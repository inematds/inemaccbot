# Os fluxos no catálogo

Cada fluxo mora no próprio repo, irmão do inemaccbot (`PROJETOS_DIR`). O bot só guarda o
comando, o repo e a descrição (`config/fluxos.json`); fases, prompts e scripts são do
domínio, no `flow.json` dele. `/<fluxo> help` (ou `/ajuda <fluxo>`) mostra a ajuda que o
domínio escreveu no `HELP.md`.

Estado em 23/10/2026 (inemaccbot 0.25.12).

| comando | prefixo | repo | fases | portão humano |
|---|---|---|---|---|
| `/promoavatar3` | `C#` | [promoavatar3](https://github.com/inematds/promoavatar3) | texto → gerar / gerar-creditos / estudio → baixar → reel | sim (`/aprovar` depois do texto e do download) |
| `/promoavatar` | `A#` | [promoavatar](https://github.com/inematds/promoavatar) | texto → gerar / … / navega-avatar → baixar → reel | sim; **congelado** desde 06/08/2026 |
| `/musicavideo` | `MVD#` | [musicavideo](https://github.com/inematds/musicavideo) | plano → musica → capa → clipe → entrega | sim, em cada fase menos a última |
| `/r7ex` e `/rtex` | `RX#` | [r7ex](https://github.com/inematds/r7ex) | ficha → producao | não; `\| portao` liga |
| `/explicavideo` | `EV#` | [explicavideos](https://github.com/inematds/explicavideos) | ficha → avatar → visual → entrega | não; `\| portao` liga |

Em todos: `| sombra` mostra o plano sem enfileirar nada, `/status <ref>` acompanha,
`/cancelar <ref>` tira da lista.

## promoavatar3 (`C#`) e promoavatar (`A#`)

Um assunto vira um reel por público (12 públicos). No `promoavatar3` são três vídeos por
público: alcance, autoridade e promocional (alvo `<publico>-alc|aut|pro`). A rota do avatar
(`| api`, `| creditos`, `| estudio`, `| navega`) diz quem gera e de que bolso sai o custo:
ver [`rotas-de-avatar.md`](rotas-de-avatar.md). O `promoavatar` ficou de pé, sem mudança de
comportamento.

```
/promoavatar3 Não comece aprendendo ferramentas | alvos=jovens-alc,jovens-aut,jovens-pro | sombra
```

## musicavideo (`MVD#`)

Uma frase vira música, capa e clipe, planejados juntos. Cada fase para e espera
`/aprovar MVD#N`; responder ao portão com as palavras da fase corrige e reabre o portão. A
música é a única parte paga. Foi o fluxo que estreou as fases de função (`cli.rodar`) sem
agente: ver [`plugar-fluxo.md`](plugar-fluxo.md).

```
/musicavideo balada pop sobre recomeço
```

## r7ex (`RX#`, 0.24.11)

Tema ou tese vira o reel viral 9:16 de 7 etapas.

1. **ficha** (agente): pesquisa, roteiro, portões automáticos (checagem e nota viral). Grava o
   `APROVADO_HEYGEN`: o comando vale como OK do avatar daquele pedido.
2. **producao** (função): avatar no estúdio HeyGen → montagem → revisor → fila do canal. A
   fila publica 1 a cada 2 h e manda o link no v3.

Canal e "agora" saem do texto (sem canal → lives7). O uso direto do r7ex no terminal continua
igual.

```
/r7ex hackers vão atacar todo mundo, cita PHP2Shell, no lives1 agora
```

## explicavideo (`EV#`, 0.25.11)

Assunto vira explicavideo v2 com o avatar do Nei, em 16:9, 9:16 ou os dois.

1. **ficha** (agente, `explicavideos/prompts/bot-ficha.md`): pesquisa e roteiro de 1 bloco
   (até ~5 min de fala), `pedido.json` e as configs v1/v2.
2. **avatar** (função, `bot/avatar.sh`): estúdio HeyGen, download pela API de leitura, v1
   (transcrição e montagem). Leva de 20 min a horas.
3. **visual** (agente, `prompts/bot-visual.md`): imagens pelo Codex e o visual v2 no tempo da
   fala.
4. **entrega** (função, `bot/entrega.sh`): render, som, QA e publicação no canal (yt-pubx);
   link no inemaytbot, arquivo no v3. QA reprovado = nada publicado.

O texto decide formato (16:9 padrão; "9x16", "vertical", "reel", "os dois"), canal (o lives
citado ou o do tema) e estilo (viral, ou aula com "tutorial"/"passo a passo"). Fica pelo
terminal: EN/ES, portal, tópico no Telegram, vídeo de mais de 1 bloco.

```
/explicavideo a geleira do juízo final vai subir o mar, nos dois formatos, no lives10
```

## `| portao` e `| sem-portao`

São espelhos (0.25.11). Num fluxo que nasce com portão, `| sem-portao` segue sem parar mas
continua mandando ao chat o que cada fase declara em `portao.mostrar`. Num fluxo que nasce
sem portão (r7ex, explicavideo), `| portao` liga a pausa em toda fase que declara `portao`,
menos a última. Os dois juntos são recusados.

## Acrescentar um fluxo

O caminho é o de [`plugar-fluxo.md`](plugar-fluxo.md) e
[`integrar-um-repo.md`](integrar-um-repo.md): `flow.json` + `prompts/` + `HELP.md` no repo do
domínio, uma linha em `config/fluxos.json`, `npm test`, e `/<fluxo> <assunto> | sombra` antes
do primeiro uso. Ao entrar um fluxo, acrescente uma linha na tabela acima e no guia
(`guia/index.html`, seção "Fluxos no catálogo", e as versões `en/` e `es/`).
