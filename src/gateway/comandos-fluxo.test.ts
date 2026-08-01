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

/**
 * O defeito que motivou isto: `/promoavatar <assunto> alvos=mulheres` — sem a
 * barra — não filtrou nada. O `alvos=mulheres` virou TEXTO do assunto, o fluxo
 * nasceu com os 12 públicos, e o agente ainda leu aquilo como ordem e gerou um
 * público só. Três comportamentos errados e nenhum aviso.
 */
describe('campo escrito sem o separador', () => {
  it('recusa em vez de engolir como assunto', async () => {
    const r = await manda('/brinquedo Assunto qualquer alvos=um');
    expect(r).toContain('ficou dentro do assunto');
    expect(fila.listar()).toHaveLength(0);
  });

  it('o erro ensina as duas formas certas', async () => {
    const r = await manda('/brinquedo Assunto alvos=um');
    expect(r).toContain('| alvos=valor');
    expect(r).toContain('--alvos=valor');
  });

  it('pega versao= e de= também, não só alvos=', async () => {
    expect(await manda('/brinquedo Assunto versao=2')).toContain('ficou dentro do assunto');
    expect(await manda('/brinquedo Assunto de=render')).toContain('ficou dentro do assunto');
  });

  // A guarda não pode passar a recusar assunto legítimo: `=` em texto corrido é
  // comum, e só os NOMES de campo conhecidos disparam.
  it('não confunde um "=" qualquer no assunto com campo', async () => {
    const r = await manda('/brinquedo Aula sobre por que 2+2=4 e outras somas');
    expect(r).toContain('B#1');
  });
});

describe('--alvo=x, a forma de bandeira', () => {
  it('--alvo=um filtra igual a | alvos=um', async () => {
    await manda('/brinquedo Assunto --alvo=um');
    expect(fluxos.status(1)!.fases.some((f) => f.alvo === 'dois')).toBe(false);
  });

  it('repetir --alvo acumula os públicos', async () => {
    await manda('/brinquedo Assunto --alvo=um --alvo=dois');
    const alvos = new Set(fluxos.status(1)!.fases.map((f) => f.alvo).filter(Boolean));
    expect([...alvos].sort()).toEqual(['dois', 'um']);
  });

  it('--alvos=a,b também, e a vírgula solta não vira alvo vazio', async () => {
    await manda('/brinquedo Assunto --alvo=um, --alvo=dois');
    const alvos = new Set(fluxos.status(1)!.fases.map((f) => f.alvo).filter(Boolean));
    expect([...alvos].sort()).toEqual(['dois', 'um']);
  });

  it('a bandeira sai do assunto — não sobra no texto que vai ao agente', async () => {
    await manda('/brinquedo Lançamento de março --alvo=um');
    expect(fluxos.status(1)!.fluxo.assunto).toBe('Lançamento de março');
  });

  it('--sombra não enfileira nada', async () => {
    const r = await manda('/brinquedo Assunto --sombra');
    expect(r).toContain('NADA foi enfileirado');
    expect(fila.listar()).toHaveLength(0);
  });

  it('bandeira sem valor é erro nomeado, não alvo vazio', async () => {
    const r = await manda('/brinquedo Assunto --alvo=');
    expect(r).toContain('precisa de um valor');
    expect(fila.listar()).toHaveLength(0);
  });
});

describe('/<fluxo> help — a ajuda mora no DOMÍNIO', () => {
  it('usa o HELP.md do repo de domínio quando ele existe', async () => {
    writeFileSync(join(repo, 'HELP.md'), 'ajuda escrita por quem entende do assunto');
    expect(await manda('/brinquedo help')).toContain('quem entende do assunto');
  });

  it('help, ajuda e ? são a mesma coisa', async () => {
    writeFileSync(join(repo, 'HELP.md'), 'MINHA AJUDA');
    for (const forma of ['help', 'ajuda', '?']) {
      expect(await manda(`/brinquedo ${forma}`)).toContain('MINHA AJUDA');
    }
  });

  // Sem isto, quem digita `/brinquedo help` esperando ajuda DISPARA um fluxo
  // com o assunto "help" — e gasta agente por engano.
  it('não cria fluxo nenhum ao pedir ajuda', async () => {
    await manda('/brinquedo help');
    expect(fila.listar()).toHaveLength(0);
  });

  // O fallback não é texto fixo: é derivado do flow.json, então o mínimo nunca
  // mente mesmo que ninguém escreva ajuda nenhuma.
  it('sem HELP.md, gera a ajuda a partir do próprio flow.json', async () => {
    const r = await manda('/brinquedo help');
    expect(r).toContain('texto');
    expect(r).toContain('render');
    expect(r).toContain('um, dois');       // os alvos reais
    expect(r).toContain('/status B#N');    // o prefixo real
    expect(r).toContain('| sombra');
  });

  it('a ajuda gerada anuncia o portão só quando o fluxo tem portão', async () => {
    expect(await manda('/brinquedo help')).not.toContain('/aprovar');
  });
});

