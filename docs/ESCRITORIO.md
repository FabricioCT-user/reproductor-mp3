# App de escritorio

La app de escritorio usa Electron y muestra la misma interfaz que la versión web. Abre archivos desde el gestor de archivos, y los **videos se enlazan** en vez de copiarse: la biblioteca guarda solo una referencia. Solo se ha probado en Linux x64.

## Instalación

Los paquetes se descargan de [Releases](https://github.com/FabricioCT-user/tarareo/releases). Usa el nombre de archivo que aparezca allí.

### Arch Linux (`.pacman`)

```bash
sudo pacman -U <archivo>.pacman
```

Registra el binario `/usr/bin/tarareo`, el icono y el archivo `.desktop` con las asociaciones de audio y video («Abrir con… → Tarareo»). Declara que reemplaza, entra en conflicto con y proporciona el paquete `reproductor-mp3`, para actualizar sin dejar ambos instalados. Configura el sandbox al instalarse (ver [Sandbox](#sandbox)).

### AppImage

```bash
chmod +x <archivo>.AppImage
./<archivo>.AppImage
```

El AppImage no registra asociaciones por sí solo. Para integrarlo en el menú y en «Abrir con…», ejecútalo una vez con `--instalar-escritorio`:

```bash
./<archivo>.AppImage --instalar-escritorio
```

Esto escribe `~/.local/share/applications/tarareo.desktop` y el icono en `~/.local/share/icons/hicolor/512x512/apps/tarareo.png`, apuntando a la ruta actual del AppImage. Vuelve a ejecutarlo si lo mueves de sitio; para quitarlo, borra ambos archivos. Al migrar desde 1.0.0, si encuentra `reproductor.desktop` apuntando a un AppImage de Reproductor, lo reemplaza; si es de otra app, lo conserva. Las asociaciones por defecto que apuntaban a `reproductor.desktop` hay que volver a elegirlas para Tarareo. Si usas un gestor de AppImages (AppImageLauncher o Gear Lever), también puede integrarlo; no se ha probado con ellos.

**Ubuntu 23.10 o posterior:** el AppImage puede no arrancar. Ubuntu restringe los espacios de nombres de usuario; el lanzador interno intenta añadir `--no-sandbox`, y la app se niega a arrancar (nunca se ejecuta sin sandbox). No recomendamos cambiar la configuración del sistema para esto. Si no arranca, usa la [demo](https://fabricioct-user.github.io/tarareo/) o la versión web. El paquete `.pacman` solo sirve en Arch y derivados, no en Ubuntu.

### Debian / Ubuntu (`.deb`)

El `.deb` todavía no se publica en Releases porque **no está probado en Ubuntu**. Si quieres generarlo tú (ver [Desde el código](#desde-el-código)):

```bash
sudo apt install ./dist/tarareo_*.deb
```

Registra las mismas asociaciones de audio y video, y declara que reemplaza, entra en conflicto con y proporciona `reproductor-mp3`. Su script de post-instalación ajusta el sandbox; si AppArmor está activo y acepta el perfil incluido (Ubuntu 24 o posterior), instala ese perfil.

### Desde el código

```bash
npm install     # instala Electron 45.4.1 y electron-builder (solo desarrollo)
npm start       # abre la app
npm run dist    # genera los paquetes en dist/
```

`electron-builder` genera `.pacman` y `.deb` con `fpm` (Ruby). Si falla por falta de `libcrypt.so.1` (en Arch, el paquete `libxcrypt-compat`), instálalo. Si solo quieres el AppImage: `npx electron-builder --linux AppImage`.

## Sandbox

Electron necesita el sandbox del sistema. Los paquetes lo configuran al instalarse; el AppImage depende de que el sistema permita espacios de nombres de usuario. **La app nunca se ejecuta con `--no-sandbox`**: se niega a arrancar con esa opción.

En sistemas sin espacios de nombres de usuario sin privilegios (p. ej. `linux-hardened` o `unprivileged_userns_clone=0`), el script de post-instalación de `.pacman`/`.deb` comprueba `unshare` como `root` y puede dejar `/opt/Tarareo/chrome-sandbox` con permisos `0755`, y entonces la app falla cerrada al arrancar. Para resolverlo, puedes poner el bit SUID a mano (`sudo chmod 4755 /opt/Tarareo/chrome-sandbox`). Son cambios en el sistema, no solo en la app: quien administra la máquina debe decidirlo, y no los recomendamos en equipos de uso general.

## Abrir archivos

Desde el terminal, en la carpeta del proyecto:

```bash
npm run app -- ~/Música/cancion.mp3 "$HOME/Música/otra canción.flac"
```

Las rutas deben ser absolutas (npm ejecuta desde la carpeta del proyecto); también valen URLs `file://`. Los archivos se añaden a la biblioteca: suena el primero y los demás quedan en la cola. Con la app ya abierta, abrir más archivos (con el mismo comando, o con el paquete instalado desde «Abrir con…») no abre otra ventana: los entrega a la abierta y la pone al frente.

En la app, «+ Añadir» y «+ Carpeta» usan el diálogo del sistema. El proceso principal solo acepta archivos regulares (resuelve enlaces simbólicos y mira la extensión del destino) de audio, video, `.lrc`, `.srt` o `.vtt`. La interfaz nunca ve rutas: recibe un id de un solo uso y pide con él los bytes, que se copian a la biblioteca como cualquier otro archivo. Un `.srt`, `.vtt` o `.lrc` que se abre solo no hace nada: se asocia a la pista si llega junto a su video o audio.

## Videos enlazados

Un video que llega por «Abrir con…», por el diálogo, arrastrándolo o con el selector de archivos se registra en `enlaces.json`, dentro de la carpeta de datos de la app (permisos 0600), con un id opaco. La biblioteca (IndexedDB) guarda solo ese id (`source: "link"`) y nunca la ruta.

La interfaz reproduce el video desde `app://reproductor/__media/<id>`. El proceso principal lo sirve con `Range` propio (`206`, `416`, tipo según la extensión), leyendo el archivo por trozos de 512 KB solo cuando el reproductor los pide, y lo cierra en cuanto se cancela la petición (al saltar). Así, un video de varios GB ni se copia ni se carga en memoria. Las etiquetas también se leen por `Range`. Solo se sirven ids registrados; quitar la pista olvida su enlace.

Si el archivo se mueve o se borra, la pista no se pierde: queda marcada «No encontrado» con «Buscar…» (eliges de nuevo el video y conservas letra, subtítulos y ediciones) o «Quitar». El audio se sigue copiando a la biblioteca.

En la versión web, los videos de hasta 2 GB se copian a IndexedDB (pidiendo almacenamiento persistente en la primera importación de video), y los de más de 2 GB quedan solo para esa sesión (`source: "session"`) con un aviso que recomienda la app de escritorio.

## Datos

La biblioteca (IndexedDB), los ajustes (localStorage) y `enlaces.json` están en la carpeta de datos de Electron: en Linux, `$XDG_CONFIG_HOME/reproductor-mp3` (o `~/.config/reproductor-mp3` si no está definida). Se conserva deliberadamente el nombre `reproductor-mp3` para que las instalaciones 1.0.0 mantengan sus datos. Con `--user-data-dir=<ruta absoluta>` se usa otra carpeta, que prevalece sobre la ruta por defecto.

## Seguridad

- La app sirve la interfaz desde `app://reproductor/`, que entrega solo los archivos de `FILES` en `sw.js` (más `index.html`) y repite la CSP del meta como cabecera.
- La ventana va endurecida: aislamiento de contexto, sandbox, sin Node en la página, sin ventanas nuevas ni navegación fuera de la app, y sin permisos salvo pantalla completa.
- El paquete lleva los *fuses* de Electron que impiden usarlo como Node (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) y solo carga la app desde el `.asar`.
- `EnableEmbeddedAsarIntegrityValidation` está activado, pero Electron solo valida la integridad del `.asar` en macOS y Windows, no en Linux. En Linux, la integridad depende de los permisos del paquete o, en el AppImage, del squashfs de solo lectura.
- Dentro de la app no se registra el service worker.
- Sin auto-actualización ni telemetría: los paquetes no comprueban actualizaciones. Para actualizar, instala el paquete nuevo.

## Límites

- Solo Linux x64. Las mediciones se hicieron con Electron 45.4.1 en Wayland (Hyprland); X11 no se ha probado.
- Pantalla completa, imagen en imagen y «Abrir con…» con el paquete instalado se comprueban a mano, y los menús del sistema no se pueden automatizar.
- Las pruebas automáticas de escritorio (`npm run smoke:app`) necesitan ffmpeg.
