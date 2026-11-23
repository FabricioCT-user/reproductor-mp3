### Mediciones Electron (TE.0, 2026-11-23)

**Electron 45.4.1** (Chromium 156.0.8078.100), `devDependencies` con versión exacta. Arch Linux, kernel 6.18 LTS, Hyprland (Wayland; Electron elige `--ozone-platform=wayland` solo), GPU Intel Raptor Lake (UHD). Código del pico en la rama `app/te0-pico` (`pico/main.js` ≈ 80 líneas: esquema, Range, ventana; `pico/medir.js` es el arnés; `pico/correr.sh` lanza las 4 corridas). La ventana nunca se mostró (`show: false`, `backgroundThrottling: false`); todo se midió desde el principal con `executeJavaScript` y el protocolo de DevTools.

Medios generados con ffmpeg: 7 clips de 8 s (640×360, seno de 440 Hz) y un MP4 H.264/AAC de **2,8 GB / 24 min** (720p, `+faststart`).

| # | Punto | Resultado | Cifra |
|---|---|---|---|
| 1 | Carga por `app://reproductor/index.html` con la CSP actual | **OK** | 0 mensajes en consola (ni avisos ni violaciones CSP), 29 botones, origen `app://reproductor`. El service worker no se registra (la app ya lo condiciona a `http*`). |
| 2 | Persistencia `localStorage` + IndexedDB entre reinicios | **OK** | Marca escrita en la corrida A y leída igual en la B (otro proceso, mismo `userData`). La app creó su `reproductor-mp3 v2` en el primer arranque. |
| 3 | MP4 de 2,8 GB por `__media/<id>` con Range | **OK** | `canplay` en 19–24 ms; saltos (a 10 %, 50 %, 90 %, 99 %…) en **4–40 ms** (`seeked`), reproduce justo después; 0 cuadros perdidos. Memoria total de la app (todos los procesos, `getAppMetrics`): ~900 MB tras un clip de 1,9 MB → **~1000 MB** con el de 2,8 GB y **estable** (998 → 997 MB) tras 10 saltos más. Principal: RSS 290 → 350 MB como máximo. No crece con el tamaño del archivo. |
| 4 | `createMediaElementSource` sobre ese `<video>` da sonido y el EQ actúa | **OK** | `AnalyserNode` (antes de una ganancia 0, así que no sonó nada): **RMS 0,088** (el seno de ffmpeg tiene amplitud 1/8: esperado 0,125/√2 = 0,088); con un `peaking` de 440 Hz a **+12 dB → 0,352** (×4,0) y a **−12 dB → 0,022** (×0,25). Idéntico en el grande y en el pequeño, en los dos modos de Range. No se pudo comprobar de oído. |
| 5 | Códecs (canPlayType + reproducción real) | **OK** con matices | Ver tabla de códecs abajo. |
| 6 | `webUtils.getPathForFile` desde el preload con `sandbox: true` | **OK** | `<input type=file>` (archivos puestos con `DOM.setFileInputFiles`) y soltar (`Input.dispatchDragEvent` con `files`): las dos devuelven la ruta absoluta exacta. Un `File` sintético devuelve `""`. **No probado**: diálogo nativo real ni arrastrar desde el gestor de archivos (simulados por DevTools, que crea el mismo tipo de `File`). |
| 7 | Arranque con `sandbox` | **OK** | Sin `--no-sandbox`. Renderer: `process.sandboxed = true`, **Seccomp 2** (filtro), `NoNewPrivs 1`, espacios de nombres *user*, *pid* y *net* propios. `chrome-sandbox` no es SUID (npm lo instala 0755): el sandbox usa espacios de nombres de usuario sin privilegios (Arch los permite, `max_user_namespaces` 62532). |

**Ubuntu ≥ 23.10 (no comprobado aquí):** AppArmor restringe por defecto los espacios de nombres de usuario sin privilegios (`kernel.apparmor_restrict_unprivileged_userns=1`), justo lo que usa el sandbox aquí. Un `.deb` debe instalar `chrome-sandbox` como SUID root (4755) o un perfil AppArmor para el binario; el AppImage no puede hacer ninguna de las dos cosas y fallaría al arrancar salvo con `--no-sandbox` (no aceptable). → TE.3: empaquetar `.deb` con perfil AppArmor/SUID; AppImage solo con esa advertencia o no ofrecerlo.

**Wayland:** sin problemas en Hyprland. Una línea en stderr del proceso GPU (`'--ozone-platform=wayland' is not compatible with Vulkan`) es inocua: Vulkan está desactivado y la decodificación de video sigue `enabled`.

#### Implementación de Range elegida: propia (`fs.createReadStream` + `206`)

