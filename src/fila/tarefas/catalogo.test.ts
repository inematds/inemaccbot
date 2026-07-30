// Guarda do risco 2 do handoff: `ContextoTarefa.sinal` é obrigatório, e toda
// tarefa `function` precisa repassá-lo a tudo que ela gera (processo filho,
// `fetch`). Ignorá-lo reintroduz o bug do processo órfão que a etapa 1 fechou:
// o serviço sai, o filho é reparentado ao init e continua queimando CPU —
// escrevendo a saída de um job que o banco já marcou como `failed`.
//
// O buraco que este arquivo tapa: não havia teste que pegasse uma tarefa NOVA
// esquecendo do sinal. Os testes de `http.get` e `ffmpeg.thumb` cobriam cada um
// o SEU caso; uma terceira tarefa nasceria sem cobertura nenhuma.
//
// Por isso o teste varre o CATÁLOGO — quem acrescentar uma tarefa e esquecer do
// sinal descobre aqui, não em produção.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarTarefas } from './index.js';
import type { ContextoTarefa, Job } from '../types.js';

let raizMidia: string;

/** Entrada PLAUSÍVEL por tarefa: com input inválido a tarefa rejeitaria na
 * validação e o teste passaria sem nunca exercitar o sinal — verde pelo motivo
 * errado, que é exatamente o defeito que esta suíte já pagou uma vez. */
function inputDe(nome: string): string {
  switch (nome) {
    case 'http.get':
      // Endereço reservado para documentação (RFC 5737): mesmo se o sinal
      // falhasse, não há para onde a conexão ir.
      return JSON.stringify({ url: 'http://192.0.2.1/algo' });
    case 'ffmpeg.thumb': {
      const arq = join(raizMidia, 'v.mp4');
      writeFileSync(arq, 'nao-e-video-de-verdade');
      return JSON.stringify({ entrada: arq });
    }
    default:
      return '{}';
  }
}

function contexto(nome: string, sinal: AbortSignal): ContextoTarefa {
  const job = {
    id: 1, fila: 'io', kind: 'function', tarefa: nome, input: inputDe(nome),
    prioridade: 0, status: 'running', tentativas: 1, max_tentativas: 1,
    lease_ate: null, lease_owner: null, disponivel_em: 0, idem_key: null,
    flow_ref: null, chat_id: null, motor: null, modelo: null, esforco: null,
    resultado: null, erro: null, criado_em: 0, iniciado_em: null, terminado_em: null,
  } as Job;
  return {
    job,
    fila: undefined as unknown as ContextoTarefa['fila'],
    agora: () => 0,
    log: () => {},
    sinal,
  };
}

beforeEach(() => { raizMidia = mkdtempSync(join(tmpdir(), 'inemaccbot-catalogo-')); });
afterEach(() => rmSync(raizMidia, { recursive: true, force: true }));

describe('catálogo de tarefas function', () => {
  const nomes = Object.keys(criarTarefas({ raizMidia: '/tmp' }));

  it('tem tarefa (senão este teste passaria sem inspecionar nada)', () => {
    expect(nomes.length).toBeGreaterThan(0);
  });

  for (const nome of nomes) {
    // Asserção sobre a MENSAGEM, não só sobre "rejeitou": uma tarefa que ignora
    // o sinal também rejeita (arquivo inválido, rede fora), e um teste que só
    // exige rejeição passaria verde sobre a tarefa quebrada — o defeito que
    // esta suíte já pagou uma vez. Só quem repassou o sinal falha COM abort.
    it(`${nome}: repassa o sinal — abortado, falha dizendo que foi abort`, async () => {
      const tarefas = criarTarefas({ raizMidia });
      const t0 = Date.now();
      // A razão do abort carrega um marcador: quem repassou o sinal rejeita
      // com ela (o `fetch` propaga a razão verbatim) ou com a própria mensagem
      // de abort da tarefa (o ffmpeg traduz). Os dois casam com /abort/i, e
      // nenhuma outra causa de falha casaria.
      await expect(tarefas[nome]!(contexto(nome, AbortSignal.abort(new Error('ABORTADO pelo worker')))))
        .rejects.toThrow(/abort/i);
      expect(Date.now() - t0).toBeLessThan(2_000);
    });

    it(`${nome}: abortado NO MEIO do trabalho, para rápido`, async () => {
      const tarefas = criarTarefas({ raizMidia });
      const ctrl = new AbortController();
      const t0 = Date.now();
      const promessa = tarefas[nome]!(contexto(nome, ctrl.signal));
      setTimeout(() => ctrl.abort(new Error('serviço encerrando')), 20);
      await expect(promessa).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(2_000);
    });
  }
});
