# inemaccbot — design (spec)

Data: 2026-07-30 · **revisão 2** (incorpora `docs/analise_critica_inemaccbot_design.md`).
Aprovado seção a seção pelo usuário.

Sistema novo, repo novo. **Nada é alterado no `inemaccvbot`**, que segue em produção até o cutover e
depois é desligado. Este documento é a arquitetura fina; cada subsistema pode ganhar spec próprio.

## 0. Sumário da decisão

| item | decisão |
|---|---|
| forma | **monólito modular**: um serviço supervisor com processos de trabalho filhos (Claude, Chromium, ffmpeg) |
| repos | **1 repo de plataforma** (`inemaccbot`) + **N repos de domínio** (um por fluxo) · 1 serviço · 1 banco operacional |
| nome | pasta/repo/serviço `inemaccbot` (sem o `v` de vídeo — o escopo deixou de ser só vídeo) |
| fila | **interna ao processo** — não há serviço separado, logo o nome `mkiservico` não é usado; env sem nome de produto (`QUEUE_DB`, `BOT_TOKEN`) |
| Telegram | token novo (bot novo); token antigo revogado na etapa 6 |
| motor de fila | **portado do `mkivideos`** (escrito host-agnóstico), corrigido para claim atômico + lease |
| tipos de job | `kind = agent` (sobe `claude -p`) · `kind = function` (código determinístico) |
| execução única | lease **+ chave de idempotência por fase/alvo** — lease sozinho não basta (§2.5) |
| prioridade | **não-preemptiva** — `/furar` põe na frente, nunca mata job em execução |
| fluxo | opcional por comando; **definição congelada** na criação (§3.4) |
| infra | SQLite em WAL, migrations versionadas, backup via API. **Sem** Redis/Postgres |

## 1. Camadas

```
Telegram
   │
┌──┴──────────────────────────────────────────────┐
│ inemaccbot — serviço supervisor                 │
│   gateway/   recebe, interpreta, notifica       │
│   fluxos/    estado + decide a próxima fase     │
│   fila/      claim atômico + workers por fila   │
│   dominio/   registries (skills/fluxos/destinos)│
└─────────────────────────────────────────────────┘
   ├─ kind=function → async no worker (HTTP) · child_process (ffmpeg) · worker_thread (CPU JS)
   └─ kind=agent    → child_process: claude -p / claude --chrome -p → skill
```

Regra que sustenta o desenho: **quem orquestra não trabalha, quem trabalha não decide.** O worker
executa um job e marca `done`/`failed`; quem lê isso e escolhe a próxima fase é o `fluxos/`.

### 1.1 Roteamento tem DUAS portas (nunca fluxo obrigatório)

```
gateway → é comando de fluxo (config/fluxos.json) ou de skill (config/skills.json)?
            ├─ skill → 1 job na fila                     (sem estado, sem fase, sem /status)
            └─ fluxo → cria estado → 1 job por fase/alvo  (com retomada e /status)
```

Um `explicativo` não paga arquivo de estado, ID de execução nem subcomandos. **Critério:** vale a
pena lembrar onde parou? Se "rodar de novo do zero" é aceitável, é skill. Se há trabalho parcial que
seria absurdo jogar fora, é fluxo.

### 1.2 O bot hospeda workers — de propósito

No v1 o bot executava `claude -p` inline (`runFase1`/`runFase2`), com mutex em memória, sem retry
nem timeout. No v2 continua hospedando execução, mas com **disciplina de worker**:
`claim → lease → executa fora do event loop → ack`, com retry, backoff, heartbeat e drain. A
diferença não é fronteira de processo, é disciplina.

**Onde cada `kind=function` roda** (correção da revisão 1, que mandava tudo pra subprocesso):

| trabalho | onde |
|---|---|
| HTTP / API / poll | `await` assíncrono no próprio worker — não bloqueia o event loop |
| ffmpeg e afins | `child_process` |
| CPU pesado em JS | `worker_thread` |
| Claude (`kind=agent`) | `child_process` |

O invariante é **"nada bloqueia o event loop"**, não "todo function vira processo". Um `fetch`
aguardado não bloqueia nada; criar processo pra ele é custo puro.

### 1.3 Drain no `SIGTERM` — semântica correta

Correção da revisão 1, que dizia "solta os leases". **Soltar lease com o processo vivo permite dupla
execução** — o oposto do que o drain existe para evitar. A ordem correta:

1. para de aceitar novos claims;
2. **continua renovando** o lease dos jobs em execução (heartbeat);
3. aguarda os jobs até `TimeoutStopSec`;
4. no timeout, encerra a **árvore** de subprocessos (kill do process group);
5. só então devolve o job à fila (`queued`) — ou deixa o lease expirar, se o processo já morreu.

**Escape hatch documentado:** como `fluxos/` só fala com `fila/` por interface, mover os workers
para um segundo processo depois é trocar chamada de função por IPC — sem tocar fluxo, skill ou
domínio. Gatilho para reconsiderar: restart do gateway doer com frequência, ou segunda máquina.

