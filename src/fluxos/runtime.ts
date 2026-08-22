// Motor de fluxos: cria, avança, retenta, cancela.
//
// A regra que sustenta o desenho (spec §1): **quem orquestra não trabalha, quem
// trabalha não decide.** O worker executa um job e o marca `done`/`failed`; quem
// lê isso e escolhe a próxima fase é este arquivo — e faz isso DENTRO da
// transação do ack, para que "fase feita" e "próxima fase enfileirada" nunca
// existam separadas (foi assim que o v1 produziu dispatch duplicado).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { flowRef, type FaseDef, type FlowDef } from '../dominio/flow.js';
import { primeiraFala } from '../dominio/roteiro.js';
import type { FilaSqlite } from '../fila/store.js';
import type { Agora, Job, Perfil } from '../fila/types.js';
import { resolverPerfil } from '../dominio/perfil.js';
import { EstadoFluxos, type Fase, type Fluxo, type StatusFluxo } from './estado.js';
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
  publicar?: (origem: string, titulo: string, tipo: string) => Publicacao | undefined;
  /**
   * Perfil padrão do `.env`. Só é consultado quando uma fase declara `perfil`
   * no `flow.json` — aí o resolvido (fase sobre padrão) é gravado no job, para
   * que o log diga com que modelo aquela fase rodou.
   */
  perfilPadrao?: Perfil;
}

