// LOOP-R, camada "medir": nota e motivo no portão viram dado (migration 5).
// Pelo caminho REAL do chat, com um domínio de brinquedo que para no portão.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { validarFluxos, type FluxoRegistrado } from '../dominio/registry-fluxos.js';
import { FakeRunner } from '../fila/runner.js';
import { FilaSqlite } from '../fila/store.js';
import { EstadoFluxos } from '../fluxos/estado.js';
import { Fluxos } from '../fluxos/runtime.js';
import { separarOpiniao } from './comandos-fluxo.js';
import { tratarMensagem, type DepsMensagem } from './mensagem.js';

let dir: string;
let fila: FilaSqlite;
let fluxos: Fluxos;
let registrados: FluxoRegistrado[];
const t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-av-'));
  const repo = join(dir, 'meudominio');
  mkdirSync(join(repo, 'prompts'), { recursive: true });
  writeFileSync(join(repo, 'prompts', 'a.md'), 'faça {{input}} em {{saida}}');
  writeFileSync(join(repo, 'flow.json'), JSON.stringify({
    nome: 'brinquedo', prefixo: 'B', versao_def: 1,
    alvos: { um: { canal: 'lives1' }, dois: { canal: 'lives2' } },
    fases: [
      {
        id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
        prompt: 'prompts/a.md', pausa_apos: true,
        portao: { mostrar: ['{{saida}}'], respostas: { reprova: 'python3 {{repo}}/r.py {{resposta}}' } },
      },
      { id: 'render', escopo: 'alvo', fila: 'render', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' },
    ],
  }));
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  fluxos = new Fluxos({ fila, estado: new EstadoFluxos(db, () => t), agora: () => t });
  registrados = validarFluxos(
    [{ command: 'brinquedo', repo, descricao: 'fluxo de teste', exemplo: '/brinquedo Assunto' }],
    dir,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(): DepsMensagem {
  return {
    fila, agora: () => t, defs: [], projetosDir: dir,
    runner: new FakeRunner({ respostas: [] }),
    perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    cwd: dir, logFile: join(dir, 'log'),
    fluxos, fluxosRegistrados: registrados,
  };
}
const manda = (texto: string) => tratarMensagem(9, texto, deps());

/** Cria o fluxo e conclui a fase `texto`: ele para no portão. */
async function noPortao(): Promise<void> {
  const criado = await manda('/brinquedo Assunto | alvos=um');
  if (!fila.listar().length) throw new Error(`fluxo não criado: ${criado}`);
  const job = fila.listar()[0]!;
  fila.pegar(job.fila, 600, 'W');
  fila.concluir(job.id, 'ok', 'W', (j) => fluxos.avancar(j));
  expect(fluxos.status(1)!.fases.some((f) => f.estado === 'aguardando-ok')).toBe(true);
}

describe('separarOpiniao', () => {
  it('sem nada, devolve só os argumentos', () => {
    expect(separarOpiniao('B#1 um')).toEqual({ args: ['B#1', 'um'] });
  });
  it('nota e motivo depois do |', () => {
    expect(separarOpiniao('B#1 nota=4 | capa fraca')).toEqual({ args: ['B#1'], nota: 4, motivo: 'capa fraca' });
  });
  it('motivo= sem |, até o fim da linha', () => {
    expect(separarOpiniao('B#1 jovens motivo=texto longo demais')).toEqual({
      args: ['B#1', 'jovens'], motivo: 'texto longo demais',
    });
  });
  it('nota fora de 1–5 é erro, não silêncio', () => {
    expect(separarOpiniao('B#1 nota=9').erro).toMatch(/nota=1 a nota=5/);
    expect(separarOpiniao('B#1 nota=bom').erro).toBeDefined();
  });
});

describe('o portão guarda o que o dono disse', () => {
  it('/aprovar com nota e motivo grava a avaliação com a versão da definição', async () => {
    await noPortao();
    const r = await manda('/aprovar B#1 nota=4 | capa fraca');
    expect(r).toContain('aprovada');
    expect(r).toContain('nota 4 e motivo anotados');
    const [a] = fluxos.avaliacoes(1);
    expect(a).toMatchObject({ acao: 'aprovar', fase: 'texto', nota: 4, motivo: 'capa fraca', tipo: 'brinquedo', chat_id: 9 });
    expect(a!.definicao_hash).toBe(fluxos.status(1)!.fluxo.definicao_hash);
  });

  it('/aprovar sem nada continua igual e grava "passou" sem nota', async () => {
    await noPortao();
    const r = await manda('/aprovar B#1');
    expect(r).toContain('aprovada —');
    expect(fluxos.avaliacoes(1)).toHaveLength(1);
    expect(fluxos.avaliacoes(1)[0]).toMatchObject({ nota: null, motivo: null });
  });

  it('/aprovar sem referência ainda adivinha o único fluxo, e leva a nota', async () => {
    await noPortao();
    expect(await manda('/aprovar nota=5')).toContain('aprovada');
    expect(fluxos.avaliacoes(1)[0]!.nota).toBe(5);
  });

  it('os apelidos passam pelo mesmo leitor', async () => {
    await noPortao();
    expect(await manda('/ok B#1 nota=3')).toContain('aprovada');
    expect(fluxos.avaliacoes(1)[0]!.nota).toBe(3);
  });

  it('nota inválida não aprova nada', async () => {
    await noPortao();
    expect(await manda('/aprovar B#1 nota=7')).toMatch(/inválida/);
    expect(fluxos.avaliacoes(1)).toHaveLength(0);
    expect(fluxos.status(1)!.fases.some((f) => f.estado === 'aguardando-ok')).toBe(true);
  });

  it('/aprovar quando nada espera não grava avaliação', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    await manda('/aprovar B#1 nota=2');
    expect(fluxos.avaliacoes(1)).toHaveLength(0);
  });

  it('/refazer mantém o alvo e grava o motivo', async () => {
    await manda('/brinquedo Assunto | alvos=um,dois');
    const job = fila.listar()[0]!;
    fila.pegar(job.fila, 600, 'W');
    fila.falhar(job.id, 'deu ruim', 'W', 1, (j) => fluxos.avancar(j));
    const r = await manda('/refazer B#1 | motivo=prompt confuso');
    expect(r).toContain('de volta na fila (motivo anotado)');
    expect(fluxos.avaliacoes(1)[0]).toMatchObject({ acao: 'refazer', fase: 'texto', motivo: 'prompt confuso' });
  });

  it('resposta ao portão (reprova) vira avaliação com a palavra e o texto', async () => {
    await noPortao();
    const r = await manda('texto: B#1 reprova muito genérico');
    expect(r).toContain('reprova');
    expect(fluxos.avaliacoes(1)[0]).toMatchObject({
      acao: 'responder', palavra: 'reprova', fase: 'texto', motivo: 'muito genérico',
    });
  });

});
