import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarFfmpegThumb } from './ffmpeg.js';
import { criarTarefas } from './index.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
let raiz: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-'));
  raiz = dir; // usa o próprio dir como raiz permitida para testes
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (input: string, sinal = new AbortController().signal): ContextoTarefa =>
  ({
    job: { input } as never, fila: {} as never, agora: () => 1_000, log: () => {}, sinal,
    aindaNao: (m: string) => { throw new Error(m); },
  });

describe('ffmpeg.thumb', () => {
  it('rejeita entrada que não existe, sem chamar o binário', async () => {
    const tarefa = criarFfmpegThumb('/bin/false', raiz);
    await expect(tarefa(ctx(JSON.stringify({ entrada: join(raiz, 'nao-existe.mp4') }))))
      .rejects.toThrow(/não encontrado|nao encontrado/i);
  });

  it('rejeita input sem entrada', async () => {
    await expect(criarFfmpegThumb('/bin/true', raiz)(ctx('{}'))).rejects.toThrow(/entrada/i);
  });

  it('devolve o caminho da saída quando o binário sai com 0', async () => {
    const entrada = join(raiz, 'v.mp4');
    writeFileSync(entrada, 'x');
    // /bin/true ignora os argumentos e sai 0; o teste prova o contrato da tarefa
    // (validação, montagem de argumentos, caminho de saída), não o ffmpeg.
    const saida = await criarFfmpegThumb('/bin/true', raiz)(ctx(JSON.stringify({ entrada })));
    expect(saida).toBe(`${entrada}.jpg`);
  });

  it('falha com o código quando o binário sai diferente de 0', async () => {
    const entrada = join(raiz, 'v.mp4');
    writeFileSync(entrada, 'x');
    await expect(criarFfmpegThumb('/bin/false', raiz)(ctx(JSON.stringify({ entrada }))))
      .rejects.toThrow(/código 1/);
  });

  it('rejeita arquivo fora da raiz permitida, sem chamar o binário', async () => {
    const fora = mkdtempSync(join(tmpdir(), 'inemaccbot-fora-'));
    try {
      const entrada = join(fora, 'v.mp4');
      writeFileSync(entrada, 'x');
      const tarefa = criarFfmpegThumb('/bin/false', raiz);
      await expect(tarefa(ctx(JSON.stringify({ entrada }))))
        .rejects.toThrow(/fora da raiz|raiz permitida/i);
    } finally {
      rmSync(fora, { recursive: true, force: true });
    }
  });

  it('rejeita caminho com prefixo parecido (sibling-prefix)', async () => {
    // Caso malicioso: raiz=/tmp/abc123/midia, entrada=/tmp/abc123/midia-outra/v.mp4
    // Um simples startsWith(raiz) falharia aqui.
    const raizTest = join(dir, 'midia');
    const raizOutra = join(dir, 'midia-outra');
    const entrada = join(raizOutra, 'v.mp4');

    // Prepara a estrutura
    const fs = await import('node:fs/promises');
    await fs.mkdir(raizTest, { recursive: true });
    await fs.mkdir(raizOutra, { recursive: true });
    await fs.writeFile(entrada, 'x');

    const tarefa = criarFfmpegThumb('/bin/false', raizTest);
    await expect(tarefa(ctx(JSON.stringify({ entrada }))))
      .rejects.toThrow(/fora da raiz|raiz permitida/i);
  });

  it('aceita traversal que se resolve dentro da raiz', async () => {
    const subdir = join(raiz, 'sub');
    const fs = await import('node:fs/promises');
    await fs.mkdir(subdir, { recursive: true });

    const entrada = join(subdir, '..', 'v.mp4');
    writeFileSync(join(raiz, 'v.mp4'), 'x');

    const saida = await criarFfmpegThumb('/bin/true', raiz)(ctx(JSON.stringify({ entrada })));
    // A saída deve ser o caminho RESOLVIDO, não a entrada bruta
    expect(saida).toBe(`${join(raiz, 'v.mp4')}.jpg`);
  });
});

describe('aborto', () => {
  /** Wrapper que grava o PID do processo que ELE VIRA (`exec`), não de um
   * filho seu: assim o PID do arquivo é o mesmo processo que o Node gerou, e o
   * ESRCH depois prova que aquele processo morreu. */
  function wrapperSleep(pidFile: string): string {
    const script = join(dir, 'sleeper.sh');
    writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\nexec /bin/sleep 30\n`, { mode: 0o755 });
    return script;
  }

  async function ate(cond: () => boolean, limiteMs: number): Promise<boolean> {
    const fim = Date.now() + limiteMs;
    while (Date.now() < fim) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return cond();
  }

  /** PID já escrito por inteiro, ou 0 se o arquivo ainda não tem conteúdo válido. */
  function lerPid(arquivo: string): number {
    try {
      const bruto = readFileSync(arquivo, 'utf8').trim();
      const n = Number(bruto);
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  const vivo = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it('aborta o processo filho quando o worker desiste do job', async () => {
    const pidFile = join(dir, 'pid');
    const entrada = join(raiz, 'v.mp4');
    writeFileSync(entrada, 'x');
    const c = new AbortController();
    // Captura a promise ANTES de abortar — senão a rejeição fica sem handler.
    const p = criarFfmpegThumb(wrapperSleep(pidFile), raiz)(
      ctx(JSON.stringify({ entrada }), c.signal),
    );
    p.catch(() => {}); // rejeição já é esperada abaixo; evita unhandled no meio
    // Espera o CONTEÚDO, não a existência: o `>` do shell cria o arquivo antes
    // de escrever nele, e sob carga a leitura pegava string vazia — `Number('')`
    // é 0, e o teste falhava de forma intermitente. (Pior: podia ler um PID
    // truncado e passar verde pelo motivo errado.)
    await ate(() => lerPid(pidFile) > 0, 5_000);
    const pid = lerPid(pidFile);
    expect(pid).toBeGreaterThan(0);
    expect(vivo(pid)).toBe(true);

    c.abort(new Error('encerrando'));
    await expect(p).rejects.toThrow(/abortado/i);

    // Poll limitado: a morte do filho é assíncrona, mas 2s é folga enorme.
    const morreu = await ate(() => !vivo(pid), 2_000);
    if (!morreu) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* já morto */ }
    }
    expect(morreu).toBe(true);
  });
});

describe('catálogo', () => {
  it('expõe exatamente as tarefas conhecidas', () => {
    const tarefas = criarTarefas({ raizMidia: raiz });
    expect(Object.keys(tarefas).sort())
      .toEqual([
        'cli.rodar', 'ffmpeg.thumb', 'heygen.baixar', 'heygen.estudio', 'heygen.gerar',
        'heygen.gerar-creditos', 'http.get', 'reel.montar',
      ]);
  });
});
