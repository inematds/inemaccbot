import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { criarEspelhoV3, pedidoDoV3 } from './espelho-v3.js';

describe('pedidoDoV3', () => {
  it('reconhece os três jeitos que o v3 escreve a origem (EV#187/188/189)', () => {
    expect(pedidoDoV3('Eventos extremos ... Pedido original do Nei no openpcbotv3, job 134142.')).toBe(true);
    expect(pedidoDoV3('Complemento definitivo do pedido #134142, job #134159. Fazer vídeo')).toBe(true);
    expect(pedidoDoV3('Pedido #134783 do Nei: faça OUTRO vídeo eventosextremospub')).toBe(true);
  });
  it('pedido digitado no chat do inemaccbot não é do v3', () => {
    expect(pedidoDoV3('Explique isso no video Eu colocaria a Transformação Digital atual em 4 eras')).toBe(false);
    expect(pedidoDoV3('tornado no sul: como se proteger')).toBe(false);
  });
});

describe('criarEspelhoV3', () => {
  it('manda o texto e, se o anexo existe, o arquivo', async () => {
    const chamadas: string[][] = [];
    const dir = mkdtempSync(join(tmpdir(), 'espelho-'));
    const anexo = join(dir, 'abertura.jpg');
    writeFileSync(anexo, 'x');
    const espelhar = criarEspelhoV3('/s', async (bin, args) => { chamadas.push([bin, ...args]); });
    await espelhar({ texto: '❌ EV#187 falhou', anexo });
    expect(chamadas).toEqual([
      ['/s/avisa-v3.sh', 'inemaccbot · ❌ EV#187 falhou'],
      ['/s/envia-v3-arquivo.sh', anexo],
    ]);
  });
  it('anexo que sumiu do disco não vira chamada', async () => {
    const chamadas: string[][] = [];
    const espelhar = criarEspelhoV3('/s', async (bin, args) => { chamadas.push([bin, ...args]); });
    await espelhar({ texto: 'oi', anexo: '/nao/existe.mp4' });
    expect(chamadas).toHaveLength(1);
  });
});
