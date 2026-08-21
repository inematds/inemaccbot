#!/usr/bin/env bash
# Pluga um FLUXO (repo de domínio) no bot a partir de um MANIFESTO já revisado.
#
#   ./scripts/plugar-fluxo.sh <nome>            # mostra o que faria e PARA
#   ./scripts/plugar-fluxo.sh <nome> --sim      # aplica
#   ./scripts/plugar-fluxo.sh <url>  --sim      # repo ainda não clonado
#   ./scripts/plugar-fluxo.sh <nome> --desfazer # restaura o backup da última vez
#
# Gêmeo do `plugar-repo.sh`, com UMA diferença que muda tudo: uma skill cabe
# inteira do lado do bot; um fluxo NÃO. O `carregarFlow` lê `<repo>/flow.json`
# do disco, e as fases de agente leem os prompts de lá. Por isso, quando o
# manifesto traz `definicao`, este script MATERIALIZA esses arquivos no repo de
# domínio antes de registrar o comando.
#
# Duas regras que governam a materialização:
#
#   1. O REPO é o dono da definição. Arquivo divergente é CONFLITO e para a
#      instalação — nunca sobrescrita. Idêntico não é conflito (re-plugar tem
#      que ser operação que não faz nada).
#   2. Este script NÃO commita no repo de domínio. Ele escreve e diz o que
#      commitar: commit em repo alheio, com autor que talvez não seja o certo,
#      é decisão do dono e não de um instalador.
#
# A ORDEM é obrigatória, não estilo: arquivos no repo PRIMEIRO, entrada em
# `config/fluxos.json` por ÚLTIMO. O registry de fluxos vai ao disco no boot
# (`registry-fluxos.ts`) e recusa entrada cujo repo não exista ou não tenha
# `flow.json` — registrar antes de materializar derruba o serviço.
#
# DETERMINÍSTICO: nenhum modelo no caminho. Quem lê o repo e desenha as fases é
# o `gerar-manifesto-fluxo.sh`, uma vez, numa máquina que tenha um modelo.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A árvore de projetos vem do MESMO lugar que o bot lê: `PROJETOS_DIR` do
# ambiente, senão do `.env` do repo, senão a pasta-pai do clone (o
# `PAI_DO_CLONE` de `src/config.ts`).
#
# Não é preciosismo: na VPS o `.env.example` traz `PROJETOS_DIR=/root/projetos`,
# e um script que assumisse a pasta-pai validaria a entrada contra uma árvore
# diferente da que o bot usa no boot — "plugou" aqui, "diretório não existe" no
# restart.
le_projetos_dir() {
  local do_env=""
  if [ -f "$REPO/.env" ]; then
    # As três limpezas fazem o MESMO que o `lerEnv` do boot, e por isso existem:
    # aspas, comentário no fim da linha (só depois de espaço, para não comer um
    # `#` que seja DADO) e espaço à direita. Sem a do meio,
    # `PROJETOS_DIR=/root/projetos   # default: ...` virava um caminho com o
    # comentário dentro, e o script ia procurar cofre e clone num diretório que
    # não existe — dizendo isso numa mensagem de erro ilegível.
    do_env="$(sed -n 's/^[[:space:]]*PROJETOS_DIR[[:space:]]*=[[:space:]]*//p' "$REPO/.env" \
      | tail -1 \
      | sed 's/^["'"'"']\(.*\)["'"'"']$/\1/; s/[[:space:]]#.*$//; s/[[:space:]]*$//')"
  fi
  echo "${PROJETOS_DIR:-${do_env:-$(dirname "$REPO")}}"
}
PROJETOS="$(le_projetos_dir)"
COFRE="$PROJETOS/wifi/.env"
FLUXOS="$REPO/config/fluxos.json"

