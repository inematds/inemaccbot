#!/usr/bin/env bash
# Pluga um repo externo no bot a partir de um MANIFESTO já revisado.
#
#   ./scripts/plugar-repo.sh <nome>            # mostra o que faria e PARA
#   ./scripts/plugar-repo.sh <nome> --sim      # aplica
#   ./scripts/plugar-repo.sh <url>  --sim      # repo ainda não clonado, manifesto vem dele
#   ./scripts/plugar-repo.sh <nome> --desfazer # restaura o backup da última vez
#
# O manifesto é procurado em DUAS fontes, nesta ordem:
#   1. config/integracoes/<nome>.json   — o adaptador LOCAL, que você revisou
#   2. <clone>/integracao.json          — o que o próprio repo declara
# Local vence: é a saída para quando o manifesto do repo estiver errado ou velho,
# sem depender de PR no projeto dos outros. Ao aplicar um manifesto vindo do
# repo, o bot o ADOTA (copia manifesto e prompt para dentro de si): o que vale
# passa a ser auditável, versionado, e não muda sozinho no próximo git pull do
# repo alheio.
#
# DETERMINÍSTICO: nenhum modelo no caminho. Quem lê o repo e decide fila,
# timeout e prompt é o `gerar-manifesto`, uma vez por repo, numa máquina que
# tenha um modelo. Aqui só se aplica o que já foi decidido e revisado — mesma
# entrada, mesmo resultado, em qualquer máquina.
#
# O manifesto mora em `config/integracoes/<nome>.json` e é versionado: numa VPS
# nova, `git pull` + este script bastam.
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
SKILLS="$REPO/config/skills.json"

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
[ -n "$NOME" ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$1"; }
morre() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
titulo(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# Nome ou URL: com URL, o nome sai do último segmento (sem .git).
case "$NOME" in
  https://*|git@*) URL_ARG="$NOME"; NOME="$(basename "$NOME" .git)" ;;
  *) URL_ARG="" ;;
esac
MANIFESTO="$REPO/config/integracoes/$NOME.json"
# Provisório: o definitivo sai do manifesto (`repo.pasta`), porque o comando do
# chat não precisa ter o nome do repositório.
CLONE="$PROJETOS/$NOME"
BACKUP="$SKILLS.bak-$NOME"
ORIGEM=local

if [ "$DESFAZER" = 1 ]; then
  titulo "Desfazer"
  [ -f "$BACKUP" ] || morre "não há backup de $NOME ($BACKUP)"
  cp "$BACKUP" "$SKILLS"
  rm -f "$BACKUP"
  ok "config/skills.json restaurado do backup"
  aviso "recompile (npm run build) e reinicie o serviço para valer"
  exit 0
fi

titulo "1. Manifesto"
if [ -f "$MANIFESTO" ]; then
  ok "manifesto local: config/integracoes/$NOME.json"
else
  # Não achou o adaptador local: talvez o próprio repo declare como ser plugado.
  # Para ler isso, o clone precisa existir — e se veio URL, clonamos agora.
  if [ ! -d "$CLONE/.git" ] && [ -n "$URL_ARG" ]; then
    if [ "$APLICAR" = 1 ] || true; then
      git clone "$URL_ARG" "$CLONE" >/dev/null 2>&1 || morre "clone falhou: $URL_ARG"
      ok "clonado em $CLONE (para ler o manifesto dele)"
    fi
  fi
  if [ -f "$CLONE/integracao.json" ]; then
    MANIFESTO="$CLONE/integracao.json"
    ORIGEM=repo
    aviso "sem adaptador local — usando o manifesto DO REPO ($CLONE/integracao.json)"
    aviso "ele é escrito por quem mantém aquele repo: leia a invocação abaixo antes do --sim"
  else
    # Sem manifesto nenhum o script PARA. Adivinhar fila, timeout e prompt produz
    # job que termina sem entregar arquivo — o defeito mais caro daqui.
    morre "não há manifesto para \"$NOME\"
     Procurei em:  config/integracoes/$NOME.json
                   $CLONE/integracao.json
     Gere um numa máquina com modelo:  ./scripts/gerar-manifesto.sh <url-do-repo>
     e comite o resultado em config/integracoes/."
  fi
fi

# O `dist/` é o que o helper importa. Compilar quando FALTA não basta: um
# `git pull` na VPS traz `src/` novo e deixa o `dist/` velho no disco, e o
# sintoma é um SyntaxError de export inexistente vindo do meio do helper —
# ilegível para quem só queria plugar. Mesma regra do `start.sh`: velho conta
# como ausente.
if [ ! -f "$REPO/dist/index.js" ] || [ -n "$(find "$REPO/src" -name '*.ts' -newer "$REPO/dist/index.js" -print -quit 2>/dev/null)" ]; then
  aviso "dist/ ausente ou desatualizado — compilando antes de validar"
  (cd "$REPO" && npm run build >/dev/null)
fi

# `eval "$(cmd)"` engole a falha do cmd (o eval de string vazia devolve 0), e o
# sintoma vira "unbound variable" trinta linhas depois. Captura, confere, avalia.
VARS="$(node "$REPO/scripts/plugar-ajuda.mjs" validar "$MANIFESTO")" || morre "manifesto inválido"
eval "$VARS"
# Agora sim: a pasta do clone é a que o manifesto declara.
CLONE="$PROJETOS/$M_PASTA"
[ "$M_PASTA" = "$NOME" ] || ok "clone esperado em $M_PASTA (o comando é $M_COMMAND)"
ok "manifesto válido: $M_COMMAND (fila $M_FILA, artefato .$M_EXT, timeout ${M_TIMEOUT}s)"
case "$M_INVOCACAO" in
  *'"{{input}}"'*) : ;;
  *) aviso 'a invocação usa {{input}} SEM aspas — entrada com espaço ou "&" quebra o comando' ;;
