# Amostra A#18 — a rota `navega-avatar`, do desastre ao número de referência

Medição das fases de **agente** do fluxo `promoavatar` com a fase opcional
`navega-avatar` (gerar o avatar CLONANDO um template no estúdio do HeyGen, pelo
navegador), colhida em **2026-08-03**. Sucessora natural da
[`amostra-a4-custo-e-tempo.md`](./amostra-a4-custo-e-tempo.md), que mediu a rota
por API — esta mede a rota por navegador, que não existia lá.

Não é benchmark: é amostra de tamanho 1 por rodada, colhida com o serviço no ar.
O valor aqui não está na precisão, está no **antes e depois** — a mesma fase foi
medida quebrada e consertada no intervalo de uma hora.

> **De onde vieram os números.** Continua valendo o aviso do A#4: o bot **não**
> registra token. Os valores foram lidos dos logs de sessão do Claude Code
> (`~/.claude/projects/-home-USUARIO-projetos-promoavatar/*.jsonl`), casados
> com os jobs pelo horário de início. **Arqueologia, não instrumentação.**
> Modelo em todas as medições: `claude-sonnet-5`, esforço `low` (perfil padrão).

---

## O número de referência (A#18, rodada boa)

`promoavatar` A#18, 1 público (`jovens`), assunto "O que é o Astra da OpenAI",
criado com `| alvos=jovens | navega | sem-portao`.

| fase | kind | duração | tool calls | output | cache write | cache read | **total** | custo |
|---|---|---|---|---|---|---|---|---|
| 1 `texto` | agent | 1 min 14 s | 7 | 7.656 | 172.083 | 704.660 | **884 mil** | US$ 0,97 |
| 2 `navega-avatar` | agent | 5 min 37 s | 51 | 13.695 | 388.761 | 7.356.977 | **7,76 M** | US$ 3,87 |
| 2.5 `baixar` | **function** | (espera) | — | — | — | — | **zero** | US$ 0,00 |

Input real: 24 e 165 tokens. Praticamente tudo que entra vem de cache — igual ao
A#4.

**A fase de navegador custa ~8x a de texto**, e **95% disso é cache read**: o
contexto inteiro relido a cada uma das 51 idas ao modelo. Navegar é
inerentemente caro porque é um passo de cada vez, e cada passo relê tudo que veio
antes — inclusive os screenshots já tirados.

### A fase 2.5 espera de graça

`baixar` é `kind: function`, sem `prompt`: código puro, nenhum LLM. E não segura
processo esperando — cada checagem que dá "ainda não" **reagenda** o job para
120 s depois e libera a fila (`heygen.baixar`, `aindaNao` → `reagendar`).

Consequência prática: **o tempo de render do HeyGen é grátis.** Uma hora de
espera = ~30 consultas HTTP, zero token, zero processo parado. O único custo é o
`timeout` configurado — estourou, a fase falha com mensagem explícita em vez de
esperar para sempre.

---

## O antes: a mesma fase, quebrada

Duas rodadas da fase `navega-avatar` antes do conserto, ambas com o prompt
antigo:

| rodada | duração | tool calls | cache read | screenshots | desfecho |
|---|---|---|---|---|---|
| A#17 job 231, tentativa 1 | **12 min 55 s** (morta a mão) | 76 | **13,5 M** | 28 (~550 KB cada) | não terminou |
| A#17 job 231, tentativa 2 | 3 min 10 s | 29 | 3,98 M | 6 | falhou e reportou |
| **A#18 job 234 (consertada)** | 5 min 37 s | 51 | 7,36 M | 12 | **vídeo gerado** |

A tentativa 1 gastou **13,5 M de tokens e não entregou nada**. A rodada
consertada entrega o vídeo por **45% menos** — e "menos" é o detalhe pequeno
perto de "funciona".

Cuidado ao ler: a tentativa 2 parece barata (3,98 M) só porque **desistiu cedo**.
Fase de navegador que falha rápido é barata; comparar custo sem olhar desfecho
engana.

---

## A causa raiz (e por que ninguém tinha visto)

O prompt mandava **"REUSE a aba do HeyGen já aberta. NUNCA abra aba nova"**.
Isso é impossível: a extensão do Claude **só enxerga abas que ela mesma criou**,
então a aba que o `stack99` deixa em Projects nunca aparece em
`tabs_context_mcp` e é inadotável.

A cascata que se seguia:

1. o agente cria a aba — que nasce **em segundo plano na única janela do `:99`**,
   ou seja, `hidden`;
2. conclui (errado) que abriu "uma segunda janela não mapeada" e que o caminho
   MCP está morto;
3. cai para `scrot` + `xdotool type`;
4. **`xdotool type` não digita acentuado** no editor tiptap — o "É" sai quebrado;
5. entra em loop de conserto **caractere a caractere**, conferindo cada passo com
   um PNG de meio mega que passa a ser relido em toda chamada seguinte.

Mais da metade dos 13 min foi só o passo 5.

### O conserto

Verificado ao vivo antes de escrever: a aba criada pelo MCP **pode** ser trazida
à frente.

```bash
export DISPLAY=:99
W=$(xdotool search --onlyvisible --class chromium | head -1)
xdotool windowactivate "$W"; sleep 0.5
xdotool key --clearmodifiers ctrl+2; sleep 1
```

`visibilityState` passa de `hidden` para `visible`, com foco. Depois do reset do
`stack99` a janela tem exatamente uma aba, então a nossa é a de número 2.

