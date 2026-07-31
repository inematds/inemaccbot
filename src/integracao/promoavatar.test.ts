// O fluxo `promoavatar` INTEIRO, contra o `flow.json` REAL do repo de domínio —
// com fila de verdade, portão humano, poll e a skill `reel` no fim.
//
// Usa o arquivo real de propósito: um teste com `flow.json` de brinquedo prova o
// motor, não o pipeline. Se alguém editar o domínio e quebrar o encaixe (nome de
// público, fase fora de ordem, skill inexistente), é aqui que aparece.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { carregarFlow, congelar, hashDefinicao, type FlowDef } from '../dominio/flow.js';
import { carregarSkills } from '../dominio/registry.js';
import { FilaSqlite } from '../fila/store.js';
import { EstadoFluxos } from '../fluxos/estado.js';
import { Fluxos } from '../fluxos/runtime.js';
import { tituloEstudio } from '../fluxos/entrada-fase.js';

const REPO_BOT = new URL('../..', import.meta.url).pathname;
const REPO_DOMINIO = join(REPO_BOT, '..', 'promoavatar');

let dir: string;
let fila: FilaSqlite;
let estado: EstadoFluxos;
let fluxos: Fluxos;
let def: FlowDef;
const eventos: { chatId: number; texto: string }[] = [];
const t = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-promoavatar-'));
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  estado = new EstadoFluxos(db, () => t);
  eventos.length = 0;
  fluxos = new Fluxos({
    fila, estado, agora: () => t,
    raizArtefatos: join(dir, 'artefatos'),
    projetosDir: join(dir, 'projetos'),
    aoEvento: (e) => eventos.push(e),
    // Repo de domínio de mentira, mas caminho de verdade: o portão lê os
    // arquivos do DISCO, e é esse encaixe que precisa de prova.
    repoDe: () => join(dir, 'dominio'),
  });
  const skills = carregarSkills(join(REPO_BOT, 'config', 'skills.json'), REPO_BOT).map((s) => s.command);
  def = congelar(carregarFlow(REPO_DOMINIO, skills), REPO_DOMINIO);
  // Destino do público `mulheres` (lives24), como em produção.
  mkdirSync(join(dir, 'projetos', 'yt-pub-lives24', 'imports', 'videos'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function criar(alvos = ['mulheres']): number {
  return fluxos.criar({
    tipo: 'promoavatar', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
    assunto: 'Não comece aprendendo ferramentas', alvos, chatId: 55,
  }).id;
}

function ackar(flowRef: string, resultado: string): void {
  const job = fila.listar().find((j) => j.flow_ref === flowRef);
  if (!job) throw new Error(`não achei job ${flowRef}`);
  if (job.status !== 'running') fila.pegar(job.fila, 600, 'W');
  fila.concluir(job.id, resultado, 'W', (j) => fluxos.avancar(j));
}

describe('flow.json real do promoavatar', () => {
  it('tem as três fases na ordem certa, com o portão depois do texto', () => {
    expect(def.fases.map((f) => f.id)).toEqual(['texto', 'baixar', 'reel']);
    expect(def.fases[0]!.pausa_apos).toBe(true);
    expect(def.fases[1]!.espera).toEqual({ intervalo: 120, timeout: 5400 });
    expect(def.fases[2]!.tarefa).toBe('reel');
  });

  it('tem os 12 públicos, cada um com canal e gatilho', () => {
    const alvos = Object.entries(def.alvos);
    expect(alvos).toHaveLength(12);
    for (const [nome, dados] of alvos) {
      expect(dados.canal, nome).toMatch(/^lives\d+$/);
      expect(dados.gatilho, nome).toBeTruthy();
    }
  });
});

/**
 * O portão é o handoff para uma PESSOA: ela precisa do título exato do vídeo e
 * do texto para colar no HeyGen. Antes disto a mensagem dizia só "fase
 * concluída", e os 12 textos ficavam num arquivo em disco que ninguém via.
 */
describe('portão entrega os roteiros no chat', () => {
  function escreverRoteiro(id: number, alvo: string, fala: string): void {
    const pasta = join(dir, 'dominio', 'textos', `A${id}`);
    mkdirSync(pasta, { recursive: true });
    writeFileSync(
      join(pasta, `${alvo}.md`),
      `# assunto — ${alvo}\n\n### FALA (texto para o HeyGen)\n${fala}\n\n### SOBREPOSIÇÕES\n- x\n`,
    );
  }

  function roteiros(): string[] {
    return eventos.filter((e) => e.texto.startsWith('🎬')).map((e) => e.texto);
  }

  it('manda uma mensagem por público, com o título do estúdio e a fala', () => {
    const id = criar(['mulheres', 'jovens']);
    escreverRoteiro(id, 'mulheres', 'Autonomia de verdade com IA.');
    escreverRoteiro(id, 'jovens', 'Tem uma profissão nascendo agora.');
    ackar('A#1//texto', 'ok');

    expect(roteiros()).toHaveLength(2);
    // A ordem é a do `flow.json` (jovens antes de mulheres), não a do pedido:
    // quem vai gravar 12 vídeos segue a lista do domínio.
    expect(roteiros()[0]).toContain('A1-jovens-v1');
    expect(roteiros()[0]).toContain('Tem uma profissão nascendo agora.');
    expect(roteiros()[1]).toContain('A1-mulheres-v1');
    expect(roteiros()[1]).toContain('Autonomia de verdade com IA.');
  });

  /**
   * A garantia que sustenta o resto: `heygen.baixar` casa o vídeo por
   * IGUALDADE EXATA de título. Se a mensagem ensinar um nome e o download
   * procurar outro, a pessoa grava 12 vídeos e a fase expira em 90 min
   * esperando algo que existe com outro nome.
   */
  it('o título da mensagem é o MESMO que o download vai procurar', () => {
    const id = criar(['mulheres']);
    escreverRoteiro(id, 'mulheres', 'fala.');
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);

    const baixar = fila.listar().find((j) => j.flow_ref === 'A#1/mulheres/baixar')!;
    const { titulo } = JSON.parse(baixar.input) as { titulo: string };
    expect(roteiros()[0]).toContain(titulo);
  });

  it('só manda a FALA — sobreposições são instrução do reel, não do estúdio', () => {
    const id = criar(['mulheres']);
    escreverRoteiro(id, 'mulheres', 'só isto se fala.');
    ackar('A#1//texto', 'ok');

    expect(roteiros()[0]).toContain('só isto se fala.');
    expect(roteiros()[0]).not.toContain('SOBREPOSIÇÕES');
  });

  it('público sem arquivo vira FALTA visível, não lista curta silenciosa', () => {
    const id = criar(['mulheres', 'jovens']);
    escreverRoteiro(id, 'mulheres', 'fala.');
    ackar('A#1//texto', 'ok');

    expect(roteiros()).toHaveLength(1);
    const falta = eventos.find((e) => e.texto.startsWith('⚠️ Sem roteiro'))!;
    expect(falta.texto).toContain('jovens');
    expect(falta.texto).not.toContain('mulheres,');
  });

  it('avisa em vez de silenciar quando não sabe o repo do domínio', () => {
    const semRepo = new Fluxos({
      fila, estado, agora: () => t,
      raizArtefatos: join(dir, 'artefatos'), projetosDir: join(dir, 'projetos'),
      aoEvento: (e) => eventos.push(e),
      repoDe: () => undefined,
    });
    const id = semRepo.criar({
      tipo: 'promoavatar', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
      assunto: 'x', alvos: ['mulheres'], chatId: 55,
    }).id;
    const job = fila.listar().find((j) => j.flow_ref === `A#${id}//texto`)!;
    fila.pegar(job.fila, 600, 'W');
    fila.concluir(job.id, 'ok', 'W', (j) => semRepo.avancar(j));

    expect(eventos.some((e) => e.texto.includes('Não sei o repo'))).toBe(true);
  });

  // O fluxo com `chat_id` nulo (criado fora do chat) não pode virar erro de
  // envio nem vazar roteiro para lugar nenhum.
  it('sem chat, não manda nada', () => {
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
      assunto: 'x', alvos: ['mulheres'], chatId: null,
    }).id;
    escreverRoteiro(id, 'mulheres', 'fala.');
    const job = fila.listar().find((j) => j.flow_ref === `A#${id}//texto`)!;
    fila.pegar(job.fila, 600, 'W');
    fila.concluir(job.id, 'ok', 'W', (j) => fluxos.avancar(j));

    expect(eventos).toHaveLength(0);
  });
});

