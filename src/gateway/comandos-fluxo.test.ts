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
import { tabelaFluxo } from './comandos-fluxo.js';
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
    const fase = (nome: string, alvo: string, estado: string) =>
      ({ fase: nome, alvo, estado, erro: null } as never);
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
      expect(r).toMatch(/1 .*(pendente|fila)/);
    });

    it('o que FALHOU é nomeado, mesmo no meio de 30', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'jovens-aut', 'falhou')]), false);
      expect(r).toContain('jovens-aut');
    });

    it('o que espera VOCÊ é nomeado', () => {
      const r = tabelaFluxo(visaoCom([...trinta('feito'), fase('reel', 'mulheres-pro', 'aguardando-ok')]), false);
      expect(r).toContain('mulheres-pro');
    });

    // Poucos alvos continuam nomeados: contar "2/2" esconderia QUAIS, e nesse
    // tamanho a lista cabe na tela sem virar parede.
    it('com poucos alvos, continua listando nome por nome', () => {
      const r = tabelaFluxo(visaoCom([fase('render', 'um', 'feito'), fase('render', 'dois', 'feito')]), false);
      expect(r).toContain('um');
      expect(r).toContain('dois');
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

  it('sem pedir, o reel sai SEM legenda', async () => {
    await manda('/brinquedo Assunto | alvos=um');
    expect(entregaDoFluxo(1)).toContain('NÃO gere legenda');
  });

  it('| legenda=sim liga, e manda a caixa encostar embaixo', async () => {
    await manda('/brinquedo Assunto | alvos=um | legenda=sim');
    const e = entregaDoFluxo(1);
    expect(e).toContain('palavra-a-palavra');
    expect(e).toContain('borda INFERIOR');
  });

  it('--legenda sem valor também liga', async () => {
    await manda('/brinquedo Assunto --alvo=um --legenda');
    expect(entregaDoFluxo(1)).toContain('palavra-a-palavra');
  });

  it('| legenda=nao desliga explicitamente', async () => {
    await manda('/brinquedo Assunto | alvos=um | legenda=nao');
    expect(entregaDoFluxo(1)).toContain('NÃO gere legenda');
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
