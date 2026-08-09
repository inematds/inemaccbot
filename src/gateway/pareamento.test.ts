import { describe, it, expect } from 'vitest';
import { emPareamento, ehPingDePareamento, mensagemDePareamento } from './pareamento.js';

describe('emPareamento', () => {
  it('só é verdade quando a allowlist é exatamente [0]', () => {
    expect(emPareamento([0])).toBe(true);
  });

  it('allowlist real não está em pareamento', () => {
    expect(emPareamento([4242])).toBe(false);
  });

  it('0 misturado com id real NÃO abre pareamento', () => {
    // Senão um .env com "0,4242" viraria porta aberta sem ninguém pedir.
    expect(emPareamento([0, 4242])).toBe(false);
  });

  it('lista vazia não está em pareamento (vazio é erro de boot, não estado)', () => {
    expect(emPareamento([])).toBe(false);
  });
});

describe('ehPingDePareamento', () => {
  it('aceita /ping', () => {
    expect(ehPingDePareamento('/ping')).toBe(true);
  });

  it('aceita /ping com espaços em volta', () => {
    expect(ehPingDePareamento('  /ping  ')).toBe(true);
  });

  it('aceita o sufixo @nome_do_bot que o Telegram acrescenta em grupo', () => {
    expect(ehPingDePareamento('/ping@inemaccbot')).toBe(true);
  });

  it('recusa qualquer outro comando', () => {
    expect(ehPingDePareamento('/fila')).toBe(false);
    expect(ehPingDePareamento('oi')).toBe(false);
    expect(ehPingDePareamento('/pingar')).toBe(false);
    expect(ehPingDePareamento('/ping agora')).toBe(false);
  });
});

describe('mensagemDePareamento', () => {
  it('confirma, mostra o id e ensina a trocar de dono', () => {
    const m = mensagemDePareamento(4242);
    expect(m).toContain('4242');
    expect(m).toContain('ALLOWED_CHAT_IDS');
  });
});
