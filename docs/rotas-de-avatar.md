# As seis rotas de avatar, e de que bolso cada uma sai

> Detalhe extraído do `README.md` em 2026-08-09, quando ele passou a ter uma
> promessa só (conhecer, instalar, configurar, usar). Isto aqui é **capacidade do
> bot** — quem gera o vídeo do avatar e quanto custa — mas é leitura de quem vai
> escolher uma rota, não de quem está instalando.
>
> O que é de DOMÍNIO (público, gatilho, canal, template) mora no repo do domínio:
> [`promoavatar3`](https://github.com/inematds/promoavatar3).


Quem decide de onde sai o custo **não é um parâmetro no corpo do POST — é a
autenticação**. A doc da HeyGen é explícita: *"When you authenticate with an API
Key (`x-api-key`), you are billed under the API tier. Usage is deducted from
your prepaid USD wallet"*, e *"OAuth (MCP and CLI `--oauth`) authenticates as
the user's web account and draws on subscription credits"*.

| rota | quem faz o trabalho | custo | estado |
|---|---|---|---|
| **normal** (padrão) | **você**, no estúdio | **ilimitado nesta conta** (ver ressalva) · seu tempo: 36 colagens | **em produção** |
| **`\| creditos`** | o bot, pela CLI autenticada por OAuth | **~1 crédito por vídeo** | **implementado**; rota provada à mão em 2026-08-02, **ainda não em fluxo** |
| **`\| api`** | o bot, pela chave de API | **~US$ 0,73/vídeo** (Avatar III) | implementado, **nunca fez chamada real** |
| **`\| estudio`** | um SCRIPT (Playwright) clonando o template no estúdio | igual à normal, **zero token de LLM** | implementado 2026-08-06; o script gerou vídeo ponta a ponta no teste, **ainda não rodou dentro de um fluxo** |
| **`\| navega`** | um AGENTE clonando o template no estúdio (`Edit as New`) | igual à normal, **+ ~US$ 1,25 de LLM por público** | rodou 112 jobs (A#19–A#29), mas **só existe no `promoavatar`, que está congelado** — ver ressalva abaixo |
| **navegação** (`fluxo-navegador` montando cena do zero) | um agente escolhendo avatar, voz, cenário | igual à normal, **mais tokens ainda** | **morta**: pertencia ao fluxo `promoclub`, que saiu do `config/fluxos.json` |

**Ressalva do `| navega` (verificado em 2026-08-09).** O `flow.json` do
`promoavatar3` — o domínio ativo — declara `api`, `creditos` e `estudio`, e **não**
declara `navega`. A rota existe apenas no `promoavatar`, congelado desde 2026-08-06.

Isso tem uma consequência que vale dizer em voz alta: o `| navega` era o **caminho de
volta** se o DOM do HeyGen mudasse e o script do `| estudio` quebrasse. No fluxo
atual esse plano B não existe. Portá-lo para o `promoavatar3` é uma decisão em
aberto, não um esquecimento.

**`| estudio` e `| navega` fazem a mesma coisa e cobram do mesmo lugar** — clonam
o `TEMPLATE-AVATAR`, herdam cenário, avatar, voz e motor. A única diferença é
quem pilota o navegador: um script determinístico ou um agente. O `navega` fica
de pé de propósito, como caminho de volta se o DOM do HeyGen mudar e o script
quebrar. **Pedir duas rotas é recusado na criação** — juntas gerariam o mesmo
vídeo duas vezes, cada uma cobrando de um bolso.

O que o script resolve e o prompt não resolvia (medido em 2026-08-06, ao portar):

1. **A busca por `TEMPLATE-AVATAR` devolve três** (`-9`, `-16` e o certo). O
   prompt manda o agente PARAR nesse caso, porque ele não tem como decidir qual
   é o original. O script casa por **igualdade exata**.
2. **"Gerar" não gera.** Abre um modal de confirmação (resolução, formato, fps);
   quem dispara é o botão **"Enviar"**. Esse passo **não estava no prompt** — um
   agente que declarasse "gerei" ali estaria de boa-fé, e a fase `baixar`
   esperaria 1h30 por um vídeo que ficou `draft` para sempre.
3. **Acento sem receita.** `type()` pelo CDP escreve certo no tiptap: some toda
   a parte de `xclip`/`xdotool`/`ctrl+2`/`visibilityState` — a maior seção do
   prompt e a "causa nº 1 de falha silenciosa".
4. **A interface está em pt-BR** ("Editar como Novo", "Vídeo sem título",
   "Gerar", "Enviar"), e o prompt fala em inglês. O agente acertava por
   interpretação; o script acerta por seletor.

O script é `scripts/heygen-estudio.mjs` e a tarefa é `heygen.estudio`
(`src/fila/tarefas/heygen-estudio.ts`). Ele **retoma de um rascunho homônimo**
em vez de clonar de novo, e a tarefa **não gera duas vezes**: se o título já
está no estúdio em qualquer status que não `draft`, a tentativa anterior já
enviou e já cobrou.

**O ponto frágil da rota `| estudio` é a sessão.** Ela usa um perfil de Chromium
já logado no HeyGen (`HEYGEN_PERFIL_CHROME`, default
`~/.cache/inemaccbot/perfil-heygen`) — uma cópia dos cookies do Chromium do
`:99`. Quando a sessão expirar, a fase falha com *"a sessão do HeyGen não está
logada neste perfil"* e o conserto é recopiar o perfil.

A `| navega` é a rota de navegação **sem montar cena**: em vez de escolher
avatar, voz, cenário e proporção a cada vídeo, ela clona um projeto-template do
estúdio e só troca duas coisas — o título e a fala. O barato não é cada passo
ficar mais barato: é haver menos passos. Detalhes, e o que o reconhecimento no
estúdio provou, em [`docs/rota-navega-avatar.md`](docs/rota-navega-avatar.md).

**Ressalva que muda a conta de quem for copiar isto:** nesta conta a rota
*normal* é ilimitada, então ela não consome os 500 créditos — e a de *navegação*,
por ser o mesmo estúdio, também não. Em plano com crédito contado as duas
passam a custar, e aí a comparação é outra. O que foi MEDIDO aqui é só o débito
da rota OAuth; o consumo de um render feito à mão nunca foi medido.

**O teste de 2026-08-02** (`TESTE-CREDITOS-v1`, 8,67s, `avatar_iii`), que provou
a rota de créditos ponta a ponta:

| | antes | depois |
|---|---|---|
| créditos premium | 200 | **199** |
| créditos add-on | 300 | 300 |
| carteira US$ | 0,22 | **0,22 — intacta** |

Quatro respostas de uma vez: debita da **assinatura** (`billing_type:
subscription`), roda **headless** (sessão salva, token `refreshable`, válido
10 dias), custa **1 crédito** para 8,67s — e, o que mais importava, o
`heygen.baixar` **acha pelo título** um vídeo gerado por OAuth mesmo listando
com a chave de API: as duas credenciais veem a mesma conta, então a fase
`baixar` não muda.

Extrapolando: **36 alvos ≈ 36 créditos dos 500**, contra ~US$ 26 pela API. Uma
amostra não distingue "1 por vídeo" de "1 por minuto começado", mas como os
vídeos ficam abaixo de 1 min, dá no mesmo.

**A dúvida que sobra na rota de créditos:** a doc chama OAuth de *"trial-scale
only"* e recomenda API key *"for anything at scale — batches, pipelines"*. Um
vídeo não prova 36. O teste que falta é um público inteiro (3 alvos, 3
créditos) antes de soltar o lote.

**Por que a navegação virou legado:** ela só existia porque era o único jeito de
alcançar os créditos sem a mão. O OAuth alcança melhor — sem depender de aba
logada, sem quebrar quando o layout do estúdio muda, sem gastar tokens de LLM.

**Cuidado com o motor.** O `/v3/videos` usa **Avatar IV por padrão**, que custa
US$ 0,05–0,0667/s contra **US$ 0,0167/s do Avatar III** — 3 a 4× mais caro pelo
mesmo minuto. O campo `engine` tem que ser explícito; deixar no default é
escolher o caro sem saber.

**Como as duas rotas do bot são declaradas.** Cada uma é uma fase OPCIONAL no
`flow.json`, e só entra no fluxo quando a flag dela vem na criação:

```
texto → gerar(só |api) → gerar-creditos(só |creditos) → baixar → reel
```

Pedir as duas juntas é **recusado** — gerariam o mesmo vídeo duas vezes,
cobrando dos dois bolsos. O motor é do domínio (`"engine": "avatar_iii"` no
`flow.json`), nunca o default da API.

**O que falta fazer** (ordem sugerida):

1. ~~`engine` explícito~~ — **feito**: o domínio declara `avatar_iii`, e a
   tarefa nunca deixa o campo em branco.
2. ~~Implementar a `| creditos`~~ — **feito**: `heygen.gerar-creditos`, mesma
   tarefa com a autenticação trocada (CLI por OAuth, `HEYGEN_CLI` no `.env` —
   caminho, não segredo: o token expira e quem renova é a CLI).
3. **Teste de lote**: um público inteiro (`| alvos=jovens-alc,jovens-aut,`
   `jovens-pro | creditos`), 3 créditos, para saber se o "trial-scale" da doc
   vira rate limit no meio.
4. **Rota `| api` continua não provada** — só dá para testar com a carteira
   recarregada. Sem pressa: com créditos funcionando, a API é reserva.
5. **Navegação**: manter como legado do `promoclub` (fluxo aposentado), não como quarta opção viva.

Detalhe completo, com as travas de idempotência e de saldo:
[`docs/fase-avatar-via-api.md`](docs/fase-avatar-via-api.md).
