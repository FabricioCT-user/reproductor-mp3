# Nota (2026-11-24): la app y el paquete npm pasan a llamarse «Tarareo» (`tarareo`, v1.1.0). Se conserva la carpeta de datos `reproductor-mp3`, el origen `app://reproductor`, IndexedDB y demás identificadores persistidos para mantener compatibilidad con datos existentes. El repositorio se renombra centralmente al fusionar.

# Plan: reproducción de video MP4 + app de escritorio (Electron)

> Estado (2026-11-24): **implementado**. Hechas la Fase E (TE.0–TE.5) y las tareas no obsoletas de las Fases 0 a 2, 3.1, 4.1, 4.2, 5 y 6 (las tachadas quedaron obsoletas o fuera de alcance). Sin hacer solo las opcionales: T0.8, T3.2 y T4.3. Escrito originalmente tras leer `CLAUDE.md`, `README.md`, `src/`, `src/app/`, `launcher/`, `sw.js`, `index.html` y las pruebas.
> **Revisión 2 (2026-11-23):** la persona decidió convertir el reproductor en **app de escritorio con Electron**. Se añade la **Fase E** (migración), se rehace la **Fase 2** (videos enlazados por ruta, no copiados), el lanzador Python se sustituye por la asociación de archivos de la app, y lo que deja de aplicar queda marcado **~~tachado~~ (obsoleto)** con el motivo, para que se vea qué cambió.
> Cada tarea = **una rama y un PR** (`video/<id>-<nombre>` o `app/<id>-<nombre>` para la Fase E), con pruebas, README al día y commit en español con el trailer `Co-Authored-By`.

**Leyenda de modelos**

| Etiqueta | Para qué |
|---|---|
| **Opus** | delicado: grafo de Web Audio, esquema/migración de IndexedDB, proceso principal de Electron, IPC/preload, protocolos, seguridad |
| **Sonnet** | el grueso: funciones nuevas con lógica y pruebas |
| **Haiku / Codex gpt-6-luna** | mecánico: renombrados, textos, listas de tipos, atajos, README |
| **Revisión: Gemini o Codex** | cada PR lo revisa un modelo distinto del que lo escribió; los de Opus, ambos si es posible |

---

## 0. Diagnóstico: lo que el código actual condiciona

Cosas concretas encontradas al leer el código que deciden el diseño:

1. **Los decks son `<audio>` y están cableados a Web Audio** (`core.js`: `decks = [$("audio"), $("audio-b")]`; `player.js/startAnalyser`: `createMediaElementSource(d)` una sola vez por elemento). `createMediaElementSource` **no se puede repetir** sobre otro elemento ni deshacer, así que no se puede «cambiar a un `<video>`» al vuelo: hay que hacer que los **dos decks sean `<video>` desde el principio**. Un `<video>` reproduce audio igual que un `<audio>`, así que el ecualizador, el visualizador, los fundidos y `ensureSound` siguen intactos.
2. **Un elemento multimedia que se saca del DOM se pausa** (lo dice la especificación). No se puede mover el deck activo a otro contenedor para «mostrarlo»: los dos decks viven fijos en un escenario de video y solo se muestra/oculta el activo con CSS.
3. **`Storage.setField` (letras, ediciones) hace `get` + `put` del registro entero, incluido el `blob`.** Con un MP3 de 8 MB da igual; con un video copiado de 2 GB (versión web), según el navegador, puede **reescribir/duplicar el archivo en disco** cada vez que se guarda una letra o una edición. Además, en Electron los videos **no tendrán blob** (se enlazan por ruta) y hoy el arranque descarta los registros sin blob. Ambas cosas exigen el esquema v2 (T0.3).
4. **En cada arranque se vuelven a leer las etiquetas de todas las pistas** (`main.js/init` → `makeTrack` → `Tags.read`). Con videos (moov de varios MB, miniaturas) el arranque se haría lento: conviene **guardar los metadatos ya analizados** en el registro.
5. **`Storage.add` falla en silencio**: si se acaba la cuota, la pista queda «solo en memoria» y la persona no se entera. Sigue importando en la versión web y para el audio.
6. **`Tags.readMp4` ya sabe recorrer átomos** (cabeceras de 64 bits a nivel superior, `moov` al final), pero el recorrido interno (`boxes`) no admite tamaños de 64 bits y lee el `moov` entero en memoria (máx. 64 MB). Es una buena base para un módulo `src/mp4.js` compartido.
7. ~~**El lanzador lee el archivo entero en memoria** (`launcher.js`: `await r.blob()`)…~~ **Obsoleto:** el lanzador Python se retira (TE.4). En Electron, «Abrir con…» llega al proceso principal como ruta y el video se lee por streaming desde el disco.
8. **La CSP ya permite lo necesario**: `media-src 'self' blob:` (vale también para `<track>`), `img-src blob: data:` (miniaturas). **En Electron sigue sin tocarse** siempre que los videos se sirvan desde el **mismo origen** que la app (`app://reproductor/__media/<id>`, ver TE.1/T2.1). Es además lo que evita que Web Audio reciba silencio (un medio de otro origen sin CORS llega mudo a `createMediaElementSource`).
9. Hay ~80 referencias a la variable global `audio` repartidas en `src/app/*` y `tests/smoke.js`.
10. **(Nuevo)** `package.json` no tiene dependencias y la CI solo ejecuta `npm test` **sin `npm install`**: añadir `electron` y `electron-builder` como `devDependencies` no rompe la CI mientras las pruebas unitarias no los requieran.
11. **(Nuevo)** `main.js:70` cablea `launchQueue` a nivel superior (contra la regla de `wire…()`); al tocar «Abrir con…» en TE.2 se mueve dentro de un `wire…()`.

---

## 1. Decisiones de diseño (propuesta)

