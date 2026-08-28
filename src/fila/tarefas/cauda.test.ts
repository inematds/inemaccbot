import { describe, expect, it } from 'vitest';

import { cauda } from './cli.js';

// MVD#132 chegou no chat como "Traceback ... / File main.py line 403 /
// sys.exit(main(...))" — três linhas de cabeçalho e nenhuma causa. Num
// traceback Python a causa é a ÚLTIMA linha, então ancorar no primeiro
// "parece erro" cortava exatamente o que se queria ler.
describe('cauda', () => {
  it('traceback: fica com a causa (o fim), não com o cabeçalho', () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "src/main.py", line 403, in <module>',
      '    sys.exit(main(sys.argv[1:]))',
      '  File "src/planner.py", line 55, in chamar_fable',
      '    r = subprocess.run(...)',
      "subprocess.TimeoutExpired: Command 'claude' timed out after 900 seconds",
    ].join('\n');
    const s = cauda(tb);
    expect(s).toContain('TimeoutExpired');
    expect(s).not.toContain('Traceback (most recent');
  });

  it('erro de uma linha continua ancorando no erro, não na cauda', () => {
    const s = cauda('preparando...\nerro: chave ausente\ndetalhe A\ndetalhe B\ndetalhe C\ndetalhe D\nrodapé');
    expect(s.startsWith('erro: chave ausente')).toBe(true);
  });

  it('só ruído: devolve a última linha crua em vez de silêncio', () => {
    expect(cauda('[download]  50% of 10MiB\n[download] 100% of 10MiB')).toContain('100%');
  });
});
