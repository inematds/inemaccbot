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
import type { FluxoRegistrado } from '../dominio/registry-fluxos.js';
import type { Fluxos } from '../fluxos/runtime.js';
import { ajudaDaSkill } from './ajuda-dominio.js';
import { executar, parseComando } from './comandos.js';
import {
  ajudaDoFluxo, aprovarFluxo, cancelarFluxo, criarFluxo, refazerFluxo, statusFluxo,
  textoFluxos,
} from './comandos-fluxo.js';
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
  /** Motor de fluxos e o catálogo de repos de domínio. Ausentes = etapa 4. */
  fluxos?: Fluxos;
  fluxosRegistrados?: FluxoRegistrado[];
  /**
   * Saneia o que entra no CONTEXTO da resposta. O log do serviço é lido do
   * disco e vai inteiro para o prompt; ele carrega caminhos, mensagens de erro
   * de job e, no pior caso, um segredo que escapou. O prompt manda não repetir
   * isso, mas instrução a um modelo não é controle — a redação é (§9).
   */
  redigir?: (texto: string) => string;
}

/** Raiz do repo — os arquivos de ajuda das skills ficam ao lado dos prompts. */
const RAIZ_REPO = new URL('../..', import.meta.url).pathname;

/**
 * Devolve a resposta quando o texto é comando de FLUXO; `undefined` quando não
 * é — aí o roteamento normal segue.
 */
function tratarComandoDeFluxo(
  chatId: number, texto: string, deps: DepsMensagem,
): string | undefined {
  if (!deps.fluxos) return undefined;
  const registrados = deps.fluxosRegistrados ?? [];
  const depsFluxo = {
    fluxos: deps.fluxos, registrados, chatId,
    skills: deps.defs.map((d) => d.command),
  };

  const t = texto.trim();
  const [bruto, ...resto] = t.split(/\s+/);
  const verbo = (bruto ?? '').toLowerCase();
  const argumento = resto.join(' ');

  if (verbo === '/fluxos') return textoFluxos(registrados);

  // `/ajuda <nome>` — a ajuda de UM domínio, skill ou fluxo. Sem nome, cai no
  // `/ajuda` geral (a lista de comandos), tratado adiante.
  if ((verbo === '/ajuda' || verbo === '/help') && argumento.trim()) {
    const nome = argumento.trim().toLowerCase().replace(/^\//, '');
    const fluxo = registrados.find((f) => f.command === nome);
    if (fluxo) return ajudaDoFluxo(fluxo, depsFluxo.skills);
    const skill = deps.defs.find((d) => d.command === nome);
    if (skill) return ajudaDaSkill(skill, RAIZ_REPO);
    return `não conheço "${nome}". Veja /skills e /fluxos.`;
  }

  // Quatro nomes para o mesmo ato, porque quatro foram digitados de verdade:
  // quem acabou de gravar os avatares alcança "/pronto" antes de "/aprovar" —
  // o verbo certo é o de quem TERMINOU a própria parte, não o de quem julga o
  // trabalho de outro.
  if (verbo === '/aprovar' || verbo === '/aprovado' || verbo === '/pronto' || verbo === '/ok') {
    const [ref] = resto;
    // Sem referência, o bot ADIVINHA quando não há ambiguidade. Aconteceu de
    // verdade: `/aprovar` sem argumento respondia "diga qual: /aprovar P#16"
    // com UM único fluxo esperando no portão — o bot sabia a resposta e mandava
    // a pessoa procurar o número.
    if (!ref) {
      const esperando = depsFluxo.fluxos.aguardandoAprovacao();
      if (esperando.length === 1) {
        const f = esperando[0]!;
        return aprovarFluxo(`${f.prefixo}#${f.id}`, depsFluxo) ?? '';
      }
      if (!esperando.length) return 'nenhum fluxo esperando aprovação agora.';
      const quais = esperando.map((f) => `${f.prefixo}#${f.id}`).join(' · ');
      return `mais de um fluxo esperando — diga qual: ${quais}`;
    }
    return aprovarFluxo(ref, depsFluxo) ?? `não entendi "${ref}" — use /aprovar A#9`;
  }

  if (verbo === '/status' || verbo === '/refazer' || verbo === '/cancelar') {
    const [ref, alvo] = resto;
    if (!ref) return undefined; // `/status` sozinho é a lista de jobs
    const resposta = verbo === '/status' ? statusFluxo(ref, depsFluxo)
      : verbo === '/refazer' ? refazerFluxo(ref, alvo, depsFluxo)
        : cancelarFluxo(ref, alvo, depsFluxo);
    if (resposta !== undefined) return resposta;
    // `undefined` = não era referência de fluxo. Número É legítimo (`/status 13`
    // é job) e segue adiante. Qualquer outra coisa é referência ERRADA, e dizer
    // isso importa: `/refazer A6 jovens` (sem o `#`) caía calado no tratador de
    // job e morria como comando desconhecido — o `/aprovar` já avisava, estes
    // dois não.
    if (!/^\d+$/.test(ref)) {
      return `não entendi "${ref}" — para fluxo use ${verbo} A#6 [público]; para job, ${verbo} 13.`;
    }
    return undefined;
  }

  const registrado = registrados.find((f) => `/${f.command}` === verbo);
  if (registrado) {
    // `/<fluxo> help` (ou `ajuda`) — antes de tratar como assunto, senão alguém
    // que quer a ajuda dispara um fluxo com o assunto "help".
    if (/^(help|ajuda|\?)$/i.test(argumento.trim())) {
      return ajudaDoFluxo(registrado, depsFluxo.skills);
    }
    return criarFluxo(registrado, argumento, depsFluxo);
  }
  return undefined;
}

/** Jobs deste chat, do mais recente para o mais antigo, com teto — o contexto
 * da resposta não pode crescer com o histórico. Escopado ao chat de propósito:
 * job de outro chat nunca entra na resposta. */
function jobsDoChat(fila: FilaSqlite, chatId: number, limite = 15): Job[] {
  // Teto na CONSULTA, não só no slice: `jobs` nunca é purgado, e sem isto o
  // custo de responder uma pergunta cresce com todo o histórico do bot.
  return fila.listar({ limite: 200 }).filter((j) => j.chat_id === chatId).reverse().slice(0, limite);
}

export async function tratarMensagem(
  chatId: number, texto: string, deps: DepsMensagem,
): Promise<string> {
  // Fluxos entram ANTES do parser de comandos de job: `/status P#16` e
  // `/status 12` são o mesmo verbo com argumentos de tipos diferentes, e quem
  // decide é o formato do argumento.
  const doFluxo = tratarComandoDeFluxo(chatId, texto, deps);
  if (doFluxo !== undefined) return doFluxo;

  const cmd = parseComando(texto, deps.defs, deps.projetosDir);
  const depsCmd = { fila: deps.fila, chatId, agora: deps.agora, defs: deps.defs, perfilPadrao: deps.perfil };

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
