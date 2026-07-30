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
  porTitulo(titulos: string[]): Promise<Map<string, VideoHeygen>>;
  urlDe(videoId: string): Promise<string | null>;
  baixar(url: string, destino: string): Promise<void>;
}

export interface EntradaHeygen {
  /** Título exato no estúdio: `P16-mulheres-v1`. */
  titulo: string;
  /** Onde gravar o .mp4. */
  destino: string;
}

/**
 * Lê a chave em RUNTIME, do arquivo apontado pela config. Nunca no código, nunca
 * no repo — regra dura do domínio, e §9 do spec.
 */
export function lerChaveHeygen(envPath: string, ler: (p: string) => string): string {
  const env: Record<string, string> = {};
  for (const linha of ler(envPath).split('\n')) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const chave = env.HEYGEN_API_KEY;
  if (!chave) throw new Error(`HEYGEN_API_KEY não encontrada em ${envPath}`);
  return chave;
}

export function criarClienteHeygen(
  chaveDe: () => string, buscar: typeof fetch = fetch,
): ClienteHeygen {
  return {
    async porTitulo(titulos) {
      // `limit=100` porque o v1 já pagou por isso: com o default, um vídeo
      // gerado há alguns dias sumia da página e o download travava.
      const r = await buscar('https://api.heygen.com/v1/video.list?limit=100', {
        headers: { 'X-Api-Key': chaveDe(), Accept: 'application/json' },
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
    async urlDe(videoId) {
      const r = await buscar(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
        headers: { 'X-Api-Key': chaveDe() },
      });
      if (!r.ok) throw new Error(`video_status.get HTTP ${r.status}`);
      const dados = (await r.json()) as { data?: { video_url?: string } };
      return dados.data?.video_url ?? null;
    },
    async baixar(url, destino) {
      const r = await buscar(url);
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
    const { titulo, destino } = JSON.parse(ctx.job.input || '{}') as Partial<EntradaHeygen>;
    if (!titulo || !destino) throw new Error('heygen.baixar: input precisa de { titulo, destino }');

    // Procure ANTES de criar (§2.5): o arquivo já baixado é a resposta. Sem
    // isto, uma retentativa depois de um crash baixaria de novo — e, pior, o
    // reel seria enfileirado duas vezes.
    if (existsSync(destino) && statSync(destino).size > 0) return destino;

    const achados = await cliente.porTitulo([titulo]);
    const v = achados.get(titulo);
    if (!v) {
      // O caso NORMAL enquanto a pessoa ainda não gerou o vídeo, ou o estúdio
      // ainda não o listou. Não é falha: é "ainda não".
      ctx.aindaNao(`"${titulo}" ainda não aparece no HeyGen`);
    }
    if (v.status !== 'completed') ctx.aindaNao(`"${titulo}" está ${v.status}`);

    const url = await cliente.urlDe(v.videoId);
    if (!url) ctx.aindaNao(`"${titulo}" está completed mas ainda sem video_url`);

    await cliente.baixar(url, destino);
    if (!existsSync(destino) || statSync(destino).size === 0) {
      throw new Error(`heygen.baixar: arquivo vazio depois do download: ${destino}`);
    }
    ctx.log(`heygen.baixar: ${titulo} → ${destino}`);
    return destino;
  };
}
