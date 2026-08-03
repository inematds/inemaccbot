// Fase 2.5 do promoclub: descobre no HeyGen o vídeo daquele alvo, PELO TÍTULO, e
// baixa.
//
// Portado do `baixarTick` do v1, com duas diferenças de fundo:
//
//  1. Lá era um watcher varrendo todos os assuntos a cada 5 minutos, guiado por
//     um JSON de estado. Aqui é UMA fase de UM alvo: o poll é da fila
//     (`aindaNao` → `reagendar`), e o estado é a linha da fase.
//  2. O título é a chave de idempotência de verdade (§2.5): `P16-mulheres-v1` é
//     determinístico, então reexecutar a fase depois de um crash ACHA o vídeo
//     que já existe em vez de pedir outro. É por isso que o v1 encurtou o
//     título — o longo truncava e o download nunca casava.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tarefa } from '../worker.js';
import type { ContextoTarefa } from '../types.js';

export interface VideoHeygen {
  videoId: string;
  status: string;
}

/** O mínimo da API do HeyGen de que esta fase depende — injetado, para o teste
 * não tocar a rede. */
export interface ClienteHeygen {
  /** título → vídeo, entre os mais recentes da conta. */
  porTitulo(titulos: string[], sinal?: AbortSignal): Promise<Map<string, VideoHeygen>>;
  urlDe(videoId: string, sinal?: AbortSignal): Promise<string | null>;
  baixar(url: string, destino: string, sinal?: AbortSignal): Promise<void>;
  /** Cria o vídeo no estúdio e devolve o `video_id`. Só é chamado pela fase
   *  `gerar` (a opção `| api`); o fluxo manual nunca passa por aqui. */
  gerar(pedido: PedidoDeGeracao, sinal?: AbortSignal): Promise<string>;
  /** Saldo da carteira em US$. `null` quando não deu para saber — medidor
   *  quebrado não pode virar bloqueio do pipeline. */
  saldo(sinal?: AbortSignal): Promise<number | null>;
}

export interface PedidoDeGeracao {
  /** O MESMO título que a fase `baixar` vai procurar. É o que dispensa carregar
   *  `video_id` de uma fase para a outra. */
  titulo: string;
  texto: string;
  avatarId: string;
  voiceId: string;
  /** Motor: `avatar_iii` | `avatar_iv` | `avatar_v`. SEMPRE explícito — ver
   *  `MOTOR_PADRAO`. */
  engine: string;
  /** `Idempotency-Key`: derivada do título, nunca sorteada — ver `criarHeygenGerar`. */
  chave: string;
}

/**
 * Motor quando o domínio não escolhe.
 *
 * `avatar_iii` porque é o barato: US$ 0,0167/s contra US$ 0,05–0,0667/s do
 * Avatar IV — 3 a 4× pelo mesmo minuto. E o `/v3/videos` usa **Avatar IV por
 * padrão** quando o campo é omitido ("Avatar IV is used by default when 'engine'
 * is omitted", doc da própria CLI), então omitir não é neutro: é escolher o caro
 * sem perceber. Num fluxo de 36 alvos a diferença é ~US$ 26 contra ~US$ 80–105.
 */
export const MOTOR_PADRAO = 'avatar_iii';

export interface EntradaHeygen {
  /** Título exato no estúdio: `P16-mulheres-v1`. */
  titulo: string;
  /** Onde gravar o .mp4. */
  destino: string;
  /** Janela de poll da fase (segundos), vinda do `flow.json` congelado. */
  espera?: { intervalo: number; timeout: number };
}

/**
 * Lê a chave em RUNTIME, do arquivo apontado pela config. Nunca no código, nunca
 * no repo — regra dura do domínio, e §9 do spec.
 */
