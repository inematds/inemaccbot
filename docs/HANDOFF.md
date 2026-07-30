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

- `master` em `95ccd79`. **318 testes verdes**, typecheck limpo.
- **Etapas 0, 1 e 2** mergeadas. Etapa 2 = fila `texto` com `kind=agent`, registry de
  skills, gateway completo (skill digitada, texto livre, pergunta, anexo, entrega).
  Plano: `docs/superpowers/plans/2026-07-30-etapa-2-texto.md`.
- O serviço **está no ar**: `systemctl --user status inemaccbot` (unidade de USUÁRIO, em
  `~/.config/systemd/user/`). Log em `~/projetos/inemaccbot/inemaccbot.log`.
- Os três serviços do v1 (`inemaccvbot`, `mkivideos`, `mkitexto`) estão **`active` mas `disabled`**:
  seguem de pé até o próximo reboot, e não voltam sozinhos. Foi decisão explícita do dono
  (2026-07-30) — ele ainda depende deles, porque o novo não cobre as skills nem o promoclub.

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
| ~~2~~ | ~~fila `texto`~~ — **feito**, mas o cutover ainda não | `mkitexto.service` (**pendente**, ver §9) |
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

## 9. O que ficou FALTANDO da etapa 2 (leia antes de tocar no cutover)

O código da etapa 2 está pronto, verde e no ar. O que **não** foi feito é a aceitação do
§7.4, que é manual por natureza: **mesma entrada nos dois bots → saída equivalente**. Ela
custa GPU e token e depende de um link real.

Sequência que falta, nesta ordem:

1. rodar `transcrever: <link real>` no bot NOVO e o equivalente no velho, comparar;
2. só então, com o dono confirmando: `systemctl --user disable --now mkitexto`;
3. e tirar `transcrever`/`dublar` do `config/skills.json` do **v1** (uma linha de config,
   reversível) — senão o bot velho segue aceitando pedidos que ninguém mais executa.

Enquanto o passo 2 não acontece, **as duas filas de texto estão vivas ao mesmo tempo**.
Para `texto` isso não briga por GPU como o render brigaria, mas os dois bots respondem —
mande o pedido para um de cada vez, de propósito, ao comparar.

Atenção ao commit do passo 3: o repo do v1 tem alterações não commitadas em `src/config.ts`,
`src/interpret.ts` e `src/promoclub.ts`. Não varra isso para dentro do commit de cutover.
