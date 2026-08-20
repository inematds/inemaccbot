// Boot, laço e desligamento — o miolo do processo. Toda a durabilidade da etapa
// 0 (lease, recuperação, drain, guarda de posse) fica INERTE até este arquivo
// existir: ninguém chamava `recuperarLeasesVencidos()`, `passo()` nem ligava
// SIGTERM a `drenar()`.
//
// Duas responsabilidades, separadas de propósito:
//   `criarServico` — testável sem processo, sem rede, sem sinais;
//   `main`         — lê o .env do disco, monta as deps reais, liga os sinais.
// `main` só roda quando o módulo é EXECUTADO; nunca no import (os testes
// importam este arquivo).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Config, carregarConfig } from './config.js';
import { type EscritaEnv, gravarEnv, trocarValorEnv } from './env-arquivo.js';
import { abrirDb } from './db/abrir.js';
import { redatorPadrao } from './dominio/redacao.js';
import { carregarSkills as carregarSkillsPadrao, type SkillDef } from './dominio/registry.js';
import { criarPromptDe, parseEntradaSkill } from './fila/skills.js';
import { carregarFluxos as carregarFluxosPadrao, type FluxoRegistrado } from './dominio/registry-fluxos.js';
import { EstadoFluxos } from './fluxos/estado.js';
import { publicarVideo } from './fluxos/publicar.js';
import { Fluxos } from './fluxos/runtime.js';
import { aplicarMigrations } from './db/migrations.js';
import { CONCORRENCIAS, FILAS } from './fila/filas.js';
import { FilaSqlite } from './fila/store.js';
import { RUNNERS } from './fila/runner.js';
import { ClaudeRunner } from './fila/runner-claude.js'; // o import também registra RUNNERS.claude (sobrescrito no boot com CLAUDE_BIN)
import './fila/runner-chrome.js'; // idem: RUNNERS.chrome (fase de navegador)
import { CodexRunner } from './fila/runner-codex.js'; // motor alternativo — docs/motor-codex.md
import { OpencodeRunner } from './fila/runner-opencode.js'; // motor alternativo — docs/motor-opencode.md
import { criarTarefas as criarTarefasPadrao } from './fila/tarefas/index.js';
import type { Agora, Job } from './fila/types.js';
import { Worker, type Tarefa } from './fila/worker.js';
import { tratarMensagem } from './gateway/mensagem.js';
import { criarBaixadorTelegram } from './gateway/midia.js';
import { nomeDeEntrega } from './gateway/entrega.js';
import { criarNotificador } from './gateway/notificar.js';
import { type Transporte, criarBot } from './gateway/telegram.js';

/**
 * A versão sai do `package.json`, não de uma constante ao lado: duas cópias do
 * número divergem no primeiro bump com pressa, e a que aparece no log de boot
 * seria a mentira mais barata de produzir. Resolve tanto de `dist/` quanto de
 * `src/` — os dois estão um nível abaixo da raiz do repo.
 */
const VERSAO = (JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }).version;

// A lista de filas e suas concorrências vivem em `fila/filas.ts` — o gateway
// precisa da MESMA lista para o `/fila`, e ele não pode importar daqui.
// Reexportado porque os testes da etapa 1 e o deploy já apontavam para cá.
export { CONCORRENCIAS, FILAS };

/** O bot é um recurso de ciclo de vida (start/stop), não só um `Transporte` —
 * por isso o serviço recebe as três coisas juntas. */
export interface TransporteServico {
  iniciar(): Promise<void>;
  parar(): Promise<void>;
  transporte: Transporte;
}

export interface DepsServico {
  agora: Agora;
  /**
   * Recebe `aoComando` porque o handler de mensagem precisa da FILA, que só
   * existe dentro de `criarServico` — sem este segundo argumento não há como
   * ligar `/fila`, `/status`, `/cancelar` ao store sem o adaptador Telegram
   * conhecer o store.
   */
  criarTransporte: (
    cfg: Config,
    deps: {
      aoComando: (chatId: number, texto: string) => Promise<string>;
      /** Log do serviço — o transporte NUNCA escreve em `console`, senão o
       * único rastro do gateway cai num sink diferente do resto (§8). */
      log: (m: string) => void;
      /** O transporte morreu DEPOIS do boot (laço de polling caiu). O serviço
       * fica surdo: jobs rodam, nenhum comando entra, nenhuma notificação sai.
       * Chamar isto derruba o serviço para o systemd reiniciar. */
      aoFalhaFatal: (e: Error) => void;
    },
  ) => TransporteServico;
  /** Como o PROCESSO morre depois de `parar()` numa falha fatal. Só `main`
   * passa (process.exit); nos testes o serviço só precisa ficar parado. */
  aoFalhaFatal?: (e: Error) => void;
  log: (m: string) => void;
  /** Pausa do laço quando `passo()` devolve false (nada na fila). */
  intervaloOciosoMs: number;
  /** Periodicidade do `bater()` — na produção, bem abaixo de `leaseSegundos`. */
  heartbeatMs: number;
  /** Teto do dreno antes de `abortar()` o que sobrou. */
  timeoutDrenoMs: number;
  leaseSegundos?: number;
  /** Só os testes trocam: o catálogo de tarefas é FECHADO na produção. */
  criarTarefas?: (opts: { raizMidia: string }) => Record<string, Tarefa>;
  /** Idem para o registry de skills: em produção vem de `config/skills.json`. */
  carregarSkills?: (caminho: string, raiz: string) => SkillDef[];
  /** Idem para o registry de fluxos (repos de domínio). */
  carregarFluxos?: (caminho: string, raizPadrao: string) => FluxoRegistrado[];
}

