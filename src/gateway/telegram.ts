// Adaptador Telegram (grammy). ÚNICO arquivo do gateway que conhece a API do
// Telegram — tudo que é política (allowlist, corte, log) vive em `rotear`,
// que é pura e testável sem grammy. `criarBot` é só a fiação.
import { Bot, InputFile } from 'grammy';
import type { Config } from '../config.js';
import { comandoDeAnexo, type BaixarAnexo } from './midia.js';
import { ehPingDePareamento, emPareamento, mensagemDePareamento } from './pareamento.js';

/** Telegram rejeita qualquer mensagem acima de 4096 chars (UTF-16 code units) com
 * "400: Bad Request: message is too long". `limit` fica um pouco abaixo disso de propósito —
 * Telegram conta entidades/formatação além do texto puro, e isso dá margem sem complicar a conta.
 *
 * Portado do v1 (inemaccvbot/src/reply.ts, splitForTelegram) — o corte de 4096 é conhecimento
 * duro já pago em produção; não reescrever do zero.
 *
 * Estratégia de corte, em ordem de preferência (nunca perde caracteres, nunca gera chunk vazio):
 *   1. quebra em fronteira de parágrafo/linha (`\n`);
 *   2. se uma "linha" sozinha ainda estoura o limite, quebra em espaços;
 *   3. se um único token (sem espaço) ainda estoura o limite, corta na marra (último recurso).
 */
/** Teto de UMA mensagem. Exportado porque a entrega precisa do MESMO número:
 * decidir "isto cabe numa mensagem?" com um valor próprio criaria duas fontes
 * de verdade para o mesmo limite do Telegram. */
export const LIMITE_MENSAGEM = 4_000;

export function cortar(texto: string, limite = LIMITE_MENSAGEM): string[] {
  if (texto.length <= limite) return texto.length ? [texto] : [];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) { chunks.push(current); current = ''; }
  };

  const lines = texto.split('\n');
  lines.forEach((line, i) => {
    const sep = i < lines.length - 1 ? '\n' : '';
    let piece = line + sep;

    while (piece.length > 0) {
      if (current.length + piece.length <= limite) {
        current += piece;
        piece = '';
        continue;
      }

      if (current.length > 0) { flush(); continue; }

      if (piece.length <= limite) { current = piece; piece = ''; continue; }

      const spaceIdx = piece.lastIndexOf(' ', limite);
      if (spaceIdx > 0) {
        current = piece.slice(0, spaceIdx + 1);
        piece = piece.slice(spaceIdx + 1);
        flush();
        continue;
      }

      current = piece.slice(0, limite);
      piece = piece.slice(limite);
      flush();
    }
  });
  flush();

  return chunks;
}

/** Mensagem que o chat vê quando `aoComando` explode. Genérica de propósito —
 * o texto real do erro (que pode conter caminho interno, stack, etc.) nunca sai
 * daqui; só vai pro log. */
const MENSAGEM_ERRO_GENERICA = 'Deu erro por aqui. Já ficou registrado, tenta de novo daqui a pouco.';

/** Política completa de roteamento de uma mensagem recebida, pura — sem grammy.
 * chat fora da allowlist: [] + log da rejeição, `aoComando` nunca chamado (spec §9,
 * esse log é o único rastro de uma tentativa não autorizada).
 * chat permitido: chama `aoComando`, corta a resposta, devolve os pedaços.
 * `aoComando` lançando: um pedaço genérico (nunca o erro verbatim) + log do erro real. */
export async function rotear(
  entrada: { chatId: number; texto: string },
  deps: {
    permitido: (chatId: number) => boolean;
    aoComando: (chatId: number, texto: string) => Promise<string>;
    log: (m: string) => void;
    /** Tenta parear e devolve a resposta, ou `null` quando o bot JÁ tem dono.
     *  Ausente (ou devolvendo `null`) é o caso normal, e aí a rejeição é
     *  exatamente a de sempre: silêncio. É o que garante que um bot já pareado
     *  nunca ecoe chat id para estranho. */
    parear?: (chatId: number) => string | null;
  },
): Promise<string[]> {
  const { chatId, texto } = entrada;

  if (!deps.permitido(chatId)) {
    if (deps.parear && ehPingDePareamento(texto)) {
      const resposta = deps.parear(chatId);
      if (resposta !== null) return cortar(resposta);
    }
    deps.log(`gateway: mensagem rejeitada — chat ${chatId} fora da allowlist`);
    return [];
  }

  try {
    const resposta = await deps.aoComando(chatId, texto);
    return cortar(resposta);
  } catch (erro) {
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    deps.log(`gateway: erro ao processar comando do chat ${chatId}: ${detalhe}`);
    return [MENSAGEM_ERRO_GENERICA];
  }
}