## 2. Fila

### 2.1 Tabela `jobs`

```sql
id              INTEGER PRIMARY KEY
fila            TEXT     -- render | navegador | texto | io | cpu
kind            TEXT     -- agent | function
tarefa          TEXT     -- nome da skill (agent) ou da função (function)
input           TEXT     -- JSON de argumentos
prioridade      INTEGER  -- default 0; /furar sobe
status          TEXT     -- queued | running | done | failed | canceled
tentativas      INTEGER
max_tentativas  INTEGER
lease_ate       INTEGER  -- timestamp; renovado por heartbeat; vencido → volta para queued
disponivel_em   INTEGER  -- claim só pega quando <= now (poll, backoff, agendamento)
idem_key        TEXT     -- chave de idempotência (§2.5); NULL em job sem efeito externo
flow_ref        TEXT     -- "P#16/mulheres/render" ou NULL (job solto)
chat_id         INTEGER  -- para quem responder (NULL em fase de fluxo)
resultado       TEXT
erro            TEXT
criado_em / iniciado_em / terminado_em INTEGER
```

Índices: `(fila, status, disponivel_em, prioridade)` para o claim; `flow_ref` para histórico.

**Linhas de `jobs` nunca são deletadas** — cada tentativa fica registrada. É o histórico de execução
(§3.5), sem tabela paralela.

### 2.2 Claim atômico

```sql
UPDATE jobs SET status='running', lease_ate=?, tentativas=tentativas+1
WHERE id = (SELECT id FROM jobs
            WHERE status='queued' AND fila=? AND disponivel_em <= ?
            ORDER BY prioridade DESC, id ASC LIMIT 1)
RETURNING *;
```

SQLite em WAL com `busy_timeout` faz concorrência > 1 sem infra extra. O que limita a fila hoje é o
padrão de uso (`SELECT` seguido de `UPDATE`), não o SQLite.

### 2.3 Filas = classe de recurso

| fila | conc. | kind típico | para quê |
|---|---|---|---|
| `render` | 1 | agent | vídeo/reel — GPU e token |
| `navegador` | 1 | agent | `claude --chrome -p`, Chromium `:99` exclusivo |
| `texto` | 2 | agent | transcrever, dublar |
| `io` | 10 | function | HTTP/API, download, poll de status |
| `cpu` | 1 | function | **ffmpeg**, conversão, thumbnail |

Revisão 1 tinha uma fila `leve` só, com ffmpeg dentro — errado: ffmpeg compete por CPU/GPU com o
render e não é leve. Separado em `io` e `cpu`.

Exclusividade é **propriedade da fila** (`navegador` com concorrência 1), não variável em memória.
Não existe tabela `locks` — só entra se aparecer exclusividade mais fina (ex.: duas contas HeyGen).

As concorrências por fila já limitam o total de agentes Claude simultâneos (render 1 + navegador 1 +
texto 2 = 4). **Não** há teto global separado: seria um segundo mecanismo para o mesmo invariante.

### 2.4 Prioridade

Não-preemptiva. `/furar <job>` põe na frente; `/cancelar <job>` mata o que está rodando, por decisão
humana. Preempção automática num render de 15 min sem checkpoint queima token e é a parte mais
propensa a bug do sistema — fora de escopo.

### 2.5 Execução única de verdade: lease **+** idempotência

Lease garante **claim único**, não **efeito único**. O furo concreto:

```
worker cria o vídeo no HeyGen → processo morre antes de gravar o ID
   → lease vence → outro worker roda a mesma fase → cria o vídeo DE NOVO
```

Toda tarefa com efeito externo recebe `idem_key = <flow_ref>` (ex.: `P#16/mulheres/render`) — ou,
para job solto, uma chave derivada da entrada. Contrato obrigatório da tarefa:

> **procure antes de criar.** Se já existe operação ou artefato com essa chave, adote-o e siga.

Isso é implementável hoje porque o v1 já produz um nome único e determinístico por fase/alvo:
`tituloCurto(id, publico, versao)` → `P16-mulheres-v1`, gravado no campo "nome do vídeo" do HeyGen.
A fase de render consulta o estúdio por esse nome antes de criar. Mesma ideia para download
(arquivo já existe → adota) e para `reel` (job com mesmo `idem_key` já `done` → não reenfileira).

`UNIQUE(idem_key, status)` não serve (vários `failed` legítimos). A regra é aplicada na tarefa, e
testada (§6.2).

## 3. Fluxos

### 3.1 Fase = template de job

Uma fase não executa nada: descreve **qual job enfileirar**. O runtime não conhece "fase de
navegador" nem "fase de API" — só monta job.

```jsonc
{ "id": "render", "fila": "navegador", "kind": "agent",
  "tarefa": "fluxo-navegador", "prompt": "prompts/fase2.md",
  "escopo": "alvo",            // "fluxo" = 1 job para todos | "alvo" = 1 job por alvo
  "max_tentativas": 2 }
```

`escopo` vem do caso real: o promoclub gera os 12 textos em **um** job (`fluxo`) e renderiza **um job
por público** (`alvo`).

