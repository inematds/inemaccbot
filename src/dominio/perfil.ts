// Perfil de execução = { motor, modelo, esforco }.
//
// No v1 isso era hardcoded em DOIS lugares (`mkivideos/src/cli-lib.ts:171` com
// `--model sonnet --effort low` para toda skill de render, e
// `inemaccvbot/src/interpret.ts` com opus/low), então tarefas de dificuldade
// muito diferente compartilhavam perfil por acidente e mudar exigia recompilar.
//
// Aqui é CONFIGURAÇÃO, resolvida por precedência, e o perfil efetivo é gravado
// no job — quando um render sai ruim, o log diz com que modelo rodou.
// Documentação de uso e de portabilidade: docs/perfil-de-execucao.md
import type { Perfil } from '../fila/types.js';

/** Ranking de capacidade. Usado só para comparar (piso de `exige`), nunca para escolher sozinho. */
export const MODELOS_RANK: Record<string, number> = {
  haiku: 1,
  fable: 2,
  sonnet: 3,
  opus: 4,
};

export const ESFORCOS_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export interface PerfilParcial {
  motor?: string;
  modelo?: string;
  esforco?: string;
}

/**
 * O que a própria skill declara sobre o que precisa (lido do SKILL.md / do
 * registry da skill):
 * - `sugere`: preferência fraca — perde de registry, fase e override
 * - `exige`: PISO — eleva o resultado se ele vier mais fraco; só um override
 *   explícito do operador consegue furar, e isso gera aviso
 */
export interface DeclaracaoSkill {
  sugere?: PerfilParcial;
  exige?: PerfilParcial;
}

export interface FontesPerfil {
  /** 1 — override pontual no comando: `| modelo=opus` */
  override?: PerfilParcial;
  /** 2 — fase do flow.json */
  fase?: PerfilParcial;
  /** 3 — entrada do registry (skills.json / fluxos.json) */
  registry?: PerfilParcial;
  /** 4 — o que a skill declara */
  skill?: DeclaracaoSkill;
  /** 5 — default do .env */
  padrao: Perfil;
}

export interface ResolucaoPerfil {
  perfil: Perfil;
  avisos: string[];
}

function primeiro(campo: keyof PerfilParcial, fontes: (PerfilParcial | undefined)[]): string | undefined {
  for (const f of fontes) {
    const v = f?.[campo];
    if (v !== undefined) return v;
  }
  return undefined;
}

function validar(p: Perfil): void {
  if (MODELOS_RANK[p.modelo] === undefined) {
    throw new Error(`modelo desconhecido: ${p.modelo} (conhecidos: ${Object.keys(MODELOS_RANK).join(', ')})`);
  }
  if (ESFORCOS_RANK[p.esforco] === undefined) {
    throw new Error(`esforço desconhecido: ${p.esforco} (conhecidos: ${Object.keys(ESFORCOS_RANK).join(', ')})`);
  }
}

export function resolverPerfil(f: FontesPerfil): ResolucaoPerfil {
  const ordem = [f.override, f.fase, f.registry, f.skill?.sugere];
  const perfil: Perfil = {
    motor: primeiro('motor', ordem) ?? f.padrao.motor,
    modelo: primeiro('modelo', ordem) ?? f.padrao.modelo,
    esforco: primeiro('esforco', ordem) ?? f.padrao.esforco,
  };
  validar(perfil);

  const avisos: string[] = [];
  const exige = f.skill?.exige;
  if (exige) {
    if (exige.motor && perfil.motor !== exige.motor) {
      if (f.override?.motor === perfil.motor) {
        avisos.push(`override usa motor ${perfil.motor}, mas a skill exige ${exige.motor}`);
      } else {
        perfil.motor = exige.motor;
        avisos.push(`skill exige motor ${exige.motor} — aplicado`);
      }
    }
    for (const [campo, rank] of [['modelo', MODELOS_RANK], ['esforco', ESFORCOS_RANK]] as const) {
      const pedido = exige[campo];
      if (!pedido) continue;
      if (rank[pedido] === undefined) throw new Error(`skill exige ${campo} desconhecido: ${pedido}`);
      if (rank[perfil[campo]] >= rank[pedido]) continue;
      if (f.override?.[campo] === perfil[campo]) {
        avisos.push(`override usa ${campo} ${perfil[campo]}, abaixo do exigido pela skill (${pedido})`);
      } else {
        perfil[campo] = pedido;
        avisos.push(`skill exige ${campo} ${pedido} — elevado`);
      }
    }
    validar(perfil);
  }
  return { perfil, avisos };
}
