import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeRunner, argumentosClaude } from './runner-claude.js';
import { RUNNERS } from './runner.js';

/** O caminho do sleep varia por distro; o repo já checa os dois. */
const binarioSleep = (): string =>
  existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep';

/** Arquivos que o payload NÃO deveria criar — apagados de qualquer jeito. */
const criados: string[] = [];
afterEach(() => {
  for (const f of criados.splice(0)) rmSync(f, { force: true });
});

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

  // O prazo de escalada pra SIGKILL é 2s. Se `cancelar` não corresse contra a
  // saída do filho, TODO cancelamento pagaria esses 2s — por job, no /cancelar
  // e no timeout do drain. O limite de 1_500ms é folgado de propósito.
  it('cancelar volta assim que o filho morre, sem pagar o prazo do SIGKILL', async () => {
    const r = new ClaudeRunner(binarioSleep());
    const exec = r.iniciar({ ...ctx('sonnet', 'low'), prompt: '30' });
    const p = exec.aguardar();
    const t0 = Date.now();
    await exec.cancelar();
    const decorrido = Date.now() - t0;
    await expect(p).rejects.toThrow(/cancelad/);
    expect(decorrido).toBeLessThan(1_500);
  });

  // O teste de "sem shell" acima olha só o ARRAY de argumentos — função pura que
  // nunca faz spawn. Aqui o payload atravessa o spawn de verdade: tem que chegar
  // como STRING LITERAL e não pode executar nada.
  it('o payload de shell atravessa o spawn como literal, sem efeito colateral', async () => {
    const alvo = join(tmpdir(), `inemaccbot-pwned-${process.pid}-${Date.now()}`);
    criados.push(alvo);
    const payload = `\`$(touch ${alvo}); rm -rf naoexiste\``;

    const r = new ClaudeRunner('/bin/echo');
    const saida = await r.iniciar({ ...ctx('sonnet', 'low'), prompt: payload }).aguardar();

    expect(saida).toContain(payload);
    expect(existsSync(alvo)).toBe(false);
  });
});