### 3.2 `flow.json` — vive no repo de domínio

```jsonc
{
  "nome": "promoclub", "prefixo": "P", "versao_def": 1,
  "alvos": {
    "mulheres":     { "canal": "lives21", "gatilho": "..." },
    "pais-lives32": { "canal": "lives32", "gatilho": "..." }
  },
  "fases": [
    { "id": "texto",  "escopo": "fluxo", "fila": "texto",     "kind": "agent",
      "tarefa": "fluxo-agente",    "prompt": "prompts/fase1.md" },
    { "id": "render", "escopo": "alvo",  "fila": "navegador", "kind": "agent",
      "tarefa": "fluxo-navegador", "prompt": "prompts/fase2.md", "max_tentativas": 2 },
    { "id": "baixar", "escopo": "alvo",  "fila": "io",        "kind": "function",
      "tarefa": "heygen.baixar",   "espera": { "intervalo": 120, "timeout": 5400 } },
    { "id": "reel",   "escopo": "alvo",  "fila": "render",    "kind": "agent",
      "tarefa": "reel", "entrega": "{canal}" }
  ]
}
```

A última fase usa a **skill `reel` do catálogo**, a mesma que o usuário dispara no chat: fluxo é
cliente da fila como qualquer um.

`espera: { intervalo, timeout }` (segundos) descreve fase de *poll*: se a tarefa `function` ainda não
encontrou o que aguarda, reagenda a si mesma com `disponivel_em = now + intervalo`, até `timeout`
contado do primeiro enfileiramento da fase — então o alvo vai para `falhou`. Sem isso o poll viraria
busy-loop.

**Domínio diz para quem, o bot sabe onde:** o `flow.json` referencia canal por nome (`lives21`),
nunca por ID. O mapa de destinos é registry único no `inemaccbot` (`dominio/`), evitando N cópias
divergentes da lista de canais.

### 3.3 Estado em tabelas, no MESMO DB da fila

```sql
fluxos
  id, tipo, slug, assunto, versao, chat_id, status, criado_em,
  definicao_json TEXT,     -- snapshot imutável do flow.json (§3.4)
  definicao_hash TEXT,     -- sha256 do snapshot + dos prompts
  versao_def     INTEGER

fluxo_fases
  fluxo_id, fase, alvo, escopo, estado, job_id, tentativas, dados(JSON), erro,
  PRIMARY KEY (fluxo_id, fase, alvo)
  -- alvo = '' (string vazia) quando escopo='fluxo'; sentinela em vez de NULL para a PK funcionar
  -- estado: pendente | rodando | feito | falhou | pulado
```

Correção da revisão 1: ela tinha `fluxo_alvos(fluxo_id, alvo)` — **sem lugar para a fase de escopo
`fluxo`**. `fluxo_fases` com `alvo=''` resolve; um fluxo com fase global e fases por alvo cabe na
mesma tabela:

```
texto   alvo=''          escopo=fluxo
render  alvo=mulheres    escopo=alvo
reel    alvo=mulheres    escopo=alvo
```

Sai o `state/<slug>.json` do v1. Estar no mesmo DB é o que torna **"marcar fase concluída +
enfileirar a próxima" uma única transação** — elimina por construção o dispatch duplicado do v1.
`dados` é o único campo livre (título HeyGen, caminho de arquivo), para não engessar schema por
fluxo. Artefatos continuam no repo de domínio (`output/`); o DB guarda progresso, não conteúdo.

### 3.4 Definição congelada

Um fluxo em andamento **não pode** depender do `flow.json` no disco: editar a lista de alvos ou um
prompt no meio de uma execução mudaria as regras do jogo em voo.

Na criação, o runtime grava `definicao_json` (snapshot completo), `definicao_hash`
(sha256 do JSON + conteúdo dos prompts referenciados) e `versao_def`. **Toda decisão de fase lê o
snapshot, nunca o disco.** Consequências:

- editar `flow.json` afeta só fluxos novos;
- `/status P#16` mostra `versao_def` e avisa se o disco divergiu do snapshot;
- um fluxo antigo retomado após restart continua coerente;
- `/refazer` usa o snapshot original — retentar não muda as regras.

### 3.5 Avanço dirigido por evento — não existe watcher

```
worker termina job → (mesma transação)
                      ├─ jobs:        status = done
                      ├─ fluxo_fases: estado → feito, dados ← resultado
                      └─ próxima fase daquele alvo → INSERT em jobs
                     commit
```

Cada alvo caminha independente: o público 3 pode estar no reel enquanto o 9 espera render. Sem
barreira entre fases (nenhum fluxo atual precisa; se precisar, entra `"barreira": true` na fase).

**Histórico**: `fluxo_fases` guarda o estado *atual*; o histórico completo (cada tentativa, com
duração, erro e resultado) são as linhas de `jobs` com aquele `flow_ref`, que nunca são deletadas.
Uma view `fluxo_historico` junta os dois. Deliberadamente **sem** tabela `fluxo_execucoes`: seria uma
segunda escrita do mesmo fato, com dois lugares para divergir.