| | `net.fetch(pathToFileURL(…))` | Propia (`fs.createReadStream`) |
|---|---|---|
| ¿Reenvía Range? | Sí, pero **mal**: pidiendo `bytes=1000-1999` devuelve los 1000 bytes correctos con **`200`**, sin `Content-Range`, `Content-Length` ni `Accept-Ranges`. | `206` + `Content-Range` + `Content-Length` + `Accept-Ranges`; `416` con `bytes */tam`. |
| Video de 2,8 GB | Funciona hoy (Chromium tolera la respuesta) y los saltos son algo más rápidos (2–7 ms) | Funciona; saltos 4–40 ms |
| Memoria del principal | RSS máx. ~300 MB (los bytes no pasan por JS) | RSS máx. ~350 MB |
| Bytes leídos del disco | — | 200 MB por 6 peticiones, 446 MB por 11: cada petición lee ~40 MB por adelantado antes de que el renderer la cancele |

Elegida la **propia** porque: cumple HTTP (el `200` sin `Content-Range` de `net.fetch` es un comportamiento no documentado que puede cambiar entre versiones de Electron y que la app no controla), permite `416`, tipo MIME por extensión y comprobar el id antes de tocar el disco, y se prueba con `node:test` (`rango.js`). Lo que hay que mejorar en T2.1: la lectura anticipada (~40 MB por petición) viene de `Readable.toWeb`; usar un `ReadableStream` con `pull()` que lea trozos de 256 KB–1 MB con `FileHandle.read` (contrapresión real) y cierre el descriptor en `cancel()`. Comprobar en la prueba de humo que no quedan descriptores abiertos tras muchos saltos.

#### Códecs (Electron 45.4.1 en este equipo)

| Archivo | `canPlayType` | Imagen | Sonido (RMS) |
|---|---|---|---|
| MP4 H.264 + AAC | probably | sí, 0 perdidos | sí (0,088) |
| MP4 HEVC (`hvc1`) + AAC | probably (`hvc1` y `hev1`) | **sí** | sí |
| MP4 AV1 + AAC | probably | sí | sí |
| WebM VP9 + Opus | probably | sí | sí |
| MKV H.264 + AAC | probably (`video/x-matroska` a secas: maybe) | sí | sí |
| MP4 H.264 + **AC-3** | `ac-3`: vacío | sí | **no** (RMS 0, 0 bytes de audio decodificados, **sin error**) |
| MP4 H.264 + **E-AC-3** | `ec-3`: vacío | sí | **no** (igual) |
| MOV (`video/quicktime`) | vacío | no probado | — |
| FLAC, Ogg Opus | probably | — | — |

- HEVC funcionó aquí, probablemente por VA-API en la Intel: **no garantizado** en otro equipo (sin hardware compatible no decodifica). T3.1 debe comprobar `canPlayType` y además detectar «0 cuadros decodificados».
- AC-3/E-AC-3: el video carga y reproduce **mudo sin ningún error**. T3.1 tiene que detectarlo antes (pista `ac-3`/`ec-3` en el `stsd` vía `mp4.js`) o después (`webkitAudioDecodedByteCount === 0` tras ~1 s de reproducción con pista de audio) y avisar «el video se verá sin sonido».

#### Recomendación: **seguir con Electron**

Los 7 puntos pasan, incluido el riesgo n.º 1 (Web Audio con video del mismo origen). Cambios para las tareas siguientes:

- **TE.1:** Electron **45.4.1** exacto. El paquete `electron` descarga el binario (274 MB descomprimido) en el primer `electron .`, no en `npm install`, así que `npm ci` en CI sigue siendo ligero. Escuchar `console-message` con el objeto evento (los argumentos sueltos están obsoletos en 45). El pico usó `autoplayPolicy: "no-user-gesture-required"` (el `AudioContext` nace `running` sin clic): ponerlo en TE.1 para «Abrir con…» y mantener igualmente la comprobación de `play()`. El esquema con `standard, secure, supportFetchAPI, stream` basta; la CSP del meta se aplica tal cual (añadir la cabecera es defensa en profundidad, no necesidad).
- **T2.1:** Range **propio** (no `net.fetch`), con el `ReadableStream`/`FileHandle` de arriba; `Content-Type` por extensión (Chromium aceptó `video/x-matroska`). Web Audio funciona tal como está en `player.js` (`createMediaElementSource`), sin `crossorigin`. `webUtils.getPathForFile` en el preload con `sandbox: true` es suficiente para `enlazar(files)`.
- **TE.3:** sandbox en Ubuntu ≥ 23.10 (ver arriba): `.deb` con SUID o perfil AppArmor; probar en una VM de Ubuntu antes de publicar.
- **T3.1 / §5:** actualizar la tabla de formatos con lo de arriba (MKV y HEVC sí aquí; AC-3/E-AC-3 mudos sin error).
