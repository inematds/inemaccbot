// Todo prompt de agente PROÍBE mexer no ambiente da máquina.
//
// Não é zelo abstrato: em 2026-07-31 um render leu no log da própria ferramenta
// a dica "install chrome-headless-shell for the optimized path", instalou, e o
// binário errado (pacote `linux_arm` numa máquina aarch64) derrubou o render
// SEGUINTE — sonda de GPU falhando, captura em software, 1 worker, timeout de
// 300s. O job que quebrou não foi o que instalou.
//
// Este teste é o que faz a regra existir de verdade: prompt novo sem a proibição
// falha aqui, com o nome do arquivo. Mesma forma do `ajuda-dominio.test.ts`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = new URL('../..', import.meta.url).pathname;
const PROMPTS = join(RAIZ, 'prompts');

const arquivos = readdirSync(PROMPTS).filter((f) => f.endsWith('.md'));

describe('todo prompt proíbe mexer no ambiente', () => {
  it('há prompts para varrer (senão este teste passa por vazio)', () => {
    expect(arquivos.length).toBeGreaterThan(0);
  });

  it.each(arquivos)('%s tem a seção NÃO MEXA NA MÁQUINA', (nome) => {
    const texto = readFileSync(join(PROMPTS, nome), 'utf8');
    expect(texto, `${nome} não proíbe mexer no ambiente`).toContain('NÃO MEXA NA MÁQUINA');
  });

  // A proibição precisa dizer o que fazer no lugar. "Não instale" sem saída
  // deixa o agente escolher sozinho — que é como o problema apareceu.
  it.each(arquivos)('%s manda declarar ERRO em vez de instalar', (nome) => {
    const texto = readFileSync(join(PROMPTS, nome), 'utf8');
    expect(texto, `${nome} proíbe instalar mas não diz o que fazer`).toMatch(/NÃO instale/i);
    expect(texto).toMatch(/ERRO:/);
  });
});
