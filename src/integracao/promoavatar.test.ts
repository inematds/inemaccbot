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
import { carregarFlow, congelar, hashDefinicao, validarFlow, type FlowDef } from '../dominio/flow.js';
import { carregarSkills } from '../dominio/registry.js';
import { FilaSqlite } from '../fila/store.js';
import { EstadoFluxos } from '../fluxos/estado.js';
import { Fluxos } from '../fluxos/runtime.js';
import { pastaTextos, tituloEstudio } from '../fluxos/entrada-fase.js';
import { criarPromptDe } from '../fila/skills.js';

const REPO_BOT = new URL('../..', import.meta.url).pathname;
const REPO_DOMINIO = join(REPO_BOT, '..', 'promoavatar');

let dir: string;
let fila: FilaSqlite;
let estado: EstadoFluxos;
let fluxos: Fluxos;
let def: FlowDef;
const eventos: { chatId: number; texto: string; anexo?: string }[] = [];
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
  // Destino do público `mulheres`, como em produção — o canal vem do flow.json
  // REAL, então este caminho segue o remapeamento de 2026-07-31 (lives24 →
  // lives4). Se divergir, o `destino` do job de reel vem `undefined` e este
  // teste é o que avisa.
  mkdirSync(join(dir, 'projetos', 'yt-pub-lives4', 'imports', 'videos'), { recursive: true });
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
  // A fase `gerar` está declarada no arquivo mas é OPCIONAL (`opcional: "api"`):
  // ela só entra num fluxo criado com `| api`. Sem a opção, o fluxo continua
  // sendo texto → baixar → reel, que é o que os testes abaixo exercitam.
  it('tem as três fases na ordem certa, com o portão depois do texto', () => {
    expect(def.fases.filter((f) => !f.opcional).map((f) => f.id))
      .toEqual(['texto', 'baixar', 'reel']);
    expect(def.fases.find((f) => f.id === 'gerar')?.opcional).toBe('api');
    const porId = (id: string) => def.fases.find((f) => f.id === id)!;
    expect(porId('texto').pausa_apos).toBe(true);
    // 40h, não 90 min: a fila de renderização do HeyGen chega a 36h, e ESPERAR
    // NÃO É ERRO — o teto existe só para o vídeo que nunca foi gerado. Dois
    // públicos do A#33 morreram no prazo antigo com o vídeo pronto lá.
    expect(porId('baixar').espera).toEqual({ intervalo: 300, timeout: 144_000 });
    // A fase de reel é FUNÇÃO desde 2026-08-06: o agente só re-derivava nomes
    // que o bot já tinha e disparava um comando. Ver `fila/tarefas/reel.ts` e
    // `docs/custo-por-fase-a19-a29.md`.
    expect(porId('reel').kind).toBe('function');
    expect(porId('reel').tarefa).toBe('reel.montar');
    expect(porId('reel').espera).toEqual({ intervalo: 120, timeout: 10800 });
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
 * A OUTRA metade do contrato de caminho: o portão lê `<pasta>/<alvo>.md`, mas
 * quem GRAVA ali é o agente, obedecendo ao `{{pasta}}` do prompt. Se a variável
 * não chegar ao template, `renderizarPrompt` derruba o job — e sem este teste
 * isso só apareceria no primeiro `/promoavatar` real.
 *
 * É a armadilha que o HANDOFF diz ter aparecido TRÊS vezes: código alcançável
 * com os testes ackando job à mão, sem passar pelo caminho que o agente usa.
 */
describe('a fase de texto recebe a pasta ditada pelo bot', () => {
  async function ctxDaFase1(): Promise<{ prompt: string; cwd: string }> {
    const id = criar(['mulheres']);
    const job = fila.listar().find((j) => j.flow_ref === `A#${id}//texto`)!;
    const ctx = await criarPromptDe({
      defs: carregarSkills(join(REPO_BOT, 'config', 'skills.json'), REPO_BOT),
      raizRepo: REPO_BOT,
      projetosDir: REPO_BOT, raizArtefatos: join(dir, 'artefatos'), cwd: dir,
      perfilPadrao: { motor: 'claude', modelo: 'sonnet', esforco: 'low' },
    })(job);
    return { prompt: ctx.prompt, cwd: ctx.cwd };
  }

  const promptDaFase1 = async (): Promise<string> => (await ctxDaFase1()).prompt;

  /**
   * O A#5 falhou DUAS vezes com "skill inemaclub-textos não encontrada": ela é
   * skill de PROJETO (`<repo>/.claude/skills/`) e o job rodava em `homedir()`.
   * É também o diretório onde o prompt manda commitar.
   */
  it('roda DENTRO do repo de domínio, não no home', async () => {
    mkdirSync(join(dir, 'dominio'), { recursive: true });
    expect((await ctxDaFase1()).cwd).toBe(join(dir, 'dominio'));
  });

  it('cai no cwd padrão quando a fase não declarou repo (fluxo antigo)', async () => {
    // Sem o diretório no disco, o repo declarado não vale — §9 não aceita
    // `cwd` que não existe.
    expect((await ctxDaFase1()).cwd).toBe(dir);
  });

  it('renderiza {{pasta}} com o caminho absoluto do repo de domínio', async () => {
    const prompt = await promptDaFase1();
    expect(prompt).toContain(join(dir, 'dominio', 'textos', 'A1'));
  });

  // Placeholder literal chegando ao agente é o modo de falha que o §9 chama de
  // pior: ele inventaria uma pasta, e o portão reportaria 12 faltas.
  it('não deixa nenhum placeholder por preencher', async () => {
    expect(await promptDaFase1()).not.toContain('{{');
  });

  /**
   * O filtro de alvos não chegava ao prompt: o A#4 nasceu com 1 público e o
   * agente escreveu 12 arquivos, porque o texto dizia "para TODOS os públicos
   * do pipeline". O fluxo sabia; o prompt não.
   */
  it('renderiza {{publicos}} com os alvos REAIS do fluxo, não com os 12', async () => {
    const prompt = await promptDaFase1();
    expect(prompt).toContain('mulheres');
    expect(prompt).not.toContain('empreendedores');
    expect(prompt).not.toContain('educadores');
  });

  it('a pasta que o prompt manda gravar é a MESMA que o portão vai ler', async () => {
    const prompt = await promptDaFase1();
    const fluxo = estado.obter(1)!;
    expect(prompt).toContain(pastaTextos(join(dir, 'dominio'), fluxo));
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
    // Filtra pelo TÍTULO e não por emoji: a mensagem do portão perdeu o `🎬`
    // (atrapalhava copiar), e um filtro por emoji passaria a não casar com
    // nada — deixando as asserções de contagem verdes por vazio.
    return eventos.filter((e) => /^A\d+-/.test(e.texto)).map((e) => e.texto);
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
   * São dois portões e eles pedem coisas diferentes.
   *
   * O da fase de TEXTO existe para você LER e revisar antes de aprovar, então
   * as falas vão inteiras — inclusive quando o avatar é gerado sozinho
   * (`| navega`), porque revisar é o motivo de o portão existir.
   *
   * Este teste existe porque a primeira versão condicionou pela ROTA e tirou a
   * fala do portão errado (2026-08-05).
   */
  it('o portão do TEXTO manda as falas mesmo com rota automática', () => {
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
      assunto: 'Não comece aprendendo ferramentas', alvos: ['mulheres', 'jovens'],
      chatId: 55, opcoes: { navega: true },
    }).id;
    escreverRoteiro(id, 'mulheres', 'Autonomia de verdade com IA.');
    escreverRoteiro(id, 'jovens', 'Tem uma profissão nascendo agora.');
    ackar(`A#${id}//texto`, 'ok');

    expect(roteiros()).toHaveLength(2);
    expect(roteiros()[0]).toContain('Tem uma profissão nascendo agora.');
    expect(roteiros()[1]).toContain('Autonomia de verdade com IA.');
    // E nada de lista resumida aqui: ela é do portão dos avatares.
    expect(eventos.map((e) => e.texto).some((t) => t.includes('avatar(es) a gerar'))).toBe(false);
  });

  /**
   * O portão dos AVATARES (depois do download) é o outro caso: aqui não há o
   * que ler — as falas já foram revisadas no portão anterior — e repetir 12
   * blocos empurraria para cima a única coisa que se olha, que é QUAIS públicos
   * entraram. Vai só a lista, com os títulos do estúdio.
   */
  /**
   * O PORTÃO QUE O DOMÍNIO DECLARA (`portao.mostrar` no flow.json).
   *
   * Antes disto o bot tinha duas convenções chumbadas: os roteiros do
   * promoavatar e, como rede, o artefato. Duas heurísticas do BOT sobre o que
   * um domínio quer mostrar — quando quem sabe isso é o domínio.
   *
   * `{{artefato:campo}}` é a peça que faz funcionar: o slug do musicavideo é
   * derivado do texto e desambiguado com `-2`, então o bot nunca conhece o
   * caminho do PLANO.md. O domínio escreve `plano: <caminho>` no recibo, e o
   * portão vai buscar ali.
   */
  it('domínio que DECLARA o portão manda o arquivo que ele apontou', () => {
    const recibo = join(dir, 'recibo.txt');
    const plano = join(dir, 'PLANO-do-dominio.md');
    writeFileSync(plano, '# Além da Terra\n\nEstrutura: intro · verso · refrão');
    writeFileSync(recibo, `slug: para-a-musica-2\nplano: ${plano}\n`);
    const comPortao = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, portao: { mostrar: ['{{artefato:plano}}'] } } : f)),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: comPortao, hash: hashDefinicao(comPortao, REPO_DOMINIO),
      assunto: 'assunto', alvos: ['jovens'], chatId: 55,
    }).id;
    ackar(`A#${id}//texto`, recibo);

    const texto = eventos.map((e) => e.texto).find((t) => t.includes('Além da Terra'));
    expect(texto).toBeDefined();
    expect(texto).toContain('intro · verso · refrão');
    // Declarou: nenhuma das duas heurísticas antigas entra.
    expect(eventos.some((e) => e.texto.includes('Sem roteiro em'))).toBe(false);
    expect(eventos.some((e) => e.texto.includes('produziu'))).toBe(false);
  });

  // MÍDIA VAI COMO ARQUIVO. Até 2026-08-21 o portão só empurrava texto: a
  // faixa, a capa e o clipe ficavam no disco e, do chat, "não acontecia nada"
  // quando o fluxo terminava. Um `.mp3` lido como UTF-8 seria lixo na tela.
  it('portão que aponta mídia manda o ARQUIVO, não o conteúdo', () => {
    const recibo = join(dir, 'recibo-midia.txt');
    const faixa = join(dir, 'faixa-1.mp3');
    writeFileSync(faixa, 'nao-e-texto');
    writeFileSync(recibo, `musica: ${faixa}\n`);
    const comPortao = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, portao: { mostrar: ['{{artefato:musica}}'] } } : f)),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: comPortao, hash: hashDefinicao(comPortao, REPO_DOMINIO),
      assunto: 'assunto', alvos: ['jovens'], chatId: 55,
    }).id;
    ackar(`A#${id}//texto`, recibo);

    const evento = eventos.find((e) => e.anexo);
    expect(evento?.anexo).toBe(faixa);
    // O texto que acompanha diz o NOME, não o conteúdo do arquivo.
    expect(evento?.texto).toContain('faixa-1.mp3');
    expect(evento?.texto).not.toContain('nao-e-texto');
  });

  // VÍDEO VAI POR LINK, não anexado — o clipe de uma música de 3 minutos passa
  // de 200 MB e o Telegram recusa documento acima de 50. É o mesmo caminho que
  // o promoavatar já usa para os reels (`entregarVideos`).
  it('portão que aponta VÍDEO manda o link publicado, não o arquivo', () => {
    const recibo = join(dir, 'recibo-video.txt');
    const clipe = join(dir, 'clipe.mp4');
    writeFileSync(clipe, 'video');
    writeFileSync(recibo, `clipe: ${clipe}\n`);
    const publicados: string[] = [];
    const comLink = new Fluxos({
      fila, estado, agora: () => t,
      raizArtefatos: join(dir, 'artefatos'), projetosDir: join(dir, 'projetos'),
      aoEvento: (e) => eventos.push(e),
      repoDe: () => REPO_DOMINIO,
      publicar: (origem, titulo) => {
        publicados.push(`${titulo}:${origem}`);
        return { arquivo: origem, links: [`http://casa:8080/v/${titulo}.mp4`] };
      },
    });
    const comPortao = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, portao: { mostrar: ['{{artefato:clipe}}'] } } : f)),
    };
    const id = comLink.criar({
      tipo: 'promoavatar', definicao: comPortao, hash: hashDefinicao(comPortao, REPO_DOMINIO),
      assunto: 'assunto', alvos: ['jovens'], chatId: 55,
    }).id;
    const job = fila.listar().find((j) => j.flow_ref === `A#${id}//texto`)!;
    if (job.status !== 'running') fila.pegar(job.fila, 600, 'W');
    fila.concluir(job.id, recibo, 'W', (j) => comLink.avancar(j));

    const evento = eventos.find((e) => e.texto.includes('http://casa:8080'));
    expect(evento).toBeDefined();
    expect(evento?.anexo).toBeUndefined();          // link, não anexo
    expect(publicados[0]).toContain(`A${id}-texto`); // nome carrega REF e fase
  });

  it('arquivo de texto continua indo INLINE, sem virar anexo', () => {
    const recibo = join(dir, 'recibo-texto.txt');
    const plano = join(dir, 'PLANO-inline.md');
    writeFileSync(plano, '# Além da Terra\n\nconteúdo para ler no chat');
    writeFileSync(recibo, `plano: ${plano}\n`);
    const comPortao = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, portao: { mostrar: ['{{artefato:plano}}'] } } : f)),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: comPortao, hash: hashDefinicao(comPortao, REPO_DOMINIO),
      assunto: 'assunto', alvos: ['jovens'], chatId: 55,
    }).id;
    ackar(`A#${id}//texto`, recibo);

    expect(eventos.some((e) => e.anexo)).toBe(false);
    expect(eventos.some((e) => e.texto.includes('conteúdo para ler no chat'))).toBe(true);
  });

  // Valor de recibo com quebra de linha não vira caminho: o portão avisa em vez
  // de tentar ler um arquivo cujo nome tem `\n` no meio.
  it('valor de recibo multilinha não vira caminho', () => {
    const recibo = join(dir, 'recibo-sujo.txt');
    writeFileSync(recibo, 'plano: /out/PLANO.md\nmalicioso\n');
    const bom = join(dir, 'PLANO-ok.md');
    writeFileSync(bom, 'ok');
    const comPortao = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, portao: { mostrar: ['{{artefato:plano}}'] } } : f)),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: comPortao, hash: hashDefinicao(comPortao, REPO_DOMINIO),
      assunto: 'assunto', alvos: ['jovens'], chatId: 55,
    }).id;
    ackar(`A#${id}//texto`, recibo);
    // A primeira linha é o valor; o resto do recibo não entra no caminho.
    const aviso = eventos.map((e) => e.texto).find((t) => t.includes('não consegui ler'));
    expect(aviso).toContain('/out/PLANO.md');
    expect(aviso).not.toContain('malicioso');
  });

  // Marcador que não resolve vira AVISO, nunca portão mudo — que é o defeito
  // que este mecanismo existe para consertar.
  it('molde que não resolve avisa, em vez de abrir o portão calado', () => {
    const recibo = join(dir, 'recibo-sem-campo.txt');
    writeFileSync(recibo, 'slug: x\n');
    const comPortao = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, portao: { mostrar: ['{{artefato:plano}}'] } } : f)),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: comPortao, hash: hashDefinicao(comPortao, REPO_DOMINIO),
      assunto: 'assunto', alvos: ['jovens'], chatId: 55,
    }).id;
    ackar(`A#${id}//texto`, recibo);

    expect(eventos.some((e) => e.texto.includes('não consegui resolver'))).toBe(true);
  });

  /**
   * DOMÍNIO QUE NÃO ESCREVE ROTEIRO — o portão ainda tem que dar o que ler.
   *
   * `textos/<REF>/<alvo>.md` é a forma do promoavatar, e o portão nasceu com
   * ela. O musicavideo produz um `PLANO.md` na pasta de saída dele, e no MVD#89
   * (2026-08-21) o portão abriu dizendo só "sem roteiro": nada para ler, nada
   * para decidir — e a fase seguinte é a única paga do fluxo. Agora, sem
   * roteiro, vai o ARTEFATO que a fase declarou no `RESULT:`, que todo domínio
   * tem por contrato.
   */
  it('sem roteiro no domínio, o portão manda o artefato que a fase produziu', () => {
    const recibo = join(dir, 'recibo.txt');
    writeFileSync(recibo, 'slug: para-a-musica-2\ntitulo: Além da Terra\nplano: /out/PLANO.md');
    const id = criar(['jovens']);
    ackar(`A#${id}//texto`, recibo);

    const texto = eventos.map((e) => e.texto).find((t) => t.includes('a fase texto produziu'));
    expect(texto).toBeDefined();
    expect(texto).toContain('Além da Terra');
    expect(texto).toContain('/out/PLANO.md');
    // E a reclamação de roteiro faltando NÃO aparece: havia o que mostrar.
    expect(eventos.some((e) => e.texto.includes('Sem roteiro em'))).toBe(false);
  });

  // Artefato ilegível (sumiu, é binário) não vira silêncio nem stack trace: vai
  // o caminho, que é o que permite ir olhar.
  it('artefato que não dá para ler vira o caminho no chat', () => {
    const id = criar(['jovens']);
    ackar(`A#${id}//texto`, join(dir, 'nao-existe.txt'));

    const texto = eventos.map((e) => e.texto).find((t) => t.includes('a fase texto produziu'));
    expect(texto).toContain('nao-existe.txt');
  });

  it('o portão dos AVATARES manda só a lista, não as falas de novo', () => {
    const id = criar(['mulheres', 'jovens']);
    escreverRoteiro(id, 'mulheres', 'Autonomia de verdade com IA.');
    escreverRoteiro(id, 'jovens', 'Tem uma profissão nascendo agora.');
    ackar(`A#${id}//texto`, 'ok');
    fluxos.aprovar(id);
    const antes = eventos.length;
    for (const alvo of ['jovens', 'mulheres']) {
      ackar(`A#${id}/${alvo}/baixar`, `/midia/${alvo}.mp4`);
    }
    const novos = eventos.slice(antes).map((e) => e.texto);
    const lista = novos.find((t) => t.includes('avatar(es) a gerar'));
    expect(lista).toBeDefined();
    expect(lista).toContain(`A${id}-jovens-v1`);
    expect(lista).not.toContain('Autonomia de verdade');
    // Nenhuma mensagem no formato "título + fala" neste portão.
    expect(novos.filter((t) => /^A\d+-/.test(t))).toHaveLength(0);
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

  // A mensagem é para ser SELECIONADA e colada no estúdio; emoji entra junto.
  it('a mensagem do roteiro começa no TÍTULO, sem emoji', () => {
    const id = criar(['mulheres']);
    escreverRoteiro(id, 'mulheres', 'fala.');
    ackar('A#1//texto', 'ok');
    expect(roteiros()[0]!.startsWith('A1-mulheres-v1')).toBe(true);
    expect(roteiros()[0]).not.toContain('🎬');
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

/**
 * O que a pessoa recebe quando o fluxo fecha. O reel do A#4 tinha 38 MB e o
 * artefato do bot chama `9.mp4` — o id do job não diz nada a quem recebe, e o
 * arquivo não cabe bem em anexo. O que serve é link + nome do título.
 */
describe('vídeo final: link e nome do título', () => {
  function fluxosComPublicacao(): { f: Fluxos; publicados: string[] } {
    const publicados: string[] = [];
    const f = new Fluxos({
      fila, estado, agora: () => t,
      raizArtefatos: join(dir, 'artefatos'), projetosDir: join(dir, 'projetos'),
      aoEvento: (e) => eventos.push(e),
      repoDe: () => join(dir, 'dominio'),
      publicar: (origem, titulo) => {
        publicados.push(`${titulo}<-${origem}`);
        return { arquivo: `/servida/${titulo}.mp4`, links: [`http://rede:8202/${titulo}.mp4`] };
      },
    });
    return { f, publicados };
  }

  function rodarAteOFim(f: Fluxos, id: number): void {
    const acabar = (ref: string, res: string): void => {
      const job = fila.listar().find((j) => j.flow_ref === ref && j.status !== 'done')!;
      if (job.status !== 'running') fila.pegar(job.fila, 600, 'W');
      fila.concluir(job.id, res, 'W', (j) => f.avancar(j));
    };
    acabar(`A#${id}//texto`, join(dir, 'artefatos', 'fluxos', '1.txt'));
    f.aprovar(id);
    acabar(`A#${id}/mulheres/baixar`, join(dir, 'avatar.mp4'));
    // Segundo portão: os avatares baixaram e esperam você assistir antes de
    // queimar ~19 min de render por público.
    f.aprovar(id);
    acabar(`A#${id}/mulheres/reel`, join(dir, 'reel-9.mp4'));
  }

  it('manda o link do vídeo final com o nome do título', () => {
    const { f, publicados } = fluxosComPublicacao();
    const id = f.criar({
      tipo: 'promoavatar', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
      assunto: 'x', alvos: ['mulheres'], chatId: 55,
    }).id;
    rodarAteOFim(f, id);

    // Publicou o artefato da ÚLTIMA fase (o reel), não o avatar do meio.
    expect(publicados).toEqual([`A1-mulheres-v1<-${join(dir, 'reel-9.mp4')}`]);

    const msg = eventos.filter((e) => e.texto.startsWith('🎬')).at(-1)!.texto;
    expect(msg).toContain('A1-mulheres-v1');
    expect(msg).toContain('http://rede:8202/A1-mulheres-v1.mp4');
  });

  // `PUBLICO_URLS` tem três bases (rede.club, rede1.club, rede2.club) porque a
  // máquina responde por três nomes na rede local. Mandar as três por vídeo é
  // 3 linhas × 36 alvos = 108 linhas de link no chat, e quem recebe clica na
  // primeira mesmo — as outras só empurram o próximo título para fora da tela.
  it('entrega UM link por vídeo, o primeiro da lista', () => {
    const publicados: string[] = [];
    const f = new Fluxos({
      fila, estado, agora: () => t,
      raizArtefatos: join(dir, 'artefatos'), projetosDir: join(dir, 'projetos'),
      aoEvento: (e) => eventos.push(e),
      repoDe: () => join(dir, 'dominio'),
      publicar: (origem, titulo) => {
        publicados.push(titulo);
        return {
          arquivo: `/servida/${titulo}.mp4`,
          links: [
            `http://rede.club:8202/${titulo}.mp4`,
            `http://rede1.club:8202/${titulo}.mp4`,
            `http://rede2.club:8202/${titulo}.mp4`,
          ],
        };
      },
    });
    const id = f.criar({
      tipo: 'promoavatar', definicao: def, hash: hashDefinicao(def, REPO_DOMINIO),
      assunto: 'x', alvos: ['mulheres'], chatId: 55,
    }).id;
    rodarAteOFim(f, id);

    const msg = eventos.filter((e) => e.texto.startsWith('🎬')).at(-1)!.texto;
    expect(msg).toContain('http://rede.club:8202/A1-mulheres-v1.mp4');
    expect(msg).not.toContain('rede1.club');
    expect(msg).not.toContain('rede2.club');
  });

  it('sem publicação configurada, diz o caminho em vez de omitir o alvo', () => {
    const id = criar(['mulheres']);
    rodarAteOFim(fluxos, id);
    const msg = eventos.filter((e) => e.texto.includes('sem link')).at(-1)!.texto;
    expect(msg).toContain('A1-mulheres-v1');
    expect(msg).toContain(join(dir, 'reel-9.mp4'));
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
    fluxos.aprovar(id);   // portão novo: os avatares baixaram e esperam revisão

    const reel = fila.listar().find((j) => j.flow_ref === 'A#1/mulheres/reel')!;
    expect(reel.fila).toBe('render');
    expect(reel.tarefa).toBe('reel.montar');
    expect(reel.kind).toBe('function');
    const input = JSON.parse(reel.input) as Record<string, string>;
    // O avatar vem da fase anterior; o resto o bot DERIVA — antes ele mandava
    // só o caminho e o agente re-parseava REF e público desse nome.
    expect(input.avatar).toBe(avatar);
    expect(input.alvo).toBe('mulheres');
    expect(input.textos).toMatch(/textos\/A1\/mulheres\.md$/);
    expect(input.saida).toMatch(/reel\/A1-mulheres-v1\.mp4$/);
    expect(input.script).toMatch(/scripts\/montar-reel\.py$/);
    void id;
  });

  it('fluxo fecha e avisa quando o reel do último alvo entra', () => {
    const id = criar();
    ackar('A#1//texto', 'ok');
    fluxos.aprovar(id);
    ackar('A#1/mulheres/baixar', '/tmp/a.mp4');
    fluxos.aprovar(id);   // portão novo depois do download
    ackar('A#1/mulheres/reel', '/tmp/reel.mp4');
    expect(estado.obter(id)!.status).toBe('feito');
    // `some` e não `at(-1)`: depois do aviso de fim vem o link do vídeo final.
    expect(eventos.some((e) => e.texto.includes('terminou: feito'))).toBe(true);
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
    fluxos.aprovar(id);   // portão novo depois do download
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
    expect(input.espera).toEqual({ intervalo: 300, timeout: 144_000 });
  });

  // Sem o prazo, um vídeo que a pessoa nunca gera é pollado PARA SEMPRE:
  // `reagendar` não gasta tentativa, então a fase nunca falharia e o /status
  // diria "rodando" indefinidamente.
  it('estourado o timeout, a fase FALHA de verdade', async () => {
    const { criarHeygenBaixar } = await import('../fila/tarefas/heygen.js');
    const tarefa = criarHeygenBaixar({
      porTitulo: async () => new Map(), urlDe: async () => null, baixar: async () => {},
      gerar: async () => { throw new Error('não deve gerar'); },
      saldo: async () => null,
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

/**
 * Legenda e CTA são decisões de quem PUBLICA, não do agente. Ficam resolvidas
 * na definição CONGELADA: o fluxo nasce com a regra e não muda no meio.
 */
describe('opções do fluxo: legenda e clipe de CTA', () => {
  it('a fase de reel não carrega mais instrução de agente', () => {
    const reel = def.fases.find((f) => f.id === 'reel')!;
    // `entrega` era prosa para o modelo — CTA e legenda agora são decisão do
    // `montar-reel.py` (CTA: clipe padrão do repo; legenda: não existe, ver
    // decisão 2 de promoavatar/docs/decisoes-reel.md).
    expect(reel.entrega).toBeUndefined();
    expect(reel.perfil).toBeUndefined();
  });

  it('existe o clipe de CTA 9:16 no repo de domínio', () => {
    expect(existsSync(join(REPO_DOMINIO, 'cta', 'cta-9x16.mp4'))).toBe(true);
  });
});

/**
 * Perfil por FASE. O slot existia em `resolverPerfil` (precedência 2) e nunca
 * tinha sido ligado — toda fase de todo fluxo rodava no padrão do `.env`.
 * A fase de texto escreve o roteiro dos 12 públicos uma vez; a de reel
 * multiplica por público e só lê o mosaico. São trabalhos diferentes.
 */
describe('perfil por fase', () => {
  it('grava no job o perfil que a fase declarou, resolvido sobre o padrão', () => {
    const comPerfil = {
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto'
        ? { ...f, perfil: { modelo: 'opus', esforco: 'high' } }
        : f.id === 'reel' ? { ...f, perfil: { modelo: 'haiku' } } : f)),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: comPerfil, hash: 'h',
      assunto: 'assunto', alvos: ['mulheres'], chatId: 55,
    }).id;

    const texto = fila.listar().find((j) => j.flow_ref === `A#${id}//texto`)!;
    expect(texto.modelo).toBe('opus');
    expect(texto.esforco).toBe('high');
    // O que a fase NÃO declarou vem do padrão — não fica nulo, senão o worker
    // ignora o job inteiro (`skills.ts` exige os três campos).
    expect(texto.motor).toBeTruthy();
  });

  it('fase sem `perfil` continua caindo no padrão — nada muda para fluxo antigo', () => {
    // Construído SEM perfil de propósito: o flow.json real passou a declarar um
    // na fase de texto (2026-08-05), e um fluxo criado antes disso — ou de outro
    // domínio — não pode mudar de modelo por o campo existir.
    const semPerfil = {
      ...def,
      fases: def.fases.map(({ perfil, ...resto }) => resto),
    };
    const id = fluxos.criar({
      tipo: 'promoavatar', definicao: semPerfil, hash: 'h',
      assunto: 'assunto', alvos: ['mulheres'], chatId: 55,
    }).id;
    const texto = fila.listar().find((j) => j.flow_ref === `A#${id}//texto`)!;
    expect(texto.modelo).toBeNull();
  });

  it('modelo inexistente derruba o flow.json no parse, não na hora de rodar', () => {
    expect(() => validarFlow({
      ...def,
      fases: def.fases.map((f) => (f.id === 'texto' ? { ...f, perfil: { modelo: 'opus5' } } : f)),
    }, REPO_DOMINIO, def.fases.map((f) => f.tarefa))).toThrow(/opus5/);
  });

  // `cli.rodar` — o comando é do domínio, e é CONFERIDO na carga. A alternativa
  // (prosa dentro de um prompt) foi o que deixou um modelo inventar o binário
  // `musicavideo`, que não existe no PATH, e só falhar no primeiro job real.
  describe('cli.rodar: o comando é declarado e validado', () => {
    const comCli = (extra: Record<string, unknown>): FlowDef => ({
      ...def,
      fases: [{
        id: 'roda', escopo: 'fluxo', fila: 'io', kind: 'function',
        tarefa: 'cli.rodar', max_tentativas: 1, ...extra,
      }] as FlowDef['fases'],
    });
    const tarefas = ['cli.rodar'];

    it('sem `comando`, o flow.json é recusado na carga', () => {
      expect(() => validarFlow(comCli({}), REPO_DOMINIO, tarefas)).toThrow(/comando/);
    });

    it('comando com caminho FIXO é recusado — não sobrevive a outra máquina', () => {
      expect(() => validarFlow(comCli({ comando: 'bash /home/alguem/x.sh {{input}}' }),
        REPO_DOMINIO, tarefas)).toThrow(/\{\{repo\}\}/);
    });

    // Com prompt e tudo: mesmo assim é recusado. `cli.rodar` como agente seria
    // exatamente o desenho que estamos desmontando — um modelo lendo prosa para
    // digitar um comando que já está declarado ao lado.
    it('kind agent com cli.rodar é recusado — quem roda é o BOT', () => {
      expect(() => validarFlow(
        comCli({ comando: 'bash {{repo}}/x.sh', kind: 'agent', prompt: 'prompts/fase1-texto.md' }),
        REPO_DOMINIO, tarefas,
      )).toThrow(/function/);
    });

    it('`comando` em fase que não é cli.rodar é recusado', () => {
      expect(() => validarFlow({
        ...def,
        fases: def.fases.map((f) => (f.id === 'texto' ? { ...f, comando: 'bash {{repo}}/x.sh' } : f)),
      }, REPO_DOMINIO, def.fases.map((f) => f.tarefa))).toThrow(/cli\.rodar/);
    });

    it('declarado direito, passa e sobrevive ao congelamento', () => {
      const d = validarFlow(comCli({ comando: 'bash {{repo}}/x.sh plano {{input}}' }),
        REPO_DOMINIO, tarefas);
      expect(d.fases[0]!.comando).toBe('bash {{repo}}/x.sh plano {{input}}');
      expect(congelar(d, REPO_DOMINIO).fases[0]!.comando)
        .toBe('bash {{repo}}/x.sh plano {{input}}');
    });
  });

  // A GARANTIA DE NÃO-REGRESSÃO: o promoavatar é anterior a tudo isso e não
  // declara `comando` em fase nenhuma. Campo novo é opcional — quem não usa
  // continua idêntico.
  it('o flow.json REAL do promoavatar não muda com o campo novo', () => {
    expect(def.fases.some((f) => f.comando !== undefined)).toBe(false);
    expect(def.fases.map((f) => f.tarefa)).not.toContain('cli.rodar');
  });
});
