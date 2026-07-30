// Monta a EXECUÇÃO de um job `kind=agent` a partir do registry de skills.
//
// É o que substitui o `promptDe` que lançava desde a etapa 1 ("sem agentes na
// etapa 1"). O handoff avisava: trocar isso tem que acontecer no MESMO commit
// que tornar `kind='agent'` alcançável, senão o primeiro job de agente queima
// uma tentativa e morre com mensagem sem sentido.
//
// Mora em `fila/` (e não em `dominio/`) porque devolve um `ContextoExecucao`,
// que é contrato da fila. A política — catálogo, prompt, perfil, contrato de
// saída — vem toda de `dominio/`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extrairAlvo, extrairArtefato } from '../dominio/artefato.js';
import { renderizarPrompt } from '../dominio/prompt.js';
import { resolverPerfil } from '../dominio/perfil.js';
import { acharSkill, type SkillDef } from '../dominio/registry.js';
import { esperarArtefato, jaFoiDisparado, limparMarcadores, type OpcoesEspera } from './render.js';
import type { ContextoExecucao } from './runner.js';
import type { Job, Perfil } from './types.js';

/** O que o gateway grava em `job.input` para uma skill. */
export interface EntradaSkill {
  /** O que o usuário pediu: link, assunto ou caminho. */
  entrada: string;
  /** Diretório de destino do artefato (`| livesN` resolvido), ou ausente. */
  destino?: string;
  /** Override pontual do perfil (`| modelo=opus`) — precedência 1 do §1.5. */
  perfil?: { motor?: string; modelo?: string; esforco?: string };
  /** Campos declarados pela skill (`| vertical`, `| curso skillsx`). */
  campos?: Record<string, string>;
}

export function parseEntradaSkill(input: string): EntradaSkill {
  let bruto: unknown;
  try {
    bruto = JSON.parse(input);
  } catch {
    throw new Error('input do job não é JSON — job criado fora do gateway?');
  }
  if (typeof bruto !== 'object' || bruto === null) throw new Error('input do job não é um objeto');
  const o = bruto as Record<string, unknown>;
  if (typeof o.entrada !== 'string' || o.entrada.trim() === '') {
    throw new Error('input do job sem "entrada"');
  }
  return {
    entrada: o.entrada,
    destino: typeof o.destino === 'string' ? o.destino : undefined,
    perfil: (typeof o.perfil === 'object' && o.perfil !== null ? o.perfil : undefined) as EntradaSkill['perfil'],
    campos: (typeof o.campos === 'object' && o.campos !== null ? o.campos : undefined) as EntradaSkill['campos'],
  };
}

export interface OpcoesSkills {
  defs: SkillDef[];
  /** Raiz do repo — os prompts do registry são relativos a ela. */
  raizRepo: string;
  /** Onde os artefatos de skill são gravados. */
  raizArtefatos: string;
  /** `cwd` dos processos de agente. Validado: tem que existir. */
  cwd: string;
  perfilPadrao: Perfil;
  log?: (m: string) => void;
  /**
   * Janelas da espera por artefato. A produção NÃO passa nada: valem os valores
   * reais (poll de 5s, estabilidade de 12s). Só o teste troca — senão cada teste
   * de render pagaria 12 segundos de relógio de parede, e a regra da §6.1 é
   * relógio injetável, nunca `sleep`.
   */
  espera?: Pick<OpcoesEspera, 'estavelMs' | 'intervaloMs' | 'agoraMs' | 'dormir'>;
}

/**
 * Teto do AGENTE numa skill que espera artefato. Ele só monta o material e
 * dispara o passo destacado — 20 minutos é folga larga para isso. O prazo do
 * render em si é o `timeout_segundos` do registry, e vale para a espera.
 */
const TIMEOUT_SETUP_SEGUNDOS = 20 * 60;

/**
 * Caminho do artefato: determinístico por JOB, não por tentativa. Uma
 * retentativa (mesmo `job.id`) reescreve o mesmo arquivo em vez de espalhar
 * `-1`, `-2` pelo disco — e é o que torna "procure antes de criar" (§2.5)
 * implementável para estas tarefas mais tarde, sem mudar o nome.
 */
export function caminhoArtefato(raiz: string, def: SkillDef, job: Job): string {
  return join(raiz, def.command, `${job.id}.${def.artefato_exts[0]}`);
}

function camposDeclarados(def: SkillDef, doJob: Record<string, string> | undefined): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const [nome, c] of Object.entries(def.campos)) {
    // Campo de ENTREGA (ex.: `mover`) é decisão do gateway depois do job — dar
    // isso ao agente seria pedir a ele que movesse arquivo.
    if (c.usa === 'entrega') continue;
    saida[nome] = doJob?.[nome] ?? c.padrao;
  }
  return saida;
}

