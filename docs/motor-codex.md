# Motor `codex` — rodar os jobs de agente pela CLI da OpenAI

O motor padrão do bot é o `claude`. Este documento é sobre a **alternativa**:
como ligar o `codex` sem mexer em nada do que já roda, como testar num job só, e
o que funciona e o que não funciona com ele.

Arquivo: `src/fila/runner-codex.ts` · testes: `src/fila/runner-codex.test.ts` ·
o par aberto: [`docs/motor-opencode.md`](motor-opencode.md) ·
como o perfil é resolvido: [`docs/perfil-de-execucao.md`](perfil-de-execucao.md)

## Por que trocar é barato

O worker escolhe o motor pelo NOME, em runtime:

```ts
// src/fila/worker.ts
const runner = this.opts.runners[ctx.perfil.motor];
if (!runner) throw new Error(`motor desconhecido: ${ctx.perfil.motor}`);
```

`RUNNERS` é um dicionário aberto (`src/fila/runner.ts`), e `motor` já é campo de
perfil resolvido por precedência. Registrar uma chave nova **não altera** o
caminho de quem pede `claude` — é por isso que ligar o codex não é um risco para
o que está em produção.

A maquinaria de processo (process group próprio, timeout de parede, teto de 4 MB
de saída, matar a ÁRVORE no cancelamento) é **herdada** do `ClaudeRunner`: ela
não tem nada de Claude, é o contrato de executar um binário de agente. O que
muda de motor para motor é só a tradução do perfil em flags.

## Como ligar

Nada a instalar do lado do bot — o runner já vem registrado. O que você precisa é
do `codex` na máquina e logado (`codex login`).

Se o binário não estiver no caminho padrão (`~/.npm-global/bin/codex`), declare:

```bash
CODEX_BIN=/caminho/do/codex
```

