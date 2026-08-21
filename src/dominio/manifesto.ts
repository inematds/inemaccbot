// Validador do MANIFESTO DE INTEGRAÇÃO — o arquivo que descreve como plugar um
// repo externo no bot.
//
// Existe para separar duas coisas que hoje andam juntas e não deveriam:
//
//   GERAR o manifesto  exige ler o repo e julgar (fila, timeout, o prompt e as
//                      armadilhas do script). Precisa de um modelo, roda UMA vez
//                      por repo, na máquina de quem tem um.
//   APLICAR o manifesto  é determinístico. Roda na VPS, sem modelo, quantas
//                      vezes for preciso, e tem que dar o MESMO resultado.
//
// Este arquivo é o contrato entre os dois: o gerador escreve, o `plugar-repo`
// lê, e o que estiver fora do esquema é recusado aqui — antes de virar entrada
// de `config/skills.json`, porque config inválida não falha no plugar, falha no
// BOOT, e o modo de falha "o bot não sobe" é pior que "a instalação parou".
import { isAbsolute } from 'node:path';

import type { Fila } from '../fila/types.js';
import { NOME_SIMPLES } from './flow.js';
import { COMANDO_VALIDO, FILAS_VALIDAS } from './registry.js';

/**
 * Versões de ESQUEMA que este bot entende — não a versão do bot.
 *
 * Um manifesto que dissesse `"inemaccbot": ">=0.5.0"` obrigaria todo repo a
 * saber a versão de um projeto que ele não controla, e envelheceria no primeiro
 * bump feito por outro motivo. O esquema muda quando o CONTRATO muda, que é bem
 * mais raro.
 */
export const SCHEMAS_SUPORTADOS = [1];

/** O que o gerador pode marcar como adivinhado. É o que a tela de revisão
 * destaca — e o que, meses depois, diz se um valor foi decidido ou chutado. */
const CONFIANCAS = new Set(['lido', 'chute']);

const TIPOS_CAMPO = new Set(['bandeira', 'texto']);
const USOS_CAMPO = new Set(['prompt', 'entrega']);
const NOME_CAMPO = /^[a-z][a-z0-9_]{0,20}$/;
/** Nome de variável de ambiente: é NOME de chave, nunca o valor dela. */
const NOME_CHAVE = /^[A-Z][A-Z0-9_]{2,40}$/;
/** Binário: o que se digita num `command -v`. */
const NOME_BIN = /^[a-z0-9][a-z0-9._+-]{0,30}$/i;
const NOME_FONTE = /^[a-z0-9][a-z0-9-]*$/;

export interface CampoManifesto {
  tipo: 'bandeira' | 'texto';
  padrao: string;
  usa: 'prompt' | 'entrega';
}

export interface ManifestoSkill {
  manifesto: number;
  rota: 'skill';
  command: string;
  /** `url` é OPCIONAL: quando o manifesto viaja DENTRO do repo
   * (`<repo>/integracao.json`), quem o lê já tem o clone na mão, e exigir a URL
   * obrigaria um repo ainda sem `remote` a inventar uma. Sem ela, o
   * `plugar-repo` recusa apenas o caso em que precisaria clonar. */
  repo: {
    url?: string;
    commit?: string;
    /** Nome da PASTA do clone, quando difere do `command` (o comando do chat não
     * precisa ter o nome do repositório: `roda` num repo `repoprep`). Sem isto o
     * `plugar-repo` procuraria o clone pelo comando e não acharia. */
    pasta?: string;
  };
  /** Linha de comando do domínio. Usa `{{repo}}` e `{{input}}`; caminho absoluto
   * é recusado (não sobrevive a outra máquina). Com `sem_agente`, ela É o
   * comando que o bot roda; sem, ela é o que o prompt manda o agente rodar. */
  invocacao: string;
  /**
   * A skill roda SEM AGENTE: o bot executa a `invocacao` direto.
   *
   * Vale quando a skill só monta uma linha de comando — que é o caso normal de
   * skill plugada de repo externo. O `analisevideo` era assim e pagava um
   * modelo para digitar bash: em 2026-08-21 o agente destacou o processo
   * (proibido no prompt), encerrou o turno, e o job morreu sem contrato levando
   * a análise junto. Deixe `false` só quando o agente REALMENTE decide algo —
   * escrever texto, navegar, escolher entre caminhos.
   */
  sem_agente?: boolean;
  fila: Fila;
  artefato_exts: string[];
  timeout_segundos: number;
  max_tentativas: number;
  aceita_destino: boolean;
  campos: Record<string, CampoManifesto>;
  requer: { bin: string[]; chaves: string[]; fontes: string[] };
  /** Caminho do prompt, relativo à raiz do BOT (o prompt é do bot, não do repo
   * plugado: é ele que carrega o contrato `RESULT:`/`ERRO:`). */
  prompt: string;
  /** O que o `/ajuda` mostra. Está no manifesto e não num default do script
   * porque é texto que alguém lê no chat: "analisevideo (plugado por manifesto)"
   * seria pior que não ter ajuda. */
  descricao: string;
  exemplo: string;
  gerado?: { em?: string; por?: string; confianca: Record<string, 'lido' | 'chute'> };
}

