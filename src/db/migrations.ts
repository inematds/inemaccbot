// Migrations versionadas com checksum. O boot RECUSA subir se o SQL de uma
// migration já aplicada mudou — divergência silenciosa de schema é a pior
// classe de bug num sistema que guarda estado de fluxo.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  nome: string;
  sql: string;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Migrations do sistema, em ordem crescente de `version`. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    nome: 'jobs',
    sql: `
      CREATE TABLE jobs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        fila           TEXT    NOT NULL,
        kind           TEXT    NOT NULL,
        tarefa         TEXT    NOT NULL,
        input          TEXT    NOT NULL,
        prioridade     INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'queued',
        tentativas     INTEGER NOT NULL DEFAULT 0,
        max_tentativas INTEGER NOT NULL DEFAULT 1,
        lease_ate      INTEGER,
        disponivel_em  INTEGER NOT NULL DEFAULT 0,
        idem_key       TEXT,
        flow_ref       TEXT,
        chat_id        INTEGER,
        motor          TEXT,
        modelo         TEXT,
        esforco        TEXT,
        resultado      TEXT,
        erro           TEXT,
        criado_em      INTEGER NOT NULL,
        iniciado_em    INTEGER,
        terminado_em   INTEGER
      );
      CREATE INDEX idx_jobs_claim
        ON jobs (fila, status, disponivel_em, prioridade DESC, id);
      CREATE INDEX idx_jobs_flow_ref ON jobs (flow_ref);
      CREATE INDEX idx_jobs_idem_key ON jobs (idem_key);
    `,
  },
];

const SCHEMA_CONTROLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    nome       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

export function aplicarMigrations(
  db: Database.Database,
  agora: () => number,
  migrations: Migration[] = MIGRATIONS,
): number {
  db.exec(SCHEMA_CONTROLE);

  const aplicadas = new Map<number, string>(
    (db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
      version: number; checksum: string;
    }[]).map((l) => [l.version, l.checksum]),
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // First pass: validate all already-applied migrations (no side effects)
  for (const m of sorted) {
    const soma = checksum(m.sql);
    const anterior = aplicadas.get(m.version);
    if (anterior !== undefined && anterior !== soma) {
      throw new Error(
        `migration ${m.version} (${m.nome}): checksum divergente — o SQL mudou depois de aplicado`,
      );
    }
  }

  // Second pass: apply pending migrations
  let n = 0;
  for (const m of sorted) {
    const soma = checksum(m.sql);
    const anterior = aplicadas.get(m.version);
    if (anterior !== undefined) {
      continue; // Already applied and validated
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, nome, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.nome, soma, agora());
    })();
    n += 1;
  }
  return n;
}