export interface Servico {
  iniciar(): Promise<void>;
  parar(): Promise<void>;
  /** Exposto para os testes inspecionarem o estado da fila sem abrir o DB. */
  fila: FilaSqlite;
  /** Timers VIVOS pertencentes ao serviço. Existe para o teste provar que
   * `parar()` não deixa nada segurando o event loop. */
  timers(): number;
}

const LEASE_PADRAO_SEGUNDOS = 60;

/**
 * Erros do Telegram que NÃO melhoram com retentativa. Retentar chat inexistente
 * ou bot bloqueado é bater numa porta que não abre — a cada 20 segundos, para
 * sempre.
 */
export function ehFalhaPermanenteDeEnvio(mensagem: string): boolean {
  return /chat not found|bot was blocked|user is deactivated|chat_id is empty|message is too long|CHAT_WRITE_FORBIDDEN/i
    .test(mensagem);
}

/** Raiz do repo: `config/` e `prompts/` vivem lá. Funciona igual rodando de
 * `src/` (teste) e de `dist/` (produção) — os dois estão um nível abaixo. */
const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));

export function criarServico(cfg: Config, deps: DepsServico): Servico {
  // Numa instalação nova o diretório do QUEUE_DB pode não existir ainda, e o
  // erro do SQLite nesse caso é opaco.
  mkdirSync(dirname(cfg.queueDb), { recursive: true });
  const db = abrirDb(cfg.queueDb);
  const fila = new FilaSqlite(db, deps.agora);
  const leaseSegundos = deps.leaseSegundos ?? LEASE_PADRAO_SEGUNDOS;

  // O runner do Claude passa a usar o binário da CONFIG, não o que o PATH do
  // processo achar. Ver `claudeBin` em `config.ts`: com o PATH do systemd o
  // `claude` caía numa instalação de março que pede permissão a cada `Write`,
  // e as fases de texto terminavam sem escrever nada (C#77, C#78).
  //
  // Se o binário declarado não existe, o boot cai AQUI, com o caminho na
  // mensagem — e não mais fase por fase, com um erro que não fala do assunto.
  if (!existsSync(cfg.claudeBin)) {
    throw new Error(`CLAUDE_BIN não existe: ${cfg.claudeBin}`);
  }
  RUNNERS.claude = new ClaudeRunner(cfg.claudeBin);

  // Motores ALTERNATIVOS (`| motor=codex`, `| motor=opencode`).
  //
  // Registrados sempre, mas a ausência do binário NÃO derruba o boot como a do
  // `claude`: eles são opcionais por desenho, e uma máquina que só usa o motor
  // padrão não pode parar de subir porque não instalou um agente que ninguém
  // pediu. Quem pedir por um motor sem binário recebe o erro do `spawn` no job,
  // com o caminho na mensagem.
  //
  // A exceção é o motor PADRÃO: se `MOTOR_PADRAO` aponta para um binário que não
  // existe, TODO job de agente falharia — isso é erro de boot, igual ao do
  // `CLAUDE_BIN`, e cai aqui com o caminho na mensagem.
  RUNNERS.codex = new CodexRunner(cfg.codexBin);
  RUNNERS.opencode = new OpencodeRunner(cfg.opencodeBin);
  for (const [motor, bin] of [['codex', cfg.codexBin], ['opencode', cfg.opencodeBin]] as const) {
    if (existsSync(bin)) continue;
    if (cfg.motorPadrao === motor) {
      throw new Error(`MOTOR_PADRAO=${motor}, mas o binário não existe: ${bin}`);
    }
    process.stderr.write(
      `motor ${motor}: binário ausente (${bin}) — só falha se alguém pedir | motor=${motor}\n`,
    );
  }

  /** Identidade DESTA instância — é contra isto que as guardas de posse
   * (`concluir`/`falhar`/`renovar`) comparam. Calculado uma vez. */
  const dono = `${hostname()}:${process.pid}`;

  /** Ponto ÚNICO de saneamento do que sai do sistema (spec §9). O `BOT_TOKEN`
   * entra como literal porque ele aparece nas URLs da API do Telegram, que é
   * exatamente o que um erro de download de anexo carrega. */
  const redigir = redatorPadrao({ segredos: [cfg.botToken], home: homedir() });

  let rodando = false;
  let parando: Promise<void> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let transp: TransporteServico | null = null;
  let workers: { w: Worker; n: number }[] = [];
  let varrendo = false;
  /** Preenchido no `iniciar()`, junto do transporte — antes dele não há para
   * onde notificar. */
  let notificar: ((job: Job) => Promise<void>) | null = null;
  let fluxos: Fluxos | null = null;
  let fluxosRegistrados: FluxoRegistrado[] = [];
  /** Avisos de fluxo produzidos DENTRO da transação do ack, drenados logo
   * depois dela — ver `aoEvento` abaixo. */
  const eventosDeFluxo: { chatId: number; texto: string }[] = [];
  let lacos: Promise<void>[] = [];

  const timeouts = new Set<NodeJS.Timeout>();
  /** Resolvedores das esperas ociosas, para acordá-las no desligamento em vez
   * de deixar o `parar()` pagar o intervalo ocioso inteiro. */
  const acordadores = new Set<() => void>();

  function esperar(ms: number): Promise<void> {
    return new Promise<void>((resolver) => {
      let t: NodeJS.Timeout | undefined;
      const fim = (): void => {
        if (t) { clearTimeout(t); timeouts.delete(t); }
        acordadores.delete(fim);
        resolver();
      };
      t = setTimeout(fim, ms);
      timeouts.add(t);
      acordadores.add(fim);
    });
  }

  function limparTimers(): void {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    for (const t of timeouts) clearTimeout(t);
    timeouts.clear();
    acordadores.clear();
  }

  // Preenchido em `iniciar()` (o registry é lido lá, junto das migrations). O
  // handler tem que existir ANTES disso porque `criarTransporte` o recebe.
  let defs: SkillDef[] = [];

  const aoComando = async (chatId: number, texto: string): Promise<string> =>
    tratarMensagem(chatId, texto, {
      fila,
      agora: deps.agora,
      defs,
      projetosDir: cfg.projetosDir,
      // Mesmo motor da fila: um lugar só do sistema sabe falar com o Claude.
      runner: RUNNERS[cfg.motorPadrao] ?? RUNNERS.claude,
      perfil: { motor: cfg.motorPadrao, modelo: cfg.modeloPadrao, esforco: cfg.esforcoPadrao },
      cwd: homedir(),
      logFile: cfg.logFile,
      redigir,
      // Duas áreas, e a distinção não é cosmética: `state/artefatos` é do BOT
      // (ele sabe o que é terminal e pode limpar); `~/projetos/output` é de
      // vários projetos, e medir não é a mesma coisa que poder apagar.
      areas: [
        { rotulo: 'bot (artefatos)', caminho: join(cfg.stateDir, 'artefatos'), doBot: true },
        { rotulo: 'skills (output)', caminho: cfg.publicoDir, doBot: false },
      ],
      // O `/limpar` só pode tocar nestas duas raízes. Passar caminho é o que
      // impede o comando de decidir sozinho onde vasculhar.
      raizArtefatos: join(cfg.stateDir, 'artefatos'),
      publicoDir: cfg.publicoDir,
      ...(fluxos ? { fluxos } : {}),
      fluxosRegistrados,
    });

  /** O `Worker` é um stepper puro por decisão da etapa 0 — quem agenda é aqui. */
  async function laco(w: Worker): Promise<void> {
    while (rodando) {
      let pegou = false;
      try {
        pegou = await w.passo();
      } catch (e) {
        // Depois de `parar()` o DB pode já estar fechado sob um `passo()`
        // abandonado (job roubado): isso é encerramento, não falha.
        if (!rodando) return;
        deps.log(`laço: erro em passo(): ${(e as Error).message}`);
      }
      // O `&& rodando` não é redundante: sem ele, um `passo()` que assenta
      // DEPOIS de `limparTimers()` registraria um timeout novo num conjunto já
      // limpo — um timer sobrevivendo ao `parar()`.
      if (!pegou && rodando) await esperar(deps.intervaloOciosoMs);
    }
  }

  // SIGTERM e SIGINT podem chegar os dois: o segundo `parar()` tem que ser um
  // no-op, não um segundo `db.close()`.
  const parar = (): Promise<void> => (parando ??= desligar());

  /**
   * Falha do gateway depois do boot. Ficar de pé sem transporte é o estado que
   * a spec §8 proíbe (silêncio nunca é estado válido): nada chega, nada sai, e
   * nada reinicia. Então: loga NO LOG DO SERVIÇO (nunca `console`), desliga
   * ordenadamente (`parar()` é memoizado — SIGTERM e esta rota compartilham o
   * mesmo desligamento) e só então avisa `main` para sair diferente de zero.
   */
  function falhaFatal(e: Error): void {
    deps.log(`FATAL: transporte caiu depois do boot: ${e.message} — desligando`);
    void parar().then(
      () => deps.aoFalhaFatal?.(e),
      (erro: unknown) => {
        // Desligamento quebrado não pode engolir a saída não-zero.
        deps.log(`FATAL: desligamento falhou: ${(erro as Error).message}`);
        deps.aoFalhaFatal?.(e);
      },
    );
  }

  /**
   * Reentrega notificações de término que nunca chegaram. Best-effort e nunca
   * lança: é rede de segurança, não caminho principal — se falhar de novo, o
   * job continua marcado como não-notificado e a próxima passagem tenta.
   */
  async function reentregarNotificacoes(): Promise<void> {
    if (!notificar) return;
    // Uma varredura por vez. Ela roda a cada heartbeat e faz uma chamada de
    // rede por job; se uma passagem demorar mais que o intervalo, a seguinte
    // veria as MESMAS linhas ainda não marcadas e mandaria a mensagem duas
    // vezes — quebrando exatamente o "exatamente uma vez" que ela existe para
    // garantir.
    if (varrendo) return;
    varrendo = true;
    try {
      await varrerPendentes();
    } finally {
      varrendo = false;
    }
  }

  async function varrerPendentes(): Promise<void> {
    if (!notificar) return;
    let pendentes: Job[];
    try {
      pendentes = fila.pendentesDeNotificacao();
    } catch (e) {
      deps.log(`reentrega: não consegui listar pendentes: ${(e as Error).message}`);
      return;
    }
    for (const job of pendentes) {
      try {
        await notificar(job);
        fila.marcarNotificado(job.id);
        deps.log(`[job ${job.id}] notificação reentregue`);
      } catch (e) {
        const msg = (e as Error).message;
        // Falha PERMANENTE (chat apagado, bot bloqueado, mensagem inválida):
        // retentar isso a cada 20s é bater numa porta que não abre. Marca como
        // notificado e registra — perder a mensagem é o fato, e o log é o
        // rastro honesto disso.
        if (ehFalhaPermanenteDeEnvio(msg)) {
          fila.marcarNotificado(job.id);
          deps.log(`[job ${job.id}] notificação impossível (${msg.slice(0, 120)}) — desistindo`);
          continue;
        }
        deps.log(`[job ${job.id}] reentrega falhou (tentarei de novo): ${msg}`);
      }
    }
  }

  async function iniciar(): Promise<void> {
    // 1. schema. Checksum divergente derruba o boot: subir sobre um schema que
    //    não reconhecemos é pior que não subir.
    try {
      aplicarMigrations(db, deps.agora);
    } catch (e) {
      db.close();
      throw e;
    }

    // 2. raiz de mídia e de artefatos (derivadas do STATE_DIR, sem variável nova).
    const raizMidia = join(cfg.stateDir, 'midia');
    mkdirSync(raizMidia, { recursive: true });
    const raizArtefatos = join(cfg.stateDir, 'artefatos');
    mkdirSync(raizArtefatos, { recursive: true });

    // 2.1 registry de skills. ANTES dos workers, e sem try/catch de propósito:
    //     registry inválido derruba o boot, igual a checksum de migration
    //     divergente. Subir com um catálogo que não entendemos é pior que não
    //     subir — e a alternativa (falhar no primeiro job) queima uma tentativa
    //     e responde ao usuário com um erro sem sentido.
    try {
      defs = (deps.carregarSkills ?? carregarSkillsPadrao)(
        join(RAIZ_REPO, 'config', 'skills.json'),
        RAIZ_REPO,
      );
    } catch (e) {
      // Mesmo cuidado das migrations logo acima: o boot morre, mas não deixa o
      // arquivo do SQLite aberto atrás de si.
      db.close();
      throw e;
    }
    // Motor de fluxos: o estado vive no MESMO banco da fila, e é isso que torna
    // o avanço transacional possível (§3.3).
    const estadoFluxos = new EstadoFluxos(db, deps.agora);
    fluxos = new Fluxos({
      fila, estado: estadoFluxos, agora: deps.agora, log: deps.log,
      raizArtefatos, projetosDir: cfg.projetosDir,
      // O evento é SÓ empilhado aqui: `avancar` roda dentro da transação do
      // ack, e uma chamada de rede lá dentro seguraria a transação. O envio
      // acontece logo depois do commit, no `aoTerminar`.
      aoEvento: (e) => eventosDeFluxo.push(e),
      // Fechamento sobre a variável, não sobre o valor: o registry de fluxos só
      // é carregado logo ABAIXO, e ler aqui daria `undefined` para sempre.
      repoDe: (tipo) => fluxosRegistrados?.find((f) => f.command === tipo)?.repo,
      // O link do vídeo final. A cópia acontece aqui, e não em `fluxos/`,
      // porque só o boot sabe qual pasta já é servida por HTTP e por quais
      // bases de URL ela responde.
      publicar: (origem, titulo, tipo) =>
        publicarVideo(origem, titulo, cfg.publicoDir, cfg.publicoUrls, tipo),
      // Base sobre a qual o `perfil` de uma fase é resolvido (o mesmo default
      // que o worker usaria se a fase não declarasse nada).
      perfilPadrao: { motor: cfg.motorPadrao, modelo: cfg.modeloPadrao, esforco: cfg.esforcoPadrao },
    });
    fluxosRegistrados = (deps.carregarFluxos ?? carregarFluxosPadrao)(
      join(RAIZ_REPO, 'config', 'fluxos.json'),
      cfg.projetosDir,
    );

    const promptDe = criarPromptDe({
      defs,
      raizRepo: RAIZ_REPO,
      projetosDir: cfg.projetosDir,
      raizArtefatos,
      cwd: homedir(),
      log: deps.log,
      perfilPadrao: {
        motor: cfg.motorPadrao,
        modelo: cfg.modeloPadrao,
        esforco: cfg.esforcoPadrao,
      },
    });

    // 3. + 4. recuperação ANTES de qualquer `passo()`, e logada — é a única
    //    evidência de que houve queda.
    const r = fila.recuperarLeasesVencidos();
    deps.log(`boot: recuperação de leases — requeued=${r.requeued} failed=${r.falhados.length}`);
    // Rede de segurança do §3.6c: fase que já deveria estar rodando e ficou sem
    // job (banco restaurado de backup, import de fluxo) volta para a fila.
    fluxos?.reenfileirarOrfas();

    // 5. só então: workers e bot.
    const tarefas = (deps.criarTarefas ?? criarTarefasPadrao)({
      raizMidia,
      heygenEnvPath: cfg.heygenEnvPath,
      heygenCli: cfg.heygenCli,
      heygenPerfilChrome: cfg.heygenPerfilChrome,
      // O script mora no REPO DO BOT (é infraestrutura, não conteúdo de
      // domínio): resolvido a partir do `dist/`, funciona rodando de qualquer
      // diretório.
      heygenEstudioScript: join(RAIZ_REPO, 'scripts', 'heygen-estudio.mjs'),
    });
    transp = deps.criarTransporte(cfg, { aoComando, log: deps.log, aoFalhaFatal: falhaFatal });
    const transporte = transp.transporte;
    /** Drena os avisos de fluxo. Chamado depois do ack, nunca dentro dele. */
    const soltarEventosDeFluxo = async (): Promise<void> => {
      while (eventosDeFluxo.length) {
        const e = eventosDeFluxo.shift()!;
        try {
          await transporte.responder(e.chatId, e.texto);
        } catch (erro) {
          // §8: perder o aviso é ruim, derrubar o worker é pior. O log fica.
          deps.log(`fluxo: aviso não entregue: ${(erro as Error).message}`);
        }
      }
    };

    const notificarJob = criarNotificador(transp.transporte, {
      redigir,
      log: deps.log,
      // Só job de SKILL produz artefato em disco. `http.get` devolve texto e
      // `ffmpeg.thumb` já responde o caminho — tratá-los como artefato faria a
      // entrega tentar ler um corpo HTTP como se fosse arquivo.
      temArtefato: (job) => defs.some((d) => d.command === job.tarefa),
      entregaDe: (job) => {
        const def = defs.find((d) => d.command === job.tarefa);
        if (!def) return {};
        try {
          const e = parseEntradaSkill(job.input);
          return {
            destinoDir: e.destino,
            nome: nomeDeEntrega({
              command: def.command, id: job.id,
              ext: def.artefato_exts[0], campos: e.campos,
            }),
            mover: e.campos?.mover === 'sim',
          };
        } catch {
          return {};
        }
      },
    });

    // O notificador do worker faz as duas coisas: avisa sobre o JOB (quando ele
    // tem dono no chat) e solta os avisos de FLUXO que o avanço empilhou.
    notificar = async (job: Job): Promise<void> => {
      await notificarJob(job);
      await soltarEventosDeFluxo();
    };

    // 6. §8: a recuperação acabou de marcar jobs como `failed` — uma transição
    //    TERMINAL que acontece fora do `Worker`. Sem isto o chat que pediu o job
    //    nunca fica sabendo que ele morreu no `kill -9`, e silêncio não é estado
    //    válido. Mesmo notificador do worker (um único formato de mensagem).
    //
    //    Posição: DEPOIS de `criarTransporte` (não há para onde mandar antes) e
    //    ANTES dos laços começarem — assim a notificação do boot chega antes de
    //    qualquer mensagem de job novo, que é a ordem que o operador espera.
    //    Uma falha aqui não pode derrubar o boot: o job já está durável como
    //    `failed`, perder a notificação é ruim, não subir é pior.
    for (const job of r.falhados) {
      try {
        await notificar(job);
        fila.marcarNotificado(job.id);
      } catch (e) {
        deps.log(`boot: notificação da recuperação falhou (job ${job.id}): ${(e as Error).message}`);
      }
    }

    workers = FILAS.map((f) => ({
      n: CONCORRENCIAS[f],
      w: new Worker(
        fila,
        {
          fila: f,
          dono,
          concorrencia: CONCORRENCIAS[f],
          leaseSegundos,
          tarefas,
          runners: RUNNERS,
          promptDe,
          log: deps.log,
          aoTerminar: notificar ?? undefined,
          redigir,
          // Evidência de falha de contrato: `state/saidas/<job>-t<n>.log`.
          // Um arquivo por TENTATIVA — o C#77 falhou duas vezes e as duas
          // saídas importam (a segunda pode ter quebrado por outro motivo).
          // Redigido, porque este arquivo tem o mesmo destino que o erro: olho
          // humano, com prompt e caminhos dentro.
          guardarSaidaBruta: (job, bruto) => {
            const dir = join(cfg.stateDir, 'saidas');
            mkdirSync(dir, { recursive: true });
            const caminho = join(dir, `${job.id}-t${job.tentativas}.log`);
            writeFileSync(caminho, redigir(bruto), 'utf8');
            return caminho;
          },
          // O avanço do fluxo acontece DENTRO da transação do ack.
          aoAckar: (job) => fluxos?.avancar(job),
        },
        deps.agora,
      ),
    }));

    rodando = true;
    // Um laço por unidade de concorrência: `passo()` processa UM job e o espera,
    // então um laço só nunca usaria a concorrência 10 da fila `io`.
    lacos = workers.flatMap(({ w, n }) =>
      Array.from({ length: n }, () => laco(w)),
    );

    heartbeat = setInterval(() => {
      void Promise.all(workers.map(({ w }) => w.bater())).catch((e: unknown) => {
        deps.log(`heartbeat: ${(e as Error).message}`);
      });
      // Recuperação PERIÓDICA, não só no boot (spec §3.6b: `running` sem worker
      // vivo volta pra fila). Rodar só no boot bastava enquanto os jobs duravam
      // segundos; com um render de 2h, um `kill -9` seguido de restart DENTRO da
      // janela do lease deixava o job `running` com lease vivo e ninguém para
      // reclamá-lo — preso para sempre. Com a adoção do render em pé, requeue
      // aqui é seguro: a tentativa seguinte adota o trabalho destacado em vez de
      // disparar outro.
      // Reentrega do que ficou sem aviso (§8). Vale para os dois casos que o
      // log sozinho não resolve: Telegram fora do ar na hora do ack, e processo
      // morto entre gravar o término e enviar a mensagem.
      void reentregarNotificacoes();
      try {
        const r = fila.recuperarLeasesVencidos();
        if (r.requeued || r.falhados.length) {
          deps.log(`recuperação periódica: requeued=${r.requeued} failed=${r.falhados.length}`);
          // Sem notificação inline aqui de propósito: estes jobs acabaram de
          // virar `failed` com `notificado_em` nulo, então a própria varredura
          // de reentrega (que roda no mesmo tick) os pega — e ela é quem marca
          // a entrega. Notificar aqui também mandaria a mensagem duas vezes.
        }
      } catch (e) {
        deps.log(`recuperação periódica falhou: ${(e as Error).message}`);
      }
    }, deps.heartbeatMs);

    // Depois deste ponto os laços já estão girando e o heartbeat já está de pé.
    // Se `transporte.iniciar()` rejeitar (o caso comum em produção: `bot.init()`
    // com token inválido), quem chamou recebe o erro — mas ninguém chama
    // `parar()` num boot que falhou. Sem este desmonte, um `iniciar()` tentado
    // de novo poria um SEGUNDO conjunto de laços na mesma fila com o mesmo
    // `dono`, e o heartbeat sobreviveria segurando o event loop.
    try {
      await transp.iniciar();
    } catch (e) {
      await parar();
      throw e;
    }
  }

  async function desligar(): Promise<void> {
    // 1. o bot para de RECEBER antes de tudo: nenhum comando novo entra
    //    enquanto drenamos.
    if (transp) {
      try {
        await transp.parar();
      } catch (e) {
        deps.log(`desligamento: erro ao parar o transporte: ${(e as Error).message}`);
      }
    }

    // 2. laços param de reclamar trabalho novo (e acordam já das esperas).
    rodando = false;
    for (const acordar of [...acordadores]) acordar();

    // 3. dreno com teto.
    //    `drenar()` espera só o trabalho que o worker ainda POSSUI: um job
    //    roubado no meio do dreno (lease vencido + reclaim de outra instância)
    //    é largado de propósito por `bater()`, e o `passo()` correspondente
    //    pode nunca assentar. Por isso os `lacos` entram na MESMA corrida com
    //    timeout — nunca num `await` que assume que todos terminam.
    //
    //    Os `lacos` estão aqui por uma SEGUNDA razão, independente da primeira:
    //    `drenar()` não cobre a cauda de notificação (ver o docstring dele). O
    //    job sai de `ativos` antes do `aoTerminar`, então `drenar()` pode
    //    resolver com a última mensagem ainda em voo; só a promise de `passo()`
    //    — que é o que `laco()` mantém — assenta depois do `aoTerminar`. Sem os
    //    `lacos` nesta corrida, `parar()` cortaria o "✅ Job N concluído" do
    //    último job. Não simplificar para `workers.map(w => w.drenar())`.
    const dreno = Promise.all([
      ...workers.map(({ w }) => w.drenar()),
      ...lacos,
    ]).then(() => true, () => true);
    const drenou = await Promise.race([dreno, esperar(deps.timeoutDrenoMs).then(() => false)]);

    // 4. o que sobrou vira falha explícita — nunca fica `running` com lease
    //    vivo, que é o estado que nenhuma recuperação futura consegue distinguir
    //    de trabalho em andamento antes do lease expirar.
    if (!drenou) {
      deps.log(`desligamento: dreno estourou ${deps.timeoutDrenoMs}ms — abortando o que sobrou`);
      for (const { w } of workers) {
        try {
          await w.abortar();
        } catch (e) {
          deps.log(`desligamento: erro ao abortar: ${(e as Error).message}`);
        }
      }
    }

    // 5. timers e DB. Depois de `abortar()` o `drenar()` pendente sai no próximo
    //    tick sem tocar no banco (a lista de ativos está vazia), então fechar
    //    aqui é seguro.
    limparTimers();
    db.close();
  }

  return {
    iniciar,
    parar,
    fila,
    timers: () => timeouts.size + (heartbeat ? 1 : 0),
  };
}

