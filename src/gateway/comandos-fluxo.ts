// Comandos de FLUXO. Separado de `comandos.ts` porque aquele arquivo é síncrono
// e sem estado além da fila; aqui há leitura de disco (o `flow.json` do repo de
// domínio) e um runtime.
//
// `/status`, `/refazer` e `/cancelar` são os MESMOS verbos dos jobs — o que
// muda é o argumento: `12` é job, `P#16` é fluxo. Ter dois verbos para a mesma
// pergunta seria atrito puro.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { carregarFlow, congelar, hashDefinicao, parseRef, type FlowDef } from '../dominio/flow.js';
import type { FluxoRegistrado } from '../dominio/registry-fluxos.js';
import type { Fase, Fluxo } from '../fluxos/estado.js';
import type { Fluxos } from '../fluxos/runtime.js';

export interface DepsFluxo {
  fluxos: Fluxos;
  registrados: FluxoRegistrado[];
  chatId: number;
  /** Comandos das skills do catálogo. Uma FASE pode disparar uma skill (a
   * última do promoclub é a mesma `reel` do chat), e a validação do `flow.json`
   * precisa conhecê-las para não recusar o que existe. */
  skills?: string[];
}

const ICONE: Record<Fase['estado'], string> = {
  pendente: '·', rodando: '▶️', feito: '✅', 'aguardando-ok': '⏸️',
  falhou: '❌', pulado: '⏭️',
};

/**
 * `/<fluxo> help` — a ajuda COMPLETA, que mora no repo de domínio.
 *
 * Por que lá e não aqui: o domínio já é dono do `flow.json`, dos públicos e dos
 * prompts. A ajuda é conhecimento do mesmo tipo — mantê-la no bot criaria dois
 * lugares para atualizar quando um público mudasse, e um deles envelheceria
 * calado.
 *
 * Lida do disco A CADA pedido, ao contrário do prompt (que é congelado por
 * fluxo): ajuda não afeta execução nenhuma, e ajuda desatualizada é pior que
 * ajuda que muda.
 *
 * Sem `HELP.md` no domínio, o fallback NÃO é um texto fixo: é a ajuda derivada
 * do próprio `flow.json`. Assim o mínimo nunca mente, mesmo que ninguém tenha
 * escrito nada.
 */
export function ajudaDoFluxo(
  registrado: FluxoRegistrado, skills: string[], ler = lerArquivo,
): string {
  const doDominio = ler(join(registrado.repo, 'HELP.md'));
  if (doDominio?.trim()) return doDominio.trim();

  let def: FlowDef;
  try {
    def = carregarFlow(registrado.repo, skills);
  } catch (e) {
    return `/${registrado.command} — ${registrado.descricao}\n(não consegui ler a definição: ${(e as Error).message})`;
  }

  const alvos = Object.keys(def.alvos);
  const linhas = [
    `/${registrado.command} — ${registrado.descricao}`,
    '',
    `Uso: ${registrado.exemplo}`,
    '',
    'Fases:',
    ...def.fases.map((f, i) => {
      const quem = f.tarefa === 'fluxo-navegador' ? 'bot, navegador'
        : f.tarefa === 'heygen.baixar' ? 'bot, automático'
          : f.kind === 'agent' && !f.prompt_texto && !f.prompt ? `skill ${f.tarefa}` : 'bot';
      const escopo = f.escopo === 'fluxo' ? 'um job para todos' : 'um job por público';
      const pausa = f.pausa_apos ? ' → PARA e espera /aprovar' : '';
      return `  ${i + 1}. ${f.id} (${quem} · ${escopo} · fila ${f.fila})${pausa}`;
    }),
    '',
    `Públicos (${alvos.length}): ${alvos.join(', ')}`,
    '',
    'Campos (com "|" no fim, ou "--" em qualquer lugar):',
    '  | alvos=a,b   só esses públicos (ou --alvo=a --alvo=b)',
    '  | de=<fase>   começa nessa fase (as anteriores ficam puladas)',
    '  | legenda      liga a legenda no reel (padrão: SEM legenda)',
    '  | versao=N    versão do assunto',
    '  | sombra      mostra o plano sem enfileirar nada',
    '',
    `Acompanhar: /status ${def.prefixo}#N · /refazer ${def.prefixo}#N [público] · /cancelar ${def.prefixo}#N`,
  ];
  if (def.fases.some((f) => f.pausa_apos)) {
    linhas.push(`Liberar o portão: /aprovar ${def.prefixo}#N`);
  }
  return linhas.join('\n');
}