esac
[ -n "$M_CHUTES" ] && aviso "campos que o gerador CHUTOU (confira se ainda valem): $M_CHUTES"

titulo "2. Repo"
if [ -d "$CLONE/.git" ]; then
  ok "clone existe: $CLONE"
  if [ "$APLICAR" = 1 ]; then (cd "$CLONE" && git pull --ff-only >/dev/null 2>&1) && ok "atualizado" || aviso "git pull falhou — seguindo com o que está no disco"; fi
else
  [ -n "$M_URL" ] || morre "o repo não está em $CLONE e o manifesto não traz repo.url
     Clone-o você, ou rode com a URL: ./scripts/plugar-repo.sh <url> --sim"
  if [ "$APLICAR" = 1 ]; then
    git clone "$M_URL" "$CLONE" >/dev/null 2>&1 || morre "clone falhou: $M_URL"
    ok "clonado em $CLONE"
  else
    aviso "clonaria $M_URL em $CLONE"
  fi
fi
# Proveniência: o manifesto foi escrito olhando UM commit. Se o repo andou, as
# decisões dele (invocação, armadilhas no prompt) podem não valer mais.
if [ -n "$M_COMMIT" ] && [ -d "$CLONE/.git" ]; then
  ATUAL="$(cd "$CLONE" && git rev-parse HEAD 2>/dev/null | cut -c1-${#M_COMMIT})"
  [ "$ATUAL" = "$M_COMMIT" ] && ok "repo no commit do manifesto ($M_COMMIT)" \
    || aviso "repo está em $ATUAL, manifesto foi feito para $M_COMMIT — revise antes de confiar"
fi

titulo "3. Dependências"
# Sugestão de instalação por binário. É SUGESTÃO: o script não instala nada, nem
# aqui nem no agente — quem decide o que entra na máquina é o dono. Mas dizer
# "instale você" sem o comando é atrito puro numa VPS.
comoInstalar() {
  case "$1" in
    yt-dlp)  # o do apt costuma ser velho demais para o YouTube de hoje
      echo 'sudo apt install -y pipx && pipx install yt-dlp   # (o yt-dlp do apt envelhece rápido e quebra em site que muda)' ;;
    ffmpeg|ffprobe) echo 'sudo apt install -y ffmpeg' ;;
    jq)      echo 'sudo apt install -y jq' ;;
    python3) echo 'sudo apt install -y python3' ;;
    node)    echo 'NodeSource 22.x — ver README §0' ;;
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
if [ -n "${FALTAM_BIN// /}" ]; then
  morre "faltando:${FALTAM_BIN}
     Instale e rode de novo. O prompt PROÍBE o agente de instalar: sem isto a
     fase não falha na instalação, falha no primeiro job com 'ERRO: falta <o quê>'."
fi
[ -z "$M_BIN" ] && ok "nenhum binário exigido"

titulo "4. Chaves no cofre"
if [ -n "$M_CHAVES" ]; then
  FALTAM="$(node "$REPO/scripts/plugar-ajuda.mjs" chaves-faltando "$COFRE" $M_CHAVES)"
  if [ -n "${FALTAM// /}" ]; then
    morre "faltando (ou vazia) no cofre $COFRE: $FALTAM
     Chave vazia é pior que ausente: o boot passa e a rota falha no primeiro job."
  fi
  ok "chaves presentes: $M_CHAVES"
else
  ok "nenhuma chave exigida"
fi

