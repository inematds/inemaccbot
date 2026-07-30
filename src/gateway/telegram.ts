// Adaptador Telegram (grammy). ÚNICO arquivo do gateway que conhece a API do
// Telegram — tudo que é política (allowlist, corte, log) vive em `rotear`,
// que é pura e testável sem grammy. `criarBot` é só a fiação.
import { Bot } from 'grammy';
import type { Config } from '../config.js';

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
export function cortar(texto: string, limite = 4000): string[] {
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

export interface Roteador {
  chatPermitido(chatId: number): boolean;
}

/** Política completa de roteamento de uma mensagem recebida, pura — sem grammy.
 * chat fora da allowlist: [] + log da rejeição, `aoComando` nunca chamado (spec §9,
 * esse log é o único rastro de uma tentativa não autorizada).
 * chat permitido: chama `aoComando`, corta a resposta, devolve os pedaços.
 * `aoComando` lançando: um pedaço genérico (nunca o erro verbatim) + log do erro real. */
export async function rotear(
  entrada: { chatId: number; texto: string },
  deps: { permitido: (chatId: number) => boolean; aoComando: (chatId: number, texto: string) => Promise<string>; log: (m: string) => void },
): Promise<string[]> {
  const { chatId, texto } = entrada;

  if (!deps.permitido(chatId)) {
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

/** Seam usado por tarefas futuras (ex.: notificar conclusão de job) sem que
 * quem chama precise conhecer grammy. */
export interface Transporte {
  responder(chatId: number, texto: string): Promise<void>;
}

/** Único ponto de fiação com grammy. Não tem política — só liga `rotear` ao
 * `bot.on('message:text')` e ao envio dos pedaços. */
export function criarBot(
  cfg: Config,
  deps: { aoComando: (chatId: number, texto: string) => Promise<string> },
): { bot: Bot; transporte: Transporte } {
  const bot = new Bot(cfg.botToken);

  const permitido = (chatId: number): boolean => cfg.chatsPermitidos.includes(chatId);
  const log = (m: string): void => { console.error(m); };

  bot.on('message:text', async (ctx) => {
    const pedacos = await rotear(
      { chatId: ctx.chat.id, texto: ctx.message.text },
      { permitido, aoComando: deps.aoComando, log },
    );
    for (const pedaco of pedacos) {
      await ctx.reply(pedaco);
    }
  });

  const transporte: Transporte = {
    async responder(chatId: number, texto: string): Promise<void> {
      for (const pedaco of cortar(texto)) {
        await bot.api.sendMessage(chatId, pedaco);
      }
    },
  };

  return { bot, transporte };
}
