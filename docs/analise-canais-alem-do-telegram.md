# Trocar o Telegram por WhatsApp, e-mail ou chatbot — análise

Pergunta: dá para usar WhatsApp (Evolution API ou similar), Gmail/e-mail ou um
chatbot no lugar do Telegram?

Resposta curta: **dá, e o desenho já ajuda — mas não é trocar o adaptador.**
Existe um número que decide se isso é um fim de semana ou uma semana, e ele está
na seção seguinte.

## O que já está pronto para isso

O gateway foi escrito com costura. Só **um** arquivo conhece o grammy:

| peça | arquivo | depende do Telegram? |
|---|---|---|
| `rotear` (allowlist, erro genérico, log) | `src/gateway/telegram.ts:79` | **não** — pura |
| `rotearAnexo` | `src/gateway/telegram.ts:132` | **não** — o download é injetado |
| `Transporte` (`responder`, `enviarDocumento`) | `src/gateway/telegram.ts:117` | **não** — é uma interface |
| `criarBot` | `src/gateway/telegram.ts:170` | **sim** — é só a fiação |
| interpretação dos comandos | `src/gateway/mensagem.ts`, `comandos.ts` | não |

Ou seja: toda a *política* já é testável sem rede. Um canal novo é, em tese,
um `criarBot` novo devolvendo o mesmo `Transporte`.

## O que trava — os três acoplamentos reais

### 1. `chatId` é `number`, e isso está no banco

Este é **o** custo. Não é um tipo num arquivo, é uma coluna:

- `src/db/migrations.ts:37` e `:107` — `chat_id INTEGER`
- `src/db/migrations.ts:84` — índice composto `(status, notificado_em, chat_id)`,
  o que a varredura de notificação usa
- `src/fila/types.ts:35`, `src/fluxos/estado.ts:25` — `chat_id: number | null`
- e a assinatura `chatId: number` atravessa `index.ts`, `runtime.ts`,
  `comandos.ts`, `comandos-fluxo.ts`, `mensagem.ts`

Identidade no Telegram é um inteiro. Nos outros canais **não é**:

| canal | identidade | cabe em INTEGER? |
|---|---|---|
| Telegram | `123456789` | sim |
| WhatsApp (Evolution) | `5551999...@s.whatsapp.net` | não |
| e-mail | `nei@exemplo.com` | não |
| chatbot web | sessão/usuário (uuid) | não |

Trocar para `TEXT` é migração de schema + tocar a varredura de notificação e o
índice. É mecânico, tem 616 testes segurando, mas **não é um adaptador novo** —
e enquanto não for feito, nenhum dos três canais entra de verdade.

Há ainda `chatsPermitidos: number[]` em `src/config.ts:14`, lido de env por
`split(',')` (`:43`) — mesma história, menor.

### 2. `LIMITE_MENSAGEM = 4000` é um fato do Telegram virado constante global

`src/gateway/telegram.ts:23`, e a entrega depende do mesmo número de propósito
(o comentário ali explica por quê). Mas:

- **e-mail** não fatia — mandar 8 e-mails de 4000 chars é absurdo;
- **WhatsApp** tem outro teto;
- **chatbot web** não tem teto nenhum.

Vira política por canal, não uma constante. Mudança pequena, mas real.

### 3. Anexo: "legenda vira comando" é convenção do Telegram

`comandoDeAnexo` (`src/gateway/midia.ts:56`) e `criarBaixadorTelegram` (`:80`).
A ideia "manda o arquivo com uma legenda e a legenda é o comando" não existe
igual fora dali: e-mail tem assunto + corpo + anexos (o assunto seria a
legenda); chatbot web tem upload sem legenda nenhuma.

## Canal por canal

### WhatsApp via Evolution API

