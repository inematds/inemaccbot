# Handoff — inemaccbot

Escrito em 2026-07-30, ao fim da sessão que criou o projeto e entregou as etapas 0 e 1.
**Atualizado em 2026-07-30 (mesmo dia), ao fim da etapa 2.**
Ponto de partida para quem (agente ou humano) continuar daqui. Leia isto antes de
reconstruir contexto por arqueologia de git.

## 1. O que é este projeto

Sucessor do `~/projetos/inemaccvbot`. **Monólito modular** — um processo, um repo, um banco:

```
Telegram → gateway/ → (skill direto | fluxo com estado) → fila/ → worker → função ou agente
                                                            dominio/ = regras puras
                                                            db/      = SQLite, migrations, backup
```

O problema que ele resolve: no v1, o bot executava `claude -p` inline, com mutex em memória,
sem retry, sem timeout, perdendo trabalho a cada restart. Aqui a fila é durável, o claim é
atômico, o lease tem posse, e o desligamento não perde trabalho.

**Arquitetura completa:** `docs/superpowers/specs/2026-07-30-inemaccbot-design.md` (revisão 2).
Leia pelo menos §1 (camadas), §2.5 e §2.5.1 (efeito único e posse do lease), §3 (fluxos), §7 (cutover).

## 2. Estado em 2026-07-30

- `master` em `2b4a525`+. **366 testes verdes**, typecheck limpo.
- **Etapas 0, 1, 2 e 3** mergeadas. Etapa 2 = fila `texto` com `kind=agent`, registry de
  skills, gateway completo (skill digitada, texto livre, pergunta, anexo, entrega).
  Plano: `docs/superpowers/plans/2026-07-30-etapa-2-texto.md`.
- O serviço **está no ar**: `systemctl --user status inemaccbot` (unidade de USUÁRIO, em
  `~/.config/systemd/user/`). Log em `~/projetos/inemaccbot/inemaccbot.log`.
- Serviços em 2026-07-30, ao fim da etapa 2:

  | serviço | active | enabled | |
  |---|---|---|---|
  | `inemaccbot` | sim | **sim** | o novo |
  | `inemaccvbot` | **não** | não | desligado a pedido do dono (ver abaixo) |
  | `mkivideos` | **não** | não | idem |
  | `mkitexto` | **não** | não | desligado no cutover da etapa 2 |

  **O v1 inteiro está parado desde 2026-07-30.** Isso NÃO foi o cutover das etapas 3–6:
  foi decisão explícita do dono, que declarou não usar mais nada de lá — inclusive o
  `/promoclub` ("pode até parar o promoclub, que não vou usar mais lá"). Ele confirmou
  depois de eu dizer, com todas as letras, que ficaria só com `transcrever`/`dublar` até as
  etapas 3 e 5 existirem.

  Nada foi perdido no desligamento: a fila do `mkivideos` só tinha job terminal (291 done,
  54 failed, 19 canceled), sem nada `queued` nem `running`, e não havia fluxo de promoclub
  em voo. Reverter é `systemctl --user start <serviço>` — nada foi apagado nem migrado.

### O que o bot novo faz hoje

- **Serviço:** `/ping` · `/ajuda` (`/help`) · `/skills` · `/fila` · `/status <id>` ·
  `/cancelar <id>` · `/furar <id>` · `http <url>` · `thumb <caminho>`.
- **Skills (registry `config/skills.json`):** `transcrever: <link>` e
  `dublar: <link> | lives3`, na fila `texto`, como `kind=agent`. Campos genéricos:
  `livesN` (destino), `modelo=`, `esforco=`.
- **Texto livre:** interpretado por um agente curto — vira job, ou vira pergunta
  respondida com os jobs DESTE chat + cauda do log (ambos redigidos).
- **Anexo:** documento/vídeo/áudio cai em `state/midia` e a legenda vira comando.
- **Entrega:** destino `livesN` copia o artefato; `.txt`/`.srt` curto vai como TEXTO no
  chat; o resto vai como anexo (≤45 MB) ou só o caminho.

### O que ele NÃO faz

Sem `render` (etapa 3), sem `fluxos/`, `/refazer`, `/status <fluxo>`, dashboard nem
`/promoclub`. O `interpret` conhece skills, não fluxos.

### Etapa 3 — render (2026-07-30)

As cinco skills de vídeo voltaram: `explicativo`, `curso`, `demo`, `reel`, `reelinematds`,
na fila `render` (concorrência 1). Plano em
`docs/superpowers/plans/2026-07-30-etapa-3-render.md`.

