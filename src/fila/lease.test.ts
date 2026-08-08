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
    const job = fila.pegar('io', 60, 'w1')!;
    t = 1_050;
    expect(fila.renovar(job.id, 60, 'w1')).toBe(true);
    expect(fila.obter(job.id)!.lease_ate).toBe(1_110);
  });

  it('não renova job que não está running', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    expect(fila.renovar(job.id, 60, 'w1')).toBe(false);
  });

  // É este `false` que faz o `/cancelar` MATAR o processo filho: `bater()` lê
  // o false e dispara `ctrl.abort()`. Aqui o `lease_owner` é preservado de
  // propósito — assim o único predicado que pode recusar é `status='running'`,
  // e um mutante que o remova fica vermelho neste teste (o `cancelar()` real
  // também zera o dono, o que mascararia a regressão no teste de ponta a ponta).
  it('não renova job cancelado mesmo com o lease_owner ainda casando', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60, 'w1')!;
    db.prepare(`UPDATE jobs SET status = 'canceled' WHERE id = ?`).run(job.id);
    expect(fila.obter(job.id)!.lease_owner).toBe('w1');
    expect(fila.renovar(job.id, 60, 'w1')).toBe(false);
  });
});

describe('recuperarLeasesVencidos', () => {
  it('devolve à fila o job cujo lease venceu, preservando tentativas', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 3 });
    const job = fila.pegar('render', 60, 'w1')!;
    expect(job.tentativas).toBe(1);

    t = 1_061;
    expect(fila.recuperarLeasesVencidos()).toEqual({ requeued: 1, falhados: [] });

    const depois = fila.obter(job.id)!;
    expect(depois.status).toBe('queued');
    expect(depois.tentativas).toBe(1);
    expect(depois.lease_ate).toBeNull();
    expect(depois.lease_owner).toBeNull();
    expect(fila.pegar('render', 60, 'w2')!.tentativas).toBe(2);
  });

  // Sem o teto aqui, um job que MATA o processo (OOM) roda pra sempre: `falhar`
  // — o único lugar que checava max_tentativas — é exatamente o que o crash pula.
  it('não devolve à fila job que já gastou todas as tentativas — falha', () => {
    const job = fila.enfileirar({
      fila: 'render', kind: 'agent', tarefa: 'mata-o-node', input: '', max_tentativas: 1,
    });
    fila.pegar('render', 60, 'w1');

    t = 1_061;
    const rec = fila.recuperarLeasesVencidos();
    expect(rec.requeued).toBe(0);
    expect(rec.falhados.map((j) => j.id)).toEqual([job.id]);
    expect(rec.falhados[0]!.status).toBe('failed');

    const depois = fila.obter(job.id)!;
    expect(depois.status).toBe('failed');
    expect(depois.erro).toBe('lease vencido sem ack (worker morreu)');
    expect(depois.terminado_em).toBe(1_061);
    expect(depois.lease_ate).toBeNull();
    expect(depois.lease_owner).toBeNull();
    expect(fila.pegar('render', 60, 'w2')).toBeUndefined();
  });

  it('não mexe em job com lease vivo', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    fila.pegar('io', 60, 'w1');
    t = 1_030;
    expect(fila.recuperarLeasesVencidos()).toEqual({ requeued: 0, falhados: [] });
  });

  it('não mexe em job terminal', () => {
    const statuses: Array<'done' | 'failed' | 'canceled'> = ['done', 'failed', 'canceled'];
    for (const status of statuses) {
      const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
      fila.pegar('io', 60, 'w1');
      // Deliberately force terminal status while leaving lease_ate populated and expired
      db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, job.id);
      t = 5_000;
      const recovered = fila.recuperarLeasesVencidos();
      expect(recovered).toEqual({ requeued: 0, falhados: [] });
      expect(fila.obter(job.id)!.status).toBe(status);
    }
  });

  it('recuperar duas vezes não recupera de novo (lease já nulo)', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '', max_tentativas: 3 });
    fila.pegar('io', 60, 'w1');
    t = 1_061;
    expect(fila.recuperarLeasesVencidos()).toEqual({ requeued: 1, falhados: [] });
    expect(fila.recuperarLeasesVencidos()).toEqual({ requeued: 0, falhados: [] });
  });
});
