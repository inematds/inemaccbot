import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { statSync } from 'node:fs';
import { RenderFalhou, esperarArtefato, limparMarcadores, processoVivo, trabalhoEmCurso } from './render.js';

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
  // Este teste afirmava que `.err` + artefato pronto = FALHA. O A#8/criadores
  // mostrou que está errado: o render tinha completado, o MP4 tinha 50 MB, e o
  // job morreu. O próprio `trabalhoEmCurso` já discordava
  // (`if (existsSync(alvo)) return true; // pronto: adotar é o certo`).
  // A intenção original — `esperarArtefato` NÃO apaga marcador, quem limpa é
  // quem dispara — continua provada abaixo.
  it('com .err e artefato pronto, o ARTEFATO vence — e o marcador não é apagado', async () => {
    const { agoraMs, dormir } = relogio();
    writeFileSync(`${alvo}.err`, '');
    writeFileSync(alvo, 'pronto');
    await expect(esperarArtefato(alvo, {
      timeoutMs: 600_000, sinal: semSinal, agoraMs, dormir, estavelMs: 0,
    })).resolves.toBe(alvo);
    expect(existsSync(`${alvo}.err`)).toBe(true);
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
    expect(trabalhoEmCurso(alvo)).toBe(false);
  });

  it('não reclama quando não há o que limpar', () => {
    expect(() => limparMarcadores(alvo)).not.toThrow();
  });
});

describe('trabalhoEmCurso', () => {
  it('reconhece o .log deixado pelo passo destacado', () => {
    expect(trabalhoEmCurso(alvo)).toBe(false);
    writeFileSync(`${alvo}.log`, '');
    expect(trabalhoEmCurso(alvo)).toBe(true);
  });

  it('o próprio artefato pronto também conta', () => {
    writeFileSync(alvo, 'pronto');
    expect(trabalhoEmCurso(alvo)).toBe(true);
  });

  // O ponto mais sutil desta etapa: com `.err`, a tentativa anterior ENCERROU.
  // Adotar aí faria a retentativa ler o marcador velho e falhar na hora — o
  // `max_tentativas` não compraria nada exatamente no caso para o qual existe.
  it('com .err presente NÃO está em curso: a retentativa dispara de novo', () => {
    writeFileSync(`${alvo}.log`, '');
    writeFileSync(`${alvo}.err`, '');
    expect(trabalhoEmCurso(alvo)).toBe(false);
  });

  // MVD#90 e MVD#91, 2026-08-22: `.log` de ontem, SEM `.pid` (o processo morreu
  // sem deixar rastro), e a tentativa seguinte ADOTOU o morto — 180 min olhando
  // um arquivo que ninguém escrevia, com a fila `render` (1 por vez) parada.
  it('sem .pid e com .log PARADO, o trabalho não está em curso', () => {
    writeFileSync(`${alvo}.log`, 'progresso: 33/47');
    const mtime = statSync(`${alvo}.log`).mtimeMs;
    expect(trabalhoEmCurso(alvo, () => mtime + 5 * 60_000)).toBe(true);    // 5 min: lento
    expect(trabalhoEmCurso(alvo, () => mtime + 25 * 60_000)).toBe(false);  // 25 min: parado
  });

  it('.pid VIVO manda mais que o relógio do log', () => {
    // Nunca declarar morto quem tem prova de vida: a geração já paga vale mais
    // que a suspeita de lentidão.
    writeFileSync(`${alvo}.log`, 'progresso: 33/47');
    writeFileSync(`${alvo}.pid`, String(process.pid));
    const mtime = statSync(`${alvo}.log`).mtimeMs;
    expect(trabalhoEmCurso(alvo, () => mtime + 90 * 60_000)).toBe(true);
  });

  it('.pid MORTO encerra, mesmo com log recém-escrito', () => {
    writeFileSync(`${alvo}.log`, 'progresso: 33/47');
    writeFileSync(`${alvo}.pid`, '2147483646');   // pid que não existe
    expect(trabalhoEmCurso(alvo, () => Date.now())).toBe(false);
  });
});

/**
 * A#8/criadores em produção: o `.err` foi criado 02:23, o MP4 terminou 02:24 —
 * "Render complete" no log, 50 MB no disco — e o job foi declarado morto. A
 * checagem do marcador vinha ANTES da do artefato.
 */
