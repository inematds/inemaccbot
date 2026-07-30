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

  it('divergent checksum found during validation does NOT apply any pending migrations', () => {
    const db = abrirDb(caminho);
    const M2: Migration = { version: 2, nome: 'cria_u', sql: 'CREATE TABLE u (b INTEGER);' };
    // First, apply M2 so it exists in schema_migrations
    aplicarMigrations(db, agora, [M2]);
    // Now try to apply [M1 pending, M2 tampered]
    const M2tampered: Migration = { ...M2, sql: 'CREATE TABLE u (b TEXT);' };
    expect(() => aplicarMigrations(db, agora, [M1, M2tampered])).toThrow(/checksum/i);
    // Verify M1 was NOT applied (table t does not exist)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").all();
    expect(tables).toHaveLength(0);
    // Verify no schema_migrations row for M1
    const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('malformed SQL does not apply and leaves schema_migrations clean', () => {
    const db = abrirDb(caminho);
    const malformed: Migration = { version: 1, nome: 'bad', sql: 'CREATE TABLE ( ;' };
    expect(() => aplicarMigrations(db, agora, [malformed])).toThrow();
    // Verify no schema_migrations row for version 1
    const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('transaction rollback on partial SQL failure leaves no partial state', () => {
    const db = abrirDb(caminho);
    const partial: Migration = {
      version: 1,
      nome: 'partial',
      sql: 'CREATE TABLE bom (a INTEGER); CREATE TABLE ( ;',
    };
    expect(() => aplicarMigrations(db, agora, [partial])).toThrow();
    // Verify the first table (bom) was NOT created (rollback worked)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bom'").all();
    expect(tables).toHaveLength(0);
    // Verify no schema_migrations row for version 1
    const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all();
    expect(rows).toHaveLength(0);
    db.close();
  });
});
