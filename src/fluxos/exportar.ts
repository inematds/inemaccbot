// Export/import de fluxo (spec §7.6).
//
// **Pré-requisito da etapa 5, não melhoria futura.** Sem isso, migrar o estado
// de arquivo JSON (v1) para tabela (v2) é uma porta sem volta: se o motor novo
// se mostrar errado no meio de um `P#16`, não há como levar o progresso de volta
// nem para outro banco. Com o par export/import, esta etapa deixa de ser
// irreversível.
//
// O export carrega a DEFINIÇÃO CONGELADA junto: importar num banco onde o
// `flow.json` do disco já mudou tem que reconstruir o fluxo como ele era, não
// como o disco está hoje.
import type { EstadoFluxos, Fase, Fluxo } from './estado.js';

export interface FluxoExportado {
  formato: 1;
  fluxo: Omit<Fluxo, 'id'> & { id_original: number };
  fases: Omit<Fase, 'fluxo_id'>[];
}

export function exportarFluxo(estado: EstadoFluxos, fluxoId: number): FluxoExportado {
  const fluxo = estado.obter(fluxoId);
  if (!fluxo) throw new Error(`fluxo ${fluxoId} não existe`);
  const { id, ...resto } = fluxo;
  return {
    formato: 1,
    fluxo: { ...resto, id_original: id },
    fases: estado.fases(fluxoId).map(({ fluxo_id, ...f }) => f),
  };
}

/**
 * Reconstrói o fluxo. O id NOVO é do banco de destino — carregar o id original
 * seria colidir com o que já existe lá; ele fica registrado no export só para
 * rastreabilidade.
 *
 * Os `job_id` das fases NÃO são reconectados: aqueles jobs pertencem ao banco de
 * origem. Uma fase que estava `rodando` volta como `pendente`, e a rede de
 * segurança do boot (`reenfileirarOrfas`) a reenfileira — que é exatamente o
 * comportamento certo para trabalho que ficou para trás.
 */
export function importarFluxo(estado: EstadoFluxos, dados: unknown): Fluxo {
  if (typeof dados !== 'object' || dados === null) throw new Error('import: payload inválido');
  const d = dados as Partial<FluxoExportado>;
  if (d.formato !== 1) throw new Error(`import: formato ${String(d.formato)} desconhecido`);
  if (!d.fluxo || !Array.isArray(d.fases)) throw new Error('import: faltam "fluxo" ou "fases"');

  const f = d.fluxo;
  const novo = estado.criar({
    tipo: f.tipo,
    prefixo: f.prefixo,
    slug: f.slug,
    assunto: f.assunto,
    versao: f.versao,
    chatId: f.chat_id,
    // A definição vem do EXPORT, nunca do disco: o `flow.json` de hoje pode já
    // estar diferente do que este fluxo congelou.
    definicao: JSON.parse(f.definicao_json) as never,
    hash: f.definicao_hash,
  });

  estado.criarFases(
    novo.id,
    d.fases.map((fase) => ({
      fase: fase.fase, alvo: fase.alvo, escopo: fase.escopo, ordem: fase.ordem,
    })),
  );
  for (const fase of d.fases) {
    estado.atualizarFase(novo.id, fase.fase, fase.alvo, {
      estado: fase.estado === 'rodando' ? 'pendente' : fase.estado,
      tentativas: fase.tentativas,
      dados: fase.dados,
      erro: fase.erro,
      job_id: null,
    });
  }
  estado.recalcularStatus(novo.id);
  return novo;
}
