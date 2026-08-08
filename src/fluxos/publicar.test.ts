import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publicarVideo } from './publicar.js';

let dir: string;
let origem: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-pub-'));
  origem = join(dir, 'artefato', 'reel.mp4');
  mkdirSync(join(dir, 'artefato'), { recursive: true });
  writeFileSync(origem, 'video');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BASES = ['http://rede.club:8202'];

describe('publicarVideo', () => {
  it('põe o vídeo numa subpasta por FLUXO', () => {
    const p = publicarVideo(origem, 'A9-jovens-v1', join(dir, 'pub'), BASES, 'promoavatar')!;
    expect(existsSync(join(dir, 'pub', 'promoavatar', 'A9-jovens-v1.mp4'))).toBe(true);
    expect(p.links[0]).toBe('http://rede.club:8202/promoavatar/A9-jovens-v1.mp4');
  });

  // Dois fluxos, duas pastas: é o que permite limpar um sem tocar no outro.
  it('fluxos diferentes não se misturam', () => {
    publicarVideo(origem, 'A9-jovens-v1', join(dir, 'pub'), BASES, 'promoavatar');
    publicarVideo(origem, 'C3-jovens-v1', join(dir, 'pub'), BASES, 'promoavatar3');
    expect(existsSync(join(dir, 'pub', 'promoavatar', 'A9-jovens-v1.mp4'))).toBe(true);
    expect(existsSync(join(dir, 'pub', 'promoavatar3', 'C3-jovens-v1.mp4'))).toBe(true);
  });

  it('sem subpasta, cai na raiz (compatível com o que já existia)', () => {
    const p = publicarVideo(origem, 'A9-jovens-v1', join(dir, 'pub'), BASES)!;
    expect(p.links[0]).toBe('http://rede.club:8202/A9-jovens-v1.mp4');
  });

  // O alvo vem do `flow.json`, que é editável por fora: um tipo com barra não
  // pode escrever fora da pasta publicada.
  it('não deixa o nome do fluxo escapar da pasta', () => {
    const p = publicarVideo(origem, 'A9-x-v1', join(dir, 'pub'), BASES, '../../etc')!;
    expect(p.arquivo.startsWith(join(dir, 'pub'))).toBe(true);
  });

  it('artefato ausente devolve undefined em vez de link quebrado', () => {
    expect(publicarVideo(join(dir, 'nao-existe.mp4'), 'A9-x-v1', join(dir, 'pub'), BASES, 'promoavatar')).toBeUndefined();
  });

  it('sem base de URL não publica', () => {
    expect(publicarVideo(origem, 'A9-x-v1', join(dir, 'pub'), [], 'promoavatar')).toBeUndefined();
  });
});
