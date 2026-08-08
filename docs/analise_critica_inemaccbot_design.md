# Análise crítica do design do `inemaccbot`

## Veredito geral

O desenho está bem acima da média para um sistema interno desse porte. Ele resolve corretamente problemas reais do sistema atual:

- separa skill direta de fluxo com estado;
- elimina watchers frágeis;
- introduz claim atômico e lease;
- organiza filas por tipo de recurso;
- transforma o `/promoclub` em um caso do motor de fluxos;
- prevê migração incremental;
- exige testes de concorrência e recuperação.

### Avaliação

- **Conceito arquitetural:** 8,5/10
- **Clareza da especificação:** 9/10
- **Prontidão para produção:** 7/10
- **Estimativa de esforço:** provavelmente otimista

A arquitetura é boa para uma máquina, um operador e volume controlado, mas alguns pontos precisam ser corrigidos antes da implementação.

---

## Pontos fortes

### 1. Skill direta não vira workflow artificial

```text
skill → um job direto na fila
fluxo → estado + fases + retomada
```

Regra correta:

> Se rodar novamente desde o começo é aceitável, é skill.  
> Se existe trabalho parcial que precisa ser preservado, é fluxo.

### 2. Filas por classe de recurso

É correto organizar as filas como:

```text
render
navegador
texto
leve
```

Fila representa consumo e concorrência, não o nome da skill ou do produto.

### 3. Avanço transacional no lugar de watcher

```text
worker termina
    ↓
marca job como concluído
    ↓
atualiza o estado do fluxo
    ↓
insere o próximo job
```

Isso reduz risco de perda de eventos, avanço duplicado e lógica espalhada.

### 4. Claim, lease, retry e backoff

A fila passa a ter disciplina durável:

- claim atômico;
- lease;
- retry;
- backoff;
- `disponivel_em`;
- drain no encerramento.

### 5. Migração incremental

A ordem proposta é segura:

```text
fila básica
→ tarefas leves
→ texto
→ render
→ paridade operacional
→ fluxos
→ desligamento
```

---

# Problemas e riscos

## 1. “Um repo” não corresponde ao desenho real

O documento afirma “1 repo”, mas também prevê um repo de domínio para cada fluxo.

A definição mais correta seria:

```text
1 repo de plataforma: inemaccbot
N repos ou pacotes de domínio
1 serviço principal
1 banco operacional
```

Isso afeta deploy, versionamento, rollback, testes e compatibilidade.

---

## 2. Falta congelar a definição do workflow

Um fluxo em andamento não pode depender do `flow.json` atual, porque ele pode mudar durante a execução.

Ao criar o fluxo, grave:

```text
fluxos.definicao_json
fluxos.versao
fluxos.hash_definicao
```

Cada execução deve continuar usando a definição imutável com a qual começou.

---

## 3. Lease não garante execução única

Lease evita dois claims simultâneos, mas não evita repetir uma operação externa.

Exemplo:

1. o worker cria um vídeo no HeyGen;
2. o processo morre antes de salvar o ID;
3. o lease vence;
4. outro worker cria o vídeo novamente.

Cada fase precisa de uma chave idempotente:

```text
idempotency_key = fluxo_id + alvo + fase
```

Exemplo:

```text
P#16/mulheres/render
```

A tarefa deve procurar uma operação ou artefato já existente antes de criar outro.

---

## 4. Não liberar lease enquanto o processo ainda está vivo

Durante o `SIGTERM`, o sistema deve:

1. parar novos claims;
2. continuar renovando leases;
3. aguardar os jobs;
4. encerrar a árvore de subprocessos ao atingir o timeout;
5. somente então devolver o job ou deixar o lease expirar.

Liberar o lease cedo pode causar duas execuções simultâneas.

---

## 5. `kind=function` está amplo demais

API, download, polling e FFmpeg têm custos muito diferentes.

Sugestão inicial:

```text
io         concorrência 10
cpu        concorrência 1 ou 2
texto      concorrência 2
render     concorrência 1
navegador  concorrência 1
```

FFmpeg não deve ser automaticamente tratado como tarefa leve.

---

## 6. Nem toda função precisa de processo ou thread

Classificação mais correta:

```text
HTTP/API/poll     → async no worker
FFmpeg            → child_process
CPU em JavaScript → worker_thread
Claude            → child_process
```

O princípio deve ser: o gateway não executa trabalho. Isso não exige criar processo para todo `fetch`.

---

## 7. O schema perde histórico

`fluxo_alvos` guarda apenas o estado atual. Isso dificulta auditoria e métricas.

Separar:

```text
fluxo_alvos
- fluxo_id
- alvo
- fase_atual
- estado_atual
- dados

fluxo_execucoes
- fluxo_id
- alvo
- fase
- job_id
- tentativa
- status
- iniciado_em
- terminado_em
- resultado
- erro
```

---

## 8. O escopo `fluxo` precisa ser modelado claramente

A fase global de texto e as fases por alvo não devem ser forçadas na mesma estrutura.

