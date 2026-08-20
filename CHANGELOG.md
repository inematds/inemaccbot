# CHANGELOG

Versionamento `X.XX.YY`. Patch incrementa o `YY`; minor (feature ou mudança de
comportamento) incrementa o `XX` e CARREGA o `YY`, sem zerar; só major zera o
resto. A versão fica no `package.json` e é lida de lá no boot — não há segunda
cópia do número.

Começou em 2026-08-13, com o repo já em produção: o histórico anterior está no
`git log`, não aqui.

## 0.6.0 — 2026-08-20

### Adicionado

- **Rota de FLUXO no manifesto**, com o par próprio: `gerar-manifesto-fluxo.sh`
  (uma vez, com modelo) + `plugar-fluxo.sh` (determinístico, em qualquer
  máquina). Antes o validador recusava `"rota": "fluxo"` apontando o caminho
  manual. Doc: [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md).
- **O manifesto de fluxo CARREGA a definição** (`definicao.flow`,
  `definicao.prompts`, `definicao.help`) e o `plugar-fluxo` a materializa no repo
  de domínio. Sem isso o manifesto só serviria para repos que JÁ são domínio — e
  o caso que importa é o contrário. Repo que já tem `flow.json`: o manifesto sai
  só como registro.
- **`planoMaterializacao`** (`dominio/plugar.ts`) — decide o que escrever no repo
  alheio. **O repo é o dono da definição**: arquivo divergente é CONFLITO e para
  a instalação, nunca sobrescrita; conteúdo idêntico (mesmo com `\n` a mais) não
  é conflito, para que re-plugar seja operação que não faz nada.
- **`inserirEntradaFluxo`** — insere em `config/fluxos.json` validando com o
  validador do BOOT. Ele vai ao disco, e é por isso que a ordem
  materializar → registrar não é negociável: entrada apontando para repo sem
  `flow.json` derruba o serviço.
- **`plugar-ajuda.mjs`**: `validar-fluxo`, `materializar`, `entrada-fluxo`.

### Mudado

- **`Manifesto` virou união** (`ManifestoSkill | ManifestoFluxo`), com `repo`,
  `requer` e `gerado` extraídos em validadores compartilhados — duplicá-los seria
  garantir que divergissem no primeiro campo novo, e o campo novo aqui costuma
  ser uma regra de segurança.

### Notas

- **`HELP.md` curto é pior que nenhum**, e o validador agora recusa
  `definicao.help` com menos de 60 caracteres. Quando o arquivo existe,
  `ajudaDoFluxo` o usa NO LUGAR da ajuda derivada do `flow.json` (que lista
  fases, escopo e portões): um esqueleto troca a boa pela ruim e reprova a regra
  "todo domínio do catálogo é documentado". Descoberto rodando o par de ponta a
  ponta — o passo 7 do `plugar-fluxo` pegou.
- O `--desfazer` restaura `config/fluxos.json` e **não** remove o que foi
  materializado no repo de domínio: seria a única operação irreversível do
  script, num repo que não é nosso.
- O gerador extrai o catálogo de tarefas DO CÓDIGO (`TAREFAS_DE_FASE` +
  `config/skills.json`). `alvos` (canal e gatilho) sai sempre marcado como chute:
  é conhecimento de negócio e não está em código-fonte nenhum.

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
