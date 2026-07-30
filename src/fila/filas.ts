// Classes de recurso do sistema (spec §2.3) — UMA fonte de verdade.
//
// Isto morava em dois lugares: `CONCORRENCIAS` no index.ts (quem sobe os
// workers) e uma constante `FILAS` própria no gateway/comandos.ts (quem monta o
// `/fila`). Duas listas para o mesmo fato: acrescentar uma fila ia deixá-la
// invisível nas métricas até alguém notar. Como o gateway não pode importar do
// index.ts (importar para cima quebra as fronteiras do §4), a lista desce para
// cá — a camada que ambos já podem ler.
import type { Fila } from './types.js';

export const CONCORRENCIAS: Record<Fila, number> = {
  render: 1,
  navegador: 1,
  texto: 2,
  io: 10,
  cpu: 1,
};

/** Ordem estável — é a ordem em que o `/fila` lista, e ela não deve dançar. */
export const FILAS = Object.keys(CONCORRENCIAS) as Fila[];

export function ehFila(nome: string): nome is Fila {
  return Object.hasOwn(CONCORRENCIAS, nome);
}
