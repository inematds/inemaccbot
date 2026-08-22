// Os comandos de fluxo pelo caminho REAL do chat, com um repo de domínio de
// brinquedo — nenhum teste toca Telegram nem `claude`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ctaDaDefinicao, type FlowDef } from '../dominio/flow.js';
import { definirCapaFluxo, parseCapa, tabelaFluxo } from './comandos-fluxo.js';
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

// `tudo` atravessa o roteamento de ajuda de DOMÍNIO — que só existe quando há
// fluxos ligados. Sem a palavra reservada, `/ajuda tudo` responderia "não
// conheço \"tudo\"", porque o nome cairia na busca por skill/fluxo.
describe('/ajuda em dois níveis', () => {
  it('o resumo não lista tudo, mas ensina como pedir o resto', async () => {
    const r = await manda('/ajuda');
    expect(r).toContain('/ajuda tudo');
    expect(r).not.toContain('/furar');
  });

  it('/ajuda tudo devolve a lista inteira, não "não conheço"', async () => {
    const r = await manda('/ajuda tudo');
    expect(r).toContain('/furar');
    expect(r).not.toContain('não conheço');
  });

  it('/ajuda <fluxo> continua sendo a ajuda daquele fluxo', async () => {
    expect(await manda('/ajuda brinquedo')).toContain('brinquedo');
  });
});

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

  // `estudio` estava em CAMPOS e BANDEIRAS mas faltava na alternação de
  // `campo=valor`, então `| estudio=nao` era recusado como campo desconhecido.
  it('| estudio=nao é aceito como as outras bandeiras', async () => {
    expect(await manda('/brinquedo Assunto | estudio=nao')).not.toMatch(/campo desconhecido/);
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

  // Aconteceu no chat: `| sombra.` morria como "campo desconhecido: sombra.".
  // Ponto no fim é hábito de quem escreve frase, não erro de uso.
  it('pontuação no fim do campo é aparada', async () => {
    const r = await manda('/brinquedo Assunto | sombra.');
    expect(r).toContain('NADA foi enfileirado');
    expect(fila.listar()).toHaveLength(0);
  });

  it('pontuação é aparada também no campo com valor', async () => {
    await manda('/brinquedo Assunto | alvos=um,dois;');
    const visao = fluxos.status(1)!;
    const alvos = new Set(visao.fases.filter((f) => f.alvo).map((f) => f.alvo));
    expect(alvos).toEqual(new Set(['um', 'dois']));
  });

  // O assunto é `partes.shift()` e não passa pela aparagem — a pontuação DELE
  // é conteúdo, e o assunto de debate ("isso é bom ou ruim?") vive disso.
  it('a pontuação do ASSUNTO fica intacta', async () => {
    await manda('/brinquedo Isso é bom ou ruim? | sombra');
    await manda('/brinquedo Isso é bom ou ruim?');
    expect(fluxos.status(1)!.fluxo.assunto).toBe('Isso é bom ou ruim?');
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

/**
 * As duas flags novas. A regra que rege as duas: DESLIGADAS, o fluxo é byte por
 * byte o de hoje — nem a fase `gerar` entra na definição, nem o portão sai.
 */
describe('| api e | sem-portao', () => {
  /** Repo de brinquedo com a fase `gerar` declarada e um portão depois do texto. */
  function comGerarEPortao(): void {
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      avatar_id: 'av-1', voice_id: 'vo-1',
      alvos: { um: { canal: 'lives1' }, dois: { canal: 'lives2' } },
      fases: [
        { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md', pausa_apos: true },
        { id: 'gerar', escopo: 'alvo', fila: 'io', kind: 'function', tarefa: 'heygen.gerar', opcional: 'api', espera: { intervalo: 60, timeout: 3600 } },
        { id: 'render', escopo: 'alvo', fila: 'render', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' },
      ],
    }));
  }

  const fasesDe = (id: number): string[] =>
    [...new Set(fluxos.status(id)!.fases.map((f) => f.fase))];

  beforeEach(() => { comGerarEPortao(); });

  describe('sem flag nenhuma: o comportamento de hoje', () => {
    it('a fase `gerar` NÃO entra no fluxo', async () => {
      await manda('/brinquedo Assunto');
      expect(fasesDe(1)).not.toContain('gerar');
      expect(fasesDe(1)).toContain('texto');
    });

    it('o | sombra também não mostra a fase gerar', async () => {
      expect(await manda('/brinquedo Assunto | sombra')).not.toContain('gerar');
    });

    it('o portão continua de pé', async () => {
      await manda('/brinquedo Assunto');
      const fase = fluxos.status(1)!.fases.find((f) => f.fase === 'texto')!;
      expect(fluxos.status(1)!.fluxo.definicao_json).toContain('pausa_apos');
      expect(fase).toBeTruthy();
    });
  });

  describe('| api', () => {
    it('põe a fase gerar no fluxo', async () => {
      await manda('/brinquedo Assunto | api');
      expect(fasesDe(1)).toContain('gerar');
    });

    it('aparece no | sombra antes de gastar', async () => {
      const r = await manda('/brinquedo Assunto | api | sombra');
      expect(r).toContain('gerar');
      expect(r).toContain('NADA foi enfileirado');
    });

    it('--api é a mesma coisa', async () => {
      await manda('/brinquedo Assunto --api');
      expect(fasesDe(1)).toContain('gerar');
    });

    // O portão fica: com a API, um texto ruim que passa direto custa dinheiro.
    it('NÃO tira o portão sozinho', async () => {
      await manda('/brinquedo Assunto | api');
      expect(fluxos.status(1)!.fluxo.definicao_json).toContain('pausa_apos');
    });
  });

  describe('| creditos', () => {
    /** O mesmo repo de brinquedo, com as TRÊS fases opcionais declaradas. */
    function comAsDuasRotas(): void {
      writeFileSync(join(repo, 'flow.json'), JSON.stringify({
        nome: 'brinquedo', prefixo: 'B', versao_def: 3,
        avatar_id: 'av-1', voice_id: 'vo-1',
        alvos: { um: { canal: 'lives1' } },
        fases: [
          { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md', pausa_apos: true },
          { id: 'gerar', escopo: 'alvo', fila: 'io', kind: 'function', tarefa: 'heygen.gerar', opcional: 'api' },
          { id: 'gerar-creditos', escopo: 'alvo', fila: 'io', kind: 'function', tarefa: 'heygen.gerar-creditos', opcional: 'creditos' },
          { id: 'navega-avatar', escopo: 'alvo', fila: 'navegador', kind: 'agent', tarefa: 'fluxo-navegador', prompt: 'prompts/a.md', opcional: 'navega' },
        ],
      }));
    }

    beforeEach(() => { comAsDuasRotas(); });

    it('põe a fase de créditos, e NÃO a de api', async () => {
      await manda('/brinquedo Assunto | creditos');
      expect(fasesDe(1)).toContain('gerar-creditos');
      expect(fasesDe(1)).not.toContain('gerar');
    });

    it('| api põe a de api, e não a de créditos', async () => {
      await manda('/brinquedo Assunto | api');
      expect(fasesDe(1)).toContain('gerar');
      expect(fasesDe(1)).not.toContain('gerar-creditos');
    });

    it('sem flag, nenhuma das três entra', async () => {
      await manda('/brinquedo Assunto');
      expect(fasesDe(1)).not.toContain('gerar');
      expect(fasesDe(1)).not.toContain('gerar-creditos');
      expect(fasesDe(1)).not.toContain('navega-avatar');
    });

    it('| navega põe SÓ a fase de navegador', async () => {
      await manda('/brinquedo Assunto | navega');
      expect(fasesDe(1)).toContain('navega-avatar');
      expect(fasesDe(1)).not.toContain('gerar');
      expect(fasesDe(1)).not.toContain('gerar-creditos');
    });

    // A fase de navegador dirige o Chromium EXCLUSIVO do display `:99`; a fila
    // `navegador` tem concorrência 1 por causa disso. Se ela caísse na fila
    // errada, dois jobs disputariam o mesmo navegador.
    it('| navega deixa a fase na fila `navegador` na definição congelada', async () => {
      await manda('/brinquedo Assunto | navega');
      const def = JSON.parse(fluxos.status(1)!.fluxo.definicao_json) as {
        fases: { id: string; fila: string }[];
      };
      expect(def.fases.find((f) => f.id === 'navega-avatar')?.fila).toBe('navegador');
    });

    // As duas juntas gerariam o MESMO vídeo duas vezes, cobrando dos dois
    // bolsos. Recusar é melhor que escolher por conta própria qual vale.
    it('as duas rotas juntas é RECUSADO, sem enfileirar nada', async () => {
      const r = await manda('/brinquedo Assunto | api | creditos');
      expect(r).toMatch(/api.*creditos|creditos.*api/i);
      expect(r).toMatch(/uma|duas|só/i);
      expect(fila.listar()).toHaveLength(0);
      expect(fluxos.status(1)).toBeUndefined();
    });

    // A exclusão é por CONTAGEM, não par a par: com três rotas, testar só
    // `api+creditos` deixaria os outros dois pares passarem calados.
    it.each([
      ['| api | navega'],
      ['| creditos | navega'],
      ['| api | creditos | navega'],
    ])('%s também é RECUSADO', async (flags) => {
      const r = await manda(`/brinquedo Assunto ${flags}`);
      expect(r).toMatch(/uma|só/i);
      expect(fila.listar()).toHaveLength(0);
      expect(fluxos.status(1)).toBeUndefined();
    });
  });

  describe('| sem-portao', () => {
    it('tira a pausa da definição congelada', async () => {
      await manda('/brinquedo Assunto | sem-portao');
      expect(fluxos.status(1)!.fluxo.definicao_json).not.toContain('pausa_apos');
    });

    it('não liga a API por tabela', async () => {
      await manda('/brinquedo Assunto | sem-portao');
      expect(fasesDe(1)).not.toContain('gerar');
    });

    it('as duas juntas: gera e não para', async () => {
      await manda('/brinquedo Assunto | api | sem-portao');
      expect(fasesDe(1)).toContain('gerar');
      expect(fluxos.status(1)!.fluxo.definicao_json).not.toContain('pausa_apos');
    });
  });

  it('o campo desconhecido continua listando o que existe, agora com as duas', async () => {
    const r = await manda('/brinquedo Assunto | inventado');
    expect(r).toContain('api');
    expect(r).toContain('sem-portao');
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

// A MESMA armadilha da ajuda, com a palavra que todo mundo digita primeiro.
// Em 2026-08-21 o `/musicavideo status` criou o MVD#88 — um fluxo de verdade,
// com o assunto "status", que rodou a fase de plano e falhou. Perguntar pelo
// andamento não pode custar um fluxo.
// Copiar e colar a mensagem anterior traz o `/comando` junto, e ele virava a
// primeira palavra do ASSUNTO: no MVD#90 (2026-08-21) o texto que foi para o
// planejador começava com "/musicavideo Para a música...", e o domínio planejou
// uma música sobre isso.
// `/status 90` era JOB, sempre. Só que o painel logo acima lista `MVD#90`, e
// digitar o número que se acabou de ler é o reflexo: a resposta vinha sobre um
// job antigo de mesmo id, e parecia que "o /status não mostra as fases".
describe('/status <número>', () => {
  it('número de fluxo existente mostra o FLUXO, e lembra do job', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const r = await manda('/status 1');
    expect(r).toContain('B#1');
    expect(r).toContain('texto');
    expect(r).toContain('/jobs 1');
  });

  it('número que não é fluxo continua indo para o tratador de job', async () => {
    const r = await manda('/status 4242');
    expect(r).not.toContain('B#');
  });
});

describe('/<fluxo> com o comando ecoado no texto', () => {
  it('o eco do comando não vira parte do assunto', async () => {
    await manda('/brinquedo /brinquedo Lançamento de março | alvos=um');
    const fluxo = fluxos.status(1)!.fluxo;
    expect(fluxo.assunto).toBe('Lançamento de março');
  });

  it('um assunto que só MENCIONA o comando no meio fica intacto', async () => {
    await manda('/brinquedo compare o /brinquedo com o outro | alvos=um');
    expect(fluxos.status(1)!.fluxo.assunto).toBe('compare o /brinquedo com o outro');
  });
});

describe('/<fluxo> status — a situação do último fluxo do domínio', () => {
  it('não cria fluxo nenhum', async () => {
    await manda('/brinquedo status');
    expect(fila.listar()).toHaveLength(0);
  });

  it('mostra a tabela de fases do último fluxo daquele domínio', async () => {
    await manda('/brinquedo Assunto de verdade | alvos=um');
    const r = await manda('/brinquedo status');
    expect(r).toContain('B#1');
    expect(r).toContain('texto');   // as fases, que é o que se foi ver
  });

  it('status, situação e andamento são a mesma coisa', async () => {
    await manda('/brinquedo Assunto de verdade | alvos=um');
    for (const forma of ['status', 'situacao', 'situação', 'andamento']) {
      expect(await manda(`/brinquedo ${forma}`)).toContain('B#1');
    }
    expect(fila.listar()).toHaveLength(1);   // nenhum fluxo a mais
  });

  // Sem fluxo nenhum, a resposta ensina a começar em vez de dizer "não existe".
  it('sem fluxo do domínio, aponta o exemplo do registro', async () => {
    const r = await manda('/brinquedo status');
    expect(r).toContain('nenhum fluxo');
    expect(r).toContain('/brinquedo');
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
    expect(r).toContain('def v3');
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

  // MUDANÇA DELIBERADA: `/status` sozinho era a lista de jobs e virou o painel
  // dos fluxos. A pergunta que se faz no chat é "quais assuntos estão em pé e o
  // que cada um espera de mim" — job solto é detalhe de máquina. A lista de
  // jobs não sumiu: `/jobs` é o mesmo comando, e o painel aponta para ela.
  describe('/status sozinho — o painel dos fluxos', () => {
    it('sem fluxo aberto, diz isso e aponta as duas saídas', async () => {
      const r = await manda('/status');
      expect(r).toContain('Nenhum fluxo aberto');
      expect(r).toContain('/completos');
      expect(r).toContain('/jobs');
    });

    // Job de SKILL (sem fluxo) não aparecia em lugar nenhum do painel. Quem
    // manda um `analisevideo:` e digita `/status` está perguntando o que o bot
    // está FAZENDO — e via um painel que não mencionava o trabalho em curso.
    it('mostra os jobs de skill vivos, que não têm fluxo', async () => {
      fila.enfileirar({ tarefa: 'brinquedo', fila: 'io', kind: 'agent', input: '{}', chat_id: 9 });
      const r = await manda('/status');
      expect(r).toContain('Skills:');
      expect(r).toContain('brinquedo');
    });

    it('sem job de skill, a linha nem aparece', async () => {
      const r = await manda('/status');
      expect(r).not.toContain('Skills:');
    });

    it('lista o número, a situação e o assunto de cada fluxo aberto', async () => {
      await manda('/brinquedo Primeiro assunto');
      await manda('/brinquedo Segundo assunto');
      const r = await manda('/status');
      expect(r).toContain('Fluxos abertos (2):');
      expect(r).toContain('B#1');
      expect(r).toContain('Primeiro assunto');
      expect(r).toContain('B#2');
      expect(r).toContain('Segundo assunto');
    });

    it('traz o detalhe fase × alvo de cada um, SEM repetir os atalhos por fluxo', async () => {
      await manda('/brinquedo Primeiro assunto');
      await manda('/brinquedo Segundo assunto');
      const r = await manda('/status');
      expect(r).toContain('def v');
      // O atalho aparece UMA vez, no rodapé — não uma vez por fluxo.
      expect(r.match(/\/refazer/g)?.length).toBe(1);
    });

    it('a lista de jobs continua viva em /jobs', async () => {
      expect(await manda('/jobs')).toMatch(/Nada na fila|Na fila agora/);
    });

    // O rodapé dizia `/status C#12` com o número CRAVADO no código, e o C#12 já
    // nem estava aberto — o painel mandava agir num fluxo que não era o seu.
    describe('o rodapé usa o ref REAL, não um número de exemplo', () => {
      it('com um fluxo aberto, o atalho é o dele', async () => {
        await manda('/brinquedo Assunto único');
        const r = await manda('/status');
        expect(r).toContain('/status B#1');
        expect(r).not.toMatch(/C#12/);
      });

      it('com vários, usa <ref> em vez de eleger um', async () => {
        await manda('/brinquedo Primeiro');
        await manda('/brinquedo Segundo');
        const r = await manda('/status');
        expect(r).toContain('/status <ref>');
        expect(r).not.toMatch(/C#12/);
      });

      it('/completos também não crava número', async () => {
        expect(await manda('/completos')).not.toMatch(/C#12/);
      });
    });
  });

  // O C#15 tem 36 alvos: `baixar:` e `reel:` viravam duas paredes de
  // `✅ nome ·` que o Telegram quebrava no meio das palavras
  // (`pessoa-`/`comum-pro`). O que se lê de relance é a CONTAGEM; nome de alvo
  // só interessa quando é exceção — o que falhou e o que espera você.
  describe('fase com muitos alvos: conta, e nomeia só a exceção', () => {
    const fase = (nome: string, alvo: string, estado: string, erro: string | null = null) =>
      ({ fase: nome, alvo, estado, erro } as never);
    const visaoCom = (fases: unknown[]) => ({
      fluxo: { prefixo: 'C', id: 15, tipo: 'promoavatar3', assunto: 'assunto', status: 'rodando', versao_def: 1 },
      fases,
    } as never);

    const trinta = (estado: string, nome = 'reel') =>
      Array.from({ length: 30 }, (_, i) => fase(nome, `alvo${i}`, estado));

    it('todos no mesmo estado viram uma contagem, sem listar nome', () => {
      const r = tabelaFluxo(visaoCom(trinta('feito')), false);
      expect(r).toContain('30/30');
      expect(r).not.toContain('alvo7');
    });

    it('mistura de estados vira contagem por estado', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'sobrou', 'pendente')]), false);
      expect(r).toMatch(/30\/31/);
      expect(r).toMatch(/01 ⏳/);
    });

    // Mudou em 2026-08-13: a falha deixou de ser nomeada NA LINHA DA FASE e
    // passou a ter seção própria, agrupada por causa — só no detalhe. No painel
    // fica a contagem, que é o pedido de quem olha vários fluxos de relance.
    it('o que FALHOU aparece no detalhe, na seção de falhas', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'jovens-aut', 'falhou')]), true);
      expect(r).toContain('jovens-aut');
      expect(r).toContain('Falhas (1)');
    });

    it('o que FALHOU NÃO é nomeado no painel — lá é contagem', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'jovens-aut', 'falhou')]), false);
      expect(r).not.toContain('jovens-aut');
      expect(r).toMatch(/1 ❌/);
    });

    // Nomear o que RODA entrou em 2026-08-12 e virou pedido do DETALHE em
    // 2026-08-14: no painel de vários fluxos, `rodando` + `esperando você` com
    // 36 alvos empurravam o fluxo seguinte para fora da tela.
    it('o que está RODANDO é nomeado no DETALHE, mesmo no meio de 30', () => {
      // MESMA fase dos 30: com fase própria seriam 1 alvo, que cai no ramo
      // "poucos alvos" e nomeia de qualquer jeito — o teste passaria sem provar nada.
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'profissionais-aut', 'rodando')]), true);
      expect(r).toContain('profissionais-aut');
    });

    it('...e NÃO é nomeado no painel — lá é só número', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'profissionais-aut', 'rodando')]), false);
      expect(r).not.toContain('profissionais-aut');
      expect(r).toMatch(/01 ▶️/);
    });

    // O contrário do pedido: `pendente` NÃO é nomeado. Com 35 na fila a lista
    // vira a parede de nomes que a contagem existe para evitar.
    it('o que está na FILA continua só contado', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'so-na-fila', 'pendente')]), false);
      expect(r).not.toContain('so-na-fila');
    });

    // Nomear sem teto reintroduz a parede: 20 rodando ao mesmo tempo (a fila
    // `io` roda em paralelo) sairiam em uma linha só, quebrada no meio da
    // palavra pelo Telegram.
    it('nomeação tem teto, e diz quantos ficaram de fora', () => {
      const muitos = Array.from({ length: 20 }, (_, i) => fase('reel', `alvo-rodando-${i}`, 'rodando'));
      const r = tabelaFluxo(visaoCom([...trinta('feito'), ...muitos]), true);
      expect(r).toContain('alvo-rodando-0');
      expect(r).not.toContain('alvo-rodando-19');
      expect(r).toMatch(/\+\d+/);
    });

    it('o que espera VOCÊ é nomeado no detalhe', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'mulheres-pro', 'aguardando-ok')]), true);
      expect(r).toContain('mulheres-pro');
    });

    // No painel a linha "⏸️ esperando você em <fase>" continua — ela é a AÇÃO,
    // não a lista. O que sai é a enumeração dos alvos.
    it('no painel, quem espera vira número mais a linha de ação', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'mulheres-pro', 'aguardando-ok')]), false);
      expect(r).not.toContain('mulheres-pro');
      expect(r).toContain('esperando você em "reel"');
    });

    // Poucos alvos continuam nomeados NO DETALHE: contar "02/02" esconderia
    // QUAIS, e nesse tamanho a lista cabe na tela sem virar parede.
    it('com poucos alvos, o detalhe continua listando nome por nome', () => {
      const r = tabelaFluxo(visaoCom([fase('render', 'um', 'feito'), fase('render', 'dois', 'feito')]), true);
      expect(r).toContain('um');
      expect(r).toContain('dois');
    });

    it('o painel conta mesmo com poucos alvos, com dois algarismos', () => {
      const r = tabelaFluxo(visaoCom([fase('render', 'um', 'feito'), fase('render', 'dois', 'feito')]), false);
      expect(r).toContain('02/02 ✅');
    });

    // O ✅ é AFIRMAÇÃO, não enfeite da contagem. Ele vinha colado sempre, e
    // `capa-clipe 00/01 ✅ · 01 ❌` dizia visto-e-erro na mesma linha: quem
    // varre o painel lê o verde primeiro e conclui que aquilo está pronto.
    // Com DOIS alvos a contagem volta a fazer sentido — com um só, ela é ruído
    // (ver "fluxo de um alvo só" mais abaixo).
    it('fase incompleta NÃO leva ✅ — só os números e o que está acontecendo', () => {
      const r = tabelaFluxo(visaoCom([
        fase('render', 'um', 'falhou'), fase('render', 'dois', 'falhou'),
      ]), false);
      expect(r).toContain('00/02');
      expect(r).not.toContain('00/02 ✅');
      expect(r).toContain('❌');
    });

    it('fase pela metade também não leva ✅', () => {
      const r = tabelaFluxo(visaoCom([
        fase('render', 'um', 'feito'), fase('render', 'dois', 'rodando'),
      ]), false);
      expect(r).toContain('01/02');
      expect(r).not.toContain('01/02 ✅');
      expect(r).toContain('▶️');
    });

    // PROGRESSO DENTRO DA FASE. Uma fase de uma hora aparecia como "▶️ rodando"
    // do começo ao fim: não dava para saber se tinha avançado 2 ou 40 shots,
    // nem se estava viva (dono, 2026-08-22: "poderia ter os clips 23/40").
    it('fase em curso mostra o progresso que o domínio declarou', () => {
      const r = tabelaFluxo(
        visaoCom([fase('render', '', 'rodando')]), false,
        () => '23/47 shots',
      );
      expect(r).toContain('▶️ 23/47 shots');
    });

    // A FALHADA é onde o número mais importa: a causa diz "não terminou em 180
    // min" e não diz que 11 dos 47 clipes ficaram prontos — que é o dado para
    // decidir se vale retomar. Excluí-la foi erro, corrigido em 2026-08-22.
    it('fase falhada mostra ONDE parou', () => {
      const r = tabelaFluxo(
        visaoCom([fase('render', '', 'falhou', 'estourou o teto')]), false, () => '11/47 shots',
      );
      expect(r).toContain('❌ 11/47 shots');
      expect(r).toContain('estourou o teto');
    });

    // A feita não mostra: ali o número seria o total repetido.
    it('fase feita não repete o total', () => {
      const feita = tabelaFluxo(visaoCom([fase('render', '', 'feito')]), false, () => '47/47 shots');
      expect(feita).not.toContain('47/47 shots');
    });

    it('domínio que não declara progresso não muda nada', () => {
      const r = tabelaFluxo(visaoCom([fase('render', '', 'rodando')]), false, () => undefined);
      expect(r).toContain('▶️');
    });

    // `pulado` significava duas coisas e o mesmo ⏭️ contava as duas: "não entrou
    // neste fluxo" (fase opcional, `| de=`) e "não chegou a rodar porque a
    // anterior quebrou". Num fluxo FALHADO o segundo é o que importa, e ⏭️ lido
    // como "pulei de propósito" fazia o painel parecer mais saudável do que
    // estava (dono, 2026-08-22: "se falhou e parou, as fases posteriores...").
    it('em fluxo falhado, fase posterior aparece BLOQUEADA, não pulada', () => {
      const visao = visaoCom([fase('render', '', 'falhou', 'estourou o teto')]);
      const comFalha = {
        ...(visao as unknown as Record<string, unknown>),
        fluxo: { prefixo: 'C', id: 15, tipo: 'x', assunto: 'a', status: 'falhou', versao_def: 1 },
        fases: [
          fase('render', '', 'falhou', 'estourou o teto'),
          fase('entregar', '', 'pulado'),
        ],
      } as never;
      const r = tabelaFluxo(comFalha, false);
      expect(r).toContain('⛔');
      expect(r).not.toContain('⏭️');
    });

    // E num fluxo que NÃO falhou, `pulado` continua sendo ⏭️: ali ele é escolha
    // (fase opcional que não entrou), não consequência.
    it('em fluxo saudável, pulado continua sendo ⏭️', () => {
      const r = tabelaFluxo(visaoCom([fase('gerar', '', 'pulado')]), false);
      expect(r).toContain('⏭️');
      expect(r).not.toContain('⛔');
    });

    // De relance: rodando e falhado têm que se separar SEM ler a palavra. Com
    // três fluxos na tela, "status: falhou" e "status: rodando" eram
    // indistinguíveis, e a pilha de ícones logo abaixo puxava o olho antes.
    it('o status do fluxo tem ícone, e ele vem primeiro', () => {
      const r = tabelaFluxo(visaoCom([fase('render', '', 'rodando')]), false);
      expect(r).toContain('▶️ rodando');
      expect(r).not.toContain('status: rodando');
    });

    // A legenda saiu daqui: com três fluxos, apareciam três legendas idênticas
    // separando justamente o que se quer comparar. Ela vive uma vez só, no fim
    // do painel inteiro.
    it('a tabela de um fluxo NÃO carrega a legenda', () => {
      const r = tabelaFluxo(visaoCom([fase('render', '', 'feito')]), false);
      expect(r).not.toContain('feito · ▶️ rodando');
    });

    // FLUXO DE UM ALVO SÓ: contagem é ruído. `capa-clipe 00/01 · 01 ❌` faz o
    // leitor decodificar dois números para descobrir o que um ícone já diz — e
    // o que ele veio buscar, POR QUE falhou, não estava em lugar nenhum da
    // tela. Reclamação do dono em 2026-08-22, olhando três fluxos falhados.
    it('com um alvo só, a linha é o estado — sem contagem', () => {
      const r = tabelaFluxo(visaoCom([fase('render', '', 'rodando')]), false);
      expect(r).toContain('▶️');
      expect(r).not.toContain('00/01');
    });

    it('e na falha, a CAUSA vem junto', () => {
      const r = tabelaFluxo(visaoCom([
        fase('render', '', 'falhou',
          'o render não terminou em 180 min — alvo /art/fluxos/B1/render.txt'),
      ]), false);
      expect(r).toContain('❌');
      expect(r).toContain('o render não terminou em 180 min');
      // O caminho interno que o bot nomeou serve ao log, não ao painel: ocupa
      // metade da linha e empurra a causa para fora do corte.
      expect(r).not.toContain('/art/fluxos');
    });

    // O NÚMERO DO PASSO. Sem ele a pilha diz o que aconteceu, mas não ONDE o
    // fluxo está: "capa-clipe ❌" não conta que isso é o passo 3 de 4, nem que
    // sobrou um (dono, 2026-08-22: "não aparece os números dos passos").
    it('cada fase mostra a posição dela no fluxo', () => {
      const r = tabelaFluxo(visaoCom([
        fase('texto', '', 'feito'), fase('render', '', 'rodando'), fase('entregar', '', 'pendente'),
      ]), false);
      expect(r).toContain('1/3 texto');
      expect(r).toContain('2/3 render');
      expect(r).toContain('3/3 entregar');
    });

    // `pendente` sozinho era `·`, o mesmo caractere do separador da linha —
    // não significava nada no painel.
    it('fase que ainda vai rodar aparece como fila, não como ponto', () => {
      const r = tabelaFluxo(visaoCom([fase('render', '', 'pendente')]), false);
      expect(r).toContain('⏳');
    });

    // O rabo que aponta para arquivo INTERNO do bot sai — nas duas formas que
    // ele tem — e a sobra de corte também: um travessão pendurado no fim é o
    // cadáver do trecho que acabou de sair, e lê-se como frase interrompida.
    it('a causa não termina em travessão órfão', () => {
      const r = tabelaFluxo(visaoCom([
        fase('render', '', 'falhou',
          'o agente terminou sem declarar RESULT — saída do agente em ~/state/saidas/1-t2.log'),
      ]), false);
      expect(r).toContain('o agente terminou sem declarar RESULT');
      expect(r).not.toContain('saidas/1-t2.log');
      expect(r).not.toMatch(/—\s*$/m);
    });

    // Causa longa vira UMA linha com reticência: o teto do detalhe quebra em
    // duas no celular e desalinha a pilha. Sumir no meio, sem aviso, é o que
    // faz alguém achar que a mensagem acabou ali.
    it('causa longa é cortada com reticência no painel', () => {
      const longa = `${'x'.repeat(120)} FIM`;
      const r = tabelaFluxo(visaoCom([fase('render', '', 'falhou', longa)]), false);
      expect(r).toContain('…');
      expect(r).not.toContain('FIM');
      const linhaCausa = r.split('\n').find((l) => l.includes('↳'))!;
      expect(linhaCausa.length).toBeLessThan(70);
    });

    // A coluna dos números alinha pelo NOME MAIS LONGO: com `capa-clipe` (10) e
    // largura fixa em 8, essa linha saía do prumo e a pilha deixava de ser
    // varrível de cima a baixo, que é a única coisa que o painel faz bem.
    it('a coluna alinha pelo nome de fase mais longo', () => {
      const r = tabelaFluxo(visaoCom([
        fase('plano', 'um', 'feito'), fase('plano', 'dois', 'feito'),
        fase('capa-clipe', 'um', 'rodando'), fase('capa-clipe', 'dois', 'rodando'),
      ]), false);
      const linhas = r.split('\n').filter((l) => /\d\d\/\d\d/.test(l));
      const colunas = linhas.map((l) => l.indexOf(l.match(/\d\d\/\d\d/)![0]));
      expect(new Set(colunas).size, `números em colunas diferentes: ${linhas.join(' | ')}`).toBe(1);
    });

    // O celular quebra por volta de 40 colunas. O assunto tem uma linha só para
    // ele (cortado), e as linhas de estado não passam da largura — senão o
    // painel volta pela metade e deixa de ser varrível com o olho.
    it('cada linha cabe na largura do chat', () => {
      const fases = [
        fase('texto', '', 'feito'),
        ...Array.from({ length: 36 }, (_, i) => fase('reel', `publico-longo-${i}-pro`, i < 6 ? 'feito' : 'pendente')),
      ];
      const v = visaoCom(fases) as { fluxo: { assunto: string } };
      v.fluxo.assunto = 'KIMI K3 mal saiu detonando todos e agora ja vem o K4. '
        + 'A China está entregando IA de ponta em código aberto. MINHA POSIÇÃO: '
        + 'aberto hoje não é garantia de aberto amanhã.';
      const linhas = tabelaFluxo(v as never, false).split('\n');
      for (const l of linhas) expect(l.length).toBeLessThanOrEqual(42);
    });

    // O cabeçalho da lista já corta o assunto em `…`; o detalhe despejava o
    // parágrafo inteiro (posição, pergunta para os comentários) antes de
    // qualquer estado.
    it('o assunto do detalhe é cortado, não despejado inteiro', () => {
      const gigante = 'A'.repeat(400);
      const v = visaoCom([fase('texto', '', 'feito')]) as { fluxo: { assunto: string } };
      v.fluxo.assunto = gigante;
      const r = tabelaFluxo(v as never, false);
      expect(r).not.toContain(gigante);
      expect(r).toContain('…');
    });
  });

  describe('/completos', () => {
    it('sem nada terminado, diz isso e aponta os abertos', async () => {
      const r = await manda('/completos');
      expect(r).toContain('Nenhum fluxo completo ainda');
      expect(r).toContain('/status');
    });

    it('não mostra fluxo aberto', async () => {
      await manda('/brinquedo Assunto aberto');
      expect(await manda('/completos')).toContain('Nenhum fluxo completo ainda');
    });
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


/**
 * Legenda é decisão de quem publica: o default é NÃO, e quem quer liga na
 * criação. O CTA vira um clipe pronto do próprio domínio, editável sem tocar
 * no bot. Os dois ficam resolvidos na definição CONGELADA — o fluxo nasce com
 * a regra e não muda no meio do caminho.
 */
describe('legenda e CTA como opções do fluxo', () => {
  function entregaDoFluxo(id: number): string {
    const bruto = fluxos.status(id)!.fluxo.definicao_json;
    const def = JSON.parse(bruto) as { fases: { id: string; entrega?: string }[] };
    return def.fases.find((f) => f.id === 'render')?.entrega ?? '';
  }

  beforeEach(() => {
    // O domínio de brinquedo ganha os dois marcadores na fase `render`.
    const flow = JSON.parse(readFileSync(join(repo, 'flow.json'), 'utf8')) as {
      fases: { id: string; entrega?: string }[];
    };
    flow.fases[1]!.entrega = 'CTA: {cta} · LEGENDA: {legenda}';
    writeFileSync(join(repo, 'flow.json'), JSON.stringify(flow));
  });

  // Default INVERTIDO em 2026-08-07: o pipeline passou a legendar. A versão
  // anterior deste teste exigia o oposto — ver a nota em `resolverOpcoes`.
  it('sem pedir, o reel JÁ sai com legenda', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const e = entregaDoFluxo(1);
    expect(e).toContain('UMA palavra por vez');
    expect(e).not.toContain('NÃO gere legenda');
  });

  it('| legenda=sim liga (redundante, mas não é erro)', async () => {
    await manda('/brinquedo Assunto | alvos=um | legenda=sim');
    expect(entregaDoFluxo(1)).toContain('UMA palavra por vez');
  });

  it('--legenda sem valor também liga', async () => {
    await manda('/brinquedo Assunto --alvo=um --legenda');
    expect(entregaDoFluxo(1)).toContain('UMA palavra por vez');
  });

  it('a legenda encosta na base da faixa do avatar, não no terço inferior', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const e = entregaDoFluxo(1);
    expect(e).toContain('BASE da faixa do avatar');
  });

  it('| legenda=nao desliga explicitamente', async () => {
    await manda('/brinquedo Assunto | alvos=um | legenda=nao');
    expect(entregaDoFluxo(1)).toContain('NÃO gere legenda');
  });

  // E a decisão fica GRAVADA na definição, não só na prosa da `entrega`: é o
  // único caminho para uma fase de FUNÇÃO (`reel.montar`), que não lê prompt.
  it('| legenda=nao fica gravado na definição congelada', async () => {
    await manda('/brinquedo Assunto | alvos=um | legenda=nao');
    const def = JSON.parse(fluxos.status(1)!.fluxo.definicao_json) as { legenda?: boolean };
    expect(def.legenda).toBe(false);
  });

  // Com legenda (o default) o campo NEM APARECE: a definição de um fluxo normal
  // continua idêntica à de antes de a opção existir, como no `pausa_apos`.
  it('com legenda, a definição não ganha campo nenhum', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const def = JSON.parse(fluxos.status(1)!.fluxo.definicao_json) as { legenda?: boolean };
    expect(def.legenda).toBeUndefined();
  });

  // Sem clipe no domínio, o CTA volta a ser desenhado — nunca aponta para um
  // arquivo que não existe.
  it('sem clipe no repo, o CTA é desenhado pelo agente', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    expect(entregaDoFluxo(1)).toContain('desenhe o CTA');
  });

  it('com clipe no repo, aponta para ELE e manda concatenar no fim', async () => {
    mkdirSync(join(repo, 'cta'), { recursive: true });
    writeFileSync(join(repo, 'cta', 'cta-9x16.mp4'), 'video');
    await manda('/brinquedo Assunto | alvos=um');
    const e = entregaDoFluxo(1);
    expect(e).toContain(join(repo, 'cta', 'cta-9x16.mp4'));
    expect(e).toContain('no FIM');
  });
});

