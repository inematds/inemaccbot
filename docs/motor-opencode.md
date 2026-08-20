# Motor `opencode` — rodar os jobs de agente por uma CLI aberta

O motor padrão do bot é o `claude`. Este documento é sobre a alternativa
**aberta**: o [opencode](https://opencode.ai), que fala com vários provedores
(Anthropic, OpenAI, Groq, DeepSeek, modelo local via Ollama/LM Studio) pela mesma
CLI. É o caminho para quem quer largar a conta de um fornecedor específico sem
reescrever as skills.

Arquivo: `src/fila/runner-opencode.ts` · testes:
`src/fila/runner-opencode.test.ts` · o par fechado:
[`docs/motor-codex.md`](motor-codex.md) · como o perfil é resolvido:
[`docs/perfil-de-execucao.md`](perfil-de-execucao.md)

## ⚠️ Procedência: este runner não foi testado contra a CLI real

Diferente do `codex`, o `opencode` **não estava instalado** na máquina onde este
runner foi escrito. As flags vêm da documentação da CLI. Os testes exercitam a
função pura de argumentos e a maquinaria de processo — **não** a CLI real.

Antes de usar em produção, rode o **roteiro de verificação** no fim deste
documento. Se alguma flag estiver errada, o conserto é uma linha em
`argumentosOpencode` — a função é pura justamente para isso.

## Por que trocar é barato

Vale a mesma explicação do `codex`: o worker escolhe o motor pelo nome
(`RUNNERS[ctx.perfil.motor]`), `RUNNERS` é um dicionário aberto, e registrar uma
chave nova não altera o caminho de quem pede `claude`. A maquinaria de processo
(process group, timeout de parede, teto de saída, matar a árvore) é herdada do
`ClaudeRunner`.

## Como ligar

Instale o opencode e configure o provedor (`opencode auth login`). Depois, se o
binário não estiver no caminho padrão (`~/.opencode/bin/opencode`):

```bash
OPENCODE_BIN=/caminho/do/opencode
```

Caminho explícito, e não PATH, pelo mesmo motivo do `CLAUDE_BIN` — o PATH do
systemd é mínimo e não se pode confiar nele para decidir qual binário roda.

**Binário ausente não derruba o boot**: o serviço sobe, avisa no log, e só falha
quem pedir `| motor=opencode`. A exceção é `MOTOR_PADRAO=opencode` com binário
inexistente, que é erro de boot.

## Os três níveis de adoção

| escopo | como | quando usar |
|---|---|---|
| **um job** | `transcrever: <link> \| motor=opencode` | primeiro teste |
| **uma skill** | `"perfil": { "motor": "opencode" }` em `config/skills.json` | a skill provou que roda |
| **tudo** | `MOTOR_PADRAO=opencode` no `.env` + restart | você já confia |

## Modelo: aqui o mapa quase sempre é obrigatório

O opencode identifica modelo como **`provedor/modelo`**. Um alias solto
(`sonnet`) não resolve nada para ele, então:

```bash
OPENCODE_MODELOS="sonnet=anthropic/claude-sonnet-4-5,opus=deepseek/deepseek-chat"
```

Sem a variável, o `--model` não é passado e vale o default do `opencode.json` do
usuário — o que é uma escolha legítima se a máquina só usa um modelo.

`MODELOS_RANK` em `src/dominio/perfil.ts` **não muda**: o alias continua sendo o
vocabulário do bot, e a tradução para o id do provedor mora no runner.

## Esforço: não viaja, de propósito

A CLI do opencode não expõe nível de raciocínio — isso é propriedade do modelo
escolhido. Em vez de inventar uma flag que não existe, o `esforco` simplesmente
**não é passado**. Há um teste que fixa isso: `| esforco=low` e `| esforco=max`
produzem exatamente os mesmos argumentos.

Quem quer "mais esforço" mapeia um alias para um modelo mais forte em
`OPENCODE_MODELOS`. Fingir que a flag existe seria pior: o job rodaria diferente
do que o `/status` diz que ele é.

## As flags

```
opencode run [--model <provedor/modelo>] "<prompt>"
```

- **`run`** — o subcomando não-interativo. Sem ele a CLI abre a TUI e o job
  pendura até o timeout de parede.
- **`--model`** só quando há mapa.
- **o prompt por último**, como argumento único. Nunca `shell: true` — há teste.
- **`--print-logs` fica de fora**: a saída do agente é o contrato (`RESULT:`), e
  log de infra no meio dela só aumenta a chance de ruído.

## O que esperar de cada skill

A divisão é a mesma do codex, e pelo mesmo motivo — o que decide é o **prompt**,
não o motor:

| skill | roda? | por quê |
|---|---|---|
| `transcrever`, `dublar`, `analisevideo`, `imagem`, `historia` | **deve rodar** | o prompt manda rodar UM comando fixo e copiar o arquivo |
| `explicativo`, `curso`, `demo`, `reel`, `reelinematds`, `reelpromo` | **NÃO** | começam com "Use a skill `X`", conceito de Claude Code. O opencode não tem isso e **falha em silêncio**, improvisando |
| fase `texto` do promoavatar | testar num alvo só | geração longa com contrato de 12 arquivos + commit |
| `navega-avatar` | **NÃO** | é `claude --chrome`. Use a rota `\| estudio` |

Mantenha as skills da linha "NÃO" no motor `claude` (`"perfil": { "motor": "claude" }`
em `config/skills.json`) e `MOTOR_PADRAO=opencode` fica seguro para o resto.

## Uma pergunta que este motor NÃO responde

Trocar o motor **não** tira o laço agêntico — só troca de quem é a conta. Se o
objetivo é "só as LLMs no `.env`", sem agente nenhum, o caminho é outro: portar
as skills de cola para `kind: function` e escrever um runner de API de chamada
única. Está analisado em `doc/sem-agente.md` (privado).

## Roteiro de verificação

Faça nesta ordem — o passo 2 é o que valida as flags deste runner.

```bash
# 1. binário e provedor
opencode --version
opencode auth list

# 2. as flags do runner, na mão
cd /tmp && opencode run \
  'Escreva ok em /tmp/oc-smoke.txt via shell. Sua ULTIMA linha deve ser exatamente: RESULT: /tmp/oc-smoke.txt'
cat /tmp/oc-smoke.txt   # tem que dizer "ok"
```

Se o passo 2 falhar, olhe **o quê** falhou antes de mexer no bot:

| sintoma | causa provável | conserto |
|---|---|---|
| abre uma interface e não volta | `run` não é o subcomando desta versão | ajuste `argumentosOpencode` |
| roda mas não executa comandos | falta permissão/aprovação automática | a CLI pode precisar de uma flag de permissão — acrescente em `argumentosOpencode` |
| roda e responde, mas não cria o arquivo | o agente não tem ferramenta de shell no perfil ativo | configure o agente no `opencode.json` |
| `provider not found` | mapa de modelo | `OPENCODE_MODELOS` ou o default do `opencode.json` |

```bash
# 3. um job de verdade, sem tocar em config
#    no Telegram:  transcrever: <link> | motor=opencode

# 4. confira no log qual motor rodou
grep 'motor=opencode' inemaccbot.log
```

## Ruído no stdout

O contrato é extraído por `ultimaLinhaCasando` (`src/dominio/artefato.ts`), que
varre TODAS as linhas e fica com a ÚLTIMA que casa. Ou seja: log de infra em volta
do `RESULT:` não quebra nada — foi assim que o motor `codex`, que imprime bastante
ruído, passou. O que quebra é volume: acima de 4 MB
(`LIMITE_SAIDA_BYTES`) o buffer guarda o INÍCIO do stdout, o `RESULT:` do fim se
perde e o job falha por "sem contrato".

## O que NÃO muda

Fila SQLite, lease, drain, retomada, gateway do Telegram, motor de fluxos, portão
humano, notificação no chat, contrato `RESULT:`/`ERRO:`/`RENDER:` — nada disso
sabe qual agente está por baixo.
