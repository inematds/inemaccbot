// Responde uma PERGUNTA sobre o serviço ("terminou?", "deu erro em algum?",
// "o que você sabe fazer?").
//
// Portado do `answer.ts` do v1, e muito menor: lá o contexto vinha de dois
// serviços HTTP (`queue-client`) mais um arquivo de state paralelo, e cada um
// podia estar fora do ar — daí metade do código ser tratamento de
// indisponibilidade. Aqui a fila é uma tabela no mesmo processo: ou o bot está
// de pé (e o contexto existe) ou não há a quem perguntar.
//
// Duas regras que vieram inteiras do v1, porque são de segurança e não de
// estilo: o contexto é ESCOPADO ao chat que perguntou (nunca vaza job de outro
// chat), e o log entra saneado (§9).
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

import type { Runner } from '../fila/runner.js';
import type { Job, Perfil } from '../fila/types.js';
import type { SkillDef } from '../dominio/registry.js';
import { textoSkills } from './gramatica.js';

/**
 * Lê só o FIM do arquivo, sem nunca carregar o log inteiro na memória (ele
 * cresce sem teto em produção). Nunca lança: um log ilegível não pode impedir
 * a resposta.
 */
export function caudaDoLog(arquivo: string, maxLinhas = 120, maxColunas = 300, bytes = 200_000): string {
  if (!existsSync(arquivo)) return '(sem log ainda)';
  let fd: number | undefined;
  try {
    const tamanho = statSync(arquivo).size;
    if (tamanho === 0) return '(log vazio)';
    const ler = Math.min(tamanho, bytes);
    const inicio = tamanho - ler;
    fd = openSync(arquivo, 'r');
    const buf = Buffer.alloc(ler);
    readSync(fd, buf, 0, ler, inicio);
    const linhas = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
    // Começando no meio do arquivo, a primeira linha pode estar cortada.
    const usaveis = inicio > 0 && linhas.length > 1 ? linhas.slice(1) : linhas;
    const cauda = usaveis.slice(-maxLinhas).map((l) => (l.length > maxColunas ? `${l.slice(0, maxColunas)}…` : l));
    return cauda.length ? cauda.join('\n') : '(log vazio)';
  } catch {
    return '(log inacessível)';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* noop */ } }
  }
}

function linhaJob(j: Job, agora: number): string {
  const idade = j.terminado_em ?? j.iniciado_em ?? j.criado_em;
  return [
    `job ${j.id}`,
    j.tarefa,
    `fila=${j.fila}`,
    `status=${j.status}`,
    `tentativas=${j.tentativas}/${j.max_tentativas}`,
    `há ${Math.max(0, agora - idade)}s`,
    j.erro ? `erro=${j.erro.slice(0, 200)}` : '',
  ].filter(Boolean).join(' · ');
}

export interface ContextoResposta {
  jobsDoChat: Job[];
  cauda: string;
  defs: SkillDef[];
  agora: number;
}

export function montarPromptResposta(pergunta: string, ctx: ContextoResposta): string {
  const jobs = ctx.jobsDoChat.length
    ? ctx.jobsDoChat.map((j) => linhaJob(j, ctx.agora)).join('\n')
    : '(nenhum job deste chat)';
  return [
    'Você é o assistente de um bot de fila de jobs. Responda em PT-BR, CURTO e FACTUAL, usando SOMENTE o contexto abaixo.',
    'Se o contexto não tiver a resposta, diga que não sabe — NUNCA invente status, prazo ou ação.',
    'Nunca repita caminhos de configuração, tokens ou trechos crus de log: resuma em linguagem natural.',
    'Se a pergunta for sobre o que você CONSEGUE fazer, responda SÓ com base na lista de skills abaixo, e diga planamente o que está fora dela.',
    '',
    '--- skills registradas (fonte real) ---',
    textoSkills(ctx.defs),
    '--- jobs deste chat ---',
    jobs,
    '--- log recente do serviço (mais novo no fim) ---',
    ctx.cauda,
    '',
    '--- pergunta ---',
    pergunta,
  ].join('\n');
}

export interface DepsResposta {
  runner: Runner;
  perfil: Perfil;
  cwd: string;
  timeoutMs?: number;
}

const TIMEOUT_PADRAO_MS = 90_000;

export async function responderPergunta(
  pergunta: string, ctx: ContextoResposta, deps: DepsResposta,
): Promise<string> {
  const exec = deps.runner.iniciar({
    prompt: montarPromptResposta(pergunta, ctx),
    cwd: deps.cwd,
    perfil: deps.perfil,
    vars: {},
    timeoutMs: deps.timeoutMs ?? TIMEOUT_PADRAO_MS,
  });
  try {
    const r = (await exec.aguardar()).trim();
    return r || 'não consegui responder isso agora.';
  } catch (e) {
    // §8: silêncio nunca é estado válido — inclusive aqui, onde a falha é de
    // uma pergunta e não de um job.
    return `não consegui responder agora: ${(e as Error).message}`;
  } finally {
    await exec.limpar();
  }
}
