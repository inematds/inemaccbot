// Registry de FONTES — de onde sai o MATERIAL de entrada (explicativo, trilha,
// b-roll, capa). É o espelho de `destinos.ts`, que responde a pergunta oposta
// (para onde vai o artefato pronto), e existe pelo mesmo motivo §3.2: o domínio
// referencia material por NOME (`trilhas`), nunca por caminho. Caminho em
// `flow.json` ou em prompt é o que envelhece na primeira vez que alguém troca de
// máquina — e o CTA do reel, hoje um caminho dentro do domínio, é o aviso.
//
// Diferença de desenho para os destinos, e ela é deliberada: destino é
// DESCOBERTO no disco (`yt-pub-livesN`), fonte é DECLARADA em
// `config/fontes.json`. Descobrir fonte seria adivinhar que qualquer pasta de
// mídia é material do bot; declarar mantém a lista pequena e revisável.
//
// FONTE É PASTA, e a escolha do arquivo dentro dela é EXPLÍCITA
// (`| trilha=lofi` → `<fonte>/lofi.mp3`). Nada de "pega um da pasta": sorteio
// quebraria a promessa de mesmo pedido → mesmo resultado, que já custou caro no
// adaptador de imagem (provedor sem seed).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Nome citado pelo domínio e pelo chat: minúsculas, dígitos e hífen. */
const NOME = /^[a-z0-9][a-z0-9-]*$/;

/** Nome do arquivo escolhido dentro da fonte. Sem `/`, sem `..`, sem espaço:
 * o valor vem do chat e vira caminho — é a mesma barreira do registry de
 * skills, e pelo mesmo motivo (texto do usuário não escolhe caminho). */
const ESCOLHA = /^[a-z0-9][a-z0-9._-]*$/i;

export interface FonteDef {
  /** Nome pelo qual o domínio pede. */
  nome: string;
  /** Caminho RELATIVO à raiz de material, nunca absoluto: caminho absoluto num
   * arquivo versionado não sobrevive à mudança de máquina. */
  caminho: string;
}

function erro(campo: string, detalhe: string): never {
  throw new Error(`registry de fontes: ${campo}: ${detalhe}`);
}

/** Valida o conteúdo de `config/fontes.json`. Objeto `{ nome: caminho }`.
 * Arquivo ausente é caso NORMAL: o registry fica vazio e nada muda. */
export function validarFontes(dados: unknown): FonteDef[] {
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    throw new Error('registry de fontes: o arquivo precisa ser um objeto { nome: caminho }');
  }
  return Object.entries(dados as Record<string, unknown>).map(([nome, bruto]) => {
    if (!NOME.test(nome)) erro(nome, 'nome inválido (minúsculas, dígitos e hífen)');
    if (typeof bruto !== 'string' || !bruto.trim()) erro(nome, 'caminho vazio');
    const caminho = bruto.trim();
    if (isAbsolute(caminho) || caminho.split('/').includes('..')) {
      erro(nome, `"${caminho}" — relativo à raiz de material, sem ".."`);
    }
    return { nome, caminho };
  });
}

/** `trilhas` → `<raiz>/audio/trilhas`, ou null se o nome não está no registry
 * ou a pasta não existe no disco. As duas falhas são a mesma para quem chamou:
 * não há de onde tirar material. */
export function resolverFonte(nome: string, fontes: FonteDef[], raiz: string): string | null {
  const def = fontes.find((f) => f.nome === nome.trim().toLowerCase());
  if (!def) return null;
  const caminho = join(raiz, def.caminho);
  if (!existsSync(caminho) || !statSync(caminho).isDirectory()) return null;
  return caminho;
}

/** O ARQUIVO dentro da fonte, escolhido por nome. `escolha` é o que veio do
 * chat (`| trilha=lofi`), com ou sem extensão: sem extensão, casa com o único
 * arquivo daquele nome-base; com mais de um candidato, recusa em vez de
 * escolher — ambiguidade resolvida em silêncio é o defeito que não se vê. */
export function resolverArquivoDaFonte(
  nome: string,
  escolha: string,
  fontes: FonteDef[],
  raiz: string,
): string | null {
  const pasta = resolverFonte(nome, fontes, raiz);
  if (!pasta) return null;
  const alvo = escolha.trim();
  if (!ESCOLHA.test(alvo)) return null;

  let entradas: string[];
  try {
    entradas = readdirSync(pasta).filter((e) => statSync(join(pasta, e)).isFile());
  } catch {
    return null;
  }
  // Nome exato ganha de nome-base: `lofi.mp3` é escolha inequívoca, e quem a
  // digitou não quer que a gente procure outro `lofi.*`.
  if (entradas.includes(alvo)) return join(pasta, alvo);

  const semExt = entradas.filter((e) => e.slice(0, e.lastIndexOf('.') > 0 ? e.lastIndexOf('.') : e.length) === alvo);
  if (semExt.length === 1) return join(pasta, semExt[0]);
  return null;
}

/** Nomes registrados, em ordem — alimenta as mensagens de erro e a ajuda.
 * "fonte não existe" sem dizer quais existem é atrito puro (§ mesma regra dos
 * destinos). */
export function listarFontes(fontes: FonteDef[]): string[] {
  return fontes.map((f) => f.nome).sort();
}

/** O que existe DENTRO de uma fonte, para a mensagem de erro da escolha. */
export function listarArquivosDaFonte(nome: string, fontes: FonteDef[], raiz: string): string[] {
  const pasta = resolverFonte(nome, fontes, raiz);
  if (!pasta) return [];
  try {
    return readdirSync(pasta).filter((e) => statSync(join(pasta, e)).isFile()).sort();
  } catch {
    return [];
  }
}
