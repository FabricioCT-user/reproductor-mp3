// Integración opcional del AppImage en el escritorio Linux (--instalar-escritorio).
// Escribe el archivo .desktop y el icono en ~/.local/share (o $XDG_DATA_HOME) apuntando a $APPIMAGE,
// de forma atómica, sin shell y escapando la ruta según la especificación Freedesktop Desktop Entry.
// Sin Electron: se prueba con node:test.
"use strict";

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const NOMBRE_ESCRITORIO = "reproductor.desktop";
const NOMBRE_ICONO = "reproductor";
const NOMBRE_APP = "Reproductor";
const CATEGORIAS = "AudioVideo;Audio;Video;Player";
// Coincide con build.linux.mimeTypes de package.json (electron-builder elimina «build» al empaquetar; una prueba vigila la igualdad).
const MIME_TYPES = [
  "audio/mpeg",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/x-vorbis+ogg",
  "audio/opus",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "video/mp4",
  "video/x-m4v",
  "video/webm",
  "video/x-matroska",
  "video/quicktime",
];
const CONTROL = /[\x00-\x1f\x7f]/;
const MIME_VALIDO = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

// Escape de un valor de tipo «string» en archivos .desktop (Desktop Entry Spec).
function escaparCadena(texto) {
  return String(texto)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Cita un argumento para el campo Exec según la Desktop Entry Spec:
// 1) Se rechazan caracteres de control (incluidos saltos de línea y NUL).
// 2) Dentro de comillas dobles en Exec, \, ", ` y $ llevan barra invertida, y % se duplica (%%).
// 3) Como Exec es un valor de tipo «string», las barras se duplican una segunda vez (p. ej. \ → \\\\, $ → \\$).
function escaparExec(ruta) {
  if (typeof ruta !== "string" || ruta.length === 0) throw new Error("Ruta de ejecutable vacía");
  if (CONTROL.test(ruta)) throw new Error("La ruta del ejecutable contiene caracteres de control no permitidos");
  const enExec = ruta
    .replace(/([\\"`$])/g, "\\$1")
    .replace(/%/g, "%%");
  return `"${enExec.replace(/\\/g, "\\\\")}"`;
}

// Carpeta base XDG para datos del usuario ($XDG_DATA_HOME si es absoluta, o $HOME/.local/share).
function carpetaDatos(env = process.env) {
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.length > 0 && path.isAbsolute(xdg) && !CONTROL.test(xdg)) {
    return path.normalize(xdg);
  }
  const home = env.HOME;
  if (typeof home === "string" && home.length > 0 && path.isAbsolute(home) && !CONTROL.test(home)) {
    return path.join(path.normalize(home), ".local", "share");
  }
  throw new Error("No se pudo determinar la carpeta de datos del usuario (faltan XDG_DATA_HOME y HOME)");
}

// Valida que la ruta del ejecutable sea absoluta, real, sin caracteres de control y un archivo regular.
async function validarEjecutable(ruta) {
  if (typeof ruta !== "string" || ruta.length === 0 || !path.isAbsolute(ruta) || CONTROL.test(ruta)) {
    throw new Error("La ruta del AppImage no es una ruta absoluta válida");
  }
  let real, st;
  try {
    real = await fs.promises.realpath(ruta);
    st = await fs.promises.stat(real);
  } catch {
    throw new Error(`No se encuentra el archivo del AppImage: ${ruta}`);
  }
  if (CONTROL.test(real)) throw new Error("La ruta real del AppImage contiene caracteres de control no permitidos");
  if (!st.isFile()) throw new Error(`La ruta del AppImage no es un archivo regular: ${real}`);
  return real;
}

// Genera el texto completo del archivo .desktop.
function contenidoDesktop({ rutaEjecutable, nombre, comentario, categorias, mimeTypes, icono = NOMBRE_ICONO, wmClass = NOMBRE_ICONO }) {
  if (!Array.isArray(mimeTypes) || mimeTypes.length === 0) throw new Error("Faltan tipos MIME");
  for (const m of mimeTypes) {
    if (typeof m !== "string" || !MIME_VALIDO.test(m)) throw new Error(`Tipo MIME no válido: ${m}`);
  }
  const cat = String(categorias || "AudioVideo;Audio;Video;Player").replace(/;+$/, "");
  if (CONTROL.test(cat)) throw new Error("Categorías no válidas");
  const lineas = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escaparCadena(nombre || "Reproductor")}`,
    `Comment=${escaparCadena(comentario || "Reproductor de música y video local")}`,
    `Exec=${escaparExec(rutaEjecutable)} %F`,
    `Icon=${escaparCadena(icono)}`,
    "Terminal=false",
    `Categories=${escaparCadena(cat)};`,
    `MimeType=${mimeTypes.join(";")};`,
    `StartupWMClass=${escaparCadena(wmClass)}`,
    "StartupNotify=false",
  ];
  return `${lineas.join("\n")}\n`;
}

// Escritura atómica en la misma carpeta (archivo temporal exclusivo + rename).
async function escribirAtomico(destino, contenido, modo = 0o644) {
  const dir = path.dirname(destino);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.${path.basename(destino)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.promises.writeFile(tmp, contenido, { flag: "wx", mode: modo });
    await fs.promises.rename(tmp, destino);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

// Actualiza la caché de aplicaciones de escritorio si update-desktop-database está disponible (sin shell).
function actualizarBaseEscritorio(dirAplicaciones) {
  return new Promise((resolve) => {
    execFile("update-desktop-database", [dirAplicaciones], { timeout: 5000 }, () => resolve());
  });
}

// Instala el .desktop y el icono para el AppImage actual ($APPIMAGE) dentro de XDG_DATA_HOME / ~/.local/share.
async function instalar({ env = process.env, raiz, actualizarBase = true } = {}) {
  const appImage = env.APPIMAGE;
  if (typeof appImage !== "string" || appImage.length === 0) {
    throw new Error("--instalar-escritorio solo sirve al ejecutar el AppImage (falta la variable APPIMAGE)");
  }
  const ejecutable = await validarEjecutable(appImage);
  const pkg = JSON.parse(await fs.promises.readFile(path.join(raiz, "package.json"), "utf8"));
  const iconoBytes = await fs.promises.readFile(path.join(raiz, "icon-512.png"));
  const datos = carpetaDatos(env);
  const dirAplicaciones = path.join(datos, "applications");
  const rutaEscritorio = path.join(dirAplicaciones, NOMBRE_ESCRITORIO);
  const rutaIcono = path.join(datos, "icons", "hicolor", "512x512", "apps", `${NOMBRE_ICONO}.png`);
  const contenido = contenidoDesktop({
    rutaEjecutable: ejecutable,
    nombre: pkg.build?.productName || NOMBRE_APP,
    comentario: pkg.description || "Reproductor de música y video local",
    categorias: pkg.build?.linux?.category || CATEGORIAS,
    mimeTypes: pkg.build?.linux?.mimeTypes || MIME_TYPES,
  });
  await escribirAtomico(rutaIcono, iconoBytes, 0o644);
  await escribirAtomico(rutaEscritorio, contenido, 0o644);
  if (actualizarBase) await actualizarBaseEscritorio(dirAplicaciones);
  return { escritorio: rutaEscritorio, icono: rutaIcono, ejecutable };
}

module.exports = {
  NOMBRE_ESCRITORIO,
  NOMBRE_ICONO,
  NOMBRE_APP,
  CATEGORIAS,
  MIME_TYPES,
  escaparCadena,
  escaparExec,
  carpetaDatos,
  validarEjecutable,
  contenidoDesktop,
  escribirAtomico,
  instalar,
};
