// Definição de um FLUXO: o `flow.json` que mora no repo de domínio.
//
// A diferença de fundo para uma skill (`registry.ts`): a skill lê o prompt do
// disco a cada job, porque não tem estado e "rodar de novo do zero" é aceitável.
// Um fluxo NÃO pode: ele tem trabalho parcial. Editar a lista de alvos ou um
// prompt no meio de uma execução mudaria as regras do jogo em voo (§3.4). Por
// isso a definição é CONGELADA na criação, e o hash cobre o JSON mais o
// conteúdo de cada prompt referenciado.
import { ESFORCOS_RANK, MODELOS_RANK } from './perfil.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { Fila, Kind } from '../fila/types.js';

export interface FaseDef {
  id: string;
  /** `fluxo` = um job para todos os alvos; `alvo` = um job por alvo. */
  escopo: 'fluxo' | 'alvo';
  fila: Fila;
  kind: Kind;
  /** Nome da tarefa: skill do catálogo (`kind=agent`) ou função registrada. */
  tarefa: string;
  /** Caminho do prompt, relativo à raiz do repo de domínio. Só em `kind=agent`. */
  prompt?: string;
  /**
   * O CONTEÚDO do prompt, preenchido no congelamento. É ele que vai para o job,
   * não o caminho: ler o arquivo na hora de executar seria exatamente o que o
   * §3.4 proíbe — um prompt editado no meio da execução mudaria as regras de um
   * fluxo em voo, sem mudar uma vírgula do flow.json.
   */
  prompt_texto?: string;
  max_tentativas: number;
  /** Fase de POLL: reagenda a si mesma até achar o que espera, ou estourar. */
  espera?: { intervalo: number; timeout: number };
  /** Destino da entrega, com `{canal}` resolvido pelo alvo. */
  entrega?: string;
  /**
   * PORTÃO HUMANO: ao terminar esta fase, o fluxo PARA e espera `/aprovar`.
   *
   * Existe porque há trabalho que custa caro e não dá para desfazer — render de
   * avatar, fila de reel. Aprovar o texto antes vale mais que retentar depois.
   * Também é como se modela uma fase que é feita FORA do bot (a pessoa gera os
   * avatares no estúdio): o fluxo espera, e o `/aprovar` é o "terminei".
   */
  pausa_apos?: boolean;
  /**
   * Fase OPCIONAL: só entra no fluxo quando a opção de mesmo nome foi pedida na
   * criação (hoje, `api`).
   *
   * O default é a fase NÃO existir. É isso que faz um fluxo criado sem a opção
   * ficar idêntico ao de antes da fase ser declarada — mesmo `/status`, mesmo
   * `| sombra`, sem uma linha a mais dizendo "pulado" para explicar algo que
   * não vai acontecer.
   */
  opcional?: string;
  /**
   * Perfil de execução DESTA fase (`{modelo, esforco, motor}`, todos opcionais).
   *
   * O slot já existia em `resolverPerfil` (`FontesPerfil.fase`, precedência 2)
   * e nunca tinha sido ligado: sem ele toda fase de todo fluxo rodava no padrão
   * do `.env`, e fases de dificuldade muito diferente compartilhavam perfil por
   * acidente — exatamente o defeito do v1 que o `perfil.ts` existe para
   * corrigir. Medido em 2026-08-05: a fase `texto` escreve o roteiro de 12
   * públicos UMA vez (US$ 2,41 no fluxo), enquanto a fase `reel` multiplica por
   * público e o que sobra de modelo nela é ler o mosaico e reagir a exit != 0.
   * São trabalhos diferentes; agora podem ter modelos diferentes.
   *
   * Ausente = o padrão do `.env`, como antes.
   */
  perfil?: { motor?: string; modelo?: string; esforco?: string };
}

export interface AlvoDef {
  /** Nome do canal, NUNCA o caminho: o mapa de destinos é registry do bot (§3.2). */
  canal?: string;
  [chave: string]: string | undefined;
}

export interface FlowDef {
  nome: string;
  /** Uma letra ou duas: vira o `P` de `P#16`. */
  prefixo: string;
  versao_def: number;
  alvos: Record<string, AlvoDef>;
  fases: FaseDef[];
  /** Quem fala, quando a fase de avatar é feita pela API (`| api`). Fica no
   *  DOMÍNIO porque é decisão dele — o bot só sabe chamar a HeyGen. Um alvo
   *  pode sobrescrever qualquer um dos dois (ver `AlvoDef`). */
  avatar_id?: string;
  voice_id?: string;
  /** Motor da geração (`avatar_iii` | `avatar_iv` | `avatar_v`). Sem ele, a
   *  tarefa usa o barato — ver `MOTOR_PADRAO`. */
  engine?: string;
}

