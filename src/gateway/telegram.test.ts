import { describe, it, expect, vi } from 'vitest';
import { cortar, rotear, criarBot } from './telegram.js';
import type { Config } from '../config.js';

// --- cortar: portado de inemaccvbot/src/reply.ts (splitForTelegram), mesma suíte ---

describe('cortar', () => {
  it('texto curto vira um único chunk, sem alterar o conteúdo', () => {
    const text = 'oi, tudo bem?';
    expect(cortar(text)).toEqual([text]);
  });

  it('texto vazio não gera chunk nenhum', () => {
    expect(cortar('')).toEqual([]);
  });

  it('texto de 10000 chars vira vários chunks, cada um dentro do limite, nada vazio', () => {
    const text = Array.from({ length: 800 }, (_, i) => `linha ${i} com algum conteúdo de exemplo pra engordar`).join('\n');
    expect(text.length).toBeGreaterThan(10000);
    const chunks = cortar(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(4000);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('token gigante sem espaço nenhum ainda é quebrado (hard-cut de último recurso)', () => {
    const text = 'x'.repeat(9000);
    const chunks = cortar(text, 4000);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('')).toBe(text);
  });

  it('prefere quebrar em espaço quando uma linha isolada estoura o limite', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `palavra${i}`).join(' ');
    const chunks = cortar(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('')).toBe(text);
  });
});

// --- rotear: a política, sem grammy ---

describe('rotear', () => {
  it('chat fora da allowlist: retorna [], aoComando nunca é chamado, e loga a rejeição com o chatId', async () => {
    const aoComando = vi.fn(async () => 'nunca deveria rodar');
    const logs: string[] = [];
    const resultado = await rotear(
      { chatId: 999, texto: '/ping' },
      { permitido: () => false, aoComando, log: (m) => logs.push(m) },
    );
    expect(resultado).toEqual([]);
    expect(aoComando).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('999'))).toBe(true);
  });

  it('chat permitido: chama aoComando e retorna os pedaços da resposta', async () => {
    const aoComando = vi.fn(async (chatId: number, texto: string) => `resposta para ${texto} de ${chatId}`);
    const resultado = await rotear(
      { chatId: 123, texto: '/ping' },
      { permitido: () => true, aoComando, log: () => {} },
    );
    expect(aoComando).toHaveBeenCalledWith(123, '/ping');
    expect(resultado).toEqual(['resposta para /ping de 123']);
  });

  it('resposta maior que o limite produz mais de um pedaço', async () => {
    const grande = 'a'.repeat(9000);
    const aoComando = vi.fn(async () => grande);
    const resultado = await rotear(
      { chatId: 1, texto: '/fila' },
      { permitido: () => true, aoComando, log: () => {} },
    );
    expect(resultado.length).toBeGreaterThan(1);
    expect(resultado.join('')).toBe(grande);
  });

  it('aoComando lançando: retorna exatamente um pedaço genérico sem o texto do erro, e loga o erro real', async () => {
    const erroReal = 'stack trace: /home/segredo/arquivo.ts:42 falha interna XYZ';
    const aoComando = vi.fn(async () => { throw new Error(erroReal); });
    const logs: string[] = [];
    const resultado = await rotear(
      { chatId: 42, texto: '/status 1' },
      { permitido: () => true, aoComando, log: (m) => logs.push(m) },
    );
    expect(resultado.length).toBe(1);
    expect(resultado[0]).not.toContain(erroReal);
    expect(logs.some((l) => l.includes(erroReal))).toBe(true);
  });
});

// --- criarBot: única fronteira que importa grammy ---

describe('criarBot', () => {
  it('constrói o Bot e expõe um Transporte, sem I/O de rede', () => {
    // Token obviamente falso mas bem-formado (grammy só valida a FORMA na construção,
    // não faz chamada de rede — getMe só ocorre em bot.start()/bot.init(), que não chamamos aqui).
    const cfg: Config = {
      botToken: '123456:AAAA-fake-token-nao-real-1234567890AB',
      queueDb: ':memory:',
      stateDir: '/tmp',
      logFile: '/tmp/log',
      chatsPermitidos: [123],
      motorPadrao: 'claude',
      modeloPadrao: 'sonnet',
      esforcoPadrao: 'low',
    };
    const { bot, transporte } = criarBot(cfg, { aoComando: async () => 'ok' });
    expect(bot).toBeDefined();
    expect(typeof transporte.responder).toBe('function');
  });
});
