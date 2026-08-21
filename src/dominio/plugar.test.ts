import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chavesFaltando, inserirEntradaFluxo, inserirEntradaSkill, invocacaoResolvida, planoMaterializacao,
} from './plugar.js';

function repoComPrompts(...nomes: string[]): string {
  const raiz = mkdtempSync(join(tmpdir(), 'plugar-'));
  mkdirSync(join(raiz, 'prompts'), { recursive: true });
  for (const n of nomes) writeFileSync(join(raiz, 'prompts', n), 'prompt {{input}} {{saida}}');
  return raiz;
}

const ENTRADA = {
  command: 'analisevideo',
  fila: 'texto',
  kind: 'agent',
  prompt: 'prompts/analisevideo.md',
  artefato_exts: ['md'],
  max_tentativas: 2,
  timeout_segundos: 3600,
  aceita_destino: false,
  descricao: 'análise visual',
  exemplo: 'analisevideo: https://x/y',
};

const EXISTENTE = JSON.stringify([{
  command: 'transcrever',
  fila: 'texto',
  kind: 'agent',
  prompt: 'prompts/transcrever.md',
  artefato_exts: ['txt'],
  max_tentativas: 2,
  timeout_segundos: 3600,
  aceita_destino: false,
  descricao: 'transcreve',
  exemplo: 'transcrever: url',
}], null, 2);

describe('inserirEntradaSkill', () => {
  it('acrescenta preservando o que já existia', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    const { texto, acao } = inserirEntradaSkill(EXISTENTE, ENTRADA, raiz);
    const lista = JSON.parse(texto);
    expect(acao).toBe('inserida');
    expect(lista.map((s: { command: string }) => s.command)).toEqual(['transcrever', 'analisevideo']);
  });

  // Re-plugar é caso normal (o manifesto mudou). O que não pode é ser silencioso
  // — daí `acao`, que o script mostra antes de gravar.
  it('substitui a entrada de mesmo command, e anuncia', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    const uma = inserirEntradaSkill(EXISTENTE, ENTRADA, raiz).texto;
    const { texto, acao } = inserirEntradaSkill(uma, { ...ENTRADA, timeout_segundos: 900 }, raiz);
    const lista = JSON.parse(texto);
    expect(acao).toBe('substituida');
    expect(lista).toHaveLength(2);
    expect(lista[1].timeout_segundos).toBe(900);
  });

  // A defesa central: o que sai daqui é gravado, e config inválida não falha no
  // plugar — falha no BOOT.
  it('recusa quando a entrada não passa no validador do boot (prompt ausente)', () => {
    const raiz = repoComPrompts('transcrever.md');   // sem analisevideo.md
    expect(() => inserirEntradaSkill(EXISTENTE, ENTRADA, raiz))
      .toThrow(/prompt.*ausente|arquivo ausente/i);
  });

  it('recusa fila inexistente antes de gravar', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    expect(() => inserirEntradaSkill(EXISTENTE, { ...ENTRADA, fila: 'inventada' }, raiz))
      .toThrow(/fila/);
  });

  it('recusa JSON quebrado em vez de sobrescrever o arquivo', () => {
    const raiz = repoComPrompts('analisevideo.md');
    expect(() => inserirEntradaSkill('[{ isto não é json', ENTRADA, raiz))
      .toThrow(/não é JSON válido/);
  });

  it('termina com quebra de linha (diff limpo no git)', () => {
    const raiz = repoComPrompts('transcrever.md', 'analisevideo.md');
    expect(inserirEntradaSkill(EXISTENTE, ENTRADA, raiz).texto.endsWith('\n')).toBe(true);
  });
});

describe('chavesFaltando', () => {
  it('chave presente e preenchida não falta', () => {
    expect(chavesFaltando('GOOGLE_API_KEY=abc\n', ['GOOGLE_API_KEY'])).toEqual([]);
  });

  // O caso que motiva a função: `CHAVE=` passa em qualquer teste de existência e
  // só falha no primeiro job, com erro do provedor que não menciona o cofre.
  it('chave declarada e VAZIA conta como faltando', () => {
    expect(chavesFaltando('GOOGLE_API_KEY=\n', ['GOOGLE_API_KEY'])).toEqual(['GOOGLE_API_KEY']);
  });

  it('ignora comentário e linha solta', () => {
    const cofre = '# GOOGLE_API_KEY=nao-vale\nlixo\nGROQ_API_KEY=x\n';
    expect(chavesFaltando(cofre, ['GOOGLE_API_KEY', 'GROQ_API_KEY'])).toEqual(['GOOGLE_API_KEY']);
  });

  it('aceita valor entre aspas', () => {
    expect(chavesFaltando('GOOGLE_API_KEY="abc"\n', ['GOOGLE_API_KEY'])).toEqual([]);
  });

  it('cofre vazio faz todas faltarem', () => {
    expect(chavesFaltando('', ['A_KEY', 'B_KEY'])).toEqual(['A_KEY', 'B_KEY']);
  });
});

describe('invocacaoResolvida', () => {
  it('resolve {{repo}} e PRESERVA {{input}}', () => {
    const linha = invocacaoResolvida('bash {{repo}}/a.sh analisa "{{input}}"', '/root/projetos/analisevideo');
    expect(linha).toBe('bash /root/projetos/analisevideo/a.sh analisa "{{input}}"');
  });

  it('resolve todas as ocorrências de {{repo}}', () => {
    expect(invocacaoResolvida('cd {{repo}} && bash {{repo}}/a.sh "{{input}}"', '/r'))
      .toBe('cd /r && bash /r/a.sh "{{input}}"');
  });
});

