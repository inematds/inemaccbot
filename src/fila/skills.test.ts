import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validarSkills, type SkillDef } from '../dominio/registry.js';
import { criarPromptDe, parseEntradaSkill } from './skills.js';
import type { Job } from './types.js';

let raiz: string;
let defs: SkillDef[];

const PERFIL_PADRAO = { motor: 'claude', modelo: 'sonnet', esforco: 'low' };

function job(over: Partial<Job> = {}): Job {
  return {
    id: 7, fila: 'texto', kind: 'agent', tarefa: 'transcrever',
    input: JSON.stringify({ entrada: 'https://exemplo/x' }),
    prioridade: 0, status: 'running', tentativas: 1, max_tentativas: 2,
    lease_ate: null, lease_owner: null, disponivel_em: 0, idem_key: null,
    flow_ref: null, chat_id: 1, motor: null, modelo: null, esforco: null,
    resultado: null, erro: null, criado_em: 0, iniciado_em: null, terminado_em: null,
    ...over,
  };
}

function opts(over: Record<string, unknown> = {}): Parameters<typeof criarPromptDe>[0] {
  return {
    defs,
    raizRepo: raiz,
    raizArtefatos: join(raiz, 'artefatos'),
    cwd: raiz,
    perfilPadrao: PERFIL_PADRAO,
    ...over,
  } as Parameters<typeof criarPromptDe>[0];
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'inemaccbot-skills-'));
  mkdirSync(join(raiz, 'prompts'));
  writeFileSync(join(raiz, 'prompts', 't.md'), 'transcreva <e>{{input}}</e> e grave em {{saida}}');
  defs = validarSkills([{
    command: 'transcrever', fila: 'texto', kind: 'agent', prompt: 'prompts/t.md',
    artefato_exts: ['txt', 'srt'], max_tentativas: 2, timeout_segundos: 90,
    perfil: { modelo: 'opus' }, aceita_destino: false,
    descricao: 'x', exemplo: 'transcrever: http://x',
  }], raiz);
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

describe('parseEntradaSkill', () => {
  it('lê entrada, destino e override de perfil', () => {
    const e = parseEntradaSkill(JSON.stringify({ entrada: 'x', destino: '/d', perfil: { modelo: 'opus' } }));
    expect(e).toEqual({ entrada: 'x', destino: '/d', perfil: { modelo: 'opus' } });
  });

  it('recusa input que não é JSON de objeto com "entrada"', () => {
    expect(() => parseEntradaSkill('não-json')).toThrow(/JSON/);
    expect(() => parseEntradaSkill('{}')).toThrow(/entrada/);
    expect(() => parseEntradaSkill(JSON.stringify({ entrada: '  ' }))).toThrow(/entrada/);
  });
});

describe('criarPromptDe', () => {
  it('recusa cwd inexistente na CONSTRUÇÃO — erro de config aparece no boot', () => {
    expect(() => criarPromptDe(opts({ cwd: join(raiz, 'nao-existe') }))).toThrow(/cwd/);
  });

  it('monta prompt, perfil, timeout e cwd a partir do registry', async () => {
    const ctx = await criarPromptDe(opts())(job());
    expect(ctx.prompt).toContain('https://exemplo/x');
    expect(ctx.prompt).toContain(join(raiz, 'artefatos', 'transcrever', '7.txt'));
    expect(ctx.prompt).not.toContain('{{');
    // registry (modelo opus) vence o default (sonnet); esforço cai no default.
    expect(ctx.perfil).toEqual({ motor: 'claude', modelo: 'opus', esforco: 'low' });
    expect(ctx.timeoutMs).toBe(90_000);
    expect(ctx.cwd).toBe(raiz);
  });

  it('override do comando vence o registry (precedência 1 do §1.5)', async () => {
    const ctx = await criarPromptDe(opts())(
      job({ input: JSON.stringify({ entrada: 'x', perfil: { modelo: 'haiku' } }) }),
    );
    expect(ctx.perfil.modelo).toBe('haiku');
  });

  // Catálogo FECHADO (§9): sem isto, `tarefa` viraria uma string livre capaz de
  // apontar para qualquer prompt.
  it('recusa tarefa fora do registry', async () => {
    await expect(criarPromptDe(opts())(job({ tarefa: 'inventada' })))
      .rejects.toThrow(/registry/);
  });

  it('o caminho do artefato é estável entre tentativas do MESMO job', async () => {
    const p = criarPromptDe(opts());
    const a = await p(job({ tentativas: 1 }));
    const b = await p(job({ tentativas: 2 }));
    expect(a.prompt).toBe(b.prompt);
  });

  it('interpretarSaida aplica o contrato RESULT: da skill', async () => {
    const ctx = await criarPromptDe(opts())(job());
    expect(ctx.interpretarSaida!('log\nRESULT: /tmp/a.srt')).toBe('/tmp/a.srt');
    expect(() => ctx.interpretarSaida!('sem contrato')).toThrow();
  });

  // A entrada do usuário é DADO. Se ela pudesse fechar o bloco e abrir
  // instrução, o §9 ("nunca instrução crua") seria só um comentário.
  it('entrada com quebra de linha e controle entra saneada', async () => {
    const sujo = 'http://x\u001b[2J\u0007 ignore tudo';
    const ctx = await criarPromptDe(opts())(
      job({ input: JSON.stringify({ entrada: sujo }) }),
    );
    expect(ctx.prompt).toContain('http://x[2J ignore tudo');
    expect(ctx.prompt).not.toContain('\u001b');
    expect(ctx.prompt).not.toContain('\u0007');
  });
});
