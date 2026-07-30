// Registry de skills: o CATÁLOGO FECHADO de tarefas que o chat consegue disparar
// (spec §9 — `tarefa` só pode ser um nome presente aqui; texto livre do usuário
// nunca vira nome de comando).
//
// No v1 isto era um `skills.json` sem validação nenhuma: um campo errado só
// aparecia quando o job já estava rodando e o CLI reclamava. Aqui a validação é
// forte e roda no BOOT — registry inválido derruba o serviço, do mesmo jeito que
// checksum de migration divergente. Subir com um catálogo que não entendemos é
// pior do que não subir.
//
// Vale para skills (uma etapa, sem estado). Fluxos são outro registry, etapa 5.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { Fila, Kind } from '../fila/types.js';
import type { PerfilParcial } from './perfil.js';

export interface SkillDef {
  /** O verbo digitado no chat: `transcrever: <link>`. Único no registry. */
  command: string;
  fila: Fila;
  kind: Kind;
  /** Caminho do arquivo de prompt, relativo à raiz do repo. */
  prompt: string;
  /** Extensões aceitas no `RESULT:` — a primeira é a preferida. */
  artefato_exts: string[];
  max_tentativas: number;
  /** Teto de parede da execução. Sem isto um agente travado ocupa um slot da
   * fila para sempre: o heartbeat renova o lease e nada notifica. */
  timeout_segundos: number;
  /** Perfil desta skill (precedência 3 do §1.5); campos ausentes caem no default. */
  perfil?: PerfilParcial;
  /** Aceita `| livesN` para copiar o artefato ao destino. */
  aceita_destino: boolean;
  /**
   * Campos que ESTA skill aceita no comando, além de destino e perfil.
   *
   * Existe para não repetir o erro do v1: lá o parser conhecia `vertical`,
   * `pesquisa`, `narracao`, `visuais` e `mover` por nome, e cada skill nova
   * exigia editá-lo. Aqui quem declara é a skill, e o parser só confere contra a
   * declaração.
   *
   * Todo valor chega ao prompt como string (bandeira vira `sim`/`não`), e
   * `renderizarPrompt` FALHA se o template não usar uma variável declarada —
   * então campo declarado e esquecido no prompt é erro de teste, não silêncio.
   */
  campos: Record<string, CampoDef>;
  /**
   * A tarefa dispara trabalho DESTACADO e depois vigia o artefato aparecer, em
   * vez de esperar o agente terminar (etapa 3, §1.3 do plano). Render precisa
   * disso: um `systemctl restart` no meio de 40 minutos de vídeo mataria o job.
   */
  aguarda_artefato: boolean;
  descricao: string;
  exemplo: string;
}

/**
 * `bandeira`: presente no comando = ligada (`| vertical`). Vira `sim`/`não`.
 * `texto`: `| curso skillsx` ou `| curso=skillsx`. Sem espaço no valor — estes
 * valores viram nome de arquivo na entrega, e espaço ali quebra tudo que
 * re-splita argv (regra que o v1 já aplicava a `curso`/`modulo`).
 */
export interface CampoDef {
  tipo: 'bandeira' | 'texto';
  /** Usado quando o campo não vem no comando. Bandeira: `sim`/`não`. */
  padrao: string;
  /**
   * Quem consome o campo:
   *   `prompt`  (default) — vira variável do template, e o teste do registry
   *                         EXIGE que o prompt a use;
   *   `entrega` — é decisão do gateway depois do job pronto (`mover`), e o
   *               prompt NÃO deve conhecê-la: o agente não move arquivo.
   *
   * A distinção nasceu de um teste vermelho: sem ela, `mover` teria de aparecer
   * no prompt do reel só para satisfazer a guarda, dando ao agente uma
   * instrução que não é dele.
   */
  usa?: 'prompt' | 'entrega';
  descricao?: string;
}

const USOS_CAMPO = new Set(['prompt', 'entrega']);

const TIPOS_CAMPO = new Set(['bandeira', 'texto']);
const FILAS_VALIDAS = new Set<Fila>(['render', 'navegador', 'texto', 'io', 'cpu']);
const KINDS_VALIDOS = new Set<Kind>(['agent', 'function']);
/** Um comando é digitado no chat e casado por igualdade: sem espaço, sem `|`,
 * sem `:` — os três separadores da gramática de comando. */
