import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

function novaFila(): FilaSqlite {
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  return new FilaSqlite(db, () => t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  fila = novaFila();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('enfileirar', () => {
  it('grava com defaults e devolve o job criado', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'http.get', input: '{}' });
    expect(job.id).toBe(1);
    expect(job.status).toBe('queued');
    expect(job.prioridade).toBe(0);
    expect(job.max_tentativas).toBe(1);
    expect(job.tentativas).toBe(0);
    expect(job.disponivel_em).toBe(1_000);
    expect(job.criado_em).toBe(1_000);
    expect(job.lease_ate).toBeNull();
  });

  it('grava campos opcionais, inclusive o perfil de execução', () => {
    const job = fila.enfileirar({
      fila: 'render', kind: 'agent', tarefa: 'explicativo', input: 'RAG',
      prioridade: 5, max_tentativas: 3, disponivel_em: 1_500,
      idem_key: 'P#16/mulheres/render', flow_ref: 'P#16/mulheres/render', chat_id: 42,
      perfil: { motor: 'claude', modelo: 'sonnet', esforco: 'low' },
    });
    expect(job.prioridade).toBe(5);
    expect(job.max_tentativas).toBe(3);
    expect(job.disponivel_em).toBe(1_500);
    expect(job.idem_key).toBe('P#16/mulheres/render');
    expect(job.flow_ref).toBe('P#16/mulheres/render');
    expect(job.chat_id).toBe(42);
    expect(job.motor).toBe('claude');
    expect(job.modelo).toBe('sonnet');
    expect(job.esforco).toBe('low');
  });
});

describe('obter e listar', () => {
  it('obter devolve undefined para id inexistente', () => {
    expect(fila.obter(999)).toBeUndefined();
  });

  it('listar filtra por fila e por status', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'b', input: '' });
    expect(fila.listar().length).toBe(2);
    expect(fila.listar({ fila: 'io' }).map((j) => j.tarefa)).toEqual(['a']);
    expect(fila.listar({ status: 'done' })).toEqual([]);
  });
});

describe('listar com teto e janela (o histórico não é purgado)', () => {
  it('sem limite, devolve tudo em ordem crescente', () => {
    for (let i = 0; i < 5; i += 1) fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 't', input: '{}' });
    expect(fila.listar().map((j) => j.id)).toEqual([1, 2, 3, 4, 5]);
  });

  // O teto pega os MAIS RECENTES: um painel que mostrasse os cinco primeiros
  // jobs da vida do bot seria inútil.
  it('com limite, devolve os últimos — ainda em ordem crescente', () => {
    for (let i = 0; i < 5; i += 1) fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 't', input: '{}' });
    expect(fila.listar({ limite: 2 }).map((j) => j.id)).toEqual([4, 5]);
  });

  it('desde corta pelo tempo de criação', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'velho', input: '{}' });
    t += 1_000;
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'novo', input: '{}' });
    const recentes = fila.listar({ desde: t });
    expect(recentes.map((j) => j.tarefa)).toEqual(['novo']);
  });
});
