// Loop de trabalho de UMA fila. Não sabe o que é Telegram nem fluxo — só
// claim → executa → ack. A disciplina que faltava no v1: lease com heartbeat,
// falha registrada, e drain que NÃO solta o lease do que está em voo (spec §1.3).
import type { Execucao, ContextoExecucao, Runner } from './runner.js';
import type { FilaSqlite } from './store.js';
import type { Fila, Job } from './types.js';

export type Tarefa = (job: Job) => Promise<string>;

export interface WorkerOpts {
  fila: Fila;
  concorrencia: number;
  leaseSegundos: number;
  heartbeatSegundos: number;
  tarefas: Record<string, Tarefa>;
  runners: Record<string, Runner>;
  promptDe: (job: Job) => ContextoExecucao;
  log?: (m: string) => void;
}

export class Worker {
  private drenando = false;
  private readonly ativos = new Map<number, Execucao | null>();

  constructor(
    private readonly fila: FilaSqlite,
    private readonly opts: WorkerOpts,
  ) {}

  get emVoo(): number {
    return this.ativos.size;
  }

  /** Renova o lease de tudo que está em voo. Chamado pelo timer e no drain. */
  async bater(): Promise<void> {
    for (const id of this.ativos.keys()) {
      this.fila.renovar(id, this.opts.leaseSegundos);
    }
  }

  /** Processa no máximo um job. Devolve true se pegou algo. */
  async passo(): Promise<boolean> {
    if (this.drenando) return false;
    if (this.ativos.size >= this.opts.concorrencia) return false;

    const job = this.fila.pegar(this.opts.fila, this.opts.leaseSegundos);
    if (!job) return false;

    this.ativos.set(job.id, null);
    const log = this.opts.log ?? (() => {});
    const ref = job.flow_ref ? ` ${job.flow_ref}` : '';
    log(`[job ${job.id}${ref}] ${job.fila}/${job.tarefa} motor=${job.motor ?? '-'} modelo=${job.modelo ?? '-'} esforco=${job.esforco ?? '-'}`);

    try {
      const saida = job.kind === 'function'
        ? await this.rodarFuncao(job)
        : await this.rodarAgente(job);
      if (!this.fila.concluir(job.id, saida)) {
        log(`[job ${job.id}] terminou mas não estava running (cancelado?) — done rejeitado`);
      }
    } catch (e) {
      const erro = (e as Error).message.slice(0, 1_000);
      const r = this.fila.falhar(job.id, erro, 30);
      log(`[job ${job.id}] ${r}: ${erro}`);
    } finally {
      this.ativos.delete(job.id);
    }
    return true;
  }

  private async rodarFuncao(job: Job): Promise<string> {
    const tarefa = this.opts.tarefas[job.tarefa];
    if (!tarefa) throw new Error(`tarefa desconhecida: ${job.tarefa}`);
    return tarefa(job);
  }

  private async rodarAgente(job: Job): Promise<string> {
    const ctx = this.opts.promptDe(job);
    const runner = this.opts.runners[ctx.perfil.motor];
    if (!runner) throw new Error(`motor desconhecido: ${ctx.perfil.motor}`);
    const exec = runner.iniciar(ctx);
    this.ativos.set(job.id, exec);
    try {
      return await exec.aguardar();
    } finally {
      await exec.limpar();
    }
  }

  /**
   * Drain: para de aceitar novos claims e espera o que está em voo, RENOVANDO o
   * lease enquanto espera. Soltar o lease aqui permitiria outro worker pegar o
   * mesmo job com o nosso processo ainda vivo.
   */
  async drenar(): Promise<void> {
    this.drenando = true;
    while (this.ativos.size > 0) {
      await this.bater();
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Encerra à força o que estiver em voo (usado no timeout do drain). */
  async abortar(): Promise<void> {
    for (const [id, exec] of this.ativos) {
      await exec?.cancelar();
      this.fila.falhar(id, 'interrompido no encerramento do serviço', 30);
    }
    this.ativos.clear();
  }
}
