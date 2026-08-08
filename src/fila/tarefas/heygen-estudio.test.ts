import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { criarHeygenEstudio } from './heygen-estudio.js';
import type { ClienteHeygen } from './heygen.js';
import { AindaNao, type ContextoTarefa } from '../types.js';

function ctx(input: string, over: Partial<ContextoTarefa> = {}): ContextoTarefa {
  return {
    job: { input, criado_em: 0 } as never,
    fila: {} as never,
    agora: () => 1_000,
    log: () => {},
    sinal: new AbortController().signal,
    aindaNao: (m: string) => { throw new AindaNao(m); },
    ...over,
  } as ContextoTarefa;
}

function cliente(over: Partial<ClienteHeygen> = {}): ClienteHeygen {
  return {
    porTitulo: async () => new Map(),
    urlDe: async () => null,
    baixar: async () => {},
    gerar: async () => { throw new Error('a rota do estúdio não usa a API de geração'); },
    saldo: async () => null,
    ...over,
  };
}

const opts = (rodar: NonNullable<Parameters<typeof criarHeygenEstudio>[1]['rodar']>) => ({
  perfil: '/perfil', script: '/repo/scripts/heygen-estudio.mjs', rodar,
});
const entrada = JSON.stringify({ titulo: 'A32-jovens-v1', texto: 'Olá. É a fala com acento.' });

describe('heygen.estudio: o estúdio por script', () => {
  it('chama o script com título, perfil e a fala EM ARQUIVO', async () => {
    let args: string[] = [];
    const tarefa = criarHeygenEstudio(cliente(), opts(async (a) => {
      args = a;
      return { codigo: 0, saida: 'RESULT: A32-jovens-v1' };
    }));
    await expect(tarefa(ctx(entrada))).resolves.toBe('A32-jovens-v1');
    expect(args[0]).toMatch(/heygen-estudio\.mjs$/);
    expect(args).toContain('--titulo');
    expect(args).toContain('A32-jovens-v1');
    expect(args).toContain('--perfil');
    // A fala NUNCA vai na linha de comando: acento dentro de aspas de shell é a
    // classe de bug que a receita antiga de xclip existia para evitar.
    expect(args.join(' ')).not.toContain('acento');
    const arq = args[args.indexOf('--fala-arquivo') + 1]!;
    expect(readFileSync(arq, 'utf8')).toBe('Olá. É a fala com acento.');
  });

  it('NÃO gera de novo quando o título já está no estúdio — trava de cobrança dupla', async () => {
    const tarefa = criarHeygenEstudio(
      cliente({
        porTitulo: async () => new Map([['A32-jovens-v1', { videoId: 'v1', status: 'pending' } as never]]),
      }),
      opts(async () => { throw new Error('não deve rodar o script'); }),
    );
    await expect(tarefa(ctx(entrada))).resolves.toBe('A32-jovens-v1');
  });

  it('um RASCUNHO não conta como enviado: o script continua dele', async () => {
    let rodou = false;
    const tarefa = criarHeygenEstudio(
      cliente({
        porTitulo: async () => new Map([['A32-jovens-v1', { videoId: 'v1', status: 'draft' } as never]]),
      }),
      opts(async () => { rodou = true; return { codigo: 0, saida: '' }; }),
    );
    await expect(tarefa(ctx(entrada))).resolves.toBe('A32-jovens-v1');
    expect(rodou).toBe(true);
  });

  it('leva o motivo do script para o erro do job, não "exit 3"', async () => {
    const tarefa = criarHeygenEstudio(cliente(), opts(async () => ({
      codigo: 3,
      saida: '02:10:01 buscando\nERRO: 3 cards com o nome exato "TEMPLATE-AVATAR" (esperado 1)\n',
    })));
    await expect(tarefa(ctx(entrada))).rejects.toThrow(/3 cards com o nome exato/);
  });

  it('recusa input sem texto — vídeo mudo não é falha silenciosa', async () => {
    const tarefa = criarHeygenEstudio(cliente(), opts(async () => ({ codigo: 0, saida: '' })));
    const semTexto = JSON.stringify({ titulo: 'A32-jovens-v1', texto: '  ' });
    await expect(tarefa(ctx(semTexto))).rejects.toThrow(/sem texto/);
  });

  it('estoura o prazo da fase em vez de tentar para sempre', async () => {
    const tarefa = criarHeygenEstudio(cliente(), opts(async () => ({ codigo: 0, saida: '' })));
    const comPrazo = JSON.stringify({
      titulo: 'A32-jovens-v1', texto: 'oi', espera: { intervalo: 60, timeout: 100 },
    });
    await expect(tarefa(ctx(comPrazo, { agora: () => 5_000 }))).rejects.toThrow(/não foi enviado/);
  });

  it('não começa quando o worker já largou o job', async () => {
    const c = new AbortController();
    c.abort(new Error('desligando'));
    const tarefa = criarHeygenEstudio(cliente(), opts(async () => {
      throw new Error('não deve rodar o script');
    }));
    await expect(tarefa(ctx(entrada, { sinal: c.signal }))).rejects.toThrow(/desligando/);
  });
});
