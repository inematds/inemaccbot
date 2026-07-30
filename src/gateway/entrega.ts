// Entrega do artefato de um job concluído.
//
// Quem entrega é o GATEWAY, não a fila: `fila/` não pode conhecer Telegram nem
// destinos (§4). O worker termina o job com o CAMINHO do artefato em
// `resultado`; daqui em diante é decisão de apresentação.
//
// Três casos, nesta ordem:
//   1. destino pedido (`| lives3`)  → copia para lá e responde o caminho final;
//   2. texto curto (.txt/.srt)      → manda o CONTEÚDO no chat (é o que se quer
//                                     de uma transcrição — o caminho no disco
//                                     não serve de nada no celular);
//   3. resto                        → manda o arquivo como documento se couber
//                                     no limite do Telegram; senão, o caminho.
//
// Portado do `deliver.ts`/`media.ts` do v1 no que importa: sanitização de nome e
// garantia de que a cópia NUNCA escreve fora do diretório de destino.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';

/** Acima disso, uma transcrição vira parede de texto no chat — vai como arquivo. */
export const LIMITE_TEXTO_BYTES = 100_000;
/** Teto do `sendDocument` da API do Telegram é 50 MB; ficamos abaixo. */
export const LIMITE_DOCUMENTO_BYTES = 45 * 1024 * 1024;

const EXTS_TEXTO = new Set(['.txt', '.srt', '.md', '.vtt']);

/** Nome público seguro: sem diretório embutido, sem espaço, sem unicode
 * problemático. `basename` primeiro mata qualquer `../../etc/passwd`. */
export function nomeSeguro(nome: string): string {
  const base = basename(String(nome ?? '').trim()) || 'arquivo';
  const ext = extname(base);
  const raiz = ext ? base.slice(0, -ext.length) : base;
  const limpo = raiz
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    // Ponto na borda sai junto com o hífen: sem isso `...` sobrevive inteiro
    // (`.` vira extensão, `..` vira raiz) e o nome final é `...` — que é
    // exatamente a forma que a sanitização existe para não deixar passar.
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 150);
  const extLimpa = ext.replace(/[^a-zA-Z0-9.]+/g, '').replace(/^\.+$/, '').slice(0, 20);
  return (limpo || 'arquivo') + extLimpa;
}

/**
 * Copia `origem` para dentro de `destinoDir`, sem colisão. Nunca escreve fora
 * de `destinoDir` — a checagem é ciente do separador, porque `startsWith` puro
 * deixaria `/data/midia-secreta` passar contra a raiz `/data/midia` (o mesmo
 * defeito já corrigido no `ffmpeg.thumb` na etapa 1).
 */
export function copiarParaDestino(origem: string, destinoDir: string): string {
  const raiz = resolve(destinoDir);
  mkdirSync(raiz, { recursive: true });

  const nome = nomeSeguro(basename(origem));
  const ext = extname(nome);
  const caule = ext ? nome.slice(0, -ext.length) : nome;

  for (let n = 0; ; n += 1) {
    const candidato = n === 0 ? nome : `${caule}-${n}${ext}`;
    const alvo = resolve(raiz, candidato);
    if (alvo !== raiz && !alvo.startsWith(raiz + sep)) {
      throw new Error('nome de arquivo inválido: escaparia do diretório de destino');
    }
    if (!existsSync(alvo)) {
      copyFileSync(origem, alvo);
      return alvo;
    }
    // Mesmo tamanho: é o arquivo que já entregamos antes (retentativa do mesmo
    // job). Adota em vez de multiplicar cópias — a mesma regra de "procure
    // antes de criar" do §2.5, na escala desta operação.
    if (statSync(alvo).size === statSync(origem).size) return alvo;
  }
}

export interface Entrega {
  /** Texto a mandar no chat. */
  mensagem: string;
  /** Caminho de um arquivo a anexar, se for o caso. */
  anexo?: string;
}

/**
 * Decide (sem enviar nada) o que fazer com o artefato. Separado do envio para
 * ser testável sem Telegram — nenhum teste deste bot toca a API real.
 */
export function planejarEntrega(caminho: string, destinoDir?: string): Entrega {
  if (!caminho) return { mensagem: 'o job terminou sem artefato.' };
  if (!existsSync(caminho)) {
    // Acontece de verdade: o agente declarou `RESULT:` e o arquivo sumiu (ou
    // nunca existiu). Dizer isso é melhor que mandar um caminho quebrado.
    return { mensagem: `o job terminou, mas o arquivo não está lá: ${caminho}` };
  }

  const tamanho = statSync(caminho).size;
  if (destinoDir) {
    const final = copiarParaDestino(caminho, destinoDir);
    return { mensagem: `pronto: ${final}` };
  }

  const ext = extname(caminho).toLowerCase();
  if (EXTS_TEXTO.has(ext) && tamanho <= LIMITE_TEXTO_BYTES) {
    const conteudo = readFileSync(caminho, 'utf8').trim();
    return { mensagem: conteudo || `(arquivo vazio) ${caminho}` };
  }

  if (tamanho <= LIMITE_DOCUMENTO_BYTES) {
    return { mensagem: `pronto: ${basename(caminho)}`, anexo: caminho };
  }

  const mb = Math.round(tamanho / (1024 * 1024));
  return { mensagem: `pronto (${mb} MB, grande demais pro Telegram): ${caminho}` };
}