export function criarPromptDe(opts: OpcoesSkills): (job: Job) => Promise<ContextoExecucao> {
  if (!existsSync(opts.cwd)) {
    throw new Error(`skills: cwd de agente não existe: ${opts.cwd}`);
  }

  return async (job: Job): Promise<ContextoExecucao> => {
    // Catálogo FECHADO (§9): um `tarefa` fora do registry falha aqui, antes de
    // qualquer processo nascer. É a mesma barreira que impede texto do usuário
    // de virar nome de comando.
    const def = acharSkill(opts.defs, job.tarefa);
    if (!def) {
      throw new Error(`tarefa "${job.tarefa}" não está no registry de skills`);
    }
    if (def.kind !== 'agent') {
      throw new Error(`tarefa "${job.tarefa}" é kind=${def.kind}, não deveria rodar como agente`);
    }

    const entrada = parseEntradaSkill(job.input);
    const saida = caminhoArtefato(opts.raizArtefatos, def, job);
    mkdirSync(join(opts.raizArtefatos, def.command), { recursive: true });

    // Vamos DISPARAR trabalho novo (não há nada em curso): apaga os marcadores
    // da tentativa anterior agora, e não na hora de vigiar — ver
    // `limparMarcadores`.
    const emCurso = def.aguarda_artefato && jaFoiDisparado(saida);
    if (def.aguarda_artefato && !emCurso) limparMarcadores(saida);

    // Lido A CADA job de propósito: editar um prompt passa a valer para o
    // próximo job sem reiniciar o serviço. Skill não tem estado — "rodar de novo
    // do zero" é aceitável por definição (§1.1). Fluxo é o oposto: lá a
    // definição é congelada na criação (§3.4).
    let template: string;
    try {
      template = readFileSync(join(opts.raizRepo, def.prompt), 'utf8');
    } catch {
      throw new Error(`prompt da skill "${def.command}" não pôde ser lido: ${def.prompt}`);
    }

    // Perfil GRAVADO no job manda: ele foi resolvido no enfileiramento e é o
    // que o `/status` e o log mostram. Resolver de novo aqui poderia divergir
    // do que foi prometido ao usuário — bastaria alguém editar o registry entre
    // o enfileiramento e a execução. Job sem perfil (enfileirado por outro
    // caminho) cai na resolução normal.
    const perfil = job.motor && job.modelo && job.esforco
      ? { motor: job.motor, modelo: job.modelo, esforco: job.esforco }
      : resolverPerfil({
        override: entrada.perfil,
        registry: def.perfil,
        padrao: opts.perfilPadrao,
      }).perfil;

    return {
      // Os campos DECLARADOS entram sempre, com o default quando o comando os
      // omitiu — quem monta isso é a gramática. Um campo que o job carrega mas
      // a skill não declara mais (registry editado depois do enfileiramento) é
      // descartado aqui, senão `renderizarPrompt` derrubaria o job por uma
      // variável que o template não usa.
      prompt: renderizarPrompt(template, {
        input: entrada.entrada,
        saida,
        ...camposDeclarados(def, entrada.campos),
      }),
      cwd: opts.cwd,
      perfil,
      vars: {},
      // A skill que espera artefato dá ao AGENTE um prazo curto (ele só faz o
      // setup e dispara), e à ESPERA o prazo longo. Um só teto para os dois
      // faria o agente poder gastar as duas horas do render antes de disparar
      // qualquer coisa.
      timeoutMs: def.aguarda_artefato
        ? Math.min(def.timeout_segundos, TIMEOUT_SETUP_SEGUNDOS) * 1_000
        : def.timeout_segundos * 1_000,
      ...(def.aguarda_artefato
        ? {
          interpretarSaida: (bruto: string) => extrairAlvo(bruto, def.artefato_exts),
          aguardarArtefato: (alvo: string, sinal: AbortSignal) =>
            esperarArtefato(alvo, {
              timeoutMs: def.timeout_segundos * 1_000,
              sinal,
              log: opts.log,
              ...opts.espera,
            }),
          // Adoção (§2.5 "procure antes de criar"): o `.log` ao lado do alvo
          // prova que uma tentativa anterior já disparou o trabalho.
          ...(emCurso ? { alvoEmCurso: saida } : {}),
        }
        : {
          interpretarSaida: (bruto: string) => extrairArtefato(bruto, def.artefato_exts),
        }),
    };
  };
}