**A decisão que sustenta tudo:** render leva de 15 min a 2h, então o agente NÃO segura a
sessão até o fim. Ele monta o material, dispara só o render final destacado
(`nohup … || touch "<alvo>.err"`, gravando o `.pid`), declara `RENDER: <alvo>` e sai. Quem
espera é a fila — **segurando o slot**. Soltar a vaga entre um poll e outro deixaria um
segundo render ser reclamado, e os dois escreveriam na mesma GPU: é o mesmo invariante do
§7.1, dentro do bot.

Consequências que valem lembrar antes de mexer:

- **Adoção**: `.log` presente e `.err` ausente = trabalho EM CURSO → a tentativa seguinte
  adota em vez de disparar. `.err` presente = tentativa anterior encerrada → limpa e
  dispara de novo. Errar essa distinção anula o `max_tentativas` justamente no caso para o
  qual ele existe (achado na revisão, não em produção).
- **`/cancelar` mata o render destacado** (pelo `.pid`); desligamento e perda de lease
  deixam vivo DE PROPÓSITO — é disso que a adoção depende.
- **Recuperação de lease roda periodicamente**, não só no boot: com job de 2h, um `kill -9`
  seguido de restart dentro da janela do lease deixava o job preso para sempre.
- **`max_tentativas: 4`** nas skills de render: cada deploy durante um render gasta uma
  tentativa, e o requeue adota em vez de renderizar de novo.
- **Campos são declarados pela SKILL** (`vertical`, `curso`, `modulo`, `visuais`, `mover`),
  não conhecidos pelo parser — no v1 cada skill nova exigia editá-lo. Campo com
  `usa: "entrega"` (o `mover`) não vai ao prompt: o agente não move arquivo.
- **Teto de setup por skill** (`timeout_setup_segundos`): em reel o agente roda o pipeline
  criativo inteiro inline, então 20 min matariam todo job antes do disparo.

Da etapa 4 vieram, porque o v1 está desligado e faziam falta: duração no `/status` e na
conclusão, e `/refazer <id>`.

### Decisões da etapa 2 que mudam o desenho das próximas

- **Skill de agente roda SÍNCRONA.** O v1 disparava `nohup` e vigiava o arquivo porque a
  fila dele não tinha lease com heartbeat; aqui o agente vive até o fim e declara
  `RESULT: <caminho>`. **Preço:** restart ou deploy no meio de uma transcrição mata aquele
  job — mitigado com `max_tentativas: 2` no registry, que reexecuta do zero.
- **`resultado` do job é o CAMINHO**, nunca o stdout do agente. Sem `RESULT:` nem `ERRO:` o
  job FALHA: agente que não disse onde gravou é indistinguível de agente que não gravou.
- **Prompt é arquivo** (`prompts/*.md`), lido a cada job (editar não exige restart), com a
  entrada do usuário entrando saneada como variável — nunca como instrução (§9).
- **Registry validado no boot**: entrada inválida derruba o serviço, como checksum de
  migration divergente.

## 3. Como continuar

O plano de cutover está em §7 do spec. Resumo:

| etapa | entrega | desliga ao fim |
|---|---|---|
| ~~2~~ | ~~fila `texto`~~ | ~~`mkitexto`~~ — desligado |
| ~~3~~ | ~~fila `render`~~ | ~~`mkivideos`~~ — já estava desligado |
| 3 | fila `render`: `explicativo`, `curso`, `demo`, `reel`, `reelinematds` | `mkivideos.service` |
| 4 | paridade operacional (help gerado, dashboard, regressões do `watcher.test.ts` do v1) | — |
| 5 | `fluxos/` + fila `navegador` + `flow.json` no `inemaclubpromover` | `/promoclub` do v1 |
| 6 | — | `inemaccvbot.service`, revogar o token antigo |

**Regra de ouro do cutover (§7.1):** nunca duas filas da mesma classe vivas. Dois renders
simultâneos disputam a mesma GPU sem saber um do outro.

Antes de escrever a etapa 3, releia a seção 5 — os riscos que sobraram.

## 4. Convenções que não são negociáveis

Elas foram pagas com defeitos reais durante o desenvolvimento; afrouxar qualquer uma reabre um bug
que já custou uma rodada de correção.

- **Relógio injetável.** Nada chama `Date.now()` fora de um `agora: Agora`. Timers de
  agendamento (`setInterval`/`setTimeout` no `index.ts`) são reais por natureza, mas
  parametrizados.
- **Testes usam arquivo SQLite temporário, nunca `:memory:`.** Claim atômico e WAL não existem em
  memória; um teste em `:memory:` passa verde sobre uma fila quebrada.