Sugestão:

```text
fluxo_fases
- fluxo_id
- fase
- escopo
- alvo NULL quando escopo=fluxo
- estado
- job_id
- dados
```

Exemplo:

```text
texto  alvo=NULL
render alvo=mulheres
render alvo=pais
reel   alvo=mulheres
```

---

## 9. Cancelamento está subespecificado

É necessário definir:

- sinal usado;
- encerramento da árvore de processos;
- status final;
- cancelamento de operações externas;
- bloqueio de `ack done` depois do cancelamento.

Contrato sugerido para runners:

```text
start()
cancel()
heartbeat()
cleanup()
```

---

## 10. Segurança precisa virar requisito

Adicionar explicitamente:

- allowlist de `chat_id`;
- catálogo fechado de tarefas;
- `spawn`/`execFile` sem `shell=true`;
- validação de `cwd`;
- proteção contra path traversal;
- limites de upload;
- mascaramento de segredos;
- permissões restritas;
- subprocessos sem privilégio.

---

## 11. Backup e migrations do SQLite

Com WAL, copiar apenas o arquivo principal pode gerar backup incompleto.

É necessário:

- SQLite Backup API ou `.backup`;
- política de retenção;
- teste de restore;
- migrations versionadas;
- checksum das migrations.

```text
schema_migrations
- version
- applied_at
- checksum
```

---

## 12. Observabilidade precisa ir além dos logs

Também acompanhar:

- duração por tarefa;
- retries;
- leases expirados;
- tamanho das filas;
- jobs presos;
- taxa de erro;
- uso de CPU e RAM;
- processos Claude ativos;
- tempo médio por fase.

Exemplo:

```text
fila render:
- 1 executando
- 7 aguardando
- job mais antigo: 42 min
- taxa de falha em 24h: 8%
```

---

# Sobre o monólito modular

A escolha é correta para o momento atual.

Contudo, “um processo” não descreve exatamente a operação, pois o serviço abrirá Claude, Chromium, FFmpeg e outros subprocessos.

Descrição mais precisa:

> Um serviço supervisor principal com processos de trabalho filhos.

---

# Crítica ao cutover

Desligar a fila antiga assim que a nova for validada é uma boa decisão.

O risco está na etapa de fluxos, descrita como quase sem rollback.

Antes do cutover, implementar:

```text
exportar fluxo do DB → JSON
importar JSON → fluxo no DB
```

Também vale executar uma validação em sombra: o sistema novo interpreta e monta o plano, mas ainda não executa.

---

# Estimativa de esforço

A estimativa de 9–12 sessões parece agressiva.

Uma previsão mais segura:

| Parte | Sessões |
|---|---:|
| Fila, claim, lease e testes | 3–4 |
| Gateway e tarefas leves | 1–2 |
| Texto | 1–2 |
| Render | 2–3 |
| Paridade operacional | 2 |
| Motor de fluxos | 3–5 |
| PromoClub e navegador | 2–4 |
| Cutover e estabilização | 1–2 |
| **Total** | **15–24** |

---

# Mudanças obrigatórias antes da implementação

1. Congelar a definição de cada workflow.
2. Adicionar chave idempotente por fase e alvo.
3. Corrigir a semântica do drain.
4. Separar estado atual de histórico.
5. Modelar fases globais e por alvo.
6. Definir cancelamento e árvore de subprocessos.
7. Criar migrations, backup consistente e restore.
8. Adicionar requisitos mínimos de segurança.
9. Corrigir a afirmação “1 repo”.
10. Retirar FFmpeg da classificação automática de tarefa leve.

## Mudanças recomendadas

- métricas operacionais;
- exportação e importação de estado;
- limite global de processos Claude;
- heartbeat de jobs longos;
- validação forte dos registries;
- hash da definição e dos prompts;
- histórico de execuções;
- testes de incompatibilidade entre versões.

---

# Arquitetura revisada

```text
Telegram
   ↓
Gateway
   ↓
Roteador
   ├── Skill direta
   │      ↓
   │   Task Queue
   │      ↓
   │    Worker
   │      ↓
   │   Function ou Agent
   │
   └── Workflow
          ↓
      Workflow Engine
          ↓
      definição congelada
          ↓
      fases globais ou por alvo
          ↓
      Task Queues
          ↓
        Workers
```

Armazenamento recomendado:

```text
SQLite
├── jobs
├── workflows
├── workflow_steps
├── workflow_history
├── schema_migrations
└── operational_events
```

---

# Conclusão

A direção do projeto é correta:

> **Monólito modular, filas duráveis, workers disciplinados e workflow opcional.**

Os principais riscos são garantias mais fortes do que a implementação realmente oferece:

- retomada sem duplicação;
- cancelamento seguro;
- continuidade com `flow.json` mutável;
- rollback do estado;
- histórico incompleto.

Corrigindo esses pontos antes de programar, o `inemaccbot` pode permanecer simples de operar e, ao mesmo tempo, robusto para crescer.
