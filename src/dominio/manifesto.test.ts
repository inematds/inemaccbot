// O manifesto é o contrato entre o gerador (com modelo, uma vez) e o
// `plugar-repo` (determinístico, na VPS). Estes testes fixam o que o validador
// tem que RECUSAR: cada recusa aqui é um boot que não cai lá.
import { describe, expect, it } from 'vitest';

import {
  camposChutados, paraEntradaSkill, validarManifesto,
  type Manifesto, type ManifestoSkill,
} from './manifesto.js';
import { validarSkills } from './registry.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = {
  manifesto: 1,
  rota: 'skill',
  command: 'analisevideo',
  repo: { url: 'https://github.com/inematds/analisevideo', commit: 'abc1234' },
  invocacao: 'bash {{repo}}/analisevideo.sh analisa "{{input}}" {{slug}}',
  fila: 'texto',
  artefato_exts: ['md'],
  timeout_segundos: 3600,
  max_tentativas: 2,
  aceita_destino: false,
  requer: { bin: ['yt-dlp', 'jq'], chaves: ['GOOGLE_API_KEY'], fontes: [] },
  prompt: 'prompts/analisevideo.md',
  descricao: 'análise visual do vídeo do link (câmera, luz, montagem)',
  exemplo: 'analisevideo: https://youtube.com/watch?v=XXXX',
  gerado: { em: '2026-08-20', por: 'claude', confianca: { fila: 'chute', timeout_segundos: 'chute' } },
};

/** Estreita a união para o ramo de skill. O teste sabe qual rota está exercendo;
 *  o `throw` existe para o dia em que alguém trocar a BASE sem perceber. */
function comoSkill(m: Manifesto): ManifestoSkill {
  if (m.rota !== 'skill') throw new Error(`esperava rota skill, veio ${m.rota}`);
  return m;
}

describe('esquema (a versão é do MANIFESTO, não do bot)', () => {
  it('aceita o esquema 1 e devolve o manifesto normalizado', () => {
    const m = comoSkill(validarManifesto(BASE));
    expect(m.command).toBe('analisevideo');
    expect(m.artefato_exts).toEqual(['md']);
  });

  // Recusar dizendo o que fazer: "esquema desconhecido" sem instrução vira
  // chamado de suporte.
  it('recusa esquema desconhecido dizendo para atualizar o bot', () => {
    expect(() => validarManifesto({ ...BASE, manifesto: 2 }))
      .toThrow(/esquema 2 desconhecido.*Atualize o inemaccbot/s);
  });

  it('recusa manifesto sem o campo de versão', () => {
    const { manifesto: _, ...sem } = BASE;
    expect(() => validarManifesto(sem)).toThrow(/versão do ESQUEMA/);
  });

  it('recusa rota que não é skill nem fluxo, dizendo a diferença entre as duas', () => {
    expect(() => validarManifesto({ ...BASE, rota: 'coisa' })).toThrow(/skill.*fluxo|fluxo.*skill/s);
  });
});

