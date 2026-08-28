// `reel.montar` — a fase de reel SEM agente.
//
// Por que ela existe: até o A#29 esta fase era `kind: agent`. O agente lia um
// prompt de 86 linhas para (1) extrair `REF` e `público` do NOME do arquivo do
// avatar, (2) escolher um slug de workspace, (3) conferir se o `.md` do público
// existia e (4) montar uma linha de comando. Nada disso é decisão: o bot já
// conhece os quatro dados — foi ele que GEROU o nome do arquivo
// (`entrada-fase.ts:caminhoAvatar`).
//
// O que essa releitura custava, medido em `docs/custo-por-fase-a19-a29.md`:
// ~US$ 0,18 e ~180k de cache_read por reel para produzir ~1k de saída. E três
// defeitos de produção saíram daqui, nenhum do `montar-reel.py`:
//
//  - A#23: o agente usou a skill global e escreveu HTML à mão (`template: None`);
//  - A#25: leu `{canal}` como se fosse o público e procurou `textos/A25/lives2.md`;
//  - A#29: o haiku escreveu um redirecionamento que o portão de permissão
//    recusou, e o job seguinte ficou 1h47 sem produzir nada.
//
// O contrato com o resto do sistema NÃO muda: o pipeline continua indo para
// segundo plano destacado gravando `.pid`/`.log`/`.err`, e quem vigia continua
// sendo `render.ts`. O que sai é o modelo no meio.
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

import { esperarArtefato, limparMarcadores, trabalhoEmCurso } from '../render.js';
import type { ContextoTarefa } from '../types.js';
import type { Tarefa } from '../worker.js';

/** Entrada da fase, montada por `entrada-fase.ts`. Nada aqui é adivinhado. */
export interface EntradaReel {
  /** MP4 do avatar que a fase `baixar` gravou. */
  avatar: string;
  /** Nome do público — vem do `flow_ref`, não de parse de nome de arquivo. */
  alvo: string;
  /** `<repo>/textos/<REF>/<alvo>.md`, o mesmo arquivo que o portão mostrou. */
  textos: string;
  /** Onde o `.mp4` final tem que aparecer. É o que `render.ts` vigia. */
  saida: string;
  /** Workspace de trabalho do pipeline (imagens, cortes, QC). */
  ws: string;
  /** `montar-reel.py` — pode ser o motor de OUTRO repo (um motor, N domínios). */
  script: string;
  /** `flow.json` DO DOMÍNIO do job. Sem ele o `preparar.py` deriva o repo da
   *  pasta-pai do script, e um job do promoavatar3 leria o `flow.json` do
   *  promoavatar — templates e padrão de layout errados. */
  flow?: string;
  /** `<yt-pub-livesN>/imports/videos` — a pasta que o projeto do canal importa.
   *  Ausente quando o público não declara canal. */
  destino?: string;
  /** Clipe de encerramento, quando o domínio declara um por variante. Ausente =
   *  o `montar-reel.py` usa o default dele (o `cta/cta-9x16.mp4` do domínio). */
  cta?: string;
  /** Desliga a legenda do reel. Ausente = vale o default do
   *  `montar-reel.py`, que legenda palavra a palavra (`docs/legenda.md`). */
  semLegenda?: boolean;
  espera?: { intervalo: number; timeout: number };
}

/** Como o processo destacado é disparado. Injetável para o teste não render. */
export interface Disparo {
  disparar: (d: { comando: string; saida: string }) => void;
  /** Ritmo da vigília. Injetável só para o teste não esperar 12s de
   *  estabilidade de arquivo — em produção valem os padrões do `render.ts`. */
  vigia?: { intervaloMs?: number; estavelMs?: number };
}

/**
 * O comando é o MESMO que o prompt do agente mandava montar, com uma diferença
 * que importa: aqui ele é uma f-string, não uma instrução. O `echo $$` vem de
 * DENTRO do `bash -c` (o `$!` de fora pegava o shell encadeado, e o `/cancelar`
 * passava a matar o processo errado), e o `|| touch .err` é o que faz uma
 * reprovação de portão virar falha em segundos em vez de duas horas de espera.
 */
export function montarComando(e: EntradaReel): string {
  const py = [
    'python3', q(e.script),
    '--avatar', q(e.avatar),
    '--ws', q(e.ws),
    '--alvo', e.alvo,
    '--textos', q(e.textos),
    '--saida', q(e.saida),
    ...(e.flow ? ['--flow', q(e.flow)] : []),
    ...(e.cta ? ['--cta', q(e.cta)] : []),
    ...(e.semLegenda ? ['--sem-legenda'] : []),
  ].join(' ');
  return `echo $$ > ${q(`${e.saida}.pid`)}; ${py} || touch ${q(`${e.saida}.err`)}`;
}

