// Tarefa `function` mais barata que existe: serve para exercitar claim, lease,
// prioridade e cancelamento com jobs de milissegundos, onde errar custa pouco.
import type { Tarefa } from '../worker.js';
import type { ContextoTarefa } from '../types.js';

const LIMITE = 8_000;

export function criarHttpGet(fetchFn: typeof fetch = fetch): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    const { url } = JSON.parse(ctx.job.input || '{}') as { url?: string };
    if (!url) throw new Error('http.get: input precisa de { url }');
    const u = new URL(url);
    // Sem file:// nem data:: a URL vem do usuário, e um GET não pode virar
    // leitura de disco do servidor.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`http.get: esquema não permitido: ${u.protocol}`);
    }
    const r = await fetchFn(u);
    if (!r.ok) throw new Error(`http.get: HTTP ${r.status}`);
    const corpo = await r.text();
    return corpo.length > LIMITE ? `${corpo.slice(0, LIMITE)}\n… (truncado)` : corpo;
  };
}
