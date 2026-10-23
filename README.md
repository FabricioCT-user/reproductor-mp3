# Reproductor MP3

Reproductor de música local que corre en el navegador. Sin dependencias ni build: tus archivos nunca salen de tu equipo.

## Funciones

- Biblioteca persistente (IndexedDB): al reabrir la página tus canciones siguen ahí
- Lectura de etiquetas ID3v2: título, artista, álbum y carátula
- Carátula grande, miniaturas en la lista y fondo difuminado con los colores del álbum
- Visualizador de audio en tiempo real
- Búsqueda en la biblioteca y botón para quitar canciones
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

## Uso

Abre `index.html` en el navegador, o sirve la carpeta:

```bash
python -m http.server 8000
```

y visita <http://localhost:8000>.

## Hoja de ruta

- [ ] Listas de reproducción con nombre y reordenar arrastrando
- [ ] Cola de reproducción
- [ ] Ecualizador
- [ ] Soporte de etiquetas Vorbis/MP4 (FLAC, OGG, M4A)
- [ ] Letras sincronizadas
- [ ] Empaquetado como app de escritorio / PWA

## Licencia

MIT
