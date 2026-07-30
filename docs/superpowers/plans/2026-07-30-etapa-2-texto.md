# Etapa 2 — fila `texto` (`transcrever`, `dublar`) + gateway de skills

Data: 2026-07-30. Spec: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md` §7.2 (etapa 2),
§1.4/§1.5 (motor e perfil), §2.5 (idempotência), §9 (segurança).
Estado de partida: `master` em `ec0b1db`, 202 testes verdes, etapas 0 e 1 no ar.

## 0. O que esta etapa entrega

Tornar `kind='agent'` alcançável pela primeira vez, com as duas skills que hoje rodam no
`mkitexto.service`: `transcrever` (link → .txt/.srt via Whisper local) e `dublar` (link → .mp4
dublado). Junto vem o gateway que falta para elas serem usáveis: registry de skills, parser de
comando `skill: entrada | campos`, interpretação de texto livre, resposta a perguntas sobre o
serviço, download de anexo e entrega do artefato.

Ao fim: `mkitexto.service` desligado — **depois** de uma comparação real lado a lado (§7).

## 1. Decisões de desenho (e por quê)

### 1.1 Execução SÍNCRONA, não background+poll

O v1 faz o agente disparar `nohup … &`, imprimir `RENDER: <path>` e sair; o worker vigia o arquivo.
Isso existia porque a fila do `mkivideos` não tinha lease com heartbeat e a sessão não segurava um
render de 1–2h. Aqui o lease é renovado a cada 20s enquanto o job vive, e transcrever/dublar levam
minutos — então o agente roda até o fim e emite `RESULT: <caminho>`. Some o poll, some o watcher,
some o marcador `.err`.

**O preço, dito em voz alta:** um restart ou deploy no meio de uma transcrição mata aquele job
(`desligar()` aborta o que sobra depois de 110s e marca `failed`). O v1, destacado, sobrevivia a
isso. Mitigação: `max_tentativas: 2` no registry destas tarefas — a retentativa reexecuta do zero,
o que é aceitável para um trabalho de minutos e sem efeito externo irreversível.

### 1.2 Timeout de parede e teto de saída no runner — no mesmo commit que liberar o agente

`ClaudeRunner` hoje não tem timeout nem limite de stdout (o v1 tinha `timeout: 120_000` e
`maxBuffer: 10MB`). Com `promptDe` lançando, isso é inerte; no instante em que um job `agent`
rodar, um `claude -p` travado ocupa 1 dos 2 slots de `texto` **para sempre** — o heartbeat renova o
lease indefinidamente e nada notifica. Entra junto: `timeoutMs` por execução (do registry) e teto
de bytes acumulados de stdout/stderr.

### 1.3 `resultado` é o caminho extraído, não o stdout cru

`concluir()` grava o que `rodarAgente` devolve, e o notificador manda isso para o chat. Portanto o
runner de skill extrai a última linha `RESULT: <caminho com extensão esperada>` (por skill:
`txt|srt` para transcrever, `mp4` para dublar) e **falha o job** se o contrato não aparecer. Sem
isso o chat recebe a transcrição inteira, ou pior, o log do agente.

### 1.4 Redação de `erro` e `resultado` (risco 3 do handoff)

`job.erro` vai verbatim para o chat. Com stderr de agente isso passa a carregar caminhos, prompt e
possivelmente segredos. Regra desta etapa, aplicada num único ponto (`dominio/redacao.ts`, usado
pelo worker antes de gravar e pelo notificador antes de enviar):

- mascara `BOT_TOKEN` e qualquer `\d{8,}:[A-Za-z0-9_-]{30,}` (formato de token do Telegram);
- mascara valores de variáveis com nome contendo `TOKEN|KEY|SECRET|PASSWORD`;
- substitui `/home/<user>` por `~`;
- corta em 1.000 chars ao gravar e 300 ao notificar (limite já existente).

### 1.5 Registry de skills (`config/skills.json`) + prompts em arquivo

Uma entrada por skill, validada forte no boot (falha de validação derruba o boot, como as
migrations). Campos:

```jsonc
{ "command": "transcrever", "fila": "texto", "kind": "agent",
  "motor": "claude", "modelo": "sonnet", "esforco": "low",
  "prompt": "prompts/transcrever.md",
  "artefato_exts": ["txt", "srt"],
  "max_tentativas": 2, "timeout_segundos": 3600,
  "descricao": "...", "exemplo": "transcrever: https://..." }
