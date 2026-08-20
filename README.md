# inemaccbot

Gateway Telegram + fila durável. Sucessor do `inemaccvbot`.

## 📖 Guia de uso

Guia completo (landing + passo a passo): **https://inematds.github.io/inemaccbot/guia/**

Mapa da arquitetura (diagramas do bot, do `promoavatar` e do `promoavatar3`, os arquivos de
configuração e onde alterar cada coisa): **https://inematds.github.io/inemaccbot/guia/arquitetura.html**

**Estado: etapas 0 a 5 concluídas, mais os fluxos de domínio.** A fila é durável (SQLite em
WAL, lease com heartbeat, drain, claim atômico), o gateway fala com o Telegram, as skills
rodam como agente (`transcrever`, `dublar`, `explicativo`, `curso`, `demo`, `reel`,
`reelinematds`), e o motor de fluxos executa pipelines com estado por fase e alvo,
definição congelada, portão humano e retomada. O v1 (`inemaccvbot`, `mkivideos`,
`mkitexto`) está desligado.

O que **não** existe de propósito: barreira entre fases, preempção de job, teto global de
agentes, multiusuário. Ver §11 do spec — cada item com o gatilho para reconsiderar.

**Vai plugar um domínio/skill novo no bot?** Comece pelo **porquê** —
[`docs/integrar-um-repo.md`](docs/integrar-um-repo.md): por que o bot conhece a
FICHA do repo e não o código dele, por que os scripts são um par (um caro com
modelo, um barato determinístico), como entrada, saída e portões funcionam, e a
tabela de modos de falha que já morderam. Depois, cada rota tem o seu par de
scripts, e ambas têm o passo a passo manual como leitura de fundo:

