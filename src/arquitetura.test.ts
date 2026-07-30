// src/arquitetura.test.ts
// As fronteiras do monólito modular são verificadas por teste, não por revisão
// humana. Regras do spec §4:
//   fila/    não importa de gateway/ nem de fluxos/
//   fluxos/  não importa de gateway/
//   dominio/ não importa de gateway/, fila/ nem fluxos/ (exceto TIPOS de fila/)
//   db/      não importa de nenhuma das outras
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = new URL('.', import.meta.url).pathname;

const PROIBIDO: Record<string, string[]> = {
  db: ['gateway', 'fila', 'fluxos', 'dominio'],
  fila: ['gateway', 'fluxos'],
  fluxos: ['gateway'],
  dominio: ['gateway', 'fluxos'],
};

function arquivosTs(dir: string): string[] {
  let saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida = saida.concat(arquivosTs(caminho));
    else if (nome.endsWith('.ts')) saida.push(caminho);
  }
  return saida;
}

/** `../fila/types.js` importado por dominio/ é a ÚNICA exceção: tipo, não implementação. */
const EXCECOES = [{ de: 'dominio', para: 'fila', arquivo: 'types.js' }];

// A regra vale pra todo .ts, inclusive teste — teste não é isenção de fronteira.
// Teste que precisa legitimamente cruzar camadas mora em src/integracao/, que
// fica de fora do mapa PROIBIDO de propósito. A lista de exceções acima tem
// UMA entrada só, e é assim que deve continuar.

describe('fronteiras entre camadas', () => {
  for (const [camada, vetados] of Object.entries(PROIBIDO)) {
    it(`${camada}/ não importa de ${vetados.join(', ')}`, () => {
      let dir: string;
      try {
        dir = join(RAIZ, camada);
        statSync(dir);
      } catch {
        return; // camada ainda não existe nesta etapa
      }
      // Sem esta asserção, uma lista vazia de arquivos passa verde e o teste
      // vira decoração — o mesmo defeito que ele existe pra impedir em
      // outros lugares.
      const arquivos = arquivosTs(dir);
      expect(
        arquivos.length,
        `nenhum .ts encontrado em ${dir} — o teste de fronteiras estaria passando sem inspecionar nada`,
      ).toBeGreaterThan(0);

      const violacoes: string[] = [];
      for (const arquivo of arquivos) {
        const codigo = readFileSync(arquivo, 'utf8');
        for (const alvo of vetados) {
          const re = new RegExp(`from\\s+['"][^'"]*\\b${alvo}/([^'"]+)['"]`, 'g');
          for (const m of codigo.matchAll(re)) {
            const permitido = EXCECOES.some(
              (e) => e.de === camada && e.para === alvo && m[1] === e.arquivo,
            );
            if (!permitido) violacoes.push(`${arquivo} → ${alvo}/${m[1]}`);
          }
        }
      }
      expect(violacoes).toEqual([]);
    });
  }
});
