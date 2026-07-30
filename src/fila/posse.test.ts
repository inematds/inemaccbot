// Posse do lease (`lease_owner`). O `status = 'running'` sozinho não distingue
// "o job ainda é meu" de "meu lease venceu, a recuperação devolveu o job à fila
// e outra instância o pegou". Sem `lease_owner`, o worker zumbi que acorda
// depois sobrescreve trabalho VIVO — é o cenário que estes testes travam.
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  t = 1_000;
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lease_owner no store', () => {
  it('pegar grava o dono do lease', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60, 'A')!;
    expect(job.lease_owner).toBe('A');
    expect(fila.obter(job.id)!.lease_owner).toBe('A');
  });

  it('renovar com dono errado devolve false e não empurra o lease', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60, 'A')!;
    t = 1_050;
    expect(fila.renovar(job.id, 60, 'B')).toBe(false);
    expect(fila.obter(job.id)!.lease_ate).toBe(1_060);   // intacto
  });

  it('o worker estolado NÃO consegue concluir um job já reclamado por outro', () => {
    fila.enfileirar({
      fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 3,
    });
    const jobA = fila.pegar('render', 60, 'A')!;

    // A estola; o lease vence; a recuperação devolve o job à fila; B pega.
    t = 1_061;
    expect(fila.recuperarLeasesVencidos()).toEqual({ requeued: 1, failed: 0 });
    const jobB = fila.pegar('render', 60, 'B')!;
    expect(jobB.id).toBe(jobA.id);

    // A acorda e tenta dar ack: recusado, e o resultado de B fica intocado.
    expect(fila.concluir(jobA.id, 'resultado-de-A', 'A')).toBe(false);
    expect(fila.obter(jobA.id)!.resultado).toBeNull();
    expect(fila.obter(jobA.id)!.status).toBe('running');

    expect(fila.concluir(jobB.id, 'resultado-de-B', 'B')).toBe(true);
    expect(fila.obter(jobB.id)!.resultado).toBe('resultado-de-B');
  });

  it('falhar e reagendar também exigem a posse', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60, 'A')!;
    expect(fila.falhar(job.id, 'de outro', 'B', 10)).toBe('failed'); // placeholder, sem efeito
    expect(fila.obter(job.id)!.status).toBe('running');
    expect(fila.obter(job.id)!.erro).toBeNull();

    expect(fila.reagendar(job.id, 120, 'B')).toBe(false);
    expect(fila.obter(job.id)!.status).toBe('running');
  });
});

describe('Worker.bater', () => {
  it('larga o job em voo quando o lease não é mais nosso', async () => {
    const runner = new FakeRunner({ respostas: ['nunca'], travar: true });
    const w = new Worker(fila, {
      fila: 'io', dono: 'A', concorrencia: 1, leaseSegundos: 60,
      tarefas: {}, runners: { fake: runner },
      promptDe: (job: Job) => ({
        prompt: job.input, cwd: '/tmp',
        perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' }, vars: {},
      }),
    }, () => t);
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '', max_tentativas: 3,
      perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    });
    const emCurso = w.passo();
    await new Promise((r) => setTimeout(r, 10));
    expect(w.emVoo).toBe(1);

    // B rouba o job: lease de A vence, recuperação devolve à fila, B pega.
    t = 1_061;
    fila.recuperarLeasesVencidos();
    expect(fila.pegar('io', 60, 'B')!.id).toBe(job.id);

    await w.bater();
    expect(w.emVoo).toBe(0);
    expect(runner.cancelamentos).toBe(1);

    await emCurso;
    // A não dá ack nenhum: o job continua running e pertencendo a B.
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('running');
    expect(d.lease_owner).toBe('B');
    expect(d.erro).toBeNull();
  });

  it('job roubado não gera log de "failed" (o ack já é bloqueado pela posse, o log não pode mentir)', async () => {
    const logs: string[] = [];
    const runner = new FakeRunner({ respostas: ['nunca'], travar: true });
    const w = new Worker(fila, {
      fila: 'io', dono: 'A', concorrencia: 1, leaseSegundos: 60,
      tarefas: {}, runners: { fake: runner },
      promptDe: (job: Job) => ({
        prompt: job.input, cwd: '/tmp',
        perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' }, vars: {},
      }),
      log: (m) => logs.push(m),
    }, () => t);
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'x', input: '', max_tentativas: 3,
      perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    });
    const emCurso = w.passo();
    await new Promise((r) => setTimeout(r, 10));

    // B rouba o job: lease de A vence, recuperação devolve à fila, B pega.
    t = 1_061;
    fila.recuperarLeasesVencidos();
    fila.pegar('io', 60, 'B');

    await w.bater();
    await emCurso;

    const doJob = logs.filter((m) => m.includes(`[job ${job.id}]`));
    expect(doJob.some((m) => /LEASE PERDIDO/.test(m))).toBe(true);
    expect(doJob.some((m) => /failed|requeued/.test(m))).toBe(false);
  });
});