```

O prompt é arquivo (`prompts/*.md`) com placeholders `{{input}}` e `{{saida}}` — spec §9: o que o
usuário fornece entra como **variável**, nunca como instrução crua. `tarefa` de um job só pode ser
`command` do registry (catálogo fechado).

Isso já resolve o risco 4 do handoff (fila `texto` sem portão): o boot valida o registry antes de
qualquer `passo()`, e um job com tarefa fora do catálogo falha explicitamente.

### 1.6 Entrega no gateway, não na fila

O artefato existe em disco quando o job fica `done`. Quem entrega é o gateway (o `fila/` não pode
conhecer Telegram nem destinos): o notificador ganha um passo de entrega injetado —

- `.txt`/`.srt` pequeno: manda o **conteúdo** no chat (cortado por `splitForTelegram`) e o caminho;
- destino `livesN` no comando: copia para `<projetos>/yt-pub-livesN/imports/videos` (registry de
  destinos, portado de `dests.ts`), e responde com o caminho final;
- `.mp4` sem destino: responde só o caminho (avatar/dublado passa do limite do Telegram).

### 1.7 Lista de filas em UM lugar (risco 5)

Hoje `comandos.ts` (gateway) tem a própria lista de filas e `index.ts` tem `CONCORRENCIAS`. A
correção **não** é o gateway importar do `index.ts` (importar para cima quebra o teste de
arquitetura): a lista e as concorrências descem para `fila/` e os dois passam a ler de lá.

## 2. Tarefas (nesta ordem; suíte verde ao fim de cada uma)

| # | tarefa | entrega |
|---|---|---|
| 1 | branch `etapa-2-texto` + backup do DB | ponto de retorno |
| 2 | `fila/filas.ts`: lista + concorrências num lugar só (risco 5) | `index.ts` e `comandos.ts` leem de lá |
| 3 | `dominio/redacao.ts` (§1.4) + aplicação no worker e no notificador | segredos não vazam no chat |
| 4 | `dominio/registry.ts` + `config/skills.json` + `prompts/*.md` | loader validado, boot recusa registry inválido |
| 5 | runner: `timeoutMs` + teto de saída (§1.2) | agente travado morre e notifica |
| 6 | `fila/skill-agente.ts`: `promptDe` real + extração `RESULT:` (§1.3) e o throw sai | `kind=agent` alcançável |
| 7 | gateway: `skill: entrada \| campos` (parser de 2 portas) + `/skills` + ajuda gerada | `transcrever: <link>` enfileira |
| 8 | `dominio/destinos.ts` + entrega no notificador (§1.6) | artefato chega ao destino/chat |
| 9 | `gateway/media.ts`: anexo → `state/midia` | resolve também a pendência do `thumb` |
| 10 | `gateway/interpret.ts`: texto livre → jobs | pedido em linguagem natural |
| 11 | `gateway/answer.ts`: pergunta sobre o serviço (DB local + log + registry) | "terminou?" responde |
| 12 | teste de catálogo: toda tarefa `function` aborta em ≤N ms (risco 2) | nova tarefa não reintroduz órfão |
| 13 | revisão da branch + typecheck + suíte + merge | `master` verde |

Risco 2 do handoff vale para as tarefas `function` novas (anexo, entrega) — não para
`transcrever`/`dublar`, que são `agent` e morrem por `exec.cancelar()`.

## 3. Testes (o que prova cada coisa)

- registry: entrada inválida (fila inexistente, prompt ausente, exts vazias) derruba o loader;
- prompt: `{{input}}` com aspas/quebra de linha não vira instrução; placeholder desconhecido falha;
- runner: execução que passa do `timeoutMs` é morta (árvore inteira) e vira `failed` notificado;
- extração: stdout sem `RESULT:` falha; com `ERRO:` falha com o motivo; extensão errada falha;
- redação: token de bot e `/home/<user>` não aparecem no `erro` gravado nem na notificação;
- gateway: `transcrever: <link> | lives3` enfileira 1 job na fila `texto` com perfil resolvido;
- entrega: `.txt` vai como texto; destino inexistente é erro claro; traversal no nome é rejeitado;
- catálogo: toda tarefa `function` do catálogo aborta em ≤ 500ms ao receber o sinal.

Regras não negociáveis do handoff §4 valem inteiras: relógio injetável, SQLite em arquivo temp,
nenhum teste toca Telegram/rede/`claude`, `spawn` sem `shell`, imports `.js`, fronteiras por
`arquitetura.test.ts` (mover o teste, nunca alargar a exceção), e guarda nova provada por mutação.

## 4. O que esta etapa NÃO faz

Nada de `render` (etapa 3), `fluxos/`, `/refazer`, `/status <fluxo>`, dashboard ou help gerado
completo (etapa 4). `interpret` conhece só skills — fluxos entram na etapa 5.

## 5. Aceitação (§7.4) e cutover

A prova da etapa 2 é **manual e não automatizável**: mesma entrada nos dois bots → saída
equivalente. Custa GPU e token, e depende de um link real.

Sequência do fim, sem atalho:

1. suíte verde + typecheck + merge em `master`;
2. deploy (`npm run build`, restart do serviço) com backup do DB antes;
3. **uma transcrição real** no bot novo e a mesma no velho, comparadas lado a lado;
4. só então, e com o dono confirmando: `systemctl --user disable --now mkitexto`, e
   `transcrever`/`dublar` saem do `config/skills.json` do v1 (uma linha de config, reversível).

O passo 4 mexe num serviço vivo que o dono decidiu deixar de pé — é confirmado, não presumido.
Atenção: o repo do v1 tem alterações não commitadas em `src/config.ts`, `src/interpret.ts` e
`src/promoclub.ts`; elas não podem ser varridas para dentro do commit de cutover.
