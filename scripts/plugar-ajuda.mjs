#!/usr/bin/env node
// Ponte entre o `plugar-repo.sh` (que faz IO) e o domínio (que decide).
//
// Existe porque validar manifesto e mexer em JSON são coisas com TESTE em
// `src/dominio/{manifesto,plugar}.ts`; refazê-las em `jq`/`sed` seria uma
// segunda implementação sem teste, divergindo da primeira no primeiro campo
// novo. Aqui não há regra nenhuma: só leitura de arquivo e chamada.
//
// Usa `dist/` porque é o que existe na VPS — o shell garante o build antes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  validarManifesto, paraEntradaSkill, paraEntradaFluxo, camposChutados,
} from '../dist/dominio/manifesto.js';
import {
  inserirEntradaSkill, inserirEntradaFluxo, chavesFaltando, invocacaoResolvida,
  planoMaterializacao,
} from '../dist/dominio/plugar.js';
import { carregarFlow } from '../dist/dominio/flow.js';

/** Comandos do catálogo: uma fase pode nomear uma SKILL como tarefa, e o
 *  validador do flow precisa da lista para não recusar as que existem. */
function comandosDoCatalogo(raizBot) {
  try {
    return JSON.parse(readFileSync(join(raizBot, 'config/skills.json'), 'utf8')).map((s) => s.command);
  } catch { return []; }
}

/**
 * Roda o validador REAL do `flow.json` sobre a definição que o manifesto
 * carrega, materializando-a num diretório TEMPORÁRIO.
 *
 * Por que o rodeio: `carregarFlow` lê do disco (é ele que confere que o prompt
 * de cada fase existe e não está vazio), e o manifesto traz tudo em memória. Sem
 * isto, o esquema do manifesto passaria e o `flow.json` produzido só seria
 * recusado no PRIMEIRO COMANDO do fluxo — depois de já ter sido escrito no repo
 * de domínio. Foi assim que um `versao_def` ausente atravessou a geração
 * inteira: o esquema do manifesto não o exige, o do flow.json sim.
 *
 * Temporário e não o repo real de propósito: validar não pode escrever no repo
 * dos outros.
 */