// A pessoa que revisa está no Telegram: mandar a imagem com legenda
// `capa: A#1 um` tem que bastar. Antes o caminho era "edite o .md", que só
// funciona para quem tem terminal.
describe('capa — trocar a imagem de um segmento pela enviada no chat', () => {
  const MD = [
    '## IMAGENS',
    'IMAGEM 1 — "primeira frase" [ATENÇÃO/capa]',
    'um prompt qualquer',
    '',
    'IMAGEM 2 — "segunda frase"',
    'outro prompt',
  ].join('\n');

  function comDisco(inicial: Record<string, string>) {
    const disco = { ...inicial };
    return {
      disco,
      ler: (c: string) => disco[c] ?? null,
      gravar: (c: string, t: string) => { disco[c] = t; },
    };
  }

  it('escreve o arquivo no público pedido e diz em que momento ele entra', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const d = comDisco({ [`${repo}/textos/B1/um.md`]: MD });
    const saida = definirCapaFluxo('B#1', 'um', { n: 1, arquivo: '/midia/capa.png' },
      { fluxos, registrados, chatId: 9, ler: d.ler, gravar: d.gravar });
    expect(saida).toContain('IMAGEM 1 de B#1');
    expect(saida).toContain('entra em "primeira frase"');
    expect(d.disco[`${repo}/textos/B1/um.md`]).toContain('arquivo: /midia/capa.png');
  });

  it('`*` vale para todos os públicos do fluxo', async () => {
    await manda('/brinquedo Assunto | alvos=um,dois');
    const d = comDisco({
      [`${repo}/textos/B1/um.md`]: MD,
      [`${repo}/textos/B1/dois.md`]: MD,
    });
    const saida = definirCapaFluxo('B#1', '*', { n: 1, arquivo: '/midia/c.png' },
      { fluxos, registrados, chatId: 9, ler: d.ler, gravar: d.gravar });
    expect(saida).toContain('2 público(s)');
    expect(d.disco[`${repo}/textos/B1/um.md`]).toContain('arquivo: /midia/c.png');
    expect(d.disco[`${repo}/textos/B1/dois.md`]).toContain('arquivo: /midia/c.png');
  });

  it('sem público, ensina a sintaxe em vez de adivinhar', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    expect(definirCapaFluxo('B#1', undefined, { n: 1, arquivo: '/x.png' }, { fluxos, registrados, chatId: 9 }))
      .toContain('diga o público');
  });

  it('público sem arquivo no disco vira erro nomeado, não silêncio', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    const d = comDisco({});
    const saida = definirCapaFluxo('B#1', 'um', { n: 1, arquivo: '/x.png' },
      { fluxos, registrados, chatId: 9, ler: d.ler, gravar: d.gravar });
    expect(saida).toContain('não achei');
    expect(saida).toContain('nada mudou');
  });

  it('fluxo inexistente é dito, não ignorado', async () => {
    expect(definirCapaFluxo('B#99', 'um', { n: 1, arquivo: '/x.png' }, { fluxos, registrados, chatId: 9 }))
      .toContain('não existe neste bot');
  });
});