### 3.6 Falha, retry, restart

1. Job falha e `tentativas < max_tentativas` → volta a `queued` com backoff via `disponivel_em`
2. Esgotou → `fluxo_fases.estado = falhou`, grava `erro`, **notifica no chat**, e os outros alvos seguem
3. `/refazer P#16` → só o que está `falhou` volta a `pendente`, tentativas zeradas
4. `/refazer P#16 <alvo>` → um alvo só

Um fluxo nunca morre por inteiro por causa de um alvo.

No boot, nessa ordem: (a) `jobs` com `lease_ate` vencido → `queued`; (b) `running` sem worker vivo →
idem; (c) `fluxo_fases` em `pendente` sem job correspondente → enfileira (rede de segurança). Não
existe código especial de "retomada de fase 2": é consequência do lease + idempotência.

### 3.7 Cancelamento — contrato explícito

Toda tarefa (function ou agent) é executada por um *runner* com quatro operações:

```
start()      inicia; devolve handle
heartbeat()  renova lease_ate enquanto vive (obrigatório em job longo)
cancel()     encerra a ÁRVORE de subprocessos (kill do process group), não só o pai
cleanup()    remove parciais (arquivo .part, tmp) e libera recursos
```

Regras:
- `/cancelar <job>`: `queued` → `canceled` direto; `running` → `cancel()` + `cleanup()` → `canceled`
- **`ack done` após cancelamento é rejeitado** — um job cancelado nunca vira `done` por corrida
- `/cancelar P#16 [alvo]`: cancela os jobs pendentes/rodando daquele fluxo e marca as fases `pulado`
- Operação externa já criada (render no HeyGen) **não** é desfeita automaticamente; a mensagem de
  cancelamento diz o que ficou lá, para decisão humana

### 3.8 Interface de `fluxos/`

```
criar(tipo, assunto, opts) → fluxoId      // congela a definição
avancar(jobId, resultado)  → jobs enfileirados   // chamado pelo worker
status(ref)                → visão
refazer(ref, alvo?)
cancelar(ref, alvo?)
exportar(ref) → JSON  ·  importar(JSON) → fluxoId   // rollback (§7.6)
```

Testável com fila fake e `flow.json` de brinquedo — sem Telegram, sem Claude, sem HeyGen.

### 3.9 Comandos

| comando | efeito |
|---|---|
| `/skills` · `/fluxos` | listam os registries |
| `/<fluxo> <assunto> [\| alvos=a,b] [\| versao=N]` | cria e dispara |
| `/status [P#16]` | tabela fase × alvo × estado (+ `versao_def`) |
| `/status log` (alias `/statuslog`) | histórico — alias pela memória muscular do v1 |
| `/refazer P#16 [alvo]` | retenta o que falhou |
| `/cancelar P#16 [alvo]` \| `/cancelar <job>` | cancela |
| `/furar <job>` | prioridade máxima |
| `/fila` | por fila: rodando, pendentes, mais antigo, lease vencendo, taxa de erro 24h |

`/status` é genérico e serve **todos** os fluxos — sem código por fluxo. Esse é o teste do desenho:
**fluxo novo = 1 entrada em `config/fluxos.json` + 1 repo de domínio, zero linha de código.**

### 3.10 Quando criar um fluxo (e um repo de domínio)

| situação | o que é |
|---|---|
| mesmo pipeline, assunto diferente | um **alvo** — nada novo |
| mesmo pipeline, públicos diferentes | edita `flow.json` — nada novo |
| fases diferentes, prompts e artefatos próprios | **fluxo novo → repo de domínio novo** (ex.: `inemaavatarclub`) |
| uma etapa só, sem estado | **skill** — entra no `skills.json` |

## 4. Estrutura do repo

```
inemaccbot/
├── src/
│   ├── gateway/    bot, parser, interpret, help, reply, media, answer
│   ├── fila/       types, store, claim, worker, runner, dashboard, tarefas/
│   ├── fluxos/     runtime, estado, status, export
│   ├── dominio/    registries + destinos
│   ├── db/         migrations/ (versionadas, com checksum), backup
│   └── index.ts    boot, drain
├── config/         skills.json, fluxos.json, destinos.json
├── deploy/         inemaccbot.service
└── docs/
```

Fronteira: `fila/` não importa de `gateway/` nem de `fluxos/`; `fluxos/` não importa de `gateway/`;
`gateway/` importa só a *interface* da fila, nunca o store concreto; `dominio/` não importa nenhum
dos três. **Verificado por teste** (§6.4), não por revisão humana.

## 5. Migração — módulo por módulo

### 5.1 De `inemaccvbot` (2.963L código + 2.797L teste)

