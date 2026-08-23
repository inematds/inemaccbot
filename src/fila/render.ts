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
import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';

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
  // O `.log` é GUARDADO, não apagado. Ele é a única memória de onde a tentativa
  // anterior parou (`progresso: 6/42`), e apagá-lo aqui matava o número
  // exatamente quando ele mais serve: no `/status` de uma fase que falhou. Foi
  // o MVD#100 em 2026-08-23 — o clipe morreu no shot 6 de 42 por cota da Agnes,
  // a tentativa seguinte limpou o log e o chat passou a não ter número nenhum
  // para mostrar.
  //
  // Um nível só de história: `.log.anterior` é sobrescrito a cada tentativa.
  // Guardar N gerações encheria o disco com o log de renders que ninguém vai
  // ler — o que se quer é "onde parou da última vez".
  try { renameSync(`${alvo}.log`, `${alvo}.log.anterior`); } catch { /* não existia */ }
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
export function trabalhoEmCurso(alvo: string, agoraMs: () => number = Date.now): boolean {
  if (existsSync(alvo)) return true; // pronto: adotar é o certo
  if (!existsSync(`${alvo}.log`) || existsSync(`${alvo}.err`)) return false;
  // Disparado E ainda vivo. O `.log` sozinho não prova vida: o processo pode ter
  // sido morto sem chance de rodar o `|| touch .err` — é o que um
  // `systemctl restart` faz, porque o render é neto do serviço e cai junto com o
  // cgroup. Aconteceu em 2026-08-05 (A#25/40mais): a tentativa seguinte ADOTOU
  // um render morto e ficou 2h esperando, com a fila `render` (1 por vez)
  // parada atrás dela.
  const vivo = processoVivo(alvo);
  if (vivo !== null) return vivo;
  // SEM `.pid` não há veredito pelo processo — e "sem prova de morte" não pode
  // significar esperar 3h. O `.log` é a segunda prova: o domínio escreve nele a
  // cada shot (`progresso: 33/47`), então um log PARADO há muito tempo é um
  // trabalho que não está mais andando.
  //
  // Foi assim que MVD#90 e MVD#91 queimaram 180 min cada um, duas vezes: o
  // `.log` ficou de ontem, sem `.pid`, e a tentativa seguinte ADOTOU o morto e
  // ficou olhando um arquivo que ninguém mais escrevia — com a fila `render`
  // (1 por vez) parada atrás.
  return !logParado(alvo, agoraMs());
}

/** Quanto tempo sem escrever no `.log` já conta como trabalho parado. Folgado
 *  de propósito: a Agnes espera 60s quando a fila dela enche, e um shot leva
 *  minutos — declarar morto quem só está lento custaria a geração já paga. */
export const LOG_PARADO_MS = 20 * 60_000;

export function logParado(alvo: string, agoraMs: number, tetoMs = LOG_PARADO_MS): boolean {
  try {
    return agoraMs - statSync(`${alvo}.log`).mtimeMs > tetoMs;
  } catch {
    return false;   // sem log para medir, não afirmamos morte
  }
}

/**
 * O processo destacado ainda existe?
 *
 * `true` vivo · `false` morto · `null` não dá para saber (sem `.pid`, ilegível,
 * ou de outro dono). O `null` é deliberado e conservador: sem prova de morte,
 * quem chama deve continuar esperando — declarar morto um render vivo custa a
 * GPU e os tokens já gastos.
 */
export function processoVivo(alvo: string): boolean | null {
  let pid: number;
  try {
    pid = Number(readFileSync(`${alvo}.pid`, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);   // sinal 0: só testa existência
    return true;
  } catch (e) {
    // EPERM = existe, de outro dono. Só ESRCH prova que morreu.
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;
  }
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
    // Processo MORTO sem marcador e sem artefato: mesma carência, mesmo destino.
    //
    // O `.err` é escrito pelo `|| touch` do próprio comando, então ele só existe
    // quando o comando teve a chance de terminar. Quem é MORTO — `systemctl
    // restart` derrubando o cgroup, OOM killer, `kill -9` — não escreve nada, e
    // aí o serviço esperava o timeout INTEIRO (120 min), com a fila `render`
    // parada atrás. Foi o A#25/40mais em 2026-08-05: 108 min de espera por um
    // processo morto 2 min depois de disparado.
    //
    // A carência é a mesma do marcador, e pelo mesmo motivo: o `.pid` é do
    // `bash -c`, que pode sair antes do ffmpeg terminar de fechar o arquivo.
    if (prazoDeCarencia === null && processoVivo(alvo) === false && !existsSync(alvo)) {
      prazoDeCarencia = agora() + estavelMs * 2 + intervaloMs;
      log(`processo destacado de ${alvo} não existe mais — carência antes de declarar morto`);
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
      const semMarcador = !existsSync(marcadorErro)
        ? ' — sem marcador de erro: foi MORTO (restart do serviço, OOM ou kill), não falhou sozinho'
        : '';
      throw new RenderFalhou(
        `o passo destacado morreu (ver ${arquivoLog})${semMarcador}${trecho ? `\n${trecho}` : ''}`,
      );
    }

    await dormir(intervaloMs);
  }

  throw new RenderFalhou(`o render não terminou em ${Math.round(opts.timeoutMs / 60_000)} min — alvo ${alvo}`);
}
