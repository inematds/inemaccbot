// Comandos do gateway, PUROS: nenhuma linha aqui conhece grammy ou a API do
// Telegram (regra herdada do v1 — nenhum teste deste bot bate na API real).
// `executar` só fala com o store; nunca imprime, nunca envia.
import { resolverPerfil } from '../dominio/perfil.js';
import type { SkillDef } from '../dominio/registry.js';
import { FILAS } from '../fila/filas.js';
import { analisar, textoSkills, type PedidoSkill } from './gramatica.js';
import type { Agora, Fila, Job, Perfil } from '../fila/types.js';
import type { FilaSqlite } from '../fila/store.js';

export type Comando =
  | { tipo: 'ping' }
  | { tipo: 'fila' }
  | { tipo: 'status'; id: number }
  /** `/status` sem id: a lista do que está na fila e do que terminou. */
  | { tipo: 'lista' }
  | { tipo: 'cancelar'; id: number }
  | { tipo: 'furar'; id: number }
  | { tipo: 'refazer'; id: number }
  | { tipo: 'http'; url: string }
  | { tipo: 'thumb'; entrada: string }
  | { tipo: 'ajuda' }
  | { tipo: 'skills' }
  /** Um pedido de skill do catálogo (`transcrever: <link> | lives3`). */
  | { tipo: 'skill'; pedido: PedidoSkill }
  /** Texto que NÃO casou com nada — quem decide o que fazer com ele é o
   * chamador (na etapa 2, o `interpret`); aqui ele só não vira comando. */
  | { tipo: 'livre'; texto: string }
  /** Erro de gramática, com mensagem NOSSA (não eco da entrada do usuário). */
  | { tipo: 'erro'; mensagem: string }
  | { tipo: 'desconhecido'; texto: string };

export interface DepsComando {
  fila: FilaSqlite;
  chatId: number;
  agora: Agora;
  /** Catálogo de skills. Vazio = só os comandos de serviço (é o que os testes
   * da etapa 1 usam). */
  defs?: SkillDef[];
  /** Base da precedência do §1.5 (o default do `.env`). */
  perfilPadrao?: Perfil;
}

// Prioridade "furada": bem acima de qualquer valor manual plausível, pra não
// depender de descobrir o máximo atual (evita corrida entre leitura e escrita).
const PRIORIDADE_FURO = 1_000_000;

/** Só para quem não passa `perfilPadrao` (testes de comando de serviço). Em
 * produção o valor vem do `.env`, via index.ts. */
const PERFIL_PADRAO_FALLBACK: Perfil = { motor: 'claude', modelo: 'sonnet', esforco: 'low' };

/** Só um inteiro estritamente numérico é um id deste bot. `V#5`/`T#7` (formato
 * do bot antigo) e lixo tipo "abc" caem fora daqui de propósito — spec §5.1:
 * ids do bot antigo não podem ser resolvidos por acidente contra este banco. */
function parseId(arg: string | undefined): number | undefined {
  if (arg === undefined || arg === '') return undefined;
  if (!/^-?\d+$/.test(arg)) return undefined;
  return Number(arg);
}

/**
 * `defs`/`projetosDir` habilitam a SEGUNDA porta (§1.1): sem eles, todo texto
 * que não é comando de barra cai em `desconhecido`, que é o comportamento da
 * etapa 1. Com eles, `transcrever: <link>` vira pedido de skill e o resto vira
 * `livre` — o material do `interpret`.
 */
export function parseComando(texto: string, defs: SkillDef[] = [], projetosDir = ''): Comando {
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
    case '/skills':
      return { tipo: 'skills' };
    case '/status':
    case '/jobs': {
      // Sem argumento NÃO é erro: é a pergunta mais comum que existe ("o que
      // está rolando?"). Mandar isso para "comando não reconhecido" foi um
      // defeito real, achado no primeiro uso pelo chat.
      if (arg === '') return { tipo: 'lista' };
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
    case '/refazer': {
      const id = parseId(arg);
      return id === undefined ? { tipo: 'desconhecido', texto: t } : { tipo: 'refazer', id };
    }
    case 'http':
      return arg === '' ? { tipo: 'desconhecido', texto: t } : { tipo: 'http', url: arg };
    case 'thumb':
      return arg === '' ? { tipo: 'desconhecido', texto: t } : { tipo: 'thumb', entrada: arg };
    default: {
      // Comando de barra que não existe continua sendo `desconhecido`: um
      // `/xyz` é claramente uma tentativa de comando, não conversa.
      if (cmd.startsWith('/')) return { tipo: 'desconhecido', texto: t };
      if (defs.length === 0) return { tipo: 'desconhecido', texto: t };
      const a = analisar(t, defs, projetosDir);
      if (a.tipo === 'skill') return { tipo: 'skill', pedido: a.pedido };
      if (a.tipo === 'livre') return { tipo: 'livre', texto: a.texto };
      // Erro de GRAMÁTICA é diferente de comando desconhecido: aqui o usuário
      // acertou a skill e errou um campo, e a mensagem tem que dizer qual —
      // ela é gerada por nós, não é eco da entrada dele.
      return { tipo: 'erro', mensagem: a.mensagem };
    }
  }
}

