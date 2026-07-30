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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Config, carregarConfig } from './config.js';
import { abrirDb } from './db/abrir.js';
import { redatorPadrao } from './dominio/redacao.js';
import { carregarSkills as carregarSkillsPadrao, type SkillDef } from './dominio/registry.js';
import { criarPromptDe, parseEntradaSkill } from './fila/skills.js';
import { aplicarMigrations } from './db/migrations.js';
import { CONCORRENCIAS, FILAS } from './fila/filas.js';
import { FilaSqlite } from './fila/store.js';
import { RUNNERS } from './fila/runner.js';
import './fila/runner-claude.js'; // efeito colateral: registra RUNNERS.claude
import { criarTarefas as criarTarefasPadrao } from './fila/tarefas/index.js';
import type { Agora, Fila, Job } from './fila/types.js';
import { Worker, type Tarefa } from './fila/worker.js';
import { executar, parseComando } from './gateway/comandos.js';
import { criarNotificador } from './gateway/notificar.js';
import { type Transporte, criarBot } from './gateway/telegram.js';

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
    executar(parseComando(texto, defs, cfg.projetosDir), {
      fila,
      chatId,
      agora: deps.agora,
      defs,
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
    defs = (deps.carregarSkills ?? carregarSkillsPadrao)(
      join(RAIZ_REPO, 'config', 'skills.json'),
      RAIZ_REPO,
    );
    const promptDe = criarPromptDe({
      defs,
      raizRepo: RAIZ_REPO,
      raizArtefatos,
      cwd: homedir(),
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

    // 5. só então: workers e bot.
    const tarefas = (deps.criarTarefas ?? criarTarefasPadrao)({ raizMidia });
    transp = deps.criarTransporte(cfg, { aoComando, log: deps.log, aoFalhaFatal: falhaFatal });
    const notificar = criarNotificador(transp.transporte, {
      redigir,
      log: deps.log,
      // Só job de SKILL produz artefato em disco. `http.get` devolve texto e
      // `ffmpeg.thumb` já responde o caminho — tratá-los como artefato faria a
      // entrega tentar ler um corpo HTTP como se fosse arquivo.
      temArtefato: (job) => defs.some((d) => d.command === job.tarefa),
      destinoDe: (job) => {
        try {
          return parseEntradaSkill(job.input).destino;
        } catch {
          return undefined;
        }
      },
    });

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
          aoTerminar: notificar,
          redigir,
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

/** Parser mínimo de .env: `CHAVE=valor`, `#` comenta a linha, aspas opcionais.
 * Não é dotenv — é o suficiente para o boot e não acrescenta dependência. */
export function lerEnv(texto: string): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const linha of texto.split('\n')) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;
    const i = limpa.indexOf('=');
    if (i <= 0) continue;
    const chave = limpa.slice(0, i).trim();
    let valor = limpa.slice(i + 1).trim();
    if (valor.length >= 2 && (valor.startsWith('"') || valor.startsWith("'")) && valor.at(-1) === valor[0]) {
      valor = valor.slice(1, -1);
    }
    saida[chave] = valor;
  }
  return saida;
}

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
  },
): TransporteServico {
  const { bot, transporte } = criarBot(cfg, { aoComando: deps.aoComando, log: deps.log });
  const ciclo = ligarPolling(bot, deps);
  return { ...ciclo, transporte };
}

export async function main(): Promise<void> {
  const arquivo = resolve(process.cwd(), '.env');
  const doArquivo = existsSync(arquivo) ? lerEnv(readFileSync(arquivo, 'utf8')) : {};
  // O ambiente do processo vence o arquivo (systemd/override manual).
  const cfg = carregarConfig({ ...doArquivo, ...process.env });

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
    criarTransporte: criarTransporteReal,
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
  log(`serviço no ar (filas: ${FILAS.join(', ')})`);
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
