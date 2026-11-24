# Desarrollo

Sin dependencias en ejecución: JavaScript clásico en el navegador, sin empaquetador. Electron 45.4.1 (versión exacta, solo para desarrollo) hace falta únicamente para la app de escritorio: `npm test` no lo necesita. La CI usa Node 22.

## Comandos

```bash
npm test           # 231 pruebas unitarias (node:test), unos segundos
npm run web        # servidor estático en http://127.0.0.1:8000
npm run smoke:app  # pruebas de humo dentro de Electron, sin ventana (necesita ffmpeg)
npm run app        # app de escritorio con menú y herramientas de desarrollo
npm run dist       # paquetes Linux en dist/ (.pacman, .AppImage y .deb)
```

Pruebas de humo en el navegador: con `npm run web` abre <http://127.0.0.1:8000/tests/smoke.html>.

## Estructura

```
index.html  style.css  sw.js  manifest.webmanifest   página, estilos, caché sin conexión, PWA
icon.svg  icon-*.png                                  logotipos
src/
  util.js          funciones puras (formatos, rutas, isAudio…)
  lyrics.js        analizador de letras LRC
  playlist-io.js   formato JSON y M3U8 de las listas
  id3.js           lector ID3v2 (y analizador compartido con el escritor)
  mp4.js           recorrido de átomos MP4 (64 bits, size=0, lectura incremental sin cargar mdat/stbl)
  mkv.js           detección acotada (256 KiB) de pistas y CodecID en contenedores Matroska/WebM (EBML)
  subtitles.js     SRT y WebVTT: parse, decode (UTF-8, UTF-16, windows-1252) y toVtt
  tags.js          lector de etiquetas: FLAC, Ogg/Opus, M4A (MP3 se delega en id3.js)
  tag-writer.js    escritor de etiquetas para copias de MP3 y FLAC
  storage.js       biblioteca en IndexedDB (v2: metadatos en «tracks», archivos aparte en «files»; migra la v1 sola)
  app/             la aplicación, un archivo por función:
                   core, library, playlists, lyrics-ui, player, eq, fades, editor, theme, fullscreen, pip, subtitles-ui, main
electron/          app de escritorio: main.js (protocolo app://reproductor/, ventana endurecida, instancia
                   única y archivos abiertos desde el sistema), preload.js (puente mínimo), lib/servir.js (lista blanca
                   del protocolo), lib/argumentos.js, lib/rutas.js (validar rutas), lib/entregas.js (ids de archivos abiertos),
                   lib/enlaces.js (registro de videos enlazados), lib/rango.js, lib/medios.js (servir videos con Range)
                   y lib/escritorio.js (integración .desktop opcional del AppImage)
ejemplos/          audios y video de la demo (y LEEME.md con su procedencia)
scripts/           generar-ejemplos.js: regenera ejemplos/ (requiere FFmpeg)
tests/
  unit/            pruebas con node:test (módulos puros, escritor de etiquetas, almacenamiento y migración, coherencia del proyecto)
  smoke.html       pruebas de humo: manejan la aplicación real en el navegador
  smoke-app.js     ejecuta las mismas pruebas de humo dentro de Electron (npm run smoke:app)
docs/              documentación (USO, ESCRITORIO, DESARROLLO) y PLAN-MP4.md (plan de video y de la app de escritorio)
```

**Cómo está organizado `src/app/`:** cada archivo solo *declara* (funciones y constantes); no hace nada al cargarse. Todo el cableado de eventos vive en funciones `wire…()` (una por archivo) que `main.js` llama al final, cuando todo ya existe. Por eso el orden de carga solo importa para las constantes que se usan al declarar (`index.html` y las pruebas lo vigilan). Todo es global, así que los nombres no pueden repetirse entre archivos.

**Al añadir o mover un archivo:** ponlo en `index.html` (el orden importa: `util`, `lyrics`, `id3` antes que `tags`, `tags` antes que `tag-writer`, `main.js` el último) y en `FILES` de `sw.js`. Una prueba de coherencia lo comprueba. Al cambiar la lista de archivos, sube también `VERSION` en `sw.js`: el service worker la usa para recuperar la caché.

## Convenciones

