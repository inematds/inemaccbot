# inemaccbot — design (spec)

Data: 2026-07-30 · Aprovado seção a seção pelo usuário nesta data.

Sistema novo, repo novo. **Nada é alterado no `inemaccvbot`**, que segue em produção até o
cutover e depois é desligado. Este documento é a arquitetura fina; cada subsistema pode ganhar
seu próprio spec de detalhe depois.

## Sumário da decisão

| item | decisão |
|---|---|
| forma | **monólito modular** com motor de workflow e fila durável — 1 repo, 1 processo, 1 DB |
| nome | pasta/repo/serviço `inemaccbot` (sem o `v` de vídeo — o escopo deixou de ser só vídeo) |
| fila | **interna ao processo** — não há serviço separado, logo o nome `mkiservico` não é usado em lugar nenhum (o conceito de "serviço de fila" foi absorvido); nomes de env sem produto (`QUEUE_DB`, `BOT_TOKEN`) |
| Telegram | token novo (bot novo); token antigo revogado na etapa 6 |
| motor de fila | **portado do `mkivideos`** (já escrito host-agnóstico), corrigido para claim atômico + lease |
| tipos de job | `kind = agent` (sobe `claude -p`) · `kind = function` (código determinístico) |
| prioridade | **não-preemptiva** — `/furar` põe na frente, nunca mata job em execução |
| fluxo | opcional por comando: skill vai direto pra fila; fluxo tem estado e fases |
| infra | SQLite em WAL. **Sem** Redis/Postgres (nenhum instalado; máquina única, usuário único) |

## 1. Camadas

```
Telegram
   │
┌──┴──────────────────────────────────────────────┐
│ inemaccbot (1 processo, 1 repo, 1 DB)           │
│   gateway/   recebe, interpreta, notifica       │
│   fluxos/    estado + decide a próxima fase     │
│   fila/      claim atômico + workers por fila   │
│   dominio/   registries (skills/fluxos/destinos)│
└─────────────────────────────────────────────────┘
   ├─ kind=function → spawn/thread (API, download, ffmpeg)
   └─ kind=agent    → claude -p / claude --chrome -p → skill
```

Regra que sustenta o desenho: **quem orquestra não trabalha, quem trabalha não decide.** O worker
executa um job e marca `done`/`failed`; quem lê isso e escolhe a próxima fase é o `fluxos/`.

### 1.1 Roteamento tem DUAS portas (nunca fluxo obrigatório)

```
gateway → é comando de fluxo (config/fluxos.json) ou de skill (config/skills.json)?
            ├─ skill → 1 job na fila                      (sem estado, sem fase, sem /status)
            └─ fluxo → cria estado → 1 job por fase/alvo   (com retomada e /status)
```

Um `explicativo` não paga arquivo de estado, ID de execução nem subcomandos. **O critério de qual
porta usar:** vale a pena lembrar onde parou? Se falhar e "rodar de novo do zero" é aceitável, é
skill. Se há trabalho parcial que seria absurdo jogar fora, é fluxo.

### 1.2 O bot hospeda workers — de propósito

No v1 o bot executava `claude -p` inline (`runFase1`/`runFase2`), com mutex em memória, sem retry,
sem timeout. No v2 ele continua hospedando execução, mas com **disciplina de worker**:
`claim → lease → spawn (fora do event loop) → ack`, com retry, backoff e drain. A diferença não é
fronteira de processo, é disciplina.

Dois riscos assumidos, com mitigação obrigatória:

1. **Bloqueio do event loop** — `kind=function` **nunca** roda inline; sempre `spawn`/`worker_threads`.
   O handler do Telegram só faz `await`.
2. **Restart mata trabalho em voo** — `SIGTERM` → *drain* (para de dar claim, solta leases) e
   `lease_ate` devolve à fila o que não terminou. Restart custa reprocessar um job, não perder um fluxo.

**Escape hatch documentado:** como `fluxos/` só fala com `fila/` por interface, mover os workers
para um segundo processo depois é trocar chamada de função por IPC — sem tocar fluxo, skill ou
domínio. Decisão adiada, não impossibilitada. Gatilho para reconsiderar: restart do gateway
começar a doer com frequência, ou necessidade de segunda máquina.

