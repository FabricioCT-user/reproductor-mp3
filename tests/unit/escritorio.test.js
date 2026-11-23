// Integración del AppImage en el escritorio Linux (electron/lib/escritorio.js). No necesita Electron.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const escritorio = require("../../electron/lib/escritorio");

const ROOT = path.join(__dirname, "..", "..");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "escritorio-prueba-")));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function tieneValidador() {
  try { execFileSync("desktop-file-validate", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

test("escaparExec: cita según la Desktop Entry Spec y bloquea caracteres de control", () => {
  assert.equal(escritorio.escaparExec("/home/ana/Reproductor.AppImage"), '"/home/ana/Reproductor.AppImage"');
  assert.equal(escritorio.escaparExec("/home/ana/Mis Apps/Reproductor ñ.AppImage"), '"/home/ana/Mis Apps/Reproductor ñ.AppImage"');
  // En .desktop se aplica el escape de cadena (\ → \\) sobre el escape de Exec (\, ", `, $ → \X) y % → %%.
  assert.equal(escritorio.escaparExec('/tmp/a"b$c`d\\e%Ff'), '"/tmp/a\\\\"b\\\\$c\\\\`d\\\\\\\\e%%Ff"');
  for (const mala of ["", "/tmp/a\nb", "/tmp/a\rb", "/tmp/a\0b", "/tmp/a\tb", "/tmp/a\x7fb", null, 5]) {
    assert.throws(() => escritorio.escaparExec(mala), `debió rechazar ${JSON.stringify(mala)}`);
  }
});

test("carpetaDatos: prefiere XDG_DATA_HOME absoluto y cae a HOME/.local/share", () => {
  assert.equal(escritorio.carpetaDatos({ XDG_DATA_HOME: "/datos/xdg", HOME: "/home/ana" }), "/datos/xdg");
  assert.equal(escritorio.carpetaDatos({ XDG_DATA_HOME: "relativa", HOME: "/home/ana" }), "/home/ana/.local/share");
  assert.equal(escritorio.carpetaDatos({ HOME: "/home/ana" }), "/home/ana/.local/share");
  assert.throws(() => escritorio.carpetaDatos({}));
  assert.throws(() => escritorio.carpetaDatos({ HOME: "relativa" }));
  assert.throws(() => escritorio.carpetaDatos({ HOME: "/home/ana\nmal" }));
});

test("contenidoDesktop: genera una entrada válida con MimeType, %F y sin --no-sandbox", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const txt = escritorio.contenidoDesktop({
    rutaEjecutable: '/home/ana/Apps $1 "test" `x` \\dir 100%/Reproductor.AppImage',
    nombre: pkg.build.productName,
    comentario: pkg.description,
    categorias: pkg.build.linux.category,
    mimeTypes: pkg.build.linux.mimeTypes,
  });
  assert.match(txt, /^\[Desktop Entry\]\n/);
  assert.match(txt, /\nType=Application\n/);
  assert.match(txt, /\nName=Reproductor\n/);
  assert.match(txt, /\nExec="\/home\/ana\/Apps \\\\\$1 \\\\"test\\\\" \\\\`x\\\\` \\\\\\\\dir 100%%\/Reproductor\.AppImage" %F\n/);
  assert.match(txt, /\nIcon=reproductor\n/);
  assert.match(txt, /\nStartupWMClass=reproductor\n/);
  assert.match(txt, /\nMimeType=audio\/mpeg;.*video\/mp4;.*;\n/);
  assert.doesNotMatch(txt, /--no-sandbox/);

  if (tieneValidador()) {
    const f = path.join(dir, "valido.desktop");
    fs.writeFileSync(f, txt);
    assert.doesNotThrow(() => execFileSync("desktop-file-validate", [f], { stdio: "pipe" }));
  }
});

test("contenidoDesktop: rechaza tipos MIME mal formados o inyección en campos", () => {
  assert.throws(() => escritorio.contenidoDesktop({ rutaEjecutable: "/a/b", mimeTypes: [] }));
  assert.throws(() => escritorio.contenidoDesktop({ rutaEjecutable: "/a/b", mimeTypes: ["audio/mpeg\nExec=mal"] }));
  assert.throws(() => escritorio.contenidoDesktop({ rutaEjecutable: "/a/b", mimeTypes: ["audio/mpeg;otro"] }));
  const txt = escritorio.contenidoDesktop({
    rutaEjecutable: "/a/b",
    nombre: "Reproductor\nExec=mal",
    mimeTypes: ["audio/mpeg"],
  });
  assert.equal((txt.match(/^Exec=/gm) || []).length, 1);
  assert.ok(txt.includes("Name=Reproductor\\nExec=mal\n"));
});

test("instalar: escribe .desktop e icono de forma atómica en XDG_DATA_HOME sin dejar temporales", async () => {
  const carpetaApp = path.join(dir, 'App con espacios $1 "hola" 50%');
  fs.mkdirSync(carpetaApp, { recursive: true });
  const fakeAppImage = path.join(carpetaApp, "Reproductor.AppImage");
  fs.writeFileSync(fakeAppImage, "#!/bin/sh\n", { mode: 0o755 });
  const enlace = path.join(dir, "enlace.AppImage");
  fs.symlinkSync(fakeAppImage, enlace);

  const xdg = path.join(dir, "xdg-data");
  const r = await escritorio.instalar({
    env: { APPIMAGE: enlace, XDG_DATA_HOME: xdg },
    raiz: ROOT,
    actualizarBase: false,
  });

  assert.equal(r.ejecutable, fakeAppImage);
  assert.equal(r.escritorio, path.join(xdg, "applications", "reproductor.desktop"));
  assert.equal(r.icono, path.join(xdg, "icons", "hicolor", "512x512", "apps", "reproductor.png"));

  const desktop = fs.readFileSync(r.escritorio, "utf8");
  assert.ok(desktop.includes(`Exec=${escritorio.escaparExec(fakeAppImage)} %F\n`));
  assert.equal(fs.statSync(r.escritorio).mode & 0o777, 0o644);
  assert.deepEqual(fs.readFileSync(r.icono), fs.readFileSync(path.join(ROOT, "icon-512.png")));
  assert.deepEqual(fs.readdirSync(path.join(xdg, "applications")), ["reproductor.desktop"]);
  assert.deepEqual(fs.readdirSync(path.join(xdg, "icons", "hicolor", "512x512", "apps")), ["reproductor.png"]);

  if (tieneValidador()) {
    assert.doesNotThrow(() => execFileSync("desktop-file-validate", [r.escritorio], { stdio: "pipe" }));
  }

  // Reinstalar sobrescribe limpiamente sin dejar temporales.
  await escritorio.instalar({ env: { APPIMAGE: fakeAppImage, XDG_DATA_HOME: xdg }, raiz: ROOT, actualizarBase: false });
  assert.deepEqual(fs.readdirSync(path.join(xdg, "applications")), ["reproductor.desktop"]);
});

test("instalar: funciona con un package.json empaquetado (sin campo build, como dentro de app.asar)", async () => {
  const raizAsar = path.join(dir, "asar-simulado");
  fs.mkdirSync(raizAsar, { recursive: true });
  fs.writeFileSync(path.join(raizAsar, "package.json"), JSON.stringify({ name: "reproductor-mp3", description: "Desc" }));
  fs.copyFileSync(path.join(ROOT, "icon-512.png"), path.join(raizAsar, "icon-512.png"));
  const fake = path.join(dir, "empaquetado.AppImage");
  fs.writeFileSync(fake, "x");
  const xdg = path.join(dir, "xdg-asar");
  const r = await escritorio.instalar({ env: { APPIMAGE: fake, XDG_DATA_HOME: xdg }, raiz: raizAsar, actualizarBase: false });
  const desktop = fs.readFileSync(r.escritorio, "utf8");
  assert.ok(desktop.includes("Name=Reproductor\n"));
  assert.ok(desktop.includes("MimeType=audio/mpeg;"));
  assert.ok(desktop.includes("video/mp4;"));
  if (tieneValidador()) {
    assert.doesNotThrow(() => execFileSync("desktop-file-validate", [r.escritorio], { stdio: "pipe" }));
  }
});

test("instalar: cae a HOME/.local/share si no hay XDG_DATA_HOME y falla si APPIMAGE falta o es inválido", async () => {
  const fake = path.join(dir, "ok.AppImage");
  fs.writeFileSync(fake, "x");
  const home = path.join(dir, "home-falso");
  const r = await escritorio.instalar({ env: { APPIMAGE: fake, HOME: home }, raiz: ROOT, actualizarBase: false });
  assert.equal(r.escritorio, path.join(home, ".local", "share", "applications", "reproductor.desktop"));

  await assert.rejects(escritorio.instalar({ env: { HOME: home }, raiz: ROOT, actualizarBase: false }), /APPIMAGE/);
  await assert.rejects(escritorio.instalar({ env: { APPIMAGE: "relativa.AppImage", HOME: home }, raiz: ROOT, actualizarBase: false }));
  await assert.rejects(escritorio.instalar({ env: { APPIMAGE: path.join(dir, "no-existe.AppImage"), HOME: home }, raiz: ROOT, actualizarBase: false }));
  await assert.rejects(escritorio.instalar({ env: { APPIMAGE: dir, HOME: home }, raiz: ROOT, actualizarBase: false }));
});