const FILAS_VALIDAS = new Set<Fila>(['render', 'navegador', 'texto', 'io', 'cpu']);
// Começa com letra OU dígito: os públicos reais incluem `40mais` e `60mais`, e
// quem define o vocabulário do domínio é o domínio — não o validador do bot.
const NOME_SIMPLES = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function erro(campo: string, detalhe: string): never {
  throw new Error(`flow.json (${campo}): ${detalhe}`);
}

function texto(v: unknown, campo: string): string {
  if (typeof v !== 'string' || v.trim() === '') erro(campo, 'faltando ou vazio');
  return (v as string).trim();
}

/**
 * Valida a definição já parseada. `raiz` é o repo de DOMÍNIO — é lá que os
 * prompts das fases vivem, não neste repo.
 */
/**
 * Tarefas que uma FASE pode nomear, além das SKILLS do catálogo (`reel`,
 * `explicativo`…). Catálogo fechado (§9): o `flow.json` não inventa comando.
 *
 * `skills` chega por parâmetro porque quem conhece o catálogo é o bot, não o
 * repo de domínio — e um `flow.json` que referencie skill inexistente tem que
 * ser recusado na CARGA, não no primeiro job.
 */
export const TAREFAS_DE_FASE = new Set([
  'fluxo-agente', 'fluxo-navegador', 'heygen.baixar', 'heygen.gerar',
  // A rota de CRÉDITOS: mesma fase, outra autenticação (OAuth pela CLI).
  'heygen.gerar-creditos',
  // A rota do ESTÚDIO por script (`| estudio`), irmã do `fluxo-navegador`.
  'heygen.estudio',
  // A fase de reel como FUNÇÃO: o agente só resolvia nomes e disparava um
  // comando. Ver `fila/tarefas/reel.ts` e `docs/custo-por-fase-a19-a29.md`.
  'reel.montar',
]);

