// O motor de fluxos com fila REAL e runner fake, contra um `flow.json` de
// brinquedo — 3 fases, 2 alvos, a primeira de escopo `fluxo` (§6.3).
//
// É aqui que as propriedades da etapa 5 são provadas: avanço independente por
// alvo, falha isolada, definição congelada, atomicidade, `/refazer` seletivo e
// export/import.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { carregarFlow, hashDefinicao, type FlowDef } from '../dominio/flow.js';
import { FilaSqlite } from '../fila/store.js';
import { EstadoFluxos } from '../fluxos/estado.js';
import { exportarFluxo, importarFluxo } from '../fluxos/exportar.js';
import { Fluxos } from '../fluxos/runtime.js';
import type { Job } from '../fila/types.js';

let dir: string;
let dominio: string;
let fila: FilaSqlite;
let estado: EstadoFluxos;
let fluxos: Fluxos;
let def: FlowDef;
let t = 1_000;

/** Repo de domínio de brinquedo: 3 fases (a 1ª global), 2 alvos. */
function escreverDominio(): void {
  dominio = join(dir, 'dominio');
  mkdirSync(join(dominio, 'prompts'), { recursive: true });
  writeFileSync(join(dominio, 'prompts', 'texto.md'), 'escreva sobre {{input}} em {{saida}}');
  writeFileSync(join(dominio, 'prompts', 'render.md'), 'renderize {{input}} em {{saida}}');
  writeFileSync(join(dominio, 'flow.json'), JSON.stringify({
    nome: 'brinquedo', prefixo: 'B', versao_def: 1,
    alvos: { mulheres: { canal: 'lives21' }, pais: { canal: 'lives32' } },
    fases: [
      { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/texto.md' },
      { id: 'render', escopo: 'alvo', fila: 'render', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/render.md', max_tentativas: 2 },
      { id: 'entregar', escopo: 'alvo', fila: 'io', kind: 'function', tarefa: 'fluxo-entrega' },
    ],
  }, null, 2));
}

beforeEach(() => {
  t = 1_000;
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-fluxos-'));
  escreverDominio();
  const db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  estado = new EstadoFluxos(db, () => t);
  fluxos = new Fluxos({ fila, estado, agora: () => t });
  def = carregarFlow(dominio);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function criar(alvos?: string[]): number {
  return fluxos.criar({
    tipo: 'brinquedo', definicao: def, hash: hashDefinicao(def, dominio),
    assunto: 'Assunto de teste', alvos, chatId: 42,
  }).id;
}

/**
 * Reclama ESTE job. `pegar` devolve o primeiro elegível da fila, e numa fase de
 * escopo `alvo` há mais de um job na mesma fila — sem isto, o teste ackava um
 * job diferente do que pretendia e passava (ou falhava) pelo motivo errado.
 */
function reclamar(id: number): void {
  const alvo = fila.obter(id)!;
  if (alvo.status === 'running') return;
  for (let i = 0; i < 10; i += 1) {
    const pego = fila.pegar(alvo.fila, 600, 'W');
    if (!pego || pego.id === id) return;
  }
  throw new Error(`não consegui reclamar o job ${id}`);
}

/** Fecha um job como o worker faria — com o avanço DENTRO da transação do ack. */
function concluirJob(id: number, resultado = 'ok'): void {
  reclamar(id);
  fila.concluir(id, resultado, 'W', (job) => fluxos.avancar(job));
}

function falharJob(id: number, erro = 'deu ruim'): 'requeued' | 'failed' {
  reclamar(id);
  return fila.falhar(id, erro, 'W', 1, (j: Job) => fluxos.avancar(j));
}

const faseDe = (fluxoId: number, fase: string, alvo = '') => estado.fase(fluxoId, fase, alvo)!;

describe('criação e primeira fase', () => {
  it('cria as fases de todos os alvos e enfileira só a primeira', () => {
    const id = criar();
    // 1 fase global + 2 fases por alvo × 2 alvos = 5 linhas.
    expect(estado.fases(id)).toHaveLength(5);
    // Só a fase global entrou na fila.
    expect(fila.listar()).toHaveLength(1);
    const job = fila.listar()[0]!;
    expect(job.fila).toBe('texto');
    expect(job.flow_ref).toBe('B#1//texto');
    // O chat_id do JOB é nulo de propósito: quem fala com o chat é o fluxo.
    expect(job.chat_id).toBeNull();
  });

  it('subconjunto de alvos é respeitado; alvo inventado é recusado', () => {
    const id = criar(['mulheres']);
    expect(estado.fases(id).filter((f) => f.alvo === 'pais')).toHaveLength(0);
    expect(() => criar(['inexistente'])).toThrow(/alvo desconhecido/);
  });

  it('o input do job carrega o alvo e os dados dele (canal por NOME, não caminho)', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const render = fila.listar().find((j) => j.flow_ref?.includes('/render'))!;
    const input = JSON.parse(render.input) as { fluxo: { alvo: string; canal: string } };
    expect(['mulheres', 'pais']).toContain(input.fluxo.alvo);
    expect(['lives21', 'lives32']).toContain(input.fluxo.canal);
    expect(input.fluxo.canal).not.toContain('/');
    void id;
  });
});

describe('avanço', () => {
  it('fase global alimenta TODOS os alvos', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    expect(faseDe(id, 'texto').estado).toBe('feito');
    const renders = fila.listar().filter((j) => j.flow_ref?.includes('/render'));
    expect(renders).toHaveLength(2);
  });

  // §3.5: cada alvo caminha independente, sem barreira entre fases.
  it('um alvo pode estar na fase 3 enquanto o outro ainda está na 2', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const render = fila.listar().find((j) => j.flow_ref === 'B#1/mulheres/render')!;
    concluirJob(render.id);

    expect(faseDe(id, 'render', 'mulheres').estado).toBe('feito');
    expect(faseDe(id, 'entregar', 'mulheres').estado).toBe('rodando');
    expect(faseDe(id, 'render', 'pais').estado).toBe('rodando');
    expect(faseDe(id, 'entregar', 'pais').estado).toBe('pendente');
  });

  it('o fluxo fecha como feito quando a última fase de todos termina', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    for (const alvo of ['mulheres', 'pais']) {
      concluirJob(fila.listar().find((j) => j.flow_ref === `B#1/${alvo}/render`)!.id);
      concluirJob(fila.listar().find((j) => j.flow_ref === `B#1/${alvo}/entregar`)!.id);
    }
    expect(estado.obter(id)!.status).toBe('feito');
  });
});

