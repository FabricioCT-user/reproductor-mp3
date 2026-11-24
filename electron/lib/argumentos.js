// Argumentos de la línea de órdenes del proceso principal. Sin Electron: se prueba con node:test.
"use strict";

const path = require("node:path");

// argv: process.argv completo. empaquetada: app.isPackaged.
// - En desarrollo (`electron . …`) argv[1] es la carpeta de la app; empaquetada, argv[1] ya es un argumento.
// - --smoke: carga la prueba de humo (solo en desarrollo: el paquete no lleva tests/).
// - --instalar-escritorio: instala el archivo .desktop y el icono para el AppImage en ~/.local/share y sale.
// - --user-data-dir=<ruta>: carpeta absoluta o relativa al cwd. Chromium no admite valor separado.
//   La usa smoke:app con una temporal explícita.
// - El resto de opciones (--algo, incluidas las de Chromium) se ignoran; lo que no empieza por - son archivos (TE.2).
//   Tras «--» todo son archivos.
function analizar(argv, { empaquetada = false, cwd = process.cwd() } = {}) {
  const res = { smoke: false, instalarEscritorio: false, datos: null, errorDatos: null, archivos: [] };
  let soloArchivos = false;
  const argumentos = argv.slice(empaquetada ? 1 : 2);
  for (let i = 0; i < argumentos.length; i++) {
    const a = argumentos[i];
    if (typeof a !== "string" || a === "") continue;
    if (soloArchivos || !a.startsWith("-")) { res.archivos.push(a); continue; }
    if (a === "--") { soloArchivos = true; continue; }
    if (a === "--smoke") { if (!empaquetada) res.smoke = true; continue; }
    if (a === "--instalar-escritorio") { res.instalarEscritorio = true; continue; }
    if (a === "--user-data-dir") {
      res.errorDatos = "--user-data-dir requiere el formato --user-data-dir=<ruta>";
      continue;
    }
    if (a.startsWith("--user-data-dir=")) {
      const valor = a.slice("--user-data-dir=".length);
      if (!valor) res.errorDatos = "--user-data-dir requiere una ruta no vacía";
      else res.datos = path.resolve(cwd, valor);
    }
  }
  return res;
}

module.exports = { analizar };
