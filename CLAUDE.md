# Tarareo — guía para Claude

Tarareo es un reproductor de música local que corre en el navegador. **JavaScript clásico, sin dependencias de ejecución ni paso de build.** Electron y electron-builder son dependencias de desarrollo, con versión exacta (sin `^`), solo para la app de escritorio: la interfaz no las necesita y `npm test` tampoco. Repo público: https://github.com/FabricioCT-user/tarareo. La persona que lo mantiene habla español: interfaz, comentarios, mensajes de commit y README van **en español**.

## Comandos

```bash
npm start          # app de escritorio (Electron), igual que npm run app
npm run app        # app de escritorio (Electron 45.4.1 exacto, devDependency)
npm run dist       # empaqueta en dist/: .pacman, .AppImage y .deb (electron-builder; la configuración está en la clave build de package.json)
npm run web        # servidor estático (python3 -m http.server) en http://127.0.0.1:8000
npm test           # 222 pruebas unitarias (node:test, tests/unit/*.test.js); NO debe requerir Electron
npm run smoke:app  # pruebas de humo dentro de Electron, sin ventana y con --user-data-dir temporal; sale 0/1 (necesita ffmpeg)
```

- Pruebas de humo en navegador: `npm run web` y abre `http://127.0.0.1:8000/tests/smoke.html`; `window.__results` / `window.__done` tienen el resultado.
- **Usa `/usr/bin/node` y `/usr/bin/npm`**: en el shell de la persona `node` es una función rota de nvm.
- CI: GitHub Actions ejecuta `npm test` en cada push (`.github/workflows/test.yml`).

## Estructura

```
index.html  style.css  sw.js  manifest.webmanifest  icon*.{svg,png}  package.json
src/              módulos sin DOM: util, lyrics, playlist-io, id3, mp4, mkv, tags, tag-writer, storage, subtitles
src/app/          la aplicación: core, library, playlists, lyrics-ui, player, eq, fades, editor, theme, fullscreen, pip, subtitles-ui, main
tests/unit/       node:test; helpers.js construye MP3/FLAC/Ogg/MP4 sintéticos
tests/smoke.*     pruebas de humo en el navegador (smoke-app.js: las mismas en Electron)
electron/         app de escritorio: main.js, preload.js y lib/ (argumentos, enlaces, entregas, escritorio, medios, rango, rutas, servir). Nada de lib/ hace require("electron"); se prueban con node:test
docs/PLAN-MP4.md  plan de video y de la app de escritorio (estado al día)
```

**App Electron:** protocolo `app://reproductor/` con lista blanca = `FILES` de `sw.js` + `index.html` y la CSP del meta repetida como cabecera; ventana endurecida (contextIsolation, sandbox, sin nodeIntegration, sin ventanas nuevas ni navegación fuera de la app, permisos negados salvo `fullscreen`). Todo manejador IPC comprueba `deLaApp(event)` (una prueba lo vigila). El preload solo expone `window.reproductor` con `contextBridge` (`esApp`, `version`, `onAbrir`, `elegirArchivos`, `leer`, `enlazar`, `olvidar`, `estadoEnlaces`). `electron/lib` no puede hacer `require("electron")`. Archivos del sistema (argv, `second-instance`, diálogo): `lib/rutas.js` valida (archivo regular, `realpath`, extensión del destino) y `lib/entregas.js` da ids de un solo uso; **la interfaz nunca recibe rutas**, pide los bytes por id. **Videos (T2.1):** no se leen ni se copian; `reproductor.enlazar(idEntrega | File)` (el preload saca la ruta de un File con `webUtils.getPathForFile`) los registra en `lib/enlaces.js` (`userData/enlaces.json`, 0600, escritura atómica, ids de 32 hex) y la interfaz usa `LinkedFile` (library.js), cuyo `url` es `__media/<linkId>` y cuyo `slice().arrayBuffer()` pide `Range`. `__media` lo sirve `lib/medios.js` (`ReadableStream` con `pull()` + `FileHandle.read`, cierra en `cancel()`; `lib/rango.js` analiza la cabecera). `olvidar(id)` al quitar la pista. `wireSystemOpen()` (library.js) junta launchQueue y la app.

**Regla de `src/app/`:** los archivos solo *declaran* (funciones y constantes). Todo el cableado de eventos, intervalos y estado inicial va dentro de funciones `wire…()` (una por archivo) que `main.js` llama al final. No pongas `addEventListener` ni `setInterval` sueltos a nivel superior. Todo es global (scripts clásicos, no módulos ES), así que los nombres no pueden repetirse entre archivos.

Al **añadir o mover un archivo**: ponlo en `index.html` (el orden importa: `util`, `lyrics`, `id3` antes que `tags`, `tags` antes que `tag-writer`, `main.js` el último) y en `FILES` de `sw.js`. Una prueba de coherencia lo comprueba.

## Convenciones y límites

