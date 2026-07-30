# Handoff — inemaccbot

Escrito em 2026-07-30, ao fim da sessão que criou o projeto e entregou as etapas 0 e 1.
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

- `master` em `975558e`. **202 testes verdes**, typecheck limpo.
- **Etapa 0** (núcleo da fila) e **etapa 1** (gateway + serviço) mergeadas.
- O serviço **está no ar**: `systemctl --user status inemaccbot` (unidade de USUÁRIO, em
  `~/.config/systemd/user/`). Log em `~/projetos/inemaccbot/inemaccbot.log`.
- Os três serviços do v1 (`inemaccvbot`, `mkivideos`, `mkitexto`) estão **`active` mas `disabled`**:
  seguem de pé até o próximo reboot, e não voltam sozinhos. Foi decisão explícita do dono
  (2026-07-30) — ele ainda depende deles, porque o novo não cobre as skills nem o promoclub.

### O que o bot novo faz hoje

`/ping` · `/ajuda` (alias `/help`) · `/fila` · `/status <id>` · `/cancelar <id>` · `/furar <id>` ·
`http <url>` · `thumb <caminho>`. Verbo aceita maiúsculas; argumento não é normalizado (caminho e
URL diferenciam caixa).

### O que ele NÃO faz

Nenhum job `kind='agent'`. Sem skills, sem registries em JSON, sem runtime de fluxos, sem
`/promoclub`, sem `interpret` por `claude -p`. Isso é etapa 2 em diante.

## 3. Como continuar

O plano de cutover está em §7 do spec. Resumo:

| etapa | entrega | desliga ao fim |
|---|---|---|
| 2 | fila `texto`: `transcrever`, `dublar`; registries; `kind=agent` | `mkitexto.service` |
| 3 | fila `render`: `explicativo`, `curso`, `demo`, `reel`, `reelinematds` | `mkivideos.service` |
| 4 | paridade operacional (help gerado, dashboard, regressões do `watcher.test.ts` do v1) | — |
| 5 | `fluxos/` + fila `navegador` + `flow.json` no `inemaclubpromover` | `/promoclub` do v1 |
| 6 | — | `inemaccvbot.service`, revogar o token antigo |

**Regra de ouro do cutover (§7.1):** nunca duas filas da mesma classe vivas. Dois renders
simultâneos disputam a mesma GPU sem saber um do outro.

Antes de escrever a etapa 2, releia a seção 5 deste documento — há três riscos nomeados que
mudam o desenho dela.

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

## 5. Riscos nomeados para a etapa 2

Vieram das revisões finais das etapas 0 e 1. Não são opinião — cada um tem cenário concreto.

1. **`promptDe` é um throw explícito** (`src/index.ts`). Precisa ser substituído **no mesmo commit**
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

- **`thumb` é anunciado no `/ajuda` e é inalcançável na prática:** só aceita caminho dentro de
  `state/midia`, e nada na etapa 1 escreve lá. Ou some da lista, ou ganha uma tarefa de download.
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
