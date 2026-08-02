// Comandos do gateway, PUROS: nenhuma linha aqui conhece grammy ou a API do
// Telegram (regra herdada do v1 — nenhum teste deste bot bate na API real).
// `executar` só fala com o store; nunca imprime, nunca envia.
import { resolverPerfil } from '../dominio/perfil.js';
import type { SkillDef } from '../dominio/registry.js';
import { humano, medirSubpastas, tamanhoDe } from '../dominio/espaco.js';
import { CONCORRENCIAS, FILAS } from '../fila/filas.js';
import { analisar, textoSkills, type PedidoSkill } from './gramatica.js';
import type { Agora, Fila, Job, Perfil } from '../fila/types.js';
import type { FilaSqlite } from '../fila/store.js';

export type Comando =
  | { tipo: 'ping' }
  | { tipo: 'fila' }
  | { tipo: 'espaco' }
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
  /** Raízes que o `/espaco` mede. Injetadas porque quem sabe onde ficam é o
   * boot (`STATE_DIR`, `PUBLICO_DIR`), não este módulo. */
  areas?: { rotulo: string; caminho: string; doBot: boolean }[];
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
    case '/espaco':
    case '/espaço':
      return { tipo: 'espaco' };
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

/**
 * A ajuda em SEÇÕES, não em lista corrida.
 *
 * Eram 18 linhas seguidas, e `/status` aparecia duas vezes com descrições que
 * se contradiziam ("lista os jobs" e "os fluxos abertos") — sobra do dia em que
 * `/status` deixou de ser a lista de jobs e virou o painel de fluxos, sem que a
 * linha velha saísse. Uma lista desse tamanho sem agrupamento não é lida: quem
 * chega no chat quer saber PRIMEIRO o que está acontecendo, depois como agir.
 */
const AJUDA_SECOES: Array<{ titulo: string; linhas: Array<{ uso: string; descricao: string }> }> = [
  {
    titulo: 'Ver o que está acontecendo',
    linhas: [
      { uso: '/status', descricao: 'o painel dos fluxos ABERTOS — um por linha, com o que cada um espera de você' },
      { uso: '/completos', descricao: 'os fluxos que já terminaram, do mais novo para o mais velho' },
      { uso: '/jobs', descricao: 'a fila de jobs — o que está rodando e o que acabou' },
      { uso: '/fila', descricao: 'a saúde de cada fila: rodando, pendentes, idade, erro em 24h' },
      { uso: '/status <ref>', descricao: 'detalhe de um job (j13) ou de um fluxo (A#9, ou a9)' },
      { uso: '/ping', descricao: 'verifica se o bot está vivo' },
    ],
  },
  {
    titulo: 'Agir num fluxo ou num job',
    linhas: [
      { uso: '/pronto [ref]', descricao: 'terminei minha parte — libera o fluxo parado (sem ref, se só um espera). Também: /aprovar, /aprovado, /ok' },
      { uso: '/refazer <ref>', descricao: 'retenta: no fluxo, retoma da fase que falhou; num alvo, só ele' },
      { uso: '/cancelar <ref>', descricao: 'cancela um job ou um fluxo (o que já foi criado FORA continua lá)' },
      { uso: '/furar <id>', descricao: 'põe um job pendente na frente da fila' },
    ],
  },
  {
    titulo: 'Catálogo',
    linhas: [
      { uso: '/skills', descricao: 'as skills (uma etapa, sem estado)' },
      { uso: '/fluxos', descricao: 'os fluxos (várias fases, com estado e retomada)' },
      { uso: '/ajuda <nome>', descricao: 'a ajuda de UMA skill ou fluxo (/ajuda promoavatar). Sozinho — /ajuda ou /help — mostra esta lista' },
    ],
  },
  {
    titulo: 'Manutenção e espaço',
    linhas: [
      { uso: '/espaco', descricao: 'quanto disco cada área está ocupando (bot × skills)' },
      { uso: '/limpar <escopo>', descricao: 'A#8 · promoavatar · artefatos [dias] · tudo (mostra antes; só executa com "confirmar")' },
      { uso: 'http <url>', descricao: 'enfileira um GET' },
      { uso: 'thumb <caminho>', descricao: 'enfileira uma thumbnail' },
    ],
  },
];

