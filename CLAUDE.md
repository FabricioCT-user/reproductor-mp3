# Reproductor MP3 — guía para Claude

Reproductor de música local que corre en el navegador. **JavaScript clásico, sin dependencias ni build.** Repo público: https://github.com/FabricioCT-user/reproductor-mp3. La persona que lo mantiene habla español: interfaz, comentarios, mensajes de commit y README van **en español**.

## Comandos

```bash
npm start      # servidor estático en http://localhost:8000
npm test       # pruebas unitarias (node:test, tests/unit/*.test.js, ~80)
```

- Pruebas de humo (manejan la app real): con `npm start` abre `http://localhost:8000/tests/smoke.html`; `window.__results` / `window.__done` tienen el resultado.
- **Usa `/usr/bin/node` y `/usr/bin/npm`**: en el shell de la persona `node` es una función rota de nvm.
- CI: GitHub Actions ejecuta `npm test` en cada push (`.github/workflows/test.yml`).

## Estructura

```
index.html  style.css  sw.js  manifest.webmanifest  icon*.{svg,png}
src/              módulos sin DOM: util, lyrics, playlist-io, id3, tags, tag-writer, storage
src/app/          la aplicación: core, library, playlists, lyrics-ui, player, eq, fades, editor, theme, main
tests/unit/       node:test; helpers.js construye MP3/FLAC/Ogg/MP4 sintéticos
tests/smoke.*     pruebas de humo en el navegador
```

**Regla de `src/app/`:** los archivos solo *declaran* (funciones y constantes). Todo el cableado de eventos, intervalos y estado inicial va dentro de funciones `wire…()` (una por archivo) que `main.js` llama al final. No pongas `addEventListener` ni `setInterval` sueltos a nivel superior. Todo es global (scripts clásicos, no módulos ES), así que los nombres no pueden repetirse entre archivos.

Al **añadir o mover un archivo**: ponlo en `index.html` (el orden importa: `util`, `lyrics`, `id3` antes que `tags`, `tags` antes que `tag-writer`, `main.js` el último) y en `FILES` de `sw.js`. Una prueba de coherencia lo comprueba.

## Convenciones y límites

- **CSP estricta** (meta en `index.html`): sin `unsafe-inline` ni `unsafe-eval`. Nada de `innerHTML` con datos de archivos (usa `textContent`), ni `style="…"` ni `onclick="…"` en el HTML, ni `eval`. Si cambias el script en línea del tema, actualiza su hash en la CSP (hay una prueba que lo vigila).
- Los datos del usuario nunca salen del equipo: no añadas peticiones de red ni librerías externas.
- Acceso a `localStorage` solo mediante `store` (core.js): puede estar bloqueado o tener datos corruptos.
- **Datos guardados:** IndexedDB `reproductor-mp3` v1, almacén `tracks` `{ id, name, blob, type, lyrics?, edits? }`. `localStorage`: `shuffle repeat speed crossfade playlists eq order lastId volume lyrics theme`. Un cambio de esquema exige subir la versión y migrar; no rompas los datos existentes.
- Las ediciones de etiquetas **no modifican el original**: viven en `edits`. Solo «descargar copia» (MP3 y FLAC) escribe etiquetas, siempre en un archivo nuevo, y se verifica releyéndolo.
- Para reproducir sin clic previo (Abrir con…), `play()` comprueba que el contexto de audio esté activo; no dejes que «suene» en silencio.

## Flujo de trabajo

Tras cada función importante: probarla (pruebas nuevas si procede), actualizar el README, **commit y push** con mensaje en español y el trailer `Co-Authored-By`. Verifica en el navegador integrado antes de dar algo por hecho, y di claramente lo que no se pudo comprobar (menús del sistema operativo, selectores de archivo nativos, Firefox/Safari).

## Trampas conocidas del entorno

- ffmpeg y flac están instalados para generar audio de prueba, pero usa `timeout N ffmpeg … </dev/null` (encadenados se cuelgan). ffmpeg guarda la letra de MP3 como `TXXX`, no `USLT`.
- No uses `pkill -f <patrón>` si el patrón aparece en tu propio comando (se mata a sí mismo, exit 144); localiza el pid con `ss -ltnp 'sport = :PUERTO'`.
- Navegador integrado: la pestaña debe estar al frente (`tabs_select`) o se ralentizan temporizadores y audio; `javascript_tool` caduca a los 45 s (sondea en llamadas cortas); `alert/confirm/prompt` están suprimidos (usa stubs); las capturas van un paso por detrás.
- La prueba de humo carga la página **sin** la CSP (vía `srcdoc` + `<base href="../">`) porque necesita `eval`; la CSP real se comprueba aparte.
- `indexedDB.deleteDatabase` se bloquea si otra pestaña tiene la base abierta: en pruebas se vacía el almacén.
- El service worker revalida siempre con la red; si cambias la lista de archivos sube `VERSION` en `sw.js`.

## Pendiente (hoja de ruta del README)

- Copias con etiquetas también para Ogg, Opus y M4A.
