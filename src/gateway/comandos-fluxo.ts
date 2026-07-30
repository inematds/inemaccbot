// Comandos de FLUXO. Separado de `comandos.ts` porque aquele arquivo é síncrono
// e sem estado além da fila; aqui há leitura de disco (o `flow.json` do repo de
// domínio) e um runtime.
//
// `/status`, `/refazer` e `/cancelar` são os MESMOS verbos dos jobs — o que
// muda é o argumento: `12` é job, `P#16` é fluxo. Ter dois verbos para a mesma
// pergunta seria atrito puro.
import { carregarFlow, congelar, hashDefinicao, parseRef } from '../dominio/flow.js';
import type { FluxoRegistrado } from '../dominio/registry-fluxos.js';
import type { Fase } from '../fluxos/estado.js';
import type { Fluxos } from '../fluxos/runtime.js';

export interface DepsFluxo {
  fluxos: Fluxos;
  registrados: FluxoRegistrado[];
  chatId: number;
  /** Comandos das skills do catálogo. Uma FASE pode disparar uma skill (a
   * última do promoclub é a mesma `reel` do chat), e a validação do `flow.json`
   * precisa conhecê-las para não recusar o que existe. */
  skills?: string[];
}

const ICONE: Record<Fase['estado'], string> = {
  pendente: '·', rodando: '▶️', feito: '✅', 'aguardando-ok': '⏸️',
  falhou: '❌', pulado: '⏭️',
};

export function textoFluxos(registrados: FluxoRegistrado[]): string {
  if (!registrados.length) {
    return 'nenhum fluxo registrado ainda. O motor está pronto; falta o repo de domínio.';
  }
  return [
    'Fluxos disponíveis:',
    ...registrados.map((f) => `\n• /${f.command} — ${f.descricao}\n  ex.: ${f.exemplo}`),
  ].join('\n');
}

/**
 * `/<fluxo> <assunto> [| alvos=a,b] [| versao=N] [| sombra]`
 *
 * `sombra` monta o plano e NÃO enfileira (§7.5) — é como se confere um
 * `flow.json` novo antes de gastar GPU.
 */
