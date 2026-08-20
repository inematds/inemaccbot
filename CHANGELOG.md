# CHANGELOG

Versionamento `X.XX.YY`. Patch incrementa o `YY`; minor (feature ou mudança de
comportamento) incrementa o `XX` e CARREGA o `YY`, sem zerar; só major zera o
resto. A versão fica no `package.json` e é lida de lá no boot — não há segunda
cópia do número.

Começou em 2026-08-13, com o repo já em produção: o histórico anterior está no
`git log`, não aqui.

## 0.5.0 — 2026-08-20

### Adicionado

- **Motores `codex` e `opencode` como alternativa ao `claude`.** O worker já
  escolhia o motor pelo NOME (`RUNNERS[perfil.motor]`) e `RUNNERS` já era
  dicionário aberto — faltava quem atendesse por outro nome. Ligar não muda nada
  no caminho de quem pede `claude`: liga-se por job (`| motor=codex`), por skill
  (`config/skills.json`) ou pelo `.env` (`MOTOR_PADRAO`).
  Os dois runners herdam do `ClaudeRunner` toda a maquinaria de processo (process
  group próprio, timeout de parede, teto de 4 MB, matar a ÁRVORE no
  cancelamento); o que cada um define é a função PURA que traduz o perfil em
  flags. Docs: [`docs/motor-codex.md`](docs/motor-codex.md) e
  [`docs/motor-opencode.md`](docs/motor-opencode.md).
- **`CODEX_BIN` / `OPENCODE_BIN`** — binário por CAMINHO, não pelo PATH, pelo
  mesmo motivo do `CLAUDE_BIN` (PATH do systemd é mínimo; C#77/C#78).
  Ausente **não** derruba o boot: motor alternativo é opcional por desenho, o
  serviço avisa no log e só falha quem pedir por ele. A exceção é `MOTOR_PADRAO`
  apontando para binário inexistente — aí é erro de boot, com o caminho na
  mensagem.
- **`CODEX_MODELOS` / `OPENCODE_MODELOS`** — tradução alias → id do motor, no
  runner. Vazio por padrão: chutar um id para cada alias faria todo job quebrar
  no dia em que o fornecedor renomeasse um modelo. Sem mapa, vale o modelo
  configurado na própria CLI. `MODELOS_RANK` do domínio não muda — o alias
  continua sendo o vocabulário do bot.

### Notas

- O `codex` foi verificado com `codex exec` real: o contrato `RESULT:` é extraído
  mesmo com o ruído do CLI — num run real ele **não** foi a última linha do
  stdout, e `ultimaLinhaCasando` fica com a última linha que CASA.
- O `opencode` **não** foi verificado contra a CLI real (não instalada na
  máquina). O doc traz o roteiro de verificação e a tabela sintoma → conserto.
- As skills que começam com "Use a skill X" (`explicativo`, `curso`, `demo`,
  `reel`, `reelinematds`, `reelpromo`) são conceito de Claude Code e **falham em
  silêncio** em qualquer outro motor: elas improvisam em vez de dizer que não
  acharam a skill. Mantenha `"perfil": { "motor": "claude" }` nelas antes de
  mexer no `MOTOR_PADRAO`.

## 0.4.0 — 2026-08-14

### Mudado

- **Painel de fluxos: só número.** As linhas com os nomes dos alvos `rodando` e
  `esperando você` saíram do painel e ficaram só no detalhe (`/status C#67`).
  Com 36 alvos elas empurravam o fluxo seguinte para fora da tela — o painel
  passou de 13 para 8 linhas por fluxo.
  As contagens ganharam dois algarismos (`01/36`, `07/36`) para os números
  começarem na mesma coluna, e a palavra de cada estado virou uma legenda única
  no rodapé. `pendente` ganhou ícone próprio no painel (⏳): o dele era `·`, o
  mesmo separador da linha, e sem a palavra ao lado `29 ·` não significava nada.
- **Ajuda de domínio em duas camadas.** `/<fluxo> help` responde o cartão mais o
  menu de seções; `/<fluxo> help <seção>` responde só ela. As seções são os
  `## ` do próprio `HELP.md` — casam sem acento e por prefixo. `HELP.md` sem
  `## ` nenhum volta inteiro, como antes (é o caso do promoavatar).
  Vale para `/ajuda <fluxo> <seção>` também.

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