describe('falha isolada (§3.6)', () => {
  it('um alvo que falha não impede o outro, e o fluxo fecha como falhou', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);

    // `mulheres` esgota as tentativas da fase render (max_tentativas 2).
    const jobM = fila.listar().find((j) => j.flow_ref === 'B#1/mulheres/render')!;
    expect(falharJob(jobM.id)).toBe('requeued');
    // Retentativa NÃO marca a fase como falhada: ela ainda vai tentar sozinha.
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('rodando');
    t += 60;
    expect(falharJob(jobM.id)).toBe('failed');
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('falhou');

    // `pais` segue até o fim.
    concluirJob(fila.listar().find((j) => j.flow_ref === 'B#1/pais/render')!.id);
    concluirJob(fila.listar().find((j) => j.flow_ref === 'B#1/pais/entregar')!.id);

    expect(faseDe(id, 'entregar', 'pais').estado).toBe('feito');
    // 11 prontos e 1 falhado NÃO é um fluxo feito — dizer que é esconderia o
    // alvo que precisa de /refazer.
    expect(estado.obter(id)!.status).toBe('falhou');
  });
});

describe('fases inalcançáveis depois de uma falha', () => {
  // Deixá-las `pendente` mentiria duas vezes: o fluxo pareceria "rodando" para
  // sempre, e a rede de segurança do boot tentaria enfileirá-las.
  it('as fases seguintes daquele alvo viram pulado', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const j = fila.listar().find((x) => x.flow_ref === 'B#1/mulheres/render')!;
    falharJob(j.id); t += 60; falharJob(j.id);
    expect(faseDe(id, 'entregar', 'mulheres').estado).toBe('pulado');
    // O outro alvo não é tocado.
    expect(faseDe(id, 'entregar', 'pais').estado).toBe('pendente');
  });

  it('e o /refazer as traz de volta para pendente', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const j = fila.listar().find((x) => x.flow_ref === 'B#1/mulheres/render')!;
    falharJob(j.id); t += 60; falharJob(j.id);
    fluxos.refazer(id, 'mulheres');
    expect(faseDe(id, 'entregar', 'mulheres').estado).toBe('pendente');
  });
});