## 2. Fila

### 2.1 Tabela `jobs`

```sql
id             INTEGER PRIMARY KEY
fila           TEXT     -- render | navegador | leve | texto
kind           TEXT     -- agent | function
tarefa         TEXT     -- nome da skill (agent) ou da função (function)
input          TEXT     -- JSON de argumentos
prioridade     INTEGER  -- default 0; /furar sobe
status         TEXT     -- queued | running | done | failed | canceled
tentativas     INTEGER
max_tentativas INTEGER
lease_ate      INTEGER  -- timestamp; vencido → volta para queued
disponivel_em  INTEGER  -- claim só pega quando <= now (poll, backoff, agendamento)
flow_ref       TEXT     -- "P#16/mulheres/render" ou NULL (job solto)
chat_id        INTEGER  -- para quem responder (NULL em fase de fluxo)
resultado      TEXT
erro           TEXT
criado_em / iniciado_em / terminado_em INTEGER
```

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

| fila | concorrência | kind típico | para quê |
|---|---|---|---|
| `render` | 1 | agent | vídeo/reel — GPU e token |
| `navegador` | 1 | agent | `claude --chrome -p`, Chromium `:99` exclusivo |
| `texto` | 2 | agent | transcrever, dublar |
| `leve` | 10 | function | API, download, ffmpeg, poll de status |

Exclusividade é **propriedade da fila** (`navegador` com concorrência 1), não variável em memória.
Não existe tabela `locks` — só entra se aparecer exclusividade mais fina (ex.: duas contas HeyGen).

### 2.4 Prioridade

Não-preemptiva. `/furar <job>` põe na frente da fila; `/cancelar <job>` mata explicitamente o que
está rodando, por decisão humana. Preempção automática num render de 15 min sem checkpoint queima
token e é a parte mais propensa a bug do sistema — fora de escopo.

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

`escopo` vem do caso real: o promoclub gera os 12 textos em **um** job (`fluxo`) e renderiza **um
job por público** (`alvo`).

### 3.2 `flow.json` — vive no repo de domínio

```jsonc
{
  "nome": "promoclub", "prefixo": "P",
  "alvos": {
    "mulheres":     { "canal": "lives21", "gatilho": "..." },
    "pais-lives32": { "canal": "lives32", "gatilho": "..." }
  },
  "fases": [
    { "id": "texto",  "escopo": "fluxo", "fila": "texto",     "kind": "agent",
      "tarefa": "fluxo-agente",    "prompt": "prompts/fase1.md" },
    { "id": "render", "escopo": "alvo",  "fila": "navegador", "kind": "agent",
      "tarefa": "fluxo-navegador", "prompt": "prompts/fase2.md", "max_tentativas": 2 },
    { "id": "baixar", "escopo": "alvo",  "fila": "leve",      "kind": "function",
      "tarefa": "heygen.baixar",   "espera": { "intervalo": 120, "timeout": 5400 } },
    { "id": "reel",   "escopo": "alvo",  "fila": "render",    "kind": "agent",
      "tarefa": "reel", "entrega": "{canal}" }
  ]
}
```

A última fase usa a **skill `reel` do catálogo**, a mesma que o usuário dispara no chat: fluxo é
cliente da fila como qualquer um.

`espera: { intervalo, timeout }` (segundos) descreve fase de *poll*: se a tarefa `function` ainda não
encontrou o que aguarda, ela reagenda a si mesma com `disponivel_em = now + intervalo`, até
`timeout` contado do primeiro enfileiramento da fase — então o alvo vai para `falhou`. Sem isso o
poll viraria busy-loop. Semântica exata detalhada no spec de `fluxos/` (§10.2).

**Domínio diz para quem, o bot sabe onde:** o `flow.json` referencia canal por nome (`lives21`),
nunca por ID. O mapa de destinos é registry único no `inemaccbot` (`dominio/`), evitando N cópias
divergentes da lista de canais nos repos de domínio.

### 3.3 Estado em tabelas, no MESMO DB da fila

```sql
fluxos       id, tipo, slug, assunto, versao, chat_id, status, criado_em
fluxo_alvos  fluxo_id, alvo, fase, estado, tentativas, dados(JSON), job_id, erro
             -- estado: pendente | rodando | feito | falhou | pulado
             -- PK (fluxo_id, alvo)
```

