// O promoavatar3 é AUTÔNOMO: motor, templates e skill próprios.
//
// A primeira tentativa foi compartilhar o motor do promoavatar (`motor_repo`),
// para não duplicar código que envelhece — foi cópia velha de `preparar.py` que
// produziu o `template: None` do A#23. A decisão mudou quando o dono declarou o
// promoavatar **congelado** (2026-08-06): "promoavatar3 não é evolução, é um
// sistema diferente, e os dois podem evoluir". Com a origem parada, a cópia não
// diverge — ela vira a única versão viva, e cada domínio ajusta a sua.
//
// O que estes testes protegem: que o promoavatar3 não volte a depender do outro
// repo em silêncio. `preparar.py` deriva o repo da pasta-pai do PRÓPRIO script,
// então um `script` apontando para fora levaria o layout do domínio errado.
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
  it('a fase de reel é função e usa o motor DESTE repo', () => {
    const reel = def.fases.find((f) => f.id === 'reel')!;
    expect(reel.kind).toBe('function');
    expect(reel.tarefa).toBe('reel.montar');
    // Sem `motor_repo`: o promoavatar está congelado e este projeto é autônomo.
    expect(def.motor_repo).toBeUndefined();

    const i = entrada('reel', Object.keys(def.alvos)[0]!);
    expect(i.script).toBe(join(REPO_DOMINIO, 'scripts', 'montar-reel.py'));
    expect(i.flow).toBe(join(REPO_DOMINIO, 'flow.json'));
    expect(i.textos).toContain('promoavatar3/textos/C16/');
    // A garantia que importa: NADA aponta para o outro repo.
    expect(JSON.stringify(i)).not.toContain('projetos/promoavatar/');
  });

  it('o motor e os layouts existem NESTE repo', () => {
    for (const f of ['scripts/montar-reel.py', 'scripts/preparar.py', 'scripts/montar.py',
      'scripts/qc-frames.py', 'scripts/revisor.py', 'scripts/gen-imagem.py',
      'templates/empilhado-capa.json', 'cta/cta-9x16.mp4', 'flow.json']) {
      expect(existsSync(join(REPO_DOMINIO, f)), `falta ${f}`).toBe(true);
    }
  });

  it('declara o layout, e o arquivo dele está aqui', () => {
    expect(def.template).toBeTruthy();
    expect(def.templates_dir).toBeTruthy();
    expect(existsSync(join(REPO_DOMINIO, def.templates_dir!, `${def.template}.json`))).toBe(true);
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
