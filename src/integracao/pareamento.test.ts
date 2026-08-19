// O caminho inteiro: .env com ALLOWED_CHAT_IDS=0 -> carregarConfig -> pareamento
// -> allowlist viva + .env reescrito que sobrevive ao restart. É o teste que
// teria pego o bug de "responde pareado e rejeita a próxima mensagem", e o de
// "o .env do dono foi reescrito por cima".
import { describe, it, expect } from 'vitest';
import { carregarConfig } from '../config.js';
import { lerEnv, persistirAllowlistNoEnv } from '../index.js';
import { emPareamento } from '../gateway/pareamento.js';

const ENV_INICIAL = [
  '# preencha com o id do seu chat, ou deixe 0 para parear no primeiro /ping',
  'ALLOWED_CHAT_IDS=0',
  'BOT_TOKEN=123:abc',
  'QUEUE_DB=/tmp/q.db',
  'STATE_DIR=/tmp/state',
  'LOG_FILE=/tmp/x.log',
].join('\n') + '\n';

describe('pareamento ponta a ponta', () => {
  it('do .env sentinela ao .env com o dono, e o boot seguinte concorda', () => {
    let disco = ENV_INICIAL;

    const cfg = carregarConfig(lerEnv(disco));
    expect(cfg.chatsPermitidos).toEqual([0]);
    expect(emPareamento(cfg.chatsPermitidos)).toBe(true);

    // O que `criarBot` faz ao parear, aqui explícito: memória in-place, depois disco.
    cfg.chatsPermitidos.splice(0, cfg.chatsPermitidos.length, 4242);
    persistirAllowlistNoEnv('/casa/.env', cfg.chatsPermitidos, {
      ler: () => disco,
      escrever: (_c, t) => { disco = t; },
      renomear: () => {},
      permissao: () => {},
    });

    // Um boot futuro lê o mesmo dono do arquivo...
    const depois = carregarConfig(lerEnv(disco));
    expect(depois.chatsPermitidos).toEqual([4242]);
    // ...e não está mais em pareamento: a porta fechou.
    expect(emPareamento(depois.chatsPermitidos)).toBe(false);
    // O comentário do dono sobreviveu à reescrita.
    expect(disco).toContain('# preencha com o id do seu chat');
    // E nenhuma outra chave foi tocada.
    expect(lerEnv(disco).BOT_TOKEN).toBe('123:abc');
  });

  it('voltar ALLOWED_CHAT_IDS=0 à mão reabre o pareamento no boot seguinte', () => {
    const comDono = ENV_INICIAL.replace('ALLOWED_CHAT_IDS=0', 'ALLOWED_CHAT_IDS=4242');
    expect(emPareamento(carregarConfig(lerEnv(comDono)).chatsPermitidos)).toBe(false);

    const reaberto = comDono.replace('ALLOWED_CHAT_IDS=4242', 'ALLOWED_CHAT_IDS=0');
    expect(emPareamento(carregarConfig(lerEnv(reaberto)).chatsPermitidos)).toBe(true);
  });

  it('ALLOWED_CHAT_IDS vazio continua derrubando o boot — vazio não é pareamento', () => {
    const vazio = ENV_INICIAL.replace('ALLOWED_CHAT_IDS=0', 'ALLOWED_CHAT_IDS=');
    expect(() => carregarConfig(lerEnv(vazio))).toThrow(/ALLOWED_CHAT_IDS/);
  });
});

describe('lerEnv e o `#`', () => {
  it('corta comentário no fim da linha (o que derrubava o boot na VPS)', () => {
    const e = lerEnv('PROJETOS_DIR=/root/projetos   # default: $HOME/projetos\n');
    expect(e.PROJETOS_DIR).toBe('/root/projetos');
  });

  it('preserva o `#` que é dado, colado no valor', () => {
    expect(lerEnv('SENHA=s3nh#a\n').SENHA).toBe('s3nh#a');
    expect(lerEnv('URL=http://x/y#z\n').URL).toBe('http://x/y#z');
  });

  it('aspas protegem um valor com espaço antes do `#`', () => {
    expect(lerEnv('T="a #b"  # comentário\n').T).toBe('a #b');
  });
});
