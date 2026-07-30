// Store da fila sobre better-sqlite3. Nenhum conhecimento de Telegram, fluxo ou
// skill: recebe NovoJob, devolve Job. O relógio vem por injeção (`agora`).
import type Database from 'better-sqlite3';

import type { Agora, Fila, Job, NovoJob, StatusJob } from './types.js';

export class FilaSqlite {
  constructor(
    private readonly db: Database.Database,
    private readonly agora: Agora,
  ) {}

  enfileirar(n: NovoJob): Job {
    const agora = this.agora();
    const info = this.db
      .prepare(
        `INSERT INTO jobs
           (fila, kind, tarefa, input, prioridade, max_tentativas, disponivel_em,
            idem_key, flow_ref, chat_id, motor, modelo, esforco, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n.fila,
        n.kind,
        n.tarefa,
        n.input,
        n.prioridade ?? 0,
        n.max_tentativas ?? 1,
        n.disponivel_em ?? agora,
        n.idem_key ?? null,
        n.flow_ref ?? null,
        n.chat_id ?? null,
        n.perfil?.motor ?? null,
        n.perfil?.modelo ?? null,
        n.perfil?.esforco ?? null,
        agora,
      );
    const job = this.obter(Number(info.lastInsertRowid));
    if (!job) throw new Error('enfileirar: job não encontrado após INSERT');
    return job;
  }

  obter(id: number): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
  }

  listar(filtro: { fila?: Fila; status?: StatusJob } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filtro.fila) { where.push('fila = ?'); args.push(filtro.fila); }
    if (filtro.status) { where.push('status = ?'); args.push(filtro.status); }
    const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id`;
    return this.db.prepare(sql).all(...args) as Job[];
  }
}
