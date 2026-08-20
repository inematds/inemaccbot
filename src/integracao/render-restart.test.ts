// Os dois testes que sustentam o desenho da etapa 3. Se um destes cair, o
// desenho está errado — não o teste.
//
//  1. ADOÇÃO: o serviço cai no meio de um render; na volta, o job NÃO dispara um
//     segundo render sobre o primeiro. É o §2.5 ("procure antes de criar")
//     aplicado ao trabalho destacado, e o equivalente, aqui, do teste de
//     idempotência que sustenta a etapa 0.
//  2. SLOT PRESO: enquanto um render é vigiado, nenhum outro job de render é
//     reclamado. Sem isso, dois renders escrevem na mesma GPU sem saber um do
//     outro — o que a concorrência 1 da fila existe para impedir.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { validarSkills, type SkillDef } from '../dominio/registry.js';
import { FakeRunner } from '../fila/runner.js';
import { criarPromptDe } from '../fila/skills.js';
import { FilaSqlite } from '../fila/store.js';
import { Worker } from '../fila/worker.js';

let dir: string;
let fila: FilaSqlite;
let defs: SkillDef[];
let t = 1_000;

beforeEach(() => {
  t = 1_000;
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-render-e2e-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'r.md'), 'renderize {{input}} em {{saida}}');
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  defs = validarSkills([{
    command: 'explicativo', fila: 'render', kind: 'agent', prompt: 'prompts/r.md',
    artefato_exts: ['mp4'], max_tentativas: 2, timeout_segundos: 3600,
    aceita_destino: true, aguarda_artefato: true, descricao: 'd', exemplo: 'ex',
  }], dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alvoDoJob = (id: number): string => join(dir, 'artefatos', 'explicativo', `${id}.mp4`);

function worker(runner: FakeRunner, over: Record<string, unknown> = {}): Worker {
  return new Worker(fila, {
    fila: 'render', dono: 'A', concorrencia: 1, leaseSegundos: 60,
    tarefas: {}, runners: { fake: runner },
    promptDe: criarPromptDe({
      defs, raizRepo: dir, projetosDir: dir, raizArtefatos: join(dir, 'artefatos'), cwd: dir,
      perfilPadrao: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
      // Janelas curtas: o comportamento sob teste é a ADOÇÃO e a posse do slot,
      // não a duração das janelas (essas têm teste próprio em render.test.ts).
      espera: { estavelMs: 0, intervaloMs: 1 },
    }),
    ...over,
  }, () => t);
}

function enfileirar(): number {
  return fila.enfileirar({
    fila: 'render', kind: 'agent', tarefa: 'explicativo',
    input: JSON.stringify({ entrada: 'O que é RAG' }), max_tentativas: 2,
    perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
  }).id;
}

describe('render sobrevive a restart', () => {
  it('a segunda tentativa ADOTA o render em curso em vez de disparar outro', async () => {
    const id = enfileirar();
    const alvo = alvoDoJob(id);

    // 1ª tentativa: o agente dispara o passo destacado (que deixa o `.log`) e
    // some no meio — é o que um `systemctl restart` provoca.
    const primeiro = new FakeRunner({ respostas: [] });
    const iniciarOriginal = primeiro.iniciar.bind(primeiro);
    primeiro.iniciar = (ctx) => {
      mkdirSync(join(dir, 'artefatos', 'explicativo'), { recursive: true });
      writeFileSync(`${alvo}.log`, 'render disparado…');
      return { ...iniciarOriginal(ctx), aguardar: async () => { throw new Error('serviço caiu'); } };
    };
    await worker(primeiro).passo();
    expect(fila.obter(id)!.status).toBe('queued'); // max_tentativas=2
    expect(primeiro.chamadas).toHaveLength(1);

    // Entre as tentativas, o processo destacado — que sobreviveu — termina.
    writeFileSync(alvo, 'video pronto');
    t += 120; // passa o backoff da retentativa

    // 2ª tentativa: o agente NÃO pode ser chamado de novo.
    const segundo = new FakeRunner({ respostas: [`RENDER: ${alvo}`] });
    await worker(segundo).passo();

    expect(segundo.chamadas).toHaveLength(0);
    const job = fila.obter(id)!;
    expect(job.status).toBe('done');
    expect(job.resultado).toBe(alvo);
  });

  it('sem trabalho em curso, a primeira tentativa chama o agente normalmente', async () => {
    const id = enfileirar();
    const alvo = alvoDoJob(id);
    const runner = new FakeRunner({ respostas: [] });
    const original = runner.iniciar.bind(runner);
    runner.iniciar = (ctx) => {
      mkdirSync(join(dir, 'artefatos', 'explicativo'), { recursive: true });
      writeFileSync(alvo, 'video pronto');
      return { ...original(ctx), aguardar: async () => `RENDER: ${alvo}` };
    };
    await worker(runner).passo();
    expect(runner.chamadas).toHaveLength(1);
    expect(fila.obter(id)!.status).toBe('done');
  });

  it('o passo destacado que morre (.err) falha o job com o motivo do log', async () => {
    const id = enfileirar();
    const alvo = alvoDoJob(id);
    const runner = new FakeRunner({ respostas: [] });
    const original = runner.iniciar.bind(runner);
    runner.iniciar = (ctx) => {
      mkdirSync(join(dir, 'artefatos', 'explicativo'), { recursive: true });
      return {
        ...original(ctx),
        aguardar: async () => {
          writeFileSync(`${alvo}.err`, '');
          writeFileSync(`${alvo}.log`, 'CUDA out of memory');
          return `RENDER: ${alvo}`;
        },
      };
    };
    await worker(runner).passo();
    // 1ª tentativa: volta pra fila, com o motivo já gravado.
    expect(fila.obter(id)!.erro).toMatch(/CUDA out of memory/);
    expect(fila.obter(id)!.status).toBe('queued');

    // A 2ª tentativa TEM que disparar de novo. Enquanto a adoção olhava só o
    // `.log`, ela adotava um trabalho morto, lia o `.err` velho e falhava na
    // hora — o `max_tentativas` não comprava nada exatamente no caso para o
    // qual existe (CUDA sem memória, yt-dlp instável).
    t += 120;
    const segundo = new FakeRunner({ respostas: [] });
    const orig2 = segundo.iniciar.bind(segundo);
    segundo.iniciar = (ctx) => {
      writeFileSync(alvo, 'agora foi');
      return { ...orig2(ctx), aguardar: async () => `RENDER: ${alvo}` };
    };
    await worker(segundo).passo();
    expect(segundo.chamadas).toHaveLength(1);
    expect(fila.obter(id)!.status).toBe('done');
  });
});

describe('a fila de render não deixa dois renders no ar', () => {
  it('enquanto um render é vigiado, o segundo job NÃO é reclamado', async () => {
    const a = enfileirar();
    const b = enfileirar();
    const alvo = alvoDoJob(a);

    let soltar: () => void = () => {};
    const travado = new Promise<void>((r) => { soltar = r; });
    const runner = new FakeRunner({ respostas: [] });
    const original = runner.iniciar.bind(runner);
    runner.iniciar = (ctx) => {
      mkdirSync(join(dir, 'artefatos', 'explicativo'), { recursive: true });
      writeFileSync(`${alvo}.log`, 'disparado');
      return {
        ...original(ctx),
        // O agente devolve o alvo e sai; o job segue vivo VIGIANDO.
        aguardar: async () => { await travado; writeFileSync(alvo, 'pronto'); return `RENDER: ${alvo}`; },
      };
    };

    const w = worker(runner);
    const emVoo = w.passo();
    await new Promise((r) => setTimeout(r, 20));

    // Concorrência 1: com o job A ocupando o slot, `passo()` não pega o B.
    expect(await w.passo()).toBe(false);
    expect(fila.obter(b)!.status).toBe('queued');
    expect(runner.chamadas).toHaveLength(1);

    soltar();
    await emVoo;
    expect(fila.obter(a)!.status).toBe('done');
    expect(existsSync(alvo)).toBe(true);
  });
});
