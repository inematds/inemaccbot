// Motor de fluxos: cria, avança, retenta, cancela.
//
// A regra que sustenta o desenho (spec §1): **quem orquestra não trabalha, quem
// trabalha não decide.** O worker executa um job e o marca `done`/`failed`; quem
// lê isso e escolhe a próxima fase é este arquivo — e faz isso DENTRO da
// transação do ack, para que "fase feita" e "próxima fase enfileirada" nunca
// existam separadas (foi assim que o v1 produziu dispatch duplicado).
import { readFileSync } from 'node:fs';
import { flowRef, type FaseDef, type FlowDef } from '../dominio/flow.js';
import { primeiraFala } from '../dominio/roteiro.js';
import type { FilaSqlite } from '../fila/store.js';
import type { Agora, Job } from '../fila/types.js';
import { EstadoFluxos, type Fase, type Fluxo } from './estado.js';
import { montarInput, pastaTextos, tituloEstudio } from './entrada-fase.js';
import type { Publicacao } from './publicar.js';

/** Arquivo ausente é resposta legítima ("este público não saiu"), não erro de
 * execução — o portão a transforma em linha de falta no chat. */
function lerRoteiroDoDisco(pasta: string, alvo: string): string | null {
  try {
    return readFileSync(`${pasta}/${alvo}.md`, 'utf8');
  } catch {
    return null;
  }
}

export interface OpcoesRuntime {
  fila: FilaSqlite;
  estado: EstadoFluxos;
  agora: Agora;
  /** Onde os artefatos de fluxo (avatares baixados) são gravados. */
  raizArtefatos?: string;
  /** Raiz dos repos `yt-pub-livesN` — o registry de destinos. */
  projetosDir?: string;
  log?: (m: string) => void;
  /**
   * Avisos para o chat. SÍNCRONO e sem rede de propósito: `avancar` roda dentro
   * da transação do ack, e mandar mensagem ali dentro seguraria a transação por
   * uma chamada de rede. Quem recebe isto só empilha; o envio acontece depois do
   * commit (ver src/index.ts).
   *
   * Sem isto um fluxo falharia em SILÊNCIO — o §8 proíbe, e a etapa 4 acabou de
   * gastar um documento inteiro fechando essa classe de buraco.
   */
  aoEvento?: (evento: EventoFluxo) => void;
  /**
   * Repo de domínio por tipo de fluxo (`config/fluxos.json`). Injetado, e não
   * lido aqui, porque quem valida o registry é o boot — `fluxos/` não conhece
   * `dominio/registry-fluxos`.
   */
  repoDe?: (tipo: string) => string | undefined;
  /**
   * Lê o roteiro de um público. Injetado para que o portão seja testável sem
   * disco; o padrão lê o arquivo que a fase de texto gravou.
   */
  lerRoteiro?: (pasta: string, alvo: string) => string | null;
  /**
   * Publica o vídeo final e devolve os links. Injetado porque só o boot conhece
   * a pasta servida e as bases de URL (`config.publicoDir`/`publicoUrls`).
   * Ausente = nenhum link vai ao chat, e o fluxo diz isso em vez de calar.
   */
  publicar?: (origem: string, titulo: string) => Publicacao | undefined;
}

export interface EventoFluxo {
  chatId: number;
  texto: string;
}

/** O que o gateway passa para criar um fluxo. */
export interface PedidoFluxo {
  tipo: string;
  definicao: FlowDef;
  hash: string;
  assunto: string;
  /** Subconjunto de alvos; ausente = todos os do `flow.json`. */
  alvos?: string[];
  versao?: number;
  chatId?: number | null;
  /**
   * Começa numa fase mais adiante: as anteriores nascem `pulado`.
   *
   * O caso real: a pessoa escreveu os textos (ou já gerou os avatares) por
   * fora, e quer que o bot continue do meio. As fases puladas ficam MARCADAS —
   * o `/status` não pode dizer que o bot fez um trabalho que ele não fez.
   */
  de?: string;
}

/** Uma linha do plano: o que SERIA enfileirado. É o que o modo sombra imprime. */
export interface ItemPlano {
  fase: string;
  alvo: string;
  fila: string;
  kind: string;
  tarefa: string;
}

