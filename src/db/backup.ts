// Backup pela API do SQLite. NUNCA `cp` do arquivo principal: com WAL, as
// escritas recentes moram no -wal e a cópia crua sai inconsistente.
import type Database from 'better-sqlite3';

export async function backupPara(db: Database.Database, destino: string): Promise<void> {
  await db.backup(destino);
}