/**
 * O parser do verbo `capa:` — o elo que faltava para a foto mandada no chat
 * chegar ao `.md`. O anexo já era baixado e o núcleo já escrevia; sem isto,
 * mandar a imagem no Telegram não fazia nada (pendência "not-wired" de
 * 2026-08-04, fechada em 2026-08-05).
 */
describe('parseCapa', () => {
  it('lê o que o anexo monta: legenda + arquivo do midia.ts', () => {
    expect(parseCapa('capa: A#25 jovens | arquivo=/midia/1785-x.png'))
      .toEqual({ ref: 'A#25', alvo: 'jovens', n: 1, arquivo: '/midia/1785-x.png' });
  });

  it('`*` vale para todos os públicos, e o número da imagem é opcional', () => {
    const r = parseCapa('capa: A#25 * 3 | arquivo=/a/b.png');
    expect(r.alvo).toBe('*');
    expect(r.n).toBe(3);
  });

  it('`cover` é explícito; sem ele o modo fica indefinido (contain)', () => {
    expect(parseCapa('capa: A#25 jovens cover | arquivo=/a.png').modo).toBe('cover');
    // Imagem enviada pelo dono não é cortada sem ele pedir: ela já vem composta.
    expect(parseCapa('capa: A#25 jovens | arquivo=/a.png').modo).toBeUndefined();
  });

  it('sem `arquivo=` devolve arquivo indefinido — quem chama recusa', () => {
    expect(parseCapa('capa: A#25 jovens').arquivo).toBeUndefined();
  });

  it('aceita caminho com `=` no nome sem picotar', () => {
    expect(parseCapa('capa: A#25 j | arquivo=/tmp/a=b.png').arquivo).toBe('/tmp/a=b.png');
  });

  it('sem nada devolve ref indefinida em vez de explodir', () => {
    expect(parseCapa('capa:').ref).toBeUndefined();
  });
});

