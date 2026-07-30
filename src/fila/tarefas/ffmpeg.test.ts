import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarFfmpegThumb } from './ffmpeg.js';
import { TAREFAS } from './index.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (input: string): ContextoTarefa =>
  ({ job: { input } as never, fila: {} as never, agora: () => 1_000, log: () => {} });

describe('ffmpeg.thumb', () => {
  it('rejeita entrada que não existe, sem chamar o binário', async () => {
    const tarefa = criarFfmpegThumb('/bin/false');
    await expect(tarefa(ctx(JSON.stringify({ entrada: join(dir, 'nao-existe.mp4') }))))
      .rejects.toThrow(/não encontrado|nao encontrado/i);
  });

  it('rejeita input sem entrada', async () => {
    await expect(criarFfmpegThumb('/bin/true')(ctx('{}'))).rejects.toThrow(/entrada/i);
  });

  it('devolve o caminho da saída quando o binário sai com 0', async () => {
    const entrada = join(dir, 'v.mp4');
    writeFileSync(entrada, 'x');
    // /bin/true ignora os argumentos e sai 0; o teste prova o contrato da tarefa
    // (validação, montagem de argumentos, caminho de saída), não o ffmpeg.
    const saida = await criarFfmpegThumb('/bin/true')(ctx(JSON.stringify({ entrada })));
    expect(saida).toBe(`${entrada}.jpg`);
  });

  it('falha com o código quando o binário sai diferente de 0', async () => {
    const entrada = join(dir, 'v.mp4');
    writeFileSync(entrada, 'x');
    await expect(criarFfmpegThumb('/bin/false')(ctx(JSON.stringify({ entrada }))))
      .rejects.toThrow(/código 1/);
  });
});

describe('catálogo', () => {
  it('expõe exatamente as tarefas conhecidas', () => {
    expect(Object.keys(TAREFAS).sort()).toEqual(['ffmpeg.thumb', 'http.get']);
  });
});
