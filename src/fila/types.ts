// Contratos da fila. Sem dependência de gateway, fluxos ou Telegram.

export type Fila = 'render' | 'navegador' | 'texto' | 'io' | 'cpu';
export type Kind = 'agent' | 'function';
export type StatusJob = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/** Relógio injetável (segundos epoch). Nada no sistema chama Date.now() direto. */
export type Agora = () => number;

/** Perfil de execução efetivo de um job — ver src/dominio/perfil.ts e docs/perfil-de-execucao.md. */
export interface Perfil {
  motor: string;
  modelo: string;
  esforco: string;
}

export interface Job {
  id: number;
  fila: Fila;
  kind: Kind;
  tarefa: string;
  input: string;
  prioridade: number;
  status: StatusJob;
  tentativas: number;
  max_tentativas: number;
  lease_ate: number | null;
  /** Quem detém o lease agora; `NULL` quando o job não está em execução. */
  lease_owner: string | null;
  disponivel_em: number;
  /** Chave de idempotência: identifica o EFEITO, não a tentativa. Ver spec §2.5. */
  idem_key: string | null;
  /** "P#16/mulheres/render" quando o job é fase de fluxo; null em job solto. */
  flow_ref: string | null;
  chat_id: number | null;
  motor: string | null;
  modelo: string | null;
  esforco: string | null;
  resultado: string | null;
  erro: string | null;
  /** Quando o término foi notificado ao `chat_id`. NULL = ainda não avisamos. */
  notificado_em: number | null;
  criado_em: number;
  iniciado_em: number | null;
  terminado_em: number | null;
}

/**
 * O que uma tarefa `kind=function` recebe. Ela precisa do STORE, não só do job:
 * é por aqui que a regra "procure antes de criar" do §2.5 fica alcançável —
 * sem isto, uma tarefa não consegue consultar `jaConcluido` e a garantia de
 * efeito único vira comentário.
 */
export interface ContextoTarefa {
  job: Job;
  // import inline de propósito — types.ts precisa continuar sem import de
  // runtime, senão a exceção de fronteira dominio/ -> fila/types.js vira
  // acoplamento de verdade.
  fila: import('./store.js').FilaSqlite;
  agora: Agora;
  log: (m: string) => void;
  /**
   * Dispara quando o worker desiste deste job — encerramento do serviço
   * (`abortar()`) ou lease perdido (`bater()`). Uma tarefa `function` PRECISA
   * repassar este sinal para tudo que ela gera (processo filho, `fetch`) e
   * parar. Ignorá-lo é o bug do processo órfão: o serviço sai, o filho é
   * reparentado ao init e continua queimando CPU — escrevendo a saída de um job
   * que o banco já marcou como `failed`, e ainda concorrendo com a próxima
   * instância que reexecuta o mesmo trabalho.
   */
  sinal: AbortSignal;
  /**
   * A tarefa não achou (ainda) o que espera: devolve isto para ser chamada de
   * novo daqui a `intervalo` segundos, SEM gastar tentativa. É o mecanismo de
   * poll do §3.2 — quem o implementa é o worker, via `reagendar()`.
   *
   * Devolver isto não é falha: um render que ainda está processando no estúdio
   * é o caso NORMAL desta fase.
   */
  aindaNao(motivo: string): never;
}

/** Lançada por `ContextoTarefa.aindaNao` — sinal, não erro. */
export class AindaNao extends Error {}

export interface NovoJob {
  fila: Fila;
  kind: Kind;
  tarefa: string;
  input: string;
  prioridade?: number;
  max_tentativas?: number;
  disponivel_em?: number;
  idem_key?: string | null;
  flow_ref?: string | null;
  chat_id?: number | null;
  perfil?: Perfil | null;
}
