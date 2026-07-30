import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validarSkills, type SkillDef } from '../dominio/registry.js';
import { analisar, textoSkills } from './gramatica.js';

let raiz: string;
let projetos: string;
let defs: SkillDef[];

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'inemaccbot-gram-'));
  mkdirSync(join(raiz, 'prompts'));
  writeFileSync(join(raiz, 'prompts', 'p.md'), '{{input}} {{saida}}');
  projetos = join(raiz, 'projetos');
  mkdirSync(join(projetos, 'yt-pub-lives3', 'imports', 'videos'), { recursive: true });

  const comum = {
    fila: 'texto', kind: 'agent', prompt: 'prompts/p.md', artefato_exts: ['txt'],
    max_tentativas: 2, timeout_segundos: 60, descricao: 'd', exemplo: 'ex: x',
  };
  defs = validarSkills([
    { ...comum, command: 'transcrever', aceita_destino: false },
    { ...comum, command: 'dublar', artefato_exts: ['mp4'], aceita_destino: true },
  ], raiz);
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

const an = (t: string) => analisar(t, defs, projetos);

describe('analisar — duas portas (§1.1)', () => {
  it('reconhece uma skill do catálogo', () => {
    expect(an('transcrever: https://x/y')).toEqual({
      tipo: 'skill', pedido: { command: 'transcrever', entrada: 'https://x/y' },
    });
  });

  it('o verbo é normalizado, a entrada não (link diferencia caixa)', () => {
    const a = an('Transcrever: https://X/Y');
    expect(a).toMatchObject({ tipo: 'skill', pedido: { command: 'transcrever', entrada: 'https://X/Y' } });
  });

  // O ":" é comum em conversa. Se a porta fosse por FORMATO, "hoje: choveu"
  // viraria comando; ela é por igualdade contra o catálogo.
  it('texto com ":" que não é skill vira texto livre, não comando', () => {
    expect(an('hoje: choveu muito')).toEqual({ tipo: 'livre', texto: 'hoje: choveu muito' });
  });

  it('texto sem ":" vira texto livre', () => {
    expect(an('já terminou aquele job?').tipo).toBe('livre');
  });

  it('skill sem entrada é erro com o exemplo da própria skill', () => {
    const a = an('transcrever:');
    expect(a).toMatchObject({ tipo: 'erro' });
    expect((a as { mensagem: string }).mensagem).toContain('ex: x');
  });

  // Defeito real do v1: filtrar vazios ANTES de tomar a entrada fazia o
  // primeiro campo virar a entrada.
  it('entrada vazia com campo depois não deixa o campo virar entrada', () => {
    expect(an('dublar: | lives3').tipo).toBe('erro');
  });
});

describe('analisar — campos', () => {
  it('resolve destino livesN para o caminho no disco', () => {
    const a = an('dublar: http://x | lives3');
    expect(a).toMatchObject({
      tipo: 'skill',
      pedido: { destino: join(projetos, 'yt-pub-lives3', 'imports', 'videos'), destinoToken: 'lives3' },
    });
  });

  it('destino inexistente lista os válidos', () => {
    const a = an('dublar: http://x | lives99');
    expect((a as { mensagem: string }).mensagem).toContain('lives3');
  });

  it('skill que não aceita destino recusa em vez de ignorar em silêncio', () => {
    expect(an('transcrever: http://x | lives3')).toMatchObject({ tipo: 'erro' });
  });

  it('override de perfil vira campo estruturado (aceita "esforço" com cedilha)', () => {
    const a = an('transcrever: http://x | modelo=opus | esforço=high');
    expect((a as { pedido: { perfil: unknown } }).pedido.perfil).toEqual({ modelo: 'opus', esforco: 'high' });
  });

  it('campo desconhecido é erro nomeado, não silêncio', () => {
    const a = an('transcrever: http://x | vertical');
    expect((a as { mensagem: string }).mensagem).toContain('vertical');
  });
});

describe('textoSkills', () => {
  it('lista o catálogo real com exemplo', () => {
    const t = textoSkills(defs);
    expect(t).toContain('transcrever');
    expect(t).toContain('dublar');
    expect(t).toContain('ex: x');
  });
});