export interface EventoFluxo {
  chatId: number;
  texto: string;
  /**
   * Arquivo a ANEXAR — a faixa, a capa, o clipe.
   *
   * Até 2026-08-21 o portão de fluxo só empurrava texto, e o material ficava no
   * disco: o fluxo terminava e, do chat, "não acontecia nada". O bot já sabia
   * mandar documento (`transporte.enviarDocumento`), mas só no caminho de
   * notificação de job com chat — que fase de fluxo não tem, de propósito.
   */
  anexo?: string;
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
  /**
   * Opções pedidas na criação (`| api`, `| sem-portao`). Ficam AQUI, e não só
   * no gateway, porque é o runtime que monta as fases: uma fase `opcional`
   * declarada no `flow.json` só entra se a opção correspondente veio ligada, e
   * isso vale para qualquer chamador — gateway, teste ou import.
   */
  opcoes?: Record<string, boolean>;
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
  private readonly publicar?: (origem: string, titulo: string, tipo: string) => Publicacao | undefined;
  private readonly perfilPadrao: Perfil;

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
    this.perfilPadrao = opts.perfilPadrao ?? { motor: 'claude', modelo: 'sonnet', esforco: 'low' };
  }

  /**
   * A definição REALMENTE usada por este fluxo.
   *
   * Uma fase marcada `opcional: "api"` no `flow.json` só entra se a opção `api`
   * veio ligada na criação. Sem a opção, ela é REMOVIDA — não marcada como
   * pulada: um fluxo criado sem a opção tem que ficar idêntico ao de antes de a
   * fase existir, e "gerar: pulado" no `/status` explicaria algo que não vai
   * acontecer.
   *
   * Fica aqui, e não no gateway, porque é o runtime que monta as fases: import,
   * teste e qualquer outro chamador passam por este mesmo ponto.
   */
  private definicaoEfetiva(pedido: PedidoFluxo): FlowDef {
    const opcoes = pedido.opcoes ?? {};
    const fases = pedido.definicao.fases.filter((f) => !f.opcional || opcoes[f.opcional]);
    if (fases.length === pedido.definicao.fases.length) return pedido.definicao;
    return { ...pedido.definicao, fases };
  }

  private avisar(fluxo: Fluxo, texto: string, anexo?: string): void {
    if (fluxo.chat_id === null) return;
    this.aoEvento({ chatId: fluxo.chat_id, texto, ...(anexo ? { anexo } : {}) });
  }

  /**
   * Monta o plano SEM enfileirar (§7.5, modo sombra). É como se confere um
   * `flow.json` novo antes de gastar GPU e antes de tocar em serviço externo.
   */
  sombra(pedido: PedidoFluxo): ItemPlano[] {
    const definicao = this.definicaoEfetiva(pedido);
    const alvos = this.alvosDe(pedido);
    const partida = this.indiceDePartida(pedido);
    const plano: ItemPlano[] = [];
    for (const fase of definicao.fases.slice(partida)) {
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
    const fases = this.definicaoEfetiva(pedido).fases;
    const i = fases.findIndex((f) => f.id === pedido.de);
    if (i < 0) {
      throw new Error(
        `fase "${pedido.de}" não existe neste fluxo — fases: ${fases.map((f) => f.id).join(', ')}`,
      );
    }
    return i;
  }

  /** Cria o fluxo com a definição CONGELADA e enfileira a primeira fase. */
  criar(pedido: PedidoFluxo): Fluxo {
    // A definição GRAVADA é a efetiva: é ela que o `/status`, o `/refazer` e a
    // retomada vão ler daqui para frente.
    const definicao = this.definicaoEfetiva(pedido);
    const alvos = this.alvosDe(pedido);
    const partida = this.indiceDePartida(pedido);
    const fluxo = this.estado.criar({
      tipo: pedido.tipo,
      prefixo: definicao.prefixo,
      slug: slugificar(pedido.assunto),
      assunto: pedido.assunto,
      versao: pedido.versao ?? 1,
      chatId: pedido.chatId ?? null,
      definicao,
      hash: pedido.hash,
    });

    this.estado.criarFases(
      fluxo.id,
      definicao.fases.flatMap((fase, ordem) =>
        (fase.escopo === 'fluxo' ? [''] : alvos).map((alvo) => ({
          fase: fase.id, alvo, escopo: fase.escopo, ordem,
        })),
      ),
    );

    // Fases anteriores à partida: `pulado`, e ditas como tal. Marcar como
    // `feito` seria mentir sobre quem fez o trabalho.
    for (const fase of definicao.fases.slice(0, partida)) {
      for (const alvo of fase.escopo === 'fluxo' ? [''] : alvos) {
        this.estado.atualizarFase(fluxo.id, fase.id, alvo, { estado: 'pulado' });
      }
    }

    // A fase de partida entra agora; as demais nascem do avanço.
    const primeira = definicao.fases[partida]!;
    for (const alvo of primeira.escopo === 'fluxo' ? [''] : alvos) {
      this.enfileirarFase(fluxo, primeira, alvo);
    }
    this.log(
      `${fluxo.prefixo}#${fluxo.id} criado (${alvos.length} alvo(s), `
      + `${definicao.fases.length} fase(s)${partida ? `, começando em "${primeira.id}"` : ''})`,
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
    // Perfil DA FASE (precedência 2 em `resolverPerfil`). Sem `perfil` no
    // flow.json não gravamos nada e o worker cai no padrão do `.env`, que é o
    // comportamento de sempre — um fluxo antigo não muda de modelo por isto
    // existir. `skills.ts` exige os TRÊS campos para respeitar o job, então
    // resolvemos aqui contra o padrão em vez de gravar só o que a fase disse.
    const perfil = fase.perfil
      ? resolverPerfil({ fase: fase.perfil, padrao: this.perfilPadrao }).perfil
      : undefined;
    const job = this.fila.enfileirar({
      fila: fase.fila,
      kind: fase.kind,
      tarefa: fase.tarefa,
      // `perfil`, não `motor/modelo/esforco` soltos: é o campo que `NovoJob`
      // declara, e um spread com os três passa no typecheck (spread não dispara
      // excess-property check) e é descartado em silêncio no insert.
      ...(perfil ? { perfil } : {}),
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
        // Com `| api`, o portão continua existindo mas MUDA de significado: o
        // que se espera de você é revisar os textos, não gravar avatar nenhum.
        // Dizer isso importa porque as mensagens seguintes trazem os títulos de
        // estúdio, e sem esta linha elas parecem um pedido para gravar.
        const peloBot = def.fases.some((f) => f.tarefa === 'heygen.gerar');
        this.avisar(
          fluxo,
          `⏸️ ${fluxo.prefixo}#${fluxo.id} — fase ${fase.fase} concluída e AGUARDANDO você.\n`
          + (peloBot
            ? 'Revise os textos abaixo — os avatares quem gera é o BOT, e isso gasta da carteira.\n'
            : '')
          + `Quando estiver pronto: /aprovar ${fluxo.prefixo}#${fluxo.id}`,
        );
        this.entregarRoteiros(fluxo, faseDef);
      }
      return;
    }

    // SEM PORTÃO, MAS NÃO MUDO. `| sem-portao` REMOVE o `pausa_apos` da definição
    // congelada — e, até 2026-08-21, levava junto tudo o que a fase mandaria no
    // chat: o fluxo corria inteiro em silêncio e o material só aparecia no
    // disco. Não é o que se pede quando se pede "não me faça aprovar".
    //
    // A marca de que era isso: `portao.mostrar` declarado numa fase SEM
    // `pausa_apos`. Não acontece por acidente — a validação do `flow.json` exige
    // portão para declarar `portao`, então essa combinação só existe quando o
    // `sem-portao` tirou a pausa de um fluxo que tinha portão declarado.
    if (faseDef?.portao && this.faseCompleta(fluxo, fase.fase)) {
      this.avisar(
        fluxo,
        `▶️ ${fluxo.prefixo}#${fluxo.id} — fase ${fase.fase} concluída (sem portão, seguindo).`,
      );
      this.entregarDeclarado(fluxo, faseDef);
    }

    // PAUSADO não enfileira a próxima. O que já estava rodando termina (matar
    // render pago para "pausar" seria pior), mas a fase seguinte espera o
    // `/retomar` — que é o sentido inteiro da pausa.
    if (this.estado.obter(fluxo.id)?.status === 'pausado') {
      this.avisar(fluxo, `⏸️ ${fluxo.prefixo}#${fluxo.id} — fase ${fase.fase} terminou, e o fluxo está PAUSADO.`
        + ` Retome com /retomar ${fluxo.prefixo}#${fluxo.id}`);
      return;
    }

    const proxima = this.proximaFase(def, fase);
    if (proxima) {
      // Fase de escopo `fluxo` alimenta TODOS os alvos; fase de alvo alimenta só
      // o seu. É o que faz o promoavatar caber: 1 job de texto para 12 públicos,
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
  /**
   * O portão que o DOMÍNIO declarou (`portao.mostrar` no `flow.json`).
   *
   * Um item por mensagem, como nos roteiros: o que se faz com o conteúdo de um
   * portão é ler e decidir, e juntar tudo numa mensagem só empurra o começo
   * para fora da tela (`cortar`, no telegram.ts, trunca em ~4000 chars).
   *
   * Caminho que não resolve NÃO é silêncio: vira aviso com o marcador que ficou
   * sem valor. Portão que abre mudo é o defeito que isto existe para consertar.
   */
  private entregarDeclarado(fluxo: Fluxo, faseDef: FaseDef): void {
    const repo = this.repoDe(fluxo.tipo) ?? '';
    for (const alvo of this.alvosDoFluxo(fluxo)) {
      const fase = this.estado.fases(fluxo.id)
        .find((f) => f.fase === faseDef.id && (f.alvo === alvo || f.alvo === ''));
      const artefato = fase?.job_id == null ? '' : (this.fila.obter(fase.job_id)?.resultado?.trim() ?? '');
      for (const molde of faseDef.portao?.mostrar ?? []) {
        const caminho = resolverMostrar(molde, { repo, ref: `${fluxo.prefixo}${fluxo.id}`, alvo, artefato });
        if (!caminho) {
          this.avisar(fluxo, `⚠️ ${fluxo.prefixo}#${fluxo.id} — o portão pede "${molde}" e não consegui resolver.`);
          continue;
        }
        // MÍDIA VAI COMO ARQUIVO. Um `.mp3` lido como UTF-8 vira lixo no chat, e
        // era isso que impedia o material de chegar: o portão só sabia texto.
        //
        // ...menos VÍDEO, que vai como LINK — o mesmo caminho do promoavatar
        // (`entregarVideos`). Não é preferência de estilo: o clipe de uma música
        // de 3 minutos passa de 200 MB, e o Telegram recusa documento acima de
        // 50 MB. Anexar seria prometer entrega e falhar no arquivo que mais
        // importa. Sem `publicar` configurado (ou se a publicação falhar), cai
        // para anexo, e o texto do portão já carrega o caminho de qualquer jeito.
        if (ehMidia(caminho)) {
          const link = ehVideo(caminho)
            ? this.publicar?.(caminho, tituloPublicado(fluxo, faseDef.id, alvo), fluxo.tipo)
            : undefined;
          if (link) {
            this.avisar(fluxo, `🎬 ${basename(caminho)}\n${link.links[0]}`);
            continue;
          }
          this.avisar(fluxo, `📎 ${basename(caminho)}`, caminho);
          continue;
        }
        let corpo: string;
        try {
          corpo = readFileSync(caminho, 'utf8').trim();
        } catch {
          this.avisar(fluxo, `⚠️ ${fluxo.prefixo}#${fluxo.id} — o portão pede ${caminho}, que não consegui ler.`);
          continue;
        }
        const LIMITE = 3000;
        this.avisar(fluxo, corpo.length <= LIMITE
          ? corpo
          : `${corpo.slice(0, LIMITE)}\n\n[…cortado — inteiro em ${caminho}]`);
      }
      // Fase de escopo `fluxo` tem um resultado só: repetir por público mandaria
      // o mesmo texto N vezes.
      if (faseDef.escopo === 'fluxo') return;
    }
  }

  /**
   * O que a fase produziu, para o portão de um domínio que não escreve roteiro.
   *
   * Sai do `resultado` do job — o caminho que o agente declarou no `RESULT:` e
   * que o contrato do artefato já validou. Não adivinhamos formato: se der para
   * ler como texto, vai o texto; se for binário ou grande demais, vai o
   * caminho. Truncar em silêncio seria repetir o defeito que `cortar` já
   * causou no telegram.ts.
   */
  private artefatoDaFase(fluxo: Fluxo, faseDef: FaseDef | undefined, alvo: string): string | null {
    if (!faseDef) return null;
    const fase = this.estado.fases(fluxo.id)
      .find((f) => f.fase === faseDef.id && (f.alvo === alvo || f.alvo === ''));
    const caminho = fase?.job_id === null || fase?.job_id === undefined
      ? undefined
      : this.fila.obter(fase.job_id)?.resultado?.trim();
    if (!caminho) return null;
    const cabecalho = `📄 ${fluxo.prefixo}#${fluxo.id} — o que a fase ${faseDef.id} produziu:`;
    let texto: string;
    try {
      texto = readFileSync(caminho, 'utf8').trim();
    } catch {
      return `${cabecalho}\n${caminho}`;
    }
    if (!texto) return `${cabecalho}\n${caminho}`;
    const LIMITE = 3000;
    return texto.length <= LIMITE
      ? `${cabecalho}\n\n${texto}`
      : `${cabecalho}\n\n${texto.slice(0, LIMITE)}\n\n[…cortado — inteiro em ${caminho}]`;
  }

  private entregarRoteiros(fluxo: Fluxo, faseDef?: FaseDef): void {
    if (fluxo.chat_id === null) return;
    // O DOMÍNIO DECLAROU o que este portão mostra: obedecemos, e não há
    // heurística nenhuma depois. Um domínio que declara e mesmo assim recebe a
    // convenção de outro domínio no chat não teria por que declarar.
    if (faseDef?.portao) {
      this.entregarDeclarado(fluxo, faseDef);
      return;
    }
    const repo = this.repoDe(fluxo.tipo);
    if (!repo) {
      this.avisar(fluxo, `⚠️ Não sei o repo do fluxo "${fluxo.tipo}" — os roteiros não vão no chat.`);
      return;
    }
    const pasta = pastaTextos(repo, fluxo);
    const faltando: string[] = [];

    // QUAL PORTÃO decide o que vai no chat — não a rota do avatar.
    //
    // São dois portões e eles pedem coisas diferentes:
    //
    //  - o da fase que ESCREVE os textos (escopo `fluxo`): você precisa LER os
    //    roteiros para revisar antes de aprovar. Vão inteiros, um por público,
    //    sempre — mesmo quando o avatar é gerado sozinho. Revisar é o motivo
    //    de o portão existir.
    //  - o dos AVATARES (escopo `alvo`, depois do download): aqui não há o que
    //    ler, e 12 blocos de fala repetidos só empurram para cima a única coisa
    //    que se olha, que é QUAIS públicos entraram. Vai só a lista.
    //
    // Pedido do dono em 2026-08-04, corrigido em 2026-08-05: a primeira versão
    // condicionou pela ROTA (`| navega`) e tirou a fala do portão errado — o de
    // texto, justamente o que existe para ser lido.
    //
    // A leitura do arquivo continua acontecendo nos dois casos: é ela que
    // detecta roteiro faltando, e esse aviso vale mais no portão dos avatares —
    // sem ele, um público sem texto só apareceria 90 min depois, no download.
    const soLista = faseDef !== undefined && faseDef.escopo !== 'fluxo';
    const titulos: string[] = [];

    const todosAlvos = this.alvosDoFluxo(fluxo);
    const alvosVistos = todosAlvos.length;

    for (const alvo of todosAlvos) {
      const bruto = this.lerRoteiro(pasta, alvo);
      const fala = bruto === null ? null : primeiraFala(bruto);
      if (!fala) {
        faltando.push(alvo);
        continue;
      }
      if (soLista) {
        titulos.push(tituloEstudio(fluxo, alvo));
        continue;
      }
      // SEM emoji e sem `(${alvo})`: esta mensagem existe para ser SELECIONADA
      // e colada no HeyGen, e o `🎬` entra na seleção junto. O título já carrega
      // o público (`A9-jovens-v1`), então repetir só empurra a fala para baixo.
      // Os avisos que ninguém copia (portão, falta, fim) mantêm o emoji — ali
      // ele ajuda a varrer o chat com o olho.
      this.avisar(fluxo, `${tituloEstudio(fluxo, alvo)}\n\n${fala}`);
    }

    // UMA mensagem com a lista, não uma por público: aqui não há nada a copiar,
    // então dividir só faria o chat rolar. O título é o mesmo que a fase de
    // download procura por igualdade exata, e é por ele que se acha o vídeo no
    // estúdio se algo precisar de conferência.
    if (soLista && titulos.length) {
      this.avisar(
        fluxo,
        `🎬 ${fluxo.prefixo}#${fluxo.id} — ${titulos.length} avatar(es) a gerar:\n`
        + titulos.map((t) => `· ${t}`).join('\n'),
      );
    }

    // DOMÍNIO QUE NÃO ESCREVE ROTEIRO: quando NENHUM público tem arquivo, o que
    // falta não é um texto — é a convenção inteira. `textos/<REF>/<alvo>.md` é a
    // forma do promoavatar, e o portão nasceu com ela; o musicavideo produz um
    // PLANO.md na pasta de saída dele. No MVD#89 (2026-08-21) o portão abriu
    // dizendo só "sem roteiro": nada para ler, nada para decidir, e a fase
    // seguinte é a única paga do fluxo.
    //
    // Então mandamos o que a fase REALMENTE produziu — o artefato que ela
    // declarou no `RESULT:`, o mínimo que todo domínio tem por contrato.
    //
    // Só no TUDO-faltando, e não por público: no promoavatar, um público sem
    // texto entre outros doze continua sendo FALTA, e trocar o aviso pelo
    // artefato da fase esconderia justamente o defeito que o aviso existe para
    // mostrar.
    if (!soLista && faltando.length === alvosVistos && alvosVistos > 0) {
      const artefato = this.artefatoDaFase(fluxo, faseDef, faltando[0]!);
      if (artefato) {
        this.avisar(fluxo, artefato);
        return;
      }
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
      const pub = this.publicar?.(fase.dados, titulo, fluxo.tipo);
      if (!pub) {
        // O vídeo existe no disco do bot; só não deu para publicar. Dizer o
        // caminho é melhor que omitir — sem isto o alvo simplesmente sumiria
        // da mensagem final.
        this.avisar(fluxo, `🎬 ${titulo} — pronto, mas sem link: ${fase.dados}`);
        continue;
      }
      // UM link, o primeiro — não os três. `PUBLICO_URLS` lista as bases porque
      // a máquina responde por mais de um nome na rede local, mas isso é
      // detalhe de infra: quem recebe clica na primeira de qualquer jeito, e
      // três linhas por vídeo viram 108 num fluxo de 36 alvos, empurrando o
      // título seguinte para fora da tela. As outras bases continuam existindo
      // na config, para quem precisar montar a URL na mão.
      this.avisar(fluxo, `🎬 ${titulo}\n${pub.links[0]}`);
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
  /**
   * A fase terminou para TODOS os alvos — a versão sem portão do
   * `portaoCompleto`. Com 12 públicos, entregar a cada alvo mandaria a mesma
   * coisa 12 vezes; o que se quer é uma entrega quando a fase fecha.
   */
  private faseCompleta(fluxo: Fluxo, fase: string): boolean {
    const daFase = this.estado.fases(fluxo.id).filter((f) => f.fase === fase);
    return daFase.every((f) => f.estado === 'feito' || f.estado === 'pulado');
  }

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
  /**
   * Fluxos parados num portão, esperando uma pessoa.
   *
   * Existe para o comando SEM argumento poder adivinhar: quem acabou de gravar
   * os avatares não deveria ter que lembrar do número. Se houver exatamente um,
   * não há ambiguidade nenhuma.
   */
  /** Id, prefixo e tipo de cada fluxo — o que a limpeza precisa saber para
   * recortar por fluxo ou por tipo, sem carregar fase nenhuma. */
  listarResumo(): { id: number; prefixo: string; tipo: string }[] {
    return this.estado.listar().map((f) => ({ id: f.id, prefixo: f.prefixo, tipo: f.tipo }));
  }

  /** Todos os fluxos, ou só os de um status. O painel do chat vive disto:
   * `rodando`/`falhou` são os que ainda pedem alguma coisa de você,
   * `feito` é o histórico. */
  listarFluxos(status?: StatusFluxo): Fluxo[] {
    return this.estado.listar(status);
  }

  listarTipos(): string[] {
    return [...new Set(this.estado.listar().map((f) => f.tipo))];
  }

  aguardandoAprovacao(): Fluxo[] {
    return this.estado.listar().filter((f) =>
      this.estado.fases(f.id).some((fase) => fase.estado === 'aguardando-ok'));
  }

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
  /**
   * PAUSA o fluxo: tira da fila o que ainda não começou e não enfileira mais
   * nada até `/retomar`.
   *
   * A única saída antes disto era `/cancelar`, que mata e marca as fases como
   * puladas, sem volta. Quem só queria dar passagem a outro fluxo na fila
   * (`render` é uma vaga só) perdia o trabalho.
   *
   * O que está RODANDO continua até o fim, de propósito: matar um render de uma
   * hora para "pausar" é perder trabalho pago — e ele não vai enfileirar a fase
   * seguinte, porque a pausa é conferida no avanço.
   */
  pausar(fluxoId: number): { tirados: number; emCurso: number } {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) throw new Error('fluxo não existe');
    let tirados = 0;
    let emCurso = 0;
    for (const fase of this.estado.fases(fluxoId)) {
      if (fase.estado !== 'pendente' || fase.job_id === null) {
        if (fase.estado === 'rodando') emCurso += 1;
        continue;
      }
      // Job que ainda não começou volta a ser fase pendente SEM job: é assim
      // que o `/retomar` (e o reenfileirador do boot) sabe o que reenfileirar.
      if (this.fila.cancelar(fase.job_id)) tirados += 1;
      this.estado.atualizarFase(fluxoId, fase.fase, fase.alvo, { job_id: null });
    }
    this.estado.marcarStatus(fluxoId, 'pausado');
    return { tirados, emCurso };
  }

  /** RETOMA: volta a `rodando` e reenfileira o que estava liberado. */
  retomar(fluxoId: number): { enfileirados: number } {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) throw new Error('fluxo não existe');
    this.estado.marcarStatus(fluxoId, 'rodando');
    const def = this.estado.definicaoDe(fluxo);
    const todas = this.estado.fases(fluxoId);
    let enfileirados = 0;
    for (const fase of todas) {
      if (fase.estado !== 'pendente' || fase.job_id !== null) continue;
      if (!this.liberada(def, todas, fase)) continue;
      const faseDef = def.fases.find((f) => f.id === fase.fase);
      if (!faseDef) continue;
      this.enfileirarFase(fluxo, faseDef, fase.alvo);
      enfileirados += 1;
    }
    // Sem nada a enfileirar, o status volta a ser o que as fases dizem: um
    // fluxo que já tinha terminado não pode ficar "rodando" por ter sido
    // retomado.
    if (!enfileirados) this.estado.recalcularStatus(fluxoId);
    return { enfileirados };
  }

  /**
   * PRIORIZA: os jobs enfileirados deste fluxo saem primeiro.
   *
   * A fila `render` tem uma vaga (é a GPU), então dois fluxos grandes se
   * revezam por horas. Escolher qual termina antes era impossível pelo chat.
   * Só alcança job `queued`: um `running` já saiu da fila, e mudar prioridade
   * nele seria mexer num número morto.
   */
  priorizar(fluxoId: number, prioridade = 10): { furados: number } {
    let furados = 0;
    for (const fase of this.estado.fases(fluxoId)) {
      if (fase.job_id === null) continue;
      if (this.fila.priorizar(fase.job_id, prioridade)) furados += 1;
    }
    return { furados };
  }

  /**
   * REENTREGA o que o fluxo já produziu — o `/dados <ref>`.
   *
   * O material só chegava no instante em que cada portão abria. Se o fluxo
   * falhou depois, ou se a mensagem já rolou no chat, não havia como pedir de
   * novo: o `/status` mostra estado e causa, nunca conteúdo, e os arquivos
   * ficam numa pasta de saída alcançável só por `ls` na máquina.
   *
   * O caso que doeu: o MVD#89 tem faixa, capa e clipe INTEIROS no disco (US$
   * 0,08 pagos) e ficou preso atrás de um fluxo marcado como falho, por um
   * defeito de contrato que nem existe mais.
   *
   * Nada é regerado: isto só relê o que as fases declararam em `portao.mostrar`
   * e manda de novo. Fase que não declarou não entrega nada — e dizer isso vale
   * mais que silêncio, porque o vazio aqui é sempre falta de declaração.
   */
  reentregar(fluxoId: number): { fases: string[]; semDeclaracao: string[] } {
    const fluxo = this.estado.obter(fluxoId);
    if (!fluxo) throw new Error('fluxo não existe');
    const def = this.estado.definicaoDe(fluxo);
    const fases: string[] = [];
    const semDeclaracao: string[] = [];
    for (const faseDef of def.fases) {
      const linhas = this.estado.fases(fluxoId).filter((f) => f.fase === faseDef.id);
      if (!linhas.some((f) => f.estado === 'feito')) continue;
      if (!faseDef.portao) { semDeclaracao.push(faseDef.id); continue; }
      this.avisar(fluxo, `📦 ${fluxo.prefixo}#${fluxo.id} — ${faseDef.id}:`);
      this.entregarDeclarado(fluxo, faseDef);
      fases.push(faseDef.id);
    }
    return { fases, semDeclaracao };
  }

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

/**
 * Resolve um molde de `portao.mostrar` num caminho.
 *
 * `{{artefato:campo}}` lê `campo: valor` DENTRO do artefato — é o que permite a
 * um domínio entregar um caminho que só ele sabe montar (o slug do musicavideo
 * é derivado do texto e desambiguado com `-2`, e o bot nunca o conhece).
 *
 * Devolve `null` quando algum marcador fica sem valor: caminho meio resolvido
 * (`/out/{{artefato:plano}}/x`) aponta para lugar nenhum, e tentar ler daria uma
 * mensagem de erro pior que dizer que o molde não resolveu.
 */
export function resolverMostrar(
  molde: string,
  campos: { repo: string; ref: string; alvo: string; artefato: string },
): string | null {
  let faltou = false;
  const caminho = molde.replace(/\{\{([\w:]+)\}\}/g, (_, chave: string) => {
    if (chave.startsWith('artefato:')) {
      const campo = chave.slice('artefato:'.length);
      if (!campos.artefato) { faltou = true; return ''; }
      let texto: string;
      try {
        texto = readFileSync(campos.artefato, 'utf8');
      } catch {
        faltou = true;
        return '';
      }
      const m = new RegExp(`^\\s*${campo}\\s*:\\s*(.+)$`, 'im').exec(texto);
      if (!m) { faltou = true; return ''; }
      const valor = sanearValorDeRecibo(m[1]!);
      if (!valor) { faltou = true; return ''; }
      return valor;
    }
    const valor = (campos as Record<string, string>)[chave];
    if (!valor) { faltou = true; return ''; }
    return valor;
  });
  return faltou ? null : caminho;
}

/**
 * O que vai como ARQUIVO em vez de texto.
 *
 * Por extensão, e não por heurística de conteúdo: adivinhar "isto parece
 * binário" erra nos dois sentidos — um `.md` com um caractere estranho viraria
 * anexo, e um `.mp4` truncado viraria parede de lixo no chat. Extensão é o que
 * o domínio controla e o que o operador consegue prever.
 */
const EXT_MIDIA = new Set([
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
  'mp4', 'mov', 'webm', 'mkv',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'pdf', 'zip',
]);

/** `MVD89-capa-clipe` — o nome do arquivo publicado. Carrega a REF e a fase
 *  porque é o que permite achar o vídeo depois sem abrir o banco. */
function tituloPublicado(fluxo: Fluxo, fase: string, alvo: string): string {
  return `${fluxo.prefixo}${fluxo.id}-${fase}${alvo ? `-${alvo}` : ''}`;
}

const EXT_VIDEO = new Set(['mp4', 'mov', 'webm', 'mkv']);

/** Vídeo vai por LINK: o Telegram recusa documento acima de 50 MB, e clipe de
 *  música passa disso com folga. Mesma escolha do `entregarVideos`. */
export function ehVideo(caminho: string): boolean {
  return EXT_VIDEO.has(caminho.split('.').pop()?.toLowerCase() ?? '');
}

export function ehMidia(caminho: string): boolean {
  const ext = caminho.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIDIA.has(ext);
}

/**
 * O valor que veio de um RECIBO, saneado.
 *
 * Recibo é saída de programa — hoje do CLI do domínio, mas já foi de agente, e
 * pode voltar a ser. Um valor com quebra de linha, caractere de controle ou
 * comprimento absurdo não é caminho: é acidente (ou coisa pior) chegando a um
 * `readFileSync`, a uma mensagem de chat e, no `{{anterior:campo}}`, a uma
 * linha de comando. Risco que ESTE mecanismo introduziu em 2026-08-21, apontado
 * na revisão do mesmo dia.
 *
 * Uma linha, sem controles, no máximo 500 caracteres. Vazio = "não resolveu",
 * que os dois chamadores já sabem tratar (aviso no portão, argumento vazio no
 * comando — e nunca marcador cru).
 */
export function sanearValorDeRecibo(bruto: string): string {
  const linha = bruto.split(/[\r\n]/)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  const limpo = linha.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return limpo.length > 500 ? '' : limpo;
}
