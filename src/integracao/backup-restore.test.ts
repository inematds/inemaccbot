// Com WAL, copiar só o arquivo principal produz backup INCOMPLETO (as escritas
// recentes vivem no -wal). Este teste prova que o backup pela API do SQLite
// carrega os dados e que a fila funciona no arquivo restaurado.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { backupPara } from '../db/backup.js';
import { FilaSqlite } from '../fila/store.js';

let dir: string;
const t = 1_000;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('backup carrega os jobs e o arquivo restaurado é operacional', async () => {
  const origem = join(dir, 'fila.db');
  const db = abrirDb(origem);
  aplicarMigrations(db, () => t, MIGRATIONS);
  const fila = new FilaSqlite(db, () => t);
  fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'explicativo', input: 'RAG' });

  const destino = join(dir, 'backup.db');
  await backupPara(db, destino);
  db.close();

  expect(existsSync(destino)).toBe(true);

  const restaurado = abrirDb(destino);
  const fila2 = new FilaSqlite(restaurado, () => t);
  expect(fila2.listar()).toHaveLength(1);
  expect(fila2.pegar('render', 60, 'w1')?.tarefa).toBe('explicativo');   // fila funciona no restaurado
  restaurado.close();
});
