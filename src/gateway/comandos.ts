// Comandos do gateway, PUROS: nenhuma linha aqui conhece grammy ou a API do
// Telegram (regra herdada do v1 — nenhum teste deste bot bate na API real).
// `executar` só fala com o store; nunca imprime, nunca envia.
import type { Agora, Fila, Job } from '../fila/types.js';
import type { FilaSqlite } from '../fila/store.js';

export type Comando =
  | { tipo: 'ping' }
  | { tipo: 'fila' }
  | { tipo: 'status'; id: number }
  | { tipo: 'cancelar'; id: number }
  | { tipo: 'furar'; id: number }
  | { tipo: 'http'; url: string }
  | { tipo: 'thumb'; entrada: string }
  | { tipo: 'ajuda' }
  | { tipo: 'desconhecido'; texto: string };

export interface DepsComando {
  fila: FilaSqlite;
  chatId: number;
  agora: Agora;
}

// Prioridade "furada": bem acima de qualquer valor manual plausível, pra não
// depender de descobrir o máximo atual (evita corrida entre leitura e escrita).
const PRIORIDADE_FURO = 1_000_000;

/** Só um inteiro estritamente numérico é um id deste bot. `V#5`/`T#7` (formato
 * do bot antigo) e lixo tipo "abc" caem fora daqui de propósito — spec §5.1:
 * ids do bot antigo não podem ser resolvidos por acidente contra este banco. */
function parseId(arg: string | undefined): number | undefined {
  if (arg === undefined || arg === '') return undefined;
  if (!/^-?\d+$/.test(arg)) return undefined;
  return Number(arg);
}

export function parseComando(texto: string): Comando {
  const t = texto.trim();
  const [bruto, ...resto] = t.split(/\s+/);
  const arg = resto.join(' ');
  // Só o VERBO é normalizado. Teclado de celular capitaliza a primeira letra
  // sozinho, e `/Ping` cair em "comando não reconhecido" é atrito puro. O
  // argumento fica intocado de propósito: caminho de arquivo e URL diferenciam
  // maiúscula de minúscula, e baixá-los quebraria `thumb`/`http`.
  const cmd = (bruto ?? '').toLowerCase();

  switch (cmd) {
    case '/ping':
      return { tipo: 'ping' };
    case '/fila':
      return { tipo: 'fila' };
    case '/ajuda':
    case '/help':
      return { tipo: 'ajuda' };
    case '/status': {
      const id = parseId(arg);
      return id === undefined ? { tipo: 'desconhecido', texto: t } : { tipo: 'status', id };
    }
    case '/cancelar': {
      const id = parseId(arg);
      return id === undefined ? { tipo: 'desconhecido', texto: t } : { tipo: 'cancelar', id };
    }
    case '/furar': {
      const id = parseId(arg);
      return id === undefined ? { tipo: 'desconhecido', texto: t } : { tipo: 'furar', id };
    }
    case 'http':
      return arg === '' ? { tipo: 'desconhecido', texto: t } : { tipo: 'http', url: arg };
    case 'thumb':
      return arg === '' ? { tipo: 'desconhecido', texto: t } : { tipo: 'thumb', entrada: arg };
    default:
      return { tipo: 'desconhecido', texto: t };
  }
}

const AJUDA_LINHAS: Array<{ uso: string; descricao: string }> = [
  { uso: '/ping', descricao: 'verifica se o bot está vivo' },
  { uso: '/fila', descricao: 'resumo de cada fila (rodando, pendente, idade, erro 24h)' },
  { uso: '/status <id>', descricao: 'status de um job' },
  { uso: '/cancelar <id>', descricao: 'cancela um job pendente ou em execução' },
  { uso: '/furar <id>', descricao: 'põe um job pendente na frente da fila' },
  { uso: 'http <url>', descricao: 'enfileira um GET' },
  { uso: 'thumb <caminho>', descricao: 'enfileira uma thumbnail' },
  { uso: '/ajuda (ou /help)', descricao: 'esta lista' },
];

function respostaAjuda(): string {
  return ['Comandos:', ...AJUDA_LINHAS.map((l) => `${l.uso} — ${l.descricao}`)].join('\n');
}

// Job não encontrado neste banco: recusa honesta, nunca age. Cobre tanto id
// inexistente quanto formatos do bot antigo (`V#5`, `T#7`) que já caem em
// `desconhecido` no parse — esta mensagem é só pro caso "parece um id, mas
// não existe aqui".
const MSG_ID_DESCONHECIDO = 'id não existe neste bot (não é deste bot ou já não existe mais).';

