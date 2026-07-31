// A REGRA DO SISTEMA, verificada: todo domínio que entra no catálogo responde
// ajuda utilizável.
//
// Este arquivo existe para que a regra não dependa de disciplina. Alguém
// acrescenta uma skill nova no `config/skills.json` ou um fluxo no
// `config/fluxos.json` e não escreve ajuda nenhuma? A suíte fica vermelha aqui,
// com o nome do domínio mudo — e o conserto é escrever o arquivo de ajuda OU
// preencher `descricao`/`exemplo` no registro.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { carregarSkills, validarSkills, type SkillDef } from '../dominio/registry.js';
import { carregarFluxos } from '../dominio/registry-fluxos.js';
import { ajudaDoFluxo } from './comandos-fluxo.js';
import { ajudaDaSkill } from './ajuda-dominio.js';

const REPO = new URL('../..', import.meta.url).pathname;
const PROJETOS = join(REPO, '..');

const skills = carregarSkills(join(REPO, 'config', 'skills.json'), REPO);
const fluxos = carregarFluxos(join(REPO, 'config', 'fluxos.json'), PROJETOS);
const comandosSkill = skills.map((s) => s.command);

describe('REGRA: todo domínio do catálogo é documentado', () => {
  it('há domínios para verificar (senão este teste seria decoração)', () => {
    expect(skills.length + fluxos.length).toBeGreaterThan(0);
  });

  for (const def of skills) {
    it(`skill "${def.command}" responde ajuda utilizável`, () => {
      const ajuda = ajudaDaSkill(def, REPO);
      // Utilizável = diz o nome, diz como usar, e não é um esqueleto vazio.
      expect(ajuda).toContain(def.command);
      expect(ajuda.length).toBeGreaterThan(60);
      expect(ajuda).toMatch(/uso:/i);
      // Todo campo que a skill aceita aparece — senão o usuário não tem como
      // descobrir que ele existe.
      for (const campo of Object.keys(def.campos)) expect(ajuda).toContain(campo);
    });
  }

  for (const reg of fluxos) {
    it(`fluxo "${reg.command}" responde ajuda utilizável`, () => {
      const ajuda = ajudaDoFluxo(reg, comandosSkill);
      expect(ajuda).toContain(reg.command);
      expect(ajuda.length).toBeGreaterThan(60);
      // A referência certa (`A#N` vs `P#N`) é o que mais confunde na prática.
      expect(ajuda).toMatch(/#N|#\d/);
    });
  }
});

describe('ajudaDaSkill', () => {
  let dir: string;
  let def: SkillDef;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inemaccbot-ajuda-'));
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(join(dir, 'prompts', 'x.md'), '{{input}} {{saida}}');
    def = validarSkills([{
      command: 'exemplo', fila: 'texto', kind: 'agent', prompt: 'prompts/x.md',
      artefato_exts: ['txt'], max_tentativas: 2, timeout_segundos: 600,
      aceita_destino: true, descricao: 'faz alguma coisa útil',
      exemplo: 'exemplo: http://x',
      campos: { vertical: { tipo: 'bandeira', padrao: 'não', descricao: 'formato 9:16' } },
    }], dir)[0]!;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Quem entende do assunto escreve; o bot só serve.
  it('usa o arquivo escrito ao lado do prompt, quando existe', () => {
    writeFileSync(join(dir, 'prompts', 'x.help.md'), 'ajuda escrita à mão');
    expect(ajudaDaSkill(def, dir)).toBe('ajuda escrita à mão');
  });

  // E é isto que torna escrever OPCIONAL sem virar buraco: o derivado sai da
  // mesma fonte que o bot usa para executar, então não pode divergir.
  it('sem arquivo, DERIVA do registro — fila, prazo, entrega e campos', () => {
    const a = ajudaDaSkill(def, dir);
    expect(a).toContain('faz alguma coisa útil');
    expect(a).toContain('exemplo: http://x');
    expect(a).toContain('texto');          // fila
    expect(a).toContain('10 min');         // prazo
    expect(a).toContain('.txt');           // entrega
    expect(a).toContain('livesN');         // aceita destino
    expect(a).toContain('vertical');       // campo declarado
    expect(a).toContain('formato 9:16');   // com a descrição do campo
  });

  it('arquivo vazio não conta como ajuda escrita', () => {
    writeFileSync(join(dir, 'prompts', 'x.help.md'), '   \n  ');
    expect(ajudaDaSkill(def, dir)).toContain('faz alguma coisa útil');
  });
});