Sai o `state/<slug>.json` do v1. Estar no mesmo DB é o que torna **"marcar fase concluída +
enfileirar a próxima" uma única transação** — elimina por construção o dispatch duplicado que o v1
tem. `dados` é o único campo livre (título HeyGen, caminho de arquivo), para não engessar schema por
fluxo. Artefatos continuam no repo de domínio (`output/`); o DB guarda progresso, não conteúdo.

### 3.4 Avanço dirigido por evento — não existe watcher

```
worker termina job → (mesma transação)
                      ├─ jobs:        status = done
                      ├─ fluxo_alvos: fase → feito, dados ← resultado
                      └─ próxima fase daquele alvo → INSERT em jobs
                     commit
```

Cada alvo caminha independente: o público 3 pode estar no reel enquanto o 9 espera render. Sem
barreira entre fases (nenhum fluxo atual precisa; se precisar, entra `"barreira": true` na fase).

### 3.5 Falha, retry, restart

1. Job falha e `tentativas < max_tentativas` → volta a `queued` com backoff via `disponivel_em`
2. Esgotou → `fluxo_alvos.estado = falhou`, grava `erro`, **notifica no chat**, e os outros alvos seguem
3. `/refazer P#16` → só o que está `falhou` volta a `pendente`, tentativas zeradas
4. `/refazer P#16 <alvo>` → um alvo só

Um fluxo nunca morre por inteiro por causa de um alvo.

No boot, nessa ordem: (a) `jobs` com `lease_ate` vencido → `queued`; (b) `running` sem worker vivo →
idem; (c) `fluxo_alvos` em `pendente` sem job correspondente → enfileira (rede de segurança). Não
existe código especial de "retomada de fase 2": é consequência do lease.

### 3.6 Interface de `fluxos/`

```
criar(tipo, assunto, opts) → fluxoId
avancar(jobId, resultado)  → jobs enfileirados      // chamado pelo worker
status(ref)                → visão
refazer(ref, alvo?)
```

Testável com fila fake e um `flow.json` de brinquedo — sem Telegram, sem Claude, sem HeyGen.

### 3.7 Comandos

| comando | efeito |
|---|---|
| `/skills` · `/fluxos` | listam os registries |
| `/<fluxo> <assunto> [\| alvos=a,b] [\| versao=N]` | cria e dispara |
| `/status [P#16]` | tabela alvo × fase × estado |
| `/status log` (alias `/statuslog`) | histórico — alias mantido pela memória muscular do v1 |
| `/refazer P#16 [alvo]` | retenta o que falhou |
| `/cancelar P#16 [alvo]` \| `/cancelar <job>` | cancela |
| `/furar <job>` | prioridade máxima |
| `/fila` | por fila: rodando, pendentes, lease vencendo |

`/status` é genérico e serve **todos** os fluxos — sem código por fluxo. Esse é o teste do desenho:
**fluxo novo = 1 entrada em `config/fluxos.json` + 1 repo de domínio, zero linha de código.**

### 3.8 Quando criar um fluxo (e um repo de domínio)

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
│   ├── fila/       types, store, claim, worker, dashboard, tarefas/
│   ├── fluxos/     runtime, estado, status
│   ├── dominio/    registries + destinos
│   └── index.ts    boot, drain
├── config/         skills.json, fluxos.json, destinos.json
├── deploy/         inemaccbot.service
└── docs/
```

Fronteira: `fila/` não importa de `gateway/` nem de `fluxos/`; `fluxos/` não importa de `gateway/`;
`gateway/` importa só a *interface* da fila, nunca o store concreto; `dominio/` não importa nenhum
dos três. **Verificado por teste** (§6), não por revisão humana.

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

Cuidado de cutover no `jobref`: nas etapas 1–5 os dois bots estão vivos e o usuário pode colar no
bot novo um id vindo do velho. Um id que não exista no DB novo é **rejeitado com mensagem clara**
("job #N não é deste bot — veja `/fila`"), nunca resolvido silenciosamente contra o DB próprio, que
agiria no job errado. Ids com prefixo `V#`/`T#` também são rejeitados com a mesma mensagem.
| `help.ts` | 57 | reescreve | gerado dos registries |
| `config.ts` | 66 | reescreve | env sem nome de produto |
| `bot.ts` | 724 | reescreve fino | vira `gateway/` de roteamento |
| `promoclub.ts` | 822 | divide | ~350L → `fluxos/` genérico · domínio → `flow.json` |
| `state.ts` | 92 | descarta | substituído por `jobs.chat_id` + tabelas de fluxo |
| `queue-client.ts` | 118 | descarta | `execFile` + regex em stdout → chamada tipada |
| `watcher.ts` | 196 | descarta | avanço passa a ser transacional |

