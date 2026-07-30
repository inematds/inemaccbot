// Contrato de execução de UM job. O motor (Claude, Codex, …) é plugável: nada
// fora deste arquivo e dos runner-*.ts sabe qual agente está por baixo.
// Ver docs/perfil-de-execucao.md.
import type { Perfil } from './types.js';

export interface ContextoExecucao {
  prompt: string;
  cwd: string;
  perfil: Perfil;
  vars: Record<string, string>;
  /**
   * Teto de PAREDE desta execução (vem do registry da skill). Ausente = sem
   * teto, que é o comportamento que só faz sentido em teste: em produção um
   * agente sem prazo ocupa um slot da fila para sempre, porque o heartbeat
   * renova o lease enquanto o processo existir.
   */
  timeoutMs?: number;
  /**
   * Traduz o stdout bruto no RESULTADO do job (para skills: o caminho declarado
   * em `RESULT:`). Mora aqui, e não no worker, porque o que conta como resultado
   * é conhecimento do DOMÍNIO — `fila/` não sabe o que é `RESULT:`. Ausente: o
   * stdout cru vira o resultado (é o que os testes de fila usam).
   */
  interpretarSaida?: (bruto: string) => string;
  /**
   * O agente DISPARA o trabalho e sai; o resultado aparece depois, fora dele
   * (etapa 3: render destacado). Quando presente, o worker chama isto com o
   * caminho que `interpretarSaida` extraiu e espera aqui — segurando o lease
   * (o heartbeat continua) e, portanto, o SLOT da fila.
   *
   * Segurar o slot é requisito, não detalhe: liberar a vaga entre um poll e
   * outro deixaria um segundo render ser reclamado, e os dois escreveriam na
   * mesma GPU — que é exatamente o que a concorrência 1 da fila existe para
   * impedir.
   */
  aguardarArtefato?: (alvo: string, sinal: AbortSignal) => Promise<string>;
  /**
   * O trabalho já foi disparado numa tentativa anterior (o serviço caiu no meio
   * e o processo destacado sobreviveu). O agente NÃO é chamado: vai direto
   * esperar o artefato deste caminho. Sem isto, um restart no meio de um render
   * dispararia um SEGUNDO render sobre o primeiro.
   */
  alvoEmCurso?: string;
  /**
   * Encerra o trabalho DESTACADO. Chamado só quando o operador cancelou o job:
   * no desligamento e na perda de lease o processo destacado tem que sobreviver,
   * porque é ele que a próxima tentativa adota.
   *
   * Devolve `true` se havia o que matar — a mensagem no chat depende disso: um
   * render que continuou rodando não pode ser anunciado como cancelado (§3.7).
   */
  encerrarTrabalho?: () => Promise<boolean>;
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
