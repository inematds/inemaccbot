import { describe, expect, it } from 'vitest';

import { carregarConfig } from './config.js';

const base = {
  BOT_TOKEN: 'x:y',
  QUEUE_DB: '/tmp/q.db',
  STATE_DIR: '/tmp/estado',
  LOG_FILE: '/tmp/bot.log',
  ALLOWED_CHAT_IDS: '42, 7',
};

describe('carregarConfig', () => {
  it('lê o essencial e parseia a allowlist', () => {
    const c = carregarConfig(base);
    expect(c.botToken).toBe('x:y');
    expect(c.chatsPermitidos).toEqual([42, 7]);
  });

  it('aplica os defaults de perfil quando não vêm no ambiente', () => {
    const c = carregarConfig(base);
    expect(c.motorPadrao).toBe('claude');
    expect(c.modeloPadrao).toBe('sonnet');
    expect(c.esforcoPadrao).toBe('low');
  });

  it('respeita os defaults de perfil vindos do ambiente', () => {
    const c = carregarConfig({ ...base, MODELO_PADRAO: 'opus', ESFORCO_PADRAO: 'high' });
    expect(c.modeloPadrao).toBe('opus');
    expect(c.esforcoPadrao).toBe('high');
  });

  it('falha alto quando falta variável essencial, nomeando qual', () => {
    const { BOT_TOKEN, ...semToken } = base;
    expect(() => carregarConfig(semToken)).toThrow(/BOT_TOKEN/);
  });

  it('falha quando a allowlist está vazia — bot aberto é falha de segurança, não default', () => {
    expect(() => carregarConfig({ ...base, ALLOWED_CHAT_IDS: '' })).toThrow(/ALLOWED_CHAT_IDS/);
  });

  it('falha quando a allowlist tem entrada não numérica', () => {
    expect(() => carregarConfig({ ...base, ALLOWED_CHAT_IDS: '42,abc' })).toThrow(/abc/);
  });

  it('nunca inclui o token na mensagem de erro', () => {
    try {
      carregarConfig({ ...base, ALLOWED_CHAT_IDS: '' });
    } catch (e) {
      expect((e as Error).message).not.toContain('x:y');
    }
  });
});