Porta direto ou quase: ~800L (27%). Reescreve/dilui: ~1.700L. Descarta: ~400L.

### 5.2 De `mkivideos` (2.480L) → `fila/`

O `types.ts` do `mkivideos` abre com *"Contratos do motor de fila — host-agnósticos (ports &
adapters). Um host … implementa QueueStore + QueueDeps"*: o motor **já foi escrito para ser
portado**. O `inemaccbot` entra como novo host.

| módulo | destino |
|---|---|
| `types.ts` (152) | porta + estende: `skill` deixa de ser union hardcoded e vira string do registry; entram `fila`, `kind`, `prioridade`, `lease_ate`, `disponivel_em`, `flow_ref` |
| `queue.ts` (636) | porta: parse/prompt/worker, já host-agnóstico |
| `sqlite-store.ts` (165) | porta + **corrige**: hoje é `SELECT … LIMIT 1` seguido de `UPDATE` (não atômico) e no boot marca todo `running` como `failed: "interrompido por reinício"`. Vira claim atômico + lease — o job volta à fila em vez de morrer |
| `dashboard.ts` (188) | porta: ganha coluna de fila e prioridade |
| `cli-lib.ts` (213) | porta parcial: o runner `claude --model … -p` é o `kind=agent`; o resto é opcional |

Achado registrado: o `mkivideos` já tem `kind: 'plan'` — job cujo trabalho é enfileirar outros jobs
(URL de curso → 1 job por módulo). É um proto-fluxo sem estado nem retomada; o `fluxos/`
generaliza. `plan` pode virar fluxo de 2 fases ou permanecer como está.

### 5.3 Código realmente novo (~700–900L)

1. `fluxos/` runtime — 4 funções, 2 tabelas, avanço transacional (~350L, boa parte adaptada do `promoclub.ts`)
2. Loader e validação dos registries (`skills.json`, `fluxos.json`, `flow.json`) (~120L)
3. Tarefas `kind=function` — `heygen.baixar`, `http.get`, `ffmpeg.*` (~150L, cresce por demanda)
4. Runners `fluxo-agente` / `fluxo-navegador` — prompt de arquivo + cwd + vars (~100L)
5. Boot: recuperação de lease + `SIGTERM` drain (~80L)

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

- **SQLite em arquivo temporário, não `:memory:`** — claim atômico, WAL, `busy_timeout` e
  concorrência > 1 não existem em memória. Um DB por teste, em `tmp`, apagado no fim.
- **Concorrência de verdade**: N workers, 1 job → executou exatamente 1 vez. Variante hostil:
  `kill -9` no meio → lease vence → job volta → **não duplica** (idempotência pela chave da fase).

### 6.3 Camadas

1. **Unidade pura** — `parser`, `jobref`, `reply`, `dests`, `log`, validação de registry
2. **Fila (DB real)** — claim, prioridade, lease/expiração, retry com backoff, `disponivel_em`, drain, limite por fila
3. **Fluxos (fila real + runners fake)** — `flow.json` de brinquedo (3 fases, 2 alvos, uma com `escopo: fluxo`): avanço independente por alvo, falha isolada, `/refazer` seletivo, retomada após kill, e atomicidade (crash entre "marcar fase" e "enfileirar" não deixa alvo órfão)
4. **Gateway (fila fake)** — roteamento nas 2 portas, texto livre via `interpret`, corte de 4096, anexo, entrega
5. **Aceitação manual** — os 6 testes reais da §7.4 (custam GPU e token; não automatizados)

### 6.4 Teste de arquitetura

Um teste varre os `import` de cada pacote e falha se qualquer regra da §4 for violada. É o que
impede o monólito modular de virar monólito — verificável em CI, não em revisão humana.

