// Comandos de FLUXO. Separado de `comandos.ts` porque aquele arquivo é síncrono
// e sem estado além da fila; aqui há leitura de disco (o `flow.json` do repo de
// domínio) e um runtime.
//
// `/status`, `/refazer` e `/cancelar` são os MESMOS verbos dos jobs — o que
// muda é o argumento: `12` é job, `P#16` é fluxo. Ter dois verbos para a mesma
// pergunta seria atrito puro.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  aplicarVariante, carregarFlow, congelar, hashDefinicao, parseRef, variantesDe,
  type FlowDef,
} from '../dominio/flow.js';
import type { FluxoRegistrado } from '../dominio/registry-fluxos.js';
import type { Fase, Fluxo } from '../fluxos/estado.js';
import type { Fluxos } from '../fluxos/runtime.js';
import { comCapa } from '../fluxos/capa.js';
import { pastaTextos } from '../fluxos/entrada-fase.js';

export interface DepsFluxo {
  fluxos: Fluxos;
  registrados: FluxoRegistrado[];
  chatId: number;
  /** Comandos das skills do catálogo. Uma FASE pode disparar uma skill (a
   * última do promoavatar é a mesma `reel` do chat), e a validação do `flow.json`
   * precisa conhecê-las para não recusar o que existe. */
  skills?: string[];
  /**
   * Jobs de SKILL vivos (sem fluxo). O painel é de fluxos, mas quem manda um
   * `analisevideo:` e digita `/status` está perguntando "o que o bot está
   * fazendo" — e via um painel que não mencionava o trabalho em curso. O rodapé
   * já apontava `/jobs`; uma linha aqui evita a viagem.
   */
  jobsSoltos?: () => { id: number; tarefa: string; status: string }[];
  /**
   * O progresso DENTRO de uma fase em curso (`23/47 shots`), quando o domínio
   * o declara.
   *
   * Uma fase de uma hora aparecia como `▶️ rodando` do começo ao fim: não dava
   * para saber se tinha avançado 2 ou 40 shots, nem se estava viva. O contrato
   * é o mesmo do recibo — o domínio IMPRIME `progresso: 23/47 shots` e o bot lê
   * a última linha dessas do log da fase. Domínio que não imprime não mostra
   * nada, e nada quebra.
   */
  progressoDe?: (fluxo: Fluxo, fase: Fase) => string | undefined;
}

/** O estado do FLUXO inteiro, em um caractere. `rodando` e `falhou` são os dois
 *  que precisam se separar de relance no painel; os outros vêm junto para a
 *  linha não ficar sem ícone e desalinhar a pilha. */
const ICONE_FLUXO: Record<string, string> = {
  rodando: '▶️', falhou: '❌', feito: '✅', cancelado: '🚫', pausado: '⏸️',
};

const ICONE: Record<Fase['estado'], string> = {
  pendente: '·', rodando: '▶️', feito: '✅', 'aguardando-ok': '⏸️',
  falhou: '❌', pulado: '⏭️',
};

/** Nome de seção comparável: sem acento, minúsculo. Quem digita `| prompt=` no
 *  chat não vai acertar "VARIANTES DE TEXTO" — acerta "variantes". */
