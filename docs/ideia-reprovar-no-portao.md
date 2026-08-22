# Reprovar no portão (e as duas faixas que ninguém viu)

Anotado em 2026-08-22, para fazer depois. Dois pedidos, a mesma raiz: **o portão
só sabe dizer SIM.**

## 1. Não dá para reprovar

`/aprovar` (e `/pronto`) liberam. Não há o contrário.

`/refazer` não serve: ele só pega fase em `falhou` (`runtime.ts`, no laço de
`refazer()` — `if (fase.estado !== 'falhou') continue`). Fase parada no portão
está em `aguardando-ok`, então o chat responde *"nada a refazer — nenhuma fase
falhou"*. A única saída é `/cancelar`, que mata o fluxo inteiro e marca as fases
como puladas: para trocar UMA capa, perde-se tudo.

Forma proposta:

    /refazer <ref> [público] | correcao=<o que corrigir>

- passa a aceitar fase em `aguardando-ok`, não só `falhou`;
- a fase volta a `pendente` e as posteriores voltam a esperar a vez
  (`marcarPosteriores`, que `refazer` já chama);
- a `correcao` entra no input da fase — é o que faltava para "refaz, mas
  diferente" em vez de "refaz igual".

Mexe em `fluxos/runtime.ts` e no parser do comando. É mudança de comportamento
do portão: bump minor.

## 2. A capa tem correção; o resto não

Para a capa já existe saída sem refazer nada — e é o modelo do que falta:

    capa: <ref> <público> <n> [cover]        # outra imagem do roteiro visual
    capa: <ref> <público>  + foto anexada    # a imagem que a pessoa mandou
    capa: <ref> * ...                        # todos os públicos de uma vez

Para o texto/roteiro não há equivalente: é editar `<repo>/textos/<REF>/<alvo>.md`
à mão, o que só funciona para quem tem terminal — exatamente o atrito que o
comando `capa:` existe para eliminar.

## 3. A fase `musica` produz DUAS faixas e mostra UMA — FEITO em 2026-08-22

> Resolvido: o recibo passou a declarar `musica_alt:` e o `flow.json` mostra as
> duas, com `?` no molde da alternativa. Fica pendente só **escolher** qual vale
> (o `musica: <ref> 2` descrito no fim). O texto abaixo é o diagnóstico original.

Achado no MVD#96 (2026-08-22). O `kie:suno-v4.5` devolve duas variações e as duas
estão no disco:

    output/musicavideo/traditional-southern-brazilian-gaucho-fo/faixa-1.mp3
    output/musicavideo/traditional-southern-brazilian-gaucho-fo/faixa-2.mp3

O recibo declara só a primeira (`musica: … /faixa-1.mp3`), o chat entrega só ela,
e a `faixa-2` — já paga no mesmo US$ 0,08 — nunca é ouvida nem oferecida. Não é
custo extra escolher: é escolha que já foi paga e está sendo jogada fora.

Duas metades:
- a fase declarar as duas na entrega do portão (é `portao.mostrar` do domínio);
- um jeito de dizer qual vale — no mesmo formato do `capa:`, algo como
  `musica: <ref> 2`, que grava a escolha antes de a fase `clipe` ler a faixa.

A ordem importa: o `clipe` do MVD#96 já começou com a faixa-1. Escolher depois
do clipe montado não adianta.


## 4. Duas faixas, e o clipe? (pedido de 2026-08-22)

Entregar as duas resolveu ver; não resolveu **o que renderizar**. Hoje o `clipe`
lê a faixa escolhida (`faixa_aprovada` no `executor.py`) e ignora a outra. Três
saídas, e elas não são exclusivas:

**a) Dois clipes, um por faixa.** O domínio já sabe fazer isso: `_capas_por_versao`
marca `capa-v1.png`/`capa-v2.png` justamente porque "o Suno entrega duas, e as
duas viram clipe", e `aprova <slug> musica --faixa N` já reaponta para um
`clipe-N.mp4` existente **sem re-render**. Falta o fluxo do bot pedir os dois.
Custo: dobra a fase mais cara do fluxo (render de horas, fila `render` de uma
vaga só). Não pode ser o default.

**b) O mesmo clipe para as duas faixas.** Barato: um render, duas trilhas
trocadas por `ffmpeg -c:v copy`. Serve quando o visual não foi feito para a
letra — e é o caso comum de um clipe gerado do plano, não da faixa. É a opção
com melhor relação custo/entrega das três.

**c) Escolher no portão qual vira clipe.** O que o pedido literalmente diz. No
molde do `capa:`, algo como:

    musica: <ref> 2        # a faixa 2 é a que vale; o clipe usa ela

Grava a escolha ANTES de a fase `clipe` ler a faixa — depois do clipe montado
não adianta. Por baixo é o `aprova <slug> musica --faixa N` que já existe; falta
o comando no chat e a ordem no portão.

Ordem sugerida: **(c) primeiro** — é a mais barata de implementar e a que evita
render errado. Depois **(b)** como opção explícita (`| dois-clipes` seria (a),
e (a) só sob pedido, nunca por default).

Nota: (c) é a mesma peça do item 1 deste documento (reprovar no portão) vista de
outro ângulo — em ambos, o portão precisa aceitar uma RESPOSTA além do sim.