const AJUDA_LINHAS: Array<{ uso: string; descricao: string }> = [
  { uso: '/ping', descricao: 'verifica se o bot está vivo' },
  { uso: '/fila', descricao: 'resumo de cada fila (rodando, pendente, idade, erro 24h)' },
  { uso: '/status', descricao: 'lista os jobs (ativos e os últimos terminados)' },
  { uso: '/status <id>', descricao: 'detalhe de um job' },
  { uso: '/cancelar <id>', descricao: 'cancela um job pendente ou em execução' },
  { uso: '/furar <id>', descricao: 'põe um job pendente na frente da fila' },
  { uso: 'http <url>', descricao: 'enfileira um GET' },
  { uso: 'thumb <caminho>', descricao: 'enfileira uma thumbnail' },
  { uso: '/refazer <id>', descricao: 'enfileira de novo um job já terminado' },
  { uso: '/skills', descricao: 'lista as skills do catálogo' },
  { uso: '/ajuda (ou /help)', descricao: 'esta lista' },
];

/** A ajuda mistura os comandos FIXOS (serviço) com as skills do REGISTRY — a
 * lista de skills nunca é escrita à mão aqui, senão ela envelhece calada. */
function respostaAjuda(defs: SkillDef[]): string {
  const linhas = ['Comandos:', ...AJUDA_LINHAS.map((l) => `${l.uso} — ${l.descricao}`)];
  if (defs.length) {
    linhas.push('', 'Skills (formato `skill: entrada | campo`):');
    for (const d of defs) linhas.push(`${d.command}: … — ${d.descricao}`);
    linhas.push('', 'Campos: livesN (destino) · modelo=opus · esforco=high');
  }
  return linhas.join('\n');
}

// Job não encontrado neste banco: recusa honesta, nunca age. Cobre tanto id
// inexistente quanto formatos do bot antigo (`V#5`, `T#7`) que já caem em
// `desconhecido` no parse — esta mensagem é só pro caso "parece um id, mas
// não existe aqui".
const MSG_ID_DESCONHECIDO = 'id não existe neste bot (não é deste bot ou já não existe mais).';

function exigirJob(fila: FilaSqlite, id: number): Job | undefined {
  return fila.obter(id);
}

/**
 * `45s` · `14m` · `1h2m`. `undefined` quando falta um dos carimbos — nunca
 * inventa duração (regra portada do `formatDuration` do v1).
 */