| Tema | Propuesta | Alternativa descartada y por qué |
|---|---|---|
| Plataforma | **App de escritorio Electron** (Linux primero). La interfaz es la misma web (`index.html` + `src/`), cargada por un protocolo propio `app://reproductor/`. La versión web sigue funcionando mientras sea barato (detección con `window.reproductor`) | Tauri: en Linux usa WebKitGTK (H.264/AAC dependen de GStreamer del sistema, Web Audio con `<video>` menos fiable); `file://`: sin origen estable para IndexedDB, CSP `'self'` ambigua |
| Elementos | Los dos decks pasan a ser `<video playsinline preload="metadata">` dentro de un `#stage`; la variable `audio` pasa a llamarse `media` | Un `<video>` aparte para video: duplicaría el grafo de Web Audio y rompería EQ/fundido |
| Tipo de pista | Campo `kind: "audio" \| "video"` decidido por **contenido** (pista `hdlr` = `vide` en MP4, `videoWidth > 0` tras cargar), no por extensión | Por extensión: un `.mp4` solo de audio se mostraría como video negro |
| Fundido | Solo **audio → audio**. Si alguna de las dos pistas es video, corte limpio (decidido) | Fundido visual: fuera por ahora |
| Temporizador | Igual que ahora (fundido de volumen + pausa); «al terminar la canción» pasa a «al terminar la pista» | — |
| Ecualizador / visualizador | El EQ se aplica igual. El visualizador se oculta mientras se ve un video | — |
| Letras | Siguen siendo de audio. En video el botón «Letra» se convierte en «Subtítulos» | Mezclar LRC y SRT en el mismo panel |
| Almacenamiento (Electron) | **Videos: enlazados por ruta**, nunca copiados. El proceso principal guarda `id → ruta` en `userData`; la interfaz solo conoce el `id` y reproduce desde `app://reproductor/__media/<id>` con peticiones `Range` (salto instantáneo, sin cargar el archivo en memoria). **Audio: se sigue copiando a IndexedDB** como hoy (decisión pendiente §10) | ~~File System Access~~ (lo sustituye la ruta real, sin diálogos de permiso); copiar videos a IndexedDB |
| Almacenamiento (web) | Copiar a IndexedDB hasta **2 GB**; por encima, «solo esta sesión». Sin File System Access | Mantener FSA: coste alto para una versión que pasa a ser secundaria |
| «Abrir con…» | Asociación de archivos de la app instalada (`.desktop` con `MimeType`) + instancia única: los archivos llegan por `argv` / `second-instance` al proceso principal | ~~Lanzador Python + cola + servidor local~~ (se retira en TE.4) |
| Formatos no soportados | Detectar y explicar; **no transcodificar** (ni ffmpeg.wasm ni ffmpeg del sistema) | — |
| Seguridad Electron | `contextIsolation`, `sandbox`, sin `nodeIntegration`, preload mínimo con API cerrada, CSP intacta, navegación y ventanas nuevas bloqueadas, permisos denegados salvo pantalla completa, *fuses* endurecidos, **ninguna petición de red** (sin auto-actualización) | — |

---

## 2. Mejoras del lado audio que conviene hacer ANTES (Fase 0)

Todas sirven ya a la música y quitan riesgo al trabajo de video. Ninguna depende de Electron: pueden ir en paralelo con la Fase E.

### ~~T0.1 — Medir cómo se comportan los blobs grandes en IndexedDB~~ · **Obsoleta**
- Motivo: en Electron los videos no se copian, y en la web el tope es 2 GB (decidido). El esquema v2 (T0.3) es necesario igualmente (punto 3 del §0), así que la medición ya no decide nada. Lo que sí hay que medir pasa al pico TE.0.

### T0.2 — Avisar cuando no se puede guardar · **Sonnet**
- `addFiles`: si `Storage.add` falla, contarlo y avisar («N pistas solo para esta sesión: no hay espacio»), distinguiendo `QuotaExceededError`. Sigue haciendo falta para el audio y para la versión web.
- Prueba de humo: `Storage.add` sustituido por uno que lanza `QuotaExceededError` → aviso visible y la pista se reproduce igualmente.
- Revisión: Codex.

### T0.3 — Esquema v2: metadatos separados de los archivos · **Opus**
- IndexedDB `reproductor-mp3` **v2** (el nombre de la base **no cambia** aunque la app se llame «Reproductor»: hay datos guardados):
  - `tracks` (sin blob): `{ id, name, type, size, lastModified, kind, source: "blob"|"link"|"session", linkId?, lyrics?, edits?, meta?, subs?, thumb? }`
  - `files` (nuevo): `{ id, blob }` — misma clave que `tracks`; solo para `source: "blob"`.
  - ~~`source: "handle"`, `handle?`~~ (File System Access, obsoleto) → `source: "link"` + `linkId` (id opaco del registro de enlaces de Electron, T2.1). **La ruta nunca se guarda en IndexedDB.**
- Migración en `onupgradeneeded` (v1 → v2) con cursor sobre `tracks`: mueve cada `blob` a `files` y lo quita del registro, dentro de la transacción de actualización. Si el registro no tiene blob válido, se deja como está.
- `Storage` mantiene su interfaz (`add`, `remove`, `clear`, `all`, `setLyrics`, `setEdits`): `all()` devuelve los metadatos y un `getFile(id)` perezoso. Para `source: "link"` el arranque **no descarta** el registro.
- `setField` ya no toca blobs.
- Pruebas: la migración se prueba en la **prueba de humo**: base v1 con 2 pistas (una con letra y ediciones) → abrir la app → todo sigue (reproducción, letra, edición, orden). Escenario extra: base v1 con un registro corrupto. Debe pasar **en el navegador y en Electron** (TE.1 trae el ejecutor).
- Actualizar «Datos guardados» en `CLAUDE.md`.
- Revisión: Gemini **y** Codex.

### T0.4 — Guardar los metadatos analizados · **Sonnet** (tras T0.3)
- Al importar, guardar en `tracks.meta` `{ title, artist, album, lyrics, hasCover, duration, kind, width, height, codecs }` y `metaVersion`. En el arranque, si la versión coincide, no se vuelve a leer el archivo; la carátula se lee perezosa al pintarla. Importa más aún con videos enlazados (leer la cabecera de 50 videos del disco en cada arranque).
- Prueba: contar llamadas a `Tags.read` en el arranque de la prueba de humo (debe ser 0 tras la primera carga).
- Revisión: Codex.

### T0.5 — Extraer `src/mp4.js` (recorrido de átomos compartido) · **Sonnet**
- Mover de `tags.js` el recorrido de átomos a `src/mp4.js`, añadiendo: tamaños de 64 bits también en hijos, `size = 0`, y **lectura incremental** del `moov` (leer cabeceras de hijos y saltar `stbl`, `mdat`, etc.). Con videos enlazados, `File.slice` sobre la respuesta de `__media` (o un `Blob` perezoso) evita leer el archivo entero.
- `tags.js` usa `MP4` sin cambiar su salida: las pruebas actuales de M4A deben pasar sin tocarlas.
- Orden de carga: `mp4.js` antes de `tags.js` en `index.html` y en `FILES` de `sw.js` (sube `VERSION`).
- Revisión: Gemini.

