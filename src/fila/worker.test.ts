// src/fila/worker.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';
import { FakeRunner } from './runner.js';
import { Worker } from './worker.js';
import type { Job } from './types.js';

let dir: string;
let fila: FilaSqlite;
let t = 1_000;

function novoWorker(over: Partial<ConstructorParameters<typeof Worker>[1]> = {}): Worker {
  return new Worker(fila, {
    fila: 'io', dono: 'A', concorrencia: 1, leaseSegundos: 60,
    tarefas: { ok: async () => 'pronto', explode: async () => { throw new Error('boom'); } },
    runners: { fake: new FakeRunner({ respostas: ['saida do agente'] }) },
    promptDe: (job: Job) => ({
      prompt: job.input, cwd: '/tmp',
      perfil: { motor: job.motor ?? 'fake', modelo: job.modelo ?? 'sonnet', esforco: job.esforco ?? 'low' },
      vars: {},
    }),
    ...over,
  }, () => t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('passo', () => {
  it('executa tarefa function e conclui o job', async () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'ok', input: '' });
    expect(await novoWorker().passo()).toBe(true);
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('done');
    expect(d.resultado).toBe('pronto');
  });

  it('executa job agent pelo runner do motor gravado no job', async () => {
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'qualquer', input: 'prompt',
      perfil: { motor: 'fake', modelo: 'opus', esforco: 'high' },
    });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.resultado).toBe('saida do agente');
  });

  it('falha o job quando a tarefa lança', async () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'explode', input: '' });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.status).toBe('failed');
    expect(fila.obter(job.id)!.erro).toContain('boom');
  });

  it('falha o job quando a tarefa não existe no catálogo', async () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'inexistente', input: '' });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.erro).toMatch(/tarefa desconhecida/i);
  });

  it('falha o job quando o motor não está registrado', async () => {
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '',
      perfil: { motor: 'motor-que-nao-existe', modelo: 'sonnet', esforco: 'low' },
    });
    await novoWorker().passo();
    expect(fila.obter(job.id)!.erro).toMatch(/motor desconhecido/i);
  });

  it('devolve false quando não há nada na fila', async () => {
    expect(await novoWorker().passo()).toBe(false);
  });

  it('entrega à tarefa um contexto com job, fila e relógio', async () => {
    let visto: { id: number; temFila: boolean; agora: number } | undefined;
    const w = novoWorker({
      tarefas: {
        espia: async (ctx) => {
          visto = { id: ctx.job.id, temFila: typeof ctx.fila.obter === 'function', agora: ctx.agora() };
          return 'ok';
        },
      },
    });
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'espia', input: '' });
    await w.passo();
    expect(visto).toEqual({ id: job.id, temFila: true, agora: 1_000 });
  });

  it('a tarefa consegue consultar jaConcluido pelo contexto (§2.5 alcançável)', async () => {
    const CHAVE = 'P#1/alvo/fase';
    const anterior = fila.enfileirarSeNovo({
      fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE,
    });
    fila.pegar('io', 60, 'w0');
    fila.concluir(anterior.job.id, 'artefato-antigo', 'w0');

    const w = novoWorker({
      tarefas: { adota: async (ctx) => ctx.fila.jaConcluido(ctx.job.idem_key!)?.resultado ?? 'novo' },
    });
    const job = fila.enfileirar({
      fila: 'io', kind: 'function', tarefa: 'adota', input: '', idem_key: CHAVE,
    });
    await w.passo();
    expect(fila.obter(job.id)!.resultado).toBe('artefato-antigo');
  });
});

