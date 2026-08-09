#!/usr/bin/env bash
# Instalação do inemaccbot — faz o que é automatizável e PARA no que exige você.
#
# Uso:
#   ./scripts/instalar.sh            # instala (idempotente: pode rodar de novo)
#   ./scripts/instalar.sh --checar   # não muda nada, só diz o que falta
#   ./scripts/instalar.sh --sem-chromium   # pula o download do Chromium (~400 MB)
#
# O que ele NÃO faz, de propósito: instalar Node (é decisão de máquina), escrever
# BOT_TOKEN, logar no Claude, logar no HeyGen e copiar o CTA. Esses quatro são
# segredo ou ativo seu — o script lista cada um no fim, com o que quebra sem ele.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJETOS="$(dirname "$REPO")"
CHECAR=0
CHROMIUM=1
for a in "$@"; do
  case "$a" in
    --checar) CHECAR=1 ;;
    --sem-chromium) CHROMIUM=0 ;;
    *) echo "opção desconhecida: $a" >&2; exit 2 ;;
  esac
done

falta=()
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$1"; }
erro()  { printf '  \033[31m✗\033[0m %s\n' "$1"; falta+=("$1"); }
titulo(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
faca()  { [ "$CHECAR" = 1 ] && { aviso "(--checar) pularia: $*"; return 0; }; "$@"; }

titulo "0. Pré-requisitos"

if command -v node >/dev/null; then
  maior="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$maior" -ge 22 ]; then ok "node $(node -v)"
  else erro "node $(node -v) — precisa de 22+. Ubuntu 24.04 traz o 18; use o NodeSource 22.x"; fi
else
  erro "node ausente — instale a 22+ (NodeSource 22.x)"
fi

for bin in ffmpeg python3 bash git; do
  if command -v "$bin" >/dev/null; then ok "$bin"; else erro "$bin ausente"; fi
done
command -v sqlite3 >/dev/null && ok "sqlite3" || aviso "sqlite3 ausente — só perde o diagnóstico manual da fila"

# `claude` é o motor padrão dos jobs de agente: instalado NÃO basta, tem que estar logado.
if command -v claude >/dev/null; then
  # A saída vem em JSON indentado ("loggedIn": true) — o grep tolera o espaço.
  if claude auth status 2>/dev/null | grep -qE '"loggedIn": *true'; then ok "claude logado"
  else erro "claude instalado mas SEM login — rode 'claude auth login' (todo job de agente falha sem isso)"; fi
else
  erro "claude ausente — 'npm install -g @anthropic-ai/claude-code' e depois 'claude auth login'"
fi

titulo "1. Dependências do projeto"
cd "$REPO"
if [ -d node_modules ] && [ "$CHECAR" = 1 ]; then ok "node_modules já existe"
else faca npm ci; fi

# `tsc` é devDependency. Com NODE_ENV=production o npm pula TODAS as devDeps
# sozinho — e o sintoma só aparece lá na frente, como `tsc: not found` no build.
if [ ! -x node_modules/.bin/tsc ]; then
  erro "node_modules sem devDependencies (falta o tsc). Causa quase certa: NODE_ENV=production. Refaça com: NODE_ENV=development npm ci --include=dev"
else
  ok "devDependencies presentes (tsc)"
fi

titulo "2. Repos de domínio (irmãos em $PROJETOS)"
for r in promoavatar promoavatar3; do
  if [ -d "$PROJETOS/$r/.git" ]; then ok "$r"
  else faca git clone "https://github.com/inematds/$r.git" "$PROJETOS/$r" && ok "$r clonado"; fi
done

titulo "3. CTA (versionado nos repos de domínio desde 2026-08-08)"
for r in promoavatar promoavatar3; do
  if [ -f "$PROJETOS/$r/cta/cta-9x16.mp4" ]; then ok "$r/cta/cta-9x16.mp4"
  else erro "falta $PROJETOS/$r/cta/cta-9x16.mp4 — o CTA agora vem no clone: 'cd $PROJETOS/$r && git pull'"; fi
