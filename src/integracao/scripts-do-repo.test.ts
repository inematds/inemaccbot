// Os SCRIPTS que o bot dispara existem e resolvem suas dependências A PARTIR
// DO REPO.
//
// Existe por um defeito de produção (2026-08-06): o `scripts/heygen-estudio.mjs`
// foi escrito e testado num scratchpad com um `node_modules` emprestado de
// outro projeto. No repo do bot o `playwright` não estava instalado — e os 12
// jobs da estreia da rota `| estudio` morreram todos com "saiu com código 1",
// antes de tocar no HeyGen. Nenhum teste pegou porque nenhum teste rodava o
// script de onde ele roda de verdade.
//
// Não abre navegador nem toca em rede: pergunta ao Node se o import resolveria.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = join(import.meta.dirname, '..', '..');

/** Cada script que uma tarefa `function` dispara, e o que ele importa. */
const SCRIPTS = [
  { arquivo: 'scripts/heygen-estudio.mjs', importa: ['playwright'] },
];

describe('scripts disparados pelo bot', () => {
  for (const { arquivo, importa } of SCRIPTS) {
    it(`${arquivo} existe no repo`, () => {
      expect(existsSync(join(RAIZ, arquivo)), `falta ${arquivo}`).toBe(true);
    });

    for (const dep of importa) {
      it(`${arquivo}: "${dep}" resolve a partir do repo`, () => {
        // `createRequire` no diretório do script: é exatamente a resolução que
        // o Node faz quando a tarefa dispara `node scripts/...`.
        const codigo = `import {createRequire} from 'node:module';`
          + `createRequire(${JSON.stringify(join(RAIZ, arquivo))}).resolve(${JSON.stringify(dep)});`;
        expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', codigo],
          { cwd: RAIZ, stdio: 'pipe' })).not.toThrow();
      });
    }
  }

  // O caminho que o `index.ts` passa para a tarefa tem que ser o arquivo real:
  // um erro de digitação aqui só apareceria no primeiro job da fase.
  it('o caminho que o index.ts monta aponta para o script que existe', () => {
    expect(existsSync(join(RAIZ, 'scripts', 'heygen-estudio.mjs'))).toBe(true);
  });
});
