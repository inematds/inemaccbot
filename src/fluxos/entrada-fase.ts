// Como cada FASE vira o `input` de um job.
//
// §3.1: "uma fase não executa nada — descreve qual job enfileirar". Este arquivo
// é essa tradução, e é o único lugar onde o runtime precisa saber que existe
// mais de um tipo de tarefa de fase.
//
// A regra que o §3.2 impõe e que está implementada aqui: **o domínio diz para
// QUEM, o bot sabe ONDE.** O `flow.json` referencia o canal por nome
// (`lives21`); quem resolve isso para um caminho no disco é o registry de
// destinos do bot. Um `flow.json` com caminho embutido seria uma cópia
// divergente da lista de canais esperando para envelhecer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolverDestino } from '../dominio/destinos.js';
import { primeiraFala } from '../dominio/roteiro.js';
import type { FaseDef, FlowDef } from '../dominio/flow.js';
import type { Fluxo } from './estado.js';

export interface ContextoEntrada {
  fluxo: Fluxo;
  def: FlowDef;
  fase: FaseDef;
  alvo: string;
  /** `dados` da fase anterior daquele alvo — normalmente um caminho de arquivo. */
  anterior?: string | null;
  raizArtefatos: string;
  projetosDir: string;
  /** Repo de domínio deste fluxo (`config/fluxos.json`). Sem ele a fase de
   * texto não recebe `{{pasta}}` — ver `pastaTextos`. */
  repoDominio?: string;
  /** Públicos REAIS deste fluxo, já filtrados por `| alvos=`. Vira `{{publicos}}`. */
  alvosDoFluxo?: string[];
}

/**
 * Onde a fase de texto grava um arquivo por público.
 *
 * O bot DITA este caminho, e isso foi pago em produção: o prompt pedia um
 * caminho relativo (`textos/<slug-do-assunto>/`) e o job rodava com
 * `cwd: homedir()`, então o agente escolhia o repo e o slug sozinho — o A#1
 * gravou os 12 textos e o commit no repo do `promoclub`, não no do
 * `promoavatar`. Caminho escolhido pelo agente é caminho que o portão não
 * consegue reencontrar.
 *
 * `A1` e não o slug do assunto porque o portão precisa achar a pasta sabendo só
 * o fluxo, e dois fluxos com o mesmo assunto não podem colidir.
 */
export function pastaTextos(repoDominio: string, fluxo: Fluxo): string {
  return `${repoDominio}/textos/${fluxo.prefixo}${fluxo.id}`;
}

/**
 * Título do vídeo no estúdio: `P16-mulheres-v1`.
 *
 * CURTO de propósito, e isso foi pago em produção: o título longo truncava no
 * HeyGen, e o download — que casa PELO TÍTULO — nunca encontrava o vídeo. É
 * também a chave de idempotência da fase de download (§2.5).
 */
export function tituloEstudio(fluxo: Fluxo, alvo: string): string {
  return `${fluxo.prefixo}${fluxo.id}-${alvo}-v${fluxo.versao}`;
}

/** O `.mp4` que a fase de download grava, e que a fase de reel consome. */
export function caminhoAvatar(raizArtefatos: string, fluxo: Fluxo, alvo: string): string {
  return `${raizArtefatos}/fluxos/${fluxo.prefixo}${fluxo.id}/${tituloEstudio(fluxo, alvo)}.mp4`;
}

