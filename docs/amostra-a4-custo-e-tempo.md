# Amostra A#4 — onde vai o tempo e o token num fluxo completo

Medição de **um** fluxo `promoavatar` que rodou inteiro em 2026-07-31, do assunto
ao reel entregue. Não é benchmark: é uma amostra de tamanho 1, colhida de um
caso real com o serviço no ar.

Serve para responder três perguntas que estavam no escuro: **quanto custa**,
**onde o tempo é gasto**, e **que parte de cada fase é LLM, é IA-não-LLM, ou não
tem IA nenhuma**.

> **De onde vieram os números.** O bot NÃO registra token nem separa tempo de
> agente de tempo de render — a tabela `jobs` só tem `iniciado_em` e
> `terminado_em`. Os tokens foram lidos dos logs de sessão do Claude Code
> (`~/.claude/projects/-home-USUARIO/*.jsonl`), casados com os jobs pelo
> horário de início. Os tempos de render vieram de
> `state/artefatos/reel/9.mp4.log`. Ou seja: **isto é arqueologia, não
> instrumentação.** Repetir a medição exige refazer o mesmo cruzamento à mão.

---

## O fluxo medido

`promoavatar` A#4, 1 público (`mulheres`), assunto "INEMA Agentes HUB V".
Três fases, três jobs, status final `feito`.

| job | fase | fila | duração | resultado |
|---|---|---|---|---|
| 7 | `texto` | texto | **2 min 45 s** | 12 arquivos `.md` |
| 8 | `baixar` | io | **3 s** | `A4-mulheres-v1.mp4` (15 MB) |
| 9 | `reel` | render | **21 min 34 s** | `9.mp4` (39 MB, 32,4 s de vídeo) |
| | | **total** | **~24 min 20 s** | |

---

## A descoberta principal: o render é 4% do tempo

O job do reel levou 21 min 34 s. Dentro dele, o `hyperframes render` que produziu
o MP4 final levou **50,8 segundos**:

| etapa do render | duração |
|---|---|
| processamento de áudio | 0,9 s |
| calibração de captura | 3,3 s |
| captura de 972 frames | 33,5 s |
| encode | 10,1 s |
| montagem final | 1,0 s |
| **total do render** | **50,8 s** |

972 frames · 30 fps · 1080x1920 · 4 workers · captura por screenshot (o Chrome
do sistema não expõe o caminho otimizado — ver "Achados" abaixo).

Ou seja:

```
job 9 = 21 min 34 s
├── agente (LLM + ferramentas)  ~20 min 43 s   96%
└── render determinístico          50,8 s       4%
```

**A intuição de que "render de vídeo demora" está errada aqui.** O que demora é
o agente decidindo o que renderizar. Isso muda onde vale otimizar: mexer em
qualidade/resolução do render mexe em 4% do tempo.

---

## Tokens

| job | mensagens | output | input | cache read | cache write |
|---|---|---|---|---|---|
| 7 (`texto`) | 36 | 16.525 | 72 | 2.602.404 | 147.722 |
| 9 (`reel`) | 146 | 73.372 | 292 | 18.065.325 | 346.049 |
| **A#4 inteiro** | **182** | **89.897** | **364** | **20.667.729** | **493.771** |

Modelo: `claude-sonnet-5`, esforço `low` nos dois (o perfil padrão das skills).

Três coisas que esses números dizem:

1. **O reel custa ~4,4x o texto em output**, e é uma fase por público. Num fluxo
   de 12 públicos, o texto continua sendo 1 job e o reel vira 12 — a conta não
   cresce igual nas duas pontas.
2. **O cache read domina tudo**: 20,7 milhões contra 90 mil de output. É o
   agente relendo o contexto a cada uma das 182 idas e voltas. É também a parte
   mais barata por token, mas é onde o volume está.
3. **Input real é irrisório** (364 tokens). Praticamente tudo que entra vem de
   cache.

---

## Fase por fase: LLM, IA-não-LLM, e sem IA

### Fase 1 — `texto` (2 min 45 s, 16.525 tokens de output)

| parte | natureza |
|---|---|
| Escrever os roteiros por público | **LLM** (sonnet/low, via skill `inemaclub-textos`) |
| Adaptar gancho e CTA ao gatilho do público | **LLM** |
| Gravar os `.md` e fazer `git commit` | **sem IA** |

Fase quase inteiramente LLM. O trabalho é texto, então isso é esperado.

### Fase 2 — `baixar` (3 s, zero token)

| parte | natureza |
|---|---|
| Consultar a API do HeyGen e casar pelo título | **sem IA** |
| Baixar o MP4 | **sem IA** |

`kind: function` — não passa por agente nenhum. É código, e por isso são 3
segundos. (O avatar em si foi gerado pelo HeyGen, que usa IA — mas fora do bot,
por uma pessoa, e não entra nesta conta.)

### Fase 3 — `reel` (21 min 34 s, 73.372 tokens de output, 65 comandos de shell)

Ferramentas que o agente chamou, contadas no log da sessão:

