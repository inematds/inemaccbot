# Conversas abertas — retomar em 2026-08-03

Duas discussões que ficaram em pé no fim do dia 02/08. Nada aqui foi decidido;
é material para conversar, com o que já foi medido separado do que é palpite.

---

## Assunto 1 — Layout do reel, templates e imagens

### Quem define o layout: três camadas, e confundi-las é o erro comum

| camada | onde | manda em | alcance |
|---|---|---|---|
| **skill** | `~/.claude/skills/reel-edita-inema/` | esqueleto de 3 faixas (topo/meio/base), 1080×1920, paleta (`estilo.md`: base `#0E1116`, âmbar `#F5A623`), legenda na altura do peito, beat ≤4s, CTA fixo, catálogo de receitas R1–R5 | **global** — muda TODO reel, inclusive os disparados no chat |
| **domínio** | `flow.json` → fase `reel` → campo `entrega` | o que ESTE pipeline pede: os quatro gatilhos, headline a partir do `{gatilho}` do público, `{fecho}` por tipo, marcadores `{legenda}`/`{cta}` | só este fluxo, **congelado na criação** |
| **agente** | na hora do render | escolhe/combina a receita, decide o gancho do topo, o ritmo | por vídeo |

O `entrega` do promoavatar3 hoje começa com "capa impacto" — é ele, não a skill
sozinha, que dá a cara atual dos reels.

### Mais de um template: já existem cinco, o que falta é ESCOLHER

R1 headline-choque (default) · R2 imagem-manchete · R3 explicativo-forte ·
R4 painel visual · R5 número. Hoje quem escolhe é o agente, e a skill manda
"não repita molde". Quatro formas de tornar a escolha explícita:

1. **Por público, no `flow.json`** — zero código. Campos do alvo já viajam para
   o prompt (é assim que `canal` e `gatilho` chegam): bastaria `"template": "R2"`
   no alvo e citá-lo no `entrega`. `jovens` com imagem-manchete, `60mais` com
   headline-choque.
2. **Receita nova na skill** (`references/04-recetas.md`) — também zero código; o
   catálogo é declaradamente aberto.
3. **Flag no comando** (`| template=R2`) — mudança pequena no bot, igual à
   `| legenda`. Vale se a escolha for no envio, não no arquivo.
4. **Fluxo separado** — só se o `entrega` inteiro mudar.

Começar por 1 e 2 cobre "mais de um template" sem tocar em código.

### Imagens: quem define, e onde estão os ganhos

Quem escreve o prompt de cada imagem é o **agente**, na hora, a partir das
SOBREPOSIÇÕES/gatilho. Chama `scripts/gen-imagem.py` → **inemaimg local**.
Não há prompt de imagem escrito em lugar nenhum.

Ganhos, em ordem de impacto:

1. **`steps 4` é muito baixo** (default do script, herdado do flux2-klein). 20–30
   muda a qualidade visivelmente. É um parâmetro.
2. **Modelo melhor disponível**: o inemaimg tem `flux2-klein`, **`flux2-dev`**,
   `ernie`, `qwen-edit-2511`. Custo: tempo de GPU.
3. **`seed 7` fixo em tudo** — de propósito (determinismo), mas faz tudo nascer
   da mesma semente. Variar por alvo/segmento dá variedade sem perder
   reprodutibilidade.
4. **O prompt da imagem podia vir do DOMÍNIO.** A fase de texto já escreve as
   SOBREPOSIÇÕES por alvo; podia escrever também uma linha de prompt de imagem
   por segmento. Aí a imagem é decidida por quem conhece o público e **revisada
   no portão**, em vez de improvisada no render. É o item que mais muda o
   resultado, e o único que dá controle real.
5. **A imagem nasce quadrada e vai para faixa horizontal** — o script não manda
   proporção. Gerar já no formato do topo evita corte ruim.

**Teste barato proposto:** mesma imagem em `klein/4 steps` (hoje) × `dev/28
steps`, lado a lado. Minutos de GPU, zero dinheiro.

