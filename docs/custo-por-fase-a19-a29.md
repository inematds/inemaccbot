# Tempo, token e custo por fase — A#19 a A#29

Medido em 2026-08-06. Mesma advertência do `amostra-a23-a24-fase-reel.md`: o bot
**não registra token**, isto é arqueologia. Tempo sai do banco (confiável);
token sai dos logs de sessão do Claude Code, casados com o job.

## Método (mudou em relação à amostra anterior)

O casamento por janela de horário foi **abandonado** — foi ele que produziu, na
sessão anterior, `cache_read` idêntico em duas fases diferentes. O novo:

1. Uma sessão de agente tem **um** prompt de usuário (é o `-p` do
   `runner-claude.ts`); sessão humana tem vários. Isso já separa as duas classes.
2. O prompt injetado cita o **título do avatar do job** (`A25-jovens-v1`). O
   casamento exige esse título — substring do alvo não basta, porque as janelas
   de alvos diferentes se sobrepõem.
3. Empate entre candidatos: escolhe a sessão cujo início e duração **melhor se
   ajustam** à janela do job (não a maior — "a maior" puxava a sessão do vizinho).
4. Sessões do projeto `claude-mem-observer-sessions` são excluídas (é o
   observador, não o agente).
5. A fase `texto` não tem alvo, então o critério dela é a **assinatura do
   prompt** (`inemaclub-textos`). Sem isso o casamento pegava uma sessão de
   navegação que rodava na mesma janela — foi exatamente o que produziu o
   "outlier" do A#28 na primeira passada (5.534k de cache_read eram de um job
   de HeyGen, não de texto).
6. Job sem casamento fica **sem casamento**. Não há fallback por horário.

**Duas correções que mudaram os números na raiz:**

- **O mesmo `message.id` aparece em várias linhas do JSONL com o `usage`
  repetido.** Somar linha a linha **dobra** o token (medido num job do A#19:
  20.958 contra 10.720 reais). Toda contagem aqui é deduplicada por `message.id`.
- A fase `baixar` é `kind: function` (heygen/ffmpeg): **não gasta token nenhum**.
  Qualquer casamento de sessão com ela seria token inventado.

