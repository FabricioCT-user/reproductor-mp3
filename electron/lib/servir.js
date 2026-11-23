// Protocolo app://reproductor/: decide qué se sirve y con qué cabeceras. Sin Electron: se prueba con node:test.
// Solo se sirven los archivos de la app (lista blanca derivada de FILES de sw.js + index.html); todo lo demás es 404.
"use strict";

const ORIGEN = "app://reproductor";
const HOST = "reproductor";

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Archivos extra que solo existen con --smoke (prueba de humo en Electron; nunca en el paquete).
const PRUEBAS = ["tests/smoke.html", "tests/smoke.js"];

const extension = (rel) => { const m = /\.[a-z0-9]+$/i.exec(rel); return m ? m[0].toLowerCase() : ""; };
const tipoDe = (rel) => TIPOS[extension(rel)] || "application/octet-stream";

// FILES de sw.js (texto del archivo) → conjunto de rutas relativas. "./" es index.html.
function listaBlanca(swTexto, { smoke = false } = {}) {
  const bloque = /const FILES = \[([^\]]*)\]/.exec(swTexto);
  if (!bloque) throw new Error("sw.js no tiene la lista FILES");
  const lista = new Set(["index.html"]);
  for (const [, f] of bloque[1].matchAll(/"([^"]+)"/g)) {
    if (f === "./") continue;
    lista.add(f.replace(/^\.\//, ""));
  }
  if (smoke) for (const f of PRUEBAS) lista.add(f);
  return lista;
}

// CSP del meta de index.html, para repetirla como cabecera (defensa en profundidad, idéntica).
function cspDeHtml(html) {
  return /<meta http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? null;
}

// ¿La URL es de la app? (Node trata app: como esquema no especial: origin vale "null", se compara a mano.)
function esUrlDeApp(url) {
  try {
    const u = new URL(url);
    return u.protocol === "app:" && u.host === HOST && !u.username && !u.password && !u.port;
  } catch { return false; }
}

const ID_MEDIO = /^[0-9a-f]{32}$/;

// Petición → { estado, rel?, tipo? } para archivos de la app, { estado, medio } para __media/<id> (T2.1).
function resolver(url, metodo, lista) {
  if (metodo !== "GET" && metodo !== "HEAD") return { estado: 405 };
  if (!esUrlDeApp(url)) return { estado: 404 };
  const crudo = new URL(url).pathname;
  let rel;
  try { rel = decodeURIComponent(crudo); } catch { return { estado: 400 }; }
  rel = rel.replace(/^\//, "");
  if (rel === "") rel = "index.html";
  // La lista blanca ya rechaza todo lo demás; esto es una segunda barrera por si alguien la amplía mal.
  if (rel.includes("..") || rel.includes("\\") || rel.includes("\0") || rel.startsWith("/") || /^[a-z]:/i.test(rel)) return { estado: 404 };
  const medio = /^__media\/(.*)$/.exec(rel);
  if (medio) return ID_MEDIO.test(medio[1]) ? { estado: 200, medio: medio[1] } : { estado: 404 };
  if (!lista.has(rel)) return { estado: 404 };
  return { estado: 200, rel, tipo: tipoDe(rel) };
}

// Cabeceras de un archivo de la app. Las páginas de prueba (tests/) van sin CSP: la prueba de humo necesita eval.
function cabeceras(rel, csp) {
  const h = { "Content-Type": tipoDe(rel), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" };
  if (csp && !rel.startsWith("tests/")) h["Content-Security-Policy"] = csp;
  return h;
}

module.exports = { ORIGEN, PRUEBAS, listaBlanca, cspDeHtml, esUrlDeApp, resolver, cabeceras, tipoDe };
