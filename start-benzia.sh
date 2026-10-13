#!/usr/bin/env bash
# Lanzador de benzIA: libera los puertos ocupados y arranca el servicio atado a la consola.
# Al cerrar la consola (o con Ctrl+C) el proceso se detiene.
set -euo pipefail

cd "$(dirname "$0")"

[ -f .env ] || { echo "Falta el archivo .env" >&2; exit 1; }

port_from_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-; }

ADMIN_PORT=$(port_from_env ADMIN_PORT); ADMIN_PORT=${ADMIN_PORT:-3400}
GATEWAY_PORT=$(port_from_env GATEWAY_PORT); GATEWAY_PORT=${GATEWAY_PORT:-3401}

if [ "$ADMIN_PORT" = "$GATEWAY_PORT" ]; then
  echo "ADMIN_PORT y GATEWAY_PORT deben ser distintos." >&2
  exit 1
fi

free_port() {
  local port=$1 pids i
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] || { echo "Puerto $port libre."; return 0; }
  echo "Puerto $port ocupado (PID: $(echo $pids | tr '\n' ' ')); terminando proceso..."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for i in $(seq 1 20); do
    pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -z "$pids" ] && break
    sleep 0.5
  done
  if [ -n "$pids" ]; then
    echo "El proceso no termino; forzando kill -9..."
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "No se pudo liberar el puerto $port." >&2
    exit 1
  fi
  echo "Puerto $port liberado."
}

free_port "$ADMIN_PORT"
free_port "$GATEWAY_PORT"

if [ ! -d node_modules ]; then
  echo "Instalando dependencias..."
  npm install
fi

mkdir -p logs

# Arranca el servidor ATADO a la consola (primer plano).
# Al cerrar la terminal o pulsar Ctrl+C se envia SIGINT/SIGTERM/SIGHUP y el proceso termina.
# Nota: process substitution (no pipe) para que el PID del job sea el de node y no el de tee.
node --disable-warning=ExperimentalWarning src/server.js > >(tee -a logs/gateway.log) 2>&1 &
NODE_PID=$!
echo $NODE_PID > logs/benzia.pid
TEE_PIDS=""

cleanup() {
  # Evita doble limpieza
  trap - INT TERM HUP EXIT
  if kill -0 "$NODE_PID" 2>/dev/null; then
    echo "Deteniendo benzIA (PID $NODE_PID)..."
    kill "$NODE_PID" 2>/dev/null || true
  fi
  # Espera gradual hasta 12 s; si no termina, forzar
  for i in $(seq 1 24); do
    kill -0 "$NODE_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$NODE_PID" 2>/dev/null; then
    echo "Cierre gradual agotado; forzando kill -9..."
    kill -9 "$NODE_PID" 2>/dev/null || true
  fi
  # Matamos tambien el tee hijo de la substitution (queda huerfano al morir node)
  for p in $TEE_PIDS; do
    kill -9 "$p" 2>/dev/null || true
  done
  wait "$NODE_PID" 2>/dev/null || true
}
trap cleanup INT TERM HUP EXIT
TEE_PIDS=$(pgrep -P "$$" tee 2>/dev/null || true)

for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$ADMIN_PORT/admin/api/session"; then
    echo "benzIA en marcha (PID $NODE_PID)"
    echo "  Panel:   http://localhost:$ADMIN_PORT"
    echo "  Gateway: http://localhost:$GATEWAY_PORT/v1"
    echo "  Chat:    http://localhost:$GATEWAY_PORT/chat"
    echo "  Logs:    logs/gateway.log (tambien se muestran en esta consola)"
    echo "  Parar:   Ctrl+C o cerrar esta consola"
    # Espera al servidor hasta que termine (Ctrl+C, cierre de consola o kill)
    wait "$NODE_PID"
    exit 0
  fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "El proceso termino al arrancar; ultimas lineas del log:" >&2
    tail -20 logs/gateway.log >&2
    exit 1
  fi
  sleep 0.5
done

echo "El servicio no respondio a tiempo; revisa logs/gateway.log" >&2
exit 1