import { describe, expect, it } from 'vitest';

import { SemContrato, extrairArtefato } from './artefato.js';

describe('extrairArtefato', () => {
  it('pega o caminho da última linha RESULT:', () => {
    const saida = ['blá blá', 'RESULT: /tmp/velho.txt', 'mais log', 'RESULT: /tmp/novo.txt'].join('\n');
    expect(extrairArtefato(saida, ['txt'])).toBe('/tmp/novo.txt');
  });

  it('aceita qualquer extensão declarada pela skill', () => {
    expect(extrairArtefato('RESULT: /tmp/a.srt', ['txt', 'srt'])).toBe('/tmp/a.srt');
  });

  // O v1 tratava ausência como `null` e seguia. Aqui é falha: agente que não
  // declarou onde gravou é indistinguível de agente que não gravou nada.
  it('falha quando não há contrato nenhum', () => {
    expect(() => extrairArtefato('terminei, tudo certo!', ['txt'])).toThrow(SemContrato);
  });

  it('falha com o motivo quando o agente declara ERRO:', () => {
    expect(() => extrairArtefato('log\nERRO: yt-dlp não achou o vídeo', ['txt']))
      .toThrow(/yt-dlp não achou o vídeo/);
  });

  it('falha explicando a extensão quando o RESULT: não bate com a skill', () => {
    expect(() => extrairArtefato('RESULT: /tmp/a.txt', ['mp4'])).toThrow(/\.mp4/);
  });

  it('não confunde o texto transcrito com o contrato — só a linha inteira conta', () => {
    const saida = 'a pessoa disse: RESULT: isso aqui é fala\nRESULT: /tmp/ok.txt';
    expect(extrairArtefato(saida, ['txt'])).toBe('/tmp/ok.txt');
  });
});

/**
 * O A#5 declarou `` `ERRO: skill não encontrada` `` — com crase — e o contrato
 * não casou. O bot então disse "terminou sem declarar" sobre um agente que
 * TINHA declarado: diagnóstico errado sobre uma falha real.
 */
describe('enfeite de markdown na linha de contrato', () => {
  it('aceita ERRO: entre crases', () => {
    expect(() => extrairArtefato('fiz\n`ERRO: skill não encontrada`', ['txt']))
      .toThrow(/skill não encontrada/);
  });

  it('aceita ERRO: em negrito', () => {
    expect(() => extrairArtefato('fiz\n**ERRO: deu ruim**', ['txt'])).toThrow(/deu ruim/);
  });

  it('aceita RESULT: entre crases', () => {
    expect(extrairArtefato('ok\n`RESULT: /tmp/a.txt`', ['txt'])).toBe('/tmp/a.txt');
  });

  it('aceita RESULT: como item de lista', () => {
    expect(extrairArtefato('ok\n- RESULT: /tmp/a.txt', ['txt'])).toBe('/tmp/a.txt');
  });

  // Sem contrato nenhum continua sendo falha — o enfeite não pode virar uma
  // porta para aceitar qualquer coisa.
  it('texto solto continua sem contrato', () => {
    expect(() => extrairArtefato('`terminei tudo`', ['txt'])).toThrow(/sem declarar/);
  });
});
