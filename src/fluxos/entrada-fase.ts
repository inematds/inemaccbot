// Como cada FASE vira o `input` de um job.
//
// §3.1: "uma fase não executa nada — descreve qual job enfileirar". Este arquivo
// é essa tradução, e é o único lugar onde o runtime precisa saber que existe
// mais de um tipo de tarefa de fase.
//
// A regra que o §3.2 impõe e que está implementada aqui: **o domínio diz para
// QUEM, o bot sabe ONDE.** O `flow.json` referencia o canal por nome
// (`lives21`); quem resolve isso para um caminho no disco é o registry de
// destinos do bot. Um `flow.json` com caminho embutido seria uma cópia
// divergente da lista de canais esperando para envelhecer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolverDestino } from '../dominio/destinos.js';
import { sanearValorDeRecibo } from './runtime.js';
import { primeiraFala } from '../dominio/roteiro.js';
import { ctaDaDefinicao } from '../dominio/flow.js';
import type { FaseDef, FlowDef } from '../dominio/flow.js';
import type { Fluxo } from './estado.js';

export interface ContextoEntrada {
  fluxo: Fluxo;
  def: FlowDef;
  fase: FaseDef;
  alvo: string;
  /** `dados` da fase anterior daquele alvo — normalmente um caminho de arquivo. */
  anterior?: string | null;
  raizArtefatos: string;
  projetosDir: string;
  /** Repo de domínio deste fluxo (`config/fluxos.json`). Sem ele a fase de
   * texto não recebe `{{pasta}}` — ver `pastaTextos`. */
  repoDominio?: string;
  /** Públicos REAIS deste fluxo, já filtrados por `| alvos=`. Vira `{{publicos}}`. */
  alvosDoFluxo?: string[];
}

/**
 * Onde a fase de texto grava um arquivo por público.
 *
 * O bot DITA este caminho, e isso foi pago em produção: o prompt pedia um
 * caminho relativo (`textos/<slug-do-assunto>/`) e o job rodava com
 * `cwd: homedir()`, então o agente escolhia o repo e o slug sozinho — o A#1
 * gravou os 12 textos e o commit no repo do `promoavatar`, não no do
 * `promoavatar`. Caminho escolhido pelo agente é caminho que o portão não
 * consegue reencontrar.
 *
 * `A1` e não o slug do assunto porque o portão precisa achar a pasta sabendo só
 * o fluxo, e dois fluxos com o mesmo assunto não podem colidir.
 */
export function pastaTextos(repoDominio: string, fluxo: Fluxo): string {
  return `${repoDominio}/textos/${fluxo.prefixo}${fluxo.id}`;
}

/**
 * Título do vídeo no estúdio: `P16-mulheres-v1`.
 *
 * CURTO de propósito, e isso foi pago em produção: o título longo truncava no
 * HeyGen, e o download — que casa PELO TÍTULO — nunca encontrava o vídeo. É
 * também a chave de idempotência da fase de download (§2.5).
 */
export function tituloEstudio(fluxo: Fluxo, alvo: string): string {
  return `${fluxo.prefixo}${fluxo.id}-${alvo}-v${fluxo.versao}`;
}

/** O `.mp4` que a fase de download grava, e que a fase de reel consome. */
export function caminhoAvatar(raizArtefatos: string, fluxo: Fluxo, alvo: string): string {
  return `${raizArtefatos}/fluxos/${fluxo.prefixo}${fluxo.id}/${tituloEstudio(fluxo, alvo)}.mp4`;
}

