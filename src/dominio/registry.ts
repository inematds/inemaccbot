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
  descricao: string;
  exemplo: string;
}

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
