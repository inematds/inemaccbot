// Contrato de execução de UM job. O motor (Claude, Codex, …) é plugável: nada
// fora deste arquivo e dos runner-*.ts sabe qual agente está por baixo.
// Ver docs/perfil-de-execucao.md.
import type { Perfil } from './types.js';

export interface ContextoExecucao {
  prompt: string;
  cwd: string;
  perfil: Perfil;
  vars: Record<string, string>;
}

/** Uma execução em curso. `cancelar` encerra a ÁRVORE de processos (spec §3.7). */
export interface Execucao {
  aguardar(): Promise<string>;
  cancelar(): Promise<void>;
  limpar(): Promise<void>;
}

export interface Runner {
  nome: string;
  iniciar(ctx: ContextoExecucao): Execucao;
}

export interface FakeRunnerOpts {
  respostas?: string[];
  erros?: string[];
  /** Quando true, `aguardar` só resolve/rejeita depois de cancelar. */
  travar?: boolean;
}

/**
 * Runner de teste. É a SEGUNDA implementação da interface — por isso a costura
 * de motor plugável não custa nada: ela já é exigida pelos testes.
 */
export class FakeRunner implements Runner {
  nome = 'fake';
  chamadas: ContextoExecucao[] = [];
  cancelamentos = 0;
  limpezas = 0;

  constructor(private readonly opts: FakeRunnerOpts = {}) {}

  iniciar(ctx: ContextoExecucao): Execucao {
    this.chamadas.push(ctx);
    const resposta = this.opts.respostas?.shift();
    const erro = this.opts.erros?.shift();
    let rejeitarCancelado: ((e: Error) => void) | undefined;

    const aguardar = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        rejeitarCancelado = reject;
        if (this.opts.travar) return;
        if (erro !== undefined) reject(new Error(erro));
        else resolve(resposta ?? '');
      });

    return {
      aguardar,
      cancelar: async () => {
        this.cancelamentos += 1;
        rejeitarCancelado?.(new Error('cancelado'));
      },
      limpar: async () => { this.limpezas += 1; },
    };
  }
}

/** Registro de motores disponíveis, preenchido pelos runner-*.ts. */
export const RUNNERS: Record<string, Runner> = {};
