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

### O que foi MEDIDO (logs de sessão, 01–02/08)

Consumo por execução de agente, agrupado pelo diretório onde o job rodou:

| fase | sessões | total | **média por execução** |
|---|---|---|---|
| **reel** | 77 | 883,7 mi tokens | **11,5 milhões** |
| **texto** (domínio) | 14 | 75,1 mi tokens | **5,4 milhões** |

Ordem de grandeza: um fluxo C# de 36 alvos gasta ~**400 milhões de tokens** só
na fase de reel. O texto, que parece o trabalho "grande", é menos da metade de
UM reel.

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
- Vale perguntar: **o reel precisa mesmo de 11,5 mi de tokens por vídeo?** É o
  maior consumo do pipeline por uma margem enorme, e ninguém olhou para ele
  ainda — o custo estava escondido atrás de "é o agente que faz".

---

## Estado do que ficou pronto ontem (contexto, não pauta)

- `| api` (carteira US$) e `| creditos` (OAuth/CLI) implementadas, mutuamente
  exclusivas; `| sem-portao` independente das duas.
- Motor explícito `avatar_iii` no domínio — evita o default Avatar IV, 3–4× mais
  caro.
- **Falta o teste de lote**: `/promoavatar3 <assunto> | alvos=jovens-alc,`
  `jovens-aut,jovens-pro | creditos` (3 créditos dos 499).
- A rota `| api` nunca fez chamada real; carteira em US$ 0,22.
