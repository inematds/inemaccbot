# Ideia: deixar o `/fila` legível

Anotação para revisar depois. **Nada aqui está implementado.**

## O que aconteceu

O `/fila` mostrou:

```
13 reel — /home/nmaldaner/projetos/inemaccbot/stat… (18m)
```

E a pergunta foi: **"o que é 13 reel?"**

Era o `A#6/jovens/reel` — a última fase do fluxo do público `jovens`. A
informação existe no banco (`jobs.flow_ref`), só não vai para a tela.

Com 12 reels na fila, essa linha apareceria **doze vezes praticamente igual**,
mudando só o número. Não haveria como saber qual público é qual, nem qual
cancelar se um travasse.

## As duas mudanças

**1. Prefixar o id.** `j13` em vez de `13` — deixa claro que o número é
identificador de job, e não parte do nome da tarefa. Também separa visualmente
do id de FLUXO, que já usa outra forma (`A#6`). Hoje "13" solto no começo da
linha se confunde com contagem.

**2. Mostrar o `flow_ref` quando existir.** É o que responde "de quem é isto":

```
j13 reel · A#6/jovens — state/artefatos/reel/13.mp4 (18m)
```

Job avulso (sem fluxo) continua sem a parte do meio.

## Detalhes que valem pensar juntos

- **O caminho truncado (`…/stat…`) não serve para nada** no meio da linha. O que
  identifica é a tarefa e o fluxo; o caminho só importa no fim, e o `/status`
  já o mostra inteiro. Talvez saia daqui.
- **Ordenar por quê?** Com 12 reels, ver primeiro o que está `running` e depois
  a fila de espera é mais útil que ordem de id.
- **Quantos mostrar?** A etapa 4 já pôs teto nas consultas do painel. Com 12
  alvos a lista fica longa — vale conferir se o teto atual corta algo relevante.

## Ligação

`docs/ideia-comando-de-limpeza.md` levanta a mesma família: falta um `/espaco`
(ou uma linha no `/fila`) dizendo quanto o disco está ocupando. Se o `/fila` for
mexido, é a hora de resolver os dois.
