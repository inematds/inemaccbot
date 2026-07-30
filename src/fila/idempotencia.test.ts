// src/fila/idempotencia.test.ts
// Lease garante claim único; NÃO garante efeito único. O cenário real: o worker
// cria o vídeo no HeyGen, morre antes do ack, o lease vence, outro worker roda a
// mesma fase — e criaria um SEGUNDO vídeo. A defesa é a chave de idempotência
// (spec §2.5): a tarefa procura antes de criar.
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

const CHAVE = 'P#16/mulheres/render';

describe('enfileirarSeNovo', () => {
  it('enfileira na primeira vez', () => {
    const r = fila.enfileirarSeNovo({
      fila: 'navegador', kind: 'agent', tarefa: 'fluxo-navegador', input: '', idem_key: CHAVE,
    });
    expect(r.novo).toBe(true);
  });

  it('não duplica job pendente com a mesma chave', () => {
    fila.enfileirarSeNovo({ fila: 'navegador', kind: 'agent', tarefa: 'x', input: '', idem_key: CHAVE });
    const r = fila.enfileirarSeNovo({ fila: 'navegador', kind: 'agent', tarefa: 'x', input: '', idem_key: CHAVE });
    expect(r.novo).toBe(false);
    expect(fila.listar()).toHaveLength(1);
  });

  it('não reenfileira o que já está done', () => {
    const p = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    fila.pegar('io', 60, 'w1');
    fila.concluir(p.job.id, 'ok', 'w1');
    const r = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    expect(r.novo).toBe(false);
    expect(r.job.status).toBe('done');
  });

  it('DEIXA reenfileirar depois de failed (retry manual é legítimo)', () => {
    const p = fila.enfileirarSeNovo({
      fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE, max_tentativas: 1,
    });
    fila.pegar('io', 60, 'w1');
    fila.falhar(p.job.id, 'boom', 'w1', 10);
    const r = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    expect(r.novo).toBe(true);
  });

  it('sem idem_key sempre enfileira', () => {
    fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '' });
    fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '' });
    expect(fila.listar()).toHaveLength(2);
  });
});

describe('jaConcluido', () => {
  it('permite a tarefa ADOTAR o efeito de uma execução anterior', () => {
    // simula: worker criou o render, gravou o resultado, e MORREU antes do ack final
    const p = fila.enfileirarSeNovo({ fila: 'io', kind: 'function', tarefa: 'x', input: '', idem_key: CHAVE });
    fila.pegar('io', 60, 'w1');
    fila.concluir(p.job.id, 'heygen:video-abc', 'w1');

    expect(fila.jaConcluido(CHAVE)?.resultado).toBe('heygen:video-abc');
    expect(fila.jaConcluido('outra/chave')).toBeUndefined();
  });
});
