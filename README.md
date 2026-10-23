# Reproductor MP3

Reproductor de música local que corre en el navegador. **Sin dependencias ni build**: tus archivos nunca salen de tu equipo.

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

## Uso

Sirve la carpeta con cualquier servidor estático:

```bash
npm start            # o: python3 -m http.server 8000
```

y abre <http://localhost:8000>. Desde Chrome o Edge puedes **instalarla como app** (icono de instalar en la barra de direcciones, o menú ⋮ → «Instalar Reproductor MP3»). Una vez instalada se abre en su propia ventana y también funciona sin el servidor (se sirve desde la copia guardada).

### Abrir un archivo con doble clic («Abrir con…»)

Con la app **instalada** (Chrome o Edge de escritorio), el sistema la ofrece como programa para abrir `.mp3`, `.flac`, `.m4a`, `.ogg`, `.oga`, `.opus`, `.aac` y `.wav`:

1. Instala la app como se explica arriba.
2. Clic derecho sobre un archivo de audio → **Abrir con** → *Reproductor MP3* (en Windows: «Elegir otra aplicación»; en macOS: «Obtener información» → «Abrir con»). Para que sea el programa por defecto, marca «Usar siempre» o cámbialo en las propiedades del tipo de archivo.
3. El archivo se añade a la biblioteca y empieza a sonar. Si abres varios a la vez, suena el primero y el resto quedan en la cola. Si la app ya está abierta, los archivos van a esa ventana.

Si el navegador no permite que algo suene sin que hayas tocado la página, la app lo pausa y avisa («pulsa ▶») en vez de reproducir en silencio.

> Tu biblioteca, tus listas y tus ajustes se guardan en el navegador y **ligados a la dirección exacta** (`localhost:8000` no comparte datos con `localhost:3000`). Si borras los datos del sitio se pierden; exporta tus listas antes si te importa conservarlas. Los archivos de música se copian dentro del almacenamiento del navegador.

## Privacidad

No hay servidor ni análisis: la aplicación solo se descarga a sí misma. Una política de seguridad de contenido (CSP) impide cargar nada de otros sitios.

## Desarrollo

Sin dependencias: JavaScript clásico en el navegador, sin empaquetador. Para las pruebas basta con Node 22 o superior (probado con 26).

```
index.html  style.css  sw.js  manifest.webmanifest   página, estilos, caché sin conexión, PWA
src/
  util.js          funciones puras (formatos, rutas, isAudio…)
  lyrics.js        analizador de letras LRC
  playlist-io.js   formato JSON y M3U8 de las listas
  id3.js           lector ID3v2 (y analizador compartido con el escritor)
  tags.js          lector de etiquetas: FLAC, Ogg/Opus, M4A (MP3 se delega en id3.js)
  tag-writer.js    escritor de etiquetas para copias de MP3 y FLAC
  storage.js       biblioteca en IndexedDB
  app/             la aplicación, un archivo por función:
                   core, library, playlists, lyrics-ui, player, eq, fades, editor, theme, main
tests/
  unit/            pruebas con node:test (módulos puros, escritor de etiquetas, coherencia del proyecto)
  smoke.html       pruebas de humo: manejan la aplicación real en el navegador
```

**Cómo está organizado `src/app/`**: cada archivo solo *declara* (funciones y constantes); no hace nada al cargarse. Todo el cableado de eventos vive en funciones `wire…()` (una por archivo) que `main.js` llama al final, cuando todo ya existe. Por eso el orden de carga solo importa para las constantes que se usan al declarar (`index.html` y las pruebas lo vigilan).

**Pruebas**

```bash
npm test                         # unitarias (~80 pruebas, un par de segundos)
npm start                        # y abre http://localhost:8000/tests/smoke.html para las de humo
```

Las unitarias cargan los mismos scripts que el navegador dentro de un contexto aislado de Node y construyen archivos MP3, FLAC, Ogg y MP4 sintéticos para comprobar lectores y escritor (unsincronización, cabecera extendida, ID3v2.2, carátulas, bloques FLAC…). Las de humo importan archivos, reproducen, reordenan, editan, exportan, recargan y fuerzan fallos (archivos que no se pueden reproducir, `localStorage` corrupto, registros dañados). La prueba de humo usa audio generado en el propio navegador y no necesita ffmpeg.

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
