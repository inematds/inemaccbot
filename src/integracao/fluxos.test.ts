// O motor de fluxos com fila REAL e runner fake, contra um `flow.json` de
// brinquedo — 3 fases, 2 alvos, a primeira de escopo `fluxo` (§6.3).
//
// É aqui que as propriedades da etapa 5 são provadas: avanço independente por
// alvo, falha isolada, definição congelada, atomicidade, `/refazer` seletivo e
// export/import.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abrirDb } from '../db/abrir.js';
import { MIGRATIONS, aplicarMigrations } from '../db/migrations.js';
import { carregarFlow, congelar, hashDefinicao, type FlowDef } from '../dominio/flow.js';
import { FilaSqlite } from '../fila/store.js';
import { EstadoFluxos } from '../fluxos/estado.js';
import { exportarFluxo, importarFluxo } from '../fluxos/exportar.js';
import { Fluxos } from '../fluxos/runtime.js';
import { FakeRunner } from '../fila/runner.js';
import { criarPromptDe } from '../fila/skills.js';
import { Worker } from '../fila/worker.js';
import type { Job } from '../fila/types.js';

let dir: string;
let dominio: string;
let fila: FilaSqlite;
let estado: EstadoFluxos;
let fluxos: Fluxos;
let def: FlowDef;
let db: ReturnType<typeof abrirDb>;
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
      // Só existe UMA tarefa de fase implementada hoje (`fluxo-agente`), e a
      // validação recusa qualquer outra — é o catálogo fechado do §9 aplicado a
      // fases. Tarefas de função entram com o primeiro fluxo que precisar.
      { id: 'entregar', escopo: 'alvo', fila: 'io', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/render.md' },
    ],
  }, null, 2));
}