| módulo | L | destino | por quê |
|---|---|---|---|
| `reply.ts` | 68 | porta igual | corte de 4096 chars do Telegram; conhecimento duro |
| `log.ts` | 60 | porta igual | rotação de log |
| `media.ts` | 90 | porta igual | download de anexo, nome seguro |
| `deliver.ts` | 73 | porta igual | entrega + sanitização anti-traversal |
| `answer.ts` | 149 | porta igual | respostas de serviço |
| `dests.ts` | 23 | porta igual | descobre `yt-pub-lives<N>`; vira registry de destinos |
| `parser.ts` | 131 | porta + estende | roteia nos 2 registries |
| `interpret.ts` | 128 | porta + estende | o prompt do `claude -p` passa a conhecer fluxos |
| `skills.ts` | 32 | porta + estende | vira loader de registry |
| `jobref.ts` | 40 | simplifica | prefixos `V#`/`T#` existiam por causa de 2 DBs; agora id é global |
| `help.ts` | 57 | reescreve | gerado dos registries |
| `config.ts` | 66 | reescreve | env sem nome de produto |
| `bot.ts` | 724 | reescreve fino | vira `gateway/` de roteamento |
| `promoclub.ts` | 822 | divide | ~350L → `fluxos/` genérico · domínio → `flow.json` |
| `state.ts` | 92 | descarta | substituído por `jobs.chat_id` + tabelas de fluxo |
| `queue-client.ts` | 118 | descarta | `execFile` + regex em stdout → chamada tipada |
| `watcher.ts` | 196 | descarta | avanço passa a ser transacional |

Cuidado de cutover no `jobref`: nas etapas 1–5 os dois bots estão vivos e o usuário pode colar no bot
novo um id vindo do velho. Um id que não exista no DB novo é **rejeitado com mensagem clara**
("job #N não é deste bot — veja `/fila`"), nunca resolvido silenciosamente contra o DB próprio, que
agiria no job errado. Ids com prefixo `V#`/`T#` são rejeitados do mesmo jeito.

Porta direto ou quase: ~800L (27%). Reescreve/dilui: ~1.700L. Descarta: ~400L.

### 5.2 De `mkivideos` (2.480L) → `fila/`

O `types.ts` do `mkivideos` abre com *"Contratos do motor de fila — host-agnósticos (ports &
adapters). Um host … implementa QueueStore + QueueDeps"*: o motor **já foi escrito para ser
portado**. O `inemaccbot` entra como novo host.

| módulo | destino |
|---|---|
| `types.ts` (152) | porta + estende: `skill` deixa de ser union hardcoded e vira string do registry; entram `fila`, `kind`, `prioridade`, `lease_ate`, `disponivel_em`, `idem_key`, `flow_ref` |
| `queue.ts` (636) | porta: parse/prompt/worker, já host-agnóstico |
| `sqlite-store.ts` (165) | porta + **corrige**: hoje é `SELECT … LIMIT 1` seguido de `UPDATE` (não atômico) e no boot marca todo `running` como `failed: "interrompido por reinício"`. Vira claim atômico + lease — o job volta à fila em vez de morrer |
| `dashboard.ts` (188) | porta: ganha fila, prioridade e métricas (§8) |
| `cli-lib.ts` (213) | porta parcial: o runner `claude --model … -p` é o `kind=agent`; o resto é opcional |

Achado registrado: o `mkivideos` já tem `kind: 'plan'` — job cujo trabalho é enfileirar outros jobs
(URL de curso → 1 job por módulo). É um proto-fluxo sem estado nem retomada; o `fluxos/` generaliza.
`plan` pode virar fluxo de 2 fases ou permanecer como está.

### 5.3 Código realmente novo (~1.100–1.400L)

1. `fluxos/` runtime — estado, congelamento, avanço transacional, export/import (~450L, parte adaptada do `promoclub.ts`)
2. Loader e **validação forte** dos registries (`skills.json`, `fluxos.json`, `flow.json`) (~150L)
3. Tarefas `kind=function` com contrato de idempotência — `heygen.baixar`, `http.get`, `ffmpeg.*` (~200L, cresce por demanda)
4. Runners `fluxo-agente` / `fluxo-navegador` + contrato `start/heartbeat/cancel/cleanup` (~200L)
5. Boot: recuperação de lease + drain correto + kill de árvore de processos (~120L)
6. `db/migrations` versionadas com checksum + backup/restore (~120L)

### 5.4 Domínio que sai do bot

`PUBLICO_LIVES` e `PUBLICO_GATILHO` (`promoclub.ts:11-33`) e os prompts das fases 1 e 2 vão para
`inemaclubpromover/flow.json` + `inemaclubpromover/prompts/`. Trocar um público deixa de exigir
recompilar e reiniciar o bot.

Nota: **não existe** `~/.claude/skills/inemaclub-textos` — a "skill" citada no v1 é instrução dentro
do `inemaclubpromover/CLAUDE.md`, executada pelo `claude -p` com cwd lá. No v2 isso passa a ser
`flow.json` + `prompts/`, sem fingir ser skill.

## 6. Testes e qualidade

### 6.1 Fakes obrigatórios