/** Aspas simples no estilo POSIX: nenhum caminho vira comando. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function disparoReal(): Disparo['disparar'] {
  return ({ comando, saida }) => {
    // O `.log` é aberto AQUI em vez de virar um `>` dentro do comando: é o
    // mesmo arquivo que o caminho do agente produzia, sem depender de um
    // redirecionamento de shell — que foi exatamente o que o portão de
    // permissão recusou do haiku no A#29.
    const log = openSync(`${saida}.log`, 'w');
    try {
      // `detached` + `unref` de propósito: o render tem que sobreviver ao
      // encerramento do serviço, para a tentativa seguinte ADOTÁ-LO em vez de
      // queimar a GPU duas vezes. É a mesma razão pela qual `render.ts` não
      // mata o processo na perda de lease.
      const filho = spawn('bash', ['-c', comando], {
        detached: true,
        stdio: ['ignore', log, log],
      });
      filho.unref();
    } finally {
      closeSync(log);
    }
  };
}

export function criarReelMontar(opts: Disparo): Tarefa {
  return async (ctx: ContextoTarefa): Promise<string> => {
    if (ctx.sinal.aborted) {
      throw ctx.sinal.reason instanceof Error
        ? ctx.sinal.reason
        : new Error(`reel.montar: abortado (${String(ctx.sinal.reason)})`);
    }
    const e = JSON.parse(ctx.job.input || '{}') as Partial<EntradaReel>;
    if (!e.saida) throw new Error('reel.montar: input precisa de { saida }');
    if (!e.avatar || !e.alvo || !e.textos || !e.ws || !e.script) {
      throw new Error(`reel.montar: input incompleto para "${e.alvo ?? '?'}"`);
    }
    const cheia = e as EntradaReel;

    // Procure ANTES de criar (§2.5): o arquivo pronto é a resposta. Mesmo aí a
    // entrega ao canal é conferida — uma retentativa depois de um restart tem
    // que terminar de entregar, não só reconhecer que o vídeo existe.
    if (existsSync(cheia.saida) && statSync(cheia.saida).size > 0) {
      entregarAoCanal(cheia, ctx);
      return cheia.saida;
    }

    // Tentativa anterior ENCERRADA com erro: o `.log` tem o motivo (portão que
    // reprovou, CUDA sem memória). Falhar COM o motivo vale mais que um erro
    // genérico — e limpar aqui é o que faz a retentativa começar limpa.
    if (existsSync(`${cheia.saida}.err`)) {
      const motivo = ultimasLinhas(`${cheia.saida}.log`);
      limparMarcadores(cheia.saida);
      throw new Error(`reel.montar: o pipeline de "${cheia.alvo}" falhou — ${motivo}`);
    }

    // Já disparado e vivo: ADOTAR — esperar o mesmo render, nunca disparar um
    // segundo na mesma GPU.
    if (trabalhoEmCurso(cheia.saida)) {
      ctx.log(`reel.montar: adotando o render em curso de "${cheia.alvo}"`);
      const adotado = await vigiar(cheia, ctx, opts.vigia);
      entregarAoCanal(cheia, ctx);
      return adotado;
    }

    // O teto conta da PRIMEIRA TENTATIVA (`iniciado_em`, gravado com COALESCE e
    // nunca reescrito), não da criação — o mesmo relógio que o `cli.rodar` e o
    // `heygen.estudio` já usavam; só este ficou para trás.
    //
    // Os 36 reels de um C# nascem no mesmo segundo e a fila `render` é serial
    // (concorrência 1, é a GPU). Medir de `criado_em` faz a ESPERA NA FILA
    // consumir o orçamento do render: quem está do meio para o fim do lote é
    // chamado, vê o prazo já vencido e morre em MILISSEGUNDOS, sem nunca tocar
    // na GPU. C#141 e C#142 em 2026-08-28: 49 reels mortos assim, atrás de
    // clipes de música de 1-2h cada.
    //
    // O que o teto ainda protege continua protegido: o render pendurado. Ele
    // vive dentro de UMA tentativa (o job segura a vaga e vigia), então o
    // relógio da primeira tentativa é o relógio dele.
    const relogio = ctx.job.iniciado_em ?? ctx.job.criado_em;
    if (cheia.espera && ctx.agora() - relogio > cheia.espera.timeout) {
      throw new Error(
        `reel.montar: "${cheia.alvo}" não ficou pronto em ${Math.round(cheia.espera.timeout / 60)} min`,
      );
    }

    // As duas conferências que o prompt pedia ao agente. Aqui elas são um
    // `existsSync`, e falham COM o caminho — que era exatamente o que o agente
    // do A#25 não conseguiu fazer quando procurou `textos/A25/lives2.md`.
    if (!existsSync(cheia.avatar)) {
      throw new Error(`reel.montar: falta o avatar de "${cheia.alvo}": ${cheia.avatar}`);
    }
    if (!existsSync(cheia.textos)) {
      throw new Error(`reel.montar: falta o texto de "${cheia.alvo}": ${cheia.textos}`);
    }

    limparMarcadores(cheia.saida);
    mkdirSync(dirname(cheia.saida), { recursive: true });
    mkdirSync(cheia.ws, { recursive: true });
    const comando = montarComando(cheia);
    opts.disparar({ comando, saida: cheia.saida });
    ctx.log(`reel.montar: ${cheia.alvo} disparado → ${cheia.saida}`);
    // ESPERA SEGURANDO O JOB, e isso não é detalhe: a fila `render` tem
    // concorrência 1 porque é a GPU. Devolver `aindaNao` aqui libera a vaga, o
    // job seguinte entra, dispara O SEU render, e assim por diante — foi
    // exatamente o que aconteceu no A#30/A#31 em 2026-08-06: **24 renders
    // simultâneos**, 49 processos, a máquina no chão. O caminho de agente não
    // tinha esse buraco porque quem esperava era o `aguardarArtefato` do
    // worker, que segurava a vaga.
    //
    // Segurar o job NÃO prende o render a este processo: ele foi disparado
    // destacado, sobrevive a um restart, e a tentativa seguinte o adota pelo
    // `trabalhoEmCurso` acima.
    const pronto = await vigiar(cheia, ctx, opts.vigia);
    entregarAoCanal(cheia, ctx);
    return pronto;
  };
}

/**
 * Copia o reel para a pasta que o projeto do canal importa.
 *
 * Idempotente: se o arquivo já está lá com o mesmo tamanho, não recopia — a
 * fase pode ser reclamada mais de uma vez (poll, restart) e recopiar 26 MB a
 * cada passagem seria desperdício.
 *
 * NÃO derruba o job: o vídeo está pronto e publicado no link do chat; falhar a
 * fase inteira porque o repo do canal sumiu trocaria um problema pequeno
 * (entregar depois, à mão) por um grande (refazer o render).
 */