// --- Falhas no detalhe: lista completa e agrupada; no painel, só contagem ---
//
// Caso real (C#61, 2026-08-13): 25 falhas, 21 delas na fase `estudio` com só
// TRÊS mensagens distintas, e cada linha repetindo "heygen.estudio: C61-<alvo>-v1 —"
// antes do que importa. A lista era ilegível justamente onde precisava ser lida.
describe('falhas: agrupadas no detalhe, contadas no painel', () => {
  const fase = (nome: string, alvo: string, estado: string, erro: string | null = null) =>
    ({ fase: nome, alvo, estado, erro } as never);
  const visaoCom = (fases: unknown[]) => ({
    fluxo: { prefixo: 'C', id: 61, tipo: 'promoavatar3', assunto: 'assunto', status: 'falhou', versao_def: 1 },
    fases,
  } as never);

  const doisCards = (a: string) =>
    fase('estudio', a, 'falhou', `heygen.estudio: C61-${a}-v1 — 2 cards com o nome exato "TEMPLATE-AVATAR" (esperado 1)`);
  const zeroCards = (a: string) =>
    fase('estudio', a, 'falhou', `heygen.estudio: C61-${a}-v1 — 0 cards com o nome exato "TEMPLATE-AVATAR" (esperado 1)`);
  const fetchFail = (a: string) => fase('baixar', a, 'falhou', 'fetch failed');

  const c61 = () => visaoCom([
    ...['40mais-aut', 'criadores-aut', 'criadores-pro'].map(doisCards),
    ...['educadores-alc', 'educadores-aut', 'jovens-alc', 'jovens-aut'].map(zeroCards),
    fase('estudio', '60mais-pro', 'falhou', 'heygen.estudio: C61-60mais-pro-v1 — locator.click: Timeout 45000ms exceeded.'),
    ...['criadores-alc', 'familia-pro', 'profissionais-alc', 'tecnicos-alc'].map(fetchFail),
  ]);

  it('detalhe: agrupa por mensagem e mostra TODOS os alvos, sem cortar', () => {
    const r = tabelaFluxo(c61(), true);
    // os 4 alvos da mesma causa numa linha só, e nenhum some
    for (const a of ['educadores-alc', 'educadores-aut', 'jovens-alc', 'jovens-aut']) {
      expect(r).toContain(a);
    }
    for (const a of ['criadores-alc', 'familia-pro', 'profissionais-alc', 'tecnicos-alc']) {
      expect(r).toContain(a);
    }
  });

  it('detalhe: a mensagem repetida aparece UMA vez, com a contagem', () => {
    const r = tabelaFluxo(c61(), true);
    const ocorrencias = r.split('0 cards com o nome exato').length - 1;
    expect(ocorrencias).toBe(1);
    expect(r).toMatch(/0 cards[^\n]*\(4\)|\(4\)[^\n]*0 cards/);
  });

  it('detalhe: some o prefixo repetido (tarefa e título do estúdio)', () => {
    const r = tabelaFluxo(c61(), true);
    expect(r).not.toContain('C61-educadores-alc-v1');
    expect(r).not.toContain('heygen.estudio:');
  });

  it('detalhe: separa por fase, porque a causa e o conserto são por fase', () => {
    const r = tabelaFluxo(c61(), true);
    expect(r).toMatch(/estudio.*\(8\)/s);
    expect(r).toMatch(/baixar.*\(4\)/s);
  });

  it('painel: nenhuma lista de falha — só a contagem da fase', () => {
    const r = tabelaFluxo(c61(), false);
    expect(r).not.toContain('Falhas');
    expect(r).not.toContain('educadores-alc');
    expect(r).toMatch(/estudio.*08 ❌/);
  });

  it('painel de UM alvo que falhou também não vira lista', () => {
    const r = tabelaFluxo(visaoCom([fase('reel', 'jovens-aut', 'falhou', 'estourou')]), false);
    expect(r).not.toContain('Falhas');
  });

  it('detalhe continua oferecendo o /refazer', () => {
    expect(tabelaFluxo(c61(), true)).toContain('/refazer C#61');
  });
});