---

## Assunto 2 — A fase de navegação do promoclub gasta muito token

### O que foi MEDIDO (logs de sessão)

Classificado por marcador duro — a skill de fato invocada (`Launching skill: …`)
e as tools de navegador (`mcp__claude-in-chrome__*`), não por palavra no texto.

| fluxo | fase | sess | entrada | saída | cache escrito | cache lido | TOTAL | mediana/sessão |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| promoclub | **avatar (NAVEGAÇÃO)** | 50 | 24.601 | 5.416.187 | 40.429.831 | 2.435.630.775 | **2.481.501.394** | 25.477.568 |
| promoclub | reel* | 2 | 2.780 | 1.223.544 | 15.996.458 | 616.901.675 | 634.124.457 | 317.062.228 |
| promoclub | texto | 39 | 2.833 | 1.605.167 | 8.656.371 | 59.685.985 | 69.950.356 | 1.465.738 |
| nossos | **reel** | 93 | 18.294 | 5.666.321 | 29.633.492 | 1.048.000.315 | **1.083.318.422** | 10.973.546 |
| promoavatar | texto | 10 | 432 | 104.929 | 1.873.736 | 14.554.369 | 16.533.466 | 1.910.659 |
| promoavatar3 | texto | 6 | 265 | 179.961 | 1.158.348 | 9.956.421 | 11.294.995 | 1.356.910 |

**Cache é quase tudo:** 98% do total na navegação, 96% no reel. Cache lido é
~10× mais barato que token novo, então o custo em dinheiro é bem menor que o
bruto — mas o número também é sintoma: contexto enorme relido a cada passo.

**\* Cuidado com a linha do reel do promoclub: unidade diferente.** São 2
sessões porque uma delas ficou **75 horas viva, com 1.404 mensagens** — uma
conversa de três dias, não um vídeo. Ali o custo por mensagem cresceu de 57 mil
para 778 mil tokens (13,6×) conforme o contexto acumulava. Não é comparável com
as nossas.

**A unidade dos NOSSOS reels é o vídeo:** 91 pastas distintas em
`~/projetos/output/reels/<slug>` para 93 sessões — mediana de 1 sessão por
vídeo, ~11 milhões de tokens cada, 98 mensagens, 12 min. Um fluxo C# de 36
alvos gasta ~**400 milhões** só na fase de reel.

**O desenho "um job = uma sessão" é o que nos protege** da bola de neve que
custou 632 milhões no promoclub. Não foi escolhido pensando em token, mas é o
efeito — vale registrar como propriedade, não como sorte.

### O que NÃO foi medido, e é o ponto da conversa

**A fase de navegação nunca rodou.** Zero jobs `fluxo-navegador` no banco, zero
fluxos promoclub criados. Então não há número dela — só analogia:

- ela dirige o estúdio por screenshots, e imagem custa caro em token;
- o vizinho mais próximo medido é o reel (11,5 mi por execução), que também
  olha frames de vídeo;
- palpite honesto: **mesma ordem de grandeza**, com 12 públicos = dezenas de
  milhões, para um trabalho que a rota `| creditos` (OAuth) faz com **zero**
  token de LLM.

Ou seja: a conversa "a navegação gasta muito" provavelmente já está resolvida
pela rota de créditos — mas vale medir uma execução antes de sepultar a fase.

### Ideias levantadas (não implementadas)

- **Script determinístico (Playwright) no lugar do agente.** Padroniza e tira o
  custo de LLM da navegação. Perde a adaptação a mudança de layout — que é
  justamente o que o agente compensa hoje.
- **Não regenerar o avatar a cada geração de conteúdo** (ponto do Nei). Reusar
  um avatar já gerado quando o texto não muda, em vez de pedir um novo. Encaixa
  na trava que já existe na rota de API ("procure antes de criar"), e valeria
  também para créditos.
