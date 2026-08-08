import { describe, expect, it } from 'vitest';

import { FakeRunner } from './runner.js';

const ctx = {
  prompt: 'faça X', cwd: '/tmp', perfil: { motor: 'claude', modelo: 'sonnet', esforco: 'low' },
  vars: {},
};

describe('FakeRunner', () => {
  it('devolve a resposta programada e registra a chamada', async () => {
    const r = new FakeRunner({ respostas: ['ok'] });
    const exec = r.iniciar(ctx);
    await expect(exec.aguardar()).resolves.toBe('ok');
    expect(r.chamadas).toHaveLength(1);
    expect(r.chamadas[0].perfil.modelo).toBe('sonnet');
  });

  it('propaga erro programado', async () => {
    const r = new FakeRunner({ erros: ['boom'] });
    await expect(r.iniciar(ctx).aguardar()).rejects.toThrow('boom');
  });

  it('cancelar faz aguardar rejeitar com "cancelado" e conta o cancelamento', async () => {
    const r = new FakeRunner({ respostas: ['nunca'], travar: true });
    const exec = r.iniciar(ctx);
    const p = exec.aguardar();
    await exec.cancelar();
    await expect(p).rejects.toThrow(/cancelado/);
    expect(r.cancelamentos).toBe(1);
  });

  it('limpar é idempotente', async () => {
    const r = new FakeRunner({ respostas: ['ok'] });
    const exec = r.iniciar(ctx);
    await exec.aguardar();
    await exec.limpar();
    await exec.limpar();
    expect(r.limpezas).toBe(2);
  });
});