// A rota de fluxo carrega a DEFINIÇÃO porque um fluxo não cabe do lado do bot:
// `carregarFlow` lê `<repo>/flow.json` do disco. O manifesto é o que permite
// plugar um repo que ainda NÃO é domínio.
describe('rota fluxo', () => {
  const FLUXO = {
    manifesto: 1,
    rota: 'fluxo',
    command: 'musicaclone',
    repo: { url: 'https://github.com/inematds/musicaclone', commit: 'abc1234', pasta: 'musicaclone' },
    descricao: 'faixa, capa e clipes a partir de um tema',
    exemplo: '/musicaclone saudade de domingo',
    definicao: {
      flow: {
        nome: 'musicaclone',
        prefixo: 'M',
        alvos: { unico: { canal: 'lives3', gatilho: 'x' } },
        fases: [
          { id: 'letra', escopo: 'fluxo', fila: 'texto', kind: 'agent', tarefa: 'fluxo-agente', prompt: 'prompts/fase-letra.md' },
          { id: 'clipe', escopo: 'alvo', fila: 'render', kind: 'function', tarefa: 'reel.montar' },
        ],
      },
      prompts: { 'prompts/fase-letra.md': 'escreva a letra de {{input}}' },
      help: '# musicaclone\n\nEscreve a letra, gera a faixa e monta os clipes. Ref: M#N.\n',
    },
  };

  it('aceita o pacote completo e normaliza', () => {
    const m = validarManifesto(FLUXO);
    expect(m.rota).toBe('fluxo');
    expect(m.command).toBe('musicaclone');
    if (m.rota !== 'fluxo') throw new Error('rota errada');
    expect(Object.keys(m.definicao?.prompts ?? {})).toEqual(['prompts/fase-letra.md']);
    expect(m.definicao?.help).toContain('Ref: M#N');
  });

  // Sem `definicao` o manifesto é só REGISTRO — é o caso do repo que já é
  // domínio (promoavatar), onde materializar seria sobrescrever o dono.
  it('aceita manifesto sem definicao: o repo já traz o flow.json', () => {
    const { definicao: _, ...sem } = FLUXO;
    const m = validarManifesto(sem);
    if (m.rota !== 'fluxo') throw new Error('rota errada');
    expect(m.definicao).toBeUndefined();
  });

  // ESTA é a checagem que justifica validar `flow` aqui: `carregarFlow` só
  // acusaria isso DEPOIS de escrever no repo alheio, que é o que não dá para
  // desfazer com elegância.
  it('recusa fase kind=agent cujo prompt não vem no pacote, nomeando a fase', () => {
    const quebrado = {
      ...FLUXO,
      definicao: { ...FLUXO.definicao, prompts: {} },
    };
    expect(() => validarManifesto(quebrado)).toThrow(/fase "letra".*prompts\/fase-letra\.md/s);
  });

  it('recusa fluxo sem fase', () => {
    expect(() => validarManifesto({
      ...FLUXO,
      definicao: { ...FLUXO.definicao, flow: { ...FLUXO.definicao.flow, fases: [] } },
    })).toThrow(/fases.*não faz nada/s);
  });

  // O caminho do prompt vira ARQUIVO NO REPO ALHEIO. Um manifesto de terceiro
  // com ".." escreveria fora dele.
  it('recusa caminho de prompt absoluto ou com ".."', () => {
    for (const mau of ['/etc/x.md', '../fora.md']) {
      expect(() => validarManifesto({
        ...FLUXO,
        definicao: { ...FLUXO.definicao, prompts: { [mau]: 'x' } },
      })).toThrow(/relativo ao repo|não vem no manifesto/);
    }
  });

  // HELP.md presente SUBSTITUI a ajuda derivada do flow.json, que lista fases,
  // escopo e portões. Um esqueleto troca a boa pela ruim — e a regra
  // "todo domínio do catálogo é documentado" reprova a suíte inteira.
  it('recusa HELP.md curto, que é pior que nenhum', () => {
    expect(() => validarManifesto({
      ...FLUXO,
      definicao: { ...FLUXO.definicao, help: '# musicaclone' },
    })).toThrow(/SUBSTITUI a ajuda|Escreva um de verdade ou omita/);
  });

  it('aceita omitir o help: a ajuda derivada do flow.json não mente', () => {
    const { help: _, ...semHelp } = FLUXO.definicao;
    const m = validarManifesto({ ...FLUXO, definicao: semHelp });
    if (m.rota !== 'fluxo') throw new Error('rota errada');
    expect(m.definicao?.help).toBeUndefined();
  });

  it('recusa fase sem id válido', () => {
    expect(() => validarManifesto({
      ...FLUXO,
      definicao: {
        ...FLUXO.definicao,
        flow: { ...FLUXO.definicao.flow, fases: [{ id: 'Fase Um', kind: 'function', tarefa: 'x' }] },
      },
    })).toThrow(/fases\[0\]\.id/);
  });

  // Segredo NUNCA entra no manifesto: ele é versionado e o `origin` é público.
  // A regra vale nas DUAS rotas — é o que a extração de `validarRequer` garante.
  // (Quem barra `CHAVE=valor` é o formato do NOME, antes da guarda do `=`.)
  it('recusa valor de chave também na rota fluxo', () => {
    expect(() => validarManifesto({
      ...FLUXO,
      requer: { chaves: ['SUNO_KEY=abc123'] },
    })).toThrow(/requer\.chaves\[0\]/);
  });
});

