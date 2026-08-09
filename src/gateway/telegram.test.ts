import { describe, it, expect, vi } from 'vitest';
import type { Bot } from 'grammy';
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

  // --- pareamento: a exceção à rejeição, só enquanto o bot não tem dono ---

  it('em pareamento, /ping de chat desconhecido pareia e responde', async () => {
    const log = vi.fn();
    const parear = vi.fn(() => 'Pareado. id 4242');
    const aoComando = vi.fn();

    const r = await rotear(
      { chatId: 4242, texto: '/ping' },
      { permitido: () => false, aoComando, log, parear },
    );

    expect(r).toEqual(['Pareado. id 4242']);
    expect(parear).toHaveBeenCalledWith(4242);
    // O comando NÃO roda nesta mensagem: parear é o efeito, e só.
    expect(aoComando).not.toHaveBeenCalled();
  });

  it('em pareamento, mensagem que não é /ping continua rejeitada em silêncio', async () => {
    const log = vi.fn();
    const parear = vi.fn(() => 'nunca');

    const r = await rotear(
      { chatId: 4242, texto: '/fila' },
      { permitido: () => false, aoComando: vi.fn(), log, parear },
    );

    expect(r).toEqual([]);
    expect(parear).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('gateway: mensagem rejeitada — chat 4242 fora da allowlist');
  });

  it('`parear` devolvendo null (bot já tem dono) cai na rejeição normal', async () => {
    const log = vi.fn();

    const r = await rotear(
      { chatId: 4242, texto: '/ping' },
      { permitido: () => false, aoComando: vi.fn(), log, parear: () => null },
    );

    expect(r).toEqual([]);
    expect(log).toHaveBeenCalledWith('gateway: mensagem rejeitada — chat 4242 fora da allowlist');
  });

  it('sem `parear` (fora de pareamento), /ping de desconhecido é silêncio — nunca ecoa o id', async () => {
    const log = vi.fn();

    const r = await rotear(
      { chatId: 4242, texto: '/ping' },
      { permitido: () => false, aoComando: vi.fn(), log },
    );

    expect(r).toEqual([]);
    expect(log).toHaveBeenCalledWith('gateway: mensagem rejeitada — chat 4242 fora da allowlist');
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
      heygenEnvPath: '/tmp/heygen-inexistente.env', heygenCli: 'heygen', heygenPerfilChrome: '/tmp/perfil-heygen',
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
      heygenEnvPath: '/tmp/heygen-inexistente.env', heygenCli: 'heygen', heygenPerfilChrome: '/tmp/perfil-heygen',
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

  // --- pareamento pela fiação real: cfg vivo + persistência injetada ---

  /** Config mínima com a allowlist que o teste quiser. Os demais campos não
   *  participam do pareamento — só precisam existir. */
  function cfgCom(chatsPermitidos: number[]): Config {
    return {
      botToken: '123456:AAAA-fake-token-nao-real-1234567890AB',
      queueDb: ':memory:',
      stateDir: '/tmp',
      logFile: '/tmp/log',
      chatsPermitidos,
      motorPadrao: 'claude',
      modeloPadrao: 'sonnet',
      esforcoPadrao: 'low', publicoDir: '/tmp/publico', publicoUrls: [],
      projetosDir: '/tmp/projetos-inexistente',
      heygenEnvPath: '/tmp/heygen-inexistente.env', heygenCli: 'heygen', heygenPerfilChrome: '/tmp/perfil-heygen',
    };
  }

  /** Despacha um texto pelo caminho real do grammy, sem rede: `botInfo` evita o
   *  getMe(), e o transformer intercepta o sendMessage que o `ctx.reply` faria. */
  async function simularTexto(bot: Bot, chatId: number, texto: string): Promise<string[]> {
    const enviados: string[] = [];
    bot.botInfo = {
      id: 1, is_bot: true, first_name: 'teste', username: 'teste_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
      has_topics_enabled: false, allows_users_to_create_topics: false,
      can_manage_bots: false, supports_join_request_queries: false,
    };
    bot.api.config.use(async (_prev, metodo, carga) => {
      if (metodo === 'sendMessage') enviados.push(String((carga as { text: string }).text));
      return { ok: true, result: { message_id: 1 } } as never;
    });
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Date.now() / 1000,
        chat: { id: chatId, type: 'private', first_name: 'x' },
        from: { id: chatId, is_bot: false, first_name: 'x' },
        text: texto,
      },
    });
    return enviados;
  }

  it('pareia: muta a allowlist em memória e persiste, e o comando não roda nessa mensagem', async () => {
    const cfg = cfgCom([0]);
    const persistirAllowlist = vi.fn();
    const aoComando = vi.fn(async () => 'pong');

    const { bot } = criarBot(cfg, { aoComando, log: vi.fn(), persistirAllowlist });
    const enviados = await simularTexto(bot, 4242, '/ping');

    expect(cfg.chatsPermitidos).toEqual([4242]);
    expect(persistirAllowlist).toHaveBeenCalledWith([4242]);
    expect(enviados.join('')).toContain('4242');
    expect(aoComando).not.toHaveBeenCalled();
  });

  it('a allowlist mutada vale NA HORA: a mensagem seguinte do mesmo chat já roda o comando', async () => {
    // É o bug que este desenho existe pra evitar — persistir só no arquivo faria
    // o bot dizer "pareado" e rejeitar a próxima mensagem até reiniciar.
    const cfg = cfgCom([0]);
    const aoComando = vi.fn(async () => 'pong');

    const { bot } = criarBot(cfg, { aoComando, log: vi.fn(), persistirAllowlist: vi.fn() });
    await simularTexto(bot, 4242, '/ping');
    await simularTexto(bot, 4242, '/fila');

    expect(aoComando).toHaveBeenCalledWith(4242, '/fila');
  });

  it('depois de pareado, um segundo chat NÃO entra', async () => {
    const cfg = cfgCom([0]);
    const { bot } = criarBot(cfg, { aoComando: vi.fn(async () => 'pong'), log: vi.fn(), persistirAllowlist: vi.fn() });

    await simularTexto(bot, 4242, '/ping');
    const enviados = await simularTexto(bot, 9999, '/ping');

    expect(cfg.chatsPermitidos).toEqual([4242]);
    expect(enviados).toEqual([]);
  });

  it('falha ao persistir NÃO derruba o pareamento em memória, e loga o valor a pôr na mão', async () => {
    const linhas: string[] = [];
    const cfg = cfgCom([0]);
    const persistirAllowlist = vi.fn(() => { throw new Error('EROFS'); });

    const { bot } = criarBot(cfg, {
      aoComando: vi.fn(async () => 'pong'),
      log: (m) => linhas.push(m),
      persistirAllowlist,
    });
    await simularTexto(bot, 4242, '/ping');

    expect(cfg.chatsPermitidos).toEqual([4242]);
    expect(linhas.some((l) => l.includes('EROFS') && l.includes('ALLOWED_CHAT_IDS=4242'))).toBe(true);
  });

  it('allowlist real não abre pareamento: chat desconhecido continua no silêncio', async () => {
    const cfg = cfgCom([123]);
    const persistirAllowlist = vi.fn();

    const { bot } = criarBot(cfg, { aoComando: vi.fn(async () => 'pong'), log: vi.fn(), persistirAllowlist });
    const enviados = await simularTexto(bot, 4242, '/ping');

    expect(enviados).toEqual([]);
    expect(persistirAllowlist).not.toHaveBeenCalled();
    expect(cfg.chatsPermitidos).toEqual([123]);
  });
});