- **Nenhum teste toca a API do Telegram nem a rede.**
- **`spawn`/`execFile` sempre sem `shell: true`**, argumentos em array.
- **ESM:** todo import relativo termina em `.js`.
- **Fronteiras entre camadas** verificadas por `src/arquitetura.test.ts`, com **exatamente uma**
  exceção (`dominio/` → `fila/types.js`, tipo e não implementação). Teste que cruza camadas vive em
  `src/integracao/`. Se você bater na regra, **mova o teste** — não alargue a lista.
- **Guarda nova exige prova por mutação:** quebre a guarda, veja o teste ficar vermelho, restaure.
  Metade dos defeitos desta sessão eram testes que passavam pelo motivo errado.

## 5. Riscos nomeados (estado depois da etapa 2)

**Fechados na etapa 2:** 1 (`promptDe`), 2 (teste de catálogo do sinal), 3 (redação de
`job.erro`), 4 (portão da fila `texto` = registry validado no boot), 5 (lista de filas em
`fila/filas.ts`). Sobra o 6 (`raizMidia` derivada). Registro do que eram, para quem for ler
os commits:

1. ~~**`promptDe` é um throw explícito**~~ (`src/index.ts`). Precisa ser substituído **no mesmo commit**
   que tornar `kind='agent'` alcançável, senão o primeiro job de agente queima uma tentativa e
   morre com mensagem sem sentido.
2. **`ContextoTarefa.sinal` é obrigatório.** Toda tarefa nova precisa repassá-lo a todo processo
   filho e a todo `fetch`, ou reintroduz o bug do processo órfão que a etapa 1 fechou. **Não há
   teste que pegue uma tarefa NOVA esquecendo** — vale um teste de catálogo que assere que toda
   entrada de `criarTarefas` aborta em até N ms.
3. **`job.erro` vai verbatim para o chat.** Inofensivo com `http.get`/`ffmpeg.thumb`; vira
   superfície de vazamento no instante em que for stderr de agente, com caminhos, prompts e
   possivelmente segredos. Decida a redação **antes** do primeiro `kind='agent'`.
4. **`texto` já sobe com concorrência 2 e zero tarefas.** No momento em que um job `texto` for
   enfileirado ele executa — não há flag entre "registry carregado" e "jobs rodam". A etapa 2
   precisa do próprio portão.
5. **`/fila` tem a própria lista de filas** (`comandos.ts`), separada de `CONCORRENCIAS`
   (`index.ts`). Duas fontes de verdade: acrescentar fila na etapa 2 vai omiti-la das métricas.
6. **`raizMidia` é derivada** (`join(stateDir, 'midia')`), não configurada. Artefatos de render
   podem querer outro volume; promover isso mexe na assinatura de `criarTarefas` de novo.

## 6. Decisões tomadas sem o dono (madrugada de 2026-07-30)

Ele autorizou decidir no lugar dele, pedindo o lado conservador e registro. Todas revisáveis:

- **Containment do `ffmpeg.thumb`** — aceitava caminho arbitrário do chat e escrevia
  `${entrada}.jpg` com `-y`: primitiva de sobrescrita. Virou raiz obrigatória com checagem ciente
  do separador (`startsWith` puro deixa `/data/midia-secreta` passar contra raiz `/data/midia`).
- **Revertida uma restrição minha de processo** — eu proibira tocar no store, e isso empurrou um
  handle cru do SQLite para o gateway, capaz de contornar as guardas de posse. Virou
  `FilaSqlite.priorizar()`. *Lição: "não toque no arquivo de outra task" é conveniência de
  processo, não regra de arquitetura.*
- **`AbortSignal` no `ContextoTarefa`** — tarefa `function` nunca produzia `Execucao`, então
  `abortar()` era no-op e o `ffmpeg` ficava órfão queimando CPU após o shutdown.
- **Notificação nas duas transições terminais fora do `passo()`** (recuperação no boot e abort no
  desligamento), que eram silenciosas — violação direta do §8.

Detalhe de cada uma, com justificativa, em
`.superpowers/sdd/2026-07-30-etapa-1-gateway-io-cpu/progress.md` (o ledger; git-ignored, só em disco).

## 7. Pendências conhecidas, não bloqueantes

- ~~`thumb` inalcançável~~ — resolvido: anexo do Telegram grava em `state/midia`.
- **Um teste é flaky sob carga:** `ffmpeg.test.ts > aborta o processo filho…` espera um
  arquivo de PID em até 5s e falhou uma vez na suíte cheia (passou nas 3 execuções
  seguintes). Se voltar, o conserto é a janela, não o código.
