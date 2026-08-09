// Primeiro contato: com a allowlist em `0`, o primeiro /ping cadastra o chat.
// Decisão do dono (spec 2026-08-08), tomada com o risco na mesa: quem chegar
// primeiro leva o bot. O que dava pra estreitar sem contrariar a decisão está
// estreitado aqui — só texto, só /ping, só no estado sentinela.

/** `0` não é id de chat nenhum no Telegram, por isso serve de sentinela sem
 *  ambiguidade: `ALLOWED_CHAT_IDS=0` significa "ainda não tem dono". */
export const SENTINELA_PAREAMENTO = 0;

/** Exatamente `[0]`. `[0,123]` é allowlist real com lixo dentro, não convite. */
export function emPareamento(chatsPermitidos: number[]): boolean {
  return chatsPermitidos.length === 1 && chatsPermitidos[0] === SENTINELA_PAREAMENTO;
}

/** Só `/ping` pareia. Em grupo o Telegram manda `/ping@nome_do_bot`, então o
 *  sufixo é aceito; qualquer argumento depois do comando, não. */
export function ehPingDePareamento(texto: string): boolean {
  return /^\/ping(@[A-Za-z0-9_]+)?$/.test(texto.trim());
}

export function mensagemDePareamento(chatId: number): string {
  return [
    `Pareado. Este chat (id ${chatId}) agora é o dono do bot.`,
    '',
    'Gravei em ALLOWED_CHAT_IDS no .env. Para trocar de dono depois: ponha',
    'ALLOWED_CHAT_IDS=0 de volta, reinicie, e mande /ping do chat novo.',
  ].join('\n');
}
