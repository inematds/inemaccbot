// Montagem do prompt de uma skill a partir do arquivo do repo + variáveis.
//
// Spec §9: "o prompt vem de ARQUIVO, não de texto do usuário — o que o usuário
// fornece entra como VARIÁVEL, nunca como instrução crua". Este arquivo é o que
// torna essa frase verificável:
//   - o template é dono da estrutura e das instruções;
//   - a entrada do usuário é saneada e injetada só onde o template marcou;
//   - um placeholder não preenchido é ERRO, nunca um `{{saida}}` literal
//     chegando ao agente (que então inventaria um caminho de saída).

/** Controle ASCII menos `\n` e `\t`: em prompt eles só servem pra escapar de
 * bloco/quebrar o parsing de quem lê o log. Escrito com escapes de propósito —
 * bytes de controle literais no fonte fazem até o `grep` tratar o arquivo como
 * binário. */
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export const LIMITE_VARIAVEL = 2_000;

/**
 * Saneia UM valor antes de ele entrar no prompt. Não tenta "escapar" markdown —
 * escaping é ilusão de segurança com LLM. O que faz de verdade:
 *  - remove caracteres de controle;
 *  - normaliza CRLF;
 *  - corta no limite (um "assunto" de 50 KB é abuso ou acidente, e nos dois
 *    casos estoura o contexto do agente antes de fazer algo útil).
 */
export function sanitizarVariavel(valor: string, limite = LIMITE_VARIAVEL): string {
  const limpo = String(valor ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLE, '')
    .trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

/**
 * Substitui `{{chave}}` pelos valores dados. Falha se sobrar placeholder — o
 * modo de falha oposto (deixar passar) é o pior: o agente receberia a instrução
 * "grave em {{saida}}" e escolheria um caminho qualquer, que ninguém encontra.
 * Também falha se uma variável fornecida não aparecer no template: isso sempre
 * significa template e chamador fora de sincronia.
 */
export function renderizarPrompt(template: string, vars: Record<string, string>): string {
  const usadas = new Set<string>();
  const saida = template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (bruto, chave: string) => {
    const v = vars[chave];
    if (v === undefined) return bruto; // fica para a checagem de sobra, abaixo
    usadas.add(chave);
    return sanitizarVariavel(v);
  });

  const sobrando = [...saida.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1]);
  if (sobrando.length) {
    throw new Error(`prompt: placeholder sem valor: ${[...new Set(sobrando)].join(', ')}`);
  }
  const naoUsadas = Object.keys(vars).filter((k) => !usadas.has(k));
  if (naoUsadas.length) {
    throw new Error(`prompt: variável fornecida que o template não usa: ${naoUsadas.join(', ')}`);
  }
  return saida;
}
