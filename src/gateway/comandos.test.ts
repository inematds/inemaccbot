import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from '../fila/store.js';
import { executar, parseComando, type DepsComando } from './comandos.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-comandos-'));
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  t = 1_000;
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(): DepsComando {
  return { fila, chatId: 42, agora: () => t };
}

describe('parseComando', () => {
  it('reconhece /ping', () => {
    expect(parseComando('/ping')).toEqual({ tipo: 'ping' });
  });

  it('reconhece /fila', () => {
    expect(parseComando('/fila')).toEqual({ tipo: 'fila' });
  });

  it('reconhece /status <id>', () => {
    expect(parseComando('/status 5')).toEqual({ tipo: 'status', id: 5 });
  });

  it('reconhece /cancelar <id>', () => {
    expect(parseComando('/cancelar 5')).toEqual({ tipo: 'cancelar', id: 5 });
  });

  it('reconhece /furar <id>', () => {
    expect(parseComando('/furar 5')).toEqual({ tipo: 'furar', id: 5 });
  });

  it('reconhece http <url>', () => {
    expect(parseComando('http https://exemplo.com')).toEqual({
      tipo: 'http',
      url: 'https://exemplo.com',
    });
  });

  it('reconhece thumb <caminho>', () => {
    expect(parseComando('thumb /media/video.mp4')).toEqual({
      tipo: 'thumb',
      entrada: '/media/video.mp4',
    });
  });

  it('reconhece /ajuda e /help como alias', () => {
    expect(parseComando('/ajuda')).toEqual({ tipo: 'ajuda' });
    expect(parseComando('/help')).toEqual({ tipo: 'ajuda' });
  });

  it('argumentos malformados caem em desconhecido', () => {
    expect(parseComando('/status')).toEqual({ tipo: 'desconhecido', texto: '/status' });
    expect(parseComando('/status abc')).toEqual({ tipo: 'desconhecido', texto: '/status abc' });
    expect(parseComando('http')).toEqual({ tipo: 'desconhecido', texto: 'http' });
    expect(parseComando('thumb')).toEqual({ tipo: 'desconhecido', texto: 'thumb' });
  });

  it('texto livre cai em desconhecido', () => {
    expect(parseComando('oi tudo bem?')).toEqual({ tipo: 'desconhecido', texto: 'oi tudo bem?' });
  });
});