export function lerChaveHeygen(envPath: string, ler: (p: string) => string): string {
  const env: Record<string, string> = {};
  let conteudo: string;
  try {
    conteudo = ler(envPath);
  } catch {
    // Mensagem própria: o ENOENT cru do Node não diz O QUE se procurava ali, e
    // esse arquivo é config de máquina, não de repo.
    throw new Error(`não consegui ler o arquivo da HEYGEN_API_KEY: ${envPath}`);
  }
  for (const linha of conteudo.split('\n')) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const chave = env.HEYGEN_API_KEY;
  if (!chave) throw new Error(`HEYGEN_API_KEY não encontrada em ${envPath}`);
  return chave;
}

/** O que o `video_status.get` devolve sobre o vídeo pronto. */
export interface DadosDoVideo {
  /** MP4 sem legenda queimada. */
  video_url?: string | null;
  /** O MESMO vídeo com a legenda QUEIMADA nos pixels — só vem preenchido
   *  quando o render do estúdio foi feito com legenda. */
  video_url_caption?: string | null;
}

/**
 * Qual MP4 baixar — e a regra é: **quem decide sobre legenda é o estúdio.**
 *
 * Se o render foi feito COM legenda, `video_url_caption` vem preenchido e é ele
 * que queremos: a legenda foi uma escolha de quem gravou. Se foi feito sem,
 * esse campo vem nulo (ou vazio) e caímos no `video_url` limpo. Não há terceira
 * opção a pedir da API: a URL é pronta, sem `?estilo=`/`?formato=`, e os seis
 * endpoints de legenda (`video.caption`, `video/caption`, `video.subtitle`,
 * `caption.list`, `caption_styles`, `v2/video/<id>`) dão 404 — estilo, fonte e
 * posição se decidem no estúdio, antes de renderizar.
 *
 * Duas consequências que quem gravar precisa saber, e que nenhum código
 * desfaz: legenda queimada vem enquadrada para 16:9, então no reel 9:16 ela
 * pode ser cortada ou colidir com a base; e se o reel também for montado com
 * `| legenda`, saem DUAS. Ligar uma é decidir desligar a outra.
 *
 * Medido em 2026-08-01, nos 25 vídeos completos mais recentes da conta (todos
 * gravados sem legenda): `video_url_caption` nulo em todos — ou seja, hoje o
 * caminho normal continua sendo o limpo, e este código só muda o dia em que
 * alguém gravar com legenda ligada.
 */
export function escolherUrl(dados: DadosDoVideo | undefined): string | null {
  return dados?.video_url_caption || dados?.video_url || null;
}

