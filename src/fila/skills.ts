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
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { extrairAlvo, extrairArtefato, SemContrato } from '../dominio/artefato.js';
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
  /**
   * Árvore de projetos (`PROJETOS_DIR` do boot). É contra ela que o `repo` de
   * uma skill plugada vira caminho — o `{{repo}}` do prompt.
   */
  projetosDir: string;
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
 * promoavatar gera 12 peças numa sessão só. */
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

  // A `pasta` do domínio (`textos/C15`) também é criada AQUI, e pelo mesmo
  // motivo do `saida`: quem inventou o caminho foi o bot — ele o injeta no
  // prompt como `{{pasta}}` —, então criá-lo é trabalho do bot.
  //
  // Custou o C#15: a pasta não existia, o `mkdir` do agente foi bloqueado pelo
  // sandbox do motor ("may only create directories in the allowed working
  // directories") e cada `Write` virou pedido de permissão. O bot roda sem
  // ninguém na frente do terminal: pedido de permissão é fase perdida, e o
  // agente terminou sem escrever um arquivo sequer. Nem o resgate pelo arquivo
  // (`aceitarPeloArquivo`) salva isso — ali não há trabalho nenhum a resgatar.
  //
  // Só criamos a pasta se o repo de domínio EXISTE: criá-la fora dele faria o
  // bot materializar a árvore de um repo que não está no disco, e ainda mudaria
  // por efeito colateral o `cwd` resolvido logo abaixo (que cai para
  // `opts.cwd` justamente quando o repo não existe).
  const repo = existsSync(e.fluxo?.repo ?? '') ? e.fluxo.repo : undefined;
  if (repo && e.fluxo?.pasta) mkdirSync(e.fluxo.pasta, { recursive: true });

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
    cwd: repo ?? opts.cwd,
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
    //
    // …com UMA saída de emergência: o arquivo que o BOT nomeou já estar lá.
    // Ver `aceitarPeloArquivo`.
    interpretarSaida: (bruto: string) => {
      try {
        return recusarReciboDeErro(extrairArtefato(bruto, ['txt']));
      } catch (err) {
        if (aceitarPeloArquivo(err, bruto, saida)) {
          opts.log?.(`[job ${job.id}] sem "RESULT:", mas ${saida} existe — aceito pelo arquivo`);
          return saida;
        }
        throw err;
      }
    },
  };
}

/**
 * O trabalho terminou, o agente só não avisou.
 *
 * Custou o C#14: 36 roteiros escritos, o `{{saida}}` gravado no formato certo, e
 * tudo descartado porque a última linha `RESULT:` não veio — provavelmente
 * comida pelo teto de stdout (`LIMITE_SAIDA_BYTES`), que corta justamente o FIM.
 * O `/refazer` reescreveu os 36 e tropeçou no mesmo lugar.
 *
 * O caminho não é informação que o agente detém: quem o inventou foi o bot, e
 * ele o injetou no prompt como `{{saida}}`. Exigir que o agente o repita de
 * volta é cerimônia — dá para simplesmente olhar se o arquivo está lá.
 *
 * Duas condições, e as duas importam:
 *
 * 1. **Nada de contrato no stdout.** `ERRO:` declarado é falha DE VERDADE e
 *    segue falha: o A#3 já virou `done` por aceitar stdout qualquer, e o portão
 *    abriu numa fase que tinha quebrado. Um `RESULT:` com extensão errada
 *    também não cai aqui — é bug de quem escreveu, e mascarar atrasa o conserto.
 * 2. **O arquivo existe e tem conteúdo.** Vazio é o agente tendo criado o
 *    arquivo e morrido antes de escrever; aceitar isso entregaria um recibo em
 *    branco para a fase seguinte.
 */
/**
 * Recibo que ANUNCIA ERRO não é recibo — mesmo com o `RESULT:` correto.
 *
 * O guarda equivalente já existia, mas só no resgate pelo arquivo (o furo do
 * A#17). Faltava o caminho normal: o agente declara `RESULT: {{saida}}`
 * certinho e escreve DENTRO do arquivo que a coisa falhou. O job vira `done`, o
 * portão abre, e a fase seguinte roda sobre um trabalho que não existe.
 *
 * Aconteceu no MVD#89 (2026-08-21): o Suno recusou o `prompt_estilo` por citar
 * um artista, nenhuma faixa foi gerada, o recibo dizia `erro: geração de música
 * falhou` — e o fluxo seguiu para a fase de capa e clipe como se a música
 * estivesse pronta.
 *
 * Início de linha, e só: um artefato legítimo pode citar a palavra no meio de
 * uma frase, e recusar isso trocaria um defeito por outro.
 */
function recusarReciboDeErro(caminho: string): string {
  let texto: string;
  try {
    texto = readFileSync(caminho, 'utf8');
  } catch {
    return caminho;   // ilegível é outro problema, e quem espera pelo arquivo o vê
  }
  const m = /^[\s>*_`-]*ERRO\s*:\s*(.+)$/im.exec(texto);
  if (m) throw new SemContrato(`o recibo da fase declara erro: ${m[1]!.trim()}`);
  return caminho;
}

function aceitarPeloArquivo(err: unknown, bruto: string, saida: string): boolean {
  if (!(err instanceof SemContrato)) return false;
  // Só o caso "não declarou NADA". As outras mensagens de `SemContrato` são
  // declarações erradas ou um `ERRO:` legítimo — nenhuma delas é silêncio.
  if (!/terminou sem declarar/.test(err.message)) return false;
  // Rede a mais: um `ERRO:` que o extrator não casou (enfeitado de um jeito
  // novo) não pode virar sucesso por descuido.
  if (/^[\s>*_`-]*ERRO\s*:/im.test(bruto)) return false;
  try {
    if (statSync(saida).size <= 0) return false;
  } catch {
    return false;
  }
  // ...e o mesmo teste NO ARQUIVO, que é o furo que o A#17 encontrou.
  //
  // O prompt manda o agente gravar o resultado em `{{saida}}` E declarar
  // `ERRO:` na última linha quando falha. O agente do navegador fez metade
  // disso: escreveu `ERRO: aba do editor abriu oculta` DENTRO do arquivo e, no
  // stdout, contou a falha em prosa ("reportado em 231.txt com ERRO: como
  // última linha"). Nenhum `ERRO:` começava linha no stdout, então o guarda
  // acima não casou; o arquivo existia e não estava vazio, e o job virou
  // `done`. O portão abriu a fase de download, que foi procurar no HeyGen um
  // vídeo que nunca tinha sido gerado.
  //
  // Um recibo que começa anunciando erro não é recibo. Só olhamos INÍCIO DE
  // LINHA de propósito: um artefato legítimo pode citar a palavra no meio de
  // uma frase, e recusar isso transformaria o conserto num novo bug.
  try {
    return !/^[\s>*_`-]*ERRO\s*:/im.test(readFileSync(saida, 'utf8'));
  } catch {
    return false;
  }
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
        // Só entra quando o template pede: `renderizarPrompt` derruba o job se
        // receber variável que o prompt não usa, e a maioria das skills não é
        // de repo externo.
        ...(def.repo !== undefined && /\{\{\s*repo\s*\}\}/i.test(template)
          ? { repo: join(opts.projetosDir, def.repo) }
          : {}),
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
