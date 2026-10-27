#!/usr/bin/env bash
# Arranque de benzIA para el acceso directo del escritorio.
# Prepara el entorno (Node/npm del nvm) y la configuracion (.env) antes de
# llamar al lanzador del proyecto (start-benzia.sh).
set -euo pipefail

PROYECTO="$HOME/Proyectos/benzIA"
cd "$PROYECTO"

avisar_error() {
  echo "$1" >&2
  command -v zenity >/dev/null 2>&1 && zenity --error --title="benzIA no puede arrancar" --text="$1" || true
}

# --- 0) benzIA ya esta gestionado por el servicio del sistema (arranque automatico) ---
if [ -z "${BENZIA_SERVICIO:-}" ] && systemctl is-active --quiet benzia.service 2>/dev/null; then
  aviso="benzIA ya esta en marcha como servicio del sistema (arranque automatico al encender el equipo). Su consola se abre al iniciar sesion. Para lanzarlo a mano primero: sudo systemctl stop benzia.service"
  echo "$aviso"
  command -v zenity >/dev/null 2>&1 && zenity --info --title="benzIA" --text="$aviso" || true
  exit 0
fi

# --- 1) Node y npm: el acceso directo no hereda el nvm del terminal ---
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  candidato=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
  [ -n "$candidato" ] && export PATH="$candidato:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  avisar_error "No se encontro Node.js ni npm. Instalalos (o revisa nvm) y vuelve a intentarlo."
  exit 1
fi

version_mayor=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$version_mayor" -lt 20 ]; then
  echo "Aviso: benzIA necesita Node 20 o superior y tienes $(node -v). Puede fallar." >&2
fi

# --- 2) Configuracion .env (se crea una sola vez, con token nuevo) ---
if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    avisar_error "No existe .env ni .env.example en $PROYECTO."
    exit 1
  fi
  cp .env.example .env
  token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$token|" .env
  echo "Se creo el archivo de configuracion .env con una contrasena de administrador nueva."
  echo "  Archivo:             $PROYECTO/.env"
  echo "  Contrasena del panel: $token"
  echo "  (Puedes cambiarla despues editando la linea ADMIN_TOKEN de ese archivo)"
  echo
fi

# --- 3) Dependencias ---
if [ ! -d node_modules ]; then
  echo "Primera vez: se instalaran las dependencias con npm. Puede tardar varios minutos."
  echo
fi

# --- 4) Arranque del proyecto (deja el servicio en primer plano) ---
echo "Iniciando benzIA..."
exec "$PROYECTO/start-benzia.sh"
