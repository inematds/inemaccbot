// Espera por um artefato produzido por trabalho DESTACADO.
//
// Por que existe (plano da etapa 3, §1): um render leva de 15 min a 2h. Se o
// agente segurasse a sessão inteira, um `systemctl restart` mataria o trabalho —
// o dreno aborta o que sobra depois de 110s, e junto vão a GPU e os tokens já
// gastos. Então o agente faz o setup, dispara SÓ o render final destacado
// (`nohup … || touch "<alvo>.err"`), declara `RENDER: <alvo>` e sai; quem espera
// é isto aqui.
//
// Portado do `waitForFile` do `mkivideos`, incluindo as duas lições que ele
// pagou em produção:
//
//  1. **marcador `.err`** — sem ele, um passo que morre 10 segundos depois de
//     disparado deixa o serviço esperando o timeout INTEIRO (o comentário lá
//     nomeia o caso real: um `transcrever_v1.py` que crashava logo no início).
//  2. **estabilidade de tamanho** — arquivo que existe não é arquivo pronto: o
//     ffmpeg cria o `.mp4` no primeiro frame e escreve nele por 40 minutos.
//
// O que NÃO foi portado é a passividade do v1: aqui quem espera detém um lease,
// renovado pelo heartbeat do worker, e obedece ao `sinal` (encerramento do
// serviço ou lease perdido).
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';

/** Encerra o trabalho destacado a partir do `.pid` que o prompt gravou.
 * Usado SÓ no `/cancelar`: no desligamento e na perda de lease o processo tem
 * que continuar vivo de propósito, para a próxima tentativa adotá-lo. */
export async function encerrarTrabalhoDestacado(alvo: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number(readFileSync(`${alvo}.pid`, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1) return false;
  // Mata o GRUPO: o render abre filhos (chrome, ffmpeg), e matar só o pai
  // deixaria a GPU ocupada do mesmo jeito.
  for (const sinal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(-pid, sinal); } catch { /* já morreu */ }
  }
  return true;
}