titulo "5. Prompt"
# O manifesto aponta um prompt DO BOT — é ele que carrega o contrato
# `RESULT:`/`ERRO:`. Sem o arquivo, o registry recusa no boot.
#
# Manifesto vindo do REPO aponta prompt do repo. Adotar = copiar para dentro do
# bot, que é onde o registry procura, e onde ele fica sob o SEU git — imune ao
# próximo pull do repo alheio. Em modo seco nada é copiado: a validação do passo
# 6 roda contra uma raiz temporária, para não escrever no repo sem --sim.
RAIZ_VALIDACAO="$REPO"
PROMPT_DO_REPO=""
if [ "$ORIGEM" = repo ] && [ ! -s "$REPO/$M_PROMPT" ]; then
  PROMPT_DO_REPO="$CLONE/$M_PROMPT"
  [ -s "$PROMPT_DO_REPO" ] || morre "o manifesto do repo aponta um prompt que não existe lá: $M_PROMPT"
  if [ "$APLICAR" = 1 ]; then
    mkdir -p "$REPO/$(dirname "$M_PROMPT")"
    cp "$PROMPT_DO_REPO" "$REPO/$M_PROMPT"
    ok "prompt adotado do repo → $M_PROMPT"
    PROMPT_DO_REPO=""
  else
    aviso "adotaria o prompt do repo: $M_PROMPT (nada é copiado sem --sim)"
    # A raiz temporária precisa conter TODOS os prompts, não só o novo: o
    # validador confere o array inteiro do skills.json, e as outras skills
    # sumiriam. Espelha por symlink e sobrepõe o que vem do repo.
    RAIZ_VALIDACAO="$(mktemp -d)"
    cp -rs "$REPO/prompts" "$RAIZ_VALIDACAO/prompts"
    mkdir -p "$RAIZ_VALIDACAO/$(dirname "$M_PROMPT")"
    cp -f "$PROMPT_DO_REPO" "$RAIZ_VALIDACAO/$M_PROMPT"
  fi
fi
ALVO_PROMPT="$RAIZ_VALIDACAO/$M_PROMPT"
[ -s "$ALVO_PROMPT" ] || morre "prompt ausente ou vazio: $M_PROMPT
     Ele é gerado junto com o manifesto e deveria estar versionado."
grep -q '{{input}}' "$ALVO_PROMPT" || aviso "o prompt não cita {{input}} — a skill ignoraria o pedido"
grep -q '{{saida}}' "$ALVO_PROMPT" || aviso "o prompt não cita {{saida}} — o bot não acharia o artefato"
grep -q 'RESULT:'   "$ALVO_PROMPT" || aviso "o prompt não fecha com RESULT: — a fase não teria como declarar sucesso"
ok "prompt: $M_PROMPT"
printf '     invocação: %s\n' "$(node "$REPO/scripts/plugar-ajuda.mjs" invocacao "$MANIFESTO" "$CLONE")"

titulo "6. Entrada no config/skills.json"
NOVO="$(mktemp)"; trap 'rm -f "$NOVO"' EXIT
# Valida com o validador REAL do registry (o do boot) ANTES de escrever: é o que
# faz "plugou" e "o serviço sobe" serem a mesma coisa.
ACAO="$(node "$REPO/scripts/plugar-ajuda.mjs" entrada \
  "$MANIFESTO" "$SKILLS" "$RAIZ_VALIDACAO" 2>&1 >"$NOVO")" \
  || { cat "$NOVO" >&2; morre "a entrada NÃO passou no validador do boot — nada foi escrito"; }
ok "entrada $ACAO, e válida para o boot"

if command -v diff >/dev/null; then
  printf '\n'; diff -u "$SKILLS" "$NOVO" | sed -n '1,60p' || true
fi

if [ "$APLICAR" != 1 ]; then
  titulo "Nada foi escrito"
  aviso "revise o diff acima e rode de novo com --sim"
  exit 0
fi

# Backup só quando ainda NÃO existe um: rodar `--sim` duas vezes salvava, na
# segunda, um arquivo que JÁ continha a entrada, e `--desfazer` "restaurava" o
# que se queria desfazer. O backup é o estado ANTERIOR ao primeiro plug, e é o
# `--desfazer` que o consome.
if [ -f "$BACKUP" ]; then
  aviso "backup anterior preservado ($(basename "$BACKUP")) — ele é o estado de ANTES do primeiro plug"
else
  cp "$SKILLS" "$BACKUP"
fi
cp "$NOVO" "$SKILLS"
ok "config/skills.json atualizado (backup em $(basename "$BACKUP"))"

if [ "$ORIGEM" = repo ]; then
  # Adota o manifesto: a partir daqui vale a CÓPIA, versionada no bot. Sem isto,
  # o que governa a config do seu bot mudaria sozinho no próximo pull do repo.
  mkdir -p "$REPO/config/integracoes"
  cp "$MANIFESTO" "$REPO/config/integracoes/$M_COMMAND.json"
  ok "manifesto adotado → config/integracoes/$M_COMMAND.json (comite-o)"
fi

titulo "7. Suíte e build"
(cd "$REPO" && npm test >/dev/null 2>&1) && ok "suíte" || morre "suíte falhou — desfaça com --desfazer"
(cd "$REPO" && npm run build >/dev/null 2>&1) && ok "build" || morre "build falhou — desfaça com --desfazer"

titulo "Falta você"
cat <<FIM
  1. Confira job em voo (/status no Telegram) — restart mata render em andamento.
  2. Reinicie o serviço.
  3. /ajuda deve listar "$M_COMMAND".
  4. Teste com uma entrada real e confira que o arquivo chega no chat.

  Se algo der errado:  ./scripts/plugar-repo.sh $NOME --desfazer
FIM
