// Catálogo FECHADO de tarefas `function` (spec §9): o campo `tarefa` de um job
// só pode ser uma chave daqui. Texto livre do usuário nunca vira nome de tarefa.
import { readFileSync } from 'node:fs';

import type { Tarefa } from '../worker.js';
import { criarHttpGet } from './http.js';
import { criarFfmpegThumb } from './ffmpeg.js';
import { criarClienteHeygen, criarHeygenBaixar, criarHeygenGerar, lerChaveHeygen } from './heygen.js';

export function criarTarefas(opts: {
  raizMidia: string;
  /** Arquivo de onde a HEYGEN_API_KEY é lida EM RUNTIME (nunca no repo, §9). */
  heygenEnvPath?: string;
}): Record<string, Tarefa> {
  const cliente = criarClienteHeygen(
    () => lerChaveHeygen(opts.heygenEnvPath ?? '', (p) => readFileSync(p, 'utf8')),
  );
  return {
    'http.get': criarHttpGet(),
    'ffmpeg.thumb': criarFfmpegThumb('ffmpeg', opts.raizMidia),
    // A chave é lida a cada chamada, não no boot: trocar o `.env` passa a valer
    // sem reiniciar, e a chave nunca fica pendurada em memória de propósito.
    'heygen.baixar': criarHeygenBaixar(cliente),
    // Só é alcançada por um fluxo criado com `| api` — a fase `gerar` não
    // existe na definição congelada de um fluxo normal.
    'heygen.gerar': criarHeygenGerar(cliente),
  };
}
