#!/usr/bin/env node
// Ponte entre o `plugar-repo.sh` (que faz IO) e o domínio (que decide).
//
// Existe porque validar manifesto e mexer em JSON são coisas com TESTE em
// `src/dominio/{manifesto,plugar}.ts`; refazê-las em `jq`/`sed` seria uma
// segunda implementação sem teste, divergindo da primeira no primeiro campo
// novo. Aqui não há regra nenhuma: só leitura de arquivo e chamada.
//
// Usa `dist/` porque é o que existe na VPS — o shell garante o build antes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  validarManifesto, paraEntradaSkill, paraEntradaFluxo, camposChutados,
} from '../dist/dominio/manifesto.js';
import {
  inserirEntradaSkill, inserirEntradaFluxo, chavesFaltando, invocacaoResolvida,
  planoMaterializacao,
} from '../dist/dominio/plugar.js';

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
      for (const c of plano.iguais) process.stdout.write(`IGUAL ${c}\n`);
      for (const a of plano.escrever) process.stdout.write(`ESCREVER ${a.caminho}\n`);
      // O conflito PARA a instalação: o repo é o dono da definição, e
      // sobrescrever flow.json alheio apagaria a máquina de estados de um fluxo
      // que pode estar em produção.
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