/**
 * A DEFINIÇÃO que o manifesto de fluxo carrega para dentro do repo de domínio.
 *
 * Existe porque um fluxo não cabe do lado do bot: `carregarFlow` lê
 * `<repo>/flow.json` do DISCO, e as fases de agente leem os prompts de lá
 * também. Um manifesto que só registrasse o comando serviria apenas para repos
 * que JÁ são domínio — e o caso que importa é o contrário: um repo que ainda
 * não é.
 *
 * Ausente = o repo já traz a definição, e o manifesto é só registro.
 *
 * O que este bloco NÃO é: uma segunda fonte de verdade. Quem manda no fluxo é
 * sempre o `flow.json` NO REPO — o `plugar-fluxo` materializa isto uma vez, sem
 * nunca sobrescrever arquivo divergente, e daí em diante o repo é o dono.
 */
export interface DefinicaoFluxo {
  /** O conteúdo do `flow.json`. Não validado aqui em profundidade — quem valida
   *  de verdade é `carregarFlow`, depois de materializar, porque só no disco dá
   *  para conferir que os prompts das fases existem e não estão vazios. */
  flow: Record<string, unknown>;
  /** Prompt de cada fase `kind=agent`, por caminho relativo ao repo. As chaves
   *  são conferidas contra as fases: prompt declarado e ausente é o erro que o
   *  `carregarFlow` só acusaria depois de escrever no repo alheio. */
  prompts: Record<string, string>;
  /** `HELP.md` do domínio. Opcional de verdade: sem ele o `/<fluxo> help` cai
   *  na ajuda derivada do próprio `flow.json`, que não é um texto pior por ser
   *  automático. */
  help?: string;
}

export interface ManifestoFluxo {
  manifesto: number;
  rota: 'fluxo';
  command: string;
  repo: { url?: string; commit?: string; pasta?: string };
  requer: { bin: string[]; chaves: string[]; fontes: string[] };
  descricao: string;
  exemplo: string;
  /** Ausente = o repo já traz `flow.json` e os prompts. */
  definicao?: DefinicaoFluxo;
  gerado?: { em?: string; por?: string; confianca: Record<string, 'lido' | 'chute'> };
}

export type Manifesto = ManifestoSkill | ManifestoFluxo;

function erro(campo: string, detalhe: string): never {
  throw new Error(`manifesto: ${campo}: ${detalhe}`);
}

function texto(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !v.trim()) erro(campo, 'precisa ser texto não vazio');
  return v.trim();
}

function inteiroPositivo(v: unknown, campo: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) erro(campo, 'inteiro > 0');
  return v;
}

function listaDe(v: unknown, campo: string, formato: RegExp, comoChamar: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) erro(campo, 'precisa ser array');
  return v.map((item, i) => {
    const s = texto(item, `${campo}[${i}]`);
    if (!formato.test(s)) erro(`${campo}[${i}]`, `"${s}" — ${comoChamar}`);
    return s;
  });
}

