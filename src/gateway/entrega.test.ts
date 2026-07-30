import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LIMITE_TEXTO_BYTES, copiarParaDestino, nomeSeguro, planejarEntrega,
} from './entrega.js';

let dir: string;
let destino: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-entrega-'));
  destino = join(dir, 'destino');
  mkdirSync(destino);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function arquivo(nome: string, conteudo: string): string {
  const p = join(dir, nome);
  writeFileSync(p, conteudo);
  return p;
}

describe('nomeSeguro', () => {
  it('mata diretório embutido e traversal', () => {
    expect(nomeSeguro('../../etc/passwd')).toBe('passwd');
    expect(nomeSeguro('/abs/a b.txt')).toBe('a-b.txt');
  });

  it('nunca devolve vazio', () => {
    expect(nomeSeguro('   ')).toBe('arquivo');
    expect(nomeSeguro('...')).toBe('arquivo');
  });
});

describe('copiarParaDestino', () => {
  it('copia com nome sanitizado', () => {
    const final = copiarParaDestino(arquivo('a b.txt', 'x'), destino);
    expect(basename(final)).toBe('a-b.txt');
    expect(existsSync(final)).toBe(true);
  });

  it('adota o arquivo já entregue em vez de multiplicar cópias (retentativa)', () => {
    const src = arquivo('a.txt', 'conteudo');
    expect(copiarParaDestino(src, destino)).toBe(copiarParaDestino(src, destino));
  });

  it('sufixa quando existe outro arquivo de mesmo nome e tamanho diferente', () => {
    writeFileSync(join(destino, 'a.txt'), 'outra coisa bem maior');
    const final = copiarParaDestino(arquivo('a.txt', 'x'), destino);
    expect(basename(final)).toBe('a-1.txt');
  });
});

describe('planejarEntrega', () => {
  it('texto curto vai como CONTEÚDO — caminho no disco não serve no celular', () => {
    const e = planejarEntrega(arquivo('t.txt', 'a transcrição inteira'));
    expect(e.mensagem).toBe('a transcrição inteira');
    expect(e.anexo).toBeUndefined();
  });

  it('texto grande vai como anexo, não como parede de texto', () => {
    const e = planejarEntrega(arquivo('t.txt', 'x'.repeat(LIMITE_TEXTO_BYTES + 1)));
    expect(e.anexo).toBeDefined();
  });

  // A faixa onde vivem as transcrições REAIS (uns 20 KB = ~15 min de fala).
  // Com o limite antigo (100 KB) isto virava ~5 mensagens seguidas — e uma de
  // 40 min, ~25, o que o Telegram corta no meio. O teste fixa o limiar na
  // fronteira certa: uma mensagem.
  it('transcrição de tamanho real (20 KB) vai como ANEXO, não em N mensagens', () => {
    const e = planejarEntrega(arquivo('real.txt', 'a fala '.repeat(3_000)));
    expect(e.anexo).toBeDefined();
  });

  it('o que cabe numa mensagem continua chegando como texto legível', () => {
    const e = planejarEntrega(arquivo('curta.txt', 'x'.repeat(LIMITE_TEXTO_BYTES - 1)));
    expect(e.anexo).toBeUndefined();
    expect(e.mensagem.length).toBeLessThanOrEqual(LIMITE_TEXTO_BYTES);
  });

  it('binário dentro do limite vira anexo', () => {
    const e = planejarEntrega(arquivo('v.mp4', 'bytes'));
    expect(e.anexo).toContain('v.mp4');
  });

  it('com destino, copia e responde o caminho final — sem anexar', () => {
    const e = planejarEntrega(arquivo('v.mp4', 'bytes'), destino);
    expect(e.mensagem).toContain(destino);
    expect(e.anexo).toBeUndefined();
    expect(existsSync(join(destino, 'v.mp4'))).toBe(true);
  });

  // Acontece de verdade: o agente declara `RESULT:` e o arquivo não está lá.
  // Mandar um caminho quebrado seria pior que dizer o que houve.
  it('artefato ausente é dito com todas as letras', () => {
    expect(planejarEntrega(join(dir, 'fantasma.txt')).mensagem).toMatch(/não está lá/);
  });

  it('resultado vazio não explode', () => {
    expect(planejarEntrega('').mensagem).toMatch(/sem artefato/);
  });
});
