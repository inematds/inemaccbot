// Loop de trabalho de UMA fila. Não sabe o que é Telegram nem fluxo — só
// claim → executa → ack. A disciplina que faltava no v1: lease com heartbeat,
// falha registrada, e drain que NÃO solta o lease do que está em voo (spec §1.3).
import type { Execucao, ContextoExecucao, Runner } from './runner.js';
import type { FilaSqlite, GanchoTransacional } from './store.js';
import { AindaNao, type Agora, type ContextoTarefa, type Fila, type Job } from './types.js';

export type Tarefa = (ctx: ContextoTarefa) => Promise<string>;

export interface WorkerOpts {
  fila: Fila;
  /**
   * Identifica ESTA instância do worker (a etapa 1 usará algo estável como
   * `hostname:pid`). Todo ack carrega o dono porque só o `status = 'running'`
   * não distingue "o job ainda é meu" de "outra instância reclamou o job depois
   * que meu lease venceu" — sem isto, um worker zumbi sobrescreve trabalho vivo.
   */
  dono: string;
  concorrencia: number;
  leaseSegundos: number;
  tarefas: Record<string, Tarefa>;
  runners: Record<string, Runner>;
  promptDe: (job: Job) => Promise<ContextoExecucao>;
  log?: (m: string) => void;
  /**
   * Chamado depois do ack (concluir/falhar), com o job RELIDO do banco — carrega
   * o `status`, `resultado`/`erro` finais, não o snapshot pré-execução. O worker
   * não sabe o que é feito aqui (spec: fila/ não importa gateway/); quem liga a
   * notificação de verdade é `src/index.ts` passando `criarNotificador(...)`.
   * Uma exceção aqui NUNCA pode derrubar o worker — o ack já aconteceu, perder a
   * notificação é aceitável, perder a fila não é (ver `passo()`).
   */
  aoTerminar?: (job: Job) => Promise<void>;
  /**
   * Saneia a mensagem de erro ANTES de ela ser gravada no banco (de onde vai
   * verbatim para o chat e para o log). Injetada, não importada: a política de
   * redação é de `dominio/`, e o worker só precisa saber que existe um ponto
   * único por onde todo erro passa. Default: identidade — nesta forma o teste
   * que não se importa com redação não precisa montar uma.
   *
   * Isto vira crítico com `kind=agent`: o erro deixa de ser "HTTP 404" e passa a
   * ser stderr de um `claude -p`, com prompt, caminhos e possivelmente segredos.
   */
  redigir?: (texto: string) => string;
  /**
   * Roda DENTRO da transação do ack (ver `GanchoTransacional` no store). É por
   * aqui que o avanço de fluxo acontece de forma atômica com o fechamento do
   * job — sem que `fila/` conheça `fluxos/`.
   */
  aoAckar?: GanchoTransacional;
  /** Espera entre checagens de uma tarefa de poll (`aindaNao`). */
  intervaloPollSegundos?: number;
}

/**
 * Worker é um stepper puro: não se agenda sozinho. Quem chama `passo()` em
 * loop, chama `bater()` periodicamente e liga `SIGTERM` a `drenar()` é o
 * `src/index.ts` — não esta classe.
 */
/**
 * O que um job em voo carrega para poder ser encerrado à força. UM mapa só (em
 * vez de um `Map` paralelo de controllers) porque `bater()` e `abortar()` já
 * iteram `ativos` e destructuram a entrada: com os dois campos juntos, o
 * cancelamento do agente e o abort da função são feitos no MESMO ponto, e não
 * existe limpeza em dois lugares para alguém esquecer.
 *
 * `exec` só existe em job `kind=agent`; `ctrl` só existe em `kind=function`.
 */
interface Ativo {
  exec: Execucao | null;
  ctrl: AbortController | null;
  /** Só em job que disparou trabalho FORA da árvore de processos (render). */
  encerrar: (() => Promise<boolean>) | null;
}