export function montarInput(ctx: ContextoEntrada): string {
  const { fluxo, def, fase, alvo } = ctx;
  const dadosAlvo = alvo ? def.alvos[alvo] ?? {} : {};
  const base = {
    fluxo: { ref: `${fluxo.prefixo}#${fluxo.id}`, fase: fase.id, alvo, ...dadosAlvo },
  };

  if (fase.tarefa === 'heygen.baixar') {
    return JSON.stringify({
      ...base,
      titulo: tituloEstudio(fluxo, alvo),
      destino: caminhoAvatar(ctx.raizArtefatos, fluxo, alvo),
      // A janela de poll vem da DEFINIÇÃO CONGELADA, não de um default do
      // worker: sem o `timeout` viajando com o job, um vídeo que a pessoa nunca
      // gera é pollado para sempre — `reagendar` não gasta tentativa, então a
      // fase nunca falharia e o `/status` diria "rodando" indefinidamente.
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  // A fase `gerar` (opção `| api`): o bot manda O QUE falar, com que rosto e
  // com que voz. O TÍTULO é o mesmo que a fase `baixar` vai procurar — é o que
  // dispensa carregar `video_id` de uma fase para a outra, e o que faz a fase
  // seguinte não precisar saber se o vídeo veio da API ou da mão de alguém.
  if (fase.tarefa === 'heygen.gerar') {
    return JSON.stringify({
      ...base,
      titulo: tituloEstudio(fluxo, alvo),
      // A FALA sai do MESMO arquivo que o portão manda no chat — se o texto que
      // a pessoa revisaria e o que o avatar fala pudessem divergir, o portão
      // deixaria de ser revisão de nada.
      texto: falaDoAlvo(ctx.repoDominio, fluxo, alvo),
      // O alvo pode sobrescrever avatar e voz (um público com outra voz não
      // deveria obrigar a criar outro fluxo).
      avatarId: dadosAlvo.avatar_id ?? def.avatar_id ?? '',
      voiceId: dadosAlvo.voice_id ?? def.voice_id ?? '',
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  // Skill do catálogo (a última fase do promoclub é a MESMA skill `reel` que o
  // usuário dispara no chat — fluxo é cliente da fila como qualquer um, §3.2).
  if (fase.kind === 'agent' && !fase.prompt_texto) {
    const arquivo = ctx.anterior ?? '';
    const canal = dadosAlvo.canal;
    const destino = canal ? resolverDestino(canal, ctx.projetosDir) : null;
    return JSON.stringify({
      ...base,
      entrada: [arquivo, instrucaoExtra(fase, dadosAlvo)].filter(Boolean).join(' '),
      ...(destino ? { destino } : {}),
    });
  }

  // Fase de agente com prompt próprio (`fluxo-agente`, `fluxo-navegador`).
  //
  // `pasta` entra DENTRO de `fluxo` porque `contextoDeFase` (fila/skills.ts)
  // promove a variável todo campo string daí — é como `canal` e `gatilho`
  // chegam ao prompt, e evita um caminho especial só para esta.
  // `publicos` existe porque o filtro de alvos NÃO chegava ao prompt: o A#4
  // nasceu com 1 alvo e o agente escreveu 12 arquivos, já que o texto dizia
  // "para TODOS os públicos do pipeline". O fluxo sabia; o prompt não.
  const extra: Record<string, string> = {
    // `repo` vira o `cwd` do processo do agente (ver `contextoDeFase`). Sem
    // isto o job roda em `homedir()` e NÃO enxerga as skills de projeto do
    // domínio: o A#5 falhou duas vezes com "skill inemaclub-textos não
    // encontrada" porque ela mora em `<repo>/.claude/skills/`. É também o
    // diretório onde o prompt manda commitar.
    ...(ctx.repoDominio ? { repo: ctx.repoDominio, pasta: pastaTextos(ctx.repoDominio, fluxo) } : {}),
    ...(ctx.alvosDoFluxo?.length ? { publicos: ctx.alvosDoFluxo.join(', ') } : {}),
  };
  return JSON.stringify({
    ...base,
    ...(Object.keys(extra).length ? { fluxo: { ...base.fluxo, ...extra } } : {}),
    entrada: fluxo.assunto,
    ...(fase.prompt_texto ? { prompt_texto: fase.prompt_texto } : {}),
    ...(alvo ? { titulo: tituloEstudio(fluxo, alvo) } : {}),
  });
}

/**
 * O que o domínio quer dizer à skill além do arquivo. Vem do `flow.json` (campo
 * `entrega` da fase, com `{gatilho}`/`{alvo}` resolvidos) — não daqui: a
 * headline de capa é decisão de quem entende do público, não do bot.
 */
function instrucaoExtra(fase: FaseDef, dadosAlvo: Record<string, string | undefined>): string {
  if (!fase.entrega) return '';
  return fase.entrega.replace(/\{(\w+)\}/g, (bruto, chave: string) => dadosAlvo[chave] ?? bruto);
}

/**
 * A FALA do roteiro daquele alvo — o que o avatar vai dizer.
 *
 * Lê o MESMO arquivo que o portão manda no chat (`<pasta>/<alvo>.md`), e extrai
 * a mesma seção. Se o texto revisado no portão e o texto falado pudessem
 * divergir, o portão deixaria de ser revisão de coisa nenhuma.
 *
 * Vazio quando o arquivo não existe ou não tem `### FALA`: quem reclama é a
 * tarefa `heygen.gerar`, com o título no erro — melhor que um vídeo mudo, e
 * melhor que uma exceção sem contexto na montagem do input.
 */
function falaDoAlvo(repo: string | undefined, fluxo: Fluxo, alvo: string): string {
  if (!repo || !alvo) return '';
  try {
    return primeiraFala(readFileSync(join(pastaTextos(repo, fluxo), `${alvo}.md`), 'utf8')) ?? '';
  } catch {
    return '';
  }
}
