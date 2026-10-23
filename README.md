# Reproductor MP3

Reproductor de música local que corre en el navegador. Sin dependencias ni build: tus archivos nunca salen de tu equipo.

## Funciones

- Biblioteca persistente (IndexedDB): al reabrir la página tus canciones siguen ahí
- Lectura de etiquetas y carátula (título, artista, álbum) en MP3 (ID3v2), FLAC, Ogg Vorbis, Opus y M4A/AAC
- Edición de etiquetas (título, artista, álbum y carátula) con el botón `✎` de cada canción o doble clic sobre el título del reproductor. Los cambios se guardan en la app y se pueden restaurar; tus archivos originales no se modifican. Las carátulas grandes se reducen a 800 px
- Edición en lote: pulsa `Seleccionar` (o Ctrl/Cmd + clic en una canción), marca varias (Mayús para rangos, «Todas» respeta el filtro) y pulsa `Editar`. Solo se cambian los campos que toques, así que puedes poner el álbum a toda una carpeta sin pisar artistas o títulos distintos; «Restaurar originales» deshace las ediciones de todas
- Carátula grande, miniaturas en la lista y fondo difuminado con los colores del álbum
- Visualizador de audio en tiempo real
- Letras sincronizadas: lee la letra incrustada (MP3, FLAC, Ogg, Opus, M4A) o archivos `.lrc` y resalta la línea actual; pulsa una línea para saltar a ella. Para añadir una `.lrc`, suéltala junto al audio con el mismo nombre (o usa «Cargar .lrc» en el panel); se guarda en el navegador. Botón `Letra` o tecla `L`
- Ecualizador de 10 bandas (32 Hz–16 kHz, ±12 dB) con preajustes (Graves, Agudos, Voz, Rock, Pop, Electrónica, Clásica); se guarda entre sesiones
- Búsqueda en la biblioteca y botón para quitar canciones
- Reordena la biblioteca arrastrando (el orden se guarda)
- Listas de reproducción con nombre: créalas, renómbralas, reordénalas arrastrando y añade canciones con el botón `♫`. Siguiente/anterior respetan la lista desde la que reproduces
- Exportar e importar listas (botón `⋯`): JSON con todas tus listas, o M3U8 estándar para otros reproductores. Las canciones se identifican por nombre de archivo y tamaño, así que valen en otro navegador; las que aún no estén en la biblioteca quedan «pendientes» y se enlazan solas al importarlas. También puedes soltar un `.json` / `.m3u8` en la ventana
- Cola de reproducción: pulsa `+` en una canción para reproducirla a continuación
- Instalable como app (PWA) y funciona sin conexión
- Velocidad de reproducción de 0,5× a 2× sin cambiar el tono (menú `1×` o teclas `[` y `]`); se recuerda entre sesiones
- Fundido entre canciones (crossfade) de 2 a 12 s con curva de potencia constante (botón `⇄`); solo cuando la reproducción pasa sola a la siguiente, nunca en la última ni al cambiar a mano
- Temporizador de apagado (15–90 min, personalizado o «al terminar la canción») con fundido de salida de 8 s
- Aleatorio, repetir, volumen y silencio (se recuerdan entre sesiones)
- Teclas multimedia del sistema (Media Session API)
- Tema claro, oscuro o automático (sigue al sistema); botón `◐` / `☀` / `☾`
- Interfaz adaptable a móvil
- Importa carpetas completas (con subcarpetas) con el botón `+ Carpeta` o arrastrándolas a la ventana: se ordenan por ruta en orden natural, se ignoran los archivos que no son audio y no se duplican las canciones ya importadas. Los `.lrc` de la carpeta se emparejan con su canción
- Arrastra archivos sueltos a cualquier parte de la ventana para añadirlos

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

Abre `index.html` en el navegador, o sirve la carpeta:

```bash
python -m http.server 8000
```

y visita <http://localhost:8000>.

## Hoja de ruta

- [ ] Descargar una copia del archivo con las etiquetas editadas

## Licencia

MIT
