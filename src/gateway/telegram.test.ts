import { describe, it, expect, vi } from 'vitest';
import { cortar, rotear, criarBot, enviarPedacos } from './telegram.js';
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

// --- enviarPedacos: drena os pedaços sequencialmente, na ordem ---

describe('enviarPedacos', () => {
  it('três pedaços: enviar é chamado exatamente três vezes, na ordem', async () => {
    const chamadas: string[] = [];
    const enviar = vi.fn(async (t: string) => { chamadas.push(t); });
    await enviarPedacos(enviar, ['a', 'b', 'c']);
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(chamadas).toEqual(['a', 'b', 'c']);
  });

  it('um pedaço: exatamente uma chamada', async () => {
    const enviar = vi.fn(async () => {});
    await enviarPedacos(enviar, ['único']);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('zero pedaços: nenhuma chamada (caminho não autorizado não deve gerar mensagem vazia)', async () => {
    const enviar = vi.fn(async () => {});
    await enviarPedacos(enviar, []);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('ordem de CONCLUSÃO respeita a ordem de entrada mesmo sob latência assíncrona variável — ' +
    'uma implementação paralela (map sem await) terminaria fora de ordem e faria este teste falhar',
  async () => {
    // Cada `enviar` só resolve quando o teste manda (`resolvers`), com atrasos deliberadamente
    // invertidos: o pedaço 'a' (primeiro) resolve por ÚLTIMO, 'c' (último) resolve PRIMEIRO. Uma
    // implementação sequencial (await dentro do for) nunca chega a chamar `enviar('b')` antes de
    // `enviar('a')` ter resolvido — então a ordem de CONCLUSÃO fica 'a','b','c' de qualquer jeito.
    // Uma implementação paralela chamaria as três de uma vez e completaria 'c','b','a'.
    const resolvers: Array<() => void> = [];
    const concluidos: string[] = [];
    const enviar = vi.fn((t: string) => new Promise<void>((resolve) => {
      resolvers.push(() => { concluidos.push(t); resolve(); });
    }));

    const promessa = enviarPedacos(enviar, ['a', 'b', 'c']);

    // Só o primeiro `enviar` foi chamado até aqui — prova que a implementação é sequencial
    // (se fosse `map`, as três já teriam sido chamadas nesta linha).
    expect(enviar).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await Promise.resolve(); // deixa o loop `for...of` avançar até a próxima chamada
    await Promise.resolve();

    expect(enviar).toHaveBeenCalledTimes(2);
    resolvers[1]();
    await Promise.resolve();
    await Promise.resolve();

    expect(enviar).toHaveBeenCalledTimes(3);
    resolvers[2]();

    await promessa;
    expect(concluidos).toEqual(['a', 'b', 'c']);
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
      esforcoPadrao: 'low', publicoDir: '/tmp/publico', publicoUrls: [],
      projetosDir: '/tmp/projetos-inexistente',
      heygenEnvPath: '/tmp/heygen-inexistente.env',
    };
    const { bot, transporte } = criarBot(cfg, { aoComando: async () => 'ok' });
    expect(bot).toBeDefined();
    expect(typeof transporte.responder).toBe('function');
  });

  it('usa o logger injetado (nunca console) para logar a rejeição de chat fora da allowlist', async () => {
    // `botInfo` pré-preenchido evita a chamada de rede getMe() que o grammy faria
    // em bot.init(); `handleUpdate` despacha o update sintético direto pros
    // handlers, sem polling nem rede — é a fronteira mais funda alcançável sem tocar Telegram.
    const cfg: Config = {
      botToken: '123456:AAAA-fake-token-nao-real-1234567890AB',
      queueDb: ':memory:',
      stateDir: '/tmp',
      logFile: '/tmp/log',
      chatsPermitidos: [123], // chat 999 abaixo fica de fora de propósito
      motorPadrao: 'claude',
      modeloPadrao: 'sonnet',
      esforcoPadrao: 'low', publicoDir: '/tmp/publico', publicoUrls: [],
      projetosDir: '/tmp/projetos-inexistente',
      heygenEnvPath: '/tmp/heygen-inexistente.env',
    };

    const linhas: string[] = [];
    const log = (m: string): void => { linhas.push(m); };

    const { bot } = criarBot(cfg, { aoComando: async () => 'nao deveria ser chamado', log });
    bot.botInfo = {
      id: 1, is_bot: true, first_name: 'teste', username: 'teste_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
      has_topics_enabled: false, allows_users_to_create_topics: false,
      can_manage_bots: false, supports_join_request_queries: false,
    };

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Date.now() / 1000,
        chat: { id: 999, type: 'private', first_name: 'x' },
        from: { id: 999, is_bot: false, first_name: 'x' },
        text: 'oi',
      },
    });

    expect(linhas).toEqual(['gateway: mensagem rejeitada — chat 999 fora da allowlist']);
  });
});
