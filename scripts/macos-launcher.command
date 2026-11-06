#!/bin/bash
# Lanzador de benzIA para macOS (Apple Silicon). Doble clic en el Finder o
# ./benzia.command en Terminal. Usa el Node incluido en el paquete; no hay que
# instalar nada. La base de datos queda en ./data dentro de la carpeta.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$DIR/runtime/bin:$PATH"

cd "$DIR/app"

# Configuracion: copia .env.example a .env si quieres cambiar puertos o la URL
# de LM Studio; sin .env se usan los valores por defecto (3401/3400).
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
export DATA_DIR="${DATA_DIR:-$DIR/data}"

if [ "${1:-}" = "--smoke" ]; then
  # Autocomprobacion: arranca, espera y se cierra (la usa el empaquetado).
  node --disable-warning=ExperimentalWarning src/server.js &
  PID=$!
  sleep 3
  kill $PID 2>/dev/null || true
  exit 0
fi

echo "benzIA iniciandose..."
echo "  Panel de administracion: http://localhost:${ADMIN_PORT:-3400}/dashboard"
echo "  Chat publico:            http://localhost:${GATEWAY_PORT:-3401}/chat"
echo "Pulsa Control+C para detenerlo."
exec node --disable-warning=ExperimentalWarning src/server.js