APLICAR=0
DESFAZER=0
NOME=""
for a in "$@"; do
  case "$a" in
    --sim) APLICAR=1 ;;
    --desfazer) DESFAZER=1 ;;
    -*) echo "opção desconhecida: $a" >&2; exit 2 ;;
    *) [ -z "$NOME" ] && NOME="$a" || { echo "nome repetido: $a" >&2; exit 2; } ;;
  esac
done
[ -n "$NOME" ] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$1"; }
morre() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
titulo(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

case "$NOME" in
  https://*|git@*) URL_ARG="$NOME"; NOME="$(basename "$NOME" .git)" ;;
  *) URL_ARG="" ;;
esac
MANIFESTO="$REPO/config/integracoes/$NOME.json"
CLONE="$PROJETOS/$NOME"
BACKUP="$FLUXOS.bak-$NOME"
ORIGEM=local

if [ "$DESFAZER" = 1 ]; then
  titulo "Desfazer"
  [ -f "$BACKUP" ] || morre "não há backup de $NOME ($BACKUP)"
  cp "$BACKUP" "$FLUXOS"
  # Consome o backup: sem isto, um `--sim` depois deste `--desfazer` acharia um
  # backup velho e o preservaria, e o próximo `--desfazer` voltaria para um
  # estado de duas operações atrás.
  rm -f "$BACKUP"
  ok "config/fluxos.json restaurado do backup"
  # Os arquivos materializados NÃO são removidos, e isso é deliberado: eles
  # estão num repo que não é nosso, podem ter sido editados desde então, e um
  # `rm` ali seria a única operação irreversível do script inteiro.
  #
  # A pasta sai do MANIFESTO, não do nome digitado: `repo.pasta` pode diferir do
  # comando (o chat não precisa usar o nome do repositório), e apontar a pasta
  # errada numa instrução de apagar arquivos é pior que não apontar nenhuma.
  PASTA_DESFAZER="$NOME"
  if [ -f "$MANIFESTO" ]; then
    PASTA_DESFAZER="$(node -e "
      const m = require('$MANIFESTO');
      process.stdout.write(m.repo?.pasta || m.command || '$NOME');
    " 2>/dev/null || echo "$NOME")"
  fi
  aviso "os arquivos materializados em $PROJETOS/$PASTA_DESFAZER (se houve) NÃO foram removidos — o repo é o dono; apague você se quiser"
  aviso "recompile (npm run build) e reinicie o serviço para valer"
  exit 0
fi

titulo "1. Manifesto"
if [ -f "$MANIFESTO" ]; then
  ok "manifesto local: config/integracoes/$NOME.json"
else
  if [ ! -d "$CLONE/.git" ] && [ -n "$URL_ARG" ]; then
    git clone "$URL_ARG" "$CLONE" >/dev/null 2>&1 || morre "clone falhou: $URL_ARG"
    ok "clonado em $CLONE (para ler o manifesto dele)"
  fi
  if [ -f "$CLONE/integracao.json" ]; then
    MANIFESTO="$CLONE/integracao.json"
    ORIGEM=repo
    aviso "sem adaptador local — usando o manifesto DO REPO ($CLONE/integracao.json)"
  else
    morre "não há manifesto para \"$NOME\"
     Procurei em:  config/integracoes/$NOME.json
                   $CLONE/integracao.json
     Gere um numa máquina com modelo:  ./scripts/gerar-manifesto-fluxo.sh <url-do-repo>"
  fi
fi

if [ ! -f "$REPO/dist/index.js" ] || [ -n "$(find "$REPO/src" -name '*.ts' -newer "$REPO/dist/index.js" -print -quit 2>/dev/null)" ]; then
  aviso "dist/ ausente ou desatualizado — compilando antes de validar"
  (cd "$REPO" && npm run build >/dev/null)
fi

