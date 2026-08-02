import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AindaNao } from '../types.js';
import { criarHeygenBaixar, escolherUrl, lerChaveHeygen, type ClienteHeygen } from './heygen.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-heygen-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(input: string): ContextoTarefa {
  return {
    job: { input } as never,
    fila: {} as never,
    agora: () => 1_000,
    log: () => {},
    sinal: new AbortController().signal,
    aindaNao: (m: string) => { throw new AindaNao(m); },
  };
}

function cliente(over: Partial<ClienteHeygen> = {}): ClienteHeygen {
  return {
    porTitulo: async () => new Map(),
    urlDe: async () => 'https://cdn/video.mp4',
    baixar: async (_u, destino) => writeFileSync(destino, 'bytes-do-video'),
    ...over,
  };
}

const entrada = (destino: string) => JSON.stringify({ titulo: 'P16-mulheres-v1', destino });

// Quem decide se o vídeo tem legenda é o ESTÚDIO, não o bot: se o render foi
// feito com legenda, é esse vídeo que a gente quer. `video_url_caption` só vem
// preenchido quando existe render com legenda queimada — nos 25 vídeos medidos
// em 2026-08-01 (todos gravados sem legenda) ele veio nulo em todos.
describe('escolherUrl: o estúdio decide se tem legenda', () => {
  it('prefere o vídeo COM legenda quando o estúdio gravou com ela', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4', video_url_caption: 'https://cdn/legendado.mp4' }))
      .toBe('https://cdn/legendado.mp4');
  });

  it('cai no limpo quando o estúdio gravou sem legenda', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4', video_url_caption: null }))
      .toBe('https://cdn/limpo.mp4');
  });

  it('campo ausente também cai no limpo', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4' })).toBe('https://cdn/limpo.mp4');
  });

  // String vazia é o mesmo que não ter — baixar `""` viraria download HTTP
  // inválido em vez de "ainda sem url", que é o estado honesto.
  it('string vazia não conta como vídeo legendado', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4', video_url_caption: '' }))
      .toBe('https://cdn/limpo.mp4');
  });

  it('sem nenhuma das duas: null, para a fase seguir esperando', () => {
    expect(escolherUrl({})).toBe(null);
    expect(escolherUrl(undefined)).toBe(null);
  });
});

describe('heygen.baixar', () => {
  it('baixa quando o vídeo está completed', async () => {
    const destino = join(dir, 'P16-mulheres-v1.mp4');
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'completed' }]]),
    }));
    await expect(t(ctx(entrada(destino)))).resolves.toBe(destino);
    expect(readFileSync(destino, 'utf8')).toBe('bytes-do-video');
  });

  // O caso NORMAL enquanto a pessoa ainda está gerando no estúdio. Tratar isso
  // como falha queimaria as tentativas da fase em minutos.
  it('vídeo ausente vira "ainda não", não falha', async () => {
    const t = criarHeygenBaixar(cliente());
    await expect(t(ctx(entrada(join(dir, 'x.mp4'))))).rejects.toThrow(AindaNao);
  });

  it('vídeo ainda processando também é "ainda não"', async () => {
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'processing' }]]),
    }));
    await expect(t(ctx(entrada(join(dir, 'x.mp4'))))).rejects.toThrow(/processing/);
  });

  it('completed sem video_url é "ainda não" — não é erro do usuário', async () => {
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'completed' }]]),
      urlDe: async () => null,
    }));
    await expect(t(ctx(entrada(join(dir, 'x.mp4'))))).rejects.toThrow(AindaNao);
  });

  // §2.5, "procure antes de criar": sem isto uma retentativa depois de um crash
  // baixaria de novo E enfileiraria um segundo reel.
  it('arquivo já baixado é ADOTADO, sem tocar na API', async () => {
    const destino = join(dir, 'pronto.mp4');
    writeFileSync(destino, 'ja-estava-aqui');
    let chamou = false;
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => { chamou = true; return new Map(); },
    }));
    await expect(t(ctx(entrada(destino)))).resolves.toBe(destino);
    expect(chamou).toBe(false);
  });

  it('arquivo vazio no destino NÃO conta como baixado', async () => {
    const destino = join(dir, 'vazio.mp4');
    writeFileSync(destino, '');
    const t = criarHeygenBaixar(cliente());
    await expect(t(ctx(entrada(destino)))).rejects.toThrow(AindaNao);
  });

  it('download que produz arquivo vazio é FALHA, não "ainda não"', async () => {
    const destino = join(dir, 'z.mp4');
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'completed' }]]),
      baixar: async () => writeFileSync(destino, ''),
    }));
    await expect(t(ctx(entrada(destino)))).rejects.toThrow(/vazio/);
  });

  it('input incompleto falha claro', async () => {
    await expect(criarHeygenBaixar(cliente())(ctx('{}'))).rejects.toThrow(/titulo, destino/);
  });
});

describe('lerChaveHeygen', () => {
  it('lê a chave do arquivo apontado, em runtime', () => {
    expect(lerChaveHeygen('/x/.env', () => 'OUTRA=1\nHEYGEN_API_KEY="abc123"\n')).toBe('abc123');
  });

  it('erro claro quando a chave não está lá', () => {
    expect(() => lerChaveHeygen('/x/.env', () => 'NADA=1')).toThrow(/HEYGEN_API_KEY/);
  });
});
