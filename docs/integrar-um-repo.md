# Integrar um repo no bot: por que existe o manifesto, e por que plugar é um script burro

Este documento é o **porquê**. O passo a passo campo a campo está em
[`plugar-por-manifesto.md`](plugar-por-manifesto.md) (skill) e
[`plugar-fluxo.md`](plugar-fluxo.md) (fluxo); o exemplo real, do clone ao
primeiro job, em [`instalar-analisevideo.md`](instalar-analisevideo.md).

## O problema

Você tem um projeto que já funciona sozinho — `analisevideo`, `musicavideo`, o
que for. Ele nasceu sem saber que o inemaccbot existe, e não deveria ter que
saber. Você quer digitar `musicavideo: <link>` no Telegram e receber o arquivo
de volta.

As duas saídas óbvias são ruins:

- **Importar o código do outro repo para dentro do bot.** Vira cópia que
  envelhece, e todo projeto novo obriga a editar o bot.
- **Deixar um agente "se virar".** É o que o v1 fazia. Sem contrato, o agente
  escolhe um caminho de saída qualquer, ninguém acha o arquivo, e o job termina
  "com sucesso" sem entregar nada.

## A saída: o bot não conhece o repo, conhece a FICHA dele

O bot nunca importa o código de ninguém. Ele sabe fazer **uma coisa**: rodar
uma linha de shell dentro de um agente e recolher **um arquivo**.

O manifesto é a ficha que responde às quatro perguntas que faltam:

| Pergunta | Campo | Por que não dá para adivinhar |
|---|---|---|
| Como chamo? | `invocacao` | `bash {{repo}}/x.sh "{{input}}"` — só quem leu o repo sabe |
| Onde isso pode rodar? | `fila`, `timeout_segundos`, `max_tentativas` | um render na fila do texto trava as outras skills |
| O que a máquina precisa ter? | `requer.bin`, `requer.chaves` | faltar `yt-dlp` ou `GOOGLE_API_KEY` só apareceria no primeiro job |
| O que espero de volta? | `artefato_exts` | é o que nomeia o `{{saida}}` |

Mais o **prompt** (`prompts/<nome>.md`): o texto entregue ao agente. Rode esta
linha, grave em `{{saida}}`, **não instale nada**, e termine declarando o
contrato — com as armadilhas que o repo tem de verdade (nome que o script
desambigua sozinho, saída em caminho diferente do previsto, pasta reaproveitada
entre execuções). É isso que separa o prompt gerado de um genérico.

Plugado, tudo isso vira **uma linha** em `config/skills.json` (skill) ou em
`config/fluxos.json` (fluxo). O repo continua intacto e continua sendo dono de
si.

## Por que são DOIS scripts, e não um

O par existe porque as duas metades têm custos opostos:

**`gerar-manifesto*` — a metade cara.** Um modelo lê o repo alheio e decide
fila, timeout, invocação, prompt. Exige julgamento e uma máquina com modelo.
Roda **uma vez por repo**, e o resultado é comitado.

**`plugar-repo` / `plugar-fluxo` — a metade barata.** **Nenhum modelo no
caminho.** Só aplica o que já foi decidido e revisado: mesma entrada, mesmo
resultado, em qualquer máquina. Numa VPS nova, `git pull` + plugar bastam.

Daí a regra prática: **gerar onde tem modelo; na VPS, só plugar.** Se o
`gerar-manifesto` falhar na VPS com "o modelo falhou", quase sempre é isso — a
CLI não está logada lá (desde a 0.9.4 a mensagem diz o motivo real).

E daí também a regra que resume o resto: **plugar nunca adivinha.** Sem
manifesto ele **para** em vez de chutar, porque o modo de falha de chutar é um
job que termina sem entregar arquivo — o defeito mais caro deste projeto. O
lugar de consertar é sempre o manifesto, antes de plugar.

## O que o plugar confere antes de escrever

Nesta ordem, e cada passo existe por um defeito que já aconteceu:

1. **Manifesto** — local (`config/integracoes/<nome>.json`) vence o do repo
   (`<clone>/integracao.json`). Manifesto vindo do repo é **adotado**: copiado
   para dentro do bot, sob o seu git, para não mudar sozinho no próximo `git
   pull` do projeto alheio.
2. **Repo** — clona ou atualiza, e compara o `HEAD` com o `repo.commit` do
   manifesto. O manifesto foi escrito olhando **um** commit; se o repo andou,
   avisa em vez de aplicar às cegas.
3. **Binários** — sugere o comando de instalação e **para**. Não instala nada:
   quem decide o que entra na máquina é o dono, e o prompt proíbe o agente de
   instalar.
4. **Chaves no cofre** (`~/projetos/wifi/.env`) — só o **nome** da variável
   viaja no manifesto, que é versionado e público. **Chave vazia conta como
   faltando**: `CHAVE=` passa em qualquer teste de existência e só falha no
   primeiro job, com um erro do provedor que não menciona o cofre.
5. **Prompt** — precisa citar `{{input}}`, `{{saida}}` e `RESULT:`.
6. **A entrada, com o validador REAL do boot** — antes de tocar no arquivo. É o
   que faz "plugou" e "o serviço sobe" serem a mesma coisa: registry inválido
   **derruba o boot**, e o modo de falha "o bot não sobe" é pior que "a
   instalação parou".
7. Só então escreve, com backup (`--desfazer` restaura), e roda **suíte e
   build**.

Modo seco é o padrão: sem `--sim` ele mostra o diff e **não escreve nada** —
esse é o motivo número um de "plugou e não apareceu no `skills.json`".