/** Envia os `pedacos` SEQUENCIALMENTE, aguardando cada um antes de disparar o
 * próximo. Em paralelo (`pedacos.map(enviar)` sem await) o Telegram entrega
 * fora de ordem, e uma resposta longa chega embaralhada no chat — por isso o
 * `for...of` com `await`, nunca `Promise.all`/`map`. Único lugar que drena
 * pedaços; `criarBot` e `Transporte.responder` chamam esta função em vez de
 * reimplementar o loop cada um por conta própria. */
export async function enviarPedacos(
  enviar: (texto: string) => Promise<void>,
  pedacos: string[],
): Promise<void> {
  for (const pedaco of pedacos) {
    await enviar(pedaco);
  }
}

/** Seam usado por tarefas futuras (ex.: notificar conclusão de job) sem que
 * quem chama precise conhecer grammy. */
export interface Transporte {
  responder(chatId: number, texto: string): Promise<void>;
  /** Envia um arquivo do disco como documento. Opcional: um transporte de teste
   * que só verifica texto não precisa implementar. */
  enviarDocumento?(chatId: number, caminho: string): Promise<void>;
}

/**
 * Anexo recebido: baixa e transforma a legenda em comando. Pura em relação ao
 * Telegram (o download é injetado), então testável sem rede.
 *
 * Sem legenda, NÃO tenta adivinhar o que fazer com o arquivo: confirma o
 * recebimento e devolve o caminho, que é o que torna `thumb <caminho>` (e
 * qualquer skill que aceite caminho) alcançável.
 */
export async function rotearAnexo(
  entrada: { chatId: number; fileId: string; nomeOriginal: string; legenda: string },
  deps: {
    permitido: (chatId: number) => boolean;
    baixar: (fileId: string, nomeOriginal: string) => Promise<string>;
    aoComando: (chatId: number, texto: string) => Promise<string>;
    log: (m: string) => void;
  },
): Promise<string[]> {
  if (!deps.permitido(entrada.chatId)) {
    deps.log(`gateway: anexo rejeitado — chat ${entrada.chatId} fora da allowlist`);
    return [];
  }

  let caminho: string;
  try {
    caminho = await deps.baixar(entrada.fileId, entrada.nomeOriginal);
  } catch (erro) {
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    deps.log(`gateway: falha ao baixar anexo do chat ${entrada.chatId}: ${detalhe}`);
    // Genérica de propósito: a URL da API do Telegram carrega o token no path.
    return ['não consegui baixar esse arquivo.'];
  }

  const comando = comandoDeAnexo(entrada.legenda, caminho);
  if (!comando) return cortar(`recebi o arquivo: ${caminho}`);

  try {
    return cortar(await deps.aoComando(entrada.chatId, comando));
  } catch (erro) {
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    deps.log(`gateway: erro ao processar anexo do chat ${entrada.chatId}: ${detalhe}`);
    return [MENSAGEM_ERRO_GENERICA];
  }
}

/** Único ponto de fiação com grammy. Não tem política — só liga `rotear` ao
 * `bot.on('message:text')` e ao envio dos pedaços. */
