# Plugar um FLUXO por manifesto

O par `gerar-manifesto-fluxo` + `plugar-fluxo` faz para a **rota de fluxo** o que
[`docs/plugar-por-manifesto.md`](plugar-por-manifesto.md) já fazia para a rota de
skill: um lado caro, com modelo, que roda uma vez por repo; e um lado
determinístico, sem modelo, que aplica em qualquer máquina.

A versão manual continua valendo e é a melhor leitura para entender o que está
acontecendo: rota B de [`docs/instalar-analisevideo.md`](instalar-analisevideo.md).

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

Duas regras governam a materialização, e nenhuma é negociável:

1. **O repo é o dono da definição.** Arquivo com conteúdo diferente é
   **conflito** e para a instalação — nunca sobrescrita. Sobrescrever um
   `flow.json` alheio apagaria a máquina de estados de um fluxo que pode estar
   em produção, e `--desfazer` num repo que não é nosso é promessa que não se
   cumpre. Conteúdo idêntico não é conflito: re-plugar tem que ser operação que
   não faz nada.
2. **O script não commita no repo de domínio.** Ele escreve e diz o que
   commitar. Commit em repo alheio, com autor que talvez não seja o certo, é
   decisão do dono.

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
| 5. Definição | materializa (ou confirma que o repo já traz) | escrever por cima do dono |
| 6. `config/fluxos.json` | insere e valida com o validador **do boot** | entrada que derruba o serviço |
| 7. Suíte e build | roda os dois | descobrir a quebra no restart |

### A ordem 5 → 6 é obrigatória

O registry de fluxos vai ao **disco** no boot: ele recusa entrada cujo repo não
exista ou não tenha `flow.json` (`dominio/registry-fluxos.ts`). Registrar antes
de materializar **derruba o serviço**. Por isso, em modo seco, o passo 6 avisa
que só roda com `--sim` — não há como validar contra um arquivo que ainda não
existe.

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
