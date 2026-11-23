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
const escritorio = require("./lib/escritorio");
const medios = require("./lib/medios");
const rutas = require("./lib/rutas");
const servir = require("./lib/servir");

const RAIZ = path.join(__dirname, "..");
const args = analizar(process.argv, { empaquetada: app.isPackaged });
const SMOKE_LIMITE_MS = 10 * 60 * 1000;
const MENSAJE_SIN_SANDBOX = "El Reproductor no se ejecuta sin sandbox. Usa el paquete .deb/.pacman o habilita los espacios de nombres de usuario.";

// Muestra diálogo gráfico solo cuando se lanza desde un entorno de escritorio sin consola
// (stderr en /dev/null o journald de systemd), nunca en terminal, pipes ni pruebas automáticas.
function esLanzamientoGrafico() {
  if (args.smoke) return false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  if (process.stderr.isTTY) return false;
  try {
    const st = fs.fstatSync(2);
    if (st.isCharacterDevice()) return true;
    if (st.isSocket() && process.env.JOURNAL_STREAM === `${st.dev}:${st.ino}`) return true;
  } catch {}
  return false;
}

// Política de seguridad (TE.1/TE.3): negarse a arrancar sin sandbox (cubre también el fallback
// silencioso a --no-sandbox que añade el AppRun de electron-builder si fallan los userns).
if (app.commandLine.hasSwitch("no-sandbox")) {
  console.error(MENSAJE_SIN_SANDBOX);
  if (esLanzamientoGrafico()) {
    app.whenReady().then(() => {
      dialog.showErrorBox("Reproductor", MENSAJE_SIN_SANDBOX);
      app.exit(1);
    }).catch(() => app.exit(1));
  } else {
    app.exit(1);
  }
  return;
}

