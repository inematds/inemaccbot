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

  /**
   * `limite` e `desde` existem porque `jobs` NUNCA é purgado — é o histórico
   * (§3.5). Sem teto, cada `/fila` e cada `/status` varrem a tabela inteira, e
   * o custo cresce para sempre com o uso. O teto pega os mais RECENTES (ordem
   * decrescente na consulta, revertida na volta) — o histórico antigo continua
   * lá para quem pedir um job pelo id.
   */
  listar(filtro: { fila?: Fila; status?: StatusJob; desde?: number; limite?: number } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filtro.fila) { where.push('fila = ?'); args.push(filtro.fila); }
    if (filtro.status) { where.push('status = ?'); args.push(filtro.status); }
    if (filtro.desde !== undefined) { where.push('criado_em >= ?'); args.push(filtro.desde); }
    const onde = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    if (filtro.limite === undefined) {
      return this.db.prepare(`SELECT * FROM jobs${onde} ORDER BY id`).all(...args) as Job[];
    }
    const linhas = this.db
      .prepare(`SELECT * FROM jobs${onde} ORDER BY id DESC LIMIT ?`)
      .all(...args, filtro.limite) as Job[];
    return linhas.reverse();
  }

  /**
   * Claim ATÔMICO: um único UPDATE ... WHERE id = (SELECT ...) RETURNING *.
   * Fazer SELECT e depois UPDATE (como o mkivideos faz hoje) permite que dois
   * workers peguem o mesmo job. Ordem: prioridade DESC, id ASC (FIFO dentro da
   * mesma prioridade). `disponivel_em` cobre poll, backoff e agendamento.
   *
   * `dono` grava QUEM pegou o job no mesmo UPDATE atômico: é o que permite ao
   * ack (`concluir`/`falhar`/`reagendar`/`renovar`) recusar um worker zumbi que
   * acordou depois de o lease dele ter sido recuperado por outra instância.
   */
  pegar(fila: Fila, leaseSegundos: number, dono: string): Job | undefined {
    const agora = this.agora();
    return this.db
      .prepare(
        `UPDATE jobs
            SET status = 'running',
                tentativas = tentativas + 1,
                lease_ate = ?,
                lease_owner = ?,
                iniciado_em = COALESCE(iniciado_em, ?)
          WHERE id = (SELECT id FROM jobs
                       WHERE fila = ? AND status = 'queued' AND disponivel_em <= ?
                       ORDER BY prioridade DESC, id ASC
                       LIMIT 1)
        RETURNING *`,
      )
      .get(agora + leaseSegundos, dono, agora, fila, agora) as Job | undefined;
  }

  /**
   * Heartbeat: empurra o lease enquanto o trabalho está vivo. Obrigatório em job
   * longo (render de ~15 min) e durante o drain — soltar lease com o processo
   * vivo é exatamente o que permitiria dupla execução (spec §1.3).
   *
   * Devolve `false` quando o job não é mais nosso — o chamador DEVE largar o
   * trabalho em voo em vez de continuar batendo (ver `Worker.bater`).
   */
  renovar(id: number, leaseSegundos: number, dono: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET lease_ate = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(this.agora() + leaseSegundos, id, dono);
    return r.changes === 1;
  }

  /**
   * Recupera todo job `running` com lease vencido (worker morto, kill -9, queda
   * de energia). `tentativas` NÃO é zerado: o job já consumiu uma.
   *
   * O teto de tentativas tem que ser aplicado AQUI também: `falhar()` é
   * justamente o caminho que um crash pula, então requeue cego eternizaria um
   * job que mata o processo (max_tentativas=1 + OOM = loop infinito). Quem já
   * gastou todas as tentativas vira `failed` direto.
   *
   * Devolve `falhados` como LINHAS COMPLETAS, não uma contagem: quem chama
   * (`src/index.ts`) precisa de `chat_id` e `erro` para notificar cada job que
   * esta transição terminou (spec §8 — falha sempre notifica). Devolver só um
   * número obrigaria uma segunda consulta que já não saberia QUAIS linhas foram
   * afetadas. O requeue continua contagem: retentativa não é término.
   */
  recuperarLeasesVencidos(): { requeued: number; falhados: Job[] } {
    const agora = this.agora();
    const vencido = `status = 'running' AND lease_ate IS NOT NULL AND lease_ate <= ?`;
    return this.db.transaction(() => {
      // Ordem importa: o requeue roda primeiro e tira essas linhas de `running`,
      // então o UPDATE seguinte não pode pegá-las por engano.
      const req = this.db
        .prepare(
          `UPDATE jobs SET status = 'queued', lease_ate = NULL, lease_owner = NULL
            WHERE ${vencido} AND tentativas < max_tentativas`,
        )
        .run(agora);
      // Ids ANTES do UPDATE: depois dele o predicado `vencido` já não casa.
      const ids = this.db
        .prepare(`SELECT id FROM jobs WHERE ${vencido} AND tentativas >= max_tentativas`)
        .all(agora) as { id: number }[];
      this.db
        .prepare(
          `UPDATE jobs SET status = 'failed', erro = ?, lease_ate = NULL,
                           lease_owner = NULL, terminado_em = ?
            WHERE ${vencido} AND tentativas >= max_tentativas`,
        )
        .run('lease vencido sem ack (worker morreu)', agora, agora);
      const falhados = ids
        .map(({ id }) => this.obter(id))
        .filter((j): j is Job => j !== undefined);
      return { requeued: req.changes, falhados };
    })();
  }

  /**
   * Fecha o job como done. O `AND status = 'running'` é a proteção contra a
   * corrida "cancelei, mas o worker terminou depois": job cancelado NUNCA vira
   * done (spec §3.7). O `AND lease_owner = ?` é a segunda proteção: um worker
   * que perdeu o lease (estol + recuperação + reclaim por outra instância) não
   * pode sobrescrever o resultado de quem está rodando o job agora.
   */
  concluir(id: number, resultado: string, dono: string): boolean {
    const agora = this.agora();
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'done', resultado = ?, erro = NULL,
                         lease_ate = NULL, lease_owner = NULL, terminado_em = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(resultado, agora, id, dono);
    return r.changes === 1;
  }

  /**
   * Falha o job. Se ainda há tentativa, volta pra fila com backoff exponencial
   * (base * 2^(tentativas-1)); senão vira `failed`. Nunca reabre job cancelado
   * nem job que já pertence a outro dono.
   */
  falhar(id: number, erro: string, dono: string, backoffBase = 30): 'requeued' | 'failed' {
    const agora = this.agora();
    return this.db.transaction(() => {
      const job = this.db
        .prepare(
          `SELECT * FROM jobs WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .get(id, dono) as Job | undefined;
      if (!job) return 'failed';

      if (job.tentativas < job.max_tentativas) {
        const espera = backoffBase * 2 ** (job.tentativas - 1);
        this.db
          .prepare(
            `UPDATE jobs SET status = 'queued', erro = ?, lease_ate = NULL,
                             lease_owner = NULL, disponivel_em = ?
              WHERE id = ?`,
          )
          .run(erro, agora + espera, id);
        return 'requeued';
      }
      this.db
        .prepare(
          `UPDATE jobs SET status = 'failed', erro = ?, lease_ate = NULL,
                           lease_owner = NULL, terminado_em = ?
            WHERE id = ?`,
        )
        .run(erro, agora, id);
      return 'failed';
    })();
  }

  /**
   * Cancela job pendente ou em execução. Job terminal não é cancelável.
   * Sem `dono` de propósito: cancelar é ação do OPERADOR, não do dono do lease.
   */
  cancelar(id: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'canceled', lease_ate = NULL, lease_owner = NULL,
                         terminado_em = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(this.agora(), id);
    return r.changes === 1;
  }

  /**
   * Sobe a prioridade de um job pendente pra ele sair primeiro de `pegar`
   * (`ORDER BY prioridade DESC, id ASC`). Só se aplica a `queued`: um job
   * `running` já saiu da fila, sua posição nela deixou de existir — mudar
   * `prioridade` nele não teria efeito nenhum sobre nada, então não fazemos
   * (e ninguém deve "corrigir" isto pra cobrir `running` depois: seria mudar
   * um número morto). Sem `dono` de propósito, como `cancelar`: furar é ação
   * do OPERADOR, não do dono do lease.
   */
  priorizar(id: number, prioridade: number): boolean {
    const r = this.db
      .prepare(`UPDATE jobs SET prioridade = ? WHERE id = ? AND status = 'queued'`)
      .run(prioridade, id);
    return r.changes === 1;
  }

  /**
   * Devolve o job à fila para nova checagem em `emSegundos` SEM gastar tentativa
   * — é o mecanismo de poll das fases com `espera` (spec §3.2).
   */
  reagendar(id: number, emSegundos: number, dono: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_ate = NULL, lease_owner = NULL,
                         disponivel_em = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(this.agora() + emSegundos, id, dono);
    return r.changes === 1;
  }

  /**
   * Jobs que TERMINARAM e cujo dono ainda não foi avisado. É a rede de segurança
   * do §8: uma notificação que falhou (Telegram fora do ar, processo morto
   * entre o ack e o envio) some para sempre se ninguém reprocurar.
   *
   * `canceled` fica de fora de propósito: o cancelamento já foi confirmado no
   * chat pelo próprio comando que o disparou.
   */
  pendentesDeNotificacao(limite = 20): Job[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs
          WHERE status IN ('done', 'failed')
            AND chat_id IS NOT NULL
            AND notificado_em IS NULL
          ORDER BY id LIMIT ?`,
      )
      .all(limite) as Job[];
  }

  /**
   * Marca a notificação como entregue. Só DEPOIS do envio ter sucesso — marcar
   * antes trocaria "avisa duas vezes" (chato) por "nunca avisa" (o modo de
   * falha que a §8 proíbe).
   */
  marcarNotificado(id: number): boolean {
    const r = this.db
      .prepare('UPDATE jobs SET notificado_em = ? WHERE id = ? AND notificado_em IS NULL')
      .run(this.agora(), id);
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