| | |
|---|---|
| entrada | webhook HTTP — você sobe um endpoint; hoje o grammy faz long-poll sozinho |
| identidade | JID string |
| entrega do MP4 | tem teto de tamanho; o reel já é entregue no `livesN` do disco e o chat só manda o **link** (`src/fluxos/publicar.ts`) — então o teto quase não incomoda |
| operação | **um contêiner que você mantém + um número que pode ser banido** |
| portão (`/aprovar`, `/pronto`) | funciona bem — é conversa, latência baixa |

O ponto fraco não é técnico, é operacional: Evolution é WhatsApp não-oficial. O
número é seu, o banimento é seu, e a atualização do WhatsApp quebra a biblioteca
quando quiser. O caminho oficial (Cloud API da Meta) não tem esse risco, mas tem
cadastro de negócio, template de mensagem e janela de 24h — o que atrapalha
justamente o aviso de "job terminou" fora da janela.

### Gmail / e-mail

| | |
|---|---|
| entrada | IMAP idle ou poll — muda o modelo: hoje é push |
| identidade | endereço, string |
| entrega do MP4 | anexo tem teto baixo; **link é a resposta certa** |
| operação | OAuth do Google (chato de montar, estável depois) |
| portão | **ruim** — a volta é de minutos a horas |

Diagnóstico honesto: e-mail é **bom para notificação, ruim para comando.**
O ciclo do fluxo é `/status` → `/aprovar` → `/pronto`, tudo conversa curta. Por
e-mail vira uma troca de cartas. Onde e-mail brilha é no fim: "A#9 terminou, 12
reels, aqui estão os links" — isso é uma mensagem só, e sobrevive a ficar
fechado.

### Chatbot (página web própria)

| | |
|---|---|
| entrada | você hospeda; WebSocket ou HTTP |
| identidade | sua — sessão/uuid |
| entrega do MP4 | você já serve os vídeos em `http.server 8202` — o player fica na própria página |
| operação | **tudo é seu**: hospedar, autenticar, manter |
| portão | ótimo, e é o único que pode **mostrar o vídeo** em vez de mandar link |

É o mais trabalhoso e o mais poderoso. É o único onde a revisão do portão pode
ser de verdade — ver os 12 roteiros lado a lado, aprovar por público, assistir
o reel antes de publicar. Também é o único sem terceiro que possa banir você.

## Comparação em uma tela

| | Telegram (hoje) | WhatsApp/Evolution | e-mail | chatbot web |
|---|---|---|---|---|
| esforço | — | médio | médio | **alto** |
| risco de terceiro | baixo | **alto (ban)** | baixo | nenhum |
| portão conversacional | ótimo | ótimo | **ruim** | ótimo |
| notificação de fim | boa | boa | **ótima** | boa |
| mostrar o vídeo | link | link | link | **player** |
| quem opera | ninguém | você (contêiner + número) | OAuth | **você, tudo** |

## Recomendação

**Não troque o Telegram. Acrescente.**

O `Transporte` já é quase um `Canal`. O caminho de menor arrependimento, em
ordem:

1. **`chat_id` de INTEGER para TEXT** (schema + varredura + índice + as
   assinaturas). É pré-requisito de qualquer canal novo, é mecânico, e sozinho
   não muda nada visível — o que o torna seguro de fazer antes de decidir o
   resto.
2. **`LIMITE_MENSAGEM` vira propriedade do canal**, não constante global.
3. **E-mail só de saída**, como segundo destino da notificação de fim de fluxo.
   É o menor pedaço com valor real: não precisa entender comando nenhum, e
   resolve "eu não estava no Telegram quando os 12 reels ficaram prontos".
4. **Aí sim decida** entre WhatsApp e chatbot — e a essa altura o custo de cada
   um já será só o adaptador, porque 1 e 2 são o que realmente doía.

O que eu **não** faria: substituir o Telegram por WhatsApp/Evolution. Troca um
canal que ninguém opera por um contêiner e um número banível, e não ganha
nenhuma capacidade nova — a mesma conversa, no mesmo formato, com mais risco.

---

Levantado em 2026-08-01. Os `file:line` acima foram conferidos nesta data; se
algum não bater, o código andou.
