// src/gateway/notificar.test.ts
import { describe, expect, it } from 'vitest';

import { criarNotificador } from './notificar.js';
import type { Transporte } from './telegram.js';
import type { Job } from '../fila/types.js';

function job(over: Partial<Job> = {}): Job {
  return {
    id: 1,
    fila: 'io',
    kind: 'function',
    tarefa: 'x',
    input: '',
    prioridade: 0,
    status: 'done',
    tentativas: 1,
    max_tentativas: 3,
    lease_ate: null,
    lease_owner: null,
    disponivel_em: 0,
    idem_key: null,
    flow_ref: null,
    chat_id: 42,
    motor: null,
    modelo: null,
    esforco: null,
    resultado: null,
    erro: null,
    criado_em: 0,
    iniciado_em: null,
    terminado_em: null,
    ...over,
  };
}

function fakeTransporte(): { transporte: Transporte; chamadas: Array<{ chatId: number; texto: string }> } {
  const chamadas: Array<{ chatId: number; texto: string }> = [];
  return {
    chamadas,
    transporte: {
      async responder(chatId: number, texto: string): Promise<void> {
        chamadas.push({ chatId, texto });
      },
    },
  };
}

describe('criarNotificador', () => {
  it('job done: uma mensagem pro chat certo, contendo o id e o resultado', async () => {
    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte);
    await notificar(job({ status: 'done', chat_id: 42, resultado: 'saída pronta' }));
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.chatId).toBe(42);
    expect(chamadas[0]!.texto).toContain('1');
    expect(chamadas[0]!.texto).toContain('saída pronta');
  });

  it('job failed: uma mensagem contendo o id e o erro, truncado se longo', async () => {
    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte);
    const erroLongo = 'x'.repeat(5_000);
    await notificar(job({ status: 'failed', chat_id: 7, erro: erroLongo }));
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.chatId).toBe(7);
    expect(chamadas[0]!.texto).toContain('1');
    expect(chamadas[0]!.texto.length).toBeLessThan(erroLongo.length);
  });

  it('chat_id null: não notifica ninguém', async () => {
    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte);
    await notificar(job({ status: 'done', chat_id: null, resultado: 'x' }));
    expect(chamadas).toHaveLength(0);
  });

  it('status canceled: não notifica ninguém', async () => {
    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte);
    await notificar(job({ status: 'canceled', chat_id: 42 }));
    expect(chamadas).toHaveLength(0);
  });

  it('status queued (requeue): não notifica ninguém', async () => {
    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte);
    await notificar(job({ status: 'queued', chat_id: 42 }));
    expect(chamadas).toHaveLength(0);
  });
});
