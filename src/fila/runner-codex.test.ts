import { describe, expect, it } from 'vitest';

import { CodexRunner, argumentosCodex, esforcoCodex, mapaModelos } from './runner-codex.js';
import { RUNNERS } from './runner.js';

const ctx = (modelo: string, esforco: string) => ({
  prompt: 'faça X', cwd: '/tmp',
  perfil: { motor: 'codex', modelo, esforco }, vars: {},
});

describe('mapaModelos', () => {
  it('sem CODEX_MODELOS, não mapeia nada (vale o config.toml da máquina)', () => {
    expect(mapaModelos({})).toEqual({});
    expect(mapaModelos({ CODEX_MODELOS: '  ' })).toEqual({});
  });

  it('lê pares alias=id separados por vírgula', () => {
    expect(mapaModelos({ CODEX_MODELOS: 'sonnet=gpt-5.1-codex, opus=gpt-5.6-sol' }))
      .toEqual({ sonnet: 'gpt-5.1-codex', opus: 'gpt-5.6-sol' });
  });

  it('ignora pedaço malformado em vez de derrubar o boot', () => {
    expect(mapaModelos({ CODEX_MODELOS: 'sonnet=gpt-5.1-codex,lixo,=x,y=' }))
      .toEqual({ sonnet: 'gpt-5.1-codex' });
  });
});

describe('esforcoCodex', () => {
  it('passa direto os degraus que o codex conhece', () => {
    for (const e of ['minimal', 'low', 'medium', 'high']) expect(esforcoCodex(e)).toBe(e);
  });

  // O bot tem cinco degraus e o codex quatro. Colapsar no teto é decisão
  // consciente: recusar o job seria pior que entregá-lo no máximo do motor.
  it('colapsa xhigh e max no teto do motor', () => {
    expect(esforcoCodex('xhigh')).toBe('high');
    expect(esforcoCodex('max')).toBe('high');
  });
});

describe('argumentosCodex', () => {
  it('roda em modo não-interativo, fora de repo git e sem sandbox', () => {
    const args = argumentosCodex(ctx('sonnet', 'low'));
    expect(args[0]).toBe('exec');
    expect(args).toContain('--skip-git-repo-check');
    expect(args.join(' ')).toContain('-s danger-full-access');
  });

  // O `-s` explícito é o ponto: sem ele, o comportamento do serviço passaria a
  // depender do `~/.codex/config.toml` da máquina — a mesma armadilha do PATH
  // que o CLAUDE_BIN já custou caro.
  it('não passa --model quando não há mapa: vale o config da máquina', () => {
    expect(argumentosCodex(ctx('opus', 'high'), {})).not.toContain('--model');
  });

  it('traduz o alias no id do motor quando o mapa diz', () => {
    const args = argumentosCodex(ctx('opus', 'high'), { opus: 'gpt-5.6-sol' });
    expect(args.join(' ')).toContain('--model gpt-5.6-sol');
  });

  it('leva o esforço como override de config', () => {
    expect(argumentosCodex(ctx('sonnet', 'max'))).toContain('model_reasoning_effort="high"');
  });

  it('nunca usa shell: o prompt é o ÚLTIMO argumento, sem interpolação', () => {
    const args = argumentosCodex({ ...ctx('sonnet', 'low'), prompt: 'rm -rf / ; echo oi' });
    expect(args[args.length - 1]).toBe('rm -rf / ; echo oi');
  });
});

describe('registro de motores', () => {
  it('registra "codex" em RUNNERS sem tocar em "claude"', () => {
    expect(RUNNERS.codex).toBeInstanceOf(CodexRunner);
    expect(RUNNERS.codex.nome).toBe('codex');
    expect(RUNNERS.claude?.nome).toBe('claude');
  });
});

describe('execução real de subprocesso (usa /bin/echo como binário)', () => {
  it('herda a maquinaria do ClaudeRunner e devolve o stdout', async () => {
    const r = new CodexRunner('/bin/echo');
    const saida = await r.iniciar(ctx('sonnet', 'low')).aguardar();
    expect(saida).toContain('exec');
    expect(saida).toContain('faça X');
  });
});
