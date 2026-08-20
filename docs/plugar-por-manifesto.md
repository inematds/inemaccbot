# Plugar um repo por manifesto — o par `gerar-manifesto` + `plugar-repo`

Automação da rota A (skill de catálogo) do
[`instalar-analisevideo.md`](instalar-analisevideo.md), que continua sendo a
referência do caminho manual e da rota B.

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

- **Só rota A.** Fluxo (rota B) exige commitar `flow.json` e `HELP.md` **dentro
  do repo plugado**, e um script que escreve em repo de terceiro é outra ordem de
  invasividade. Continua manual, pelo `instalar-analisevideo.md`.
- **Manifesto no repo alvo** ainda não é lido: hoje o adaptador mora no bot, o
  que tem a vantagem de plugar repo de terceiro sem pedir commit a ninguém. Se
  passar a ser lido, a precedência prevista é **local vence repo** — para você ter
  saída quando o manifesto do repo estiver errado.
- **Manifesto é dado, nunca comando.** O `plugar-ajuda.mjs` emite tudo com aspas
  de shell porque o `plugar-repo.sh` consome com `eval`; sem isso, um valor com
  espaço vira comando executado. Aconteceu no primeiro teste: o `jq` de
  `requer.bin` rodou de verdade e travou lendo stdin.