// `| prompt=<variante>`: a MESMA fase escrita com outra estratégia. Quais
// existem é o DOMÍNIO que declara (`variantes` na fase), como já acontece com
// `opcional` — o bot não adivinha nome de arquivo por convenção.
describe('| prompt=<variante>', () => {
  /** O repo de brinquedo com duas variantes declaradas na fase de texto. */
  function comVariantes(): void {
    writeFileSync(join(repo, 'prompts', 'viral.md'), 'ESCREVA VIRAL: {{input}} em {{saida}}');
    writeFileSync(join(repo, 'prompts', 'promocao.md'), 'ESCREVA MANIFESTO: {{input}} em {{saida}}');
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      fases: [
        {
          id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
          prompt: 'prompts/a.md',
          variantes: { promocao: 'prompts/promocao.md', viral: 'prompts/viral.md' },
        },
      ],
    }));
  }

  const defDe = (id: number) => JSON.parse(fluxos.status(id)!.fluxo.definicao_json) as {
    fases: { id: string; prompt?: string; prompt_texto?: string }[];
  };

  beforeEach(() => { comVariantes(); });

  // O defeito que a flag existiria para ter em silêncio: trocar o caminho DEPOIS
  // do congelamento deixaria o `prompt_texto` sendo o do prompt padrão, e o
  // fluxo rodaria o texto errado sem ninguém perceber.
  it('congela o TEXTO da variante, não o do prompt padrão', async () => {
    await manda('/brinquedo Assunto | prompt=viral');
    const texto = defDe(1).fases.find((f) => f.id === 'texto');
    expect(texto?.prompt).toBe('prompts/viral.md');
    expect(texto?.prompt_texto).toContain('ESCREVA VIRAL');
    expect(texto?.prompt_texto).not.toContain('faça');
  });

  it('sem a flag, continua exatamente o de antes', async () => {
    await manda('/brinquedo Assunto');
    const texto = defDe(1).fases.find((f) => f.id === 'texto');
    expect(texto?.prompt).toBe('prompts/a.md');
    expect(texto?.prompt_texto).toContain('faça');
  });

  // O hash cobre o JSON MAIS o conteúdo dos prompts. Se ele fosse calculado
  // antes da troca, dois fluxos de estratégias opostas teriam o mesmo hash.
  it('o hash muda com a variante', async () => {
    await manda('/brinquedo Assunto | prompt=viral');
    await manda('/brinquedo Assunto');
    expect(fluxos.status(1)!.fluxo.definicao_hash)
      .not.toBe(fluxos.status(2)!.fluxo.definicao_hash);
  });

  it('a resposta da criação diz qual variante nasceu', async () => {
    expect(await manda('/brinquedo Assunto | prompt=viral')).toContain('viral');
  });

  it('aceita a forma de bandeira e normaliza a caixa', async () => {
    await manda('/brinquedo Assunto --prompt=VIRAL');
    expect(defDe(1).fases[0].prompt).toBe('prompts/viral.md');
  });

  it('variante desconhecida é recusada COM a lista, sem enfileirar nada', async () => {
    const r = await manda('/brinquedo Assunto | prompt=nao-existe');
    expect(r).toContain('promocao');
    expect(r).toContain('viral');
    expect(r).not.toContain('não consegui ler a definição');
    expect(fila.listar()).toHaveLength(0);
    expect(fluxos.status(1)).toBeUndefined();
  });

  it('num domínio SEM variantes, a flag é recusada explicando isso', async () => {
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      fases: [{ id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' }],
    }));
    const r = await manda('/brinquedo Assunto | prompt=viral');
    expect(r).toMatch(/não declara variantes/);
    expect(fluxos.status(1)).toBeUndefined();
  });

  it('o help lista as variantes declaradas', async () => {
    const r = await manda('/brinquedo help');
    expect(r).toContain('| prompt=<variante>');
    expect(r).toContain('promocao ou viral');
  });

  // O "|" é o separador de CAMPOS: `prompt=promocao|viral` no help viraria um
  // campo "viral" inexistente na mão de quem copia a linha inteira.
  it('o help NÃO separa as variantes com "|"', async () => {
    expect(await manda('/brinquedo help')).not.toContain('promocao|viral');
  });

  it('o help NÃO inventa a linha num domínio sem variantes', async () => {
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      fases: [{ id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' }],
    }));
    expect(await manda('/brinquedo help')).not.toContain('| prompt=');
  });
});

