// Roteamento completo de uma mensagem, com os dois agentes fakes (§6.1: nenhum
// teste toca a API do Telegram nem o `claude`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { validarSkills, type SkillDef } from '../dominio/registry.js';
import { FakeRunner } from '../fila/runner.js';
import { FilaSqlite } from '../fila/store.js';
import { montarPromptInterpret } from './interpret.js';
import { tratarMensagem, type DepsMensagem } from './mensagem.js';

let dir: string;
let projetos: string;
let fila: FilaSqlite;
let defs: SkillDef[];
const t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-msg-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'p.md'), '{{input}} {{saida}}');
  projetos = join(dir, 'projetos');
  mkdirSync(join(projetos, 'yt-pub-lives3', 'imports', 'videos'), { recursive: true });

  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);

  const comum = {
    fila: 'texto', kind: 'agent', prompt: 'prompts/p.md', artefato_exts: ['txt'],
    max_tentativas: 2, timeout_segundos: 60, descricao: 'd', exemplo: 'ex',
  };
  defs = validarSkills([
    { ...comum, command: 'transcrever', aceita_destino: false },
    { ...comum, command: 'dublar', artefato_exts: ['mp4'], aceita_destino: true },
  ], dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(respostas: string[]): DepsMensagem {
  return {
    fila,
    agora: () => t,
    defs,
    projetosDir: projetos,
    runner: new FakeRunner({ respostas }),
    perfil: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    cwd: dir,
    logFile: join(dir, 'servico.log'),
  };
}

describe('tratarMensagem', () => {
  it('/ajuda é o resumo e /ajuda tudo é a lista inteira', async () => {
    const d = deps([]);
    const curta = await tratarMensagem(1, '/ajuda', d);
    expect(curta).toContain('/ajuda tudo');
    expect(curta).not.toContain('/furar');

    const completa = await tratarMensagem(1, '/ajuda tudo', d);
    expect(completa).toContain('/furar');
    expect(completa).not.toContain('não conheço');
  });

  it('comando de serviço nem chega no agente', async () => {
    const d = deps([]); // nenhuma resposta preparada: se chamar o runner, dá vazio
    expect(await tratarMensagem(1, '/ping', d)).toBe('pong');
  });

  it('skill digitada enfileira direto, sem passar pelo interpretador', async () => {
    const runner = new FakeRunner({ respostas: [] });
    const r = await tratarMensagem(1, 'transcrever: http://x', { ...deps([]), runner });
    expect(r).toContain('job j1');
    expect(runner.chamadas).toHaveLength(0);
  });

  it('texto livre vira job quando o interpretador identifica um pedido', async () => {
    const r = await tratarMensagem(9, 'me dá o texto desse vídeo aí: http://x', deps([
      JSON.stringify({ jobs: [{ command: 'transcrever', entrada: 'http://x' }], ignorado: null }),
    ]));
    const job = fila.obter(1)!;
    expect(job.tarefa).toBe('transcrever');
    expect(job.chat_id).toBe(9);
    expect(r).toContain('job j1');
  });

  it('parte não atendida do pedido é dita, não engolida', async () => {
    const r = await tratarMensagem(1, 'transcreve e manda por email', deps([
      JSON.stringify({ jobs: [{ command: 'transcrever', entrada: 'http://x' }], ignorado: 'mandar por e-mail' }),
    ]));
    expect(r).toContain('e-mail');
  });

  it('resolve destino pedido em linguagem natural', async () => {
    await tratarMensagem(1, 'dubla e joga no lives3', deps([
      JSON.stringify({ jobs: [{ command: 'dublar', entrada: 'http://x', destino: 'lives3' }] }),
    ]));
    expect(JSON.parse(fila.obter(1)!.input).destino).toContain('yt-pub-lives3');
  });

  // O agente alucina comando. Catálogo fechado (§9) quer dizer RECUSAR — não
  // "tentar assim mesmo" com uma tarefa que ninguém sabe executar.
  it('recusa skill inventada pelo interpretador, sem enfileirar nada', async () => {
    const r = await tratarMensagem(1, 'faz um carrossel', deps([
      JSON.stringify({ jobs: [{ command: 'carrossel', entrada: 'x' }] }),
    ]));
    expect(r).toContain('carrossel');
    expect(fila.listar()).toHaveLength(0);
  });

  it('destino inexistente é recusado com a lista dos válidos', async () => {
    const r = await tratarMensagem(1, 'dubla e joga no lives99', deps([
      JSON.stringify({ jobs: [{ command: 'dublar', entrada: 'http://x', destino: 'lives99' }] }),
    ]));
    expect(r).toContain('lives3');
    expect(fila.listar()).toHaveLength(0);
  });

  it('RECUSAR: do agente vira a resposta, sem job', async () => {
    const r = await tratarMensagem(1, 'joga xadrez comigo', deps(['RECUSAR: não jogo xadrez']));
    expect(r).toContain('xadrez');
    expect(fila.listar()).toHaveLength(0);
  });

  it('resposta inválida do agente não vira job nem exceção', async () => {
    const r = await tratarMensagem(1, 'qualquer coisa', deps(['isso não é json']));
    expect(r.length).toBeGreaterThan(0);
    expect(fila.listar()).toHaveLength(0);
  });

  it('pergunta é respondida com o contexto, em segunda chamada ao agente', async () => {
    fila.enfileirar({ fila: 'texto', kind: 'agent', tarefa: 'transcrever', input: '{}', chat_id: 5 });
    const runner = new FakeRunner({
      respostas: [JSON.stringify({ pergunta: 'terminou?' }), 'ainda está na fila.'],
    });
    const r = await tratarMensagem(5, 'já terminou?', { ...deps([]), runner });
    expect(r).toBe('ainda está na fila.');
    // O prompt da resposta carrega o job DESTE chat.
    expect(runner.chamadas[1]!.prompt).toContain('job 1');
  });

  it('o log que entra no contexto da resposta passa pelo redator', async () => {
    writeFileSync(join(dir, 'servico.log'), 'boot ok\nBOT_TOKEN=1234567890:AAsegredoqueNAOpodesairdaqui000000000\n');
    const runner = new FakeRunner({ respostas: [JSON.stringify({ pergunta: 'e aí?' }), 'tudo certo.'] });
    await tratarMensagem(1, 'e aí?', {
      ...deps([]),
      runner,
      redigir: (t2) => t2.replace(/\d{8,}:[A-Za-z0-9_-]{30,}/g, '«redigido»'),
    });
    expect(runner.chamadas[1]!.prompt).not.toContain('segredoqueNAOpodesair');
  });

  it('contexto da resposta NUNCA carrega job de outro chat', async () => {
    fila.enfileirar({ fila: 'texto', kind: 'agent', tarefa: 'transcrever', input: '{}', chat_id: 777 });
    const runner = new FakeRunner({ respostas: [JSON.stringify({ pergunta: 'e aí?' }), 'nada seu por aqui.'] });
    await tratarMensagem(5, 'e aí?', { ...deps([]), runner });
    expect(runner.chamadas[1]!.prompt).not.toContain('job 1');
  });
});

describe('montarPromptInterpret', () => {
  it('lista as skills reais e marca o texto do usuário como DADO', () => {
    const p = montarPromptInterpret('faz isso', defs, ['lives3']);
    expect(p).toContain('transcrever');
    expect(p).toContain('lives3');
    expect(p).toMatch(/DADO do usuário/);
  });
});
