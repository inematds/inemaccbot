import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Níveis de modelo do ecossistema INEMA — fonte única em ~/.config/inema/modelos.env
 * (doc: ~/projetos/wifi/MODELOS.md). Ordem: variável de ambiente → arquivo central.
 *
 * Nível neutro (`super|topo|executor|menor`) vira o ID de cada motor:
 * `INEMA_<MOTOR>_<NIVEL>` (modelo) e `INEMA_<MOTOR>_<NIVEL>_EFFORT` (esforço).
 * SUPER vazio herda TOPO.
 */
const ARQUIVO_CENTRAL = join(homedir(), '.config', 'inema', 'modelos.env');

function lerCentral(chave: string): string | undefined {
  if (process.env[chave]) return process.env[chave];
  try {
    const m = readFileSync(ARQUIVO_CENTRAL, 'utf-8').match(new RegExp(`^${chave}=(.*)$`, 'm'));
    return m?.[1].trim() || undefined;
  } catch {
    return undefined;
  }
}

export const NIVEIS = ['super', 'topo', 'executor', 'menor'] as const;
export type Nivel = (typeof NIVEIS)[number];

export function ehNivel(s: unknown): s is Nivel {
  return typeof s === 'string' && (NIVEIS as readonly string[]).includes(s);
}

export function nivel(motor: 'claude' | 'codex', n: Nivel): { modelo?: string; esforco?: string } {
  const ler = (x: string) => ({
    modelo: lerCentral(`INEMA_${motor.toUpperCase()}_${x}`),
    esforco: lerCentral(`INEMA_${motor.toUpperCase()}_${x}_EFFORT`),
  });
  const r = ler(n.toUpperCase());
  return !r.modelo && n === 'super' ? ler('TOPO') : r;
}