/** Parser mínimo de .env: `CHAVE=valor`, `#` comenta, aspas opcionais.
 * Não é dotenv — é o suficiente para o boot e não acrescenta dependência.
 *
 * O `#` também comenta no FIM da linha, mas só quando vem depois de espaço e
 * fora de aspas: `PROJETOS_DIR=/root/projetos   # default: ...` dava um caminho
 * com o comentário dentro, e o boot morria dizendo que o diretório não existe.
 * A exigência do espaço preserva o `#` que é DADO — uma senha `s3nh#a` ou um
 * fragmento de URL colado no valor continuam inteiros; se o valor legítimo tem
 * espaço antes do `#`, aspas resolvem. */
export function lerEnv(texto: string): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const linha of texto.split('\n')) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;
    const i = limpa.indexOf('=');
    if (i <= 0) continue;
    const chave = limpa.slice(0, i).trim();
    let valor = limpa.slice(i + 1).trim();
    const aspa = valor[0] === '"' || valor[0] === "'" ? valor[0] : '';
    const fecha = aspa ? valor.indexOf(aspa, 1) : -1;
    if (fecha > 0) {
      valor = valor.slice(1, fecha);
    } else if (!aspa) {
      valor = valor.replace(/\s+#.*$/, '').trim();
    }
    saida[chave] = valor;
  }
  return saida;
}