function exigirJob(fila: FilaSqlite, id: number): Job | undefined {
  return fila.obter(id);
}

function fmtStatus(job: Job): string {
  const linhas = [
    `job ${job.id}`,
    `status: ${job.status}`,
    `fila: ${job.fila}`,
    `tarefa: ${job.tarefa}`,
    `tentativas: ${job.tentativas}/${job.max_tentativas}`,
  ];
  if (job.resultado) linhas.push(`resultado: ${job.resultado}`);
  if (job.erro) linhas.push(`erro: ${job.erro}`);
  return linhas.join('\n');
}

const FILAS: Fila[] = ['render', 'navegador', 'texto', 'io', 'cpu'];
const JANELA_ERRO_SEGUNDOS = 24 * 60 * 60;

function resumoFila(fila: FilaSqlite, nome: Fila, agora: number): string {
  const jobs = fila.listar({ fila: nome });
  const rodando = jobs.filter((j) => j.status === 'running').length;
  const pendentes = jobs.filter((j) => j.status === 'queued');
  const maisAntigo = pendentes.reduce<number | undefined>(
    (min, j) => (min === undefined || j.criado_em < min ? j.criado_em : min),
    undefined,
  );
  const idadeMaisAntigo = maisAntigo === undefined ? undefined : agora - maisAntigo;

  const janela = agora - JANELA_ERRO_SEGUNDOS;
  const terminados24h = jobs.filter(
    (j) => j.terminado_em !== null && j.terminado_em >= janela && (j.status === 'done' || j.status === 'failed'),
  );
  const falhas24h = terminados24h.filter((j) => j.status === 'failed').length;
  // Sem terminado nenhum na janela: taxa de erro não existe, não é zero — não
  // divide por zero, e "0%" seria uma afirmação falsa de "está tudo bem".
  const taxaErro =
    terminados24h.length === 0 ? '—' : `${Math.round((falhas24h / terminados24h.length) * 100)}%`;

  return (
    `${nome}: rodando=${rodando} pendentes=${pendentes.length} ` +
    `mais_antigo=${idadeMaisAntigo === undefined ? '—' : `${idadeMaisAntigo}s`} ` +
    `erro_24h=${taxaErro}`
  );
}

export function executar(cmd: Comando, deps: DepsComando): string {
  switch (cmd.tipo) {
    case 'ping':
      return 'pong';

    case 'ajuda':
      return respostaAjuda();

    case 'fila': {
      const agora = deps.agora();
      return FILAS.map((f) => resumoFila(deps.fila, f, agora)).join('\n');
    }

    case 'status': {
      const job = exigirJob(deps.fila, cmd.id);
      if (!job) return MSG_ID_DESCONHECIDO;
      return fmtStatus(job);
    }

    case 'cancelar': {
      const job = exigirJob(deps.fila, cmd.id);
      if (!job) return MSG_ID_DESCONHECIDO;
      const cancelou = deps.fila.cancelar(cmd.id);
      if (!cancelou) return `nada foi cancelado: job ${cmd.id} já está ${job.status} (terminal).`;
      return `job ${cmd.id} cancelado.`;
    }

    case 'furar': {
      const job = exigirJob(deps.fila, cmd.id);
      if (!job) return MSG_ID_DESCONHECIDO;
      if (job.status !== 'queued') {
        return `nada mudou: job ${cmd.id} não está pendente (status atual: ${job.status}).`;
      }
      const furou = deps.fila.priorizar(cmd.id, PRIORIDADE_FURO);
      if (!furou) {
        return `nada mudou: job ${cmd.id} não está mais pendente.`;
      }
      return `job ${cmd.id} furado — vai na frente da fila.`;
    }

    case 'http': {
      const job = deps.fila.enfileirar({
        fila: 'io',
        kind: 'function',
        tarefa: 'http.get',
        input: JSON.stringify({ url: cmd.url }),
        chat_id: deps.chatId,
      });
      return `enfileirado: job ${job.id} (http.get)`;
    }

    case 'thumb': {
      const job = deps.fila.enfileirar({
        fila: 'cpu',
        kind: 'function',
        tarefa: 'ffmpeg.thumb',
        input: JSON.stringify({ entrada: cmd.entrada }),
        chat_id: deps.chatId,
      });
      return `enfileirado: job ${job.id} (ffmpeg.thumb)`;
    }

    case 'desconhecido':
      // NUNCA ecoar cmd.texto de volta: é entrada do usuário, e a instrução é
      // explícita — a resposta aponta pro /ajuda, não repete o que foi digitado.
      return 'comando não reconhecido. Veja /ajuda.';
  }
}