function slugificar(texto: string): string {
  return texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'fluxo';
}

export class Fluxos {
  private readonly estado: EstadoFluxos;
  private readonly fila: FilaSqlite;
  private readonly agora: Agora;
  private readonly raizArtefatos: string;
  private readonly projetosDir: string;
  private readonly log: (m: string) => void;
  private readonly aoEvento: (evento: EventoFluxo) => void;
  private readonly repoDe: (tipo: string) => string | undefined;
  private readonly lerRoteiro: (pasta: string, alvo: string) => string | null;
  private readonly publicar?: (origem: string, titulo: string) => Publicacao | undefined;

  constructor(opts: OpcoesRuntime) {
    this.estado = opts.estado;
    this.fila = opts.fila;
    this.agora = opts.agora;
    this.raizArtefatos = opts.raizArtefatos ?? '/tmp';
    this.projetosDir = opts.projetosDir ?? '/tmp';
    this.log = opts.log ?? ((): void => {});
    this.aoEvento = opts.aoEvento ?? ((): void => {});
    this.repoDe = opts.repoDe ?? ((): undefined => undefined);
    this.lerRoteiro = opts.lerRoteiro ?? lerRoteiroDoDisco;
    this.publicar = opts.publicar;
  }

  private avisar(fluxo: Fluxo, texto: string): void {
    if (fluxo.chat_id === null) return;
    this.aoEvento({ chatId: fluxo.chat_id, texto });
  }

  /**
   * Monta o plano SEM enfileirar (§7.5, modo sombra). É como se confere um
   * `flow.json` novo antes de gastar GPU e antes de tocar em serviço externo.
   */
  sombra(pedido: PedidoFluxo): ItemPlano[] {
    const alvos = this.alvosDe(pedido);
    const partida = this.indiceDePartida(pedido);
    const plano: ItemPlano[] = [];
    for (const fase of pedido.definicao.fases.slice(partida)) {
      for (const alvo of fase.escopo === 'fluxo' ? [''] : alvos) {
        plano.push({
          fase: fase.id, alvo: alvo || '(todos)', fila: fase.fila,
          kind: fase.kind, tarefa: fase.tarefa,
        });
      }
    }
    return plano;
  }

  private alvosDe(pedido: PedidoFluxo): string[] {
    const todos = Object.keys(pedido.definicao.alvos);
    if (!pedido.alvos?.length) return todos;
    const desconhecidos = pedido.alvos.filter((a) => !todos.includes(a));
    if (desconhecidos.length) {
      throw new Error(`alvo desconhecido: ${desconhecidos.join(', ')} — conheço: ${todos.join(', ')}`);
    }
    return pedido.alvos;
  }

  /** Índice da fase de partida; erro claro quando o nome não existe. */
  private indiceDePartida(pedido: PedidoFluxo): number {
    if (!pedido.de) return 0;
    const i = pedido.definicao.fases.findIndex((f) => f.id === pedido.de);
    if (i < 0) {
      throw new Error(
        `fase "${pedido.de}" não existe neste fluxo — fases: ${pedido.definicao.fases.map((f) => f.id).join(', ')}`,
      );
    }
    return i;
  }

