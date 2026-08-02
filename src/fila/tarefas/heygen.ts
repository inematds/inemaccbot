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
}

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
