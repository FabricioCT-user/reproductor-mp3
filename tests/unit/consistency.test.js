// Comprobaciones de que las piezas del proyecto encajan entre sí (lo que más se rompe al mover archivos).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const html = read("index.html");

const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
const swFiles = [...read("sw.js").match(/const FILES = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const normalize = (f) => f.replace(/^\.\//, "");

test("index.html carga scripts que existen y compilan", () => {
  assert.ok(scripts.length > 0);
  for (const s of scripts) {
    assert.ok(fs.existsSync(path.join(ROOT, s)), `falta ${s}`);
    assert.doesNotThrow(() => new vm.Script(read(s), { filename: s }), `error de sintaxis en ${s}`);
  }
});

test("los scripts se cargan en un orden válido (lo que usa cada uno ya está definido) y app.js va el último", () => {
  const order = scripts.map((s) => path.basename(s));
  const before = (a, b) => assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), `${a} debe cargarse antes que ${b}`);
  before("lyrics.js", "tags.js");
  before("subtitles.js", "subtitles-ui.js");
  before("id3.js", "tags.js");
  before("mp4.js", "tags.js");
  before("mkv.js", "library.js");
  before("id3.js", "tag-writer.js");
  before("tags.js", "tag-writer.js");
  assert.equal(order.at(-1), "main.js");
});

test("el service worker precachea todo lo que carga la página y solo archivos que existen", () => {
  const cached = new Set(swFiles.map(normalize));
  for (const f of swFiles) if (f !== "./") assert.ok(fs.existsSync(path.join(ROOT, f)), `sw.js lista un archivo inexistente: ${f}`);
  for (const f of [...scripts, "style.css", "index.html", "manifest.webmanifest"]) assert.ok(cached.has(normalize(f)), `sw.js no precachea ${f}`);
});

test("los iconos del manifest existen", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `falta ${icon.src}`);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.start_url === "./" ? "index.html" : manifest.start_url)));
});

