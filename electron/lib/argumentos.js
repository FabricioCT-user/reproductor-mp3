// Argumentos de la línea de órdenes del proceso principal. Sin Electron: se prueba con node:test.
"use strict";

const path = require("node:path");

// argv: process.argv completo. empaquetada: app.isPackaged.
// - En desarrollo (`electron . …`) argv[1] es la carpeta de la app; empaquetada, argv[1] ya es un argumento.
// - --smoke: carga la prueba de humo (solo en desarrollo: el paquete no lleva tests/).
// - --instalar-escritorio: instala el archivo .desktop y el icono para el AppImage en ~/.local/share y sale.
// - --user-data-dir=<ruta absoluta>: carpeta de datos (la usa smoke:app con una temporal).
// - El resto de opciones (--algo, incluidas las de Chromium) se ignoran; lo que no empieza por - son archivos (TE.2).
//   Tras «--» todo son archivos.
function analizar(argv, { empaquetada = false } = {}) {
  const res = { smoke: false, instalarEscritorio: false, datos: null, archivos: [] };
  let soloArchivos = false;
  for (const a of argv.slice(empaquetada ? 1 : 2)) {
    if (typeof a !== "string" || a === "") continue;
    if (soloArchivos || !a.startsWith("-")) { res.archivos.push(a); continue; }
    if (a === "--") { soloArchivos = true; continue; }
    if (a === "--smoke") { if (!empaquetada) res.smoke = true; continue; }
    if (a === "--instalar-escritorio") { res.instalarEscritorio = true; continue; }
    const m = /^--user-data-dir=(.+)$/.exec(a);
    if (m && path.isAbsolute(m[1])) res.datos = path.normalize(m[1]);
  }
  return res;
}

module.exports = { analizar };