function conferirDefinicao(definicao, raizBot) {
  const tmp = mkdtempSync(join(tmpdir(), 'flow-conferir-'));
  try {
    const plano = planoMaterializacao(definicao, () => undefined);
    for (const a of plano.escrever) {
      const destino = join(tmp, a.caminho);
      mkdirSync(dirname(destino), { recursive: true });
      writeFileSync(destino, a.conteudo);
    }
    carregarFlow(tmp, comandosDoCatalogo(raizBot));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const [, , comando, ...args] = process.argv;

/** Aspas de shell à prova de valor hostil: o manifesto é DADO, e o shell o
 * consome com `eval`. Sem isto, `requer.bin: ["a b"]` já vira dois comandos —
 * e um manifesto de repo de terceiro viraria execução arbitrária. */
function sh(valor) {
  return `'${String(valor).replaceAll("'", `'\\''`)}'`;
}

function lerJson(caminho) {
  return JSON.parse(readFileSync(caminho, 'utf8'));
}

/** Erro do domínio é MENSAGEM, não pilha: quem lê é quem está instalando. */
function morrer(e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

try {
  if (comando === 'validar') {
    // `<manifesto.json>` → imprime `chave=valor` para o shell consumir com `eval`.
    const m = validarManifesto(lerJson(args[0]));
    const chutes = camposChutados(m);
    process.stdout.write([
      `M_COMMAND=${sh(m.command)}`,
      `M_URL=${sh(m.repo.url ?? '')}`,
      `M_COMMIT=${sh(m.repo.commit ?? '')}`,
      `M_PASTA=${sh(m.repo.pasta ?? m.command)}`,
      `M_PROMPT=${sh(m.prompt)}`,
      `M_FILA=${sh(m.fila)}`,
      `M_TIMEOUT=${sh(m.timeout_segundos)}`,
      `M_EXT=${sh(m.artefato_exts[0])}`,
      `M_BIN=${sh(m.requer.bin.join(' '))}`,
      `M_CHAVES=${sh(m.requer.chaves.join(' '))}`,
      `M_FONTES=${sh(m.requer.fontes.join(' '))}`,
      `M_CHUTES=${sh(chutes.join(' '))}`,
      `M_INVOCACAO=${sh(m.invocacao)}`,
    ].join('\n') + '\n');
  } else if (comando === 'chaves-faltando') {
    // `<cofre> <CHAVE...>` → imprime as que faltam (vazio = todas presentes).
    const [cofre, ...exigidas] = args;
    let texto = '';
    try { texto = readFileSync(cofre, 'utf8'); } catch { texto = ''; }
    process.stdout.write(`${chavesFaltando(texto, exigidas).join(' ')}\n`);
  } else if (comando === 'invocacao') {
    // `<manifesto.json> <caminho-do-repo>` → a linha com {{repo}} resolvido.
    const m = validarManifesto(lerJson(args[0]));
    process.stdout.write(`${invocacaoResolvida(m.invocacao, args[1])}\n`);
  } else if (comando === 'entrada') {
    // `<manifesto.json> <skills.json> <raiz-do-bot>`
    // → o skills.json JÁ com a entrada, na saída padrão; a AÇÃO, na de erro.
    // Não grava: quem grava é o shell, depois de te mostrar o diff.
    const [caminhoManifesto, caminhoSkills, raiz] = args;
    const m = validarManifesto(lerJson(caminhoManifesto));
    const entrada = paraEntradaSkill(m);
    const { texto, acao } = inserirEntradaSkill(readFileSync(caminhoSkills, 'utf8'), entrada, raiz);
    process.stderr.write(`${acao}\n`);
    process.stdout.write(texto);
  } else if (comando === 'validar-fluxo') {
    // `<manifesto.json>` → `chave=valor` para o shell. Espelha `validar`, mas o
    // que sai é outro conjunto: fluxo não tem invocação, fila nem extensão.
    const m = validarManifesto(lerJson(args[0]));
    if (m.rota !== 'fluxo') morrer(new Error(`manifesto: rota "${m.rota}" — este é o caminho de fluxo`));
    // O validador REAL do flow.json, num temporário. Recusar AQUI é o único
    // momento em que ainda não se escreveu no repo de domínio.
    if (m.definicao) conferirDefinicao(m.definicao, join(import.meta.dirname, '..'));
    process.stdout.write([
      `M_COMMAND=${sh(m.command)}`,
      `M_URL=${sh(m.repo.url ?? '')}`,
      `M_COMMIT=${sh(m.repo.commit ?? '')}`,
      `M_PASTA=${sh(m.repo.pasta ?? m.command)}`,
      `M_BIN=${sh(m.requer.bin.join(' '))}`,
      `M_CHAVES=${sh(m.requer.chaves.join(' '))}`,
      `M_FONTES=${sh(m.requer.fontes.join(' '))}`,
      `M_CHUTES=${sh(camposChutados(m).join(' '))}`,
      `M_TEM_DEFINICAO=${sh(m.definicao ? '1' : '')}`,
    ].join('\n') + '\n');
  } else if (comando === 'materializar') {
    // `<manifesto.json> <caminho-do-repo> [--sim]`
    // → lista o que faria; com --sim, escreve. NUNCA sobrescreve divergente.
    const [caminhoManifesto, repo, sim] = args;
    const m = validarManifesto(lerJson(caminhoManifesto));
    if (m.rota !== 'fluxo') morrer(new Error(`manifesto: rota "${m.rota}" — este é o caminho de fluxo`));
    if (!m.definicao) {
      // Sem definição o manifesto é só REGISTRO: o repo já é domínio.
      process.stdout.write('nada a materializar: o manifesto não traz definição\n');
    } else {
      const plano = planoMaterializacao(m.definicao, (c) => {
        try { return readFileSync(join(repo, c), 'utf8'); } catch { return undefined; }
      });
      for (const c of plano.conflitos) process.stdout.write(`CONFLITO ${c}\n`);
      for (const a of plano.importar) process.stdout.write(`IMPORTAR ${a.caminho} (a versão do DOMÍNIO vence)\n`);
      for (const c of plano.iguais) process.stdout.write(`IGUAL ${c}\n`);
      for (const a of plano.escrever) process.stdout.write(`ESCREVER ${a.caminho} (gerado — REVISE)\n`);
      // Conflito agora só sobra em repo que ainda NÃO é domínio (sem flow.json
      // próprio): ali não há fonte para importar, e sobrescrever arquivo alheio
      // continua fora de questão.
      if (plano.conflitos.length) {
        morrer(new Error(
          `o repo já tem ${plano.conflitos.length} arquivo(s) com conteúdo diferente do manifesto.`
          + ' O repo é o dono da definição: compare e decida você — nada foi escrito.',
        ));
      }
      if (sim === '--sim') {
        for (const a of plano.escrever) {
          const destino = join(repo, a.caminho);
          mkdirSync(dirname(destino), { recursive: true });
          writeFileSync(destino, a.conteudo);
        }
        // A SINCRONIZAÇÃO, no sentido que importa: domínio → manifesto. Sem
        // isto o manifesto guardaria para sempre a versão chutada, e o próximo
        // plug numa máquina limpa escreveria ela no repo como se fosse a
        // definição — que é exatamente como os prompts quebrados do musicavideo
        // chegaram à produção.
        if (plano.importar.length) {
          const bruto = JSON.parse(readFileSync(caminhoManifesto, 'utf8'));
          for (const a of plano.importar) {
            if (a.caminho === 'flow.json') bruto.definicao.flow = JSON.parse(a.conteudo);
            else if (a.caminho === 'HELP.md') bruto.definicao.help = a.conteudo;
            else bruto.definicao.prompts[a.caminho] = a.conteudo;
          }
          writeFileSync(caminhoManifesto, `${JSON.stringify(bruto, null, 2)}\n`);
          process.stdout.write(`manifesto atualizado a partir do domínio: ${plano.importar.length} arquivo(s)\n`);
        }
      }
    }
  } else if (comando === 'entrada-fluxo') {
    // `<manifesto.json> <fluxos.json> <PROJETOS_DIR>`
    // → o fluxos.json JÁ com a entrada, na saída padrão; a AÇÃO, na de erro.
    // Só passa DEPOIS de materializar: o validador vai ao disco atrás do flow.json.
    const [caminhoManifesto, caminhoFluxos, projetosDir] = args;
    const m = validarManifesto(lerJson(caminhoManifesto));
    if (m.rota !== 'fluxo') morrer(new Error(`manifesto: rota "${m.rota}" — este é o caminho de fluxo`));
    const { texto, acao } = inserirEntradaFluxo(
      readFileSync(caminhoFluxos, 'utf8'), paraEntradaFluxo(m), projetosDir,
    );
    process.stderr.write(`${acao}\n`);
    process.stdout.write(texto);
  } else {
    morrer(new Error(
      'uso: plugar-ajuda.mjs validar|chaves-faltando|invocacao|entrada'
      + '|validar-fluxo|materializar|entrada-fluxo',
    ));
  }
} catch (e) {
  morrer(e);
}