**Isto não reproduz as medianas publicadas em `amostra-a23-a24-fase-reel.md`**
(A#19 22,7k contra 31,2k aqui) — e a diferença **fica sem explicação**:

- não é a duplicação por `message.id`: corrigi-la fez os números **caírem**
  (59,5k → 31,2k) e ainda assim ficam acima dos 22,7k;
- não é o tamanho da amostra: aqui o A#19 tem n=10 e o doc antigo n=12. Mesmo
  supondo que os 2 jobs faltantes valessem zero, a mediana só cairia para 29,1k.

O que se pode afirmar deste lado: cada job do A#19 casou com **exatamente um**
candidato forte (título de avatar único, `n_cand=1`, sem ambiguidade). As duas
medições concordam na ordem de grandeza e na direção da queda; o valor absoluto
diverge e o motivo não foi encontrado.

## Cobertura

| fase | tarefa | kind | jobs | casados | sem casamento |
|---|---|---|---|---|---|
| texto | `fluxo-agente` | agent | 11 | 10 | 1 (A#28) |
| navega-avatar | `fluxo-navegador` | agent | 112 | 112 | 0 |
| reel | `reel` / `reelpromo` | agent | 122 | 104 | 18 |
| baixar | `heygen.baixar` | **function** | 102 | — | não gasta token |

O texto do A#28 não tem sessão com a assinatura `inemaclub-textos` na janela —
ficou de fora em vez de receber o número errado.

Dos 18 sem casamento no reel: **10 são do A#29** (`queued`, nunca rodaram) e 8
são jobs `done` cujo log não foi encontrado (A#19×2, A#21×4, A#22×1, A#24×1).

## Custo (US$)

Preço de tabela: sonnet 5 **2/10** por M (promocional, vigente até 2026-08-31 —
que é o período destes fluxos), opus 5 5/25, haiku 4.5 1/5. Cache read a 0,1× do
input, cache write a 1,25×.

> No preço cheio do sonnet (3/15) **todo valor de sonnet aqui é multiplicado por
> 1,5 de forma uniforme**: os dólares absolutos sobem, as proporções entre fases
> e a participação percentual não mudam.

| fluxo | texto | navega | reel | TOTAL |
|---|---:|---:|---:|---:|
| A#19 | 0,81 | 14,99 | 21,29 | 37,09 |
| A#20 | 0,45 | 1,49 | 1,40 | 3,34 |
| A#21 | 0,97 | 14,84 | 13,68 | 29,50 |
| A#22 | 0,80 | 15,61 | 21,49 | 37,90 |
| A#23 | 0,48 | 2,96 | 3,82 | 7,26 |
| A#24 | 0,83 | 15,31 | 12,97 | 29,11 |
| A#25 | 0,99 | 16,68 | 3,77 | 21,44 |
| A#26 | 0,81 | 17,28 | 2,08 | 20,17 |
| A#27 | 0,93 | 15,77 | 2,21 | 18,91 |
| A#28 | —² | 16,81 | 2,37 | 19,18 |
| A#29 | 3,07 | 14,78 | 0,19¹ | 18,04 |
| **soma** | **10,14** | **146,53** | **85,26** | **241,93** |

¹ só 2 dos 12 reels do A#29 rodaram. ² texto do A#28 sem casamento.

**A participação sobre a soma inteira é enviesada** e não deve ser citada
sozinha: o reel tem 18 jobs sem casamento (contra 0 do navega), então a coluna
do reel está subestimada por uma quantia desconhecida.

**Use o recorte de cobertura 100%** — A#26 e A#27, os únicos fluxos completos
com 12 públicos e o pipeline novo, todos os jobs casados:

| fase | US$ | participação |
|---|---:|---:|
| navega-avatar | 33,05 | **84,6%** |
| reel | 4,29 | 11,0% |
| texto | 1,74 | 4,5% |
| baixar | 0,00 | 0% |

Isso confirma o `pipeline.md`: **a navegação é o custo** (84,6%, contra os 86%
publicados lá). Sobre a soma inteira dos 11 fluxos a proporção fica mais branda
(navega 60,6%, reel 35,2%) só porque o recorte inclui os fluxos antigos, quando
o reel ainda era caro — e porque faltam jobs de reel.

## Token por job (mediana): entrada / cache_read / cache_write / saída

O `input` puro é irrelevante (dezenas de tokens). **Quem manda é cache_read** —
é o retrato de quanto contexto o agente relê a cada chamada.

### texto (1 job por fluxo)

| fluxo | cache_read | cache_write | saída | modelo |
|---|---:|---:|---:|---|
| A#19 | 1.396k | 136k | 18,9k | sonnet 5 |
| A#21 | 1.755k | 145k | 26,2k | sonnet 5 |
| A#22 | 1.888k | 74k | 24,3k | sonnet 5 |
| A#24 | 1.513k | 118k | 23,6k | sonnet 5 |
| A#25 | 1.598k | 149k | 29,7k | sonnet 5 |
| A#26 | 1.760k | 77k | 26,1k | sonnet 5 |
| A#27 | 1.841k | 121k | 26,3k | sonnet 5 |
| A#29 | 2.287k | 166k | 35,6k | **opus 5** |

(A#28 não aparece: sem casamento. Na primeira passada ele aparecia com 5.534k
de cache_read — era uma sessão de navegação capturada por engano, e foi o que
motivou a assinatura de prompt no critério.)

O **A#29 é o opus**: 2.287k de cache_read e 35,6k de saída contra ~1.800k/26k
do sonnet — US$ 3,07 contra ~US$ 0,90. **3,4× o custo da fase texto**, e a fase
inteira ainda é só ~4,5% do total. (O handoff anterior falava em US$ 5,50 × 2,41
pelo método antigo; a ordem — opus custa ~3× — se mantém.)

### navega-avatar (12 jobs por fluxo)

Notavelmente **estável**: cache_read entre 3.790k e 5.157k, saída entre 6,3k e
8,0k, em todos os 11 fluxos. Não mudou com nenhuma das reformas do pipeline —
o que é esperado, já que nenhuma delas tocou a navegação. É por isso que ela
virou a dona do custo: não caiu enquanto todo o resto caía.

### reel (12 jobs por fluxo)

| fluxo | cache_read | saída | o que rodava |
|---|---:|---:|---|
| A#19 | 6.883k | 31,2k | skill global, HTML à mão |
| A#21 | 5.580k | 27,3k | idem |
| A#22 | 6.083k | 25,4k | idem |
| A#23 | 6.340k | 25,0k | idem |
| A#24 | 2.630k | 10,0k | idem, já mais enxuto |
| A#25 | **193k** | **1,0k** | `reelpromo` + `montar-reel.py` |
| A#26 | 196k | 1,0k | idem |
| A#27 | 179k | 0,9k | idem |
| A#28 | 160k | 1,0k | idem |
| A#29 | 198k | 4,6k | idem, **haiku** |

**A queda é de 35× no cache_read e de 25× na saída**, e ela acontece
exatamente no A#25 — o primeiro fluxo com a skill do projeto e o
`montar-reel.py`. O agente deixou de escrever HTML e passou a chamar um script.

**O haiku do A#29** (2 jobs): cache_read igual ao sonnet (198k contra ~180k),
saída 4,6k contra 1,0k — **escreve ~4× mais** para fazer o mesmo. Como haiku é
5× mais barato na saída, o custo por reel empata; mas 2 jobs não decidem nada, e
falta ver se passa nos portões. **Não conclua ainda.**

## Tempo (mediana, segundos): execução / espera na fila

| fluxo | texto | navega | reel |
|---|---|---|---|
| A#19 | 252 / 1 | 315 / 1.628 | 915 / 3.184 |
| A#21 | 292 / 0 | 310 / 1.952 | 966 / 4.143 |
| A#22 | 326 / 0 | 324 / 4.965 | 938 / 9.293 |
| A#24 | 311 / 1 | 398 / 1.980 | 790 / 2.795 |
| A#25 | 360 / 0 | 314 / 2.079 | 316 / 1.972 |
| A#26 | 359 / 1 | 350 / 1.940 | 220 / 6.376 |
| A#27 | 421 / 1 | 313 / 5.667 | 201 / 3.864 |
| A#28 | 439 / 1 | 344 / 8.342 | 223 / 1.205 |
| A#29 | 653 / 1 | 282 / 1.437 | — |

Duas leituras:

- **O reel caiu de ~15 min para ~3,5 min de execução** (915s → 220s), na mesma
  fronteira A#24/A#25. Bate com a queda de token: o que sumiu foi conversa.
- **A espera na fila domina o relógio de parede.** No A#22 um reel esperou
  9.293s (2h35) para rodar 938s. Com `render` serializado em 1 e 12 públicos por
  fluxo, o gargalo do tempo total **não é o agente**. Quem quiser encurtar o
  fluxo mexe na concorrência da fila, não no prompt.
- O tempo do texto **subiu** de 252s para 653s — mas A#29 é opus, e opus pensa
  mais. Nos sonnets a subida é suave (252 → 439).

## Ressalva de método sobre TEMPO (achada em 2026-08-06)

**`jobs.iniciado_em` não é reescrito quando o job é reclamado de novo.** Um job
que foi enfileirado, esperou, foi requeued (poll, restart, falha) e só então
rodou carrega o carimbo da PRIMEIRA reclamação — então
`terminado_em - iniciado_em` inclui a espera, não só a execução.

Isso enganou duas vezes no mesmo dia:

- **o job 582** (A#29/40mais/reel) chegou a `running` já com 6.623s acumulados
  de uma tentativa da véspera, e o vigia de 120 min quase o matou por um prazo
  que ele nunca gastou;
- **os cinco primeiros reels do A#30** apareceram com 1.348s a 1.998s, o que
  levou à conclusão errada de que a fase de reel como função tinha ficado 6×
  mais lenta. Os horários de disparo no journal mostram a verdade: **205s, 110s,
  160s, 200s, 180s** — mediana 180s, contra 220s do caminho de agente.

**Toda coluna de tempo deste documento herda esse viés para cima**, na medida em
que os jobs tenham sido requeued. Onde o número importa, confira o disparo no
journal (`reel.montar: <alvo> disparado`) em vez de subtrair as duas colunas.

## Ressalvas herdadas

- **A#24 não serve como medida limpa de tempo** — a máquina estava disputada com
  renders de teste (registrado em `amostra-a23-a24-fase-reel.md`).
- **A#20 e A#23 têm 1 e 2 públicos** — as medianas deles são anedota.
- **A#25/40mais ficou `failed`** (o render que o restart matou) e nunca foi refeito.
- **O A#25 tem 22 jobs de reel para 12 públicos** — houve refação; as medianas
  incluem as duas passadas.
