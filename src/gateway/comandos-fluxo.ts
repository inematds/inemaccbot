// Comandos de FLUXO. Separado de `comandos.ts` porque aquele arquivo é síncrono
// e sem estado além da fila; aqui há leitura de disco (o `flow.json` do repo de
// domínio) e um runtime.
//
// `/status`, `/refazer` e `/cancelar` são os MESMOS verbos dos jobs — o que
// muda é o argumento: `12` é job, `P#16` é fluxo. Ter dois verbos para a mesma
// pergunta seria atrito puro.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { carregarFlow, congelar, hashDefinicao, parseRef, type FlowDef } from '../dominio/flow.js';
import type { FluxoRegistrado } from '../dominio/registry-fluxos.js';
import type { Fase } from '../fluxos/estado.js';
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
}

/** Nomes de campo que o comando entende. Uma fonte só: a guarda de digitação
 * abaixo casa contra ESTA lista, senão ela envelhece sozinha quando alguém
 * acrescentar um campo. */
const CAMPOS = ['alvos', 'alvo', 'versao', 'versão', 'de'] as const;

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
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) { erro ??= `versão inválida: "${valor}"`; return; }
    versao = n;
  };

  // Bandeiras saem do texto ANTES do corte por `|`, para poderem aparecer em
  // qualquer posição sem que o pedaço vire assunto.
  const semBandeiras = argumento.replace(BANDEIRA, (_todo, nome: string, valor?: string) => {
    acrescentar(nome, valor);
    return ' ';
  });
  if (erro) return { erro };

  const partes = semBandeiras.split('|').map((s) => s.trim());
  const assunto = (partes.shift() ?? '').replace(/\s+/g, ' ').trim();
  if (!assunto) return { erro: 'sem-assunto' };

  for (const campo of partes.filter(Boolean)) {
    const m = campo.match(/^(alvos|alvo|versao|versão|de)\s*=\s*(.+)$/i);
    if (m) {
      acrescentar(m[1], m[2]);
      if (erro) return { erro };
      continue;
    }
    if (campo.toLowerCase() === 'sombra') { sombra = true; continue; }
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

  return { assunto, alvos, versao, de, sombra };
}

export function criarFluxo(
  registrado: FluxoRegistrado, argumento: string, deps: DepsFluxo,
): string {
  const lido = interpretarArgumento(argumento);
  if ('erro' in lido) return lido.erro === 'sem-assunto'
    ? `faltou o assunto — ex.: ${registrado.exemplo}`
    : lido.erro;
  const { assunto, alvos, versao, de, sombra } = lido;

  // A definição é lida do disco AQUI e congelada na criação. Um `flow.json`
  // inválido é recusado agora, com o usuário na frente, e não no primeiro job.
  let definicao;
  let hash: string;
  try {
    const doDisco = carregarFlow(registrado.repo, deps.skills ?? []);
    hash = hashDefinicao(doDisco, registrado.repo);
    // Congela AQUI: daqui para frente o fluxo não depende mais do disco do repo
    // de domínio, nem para o texto dos prompts.
    definicao = congelar(doDisco, registrado.repo);
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

  const { fluxo, fases } = visao;
  const linhas = [
    `${fluxo.prefixo}#${fluxo.id} — ${fluxo.tipo}: ${fluxo.assunto}`,
    `status: ${fluxo.status} · versão da definição: ${fluxo.versao_def}`,
  ];
  const porFase = new Map<string, Fase[]>();
  for (const f of fases) {
    const lista = porFase.get(f.fase) ?? [];
    lista.push(f);
    porFase.set(f.fase, lista);
  }
  for (const [fase, lista] of porFase) {
    const alvos = lista
      .map((f) => `${ICONE[f.estado]} ${f.alvo || '(todos)'}`)
      .join(' · ');
    linhas.push(`${fase}: ${alvos}`);
  }
  const esperando = fases.filter((f) => f.estado === 'aguardando-ok');
  if (esperando.length) {
    linhas.push('', `⏸️ esperando você em "${esperando[0]!.fase}" — libere com /aprovar ${fluxo.prefixo}#${fluxo.id}`);
  }
  const falhas = fases.filter((f) => f.estado === 'falhou');
  if (falhas.length) {
    linhas.push('', 'Falhas:');
    for (const f of falhas) linhas.push(`  ${f.alvo || '(todos)'}/${f.fase}: ${(f.erro ?? '').slice(0, 200)}`);
    linhas.push(`Retentar: /refazer ${fluxo.prefixo}#${fluxo.id} [alvo]`);
  }
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
