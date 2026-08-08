import { describe, expect, it } from 'vitest';

import { montarInput, type ContextoEntrada } from './entrada-fase.js';
import type { FaseDef, FlowDef } from '../dominio/flow.js';
import type { Fluxo } from './estado.js';

const fluxo = { id: 32, prefixo: 'A', versao: 1, assunto: 'assunto' } as Fluxo;
const def = { alvos: { jovens: { canal: 'lives22' } } } as unknown as FlowDef;

function ctx(over: Partial<ContextoEntrada> = {}): ContextoEntrada {
  return {
    fluxo,
    def,
    fase: {
      id: 'reel', kind: 'function', tarefa: 'reel.montar',
      espera: { intervalo: 60, timeout: 7200 },
    } as unknown as FaseDef,
    alvo: 'jovens',
    raizArtefatos: '/art',
    projetosDir: '/home/u/projetos',
    repoDominio: '/repo',
    ...over,
  };
}

describe('montarInput: fase de reel como função', () => {
  it('deriva TODOS os campos do fluxo e do alvo — nada de parsear nome de arquivo', () => {
    const e = JSON.parse(montarInput(ctx()));
    expect(e.alvo).toBe('jovens');
    expect(e.textos).toBe('/repo/textos/A32/jovens.md');
    expect(e.script).toBe('/repo/scripts/montar-reel.py');
    // Determinística por fluxo × alvo × versão: uma retentativa nasce com outro
    // id de job e precisa reencontrar o MESMO arquivo, senão "procure antes de
    // criar" não vale nada.
    expect(e.saida).toBe('/art/reel/A32-jovens-v1.mp4');
    expect(e.ws).toBe('/home/u/projetos/output/reels/A32-jovens-v1');
    expect(e.espera).toEqual({ intervalo: 60, timeout: 7200 });
  });

  it('usa o mp4 que a fase anterior devolveu, com o caminho canônico de rede', () => {
    expect(JSON.parse(montarInput(ctx({ anterior: '/art/fluxos/A32/x.mp4' }))).avatar)
      .toBe('/art/fluxos/A32/x.mp4');
    expect(JSON.parse(montarInput(ctx({ anterior: null }))).avatar)
      .toBe('/art/fluxos/A32/A32-jovens-v1.mp4');
  });

  it('leva o alvo no bloco `fluxo`, que é o que o /status mostra', () => {
    expect(JSON.parse(montarInput(ctx())).fluxo).toMatchObject({
      ref: 'A#32', fase: 'reel', alvo: 'jovens', canal: 'lives22',
    });
  });
});