export class Worker {
  private drenando = false;
  private readonly ativos = new Map<number, Ativo>();
  /**
   * Ids já encerrados por `abortar()`. Sem isto, `abortar` e o catch de `passo`
   * chamam `falhar` para o MESMO job e quem ganha é ordem de microtask — o
   * abort perderia a corrida com uma mudança inocente no encadeamento de awaits.
   */
  private readonly abortados = new Set<number>();

  constructor(
    private readonly fila: FilaSqlite,
    private readonly opts: WorkerOpts,
    private readonly agora: Agora,
  ) {}

  get emVoo(): number {
    return this.ativos.size;
  }

  /**
   * Renova o lease de tudo que está em voo. Chamado pelo timer e no drain.
   *
   * `renovar` devolvendo false significa que o job NÃO é mais nosso (nosso lease
   * venceu, a recuperação o devolveu à fila e outra instância o pegou). Nesse
   * caso largamos o trabalho: cancela a execução, tira de `ativos` para nunca
   * dar ack. Não chamamos `falhar` — o job agora pertence a outro worker.
   *
   * Também marcamos o id em `abortados` ANTES de tirar de `ativos`: job roubado
   * não é job que falhou. O `passo()` abandonado continua rodando, a execução
   * cancelada rejeita, e o catch de `passo()` chamaria `falhar()` — a guarda de
   * posse no store bloqueia o ack (seguro), mas sem `abortados` o log ainda
   * registraria "[job N] failed: ..." para um job que só foi roubado, não falhou.
   */
  async bater(): Promise<void> {
    const log = this.opts.log ?? (() => {});
    for (const [id, ativo] of [...this.ativos]) {
      if (this.fila.renovar(id, this.opts.leaseSegundos, this.opts.dono)) continue;
      // `renovar` devolve false por DUAS causas muito diferentes, e chamar as
      // duas de "LEASE PERDIDO" mente para o operador: o `/cancelar` dele põe
      // o job em `canceled`, e é o `WHERE status = 'running'` do `renovar` que
      // rejeita — este é o caminho por onde o ffmpeg do job cancelado morre.
      // O status é uma leitura só; distinguir sai barato.
      const status = this.fila.obter(id)?.status;
      const motivo = status === 'canceled'
        ? 'CANCELADO pelo operador'
        : `LEASE PERDIDO (dono=${this.opts.dono})`;
      log(`[job ${id}] ${motivo} — abandonando o trabalho em voo`);
      this.abortados.add(id);
      this.ativos.delete(id);
      // CANCELAR é diferente de perder o lease: o trabalho destacado (um render
      // fora da árvore de processos) precisa morrer, senão ele segue ocupando a
      // GPU enquanto o próximo job de render já reclamou o slot — dois renders
      // na mesma GPU, que é o invariante que toda esta fila protege.
      if (status === 'canceled' && ativo.encerrar) {
        try {
          const matou = await ativo.encerrar();
          log(`[job ${id}] trabalho destacado ${matou ? 'encerrado' : 'não encontrado (pode seguir rodando)'}`);
        } catch (e) {
          log(`[job ${id}] não consegui encerrar o trabalho destacado: ${(e as Error).message}`);
        }
      }
      // Se `exec` ainda é null (job reclamado mas a Execução ainda não foi
      // atribuída em `ativos`), `exec?.cancelar()` é um no-op: se um processo
      // filho já tinha sido gerado, ele segue rodando sem supervisão até
      // terminar sozinho. Janela estreita (entre `passo()` reclamar o job e
      // `rodarAgente`/`rodarFuncao` atribuir a Execução) e nenhum ack é possível
      // de qualquer forma, então não há dado em risco — só um processo órfão.
      //
      // O `ctrl.abort()` é o mesmo cuidado para `kind=function`: sem ele um
      // ffmpeg deste job continuaria rodando enquanto a instância que roubou o
      // job reexecuta a MESMA tarefa — dois processos escrevendo o mesmo
      // arquivo de saída.
      ativo.ctrl?.abort(new Error('lease perdido'));
      await ativo.exec?.cancelar();
    }
  }