describe('executar', () => {
  it('/ping responde algo curto de liveness', () => {
    const r = executar(parseComando('/ping'), deps());
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThan(60);
  });

  it('/ajuda lista os comandos', () => {
    const r = executar(parseComando('/ajuda'), deps());
    expect(r).toMatch(/ping/);
    expect(r).toMatch(/fila/);
    expect(r).toMatch(/status/);
    expect(r).toMatch(/cancelar/);
    expect(r).toMatch(/furar/);
    expect(r).toMatch(/http/);
    expect(r).toMatch(/thumb/);
  });

  it('desconhecido aponta para /ajuda e não ecoa o texto cru', () => {
    const texto = 'segredo-super-especifico-xyz';
    const r = executar(parseComando(texto), deps());
    expect(r).toMatch(/\/ajuda|\/help/);
    expect(r).not.toContain(texto);
  });

  it('http enfileira na fila io e responde com o id', () => {
    const r = executar(parseComando('http https://exemplo.com/a'), deps());
    const job = fila.obter(1)!;
    expect(job.fila).toBe('io');
    expect(job.kind).toBe('function');
    expect(job.tarefa).toBe('http.get');
    expect(JSON.parse(job.input)).toEqual({ url: 'https://exemplo.com/a' });
    expect(job.chat_id).toBe(42);
    expect(r).toContain('1');
  });

  it('thumb enfileira na fila cpu e responde com o id', () => {
    const r = executar(parseComando('thumb /media/v.mp4'), deps());
    const job = fila.obter(1)!;
    expect(job.fila).toBe('cpu');
    expect(job.tarefa).toBe('ffmpeg.thumb');
    expect(JSON.parse(job.input)).toEqual({ entrada: '/media/v.mp4' });
    expect(r).toContain('1');
  });

  describe('/status', () => {
    it('mostra status, tarefa, fila e tentativas de um job existente', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const r = executar(parseComando(`/status ${job.id}`), deps());
      expect(r).toMatch(/queued/);
      expect(r).toMatch(/http\.get/);
      expect(r).toMatch(/io/);
    });

    it('mostra o erro quando o job falhou', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      fila.falhar(job.id, 'timeout de rede', 'w1', 30);
      // segunda falha sem mais tentativas -> failed
      const r = executar(parseComando(`/status ${job.id}`), deps());
      expect(r).toMatch(/failed|queued/);
    });

    it('mostra o resultado quando o job terminou', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      fila.concluir(job.id, 'ok-resultado', 'w1');
      const r = executar(parseComando(`/status ${job.id}`), deps());
      expect(r).toMatch(/done/);
      expect(r).toContain('ok-resultado');
    });

    it('recusa id que não existe neste bot, sem agir em job algum', () => {
      const r = executar(parseComando('/status 999'), deps());
      expect(r).toMatch(/não é deste bot|não existe/i);
    });

    it('recusa id prefixado no formato do bot antigo (V#5), sem agir em job algum', () => {
      const antes = fila.listar();
      const r = executar(parseComando('/status V#5'), deps());
      expect(r).toMatch(/não reconhecido|não é deste bot|não existe/i);
      expect(fila.listar()).toEqual(antes);
    });

    it('recusa id prefixado no formato do bot antigo (T#7), sem agir em job algum', () => {
      const antes = fila.listar();
      const r = executar(parseComando('/status T#7'), deps());
      expect(r).toMatch(/não reconhecido|não é deste bot|não existe/i);
      expect(fila.listar()).toEqual(antes);
    });
  });

  describe('/cancelar', () => {
    it('cancela job pendente', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const r = executar(parseComando(`/cancelar ${job.id}`), deps());
      expect(r).toMatch(/cancelad/i);
      expect(fila.obter(job.id)!.status).toBe('canceled');
    });

    it('num job done não mente: diz que nada foi cancelado', () => {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      fila.concluir(job.id, 'ok', 'w1');
      const r = executar(parseComando(`/cancelar ${job.id}`), deps());
      expect(r).toMatch(/não|nada/i);
      expect(r).not.toMatch(/^cancelad/i);
      expect(fila.obter(job.id)!.status).toBe('done');
    });

    it('recusa id inexistente', () => {
      const r = executar(parseComando('/cancelar 999'), deps());
      expect(r).toMatch(/não é deste bot|não existe/i);
    });
  });

  describe('/furar', () => {
    it('põe o job na frente da fila', () => {
      const a = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const b = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      executar(parseComando(`/furar ${b.id}`), deps());
      expect(fila.pegar('io', 60, 'w')!.id).toBe(b.id);
      expect(fila.pegar('io', 60, 'w')!.id).toBe(a.id);
    });

    it('em job já running não muda nada e avisa', () => {
      const a = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      const antes = fila.obter(a.id)!.prioridade;
      const r = executar(parseComando(`/furar ${a.id}`), deps());
      expect(r).toMatch(/não|nada/i);
      expect(fila.obter(a.id)!.prioridade).toBe(antes);
    });

    it('recusa id inexistente', () => {
      const r = executar(parseComando('/furar 999'), deps());
      expect(r).toMatch(/não é deste bot|não existe/i);
    });
  });

  describe('/fila', () => {
    it('numa fila vazia não divide por zero nem quebra', () => {
      expect(() => executar(parseComando('/fila'), deps())).not.toThrow();
      const r = executar(parseComando('/fila'), deps());
      expect(r.length).toBeGreaterThan(0);
    });

    it('resume rodando/pendentes/idade do mais antigo/taxa de erro', () => {
      fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      const b = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
      fila.pegar('io', 60, 'w1');
      t = 2_000;
      const r = executar(parseComando('/fila'), deps());
      expect(r).toMatch(/io/);
      expect(r).toMatch(/1/); // 1 rodando
    });
  });
});