export function criarBot(
  cfg: Config,
  deps: {
    aoComando: (chatId: number, texto: string) => Promise<string>;
    log?: (m: string) => void;
    /** Ausente: o bot ignora anexos (é o comportamento da etapa 1). */
    baixarAnexo?: BaixarAnexo;
    /** Grava a allowlist nova onde ela sobrevive a um restart (o `.env`).
     *  Injetada porque o gateway não conhece disco — e porque o teste do
     *  pareamento não pode escrever no `.env` de ninguém. */
    persistirAllowlist?: (ids: number[]) => void;
    /** Depois de responder — é onde os avisos que o COMANDO empilhou saem.
     *  Sem isto, `/dados` anuncia a reentrega e o material nunca chega. */
    aposResponder?: () => Promise<void>;
  },
): { bot: Bot; transporte: Transporte } {
  const bot = new Bot(cfg.botToken);

  const permitido = (chatId: number): boolean => cfg.chatsPermitidos.includes(chatId);
  // Sem `log` injetado, fica em silêncio (no-op) em vez de vazar pro `console` —
  // uma fiação esquecida assim é silenciosa nos testes, não barulhenta no sink errado.
  const log = deps.log ?? ((): void => {});

  // O estado é consultado A CADA mensagem, não uma vez na construção: parear na
  // construção deixaria a porta aberta para sempre, e o SEGUNDO /ping tomaria o
  // bot do primeiro. `null` significa "não estou em pareamento" e devolve o
  // fluxo à rejeição normal.
  const parear = !deps.persistirAllowlist
    ? undefined
    : (chatId: number): string | null => {
        if (!emPareamento(cfg.chatsPermitidos)) return null;
        // MEMÓRIA PRIMEIRO, e in-place: `permitido` fecha sobre ESTE array, e
        // reatribuir `cfg.chatsPermitidos` deixaria o closure vendo o antigo —
        // o bot diria "pareado" e rejeitaria a mensagem seguinte até reiniciar.
        cfg.chatsPermitidos.splice(0, cfg.chatsPermitidos.length, chatId);
        log(`gateway: pareado — chat ${chatId} virou dono do bot`);
        try {
          deps.persistirAllowlist?.(cfg.chatsPermitidos);
        } catch (erro) {
          // Disco read-only não pode custar a sessão: o chat continua valendo
          // até o próximo restart, e o log diz o que pôr no .env na mão.
          const detalhe = erro instanceof Error ? erro.message : String(erro);
          log(`gateway: pareado em memória, mas falhei ao gravar o .env (${detalhe}) — ponha ALLOWED_CHAT_IDS=${chatId} à mão`);
        }
        return mensagemDePareamento(chatId);
      };

  /** O dreno nunca derruba o handler: perder um aviso é ruim, ficar surdo é
   *  pior — a mesma regra do §8 que vale no dreno do worker. */
  const soltarPendentes = async (): Promise<void> => {
    if (!deps.aposResponder) return;
    try {
      await deps.aposResponder();
    } catch (erro) {
      log(`gateway: dreno pós-resposta falhou: ${(erro as Error).message}`);
    }
  };

  bot.on('message:text', async (ctx) => {
    const pedacos = await rotear(
      { chatId: ctx.chat.id, texto: ctx.message.text },
      { permitido, aoComando: deps.aoComando, log, parear },
    );
    await enviarPedacos(async (pedaco) => { await ctx.reply(pedaco); }, pedacos);
    await soltarPendentes();
  });

  // Documento, vídeo e áudio entram pelo MESMO caminho: o que interessa é o
  // `file_id` e o nome, e o resto é decisão da skill.
  if (deps.baixarAnexo) {
    const baixar = deps.baixarAnexo;
    bot.on(['message:document', 'message:video', 'message:audio', 'message:voice'], async (ctx) => {
      const m = ctx.message;
      const arquivo = m?.document ?? m?.video ?? m?.audio ?? m?.voice;
      if (!arquivo) return;
      const nome =
        (m.document?.file_name ?? m.audio?.file_name)
        ?? `anexo.${m.video ? 'mp4' : m.voice ? 'ogg' : 'bin'}`;
      const pedacos = await rotearAnexo(
        { chatId: ctx.chat.id, fileId: arquivo.file_id, nomeOriginal: nome, legenda: m.caption ?? '' },
        { permitido, baixar, aoComando: deps.aoComando, log },
      );
      await enviarPedacos(async (pedaco) => { await ctx.reply(pedaco); }, pedacos);
      await soltarPendentes();
    });
  }

  const transporte: Transporte = {
    async responder(chatId: number, texto: string): Promise<void> {
      await enviarPedacos(async (pedaco) => { await bot.api.sendMessage(chatId, pedaco); }, cortar(texto));
    },
    async enviarDocumento(chatId: number, caminho: string): Promise<void> {
      await bot.api.sendDocument(chatId, new InputFile(caminho));
    },
  };

  return { bot, transporte };
}
