# Reproductor

[![Pruebas](https://github.com/FabricioCT-user/reproductor-mp3/actions/workflows/test.yml/badge.svg)](https://github.com/FabricioCT-user/reproductor-mp3/actions/workflows/test.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

Reproductor de música local que corre en el navegador. **Sin build**: tus archivos nunca salen de tu equipo.

## Inicio rápido

**Requisitos:** un navegador moderno (probado en Chromium), Node.js y npm. Para servir solo la versión web también puedes usar Python 3.

```bash
git clone https://github.com/FabricioCT-user/reproductor-mp3.git
cd reproductor-mp3
npm run web                        # servidor web estático en http://127.0.0.1:8000
```

Con `npm install`, `npm start` abre la app de escritorio (Electron).

1. Abre <http://127.0.0.1:8000>.
2. Pulsa **`+ Añadir`** (o **`+ Carpeta`**), o arrastra tus canciones a la ventana. Quedan guardadas en el navegador: no hay que volver a importarlas.
3. Pulsa una canción y a disfrutar. Las [funciones](#funciones) y los [atajos](#atajos) están más abajo.

¿Quieres abrir un archivo desde tu gestor de archivos? Instala la app de escritorio con el paquete de tu sistema.

## Funciones

**Biblioteca**
- Se guarda en el navegador (IndexedDB): al reabrir la página tus canciones siguen ahí.
- Importa archivos sueltos o **carpetas completas** (con subcarpetas) con `+ Añadir`, `+ Carpeta` o arrastrándolos a la ventana. Se ordenan por ruta en orden natural (`2` antes que `10`), se ignora lo que no es audio y no se duplica lo ya importado.
- Búsqueda, reordenar arrastrando (el orden se guarda) y cola de reproducción (`+` en una canción).
- **Listas de reproducción con nombre**, reordenables. Siguiente/anterior respetan la lista desde la que reproduces.
- **Exportar e importar listas** (botón `⋯`): JSON con todas tus listas o M3U8 estándar. Las canciones se identifican por nombre de archivo y tamaño; las que aún no estén en la biblioteca quedan «pendientes» y se enlazan solas al importarlas.

**Reproducción**
- Aleatorio, repetir, volumen, velocidad de 0,5× a 2× sin cambiar el tono, y teclas multimedia del sistema.
- **Fundido entre canciones** de 2 a 12 s (potencia constante) cuando la reproducción pasa sola a la siguiente.
- **Temporizador de apagado** (15–90 min, personalizado o «al terminar la canción») con fundido de salida.
- **Ecualizador de 10 bandas** con preajustes y visualizador de audio.
- **Letras sincronizadas**: lee la letra incrustada o archivos `.lrc` (suéltalos junto al audio con el mismo nombre) y resalta la línea actual; pulsa una línea para saltar a ella.

**Etiquetas**
- Lee título, artista, álbum, carátula y letra de **MP3 (ID3v2.2–2.4), FLAC, Ogg Vorbis, Opus y M4A/AAC**.
- **Edita** título, artista, álbum y carátula de una canción (`✎` o doble clic sobre el título) o de **varias a la vez** (`Seleccionar` o Ctrl/Cmd + clic; solo se cambian los campos que toques). Los cambios se guardan en la app y se pueden restaurar: **tus archivos originales no se modifican**.
- **Descarga una copia con las etiquetas escritas dentro** (solo MP3 y FLAC). El resto de etiquetas y el audio se conservan byte a byte, y la copia se vuelve a leer para comprobar que coincide antes de descargarla.

**Interfaz**
- Tema claro, oscuro o automático, adaptable a móvil, instalable como app (PWA) y funciona sin conexión.
- Una vez instalada, se ofrece en «Abrir con…» para los archivos de audio del sistema.

## Atajos

| Tecla | Acción |
|---|---|
| `Espacio` | Reproducir / pausar |
| `←` / `→` | Retroceder / avanzar 5 s |
| `↑` / `↓` | Volumen |
| `N` / `P` | Siguiente / anterior |
| `S` / `R` | Aleatorio / repetir |
| `M` | Silenciar |
| `[` / `]` | Velocidad más lenta / más rápida |
| `L` | Mostrar / ocultar letra |
| `F` | Pantalla completa (en video) |

## Uso

Para usar la versión web, arranca el servidor estático (se detiene con Ctrl+C):

```bash
npm run web           # servidor estático en http://127.0.0.1:8000
```

y abre <http://127.0.0.1:8000>. Desde Chrome o Edge puedes **instalarla como app** (icono de instalar en la barra de direcciones, o menú ⋮ → «Instalar Reproductor»). Una vez instalada se abre en su propia ventana y también funciona sin el servidor (se sirve desde la copia guardada).

### Abrir un archivo con doble clic («Abrir con…»)

Con la app **instalada** (Chrome o Edge de escritorio), el sistema la ofrece como programa para abrir `.mp3`, `.flac`, `.m4a`, `.ogg`, `.oga`, `.opus`, `.aac` y `.wav`:

1. Instala la app como se explica arriba.
2. Clic derecho sobre un archivo de audio → **Abrir con** → *Reproductor* (en Windows: «Elegir otra aplicación»; en macOS: «Obtener información» → «Abrir con»). Para que sea el programa por defecto, marca «Usar siempre» o cámbialo en las propiedades del tipo de archivo.
3. El archivo se añade a la biblioteca y empieza a sonar. Si abres varios a la vez, suena el primero y el resto quedan en la cola. Si la app ya está abierta, los archivos van a esa ventana.

Si el navegador no permite que algo suene sin que hayas tocado la página, la app lo pausa y avisa («pulsa ▶») en vez de reproducir en silencio.

### Si usas Firefox

Firefox de escritorio no permite instalar aplicaciones web ni registrarlas en «Abrir con…». Para reproducir un archivo local:

1. Abre la app (<http://127.0.0.1:8000>).
2. Arrastra el archivo (o toda la carpeta) a la ventana, o usa `+ Añadir` / `+ Carpeta`.
3. Queda guardado en la biblioteca: no hay que volver a importarlo la próxima vez.

Consejo: fija la pestaña (clic derecho → *Fijar pestaña*) para tener el reproductor siempre a mano. Firefox no se ha probado todavía con esta aplicación.

> Tu biblioteca, tus listas y tus ajustes se guardan en el navegador y **ligados a la dirección exacta** (`127.0.0.1:8000` no comparte datos con `localhost:8000`). Si borras los datos del sitio se pierden; exporta tus listas antes si te importa conservarlas. Los archivos de música se copian dentro del almacenamiento del navegador.

## Formatos y compatibilidad

- **Recomendados:** audio en MP3, FLAC, Ogg Vorbis, Opus, M4A (AAC) y WAV; video en **MP4 (H.264 + AAC)** y **WebM (VP8/VP9/AV1 + Opus/Vorbis)**.
- **Comprobación al importar:** en archivos MP4/M4V/M4A/MOV (`stsd`) y WebM/MKV (`Tracks` / `CodecID` en los primeros 256 KiB) el reproductor lee los códecs de las pistas y comprueba compatibilidad con `canPlayType`. Si algún códec no es compatible (por ejemplo **HEVC/H.265** sin decodificador o audio **AC-3/E-AC-3**, que se reproduce mudo sin error), la pista se importa igualmente pero queda marcada en la biblioteca («puede no reproducirse») con el motivo y avisa al reproducir.
- **MKV, AVI, MOV u otros contenedores:** si un archivo no se reproduce o falla por el contenedor, puedes cambiar el contenedor a MP4 **sin recodificar** (remux instantáneo y sin pérdida de calidad) con `ffmpeg`:

```bash
ffmpeg -i entrada.mkv -c copy salida.mp4
```

Si el archivo tenía audio AC-3/E-AC-3 (sin sonido), convierte solo el audio a AAC conservando el video intacto:

```bash
ffmpeg -i entrada.mkv -c:v copy -c:a aac salida.mp4
```

## Privacidad

No hay servidor remoto ni análisis: la aplicación solo se descarga a sí misma (el servidor web local escucha únicamente en tu equipo). Una política de seguridad de contenido (CSP) impide cargar nada de otros sitios.

## Desarrollo

Sin dependencias: JavaScript clásico en el navegador, sin empaquetador. Para las pruebas basta con Node 22 o superior (probado con 26). La app de escritorio (en construcción) usa Electron, que solo hace falta para ella: `npm test` no lo necesita.

```
index.html  style.css  sw.js  manifest.webmanifest   página, estilos, caché sin conexión, PWA
src/
  util.js          funciones puras (formatos, rutas, isAudio…)
  lyrics.js        analizador de letras LRC
  playlist-io.js   formato JSON y M3U8 de las listas
  id3.js           lector ID3v2 (y analizador compartido con el escritor)
  mp4.js           recorrido de átomos MP4 (64 bits, size=0, lectura incremental sin cargar mdat/stbl)
  mkv.js           detección acotada (256 KiB) de pistas y CodecID en contenedores Matroska/WebM (EBML)
  tags.js          lector de etiquetas: FLAC, Ogg/Opus, M4A (MP3 se delega en id3.js)
  tag-writer.js    escritor de etiquetas para copias de MP3 y FLAC
  storage.js       biblioteca en IndexedDB (v2: metadatos en «tracks», archivos aparte en «files»; migra la v1 sola)
  app/             la aplicación, un archivo por función:
                   core, library, playlists, lyrics-ui, player, eq, fades, editor, theme, main
electron/          app de escritorio: main.js (protocolo app://reproductor/, ventana endurecida, instancia
                   única y archivos abiertos desde el sistema), preload.js (puente mínimo), lib/servir.js (lista blanca
                   del protocolo), lib/argumentos.js, lib/rutas.js (validar rutas), lib/entregas.js (ids de archivos abiertos),
                   lib/enlaces.js (registro de videos enlazados), lib/rango.js, lib/medios.js (servir videos con Range)
                   y lib/escritorio.js (integración .desktop opcional del AppImage)
tests/
  unit/            pruebas con node:test (módulos puros, escritor de etiquetas, almacenamiento y migración, coherencia del proyecto)
  smoke.html       pruebas de humo: manejan la aplicación real en el navegador
  smoke-app.js     ejecuta las mismas pruebas de humo dentro de Electron (npm run smoke:app)
```

**Cómo está organizado `src/app/`**: cada archivo solo *declara* (funciones y constantes); no hace nada al cargarse. Todo el cableado de eventos vive en funciones `wire…()` (una por archivo) que `main.js` llama al final, cuando todo ya existe. Por eso el orden de carga solo importa para las constantes que se usan al declarar (`index.html` y las pruebas lo vigilan).

**Pruebas**

```bash
npm test                         # unitarias (~175 pruebas, unos segundos)
npm run web                      # y abre http://127.0.0.1:8000/tests/smoke.html para las de humo
npm install && npm run smoke:app # las mismas de humo dentro de Electron, sin ventana; sale con 0 o 1 (necesita ffmpeg)
```

Las unitarias cargan los mismos scripts que el navegador dentro de un contexto aislado de Node y construyen archivos MP3, FLAC, Ogg y MP4 sintéticos para comprobar lectores y escritor (unsincronización, cabecera extendida, ID3v2.2, carátulas, bloques FLAC…). Las de humo importan archivos, reproducen, reordenan, editan, exportan, recargan y fuerzan fallos (archivos que no se pueden reproducir, `localStorage` corrupto, registros dañados) y comprueban que una biblioteca guardada con la versión anterior de la base (v1) se migra sin perder canciones, letras, ediciones ni orden. La prueba de humo del navegador usa audio generado en el propio navegador y no necesita ffmpeg; la de Electron genera con ffmpeg los videos que enlaza (uno de 5 minutos, para que los saltos abran y cancelen peticiones de verdad) y cuenta en `/proc/self/fd` que no quede ningún archivo abierto.

**App de escritorio (Electron) — instalación y empaquetado**

```bash
npm install          # instala Electron 45.4.1 y electron-builder (solo desarrollo)
npm run app          # abre la app (con menú y herramientas de desarrollo)
npm run dist         # genera los paquetes Linux en dist/ (.pacman, .AppImage y .deb)
```

> En Arch Linux, `electron-builder` usa su `fpm` empaquetado (Ruby) para generar `.pacman` y `.deb`, que necesita `libxcrypt-compat` (`libcrypt.so.1`). Si solo quieres el AppImage: `npx electron-builder --linux AppImage`.

- **Arch Linux (`.pacman`):** instala el paquete generado en `dist/` con `sudo pacman -U dist/reproductor-mp3-*.pacman`. Registra el binario `/usr/bin/reproductor`, el icono y el archivo `.desktop` con asociaciones de audio y video («Abrir con… → Reproductor»). Configura el sandbox automáticamente (espacios de nombres de usuario o `chrome-sandbox` SUID si el kernel no los permite; nunca `--no-sandbox`).
- **AppImage (`.AppImage`):** dale permiso de ejecución (`chmod +x dist/Reproductor-*.AppImage`) y ejecútalo directamente. Como el AppImage no registra asociaciones por sí solo, puedes integrarlo en el menú y en «Abrir con…» con:

  ```bash
  dist/Reproductor-1.0.0.AppImage --instalar-escritorio
  ```

  Esto escribe `~/.local/share/applications/reproductor.desktop` y el icono en `~/.local/share/icons/hicolor/512x512/apps/reproductor.png` apuntando a la ruta actual del AppImage (vuelve a ejecutarlo si lo mueves de sitio; para quitarlo basta borrar ambos archivos). También funciona con gestores como AppImageLauncher o Gear Lever. En sistemas donde los espacios de nombres de usuario sin privilegios están restringidos (p. ej. Ubuntu ≥ 23.10 con AppArmor o kernels con `unprivileged_userns_clone=0`), el lanzador interno del AppImage intenta añadir `--no-sandbox` y **la app se niega a arrancar** (nunca se ejecuta sin sandbox); en esos casos usa el paquete `.deb` o `.pacman`, o habilita los espacios de nombres de usuario.
- **Debian / Ubuntu (`.deb`):** `sudo apt install ./dist/reproductor-mp3_*.deb`. Registra las mismas asociaciones de audio y video e instala el perfil de AppArmor/sandbox.
- **Sandbox en sistemas sin espacios de nombres de usuario (`linux-hardened`, `unprivileged_userns_clone=0`):** el script de post-instalación de `.pacman`/`.deb` comprueba `unshare` como `root` y puede dejar `/opt/Reproductor/chrome-sandbox` con permisos `0755`, haciendo que la app falle cerrada al arrancar. Para resolverlo, habilita el bit SUID a mano (`sudo chmod 4755 /opt/Reproductor/chrome-sandbox`) o habilita los espacios de nombres de usuario; **nunca** uses `--no-sandbox` (la app lo rechaza).
- **Sin auto-actualización ni telemetría:** los paquetes no se conectan a ningún servidor ni comprueban actualizaciones.

La app sirve la misma interfaz desde `app://reproductor/`, que solo entrega los archivos de `FILES` de `sw.js` (más `index.html`) y repite la CSP del meta como cabecera. La ventana va endurecida: aislamiento de contexto, sandbox, sin Node en la página, sin ventanas nuevas ni navegación fuera de la app y sin permisos salvo pantalla completa; el paquete lleva los *fuses* de Electron que impiden usarlo como Node (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) y solo carga la app del `.asar` (nota: el *fuse* `EnableEmbeddedAsarIntegrityValidation` está activado, pero Electron solo valida la integridad del `.asar` en macOS y Windows, no en Linux; en Linux la integridad depende de los permisos del paquete o del squashfs de solo lectura del AppImage). Dentro de la app no se registra el service worker.

**Abrir archivos en la app:** `npm run app -- ~/Música/cancion.mp3 "$HOME/Música/otra canción.flac"` (rutas absolutas: npm ejecuta desde la carpeta del proyecto; también valen URLs `file://`) los añade a la biblioteca, suena el primero y los demás quedan en la cola. Con la app ya abierta, abrir más archivos (otra vez el mismo comando o, cuando exista el paquete, «Abrir con…») no abre otra ventana: los entrega a la abierta y la pone al frente. En la app, «+ Añadir» y «+ Carpeta» usan el diálogo del sistema. El proceso principal solo acepta archivos regulares (resuelve enlaces simbólicos y mira la extensión del destino) de audio, video, `.lrc`, `.srt` o `.vtt`, y la interfaz nunca ve rutas: recibe un id de un solo uso y pide con él los bytes, que se copian a la biblioteca como cualquier otro archivo. Los subtítulos aún no se abren.

**Videos en la app: se enlazan, no se copian.** Un video que llega por «Abrir con…», el diálogo, arrastrándolo o con el selector de archivos se registra en `enlaces.json`, dentro de la carpeta de datos de la app (permisos 0600), con un id opaco; la biblioteca (IndexedDB) guarda solo ese id (`source: "link"`) y nunca la ruta. La interfaz lo reproduce desde `app://reproductor/__media/<id>`, que el proceso principal sirve con `Range` propio (`206`, `416`, tipo por extensión) leyendo el archivo por trozos de 512 KB solo cuando el reproductor los pide y cerrándolo en cuanto cancela la petición (al saltar), así que un video de varios GB ni se copia ni se carga en memoria. Las etiquetas se leen también por `Range`. Solo se sirven ids registrados; quitar la pista olvida su enlace. Si el archivo se mueve o se borra, la pista no se pierde (avisar «no encontrado» y volver a enlazarlo llegará después). El audio se sigue copiando a la biblioteca, y la versión web no cambia: allí los videos se copian como cualquier archivo. La asociación con el gestor de archivos («Abrir con…») se ofrece con la app de escritorio instalada.

**Al publicar una versión nueva**, si cambia la lista de archivos de la aplicación actualiza `FILES` y `VERSION` en `sw.js` (una prueba comprueba que `FILES` coincide con lo que carga la página).

## Límites conocidos

- La lista de canciones no está virtualizada: con cientos va bien; con decenas de miles aún no se ha probado.
- Las copias con etiquetas solo existen para MP3 y FLAC. En MP3 con etiqueta ID3v2.2 (muy antiguo) la copia solo lleva las etiquetas editadas.
- Las ediciones y las letras cargadas viven en el navegador; no viajan con el archivo salvo que descargues la copia.
- «Abrir con…» solo funciona con la app instalada en Chrome o Edge de escritorio, y la integración con el sistema (menú contextual, programa por defecto) depende del sistema operativo: sus pruebas automáticas cubren la parte de la app, no el propio menú del sistema.
- Probado en Chromium; en Firefox y Safari el audio, el almacenamiento y las carpetas deberían funcionar, pero no se ha verificado.

## Hoja de ruta

- [ ] Descargar copias con etiquetas también para Ogg, Opus y M4A

## Licencia

MIT
