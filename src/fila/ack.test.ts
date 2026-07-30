import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { FilaSqlite } from './store.js';

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

describe('concluir', () => {
  it('marca done com resultado e terminado_em', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    t = 1_010;
    expect(fila.concluir(job.id, '/saida.mp4')).toBe(true);
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('done');
    expect(d.resultado).toBe('/saida.mp4');
    expect(d.terminado_em).toBe(1_010);
  });

  it('REJEITA done depois de cancelado', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    expect(fila.cancelar(job.id)).toBe(true);
    expect(fila.concluir(job.id, 'x')).toBe(false);
    expect(fila.obter(job.id)!.status).toBe('canceled');
  });
});

describe('falhar', () => {
  it('reenfileira com backoff exponencial enquanto há tentativa', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 3 });
    const job = fila.pegar('render', 60)!;           // tentativas = 1
    expect(fila.falhar(job.id, 'boom', 10)).toBe('requeued');
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('queued');
    expect(d.erro).toBe('boom');
    expect(d.disponivel_em).toBe(1_010);             // 10 * 2^(1-1) = 10
    expect(d.lease_ate).toBeNull();
  });

  it('backoff cresce com a tentativa', () => {
    fila.enfileirar({ fila: 'render', kind: 'agent', tarefa: 'a', input: '', max_tentativas: 4 });
    const job = fila.pegar('render', 60)!;
    fila.falhar(job.id, 'e1', 10);
    t = 1_010;
    fila.pegar('render', 60);                        // tentativas = 2
    fila.falhar(job.id, 'e2', 10);
    expect(fila.obter(job.id)!.disponivel_em).toBe(1_030); // 1_010 + 10 * 2^(2-1)
  });

  it('esgotadas as tentativas, vira failed', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '', max_tentativas: 1 });
    const job = fila.pegar('io', 60)!;
    expect(fila.falhar(job.id, 'fim', 10)).toBe('failed');
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('failed');
    expect(d.terminado_em).toBe(1_000);
  });

  // Wart: quando job não é 'running', falhar retorna 'failed' como placeholder
  // (não há terceira variante no tipo 'requeued' | 'failed'). Não significa
  // que as tentativas se esgotaram — só o estado do job é autoritário.
  it('falha sem efeito se job nunca foi claimed (queued)', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const disponivel_em_antes = fila.obter(job.id)!.disponivel_em;
    fila.falhar(job.id, 'erro-que-nao-deve-aparecer');
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('queued');
    expect(d.erro).toBeNull();
    expect(d.tentativas).toBe(0);
    expect(d.disponivel_em).toBe(disponivel_em_antes);
  });

  it('falha sem efeito se job foi cancelado', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    fila.cancelar(job.id);
    fila.falhar(job.id, 'x');
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('canceled');
    expect(d.erro).toBeNull();
  });
});

describe('cancelar e reagendar', () => {
  it('cancela job na fila', () => {
    const job = fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    expect(fila.cancelar(job.id)).toBe(true);
    expect(fila.obter(job.id)!.status).toBe('canceled');
  });

  it('não cancela job terminal', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'a', input: '' });
    const job = fila.pegar('io', 60)!;
    fila.concluir(job.id, 'ok');
    expect(fila.cancelar(job.id)).toBe(false);
  });

  it('reagenda para poll sem gastar tentativa', () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'poll', input: '' });
    const job = fila.pegar('io', 60)!;
    expect(fila.reagendar(job.id, 120)).toBe(true);
    const d = fila.obter(job.id)!;
    expect(d.status).toBe('queued');
    expect(d.disponivel_em).toBe(1_120);
    expect(d.tentativas).toBe(1);
  });
});