export function montarInput(ctx: ContextoEntrada): string {
  const { fluxo, def, fase, alvo } = ctx;
  const dadosAlvo = alvo ? def.alvos[alvo] ?? {} : {};
  const base = {
    fluxo: { ref: `${fluxo.prefixo}#${fluxo.id}`, fase: fase.id, alvo, ...dadosAlvo },
  };

  // `cli.rodar` — o CLI do domínio, sem agente. Os marcadores viram uma linha de
  // comando AQUI, onde o bot conhece repo, ref, alvo e a entrada do usuário; a
  // tarefa só executa. Ver o cabeçalho de `fila/tarefas/cli.ts` para o que isso
  // deixou de custar.
  if (fase.tarefa === 'cli.rodar') {
    const saida = `${ctx.raizArtefatos}/fluxos/${fluxo.prefixo}${fluxo.id}`
      + `/${fase.id}${alvo ? `-${alvo}` : ''}.txt`;
    return JSON.stringify({
      ...base,
      comando: resolverComando(fase.comando ?? '', {
        repo: ctx.repoDominio ?? '',
        input: fluxo.assunto,
        alvo,
        ref: `${fluxo.prefixo}${fluxo.id}`,
        saida,
        // O recibo da fase ANTERIOR: é por ele que passa o dado que só o
        // domínio sabe montar — o slug, derivado do texto e desambiguado com
        // `-2`, que o bot nunca conhece.
        anterior: ctx.anterior ?? '',
      }),
      // O cwd é o repo de DOMÍNIO, como nas fases de agente: é onde o script
      // mora e onde ele espera estar.
      cwd: ctx.repoDominio ?? '',
      saida,
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  if (fase.tarefa === 'heygen.baixar') {
    return JSON.stringify({
      ...base,
      titulo: tituloEstudio(fluxo, alvo),
      destino: caminhoAvatar(ctx.raizArtefatos, fluxo, alvo),
      // A janela de poll vem da DEFINIÇÃO CONGELADA, não de um default do
      // worker: sem o `timeout` viajando com o job, um vídeo que a pessoa nunca
      // gera é pollado para sempre — `reagendar` não gasta tentativa, então a
      // fase nunca falharia e o `/status` diria "rodando" indefinidamente.
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  // A fase `gerar` (opção `| api`): o bot manda O QUE falar, com que rosto e
  // com que voz. O TÍTULO é o mesmo que a fase `baixar` vai procurar — é o que
  // dispensa carregar `video_id` de uma fase para a outra, e o que faz a fase
  // seguinte não precisar saber se o vídeo veio da API ou da mão de alguém.
  if (fase.tarefa === 'heygen.gerar' || fase.tarefa === 'heygen.gerar-creditos') {
    return JSON.stringify({
      ...base,
      titulo: tituloEstudio(fluxo, alvo),
      // A FALA sai do MESMO arquivo que o portão manda no chat — se o texto que
      // a pessoa revisaria e o que o avatar fala pudessem divergir, o portão
      // deixaria de ser revisão de nada.
      texto: falaDoAlvo(ctx.repoDominio, fluxo, alvo),
      // O alvo pode sobrescrever avatar e voz (um público com outra voz não
      // deveria obrigar a criar outro fluxo).
      avatarId: dadosAlvo.avatar_id ?? def.avatar_id ?? '',
      voiceId: dadosAlvo.voice_id ?? def.voice_id ?? '',
      // Motor: do alvo, do fluxo, ou o padrão barato da tarefa. Nunca o default
      // da API (Avatar IV), que custa 3 a 4× mais pelo mesmo minuto.
      ...(dadosAlvo.engine ?? def.engine ? { engine: dadosAlvo.engine ?? def.engine } : {}),
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  // A rota do ESTÚDIO por script (`| estudio`). Precisa do TÍTULO — que é o
  // contrato com a fase `baixar` — e da FALA. NÃO precisa de avatar, voz nem
  // motor: eles vêm do template clonado, e é exatamente por isso que esta rota
  // existe ao lado do `| creditos`, que monta o vídeo sem template.
  if (fase.tarefa === 'heygen.estudio') {
    return JSON.stringify({
      ...base,
      titulo: tituloEstudio(fluxo, alvo),
      texto: falaDoAlvo(ctx.repoDominio, fluxo, alvo),
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  // A fase de reel como FUNÇÃO (`reel.montar`). Aqui está a razão de ela poder
  // deixar de ser agente: TODOS os campos abaixo são derivados do fluxo e do
  // alvo, e o bot já os conhece. O agente recebia só o caminho do avatar e
  // tinha que RE-DERIVAR `REF` e `público` parseando esse nome — um dado que
  // este mesmo arquivo tinha gerado em `caminhoAvatar`. Era esse round-trip que
  // pagava US$ 0,18 por reel e produzia os erros de identificação de público.
  if (fase.tarefa === 'reel.montar') {
    const titulo = tituloEstudio(fluxo, alvo);
    return JSON.stringify({
      ...base,
      // `anterior` é o `.mp4` que a fase `baixar` devolveu; o caminho canônico
      // é o mesmo, e serve de rede quando a fase roda solta.
      avatar: ctx.anterior || caminhoAvatar(ctx.raizArtefatos, fluxo, alvo),
      alvo,
      textos: ctx.repoDominio ? join(pastaTextos(ctx.repoDominio, fluxo), `${alvo}.md`) : '',
      // Determinística por fluxo × alvo × versão, e NÃO pelo id do job: é isso
      // que faz o "procure antes de criar" continuar valendo numa retentativa,
      // que nasce com outro id.
      saida: `${ctx.raizArtefatos}/reel/${titulo}.mp4`,
      ws: `${ctx.projetosDir}/output/reels/${titulo}`,
      // O MOTOR pode morar em outro repo (`motor_repo` no flow.json): o
      // promoavatar3 usa os scripts do promoavatar em vez de manter uma cópia
      // que diverge — foi cópia velha de `preparar.py` que produziu o
      // `template: None` do A#23.
      script: motorDoReel(ctx),
      // ...e por isso o `flow.json` do DOMÍNIO viaja junto: é dele que saem os
      // templates e o layout padrão, não do repo onde o script mora.
      ...(ctx.repoDominio ? { flow: join(ctx.repoDominio, 'flow.json') } : {}),
      // O clipe de encerramento sai da definição CONGELADA, não do disco: um
      // fluxo criado como viral tem que terminar com o clipe da variante mesmo
      // que alguém edite o `flow.json` do domínio no meio da execução (§3.4).
      // Sem declaração, nada é passado e vale o default do `montar-reel.py`.
      ...(ctx.repoDominio && ctaDaDefinicao(def)
        ? { cta: join(ctx.repoDominio, ctaDaDefinicao(def) as string) }
        : {}),
      // O canal do público, resolvido para uma pasta pelo registry de destinos
      // (§3.2: o domínio diz para QUEM, o bot sabe ONDE). Sem isto o reel fica
      // no artefato do bot e NÃO chega ao canal — foi o que aconteceu com o
      // A#30/A#31/A#32 quando a fase virou função: o `destino` só era montado
      // no branch de skill, porque quem copiava era o agente.
      ...(dadosAlvo.canal
        ? { destino: resolverDestino(dadosAlvo.canal, ctx.projetosDir) ?? undefined }
        : {}),
      // Legenda desligada na criação (`| legenda=nao`) vira `--sem-legenda`.
      // Sai da definição CONGELADA, como o CTA: quem criou o fluxo sem legenda
      // continua sem legenda mesmo que o default do domínio mude no meio (§3.4).
      ...(def.legenda === false ? { semLegenda: true } : {}),
      ...(fase.espera ? { espera: fase.espera } : {}),
    });
  }

  // Skill do catálogo (a última fase do promoavatar é a MESMA skill `reel` que o
  // usuário dispara no chat — fluxo é cliente da fila como qualquer um, §3.2).
  if (fase.kind === 'agent' && !fase.prompt_texto) {
    const arquivo = ctx.anterior ?? '';
    const canal = dadosAlvo.canal;
    const destino = canal ? resolverDestino(canal, ctx.projetosDir) : null;
    return JSON.stringify({
      ...base,
      entrada: [arquivo, instrucaoExtra(fase, dadosAlvo, alvo)].filter(Boolean).join(' '),
      ...(destino ? { destino } : {}),
    });
  }

  // Fase de agente com prompt próprio (`fluxo-agente`, `fluxo-navegador`).
  //
  // `pasta` entra DENTRO de `fluxo` porque `contextoDeFase` (fila/skills.ts)
  // promove a variável todo campo string daí — é como `canal` e `gatilho`
  // chegam ao prompt, e evita um caminho especial só para esta.
  // `publicos` existe porque o filtro de alvos NÃO chegava ao prompt: o A#4
  // nasceu com 1 alvo e o agente escreveu 12 arquivos, já que o texto dizia
  // "para TODOS os públicos do pipeline". O fluxo sabia; o prompt não.
  const extra: Record<string, string> = {
    // `repo` vira o `cwd` do processo do agente (ver `contextoDeFase`). Sem
    // isto o job roda em `homedir()` e NÃO enxerga as skills de projeto do
    // domínio: o A#5 falhou duas vezes com "skill inemaclub-textos não
    // encontrada" porque ela mora em `<repo>/.claude/skills/`. É também o
    // diretório onde o prompt manda commitar.
    ...(ctx.repoDominio ? { repo: ctx.repoDominio, pasta: pastaTextos(ctx.repoDominio, fluxo) } : {}),
    ...(ctx.alvosDoFluxo?.length ? { publicos: ctx.alvosDoFluxo.join(', ') } : {}),
  };
  return JSON.stringify({
    ...base,
    ...(Object.keys(extra).length ? { fluxo: { ...base.fluxo, ...extra } } : {}),
    entrada: fluxo.assunto,
    ...(fase.prompt_texto ? { prompt_texto: fase.prompt_texto } : {}),
    ...(alvo ? { titulo: tituloEstudio(fluxo, alvo) } : {}),
  });
}

/**
 * O que o domínio quer dizer à skill além do arquivo. Vem do `flow.json` (campo
 * `entrega` da fase, com `{gatilho}`/`{alvo}` resolvidos) — não daqui: a
 * headline de capa é decisão de quem entende do público, não do bot.
 */
/**
 * Onde está o `montar-reel.py` deste domínio.
 *
 * `motor_repo` no `flow.json` aponta para o repo que HOSPEDA o motor; sem ele,
 * o motor é o do próprio domínio. Um motor para N domínios evita a cópia que
 * envelhece — a skill `reel-promoavatar` existe por causa de uma.
 */
function motorDoReel(ctx: ContextoEntrada): string {
  const repo = ctx.def.motor_repo
    ? join(ctx.projetosDir, ctx.def.motor_repo)
    : ctx.repoDominio;
  return repo ? join(repo, 'scripts', 'montar-reel.py') : '';
}

function instrucaoExtra(
  fase: FaseDef,
  dadosAlvo: Record<string, string | undefined>,
  alvo?: string,
): string {
  if (!fase.entrega) return '';
  // `{alvo}` é o NOME DO PÚBLICO, e faltava: só os campos declarados no
  // `flow.json` (canal, gatilho) chegavam aqui. Sem ele, quem escreve a entrega
  // não tem como citar o público e acaba usando `{canal}` — foi o A#25/
  // pessoa-comum: a instrução dizia "público lives2", o agente acreditou e
  // procurou `textos/A25/lives2.md`, que não existe. O canal é destino de
  // publicação, não identidade do público.
  const campos: Record<string, string | undefined> = { ...dadosAlvo, ...(alvo ? { alvo } : {}) };
  return fase.entrega.replace(/\{(\w+)\}/g, (bruto, chave: string) => campos[chave] ?? bruto);
}

/**
 * A FALA do roteiro daquele alvo — o que o avatar vai dizer.
 *
 * Lê o MESMO arquivo que o portão manda no chat (`<pasta>/<alvo>.md`), e extrai
 * a mesma seção. Se o texto revisado no portão e o texto falado pudessem
 * divergir, o portão deixaria de ser revisão de coisa nenhuma.
 *
 * Vazio quando o arquivo não existe ou não tem `### FALA`: quem reclama é a
 * tarefa `heygen.gerar`, com o título no erro — melhor que um vídeo mudo, e
 * melhor que uma exceção sem contexto na montagem do input.
 */
function falaDoAlvo(repo: string | undefined, fluxo: Fluxo, alvo: string): string {
  if (!repo || !alvo) return '';
  try {
    return primeiraFala(readFileSync(join(pastaTextos(repo, fluxo), `${alvo}.md`), 'utf8')) ?? '';
  } catch {
    return '';
  }
}

/**
 * Marcador → valor, com ASPAS POSIX em tudo que vem de fora.
 *
 * O `{{input}}` é texto que o usuário digitou no Telegram. Interpolar isso numa
 * linha de `bash -c` sem aspar é a diferença entre um assunto com aspas simples
 * e um comando arbitrário rodando no repo de domínio. Aspar aqui — e não pedir
 * ao domínio que se lembre de aspar no `flow.json` — é o que faz a regra valer
 * para todo domínio, inclusive o que ainda não existe.
 *
 * Marcador sem valor vira string vazia ASPADA (`''`), nunca o marcador cru: um
 * `{{alvo}}` sobrando na linha de comando seria interpretado pelo shell.
 */
export function resolverComando(
  molde: string,
  campos: {
    repo: string; input: string; alvo: string; ref: string; saida: string; anterior?: string;
  },
  ler: (caminho: string) => string = (c) => readFileSync(c, 'utf8'),
): string {
  return molde.replace(/\{\{([\w:]+)\}\}/g, (_, chave: string) => {
    // `{{anterior:campo}}` — o valor de `campo:` DENTRO do recibo da fase
    // anterior, mesma gramática do `portao.mostrar`. É por onde passa o dado
    // que só o domínio sabe montar: o slug do musicavideo é derivado do texto e
    // desambiguado com `-2`, e sem isto a fase seguinte teria que adivinhar —
    // que era o que o agente fazia, e errava.
    //
    // Campo ausente vira string vazia ASPADA: um argumento vazio, que o domínio
    // recusa com mensagem própria, é melhor que um marcador cru no shell.
    if (chave.startsWith('anterior:')) {
      if (!campos.anterior) return aspar('');
      try {
        const achado = new RegExp(`^\\s*${chave.slice('anterior:'.length)}\\s*:\\s*(.+)$`, 'im')
          .exec(ler(campos.anterior));
        // SANEADO antes de aspar: uma linha, sem controles, com teto de
        // tamanho. As aspas já impedem o valor de virar comando; o saneamento
        // impede que ele quebre a linha ou entre um `\n` no meio do argumento.
        return aspar(achado ? sanearValorDeRecibo(achado[1]!) : '');
      } catch {
        return aspar('');
      }
    }
    const valor = (campos as Record<string, string>)[chave] ?? '';
    // O `{{repo}}` entra SEM aspas quando é um caminho simples, para o comando
    // ficar legível no log e no `/status`; qualquer coisa fora de [\w/.-] volta
    // a ser aspada. Os outros campos são sempre aspados.
    if (chave === 'repo' && /^[\w/.@+-]+$/.test(valor)) return valor;
    return aspar(valor);
  });
}

/** Aspas simples no estilo POSIX: nenhum texto vira comando. */
function aspar(s: string): string {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}
