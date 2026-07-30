# Etapa 3 — fila `render` (`explicativo`, `curso`, `demo`, `reel`, `reelinematds`)

Data: 2026-07-30. Spec: §7.2 (etapa 3), §2.3 (filas), §2.5 (idempotência), §1.3 (drain).
Estado de partida: `master` em `07b0474`, 322 testes verdes, etapa 2 no ar.
**O v1 inteiro está parado** — não há fila velha para competir, e também não há rede de segurança.

## 0. O que muda em relação à etapa 2

O encanamento já existe: registry, prompt em arquivo, `kind=agent`, contrato `RESULT:`,
perfil gravado no job, entrega em `livesN`, anexo, texto livre. Em tese, render seria mais
cinco entradas no `config/skills.json` e cinco prompts.

Não é, por uma razão só: **duração**. Transcrição leva minutos; render leva de 15 min a 2h.
Isso quebra três coisas do desenho atual e obriga a uma decisão antes de escrever qualquer
linha.

## 1. Decisão central: como um render de 2h sobrevive

### 1.1 Por que síncrono puro NÃO serve aqui

Na etapa 2 o agente vive do começo ao fim do job e o lease é renovado pelo heartbeat. Para
minutos, funciona. Para render, três problemas:

1. **Deploy mata o trabalho.** `desligar()` aborta o que sobra depois de 110s. Um render de
   40 minutos morre num `systemctl restart` — e leva junto GPU e token já gastos.
2. **Sessão longa de `claude -p`.** Foi exatamente o que motivou o modo background do v1
   (comentário "P7: sessão não segura 1–2h" no `mkivideos`).
3. **O `.err`**, que o v1 aprendeu na marra: sem marcador de falha, um passo que morre 10s
   depois de disparado deixa o serviço esperando até o timeout inteiro. O comentário no
   `waitForFile` nomeia o caso real (`transcrever_v1.py` que crashava).

### 1.2 O que o v1 fazia, e o que dele vale herdar

O agente fazia o SETUP inline, disparava só o render final destacado
(`nohup bash -c '<render> || touch "<alvo>.err"' >"<alvo>.log" 2>&1 &`), imprimia
`RENDER: <alvo>` e saía. O worker então vigiava o arquivo até estabilizar (12s de tamanho
parado), com o `.err` como atalho de falha rápida e 2h de timeout como backstop.

Isso vale herdar inteiro. **O que NÃO vale herdar** é o worker do v1 largar o job: lá não
havia lease, então "vigiar" era só um `await` num processo que, se morresse, perdia tudo.

### 1.3 O desenho proposto: dispara destacado, mas SEGURA o slot

Uma tarefa só, que faz as duas fases:

```
1. o alvo é determinístico  →  <artefatos>/<skill>/<id>-<nome>.mp4
2. já existe o alvo?             → adota, termina (não re-renderiza)
3. já existe o <alvo>.log?       → o render JÁ foi disparado numa tentativa anterior:
                                    NÃO chama o agente de novo, vai direto vigiar
4. senão                          → chama o agente (setup + dispara destacado + `RENDER:`)
5. vigia alvo / <alvo>.err, com o lease sendo renovado pelo heartbeat
```

Duas propriedades que isso compra, e que são o motivo de escolher assim:

- **O slot da fila fica ocupado enquanto vigia.** Isto é obrigatório, não detalhe: se o job
  voltasse para a fila entre um poll e outro (via `reagendar`), outro job de render seria
  reclamado e **dois renders escreveriam na mesma GPU** — exatamente o que a concorrência 1
  existe para impedir. A regra de ouro do §7.1 vale dentro do bot também, não só entre bots.
- **Restart não perde o render.** O processo destacado sobrevive ao `SIGTERM`; o job volta
  para a fila (lease vencido); na próxima tentativa o passo 3 vê o `.log`, não dispara nada
  de novo e volta a vigiar. É o §2.5 ("procure antes de criar") aplicado, e por isso estas
  skills precisam de `max_tentativas` ≥ 2.

Custo honesto: a tarefa de render deixa de ser `kind=agent` puro e passa a ser uma tarefa
que USA um agente por dentro — o registry ganha `aguarda_artefato: true`, e o worker segue
sem saber o que é render.

