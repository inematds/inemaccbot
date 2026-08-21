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

// `cli.rodar` — a linha de comando é montada AQUI, onde o bot conhece repo,
// ref, alvo e a entrada do usuário. O agente que fazia isso inventou um binário
// que não existe (MVD#87, 2026-08-21).
describe('montarInput: cli.rodar', () => {
  function ctxCli(comando: string, assunto = 'balada pop sobre recomeço') {
    return ctx({
      fluxo: { id: 89, prefixo: 'MVD', versao: 1, assunto } as Fluxo,
      fase: { id: 'plano', kind: 'function', tarefa: 'cli.rodar', comando } as unknown as FaseDef,
      alvo: 'unico',
    });
  }

  it('resolve os marcadores e ASPA a entrada do usuário', () => {
    const e = JSON.parse(montarInput(ctxCli('bash {{repo}}/musicavideo.sh plano {{input}}')));
    expect(e.comando).toBe("bash /repo/musicavideo.sh plano 'balada pop sobre recomeço'");
    expect(e.cwd).toBe('/repo');
  });

  // O assunto vem do Telegram. Sem aspar, um apóstrofo já quebra a linha — e
  // pior que quebrar é NÃO quebrar e virar comando.
  it('texto com aspas e ponto-e-vírgula não vira comando', () => {
    const e = JSON.parse(montarInput(
      ctxCli('bash {{repo}}/x.sh {{input}}', "o'brien; rm -rf /tmp/nao"),
    ));
    expect(e.comando).toBe("bash /repo/x.sh 'o'\\''brien; rm -rf /tmp/nao'");
  });

  // Determinístico por fluxo × fase × alvo: uma retentativa nasce com outro id
  // de job e tem que reescrever o MESMO recibo.
  it('o recibo é nomeado pelo bot, não pelo domínio', () => {
    const e = JSON.parse(montarInput(ctxCli('bash {{repo}}/x.sh {{input}}')));
    expect(e.saida).toBe('/art/fluxos/MVD89/plano-unico.txt');
  });

  it('{{alvo}}, {{ref}} e {{saida}} também chegam resolvidos', () => {
    const e = JSON.parse(montarInput(ctxCli('x {{ref}} {{alvo}} {{saida}}')));
    expect(e.comando).toBe("x 'MVD89' 'unico' '/art/fluxos/MVD89/plano-unico.txt'");
  });

  // Marcador sem valor vira string vazia ASPADA, nunca o marcador cru — que o
  // shell interpretaria.
  it('marcador desconhecido não sobra na linha', () => {
    const e = JSON.parse(montarInput(ctxCli('x {{inexistente}}')));
    expect(e.comando).toBe("x ''");
  });
});

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

  // O elo do meio do `| legenda=nao`: a decisão está na definição CONGELADA
  // (`legenda: false`, gravada por `resolverOpcoes`) e é daqui que ela alcança o
  // `montar-reel.py`. Fase de função não lê prompt — sem este repasse a opção
  // morre entre o chat e o render, que foi o estado até 2026-08-21.
  it('leva `semLegenda` quando o fluxo foi congelado sem legenda', () => {
    const semLegenda = { ...def, legenda: false } as unknown as FlowDef;
    expect(JSON.parse(montarInput(ctx({ def: semLegenda }))).semLegenda).toBe(true);
  });

  it('não leva nada quando ninguém desligou — o default é do montar-reel.py', () => {
    expect(JSON.parse(montarInput(ctx())).semLegenda).toBeUndefined();
    const comLegenda = { ...def, legenda: true } as unknown as FlowDef;
    expect(JSON.parse(montarInput(ctx({ def: comLegenda }))).semLegenda).toBeUndefined();
  });
});