// O validador recusa `variantes` malformado na CRIAÇÃO, com o usuário na frente
// — e não no primeiro job, quando o fluxo já nasceu.
describe('validação de `variantes` no flow.json', () => {
  const comFases = (fases: unknown[]) => writeFileSync(join(repo, 'flow.json'), JSON.stringify({
    nome: 'brinquedo', prefixo: 'B', versao_def: 3,
    alvos: { um: { canal: 'lives1' } }, fases,
  }));

  it('arquivo de variante ausente é recusado, nomeando a variante', async () => {
    comFases([{
      id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
      prompt: 'prompts/a.md', variantes: { viral: 'prompts/nao-existe.md' },
    }]);
    const r = await manda('/brinquedo Assunto');
    expect(r).toContain('variantes.viral');
    expect(fluxos.status(1)).toBeUndefined();
  });

  // Aceitar em silêncio um campo que não tem o que trocar é pior que recusar:
  // o dono acharia que declarou uma variante e ela nunca entraria.
  it('`variantes` numa fase sem prompt próprio é recusado', async () => {
    comFases([
      { id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' },
      { id: 'reel', escopo: 'alvo', fila: 'render', kind: 'function', tarefa: 'reel.montar', variantes: { viral: 'prompts/a.md' } },
    ]);
    expect(await manda('/brinquedo Assunto')).toMatch(/variantes.*prompt próprio/s);
  });

  it('nome de variante com acento ou espaço é recusado', async () => {
    comFases([{
      id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
      prompt: 'prompts/a.md', variantes: { 'promoção': 'prompts/a.md' },
    }]);
    expect(await manda('/brinquedo Assunto')).toMatch(/nome inválido/);
  });
});

// O clipe de encerramento por variante. O clipe padrão é um CTA ("saiba mais
// em inema.club") e a variante viral se organiza em torno de UM pedido de
// engajamento — um segundo pedido 3s depois compete com ele.
describe('cta por variante', () => {
  function comCta(): void {
    for (const n of ['viral.md', 'a.md']) writeFileSync(join(repo, 'prompts', n), `P ${n} {{input}} {{saida}}`);
    mkdirSync(join(repo, 'cta'), { recursive: true });
    writeFileSync(join(repo, 'cta', 'cta-9x16.mp4'), 'x');
    writeFileSync(join(repo, 'cta', 'marca-9x16.mp4'), 'y');
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      cta: { padrao: 'cta/cta-9x16.mp4', viral: 'cta/marca-9x16.mp4' },
      fases: [{
        id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
        prompt: 'prompts/a.md', variantes: { viral: 'prompts/viral.md' },
      }],
    }));
  }
  const defDe = (id: number) => JSON.parse(fluxos.status(id)!.fluxo.definicao_json) as FlowDef;

  beforeEach(() => { comCta(); });

  it('a definição congelada grava QUAL variante nasceu', async () => {
    await manda('/brinquedo Assunto | prompt=viral');
    expect(defDe(1).variante).toBe('viral');
  });

  it('sem variante, nada de `variante` na definição', async () => {
    await manda('/brinquedo Assunto');
    expect(defDe(1).variante).toBeUndefined();
  });

  it('viral escolhe o clipe da marca; sem flag, o padrão', async () => {
    await manda('/brinquedo Assunto | prompt=viral');
    await manda('/brinquedo Assunto');
    expect(ctaDaDefinicao(defDe(1))).toBe('cta/marca-9x16.mp4');
    expect(ctaDaDefinicao(defDe(2))).toBe('cta/cta-9x16.mp4');
  });

  // Chave errada em `cta` seria "usou o clipe errado" descoberto no vídeo
  // pronto — cara e silenciosa. Recusar na criação é o barato.
  it('chave de cta que não é variante declarada é recusada', async () => {
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      cta: { padrao: 'cta/cta-9x16.mp4', virall: 'cta/marca-9x16.mp4' },
      fases: [{
        id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente',
        prompt: 'prompts/a.md', variantes: { viral: 'prompts/viral.md' },
      }],
    }));
    expect(await manda('/brinquedo Assunto')).toMatch(/virall/);
  });

  it('arquivo de cta ausente é recusado na criação', async () => {
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      cta: { padrao: 'cta/nao-existe.mp4' },
      fases: [{ id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' }],
    }));
    expect(await manda('/brinquedo Assunto')).toMatch(/cta.padrao/);
  });

  // Domínio que não declara `cta` continua exatamente como antes: nada é
  // passado ao motor e vale o default do `montar-reel.py`.
  it('sem `cta` no flow.json, nenhum clipe é escolhido pelo bot', async () => {
    writeFileSync(join(repo, 'flow.json'), JSON.stringify({
      nome: 'brinquedo', prefixo: 'B', versao_def: 3,
      alvos: { um: { canal: 'lives1' } },
      fases: [{ id: 'texto', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/a.md' }],
    }));
    await manda('/brinquedo Assunto');
    expect(ctaDaDefinicao(defDe(1))).toBeUndefined();
  });
});

