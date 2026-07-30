// Teste ponta a ponta: cruza gateway/ e fila/ de propósito — vive em
// src/integracao/ por isso (a exceção fixada na etapa 0 às regras de fronteira
// de src/arquitetura.test.ts). É o único teste que prova que uma mensagem
// digitada num chat vira job, roda, e volta como resposta — incluindo o
// caminho triste (spec §8: silêncio nunca é estado válido) e a allowlist.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../config.js';
import { criarHttpGet } from '../fila/tarefas/http.js';
import type { Tarefa } from '../fila/worker.js';
import { rotear } from '../gateway/telegram.js';
import type { Transporte } from '../gateway/telegram.js';
import { criarServico } from '../index.js';
import type { Servico } from '../index.js';

let dir: string;
let t = 1_000;
const agora = (): number => t;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-ponta-a-ponta-'));
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

/** `fetch` falso: nunca toca a rede. Uma URL devolve 200 com corpo; outra
 * devolve 500 — é o caminho triste, exatamente como o brief sugere (task-10). */
function fakeFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = input.toString();
    if (url === 'https://exemplo.test/erro') {
      return { ok: false, status: 500, text: async () => 'não usado' } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => 'corpo-de-teste' } as unknown as Response;
  }) as typeof fetch;
}

/** Monta o serviço com um transporte fake que faz o MESMO roteamento que
 * `criarBot` faz de verdade (allowlist -> aoComando -> corte -> envio) via
 * `rotear`/`enviarPedacos` reais — só o `grammy` é trocado. É o que garante
 * que este teste exercita a allowlist de ponta a ponta, não só o `executar`. */
function montar(): {
  svc: Servico;
  mensagens: { chatId: number; texto: string }[];
  chegar: (chatId: number, texto: string) => Promise<void>;
} {
  const cfg = criarCfg();
  const mensagens: { chatId: number; texto: string }[] = [];
  let aoComandoCapturado: ((chatId: number, texto: string) => Promise<string>) | undefined;

  const svc = criarServico(cfg, {
    agora,
    criarTransporte: (_c, deps) => {
      aoComandoCapturado = deps.aoComando;
      const transporte: Transporte = {
        async responder(chatId, texto) {
          mensagens.push({ chatId, texto });
        },
      };
      return {
        async iniciar() { /* nada a iniciar num fake */ },
        async parar() { /* nada a parar num fake */ },
        transporte,
      };
    },
    log: () => { /* log do serviço não é parte deste teste */ },
    intervaloOciosoMs: 2,
    heartbeatMs: 5,
    timeoutDrenoMs: 2_000,
    leaseSegundos: 60,
    criarTarefas: () => ({ 'http.get': criarHttpGet(fakeFetch()) }) as Record<string, Tarefa>,
  });

  const chegar = async (chatId: number, texto: string): Promise<void> => {
    const pedacos = await rotear(
      { chatId, texto },
      {
        permitido: (id) => cfg.chatsPermitidos.includes(id),
        aoComando: aoComandoCapturado!,
        log: () => { /* log do gateway não é parte deste teste */ },
      },
    );
    for (const pedaco of pedacos) mensagens.push({ chatId, texto: pedaco });
  };

  return { svc, mensagens, chegar };
}

async function ate(cond: () => boolean, limiteMs = 3_000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condição não atingida no tempo limite');
}

describe('ponta a ponta: chat -> job -> execução -> resposta', () => {
  it('caminho feliz: http <url> vira job, executa, notifica e some da fila', async () => {
    const { svc, mensagens, chegar } = montar();
    await svc.iniciar();

    // 1. mensagem de um chat PERMITIDO.
    await chegar(42, 'http https://exemplo.test/x');

    // "enfileirado: job N (http.get)" é a resposta síncrona do comando.
    const ack = mensagens.find((m) => /enfileirado: job \d+ \(http\.get\)/.test(m.texto));
    expect(ack).toBeDefined();
    const id = Number(/job (\d+)/.exec(ack!.texto)![1]);

    // 2. o job existe na fila `io` com chat_id preenchido.
    const job = svc.fila.obter(id);
    expect(job?.fila).toBe('io');
    expect(job?.tarefa).toBe('http.get');
    expect(job?.chat_id).toBe(42);

    // 3. o worker roda e conclui com o corpo buscado.
    await ate(() => svc.fila.obter(id)?.status === 'done');
    expect(svc.fila.obter(id)?.resultado).toBe('corpo-de-teste');

    // 4. o notificador manda ao chat certo uma mensagem com o id do job.
    await ate(() => mensagens.some((m) => m.chatId === 42 && new RegExp(`Job ${id} conclu`).test(m.texto)));

    // 5. /fila não mostra mais nada pendente na fila `io`.
    await chegar(42, '/fila');
    const resumo = mensagens.at(-1)!.texto;
    expect(resumo).toMatch(/io: rodando=0 pendentes=0/);

    await svc.parar();
  });

  it('caminho triste: tarefa que falha vira job failed e o chat RECEBE id + trecho do erro', async () => {
    const { svc, mensagens, chegar } = montar();
    await svc.iniciar();

    await chegar(42, 'http https://exemplo.test/erro');
    const ack = mensagens.find((m) => /enfileirado: job \d+ \(http\.get\)/.test(m.texto));
    const id = Number(/job (\d+)/.exec(ack!.texto)![1]);

    await ate(() => svc.fila.obter(id)?.status === 'failed');

    // A garantia que a spec §8 exige, exercitada de ponta a ponta: uma falha
    // NUNCA é silenciosa — o chat vê o id e um pedaço do erro real.
    const notificacao = mensagens.find(
      (m) => m.chatId === 42 && new RegExp(`Job ${id} falhou`).test(m.texto),
    );
    expect(notificacao).toBeDefined();
    expect(notificacao!.texto).toMatch(/HTTP 500/);

    await svc.parar();
  });

  it('allowlist: mensagem de chat fora da lista não vira job nem resposta', async () => {
    const { svc, mensagens, chegar } = montar();
    await svc.iniciar();

    await chegar(999, 'http https://exemplo.test/x');

    // Nenhum ack, nenhum job, nenhuma tentativa de execução: o roteamento
    // barra ANTES de `aoComando`.
    expect(mensagens).toEqual([]);
    expect(svc.fila.obter(1)).toBeUndefined();

    await svc.parar();
  });
});
