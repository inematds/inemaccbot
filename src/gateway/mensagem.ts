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
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Fluxos } from '../fluxos/runtime.js';
import { humano } from '../dominio/espaco.js';
import { planejarLimpeza } from '../dominio/limpeza.js';
import { ajudaDaSkill } from './ajuda-dominio.js';
import { AJUDA_COMPLETA, executar, parseComando } from './comandos.js';
import {
  ajudaDoFluxo, aprovarFluxo, cancelarFluxo, criarFluxo, definirCapaFluxo, fluxosCompletos,
  dadosDoFluxo, painelFluxos, parseCapa, refazerFluxo, statusDoDominio, statusFluxo, textoFluxos,
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
  /** Áreas de disco que o `/espaco` mede. Vazio = o comando diz que não sabe. */
  areas?: { rotulo: string; caminho: string; doBot: boolean }[];
  /** Raízes que o `/limpar` pode tocar. Sem elas o comando não apaga nada. */
  raizArtefatos?: string;
  publicoDir?: string;
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
    // Jobs de skill vivos: sem fluxo, eles não apareciam em lugar nenhum do
    // painel — e quem digita `/status` está perguntando o que o bot está
    // fazendo, não "quais fluxos existem".
    // O progresso que o DOMÍNIO declara no log da fase (`progresso: 23/47
    // shots`). O caminho do log é o mesmo que o `cli.rodar` monta; sem arquivo
    // ou sem a linha, não mostra nada.
    progressoDe: (fluxo: { prefixo: string; id: number }, fase: { fase: string; alvo: string }) => {
      const base = join(
        deps.raizArtefatos ?? '', 'fluxos', `${fluxo.prefixo}${fluxo.id}`,
        `${fase.fase}${fase.alvo ? `-${fase.alvo}` : ''}.txt.log`,
      );
      return ultimoProgresso(base);
    },
    jobsSoltos: () => [
      ...deps.fila.listar({ status: 'running' }),
      ...deps.fila.listar({ status: 'queued' }),
    ]
      .filter((j) => !j.flow_ref)
      .map((j) => ({ id: j.id, tarefa: j.tarefa, status: j.status })),
  };

  const t = texto.trim();
  const [bruto, ...resto] = t.split(/\s+/);
  const verbo = (bruto ?? '').toLowerCase();
  const argumento = resto.join(' ');

  if (verbo === '/fluxos') return textoFluxos(registrados);

  // `capa: A#25 jovens` COM a foto anexada — o último elo da corrente.
  //
  // O anexo já vinha sendo baixado (`gateway/midia.ts` monta
  // `capa: <ref> <alvo> | arquivo=<caminho>`) e o núcleo que escreve no `.md` já
  // existia com testes; faltava exatamente isto, e por isso mandar a foto no
  // chat não fazia nada. O momento natural de usar é o PORTÃO da fase de texto:
  // ali nenhum avatar foi gerado e nenhuma imagem foi paga, então trocar a capa
  // ainda é de graça.
  if (verbo === 'capa:' || verbo === 'capa' || verbo === '/capa') {
    const { ref, alvo, n, arquivo, modo } = parseCapa(t);
    if (!ref) return 'use: `capa: A#25 <publico>` COM a imagem anexada (ou `*` para todos).';
    if (!arquivo) {
      return 'não veio imagem. Mande a FOTO com a legenda `capa: '
        + `${ref}${alvo ? ` ${alvo}` : ' <publico>'}\` — ou passe \`| arquivo=/caminho\`.`;
    }
    return definirCapaFluxo(ref, alvo, { n, arquivo, ...(modo ? { modo } : {}) }, depsFluxo)
      ?? `não entendi "${ref}" — use \`capa: A#25 <publico>\`.`;
  }

  // `/ajuda <nome>` — a ajuda de UM domínio, skill ou fluxo. Sem nome, cai no
  // `/ajuda` geral (a lista de comandos), tratado adiante.
  if ((verbo === '/ajuda' || verbo === '/help') && argumento.trim()
      && !AJUDA_COMPLETA.has(argumento.trim().toLowerCase())) {
    // `/ajuda <fluxo> [seção]`: o que vem depois do nome é a seção, para as duas
    // formas responderem igual (`/ajuda promoavatar3 variantes`).
    const [primeiro = '', ...resto] = argumento.trim().split(/\s+/);
    const nome = primeiro.toLowerCase().replace(/^\//, '');
    const fluxo = registrados.find((f) => f.command === nome);
    if (fluxo) return ajudaDoFluxo(fluxo, depsFluxo.skills, resto.join(' ') || undefined);
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

  if (verbo === '/limpar') {
    return limpar(resto, deps, depsFluxo.fluxos);
  }

  if (verbo === '/completos') {
    return fluxosCompletos(depsFluxo);
  }

  // `/dados <ref>` — o material que o fluxo já produziu, de volta no chat. O
  // `/status` diz em que pé está; este diz o que saiu.
  if (verbo === '/dados' || verbo === '/entregar') {
    const [ref] = resto;
    if (!ref) return `qual fluxo? ex.: ${verbo} A#9`;
    return dadosDoFluxo(ref, depsFluxo) ?? `não entendi "${ref}" — use ${verbo} A#9`;
  }

  if (verbo === '/status' || verbo === '/refazer' || verbo === '/cancelar') {
    const [ref, alvo] = resto;
    // `/status` sozinho é o painel dos FLUXOS. Era a lista de jobs, e mudou de
    // dono porque a pergunta que se faz no chat é "quais assuntos estão em pé e
    // o que cada um espera de mim" — job solto é detalhe de máquina. A lista de
    // jobs não sumiu: `/jobs` é o mesmo comando de antes, e o rodapé do painel
    // aponta para ela.
    if (!ref) return verbo === '/status' ? painelFluxos(depsFluxo) : undefined;
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
    // `/<fluxo> help [seção]` — a seção é opcional e vem depois da palavra.
    const pedido = /^(?:help|ajuda|\?)(?:\s+(.+))?$/i.exec(argumento.trim());
    if (pedido) {
      return ajudaDoFluxo(registrado, depsFluxo.skills, pedido[1]?.trim());
    }
    // `/<fluxo> status` — a mesma armadilha da ajuda, e ela mordeu: quem digitou
    // `/musicavideo status` criou um fluxo com o assunto "status" (MVD#88).
    if (/^(?:status|situa[cç][aã]o|andamento)$/i.test(argumento.trim())) {
      return statusDoDominio(registrado, depsFluxo);
    }
    return criarFluxo(registrado, argumento, depsFluxo);
  }
  return undefined;
}

/**
 * `/limpar <escopo> [dias] [confirmar]`.
 *
 * DRY-RUN por padrão, e isso não é zelo: os escopos chegam a mais de 1 GB, e
 * apagar não tem volta. Sem a palavra `confirmar`, só mostra.
 */
function limpar(
  resto: string[], deps: DepsMensagem, fluxos: Fluxos,
): string {
  const args = resto.map((a) => a.toLowerCase());
  const confirmar = args.includes('confirmar');
  const escopo = resto.find((a) => a.toLowerCase() !== 'confirmar');
  const dias = resto.map(Number).find((n) => Number.isInteger(n) && n >= 0);

  if (!escopo) {
    const tipos = [...new Set(fluxos.listarTipos())];
    return `o que limpar? /limpar A#8 · ${tipos.join(' · ') || '<fluxo>'} · artefatos [dias] · tudo`
      + '\nSem "confirmar" eu só mostro o que sairia.';
  }

  const plano = planejarLimpeza({
    escopo,
    ...(dias !== undefined ? { dias } : {}),
    jobs: deps.fila.listar({ limite: 5000 }),
    fluxos: fluxos.listarResumo(),
    raizArtefatos: deps.raizArtefatos ?? '',
    publicoDir: deps.publicoDir ?? '',
    agoraMs: deps.agora() * 1000,
  });
  if (plano.erro) return plano.erro;
  if (!plano.itens.length) return `nada a limpar em "${escopo}".`;

  const total = plano.itens.reduce((n, i) => n + i.bytes, 0);
  const cabeca = plano.itens.slice(0, 12).map((i) => `  ${humano(i.bytes)}  ${i.motivo}`);
  const resto12 = plano.itens.length > 12 ? [`  … e mais ${plano.itens.length - 12}`] : [];

  if (!confirmar) {
    return [
      `${escopo}: ${plano.itens.length} item(ns), ${humano(total)}`,
      ...cabeca, ...resto12, '',
      `Para apagar: /limpar ${escopo}${dias !== undefined ? ` ${dias}` : ''} confirmar`,
    ].join('\n');
  }

  let apagados = 0;
  let libertos = 0;
  const falhas: string[] = [];
  for (const i of plano.itens) {
    try {
      rmSync(i.caminho, { recursive: true, force: true });
      apagados += 1;
      libertos += i.bytes;
    } catch (e) {
      falhas.push(`${i.caminho}: ${(e as Error).message}`);
    }
  }
  return [
    `${escopo}: ${apagados} item(ns) apagado(s), ${humano(libertos)} liberados.`,
    ...(falhas.length ? ['', `não consegui apagar ${falhas.length}:`, ...falhas.slice(0, 3)] : []),
  ].join('\n');
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
  const depsCmd = {
    fila: deps.fila, chatId, agora: deps.agora, defs: deps.defs,
    perfilPadrao: deps.perfil, ...(deps.areas ? { areas: deps.areas } : {}),
  };

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

/**
 * A última linha `progresso: <o que for>` de um log de fase.
 *
 * Contrato mínimo de propósito: o domínio escolhe a unidade (shots, imagens,
 * páginas) e o bot só repete. Tentar interpretar o número obrigaria o bot a
 * conhecer o domínio, que é o acoplamento que este sistema passa o dia
 * evitando.
 */
function ultimoProgresso(caminho: string): string | undefined {
  let texto: string;
  try {
    texto = readFileSync(caminho, 'utf8');
  } catch {
    return undefined;
  }
  let achado: string | undefined;
  for (const linha of texto.split('\n')) {
    const m = /^\s*progresso:\s*(.+?)\s*$/i.exec(linha);
    if (m) achado = m[1];
  }
  // Uma linha de progresso pode ser longa; o painel tem régua de ~42.
  return achado?.slice(0, 32);
}