  /** Processa no máximo um job. Devolve true se pegou algo. */
  async passo(): Promise<boolean> {
    if (this.drenando) return false;
    if (this.ativos.size >= this.opts.concorrencia) return false;

    const job = this.fila.pegar(this.opts.fila, this.opts.leaseSegundos, this.opts.dono);
    if (!job) return false;

    this.ativos.set(job.id, { exec: null, ctrl: null, encerrar: null });
    const log = this.opts.log ?? (() => {});
    const ref = job.flow_ref ? ` ${job.flow_ref}` : '';
    log(`[job ${job.id}${ref}] ${job.fila}/${job.tarefa} motor=${job.motor ?? '-'} modelo=${job.modelo ?? '-'} esforco=${job.esforco ?? '-'}`);

    let terminou = false;
    try {
      const saida = job.kind === 'function'
        ? await this.rodarFuncao(job)
        : await this.rodarAgente(job);
      if (this.fila.concluir(job.id, saida, this.opts.dono, this.opts.aoAckar)) {
        terminou = true;
      } else {
        log(`[job ${job.id}] terminou mas não era mais nosso (cancelado/roubado?) — done rejeitado`);
      }
    } catch (e) {
      // POLL: a tarefa não achou o que espera. Não é falha — o job volta para a
      // fila com atraso e SEM gastar tentativa (§3.2). Sem este caminho, uma
      // fase de espera queimaria as tentativas em minutos.
      if (e instanceof AindaNao && !this.abortados.has(job.id)) {
        const segundos = this.opts.intervaloPollSegundos ?? 60;
        if (this.fila.reagendar(job.id, segundos, this.opts.dono)) {
          log(`[job ${job.id}] ainda não: ${e.message} — nova checagem em ${segundos}s`);
        }
        this.ativos.delete(job.id);
        this.abortados.delete(job.id);
        return true;
      }
      // `abortar()` já fechou este job; falhar de novo aqui seria uma corrida
      // decidida por ordem de microtask (ver `abortados`).
      if (!this.abortados.has(job.id)) {
        const redigir = this.opts.redigir ?? ((t: string) => t);
        const erro = redigir((e as Error).message).slice(0, 1_000);
        const r = this.fila.falhar(job.id, erro, this.opts.dono, 30, this.opts.aoAckar);
        log(`[job ${job.id}] ${r}: ${erro}`);
        // 'requeued' não é término — só 'failed' final justifica notificar (§8:
        // uma retentativa não é conclusão, silenciosa de propósito aqui).
        terminou = r === 'failed';
      }
    } finally {
      this.ativos.delete(job.id);
      this.abortados.delete(job.id);
    }
    if (terminou) await this.notificarTermino(job.id);
    return true;
  }

  /**
   * Único ponto que dispara `aoTerminar`. Existe porque o término NÃO acontece
   * só em `passo()`: `abortar()` também fecha jobs como `failed`, e a spec §8
   * não abre exceção por caminho — silêncio nunca é estado válido.
   * Relê o job para carregar `status`/`erro` finais, e nunca propaga: o ack já
   * aconteceu, perder a notificação é aceitável, perder o worker não é.
   */
  private async notificarTermino(id: number): Promise<void> {
    if (!this.opts.aoTerminar) return;
    const log = this.opts.log ?? (() => {});
    try {
      const relido = this.fila.obter(id);
      if (!relido) return;
      await this.opts.aoTerminar(relido);
      // Só DEPOIS do envio ter sucesso. Marcar antes trocaria "avisa duas
      // vezes" (chato) por "nunca avisa" — e é o segundo que a §8 proíbe.
      // Enquanto isto não é marcado, a varredura de reentrega vê o job.
      this.fila.marcarNotificado(id);
    } catch (e) {
      // A mensagem NÃO se perde: o job segue com `notificado_em` nulo e a
      // varredura periódica tenta de novo. No v1 isso era o watcher
      // reencontrando um job ainda pendente; aqui é uma coluna.
      log(`[job ${id}] aoTerminar falhou (será reentregue): ${(e as Error).message}`);
    }
  }