| dependência | fake |
|---|---|
| Telegram | `Enfileirador`/`Notificador` fake — nenhum teste toca a API |
| `claude -p` / `--chrome -p` | `Runner` injetável com stdout canned: sucesso, falha e "sucesso fantasma" (caso real do v1) |
| HeyGen / HTTP | `fetch` injetado |
| relógio | **`now()` injetável** — obrigatório: lease, backoff e `disponivel_em` são tempo. Sem isso o teste vira `sleep`: lento e instável |

### 6.2 O que precisa ser real

- **SQLite em arquivo temporário, não `:memory:`** — claim atômico, WAL e `busy_timeout` não existem
  em memória. Um DB por teste, em `tmp`, apagado no fim.
- **Concorrência de verdade**: N workers, 1 job → executou exatamente 1 vez.
- **Idempotência (§2.5)**: mata o worker *depois* do efeito externo e *antes* do ack → ao reprocessar,
  a tarefa **adota** o artefato existente e não cria segundo. É o teste mais importante da suíte.
- **Drain (§1.3)**: `SIGTERM` com job em execução → lease continua sendo renovado, job termina ou é
  devolvido; nunca dois workers na mesma fase.
- **Cancelamento (§3.7)**: `cancel()` mata a árvore (nenhum processo filho órfão) e `ack done`
  posterior é rejeitado.
- **Restore**: backup gerado pela API do SQLite é restaurado num DB novo e a suíte de fila passa nele.

### 6.3 Camadas

1. **Unidade pura** — `parser`, `jobref`, `reply`, `dests`, `log`, validação de registry
2. **Fila (DB real)** — claim, prioridade, lease/heartbeat/expiração, retry com backoff, `disponivel_em`, drain, limite por fila
3. **Fluxos (fila real + runners fake)** — `flow.json` de brinquedo (3 fases, 2 alvos, uma com `escopo: fluxo`): avanço independente por alvo, falha isolada, `/refazer` seletivo, retomada após kill, definição congelada (editar o disco não afeta fluxo em voo), e atomicidade (crash entre "marcar fase" e "enfileirar" não deixa fase órfã)
4. **Gateway (fila fake)** — roteamento nas 2 portas, texto livre via `interpret`, corte de 4096, anexo, entrega, rejeição de id cross-bot
5. **Aceitação manual** — os testes reais da §7.4 (custam GPU e token; não automatizados)

### 6.4 Teste de arquitetura

Um teste varre os `import` de cada pacote e falha se qualquer regra da §4 for violada. É o que
impede o monólito modular de virar monólito — verificável em CI, não em revisão humana.

### 6.5 Testes herdados

**Nenhum teste do v1 é descartado sem equivalente no v2 ou justificativa escrita.** Em especial:

- `watcher.test.ts` — 443L para um arquivo de 196L, com comentários citando "finding 4": bugs de
  produção fossilizados. O `watcher.ts` morre; os casos viram regressão do avanço transacional. Caso
  sem equivalente = buraco no v2.
- `promoclub.test.ts` (413L) — o que testa fase/estado/retomada vira teste do `fluxos/` genérico; o
  que testa públicos/canais vira fixture de domínio.

## 7. Cutover

### 7.1 Desligar por fila, não tudo de uma vez

Se `mkivideos.service` e o `inemaccbot` estiverem ambos com fila de render viva, **dois renders
competem pela mesma GPU sem saber um do outro**. Logo: quando a fila nova de uma classe passa a
validação, o serviço velho equivalente desliga na hora.

| etapa | fila nova validada | desliga na hora |
|---|---|---|
| 1 | `io`, `cpu` | — (não existem hoje) |
| 2 | `texto` | `mkitexto.service` |
| 3 | `render` | `mkivideos.service` |
| 5 | `navegador` | `/promoclub` do bot velho |
| 6 | — | `inemaccvbot.service` |

### 7.2 Etapas

- **0 · esqueleto** — repo, `.env` 600 fora do git, SQLite WAL, migrations, unit systemd. Porta o
  motor do `mkivideos` com as colunas novas, claim atômico, lease com heartbeat e drain correto.
  Nenhum comando de Telegram. Fecha com a suíte de fila verde, incluindo dois workers disputando o
  mesmo job e o teste de idempotência.
- **1 · `io`/`cpu` + gateway mínimo** — `/ping`, `/status`, `/fila` e duas tarefas `function`
  (`http.get`, `ffmpeg.thumb`). Valida claim, lease, drain, cancelamento e prioridade com jobs
  baratos: barato de errar.
- **2 · `texto`** — `transcrever`, `dublar`. Porta `interpret`, `parser`, `reply`, `media`,
  `deliver`, `answer`. Compara saída com o velho → desliga `mkitexto.service`.
- **3 · `render`** — `explicativo`, `curso`, `demo`, `reel`, `reelinematds`. Um teste real por skill
  → desliga `mkivideos.service`.
- **4 · paridade operacional** — `help` gerado, `/furar`, `/cancelar`, `/refazer`, dashboard com
  métricas, e os casos do `watcher.test.ts` como regressão. Sem isso, desligar o velho deixa o
  sistema cego.
