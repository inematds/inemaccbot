# inemaccbot

Gateway Telegram + fila durável. Sucessor do `inemaccvbot`.

## 📖 Guia de uso

Guia completo (landing + passo a passo): **https://inematds.github.io/inemaccbot/guia/**

**Estado: etapas 0 a 5 concluídas, mais os fluxos de domínio.** A fila é durável (SQLite em
WAL, lease com heartbeat, drain, claim atômico), o gateway fala com o Telegram, as skills
rodam como agente (`transcrever`, `dublar`, `explicativo`, `curso`, `demo`, `reel`,
`reelinematds`), e o motor de fluxos executa pipelines com estado por fase e alvo,
definição congelada, portão humano e retomada. O v1 (`inemaccvbot`, `mkivideos`,
`mkitexto`) está desligado.

O que **não** existe de propósito: barreira entre fases, preempção de job, teto global de
agentes, multiusuário. Ver §11 do spec — cada item com o gatilho para reconsiderar.

## Instalação (passo a passo)

Do zero até `/ping` respondendo no Telegram. Testado no Ubuntu com Node v24.

**Atalho:** `./scripts/instalar.sh` faz os passos 1 a 7 e para no que exige você
(token, login do Claude, CTA, login do HeyGen), listando cada pendência com o que
quebra sem ela. `--checar` não muda nada, só diz o que falta; `--sem-chromium` pula o
download de ~400 MB. Rodar de novo é seguro. Os passos abaixo são o que ele faz — leia
se quiser entender ou fazer na mão.

### 0. Pré-requisitos

| o quê | para quê | sem isso |
|---|---|---|
| **Node 22+** (`node -v`) | o processo | não sobe. O Ubuntu 24.04 traz o 18 — use o repositório NodeSource 22.x |
| **`claude` no PATH, e LOGADO** | motor padrão dos jobs de agente (`src/fila/runner-claude.ts`) | o bot sobe, mas todo job de agente falha. Instalado ≠ autenticado: confira com `claude auth status` (espere `"loggedIn":true`) |
| **`ffmpeg`** | tarefa `ffmpeg.thumb` e o áudio/vídeo das skills | thumbnail e render falham |
| **`python3` + `bash`** | a fase de reel dispara o `montar-reel.py` destacado | a fase `reel.montar` falha |
| **Chromium do Playwright** | `scripts/heygen-estudio.mjs` (`chromium.launchPersistentContext`) | a rota `\| estudio` falha. `npx playwright install --with-deps chromium` — a versão do Playwright está travada no `package.json` |
| **`sqlite3` (CLI)** | opcional — inspecionar a fila na mão (`select ... from jobs`) | só perde o diagnóstico manual |

O banco em si é o `better-sqlite3` (compila no `npm install`), não a CLI.

### 1. Clonar e instalar

```bash
git clone git@github.com:inematds/inemaccbot.git ~/projetos/inemaccbot
cd ~/projetos/inemaccbot
npm ci            # `ci`, não `install`: instalação reproduzível pelo lockfile
```

**Ainda não rode `npm test`.** A suíte só fecha depois do passo 2 — sem os repos de
domínio, dezenas de testes falham por `flow.json` ausente.

Se `npm run build` disser `tsc: not found`, o `npm ci` pulou as devDependencies (é o que
`NODE_ENV=production` faz sozinho, comum em servidor). Refaça com
`NODE_ENV=development npm ci --include=dev`. O aviso do `npm audit` é ruído de
transitivas: **não** rode `audit fix --force`, ele desfaz o pin do Playwright.

### 2. Repos de domínio (irmãos, não submódulos)

`config/fluxos.json` declara os repos que os fluxos carregam de `PROJETOS_DIR`
(default `$HOME/projetos`). Eles NÃO vêm no clone e não são submódulos — clone os dois
como irmãos deste diretório:

```bash
cd ~/projetos
git clone https://github.com/inematds/promoavatar.git
git clone https://github.com/inematds/promoavatar3.git
```

Sem eles o boot sobe, mas dezenas de testes falham e `/promoavatar` e `/promoavatar3`
quebram na primeira fase.

### 3. O CTA (já vem no clone desde 2026-08-08)

`promoavatar` e `promoavatar3` exigem `cta/cta-9x16.mp4`. Ele era ativo externo — os
dois repos ignoram `*.mp4` e o arquivo não vinha no clone, o que fazia **2 testes
falharem** numa máquina nova. Agora está versionado nos dois, por uma exceção explícita
no `.gitignore` deles (`!cta/*.mp4`): são 60 KB e o arquivo não é regenerável.

```text
~/projetos/promoavatar/cta/cta-9x16.mp4
~/projetos/promoavatar3/cta/cta-9x16.mp4
```

**Nada a fazer neste passo** — só confira que os dois caminhos existem depois do passo 2.
Se estiverem faltando, seu clone é anterior à mudança: `git pull` em cada repo.

Formato esperado: 1080x1920, H.264/`yuv420p`/30 fps, AAC 48 kHz estéreo — o pipeline
concatena sem reencodar quando os parâmetros batem.

### 4. Testar e compilar

```bash
cd ~/projetos/inemaccbot
npm test           # agora sim: 788/788
npm run build      # gera dist/index.js — o unit systemd roda daí, não do src/
```

### 5. Criar o bot no Telegram

