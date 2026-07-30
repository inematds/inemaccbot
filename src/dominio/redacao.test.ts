import { describe, expect, it } from 'vitest';

import { MASCARA, redigir } from './redacao.js';

// O token de exemplo é sintético (formato do BotFather, valor inventado) — nunca
// um valor real, nem sequer expirado.
const TOKEN_FALSO = '1234567890:AAH9xQvT3kLmNpQrStUvWxYz012345678ab';

describe('redigir', () => {
  it('mascara um token no formato do Telegram mesmo sem conhecer o valor', () => {
    const r = redigir(`falha ao chamar https://api.telegram.org/bot${TOKEN_FALSO}/getFile`);
    expect(r).not.toContain(TOKEN_FALSO);
    expect(r).toContain(MASCARA);
  });

  it('mascara valor literal configurado (o BOT_TOKEN em uso)', () => {
    const segredo = 'segredo-muito-especifico-123';
    const r = redigir(`erro: usei ${segredo} e falhou`, { segredos: [segredo] });
    expect(r).not.toContain(segredo);
  });

  it('ignora "segredo" curto demais — mascará-lo comeria texto comum', () => {
    const r = redigir('erro no arquivo abc.txt', { segredos: ['abc'] });
    expect(r).toContain('abc.txt');
  });

  it('mascara o VALOR de atribuições cujo nome cheira a segredo, preservando o nome', () => {
    const r = redigir('env: ANTHROPIC_API_KEY=sk-ant-abc123 OUTRA=ok');
    expect(r).toContain('ANTHROPIC_API_KEY=');
    expect(r).not.toContain('sk-ant-abc123');
    expect(r).toContain('OUTRA=ok');
  });

  it('troca o home do usuário por ~', () => {
    const r = redigir('não achei /home/fulano/projetos/x.mp4', { home: '/home/fulano' });
    expect(r).toBe('não achei ~/projetos/x.mp4');
  });

  it('corta no limite pedido', () => {
    expect(redigir('a'.repeat(50), { limite: 10 })).toHaveLength(10);
  });

  it('não lança em entrada não-string (é chamada no caminho de falha)', () => {
    expect(() => redigir(undefined as unknown as string)).not.toThrow();
  });
});
