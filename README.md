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

## Uso no chat

### Comandos de serviço

| comando | o que faz |
|---|---|
| `/ping` | verifica se o bot está vivo |
| `/ajuda` (`/help`) | a lista de comandos |
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
/promoavatar <assunto> [--alvo=jovens] [| legenda] [| versao=N] [| de=<fase>] [| sombra]
```

| opção | padrão | |
|---|---|---|
| `--alvo=x` (repetível) ou `\| alvos=a,b` | todos | só esses públicos |
| `\| legenda` | **desligada** | legenda no reel, caixa encostada na borda inferior |
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

#### As TRÊS rotas de avatar, e de que bolso cada uma sai

Quem decide de onde sai o custo **não é um parâmetro no corpo do POST — é a
autenticação**. A doc da HeyGen é explícita: *"When you authenticate with an API
Key (`x-api-key`), you are billed under the API tier. Usage is deducted from
your prepaid USD wallet"*, e *"OAuth (MCP and CLI `--oauth`) authenticates as
the user's web account and draws on subscription credits"*.

| rota | como | de onde sai | estado |
|---|---|---|---|
| **estúdio** (padrão) | você grava no HeyGen; o bot para no portão | crédito da assinatura | **em produção** |
| **`\| api`** | `heygen.gerar` → `POST /v3/videos` com `x-api-key` | carteira em US$ | **implementado, NÃO testado contra a API real** |
| **`\| creditos`** | CLI `heygen` autenticada por OAuth | crédito da assinatura | **não implementado** |

Saldos medidos em 2026-08-02: carteira **US$ 0,22**; assinatura **500 créditos**
(`plan_credit: 200` + `generative_credit: 300`). Um fluxo de 36 alvos consome
~26,5 min de vídeo — ~US$ 26 pela API (Avatar III) ou perto dos 500 créditos.

**Sobre a rota de créditos, três coisas que decidem se ela vale:**

1. A doc chama OAuth de **"trial-scale only"** e manda usar API key *"for
   anything at scale — batches, pipelines, production traffic"*. Um fluxo de 36
   alvos é exatamente o batch que eles desaconselham.
2. **O token OAuth expira** — não é segredo estático que se cole no `.env` como
   a `HEYGEN_API_KEY`. Quem renova é a CLI, que guarda a sessão em
   `~/.config/heygen`. Por isso o `.env` guardaria o CAMINHO da CLI
   (`HEYGEN_CLI=…`), não um token.
3. **Falta provar que a CLI roda headless** com a sessão salva. Se exigir
   interação a cada uso, a rota não serve para um bot sem ninguém na frente do
   terminal. Um teste de 15s responde isso e o custo real.

Existe ainda uma QUARTA forma, já declarada mas nunca exercitada: a fase
`fluxo-navegador` do `promoclub`, um agente dirigindo o estúdio pela sua aba
logada (crédito da assinatura, sem API). O banco não tem **nenhum** job dessa
tarefa até hoje — está escrita, não provada.

**Cuidado com o motor.** O `/v3/videos` usa **Avatar IV por padrão**, que custa
US$ 0,05–0,0667/s contra **US$ 0,0167/s do Avatar III** — 3 a 4× mais caro pelo
mesmo minuto. O campo `engine` tem que ser explícito; deixar no default é
escolher o caro sem saber.

Detalhe completo, com as travas de idempotência e de saldo:
[`docs/fase-avatar-via-api.md`](docs/fase-avatar-via-api.md).

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
- Arquitetura: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md`
- Perfil de execução (motor/modelo/esforço): `docs/perfil-de-execucao.md`
- Planos: `docs/superpowers/plans/` (uma etapa por arquivo, 0 a 5 + promoclub)
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
| `io` | 10 | `http.get` |
| `cpu` | 1 | `ffmpeg.thumb` |
| `texto` | 2 | nenhuma — ociosa |
| `render` | 1 | nenhuma — ociosa |
| `navegador` | 1 | nenhuma — ociosa |

## As duas tarefas `function`

O catálogo (`src/fila/tarefas/index.ts`) é **fechado**: o campo `tarefa` de um job só pode ser uma
das chaves aqui, nunca texto livre do usuário.

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
