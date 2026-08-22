// Leitura e escrita das tabelas de fluxo. Sem regra de negócio: quem decide o
// que fazer é o `runtime.ts`.
import type Database from 'better-sqlite3';

import type { FlowDef } from '../dominio/flow.js';
import type { Agora } from '../fila/types.js';

export type EstadoFase =
  | 'pendente'
  | 'rodando'
  | 'feito'
  /** Terminou, e o fluxo está PARADO esperando `/aprovar` (portão humano). */
  | 'aguardando-ok'
  | 'falhou'
  | 'pulado';
/**
 * `pausado` é ABERTO e voluntário: o fluxo não terminou e não falhou — alguém
 * pediu para ele esperar. Ele existe porque a única saída era `/cancelar`, que
 * mata e marca as fases como puladas, sem volta: quem só queria dar passagem a
 * outro fluxo na fila perdia o trabalho.
 */
export type StatusFluxo = 'rodando' | 'feito' | 'falhou' | 'cancelado' | 'pausado';

export interface Fluxo {
  id: number;
  tipo: string;
  prefixo: string;
  slug: string;
  assunto: string;
  versao: number;
  chat_id: number | null;
  status: StatusFluxo;
  definicao_json: string;
  definicao_hash: string;
  versao_def: number;
  criado_em: number;
  terminado_em: number | null;
}

export interface Fase {
  fluxo_id: number;
  fase: string;
  /** `''` quando a fase é de escopo `fluxo` — sentinela, porque a PK não aceita NULL. */
  alvo: string;
  escopo: 'fluxo' | 'alvo';
  ordem: number;
  estado: EstadoFase;
  job_id: number | null;
  tentativas: number;
  dados: string | null;
  erro: string | null;
  criado_em: number;
}

export class EstadoFluxos {
  constructor(
    private readonly db: Database.Database,
    private readonly agora: Agora,
  ) {}

  criar(entrada: {
    tipo: string; prefixo: string; slug: string; assunto: string; versao: number;
    chatId: number | null; definicao: FlowDef; hash: string;
  }): Fluxo {
    const agora = this.agora();
    const info = this.db
      .prepare(
        `INSERT INTO fluxos
           (tipo, prefixo, slug, assunto, versao, chat_id, definicao_json,
            definicao_hash, versao_def, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entrada.tipo, entrada.prefixo, entrada.slug, entrada.assunto, entrada.versao,
        entrada.chatId, JSON.stringify(entrada.definicao), entrada.hash,
        entrada.definicao.versao_def, agora,
      );
    const fluxo = this.obter(Number(info.lastInsertRowid));
    if (!fluxo) throw new Error('fluxos: linha não encontrada após INSERT');
    return fluxo;
  }

  obter(id: number): Fluxo | undefined {
    return this.db.prepare('SELECT * FROM fluxos WHERE id = ?').get(id) as Fluxo | undefined;
  }

  listar(status?: StatusFluxo): Fluxo[] {
    const sql = status
      ? 'SELECT * FROM fluxos WHERE status = ? ORDER BY id'
      : 'SELECT * FROM fluxos ORDER BY id';
    return (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Fluxo[];
  }

  /** A definição CONGELADA. Toda decisão de fase lê daqui, nunca do disco (§3.4). */
  definicaoDe(fluxo: Fluxo): FlowDef {
    return JSON.parse(fluxo.definicao_json) as FlowDef;
  }

  criarFases(fluxoId: number, fases: Omit<Fase, 'fluxo_id' | 'criado_em' | 'estado' | 'job_id' | 'tentativas' | 'dados' | 'erro'>[]): void {
    const agora = this.agora();
    const ins = this.db.prepare(
      `INSERT INTO fluxo_fases (fluxo_id, fase, alvo, escopo, ordem, criado_em)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const f of fases) ins.run(fluxoId, f.fase, f.alvo, f.escopo, f.ordem, agora);
    })();
  }

  fases(fluxoId: number): Fase[] {
    return this.db
      .prepare('SELECT * FROM fluxo_fases WHERE fluxo_id = ? ORDER BY ordem, alvo')
      .all(fluxoId) as Fase[];
  }

  fase(fluxoId: number, fase: string, alvo: string): Fase | undefined {
    return this.db
      .prepare('SELECT * FROM fluxo_fases WHERE fluxo_id = ? AND fase = ? AND alvo = ?')
      .get(fluxoId, fase, alvo) as Fase | undefined;
  }

  /** A fase que um job está executando — o caminho de volta do ack para o fluxo. */
  faseDoJob(jobId: number): Fase | undefined {
    return this.db
      .prepare('SELECT * FROM fluxo_fases WHERE job_id = ?')
      .get(jobId) as Fase | undefined;
  }

  atualizarFase(
    fluxoId: number, fase: string, alvo: string,
    campos: Partial<Pick<Fase, 'estado' | 'job_id' | 'tentativas' | 'dados' | 'erro'>>,
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(campos)) { sets.push(`${k} = ?`); args.push(v); }
    if (!sets.length) return;
    this.db
      .prepare(`UPDATE fluxo_fases SET ${sets.join(', ')} WHERE fluxo_id = ? AND fase = ? AND alvo = ?`)
      .run(...args, fluxoId, fase, alvo);
  }

  /**
   * Fecha o fluxo quando não sobra fase por fazer. `falhou` se algum alvo
   * falhou — um fluxo com 11 alvos prontos e 1 falhado NÃO é um fluxo feito, e
   * dizer que é esconderia o alvo que precisa de `/refazer`.
   */
  recalcularStatus(fluxoId: number): StatusFluxo {
    // PAUSADO não se recalcula. O estado das fases não sabe que alguém pediu
    // pausa — sem esta guarda, o primeiro ack devolveria o fluxo para `rodando`
    // e a pausa duraria até o próximo evento.
    const atual = this.obter(fluxoId);
    if (atual?.status === 'pausado') return 'pausado';
    const fases = this.fases(fluxoId);
    // `aguardando-ok` conta como ABERTO: o fluxo não terminou, está esperando
    // uma pessoa. Tratá-lo como terminal faria o bot anunciar "feito" no meio.
    const aberto = fases.some(
      (f) => f.estado === 'pendente' || f.estado === 'rodando' || f.estado === 'aguardando-ok',
    );
    // A ordem importa: um fluxo cujos alvos foram todos cancelados um a um não
    // é um fluxo "feito" — ele não fez nada. Sem este caso, `/cancelar` alvo a
    // alvo terminaria anunciando sucesso.
    const status: StatusFluxo = aberto
      ? 'rodando'
      : fases.some((f) => f.estado === 'falhou') ? 'falhou'
        : fases.every((f) => f.estado === 'pulado') ? 'cancelado' : 'feito';
    this.db
      .prepare('UPDATE fluxos SET status = ?, terminado_em = ? WHERE id = ?')
      .run(status, status === 'rodando' ? null : this.agora(), fluxoId);
    return status;
  }

  marcarStatus(fluxoId: number, status: StatusFluxo): void {
    this.db
      .prepare('UPDATE fluxos SET status = ?, terminado_em = ? WHERE id = ?')
      .run(status, status === 'rodando' ? null : this.agora(), fluxoId);
  }
}