export function criarFluxo(
  registrado: FluxoRegistrado, argumento: string, deps: DepsFluxo,
): string {
  const partes = argumento.split('|').map((s) => s.trim());
  const assunto = partes.shift() ?? '';
  if (!assunto) return `faltou o assunto — ex.: ${registrado.exemplo}`;

  let alvos: string[] | undefined;
  let versao: number | undefined;
  let sombra = false;
  for (const campo of partes.filter(Boolean)) {
    const m = campo.match(/^(alvos|versao|versão)\s*=\s*(.+)$/i);
    if (m) {
      if (m[1].toLowerCase() === 'alvos') {
        alvos = m[2].split(',').map((a) => a.trim()).filter(Boolean);
      } else {
        const n = Number(m[2].trim());
        if (!Number.isInteger(n) || n <= 0) return `versão inválida: "${m[2].trim()}"`;
        versao = n;
      }
      continue;
    }
    if (campo.toLowerCase() === 'sombra') { sombra = true; continue; }
    return `campo desconhecido: "${campo}" — aceito: alvos=a,b · versao=N · sombra`;
  }

  // A definição é lida do disco AQUI e congelada na criação. Um `flow.json`
  // inválido é recusado agora, com o usuário na frente, e não no primeiro job.
  let definicao;
  let hash: string;
  try {
    const doDisco = carregarFlow(registrado.repo, deps.skills ?? []);
    hash = hashDefinicao(doDisco, registrado.repo);
    // Congela AQUI: daqui para frente o fluxo não depende mais do disco do repo
    // de domínio, nem para o texto dos prompts.
    definicao = congelar(doDisco, registrado.repo);
  } catch (e) {
    return `não consegui ler a definição do fluxo: ${(e as Error).message}`;
  }

  const pedido = {
    tipo: registrado.command, definicao, hash, assunto, alvos, versao,
    chatId: deps.chatId,
  };

  try {
    if (sombra) {
      const plano = deps.fluxos.sombra(pedido);
      return [
        `sombra de /${registrado.command} — ${plano.length} job(s), NADA foi enfileirado:`,
        ...plano.map((p) => `  ${p.fase} · ${p.alvo} · ${p.fila}/${p.tarefa} (${p.kind})`),
      ].join('\n');
    }
    const fluxo = deps.fluxos.criar(pedido);
    const total = Object.keys(definicao.alvos).length;
    return `criado: ${fluxo.prefixo}#${fluxo.id} (${alvos?.length ?? total} alvo(s)) — acompanhe com /status ${fluxo.prefixo}#${fluxo.id}`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Tabela fase × alvo do `/status P#16`. */
export function statusFluxo(ref: string, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  // Prefixo errado é recusa, não "acha o mais parecido": `P#16` e `B#16` são
  // fluxos diferentes, e agir no errado seria pior que não agir.
  if (!visao || visao.fluxo.prefixo !== r.prefixo) {
    return `${ref} não existe neste bot.`;
  }

  const { fluxo, fases } = visao;
  const linhas = [
    `${fluxo.prefixo}#${fluxo.id} — ${fluxo.tipo}: ${fluxo.assunto}`,
    `status: ${fluxo.status} · versão da definição: ${fluxo.versao_def}`,
  ];
  const porFase = new Map<string, Fase[]>();
  for (const f of fases) {
    const lista = porFase.get(f.fase) ?? [];
    lista.push(f);
    porFase.set(f.fase, lista);
  }
  for (const [fase, lista] of porFase) {
    const alvos = lista
      .map((f) => `${ICONE[f.estado]} ${f.alvo || '(todos)'}`)
      .join(' · ');
    linhas.push(`${fase}: ${alvos}`);
  }
  const esperando = fases.filter((f) => f.estado === 'aguardando-ok');
  if (esperando.length) {
    linhas.push('', `⏸️ esperando você em "${esperando[0]!.fase}" — libere com /aprovar ${fluxo.prefixo}#${fluxo.id}`);
  }
  const falhas = fases.filter((f) => f.estado === 'falhou');
  if (falhas.length) {
    linhas.push('', 'Falhas:');
    for (const f of falhas) linhas.push(`  ${f.alvo || '(todos)'}/${f.fase}: ${(f.erro ?? '').slice(0, 200)}`);
    linhas.push(`Retentar: /refazer ${fluxo.prefixo}#${fluxo.id} [alvo]`);
  }
  return linhas.join('\n');
}

/** `/aprovar P#16` — solta o portão humano. */
export function aprovarFluxo(ref: string, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  const { liberados, fase } = deps.fluxos.aprovar(r.id);
  if (!liberados) return `${ref} não está esperando aprovação agora.`;
  return `${ref}: ${fase} aprovada — ${liberados} job(s) enfileirado(s).`;
}

export function refazerFluxo(ref: string, alvo: string | undefined, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  const { refeitos } = deps.fluxos.refazer(r.id, alvo);
  if (!refeitos) return `nada a refazer em ${ref}${alvo ? ` (alvo ${alvo})` : ''} — nenhuma fase falhou.`;
  return `${ref}: ${refeitos} fase(s) reenfileirada(s).`;
}

export function cancelarFluxo(ref: string, alvo: string | undefined, deps: DepsFluxo): string | undefined {
  const r = parseRef(ref);
  if (!r) return undefined;
  const visao = deps.fluxos.status(r.id);
  if (!visao || visao.fluxo.prefixo !== r.prefixo) return `${ref} não existe neste bot.`;
  const { cancelados } = deps.fluxos.cancelar(r.id, alvo);
  return [
    `${ref}${alvo ? ` (alvo ${alvo})` : ''} cancelado — ${cancelados} job(s) interrompido(s).`,
    // §3.7: operação externa já criada NÃO é desfeita. Dizer isso é parte do
    // contrato de cancelamento, não gentileza.
    'O que já tiver sido criado fora (render no estúdio, arquivo entregue) continua lá.',
  ].join('\n');
}
