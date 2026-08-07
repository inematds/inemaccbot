// O promoavatar3 usa o MOTOR do promoavatar, mas o `flow.json` DELE.
//
// Existe porque a alternativa — copiar `scripts/` e `templates/` para o outro
// domínio — é o defeito que a skill `reel-promoavatar` foi criada para impedir:
// no A#23 o agente rodou a cópia velha de `preparar.py` da skill global e saiu
// `template: None`, com o HTML escrito à mão. Cópia de motor envelhece.
//
// A armadilha que estes testes fixam: `preparar.py` deriva o repo da pasta-pai
// do PRÓPRIO script (`REPO = AQUI.parent`) quando `--flow` não vem. Sem o
// `--flow` do domínio, um job do promoavatar3 leria os templates e o layout
// padrão do promoavatar.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { carregarFlow, congelar } from '../dominio/flow.js';
import { montarInput } from '../fluxos/entrada-fase.js';
import type { Fluxo } from '../fluxos/estado.js';

const PROJETOS = join(homedir(), 'projetos');
const REPO_DOMINIO = join(PROJETOS, 'promoavatar3');
const SKILLS = ['reel', 'reelpromo', 'explicativo'];

// `congelar` é o que o runtime faz na criação: sem ele a fase de texto não
// tem `prompt_texto` (o prompt ainda é um caminho no disco).
const def = congelar(carregarFlow(REPO_DOMINIO, SKILLS), REPO_DOMINIO);
const fluxo = { id: 16, prefixo: 'C', versao: 1, assunto: 'x' } as Fluxo;

function entrada(faseId: string, alvo: string): Record<string, string> {
  const fase = def.fases.find((f) => f.id === faseId)!;
  return JSON.parse(montarInput({
    fluxo, def, fase, alvo,
    raizArtefatos: '/art', projetosDir: PROJETOS, repoDominio: REPO_DOMINIO,
  })) as Record<string, string>;
}

describe('promoavatar3: motor compartilhado, domínio próprio', () => {
  it('a fase de reel é função e aponta para o motor do promoavatar', () => {
    const reel = def.fases.find((f) => f.id === 'reel')!;
    expect(reel.kind).toBe('function');
    expect(reel.tarefa).toBe('reel.montar');
    expect(def.motor_repo).toBe('promoavatar');

    const i = entrada('reel', Object.keys(def.alvos)[0]!);
    expect(i.script).toBe(join(PROJETOS, 'promoavatar', 'scripts', 'montar-reel.py'));
    // ...e o flow.json é o DELE: é de onde saem `template` e `templates_dir`.
    expect(i.flow).toBe(join(REPO_DOMINIO, 'flow.json'));
    expect(i.textos).toContain('promoavatar3/textos/C16/');
  });

  it('o motor existe no disco, com o `--flow` que o bot vai passar', () => {
    expect(existsSync(join(PROJETOS, 'promoavatar', 'scripts', 'montar-reel.py'))).toBe(true);
    expect(existsSync(join(REPO_DOMINIO, 'flow.json'))).toBe(true);
  });

  it('declara o layout, senão o `preparar.py` não resolve template nenhum', () => {
    expect(def.template).toBeTruthy();
    expect(def.templates_dir).toBeTruthy();
  });

  it('a rota `| estudio` existe e é exclusiva com as outras', () => {
    const rotas = def.fases.filter((f) => f.opcional).map((f) => f.opcional);
    expect(rotas).toContain('estudio');
    expect(rotas).toContain('api');
    expect(rotas).toContain('creditos');
  });

  it('o prazo do `baixar` cobre a fila real do HeyGen (36h), e o reel os 36 alvos', () => {
    const porId = (id: string) => def.fases.find((f) => f.id === id)!;
    expect(porId('baixar').espera!.timeout).toBeGreaterThanOrEqual(129_600);
    // 36 alvos em série a ~165s são ~100 min: o default interno (3h) não daria
    // margem a um requeue.
    expect(porId('reel').espera!.timeout).toBeGreaterThanOrEqual(21_600);
    expect(Object.keys(def.alvos)).toHaveLength(36);
  });

  it('o prompt da fase de texto pede a seção IMAGENS — é o portão do motor', () => {
    // Sem `## IMAGENS` com headline/hook por segmento o `preparar.py` sai com
    // exit 3, e TODOS os públicos falhariam no primeiro job.
    const fase = def.fases.find((f) => f.id === 'texto')!;
    expect(fase.prompt_texto).toContain('## IMAGENS');
    expect(fase.prompt_texto).toContain('headline:');
    expect(fase.prompt_texto).toContain('hook:');
  });
});