## 2. As outras quatro decisões

### 2.1 Campos por skill, sem voltar ao parser do v1

Hoje a gramática conhece só destino e perfil. `--vertical`, `curso` e `modulo` são de
vídeo. **Não** vou pôr `if (skill === 'curso')` no parser — foi assim que o v1 chegou a um
parser que conhecia `vertical`, `pesquisa`, `narracao`, `visuais` e `mover`, e que precisava
ser editado a cada skill nova.

O registry passa a declarar o que a skill aceita:

```jsonc
"campos": { "vertical": { "tipo": "bandeira", "padrao": false },
            "curso":    { "tipo": "texto", "padrao": "" } }
```

A gramática valida contra essa declaração e entrega os valores como variáveis do prompt.
Como `renderizarPrompt` já **falha** se uma variável não for usada pelo template, declarar
um campo e esquecer de usá-lo no prompt vira erro de teste, não comportamento silencioso.

### 2.2 `curso`/`modulo`: nome do arquivo, não coluna

Ficam no `input` e servem para NOMEAR o artefato na entrega
(`<curso>-<modulo>-<16|9>.mp4`, o padrão ordenável do v1). Não viram coluna: agrupar
métricas por curso é etapa 4, e coluna nova é migration.

Cuidado que isso exige: o caminho do artefato de TRABALHO continua sendo por job
(`<id>-…`), senão dois jobs do mesmo módulo colidiriam e o segundo "adotaria" o vídeo do
primeiro achando que era retentativa. O nome bonito é da ENTREGA.

### 2.3 `reel` entrega por CÓPIA

As skills `reel-edita-inema`/`reel-edita-inematds` gravam em
`~/projetos/output/reels/<slug>/`, e o v1 nunca passava `--pasta` nelas: o watcher COPIAVA
para `livesN` e deixava o original. A entrega da etapa 2 já copia — então isto é herança de
graça, mas ganha teste próprio, porque foi um bug real lá. Campo `| mover` para o caso
oposto, como no v1.

### 2.4 O que puxo da etapa 4 para cá

A etapa 4 existia para você não ficar cego ao desligar o v1. **Você já desligou.** Então
trago o que é barato e some fazendo falta agora:

- **duração** no `/status` e na mensagem de conclusão (o v1 tinha, em `formatDuration`);
- mensagem de conclusão dizendo para onde o arquivo foi (`doneMessage` do v1);
- `/refazer <id>` para job solto — reenfileira com a mesma entrada.

Fica para a etapa 4: dashboard, métricas ricas por curso e as regressões do `watcher.test.ts`.

## 3. Tarefas

| # | tarefa |
|---|---|
| 1 | branch + backup do DB |
| 2 | `campos` no registry (declaração + validação) e na gramática |
| 3 | tarefa `render.dirigir`: alvo determinístico, adoção, dispara agente, vigia alvo/`.err` |
| 4 | os 5 prompts (`explicativo`, `curso`, `demo`, `reel`, `reelinematds`) + entradas no registry |
| 5 | nome de entrega `<curso>-<modulo>-<fmt>` + `| mover` no reel |
| 6 | duração no `/status` e na conclusão; `/refazer <id>` |
| 7 | teste de restart: render disparado, serviço cai, segunda tentativa NÃO redispara |
| 8 | revisão, suíte, merge, deploy |

## 4. Testes que provam o desenho

- **adoção após queda**: `.log` existe → o agente NÃO é chamado de novo (é o teste mais
  importante desta etapa, o equivalente ao de idempotência da etapa 0);
- **`.err` falha rápido**: não espera o timeout inteiro;
- **estabilidade**: arquivo crescendo não é considerado pronto;
- **slot preso**: enquanto um render vigia, um segundo job de render NÃO é reclamado;
- **campos**: campo não declarado pela skill é recusado; declarado e não usado no prompt
  quebra o teste;
- **reel copia** (original permanece) e `| mover` move.

## 5. Aceitação — e o que ela custa

A spec pede **um render real por skill**. São 5 vídeos de verdade: GPU, tokens e tempo.
Proponho começar por `explicativo` (o mais barato e o mais usado) e você decidir quais dos
outros valem rodar. Não disparo nenhum sem você mandar.
