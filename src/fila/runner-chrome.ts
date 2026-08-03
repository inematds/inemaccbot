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
import { execFileSync } from 'node:child_process';
import { ClaudeRunner, argumentosClaude } from './runner-claude.js';
import { RUNNERS, type ContextoExecucao } from './runner.js';

/** As mesmas flags do runner normal, mais `--chrome` na frente. */
export function argumentosChrome(ctx: ContextoExecucao): string[] {
  return ['--chrome', ...argumentosClaude(ctx)];
}

/** O serviço que sobe a stack do display `:99` (Xvfb + openbox + vnc + Chromium). */
export const SERVICO_STACK99 = 'stack99.service';

/**
 * Volta o Chromium do `:99` para UMA aba (Projects) antes de cada job de
 * navegador.
 *
 * Por que isto existe (§7.2 do `setup-linux-navegador.md`, custou uma rodada
 * inteira para ser entendido): o editor do HeyGen abre em aba nova, e uma aba
 * que nasce em segundo plano fica `document.visibilityState === 'hidden'` para
 * sempre. O editor tiptap NÃO sincroniza digitação em aba oculta — o job então
 * "roda", não digita nada, e reporta 0 vídeos parecendo saudável. A causa não
 * era o Xvfb: era LIXO DE ABAS acumulado de runs anteriores. O reset é o fix
 * determinístico; o subagente até resolvia sozinho com `xdotool`, mas não
 * sempre.
 *
 * É seguro reiniciar aqui porque a fila `navegador` tem concorrência 1: quando
 * este job começa, nenhum outro está usando o `:99`.
 *
 * Best-effort de propósito. Numa máquina sem `stack99` (dev, CI, qualquer um
 * que não seja esta), falhar aqui derrubaria um job que talvez fosse rodar bem
 * no navegador do desktop. Quem sabe de verdade se a aba está utilizável é o
 * próprio prompt da fase, que confere `visibilityState` antes de digitar.
 */
export function resetarStack99(
  executar: (cmd: string, args: string[]) => void = (cmd, args) => {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 60_000 });
  },
  log: (texto: string) => void = (t) => process.stderr.write(`${t}\n`),
): void {
  try {
    executar('systemctl', ['--user', 'restart', SERVICO_STACK99]);
    log(`navegador: ${SERVICO_STACK99} reiniciado (aba única)`);
  } catch (e) {
    log(`navegador: não reiniciei ${SERVICO_STACK99} (${(e as Error).message})`);
  }
}

class ChromeRunner extends ClaudeRunner {
  iniciar(ctx: ContextoExecucao) {
    resetarStack99();
    return super.iniciar(ctx);
  }
}

RUNNERS.chrome = new ChromeRunner({ montarArgs: argumentosChrome });
