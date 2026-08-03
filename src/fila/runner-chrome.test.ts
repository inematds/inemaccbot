// O reset do `:99` é a peça que decide se a fase de navegador digita ou não
// digita — e falha de um jeito que PARECE saudável (job roda, não digita nada,
// reporta 0 vídeos). Por isso ele é testado pelo comportamento observável:
// a ordem das chamadas e o que acontece quando a máquina não tem `stack99`.
import { describe, expect, it } from 'vitest';
import { CHECK_STACK99, SERVICO_STACK99, resetarStack99 } from './runner-chrome.js';

/** Um `executar` de mentira que registra o que foi chamado e pode falhar. */
function espiao(falharEm: (cmd: string, args: string[]) => boolean = () => false) {
  const chamadas: string[][] = [];
  const logs: string[] = [];
  let relogio = 0;
  const deps = {
    executar: (cmd: string, args: string[]): void => {
      chamadas.push([cmd, ...args]);
      if (falharEm(cmd, args)) throw new Error('falhou de propósito');
    },
    agora: (): number => relogio,
    // Dormir AVANÇA o relógio: sem isto o laço de espera nunca chegaria ao
    // orçamento e o teste penduraria em vez de falhar.
    dormir: (ms: number): void => { relogio += Math.max(ms, 1); },
    log: (t: string): void => { logs.push(t); },
  };
  return { chamadas, logs, deps };
}

describe('resetarStack99', () => {
  it('reinicia o serviço e SÓ termina quando o check passa', () => {
    const { chamadas, logs, deps } = espiao();
    resetarStack99(deps);
    expect(chamadas[0]).toEqual(['systemctl', '--user', 'restart', SERVICO_STACK99]);
    expect(chamadas[1]).toEqual(['bash', CHECK_STACK99]);
    expect(logs.join(' ')).toMatch(/mapeada/i);
  });

  // O erro que este teste existe para pegar: dar o reset por concluído com o
  // serviço de pé mas a janela ainda não pintada. `systemctl restart` volta
  // quando o SERVIÇO subiu, não quando o Chromium está utilizável — soltar o
  // agente aí é voltar ao `hidden` que o reset deveria ter matado.
  it('insiste no check enquanto ele falha, e desiste no orçamento', () => {
    const { chamadas, logs, deps } = espiao((cmd) => cmd === 'bash');
    resetarStack99(deps);
    const checks = chamadas.filter(([cmd]) => cmd === 'bash');
    expect(checks.length).toBeGreaterThan(1);
    expect(logs.join(' ')).toMatch(/não ficou mapeada/i);
  });

  // Best-effort é uma AFIRMAÇÃO do comentário do módulo; sem este teste ela era
  // só uma intenção. Se propagar, todo job do runner chrome morre em dev/CI.
  it('máquina sem stack99: não propaga, e nem tenta o check', () => {
    const { chamadas, logs, deps } = espiao((cmd) => cmd === 'systemctl');
    expect(() => resetarStack99(deps)).not.toThrow();
    expect(chamadas.filter(([cmd]) => cmd === 'bash')).toHaveLength(0);
    expect(logs.join(' ')).toMatch(/não reiniciei/i);
  });
});
