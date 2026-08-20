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

export interface Manifesto {
  manifesto: number;
  rota: 'skill';
  command: string;
  repo: { url: string; commit?: string };
  /** Linha de comando que o PROMPT vai mandar o agente rodar. Usa `{{repo}}` e
   * `{{input}}`; caminho absoluto é recusado (não sobrevive a outra máquina). */
  invocacao: string;
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
  if (rota !== 'skill') {
    // Fluxo (rota B) exige commitar `flow.json` e `HELP.md` DENTRO do repo
    // plugado — outra ordem de invasividade, e por isso continua manual.
    erro('rota', `"${rota}" — só "skill" por enquanto; para fluxo, ver docs/instalar-analisevideo.md`);
  }

  const command = texto(d.command, 'command');
  if (!COMANDO_VALIDO.test(command)) {
    erro('command', `"${command}" — minúsculas, dígitos e hífen (sem espaço, ":" ou "|")`);
  }

  if (typeof d.repo !== 'object' || d.repo === null || Array.isArray(d.repo)) {
    erro('repo', 'precisa ser objeto { url, commit? }');
  }
  const r = d.repo as Record<string, unknown>;
  const url = texto(r.url, 'repo.url');
  if (!/^(https:\/\/|git@)/.test(url) || /\s/.test(url)) {
    erro('repo.url', `"${url}" — https:// ou git@, sem espaço`);
  }
  // O commit é PROVENIÊNCIA: diz para qual versão do repo este manifesto foi
  // escrito, e é o que permite avisar "o repo mudou desde então" em vez de
  // aplicar às cegas.
  const commit = r.commit === undefined ? undefined : texto(r.commit, 'repo.commit');
  if (commit !== undefined && !/^[0-9a-f]{7,40}$/.test(commit)) {
    erro('repo.commit', `"${commit}" — hash git (7 a 40 hex)`);
  }

  const invocacao = texto(d.invocacao, 'invocacao');
  // `{{repo}}` obrigatório: sem ele a linha traz caminho da máquina de quem
  // gerou, que é exatamente o defeito que o SKILL.md do analisevideo tem.
  if (!invocacao.includes('{{repo}}')) {
    erro('invocacao', 'precisa citar {{repo}} — caminho fixo não sobrevive a outra máquina');
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

  const prompt = texto(d.prompt, 'prompt');
  if (isAbsolute(prompt) || prompt.split('/').includes('..')) {
    erro('prompt', 'caminho relativo à raiz do bot, sem ".."');
  }

  let requer = { bin: [] as string[], chaves: [] as string[], fontes: [] as string[] };
  if (d.requer !== undefined) {
    if (typeof d.requer !== 'object' || d.requer === null || Array.isArray(d.requer)) {
      erro('requer', 'precisa ser objeto { bin?, chaves?, fontes? }');
    }
    const q = d.requer as Record<string, unknown>;
    requer = {
      bin: listaDe(q.bin, 'requer.bin', NOME_BIN, 'nome de binário (o que se digita no shell)'),
      chaves: listaDe(q.chaves, 'requer.chaves', NOME_CHAVE, 'NOME da variável (ex.: GOOGLE_API_KEY)'),
      fontes: listaDe(q.fontes, 'requer.fontes', NOME_FONTE, 'nome de fonte registrada'),
    };
    // Segredo NUNCA entra no manifesto: ele é versionado, e `origin` é público.
    // O `=` é o sinal de que alguém colou `CHAVE=valor` em vez do nome.
    for (const c of requer.chaves) {
      if (c.includes('=')) erro('requer.chaves', 'declare o NOME da chave, nunca o valor');
    }
  }

  let gerado: Manifesto['gerado'];
  if (d.gerado !== undefined) {
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
    gerado = {
      ...(g.em === undefined ? {} : { em: texto(g.em, 'gerado.em') }),
      ...(g.por === undefined ? {} : { por: texto(g.por, 'gerado.por') }),
      confianca: conf,
    };
  }

  return {
    manifesto: versao,
    rota: 'skill',
    command,
    repo: { url, ...(commit ? { commit } : {}) },
    invocacao,
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
export function paraEntradaSkill(m: Manifesto): Record<string, unknown> {
  return {
    command: m.command,
    fila: m.fila,
    kind: 'agent',
    prompt: m.prompt,
    artefato_exts: m.artefato_exts,
    max_tentativas: m.max_tentativas,
    timeout_segundos: m.timeout_segundos,
    aceita_destino: m.aceita_destino,
    ...(Object.keys(m.campos).length ? { campos: m.campos } : {}),
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
