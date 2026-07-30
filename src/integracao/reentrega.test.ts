// Regressão herdada do `watcher.test.ts` do v1 (spec §6.5).
//
// O caso original: "notify falha em job done → o job continua pendente, o
// status não é persistido, e uma passagem seguinte com notify funcionando
// entrega a mensagem EXATAMENTE UMA VEZ".
//
// No v1 isso caía de graça do desenho: o watcher só marcava o job como visto
// depois do envio dar certo. No v2 o worker acka o job e depois notifica — se a
// notificação falhasse, a mensagem sumia para sempre e o log era o único
// rastro. Silêncio, que a §8 proíbe.
//
// A coluna `notificado_em` é o equivalente: enquanto for NULL num job terminal
// com `chat_id`, o dono ainda não sabe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from '../fila/store.js';
import { Worker } from '../fila/worker.js';
import { criarNotificador } from '../gateway/notificar.js';
import type { Transporte } from '../gateway/telegram.js';
import type { Job } from '../fila/types.js';
import { ehFalhaPermanenteDeEnvio } from '../index.js';

let dir: string;
let fila: FilaSqlite;
const t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-reentrega-'));
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Transporte que falha as `falhasIniciais` primeiras tentativas. */
function transporteInstavel(falhasIniciais: number): { transporte: Transporte; enviadas: string[] } {
  const enviadas: string[] = [];
  let restantes = falhasIniciais;
  return {
    enviadas,
    transporte: {
      async responder(_c: number, texto: string): Promise<void> {
        if (restantes > 0) { restantes -= 1; throw new Error('Telegram fora do ar'); }
        enviadas.push(texto);
      },
    },
  };
}

function worker(aoTerminar: (job: Job) => Promise<void>): Worker {
  return new Worker(fila, {
    fila: 'io', dono: 'A', concorrencia: 1, leaseSegundos: 60,
    tarefas: { ok: async () => 'pronto' },
    runners: {},
    promptDe: async () => { throw new Error('sem agente neste teste'); },
    aoTerminar,
  }, () => t);
}

/** A varredura que o serviço roda no heartbeat, reduzida ao essencial. */
async function varrer(notificar: (job: Job) => Promise<void>): Promise<void> {
  for (const job of fila.pendentesDeNotificacao()) {
    try {
      await notificar(job);
      fila.marcarNotificado(job.id);
    } catch { /* fica pendente para a próxima */ }
  }
}

describe('falha permanente de envio', () => {
  // Retentar "chat not found" a cada 20 segundos é bater numa porta que não
  // abre — para sempre, contra uma API externa.
  it('é reconhecida pela mensagem do Telegram', () => {
    for (const m of [
      '400: Bad Request: chat not found',
      'Forbidden: bot was blocked by the user',
      '400: Bad Request: message is too long',
    ]) expect(ehFalhaPermanenteDeEnvio(m)).toBe(true);
  });

  it('falha transitória NÃO é confundida com permanente', () => {
    for (const m of ['ETIMEDOUT', '429: Too Many Requests', 'socket hang up']) {
      expect(ehFalhaPermanenteDeEnvio(m)).toBe(false);
    }
  });
});

describe('notificação que falhou é reentregue — exatamente uma vez', () => {
  it('mensagem perdida no ack volta na varredura seguinte', async () => {
    const { transporte, enviadas } = transporteInstavel(1);
    const notificar = criarNotificador(transporte);
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '{}', chat_id: 7 });

    await worker(notificar).passo();
    // O job terminou de verdade, mas o dono não soube.
    expect(fila.obter(1)!.status).toBe('done');
    expect(enviadas).toHaveLength(0);
    expect(fila.obter(1)!.notificado_em).toBeNull();

    await varrer(notificar);
    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]).toContain('Job 1');

    // E não repete: é o "exatamente uma vez" do caso original.
    await varrer(notificar);
    expect(enviadas).toHaveLength(1);
  });

  it('notificação que deu certo de primeira não é reenviada', async () => {
    const { transporte, enviadas } = transporteInstavel(0);
    const notificar = criarNotificador(transporte);
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '{}', chat_id: 7 });

    await worker(notificar).passo();
    expect(enviadas).toHaveLength(1);
    expect(fila.obter(1)!.notificado_em).not.toBeNull();

    await varrer(notificar);
    expect(enviadas).toHaveLength(1);
  });

  it('job sem chat_id nunca entra na fila de reentrega', async () => {
    const { transporte } = transporteInstavel(0);
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '{}' });
    await worker(criarNotificador(transporte)).passo();
    expect(fila.pendentesDeNotificacao()).toHaveLength(0);
  });

  // Cancelamento já foi confirmado no chat pelo próprio comando que o disparou:
  // reentregar isso seria ruído.
  it('job cancelado não vira pendência de notificação', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '{}', chat_id: 7 });
    fila.cancelar(1);
    expect(fila.pendentesDeNotificacao()).toHaveLength(0);
  });

  // Sem trava, duas varreduras concorrentes veem as MESMAS linhas ainda não
  // marcadas e mandam a mensagem duas vezes — quebrando o "exatamente uma vez"
  // que a varredura existe para garantir. Acontece de verdade quando uma
  // passagem demora mais que o intervalo do heartbeat.
  it('duas varreduras concorrentes não mandam a mesma mensagem duas vezes', async () => {
    const enviadas: string[] = [];
    const transporte: Transporte = {
      async responder(_c, texto) {
        await new Promise((r) => { setTimeout(r, 30); });
        enviadas.push(texto);
      },
    };
    const notificar = criarNotificador(transporte);
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '{}', chat_id: 7 });
    fila.pegar('io', 60, 'A');
    fila.concluir(1, 'ok', 'A');

    let varrendo = false;
    const comTrava = async (): Promise<void> => {
      if (varrendo) return;
      varrendo = true;
      try { await varrer(notificar); } finally { varrendo = false; }
    };
    await Promise.all([comTrava(), comTrava()]);
    expect(enviadas).toHaveLength(1);
  });

  it('marcarNotificado é idempotente — a segunda chamada não faz nada', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '{}', chat_id: 7 });
    fila.pegar('io', 60, 'A');
    fila.concluir(1, 'ok', 'A');
    expect(fila.marcarNotificado(1)).toBe(true);
    expect(fila.marcarNotificado(1)).toBe(false);
  });
});
