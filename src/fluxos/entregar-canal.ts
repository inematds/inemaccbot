// Levar ao canal o PACOTE que o domínio montou — vídeo, título, descrição e
// capa juntos, para o destino não ter que refazer nada disso.
//
// Divisão de trabalho, a mesma de sempre: o domínio monta a pasta e diz onde
// ela está (linha `publicacao: <caminho>` no recibo); o bot é o único que sabe
// que `lives10` mora em `~/projetos/yt-pub-lives10` (§3.2).
//
// Por que uma pasta por entrega, e não o arquivo solto em `imports/videos`:
// aquela pasta é UM LOTE compartilhado e o import worker a apaga depois de
// processar. Um pacote com manifest precisa do seu próprio lote — `imports/
// <slug>/`, IRMÃO de `videos`, nunca dentro dele. O caminho do reel continua
// como está: arquivo solto, nome = título.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** `lives10` → `<projetosDir>/yt-pub-lives10/imports`, ou null se o projeto do
 * canal não existir no disco. Irmão do `resolverDestino` de `destinos.ts`, que
 * aponta para o lote `imports/videos` do reel. */
export function resolverImports(token: string, projetosDir: string): string | null {
  const m = token.trim().toLowerCase().match(/^lives(\d+)$/);
  if (!m) return null;
  const raiz = join(projetosDir, `yt-pub-lives${m[1]}`);
  if (!existsSync(raiz) || !statSync(raiz).isDirectory()) return null;
  return join(raiz, 'imports');
}

/** O caminho declarado em `publicacao: <caminho>` dentro do recibo. Mesma
 * gramática `campo: valor` que o `{{anterior:campo}}` já lê — nada de inventar
 * um segundo canal de comunicação entre domínio e bot. */
export function pacoteNoRecibo(recibo: string): string | null {
  let texto: string;
  try {
    texto = readFileSync(recibo, 'utf8');
  } catch {
    return null;
  }
  const achado = /^\s*publicacao\s*:\s*(.+)$/im.exec(texto);
  const caminho = achado?.[1]?.trim();
  if (!caminho || !caminho.startsWith('/')) return null;
  return existsSync(caminho) && statSync(caminho).isDirectory() ? caminho : null;
}

export interface EntregaCanal {
  destino: string;
  lote: string;
}

/**
 * Copia o pacote para `imports/<lote>/`, com nome de lote vindo da pasta do
 * slug (`publicacao/` é o nome de dentro; o slug é o pai).
 *
 * COPIA, não move: a pasta do slug segue canônica, e uma retentativa tem que
 * achar o pacote onde ele estava. Monta em `.<lote>.tmp` e renomeia no fim — o
 * worker varre de hora em hora e leria pasta pela metade.
 */
export function entregarPacote(
  pacote: string, canal: string, projetosDir: string,
): EntregaCanal | null {
  const imports = resolverImports(canal, projetosDir);
  if (!imports) return null;
  const lote = basename(dirname(pacote)) || basename(pacote);
  const destino = join(imports, lote);
  const tmp = join(imports, `.${lote}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(imports, { recursive: true });
  cpSync(pacote, tmp, { recursive: true });
  rmSync(destino, { recursive: true, force: true });
  renameSync(tmp, destino);
  return { destino, lote };
}
