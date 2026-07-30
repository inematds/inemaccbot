import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from './abrir.js';
import { aplicarMigrations, type Migration } from './migrations.js';

const agora = () => 1_700_000_000;

describe('migrations', () => {
  let dir: string;
  let caminho: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
    caminho = join(dir, 'teste.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const M1: Migration = { version: 1, nome: 'cria_t', sql: 'CREATE TABLE t (a INTEGER);' };

  it('abre em WAL com busy_timeout', () => {
    const db = abrirDb(caminho);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('aplica uma migration e registra versão + checksum', () => {
    const db = abrirDb(caminho);
    expect(aplicarMigrations(db, agora, [M1])).toBe(1);
    const linha = db.prepare('SELECT version, checksum FROM schema_migrations').get() as {
      version: number; checksum: string;
    };
    expect(linha.version).toBe(1);
    expect(linha.checksum).toHaveLength(64);
    db.close();
  });

  it('é idempotente — segunda chamada não aplica nada', () => {
    const db = abrirDb(caminho);
    aplicarMigrations(db, agora, [M1]);
    expect(aplicarMigrations(db, agora, [M1])).toBe(0);
    db.close();
  });

  it('recusa subir se o checksum de uma migration aplicada divergir', () => {
    const db = abrirDb(caminho);
    aplicarMigrations(db, agora, [M1]);
    const adulterada: Migration = { ...M1, sql: 'CREATE TABLE t (a TEXT);' };
    expect(() => aplicarMigrations(db, agora, [adulterada])).toThrow(/checksum/i);
    db.close();
  });
});
