// O registry de fontes é o espelho do de destinos: nome no domínio, caminho só
// no bot. O que estes testes fixam é a parte que decide comportamento — fonte é
// PASTA, escolha é EXPLÍCITA, e ambiguidade RECUSA em vez de sortear.
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  listarArquivosDaFonte, listarFontes, resolverArquivoDaFonte, resolverFonte, validarFontes,
} from './fontes.js';

function raizCom(arquivos: Record<string, string[]>): string {
  const raiz = mkdtempSync(join(tmpdir(), 'fontes-'));
  for (const [pasta, nomes] of Object.entries(arquivos)) {
    mkdirSync(join(raiz, pasta), { recursive: true });
    for (const n of nomes) writeFileSync(join(raiz, pasta, n), 'x');
  }
  return raiz;
}

const FONTES = validarFontes({ trilhas: 'audio/trilhas', explicativos: 'output/explicativos' });

describe('validarFontes', () => {
  it('objeto vazio é registry vazio — arquivo ausente não é erro', () => {
    expect(validarFontes({})).toEqual([]);
  });

  // Caminho absoluto num arquivo versionado não sobrevive à mudança de máquina:
  // é a mesma regra do `repo` no flow.json (nome de pasta, não caminho).
  it('recusa caminho absoluto e ".."', () => {
    expect(() => validarFontes({ t: '/mnt/trilhas' })).toThrow(/relativo/);
    expect(() => validarFontes({ t: '../fora' })).toThrow(/relativo/);
  });

  it('recusa nome inválido e caminho vazio, nomeando qual', () => {
    expect(() => validarFontes({ 'Trilhas Boas': 'a' })).toThrow(/Trilhas Boas/);
    expect(() => validarFontes({ t: '   ' })).toThrow(/t: caminho vazio/);
  });

  it('recusa arquivo que não é objeto', () => {
    expect(() => validarFontes([])).toThrow(/objeto/);
  });
});

describe('resolverFonte', () => {
  it('nome vira caminho sob a raiz', () => {
    const raiz = raizCom({ 'audio/trilhas': ['lofi.mp3'] });
    expect(resolverFonte('trilhas', FONTES, raiz)).toBe(join(raiz, 'audio/trilhas'));
  });

  it('null quando o nome não está no registry ou a pasta não existe', () => {
    const raiz = raizCom({ 'audio/trilhas': [] });
    expect(resolverFonte('inventada', FONTES, raiz)).toBeNull();
    expect(resolverFonte('explicativos', FONTES, raiz)).toBeNull();
  });
});

describe('resolverArquivoDaFonte', () => {
  it('escolhe pelo nome exato', () => {
    const raiz = raizCom({ 'audio/trilhas': ['lofi.mp3', 'rock.mp3'] });
    expect(resolverArquivoDaFonte('trilhas', 'lofi.mp3', FONTES, raiz))
      .toBe(join(raiz, 'audio/trilhas/lofi.mp3'));
  });

  it('aceita nome sem extensão quando ele é inequívoco', () => {
    const raiz = raizCom({ 'audio/trilhas': ['lofi.mp3', 'rock.mp3'] });
    expect(resolverArquivoDaFonte('trilhas', 'lofi', FONTES, raiz))
      .toBe(join(raiz, 'audio/trilhas/lofi.mp3'));
  });

  // O ponto do desenho: com dois candidatos, RECUSA. Sortear quebraria "mesmo
  // pedido, mesmo resultado" — e um sorteio em silêncio é o defeito que ninguém
  // vê até comparar dois reels.
  it('recusa quando o nome-base é ambíguo', () => {
    const raiz = raizCom({ 'audio/trilhas': ['lofi.mp3', 'lofi.wav'] });
    expect(resolverArquivoDaFonte('trilhas', 'lofi', FONTES, raiz)).toBeNull();
  });

  it('nunca escapa da pasta: barra, ".." e absoluto são recusados', () => {
    const raiz = raizCom({ 'audio/trilhas': ['lofi.mp3'] });
    for (const mau of ['../segredo', 'sub/lofi.mp3', '/etc/passwd', '']) {
      expect(resolverArquivoDaFonte('trilhas', mau, FONTES, raiz)).toBeNull();
    }
  });

  it('null quando o arquivo não existe na fonte', () => {
    const raiz = raizCom({ 'audio/trilhas': ['lofi.mp3'] });
    expect(resolverArquivoDaFonte('trilhas', 'jazz', FONTES, raiz)).toBeNull();
  });
});

describe('listagens (as mensagens de erro dependem delas)', () => {
  it('lista os nomes registrados em ordem', () => {
    expect(listarFontes(FONTES)).toEqual(['explicativos', 'trilhas']);
  });

  it('lista os arquivos de uma fonte, e vazio quando ela não existe', () => {
    const raiz = raizCom({ 'audio/trilhas': ['rock.mp3', 'lofi.mp3'] });
    expect(listarArquivosDaFonte('trilhas', FONTES, raiz)).toEqual(['lofi.mp3', 'rock.mp3']);
    expect(listarArquivosDaFonte('explicativos', FONTES, raiz)).toEqual([]);
  });
});