/** A ajuda mistura os comandos FIXOS (serviço) com as skills do REGISTRY — a
 * lista de skills nunca é escrita à mão aqui, senão ela envelhece calada. */
function respostaAjuda(defs: SkillDef[]): string {
  const linhas: string[] = [];
  for (const secao of AJUDA_SECOES) {
    if (linhas.length) linhas.push('');
    linhas.push(`${secao.titulo}:`);
    for (const l of secao.linhas) linhas.push(`  ${l.uso} — ${l.descricao}`);
  }
  if (defs.length) {
    linhas.push('', 'Skills (formato `skill: entrada | campo`):');
    for (const d of defs) linhas.push(`  ${d.command}: … — ${d.descricao}`);
    linhas.push('', 'Campos: livesN (destino) · modelo=opus · esforco=high');
    linhas.push('Ajuda de um comando específico: /ajuda <nome>');
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
    `job j${job.id}${job.flow_ref ? ` · ${job.flow_ref}` : ''}`,
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
/**
 * Janela e teto das consultas do painel. `jobs` nunca é purgado (é o
 * histórico), então varrer a tabela inteira a cada `/fila` fica mais caro para
 * sempre. 30 dias e 500 linhas cobrem qualquer pergunta operacional — e um job
 * específico continua acessível por `/status <id>`, que busca por id.
 */
const JANELA_PAINEL_SEGUNDOS = 30 * 24 * 60 * 60;
const TETO_PAINEL = 500;
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
  // `j13` e não `13`: o número solto no começo da linha se confunde com
  // contagem, e o prefixo separa visualmente do id de FLUXO (`A#9`), que é
  // outra coisa. Do chat real: "o que é 13 reel?".
  //
  // E o `flow_ref` responde DE QUEM é o job. Sem ele, doze reels de um fluxo de
  // 12 públicos viram doze linhas idênticas, sem dizer qual público é qual nem
  // qual cancelar se um travar.
  const dono = job.flow_ref ? ` · ${job.flow_ref}` : '';
  return `${icone} j${job.id} ${job.tarefa}${dono}${entrada ? ` — ${entrada}` : ''}${quando ? ` (${quando})` : ''}`;
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
  const jobs = fila.listar({
    fila: nome, desde: agora - JANELA_PAINEL_SEGUNDOS, limite: TETO_PAINEL,
  });
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

  // Uma fila sem NADA a dizer não merece uma linha: com três das cinco zeradas,
  // elas ocupavam o mesmo espaço da única que importava e empurravam a manchete
  // (30 pendentes há uma hora) para o meio da tela.
  const temTaxa = falhas24h > 0;
  if (!rodando && !pendentes.length && !temTaxa && !retentados && !presos.length) {
    return '';
  }

  // Sem trabalho AGORA, mas com história (erro ou retentativa) na janela: a
  // linha existe pelo histórico, então "0 rodando · 0 na fila" é ruído — o que
  // se quer ler ali embaixo é a taxa de erro.
  const partes = rodando === 0 && pendentes.length === 0
    ? ['ocioso']
    : [`${rodando} rodando`, `${pendentes.length} na fila`];
  if (idadeMaisAntigo !== undefined) {
    partes.push(`mais antigo ${duracao(0, idadeMaisAntigo) ?? `${idadeMaisAntigo}s`}`);
  }
  const eta = estimativaDeVazao(nome, pendentes, jobs);
  if (eta) partes.push(`~${eta} para vazar`);

  const alerta = presos.length || (temTaxa && terminados24h.length > 0) ? '⚠️ ' : '';
  const linhas = [`${nome}: ${alerta}${partes.join(' · ')}`];

  // Taxa de erro SEM denominador engana nos dois sentidos: "50%" pode ser 1 de
  // 2 (ruído) ou 100 de 200 (incêndio), e quem lê não tem como saber qual.
  const detalhe: string[] = [];
  if (terminados24h.length) {
    detalhe.push(`erro 24h: ${taxaErro} (${falhas24h} de ${terminados24h.length})`);
  }
  if (retentados) detalhe.push(`${retentados} retentado${retentados > 1 ? 's' : ''}`);
  if (detalhe.length) linhas.push(`  ${detalhe.join(' · ')}`);

  if (presos.length) {
    linhas.push(`  ⚠️ possivelmente preso: ${presos.map((j) => `j${j.id}${j.flow_ref ? ` (${j.flow_ref})` : ''} ${duracao(j.iniciado_em, agora)}`).join(', ')}`);
  }
  return linhas.join('\n');
}

/**
 * Quanto tempo a fila leva para vazar, pela média REAL das tarefas pendentes
 * dividida pela concorrência da fila.
 *
 * Existe porque a conta estava sendo deixada para o leitor: o painel já
 * mostrava "30 pendentes" e "reel: 16m (58x)" em blocos diferentes, e ninguém
 * multiplica de cabeça. Sem média da tarefa não há estimativa — inventar um
 * número seria pior que não ter, porque um ETA errado vira decisão errada
 * ("dá tempo de reiniciar o serviço").
 */
function estimativaDeVazao(nome: Fila, pendentes: Job[], jobs: Job[]): string | undefined {
  if (!pendentes.length) return undefined;
  const duracoes = new Map<string, number[]>();
  for (const j of jobs) {
    if (j.status !== 'done' || j.iniciado_em === null || j.terminado_em === null) continue;
    duracoes.set(j.tarefa, [...(duracoes.get(j.tarefa) ?? []), j.terminado_em - j.iniciado_em]);
  }
  let total = 0;
  for (const p of pendentes) {
    const ds = duracoes.get(p.tarefa);
    if (!ds?.length) return undefined; // uma tarefa sem histórico já invalida a soma
    total += ds.reduce((a, b) => a + b, 0) / ds.length;
  }
  const segundos = Math.round(total / Math.max(1, CONCORRENCIAS[nome]));
  return duracao(0, segundos);
}

export function executar(cmd: Comando, deps: DepsComando): string {
  switch (cmd.tipo) {
    case 'ping':
      return 'pong';

    case 'ajuda':
      return respostaAjuda(deps.defs ?? []);

    case 'espaco': {
      const areas = deps.areas ?? [];
      if (!areas.length) return 'não sei quais áreas medir (config sem PUBLICO_DIR/STATE_DIR?).';
      const linhas: string[] = [];
      for (const a of areas) {
        const total = tamanhoDe(a.caminho);
        linhas.push(
          `${a.rotulo}: ${humano(total.bytes)} · ${total.arquivos} arquivo(s)`
          + (a.doBot ? '' : '  (não é só do bot)'),
        );
        for (const p of medirSubpastas(a.caminho)) {
          linhas.push(`   ${p.nome}: ${humano(p.bytes)} · ${p.arquivos}`);
        }
      }
      // Dizer de quem é cada área importa: a limpeza automática só pode nascer
      // onde o bot é dono. Varrer a pasta das skills seria apagar dado alheio.
      linhas.push('', 'Só a área do bot é dele para limpar. A das skills é de vários projetos.');
      return linhas.join('\n');
    }

    case 'fila': {
      const agora = deps.agora();
      const porFila = FILAS.map((f) => ({ nome: f, texto: resumoFila(deps.fila, f, agora) }));
      const linhas = porFila.filter((f) => f.texto).map((f) => f.texto);
      // As ociosas não somem — some o espaço que ocupavam. Sumir de vez faria o
      // painel esconder que a fila existe, e "não aparece" viraria "não sobe".
      const ociosas = porFila.filter((f) => !f.texto).map((f) => f.nome);
      if (ociosas.length) linhas.push(`ociosas: ${ociosas.join(', ')}`);
      const medias = mediasPorTarefa(
        deps.fila.listar({ desde: agora - JANELA_PAINEL_SEGUNDOS, limite: TETO_PAINEL }),
      );
      if (medias.length) linhas.push('', 'Duração média:', ...medias.map((m) => `  ${m}`));
      return linhas.join('\n');
    }

    case 'lista': {
      const agora = deps.agora();
      const todos = deps.fila.listar({ limite: TETO_PAINEL });
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
      return `enfileirado: job j${job.id} (http.get)`;
    }

    case 'thumb': {
      const job = deps.fila.enfileirar({
        fila: 'cpu',
        kind: 'function',
        tarefa: 'ffmpeg.thumb',
        input: JSON.stringify({ entrada: cmd.entrada }),
        chat_id: deps.chatId,
      });
      return `enfileirado: job j${job.id} (ffmpeg.thumb)`;
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
      return `enfileirado: job j${job.id} (${def.command})${destino}`;
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