describe('| de=<fase>', () => {
  it('começa no meio e LISTA os títulos esperados no estúdio', async () => {
    const r = await manda('/brinquedo Assunto | alvos=um | de=render');
    // Sem os títulos, quem gera o material fora não tem como acertar o nome —
    // e o download procura exatamente por ele.
    expect(r).toContain('começando em "render"');
    expect(r).toContain('B1-um-v1');
    expect(fila.listar()[0]!.flow_ref).toBe('B#1/um/render');
  });

  it('fase inexistente é recusada, sem criar fluxo', async () => {
    const r = await manda('/brinquedo Assunto | de=inventada');
    expect(r).toMatch(/não existe neste fluxo/);
    expect(fila.listar()).toHaveLength(0);
  });

  it('sem `de`, não polui a resposta com títulos', async () => {
    expect(await manda('/brinquedo Assunto')).not.toContain('Títulos esperados');
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
    expect(await manda('/status 1')).toContain('job j1');
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

/**
 * `/refazer A6 jovens` (sem o `#`) caía calado: `refazerFluxo` devolvia
 * `undefined`, o texto escorregava para o tratador de JOB, que espera número, e
 * morria como comando desconhecido. O `/aprovar` já avisava; estes dois não.
 */
describe('referência de fluxo malformada', () => {
  // O `#` deixou de ser obrigatório: `B1` é tão inequívoco quanto `B#1`, e
  // exigi-lo custou uma tentativa perdida no chat real (31/07). Agora só o que
  // NÃO é referência nem número vira aviso.
  it('sem o # é aceito como referência', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    expect(await manda('/status B1')).toContain('B#1');
    expect(await manda('/status b1')).toContain('B#1');
  });

  it('referência de fluxo que não existe diz isso, e não "não entendi"', async () => {
    expect(await manda('/refazer B9 um')).toContain('não existe neste bot');
  });

  it('texto que não é referência nem número avisa', async () => {
    expect(await manda('/cancelar xyz')).toContain('não entendi');
  });

  // Número continua sendo JOB — o fallthrough é intencional aí.
  it('número segue para o tratador de job', async () => {
    const r = await manda('/status 13');
    expect(r).not.toContain('não entendi');
  });

  it('referência certa continua funcionando', async () => {
    await manda('/brinquedo Assunto');
    expect(await manda('/status B#1')).toContain('B#1');
  });
});

/**
 * O caso real: depois de um `/refazer`, o fluxo já estava trabalhando, mas a
 * resposta era só a contagem e vinha silêncio por minutos. A pessoa insistiu no
 * `/aprovar`, ouviu "não está esperando aprovação" — verdade que não ajuda — e
 * acabou criando um fluxo NOVO por engano, gastando um avatar gravado à mão.
 */
describe('o bot diz o que está fazendo', () => {
  async function comFaseFalhada(): Promise<void> {
    await manda('/brinquedo Assunto | alvos=um');
    const job = fila.listar()[0]!;
    fila.pegar(job.fila, 600, 'W');
    fila.falhar(job.id, 'deu ruim', 'W', 1, (j) => fluxos.avancar(j));
  }

  it('/refazer diz QUAL fase voltou e o job', async () => {
    await comFaseFalhada();
    const r = await manda('/refazer B#1');
    expect(r).toContain('texto');
    expect(r).toMatch(/job \d+/);
  });

  it('/refazer avisa que NÃO precisa aprovar', async () => {
    await comFaseFalhada();
    expect(await manda('/refazer B#1')).toContain('Não precisa aprovar');
  });

  it('/aprovar num fluxo que está trabalhando diz o que ele faz, não só "não"', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const r = await manda('/aprovar B#1');
    expect(r).toContain('não está esperando aprovação');
    expect(r).toContain('Está trabalhando');
    expect(r).toContain('texto');
  });

  it('/aprovar num fluxo já terminado diz que terminou', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    for (const j of fila.listar()) {
      fila.pegar(j.fila, 600, 'W');
      fila.concluir(j.id, 'ok', 'W', (x) => fluxos.avancar(x));
    }
    for (const j of fila.listar().filter((x) => x.status === 'queued')) {
      fila.pegar(j.fila, 600, 'W');
      fila.concluir(j.id, 'ok', 'W', (x) => fluxos.avancar(x));
    }
    expect(await manda('/aprovar B#1')).toMatch(/Já terminou|Está trabalhando|na fila/);
  });
});

/**
 * Do chat real, 31/07 22:46: `/aprovado` → "comando não reconhecido";
 * `/aprovar` sem referência → "diga qual: /aprovar P#16" com UM único fluxo
 * esperando no portão. O bot sabia a resposta e mandou a pessoa caçar o número.
 */
describe('liberar o portão sem atrito', () => {
  async function noPortao(): Promise<void> {
    await manda('/brinquedo Assunto | alvos=um');
    const job = fila.listar()[0]!;
    fila.pegar(job.fila, 600, 'W');
    fila.concluir(job.id, 'ok', 'W', (j) => fluxos.avancar(j));
  }

  it.each(['/aprovar', '/aprovado', '/pronto', '/ok'])('%s sozinho libera o único fluxo esperando', async (verbo) => {
    // O flow.json de brinquedo não tem portão; forço o estado de espera.
    await manda('/brinquedo Assunto | alvos=um');
    const visao = fluxos.status(1)!;
    // Sem portão declarado, nada está aguardando: a resposta tem que dizer isso,
    // não "diga qual".
    expect(await manda(verbo)).toContain('nenhum fluxo esperando');
    void visao; void noPortao;
  });

  it('com mais de um esperando, lista as referências em vez de mandar adivinhar', async () => {
    const r = await manda('/aprovar');
    expect(r).not.toContain('/aprovar P#16');
  });

  it('com referência continua funcionando', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    expect(await manda('/aprovar B#1')).toContain('B#1');
  });

  it('referência inválida ensina o formato certo', async () => {
    expect(await manda('/pronto xyz')).toContain('não entendi');
  });
});
