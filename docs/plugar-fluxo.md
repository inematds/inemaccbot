# Plugar um FLUXO por manifesto

O par `gerar-manifesto-fluxo` + `plugar-fluxo` faz para a **rota de fluxo** o que
[`docs/plugar-por-manifesto.md`](plugar-por-manifesto.md) já fazia para a rota de
skill: um lado caro, com modelo, que roda uma vez por repo; e um lado
determinístico, sem modelo, que aplica em qualquer máquina.

A versão manual continua valendo e é a melhor leitura para entender o que está
acontecendo: rota B de [`docs/instalar-analisevideo.md`](instalar-analisevideo.md).

> **Novo em 0.6.x, ainda sem uso em produção.** O par foi verificado em
> laboratório (ver [Estado da verificação](#estado-da-verificação)); a primeira
> instalação real e o teste na VPS estão pendentes. Se algo aqui divergir do que
> a VPS mostrar, o documento é que está errado.

## O que entrou

| peça | onde | o que faz |
|---|---|---|
| `rota: "fluxo"` no manifesto | `dominio/manifesto.ts` | antes era recusado com "só skill por enquanto" |
| `definicao` | idem | o manifesto CARREGA `flow.json`, prompts e `HELP.md` |
| `gerar-manifesto-fluxo.sh` | `scripts/` | lê o repo com modelo e DESENHA as fases |
| `plugar-fluxo.sh` | `scripts/` | materializa no repo de domínio e registra no bot |
| conferência com `carregarFlow` | `plugar-ajuda.mjs` | roda o validador REAL do `flow.json` num temporário, antes de escrever |
| `planoMaterializacao` | `dominio/plugar.ts` | decide escrever / igual / **importar** / conflito |
| `inserirEntradaFluxo` | idem | entrada em `config/fluxos.json`, validada pelo validador do BOOT |

## Skill ou fluxo?

Escolha errada aqui custa mais que qualquer detalhe adiante.

| | skill | fluxo |
|---|---|---|
| entrega | **um** artefato | vários, em etapas |
| estado | nenhum entre execuções | por fase e por alvo, retomável |
| portão humano | não | sim (`pausa_apos`) |
| onde mora o miolo | um prompt **no bot** | `flow.json` + prompts **no repo** |
| exemplo | `transcrever: <link>` | `/promoavatar <assunto>` |

Regra prática: se você quer **parar no meio e olhar** antes de gastar o passo
caro, é fluxo. Se é "entra X, sai um arquivo", é skill.

## A diferença que molda os dois scripts

Uma skill cabe inteira do lado do bot. Um fluxo **não**: `carregarFlow` lê
`<repo>/flow.json` do disco, e as fases de agente leem os prompts de lá.

Daí a decisão central deste par: quando o repo ainda **não** é domínio, o
manifesto **carrega a definição** (`definicao.flow`, `definicao.prompts`,
`definicao.help`) e o `plugar-fluxo` a **materializa** no repo. Quando o repo já
tem `flow.json`, o manifesto é só **registro**.

Três regras governam a materialização, e nenhuma é negociável:

1. **O repo é o dono da definição.** Arquivo com conteúdo diferente nunca é
   sobrescrito. Sobrescrever um `flow.json` alheio apagaria a máquina de estados
   de um fluxo que pode estar em produção, e `--desfazer` num repo que não é
   nosso é promessa que não se cumpre. Conteúdo idêntico não é conflito:
   re-plugar tem que ser operação que não faz nada.
2. **Repo que já é domínio é a FONTE, e a sincronização é domínio → manifesto.**
   Quando o repo traz `flow.json` próprio, divergência não para nada: o arquivo
   do repo é `IMPORTAR`, e é o **manifesto** que se atualiza a partir dele. O
   conflito sobra só para repo que ainda não é domínio, onde não há de onde
   importar.

   O motivo é concreto. O manifesto do musicavideo foi escrito por um modelo,
   chutando como o domínio funciona: inventou um binário `musicavideo` que não
   existe no PATH e um contrato de saída errado (`RESULT:` apontando o
   `PLANO.md` do domínio em vez do `{{saida}}` do bot). Os dois passaram por
   toda a validação e só falharam em produção, no MVD#87 e no MVD#88. Definição
   adivinhada não pode competir de igual para igual com a que o domínio
   versiona — e, corrigida no repo, tem que voltar para o manifesto, senão o
   próximo plug numa máquina limpa reescreve a versão quebrada.

   Por isso o que sai como `ESCREVER` vem marcado **(gerado — REVISE)**: ali o
   domínio não declarou nada, e o que está indo para o disco é palpite. Leia
   principalmente a invocação e o contrato de saída.
3. **O script não commita no repo de domínio.** Ele escreve e diz o que
   commitar. Commit em repo alheio, com autor que talvez não seja o certo, é
   decisão do dono.

### O portão é do domínio: `portao.mostrar`

O portão nasceu lendo `textos/<REF>/<alvo>.md` — a forma do promoavatar. Quando
o musicavideo entrou, o portão dele abriu **mudo** (MVD#89): o produto era um
`PLANO.md` numa pasta cujo slug o bot nem conhece, e a fase seguinte era a única
paga do fluxo. Em vez de o bot ganhar uma segunda convenção chumbada, a fase
DECLARA o que mostrar:

```json
{ "id": "plano", "pausa_apos": true, "portao": { "mostrar": ["{{artefato:plano}}"] } }
```

Marcadores: `{{repo}}`, `{{ref}}` (`A32`), `{{alvo}}`, `{{artefato}}` (o arquivo
que a fase declarou no `RESULT:`) e `{{artefato:campo}}` — o valor de `campo:`
DENTRO desse arquivo. Este último é o que faz o mecanismo servir de verdade: o
slug do musicavideo é derivado do texto e desambiguado com `-2`, então o caminho
do produto só o domínio sabe montar. Ele escreve `plano: <caminho>` no recibo, e
o portão vai buscar ali.

Regras: `portao` só é aceito em fase com `pausa_apos` (declarar o que mostrar
numa fase que não para seria pedido nunca atendido); molde que não resolve vira
**aviso nomeando o molde**, nunca portão calado; e quem declara não recebe
nenhuma heurística por cima — sem declaração, vale o comportamento de sempre
(roteiros, e o artefato como rede quando não há roteiro nenhum).

## Gerar (uma vez, com modelo)

```bash
./scripts/gerar-manifesto-fluxo.sh ~/projetos/musicaclone
# ou pela URL, que ele clona num temporário:
./scripts/gerar-manifesto-fluxo.sh https://github.com/inematds/musicaclone
```

Saída: **um** arquivo versionável, `config/integracoes/<command>.json`.

O modelo faz duas chamadas — a primeira desenha a máquina de estados, a segunda
escreve **um prompt por fase de agente**. É a mesma separação da rota de skill, e
pelo mesmo motivo: markdown dentro de JSON na mesma resposta sai escapado errado
e estraga os dois.

O catálogo de tarefas que vai no prompt é **extraído do código** (`TAREFAS_DE_FASE`
em `dominio/flow.ts` mais os comandos de `config/skills.json`), nunca digitado à
mão: uma lista que envelhecesse faria o modelo inventar tarefa, e o erro só
apareceria no `plugar-fluxo`.

### O que o modelo NÃO consegue saber

**`alvos` — canal e gatilho.** Isso é conhecimento de negócio; não está em
código-fonte nenhum. Por isso ele é instruído a marcar `definicao.flow.alvos`
sempre como `chute`, e a tela de revisão grita isso. Quando não dá para deduzir,
ele gera **um alvo só**, chamado `unico` — e cabe a você abrir e corrigir.

A tela de revisão mostra a tabela de fases (id, escopo, fila, kind, tarefa, e
onde estão os portões) justamente para essa conferência ser possível sem abrir o
JSON.

## Plugar (em qualquer máquina, sem modelo)

```bash
./scripts/plugar-fluxo.sh musicaclone          # mostra o plano e PARA
./scripts/plugar-fluxo.sh musicaclone --sim    # materializa e registra
./scripts/plugar-fluxo.sh musicaclone --desfazer
```

Os sete passos, e o que cada um evita:

| passo | o que faz | o que evita |
|---|---|---|
| 1. Manifesto | valida; local vence o do repo | manifesto inválido virando config quebrada |
| 2. Repo | clone, e confere o **commit** do manifesto | confiar num desenho feito para outra versão do repo |
| 3. Dependências | `command -v` de cada `requer.bin` | fase que falha no primeiro job, não na instalação |
| 4. Chaves | confere no cofre; **vazia conta como ausente** | `CHAVE=` que passa no boot e falha 40 min depois |
| 5. Definição | importa do domínio o que ele declara; materializa só o que falta | escrever por cima do dono, e definição chutada virando fonte |
| 6. `config/fluxos.json` | insere e valida com o validador **do boot** | entrada que derruba o serviço |
| 7. Suíte e build | roda os dois | descobrir a quebra no restart |

### A ordem 5 → 6 é obrigatória

O registry de fluxos vai ao **disco** no boot: ele recusa entrada cujo repo não
exista ou não tenha `flow.json` (`dominio/registry-fluxos.ts`). Registrar antes
de materializar **derruba o serviço**. Por isso, em modo seco, o passo 6 avisa
que só roda com `--sim` — não há como validar contra um arquivo que ainda não
existe.

### O backup, e o ciclo `--sim` → `--sim` → `--desfazer`

O backup (`config/fluxos.json.bak-<nome>`) guarda o estado **anterior ao
primeiro plug**, e só é criado quando ainda não existe. Rodar `--sim` duas vezes
não o sobrescreve — se sobrescrevesse, a segunda rodada salvaria um arquivo que
JÁ contém a entrada, e `--desfazer` "restauraria" exatamente o que se queria
desfazer. É o `--desfazer` que consome o backup, para que o próximo `--sim`
comece um ciclo novo.

(Vale igual para o `plugar-repo.sh` e o `config/skills.json`.)

### O que `--desfazer` faz, e o que não faz

Restaura o `config/fluxos.json` do backup. **Não remove** os arquivos
materializados no repo de domínio: eles estão num repo que não é nosso, podem ter
sido editados desde então, e um `rm` ali seria a única operação irreversível do
script inteiro. Ele diz a pasta certa (lida de `repo.pasta`, que pode diferir do
comando) e deixa a decisão com você.

## HELP.md curto é pior que nenhum

Isto é mecânico, não gosto: quando `HELP.md` existe, `ajudaDoFluxo` o usa **no
lugar** da ajuda derivada do `flow.json` — que lista fases, escopo e onde estão
os portões. Um esqueleto de três linhas troca uma ajuda boa e automática por uma
ruim e manual, e a regra "todo domínio do catálogo é documentado"
(`gateway/ajuda-dominio.test.ts`) reprova a suíte inteira por causa disso.

Por isso o validador **recusa** `definicao.help` com menos de 60 caracteres, e a
recusa acontece na validação do manifesto — o único momento em que ainda não se
escreveu nada no repo alheio. Não sabe o que escrever? **Omita o campo:** a ajuda
derivada não mente.

## Onde o custo realmente está

Não é no `flow.json`. É no **catálogo fechado de tarefas** (§9): `tarefa` só pode
ser um nome já registrado. Se o seu fluxo precisa de um passo que não existe
(publicar numa plataforma, gerar uma faixa), isso é **código novo** em
`src/fila/tarefas/`, com teste — e nenhum gerador tira isso de você.

O contorno barato, e o gerador é instruído a usá-lo: a fase vira `kind: agent`
com `tarefa: fluxo-agente` e um prompt que manda rodar o comando do repo. Mais
caro em token e mais frágil, mas roda hoje. Converter para `function` depois é
uma fase de cada vez.

## Depois de plugar

1. Comite no repo de domínio o `flow.json` / prompts / `HELP.md` materializados.
2. Confira job em voo (`/status`) — restart mata render em andamento.
3. Reinicie o serviço.
4. `/ajuda` lista o comando; `/<fluxo> help` mostra o cartão do domínio.
5. **Rode um fluxo real até o primeiro portão** antes de confiar nas fases
   seguintes. O desenho só está provado quando a primeira fase entrega.

## Estado da verificação

Honestidade sobre o que foi exercitado, porque isto muda o que você deve olhar
com desconfiança amanhã.

| peça | como foi verificado |
|---|---|
| validador (`rota: fluxo`) | teste automatizado — pacote válido, prompt ausente, fase sem id, caminho com `..`, HELP curto, chave com valor |
| `planoMaterializacao` | teste automatizado — escrever, igual (com `\n` a mais), importar (domínio vence), conflito (repo que não é domínio) |
| `inserirEntradaFluxo` | teste automatizado, incluindo repo sem `flow.json` |
| `plugar-fluxo.sh` | **ponta a ponta com repo de domínio real**: modo seco, `--sim`, re-plugar, conflito, `--desfazer`, e o ciclo `--sim` → `--sim` → `--desfazer` |
| `PROJETOS_DIR` | as três precedências (ambiente, `.env`, pasta-pai) |
| conferência via `carregarFlow` | verificada com um manifesto sem `versao_def`: recusa antes de escrever |
| `gerar-manifesto-fluxo.sh` | **rodado contra o modelo em dois repos** (um de teste e o `musicavideo`), até a revisão e a gravação |
| na VPS | **não** — é o teste de amanhã |
| um fluxo plugado rodando de verdade no Telegram | **não** |

## Duas validações, e por que são duas

O manifesto passa por **dois** validadores, e confundi-los custa caro:

1. **O esquema do manifesto** (`dominio/manifesto.ts`) — a forma do pacote:
   rota, repo, requer, e a coerência "toda fase de agente tem o prompt dela
   dentro".
2. **O validador REAL do `flow.json`** (`carregarFlow`) — a semântica do fluxo:
   `versao_def`, prefixo, alvos, tarefa no catálogo, prompt existente e não
   vazio.

O segundo lê do **disco**, e o manifesto traz tudo em memória. Por isso o
`plugar-ajuda validar-fluxo` materializa a definição num diretório
**temporário** e chama `carregarFlow` ali — validar não pode escrever no repo
dos outros, e recusar nesse ponto é o único momento em que ainda não se escreveu
nada.

Sem essa conferência, um campo que o esquema do manifesto não exige atravessaria
a geração inteira e só seria recusado no PRIMEIRO COMANDO do fluxo — depois de
já estar escrito no repo de domínio. Foi exatamente o que aconteceu com
`versao_def` na primeira simulação: obrigatório no `flow.json`, ausente do
prompt do gerador, invisível para o esquema do manifesto.

## Limites conhecidos

Nenhum destes é bug do script: são o que o desenho automático não resolve.

**1. O modelo colapsa portões.** Na simulação com o `musicavideo` — que tem
portão POR PARTE (`ok musica`, `ok capa`, `ok clipe`) — ele desenhou uma fase
`gerar` só, com um portão. O fluxo rodaria, mas você perderia o "aprovo a capa,
rejeito o clipe", que é o ponto daquele repo. **Confira o número de portões
contra o que o repo oferece** antes de aceitar.

**2. `alvos` é sempre chute.** Canal e gatilho são conhecimento de negócio e não
estão em código-fonte nenhum. O gerador foi instruído a marcá-los como chute
sempre, e a gerar UM alvo (`unico`) quando não sabe. Na simulação ele escreveu
`"canal": "livesN"` — literal, não resolvido. É para corrigir na revisão.

**3. O catálogo fechado é o teto.** `tarefa` só pode ser um nome já registrado
(`TAREFAS_DE_FASE` + os comandos de `config/skills.json`). Passo que não existe
vira fase `kind: agent` com prompt de cola — mais caro em token e mais frágil.
Fazer virar `function` é código novo em `src/fila/tarefas/`, com teste, e nenhum
gerador tira isso de você.

**4. Repo que já tem portão e estado próprios.** `musicavideo` (`estado.json`,
`faz` retoma de onde parou) e `timesmkt3` (bot, BullMQ, 5 stages com aprovação)
já são máquinas de estado completas. Plugar como fluxo DUPLICA isso: dois
portões, dois `/status`, duas retomadas. A pergunta anterior a "como plugo" é
"devo plugar, ou trazer as partes e aposentar a duplicata?".

## Roteiro do teste na VPS

Ordem pensada para que a primeira falha seja barata.

### Antes de tudo: o gerador NÃO roda na VPS

`gerar-manifesto-fluxo.sh` precisa de um modelo. É metade cara do par, e roda
**uma vez, na sua máquina**. Na VPS entra só o `plugar-fluxo.sh`, determinístico,
lendo o manifesto que veio versionado no `git pull`.

### 1. Conferir a árvore de projetos

```bash
grep PROJETOS_DIR .env          # na VPS o exemplo traz /root/projetos
```

O script agora lê `PROJETOS_DIR` do ambiente, senão do `.env` do repo, senão a
pasta-pai do clone — a MESMA ordem do bot. Se divergirem, você plugaria contra
uma árvore e o bot subiria contra outra: "plugou" aqui, `diretório não existe`
no restart. **Esta é a primeira coisa a checar amanhã**, porque é a única que
depende da máquina — e porque até 0.6.1 os dois scripts assumiam a pasta-pai,
ignorando a variável.

### 2. Modo seco, sempre

```bash
git pull
./scripts/plugar-fluxo.sh <command>          # NÃO escreve nada
```

O que ler na saída, em ordem de importância:

- **passo 5** — `IMPORTAR` / `IGUAL` / `ESCREVER` / `CONFLITO`. `IMPORTAR` é o
  domínio vencendo e o manifesto se atualizando (confira o diff dele antes de
  commitar). `ESCREVER` é conteúdo GERADO indo para o repo: leia. `CONFLITO`
  para tudo, e é o comportamento certo num repo que ainda não é domínio.
- **passo 1** — a linha de chutes. `definicao.flow.alvos` estará lá sempre.
- **passo 2** — se o repo andou desde o commit do manifesto, o aviso aparece.

Em modo seco o passo 6 avisa que não valida: não há como validar contra um
`flow.json` que ainda não existe.

### 3. Aplicar

```bash
./scripts/plugar-fluxo.sh <command> --sim
```

Ele materializa, registra, roda a suíte e o build. Se a suíte quebrar,
`--desfazer` e leia o erro: foi assim que a regra do `HELP.md` apareceu.

### 4. Antes de reiniciar

```bash
# no Telegram
/status
```

**Restart mata render em andamento.** Confira job em voo antes.

### 5. Depois de reiniciar

```bash
/ajuda                # o comando novo aparece?
/<comando> help       # o cartão do domínio responde?
```

E então rode um fluxo real **até o primeiro portão**. Não confie nas fases
seguintes antes disso: o desenho só está provado quando a primeira fase entrega
arquivo.

### 6. Commitar no repo de domínio

O `plugar-fluxo` **não commita** lá. Os arquivos materializados ficam
não-commitados no repo de domínio, esperando sua revisão — e o autor do commit
segue a conta de destino daquele repo, não a deste.

## Se der errado

| sintoma | causa provável | o que fazer |
|---|---|---|
| `registry de fluxos: … diretório não existe` no boot | `PROJETOS_DIR` divergente, ou repo não clonado | passo 1 do roteiro |
| `não há flow.json em …` | registrou sem materializar | `--desfazer`, e rode com `--sim` |
| `CONFLITO flow.json` | repo que ainda não é domínio já tem arquivo diferente | compare os dois; o repo manda. Em repo COM `flow.json` próprio isto não acontece: vira `IMPORTAR` |
| a suíte reprova em "todo domínio do catálogo é documentado" | `HELP.md` curto | omita o `help` do manifesto: a ajuda derivada é melhor |
| `manifesto inválido` no passo 1 | manifesto velho para o esquema atual | regere na sua máquina |
| o fluxo aparece no `/ajuda` mas o primeiro comando falha | `flow.json` semanticamente inválido | o boot não valida conteúdo; o erro vem do `carregarFlow` — leia a mensagem, ela nomeia o campo. Se o fluxo foi plugado por manifesto isto não deveria acontecer: a conferência do passo 1 já roda o `carregarFlow` |
| `flow.json (<campo>): …` já no passo 1 | a definição do manifesto é inválida | é a conferência funcionando — corrija o manifesto e regere, nada foi escrito |
