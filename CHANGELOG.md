# CHANGELOG

Versionamento `X.XX.YY`. Patch incrementa o `YY`; minor (feature ou mudança de
comportamento) incrementa o `XX` e CARREGA o `YY`, sem zerar; só major zera o
resto. A versão fica no `package.json` e é lida de lá no boot — não há segunda
cópia do número.

Começou em 2026-08-13, com o repo já em produção: o histórico anterior está no
`git log`, não aqui.

## 0.16.6 — 2026-08-22

**`{{molde}}?` no `portao.mostrar`: material que às vezes existe.** O Suno
entrega DUAS faixas e o musicavideo declarava uma só — a segunda ficava no
disco, paga no mesmo US$ 0,08, e nunca era ouvida (MVD#96). Declarar a segunda
como molde obrigatório resolveria isso e criaria outro defeito: com
`--faixa-pronta` existe UMA faixa, e o portão avisaria "não consegui resolver"
justamente no fluxo em que a pessoa trouxe a música dela. Com o `?`, molde que
não resolve segue calado; sem ele, o aviso continua — portão mudo continua sendo
defeito.

Campo PRÓPRIO (`musica_alt:`) e não uma segunda linha `musica:`: quem lê o
recibo pega a ÚLTIMA ocorrência do campo (é assim que a linha de progresso
`musica: pronto → …` não vira caminho), e repetir o nome trocaria a faixa
escolhida pela alternativa.

Vale para o que vier: fluxo já criado carrega a definição CONGELADA, então o
MVD#96 não passa a entregar a faixa-2 — o recibo dele já está escrito.

## 0.15.6 — 2026-08-22

**A tentativa 2 de uma fase destacada nascia vencida.** O guard do `cli.rodar`
media `agora - criado_em` contra `espera.timeout` — o mesmo número que a
vigília da tentativa 1 já tinha gasto INTEIRO. Toda tentativa 2 falhava em
segundos sem disparar nada, e o `max_tentativas: 2` era decoração em qualquer
skill com `aguarda_artefato`. Agora o prazo é o ORÇAMENTO do job
(`espera.timeout × max_tentativas`), contado do primeiro início e não do
enfileiramento — fila cheia não consome mais o prazo de trabalho.

**E o `cli.rodar` não gravava `.pid`.** O `reel.montar` grava desde sempre; esta
rota não, então `processoVivo` devolvia sempre `null` e a decisão caía no log
parado da 0.14.6. O `analisevideo` ficou mais de 20 min sem escrever no
`.log` durante a análise, foi declarado morto — e terminou BEM 50 min depois, com o job já
`failed` e a análise no disco sem entrega (jobs 5121/5122, 2026-08-22). Com o
`.pid`, o veredito volta a ser o processo; e sem ele o teto maior acima
re-dispararia comando caro por cima de um vivo.

Também: recibo que chega ATRASADO vence o prazo vencido — trabalho feito e pago
não se joga fora.

Fica de fora, de propósito: recibo órfão de job já `failed` continua sem
entrega automática (o 5121 foi entregue à mão), e a fase `texto/transcrever` do
job 5120 tem causa própria, não mexida aqui.

## 0.14.6 — 2026-08-22

**Adotar trabalho destacado agora exige prova de vida.** Sem `.pid`,
`processoVivo` devolve `null` — e "não sei" estava valendo como "espere". Um
`.log` de ontem bastava para a tentativa seguinte adotar um processo morto e
ficar 180 min olhando um arquivo que ninguém escrevia, com a fila `render`
(1 por vez) parada atrás. Foi o que matou MVD#90 e MVD#91, duas vezes cada.

Agora o `.log` é a segunda prova: o domínio escreve nele a cada shot, então
20 min sem escrita conta como parado. `.pid` vivo continua mandando mais que o
relógio — declarar morto quem está só lento custaria a geração já paga.

## 0.13.6 — 2026-08-22

**O dreno do `/dados` agora chega em produção.** A 0.12.5 criou o `aposResponder`
e a 0.13.5 destravou o portão, mas o adaptador real do Telegram não repassava o
dreno ao `criarBot` — o comando seguia mudo. O teste passava porque o transporte
falso chamava o hook direto, ou seja, testava o lado errado da fronteira. O
campo virou OBRIGATÓRIO em `criarBot` (o compilador cobra quem monta o bot) e o
teste novo bate no handler de verdade, provando que o dreno sai DEPOIS da
resposta.

## 0.13.5 — 2026-08-22

**O portão do musicavideo abria mudo — e ninguém sabia.** A entrega do que o
`portao.mostrar` declara iterava sobre os ALVOS do fluxo. Um fluxo cujas fases
são todas de escopo `fluxo` (o musicavideo inteiro) não tem alvo nenhum: a
lista vinha vazia, o laço não rodava, e o plano, a música e a capa nunca
chegavam ao chat — sem nem o aviso de que algo faltou. Agora, lista vazia
entrega uma vez, com alvo vazio. O promoavatar não muda: lá a fase de texto é
de escopo fluxo mas usa `{{alvo}}` para achar o roteiro de cada público.

**O campo do recibo vale pela ÚLTIMA ocorrência.** O domínio narra enquanto
trabalha e imprime o bloco `campo: valor` no fim. O musicavideo escreve
`musica: pronto → faixa-1.mp3 (US$ 0.08)` no meio e o caminho real no fim —
pegar a primeira ocorrência entregava a frase de progresso como se fosse
arquivo. Vale para `{{artefato:campo}}` e `{{anterior:campo}}`.

## 0.12.5 — 2026-08-22

A capa virou arte, e a entrega ao canal virou pacote.

**Arte da capa (musicavideo).** A imagem do gerador passou a ser o FUNDO: o
título é composto por cima por função, e cada template de capa declara a sua
tipografia. A crua fica guardada, então recompor não custa nada.

**Entrega ao canal.** O `canal` declarado nos alvos do `flow.json` deixou de ser
decorativo. Quando uma fase de escopo `fluxo` escreve `publicacao: <pasta>` no
recibo, o fim do fluxo leva essa pasta para `imports/<lote>/` do projeto do
canal — um lote próprio, IRMÃO do `videos` que o reel usa, nunca dentro dele.
O pacote leva vídeo, título, descrição e capa 16:9 com `manifest.json`: o
destino não precisa refazer nada disso. O caminho do reel segue como estava —
arquivo solto, nome = título.

Falhar a entrega não derruba o fim do fluxo: o pacote continua no disco e o
caminho vai na mensagem.

**`/dados` voltou a entregar.** O dreno dos avisos de fluxo estava pendurado só
na notificação de JOB: com a fila vazia, `/dados` anunciava a reentrega e o
material ficava no buffer até o próximo job — que podia ser nunca. Agora o
gateway drena depois de responder a qualquer comando.

## 0.11.4 — 2026-08-21

O dia em que o agente saiu das fases onde ele não pensava — e o contrato entre
bot e domínio passou a ser declarado em vez de narrado. Tudo nasceu da primeira
execução real do musicavideo (MVD#87 a #91), que falhou seis vezes seguidas, uma
por silêncio do contrato.

### Adicionado

- **`cli.rodar`** — a fase declara `comando` no `flow.json` e o BOT executa, sem
  agente lendo prompt para digitar bash. Validado na CARGA (exige `{{repo}}`,
  recusa `kind: agent`, vocabulário de marcadores fechado); texto do chat entra
  sempre ASPADO; o recibo é nomeado pelo bot. Com `espera`, dispara destacado e
  vigia — o mesmo contrato de marcadores do `reel.montar`, então `render.ts`
  serve aos dois. O musicavideo foi portado: 4 fases de agente viraram 4
  comandos, e 23 KB de prompt foram apagados.
- **Skill sem agente** — `comando` + `kind: function` no `config/skills.json`
  (`sem_agente: true` no manifesto, e a `invocacao` que já existia vira o
  comando). O `analisevideo` pagava um modelo para montar uma linha de bash; o
  modelo destacava o processo (proibido no prompt), o job morria sem contrato e
  a análise ia junto. O que volta ao chat é o ARTEFATO que o domínio imprimiu,
  conferido contra `artefato_exts` e contra o disco.
- **`portao.mostrar`** — o DOMÍNIO declara o que o portão manda no chat, com
  `{{artefato:campo}}` lendo o recibo da fase. Texto vai inline, áudio e imagem
  vão como ARQUIVO, vídeo vai como LINK publicado (mp4 de música passa dos 50 MB
  do Telegram). Antes o portão só sabia a convenção do promoavatar, e abria mudo
  para qualquer outro domínio.
- **`/<fluxo> status`** — a palavra que todo mundo digita deixou de criar um
  fluxo com o assunto "status".
- **O plug IMPORTA do domínio** — repo com `flow.json` próprio é a FONTE, e o
  manifesto se atualiza a partir dele (`IMPORTAR`), inclusive nas remoções
  (`DESCARTAR`). Antes a definição chutada por um modelo competia de igual para
  igual com a que o domínio versiona.
- **O plug confere mais** — `validar-repo` roda o validador REAL contra o
  `flow.json` do repo (ninguém rodava, nos caminhos em que o repo é a fonte),
  `conferir-comandos` verifica que o script declarado existe, e `conferir-fontes`
  tirou o `requer.fontes` do limbo de campo validado e ignorado.

### Corrigido

- **Recibo que anuncia erro não é sucesso**, mesmo com o `RESULT:` correto: o
  guarda do A#17 só cobria o resgate pelo arquivo. Um `erro:` no recibo abria o
  portão e mandava a fase seguinte rodar sobre trabalho que não existia.
- **`| legenda=nao` voltou a fazer algo** — era aceito e morria: só substituía
  `{legenda}` num campo `entrega` que nenhum domínio tem desde que o reel virou
  função. Agora viaja na definição congelada e vira `--sem-legenda`.
- **`| sem-portao` deixou de ser mudo** — tirava a pausa e levava junto tudo o
  que a fase mandaria no chat.
- **"código null"** era o serviço matando o comando: agora a falha nomeia o
  sinal e as causas, em vez de culpar o domínio.
- **O `/comando` ecoado** (copiar e colar a mensagem anterior) virava a primeira
  palavra do assunto.
- **Valores lidos de recibo são saneados** (uma linha, sem controles, teto de
  500 chars) — buraco aberto pelo próprio `{{artefato:campo}}`.
- **`ID_FASE` tinha duas implementações divergentes** entre manifesto e flow;
  agora é uma. Era o "segunda implementação divergiria no primeiro campo novo"
  que o comentário do `conferirDefinicao` previa.
- **`analisevideo.json` apontava `repo.pasta: "repo"`**, pasta que não existe.

## 0.10.4 — 2026-08-20

### Adicionado

- **`docs/integrar-um-repo.md`** — o **porquê** da integração por manifesto,
  que faltava: o bot conhece a FICHA do repo e não o código dele; o par de
  scripts (a metade CARA, com modelo, uma vez por repo; a BARATA,
  determinística, em toda máquina); o que o `plugar` confere antes de escrever e
  por qual defeito cada passo existe; entrada (`{{input}}`, `{{repo}}`, os três
  nomes que se confundem), contrato de saída (`RESULT:`/`ERRO:`, artefato como
  verdade), skill vs. fluxo, portões, e a tabela de modos de falha já vividos.
  Ligado no README em dois pontos: o bloco de roteamento do topo e o índice.

## 0.9.4 — 2026-08-20

### Adicionado

- **"o modelo falhou" agora diz POR QUÊ.** A CLI do claude escreve
  "não autenticado", "sem crédito" e rate limit no **stdout**, que os
  geradores desviam para o arquivo de resposta — mostrar só o stderr produzia
  um `✗ o modelo falhou` sem uma linha de motivo, tendo o motivo no disco.
  Os quatro pontos de chamada (`gerar-manifesto` e `gerar-manifesto-fluxo`,
  manifesto e prompt/fases) passam a imprimir código de saída, stderr E
  stdout, o comando para conferir a CLI sozinha, e o lembrete de que esta
  metade do par precisa de modelo — na VPS roda-se só o `plugar-*`.

## 0.8.4 — 2026-08-20

### Corrigido

- **`gerar-manifesto-fluxo.sh` por URL nascia com `repo.pasta: "repo"`** — o
  mesmo `basename` da pasta temporária do clone que a 0.8.1 consertou no
  `gerar-manifesto.sh` e que passou batido no irmão. O nome agora sai da URL.
  A falha não aparecia na geração (a tela de revisão só mostrava `pasta repo`):
  aparecia no `plugar-fluxo`, procurando o clone em `~/projetos/repo`.

## 0.8.3 — 2026-08-20

### Corrigido

- **Comentário no fim da linha do `.env` entrava no `PROJETOS_DIR` dos
  scripts.** O boot já sabia disso (`lerEnv` corta ` # ...` fora de aspas), mas
  o `sed` do `plugar-repo`/`plugar-fluxo` não — e com
  `PROJETOS_DIR=/root/projetos   # default: ...` no `.env` da VPS o script
  procurava o clone e o cofre em `/root/projetos          # default: $HOME/...`.
  O erro que aparecia era "faltando (ou vazia) no cofre …: GOOGLE_API_KEY",
  culpando a chave em vez do caminho. Agora as duas leituras fazem a mesma
  limpeza (aspas, comentário só depois de espaço, espaço à direita).

## 0.8.2 — 2026-08-20

### Corrigido

- **`dist/` VELHO contava como presente nos scripts de plugar/gerar.** Eles
  compilavam só quando o `dist/` faltava; um `git pull` na VPS traz `src/` novo
  e deixa o `dist/` para trás, e o helper morria com
  `SyntaxError: ... does not provide an export named 'inserirEntradaFluxo'` no
  meio do passo 1 — ilegível para quem só queria plugar um repo. Agora vale a
  mesma regra do `start.sh`: qualquer `.ts` mais novo que `dist/index.js`
  dispara o build. Vale nos quatro (`plugar-repo`, `plugar-fluxo`,
  `gerar-manifesto`, `gerar-manifesto-fluxo`).

## 0.8.1 — 2026-08-20

### Adicionado

- **O `{{repo}}` do prompt passou a ser RESOLVIDO de verdade.** O
  `gerar-manifesto` sempre mandou o prompt citar `{{repo}}/script.sh` em vez de
  um caminho de máquina — é o que faz o prompt viajar para a VPS — e o próprio
  gerador dizia ao modelo que "o `{{repo}}` já vem resolvido pelo bot". Não
  vinha: a montagem do prompt só conhecia `input`, `saida` e os campos
  declarados, e `renderizarPrompt` derruba o job em placeholder sem valor.
  Ou seja, TODA skill plugada por manifesto morreria no primeiro job real,
  depois de a instalação inteira ter dito "plugado". Agora a entrada de
  `config/skills.json` carrega `repo` (NOME da pasta do clone, nunca caminho
  absoluto) e a execução o resolve contra o `PROJETOS_DIR` do boot — o mesmo
  contrato dos fluxos. Pego pela suíte que o `plugar-repo` roda no fim, ao
  plugar o `analisevideo`.
- **`stop.sh`** na raiz, gêmeo do `start.sh`: para o serviço e mata um
  `node dist/index.js` solto (um `start.sh` esquecido continua disputando o
  `getUpdates` com a próxima subida). Recusa parar quando há job em voo —
  restart mata render em andamento —, e `--forcar` passa por cima.
- Skill `analisevideo` plugada: análise visual/cinematográfica de vídeo com
  Gemini, fila `io`.

## 0.7.1 — 2026-08-20

### Adicionado

- **A definição do manifesto passa pelo validador REAL do `flow.json`.** O
  `plugar-ajuda validar-fluxo` materializa a definição num diretório
  TEMPORÁRIO e chama `carregarFlow` ali. Sem isso, um campo que o esquema do
  manifesto não exige atravessava a geração inteira e só era recusado no
  PRIMEIRO COMANDO do fluxo — depois de já estar escrito no repo de domínio.
  Foi o caso do `versao_def`: obrigatório no `flow.json`, ausente do prompt do
  gerador, invisível para o esquema do manifesto. Validar num temporário porque
  validar não pode escrever no repo dos outros.
- `docs/plugar-fluxo.md` ganhou **roteiro do teste na VPS**, limites conhecidos,
  estado da verificação e tabela sintoma → conserto.

### Corrigido

- **`PROJETOS_DIR` era ignorado pelos scripts.** `plugar-fluxo` e `plugar-repo`
  assumiam a pasta-pai do clone; o bot lê a variável (ambiente, senão `.env`,
  senão a pasta-pai). Na VPS o `.env.example` traz `PROJETOS_DIR=/root/projetos`,
  então os dois validariam contra árvores diferentes: "plugou" no script,
  `diretório não existe` no boot. Agora os scripts seguem a MESMA ordem do bot.
- **Rodar `--sim` duas vezes destruía o backup**, nos dois scripts: a segunda
  rodada salvava um arquivo que já continha a entrada, e `--desfazer`
  "restaurava" exatamente o que se queria desfazer. O backup passa a ser criado
  só quando ainda não existe (é o estado de ANTES do primeiro plug), e o
  `--desfazer` o consome.
- O prompt do gerador agora pede `versao_def` e aceita prefixo de 1 a 3 letras
  (o validador sempre aceitou; o prompt pedia uma).

## 0.6.1 — 2026-08-20

### Corrigido

- **O rascunho do manifesto sobrevive à falha de validação.** Os dois geradores
  diziam "edite à mão: `$TMP/manifesto.json`" num script cujo `trap` acabara de
  apagar o `$TMP` — instrução impossível de seguir, jogando fora as chamadas de
  modelo já pagas. Agora o rascunho é copiado para
  `config/integracoes/<nome>.json.rascunho` ANTES de validar, e removido no
  sucesso. Achado rodando o gerador de fluxo pela primeira vez de verdade.
- **Manifesto de fluxo inválido vai para a REVISÃO, não para a morte.** O
  gerador morria e descartava o desenho inteiro por causa de um campo — na
  primeira rodada real, o modelo escreveu a marca de confiança como
  `flow.alvos` em vez de `definicao.flow.alvos` e as quatro chamadas foram para
  o lixo. Agora o erro cai na tela de revisão, que já sabe editar e revalidar; e
  `[enter]` recusa aceitar enquanto estiver inválido, porque aceitar só adiaria
  a mesma falha para o `plugar-fluxo`, numa máquina que talvez não tenha modelo.
- **`plugar-fluxo.sh` apontava um comando inexistente** (`gerar-manifesto.sh
  --fluxo`) na mensagem que aparece justamente para quem não tem manifesto. O
  script irmão chama-se `gerar-manifesto-fluxo.sh`.
- O prompt do gerador agora exige o caminho COMPLETO na marca de confiança.

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
