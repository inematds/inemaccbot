#!/usr/bin/env bash
# Prepara um repo SEU para ser plugado no inemaccbot — grava dentro DELE.
#
#   ./scripts/preparar-repo.sh ~/projetos/<repo>
#
# Diferença para o `gerar-manifesto.sh`, que é o mesmo motor:
#
#   gerar-manifesto  → grava no BOT   (config/integracoes/<nome>.json + prompts/)
#                      é o ADAPTADOR: serve para plugar repo de terceiro, sem
#                      pedir commit a ninguém.
#   preparar-repo    → grava no REPO  (integracao.json + prompts/<nome>.md)
#                      o repo passa a declarar como ser plugado, e QUALQUER
#                      instalação do bot o pluga só com o nome.
#
# Use este quando o repo é seu e você quer ir preparando um por um: depois,
# plugar em qualquer máquina é `./scripts/plugar-repo.sh <nome> --sim`, sem nada
# do lado do bot.
#
# Ele NÃO comita nem faz push no seu repo — deixa os dois arquivos lá e te diz o
# comando. Mexer no git de outro projeto é decisão sua, não de script.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALVO="${1:-}"
[ -n "$ALVO" ] || { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

PARA_REPO=1 exec "$AQUI/gerar-manifesto.sh" "$ALVO"
