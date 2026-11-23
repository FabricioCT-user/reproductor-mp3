// app://reproductor/__media/<id>: sirve un video enlazado con Range propio. Sin Electron: se prueba con node:test.
// Se lee por trozos con FileHandle.read desde un ReadableStream con pull(): solo se lee lo que el consumidor pide
// (contrapresión real, sin la lectura anticipada de ~40 MB de Readable.toWeb que midió TE.0) y el descriptor se
// cierra al terminar, al fallar o cuando el reproductor cancela la petición (cancel(), p. ej. al saltar).
"use strict";

const fs = require("node:fs");
const rango = require("./rango");
const { clasificar, abrirSeguro } = require("./rutas");

const TROZO = 512 * 1024;

// FileHandle abierto, [inicio, fin] (fin incluido) → ReadableStream de Uint8Array. Cierra fh siempre, una vez.
function flujo(fh, inicio, fin, trozo = TROZO) {
  let pos = inicio;
  let cerrado = false;
  const cerrar = () => { if (cerrado) return Promise.resolve(); cerrado = true; return fh.close().catch(() => {}); };
  return new ReadableStream({
    async pull(controller) {
      const quedan = fin - pos + 1;
      if (quedan <= 0 || cerrado) { await cerrar(); controller.close(); return; }
      const buf = Buffer.allocUnsafe(Math.min(trozo, quedan));
      let n;
      try { ({ bytesRead: n } = await fh.read(buf, 0, buf.length, pos)); } catch (e) { await cerrar(); controller.error(e); return; }
      if (cerrado) return; // se canceló mientras se leía
      if (n === 0) { await cerrar(); controller.close(); return; } // el archivo se acortó: se termina antes
      pos += n;
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, n));
      if (pos > fin) { await cerrar(); controller.close(); }
    },
    cancel: cerrar,
  }, { highWaterMark: 1 });
}

// (entrada del registro o null, método, cabecera Range) → { estado, cabeceras, cuerpo? }.
// Nunca lanza: lo que no se puede abrir es 404. abrirSeguro impide symlinks (O_NOFOLLOW), FIFOs (O_NONBLOCK + fstat) y carpetas.
async function servir(entrada, metodo, cabeceraRange, { trozo = TROZO } = {}) {
  if (metodo !== "GET" && metodo !== "HEAD") return { estado: 405, cabeceras: {} };
  if (!entrada) return { estado: 404, cabeceras: {} };
  let fh;
  try {
    let st;
    ({ fh, st } = await abrirSeguro(entrada.ruta, entrada.identidad));
    const r = rango.analizar(cabeceraRange, st.size);
    const cab = rango.cabeceras(r, st.size, clasificar(entrada.ruta)?.tipo); // por extensión
    if (r.estado === 416 || metodo === "HEAD" || st.size === 0) {
      await fh.close();
      return { estado: r.estado, cabeceras: cab, cuerpo: null };
    }
    const [inicio, fin] = r.estado === 206 ? [r.inicio, r.fin] : [0, st.size - 1];
    return { estado: r.estado, cabeceras: cab, cuerpo: flujo(fh, inicio, fin, trozo) };
  } catch {
    await fh?.close().catch(() => {});
    return { estado: 404, cabeceras: {} };
  }
}

module.exports = { TROZO, flujo, servir };
