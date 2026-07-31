# Ideias para baixar o custo de token — fases 1 e 3

Anotação para revisar depois. **Nada aqui está implementado nem decidido.**

Base de tudo: a amostra do A#4 em `docs/amostra-a4-custo-e-tempo.md` (n=1).

| | mensagens | output | cache read | duração |
|---|---|---|---|---|
| fase 1 (`texto`) | 36 | 16.525 | 2,6 M | 2 min 45 s |
| fase 3 (`reel`) | 146 | 73.372 | 18,1 M | 21 min 34 s |

O **cache read domina**: 20,7 M contra 90 mil de output no fluxo inteiro. É o
agente relendo o contexto a cada turno. Qualquer ideia que reduza **número de
turnos** ataca a maior parcela; ideias que reduzam só o output atacam a menor.

---

## Fase 1 — `texto`

**1.1 — `{{publicos}}` (JÁ FEITO, mas vale medir o efeito).** O A#4 pediu 1
público e o agente escreveu 12 arquivos. Se a economia for proporcional, uma
rodada de 1 público deveria cair para perto de 1/12 do output. **Medir na
próxima rodada** — é o teste mais barato que existe e ainda não foi feito.

**1.2 — Modelo menor.** A fase é texto curto com formato rígido (FALA /
SOBREPOSIÇÕES / ESTRUTURA) e contrato simples (`RESULT:`). É o candidato mais
natural a `haiku`. O bot já suporta sem código novo: `perfil` no registry, ou
`| modelo=haiku` no comando. **Risco:** modelo mais fraco obedece menos ao
contrato de saída, e agora que a fase cobra `RESULT:`/`ERRO:` isso vira falha
visível em vez de silêncio — o que é bom para descobrir, ruim para produção.

**1.3 — Escopo: 1 job para todos vs 1 job por público.** Hoje a fase é
`escopo: "fluxo"` — uma sessão só gera os 12. O contexto cresce a cada arquivo
escrito, e o cache read acompanha. A alternativa (`escopo: "alvo"`, 12 jobs
curtos) tem contexto pequeno e constante por job, mas paga 12x o custo fixo de
carregar a skill. **Não dá para saber qual ganha sem medir os dois.**

**1.4 — Peso da skill `inemaclub-textos`.** Não foi olhado. Se o `SKILL.md` e
as referências dela forem grandes, isso entra no contexto de todo turno e
multiplica pelo número de turnos. Vale medir o tamanho do que ela carrega antes
de mexer em qualquer outra coisa.

---

## Fase 3 — `reel` (onde está o dinheiro)

4,4x o output da fase 1, e é uma fase **por público** — enquanto o texto é um
job só para todos. Num fluxo de 12, a fase 3 é praticamente o custo inteiro.

**3.1 — Renders de preview.** O agente chamou `hyperframes` **16 vezes** e
sobraram `preview.mp4`, `preview2.mp4`, `preview3.mp4` no diretório de saída.
Cada preview é um ciclo de "renderiza, olha, decide" — e "olha" custa contexto.
Reduzir de 3 previews para 1 provavelmente é a maior economia isolada
disponível. **Verificar antes:** os previews servem para o agente conferir algo
que ele não consegue prever, ou são iteração por falta de confiança?

**3.2 — Determinizar o que hoje é decisão de LLM.** Segmentação (onde troca a
imagem do topo), timing da legenda palavra-a-palavra, posicionamento — parte
disso é regra, não julgamento. Regra vira script, e script não gasta token. O
que precisa mesmo de modelo é a headline-choque e a escolha das imagens.

**3.3 — Compactar o contexto.** 146 mensagens relendo 18 M. Vale olhar o que
está sendo relido: log de render (o `9.mp4.log` tem 26 KB), saídas de `ffprobe`,
listagens. Muito disso pode ser resumido antes de entrar no contexto.

**3.4 — Subagente para o trecho pesado.** A skill já usou `Agent` 2 vezes. Levar
mais trabalho para subagente isola contexto: o pai recebe o resultado, não o
caminho inteiro até ele.

**3.5 — Não é o render.** Registrado para não se perder tempo: o
`hyperframes render` final é 50,8 s de 21 min 34 s. Mexer em qualidade ou
resolução mexe em 4% do tempo e **0%** do token.

---

## Outra LLM — qwen3.6 local ou OpenRouter

### O que já existe para encaixar

O bot tem o ponto de extensão pronto: `RUNNERS` (`src/fila/runner.ts`),
registrado por efeito colateral (`runner-claude.ts`, `runner-chrome.ts`). Um
`runner-ollama.ts` ou `runner-openrouter.ts` seguiria o mesmo contrato e viraria
`motor=ollama`. O perfil (`motor`/`modelo`/`esforco`) já é por skill e
sobrescritível por job (`| modelo=…`), então dá para testar **um job de cada
vez**, sem trocar o padrão do sistema.

### O que temos aqui

`ollama` em `localhost:11434`, com `qwen3.6:35b-a3b` (23 GB, MoE) fixado na
memória pelo `~/projetos/wifi/ollama-keeponly-qwen36.sh`, `num_ctx: 32768`.
Também: `qwen3:30b`, `qwen2.5:72b`, `llama3.1:70b`, `command-r-32k`.

### Onde faria sentido, e onde não

**Fase 1 é o candidato.** Texto em português, formato rígido, contrato de saída
simples, sem uso de ferramenta. É exatamente o perfil de tarefa que um modelo
local resolve. E o custo marginal é zero — a GPU já está ligada.

**Fase 3 provavelmente não.** São 65 comandos de shell, 11 `Read`, 2 `Skill`,
2 `Agent`. Isso exige tool use confiável em cadeia longa; é onde modelo local
costuma quebrar, e quebrar aqui significa render errado depois de 20 minutos.

### O que investigar antes de tentar

- **Contexto de 32 k pode não caber.** A fase 3 relê milhões de tokens; nem com
  cache isso entra em 32 k. A fase 1 provavelmente cabe — **medir**.
- **`--effort` é do Claude Code**, não existe em ollama nem em OpenRouter. O
  `resolverPerfil` precisaria tratar esforço como opcional por motor.
- **A skill `inemaclub-textos` é uma skill do Claude Code.** Um runner ollama
  não tem acesso a ela — ou o prompt passa a carregar as instruções embutidas,
  ou a fase 1 local não usa skill nenhuma. Isso muda o desenho da fase, não só
  o motor.
- **OpenRouter** resolve o problema da skill? Não: skill é do CLI, não do
  modelo. Vale por preço/modelo, não por capacidade de ferramenta.
- **O contrato `RESULT:`/`ERRO:` agora é cobrado.** Bom para o teste: um modelo
  que não obedece falha na hora, em vez de contaminar a fase seguinte.

### Ordem sugerida quando formos mexer

1. Medir 1.1 e 1.4 (grátis, só olhar a próxima rodada e o tamanho da skill).
2. Testar `| modelo=haiku` na fase 1 — uma linha, sem código.
3. Só então avaliar runner novo, começando por fase 1 com ollama local.
4. Fase 3: atacar 3.1 (previews) antes de pensar em trocar modelo.

---

## O obstáculo comum a tudo isto

**O bot não mede token.** Os números desta anotação vieram de arqueologia nos
logs de sessão do Claude Code, cruzados à mão pelo horário. Comparar "antes e
depois" de qualquer ideia acima exige repetir esse cruzamento manualmente.

Decisão do dono em 2026-07-31: não instrumentar agora. Registrado que o custo
disso é medir por amostragem manual, uma rodada de cada vez.
