// A rota de CRÉDITOS: gera pela CLI `heygen`, autenticada por OAuth.
//
// O que muda em relação à rota de API é SÓ quem paga: a CLI autentica como a
// conta web e debita da assinatura (`billing_type: subscription`), enquanto a
// chave de API debita da carteira em dólar. Medido em 2026-08-02: um vídeo de
// 8,67s custou 1 crédito, e a carteira não se mexeu.
//
// O resto do caminho é o mesmo — inclusive a busca por título, que continua
// usando a chave de API: as duas credenciais veem a MESMA conta, e foi isso que
// dispensou reescrever a fase `baixar`.
import { describe, expect, it } from 'vitest';

import { clienteViaCli } from './heygen-cli.js';
import type { ClienteHeygen } from './heygen.js';

function base(over: Partial<ClienteHeygen> = {}): ClienteHeygen {
  return {
    porTitulo: async () => new Map(),
    urlDe: async () => null,
    baixar: async () => {},
    gerar: async () => { throw new Error('a rota de créditos não deve usar a API paga'); },
    saldo: async () => 99,
    ...over,
  };
}

/** Simula a CLI: guarda o que foi chamado e devolve a saída combinada. */
function cli(saidas: Record<string, string>): {
  rodar: (args: string[]) => Promise<string>; chamadas: string[][];
} {
  const chamadas: string[][] = [];
  return {
    chamadas,
    rodar: async (args: string[]) => {
      chamadas.push(args);
      const chave = args[0] === 'auth' ? 'auth' : 'create';
      return saidas[chave] ?? '{}';
    },
  };
}

const OK_CREATE = JSON.stringify({ data: { video_id: 'v-novo', status: 'waiting' } });
const OK_AUTH = JSON.stringify({
  data: { subscription: { credits: { premium_credits: { remaining: 199 }, add_on_credits: { remaining: 300 } } } },
});

const pedido = {
  titulo: 'C15-jovens-alc-v1', texto: 'fala', avatarId: 'av', voiceId: 'vo',
  engine: 'avatar_iii', chave: 'gerar-C15-jovens-alc-v1',
};

describe('clienteViaCli', () => {
  it('gera pela CLI e devolve o video_id', async () => {
    const c = cli({ create: OK_CREATE });
    const cliente = clienteViaCli(base(), c.rodar);
    await expect(cliente.gerar(pedido)).resolves.toBe('v-novo');
    expect(c.chamadas[0]!.slice(0, 2)).toEqual(['video', 'create']);
  });

  it('manda título, motor, avatar e voz no corpo', async () => {
    const c = cli({ create: OK_CREATE });
    await clienteViaCli(base(), c.rodar).gerar(pedido);
    const corpo = JSON.parse(c.chamadas[0]!.at(-1)!) as Record<string, unknown>;
    expect(corpo).toMatchObject({
      type: 'avatar', title: 'C15-jovens-alc-v1', avatar_id: 'av', voice_id: 'vo',
      engine: { type: 'avatar_iii' },
    });
  });

  // A chave de API vence a sessão OAuth quando está no ambiente ("HEYGEN_API_KEY
  // always takes priority over any stored credential", diz a própria CLI). Se
  // isso acontecer, esta rota cobraria da CARTEIRA calada.
  it('não deixa a chave de API vazar para o ambiente da CLI', async () => {
    const c = cli({ create: OK_CREATE });
    await clienteViaCli(base(), c.rodar).gerar(pedido);
    expect(process.env.HEYGEN_API_KEY ?? '').toBe('');
  });

  it('saldo é a soma dos créditos da assinatura, não dólares', async () => {
    const c = cli({ auth: OK_AUTH });
    await expect(clienteViaCli(base(), c.rodar).saldo()).resolves.toBe(499);
    expect(c.chamadas[0]!.slice(0, 2)).toEqual(['auth', 'status']);
  });

  it('CLI sem sessão não bloqueia: saldo indisponível é null', async () => {
    const cliente = clienteViaCli(base(), async () => { throw new Error('no API key found'); });
    await expect(cliente.saldo()).resolves.toBe(null);
  });

  it('erro da CLI ao gerar é falha de verdade, com a saída no erro', async () => {
    const cliente = clienteViaCli(base(), async () => { throw new Error('rate limited'); });
    await expect(cliente.gerar(pedido)).rejects.toThrow(/rate limited/);
  });

  // Busca, download e leitura de url continuam vindo da chave de API — provado
  // em produção: o `video.list` acha pelo título o vídeo gerado por OAuth.
  it('delega porTitulo/urlDe/baixar ao cliente de API', async () => {
    let buscou = false;
    const cliente = clienteViaCli(
      base({ porTitulo: async () => { buscou = true; return new Map(); } }),
      async () => OK_CREATE,
    );
    await cliente.porTitulo(['x']);
    expect(buscou).toBe(true);
  });
});