O caminho é explícito, e não o PATH, pelo mesmo motivo do `CLAUDE_BIN`: o serviço
systemd roda com PATH mínimo, e "qual CLI o bot usa" não pode depender de como o
serviço subiu (custou o C#77/C#78 — ver o comentário em `src/config.ts`).

**Binário ausente não derruba o boot.** Motor alternativo é opcional por desenho:
o serviço sobe, avisa no log, e só falha quem pedir `| motor=codex`. A exceção é
`MOTOR_PADRAO=codex` com binário inexistente — aí todo job de agente falharia, e
isso é erro de boot, com o caminho na mensagem.

## Os três níveis de adoção

Do mais tímido ao mais ousado. Todos sem redeploy de lógica.

| escopo | como | quando usar |
|---|---|---|
| **um job** | `transcrever: <link> \| motor=codex` | primeiro teste |
| **uma skill** | `"perfil": { "motor": "codex" }` em `config/skills.json` | a skill provou que roda |
| **tudo** | `MOTOR_PADRAO=codex` no `.env` + restart | você já confia |

O caminho recomendado é exatamente essa ordem, começando por `transcrever` — é a
skill mais simples de verificar (entra link, sai `.txt`) e a que menos depende de
comportamento específico do agente.

## Modelo e esforço

O vocabulário do bot (`haiku`, `fable`, `sonnet`, `opus`) é alias da Claude. A
tradução para o id da OpenAI mora **no runner**, e não no ranking do domínio:
`MODELOS_RANK` em `src/dominio/perfil.ts` não muda.

```bash
CODEX_MODELOS="sonnet=gpt-5.1-codex,opus=gpt-5.6-sol"
```

**Sem essa variável, o `--model` não é passado** e vale o `model` do
`~/.codex/config.toml`. É de propósito: chutar um id da OpenAI para cada alias
faria todo job quebrar no dia em que a OpenAI renomeasse um modelo — uma quebra
causada por um default que ninguém pediu. Um par malformado é ignorado em vez de
derrubar o boot.

O esforço vira `-c model_reasoning_effort="..."`. O bot tem cinco degraus e o
codex quatro (`minimal|low|medium|high`): **`xhigh` e `max` colapsam em `high`**,
que é o teto do motor. Recusar o job por causa disso seria pior que entregá-lo no
máximo possível.

## As flags, e por que cada uma

```
codex exec --skip-git-repo-check -s danger-full-access \
  [--model <id>] -c model_reasoning_effort="<esforço>" "<prompt>"
```

- **`exec`** — modo não-interativo. Sem ele a CLI abre a TUI e o job pendura até
  o timeout de parede.
- **`--skip-git-repo-check`** — o `cwd` de uma skill é uma pasta de artefatos,
  que quase nunca é um repo git. Sem isto o codex recusa sair da largada.
- **`-s danger-full-access`** — EXPLÍCITO, não herdado do `config.toml`. Os
  prompts rodam `python3`, `ffmpeg` e gravam fora do `cwd`. Deixar isso depender
  de um arquivo de config do usuário é a mesma armadilha do PATH: o
  comportamento do serviço passaria a depender de como a máquina foi configurada.
- **o prompt por último**, como argumento único. Nunca `shell: true`, nunca
  interpolação — há teste para isso.

## O que funciona hoje

Testado de verdade (`codex exec` real, contrato extraído):

| skill | roda no codex? | por quê |
|---|---|---|
| `transcrever` | **sim, sem editar nada** | o prompt manda rodar UM comando fixo e copiar o arquivo |
| `dublar` | **sim** | idem |
| `analisevideo` | **sim** | idem (`bash analisevideo.sh`) |
| `imagem` | **sim** | idem, mas o prompt pede tradução para inglês — confira a saída |
| `historia` | **sim** | idem |
| `explicativo`, `curso`, `demo`, `reel`, `reelinematds`, `reelpromo` | **NÃO** | começam com "Use a skill `X`", que é conceito de Claude Code (`~/.claude/skills/`). O codex não tem isso e **falha em silêncio**: ele improvisa alguma coisa em vez de dizer que não achou a skill |
| fase `texto` do promoavatar | não testado | é geração criativa longa, com contrato de 12 arquivos + commit. Teste num alvo só antes |
| `navega-avatar` | **NÃO** | é `claude --chrome`, motor `chrome`. Sem equivalente — use a rota `\| estudio` |

Deixar as skills da linha "NÃO" no motor `claude` é uma linha em
`config/skills.json` (`"perfil": { "motor": "claude" }`), e aí `MOTOR_PADRAO=codex`
fica seguro para o resto.

## Ruído no stdout — e por que o contrato aguenta

O `codex exec` imprime bem mais que a resposta: cabeçalho, comandos executados,
`tokens used`, linhas de hook. Num run real, **`RESULT:` não foi a última linha
do stdout** — veio antes de `hook: Stop` e da contagem de tokens.

O contrato aguenta porque `ultimaLinhaCasando` (`src/dominio/artefato.ts`)
varre TODAS as linhas e fica com a ÚLTIMA que casa, ignorando o resto. Não é
sorte: é a mesma tolerância que o A#5 forçou (o agente respondeu com o contrato
entre crases). Mas é bom saber, porque muda o que você procura ao depurar: no log
do codex, o `RESULT:` está no meio, não no fim.

O teto de 4 MB de saída (`LIMITE_SAIDA_BYTES`) é mais relevante aqui do que com o
`claude`, justamente por esse ruído. Um job que estourar o teto guarda o INÍCIO
do stdout — e aí o `RESULT:` do fim se perde e o job falha por "sem contrato".
Se isso aparecer, o problema não é o contrato: é o volume de log.

## Roteiro de verificação

```bash
# 1. o binário existe e está logado
~/.npm-global/bin/codex --version

# 2. as flags do runner passam, e o contrato sai
cd /tmp && codex exec --skip-git-repo-check -s danger-full-access \
  -c model_reasoning_effort="low" \
  'Escreva ok em /tmp/codex-smoke.txt via shell. Sua ULTIMA linha deve ser exatamente: RESULT: /tmp/codex-smoke.txt'
cat /tmp/codex-smoke.txt   # tem que dizer "ok"

# 3. um job de verdade, sem tocar em config
#    no Telegram:  transcrever: <link> | motor=codex

# 4. confira no log qual motor rodou
grep 'motor=codex' inemaccbot.log
```

O passo 4 não é enfeite: o perfil efetivo é gravado no job e aparece no log e no
`/status`. Quando um resultado sai estranho, é ali que se descobre com que motor
ele rodou.

## O que NÃO muda

Fila SQLite, lease, drain, retomada, gateway do Telegram, motor de fluxos, portão
humano, notificação no chat, contrato `RESULT:`/`ERRO:`/`RENDER:` — nada disso
sabe qual agente está por baixo, e nada disso foi tocado.
