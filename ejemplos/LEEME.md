# Ejemplos de Tarareo

Estos audios y el vídeo se generan para esta demo mediante síntesis propia, determinista y sin dependencias: Brisa combina cuerda pulsada Karplus–Strong y un colchón suave; Jardín usa campanas y percusión ligera; Nubes tiene piano eléctrico y eco. El vídeo incluye una banda sonora original. Las carátulas son paisajes dibujados por píxeles y van incrustadas en los archivos de audio. La letra sincronizada y los subtítulos también son originales. No se usaron grabaciones ni archivos de terceros.

Cada pista dura 28 s, en estéreo a 44,1 kHz; los MP3 se codifican a 160 kb/s. Paseo dura 24 s, a 1280×720 y 24 fps, con VP9 y Opus. El generador muestra la medición ebur128 de cada canción al codificar.

Para regenerarlos desde la raíz del proyecto: `/usr/bin/node scripts/generar-ejemplos.js` (requiere FFmpeg en el sistema, solo para codificación y medición). Se distribuyen bajo la licencia del repositorio.