/**
 * Resolve as opções DO FLUXO dentro da definição congelada.
 *
 * Por que aqui e não numa coluna nova no banco: a definição já é congelada por
 * fluxo — é exatamente o lugar onde "este fluxo foi criado com estas regras"
 * mora. Um fluxo em andamento não muda de regra no meio (§3.4), e o `/status`
 * continua contando a verdade sem tabela nova.
 *
 * `{legenda}` — default é SEM. Legenda é decisão de quem publica, e forçá-la em
 * todo reel é decidir pelo dono do canal.
 * `{cta}` — o clipe padrão do PRÓPRIO domínio (`<repo>/cta/cta-9x16.mp4`).
 * Cada fluxo tem o seu, editável sem tocar no bot; sem arquivo, o CTA volta a
 * ser desenhado pelo agente.
 */
function resolverOpcoes(def: FlowDef, repo: string, legenda: boolean): FlowDef {
  const clipe = join(repo, 'cta', 'cta-9x16.mp4');
  const temClipe = existsSync(clipe);
  const textoCta = temClipe
    ? `use o clipe pronto ${clipe} — 1080x1920, 3s, com áudio. Concatene-o no FIM, `
      + 'sem re-desenhar CTA nenhum e sem recodificar o resto do reel'
    : 'desenhe o CTA "Saiba mais no inema.club", fixo e legível';
  const textoLegenda = legenda
    ? 'palavra-a-palavra, com a palavra-chave destacada. A CAIXA da legenda encosta '
      + 'na borda INFERIOR do vídeo — cerca de 1 mm acima dela, não no meio da tela '
      + 'nem na altura do peito.'
    : 'NÃO gere legenda neste reel. Sem texto de fala na tela.';
  return {
    ...def,
    fases: def.fases.map((f) => (f.entrega
      ? { ...f, entrega: f.entrega.replace('{cta}', textoCta).replace('{legenda}', textoLegenda) }
      : f)),
  };
}

/** Leitura tolerante: ajuda ausente é o caso NORMAL, não erro. */
function lerArquivo(caminho: string): string | undefined {
  try {
    return readFileSync(caminho, 'utf8');
  } catch {
    return undefined;
  }
}

export function textoFluxos(registrados: FluxoRegistrado[]): string {
  if (!registrados.length) {
    return 'nenhum fluxo registrado ainda. O motor está pronto; falta o repo de domínio.';
  }
  return [
    'Fluxos disponíveis:',
    ...registrados.map((f) => `\n• /${f.command} — ${f.descricao}\n  ex.: ${f.exemplo}`),
    '',
    'Ajuda completa de um fluxo: /<fluxo> help',
  ].join('\n');
}

interface ArgumentoFluxo {
  assunto: string;
  alvos?: string[];
  versao?: number;
  de?: string;
  sombra: boolean;
  /** Legenda no reel. Default NÃO: quem quer, liga na criação. */
  legenda: boolean;
}

/** Nomes de campo que o comando entende. Uma fonte só: a guarda de digitação
 * abaixo casa contra ESTA lista, senão ela envelhece sozinha quando alguém
 * acrescentar um campo. */
const CAMPOS = ['alvos', 'alvo', 'versao', 'versão', 'de', 'legenda'] as const;

/** `--alvo=x`, `--alvos=a,b`, `--sombra`. Repetível, e em qualquer posição. */
const BANDEIRA = new RegExp(String.raw`--(${CAMPOS.join('|')}|sombra)(?:\s*=\s*([^\s|]+))?`, 'gi');

