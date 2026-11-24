const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { rutaDatos } = require("../../electron/lib/ruta-datos");

test("ruta de datos: conserva el perfil 1.0.0 con y sin XDG_CONFIG_HOME", () => {
  assert.equal(rutaDatos({ xdgConfigHome: "/tmp/xdg", home: "/home/ana" }), "/tmp/xdg/reproductor-mp3");
  assert.equal(rutaDatos({ home: "/home/ana" }), "/home/ana/.config/reproductor-mp3");
});

test("ruta de datos: --user-data-dir tiene prioridad y se normaliza", () => {
  assert.equal(rutaDatos({ xdgConfigHome: "/tmp/xdg", home: "/home/ana", userDataDir: "/tmp/perfil/../datos" }), "/tmp/datos");
  assert.equal(rutaDatos({ home: "/home/ana", userDataDir: "relativa" }), "/home/ana/.config/reproductor-mp3");
});

test("Electron fija userData antes de pedir instancia única", () => {
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.js"), "utf8");
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("app.requestSingleInstanceLock()"));
  assert.match(main, /userDataDir:\s*args\.datos/);
});

