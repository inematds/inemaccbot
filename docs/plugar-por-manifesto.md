# Plugar um repo por manifesto — o par `gerar-manifesto` + `plugar-repo`

Automação da rota A (skill de catálogo) do
[`instalar-analisevideo.md`](instalar-analisevideo.md), que continua sendo a
referência do caminho manual das duas rotas.

Você roda **dois comandos, uma vez cada**:

```bash
# 1) onde há um modelo (sua máquina): analisa o repo e propõe
./scripts/gerar-manifesto.sh https://github.com/inematds/analisevideo
      → tela de revisão → você aceita ou edita
      → grava config/integracoes/<nome>.json + prompts/<nome>.md
      → git commit && git push

# 2) onde o bot roda (VPS): aplica, sem modelo nenhum
git pull
./scripts/plugar-repo.sh analisevideo          # mostra o diff e PARA
./scripts/plugar-repo.sh analisevideo --sim    # grava
```

Depois de reiniciar o serviço, `/analisevideo <link>` existe no Telegram.

## Por que são dois programas

Porque as duas metades têm naturezas opostas, e juntá-las estragaria a segunda:

| | `gerar-manifesto` | `plugar-repo` |
|---|---|---|
| Precisa de modelo | **sim** — lê o repo e julga | **não** |
| Roda quantas vezes | uma por repo, na vida | quantas quiser, em cada máquina |
| Determinístico | não | **sim** — mesma entrada, mesmo resultado |
| Onde | sua máquina | VPS, CI, outra VPS |

Ler o `SKILL.md`, o `README` e o **código** do script para decidir fila, timeout,
extensão de saída e — principalmente — escrever o prompt com as armadilhas do
repo é julgamento. Instalar não deveria ser: uma instalação que depende de LLM
falha de formas novas a cada execução, e duas VPS acabariam com configs
diferentes para o mesmo repo. Por isso o resultado do passo 1 é **versionado**:
o passo 2 é replay, não nova decisão.

A VPS ainda precisa do `claude` — toda skill `kind: agent` roda um agente, é o
motor do bot. O que a separação garante é que **plugar** não depende de modelo.

## O manifesto

Um arquivo por repo, em `config/integracoes/<nome>.json`. Esquema completo e
validador: `src/dominio/manifesto.ts` (com testes em `manifesto.test.ts`).

```json
{
  "manifesto": 1,
  "rota": "skill",
  "command": "analisevideo",
  "repo": { "url": "https://github.com/inematds/analisevideo.git", "commit": "2b16f14" },
  "invocacao": "bash {{repo}}/analisevideo.sh analisa \"{{input}}\"",
  "fila": "io",
  "artefato_exts": ["md", "json"],
  "timeout_segundos": 1800,
  "max_tentativas": 2,
  "aceita_destino": false,
  "requer": { "bin": ["yt-dlp", "ffmpeg", "jq"], "chaves": ["GOOGLE_API_KEY"], "fontes": [] },
  "prompt": "prompts/analisevideo.md",
  "descricao": "o que aparece no /ajuda",
  "exemplo": "analisevideo: https://youtube.com/watch?v=XXXX",
  "gerado": { "em": "2026-08-20", "por": "claude", "confianca": { "fila": "chute" } }
}
```

Os campos que carregam decisão de projeto:

- **`manifesto`** é a versão do **esquema**, não do bot. O bot declara o que
  entende (`SCHEMAS_SUPORTADOS`) e recusa o resto dizendo o que fazer. Um
  `"inemaccbot": ">=0.5"` obrigaria cada repo a saber a versão de um projeto que
  ele não controla, e envelheceria no primeiro bump feito por outro motivo.
- **`invocacao`** exige `{{repo}}` e `{{input}}`, e recusa caminho absoluto. É o
  defeito real do `SKILL.md` do `analisevideo`, que aponta para a máquina de
  quem o escreveu. Ponha `{{input}}` **entre aspas**: entrada com espaço ou `&`
  quebra a linha de comando (o script avisa se faltarem).
