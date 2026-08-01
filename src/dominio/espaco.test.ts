import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { humano, medirSubpastas, tamanhoDe } from './espaco.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-espaco-'));
  mkdirSync(join(dir, 'reel'), { recursive: true });
  mkdirSync(join(dir, 'fundo', 'mais'), { recursive: true });
  writeFileSync(join(dir, 'reel', 'a.mp4'), 'x'.repeat(3000));
  writeFileSync(join(dir, 'fundo', 'mais', 'b.mp4'), 'x'.repeat(1000));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tamanhoDe', () => {
  it('soma recursivamente e conta arquivos', () => {
    expect(tamanhoDe(dir)).toEqual({ bytes: 4000, arquivos: 2 });
  });

  // Medir NÃO pode derrubar o comando: pasta que não existe (ou sumiu no meio
  // da varredura) conta zero.
  it('pasta inexistente conta zero em vez de lançar', () => {
    expect(tamanhoDe(join(dir, 'nao-existe'))).toEqual({ bytes: 0, arquivos: 0 });
  });
});

describe('medirSubpastas', () => {
  it('ordena da maior para a menor', () => {
    expect(medirSubpastas(dir).map((p) => p.nome)).toEqual(['reel', 'fundo']);
  });

  it('conta o que está aninhado', () => {
    expect(medirSubpastas(dir).find((p) => p.nome === 'fundo')?.bytes).toBe(1000);
  });

  it('respeita o teto', () => {
    expect(medirSubpastas(dir, 1)).toHaveLength(1);
  });
});

describe('humano', () => {
  it.each([
    [500, '500 B'],
    [2048, '2 KB'],
    [5 * 1024 ** 2, '5 MB'],
    [Math.round(1.5 * 1024 ** 3), '1.5 GB'],
  ])('%i vira %s', (bytes, esperado) => {
    expect(humano(bytes)).toBe(esperado);
  });
});