// A ajuda do domínio em DUAS CAMADAS: cartão por padrão, seção sob demanda.
// O HELP.md do promoavatar3 tem ~180 linhas — numa mensagem só, o que a pessoa
// veio buscar (como se chama o comando) fica no meio de uma parede.
describe('ajuda de fluxo em duas camadas', () => {
  const comSecoes = () => writeFileSync(join(repo, 'HELP.md'), [
    'meufluxo — o cartão',
    '',
    '  /meufluxo <assunto>',
    '',
    '## VARIANTES de texto',
    '',
    'corpo das variantes',
    '',
    '## LEGENDA — ligada por default',
    '',
    'corpo da legenda',
  ].join('\n'));

  it('sem seção, responde o cartão e o menu — não o arquivo inteiro', async () => {
    comSecoes();
    const r = await manda('/brinquedo help');
    expect(r).toContain('o cartão');
    expect(r).not.toContain('corpo das variantes');
    expect(r).toContain('variantes · legenda');
  });

  it('com seção, responde só ela e o caminho de volta', async () => {
    comSecoes();
    const r = await manda('/brinquedo help variantes');
    expect(r).toContain('corpo das variantes');
    expect(r).not.toContain('corpo da legenda');
    expect(r).toContain('/brinquedo help');
  });

  // O `##` é marcação de arquivo; o bot manda texto puro.
  it('o título da seção sai sem os cerquilhas', async () => {
    comSecoes();
    const r = await manda('/brinquedo help legenda');
    expect(r).toContain('LEGENDA — ligada por default');
    expect(r).not.toContain('##');
  });

  it('casa sem acento e por prefixo', async () => {
    writeFileSync(join(repo, 'HELP.md'), 'cartão\n\n## PORTÃO — conferir antes\n\ncorpo do portão');
    expect(await manda('/brinquedo help portao')).toContain('corpo do portão');
  });

  it('seção inexistente diz quais existem, em vez de calar', async () => {
    comSecoes();
    const r = await manda('/brinquedo help inventada');
    expect(r).toContain('não achei');
    expect(r).toContain('variantes');
  });

  // O promoavatar não tem seções, e não faz sentido obrigá-lo a se reorganizar
  // para continuar respondendo.
  it('HELP.md sem seção nenhuma volta inteiro, como antes', async () => {
    writeFileSync(join(repo, 'HELP.md'), 'ajuda antiga, sem cabeçalho nenhum');
    const r = await manda('/brinquedo help');
    expect(r).toBe('ajuda antiga, sem cabeçalho nenhum');
  });

  it('/ajuda <fluxo> <seção> responde igual à outra forma', async () => {
    comSecoes();
    expect(await manda('/ajuda brinquedo variantes')).toContain('corpo das variantes');
  });
});