export function duracao(inicio: number | null, fim: number | null): string | undefined {
  if (inicio === null || fim === null) return undefined;
  const s = fim - inicio;
  if (!Number.isFinite(s) || s < 0) return undefined;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtStatus(job: Job): string {
  const linhas = [
    `job ${job.id}`,
    `status: ${job.status}`,
    `fila: ${job.fila}`,
    `tarefa: ${job.tarefa}`,
    `tentativas: ${job.tentativas}/${job.max_tentativas}`,
  ];
  // §1.5: com que perfil este job rodou. Só aparece em job de agente — em
  // `function` as colunas são nulas e uma linha "modelo: -" seria ruído.
  if (job.modelo) linhas.push(`perfil: ${job.motor}/${job.modelo}/${job.esforco}`);
  // Com render de 15 min a 2h, "quanto tempo levou" deixa de ser curiosidade e
  // vira a informação que diz se vale mudar o perfil da skill.
  const d = duracao(job.iniciado_em, job.terminado_em);
  if (d) linhas.push(`duração: ${d}`);
  if (job.resultado) linhas.push(`resultado: ${job.resultado}`);
  if (job.erro) linhas.push(`erro: ${job.erro}`);
  return linhas.join('\n');
}

const JANELA_ERRO_SEGUNDOS = 24 * 60 * 60;
/** Quantos jobs já terminados aparecem na lista. O suficiente para achar o id
 * do que acabou de rodar, sem virar parede de texto no celular. */
const TERMINADOS_NA_LISTA = 8;

function linhaLista(job: Job, agora: number): string {
  const icone = job.status === 'running' ? '▶️'
    : job.status === 'queued' ? '⏳'
      : job.status === 'done' ? '✅'
        : job.status === 'failed' ? '❌' : '🚫';
  const quando = job.status === 'running' || job.status === 'queued'
    ? duracao(job.iniciado_em ?? job.criado_em, agora)
    : duracao(job.iniciado_em, job.terminado_em);
  const entrada = resumoEntrada(job.input);
  return `${icone} ${job.id} ${job.tarefa}${entrada ? ` — ${entrada}` : ''}${quando ? ` (${quando})` : ''}`;
}

/** Um pedaço curto do que foi pedido, para reconhecer o job na lista. O input é
 * JSON do gateway; job criado por outro caminho não quebra a lista. */
function resumoEntrada(input: string): string {
  let entrada = '';
  try {
    const o = JSON.parse(input || '{}') as { entrada?: string; url?: string };
    entrada = o.entrada ?? o.url ?? '';
  } catch {
    entrada = '';
  }
  const limpa = entrada.replace(/\s+/g, ' ').trim();
  return limpa.length > 40 ? `${limpa.slice(0, 40)}…` : limpa;
}

/**
 * Um job `running` há muito mais tempo que o normal daquela tarefa. É O alarme
 * desta fila: com render de até 2h, "rodando" não diz nada sozinho — o que
 * distingue trabalho legítimo de job preso é a comparação com o histórico da
 * MESMA tarefa (um `explicativo` de 3h é suspeito; um de 20 min não).
 *
 * Sem histórico suficiente, não acusa: inventar um limite seria alarme falso, e
 * alarme falso ensina o operador a ignorar o painel.
 */
const FATOR_PRESO = 3;
const MINIMO_AMOSTRAS = 3;

function jobsPresos(jobs: Job[], agora: number): Job[] {
  const duracoes = new Map<string, number[]>();
  for (const j of jobs) {
    if (j.status !== 'done' || j.iniciado_em === null || j.terminado_em === null) continue;
    const lista = duracoes.get(j.tarefa) ?? [];
    lista.push(j.terminado_em - j.iniciado_em);
    duracoes.set(j.tarefa, lista);
  }
  return jobs.filter((j) => {
    if (j.status !== 'running' || j.iniciado_em === null) return false;
    const amostras = duracoes.get(j.tarefa);
    if (!amostras || amostras.length < MINIMO_AMOSTRAS) return false;
    const media = amostras.reduce((a, b) => a + b, 0) / amostras.length;
    return agora - j.iniciado_em > Math.max(media * FATOR_PRESO, 60);
  });
}

/** Média de duração por tarefa, só das que terminaram bem. */
function mediasPorTarefa(jobs: Job[]): string[] {
  const por = new Map<string, number[]>();
  for (const j of jobs) {
    if (j.status !== 'done' || j.iniciado_em === null || j.terminado_em === null) continue;
    const lista = por.get(j.tarefa) ?? [];
    lista.push(j.terminado_em - j.iniciado_em);
    por.set(j.tarefa, lista);
  }
  return [...por.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tarefa, ds]) => {
      const media = Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
      return `${tarefa}: ${duracao(0, media) ?? `${media}s`} (${ds.length}x)`;
    });
}

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

  // Retentativas: um job que rodou mais de uma vez custou o dobro em GPU e
  // token, e isso não aparece em nenhum outro número do painel.
  const retentados = jobs.filter((j) => j.tentativas > 1).length;
  const presos = jobsPresos(jobs, agora);

  const linhas = [
    `${nome}: rodando=${rodando} pendentes=${pendentes.length} ` +
    `mais_antigo=${idadeMaisAntigo === undefined ? '—' : `${idadeMaisAntigo}s`} ` +
    `erro_24h=${taxaErro} retentados=${retentados}`,
  ];
  if (presos.length) {
    linhas.push(`  ⚠️ possivelmente preso: ${presos.map((j) => `${j.id} (${duracao(j.iniciado_em, agora)})`).join(', ')}`);
  }
  return linhas.join('\n');
}