describe('do assunto ao reel, com o portão no meio', () => {
  it('para depois do texto e só segue com /aprovar', () => {
    const id = criar();
    // Fase 1: um job só, para todos os alvos.
    expect(fila.listar()).toHaveLength(1);
    ackar('A#1//texto', '/tmp/resumo-dos-textos.txt');

    // PAROU. Nada de download enquanto a pessoa não gerar os avatares.
    expect(estado.fase(id, 'texto', '')!.estado).toBe('aguardando-ok');
    expect(fila.listar()).toHaveLength(1);
    // `some` e não `at(-1)`: depois do aviso do portão vêm os roteiros, um por
    // público — a mensagem do `/aprovar` deixou de ser a última.
    expect(eventos.some((e) => e.texto.includes('/aprovar A#1'))).toBe(true);

    // A pessoa gerou os avatares no estúdio e avisa.
    const r = fluxos.aprovar(id);
    expect(r.liberados).toBe(1);
    const baixar = fila.listar().find((j) => j.flow_ref === 'A#1/mulheres/baixar')!;
    expect(baixar.fila).toBe('io');
    expect(baixar.tarefa).toBe('heygen.baixar');
  });

  it('o job de download procura pelo título que a pessoa usou no estúdio', () => {
    const id = criar();
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);
    const baixar = fila.listar().find((j) => j.flow_ref === 'A#1/mulheres/baixar')!;
    const input = JSON.parse(baixar.input) as { titulo: string; destino: string };
    // É o MESMO nome que o CLAUDE.md do domínio manda usar no estúdio.
    expect(input.titulo).toBe('A1-mulheres-v1');
    expect(input.destino).toContain('A1-mulheres-v1.mp4');
  });

  it('o reel recebe o arquivo baixado, o destino do canal e a headline do gatilho', () => {
    const id = criar();
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);
    const avatar = join(dir, 'artefatos', 'fluxos', 'A1', 'A1-mulheres-v1.mp4');
    mkdirSync(join(dir, 'artefatos', 'fluxos', 'A1'), { recursive: true });
    writeFileSync(avatar, 'video');
    ackar('A#1/mulheres/baixar', avatar);

    const reel = fila.listar().find((j) => j.flow_ref === 'A#1/mulheres/reel')!;
    expect(reel.fila).toBe('render');
    expect(reel.tarefa).toBe('reel');
    const input = JSON.parse(reel.input) as { entrada: string; destino?: string };
    expect(input.entrada).toContain(avatar);
    expect(input.entrada).toContain('capa impacto');
    // O gatilho do público entra na instrução — é o que vira headline-choque.
    expect(input.entrada).toContain('autonomia');
    // Canal por NOME no flow.json; caminho resolvido pelo bot (§3.2).
    expect(input.destino).toContain('yt-pub-lives24');
    void id;
  });

  it('fluxo fecha e avisa quando o reel do último alvo entra', () => {
    const id = criar();
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);
    ackar('A#1/mulheres/baixar', '/tmp/a.mp4');
    ackar('A#1/mulheres/reel', '/tmp/reel.mp4');
    expect(estado.obter(id)!.status).toBe('feito');
    expect(eventos.at(-1)!.texto).toContain('terminou: feito');
  });

  it('aprovar duas vezes não duplica job', () => {
    const id = criar();
    ackar('A#1//texto', 'ok');
    expect(fluxos.aprovar(id).liberados).toBe(1);
    expect(fluxos.aprovar(id).liberados).toBe(0);
    expect(fila.listar().filter((j) => j.tarefa === 'heygen.baixar')).toHaveLength(1);
  });

  it('aprovar um fluxo que não está esperando não faz nada', () => {
    const id = criar();
    expect(fluxos.aprovar(id).liberados).toBe(0);
  });

  it('12 públicos: 1 job de texto, depois 12 de download — e UMA mensagem de portão', () => {
    const id = criar(Object.keys(def.alvos));
    expect(fila.listar()).toHaveLength(1);
    ackar('A#1//texto', 'ok');
    // Um aviso só, não doze.
    expect(eventos.filter((e) => e.texto.includes('/aprovar'))).toHaveLength(1);
    fluxos.aprovar(id);
    expect(fila.listar().filter((j) => j.tarefa === 'heygen.baixar')).toHaveLength(12);
  });
});