describe('/refazer seletivo (§3.6.3)', () => {
  it('só o que falhou volta, com tentativas zeradas', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const jobM = fila.listar().find((j) => j.flow_ref === 'B#1/mulheres/render')!;
    falharJob(jobM.id);
    t += 60;
    falharJob(jobM.id);

    const antes = fila.listar().length;
    const r = fluxos.refazer(id);
    expect(r.refeitos).toBe(1);
    expect(fila.listar()).toHaveLength(antes + 1);
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('rodando');
    expect(faseDe(id, 'render', 'mulheres').tentativas).toBe(0);
    expect(estado.obter(id)!.status).toBe('rodando');
  });

  it('nada a refazer quando nada falhou', () => {
    const id = criar();
    expect(fluxos.refazer(id).refeitos).toBe(0);
  });

  it('refazer de um alvo só não toca no outro', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    for (const alvo of ['mulheres', 'pais']) {
      const j = fila.listar().find((x) => x.flow_ref === `B#1/${alvo}/render`)!;
      falharJob(j.id); t += 60; falharJob(j.id);
    }
    expect(fluxos.refazer(id, 'pais').refeitos).toBe(1);
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('falhou');
    expect(faseDe(id, 'render', 'pais').estado).toBe('rodando');
  });
});

describe('definição congelada (§3.4)', () => {
  it('editar o flow.json no disco NÃO muda um fluxo em voo', () => {
    const id = criar();
    // Alguém acrescenta um alvo e troca uma fase enquanto o fluxo roda.
    writeFileSync(join(dominio, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 2,
      alvos: { mulheres: { canal: 'lives21' }, pais: { canal: 'lives32' }, novo: { canal: 'lives99' } },
      fases: [{ id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/texto.md' }],
    }));

    concluirJob(fila.listar()[0]!.id);
    // O fluxo em voo continua com 2 alvos e 3 fases — as regras não mudaram.
    expect(estado.definicaoDe(estado.obter(id)!).fases).toHaveLength(3);
    expect(fila.listar().filter((j) => j.flow_ref?.includes('/render'))).toHaveLength(2);
    expect(estado.fases(id).some((f) => f.alvo === 'novo')).toBe(false);
  });

  it('o hash cobre o CONTEÚDO dos prompts, não só o JSON', () => {
    const antes = hashDefinicao(def, dominio);
    writeFileSync(join(dominio, 'prompts', 'texto.md'), 'instrução completamente outra {{input}} {{saida}}');
    expect(hashDefinicao(def, dominio)).not.toBe(antes);
  });
});

describe('atomicidade do avanço (o defeito do v1)', () => {
  // No v1 eram duas escritas: o watcher via `done` e depois enfileirava. Um
  // crash no meio deixava a fase feita e a próxima nunca enfileirada — ou
  // enfileirada duas vezes. Aqui é uma transação só.
  it('gancho que lança desfaz o ack inteiro — nada fica pela metade', () => {
    const id = criar();
    const job = fila.listar()[0]!;
    fila.pegar('texto', 60, 'W');

    expect(() => fila.concluir(job.id, 'ok', 'W', () => {
      throw new Error('crash no meio do avanço');
    })).toThrow(/crash/);

    // O job NÃO ficou done, a fase NÃO ficou feita, e nenhuma fase nova entrou.
    expect(fila.obter(job.id)!.status).toBe('running');
    expect(faseDe(id, 'texto').estado).toBe('rodando');
    expect(fila.listar()).toHaveLength(1);
  });
});

describe('cancelamento (§3.7)', () => {
  it('cancela os jobs vivos e marca as fases como pulado', () => {
    const id = criar();
    const r = fluxos.cancelar(id);
    expect(r.cancelados).toBe(1);
    expect(estado.obter(id)!.status).toBe('cancelado');
    expect(estado.fases(id).every((f) => f.estado === 'pulado')).toBe(true);
    expect(fila.listar()[0]!.status).toBe('canceled');
  });

  it('cancelar um alvo não mexe no outro', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    fluxos.cancelar(id, 'pais');
    expect(faseDe(id, 'render', 'pais').estado).toBe('pulado');
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('rodando');
  });
});