describe('repo.url', () => {
  // Manifesto que viaja DENTRO do repo não precisa da URL: quem o lê já tem o
  // clone. Exigi-la obrigaria um repo ainda sem `remote` a inventar uma.
  it('é opcional', () => {
    const m = validarManifesto({ ...BASE, repo: { commit: 'abc1234' } });
    expect(m.repo.url).toBeUndefined();
  });

  // O comando do chat não precisa ter o nome do repositório: sem `pasta`, o
  // plugar procuraria o clone por "roda" quando ele está em "repoprep".
  it('repo.pasta guarda o nome do clone quando difere do command', () => {
    const m = validarManifesto({ ...BASE, repo: { pasta: 'repoprep' } });
    expect(m.repo.pasta).toBe('repoprep');
  });

  it('repo.pasta é nome, não caminho', () => {
    expect(() => validarManifesto({ ...BASE, repo: { pasta: '/opt/x' } }))
      .toThrow(/nome de pasta/);
  });

  it('mas quando presente tem que ser https:// ou git@', () => {
    expect(() => validarManifesto({ ...BASE, repo: { url: 'ftp://x/y' } }))
      .toThrow(/https:\/\/ ou git@/);
  });
});

describe('invocação (é ela que vira comando na máquina)', () => {
  // O defeito real do SKILL.md do analisevideo: caminho absoluto da máquina de
  // quem escreveu, que não existe na VPS.
  it('exige {{repo}} em vez de caminho fixo', () => {
    expect(() => validarManifesto({ ...BASE, invocacao: 'bash /root/x/a.sh "{{input}}"' }))
      .toThrow(/\{\{repo\}\}/);
  });

  it('exige {{input}} — sem ele o comando ignora o pedido', () => {
    expect(() => validarManifesto({ ...BASE, invocacao: 'bash {{repo}}/a.sh list' }))
      .toThrow(/\{\{input\}\}/);
  });

  it('recusa caminho absoluto solto mesmo com {{repo}} presente', () => {
    expect(() => validarManifesto({ ...BASE, invocacao: 'bash {{repo}}/a.sh "{{input}}" /etc/passwd' }))
      .toThrow(/caminho absoluto/);
  });
});

describe('requer (é o que o plugar confere ANTES do primeiro job)', () => {
  // O manifesto é versionado e o `origin` é público: chave é NOME, nunca valor.
  it('recusa valor de chave em vez do nome', () => {
    expect(() => validarManifesto({ ...BASE, requer: { chaves: ['GOOGLE_API_KEY=abc123'] } }))
      .toThrow(/NOME da variável/);
  });

  it('recusa nome de chave minúsculo (não é variável de ambiente)', () => {
    expect(() => validarManifesto({ ...BASE, requer: { chaves: ['google_api_key'] } }))
      .toThrow(/NOME da variável/);
  });

  it('requer ausente vira listas vazias, não erro', () => {
    const { requer: _, ...sem } = BASE;
    expect(validarManifesto(sem).requer).toEqual({ bin: [], chaves: [], fontes: [] });
  });
});

