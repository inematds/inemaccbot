// Publicar o vídeo FINAL de um alvo: dar a ele o nome do título e devolver os
// links por onde a pessoa baixa.
//
// Por que existe: o artefato do bot é `state/artefatos/reel/9.mp4` — o número é
// o id do job, e não diz nada a quem recebe. O nome útil é o mesmo título que o
// estúdio usa (`A4-mulheres-v1`), porque é ele que amarra roteiro, avatar e reel
// numa coisa só.
//
// Por que COPIAR e não mover: `state/artefatos/` é a fonte canônica do bot — é o
// que `/status` conhece e o que uma retentativa reescreve. Mover deixaria o
// `resultado` do job apontando para um arquivo que saiu do lugar.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Só o que um nome de arquivo servido por HTTP aguenta sem escapar. O título
 * já vem restrito (`A4-mulheres-v1`), mas o alvo vem do `flow.json`, que é
 * editável por fora — sanear aqui evita que um público com barra no nome
 * escreva fora da pasta. */
function nomeSeguro(base: string): string {
  return base.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
}

export interface Publicacao {
  /** Caminho final na pasta servida. */
  arquivo: string;
  links: string[];
}

/**
 * Copia `origem` para `dir` com o nome `<titulo><ext>` e monta um link por base
 * de URL.
 *
 * Devolve `undefined` quando não há como publicar (sem pasta, sem URL, ou o
 * artefato não está lá). Silêncio NÃO é opção do chamador: quem chama avisa o
 * que faltou — um link ausente sem explicação é indistinguível de um vídeo que
 * não foi gerado.
 */
export function publicarVideo(
  origem: string, titulo: string, dir: string, bases: string[],
): Publicacao | undefined {
  if (!origem || !dir || !bases.length) return undefined;
  if (!existsSync(origem)) return undefined;

  const nome = `${nomeSeguro(titulo)}${extname(origem).toLowerCase() || '.mp4'}`;
  mkdirSync(dir, { recursive: true });
  const arquivo = join(dir, nome);
  copyFileSync(origem, arquivo);

  // `encodeURIComponent` no NOME, não na URL inteira: a base já vem pronta e
  // escapá-la quebraria o `://`.
  return { arquivo, links: bases.map((b) => `${b}/${encodeURIComponent(nome)}`) };
}
