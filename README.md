# Reproductor MP3

Reproductor de música local que corre en el navegador. Sin dependencias ni build: tus archivos nunca salen de tu equipo.

## Funciones

- Añadir canciones desde el selector o arrastrando archivos
- Lista de reproducción, anterior / siguiente
- Barra de progreso, volumen
- Modo aleatorio y repetir
- Atajos: `Espacio` play/pausa, `←` / `→` retroceder/avanzar 5 s

## Uso

Abre `index.html` en el navegador, o sirve la carpeta:

```bash
python -m http.server 8000
```

y visita <http://localhost:8000>.

## Hoja de ruta

- [ ] Guardar la lista de reproducción (IndexedDB)
- [ ] Leer etiquetas ID3 (artista, álbum, carátula)
- [ ] Visualizador de audio
- [ ] Empaquetado como app de escritorio

## Licencia

MIT
