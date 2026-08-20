// Motor `opencode`: a CLI aberta (`opencode run`), que fala com vários
// provedores (Anthropic, OpenAI, Groq, DeepSeek, modelo local…).
//
// Mesma ideia do `runner-codex.ts`: é uma ALTERNATIVA registrada por nome, e
// nada aqui toca no caminho do motor `claude`. Toda a maquinaria de processo é
// herdada do `ClaudeRunner`; o que este arquivo define é só a tradução do perfil
// em flags.
//
// AVISO DE PROCEDÊNCIA: ao contrário do `codex`, o `opencode` não estava
// instalado na máquina onde este runner foi escrito. As flags vêm da
// documentação da CLI, e os testes exercitam a função pura e a maquinaria de
// processo — NÃO a CLI real. Antes de usar em produção, rode o roteiro de
// verificação de `docs/motor-opencode.md`.
import { ClaudeRunner } from './runner-claude.js';
import { RUNNERS, type ContextoExecucao } from './runner.js';

/**
 * Tradução alias → modelo, lida de `OPENCODE_MODELOS`.
 *
 * Formato: `OPENCODE_MODELOS="sonnet=anthropic/claude-sonnet-4-5,opus=deepseek/deepseek-chat"`.
 * O opencode identifica modelo como `provedor/modelo` — um alias solto não
 * resolve.
 *
 * Vazio por padrão, pelo mesmo motivo do codex: sem mapa, o `--model` não é
 * passado e vale o default do `opencode.json` do usuário. É melhor herdar a
 * escolha de quem configurou a máquina do que chutar um id.
 */
export function mapaModelos(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const bruto = env.OPENCODE_MODELOS?.trim();
  if (!bruto) return {};
  const mapa: Record<string, string> = {};
  for (const par of bruto.split(',')) {
    const [alias, id] = par.split('=').map((s) => s.trim());
    if (alias && id) mapa[alias] = id;
  }
  return mapa;
}

/**
 * Traduz o perfil nas flags do `opencode run`.
 *
 * Repare no que NÃO está aqui: `esforco`. A CLI do opencode não expõe nível de
 * raciocínio — ele é propriedade do modelo escolhido. Em vez de inventar uma
 * flag, o esforço simplesmente não viaja: quem quer "mais esforço" mapeia um
 * alias para um modelo mais forte em `OPENCODE_MODELOS`. Fingir que a flag
 * existe seria pior — o job rodaria diferente do que o `/status` diz.
 *
 * `--print-logs` fica de fora: a saída do agente é o contrato (`RESULT:` na
 * última linha), e log de infra no meio dela só aumenta a chance de ruído.
 */
export function argumentosOpencode(
  ctx: ContextoExecucao,
  mapa: Record<string, string> = mapaModelos(),
): string[] {
  const modelo = mapa[ctx.perfil.modelo];
  return ['run', ...(modelo ? ['--model', modelo] : []), ctx.prompt];
}

export class OpencodeRunner extends ClaudeRunner {
  nome = 'opencode';
  /** Binário por CAMINHO, não pelo PATH — ver o comentário do `CodexRunner`. */
  constructor(binario?: string) {
    super({ binario: binario ?? 'opencode', montarArgs: (ctx) => argumentosOpencode(ctx) });
  }
}

RUNNERS.opencode = new OpencodeRunner();
