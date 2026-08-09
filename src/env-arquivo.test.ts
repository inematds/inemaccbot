import { describe, it, expect, vi } from 'vitest';
import { trocarValorEnv, gravarEnv, type EscritaEnv } from './env-arquivo.js';

describe('trocarValorEnv', () => {
  it('troca só a linha da chave e preserva comentários, ordem e demais linhas', () => {
    const antes = [
      '# allowlist: quem pode falar com o bot',
      'BOT_TOKEN=123:abc',
      'ALLOWED_CHAT_IDS=0',
      '',
      'LOG_FILE=/tmp/x.log',
    ].join('\n');

    const depois = trocarValorEnv(antes, 'ALLOWED_CHAT_IDS', '4242');

    expect(depois).toBe([
      '# allowlist: quem pode falar com o bot',
      'BOT_TOKEN=123:abc',
      'ALLOWED_CHAT_IDS=4242',
      '',
      'LOG_FILE=/tmp/x.log',
    ].join('\n'));
  });

  it('acrescenta a chave no fim quando ela não existe, sem duplicar quebra de linha', () => {
    expect(trocarValorEnv('BOT_TOKEN=1\n', 'ALLOWED_CHAT_IDS', '7'))
      .toBe('BOT_TOKEN=1\nALLOWED_CHAT_IDS=7\n');
  });

  it('não confunde chave que é prefixo de outra', () => {
    const antes = 'ALLOWED_CHAT_IDS_ANTIGO=9\nALLOWED_CHAT_IDS=0\n';
    expect(trocarValorEnv(antes, 'ALLOWED_CHAT_IDS', '5'))
      .toBe('ALLOWED_CHAT_IDS_ANTIGO=9\nALLOWED_CHAT_IDS=5\n');
  });

  it('ignora a chave dentro de comentário', () => {
    const antes = '# ALLOWED_CHAT_IDS=exemplo\nALLOWED_CHAT_IDS=0\n';
    expect(trocarValorEnv(antes, 'ALLOWED_CHAT_IDS', '5'))
      .toBe('# ALLOWED_CHAT_IDS=exemplo\nALLOWED_CHAT_IDS=5\n');
  });
});

describe('gravarEnv', () => {
  it('escreve em arquivo temporário, renomeia por cima e deixa em 0600', () => {
    const ordem: string[] = [];
    const io: EscritaEnv = {
      escrever: vi.fn((c: string, t: string) => { ordem.push(`escrever:${c}:${t}`); }),
      renomear: vi.fn((de: string, para: string) => { ordem.push(`renomear:${de}->${para}`); }),
      permissao: vi.fn((c: string, m: number) => { ordem.push(`permissao:${c}:${m.toString(8)}`); }),
    };

    gravarEnv('/casa/.env', 'X=1\n', io);

    expect(io.escrever).toHaveBeenCalledWith('/casa/.env.tmp', 'X=1\n');
    expect(io.renomear).toHaveBeenCalledWith('/casa/.env.tmp', '/casa/.env');
    expect(io.permissao).toHaveBeenCalledWith('/casa/.env', 0o600);
    // O rename tem que vir DEPOIS da escrita: é ele que torna a troca atômica.
    expect(ordem[0]).toBe('escrever:/casa/.env.tmp:X=1\n');
    expect(ordem[1]).toBe('renomear:/casa/.env.tmp->/casa/.env');
  });
});