- **Skill** (um comando, um artefato) → [`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md)
  — `gerar-manifesto` uma vez, `plugar-repo` em cada máquina.
- **Fluxo** (fases com estado e portão) → [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md)
  — `gerar-manifesto-fluxo` uma vez, `plugar-fluxo` em cada máquina. O manifesto
  carrega a definição e a materializa no repo de domínio, **sem sobrescrever** o
  que já estiver lá. Traz o roteiro do teste na VPS, os limites conhecidos e o
  estado da verificação. **Novo em 0.6.x, ainda sem uso em produção.**
- **À mão, com um exemplo real** → [`docs/instalar-analisevideo.md`](docs/instalar-analisevideo.md)
  — as duas rotas, passo a passo. É o que explica o que os scripts automatizam.

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
| **Chromium do Playwright** | `scripts/heygen-estudio.mjs` (`chromium.launchPersistentContext`) | a rota `\| estudio` falha. `npx playwright install chromium` — a versão do Playwright está travada no `package.json` |
| **`sqlite3` (CLI)** | opcional — inspecionar a fila na mão (`select ... from jobs`) | só perde o diagnóstico manual |

O banco em si é o `better-sqlite3` (compila no `npm install`), não a CLI.

O `claude` é o motor **padrão**, não o único: `codex` e `opencode` já vêm
registrados como alternativas e se ligam por job (`| motor=codex`), por skill ou
pelo `.env` — ver [`docs/motor-codex.md`](docs/motor-codex.md) e
[`docs/motor-opencode.md`](docs/motor-opencode.md). Binário de motor alternativo
ausente **não** derruba o boot; só falha quem pedir por ele.

**Playwright em SO recém-lançado (ex.: Ubuntu 26.04):** não use `--with-deps`. A lista
de pacotes dele é por versão de SO, e num SO novo demais ele falha na largada — foi o
que travou a instalação numa VPS 26.04. Baixe só o browser (`npx playwright install
chromium`); se o Chromium não subir por falta de biblioteca, tente `npx playwright
install-deps`, sabendo que ele também pode não ter receita para o seu SO. Nesse caso o
pin `playwright@1.57.0` é velho demais para a máquina e o caminho é subir a versão —
com teste da rota `| estudio`, porque ela automatiza uma UI e depende de timing.
Nada disso afeta o resto do bot: sem Chromium, só a rota `| estudio` fica fora.

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
(default: **a pasta que contém este clone** — os repos de domínio são irmãos do
inemaccbot, então quem clonou tudo lado a lado não precisa declarar a variável,
esteja isso em `~/projetos`, `/root/projetos` ou `/opt`). Eles NÃO vêm no clone
e não são submódulos — clone os dois como irmãos deste diretório:

```bash
cd ..   # a pasta que contém o inemaccbot
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

#### Como descobrir o chat id do Telegram (você não precisa saber de antemão)

Deixe `ALLOWED_CHAT_IDS=0` no `.env`. Isso é o **modo pareamento**: o bot ainda não
tem dono. Suba (passo 7), abra o seu bot no Telegram e mande `/ping`.

O primeiro `/ping` que chegar cadastra aquele chat como dono: o bot responde
confirmando com o id, grava esse id em `ALLOWED_CHAT_IDS` no `.env` (só essa linha
muda — comentários e o resto do arquivo ficam intactos) e **fecha a porta**. O
segundo chat que tentar já é rejeitado em silêncio.

O cadastro vale na hora, sem reiniciar: a próxima mensagem desse chat já roda
comando normalmente.

**O que isso significa, dito claramente:** enquanto a allowlist for `0`, quem mandar
`/ping` primeiro leva o bot. Se o token vazou, ou se alguém sabe o @nome do bot,
pareie antes de deixar rodando. Só `/ping` em texto pareia — anexo, foto e qualquer
outra mensagem, não.

**Trocar de dono:** ponha `ALLOWED_CHAT_IDS=0` de volta no `.env`, reinicie
(`systemctl --user restart inemaccbot`) e mande `/ping` do chat novo. Para autorizar
mais de um chat, edite a lista à mão: `ALLOWED_CHAT_IDS=111,222`.

Deixar `ALLOWED_CHAT_IDS` **vazio** não é pareamento — é erro de boot, de propósito:
a allowlist é a única barreira entre o bot e o Telegram inteiro, e configuração
inválida tem que derrubar o serviço na largada, não virar porta aberta.

### 7. Subir — primeiro na mão, depois como serviço

Na mão, pra ver o boot falhar alto se algo estiver errado:

```bash
./start.sh       # log na tela; Ctrl-C encerra pelo caminho normal (SIGINT → drenar)
```

O `start.sh` recompila se o `dist/` estiver mais velho que o `src/`, e **recusa subir
se o serviço systemd já estiver rodando**: dois processos no mesmo `BOT_TOKEN`
disputam o `getUpdates` e o bot passa a perder mensagens alternadamente — sintoma
caro de diagnosticar. Para ignorar a recusa: `./start.sh --forcar`.

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
./atualizar.sh                 # bot + domínios, compila e reinicia
./atualizar.sh --sem-restart   # atualiza e compila, sem tocar no serviço
./atualizar.sh --agora         # reinicia mesmo com job rodando (você assume)
./atualizar.sh --sem-dominios  # só o bot
```

**Ele atualiza os repos de domínio também** — e isso não é conveniência: o domínio
carrega `flow.json`, prompts, templates e o motor do reel. Bot novo com domínio
velho roda prompt antigo e produz vídeo errado, **sem erro nenhum no boot**. A lista
sai de `config/fluxos.json`, a mesma fonte que o bot lê. Domínio com mudança local é
**pulado**, nunca stashado: ali dentro moram os textos gerados pelos fluxos.

Ele faz o que a atualização na mão exigia lembrar, e nesta ordem: guarda edições
locais **deste repo** com `stash` (inclusive edições no próprio `atualizar.sh` — se
sumirem, estão em `git stash list`), `git pull --ff-only`, `npm ci` **forçando `NODE_ENV=development`**
(senão as devDeps somem e o build morre em `tsc: not found`), `npm run build`, e só
então reinicia — **detectando** se a unidade é de usuário ou de sistema, em vez de
assumir.

**A consulta de job em voo não é opcional, e por isso ela virou uma recusa.**
Reiniciar com render rodando mata o processo com SIGTERM e gasta uma tentativa do
job — é a seção [`código 143`](#código-143-não-é-erro-do-agente--é-restart). Quando
isso acontece, o código novo **já está compilado**: só o restart fica pendente.

**Clone anterior a 2026-08-08:** o script detecta e explica. Naquela data o repo foi
partido e o público renasceu de um commit órfão — quem clonou antes não tem ancestral
comum com o `origin`, e nenhum `git pull` traz o código novo (o sintoma é "puxei e não
veio nada", com `start.sh` simplesmente ausente). O script imprime a receita de
migração com os caminhos já preenchidos, preservando `.env`, banco e arquivos não
rastreados. O histórico velho continua em `inematds/inemaccbotx` (privado).

### 10. Numa VPS: onde cada arquivo mora

O `.env` do bot vai na **raiz do clone**, e isso não é preferência: `main()` lê
`resolve(process.cwd(), '.env')` e a unidade systemd usa `WorkingDirectory` +
`EnvironmentFile` apontando para a mesma pasta. Clonou em outro lugar? Edite **as
duas** linhas do unit, para o mesmo diretório — se divergirem, o systemd injeta um
`.env` e o `main()` lê outro, e o sintoma é confuso.

Numa VPS rodando como `root`:

| arquivo | quem lê | caminho |
|---|---|---|
| `.env` do bot (**config**) | `main()` + systemd | `/root/projetos/inemaccbot/.env` (`chmod 600`) |
| **cofre** (segredos de terceiros) | `HEYGEN_ENV_PATH`, `GROQ_ENV_PATH`, `IMG_ENV_PATH` | `/root/projetos/wifi/.env` (`chmod 600`) — é o **default**, criado pelo `scripts/instalar.sh` |
| login do Claude | CLI `claude` | `/root/.claude/.credentials.json` (`chmod 600`) |
| perfil do HeyGen (rota `\| estudio`) | `HEYGEN_PERFIL_CHROME` | `/root/.cache/inemaccbot/perfil-heygen` |

Os repos de domínio (`promoavatar`, `promoavatar3`) **não têm `.env` nenhum**: eles
leem tudo do ambiente que o bot repassa aos scripts filhos.

**Fontes de material (`config/fontes.json`) — registrado, ainda não ligado.** O
espelho do registry de destinos: destino responde "para onde vai o artefato",
fonte responde "de onde vem o material" (explicativo, trilha, b-roll). O domínio
pede por NOME (`trilhas`), e quem sabe o caminho é o bot — hoje o CTA do reel é
um caminho dentro do domínio, que é o tipo de coisa que envelhece ao trocar de
máquina. Duas regras: **fonte é PASTA** e **a escolha do arquivo é EXPLÍCITA**
(`lofi` → `trilhas/lofi.mp3`); nome ambíguo é recusado, nunca sorteado — sorteio
quebraria "mesmo pedido, mesmo resultado". O arquivo é **opcional**: ausente, o
registry fica vazio. `src/dominio/fontes.ts` está pronto e testado, mas **nada o
consome ainda** — ligar ao chat e ao `flow.json` é passo seguinte, e esse sim
muda comportamento.

**Dois arquivos, dois papéis** — confundi-los custa tempo: o `.env` do clone é
CONFIG do bot (`BOT_TOKEN`, `ALLOWED_CHAT_IDS`, caminhos) e não pode sair de lá;
o `wifi/.env` é o COFRE de segredo de terceiro (`HEYGEN_API_KEY`,
`GROQ_API_KEY`, `GOOGLE_API_KEY`, `AGNES_API_KEY`), um arquivo por máquina,
nunca versionado e nunca copiado por git. O `scripts/instalar.sh` cria o
esqueleto do cofre com `chmod 600` e avisa quais chaves estão vazias — preencher
é seu.

#### O `root` não é obrigatório — e um usuário de sistema é mais correto

Rodar como `root` é o caminho curto de VPS, e é o que o
`deploy/inemaccbot-sistema.service` traz hoje. Não é o certo: o bot executa
agentes que rodam comandos, e nada nele precisa de privilégio administrativo.
Num servidor que faça mais coisa que este bot, crie um usuário de sistema
dedicado:

```bash
sudo useradd --system --create-home --home-dir /srv/inemaccbot --shell /usr/sbin/nologin inemabot
```

**O que muda quando o usuário muda** — tudo que é derivado do `$HOME`, e é aqui
que a migração falha pela metade:

| item | valor com `root` | com um usuário dedicado |
|---|---|---|
| cofre (`HEYGEN_ENV_PATH` default) | `/root/projetos/wifi/.env` | `<home>/projetos/wifi/.env` |
| login do Claude | `/root/.claude/` | `<home>/.claude/` — **é por usuário**, tem que ser refeito ou copiado com `chown` |
| binário do Claude (`CLAUDE_BIN`) | `/root/.local/bin/claude` | o do novo `$HOME`, ou um caminho de sistema (`/usr/bin/claude`) |
| perfil do Chrome (`\| estudio`) | `/root/.cache/inemaccbot/perfil-heygen` | `<home>/.cache/…` — a sessão do HeyGen também é por usuário |
| clone, banco, `state/`, log | `/root/projetos/inemaccbot/` | onde você clonar — e o dono dos arquivos precisa ser o novo usuário (`chown -R`) |
| `PROJETOS_DIR` | — | **não muda**: o default é a pasta que contém o clone, não o `$HOME` |

E no unit: ajuste `User=`, `Group=`, `WorkingDirectory` e `EnvironmentFile`
juntos. A pegadinha clássica é o `%h`, que no escopo de sistema resolve para
`/root` **mesmo quando o serviço roda como outro usuário** — por isso a unidade
de sistema usa caminho absoluto, não `%h`. Se o `$HOME` do serviço não for o que
você imagina, o sintoma é sempre o mesmo: o cofre "não existe" e a chave "sumiu".

Fazer essa migração no meio de fluxo em voo perde trabalho: o `state/` e o banco
mudam de dono. Pare o serviço, confira `/status`, migre, e só então religue.

**Serviço na VPS: use o unit de SISTEMA.** A unidade de usuário
(`deploy/inemaccbot.service`) pressupõe sessão e linger — em servidor, o certo é
`deploy/inemaccbot-sistema.service`, que tem `User=`, caminhos absolutos e alvo
`multi-user.target`:

```bash
sudo cp deploy/inemaccbot-sistema.service /etc/systemd/system/inemaccbot.service
sudo systemctl daemon-reload && sudo systemctl enable --now inemaccbot
sudo systemctl stop|restart|status inemaccbot     # é isto que substitui um "stop.sh"
sudo journalctl -u inemaccbot -f
```

Ajuste `User=`, `WorkingDirectory` e `EnvironmentFile` antes — no escopo de sistema,
`%h` resolve para `/root` mesmo quando o serviço roda como outro usuário, e essa é a
pegadinha clássica de quem migra do unit de usuário. Os dois units **não** podem
rodar juntos com o mesmo `BOT_TOKEN`.

Há um atalho, e ele é o que a convenção do cofre desaconselha: como o `.env` é
publicado no ambiente do processo (`exportarParaAmbiente`), dá para pôr
`GROQ_API_KEY` direto nele e pular o cofre. Funciona, ao custo de misturar
segredo com config num arquivo que o modo pareamento reescreve — prefira o
cofre, e deixe o `.env` para configuração.

**O que muda de máquina** (o resto do `.env` é igual): `BOT_TOKEN` — use um bot
próprio, senão as duas instâncias disputam o `getUpdates` e cada uma pega metade das
mensagens; `ALLOWED_CHAT_IDS=0` para parear no primeiro `/ping`; `PUBLICO_URLS`, que
aqui são nomes da rede local e lá precisam do IP/domínio da VPS; e
`HYPERFRAMES_BROWSER_PATH`, que aponta para um snap que a VPS provavelmente não tem
(apague a linha e o default volta a valer).

O login do Claude e o do HeyGen **não** exigem navegador na VPS — os dois são
arquivo, e viajam por `scp`. O caso difícil é só a rota `| estudio`, cuja sessão
esbarra no Cloudflare por causa do IP; está levantado em `doc/` (fora do git).

## Configuração: o que só VOCÊ pode providenciar

Nada disto o bot resolve sozinho — são segredos, contas e ativos que moram fora do
repo. A coluna da direita diz o que quebra se faltar, para você não descobrir no meio
de um render.

| o quê | onde | se faltar |
|---|---|---|
| **Token do Telegram** | `BOT_TOKEN` no `.env` (BotFather) | o boot falha na hora: `config: falta BOT_TOKEN` |
| **Allowlist de chat** | `ALLOWED_CHAT_IDS` no `.env` — ou `0` para parear no primeiro `/ping` (passo 6) | vazio derruba o boot. Com o id errado o bot fica mudo: toda mensagem vira `rejeitada — fora da allowlist` no log |
| **Login do Claude** | `claude auth status` → `loggedIn: true` | o bot sobe e aceita comandos, mas **todo job de agente falha** — é a falha mais confusa de diagnosticar, porque tudo *parece* certo |
| **Binário do Claude** | `CLAUDE_BIN` (default `~/.local/bin/claude`) — **caminho, nunca o PATH**: o systemd roda com o PATH mínimo e `claude` cairia no `/usr/bin/claude` do sistema, que pode ser bem mais velho | o boot recusa subir se o caminho não existe. Com uma CLI antiga o sintoma é pior e mudo: o agente pede permissão a cada `Write`, ninguém responde, e a fase termina sem escrever arquivo nenhum (C#77 e C#78) |
| **CTA `cta-9x16.mp4`** | versionado nos dois repos de domínio, em `cta/` (passo 3) | 2 testes falham, e nenhum reel fecha: a última fase concatena o CTA no fim |
| **Perfil Chromium logado no HeyGen** | `HEYGEN_PERFIL_CHROME` (default `~/.cache/inemaccbot/perfil-heygen`) — você loga **uma vez, na mão**, naquele perfil | a rota `\| estudio` falha. É caminho, não segredo: os cookies moram dentro da pasta, fora do repo |
| **Tela para a rota `\| estudio`** | `DISPLAY` no serviço (aqui `:99`, o Xvfb do `stack99.service`) | o HeyGen **barra navegador headless**: carrega a app logada e joga o modal de login por cima, e a fase acusa "a sessão não está logada neste perfil" com a credencial certa. Sem `DISPLAY` o script cai em headless — que é o certo numa VPS sem Xvfb, e o errado aqui |
| **API key do HeyGen** | no arquivo apontado por `HEYGEN_ENV_PATH` (default `~/projetos/wifi/.env`, o cofre único do ecossistema) — qualquer arquivo com uma linha `HEYGEN_API_KEY=` serve; ver `.env.example` | as rotas `\| api` e `\| creditos` falham |
| **CLI do HeyGen** | binário `heygen` no PATH, ou o caminho em `HEYGEN_CLI` | idem |
| **Servidor do link final** | `PUBLICO_DIR` (a pasta servida) + `PUBLICO_URLS` (as bases de URL) | o vídeo é produzido, mas a mensagem chega sem link para baixar. São **duas** URLs porque a máquina fica em duas redes ao mesmo tempo |
| **Repos de domínio** | `promoavatar` e `promoavatar3` como irmãos (passo 2) | os fluxos quebram na primeira fase |

Regra geral: **`.env` guarda caminho e id; segredo de terceiro mora no arquivo do
dono dele.** É por isso que a key do HeyGen não foi copiada para cá.

Numa máquina onde esse "arquivo do dono" não existe — uma VPS, por exemplo — o
recomendado continua sendo um arquivo só dela
(`~/.config/inemaccbot/heygen.env`, `chmod 600`) apontado pelo `HEYGEN_ENV_PATH`.
Se preferir juntar tudo, o `HEYGEN_ENV_PATH` pode apontar para o **próprio `.env`**
do bot e a chave mora aqui: funciona sem mudar código, ao custo de misturar segredo
com config. O `.env.example` traz as duas receitas.

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
| `\| api` · `\| creditos` · `\| estudio` · `\| navega` | nenhuma | quem gera o avatar, e de que bolso sai. **Só uma por fluxo.** Sem nenhuma, quem grava no estúdio é você. Ver [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md) |
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

**Com script (rota A), em dois tempos.** `./scripts/gerar-manifesto.sh <url>` roda
onde há um modelo: ele lê o repo (inclusive o código do script, que é onde estão as
armadilhas), propõe os parâmetros marcando o que foi **chute**, deixa você editar, e
grava `config/integracoes/<nome>.json` + `prompts/<nome>.md` — versionados, para a
instalação ser igual em toda máquina. Roda **uma vez por repo**.

`./scripts/plugar-repo.sh <nome>` aplica um manifesto já
revisado de `config/integracoes/` — clona o repo irmão, confere binários e chaves do
cofre, valida a entrada com o validador do BOOT antes de escrever, mostra o diff e
para; só grava com `--sim`, e `--desfazer` restaura. **Nenhum modelo no caminho**:
quem lê o repo e decide fila, timeout e prompt é o `gerar-manifesto`, uma vez por
repo. Sem manifesto, ele recusa em vez de adivinhar.

E `./scripts/preparar-repo.sh ~/projetos/<repo>` faz o mesmo para um repo **seu**,
gravando o manifesto **dentro dele** (`integracao.json`): aí qualquer instalação do
bot o pluga só com o nome, sem adaptador local.

→ **Como os três funcionam, campo a campo:**
[`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md).

