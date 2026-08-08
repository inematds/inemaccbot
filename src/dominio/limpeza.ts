// O que apagar, e por quê. PLANEJA — não apaga.
//
// Separado da execução pelo mesmo motivo do `planejarEntrega`: um comando que
// remove 1 GB precisa poder ser mostrado antes de acontecer, e mostrado é
// exatamente a mesma coisa que vai ser feita — não uma segunda implementação
// que pode divergir.
//
// A divisão de escopos veio do uso, não do desenho: limpar POR FLUXO (`A#8`) é
// o recorte que casa com como o trabalho é feito, e ele não é o mesmo que
// limpar por ÁREA. A medição de 2026-08-01 mostrou o porquê — dos 1,1 GB de
// artefatos, 1,02 GB eram dos fluxos e 65 MB vieram do chat direto. Um escopo
// que juntasse os dois apagaria trabalho que ninguém pediu para apagar.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Item {
  caminho: string;
  bytes: number;
  motivo: string;
}

export interface FluxoResumo {
  id: number;
  prefixo: string;
  tipo: string;
}

export interface JobResumo {
  flow_ref: string | null;
  resultado: string | null;
  status: string;
}

export interface PedidoLimpeza {
  /** `A#8` · `promoavatar` · `artefatos` · `tudo` */
  escopo: string;
  dias?: number;
  jobs: JobResumo[];
  fluxos: FluxoResumo[];
  raizArtefatos: string;
  publicoDir: string;
  agoraMs: number;
}

const DIAS_PADRAO = 14;

function bytesDe(caminho: string): number {
  try {
    const st = statSync(caminho);
    if (!st.isDirectory()) return st.size;
  } catch {
    return -1; // não existe
  }
  let total = 0;
  for (const e of arquivosDe(caminho)) total += e.bytes;
  return total;
}

/** Arquivos (não diretórios) sob `raiz`, com tamanho e mtime. Tolerante: o que
 * não pode ser lido simplesmente não entra na lista. */
export function arquivosDe(raiz: string): { caminho: string; bytes: number; mtimeMs: number }[] {
  const saida: { caminho: string; bytes: number; mtimeMs: number }[] = [];
  let entradas: string[];
  try {
    entradas = readdirSync(raiz);
  } catch {
    return saida;
  }
  for (const e of entradas) {
    const alvo = join(raiz, e);
    let st;
    try { st = statSync(alvo); } catch { continue; }
    if (st.isDirectory()) saida.push(...arquivosDe(alvo));
    else saida.push({ caminho: alvo, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return saida;
}

/** `A#8` → `{prefixo:'A', id:8}`; qualquer outra coisa → undefined. */
function refDe(escopo: string): { prefixo: string; id: number } | undefined {
  const m = escopo.trim().match(/^([A-Za-z]{1,3})#?(\d+)$/);
  if (!m) return undefined;
  return { prefixo: m[1]!.toUpperCase(), id: Number(m[2]) };
}

function deUmFluxo(p: PedidoLimpeza, fluxo: FluxoResumo): Item[] {
  const itens: Item[] = [];
  const ref = `${fluxo.prefixo}#${fluxo.id}`;
  const rotulo = `${ref} (${fluxo.tipo})`;

  // 1. Artefato de cada job daquele fluxo — o caminho vem do BANCO, não de um
  //    palpite sobre o nome do arquivo. É o que torna o recorte exato.
  for (const j of p.jobs) {
    if (!j.flow_ref?.startsWith(`${ref}/`)) continue;
    if (!j.resultado) continue;
    const bytes = bytesDe(j.resultado);
    if (bytes < 0) continue;
    itens.push({ caminho: j.resultado, bytes, motivo: `artefato de ${rotulo}` });
  }

  // 2. A pasta de avatares baixados daquele fluxo.
  const pasta = join(p.raizArtefatos, 'fluxos', `${fluxo.prefixo}${fluxo.id}`);
  const bytesPasta = bytesDe(pasta);
  if (bytesPasta >= 0) itens.push({ caminho: pasta, bytes: bytesPasta, motivo: `avatares de ${rotulo}` });

  // 3. Os vídeos publicados daquele fluxo — pela subpasta do TIPO.
  const publicados = join(p.publicoDir, fluxo.tipo);
  for (const a of arquivosDe(publicados)) {
    if (!a.caminho.includes(`/${fluxo.prefixo}${fluxo.id}-`)) continue;
    itens.push({ caminho: a.caminho, bytes: a.bytes, motivo: `publicado de ${rotulo}` });
  }
  return itens;
}

/**
 * Monta a lista do que sairia. Nunca apaga, nunca decide sozinho: quem chama
 * mostra e pede confirmação.
 */
export function planejarLimpeza(p: PedidoLimpeza): { itens: Item[]; erro?: string } {
  const escopo = p.escopo.trim().toLowerCase();

  const ref = refDe(p.escopo);
  if (ref) {
    const fluxo = p.fluxos.find((f) => f.id === ref.id && f.prefixo === ref.prefixo);
    if (!fluxo) return { itens: [], erro: `${p.escopo} não existe neste bot.` };
    return { itens: deUmFluxo(p, fluxo) };
  }

  const doTipo = p.fluxos.filter((f) => f.tipo === escopo);
  if (doTipo.length) return { itens: doTipo.flatMap((f) => deUmFluxo(p, f)) };

  if (escopo === 'artefatos' || escopo === 'tudo') {
    const dias = escopo === 'tudo' ? 0 : (p.dias ?? DIAS_PADRAO);
    const corte = p.agoraMs - dias * 24 * 60 * 60 * 1000;
    const itens: Item[] = arquivosDe(p.raizArtefatos)
      .filter((a) => a.mtimeMs <= corte)
      .map((a) => ({
        caminho: a.caminho,
        bytes: a.bytes,
        motivo: dias ? `artefato com mais de ${dias} dia(s)` : 'artefato',
      }));
    if (escopo === 'tudo') {
      for (const f of new Set(p.fluxos.map((x) => x.tipo))) {
        for (const a of arquivosDe(join(p.publicoDir, f))) {
          itens.push({ caminho: a.caminho, bytes: a.bytes, motivo: `publicado de ${f}` });
        }
      }
    }
    return { itens };
  }

  const tipos = [...new Set(p.fluxos.map((f) => f.tipo))];
  return {
    itens: [],
    erro: `não sei limpar "${p.escopo}". Use: A#8 · ${tipos.join(' · ') || '<fluxo>'} · artefatos [dias] · tudo`,
  };
}
