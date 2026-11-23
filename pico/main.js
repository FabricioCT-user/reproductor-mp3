// Pico TE.0 (rama desechable app/te0-pico): proceso principal mínimo.
// Esquema app://reproductor/ que sirve la app y __media/<id> con Range.
// Variables: PICO_MEDIOS (carpeta de videos), PICO_DATOS (userData),
// PICO_RANGO = "propio" (fs.createReadStream + 206) | "net" (net.fetch(file://)),
// PICO_FASE (ver medir.js), PICO_SALIDA (JSON de resultados).
"use strict";
const { app, BrowserWindow, protocol, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const RAIZ = path.resolve(__dirname, "..");
const MEDIOS = process.env.PICO_MEDIOS || "";
const MODO = process.env.PICO_RANGO || "propio";
if (process.env.PICO_DATOS) app.setPath("userData", process.env.PICO_DATOS);

const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska" };
const tipo = (p) => TIPOS[path.extname(p).toLowerCase()] || "application/octet-stream";
const stats = { peticiones: 0, bytes: 0, rangos: [] };

protocol.registerSchemesAsPrivileged([{ scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Range: un solo rango; bytes=a-b, a-, -n. null = 416.
function rango(cab, tam) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(cab || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let a, b;
  if (m[1] === "") { a = Math.max(0, tam - Number(m[2])); b = tam - 1; }
  else { a = Number(m[1]); b = m[2] === "" ? tam - 1 : Math.min(Number(m[2]), tam - 1); }
  return a > b || a >= tam ? null : { a, b };
}

function servirMedio(req, ruta) {
  const tam = fs.statSync(ruta).size;
  const cab = req.headers.get("range");
  stats.peticiones++; stats.rangos.push(cab || "(sin Range)");
  if (MODO === "net") return net.fetch(pathToFileURL(ruta).href, { headers: req.headers, bypassCustomProtocolHandlers: true });
  const base = { "Content-Type": tipo(ruta), "Accept-Ranges": "bytes" };
  let r = { a: 0, b: tam - 1 }, status = 200;
  if (cab) {
    r = rango(cab, tam);
    if (!r) return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${tam}` } });
    status = 206; base["Content-Range"] = `bytes ${r.a}-${r.b}/${tam}`;
  }
  const flujo = fs.createReadStream(ruta, { start: r.a, end: r.b });
  flujo.on("data", (c) => { stats.bytes += c.length; });
  return new Response(Readable.toWeb(flujo), { status, headers: { ...base, "Content-Length": String(r.b - r.a + 1) } });
}

function manejar(req) {
  const u = new URL(req.url);
  if (u.host !== "reproductor") return new Response(null, { status: 404 });
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "") || "index.html";
  const m = /^__media\/([\w.-]+)$/.exec(rel);
  if (m) {
    const ruta = path.join(MEDIOS, m[1]);
    return MEDIOS && fs.existsSync(ruta) ? servirMedio(req, ruta) : new Response(null, { status: 404 });
  }
  const ruta = path.resolve(RAIZ, rel);
  if (!ruta.startsWith(RAIZ + path.sep) || rel.includes("..") || !fs.existsSync(ruta) || !fs.statSync(ruta).isFile())
    return new Response(null, { status: 404 });
  return new Response(fs.readFileSync(ruta), { headers: { "Content-Type": tipo(ruta) } });
}

app.whenReady().then(() => {
  protocol.handle("app", manejar);
  const win = new BrowserWindow({ width: 900, height: 650, show: process.env.PICO_MOSTRAR === "1",
    webPreferences: { preload: path.join(__dirname, "preload.js"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" } });
  require("./medir.js")(win, { stats, modo: MODO, medios: MEDIOS });
  win.loadURL("app://reproductor/index.html");
});
app.on("window-all-closed", () => app.quit());
