// `cli.rodar` — o que ela precisa garantir para substituir um agente.
//
// Cada teste aqui corresponde a uma falha real do MVD#87..#89 (2026-08-21), de
// quando estas fases eram `kind: agent` e o comando era prosa num prompt.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarCliRodar } from './cli.js';
import type { ContextoTarefa } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inemaccbot-cli-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(
  entrada: unknown,
  opts: { sinal?: AbortSignal; agora?: number; max_tentativas?: number } = {},
): ContextoTarefa {
  return {
    // `iniciado_em` e `agora` importam no modo destacado: deles sai o prazo do
    // "não ficou pronto em N min", que é o ORÇAMENTO do job inteiro
    // (`espera.timeout × max_tentativas`), não o prazo de uma tentativa.
    job: {
      id: 7,
      input: JSON.stringify(entrada),
      criado_em: 1_000,
      iniciado_em: 1_000,
      max_tentativas: opts.max_tentativas ?? 2,
    },
    agora: () => opts.agora ?? 1_000,
    log: () => {},
    sinal: opts.sinal ?? new AbortController().signal,
  } as unknown as ContextoTarefa;
}

describe('cli.rodar', () => {
  it('roda o comando e devolve o RECIBO que o BOT nomeou', async () => {
    const saida = join(dir, 'recibo.txt');
    const r = await criarCliRodar()(ctx({
      comando: 'echo "plano: /out/PLANO.md"', cwd: dir, saida,
    }));
    // O contrato do artefato é do bot: a tarefa devolve o caminho que o bot
    // escolheu, não um que o domínio imprimiu. Era exatamente aqui que o agente
    // errava, respondendo `RESULT: <PLANO.md>` e falhando com o trabalho pronto.
    expect(r).toBe(saida);
    expect(readFileSync(saida, 'utf8')).toContain('plano: /out/PLANO.md');
  });

  // A CAUSA, não a última linha. O yt-dlp e o ffmpeg despejam centenas de
  // linhas de barra de progresso, e a cauda crua pegava justamente elas: no job
  // 4775 o chat disse "falhou: comprimindo pra analise..." quando a causa era um
  // HTTP 503 do Gemini (2026-08-22).
  it('a mensagem de falha pula o progresso e pega o erro', async () => {
    writeFileSync(join(dir, 'ruidoso.sh'), [
      '#!/bin/bash',
      'echo "[download]   0.0% of 21.86MiB at 142.86KiB/s ETA 02:36"',
      'echo "[download] 100% of 21.86MiB"',
      'echo "{\\"erro\\": \\"HTTPError: HTTP Error 503: Service Unavailable\\"}"',
      'echo "[analisevideo] comprimindo pra analise..."',
      'exit 1',
    ].join('\n'));
    await expect(criarCliRodar()(ctx({
      comando: `bash ${join(dir, 'ruidoso.sh')}`, cwd: dir, saida: join(dir, 'r.txt'),
    }))).rejects.toThrow(/503/);
  });

  // Se só havia ruído, ainda assim diz alguma coisa: mensagem ruim é melhor que
  // silêncio.
  it('saída só com progresso não vira mensagem vazia', async () => {
    writeFileSync(join(dir, 'so-ruido.sh'),
      '#!/bin/bash\necho "[download] 50% of 10MiB ETA 00:10"\nexit 2\n');
    await expect(criarCliRodar()(ctx({
      comando: `bash ${join(dir, 'so-ruido.sh')}`, cwd: dir, saida: join(dir, 'r.txt'),
    }))).rejects.toThrow(/download/);
  });

  it('exit != 0 é falha, com a CAUDA da saída na mensagem', async () => {
    await expect(criarCliRodar()(ctx({
      comando: 'echo "linha boba"; echo "erro: slug já existe" >&2; exit 3',
      cwd: dir, saida: join(dir, 'r.txt'),
    }))).rejects.toThrow(/código 3.*slug já existe/s);
  });

  // O cwd é o repo de DOMÍNIO — o mesmo das fases de agente. Sem isto o script
  // roda de onde o serviço subiu, e caminhos relativos do domínio quebram.
  it('roda no cwd declarado', async () => {
    const saida = join(dir, 'r.txt');
    await criarCliRodar()(ctx({ comando: 'pwd', cwd: dir, saida }));
    expect(readFileSync(saida, 'utf8').trim()).toContain(dir.replace('/private', ''));
  });

  it('sem comando, falha dizendo o que falta no flow.json', async () => {
    await expect(criarCliRodar()(ctx({ comando: '  ', cwd: dir, saida: join(dir, 'r.txt') })))
      .rejects.toThrow(/sem comando/);
  });

  // §9: tarefa function repassa o sinal. E a mensagem tem que dizer ABORT —
  // senão o `/status` mostra encerramento de serviço como falha do domínio.
  it('abortado antes de começar: nem gasta um spawn', async () => {
    await expect(criarCliRodar()(ctx(
      { comando: 'echo nao-deveria', cwd: dir, saida: join(dir, 'r.txt') },
      { sinal: AbortSignal.abort(new Error('serviço encerrando')) },
    ))).rejects.toThrow(/abortado pelo worker/i);
  });

  it('abortado NO MEIO: para rápido e diz que foi abort', async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const p = criarCliRodar()(ctx(
      { comando: 'sleep 30', cwd: dir, saida: join(dir, 'r.txt') }, { sinal: ctrl.signal },
    ));
    setTimeout(() => ctrl.abort(new Error('serviço encerrando')), 20);
    await expect(p).rejects.toThrow(/abortado pelo worker/i);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  // MODO DESTACADO (`espera` no flow.json): é o que faz render longo caber.
  // Inline, o clipe de 43 shots morre no teto e ainda prende a vaga o tempo
  // todo; destacado, ele sobrevive ao restart e a tentativa seguinte o adota.
  describe('com `espera`: destacado e vigiado', () => {
    function ctxEspera(
      over: Record<string, unknown> = {},
      opts: { agora?: number; max_tentativas?: number } = {},
    ) {
      return ctx({
        comando: 'echo pronto', cwd: dir, saida: join(dir, 'recibo.txt'),
        espera: { intervalo: 1, timeout: 60 }, ...over,
      }, opts);
    }

    it('recibo JÁ pronto é a resposta — não dispara de novo', async () => {
      const saida = join(dir, 'recibo.txt');
      writeFileSync(saida, 'slug: x\n');
      let disparos = 0;
      const r = await criarCliRodar({ disparar: () => { disparos += 1; } })(ctxEspera());
      expect(r).toBe(saida);
      expect(disparos).toBe(0);
    });

    it('marcador .err da tentativa anterior falha COM o motivo', async () => {
      const saida = join(dir, 'recibo.txt');
      writeFileSync(`${saida}.err`, '');
      writeFileSync(`${saida}.log`, 'shot 9: agnes recusou\n');
      await expect(criarCliRodar({ disparar: () => {} })(ctxEspera()))
        .rejects.toThrow(/agnes recusou/);
      // E limpa: a retentativa começa do zero, não lê o marcador velho.
      expect(existsSync(`${saida}.err`)).toBe(false);
    });

    // `código 143` já tem seção própria no README ("não é erro do agente — é
    // restart") e chegava aqui disfarçado: o `|| touch .err` dispara igual
    // quando o SIGTERM mata o comando, e a tentativa seguinte falhava citando a
    // última linha do log — que era uma mensagem de PROGRESSO. Foi assim que a
    // análise do job 4774 morreu (2026-08-21): interrompida, não recusada.
    it('interrompido por SINAL é REFEITO, não falha', async () => {
      const saida = join(dir, 'recibo.txt');
      writeFileSync(`${saida}.err`, '');
      writeFileSync(`${saida}.rc`, '143\n');
      writeFileSync(`${saida}.log`, '[analisevideo] comprimindo pra analise...\n');
      let disparos = 0;
      const p = criarCliRodar({
        vigia: { intervaloMs: 5, estavelMs: 5 },
        disparar: () => { disparos += 1; writeFileSync(saida, 'slug: x\n'); },
      })(ctxEspera());
      await expect(p).resolves.toBe(saida);
      expect(disparos, 'devia ter refeito').toBe(1);
    });

    it('falha de verdade (exit != 0) continua falhando com o motivo', async () => {
      const saida = join(dir, 'recibo.txt');
      writeFileSync(`${saida}.err`, '');
      writeFileSync(`${saida}.rc`, '1\n');
      writeFileSync(`${saida}.log`, 'yt-dlp: vídeo privado\n');
      await expect(criarCliRodar({ disparar: () => {} })(ctxEspera()))
        .rejects.toThrow(/vídeo privado/);
    });

    it('dispara com o comando embrulhado: só o sucesso vira recibo', async () => {
      const saida = join(dir, 'recibo.txt');
      let comando = '';
      const p = criarCliRodar({
        vigia: { intervaloMs: 5, estavelMs: 5 },
        disparar: (d) => {
          comando = d.comando;
          // simula o destacado terminando bem
          writeFileSync(`${saida}.log`, 'slug: x\n');
          writeFileSync(saida, 'slug: x\n');
        },
      })(ctxEspera());
      await expect(p).resolves.toBe(saida);
      expect(comando).toContain('echo pronto;');
      // O `.rc` guarda o código de saída real: é o que distingue "falhou" de
      // "foi morto por um restart" na tentativa seguinte.
      expect(comando).toContain(`echo $c > '${saida}.rc'`);
      expect(comando).toContain(`cp '${saida}.log' '${saida}'`);
      expect(comando).toContain(`|| touch '${saida}.err'`);
    });

    // As três falhas do 2026-08-22 (jobs 5121/5122), uma por teste.
    //
    // 1. O PRAZO é do job, não da tentativa. A vigília da tentativa 1 gasta o
    //    `espera.timeout` inteiro; se o guard medir contra esse mesmo número, a
    //    tentativa 2 nasce vencida e falha em segundos sem disparar nada.
    it('tentativa 2 ainda DISPARA: o prazo é o orçamento do job', async () => {
      const saida = join(dir, 'recibo.txt');
      let disparos = 0;
      // 61s depois do início: a tentativa 1 já queimou os 60s de vigília dela.
      const p = criarCliRodar({
        vigia: { intervaloMs: 5, estavelMs: 5 },
        disparar: () => { disparos += 1; writeFileSync(saida, 'slug: x\n'); },
      })(ctxEspera({}, { agora: 1_061, max_tentativas: 2 }));
      await expect(p).resolves.toBe(saida);
      expect(disparos, 'tentativa 2 tem prazo próprio').toBe(1);
    });

    it('gasto o orçamento INTEIRO (2× o prazo), aí sim falha', async () => {
      await expect(criarCliRodar({ disparar: () => {} })(
        ctxEspera({}, { agora: 1_121, max_tentativas: 2 }),
      )).rejects.toThrow(/não ficou pronto em 2 min/);
    });

    // 2. Sem `.pid` não há prova de vida: `trabalhoEmCurso` cai no log parado e
    //    declara morto um trabalho que só está calado. Foi o que matou o 5121,
    //    que terminou BEM 50 min depois de o bot desistir dele.
    it('o comando destacado grava o `.pid` — prova de vida da adoção', async () => {
      const saida = join(dir, 'recibo.txt');
      let comando = '';
      const p = criarCliRodar({
        vigia: { intervaloMs: 5, estavelMs: 5 },
        disparar: (d) => {
          comando = d.comando;
          writeFileSync(`${saida}.log`, 'slug: x\n');
          writeFileSync(saida, 'slug: x\n');
        },
      })(ctxEspera());
      await expect(p).resolves.toBe(saida);
      expect(comando.startsWith(`echo $$ > '${saida}.pid'`)).toBe(true);
    });

    it('processo VIVO é adotado, não re-disparado', async () => {
      const saida = join(dir, 'recibo.txt');
      // Log velho (parado há muito) + `.pid` de um processo vivo: quem manda é
      // o processo. Este teste é o 5121 ao contrário.
      writeFileSync(`${saida}.log`, '[analisevideo] analisando com Gemini...\n');
      writeFileSync(`${saida}.pid`, `${process.pid}\n`);
      let disparos = 0;
      const p = criarCliRodar({
        vigia: { intervaloMs: 5, estavelMs: 5 },
        disparar: () => { disparos += 1; },
      })(ctxEspera());
      setTimeout(() => writeFileSync(saida, 'slug: x\n'), 20);
      await expect(p).resolves.toBe(saida);
      expect(disparos, 'havia um vivo — adotar').toBe(0);
    });

    // 3. Recibo que chegou depois da desistência: trabalho feito e pago. Vale
    //    mais que o prazo.
    it('recibo pronto vence o prazo vencido', async () => {
      const saida = join(dir, 'recibo.txt');
      writeFileSync(saida, 'slug: x\n');
      const r = await criarCliRodar({ disparar: () => {} })(
        ctxEspera({}, { agora: 9_999, max_tentativas: 2 }),
      );
      expect(r).toBe(saida);
    });
  });

  it('teto de tempo mata o comando em vez de segurar a vaga da fila', async () => {
    await expect(criarCliRodar()(ctx({
      comando: 'sleep 30', cwd: dir, saida: join(dir, 'r.txt'), timeout_segundos: 1,
    }))).rejects.toThrow(/estourou 1s/);
  });
});
