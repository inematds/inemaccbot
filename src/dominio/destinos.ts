// Registry de DESTINOS — para onde um artefato pode ser entregue.
//
// Portado do `dests.ts` do v1 (23L, "porta igual" na tabela de migração §5.1).
// A regra do §3.2 vale desde já: o domínio referencia canal por NOME
// (`lives21`), nunca por caminho; quem sabe onde isso fica no disco é o bot, e
// num lugar só — evitando N cópias divergentes da lista de canais.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = /^lives(\d+)$/;

/** `lives3` → `<projetosDir>/yt-pub-lives3/imports/videos`, ou null se a pasta
 * do projeto não existir. Descoberta pelo disco de propósito: criar um canal
 * novo não deve exigir editar (nem recompilar) o bot. */
export function resolverDestino(token: string, projetosDir: string): string | null {
  const m = token.trim().toLowerCase().match(TOKEN);
  if (!m) return null;
  const raiz = join(projetosDir, `yt-pub-lives${m[1]}`);
  if (!existsSync(raiz) || !statSync(raiz).isDirectory()) return null;
  return join(raiz, 'imports', 'videos');
}

/** Onde um produtor entrega na fila do yt-pub-x3. Ligar ou não as redes é decisão do painel do x3. */
export interface EntradaX3 {
  pasta: string;
}

/** `lives3` → `<projetosDir>/yt-pub-x3/entrada/lives3`, se o canal existe no x3.
 * A publicação de imports dos `yt-pub-livesN` foi pausada em 18/11/2026: entregar
 * só em `imports/videos` deixaria o reel parado sem nenhum erro. */
export function resolverEntradaX3(token: string, projetosDir: string): EntradaX3 | null {
  const canal = token.trim().toLowerCase();
  if (!TOKEN.test(canal)) return null;
  const raiz = join(projetosDir, 'yt-pub-x3');
  if (!existsSync(join(raiz, 'canais', `${canal}.yaml`))) return null;
  return { pasta: join(raiz, 'entrada', canal) };
}

/** Tokens válidos, em ordem numérica. Alimenta as mensagens de erro e a ajuda —
 * "destino não existe" sem dizer quais existem é atrito puro. */
export function listarDestinos(projetosDir: string): string[] {
  let entradas: string[] = [];
  try {
    entradas = readdirSync(projetosDir);
  } catch {
    return [];
  }
  return entradas
    .map((e) => e.match(/^yt-pub-lives(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((n) => `lives${n}`);
}

export function ehTokenDestino(token: string): boolean {
  return TOKEN.test(token.trim().toLowerCase());
}