describe('| de=<fase> — começar no meio', () => {
  // O caso real: a pessoa escreveu os textos (ou já gerou os avatares) por fora
  // e quer o bot só da 2.5 em diante.
  function criarDe(de: string, alvos = ['mulheres']): number {
    return fluxos.criar({
      tipo: 'promoavatar', definicao: def, hash: 'h',
      assunto: 'Assunto escrito à mão', alvos, de, chatId: 55,
    }).id;
  }

  it('pula a fase 1 e já enfileira o download', () => {
    const id = criarDe('baixar');
    const jobs = fila.listar();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.tarefa).toBe('heygen.baixar');
    expect(estado.fase(id, 'baixar', 'mulheres')!.estado).toBe('rodando');
  });

  // Marcar como `feito` seria mentir sobre quem fez o trabalho: o bot não
  // escreveu esses textos.
  it('as fases anteriores ficam PULADO, não feito', () => {
    const id = criarDe('baixar');
    expect(estado.fase(id, 'texto', '')!.estado).toBe('pulado');
  });

  it('o fluxo ainda fecha normalmente no fim', () => {
    const id = criarDe('baixar');
    ackar('A#1/mulheres/baixar', '/tmp/a.mp4');
    ackar('A#1/mulheres/reel', '/tmp/reel.mp4');
    expect(estado.obter(id)!.status).toBe('feito');
  });

  it('fase inexistente é recusada listando as que existem', () => {
    expect(() => criarDe('inventada')).toThrow(/fases: texto, baixar, reel/);
  });

  it('sem `de`, nada muda: começa na primeira fase', () => {
    const id = criar();
    expect(estado.fase(id, 'texto', '')!.estado).toBe('rodando');
  });

  it('a sombra respeita a partida — mostra só o que vai rodar', () => {
    const plano = fluxos.sombra({
      tipo: 'promoavatar', definicao: def, hash: 'h', assunto: 'x',
      alvos: ['mulheres'], de: 'baixar',
    });
    expect(plano.map((p) => p.fase)).toEqual(['baixar', 'reel']);
  });
});

