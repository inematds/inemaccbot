import { describe, expect, it } from 'vitest';

import { caminhoAnexo, comandoDeAnexo, nomeAnexo } from './midia.js';
import { rotearAnexo } from './telegram.js';

describe('nomeAnexo', () => {
  it('mata traversal, espaço e acento', () => {
    expect(nomeAnexo('../../etc/passwd')).toBe('passwd');
    expect(nomeAnexo('minha gravação.MP4')).toBe('minha-gravacao.mp4');
  });

  // O caminho vira parte do `input` de um job; um nome começando com "--" seria
  // lido como flag por quem re-splita argv.
  it('nunca começa com traço nem fica vazio', () => {
    expect(nomeAnexo('--force.mp4').startsWith('-')).toBe(false);
    expect(nomeAnexo('   ')).toBe('arquivo');
  });

  it('carimba o nome para não colidir', () => {
    expect(caminhoAnexo('/m', 'a.mp4', 1_700)).toBe('/m/1700-a.mp4');
  });
});

describe('comandoDeAnexo', () => {
  it('usa o caminho como entrada da skill', () => {
    expect(comandoDeAnexo('transcrever:', '/a/b.mp4')).toBe('transcrever: /a/b.mp4');
    expect(comandoDeAnexo('transcrever', '/a/b.mp4')).toBe('transcrever: /a/b.mp4');
  });

  // Colado no fim, o caminho cairia DENTRO do último campo (`| lives3 /a/b.mp4`)
  // e o parser recusaria com "campo desconhecido".
  it('entra antes dos campos, nunca no fim da linha', () => {
    expect(comandoDeAnexo('dublar: | lives3', '/a/b.mp4')).toBe('dublar: /a/b.mp4 | lives3');
  });

  it('legenda com entrada própria vence o anexo', () => {
    expect(comandoDeAnexo('transcrever: http://x', '/a/b.mp4')).toBe('transcrever: http://x');
  });

  it('sem legenda não inventa comando', () => {
    expect(comandoDeAnexo('', '/a/b.mp4')).toBe('');
  });
});

describe('rotearAnexo', () => {
  const base = { chatId: 1, fileId: 'f', nomeOriginal: 'a.mp4', legenda: 'transcrever:' };
  const log = (): void => {};

  it('chat fora da allowlist nem chega a baixar', async () => {
    let baixou = false;
    const r = await rotearAnexo(base, {
      permitido: () => false,
      baixar: async () => { baixou = true; return '/x'; },
      aoComando: async () => 'ok',
      log,
    });
    expect(r).toEqual([]);
    expect(baixou).toBe(false);
  });

  it('baixa e manda a legenda já com o caminho para o roteador', async () => {
    let recebido = '';
    await rotearAnexo(base, {
      permitido: () => true,
      baixar: async () => '/midia/1-a.mp4',
      aoComando: async (_c, texto) => { recebido = texto; return 'enfileirado'; },
      log,
    });
    expect(recebido).toBe('transcrever: /midia/1-a.mp4');
  });

  it('sem legenda, confirma o recebimento com o caminho (é o que torna `thumb` alcançável)', async () => {
    const r = await rotearAnexo({ ...base, legenda: '' }, {
      permitido: () => true,
      baixar: async () => '/midia/1-a.mp4',
      aoComando: async () => 'não deveria ser chamado',
      log,
    });
    expect(r.join('')).toContain('/midia/1-a.mp4');
  });

  // A URL da API carrega o token no path: o erro dela nunca pode ir pro chat.
  it('falha de download responde genérico, sem detalhe da API', async () => {
    const r = await rotearAnexo(base, {
      permitido: () => true,
      baixar: async () => { throw new Error('HTTP 401 em https://api.telegram.org/bot123:SEGREDO/getFile'); },
      aoComando: async () => 'ok',
      log,
    });
    expect(r.join('')).not.toContain('SEGREDO');
    expect(r.join('')).toContain('não consegui baixar');
  });

  // `capa` é a exceção: a legenda diz ONDE a imagem vai e o anexo É a imagem.
  it('capa mantém o caminho do anexo como campo', () => {
    expect(comandoDeAnexo('capa: A#22 jovens', '/midia/x.png'))
      .toBe('capa: A#22 jovens | arquivo=/midia/x.png');
  });

  it('capa sem alvo continua com o caminho como entrada', () => {
    expect(comandoDeAnexo('capa', '/midia/x.png')).toBe('capa: /midia/x.png');
  });
});