- **CSP estricta** (meta en `index.html`): sin `unsafe-inline` ni `unsafe-eval`. Nada de `innerHTML` con datos de archivos (usa `textContent`), ni `style="…"` ni `onclick="…"` en el HTML, ni `eval`. Si cambias el script en línea del tema, actualiza su hash en la CSP (hay una prueba que lo vigila).
- Los datos del usuario nunca salen del equipo: no añadas peticiones de red ni librerías externas.
- Acceso a `localStorage` solo mediante `store` (core.js): puede estar bloqueado o tener datos corruptos.
- **Datos guardados:** IndexedDB `reproductor-mp3` **v2** (el nombre no cambia: hay datos guardados), dos almacenes con la misma clave:
  - `tracks` (solo metadatos, nunca el archivo): `{ id, name, type, size, lastModified, kind, source, linkId?, lyrics?, edits?, meta?, subs?, thumb? }`. `kind`: `"audio"|"video"`. `source`: `"blob"` (archivo en `files`) | `"link"` (enlazado por la app de escritorio vía `linkId`, id opaco; **la ruta nunca se guarda en IndexedDB**) | `"session"` (no persistente; el arranque lo descarta).
  - `files`: `{ id, blob }`, solo para `source: "blob"`. Se lee perezoso con `Storage.getFile(id)`; `Storage.all()` devuelve solo metadatos y `setField` (letras, ediciones) no toca `files`.
  - Migración v1 → v2 (v1 guardaba `blob` dentro de `tracks`) en `onupgradeneeded`, en la propia transacción: o se migra todo o nada. Si falla (p. ej. sin espacio) la base se abre en v1 y `Storage` la usa en ese formato; se reintenta al siguiente arranque. Registros sin blob válido se dejan como están (el arranque los descarta, salvo `source: "link"`). Pruebas: `tests/unit/storage.test.js` (IndexedDB falsa en `fake-idb.js`) y escenarios «Migración» de la prueba de humo.
  - `localStorage`: `shuffle repeat speed crossfade playlists eq order lastId volume lyrics theme mediaFilter`.
  - En la app de escritorio, IndexedDB, localStorage y `enlaces.json` (permisos 0600) están en la carpeta de datos de Electron: en Linux, `$XDG_CONFIG_HOME/reproductor-mp3` o `~/.config/reproductor-mp3`. Se mantiene el nombre anterior para conservar los datos de las versiones 1.0.0; `--user-data-dir=<ruta absoluta>` prevalece sobre esa ruta.
  - Un cambio de esquema exige subir la versión y migrar en `onupgradeneeded`, con pruebas de migración; no rompas los datos existentes.
- Las ediciones de etiquetas **no modifican el original**: viven en `edits`. Solo «descargar copia» (MP3 y FLAC) escribe etiquetas, siempre en un archivo nuevo, y se verifica releyéndolo.
- Para reproducir sin clic previo (Abrir con…), `play()` comprueba que el contexto de audio esté activo; no dejes que «suene» en silencio.

## Flujo de trabajo

Tras cada función importante: probarla (pruebas nuevas si procede), actualizar el README, **commit y push** con mensaje en español y el trailer `Co-Authored-By`. Verifica en el navegador integrado antes de dar algo por hecho, y di claramente lo que no se pudo comprobar (menús del sistema operativo, selectores de archivo nativos, Firefox/Safari). El navegador integrado no maneja la app de Electron: sus cambios se verifican con `npm run smoke:app` y, lo que esa prueba no cubra (paquetes, «Abrir con…», pantalla completa en X11), a mano, y se dice.

## Trampas conocidas del entorno

- ffmpeg y flac están instalados para generar audio de prueba, pero usa `timeout N ffmpeg … </dev/null` (encadenados se cuelgan). ffmpeg guarda la letra de MP3 como `TXXX`, no `USLT`.
- No uses `pkill -f <patrón>` si el patrón aparece en tu propio comando (se mata a sí mismo, exit 144); localiza el pid con `ss -ltnp 'sport = :PUERTO'`.
- Navegador integrado: la pestaña debe estar al frente (`tabs_select`) o se ralentizan temporizadores y audio; `javascript_tool` caduca a los 45 s (sondea en llamadas cortas); `alert/confirm/prompt` están suprimidos (usa stubs); las capturas van un paso por detrás.
- La prueba de humo carga la página **sin** la CSP (vía `srcdoc` + `<base href="../">`) porque necesita `eval`; la CSP real se comprueba aparte.
- `indexedDB.deleteDatabase` se bloquea si otra pestaña tiene la base abierta: en pruebas se vacía el almacén.
- El service worker revalida siempre con la red; si cambias la lista de archivos sube `VERSION` en `sw.js`.
- Electron: `--smoke` (`npm run smoke:app`) exige `--user-data-dir` con una carpeta temporal (lo comprueba `electron/main.js`). Nunca pruebes con los datos reales de la persona: no uses `npm run app` con su perfil para probar.
- Electron: nunca `--no-sandbox` para que arranque algo. La app se niega a arrancar con esa opción, y hay una prueba que lo vigila.
- Electron: la ventana se crea con `show: false`, y `backgroundThrottling` solo se desactiva en `--smoke` (`electron/main.js`).

## Pendiente (hoja de ruta del README)

- Copias con etiquetas también para Ogg, Opus y M4A.
- Opcionales sin hacer (docs/PLAN-MP4.md): T0.8 (escritor de copias M4A), T3.2 (metadatos WebM/MKV) y T4.3 (subtítulos incrustados en MP4).