- Vale perguntar: **o reel precisa mesmo de 11 mi de tokens por vídeo?** É o
  maior consumo do pipeline por uma margem enorme, e ninguém olhou para ele
  ainda — o custo estava escondido atrás de "é o agente que faz".

### PROPOSTA PRINCIPAL do reel: template parametrizado + QC determinístico

O custo não é o que o modelo escreve (0,5% do total) — é o contexto **relido a
cada uma das 98 mensagens**. Então o alvo é cortar idas e voltas, não texto.

1. **Template parametrizado.** O agente emite um JSON pequeno (beats, textos,
   caminhos de imagem, tempos) e um script determinístico monta o HTML do
   Hyperframes. Some do contexto a timeline inteira E o loop
   `lint → corrige → lint`. Template versionado não tem erro de sintaxe a
   corrigir toda execução. De brinde: "mais de um template" vira escolha por
   público, e o determinismo que a skill exige (sem `Math.random`, seed fixo)
   deixa de depender da disciplina do agente.
2. **QC determinístico primeiro.** `lint-timeline` + `verify-cut` + `ffprobe`
   custam ~zero; `/watch` traz frames como imagem, e imagem é cara. Olhar com os
   olhos só quando o determinístico acusar.
3. Carregar só a receita escolhida (hoje são 12 arquivos de referência, e o que
   entra no contexto fica lá até o fim).
4. Revisor recebe só os artefatos (transcript + lint do render final), não o
   histórico da montagem.
5. Agrupar passos de shell num script: cada chamada é uma mensagem, e cada
   mensagem custa ~113 mil tokens.

**O contra-argumento, para não vender fácil:** a skill hoje manda "não repita
molde" e "que não pareça feito por IA". Template padrão empurra na direção
oposta — o contrapeso é ter 3–5 templates com variação real dentro deles
(imagem, headline, ritmo vindo da fala), em vez de um só.

**O que NÃO some com template:** sincronizar com a fala (mas isso é conta sobre
o transcript word-level, não julgamento), gerar as imagens, e um QC mínimo.

**Como medir sem apostar:** refazer UM reel já feito com template fixo e QC
determinístico, e comparar contra a linha de base medida — 98 mensagens · 113
mil tokens/mensagem · 11 milhões no total. Se as mensagens caírem para 40–50, a
conta se resolve sozinha. Nenhuma dessas mudanças toca o bot: todas são a skill
`reel-edita-inema`.

**Modelo:** assunto encerrado por ora. Fica só o dado, porque muda a intuição —
o reel já roda em **`sonnet`/esforço `low`** (a skill não declara modelo, cai no
padrão), então não há gordura de "está usando opus à toa".

---

## Estado do que ficou pronto ontem (contexto, não pauta)

- `| api` (carteira US$) e `| creditos` (OAuth/CLI) implementadas, mutuamente
  exclusivas; `| sem-portao` independente das duas.
- Motor explícito `avatar_iii` no domínio — evita o default Avatar IV, 3–4× mais
  caro.
- **Falta o teste de lote**: `/promoavatar3 <assunto> | alvos=jovens-alc,`
  `jovens-aut,jovens-pro | creditos` (3 créditos dos 499).
- A rota `| api` nunca fez chamada real; carteira em US$ 0,22.

---

## Assunto 3 — dar uma geral no `promoavatar3` (anotado em 2026-08-04)

**Decisão do dono:** primeiro acertar o `promoavatar` inteiro; **depois** revisar
o `promoavatar3` com o mesmo tratamento. Não fazer os dois em paralelo.

O que o `promoavatar` recebeu e o `promoavatar3` **ainda não tem**:

| item | promoavatar | promoavatar3 |
|---|---|---|
| portão depois do download | ✅ | ✅ (única coisa já aplicada) |
| seção `## IMAGENS` por segmento (regra 11b) | ✅ | ❌ |
| templates de layout (`templates/*.json`) | ✅ 4 | ❌ |
| mapa `formato editorial → layout` | ✅ | ❌ |
| `entrega` mandando usar `preparar.py`/`montar.py` | ✅ | ❌ |