  private async rodarFuncao(job: Job): Promise<string> {
    const tarefa = this.opts.tarefas[job.tarefa];
    if (!tarefa) throw new Error(`tarefa desconhecida: ${job.tarefa}`);
    const ctrl = new AbortController();
    // Só mutamos a entrada se ela AINDA existe: `bater()` pode ter largado este
    // job (lease perdido) enquanto procurávamos a tarefa, e um `set()` cru
    // ressuscitaria uma entrada já removida — o job voltaria a `ativos` e o
    // drain esperaria por trabalho que não é mais nosso.
    const ativo = this.ativos.get(job.id);
    if (ativo) ativo.ctrl = ctrl;
    else ctrl.abort(new Error('job não é mais deste worker'));
    try {
      return await tarefa({
        job,
        fila: this.fila,
        agora: this.agora,
        log: this.opts.log ?? (() => {}),
        sinal: ctrl.signal,
        aindaNao: (motivo: string) => { throw new AindaNao(motivo); },
      });
    } finally {
      if (ativo) ativo.ctrl = null;
    }
  }

  private async rodarAgente(job: Job): Promise<string> {
    const ctx = await this.opts.promptDe(job);

    // O trabalho já está em curso desde uma tentativa anterior (o serviço caiu
    // e o processo destacado sobreviveu): não chama o agente de novo — só
    // espera. Sem este caminho, um restart no meio de um render dispararia um
    // SEGUNDO render sobre o primeiro.
    // O encerrador vale para as duas rotas (dispara agora ou adota o que já
    // estava rodando): nos dois casos existe trabalho destacado a matar se o
    // operador cancelar.
    const ativoInicial = this.ativos.get(job.id);
    if (ativoInicial && ctx.encerrarTrabalho) ativoInicial.encerrar = ctx.encerrarTrabalho;

    if (ctx.alvoEmCurso && ctx.aguardarArtefato) {
      const log = this.opts.log ?? ((): void => {});
      log(`[job ${job.id}] trabalho já disparado — adotando ${ctx.alvoEmCurso}`);
      return this.esperarArtefato(job, ctx.aguardarArtefato, ctx.alvoEmCurso);
    }

    const runner = this.opts.runners[ctx.perfil.motor];
    if (!runner) throw new Error(`motor desconhecido: ${ctx.perfil.motor}`);
    const exec = runner.iniciar(ctx);
    // Mesma razão de `rodarFuncao`: nunca ressuscitar uma entrada que `bater()`
    // já removeu.
    const ativo = this.ativos.get(job.id);
    if (ativo) ativo.exec = exec;
    else await exec.cancelar();
    try {
      const bruto = await exec.aguardar();
      // O resultado gravado é o que o domínio disser que é (para uma skill, o
      // caminho do `RESULT:`) — nunca o stdout cru, que iria verbatim para o
      // chat. Uma exceção aqui é falha do job, e é o comportamento correto:
      // agente que não declarou onde gravou é indistinguível de agente que não
      // gravou nada.
      const saida = ctx.interpretarSaida ? ctx.interpretarSaida(bruto) : bruto;
      // Trabalho destacado: o agente só DISPAROU. Continuamos segurando o job
      // (e o slot da fila) enquanto o artefato não aparece.
      if (ctx.aguardarArtefato) return this.esperarArtefato(job, ctx.aguardarArtefato, saida);
      return saida;
    } finally {
      await exec.limpar();
    }
  }

