// O `promoclub` contra o `flow.json` REAL, com foco na fase que o promoavatar
// não tem: o avatar pelo NAVEGADOR.
//
// Ela nunca tinha sido exercitada — os testes paravam na fase 1 —, e é a peça
// mais frágil do pipeline: se ela rodar sem `--chrome`, "roda" e não faz nada.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { carregarFlow, congelar, hashDefinicao, type FlowDef } from '../dominio/flow.js';
import { carregarSkills } from '../dominio/registry.js';
import { criarPromptDe } from '../fila/skills.js';
import { FilaSqlite } from '../fila/store.js';
import { EstadoFluxos } from '../fluxos/estado.js';
import { Fluxos } from '../fluxos/runtime.js';

const REPO_BOT = new URL('../..', import.meta.url).pathname;
const REPO_DOMINIO = join(REPO_BOT, '..', 'inemaclubpromover');

let dir: string;
let fila: FilaSqlite;
let estado: EstadoFluxos;
let fluxos: Fluxos;
let def: FlowDef;
const t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-promoclub-'));
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  estado = new EstadoFluxos(db, () => t);
  fluxos = new Fluxos({
    fila, estado, agora: () => t,
    raizArtefatos: join(dir, 'artefatos'), projetosDir: join(dir, 'projetos'),
  });
  const skills = carregarSkills(join(REPO_BOT, 'config', 'skills.json'), REPO_BOT).map((s) => s.command);
  def = congelar(carregarFlow(REPO_DOMINIO, skills), REPO_DOMINIO);
  mkdirSync(join(dir, 'projetos', 'yt-pub-lives24', 'imports', 'videos'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function promptDe() {
  return criarPromptDe({
    defs: carregarSkills(join(REPO_BOT, 'config', 'skills.json'), REPO_BOT),
    raizRepo: REPO_BOT, raizArtefatos: join(dir, 'artefatos'), cwd: dir,
    perfilPadrao: { motor: 'claude', modelo: 'sonnet', esforco: 'low' },
  });
}

function criar(alvos = ['mulheres']): number {
  return fluxos.criar({
    tipo: 'promoclub', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
    assunto: 'Não comece aprendendo ferramentas', alvos, chatId: 55,
  }).id;
}

function ackar(flowRef: string, resultado: string): void {
  const job = fila.listar().find((j) => j.flow_ref === flowRef)!;
  if (job.status !== 'running') fila.pegar(job.fila, 600, 'W');
  fila.concluir(job.id, resultado, 'W', (j) => fluxos.avancar(j));
}

describe('flow.json real do promoclub', () => {
  it('tem as quatro fases, sem portão — a cadeia inteira é do bot', () => {
    expect(def.fases.map((f) => f.id)).toEqual(['texto', 'avatar', 'baixar', 'reel']);
    expect(def.fases.some((f) => f.pausa_apos)).toBe(false);
  });

  it('a fase de avatar vai para a fila navegador, que tem concorrência 1', async () => {
    const { CONCORRENCIAS } = await import('../fila/filas.js');
    expect(def.fases[1]!.fila).toBe('navegador');
    // No v1 a exclusividade era um mutex em memória, que um restart zerava.
    // Aqui é propriedade da fila — e sobrevive.
    expect(CONCORRENCIAS.navegador).toBe(1);
  });
});

describe('a fase de avatar (navegador)', () => {
  it('é EXECUTÁVEL: vira contexto com prompt renderizado', async () => {
    criar();
    ackar('P#1//texto', 'ok');
    const job = fila.listar().find((j) => j.flow_ref === 'P#1/mulheres/avatar')!;
    const ctx = await promptDe()(job);
    expect(ctx.prompt).toContain('heygen-avatar-nei-III');
    expect(ctx.prompt).toContain('mulheres');
    expect(ctx.prompt).not.toContain('{{');
  });

  // Rodar a fase de navegador sem `--chrome` é o erro de fiação silencioso
  // clássico: ela "roda" e não faz nada, porque a extensão não é reconhecida.
  it('roda no motor chrome, mesmo com o perfil padrão sendo claude', async () => {
    criar();
    ackar('P#1//texto', 'ok');
    const job = fila.listar().find((j) => j.flow_ref === 'P#1/mulheres/avatar')!;
    expect((await promptDe()(job)).perfil.motor).toBe('chrome');
  });

  it('o motor chrome está registrado e passa --chrome antes das outras flags', async () => {
    await import('../fila/runner-chrome.js');
    const { RUNNERS } = await import('../fila/runner.js');
    const { argumentosChrome } = await import('../fila/runner-chrome.js');
    expect(RUNNERS.chrome).toBeDefined();
    const args = argumentosChrome({
      prompt: 'x', cwd: '/tmp', perfil: { motor: 'chrome', modelo: 'sonnet', esforco: 'low' }, vars: {},
    });
    expect(args[0]).toBe('--chrome');
    expect(args).toContain('-p');
  });

  it('o prompt manda o título EXATO que o download vai procurar depois', async () => {
    criar();
    ackar('P#1//texto', 'ok');
    const avatar = fila.listar().find((j) => j.flow_ref === 'P#1/mulheres/avatar')!;
    const ctx = await promptDe()(avatar);
    expect(ctx.prompt).toContain('P1-mulheres-v1');

    // E é o mesmo que a fase seguinte procura — se divergirem, o download nunca
    // acha o vídeo (o defeito que fez o v1 encurtar o título).
    ackar('P#1/mulheres/avatar', 'P1-mulheres-v1');
    const baixar = fila.listar().find((j) => j.flow_ref === 'P#1/mulheres/baixar')!;
    expect((JSON.parse(baixar.input) as { titulo: string }).titulo).toBe('P1-mulheres-v1');
  });
});

describe('a cadeia inteira, sem parada', () => {
  it('texto → avatar → baixar → reel, um alvo', () => {
    const id = criar();
    ackar('P#1//texto', 'ok');
    ackar('P#1/mulheres/avatar', 'P1-mulheres-v1');
    ackar('P#1/mulheres/baixar', '/tmp/P1-mulheres-v1.mp4');
    const reel = fila.listar().find((j) => j.flow_ref === 'P#1/mulheres/reel')!;
    expect((JSON.parse(reel.input) as { destino: string }).destino).toContain('yt-pub-lives24');
    ackar('P#1/mulheres/reel', '/tmp/reel.mp4');
    expect(estado.obter(id)!.status).toBe('feito');
  });

  it('12 públicos: 1 job de texto vira 12 de avatar', () => {
    criar(Object.keys(def.alvos));
    ackar('P#1//texto', 'ok');
    expect(fila.listar().filter((j) => j.tarefa === 'fluxo-navegador')).toHaveLength(12);
  });
});