test("todos los elementos que el código busca por id existen en index.html", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const code = scripts.filter((s) => !/\/(id3|tags|tag-writer|lyrics|playlist-io|storage|util)\.js$/.test(s)).map(read).join("\n");

  const list = code.match(/const els = Object\.fromEntries\(\s*\[([\s\S]*?)\]\s*\.map/);
  assert.ok(list, "no se encontró la lista de elementos (els)");
  const declared = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const id of declared) assert.ok(ids.has(id), `els declara «${id}» pero index.html no tiene ese id`);

  // Cualquier els["x"] / els.x que se use debe estar declarado.
  const used = new Set([...code.matchAll(/els\["([^"]+)"\]/g)].map((m) => m[1]).concat([...code.matchAll(/els\.([a-zA-Z][\w]*)/g)].map((m) => m[1])));
  used.delete("toast"); // se declara pero también se usa como propiedad: comprobado abajo
  for (const id of used) assert.ok(declared.includes(id) || id === "toast", `el código usa els.${id} sin declararlo`);
  for (const id of [...code.matchAll(/els\[`edit-\$\{f\}`\]/g)].length ? ["edit-title", "edit-artist", "edit-album"] : []) assert.ok(declared.includes(id));
});

test("los identificadores del HTML no se repiten", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test("la CSP (si existe) permite lo que usa la página", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  if (!csp) return;
  for (const need of ["media-src 'self' blob:", "img-src 'self' blob: data:", "worker-src 'self'"]) assert.ok(csp.includes(need), `la CSP no incluye ${need}`);
});

test("la CSP autoriza exactamente el script en línea del tema (hash al día)", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(csp, "falta la CSP en index.html");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(inline.length, 1, "solo debe haber un script en línea");
  const hash = require("node:crypto").createHash("sha256").update(inline[0]).digest("base64");
  assert.ok(csp.includes(`'sha256-${hash}'`), `la CSP no incluye el hash actual del script en línea: sha256-${hash}`);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal([...html.matchAll(/\sstyle="/g)].length, 0, "hay estilos en línea y la CSP los bloquearía");
  assert.equal([...html.matchAll(/\son[a-z]+="/g)].length, 0, "hay manejadores de eventos en línea y la CSP los bloquearía");
});

test("los botones que solo tienen icono tienen nombre accesible", () => {
  for (const id of ["shuffle", "prev", "play", "next", "repeat", "mute", "fs-play", "fs-mute", "fs-subs", "fs-pip", "fs-exit"]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]*aria-label="[^"]+"`), `el botón ${id} no tiene aria-label`);
  }
});

test("manifest: la app se ofrece como manejadora de archivos de audio y video (Abrir con…)", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  const handlers = manifest.file_handlers;
  assert.ok(Array.isArray(handlers) && handlers.length > 0, "falta file_handlers");
  const util = require("./helpers").load("util.js");
  const isAudio = util("isAudio");
  const isVideo = util("isVideo");
  const isMedia = util("isMedia");
  for (const h of handlers) {
    assert.ok(h.action.startsWith("./") || h.action.startsWith("/"), "la acción debe estar dentro del alcance de la app");
    for (const [mime, exts] of Object.entries(h.accept)) {
      assert.match(mime, /^(audio|video)\//);
      const checkKind = mime.startsWith("video/") ? isVideo : isAudio;
      for (const ext of exts) {
        assert.match(ext, /^\.[a-z0-9]+$/, `extensión mal escrita: ${ext}`);
        assert.ok(checkKind({ name: `x${ext}`, type: "" }), `la app no reconoce ${ext} para ${mime}`);
        assert.ok(isMedia({ name: `x${ext}`, type: mime }), `isMedia no reconoce ${ext} (${mime})`);
      }
    }
  }
  const allMimes = handlers.flatMap((h) => Object.keys(h.accept));
  for (const mustMime of ["video/mp4", "video/webm"]) assert.ok(allMimes.includes(mustMime), `falta ${mustMime}`);
  const all = handlers.flatMap((h) => Object.values(h.accept).flat());
  assert.equal(new Set(all).size, all.length, "una extensión aparece en dos tipos distintos");
  for (const must of [".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".mp4", ".webm"]) assert.ok(all.includes(must), `falta ${must}`);
  assert.ok(manifest.launch_handler, "falta launch_handler (reutilizar la ventana abierta)");
});

/* ---------- App de escritorio (Electron) ---------- */

const servir = require("../../electron/lib/servir");
const pkg = JSON.parse(read("package.json"));

test("Electron: el protocolo sirve exactamente FILES de sw.js (+ index.html) y todos existen", () => {
  const lista = servir.listaBlanca(read("sw.js"));
  const esperado = new Set(swFiles.filter((f) => f !== "./").map(normalize).concat("index.html"));
  assert.deepEqual([...lista].sort(), [...esperado].sort());
  for (const f of lista) assert.ok(fs.existsSync(path.join(ROOT, f)), `el protocolo serviría un archivo inexistente: ${f}`);
  for (const f of servir.PRUEBAS) assert.ok(fs.existsSync(path.join(ROOT, f)), `falta ${f}`);
});

test("Electron: la CSP de la cabecera es idéntica a la del meta", () => {
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.equal(servir.cspDeHtml(html), meta);
  assert.equal(servir.cabeceras("index.html", servir.cspDeHtml(html))["Content-Security-Policy"], meta);
});

test("Electron: el paquete incluye lo que sirve el protocolo y no las pruebas", () => {
  const glob = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*")}$`);
  const patrones = pkg.build.files.map(glob);
  const incluido = (f) => patrones.some((p) => p.test(f));
  for (const f of [...servir.listaBlanca(read("sw.js")), "sw.js", "package.json", pkg.main, "electron/preload.js", "electron/lib/servir.js", "electron/lib/argumentos.js", "electron/lib/rutas.js", "electron/lib/entregas.js", "electron/lib/escritorio.js"]) {
    assert.ok(incluido(f), `build.files no incluye ${f}`);
  }
  for (const f of [...servir.PRUEBAS, "tests/smoke-app.js", "docs/PLAN-MP4.md", ".github/workflows/test.yml", "node_modules/x/index.js"]) assert.ok(!incluido(f), `build.files incluye ${f}`);
  assert.equal(pkg.main, "electron/main.js");
});

test("Electron: empaquetado, asociaciones de archivos (fileAssociations ↔ rutas.js ↔ isMedia) y sin --no-sandbox", () => {
  const b = pkg.build;
  assert.equal(b.productName, "Reproductor");
  assert.equal(b.appId, "io.github.fabricioct-user.reproductor");
  assert.equal(b.asar, true);
  assert.equal(b.publish, null, "no debe configurarse auto-actualización");
  assert.ok(fs.existsSync(path.join(ROOT, b.linux.icon)), `falta icono ${b.linux.icon}`);
  assert.ok(b.linux.target.includes("pacman") && b.linux.target.includes("AppImage"), "debe empaquetar pacman y AppImage");
  assert.deepEqual(b.pacman.executableArgs, ["--", "%F"], "pacman debe pasar -- antes de %F");
  assert.deepEqual(b.deb.executableArgs, ["--", "%F"], "deb debe pasar -- antes de %F");
  assert.ok(Array.isArray(b.appImage.executableArgs), "appImage debe fijar executableArgs para evitar --no-sandbox por defecto");
  assert.doesNotMatch(JSON.stringify(b), /--no-sandbox/, "nunca usar --no-sandbox");

  // Extensiones de fileAssociations === extensiones de audio/video en rutas.js === isMedia de src/util.js.
  const rutas = require("../../electron/lib/rutas");
  const util = require("./helpers").load("util.js");
  const isMedia = util("isMedia");

  const extsPaquete = b.fileAssociations.flatMap((a) => (Array.isArray(a.ext) ? a.ext : [a.ext]));
  assert.equal(new Set(extsPaquete).size, extsPaquete.length, "extensión duplicada en fileAssociations");
  for (const ext of extsPaquete) assert.match(ext, /^[a-z0-9]+$/, `extensión mal escrita en fileAssociations: ${ext}`);

  const extsRutas = Object.entries(rutas.EXTENSIONES)
    .filter(([, [clase]]) => clase === "audio" || clase === "video")
    .map(([ext]) => ext.slice(1));
  assert.deepEqual([...extsPaquete].sort(), [...extsRutas].sort(), "fileAssociations desincronizado con electron/lib/rutas.js");

  const utilSrc = read("src/util.js");
  const extsUtil = [
    ...utilSrc.match(/isAudio[\s\S]*?\\\.\(([a-z0-9|]+)\)\$/)[1].split("|"),
    ...utilSrc.match(/isVideo[\s\S]*?\\\.\(([a-z0-9|]+)\)\$/)[1].split("|"),
  ];
  assert.deepEqual([...extsPaquete].sort(), [...extsUtil].sort(), "fileAssociations desincronizado con isAudio/isVideo de src/util.js");
  for (const ext of extsPaquete) assert.equal(isMedia({ name: `prueba.${ext}`, type: "" }), true, `isMedia no reconoce .${ext}`);

  // Todos los MIME de audio/video de rutas.js están en linux.mimeTypes y sin duplicados,
  // y coinciden con los integrados en electron/lib/escritorio.js (para el AppImage empaquetado).
  const escritorio = require("../../electron/lib/escritorio");
  const mimes = b.linux.mimeTypes;
  assert.ok(Array.isArray(mimes) && mimes.length > 0);
  assert.equal(new Set(mimes).size, mimes.length, "MIME duplicado en linux.mimeTypes");
  assert.deepEqual(escritorio.MIME_TYPES, mimes, "escritorio.MIME_TYPES desincronizado con build.linux.mimeTypes");
  assert.equal(escritorio.NOMBRE_APP, b.productName);
  assert.equal(escritorio.CATEGORIAS, b.linux.category);
  for (const [ext, [clase, mime]] of Object.entries(rutas.EXTENSIONES)) {
    if (clase === "audio" || clase === "video") assert.ok(mimes.includes(mime), `linux.mimeTypes no incluye ${mime} (${ext})`);
  }
});

test("Electron: versiones exactas, fuses de seguridad y npm test sin Electron", () => {
  for (const [nombre, v] of Object.entries(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${nombre} debe tener versión exacta`);
  assert.equal(pkg.devDependencies.electron, "45.4.1");
  assert.equal(pkg.dependencies, undefined, "la app no tiene dependencias de ejecución");
  const f = pkg.build.electronFuses;
  assert.equal(f.runAsNode, false);
  assert.equal(f.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(f.enableNodeCliInspectArguments, false);
  assert.equal(f.onlyLoadAppFromAsar, true);
  assert.equal(f.enableEmbeddedAsarIntegrityValidation, true);
  // npm test corre sin node_modules (CI): ni las pruebas ni electron/lib pueden cargar electron.
  const sinElectron = fs.readdirSync(path.join(ROOT, "tests/unit")).map((f) => `tests/unit/${f}`)
    .concat(fs.readdirSync(path.join(ROOT, "electron/lib")).map((f) => `electron/lib/${f}`));
  for (const f of sinElectron) assert.doesNotMatch(read(f), /require\(\s*["']electron["']\s*\)/, `${f} carga electron`);
});

test("Electron: la ventana está endurecida", () => {
  const main = read("electron/main.js");
  for (const need of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false", "webSecurity: true", "webviewTag: false",
    'action: "deny"', '"will-navigate"', "setPermissionRequestHandler", "setPermissionCheckHandler", 'permiso === "fullscreen"',
    'autoplayPolicy: "no-user-gesture-required"', "devTools: !app.isPackaged",
    'app.commandLine.hasSwitch("no-sandbox")', "dialog.showErrorBox"]) {
    assert.ok(main.includes(need), `electron/main.js no incluye ${need}`);
  }
  assert.doesNotMatch(main, /nodeIntegration: true|contextIsolation: false|sandbox: false|webSecurity: false/);
  // Cada manejador IPC comprueba el origen del emisor.
  const manejadores = [...main.matchAll(/ipcMain\.(?:on|handle|once)\(\s*"([^"]+)",\s*(?:async\s*)?\((\w+)[^)]*\)\s*=>\s*\{?([\s\S]*?)\n  \}\);/g)];
  assert.ok(manejadores.length > 0);
  assert.equal(manejadores.length, (main.match(/ipcMain\.\w+\(/g) || []).length, "hay manejadores IPC que la prueba no reconoce (formato)");
  for (const [, canal, evento, cuerpo] of manejadores) assert.ok(cuerpo.includes(`deLaApp(${evento})`), `el canal ${canal} no comprueba el origen`);
  // Lo que usa el preload existe en el principal.
  const canales = new Set(manejadores.map((m) => m[1]));
  for (const [, canal] of read("electron/preload.js").matchAll(/ipcRenderer\.(?:sendSync|invoke|send)\("([^"]+)"/g)) assert.ok(canales.has(canal), `el preload usa ${canal}`);
});

test("Electron: la interfaz no registra el service worker dentro de la app", () => {
  assert.match(read("src/app/main.js"), /serviceWorker" in navigator && !window\.reproductor/);
});
