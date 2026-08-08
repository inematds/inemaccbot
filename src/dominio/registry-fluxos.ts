// Registry de FLUXOS: quais repos de domínio o bot conhece.
//
// Um fluxo novo = 1 entrada aqui + 1 repo de domínio, zero linha de código
// (§3.9). É o teste do desenho: se um fluxo novo exigir mexer no bot, o motor
// não ficou genérico.
//
// Separado do registry de skills de propósito: skill é uma etapa sem estado e
// mora no catálogo do bot; fluxo tem estado e a definição mora no repo de
// domínio, que é de quem entende do assunto.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface FluxoRegistrado {
  /** O que se digita no chat: `/promoavatar <assunto>`. */
  command: string;
  /** Caminho do repo de domínio, onde vivem `flow.json` e `prompts/`. */
  repo: string;
  descricao: string;
  exemplo: string;
}

const COMANDO = /^[a-z][a-z0-9-]{1,30}$/;

function erro(i: number, campo: string, detalhe: string): never {
  throw new Error(`registry de fluxos: entrada ${i} (${campo}): ${detalhe}`);
}

/**
 * `raizPadrao` resolve caminhos relativos (`~/projetos` na prática). O repo
 * precisa EXISTIR: §9 exige `cwd` validado contra a lista de repos de domínio
 * registrados, e um caminho que não existe é erro de config, não de execução.
 */
export function validarFluxos(dados: unknown, raizPadrao: string): FluxoRegistrado[] {
  if (!Array.isArray(dados)) throw new Error('registry de fluxos: precisa ser um array');
  // Array vazio é LEGÍTIMO aqui (ao contrário do de skills): o motor de fluxos
  // existe antes do primeiro fluxo de domínio — é exatamente o estado da etapa 5.
  const vistos = new Set<string>();
  return dados.map((bruta, i) => {
    if (typeof bruta !== 'object' || bruta === null || Array.isArray(bruta)) {
      erro(i, 'entrada', 'precisa ser objeto');
    }
    const d = bruta as Record<string, unknown>;
    const command = String(d.command ?? '').trim();
    if (!COMANDO.test(command)) erro(i, 'command', `"${command}" — minúsculas, dígitos e hífen`);
    if (vistos.has(command)) erro(i, 'command', `"${command}" duplicado`);
    vistos.add(command);

    const repoBruto = String(d.repo ?? '').trim();
    if (!repoBruto) erro(i, 'repo', 'faltando');
    const repo = isAbsolute(repoBruto) ? repoBruto : resolve(raizPadrao, repoBruto);
    if (!existsSync(repo) || !statSync(repo).isDirectory()) {
      erro(i, 'repo', `diretório não existe: ${repo}`);
    }
    if (!existsSync(resolve(repo, 'flow.json'))) {
      erro(i, 'repo', `não há flow.json em ${repo}`);
    }

    return {
      command,
      repo,
      descricao: String(d.descricao ?? '').trim() || command,
      exemplo: String(d.exemplo ?? '').trim() || `/${command} <assunto>`,
    };
  });
}

export function carregarFluxos(caminhoJson: string, raizPadrao: string): FluxoRegistrado[] {
  let texto: string;
  try {
    texto = readFileSync(caminhoJson, 'utf8');
  } catch {
    // Ausente = nenhum fluxo registrado. Não é erro: o bot roda só com skills.
    return [];
  }
  try {
    return validarFluxos(JSON.parse(texto), raizPadrao);
  } catch (e) {
    if ((e as Error).message.startsWith('registry de fluxos')) throw e;
    throw new Error(`registry de fluxos: JSON inválido em ${caminhoJson}: ${(e as Error).message}`);
  }
}
