// Quanto disco cada área está ocupando.
//
// Existe porque a limpeza precisava virar decisão informada, e não chute. A
// medição de 2026-08-01 mostrou o que ninguém esperava:
//
//   área do BOT (state/artefatos)   1,1 GB   ← ele é dono, sabe o que é lixo
//   área das SKILLS (~/projetos/output)  159 GB   ← de vários projetos
//
// Dentro dos 159 GB, uma pasta que não tem nada a ver com este bot (`criancas`)
// sozinha tinha 105 GB. Ou seja: a área do bot é 0,7% do problema, e o peso
// está onde ele NÃO é dono. Por isso as duas áreas são medidas separadas, e por
// isso a limpeza automática só pode nascer na primeira.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Pasta {
  nome: string;
  bytes: number;
  arquivos: number;
}

/** Soma recursiva, tolerante: pasta ilegível ou que sumiu no meio da varredura
 * conta zero em vez de derrubar o comando. Medir não pode falhar. */
export function tamanhoDe(caminho: string): { bytes: number; arquivos: number } {
  let bytes = 0;
  let arquivos = 0;
  let entradas: string[];
  try {
    entradas = readdirSync(caminho);
  } catch {
    return { bytes: 0, arquivos: 0 };
  }
  for (const e of entradas) {
    const alvo = join(caminho, e);
    let st;
    try { st = statSync(alvo); } catch { continue; }
    if (st.isDirectory()) {
      const sub = tamanhoDe(alvo);
      bytes += sub.bytes;
      arquivos += sub.arquivos;
    } else {
      bytes += st.size;
      arquivos += 1;
    }
  }
  return { bytes, arquivos };
}

/** As subpastas de `raiz`, da maior para a menor. */
export function medirSubpastas(raiz: string, teto = 8): Pasta[] {
  let entradas: string[];
  try {
    entradas = readdirSync(raiz);
  } catch {
    return [];
  }
  const pastas: Pasta[] = [];
  for (const e of entradas) {
    const alvo = join(raiz, e);
    try {
      if (!statSync(alvo).isDirectory()) continue;
    } catch { continue; }
    const { bytes, arquivos } = tamanhoDe(alvo);
    pastas.push({ nome: e, bytes, arquivos });
  }
  return pastas.sort((a, b) => b.bytes - a.bytes).slice(0, teto);
}

export function humano(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
