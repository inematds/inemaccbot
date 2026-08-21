// `cli.rodar` — a fase que roda o CLI do domínio SEM agente.
//
// A terceira fase a perder o modelo do meio, e pelo mesmo motivo das outras
// duas (`reel.montar`, `heygen.estudio`): não havia decisão ali. No musicavideo,
// a fase `plano` gastava um agente para ler 40 linhas de prompt, extrair um
// slug, montar UMA linha de comando e copiar um caminho para um `.txt`. O
// trabalho de pensar acontecia DENTRO do comando — o CLI do domínio chama o
// Fable por conta própria. Era um LLM orquestrando um script que orquestra
// outro LLM.
//
// O que isso custou em produção, em 2026-08-20/21, na primeira execução real do
// domínio (MVD#87 a #89):
//
//  - o prompt mandava rodar `musicavideo <sub>`, binário que não existe no
//    PATH — quem escreveu o prompt foi um modelo adivinhando como o domínio
//    funciona;
//  - o mesmo prompt redefinia `{{saida}}` como "o caminho do PLANO.md",
//    quebrando o contrato do artefato: o job falhava DEPOIS de o trabalho estar
//    feito e pago;
//  - num render de 43 shots, a ferramenta do agente cortou em 10 minutos, ele
//    destacou o processo (que o prompt proíbe, em negrito) e o job matou a
//    árvore ao terminar. Duas vezes.
//
// Nenhum desses três é consertável escrevendo prosa melhor. Todos somem quando
// o comando é DECLARADO no `flow.json` e quem o executa é o bot.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ContextoTarefa } from '../types.js';
import type { Tarefa } from '../worker.js';

/** Entrada da fase, montada por `entrada-fase.ts`. Nada aqui é adivinhado. */
export interface EntradaCli {
  /** A linha de comando, com os marcadores já resolvidos E aspados. */
  comando: string;
  /** Onde rodar: o repo de domínio. */
  cwd: string;
  /** O recibo: `.txt` que o bot nomeia, onde a saída do comando é gravada. */
  saida: string;
  /** Teto de execução. Ausente = `PADRAO_TIMEOUT_S`. */
  timeout_segundos?: number;
}

/** Uma hora — o mesmo teto das fases de agente (`fila/skills.ts`). Render longo
 *  não deve viver aqui: para isso existe `espera`, o poll que as fases
 *  `heygen.*` já usam. */
const PADRAO_TIMEOUT_S = 60 * 60;

/** A razão do abort, com a palavra: quem lê o `/status` precisa distinguir
 *  "o serviço encerrou" de "o comando do domínio falhou". */
function erroDeAbort(sinal: AbortSignal): Error {
  const razao = sinal.reason instanceof Error ? sinal.reason.message : String(sinal.reason ?? '');
  return new Error(`abortado pelo worker${razao ? `: ${razao}` : ''}`);
}

/** Últimas linhas não vazias — o que serve numa mensagem de erro de chat. */
function cauda(texto: string, linhas = 4): string {
  return texto.split('\n').filter((l) => l.trim()).slice(-linhas).join('\n').slice(0, 800);
}

export function criarCliRodar(): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    // O sinal ANTES de qualquer coisa: worker encerrando não deve gastar um
    // spawn, e a falha tem que dizer que foi abort — senão ela se confunde com
    // erro do domínio no `/status`.
    if (ctx.sinal.aborted) throw erroDeAbort(ctx.sinal);

    let e: EntradaCli;
    try {
      e = JSON.parse(ctx.job.input) as EntradaCli;
    } catch {
      throw new Error('input da fase não é JSON');
    }
    if (!e.comando?.trim()) throw new Error('fase sem comando — flow.json declarou "cli.rodar" sem `comando`?');

    ctx.log(`[job ${ctx.job.id}] cli.rodar: ${e.comando}`);
    const saidaTexto = await executar(e, ctx);

    // O recibo é do BOT: ele nomeia o arquivo e grava a saída do comando.
    // Nenhum modelo decide o que vai aqui, que era a origem do `RESULT:`
    // apontando para o artefato do domínio em vez do recibo.
    mkdirSync(dirname(e.saida), { recursive: true });
    writeFileSync(e.saida, saidaTexto);
    return e.saida;
  };
}

function executar(e: EntradaCli, ctx: ContextoTarefa): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // `bash -c` e não `shell: true`: a linha já vem aspada de `entrada-fase.ts`,
    // e um shell nomeado é o mesmo em qualquer máquina.
    const proc = spawn('bash', ['-c', e.comando], {
      cwd: e.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    const teto = (e.timeout_segundos ?? PADRAO_TIMEOUT_S) * 1_000;
    const relogio = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`o comando estourou ${Math.round(teto / 1000)}s e foi morto`));
    }, teto);

    // §9: tarefa `function` PRECISA repassar o sinal. Sem isto o serviço sai e o
    // filho é reparentado ao init, escrevendo a saída de um job que o banco já
    // marcou como falho — e concorrendo com a próxima instância.
    const abortar = (): void => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5_000).unref();
      // Rejeita NA HORA, sem esperar o `close`: o worker precisa da vaga de
      // volta, e o `código 143` que viria depois mentiria sobre a causa — foi
      // ele que já apareceu no chat como se fosse falha do domínio.
      limpar();
      reject(erroDeAbort(ctx.sinal));
    };
    ctx.sinal.addEventListener('abort', abortar, { once: true });

    const limpar = (): void => {
      clearTimeout(relogio);
      ctx.sinal.removeEventListener('abort', abortar);
    };

    proc.on('error', (erro) => { limpar(); reject(erro); });
    proc.on('close', (codigo) => {
      limpar();
      if (codigo === 0) {
        resolve(out.trim() ? out : err);
        return;
      }
      // A mensagem de erro carrega a CAUDA da saída, não o comando inteiro: é o
      // que o domínio imprimiu ao morrer, e é o que se lê no chat. Sem isto a
      // falha vira "exit 1" e alguém tem que ir ao log do serviço.
      reject(new Error(`o comando saiu com código ${codigo}: ${cauda(err || out)}`));
    });
  });
}