/**
 * Publica as chaves do `.env` no ambiente do PROCESSO — não só no `Config`.
 *
 * Sem isto o bot fica assimétrico e o sintoma é difícil de ler: sob systemd o
 * `EnvironmentFile=` já põe tudo em `process.env`, e os scripts filhos
 * (`montar-reel.py`, `gen-imagem.py`, `transcribe-groq.sh` — que herdam o
 * ambiente porque o `spawn` não passa `env:`) enxergam `INEMAIMG_HOST`,
 * `GROQ_ENV_PATH` e afins. Rodando pelo `./start.sh`, o `main()` lia o arquivo
 * para um objeto e os filhos NÃO viam nada — a mesma máquina, a mesma config,
 * comportamento diferente conforme quem subiu o processo.
 *
 * O que já está no ambiente VENCE o arquivo, igual a `carregarConfig`.
 */
export function exportarParaAmbiente(
  doArquivo: Record<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  for (const [chave, valor] of Object.entries(doArquivo)) {
    if (env[chave] === undefined) env[chave] = valor;
  }
}

/**
 * Persistência do pareamento: grava a allowlist nova no `.env`, que é de onde
 * ela vai ser lida no próximo boot (o systemd relê o `EnvironmentFile` no
 * start). I/O injetado pelo mesmo motivo do resto do arquivo — teste não
 * escreve no `.env` de ninguém.
 */