  /** Cria o fluxo com a definição CONGELADA e enfileira a primeira fase. */
  criar(pedido: PedidoFluxo): Fluxo {
    const alvos = this.alvosDe(pedido);
    const partida = this.indiceDePartida(pedido);
    const fluxo = this.estado.criar({
      tipo: pedido.tipo,
      prefixo: pedido.definicao.prefixo,
      slug: slugificar(pedido.assunto),
      assunto: pedido.assunto,
      versao: pedido.versao ?? 1,
      chatId: pedido.chatId ?? null,
      definicao: pedido.definicao,
      hash: pedido.hash,
    });

    this.estado.criarFases(
      fluxo.id,
      pedido.definicao.fases.flatMap((fase, ordem) =>
        (fase.escopo === 'fluxo' ? [''] : alvos).map((alvo) => ({
          fase: fase.id, alvo, escopo: fase.escopo, ordem,
        })),
      ),
    );

    // Fases anteriores à partida: `pulado`, e ditas como tal. Marcar como
    // `feito` seria mentir sobre quem fez o trabalho.
    for (const fase of pedido.definicao.fases.slice(0, partida)) {
      for (const alvo of fase.escopo === 'fluxo' ? [''] : alvos) {
        this.estado.atualizarFase(fluxo.id, fase.id, alvo, { estado: 'pulado' });
      }
    }

    // A fase de partida entra agora; as demais nascem do avanço.
    const primeira = pedido.definicao.fases[partida]!;
    for (const alvo of primeira.escopo === 'fluxo' ? [''] : alvos) {
      this.enfileirarFase(fluxo, primeira, alvo);
    }
    this.log(
      `${fluxo.prefixo}#${fluxo.id} criado (${alvos.length} alvo(s), `
      + `${pedido.definicao.fases.length} fase(s)${partida ? `, começando em "${primeira.id}"` : ''})`,
    );
    return fluxo;
  }

  /**
   * Enfileira UMA fase de UM alvo. `flow_ref` é a correlação exigida pelo §8:
   * `grep P#16` reconstrói a execução inteira.
   */
  private enfileirarFase(fluxo: Fluxo, fase: FaseDef, alvo: string): Job {
    const def = this.estado.definicaoDe(fluxo);
    // O que a fase ANTERIOR daquele alvo produziu (normalmente um caminho de
    // arquivo): é o que alimenta a próxima — o download consome o título, o
    // reel consome o .mp4 baixado.
    const anterior = this.dadosDaAnterior(fluxo, def, fase, alvo);
    const job = this.fila.enfileirar({
      fila: fase.fila,
      kind: fase.kind,
      tarefa: fase.tarefa,
      input: montarInput({
        fluxo, def, fase, alvo, anterior,
        raizArtefatos: this.raizArtefatos,
        projetosDir: this.projetosDir,
        ...(this.repoDe(fluxo.tipo) ? { repoDominio: this.repoDe(fluxo.tipo) as string } : {}),
        alvosDoFluxo: this.alvosDoFluxo(fluxo),
      }),
      max_tentativas: fase.max_tentativas,
      flow_ref: flowRef(fluxo.prefixo, fluxo.id, alvo, fase.id),
      // `chat_id` fica NULO de propósito: quem fala com o chat sobre um fluxo é
      // o fluxo (no fim, ou quando um alvo falha), não cada job de cada fase —
      // senão um P#16 de 12 alvos e 4 fases mandaria 48 mensagens.
      chat_id: null,
    });
    this.estado.atualizarFase(fluxo.id, fase.id, alvo, {
      estado: 'rodando', job_id: job.id, erro: null,
    });
    return job;
  }