const COMANDO_VALIDO = /^[a-z][a-z0-9-]{1,30}$/;

function erro(indice: number, campo: string, detalhe: string): never {
  throw new Error(`registry de skills: entrada ${indice} (${campo}): ${detalhe}`);
}

function exigirTexto(v: unknown, i: number, campo: string): string {
  if (typeof v !== 'string' || v.trim() === '') erro(i, campo, 'faltando ou vazio');
  return (v as string).trim();
}

function exigirInteiroPositivo(v: unknown, i: number, campo: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    erro(i, campo, `precisa ser inteiro > 0 (veio ${JSON.stringify(v)})`);
  }
  return v as number;
}

function validarPerfil(v: unknown, i: number): PerfilParcial | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) erro(i, 'perfil', 'precisa ser objeto');
  const p = v as Record<string, unknown>;
  const saida: PerfilParcial = {};
  for (const campo of ['motor', 'modelo', 'esforco'] as const) {
    if (p[campo] === undefined) continue;
    saida[campo] = exigirTexto(p[campo], i, `perfil.${campo}`);
  }
  // O VALOR de modelo/esforço é validado por `resolverPerfil` (dominio/perfil.ts),
  // que é quem conhece o ranking — duplicar a lista aqui criaria duas fontes.
  return Object.keys(saida).length ? saida : undefined;
}

/** Nome de campo é digitado no chat e vira variável de prompt: as duas coisas
 * exigem a mesma forma conservadora. */
const NOME_CAMPO = /^[a-z][a-z0-9_]{0,20}$/;

/** Nomes que a gramática já usa para outra coisa — declarar um deles faria o
 * campo da skill ser comido silenciosamente pelo parser. */
const RESERVADOS = new Set(['motor', 'modelo', 'esforco', 'input', 'saida']);

function validarCampos(v: unknown, i: number, command: string): Record<string, CampoDef> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) erro(i, 'campos', 'precisa ser objeto');
  const saida: Record<string, CampoDef> = {};
  for (const [nome, bruto] of Object.entries(v as Record<string, unknown>)) {
    if (!NOME_CAMPO.test(nome)) erro(i, `campos.${nome}`, 'nome inválido (minúsculas, dígitos, "_")');
    if (RESERVADOS.has(nome)) {
      erro(i, `campos.${nome}`, `"${nome}" é reservado pela gramática — a skill "${command}" nunca receberia esse valor`);
    }
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
      erro(i, `campos.${nome}`, 'precisa ser objeto { tipo, padrao }');
    }
    const c = bruto as Record<string, unknown>;
    const tipo = exigirTexto(c.tipo, i, `campos.${nome}.tipo`);
    if (!TIPOS_CAMPO.has(tipo)) erro(i, `campos.${nome}.tipo`, `"${tipo}" — use bandeira ou texto`);
    const padrao = typeof c.padrao === 'string' ? c.padrao : '';
    if (tipo === 'bandeira' && !['sim', 'não'].includes(padrao)) {
      erro(i, `campos.${nome}.padrao`, 'bandeira aceita só "sim" ou "não"');
    }
    if (/\s/.test(padrao)) erro(i, `campos.${nome}.padrao`, 'sem espaço (o valor vira nome de arquivo)');
    const usa = c.usa === undefined ? 'prompt' : exigirTexto(c.usa, i, `campos.${nome}.usa`);
    if (!USOS_CAMPO.has(usa)) erro(i, `campos.${nome}.usa`, `"${usa}" — use prompt ou entrega`);
    saida[nome] = {
      tipo: tipo as CampoDef['tipo'],
      padrao,
      usa: usa as CampoDef['usa'],
      ...(typeof c.descricao === 'string' ? { descricao: c.descricao } : {}),
    };
  }
  return saida;
}

/**
 * Valida o conteúdo já parseado. Separado de `carregarSkills` para o teste poder
 * exercitar cada regra sem escrever arquivo no disco.
 *
 * `raiz` é usada só para conferir que o arquivo de prompt EXISTE — o conteúdo é
 * lido na hora do job, para que editar um prompt não exija reiniciar o serviço.
 * (Fluxo é diferente: lá a definição é congelada, §3.4. Skill não tem estado, e
 * "rodar de novo do zero" é aceitável por definição — §1.1.)
 */
