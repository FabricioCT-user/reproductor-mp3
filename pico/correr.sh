#!/bin/bash
# Pico TE.0: ejecuta las fases y deja los JSON en $SALIDA.
# Uso: bash pico/correr.sh <carpeta-medios> <carpeta-salida>
set -u
cd "$(dirname "$0")/.."
M=$1; S=$2; DATOS=$M/datos
corre() { # fase modo nombre
  PICO_MEDIOS=$M PICO_DATOS=$DATOS PICO_FASE=$1 PICO_RANGO=$2 PICO_SALIDA=$S/$3.json \
    timeout 280 node_modules/.bin/electron pico/main.js > "$S/$3.log" 2>&1
  echo "$3: exit $?"
}
rm -rf "$DATOS"
corre a propio a-propio
corre b propio b-persistencia
corre rango net rango-net
corre rango propio rango-propio
