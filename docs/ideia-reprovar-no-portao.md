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

### A forma que o dono pediu (2026-08-22)

Uma resposta só no portão da música, com três valores:

| resposta | o que acontece |
|---|---|
| `a` | a faixa **1** é a principal — UM render |
| `b` | a faixa **2** é a principal — UM render |
| `2` | **dois clipes diferentes**, um por faixa — dois renders |

Ou seja: (a) e (b) são a MESMA operação com escolha diferente, e só `2` paga o
render dobrado. A decisão cara fica explícita e é do dono, que é o ponto — o
default nunca dobra a fase mais cara do fluxo.

**A confirmar antes de implementar:** em `a`/`b`, a outra faixa recebe o mesmo
vídeo (dois `.mp4` com a mesma imagem e trilhas diferentes, via `ffmpeg -c:v
copy`, custo zero), ou fica só o clipe da escolhida e a outra faixa continua
existindo apenas como `.mp3`? As duas leituras cabem no que foi pedido e mudam o
que sai do fluxo.

Nomear `a`/`b` e não `1`/`2` é de propósito: `2` já significa "dois clipes", e
`musica: <ref> 2` seria ambíguo entre "a faixa 2" e "dois clipes".

Ordem sugerida: esta forma primeiro — é a mais barata de implementar e a que
evita render errado, que é o prejuízo de verdade.

Nota: (c) é a mesma peça do item 1 deste documento (reprovar no portão) vista de
outro ângulo — em ambos, o portão precisa aceitar uma RESPOSTA além do sim.


## 5. Corrigir a música — ou mandar a sua (pedido de 2026-08-22)

Mesmo pedido do item 1, na fase onde ele aparece primeiro. As duas metades já
existem **dentro do domínio**; o que falta é o comando no chat.

**Corrigir e refazer.** `musicavideo ajusta <slug> musica "<instrução>" [--refaz]`
(`planner.ajustar_parte`) reescreve a seção `musica` do plano com a instrução,
valida contra o registry e — com `--refaz` — regera a faixa. Já respeita a regra
que importa: letra marcada `final_usuario` é IMUTÁVEL e o ajuste falha se o
modelo tentar mudá-la. No chat, no molde do `capa:`:

    musica: <ref> | correcao=mais lenta, sem bateria eletronica

**Mandar a faixa pronta.** Existe `--faixa-pronta arq.mp3`, que copia o arquivo
para dentro do slug, marca `musica` como `pronto` com custo zero e não altera o
original. Mas ele é opção do `plano` — só vale na CRIAÇÃO. Mandar a sua música
DEPOIS, no portão, com o áudio anexado no Telegram (o caminho que o
`gateway/midia.ts` já monta para o `capa:`), é o que falta:

    musica: <ref>   + áudio anexado

Isso exige uma entrada nova no domínio (algo como `aprova <slug> musica
--arquivo <path>`), porque hoje a única porta para faixa de fora é a criação do
plano. É a diferença entre os dois pedidos: a correção é comando que já existe;
a faixa pronta no meio do fluxo é peça nova, pequena, no domínio.

Ordem dentro do item: correção primeiro (só chat), faixa pronta depois (chat +
domínio). Os dois têm que gravar a escolha ANTES de a fase `clipe` ler a faixa.
