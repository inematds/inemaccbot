// Motor `chrome`: `claude --chrome -p`.
//
// Existe por UMA razão: a fase de avatar do promoavatar dirige o estúdio do HeyGen
// pelo navegador, e a extensão do Claude só é reconhecida quando a CLI sobe com
// `--chrome` (nesta máquina ARM64 com Chromium snap — está documentado no
// `docs/setup-linux-navegador.md` do repo de domínio).
//
// É a peça mais frágil do sistema, e o desenho reconhece isso: a fila
// `navegador` tem concorrência 1 porque o Chromium do display `:99` é EXCLUSIVO.
// No v1 essa exclusividade era um mutex em memória (`comFase2Fila`), que um
// restart zerava; aqui é propriedade da fila, e sobrevive.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { ClaudeRunner, argumentosClaude } from './runner-claude.js';
import { RUNNERS, type ContextoExecucao } from './runner.js';

/** As mesmas flags do runner normal, mais `--chrome` na frente. */
export function argumentosChrome(ctx: ContextoExecucao): string[] {
  return ['--chrome', ...argumentosClaude(ctx)];
}

/** O serviço que sobe a stack do display `:99` (Xvfb + openbox + vnc + Chromium). */
export const SERVICO_STACK99 = 'stack99.service';

/** Sai 0 só quando a JANELA do Chromium está MAPEADA — não basta o processo
 *  existir: o bug clássico era tela preta com todos os processos de pé. */
export const CHECK_STACK99 = `${homedir()}/stack99/stack99-check.sh`;

/**
 * Orçamento de PAREDE do reset inteiro, e por que é tão apertado.
 *
 * `iniciar()` é síncrono e roda no event loop do worker, que serve TODAS as
 * filas — não só a `navegador`. Enquanto isto bloqueia, nenhum outro job começa
 * e, pior, o heartbeat não renova lease nenhum. Com `LEASE_PADRAO_SEGUNDOS = 60`,
 * um reset demorado faria jobs saudáveis de outras filas perderem o lease e
 * serem repegados. 25s é menos da metade do lease: ruim, mas nunca fatal.
 *
 * Se um dia o reset precisar de mais tempo que isto, a saída não é aumentar o
 * teto — é tirar o reset do caminho síncrono.
 */
const ORCAMENTO_MS = 25_000;
const RESTART_TIMEOUT_MS = 15_000;
const INTERVALO_CHECK_MS = 1_000;

/** Espera síncrona de verdade, sem ocupar CPU. Precisa ser síncrona porque
 *  `iniciar()` é síncrono; `await` aqui deixaria o agente subir antes da janela. */
function dormirSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
 * NÃO basta reiniciar: `systemctl restart` volta quando o SERVIÇO subiu, não
 * quando o Chromium pintou a janela, carregou `app.heygen.com/projects` e
 * repareou com a extensão. Soltar o agente nesse intervalo é cair de novo no
 * mesmo buraco — ele chama `list_connected_browsers`, não acha o navegador
 * local e falha, ou acha uma janela não mapeada e volta ao `hidden`. Por isso o
 * reset só termina quando `stack99-check.sh` sai 0 (janela MAPEADA), que é
 * exatamente o ponto que o §7.2 chama de fix determinístico.
 *
 * É seguro reiniciar aqui porque a fila `navegador` tem concorrência 1: quando
 * este job começa, nenhum outro está usando o `:99`. (Isso vale para o
 * NAVEGADOR; o bloqueio do event loop é outra conta — ver `ORCAMENTO_MS`.)
 *
 * Best-effort de propósito. Numa máquina sem `stack99` (dev, CI, qualquer um
 * que não seja esta), falhar aqui derrubaria um job que talvez fosse rodar bem
 * no navegador do desktop. Quem sabe de verdade se a aba está utilizável é o
 * próprio prompt da fase, que confere `visibilityState` antes de digitar.
 */
export function resetarStack99(
  deps: {
    executar?: (cmd: string, args: string[], timeoutMs: number) => void;
    agora?: () => number;
    dormir?: (ms: number) => void;
    log?: (texto: string) => void;
  } = {},
): void {
  const executar = deps.executar ?? ((cmd, args, timeoutMs): void => {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: timeoutMs });
  });
  const agora = deps.agora ?? ((): number => Date.now());
  const dormir = deps.dormir ?? dormirSync;
  const log = deps.log ?? ((t: string): void => { process.stderr.write(`${t}\n`); });

  const limite = agora() + ORCAMENTO_MS;
  try {
    executar('systemctl', ['--user', 'restart', SERVICO_STACK99], RESTART_TIMEOUT_MS);
  } catch (e) {
    log(`navegador: não reiniciei ${SERVICO_STACK99} (${(e as Error).message})`);
    return;
  }

  // Só a partir daqui o reset vale alguma coisa: reiniciado mas com a janela
  // ainda não mapeada é o pior dos mundos — parece resolvido e não está.
  for (;;) {
    const restante = limite - agora();
    if (restante <= 0) {
      log(`navegador: ${SERVICO_STACK99} reiniciado, mas a janela do :99 não`
        + ` ficou mapeada em ${ORCAMENTO_MS / 1000}s — sigo assim mesmo`);
      return;
    }
    try {
      executar('bash', [CHECK_STACK99], Math.min(restante, INTERVALO_CHECK_MS * 5));
      log(`navegador: ${SERVICO_STACK99} reiniciado, janela do :99 mapeada (aba única)`);
      return;
    } catch {
      dormir(Math.min(INTERVALO_CHECK_MS, Math.max(0, limite - agora())));
    }
  }
}

class ChromeRunner extends ClaudeRunner {
  iniciar(ctx: ContextoExecucao) {
    resetarStack99();
    return super.iniciar(ctx);
  }
}

RUNNERS.chrome = new ChromeRunner({ montarArgs: argumentosChrome });
