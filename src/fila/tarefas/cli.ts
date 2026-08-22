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
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { esperarArtefato, limparMarcadores, trabalhoEmCurso } from '../render.js';
import type { ContextoTarefa } from '../types.js';
import type { Tarefa } from '../worker.js';
import { disparoReal, type Disparo } from './reel.js';

/** Entrada da fase, montada por `entrada-fase.ts`. Nada aqui é adivinhado. */
export interface EntradaCli {
  /** A linha de comando, com os marcadores já resolvidos E aspados. */
  comando: string;
  /** Onde rodar: o repo de domínio. */
  cwd: string;
  /** O recibo: `.txt` que o bot nomeia, onde a saída do comando é gravada. */
  saida: string;
  /** Teto de execução INLINE. Ausente = `PADRAO_TIMEOUT_S`. */
  timeout_segundos?: number;
  /**
   * Declarada no `flow.json`, muda o MODO: o comando vai para segundo plano
   * DESTACADO e a tarefa vigia o recibo aparecer.
   *
   * É o que faz um render longo caber. Inline, o comando morre no teto de 1h e
   * ainda prende uma vaga da fila o tempo todo; destacado, ele sobrevive a um
   * restart do serviço e a tentativa seguinte o ADOTA em vez de disparar um
   * segundo render (a lição do A#25/A#30, ver `fila/render.ts`).
   */
  espera?: { intervalo: number; timeout: number };
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

/**
 * Linhas de PROGRESSO, que não explicam falha nenhuma.
 *
 * O `yt-dlp` e o `ffmpeg` despejam centenas de linhas de barra; a cauda pegava
 * as últimas e o erro real ficava soterrado. No job 4775 o chat disse "o comando
 * falhou: [analisevideo] arquivo grande, comprimindo pra analise..." quando a
 * causa era um `HTTP 503` do Gemini — a mensagem apontava para o lugar errado, e
 * quem lê conclui que o problema é a compressão.
 */
const RUIDO = /^\s*(\[download\]|\[info\]|frame=|size=|progresso:)|ETA\s|\d+% of |\bit\/s\b/i;

/** Uma linha que anuncia erro — é ela que a mensagem de chat quer. */
const PARECE_ERRO = /\b(erro|error|failed|falhou|traceback|exception|recusou|http \d{3}|\d{3}:)\b/i;

/**
 * Últimas linhas ÚTEIS — o que serve numa mensagem de erro de chat.
 *
 * Ordem: tira o ruído; se sobrar alguma que anuncia erro, ela e o que veio
 * depois (o traceback costuma ter a causa na última linha); senão, a cauda do
 * que restou. Nunca devolve vazio se havia texto: uma mensagem ruim é melhor
 * que nenhuma.
 */
function cauda(texto: string, linhas = 4): string {
  const uteis = texto.split('\n').map((l) => l.trimEnd())
    .filter((l) => l.trim() && !RUIDO.test(l));
  const iErro = uteis.findIndex((l) => PARECE_ERRO.test(l));
  const escolhidas = iErro >= 0 ? uteis.slice(iErro, iErro + linhas) : uteis.slice(-linhas);
  const saida = escolhidas.join('\n').slice(0, 800);
  if (saida.trim()) return saida;
  // Só havia ruído: melhor a última linha crua do que silêncio.
  const cru = texto.split('\n').filter((l) => l.trim());
  return cru.slice(-1).join('\n').slice(0, 800);
}

/**
 * O miolo, compartilhado com a rota de SKILL (`criarSkillCli`): recebe a
 * entrada já montada e executa. A diferença entre as duas rotas é só QUEM monta
 * a `EntradaCli` — o `entrada-fase.ts` no fluxo, a própria tarefa na skill.
 */
export async function rodarEntradaCli(
  e: EntradaCli, ctx: ContextoTarefa,
  opts: { disparar: Disparo['disparar']; vigia?: Disparo['vigia'] },
): Promise<string> {
  if (!e.comando?.trim()) throw new Error('sem comando — `comando` não declarado?');
  // `spawn` com cwd inexistente devolve `ENOENT` e nada mais: a mensagem no
  // chat não diria QUAL caminho faltou, nem que o problema era o cwd. Dizer o
  // caminho é a diferença entre "o repo não está clonado nesta máquina" e meia
  // hora de investigação.
  if (e.cwd && !existsSync(e.cwd)) {
    throw new Error(`o repo do domínio não existe nesta máquina: ${e.cwd}`);
  }
  mkdirSync(dirname(e.saida), { recursive: true });
  ctx.log(`[job ${ctx.job.id}] cli.rodar: ${e.comando}`);
  if (e.espera) return destacado(e, ctx, opts.disparar, opts.vigia);
  const saidaTexto = await executar(e, ctx);
  writeFileSync(e.saida, saidaTexto);
  return e.saida;
}

export function criarCliRodar(
  opts: { disparar?: Disparo['disparar']; vigia?: Disparo['vigia'] } = {},
): Tarefa {
  const disparar = opts.disparar ?? disparoReal();
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
    // O recibo é do BOT: ele nomeia o arquivo e grava a saída do comando.
    // Nenhum modelo decide o que vai aqui, que era a origem do `RESULT:`
    // apontando para o artefato do domínio em vez do recibo.
    return rodarEntradaCli(e, ctx, { disparar, vigia: opts.vigia });
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
    proc.on('close', (codigo, sinalDeMorte) => {
      limpar();
      if (codigo === 0) {
        resolve(out.trim() ? out : err);
        return;
      }
      // MORTO POR SINAL não é "código null". Node dá `code: null` quando o
      // processo foi morto, e o sinal vem no segundo argumento — sem ele a
      // mensagem no chat era `o comando saiu com código null:` e nem dizia que
      // alguém o matou. Aconteceu no MVD#90: um `systemctl restart` derrubou a
      // fase de plano no meio, e o chat culpou o domínio.
      if (codigo === null) {
        const ondeVer = e.saida ? ` (saída parcial em ${e.saida}.log, se houver)` : '';
        reject(new Error(
          `o comando foi MORTO por ${sinalDeMorte ?? 'sinal desconhecido'}`
          + ' — restart do serviço, `/cancelar` ou o teto de tempo.'
          + ' Fase longa deve declarar `espera` no flow.json para rodar destacada'
          + `${ondeVer}: ${cauda(err || out)}`,
        ));
        return;
      }
      // A mensagem de erro carrega a CAUDA da saída, não o comando inteiro: é o
      // que o domínio imprimiu ao morrer, e é o que se lê no chat. Sem isto a
      // falha vira "exit 1" e alguém tem que ir ao log do serviço.
      reject(new Error(`o comando saiu com código ${codigo}: ${cauda(err || out)}`));
    });
  });
}

