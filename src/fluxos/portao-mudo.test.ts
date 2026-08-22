// Dois defeitos que deixavam o portão do musicavideo ABRIR MUDO — o plano, a
// música e a capa nunca chegavam ao chat, e o `/dados` também não os reentregava.
//
// Os dois só aparecem num fluxo cujas fases são TODAS de escopo `fluxo`: o
// promoavatar tem alvos, e por isso passava.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolverMostrar, ultimoCampo } from './runtime.js';

describe('ultimoCampo', () => {
  it('vale a ÚLTIMA ocorrência — o recibo vem depois da narração', () => {
    // Saída real do `musicavideo faz`: a linha de progresso usa o MESMO nome de
    // campo que o recibo do fim.
    const saida = [
      'custo estimado:',
      'musica: pronto → faixa-1.mp3 (US$ 0.0800)',
      '',
      'slug: chuva-de-verao',
      'musica: /home/x/output/chuva-de-verao/faixa-1.mp3',
    ].join('\n');
    expect(ultimoCampo(saida, 'musica')).toBe('/home/x/output/chuva-de-verao/faixa-1.mp3');
    expect(ultimoCampo(saida, 'slug')).toBe('chuva-de-verao');
    expect(ultimoCampo(saida, 'capa')).toBeNull();
  });

  it('não confunde campo com sufixo de outro nome', () => {
    expect(ultimoCampo('submusica: x\nmusica: y\n', 'musica')).toBe('y');
  });
});

describe('resolverMostrar', () => {
  function recibo(texto: string): string {
    const p = join(mkdtempSync(join(tmpdir(), 'recibo-')), 'r.txt');
    writeFileSync(p, texto);
    return p;
  }

  it('pega o caminho do recibo, não a linha de progresso', () => {
    const artefato = recibo('musica: pronto → faixa-1.mp3 (US$ 0.08)\nmusica: /out/faixa-1.mp3\n');
    expect(resolverMostrar('{{artefato:musica}}', { repo: '/r', ref: 'MVD90', alvo: '', artefato }))
      .toBe('/out/faixa-1.mp3');
  });

  it('campo ausente não vira caminho pela metade', () => {
    const artefato = recibo('slug: x\n');
    expect(resolverMostrar('{{artefato:capa}}', { repo: '/r', ref: 'MVD90', alvo: '', artefato }))
      .toBeNull();
  });

  it('alvo VAZIO resolve — é o caso do fluxo sem alvo nenhum', () => {
    expect(resolverMostrar('{{repo}}/PLANO.md', { repo: '/r', ref: 'MVD90', alvo: '', artefato: '' }))
      .toBe('/r/PLANO.md');
  });
});
