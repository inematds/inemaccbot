# Testes herdados do v1 — o que virou o quê

Spec §6.5: **nenhum teste do v1 é descartado sem equivalente no v2 ou justificativa
escrita.** Caso sem equivalente e sem justificativa = buraco.

Este documento cobre o `watcher.test.ts` (443 linhas para 196 de código, com comentários
citando bugs de produção — é o arquivo mais valioso do v1) e aponta o destino de cada caso.
Data: 2026-07-30, etapa 4.

## 1. `tick` — notificação

| caso do v1 | destino no v2 |
|---|---|
| notifica `done` uma vez e marca o estado | `integracao/reentrega.test.ts` — "notificação que deu certo de primeira não é reenviada" |
| notifica `failed` com o erro | `index.test.ts` — "falha avisa o chat e marca a notificação como entregue" |
| `running` só atualiza status, sem notificar | `gateway/notificar.test.ts` — status não-terminal não gera mensagem |
| **notify falha → job segue pendente e a passagem seguinte entrega EXATAMENTE UMA VEZ** | `integracao/reentrega.test.ts` (arquivo inteiro). **Era um buraco real**: o v2 ackava e notificava, e a mensagem perdida sumia para sempre. Fechado na etapa 4 com a coluna `notificado_em` |
| poll de uma fila falhar não impede a outra | `index.test.ts` — "tarefa que explode numa fila não impede a outra de terminar e notificar". A forma mudou (lá era rede, aqui é uma tarefa que explode); a propriedade é a mesma |
| `V#5` e `T#5` notificam independentemente | **sem equivalente, por construção**: os prefixos existiam porque havia DOIS bancos. Agora o id é global e único. O que sobrou dessa preocupação está em `comandos.test.ts` — id do bot antigo é recusado, nunca resolvido contra este banco |
| erro no poll não derruba (fila fora do ar) | **não se aplica**: não há poll. O avanço é transacional no mesmo processo e no mesmo banco — foi essa a mudança de desenho que matou o watcher |
| job fora da janela de 50 usa `jobById` como fallback | **não se aplica**: a "janela de 50" era da API HTTP do `mkivideos`. Aqui a consulta é local e por id |
| sem `jobById`, job fora da janela fica pendente sem crash | idem acima |

## 2. `doneMessage` — o conteúdo da mensagem

| caso do v1 | destino no v2 |
|---|---|
| sempre inclui o caminho em disco | `gateway/entrega.test.ts` — a mensagem carrega o caminho final (ou o conteúdo, quando é texto curto) |
| avisa quando o resultado NÃO caiu no destino pedido | `gateway/entrega.test.ts` — "artefato ausente é dito com todas as letras" e o caminho do erro de cópia |
| não trata diretório irmão com prefixo igual como dentro do destino | `gateway/entrega.test.ts` — a checagem de contenção é ciente do separador (`/data/midia-secreta` não passa por `/data/midia`) |
| inclui a duração quando há os dois carimbos | `gateway/comandos.test.ts` — `/status` mostra duração; `notificar` inclui na conclusão |
| omite a duração quando falta um carimbo | `duracao()` devolve `undefined` — nunca inventa |
| id prefixado `V#`/`T#` | **sem equivalente, por construção** (ver acima) |
| marca "com pesquisa" / "transcrição pedida" / narração | **sem equivalente, deliberado**: `pesquisa`, `narracao` e `transcrever` eram campos que o PARSER do v1 conhecia por nome. No v2 o que uma skill aceita é declarado por ela (`campos` no registry), e nenhuma das sete skills atuais declara esses três. Quando alguma declarar, o teste nasce com ela |

## 3. `reel` — cópia vs movimentação

| caso do v1 | destino no v2 |
|---|---|
| copia por default: o original permanece | `gateway/entrega.test.ts` — "copia por default, deixando o original" |
| `mover=true` move: o original some | `gateway/entrega.test.ts` — "\| mover apaga o original só depois de copiar" |
| origem inexistente: reporta erro, não finge sucesso | `gateway/entrega.test.ts` — "artefato ausente é dito com todas as letras" |
| reel sem destino não mexe em nada | `gateway/entrega.test.ts` — sem `destinoDir`, nada é copiado |
| falha ao copiar: avisa, mantém o caminho original | `gateway/notificar.test.ts` — falha de entrega vira mensagem com o caminho, e não derruba o worker |

## 4. `failMessage`

| caso do v1 | destino no v2 |
|---|---|
| inclui o id e a dica de `/status` | `gateway/notificar.test.ts` — mensagem de falha com id e trecho do erro; a lista do `/status` fecha o caminho |

## 5. Outros arquivos do v1

- **`promoclub.test.ts` (413L)** — ainda NÃO tem equivalente, e é assumido: o que ele testa
  (fase, estado, retomada) é o motor de `fluxos/`, que é a etapa 5. Os casos de
  públicos/canais viram fixture de domínio quando o promoclub for migrado. **Este é o único
  débito conhecido desta lista, e ele tem data marcada.**
- `parser.test.ts`, `skills.test.ts`, `interpret.test.ts`, `answer.test.ts`, `reply.test.ts`,
  `media.test.ts`, `deliver.test.ts`, `dests.test.ts` — os módulos foram portados na etapa 2
  com testes próprios, mais estritos em alguns pontos (o registry passou a ser validado, o
  destino a ser conferido no disco, a entrada do usuário a ser saneada).
- `jobref.test.ts`, `state.test.ts`, `queue-client.test.ts` — os módulos foram **descartados**
  (§5.1): id global tornou o prefixo desnecessário, as tabelas substituíram o `state/*.json`,
  e a chamada tipada substituiu o `execFile` + regex em stdout.