export function executar(cmd: Comando, deps: DepsComando): string {
  switch (cmd.tipo) {
    case 'ping':
      return 'pong';

    case 'ajuda':
      return respostaAjuda(deps.defs ?? []);

    case 'fila': {
      const agora = deps.agora();
      const linhas = FILAS.map((f) => resumoFila(deps.fila, f, agora));
      const medias = mediasPorTarefa(deps.fila.listar());
      if (medias.length) linhas.push('', 'Duração média:', ...medias.map((m) => `  ${m}`));
      return linhas.join('\n');
    }

    case 'lista': {
      const agora = deps.agora();
      const todos = deps.fila.listar();
      const ativos = todos.filter((j) => j.status === 'running' || j.status === 'queued');
      const terminados = todos
        .filter((j) => j.status !== 'running' && j.status !== 'queued')
        .slice(-TERMINADOS_NA_LISTA)
        .reverse();

      const linhas: string[] = [];
      linhas.push(ativos.length ? 'Na fila agora:' : 'Nada na fila agora.');
      for (const j of ativos) linhas.push(linhaLista(j, agora));
      if (terminados.length) {
        linhas.push('', `Últimos ${terminados.length}:`);
        for (const j of terminados) linhas.push(linhaLista(j, agora));
      }
      linhas.push('', 'Detalhe: /status <id>');
      return linhas.join('\n');
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

    case 'skills':
      return deps.defs?.length ? textoSkills(deps.defs) : 'nenhuma skill registrada.';

    case 'skill': {
      const def = (deps.defs ?? []).find((d) => d.command === cmd.pedido.command);
      // Catálogo fechado (§9) checado TAMBÉM aqui: `parseComando` só produz
      // `skill` a partir do registry, mas `executar` é público e não pode
      // depender de quem o chamou ter feito a checagem.
      if (!def) return `skill "${cmd.pedido.command}" não está registrada. Veja /skills.`;
      // §1.5: o perfil EFETIVO é gravado no job. Resolver isto só na hora de
      // executar (dentro de `promptDe`) deixava as colunas `motor/modelo/esforco`
      // nulas, e então o log e o `/status` mostravam `modelo=-` — justamente a
      // pergunta que o perfil em config existe para responder ("com que modelo
      // esse job rodou?"). Um perfil inválido também passa a ser recusado AQUI,
      // com o usuário na frente, em vez de queimar uma tentativa depois.
      let perfil;
      try {
        perfil = resolverPerfil({
          override: cmd.pedido.perfil,
          registry: def.perfil,
          padrao: deps.perfilPadrao ?? PERFIL_PADRAO_FALLBACK,
        }).perfil;
      } catch (e) {
        return (e as Error).message;
      }
      const job = deps.fila.enfileirar({
        fila: def.fila,
        kind: def.kind,
        tarefa: def.command,
        input: JSON.stringify({
          entrada: cmd.pedido.entrada,
          ...(cmd.pedido.destino ? { destino: cmd.pedido.destino } : {}),
          ...(cmd.pedido.perfil ? { perfil: cmd.pedido.perfil } : {}),
          ...(cmd.pedido.campos ? { campos: cmd.pedido.campos } : {}),
        }),
        max_tentativas: def.max_tentativas,
        chat_id: deps.chatId,
        perfil,
      });
      const destino = cmd.pedido.destinoToken ? ` → ${cmd.pedido.destinoToken}` : '';
      return `enfileirado: job ${job.id} (${def.command})${destino}`;
    }

    case 'refazer': {
      const job = exigirJob(deps.fila, cmd.id);
      if (!job) return MSG_ID_DESCONHECIDO;
      // Job vivo não se refaz: reenfileirar agora deixaria dois jobs fazendo o
      // mesmo trabalho — e, em render, dois processos na mesma GPU.
      if (job.status === 'queued' || job.status === 'running') {
        return `job ${cmd.id} ainda está ${job.status} — nada a refazer.`;
      }
      const novo = deps.fila.enfileirar({
        fila: job.fila,
        kind: job.kind,
        tarefa: job.tarefa,
        input: job.input,
        max_tentativas: job.max_tentativas,
        chat_id: deps.chatId,
        ...(job.motor && job.modelo && job.esforco
          ? { perfil: { motor: job.motor, modelo: job.modelo, esforco: job.esforco } }
          : {}),
      });
      // O job velho continua no banco: `jobs` nunca é deletado, é o histórico.
      return `enfileirado: job ${novo.id} (${job.tarefa}) — refaz o ${cmd.id}`;
    }

    case 'erro':
      return cmd.mensagem;

    case 'livre':
      // Na etapa 2 quem trata texto livre é o `interpret`, chamado ANTES de
      // `executar` (é assíncrono e este módulo é síncrono de propósito).
      // Chegar aqui significa que ninguém tratou: responder algo honesto é
      // melhor que silêncio.
      return 'não entendi. Veja /ajuda ou /skills.';

    case 'desconhecido':
      // NUNCA ecoar cmd.texto de volta: é entrada do usuário, e a instrução é
      // explícita — a resposta aponta pro /ajuda, não repete o que foi digitado.
      return 'comando não reconhecido. Veja /ajuda.';
  }
}
