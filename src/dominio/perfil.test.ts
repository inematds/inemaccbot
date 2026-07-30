// src/dominio/perfil.test.ts
import { describe, expect, it } from 'vitest';

import { resolverPerfil, type FontesPerfil } from './perfil.js';

const padrao = { motor: 'claude', modelo: 'sonnet', esforco: 'low' };
const base: FontesPerfil = { padrao };

describe('precedência', () => {
  it('sem nenhuma fonte, usa o padrão', () => {
    expect(resolverPerfil(base).perfil).toEqual(padrao);
  });

  it('sugestão da skill vence o padrão', () => {
    const { perfil } = resolverPerfil({ ...base, skill: { sugere: { modelo: 'opus' } } });
    expect(perfil.modelo).toBe('opus');
  });

  it('registry vence a sugestão da skill', () => {
    const { perfil } = resolverPerfil({
      ...base, skill: { sugere: { modelo: 'opus' } }, registry: { modelo: 'haiku' },
    });
    expect(perfil.modelo).toBe('haiku');
  });

  it('fase vence o registry', () => {
    const { perfil } = resolverPerfil({
      ...base, registry: { esforco: 'low' }, fase: { esforco: 'high' },
    });
    expect(perfil.esforco).toBe('high');
  });

  it('override do comando vence tudo', () => {
    const { perfil } = resolverPerfil({
      ...base, registry: { modelo: 'haiku' }, fase: { modelo: 'sonnet' },
      override: { modelo: 'opus' },
    });
    expect(perfil.modelo).toBe('opus');
  });

  it('mistura fontes campo a campo', () => {
    const { perfil } = resolverPerfil({
      ...base, registry: { modelo: 'opus' }, fase: { esforco: 'high' },
      override: { motor: 'codex' },
    });
    expect(perfil).toEqual({ motor: 'codex', modelo: 'opus', esforco: 'high' });
  });
});

describe('piso declarado pela skill (exige)', () => {
  it('eleva o modelo quando o resolvido é mais fraco que o exigido', () => {
    const { perfil, avisos } = resolverPerfil({
      ...base, skill: { exige: { modelo: 'opus' } }, registry: { modelo: 'haiku' },
    });
    expect(perfil.modelo).toBe('opus');
    expect(avisos.join(' ')).toMatch(/exige modelo opus/i);
  });

  it('eleva o esforço quando o resolvido é mais fraco', () => {
    const { perfil } = resolverPerfil({ ...base, skill: { exige: { esforco: 'high' } } });
    expect(perfil.esforco).toBe('high');
  });

  it('não rebaixa quando o resolvido é mais forte que o piso', () => {
    const { perfil } = resolverPerfil({
      ...base, skill: { exige: { modelo: 'sonnet' } }, registry: { modelo: 'opus' },
    });
    expect(perfil.modelo).toBe('opus');
  });

  it('override EXPLÍCITO do operador vence o piso, mas avisa', () => {
    const { perfil, avisos } = resolverPerfil({
      ...base, skill: { exige: { modelo: 'opus' } }, override: { modelo: 'haiku' },
    });
    expect(perfil.modelo).toBe('haiku');
    expect(avisos.join(' ')).toMatch(/abaixo do exigido/i);
  });

  it('motor exigido é obrigatório e não é rebaixável por registry', () => {
    const { perfil } = resolverPerfil({
      ...base, skill: { exige: { motor: 'claude' } }, registry: { motor: 'codex' },
    });
    expect(perfil.motor).toBe('claude');
  });
});

describe('validação', () => {
  it('rejeita modelo desconhecido', () => {
    expect(() => resolverPerfil({ ...base, override: { modelo: 'gpt-inventado' } }))
      .toThrow(/modelo desconhecido/i);
  });

  it('rejeita esforço desconhecido', () => {
    expect(() => resolverPerfil({ ...base, override: { esforco: 'turbo' } }))
      .toThrow(/esforço desconhecido/i);
  });

  it('rejeita modelo desconhecido exigido pela skill', () => {
    expect(() => resolverPerfil({ ...base, skill: { exige: { modelo: 'inventado' } } }))
      .toThrow(/exige modelo desconhecido/i);
  });

  it('rejeita esforço desconhecido exigido pela skill', () => {
    expect(() => resolverPerfil({ ...base, skill: { exige: { esforco: 'turbo' } } }))
      .toThrow(/exige esforco desconhecido/i);
  });

  // Caso que sustenta a cobertura: o resolvido (opus) já é mais forte que
  // qualquer coisa, então uma validação feita só dentro do ramo de elevação
  // nunca dispararia — o `exige` desconhecido precisa ser checado sempre,
  // não apenas quando for elevar.
  it('rejeita modelo exigido desconhecido mesmo quando nenhuma elevação seria necessária', () => {
    expect(() => resolverPerfil({
      padrao: { motor: 'claude', modelo: 'opus', esforco: 'low' },
      skill: { exige: { modelo: 'inventado' } },
    })).toThrow(/exige modelo desconhecido/i);
  });
});
