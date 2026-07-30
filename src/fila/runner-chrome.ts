// Motor `chrome`: `claude --chrome -p`.
//
// Existe por UMA razão: a fase de avatar do promoclub dirige o estúdio do HeyGen
// pelo navegador, e a extensão do Claude só é reconhecida quando a CLI sobe com
// `--chrome` (nesta máquina ARM64 com Chromium snap — está documentado no
// `docs/setup-linux-navegador.md` do repo de domínio).
//
// É a peça mais frágil do sistema, e o desenho reconhece isso: a fila
// `navegador` tem concorrência 1 porque o Chromium do display `:99` é EXCLUSIVO.
// No v1 essa exclusividade era um mutex em memória (`comFase2Fila`), que um
// restart zerava; aqui é propriedade da fila, e sobrevive.
import { ClaudeRunner, argumentosClaude } from './runner-claude.js';
import { RUNNERS, type ContextoExecucao } from './runner.js';

/** As mesmas flags do runner normal, mais `--chrome` na frente. */
export function argumentosChrome(ctx: ContextoExecucao): string[] {
  return ['--chrome', ...argumentosClaude(ctx)];
}

RUNNERS.chrome = new ClaudeRunner({ montarArgs: argumentosChrome });
