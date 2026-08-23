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
   * Prompts ALTERNATIVOS desta fase, `{ nome: caminho }` — a mesma fase escrita
   * com outra estratégia (`{ viral: "prompts/fase1-viral.md" }`).
   *
   * Quem declara é o DOMÍNIO, como já acontece com `opcional`: o bot não adivinha
   * nome de arquivo por convenção. Isso é o que faz `| prompt=X` ser recusado com
   * a lista certa num domínio que não declarou nenhuma, faz o `help` derivado
   * listar as que existem sem ninguém reescrever texto, e faz renomear uma
   * variante ser uma linha no `flow.json` em vez de mexer no bot.
   *
   * A troca acontece ANTES do congelamento (`aplicarVariante`), então o
   * `prompt_texto` congelado e o `hash` já são os da variante escolhida.
   */
  variantes?: Record<string, string>;
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
  /**
   * O que o PORTÃO desta fase mostra no chat — declarado pelo DOMÍNIO.
   *
   * O portão nasceu lendo `textos/<REF>/<alvo>.md`, que é a forma do
   * promoavatar. O musicavideo produz um `PLANO.md` numa pasta de saída cujo
   * nome (o slug) o bot nem conhece, e o portão dele abriu vazio (MVD#89):
   * nada para ler, nada para decidir, e a fase seguinte é a única paga.
   *
   * Em vez de o bot ganhar uma segunda convenção chumbada, o domínio DIZ. Cada
   * item é um caminho com marcadores:
   *
   *   `{{repo}}`      o repo de domínio
   *   `{{ref}}`       `A32` — o mesmo nome que a pasta de textos usa
   *   `{{alvo}}`      o público
   *   `{{artefato}}`  o arquivo que a fase declarou no `RESULT:`
   *   `{{artefato:campo}}`  o valor de `campo:` DENTRO desse arquivo — é assim
   *                   que um domínio entrega um caminho que só ele sabe montar
   *                   (`plano: /out/<slug>/PLANO.md` vira `{{artefato:plano}}`)
   *
   * Sem declaração, vale o comportamento de sempre: os roteiros, e o artefato
   * como rede quando não há roteiro nenhum.
   */
  portao?: {
    mostrar: string[];
    /**
     * O que se pode RESPONDER ao portão além de "sim".
     *
     * `{ "reprova": "bash {{repo}}/x.sh reprova {{anterior:slug}} clipe {{resposta}}" }`
     *
     * O portão nasceu de mão única: `/aprovar` liberava e não havia o
     * contrário. Corrigir uma capa custava `/cancelar` — o fluxo inteiro. Mas o
     * BOT não pode saber o que "corrigir uma capa" significa: quem sabe é o
     * domínio, que já tem `reprova`, `ajusta` e afins. Então ele DECLARA, do
     * mesmo jeito que declara o que mostrar.
     *
     * `{{resposta}}` é o resto da linha que a pessoa digitou, num argumento só
     * e aspado — a mesma filosofia do `--bruto`: quem interpreta é o domínio.
     * Os demais marcadores são os do `comando` (`{{repo}}`, `{{anterior:campo}}`).
     *
     * Depois que a resposta roda, a fase REABRE: o recibo velho é apagado, ela
     * volta para a fila e o portão mostra o material novo. É o "refaz e me
     * apresenta até eu aprovar".
     */
    respostas?: Record<string, string>;
  };
  /**
   * O COMANDO da fase, quando `tarefa: "cli.rodar"` — o domínio declara, o bot
   * executa. Sem agente no meio.
   *
   * Existe pelo mesmo motivo que `reel.montar` existe (ver o cabeçalho de
   * `fila/tarefas/reel.ts`): fase que só monta uma linha de comando não precisa
   * de um modelo. No musicavideo eram QUATRO fases assim — e o prompt de uma
   * delas mandava rodar um binário `musicavideo` que não existe no PATH, porque
   * quem o escreveu foi um modelo adivinhando (MVD#87, 2026-08-21). Comando
   * declarado é comando que o `plugar-fluxo.sh` consegue conferir na
   * instalação; prosa dentro de prompt, não.
   *
   * Marcadores: `{{repo}}`, `{{input}}`, `{{alvo}}`, `{{ref}}` e `{{saida}}` —
   * todos já ASPADOS na hora de montar a linha, então texto do usuário nunca
   * vira comando.
   *
   * `{{repo}}` é obrigatório pela mesma regra da rota skill do manifesto
   * (`invocacao`): caminho fixo não sobrevive a outra máquina.
   */
  comando?: string;
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
  /**
   * Clipe de encerramento concatenado no fim do reel, POR VARIANTE:
   * `{ padrao: "cta/cta-9x16.mp4", viral: "cta/marca-9x16.mp4" }`.
   *
   * Existe porque o clipe padrão é um CTA ("saiba mais em inema.club") e a
   * variante viral se organiza inteira em torno de UM pedido de engajamento —
   * um segundo pedido três segundos depois compete com ele. O clipe da variante
   * é só a marca: mantém a atribuição sem dar outra ordem.
   *
   * Ausente = o `montar-reel.py` usa o default dele (`cta/cta-9x16.mp4` do
   * domínio), que é o comportamento de sempre.
   */
  cta?: Record<string, string>;
  /**
   * CONSULTAS de leitura que o chat pode rodar: `{ lista: "bash {{repo}}/x.sh
   * lista 10" }` vira `/musicavideo lista`.
   *
   * O domínio já tinha `lista`, `busca` e afins no CLI dele; o que faltava era
   * poder perguntar do celular sem abrir terminal. São LEITURA por contrato —
   * não entram na fila, não geram artefato, e têm teto curto de tempo. Se uma
   * consulta gastar dinheiro ou demorar, ela não é consulta: é fase.
   *
   * `{{repo}}` é obrigatório (mesma regra de `comando`); `{{input}}` é opcional
   * e recebe, ASPADO, o resto da mensagem — é o que faz `/musicavideo busca
   * rock` funcionar.
   */
  consultas?: Record<string, string>;
  /**
   * LEGENDA do reel, resolvida no congelamento — não vem do `flow.json`.
   *
   * Só é gravada quando DESLIGADA (`| legenda=nao`): um fluxo normal fica com a
   * definição idêntica à de antes desta opção existir, e o hash não muda por
   * causa de um campo que repete o default. `false` aqui vira `--sem-legenda`
   * no `montar-reel.py` (`entrada-fase.ts` → `reel.ts`).
   *
   * Antes de 2026-08-21 a opção só sabia substituir `{legenda}` num campo
   * `entrega` de fase — que nenhum domínio tem desde que o reel virou função.
   * `| legenda=nao` era aceito e não fazia nada.
   */
  legenda?: boolean;
  /**
   * A variante com que ESTE fluxo foi criado (`| prompt=viral`), gravada na
   * definição congelada por `aplicarVariante`.
   *
   * Fica aqui, e não em `opcoes`, porque `opcoes` é o mapa que
   * `definicaoEfetiva` usa para FILTRAR fase opcional pelo nome — variante não
   * é fase. E porque a definição congelada já é o lugar de "este fluxo nasceu
   * com estas regras": é dela que a fase de reel lê qual clipe usar, muitas
   * horas depois da criação.
   */
  variante?: string;
  /** Quem fala, quando a fase de avatar é feita pela API (`| api`). Fica no
   *  DOMÍNIO porque é decisão dele — o bot só sabe chamar a HeyGen. Um alvo
   *  pode sobrescrever qualquer um dos dois (ver `AlvoDef`). */
  avatar_id?: string;
  voice_id?: string;
  /** Motor da geração (`avatar_iii` | `avatar_iv` | `avatar_v`). Sem ele, a
   *  tarefa usa o barato — ver `MOTOR_PADRAO`. */
  engine?: string;
  /**
   * Repo (nome da pasta em `projetosDir`) que HOSPEDA o `montar-reel.py`, para
   * um domínio usar o motor de outro em vez de manter uma cópia.
   *
   * A cópia é a armadilha conhecida: no A#23 o agente rodou o `preparar.py`
   * VELHO da skill global e saiu `template: None`. Um motor, N domínios — o
   * `flow.json` de cada um viaja junto (`--flow`), então templates e layout
   * continuam sendo do domínio.
   */
  motor_repo?: string;
  /** Pasta dos layouts do reel, relativa ao repo do domínio (default
   *  `templates`) — e o layout PADRÃO quando o texto não indica outro.
   *
   *  O `preparar.py` lê os dois do `flow.json` no disco, mas eles são
   *  declarados aqui porque `congelar()` reconstrói a definição a partir do que
   *  o validador devolve: campo não declarado é campo descartado na definição
   *  congelada, e um `/status` ou um diff de fluxo deixariam de mostrá-lo. */
  templates_dir?: string;
  template?: string;
}

