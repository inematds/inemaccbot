// Runner do motor `claude`. Único lugar do sistema que conhece a CLI do Claude.
// Trocar de motor = escrever outro arquivo como este e registrá-lo em RUNNERS.
import { spawn } from 'node:child_process';

import { RUNNERS, type ContextoExecucao, type Execucao, type Runner } from './runner.js';

/**
 * Traduz o perfil de execução nas flags da CLI. Função pura de propósito: é o
 * ponto de comparação quando se escreve o runner de outro motor.
 */
export function argumentosClaude(ctx: ContextoExecucao): string[] {
  return ['--model', ctx.perfil.modelo, '--effort', ctx.perfil.esforco, '-p', ctx.prompt];
}

export class ClaudeRunner implements Runner {
  nome = 'claude';

  constructor(private readonly binario = 'claude') {}

  iniciar(ctx: ContextoExecucao): Execucao {
    // `detached: true` cria um process group próprio: cancelar mata a ÁRVORE
    // (o agente abre subprocessos), não só o pai. Nunca `shell: true`.
    const filho = spawn(this.binario, argumentosClaude(ctx), {
      cwd: ctx.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...ctx.vars },
    });

    let cancelado = false;
    let stdout = '';
    let stderr = '';
    filho.stdout?.on('data', (d) => { stdout += String(d); });
    filho.stderr?.on('data', (d) => { stderr += String(d); });

    const promessa = new Promise<string>((resolve, reject) => {
      filho.on('error', reject);
      filho.on('close', (code) => {
        if (cancelado) return reject(new Error('execução cancelada'));
        if (code === 0) return resolve(stdout.trim());
        reject(new Error(`${this.binario} saiu com código ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });
    // Marca a promessa como observada desde o nascimento: ela pode rejeitar (via `close`)
    // antes de o chamador chamar `aguardar()`, e sem isto o Node emite
    // PromiseRejectionHandledWarning. `aguardar()` continua devolvendo a promessa
    // original, então quem espera ainda recebe a rejeição normalmente.
    promessa.catch(() => {});

    const matarArvore = (sinal: NodeJS.Signals): void => {
      if (filho.pid === undefined) return;
      try { process.kill(-filho.pid, sinal); } catch { /* já morreu */ }
    };

    return {
      aguardar: () => promessa,
      cancelar: async () => {
        cancelado = true;
        matarArvore('SIGTERM');
        await new Promise((r) => setTimeout(r, 2_000));
        matarArvore('SIGKILL');
      },
      limpar: async () => { /* o runner do Claude não deixa parciais próprios */ },
    };
  }
}

RUNNERS.claude = new ClaudeRunner();