// ── rota de fluxo ────────────────────────────────────────────────────────────

describe('planoMaterializacao', () => {
  const DEF = {
    flow: { nome: 'x', fases: [{ id: 'a' }] },
    prompts: { 'prompts/fase-a.md': 'texto do prompt' },
    help: '# ajuda',
  };
  const vazio = (): undefined => undefined;

  it('repo sem nada: escreve os três', () => {
    const p = planoMaterializacao(DEF, vazio);
    expect(p.escrever.map((a) => a.caminho)).toEqual(['flow.json', 'prompts/fase-a.md', 'HELP.md']);
    expect(p.conflitos).toEqual([]);
  });

  it('sem help no manifesto, não planeja HELP.md (a ajuda derivada não é pior)', () => {
    const { help: _, ...sem } = DEF;
    expect(planoMaterializacao(sem, vazio).escrever.map((a) => a.caminho))
      .toEqual(['flow.json', 'prompts/fase-a.md']);
  });

  // Re-plugar na mesma máquina tem que ser operação que não faz nada. O `\n`
  // final que todo editor põe não pode virar divergência.
  it('conteúdo idêntico (mesmo com \\n a mais) é "igual", não conflito', () => {
    const atual = (c: string): string | undefined => {
      if (c === 'flow.json') return `${JSON.stringify(DEF.flow, null, 2)}\n\n`;
      if (c === 'prompts/fase-a.md') return 'texto do prompt\n';
      if (c === 'HELP.md') return '# ajuda';
      return undefined;
    };
    const p = planoMaterializacao(DEF, atual);
    expect(p.iguais).toEqual(['flow.json', 'prompts/fase-a.md', 'HELP.md']);
    expect(p.escrever).toEqual([]);
    expect(p.conflitos).toEqual([]);
  });

  // O REPO é o dono da definição — e, quando ele já é DOMÍNIO (tem flow.json
  // próprio), é também a FONTE: divergência não é conflito para resolver na
  // mão, é importação. Quem se atualiza é o manifesto.
  //
  // O manifesto do musicavideo foi escrito por um modelo, chutando como o
  // domínio funciona: inventou um binário que não existe e um contrato de saída
  // errado, e os dois só falharam em produção (MVD#87/#88, 2026-08-21).
  it('em repo que já é domínio, o divergente é IMPORTADO — o domínio vence', () => {
    const atual = (c: string): string | undefined => {
      if (c === 'flow.json') return '{"nome":"do proprio dominio"}';
      if (c === 'prompts/fase-a.md') return 'o prompt QUE O DOMÍNIO versiona';
      return undefined;
    };
    const p = planoMaterializacao(DEF, atual);
    expect(p.conflitos).toEqual([]);
    expect(p.importar.map((a) => a.caminho)).toEqual(['flow.json', 'prompts/fase-a.md']);
    // E o conteúdo que viaja é o DO REPO, não o do manifesto.
    expect(p.importar[0]!.conteudo).toContain('do proprio dominio');
    expect(p.importar[1]!.conteudo).toBe('o prompt QUE O DOMÍNIO versiona');
    // O que o domínio ainda não tem continua sendo escrito.
    expect(p.escrever.map((a) => a.caminho)).toEqual(['HELP.md']);
  });

  // Sem `flow.json` próprio o repo ainda não é domínio: não há fonte de onde
  // importar, e sobrescrever arquivo alheio continua fora de questão.
  it('repo que NÃO é domínio: divergente segue sendo CONFLITO', () => {
    const atual = (c: string): string | undefined => (
      c === 'prompts/fase-a.md' ? 'um prompt de outra coisa' : undefined);
    const p = planoMaterializacao(DEF, atual);
    expect(p.conflitos).toEqual(['prompts/fase-a.md']);
    expect(p.importar).toEqual([]);
    expect(p.escrever.map((a) => a.caminho)).toEqual(['flow.json', 'HELP.md']);
  });
});

describe('inserirEntradaFluxo', () => {
  const criarRepo = (): string => {
    const raiz = mkdtempSync(join(tmpdir(), 'fluxos-'));
    mkdirSync(join(raiz, 'musicaclone'), { recursive: true });
    writeFileSync(join(raiz, 'musicaclone', 'flow.json'), '{}');
    return raiz;
  };
  const ENTRADA = { command: 'musicaclone', repo: 'musicaclone', descricao: 'd', exemplo: '/musicaclone x' };

  it('insere e valida com o validador do BOOT', () => {
    const { texto, acao } = inserirEntradaFluxo('[]', ENTRADA, criarRepo());
    expect(acao).toBe('inserida');
    expect(JSON.parse(texto)).toEqual([ENTRADA]);
  });

  it('substituir é anunciado, não silencioso (re-plugar)', () => {
    const raiz = criarRepo();
    const antes = JSON.stringify([{ ...ENTRADA, descricao: 'velha' }]);
    const { texto, acao } = inserirEntradaFluxo(antes, ENTRADA, raiz);
    expect(acao).toBe('substituida');
    expect(JSON.parse(texto)).toHaveLength(1);
    expect(JSON.parse(texto)[0].descricao).toBe('d');
  });

  // Entrada apontando para repo sem flow.json DERRUBA O BOOT. Falhar aqui é o
  // ponto: a instalação para, o serviço continua subindo.
  it('recusa entrada cujo repo não tem flow.json', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'fluxos-'));
    mkdirSync(join(raiz, 'musicaclone'), { recursive: true });
    expect(() => inserirEntradaFluxo('[]', ENTRADA, raiz)).toThrow(/flow\.json/);
  });
});
