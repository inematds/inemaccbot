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

  /**
   * Claim ATÔMICO: um único UPDATE ... WHERE id = (SELECT ...) RETURNING *.
   * Fazer SELECT e depois UPDATE (como o mkivideos faz hoje) permite que dois
   * workers peguem o mesmo job. Ordem: prioridade DESC, id ASC (FIFO dentro da
   * mesma prioridade). `disponivel_em` cobre poll, backoff e agendamento.
   */
  pegar(fila: Fila, leaseSegundos: number): Job | undefined {
    const agora = this.agora();
    return this.db
      .prepare(
        `UPDATE jobs
            SET status = 'running',
                tentativas = tentativas + 1,
                lease_ate = ?,
                iniciado_em = COALESCE(iniciado_em, ?)
          WHERE id = (SELECT id FROM jobs
                       WHERE fila = ? AND status = 'queued' AND disponivel_em <= ?
                       ORDER BY prioridade DESC, id ASC
                       LIMIT 1)
        RETURNING *`,
      )
      .get(agora + leaseSegundos, agora, fila, agora) as Job | undefined;
  }

  /**
   * Heartbeat: empurra o lease enquanto o trabalho está vivo. Obrigatório em job
   * longo (render de ~15 min) e durante o drain — soltar lease com o processo
   * vivo é exatamente o que permitiria dupla execução (spec §1.3).
   */
  renovar(id: number, leaseSegundos: number): boolean {
    const r = this.db
      .prepare(`UPDATE jobs SET lease_ate = ? WHERE id = ? AND status = 'running'`)
      .run(this.agora() + leaseSegundos, id);
    return r.changes === 1;
  }

  /**
   * Devolve à fila todo job `running` com lease vencido (worker morto, kill -9,
   * queda de energia). `tentativas` NÃO é zerado: o job já consumiu uma.
   */
  recuperarLeasesVencidos(): number {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_ate = NULL
          WHERE status = 'running' AND lease_ate IS NOT NULL AND lease_ate <= ?`,
      )
      .run(this.agora());
    return r.changes;
  }

  /**
   * Fecha o job como done. O `AND status = 'running'` é a proteção contra a
   * corrida "cancelei, mas o worker terminou depois": job cancelado NUNCA vira
   * done (spec §3.7).
   */
  concluir(id: number, resultado: string): boolean {
    const agora = this.agora();
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'done', resultado = ?, erro = NULL,
                         lease_ate = NULL, terminado_em = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(resultado, agora, id);
    return r.changes === 1;
  }

  /**
   * Falha o job. Se ainda há tentativa, volta pra fila com backoff exponencial
   * (base * 2^(tentativas-1)); senão vira `failed`. Nunca reabre job cancelado.
   */
  falhar(id: number, erro: string, backoffBase = 30): 'requeued' | 'failed' {
    const agora = this.agora();
    return this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM jobs WHERE id = ? AND status = 'running'`)
        .get(id) as Job | undefined;
      if (!job) return 'failed';

      if (job.tentativas < job.max_tentativas) {
        const espera = backoffBase * 2 ** (job.tentativas - 1);
        this.db
          .prepare(
            `UPDATE jobs SET status = 'queued', erro = ?, lease_ate = NULL, disponivel_em = ?
              WHERE id = ?`,
          )
          .run(erro, agora + espera, id);
        return 'requeued';
      }
      this.db
        .prepare(
          `UPDATE jobs SET status = 'failed', erro = ?, lease_ate = NULL, terminado_em = ?
            WHERE id = ?`,
        )
        .run(erro, agora, id);
      return 'failed';
    })();
  }

  /** Cancela job pendente ou em execução. Job terminal não é cancelável. */
  cancelar(id: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'canceled', lease_ate = NULL, terminado_em = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(this.agora(), id);
    return r.changes === 1;
  }

  /**
   * Devolve o job à fila para nova checagem em `emSegundos` SEM gastar tentativa
   * — é o mecanismo de poll das fases com `espera` (spec §3.2).
   */
  reagendar(id: number, emSegundos: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_ate = NULL, disponivel_em = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(this.agora() + emSegundos, id);
    return r.changes === 1;
  }

  /** Job já concluído com essa chave de idempotência — a tarefa pode adotar o resultado. */
  jaConcluido(idemKey: string): Job | undefined {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE idem_key = ? AND status = 'done' ORDER BY id DESC LIMIT 1`,
      )
      .get(idemKey) as Job | undefined;
  }

  /**
   * Enfileira só se não houver job com a mesma `idem_key` já concluído ou em voo.
   * `failed`/`canceled` NÃO bloqueiam: retentar é legítimo (é o que /refazer faz).
   */
  enfileirarSeNovo(n: NovoJob): { job: Job; novo: boolean } {
    if (!n.idem_key) return { job: this.enfileirar(n), novo: true };
    return this.db.transaction(() => {
      const existente = this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE idem_key = ? AND status IN ('queued', 'running', 'done')
            ORDER BY id DESC LIMIT 1`,
        )
        .get(n.idem_key) as Job | undefined;
      if (existente) return { job: existente, novo: false };
      return { job: this.enfileirar(n), novo: true };
    })();
  }
}
