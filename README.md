# Reproductor MP3

Reproductor de música local que corre en el navegador. Sin dependencias ni build: tus archivos nunca salen de tu equipo.

## Funciones

- Biblioteca persistente (IndexedDB): al reabrir la página tus canciones siguen ahí
- Lectura de etiquetas y carátula (título, artista, álbum) en MP3 (ID3v2), FLAC, Ogg Vorbis, Opus y M4A/AAC
- Carátula grande, miniaturas en la lista y fondo difuminado con los colores del álbum
- Visualizador de audio en tiempo real
- Letras sincronizadas: lee la letra incrustada (MP3, FLAC, Ogg, Opus, M4A) o archivos `.lrc` y resalta la línea actual; pulsa una línea para saltar a ella. Para añadir una `.lrc`, suéltala junto al audio con el mismo nombre (o usa «Cargar .lrc» en el panel); se guarda en el navegador. Botón `Letra` o tecla `L`
- Ecualizador de 10 bandas (32 Hz–16 kHz, ±12 dB) con preajustes (Graves, Agudos, Voz, Rock, Pop, Electrónica, Clásica); se guarda entre sesiones
- Búsqueda en la biblioteca y botón para quitar canciones
- Reordena la biblioteca arrastrando (el orden se guarda)
- Listas de reproducción con nombre: créalas, renómbralas, reordénalas arrastrando y añade canciones con el botón `♫`. Siguiente/anterior respetan la lista desde la que reproduces
- Cola de reproducción: pulsa `+` en una canción para reproducirla a continuación
- Instalable como app (PWA) y funciona sin conexión
- Aleatorio, repetir, volumen y silencio (se recuerdan entre sesiones)
- Teclas multimedia del sistema (Media Session API)
- Interfaz adaptable a móvil
- Arrastra archivos a cualquier parte de la ventana para añadirlos

## Atajos

| Tecla | Acción |
|---|---|
| `Espacio` | Reproducir / pausar |
| `←` / `→` | Retroceder / avanzar 5 s |
| `↑` / `↓` | Volumen |
| `N` / `P` | Siguiente / anterior |
| `S` / `R` | Aleatorio / repetir |
| `M` | Silenciar |
| `L` | Mostrar / ocultar letra |

## Uso

Abre `index.html` en el navegador, o sirve la carpeta:

```bash
python -m http.server 8000
```

y visita <http://localhost:8000>.

## Hoja de ruta

- [ ] Importar carpetas completas
- [ ] Exportar / importar listas de reproducción
- [ ] Velocidad de reproducción y temporizador de apagado
- [ ] Transición suave entre canciones (crossfade)
- [ ] Tema claro
- [ ] Edición de etiquetas desde la propia app

## Licencia

MIT