| ferramenta | chamadas | natureza |
|---|---|---|
| `hyperframes` | 16 | **sem IA** — HTML → frames → MP4, determinístico |
| `python` (scripts da skill) | 26 | **sem IA** na maioria (montagem, cortes, timing) |
| `ffmpeg` | 10 | **sem IA** — corte, mix, ducking, encode |
| `ffprobe` | 3 | **sem IA** — leitura de metadados |
| `whisper` | 2 | **IA, não LLM** — ASR do áudio do avatar |
| `groq` | 2 | **IA, não LLM** — onde o Whisper roda |
| `gen-imagem` | 2 | **IA, não LLM** — flux2-klein, difusão texto→imagem |
| `make-sfx` | 1 | **sem IA** — efeitos sonoros |
| `curl` | 3 | **sem IA** |

Mais 11 `Read`, 1 `Write`, 2 `Skill` e **2 subagentes** (`Agent`) — estes últimos
são LLM adicional que não aparece separado na conta de tokens acima.

Repartição:

- **LLM:** escrever a headline-choque a partir do gatilho do público; decidir a
  segmentação (onde troca a imagem do topo, quais palavras viram destaque
  âmbar); escolher onde entram os SFX; escrever os prompts das imagens; montar
  a composição Hyperframes. **É aqui que estão os 96% do tempo.**
- **IA, não LLM:** Whisper/Groq transcrevendo o avatar (é o que permite corte de
  silêncio e legenda palavra-a-palavra sincronizada); flux2-klein gerando as
  imagens da capa, com seed fixo.
- **Sem IA:** Hyperframes/Remotion e FFmpeg. A skill exige determinismo
  explícito — sem `Math.random()`, sem `Date.now()`, `repeat` finito, timelines
  `paused`. Mesmo material entra, mesmo vídeo sai.

---

## Achados que valem virar tarefa

**1. O render usa o caminho lento do Chrome.** O log avisa:

```
Using system Chrome at /snap/bin/chromium; HeadlessExperimental.beginFrame is
unavailable in regular Chrome builds, so the perf-optimized capture path falls
back to screenshot mode.
Install chrome-headless-shell for the optimized path.
```

A captura (33,5 s dos 50,8 s) está em modo screenshot. Instalar
`chrome-headless-shell` deve encurtar isso. **Mas é otimizar 4% do tempo** —
prioridade baixa, registrado para não se perder.

**2. A composição tem avisos de GSAP.** Dezenas de
`overlapping_gsap_tweens` — tweens de opacidade se sobrepondo em `#w1`, `#w3`,
`#w4`, `#w5`, `#w14`… São as palavras da legenda. Não quebrou o render, mas é
animação disputando o mesmo elemento; pode produzir piscada.

**3. O bot não mede nada disto.** Para repetir esta medição foi preciso cruzar
três fontes à mão. Se a instrumentação existisse, seriam colunas em `jobs`:
tokens (in/out/cache), tempo de agente e tempo de render separados. *Decisão do
dono em 2026-07-31: NÃO implementar agora — esta amostra basta.*

---

## O que esta amostra prova (e o que não prova)

**Prova** — os quatro elos que o handoff listava como nunca exercitados:

1. o prompt novo da fase 1 cumpriu o contrato `RESULT:`;
2. o `{{pasta}}` ditado pelo bot pôs os arquivos no repo certo;
3. o cliente do HeyGen bateu na API de verdade e casou o título `A4-mulheres-v1`
   por igualdade exata (3 segundos);
4. a skill `reel` rodou pela fila `render` nova e entregou o MP4.

**Não prova:**

- **nada sobre 12 públicos.** Rodou com 1. As fases `baixar` e `reel` são por
  alvo, então 12 públicos são 12 renders — em concorrência 1, ~4h de fila
  extrapolando esta amostra;
- **nada sobre variância.** É n=1. O tempo do agente depende de quantos
  segmentos a capa pediu, e isso muda por roteiro;
- **nada sobre custo em dinheiro.** Tokens não foram convertidos em preço.

---

## Erros abertos, colhidos nesta sessão

1. **Fase de fluxo não checa o contrato `RESULT:`/`ERRO:`** — *grave.* O A#3
   declarou `ERRO: skill inemaclub-textos não encontrada` e o job virou `done`,
   abrindo o portão de uma fase que falhou. `contextoDeFase` (`fila/skills.ts`)
   usa `interpretarSaida: (bruto) => bruto.trim()`; quem exige o contrato é
   `dominio/artefato.ts`, e só roda para skill do catálogo.
2. **O filtro de alvos não chega ao prompt.** A#4 tem 1 alvo e o agente escreveu
   12 arquivos — o prompt manda "para TODOS os públicos do pipeline".
   Desperdício, não estrago.
3. **A skill `inemaclub-textos` some de forma intermitente.** Job 6 não achou;
   job 7, um minuto depois, achou. Mesmo ambiente. Sem explicação.
4. **`aoTerminar` já falhou com `chat not found`** (jobs 2 e 3, antes desta
   sessão). No A#4 a notificação foi gravada (`notificado_em` preenchido), então
   pode ter sido chat de teste.
5. **Mensagem de commit erra a contagem** — "11 públicos" com 12 arquivos.
   Cosmético.
6. **Sem contabilidade de tokens** (ver achado 3 acima).
7. **Duração não separa agente de render** — "21 min" não diz se foi o modelo ou
   a GPU, e são problemas opostos.
