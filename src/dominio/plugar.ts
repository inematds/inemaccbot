// A parte DECIDÍVEL de plugar um repo: pegar a entrada que o manifesto produz e
// colocá-la no `config/skills.json` sem quebrar o arquivo, mais as conferências
// de requisito que não dependem do disco.
//
// Está aqui, em função pura, e não dentro do `plugar-repo.sh`, porque é o pedaço
// que decide se o bot sobe depois — e `sed` em JSON não tem teste. O shell fica
// com o que é IO: clonar, `command -v`, escrever arquivo, rodar a suíte.
import { validarSkills } from './registry.js';
import type { DefinicaoFluxo } from './manifesto.js';
import { validarFluxos } from './registry-fluxos.js';

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
 * Insere (ou substitui) a entrada de um FLUXO no texto do `config/fluxos.json`.
 *
 * Gêmeo de `inserirEntradaSkill`, com uma diferença que decide a ORDEM do
 * `plugar-fluxo`: o validador do registry de fluxos vai ao DISCO — ele exige
 * que a pasta exista e que haja um `flow.json` dentro (`registry-fluxos.ts`).
 *
 * Ou seja: esta função só passa depois de a definição já estar materializada no
 * repo. Isso não é limitação, é a ordem correta — uma entrada apontando para um
 * repo sem `flow.json` **derruba o boot**, e o modo de falha "o bot não sobe" é
 * pior que "a instalação parou".
 */
export function inserirEntradaFluxo(
  jsonAtual: string,
  entrada: Record<string, unknown>,
  raizPadrao: string,
): Insercao {
  let lista: unknown;
  try {
    lista = JSON.parse(jsonAtual);
  } catch (e) {
    throw new Error(`config/fluxos.json não é JSON válido: ${(e as Error).message}`);
  }
  if (!Array.isArray(lista)) throw new Error('config/fluxos.json precisa ser um array');

  const command = entrada.command;
  if (typeof command !== 'string') throw new Error('entrada sem command');

  const i = (lista as Record<string, unknown>[]).findIndex((f) => f?.command === command);
  const acao: Insercao['acao'] = i >= 0 ? 'substituida' : 'inserida';
  const nova = [...(lista as Record<string, unknown>[])];
  if (i >= 0) nova[i] = entrada; else nova.push(entrada);

  // O MESMO validador do boot, pelo mesmo motivo da rota de skill: "plugou" e
  // "o serviço sobe" têm que ser a mesma coisa.
  validarFluxos(nova, raizPadrao);

  return { texto: `${JSON.stringify(nova, null, 2)}\n`, acao };
}

/** Um arquivo que a definição quer pôr no repo de domínio. */
export interface ArquivoPlanejado {
  /** Caminho relativo à raiz do repo de domínio. */
  caminho: string;
  conteudo: string;
}

export interface PlanoMaterializacao {
  /** Não existe no repo: pode escrever. */
  escrever: ArquivoPlanejado[];
  /** Já existe com o MESMO conteúdo: nada a fazer, e não é conflito. */
  iguais: string[];
  /**
   * O REPO tem a sua própria versão, diferente da do manifesto — e ela VENCE.
   * Quem sincroniza é o manifesto, no sentido domínio → bot. Só acontece em
   * repo que já é domínio (tem `flow.json` próprio).
   */
  importar: ArquivoPlanejado[];
  /** Já existe DIFERENTE em repo que ainda NÃO é domínio: paramos. */
  conflitos: string[];
}

/**
 * O que escrever no repo de domínio, e o que NÃO tocar.
 *
 * A regra que governa tudo: **o repo é o dono da definição.** O manifesto
 * carrega uma cópia para poder plugar um repo que ainda não é domínio; ele não
 * é uma segunda fonte de verdade. Por isso arquivo divergente é CONFLITO e para
 * a instalação, em vez de virar sobrescrita — sobrescrever `flow.json` alheio
 * apagaria a máquina de estados de um fluxo que talvez esteja em produção, e o
 * `--desfazer` de um repo que não é nosso é promessa que não se cumpre.
 *
 * Idêntico não é conflito: re-plugar na mesma máquina, ou plugar depois de o
 * repo já ter adotado a definição, tem que ser operação que não faz nada.
 *
 * Função pura: quem lê e escreve arquivo é o helper. Aqui só se decide.
 */
export function planoMaterializacao(
  definicao: DefinicaoFluxo,
  lerAtual: (caminho: string) => string | undefined,
): PlanoMaterializacao {
  const plano: PlanoMaterializacao = { escrever: [], iguais: [], importar: [], conflitos: [] };

  // O REPO JÁ É DOMÍNIO quando traz o próprio `flow.json`. A partir daí ele não
  // é só o dono do arquivo: é a FONTE. Divergência deixa de ser conflito para
  // resolver na mão e vira importação — o manifesto se atualiza a partir dele.
  //
  // O que motivou: o manifesto do musicavideo foi ESCRITO POR UM MODELO,
  // chutando como o domínio funciona, e o chute inventou um binário que não
  // existe e um contrato de saída errado. Os dois só falharam em produção
  // (MVD#87/#88, 2026-08-21). Definição adivinhada não pode competir de igual
  // para igual com a que o domínio versiona.
  const repoEhDominio = lerAtual('flow.json') !== undefined;

  const considerar = (caminho: string, conteudo: string): void => {
    const atual = lerAtual(caminho);
    if (atual === undefined) plano.escrever.push({ caminho, conteudo });
    // Comparação por conteúdo APARADO: um `\n` final a mais (que todo editor
    // põe e todo `JSON.stringify` não) não é divergência de definição, e tratá-lo
    // como conflito faria a operação idempotente falhar na segunda vez.
    else if (atual.trim() === conteudo.trim()) plano.iguais.push(caminho);
    else if (repoEhDominio) plano.importar.push({ caminho, conteudo: atual });
    else plano.conflitos.push(caminho);
  };

  considerar('flow.json', `${JSON.stringify(definicao.flow, null, 2)}\n`);
  for (const [caminho, corpo] of Object.entries(definicao.prompts)) considerar(caminho, corpo);
  if (definicao.help !== undefined) considerar('HELP.md', definicao.help);

  return plano;
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
