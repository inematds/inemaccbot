import { describe, expect, it } from 'vitest';
import { comCapa } from './capa.js';

const MD = [
  'Formato escolhido: afirmação provocativa',
  '',
  '## FALA',
  'Uma IA da OpenAI resolveu dez problemas.',
  '',
  '## IMAGENS',
  'IMAGEM 1 — "Uma IA da OpenAI resolveu" [ATENÇÃO/capa]',
  'An old chalkboard covered in crossed-out equations',
  '',
  'IMAGEM 2 — "Não foi sorte"',
  'A floor buried in crumpled paper',
  '',
  '## ESTRUTURA',
  'Dor, virada, prova.',
].join('\n');

describe('comCapa — trocar a imagem de um segmento pela enviada no chat', () => {
  it('põe o arquivo logo abaixo do cabeçalho da IMAGEM pedida', () => {
    const r = comCapa(MD, { n: 1, arquivo: '/midia/capa.png' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('IMAGEM 1 — "Uma IA da OpenAI resolveu" [ATENÇÃO/capa]\narquivo: /midia/capa.png');
    expect(r.segmento).toBe('Uma IA da OpenAI resolveu');
    expect(r.substituiu).toBe(false);
  });

  it('não encosta nas outras imagens nem no resto do arquivo', () => {
    const r = comCapa(MD, { n: 1, arquivo: '/midia/capa.png' });
    if (!r.ok) throw new Error('esperava ok');
    expect(r.texto).toContain('IMAGEM 2 — "Não foi sorte"\nA floor buried in crumpled paper');
    expect(r.texto).toContain('## ESTRUTURA');
    expect(r.texto).toContain('Formato escolhido: afirmação provocativa');
  });

  it('o prompt continua ali, apenas ignorado por quem gera', () => {
    const r = comCapa(MD, { n: 2, arquivo: '/midia/x.png' });
    if (!r.ok) throw new Error('esperava ok');
    expect(r.texto).toContain('A floor buried in crumpled paper');
  });

  it('`cover` sai como linha própria; o default não escreve modo', () => {
    const semModo = comCapa(MD, { n: 1, arquivo: '/a.png' });
    const comModo = comCapa(MD, { n: 1, arquivo: '/a.png', modo: 'cover' });
    if (!semModo.ok || !comModo.ok) throw new Error('esperava ok');
    expect(semModo.texto).not.toContain('modo:');
    expect(comModo.texto).toContain('arquivo: /a.png\nmodo: cover');
  });

  // Trocar de capa é comum: manda uma, olha o resultado, manda outra. Se as
  // linhas antigas ficassem, o parser da skill pegaria a PRIMEIRA — a velha.
  it('trocar a capa de novo substitui, não acumula', () => {
    const um = comCapa(MD, { n: 1, arquivo: '/velha.png', modo: 'cover' });
    if (!um.ok) throw new Error('esperava ok');
    const dois = comCapa(um.texto, { n: 1, arquivo: '/nova.png' });
    if (!dois.ok) throw new Error('esperava ok');
    expect(dois.substituiu).toBe(true);
    expect(dois.texto).toContain('arquivo: /nova.png');
    expect(dois.texto).not.toContain('/velha.png');
    expect(dois.texto).not.toContain('modo: cover');
    expect(dois.texto.match(/arquivo:/g)).toHaveLength(1);
  });

  // Recusar é melhor que escrever linha órfã: a imagem seria gerada
  // normalmente e a pessoa só descobriria no vídeo pronto.
  it('recusa imagem que não existe, dizendo quais existem', () => {
    const r = comCapa(MD, { n: 9, arquivo: '/x.png' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('não existe IMAGEM 9');
    expect(r.erro).toContain('1, 2');
  });

  it('recusa texto sem seção IMAGENS e explica o porquê', () => {
    const r = comCapa('## FALA\noi\n', { n: 1, arquivo: '/x.png' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('não tem seção');
    expect(r.erro).toContain('Refaça a fase de texto');
  });

  it('não vaza para uma seção seguinte que também tenha "IMAGEM"', () => {
    const md = `${MD}\n\n## NOTAS\nIMAGEM 3 — "citada de passagem"\n`;
    const r = comCapa(md, { n: 3, arquivo: '/x.png' });
    expect(r.ok).toBe(false);
  });
});
