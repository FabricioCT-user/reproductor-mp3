// Proceso principal de la app de escritorio (Electron). Sirve la misma interfaz que la versión web
// desde el protocolo propio app://reproductor/ en una ventana endurecida.
"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analizar } = require("./lib/argumentos");
const { Enlaces } = require("./lib/enlaces");
const { Entregas } = require("./lib/entregas");
const medios = require("./lib/medios");
const rutas = require("./lib/rutas");
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

// Una sola instancia por carpeta de datos: si ya hay una abierta, le pasa sus archivos («second-instance») y se cierra.
const primera = app.requestSingleInstanceLock();
if (!primera) app.quit();

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

/* ---------- Protocolo app://reproductor/ ---------- */

const lista = servir.listaBlanca(fs.readFileSync(path.join(RAIZ, "sw.js"), "utf8"), { smoke: args.smoke });
const csp = servir.cspDeHtml(fs.readFileSync(path.join(RAIZ, "index.html"), "utf8"));
if (!csp) throw new Error("index.html no tiene CSP");

// Registro de videos enlazados (userData/enlaces.json). Se carga al arrancar; las peticiones lo esperan.
let enlaces = null;
let enlacesListos = null;

async function manejarPeticion(req) {
  const r = servir.resolver(req.url, req.method, lista);
  if (r.estado !== 200) return new Response(null, { status: r.estado });
  // __media/<id>: solo ids registrados; Range propio leyendo por trozos (medios.js).
  if (r.medio) {
    const reg = await enlacesListos;
    const m = await medios.servir(reg.obtener(r.medio), req.method, req.headers.get("range"));
    return new Response(m.cuerpo ?? null, { status: m.estado, headers: m.cabeceras });
  }
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

/* ---------- Abrir archivos del sistema ---------- */

// argv al arrancar, una segunda instancia («Abrir con…» con la app abierta) o el diálogo. La interfaz nunca ve rutas:
// recibe ids (entregas.js) y pide los bytes del audio con «reproductor:leer».
const entregas = new Entregas();
let ventana = null;
let porAbrir = []; // lo que llegó del sistema y la interfaz aún no ha recogido (p. ej. al arrancar, antes de cargar)

async function registrar(argumentos, cwd) {
  const items = [];
  for (const a of argumentos) {
    const v = await rutas.validar(rutas.aRuta(a, cwd));
    if (v) items.push(entregas.registrar(v));
  }
  return items;
}

// Se avisa a la página; ella recoge los pendientes cuando está lista (si aún no lo está, los pide al cargar).
function abrirEnLaApp(items) {
  if (!items.length) return;
  porAbrir.push(...items);
  if (ventana && !ventana.isDestroyed()) ventana.webContents.send("reproductor:hay-archivos");
}

function enfocar() {
  if (!ventana || ventana.isDestroyed()) return;
  if (ventana.isMinimized()) ventana.restore();
  ventana.show();
  ventana.focus();
}

app.on("second-instance", (_e, argv, cwd) => {
  enfocar();
  registrar(analizar(argv, { empaquetada: app.isPackaged }).archivos, cwd).then(abrirEnLaApp).catch((e) => console.error(e));
});

// Diálogo nativo. En Linux y Windows no puede elegir a la vez archivos y carpetas: son dos modos.
// En la prueba de humo no se puede manejar un diálogo nativo: devuelve la carpeta de los archivos de argv.
async function elegir(carpeta) {
  let r;
  if (args.smoke) {
    const primero = rutas.aRuta(args.archivos[0], process.cwd());
    r = { canceled: !primero, filePaths: primero ? [carpeta ? path.dirname(primero) : primero] : [] };
  } else {
    const extensiones = Object.keys(rutas.EXTENSIONES).map((e) => e.slice(1));
    r = await dialog.showOpenDialog(ventana, carpeta
      ? { title: "Añadir carpeta", properties: ["openDirectory", "multiSelections"] }
      : { title: "Añadir archivos", properties: ["openFile", "multiSelections"], filters: [{ name: "Audio, video y letras", extensions: extensiones }] });
  }
  if (r.canceled) return [];
  const items = [];
  for (const p of r.filePaths) {
    if (carpeta) for (const v of await rutas.recorrer(p)) items.push(entregas.registrar(v));
    else items.push(...(await registrar([p], process.cwd())));
  }
  return items;
}

// Video que la persona eligió → enlace persistente. Llega como id de una entrega (argv, segunda instancia, diálogo)
// o como ruta que el preload sacó de un File con webUtils.getPathForFile (arrastrar, <input>). Solo videos válidos.
async function enlazar(x) {
  let ruta = null;
  if (typeof x?.entrega === "string") ruta = entregas.tomar(x.entrega, ["video"])?.ruta ?? null;
  else if (typeof x?.ruta === "string") ruta = rutas.aRuta(x.ruta, null); // solo absolutas
  if (!ruta) return null;
  const v = await rutas.validar(ruta);
  if (!v || v.clase !== "video") return null;
  const reg = await enlacesListos;
  const linkId = await reg.registrar(v);
  return { linkId, name: v.nombre, size: v.tamano, lastModified: v.fecha, type: v.tipo };
}

function cablearIpc() {
  ipcMain.on("reproductor:info", (event) => {
    event.returnValue = deLaApp(event) ? { version: app.getVersion() } : null;
  });
  ipcMain.handle("reproductor:pendientes", (event) => {
    if (!deLaApp(event)) return [];
    return porAbrir.splice(0);
  });
  ipcMain.handle("reproductor:elegir", async (event, opciones) => {
    if (!deLaApp(event)) return [];
    return elegir(opciones?.carpeta === true);
  });
  // Bytes de un archivo entregado (audio, letra, subtítulos; nunca video), o null. Cada id sirve una sola vez.
  ipcMain.handle("reproductor:leer", async (event, id) => {
    if (!deLaApp(event)) return null;
    const e = entregas.tomar(id);
    if (!e) return null; // inventado, caducado, ya leído o un video
    return rutas.leer(e.ruta).catch(() => null); // ya no está, es otra cosa o es demasiado grande
  });
  ipcMain.handle("reproductor:enlazar", async (event, x) => {
    if (!deLaApp(event)) return null;
    return enlazar(x).catch(() => null);
  });
  ipcMain.handle("reproductor:olvidar", async (event, id) => {
    if (!deLaApp(event)) return false;
    return (await enlacesListos).olvidar(id).catch(() => false);
  });
  ipcMain.handle("reproductor:estado-enlaces", async (event, ids) => {
    if (!deLaApp(event)) return {};
    return (await enlacesListos).estado(ids).catch(() => ({}));
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
  const resultados = [...(estado?.results || []), ...(await comprobacionesAbrir(win)), ...(await comprobacionesApp(win))];
  const fallos = resultados.filter((r) => !r.ok);
  for (const r of resultados) console.log(`${r.ok ? "ok  " : "FALLO"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  if (!estado?.done) console.log(`FALLO: la prueba de humo no terminó en ${SMOKE_LIMITE_MS / 1000} s`);
  console.log(`\n${resultados.length - fallos.length}/${resultados.length} correctas`);
  app.exit(estado?.done && resultados.length > 0 && fallos.length === 0 ? 0 : 1);
}

// Abrir archivos del sistema (TE.2). smoke-app.js lanza la app con archivos en argv: dos WAV válidos (uno con
// espacios y como file://), uno que no existe, uno con extensión falsa y un video, y deja «tres.wav» en la misma carpeta
// para la segunda instancia. smoke.html no recoge los archivos (no llama a onAbrir): los recoge index.html al cargar.
async function comprobacionesAbrir(win) {
  const r = [];
  const check = (name, ok, detail) => r.push({ name: `App, abrir: ${name}`, ok: !!ok, detail: ok ? "" : JSON.stringify(detail) });
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  const hasta = async (js, ms = 8000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { if (await ev(js)) return true; await new Promise((res) => setTimeout(res, 100)); }
    return false;
  };
  const sonando = (nombre) => `(() => { const t = state.tracks[state.index]; return !!t && t.fileName === ${JSON.stringify(nombre)}
    && !media.paused && media.currentTime > 0.3 && analyser?.context.state === "running"; })()`;
  const estado = () => ev(`({ nombres: state.tracks.map((t) => t.fileName), actual: state.tracks[state.index]?.fileName,
    cola: state.queue.map((t) => t.fileName), pausado: media.paused, t: media.currentTime, ctx: analyser?.context.state,
    aviso: els.toast.hidden ? "" : els.toast.textContent })`);
  try {
    await win.loadURL(`${servir.ORIGEN}/index.html`);
    await ev("appReady.then(() => 1)");
    const ok = await hasta(sonando("uno.wav"));
    let d = await estado();
    check("los dos archivos de argv entran en la biblioteca y suena el primero (con sonido, no mudo)",
      ok && d.nombres.includes("uno.wav") && d.nombres.includes("dos con espacios ñ.wav") && !/bloque/i.test(d.aviso), d);
    check("el segundo queda en la cola", d.cola[0] === "dos con espacios ñ.wav", d.cola);
    check("ni el que no existe, ni la extensión falsa, ni el video (aún) entran", !d.nombres.some((n) => /nota|video|no-existe/.test(n)), d.nombres);
    check("la letra que acompaña al audio se asocia", await ev(`!!state.tracks.find((t) => t.fileName === "uno.wav")?.userLyrics`), d);

    // Segunda instancia real: otra app con la misma carpeta de datos le pasa su archivo a esta y se cierra.
    const { spawn } = require("node:child_process");
    const tres = path.join(path.dirname(rutas.aRuta(args.archivos[0], process.cwd())), "tres.wav");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const codigo = await new Promise((res) => {
      const hijo = spawn(process.execPath, [RAIZ, `--user-data-dir=${args.datos}`, tres], { stdio: "ignore", env });
      const t = setTimeout(() => { hijo.kill(); res("no se cerró"); }, 20000);
      hijo.on("exit", (c) => { clearTimeout(t); res(c); });
    });
    const ok2 = await hasta(sonando("tres.wav"));
    d = await estado();
    check("una segunda instancia entrega su archivo a la abierta, suena y se cierra sola", codigo === 0 && ok2, { codigo, d });
    await ev("media.pause(); 1");

    // La API del puente: nunca rutas; ids de un solo uso; los videos no se leen; ids inventados fallan.
    const api = await ev(`(async () => {
      const items = await window.reproductor.elegirArchivos({ carpeta: true });
      const falla = async (p) => (await p) === null;
      const audio = items.find((i) => i.kind === "audio");
      const video = items.find((i) => i.kind === "video");
      const bytes = await window.reproductor.leer(audio.id);
      return { items, json: JSON.stringify(items), bytes: bytes.length, esBytes: bytes instanceof Uint8Array,
        repetido: await falla(window.reproductor.leer(audio.id)), video: !!video && await falla(window.reproductor.leer(video.id)),
        inventado: await falla(window.reproductor.leer("0".repeat(32))), raro: await falla(window.reproductor.leer({ id: 1 })) };
    })()`);
    const carpeta = path.dirname(tres);
    check("elegir una carpeta da archivos con id y ruta relativa, sin rutas absolutas", api.items.length >= 5 && !api.json.includes(carpeta)
      && !api.json.includes(os.tmpdir()) && api.items.every((i) => /^[0-9a-f]{32}$/.test(i.id) && i.rel.startsWith(path.basename(carpeta) + "/")), api.items);
    check("leer devuelve los bytes una sola vez; videos e ids inventados no se leen", api.esBytes && api.bytes > 1000 && api.repetido && api.video && api.inventado && api.raro, api);
    const antes = (await estado()).nombres.length;
    await ev(`els["folder-input"].closest("label").click(); 1`);
    const ok3 = await hasta(`state.tracks.some((t) => t.fileName === "cuatro.wav")`);
    d = await estado();
    check("«+ Carpeta» usa el diálogo de la app y añade lo nuevo (subcarpetas) sin duplicar", ok3 && d.nombres.length === antes + 1, { antes, d });
  } catch (e) {
    check("comprobaciones sin excepciones", false, String(e?.stack || e));
  }
  return r;
}

// Lo que solo existe en la app: se carga la página real (con su CSP) y se comprueba el endurecimiento desde dentro.
async function comprobacionesApp(win) {
  const r = [];
  const check = (name, ok, detail) => r.push({ name: `App: ${name}`, ok: !!ok, detail: ok ? "" : JSON.stringify(detail) });
  try {
    await win.loadURL(`${servir.ORIGEN}/index.html`);
    const d = await win.webContents.executeJavaScript(`(async () => {
      const estado = async (u) => { try { return (await fetch(u)).status; } catch (e) { return String(e); } };
      let sw = 0; try { sw = (await navigator.serviceWorker.getRegistrations()).length; } catch {}
      let evalBloqueado = false; try { (0, eval)("1"); } catch { evalBloqueado = true; }
      const cab = await fetch("index.html");
      return {
        puente: window.reproductor ? { esApp: window.reproductor.esApp, version: window.reproductor.version, congelado: Object.isFrozen(window.reproductor) } : null,
        sinNode: typeof require === "undefined" && typeof process === "undefined" && typeof module === "undefined",
        ventanaNueva: window.open("https://example.com/"),
        notificaciones: await Notification.requestPermission(),
        sw, evalBloqueado,
        csp: cab.headers.get("content-security-policy"),
        nosniff: cab.headers.get("x-content-type-options"),
        fueraDeLista: [await estado("/package.json"), await estado("/sw.js"), await estado("/electron/main.js"), await estado("/tests/smoke.js")],
        medio: await estado("/__media/" + "0".repeat(32)),
        botones: document.querySelectorAll("button").length,
      };
    })()`, true);
    check("el puente expone esApp y la versión, congelado", d.puente?.esApp === true && d.puente.version === app.getVersion() && d.puente.congelado, d.puente);
    check("la página no tiene Node", d.sinNode, d);
    check("window.open queda denegado", d.ventanaNueva === null, d.ventanaNueva);
    check("los permisos se niegan (notificaciones)", d.notificaciones === "denied", d.notificaciones);
    check("no se registra el service worker", d.sw === 0, d.sw);
    check("la CSP de la cabecera es la del meta y bloquea eval", d.csp === csp && d.evalBloqueado && d.nosniff === "nosniff", d.csp);
    check("fuera de la lista blanca, 404 (tests/ se sirve solo por --smoke)", d.fueraDeLista.slice(0, 3).every((s) => s === 404) && d.fueraDeLista[3] === 200, d.fueraDeLista);
    check("__media aún no sirve nada (T2.1)", d.medio === 404, d.medio);
    check("la interfaz arranca", d.botones > 10, d.botones);
    await win.webContents.executeJavaScript('location.href = "https://example.com/"; 1');
    await new Promise((res) => setTimeout(res, 500));
    check("la navegación fuera de la app se bloquea", servir.esUrlDeApp(win.webContents.getURL()), win.webContents.getURL());
  } catch (e) {
    check("comprobaciones sin excepciones", false, String(e?.stack || e));
  }
  return r;
}

/* ---------- Arranque ---------- */

app.whenReady().then(() => {
  if (!primera) return;
  if (app.isPackaged) Menu.setApplicationMenu(null);
  endurecerSesion(session.defaultSession);
  enlaces = new Enlaces(path.join(app.getPath("userData"), "enlaces.json"));
  enlacesListos = enlaces.cargar();
  protocol.handle("app", manejarPeticion);
  cablearIpc();
  const win = crearVentana();
  ventana = win;
  registrar(args.archivos, process.cwd()).then(abrirEnLaApp).catch((e) => console.error(e));
  if (args.smoke) {
    correrSmoke(win).catch((e) => { console.error(e); app.exit(1); });
    return;
  }
  win.once("ready-to-show", () => win.show());
  win.loadURL(`${servir.ORIGEN}/index.html`);
});

app.on("window-all-closed", () => app.quit());