done

titulo "4. Chromium do Playwright (rota | estudio)"
if [ "$CHROMIUM" = 0 ]; then aviso "pulado por --sem-chromium"
elif npx playwright install --dry-run chromium >/dev/null 2>&1 \
     && [ -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" ]; then ok "já instalado"
else
  # SEM --with-deps de propósito: ele carrega uma lista de pacotes por versão de
  # SO e não conhece o Ubuntu 26.04 — era exatamente o que travava a instalação
  # lá. Aqui baixamos só o browser; se faltar biblioteca do sistema, o erro
  # aparece no launch, e quem sabe a lista (quando sabe) é o `install-deps`.
  faca npx playwright install chromium
  if [ "$CHECAR" = 0 ] && ! node -e "require('playwright').chromium.launch().then(b=>b.close())" >/dev/null 2>&1; then
    aviso "Chromium baixado mas não sobe — provavelmente falta biblioteca do sistema."
    aviso "Tente: npx playwright install-deps   (em SO muito novo ele pode não ter receita)"
    aviso "Afeta SÓ a rota | estudio; o resto do bot funciona sem isso."
  fi
fi

titulo "5. .env"
if [ -f .env ]; then
  ok ".env existe"
  chmod 600 .env
  grep -q '^BOT_TOKEN=.\+' .env || erro "BOT_TOKEN vazio no .env — pegue no @BotFather"
  # O chat id deixou de ser algo que você precisa descobrir: `0` é o modo
  # pareamento, e o primeiro /ping cadastra o chat sozinho.
  if grep -q '^ALLOWED_CHAT_IDS=.\+' .env; then
    if grep -q '^ALLOWED_CHAT_IDS=0$' .env; then
      aviso "ALLOWED_CHAT_IDS=0 — modo pareamento: o PRIMEIRO /ping que chegar vira o dono do bot"
    else ok "ALLOWED_CHAT_IDS preenchido"; fi
  else
    erro "ALLOWED_CHAT_IDS vazio — ponha 0 e o primeiro /ping cadastra seu chat sozinho (vazio derruba o boot)"
  fi
  grep -q '/CAMINHO/PARA' .env && erro "o .env ainda tem /CAMINHO/PARA — troque pelos caminhos reais" || true
else
  faca cp .env.example .env && faca chmod 600 .env
  erro ".env criado a partir do exemplo — preencha BOT_TOKEN, ALLOWED_CHAT_IDS e os caminhos"
fi

titulo "6. Testes e build"
if [ "$CHECAR" = 1 ]; then aviso "(--checar) não roda a suíte"
else
  npm test
  npm run build
  ok "suíte e build"
fi

titulo "7. systemd (unidade de USUÁRIO)"
UNIT="$HOME/.config/systemd/user/inemaccbot.service"
if [ "$CHECAR" = 1 ]; then
  [ -f "$UNIT" ] && ok "unidade instalada" || aviso "unidade ainda não instalada"
else
  install -D -m 0644 deploy/inemaccbot.service "$UNIT"
  systemctl --user daemon-reload
  ok "unidade instalada (ainda NÃO habilitada)"
fi

titulo "Resultado"
if [ ${#falta[@]} -eq 0 ]; then
  cat <<FIM
  Tudo no lugar. Para ligar:

    ./start.sh                  # aqui no terminal, log na tela, Ctrl-C pra sair
    systemctl --user enable --now inemaccbot    # ou como serviço
    loginctl enable-linger "\$USER"

  No chat: /ping (com ALLOWED_CHAT_IDS=0 é ele que pareia seu chat), /ajuda, /fila.
FIM
else
  echo "  Falta $((${#falta[@]})) coisa(s) — cada uma é sua, não do script:"
  for f in "${falta[@]}"; do echo "   · $f"; done
  echo
  echo "  Resolva e rode de novo: ./scripts/instalar.sh --checar"
  exit 1
fi