/**
 * Campo escrito SEM o `|` e SEM o `--`, sobrando dentro do assunto.
 *
 * Existe por um defeito real: `/promoavatar <assunto> alvos=mulheres` (sem a
 * barra) não filtrou nada — o `alvos=mulheres` virou TEXTO do assunto, o fluxo
 * nasceu com os 12 públicos, e o agente ainda leu aquilo como ordem e gerou um
 * público só. Três comportamentos errados, nenhum aviso. Recusar é melhor que
 * adivinhar: os dois consertos possíveis (era campo / era assunto mesmo) têm
 * custos muito diferentes.
 */
const CAMPO_SOLTO = new RegExp(String.raw`(^|\s)(${CAMPOS.join('|')})\s*=`, 'i');

/**
 * `/<fluxo> <assunto> [| alvos=a,b] [| versao=N] [| sombra]`
 *
 * Também aceita a forma de bandeira, que é a que se digita sem pensar:
 * `/<fluxo> <assunto> --alvo=mulheres --alvo=40mais`. As duas convivem porque
 * as duas são digitadas — mesma decisão do `casarCampoDeclarado` na gramática
 * de skill, que aceita `| curso x` e `| curso=x`.
 */
function interpretarArgumento(argumento: string): ArgumentoFluxo | { erro: string } {
  let alvos: string[] | undefined;
  let versao: number | undefined;
  let de: string | undefined;
  let sombra = false;
  let legenda = false;
  let erro: string | undefined;

  const acrescentar = (nome: string, bruto: string | undefined): void => {
    const chave = nome.toLowerCase();
    if (chave === 'sombra') { sombra = true; return; }
    const valor = (bruto ?? '').trim().replace(/,+$/, '');
    if (!valor) { erro ??= `"${chave}" precisa de um valor — ex.: --${chave}=mulheres`; return; }
    if (chave === 'alvo' || chave === 'alvos') {
      // `--alvo=a --alvo=b` e `--alvos=a,b` chegam ao mesmo lugar: quem digita
      // não deveria ter que saber qual das duas o parser prefere.
      alvos = [...(alvos ?? []), ...valor.split(',').map((a) => a.trim()).filter(Boolean)];
      return;
    }
    if (chave === 'de') { de = valor; return; }
    if (chave === 'legenda') {
      legenda = !/^(n|não|nao|0|false)/i.test(valor);
      return;
    }
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) { erro ??= `versão inválida: "${valor}"`; return; }
    versao = n;
  };

  // Bandeiras saem do texto ANTES do corte por `|`, para poderem aparecer em
  // qualquer posição sem que o pedaço vire assunto.
  const semBandeiras = argumento.replace(BANDEIRA, (_todo, nome: string, valor?: string) => {
    // `--legenda` sem valor LIGA: bandeira sem valor é "quero isto".
    acrescentar(nome, nome.toLowerCase() === 'legenda' ? (valor ?? 'sim') : valor);
    return ' ';
  });
  if (erro) return { erro };

  const partes = semBandeiras.split('|').map((s) => s.trim());
  const assunto = (partes.shift() ?? '').replace(/\s+/g, ' ').trim();
  if (!assunto) return { erro: 'sem-assunto' };

  for (const bruto of partes.filter(Boolean)) {
    // Pontuação no fim do comando é hábito de quem escreve frase, não erro de
    // uso: `| sombra.` era recusado como campo desconhecido "sombra.". O
    // assunto NÃO passa por aqui (é `partes.shift()`), então a pontuação dele
    // fica intacta — só os campos depois do `|` são aparados.
    const campo = bruto.replace(/[.;,!?]+$/, '').trim();
    if (!campo) continue;
    const m = campo.match(/^(alvos|alvo|versao|versão|de|legenda)\s*=\s*(.+)$/i);
    if (m) {
      acrescentar(m[1], m[2]);
      if (erro) return { erro };
      continue;
    }
    if (campo.toLowerCase() === 'sombra') { sombra = true; continue; }
    if (campo.toLowerCase() === 'legenda') { legenda = true; continue; }
    return { erro: `campo desconhecido: "${campo}" — aceito: alvos=a,b · versao=N · de=<fase> · sombra` };
  }

  const solto = assunto.match(CAMPO_SOLTO);
  if (solto) {
    const nome = solto[2].toLowerCase();
    return {
      erro: `"${nome}=" ficou dentro do assunto — faltou o "|" ou o "--".\n`
        + `Use: /<fluxo> <assunto> | ${nome}=valor   ou   --${nome}=valor\n`
        + 'Sem isso o campo não filtra nada e o fluxo nasce com TODOS os públicos.',
    };
  }

  return { assunto, alvos, versao, de, sombra, legenda };
}