export interface OpcoesEspera {
  /** Teto absoluto. Estourou, o job falha — é o backstop do "vivo mas pendurado". */
  timeoutMs: number;
  /** Quanto tempo o tamanho precisa ficar parado para o arquivo contar como pronto. */
  estavelMs?: number;
  intervaloMs?: number;
  sinal: AbortSignal;
  log?: (m: string) => void;
  /** Injetáveis para o teste não depender de relógio real. */
  agoraMs?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

export class RenderFalhou extends Error {}

const ESTAVEL_PADRAO_MS = 12_000;
const INTERVALO_PADRAO_MS = 5_000;

/**
 * Apaga os marcadores de uma tentativa ANTERIOR. Chamado por quem está prestes a
 * DISPARAR trabalho novo — nunca por quem só vai vigiar.
 *
 * O lugar importa e custou um teste vermelho para aparecer: o v1 limpava o
 * `.err` ao COMEÇAR A VIGIAR, e isso abre uma corrida real — o passo destacado
 * que morre depressa (o caso que o marcador existe para pegar) cria o `.err`
 * ANTES da vigília começar, e a limpeza apagava justamente a prova, deixando o
 * serviço esperando as duas horas inteiras. Limpando na hora de disparar,
 * qualquer marcador visto durante a vigília é verdadeiro.
 */
export function limparMarcadores(alvo: string): void {
  for (const f of [`${alvo}.err`, `${alvo}.log`, `${alvo}.pid`]) {
    try { unlinkSync(f); } catch { /* não existia */ }
  }
}

/**
 * O trabalho está EM CURSO (ou já terminou bem) — a tentativa seguinte deve
 * adotá-lo em vez de disparar um segundo render na mesma GPU.
 *
 * Note o `!existsSync(err)`: "foi disparado alguma vez" NÃO é a pergunta certa.
 * Se o passo destacado morreu, ele deixou `.log` E `.err`; adotar aí faria a
 * retentativa ler o marcador velho e falhar na hora — ou seja, o
 * `max_tentativas: 2` não compraria nada exatamente no caso para o qual existe
 * (CUDA sem memória, yt-dlp instável). Marcador de erro presente significa
 * tentativa anterior ENCERRADA: limpa e dispara de novo.
 */
export function trabalhoEmCurso(alvo: string): boolean {
  if (existsSync(alvo)) return true; // pronto: adotar é o certo
  return existsSync(`${alvo}.log`) && !existsSync(`${alvo}.err`);
}

/**
 * Espera `alvo` aparecer e parar de crescer. Resolve com o caminho; lança
 * `RenderFalhou` no marcador de erro, no timeout ou no abort.
 */
export async function esperarArtefato(alvo: string, opts: OpcoesEspera): Promise<string> {
  const estavelMs = opts.estavelMs ?? ESTAVEL_PADRAO_MS;
  const intervaloMs = opts.intervaloMs ?? INTERVALO_PADRAO_MS;
  const agora = opts.agoraMs ?? ((): number => Date.now());
  const dormir = opts.dormir ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const log = opts.log ?? ((): void => {});
  const marcadorErro = `${alvo}.err`;
  const arquivoLog = `${alvo}.log`;

  const prazo = agora() + opts.timeoutMs;
  let ultimoTamanho = -1;
  let paradoDesde = 0;
  /** Ajustado quando o `.err` aparece; até lá, `null` = sem veredito. */
  let prazoDeCarencia: number | null = null;

  while (agora() < prazo) {
    if (opts.sinal.aborted) {
      // Não é falha do render: o processo destacado segue vivo e a próxima
      // tentativa vai adotá-lo. Dizer isso no erro evita o operador procurar
      // defeito onde houve só um desligamento.
      throw new RenderFalhou('espera abortada (serviço encerrando ou lease perdido) — o render destacado continua');
    }

    // O marcador de erro NÃO é veredito final enquanto o artefato pode aparecer.
    //
    // Aconteceu em produção (A#8/criadores): o `.err` foi criado 02:23, o MP4
    // terminou 02:24 — o log dizia "Render complete", o arquivo tinha 50 MB, e
    // o job foi declarado morto assim mesmo. Um passo interno devolveu código
    // não-zero e o `|| touch .err` disparou, mas o render seguiu e completou.
    //
    // Então: visto o marcador, dá-se uma CARÊNCIA curta para o artefato
    // aparecer e estabilizar. Se aparecer, ele é a verdade — arquivo pronto e
    // validado vale mais que um marcador de saída. Se não aparecer, falha
    // rápido, que é o motivo de o marcador existir.
    if (existsSync(marcadorErro) && prazoDeCarencia === null) {
      prazoDeCarencia = agora() + estavelMs * 2 + intervaloMs;
      log(`marcador de erro visto em ${alvo} — dando carência até o artefato estabilizar`);
    }
    let tamanho = -1;
    try { tamanho = statSync(alvo).size; } catch { tamanho = -1; }
    if (tamanho > 0) {
      if (tamanho === ultimoTamanho) {
        if (paradoDesde === 0) paradoDesde = agora();
        if (agora() - paradoDesde >= estavelMs) {
          log(`render pronto: ${alvo} (${tamanho} bytes)`);
          return alvo;
        }
      } else {
        ultimoTamanho = tamanho;
        paradoDesde = 0;
        // Cresceu = está vivo. Um marcador visto antes não pode matar um render
        // que ainda está escrevendo.
        if (prazoDeCarencia !== null) prazoDeCarencia = agora() + estavelMs * 2 + intervaloMs;
      }
    }
    if (prazoDeCarencia !== null && agora() >= prazoDeCarencia) {
      let trecho = '';
      try { trecho = readFileSync(arquivoLog, 'utf8').slice(-2_000); } catch { /* sem log */ }
      throw new RenderFalhou(`o passo destacado morreu (ver ${arquivoLog})${trecho ? `\n${trecho}` : ''}`);
    }

    await dormir(intervaloMs);
  }

  throw new RenderFalhou(`o render não terminou em ${Math.round(opts.timeoutMs / 60_000)} min — alvo ${alvo}`);
}
