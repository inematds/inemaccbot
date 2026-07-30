# Etapa 5 — motor de `fluxos/` (sem o promoclub)

Data: 2026-07-30. Spec: §3 inteiro, §7.5 (sombra), §7.6 (export/import).
Estado de partida: `master` em `6f919c6`, 390 testes verdes, etapas 0–4 no ar.

**Escopo combinado com o dono:** esta etapa entrega o MOTOR, testado com um `flow.json` de
brinquedo. A migração do promoclub é passo separado, feito junto com ele depois — é o que
a §6.3 já prescrevia ("flow.json de brinquedo: 3 fases, 2 alvos, uma com escopo fluxo").

## 1. O que é um fluxo, e por que ele não é uma skill

Skill = uma etapa, sem estado. "Rodar de novo do zero" é aceitável (§1.1).

Fluxo = trabalho com progresso que seria absurdo jogar fora. O caso real: 12 públicos, cada
um com texto → render → download → reel. Se o público 9 falha no render, os outros 11 não
podem parar, e retentar não pode refazer os 11 que já ficaram prontos.

Daí as três coisas que o motor precisa ter e a skill não tem: **estado por fase e alvo**,
**avanço transacional** e **definição congelada**.

## 2. Decisões de desenho

### 2.1 O avanço acontece DENTRO da transação do ack

É o coração da etapa. O v1 tinha um watcher que via `done` e depois enfileirava a próxima
fase — duas escritas separadas, e o dispatch duplicado que a spec cita como defeito real.

Aqui: marcar a fase como feita e enfileirar a próxima é **uma transação só** com o `UPDATE`
que fecha o job. Um crash entre as duas deixa de ser possível.

O problema de fronteira: `fila/` não pode importar `fluxos/` (§4). Solução — o store aceita
um gancho que roda DENTRO da sua transação:

```ts
concluir(id, resultado, dono, dentroDaTransacao?: (job) => void)
```

Quem injeta o gancho é o `index.ts`, que pode importar os dois. O store continua sem saber
o que é fluxo; o `fluxos/` continua sem saber o que é worker.

### 2.2 Referência: `P#16`

`prefixo` do `flow.json` + `#` + id da linha em `fluxos`. É o que o usuário digita
(`/status P#16`, `/refazer P#16 mulheres`). Um `P#16` que não existe é recusado com
mensagem clara — nunca resolvido contra outro fluxo, mesma regra dos ids de job do v1.

### 2.3 Definição congelada (§3.4)

Na criação, grava `definicao_json` (snapshot completo do `flow.json`), `definicao_hash`
(sha256 do JSON + do conteúdo de cada prompt referenciado) e `versao_def`. **Toda decisão de
fase lê o snapshot, nunca o disco.** Editar o `flow.json` afeta só fluxos novos; um `P#16`
retomado depois de um restart continua coerente; `/refazer` usa a definição original.

É o oposto da skill, que lê o prompt do disco a cada job — e é deliberado: skill não tem
estado, fluxo tem.

### 2.4 Escopo `fluxo` vs `alvo`

Uma fase é `escopo: "fluxo"` (um job para todos) ou `escopo: "alvo"` (um job por alvo). A
tabela usa `alvo = ''` como sentinela para o primeiro caso — `NULL` não funciona numa chave
primária. Correção que a revisão 1 da spec já tinha registrado.

### 2.5 Fase de espera (`espera: { intervalo, timeout }`)

Fase `function` que ainda não achou o que aguarda **reagenda a si mesma**
(`disponivel_em = agora + intervalo`) sem gastar tentativa — o `reagendar()` do store, que
existe desde a etapa 0 e até hoje não tinha usuário. O `timeout` conta do primeiro
enfileiramento da fase.

Diferente do render da etapa 3, aqui soltar o slot é o certo: uma espera de horas por um
vídeo no HeyGen não disputa GPU nenhuma, e segurar um worker da fila `io` por horas seria
desperdício.

### 2.6 Export/import é pré-requisito, não melhoria (§7.6)

`exportar(ref)` produz um JSON com o estado por fase/alvo; `importar(json)` reconstrói. É o
que torna esta etapa reversível — sem isso, migrar estado de arquivo para tabela é sem
volta. Entra junto, não depois.

### 2.7 Modo sombra (§7.5)

`sombra(tipo, assunto, opts)` monta o plano de jobs e **não enfileira**: imprime fase × alvo
× fila × tarefa. É como se confere um `flow.json` novo antes de gastar GPU — e é o que vai
validar o promoclub quando ele chegar.

## 3. O que NÃO entra

- **O promoclub** (`flow.json`, prompts, os 12 públicos): passo separado, com o dono.
- **A fila `navegador` com motor real** (`claude --chrome -p`): ela já existe e sobe ociosa
  desde a etapa 1; o runner de navegador é do promoclub, porque é a fase dele que precisa do
  Chromium pareado. Uma fase `navegador` de teste usa o runner fake.
- **Barreira entre fases** (§11): nenhum fluxo atual precisa. Fica o gatilho anotado.

## 4. Tarefas

| # | tarefa |
|---|---|
| 1 | branch + backup |
| 2 | migration 4: tabelas `fluxos` e `fluxo_fases` + view `fluxo_historico` |
| 3 | `dominio/flow.ts`: validação forte do `flow.json` + hash do congelamento |
| 4 | `fluxos/estado.ts`: leitura/escrita das tabelas |
| 5 | gancho transacional no store (`concluir`/`falhar` com callback) |
| 6 | `fluxos/runtime.ts`: `criar`, `avancar`, `status`, `refazer`, `cancelar` |
| 7 | `fluxos/exportar.ts`: export/import |
| 8 | modo sombra |
| 9 | gateway: `/fluxos`, `/<fluxo> <assunto>`, `/status P#N`, `/refazer P#N [alvo]`, `/cancelar P#N [alvo]` |
| 10 | boot: fase `pendente` sem job → enfileira (rede de segurança do §3.6c) |
| 11 | fixture de fluxo de brinquedo + testes de integração |
| 12 | revisão, merge, deploy |

## 5. Testes que provam o desenho

- **avanço independente por alvo**: o alvo A na fase 3 enquanto o B ainda está na 1;
- **falha isolada**: um alvo `falhou` não impede os outros de seguirem;
- **atomicidade**: crash entre "marcar fase" e "enfileirar próxima" não deixa fase órfã —
  o teste mata a transação no meio e confere que nada ficou pela metade;
- **definição congelada**: editar o `flow.json` no disco não muda um fluxo em voo;
- **retomada**: `kill -9` no meio, e o fluxo continua de onde parou no boot seguinte;
- **`/refazer` seletivo**: só o que está `falhou` volta, e com as tentativas zeradas;
- **export → import → mesmo estado**;
- **sombra não enfileira nada**.
