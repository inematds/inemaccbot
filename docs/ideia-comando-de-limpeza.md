# Ideia: comando de limpeza dos vídeos produzidos

Anotação para revisar depois. **Nada aqui está implementado.**

## Por que precisa

Medido em 2026-07-31:

| pasta | tamanho | o que é |
|---|---|---|
| `~/projetos/output/reels` | **25 GB** (274 diretórios) | saída das skills de reel — previews, frames, renders intermediários |
| `state/artefatos/explicativo` | 65 MB | 1 vídeo |
| `state/artefatos/reel` | 39 MB | 1 vídeo |
| `state/artefatos/fluxos` | 15 MB | avatares baixados + os `.txt` de fase |
| **disco** | **3,1 T de 3,7 T — 89% cheio, 402 GB livres** | |

O `output/reels` sozinho é 25 GB, e cresce a cada job. Um render deixa para trás
bem mais que o MP4 final: no A#4 sobraram `preview.mp4`, `preview2.mp4`,
`preview3.mp4`, mais `motion/renders/` com duas versões do final e um
`.mp4.log` de 26 KB.

E a partir de agora **duplica**: o `publicarVideo` copia o final de
`state/artefatos/` para `output/reels/` com o nome do título, para o link
funcionar. Cópia é a decisão certa (a fonte canônica do bot não pode sumir), mas
significa dois arquivos por reel.

## O que o comando precisaria distinguir

Esta é a parte difícil, e é por isso que vale pensar antes de escrever:

1. **O final publicado** (`output/reels/A4-mulheres-v1.mp4`) — é o que o link do
   chat aponta. Apagar isso quebra um link que a pessoa pode abrir semanas
   depois.
2. **O artefato canônico** (`state/artefatos/reel/9.mp4`) — é o que o `/status`
   conhece e o que o `resultado` do job aponta. Apagar isso faz o bot mentir:
   ele diz onde está um arquivo que não existe mais. (O `planejarEntrega` já
   trata esse caso — "o job terminou, mas o arquivo não está lá" — então falha
   de forma honesta, mas ainda assim é perda.)
3. **O lixo do pipeline** (`preview*.mp4`, frames, renders intermediários) — é
   o grosso dos 25 GB e não serve para nada depois que o job fecha. **É o alvo
   óbvio.**
4. **Vídeo de fluxo cancelado ou falhado** — o A#1, A#2 e A#3 morreram; o que
   sobrou deles não interessa a ninguém.

## Desenhos possíveis

**A — `/limpar` no chat, com confirmação.** Segue os verbos que já existem
(`/fila`, `/status`, `/cancelar`). Mostraria quanto libera antes de apagar, e
exigiria um segundo comando para confirmar — apagar 25 GB por engano num
comando de uma palavra é o tipo de coisa que não tem volta.

**B — retenção automática por idade.** "Lixo de pipeline com mais de N dias
some." Sem comando, sem confirmação, roda no boot ou num timer. Mais seguro se
mexer SÓ na categoria 3.

**C — os dois.** Retenção automática para o lixo, comando manual para o resto.

Inclinação: **C**, com a automática entrando primeiro (é a que resolve os 25 GB
e é a que não corre risco de apagar coisa que alguém quer).

## A decidir antes de escrever

- **Quanto tempo guardar o vídeo final?** É a única pergunta que importa de
  verdade — o resto é lixo e pode ir embora rápido.
- **Apagar por fluxo (`/limpar A#4`) ou por idade?** Por fluxo casa com os
  outros comandos; por idade não precisa de ninguém lembrar.
- **O comando fala com o `output/reels` das skills?** Aquela pasta não é do bot
  — é a convenção das skills de reel, e outras coisas escrevem lá. Apagar
  dentro dela é o bot mexendo em casa alheia.
- **`/fila` já mostra tamanho?** Não. Um `/espaco` (ou uma linha no `/fila`)
  dizendo quanto cada pasta ocupa tornaria a limpeza uma decisão informada em
  vez de um chute.

## Ligação com as outras anotações

`docs/ideias-custo-de-token.md`, item 3.1: reduzir os renders de preview de 3
para 1 ataca o mesmo problema pela origem — menos lixo gerado é melhor que mais
lixo apagado, e ainda economiza token.
