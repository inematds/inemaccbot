// `cli.rodar` — o que ela precisa garantir para substituir um agente.
//
// Cada teste aqui corresponde a uma falha real do MVD#87..#89 (2026-08-21), de
// quando estas fases eram `kind: agent` e o comando era prosa num prompt.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarCliRodar } from './cli.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-cli-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(entrada: unknown, sinal = new AbortController().signal): ContextoTarefa {
  return {
    job: { id: 7, input: JSON.stringify(entrada) },
    log: () => {},
    sinal,
  } as unknown as ContextoTarefa;
}

describe('cli.rodar', () => {
  it('roda o comando e devolve o RECIBO que o BOT nomeou', async () => {
    const saida = join(dir, 'recibo.txt');
    const r = await criarCliRodar()(ctx({
      comando: 'echo "plano: /out/PLANO.md"', cwd: dir, saida,
    }));
    // O contrato do artefato é do bot: a tarefa devolve o caminho que o bot
    // escolheu, não um que o domínio imprimiu. Era exatamente aqui que o agente
    // errava, respondendo `RESULT: <PLANO.md>` e falhando com o trabalho pronto.
    expect(r).toBe(saida);
    expect(readFileSync(saida, 'utf8')).toContain('plano: /out/PLANO.md');
  });

  it('exit != 0 é falha, com a CAUDA da saída na mensagem', async () => {
    await expect(criarCliRodar()(ctx({
      comando: 'echo "linha boba"; echo "erro: slug já existe" >&2; exit 3',
      cwd: dir, saida: join(dir, 'r.txt'),
    }))).rejects.toThrow(/código 3.*slug já existe/s);
  });

  // O cwd é o repo de DOMÍNIO — o mesmo das fases de agente. Sem isto o script
  // roda de onde o serviço subiu, e caminhos relativos do domínio quebram.
  it('roda no cwd declarado', async () => {
    const saida = join(dir, 'r.txt');
    await criarCliRodar()(ctx({ comando: 'pwd', cwd: dir, saida }));
    expect(readFileSync(saida, 'utf8').trim()).toContain(dir.replace('/private', ''));
  });

  it('sem comando, falha dizendo o que falta no flow.json', async () => {
    await expect(criarCliRodar()(ctx({ comando: '  ', cwd: dir, saida: join(dir, 'r.txt') })))
      .rejects.toThrow(/sem comando/);
  });

  // §9: tarefa function repassa o sinal. E a mensagem tem que dizer ABORT —
  // senão o `/status` mostra encerramento de serviço como falha do domínio.
  it('abortado antes de começar: nem gasta um spawn', async () => {
    await expect(criarCliRodar()(ctx(
      { comando: 'echo nao-deveria', cwd: dir, saida: join(dir, 'r.txt') },
      AbortSignal.abort(new Error('serviço encerrando')),
    ))).rejects.toThrow(/abortado pelo worker/i);
  });

  it('abortado NO MEIO: para rápido e diz que foi abort', async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const p = criarCliRodar()(ctx(
      { comando: 'sleep 30', cwd: dir, saida: join(dir, 'r.txt') }, ctrl.signal,
    ));
    setTimeout(() => ctrl.abort(new Error('serviço encerrando')), 20);
    await expect(p).rejects.toThrow(/abortado pelo worker/i);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('teto de tempo mata o comando em vez de segurar a vaga da fila', async () => {
    await expect(criarCliRodar()(ctx({
      comando: 'sleep 30', cwd: dir, saida: join(dir, 'r.txt'), timeout_segundos: 1,
    }))).rejects.toThrow(/estourou 1s/);
  });
});