  /**
   * Chamado DENTRO da transação do ack (ver `GanchoTransacional` no store).
   * Marca a fase e enfileira a próxima daquele alvo — ou fecha o fluxo.
   *
   * Cada alvo caminha independente: o alvo 3 pode estar no reel enquanto o 9
   * ainda espera o render (§3.5). Não há barreira entre fases.
   */
  avancar(job: Job): void {
    const fase = this.estado.faseDoJob(job.id);
    if (!fase) return; // job solto, não é fase de fluxo
    const fluxo = this.estado.obter(fase.fluxo_id);
    if (!fluxo) return;
    const def = this.estado.definicaoDe(fluxo);

    if (job.status === 'failed') {
      this.estado.atualizarFase(fluxo.id, fase.fase, fase.alvo, {
        estado: 'falhou', erro: job.erro, tentativas: job.tentativas,
      });
      // As fases SEGUINTES daquele alvo ficaram inalcançáveis: nunca vão rodar
      // enquanto esta não passar. Deixá-las `pendente` mentiria duas vezes — o
      // fluxo pareceria "rodando" para sempre, e a rede de segurança do boot
      // tentaria enfileirá-las. `pulado` é o estado honesto, e o `/refazer` as
      // traz de volta junto com a fase que falhou.
      this.marcarPosteriores(fluxo, def, fase, 'pulado');
      // Um alvo que falha NÃO derruba o fluxo: os outros seguem (§3.6).
      const statusFalha = this.estado.recalcularStatus(fluxo.id);
      this.log(`${fluxo.prefixo}#${fluxo.id}/${fase.alvo || '-'}/${fase.fase} FALHOU`);
      // §3.6.2: falha de alvo NOTIFICA no chat. Sem isto o fluxo morre calado.
      this.avisar(
        fluxo,
        `❌ ${fluxo.prefixo}#${fluxo.id} — alvo ${fase.alvo || '(todos)'} falhou na fase ${fase.fase}.\n`
        + `${(job.erro ?? '').slice(0, 300)}\n`
        + `Retentar: /refazer ${fluxo.prefixo}#${fluxo.id} ${fase.alvo}`.trimEnd(),
      );
      if (statusFalha !== 'rodando') this.avisarFim(fluxo, statusFalha);
      return;
    }

    this.estado.atualizarFase(fluxo.id, fase.fase, fase.alvo, {
      estado: 'feito', dados: job.resultado, tentativas: job.tentativas, erro: null,
    });

    const faseDef = def.fases.find((f) => f.id === fase.fase);

    // PORTÃO: a fase terminou, mas o fluxo não segue sozinho. Fica esperando
    // `/aprovar` — é assim que se modela tanto "quero revisar antes de gastar
    // render" quanto "esta etapa é feita fora do bot, por uma pessoa".
    if (faseDef?.pausa_apos) {
      this.estado.atualizarFase(fluxo.id, fase.fase, fase.alvo, { estado: 'aguardando-ok' });
      this.estado.recalcularStatus(fluxo.id);
      if (this.portaoCompleto(fluxo, def, fase.fase)) {
        this.avisar(
          fluxo,
          `⏸️ ${fluxo.prefixo}#${fluxo.id} — fase ${fase.fase} concluída e AGUARDANDO você.\n`
          + `Quando estiver pronto: /aprovar ${fluxo.prefixo}#${fluxo.id}`,
        );
        this.entregarRoteiros(fluxo);
      }
      return;
    }

    const proxima = this.proximaFase(def, fase);
    if (proxima) {
      // Fase de escopo `fluxo` alimenta TODOS os alvos; fase de alvo alimenta só
      // o seu. É o que faz o promoclub caber: 1 job de texto para 12 públicos,
      // depois 12 jobs de render.
      const alvos = proxima.escopo === 'fluxo'
        ? ['']
        : fase.escopo === 'fluxo'
          ? this.alvosDoFluxo(fluxo)
          : [fase.alvo];
      for (const alvo of alvos) this.enfileirarFase(fluxo, proxima, alvo);
    }
    const status = this.estado.recalcularStatus(fluxo.id);
    if (status !== 'rodando') this.avisarFim(fluxo, status);
  }

  /**
   * O portão manda os ROTEIROS, não só "concluída".
   *
   * Uma mensagem por público, porque cada uma é um vídeo a gravar e o que se faz
   * com ela é copiar e colar no estúdio: juntar os 12 num texto só obrigaria a
   * pessoa a caçar o trecho certo, e `cortar` (telegram.ts) truncaria em ~4000
   * chars — silenciosamente, que é o pior jeito de perder texto.
   *
   * O título vem de `tituloEstudio`, a MESMA função que monta o que
   * `heygen.baixar` procura por igualdade exata. Reescrevê-lo aqui à mão faria
   * a mensagem instruir um nome que o download não acha, e a fase expira em
   * 90 min esperando um vídeo que existe com outro nome.
   */
  private entregarRoteiros(fluxo: Fluxo): void {
    if (fluxo.chat_id === null) return;
    const repo = this.repoDe(fluxo.tipo);
    if (!repo) {
      this.avisar(fluxo, `⚠️ Não sei o repo do fluxo "${fluxo.tipo}" — os roteiros não vão no chat.`);
      return;
    }
    const pasta = pastaTextos(repo, fluxo);
    const faltando: string[] = [];

    for (const alvo of this.alvosDoFluxo(fluxo)) {
      const bruto = this.lerRoteiro(pasta, alvo);
      const fala = bruto === null ? null : primeiraFala(bruto);
      if (!fala) {
        faltando.push(alvo);
        continue;
      }
      // Sem `(${alvo})`: o título JÁ carrega o público (`A6-jovens-v1`), e
      // repetir empurra a fala para baixo numa mensagem que existe para ser
      // copiada.
      this.avisar(fluxo, `🎬 ${tituloEstudio(fluxo, alvo)}\n\n${fala}`);
    }

    // Falta NUNCA vira lista curta silenciosa: sem esta linha, um público sem
    // arquivo simplesmente não apareceria, e a pessoa gravaria 11 vídeos
    // achando que fez os 12 — o fluxo só reclamaria 90 min depois, no download.
    if (faltando.length) {
      this.avisar(
        fluxo,
        `⚠️ Sem roteiro em ${pasta}: ${faltando.join(', ')}.\n`
        + `Retentar a fase: /refazer ${fluxo.prefixo}#${fluxo.id}`,
      );
    }
  }

