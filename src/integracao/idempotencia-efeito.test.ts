// CONTRATO EXECUTÁVEL da regra §2.5 ("procure antes de criar").
//
// `jaConcluido` e `enfileirarSeNovo` já têm testes de unidade, mas nada provava
// que uma TAREFA de verdade consulta a idempotência antes de produzir um efeito
// externo — um autor de etapa 1 podia esquecer a checagem e a suíte inteira
// continuava verde. Este teste é a forma que se espera de TODA tarefa da etapa 1
// com efeito externo (HeyGen, upload, post): adote o resultado anterior se ele
// existir, e só crie se realmente não existir nada.
//
// A sutileza que este teste existe pra cobrir: no caminho de CRASH, a primeira
// tentativa nunca escreveu linha `done`, então `jaConcluido` sozinho NÃO acha
// nada. Por isso a tarefa também procura no SERVIÇO EXTERNO pelo nome
// determinístico derivado da `idem_key` (o `tituloCurto` do sistema real). É
// essa segunda busca que impede o efeito duplicado.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from '../fila/store.js';
import { Worker, type Tarefa } from '../fila/worker.js';

/** Serviço externo caro e NÃO idempotente — criar duas vezes custa duas vezes. */
class ServicoExterno {
  criados = 0;
  private readonly porTitulo = new Map<string, string>();

  criar(titulo: string): string {
    this.criados += 1;
    const id = `ext-${this.criados}`;
    this.porTitulo.set(titulo, id);
    return id;
  }

  /** "procure antes de criar": busca pelo nome determinístico. */
  buscar(titulo: string): string | undefined {
    return this.porTitulo.get(titulo);
  }
}

/** Nome determinístico derivado da idem_key — o papel do `tituloCurto` real. */
const tituloCurto = (idemKey: string): string => `job-${idemKey}`;

let dir: string;
let fila: FilaSqlite;
let servico: ServicoExterno;
let t = 1_000;

function tarefaComEfeito(aposEfeito: (id: string) => Promise<string>): Tarefa {
  return async (ctx) => {
    const job = ctx.job;
    const titulo = tituloCurto(job.idem_key!);

    // 1) o efeito já foi concluído numa tentativa anterior? adota o resultado.
    const anterior = ctx.fila.jaConcluido(job.idem_key!);
    if (anterior?.resultado) return anterior.resultado;

    // 2) sem linha `done` (crash antes do ack): procure no serviço externo.
    const existente = servico.buscar(titulo);
    if (existente) return existente;

    // 3) só agora crie.
    return aposEfeito(servico.criar(titulo));
  };
}

function novoWorker(dono: string, tarefa: Tarefa): Worker {
  return new Worker(fila, {
    fila: 'io', dono, concorrencia: 1, leaseSegundos: 60,
    tarefas: { efeito: tarefa },
    runners: {},
    promptDe: async () => { throw new Error('sem agente neste teste'); },
  }, () => t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  servico = new ServicoExterno();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('crash DEPOIS do efeito e ANTES do ack não duplica o efeito externo', async () => {
  const job = fila.enfileirar({
    fila: 'io', kind: 'function', tarefa: 'efeito', input: '',
    idem_key: 'P16/mulheres/render', max_tentativas: 3,
  });

  // Tentativa 1: cria o efeito e o processo "morre" logo em seguida — a tarefa
  // nunca resolve, então `concluir` nunca roda e o job fica `running`.
  const morreu = new Promise<string>(() => {});
  const wA = novoWorker('A', tarefaComEfeito(async () => morreu));
  void wA.passo();
  await new Promise((r) => setTimeout(r, 10));

  expect(servico.criados).toBe(1);
  expect(fila.obter(job.id)!.status).toBe('running');
  expect(fila.obter(job.id)!.resultado).toBeNull();     // nenhum ack aconteceu

  // Boot depois do crash: o lease vence e o job volta pra fila.
  t = 1_061;
  expect(fila.recuperarLeasesVencidos()).toEqual({ requeued: 1, failed: 0 });

  // Tentativa 2, noutra instância: tem que ADOTAR o efeito, não criar outro.
  const wB = novoWorker('B', tarefaComEfeito(async (id) => id));
  expect(await wB.passo()).toBe(true);

  expect(servico.criados).toBe(1);
  const d = fila.obter(job.id)!;
  expect(d.status).toBe('done');
  expect(d.resultado).toBe('ext-1');
});

it('reexecução DEPOIS de um done adota o resultado pela fila, sem tocar no serviço', async () => {
  fila.enfileirar({
    fila: 'io', kind: 'function', tarefa: 'efeito', input: '',
    idem_key: 'P17/pais/render', max_tentativas: 3,
  });
  await novoWorker('A', tarefaComEfeito(async (id) => id)).passo();
  expect(servico.criados).toBe(1);

  // Mesmo efeito pedido de novo (ex.: /refazer de uma fase já concluída).
  fila.enfileirar({
    fila: 'io', kind: 'function', tarefa: 'efeito', input: '',
    idem_key: 'P17/pais/render', max_tentativas: 3,
  });
  await novoWorker('A', tarefaComEfeito(async (id) => id)).passo();

  expect(servico.criados).toBe(1);
});