- **`requer.chaves`** é o **nome** da variável, jamais o valor — o manifesto é
  versionado e o `origin` é público. Valor com `=` é recusado. O `plugar-repo`
  confere no cofre (`~/projetos/wifi/.env`), e **chave vazia conta como
  faltando**: `CHAVE=` passa em qualquer teste de existência e só falha no
  primeiro job, com um erro do provedor que não menciona o cofre.
- **`repo.pasta`** (ou, na falta dele, o `command`) vira o campo `repo` da
  entrada em `config/skills.json`, e é o que dá valor ao **`{{repo}}` do
  prompt** na hora do job: a execução o resolve contra o `PROJETOS_DIR` do
  boot. Por isso o prompt pode — e deve — citar `{{repo}}/script.sh` em vez de
  um caminho de máquina, sem parar de funcionar na VPS.
- **`repo.commit`** é proveniência: o manifesto foi escrito olhando **um**
  commit. Se o repo andou, o `plugar-repo` avisa em vez de aplicar às cegas.
- **`gerado.confianca`** marca cada campo como `lido` (está escrito no repo) ou
  `chute` (o modelo deduziu). É o que a tela de revisão destaca — sem isso,
  revisar dez linhas iguais vira "ok" automático. Aceita caminho pontuado
  (`requer.bin`), porque a confiança costuma diferir por sub-campo.
- **`fila`** é raia de concorrência, não categoria: `texto`, `io`, `render`,
  `navegador`, `cpu`.
- **`artefato_exts`**: a **primeira** nomeia o arquivo que o bot espera
  (`<artefatos>/<command>/<id>.<ext>`).

## Preparar um repo SEU: `preparar-repo.sh`

```bash
./scripts/preparar-repo.sh ~/projetos/<repo>
```

Mesmo motor do `gerar-manifesto`, outro destino: grava **dentro do repo**
(`integracao.json` na raiz + `prompts/<nome>.md`) em vez de dentro do bot. O
repo passa a declarar como ser plugado, e qualquer instalação do inemaccbot o
pluga só com o nome — sem adaptador do lado do bot.

Quando usar cada um:

| | grava em | serve para |
|---|---|---|
| `gerar-manifesto` | bot (`config/integracoes/`) | repo de **terceiro**, ou quando o manifesto do repo não serve à sua máquina |
| `preparar-repo` | repo (`integracao.json`) | repo **seu**, preparado uma vez e plugável em qualquer bot |

Ele **não comita nem faz push** no seu repo — deixa os arquivos e imprime o
comando. Mexer no git de outro projeto é decisão sua.

Duas checagens a mais nesse modo, porque o que fica no repo viaja para máquinas
que você não controla:

- **caminho absoluto no prompt** (`/home/...`, `/root/...`) é apontado linha a
  linha: num repo isso não viaja, e o certo é `{{repo}}`;
- **`repo.pasta`** é preenchido com o nome da pasta do clone. O `command` do chat
  não precisa ter o nome do repositório (`roda` num repo `repoprep`), e sem esse
  campo o `plugar-repo` procuraria o clone pelo comando e não acharia.

`repo.url` é **opcional** aqui: quem lê um manifesto que está dentro do repo já
tem o clone na mão. Um repo ainda sem `remote` não precisa inventar uma URL. Do
lado do bot ela só faz falta quando o clone ainda não existe — e aí o script diz
isso.

## Duas fontes de manifesto

O `plugar-repo` procura nesta ordem:

1. `config/integracoes/<nome>.json` — o **adaptador local**, que você revisou;
2. `<clone>/integracao.json` — o que o **próprio repo** declara.

**Local vence.** É a saída para quando o manifesto do repo estiver errado, velho
ou não servir à sua máquina, sem depender de PR no projeto dos outros. E o
adaptador local é o que permite plugar repo de terceiro sem pedir commit a
ninguém.