Fale com o [@BotFather](https://t.me/BotFather) → `/newbot` → ele devolve o token.
Esse valor é o `BOT_TOKEN` do passo 6 — **nunca commite o arquivo que o contém** (ver §`.env`).

### 6. Escrever o `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Preencha as cinco obrigatórias (tabela completa em [`.env`](#env)) e troque `/CAMINHO/PARA`
pelos caminhos reais. As opcionais têm default derivado do `$HOME` — a linha pode sair fora.

**Como descobrir o `ALLOWED_CHAT_IDS`**, já que sem ele o bot ignora você: deixe
`ALLOWED_CHAT_IDS=0`, suba (passo 7), mande qualquer mensagem pro bot e leia o `LOG_FILE`:

```
gateway: mensagem rejeitada — chat 123456789 fora da allowlist
```

Esse número é o seu. Ponha no `.env` e reinicie. (Vários chats: separados por vírgula.)

### 7. Subir — primeiro na mão, depois como serviço

Na mão, pra ver o boot falhar alto se algo estiver errado:

```bash
node dist/index.js       # Ctrl-C encerra pelo caminho normal (SIGINT → drenar)
```

Boot saudável imprime a linha de recuperação de leases
(`boot: recuperação de leases — requeued=N failed=M`). Erro de config ou migration
derruba o processo ali mesmo, de propósito — leia a mensagem antes de mexer em outra coisa.

Como serviço de **usuário** (não de sistema — a unidade não tem `User=` e o alvo é
`default.target`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/inemaccbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inemaccbot
loginctl enable-linger "$USER"   # o serviço sobrevive ao logout / sobe no boot
```

Os caminhos do unit usam `%h/projetos/inemaccbot` — se clonou em outro lugar, edite
`WorkingDirectory`, `EnvironmentFile` e o `WantedBy` **não**.

### 8. Verificar

```bash
systemctl --user status inemaccbot   # active (running)
tail -f "$(grep ^LOG_FILE .env | cut -d= -f2)"
```

No chat: `/ping` responde, `/ajuda` lista os comandos, `/fila` mostra as filas vazias.
Se `/ping` não responde mas o serviço está `active`, é allowlist — volte ao passo 6.

### 9. Atualizar depois

```bash
git pull && npm install && npm run build
sqlite3 inemaccbot.db "select id,fila,tarefa,status from jobs where status in ('queued','running');"
systemctl --user restart inemaccbot
```

**A consulta não é opcional.** Reiniciar com job em voo mata o processo com SIGTERM e
gasta uma tentativa dele — é a seção [`código 143`](#código-143-não-é-erro-do-agente--é-restart).
Fila vazia → reinicie à vontade.

## Configuração: o que só VOCÊ pode providenciar

Nada disto o bot resolve sozinho — são segredos, contas e ativos que moram fora do
repo. A coluna da direita diz o que quebra se faltar, para você não descobrir no meio
de um render.

| o quê | onde | se faltar |
|---|---|---|
| **Token do Telegram** | `BOT_TOKEN` no `.env` (BotFather) | o boot falha na hora: `config: falta BOT_TOKEN` |
| **Allowlist de chat** | `ALLOWED_CHAT_IDS` no `.env` | o boot falha igual. E com o id errado o bot fica mudo: toda mensagem vira `rejeitada — fora da allowlist` no log |
| **Login do Claude** | `claude auth status` → `loggedIn: true` | o bot sobe e aceita comandos, mas **todo job de agente falha** — é a falha mais confusa de diagnosticar, porque tudo *parece* certo |
| **CTA `cta-9x16.mp4`** | versionado nos dois repos de domínio, em `cta/` (passo 3) | 2 testes falham, e nenhum reel fecha: a última fase concatena o CTA no fim |
| **Perfil Chromium logado no HeyGen** | `HEYGEN_PERFIL_CHROME` (default `~/.cache/inemaccbot/perfil-heygen`) — você loga **uma vez, na mão**, naquele perfil | a rota `\| estudio` falha. É caminho, não segredo: os cookies moram dentro da pasta, fora do repo |
| **API key do HeyGen** | **não fica neste `.env`** — mora no arquivo apontado por `HEYGEN_ENV_PATH` (default `~/projetos/openpcbotv2/.env`) | as rotas `\| api` e `\| creditos` falham |
| **CLI do HeyGen** | binário `heygen` no PATH, ou o caminho em `HEYGEN_CLI` | idem |
| **Servidor do link final** | `PUBLICO_DIR` (a pasta servida) + `PUBLICO_URLS` (as bases de URL) | o vídeo é produzido, mas a mensagem chega sem link para baixar. São **duas** URLs porque a máquina fica em duas redes ao mesmo tempo |
| **Repos de domínio** | `promoavatar` e `promoavatar3` como irmãos (passo 2) | os fluxos quebram na primeira fase |

Regra geral: **`.env` guarda caminho e id; segredo de terceiro mora no arquivo do
dono dele.** É por isso que a key do HeyGen não foi copiada para cá.

## Uso no chat

### Comandos de serviço

| comando | o que faz |
|---|---|
| `/ping` | verifica se o bot está vivo |
| `/ajuda` (`/help`) | **o resumo** — o básico e como chegar no resto |
| `/ajuda tudo` | a lista COMPLETA de comandos (sinônimos: `comandos`, `completa`, `all`) |
| `/ajuda <nome>` | a ajuda de UMA skill ou fluxo (`/ajuda promoavatar`) |
| `/skills` · `/fluxos` | os dois catálogos |
| `/fila` | por fila: rodando, pendentes, idade, erro em 24h, retentados |
| `/espaco` | quanto disco cada área ocupa (bot × skills), separadas |
| `/status` | os fluxos ABERTOS: a lista de uma linha (número · situação · assunto) e depois o detalhe fase × alvo de cada um |
| `/completos` | os fluxos que terminaram, do mais novo para o mais velho |
| `/jobs` | a fila de jobs: o que está rodando e o que terminou |
| `/status j13` · `/status A#9` | detalhe de um JOB ou de um FLUXO |
| `/cancelar j13` · `/cancelar A#9 [público]` | idem |
| `/refazer j13` · `/refazer A#9 [público]` | idem — no fluxo, retoma da fase que falhou |
| `/furar j13` | põe um job pendente na frente |
| `/pronto [ref]` | "terminei minha parte" — libera o portão. Sinônimos: `/aprovar`, `/aprovado`, `/ok` |
| `/limpar <escopo>` | ver abaixo |

**A ajuda tem dois níveis, e o curto é o padrão.** A lista completa passa de 30
linhas com o catálogo de skills junto — uma tela inteira no celular para quem só
queria liberar um portão. `/ajuda` responde o básico e ensina os dois caminhos para
o detalhe; `/ajuda tudo` continua entregando tudo.

**Referência de fluxo:** `A#9`, `a#9`, `A9` e `a9` são a mesma coisa. Só número
(`13`) é sempre JOB. Na lista, job aparece como `j13 · A#9/jovens` — o `j`
separa de id de fluxo, e o sufixo diz de quem o job é.

**`/pronto` sem referência** libera o fluxo quando só um está esperando. Com
vários, ele lista quais. Com nenhum, diz isso.

**Pontuação no fim dos campos é aparada.** `| sombra.` e `| alvos=a,b;` valem —
ponto no fim é hábito de quem escreve frase, não erro de uso. O ASSUNTO não é
aparado: a pontuação dele é conteúdo, e assunto que é pergunta ("isso é bom ou
ruim?") depende dela.

### Tirar um fluxo do `/status`

O painel mostra `rodando` e `falhou` — os dois estados que ainda pedem algo de
você. Um fluxo falhado que você não vai retomar sai assim:

| quero | comando | o que acontece |
|---|---|---|
| só sumir da lista | `/cancelar A#9` | vira `cancelado`, que não aparece nem no `/status` nem no `/completos`. O fluxo continua existindo: `/status A#9` mostra tudo |
| apagar de vez | `/limpar A#9` | remove o fluxo e os artefatos do disco. Mostra o que vai apagar e só executa com `confirmar` |

`/cancelar` interrompe jobs pendentes e rodando — num fluxo já falhado não há
nenhum, então "0 job(s) interrompido(s)" é o certo, não um erro. E o que já foi
criado FORA (render no estúdio, arquivo entregue no canal) continua lá: cancelar
é sobre o pipeline, não sobre o mundo.

### `código 143` não é erro do agente — é restart

`claude saiu com código 143` significa `128 + 15` = **SIGTERM**: o processo foi
morto pelo desligamento do serviço, no meio do trabalho. Quase sempre a causa é
um `systemctl --user restart inemaccbot` com job rodando.

O que acontece com o job depende de quantas tentativas sobraram: com tentativa
disponível ele é **requeued** e o boot seguinte o retoma sozinho; sem tentativa,
vira `failed`. Um render de reel leva 10–15 min, então dois restarts seguidos
esgotam as duas tentativas do mesmo job — foi assim que o `C#13/jovens-aut/reel`
morreu, com os dois restarts do dia 2026-08-01.

**Antes de reiniciar, confira a fila:**

```bash
sqlite3 inemaccbot.db \
  "select id,fila,tarefa,status,flow_ref from jobs where status in ('queued','running');"
```

Vazio → reinicie à vontade. Com um render em voo → espere, ou aceite gastar uma
tentativa dele. Depois é só `/refazer A#9 <alvo>`: SIGTERM não corrompe nada, o
trabalho só não terminou.

### Skills (uma etapa, sem estado)

```
<skill>: <entrada> [| campo]*
```

| exemplo | |
|---|---|
| `transcrever: https://…` | áudio → texto |
| `dublar: https://… \| lives3` | e entrega no canal |
| `explicativo: <assunto> \| vertical` | vídeo explicativo 9:16 |
| `reel: /caminho/avatar.mp4 \| lives3` | reel empilhado |
| `historia: Era uma vez… \| nome=baloes` | conto → filme narrado (Agnes, US$ 0) |
| `imagem: uma raposa ruiva na neve \| ratio=16:9` | imagem avulsa (Agnes, US$ 0) |

Campos genéricos: `livesN` (destino) · `modelo=haiku` · `esforco=high`. Os
campos próprios de cada skill saem em `/ajuda <skill>`.

### Fluxos (várias fases, com estado)

```
/promoavatar <assunto> [--alvo=jovens] [| legenda=nao] [| versao=N] [| de=<fase>] [| sombra]
```

| opção | padrão | |
|---|---|---|
| `--alvo=x` (repetível) ou `\| alvos=a,b` | todos | só esses públicos |
| `\| legenda=nao` | **ligada** | desliga a legenda do reel (uma palavra por vez, caixa alta, acento na palavra-chave) — ver `promoavatar/docs/legenda.md` |
| `\| api` · `\| creditos` · `\| estudio` · `\| navega` | nenhuma | quem gera o avatar, e de que bolso sai. **Só uma por fluxo.** Sem nenhuma, quem grava no estúdio é você. Ver "As SEIS rotas de avatar" |
| `\| versao=N` | 1 | muda o `-vN` do título do estúdio |
| `\| de=<fase>` | — | começa no meio (você já fez texto e/ou avatar) |
| `\| sombra` | — | mostra o plano, não enfileira nada |

O `|` e o `--` convivem. **Campo escrito sem um dos dois é RECUSADO** — não vira
assunto em silêncio, que é como um fluxo já nasceu com 12 públicos por engano.

A ajuda completa de cada fluxo mora no repo de domínio: `/promoavatar help`.

### Limpeza

```
/limpar A#8            artefato + avatares + publicados daquele fluxo
/limpar promoavatar    todos os fluxos daquele tipo
/limpar artefatos 14   área do bot, por idade
/limpar tudo           artefatos + publicados dos fluxos conhecidos
```

**Dry-run por padrão**: sem a palavra `confirmar` no fim, só mostra o que sairia
e quanto libera. O recorte por fluxo vem do `flow_ref` no banco, então limpar um
fluxo com outro rodando é seguro. E o bot só toca no que ELE publicou dentro de
`~/projetos/output` — o resto é de outros projetos.

## Como entra um domínio novo

Este é o teste do desenho: **domínio novo não deve exigir linha de código no bot.**

### Uma SKILL (uma etapa, sem estado)

Vale quando "rodar de novo do zero" é aceitável. Não guarda progresso, não tem `/status`
próprio.

1. Escreva o prompt em `prompts/<nome>.md`. Use `{{input}}` (o que a pessoa pediu) e
   `{{saida}}` (onde gravar). A última linha do agente tem que ser `RESULT: <caminho>`.
2. Acrescente a entrada em `config/skills.json`:

   ```jsonc
   { "command": "minhaskill", "fila": "texto", "kind": "agent",
     "prompt": "prompts/minhaskill.md", "artefato_exts": ["txt"],
     "max_tentativas": 2, "timeout_segundos": 3600,
     "aceita_destino": false,
     "campos": { "vertical": { "tipo": "bandeira", "padrao": "não" } },
     "descricao": "o que ela faz", "exemplo": "minhaskill: assunto" }
   ```

3. **Ajuda (opcional):** `prompts/minhaskill.help.md`. Sem ele, o bot deriva a ajuda do
   registro — ver "Regra da documentação" abaixo.
4. `npm test`. O registry é validado no boot: entrada inválida **derruba o serviço**, e é
   assim de propósito — subir com um catálogo que não entendemos é pior que não subir.

Campo declarado tem que ser usado no prompt, e variável do prompt tem que ser declarada —
há teste para os dois lados.

### Um FLUXO (várias fases, com estado)

Vale quando há trabalho parcial que seria absurdo jogar fora. Ganha `/status`, `/refazer`
seletivo, retomada e definição congelada.

1. Crie o repo de domínio (`~/projetos/<nome>`) com `flow.json` e `prompts/`.
2. `flow.json`: `nome`, `prefixo` (o `P` de `P#16` — único por fluxo), `versao_def`,
   `alvos` (cada um com o que o domínio precisar: `canal`, `gatilho`…) e `fases`.
   Cada fase: `id`, `escopo` (`fluxo` = um job para todos, `alvo` = um por alvo), `fila`,
   `kind`, `tarefa`, `max_tentativas`, e opcionalmente `prompt`, `espera`
   (poll: `{intervalo, timeout}`), `entrega` e `pausa_apos` (portão humano → `/aprovar`).
3. `tarefa` só pode ser: `fluxo-agente`, `fluxo-navegador`, `heygen.baixar`, ou o
   `command` de uma skill do catálogo. Nome fora disso é recusado na carga.
4. Acrescente em `config/fluxos.json`: `{ "command", "repo", "descricao", "exemplo" }`.
5. **Ajuda (opcional):** `HELP.md` na raiz do repo de domínio.
6. Confira em SOMBRA antes de gastar qualquer coisa:
   `/<fluxo> <assunto> | sombra` imprime fase × alvo × fila × tarefa e **não enfileira nada**.

O domínio diz para QUEM (canal por nome, `lives21`); o bot sabe ONDE (o caminho no disco).
Nunca ponha caminho no `flow.json`.

#### As SEIS rotas de avatar, e de que bolso cada uma sai

Quem decide de onde sai o custo **não é um parâmetro no corpo do POST — é a
autenticação**. A doc da HeyGen é explícita: *"When you authenticate with an API
Key (`x-api-key`), you are billed under the API tier. Usage is deducted from
your prepaid USD wallet"*, e *"OAuth (MCP and CLI `--oauth`) authenticates as
the user's web account and draws on subscription credits"*.

| rota | quem faz o trabalho | custo | estado |
|---|---|---|---|
| **normal** (padrão) | **você**, no estúdio | **ilimitado nesta conta** (ver ressalva) · seu tempo: 36 colagens | **em produção** |
| **`\| creditos`** | o bot, pela CLI autenticada por OAuth | **~1 crédito por vídeo** | **implementado**; rota provada à mão em 2026-08-02, **ainda não em fluxo** |
| **`\| api`** | o bot, pela chave de API | **~US$ 0,73/vídeo** (Avatar III) | implementado, **nunca fez chamada real** |
| **`\| estudio`** | um SCRIPT (Playwright) clonando o template no estúdio | igual à normal, **zero token de LLM** | implementado 2026-08-06; o script gerou vídeo ponta a ponta no teste, **ainda não rodou dentro de um fluxo** |
| **`\| navega`** | um AGENTE clonando o template no estúdio (`Edit as New`) | igual à normal, **+ ~US$ 1,25 de LLM por público** | **em produção** — 112 jobs, A#19 a A#29 |
| **navegação** (`fluxo-navegador` montando cena do zero) | um agente escolhendo avatar, voz, cenário | igual à normal, **mais tokens ainda** | escrito no fluxo antigo `promoclub`, **nunca rodou** |

**`| estudio` e `| navega` fazem a mesma coisa e cobram do mesmo lugar** — clonam
o `TEMPLATE-AVATAR`, herdam cenário, avatar, voz e motor. A única diferença é
quem pilota o navegador: um script determinístico ou um agente. O `navega` fica
de pé de propósito, como caminho de volta se o DOM do HeyGen mudar e o script
quebrar. **Pedir duas rotas é recusado na criação** — juntas gerariam o mesmo
vídeo duas vezes, cada uma cobrando de um bolso.

O que o script resolve e o prompt não resolvia (medido em 2026-08-06, ao portar):

1. **A busca por `TEMPLATE-AVATAR` devolve três** (`-9`, `-16` e o certo). O
   prompt manda o agente PARAR nesse caso, porque ele não tem como decidir qual
   é o original. O script casa por **igualdade exata**.
2. **"Gerar" não gera.** Abre um modal de confirmação (resolução, formato, fps);
   quem dispara é o botão **"Enviar"**. Esse passo **não estava no prompt** — um
   agente que declarasse "gerei" ali estaria de boa-fé, e a fase `baixar`
   esperaria 1h30 por um vídeo que ficou `draft` para sempre.
3. **Acento sem receita.** `type()` pelo CDP escreve certo no tiptap: some toda
   a parte de `xclip`/`xdotool`/`ctrl+2`/`visibilityState` — a maior seção do
   prompt e a "causa nº 1 de falha silenciosa".
4. **A interface está em pt-BR** ("Editar como Novo", "Vídeo sem título",
   "Gerar", "Enviar"), e o prompt fala em inglês. O agente acertava por
   interpretação; o script acerta por seletor.

O script é `scripts/heygen-estudio.mjs` e a tarefa é `heygen.estudio`
(`src/fila/tarefas/heygen-estudio.ts`). Ele **retoma de um rascunho homônimo**
em vez de clonar de novo, e a tarefa **não gera duas vezes**: se o título já
está no estúdio em qualquer status que não `draft`, a tentativa anterior já
enviou e já cobrou.

**O ponto frágil da rota `| estudio` é a sessão.** Ela usa um perfil de Chromium
já logado no HeyGen (`HEYGEN_PERFIL_CHROME`, default
`~/.cache/inemaccbot/perfil-heygen`) — uma cópia dos cookies do Chromium do
`:99`. Quando a sessão expirar, a fase falha com *"a sessão do HeyGen não está
logada neste perfil"* e o conserto é recopiar o perfil.

A `| navega` é a rota de navegação **sem montar cena**: em vez de escolher
avatar, voz, cenário e proporção a cada vídeo, ela clona um projeto-template do
estúdio e só troca duas coisas — o título e a fala. O barato não é cada passo
ficar mais barato: é haver menos passos. Detalhes, e o que o reconhecimento no
estúdio provou, em [`docs/rota-navega-avatar.md`](docs/rota-navega-avatar.md).

**Ressalva que muda a conta de quem for copiar isto:** nesta conta a rota
*normal* é ilimitada, então ela não consome os 500 créditos — e a de *navegação*,
por ser o mesmo estúdio, também não. Em plano com crédito contado as duas
passam a custar, e aí a comparação é outra. O que foi MEDIDO aqui é só o débito
da rota OAuth; o consumo de um render feito à mão nunca foi medido.

**O teste de 2026-08-02** (`TESTE-CREDITOS-v1`, 8,67s, `avatar_iii`), que provou
a rota de créditos ponta a ponta:

| | antes | depois |
|---|---|---|
| créditos premium | 200 | **199** |
| créditos add-on | 300 | 300 |
| carteira US$ | 0,22 | **0,22 — intacta** |

Quatro respostas de uma vez: debita da **assinatura** (`billing_type:
subscription`), roda **headless** (sessão salva, token `refreshable`, válido
10 dias), custa **1 crédito** para 8,67s — e, o que mais importava, o
`heygen.baixar` **acha pelo título** um vídeo gerado por OAuth mesmo listando
com a chave de API: as duas credenciais veem a mesma conta, então a fase
`baixar` não muda.

Extrapolando: **36 alvos ≈ 36 créditos dos 500**, contra ~US$ 26 pela API. Uma
amostra não distingue "1 por vídeo" de "1 por minuto começado", mas como os
vídeos ficam abaixo de 1 min, dá no mesmo.

**A dúvida que sobra na rota de créditos:** a doc chama OAuth de *"trial-scale
only"* e recomenda API key *"for anything at scale — batches, pipelines"*. Um
vídeo não prova 36. O teste que falta é um público inteiro (3 alvos, 3
créditos) antes de soltar o lote.

**Por que a navegação virou legado:** ela só existia porque era o único jeito de
alcançar os créditos sem a mão. O OAuth alcança melhor — sem depender de aba
logada, sem quebrar quando o layout do estúdio muda, sem gastar tokens de LLM.

**Cuidado com o motor.** O `/v3/videos` usa **Avatar IV por padrão**, que custa
US$ 0,05–0,0667/s contra **US$ 0,0167/s do Avatar III** — 3 a 4× mais caro pelo
mesmo minuto. O campo `engine` tem que ser explícito; deixar no default é
escolher o caro sem saber.

**Como as duas rotas do bot são declaradas.** Cada uma é uma fase OPCIONAL no
`flow.json`, e só entra no fluxo quando a flag dela vem na criação:

```
texto → gerar(só |api) → gerar-creditos(só |creditos) → baixar → reel
```

Pedir as duas juntas é **recusado** — gerariam o mesmo vídeo duas vezes,
cobrando dos dois bolsos. O motor é do domínio (`"engine": "avatar_iii"` no
`flow.json`), nunca o default da API.

**O que falta fazer** (ordem sugerida):

1. ~~`engine` explícito~~ — **feito**: o domínio declara `avatar_iii`, e a
   tarefa nunca deixa o campo em branco.
2. ~~Implementar a `| creditos`~~ — **feito**: `heygen.gerar-creditos`, mesma
   tarefa com a autenticação trocada (CLI por OAuth, `HEYGEN_CLI` no `.env` —
   caminho, não segredo: o token expira e quem renova é a CLI).
3. **Teste de lote**: um público inteiro (`| alvos=jovens-alc,jovens-aut,`
   `jovens-pro | creditos`), 3 créditos, para saber se o "trial-scale" da doc
   vira rate limit no meio.
4. **Rota `| api` continua não provada** — só dá para testar com a carteira
   recarregada. Sem pressa: com créditos funcionando, a API é reserva.
5. **Navegação**: manter como legado do `promoclub` (fluxo aposentado), não como quarta opção viva.

Detalhe completo, com as travas de idempotência e de saldo:
[`docs/fase-avatar-via-api.md`](docs/fase-avatar-via-api.md).

#### A fase de reel deixou de ser agente (2026-08-06)

No promoavatar a última fase (`reel`) era `kind: agent`: um prompt de 86 linhas
mandava o modelo (1) extrair `REF` e `público` do NOME do arquivo do avatar,
(2) escolher um slug de workspace, (3) conferir se o `.md` do público existia e
(4) montar uma linha de comando. **Nada disso é decisão** — o bot já conhecia os
quatro dados; foi ele que gerou aquele nome (`entrada-fase.ts:caminhoAvatar`).
Metade do prompt existia só para o modelo não errar o parse de volta.

Hoje é `kind: function` / `reel.montar`. O contrato com o resto do sistema não
mudou: o pipeline continua indo para segundo plano destacado gravando
`.pid`/`.log`/`.err`, e quem vigia continua sendo `render.ts`.

O que isso custava, medido em
[`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md): **US$ 0,18 e
~180k de cache_read por reel, para produzir ~1k de saída**.

**O ganho é custo e superfície de falha, não velocidade.** Medido nos primeiros
reels do A#30 pelo caminho novo: mediana **180s**, contra **220s** pelo caminho
de agente — praticamente o mesmo, e era o esperado, já que o que saiu foi
conversa, não processamento. (A primeira leitura desses números deu "6× mais
lento" e estava errada: `jobs.iniciado_em` não é reescrito na reclamação, então
a subtração incluía a espera na fila. Ver a ressalva de método no doc.) E três defeitos de
produção saíram daí, nenhum do `montar-reel.py`:

- **A#23** — o agente usou a skill global em vez da do projeto e escreveu o HTML
  à mão (`template: None`);
- **A#25** — leu o `{canal}` como se fosse o público e foi procurar
  `textos/A25/lives2.md`, que não existe;
- **A#29** — rodando em `haiku`, escreveu um redirecionamento de shell que o
  portão de permissão recusou (job morto em 58s), e o job seguinte ficou **1h47
  sem produzir uma linha**. Em `sonnet` o mesmo job leva ~3,5 min. Registrado em
  `promoavatar/docs/decisoes-reel.md` (decisão 4).

**A legenda passou a ser padrão em 2026-08-07, e a recusa caiu.** Antes,
`| legenda` era recusada quando a fase de reel era função: o `montar-reel.py`
não legendava, então aceitar em silêncio entregaria reel sem legenda dizendo
que legendou. Agora ele legenda — uma palavra por vez, caixa alta, branca com
acento âmbar na palavra-chave, colada na base da faixa do avatar. O desenho e
o lugar de mudar cor e formato estão em `promoavatar/docs/legenda.md`.

Quem quiser a legenda do ESTÚDIO em vez da nossa precisa dizer `| legenda=nao`:
a do estúdio vem queimada no avatar e não há como removê-la, então as duas
juntas continuam saindo dobradas.

#### Onde o custo de um fluxo realmente está

Medição de 11 fluxos (A#19 a A#29, 245 jobs), em
[`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md). No recorte
de cobertura 100% (A#26 e A#27, pipeline novo, todos os jobs casados):

| fase | US$ | participação |
|---|---:|---:|
| `navega-avatar` | 33,05 | **84,6%** |
| `reel` | 4,29 | 11,0% |
| `texto` | 1,74 | 4,5% |
| `baixar` | 0,00 | 0% (`kind: function`) |

Duas conclusões que mudaram o rumo do projeto:

- **A navegação é o custo.** Ela nunca mudou em 11 fluxos (cache_read entre
  3.790k e 5.157k, saída entre 6,3k e 8,0k, sempre) enquanto todo o resto caía.
  É por isso que a rota `| estudio` existe.
- **A fila pesa mais que o agente no relógio de parede.** No A#22 um reel
  esperou 9.293s (2h35) na fila para rodar 938s. Com `render` serializado em 1 e
  12 públicos por fluxo, quem quiser encurtar o fluxo mexe na concorrência, não
  no prompt.

Ressalva de método que vale para qualquer número desse doc: **o bot não registra
token**. Tempo sai do banco (confiável); token sai dos logs de sessão do Claude
Code, casados job a job. É arqueologia, e o doc explica o casamento e o que ele
não prova.

#### `heygen.baixar`: **quem decide a legenda é o estúdio**

O `video_status.get` devolve `video_url` (limpo), `video_url_caption` (com a
legenda **queimada** nos pixels) e `caption_url` (legenda solta). A tarefa lê
`video_url_caption` **quando ele vem preenchido**, e cai no `video_url` quando
não vem (`escolherUrl`, `src/fila/tarefas/heygen.ts`).

Isso põe a decisão onde ela é tomada: **gravou com legenda no estúdio, o reel
sai com ela; gravou sem, sai sem.** O bot não escolhe, e não há o que pedir à
API — a URL é pronta (sem `?estilo=`/`?formato=`) e os seis endpoints de legenda
dão 404. Estilo, fonte e posição se decidem no estúdio, antes de renderizar.

Duas consequências que nenhum código desfaz, e que quem grava precisa saber:

- legenda queimada vem enquadrada para **16:9** — no reel 9:16 ela pode ser
  cortada ou colidir com a base;
- se o reel também for montado com `| legenda`, saem **duas**. Ligar uma é
  decidir desligar a outra.

Medido em 2026-08-01 nos 25 vídeos completos mais recentes da conta (todos
gravados sem legenda): `video_url_caption` nulo e `caption_url` vazio em todos —
ou seja, o caminho normal hoje continua sendo o limpo, e esta regra só muda o
dia em que alguém gravar com a legenda ligada. **NÃO testado:** o comportamento
com a legenda ligada no estúdio — os nomes dos campos sugerem que `video_url`
siga limpo e `video_url_caption` passe a vir preenchido, mas não há observação
que prove. O teste custa um vídeo. Detalhe também no README do repo de domínio.

### Regra da documentação (verificada por teste)

**Todo domínio que entra no catálogo responde ajuda.** Não por disciplina — por construção:

1. quem entende do assunto escreve (`HELP.md` no fluxo, `<prompt>.help.md` na skill);
2. se não escreveu, a ajuda é **derivada do registro** — fases, alvos, campos, prazos,
   prefixo. O derivado não pode divergir, porque sai da mesma fonte que o bot usa para
   executar;
3. `src/gateway/ajuda-dominio.test.ts` varre os dois catálogos e **falha** se algum domínio
   não responder ajuda utilizável.

No chat: `/ajuda <nome>` para qualquer um, ou `/<fluxo> help`.

## Documentos

- **Comece por aqui se está retomando o projeto:** `docs/HANDOFF.md`
- Avatar pela API (`| api`) e portão opcional (`| sem-portao`): `docs/fase-avatar-via-api.md`
- **Custo, tempo e token por FASE (A#19–A#29):** [`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md) — é a medição que motivou a fase de reel virar função e a rota `| estudio`
- Rota `| navega` (o agente no estúdio), que a `| estudio` substitui sem apagar: [`docs/rota-navega-avatar.md`](docs/rota-navega-avatar.md)
- **Conversas abertas (retomar):** `docs/conversas-abertas.md` — layout/templates do reel, imagens, e o custo em tokens da fase de navegação
- Arquitetura: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md`
- Perfil de execução (motor/modelo/esforço): `docs/perfil-de-execucao.md`
- Planos: `docs/superpowers/plans/` (uma etapa por arquivo, 0 a 5 + promoclub, aposentado)
- Testes herdados do v1 e onde cada um foi parar: `docs/herdado-do-v1.md`
- Crítica externa ao design (respondida na §13 do spec): `docs/analise_critica_inemaccbot_design.md`

Análises abertas (o que ainda não foi decidido):

- **Sair do Telegram — WhatsApp, e-mail ou chatbot:**
  [`docs/analise-canais-alem-do-telegram.md`](docs/analise-canais-alem-do-telegram.md).
  A costura do gateway já existe; o que trava é `chat_id` ser `INTEGER`.
  Recomendação: não trocar, acrescentar.
- **Imagem e link como material de um fluxo:**
  [`docs/analise-imagem-e-link-como-material.md`](docs/analise-imagem-e-link-como-material.md)

## Estrutura do código

```
src/
  db/           abrir.ts (SQLite + WAL), migrations.ts, backup.ts
  fila/         types.ts (Job/Perfil/Fila/ContextoTarefa), store.ts (FilaSqlite),
                runner.ts (contrato Runner/Execucao), runner-claude.ts (motor claude),
                worker.ts (stepper: passo/bater/drenar/abortar)
    tarefas/    catálogo FECHADO de tarefas `function`: http.ts (http.get), ffmpeg.ts
                (ffmpeg.thumb), index.ts (criarTarefas)
  dominio/      perfil.ts (resolverPerfil — motor/modelo/esforço; sem chamador em
                produção nesta etapa, entra na etapa 2 com kind=agent)
  gateway/      telegram.ts (adaptador grammy + allowlist + corte de mensagem),
                comandos.ts (parse/executa comandos, puro, sem grammy),
                notificar.ts (job terminado -> mensagem no chat)
  config.ts     carregarConfig — lê e valida o ambiente
  integracao/   testes que legitimamente cruzam camadas
  arquitetura.test.ts   verifica as fronteiras entre camadas (agora com gateway/)
  index.ts      boot, laço, agendamento e desligamento — o miolo do processo
```

## Desenvolvimento

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/index.js (dist/ é o outDir do tsconfig, rootDir=src)
```

Em produção: `node dist/index.js` com o `.env` no `WorkingDirectory` (ver `deploy/inemaccbot.service`).

### `.env`

Variáveis lidas por `carregarConfig` (`src/config.ts`) — as quatro primeiras são **obrigatórias**;
sem uma delas o boot falha alto e cedo, antes de subir qualquer worker:

| variável | obrigatória | default | para quê |
|---|---|---|---|
| `BOT_TOKEN` | sim | — | token do bot no Telegram (nunca commitar o valor real) |
| `QUEUE_DB` | sim | — | caminho do arquivo SQLite da fila |
| `STATE_DIR` | sim | — | raiz de estado do processo; `STATE_DIR/midia` vira a raiz de mídia (ver `ffmpeg.thumb` abaixo) |
| `LOG_FILE` | sim | — | arquivo onde `main()` também grava cada linha de log (além de stderr) |
| `ALLOWED_CHAT_IDS` | sim | — | lista de chat ids separados por vírgula; a allowlist do gateway |
| `MOTOR_PADRAO` | não | `claude` | fallback de motor pro perfil de execução (etapa 2) |
| `MODELO_PADRAO` | não | `sonnet` | idem, modelo |
| `ESFORCO_PADRAO` | não | `low` | idem, esforço |
| `HEYGEN_PERFIL_CHROME` | não | `~/.cache/inemaccbot/perfil-heygen` | perfil de Chromium **já logado no HeyGen**, usado pela rota `\| estudio`. Caminho, não segredo — os cookies moram lá dentro, fora do repo |

`.env` fica fora do git, modo 600. O parser (`lerEnv` em `src/index.ts`) é minimalista de
propósito (`CHAVE=valor`, `#` comenta, aspas opcionais) — não é `dotenv`, é o suficiente pro boot.
O ambiente real do processo (systemd `EnvironmentFile`, ou override manual) sempre vence o que está
escrito no arquivo quando os dois definem a mesma chave.

## Boot: a ordem importa

`criarServico(...).iniciar()`, em `src/index.ts`, segue esta sequência e ela não é arbitrária:

1. **Migrations** (`aplicarMigrations`) — um checksum divergente derruba o boot ali mesmo (com o
   `db.close()` antes de propagar o erro): subir sobre um schema que o código não reconhece é pior
   que não subir.
2. **Raiz de mídia** — `STATE_DIR/midia` é criada (`mkdirSync recursive`). Não é uma variável nova;
   é derivada do `STATE_DIR` que já existe.
3. **`recuperarLeasesVencidos()`** — chamada ANTES de qualquer `passo()`, e o resultado vai pro log:
   `boot: recuperação de leases — requeued=N failed=M`. Essa linha é a única evidência de que o
   processo anterior caiu com trabalho em voo. Rodar isso depois de já ter workers puxando da fila
   abriria uma corrida entre "reclamar lease vencido" e um worker novo competindo pelo mesmo job por
   engano — por isso vem antes de tudo o que segue.
4. **Só então** workers e bot sobem: o catálogo de tarefas é montado, o transporte Telegram é
   criado, os laços (`passo()` em loop, um por unidade de concorrência de cada fila) começam a
   girar, o heartbeat (`bater()`) é armado, e por fim `transporte.iniciar()` é chamado.

**É essa ordem — migrations, depois recuperação, só então trabalho novo — que torna o processo
recuperável de uma queda.** Um `kill -9` no meio de um job não deixa lixo indefinido: na próxima
subida, o passo 3 reclama qualquer lease vencido antes que um worker novo possa competir por ele.

## Desligamento: o que `drenar()` garante e o que não garante

`SIGTERM`/`SIGINT` chamam `svc.parar()` (memoizado — o segundo sinal é no-op). A sequência em
`desligar()`:

1. o transporte para de **receber** primeiro — nenhum comando novo entra durante o dreno;
2. os laços param de reclamar trabalho novo e são acordados das esperas ociosas;
3. dreno com teto: `Promise.race` entre (`w.drenar()` de cada worker + todos os laços) e um timeout
   (`timeoutDrenoMs`, 110s em produção — ver `deploy/inemaccbot.service`);
4. o que sobrou depois do teto vira falha explícita via `w.abortar()` — nunca fica `running` com
   lease vivo, que é o estado que nenhuma recuperação futura consegue distinguir de trabalho ainda
   legitimamente em andamento;
5. timers e DB fecham por último.

A sutileza que um leitor futuro vai errar se não ler isto: **`drenar()` espera só o trabalho que
esta instância ainda POSSUI o lease.** Um job cujo lease vence e é roubado por outra instância no
meio do dreno é **abandonado de propósito** por `bater()` — o `passo()` correspondente pode nunca
assentar, porque o worker desistiu (`ctx.sinal` foi abortado) e quem tem o job agora é outro
processo. Por isso `desligar()` corre `drenar()` **e** os `lacos` na mesma race com timeout, nunca
num `await` que assume que todos os `passo()` terminam. Ou seja: **`drenar()` retornar não significa
que todo `passo()` em voo já assentou** — significa que o trabalho que ainda era nosso terminou (ou
foi abortado no timeout).

## Filas e concorrência

Definidas em `CONCORRENCIAS` (`src/index.ts`), as cinco filas do spec sobem sempre, mesmo as ainda
sem tarefa — assim a etapa 2 acrescenta tarefas sem mexer no boot:

| fila | concorrência | tarefas nesta etapa |
|---|---|---|
| `io` | 10 | `http.get`, `heygen.baixar`, `heygen.gerar`, `heygen.gerar-creditos` |
| `cpu` | 1 | `ffmpeg.thumb` |
| `texto` | 2 | `fluxo-agente` (a fase de texto dos fluxos) |
| `render` | 1 | `reel.montar` — **1 por vez de propósito**: é a GPU |
| `navegador` | 1 | `heygen.estudio`, `fluxo-navegador` |

## As tarefas `function`

O catálogo (`src/fila/tarefas/index.ts`) é **fechado**: o campo `tarefa` de um job só pode ser uma
das chaves aqui, nunca texto livre do usuário. São sete: `http.get`, `ffmpeg.thumb`,
`heygen.baixar`, `heygen.gerar`, `heygen.gerar-creditos`, `heygen.estudio` e `reel.montar`.

- **`heygen.estudio`** (`src/fila/tarefas/heygen-estudio.ts`) — a rota `| estudio`: roda
  `scripts/heygen-estudio.mjs` (Playwright headless) e devolve o TÍTULO. A fala vai para um
  **arquivo**, nunca para a linha de comando — texto acentuado dentro de aspas de shell é a mesma
  classe de bug que a receita antiga de `xclip` existia para evitar. O navegador é filho do
  serviço e morre com `ctx.sinal`: ao contrário do render, deixar órfão aqui não economiza nada,
  porque a retomada continua do rascunho.
- **`reel.montar`** (`src/fila/tarefas/reel.ts`) — a fase de reel **sem agente** (ver a seção
  abaixo). Dispara o `montar-reel.py` destacado e mantém o contrato de `render.ts`
  (`.pid`/`.log`/`.err`).

- **`http.get`** (`src/fila/tarefas/http.ts`) — faz um GET simples. Recusa qualquer esquema que não
  seja `http:`/`https:` (nada de `file://` virando leitura de disco a partir de uma URL do usuário),
  repassa `ctx.sinal` pro `fetch` (a requisição para junto com o encerramento do serviço), e trunca
  a resposta em 8000 caracteres.
- **`ffmpeg.thumb`** (`src/fila/tarefas/ffmpeg.ts`) — gera uma thumbnail via `execFile('ffmpeg', ...)`
  (array de argumentos, nunca shell). **Constrangida a arquivos dentro de `STATE_DIR/midia`**
  (a raiz de mídia criada no boot): o caminho de entrada é resolvido e comparado por prefixo contra
  essa raiz (usando o separador de path, para `/dados/secreta` não passar por prefixo de
  `/dados/secret-algo`) — sem isso, um comando de chat vindo de um chat autorizado ainda poderia
  pedir a thumbnail de qualquer arquivo legível pelo processo no disco, o que é exatamente o tipo de
  acesso que a allowlist de chat não cobre (allowlist decide QUEM fala com o bot, não O QUE o bot
  pode tocar no disco). O processo do ffmpeg recebe `ctx.sinal`: se o worker desiste do job
  (encerramento ou lease perdido), o filho é morto — sem isso ele sobreviveria reparentado ao
  init, continuando a rodar depois que o banco já marcou o job como `failed`.

## Convenções

- ESM: todo import relativo termina em `.js` (mesmo importando de um `.ts`)
- Relógio injetável: nada chama `Date.now()` fora de um `agora: Agora` (`src/fila/types.ts`)
- Testes com arquivo SQLite temporário, nunca `:memory:`
- Fronteiras entre camadas verificadas por `src/arquitetura.test.ts`: `fila/` não importa de
  `gateway/` nem `fluxos/`; `fluxos/` não importa de `gateway/`; `dominio/` não importa de
  `gateway/`, `fila/` nem `fluxos/`; `db/` não importa de nenhuma das outras. A regra vale para
  **todo `.ts`, inclusive teste** — um teste que precisa legitimamente cruzar camadas não é motivo
  para abrir exceção na regra, ele vai em `src/integracao/`, que fica fora do mapa de proibições de
  propósito. A lista de exceções do teste de arquitetura tem hoje **uma única entrada**
  (`dominio/` pode importar `fila/types.js`, porque é só um tipo) — se uma fronteira falhar, o
  conserto é mover o código, não engordar essa lista.

## `Worker` é um stepper, não um serviço

`src/fila/worker.ts` não tem `iniciar()` nem agenda a si mesmo. Ele expõe `passo()` (processa no
máximo um job), `bater()` (renova o lease do que está em voo — e LARGA o job cujo lease já não é
mais nosso, sem dar ack), `drenar()` (para de aceitar novos jobs e espera o que este worker ainda
possui, renovando o lease enquanto espera — um job roubado no meio do drain é abandonado, então
retornar não garante que todo `passo()` já terminou) e `abortar()` (cancela à força o que sobrou
depois do timeout do drain). Quem chama `passo()` em loop, quem chama `bater()` periodicamente e
quem liga `SIGTERM` a `drenar()` é `src/index.ts` (desde a etapa 1) — isso é trabalho de boot, não
desta classe. `WorkerOpts.dono` identifica a instância do worker (`hostname:pid`, calculado uma vez
em `criarServico`): ele vai gravado em `jobs.lease_owner` no claim e é exigido em todo ack
(`renovar`/`concluir`/`falhar`), para que um worker estolado não sobrescreva um job que outra
instância já reclamou. `cancelar()` é a exceção: é ação de operador, não do dono do lease.
`WorkerOpts.aoTerminar`, quando presente, é chamado depois do ack com o job relido do banco — é
assim que `src/index.ts` liga `criarNotificador(...)` sem que `fila/` conheça `gateway/`.

## Deploy

`deploy/inemaccbot.service` — `ExecStart=/usr/bin/node dist/index.js` (confirmado contra
`tsconfig.json`: `outDir=dist`, `rootDir=src`), `TimeoutStopSec=120` com folga sobre o
`timeoutDrenoMs=110_000` que `main()` passa pro serviço, `EnvironmentFile` apontando pro `.env` no
mesmo diretório de onde `main()` o lê (`resolve(process.cwd(), '.env')`, com
`WorkingDirectory` igual). `Restart=on-failure`: um código de saída não-zero (falha fatal do
transporte depois do boot, ou desligamento que não completou) reergue o processo; um `SIGTERM`
tratado sai 0 e não é reiniciado.