### 6.5 Testes herdados

**Nenhum teste do v1 é descartado sem equivalente no v2 ou justificativa escrita.** Em especial:

- `watcher.test.ts` — 443L para um arquivo de 196L, com comentários citando "finding 4": são bugs de
  produção fossilizados. O `watcher.ts` morre; os casos viram regressão do avanço transacional. Caso
  sem equivalente = buraco no v2.
- `promoclub.test.ts` (413L) — o que testa fase/estado/retomada vira teste do `fluxos/` genérico; o
  que testa públicos/canais vira fixture de domínio.

### 6.6 Observabilidade é requisito

Depois de desligar o bot velho não há rede de segurança:

- **Correlação obrigatória:** todo log de job carrega `job_id` e, havendo, `flow_ref`
  (`P#16/mulheres/render`). `grep P#16` reconstrói a execução inteira.
- **`/fila`** por fila: rodando, pendentes, prioridade, lease vencendo.
- **Falha sempre notifica no chat** com `job_id` + trecho do erro. Silêncio nunca é estado válido —
  é o modo de falha mais perigoso do v1.

## 7. Cutover

### 7.1 Desligar por fila, não tudo de uma vez

Se `mkivideos.service` e o `inemaccbot` estiverem ambos com fila de render viva, **dois renders
competem pela mesma GPU sem saber um do outro**. Logo: quando a fila nova de uma classe passa a
validação, o serviço velho equivalente desliga na hora. Nunca duas filas da mesma classe vivas.

| etapa | fila nova validada | desliga na hora |
|---|---|---|
| 1 | `leve` | — (não existe hoje) |
| 2 | `texto` | `mkitexto.service` |
| 3 | `render` | `mkivideos.service` |
| 5 | `navegador` | `/promoclub` do bot velho |
| 6 | — | `inemaccvbot.service` |

### 7.2 Etapas

- **0 · esqueleto** — repo, `.env` 600 fora do git, SQLite WAL, unit systemd. Porta o motor do
  `mkivideos` com as colunas novas e o claim atômico. Nenhum comando de Telegram ainda. Fecha com
  a suíte de fila verde, incluindo dois workers disputando o mesmo job.
- **1 · `leve` + gateway mínimo** — `/ping`, `/status`, `/fila` e uma tarefa `function`
  (`http.get`). Valida claim, lease, drain e prioridade com jobs de milissegundos: barato de errar.
- **2 · `texto`** — `transcrever`, `dublar`. Porta `interpret`, `parser`, `reply`, `media`,
  `deliver`, `answer`. Compara saída com o velho → desliga `mkitexto.service`.
- **3 · `render`** — `explicativo`, `curso`, `demo`, `reel`, `reelinematds`. Um teste real por
  skill → desliga `mkivideos.service`. As 7 skills passam a viver no novo.
- **4 · paridade operacional** — `help` gerado, `/furar`, `/cancelar`, `/refazer`, dashboard, e os
  casos do `watcher.test.ts` como regressão. Sem isso, desligar o velho deixa o sistema cego.
- **5 · fluxos** — `fluxos/` + fila `navegador` + `flow.json`/`prompts/` no `inemaclubpromover`.
  **Pré-condição:** nenhum `P#N` em voo no velho (esperar os que rodam terminarem; não abrir novos lá).
- **6 · desligar** — `systemctl disable --now inemaccvbot`, repo v1 em modo arquivo com README
  apontando para o novo, token antigo revogado no BotFather.

### 7.3 Deploy

- Um `.env` modo 600: `BOT_TOKEN`, `QUEUE_DB`, `STATE_DIR`, … **sem nome de produto nas variáveis**
  (trocar o nome do serviço amanhã não deve mexer em config).
- SQLite em **WAL** + `busy_timeout` — obrigatório para concorrência > 1 na fila `leve`.
- **Backup do DB antes de cada deploy da etapa ≥ 2** — o DB passa a carregar estado de fluxo, não só
  fila; perder é perder progresso.
- Unit: `KillSignal=SIGTERM`, `TimeoutStopSec=120`, para o drain caber.
- `git push` via **SSH** se o commit tocar `.github/workflows/*` (o token `gh` da conta `inematds`
  não tem escopo `workflow`).
