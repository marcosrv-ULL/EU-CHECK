#!/usr/bin/env bash
set -euo pipefail

FILE="./nginx/whitelist.conf"

usage() {
  echo "Uso: $0 {add|del} <ip>"
  exit 1
}

# Requiere root
if [[ $EUID -ne 0 ]]; then
  echo "Este script debe ejecutarse como root" >&2
  exit 1
fi

# Validación argumentos
[ $# -eq 2 ] || usage
ACTION=$1
IP=$2

# Validación básica de IPv4
if ! [[ $IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Error: dirección IP inválida -> $IP"
  exit 2
fi

LINE="allow ${IP};"

case "$ACTION" in
  add)
    if grep -qxF "$LINE" "$FILE"; then
      echo "La IP $IP ya está en $FILE"
    else
      # Añadir al inicio del fichero
      sed -i "1i $LINE" "$FILE"
      echo "Añadida: $LINE"
    fi
    ;;
  del)
    if grep -qxF "$LINE" "$FILE"; then
      sed -i "\|^$LINE\$|d" "$FILE"
      echo "Eliminada: $LINE"
    else
      echo "La IP $IP no estaba en $FILE"
    fi
    ;;
  *)
    usage
    ;;
esac

echo "Reiniciando contenedores con docker compose..."
if docker compose restart; then
  echo "✔  Reinicio completado correctamente."
else
  echo "❌ Error al reiniciar docker compose."
  exit 3
fi