describe('export/import (§7.6)', () => {
  it('exporta e reconstrói o mesmo estado por fase', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const pacote = exportarFluxo(estado, id);

    const novo = importarFluxo(estado, JSON.parse(JSON.stringify(pacote)));
    expect(novo.id).not.toBe(id);
    expect(novo.assunto).toBe('Assunto de teste');

    const original = estado.fases(id);
    const copia = estado.fases(novo.id);
    expect(copia).toHaveLength(original.length);
    expect(copia.find((f) => f.fase === 'texto')!.estado).toBe('feito');
    // Fase que estava `rodando` volta como `pendente`: os jobs pertenciam ao
    // banco de origem, e a rede de segurança do boot reenfileira.
    expect(copia.find((f) => f.fase === 'render')!.estado).toBe('pendente');
    expect(copia.every((f) => f.job_id === null)).toBe(true);
  });

  it('a definição vem do PACOTE, não do disco de hoje', () => {
    const id = criar();
    const pacote = exportarFluxo(estado, id);
    writeFileSync(join(dominio, 'flow.json'), '{"quebrado": true}');
    const novo = importarFluxo(estado, pacote);
    expect(estado.definicaoDe(novo).fases).toHaveLength(3);
  });

  it('formato desconhecido é recusado', () => {
    expect(() => importarFluxo(estado, { formato: 99 })).toThrow(/formato/);
  });
});

describe('rede de segurança do boot (§3.6c)', () => {
  it('fase pendente sem job é reenfileirada', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id); // libera a fase render
    // Simula o banco restaurado de um backup: a fase existe, o job não.
    estado.atualizarFase(id, 'render', 'mulheres', { estado: 'pendente', job_id: null });
    expect(fluxos.reenfileirarOrfas()).toBe(1);
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('rodando');
  });

  it('não reenfileira fase que já tem job', () => {
    criar();
    expect(fluxos.reenfileirarOrfas()).toBe(0);
  });

  // Toda fase futura nasce `pendente` sem job: ela espera a vez. Enfileirá-la
  // atropelaria a ordem do fluxo inteiro.
  it('fase futura (a anterior ainda não terminou) NÃO é considerada órfã', () => {
    const id = criar();
    expect(faseDe(id, 'render', 'mulheres').estado).toBe('pendente');
    expect(fluxos.reenfileirarOrfas()).toBe(0);
  });
});

describe('modo sombra (§7.5)', () => {
  it('monta o plano completo sem enfileirar nada', () => {
    const plano = fluxos.sombra({
      tipo: 'brinquedo', definicao: def, hash: 'x', assunto: 'teste',
    });
    expect(plano).toHaveLength(5);
    expect(plano[0]).toEqual({
      fase: 'texto', alvo: '(todos)', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
    });
    expect(fila.listar()).toHaveLength(0);
    expect(estado.listar()).toHaveLength(0);
  });
});