export function criarFluxo(
  registrado: FluxoRegistrado, argumento: string, deps: DepsFluxo,
): string {
  const lido = interpretarArgumento(argumento);
  if ('erro' in lido) return lido.erro === 'sem-assunto'
    ? `faltou o assunto — ex.: ${registrado.exemplo}`
    : lido.erro;
  const { assunto, alvos, versao, de, sombra, legenda } = lido;

  // A definição é lida do disco AQUI e congelada na criação. Um `flow.json`
  // inválido é recusado agora, com o usuário na frente, e não no primeiro job.
  let definicao;
  let hash: string;
  try {
    const doDisco = carregarFlow(registrado.repo, deps.skills ?? []);
    hash = hashDefinicao(doDisco, registrado.repo);
    // Congela AQUI: daqui para frente o fluxo não depende mais do disco do repo
    // de domínio, nem para o texto dos prompts.
    definicao = resolverOpcoes(congelar(doDisco, registrado.repo), registrado.repo, legenda);
  } catch (e) {
    return `não consegui ler a definição do fluxo: ${(e as Error).message}`;
  }

  const pedido = {
    tipo: registrado.command, definicao, hash, assunto, alvos, versao, de,
    chatId: deps.chatId,
  };

  try {
    if (sombra) {
      const plano = deps.fluxos.sombra(pedido);
      return [
        `sombra de /${registrado.command} — ${plano.length} job(s), NADA foi enfileirado:`,
        ...plano.map((p) => `  ${p.fase} · ${p.alvo} · ${p.fila}/${p.tarefa} (${p.kind})`),
      ].join('\n');
    }
    const fluxo = deps.fluxos.criar(pedido);
    const total = Object.keys(definicao.alvos).length;
    const linhas = [
      `criado: ${fluxo.prefixo}#${fluxo.id} (${alvos?.length ?? total} alvo(s))`
      + `${de ? `, começando em "${de}"` : ''} — acompanhe com /status ${fluxo.prefixo}#${fluxo.id}`,
    ];
    // Quando o fluxo começa no meio, quem gera o material FORA precisa saber os
    // títulos exatos — é por eles que o download procura, e errar o nome faz a
    // fase expirar sem achar nada.
    if (de) {
      const usados = alvos ?? Object.keys(definicao.alvos);
      linhas.push('', 'Títulos esperados no estúdio:');
      for (const a of usados) linhas.push(`  ${fluxo.prefixo}${fluxo.id}-${a}-v${fluxo.versao}`);
    }
    return linhas.join('\n');
  } catch (e) {
    return (e as Error).message;
  }
}

/** Tabela fase × alvo do `/status P#16`. */
export function statusFluxo(ref: string, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  // Prefixo errado é recusa, não "acha o mais parecido": `P#16` e `B#16` são
  // fluxos diferentes, e agir no errado seria pior que não agir.
  if (!visao || visao.fluxo.prefixo !== r.prefixo) {
    return `${ref} não existe neste bot.`;
  }

  return tabelaFluxo(visao, true);
}

/**
 * O bloco fase × alvo de UM fluxo.
 *
 * `comandos` liga os atalhos (`/aprovar`, `/refazer`); o painel de vários
 * fluxos desliga, porque repetir "libere com /aprovar C#12" doze vezes é
 * exatamente o ruído que faz ninguém ler o painel. Lá o atalho aparece UMA vez,
 * no rodapé.
 */
