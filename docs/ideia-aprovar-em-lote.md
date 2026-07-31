# Ideia: aprovar vários de uma vez

Anotação para revisar depois. **Nada aqui está implementado.**

## O problema

Hoje o portão é um `/aprovar` por FLUXO: `/aprovar A#4`. Isso é confortável com
1 público, e vira trabalho manual repetitivo no cenário real — 12 públicos, 12
vídeos gravados no estúdio, e a pessoa voltando ao chat para liberar cada um.

Pior: enquanto ela não aprova, nada anda. O portão existe justamente para isso,
mas ele não deveria cobrar 12 interações quando a decisão é uma só ("gravei
todos, pode ir").

## Os dois lotes possíveis (são diferentes)

**Lote A — vários fluxos.** `/aprovar A#4 A#5 A#6`, ou `/aprovar todos`. Faz
sentido quando se criou um fluxo por público (foi o que aconteceu no A#3/A#4/
A#5: um `/promoavatar --alvo=X` para cada).

**Lote B — vários alvos DENTRO de um fluxo.** Um fluxo de 12 públicos tem hoje
um portão só (`portaoCompleto` espera todos os alvos), então `/aprovar A#6` já
libera os 12 de uma vez. **Este caso talvez já esteja resolvido** — vale
confirmar antes de escrever qualquer código, porque o comportamento nunca foi
exercitado com mais de 1 alvo em produção.

Ou seja: o pedido provavelmente é o **Lote A**.

## O que precisa ser decidido

- **`/aprovar todos` é perigoso?** Aprovar um fluxo cujo vídeo não foi gravado
  dispara `heygen.baixar`, que poleia por **90 minutos** antes de falhar. Com
  12 fluxos, são 12 esperas inúteis. Um `todos` que não confere nada é um pé no
  acelerador com os olhos fechados.
- **Conferir antes de liberar?** O bot PODE saber: `heygen.porTitulo` aceita uma
  lista de títulos numa chamada só (`porTitulo(titulos[])`). Dava para checar
  quais vídeos já existem no estúdio e responder algo como "8 dos 12 estão
  prontos — libero esses 8?". Isso transforma o lote de aposta em decisão
  informada, e reaproveita código que já existe.
- **Aprovação parcial vira estado esquisito?** Liberar 8 de 12 deixa 4 no
  portão. O `/status` sabe representar isso (é estado por fase/alvo), mas a
  mensagem de fim do fluxo precisa não mentir.
- **Qual a sintaxe?** `/aprovar A#4 A#5` (lista), `/aprovar todos`, ou
  `/aprovar` sem argumento quando só existe um esperando. A terceira é a mais
  gentil e a menos ambígua.

## Inclinação

Começar pelo mais barato e mais seguro:

1. **`/aprovar` sem argumento** quando existe exatamente UM fluxo aguardando —
   resolve o caso mais comum sem inventar sintaxe.
2. **`/aprovar A#4 A#5 A#6`** (lista explícita) — sem `todos`, sem mágica.
3. Só então avaliar o `todos` com conferência no HeyGen antes de liberar.

## Ligação com o resto

Se a conferência do item 3 for feita, ela também resolve um risco que já existe
hoje: aprovar cedo demais queima a janela de 90 minutos sem ninguém perceber. O
`HANDOFF` registra isso como característica do portão; virava garantia.

---

## `| aprovar` na criação (2026-07-31)

Pedido: `/promoavatar <assunto> | aprovar` — liberar o portão de antemão, para
o fluxo seguir sozinho assim que a fase 1 acabar.

**Não resolve o caso que motivou o pedido** (rodar a noite toda), e é importante
registrar por quê: o `heygen.baixar` tem janela de **90 minutos**
(`intervalo: 120, timeout: 5400`). Um auto-aprovar dispara os 12 downloads
assim que os roteiros ficam prontos, e os 12 morrem 90 min depois se ninguém
gravou os avatares. O portão não é o gargalo — o gargalo é uma pessoa gravando
12 vídeos no estúdio.

Onde `| aprovar` FARIA sentido:

- quem grava dentro da janela de 90 min, acordado;
- no **`promoclub`**, onde a fase de avatar é do bot (navegador) e não há humano
  no meio. Ali o auto-aprovar é o comportamento natural — mas aquela fase nunca
  rodou por este runner, e o prompt do promoclub ainda é a versão velha.

Mesma decisão de desenho do resto deste documento: liberar sem conferir é
acelerar de olhos fechados. A versão segura confere no HeyGen antes
(`porTitulo` aceita lista) e libera só o que já existe.

---

## Renomear `/aprovar` → `/pronto` (2026-07-31)

Pedido do dono. O verbo está errado para o que a pessoa faz.

`/aprovar` sugere **julgar** — dar um parecer sobre um trabalho que o bot fez. O
que acontece de verdade no portão do `promoavatar` é o contrário: **a pessoa é
quem trabalhou** (gravou os avatares no HeyGen) e está avisando o bot de que
pode seguir. O verbo natural é "pronto", "terminei", "pode ir".

Isso também explica a confusão desta madrugada. Depois de um `/refazer`, a
pessoa mandou `/aprovar` achando que precisava liberar algo. Com `/pronto` a
pergunta que a pessoa se faz muda: "eu já fiz minha parte?" — e a resposta é
óbvia, porque ela sabe se gravou ou não.

Detalhes a decidir:

- **Manter `/aprovar` como sinônimo?** O `/ok` já existe como apelido. Três
  nomes para a mesma coisa é ruído; dois já existem hoje. Talvez `/pronto` vire
  o principal, `/ok` continue, e `/aprovar` saia da ajuda mas siga funcionando
  por um tempo — quebrar o comando que a pessoa decorou é pior que ter um
  sinônimo escondido.
- **Onde o nome aparece:** a mensagem do portão (`Quando estiver pronto:
  /aprovar A#N`), a ajuda derivada do `flow.json` (`Liberar o portão:`), o
  `HELP.md` de domínio quando existir, e o texto do `/ajuda`. Trocar em um só
  lugar deixa o resto mentindo.
- **Combina com o lote:** `/pronto` sem argumento, quando só existe um fluxo
  esperando, lê muito melhor que `/aprovar` sem argumento. É o caso mais comum.

---

## Evidência de campo: as quatro tentativas (2026-07-31)

Para liberar o A#8, o dono digitou, nesta ordem:

| digitado | resultado | por quê |
|---|---|---|
| `/pronto` | **falhou** | o comando não existe (é a ideia acima, ainda não feita) |
| `/ok` | **falhou** | existe como apelido, mas sem referência → "diga qual: /aprovar P#16" |
| `/aprovar a8` | **falhou** | `parseRef` exige o `#`: o regex é `^([A-Za-z]{1,3})#(\d+)$` |
| `/aprovar a#8` | **funcionou** | minúscula é aceita (`toUpperCase` interno) |

Três coisas que isso mostra, e nenhuma é opinião:

**1. O `/pronto` é o verbo certo — a pessoa o alcançou primeiro, sem ele
existir.** Isso vale mais que qualquer argumento de design: foi o que veio à
cabeça de quem acabou de gravar 12 avatares. Sobe a prioridade da renomeação.

**2. O `#` obrigatório não tem razão de ser.** `a8` é inequívoco: letras
seguidas de dígitos, sem `#`, não colidem com id de job (que é só dígitos) nem
com nada mais. `parseRef` poderia aceitar `A#8`, `a#8`, `A8` e `a8` — quatro
formas, um significado. O `#` vira enfeite opcional em vez de armadilha.
Cuidado: `A8` não pode passar a casar onde se espera um NÚMERO de job.

**3. `/ok` sozinho não adivinha.** Se existe exatamente UM fluxo aguardando,
`/ok` (ou `/pronto`) sem argumento deveria liberá-lo — é o caso mais comum e o
que menos exige memória. Já estava na inclinação acima; agora tem caso real.

Custo de não fazer: quatro tentativas para uma ação, às 5 da manhã, com 12
avatares já gravados esperando.