### T0.6 — Renombrar `audio` → `media` · **Haiku / Codex gpt-6-luna**
- `audio` → `media`, `onAudio` → `onMedia`. En `src/app/*` y `tests/smoke.js`. Ningún cambio de comportamiento. PR aislado.
- Revisión: Codex (o Gemini si lo escribió Codex).

### T0.7 — Media Session completa · **Haiku**
- `seekto`, `seekbackward`, `seekforward`, `stop` y `setPositionState`. **Con Electron gana valor:** en Linux Chromium publica la Media Session por **MPRIS**, así que las teclas multimedia y el applet de sonido del escritorio controlarán la app.
- Revisión: Gemini.

### (Opcional) T0.8 — Escritor de copias M4A · **Opus**
- Sin cambios: no es requisito del video; dejarlo para después.

---

## 3. Migración a Electron (Fase E) — **nueva**

Objetivo: la misma interfaz, empaquetada como app de escritorio, que abre archivos del disco directamente y sustituye al lanzador Python. La lógica del proceso principal que se pueda probar sin Electron va en **módulos puros CommonJS** (`electron/lib/*.js`) con pruebas `node:test`, igual que hoy `src/` está separado de `src/app/`.

Estructura propuesta:

```
electron/
  main.js        proceso principal: ventana, protocolo app://, IPC, instancia única, argv
  preload.js     puente mínimo (contextBridge) → window.reproductor
  lib/
    rutas.js     validar rutas (absoluta, archivo regular, realpath, extensión de medio)
    rango.js     analizar cabeceras Range → {start, end} o 416
    argumentos.js  extraer archivos de argv (ignorar flags de Chromium/Electron)
    servir.js    resolver app://reproductor/<ruta> → archivo de la app (lista blanca, sin «..»)
    enlaces.js   registro id → {ruta, tamaño, fecha} en userData (JSON atómico)
electron-builder.yml
```

### TE.0 — Pico de viabilidad (rama desechable) · **Opus**
Antes de comprometer el resto, comprobar en una rama `app/te0-pico` (no se fusiona) con un `main.js` de 50 líneas:
1. La app carga por `app://reproductor/index.html` (esquema registrado con `standard`, `secure`, `supportFetchAPI`, `stream`) **con la CSP actual sin cambios** y sin errores en consola.
2. IndexedDB y `localStorage` **persisten** entre reinicios (origen estable).
3. Un MP4 H.264/AAC de 2–4 GB servido como `app://reproductor/__media/<id>` con `Range`: arranca al instante, el salto es inmediato y la memoria del proceso no crece con el tamaño del archivo. Probar `protocol.handle` + `net.fetch(pathToFileURL(…))` (¿reenvía `Range`?) frente a una implementación propia con `fs.createReadStream` y `206`.
4. **`createMediaElementSource` sobre ese `<video>` da sonido** (no silencio) y el EQ se oye. Es el riesgo n.º 1.
5. Códecs de la build de Electron: `canPlayType` y reproducción real de H.264, AAC, HEVC, AV1, VP9, AC-3/E-AC-3, MKV (H.264/AAC).
6. `webUtils.getPathForFile(file)` desde el preload con `sandbox: true` da la ruta en arrastrar-soltar y en `<input type=file>`.
7. Arranque con `sandbox` en la distro de la persona (y anotar Ubuntu ≥ 23.10 con AppArmor, ver riesgos).
- Resultado: sección «Mediciones Electron» en este plan con versión exacta de Electron probada. **Decisión de seguir o no.**
- Revisión: Gemini.

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

### TE.1 — Esqueleto de la app · **Opus** (tras TE.0)
- `package.json`: `"main": "electron/main.js"`, scripts `app` (`electron .`), `dist` (electron-builder), `web` (servidor estático, ver TE.4); `devDependencies` `electron` y `electron-builder` con **versión exacta** (sin `^`). `npm test` **no** debe requerirlas.
- Protocolo `app://reproductor/`: sirve **solo** los archivos de la app (lista blanca derivada de `FILES` de `sw.js` + `index.html`), rechaza `..`, rutas absolutas y cualquier otra cosa; añade la CSP también como **cabecera** (defensa en profundidad, idéntica a la del meta). `__media/<id>` se deja preparado para T2.1.
- Ventana endurecida: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`; `setWindowOpenHandler` → `deny`; `will-navigate` → bloquear todo lo que no sea `app://reproductor/`; `session.setPermissionRequestHandler` → negar todo salvo `fullscreen`; sin menú por defecto con DevTools en el paquete (sí con `npm run app`).
- Preload: `contextBridge.exposeInMainWorld("reproductor", { version, esApp: true })` (la API crece en TE.2 y T2.1). Cada manejador IPC en el principal **comprueba el origen del emisor** (`event.senderFrame.url` empieza por `app://reproductor/`).
- Interfaz: si existe `window.reproductor`, **no registrar el service worker** (no hace falta y complica el protocolo propio); el resto, igual.
- *Fuses* (`@electron/fuses` lo trae electron-builder): `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, `EnableEmbeddedAsarIntegrityValidation` on (verificar soporte en Linux).
- **Ejecutor de humo en Electron:** `npm run smoke:app` arranca Electron con `--user-data-dir` temporal y una bandera que carga `tests/smoke.html`; el principal recoge `window.__results` y sale con código 0/1. Así las pruebas de humo cubren navegador **y** app sin dependencias nuevas.
- Pruebas unitarias: `servir.js` (lista blanca, `..`, `%2e%2e`, mayúsculas, barra final), `argumentos.js`. `consistency.test.js`: lo que sirve el protocolo = `FILES` de `sw.js`; la CSP de la cabecera = la del meta.
- Revisión: Gemini **y** Codex (seguridad).

### TE.2 — Abrir archivos del sistema (sustituye al lanzador) · **Opus** (tras TE.1)
- `app.requestSingleInstanceLock()`; archivos de `process.argv` al arrancar y de `second-instance` con la app abierta (enfoca la ventana). Validación en `rutas.js`: existe, es archivo regular, extensión de audio/video (o `.lrc/.srt/.vtt` acompañantes), `realpath`.
- El principal entrega a la interfaz **ids**, no rutas: audio → se lee y se pasa como `File`/bytes para copiarlo a IndexedDB como hoy; video → se registra en `enlaces.js` (T2.1) y se pasa `{ linkId, name, size, lastModified, type }`.
- Preload: `reproductor.onAbrir(cb)` (evento) y `reproductor.elegirArchivos()` (`dialog.showOpenDialog`, multi-selección y carpetas).
- Interfaz: `openFromSystem` gana una tercera fuente junto a `launchQueue` (web) y la cola del lanzador (que desaparece en TE.4). Mover el `launchQueue` de `main.js:70` a un `wire…()`.
- Pruebas: unitarias de `argumentos.js`/`rutas.js` (enlaces simbólicos, directorios, extensiones falsas, rutas con espacios y `file://`); humo en Electron: lanzar con dos archivos en argv y comprobar que entran en la biblioteca y suena el primero (con `ensureSound`: que **no** suene mudo si el contexto de audio no está activo).
- Revisión: Gemini **y** Codex.

