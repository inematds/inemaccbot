// Boot, laço e desligamento. Estes testes provam ORDEM, não só resultado: a
// etapa 0 inteira (lease, recuperação, drain) fica inerte se o index.ts não
// chamar as coisas na sequência certa do spec §3.6.
//
// Nenhum teste toca Telegram nem rede — o transporte é sempre falso, e o DB é
// sempre um ARQUIVO temporário (nunca :memory:, porque o serviço abre a sua
// própria conexão sobre o mesmo caminho).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from './db/abrir.js';
import { MIGRATIONS, aplicarMigrations, checksum } from './db/migrations.js';
import { FilaSqlite } from './fila/store.js';
import type { Tarefa } from './fila/worker.js';
import type { Config } from './config.js';
import type { Transporte } from './gateway/telegram.js';
import { criarServico, ligarPolling } from './index.js';
import type { BotMinimo } from './index.js';
import type { DepsServico, Servico } from './index.js';

let dir: string;
let t = 1_000;
const agora = (): number => t;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-index-'));
  t = 1_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function criarCfg(): Config {
  return {
    botToken: 'token-de-teste-nunca-logado',
    queueDb: join(dir, 'fila.db'),
    stateDir: join(dir, 'estado'),
    logFile: join(dir, 'bot.log'),
    chatsPermitidos: [42],
    motorPadrao: 'claude',
    modeloPadrao: 'sonnet',
    esforcoPadrao: 'low',
    projetosDir: '/tmp/projetos-inexistente',
  };
}

interface FakeTransporte {
  iniciados: number;
  parados: number;
  mensagens: { chatId: number; texto: string }[];
}

/** `atrasoMs` existe para o teste da CAUDA de notificação: no Telegram real o
 * envio é uma chamada de rede, e é justamente esse tempo que expõe quem espera
 * só `drenar()` (que resolve com a mensagem ainda em voo). Com envio
 * instantâneo a regressão passaria despercebida. */
function fakeTransporte(atrasoMs = 0): { registro: FakeTransporte; criar: DepsServico['criarTransporte'] } {
  const registro: FakeTransporte = { iniciados: 0, parados: 0, mensagens: [] };
  const transporte: Transporte = {
    async responder(chatId, texto) {
      if (atrasoMs > 0) await new Promise((r) => setTimeout(r, atrasoMs));
      registro.mensagens.push({ chatId, texto });
    },
  };
  return {
    registro,
    criar: () => ({
      async iniciar() { registro.iniciados += 1; },
      async parar() { registro.parados += 1; },
      transporte,
    }),
  };
}

interface Montagem {
  svc: Servico;
  linhas: string[];
  registro: FakeTransporte;
}

function montar(
  tarefas: Record<string, Tarefa>,
  over: Partial<DepsServico> = {},
  atrasoEnvioMs = 0,
): Montagem {
  const linhas: string[] = [];
  const { registro, criar } = fakeTransporte(atrasoEnvioMs);
  const svc = criarServico(criarCfg(), {
    agora,
    criarTransporte: criar,
    log: (m) => { linhas.push(m); },
    intervaloOciosoMs: 2,
    heartbeatMs: 5,
    timeoutDrenoMs: 2_000,
    leaseSegundos: 60,
    criarTarefas: () => tarefas,
    ...over,
  });
  return { svc, linhas, registro };
}

/** Semeia o banco ANTES do serviço subir, deixando um job preso em `running`
 * com lease vencido — exatamente o rastro de um `kill -9`. */
function semearJobPreso(opts: { maxTentativas: number; chatId?: number }): void {
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, agora, MIGRATIONS);
  const fila = new FilaSqlite(db, agora);
  fila.enfileirar({
    fila: 'io', kind: 'function', tarefa: 'fake.ok', input: 'x',
    max_tentativas: opts.maxTentativas,
    chat_id: opts.chatId ?? null,
  });
  // Outra instância pegou o job e morreu com ele na mão.
  const pego = fila.pegar('io', 60, 'instancia-morta:1');
  if (!pego) throw new Error('semente: nada foi reclamado');
  db.close();
  t = 5_000; // relógio avança muito além do lease (1_000 + 60)
}

/** Lê o job por uma conexão NOVA — `parar()` fecha a do serviço, e ler de fora
 * ainda prova que o estado final ficou durável no arquivo. */