function validarCampos(v: unknown): Record<string, CampoManifesto> {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) erro('campos', 'precisa ser objeto');
  const saida: Record<string, CampoManifesto> = {};
  for (const [nome, bruto] of Object.entries(v as Record<string, unknown>)) {
    if (!NOME_CAMPO.test(nome)) erro(`campos.${nome}`, 'nome inválido (minúsculas, dígitos, "_")');
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
      erro(`campos.${nome}`, 'precisa ser objeto { tipo, padrao }');
    }
    const c = bruto as Record<string, unknown>;
    const tipo = texto(c.tipo, `campos.${nome}.tipo`);
    if (!TIPOS_CAMPO.has(tipo)) erro(`campos.${nome}.tipo`, `"${tipo}" — use bandeira ou texto`);
    const padrao = texto(c.padrao, `campos.${nome}.padrao`);
    if (tipo === 'bandeira' && padrao !== 'sim' && padrao !== 'não') {
      erro(`campos.${nome}.padrao`, 'bandeira aceita só "sim" ou "não"');
    }
    // O valor vira nome de arquivo lá na frente — a mesma barreira do registry.
    if (/\s/.test(padrao)) erro(`campos.${nome}.padrao`, 'sem espaço (o valor vira nome de arquivo)');
    const usa = c.usa === undefined ? 'prompt' : texto(c.usa, `campos.${nome}.usa`);
    if (!USOS_CAMPO.has(usa)) erro(`campos.${nome}.usa`, `"${usa}" — use prompt ou entrega`);
    saida[nome] = { tipo: tipo as 'bandeira' | 'texto', padrao, usa: usa as 'prompt' | 'entrega' };
  }
  return saida;
}

/**
 * `repo`, `requer` e `gerado` são comuns às duas rotas. Extraídos em função
 * quando a rota de fluxo entrou: duplicá-los seria garantir que divergissem no
 * primeiro campo novo — e o campo novo aqui costuma ser uma regra de segurança
 * (o `=` na chave, o caminho absoluto), não um enfeite.
 */
function validarRepo(d: Record<string, unknown>): { url?: string; commit?: string; pasta?: string } {
  if (typeof d.repo !== 'object' || d.repo === null || Array.isArray(d.repo)) {
    erro('repo', 'precisa ser objeto { url?, commit? }');
  }
  const r = d.repo as Record<string, unknown>;
  const url = r.url === undefined || r.url === '' ? undefined : texto(r.url, 'repo.url');
  if (url !== undefined && (!/^(https:\/\/|git@)/.test(url) || /\s/.test(url))) {
    erro('repo.url', `"${url}" — https:// ou git@, sem espaço`);
  }
  const pasta = r.pasta === undefined ? undefined : texto(r.pasta, 'repo.pasta');
  if (pasta !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(pasta)) {
    erro('repo.pasta', `"${pasta}" — nome de pasta, não caminho`);
  }
  // O commit é PROVENIÊNCIA: diz para qual versão do repo este manifesto foi
  // escrito, e é o que permite avisar "o repo mudou desde então" em vez de
  // aplicar às cegas.
  const commit = r.commit === undefined ? undefined : texto(r.commit, 'repo.commit');
  if (commit !== undefined && !/^[0-9a-f]{7,40}$/.test(commit)) {
    erro('repo.commit', `"${commit}" — hash git (7 a 40 hex)`);
  }
  return { ...(url ? { url } : {}), ...(commit ? { commit } : {}), ...(pasta ? { pasta } : {}) };
}

function validarRequer(d: Record<string, unknown>): { bin: string[]; chaves: string[]; fontes: string[] } {
  if (d.requer === undefined) return { bin: [], chaves: [], fontes: [] };
  if (typeof d.requer !== 'object' || d.requer === null || Array.isArray(d.requer)) {
    erro('requer', 'precisa ser objeto { bin?, chaves?, fontes? }');
  }
  const q = d.requer as Record<string, unknown>;
  const requer = {
    bin: listaDe(q.bin, 'requer.bin', NOME_BIN, 'nome de binário (o que se digita no shell)'),
    chaves: listaDe(q.chaves, 'requer.chaves', NOME_CHAVE, 'NOME da variável (ex.: GOOGLE_API_KEY)'),
    fontes: listaDe(q.fontes, 'requer.fontes', NOME_FONTE, 'nome de fonte registrada'),
  };
  // Segredo NUNCA entra no manifesto: ele é versionado, e `origin` é público.
  // O `=` é o sinal de que alguém colou `CHAVE=valor` em vez do nome.
  for (const c of requer.chaves) {
    if (c.includes('=')) erro('requer.chaves', 'declare o NOME da chave, nunca o valor');
  }
  return requer;
}

