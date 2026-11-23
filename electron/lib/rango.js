// Cabecera HTTP Range → qué trozo del archivo servir. Sin Electron: se prueba con node:test.
// Solo bytes y un rango: si llegan varios se sirve el primero que se pueda satisfacer (los navegadores piden uno).
"use strict";

const NUMERO = /^\d{1,16}$/;
const num = (s) => (NUMERO.test(s) ? Number(s) : NaN);

// (cabecera, tamaño) → { estado: 200 } (archivo entero: sin Range o con una unidad desconocida, que se ignora),
// { estado: 206, inicio, fin } (fin incluido) o { estado: 416 } (mal formado o fuera del archivo).
function analizar(cabecera, tamano) {
  if (typeof cabecera !== "string" || cabecera.trim() === "") return { estado: 200 };
  const m = /^\s*([a-z]+)\s*=(.*)$/i.exec(cabecera);
  if (!m) return { estado: 416 };
  if (m[1].toLowerCase() !== "bytes") return { estado: 200 }; // RFC 9110: una unidad que no se conoce se ignora
  const partes = m[2].split(",").map((p) => p.trim());
  if (!partes.length || partes.some((p) => !/^\d*-\d*$/.test(p) || p === "-")) return { estado: 416 };
  for (const p of partes) {
    const r = uno(p, tamano);
    if (r) return { estado: 206, ...r };
  }
  return { estado: 416 };
}

// «a-b», «a-» o «-n» → { inicio, fin } dentro del archivo, o null si no se puede satisfacer.
function uno(p, tamano) {
  const [a, b] = p.split("-");
  if (a === "") { // sufijo: los últimos n bytes
    const n = num(b);
    if (!(n > 0) || tamano === 0) return null;
    return { inicio: Math.max(0, tamano - n), fin: tamano - 1 };
  }
  const inicio = num(a);
  const fin = b === "" ? tamano - 1 : num(b);
  if (!Number.isSafeInteger(inicio) || !Number.isSafeInteger(fin) || fin < inicio || inicio >= tamano) return null;
  return { inicio, fin: Math.min(fin, tamano - 1) };
}

// Resultado de analizar → cabeceras de la respuesta (sin el cuerpo).
function cabeceras(r, tamano, tipo) {
  const h = { "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  if (r.estado === 416) return { ...h, "Content-Range": `bytes */${tamano}` };
  h["Content-Type"] = tipo || "application/octet-stream";
  if (r.estado === 206) {
    h["Content-Range"] = `bytes ${r.inicio}-${r.fin}/${tamano}`;
    h["Content-Length"] = String(r.fin - r.inicio + 1);
  } else {
    h["Content-Length"] = String(tamano);
  }
  return h;
}

module.exports = { analizar, cabeceras };
