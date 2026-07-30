// Tarefa da fila `cpu`. ffmpeg NÃO é trabalho leve — compete por CPU com o
// render — por isso vive numa fila de concorrência 1, separada da `io`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { Tarefa } from '../worker.js';
import type { ContextoTarefa } from '../types.js';

const pExecFile = promisify(execFile);

export function criarFfmpegThumb(binario = 'ffmpeg'): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    const { entrada } = JSON.parse(ctx.job.input || '{}') as { entrada?: string };
    if (!entrada) throw new Error('ffmpeg.thumb: input precisa de { entrada }');
    if (!existsSync(entrada)) throw new Error(`ffmpeg.thumb: arquivo não encontrado: ${entrada}`);
    const saida = `${entrada}.jpg`;
    try {
      // Argumentos em array, nunca shell: o caminho vem do usuário.
      await pExecFile(binario, ['-y', '-i', entrada, '-frames:v', '1', saida], { timeout: 60_000 });
    } catch (e) {
      const código = (e as { code?: number }).code ?? '?';
      throw new Error(`ffmpeg.thumb: saiu com código ${código}`);
    }
    return saida;
  };
}