function validarGerado(d: Record<string, unknown>): Manifesto['gerado'] {
  if (d.gerado === undefined) return undefined;
  if (typeof d.gerado !== 'object' || d.gerado === null || Array.isArray(d.gerado)) {
    erro('gerado', 'precisa ser objeto');
  }
  const g = d.gerado as Record<string, unknown>;
  const conf: Record<string, 'lido' | 'chute'> = {};
  if (g.confianca !== undefined) {
    if (typeof g.confianca !== 'object' || g.confianca === null || Array.isArray(g.confianca)) {
      erro('gerado.confianca', 'precisa ser objeto { campo: "lido" | "chute" }');
    }
    for (const [campo, v] of Object.entries(g.confianca as Record<string, unknown>)) {
      const marca = texto(v, `gerado.confianca.${campo}`);
      if (!CONFIANCAS.has(marca)) {
        erro(`gerado.confianca.${campo}`, `"${marca}" — use lido ou chute`);
      }
      // Marcar a confiança de um campo que não existe é rastro de manifesto
      // editado à mão pela metade: some o campo, fica a marca. Caminho
      // pontuado (`requer.bin`) é legítimo e comum — a marca costuma ser mais
      // útil no sub-campo que no bloco inteiro —, então confere-se o TOPO.
      const topo = campo.split('.')[0];
      if (!(topo in d)) erro(`gerado.confianca.${campo}`, 'campo não existe no manifesto');
      conf[campo] = marca as 'lido' | 'chute';
    }
  }
  return {
    ...(g.em === undefined ? {} : { em: texto(g.em, 'gerado.em') }),
    ...(g.por === undefined ? {} : { por: texto(g.por, 'gerado.por') }),
    confianca: conf,
  };
}

/**
 * Piso de tamanho do `HELP.md`. O número vem da regra que a suíte já aplica
 * (`ajuda.length > 60` em `gateway/ajuda-dominio.test.ts`) — repetido aqui de
 * propósito, para que a recusa aconteça ANTES de escrever no repo de domínio.
 */
const AJUDA_MINIMA = 60;

/** Nome de fase: vira parte da referência no chat (`M#3/faixa`) e nome de
 *  arquivo de estado. Mesma forma conservadora do resto do sistema. */
// A regra de id de fase é UMA, e mora no `flow.ts` — este arquivo não tem uma
// segunda opinião. A divergência era real e já mordia: aqui era
// `^[a-z][a-z0-9-]{0,30}$` e lá `^[a-z0-9][a-z0-9_-]{0,40}$`, então uma fase
// `40mais` ou `a_b` passava no `carregarFlow` e era recusada pelo manifesto —
// exatamente o "segunda implementação divergiria no primeiro campo novo" que o
// comentário do `conferirDefinicao` previa.
const ID_FASE = NOME_SIMPLES;

/**
 * Valida o manifesto de FLUXO.
 *
 * A diferença de fundo para a rota de skill: uma skill cabe inteira do lado do
 * bot (uma entrada em `config/skills.json` e um prompt), e um fluxo NÃO — o
 * `carregarFlow` lê `<repo>/flow.json` do disco, e as fases de agente leem os
 * prompts de lá. Por isso este manifesto pode CARREGAR a definição
 * (`definicao`), que o `plugar-fluxo` materializa no repo de domínio.
 *
 * O que NÃO se valida aqui, e é de propósito: a semântica do `flow.json`
 * (fases, alvos, tarefas do catálogo, prompts não vazios). Quem faz isso é
 * `carregarFlow`, o validador REAL, depois de materializar — pelo mesmo motivo
 * que `plugar-repo` valida a entrada com o validador real do registry: uma
 * segunda implementação aqui divergiria da primeira no primeiro campo novo.
 *
 * O que se valida é a COERÊNCIA INTERNA do pacote, que é o que `carregarFlow`
 * não pode ver: toda fase de agente tem que ter o prompt dela DENTRO do
 * manifesto. Sem isto, o erro só apareceria depois de escrever no repo alheio —
 * exatamente o que não se pode desfazer com elegância.
 */