export function tabelaFluxo(
  visao: { fluxo: Fluxo; fases: Fase[] },
  comandos: boolean,
): string {
  const { fluxo, fases } = visao;
  const linhas = [
    // O assunto é CORTADO aqui também, não só na lista de cima: o do C#15 tem
    // posição e pergunta para os comentários, e despejá-lo inteiro empurra o
    // estado — que é o que se veio ver — oito linhas para baixo.
    `${fluxo.prefixo}#${fluxo.id} — ${fluxo.tipo}: ${resumoAssunto(fluxo.assunto, 140)}`,
    `status: ${fluxo.status} · versão da definição: ${fluxo.versao_def}`,
  ];
  const porFase = new Map<string, Fase[]>();
  for (const f of fases) {
    const lista = porFase.get(f.fase) ?? [];
    lista.push(f);
    porFase.set(f.fase, lista);
  }
  for (const [fase, lista] of porFase) {
    linhas.push(...linhasDaFase(fase, lista));
  }
  const esperando = fases.filter((f) => f.estado === 'aguardando-ok');
  if (esperando.length) {
    linhas.push('', comandos
      ? `⏸️ esperando você em "${esperando[0]!.fase}" — libere com /aprovar ${fluxo.prefixo}#${fluxo.id}`
      : `⏸️ esperando você em "${esperando[0]!.fase}"`);
  }
  const falhas = fases.filter((f) => f.estado === 'falhou');
  if (falhas.length) {
    linhas.push('', 'Falhas:');
    for (const f of falhas) linhas.push(`  ${f.alvo || '(todos)'}/${f.fase}: ${(f.erro ?? '').slice(0, 200)}`);
    if (comandos) linhas.push(`Retentar: /refazer ${fluxo.prefixo}#${fluxo.id} [alvo]`);
  }
  return linhas.join('\n');
}

/**
 * Acima disto, a fase mostra CONTAGEM em vez de nome por nome.
 *
 * O C#15 tem 36 alvos: `baixar:` e `reel:` viravam duas paredes de `✅ nome ·`
 * que o Telegram quebrava no meio das palavras (`pessoa-` numa linha,
 * `comum-pro` na outra). Ninguém lê 36 nomes de relance — lê "6 de 36".
 *
 * Abaixo do limite a lista continua nome a nome, porque com 2 ou 3 alvos a
 * contagem esconderia QUAIS, e cabe na tela sem virar parede.
 */
const ALVOS_ANTES_DE_CONTAR = 6;

/** Como cada estado aparece na contagem. */
const NOME_ESTADO: Record<Fase['estado'], string> = {
  pendente: 'na fila', rodando: 'rodando', feito: 'feito', 'aguardando-ok': 'esperando você',
  falhou: 'falhou', pulado: 'pulado',
};

/** Estados que EXIGEM o nome do alvo, mesmo no meio de 36: são os dois que
 *  pedem uma decisão sua. O resto é contagem. */
const NOMEAR_SEMPRE: Fase['estado'][] = ['falhou', 'aguardando-ok'];

function linhasDaFase(fase: string, lista: Fase[]): string[] {
  if (lista.length <= ALVOS_ANTES_DE_CONTAR) {
    const alvos = lista.map((f) => `${ICONE[f.estado]} ${f.alvo || '(todos)'}`).join(' · ');
    return [`${fase}: ${alvos}`];
  }

  const porEstado = new Map<Fase['estado'], Fase[]>();
  for (const f of lista) porEstado.set(f.estado, [...(porEstado.get(f.estado) ?? []), f]);

  const feitos = porEstado.get('feito')?.length ?? 0;
  const partes = [`${feitos}/${lista.length} ✅`];
  for (const [estado, fs] of porEstado) {
    if (estado === 'feito') continue;
    // `pendente` não leva ícone: o dele é `·`, o mesmo separador da linha, e
    // "29 · na fila" se lê como duas colunas em vez de uma contagem.
    const icone = estado === 'pendente' ? '' : `${ICONE[estado]} `;
    partes.push(`${fs.length} ${icone}${NOME_ESTADO[estado]}`);
  }
  const linhas = [`${fase}: ${partes.join(' · ')}`];

  // A exceção é nomeada: contar "2 ❌ falhou" sem dizer QUAIS obrigaria a pedir
  // o detalhe de novo só para descobrir onde mexer.
  for (const estado of NOMEAR_SEMPRE) {
    const fs = porEstado.get(estado);
    if (fs?.length) {
      linhas.push(`  ${ICONE[estado]} ${fs.map((f) => f.alvo || '(todos)').join(', ')}`);
    }
  }
  return linhas;
}

