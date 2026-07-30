// Notificação de término de job. No v1 isso era um watcher separado varrendo
// o banco; aqui worker e gateway vivem no mesmo processo, então o worker
// chama isto direto via `WorkerOpts.aoTerminar` — sem que `fila/` conheça
// `gateway/` (o callback é injetado, ver src/index.ts).
import type { Transporte } from './telegram.js';
import { duracao } from './comandos.js';
import { planejarEntrega, type OpcoesEntrega } from './entrega.js';
import type { Job } from '../fila/types.js';

/**
 * Telegram já corta em ~4000 chars (ver `cortar` em telegram.ts), mas um erro
 * de 1000+ linhas de stack técnica é ruído no chat mesmo cabendo inteiro numa
 * mensagem — o operador não lê isso, só precisa saber ONDE olhar (job_id) e um
 * indício do quê. 300 chars é o suficiente pra reconhecer a causa (mensagem de
 * exceção + início do stack) sem virar parede de texto.
 */
const LIMITE_ERRO = 300;

export interface DepsNotificador {
  /** Segunda barreira do §9: o erro já foi redigido pelo worker ANTES de ser
   * gravado; aplicar de novo na saída custa nada e cobre o caminho em que a
   * linha veio de outro lugar (recuperação de lease no boot, por exemplo). */
  redigir?: (texto: string) => string;
  /** Como entregar ESTE job: destino, nome final, copiar ou mover. Injetado
   * porque quem sabe o formato do input e o registry é o boot, não este módulo. */
  entregaDe?: (job: Job) => OpcoesEntrega;
  /** true quando o resultado do job é um CAMINHO de artefato a entregar (skills)
   * e não um texto já pronto (`http.get`). */
  temArtefato?: (job: Job) => boolean;
  log?: (m: string) => void;
}

/**
 * spec §8: falha SEMPRE notifica (job_id + trecho do erro) — silêncio nunca é
 * estado válido. `done` notifica o resultado. Qualquer outro status (queued
 * de retentativa, running, canceled) não é término e não gera mensagem — uma
 * retentativa não é conclusão, e um cancelamento já foi confirmado no chat
 * pelo próprio comando que o disparou.
 */
export function criarNotificador(
  transporte: Transporte,
  deps: DepsNotificador = {},
): (job: Job) => Promise<void> {
  const redigir = deps.redigir ?? ((t: string) => t);
  const log = deps.log ?? ((): void => {});

  return async (job: Job): Promise<void> => {
    if (job.chat_id === null) return;

    if (job.status === 'done') {
      const bruto = job.resultado ?? '';
      if (!deps.temArtefato?.(job)) {
        await transporte.responder(job.chat_id, `✅ Job ${job.id} concluído.\n${bruto}`);
        return;
      }
      // Entrega pode falhar por causa do DISCO (destino sumiu, permissão), e
      // isso não pode virar silêncio: o job está `done` de verdade, então o
      // chat tem que receber ao menos o caminho.
      let entrega;
      try {
        entrega = planejarEntrega(bruto, deps.entregaDe?.(job) ?? {});
      } catch (e) {
        log(`[job ${job.id}] entrega falhou: ${(e as Error).message}`);
        entrega = { mensagem: `✅ Job ${job.id} concluído, mas a entrega falhou: ${redigir((e as Error).message)}\n${bruto}` };
      }
      const d = duracao(job.iniciado_em, job.terminado_em);
      await transporte.responder(
        job.chat_id,
        `✅ Job ${job.id} concluído${d ? ` em ${d}` : ''}.\n${entrega.mensagem}`,
      );
      if (entrega.anexo && transporte.enviarDocumento) {
        try {
          await transporte.enviarDocumento(job.chat_id, entrega.anexo);
        } catch (e) {
          // O caminho já foi para o chat na mensagem acima — perder o anexo é
          // ruim, derrubar o worker por isso seria pior.
          log(`[job ${job.id}] anexo não pôde ser enviado: ${(e as Error).message}`);
        }
      }
      return;
    }

    if (job.status === 'failed') {
      const erro = redigir(job.erro ?? '').slice(0, LIMITE_ERRO);
      await transporte.responder(job.chat_id, `❌ Job ${job.id} falhou.\n${erro}`);
      return;
    }
  };
}
