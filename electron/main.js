// Proceso principal de la app de escritorio (Electron). Sirve la misma interfaz que la versión web
// desde el protocolo propio app://reproductor/ en una ventana endurecida.
"use strict";

const { app, BrowserWindow, Menu, ipcMain, protocol, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { analizar } = require("./lib/argumentos");
const servir = require("./lib/servir");

const RAIZ = path.join(__dirname, "..");
const args = analizar(process.argv, { empaquetada: app.isPackaged });
const SMOKE_LIMITE_MS = 10 * 60 * 1000;

// La prueba de humo vacía la base de datos: nunca sobre la carpeta de datos real.
if (args.smoke && !args.datos) {
  console.error("--smoke exige --user-data-dir=<carpeta temporal> (usa «npm run smoke:app»)");
  process.exit(2);
}
if (args.datos) app.setPath("userData", args.datos);

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

/* ---------- Protocolo app://reproductor/ ---------- */

const lista = servir.listaBlanca(fs.readFileSync(path.join(RAIZ, "sw.js"), "utf8"), { smoke: args.smoke });
const csp = servir.cspDeHtml(fs.readFileSync(path.join(RAIZ, "index.html"), "utf8"));
if (!csp) throw new Error("index.html no tiene CSP");

async function manejarPeticion(req) {
  const r = servir.resolver(req.url, req.method, lista);
  if (r.estado !== 200) return new Response(null, { status: r.estado });
  // __media/<id>: lo implementa T2.1 (Range propio con FileHandle, solo ids registrados). De momento, nada.
  if (r.medio) return new Response(null, { status: 404 });
  let datos;
  try { datos = await fs.promises.readFile(path.join(RAIZ, r.rel)); } catch { return new Response(null, { status: 404 }); }
  return new Response(req.method === "HEAD" ? null : datos, { status: 200, headers: servir.cabeceras(r.rel, csp) });
}

/* ---------- Endurecimiento ---------- */

// Solo «fullscreen» (pantalla completa del video). Nada de micrófono, cámara, notificaciones, etc.
function endurecerSesion(ses) {
  ses.setPermissionRequestHandler((_wc, permiso, responder) => responder(permiso === "fullscreen"));
  ses.setPermissionCheckHandler((_wc, permiso) => permiso === "fullscreen");
}

app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e, url) => { if (!servir.esUrlDeApp(url)) e.preventDefault(); });
  contents.on("will-redirect", (e, url) => { if (!servir.esUrlDeApp(url)) e.preventDefault(); });
  contents.on("will-attach-webview", (e) => e.preventDefault());
});

// Todo manejador IPC pasa por aquí: solo responde a la página de la app (no a iframes ni a otros orígenes).
function deLaApp(event) {
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame && servir.esUrlDeApp(frame.url);
}

function cablearIpc() {
  ipcMain.on("reproductor:info", (event) => {
    event.returnValue = deLaApp(event) ? { version: app.getVersion() } : null;
  });
}

/* ---------- Ventana ---------- */

function crearVentana() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    show: false,
    backgroundColor: "#111111",
    icon: path.join(RAIZ, "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      // TE.0: así el AudioContext nace «running» y «Abrir con…» suena sin clic previo.
      // play() sigue comprobando que el contexto esté activo (no debe «sonar» en silencio).
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: !args.smoke,
    },
  });
  return win;
}

/* ---------- Prueba de humo (npm run smoke:app) ---------- */

async function correrSmoke(win) {
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") console.error(`[página] ${e.message}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => { console.error(`renderer caído: ${d.reason}`); app.exit(1); });
  await win.loadURL(`${servir.ORIGEN}/tests/smoke.html`);
  const fin = Date.now() + SMOKE_LIMITE_MS;
  let estado = null;
  while (Date.now() < fin) {
    await new Promise((r) => setTimeout(r, 500));
    estado = await win.webContents.executeJavaScript("({ done: window.__done === true, results: window.__results || [] })", true);
    if (estado.done) break;
  }
  const resultados = estado?.results || [];
  const fallos = resultados.filter((r) => !r.ok);
  for (const r of resultados) console.log(`${r.ok ? "ok  " : "FALLO"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  if (!estado?.done) console.log(`FALLO: la prueba de humo no terminó en ${SMOKE_LIMITE_MS / 1000} s`);
  console.log(`\n${resultados.length - fallos.length}/${resultados.length} correctas`);
  app.exit(estado?.done && resultados.length > 0 && fallos.length === 0 ? 0 : 1);
}

/* ---------- Arranque ---------- */

app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  endurecerSesion(session.defaultSession);
  protocol.handle("app", manejarPeticion);
  cablearIpc();
  const win = crearVentana();
  if (args.smoke) {
    correrSmoke(win).catch((e) => { console.error(e); app.exit(1); });
    return;
  }
  win.once("ready-to-show", () => win.show());
  win.loadURL(`${servir.ORIGEN}/index.html`);
});

app.on("window-all-closed", () => app.quit());