  /**
   * Espera o artefato de trabalho destacado, com um `AbortController` guardado
   * no MESMO campo que as tarefas `function` usam — assim `bater()` (lease
   * perdido) e `abortar()` (encerramento) já interrompem esta espera sem
   * nenhuma fiação nova. O processo destacado segue vivo de propósito: a
   * próxima tentativa o adota.
   */
  private async esperarArtefato(
    job: Job,
    aguardar: (alvo: string, sinal: AbortSignal) => Promise<string>,
    alvo: string,
  ): Promise<string> {
    const ctrl = new AbortController();
    const ativo = this.ativos.get(job.id);
    if (ativo) ativo.ctrl = ctrl;
    else ctrl.abort(new Error('job não é mais deste worker'));
    try {
      return await aguardar(alvo, ctrl.signal);
    } finally {
      if (ativo) ativo.ctrl = null;
    }
  }

  /**
   * Drain: para de aceitar novos claims e espera o que está em voo, RENOVANDO o
   * lease enquanto espera. Soltar o lease aqui permitiria outro worker pegar o
   * mesmo job com o nosso processo ainda vivo.
   *
   * Contrato real: espera só o trabalho que este worker ainda POSSUI. Um job
   * roubado no meio do drain é removido de `ativos` por `bater()` e
   * deliberadamente abandonado — seu `passo()` pode continuar assentando em
   * segundo plano (ack bloqueado pela guarda de posse) — então `drenar()`
   * retornar NÃO garante que toda promise de `passo()` já se resolveu.
   *
   * ATENÇÃO — `drenar()` NÃO cobre a CAUDA DE NOTIFICAÇÃO. `passo()` remove o
   * job de `ativos` no seu `finally`, ANTES de chamar `aoTerminar` (de
   * propósito: enquanto a entrada existe, um `bater()` concorrente renovaria o
   * lease de um job já ackado). Logo `ativos.size` chega a 0 — e este método
   * retorna — com a mensagem do último job ainda em voo.
   *
   * Quem precisa da cauda (o desligamento precisa: sem ela o "✅ Job N
   * concluído" some) tem que esperar TAMBÉM as promises de `laco()` que chamam
   * `passo()`, porque é `passo()` que só assenta depois do `aoTerminar`. Ver
   * `desligar()` em src/index.ts. Trocar aquele `Promise.all` por
   * `workers.map(w => w.drenar())` sozinho quebra isto — há teste guardando.
   */
  async drenar(): Promise<void> {
    this.drenando = true;
    while (this.ativos.size > 0) {
      await this.bater();
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Encerra à força o que estiver em voo (usado no timeout do drain). */
  async abortar(): Promise<void> {
    // Snapshot antes do loop: `passo()` deleta de `ativos` no seu `finally`
    // enquanto estamos em await, e mutar o Map durante a iteração faria um job
    // que terminou no meio do abort ser pulado (visível com concorrência > 1).
    for (const [id, ativo] of [...this.ativos]) {
      this.abortados.add(id);
      // Antes do `falhar`: a tarefa `function` precisa receber o sinal para
      // matar o processo filho que ela gerou, senão o filho sobrevive ao
      // processo e escreve a saída de um job marcado como `failed`.
      ativo.ctrl?.abort(new Error('serviço encerrando'));
      await ativo.exec?.cancelar();
      const r = this.fila.falhar(id, 'interrompido no encerramento do serviço', this.opts.dono, 30, this.opts.aoAckar);
      // §8: esta é uma transição terminal FORA de `passo()` — e o catch de
      // `passo()` a pula de propósito (o id está em `abortados`). Sem este
      // await o job morreria em silêncio. `await` e não fire-and-forget porque
      // `desligar()` chama `abortar()` com await e logo depois `main()` faz
      // `process.exit(0)`: uma notificação solta seria cortada no meio.
      if (r === 'failed') await this.notificarTermino(id);
    }
    this.ativos.clear();
  }
}