describe('marcador de erro com artefato a caminho', () => {
  it('o artefato que aparece DEPOIS do .err ainda vale', async () => {
    const alvo = join(dir, 'v.mp4');
    writeFileSync(`${alvo}.err`, '');
    writeFileSync(`${alvo}.log`, 'Render complete');
    let t = 0;
    const dormir = async (ms: number): Promise<void> => {
      t += ms;
      // O render termina logo depois do marcador, como no caso real.
      if (t === 1_000) writeFileSync(alvo, 'x'.repeat(500));
    };
    const r = await esperarArtefato(alvo, {
      timeoutMs: 600_000, estavelMs: 1_000, intervaloMs: 1_000,
      sinal: new AbortController().signal, agoraMs: () => t, dormir,
    });
    expect(r).toBe(alvo);
  });

  it('sem artefato nenhum, o .err ainda falha rápido', async () => {
    const alvo = join(dir, 'w.mp4');
    writeFileSync(`${alvo}.err`, '');
    writeFileSync(`${alvo}.log`, 'estourou a GPU');
    let t = 0;
    const dormir = async (ms: number): Promise<void> => { t += ms; };
    await expect(esperarArtefato(alvo, {
      timeoutMs: 600_000, estavelMs: 1_000, intervaloMs: 1_000,
      sinal: new AbortController().signal, agoraMs: () => t, dormir,
    })).rejects.toThrow(/passo destacado morreu/);
    // Rápido: a carência é curta, não o timeout inteiro de 10 min.
    expect(t).toBeLessThan(10_000);
  });
});

/**
 * Um processo MORTO não escreve `.err`: o marcador vem do `|| touch` do próprio
 * comando, e quem é morto (`systemctl restart` derrubando o cgroup, OOM, kill
 * -9) não chega lá. Sem isto, o serviço esperava o timeout INTEIRO.
 *
 * Custou 108 min de fila parada no A#25/40mais (2026-08-05): eu reiniciei o
 * serviço 2 min depois de o render disparar, e os outros 10 reels ficaram atrás
 * dele — a fila `render` é 1 por vez.
 */
describe('processo destacado morto sem marcador', () => {
  /** Um PID que seguramente não existe. Sobe até achar um livre. */
  function pidMorto(): number {
    for (let p = 4_194_300; p > 4_000_000; p -= 7) {
      try { process.kill(p, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return p;
      }
    }
    throw new Error('não achei pid livre');
  }

  it('processoVivo distingue vivo, morto e desconhecido', () => {
    expect(processoVivo(alvo)).toBeNull();          // sem .pid
    writeFileSync(`${alvo}.pid`, 'nao-e-numero');
    expect(processoVivo(alvo)).toBeNull();          // ilegível: conservador
    writeFileSync(`${alvo}.pid`, String(process.pid));
    expect(processoVivo(alvo)).toBe(true);
    writeFileSync(`${alvo}.pid`, String(pidMorto()));
    expect(processoVivo(alvo)).toBe(false);
  });

  it('não adota render cujo processo já morreu', () => {
    writeFileSync(`${alvo}.log`, 'comecou e morreu');
    writeFileSync(`${alvo}.pid`, String(pidMorto()));
    expect(trabalhoEmCurso(alvo)).toBe(false);
  });

  it('sem .pid legível continua adotando: sem prova de morte, espera', () => {
    writeFileSync(`${alvo}.log`, 'comecou');
    expect(trabalhoEmCurso(alvo)).toBe(true);
  });

  it('a espera falha rápido em vez de consumir o timeout inteiro', async () => {
    writeFileSync(`${alvo}.log`, 'render disparado\nmorreu aqui');
    writeFileSync(`${alvo}.pid`, String(pidMorto()));
    const r = relogio();
    await expect(esperarArtefato(alvo, {
      timeoutMs: 7_200_000, sinal: semSinal, ...r,
    })).rejects.toThrow(/foi MORTO/);
    // Muito antes das 2h: a carência é de segundos, não de horas.
    expect(r.agoraMs()).toBeLessThan(120_000);
  });

  it('processo morto MAS artefato pronto: o artefato vence', async () => {
    writeFileSync(`${alvo}.log`, 'terminou e o bash saiu');
    writeFileSync(`${alvo}.pid`, String(pidMorto()));
    writeFileSync(alvo, 'conteudo do mp4');
    await expect(esperarArtefato(alvo, {
      timeoutMs: 60_000, sinal: semSinal, ...relogio(),
    })).resolves.toBe(alvo);
  });
});