## Entrada, saída, e o contrato no meio

**Entrada.** O que você digita depois dos dois pontos vira `{{input}}`, sempre
**entre aspas** na invocação (entrada com espaço ou `&` quebraria a linha de
comando). O `{{repo}}` vira `PROJETOS_DIR/<repo.pasta>` na hora do job — por
isso o prompt cita `{{repo}}/script.sh` e nunca um caminho de máquina: o mesmo
prompt tem que valer no seu laptop e na VPS, onde `PROJETOS_DIR=/root/projetos`.

Três nomes costumam coincidir e por isso confundem:

| | o que é | quem decide |
|---|---|---|
| **URL** | de onde clonar | você |
| **`repo.pasta`** | a pasta do clone dentro de `PROJETOS_DIR` | o manifesto |
| **`command`** | o verbo do chat | o manifesto |

Só a **pasta** é usada para achar o repo no disco, e o `command` pode ser outro
(`roda` num repo `repoprep`). Se a revisão mostrar `pasta repo`, algo saiu
errado — foi o bug do `basename` da pasta temporária, corrigido em 0.8.1/0.8.4.

**Saída.** O bot não confia no que o agente *diz*, confia em **arquivo**:

- o prompt manda gravar em `{{saida}}` — caminho escolhido pelo bot,
  `state/artefatos/<command>/<job>.<ext>`, determinístico por job (retentativa
  reescreve o mesmo arquivo em vez de espalhar `-1`, `-2` pelo disco);
- sucesso é a última linha `RESULT: <caminho>`; falha é `ERRO: <motivo curto>`;
- **sem `RESULT:` mas com o arquivo no lugar, o bot aceita pelo arquivo** — o
  contrário (aceitar stdout como sucesso) já deixou passar job que não entregou
  nada;
- o resultado do job é sempre **o caminho**, nunca o stdout do agente. É ele que
  vai para o Telegram, ou para o destino quando a skill declara
  `aceita_destino`.

**Trabalho longo.** Com `aguarda_artefato`, o agente ganha um prazo **curto**
só para disparar o trabalho destacado, e o serviço fica **vigiando o arquivo
aparecer** com o prazo longo. É o que faz um `systemctl restart` no meio de 40
minutos de render não matar o job — e é por isso que toda skill da fila `render`
precisa declarar isso (há teste cobrando).

## Skill ou fluxo — a bifurcação

|  | **skill** | **fluxo** |
|---|---|---|
| gerador / plugador | `gerar-manifesto` → `plugar-repo` | `gerar-manifesto-fluxo` → `plugar-fluxo` |
| onde a entrada mora | `config/skills.json` | `config/fluxos.json` |
| forma | um comando, uma etapa, **sem estado** | **fases** com estado por alvo |
| quem é dono da lógica | o bot (prompt + manifesto) | o **`flow.json` dentro do repo de domínio**; o bot só registra comando e pasta |
| retentar | "do zero" é aceitável por definição | não: a definição é **congelada** na criação, e o prompt da fase viaja dentro do job |
| portão | não existe | `pausa_apos: true` numa fase |

Rodar os dois geradores no mesmo repo produz dois manifestos concorrentes.
Decida antes.

## Os portões

Portão é **fase que termina e o fluxo PARA**, esperando `/aprovar`. Existe para
dois casos, e os dois são econômicos:

- **revisar antes de gastar** — aprovar o roteiro antes de queimar render;
- **a etapa é sua** — o fluxo espera enquanto você faz a parte humana, e o
  `/aprovar` é o seu "terminei".

Num desenho típico (`plano [PORTÃO]` → `executar`), você aprova o plano e só aí
o caro acontece. Alguns fluxos expõem `| sem-portao` para ir direto do assunto
ao artefato — ver [`fase-avatar-via-api.md`](fase-avatar-via-api.md).

## Depois de plugar

1. Confira job em voo antes de reiniciar (`/status`, ou `./stop.sh`, que recusa
   parar com job em voo) — **restart mata render em andamento**.
2. Reinicie o serviço.
3. `/ajuda` deve listar o comando novo.
4. Teste com uma entrada real e confira que o **arquivo chega no chat**. Nada
   antes disso prova que a integração funciona: a suíte prova que o registry é
   válido, não que o script do outro repo entrega.

Deu errado: `./scripts/plugar-repo.sh <nome> --desfazer`.

## Modos de falha que já morderam

| Sintoma | Causa real |
|---|---|
| "plugou" mas o `skills.json` não mudou | rodou sem `--sim` (modo seco é o padrão) |
| `placeholder sem valor: repo` no primeiro job | o `{{repo}}` do prompt não era resolvido — corrigido em 0.8.1, e a entrada agora carrega `repo` |
| `SyntaxError: ... does not provide an export named ...` | `dist/` velho depois de um `git pull` — 0.8.2 passou a compilar quando está desatualizado |
| "faltando (ou vazia) no cofre …" com um caminho estranho | comentário no fim da linha do `.env` entrando no `PROJETOS_DIR` — 0.8.3 |
| revisão mostra `pasta repo` | nome tirado da pasta temporária do clone — 0.8.1 (skill) e 0.8.4 (fluxo) |
| `✗ o modelo falhou`, sem motivo | a CLI escreve login/crédito no **stdout**; 0.9.4 passou a mostrar os dois — e, na VPS, o normal é não ter modelo mesmo |
| job termina sem entregar arquivo | prompt sem `{{saida}}`/`RESULT:`, ou fila/timeout chutados sem revisão |
