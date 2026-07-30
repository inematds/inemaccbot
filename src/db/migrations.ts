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
  {
    version: 2,
    nome: 'lease_owner',
    sql: `
      ALTER TABLE jobs ADD COLUMN lease_owner TEXT;
    `,
  },
  {
    version: 3,
    nome: 'notificado_em',
    // Quando a notificação de término foi ENTREGUE. NULL num job terminal com
    // `chat_id` significa "o dono ainda não sabe" — e é o que a varredura de
    // reentrega procura.
    //
    // Isto fecha um buraco que o v1 não tinha: lá, se a notificação falhasse, o
    // job continuava pendente e a próxima passagem do watcher reentregava
    // exatamente uma vez (`watcher.test.ts` tinha caso dedicado). No v2 o
    // `aoTerminar` que falhava só ia para o log, e a mensagem sumia para
    // sempre — silêncio, que a §8 proíbe.
    // O backfill não é detalhe: sem ele, TODO job terminal que já existe no
    // banco entra na varredura de reentrega no primeiro tick depois do deploy.
    // No banco de produção isso é imediato — os jobs de verificação foram
    // enfileirados com `chat_id: 0`, que não é NULL e portanto passa no filtro,
    // e cujo envio falha SEMPRE ("chat not found"). Seriam duas chamadas
    // condenadas à API do Telegram a cada 20 segundos, para sempre. E num chat
    // de verdade seria pior: uma enxurrada de "Job N concluído" de jobs velhos.
    //
    // A varredura existe para o que terminar DAQUI PARA FRENTE.
    sql: `
      ALTER TABLE jobs ADD COLUMN notificado_em INTEGER;
      CREATE INDEX idx_jobs_pendente_notificacao
        ON jobs (status, notificado_em, chat_id);
      UPDATE jobs SET notificado_em = criado_em
        WHERE status IN ('done', 'failed', 'canceled');
    `,
  },
  {
    version: 4,
    nome: 'fluxos',
    // Estado de fluxo no MESMO banco da fila (§3.3). É isso que torna "marcar a
    // fase como feita + enfileirar a próxima" uma transação só — e elimina por
    // construção o dispatch duplicado que o v1 tinha com o watcher.
    //
    // `fluxo_fases.alvo` usa '' (string vazia) como sentinela para fase de
    // escopo `fluxo`: NULL não funciona em chave primária, e a revisão 1 da
    // spec já registrou esse defeito de modelagem.
    sql: `
      CREATE TABLE fluxos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo           TEXT    NOT NULL,
        prefixo        TEXT    NOT NULL,
        slug           TEXT    NOT NULL,
        assunto        TEXT    NOT NULL,
        versao         INTEGER NOT NULL DEFAULT 1,
        chat_id        INTEGER,
        status         TEXT    NOT NULL DEFAULT 'rodando',
        definicao_json TEXT    NOT NULL,
        definicao_hash TEXT    NOT NULL,
        versao_def     INTEGER NOT NULL,
        criado_em      INTEGER NOT NULL,
        terminado_em   INTEGER
      );
      CREATE INDEX idx_fluxos_status ON fluxos (status);

      CREATE TABLE fluxo_fases (
        fluxo_id   INTEGER NOT NULL REFERENCES fluxos(id),
        fase       TEXT    NOT NULL,
        alvo       TEXT    NOT NULL,
        escopo     TEXT    NOT NULL,
        ordem      INTEGER NOT NULL,
        estado     TEXT    NOT NULL DEFAULT 'pendente',
        job_id     INTEGER,
        tentativas INTEGER NOT NULL DEFAULT 0,
        dados      TEXT,
        erro       TEXT,
        criado_em  INTEGER NOT NULL,
        PRIMARY KEY (fluxo_id, fase, alvo)
      );
      CREATE INDEX idx_fases_estado ON fluxo_fases (estado, fluxo_id);
      CREATE INDEX idx_fases_job ON fluxo_fases (job_id);

      -- Histórico: \`fluxo_fases\` guarda o estado ATUAL; cada tentativa está nas
      -- linhas de \`jobs\` com aquele flow_ref, que nunca são deletadas (§3.5).
      -- A view junta os dois sem criar uma segunda escrita do mesmo fato.
      CREATE VIEW fluxo_historico AS
        SELECT f.fluxo_id, f.fase, f.alvo, f.estado,
               j.id AS job_id, j.status AS job_status, j.tentativas,
               j.iniciado_em, j.terminado_em, j.erro
          FROM fluxo_fases f
          LEFT JOIN jobs j ON j.flow_ref = (
            SELECT fl.prefixo || '#' || fl.id || '/' || f.alvo || '/' || f.fase
              FROM fluxos fl WHERE fl.id = f.fluxo_id
          );
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
