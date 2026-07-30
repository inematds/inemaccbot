// Redação de texto que sai do sistema (mensagem de erro de job, resultado).
//
// Por que existe (risco 3 do handoff): `job.erro` vai VERBATIM para o chat. Com
// `http.get`/`ffmpeg.thumb` isso era inofensivo — a mensagem de erro tinha uma
// URL e um código de saída. No instante em que um job `kind=agent` falha, o erro
// passa a ser stderr de um `claude -p`: prompt inteiro, caminhos absolutos do
// disco, variáveis de ambiente e, no pior caso, um token. Spec §9: segredos
// mascarados em log e em mensagem de erro.
//
// A decisão de desenho é aplicar isto num ÚNICO ponto de saída (o worker, antes
// de gravar) em vez de confiar que cada tarefa se comporte — uma tarefa nova
// esquecendo de redigir é exatamente o tipo de falha silenciosa que este projeto
// já pagou uma vez.

/** Token do BotFather: `<8+ dígitos>:<35 chars base64url>`. Vale para qualquer
 * bot, não só o nosso — o padrão é reconhecível sem conhecer o valor. */
// Sem `\b` na frente de propósito: o token aparece colado no prefixo da URL
// (`…/bot1234567890:AA…`), e ali não existe fronteira de palavra entre `t` e `1`.
const TOKEN_TELEGRAM = /\d{8,}:[A-Za-z0-9_-]{30,}/g;

/** `CHAVE=valor` / `CHAVE: valor` onde o nome cheira a segredo. O valor é comido
 * até o primeiro espaço ou aspas — o suficiente para o formato de env e de JSON. */
const ATRIBUICAO_SECRETA =
  /\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|APIKEY)[A-Z0-9_]*)\s*[:=]\s*("?)([^\s"',}]+)\2/gi;

export const MASCARA = '«redigido»';

export interface OpcoesRedacao {
  /** Valores literais a mascarar sempre (o BOT_TOKEN configurado, por exemplo). */
  segredos?: string[];
  /** Trocado por `~` na saída — o home do usuário aparece em todo caminho. */
  home?: string;
  /** Teto de caracteres. O que sobra vira `…`. */
  limite?: number;
}

/**
 * Nunca lança: é chamada no caminho de FALHA, e uma exceção aqui trocaria uma
 * mensagem ruim por nenhuma mensagem (§8: silêncio nunca é estado válido).
 */
export function redigir(texto: string, opts: OpcoesRedacao = {}): string {
  let saida = String(texto ?? '');

  // Literais primeiro: são o que sabemos com certeza que é segredo, e mascará-los
  // antes evita que um deles sobreviva por não casar com nenhum padrão.
  for (const s of opts.segredos ?? []) {
    if (!s || s.length < 8) continue; // valor curto demais casaria com texto comum
    saida = saida.split(s).join(MASCARA);
  }

  saida = saida.replace(TOKEN_TELEGRAM, MASCARA);
  saida = saida.replace(ATRIBUICAO_SECRETA, (_m, nome: string) => `${nome}=${MASCARA}`);

  if (opts.home && opts.home.length > 1) {
    saida = saida.split(opts.home).join('~');
  }

  const limite = opts.limite;
  if (limite !== undefined && saida.length > limite) {
    saida = `${saida.slice(0, Math.max(0, limite - 1))}…`;
  }
  return saida;
}

/** A redação usada quando não há config à mão (testes, caminhos de boot). */
export function redatorPadrao(opts: OpcoesRedacao = {}): (t: string) => string {
  return (t: string) => redigir(t, opts);
}
