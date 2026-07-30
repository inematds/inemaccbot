import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

let dir: string;
let db: Database.Database;
let fila: FilaSqlite;
let t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('renovar', () => {
  it('empurra o lease_ate de um job em execução', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    t = 1_050;
    expect(fila.renovar(job.id, 60)).toBe(true);
    expect(fila.obter(job.id)!.lease_ate).toBe(1_110);
  });

  it('não renova job que não está running', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    expect(fila.renovar(job.id, 60)).toBe(false);
  });
});

describe('recuperarLeasesVencidos', () => {
  it('devolve à fila o job cujo lease venceu, preservando tentativas', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 3 });
    const job = fila.pegar('render', 60)!;
    expect(job.tentativas).toBe(1);

    t = 1_061;
    expect(fila.recuperarLeasesVencidos()).toBe(1);

    const depois = fila.obter(job.id)!;
    expect(depois.status).toBe('queued');
    expect(depois.tentativas).toBe(1);
    expect(depois.lease_ate).toBeNull();
    expect(fila.pegar('render', 60)!.tentativas).toBe(2);
  });

  it('não mexe em job com lease vivo', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.pegar('io', 60);
    t = 1_030;
    expect(fila.recuperarLeasesVencidos()).toBe(0);
  });

  it('não mexe em job terminal', () => {
    const statuses: Array<'done' | 'failed' | 'canceled'> = ['done', 'failed', 'canceled'];
    for (const status of statuses) {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
      fila.pegar('io', 60);
      // Deliberately force terminal status while leaving lease_ate populated and expired
      db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, job.id);
      t = 5_000;
      const recovered = fila.recuperarLeasesVencidos();
      expect(recovered).toBe(0);
      expect(fila.obter(job.id)!.status).toBe(status);
    }
  });

  it('recuperar duas vezes não recupera de novo (lease já nulo)', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.pegar('io', 60);
    t = 1_061;
    expect(fila.recuperarLeasesVencidos()).toBe(1);
    expect(fila.recuperarLeasesVencidos()).toBe(0);
  });
});
