// Anexo recebido no chat → arquivo local.
//
// Portado do `media.ts` do v1 (§5.1 "porta igual"), com o downloader como
// função injetada — nenhum teste deste bot toca a API do Telegram.
//
// Fecha também uma pendência anotada no handoff: `thumb <caminho>` só aceita
// caminho dentro de `state/midia` e nada na etapa 1 escrevia lá, então o comando
// era inalcançável na prática. É aqui que passa a existir arquivo naquele
// diretório.
import { createWriteStream, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Baixa o arquivo `fileId` e devolve o caminho local. Injetado. */
export type BaixarAnexo = (fileId: string, nomeOriginal: string) => Promise<string>;

/**
 * Nome seguro para gravar em disco. Restrições que vieram de defeito real no
 * v1: o caminho vira parte do `input` de um job e é re-splitado por espaço em
 * argv, então nada de espaço; e nada de token começando com `--`, que viraria
 * flag. `basename` primeiro mata `../../etc/passwd`.
 */
export function nomeAnexo(original: string): string {
  const base = basename(String(original ?? '').trim()) || 'arquivo';
  const extBruta = extname(base);
  const ext = extBruta.toLowerCase().replace(/[^a-z0-9.]/g, '');
  const cauleBruto = extBruta ? base.slice(0, base.length - extBruta.length) : base;
  const caule = cauleBruto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${caule || 'arquivo'}${ext}`;
}

/** Nome final no diretório de mídia: carimbo + nome seguro (sem colisão). */
export function caminhoAnexo(raizMidia: string, original: string, agora: number): string {
  return join(raizMidia, `${agora}-${nomeAnexo(original)}`);
}

/**
 * Junta a legenda do anexo com o caminho local, produzindo o texto de comando.
 *
 *   "transcrever:"            + /a/b.mp4 → "transcrever: /a/b.mp4"
 *   "transcrever"             + /a/b.mp4 → "transcrever: /a/b.mp4"
 *   "dublar: | lives3"        + /a/b.mp4 → "dublar: /a/b.mp4 | lives3"
 *   ""                        + /a/b.mp4 → "" (quem chama só confirma o recebimento)
 *
 * O caminho entra como ENTRADA da skill, nunca colado no fim da linha: colado
 * no fim ele cairia dentro do último campo (`| lives3 /a/b.mp4`) e o parser
 * recusaria com "campo desconhecido" — defeito que o v1 tinha e que só aparece
 * quando alguém usa legenda com campo.
 */
export function comandoDeAnexo(legenda: string, caminho: string): string {
  const texto = (legenda ?? '').trim();
  if (!texto) return '';

  const [primeiro, ...campos] = texto.split('|').map((s) => s.trim());
  const cabeca = primeiro ?? '';
  const i = cabeca.indexOf(':');
  const verbo = (i >= 0 ? cabeca.slice(0, i) : cabeca).trim();
  const jaTemEntrada = i >= 0 && cabeca.slice(i + 1).trim() !== '';

  // Legenda com entrada própria ("transcrever: http://x") manda mais que o
  // anexo: quem escreveu foi explícito.
  const entrada = jaTemEntrada ? cabeca.slice(i + 1).trim() : caminho;
  // ...com UMA exceção, e ela é estreita de propósito: `capa` precisa das duas
  // coisas ao mesmo tempo — a legenda diz ONDE a imagem vai (`capa: A#22
  // jovens`) e o anexo É a imagem. Para os outros verbos o caminho continua
  // sendo descartado: anexar um campo que eles não conhecem faria o parser
  // recusar com "campo desconhecido" (o `transcrever:` quebraria).
  const extra = jaTemEntrada && verbo.toLowerCase() === 'capa'
    ? [`arquivo=${caminho}`] : [];
  return [`${verbo}: ${entrada}`, ...campos, ...extra].join(' | ');
}

/** Teto do anexo. A API do Telegram já não deixa um bot baixar acima de 20 MB;
 * dizer isso é melhor que estourar com um erro cru da API. */
export const LIMITE_ANEXO_BYTES = 20 * 1024 * 1024;

/**
 * Downloader real. NUNCA loga nem propaga a URL: ela carrega o token no path
 * (`/bot<token>/…`), e o erro dela vai para o chat (§9).
 */
export function criarBaixadorTelegram(botToken: string, raizMidia: string, agora: () => number): BaixarAnexo {
  return async (fileId, nomeOriginal) => {
    mkdirSync(raizMidia, { recursive: true });

    const info = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    if (!info.ok) throw new Error(`a API do Telegram recusou o arquivo (HTTP ${info.status})`);
    const corpo = (await info.json()) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    if (!corpo.ok || !corpo.result?.file_path) throw new Error('não consegui localizar o arquivo no Telegram');
    if ((corpo.result.file_size ?? 0) > LIMITE_ANEXO_BYTES) {
      throw new Error('arquivo grande demais para o bot baixar (limite de 20 MB da API) — mande o caminho no disco');
    }

    const resp = await fetch(`https://api.telegram.org/file/bot${botToken}/${corpo.result.file_path}`);
    if (!resp.ok || !resp.body) throw new Error(`falha ao baixar o arquivo (HTTP ${resp.status})`);

    const destino = caminhoAnexo(raizMidia, nomeOriginal, agora());
    await pipeline(Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destino));
    return destino;
  };
}
