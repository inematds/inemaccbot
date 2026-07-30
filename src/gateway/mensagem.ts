// Uma mensagem de chat, do texto à resposta. É o roteador do §1.1 completo:
//
//   comando de serviço (/fila, /status…)  → executar
//   `skill: entrada | campos`             → executar (enfileira)
//   texto livre                           → interpretar
//                                             ├─ pedidos  → enfileira cada um
//                                             ├─ pergunta → responderPergunta
//                                             └─ recusa   → diz o porquê
//
// Separado de `index.ts` para ser testável sem processo, sem rede e sem
// `claude`: os dois agentes entram como `Runner` injetado, que é a mesma
// costura que a fila usa (§1.4) — o `FakeRunner` já existe.
import type { FilaSqlite } from '../fila/store.js';
import type { Runner } from '../fila/runner.js';
import type { Agora, Job, Perfil } from '../fila/types.js';
import type { SkillDef } from '../dominio/registry.js';
import { executar, parseComando } from './comandos.js';
import { caudaDoLog, responderPergunta } from './answer.js';
import { interpretar } from './interpret.js';

export interface DepsMensagem {
  fila: FilaSqlite;
  agora: Agora;
  defs: SkillDef[];
  projetosDir: string;
  /** Motor dos dois agentes de interação (interpretar e responder). */
  runner: Runner;
  perfil: Perfil;
  cwd: string;
  logFile: string;
  /**
   * Saneia o que entra no CONTEXTO da resposta. O log do serviço é lido do
   * disco e vai inteiro para o prompt; ele carrega caminhos, mensagens de erro
   * de job e, no pior caso, um segredo que escapou. O prompt manda não repetir
   * isso, mas instrução a um modelo não é controle — a redação é (§9).
   */
  redigir?: (texto: string) => string;
}

/** Jobs deste chat, do mais recente para o mais antigo, com teto — o contexto
 * da resposta não pode crescer com o histórico. Escopado ao chat de propósito:
 * job de outro chat nunca entra na resposta. */
function jobsDoChat(fila: FilaSqlite, chatId: number, limite = 15): Job[] {
  return fila.listar().filter((j) => j.chat_id === chatId).reverse().slice(0, limite);
}

export async function tratarMensagem(
  chatId: number, texto: string, deps: DepsMensagem,
): Promise<string> {
  const cmd = parseComando(texto, deps.defs, deps.projetosDir);
  const depsCmd = { fila: deps.fila, chatId, agora: deps.agora, defs: deps.defs };

  if (cmd.tipo !== 'livre') return executar(cmd, depsCmd);

  const interpretacao = await interpretar(cmd.texto, {
    defs: deps.defs,
    projetosDir: deps.projetosDir,
    runner: deps.runner,
    perfil: deps.perfil,
    cwd: deps.cwd,
  });

  if (interpretacao.tipo === 'recusa') return interpretacao.motivo;

  if (interpretacao.tipo === 'pergunta') {
    return responderPergunta(
      interpretacao.pergunta,
      {
        jobsDoChat: jobsDoChat(deps.fila, chatId),
        cauda: (deps.redigir ?? ((x: string) => x))(caudaDoLog(deps.logFile)),
        defs: deps.defs,
        agora: deps.agora(),
      },
      { runner: deps.runner, perfil: deps.perfil, cwd: deps.cwd },
    );
  }

  // Enfileira pelo MESMO caminho do comando digitado (`executar`), e não por um
  // `enfileirar` próprio: assim existe um lugar só onde um job de skill nasce —
  // com as mesmas checagens de catálogo e o mesmo formato de `input`.
  const respostas = interpretacao.pedidos.map((pedido) =>
    executar({ tipo: 'skill', pedido }, depsCmd),
  );
  if (interpretacao.ignorado) respostas.push(`não vou fazer: ${interpretacao.ignorado}`);
  return respostas.join('\n');
}
