// Catálogo FECHADO de tarefas `function` (spec §9): o campo `tarefa` de um job
// só pode ser uma chave daqui. Texto livre do usuário nunca vira nome de tarefa.
import type { Tarefa } from '../worker.js';
import { criarHttpGet } from './http.js';
import { criarFfmpegThumb } from './ffmpeg.js';

export function criarTarefas(opts: { raizMidia: string }): Record<string, Tarefa> {
  return {
    'http.get': criarHttpGet(),
    'ffmpeg.thumb': criarFfmpegThumb('ffmpeg', opts.raizMidia),
  };
}