describe('drain', () => {
  it('para de pegar novos jobs, mas termina o que está em voo', async () => {
    let liberar: (() => void) | undefined;
    const w = novoWorker({
      tarefas: { lento: () => new Promise<string>((r) => { liberar = () => r('fim'); }) },
    });
    const j1 = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });
    const j2 = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });

    const emCurso = w.passo();
    const drenando = w.drenar();
    expect(await w.passo()).toBe(false);            // drain: não pega mais

    liberar!();
    await emCurso;
    await drenando;

    expect(fila.obter(j1.id)!.status).toBe('done');
    expect(fila.obter(j2.id)!.status).toBe('queued'); // nunca foi pego
  });

  it('abortar cancela a execução em voo e devolve/falha o job', async () => {
    const runner = new FakeRunner({ respostas: ['nunca'], travar: true });
    const w = novoWorker({ runners: { fake: runner }, tarefas: {} });
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '',
      perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' }, max_tentativas: 2,
    });
    const emCurso = w.passo();
    await new Promise((r) => setTimeout(r, 10));
    await w.abortar();
    await emCurso;
    expect(runner.cancelamentos).toBe(1);
    expect(fila.obter(job.id)!.status).toBe('queued');   // ainda tem tentativa
    expect(fila.obter(job.id)!.erro).toMatch(/encerramento do serviço/);
  });

  // `abortar()` e o catch de `passo()` disputavam o MESMO job: os dois chamavam
  // `falhar`, e quem ganhava era ordem de microtask. O conjunto `abortados` dá
  // a palavra final a `abortar` — o catch não pode nem tentar falhar de novo,
  // nem registrar um "failed: cancelado" fantasma no log.
  it('abortar tem a palavra final: o catch de passo não falha o job de novo', async () => {
    const runner = new FakeRunner({ respostas: ['nunca'], travar: true });
    const linhas: string[] = [];
    const w = novoWorker({ runners: { fake: runner }, tarefas: {}, log: (m) => linhas.push(m) });
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '',
      perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' }, max_tentativas: 2,
    });
    const emCurso = w.passo();
    await new Promise((r) => setTimeout(r, 10));
    await w.abortar();
    await emCurso;

    expect(fila.obter(job.id)!.erro).toMatch(/encerramento do serviço/);
    expect(linhas.filter((l) => l.includes(`[job ${job.id}]`) && /requeued|failed/.test(l)))
      .toEqual([]);
  });

  it('renova o lease durante o drain (não solta o job em voo)', async () => {
    let liberar: (() => void) | undefined;
    const w = novoWorker({
      leaseSegundos: 60,
      tarefas: { lento: () => new Promise<string>((r) => { liberar = () => r('fim'); }) },
    });
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });
    const emCurso = w.passo();
    expect(fila.obter(job.id)!.lease_ate).toBe(1_060);

    t = 1_050;
    const drenando = w.drenar();
    await w.bater();                                 // heartbeat manual
    expect(fila.obter(job.id)!.lease_ate).toBe(1_110);

    liberar!();
    await emCurso;
    await drenando;
  });

  it('a flag de drain, sozinha, recusa claim mesmo com folga na concorrência', async () => {
    let liberar: (() => void) | undefined;
    const w = novoWorker({
      concorrencia: 2,
      tarefas: { lento: () => new Promise<string>((r) => { liberar = () => r('fim'); }) },
    });
    const j1 = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });
    const j2 = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });

    const emCurso = w.passo();
    await Promise.resolve(); // deixa passo() registrar o job em ativos antes de checar

    // Com concorrencia:2 e só 1 job em voo, o portão de concorrência (ativos.size >= concorrencia)
    // NÃO está saturado — então só a flag de drenagem pode explicar a recusa abaixo.
    expect(w.emVoo).toBe(1);

    const drenando = w.drenar();
    expect(await w.passo()).toBe(false);
    expect(fila.obter(j2.id)!.status).toBe('queued');

    liberar!();
    await emCurso;
    await drenando;

    expect(fila.obter(j1.id)!.status).toBe('done');
  });

  it('abortar finaliza também um job function em voo (entrada ainda null em ativos)', async () => {
    let liberar: (() => void) | undefined;
    const w = novoWorker({
      tarefas: { lento: () => new Promise<string>((r) => { liberar = () => r('fim'); }) },
    });
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'lento', input: '' });
    const emCurso = w.passo();
    await Promise.resolve(); // job entra em ativos como null (tarefa function não tem Execucao)

    await w.abortar();

    expect(fila.obter(job.id)!.status).not.toBe('running');
    expect(fila.obter(job.id)!.erro).toMatch(/encerramento do serviço/);

    liberar!(); // libera a promise pendente pra não deixar handle solto
    await emCurso;
  });
});