Quando o manifesto vem do repo, com `--sim` o bot **adota**: copia o
`integracao.json` para `config/integracoes/<command>.json` e o prompt para
`prompts/<command>.md`. A partir daí vale a cópia — versionada no seu git, e
imune ao próximo `git pull` do repo alheio. Sem isso, o que governa a config do
seu bot mudaria sozinho, e a invocação é uma linha de comando que roda na sua
máquina.

Em modo seco nada é copiado: a validação roda contra uma raiz temporária que
espelha `prompts/` por symlink e sobrepõe o arquivo vindo do repo — o validador
confere o array inteiro do `skills.json`, então as outras skills precisam estar
lá.

O repo ainda não clonado pode ser passado por URL:
`./scripts/plugar-repo.sh https://github.com/dono/repo --sim`.

## O prompt conta mais que o manifesto

O gerador escreve os dois, mas eles falham de formas diferentes: manifesto
errado o validador pega; **prompt fraco não** — vira job `done` sem artefato,
que é o defeito mais caro de diagnosticar neste sistema.

O prompt carrega o contrato (`{{input}}` como DADO, `{{saida}}`, `RESULT:`,
`ERRO:`, a proibição de background e o bloco "NÃO MEXA NA MÁQUINA") e, o que
mais importa, as **armadilhas do repo**. No `analisevideo`, o parágrafo que vale
ouro é "use o caminho que o script imprimiu, porque o slug repetido vira
`<slug>-2`" — não está no `SKILL.md` nem no `README`; sai de ler o `mk_slug`.

Leia o prompt gerado uma vez antes de commitar. É o item 1 do que o gerador
imprime no fim, e não é formalidade.

## O que o `plugar-repo` confere, e onde ele para

1. **Manifesto** — sem ele, recusa. Não adivinha: adivinhar fila, timeout e
   prompt produz job que termina sem entregar arquivo.
2. **Repo** — clona/atualiza como irmão; compara o `HEAD` com o `repo.commit`.
3. **Dependências** — lista **todas** as que faltam, com o comando de instalação
   de cada uma. Não instala: o agente também é proibido, e por isso uma
   dependência ausente vira fase falhada em vez de instalação silenciosa.
4. **Chaves** — no cofre, presentes e não vazias.
5. **Prompt** — existe, e avisa se não cita `{{input}}`, `{{saida}}` ou `RESULT:`.
6. **Entrada** — monta e valida com `validarSkills`, **o mesmo validador do
   boot**, e mostra o diff. Sem `--sim`, nada é escrito.
7. Com `--sim`: backup, grava, roda suíte e build, e para. Reiniciar é seu — e
   antes disso, conferir job em voo no `/status`.

`--desfazer` restaura o backup.

A decisão está em `src/dominio/plugar.ts`, em função pura com teste. Não é
zelo: config inválida não falha no plugar, falha no **boot** — e "o bot não
sobe" é o pior modo de falha deste sistema.

## Limites

- **Só rota A.** Este par é o da SKILL. A rota B (fluxo) tem o par próprio —
  [`plugar-fluxo.md`](plugar-fluxo.md) —, e ele existe separado porque um fluxo
  não cabe do lado do bot: a definição tem que ir para DENTRO do repo de domínio.
  A invasividade que este documento apontava como impeditivo virou uma regra
  explícita lá: arquivo divergente é conflito e para a instalação, nunca
  sobrescrita, e o script não commita no repo alheio.
- **Manifesto no repo alvo já é lido**, como segunda fonte. Ver "Duas fontes"
  abaixo.
- **Manifesto é dado, nunca comando.** O `plugar-ajuda.mjs` emite tudo com aspas
  de shell porque o `plugar-repo.sh` consome com `eval`; sem isso, um valor com
  espaço vira comando executado. Aconteceu no primeiro teste: o `jq` de
  `requer.bin` rodou de verdade e travou lendo stdin.