**`windowactivate` sozinho não resolve** — a janela já está ativa, ela só está
mostrando a outra aba. Quem troca a aba em foco é o `ctrl+2`. Foi exatamente aí
que o agente da tentativa 2 parou e desistiu.

Com a aba visível, tudo o que era caro fica barato: digitação pelo CDP (acentua
certo), colagem via `xclip` lendo de **arquivo** (texto acentuado nunca atravessa
o shell), e **conferência pelo DOM** em vez de screenshot.

O prompt passou a **proibir** o fallback `scrot`+`type`: se a aba não ficar
visível, a fase falha e reporta. Insistir por outro caminho foi o desastre.

---

## O bug grave que a medição encontrou

O job 231 **falhou** e mesmo assim virou `done`, abrindo o portão para a fase de
download — que ficou procurando no HeyGen um vídeo que nunca foi gerado.

É o item 1 de "Erros abertos" do A#4 (`ERRO:` declarado virando `done`) voltando
**uma camada abaixo** de onde foi consertado. O guarda existia, mas só olhava o
**stdout**. O agente escreveu `ERRO: aba do editor abriu oculta` **dentro do
arquivo** e, no stdout, contou a falha em prosa — "reportado em 231.txt com
`ERRO:` como última linha". Nenhum `ERRO:` começava linha no stdout, o arquivo
existia e não estava vazio: passou.

Consertado em `fila/skills.ts` (`aceitarPeloArquivo`): o mesmo teste de `ERRO:`
agora vale para o **conteúdo do arquivo**. Só início de linha, de propósito — um
artefato legítimo pode citar a palavra no meio de uma frase, e recusar isso
trocaria um bug por outro. Há teste para os dois lados. 719 testes passam.

### O efeito colateral que sobrou

O A#18 gerou o vídeo, mas o log ainda disse `sem "RESULT:", aceito pelo arquivo`
— apesar de `234.txt` **ter** a linha `RESULT:` dentro. O agente leu "sua ÚLTIMA
linha deve ser `RESULT:`" como última linha *do arquivo*.

Ou seja: **a saída de emergência virou o caminho normal desta fase.** Funciona,
mas rede de segurança usada todo dia deixa de ser rede — é por essa mesma porta
que o `ERRO:` passou. O prompt foi ajustado para separar os dois lugares (título
DENTRO do arquivo, `RESULT:` na resposta do agente). **Não re-medido:** a próxima
rodada dirá se o contrato principal voltou a ser cumprido.

---

## Armadilhas da rota, colhidas em campo

1. **Prompt é snapshot por fluxo.** `fluxos.definicao_json` congela o
   `prompt_texto` na criação. Editar o arquivo **não** alcança fluxo já criado —
   o A#17 rodou duas vezes com o texto velho depois de consertado. Para adotar
   prompt novo: fluxo novo. (Remendar o JSON à mão deixa o `definicao_hash`
   inconsistente; não vale.)
2. **Clone órfão com nome duplicado.** O clone nasce chamado `TEMPLATE-AVATAR`.
   Se a fase falhar antes de renomear, ficam **dois** com o mesmo nome e a busca
   da rodada seguinte pode clonar do clone — erro silencioso que corrompe todos
   os públicos. Duas defesas no prompt: renomear como **primeira** ação no
   estúdio, e **parar e reportar** se a busca achar nome duplicado.
3. **A ordem no arquivo do prompt importa.** O passo a passo estava **antes** da
   seção de visibilidade, e o agente começou a clicar antes de garantir a aba —
   foi assim que sobrou o clone órfão. Hoje há um portão explícito no topo da
   seção.
4. **`list_connected_browsers` pede para perguntar ao usuário.** A tool instrui
   a chamar `AskUserQuestion`. Em execução headless isso é falha garantida. O
   prompt manda ignorar e escolher por `isLocal: true`.

---

## O que esta amostra prova (e o que não prova)

**Prova:**

1. a rota `navega-avatar` fecha ponta a ponta: clona o template, renomeia, cola a
   fala acentuada, confere pelo DOM e clica `Generate`;
2. o `ctrl+2` resolve a aba oculta do `:99` — verificado direto, não inferido;
3. a espera da fase 2.5 é gratuita em token;
4. `ERRO:` dentro do artefato não passa mais por `done`.

**Não prova:**

- **nada sobre 10 públicos.** Rodou com 1. `navega-avatar` é por alvo e a fila
  `navegador` tem concorrência 1 — 10 públicos são ~56 min de fila e ~US$ 39 só
  nessa fase, extrapolando linearmente (e extrapolação linear aqui é chute);
- **nada sobre variância.** n=1 por rodada. O número de cliques depende de quanto
  a UI do HeyGen coopera no dia;
- **nada sobre o prompt do `RESULT:`** — o ajuste é posterior à medição;
- **nada sobre estabilidade.** Uma rodada boa não diz que a próxima será.

---

## Onde valeria otimizar (não feito)

Os 12 screenshots são o alvo óbvio: cada um entra no contexto e é **relido em
toda chamada seguinte**, o que os torna caros de um jeito que não aparece na
conta do momento em que são tirados. Trocar parte da navegação visual por
seletores de DOM atacaria diretamente os 95% de cache read.

**Não mexer agora**: a rota acabou de estabilizar e a amostra é de uma rodada.
Otimizar antes de ter variância medida é trocar um problema conhecido por um
desconhecido.
