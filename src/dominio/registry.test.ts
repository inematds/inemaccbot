import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acharSkill, carregarSkills, validarSkills } from './registry.js';

let raiz: string;

/** Registry mínimo válido; cada teste estraga UM campo. */
function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'transcrever',
    fila: 'texto',
    kind: 'agent',
    prompt: 'prompts/t.md',
    artefato_exts: ['txt'],
    max_tentativas: 2,
    timeout_segundos: 60,
    aceita_destino: false,
    descricao: 'transcreve',
    exemplo: 'transcrever: http://x',
    ...over,
  };
}

function escreverPrompt(rel: string, conteudo = 'oi {{input}}'): void {
  const alvo = join(raiz, rel);
  mkdirSync(dirname(alvo), { recursive: true });
  writeFileSync(alvo, conteudo);
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'inemaccbot-registry-'));
  escreverPrompt('prompts/t.md');
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

describe('validarSkills', () => {
  it('aceita uma entrada completa e normaliza as extensões', () => {
    const [d] = validarSkills([base({ artefato_exts: ['.TXT', 'srt'] })], raiz);
    expect(d.command).toBe('transcrever');
    expect(d.artefato_exts).toEqual(['txt', 'srt']);
    expect(d.aceita_destino).toBe(false);
  });

  it('recusa array vazio — um catálogo sem skill nenhuma é erro de config, não estado válido', () => {
    expect(() => validarSkills([], raiz)).toThrow(/vazio/);
  });

  it('recusa fila inexistente', () => {
    expect(() => validarSkills([base({ fila: 'gpu' })], raiz)).toThrow(/fila/);
  });

  it('recusa kind fora de agent|function', () => {
    expect(() => validarSkills([base({ kind: 'plan' })], raiz)).toThrow(/kind/);
  });

  it('recusa comando com espaço, ":" ou "|" — são os separadores da gramática', () => {
    for (const c of ['dois pontos', 'a:b', 'a|b', 'MAIUSCULO']) {
      expect(() => validarSkills([base({ command: c })], raiz)).toThrow(/command/);
    }
  });

  it('recusa comando duplicado', () => {
    expect(() => validarSkills([base(), base()], raiz)).toThrow(/duplicado/);
  });

  it('recusa prompt ausente no disco — o erro tem que aparecer no boot, não no primeiro job', () => {
    expect(() => validarSkills([base({ prompt: 'prompts/nao-existe.md' })], raiz)).toThrow(/ausente/);
  });

  it('recusa prompt vazio', () => {
    escreverPrompt('prompts/vazio.md', '');
    expect(() => validarSkills([base({ prompt: 'prompts/vazio.md' })], raiz)).toThrow(/ausente ou vazio/);
  });

  it('recusa prompt com ".." ou caminho absoluto (fuga da raiz do repo)', () => {
    expect(() => validarSkills([base({ prompt: '../fora.md' })], raiz)).toThrow(/relativo/);
    expect(() => validarSkills([base({ prompt: '/etc/passwd' })], raiz)).toThrow(/relativo/);
  });

  it('recusa artefato_exts vazio ou com extensão inválida', () => {
    expect(() => validarSkills([base({ artefato_exts: [] })], raiz)).toThrow(/artefato_exts/);
    expect(() => validarSkills([base({ artefato_exts: ['mp 4'] })], raiz)).toThrow(/artefato_exts/);
  });

  it('recusa max_tentativas/timeout não-inteiro-positivo', () => {
    expect(() => validarSkills([base({ max_tentativas: 0 })], raiz)).toThrow(/max_tentativas/);
    expect(() => validarSkills([base({ timeout_segundos: -1 })], raiz)).toThrow(/timeout_segundos/);
    expect(() => validarSkills([base({ timeout_segundos: '60' })], raiz)).toThrow(/timeout_segundos/);
  });

  it('aceita perfil parcial e ignora perfil vazio', () => {
    expect(validarSkills([base({ perfil: { modelo: 'opus' } })], raiz)[0].perfil).toEqual({ modelo: 'opus' });
    expect(validarSkills([base({ perfil: {} })], raiz)[0].perfil).toBeUndefined();
  });
});

describe('carregarSkills', () => {
  it('lê e valida o arquivo', () => {
    const arq = join(raiz, 'skills.json');
    writeFileSync(arq, JSON.stringify([base()]));
    expect(carregarSkills(arq, raiz)).toHaveLength(1);
  });

  it('erro claro em JSON inválido e em arquivo ausente', () => {
    const arq = join(raiz, 'skills.json');
    writeFileSync(arq, '{quebrado');
    expect(() => carregarSkills(arq, raiz)).toThrow(/JSON inválido/);
    expect(() => carregarSkills(join(raiz, 'nada.json'), raiz)).toThrow(/não consegui ler/);
  });
});

describe('o registry REAL do repo', () => {
  // Sem isto, `config/skills.json` poderia ficar inválido sem nada acusar até o
  // boot em produção — o teste do validador passaria verde sobre fixtures.
  it('é válido', () => {
    const repo = new URL('../..', import.meta.url).pathname;
    const defs = carregarSkills(join(repo, 'config', 'skills.json'), repo);
    expect(defs.map((d) => d.command).sort()).toEqual(['dublar', 'transcrever']);
    expect(acharSkill(defs, 'transcrever')?.fila).toBe('texto');
    expect(acharSkill(defs, 'inexistente')).toBeUndefined();
  });
});
