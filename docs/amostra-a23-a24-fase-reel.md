# Fase reel: custo e tempo até o A#24 — a linha de base antes da skill do projeto

Medido em 2026-08-04, **depois** de todas as mudanças do dia e **antes** de
qualquer fluxo passar por elas. É esta a linha contra a qual o primeiro fluxo
com `reelpromo` deve ser comparado.

> **De onde vieram os números.** O bot **não** registra token — vale o mesmo
> aviso do A#4 e do A#18: isto é **arqueologia, não instrumentação**. Tempo sai
> do banco (`jobs.iniciado_em`/`terminado_em`, confiável). Token sai dos logs de
> sessão do Claude Code, casados **pelo título do avatar** (`A23-jovens-v1`),
> que é único por job. Ver "Como o casamento foi feito" no fim — a primeira
> tentativa saiu contaminada e é útil saber como.

## Token de saída por reel (mediana)

| fluxo | n | mediana | o que rodava |
|---|---|---|---|
| A#4 | 1 | 73,4k | HTML à mão, sem scripts |
| A#9 | 12 | 73,4k | idem |
| A#10 | 12 | 43,6k | |
| A#11 | 12 | 52,8k | |
| A#16 | 11 | 52,8k | |
| A#19 | 12 | **22,7k** | primeiros scripts (`preparar.py` na skill global) |
| A#21 | 12 | 15,7k | |
| A#22 | 12 | **12,8k** | menor medido |
| A#23 | 2 | 53,7k | ⚠️ |
| A#24 | 10 | 18,3k | |

O A#4 bate com o número publicado em `promoavatar/docs/pipeline.md` (73.372
tokens de saída na etapa 5), o que dá alguma confiança ao método.

**A queda de 73k → 12,8k é real e é dos scripts**, não das mudanças de hoje: o
A#19 em diante já usava `preparar.py`/`montar.py` (as cópias da skill global).

**O A#23 (53,7k) destoa e não sei explicar.** Dois públicos só, e um deles
gastou 53,7k contra 15,0k do outro. Não é o pipeline novo — o A#23 usou o
caminho antigo, como o A#24. Fica registrado como não explicado; suspeitar de
contaminação do casamento antes de tirar conclusão.

## Tempo de execução por reel (minutos)

| fluxo | n | média | mín | máx | falhas |
|---|---|---|---|---|---|
| A#19 | 12 | 15,8 | 5,8 | 31,5 | 0 |
| A#21 | 12 | 19,7 | 11,6 | 41,3 | 0 |
| A#22 | 12 | 15,9 | 11,1 | 29,9 | 0 |
| A#23 | 2 | 22,8 | 20,3 | 25,2 | 0 |
| A#24 | 11 | **72,3** | 4,8 | **262,4** | **3** |

O tempo mede execução do job, **não** espera na fila (`render` = 1 por vez).

**O A#24 não serve como medida limpa e o motivo é meu:** enquanto ele rodava, eu
executei três renders de teste do Hyperframes na mesma máquina (6 workers de
Chrome cada) mais geração de imagens no inemaimg. A máquina estava disputada. O
máximo de 262 min e duas das três falhas (uma por *"render não terminou em 120
min"*) são consistentes com contenção, não com defeito do pipeline. Registrado
como aviso de método: **não medir tempo de fluxo enquanto se trabalha na
máquina.**

## O que esta amostra NÃO prova

Nada sobre as mudanças de 2026-08-04. **Nenhum fluxo passou pelo caminho novo**
(`reelpromo` → skill do projeto → `montar-reel.py`): o A#23 e o A#24 foram
criados antes e têm a definição congelada. O que se espera do próximo fluxo, e
que esta linha de base permite verificar:

- **token deve CAIR** — some o loop de escrever/lintar HTML à mão, e o QC vira
  um mosaico em vez de ~10 frames relidos a cada mensagem;
- **tempo deve ficar parecido** — o render é o mesmo; o que sai é conversa, não
  processamento;
- **`template: None` deve sumir** do manifesto — é o sinal mais barato de que o
  caminho certo foi usado.

## Como o casamento foi feito (e o erro que quase passou)

A primeira tentativa casou sessão por **horário** e pegou a maior sessão dentro
da janela. Deu valores **idênticos** em fluxos diferentes (719,9k e 893,6k
repetidos) — o sintoma de que estava somando *uma* sessão humana que cita vários
avatares, não a do agente.

O conserto: casar por título do avatar **e descartar qualquer sessão que cite
mais de um título** — sessão que fala de vários reels é humana; o agente monta
um. Restou um outlier não resolvido (A#7, 878,7k), provavelmente pelo mesmo
motivo, e por isso o A#7 não entra nas conclusões.
