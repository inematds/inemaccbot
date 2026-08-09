# Instalação sem tutor: pareamento do chat, `start.sh` e Playwright em SO novo

**Data:** 2026-08-08 · **Estado:** aprovado no brainstorming, aguardando plano

## O problema, como ele apareceu

A instalação numa máquina limpa (Ubuntu 26.04, servidor `Waldemar`) travou três
vezes seguidas, e cada travada foi de uma natureza diferente:

1. `npm run build` → `tsc: not found`. O `npm ci` pulou as devDependencies
   (`NODE_ENV=production` faz isso sozinho) e nada no repo dizia isso.
2. `npx playwright install --with-deps chromium` falhou: o `--with-deps` carrega
   uma lista de pacotes por versão de SO e não conhece o 26.04.
3. Depois de instalado, faltava o passo humano: **como descobrir o chat id do
   Telegram** sem já saber onde procurar. E faltava o óbvio — *como ligo isso?*

O que une os três: a documentação e o `scripts/instalar.sh` foram escritos por
quem já tinha a máquina pronta. Eles descrevem o caminho de quem sabe.

## Decisões (tomadas pelo dono no brainstorming)

| # | Decisão | Alternativas descartadas |
|---|---|---|
| 1 | Allowlist em modo pareamento **cadastra sozinha** no primeiro `/ping` | senha de pareamento; só ecoar o id |
| 2 | O id cadastrado é persistido **reescrevendo o `.env`** | banco; arquivo próprio em `STATE_DIR` |
| 3 | `start.sh` **na raiz do repo**, primeiro plano, só sobe | wrapper stop/restart/status; instalador+start fundidos |
| 4 | Playwright: **tirar o `--with-deps`**, sem mexer no pin | bumpar o pin agora; bump + script juntos |

A decisão 1 foi tomada com o risco na mesa e reafirmada: com a allowlist em `0`,
quem chegar primeiro leva o bot. O desenho abaixo estreita a porta o quanto dá
sem contrariar a decisão.

## Parte 1 — Pareamento da allowlist

### O estado de pareamento

`ALLOWED_CHAT_IDS=0` é o **único** sentinela. Valor vazio continua sendo erro de
boot: `exigir` (`src/config.ts:43`) fica como está. O próprio comentário do
`config.ts` defende essa guarda — *"entrada inválida é erro de boot, nunca
'ignora e segue'"* — e transformar vazio em estado legal afrouxaria a única
barreira entre o bot e o Telegram inteiro. Isso é mudança maior do que a pedida.

Consequência: `chatsPermitidos === [0]` significa "em pareamento". Nenhum chat
real tem id `0`, então o estado é inequívoco.

### Onde o pareamento acontece

No ponto de rejeição de `rotear` (`src/gateway/telegram.ts:86`), **antes** de
`aoComando`. Não no gateway de comandos: a política de allowlist mora em
`rotear`, e é lá que a exceção tem que morar também.

`rotearAnexo` (`:142`) **não** pareia — segue rejeitando em silêncio.

### A porta é estreita de propósito

Pareia apenas quando as três condições valem:

- o processo está em pareamento (`chatsPermitidos` é exatamente `[0]`);
- a entrada é **mensagem de texto** (não anexo, não vídeo, não voz);
- o texto é o comando `/ping` (após `trim`; tolera o sufixo `@nome_do_bot` que o
  Telegram acrescenta em grupo).

Com cadastro aberto, "qualquer mensagem toma o bot" é a porta mais larga
possível, e estreitar para um comando explícito não custa nada a quem instala:
`/ping` já é o primeiro comando que o README manda dar.

### Os dois efeitos, nesta ordem

O furo que essa ordem evita: `carregarConfig` roda **uma vez** no boot e
`criarBot` fecha sobre `cfg` (`telegram.ts:181`,
`cfg.chatsPermitidos.includes(chatId)`). Persistir só no arquivo faria o bot
responder "cadastrado" e rejeitar a mensagem seguinte até reiniciar.

1. **Memória, síncrono:** substitui o conteúdo de `cfg.chatsPermitidos` por
   `[chatId]` (mutação in-place do array, para que o closure de `permitido`
   enxergue). A partir daqui o chat já está autorizado — a resposta é verdadeira.
2. **Disco, em seguida:** reescreve a linha `ALLOWED_CHAT_IDS=` do `.env`.

Se a escrita em disco falhar, o pareamento em memória **permanece** (a sessão
funciona) e o erro vai para o log com o valor a pôr no `.env` à mão. Perder a
sessão inteira por causa de um `.env` read-only seria o pior dos dois mundos.

### O escritor do `.env`

Módulo próprio, com caminho e escrita **injetados**, do mesmo jeito que
`carregarConfig` recebe `env` por parâmetro. Assim os testes não tocam disco —
são 797 testes verdes que precisam continuar assim.

Contrato:

- edita **apenas** a linha que começa com `ALLOWED_CHAT_IDS=`; comentários,
  ordem e demais linhas ficam byte a byte iguais;
- se a chave não existir no arquivo, acrescenta ao fim;
- escrita **atômica**: arquivo temporário no mesmo diretório + `rename`, para
  que uma queda no meio não deixe `.env` truncado;
- `chmod 600` no resultado.

### O que o chat vê

- Em pareamento, `/ping` de um desconhecido: cadastra e responde confirmando,
  com o id e a instrução de como trocar de dono depois.