- **CSP estricta** (meta en `index.html`): sin `unsafe-inline` ni `unsafe-eval`. No uses `innerHTML` con datos de archivos (usa `textContent`), ni `style="…"` ni `onclick="…"` en el HTML, ni `eval`. Si cambias el script en línea del tema, actualiza su hash en la CSP (una prueba lo vigila).
- Los datos del usuario nunca salen del equipo: no añadas peticiones de red ni librerías externas.
- Acceso a `localStorage` solo mediante `store` (core.js): puede estar bloqueado o tener datos corruptos.
- **IndexedDB** `reproductor-mp3` **v2** (el nombre no cambia: hay datos guardados), con dos almacenes que comparten clave:
  - `tracks` (solo metadatos, nunca el archivo): `{ id, name, type, size, lastModified, kind, source, linkId?, lyrics?, edits?, meta?, subs?, thumb? }`. `kind`: `"audio"|"video"`. `source`: `"blob"` (archivo en `files`), `"link"` (enlazado por la app de escritorio vía `linkId`; **la ruta nunca se guarda en IndexedDB**) o `"session"` (no persistente; el arranque lo descarta).
  - `files`: `{ id, blob }`, solo para `source: "blob"`. Se lee perezoso con `Storage.getFile(id)`. `Storage.all()` devuelve solo metadatos, y `setField` (letras, ediciones) no toca `files`.
  - Migración v1 → v2 (v1 guardaba el `blob` dentro de `tracks`) en `onupgradeneeded`, dentro de la propia transacción: o se migra todo o nada. Si falla (p. ej. sin espacio), la base se abre en v1 y `Storage` la usa en ese formato; se reintenta en el siguiente arranque. Los registros sin blob válido se dejan como están (el arranque los descarta, salvo `source: "link"`). Pruebas: `tests/unit/storage.test.js` (IndexedDB falsa en `fake-idb.js`) y los escenarios «Migración» de la prueba de humo.
  - `localStorage`: `shuffle repeat speed crossfade playlists eq order lastId volume lyrics theme mediaFilter`.
  - Un cambio de esquema exige subir la versión y migrar en `onupgradeneeded`, con pruebas de migración. No rompas los datos existentes.
- Las ediciones de etiquetas **no modifican el original**: viven en `edits`. Solo «descargar copia» (MP3 y FLAC) escribe etiquetas, siempre en un archivo nuevo, y se verifica releyéndolo.
- Para reproducir sin clic previo (Abrir con…), `play()` comprueba que el contexto de audio esté activo; no dejes que suene en silencio.
- Electron: la ventana se crea con `show: false`, y `backgroundThrottling` solo se desactiva en `--smoke` (`electron/main.js`). `--smoke` exige `--user-data-dir` con una carpeta temporal. No pruebes con los datos reales: no uses `npm run app` con tu perfil.
- Electron: nunca `--no-sandbox` para que arranque algo. La app se niega a arrancar con esa opción, y una prueba lo vigila.
- Todo manejador IPC comprueba `deLaApp(event)` (una prueba lo vigila). `electron/lib` no puede hacer `require("electron")`; por eso se prueba con node:test.

## Pruebas

- **Unitarias** (`npm test`): cargan los mismos scripts que el navegador dentro de un contexto aislado de Node y construyen archivos MP3, FLAC, Ogg y MP4 sintéticos para comprobar lectores y escritor (unsincronización, cabecera extendida, ID3v2.2, carátulas, bloques FLAC…).
- **Humo en el navegador** (`tests/smoke.html`): importan archivos, reproducen, reordenan, editan, exportan, recargan y fuerzan fallos (archivos que no se pueden reproducir, `localStorage` corrupto, registros dañados). Comprueban que una biblioteca guardada con la base v1 se migra sin perder canciones, letras, ediciones ni orden. Usan audio generado en el propio navegador y no necesitan ffmpeg. Cargan la página sin CSP (vía `srcdoc` + `<base href="../">`) porque necesitan `eval`; la CSP real se comprueba aparte.
- **Humo en Electron** (`npm run smoke:app`): las mismas pruebas dentro de la app, sin ventana. Genera con ffmpeg los videos que enlaza (uno de 5 minutos, para que los saltos abran y cancelen peticiones de verdad) y cuenta en `/proc/self/fd` que no quede ningún archivo abierto. Sale con 0 o 1.
- La CI (`.github/workflows/test.yml`) ejecuta `npm test` en cada push.

## Ejemplos de la demo

Los archivos de `ejemplos/` los genera `scripts/generar-ejemplos.js` (síntesis propia y determinista; FFmpeg solo para codificar y medir). Para regenerarlos desde la raíz del proyecto: `/usr/bin/node scripts/generar-ejemplos.js`. Detalles en [ejemplos/LEEME.md](../ejemplos/LEEME.md).

## Empaquetado

- `npm run dist` genera `.pacman`, `.AppImage` y `.deb` en `dist/`. La configuración está en la clave `build` de `package.json`. Los pasos para instalar y probar los paquetes están en [ESCRITORIO.md](ESCRITORIO.md#instalación).

## Hoja de ruta

- [ ] Copias con etiquetas también para Ogg, Opus y M4A.
- Opcionales sin hacer (ver [docs/PLAN-MP4.md](PLAN-MP4.md)): T0.8 (escritor de copias M4A), T3.2 (metadatos WebM/MKV) y T4.3 (subtítulos incrustados en MP4).
