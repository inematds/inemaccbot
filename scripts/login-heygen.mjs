// Abre o perfil de Chromium do bot COM JANELA para você logar no HeyGen na mão.
//
//   DISPLAY=:10 node scripts/login-heygen.mjs [--perfil <dir>] [--minutos 15]
//
// Por que existe: a rota `| estudio` não usa API key nem OAuth — ela dirige um
// Chromium dedicado, e a credencial é o COOKIE dentro de
// `~/.cache/inemaccbot/perfil-heygen`. Login feito no seu navegador do dia a dia
// é invisível para ele: são dois cofres separados. Este script abre EXATAMENTE
// aquele perfil, com as mesmas flags do `heygen-estudio.mjs`, para que o cookie
// que você criar seja o cookie que o bot vai usar.
//
// As flags não são decoração:
//
//  - `--password-store=basic` é como o Chromium do snap cifra os cookies aqui.
//    Logar sem ela grava com a chave do chaveiro do sistema, e aí o bot abre o
//    perfil e vê uma sessão deslogada — o cookie está lá e não decifra.
//  - `headless: false` porque o login é seu: e-mail, senha, Google, 2FA.
//
// O script não digita nada e não guarda credencial nenhuma: só abre a janela,
// espera você chegar na tela de Projetos e confirma que a sessão pegou.
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const PERFIL = arg('perfil', join(homedir(), '.cache', 'inemaccbot', 'perfil-heygen'));
const MINUTOS = Number(arg('minutos', '15'));

// A MESMA prova que o `heygen-estudio.mjs` usa para decidir se está logado: a
// barra de busca da tela de Projetos. Conferir aqui com outro critério seria
// declarar sucesso por uma régua que o bot não usa.
const BUSCA = 'input[placeholder*="esquisar" i], input[placeholder*="earch" i]';

if (!process.env.DISPLAY) {
  console.error('ERRO: sem DISPLAY — não há tela onde abrir a janela. Use DISPLAY=:10 (sessão RDP).');
  process.exit(3);
}

console.log(`perfil: ${PERFIL}`);
console.log(`tela:   ${process.env.DISPLAY}`);

const ctx = await chromium.launchPersistentContext(PERFIL, {
  headless: false,
  args: ['--password-store=basic', '--no-first-run', '--no-default-browser-check'],
  viewport: null,
});
const pg = ctx.pages()[0] ?? await ctx.newPage();
await pg.goto('https://app.heygen.com/login', { waitUntil: 'domcontentloaded', timeout: 90_000 });

console.log(`\nJanela aberta. Faça o login no HeyGen — você tem ${MINUTOS} min.`);
console.log('Quando a tela de Projetos aparecer, este script fecha sozinho.\n');

const limite = Date.now() + MINUTOS * 60_000;
let ok = false;
while (Date.now() < limite) {
  await pg.waitForTimeout(3_000);
  try {
    if (pg.url().includes('app.heygen.com') && await pg.locator(BUSCA).count()) { ok = true; break; }
  } catch { /* navegação em curso */ }
}

// Fechar o contexto é o que faz o Chromium gravar os cookies no disco — sair no
// grito (Ctrl-C na janela) pode deixar a sessão só na memória.
await ctx.close();

if (!ok) {
  console.error('ERRO: o tempo acabou sem chegar na tela de Projetos — a sessão pode não ter sido gravada.');
  process.exit(3);
}
console.log('sessão gravada no perfil. A rota `| estudio` já pode rodar.');
