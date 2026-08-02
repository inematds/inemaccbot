import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AindaNao } from '../types.js';
import { criarHeygenBaixar, criarHeygenGerar, escolherUrl, lerChaveHeygen, type ClienteHeygen } from './heygen.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-heygen-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(input: string): ContextoTarefa {
  return {
    job: { input } as never,
    fila: {} as never,
    agora: () => 1_000,
    log: () => {},
    sinal: new AbortController().signal,
    aindaNao: (m: string) => { throw new AindaNao(m); },
  };
}

function cliente(over: Partial<ClienteHeygen> = {}): ClienteHeygen {
  return {
    porTitulo: async () => new Map(),
    urlDe: async () => 'https://cdn/video.mp4',
    baixar: async (_u, destino) => writeFileSync(destino, 'bytes-do-video'),
    // O fluxo manual nunca gera: se esta fase chamar a API, é bug — e o teste
    // tem que explodir, não passar em silêncio.
    gerar: async () => { throw new Error('o caminho manual não deve gerar vídeo'); },
    saldo: async () => null,
    ...over,
  };
}

const entrada = (destino: string) => JSON.stringify({ titulo: 'P16-mulheres-v1', destino });

// Quem decide se o vídeo tem legenda é o ESTÚDIO, não o bot: se o render foi
// feito com legenda, é esse vídeo que a gente quer. `video_url_caption` só vem
// preenchido quando existe render com legenda queimada — nos 25 vídeos medidos
// em 2026-08-01 (todos gravados sem legenda) ele veio nulo em todos.
describe('escolherUrl: o estúdio decide se tem legenda', () => {
  it('prefere o vídeo COM legenda quando o estúdio gravou com ela', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4', video_url_caption: 'https://cdn/legendado.mp4' }))
      .toBe('https://cdn/legendado.mp4');
  });

  it('cai no limpo quando o estúdio gravou sem legenda', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4', video_url_caption: null }))
      .toBe('https://cdn/limpo.mp4');
  });

  it('campo ausente também cai no limpo', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4' })).toBe('https://cdn/limpo.mp4');
  });

  // String vazia é o mesmo que não ter — baixar `""` viraria download HTTP
  // inválido em vez de "ainda sem url", que é o estado honesto.
  it('string vazia não conta como vídeo legendado', () => {
    expect(escolherUrl({ video_url: 'https://cdn/limpo.mp4', video_url_caption: '' }))
      .toBe('https://cdn/limpo.mp4');
  });

  it('sem nenhuma das duas: null, para a fase seguir esperando', () => {
    expect(escolherUrl({})).toBe(null);
    expect(escolherUrl(undefined)).toBe(null);
  });
});

describe('heygen.baixar', () => {
  it('baixa quando o vídeo está completed', async () => {
    const destino = join(dir, 'P16-mulheres-v1.mp4');
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'completed' }]]),
    }));
    await expect(t(ctx(entrada(destino)))).resolves.toBe(destino);
    expect(readFileSync(destino, 'utf8')).toBe('bytes-do-video');
  });

  // O caso NORMAL enquanto a pessoa ainda está gerando no estúdio. Tratar isso
  // como falha queimaria as tentativas da fase em minutos.
  it('vídeo ausente vira "ainda não", não falha', async () => {
    const t = criarHeygenBaixar(cliente());
    await expect(t(ctx(entrada(join(dir, 'x.mp4'))))).rejects.toThrow(AindaNao);
  });

  it('vídeo ainda processando também é "ainda não"', async () => {
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'processing' }]]),
    }));
    await expect(t(ctx(entrada(join(dir, 'x.mp4'))))).rejects.toThrow(/processing/);
  });

  it('completed sem video_url é "ainda não" — não é erro do usuário', async () => {
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'completed' }]]),
      urlDe: async () => null,
    }));
    await expect(t(ctx(entrada(join(dir, 'x.mp4'))))).rejects.toThrow(AindaNao);
  });

  // §2.5, "procure antes de criar": sem isto uma retentativa depois de um crash
  // baixaria de novo E enfileiraria um segundo reel.
  it('arquivo já baixado é ADOTADO, sem tocar na API', async () => {
    const destino = join(dir, 'pronto.mp4');
    writeFileSync(destino, 'ja-estava-aqui');
    let chamou = false;
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => { chamou = true; return new Map(); },
    }));
    await expect(t(ctx(entrada(destino)))).resolves.toBe(destino);
    expect(chamou).toBe(false);
  });

  it('arquivo vazio no destino NÃO conta como baixado', async () => {
    const destino = join(dir, 'vazio.mp4');
    writeFileSync(destino, '');
    const t = criarHeygenBaixar(cliente());
    await expect(t(ctx(entrada(destino)))).rejects.toThrow(AindaNao);
  });

  it('download que produz arquivo vazio é FALHA, não "ainda não"', async () => {
    const destino = join(dir, 'z.mp4');
    const t = criarHeygenBaixar(cliente({
      porTitulo: async () => new Map([['P16-mulheres-v1', { videoId: 'v1', status: 'completed' }]]),
      baixar: async () => writeFileSync(destino, ''),
    }));
    await expect(t(ctx(entrada(destino)))).rejects.toThrow(/vazio/);
  });

  it('input incompleto falha claro', async () => {
    await expect(criarHeygenBaixar(cliente())(ctx('{}'))).rejects.toThrow(/titulo, destino/);
  });
});