- **5 · fluxos** — `fluxos/` + fila `navegador` + `flow.json`/`prompts/` no `inemaclubpromover`,
  com definição congelada e export/import. **Pré-condições:** nenhum `P#N` em voo no velho, e
  **validação em sombra** aprovada (§7.5).
- **6 · desligar** — `systemctl disable --now inemaccvbot`, repo v1 em modo arquivo com README
  apontando para o novo, token antigo revogado no BotFather.

### 7.3 Deploy

- Um `.env` modo 600: `BOT_TOKEN`, `QUEUE_DB`, `STATE_DIR`, `ALLOWED_CHAT_IDS`… **sem nome de
  produto nas variáveis**.
- SQLite em **WAL** + `busy_timeout` — obrigatório para concorrência > 1.
- **Migrations versionadas** (`schema_migrations`: `version`, `applied_at`, `checksum`); boot recusa
  subir se um checksum divergir.
- **Backup pela API do SQLite** (`.backup`/Backup API), nunca `cp` do arquivo principal — com WAL, a
  cópia crua sai inconsistente. Retenção definida + **teste de restore** na suíte (§6.2). Backup
  antes de cada deploy da etapa ≥ 2: o DB passa a carregar estado de fluxo, não só fila.
- Unit: `KillSignal=SIGTERM`, `TimeoutStopSec=120`, para o drain caber.
- `git push` via **SSH** se o commit tocar `.github/workflows/*` (o token `gh` da conta `inematds`
  não tem escopo `workflow`).
- Etapas 1–5: dois bots no ar, **tokens e DBs diferentes**, apontando para os **mesmos repos de
  domínio** — daí a pré-condição da etapa 5.

### 7.4 Aceitação por etapa (o que "validado" significa)

| etapa | prova |
|---|---|
| 0 | 2 workers, 1 job → só um pega. Kill após efeito externo e antes do ack → não duplica. `SIGTERM` com job em voo → lease renovado, sem dupla execução |
| 1 | 20 jobs `io` em paralelo; `/furar` faz o último sair primeiro; `/cancelar` num ffmpeg não deixa processo órfão |
| 2 | mesma entrada nos dois bots → saída equivalente |
| 3 | 1 render por skill, entrega no destino certo |
| 4 | cada caso do `watcher.test.ts` com equivalente verde; `/fila` mostra métricas reais |
| 5 | `P#N` de 2 públicos ponta a ponta; kill no meio da fase 2 → retoma **sem criar segundo render no HeyGen**; editar `flow.json` no meio não muda o fluxo em voo |

### 7.5 Validação em sombra (pré-condição da etapa 5)

Antes de deixar o fluxo executar, o runtime roda em **modo sombra**: interpreta o `flow.json`,
congela a definição, e **monta o plano de jobs sem enfileirar** — imprime fase × alvo × fila ×
tarefa. Compara-se com o que o v1 faria. Erro de definição aparece antes de gastar GPU e de tocar o
HeyGen.

### 7.6 Rollback

Etapas 1–4: `systemctl start` do serviço velho correspondente + desabilita o comando no novo —
barato, porque as filas são independentes.

Etapa 5 deixa de ser "sem volta": `fluxos.exportar(ref)` produz JSON com estado por fase/alvo, e
`importar` reconstrói. O par export/import é **pré-requisito da etapa 5**, não melhoria futura — é o
que permite voltar atrás depois de migrar estado de JSON para tabela.

### 7.7 Esforço estimado

Estimativa da revisão 1 (9–12) era otimista: não contava congelamento, idempotência, cancelamento,
migrations/backup e sombra.

| parte | sessões |
|---|---|
| fila, claim, lease, heartbeat, drain + testes | 3–4 |
| gateway + tarefas `io`/`cpu` | 1–2 |
| texto | 1–2 |
| render | 2–3 |
| paridade operacional (help, dashboard, métricas, regressão) | 2 |
| motor de fluxos (estado, congelamento, export/import, sombra) | 3–5 |
| promoclub + navegador | 2–4 |
| cutover e estabilização | 1–2 |
| **total** | **15–24** |

Risco concentrado na fila e no motor de fluxos. Se a fila escorregar, escorrega tudo — por isso vem
primeiro, mesmo sem nada visível no Telegram.

## 8. Observabilidade e métricas

Depois de desligar o bot velho não há rede de segurança. Contam como "pronto":

- **Correlação obrigatória:** todo log de job carrega `job_id` e, havendo, `flow_ref`
  (`P#16/mulheres/render`). `grep P#16` reconstrói a execução inteira.
- **Falha sempre notifica no chat** com `job_id` + trecho do erro. Silêncio nunca é estado válido —
  é o modo de falha mais perigoso do v1.
- **Métricas** (no `/fila` e no dashboard, calculadas de `jobs`, que nunca é purgado): duração por
  tarefa, nº de retries, leases expirados, tamanho de cada fila, idade do job mais antigo, jobs
  presos (`running` com lease renovando há muito), taxa de erro em 24h, tempo médio por fase,
  processos Claude ativos.

```
fila render: 1 executando · 7 aguardando · mais antigo 42 min · erro 24h 8%
```

