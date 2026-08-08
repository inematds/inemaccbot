// Tarefa da fila `cpu`. ffmpeg NÃO é trabalho leve — compete por CPU com o
// render — por isso vive numa fila de concorrência 1, separada da `io`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve, sep } from 'node:path';

import type { Tarefa } from '../worker.js';
import type { ContextoTarefa } from '../types.js';

const pExecFile = promisify(execFile);

export function criarFfmpegThumb(binario: string, raizPermitida: string): Tarefa {
  const raiz = resolve(raizPermitida);
  return async (ctx: ContextoTarefa): Promise<string> => {
    const { entrada } = JSON.parse(ctx.job.input || '{}') as { entrada?: string };
    if (!entrada) throw new Error('ffmpeg.thumb: input precisa de { entrada }');
    const alvo = resolve(entrada);
    // Containment: arquivo deve estar dentro da raiz permitida. Usa separator
    // para evitar que /dados/secreta passe por ser prefixo de /dados/secret-algo.
    if (alvo !== raiz && !alvo.startsWith(raiz + sep)) {
      throw new Error('ffmpeg.thumb: arquivo fora da raiz permitida');
    }
    if (!existsSync(alvo)) throw new Error(`ffmpeg.thumb: arquivo não encontrado: ${alvo}`);
    const saida = `${alvo}.jpg`;
    try {
      // Argumentos em array, nunca shell: o caminho vem do usuário.
      // `signal` e `timeout` cobrem falhas diferentes: o timeout é o ffmpeg que
      // travou sozinho; o sinal é o worker desistindo do job (encerramento ou
      // lease perdido). Sem `signal`, o filho sobrevive ao processo pai.
      await pExecFile(binario, ['-y', '-i', alvo, '-frames:v', '1', saida], {
        timeout: 60_000,
        signal: ctx.sinal,
      });
    } catch (e) {
      // O erro de abort não tem `code`; sem este caso especial ele viraria
      // "saiu com código ?" e seria indistinguível de um ffmpeg quebrado.
      if (ctx.sinal.aborted || (e as Error).name === 'AbortError') {
        throw new Error('ffmpeg.thumb: abortado (worker desistiu do job)');
      }
      const código = (e as { code?: number }).code ?? '?';
      throw new Error(`ffmpeg.thumb: saiu com código ${código}`);
    }
    return saida;
  };
}
