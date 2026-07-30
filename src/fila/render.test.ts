import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RenderFalhou, esperarArtefato, jaFoiDisparado, limparMarcadores } from './render.js';

let dir: string;
let alvo: string;

/** Relógio e sono FALSOS: a espera real usa janelas de 5s/12s/2h, e um teste
 * que dormisse de verdade seria lento e instável (regra da §6.1: relógio
 * injetável, nunca `sleep`). */
function relogio(): { agoraMs: () => number; dormir: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    agoraMs: () => t,
    dormir: async (ms: number) => { t += ms; },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inemaccbot-render-'));
  alvo = join(dir, 'video.mp4');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const semSinal = new AbortController().signal;

describe('esperarArtefato', () => {
  it('só considera pronto depois que o tamanho para de crescer', async () => {
    const { agoraMs, dormir } = relogio();
    let poll = 0;
    // O ffmpeg cria o .mp4 no primeiro frame e escreve nele por 40 minutos:
    // "arquivo existe" não é "arquivo pronto".
    const crescendo = async (ms: number): Promise<void> => {
      poll += 1;
      writeFileSync(alvo, 'x'.repeat(poll <= 3 ? poll * 10 : 30));
      await dormir(ms);
    };
    await expect(esperarArtefato(alvo, {
      timeoutMs: 600_000, sinal: semSinal, agoraMs, dormir: crescendo,
    })).resolves.toBe(alvo);
    expect(poll).toBeGreaterThan(3);
  });

  // Sem isto, um passo que morre 10s depois de disparado deixa o serviço
  // esperando o timeout INTEIRO (o bug real que o mkivideos documenta).
  it('o marcador .err falha na hora, sem esperar o timeout', async () => {
    const { agoraMs, dormir } = relogio();
    // O marcador aparece DURANTE a espera — é assim no caso real: o passo
    // destacado morre alguns segundos depois de disparado.
    const morrendo = async (ms: number): Promise<void> => {
      writeFileSync(`${alvo}.err`, '');
      writeFileSync(`${alvo}.log`, 'Traceback: yt-dlp explodiu');
      await dormir(ms);
    };
    const t0 = agoraMs();
    await expect(esperarArtefato(alvo, {
      timeoutMs: 7_200_000, sinal: semSinal, agoraMs, dormir: morrendo,
    })).rejects.toThrow(/passo destacado morreu/);
    // O ponto do teste: falhou em segundos, não nas 2h do backstop.
    expect(agoraMs() - t0).toBeLessThan(60_000);
  });

  it('o erro carrega o trecho do log — é onde o motivo real está', async () => {
    const { agoraMs, dormir } = relogio();
    const morrendo = async (ms: number): Promise<void> => {
      writeFileSync(`${alvo}.err`, '');
      writeFileSync(`${alvo}.log`, 'CUDA out of memory');
      await dormir(ms);
    };
    await expect(esperarArtefato(alvo, {
      timeoutMs: 600_000, sinal: semSinal, agoraMs, dormir: morrendo,
    })).rejects.toThrow(/CUDA out of memory/);
  });

  // Limpar marcador é responsabilidade de quem DISPARA (`limparMarcadores`), não
  // de quem vigia. Se a vigília limpasse, ela apagaria a prova do passo que
  // morreu depressa — o `.err` chega ANTES de a vigília começar — e o serviço
  // esperaria as 2h inteiras. Achado por teste vermelho, não por revisão.
  it('um .err presente na entrada é respeitado, não apagado', async () => {
    const { agoraMs, dormir } = relogio();
    writeFileSync(`${alvo}.err`, '');
    writeFileSync(alvo, 'pronto');
    await expect(esperarArtefato(alvo, {
      timeoutMs: 600_000, sinal: semSinal, agoraMs, dormir, estavelMs: 0,
    })).rejects.toThrow(/passo destacado morreu/);
  });

  it('timeout vira falha com o alvo no texto', async () => {
    const { agoraMs, dormir } = relogio();
    await expect(esperarArtefato(alvo, { timeoutMs: 30_000, sinal: semSinal, agoraMs, dormir }))
      .rejects.toThrow(RenderFalhou);
  });

  // Abortar NÃO é falha do render: o processo destacado segue vivo, e a próxima
  // tentativa o adota. O texto do erro tem que dizer isso, senão o operador vai
  // procurar defeito onde houve só um desligamento.
  it('abortar interrompe a espera dizendo que o render continua', async () => {
    const { agoraMs, dormir } = relogio();
    const ctrl = new AbortController();
    ctrl.abort(new Error('serviço encerrando'));
    await expect(esperarArtefato(alvo, { timeoutMs: 600_000, sinal: ctrl.signal, agoraMs, dormir }))
      .rejects.toThrow(/continua/);
  });
});

describe('limparMarcadores', () => {
  it('some com o .err e o .log da tentativa anterior', () => {
    writeFileSync(`${alvo}.err`, '');
    writeFileSync(`${alvo}.log`, 'velho');
    limparMarcadores(alvo);
    expect(jaFoiDisparado(alvo)).toBe(false);
  });

  it('não reclama quando não há o que limpar', () => {
    expect(() => limparMarcadores(alvo)).not.toThrow();
  });
});

describe('jaFoiDisparado', () => {
  it('reconhece o .log deixado pelo passo destacado', () => {
    expect(jaFoiDisparado(alvo)).toBe(false);
    writeFileSync(`${alvo}.log`, '');
    expect(jaFoiDisparado(alvo)).toBe(true);
  });

  it('o próprio artefato pronto também conta', () => {
    writeFileSync(alvo, 'pronto');
    expect(jaFoiDisparado(alvo)).toBe(true);
  });
});