- Etapas 1–5: dois bots no ar, **tokens e DBs diferentes**, apontando para os **mesmos repos de
  domínio** — daí a pré-condição da etapa 5.

### 7.4 Aceitação por etapa (o que "validado" significa)

| etapa | prova |
|---|---|
| 0 | 2 workers, 1 job → só um pega. `kill -9` no meio → job volta pela lease |
| 1 | 20 jobs leves em paralelo; `/furar` faz o último sair primeiro |
| 2 | mesma entrada nos dois bots → saída equivalente |
| 3 | 1 render por skill, entrega no destino certo |
| 4 | cada caso do `watcher.test.ts` com equivalente verde |
| 5 | `P#N` de 2 públicos ponta a ponta; kill do processo no meio da fase 2 → retoma sem duplicar |

### 7.5 Definition of done, por etapa

1. Suíte verde (`vitest`), zero teste skipado sem comentário do porquê
2. Teste de arquitetura (§6.4) verde
3. Teste de aceitação da etapa executado **de verdade**, resultado colado no relatório da etapa
4. Nenhum `TODO`/`FIXME` novo sem issue
5. Serviço velho correspondente desligado (etapas 2, 3, 5)
6. Commit + push no `origin`, autor `inematds <inematds@gmail.com>`

### 7.6 Rollback

Etapas 1–4: `systemctl start` do serviço velho correspondente + desabilita o comando no novo —
barato, porque as filas são independentes. A etapa 5 é a única sem volta prática (estado de fluxo
migra de JSON para tabela): por isso é a penúltima e só depois da paridade da etapa 4.

### 7.7 Esforço estimado

| etapa | sessões |
|---|---|
| 0 · fila portada + claim/lease | 2 |
| 1 · leve + gateway mínimo | 1 |
| 2 · texto | 1 |
| 3 · render | 1–2 |
| 4 · paridade operacional | 1–2 |
| 5 · fluxos + promoclub | 2–3 |
| 6 · desligar | 0,5 |

**Total 9–12 sessões.** Risco concentrado nas etapas 0 e 5. Se a 0 escorregar, escorrega tudo — por
isso ela vem primeiro, mesmo sem nada visível no Telegram.

## 8. Nomes e implicações futuras

| coisa | nome | custo de renomear depois |
|---|---|---|
| username no Telegram | `@inemaccbot` (se livre) | ~zero — BotFather, token não muda; só quebra `t.me/<user>` antigo |
| pasta + repo | `inemaccbot` | baixo — GitHub redireciona git; **mas a URL do GitHub Pages não redireciona**, e o card no portal precisa ser atualizado à mão |
| serviço, DB, logs, env | `inemaccbot.service`, `QUEUE_DB`… | o mais caro depois — varredura + reinstalar unit + editar `.env` em produção |

Por isso o nome é decidido no dia 1, e por isso **nenhuma variável de ambiente carrega nome de
produto**.

## 9. Fora de escopo (YAGNI explícito, com gatilho)

| não fazer | gatilho para reconsiderar |
|---|---|
| preempção automática de job | aparecer trabalho urgente com custo de espera maior que o de descartar um render |
| barreira entre fases | um fluxo cujo passo N precise de todos os alvos do passo N−1 |
| Redis / Postgres / BullMQ | mais de uma máquina, ou SQLite WAL medindo contenção real |
| segundo processo + IPC | restart do gateway doer com frequência |
| tabela `locks` | exclusividade mais fina que "uma fila" (ex.: duas contas HeyGen) |
| multiusuário / multi-tenant | outra pessoa usando o bot |
| versionamento de código de fluxo | execução em voo sobreviver a mudança de fases incompatível |

## 10. Especs de detalhe previstos (follow-ups)

Este documento é a arquitetura. Cada item abaixo ganha spec próprio se e quando for implementado:

1. `fila/` — schema final, migrações, contrato do dashboard
2. `fluxos/` — validação de `flow.json`, semântica exata de `espera`/timeout
3. `gateway/` — gramática de comandos e prompt do `interpret`
4. Catálogo de tarefas `kind=function`
5. Migração do `promoclub` — `flow.json` + prompts + conferência com o v1
