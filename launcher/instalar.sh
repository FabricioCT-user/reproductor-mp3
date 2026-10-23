#!/usr/bin/env bash
# Registra el lanzador como programa para abrir archivos de audio («Abrir con…») en Linux.
#
#   ./launcher/instalar.sh                    añade «Reproductor MP3» a la lista de «Abrir con…»
#   ./launcher/instalar.sh --predeterminado   además lo pone como programa por defecto de esos tipos
#   ./launcher/instalar.sh --quitar           lo elimina
#
# Solo escribe un archivo .desktop en tu carpeta personal (~/.local/share/applications); no toca nada del sistema.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(dirname "$AQUI")"
DESTINO="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
NOMBRE="reproductor-mp3.desktop"
ARCHIVO="$DESTINO/$NOMBRE"
TIPOS=(audio/mpeg audio/flac audio/x-flac audio/ogg audio/x-vorbis+ogg audio/opus audio/mp4 audio/x-m4a audio/aac audio/wav audio/x-wav)

actualizar_base() { command -v update-desktop-database >/dev/null && update-desktop-database "$DESTINO" 2>/dev/null || true; }

case "${1:-}" in
  --quitar)
    rm -f "$ARCHIVO"
    actualizar_base
    echo "Eliminado $ARCHIVO"
    exit 0 ;;
  ""|--predeterminado) ;;
  *) echo "Uso: $0 [--predeterminado | --quitar]" >&2; exit 1 ;;
esac

# El campo Exec del .desktop tiene reglas de escape propias: se rechazan rutas con caracteres problemáticos.
if [[ "$AQUI" =~ [\"\`\$\\] ]]; then
  echo "La ruta del proyecto contiene comillas, \$, \` o \\ y no se puede registrar. Muévelo a otra carpeta." >&2
  exit 1
fi

chmod +x "$AQUI/reproductor" "$AQUI/servidor.py"
mkdir -p "$DESTINO"
mimes="$(IFS=';'; echo "${TIPOS[*]}");"

cat > "$ARCHIVO" <<EOF
[Desktop Entry]
Type=Application
Name=Reproductor MP3
Comment=Reproductor de música local en el navegador
Exec="$AQUI/reproductor" %F
Icon=$RAIZ/icon-512.png
Terminal=false
Categories=AudioVideo;Audio;Player;
MimeType=$mimes
StartupNotify=false
EOF
chmod 644 "$ARCHIVO"
actualizar_base
if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$ARCHIVO" || echo "(aviso de validación; puede ser inofensivo)"; fi

if [[ "${1:-}" == "--predeterminado" ]]; then
  for t in "${TIPOS[@]}"; do xdg-mime default "$NOMBRE" "$t"; done
  echo "«Reproductor MP3» es ahora el programa por defecto para: ${TIPOS[*]}"
fi

echo "Instalado: $ARCHIVO"
echo "Clic derecho sobre un archivo de audio → «Abrir con» → «Reproductor MP3»."
echo "Para quitarlo: $0 --quitar"