- Em pareamento, qualquer outra coisa de um desconhecido: silêncio (`[]`) + log.
- **Fora** de pareamento: silêncio (`[]`) + log, exatamente como hoje. O bot
  nunca ecoa chat id para estranho depois de pareado — senão o alívio de
  instalação viraria um vazamento permanente.

### Trocar de dono

Voltar `ALLOWED_CHAT_IDS=0` no `.env` e reiniciar. Sob systemd o
`EnvironmentFile=` (`deploy/inemaccbot.service`) só é lido no start, e o
ambiente do processo vence o arquivo — então "editar e reiniciar" é o único
caminho, e ele é consistente com o que a unidade já faz.

### Log

Toda passagem pelo pareamento é registrada: tentativa, id cadastrado, e sucesso
ou falha da persistência. É o rastro que responde "por que esse chat entrou?".

## Parte 2 — `start.sh`

Na **raiz** do repo. Primeiro plano, log na tela. Faz, nesta ordem:

1. `.env` ausente → erro apontando o `instalar.sh`;
2. `dist/index.js` ausente ou mais velho que `src/` → `npm run build`;
3. `systemctl --user is-active inemaccbot` = `active` → avisa e sai, com
   `--forcar` para ignorar. Dois processos no mesmo `BOT_TOKEN` disputam o
   `getUpdates` e as mensagens se perdem de forma difícil de diagnosticar;
4. `exec node dist/index.js`.

Não vira wrapper de `stop`/`restart`/`status`: o `systemctl` já faz isso, e
reimplementar seria pior. A fronteira fica: `instalar.sh` prepara a máquina (uma
vez, pede decisões suas), `start.sh` liga (toda hora, não pede nada).

## Parte 3 — `scripts/instalar.sh`

É onde "faltou atualização" ainda é literalmente verdade:

- **passo 3 (CTA):** hoje dá `erro` e manda copiar à mão. O CTA passou a ser
  versionado nos dois repos de domínio (`promoavatar` `3e0da37`, `promoavatar3`
  `921e5f8`) — vira conferência, e a dica quando falta é `git pull`, não "copie".
- **passo 5 (`.env`), linha 86:** "ponha 0, mande uma mensagem e leia o chat id
  no log" é exatamente o que este trabalho substitui. Passa a explicar o
  pareamento e a deixar `ALLOWED_CHAT_IDS=0` como estado esperado de instalação.
- **passo 1:** detectar devDependencies puladas (`node_modules/.bin/tsc`
  ausente) e dizer a causa — `NODE_ENV=production` — antes que o build quebre.
- **passo 4 (Chromium):** ver Parte 4.
- **fim:** o bloco "para ligar" cita `./start.sh`.

## Parte 4 — Playwright em SO novo

`npx playwright install --with-deps chromium` → `npx playwright install chromium`.
O pin `playwright: "1.57.0"` **não** muda: o `heygen-estudio.mjs` automatiza uma
UI e trocar de versão mexe em timing — isso exige teste da rota `| estudio`, não
cabe numa correção de instalação.

Se o Chromium não subir por falta de biblioteca do sistema, o script mostra o
erro real de launch e aponta `npx playwright install-deps`. **Não** embarcamos
uma lista de pacotes apt para o 26.04 que não podemos verificar aqui.

Isso só afeta a rota `| estudio`; o resto do bot sobe sem Chromium.

### Lacunas conhecidas (registradas, não resolvidas)

1. Esta parte destrava instalação **nova**. Na VPS que já teve o Playwright
   atualizado à mão, `npm ci` vai **rebaixar** de volta para `1.57.0` e pode
   re-quebrar. O bump do pin segue tarefa aberta, dependendo de
   `npx playwright --version` na VPS.
2. `install-deps` pode não ter receita para o 26.04. Se for o caso, o caminho é
   o bump, não o script.

## Parte 5 — README

Ganha três coisas: o pareamento (achar o chat id sem saber nada de antemão),
o `start.sh` na seção de ligar, e a nota de Ubuntu 26.04 / Playwright com as
lacunas acima ditas em voz alta.

## Testes

| o quê | como |
|---|---|
| pareamento cadastra no `/ping` | `rotear` com `chatsPermitidos: [0]`, texto `/ping` → resposta + `cfg` mutado |
| `/ping@bot` também pareia | mesma coisa, com sufixo |
| outro texto em pareamento não cadastra | `/fila` de desconhecido → `[]`, `cfg` intocado |
| anexo nunca pareia | `rotearAnexo` com `[0]` → `[]` |
| fora de pareamento é silêncio | `chatsPermitidos: [123]`, chat `456` → `[]`, sem eco de id |
| segundo chat não entra depois de pareado | dois `/ping` de ids diferentes → só o primeiro |
| falha ao gravar não derruba a sessão | escrita injetada que lança → chat autorizado + log |
| `.env` preservado | escritor com fixture com comentários → só a linha da chave muda |
| chave ausente é acrescentada | fixture sem `ALLOWED_CHAT_IDS` |
| `exigir` continua rejeitando vazio | teste atual do `config.ts` permanece verde |

Scripts de shell não entram na suíte: `instalar.sh --checar` é a verificação
deles, rodada à mão.

## Fora de escopo

Bumpar o Playwright; lista de pacotes apt do 26.04; senha de pareamento;
allowlist com mais de um chat via pareamento (a segunda entrada é manual, no
`.env`); qualquer wrapper de operação além do `start.sh`.
