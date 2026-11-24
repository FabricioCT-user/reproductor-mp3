const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { rutaDatos } = require("../../electron/lib/ruta-datos");

test("ruta de datos: conserva el perfil 1.0.0 con y sin XDG_CONFIG_HOME", () => {
  assert.equal(rutaDatos({ xdgConfigHome: "/tmp/xdg", home: "/home/ana" }), "/tmp/xdg/reproductor-mp3");
  assert.equal(rutaDatos({ home: "/home/ana" }), "/home/ana/.config/reproductor-mp3");
});

test("ruta de datos: XDG_CONFIG_HOME relativo o vacío usa appData absoluto", () => {
  assert.equal(rutaDatos({ xdgConfigHome: "relativo", home: "/home/ana", appData: "/tmp/electron-config" }), "/tmp/electron-config/reproductor-mp3");
  assert.equal(rutaDatos({ xdgConfigHome: "", home: "/home/ana", appData: "/tmp/electron-config" }), "/tmp/electron-config/reproductor-mp3");
});

test("ruta de datos: HOME vacío, relativo o ausente nunca produce ruta relativa", () => {
  for (const home of ["", "relativo", undefined]) {
    const ruta = rutaDatos({ home });
    assert.equal(path.isAbsolute(ruta), true);
    assert.equal(ruta, path.join(require("node:os").tmpdir(), "reproductor-mp3"));
    const conAppDataRelativo = rutaDatos({ home, appData: "config-relativa" });
    assert.equal(conAppDataRelativo, ruta);
  }
});

test("ruta de datos: --user-data-dir tiene prioridad, se normaliza y resuelve relativo desde cwd", () => {
  assert.equal(rutaDatos({ xdgConfigHome: "/tmp/xdg", home: "/home/ana", userDataDir: "/tmp/perfil/../datos" }), "/tmp/datos");
  assert.equal(rutaDatos({ home: "/home/ana", userDataDir: "relativa", cwd: "/tmp/trabajo" }), "/tmp/trabajo/relativa");
});

test("Electron fija userData incondicionalmente antes de pedir instancia única", () => {
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.js"), "utf8");
  const setPath = main.indexOf('app.setPath("userData"');
  const lock = main.indexOf("app.requestSingleInstanceLock()");
  const errorDatos = main.indexOf("if (args.errorDatos)");
  assert.ok(setPath >= 0, "app.setPath(userData) debe existir");
  assert.ok(lock >= 0, "debe solicitarse la instancia única");
  assert.ok(errorDatos >= 0 && errorDatos < lock, "un --user-data-dir inválido se rechaza antes de solicitar instancia única");
  assert.ok(setPath < lock, "userData se fija antes de solicitar instancia única");
  assert.match(main, /app\.setPath\("userData",\s*rutaDatos\(/);
  assert.doesNotMatch(main, /if\s*\([^)]*args\.datos[^)]*\)\s*\{[^}]*app\.setPath\("userData"/s,
    "userData debe fijarse también cuando no se proporcionó --user-data-dir");
  assert.doesNotMatch(main, /if\s*\(\s*args\.datos\s*\)\s*app\.setPath\("userData"/,
    "app.setPath no debe quedar condicionado a args.datos");
  assert.match(main, /appData:\s*app\.getPath\("appData"\)/);
  assert.match(main, /if\s*\(args\.smoke\s*&&\s*!args\.datos\)/, "--smoke exige ruta temporal explícita");
});

test("second-instance conserva archivos si Chromium reordena un user-data-dir inválido", () => {
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.js"), "utf8");
  assert.match(main, /if\s*\(argsSegunda\.errorDatos\)\s*console\.error/);
  assert.match(main, /registrar\(argsSegunda\.archivos,\s*cwd\)/);
  assert.doesNotMatch(main, /if\s*\(argsSegunda\.errorDatos\)[^\n]*\b(?:return|app\.quit|process\.exit)/);
});

