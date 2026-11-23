// Rutas de archivos que llegan del sistema (argv, segunda instancia, diálogo). Sin Electron: se prueba con node:test.
// Solo se aceptan archivos regulares (tras resolver enlaces simbólicos) con extensión de audio, video o acompañante
// (.lrc, .srt, .vtt). La ruta resultante se queda en el proceso principal: a la interfaz solo llegan ids.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

// Extensión → [clase, tipo MIME]. Las de audio coinciden con isAudio de src/util.js (una prueba lo vigila).
const EXTENSIONES = {
  ".mp3": ["audio", "audio/mpeg"],
  ".flac": ["audio", "audio/flac"],
  ".ogg": ["audio", "audio/ogg"],
  ".oga": ["audio", "audio/ogg"],
  ".opus": ["audio", "audio/ogg"],
  ".m4a": ["audio", "audio/mp4"],
  ".aac": ["audio", "audio/aac"],
  ".wav": ["audio", "audio/wav"],
  ".weba": ["audio", "audio/webm"],
  ".mp4": ["video", "video/mp4"],
  ".m4v": ["video", "video/x-m4v"],
  ".webm": ["video", "video/webm"],
  ".mkv": ["video", "video/x-matroska"],
  ".mov": ["video", "video/quicktime"],
  ".lrc": ["letra", "text/plain"],
  ".srt": ["subtitulo", "application/x-subrip"],
  ".vtt": ["subtitulo", "text/vtt"],
};

const LIMITES = { archivos: 5000, profundidad: 8 };

// Nombre de archivo → { clase, tipo } o null. «cancion.mp3.txt», «mp3» o «.mp3» (sin nombre) no valen.
function clasificar(nombre) {
  const base = path.basename(String(nombre));
  const ext = path.extname(base).toLowerCase();
  if (!ext || ext === base.toLowerCase()) return null;
  const e = Object.hasOwn(EXTENSIONES, ext) ? EXTENSIONES[ext] : null;
  return e ? { clase: e[0], tipo: e[1] } : null;
}

// Argumento (ruta absoluta, relativa a `cwd` o URL file://) → ruta absoluta normalizada, o null.
function aRuta(arg, cwd) {
  if (typeof arg !== "string" || arg === "" || arg.includes("\0")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
    // Solo file:// locales (sin host o «localhost»); http:, smb:, etc. no son archivos del disco.
    let u;
    try { u = new URL(arg); } catch { return null; }
    if (u.protocol !== "file:" || (u.host && u.host !== "localhost")) return null;
    try { return path.normalize(fileURLToPath(u)); } catch { return null; }
  }
  if (path.isAbsolute(arg)) return path.normalize(arg);
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  return path.resolve(cwd, arg);
}

// Ruta absoluta → { ruta (real), nombre, tamano, fecha (ms), tipo, clase } o null si no existe, no es un archivo
// regular o su extensión (la del destino, si es un enlace simbólico) no es de medio.
async function validar(ruta) {
  if (typeof ruta !== "string" || !path.isAbsolute(ruta)) return null;
  let real, st;
  try {
    real = await fs.promises.realpath(ruta);
    st = await fs.promises.stat(real);
  } catch { return null; }
  if (!st.isFile()) return null;
  const c = clasificar(real);
  if (!c) return null;
  return { ruta: real, nombre: path.basename(real), tamano: st.size, fecha: Math.floor(st.mtimeMs), tipo: c.tipo, clase: c.clase };
}

// Carpeta elegida en el diálogo → archivos válidos de dentro (subcarpetas incluidas), ordenados por ruta, cada uno con
// `rel` = «carpeta/sub/archivo» (para ordenar álbumes; nunca la ruta absoluta). No sigue enlaces a carpetas (evita
// bucles), salta lo oculto y para en `limites.archivos`. Los enlaces a archivos se aceptan si el destino es válido.
async function recorrer(carpeta, limites = LIMITES) {
  const raiz = await fs.promises.realpath(carpeta).catch(() => null);
  if (!raiz || !(await fs.promises.stat(raiz).catch(() => null))?.isDirectory()) return [];
  const encontrados = [];
  const vistos = new Set();
  const base = path.basename(raiz) || "carpeta";
  async function visitar(dir, rel, nivel) {
    let entradas;
    try { entradas = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entradas.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const e of entradas) {
      if (encontrados.length >= limites.archivos) return;
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (nivel < limites.profundidad) await visitar(abs, `${rel}/${e.name}`, nivel + 1);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (!clasificar(e.name)) continue; // ni se mira el destino de lo que no parece un medio
      const v = await validar(abs);
      if (!v || vistos.has(v.ruta)) continue;
      vistos.add(v.ruta);
      encontrados.push({ ...v, rel: `${rel}/${v.nombre}` });
    }
  }
  await visitar(raiz, base, 1);
  return encontrados;
}

// Tope de lo que se copia a la memoria para pasarlo a la interfaz (el audio se guarda entero en IndexedDB).
const MAX_LECTURA = 1024 * 1024 * 1024;
const MAX_SUBTITULO = 5 * 1024 * 1024;
const MAX_SUBTITULOS_POR_VIDEO = 32;

// Busca subtítulos acompañantes (.srt / .vtt) de un video ya validado en SU MISMA carpeta:
// nombre.srt, nombre.*.srt, nombre.vtt, nombre.*.vtt. Valida cada archivo, exige que el destino real
// viva en la misma carpeta y aplica tope de tamaño y cantidad.
async function subtitulosAcompanantes(rutaVideo, { maxArchivos = MAX_SUBTITULOS_POR_VIDEO, maxTamano = MAX_SUBTITULO } = {}) {
  if (typeof rutaVideo !== "string" || !path.isAbsolute(rutaVideo)) return [];
  const realVideo = await fs.promises.realpath(rutaVideo).catch(() => null);
  if (!realVideo) return [];
  const dir = path.dirname(realVideo);
  const nombreVideo = path.basename(realVideo);
  const extVideo = path.extname(nombreVideo);
  const base = nombreVideo.slice(0, nombreVideo.length - extVideo.length).toLowerCase();
  if (!base) return [];

  let entradas;
  try { entradas = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  entradas.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const encontrados = [];
  const vistos = new Set();
  for (const e of entradas) {
    if (encontrados.length >= maxArchivos) break;
    if (e.name.startsWith(".")) continue;
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const c = clasificar(e.name);
    if (!c || c.clase !== "subtitulo") continue;
    const stem = e.name.slice(0, e.name.length - path.extname(e.name).length).toLowerCase();
    if (stem !== base && !stem.startsWith(base + ".")) continue;
    const v = await validar(path.join(dir, e.name));
    if (!v || v.clase !== "subtitulo") continue;
    if (path.dirname(v.ruta) !== dir) continue;
    if (v.tamano > maxTamano) continue;
    if (vistos.has(v.ruta)) continue;
    vistos.add(v.ruta);
    encontrados.push(v);
  }
  return encontrados;
}

// Lee entera una ruta ya validada (real). O_NOFOLLOW: si entre medias alguien la cambió por un enlace simbólico, falla;
// y se vuelve a comprobar que sea un archivo regular y que quepa.
async function leer(ruta, { limite = MAX_LECTURA } = {}) {
  const fh = await fs.promises.open(ruta, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("no es un archivo");
    if (st.size > limite) throw new Error("demasiado grande");
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

module.exports = {
  EXTENSIONES, LIMITES, MAX_LECTURA, MAX_SUBTITULO, MAX_SUBTITULOS_POR_VIDEO,
  clasificar, aRuta, validar, recorrer, subtitulosAcompanantes, leer,
};