function validarManifestoFluxo(d: Record<string, unknown>, versao: number): ManifestoFluxo {
  const command = texto(d.command, 'command');
  if (!COMANDO_VALIDO.test(command)) {
    erro('command', `"${command}" — minúsculas, dígitos e hífen (sem espaço, ":" ou "|")`);
  }

  const repo = validarRepo(d);
  const requer = validarRequer(d);
  const descricao = texto(d.descricao, 'descricao');
  const exemplo = texto(d.exemplo, 'exemplo');

  let definicao: DefinicaoFluxo | undefined;
  if (d.definicao !== undefined) {
    if (typeof d.definicao !== 'object' || d.definicao === null || Array.isArray(d.definicao)) {
      erro('definicao', 'precisa ser objeto { flow, prompts, help? }');
    }
    const def = d.definicao as Record<string, unknown>;

    if (typeof def.flow !== 'object' || def.flow === null || Array.isArray(def.flow)) {
      erro('definicao.flow', 'precisa ser o objeto do flow.json');
    }
    const flow = def.flow as Record<string, unknown>;

    const prompts: Record<string, string> = {};
    if (def.prompts !== undefined) {
      if (typeof def.prompts !== 'object' || def.prompts === null || Array.isArray(def.prompts)) {
        erro('definicao.prompts', 'precisa ser objeto { "prompts/x.md": "conteúdo" }');
      }
      for (const [caminho, conteudo] of Object.entries(def.prompts as Record<string, unknown>)) {
        // O caminho vira arquivo NO REPO ALHEIO. Absoluto ou com ".." é como um
        // manifesto de terceiro escreveria fora do repo — recusado aqui, e não
        // no momento de escrever, porque lá já seria tarde.
        if (isAbsolute(caminho) || caminho.split('/').includes('..')) {
          erro(`definicao.prompts["${caminho}"]`, 'caminho relativo ao repo, sem ".."');
        }
        const corpo = texto(conteudo, `definicao.prompts["${caminho}"]`);
        // Prompt vazio é recusado pelo `carregarFlow` DEPOIS de materializado.
        // Pegar aqui evita escrever no repo dos outros para só então falhar.
        prompts[caminho] = corpo;
      }
    }

    // Coerência: toda fase `kind=agent` declara `prompt`, e ele tem que vir no
    // pacote. É a única checagem de `flow` que este arquivo faz, e existe porque
    // é a que `carregarFlow` não consegue fazer antes da escrita.
    if (!Array.isArray(flow.fases) || flow.fases.length === 0) {
      erro('definicao.flow.fases', 'array não vazio — um fluxo sem fase não faz nada');
    }
    (flow.fases as unknown[]).forEach((f, i) => {
      if (typeof f !== 'object' || f === null || Array.isArray(f)) {
        erro(`definicao.flow.fases[${i}]`, 'precisa ser objeto');
      }
      const fase = f as Record<string, unknown>;
      const id = texto(fase.id, `definicao.flow.fases[${i}].id`);
      if (!ID_FASE.test(id)) {
        erro(`definicao.flow.fases[${i}].id`, `"${id}" — minúsculas, dígitos e hífen`);
      }
      if (fase.kind !== 'agent') return;
      const p = texto(fase.prompt, `definicao.flow.fases[${i}].prompt`);
      if (!(p in prompts)) {
        erro(
          `definicao.prompts`,
          `a fase "${id}" é kind=agent e aponta "${p}", que não vem no manifesto`
          + ' — sem o texto, o fluxo seria materializado quebrado',
        );
      }
    });

    let help: string | undefined;
    if (def.help !== undefined) {
      help = texto(def.help, 'definicao.help');
      // HELP.md CURTO é pior que nenhum, e isso é mecânico, não gosto: quando o
      // arquivo existe, `ajudaDoFluxo` o usa NO LUGAR da ajuda derivada do
      // `flow.json` — que lista fases, escopo e onde estão os portões. Um
      // esqueleto de três linhas troca uma ajuda boa e automática por uma ruim
      // e manual, e a regra `todo domínio do catálogo é documentado`
      // (`gateway/ajuda-dominio.test.ts`) reprova o repo inteiro por causa dela.
      // Pegar aqui é o único momento em que ainda não escrevemos no repo alheio.
      if (help.trim().length < AJUDA_MINIMA) {
        erro(
          'definicao.help',
          `só ${help.trim().length} caracteres — um HELP.md curto SUBSTITUI a ajuda`
          + ' derivada do flow.json, que é melhor. Escreva um de verdade ou omita o campo',
        );
      }
    }

    definicao = {
      flow,
      prompts,
      ...(help === undefined ? {} : { help }),
    };
  }

  return {
    manifesto: versao,
    rota: 'fluxo',
    command,
    repo,
    requer,
    descricao,
    exemplo,
    ...(definicao ? { definicao } : {}),
    ...(validarGerado(d) ? { gerado: validarGerado(d) } : {}),
  };
}