  private avisarFim(fluxo: Fluxo, status: string): void {
    const fases = this.estado.fases(fluxo.id);
    const feitas = fases.filter((f) => f.estado === 'feito').length;
    const falhas = fases.filter((f) => f.estado === 'falhou').length;
    this.avisar(
      fluxo,
      `${status === 'feito' ? '✅' : '⚠️'} ${fluxo.prefixo}#${fluxo.id} terminou: ${status}`
      + ` — ${feitas} fase(s) feita(s)${falhas ? `, ${falhas} falhada(s)` : ''}.`,
    );
    this.entregarVideos(fluxo, fases);
  }

  /**
   * O vídeo FINAL de cada alvo, com o nome do título e um link por rede.
   *
   * Só a ÚLTIMA fase por alvo: o fluxo produz um avatar no meio do caminho, e
   * mandar os dois links faria a pessoa baixar o errado. O que ela quer é o
   * reel pronto.
   *
   * Link e não anexo porque o reel do A#4 tem 38 MB — passa do teto prático do
   * Telegram e, mesmo quando cabe, chega comprimido.
   */
  private entregarVideos(fluxo: Fluxo, fases: Fase[]): void {
    if (fluxo.chat_id === null) return;
    const ultima = fases.filter((f) => f.alvo).reduce<Map<string, Fase>>((m, f) => {
      const atual = m.get(f.alvo);
      if (!atual || f.ordem > atual.ordem) m.set(f.alvo, f);
      return m;
    }, new Map());

    for (const [alvo, fase] of ultima) {
      if (fase.estado !== 'feito' || !fase.dados) continue;
      const titulo = tituloEstudio(fluxo, alvo);
      const pub = this.publicar?.(fase.dados, titulo);
      if (!pub) {
        // O vídeo existe no disco do bot; só não deu para publicar. Dizer o
        // caminho é melhor que omitir — sem isto o alvo simplesmente sumiria
        // da mensagem final.
        this.avisar(fluxo, `🎬 ${titulo} — pronto, mas sem link: ${fase.dados}`);
        continue;
      }
      this.avisar(fluxo, `🎬 ${titulo}\n${pub.links.join('\n')}`);
    }
  }

  /** Aplica `novo` às fases posteriores do MESMO alvo que estejam `pendente`
   * (na volta do `/refazer`, às que estiverem `pulado`). */
  private marcarPosteriores(
    fluxo: Fluxo, def: FlowDef, fase: Fase, novo: 'pulado' | 'pendente',
  ): void {
    const i = def.fases.findIndex((f) => f.id === fase.fase);
    if (i < 0) return;
    const de = novo === 'pulado' ? 'pendente' : 'pulado';
    for (const posterior of def.fases.slice(i + 1)) {
      // Quando quem falhou é uma fase GLOBAL, ela derruba os posteriores de
      // TODOS os alvos — não do alvo `''`, que nem existe nas fases por alvo.
      // Sem isto o fluxo ficava "rodando" para sempre depois de a fase global
      // falhar, e nunca avisava ninguém.
      const alvos = posterior.escopo === 'fluxo'
        ? ['']
        : fase.escopo === 'fluxo' ? this.alvosDoFluxo(fluxo) : [fase.alvo];
      for (const alvo of alvos) {
        const atual = this.estado.fase(fluxo.id, posterior.id, alvo);
        if (atual?.estado === de) {
          this.estado.atualizarFase(fluxo.id, posterior.id, alvo, { estado: novo });
        }
      }
    }
  }

