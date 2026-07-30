// Os comandos de fluxo pelo caminho REAL do chat, com um repo de domínio de
// brinquedo — nenhum teste toca Telegram nem `claude`.
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
import { tratarMensagem, type DepsMensagem } from './mensagem.js';

let dir: string;
let repo: string;
let fila: FilaSqlite;
let fluxos: Fluxos;
let registrados: FluxoRegistrado[];
const t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-cf-'));
  repo = join(dir, 'meudominio');
  mkdirSync(join(repo, 'prompts'), { recursive: true });
  writeFileSync(join(repo, 'prompts', 'a.md'), 'faça {{input}} em {{saida}}');
  writeFileSync(join(repo, 'flow.json'), JSON.stringify({
    nome: 'brinquedo', prefixo: 'B', versao_def: 3,
    alvos: { um: { canal: 'lives1' }, dois: { canal: 'lives2' } },
    fases: [
      { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' },
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

describe('/fluxos', () => {
  it('lista o catálogo', async () => {
    expect(await manda('/fluxos')).toContain('brinquedo');
  });

  it('sem fluxo registrado, diz isso com todas as letras', async () => {
    const r = await tratarMensagem(9, '/fluxos', { ...deps(), fluxosRegistrados: [] });
    expect(r).toContain('nenhum fluxo registrado');
  });
});

describe('criar fluxo', () => {
  it('cria e devolve a referência para acompanhar', async () => {
    const r = await manda('/brinquedo Lançamento de março');
    expect(r).toContain('B#1');
    expect(fila.listar()).toHaveLength(1);
  });

  it('assunto vazio é recusado com o exemplo da própria definição', async () => {
    expect(await manda('/brinquedo')).toContain('/brinquedo Assunto');
    expect(fila.listar()).toHaveLength(0);
  });

  it('subconjunto de alvos', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const visao = fluxos.status(1)!;
    expect(visao.fases.some((f) => f.alvo === 'dois')).toBe(false);
  });

  it('alvo inventado é recusado listando os que existem', async () => {
    const r = await manda('/brinquedo Assunto | alvos=inexistente');
    expect(r).toMatch(/alvo desconhecido/);
    expect(r).toContain('um');
  });

  it('campo desconhecido não vira silêncio', async () => {
    expect(await manda('/brinquedo Assunto | vertical')).toMatch(/campo desconhecido/);
  });

  // §7.5: é assim que se confere um flow.json novo antes de gastar GPU.
  it('| sombra imprime o plano e NÃO enfileira nada', async () => {
    const r = await manda('/brinquedo Assunto | sombra');
    expect(r).toContain('NADA foi enfileirado');
    expect(r).toContain('texto');
    expect(r).toContain('render');
    expect(fila.listar()).toHaveLength(0);
    expect(fluxos.status(1)).toBeUndefined();
  });

  it('flow.json quebrado é recusado na criação, não no primeiro job', async () => {
    writeFileSync(join(repo, 'flow.json'), '{"nome": "sem o resto"}');
    const r = await manda('/brinquedo Assunto');
    expect(r).toMatch(/não consegui ler a definição/);
    expect(fila.listar()).toHaveLength(0);
  });
});

describe('/status P#N', () => {
  it('mostra fase × alvo e a versão da definição congelada', async () => {
    await manda('/brinquedo Assunto');
    const r = await manda('/status B#1');
    expect(r).toContain('B#1');
    expect(r).toContain('texto');
    expect(r).toContain('versão da definição: 3');
  });

  // `P#16` e `B#16` são fluxos diferentes: agir no errado seria pior que não agir.
  it('prefixo errado é recusado, não resolvido para o mais parecido', async () => {
    await manda('/brinquedo Assunto');
    expect(await manda('/status P#1')).toContain('não existe');
  });

  it('referência inexistente é recusada', async () => {
    expect(await manda('/status B#99')).toContain('não existe');
  });

  // O verbo é o mesmo; o argumento é que diz se é job ou fluxo.
  it('/status com número continua sendo job, não fluxo', async () => {
    fila.enfileirar({ fila: 'io', kind: 'function', tarefa: 'x', input: '{}' });
    expect(await manda('/status 1')).toContain('job 1');
  });

  it('/status sozinho continua sendo a lista de jobs', async () => {
    expect(await manda('/status')).toMatch(/Nada na fila|Na fila agora/);
  });
});

describe('/refazer e /cancelar de fluxo', () => {
  it('refazer sem falha nenhuma diz isso, em vez de fingir que fez', async () => {
    await manda('/brinquedo Assunto');
    expect(await manda('/refazer B#1')).toMatch(/nada a refazer/);
  });

  it('cancelar avisa que o que foi criado FORA continua lá (§3.7)', async () => {
    await manda('/brinquedo Assunto');
    const r = await manda('/cancelar B#1');
    expect(r).toContain('cancelado');
    expect(r).toMatch(/continua lá/);
    expect(fila.obter(1)!.status).toBe('canceled');
  });
});