describe('lerChaveHeygen', () => {
  it('lê a chave do arquivo apontado, em runtime', () => {
    expect(lerChaveHeygen('/x/.env', () => 'OUTRA=1\nHEYGEN_API_KEY="abc123"\n')).toBe('abc123');
  });

  it('erro claro quando a chave não está lá', () => {
    expect(() => lerChaveHeygen('/x/.env', () => 'NADA=1')).toThrow(/HEYGEN_API_KEY/);
  });
});

/**
 * `heygen.gerar` — a alternativa por API à gravação manual no estúdio.
 *
 * A trava que mais importa aqui é a de NÃO cobrar duas vezes: `max_tentativas`
 * é 2 e um `systemctl restart` no meio (o `código 143`, que já matou o
 * `C#13/jovens-aut`) faria uma versão ingênua regerar — e recobrar — os 36
 * vídeos do fluxo.
 */
describe('heygen.gerar', () => {
  const entradaGerar = (over: Record<string, unknown> = {}) => JSON.stringify({
    titulo: 'C15-jovens-alc-v1',
    texto: 'A China está entregando IA de ponta em código aberto.',
    avatarId: 'av-1',
    voiceId: 'vo-1',
    espera: { intervalo: 60, timeout: 3600 },
    ...over,
  });

  function clienteGerador(over: Partial<ClienteHeygen> = {}): ClienteHeygen & { gerados: unknown[] } {
    const gerados: unknown[] = [];
    return {
      porTitulo: async () => new Map(),
      urlDe: async () => null,
      baixar: async () => {},
      gerar: async (pedido) => { gerados.push(pedido); return 'video-novo'; },
      saldo: async () => 10,
      gerados,
      ...over,
    } as ClienteHeygen & { gerados: unknown[] };
  }

  it('gera quando o título ainda não existe no estúdio', async () => {
    const c = clienteGerador();
    await expect(criarHeygenGerar(c)(ctx(entradaGerar()))).rejects.toThrow(AindaNao);
    expect(c.gerados).toHaveLength(1);
    expect(c.gerados[0]).toMatchObject({
      titulo: 'C15-jovens-alc-v1', avatarId: 'av-1', voiceId: 'vo-1',
    });
  });

  // §2.5, e aqui vale DINHEIRO: o título já estar no estúdio significa que a
  // tentativa anterior já gerou (e já cobrou).
  it('NÃO gera de novo quando o título já existe — em qualquer status', async () => {
    for (const status of ['processing', 'pending', 'completed', 'failed']) {
      const c = clienteGerador({
        porTitulo: async () => new Map([['C15-jovens-alc-v1', { videoId: 'v1', status }]]),
      });
      await criarHeygenGerar(c)(ctx(entradaGerar())).catch(() => {});
      expect(c.gerados, `status ${status}`).toHaveLength(0);
    }
  });

  it('a chave de idempotência vem do TÍTULO, não é sorteada', async () => {
    const c = clienteGerador();
    await criarHeygenGerar(c)(ctx(entradaGerar())).catch(() => {});
    const c2 = clienteGerador();
    await criarHeygenGerar(c2)(ctx(entradaGerar())).catch(() => {});
    expect((c.gerados[0] as { chave: string }).chave)
      .toBe((c2.gerados[0] as { chave: string }).chave);
  });

  it('terminou de gerar: devolve o título, e quem baixa é a fase seguinte', async () => {
    const c = clienteGerador({
      porTitulo: async () => new Map([['C15-jovens-alc-v1', { videoId: 'v1', status: 'completed' }]]),
    });
    await expect(criarHeygenGerar(c)(ctx(entradaGerar()))).resolves.toBe('C15-jovens-alc-v1');
  });

  it('ainda processando: pede para voltar depois, sem falhar', async () => {
    const c = clienteGerador({
      porTitulo: async () => new Map([['C15-jovens-alc-v1', { videoId: 'v1', status: 'processing' }]]),
    });
    await expect(criarHeygenGerar(c)(ctx(entradaGerar()))).rejects.toThrow(AindaNao);
  });

  // `failed` no estúdio é falha de verdade: insistir no poll gastaria a janela
  // inteira esperando um vídeo que não vem.
  it('vídeo que falhou no estúdio falha a fase, não fica em poll', async () => {
    const c = clienteGerador({
      porTitulo: async () => new Map([['C15-jovens-alc-v1', { videoId: 'v1', status: 'failed' }]]),
    });
    await expect(criarHeygenGerar(c)(ctx(entradaGerar()))).rejects.toThrow(/falhou no estúdio/);
  });

  // A carteira é PRÉ-PAGA. Sem esta trava, o fluxo de 36 alvos gera até o saldo
  // acabar e falha no meio — com os já gerados cobrados e o resto não.
  it('carteira zerada: falha antes de gerar, dizendo o saldo', async () => {
    const c = clienteGerador({ saldo: async () => 0 });
    await expect(criarHeygenGerar(c)(ctx(entradaGerar()))).rejects.toThrow(/carteira|saldo/i);
    expect(c.gerados).toHaveLength(0);
  });

  // O caso REAL da conta em 2026-08-02: US$ 0,22 na carteira. `<= 0` deixaria
  // passar, o vídeo custaria ~US$ 1 e a fase morreria no meio do fluxo — com os
  // primeiros alvos já cobrados. O piso é por VÍDEO, não "maior que zero".
  it('saldo que não cobre um vídeo NÃO gera', async () => {
    const c = clienteGerador({ saldo: async () => 0.22 });
    await expect(criarHeygenGerar(c)(ctx(entradaGerar()))).rejects.toThrow(/0\.22/);
    expect(c.gerados).toHaveLength(0);
  });

  it('com saldo, gera normalmente', async () => {
    const c = clienteGerador({ saldo: async () => 12.5 });
    await criarHeygenGerar(c)(ctx(entradaGerar())).catch(() => {});
    expect(c.gerados).toHaveLength(1);
  });

  // Saldo indisponível (endpoint fora do ar) não pode virar bloqueio: o
  // pipeline pararia por causa do medidor, não da conta.
  it('saldo indisponível não bloqueia', async () => {
    const c = clienteGerador({ saldo: async () => null });
    await criarHeygenGerar(c)(ctx(entradaGerar())).catch(() => {});
    expect(c.gerados).toHaveLength(1);
  });

  it('input sem texto, avatar ou voz é recusado antes de gastar', async () => {
    const c = clienteGerador();
    await expect(criarHeygenGerar(c)(ctx(entradaGerar({ texto: '' })))).rejects.toThrow(/texto/);
    await expect(criarHeygenGerar(c)(ctx(entradaGerar({ avatarId: '' })))).rejects.toThrow(/avatar/);
    expect(c.gerados).toHaveLength(0);
  });
});
