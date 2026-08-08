// Abre o SQLite operacional. WAL e busy_timeout são obrigatórios: a fila tem
// concorrência > 1 (fila `io`), e sem WAL um leitor bloquearia o escritor.
import Database from 'better-sqlite3';

export function abrirDb(caminho: string): Database.Database {
  const db = new Database(caminho);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