- **`jobsDoChat` varre `listar()` inteiro** para montar o contexto de uma pergunta — mesma
  família do problema já anotado nas métricas do `/fila`: degrada com o histórico.
- **Teto de anexo é 20 MB** (limite da API do Telegram para bots). Arquivo maior: manda o
  caminho no disco.
- `Transporte.responder` não checa a allowlist — um `chat_id` removido do `.env` ainda recebe a
  notificação do job que ele já tinha enfileirado.
- O teste de arquitetura casa só `from '…'`: um `await import()` dinâmico atravessaria a fronteira.
  Mesma família da lacuna já anotada (ele checa imports, não SQL cru na camada errada).
- Métricas de `/fila` varrem `listar()`; `jobs` nunca é purgado, então degrada com o histórico.
- `main()` lê o `.env` dentro do `index.ts` (`lerEnv`), não em `config.ts`.

## 8. Como o trabalho foi conduzido (e por que manter)

Cada etapa: brainstorming → spec → plano → execução task a task com subagente → revisão por task →
revisão final da branch → leva única de correção → merge. Os planos ficam em
`docs/superpowers/plans/`; o ledger de cada execução em `.superpowers/sdd/<plano>/progress.md`.

O que esse processo pegou e uma leitura atenta não pegaria: uma exceção de fronteira que era código
morto (achada pela revisão de *documentação*, não pelas três de código), `max_tentativas` nunca
consultado no caminho de crash, `renovar()` devolvendo um booleano que ninguém lia, e vários testes
que passavam pelo motivo errado.

**Não confie em relatório de subagente sem verificar.** Três vezes nesta sessão um relatório
descreveu o mecanismo errado de uma falha que ele mesmo tinha observado.

## 9. Validação da etapa 2 e o que falta do cutover

A aceitação do §7.4 dizia "mesma entrada nos dois bots → saída equivalente". **Ela caiu**:
o dono declarou em 2026-07-30 que não usa mais o sistema antigo, então não há com o que
comparar. A validação virou "o novo funciona de ponta a ponta", e foi feita:

- **dois jobs `transcrever` REAIS** rodaram no serviço no ar (não em teste): `claude -p`
  de verdade, `transcrever_v1.py` com Whisper large-v3, artefato gravado no caminho exato
  que o prompt mandou, `RESULT:` cumprido, job `done` com o caminho em ~70s;
- o segundo passou pelo caminho de comando completo com override (`| modelo=haiku`) e
  provou o §1.5 ponta a ponta: `[job 2] motor=claude modelo=haiku esforco=low` no log e
  `perfil: claude/haiku/low` no `/status`;
- a falha de notificação daquele job (`chat not found`, porque o chat era falso no teste)
  provou de lambuja que perder a notificação não derruba o worker.

O primeiro job real é que revelou o defeito do perfil não gravado — corrigido em `2b4a525`+.

### Cutover: FEITO em 2026-07-30

1. `systemctl --user disable --now mkitexto` — parado e desabilitado;
2. `transcrever`/`dublar` saíram do `config/skills.json` do v1 (commit `5e8d1cc` no
   `inemaccvbot`, empurrado), com o teste do registro passando a guardar que não sobrou
   skill de fila `texto`. O v1 foi rebuildado e reiniciado para carregar o registro novo —
   sem isso ele continuaria oferecendo as duas no `/help` e aceitando pedido para uma fila
   morta.

Os três arquivos não commitados do v1 (`src/config.ts`, `src/interpret.ts`,
`src/promoclub.ts`) e os dois docs novos **continuam fora do commit**, como previsto.

**Transcrever e dublar agora só existem no bot novo.**

### Próximo: etapa 3 (`render`)

`explicativo`, `curso`, `demo`, `reel`, `reelinematds`.

**O que mudou com o v1 parado:** a regra de ouro do §7.1 (nunca duas filas da mesma classe
vivas, porque dois renders disputam a mesma GPU sem saber um do outro) deixou de ser um
risco de cutover — não há mais fila velha para competir. Em compensação, some a rede de
segurança: **enquanto a etapa 3 não existir, não há como renderizar nada**. Isso torna a
etapa 3 a prioridade, e o `mkivideos` o rollback (`systemctl --user start mkivideos`) caso
alguma coisa precise sair no meio do caminho.

Uma decisão da etapa 2 precisa ser reexaminada antes: a execução SÍNCRONA. Para transcrição
(minutos) o preço de perder o job num restart é aceitável. Para um render de 15 min a 2h,
não é óbvio — ou o `timeout_segundos` do registry sobe bastante e o deploy passa a esperar,
ou volta alguma forma de trabalho destacado com poll. Decida isso no início da etapa 3, não
no meio.