function chaveSecao(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * A ajuda do domínio em DUAS CAMADAS.
 *
 * O `HELP.md` do promoavatar3 tem ~150 linhas: numa mensagem só, o Telegram
 * entrega uma parede que ninguém lê até o fim, e o que a pessoa veio buscar
 * (como se chama o comando) fica no meio. Então o arquivo vira cartão + seções:
 * tudo antes do primeiro `## ` é o cartão, cada `## NOME` é uma seção pedível
 * com `/<fluxo> help <nome>`.
 *
 * Arquivo SEM `## ` nenhum volta inteiro — é o caso do promoavatar, e não faz
 * sentido obrigar um domínio a se reorganizar para continuar respondendo.
 */
function recortarAjuda(texto: string, comando: string, pedida?: string): string {
  const linhas = texto.split('\n');
  const inicios = linhas
    .map((l, i) => ({ i, m: /^##\s+(.+?)\s*$/.exec(l) }))
    .filter((x) => x.m) as { i: number; m: RegExpExecArray }[];
  if (!inicios.length) return texto;

  const secoes = inicios.map((x, k) => {
    const bloco = linhas.slice(x.i, k + 1 < inicios.length ? inicios[k + 1]!.i : linhas.length);
    // O `##` é marcação de arquivo, não de chat: o bot manda texto puro e o
    // Telegram mostraria os dois cerquilhas na cara do título.
    bloco[0] = x.m[1];
    return { titulo: x.m[1], corpo: bloco.join('\n').trimEnd() };
  });
  const menu = secoes.map((s) => chaveSecao(s.titulo).split(/\s+/)[0]).join(' · ');

  if (pedida) {
    const alvo = chaveSecao(pedida);
    const achada = secoes.find((s) => chaveSecao(s.titulo) === alvo)
      ?? secoes.find((s) => chaveSecao(s.titulo).startsWith(alvo))
      ?? secoes.find((s) => chaveSecao(s.titulo).includes(alvo));
    if (achada) return `${achada.corpo}\n\nVoltar: /${comando} help`;
    return `não achei a seção "${pedida}" na ajuda do /${comando}.\nTem: ${menu}`;
  }

  const cartao = linhas.slice(0, inicios[0]!.i).join('\n').trimEnd();
  return `${cartao}\n\nMais: /${comando} help <seção>\n  ${menu}`;
}

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
  registrado: FluxoRegistrado, skills: string[], secao?: string, ler = lerArquivo,
): string {
  const doDominio = ler(join(registrado.repo, 'HELP.md'));
  if (doDominio?.trim()) return recortarAjuda(doDominio.trim(), registrado.command, secao);

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
        : f.tarefa === 'heygen.gerar' ? 'bot, API'
        : f.tarefa === 'heygen.baixar' ? 'bot, automático'
          : f.kind === 'agent' && !f.prompt_texto && !f.prompt ? `skill ${f.tarefa}` : 'bot';
      const escopo = f.escopo === 'fluxo' ? 'um job para todos' : 'um job por público';
      const pausa = f.pausa_apos ? ' → PARA e espera /aprovar' : '';
      const so = f.opcional ? ` · SÓ com | ${f.opcional}` : '';
      return `  ${i + 1}. ${f.id} (${quem} · ${escopo} · fila ${f.fila}${so})${pausa}`;
    }),
    '',
    `Públicos (${alvos.length}): ${alvos.join(', ')}`,
    '',
    'Campos (com "|" no fim, ou "--" em qualquer lugar):',
    '  | alvos=a,b   só esses públicos (ou --alvo=a --alvo=b)',
    '  | de=<fase>   começa nessa fase (as anteriores ficam puladas)',
    // Condicional pelo mesmo critério das linhas abaixo: só aparece onde faz
    // algo. São os dois caminhos por onde a decisão chega ao render — a fase de
    // reel como FUNÇÃO (vira `--sem-legenda`) ou o `{legenda}` no `entrega` de
    // uma fase de agente. Sem nenhum dos dois o campo é aceito pelo parser e não
    // muda nada, e anunciá-lo é ajuda que mente.
    ...(def.fases.some((f) => f.tarefa === 'reel.montar' || f.entrega?.includes('{legenda}'))
      ? ['  | legenda=nao desliga a legenda do reel (padrão: COM, palavra a palavra)'] : []),
    '  | versao=N    versão do assunto',
    '  | sombra      mostra o plano sem enfileirar nada',
    // Derivada do `variantes` das fases: um domínio sem variante não vê a linha,
    // e renomear uma variante no flow.json reescreve o help sozinho.
    // Separadas por " ou ", NÃO por "|": o "|" é o separador de CAMPOS, e quem
    // copiasse `prompt=promocao|viral` do help mandaria um campo "viral" que não
    // existe. A linha de ajuda tem que ser colável.
    ...(variantesDe(def).length
      ? [`  | prompt=<variante>  escreve o texto com outra estratégia — `
        + `${variantesDe(def).join(' ou ')} (padrão: o prompt normal)`] : []),
    ...(def.fases.some((f) => f.opcional === 'api')
      ? ['  | api        o BOT gera (carteira em US$)'] : []),
    ...(def.fases.some((f) => f.opcional === 'creditos')
      ? ['  | creditos   o BOT gera (créditos da assinatura)'] : []),
    ...(def.fases.some((f) => f.opcional === 'navega')
      ? ['  | navega     o BOT gera no estúdio pelo AGENTE, clonando o template (créditos)'] : []),
    ...(def.fases.some((f) => f.opcional === 'estudio')
      ? ['  | estudio    o BOT gera no estúdio por SCRIPT, clonando o template (créditos)'] : []),
    ...(def.fases.some((f) => f.pausa_apos)
      ? ['  | sem-portao  não para para você aprovar'] : []),
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
 * `{legenda}` — default é COM, desde 2026-08-07, decidido pelo dono do canal
 * ao desenhar `promoavatar/docs/legenda.md`. Vale para promoavatar e
 * promoavatar3. Desliga com `| legenda=nao`.
 *
 * O que mudou em relação à regra anterior (2026-08-03, default SEM): naquela
 * data o `montar-reel.py` NÃO legendava, então a única legenda possível era a
 * queimada no estúdio, e ligar a nossa por cima daria legenda dupla. Agora o
 * pipeline legenda: palavra a palavra, caixa alta, acento na palavra-chave.
 * A troca de default é a decisão de parar de legendar no ESTÚDIO — a legenda
 * do estúdio continua vindo queimada no avatar (o download prefere
 * `video_url_caption` quando existe, ver `fila/tarefas/heygen.ts`) e continua
 * sem remoção possível. Ligar as duas ainda dá legenda dupla; agora quem
 * escolhe a do estúdio é que precisa dizer `| legenda=nao`.
 *
 * (Este default já foi invertido por engano antes, em 2026-08-03. Desta vez a
 * inversão é a decisão explícita do dono do canal, com o motor pronto e
 * verificado do outro lado. Não desinverta sem falar com ele.)
 * `{cta}` — o clipe padrão do PRÓPRIO domínio (`<repo>/cta/cta-9x16.mp4`).
 * Cada fluxo tem o seu, editável sem tocar no bot; sem arquivo, o CTA volta a
 * ser desenhado pelo agente.
 *
 * `api` — a fase de avatar é feita pela API em vez de uma pessoa no estúdio.
 * DESLIGADA, a fase `gerar` é REMOVIDA da definição congelada, e não apenas
 * marcada como pulada: um fluxo normal tem que ficar idêntico ao de antes desta
 * opção existir — mesmo `/status`, mesmo `| sombra`, sem uma linha a mais
 * dizendo "gerar: pulado" para explicar algo que não vai acontecer.
 *
 * `semPortao` — tira o `pausa_apos` de todas as fases. Default NÃO: o portão é
 * onde discordar de um roteiro custa um texto em vez de um render, e com a API
 * ele fica MAIS barato de manter, não menos (um texto ruim que passa direto
 * vira dinheiro gasto).
 */
interface OpcoesDoFluxo {
  legenda: boolean;
  /** Ligada, mantém no fluxo as fases marcadas `opcional: "api"` no
   *  `flow.json`. Quem REMOVE as não pedidas é o runtime (`definicaoEfetiva`),
   *  para que import e teste passem pelo mesmo ponto. */
  api: boolean;
  semPortao: boolean;
}

function resolverOpcoes(def: FlowDef, repo: string, opcoes: OpcoesDoFluxo): FlowDef {
  const { legenda, semPortao } = opcoes;
  const clipe = join(repo, 'cta', 'cta-9x16.mp4');
  const temClipe = existsSync(clipe);
  const textoCta = temClipe
    ? `use o clipe pronto ${clipe} — 1080x1920, 3s, com áudio. Concatene-o no FIM, `
      + 'sem re-desenhar CTA nenhum e sem recodificar o resto do reel'
    : 'desenhe o CTA "Saiba mais no inema.club", fixo e legível';
  // A descrição segue `promoavatar/docs/legenda.md` — se ela mudar lá, muda
  // aqui. (Esta prosa só alcança fase `kind: agent`; onde o reel é função,
  // quem manda é o `montar-reel.py`, que já tem o mesmo desenho no código.)
  const textoLegenda = legenda
    ? 'UMA palavra por vez, em caixa alta, sem fundo: branca com contorno preto '
      + 'grosso, e âmbar só na palavra-chave. Fica colada na BASE da faixa do '
      + 'avatar, não no terço inferior do quadro (lá é o painel de texto).'
    : 'NÃO gere legenda neste reel. Sem texto de fala na tela.';
  const fases = def.fases
    .map((f) => (f.entrega
      ? { ...f, entrega: f.entrega.replace('{cta}', textoCta).replace('{legenda}', textoLegenda) }
      : f))
    // `pausa_apos` sai da definição inteira, não só da fase de texto: se um dia
    // um domínio tiver dois portões, "sem portão" tem que valer para os dois.
    .map((f) => {
      if (!semPortao || !f.pausa_apos) return f;
      // O campo é REMOVIDO, não posto em `false`: a definição congelada é lida
      // por gente (`/status`, diff de fluxo) e um `pausa_apos: false` gravado
      // parece portão desligado por engano, em vez de fluxo pedido sem portão.
      const { pausa_apos: _, ...semPausa } = f;
      return semPausa;
    });
  // A recusa que existia aqui caiu em 2026-08-07: o `montar-reel.py` PASSOU a
  // legendar (ver `promoavatar/docs/legenda.md`). Enquanto ele não legendava,
  // aceitar a opção em silêncio seria mentir; agora recusá-la é que seria.
  // A decisão VIAJA na definição congelada, e não só como prosa dentro de
  // `entrega`: a fase de reel é função (`reel.montar`), não lê prompt nenhum,
  // e era aí que a opção se perdia. Gravada só quando DESLIGADA, pelo mesmo
  // motivo do `pausa_apos` acima — o normal fica igual ao de sempre.
  return { ...def, fases, ...(legenda ? {} : { legenda: false }) };
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
  /** A fase de avatar é feita pela API, não por uma pessoa no estúdio.
   *  Default NÃO — sem isto o fluxo é exatamente o de hoje. */
  api: boolean;
  /** A fase de avatar é feita pela CLI (OAuth), debitando dos CRÉDITOS da
   *  assinatura em vez da carteira em dólar. Exclusiva com `api`. */
  creditos: boolean;
  /** A fase de avatar é feita pelo BOT no NAVEGADOR, clonando um template do
   *  estúdio (`Edit as New`). Também sai dos créditos da assinatura, mas pelo
   *  estúdio e não pela CLI. Exclusiva com `api` e `creditos`. */
  navega: boolean;
  /** A fase de avatar é feita pelo BOT no estúdio, por um SCRIPT de navegador
   *  (Playwright), não por um agente. Mesmo efeito e mesma cobrança do
   *  `navega` — clona o template, herda cenário/avatar/voz/motor —, e o
   *  `navega` fica de pé ao lado como caminho de volta se o DOM mudar. */
  estudio: boolean;
  /** Tira o portão humano. Default NÃO: o fluxo continua parando. */
  semPortao: boolean;
  /** Variante de prompt pedida (`| prompt=viral`). Quais existem é o domínio
   *  que diz, no `variantes` da fase — aqui só chega o nome digitado. */
  prompt?: string;
}

/** Nomes de campo que o comando entende. Uma fonte só: a guarda de digitação
 * abaixo casa contra ESTA lista, senão ela envelhece sozinha quando alguém
 * acrescentar um campo. */
const CAMPOS = [
  'alvos', 'alvo', 'versao', 'versão', 'de', 'legenda', 'prompt',
  'api', 'creditos', 'créditos', 'navega', 'estudio', 'estúdio',
  'sem-portao', 'sem-portão',
] as const;

/** Campos que são BANDEIRA: existir já é ligar, valor é opcional. */
const BANDEIRAS = new Set([
  'legenda', 'api', 'creditos', 'créditos', 'navega', 'estudio', 'estúdio',
  'sem-portao', 'sem-portão',
]);

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
  let prompt: string | undefined;
  let sombra = false;
  let legenda = true;  // default LIGADA desde 2026-08-07 — ver `resolverOpcoes`
  let api = false;
  let creditos = false;
  let navega = false;
  let estudio = false;
  let semPortao = false;
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
    // Qual variante existe é o `flow.json` que diz — validar aqui obrigaria o
    // parser a conhecer o domínio, e ele nem leu o disco ainda. Só normaliza.
    if (chave === 'prompt') { prompt = valor.toLowerCase(); return; }
    // As três bandeiras aceitam `=nao` para desligar explicitamente — quem
    // escreve `| api=nao` está dizendo o que quer, não errando.
    const ligado = !/^(n|não|nao|0|false)/i.test(valor);
    if (chave === 'legenda') { legenda = ligado; return; }
    if (chave === 'api') { api = ligado; return; }
    if (chave === 'creditos' || chave === 'créditos') { creditos = ligado; return; }
    if (chave === 'navega') { navega = ligado; return; }
    if (chave === 'estudio' || chave === 'estúdio') { estudio = ligado; return; }
    if (chave === 'sem-portao' || chave === 'sem-portão') { semPortao = ligado; return; }
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) { erro ??= `versão inválida: "${valor}"`; return; }
    versao = n;
  };

  // Bandeiras saem do texto ANTES do corte por `|`, para poderem aparecer em
  // qualquer posição sem que o pedaço vire assunto.
  const semBandeiras = argumento.replace(BANDEIRA, (_todo, nome: string, valor?: string) => {
    // `--legenda`/`--api` sem valor LIGAM: bandeira sem valor é "quero isto".
    acrescentar(nome, BANDEIRAS.has(nome.toLowerCase()) ? (valor ?? 'sim') : valor);
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
    // `est[uú]dio` faltava aqui: estava em CAMPOS e em BANDEIRAS, mas sem esta
    // alternação `| estudio=nao` caía como campo desconhecido. Toda flag nova
    // precisa entrar nos TRÊS lugares.
    const m = campo.match(/^(alvos|alvo|versao|versão|de|legenda|prompt|api|cr[eé]ditos|navega|est[uú]dio|sem-porta[oõ])\s*=\s*(.+)$/i);
    if (m) {
      acrescentar(m[1], m[2]);
      if (erro) return { erro };
      continue;
    }
    if (campo.toLowerCase() === 'sombra') { sombra = true; continue; }
    if (BANDEIRAS.has(campo.toLowerCase())) { acrescentar(campo, 'sim'); continue; }
    return {
      erro: `campo desconhecido: "${campo}" — aceito: alvos=a,b · versao=N · de=<fase>`
        + ' · prompt=<variante> · legenda · api · creditos · navega · estudio'
        + ' · sem-portao · sombra',
    };
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

  // Duas rotas juntas gerariam o MESMO vídeo duas vezes — uma cobrando da
  // carteira em dólar, as outras dos créditos. Escolher por conta própria qual
  // vale seria decidir onde gastar o dinheiro de alguém. A checagem é por
  // CONTAGEM, e não `api && creditos`: com três rotas, o par a par envelhece
  // sozinho na próxima que entrar.
  const rotas = [
    ['api', api, 'carteira em US$'],
    ['creditos', creditos, 'créditos da assinatura, pela CLI'],
    ['navega', navega, 'créditos da assinatura, pelo estúdio no navegador'],
    ['estudio', estudio, 'créditos da assinatura, pelo estúdio por script'],
  ] as const;
  const pedidas = rotas.filter(([, ligada]) => ligada);
  if (pedidas.length > 1) {
    return {
      erro: 'peça só UMA rota de avatar — '
        + rotas.map(([nome, , onde]) => `"| ${nome}" (${onde})`).join(', ')
        + `. Você pediu ${pedidas.map(([nome]) => `"| ${nome}"`).join(' e ')}, `
        + 'e juntas gerariam o mesmo vídeo mais de uma vez.',
    };
  }

  return {
    assunto, alvos, versao, de, sombra, legenda, api, creditos, navega, estudio, semPortao,
    ...(prompt ? { prompt } : {}),
  };
}

export function criarFluxo(
  registrado: FluxoRegistrado, argumento: string, deps: DepsFluxo,
): string {
  // COPIAR E COLAR A MENSAGEM ANTERIOR é o jeito mais natural de repetir um
  // pedido — e traz o `/comando` junto. Sem isto ele vira a primeira palavra do
  // ASSUNTO: no MVD#90 o texto que foi para o planejador começava com
  // "/musicavideo Para a música...", e o domínio planejou uma música sobre isso.
  // Tirar o eco é seguro porque o comando já foi consumido pelo roteamento; o
  // que sobra aqui é assunto por definição.
  const lido = interpretarArgumento(
    argumento.replace(new RegExp(`^\\s*/${registrado.command}\\b\\s*`, 'i'), ''),
  );
  if ('erro' in lido) return lido.erro === 'sem-assunto'
    ? `faltou o assunto — ex.: ${registrado.exemplo}`
    : lido.erro;
  const {
    assunto, alvos, versao, de, sombra, legenda, api, creditos, navega, estudio, semPortao,
    prompt: variante,
  } = lido;

  // A definição é lida do disco AQUI e congelada na criação. Um `flow.json`
  // inválido é recusado agora, com o usuário na frente, e não no primeiro job.
  let definicao;
  let hash: string;
  try {
    // A variante troca o CAMINHO do prompt antes do hash e do congelamento —
    // é o que faz o texto congelado e o hash serem os da variante pedida. Se a
    // troca viesse depois de `congelar`, o `prompt_texto` seria o do padrão e a
    // flag não mudaria nada, em silêncio.
    const doDisco = variante
      ? aplicarVariante(carregarFlow(registrado.repo, deps.skills ?? []), variante)
      : carregarFlow(registrado.repo, deps.skills ?? []);
    hash = hashDefinicao(doDisco, registrado.repo);
    // Congela AQUI: daqui para frente o fluxo não depende mais do disco do repo
    // de domínio, nem para o texto dos prompts.
    definicao = resolverOpcoes(
      congelar(doDisco, registrado.repo), registrado.repo, { legenda, api, semPortao },
    );
  } catch (e) {
    const msg = (e as Error).message;
    // Variante errada é erro de QUEM DIGITOU, não definição ilegível: embrulhá-lo
    // em "não consegui ler a definição" mandaria a pessoa procurar defeito no
    // flow.json quando o conserto é trocar uma palavra no comando.
    if (/^(variante desconhecida|este fluxo não declara)/.test(msg)) return msg;
    return `não consegui ler a definição do fluxo: ${msg}`;
  }

  const pedido = {
    tipo: registrado.command, definicao, hash, assunto, alvos, versao, de,
    chatId: deps.chatId,
    // A chave é o NOME da opção no `flow.json` (`opcional: "estudio"`): quem
    // filtra é `definicaoEfetiva`, comparando por essa string.
    opcoes: { api, creditos, navega, estudio, semPortao },
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
      + `${variante ? `, variante "${variante}"` : ''}`
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

/**
 * `/<fluxo> status` — a situação do ÚLTIMO fluxo daquele domínio.
 *
 * Existe pelo mesmo motivo que `/<fluxo> help` existe (ver o roteamento em
 * `mensagem.ts`): a palavra depois do comando é o ASSUNTO, então quem digitava
 * `/musicavideo status` querendo ver as fases criava um fluxo novo com o
 * assunto "status" — e ele rodou, gastou uma fase e falhou (MVD#88, 2026-08-21).
 * Perguntar pelo andamento é a coisa mais natural de se digitar; virar comando
 * é mais barato que ensinar todo mundo a escrever `/status MVD#87`.
 *
 * O ÚLTIMO, e não uma lista: com um domínio na mão, a pergunta é sobre o que
 * acabou de ser mandado. Para os outros, o painel (`/status`) continua lá.
 */
export function statusDoDominio(registrado: FluxoRegistrado, deps: DepsFluxo): string {
  const meus = deps.fluxos.listarFluxos()
    .filter((f) => f.tipo === registrado.command)
    .sort((a, b) => b.id - a.id);
  if (!meus.length) {
    return `nenhum fluxo de /${registrado.command} ainda. Comece com: ${registrado.exemplo}`;
  }
  const ultimo = meus[0]!;
  const texto = statusFluxo(`${ultimo.prefixo}#${ultimo.id}`, deps) ?? '';
  return meus.length > 1
    ? `${texto}\n\nOutros ${meus.length - 1} de /${registrado.command}: /status`
    : texto;
}

/** Tabela fase × alvo do `/status P#16`. */
export function statusFluxo(ref: string, deps: DepsFluxo): string | undefined {
  // NÚMERO PURO (`/status 90`): historicamente era job, e o comentário do
  // roteamento diz isso. Só que o painel logo acima lista `MVD#90`, e digitar
  // o número que se acabou de ler é o reflexo — a resposta vinha sobre um job
  // antigo de mesmo id, e parecia que "o /status não mostra as fases".
  //
  // Se existe fluxo com aquele id, ele ganha: é o que estava na tela. O job
  // continua alcançável por `/jobs`, e a resposta diz isso quando há os dois.
  if (/^\d+$/.test(ref)) {
    const id = Number(ref);
    const fluxo = deps.fluxos.listarFluxos().find((f) => f.id === id);
    if (!fluxo) return undefined;      // segue para o tratador de job, como antes
    const visao = deps.fluxos.status(id);
    if (!visao) return undefined;
    return `${tabelaFluxo(visao, true, deps.progressoDe)}\n\n`
      + `(era o job ${id} que você queria? /jobs ${id})`;
  }
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  // Prefixo errado é recusa, não "acha o mais parecido": `P#16` e `B#16` são
  // fluxos diferentes, e agir no errado seria pior que não agir.
  if (!visao || visao.fluxo.prefixo !== r.prefixo) {
    return `${ref} não existe neste bot.`;
  }

  return tabelaFluxo(visao, true, deps.progressoDe);
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
  progressoDe?: (fluxo: Fluxo, fase: Fase) => string | undefined,
): string {
  const { fluxo, fases } = visao;
  // Três linhas curtas em vez de duas longas: o celular quebra por volta de 40
  // colunas, e `C#15 — promoavatar3: KIMI K3 mal saiu…` com o assunto junto
  // voltava em quatro. O assunto ganha linha própria e é CORTADO — o do C#15
  // tem posição e pergunta para os comentários, e despejá-lo inteiro empurrava
  // o estado (o que se veio ver) para o fim da mensagem.
  const linhas = [
    `${fluxo.prefixo}#${fluxo.id} — ${fluxo.tipo}`,
    `  ${resumoAssunto(fluxo.assunto, LARGURA_CHAT - 2)}`,
    // O status do FLUXO com ícone, e o ícone primeiro: com três fluxos na tela,
    // "status: falhou" e "status: rodando" só se distinguem lendo a palavra —
    // e a pilha de fases logo abaixo tem ícones que puxam o olho antes. Sem
    // isto não dá para saber, de relance, se o que está ali está andando ou
    // parado (reclamação do dono em 2026-08-22).
    `${ICONE_FLUXO[fluxo.status] ?? '·'} ${fluxo.status} · def v${fluxo.versao_def}`,
  ];
  const porFase = new Map<string, Fase[]>();
  for (const f of fases) {
    const lista = porFase.get(f.fase) ?? [];
    lista.push(f);
    porFase.set(f.fase, lista);
  }
  const largura = Math.max(LARGURA_FASE, ...[...porFase.keys()].map((f) => f.length));
  // O NÚMERO DO PASSO na frente de cada fase. Sem ele a pilha diz o que
  // aconteceu, mas não ONDE o fluxo está: "capa-clipe ❌" não conta que isso é
  // o passo 3 de 4, nem que sobrou um. O total aparece pelo próprio último
  // número, e por isso ele não precisa se repetir em toda linha.
  const nomes = [...porFase.keys()];
  for (const [i, fase] of nomes.entries()) {
    linhas.push(...linhasDaFase(fase, porFase.get(fase)!, comandos, largura, fluxo.status,
      (f) => progressoDe?.(fluxo, f), `${i + 1}/${nomes.length}`));
  }
  // A legenda NÃO entra aqui. Ela entrava uma vez por fluxo, e com três fluxos
  // na tela viravam três legendas idênticas separando o que se quer comparar —
  // exatamente o ruído que ela existia para evitar. Agora sai uma só, no fim do
  // painel inteiro (`painelFluxos`).
  const esperando = fases.filter((f) => f.estado === 'aguardando-ok');
  if (esperando.length) {
    linhas.push('', comandos
      ? `⏸️ esperando você em "${esperando[0]!.fase}" — libere com /aprovar ${fluxo.prefixo}#${fluxo.id}`
      : `⏸️ esperando você em "${esperando[0]!.fase}"`);
  }
  // A lista de falhas é do DETALHE (`/status C#61`). No painel de vários fluxos
  // ela não entra: 25 falhas empurrariam os outros fluxos para fora da tela, e
  // a contagem por fase (`estudio: 8 ❌ falhou`) já diz que há o que olhar.
  const falhas = fases.filter((f) => f.estado === 'falhou');
  if (falhas.length && comandos) {
    linhas.push('', ...linhasDeFalhas(falhas));
    linhas.push(`Retentar: /refazer ${fluxo.prefixo}#${fluxo.id} [alvo]`);
  }
  return linhas.join('\n');
}

/**
 * A mensagem de erro SEM o que se repete em todas as linhas.
 *
 * O erro chega assim: `heygen.estudio: C61-jovens-alc-v1 — 0 cards com o nome
 * exato "TEMPLATE-AVATAR"`. Numa lista de 21, o nome da tarefa e o título do
 * estúdio ocupam metade da largura do celular em toda linha e não distinguem
 * nada — o que distingue vem depois do travessão. Some os dois, e o que sobra é
 * a causa, que é o que se agrupa.
 */
export function causaDaFalha(erro: string | null, alvo: string): string {
  let m = (erro ?? '').replace(/\s+/g, ' ').trim();
  if (!m) return '(sem mensagem)';
  // `heygen.estudio: `, `reel.montar: ` — nome da tarefa, igual na fase inteira.
  m = m.replace(/^[a-z][\w.-]*\.[a-z][\w-]*:\s*/i, '');
  // `C61-jovens-alc-v1 — ` — o título do estúdio, que já contém o alvo.
  const alvoEscapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  m = m.replace(new RegExp(`^\\w*-?${alvoEscapado}-v\\d+\\s*[—-]\\s*`, 'i'), '');
  m = m.replace(/^[A-Z]\d+-[\w-]+-v\d+\s*[—-]\s*/, '');
  // O RABO QUE APONTA PARA ARQUIVO INTERNO. Duas formas, as duas do próprio
  // bot: `— alvo /home/.../capa-clipe.txt` e `— saída do agente em
  // ~/.../4652-t2.log`. Servem ao log; no painel ocupam metade da linha e
  // empurram a causa de verdade para fora do corte.
  m = m.replace(/\s*[—-]\s*alvo\s+\S+$/i, '');
  m = m.replace(/\s*[—-]\s*sa[íi]da do agente em\s+\S+$/i, '');
  // Sobra de corte: um travessão ou vírgula pendurados no fim são o cadáver do
  // trecho que acabou de sair, e leem-se como frase interrompida.
  return m.replace(/[\s—,;:-]+$/, '');
}

/** Teto do texto da causa. Acima disto o Telegram quebra a linha e a lista
 *  deixa de ser varrível; o log tem a mensagem inteira. */
const CAUSA_MAX = 90;

/** Teto da causa NO PAINEL, onde ela divide espaço com outros fluxos: uma linha
 *  no celular, com a reticência avisando que há mais no `/status <ref>`. */
const CAUSA_NO_PAINEL = 58;

/**
 * As falhas agrupadas: por fase, e dentro dela por CAUSA.
 *
 * Vinte e cinco falhas com três causas distintas são três problemas, não vinte
 * e cinco — e é assim que se conserta. Todos os alvos são nomeados, sem teto:
 * aqui o usuário pediu o detalhe explicitamente, e cortar seria esconder
 * justamente o que ele veio ver.
 */
function linhasDeFalhas(falhas: Fase[]): string[] {
  const porFase = new Map<string, Fase[]>();
  for (const f of falhas) porFase.set(f.fase, [...(porFase.get(f.fase) ?? []), f]);

  const linhas = [`Falhas (${falhas.length}):`];
  for (const [fase, lista] of porFase) {
    linhas.push(`${fase} (${lista.length}):`);
    const porCausa = new Map<string, string[]>();
    for (const f of lista) {
      const causa = causaDaFalha(f.erro, f.alvo || '').slice(0, CAUSA_MAX);
      porCausa.set(causa, [...(porCausa.get(causa) ?? []), f.alvo || '(todos)']);
    }
    // Causa que atinge mais alvos primeiro: é a que paga mais por ser resolvida.
    const ordenadas = [...porCausa.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [causa, alvos] of ordenadas) {
      linhas.push(`  ${causa} (${alvos.length})`);
      linhas.push(`    ${alvos.join(', ')}`);
    }
  }
  return linhas;
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

/** Largura útil do chat no celular — a mesma régua do `/ajuda`. Linha maior
 *  que isto o Telegram quebra no meio da palavra, e o painel deixa de ser
 *  varrível com o olho. */
const LARGURA_CHAT = 42;

/** Como cada estado aparece na contagem. */
const NOME_ESTADO: Record<Fase['estado'], string> = {
  pendente: 'na fila', rodando: 'rodando', feito: 'feito', 'aguardando-ok': 'esperando você',
  falhou: 'falhou', pulado: 'pulado',
};

/** Estados que EXIGEM o nome do alvo, mesmo no meio de 36.
 *
 * `aguardando-ok` pede decisão sua. `rodando` entrou em 2026-08-12: com 35/36
 * prontos e 1 rodando, "1 ▶️ rodando" não diz QUAL — e é exatamente a que se
 * quer olhar, porque o fluxo está vivo, não há falha para nomear e o `/refazer`
 * (com razão) responde "nada a refazer".
 *
 * `falhou` SAIU em 2026-08-13: as falhas passaram a ter seção própria no
 * detalhe (`linhasDeFalhas`), agrupada por causa e com todos os alvos. Nomeá-las
 * aqui também duplicaria a informação no detalhe e encheria o painel — onde o
 * pedido é o oposto, só a contagem.
 *
 * `pendente` continua de fora de propósito: 35 na fila viram a parede de nomes
 * que a contagem existe para evitar. */
const NOMEAR_SEMPRE: Fase['estado'][] = ['aguardando-ok', 'rodando'];

/** Teto de nomes por estado. Sem ele, 20 jobs em paralelo na fila `io` sairiam
 *  numa linha só, quebrada no meio da palavra pelo Telegram — a parede de volta
 *  por outra porta. O excedente vira `+N`, nunca some calado. */
const NOMES_NA_LINHA = 6;

/**
 * Contagem com dois algarismos (`01/36`, `07/36`).
 *
 * Sem isso `1/36` e `36/36` começam em colunas diferentes e a pilha de fases
 * deixa de ser varrível de cima a baixo — que é a única coisa que o painel
 * precisa fazer bem. Acima de 99 o número cresce: cortar seria mentir.
 */
function n2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Largura MÍNIMA do nome da fase na pilha, para os números começarem juntos. A
 *  fonte do Telegram é proporcional, então isto aproxima — não alinha ao pixel.
 *  Fase com nome mais longo (`capa-clipe`) manda: alinhar pelo maior é o que
 *  mantém a coluna, e fixar em 8 fazia justamente essa linha sair do prumo. */
const LARGURA_FASE = 8;

function linhasDaFase(
  fase: string, lista: Fase[], detalhe: boolean, largura = LARGURA_FASE, statusFluxo = '',
  progresso?: (f: Fase) => string | undefined, passo = '',
): string[] {
  const rotulo = `${passo ? `${passo} ` : ''}${fase.padEnd(largura)}`;
  // `pulado` significa duas coisas MUITO diferentes, e o mesmo ⏭️ contava as
  // duas: "não entrou neste fluxo" (fase opcional, `| de=`) e "não chegou a
  // rodar porque uma fase anterior quebrou". Num fluxo falhado, o segundo caso
  // é o que importa — e ⏭️ lido como "pulei de propósito" faz o painel parecer
  // mais saudável do que está.
  const icone = (f: Fase): string => {
    if (f.estado === 'pulado' && statusFluxo === 'falhou') return '⛔';
    // `pendente` tem ícone PRÓPRIO no painel (⏳): o dele é `·`, o mesmo
    // separador da linha, e sozinho não significa nada. No detalhe a palavra
    // vem junto e o `·` volta a servir.
    if (!detalhe && f.estado === 'pendente') return '⏳';
    return ICONE[f.estado];
  };
  if (lista.length <= ALVOS_ANTES_DE_CONTAR && detalhe) {
    const alvos = lista.map((f) => `${icone(f)} ${f.alvo || '(todos)'}`).join(' · ');
    return [`${rotulo} ${alvos}`];
  }

  // FLUXO DE UM ALVO SÓ: contagem é ruído. `capa-clipe 00/01 · 01 ❌` faz o
  // leitor decodificar dois números para descobrir o que um ícone já diz, e o
  // que ele veio buscar — POR QUE falhou — não está em lugar nenhum da tela.
  // Com um alvo, a linha vira o estado e, na falha, a CAUSA.
  if (lista.length === 1) {
    const f = lista[0]!;
    const nome = f.estado === 'pulado' && statusFluxo === 'falhou' ? 'bloqueada' : NOME_ESTADO[f.estado];
    // Progresso em curso E em falha. Excluir a falhada foi erro meu: "o ponto
    // onde parou já vem na causa" não é verdade — a causa diz "o render não
    // terminou em 180 min" e não diz que 11 dos 47 clipes ficaram prontos, que
    // é o número de que se precisa para decidir se vale retomar.
    // Fase FEITA não mostra: ali o número seria o total repetido.
    const quanto = f.estado === 'rodando' || f.estado === 'falhou' ? progresso?.(f) : undefined;
    const linha = `${rotulo} ${icone(f)}${detalhe ? ` ${nome}` : ''}${quanto ? ` ${quanto}` : ''}`;
    if (f.estado !== 'falhou' || !f.erro) return [linha];
    // No PAINEL a causa é uma linha só: o teto de 90 do detalhe quebra em duas
    // no celular e desalinha a pilha. Cortada, ganha reticência — some no meio
    // é o que faz alguém achar que a mensagem acabou ali.
    const bruta = causaDaFalha(f.erro, f.alvo || '');
    const teto = detalhe ? CAUSA_MAX : CAUSA_NO_PAINEL;
    const causa = bruta.length > teto ? `${bruta.slice(0, teto - 1).trimEnd()}…` : bruta;
    return [linha, `  ↳ ${causa}`];
  }

  const porEstado = new Map<Fase['estado'], Fase[]>();
  for (const f of lista) porEstado.set(f.estado, [...(porEstado.get(f.estado) ?? []), f]);

  const feitos = porEstado.get('feito')?.length ?? 0;
  // O ✅ SÓ quando a fase fechou. Ele vinha colado na contagem sempre, e
  // `capa-clipe 00/01 ✅ · 01 ❌` dizia visto-e-erro na mesma linha: quem varre
  // o painel lê o verde primeiro e conclui que aquilo está pronto. Incompleto
  // mostra só os números — o que já foi, e o que está acontecendo agora.
  const completa = feitos === lista.length && feitos > 0;
  const partes = [`${n2(feitos)}/${n2(lista.length)}${completa ? ' ✅' : ''}`];
  for (const [estado, fs] of porEstado) {
    if (estado === 'feito') continue;
    // No painel a palavra do estado sai: ela se repete em toda fase de todo
    // fluxo e o ícone já a carrega — a legenda no rodapé diz o que cada um é.
    // No detalhe ela fica, porque ali não há repetição para cansar.
    // `pendente` tem ícone PRÓPRIO no painel: o dele é `·`, o mesmo separador
    // da linha, e sem a palavra ao lado "29 ·" deixa de significar coisa
    // alguma. No detalhe a palavra volta e o `·` original serve.
    const icone = !detalhe && estado === 'pendente' ? '⏳' : (
      estado === 'pulado' && statusFluxo === 'falhou' ? '⛔' : ICONE[estado]);
    partes.push(detalhe
      ? `${n2(fs.length)} ${icone} ${NOME_ESTADO[estado]}`
      : `${n2(fs.length)} ${icone}`);
  }
  const linhas = [`${rotulo} ${partes.join(' · ')}`];

  // Os nomes são do DETALHE. No painel de vários fluxos eles são a parede que a
  // contagem existe para evitar: com 36 alvos, `rodando` e `esperando você`
  // sozinhos empurravam o fluxo seguinte para fora da tela.
  if (!detalhe) return linhas;
  for (const estado of NOMEAR_SEMPRE) {
    const fs = porEstado.get(estado);
    if (fs?.length) {
      const nomes = fs.slice(0, NOMES_NA_LINHA).map((f) => f.alvo || '(todos)');
      const sobra = fs.length - nomes.length;
      linhas.push(`  ${ICONE[estado]} ${nomes.join(', ')}${sobra ? ` +${sobra}` : ''}`);
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

  const soltos = deps.jobsSoltos?.() ?? [];
  const linhaSoltos = (): string[] => {
    if (!soltos.length) return [];
    const rodando = soltos.filter((j) => j.status === 'running');
    const fila = soltos.filter((j) => j.status !== 'running');
    // O NOME da skill, não só a contagem: "⏳ 2 na fila" não diz se o que espera
    // é a análise que você acabou de mandar ou outra coisa. Acima de três, a
    // contagem volta — a parede é o defeito que o painel existe para evitar.
    const nomes = fila.slice(0, 3).map((j) => j.tarefa);
    const sobra = fila.length - nomes.length;
    const partes = [
      ...rodando.map((j) => `▶️ ${j.tarefa} #${j.id}`),
      ...(fila.length ? [`⏳ ${nomes.join(', ')}${sobra ? ` +${sobra}` : ''}`] : []),
    ];
    return ['', `Skills: ${partes.join(' · ')}`];
  };

  if (!abertos.length) {
    return [
      'Nenhum fluxo aberto.',
      ...linhaSoltos().filter(Boolean),
      'Terminados: /completos · fila de jobs: /jobs',
    ].join('\n');
  }

  const visoes = abertos
    .map((f) => deps.fluxos.status(f.id))
    .filter((v): v is { fluxo: Fluxo; fases: Fase[] } => v !== undefined);

  const linhas = [`Fluxos abertos (${visoes.length}):`];
  for (const v of visoes) {
    linhas.push(`  ${v.fluxo.prefixo}#${v.fluxo.id} · ${situacao(v)} — ${resumoAssunto(v.fluxo.assunto)}`);
  }
  for (const v of visoes) {
    linhas.push('', tabelaFluxo(v, false, deps.progressoDe));
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
    ...linhaSoltos(),
    '',
    // UMA legenda para o painel todo, aqui embaixo: com três fluxos na tela ela
    // aparecia três vezes, separando justamente o que se quer comparar de
    // relance. Cabe na régua de 42 — é a linha mais larga do painel.
    '✅ feito · ▶️ rodando · ⏸️ você · ⏳ fila · ❌ erro · ⛔ bloqueada',
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

/**
 * `/dados <ref>` — reentrega o que o fluxo já produziu.
 *
 * Complementa o `/status`, que responde "em que pé está" e nunca "me dá o que
 * saiu". Não regera nada: relê o que cada fase feita declarou em
 * `portao.mostrar`.
 */
export function dadosDoFluxo(ref: string, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref) ?? (/^\d+$/.test(ref) ? { id: Number(ref), prefixo: '' } : null);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || (r.prefixo && visao.fluxo.prefixo !== r.prefixo)) return `${ref} não existe neste bot.`;

  const { fases, semDeclaracao } = deps.fluxos.reentregar(r.id);
  if (!fases.length && !semDeclaracao.length) {
    return `${ref} ainda não terminou nenhuma fase — nada a entregar.`;
  }
  const linhas = fases.length
    ? [`${ref}: reentregando ${fases.length} fase(s) — ${fases.join(', ')}.`]
    : [`${ref}: nenhuma fase declara o que entrega.`];
  // Fase feita e MUDA é falta de `portao.mostrar` no flow.json do domínio, não
  // ausência de material: dizer isso poupa a caçada na pasta de saída.
  if (semDeclaracao.length) {
    linhas.push(
      `Sem declaração de entrega (o domínio não diz o que mostrar): ${semDeclaracao.join(', ')}.`,
    );
  }
  return linhas.join('\n');
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

/**
 * `capa: A#22 jovens` + a imagem anexada — troca a imagem de um segmento pela
 * que a pessoa mandou no chat.
 *
 * Existe porque quem revisa está no Telegram. As imagens são decididas na fase
 * de texto (seção `## IMAGENS`, regra 11b do prompt) e o caminho anterior era
 * "edite o .md e acrescente `arquivo:`" — instrução que só funciona para quem
 * tem terminal. Aqui o bot escreve a linha.
 *
 * `alvo` aceita `*` para valer em TODOS os públicos do fluxo: com 12 públicos,
 * repetir o comando doze vezes é o mesmo tipo de trabalho manual que este
 * comando existe para eliminar.
 *
 * IO injetável para o teste não tocar disco.
 */
/**
 * `capa: A#25 jovens 2 cover | arquivo=/x.png` → as partes.
 *
 * Separado do roteador para ser testável sem fluxo, disco nem chat. O
 * `arquivo=` chega de dois jeitos: montado pelo `gateway/midia.ts` quando a
 * pessoa manda a FOTO com a legenda, ou digitado por quem já tem o caminho.
 */
export function parseCapa(texto: string): {
  ref?: string; alvo?: string; n: number; arquivo?: string; modo?: 'cover';
} {
  const [cabeca, ...campos] = String(texto ?? '').split('|').map((x) => x.trim());
  const partes = (cabeca ?? '').replace(/^\/?capa:?/i, '').trim().split(/\s+/).filter(Boolean);
  const [ref, alvo, ...opcoes] = partes;
  const campoArquivo = campos.find((c) => /^arquivo\s*=/.test(c));
  const arquivo = campoArquivo?.split('=').slice(1).join('=').trim() || undefined;
  // `n` é o número da imagem no roteiro visual (1 = a capa do feed); `cover`
  // pede o enquadramento que CORTA. O default é `contain`: imagem enviada pelo
  // dono não é cortada sem ele pedir — ela já vem composta.
  const n = Number(opcoes.find((o) => /^\d+$/.test(o)) ?? 1);
  const modo = opcoes.some((o) => o.toLowerCase() === 'cover') ? 'cover' as const : undefined;
  return { ref, alvo, n, arquivo, ...(modo ? { modo } : {}) };
}

export function definirCapaFluxo(
  ref: string,
  alvo: string | undefined,
  pedido: { n: number; arquivo: string; modo?: 'contain' | 'cover' },
  deps: DepsFluxo & {
    ler?: (caminho: string) => string | null;
    gravar?: (caminho: string, texto: string) => void;
  },
): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  if (!alvo) return `diga o público: \`capa: ${ref} <publico>\` (ou \`*\` para todos).`;

  const registrado = deps.registrados.find((x) => x.command === visao.fluxo.tipo);
  if (!registrado?.repo) {
    return `${ref} não tem repo de domínio registrado — não sei onde ficam os textos.`;
  }
  const pasta = pastaTextos(registrado.repo, visao.fluxo);

  const ler = deps.ler ?? ((c: string) => (existsSync(c) ? readFileSync(c, 'utf8') : null));
  const gravar = deps.gravar ?? ((c: string, t: string) => writeFileSync(c, t, 'utf8'));

  const todos = [...new Set(visao.fases.map((f) => f.alvo).filter((a): a is string => Boolean(a)))];
  const alvos = alvo === '*' ? todos : [alvo];
  if (!alvos.length) return `${ref} não tem públicos.`;

  const ok: string[] = [];
  const erros: string[] = [];
  for (const a of alvos) {
    const caminho = `${pasta}/${a}.md`;
    const md = ler(caminho);
    if (md === null) { erros.push(`${a}: não achei ${caminho}`); continue; }
    const res = comCapa(md, pedido);
    if (!res.ok) { erros.push(`${a}: ${res.erro}`); continue; }
    gravar(caminho, res.texto);
    ok.push(`${a}${res.segmento ? ` — entra em "${res.segmento}"` : ''}`
      + (res.substituiu ? ' (substituiu a anterior)' : ''));
  }

  const linhas = [
    ok.length
      ? `🖼️ IMAGEM ${pedido.n} de ${ref} definida em ${ok.length} público(s)`
        + `${pedido.modo === 'cover' ? ' (cover — preenche cortando)' : ''}:`
      : `nada mudou em ${ref}.`,
    ...ok.map((l) => `  ✅ ${l}`),
    ...erros.map((l) => `  ❌ ${l}`),
  ];
  // O aviso importa: depois que o reel roda, mexer no texto não muda o vídeo —
  // e a pessoa ficaria esperando um efeito que não vem.
  const reelFeito = visao.fases.some((f) => f.fase === 'reel' && f.estado === 'feito');
  if (ok.length && reelFeito) {
    linhas.push('⚠️ o reel deste fluxo já foi montado — use /refazer para valer.');
  }
  return linhas.join('\n');
}