/**
 * O comando LONGO: destacado, vigiado, adotável.
 *
 * O contrato de marcadores é o mesmo do `reel.montar` (`.pid`/`.log`/`.err` ao
 * lado do alvo), e por isso `render.ts` serve aos dois sem saber de nenhum.
 * O recibo é o `.log` copiado no fim — o arquivo APARECER é o sinal de sucesso,
 * que é o que a vigília sabe observar.
 *
 * A vaga da fila fica SEGURA de propósito. Devolver `aindaNao` aqui liberaria o
 * worker, o job seguinte entraria e dispararia o SEU render: foi assim que o
 * A#30/A#31 produziu 24 renders simultâneos e derrubou a máquina. Segurar o job
 * não prende o trabalho a este processo — ele é destacado e sobrevive ao
 * restart, e a tentativa seguinte o adota.
 */
async function destacado(
  e: EntradaCli, ctx: ContextoTarefa, disparar: Disparo['disparar'], vigia?: Disparo['vigia'],
): Promise<string> {
  // Procure ANTES de criar (§2.5): recibo pronto é a resposta.
  if (existsSync(e.saida) && statSync(e.saida).size > 0) return e.saida;

  // Tentativa anterior ENCERRADA com erro: o `.log` tem o motivo, e falhar COM
  // ele vale mais que um erro genérico.
  //
  // ...MENOS quando o motivo foi um SINAL. O `código 143` já tem seção própria
  // no README ("não é erro do agente — é restart"), e aqui ele chegava
  // disfarçado: o `|| touch .err` do embrulho dispara igual quando o SIGTERM do
  // `systemctl restart` mata o comando, e a tentativa seguinte lia esse marcador
  // e falhava com a última linha do log — que era uma mensagem de PROGRESSO
  // ("comprimindo pra análise..."), não um erro. Foi assim que a análise do
  // job 4774 morreu em 2026-08-21: o trabalho foi interrompido, não recusado.
  //
  // Interrompido se REFAZ; recusado FALHA. É o `.rc` que separa os dois.
  if (existsSync(`${e.saida}.err`)) {
    const rc = Number(lerSeDer(`${e.saida}.rc`).trim());
    const interrompido = rc === 143 || rc === 137 || rc === 129;
    const motivo = cauda(lerSeDer(`${e.saida}.log`));
    limparMarcadores(e.saida);
    try { unlinkSync(`${e.saida}.rc`); } catch { /* não existia */ }
    if (!interrompido) throw new Error(`o comando falhou: ${motivo}`);
    ctx.log(`[job ${ctx.job.id}] cli.rodar: tentativa anterior foi INTERROMPIDA (sinal ${rc}) — refazendo`);
  }

  if (!trabalhoEmCurso(e.saida)) {
    if (ctx.agora() - ctx.job.criado_em > e.espera!.timeout) {
      throw new Error(`não ficou pronto em ${Math.round(e.espera!.timeout / 60)} min`);
    }
    limparMarcadores(e.saida);
    // `&&` e não `;`: só o sucesso vira recibo. Sem isso um comando que morre
    // no meio deixaria um recibo parcial, e a fase seguinte leria dele o slug
    // de um trabalho que não terminou.
    // O `.rc` guarda o código de saída REAL — é o que distingue "falhou" de
    // "foi morto". Sem ele, um restart vira falha permanente na retentativa.
    disparar({
      comando: `${e.comando}; c=$?; echo $c > ${aspas(`${e.saida}.rc`)}; `
        + `[ "$c" = 0 ] && cp ${aspas(`${e.saida}.log`)} ${aspas(e.saida)} `
        + `|| touch ${aspas(`${e.saida}.err`)}`,
      saida: e.saida,
    });
    ctx.log(`[job ${ctx.job.id}] cli.rodar: disparado destacado → ${e.saida}`);
  } else {
    ctx.log(`[job ${ctx.job.id}] cli.rodar: adotando o comando em curso`);
  }

  return esperarArtefato(e.saida, {
    timeoutMs: e.espera!.timeout * 1_000,
    intervaloMs: vigia?.intervaloMs ?? e.espera!.intervalo * 1_000,
    sinal: ctx.sinal,
    log: ctx.log,
    ...(vigia?.estavelMs ? { estavelMs: vigia.estavelMs } : {}),
  });
}

function lerSeDer(caminho: string): string {
  try {
    return readFileSync(caminho, 'utf8');
  } catch {
    return '';
  }
}

/** Aspas simples POSIX — os caminhos entram no comando destacado. */
function aspas(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