  /** Todos os alvos daquela fase já chegaram ao portão? Só então vale avisar —
   * senão um fluxo de 12 públicos mandaria 12 mensagens de "aguardando". */
  private portaoCompleto(fluxo: Fluxo, def: FlowDef, fase: string): boolean {
    const daFase = this.estado.fases(fluxo.id).filter((f) => f.fase === fase);
    return daFase.every((f) => f.estado === 'aguardando-ok' || f.estado === 'pulado');
  }

  /**
   * `/aprovar P#16`: solta o portão e enfileira a fase seguinte de cada alvo.
   * Idempotente — aprovar duas vezes não duplica job, porque a fase deixa de
   * estar `aguardando-ok` na primeira.
   */
  aprovar(fluxoId: number): { liberados: number; fase?: string } {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) throw new Error('fluxo não existe');
    const def = this.estado.definicaoDe(fluxo);
    const esperando = this.estado.fases(fluxoId).filter((f) => f.estado === 'aguardando-ok');
    if (!esperando.length) return { liberados: 0 };

    let liberados = 0;
    for (const fase of esperando) {
      this.estado.atualizarFase(fluxoId, fase.fase, fase.alvo, { estado: 'feito' });
      const proxima = this.proximaFase(def, fase);
      if (!proxima) continue;
      const alvos = proxima.escopo === 'fluxo'
        ? ['']
        : fase.escopo === 'fluxo' ? this.alvosDoFluxo(fluxo) : [fase.alvo];
      for (const alvo of alvos) {
        // Não reenfileira o que já está em voo: aprovar duas vezes seguidas
        // poria dois jobs no mesmo trabalho.
        const atual = this.estado.fase(fluxoId, proxima.id, alvo);
        if (atual && (atual.estado === 'rodando' || atual.estado === 'feito')) continue;
        this.enfileirarFase(fluxo, proxima, alvo);
        liberados += 1;
      }
    }
    this.estado.recalcularStatus(fluxoId);
    return { liberados, fase: esperando[0]!.fase };
  }

  private dadosDaAnterior(fluxo: Fluxo, def: FlowDef, fase: FaseDef, alvo: string): string | null {
    const i = def.fases.findIndex((f) => f.id === fase.id);
    if (i <= 0) return null;
    const anterior = def.fases[i - 1]!;
    const alvoAnterior = anterior.escopo === 'fluxo' ? '' : alvo;
    return this.estado.fase(fluxo.id, anterior.id, alvoAnterior)?.dados ?? null;
  }

  private alvosDoFluxo(fluxo: Fluxo): string[] {
    return [...new Set(this.estado.fases(fluxo.id).map((f) => f.alvo).filter((a) => a !== ''))];
  }

  private proximaFase(def: FlowDef, fase: Fase): FaseDef | undefined {
    const i = def.fases.findIndex((f) => f.id === fase.fase);
    return i >= 0 ? def.fases[i + 1] : undefined;
  }

  /** Visão de `/status P#16`: fase × alvo × estado. */
  status(fluxoId: number): { fluxo: Fluxo; fases: Fase[] } | undefined {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) return undefined;
    return { fluxo, fases: this.estado.fases(fluxoId) };
  }

  /**
   * Só o que FALHOU volta, com as tentativas zeradas (§3.6.3). Um alvo só,
   * quando pedido. Nunca mexe no que está pendente ou rodando — isso poria dois
   * jobs no mesmo trabalho.
   */
  refazer(fluxoId: number, alvo?: string): {
    refeitos: number; jobs: number[]; itens: { fase: string; alvo: string; jobId: number }[];
  } {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) throw new Error('fluxo não existe');
    const def = this.estado.definicaoDe(fluxo);
    const jobs: number[] = [];
    // Quais fases voltaram, não só quantas: o chat precisa dizer O QUE está
    // rodando agora, senão quem mandou o comando não sabe se pegou.
    const itens: { fase: string; alvo: string; jobId: number }[] = [];

    for (const fase of this.estado.fases(fluxoId)) {
      if (fase.estado !== 'falhou') continue;
      if (alvo !== undefined && fase.alvo !== alvo) continue;
      const faseDef = def.fases.find((f) => f.id === fase.fase);
      if (!faseDef) continue;
      this.estado.atualizarFase(fluxoId, fase.fase, fase.alvo, {
        estado: 'pendente', tentativas: 0, erro: null, job_id: null,
      });
      // As fases que tinham ficado inalcançáveis voltam a esperar a vez.
      this.marcarPosteriores(fluxo, def, fase, 'pendente');
      const job = this.enfileirarFase(fluxo, faseDef, fase.alvo);
      jobs.push(job.id);
      itens.push({ fase: fase.fase, alvo: fase.alvo, jobId: job.id });
    }
    if (jobs.length) this.estado.marcarStatus(fluxoId, 'rodando');
    return { refeitos: jobs.length, jobs, itens };
  }

  /**
   * Cancela o fluxo (ou um alvo): mata os jobs vivos e marca as fases como
   * `pulado`. O que já foi criado FORA (um render no HeyGen) não é desfeito —
   * a mensagem tem que dizer o que ficou lá, para decisão humana (§3.7).
   */
  cancelar(fluxoId: number, alvo?: string): { cancelados: number } {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) throw new Error('fluxo não existe');
    let cancelados = 0;
    for (const fase of this.estado.fases(fluxoId)) {
      if (alvo !== undefined && fase.alvo !== alvo) continue;
      if (fase.estado !== 'pendente' && fase.estado !== 'rodando') continue;
      if (fase.job_id !== null && this.fila.cancelar(fase.job_id)) cancelados += 1;
      this.estado.atualizarFase(fluxoId, fase.fase, fase.alvo, { estado: 'pulado' });
    }
    if (alvo === undefined) this.estado.marcarStatus(fluxoId, 'cancelado');
    else this.estado.recalcularStatus(fluxoId);
    return { cancelados };
  }

  /**
   * Uma fase pendente está LIBERADA quando é a primeira do fluxo, ou quando a
   * anterior daquele alvo já ficou `feito`.
   *
   * Esta distinção não é detalhe: TODA fase futura nasce `pendente` sem job, por
   * desenho — ela está esperando a vez, não órfã. Sem isto, a rede de segurança
   * do boot enfileiraria o fluxo inteiro de uma vez, atropelando a ordem das
   * fases (defeito achado por teste vermelho, não por revisão).
   */
  private liberada(def: FlowDef, todas: Fase[], fase: Fase): boolean {
    const i = def.fases.findIndex((f) => f.id === fase.fase);
    if (i <= 0) return i === 0;
    const anterior = def.fases[i - 1]!;
    const alvoAnterior = anterior.escopo === 'fluxo' ? '' : fase.alvo;
    return todas.some(
      (f) => f.fase === anterior.id && f.alvo === alvoAnterior && f.estado === 'feito',
    );
  }

  /**
   * Rede de segurança do §3.6c: fase que JÁ DEVERIA estar rodando, mas não tem
   * job, volta para a fila. Cobre o processo morrer entre criar a linha da fase
   * e enfileirar o job — que a transação já impede, mas que um banco restaurado
   * de backup (ou um `importar`) apresenta.
   */
  reenfileirarOrfas(): number {
    let n = 0;
    for (const fluxo of this.estado.listar('rodando')) {
      const def = this.estado.definicaoDe(fluxo);
      const todas = this.estado.fases(fluxo.id);
      for (const fase of todas) {
        if (fase.estado !== 'pendente' || fase.job_id !== null) continue;
        if (!this.liberada(def, todas, fase)) continue;
        const faseDef = def.fases.find((f) => f.id === fase.fase);
        if (!faseDef) continue;
        this.enfileirarFase(fluxo, faseDef, fase.alvo);
        n += 1;
      }
    }
    if (n) this.log(`boot: ${n} fase(s) órfã(s) reenfileirada(s)`);
    return n;
  }
}
