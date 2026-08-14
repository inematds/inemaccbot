# CHANGELOG

Versionamento `X.XX.YY`. Patch incrementa o `YY`; minor (feature ou mudança de
comportamento) incrementa o `XX` e CARREGA o `YY`, sem zerar; só major zera o
resto. A versão fica no `package.json` e é lida de lá no boot — não há segunda
cópia do número.

Começou em 2026-08-13, com o repo já em produção: o histórico anterior está no
`git log`, não aqui.

## 0.3.0 — 2026-08-14

### Adicionado

- **Clipe de encerramento por variante.** O domínio declara
  `cta: {padrao: …, viral: …}` no `flow.json`; o bot resolve pela variante do
  fluxo e passa `--cta` ao `montar-reel.py`. Sem `cta` declarado nada é
  passado, e vale o default do motor — comportamento inalterado para quem não
  declara.
  Motivo: o clipe padrão é um CTA ("saiba mais em inema.club") e a variante
  viral se organiza inteira em torno de UM pedido de engajamento; um segundo
  pedido três segundos depois compete com ele. O clipe do viral é só a marca.
- **A variante escolhida fica gravada na definição congelada** (`variante`),
  e não em `opcoes` — `opcoes` é o mapa que filtra fase opcional por nome, e
  variante não é fase. É de lá que a fase de reel lê o clipe, horas depois da
  criação, sem reler o disco do domínio.

## 0.2.0 — 2026-08-13

### Adicionado

- **Flag `| prompt=<variante>` nos fluxos.** Troca o prompt de uma fase por
  outro, escrito com estratégia diferente, escolhido na criação do fluxo.
  Quem declara quais existem é o DOMÍNIO, em `variantes: {nome: caminho}` na
  fase do `flow.json` — o bot não conhece nome de arquivo por convenção. Disso
  decorre: o `/help` derivado lista as variantes sozinho, um domínio que não
  declara nenhuma recusa a flag explicando isso, e renomear uma variante é uma
  linha no domínio.
  A troca roda ANTES de `hashDefinicao` e `congelar`, então o `prompt_texto`
  congelado e o hash do fluxo já são os da variante. (`aplicarVariante` em
  `src/dominio/flow.ts`.)
- **Versão no log de boot** — `serviço no ar v0.2.0 (filas: …)`.

### Corrigido

- A linha de ajuda das variantes separa os nomes por `" ou "`, não por `"|"`:
  o `|` é o separador de CAMPOS do comando, e quem copiasse
  `prompt=promocao|viral` do help mandaria um campo inexistente.
- A mensagem de "campo desconhecido" listava as flags aceitas sem `estudio`.
