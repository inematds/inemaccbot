import { afterEach, describe, expect, it } from 'vitest';

import { argumentosClaude } from './fila/runner-claude.js';
import { argumentosCodex } from './fila/runner-codex.js';
import { ehNivel } from './modelos.js';

const CHAVES = ['INEMA_CLAUDE_EXECUTOR', 'INEMA_CODEX_MENOR'];
const antes = Object.fromEntries(CHAVES.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of CHAVES) {
    if (antes[k] === undefined) delete process.env[k];
    else process.env[k] = antes[k];
  }
});

const ctx = (motor: string, modelo: string) =>
  ({ prompt: 'p', perfil: { motor, modelo, esforco: 'low' } }) as never;

describe('níveis centrais', () => {
  it('reconhece só os quatro níveis', () => {
    expect(['super', 'topo', 'executor', 'menor'].every(ehNivel)).toBe(true);
    expect(ehNivel('sonnet')).toBe(false);
  });

  it('claude: nível vira o ID central; apelido passa direto; esforço é o do perfil', () => {
    process.env.INEMA_CLAUDE_EXECUTOR = 'claude-exec-x';
    expect(argumentosClaude(ctx('claude', 'executor'))).toEqual(['--model', 'claude-exec-x', '--effort', 'low', '-p', 'p']);
    expect(argumentosClaude(ctx('claude', 'opus'))[1]).toBe('opus');
  });

  it('codex: nível vira --model do central quando o mapa não cobre', () => {
    process.env.INEMA_CODEX_MENOR = 'gpt-teste';
    expect(argumentosCodex(ctx('codex', 'menor'), {}).join(' ')).toContain('--model gpt-teste');
    expect(argumentosCodex(ctx('codex', 'menor'), { menor: 'gpt-mapa' }).join(' ')).toContain('--model gpt-mapa');
  });
});