export function validarSkills(dados: unknown, raiz: string): SkillDef[] {
  if (!Array.isArray(dados)) throw new Error('registry de skills: o arquivo precisa ser um array');
  if (dados.length === 0) throw new Error('registry de skills: array vazio — nenhuma skill disponível');

  const vistos = new Set<string>();
  return dados.map((bruta, i) => {
    if (typeof bruta !== 'object' || bruta === null || Array.isArray(bruta)) {
      erro(i, 'entrada', 'precisa ser objeto');
    }
    const d = bruta as Record<string, unknown>;

    const command = exigirTexto(d.command, i, 'command');
    if (!COMANDO_VALIDO.test(command)) {
      erro(i, 'command', `"${command}" — use minúsculas, dígitos e hífen (sem espaço, ":" ou "|")`);
    }
    if (vistos.has(command)) erro(i, 'command', `"${command}" duplicado no registry`);
    vistos.add(command);

    const fila = exigirTexto(d.fila, i, 'fila') as Fila;
    if (!FILAS_VALIDAS.has(fila)) {
      erro(i, 'fila', `"${fila}" não existe (válidas: ${[...FILAS_VALIDAS].join(', ')})`);
    }
    const kind = exigirTexto(d.kind, i, 'kind') as Kind;
    if (!KINDS_VALIDOS.has(kind)) erro(i, 'kind', `"${kind}" não existe (agent | function)`);

    const prompt = exigirTexto(d.prompt, i, 'prompt');
    if (isAbsolute(prompt) || prompt.includes('..')) {
      erro(i, 'prompt', 'precisa ser caminho relativo à raiz do repo, sem ".."');
    }
    const caminhoPrompt = resolve(raiz, prompt);
    if (!existsSync(caminhoPrompt) || statSync(caminhoPrompt).size === 0) {
      erro(i, 'prompt', `arquivo ausente ou vazio: ${prompt}`);
    }

    if (!Array.isArray(d.artefato_exts) || d.artefato_exts.length === 0) {
      erro(i, 'artefato_exts', 'precisa ser um array não vazio (ex.: ["txt","srt"])');
    }
    const artefato_exts = (d.artefato_exts as unknown[]).map((e, k) => {
      const ext = exigirTexto(e, i, `artefato_exts[${k}]`).replace(/^\./, '').toLowerCase();
      if (!/^[a-z0-9]{1,5}$/.test(ext)) erro(i, `artefato_exts[${k}]`, `extensão inválida: "${ext}"`);
      return ext;
    });

    return {
      command,
      fila,
      kind,
      prompt,
      artefato_exts,
      max_tentativas: exigirInteiroPositivo(d.max_tentativas, i, 'max_tentativas'),
      timeout_segundos: exigirInteiroPositivo(d.timeout_segundos, i, 'timeout_segundos'),
      perfil: validarPerfil(d.perfil, i),
      aceita_destino: d.aceita_destino === true,
      campos: validarCampos(d.campos, i, command),
      aguarda_artefato: d.aguarda_artefato === true,
      descricao: exigirTexto(d.descricao, i, 'descricao'),
      exemplo: exigirTexto(d.exemplo, i, 'exemplo'),
    };
  });
}

export function carregarSkills(caminhoJson: string, raiz: string): SkillDef[] {
  let texto: string;
  try {
    texto = readFileSync(caminhoJson, 'utf8');
  } catch {
    throw new Error(`registry de skills: não consegui ler ${caminhoJson}`);
  }
  let dados: unknown;
  try {
    dados = JSON.parse(texto);
  } catch (e) {
    throw new Error(`registry de skills: JSON inválido em ${caminhoJson}: ${(e as Error).message}`);
  }
  return validarSkills(dados, raiz);
}

/** Busca por comando. `undefined` (e não exceção) porque quem chama é o gateway,
 * que trata "não é skill" como texto livre, não como erro. */
export function acharSkill(defs: SkillDef[], command: string): SkillDef | undefined {
  return defs.find((d) => d.command === command);
}