const FILAS_VALIDAS = new Set<Fila>(['render', 'navegador', 'texto', 'io', 'cpu']);
// Começa com letra OU dígito: os públicos reais incluem `40mais` e `60mais`, e
// quem define o vocabulário do domínio é o domínio — não o validador do bot.
export const NOME_SIMPLES = /^[a-z0-9][a-z0-9_-]{0,40}$/;

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
/**
 * Os marcadores que `entrada-fase.ts` sabe resolver num `comando`.
 *
 * Fechado de propósito, como `TAREFAS_DE_FASE`: marcador desconhecido vira
 * string vazia na hora de montar a linha (nunca marcador cru — isso o shell
 * interpretaria), e "argumento vazio" é o pior sintoma possível — o comando
 * roda, faz outra coisa, e ninguém liga o efeito ao typo.
 */
export const MARCADORES_DE_COMANDO = new Set(['repo', 'input', 'alvo', 'ref', 'saida']);

/** Palavras que o chat já usa depois do nome do fluxo. Uma consulta com esse
 *  nome nunca seria alcançada — e o silêncio seria pior que a recusa. */
const RESERVADAS_DO_CHAT = new Set(['help', 'ajuda', 'status', 'situacao', 'andamento']);

export const TAREFAS_DE_FASE = new Set([
  'fluxo-agente', 'fluxo-navegador', 'heygen.baixar', 'heygen.gerar',
  // A rota de CRÉDITOS: mesma fase, outra autenticação (OAuth pela CLI).
  'heygen.gerar-creditos',
  // A rota do ESTÚDIO por script (`| estudio`), irmã do `fluxo-navegador`.
  'heygen.estudio',
  // A fase de reel como FUNÇÃO: o agente só resolvia nomes e disparava um
  // comando. Ver `fila/tarefas/reel.ts` e `docs/custo-por-fase-a19-a29.md`.
  'reel.montar',
  // O CLI do domínio, com o comando declarado em `comando`. Genérica: é a que
  // dispensa cada domínio novo de escrever um prompt ensinando um modelo a
  // rodar o próprio script — que foi como o musicavideo nasceu, com um binário
  // inventado e um contrato de saída errado (MVD#87, 2026-08-21).
  'cli.rodar',
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
  // Nome de PASTA, não caminho: o bot resolve contra `projetosDir`, como faz
  // com os canais. `flow.json` com caminho absoluto envelhece na primeira vez
  // que alguém move o repo.
  const motor_repo = typeof d.motor_repo === 'string' ? d.motor_repo.trim() : undefined;
  const templates_dir = typeof d.templates_dir === 'string' ? d.templates_dir.trim() : undefined;
  const template = typeof d.template === 'string' ? d.template.trim() : undefined;
  if (motor_repo && !/^[a-z0-9][a-z0-9._-]*$/.test(motor_repo)) {
    erro('motor_repo', `"${motor_repo}" — nome de pasta em projetosDir, não caminho`);
  }

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
    // do promoavatar é a mesma `reel` que o usuário chama no chat), o prompt é da
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

    let variantes: Record<string, string> | undefined;
    if (f.variantes !== undefined) {
      // Fora de uma fase com prompt próprio a variante não teria o que trocar —
      // e um campo aceito em silêncio que não faz nada é pior que a recusa.
      if (!prompt) erro(`fases[${i}].variantes`, 'só em fase com prompt próprio (kind=agent)');
      const v = f.variantes;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        erro(`fases[${i}].variantes`, 'objeto no formato {nome: caminho}');
      }
      const pares = Object.entries(v as Record<string, unknown>).map(([nome, bruto]) => {
        // O nome é digitado no chat (`| prompt=viral`): sem acento e sem espaço,
        // senão a flag vira uma adivinhação de como o dono escreveu a chave.
        if (!/^[a-z0-9-]+$/.test(nome)) {
          erro(`fases[${i}].variantes`, `nome inválido: "${nome}" — minúsculas, dígitos e hífen`);
        }
        const rel = texto(bruto, `fases[${i}].variantes.${nome}`);
        if (isAbsolute(rel) || rel.includes('..')) {
          erro(`fases[${i}].variantes.${nome}`, 'precisa ser relativo ao repo de domínio, sem ".."');
        }
        const cam = join(raiz, rel);
        if (!existsSync(cam) || statSync(cam).size === 0) {
          erro(`fases[${i}].variantes.${nome}`, `arquivo ausente ou vazio: ${rel}`);
        }
        return [nome, rel] as const;
      });
      if (!pares.length) erro(`fases[${i}].variantes`, 'declarado e vazio — remova o campo ou declare uma');
      variantes = Object.fromEntries(pares);
    }

    const max_tentativas = f.max_tentativas === undefined ? 1 : f.max_tentativas;
    if (typeof max_tentativas !== 'number' || !Number.isInteger(max_tentativas) || max_tentativas <= 0) {
      erro(`fases[${i}].max_tentativas`, 'inteiro > 0');
    }

    // `portao.mostrar` só existe onde há portão: declarar o que mostrar numa
    // fase que não para é pedido que nunca seria atendido, e silêncio aqui
    // viraria "configurei e não aconteceu nada".
    let portao: FaseDef['portao'];
    if (f.portao !== undefined) {
      const p = f.portao as Record<string, unknown>;
      const lista = p?.mostrar;
      if (!Array.isArray(lista) || !lista.length || lista.some((x) => typeof x !== 'string' || !x.trim())) {
        erro(`fases[${i}].portao.mostrar`, 'lista não vazia de caminhos (com {{marcadores}})');
      }
      if (f.pausa_apos !== true) erro(`fases[${i}].portao`, 'só faz sentido em fase com pausa_apos');
      // `respostas`: palavra → comando do domínio. Conferido aqui pelo mesmo
      // motivo que o `comando` da fase é: erro de digitação em `flow.json` tem
      // que aparecer no carregamento, não no primeiro portão às três da manhã.
      let respostas: Record<string, string> | undefined;
      if (p?.respostas !== undefined) {
        const r = p.respostas as Record<string, unknown>;
        const nomes = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : null;
        if (!nomes || !nomes.length) {
          erro(`fases[${i}].portao.respostas`, 'objeto não vazio { palavra: comando }');
        } else {
          respostas = {};
          for (const nome of nomes) {
            const cmd = r[nome];
            // A palavra é digitada no chat: sem espaço, sem maiúscula, para a
            // comparação não depender de como a mão veio.
            if (!/^[a-z0-9-]+$/.test(nome)) {
              erro(`fases[${i}].portao.respostas["${nome}"]`, 'palavra em minúsculas, sem espaço');
              continue;
            }
            if (typeof cmd !== 'string' || !cmd.trim()) {
              erro(`fases[${i}].portao.respostas.${nome}`, 'linha de comando não vazia');
              continue;
            }
            if (!cmd.includes('{{repo}}')) {
              erro(`fases[${i}].portao.respostas.${nome}`, 'comando com {{repo}} — caminho absoluto não viaja de máquina');
              continue;
            }
            respostas[nome] = cmd.trim();
          }
        }
      }
      portao = {
        mostrar: (lista as string[]).map((x) => x.trim()),
        ...(respostas && Object.keys(respostas).length ? { respostas } : {}),
      };
    }

    // `cli.rodar` — o comando é do DOMÍNIO, e é conferido aqui, não descoberto
    // no primeiro job às três da manhã.
    let comando: string | undefined;
    if (f.tarefa === 'cli.rodar') {
      comando = typeof f.comando === 'string' ? f.comando.trim() : '';
      if (!comando) erro(`fases[${i}].comando`, 'obrigatório em tarefa "cli.rodar"');
      if (kind !== 'function') erro(`fases[${i}].kind`, '"cli.rodar" é function — quem roda é o bot');
      if (comando && !comando.includes('{{repo}}')) {
        erro(`fases[${i}].comando`, 'precisa citar {{repo}} — caminho fixo não sobrevive a outra máquina');
      }
      // VOCABULÁRIO FECHADO de marcadores. `{{anteriro:slug}}` (typo) passava a
      // carga, passava o `conferir-comandos` e virava argumento VAZIO no
      // primeiro job — um erro de digitação custando uma execução inteira.
      //
      // `{{anterior:*}}` na PRIMEIRA fase é recusado à parte: não há fase
      // anterior, então o argumento nasceria vazio sempre. É o tipo de coisa
      // que só se descobre rodando, e não deveria.
      for (const [, marcador] of (comando ?? '').matchAll(/\{\{([\w:]+)\}\}/g)) {
        if (marcador.startsWith('anterior:')) {
          if (i === 0) {
            erro(`fases[${i}].comando`, `"{{${marcador}}}" na PRIMEIRA fase — não há recibo anterior`);
          }
          continue;
        }
        if (!MARCADORES_DE_COMANDO.has(marcador)) {
          erro(
            `fases[${i}].comando`,
            `marcador "{{${marcador}}}" não existe — conhecidos: `
            + `${[...MARCADORES_DE_COMANDO].map((m) => `{{${m}}}`).join(', ')}, {{anterior:<campo>}}`,
          );
        }
      }
    } else if (f.comando !== undefined) {
      erro(`fases[${i}].comando`, 'só faz sentido em tarefa "cli.rodar"');
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
      ...(variantes ? { variantes } : {}),
      max_tentativas,
      ...(espera ? { espera } : {}),
      ...(typeof f.entrega === 'string' ? { entrega: f.entrega } : {}),
      ...(f.pausa_apos === true ? { pausa_apos: true } : {}),
      ...(portao ? { portao } : {}),
      ...(comando ? { comando } : {}),
      ...(opcional ? { opcional } : {}),
      ...(perfil ? { perfil } : {}),
    };
  });

  // O clipe de encerramento, por variante. Chaves aceitas: `padrao` e o nome de
  // uma variante declarada em alguma fase — assim um erro de digitação
  // (`cta.virall`) é recusado aqui e não vira "usou o clipe errado" no render.
  let cta: Record<string, string> | undefined;
  if (d.cta !== undefined) {
    if (typeof d.cta !== 'object' || d.cta === null || Array.isArray(d.cta)) {
      erro('cta', 'objeto no formato {padrao: caminho, <variante>: caminho}');
    }
    const nomes = new Set(['padrao', ...fases.flatMap((f) => Object.keys(f.variantes ?? {}))]);
    const pares = Object.entries(d.cta as Record<string, unknown>).map(([chave, bruto]) => {
      if (!nomes.has(chave)) {
        erro('cta', `"${chave}" não é "padrao" nem variante declarada (${[...nomes].join(', ')})`);
      }
      const rel = texto(bruto, `cta.${chave}`);
      if (isAbsolute(rel) || rel.includes('..')) {
        erro(`cta.${chave}`, 'precisa ser relativo ao repo de domínio, sem ".."');
      }
      const cam = join(raiz, rel);
      if (!existsSync(cam) || statSync(cam).size === 0) {
        erro(`cta.${chave}`, `arquivo ausente ou vazio: ${rel}`);
      }
      return [chave, rel] as const;
    });
    if (pares.length) cta = Object.fromEntries(pares);
  }

  // CONSULTAS: nome simples → comando de leitura. Validadas como o `comando` de
  // fase, porque são a mesma coisa com outro gatilho — e um nome bobo aqui vira
  // subcomando do chat, então ele não pode colidir com `help`/`status`.
  let consultas: Record<string, string> | undefined;
  if (d.consultas !== undefined) {
    if (typeof d.consultas !== 'object' || d.consultas === null || Array.isArray(d.consultas)) {
      erro('consultas', 'objeto no formato {nome: "comando"}');
    }
    const pares = Object.entries(d.consultas as Record<string, unknown>).map(([nome, bruto]) => {
      if (!NOME_SIMPLES.test(nome)) erro(`consultas.${nome}`, 'nome em minúsculas, sem espaço');
      if (RESERVADAS_DO_CHAT.has(nome)) {
        erro(`consultas.${nome}`, `"${nome}" é palavra do chat (${[...RESERVADAS_DO_CHAT].join(', ')})`);
      }
      const cmd = texto(bruto, `consultas.${nome}`);
      if (!cmd.includes('{{repo}}')) {
        erro(`consultas.${nome}`, 'precisa citar {{repo}} — caminho fixo não sobrevive a outra máquina');
      }
      return [nome, cmd] as const;
    });
    if (pares.length) consultas = Object.fromEntries(pares);
  }

  return {
    nome, prefixo, versao_def, alvos, fases,
    ...(consultas ? { consultas } : {}),
    ...(cta ? { cta } : {}),
    ...(avatar_id ? { avatar_id } : {}),
    ...(voice_id ? { voice_id } : {}),
    ...(engine ? { engine } : {}),
    ...(motor_repo ? { motor_repo } : {}),
    ...(templates_dir ? { templates_dir } : {}),
    ...(template ? { template } : {}),
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

/** As variantes declaradas pelo domínio, na ordem em que ele as escreveu. */
export function variantesDe(def: FlowDef): string[] {
  return [...new Set(def.fases.flatMap((f) => Object.keys(f.variantes ?? {})))];
}

/**
 * Troca o prompt das fases que declaram a variante `nome`.
 *
 * Roda ANTES de `hashDefinicao` e `congelar`: é o que faz o texto congelado e o
 * hash serem os da variante escolhida. Feito depois, o `prompt_texto` seria o do
 * prompt padrão e a flag não mudaria nada — o defeito silencioso que este
 * comentário existe para evitar.
 *
 * Fase que não declara a variante fica intacta: um domínio pode ter variante só
 * na fase de texto sem que as outras precisem saber que ela existe.
 */
export function aplicarVariante(def: FlowDef, nome: string): FlowDef {
  const disponiveis = variantesDe(def);
  if (!disponiveis.includes(nome)) {
    throw new Error(disponiveis.length
      ? `variante desconhecida: "${nome}" — este fluxo tem: ${disponiveis.join(', ')}`
      : 'este fluxo não declara variantes de prompt (`variantes` no flow.json)');
  }
  return {
    ...def,
    variante: nome,
    fases: def.fases.map((f) => (f.variantes?.[nome]
      ? { ...f, prompt: f.variantes[nome] }
      : f)),
  };
}

/**
 * O clipe de encerramento deste fluxo: o da variante, se o domínio declarou um
 * para ela; senão o `padrao`; senão nenhum (e o motor usa o default dele).
 */
export function ctaDaDefinicao(def: FlowDef): string | undefined {
  if (!def.cta) return undefined;
  return (def.variante ? def.cta[def.variante] : undefined) ?? def.cta.padrao;
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
