// Loop de trabalho de UMA fila. Não sabe o que é Telegram nem fluxo — só
// claim → executa → ack. A disciplina que faltava no v1: lease com heartbeat,
// falha registrada, e drain que NÃO solta o lease do que está em voo (spec §1.3).
import type { Execucao, ContextoExecucao, Runner } from './runner.js';
import type { FilaSqlite } from './store.js';
import type { Fila, Job } from './types.js';

export type Tarefa = (job: Job) => Promise<string>;

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
  promptDe: (job: Job) => ContextoExecucao;
  log?: (m: string) => void;
}

/**
 * Worker é um stepper puro: não se agenda sozinho. Quem chama `passo()` em
 * loop, chama `bater()` periodicamente e liga `SIGTERM` a `drenar()` é o
 * `src/index.ts` — não esta classe.
 */
export class Worker {
  private drenando = false;
  private readonly ativos = new Map<number, Execucao | null>();
  /**
   * Ids já encerrados por `abortar()`. Sem isto, `abortar` e o catch de `passo`
   * chamam `falhar` para o MESMO job e quem ganha é ordem de microtask — o
   * abort perderia a corrida com uma mudança inocente no encadeamento de awaits.
   */
  private readonly abortados = new Set<number>();

  constructor(
    private readonly fila: FilaSqlite,
    private readonly opts: WorkerOpts,
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
    for (const [id, exec] of [...this.ativos]) {
      if (this.fila.renovar(id, this.opts.leaseSegundos, this.opts.dono)) continue;
      log(`[job ${id}] LEASE PERDIDO (dono=${this.opts.dono}) — abandonando o trabalho em voo`);
      this.abortados.add(id);
      this.ativos.delete(id);
      // Se `exec` ainda é null (job reclamado mas a Execução ainda não foi
      // atribuída em `ativos`), `exec?.cancelar()` é um no-op: se um processo
      // filho já tinha sido gerado, ele segue rodando sem supervisão até
      // terminar sozinho. Janela estreita (entre `passo()` reclamar o job e
      // `rodarAgente`/`rodarFuncao` atribuir a Execução) e nenhum ack é possível
      // de qualquer forma, então não há dado em risco — só um processo órfão.
      await exec?.cancelar();
    }
  }

  /** Processa no máximo um job. Devolve true se pegou algo. */
  async passo(): Promise<boolean> {
    if (this.drenando) return false;
    if (this.ativos.size >= this.opts.concorrencia) return false;

    const job = this.fila.pegar(this.opts.fila, this.opts.leaseSegundos, this.opts.dono);
    if (!job) return false;

    this.ativos.set(job.id, null);
    const log = this.opts.log ?? (() => {});
    const ref = job.flow_ref ? ` ${job.flow_ref}` : '';
    log(`[job ${job.id}${ref}] ${job.fila}/${job.tarefa} motor=${job.motor ?? '-'} modelo=${job.modelo ?? '-'} esforco=${job.esforco ?? '-'}`);

    try {
      const saida = job.kind === 'function'
        ? await this.rodarFuncao(job)
        : await this.rodarAgente(job);
      if (!this.fila.concluir(job.id, saida, this.opts.dono)) {
        log(`[job ${job.id}] terminou mas não era mais nosso (cancelado/roubado?) — done rejeitado`);
      }
    } catch (e) {
      // `abortar()` já fechou este job; falhar de novo aqui seria uma corrida
      // decidida por ordem de microtask (ver `abortados`).
      if (!this.abortados.has(job.id)) {
        const erro = (e as Error).message.slice(0, 1_000);
        const r = this.fila.falhar(job.id, erro, this.opts.dono, 30);
        log(`[job ${job.id}] ${r}: ${erro}`);
      }
    } finally {
      this.ativos.delete(job.id);
      this.abortados.delete(job.id);
    }
    return true;
  }

  private async rodarFuncao(job: Job): Promise<string> {
    const tarefa = this.opts.tarefas[job.tarefa];
    if (!tarefa) throw new Error(`tarefa desconhecida: ${job.tarefa}`);
    return tarefa(job);
  }

  private async rodarAgente(job: Job): Promise<string> {
    const ctx = this.opts.promptDe(job);
    const runner = this.opts.runners[ctx.perfil.motor];
    if (!runner) throw new Error(`motor desconhecido: ${ctx.perfil.motor}`);
    const exec = runner.iniciar(ctx);
    this.ativos.set(job.id, exec);
    try {
      return await exec.aguardar();
    } finally {
      await exec.limpar();
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
    for (const [id, exec] of [...this.ativos]) {
      this.abortados.add(id);
      await exec?.cancelar();
      this.fila.falhar(id, 'interrompido no encerramento do serviço', this.opts.dono, 30);
    }
    this.ativos.clear();
  }
}