## 9. Segurança (requisito, não recomendação)

- **Allowlist de `chat_id`** — mensagem de origem não autorizada é descartada e logada
- **Catálogo fechado de tarefas** — `tarefa` só pode ser nome presente no registry; nunca string livre do usuário virando comando
- **`spawn`/`execFile` sem `shell: true`**, argumentos como array, sempre
- **`cwd` validado** contra a lista de repos de domínio registrados
- **Path traversal**: nomes de arquivo sanitizados na entrega (regra já existente no `deliver.ts` do v1) e no download de anexo
- **Limite de tamanho** de upload/download, com mensagem clara ao estourar
- **Segredos mascarados** em log e em mensagem de erro; `.env` modo 600, no `.gitignore`
- **Subprocessos sem privilégio extra**; nenhum job roda como root
- **Prompt de fluxo vem de arquivo do repo de domínio**, não de texto do usuário — o que o usuário
  fornece entra como variável, nunca como instrução crua

## 10. Nomes e implicações futuras

| coisa | nome | custo de renomear depois |
|---|---|---|
| username no Telegram | `@inemaccbot` (se livre) | ~zero — BotFather, token não muda; só quebra `t.me/<user>` antigo |
| pasta + repo | `inemaccbot` | baixo — GitHub redireciona git; **mas a URL do GitHub Pages não redireciona**, e o card no portal precisa ser atualizado à mão |
| serviço, DB, logs, env | `inemaccbot.service`, `QUEUE_DB`… | o mais caro depois — varredura + reinstalar unit + editar `.env` em produção |

Por isso o nome é decidido no dia 1, e **nenhuma variável de ambiente carrega nome de produto**.

## 11. Fora de escopo (YAGNI explícito, com gatilho)

| não fazer | gatilho para reconsiderar |
|---|---|
| preempção automática de job | urgência cujo custo de espera passe o de descartar um render |
| barreira entre fases | fluxo cujo passo N precise de todos os alvos do passo N−1 |
| Redis / Postgres / BullMQ | mais de uma máquina, ou WAL medindo contenção real |
| segundo processo + IPC | restart do gateway doer com frequência |
| tabela `locks` | exclusividade mais fina que "uma fila" (ex.: duas contas HeyGen) |
| tabela `fluxo_execucoes` separada | `jobs` deixar de bastar como histórico (ex.: purga por tamanho) |
| teto global de processos Claude | as concorrências por fila deixarem de bastar |
| multiusuário / multi-tenant | outra pessoa usando o bot |
| migração de fluxo em voo entre versões de definição | precisar mudar as regras de um `P#N` já rodando |

## 12. Especs de detalhe previstos (follow-ups)

Este documento é a arquitetura. Cada item ganha spec próprio se e quando for implementado:

1. `fila/` — schema final, migrations, contrato do dashboard e das métricas
2. `fluxos/` — validação de `flow.json`, semântica exata de `espera`/timeout, formato do export
3. `gateway/` — gramática de comandos e prompt do `interpret`
4. Catálogo de tarefas `kind=function` e o contrato de idempotência de cada uma
5. Migração do `promoclub` — `flow.json` + prompts + conferência em sombra contra o v1

## 13. Registro da revisão 2

Resposta ponto a ponto à `docs/analise_critica_inemaccbot_design.md`:

| ponto da crítica | decisão | onde |
|---|---|---|
| 1 · "1 repo" impreciso | aceito | §0 (1 plataforma + N domínio) |
| 2 · congelar definição do workflow | aceito | §3.4 |
| 3 · lease não garante execução única | **aceito — furo real** | §2.5, §6.2 |
| 4 · não soltar lease durante o drain | **aceito — correção de erro** | §1.3 |
| 5 · `kind=function` amplo demais; ffmpeg não é leve | aceito | §2.3 (`io` + `cpu`) |
| 6 · não é todo function que precisa de processo | aceito | §1.2 |
| 7 · schema perde histórico | **parcial**: requisito aceito, tabela recusada — `jobs` já é o histórico e nunca é purgado; view `fluxo_historico`. Tabela paralela seria segunda escrita do mesmo fato | §3.5, §11 |
| 8 · modelar fase global vs por alvo | **aceito — bug de modelagem**: `fluxo_alvos` não tinha lugar para fase de escopo `fluxo` | §3.3 (`fluxo_fases`, `alvo=''`) |
| 9 · cancelamento subespecificado | aceito | §3.7 |
| 10 · segurança como requisito | aceito | §9 |
| 11 · backup e migrations do SQLite | aceito | §7.3 |
| 12 · observabilidade além de log | aceito | §8 |
| "supervisor com processos filhos" | aceito | §0, §1 |
| export/import + validação em sombra | aceito | §7.5, §7.6 |
| estimativa 15–24 sessões | aceito | §7.7 |
| teto global de processos Claude | **recusado**: concorrência por fila já limita (render 1 + navegador 1 + texto 2 = 4 agentes); teto global seria segundo mecanismo para o mesmo invariante | §2.3, §11 |
