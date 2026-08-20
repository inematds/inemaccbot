import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // O C#77 e o C#78 falharam porque o `claude` do PATH do systemd era uma
  // instalação de março que pede permissão a cada `Write`. O binário passa a
  // ser declarado, e o default é a instalação por usuário — nunca o PATH.
  it('CLAUDE_BIN default aponta para a instalação do HOME, não para o PATH', () => {
    const c = carregarConfig({ ...base, HOME: '/casa' });
    expect(c.claudeBin).toBe('/casa/.local/bin/claude');
  });

  // Os repos de domínio são clonados como irmãos do inemaccbot, então o pai do
  // clone acerta onde `$HOME/projetos` errava: VPS com o clone em /root, /opt
  // ou /srv, ou serviço rodando com outro usuário.
  it('PROJETOS_DIR default é a pasta que contém este clone, não o HOME', () => {
    const c = carregarConfig({ ...base, HOME: '/casa' });
    expect(c.projetosDir).toBe(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
    expect(c.projetosDir).not.toBe('/casa/projetos');
  });

  it('PROJETOS_DIR do ambiente manda', () => {
    expect(carregarConfig({ ...base, PROJETOS_DIR: '/srv/p' }).projetosDir).toBe('/srv/p');
  });

  it('CLAUDE_BIN do ambiente manda', () => {
    expect(carregarConfig({ ...base, CLAUDE_BIN: '/opt/claude' }).claudeBin).toBe('/opt/claude');
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
