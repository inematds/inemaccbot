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
  criado_em: number;
  iniciado_em: number | null;
  terminado_em: number | null;
}

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
