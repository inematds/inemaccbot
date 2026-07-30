import { describe, expect, it } from 'vitest';

import { ClaudeRunner, argumentosClaude } from './runner-claude.js';
import { RUNNERS } from './runner.js';

const ctx = (modelo: string, esforco: string) => ({
  prompt: 'faça X', cwd: '/tmp',
  perfil: { motor: 'claude', modelo, esforco }, vars: {},
});

describe('argumentosClaude', () => {
  it('traduz o perfil em flags da CLI, com o prompt por último', () => {
    expect(argumentosClaude(ctx('opus', 'high')))
      .toEqual(['--model', 'opus', '--effort', 'high', '-p', 'faça X']);
  });

  it('nunca usa shell: os argumentos são um array, sem interpolação', () => {
    const args = argumentosClaude({ ...ctx('sonnet', 'low'), prompt: 'rm -rf / ; echo oi' });
    expect(args[args.length - 1]).toBe('rm -rf / ; echo oi');
    expect(args.join(' ')).not.toContain('&&');
  });
});

describe('registro de motores', () => {
  it('registra "claude" em RUNNERS', () => {
    expect(RUNNERS.claude).toBeInstanceOf(ClaudeRunner);
    expect(RUNNERS.claude.nome).toBe('claude');
  });
});

describe('execução real de subprocesso (usa /bin/echo como binário)', () => {
  it('devolve o stdout', async () => {
    const r = new ClaudeRunner('/bin/echo');
    const saida = await r.iniciar(ctx('sonnet', 'low')).aguardar();
    expect(saida).toContain('--model sonnet');
  });

  it('cancelar mata a árvore e faz aguardar rejeitar', async () => {
    const r = new ClaudeRunner('/usr/bin/sleep');
    const exec = r.iniciar({ ...ctx('sonnet', 'low'), prompt: '30' });
    const p = exec.aguardar();
    await exec.cancelar();
    await expect(p).rejects.toThrow(/cancelad/);
  });
});
