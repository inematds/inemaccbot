// A parte DECIDÍVEL de plugar um repo: pegar a entrada que o manifesto produz e
// colocá-la no `config/skills.json` sem quebrar o arquivo, mais as conferências
// de requisito que não dependem do disco.
//
// Está aqui, em função pura, e não dentro do `plugar-repo.sh`, porque é o pedaço
// que decide se o bot sobe depois — e `sed` em JSON não tem teste. O shell fica
// com o que é IO: clonar, `command -v`, escrever arquivo, rodar a suíte.
import { validarSkills } from './registry.js';

export interface Insercao {
  /** O `config/skills.json` inteiro, já com a entrada dentro. */
  texto: string;
  acao: 'inserida' | 'substituida';
}

/**
 * Insere (ou substitui) a entrada de uma skill no texto do `skills.json`.
 *
 * Substituir é o caso de RE-plugar: o manifesto mudou e a entrada tem que
 * refletir isso. Recusar aqui obrigaria a editar à mão justamente quando se
 * quer automação — mas a substituição é anunciada, nunca silenciosa (ver
 * `acao`, que o script mostra antes de gravar).
 *
 * A validação usa `validarSkills`, o MESMO validador do boot: é o que garante
 * que "plugou" e "o serviço sobe" são a mesma coisa.
 */
export function inserirEntradaSkill(
  jsonAtual: string,
  entrada: Record<string, unknown>,
  raizRepo: string,
): Insercao {
  let lista: unknown;
  try {
    lista = JSON.parse(jsonAtual);
  } catch (e) {
    throw new Error(`config/skills.json não é JSON válido: ${(e as Error).message}`);
  }
  if (!Array.isArray(lista)) throw new Error('config/skills.json precisa ser um array');

  const command = entrada.command;
  if (typeof command !== 'string') throw new Error('entrada sem command');

  const i = (lista as Record<string, unknown>[]).findIndex((s) => s?.command === command);
  const acao: Insercao['acao'] = i >= 0 ? 'substituida' : 'inserida';
  const nova = [...(lista as Record<string, unknown>[])];
  if (i >= 0) nova[i] = entrada; else nova.push(entrada);

  // Validar ANTES de devolver o texto: quem chama grava o que sai daqui, e um
  // arquivo inválido no disco é o boot que não sobe.
  validarSkills(nova, raizRepo);

  return { texto: `${JSON.stringify(nova, null, 2)}\n`, acao };
}

/**
 * Quais chaves exigidas faltam no cofre.
 *
 * Chave DECLARADA E VAZIA conta como faltando, e essa é a parte que importa:
 * `CHAVE=` passa por qualquer teste de existência e falha só no primeiro job,
 * 40 minutos depois, num erro do provedor que não menciona o cofre.
 */
export function chavesFaltando(textoCofre: string, exigidas: string[]): string[] {
  const presentes = new Set(
    textoCofre.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        if (i <= 0) return null;
        const valor = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        return valor ? l.slice(0, i).trim() : null;
      })
      .filter((k): k is string => k !== null),
  );
  return exigidas.filter((c) => !presentes.has(c));
}

/**
 * A linha de comando que o prompt vai mandar rodar, com o `{{repo}}` resolvido.
 *
 * `{{input}}` NÃO é resolvido aqui de propósito: quem o substitui é o motor de
 * prompt, no momento do job, com o que o usuário digitou. Trocá-lo agora
 * congelaria a entrada de um job no arquivo de config.
 */
export function invocacaoResolvida(invocacao: string, caminhoRepo: string): string {
  return invocacao.replaceAll('{{repo}}', caminhoRepo);
}