> 📘 **Exemplo completo, do clone ao primeiro job:**
> [**`docs/instalar-analisevideo.md`**](docs/instalar-analisevideo.md) — plugar um repo
> externo ([`analisevideo`](https://github.com/inematds/analisevideo)) pelas DUAS rotas,
> com os campos que cada validador cobra, a chave no cofre, e a tabela de sintoma → causa
> quando o boot recusa subir. As duas seções abaixo são o resumo; o documento é o passo a
> passo que alguém segue na mão numa VPS.

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

#### As seis rotas de avatar → [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md)

Quem gera o vídeo do avatar, e de que bolso sai, é escolha por fluxo: `| api`,
`| creditos`, `| estudio`, `| navega` — ou nenhuma, e aí quem grava no estúdio é
você. **Só uma por fluxo**; pedir duas é recusado na criação.

A decisão não é trivial: o custo muda por **autenticação**, não por parâmetro —
chave de API debita da carteira em dólar, OAuth debita créditos da assinatura. O
detalhe de cada rota, com custo medido e estado real de cada uma, está no documento.

Resumo do estado (verificado em 2026-08-09): a rota **normal** está em produção;
`| api`, `| creditos` e `| estudio` estão implementadas mas **nunca rodaram dentro
de um fluxo**; `| navega` só existe no `promoavatar`, congelado.

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

Este README responde a uma pergunta só: **o que é o bot, como instalar, configurar e
usar.** Todo o resto mora em documento próprio, linkado daqui. Se você veio parar num
detalhe longo dentro deste arquivo, é bug de organização — abra um issue ou mova.

**Os três que continuam o README:**

- [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md) — as seis rotas, custo medido e
  o estado real de cada uma. Leia antes de escolher `| api`, `| creditos` ou `| estudio`.
- [`docs/pipeline-e-custo.md`](docs/pipeline-e-custo.md) — por que a fase de reel deixou
  de ser agente, onde o custo de um fluxo realmente está, e por que a legenda é decidida
  no estúdio.
- [`docs/arquitetura.md`](docs/arquitetura.md) — boot, desligamento, filas, tarefas
  `function`, convenções. Leitura de quem mexe no código.
- [`docs/instalar-analisevideo.md`](docs/instalar-analisevideo.md) — plugar um repo
  externo (o [`analisevideo`](https://github.com/inematds/analisevideo)) no bot, à mão,
  pelas duas rotas: skill de catálogo e repo de domínio. Serve de molde para qualquer
  outra integração.
- [`docs/integrar-um-repo.md`](docs/integrar-um-repo.md) — **por que o manifesto e o
  plugar existem**: o bot conhece a ficha do repo, não o código; a metade cara (modelo,
  uma vez) e a barata (determinística, toda máquina); entrada, contrato de saída,
  skill vs. fluxo, portões, e os modos de falha já vividos
- [`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md) — a versão automática
  do de cima (rota A): o par `gerar-manifesto` (uma vez, com modelo) + `plugar-repo`
  (determinístico, em qualquer máquina), o esquema do manifesto e o que cada validação
  evita.
- [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md) — o mesmo para a rota B (fluxo): o par
  `gerar-manifesto-fluxo` + `plugar-fluxo`, por que o manifesto de fluxo CARREGA a
  definição (um fluxo não cabe do lado do bot), a regra de conflito que impede
  sobrescrever o repo de domínio, e por que a ordem materializar → registrar não é
  negociável. Mais: **roteiro do teste na VPS**, tabela sintoma → conserto, o que
  já foi verificado e o que não, e os limites do desenho automático (o modelo
  colapsa portões; `alvos` é sempre chute).

**Trocar o motor de agente** (o `claude` é o padrão, não o único):

- [`docs/motor-codex.md`](docs/motor-codex.md) — rodar os jobs pela CLI da OpenAI
  (`codex exec`). Ligar não mexe em nada do que já roda: `| motor=codex` num job,
  depois na skill, e só então no `.env`. Traz o que funciona e o que **não**
  funciona (as skills que dizem "Use a skill X" são de Claude Code e falham em
  silêncio em qualquer outro motor).
- [`docs/motor-opencode.md`](docs/motor-opencode.md) — o mesmo pela CLI aberta
  `opencode`, que fala com Anthropic, OpenAI, Groq, DeepSeek ou modelo local.
  **Runner ainda não verificado contra a CLI real** — o documento traz o roteiro
  de verificação e a tabela de sintoma → conserto.

**Domínios** (público, gatilho, canal, prompt, template — nada disso é do bot):

- [`promoavatar3`](https://github.com/inematds/promoavatar3) — o domínio **ativo**.
- [`promoavatar`](https://github.com/inematds/promoavatar) — **congelado** desde
  2026-08-06; mantido de pé, sem receber mudança de comportamento.

**Histórico e análises:**

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

**O `.env` também é publicado no ambiente do processo** (`exportarParaAmbiente`, chamado
por `main()`), e não só lido para o `Config`. Isso existe porque os scripts das fases
herdam o ambiente do bot (o `spawn` de `reel.ts` não passa `env:`), e sem essa publicação
o bot ficava assimétrico: sob systemd o `EnvironmentFile` já resolvia, mas pelo `./start.sh`
os filhos não viam nada. Estas **não** são lidas por `carregarConfig` — só repassadas:

| variável | default | quem usa |
|---|---|---|
| `INEMAIMG_HOST` | `http://localhost:8000` | `gen-imagem.py` (imagens do reel). Numa VPS, túnel para a GPU de casa: `ssh -R 8000:localhost:8000 <vps>` |
| `INEMAIMG_MODEL` | `flux2-klein` | idem |
| `IMG_PROVEDOR` | `inemaimg` | quem gera a imagem: `inemaimg` (GPU local, **seed respeitado**) ou `agnes` (API, US$ 0, **sem seed** — o determinismo do reel cai). `kie`/`fal` recusam: não implementados |
| `IMG_ENV_PATH` | — | arquivo com a chave do provedor (ex.: `AGNES_API_KEY=`). Alternativa: a variável direto no ambiente |
| `GROQ_ENV_PATH` | `~/projetos/wifi/.env` | `transcribe-groq.sh`. Alternativa: `GROQ_API_KEY` direto no ambiente, que tem precedência |
| `HEYGEN_API_KEY` | — | só se `HEYGEN_ENV_PATH` apontar para o próprio `.env` (ver `.env.example`) |

## Arquitetura em operação → [`docs/arquitetura.md`](docs/arquitetura.md)

Boot (a ordem importa e não é arbitrária), o que `drenar()` garante no desligamento
e o que não garante, filas e concorrência, as tarefas `function`, convenções do
código e por que o `Worker` é um stepper e não um serviço.

É leitura de quem vai mexer no código. Para instalar, configurar e usar, o que está
acima basta.