/** Quantos fluxos terminados o `/completos` mostra. O resto vira uma linha
 * dizendo quantos ficaram de fora — truncar calado faz o painel mentir. */
const COMPLETOS_NA_LISTA = 10;

/** Assunto encurtado para a lista de uma linha. */
function resumoAssunto(assunto: string, limite = 70): string {
  const limpo = assunto.replace(/\s+/g, ' ').trim();
  return limpo.length <= limite ? limpo : `${limpo.slice(0, limite - 1)}…`;
}

/** A situação de um fluxo em UMA palavra, para a lista de cima. */
function situacao(visao: { fluxo: Fluxo; fases: Fase[] }): string {
  const { fluxo, fases } = visao;
  if (fases.some((f) => f.estado === 'aguardando-ok')) return '⏸️ esperando você';
  if (fluxo.status === 'falhou') return '❌ falhou';
  if (fluxo.status === 'cancelado') return '🚫 cancelado';
  if (fluxo.status === 'feito') return '✅ feito';
  const rodando = fases.find((f) => f.estado === 'rodando');
  if (rodando) return `⏳ rodando "${rodando.fase}"`;
  return '⏳ na fila';
}

/**
 * `/status` sem argumento — o painel dos fluxos ABERTOS.
 *
 * Duas camadas de propósito: primeiro a lista de uma linha por fluxo (o número
 * e a situação, que é o que se olha de relance), depois o detalhe fase × alvo
 * de cada um. Os atalhos ficam UMA vez no rodapé, não repetidos por fluxo.
 *
 * `cancelado` não é aberto nem completo — não entra em lista nenhuma. Quem
 * cancelou sabe que cancelou.
 */
export function painelFluxos(deps: DepsFluxo): string {
  const abertos = [
    ...deps.fluxos.listarFluxos('rodando'),
    ...deps.fluxos.listarFluxos('falhou'),
  ].sort((a, b) => a.id - b.id);

  if (!abertos.length) {
    return 'Nenhum fluxo aberto. Terminados: /completos · fila de jobs: /jobs';
  }

  const visoes = abertos
    .map((f) => deps.fluxos.status(f.id))
    .filter((v): v is { fluxo: Fluxo; fases: Fase[] } => v !== undefined);

  const linhas = [`Fluxos abertos (${visoes.length}):`];
  for (const v of visoes) {
    linhas.push(`  ${v.fluxo.prefixo}#${v.fluxo.id} · ${situacao(v)} — ${resumoAssunto(v.fluxo.assunto)}`);
  }
  for (const v of visoes) {
    linhas.push('', tabelaFluxo(v, false));
  }
  // O ref do rodapé é o REAL, nunca um número de exemplo: `C#12` cravado no
  // código mandava agir num fluxo que podia nem estar aberto (visto em
  // produção com o C#15 na tela e o rodapé pedindo C#12). Com um fluxo só, o
  // atalho é dele — dá para copiar e colar. Com vários, `<ref>`, porque eleger
  // um seria escolher pelo leitor.
  const ref = visoes.length === 1
    ? `${visoes[0]!.fluxo.prefixo}#${visoes[0]!.fluxo.id}`
    : '<ref>';
  linhas.push(
    '',
    `Detalhe de um: /status ${ref} · liberar: /aprovar ${ref} · retentar: /refazer ${ref}`,
    'Terminados: /completos · fila de jobs: /jobs',
  );
  return linhas.join('\n');
}

