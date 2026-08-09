# Arquitetura em operação: boot, desligamento, filas e convenções

> Detalhe extraído do `README.md` em 2026-08-09. É leitura de **quem mexe no
> código** — não de quem instala. Para instalar e configurar, o `README.md` basta.
>
> As garantias descritas aqui são verificadas por teste; quando um número aparece
> (110s de dreno, 120s no unit), ele está amarrado ao código e ao
> `deploy/*.service` — mudar um sem o outro quebra o desligamento limpo.

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