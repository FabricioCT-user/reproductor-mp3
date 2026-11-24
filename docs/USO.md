# Guía de uso

Esta guía amplía el [README](../README.md): todas las funciones, los atajos completos, la versión web y los formatos que se reproducen.

## Primeros pasos

1. Abre la app: usa la [demo](https://fabricioct-user.github.io/tarareo/) o arranca la versión web con `npm run web` y abre <http://127.0.0.1:8000>. Sin npm: `python3 -m http.server --bind 127.0.0.1 8000` desde la raíz del proyecto. Para detener el servidor, Ctrl+C.
2. Pulsa **`+ Añadir`** (o **`+ Carpeta`**), o arrastra tus canciones a la ventana. Quedan guardadas en el navegador: no hay que volver a importarlas.
3. Pulsa una canción y a disfrutar. Los atajos están [más abajo](#atajos).

## Funciones

### Biblioteca

- Se guarda en el navegador (IndexedDB): al reabrir la página tus canciones siguen ahí.
- Importa archivos sueltos o **carpetas completas** (con subcarpetas) con `+ Añadir`, `+ Carpeta` o arrastrándolos a la ventana. Se ordenan por ruta en orden natural (`2` antes que `10`), se ignora lo que no es audio o video y no se duplica lo ya importado.
- Búsqueda, reordenar arrastrando (el orden se guarda) y cola de reproducción (`+` en una canción).
- **Listas de reproducción con nombre**, reordenables. Siguiente y anterior respetan la lista desde la que reproduces.
- **Exportar e importar listas** (botón `⋯`): JSON con todas tus listas, o M3U8 estándar. Las canciones se identifican por nombre de archivo y tamaño; las que aún no estén en la biblioteca quedan «pendientes» y se enlazan solas al importarlas.

### Reproducción

- Aleatorio, repetir, volumen, velocidad de 0,5× a 2× sin cambiar el tono, y teclas multimedia del sistema.
- **Fundido entre canciones** de 2 a 12 s (potencia constante) cuando la reproducción pasa sola a la siguiente. Entre pistas de audio; si hay un video, el cambio es un corte.
- **Temporizador de apagado** (15, 30, 45, 60 o 90 min; personalizado de hasta 720 min; o «al terminar la pista») con fundido de salida.
- **Ecualizador de 10 bandas** con preajustes, y visualizador de audio.
- **Letras sincronizadas**: lee la letra incrustada o archivos `.lrc` (suéltalos junto al audio con el mismo nombre), resalta la línea actual, y pulsar una línea salta a ella.

### Etiquetas

- Lee título, artista, álbum, carátula y letra de **MP3 (ID3v2.2–2.4), FLAC, Ogg Vorbis, Opus y M4A/AAC**.
- **Edita** título, artista, álbum y carátula o miniatura de una pista (`✎` o doble clic sobre el título), o de **varias a la vez** (`Seleccionar` o Ctrl/Cmd + clic). Solo se cambian los campos que toques, y funciona igual para audio y video. Los cambios se guardan en la app y se pueden restaurar: **tus archivos originales no se modifican**.
- **Descarga una copia con las etiquetas escritas dentro** (solo MP3 y FLAC; oculto para video). En edición múltiple mezclada, los videos se saltan sin cargarlos en memoria. El resto de etiquetas y el audio se conservan byte a byte, y la copia se vuelve a leer para comprobar que coincide antes de descargarla.

### Video

- Reproduce MP4, M4V, WebM, MKV y MOV en la misma interfaz, según los códecs que soporte tu navegador o Electron (ver [Formatos y compatibilidad](#formatos-y-compatibilidad)).
- **Pantalla completa** (`F`) e **imagen en imagen** (`I`), cuando el navegador lo permite.
- **Subtítulos SRT y WebVTT:** `C` los activa o desactiva, y `Z` / `X` los adelanta o retrasa 0,1 s. Se cargan con «Cargar subtítulos…» o se asocian por nombre si llegan junto al video.
- **Miniaturas** de los videos generadas en segundo plano, y vista 16:9 en la biblioteca.
- Editas título, artista, álbum y carátula igual que en audio. La copia con etiquetas no se ofrece para video.
- Entre un video y otra pista no hay fundido: el cambio es un corte.
- Si un códec puede no reproducirse (HEVC según el hardware, o AC-3 / E-AC-3, que se oyen mudos), la pista se marca en la biblioteca y la app avisa.
- En la app de escritorio, si mueves un video enlazado, su fila queda «No encontrado» con «Buscar…» o «Quitar» (ver [docs/ESCRITORIO.md](ESCRITORIO.md)).

### Interfaz

- Tema claro, oscuro o automático, adaptable a móvil, instalable como app (PWA) y funciona sin conexión.
- Una vez instalada, se ofrece en «Abrir con…» para los archivos de audio y video del sistema.

## Atajos

| Tecla | Acción |
|---|---|
| `Espacio` | Reproducir / pausar |
| `←` / `→` | Retroceder / avanzar 5 s |
| `Mayús` + `←` / `→` | Retroceder / avanzar 30 s |
| `,` / `.` | Fotograma anterior / siguiente (en video en pausa) |
| `↑` / `↓` | Volumen |
| `N` / `P` | Siguiente / anterior |
| `S` / `R` | Aleatorio / repetir |
| `M` | Silenciar |
| `[` / `]` | Velocidad más lenta / más rápida |
| `L` | Mostrar / ocultar letra (en audio) |
| `F` | Pantalla completa (en video) |
| `I` | Imagen en imagen / Picture-in-Picture (en video) |
| `C` | Activar / desactivar subtítulos (en video) |
| `Z` / `X` | Adelantar / retrasar subtítulos 0,1 s (en video) |

## Uso en el navegador

### Instalar como app

Desde Chrome o Edge puedes **instalarla como app** (icono de instalar en la barra de direcciones, o menú ⋮ → «Instalar Tarareo»). Una vez instalada se abre en su propia ventana y también funciona sin el servidor, porque se sirve desde la copia guardada.

### Abrir un archivo con doble clic («Abrir con…»)

Con la app **instalada** en Chrome o Edge de escritorio, el sistema la ofrece como programa para abrir `.mp3`, `.flac`, `.m4a`, `.ogg`, `.oga`, `.opus`, `.aac`, `.wav`, `.mp4` y `.webm`:

1. Instala la app como se explica arriba.
2. Clic derecho sobre un archivo de audio o video → **Abrir con** → *Tarareo* (en Windows: «Elegir otra aplicación»; en macOS: «Obtener información» → «Abrir con»). Para que sea el programa por defecto, marca «Usar siempre» o cámbialo en las propiedades del tipo de archivo.
3. El archivo se añade a la biblioteca y empieza a sonar. Si abres varios a la vez, suena el primero y el resto quedan en la cola. Si la app ya está abierta, los archivos van a esa ventana.

La app de escritorio, además, registra `.weba`, `.m4v`, `.mkv` y `.mov`.

Si el navegador no permite que algo suene sin que hayas tocado la página, la app lo pausa y avisa («pulsa ▶») en vez de reproducir en silencio.

### Si usas Firefox

Firefox de escritorio no permite instalar aplicaciones web ni registrarlas en «Abrir con…». Para reproducir un archivo local:

1. Abre la app (<http://127.0.0.1:8000>).
2. Arrastra el archivo (o toda la carpeta) a la ventana, o usa `+ Añadir` / `+ Carpeta`.
3. Queda guardado en la biblioteca: no hay que volver a importarlo la próxima vez.

Consejo: fija la pestaña (clic derecho → *Fijar pestaña*) para tener el reproductor siempre a mano. En Firefox se ha comprobado la importación de la demo («Probar con ejemplos»); el resto de la app no se ha verificado todavía.

> Tu biblioteca, tus listas y tus ajustes se guardan en el navegador y **ligados a la dirección exacta** (`127.0.0.1:8000` no comparte datos con `localhost:8000`). Si borras los datos del sitio se pierden; exporta tus listas antes si te importa conservarlas. Los archivos de música y los videos de hasta 2 GB se copian dentro del almacenamiento del navegador (en la primera importación de video se solicita almacenamiento persistente); los videos de más de 2 GB se reproducen solo en esa sesión y la app recomienda usar la versión de escritorio.

## Probar con ejemplos

En la versión web, con la biblioteca vacía, aparece el botón **«Probar con ejemplos»**. Al pulsarlo, la app descarga desde el mismo sitio tres canciones (dos MP3 y un FLAC), la letra de una de ellas, un video WebM y sus subtítulos VTT, y los importa a la biblioteca. Aparte de cargar la propia app, es la única descarga que hace, y solo ocurre con ese clic.

Los ejemplos son audios y un video generados para la demo, sin grabaciones de terceros; su procedencia y cómo regenerarlos están en [ejemplos/LEEME.md](../ejemplos/LEEME.md). El botón no aparece en la app de escritorio ni cuando hay filtros o una lista seleccionada.

## Formatos y compatibilidad

- **Recomendados:** audio en MP3, FLAC, Ogg Vorbis, Opus, M4A (AAC) y WAV; video en **MP4 (H.264 + AAC)** y **WebM (VP8/VP9/AV1 + Opus/Vorbis)**.
- **Comprobación al importar:** en archivos MP4/M4V/M4A/MOV (`stsd`) y WebM/MKV (`Tracks` / `CodecID` en los primeros 256 KiB), el reproductor lee los códecs de las pistas y comprueba la compatibilidad con `canPlayType`. Si algún códec no es compatible (por ejemplo **HEVC/H.265** sin decodificador, o audio **AC-3/E-AC-3**, que se reproduce mudo sin error), la pista se importa igualmente pero queda marcada en la biblioteca («puede no reproducirse») con el motivo, y avisa al reproducir.
- **MKV, AVI, MOV u otros contenedores:** si un archivo no se reproduce o falla por el contenedor, puedes cambiarlo a MP4 **sin recodificar** (remux instantáneo y sin pérdida de calidad) con `ffmpeg`:

```bash
ffmpeg -i entrada.mkv -c copy salida.mp4
```

Si el archivo tenía audio AC-3/E-AC-3 (sin sonido), convierte solo el audio a AAC conservando el video intacto:

```bash
ffmpeg -i entrada.mkv -c:v copy -c:a aac salida.mp4
```
