// Notificação de término de job. No v1 isso era um watcher separado varrendo
// o banco; aqui worker e gateway vivem no mesmo processo, então o worker
// chama isto direto via `WorkerOpts.aoTerminar` — sem que `fila/` conheça
// `gateway/` (o callback é injetado, ver src/index.ts).
import type { Transporte } from './telegram.js';
import type { Job } from '../fila/types.js';

/**
 * Telegram já corta em ~4000 chars (ver `cortar` em telegram.ts), mas um erro
 * de 1000+ linhas de stack técnica é ruído no chat mesmo cabendo inteiro numa
 * mensagem — o operador não lê isso, só precisa saber ONDE olhar (job_id) e um
 * indício do quê. 300 chars é o suficiente pra reconhecer a causa (mensagem de
 * exceção + início do stack) sem virar parede de texto.
 */
const LIMITE_ERRO = 300;

/**
 * spec §8: falha SEMPRE notifica (job_id + trecho do erro) — silêncio nunca é
 * estado válido. `done` notifica o resultado. Qualquer outro status (queued
 * de retentativa, running, canceled) não é término e não gera mensagem — uma
 * retentativa não é conclusão, e um cancelamento já foi confirmado no chat
 * pelo próprio comando que o disparou.
 */
export function criarNotificador(transporte: Transporte): (job: Job) => Promise<void> {
  return async (job: Job): Promise<void> => {
    if (job.chat_id === null) return;

    if (job.status === 'done') {
      await transporte.responder(job.chat_id, `✅ Job ${job.id} concluído.\n${job.resultado ?? ''}`);
      return;
    }

    if (job.status === 'failed') {
      const erro = (job.erro ?? '').slice(0, LIMITE_ERRO);
      await transporte.responder(job.chat_id, `❌ Job ${job.id} falhou.\n${erro}`);
      return;
    }
  };
}
