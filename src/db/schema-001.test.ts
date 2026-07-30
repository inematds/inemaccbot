import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { abrirDb } from './abrir.js';
import { MIGRATIONS, aplicarMigrations } from './migrations.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('migration 001 cria jobs com todas as colunas do spec', () => {
  const db = abrirDb(join(dir, 'x.db'));
  aplicarMigrations(db, () => 1, MIGRATIONS);

  const colunas = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[])
    .map((c) => c.name);

  for (const esperada of [
    'id', 'fila', 'kind', 'tarefa', 'input', 'prioridade', 'status',
    'tentativas', 'max_tentativas', 'lease_ate', 'disponivel_em',
    'idem_key', 'flow_ref', 'chat_id', 'motor', 'modelo', 'esforco',
    'resultado', 'erro', 'criado_em', 'iniciado_em', 'terminado_em',
  ]) {
    expect(colunas, `falta coluna ${esperada}`).toContain(esperada);
  }

  const indices = (db.prepare('PRAGMA index_list(jobs)').all() as { name: string }[])
    .map((i) => i.name);
  expect(indices).toContain('idx_jobs_claim');
  expect(indices).toContain('idx_jobs_flow_ref');
  db.close();
});