export function criarClienteHeygen(
  chaveDe: () => string, buscar: typeof fetch = fetch,
): ClienteHeygen {
  return {
    // Todo `fetch` leva o SINAL: quando o worker desiste do job (encerramento
    // ou lease perdido), a requisição em voo tem que parar junto — senão o
    // download continua escrevendo o arquivo de um job já marcado como falho.
    // (Este contrato tem teste de catálogo; foi ele que pegou a primeira versão
    // desta tarefa, que ignorava o sinal.)
    async porTitulo(titulos, sinal) {
      // `limit=100` porque o v1 já pagou por isso: com o default, um vídeo
      // gerado há alguns dias sumia da página e o download travava.
      const r = await buscar('https://api.heygen.com/v1/video.list?limit=100', {
        headers: { 'X-Api-Key': chaveDe(), Accept: 'application/json' },
        signal: sinal,
      });
      if (!r.ok) throw new Error(`video.list HTTP ${r.status}`);
      const dados = (await r.json()) as {
        data?: { videos?: { video_id: string; video_title: string; status: string }[] };
      };
      const querido = new Set(titulos);
      const saida = new Map<string, VideoHeygen>();
      for (const v of dados.data?.videos ?? []) {
        if (querido.has(v.video_title) && !saida.has(v.video_title)) {
          saida.set(v.video_title, { videoId: v.video_id, status: v.status });
        }
      }
      return saida;
    },
    async urlDe(videoId, sinal) {
      const r = await buscar(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
        headers: { 'X-Api-Key': chaveDe() },
        signal: sinal,
      });
      if (!r.ok) throw new Error(`video_status.get HTTP ${r.status}`);
      const dados = (await r.json()) as { data?: DadosDoVideo };
      return escolherUrl(dados.data);
    },
    // `/v3/videos` porque é o endpoint vivo (o `/v2/video/generate` é o legado)
    // e é ele que aceita o `Idempotency-Key` — a trava que impede um restart no
    // meio de gerar (e cobrar) o mesmo vídeo duas vezes.
    async gerar(pedido, sinal) {
      const r = await buscar('https://api.heygen.com/v3/videos', {
        method: 'POST',
        headers: {
          'X-Api-Key': chaveDe(),
          'Content-Type': 'application/json',
          'Idempotency-Key': pedido.chave,
        },
        // O TÍTULO é o contrato com a fase `baixar`: ela procura por igualdade
        // exata desta string.
        body: JSON.stringify({
          type: 'avatar',
          avatar_id: pedido.avatarId,
          voice_id: pedido.voiceId,
          script: pedido.texto,
          title: pedido.titulo,
          engine: { type: pedido.engine },
          aspect_ratio: '16:9',
          output_format: 'mp4',
        }),
        signal: sinal,
      });
      if (!r.ok) {
        // O corpo do erro entra na mensagem: sem saldo, avatar inexistente e
        // texto longo demais são três causas diferentes com o mesmo HTTP 400, e
        // sem o corpo o operador fica adivinhando.
        const corpo = await r.text().catch(() => '');
        throw new Error(`video.generate HTTP ${r.status}${corpo ? `: ${corpo.slice(0, 300)}` : ''}`);
      }
      const dados = (await r.json()) as { data?: { video_id?: string; id?: string } };
      const id = dados.data?.video_id ?? dados.data?.id;
      if (!id) throw new Error('video.generate: resposta sem video_id');
      return id;
    },
    async saldo(sinal) {
      // `/v3/users/me` é o endpoint vivo do saldo (`wallet.remaining_balance`).
      // Qualquer falha vira `null`, nunca exceção: este número é um guarda-
      // -corpo, e um guarda-corpo que derruba a fase é pior que nenhum.
      try {
        const r = await buscar('https://api.heygen.com/v3/users/me', {
          headers: { 'X-Api-Key': chaveDe() },
          signal: sinal,
        });
        if (!r.ok) return null;
        const d = (await r.json()) as { data?: { wallet?: { remaining_balance?: number } } };
        const v = d.data?.wallet?.remaining_balance;
        return typeof v === 'number' ? v : null;
      } catch {
        return null;
      }
    },
    async baixar(url, destino, sinal) {
      const r = await buscar(url, { signal: sinal });
      if (!r.ok) throw new Error(`download HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('download vazio');
      mkdirSync(join(destino, '..'), { recursive: true });
      writeFileSync(destino, buf);
    },
  };
}

export function criarHeygenBaixar(cliente: ClienteHeygen): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    // Sinal já abortado: não começa. Vale para qualquer tarefa, e aqui evita
    // ler credencial e abrir conexão para um job que o worker já largou.
    if (ctx.sinal.aborted) {
      throw ctx.sinal.reason instanceof Error
        ? ctx.sinal.reason
        : new Error(`heygen.baixar: abortado (${String(ctx.sinal.reason)})`);
    }
    const { titulo, destino, espera } = JSON.parse(ctx.job.input || '{}') as Partial<EntradaHeygen>;
    if (!titulo || !destino) throw new Error('heygen.baixar: input precisa de { titulo, destino }');

    // Procure ANTES de criar (§2.5): o arquivo já baixado é a resposta. Sem
    // isto, uma retentativa depois de um crash baixaria de novo — e, pior, o
    // reel seria enfileirado duas vezes.
    if (existsSync(destino) && statSync(destino).size > 0) return destino;

    // Prazo da fase, contado do PRIMEIRO enfileiramento (`criado_em`), não de
    // cada checagem — senão o relógio zeraria a cada poll e a espera seria
    // eterna. Estourar aqui é falha de verdade: o vídeo não veio.
    if (espera && ctx.agora() - ctx.job.criado_em > espera.timeout) {
      throw new Error(
        `heygen.baixar: "${titulo}" não apareceu no HeyGen em ${Math.round(espera.timeout / 60)} min`,
      );
    }

    const achados = await cliente.porTitulo([titulo], ctx.sinal);
    const v = achados.get(titulo);
    if (!v) {
      // O caso NORMAL enquanto a pessoa ainda não gerou o vídeo, ou o estúdio
      // ainda não o listou. Não é falha: é "ainda não".
      ctx.aindaNao(`"${titulo}" ainda não aparece no HeyGen`, espera?.intervalo);
    }
    if (v.status !== 'completed') ctx.aindaNao(`"${titulo}" está ${v.status}`, espera?.intervalo);

    const url = await cliente.urlDe(v.videoId, ctx.sinal);
    if (!url) ctx.aindaNao(`"${titulo}" está completed mas ainda sem video_url`, espera?.intervalo);

    await cliente.baixar(url, destino, ctx.sinal);
    if (!existsSync(destino) || statSync(destino).size === 0) {
      throw new Error(`heygen.baixar: arquivo vazio depois do download: ${destino}`);
    }
    ctx.log(`heygen.baixar: ${titulo} → ${destino}`);
    return destino;
  };
}

/**
 * Piso de saldo para começar UM vídeo, em US$.
 *
 * A doc da HeyGen cobra ~US$ 1 por minuto de avatar padrão, e a média medida na
 * conta (39 vídeos, 2026-08-02) é 44s — então um vídeo fica perto de US$ 0,75.
 * O piso é 1 para não começar o que não dá para terminar.
 *
 * Por que não `saldo > 0`: a carteira estava em **US$ 0,22** quando isto foi
 * escrito. Um teto em zero passaria, o vídeo seria pedido, e a fase morreria no
 * meio do fluxo — com os alvos anteriores já cobrados, que é o pior estado para
 * refazer.
 */
const PISO_POR_VIDEO = 1;

/** Entrada da fase `gerar` (opção `| api`). */
export interface EntradaGerar {
  /** O mesmo título que a fase `baixar` procura depois. */
  titulo: string;
  /** A FALA do roteiro — o que o avatar diz. */
  texto: string;
  avatarId: string;
  voiceId: string;
  /** Motor do `flow.json`; sem ele, `MOTOR_PADRAO`. */
  engine?: string;
  espera?: { intervalo: number; timeout: number };
}

/**
 * `heygen.gerar` — a fase de avatar feita pela API, alternativa a gravar no
 * estúdio. Só existe no fluxo quando `| api` foi pedida na criação.
 *
 * Duas travas contra COBRAR DUAS VEZES, e as duas são obrigatórias:
 *
 * 1. **Procure antes de criar (§2.5).** Se o título já está no estúdio — em
 *    QUALQUER status — a tentativa anterior já gerou e já cobrou. Não se gera
 *    outro. É o mesmo idioma do `heygen.baixar`, que confere o arquivo no disco
 *    antes de baixar.
 * 2. **`Idempotency-Key` derivada do título.** A API replica a resposta
 *    original quando a mesma chave chega em até 24h. Sorteá-la não serviria de
 *    nada justamente no caso que interessa: o `código 143` (SIGTERM de restart)
 *    mata o processo e a retentativa sorteia outra chave.
 *
 * Não baixa nada: quem baixa é a fase `baixar`, pelo título, sem saber se o
 * vídeo veio da API ou da mão de alguém.
 */
export function criarHeygenGerar(cliente: ClienteHeygen): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    if (ctx.sinal.aborted) {
      throw ctx.sinal.reason instanceof Error
        ? ctx.sinal.reason
        : new Error(`heygen.gerar: abortado (${String(ctx.sinal.reason)})`);
    }
    const { titulo, texto, avatarId, voiceId, engine, espera } =
      JSON.parse(ctx.job.input || '{}') as Partial<EntradaGerar>;
    if (!titulo) throw new Error('heygen.gerar: input precisa de { titulo }');
    if (!texto?.trim()) throw new Error(`heygen.gerar: ${titulo} sem texto para falar`);
    if (!avatarId) throw new Error(`heygen.gerar: ${titulo} sem avatar (avatar_id no flow.json)`);
    if (!voiceId) throw new Error(`heygen.gerar: ${titulo} sem voz (voice_id no flow.json)`);

    if (espera && ctx.agora() - ctx.job.criado_em > espera.timeout) {
      throw new Error(
        `heygen.gerar: "${titulo}" não ficou pronto em ${Math.round(espera.timeout / 60)} min`,
      );
    }

    const jaEsta = (await cliente.porTitulo([titulo], ctx.sinal)).get(titulo);
    if (!jaEsta) {
      // A carteira da HeyGen é PRÉ-PAGA. Sem esta conferência, um fluxo de 36
      // alvos geraria até o saldo acabar e falharia no meio — com os primeiros
      // já cobrados e o resto não, que é o pior dos dois mundos para refazer.
      // `null` (medidor indisponível) NÃO bloqueia: o pipeline pararia por
      // causa do medidor, não da conta.
      const saldo = await cliente.saldo(ctx.sinal);
      if (saldo !== null && saldo < PISO_POR_VIDEO) {
        throw new Error(
          `heygen.gerar: carteira da HeyGen com US$ ${saldo.toFixed(2)} — menos que o custo de um vídeo `
          + `(~US$ ${PISO_POR_VIDEO.toFixed(2)}). Recarregue antes de usar | api.`,
        );
      }
      await cliente.gerar(
        {
          titulo, texto, avatarId, voiceId,
          engine: engine || MOTOR_PADRAO,
          chave: chaveIdempotente(titulo),
        },
        ctx.sinal,
      );
      ctx.log(`heygen.gerar: ${titulo} enviado para o estúdio`);
      ctx.aindaNao(`"${titulo}" foi enviado e está sendo gerado`, espera?.intervalo);
    }

    // `failed` no estúdio não é "ainda não": insistir no poll gastaria a janela
    // inteira esperando um vídeo que não vem. Falhar aqui deixa o `/refazer`
    // seletivo fazer o que ele existe para fazer.
    if (jaEsta.status === 'failed') {
      throw new Error(`heygen.gerar: "${titulo}" falhou no estúdio`);
    }
    if (jaEsta.status !== 'completed') {
      ctx.aindaNao(`"${titulo}" está ${jaEsta.status}`, espera?.intervalo);
    }
    ctx.log(`heygen.gerar: ${titulo} pronto`);
    // O TÍTULO é o resultado, não o caminho: a fase seguinte procura por ele.
    return titulo;
  };
}

/**
 * A chave de idempotência. O título já é único por fluxo × alvo × versão
 * (`C15-jovens-alc-v1`) — é exatamente a identidade que se quer, e ela
 * sobrevive a restart, que é o caso todo.
 *
 * `[A-Za-z0-9_:.-]` é o alfabeto que a API aceita; o título já cabe nele, mas a
 * limpeza fica aqui para um alvo com acento não virar 400 no meio de um fluxo.
 */
function chaveIdempotente(titulo: string): string {
  return `gerar-${titulo.normalize('NFD').replace(/[^A-Za-z0-9_:.-]/g, '-')}`.slice(0, 255);
}
