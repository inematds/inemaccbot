#!/usr/bin/env bash
# Atualiza o inemaccbot nesta máquina: traz o código novo, reconstrói e reinicia
# o serviço — parando ANTES se houver job em voo, que é o erro caro daqui.
#
# Uso:
#   ./atualizar.sh              # atualiza; recusa reiniciar com job rodando
#   ./atualizar.sh --agora      # reinicia mesmo com job rodando (você assume)
#   ./atualizar.sh --sem-restart  # atualiza e compila, mas não encosta no serviço
#   ./atualizar.sh --sem-dominios # não atualiza promoavatar/promoavatar3
#
# Atualiza o BOT **e os REPOS DE DOMÍNIO** declarados em `config/fluxos.json`. O
# domínio carrega o flow.json, os prompts, os templates e o motor do reel — bot
# novo com domínio velho roda prompt antigo e produz vídeo errado, sem erro
# nenhum no boot.
#
# AVISO: edições locais NÃO commitadas deste repo vão para o `git stash` antes do
# pull (recupere com `git stash pop`). Inclusive edições neste próprio arquivo.
#
# Funciona nos dois modos de serviço: unidade de USUÁRIO (máquina de trabalho) e
# de SISTEMA (VPS). Detecta qual existe em vez de assumir.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RESTART=1
FORCAR=0
DOMINIOS=1
for a in "$@"; do
  case "$a" in
    --agora) FORCAR=1 ;;
    --sem-restart) RESTART=0 ;;
    --sem-dominios) DOMINIOS=0 ;;
    *) echo "opção desconhecida: $a (use --agora, --sem-restart ou --sem-dominios)" >&2; exit 2 ;;
  esac
done

amarelo(){ printf '\033[33m%s\033[0m\n' "$1"; }
verde()  { printf '\033[32m%s\033[0m\n' "$1"; }
erro()   { printf '\033[31m%s\033[0m\n' "$1" >&2; }

echo; amarelo "=== inemaccbot — atualização ==="; echo

[ -d .git ] || { erro "isto não parece um clone do inemaccbot (sem .git)"; exit 1; }

# --- como este serviço roda aqui? -------------------------------------------
# Sem isto o script serviria a uma máquina só. `systemctl --user` não existe
# numa VPS rodando como root, e `sudo systemctl` não é o certo no desktop.
CTL=""
if systemctl --user list-unit-files inemaccbot.service >/dev/null 2>&1 \
   && systemctl --user list-unit-files inemaccbot.service | grep -q inemaccbot; then
  CTL="systemctl --user"
elif systemctl list-unit-files inemaccbot.service >/dev/null 2>&1 \
     && systemctl list-unit-files inemaccbot.service | grep -q inemaccbot; then
  CTL="sudo systemctl"
fi
if [ -z "$CTL" ]; then
  amarelo "nenhuma unidade systemd 'inemaccbot' instalada — vou atualizar sem reiniciar nada."
  RESTART=0
fi

# --- edições locais ----------------------------------------------------------
# O .env é git-ignored e nunca aparece aqui.
if ! git diff --quiet || ! git diff --cached --quiet; then
  amarelo "Há edições locais não commitadas:"
  git diff --name-only HEAD | sed 's/^/  - /'
  echo "Guardando com 'git stash' (recupere com: git stash pop)."
  git stash push -q -m "atualizar.sh $(git rev-parse --short HEAD)"
fi

ANTES="$(git rev-parse --short HEAD)"
RAMO="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin

# --- clone da história VELHA? -------------------------------------------------
# Em 2026-08-08 o repo foi partido: o público renasceu de um commit órfão, sem
# ancestral comum com o histórico anterior. Quem clonou antes disso tem duas
# árvores paralelas — `git pull` aqui ou recusa ("unrelated histories") ou
# confunde, e nunca traz o código novo. O sintoma que o usuário vê é "puxei e
# não veio nada", com arquivos novos (start.sh) simplesmente ausentes.
if ! git merge-base HEAD "origin/$RAMO" >/dev/null 2>&1; then
  echo
  erro "Este clone é ANTERIOR à partição do repositório (2026-08-08)."
  cat >&2 <<FIM

