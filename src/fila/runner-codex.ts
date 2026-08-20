// Motor `codex`: a CLI da OpenAI em modo não-interativo (`codex exec`).
//
// Existe como ALTERNATIVA ao motor `claude`, não como substituto: nada aqui
// muda o caminho de quem pede `claude`. O worker escolhe o motor pelo NOME
// (`RUNNERS[ctx.perfil.motor]`), então basta este arquivo ser importado para
// que `| motor=codex` passe a funcionar — e basta não pedir por ele para que
// tudo siga como antes.
//
// Toda a maquinaria de processo (process group próprio, timeout de parede, teto
// de saída, matar a ÁRVORE no cancelamento) é herdada do `ClaudeRunner`: ela não
// tem nada de Claude, é o contrato de executar UM binário de agente. O que muda
// de motor para motor é só a tradução do perfil em flags — a função pura abaixo.
//
// Ver `docs/motor-codex.md`.
import { ClaudeRunner } from './runner-claude.js';
import { RUNNERS, type ContextoExecucao } from './runner.js';

/**
 * Tradução alias → modelo real do codex, lida de `CODEX_MODELOS`.
 *
 * Formato: `CODEX_MODELOS="sonnet=gpt-5.1-codex,opus=gpt-5.6-sol"`.
 *
 * **Vazio por padrão, de propósito.** Os aliases do sistema (`haiku`, `fable`,
 * `sonnet`, `opus`) são vocabulário da Claude; chutar um id da OpenAI para cada
 * um deles faria todo job falhar no dia em que a OpenAI renomeasse um modelo —
 * uma quebra causada por um default que ninguém pediu. Sem mapa, o `--model` não
 * é passado e vale o `model` do `~/.codex/config.toml`, que é onde o dono da
 * máquina já declarou o que usa.
 *
 * `MODELOS_RANK` em `dominio/perfil.ts` NÃO muda: o alias continua sendo o
 * vocabulário do bot, e a tradução para o id do motor mora aqui.
 */
export function mapaModelos(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const bruto = env.CODEX_MODELOS?.trim();
  if (!bruto) return {};
  const mapa: Record<string, string> = {};
  for (const par of bruto.split(',')) {
    const [alias, id] = par.split('=').map((s) => s.trim());
    if (alias && id) mapa[alias] = id;
  }
  return mapa;
}

/**
 * O codex conhece `minimal|low|medium|high`; o bot conhece cinco degraus
 * (`dominio/perfil.ts`). Os dois de cima colapsam em `high` — é o teto do motor,
 * e recusar o job por causa disso seria pior que entregá-lo no máximo possível.
 */
export function esforcoCodex(esforco: string): string {
  return esforco === 'xhigh' || esforco === 'max' ? 'high' : esforco;
}

/**
 * Traduz o perfil nas flags do `codex exec`. Função pura, igual à
 * `argumentosClaude` — é o ponto de comparação entre os motores.
 *
 * Por que cada flag:
 * - `exec` — modo não-interativo. Sem ele a CLI abre a TUI e o job pendura.
 * - `--skip-git-repo-check` — o `cwd` de uma skill é uma pasta de artefatos, que
 *   quase nunca é um repo git. Sem isto o codex recusa sair da largada.
 * - `-s danger-full-access` — EXPLÍCITO, e não herdado do `config.toml`: os
 *   prompts rodam `python3`, `ffmpeg` e gravam fora do `cwd`. Deixar isso
 *   depender de um arquivo de config do usuário é a mesma armadilha que o
 *   `CLAUDE_BIN` já custou caro (ver `config.ts`) — o comportamento do serviço
 *   passaria a depender de como a máquina foi configurada.
 * - `--model` só quando há mapa (ver `mapaModelos`).
 * - o prompt por ÚLTIMO e como argumento único, nunca interpolado num shell.
 */
export function argumentosCodex(
  ctx: ContextoExecucao,
  mapa: Record<string, string> = mapaModelos(),
): string[] {
  const modelo = mapa[ctx.perfil.modelo];
  return [
    'exec',
    '--skip-git-repo-check',
    '-s', 'danger-full-access',
    ...(modelo ? ['--model', modelo] : []),
    '-c', `model_reasoning_effort="${esforcoCodex(ctx.perfil.esforco)}"`,
    ctx.prompt,
  ];
}

export class CodexRunner extends ClaudeRunner {
  nome = 'codex';
  /**
   * O binário vem por CAMINHO, como o do `claude` — e pelo mesmo motivo: o
   * serviço systemd roda com PATH mínimo, e o `codex` instalado por npm global
   * mora em `~/.npm-global/bin`. Confiar no PATH aqui é repetir o C#77.
   */
  constructor(binario?: string) {
    super({ binario: binario ?? 'codex', montarArgs: (ctx) => argumentosCodex(ctx) });
  }
}

RUNNERS.codex = new CodexRunner();
