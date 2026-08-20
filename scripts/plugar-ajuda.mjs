#!/usr/bin/env node
// Ponte entre o `plugar-repo.sh` (que faz IO) e o domínio (que decide).
//
// Existe porque validar manifesto e mexer em JSON são coisas com TESTE em
// `src/dominio/{manifesto,plugar}.ts`; refazê-las em `jq`/`sed` seria uma
// segunda implementação sem teste, divergindo da primeira no primeiro campo
// novo. Aqui não há regra nenhuma: só leitura de arquivo e chamada.
//
// Usa `dist/` porque é o que existe na VPS — o shell garante o build antes.
import { readFileSync } from 'node:fs';


import { validarManifesto, paraEntradaSkill, camposChutados } from '../dist/dominio/manifesto.js';
import { inserirEntradaSkill, chavesFaltando, invocacaoResolvida } from '../dist/dominio/plugar.js';

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
      `M_URL=${sh(m.repo.url)}`,
      `M_COMMIT=${sh(m.repo.commit ?? '')}`,
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
    // `<manifesto.json> <skills.json> <raiz-do-bot> <descricao> <exemplo>`
    // → o skills.json JÁ com a entrada, na saída padrão; a AÇÃO, na de erro.
    // Não grava: quem grava é o shell, depois de te mostrar o diff.
    const [caminhoManifesto, caminhoSkills, raiz, descricao, exemplo] = args;
    const m = validarManifesto(lerJson(caminhoManifesto));
    const entrada = paraEntradaSkill(m, descricao, exemplo);
    const { texto, acao } = inserirEntradaSkill(readFileSync(caminhoSkills, 'utf8'), entrada, raiz);
    process.stderr.write(`${acao}\n`);
    process.stdout.write(texto);
  } else {
    morrer(new Error(`uso: plugar-ajuda.mjs validar|chaves-faltando|invocacao|entrada`));
  }
} catch (e) {
  morrer(e);
}
