#!/usr/bin/env bash
# Desliga o bot: para o serviço systemd e, se ainda sobrar algum `node dist/index.js`
# solto (um ./start.sh esquecido num terminal), manda SIGTERM nele também.
#
# Antes de parar, olha a fila: job em `running` é render em voo, e parar o
# serviço no meio mata o render — o job volta pra fila na próxima subida, mas o
# trabalho já gasto se perde. Por isso a recusa quando há job em voo.
#
# Uso:
#   ./stop.sh             # para (recusa se houver job em voo)
#   ./stop.sh --forcar    # para mesmo com job em voo

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FORCAR=0
case "${1:-}" in
  '') ;;
  --forcar) FORCAR=1 ;;
  *) echo "opção desconhecida: $1 (só existe --forcar)" >&2; exit 2 ;;
esac

if [ "$FORCAR" = 0 ] && [ -f inemaccbot.db ] && command -v sqlite3 >/dev/null 2>&1; then
  EM_VOO="$(sqlite3 inemaccbot.db "select count(*) from jobs where status='running';" 2>/dev/null || echo 0)"
  if [ "${EM_VOO:-0}" != "0" ]; then
    sqlite3 inemaccbot.db "select '  job '||id||' '||fila||' '||tarefa from jobs where status='running';" 2>/dev/null || true
    cat >&2 <<FIM
há $EM_VOO job(s) em voo. Parar agora mata o render no meio.

  journalctl --user -u inemaccbot -f   # acompanhar até terminar
  ./stop.sh --forcar                   # parar assim mesmo
FIM
    exit 1
  fi
fi

if systemctl --user is-active --quiet inemaccbot 2>/dev/null; then
  echo "parando o serviço systemd inemaccbot..."
  systemctl --user stop inemaccbot
else
  echo "serviço systemd inemaccbot já estava parado."
fi

# Um ./start.sh em primeiro plano não é visto pelo systemd; se ficar de pé,
# continua disputando o getUpdates com a próxima subida do serviço.
SOLTOS="$(pgrep -f "node dist/index.js" || true)"
if [ -n "$SOLTOS" ]; then
  echo "matando processo solto (start.sh): $SOLTOS"
  # shellcheck disable=SC2086
  kill $SOLTOS
fi

echo "bot parado."
