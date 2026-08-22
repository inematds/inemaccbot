// O musicavideo depois do porte para `cli.rodar` (2026-08-21).
//
// Este domínio nasceu com QUATRO fases de agente para rodar um CLI — e as
// quatro falharam na primeira execução real (MVD#87..#89): binário inventado,
// contrato de saída redefinido, render destacado morto pelo job, portão duplo.
// Agora as quatro declaram `comando` e quem executa é o bot.
//
// O teste lê o `flow.json` REAL do repo, como o `promoavatar.test.ts` faz: o
// que se quer garantir não é que um objeto de brinquedo funcione, é que o
// domínio de verdade continue montando as linhas de comando certas.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { carregarFlow, congelar } from '../dominio/flow.js';
import { montarInput } from '../fluxos/entrada-fase.js';
import type { Fluxo } from '../fluxos/estado.js';

const PROJETOS = join(homedir(), 'projetos');
const REPO_DOMINIO = join(PROJETOS, 'musicavideo');
const fluxo = { id: 89, prefixo: 'MVD', versao: 1, assunto: 'balada pop sobre recomeço' } as Fluxo;

const rodar = existsSync(join(REPO_DOMINIO, 'flow.json')) ? describe : describe.skip;

rodar('musicavideo: fluxo sem agente', () => {
  const def = congelar(carregarFlow(REPO_DOMINIO, []), REPO_DOMINIO);

  function comandoDe(faseId: string, anterior?: string): string {
    const fase = def.fases.find((f) => f.id === faseId)!;
    return JSON.parse(montarInput({
      fluxo, def, fase, alvo: 'unico',
      raizArtefatos: '/art', projetosDir: PROJETOS, repoDominio: REPO_DOMINIO,
      ...(anterior ? { anterior } : {}),
    })).comando;
  }

  it('nenhuma fase usa agente — todas são cli.rodar', () => {
    expect(def.fases.every((f) => f.kind === 'function')).toBe(true);
    expect(def.fases.every((f) => f.tarefa === 'cli.rodar')).toBe(true);
    // E nenhuma carrega prompt: não há mais o que um modelo pudesse ler errado.
    expect(def.fases.some((f) => f.prompt || f.prompt_texto)).toBe(false);
  });

  // O binário inventado (MVD#87) morre aqui: o comando é o do domínio, e o
  // script existe no disco.
  it('o comando aponta para o script que EXISTE no repo', () => {
    const cmd = comandoDe('plano');
    expect(cmd).toContain(`bash ${REPO_DOMINIO}/musicavideo.sh plano`);
    expect(existsSync(join(REPO_DOMINIO, 'musicavideo.sh'))).toBe(true);
  });

  // O assunto vem do Telegram e entra como UM argumento aspado. `--bruto` é o
  // domínio dizendo "as flags estão aí dentro, eu as interpreto" — o bot não
  // conhece `--estilo` nem `--idioma`, e não deve conhecer.
  it('o assunto vai aspado, num argumento só, com --bruto', () => {
    expect(comandoDe('plano'))
      .toBe(`bash ${REPO_DOMINIO}/musicavideo.sh plano 'balada pop sobre recomeço' --bruto`);
  });

  // O slug é derivado do texto e desambiguado com `-2` pelo próprio domínio: o
  // bot nunca o conhece. Ele viaja pelo RECIBO da fase anterior.
  it('as fases seguintes leem o slug do recibo da anterior', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const recibo = join(mkdtempSync(join(tmpdir(), 'mvd-')), 'plano.txt');
    writeFileSync(recibo, 'slug: para-a-musica-2\ntitulo: Além da Terra\nplano: /out/PLANO.md\n');

    expect(comandoDe('musica', recibo)).toBe(
      `bash ${REPO_DOMINIO}/musicavideo.sh faz 'para-a-musica-2' musica --sim --sem-revisao --aprovar`,
    );
    // CAPA e CLIPE são fases separadas desde 2026-08-22: a capa é o frame 0 no
    // feed e sai em segundos; esperar o clipe (horas) para revisá-la era
    // revisar tarde.
    expect(comandoDe('capa', recibo)).toBe(
      `bash ${REPO_DOMINIO}/musicavideo.sh faz 'para-a-musica-2' capa --sim --sem-revisao --aprovar`,
    );
    expect(comandoDe('clipe', recibo)).toBe(
      `bash ${REPO_DOMINIO}/musicavideo.sh faz 'para-a-musica-2' clipe --sim --sem-revisao --aprovar`,
    );
    expect(comandoDe('entrega', recibo)).toBe(
      `bash ${REPO_DOMINIO}/musicavideo.sh pacote 'para-a-musica-2'`,
    );
  });

  // `--sem-revisao --aprovar`: o portão humano é o do BOT, no chat. O portão
  // interno do domínio, invisível ali, travou o MVD#89 com a faixa já paga.
  it('as fases não deixam parte esperando revisão dentro do domínio', () => {
    for (const id of ['musica', 'capa', 'clipe']) {
      const cmd = comandoDe(id);
      expect(cmd).toContain('--sem-revisao');
      expect(cmd).toContain('--aprovar');
    }
  });

  it('o portão do plano mostra o PLANO.md que o recibo aponta', () => {
    expect(def.fases.find((f) => f.id === 'plano')!.portao?.mostrar)
      .toEqual(['{{artefato:plano}}']);
  });

  // A capa tem portão PRÓPRIO: aprovar a arte antes de gastar horas de render.
  it('a capa para para ser aprovada, e mostra a imagem', () => {
    const capa = def.fases.find((f) => f.id === 'capa')!;
    expect(capa.pausa_apos).toBe(true);
    expect(capa.portao?.mostrar).toEqual(['{{artefato:capa}}']);
    // E ela roda na fila `io`, não em `render`: é uma chamada de API de
    // segundos, e ficar atrás de um clipe de uma hora seria absurdo.
    expect(capa.fila).toBe('io');
  });

  // O clipe é o trabalho longo: fila de render, poll, e o teto declarado.
  it('o clipe roda destacado, com espera declarada', () => {
    const clipe = def.fases.find((f) => f.id === 'clipe')!;
    expect(clipe.fila).toBe('render');
    expect(clipe.espera).toEqual({ intervalo: 60, timeout: 10800 });
  });
});
