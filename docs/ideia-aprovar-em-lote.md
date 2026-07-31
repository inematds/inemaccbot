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
