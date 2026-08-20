import { describe, expect, it } from 'vitest';

import { OpencodeRunner, argumentosOpencode, mapaModelos } from './runner-opencode.js';
import { RUNNERS } from './runner.js';

const ctx = (modelo: string, esforco: string) => ({
  prompt: 'faça X', cwd: '/tmp',
  perfil: { motor: 'opencode', modelo, esforco }, vars: {},
});

describe('mapaModelos', () => {
  it('sem OPENCODE_MODELOS, não mapeia nada (vale o opencode.json da máquina)', () => {
    expect(mapaModelos({})).toEqual({});
  });

  it('lê pares alias=provedor/modelo', () => {
    expect(mapaModelos({ OPENCODE_MODELOS: 'sonnet=anthropic/claude-sonnet-4-5,opus=deepseek/deepseek-chat' }))
      .toEqual({ sonnet: 'anthropic/claude-sonnet-4-5', opus: 'deepseek/deepseek-chat' });
  });
});

describe('argumentosOpencode', () => {
  it('roda no subcomando não-interativo', () => {
    expect(argumentosOpencode(ctx('sonnet', 'low'))[0]).toBe('run');
  });

  it('sem mapa, não passa --model', () => {
    expect(argumentosOpencode(ctx('opus', 'high'), {})).not.toContain('--model');
  });

  it('traduz o alias no provedor/modelo quando o mapa diz', () => {
    const args = argumentosOpencode(ctx('opus', 'high'), { opus: 'deepseek/deepseek-chat' });
    expect(args.join(' ')).toContain('--model deepseek/deepseek-chat');
  });

  // O esforço NÃO viaja de propósito: a CLI não expõe nível de raciocínio.
  // Se um dia passar a expor, este teste é o lugar de mudar de ideia.
  it('não inventa flag de esforço', () => {
    const baixo = argumentosOpencode(ctx('sonnet', 'low'));
    const alto = argumentosOpencode(ctx('sonnet', 'max'));
    expect(baixo).toEqual(alto);
  });

  it('nunca usa shell: o prompt é o ÚLTIMO argumento', () => {
    const args = argumentosOpencode({ ...ctx('sonnet', 'low'), prompt: 'rm -rf / ; echo oi' });
    expect(args[args.length - 1]).toBe('rm -rf / ; echo oi');
  });
});

describe('registro de motores', () => {
  it('registra "opencode" em RUNNERS sem tocar em "claude"', () => {
    expect(RUNNERS.opencode).toBeInstanceOf(OpencodeRunner);
    expect(RUNNERS.opencode.nome).toBe('opencode');
    expect(RUNNERS.claude?.nome).toBe('claude');
  });
});

describe('execução real de subprocesso (usa /bin/echo como binário)', () => {
  it('herda a maquinaria do ClaudeRunner e devolve o stdout', async () => {
    const r = new OpencodeRunner('/bin/echo');
    const saida = await r.iniciar(ctx('sonnet', 'low')).aguardar();
    expect(saida).toContain('run');
    expect(saida).toContain('faça X');
  });
});