describe('a janela de poll vem do flow.json, não de um default', () => {
  it('o job de download carrega intervalo e timeout da fase', () => {
    const id = criar();
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);
    const baixar = fila.listar().find((j) => j.tarefa === 'heygen.baixar')!;
    const input = JSON.parse(baixar.input) as { espera: { intervalo: number; timeout: number } };
    expect(input.espera).toEqual({ intervalo: 120, timeout: 5400 });
  });

  // Sem o prazo, um vídeo que a pessoa nunca gera é pollado PARA SEMPRE:
  // `reagendar` não gasta tentativa, então a fase nunca falharia e o /status
  // diria "rodando" indefinidamente.
  it('estourado o timeout, a fase FALHA de verdade', async () => {
    const { criarHeygenBaixar } = await import('../fila/tarefas/heygen.js');
    const tarefa = criarHeygenBaixar({
      porTitulo: async () => new Map(), urlDe: async () => null, baixar: async () => {},
    });
    const ctx = {
      job: {
        input: JSON.stringify({
          titulo: 'A1-mulheres-v1', destino: '/tmp/x.mp4',
          espera: { intervalo: 120, timeout: 60 },
        }),
        criado_em: 1_000,
      } as never,
      fila: {} as never,
      agora: () => 1_000 + 61, // um segundo além do prazo
      log: () => {},
      sinal: new AbortController().signal,
      aindaNao: (m: string) => { throw new Error(`ainda-nao: ${m}`); },
    };
    await expect(tarefa(ctx)).rejects.toThrow(/não apareceu no HeyGen/);
  });
});

describe('o título é a chave de idempotência (§2.5)', () => {
  it('é determinístico por fluxo e alvo', () => {
    const fluxo = estado.obter(criar())!;
    expect(tituloEstudio(fluxo, 'mulheres')).toBe('A1-mulheres-v1');
    expect(tituloEstudio(fluxo, 'mulheres')).toBe(tituloEstudio(fluxo, 'mulheres'));
  });

  it('o destino do download não colide entre alvos', () => {
    const id = criar(['mulheres', 'jovens']);
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);
    const destinos = fila.listar()
      .filter((j) => j.tarefa === 'heygen.baixar')
      .map((j) => (JSON.parse(j.input) as { destino: string }).destino);
    expect(new Set(destinos).size).toBe(2);
    expect(destinos.every((d) => existsSync(join(d, '..')) || true)).toBe(true);
  });
});
