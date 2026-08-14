import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AindaNao, type ContextoTarefa } from '../types.js';
import { criarReelMontar, montarComando } from './reel.js';

/** Vigília rápida: em produção valem os padrões (5s de poll, 12s de estabilidade). */
const VIGIA = { intervaloMs: 10, estavelMs: 20 };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-reel-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

/** Cria avatar e texto no disco — o que a tarefa exige antes de disparar. */
function entrada(over: Record<string, unknown> = {}): string {
  const avatar = join(dir, 'A29-jovens-v1.mp4');
  const textos = join(dir, 'jovens.md');
  writeFileSync(avatar, 'mp4');
  writeFileSync(textos, '### FALA\noi');
  return JSON.stringify({
    avatar, textos, saida: join(dir, 'saida', '600.mp4'),
    alvo: 'jovens', ws: join(dir, 'ws'), script: join(dir, 'montar-reel.py'),
    ...over,
  });
}

describe('reel.montar: dispara o pipeline sem agente', () => {
  it('dispara o montar-reel.py com os argumentos do job', async () => {
    const chamadas: { comando: string }[] = [];
    // O `.err` logo depois de disparar encerra a espera: o teste é sobre O QUE
    // foi disparado, não sobre a vigília.
    const tarefa = criarReelMontar({
      disparar: (d) => { chamadas.push(d); writeFileSync(`${d.saida}.err`, ''); },
      vigia: VIGIA,
    });
    await expect(tarefa(ctx(entrada()))).rejects.toThrow();
    const d = chamadas[0]!;
    expect(d.comando).toContain('montar-reel.py');
    expect(d.comando).toContain('--alvo jovens');
    expect(d.comando).toContain('A29-jovens-v1.mp4');
    // O `.err` é o que faz um pipeline morto falhar em segundos, não em 2h.
    expect(d.comando).toContain('.err');
    // O PID vem de DENTRO do bash -c: é por ele que o /cancelar mata o render.
    expect(d.comando).toContain('echo $$');
  });

  it('devolve a saída quando o arquivo já existe (procure antes de criar)', async () => {
    const saida = join(dir, 'pronto.mp4');
    writeFileSync(saida, 'mp4-pronto');
    const tarefa = criarReelMontar({ disparar: () => { throw new Error('não deve disparar'); } });
    await expect(tarefa(ctx(entrada({ saida })))).resolves.toBe(saida);
  });

  it('falha quando o texto do público não existe — não dispara render torto', async () => {
    const tarefa = criarReelMontar({ disparar: () => { throw new Error('não deve disparar'); } });
    const inp = entrada({ textos: join(dir, 'nao-existe.md') });
    await expect(tarefa(ctx(inp))).rejects.toThrow(/nao-existe\.md/);
  });

  it('falha quando o avatar não existe', async () => {
    const tarefa = criarReelMontar({ disparar: () => { throw new Error('não deve disparar'); } });
    const inp = entrada({ avatar: join(dir, 'sem-avatar.mp4') });
    await expect(tarefa(ctx(inp))).rejects.toThrow(/sem-avatar\.mp4/);
  });

  it('adota o render em curso em vez de disparar um segundo na mesma GPU', async () => {
    const saida = join(dir, 'saida', '601.mp4');
    mkdirSync(join(dir, 'saida'), { recursive: true });
    writeFileSync(`${saida}.log`, 'render andando');
    writeFileSync(`${saida}.pid`, String(process.pid)); // vivo de verdade
    const tarefa = criarReelMontar({
      disparar: () => { throw new Error('não deve disparar'); }, vigia: VIGIA,
    });
    // Adotar é ESPERAR o mesmo render; o `.err` encerra a espera no teste.
    const c = new AbortController();
    const p = tarefa(ctx(entrada({ saida }), { sinal: c.signal }));
    writeFileSync(`${saida}.err`, '');
    await expect(p).rejects.toThrow();
  });

  // O defeito que custou 24 renders simultâneos no A#30/A#31 (2026-08-06): a
  // tarefa devolvia `aindaNao` depois de disparar, liberando a vaga da fila
  // `render` (concorrência 1 = a GPU) para o job seguinte disparar o SEU.
  it('SEGURA o job enquanto o render corre — não devolve a vaga da fila', async () => {
    const saida = join(dir, 'saida', '604.mp4');
    let dispararam = 0;
    const tarefa = criarReelMontar({ disparar: () => { dispararam++; }, vigia: VIGIA });
    const p = tarefa(ctx(entrada({ saida })));
    let resolvida = false;
    void p.then(() => { resolvida = true; }, () => { resolvida = true; });
    await new Promise((r) => setTimeout(r, 60));
    expect(dispararam).toBe(1);
    expect(resolvida).toBe(false);      // ainda esperando: a vaga continua ocupada
    mkdirSync(join(dir, 'saida'), { recursive: true });
    writeFileSync(`${saida}.err`, '');  // encerra a vigília
    await expect(p).rejects.toThrow();
  });

  // O reel tem que CHEGAR AO CANAL. Quando a fase virou função, o `destino`
  // deixou de ser montado (só o branch de skill o fazia, porque quem copiava
  // era o agente) e 24 reels do A#30/A#31 ficaram no artefato do bot sem nunca
  // ir para o `yt-pub-livesN` — com link no chat, o que fazia parecer entregue.
  it('entrega o reel na pasta do canal', async () => {
    const saida = join(dir, 'saida', '700.mp4');
    const destino = join(dir, 'yt-pub-lives22', 'imports', 'videos');
    const inp = entrada({ saida, destino });
    const tarefa = criarReelMontar({
      disparar: (d) => { mkdirSync(dirname(d.saida), { recursive: true }); writeFileSync(d.saida, 'reel-pronto'); },
      vigia: VIGIA,
    });
    await expect(tarefa(ctx(inp))).resolves.toBe(saida);
    expect(readFileSync(join(destino, '700.mp4'), 'utf8')).toBe('reel-pronto');
  });

  it('não recopia quando o canal já tem o arquivo do mesmo tamanho', async () => {
    const saida = join(dir, 'saida', '701.mp4');
    const destino = join(dir, 'canal');
    mkdirSync(join(dir, 'saida'), { recursive: true });
    mkdirSync(destino, { recursive: true });
    writeFileSync(saida, 'pronto');
    writeFileSync(join(destino, '701.mp4'), 'MARCA!');  // MESMO tamanho (6 bytes)
    const tarefa = criarReelMontar({ disparar: () => { throw new Error('não deve disparar'); } });
    await expect(tarefa(ctx(entrada({ saida, destino })))).resolves.toBe(saida);
    expect(readFileSync(join(destino, '701.mp4'), 'utf8')).toBe('MARCA!');
  });

  it('canal inacessível NÃO derruba o job — o reel já está pronto', async () => {
    const saida = join(dir, 'saida', '702.mp4');
    mkdirSync(join(dir, 'saida'), { recursive: true });
    writeFileSync(saida, 'pronto');
    const tarefa = criarReelMontar({ disparar: () => { throw new Error('não deve disparar'); } });
    const inp = entrada({ saida, destino: '/dev/null/videos' });
    await expect(tarefa(ctx(inp))).resolves.toBe(saida);
  });

  it('falha quando a tentativa anterior deixou o marcador .err', async () => {
    const saida = join(dir, 'saida', '602.mp4');
    mkdirSync(join(dir, 'saida'), { recursive: true });
    writeFileSync(`${saida}.log`, 'portao 3 reprovou: preto');
    writeFileSync(`${saida}.err`, '');
    const chamadas: unknown[] = [];
    const tarefa = criarReelMontar({ disparar: (d) => { chamadas.push(d); } });
    await expect(tarefa(ctx(entrada({ saida })))).rejects.toThrow(/portao 3 reprovou/);
    expect(chamadas).toHaveLength(0);
  });

  it('estoura o prazo da fase em vez de pollar para sempre', async () => {
    const inp = entrada({ espera: { intervalo: 60, timeout: 100 } });
    const tarefa = criarReelMontar({ disparar: () => {} });
    await expect(tarefa(ctx(inp, { agora: () => 5_000 }))).rejects.toThrow(/não ficou pronto/);
  });

  it('não começa quando o worker já largou o job', async () => {
    const c = new AbortController();
    c.abort(new Error('desligando'));
    const tarefa = criarReelMontar({ disparar: () => { throw new Error('não deve disparar'); } });
    await expect(tarefa(ctx(entrada(), { sinal: c.signal }))).rejects.toThrow(/desligando/);
  });

  it('limpa marcadores da tentativa encerrada antes de disparar de novo', async () => {
    const saida = join(dir, 'saida', '603.mp4');
    mkdirSync(join(dir, 'saida'), { recursive: true });
    writeFileSync(`${saida}.log`, 'velho');
    writeFileSync(`${saida}.err`, '');
    const tarefa = criarReelMontar({ disparar: () => {} });
    // Primeira passada: falha pelo `.err`. Segunda (depois do /refazer): limpa.
    await expect(tarefa(ctx(entrada({ saida })))).rejects.toThrow();
    expect(existsSync(`${saida}.err`)).toBe(false);
    expect(existsSync(`${saida}.log`)).toBe(false);
  });
});

// O último elo: o clipe escolhido na criação precisa virar argumento do
// `montar-reel.py`. Sem `--cta`, o script usa o default dele e a escolha por
// variante morre em silêncio no caminho.
describe('--cta', () => {
  const base = {
    avatar: '/a.mp4', alvo: 'jovens', textos: '/t.md', saida: '/s.mp4',
    ws: '/ws', script: '/m.py',
  };

  it('entra no comando quando a entrada traz o clipe', () => {
    expect(montarComando({ ...base, cta: '/dom/cta/marca-9x16.mp4' }))
      .toContain(`--cta '/dom/cta/marca-9x16.mp4'`);
  });

  it('some quando não há clipe declarado', () => {
    expect(montarComando(base)).not.toContain('--cta');
  });

  it('caminho com aspas não vira comando', () => {
    expect(montarComando({ ...base, cta: "/dom/it's.mp4" })).toContain(`'/dom/it'\\''s.mp4'`);
  });
});
