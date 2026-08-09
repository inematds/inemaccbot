#!/usr/bin/env bash
# Liga o bot em primeiro plano, com o log na tela. É o "rodar sem systemd" —
# primeira vez, depuração, e o dia em que o serviço não sobe e você quer ver
# por quê. Parar: Ctrl-C.
#
# Uso:
#   ./start.sh             # sobe (recusa se o serviço systemd já estiver de pé)
#   ./start.sh --forcar    # sobe mesmo assim
#
# Para o dia a dia, o serviço é melhor:
#   systemctl --user start|stop|restart inemaccbot
#   journalctl --user -u inemaccbot -f

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FORCAR=0
case "${1:-}" in
  '') ;;
  --forcar) FORCAR=1 ;;
  *) echo "opção desconhecida: $1 (só existe --forcar)" >&2; exit 2 ;;
esac

if [ ! -f .env ]; then
  echo "sem .env aqui — rode ./scripts/instalar.sh primeiro" >&2
  exit 1
fi

# Dois processos no MESMO BOT_TOKEN disputam o getUpdates do Telegram e as
# mensagens somem alternadamente. O sintoma é "o bot ignora metade do que eu
# mando", que é caro de diagnosticar — daí a recusa explícita.
if [ "$FORCAR" = 0 ] && systemctl --user is-active --quiet inemaccbot 2>/dev/null; then
  cat >&2 <<'FIM'
o serviço systemd inemaccbot JÁ está rodando.

Subir um segundo processo no mesmo BOT_TOKEN faz os dois brigarem pelo
getUpdates, e o bot passa a perder mensagens. Escolha um:

  systemctl --user stop inemaccbot && ./start.sh   # depurar aqui no terminal
  journalctl --user -u inemaccbot -f               # só acompanhar o serviço
  ./start.sh --forcar                              # subir assim mesmo
FIM
  exit 1
fi

# Compila só quando falta ou está velho: ligar não pode virar ritual de build.
if [ ! -f dist/index.js ] || [ -n "$(find src -name '*.ts' -newer dist/index.js -print -quit 2>/dev/null)" ]; then
  echo "compilando (dist desatualizado)..."
  npm run build
fi

# `exec` para que o Ctrl-C e o SIGTERM cheguem ao node, e não a este shell.
exec node dist/index.js
