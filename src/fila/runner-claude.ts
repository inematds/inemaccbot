// Runner do motor `claude`. Único lugar do sistema que conhece a CLI do Claude.
// Trocar de motor = escrever outro arquivo como este e registrá-lo em RUNNERS.
import { spawn } from 'node:child_process';

import { RUNNERS, type ContextoExecucao, type Execucao, type Runner } from './runner.js';

/**
 * Traduz o perfil de execução nas flags da CLI. Função pura de propósito: é o
 * ponto de comparação quando se escreve o runner de outro motor.
 *
 * `modelo` é um ALIAS da CLI (`opus`, `sonnet`, `fable`, `haiku`) — os mesmos
 * nomes que `dominio/perfil.ts` valida. Se um dia for preciso fixar uma versão
 * exata, o mapa alias → id entra AQUI, não no ranking do domínio.
 */
export function argumentosClaude(ctx: ContextoExecucao): string[] {
  return ['--model', ctx.perfil.modelo, '--effort', ctx.perfil.esforco, '-p', ctx.prompt];
}

/**
 * Teto de saída acumulada. Sem isto, `stdout += String(d)` cresce sem limite: um
 * agente que entra em laço de log come a memória do serviço inteiro, e nenhuma
 * das duas pontas (worker, banco) tem defesa própria — o v1 tinha `maxBuffer:
 * 10MB` no `execFile` e aqui isso tinha se perdido.
 *
 * Guardamos o INÍCIO e não o fim porque o contrato `RESULT:`/`ERRO:` é a ÚLTIMA
 * linha… mas quem estoura 4 MB de stdout já quebrou o contrato de qualquer jeito;
 * o que se quer nesse caso é a primeira evidência do que deu errado.
 */
export const LIMITE_SAIDA_BYTES = 4 * 1024 * 1024;

/** Acumulador com teto: para de crescer e registra que truncou. */
class Buffer_ {
  texto = '';
  truncou = false;
  constructor(private readonly limite: number) {}
  add(pedaco: string): void {
    if (this.texto.length >= this.limite) { this.truncou = true; return; }
    const cabe = this.limite - this.texto.length;
    if (pedaco.length > cabe) { this.truncou = true; this.texto += pedaco.slice(0, cabe); }
    else this.texto += pedaco;
  }
}

export interface OpcoesClaudeRunner {
  binario?: string;
  /** Só os testes trocam: permite exercitar timeout e teto com um processo real
   * que não seja o `claude` (que não existe no ambiente de teste). */
  montarArgs?: (ctx: ContextoExecucao) => string[];
  limiteSaidaBytes?: number;
}

export class ClaudeRunner implements Runner {
  nome = 'claude';
  private readonly binario: string;
  private readonly montarArgs: (ctx: ContextoExecucao) => string[];
  private readonly limiteSaida: number;

  constructor(opts: OpcoesClaudeRunner | string = {}) {
    const o = typeof opts === 'string' ? { binario: opts } : opts;
    this.binario = o.binario ?? 'claude';
    this.montarArgs = o.montarArgs ?? argumentosClaude;
    this.limiteSaida = o.limiteSaidaBytes ?? LIMITE_SAIDA_BYTES;
  }

  iniciar(ctx: ContextoExecucao): Execucao {
    // `detached: true` cria um process group próprio: cancelar mata a ÁRVORE
    // (o agente abre subprocessos), não só o pai. Nunca `shell: true`.
    const filho = spawn(this.binario, this.montarArgs(ctx), {
      cwd: ctx.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...ctx.vars },
    });

    let cancelado = false;
    let expirou = false;
    const stdout = new Buffer_(this.limiteSaida);
    const stderr = new Buffer_(this.limiteSaida);
    // Resolvida pelo MESMO handler de `close` que já existe — nada de um segundo
    // listener, que vazaria se ninguém cancelasse.
    let marcarFechado: () => void;
    const fechado = new Promise<void>((r) => { marcarFechado = r; });
    filho.stdout?.on('data', (d) => stdout.add(String(d)));
    filho.stderr?.on('data', (d) => stderr.add(String(d)));

    const matarArvore = (sinal: NodeJS.Signals): void => {
      if (filho.pid === undefined) return;
      try { process.kill(-filho.pid, sinal); } catch { /* já morreu */ }
    };

    /**
     * Timeout de PAREDE. Sem ele, um `claude -p` travado (rede pendurada, espera
     * por input que nunca vem) segura um slot da fila para sempre: o heartbeat
     * do worker renova o lease indefinidamente, o job nunca termina e nada é
     * notificado — o modo de falha silenciosa que a spec §8 proíbe.
     */
    let relogioTimeout: NodeJS.Timeout | undefined;
    const timeoutMs = ctx.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      relogioTimeout = setTimeout(() => {
        expirou = true;
        matarArvore('SIGKILL'); // já passou do prazo: não há por que negociar
      }, timeoutMs);
      // Não segura o event loop no desligamento — o timer só existe enquanto o
      // processo filho existe.
      relogioTimeout.unref?.();
    }

    const promessa = new Promise<string>((resolve, reject) => {
      filho.on('error', (e) => { clearTimeout(relogioTimeout); reject(e); });
      filho.on('close', (code) => {
        clearTimeout(relogioTimeout);
        marcarFechado();
        if (expirou) {
          return reject(new Error(`${this.binario}: timeout de ${Math.round((timeoutMs ?? 0) / 1000)}s — execução encerrada`));
        }
        if (cancelado) return reject(new Error('execução cancelada'));
        if (code === 0) return resolve(stdout.texto.trim());
        const cauda = stderr.texto.trim().slice(0, 500);
        reject(new Error(`${this.binario} saiu com código ${code}: ${cauda}`));
      });
    });
    // Marca a promessa como observada desde o nascimento: ela pode rejeitar (via `close`)
    // antes de o chamador chamar `aguardar()`, e sem isto o Node emite
    // PromiseRejectionHandledWarning. `aguardar()` continua devolvendo a promessa
    // original, então quem espera ainda recebe a rejeição normalmente.
    promessa.catch(() => {});

    return {
      aguardar: () => promessa,
      cancelar: async () => {
        cancelado = true;
        clearTimeout(relogioTimeout);
        matarArvore('SIGTERM');
        // Corrida contra a saída do filho: o processo bem-comportado morre no
        // SIGTERM em milissegundos. Esperar os 2s cheios em TODO cancelamento
        // custaria isso por job em `/cancelar` e no timeout do drain.
        let relogio: NodeJS.Timeout | undefined;
        const prazo = new Promise<'prazo'>((r) => {
          relogio = setTimeout(() => r('prazo'), 2_000);
        });
        const quem = await Promise.race([fechado.then(() => 'fechou' as const), prazo]);
        clearTimeout(relogio);
        if (quem === 'prazo') matarArvore('SIGKILL');
      },
      limpar: async () => { /* o runner do Claude não deixa parciais próprios */ },
    };
  }
}

RUNNERS.claude = new ClaudeRunner();