O histórico daqui e o do origin não têm ancestral comum, então nenhum \`git pull\`
vai trazer o código novo — não é falha sua nem do comando.

Migração (o histórico velho NÃO se perde: está em inematds/inemaccbotx, privado):

  cd "$(dirname "$PWD")"
  mkdir -p ~/salvos-inemaccbot
  cp "$PWD/.env" ~/salvos-inemaccbot/ 2>/dev/null
  cp "$PWD"/inemaccbot.db* ~/salvos-inemaccbot/ 2>/dev/null
  git -C "$PWD" ls-files --others --exclude-standard   # veja o que só existe aqui

  mv "$PWD" "$PWD.historia-velha"
  git clone https://github.com/inematds/inemaccbot.git "$PWD"
  cp ~/salvos-inemaccbot/.env "$PWD/.env" && chmod 600 "$PWD/.env"
  cp ~/salvos-inemaccbot/inemaccbot.db* "$PWD/" 2>/dev/null
  cd "$PWD" && ./atualizar.sh --sem-restart

Só apague a pasta .historia-velha depois de confirmar que o bot novo sobe.
FIM
  exit 1
fi

git pull --ff-only
DEPOIS="$(git rev-parse --short HEAD)"

if [ "$ANTES" = "$DEPOIS" ]; then
  verde "já estava atualizado ($DEPOIS)."
else
  verde "código: $ANTES → $DEPOIS"
  git log --oneline "$ANTES..$DEPOIS" | sed 's/^/  /'
fi

# --- repos de domínio ---------------------------------------------------------
# Atualizar só o bot deixa a metade que decide COMO o trabalho é feito parada:
# flow.json, prompts, templates, o motor do reel e o adaptador de imagem moram
# nos domínios. Um bot novo com domínio velho roda prompt antigo e não conhece
# IMG_PROVEDOR — e o sintoma aparece no vídeo, não no boot.
#
# A lista sai de config/fluxos.json, que é a MESMA fonte que o bot lê para
# carregar os fluxos: manter uma segunda lista aqui divergiria no primeiro
# domínio novo.
if [ "$DOMINIOS" = 1 ] && [ -f config/fluxos.json ]; then
  RAIZ="${PROJETOS_DIR:-$(dirname "$PWD")}"
  echo
  amarelo "--- repos de domínio (em $RAIZ)"
  for repo in $(python3 -c "
import json
print(' '.join(sorted({f['repo'] for f in json.load(open('config/fluxos.json')) if f.get('repo')})))
" 2>/dev/null); do
    dir="$RAIZ/$repo"
    if [ ! -d "$dir/.git" ]; then
      erro "  $repo: não está clonado em $dir — os fluxos dele quebram na primeira fase"
      continue
    fi
    # Domínio sujo NÃO leva stash: ali dentro moram os textos gerados pelos
    # fluxos, e mexer neles às cegas é perder trabalho de verdade.
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      amarelo "  $repo: tem mudanças locais — PULADO (commite ou descarte e rode de novo)"
      continue
    fi
    de="$(git -C "$dir" rev-parse --short HEAD)"
    if git -C "$dir" pull --ff-only --quiet 2>/dev/null; then
      para="$(git -C "$dir" rev-parse --short HEAD)"
      [ "$de" = "$para" ] && verde "  $repo: já atualizado ($para)" \
                          || verde "  $repo: $de → $para"
    else
      erro "  $repo: o pull falhou (rode 'git -C $dir pull' para ver o motivo)"
    fi
  done
fi

# --- dependências e build ----------------------------------------------------
# `npm ci` com NODE_ENV=production pula as devDeps e o build morre em
# `tsc: not found` três passos depois da causa. Forçamos development.
NODE_ENV=development npm ci --include=dev
npm run build
verde "build ok"

[ "$RESTART" = 0 ] && { echo; verde "pronto (serviço não foi tocado)."; exit 0; }

# --- job em voo? -------------------------------------------------------------
# Reiniciar com render rodando mata o processo com SIGTERM e queima uma
# tentativa do job. A consulta não é opcional — é a razão de este script existir
# em vez de um `git pull && systemctl restart` na mão.
EMVOO=""
if command -v sqlite3 >/dev/null && [ -f inemaccbot.db ]; then
  EMVOO="$(sqlite3 inemaccbot.db \
    "select id||' '||fila||' '||tarefa from jobs where status='running';" 2>/dev/null || true)"
fi

if [ -n "$EMVOO" ] && [ "$FORCAR" = 0 ]; then
  echo
  erro "Há job(s) RODANDO agora:"
  echo "$EMVOO" | sed 's/^/  · /' >&2
  cat >&2 <<'FIM'

Reiniciar agora mata o processo com SIGTERM e gasta uma tentativa do job — se
for render, a GPU já queimada vai junto. Escolha:

  aguarde terminar e rode ./atualizar.sh de novo
  ./atualizar.sh --agora        # reinicia assim mesmo

O código novo JÁ está compilado; só o restart ficou pendente.
FIM
  exit 1
fi

[ -n "$EMVOO" ] && amarelo "reiniciando com job em voo (--agora)."

$CTL restart inemaccbot
sleep 2
if $CTL is-active --quiet inemaccbot; then
  verde "serviço reiniciado e ativo."
else
  erro "o serviço NÃO subiu. Veja o log:"
  [ "$CTL" = "sudo systemctl" ] && echo "  sudo journalctl -u inemaccbot -n 50" >&2 \
                                || echo "  journalctl --user -u inemaccbot -n 50" >&2
  exit 1
fi