/**
 * Porta de entrada das DUAS rotas. Despacha por `rota` depois de conferir o
 * esquema — a versão primeiro, porque sem ela nenhuma outra checagem significa
 * coisa alguma.
 */
export function validarManifesto(dados: unknown): Manifesto {
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    throw new Error('manifesto: precisa ser um objeto');
  }
  const d = dados as Record<string, unknown>;

  // O esquema PRIMEIRO: sem saber a versão, nenhuma outra checagem significa
  // coisa alguma — e a mensagem tem que dizer o que fazer, não só recusar.
  const versao = d.manifesto;
  if (typeof versao !== 'number' || !Number.isInteger(versao)) {
    erro('manifesto', 'faltando ou não é inteiro — o campo declara a versão do ESQUEMA (ex.: 1)');
  }
  if (!SCHEMAS_SUPORTADOS.includes(versao)) {
    erro(
      'manifesto',
      `esquema ${versao} desconhecido — este bot entende ${SCHEMAS_SUPORTADOS.join(', ')}. `
      + 'Atualize o inemaccbot, ou gere o manifesto no esquema suportado',
    );
  }

  const rota = texto(d.rota, 'rota');
  if (rota === 'fluxo') return validarManifestoFluxo(d, versao);
  if (rota !== 'skill') {
    erro('rota', `"${rota}" — use "skill" (um comando, um artefato) ou "fluxo" (fases com estado e portão)`);
  }

  const command = texto(d.command, 'command');
  if (!COMANDO_VALIDO.test(command)) {
    erro('command', `"${command}" — minúsculas, dígitos e hífen (sem espaço, ":" ou "|")`);
  }

  const repo = validarRepo(d);

  const invocacao = texto(d.invocacao, 'invocacao');
  // `{{repo}}` obrigatório: sem ele a linha traz caminho da máquina de quem
  // gerou, que é exatamente o defeito que o SKILL.md do analisevideo tem.
  if (!invocacao.includes('{{repo}}')) {
    erro('invocacao', 'precisa citar {{repo}} — caminho fixo não sobrevive a outra máquina');
  }
  if (d.sem_agente !== undefined && typeof d.sem_agente !== 'boolean') {
    erro('sem_agente', 'true ou false — com true, o BOT roda a invocação e não há prompt');
  }
  if (!invocacao.includes('{{input}}')) {
    erro('invocacao', 'precisa citar {{input}} — sem isso o comando ignora o que o usuário pediu');
  }
  if (/(^|\s)\/[a-z]/i.test(invocacao)) {
    erro('invocacao', 'caminho absoluto na linha de comando — use {{repo}}');
  }

  const fila = texto(d.fila, 'fila') as Fila;
  if (!FILAS_VALIDAS.has(fila)) {
    erro('fila', `"${fila}" não existe (válidas: ${[...FILAS_VALIDAS].join(', ')})`);
  }

  if (!Array.isArray(d.artefato_exts) || d.artefato_exts.length === 0) {
    erro('artefato_exts', 'array não vazio (ex.: ["md"]) — a PRIMEIRA nomeia o arquivo esperado');
  }
  const artefato_exts = (d.artefato_exts as unknown[]).map((e, i) => {
    const ext = texto(e, `artefato_exts[${i}]`).replace(/^\./, '').toLowerCase();
    if (!/^[a-z0-9]{1,5}$/.test(ext)) erro(`artefato_exts[${i}]`, `extensão inválida: "${ext}"`);
    return ext;
  });

  const descricao = texto(d.descricao, 'descricao');
  const exemplo = texto(d.exemplo, 'exemplo');

  // `prompt` só é obrigatório quando HÁ agente. Com `sem_agente`, quem roda é o
  // bot e um prompt declarado seria arquivo que ninguém lê — pior que ausente,
  // porque parece vigente.
  const semAgente = d.sem_agente === true;
  if (semAgente && d.prompt !== undefined) {
    erro('prompt', 'com sem_agente não há prompt: quem roda a invocação é o bot');
  }
  const prompt = semAgente ? '' : texto(d.prompt, 'prompt');
  if (prompt && (isAbsolute(prompt) || prompt.split('/').includes('..'))) {
    erro('prompt', 'caminho relativo à raiz do bot, sem ".."');
  }

  const requer = validarRequer(d);

  const gerado = validarGerado(d);

  return {
    manifesto: versao,
    rota: 'skill',
    command,
    repo,
    invocacao,
    ...(d.sem_agente === true ? { sem_agente: true } : {}),
    fila,
    artefato_exts,
    timeout_segundos: inteiroPositivo(d.timeout_segundos, 'timeout_segundos'),
    max_tentativas: d.max_tentativas === undefined ? 2 : inteiroPositivo(d.max_tentativas, 'max_tentativas'),
    aceita_destino: d.aceita_destino === true,
    campos: validarCampos(d.campos),
    requer,
    prompt,
    descricao,
    exemplo,
    ...(gerado ? { gerado } : {}),
  };
}

