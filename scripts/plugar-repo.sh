#!/usr/bin/env bash
# Pluga um repo externo no bot a partir de um MANIFESTO já revisado.
#
#   ./scripts/plugar-repo.sh <nome>            # mostra o que faria e PARA
#   ./scripts/plugar-repo.sh <nome> --sim      # aplica
#   ./scripts/plugar-repo.sh <nome> --desfazer # restaura o backup da última vez
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
PROJETOS="$(dirname "$REPO")"
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

MANIFESTO="$REPO/config/integracoes/$NOME.json"
CLONE="$PROJETOS/$NOME"
BACKUP="$SKILLS.bak-$NOME"

if [ "$DESFAZER" = 1 ]; then
  titulo "Desfazer"
  [ -f "$BACKUP" ] || morre "não há backup de $NOME ($BACKUP)"
  cp "$BACKUP" "$SKILLS"
  ok "config/skills.json restaurado do backup"
  aviso "recompile (npm run build) e reinicie o serviço para valer"
  exit 0
fi

titulo "1. Manifesto"
# Sem manifesto o script PARA. A alternativa seria adivinhar fila, timeout e
# prompt — e o resultado disso é job que termina sem entregar arquivo, que é o
# defeito mais caro de diagnosticar neste sistema.
[ -f "$MANIFESTO" ] || morre "não há manifesto para \"$NOME\" ($MANIFESTO)
     Gere um numa máquina com modelo:  ./scripts/gerar-manifesto.sh <url-do-repo>
     e comite o resultado em config/integracoes/."

# O `dist/` é o que o helper importa; na VPS ele já existe, mas um clone novo não.
if [ ! -d "$REPO/dist/dominio" ]; then
  aviso "dist/ ausente — compilando antes de validar"
  (cd "$REPO" && npm run build >/dev/null)
fi

eval "$(node "$REPO/scripts/plugar-ajuda.mjs" validar "$MANIFESTO")" || morre "manifesto inválido"
ok "manifesto válido: $M_COMMAND (fila $M_FILA, artefato .$M_EXT, timeout ${M_TIMEOUT}s)"
[ -n "$M_CHUTES" ] && aviso "campos que o gerador CHUTOU (confira se ainda valem): $M_CHUTES"

titulo "2. Repo"
if [ -d "$CLONE/.git" ]; then
  ok "clone existe: $CLONE"
  if [ "$APLICAR" = 1 ]; then (cd "$CLONE" && git pull --ff-only >/dev/null 2>&1) && ok "atualizado" || aviso "git pull falhou — seguindo com o que está no disco"; fi
else
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
for b in $M_BIN; do
  command -v "$b" >/dev/null && ok "$b" || morre "$b ausente — instale VOCÊ.
     O prompt proíbe o agente de instalar: sem isto a fase morre com 'ERRO: falta $b'."
done
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
[ -s "$REPO/$M_PROMPT" ] || morre "prompt ausente ou vazio: $M_PROMPT
     Ele é gerado junto com o manifesto e deveria estar versionado."
grep -q '{{input}}' "$REPO/$M_PROMPT" || aviso "o prompt não cita {{input}} — a skill ignoraria o pedido"
grep -q '{{saida}}' "$REPO/$M_PROMPT" || aviso "o prompt não cita {{saida}} — o bot não acharia o artefato"
grep -q 'RESULT:'   "$REPO/$M_PROMPT" || aviso "o prompt não fecha com RESULT: — a fase não teria como declarar sucesso"
ok "prompt: $M_PROMPT"
printf '     invocação: %s\n' "$(node "$REPO/scripts/plugar-ajuda.mjs" invocacao "$MANIFESTO" "$CLONE")"

titulo "6. Entrada no config/skills.json"
NOVO="$(mktemp)"; trap 'rm -f "$NOVO"' EXIT
DESCRICAO="${PLUGAR_DESCRICAO:-$M_COMMAND (plugado por manifesto)}"
EXEMPLO="${PLUGAR_EXEMPLO:-$M_COMMAND: <entrada>}"
# Valida com o validador REAL do registry (o do boot) ANTES de escrever: é o que
# faz "plugou" e "o serviço sobe" serem a mesma coisa.
ACAO="$(node "$REPO/scripts/plugar-ajuda.mjs" entrada \
  "$MANIFESTO" "$SKILLS" "$REPO" "$DESCRICAO" "$EXEMPLO" 2>&1 >"$NOVO")" \
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

cp "$SKILLS" "$BACKUP"
cp "$NOVO" "$SKILLS"
ok "config/skills.json atualizado (backup em $(basename "$BACKUP"))"

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
