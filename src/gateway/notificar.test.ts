// src/gateway/notificar.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    notificado_em: null,
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

/** Transporte que também registra anexos — o de cima cobre só texto de propósito
 * (`enviarDocumento` é opcional na interface). */
function transporteComAnexo(): {
  transporte: Transporte;
  textos: string[];
  anexos: string[];
} {
  const textos: string[] = [];
  const anexos: string[] = [];
  return {
    textos,
    anexos,
    transporte: {
      async responder(_c: number, texto: string): Promise<void> { textos.push(texto); },
      async enviarDocumento(_c: number, caminho: string): Promise<void> { anexos.push(caminho); },
    },
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-notif-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  describe('entrega de artefato (job de skill)', () => {
    const skill = { temArtefato: () => true };

    it('transcrição curta chega como TEXTO no chat', async () => {
      const { transporte, textos, anexos } = transporteComAnexo();
      const arq = join(dir, 'a.txt');
      writeFileSync(arq, 'o que foi falado');
      await criarNotificador(transporte, skill)(job({ status: 'done', resultado: arq }));
      expect(textos.join('\n')).toContain('o que foi falado');
      expect(anexos).toEqual([]);
    });

    it('vídeo dublado chega como ANEXO', async () => {
      const { transporte, anexos } = transporteComAnexo();
      const arq = join(dir, 'v.mp4');
      writeFileSync(arq, 'bytes');
      await criarNotificador(transporte, skill)(job({ status: 'done', resultado: arq }));
      expect(anexos).toEqual([arq]);
    });

    // Sem `temArtefato`, o resultado de um `http.get` (corpo da resposta) seria
    // tratado como caminho de arquivo.
    it('job que NÃO é skill continua com o resultado cru na mensagem', async () => {
      const { transporte, textos } = transporteComAnexo();
      await criarNotificador(transporte)(job({ status: 'done', resultado: 'corpo http' }));
      expect(textos.join('')).toContain('corpo http');
    });

    it('falha ao enviar o anexo não derruba nada — o caminho já foi no texto', async () => {
      const arq = join(dir, 'v.mp4');
      writeFileSync(arq, 'bytes');
      const transporte: Transporte = {
        async responder(): Promise<void> { /* ok */ },
        async enviarDocumento(): Promise<void> { throw new Error('rede caiu'); },
      };
      await expect(criarNotificador(transporte, skill)(job({ status: 'done', resultado: arq })))
        .resolves.toBeUndefined();
    });

    it('erro de job passa pelo redator antes de ir pro chat', async () => {
      const { transporte, chamadas } = fakeTransporte();
      const notificar = criarNotificador(transporte, { redigir: (t) => t.replace('segredo', '«x»') });
      await notificar(job({ status: 'failed', erro: 'vazou segredo aqui' }));
      expect(chamadas[0]!.texto).not.toContain('segredo');
    });
  });
});

/**
 * A#8: 11 reels prontos e ZERO entregues no `livesN`. A entrega morava dentro
 * do notificador, que desistia quando `chat_id` era nulo — e job de fase de
 * fluxo tem chat nulo de propósito.
 */
describe('job de fluxo (sem chat) ainda ENTREGA', () => {
  it('copia o artefato para o destino mesmo sem chat', async () => {
    const origem = join(dir, 'reel.mp4');
    const destinoDir = join(dir, 'yt-pub-lives24', 'imports', 'videos');
    mkdirSync(destinoDir, { recursive: true });
    writeFileSync(origem, 'video');

    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte, {
      temArtefato: () => true,
      entregaDe: () => ({ destinoDir, nome: 'A8-mulheres-v1.mp4' }),
    });
    await notificar(job({ chat_id: null, status: 'done', resultado: origem }));

    expect(existsSync(join(destinoDir, 'A8-mulheres-v1.mp4'))).toBe(true);
    // E continua sem falar no chat: 48 mensagens num fluxo de 12 é o que o
    // `chat_id: null` existe para evitar.
    expect(chamadas).toHaveLength(0);
  });

  it('destino ausente não vira erro nem mensagem', async () => {
    const origem = join(dir, 'solto.mp4');
    writeFileSync(origem, 'video');
    const { transporte, chamadas } = fakeTransporte();
    const notificar = criarNotificador(transporte, { temArtefato: () => true, entregaDe: () => ({}) });
    await expect(notificar(job({ chat_id: null, status: 'done', resultado: origem })))
      .resolves.toBeUndefined();
    expect(chamadas).toHaveLength(0);
  });
});