Cuidados para a revisão, aprendidos no `promoavatar`:

1. **`definicao_json` é snapshot por fluxo** — nada disso alcança fluxo já
   criado. Testar exige fluxo novo.
2. **A skill é lida ao vivo**; o `entrega` não. Mudança em
   `~/.claude/skills/reel-edita-inema/` vale para TODOS os domínios na hora —
   inclusive o promoavatar3 — enquanto o `flow.json` só vale para fluxo novo.
   Isso já aconteceu: os reels do A#21 usaram o `preparar.py` sem que o
   `entrega` deles pedisse.
3. **O promoavatar3 usa 3 públicos "jovens-*"** (`jovens-alc`, `jovens-aut`,
   `jovens-pro`) e a rota `| creditos`, não a `| navega`. O mapa de layouts pode
   fazer menos sentido com públicos tão próximos — vale checar se os formatos
   editoriais realmente variam entre eles antes de copiar o mapa.
4. **Nunca espalhar mudança de comportamento sem pedido.** O portão só entrou
   aqui porque foi pedido explicitamente; o resto espera.

---

## Assunto 4 — Notificar cada fase concluída no chat (sugestão, 2026-08-04)

**Pedido do dono, durante o A#23:** hoje o chat avisa nos portões e no fim. Quem
acompanha um fluxo fica sem saber quando uma fase intermediária fecha — no A#23
os avatares dos dois públicos ficaram prontos e só se descobriu consultando o
banco. A sugestão é **notificar a cada fase realizada**, não só nos portões.

Onde isso encosta no código:

- `jobs.notificado_em` já existe e é a trava de "avisou uma vez só"
  (`src/fila/store.ts:312`), com varredura de recuperação para mensagem que se
  perdeu (`src/fila/worker.ts:229`). O mecanismo está pronto; o que falta é
  **quando** disparar.
- Hoje o aviso sai por job terminal e nos pontos de `pausa_apos`. Uma fase de
  escopo `alvo` gera N jobs (um por público), então "fase concluída" para o
  usuário é o **conjunto**, não o job — notificar por job daria 2 mensagens por
  fase com 2 públicos, e 12 com 12.

Decisões que precisam ser tomadas antes de implementar:

1. **Granularidade:** por job (`A#23/jovens/navega-avatar feito`) ou por fase
   agregada (`A#23 · navega-avatar: 2/2 feitos`)? Com 12 públicos a primeira
   vira spam — provavelmente agregada, com uma linha só quando o último alvo
   fecha.
2. **Opt-in ou padrão?** Um `| verboso` no comando, ou sempre. Fluxo de 12
   públicos × 4 fases = 48 eventos se for por job.
3. **O que a mensagem carrega:** só o nome da fase, ou o dado útil (qual
   template resolveu, quantas imagens saíram, custo parcial).

Não implementado — está aqui como sugestão registrada, não como decisão.

## Achado ao verificar o A#23: o snapshot não congela o template

`definicao_json` do fluxo 23 tem as chaves `alvos, avatar_id, engine, fases,
nome, prefixo, versao_def, voice_id` — **não** `template` nem `templates_dir`,
que existem no `flow.json` do repo.

Hoje não quebra: o `preparar.py` acha o `flow.json` do repo sozinho (mudança de
2026-08-04). Mas quer dizer que **o layout de um fluxo não é reproduzível pelo
snapshot** — se o `template` padrão da raiz mudar no repo, refazer um fluxo
antigo pode sair com outro layout, e o snapshot não denuncia. O `entrega` (que
descreve todo o pipeline) É congelado; a config de layout não.

Conferido no A#23: o `entrega` congelado já traz `montar-reel.py` e as decisões
de SFX/legenda/revisor — o fluxo nasceu com tudo de 2026-08-04.