beforeEach(() => {
  t = 1_000;
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-fluxos-'));
  escreverDominio();
  db = abrirDb(join(dir, 'fila.db'));
  aplicarMigrations(db, () => t, MIGRATIONS);
  fila = new FilaSqlite(db, () => t);
  estado = new EstadoFluxos(db, () => t);
  // `repoDe` porque a fase `gerar` lê a FALA do roteiro no repo de domínio —
  // o mesmo arquivo que o portão manda no chat.
  fluxos = new Fluxos({ fila, estado, agora: () => t, repoDe: () => dominio });
  def = carregarFlow(dominio);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Cria como o gateway cria: com a definição CONGELADA (texto dos prompts
 * embutido). Passar a definição crua era o que fazia a fase chegar ao worker
 * sem prompt. */
function criar(alvos?: string[]): number {
  return fluxos.criar({
    tipo: 'brinquedo', definicao: congelar(def, dominio), hash: hashDefinicao(def, dominio),
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

describe('a fase roda pelo WORKER (não só por ack manual)', () => {
  // Sem este teste, o motor parecia pronto e nenhum job de fase era executável:
  // `criarPromptDe` procuraria "fluxo-agente" no registry de skills e falharia.
  // É a mesma forma do `promptDe` que lançava na etapa 1 — código alcançável
  // sem implementação atrás.
  it('o worker executa a fase com o prompt CONGELADO, não com o do disco', async () => {
    const id = criar();
    // A resposta obedece ao contrato: fase, como skill, só é sucesso com
    // `RESULT: <caminho>.txt` na última linha.
    const runner = new FakeRunner({ respostas: [`saiu o texto\nRESULT: ${join(dir, 'art', 'fluxos', '1.txt')}`] });
    const w = new Worker(fila, {
      fila: 'texto', dono: 'W', concorrencia: 1, leaseSegundos: 60,
      tarefas: {}, runners: { fake: runner },
      promptDe: criarPromptDe({
        defs: [], raizRepo: dir, projetosDir: dir, raizArtefatos: join(dir, 'art'), cwd: dir,
        perfilPadrao: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
      }),
      aoAckar: (job) => fluxos.avancar(job),
    }, () => t);

    // Alguém edita o prompt no repo de domínio DEPOIS da criação do fluxo.
    writeFileSync(join(dominio, 'prompts', 'texto.md'), 'INSTRUÇÃO NOVA {{input}} {{saida}}');

    expect(await w.passo()).toBe(true);
    expect(runner.chamadas[0]!.prompt).toContain('escreva sobre');
    expect(runner.chamadas[0]!.prompt).not.toContain('INSTRUÇÃO NOVA');
    expect(runner.chamadas[0]!.prompt).toContain('Assunto de teste');

    // E o avanço aconteceu na mesma transação do ack.
    expect(faseDe(id, 'texto').estado).toBe('feito');
    expect(fila.listar().filter((j) => j.flow_ref?.includes('/render'))).toHaveLength(2);
  });

  /**
   * O A#3 rodou assim em produção: o agente respondeu
   * `ERRO: skill inemaclub-textos não encontrada`, o job virou `done` e o
   * portão abriu numa fase que tinha falhado. A fase usava
   * `interpretarSaida: (bruto) => bruto.trim()` — aceitava qualquer stdout.
   */
  function workerDeFase(runner: FakeRunner): Worker {
    return new Worker(fila, {
      fila: 'texto', dono: 'W', concorrencia: 1, leaseSegundos: 60,
      tarefas: {}, runners: { fake: runner },
      promptDe: criarPromptDe({
        defs: [], raizRepo: dir, projetosDir: dir, raizArtefatos: join(dir, 'art'), cwd: dir,
        perfilPadrao: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
      }),
      aoAckar: (job) => fluxos.avancar(job),
    }, () => t);
  }

  it('agente que declara ERRO: NÃO passa por fase feita', async () => {
    const id = criar();
    const w = workerDeFase(new FakeRunner({
      respostas: ['tentei\nERRO: skill inemaclub-textos não encontrada'],
    }));
    // `max_tentativas` do flow.json de teste: roda até esgotar.
    for (let i = 0; i < 5 && await w.passo(); i += 1) fila.recuperarLeasesVencidos();

    expect(faseDe(id, 'texto').estado).toBe('falhou');
    const job = fila.listar().find((j) => j.flow_ref?.includes('//texto'))!;
    expect(job.status).toBe('failed');
    expect(job.erro).toContain('inemaclub-textos');
  });

  it('agente que não declara nada também falha', async () => {
    const id = criar();
    const w = workerDeFase(new FakeRunner({ respostas: ['fiz um monte de coisa e esqueci de dizer onde'] }));
    for (let i = 0; i < 5 && await w.passo(); i += 1) fila.recuperarLeasesVencidos();

    expect(faseDe(id, 'texto').estado).toBe('falhou');
  });

  /**
   * O estrago silencioso do mesmo defeito: `resultado` virava o stdout inteiro,
   * e é ele que a fase SEGUINTE recebe como `anterior`. A fase de reel ganhava
   * um blob de prosa onde esperava um caminho de arquivo.
   */
  it('o resultado gravado é o CAMINHO, não o texto do agente', async () => {
    criar();
    const alvo = join(dir, 'art', 'fluxos', '1.txt');
    const w = workerDeFase(new FakeRunner({ respostas: [`prosa que ninguém quer no chat\nRESULT: ${alvo}`] }));
    await w.passo();

    const job = fila.listar().find((j) => j.flow_ref?.includes('//texto'))!;
    expect(job.resultado).toBe(alvo);
    expect(job.resultado).not.toContain('prosa');
  });

  it('a fase recebe as variáveis do alvo (canal), sem receber as que o prompt não pede', async () => {
    criar();
    concluirJob(fila.listar()[0]!.id);
    const jobRender = fila.listar().find((j) => j.flow_ref === 'B#1/mulheres/render')!;
    const ctx = await criarPromptDe({
      defs: [], raizRepo: dir, projetosDir: dir, raizArtefatos: join(dir, 'art'), cwd: dir,
      perfilPadrao: { motor: 'fake', modelo: 'sonnet', esforco: 'low' },
    })(fila.obter(jobRender.id)!);
    // O template usa só {{input}} e {{saida}}; `canal` existe no job e NÃO é
    // passado — `renderizarPrompt` recusaria variável não usada.
    expect(ctx.prompt).toContain('Assunto de teste');
    expect(ctx.prompt).not.toContain('{{');
  });
});

describe('o fluxo AVISA no chat (§3.6.2 e §8)', () => {
  function comEventos(): { eventos: { chatId: number; texto: string }[]; f: Fluxos } {
    const eventos: { chatId: number; texto: string }[] = [];
    // MESMA conexão do resto do teste: abrir uma segunda sobre o mesmo arquivo
    // dá "database is locked" — o WAL permite leitores concorrentes, não dois
    // escritores no mesmo processo.
    const f = new Fluxos({
      fila, estado: new EstadoFluxos(db, () => t), agora: () => t,
      aoEvento: (e) => eventos.push(e),
    });
    return { eventos, f };
  }

  it('alvo que falha vira mensagem com o motivo e o comando de retentativa', () => {
    const { eventos, f } = comEventos();
    fluxos.criar({
      tipo: 'brinquedo', definicao: congelar(def, dominio), hash: 'h', assunto: 'A', chatId: 77,
    });
    const job = fila.listar().find((j) => j.flow_ref === 'B#1//texto')!;
    fila.pegar('texto', 60, 'W');
    fila.falhar(job.id, 'estourou tudo', 'W', 1, (j) => f.avancar(j));

    expect(eventos).toHaveLength(2); // falha do alvo + fim do fluxo
    expect(eventos[0]!.chatId).toBe(77);
    expect(eventos[0]!.texto).toContain('estourou tudo');
    expect(eventos[0]!.texto).toContain('/refazer B#1');
  });

  it('fluxo que termina bem também avisa', () => {
    const { eventos, f } = comEventos();
    fluxos.criar({
      tipo: 'brinquedo', definicao: congelar(def, dominio), hash: 'h',
      assunto: 'A', alvos: ['mulheres'], chatId: 77,
    });
    const ack = (ref: string): void => {
      const j = fila.listar().find((x) => x.flow_ref === ref)!;
      reclamar(j.id);
      fila.concluir(j.id, 'ok', 'W', (job) => f.avancar(job));
    };
    ack('B#1//texto');
    ack('B#1/mulheres/render');
    ack('B#1/mulheres/entregar');
    // `some` e não `at(-1)`: depois do aviso de fim vem o link do vídeo final.
    expect(eventos.some((e) => e.texto.includes('terminou: feito'))).toBe(true);
  });

  it('o PACOTE que a fase de fluxo declarou vai para o lote do canal', () => {
    // Isto é o `canal` do alvo deixando de ser decorativo: a fase de escopo
    // `fluxo` escreve `publicacao: <pasta>` no recibo, e o fim do fluxo leva a
    // pasta para `imports/<lote>` do projeto do canal.
    const eventos: { chatId: number; texto: string }[] = [];
    const projetos = mkdtempSync(join(tmpdir(), 'projetos-'));
    mkdirSync(join(projetos, 'yt-pub-lives21', 'imports', 'videos'), { recursive: true });
    const pacote = join(dir, 'chuva-de-verao', 'publicacao');
    mkdirSync(pacote, { recursive: true });
    writeFileSync(join(pacote, 'manifest.json'), '{"clips":[{"title":"Chuva de Verão"}]}');
    const recibo = join(dir, 'recibo-entrega.txt');
    writeFileSync(recibo, `slug: chuva-de-verao\npublicacao: ${pacote}\n`);

    const f = new Fluxos({
      fila, estado: new EstadoFluxos(db, () => t), agora: () => t,
      aoEvento: (e) => eventos.push(e), projetosDir: projetos,
    });
    fluxos.criar({
      tipo: 'brinquedo', definicao: congelar(def, dominio), hash: 'h',
      assunto: 'A', alvos: ['mulheres'], chatId: 77,
    });
    const ack = (ref: string, dados: string): void => {
      const j = fila.listar().find((x) => x.flow_ref === ref)!;
      reclamar(j.id);
      fila.concluir(j.id, dados, 'W', (job) => f.avancar(job));
    };
    ack('B#1//texto', recibo);
    ack('B#1/mulheres/render', 'ok');
    ack('B#1/mulheres/entregar', 'ok');

    const lote = join(projetos, 'yt-pub-lives21', 'imports', 'chuva-de-verao');
    expect(readFileSync(join(lote, 'manifest.json'), 'utf8')).toContain('Chuva de Verão');
    expect(eventos.some((e) => e.texto.includes('entregue em lives21'))).toBe(true);
    rmSync(projetos, { recursive: true, force: true });
  });

  it('o MESMO pacote em dois recibos entrega uma vez só', () => {
    // Como no musicavideo de verdade: `clipe` e `entrega` são AMBAS de escopo
    // fluxo, e as duas terminam com a linha `publicacao:` no recibo — a entrega
    // roda no fim do `faz` e de novo no `pacote`. Sem dedup, dois avisos.
    const eventos: { chatId: number; texto: string }[] = [];
    const projetos = mkdtempSync(join(tmpdir(), 'projetos-'));
    mkdirSync(join(projetos, 'yt-pub-lives21', 'imports'), { recursive: true });
    const pacote = join(dir, 'dobrado', 'publicacao');
    mkdirSync(pacote, { recursive: true });
    writeFileSync(join(pacote, 'manifest.json'), '{}');
    const recibo = (nome: string): string => {
      const r = join(dir, nome);
      writeFileSync(r, `publicacao: ${pacote}\n`);
      return r;
    };

    const dom2 = join(dir, 'dominio2');
    mkdirSync(join(dom2, 'prompts'), { recursive: true });
    writeFileSync(join(dom2, 'prompts', 'p.md'), 'faça {{input}} em {{saida}}');
    writeFileSync(join(dom2, 'flow.json'), JSON.stringify({
      nome: 'duplo', prefixo: 'D', versao_def: 1,
      alvos: { unico: { canal: 'lives21' } },
      fases: [
        { id: 'clipe', escopo: 'fluxo', fila: 'render', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/p.md' },
        { id: 'entrega', escopo: 'fluxo', fila: 'io', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/p.md' },
      ],
    }));
    const def2 = carregarFlow(dom2);

    const f = new Fluxos({
      fila, estado: new EstadoFluxos(db, () => t), agora: () => t,
      aoEvento: (e) => eventos.push(e), projetosDir: projetos,
    });
    fluxos.criar({
      tipo: 'duplo', definicao: congelar(def2, dom2), hash: 'h2', assunto: 'A', chatId: 77,
    });
    for (const [ref, dados] of [['D#1//clipe', recibo('r1.txt')], ['D#1//entrega', recibo('r2.txt')]]) {
      const j = fila.listar().find((x) => x.flow_ref === ref)!;
      reclamar(j.id);
      fila.concluir(j.id, dados!, 'W', (job) => f.avancar(job));
    }

    expect(eventos.filter((e) => e.texto.includes('entregue em lives21'))).toHaveLength(1);
    rmSync(projetos, { recursive: true, force: true });
  });

  it('fluxo SEM alvo nenhum ainda entrega o que o portão declara', () => {
    // O musicavideo: todas as fases de escopo `fluxo`, nenhuma linha com alvo.
    // `alvosDoFluxo` devolvia [] e o laço da entrega não rodava — portão mudo,
    // sem nem um aviso de que algo faltou.
    const eventos: { chatId: number; texto: string }[] = [];
    const dom3 = join(dir, 'dominio3');
    mkdirSync(join(dom3, 'prompts'), { recursive: true });
    writeFileSync(join(dom3, 'prompts', 'p.md'), 'faça {{input}} em {{saida}}');
    const plano = join(dir, 'PLANO-do-teste.md');
    writeFileSync(plano, '# Chuva de Verão\n\nplano inteiro aqui.');
    const recibo = join(dir, 'recibo-plano.txt');
    // Duas linhas `plano:` de propósito: a narração no meio, o recibo no fim.
    writeFileSync(recibo, `plano: gerando...\nplano: ${plano}\n`);
    writeFileSync(join(dom3, 'flow.json'), JSON.stringify({
      nome: 'semalvo', prefixo: 'S', versao_def: 1,
      alvos: { unico: { gatilho: 'x' } },
      fases: [
        {
          id: 'plano', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
          prompt: 'prompts/p.md', pausa_apos: true,
          portao: { mostrar: ['{{artefato:plano}}'] },
        },
      ],
    }));
    const def3 = carregarFlow(dom3);
    const f = new Fluxos({
      fila, estado: new EstadoFluxos(db, () => t), agora: () => t,
      aoEvento: (e) => eventos.push(e),
    });
    fluxos.criar({
      tipo: 'semalvo', definicao: congelar(def3, dom3), hash: 'h3', assunto: 'A', chatId: 77,
    });
    const j = fila.listar().find((x) => x.flow_ref === 'S#1//plano')!;
    reclamar(j.id);
    fila.concluir(j.id, recibo, 'W', (job) => f.avancar(job));

    expect(eventos.some((e) => e.texto.includes('plano inteiro aqui'))).toBe(true);
  });

  // `{{molde}}?` — OPCIONAL. O Suno entrega DUAS faixas e o musicavideo só
  // declarava uma: a segunda ficava no disco, paga no mesmo custo e nunca
  // ouvida (MVD#96). Mas `--faixa-pronta` produz UMA, e um molde obrigatório
  // para a segunda avisaria "não consegui resolver" justamente aí.
  function fluxoComOpcional(recibo: string): { chatId: number; texto: string }[] {
    const eventos: { chatId: number; texto: string }[] = [];
    const dom = join(dir, `dom-opc-${recibo.length}`);
    mkdirSync(join(dom, 'prompts'), { recursive: true });
    writeFileSync(join(dom, 'prompts', 'p.md'), 'faça {{input}} em {{saida}}');
    writeFileSync(join(dom, 'flow.json'), JSON.stringify({
      nome: 'opcional', prefixo: 'O', versao_def: 1,
      alvos: { unico: { gatilho: 'x' } },
      fases: [{
        id: 'musica', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
        prompt: 'prompts/p.md', pausa_apos: true,
        portao: { mostrar: ['{{artefato:musica}}', '{{artefato:musica_alt}}?'] },
      }],
    }));
    const d = carregarFlow(dom);
    const f = new Fluxos({
      fila, estado: new EstadoFluxos(db, () => t), agora: () => t,
      aoEvento: (e) => eventos.push(e),
    });
    fluxos.criar({ tipo: 'opcional', definicao: congelar(d, dom), hash: `h-${recibo.length}`, assunto: 'A', chatId: 77 });
    const j = fila.listar().find((x) => x.flow_ref === 'O#1//musica')
      ?? fila.listar().reverse().find((x) => x.flow_ref?.endsWith('//musica'))!;
    reclamar(j.id);
    fila.concluir(j.id, recibo, 'W', (job) => f.avancar(job));
    return eventos;
  }

  it('molde OPCIONAL que resolve entrega as duas faixas', () => {
    const f1 = join(dir, 'faixa-1.mp3');
    const f2 = join(dir, 'faixa-2.mp3');
    writeFileSync(f1, 'audio1');
    writeFileSync(f2, 'audio2');
    const recibo = join(dir, 'recibo-2-faixas.txt');
    writeFileSync(recibo, `musica: ${f1}\nmusica_alt: ${f2}\n`);
    const eventos = fluxoComOpcional(recibo);
    expect(eventos.some((e) => e.texto.includes('faixa-1.mp3'))).toBe(true);
    // `📎` e não só o nome: sem tirar o `?` o caminho vira `...mp3?`, que não
    // é reconhecido como mídia e só apareceria dentro de um aviso de erro.
    expect(eventos.some((e) => e.texto.includes('📎 faixa-2.mp3')), 'a segunda faixa também').toBe(true);
  });

  it('molde OPCIONAL que não resolve fica CALADO (não vira aviso)', () => {
    const f1 = join(dir, 'so-uma.mp3');
    writeFileSync(f1, 'audio1');
    const recibo = join(dir, 'recibo-1-faixa.txt');
    writeFileSync(recibo, `musica: ${f1}\n`);
    const eventos = fluxoComOpcional(recibo);
    expect(eventos.some((e) => e.texto.includes('so-uma.mp3'))).toBe(true);
    expect(eventos.some((e) => e.texto.includes('não consegui resolver')),
      'faixa que não existe não é erro').toBe(false);
  });

  it('fase sem pacote no recibo não inventa entrega ao canal', () => {
    const eventos: { chatId: number; texto: string }[] = [];
    const projetos = mkdtempSync(join(tmpdir(), 'projetos-'));
    mkdirSync(join(projetos, 'yt-pub-lives21', 'imports'), { recursive: true });
    const f = new Fluxos({
      fila, estado: new EstadoFluxos(db, () => t), agora: () => t,
      aoEvento: (e) => eventos.push(e), projetosDir: projetos,
    });
    fluxos.criar({
      tipo: 'brinquedo', definicao: congelar(def, dominio), hash: 'h',
      assunto: 'A', alvos: ['mulheres'], chatId: 77,
    });
    for (const ref of ['B#1//texto', 'B#1/mulheres/render', 'B#1/mulheres/entregar']) {
      const j = fila.listar().find((x) => x.flow_ref === ref)!;
      reclamar(j.id);
      fila.concluir(j.id, 'ok', 'W', (job) => f.avancar(job));
    }
    expect(eventos.some((e) => e.texto.includes('entregue em'))).toBe(false);
    rmSync(projetos, { recursive: true, force: true });
  });

  it('fluxo sem chat_id não gera evento nenhum', () => {
    const { eventos, f } = comEventos();
    fluxos.criar({ tipo: 'brinquedo', definicao: congelar(def, dominio), hash: 'h', assunto: 'A', chatId: null });
    const j = fila.listar().find((x) => x.flow_ref === 'B#1//texto')!;
    fila.pegar('texto', 60, 'W');
    fila.falhar(j.id, 'x', 'W', 1, (job) => f.avancar(job));
    expect(eventos).toHaveLength(0);
  });
});

describe('view fluxo_historico', () => {
  // A view junta `fluxo_fases` (estado atual) com as linhas de `jobs` daquele
  // flow_ref (o histórico, que nunca é deletado). Se a expressão do JOIN
  // divergir do `flowRef()`, ela devolve vazio em silêncio — e ninguém nota
  // até precisar do histórico.
  it('casa fase com job pelo flow_ref e traz o histórico', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const linhas = db
      .prepare('SELECT * FROM fluxo_historico WHERE fluxo_id = ? AND fase = ?')
      .all(id, 'texto') as { job_id: number | null; job_status: string | null }[];
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.job_id).not.toBeNull();
    expect(linhas[0]!.job_status).toBe('done');
  });

  it('traz TODAS as tentativas daquela fase, não só a última', () => {
    const id = criar();
    concluirJob(fila.listar()[0]!.id);
    const j = fila.listar().find((x) => x.flow_ref === 'B#1/mulheres/render')!;
    falharJob(j.id); t += 60; falharJob(j.id);
    fluxos.refazer(id, 'mulheres'); // gera um SEGUNDO job para a mesma fase

    const linhas = db
      .prepare('SELECT job_id FROM fluxo_historico WHERE fluxo_id = ? AND fase = ? AND alvo = ?')
      .all(id, 'render', 'mulheres');
    expect(linhas.length).toBeGreaterThanOrEqual(2);
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

/**
 * A fase `gerar` (opção `| api`): o input dela é montado pelo BOT, e é o que
 * decide o que o avatar diz, com que rosto e com que voz.
 *
 * O título é o mesmo da fase `baixar` de propósito — é o que dispensa carregar
 * `video_id` de uma fase para a outra e o que faz `baixar` não precisar saber
 * se o vídeo veio da API ou da mão de alguém.
 */
describe('input da fase gerar', () => {
  function dominioComGerar(): FlowDef {
    mkdirSync(join(dominio, 'prompts'), { recursive: true });
    writeFileSync(join(dominio, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 1,
      avatar_id: 'avatar-do-dominio', voice_id: 'voz-do-dominio',
      alvos: { um: { canal: 'lives1' }, dois: { canal: 'lives2', voice_id: 'voz-do-alvo' } },
      fases: [
        { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/texto.md' },
        { id: 'gerar', escopo: 'alvo', fila: 'io', kind: 'function', tarefa: 'heygen.gerar', opcional: 'api', espera: { intervalo: 60, timeout: 3600 } },
      ],
    }));
    return congelar(carregarFlow(dominio, []), dominio);
  }

  function inputDoGerar(alvo: string): Record<string, unknown> {
    const d = dominioComGerar();
    const f = fluxos.criar({
      tipo: 'brinquedo', definicao: d, hash: hashDefinicao(d, dominio),
      assunto: 'assunto', alvos: ['um', 'dois'], chatId: 1,
      opcoes: { api: true },
    });
    // A fase de texto grava a FALA no arquivo que o portão já lê.
    const pasta = join(dominio, 'textos', `B${f.id}`);
    mkdirSync(pasta, { recursive: true });
    for (const a of ['um', 'dois']) {
      writeFileSync(join(pasta, `${a}.md`), `### FALA\nfala do ${a}\n\n### SOBREPOSIÇÕES\n- x\n`);
    }
    const job = fila.listar().find((j) => j.flow_ref === `B#${f.id}//texto`)!;
    fila.pegar('texto', 600, 'W');
    fila.concluir(job.id, join(pasta, 'resumo.txt'), 'W', (j) => fluxos.avancar(j));
    const gerar = fila.listar().find((j) => j.flow_ref === `B#${f.id}/${alvo}/gerar`)!;
    return JSON.parse(gerar.input) as Record<string, unknown>;
  }

  it('leva o MESMO título que a fase baixar procura', () => {
    expect(inputDoGerar('um').titulo).toBe('B1-um-v1');
  });

  it('leva a FALA do roteiro daquele alvo, não o assunto', () => {
    expect(inputDoGerar('um').texto).toBe('fala do um');
  });

  it('avatar e voz vêm do domínio', () => {
    expect(inputDoGerar('um')).toMatchObject({ avatarId: 'avatar-do-dominio', voiceId: 'voz-do-dominio' });
  });

  // Um público pode pedir outra voz sem mudar a do fluxo inteiro.
  it('o alvo pode sobrescrever a voz', () => {
    expect(inputDoGerar('dois')).toMatchObject({ avatarId: 'avatar-do-dominio', voiceId: 'voz-do-alvo' });
  });

  it('leva a janela de poll da definição congelada', () => {
    expect(inputDoGerar('um').espera).toEqual({ intervalo: 60, timeout: 3600 });
  });
});

describe('o portão diz QUEM gera o avatar', () => {
  it('com a fase gerar no fluxo, avisa que quem gera é o bot', () => {
    const eventos: string[] = [];
    const f2 = new Fluxos({
      fila, estado, agora: () => t, repoDe: () => dominio,
      aoEvento: (e) => eventos.push(e.texto),
    });
    writeFileSync(join(dominio, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 1,
      avatar_id: 'av', voice_id: 'vo',
      alvos: { um: { canal: 'lives1' } },
      fases: [
        { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/texto.md', pausa_apos: true },
        { id: 'gerar', escopo: 'alvo', fila: 'io', kind: 'function', tarefa: 'heygen.gerar', opcional: 'api' },
      ],
    }));
    const d = congelar(carregarFlow(dominio, []), dominio);
    const fl = f2.criar({
      tipo: 'brinquedo', definicao: d, hash: hashDefinicao(d, dominio),
      assunto: 'x', alvos: ['um'], chatId: 7, opcoes: { api: true },
    });
    const job = fila.listar().find((j) => j.flow_ref === `B#${fl.id}//texto`)!;
    fila.pegar('texto', 600, 'W');
    fila.concluir(job.id, 'ok', 'W', (j) => f2.avancar(j));
    expect(eventos.find((e) => e.startsWith('⏸️'))).toMatch(/quem gera é o BOT/i);
  });
});