// Integración opcional del AppImage en el escritorio: escribe .desktop e icono y sale sin abrir ventana.
if (args.instalarEscritorio) {
  escritorio.instalar({ raiz: RAIZ }).then((r) => {
    console.log(`Instalado: ${r.escritorio}`);
    console.log(`Icono: ${r.icono}`);
    console.log(`Ejecutable: ${r.ejecutable}`);
    app.exit(0);
  }).catch((e) => {
    console.error(`Error al instalar la entrada de escritorio: ${e.message}`);
    app.exit(1);
  });
  return;
}

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
  const vistos = new Set();
  const agregar = (v) => {
    if (!v || vistos.has(v.ruta)) return;
    vistos.add(v.ruta);
    items.push(entregas.registrar(v));
  };
  for (const a of argumentos) {
    const v = await rutas.validar(rutas.aRuta(a, cwd));
    if (!v) continue;
    agregar(v);
    if (v.clase === "video") {
      for (const s of await rutas.subtitulosAcompanantes(v.ruta)) agregar(s);
    }
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
  // En la prueba de humo la ventana nunca se muestra: si no, la segunda instancia la abriría en el escritorio del usuario.
  if (args.smoke || !ventana || ventana.isDestroyed()) return;
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
      : { title: "Añadir archivos", properties: ["openFile", "multiSelections"], filters: [{ name: "Audio, video, letras y subtítulos", extensions: extensiones }] });
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
  const desdeRuta = typeof x?.ruta === "string";
  if (typeof x?.entrega === "string") ruta = entregas.tomar(x.entrega, ["video"])?.ruta ?? null;
  else if (desdeRuta) ruta = rutas.aRuta(x.ruta, null); // solo absolutas
  if (!ruta) return null;
  const v = await rutas.validar(ruta);
  if (!v || v.clase !== "video") return null;
  const reg = await enlacesListos;
  const linkId = await reg.registrar(v);
  const res = { linkId, name: v.nombre, size: v.tamano, lastModified: v.fecha, type: v.tipo };
  if (desdeRuta) {
    const acomp = await rutas.subtitulosAcompanantes(v.ruta);
    if (acomp.length) res.subtitulos = acomp.map((s) => entregas.registrar(s));
  }
  return res;
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
    const limite = e.clase === "subtitulo" ? rutas.MAX_SUBTITULO : rutas.MAX_LECTURA;
    return rutas.leer(e.ruta, { limite }).catch(() => null); // ya no está, es otra cosa o es demasiado grande
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
  const resultados = [...(estado?.results || []), ...(await comprobacionesAbrir(win)), ...(await comprobacionesEnlaces(win)),
    ...(await comprobacionesCompatibilidad(win)), ...(await comprobacionesApp(win))];
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
    check("ni el que no existe ni la extensión falsa entran; el video sí (enlazado)",
      !d.nombres.some((n) => /nota|no-existe/.test(n)) && d.nombres.includes("video.mp4"), d.nombres);
    check("la letra que acompaña al audio se asocia", await ev(`!!state.tracks.find((t) => t.fileName === "uno.wav")?.userLyrics`), d);

    // Segunda instancia real: otra app con la misma carpeta de datos le pasa su archivo a esta y se cierra.
    const { spawn } = require("node:child_process");
    const tres = path.join(path.dirname(rutas.aRuta(args.archivos[0], process.cwd())), "tres.wav");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const codigo = await new Promise((res) => {
      const hijo = spawn(process.execPath, [RAIZ, `--user-data-dir=${args.datos}`, "--", tres], { stdio: "ignore", env });
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

// Videos enlazados por ruta (T2.1). comprobacionesAbrir dejó en la biblioteca «video.mp4» (llegó por argv; 5 min, ~8 MB).
// smoke-app.js deja además «otro video.mp4» junto a la carpeta de los medios: entra por <input> (webUtils).
async function comprobacionesEnlaces(win) {
  const r = [];
  const check = (name, ok, detail) => r.push({ name: `App, enlaces: ${name}`, ok: !!ok, detail: ok ? "" : JSON.stringify(detail) });
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  const pausa = (ms) => new Promise((res) => setTimeout(res, ms));
  const hasta = async (js, ms = 10000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { if (await ev(js)) return true; await pausa(100); }
    return false;
  };
  const carpeta = path.dirname(rutas.aRuta(args.archivos[0], process.cwd()));
  const rutaVideo = path.join(carpeta, "video.mp4");
  const otro = path.join(path.dirname(carpeta), "otro video.mp4");
  const archivoEnlaces = path.join(app.getPath("userData"), "enlaces.json");
  // Descriptores del proceso principal abiertos sobre los videos de prueba.
  const abiertos = () => fs.readdirSync("/proc/self/fd").filter((fd) => {
    try { return [rutaVideo, otro].includes(fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { return false; }
  }).length;
  const hastaCerrados = async (ms = 5000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { if (abiertos() === 0) return true; await pausa(100); }
    return abiertos() === 0;
  };
  const registro = (nombre) => ev(`(async () => {
    const recs = await Storage.all();
    const rec = recs.find((x) => x.name === ${JSON.stringify(nombre)}) || null;
    const t = state.tracks.find((x) => x.fileName === ${JSON.stringify(nombre)});
    return { rec, json: JSON.stringify(recs), archivo: rec ? (await Storage.getFile(rec.id)) !== null : null,
      url: t?.url ?? null, linkId: t?.linkId ?? null, kind: t?.meta?.kind ?? null, noDisponible: !!t?.unavailable, hay: !!t };
  })()`);
  const leerEnlaces = () => { try { return fs.readFileSync(archivoEnlaces, "utf8"); } catch { return ""; } };
  try {
    // Lo que se guarda: en IndexedDB solo el id; la ruta solo en enlaces.json (0600).
    let d = await registro("video.mp4");
    const id = d.rec?.linkId;
    check("el video de argv se enlaza: IndexedDB guarda source «link» + linkId, sin archivo ni ruta",
      d.rec?.source === "link" && /^[0-9a-f]{32}$/.test(id) && d.archivo === false && d.linkId === id
      && !d.json.includes(carpeta) && !d.json.includes(os.tmpdir()) && d.url === `__media/${id}` && d.kind === "video", d);
    const texto = leerEnlaces();
    check("el registro de enlaces está en userData con permisos 0600 y guarda la ruta real",
      (fs.statSync(archivoEnlaces).mode & 0o777) === 0o600 && texto.includes(id) && texto.includes(JSON.stringify(rutaVideo).slice(1, -1)), texto);
    const cabeza = await ev(`new LinkedFile({ name: "v", size: 100 }, { linkId: ${JSON.stringify(id)} }).slice(4, 8).arrayBuffer()
      .then((b) => new TextDecoder().decode(b))`);
    check("las etiquetas se leen por Range sin copiar el archivo (LinkedFile.slice)", cabeza === "ftyp", cabeza);

    // Reproducir, con imagen y con sonido por Web Audio (mismo origen).
    await ev(`loadTrack(state.tracks.findIndex((t) => t.fileName === "video.mp4"), true, "all"); 1`);
    const suena = await hasta(`!media.paused && media.currentTime > 0.5 && media.videoWidth === 320
      && media.webkitAudioDecodedByteCount > 0 && analyser?.context.state === "running"`);
    const m = await ev(`({ src: media.currentSrc, t: media.currentTime, w: media.videoWidth, audio: media.webkitAudioDecodedByteCount,
      ctx: analyser?.context.state, error: media.error?.code ?? null })`);
    check("reproduce desde app://reproductor/__media/<id> con imagen y sonido", suena && m.src === `${servir.ORIGEN}/__media/${id}`, m);

    const subAuto = await hasta(`media.textTracks[0]?.activeCues?.length === 1 && media.textTracks[0].activeCues[0].text === "Subtítulo automático"`, 5000);
    const subInfo = await ev(`({ subs: state.tracks[state.index]?.subs?.map((s) => ({ label: s.label, offset: s.offset })),
      cues: [...(media.textTracks[0]?.activeCues || [])].map((c) => c.text) })`);
    check("encuentra solo el .srt junto al video abierto por argv y muestra activeCues", subAuto, subInfo);

    // Saltar: a mitad y sigue sonando.
    const t = await ev(`new Promise((res) => { media.addEventListener("seeked", () => res(media.currentTime), { once: true }); media.currentTime = 5; })`);
    const sigue = await hasta("!media.paused && media.currentTime > 5.3");
    check("salta a mitad del video y sigue reproduciendo", Math.abs(t - 5) < 0.1 && sigue, { t });

    // Muchos saltos: cada uno puede abrir una petición nueva y cancelar la anterior; ninguna debe dejar el archivo abierto.
    const n = await ev(`(async () => {
      let hechos = 0;
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => {
          const tope = setTimeout(res, 3000);
          media.addEventListener("seeked", () => { clearTimeout(tope); hechos++; res(); }, { once: true });
          media.currentTime = ((i * 37) % 40) * 7; // de 0 a 273 s, saltando lejos
        });
      }
      return hechos;
    })()`);
    const durante = abiertos();
    await ev(`media.pause(); media.removeAttribute("src"); media.load(); 1`);
    const cerrados = await hastaCerrados();
    check("40 saltos seguidos: como mucho un par de descriptores abiertos a la vez", n === 40 && durante <= 3, { n, durante });
    check("al soltar el video no queda ningún descriptor abierto (/proc/self/fd)", cerrados, { quedan: abiertos() });

    // El protocolo, desde la página: Range, 416, ids falsos, salirse de __media.
    const p = await ev(`(async () => {
      const g = async (url, rango) => {
        const res = await fetch(url, rango ? { headers: { Range: rango } } : undefined);
        return { s: res.status, cr: res.headers.get("content-range"), ct: res.headers.get("content-type"), len: (await res.arrayBuffer()).byteLength };
      };
      const u = "__media/" + ${JSON.stringify(id)};
      return { parcial: await g(u, "bytes=0-99"), sufijo: await g(u, "bytes=-10"), fuera: await g(u, "bytes=999999999-"),
        falso: await g("__media/" + "0".repeat(32)), salir: await g("__media/%2e%2e%2findex.html"), corto: await g("__media/abc") };
    })()`);
    const tam = fs.statSync(rutaVideo).size;
    check("Range: 206 con Content-Range y Content-Type por extensión; sufijo", p.parcial.s === 206 && p.parcial.cr === `bytes 0-99/${tam}`
      && p.parcial.len === 100 && p.parcial.ct === "video/mp4" && p.sufijo.s === 206 && p.sufijo.len === 10, p);
    check("Range fuera del archivo: 416 con bytes */tamaño", p.fuera.s === 416 && p.fuera.cr === `bytes */${tam}`, p.fuera);
    check("__media con id falso, mal formado o «..»: 404", p.falso.s === 404 && p.salir.s === 404 && p.corto.s === 404, p);
    check("las peticiones de la página no dejan descriptores abiertos", await hastaCerrados(), abiertos());

    // Un File con ruta real (arrastrar o <input>): el preload saca la ruta con webUtils y se enlaza.
    const dbg = win.webContents.debugger;
    dbg.attach("1.3");
    try {
      const { root } = await dbg.sendCommand("DOM.getDocument");
      const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" });
      await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [otro] });
    } finally { dbg.detach(); }
    await hasta(`state.tracks.some((t) => t.fileName === "otro video.mp4")`);
    await hasta(`state.tracks.find((t) => t.fileName === "otro video.mp4")?.subs?.length === 1`, 5000);
    d = await registro("otro video.mp4");
    const otroSubs = await ev(`state.tracks.find((t) => t.fileName === "otro video.mp4")?.subs || []`);
    const otroId = d.rec?.linkId;
    check("un File de <input> o arrastrado (webUtils.getPathForFile) se enlaza sin copiarse",
      d.rec?.source === "link" && /^[0-9a-f]{32}$/.test(otroId) && d.archivo === false && !d.json.includes(otro), d);
    check("al enlazar un video por <input>/arrastrar encuentra solo el .es.srt de su misma carpeta",
      otroSubs.length === 1 && otroSubs[0].lang === "es" && otroSubs[0].label === "Español"
      && otroSubs[0].text.includes("Subtítulo enlazado") && !d.json.includes(path.dirname(otro)), otroSubs);

    // Lo que no es un video con ruta no se enlaza: un File creado por la página se copia como en la web.
    const api = await ev(`(async () => {
      const bytes = await (await fetch("__media/" + ${JSON.stringify(id)})).arrayBuffer();
      const sintetico = new File([bytes], "sintetico.mp4", { type: "video/mp4", lastModified: 1 });
      const r = { inventado: await window.reproductor.enlazar("0".repeat(32)), sintetico: await window.reproductor.enlazar(sintetico),
        objeto: await window.reproductor.enlazar({ ruta: "/etc/passwd" }), numero: await window.reproductor.enlazar(5) };
      await addFiles([sintetico]);
      r.copiado = (await Storage.all()).find((x) => x.name === "sintetico.mp4")?.source;
      return r;
    })()`);
    check("ids inventados, Files sin ruta u objetos no se enlazan; el File sin ruta se copia",
      api.inventado === null && api.sintetico === null && api.objeto === null && api.numero === null && api.copiado === "blob", api);

    // Reinicio: la página recarga de IndexedDB y el principal relee enlaces.json.
    await win.loadURL(`${servir.ORIGEN}/index.html`);
    await ev("appReady.then(() => 1)");
    d = await registro("video.mp4");
    const relee = (await new Enlaces(archivoEnlaces).cargar()).obtener(id);
    await ev(`loadTrack(state.tracks.findIndex((t) => t.fileName === "video.mp4"), true, "all"); 1`);
    const suena2 = await hasta("!media.paused && media.currentTime > 0.3 && media.videoWidth === 320");
    check("tras recargar (y releer enlaces.json) el video sigue enlazado y suena", d.hay && !d.noDisponible && d.url === `__media/${id}`
      && relee?.ruta === rutaVideo && suena2, { d, relee: !!relee });
    await ev(`media.pause(); media.removeAttribute("src"); media.load(); 1`);

    // Borrar la pista olvida su enlace.
    await ev(`removeTrack(state.tracks.findIndex((t) => t.fileName === "otro video.mp4")); 1`);
    await pausa(300);
    const borrado = await ev(`fetch("__media/" + ${JSON.stringify(otroId)}).then((r) => r.status)`);
    check("al quitar la pista se olvida su enlace (404 y fuera de enlaces.json)", borrado === 404 && !leerEnlaces().includes(otroId)
      && !leerEnlaces().includes("otro video"), { borrado });

    // Si el archivo desaparece, al arrancar no se borra nada (T2.2 lo marcará).
    fs.renameSync(rutaVideo, `${rutaVideo}.movido`);
    try {
      await win.loadURL(`${servir.ORIGEN}/index.html`);
      await ev("appReady.then(() => 1)");
      d = await registro("video.mp4");
      check("un enlace cuyo archivo ya no está no se borra al arrancar", d.hay && d.rec?.linkId === id && leerEnlaces().includes(id), d);
    } finally { fs.renameSync(`${rutaVideo}.movido`, rutaVideo); }
    check("al final no queda ningún descriptor abierto", await hastaCerrados(), abiertos());
  } catch (e) {
    check("comprobaciones sin excepciones", false, String(e?.stack || e));
  }
  return r;
}

// Compatibilidad de códecs (T3.1): smoke-app.js genera un MP4 H.264 + AC-3 real con ffmpeg.
// En esta build de Electron el AC-3 reproduce mudo sin lanzar error: se detecta vía stsd + canPlayType,
// se marca en la fila de la biblioteca y avisa al reproducirlo.
async function comprobacionesCompatibilidad(win) {
  const r = [];
  const check = (name, ok, detail) => r.push({ name: `App, compatibilidad: ${name}`, ok: !!ok, detail: ok ? "" : JSON.stringify(detail) });
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  const pausa = (ms) => new Promise((res) => setTimeout(res, ms));
  const hasta = async (js, ms = 8000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { if (await ev(js)) return true; await pausa(100); }
    return false;
  };
  const carpeta = path.dirname(rutas.aRuta(args.archivos[0], process.cwd()));
  const rutaAc3 = path.join(path.dirname(carpeta), "ac3.mp4");
  try {
    await win.loadURL(`${servir.ORIGEN}/index.html`);
    await ev("appReady.then(() => 1)");
    const dbg = win.webContents.debugger;
    dbg.attach("1.3");
    try {
      const { root } = await dbg.sendCommand("DOM.getDocument");
      const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" });
      await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [rutaAc3] });
    } finally { dbg.detach(); }
    await hasta(`state.tracks.some((t) => t.fileName === "ac3.mp4")`);
    const imp = await ev(`(() => {
      const t = state.tracks.find((x) => x.fileName === "ac3.mp4");
      const rows = [...els.playlist.querySelectorAll("li")];
      const row = rows.find((li) => li.querySelector(".t-name")?.textContent === "ac3");
      return {
        hay: !!t, kind: t?.meta?.kind ?? null, codecs: t?.meta?.codecs ?? null,
        warn: t?.compatWarning ?? null, rowWarn: row?.querySelector(".t-warn")?.textContent ?? null,
        toastImport: els.toast.hidden ? "" : els.toast.textContent,
      };
    })()`);
    check("MP4 AC-3 real se importa, extrae códecs (avc1 + ac-3) y marca la fila como «puede no reproducirse»",
      imp.hay && imp.kind === "video" && /avc1\./i.test(imp.codecs || "") && /\bac-3\b/i.test(imp.codecs || "")
      && /AC-3/i.test(imp.warn || "") && /puede no reproducirse/i.test(imp.rowWarn || "") && /AC-3/i.test(imp.rowWarn || ""), imp);

    // Al reproducirlo, avisa de que el audio AC-3 no es compatible.
    await ev(`els.toast.hidden = true; loadTrack(state.tracks.findIndex((t) => t.fileName === "ac3.mp4"), true, "all"); 1`);
    const avisoOk = await hasta(`!els.toast.hidden && /el audio AC-3 no es compatible/i.test(els.toast.textContent)`);
    const playInfo = await ev(`({ toast: els.toast.textContent, hidden: els.toast.hidden, w: media.videoWidth })`);
    check("al reproducir el MP4 AC-3 muestra el aviso de audio AC-3 no compatible", avisoOk, playInfo);

    await ev(`media.pause(); media.removeAttribute("src"); media.load(); removeTrack(state.tracks.findIndex((t) => t.fileName === "ac3.mp4")); 1`);
    await pausa(200);
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
    check("__media con un id que no está registrado: 404", d.medio === 404, d.medio);
    check("la interfaz arranca", d.botones > 10, d.botones);
    await win.webContents.executeJavaScript('location.href = "https://example.com/"; 1');
    await new Promise((res) => setTimeout(res, 500));
    check("la navegación fuera de la app se bloquea", servir.esUrlDeApp(win.webContents.getURL()), win.webContents.getURL());

    // Política de sandbox: arrancar con --no-sandbox debe negarse y salir con código != 0.
    const { spawn } = require("node:child_process");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const sinSandbox = await new Promise((res) => {
      let stderr = "";
      const hijo = spawn(process.execPath, [RAIZ, "--no-sandbox"], { stdio: ["ignore", "pipe", "pipe"], env });
      hijo.stderr.on("data", (chunk) => { stderr += chunk; });
      const t = setTimeout(() => { hijo.kill(); res({ codigo: "timeout", stderr }); }, 15000);
      hijo.on("exit", (codigo) => { clearTimeout(t); res({ codigo, stderr }); });
    });
    check("se niega a arrancar con --no-sandbox (código != 0 y aviso claro)",
      sinSandbox.codigo === 1 && /sin sandbox/i.test(sinSandbox.stderr), sinSandbox);
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
