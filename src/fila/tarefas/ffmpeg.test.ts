import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarFfmpegThumb } from './ffmpeg.js';
import { criarTarefas } from './index.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
let raiz: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  raiz = dir; // usa o próprio dir como raiz permitida para testes
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (input: string): ContextoTarefa =>
  ({ job: { input } as never, fila: {} as never, agora: () => 1_000, log: () => {} });

describe('ffmpeg.thumb', () => {
  it('rejeita entrada que não existe, sem chamar o binário', async () => {
    const tarefa = criarFfmpegThumb('/bin/false', raiz);
    await expect(tarefa(ctx(JSON.stringify({ entrada: join(raiz, 'nao-existe.mp4') }))))
      .rejects.toThrow(/não encontrado|nao encontrado/i);
  });

  it('rejeita input sem entrada', async () => {
    await expect(criarFfmpegThumb('/bin/true', raiz)(ctx('{}'))).rejects.toThrow(/entrada/i);
  });

  it('devolve o caminho da saída quando o binário sai com 0', async () => {
    const entrada = join(raiz, 'v.mp4');
    writeFileSync(entrada, 'x');
    // /bin/true ignora os argumentos e sai 0; o teste prova o contrato da tarefa
    // (validação, montagem de argumentos, caminho de saída), não o ffmpeg.
    const saida = await criarFfmpegThumb('/bin/true', raiz)(ctx(JSON.stringify({ entrada })));
    expect(saida).toBe(`${entrada}.jpg`);
  });

  it('falha com o código quando o binário sai diferente de 0', async () => {
    const entrada = join(raiz, 'v.mp4');
    writeFileSync(entrada, 'x');
    await expect(criarFfmpegThumb('/bin/false', raiz)(ctx(JSON.stringify({ entrada }))))
      .rejects.toThrow(/código 1/);
  });

  it('rejeita arquivo fora da raiz permitida, sem chamar o binário', async () => {
    const fora = mkdtempSync(join(tmpdir(), 'inemaccbot-fora-'));
    try {
      const entrada = join(fora, 'v.mp4');
      writeFileSync(entrada, 'x');
      const tarefa = criarFfmpegThumb('/bin/false', raiz);
      await expect(tarefa(ctx(JSON.stringify({ entrada }))))
        .rejects.toThrow(/fora da raiz|raiz permitida/i);
    } finally {
      rmSync(fora, { recursive: true, force: true });
    }
  });

  it('rejeita caminho com prefixo parecido (sibling-prefix)', async () => {
    // Caso malicioso: raiz=/tmp/abc123/midia, entrada=/tmp/abc123/midia-outra/v.mp4
    // Um simples startsWith(raiz) falharia aqui.
    const raizTest = join(dir, 'midia');
    const raizOutra = join(dir, 'midia-outra');
    const entrada = join(raizOutra, 'v.mp4');

    // Prepara a estrutura
    const fs = await import('node:fs/promises');
    await fs.mkdir(raizTest, { recursive: true });
    await fs.mkdir(raizOutra, { recursive: true });
    await fs.writeFile(entrada, 'x');

    const tarefa = criarFfmpegThumb('/bin/false', raizTest);
    await expect(tarefa(ctx(JSON.stringify({ entrada }))))
      .rejects.toThrow(/fora da raiz|raiz permitida/i);
  });

  it('aceita traversal que se resolve dentro da raiz', async () => {
    const subdir = join(raiz, 'sub');
    const fs = await import('node:fs/promises');
    await fs.mkdir(subdir, { recursive: true });

    const entrada = join(subdir, '..', 'v.mp4');
    writeFileSync(join(raiz, 'v.mp4'), 'x');

    const saida = await criarFfmpegThumb('/bin/true', raiz)(ctx(JSON.stringify({ entrada })));
    // A saída deve ser o caminho RESOLVIDO, não a entrada bruta
    expect(saida).toBe(`${join(raiz, 'v.mp4')}.jpg`);
  });
});

describe('catálogo', () => {
  it('expõe exatamente as tarefas conhecidas', () => {
    const tarefas = criarTarefas({ raizMidia: raiz });
    expect(Object.keys(tarefas).sort()).toEqual(['ffmpeg.thumb', 'http.get']);
  });
});
