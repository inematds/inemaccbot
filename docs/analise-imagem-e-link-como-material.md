# Análise: imagem e link como MATERIAL de um fluxo

Pergunta: mandar uma ou várias imagens, ou um link, para servirem de conteúdo do
reel e de assunto. O que existe hoje e o que custaria adaptar — assumindo que as
skills aceitam.

Levantado no código em 2026-08-01. **Nada aqui está implementado.**

## O que existe hoje

### Anexo

`telegram.ts` trata `document`, `video`, `audio` e `voice`. O arquivo é baixado
para `state/midia` e a LEGENDA vira o comando (`midia.ts:comandoDeAnexo`):

```
legenda "transcrever"           → transcrever: <caminho do arquivo>
legenda "transcrever: http://x" → transcrever: http://x   (a legenda manda mais)
legenda vazia                   → "recebi o arquivo: <caminho>"
```

Três limites que decidem o resto desta análise:

1. **`photo` NÃO é tratado.** A lista de eventos não inclui `message:photo`, que
   é como o Telegram entrega uma imagem mandada do jeito normal. Mandar a imagem
   como *arquivo* (documento) funciona; mandar como *foto* cai no vazio.
2. **Um anexo = uma mensagem = um job.** Não há noção de conjunto.
3. **Teto de 20 MB** — a API do Telegram não deixa um bot baixar mais que isso.

### Link

Não existe tratamento de link como material. O que há:

- `http <url>` — uma tarefa `function` que faz GET e guarda a resposta;
- `<skill>: <url>` — a URL vira a `entrada` da skill, e quem baixa é a skill
  (é assim que `transcrever` funciona);
- texto livre com URL vai para o `interpret`, que decide virar job ou pergunta.

Nenhum desses lê uma página e a transforma em ASSUNTO.

### Fluxo

`criarFluxo(registrado, argumento, deps)` recebe **texto e só texto**. O
`assunto` é uma string; não há campo para arquivo nem para material.

E os dois caminhos não se encontram: `comandoDeAnexo` monta `<verbo>: <entrada>`,
com dois-pontos. Comando de fluxo é `/promoavatar <assunto>`, sem dois-pontos.
Uma imagem com legenda `/promoavatar tema` viraria `/promoavatar: <caminho>` —
que não casa com nada.

**Conclusão: hoje nem imagem nem link chegam a um fluxo. Só a skills.**

## O que faltaria, por camada

### A. Aceitar foto (barato)

Acrescentar `message:photo` ao handler existente. O Telegram manda um array de
tamanhos; usa-se o último (maior). O resto do caminho já existe.

**Risco:** baixo. **Ganho:** uma imagem por mensagem já funcionaria como
funciona um documento hoje.

### B. Várias imagens de uma vez (é aqui que dói)

O Telegram manda um álbum como **N mensagens separadas**, cada uma com o mesmo
`media_group_id`, chegando em menos de um segundo. Só a primeira costuma trazer
a legenda.

Hoje o gateway é **sem estado por mensagem**: cada uma entra, vira comando e sai.
Juntar um álbum exige acumular por `media_group_id` e esperar um instante antes
de despachar — ou seja, **estado com tempo dentro do gateway**, que é
exatamente o que ele não tem.

Duas saídas:

1. **Buffer com timer** (~300 ms) por `media_group_id`. Simples de descrever,
   chato de testar: relógio injetável, mensagem que chega atrasada, o que fazer
   se o serviço cair no meio do álbum.
2. **Comando explícito**: a pessoa manda as imagens (cada uma vira arquivo em
   `state/midia`), e depois um comando que as referencia (`/promoavatar tema |
   material=ultimas:4`). Sem timer, sem estado novo — mas exige um passo a mais
   de quem usa.

A (2) é bem mais barata e não introduz corrida nenhuma. A (1) é mais natural
para quem manda.

### C. Link como material (médio)

Precisa de uma decisão antes do código: **quem lê o link?**

- **O agente da fase 1.** Ele já roda com Bash no repo de domínio; buscar a
  página é uma linha no prompt. Zero código novo no bot. Preço: o conteúdo entra
  no contexto do modelo (token) e o §9 manda tratar tudo que vem de fora como
  DADO, nunca instrução — uma página com "ignore as instruções acima" é o caso
  clássico.
- **Uma tarefa `function` antes da fase 1.** Busca, extrai texto, grava. O
  conteúdo vira arquivo e a fase 1 recebe o caminho. Mais código, mas isola o
  conteúdo não confiável e não gasta token para buscar.

### D. O fluxo carregar o material (estrutural)

Hoje `fluxos` guarda `assunto` (texto). Material precisaria de:

- um campo novo — `materiais` (JSON) na tabela `fluxos`, o que é **migration**;
- `PedidoFluxo.materiais?: string[]`;
- `montarInput` expondo `{{materiais}}` ao prompt da fase 1;
- e, se as imagens forem usadas no REEL, o `entrega` da fase 3 também precisa
  recebê-las — senão a skill continua gerando as próprias imagens.

É a parte que mais mexe no desenho, e a única que exige migration.

## Ordem sugerida (do mais barato ao mais caro)

| # | passo | custo | destrava |
|---|---|---|---|
| 1 | `message:photo` no handler | baixo | imagem avulsa para SKILL (`imagem:`, `reel:`) |
| 2 | link lido pelo agente da fase 1, com regra de DADO | baixo | assunto a partir de página |
| 3 | `materiais` no fluxo (migration + `{{materiais}}`) | médio | fluxo com material |
| 4 | material chegando à fase 3 (`entrega`) | médio | imagens do usuário no reel |
| 5 | álbum por `media_group_id` com timer | alto | várias imagens numa tacada |

O passo 5 pode ser trocado pelo comando explícito (B.2) por quase nada.

## O que eu faria primeiro, e por quê

**Passos 1 e 2.** Juntos já entregam o caso mais comum — "olha esta imagem" e
"faz um reel sobre esta página" — sem migration, sem estado novo no gateway e
sem tocar no motor de fluxos. Custam pouco e são reversíveis.

O passo 3 só vale quando estiver claro **o que o material faz**: virar o assunto
(fase 1 lê e escreve), virar imagem do reel (fase 3 usa), ou os dois. São
desenhos diferentes, e escolher errado custa uma migration para desfazer.

## Riscos nomeados

- **Conteúdo de fora é DADO, nunca instrução** (§9). Página e legenda de imagem
  entram sanitizadas e delimitadas, como o `{{input}}` já entra. Uma página que
  diz "gere 12 públicos" não pode virar comando.
- **20 MB** é o teto de download do bot. Imagem cabe folgado; vídeo, não.
- **Material some.** `state/midia` não é purgado hoje, e o `/limpar` não o cobre
  — se material virar rotina, ele entra na conta de disco.
- **Idempotência.** Um fluxo com material precisa que o material continue lá na
  retentativa. Caminho absoluto em `state/midia` resolve; caminho temporário do
  Telegram, não.