describe('proveniência e confiança', () => {
  it('lista os campos chutados, em ordem — é o que a revisão destaca', () => {
    expect(camposChutados(validarManifesto(BASE))).toEqual(['fila', 'timeout_segundos']);
  });

  it('recusa marca de confiança em campo que não existe (manifesto editado pela metade)', () => {
    const m = { ...BASE, gerado: { confianca: { inventado: 'chute' } } };
    expect(() => validarManifesto(m)).toThrow(/inventado.*não existe/);
  });

  // O gerador marca `requer.bin` com frequência — a confiança costuma diferir
  // entre os sub-campos, e obrigar a marcar o bloco inteiro perderia isso.
  it('aceita caminho pontuado quando o campo do topo existe', () => {
    const m = { ...BASE, gerado: { confianca: { 'requer.bin': 'lido', 'requer.chaves': 'chute' } } };
    expect(camposChutados(validarManifesto(m))).toEqual(['requer.chaves']);
  });

  it('recusa caminho pontuado cujo topo não existe', () => {
    const m = { ...BASE, gerado: { confianca: { 'inventado.x': 'chute' } } };
    expect(() => validarManifesto(m)).toThrow(/não existe/);
  });

  it('recusa marca fora de lido|chute', () => {
    const m = { ...BASE, gerado: { confianca: { fila: 'talvez' } } };
    expect(() => validarManifesto(m)).toThrow(/lido ou chute/);
  });

  it('commit tem que ser hash git — é a proveniência que permite avisar "o repo mudou"', () => {
    expect(() => validarManifesto({ ...BASE, repo: { url: BASE.repo.url, commit: 'HEAD' } }))
      .toThrow(/hash git/);
  });
});

describe('ajuda (o que o usuário lê no chat)', () => {
  it('descricao e exemplo são obrigatórios — default genérico é pior que nada', () => {
    const { descricao: _d, ...semDescricao } = BASE;
    expect(() => validarManifesto(semDescricao)).toThrow(/descricao/);
    const { exemplo: _e, ...semExemplo } = BASE;
    expect(() => validarManifesto(semExemplo)).toThrow(/exemplo/);
  });
});

describe('campos declarados', () => {
  it('aceita bandeira com padrão sim/não', () => {
    const m = comoSkill(validarManifesto({ ...BASE, campos: { vertical: { tipo: 'bandeira', padrao: 'não' } } }));
    expect(m.campos.vertical).toEqual({ tipo: 'bandeira', padrao: 'não', usa: 'prompt' });
  });

  it('recusa bandeira com padrão que não é sim/não', () => {
    expect(() => validarManifesto({ ...BASE, campos: { v: { tipo: 'bandeira', padrao: 'talvez' } } }))
      .toThrow(/sim.*não/);
  });

  it('recusa padrão com espaço (o valor vira nome de arquivo)', () => {
    expect(() => validarManifesto({ ...BASE, campos: { v: { tipo: 'texto', padrao: 'a b' } } }))
      .toThrow(/sem espaço/);
  });
});

// A prova de que o contrato fecha: a entrada gerada tem que passar no validador
// REAL do registry — o mesmo que roda no boot. Sem este teste, o manifesto
// poderia estar "válido" e ainda assim derrubar o serviço.
describe('paraEntradaSkill → validarSkills (o validador do boot)', () => {
  it('a entrada produzida é aceita pelo registry de skills', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'manifesto-'));
    mkdirSync(join(raiz, 'prompts'), { recursive: true });
    writeFileSync(join(raiz, 'prompts/analisevideo.md'), 'prompt com {{input}} e {{saida}}');

    const m = comoSkill(validarManifesto(BASE));
    const entrada = paraEntradaSkill(m);
    const defs = validarSkills([entrada], raiz);

    expect(defs).toHaveLength(1);
    expect(defs[0].command).toBe('analisevideo');
    expect(defs[0].artefato_exts).toEqual(['md']);
    expect(defs[0].timeout_segundos).toBe(3600);
  });
});
