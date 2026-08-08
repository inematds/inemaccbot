// Gramática do comando de skill: `<skill>: <entrada> [| campo]*`
//
// Portada do `parser.ts` do v1 (§5.1 "porta + estende"), com o que ela tinha de
// domínio embutido tirado fora: lá o parser conhecia `vertical`, `pesquisa`,
// `narracao`, `visuais`, `mover`, e cada skill nova exigia mexer nele. Aqui os
// campos são genéricos — destino e perfil de execução — e o que é específico de
// uma skill vive no prompt dela.
//
// Duas portas (§1.1): o que casa com um `command` do registry vira job; o resto
// é texto livre e vai para o `interpret`. Um `:` na frase ("hoje: choveu") não
// pode virar comando por acidente, e por isso a checagem é por igualdade contra
// o catálogo, nunca por formato.
import { ehTokenDestino, listarDestinos, resolverDestino } from '../dominio/destinos.js';
import { acharSkill, type SkillDef } from '../dominio/registry.js';

export interface PedidoSkill {
  command: string;
  entrada: string;
  /** Caminho já resolvido do destino (`| lives3`), quando houver. */
  destino?: string;
  destinoToken?: string;
  perfil?: { motor?: string; modelo?: string; esforco?: string };
  /** Campos declarados pela skill, já com os defaults preenchidos. */
  campos?: Record<string, string>;
}

export type Analise =
  | { tipo: 'skill'; pedido: PedidoSkill }
  | { tipo: 'livre'; texto: string }
  | { tipo: 'erro'; mensagem: string };

const CAMPO_PERFIL = /^(motor|modelo|esforco|esforço)\s*=\s*(.+)$/i;

/**
 * `defs` é o catálogo; `projetosDir` é onde os destinos vivem. Nenhum efeito
 * colateral além de LER o disco para resolver o destino — o disco é a fonte da
 * lista de canais (ver `dominio/destinos.ts`).
 */
export function analisar(texto: string, defs: SkillDef[], projetosDir: string): Analise {
  const linha = texto.trim();
  const m = linha.match(/^([a-zA-Z0-9-]+)\s*:\s*([\s\S]*)$/);
  if (!m) return { tipo: 'livre', texto: linha };

  const def = acharSkill(defs, m[1].toLowerCase());
  if (!def) return { tipo: 'livre', texto: linha };

  // O primeiro segmento é a entrada, tomado POSICIONALMENTE — antes de filtrar
  // vazios. Senão uma entrada vazia "some" e o primeiro campo vira a entrada
  // (defeito real do v1, corrigido lá e preservado aqui).
  const partes = m[2].split('|').map((s) => s.trim());
  const entrada = partes.shift() ?? '';
  if (!entrada) {
    return { tipo: 'erro', mensagem: `faltou o que vem depois de "${def.command}:" — ex.: ${def.exemplo}` };
  }

  const pedido: PedidoSkill = { command: def.command, entrada };
  // Defaults primeiro: o prompt recebe TODOS os campos declarados, sempre. Sem
  // isso, um campo omitido no comando viraria `{{vertical}}` sem valor, e
  // `renderizarPrompt` derrubaria o job em vez do comando.
  const campos: Record<string, string> = Object.fromEntries(
    Object.entries(def.campos).map(([nome, c]) => [nome, c.padrao]),
  );

  for (const campo of partes.filter(Boolean)) {
    const declarado = casarCampoDeclarado(campo, def);
    if (declarado) {
      if ('erro' in declarado) return { tipo: 'erro', mensagem: declarado.erro };
      campos[declarado.nome] = declarado.valor;
      continue;
    }
    const perfil = campo.match(CAMPO_PERFIL);
    if (perfil) {
      const chave = perfil[1].toLowerCase() === 'esforço' ? 'esforco' : perfil[1].toLowerCase();
      pedido.perfil = { ...pedido.perfil, [chave]: perfil[2].trim().toLowerCase() };
      continue;
    }
    if (ehTokenDestino(campo)) {
      if (!def.aceita_destino) {
        return { tipo: 'erro', mensagem: `"${def.command}" não entrega em destino — o resultado volta aqui no chat.` };
      }
      const destino = resolverDestino(campo, projetosDir);
      if (!destino) {
        const validos = listarDestinos(projetosDir).join(', ') || '(nenhum)';
        return { tipo: 'erro', mensagem: `destino "${campo}" não existe — válidos: ${validos}` };
      }
      pedido.destino = destino;
      pedido.destinoToken = campo.trim().toLowerCase();
      continue;
    }
    return {
      tipo: 'erro',
      mensagem: `campo desconhecido: "${campo}"${dica(def)}`,
    };
  }

  if (Object.keys(campos).length) pedido.campos = campos;
  return { tipo: 'skill', pedido };
}

/**
 * Casa um segmento contra os campos DECLARADOS pela skill.
 *
 *   `| vertical`            → bandeira ligada
 *   `| curso skillsx`       → texto
 *   `| curso=skillsx`       → texto (as duas formas, porque as duas são digitadas)
 *
 * Devolve `undefined` quando o segmento não é campo desta skill — aí quem tenta
 * é o perfil, depois o destino, e por fim vira erro nomeado.
 */
function casarCampoDeclarado(
  campo: string, def: SkillDef,
): { nome: string; valor: string } | { erro: string } | undefined {
  const m = campo.match(/^([a-zA-Z][a-zA-Z0-9_]*)(?:\s*[=\s]\s*([\s\S]+))?$/);
  if (!m) return undefined;
  const nome = m[1].toLowerCase();
  const c = def.campos[nome];
  if (!c) return undefined;
  const valor = (m[2] ?? '').trim();

  if (c.tipo === 'bandeira') {
    if (valor === '') return { nome, valor: 'sim' };
    const v = valor.toLowerCase();
    if (['sim', 'nao', 'não', 'true', '1'].includes(v)) return { nome, valor: 'sim' };
    if (['nao', 'não', 'false', '0'].includes(v)) return { nome, valor: 'não' };
    return { erro: `"${nome}" é bandeira: use só "| ${nome}" (ou "| ${nome}=não")` };
  }

  if (valor === '') return { erro: `"${nome}" precisa de um valor — ex.: "| ${nome} algo"` };
  // Sem espaço: estes valores viram nome de arquivo na entrega. Regra herdada do
  // v1, que rejeitava "curso t1 m1" pelo mesmo motivo.
  if (/\s/.test(valor)) return { erro: `"${nome}" não pode ter espaço — ex.: "| ${nome} t1m1"` };
  return { nome, valor };
}

function dica(def: SkillDef): string {
  const nomes = Object.keys(def.campos);
  const partes = [
    ...nomes,
    ...(def.aceita_destino ? ['livesN'] : []),
    'modelo=…', 'esforco=…',
  ];
  return ` — "${def.command}" aceita: ${partes.join(', ')}`;
}

/** Lista do `/skills`: é o catálogo real, nunca uma lista escrita à mão. */
export function textoSkills(defs: SkillDef[]): string {
  return [
    'Skills disponíveis:',
    ...defs.map((d) => `\n• ${d.command} — ${d.descricao}\n  ex.: ${d.exemplo}`),
  ].join('\n');
}