/** `/completos` — os fluxos que terminaram, do mais novo para o mais velho. */
export function fluxosCompletos(deps: DepsFluxo): string {
  const feitos = deps.fluxos.listarFluxos('feito').sort((a, b) => b.id - a.id);
  if (!feitos.length) return 'Nenhum fluxo completo ainda. Abertos: /status';

  const mostrar = feitos.slice(0, COMPLETOS_NA_LISTA);
  const linhas = [`Fluxos completos (${feitos.length}):`];
  for (const f of mostrar) {
    linhas.push(`  ${f.prefixo}#${f.id} · ${f.tipo} — ${resumoAssunto(f.assunto)}`);
  }
  if (feitos.length > mostrar.length) {
    linhas.push(`  … e mais ${feitos.length - mostrar.length} mais antigo(s), fora desta lista.`);
  }
  linhas.push('', `Detalhe de um: /status ${mostrar[0]!.prefixo}#${mostrar[0]!.id} · abertos: /status`);
  return linhas.join('\n');
}

/** `/aprovar P#16` — solta o portão humano. */
export function aprovarFluxo(ref: string, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  const { liberados, fase } = deps.fluxos.aprovar(r.id);
  // "Não está esperando" é verdade e não ajuda: quem digitou quer saber se
  // precisa fazer algo. Aconteceu de verdade — depois de um `/refazer`, o
  // fluxo já estava trabalhando e a pessoa insistiu no `/aprovar` achando que
  // faltava liberar, até criar um fluxo novo por engano.
  if (!liberados) return `${ref} não está esperando aprovação.\n${oQueEstaFazendo(visao)}`;
  return `${ref}: ${fase} aprovada — ${liberados} job(s) enfileirado(s).`;
}

export function refazerFluxo(ref: string, alvo: string | undefined, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  const { refeitos, itens } = deps.fluxos.refazer(r.id, alvo);
  if (!refeitos) return `nada a refazer em ${ref}${alvo ? ` (alvo ${alvo})` : ''} — nenhuma fase falhou.`;
  // Dizer O QUE voltou e que NÃO precisa aprovar. Antes era só a contagem, e o
  // silêncio dos minutos seguintes fazia parecer que o comando não pegou — a
  // pessoa mandava `/aprovar`, não acontecia nada, e ela criava um fluxo novo.
  return [
    `${ref}: ${refeitos} fase(s) de volta na fila.`,
    ...itens.map((i) => `  ▶️ ${i.fase}${i.alvo ? ` (${i.alvo})` : ''} — job ${i.jobId}`),
    'Não precisa aprovar: o portão já foi passado. Eu aviso quando terminar.',
  ].join('\n');
}

export function cancelarFluxo(ref: string, alvo: string | undefined, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  const { cancelados } = deps.fluxos.cancelar(r.id, alvo);
  return [
    `${ref}${alvo ? ` (alvo ${alvo})` : ''} cancelado — ${cancelados} job(s) interrompido(s).`,
    // §3.7: operação externa já criada NÃO é desfeita. Dizer isso é parte do
    // contrato de cancelamento, não gentileza.
    'O que já tiver sido criado fora (render no estúdio, arquivo entregue) continua lá.',
  ].join('\n');
}

/**
 * Uma linha dizendo o que o fluxo está fazendo AGORA. Serve às respostas que
 * antes só negavam ("não está esperando aprovação"): quem digitou precisa saber
 * se falta uma ação dele ou se é só esperar.
 */
function oQueEstaFazendo(visao: { fluxo: { status: string }; fases: Fase[] }): string {
  const rodando = visao.fases.filter((f) => f.estado === 'rodando');
  if (rodando.length) {
    const quais = rodando.map((f) => `${f.fase}${f.alvo ? ` (${f.alvo})` : ''}`).join(', ');
    return `Está trabalhando: ${quais}. Só esperar — eu aviso quando terminar.`;
  }
  const pendentes = visao.fases.filter((f) => f.estado === 'pendente').length;
  if (pendentes) return `${pendentes} fase(s) na fila esperando a vez. Só esperar.`;
  if (visao.fluxo.status === 'feito') return 'Já terminou.';
  if (visao.fluxo.status === 'falhou') return 'Terminou com falha — veja /status para retentar.';
  return `Status: ${visao.fluxo.status}.`;
}
