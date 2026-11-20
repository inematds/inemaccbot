// De onde veio o pedido de um fluxo. Ver `gateway/espelho-v3.ts`.

/**
 * O pedido veio do v3? O v3 escreve a origem no próprio texto do pedido
 * ("Pedido original do Nei no openpcbotv3, job 134142", "Pedido #134783 do
 * Nei", "Complemento ... do pedido #134142, job #134159"). Pedido digitado no
 * chat do inemaccbot não traz nada disso.
 */
export function pedidoDoV3(assunto: string): boolean {
  return /openpcbotv3|\bv3\b.*\bjob\b|\bpedido\s*#\d+|\bjob\s*#\d+/i.test(assunto);
}