VARS="$(node "$REPO/scripts/plugar-ajuda.mjs" validar-fluxo "$MANIFESTO")" || morre "manifesto inválido"
eval "$VARS"
CLONE="$PROJETOS/$M_PASTA"
[ "$M_PASTA" = "$NOME" ] || ok "clone esperado em $M_PASTA (o comando é $M_COMMAND)"
ok "manifesto de fluxo válido: /$M_COMMAND"
[ -n "$M_CHUTES" ] && aviso "campos que o gerador CHUTOU (confira se ainda valem): $M_CHUTES"
# `alvos` sem revisão é o erro caro desta rota: canal e gatilho são do NEGÓCIO,
# não do repo — nenhum modelo os lê de um código-fonte.
case " $M_CHUTES " in
  *" definicao "*|*" definicao.flow "*)
    aviso "a DEFINIÇÃO foi chutada: confira canal e gatilho de cada alvo antes do --sim" ;;
esac

titulo "2. Repo de domínio"
if [ -d "$CLONE/.git" ]; then
  ok "clone existe: $CLONE"
  if [ "$APLICAR" = 1 ]; then (cd "$CLONE" && git pull --ff-only >/dev/null 2>&1) && ok "atualizado" || aviso "git pull falhou — seguindo com o que está no disco"; fi
else
  [ -n "$M_URL" ] || morre "o repo não está em $CLONE e o manifesto não traz repo.url
     Clone-o você, ou rode com a URL: ./scripts/plugar-fluxo.sh <url> --sim"
  if [ "$APLICAR" = 1 ]; then
    git clone "$M_URL" "$CLONE" >/dev/null 2>&1 || morre "clone falhou: $M_URL"
    ok "clonado em $CLONE"
  else
    aviso "clonaria $M_URL em $CLONE"
    morre "sem o clone não dá para conferir a materialização — rode com --sim, ou clone você e rode de novo"
  fi
fi
if [ -n "$M_COMMIT" ] && [ -d "$CLONE/.git" ]; then
  ATUAL="$(cd "$CLONE" && git rev-parse HEAD 2>/dev/null | cut -c1-${#M_COMMIT})"
  [ "$ATUAL" = "$M_COMMIT" ] && ok "repo no commit do manifesto ($M_COMMIT)" \
    || aviso "repo está em $ATUAL, manifesto foi feito para $M_COMMIT — revise antes de confiar"
fi

titulo "3. Dependências"
comoInstalar() {
  case "$1" in
    yt-dlp)  echo 'sudo apt install -y pipx && pipx install yt-dlp' ;;
    ffmpeg|ffprobe) echo 'sudo apt install -y ffmpeg' ;;
    jq)      echo 'sudo apt install -y jq' ;;
    python3) echo 'sudo apt install -y python3' ;;
    *)       echo "sudo apt install -y $1   # (nome do pacote pode diferir do binário)" ;;
  esac
}
FALTAM_BIN=""
for b in $M_BIN; do
  if command -v "$b" >/dev/null; then ok "$b"; else
    printf '  \033[31m✗\033[0m %s ausente\n' "$b"
    printf '      %s\n' "$(comoInstalar "$b")"
    FALTAM_BIN="$FALTAM_BIN $b"
  fi
done
[ -n "${FALTAM_BIN// /}" ] && morre "faltando:${FALTAM_BIN} — instale e rode de novo"
[ -z "$M_BIN" ] && ok "nenhum binário exigido"

titulo "4. Chaves no cofre"
if [ -n "$M_CHAVES" ]; then
  FALTAM="$(node "$REPO/scripts/plugar-ajuda.mjs" chaves-faltando "$COFRE" $M_CHAVES)"
  [ -n "${FALTAM// /}" ] && morre "faltando (ou vazia) no cofre $COFRE: $FALTAM
     Chave vazia é pior que ausente: o boot passa e a fase falha no primeiro job."
  ok "chaves presentes: $M_CHAVES"
else
  ok "nenhuma chave exigida"
fi

# FONTES exigidas (o material de entrada: trilha, b-roll). Era campo declarado,
# validado, exportado — e ignorado por este script. Mecanismo que não é
# conferido é mecanismo morto, e o custo aparece no primeiro job que precisa do
# material.
if SAIDA_FON="$(node "$REPO/scripts/plugar-ajuda.mjs" conferir-fontes $M_FONTES 2>&1)"; then
  ok "$SAIDA_FON"
