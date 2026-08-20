import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { chavesFaltando, inserirEntradaSkill, invocacaoResolvida } from './plugar.js';

function repoComPrompts(...nomes: string[]): string {
  const raiz = mkdtempSync(join(tmpdir(), 'plugar-'));
  mkdirSync(join(raiz, 'prompts'), { recursive: true });
  for (const n of nomes) writeFileSync(join(raiz, 'prompts', n), 'prompt {{input}} {{saida}}');
  return raiz;
}

const ENTRADA = {
  command: 'analisevideo',
  fila: 'texto',
  kind: 'agent',
  prompt: 'prompts/analisevideo.md',
  artefato_exts: ['md'],
  max_tentativas: 2,
  timeout_segundos: 3600,
  aceita_destino: false,
  descricao: 'análise visual',
  exemplo: 'analisevideo: https://x/y',
};

const EXISTENTE = JSON.stringify([{
  command: 'transcrever',
  fila: 'texto',
  kind: 'agent',
  prompt: 'prompts/transcrever.md',
  artefato_exts: ['txt'],
  max_tentativas: 2,
  timeout_segundos: 3600,
  aceita_destino: false,
  descricao: 'transcreve',
  exemplo: 'transcrever: url',
}], null, 2);

describe('inserirEntradaSkill', () => {
  it('acrescenta preservando o que já existia', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    const { texto, acao } = inserirEntradaSkill(EXISTENTE, ENTRADA, raiz);
    const lista = JSON.parse(texto);
    expect(acao).toBe('inserida');
    expect(lista.map((s: { command: string }) => s.command)).toEqual(['transcrever', 'analisevideo']);
  });

  // Re-plugar é caso normal (o manifesto mudou). O que não pode é ser silencioso
  // — daí `acao`, que o script mostra antes de gravar.
  it('substitui a entrada de mesmo command, e anuncia', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    const uma = inserirEntradaSkill(EXISTENTE, ENTRADA, raiz).texto;
    const { texto, acao } = inserirEntradaSkill(uma, { ...ENTRADA, timeout_segundos: 900 }, raiz);
    const lista = JSON.parse(texto);
    expect(acao).toBe('substituida');
    expect(lista).toHaveLength(2);
    expect(lista[1].timeout_segundos).toBe(900);
  });

  // A defesa central: o que sai daqui é gravado, e config inválida não falha no
  // plugar — falha no BOOT.
  it('recusa quando a entrada não passa no validador do boot (prompt ausente)', () => {
    const raiz = repoComPrompts('transcrever.md');   // sem analisevideo.md
    expect(() => inserirEntradaSkill(EXISTENTE, ENTRADA, raiz))
      .toThrow(/prompt.*ausente|arquivo ausente/i);
  });

  it('recusa fila inexistente antes de gravar', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    expect(() => inserirEntradaSkill(EXISTENTE, { ...ENTRADA, fila: 'inventada' }, raiz))
      .toThrow(/fila/);
  });

  it('recusa JSON quebrado em vez de sobrescrever o arquivo', () => {
    const raiz = repoComPrompts('analisevideo.md');
    expect(() => inserirEntradaSkill('[{ isto não é json', ENTRADA, raiz))
      .toThrow(/não é JSON válido/);
  });

  it('termina com quebra de linha (diff limpo no git)', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    expect(inserirEntradaSkill(EXISTENTE, ENTRADA, raiz).texto.endsWith('\n')).toBe(true);
  });
});

describe('chavesFaltando', () => {
  it('chave presente e preenchida não falta', () => {
    expect(chavesFaltando('GOOGLE_API_KEY=abc\n', ['GOOGLE_API_KEY'])).toEqual([]);
  });

  // O caso que motiva a função: `CHAVE=` passa em qualquer teste de existência e
  // só falha no primeiro job, com erro do provedor que não menciona o cofre.
  it('chave declarada e VAZIA conta como faltando', () => {
    expect(chavesFaltando('GOOGLE_API_KEY=\n', ['GOOGLE_API_KEY'])).toEqual(['GOOGLE_API_KEY']);
  });

  it('ignora comentário e linha solta', () => {
    const cofre = '# GOOGLE_API_KEY=nao-vale\nlixo\nGROQ_API_KEY=x\n';
    expect(chavesFaltando(cofre, ['GOOGLE_API_KEY', 'GROQ_API_KEY'])).toEqual(['GOOGLE_API_KEY']);
  });

  it('aceita valor entre aspas', () => {
    expect(chavesFaltando('GOOGLE_API_KEY="abc"\n', ['GOOGLE_API_KEY'])).toEqual([]);
  });

  it('cofre vazio faz todas faltarem', () => {
    expect(chavesFaltando('', ['A_KEY', 'B_KEY'])).toEqual(['A_KEY', 'B_KEY']);
  });
});

describe('invocacaoResolvida', () => {
  it('resolve {{repo}} e PRESERVA {{input}}', () => {
    const linha = invocacaoResolvida('bash {{repo}}/a.sh analisa "{{input}}"', '/root/projetos/analisevideo');
    expect(linha).toBe('bash /root/projetos/analisevideo/a.sh analisa "{{input}}"');
  });

  it('resolve todas as ocorrências de {{repo}}', () => {
    expect(invocacaoResolvida('cd {{repo}} && bash {{repo}}/a.sh "{{input}}"', '/r'))
      .toBe('cd /r && bash /r/a.sh "{{input}}"');
  });
});