### TE.3 — Empaquetado y asociación de archivos · **Sonnet** (revisión de seguridad Opus) (tras TE.2)
- `electron-builder.yml`: `productName: Reproductor`, `appId` (propuesta: `io.github.fabricioct-user.reproductor`), `files` en lista blanca (excluye `tests/`, `launcher/`, `PLAN-*.md`, `.github/`), `asar: true`, iconos existentes.
- Destinos Linux: **AppImage, deb y pacman**. `linux.mimeTypes` + `fileAssociations` para audio (`audio/mpeg`, `audio/flac`, `audio/ogg`, `audio/mp4`, `audio/x-wav`…) y video (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`, `video/x-m4v`): genera el `.desktop` con `MimeType=` y `%F`.
- deb/pacman: tras instalar, «Abrir con… → Reproductor» en el gestor de archivos. AppImage: **no** registra asociaciones por sí sola; documentar (AppImageLauncher / Gear Lever) o un `--instalar-escritorio` opcional que escriba el `.desktop` en `~/.local/share/applications` (como hace hoy `instalar.sh`).
- Comprobar en el paquete: `chrome-sandbox` con SUID en deb/pacman, o *user namespaces* disponibles; **nunca** publicar con `--no-sandbox`.
- Sin auto-actualización ni telemetría (los datos no salen del equipo). Opcional: workflow de GitHub que construya los paquetes al etiquetar una versión (decisión §10).
- Pruebas: unitaria que compara las extensiones de `fileAssociations`, `rutas.js` e `isMedia` de `util.js`. Manual (anotarlo en el PR): instalar deb y pacman, «Abrir con…» desde Nautilus/Dolphin, doble clic con la app abierta y cerrada, AppImage en la distro de la persona.
- Revisión: Codex; Opus revisa *fuses*/sandbox.

### TE.4 — Retirar el lanzador Python · **Sonnet** (tras TE.3 verificada a mano)
- Se borran `launcher/reproductor`, `launcher/instalar.sh`, la cola de `servidor.py`/`comun.py`, `src/app/launcher.js` (de `index.html` y `FILES`, sube `VERSION`), la regla de `sw.js` para `/__abrir/*` y `tests/unit/launcher.test.js` (sus defensas pasan a las pruebas de `electron/lib`).
- Para la versión web y las pruebas de humo en el navegador queda un **servidor estático mínimo**: `npm run web` → `python3 -m http.server --bind 127.0.0.1 8000` (o `servidor.py` reducido a estático si se quiere conservar la comprobación de `Host`; decisión menor, recomiendo el mínimo). `npm start` pasa a abrir la app (`electron .`).
- **No** borrar antes de que «Abrir con…» funcione con el paquete instalado: la persona usa el lanzador hoy.
- Añadir `launcher/__pycache__/` a `.gitignore` mientras exista la carpeta.
- Revisión: Gemini.

### TE.5 — Documentación y reglas · **Haiku** (con cada PR de la Fase E; repaso final al terminar TE.4) · **Hecha**
> Hecho (2026-11-24): README, `CLAUDE.md` y este plan contrastados con el código (222 pruebas en verde; tamaños y nombres de los paquetes, según `dist/`). Correcciones: la carpeta de datos es `~/.config/reproductor-mp3` (el paquete no tiene `productName`), no `~/.config/Reproductor`.
- README: instalación (paquetes, AppImage), «Abrir con…», versión web como alternativa, requisitos, tamaño.
- `CLAUDE.md`: comandos (`npm run app`, `npm run dist`, `npm run smoke:app`, `npm run web`), estructura con `electron/`, la regla «sin dependencias» matizada («ninguna en tiempo de ejecución de la interfaz; Electron y electron-builder solo como desarrollo»), reglas de seguridad de Electron (las de §1), «Datos guardados» (IndexedDB y localStorage en la carpeta de datos de Electron, `~/.config/reproductor-mp3`; registro de enlaces `enlaces.json`), y sustituir las trampas del lanzador (`REPRODUCTOR_NO_ABRIR`) por las de Electron (`--user-data-dir` temporal en pruebas; nunca abrir la app real de la persona con sus datos).
- Revisión: Codex.

---

## 3b. Núcleo de medios (Fase 1) — *restaurada: se perdió al reajustar el plan a Electron*

### T1.1 — Decks `<video>` y escenario · **Opus**
- `index.html`: los dos `<audio>` pasan a `<video id="deck-a"> <video id="deck-b">` con `playsinline preload="metadata"`, dentro de `<div id="stage">`, apilados en la zona de la carátula; ocultos (`hidden` vía clase, **no** sacados del DOM) mientras la pista es de audio.
- Nada más cambia: el grafo de `startAnalyser` es el mismo. Verificar que `ensureSound` sigue pausando en vez de «sonar mudo».
- Aceptación: **toda** la prueba de humo actual pasa sin cambios de expectativas, en el navegador **y** con `npm run smoke:app`; manual: EQ audible, fundido, temporizador, letras.
- Revisión: Gemini y Codex.

### T1.2 — Tipo de pista y detección · **Sonnet** (tras T0.5)
- `util.js`: `isVideo(f)` (`video/*`, `.mp4 .m4v .webm .mov .mkv`), `isMedia = isAudio || isVideo`. Ojo: `.mp4`/`.webm` pueden ser solo audio.
- `mp4.js`: lista de pistas (`trak/mdia/hdlr`) → `kind`. WebM/MKV: se decide al cargar (`videoWidth > 0`).
- `addFiles`, `openFromSystem`, `accept` de los `<input>`: aceptan video.
- Pruebas unitarias: `isVideo`, MP4 sintético solo audio → `audio`, con `vide` → `video`.
- Revisión: Codex.

### T1.3 — Reproducir video en el escenario · **Sonnet** (tras T1.1, T1.2)
- `loadTrack`: según `kind`, muestra el escenario (deck activo visible) o la carátula. Al cambiar de deck en un fundido, la visibilidad sigue al deck activo.
- `hasNext/crossfadeCheck` (`fades.js`): sin fundido si la pista actual o la siguiente es video.
- Visualizador oculto y bucle `draw()` parado mientras el activo es video.
- Botón de letra → subtítulos en video (el cableado real llega en T4.2).
- Smoke: importar un video generado (ver §8), comprobar `videoWidth > 0`, que el EQ sigue conectado, alternar audio → video → audio, y que no se intenta fundido.
- Revisión: Gemini.

---

## 4. Archivos de video: enlazar, no copiar (Fase 2) — **rehecha**

~~Contexto de cuotas (Chromium ~60 %, Firefox «best effort», Safari 7 días)~~ — **obsoleto en la app**: Electron guarda los datos en `~/.config/reproductor-mp3` sin desalojo, y los videos ni siquiera ocupan espacio ahí. Solo afecta a la versión web (T2.3).

### ~~T2.1 — Persistencia y uso de espacio (`persist()`, `estimate()`)~~ · **Obsoleta** → lo poco que sigue aplicando (web) pasa a T2.3.
### ~~T2.2 — Enlazar sin copiar (File System Access, solo Chromium)~~ · **Obsoleta** → sustituida por T2.1 nueva (rutas reales vía Electron, sin diálogos de permiso).
### ~~T2.3 — Lanzador con video (`comun.py`, `instalar.sh`, `file_handlers`)~~ · **Obsoleta** → sustituida por TE.2/TE.3 (asociación de la app). En la web solo se añaden `file_handlers` de video al manifest (T2.3 nueva).

### T2.1 — Videos enlazados por ruta · **Opus** (tras TE.2, T0.3, T1.2) · **Hecha**
> Hecho: `enlaces.js`, `rango.js`, `medios.js` (en vez de `fs.createReadStream`: `ReadableStream` con `pull()` y trozos de 512 KB; la prueba de humo mide 1–2,6 MB leídos por petición cancelada en lugar de ~40 MB). `enlazar` acepta el id de una entrega (lo que llega por argv/diálogo: solo se enlaza si de verdad entra en la biblioteca) o un `File` con ruta. Varios rangos → se sirve el primero satisfacible; mal formados → 416; unidad desconocida → 200. Vaciar la biblioteca olvida cada enlace (sin API aparte). `estadoEnlaces` ya existe para T2.2. `rutas.js` pasa a `Math.floor` en la fecha (igual que `File.lastModified` de Chromium: un video arrastrado y el mismo abierto por diálogo dan la misma clave).
- `electron/lib/enlaces.js`: registro `id → { ruta, tamaño, fecha }` en `userData/enlaces.json` (escritura atómica: temporal + `rename`; permisos 0600). `id` = 32 hex aleatorios (mismo patrón que la cola actual). Solo se registran rutas que llegaron por **acción de la persona**: arrastrar, `<input>`, diálogo, «Abrir con…».
- Preload: `reproductor.enlazar(files)` → usa `webUtils.getPathForFile` y devuelve `linkId`s; `reproductor.estadoEnlaces(ids)` → `{ ok | falta | cambiado }`; `reproductor.olvidar(id)`. La interfaz **nunca** ve ni guarda rutas.
- Protocolo: `app://reproductor/__media/<id>` sirve solo ids registrados, con `Range` (`rango.js`: `bytes=a-b`, `a-`, `-n`, inválidos → `416`; un solo rango), `Content-Type` por extensión, `Accept-Ranges`. Lectura con `fs.createReadStream` (sin cargar en memoria). La CSP no cambia (`media-src 'self'`) y Web Audio recibe sonido (mismo origen).
- Interfaz: en `addFiles`, si `window.reproductor` y la pista es video → `source: "link"`, sin copiar; si es audio → copiar como hoy (o enlazar, según decisión §10). `loadTrack` usa la URL `__media` en vez de `URL.createObjectURL`. Las etiquetas/miniaturas se leen con `fetch` + `Range` sobre la misma URL (T0.5 incremental).
- Al borrar la pista de la biblioteca → `olvidar(id)`. «Vaciar biblioteca» → vaciar el registro.
- Pruebas: unitarias de `rango.js` y `enlaces.js` (JSON corrupto → registro vacío sin romper el arranque, escritura atómica); humo en Electron: enlazar un video generado, salto a mitad, EQ conectado, reinicio → sigue disponible; petición a `__media/<id-falso>` y a `__media/../index.html` → 404.
- Revisión: Gemini **y** Codex.

### T2.2 — Archivos que faltan o cambiaron · **Sonnet** (tras T2.1) · **Hecha**
> Hecho: `init` (main.js) llama a `comprobarEstadoEnlaces()` al terminar de cargar la biblioteca, sin esperarla (un disco lento no retrasa el arranque ni «Abrir con…»); también se comprueba al pulsar una fila o al abrirla desde el sistema. `enlaces.json` guarda además la identidad del archivo (dev/ino/tamaño/fecha exacta): un archivo sustituido con el mismo tamaño y fecha da «cambiado» y `__media` no lo sirve. «Buscar…» abre el diálogo en modo `{ video: true }` (un solo video), enlaza el elegido, relee sus metadatos y sustituye la pista por otra con el mismo id (`Storage.updateLink`); el enlace viejo se olvida. Una respuesta de estado solo se aplica si la pista sigue en la biblioteca con el mismo `linkId`, así que una comprobación en curso nunca invalida el enlace recién hecho (sin esperas ni marcas de tiempo).
- Al arrancar (y al reproducir): `estadoEnlaces` → si falta o cambió tamaño/fecha, la fila se marca «no encontrado» con «Buscar…» (diálogo → nuevo enlace conservando letra, subtítulos, ediciones, posición en listas) o «Quitar». Nunca romper el arranque.
- Las listas exportadas siguen identificando por nombre + tamaño (sin rutas: no filtran la estructura del disco).
- Humo en Electron: renombrar el archivo enlazado entre reinicios → «no encontrado»; volver a enlazar → recupera sus datos.
- Revisión: Codex.

### T2.3 — Versión web: tope de 2 GB y avisos · **Sonnet** (tras T0.2, T0.3) · **Hecha**
> Hecho: sin `window.reproductor`, `addFiles` copia a IndexedDB los videos de hasta 2 GB inclusive (`2 * 1024 ** 3` bytes) pidiendo `navigator.storage.persist()` una sola vez en la primera importación de video, y deja los de más de 2 GB solo en memoria (`source: "session"`, `id: null`) con un aviso visible que recomienda la app de escritorio, manteniendo los avisos de cuota de T0.2 y el conteo separado en el resumen de importación. `manifest.webmanifest` añade `video/mp4` (`.mp4`) y `video/webm` (`.webm`) a `file_handlers`.
- Sin `window.reproductor`: videos ≤ 2 GB se copian a IndexedDB (con `navigator.storage.persist()` pedido en la primera importación de video); > 2 GB → «solo esta sesión» con aviso que recomienda la app de escritorio.
- `manifest.webmanifest`: `file_handlers` para `video/mp4` y `video/webm` (Chromium instalado como PWA).
- Prueba de humo (navegador): archivo simulado de 2 GB + 1 byte → no se copia, queda de sesión, aviso visible.
- Revisión: Gemini.

---

## 5. Formatos (Fase 3)

| Formato | Electron (Chromium con códecs propietarios) | Chromium | Firefox | Qué hacemos |
|---|---|---|---|---|
| MP4 H.264 + AAC | **sí** (Electron incluye H.264/AAC en su ffmpeg; confirmar en TE.0) | sí | sí | soportado, formato recomendado |
| MP4 H.265/HEVC | solo con decodificación por hardware (VA-API en Linux, a verificar) | ídem | según SO | `canPlayType`; si no, avisar |
| MP4 AV1 | sí | sí | sí | `canPlayType` |
| WebM VP8/VP9/AV1 + Opus/Vorbis | sí | sí | sí | soportado |
| MOV (QuickTime) con H.264 | normalmente sí | normalmente sí | a veces | intentarlo |
| MKV | a menudo sí si los códecs lo son | ídem | no | intentarlo; si falla, mensaje + consejo de *remux* |
| AVI, WMV, FLV, MPEG-TS | no | no | no | rechazar con mensaje claro |
| Audio AC-3/E-AC-3/DTS dentro del MP4 | casi nunca | casi nunca | no | avisar «el video se verá sin sonido» |

Con Electron la tabla deja de depender del navegador de la persona: se prueba **una** build fija (la de TE.0) y se repite al subir de versión de Electron.

### T3.1 — Compatibilidad: comprobar antes y explicar después · **Sonnet** (tras T0.5)
- Sin cambios respecto a la versión anterior: `stsd` → cadena de códecs → `canPlayType`; `error` / `videoWidth === 0` → mensaje; MKV/AVI → consejo de *remux* (`ffmpeg -i entrada.mkv -c copy salida.mp4` en el README); función pura `explainFailure(kind, ext, codecs)` con pruebas.
- Revisión: Gemini.

### T3.2 — (Opcional) Metadatos de WebM/MKV · **Sonnet**
- Lector EBML mínimo. Baja prioridad.

---

## 6. Subtítulos SRT/VTT (Fase 4)

### T4.1 — `src/subtitles.js` (módulo puro) · **Sonnet**
- Sin cambios: `parse` SRT/VTT, `decode` (UTF-8 / UTF-16 / `windows-1252`), `toVtt` con escape. Pruebas con casos reales.
- Revisión: Codex.

### T4.2 — Subtítulos en el reproductor · **Sonnet** (tras T1.3, T4.1)
- Sin cambios en lo esencial (`<track>` con `blob:` VTT, `::cue`, emparejado por nombre, desfase, `tracks.subs`).
- **Electron:** al enlazar o abrir un video, el principal busca `nombre.srt` / `nombre.*.srt` / `.vtt` **en la misma carpeta** y los ofrece (solo lee archivos de texto acompañantes del video que la persona abrió, validados en `rutas.js`). En la web sigue siendo «arrastrarlos junto al video» o «Cargar subtítulos…».
- Revisión: Gemini.

### T4.3 — (Opcional) Subtítulos incrustados en MP4 (`tx3g`/`mov_text`) · **Sonnet**
- Sin cambios.

---

## 7. Miniaturas y metadatos MP4 (Fase 5)

### T5.1 — Metadatos de video en `mp4.js` · **Sonnet** (tras T0.5)
- Implementado: `mvhd`, `tkhd` versión 0/1 con rotación y dimensiones efectivas, `hdlr`, etiquetas `ilst` (incluidos serie/temporada/episodio) y capítulos Nero `chpl`. La biblioteca muestra resolución y artista/año o serie/temporada/episodio.
- Robustez: tamaños de 64 bits, cajas truncadas o de tamaño 0 y límites de profundidad/recorrido.
- Pruebas: `tests/unit/mp4.test.js` y `tests/unit/tags.test.js`.
- Revisión: Codex.

### T5.2 — Miniaturas · **Sonnet** (tras T1.3, T0.3)
- Sin cambios en el método (`<video muted>` fuera del grafo, `seeked`, canvas, JPEG ~20 KB en `tracks.thumb`). En Electron el `<video>` auxiliar usa la URL `__media/<id>` (el salto con `Range` hace que sea rápido incluso en videos de varios GB).
- Revisión: Gemini.

### T5.3 — Editor con video · **Haiku** · **Hecha**
> Hecho: el editor (`src/app/editor.js`) funciona igual con pistas de video: título, artista, álbum y carátula/miniatura. Quitar o cambiar la carátula no pierde ni regenera `tracks.thumb`, reflejándose de inmediato en la lista y en el reproductor. «Guardar y descargar copia» se oculta para pistas de video (TagWriter solo escribe MP3/FLAC); en edición múltiple mezclada sigue visible si hay algún audio MP3/FLAC y los videos se saltan al descargar sin leer el archivo entero en memoria. Se previenen errores al manejar pistas no disponibles (sin `file`) o videos enlazados en Electron (`LinkedFile`), sin escribir nunca sobre el original. Textos adaptados («pista» y «miniatura»). Pruebas completas en `tests/smoke.js`.
- Sin cambios («descargar copia» oculto para video). En Electron «descargar» sigue siendo descarga (diálogo de guardar de Electron); no se escribe nunca sobre el original.
- Revisión: Codex.

---

## 8. Interfaz (Fase 6)

### T6.1 — Vista de video y biblioteca · **Sonnet** (tras T1.3)
- Sin cambios.

### T6.2 — Pantalla completa · **Sonnet**
- Sin cambios (`requestFullscreen()` sobre `#stage`). En Electron el permiso `fullscreen` es el único que concede el manejador de permisos (TE.1). Comprobar en Wayland y X11.
- Revisión: Codex.

### T6.3 — Picture-in-picture · **Haiku** (tras T1.3)
- Sin cambios; verificar que la build de Electron lo expone (`document.pictureInPictureEnabled`). Si no, el botón no aparece (ya está previsto).
- Revisión: Gemini.

### T6.4 — Atajos · **Haiku**
- Sin cambios (tabla anterior: `F`, `I`, `C`, `Z/X`, `,`/`.`, `Mayús+←/→`, `L`). En Electron, comprobar que `F11`/`Ctrl+R`/`Ctrl+Mayús+I` del menú por defecto no chocan (en el paquete no hay menú por defecto).

| Tecla | Acción | Nota |
|---|---|---|
| `F` | pantalla completa | |
| `I` | picture-in-picture | `P` ya es «anterior» |
| `C` | subtítulos sí/no | |
| `Z` / `X` | desfase de subtítulos −/+ 0,1 s | |
| `,` / `.` | fotograma anterior/siguiente (en pausa) | paso de 1/30 s |
| `Mayús + ←/→` | ±30 s | |
| `L` | letra (audio) | sin cambios |

### T6.5 — Textos «canción» → «pista» y nombre «Reproductor» · **Haiku**
- Nombre decidido: **«Reproductor»** → `<title>`, `manifest`, README, `productName` de electron-builder (TE.3) y título de la ventana. El repositorio y el paquete npm pueden seguir llamándose `reproductor-mp3` (decisión menor §10); la base IndexedDB **no** se renombra.

### ~~T6.6 — Fundido visual entre videos~~ · **Fuera por ahora** (decidido: corte limpio).

---

## 9. Pruebas (transversal)

**Unitarias (`node:test`, sin dependencias, sin Electron instalado)**
- `mp4.js`, `subtitles.js`, `util.js` (`isVideo`, `isMedia`, `explainFailure`): sin cambios.
- **Nuevo `electron/lib`:** `servir.js` (lista blanca, recorrido de directorios, codificaciones raras), `rango.js`, `argumentos.js`, `rutas.js` (enlaces simbólicos, directorios, extensiones), `enlaces.js` (JSON corrupto, escritura atómica, ids no hex).
- ~~`launcher.test.js`~~ → se retira con TE.4; sus defensas equivalentes quedan en las pruebas de `electron/lib` (solo ids registrados, solo medios, id de 32 hex).
- `consistency.test.js`: `index.html` ↔ `sw.js` ↔ lista blanca del protocolo; CSP meta = CSP cabecera; extensiones de `fileAssociations` (TE.3) = `rutas.js` = `isMedia`; `file_handlers` del manifest coherentes.

**Humo (`tests/smoke.js`)** — ahora en **dos ejecutores**: navegador (`tests/smoke.html`, como hoy) y Electron (`npm run smoke:app`, TE.1).
- Video generado **en el propio navegador** (canvas + `captureStream` + `MediaRecorder`), sin ffmpeg.
- Escenarios comunes: importar video · `videoWidth > 0` · EQ en el grafo · audio → video → audio · sin fundido con video · temporizador pausa el video · subtítulos · miniatura · recarga conserva todo · migración v1 → v2 · video no compatible avisa.
- Solo web: cuota agotada (T0.2), > 2 GB queda de sesión (T2.3).
- Solo Electron: archivos por argv, enlace por ruta con salto, reinicio conserva enlaces, archivo movido → «no encontrado», `__media` con id falso → 404.

**Manual (no automatizable: decirlo en cada PR)**
- Pantalla completa y PiP reales, «Abrir con…» desde el gestor de archivos con paquete deb/pacman instalado, AppImage, teclas multimedia/MPRIS, Wayland y X11, Firefox para la versión web, videos reales grandes (fixtures con `timeout 60 ffmpeg … </dev/null`: H.264/AAC con y sin `-movflags +faststart`, HEVC, VP9 WebM, MKV, AC-3).
- El navegador integrado **no puede manejar la app de Electron**: lo que no cubra `npm run smoke:app` se comprueba a mano y se dice.

---

## 10. Decisiones

### Decidido (2026-11-23)
1. **Nombre**: «Reproductor» (sin «MP3»).
2. **Videos**: se **enlazan** al archivo del disco por defecto. *Actualizado:* con Electron se enlazan por **ruta** (T2.1 nueva), no con File System Access.
3. **Tamaño máximo para copiar**: 2 GB. Por encima, nunca se copia. Sin streaming con `Range` *en el servidor Python* — *actualizado:* el servidor Python se retira; en Electron el `Range` lo sirve el propio proceso principal, solo para ids registrados, y es lo que permite no copiar ni cargar el video en memoria.
4. **Fundido**: corte limpio entre videos; T6.6 fuera.
5. **Plataforma**: app de escritorio con **Electron** (antes «abierto»). La web se mantiene si es barato.
6. **Nuevas decisiones 1–7 (abajo): aceptadas todas las recomendaciones** (2026-11-23). Matiz en la 4: el usuario usa Arch → prioridad pacman + AppImage; deb después.

### Nuevas decisiones que necesito de la persona
1. **Dependencias de desarrollo.** Electron y electron-builder rompen la letra de «sin dependencias ni build» (no su espíritu: la interfaz sigue sin dependencias). ¿De acuerdo con añadirlas como `devDependencies` con versión fija y matizar la regla en `CLAUDE.md`? *Recomiendo sí.*
2. **Audio en la app: ¿copiar o enlazar?** *Recomiendo seguir copiando* el audio a IndexedDB (cero cambios, la biblioteca sobrevive si mueves la carpeta de música) y enlazar solo los videos. Alternativa: enlazar todo (una sola vía, no duplica la música en disco, pero la biblioteca depende de que no muevas archivos).
3. **Datos de la versión web actual.** La app tiene su propio almacenamiento: la biblioteca que hoy está en el navegador (`localhost:8000`) **no pasa sola** a la app. Opciones: (a) volver a importar la carpeta de música y las listas exportadas (JSON/M3U, se enlazan por nombre + tamaño) — sin trabajo extra; (b) tarea opcional TE.6 «Exportar/importar ajustes» (EQ, listas, tema, letras propias, ediciones) en un JSON. *Recomiendo (a) + TE.6 si tienes letras o ediciones que no quieres perder.*
4. **Formatos de paquete y distribución.** ¿AppImage, deb **y** pacman, o solo el de tu distro? ¿Publicar los paquetes en GitHub Releases con un workflow al etiquetar versión? *Recomiendo los tres localmente y Releases más adelante.* Sin auto-actualización (no habrá peticiones de red): actualizar será a mano.
5. **¿Cuánto tiempo mantener la versión web?** *Recomiendo* mantenerla mientras el coste sea el de hoy (mismo código + T2.3) y revisarlo tras TE.4; si se abandona, se borran `sw.js`, `manifest` y T2.3.
6. **Otras plataformas.** ¿Solo Linux? Windows sería barato después (NSIS); macOS exige firma y notarización de Apple. *Recomiendo solo Linux por ahora.*
7. (Menor) **`servidor.py`**: ¿reducirlo a servidor estático con la comprobación de `Host`, o sustituirlo por `python3 -m http.server`? *Recomiendo lo segundo.* ¿Renombrar el repo/paquete `reproductor-mp3`? *Recomiendo no tocarlo de momento.*

### Riesgos (Electron)
| Riesgo | Impacto | Mitigación |
|---|---|---|
| Medio de otro origen → Web Audio recibe **silencio** | EQ y visualizador rotos con video | Servir videos desde el mismo origen `app://reproductor/__media/` (o `crossorigin` + CORS); comprobado en TE.0 punto 4 |
| `protocol.handle` + `net.fetch` no reenvía bien `Range` en la versión elegida | Saltos lentos, video entero en memoria | Implementación propia con `fs.createReadStream` y `206` (`rango.js`, probada) |
| Sandbox: Ubuntu ≥ 23.10 restringe *user namespaces* (AppArmor); AppImage sin `chrome-sandbox` SUID | La app no arranca en algunas distros | Perfil AppArmor en el deb; documentar; **no** distribuir con `--no-sandbox` |
| AppImage no registra «Abrir con…» y necesita `libfuse2` en algunas distros | «Abrir con…» no aparece | deb/pacman como vía principal; `--instalar-escritorio` opcional; documentar |
| Electron saca versión mayor cada ~8 semanas y solo mantiene 3 | Fallos de seguridad de Chromium sin parchear si no se actualiza | Versión fija; revisar al menos cada trimestre; repetir humo y tabla de códecs al subir |
| HEVC / AC-3 dependen del hardware o no están | Algunos videos sin imagen o sin sonido | T3.1 lo detecta y explica; consejo de *remux*/recodificar fuera |
| Tamaño: ~100 MB por paquete (frente a ~200 KB de la web) | Descarga e instalación | Aceptado al elegir Electron; Tauri se descartó por códecs |
| Pruebas: el navegador integrado no maneja Electron | Menos verificación automática | `npm run smoke:app` (TE.1) + lista manual explícita en cada PR |
| La biblioteca del navegador no se migra sola | La persona «pierde» letras/ediciones al cambiar | Decisión 3 (TE.6 opcional) |
| Rutas del disco en `enlaces.json` | Privacidad local | Solo en `userData`, permisos 0600, nunca en IndexedDB, listas exportadas ni red |
| CI: si algún día se hace `npm ci`, descarga Electron (~100 MB) | CI lenta | Mantener `npm test` sin instalar, o `ELECTRON_SKIP_BINARY_DOWNLOAD=1` |

---

## 11. Orden y dependencias

```
Fase E  TE.0 (pico, decide) ─► TE.1 ─► TE.2 ─► TE.3 ─► TE.4      TE.5 acompaña a cada PR
Fase 0  T0.3 ─► T0.4        T0.2   T0.5   T0.6   T0.7                 (en paralelo entre sí y con TE.1–TE.3)
Fase 1  T0.6 ─► T1.1 ─┐
        T0.5 ─► T1.2 ─┴► T1.3
Fase 2  TE.2 + T0.3 + T1.2 ─► T2.1 ─► T2.2 ;   T0.2 + T0.3 ─► T2.3 (web)
Fase 3  T0.5 ─► T3.1  (T3.2 opcional)
Fase 4  T4.1 (en cualquier momento) ─► T4.2 (tras T1.3; la búsqueda de .srt vecinos tras T2.1)
Fase 5  T0.5 ─► T5.1 ;  T1.3 + T0.3 ─► T5.2 ─► T5.3
Fase 6  T1.3 ─► T6.1 ─► T6.2, T6.3, T6.4 ;  T6.5 en cualquier momento (nombre ya decidido)
```

Notas de orden:
- **TE.0 va primero**: si el punto 4 (Web Audio con video servido por el protocolo) falla y no tiene arreglo, cambia el diseño de la Fase 2.
- TE.1 casi no toca la interfaz (solo no registrar el service worker), así que no choca con T0.6/T1.x. TE.2 toca `library.js/openFromSystem`: coordinar con T1.2.
- TE.4 solo cuando TE.3 esté instalada y probada a mano por la persona.

**Resumen por modelo**

| Modelo | Tareas |
|---|---|
| Opus | TE.0, TE.1, TE.2, T0.3, T1.1, T2.1 (y T0.8 si se hace); revisión de seguridad de TE.3 |
| Sonnet | TE.3, TE.4, T0.2, T0.4, T0.5, T1.2, T1.3, T2.2, T2.3, T3.1, T3.2, T4.1, T4.2, T4.3, T5.1, T5.2, T6.1, T6.2 |
| Haiku / Codex gpt-6-luna | TE.5, T0.6, T0.7, T5.3, T6.3, T6.4, T6.5 |
| Revisión Gemini / Codex | todos los PR; doble revisión en TE.1, TE.2, T0.3, T1.1, T2.1 |
| Obsoletas | ~~T0.1~~, ~~T2.1 (cuotas)~~, ~~T2.2 (File System Access)~~, ~~T2.3 (lanzador con video)~~, ~~T6.6~~ |

**Hito mínimo útil** (abrir un MP4 del disco en la app sin romper nada):
TE.0 → TE.1 → T0.3, T0.5, T0.6 → T1.1, T1.2, T1.3 → TE.2 → T2.1 → T6.1, T6.2.
Después: TE.3 (instalable con «Abrir con…») → TE.4 (retirar el lanzador). El resto (subtítulos, miniaturas, PiP, versión web con tope de 2 GB) se añade encima sin rehacer nada.