function entregarAoCanal(e: EntradaReel, ctx: ContextoTarefa): void {
  if (!e.destino) return;
  try {
    const alvo = join(e.destino, basename(e.saida));
    const origem = statSync(e.saida);
    if (existsSync(alvo) && statSync(alvo).size === origem.size) return;
    mkdirSync(e.destino, { recursive: true });
    copyFileSync(e.saida, alvo);
    ctx.log(`reel.montar: ${e.alvo} entregue ao canal → ${alvo}`);
  } catch (erro) {
    ctx.log(`reel.montar: ${e.alvo} NÃO foi entregue ao canal: ${(erro as Error).message}`);
  }
}

/** Espera o `.mp4` aparecer e parar de crescer. Falha no `.err`, no prazo ou
 *  quando o worker larga o job. */
async function vigiar(
  e: EntradaReel, ctx: ContextoTarefa, vigia?: Disparo['vigia'],
): Promise<string> {
  const timeoutMs = (e.espera?.timeout ?? 10_800) * 1_000;
  return await esperarArtefato(e.saida, {
    timeoutMs,
    sinal: ctx.sinal,
    log: (m) => ctx.log(`reel.montar[${e.alvo}] ${m}`),
    ...(vigia?.intervaloMs ? { intervaloMs: vigia.intervaloMs } : {}),
    ...(vigia?.estavelMs ? { estavelMs: vigia.estavelMs } : {}),
  });
}

/** O rabo do `.log`, que é onde o motivo real da falha está. */
function ultimasLinhas(arquivo: string, n = 3): string {
  try {
    const linhas = readFileSync(arquivo, 'utf8').trimEnd().split('\n');
    return linhas.slice(-n).join(' | ').slice(0, 400) || 'sem log';
  } catch {
    return 'sem log';
  }
}