function lerJob(id: number): ReturnType<FilaSqlite['obter']> {
  const db = abrirDb(join(dir, 'fila.db'));
  try {
    return new FilaSqlite(db, agora).obter(id);
  } finally {
    db.close();
  }
}

async function ate(cond: () => boolean, limiteMs = 3_000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condição não atingida no tempo limite');
}

const OK: Record<string, Tarefa> = { 'fake.ok': async () => 'pronto' };

describe('boot', () => {
  it('sobe com DB vazio, sem erro, e cria a raiz de mídia', async () => {
    const { svc, registro } = montar(OK);
    await svc.iniciar();
    expect(existsSync(join(dir, 'estado', 'midia'))).toBe(true);
    expect(registro.iniciados).toBe(1);
    await svc.parar();
    expect(registro.parados).toBe(1);
  });

  it('recupera leases vencidos ANTES do primeiro passo() e loga o resultado', async () => {
    semearJobPreso({ maxTentativas: 3 });
    const { svc, linhas } = montar(OK);
    await svc.iniciar();
    // Se a recuperação não rodasse (ou rodasse depois do primeiro passo), o job
    // continuaria `running` com dono de outra instância e NUNCA seria pego.
    await ate(() => svc.fila.obter(1)?.status === 'done');
    await svc.parar();

    expect(lerJob(1)?.status).toBe('done');

    const iRecuperacao = linhas.findIndex((l) => /requeued=1 failed=0/.test(l));
    const iPrimeiroPasso = linhas.findIndex((l) => /^\[job 1/.test(l));
    expect(iRecuperacao).toBeGreaterThanOrEqual(0);
    expect(iPrimeiroPasso).toBeGreaterThanOrEqual(0);
    // A prova de ordem: o log da recuperação precede o log do claim.
    expect(iRecuperacao).toBeLessThan(iPrimeiroPasso);
  });

  it('job preso que já esgotou as tentativas vira failed, não volta pra fila', async () => {
    semearJobPreso({ maxTentativas: 1 });
    const { svc, linhas } = montar(OK);
    await svc.iniciar();
    await svc.parar();

    expect(lerJob(1)?.status).toBe('failed');
    expect(linhas.some((l) => /requeued=0 failed=1/.test(l))).toBe(true);
  });

  it('checksum divergente aborta o boot nomeando a migration', async () => {
    const db = abrirDb(join(dir, 'fila.db'));
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, nome TEXT NOT NULL,
      checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);`);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
      .run(1, 'jobs', checksum('-- outro SQL qualquer'), 1_000);
    db.close();

    const { svc, registro } = montar(OK);
    await expect(svc.iniciar()).rejects.toThrow(/migration 1 \(jobs\)/);
    // O serviço não pode ter subido nada sobre um schema que não reconhece.
    expect(registro.iniciados).toBe(0);
    expect(svc.timers()).toBe(0);
  });

  it('transporte que falha ao iniciar desmonta o que já subiu', async () => {
    // Caso comum em produção: BOT_TOKEN inválido derruba `bot.init()`. Os laços
    // e o heartbeat já estão de pé nesse ponto; sem desmonte, um `iniciar()`
    // tentado de novo poria um SEGUNDO conjunto de laços na mesma fila.
    const { svc } = montar(OK, {
      criarTransporte: () => ({
        async iniciar() { throw new Error('token inválido'); },
        async parar() { /* nada a parar */ },
        transporte: { async responder() { /* nunca chamado */ } },
      }),
    });
    await expect(svc.iniciar()).rejects.toThrow(/token inválido/);
    expect(svc.timers()).toBe(0);
  });
});

describe('desligamento', () => {
  it('parar() espera o job em voo terminar — ele fica done, não queued', async () => {
    let comecou = false;
    const tarefas: Record<string, Tarefa> = {
      'fake.lenta': async () => {
        comecou = true;
        await new Promise((r) => setTimeout(r, 120));
        return 'terminei';
      },
    };
    const { svc } = montar(tarefas);
    await svc.iniciar();
    svc.fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'fake.lenta', input: 'x' });
    await ate(() => comecou);
    await svc.parar();

    const job = lerJob(1);
    expect(job?.status).toBe('done');
    expect(job?.resultado).toBe('terminei');
  });

  it('parar() com job que nunca termina estoura o timeout e não deixa lease vivo', async () => {
    let comecou = false;
    const tarefas: Record<string, Tarefa> = {
      'fake.travada': async () => {
        comecou = true;
        await new Promise(() => { /* nunca resolve */ });
        return 'inalcançável';
      },
    };
    const { svc } = montar(tarefas, { timeoutDrenoMs: 60 });
    await svc.iniciar();
    svc.fila.enfileirar({ fila: 'cpu', kind: 'function', tarefa: 'fake.travada', input: 'x' });
    await ate(() => comecou);
    await svc.parar();

    const job = lerJob(1);
    // A garantia que importa: recuperável. Nunca `running` com lease vivo.
    expect(job?.status).not.toBe('running');
    expect(['queued', 'failed']).toContain(job?.status);
    expect(job?.lease_owner).toBeNull();
    expect(job?.lease_ate).toBeNull();
  });

  it('nenhum timer do serviço sobrevive a parar()', async () => {
    const { svc } = montar(OK);
    await svc.iniciar();
    // Enquanto roda existe pelo menos o heartbeat.
    expect(svc.timers()).toBeGreaterThan(0);
    await svc.parar();
    expect(svc.timers()).toBe(0);
  });

  it('parar() é idempotente (SIGTERM + SIGINT no mesmo processo)', async () => {
    const { svc, registro } = montar(OK);
    await svc.iniciar();
    await Promise.all([svc.parar(), svc.parar()]);
    await svc.parar();
    expect(registro.parados).toBe(1);
  });
});

describe('notificação', () => {
  it('job com chat_id vira mensagem no transporte ao terminar', async () => {
    const { svc, registro } = montar(OK);
    await svc.iniciar();
    svc.fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'fake.ok', input: 'x', chat_id: 42 });
    await ate(() => registro.mensagens.length > 0);
    await svc.parar();
    expect(registro.mensagens[0]?.chatId).toBe(42);
    expect(registro.mensagens[0]?.texto).toMatch(/Job 1 conclu/);
  });

  // §8 não abre exceção por caminho: a recuperação de boot é uma transição
  // TERMINAL fora do Worker. Sem a notificação aqui, o chat que pediu o job
  // nunca fica sabendo que ele morreu no `kill -9` — silêncio permanente.
  it('job morto no kill -9 e esgotado de tentativas avisa o chat no próximo boot', async () => {
    semearJobPreso({ maxTentativas: 1, chatId: 42 });
    const { svc, registro } = montar(OK);
    await svc.iniciar();
    // Já durante o `iniciar()`: nada de esperar laço nenhum.
    expect(registro.mensagens).toHaveLength(1);
    expect(registro.mensagens[0]?.chatId).toBe(42);
    expect(registro.mensagens[0]?.texto).toMatch(/Job 1 falhou/);
    expect(registro.mensagens[0]?.texto).toMatch(/lease vencido sem ack/);
    await svc.parar();
  });

  it('job recuperado que só volta pra fila NÃO avisa o chat (retentativa não é término)', async () => {
    semearJobPreso({ maxTentativas: 3, chatId: 42 });
    const { svc, registro } = montar(OK);
    await svc.iniciar();
    const naFalha = registro.mensagens.filter((m) => /falhou/.test(m.texto));
    expect(naFalha).toHaveLength(0);
    await svc.parar();
  });

  // §8 de novo, no outro extremo do ciclo de vida: `abortar()` fecha o job como
  // `failed` fora do `passo()` (o catch de `passo()` pula o id em `abortados`).
  // E a mensagem tem que estar FEITA quando `parar()` resolve — `main()` chama
  // `process.exit(0)` logo em seguida e cortaria um envio solto.
  it('job abortado no encerramento avisa o chat antes de parar() resolver', async () => {
    let comecou = false;
    const tarefas: Record<string, Tarefa> = {
      'fake.travada': async () => {
        comecou = true;
        await new Promise(() => { /* nunca resolve */ });
        return 'inalcançável';
      },
    };
    const { svc, registro } = montar(tarefas, { timeoutDrenoMs: 60 });
    await svc.iniciar();
    svc.fila.enfileirar({
      fila: 'cpu', kind: 'function', tarefa: 'fake.travada', input: 'x',
      chat_id: 42, max_tentativas: 1,
    });
    await ate(() => comecou);
    await svc.parar();

    expect(registro.mensagens.map((m) => m.texto)).toEqual([
      expect.stringMatching(/Job 1 falhou/) as unknown as string,
    ]);
    expect(registro.mensagens[0]?.texto).toMatch(/interrompido no encerramento/);
  });

  // GUARDA DE REGRESSÃO (não simplificar o `Promise.all` de `desligar()`):
  // `passo()` tira o job de `ativos` ANTES do `aoTerminar`, então `drenar()`
  // sozinho pode resolver com a mensagem ainda em voo. Trocar aquela corrida
  // por `workers.map(w => w.drenar())` faz ESTE teste ficar vermelho.
  it('job que termina DURANTE o dreno tem a mensagem enviada antes de parar() resolver', async () => {
    let comecou = false;
    const tarefas: Record<string, Tarefa> = {
      'fake.lenta': async () => {
        comecou = true;
        await new Promise((r) => setTimeout(r, 120));
        return 'terminei';
      },
    };
    // Envio com latência de rede (como o Telegram de verdade): é o que revela
    // que `drenar()` sozinho resolve com a mensagem ainda em voo.
    const { svc, registro } = montar(tarefas, {}, 150);
    await svc.iniciar();
    svc.fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'fake.lenta', input: 'x', chat_id: 42 });
    await ate(() => comecou);
    // O job ainda está rodando: nada foi notificado.
    expect(registro.mensagens).toHaveLength(0);

    await svc.parar();

    // Sem esperar mais nada depois do `parar()` — é este o ponto.
    expect(registro.mensagens).toHaveLength(1);
    expect(registro.mensagens[0]?.texto).toMatch(/Job 1 conclu/);
  });
});

describe('gateway caído depois do boot', () => {
  // §8: silêncio nunca é estado válido. Antes desta correção, o laço de polling
  // caía num `console.error` e o serviço seguia de pé, surdo, até alguém notar.
  it('derruba o serviço e loga quando o polling cai depois do boot', async () => {
    let derrubar: ((e: Error) => void) | undefined;
    const linhas: string[] = [];
    const fatais: Error[] = [];
    const svc = criarServico(criarCfg(), {
      agora,
      criarTransporte: (_cfg, d) => {
        derrubar = d.aoFalhaFatal;
        return {
          async iniciar() { /* boot OK; o polling só cai depois */ },
          async parar() { /* nada */ },
          transporte: { async responder() { /* nada */ } },
        };
      },
      log: (m) => { linhas.push(m); },
      intervaloOciosoMs: 2,
      heartbeatMs: 5,
      timeoutDrenoMs: 2_000,
      leaseSegundos: 60,
      criarTarefas: () => OK,
      aoFalhaFatal: (e) => { fatais.push(e); },
    });
    await svc.iniciar();
    expect(svc.timers()).toBeGreaterThan(0);

    derrubar!(new Error('polling morreu'));
    await ate(() => fatais.length > 0);

    // Parado de verdade: sem timers vivos e sem DB aberto.
    expect(svc.timers()).toBe(0);
    expect(fatais[0]?.message).toBe('polling morreu');
    expect(linhas.join('\n')).toMatch(/FATAL.*polling morreu/);
    // `parar()` é memoizado: um SIGTERM depois disso não desliga de novo.
    await svc.parar();
  });

  it('ligarPolling manda a queda do bot.start() para o log e para a falha fatal', async () => {
    const linhas: string[] = [];
    const fatais: Error[] = [];
    let parou = 0;
    const bot: BotMinimo = {
      async init() { /* token OK */ },
      async start() { throw new Error('getUpdates 401'); },
      async stop() { parou += 1; },
    };
    const ciclo = ligarPolling(bot, {
      log: (m) => { linhas.push(m); },
      aoFalhaFatal: (e) => { fatais.push(e); },
    });
    await ciclo.iniciar();
    await ate(() => fatais.length > 0);
    expect(fatais[0]?.message).toMatch(/401/);
    expect(linhas.join('\n')).toMatch(/polling caiu.*401/);
    await ciclo.parar();
    expect(parou).toBe(1);
  });
});