export function validarFlow(dados: unknown, raiz: string, skills: string[] = []): FlowDef {
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    throw new Error('flow.json: precisa ser um objeto');
  }
  const d = dados as Record<string, unknown>;

  const nome = texto(d.nome, 'nome');
  if (!NOME_SIMPLES.test(nome)) erro('nome', `"${nome}" — minúsculas, dígitos, "-" e "_"`);

  const prefixo = texto(d.prefixo, 'prefixo');
  if (!/^[A-Z]{1,3}$/.test(prefixo)) erro('prefixo', `"${prefixo}" — 1 a 3 letras maiúsculas (vira o "P" de P#16)`);

  // `avatar_id`/`voice_id` são opcionais: só o fluxo que usa `| api` precisa
  // deles, e a fase `gerar` recusa com mensagem própria quando faltam.
  const avatar_id = typeof d.avatar_id === 'string' ? d.avatar_id.trim() : undefined;
  const voice_id = typeof d.voice_id === 'string' ? d.voice_id.trim() : undefined;
  const engine = typeof d.engine === 'string' ? d.engine.trim() : undefined;

  const versao_def = d.versao_def;
  if (typeof versao_def !== 'number' || !Number.isInteger(versao_def) || versao_def <= 0) {
    erro('versao_def', 'precisa ser inteiro > 0');
  }

  if (typeof d.alvos !== 'object' || d.alvos === null || Array.isArray(d.alvos)) {
    erro('alvos', 'precisa ser objeto { nome: { … } }');
  }
  const alvos: Record<string, AlvoDef> = {};
  for (const [nomeAlvo, bruto] of Object.entries(d.alvos as Record<string, unknown>)) {
    if (!NOME_SIMPLES.test(nomeAlvo)) erro(`alvos.${nomeAlvo}`, 'nome inválido');
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
      erro(`alvos.${nomeAlvo}`, 'precisa ser objeto');
    }
    const a: AlvoDef = {};
    for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
      a[k] = typeof v === 'string' ? v : String(v);
    }
    alvos[nomeAlvo] = a;
  }
  if (Object.keys(alvos).length === 0) erro('alvos', 'nenhum alvo — um fluxo sem alvo não tem o que fazer');

  if (!Array.isArray(d.fases) || d.fases.length === 0) erro('fases', 'precisa ser um array não vazio');
  const vistas = new Set<string>();
  const fases = (d.fases as unknown[]).map((bruta, i) => {
    if (typeof bruta !== 'object' || bruta === null || Array.isArray(bruta)) {
      erro(`fases[${i}]`, 'precisa ser objeto');
    }
    const f = bruta as Record<string, unknown>;
    const id = texto(f.id, `fases[${i}].id`);
    if (!NOME_SIMPLES.test(id)) erro(`fases[${i}].id`, `"${id}" — nome inválido`);
    if (vistas.has(id)) erro(`fases[${i}].id`, `"${id}" duplicado`);
    vistas.add(id);

    const opcional = typeof f.opcional === 'string' && f.opcional.trim()
      ? f.opcional.trim() : undefined;

    // Validado AQUI, no boot, e não na hora de enfileirar: um `modelo: "opus5"`
    // (que não existe — o nome é `opus`) tem que derrubar o registro do fluxo,
    // não a fase, 40 minutos depois, com o avatar já gerado.
    let perfil: { motor?: string; modelo?: string; esforco?: string } | undefined;
    if (f.perfil !== undefined) {
      if (typeof f.perfil !== 'object' || f.perfil === null || Array.isArray(f.perfil)) {
        erro(`fases[${i}].perfil`, 'precisa ser objeto {motor?, modelo?, esforco?}');
      }
      const p = f.perfil as Record<string, unknown>;
      const campo = (nome: 'motor' | 'modelo' | 'esforco'): string | undefined => {
        if (p[nome] === undefined) return undefined;
        const v = texto(p[nome], `fases[${i}].perfil.${nome}`);
        if (nome === 'modelo' && MODELOS_RANK[v] === undefined) {
          erro(`fases[${i}].perfil.modelo`, `"${v}" — conheço: ${Object.keys(MODELOS_RANK).join(', ')}`);
        }
        if (nome === 'esforco' && ESFORCOS_RANK[v] === undefined) {
          erro(`fases[${i}].perfil.esforco`, `"${v}" — conheço: ${Object.keys(ESFORCOS_RANK).join(', ')}`);
        }
        return v;
      };
      const m = campo('motor'), mo = campo('modelo'), e = campo('esforco');
      perfil = { ...(m ? { motor: m } : {}), ...(mo ? { modelo: mo } : {}), ...(e ? { esforco: e } : {}) };
      if (Object.keys(perfil).length === 0) perfil = undefined;
    }

    const escopo = texto(f.escopo, `fases[${i}].escopo`);
    if (escopo !== 'fluxo' && escopo !== 'alvo') erro(`fases[${i}].escopo`, '"fluxo" ou "alvo"');

    const fila = texto(f.fila, `fases[${i}].fila`) as Fila;
    if (!FILAS_VALIDAS.has(fila)) erro(`fases[${i}].fila`, `"${fila}" não existe`);

    const kind = texto(f.kind, `fases[${i}].kind`) as Kind;
    if (kind !== 'agent' && kind !== 'function') erro(`fases[${i}].kind`, '"agent" ou "function"');

    // Catálogo fechado também aqui (§9): a fase nomeia a tarefa, e quem confere
    // se ela existe é o runtime, contra o registry de skills e o de funções.
    const tarefa = texto(f.tarefa, `fases[${i}].tarefa`);
    if (!TAREFAS_DE_FASE.has(tarefa) && !skills.includes(tarefa)) {
      erro(
        `fases[${i}].tarefa`,
        `"${tarefa}" não existe — tarefas de fase: ${[...TAREFAS_DE_FASE].join(', ')}`
        + `${skills.length ? ` · skills: ${skills.join(', ')}` : ''}`,
      );
    }

    let prompt: string | undefined;
    // Prompt próprio só nas fases que SÃO do domínio (`fluxo-agente`,
    // `fluxo-navegador`). Quando a fase dispara uma SKILL do catálogo (a última
    // do promoclub é a mesma `reel` que o usuário chama no chat), o prompt é da
    // skill e mora no bot — exigi-lo aqui obrigaria o domínio a duplicá-lo.
    if (kind === 'agent' && TAREFAS_DE_FASE.has(tarefa)) {
      prompt = texto(f.prompt, `fases[${i}].prompt`);
      if (isAbsolute(prompt) || prompt.includes('..')) {
        erro(`fases[${i}].prompt`, 'precisa ser relativo ao repo de domínio, sem ".."');
      }
      const caminho = join(raiz, prompt);
      if (!existsSync(caminho) || statSync(caminho).size === 0) {
        erro(`fases[${i}].prompt`, `arquivo ausente ou vazio: ${prompt}`);
      }
    }

    const max_tentativas = f.max_tentativas === undefined ? 1 : f.max_tentativas;
    if (typeof max_tentativas !== 'number' || !Number.isInteger(max_tentativas) || max_tentativas <= 0) {
      erro(`fases[${i}].max_tentativas`, 'inteiro > 0');
    }

    let espera: FaseDef['espera'];
    if (f.espera !== undefined) {
      const e = f.espera as Record<string, unknown>;
      const intervalo = e?.intervalo;
      const timeout = e?.timeout;
      if (typeof intervalo !== 'number' || intervalo <= 0) erro(`fases[${i}].espera.intervalo`, 'segundos > 0');
      if (typeof timeout !== 'number' || timeout <= intervalo) {
        erro(`fases[${i}].espera.timeout`, 'segundos, maior que o intervalo');
      }
      if (kind !== 'function') erro(`fases[${i}].espera`, 'só faz sentido em fase kind=function');
      espera = { intervalo, timeout };
    }

    return {
      id,
      escopo: escopo as FaseDef['escopo'],
      fila,
      kind,
      tarefa,
      ...(prompt ? { prompt } : {}),
      max_tentativas,
      ...(espera ? { espera } : {}),
      ...(typeof f.entrega === 'string' ? { entrega: f.entrega } : {}),
      ...(f.pausa_apos === true ? { pausa_apos: true } : {}),
      ...(opcional ? { opcional } : {}),
      ...(perfil ? { perfil } : {}),
    };
  });

  return {
    nome, prefixo, versao_def, alvos, fases,
    ...(avatar_id ? { avatar_id } : {}),
    ...(voice_id ? { voice_id } : {}),
    ...(engine ? { engine } : {}),
  };
}