else
  printf '%s\n' "$SAIDA_FON" | sed 's/^/     /'
  morre "resolva as fontes exigidas e rode de novo"
fi

titulo "5. Definição no repo de domínio"
# Modo seco: lista o plano e não escreve. O CONFLITO mata o script aqui — antes
# de qualquer escrita, e antes de tocar no config do bot.
if [ -n "$M_TEM_DEFINICAO" ]; then
  if [ "$APLICAR" = 1 ]; then
    SAIDA_MAT="$(node "$REPO/scripts/plugar-ajuda.mjs" materializar "$MANIFESTO" "$CLONE" --sim)" \
      || { printf '%s\n' "$SAIDA_MAT" | sed 's/^/     /'; morre "materialização recusada — nada foi escrito"; }
    printf '%s\n' "$SAIDA_MAT" | sed 's/^/     /'
    # O DOMÍNIO É A FONTE. Quando ele traz a própria definição, é o MANIFESTO
    # que se atualiza — e é isso que impede a definição chutada por um modelo de
    # voltar a ser escrita no repo no próximo plug (os prompts quebrados do
    # musicavideo chegaram à produção exatamente assim).
    if printf '%s' "$SAIDA_MAT" | grep -q '^IMPORTAR '; then
      ok "manifesto sincronizado A PARTIR do domínio (o repo é a fonte)"
      aviso "confira o diff do manifesto antes de commitar: git diff config/integracoes/$NOME.json"
    fi
    if printf '%s' "$SAIDA_MAT" | grep -q '^ESCREVER '; then
      ok "definição materializada em $CLONE"
      aviso "os arquivos ESCREVER são GERADOS, não versionados pelo domínio: leia antes de rodar.
     Confira principalmente a invocação (binário que talvez não exista no PATH) e o
     contrato de saída (RESULT: tem que apontar o {{saida}} do bot, não o artefato do domínio)."
      aviso "os arquivos NÃO foram commitados: revise e comite VOCÊ, no repo $M_PASTA"
    fi
  else
    node "$REPO/scripts/plugar-ajuda.mjs" materializar "$MANIFESTO" "$CLONE" \
      | sed 's/^/     /' || morre "materialização recusada — nada foi escrito"
    aviso "nada escrito (modo seco)"
  fi
else
  [ -f "$CLONE/flow.json" ] || morre "o manifesto não traz definição e o repo não tem flow.json
     Um dos dois precisa existir: ou o repo já é domínio, ou o manifesto carrega a definição."
  ok "o repo já traz o flow.json — o manifesto é só registro"
fi

# O `flow.json` DO REPO é semanticamente válido? Não basta existir.
#
# O passo 1 conferiu a cópia do MANIFESTO num temporário, e o registry do boot
# só confere existência. Quando o repo é a FONTE (divergência que vira IMPORTAR,
# ou manifesto sem definição), nada tinha rodado o validador real contra ele —
# e um flow.json inválido atravessava a instalação para morrer no primeiro
# comando. A tese deste script é o contrário: "a instalação parou" é melhor que
# "o bot não sobe".
if [ -f "$CLONE/flow.json" ]; then
  if SAIDA_VAL="$(node "$REPO/scripts/plugar-ajuda.mjs" validar-repo "$CLONE" 2>&1)"; then
    ok "flow.json do repo é válido — $SAIDA_VAL"
  else
    printf '%s\n' "$SAIDA_VAL" | sed 's/^/     /'
    morre "o flow.json do repo de domínio é inválido — conserte lá e rode de novo"
  fi
fi