export function persistirAllowlistNoEnv(
  caminho: string,
  ids: number[],
  io: EscritaEnv & { ler(caminho: string): string },
): void {
  // Vírgula sem espaço: é exatamente o formato que `carregarConfig` parseia.
  const texto = trocarValorEnv(io.ler(caminho), 'ALLOWED_CHAT_IDS', ids.join(','));
  gravarEnv(caminho, texto, io);
}

/** As operações de disco reais por trás de `persistirAllowlistNoEnv`. */
const ESCRITA_ENV_REAL = {
  ler: (c: string): string => readFileSync(c, 'utf8'),
  escrever: (c: string, t: string): void => { writeFileSync(c, t, { mode: 0o600 }); },
  renomear: (de: string, para: string): void => { renameSync(de, para); },
  permissao: (c: string, m: number): void => { chmodSync(c, m); },
};

/** Transporte real. `bot.start()` NÃO é aguardado: no grammy ele só assenta
 * quando o bot PARA — esperar por ele travaria o boot antes do primeiro
 * `passo()`. `bot.init()` é o que falha rápido (token inválido). */
/** O mínimo do grammy de que o ciclo de vida depende — assim o teste do
 * polling não precisa de grammy nem de rede. */
export interface BotMinimo {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Liga `init`/`start`/`stop` ao ciclo de vida do serviço. Extraído de
 * `criarTransporteReal` para que a rota "o polling caiu" seja testável: antes
 * ela vivia dentro de um closure que só existia com um bot grammy de verdade,
 * e por isso o `console.error` original nunca foi coberto por teste.
 */
export function ligarPolling(
  bot: BotMinimo,
  deps: { log: (m: string) => void; aoFalhaFatal: (e: Error) => void },
): { iniciar(): Promise<void>; parar(): Promise<void> } {
  return {
    async iniciar() {
      await bot.init();
      void bot.start().catch((e: unknown) => {
        // Não é aviso: sem polling o serviço está surdo. Loga onde todo o
        // resto loga e derruba o processo — `Restart=on-failure` é a
        // recuperação; continuar de pé é apodrecer em silêncio.
        const erro = e instanceof Error ? e : new Error(String(e));
        deps.log(`bot: laço de polling caiu: ${erro.message}`);
        deps.aoFalhaFatal(erro);
      });
    },
    async parar() {
      await bot.stop();
    },
  };
}

function criarTransporteReal(
  cfg: Config,
  deps: {
    aoComando: (chatId: number, texto: string) => Promise<string>;
    log: (m: string) => void;
    aoFalhaFatal: (e: Error) => void;
    /** O `.env` que `main` leu — destino do id quando o bot é pareado. */
    caminhoEnv: string;
  },
): TransporteServico {
  const { bot, transporte } = criarBot(cfg, {
    aoComando: deps.aoComando,
    log: deps.log,
    persistirAllowlist: (ids: number[]): void => {
      persistirAllowlistNoEnv(deps.caminhoEnv, ids, ESCRITA_ENV_REAL);
    },
    // Anexo cai em `state/midia`, que é a raiz que o `ffmpeg.thumb` já exige —
    // é o que torna aquele comando alcançável na prática.
    baixarAnexo: criarBaixadorTelegram(
      cfg.botToken,
      join(cfg.stateDir, 'midia'),
      () => Math.floor(Date.now() / 1000),
    ),
  });
  const ciclo = ligarPolling(bot, deps);
  return { ...ciclo, transporte };
}

export async function main(): Promise<void> {
  const arquivo = resolve(process.cwd(), '.env');
  const doArquivo = existsSync(arquivo) ? lerEnv(readFileSync(arquivo, 'utf8')) : {};
  // O ambiente do processo vence o arquivo (systemd/override manual).
  const cfg = carregarConfig({ ...doArquivo, ...process.env });
  // E o arquivo tem que chegar aos scripts filhos, não só ao Config.
  exportarParaAmbiente(doArquivo, process.env);

  mkdirSync(dirname(cfg.logFile), { recursive: true });
  const log = (m: string): void => {
    const linha = `${new Date().toISOString()} ${m}\n`;
    process.stderr.write(linha);
    try {
      appendFileSync(cfg.logFile, linha);
    } catch {
      /* log em disco é best-effort; nunca derruba o serviço */
    }
  };

  const svc = criarServico(cfg, {
    agora: () => Math.floor(Date.now() / 1000),
    // O caminho do `.env` entra por aqui: `criarServico` não precisa conhecê-lo,
    // e o pareamento precisa saber onde gravar o id do dono.
    criarTransporte: (c, d) => criarTransporteReal(c, { ...d, caminhoEnv: arquivo }),
    log,
    intervaloOciosoMs: 1_000,
    heartbeatMs: 20_000,
    // O unit dá 120s no SIGTERM; saímos com folga antes do SIGKILL.
    timeoutDrenoMs: 110_000,
    leaseSegundos: LEASE_PADRAO_SEGUNDOS,
    // O desligamento já aconteceu quando isto é chamado; aqui só o código de
    // saída. Não-zero é o que faz o `Restart=on-failure` do unit agir.
    aoFalhaFatal: () => process.exit(1),
  });

  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sinal, () => {
      log(`sinal ${sinal} recebido — desligando`);
      // Regra de código de saída: queda do polling SEM sinal antes → sai 1 (o
      // `Restart=on-failure` reergue). Desligamento iniciado por sinal sai 0
      // mesmo se o polling rejeitar no meio do dreno: `parar()` é memoizado,
      // este `.then` foi registrado primeiro, e a parada era intencional —
      // reiniciar aqui seria desfazer o que o operador pediu.
      void svc.parar().then(
        () => process.exit(0),
        (e: unknown) => {
          log(`desligamento falhou: ${(e as Error).message}`);
          process.exit(1);
        },
      );
    });
  }

  await svc.iniciar();
  log(`serviço no ar v${VERSAO} (filas: ${FILAS.join(', ')})`);
}

// Só quando EXECUTADO — nunca no import (os testes importam este módulo).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((e: unknown) => {
    // stderr cru de propósito: o que falhou aqui pode ser o próprio
    // `carregarConfig`, e então não existe `cfg.logFile` para onde escrever.
    process.stderr.write(`boot falhou: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
