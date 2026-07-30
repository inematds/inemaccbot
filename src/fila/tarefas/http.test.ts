import { describe, expect, it } from 'vitest';

import { criarHttpGet } from './http.js';
import type { ContextoTarefa } from '../types.js';

const ctx = (input: string, sinal = new AbortController().signal): ContextoTarefa =>
  ({ job: { input } as never, fila: {} as never, agora: () => 1_000, log: () => {}, sinal });

describe('http.get', () => {
  it('devolve o corpo de uma resposta 200', async () => {
    const tarefa = criarHttpGet(async () => new Response('conteúdo', { status: 200 }));
    await expect(tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' })))).resolves.toBe('conteúdo');
  });

  it('falha com o status quando não é 2xx', async () => {
    const tarefa = criarHttpGet(async () => new Response('nao', { status: 503 }));
    await expect(tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' })))).rejects.toThrow(/503/);
  });

  it('rejeita input sem url', async () => {
    const tarefa = criarHttpGet(async () => new Response('x'));
    await expect(tarefa(ctx('{}'))).rejects.toThrow(/url/i);
  });

  it('rejeita esquema que não seja http(s) — sem file:// nem data:', async () => {
    const tarefa = criarHttpGet(async () => new Response('x'));
    await expect(tarefa(ctx(JSON.stringify({ url: 'file:///etc/passwd' })))).rejects.toThrow(/esquema/i);
  });

  it('repassa o sinal de aborto do worker para o fetch', async () => {
    // Sem isto uma requisição em voo sobreviveria ao desligamento.
    let visto: AbortSignal | undefined;
    const tarefa = criarHttpGet(async (_u, init) => {
      visto = (init as RequestInit | undefined)?.signal ?? undefined;
      return new Response('ok', { status: 200 });
    });
    const c = new AbortController();
    await tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' }), c.signal));
    expect(visto).toBe(c.signal);
  });

  it('trunca corpo gigante em vez de devolver megabytes pro chat', async () => {
    const tarefa = criarHttpGet(async () => new Response('a'.repeat(20_000), { status: 200 }));
    const saida = await tarefa(ctx(JSON.stringify({ url: 'https://exemplo.test/a' })));
    expect(saida.length).toBeLessThanOrEqual(8_200);
    expect(saida).toMatch(/truncado/);
  });
});
