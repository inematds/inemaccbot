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
import { resolverDestino } from '../dominio/destinos.js';
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
  return JSON.stringify({
    ...base,
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
