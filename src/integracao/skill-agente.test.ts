// Ponta a ponta do caminho novo da etapa 2: mensagem no chat → job na fila
// `texto` → agente (fake) → contrato `RESULT:` → artefato entregue no chat.
//
// É o teste que amarra as camadas que os unitários cobrem separadas, e o mais
// próximo que dá de automatizar a aceitação do §7.4 — a prova real ("mesma
// entrada nos dois bots, saída equivalente") custa GPU e token e é manual.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { tratarMensagem } from '../gateway/mensagem.js';
import { criarNotificador } from '../gateway/notificar.js';
import { parseEntradaSkill } from '../fila/skills.js';
import type { Transporte } from '../gateway/telegram.js';

let dir: string;
let fila: FilaSqlite;
let defs: SkillDef[];
let t = 1_000;

const enviados: string[] = [];
const anexos: string[] = [];
const transporte: Transporte = {
  async responder(_c, texto) { enviados.push(texto); },
  async enviarDocumento(_c, caminho) { anexos.push(caminho); },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-e2e-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'p.md'), 'transcreva {{input}} para {{saida}}');
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  defs = validarSkills([{
    command: 'transcrever', fila: 'texto', kind: 'agent', prompt: 'prompts/p.md',
    artefato_exts: ['txt'], max_tentativas: 2, timeout_segundos: 60,
    aceita_destino: false, descricao: 'd', exemplo: 'ex',
  }], dir);
  enviados.length = 0;
  anexos.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** O worker montado como o boot monta, com o motor trocado pelo fake. */
function worker(runner: FakeRunner): Worker {
  const notificar = criarNotificador(transporte, {
    temArtefato: (job) => defs.some((d) => d.command === job.tarefa),
    entregaDe: (job) => {
      try { return { destinoDir: parseEntradaSkill(job.input).destino }; } catch { return {}; }
    },
  });
  return new Worker(fila, {
    fila: 'texto', dono: 'A', concorrencia: 1, leaseSegundos: 60,
    tarefas: {},
    runners: { fake: runner },
    promptDe: criarPromptDe({
      defs, raizRepo: dir, projetosDir: dir, raizArtefatos: join(dir, 'artefatos'), cwd: dir,
      perfilPadrao: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    }),
    aoTerminar: notificar,
  }, () => t);
}

async function mandar(texto: string): Promise<string> {
  return tratarMensagem(42, texto, {
    fila, agora: () => t, defs, projetosDir: join(dir, 'projetos'),
    runner: new FakeRunner({ respostas: [] }),
    perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    cwd: dir, logFile: join(dir, 'log'),
  });
}

describe('skill de agente, ponta a ponta', () => {
  it('do comando ao texto entregue no chat', async () => {
    await mandar('transcrever: https://exemplo/video');

    // O agente fake grava o arquivo que o prompt mandou gravar e declara o
    // contrato — é exatamente o que o `claude -p` real faz.
    const runner = new FakeRunner({ respostas: [] });
    const saida = join(dir, 'artefatos', 'transcrever', '1.txt');
    const original = runner.iniciar.bind(runner);
    runner.iniciar = (ctx) => {
      writeFileSync(saida, 'foi isso que a pessoa falou');
      return { ...original(ctx), aguardar: async () => `log do agente\nRESULT: ${saida}` };
    };

    expect(await worker(runner).passo()).toBe(true);

    const job = fila.obter(1)!;
    expect(job.status).toBe('done');
    // O resultado é o CAMINHO, nunca o stdout do agente.
    expect(job.resultado).toBe(saida);
    // E o chat recebeu o CONTEÚDO — o caminho no disco não serve no celular.
    expect(enviados.join('\n')).toContain('foi isso que a pessoa falou');
    expect(anexos).toEqual([]);

    // O prompt chegou montado do arquivo, com a entrada como variável.
    expect(runner.chamadas[0]!.prompt).toContain('https://exemplo/video');
    expect(runner.chamadas[0]!.timeoutMs).toBe(60_000);
  });

  it('agente que não cumpre o contrato falha o job e AVISA no chat', async () => {
    await mandar('transcrever: https://exemplo/video');

    // Primeira tentativa: sem `RESULT:` nem `ERRO:`. Como max_tentativas=2, isso
    // volta pra fila com backoff — retentativa não é conclusão, e por isso o
    // chat NÃO é avisado ainda (§8 fala de término, não de tropeço).
    await worker(new FakeRunner({ respostas: ['terminei, tudo certo!'] })).passo();
    expect(fila.obter(1)!.status).toBe('queued');
    expect(enviados).toEqual([]);

    // Passado o backoff, a segunda tentativa esgota as tentativas: agora sim é
    // término, e o chat tem que saber — silêncio nunca é estado válido.
    t += 120;
    await worker(new FakeRunner({ respostas: ['de novo sem contrato'] })).passo();
    const job = fila.obter(1)!;
    expect(job.status).toBe('failed');
    expect(job.erro).toMatch(/RESULT/);
    expect(enviados.join('\n')).toContain('falhou');
  });

  it('agente que declara ERRO: falha com o motivo dele', async () => {
    await mandar('transcrever: https://exemplo/video');
    await worker(new FakeRunner({ respostas: ['ERRO: yt-dlp não achou o vídeo'] })).passo();
    expect(fila.obter(1)!.erro).toContain('yt-dlp');
  });
});

// Skill plugada de um repo externo (`plugar-repo.sh`): o prompt gerado cita
// `{{repo}}/script.sh` em vez de um caminho de máquina, porque `config/` é
// versionado e roda também na VPS. Quem dá valor ao placeholder é a execução,
// resolvendo o NOME da pasta contra o `PROJETOS_DIR` do boot.
//
// Sem isso o job morria em "placeholder sem valor: repo" no PRIMEIRO uso —
// depois de a instalação inteira ter dito "plugado".
describe('skill de repo externo', () => {
  it('resolve {{repo}} contra o PROJETOS_DIR', async () => {
    writeFileSync(join(dir, 'prompts', 'ext.md'), 'rode bash {{repo}}/x.sh "{{input}}" > {{saida}}');
    const externas = validarSkills([{
      command: 'analisa', fila: 'io', kind: 'agent', prompt: 'prompts/ext.md',
      repo: 'ferramenta', artefato_exts: ['md'], max_tentativas: 1,
      timeout_segundos: 60, aceita_destino: false, descricao: 'd', exemplo: 'ex',
    }], dir);

    const promptDe = criarPromptDe({
      defs: externas, raizRepo: dir, projetosDir: join(dir, 'projetos'),
      raizArtefatos: join(dir, 'artefatos'), cwd: dir,
      perfilPadrao: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    });
    const job = fila.enfileirar({
      fila: 'io', kind: 'agent', tarefa: 'analisa',
      input: JSON.stringify({ entrada: 'https://exemplo/v' }), max_tentativas: 1,
    });

    const ctx = await promptDe(fila.obter(job.id)!);
    expect(ctx.prompt).toContain(`bash ${join(dir, 'projetos', 'ferramenta')}/x.sh`);
    expect(ctx.prompt).not.toContain('{{repo}}');
  });
});
