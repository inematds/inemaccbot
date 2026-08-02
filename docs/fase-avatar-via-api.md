# Fase de avatar via API (`| api`) e portão opcional (`| sem-portao`)

Alternativa à gravação manual no estúdio: o bot gera os avatares chamando a
HeyGen, em vez de esperar que uma pessoa os grave. Vale para o `/promoavatar`
(`A#`) e o `/promoavatar3` (`C#`).

**Nada disto muda o comportamento de hoje.** As duas flags nascem desligadas, e
sem elas o fluxo é o mesmo de sempre: o bot escreve os textos e PARA, você grava
no HeyGen, `/aprovar` libera o download e o reel.

## As quatro combinações

| comando | fase de avatar | portão |
|---|---|---|
| `/promoavatar3 <assunto>` | você grava no estúdio | para e espera `/aprovar` — **o de hoje** |
| `/promoavatar3 <assunto> \| api` | a API gera | para e espera `/aprovar` |
| `/promoavatar3 <assunto> \| sem-portao` | você grava no estúdio | não para |
| `/promoavatar3 <assunto> \| api \| sem-portao` | a API gera | não para — do assunto ao reel sozinho |

As duas flags são independentes e valem igual nos dois fluxos.

A terceira linha é quase sempre um erro de uso — sem portão e sem API, a fase de
download expira em 90 min esperando um vídeo que ninguém gravou. Não é proibida
(proibir combinação é decidir pelo dono do fluxo), mas está documentada aqui
como o que é.

## Por que nada quebra

Cinco garantias, e nenhuma delas é promessa — todas saem de mecanismo que já
existe:

1. **Default desligado.** Sem flag, nem a fase `gerar` entra na definição nem o
   portão sai.
2. **Definição congelada na criação.** Os fluxos que já existem no banco (o
   `A#16`, o `C#15`) carregam a definição com que nasceram. Editar `flow.json`
   hoje não muda nenhum deles — isto já é lei do sistema (§3.4), não algo novo.
3. **A fase `gerar` é REMOVIDA quando a flag está desligada**, no mesmo lugar em
   que `legenda` e `cta` já são resolvidos (`resolverOpcoes`). Com isso o
   `/status`, o `| sombra` e o `/refazer` de um fluxo normal ficam idênticos —
   sem linha a mais dizendo "gerar: pulado".
4. **A fase `baixar` não muda uma linha.** A geração usa o mesmo título que o
   download procura (`A<N>-<publico>-v1`, `C<N>-<alvo>-v1`), então o download
   não sabe — nem precisa saber — se o vídeo veio da sua mão ou da API.
5. **A suíte atual passa sem edição.** Se um teste de hoje precisar mudar, o
   comportamento de hoje mudou, e o desenho está errado.

## A fase `gerar`

```jsonc
{ "id": "gerar", "escopo": "alvo", "fila": "io", "kind": "function",
  "tarefa": "heygen.gerar", "max_tentativas": 2,
  "espera": { "intervalo": 60, "timeout": 3600 } }
```

Entra entre `texto` e `baixar`. Cria o vídeo, espera ficar `completed` e deixa
que a fase `baixar` faça o resto pelo título — o `video_id` não precisa ser
carregado de uma fase para a outra.

Quem fala é decisão do DOMÍNIO, não do bot: `avatar_id` e `voice_id` moram no
`flow.json` (no topo, ou por alvo quando um público pedir outra voz). O bot só
sabe chamar a API.

## Cobrança dupla: o risco que precisa de trava

`max_tentativas: 2` mais um `systemctl restart` no meio (o `código 143`, que já
matou o `C#13/jovens-aut`) fariam uma tarefa ingênua **gerar e cobrar os 36
vídeos de novo**. Duas travas, as duas obrigatórias:

1. **Procure antes de criar (§2.5).** Antes de gerar, busca pelo título: se o
   vídeo já existe no estúdio (em qualquer status), a tarefa não cria outro. É o
   mesmo idioma do `heygen.baixar`, que confere `existsSync(destino)` antes de
   baixar.
2. **`Idempotency-Key` no POST.** A API replica a resposta original quando a
   mesma chave chega em até 24h. A chave é derivada do título (que é único por
   fluxo × alvo × versão), não sorteada — sorteada não sobreviveria ao restart,
   que é exatamente o caso que se quer cobrir.

## Custo de operar

Medido em 2026-08-02, nos 39 vídeos completos mais recentes da conta: duração
média **44,1s** (mín 21,9 · máx 187,2). Então 36 alvos ≈ **26,5 min de vídeo**.

| motor | preço da doc | fluxo C# (36 alvos) | fluxo A# (12 públicos) |
|---|---|---|---|
| avatar padrão | ~US$ 1/min | **~US$ 26** | ~US$ 9 |
| Avatar IV | US$ 3–4/min | ~US$ 80 a 106 | ~US$ 27 a 35 |

Qual dos dois depende do `avatar_id`/engine escolhido no `flow.json`.

**A carteira é pré-paga e estava em US$ 0,22** (`GET /v3/users/me` →
`billing_type: "wallet"`, `remaining_balance`). Por isso a criação com `| api`
**confere o saldo antes de enfileirar** e recusa com o número na mão ("a
carteira tem US$ X e este fluxo precisa de ~US$ Y") — falhar na criação é muito
melhor que gerar oito vídeos e morrer no nono, com os oito já cobrados.

A estimativa usada na conferência é a média medida × número de alvos. É
estimativa mesmo: a cobrança real é por segundo gerado.

## Sobre tirar o portão

O portão existe porque "discordar de um roteiro no portão custa um texto, não um
render". Com `| api` esse argumento fica MAIS forte, não menos: um texto ruim
que passa direto custa ~US$ 26.

Por isso `| api` sozinho **mantém** o portão — ele só muda de significado, de
"grave os avatares" para "revise os textos". Quem quiser a esteira inteira sem
parar pede as duas flags, explicitamente.

## O que a API dá, e o que não dá

Confirmado contra a conta real em 2026-08-02:

- `/v3/users/me`, `/v3/videos`, `/v2/avatars` (1330 avatares + 7600 talking
  photos) e `/v2/voices` (2558 vozes) respondem com a chave que o bot já usa
  (a de `~/projetos/openpcbotv2/.env`, apontada por `HEYGEN_ENV_PATH`).
- Os ids que este domínio usa existem: avatar `Nei Maldaner`, voz `INEMA TIME`.
- A legenda continua sendo decisão do estúdio/da chamada — ver a seção
  `heygen.baixar` no README: o download prefere `video_url_caption` quando ele
  vem preenchido.
