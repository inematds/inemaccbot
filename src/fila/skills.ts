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
import {
  encerrarTrabalhoDestacado, esperarArtefato, limparMarcadores, trabalhoEmCurso,
  type OpcoesEspera,
} from './render.js';
import type { ContextoExecucao } from './runner.js';
import type { Job, Perfil } from './types.js';

/**
 * Nome da tarefa de fase de fluxo com agente. Uma fase não é uma skill do
 * catálogo: o prompt dela vem CONGELADO no próprio job (§3.4), e não de um
 * arquivo lido na hora.
 */
export const TAREFA_FLUXO_AGENTE = 'fluxo-agente';

/**
 * Fase de fluxo que dirige o NAVEGADOR. Igual à de agente, com uma diferença
 * que não é opcional: o motor é `chrome` (`claude --chrome`), senão a extensão
 * não é reconhecida e a fase falha sem tocar no estúdio.
 *
 * O motor vem daqui e não do perfil padrão de propósito: uma fase de navegador
 * rodando sem `--chrome` é um erro de fiação silencioso — ela "roda" e não faz
 * nada. Amarrar os dois no mesmo lugar tira essa possibilidade.
 */
export const TAREFA_FLUXO_NAVEGADOR = 'fluxo-navegador';

/** O que o RUNTIME de fluxos grava no `input` de um job de fase. */
export interface EntradaFase {
  entrada: string;
  /** Texto do prompt, congelado na criação do fluxo. */
  prompt_texto: string;
  /** Título do artefato no serviço externo (o vídeo no estúdio). */
  titulo?: string;
  fluxo: { ref: string; fase: string; alvo: string } & Record<string, string>;
}

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
 * Teto do AGENTE numa skill que espera artefato, quando o registry não diz
 * outro. Serve para quem só monta material e dispara (`explicativo`, `curso`,
 * `demo`); as skills de reel declaram o próprio, porque nelas o agente roda o
 * pipeline criativo inteiro inline.
 */
const TIMEOUT_SETUP_PADRAO_SEGUNDOS = 20 * 60;

/** Teto de uma fase de fluxo com agente. Generoso: uma fase de texto do
 * promoclub gera 12 peças numa sessão só. */
const TIMEOUT_FASE_SEGUNDOS = 60 * 60;

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

/** Variáveis que uma fase recebe: a entrada do fluxo, o alvo e o que o
 * `flow.json` declarou nele (canal, gatilho…), mais o caminho de saída. */
function contextoDeFase(job: Job, opts: OpcoesSkills, motorForcado?: string): ContextoExecucao {
  let e: EntradaFase;
  try {
    e = JSON.parse(job.input) as EntradaFase;
  } catch {
    throw new Error('input da fase não é JSON');
  }
  if (!e.prompt_texto) throw new Error('fase sem prompt congelado — fluxo criado por versão antiga?');

  const saida = join(opts.raizArtefatos, 'fluxos', `${job.id}.txt`);
  mkdirSync(join(opts.raizArtefatos, 'fluxos'), { recursive: true });

  const vars: Record<string, string> = { input: e.entrada, saida };
  // Campos do topo que o prompt pode citar. `titulo` é o caso que importa: a
  // fase de avatar TEM que nomear o vídeo exatamente como a fase de download
  // vai procurar — se divergirem, o download nunca acha (defeito que fez o v1
  // encurtar o título).
  if (e.titulo) vars.titulo = e.titulo;
  for (const [k, v] of Object.entries(e.fluxo ?? {})) {
    if (typeof v === 'string') vars[k] = v;
  }

  const base = job.motor && job.modelo && job.esforco
    ? { motor: job.motor, modelo: job.modelo, esforco: job.esforco }
    : opts.perfilPadrao;
  const perfil = motorForcado ? { ...base, motor: motorForcado } : base;

  return {
    // `renderizarPrompt` recusa variável que o template não usa, então uma fase
    // só recebe o que o prompt dela realmente pede.
    prompt: renderizarPrompt(e.prompt_texto, filtrarUsadas(e.prompt_texto, vars)),
    // O repo de DOMÍNIO, não `homedir()`: é onde vivem as skills de projeto
    // (`<repo>/.claude/skills/`) e o git em que o prompt manda commitar. O
    // valor vem do registry validado no boot (§9 exige `cwd` conferido contra
    // a lista de repos registrados), e cai para `opts.cwd` se a fase não
    // declarou repo — fluxo criado por versão anterior a isto.
    cwd: existsSync(e.fluxo?.repo ?? '') ? e.fluxo.repo : opts.cwd,
    perfil,
    vars: {},
    timeoutMs: TIMEOUT_FASE_SEGUNDOS * 1_000,
    // O MESMO contrato das skills do catálogo, e não `bruto.trim()`.
    //
    // Sem isto a fase aceitava qualquer stdout como sucesso, e aconteceu em
    // produção: o A#3 respondeu `ERRO: skill inemaclub-textos não encontrada`,
    // o job virou `done` e o portão abriu numa fase que tinha falhado. Pior
    // ainda em silêncio: `resultado` virava o texto inteiro do agente, e é ele
    // que a fase SEGUINTE recebe como `anterior` — a fase de reel ganhava um
    // blob de prosa onde esperava um caminho de arquivo.
    //
    // `.txt` porque é o que `{{saida}}` promete ao prompt (ver `saida` acima).
    interpretarSaida: (bruto: string) => extrairArtefato(bruto, ['txt']),
  };
}

/** Só as variáveis que o template cita — o resto seria erro em `renderizarPrompt`. */
function filtrarUsadas(template: string, vars: Record<string, string>): Record<string, string> {
  const usadas = new Set(
    [...template.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1]),
  );
  return Object.fromEntries(Object.entries(vars).filter(([k]) => usadas.has(k)));
}

export function criarPromptDe(opts: OpcoesSkills): (job: Job) => Promise<ContextoExecucao> {
  if (!existsSync(opts.cwd)) {
    throw new Error(`skills: cwd de agente não existe: ${opts.cwd}`);
  }

  return async (job: Job): Promise<ContextoExecucao> => {
    // Fase de fluxo: o prompt não vem do disco, vem do job — congelado quando o
    // fluxo foi criado. Ler o arquivo aqui reintroduziria exatamente o que o
    // §3.4 proíbe: editar um prompt mudaria um fluxo em voo.
    if (job.tarefa === TAREFA_FLUXO_AGENTE) return contextoDeFase(job, opts);
    if (job.tarefa === TAREFA_FLUXO_NAVEGADOR) return contextoDeFase(job, opts, 'chrome');

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
    const emCurso = def.aguarda_artefato && trabalhoEmCurso(saida);
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
        ? Math.min(
          def.timeout_segundos,
          def.timeout_setup_segundos ?? TIMEOUT_SETUP_PADRAO_SEGUNDOS,
        ) * 1_000
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
          // Só o `/cancelar` mata o trabalho destacado. Desligamento e perda de
          // lease deixam vivo de propósito — é o que a adoção depende.
          encerrarTrabalho: () => encerrarTrabalhoDestacado(saida),
        }
        : {
          interpretarSaida: (bruto: string) => extrairArtefato(bruto, def.artefato_exts),
        }),
    };
  };
}
