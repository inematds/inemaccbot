import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planejarLimpeza, type JobResumo } from './limpeza.js';

let dir: string;
let art: string;
let pub: string;
const AGORA = 1_700_000_000_000;
const DIA = 24 * 60 * 60 * 1000;

const FLUXOS = [
  { id: 8, prefixo: 'A', tipo: 'promoavatar' },
  { id: 9, prefixo: 'A', tipo: 'promoavatar' },
  { id: 3, prefixo: 'C', tipo: 'promoavatar3' },
];

/** Grava com mtime FIXO relativo ao relógio fictício: sem isso a fixture nasce
 * com a hora real e nenhum corte por idade é testável. */
function arquivo(caminho: string, tamanho: number, idadeMs = 60 * 60 * 1000): void {
  mkdirSync(join(caminho, '..'), { recursive: true });
  writeFileSync(caminho, 'x'.repeat(tamanho));
  const quando = new Date(AGORA - idadeMs);
  utimesSync(caminho, quando, quando);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-limpeza-'));
  art = join(dir, 'artefatos');
  pub = join(dir, 'output');
  arquivo(join(art, 'reel', '34.mp4'), 100);      // do A#8
  arquivo(join(art, 'reel', '99.mp4'), 50);       // do chat direto
  arquivo(join(art, 'fluxos', 'A8', 'av.mp4'), 200);
  arquivo(join(art, 'fluxos', 'A9', 'av.mp4'), 300);
  arquivo(join(pub, 'promoavatar', 'A8-jovens-v1.mp4'), 400);
  arquivo(join(pub, 'promoavatar', 'A9-jovens-v1.mp4'), 500);
  arquivo(join(pub, 'promoavatar3', 'C3-jovens-v1.mp4'), 600);
  arquivo(join(pub, 'criancas', 'nao-e-nosso.mp4'), 9999);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const JOBS: JobResumo[] = [
  { flow_ref: 'A#8/jovens/reel', resultado: '', status: 'done' },
  { flow_ref: null, resultado: '', status: 'done' },
];

function planejar(escopo: string, dias?: number) {
  const jobs: JobResumo[] = [
    { ...JOBS[0]!, resultado: join(art, 'reel', '34.mp4') },
    { ...JOBS[1]!, resultado: join(art, 'reel', '99.mp4') },
  ];
  return planejarLimpeza({
    escopo, ...(dias !== undefined ? { dias } : {}),
    jobs, fluxos: FLUXOS, raizArtefatos: art, publicoDir: pub, agoraMs: AGORA,
  });
}

describe('escopo por FLUXO', () => {
  it('pega artefato, avatares e publicados só daquele fluxo', () => {
    const { itens } = planejar('A#8');
    const caminhos = itens.map((i) => i.caminho);
    expect(caminhos).toContain(join(art, 'reel', '34.mp4'));
    expect(caminhos).toContain(join(art, 'fluxos', 'A8'));
    expect(caminhos).toContain(join(pub, 'promoavatar', 'A8-jovens-v1.mp4'));
  });

  // O recorte tem que ser EXATO: o A#9 estava rodando quando o A#8 foi limpo.
  it('não encosta em outro fluxo', () => {
    const caminhos = planejar('A#8').itens.map((i) => i.caminho).join('|');
    expect(caminhos).not.toContain('A9');
    expect(caminhos).not.toContain('P3');
  });

  it('nem no que veio do chat direto', () => {
    expect(planejar('A#8').itens.map((i) => i.caminho)).not.toContain(join(art, 'reel', '99.mp4'));
  });

  it('aceita a8 sem o #', () => {
    expect(planejar('a8').itens.length).toBe(planejar('A#8').itens.length);
  });

  it('fluxo inexistente é erro, não lista vazia', () => {
    expect(planejar('A#77').erro).toContain('não existe');
  });
});

describe('escopo por TIPO', () => {
  it('promoavatar pega A#8 e A#9, e não o promoavatar3', () => {
    const caminhos = planejar('promoavatar').itens.map((i) => i.caminho).join('|');
    expect(caminhos).toContain('A8');
    expect(caminhos).toContain('A9');
    expect(caminhos).not.toContain('P3');
  });

  it('promoavatar3 pega só o dele', () => {
    const caminhos = planejar('promoavatar3').itens.map((i) => i.caminho).join('|');
    expect(caminhos).toContain('C3-jovens-v1.mp4');
    expect(caminhos).not.toContain('A8');
  });
});

describe('escopo por IDADE', () => {
  it('sem arquivo velho, não propõe nada', () => {
    expect(planejar('artefatos', 14).itens).toHaveLength(0);
  });

  it('com dias=0 pega tudo da área do bot', () => {
    const caminhos = planejar('artefatos', 0).itens.map((i) => i.caminho);
    expect(caminhos).toContain(join(art, 'reel', '99.mp4'));
  });

  it('nunca sai da área do BOT', () => {
    const caminhos = planejar('artefatos', 0).itens.map((i) => i.caminho).join('|');
    expect(caminhos).not.toContain('output');
  });
});

describe('tudo', () => {
  it('junta artefatos e publicados dos fluxos conhecidos', () => {
    const caminhos = planejar('tudo').itens.map((i) => i.caminho).join('|');
    expect(caminhos).toContain(join(art, 'reel', '99.mp4'));
    expect(caminhos).toContain('promoavatar');
    expect(caminhos).toContain('promoavatar3');
  });

  // A regra que protege 159 GB: o bot só toca no que ele publicou.
  it('NÃO toca no que não é do bot em output/', () => {
    expect(planejar('tudo').itens.map((i) => i.caminho).join('|')).not.toContain('criancas');
  });
});

describe('escopo desconhecido', () => {
  it('ensina os escopos válidos em vez de apagar algo', () => {
    const r = planejar('xpto');
    expect(r.itens).toHaveLength(0);
    expect(r.erro).toContain('promoavatar');
  });
});

describe('idade', () => {
  it('arquivo mais velho que o corte entra', () => {
    const velho = join(art, 'reel', 'antigo.mp4');
    arquivo(velho, 10, 30 * DIA);
    expect(planejar('artefatos', 14).itens.map((i) => i.caminho)).toContain(velho);
  });
});