/**
 * A entrada de `config/skills.json` que este manifesto produz.
 *
 * Função pura e separada da escrita de propósito: é ela que o `plugar-repo`
 * valida com o validador REAL do registry antes de tocar no arquivo — a única
 * defesa contra um manifesto que passa aqui e derruba o boot lá.
 */
export function paraEntradaSkill(m: ManifestoSkill): Record<string, unknown> {
  // SEM AGENTE quando o manifesto declara `sem_agente: true`: a `invocacao`,
  // que já é validada (cita `{{repo}}` e `{{input}}`), vira o `comando` da
  // skill e quem executa é o bot.
  //
  // A invocação SEMPRE existiu neste manifesto — ela só era usada para escrever
  // o prompt que um modelo depois leria para digitar o mesmo comando. O
  // analisevideo mostrou o preço disso em 2026-08-21: o agente destacou o
  // processo (proibido no prompt), encerrou o turno e o job morreu sem
  // contrato, matando a análise junto.
  if (m.sem_agente) {
    return {
      command: m.command,
      fila: m.fila,
      kind: 'function',
      comando: m.invocacao,
      repo: m.repo.pasta ?? m.command,
      artefato_exts: m.artefato_exts,
      max_tentativas: m.max_tentativas,
      timeout_segundos: m.timeout_segundos,
      aceita_destino: m.aceita_destino,
      aguarda_artefato: true,
      ...(Object.keys(m.campos).length ? { campos: m.campos } : {}),
      descricao: m.descricao,
      exemplo: m.exemplo,
    };
  }
  return {
    command: m.command,
    fila: m.fila,
    kind: 'agent',
    prompt: m.prompt,
    // A pasta do clone: é o que a execução resolve contra o `PROJETOS_DIR` para
    // dar valor ao `{{repo}}` que o prompt gerado usa no lugar de um caminho de
    // máquina. Sem isto o primeiro job morre em "placeholder sem valor: repo".
    repo: m.repo.pasta ?? m.command,
    artefato_exts: m.artefato_exts,
    max_tentativas: m.max_tentativas,
    timeout_segundos: m.timeout_segundos,
    aceita_destino: m.aceita_destino,
    ...(Object.keys(m.campos).length ? { campos: m.campos } : {}),
    descricao: m.descricao,
    exemplo: m.exemplo,
  };
}

/**
 * A entrada de `config/fluxos.json` que um manifesto de fluxo produz.
 *
 * Repare no que NÃO está aqui: fase, alvo, prompt. O bot só registra o COMANDO
 * e onde o repo está; a máquina de estados mora no `flow.json`, dentro do repo
 * de domínio. É essa divisão que faz um fluxo ser do domínio e não do bot.
 *
 * `repo` sai como NOME DE PASTA, nunca caminho absoluto: quem resolve contra o
 * `PROJETOS_DIR` é o registry, e um caminho absoluto aqui não sobreviveria a
 * outra máquina — que é o ponto inteiro de o manifesto ser versionado.
 */
export function paraEntradaFluxo(m: ManifestoFluxo): Record<string, unknown> {
  return {
    command: m.command,
    repo: m.repo.pasta ?? m.command,
    descricao: m.descricao,
    exemplo: m.exemplo,
  };
}

/** Os campos que o gerador marcou como chute — o que a tela de revisão destaca.
 * Sem isso, revisar dez linhas iguais vira "ok" automático. */
export function camposChutados(m: Manifesto): string[] {
  return Object.entries(m.gerado?.confianca ?? {})
    .filter(([, v]) => v === 'chute')
    .map(([k]) => k)
    .sort();
}
