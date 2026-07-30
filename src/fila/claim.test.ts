import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let caminho: string;
let t = 1_000;

function conectar(): FilaSqlite {
  const db = abrirDb(caminho);
  aplicarMigrations(db, () => t, MIGRATIONS);
  return new FilaSqlite(db, () => t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  caminho = join(dir, 'fila.db');
  t = 1_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pegar', () => {
  it('marca running, incrementa tentativas e define lease', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60);
    expect(job?.status).toBe('running');
    expect(job?.tentativas).toBe(1);
    expect(job?.lease_ate).toBe(1_060);
    expect(job?.iniciado_em).toBe(1_000);
  });

  it('respeita a fila pedida', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '' });
    expect(fila.pegar('io', 60)).toBeUndefined();
    expect(fila.pegar('render', 60)?.tarefa).toBe('a');
  });

  it('ordena por prioridade DESC e depois por id ASC', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'primeiro', input: '' });
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'furou', input: '', prioridade: 10 });
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'segundo', input: '' });
    expect(fila.pegar('io', 60)?.tarefa).toBe('furou');
    expect(fila.pegar('io', 60)?.tarefa).toBe('primeiro');
    expect(fila.pegar('io', 60)?.tarefa).toBe('segundo');
  });

  it('não pega job agendado para o futuro', () => {
    const fila = conectar();
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'depois', input: '', disponivel_em: 2_000 });
    expect(fila.pegar('io', 60)).toBeUndefined();
    t = 2_000;
    expect(fila.pegar('io', 60)?.tarefa).toBe('depois');
  });

  it('devolve undefined com a fila vazia', () => {
    expect(conectar().pegar('io', 60)).toBeUndefined();
  });

  it('duas conexões concorrentes: só uma pega o mesmo job', () => {
    const a = conectar();
    const b = conectar();
    a.enfileirar({ fila: 'io', kind: 'function', tarefa: 'unico', input: '' });
    const pegos = [a.pegar('io', 60), b.pegar('io', 60)].filter(Boolean);
    expect(pegos).toHaveLength(1);
  });
});