export function carregarFlow(raiz: string, skills: string[] = []): FlowDef {
  const caminho = join(raiz, 'flow.json');
  let bruto: string;
  try {
    bruto = readFileSync(caminho, 'utf8');
  } catch {
    throw new Error(`flow.json: não consegui ler ${caminho}`);
  }
  try {
    return validarFlow(JSON.parse(bruto), raiz, skills);
  } catch (e) {
    if ((e as Error).message.startsWith('flow.json')) throw e;
    throw new Error(`flow.json: JSON inválido em ${caminho}: ${(e as Error).message}`);
  }
}

/**
 * Congela a definição: devolve uma cópia com o TEXTO de cada prompt embutido.
 * Daqui para frente o fluxo não depende mais do disco do repo de domínio.
 */
export function congelar(def: FlowDef, raiz: string): FlowDef {
  return {
    ...def,
    fases: def.fases.map((f) => (f.prompt
      ? { ...f, prompt_texto: readFileSync(join(raiz, f.prompt), 'utf8') }
      : f)),
  };
}

/**
 * Hash do CONGELAMENTO: a definição mais o conteúdo de cada prompt que ela
 * referencia. Só o JSON não bastaria — editar um prompt mudaria o que o fluxo
 * faz sem mudar uma vírgula do `flow.json`, e o `/status` diria que está tudo
 * igual.
 */
export function hashDefinicao(def: FlowDef, raiz: string): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(def));
  for (const fase of def.fases) {
    if (!fase.prompt) continue;
    h.update(`\n--${fase.id}--\n`);
    try {
      h.update(readFileSync(join(raiz, fase.prompt), 'utf8'));
    } catch {
      h.update('(prompt ilegível)');
    }
  }
  return h.digest('hex');
}

/** `P#16/mulheres/render` — a correlação que o §8 exige em todo log de job. */
export function flowRef(prefixo: string, fluxoId: number, alvo: string, fase: string): string {
  return `${prefixo}#${fluxoId}/${alvo}/${fase}`;
}

/** `P#16` → `{ prefixo, id }`; `undefined` se não for uma referência. */
/**
 * `A#9`, `a#9`, `A9` e `a9` — as quatro formas, um significado.
 *
 * O `#` era obrigatório e virou armadilha: em 31/07 o dono tentou
 * `/aprovar a8` e ouviu que não existia. Letras seguidas de dígitos são
 * inequívocas — não colidem com id de JOB, que é só número, e é isso que
 * mantém `/status 13` funcionando como job.
 */
export function parseRef(texto: string): { prefixo: string; id: number } | undefined {
  const m = texto.trim().match(/^([A-Za-z]{1,3})#?(\d+)$/);
  if (!m) return undefined;
  return { prefixo: m[1].toUpperCase(), id: Number(m[2]) };
}