# O comando declarado aponta para um script que EXISTE? É o `command -v` do
# passo 3 aplicado ao que o domínio declarou — só possível desde que a invocação
# deixou de ser prosa dentro de um prompt.
if [ -f "$CLONE/flow.json" ]; then
  if SAIDA_CMD="$(node "$REPO/scripts/plugar-ajuda.mjs" conferir-comandos "$CLONE" 2>&1)"; then
    [ -n "$SAIDA_CMD" ] && printf '%s\n' "$SAIDA_CMD" | sed 's/^/     /'
    [ -n "$SAIDA_CMD" ] && ok "os comandos declarados apontam para scripts que existem"
  else
    printf '%s\n' "$SAIDA_CMD" | sed 's/^/     /'
    morre "conserte o comando no flow.json do domínio (ou traga o script) e rode de novo"
  fi
fi

titulo "6. Entrada no config/fluxos.json"
# O validador REAL do registry de fluxos (o do boot), e ele vai ao DISCO: é por
# isso que este passo vem DEPOIS da materialização.
NOVO="$(mktemp)"; trap 'rm -f "$NOVO"' EXIT
if [ "$APLICAR" != 1 ] && [ -n "$M_TEM_DEFINICAO" ] && [ ! -f "$CLONE/flow.json" ]; then
  aviso "em modo seco o flow.json ainda não existe — a validação do registry só roda com --sim"
  titulo "Nada foi escrito"
  aviso "revise o plano acima e rode de novo com --sim"
  exit 0
fi
ACAO="$(node "$REPO/scripts/plugar-ajuda.mjs" entrada-fluxo \
  "$MANIFESTO" "$FLUXOS" "$PROJETOS" 2>&1 >"$NOVO")" \
  || { cat "$NOVO" >&2; morre "a entrada NÃO passou no validador do boot — config/fluxos.json intacto"; }
ok "entrada $ACAO, e válida para o boot"

if command -v diff >/dev/null; then
  printf '\n'; diff -u "$FLUXOS" "$NOVO" | sed -n '1,40p' || true
fi

if [ "$APLICAR" != 1 ]; then
  titulo "Nada foi escrito"
  aviso "revise o diff acima e rode de novo com --sim"
  exit 0
fi

# Backup só quando ainda NÃO existe um, e por um motivo que custou um teste:
# rodar `--sim` duas vezes salvava, na segunda, um arquivo que JÁ continha a
# entrada — e aí `--desfazer` "restaurava" exatamente o que se queria desfazer.
# O backup guarda o estado ANTERIOR ao primeiro plug, e é o `--desfazer` que o
# consome (ver abaixo).
if [ -f "$BACKUP" ]; then
  aviso "backup anterior preservado ($(basename "$BACKUP")) — ele é o estado de ANTES do primeiro plug"
else
  cp "$FLUXOS" "$BACKUP"
fi
cp "$NOVO" "$FLUXOS"
ok "config/fluxos.json atualizado (backup em $(basename "$BACKUP"))"

if [ "$ORIGEM" = repo ]; then
  mkdir -p "$REPO/config/integracoes"
  cp "$MANIFESTO" "$REPO/config/integracoes/$M_COMMAND.json"
  ok "manifesto adotado → config/integracoes/$M_COMMAND.json (comite-o)"
fi

titulo "7. Suíte e build"
(cd "$REPO" && npm test >/dev/null 2>&1) && ok "suíte" || morre "suíte falhou — desfaça com --desfazer"
(cd "$REPO" && npm run build >/dev/null 2>&1) && ok "build" || morre "build falhou — desfaça com --desfazer"

titulo "Falta você"
cat <<FIM
  1. Comite no repo $M_PASTA o flow.json / prompts / HELP.md materializados.
  2. Confira job em voo (/status no Telegram) — restart mata render em andamento.
  3. Reinicie o serviço.
  4. /ajuda deve listar "$M_COMMAND"; "/$M_COMMAND help" mostra o cartão do domínio.
  5. Rode um fluxo real ATÉ O PRIMEIRO PORTÃO antes de confiar nas fases seguintes.

  Se algo der errado:  ./scripts/plugar-fluxo.sh $NOME --desfazer
FIM
