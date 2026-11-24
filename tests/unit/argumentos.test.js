// Argumentos del proceso principal de la app de escritorio (electron/lib/argumentos.js). No necesita Electron.
const test = require("node:test");
const assert = require("node:assert/strict");
const { analizar } = require("../../electron/lib/argumentos");

const dev = (...a) => analizar(["/ruta/electron", ".", ...a]);
const pkg = (...a) => analizar(["/opt/Reproductor/reproductor", ...a], { empaquetada: true });

test("sin argumentos", () => {
  assert.deepEqual(dev(), { smoke: false, instalarEscritorio: false, datos: null, errorDatos: null, archivos: [] });
  assert.deepEqual(pkg(), { smoke: false, instalarEscritorio: false, datos: null, errorDatos: null, archivos: [] });
});

test("en desarrollo se salta la carpeta de la app; empaquetada no", () => {
  assert.deepEqual(dev("/m/a.mp3").archivos, ["/m/a.mp3"]);
  assert.deepEqual(pkg("/m/a.mp3", "b.flac").archivos, ["/m/a.mp3", "b.flac"]);
});

test("--smoke solo en desarrollo", () => {
  assert.equal(dev("--smoke").smoke, true);
  assert.equal(pkg("--smoke").smoke, false);
  assert.equal(dev("--smoke=1").smoke, false);
});

test("--instalar-escritorio en desarrollo y empaquetada; tras «--» es archivo", () => {
  assert.equal(dev("--instalar-escritorio").instalarEscritorio, true);
  assert.equal(pkg("--instalar-escritorio").instalarEscritorio, true);
  assert.equal(pkg("--instalar-escritorio=1").instalarEscritorio, false);
  const tras = pkg("--", "--instalar-escritorio");
  assert.equal(tras.instalarEscritorio, false);
  assert.deepEqual(tras.archivos, ["--instalar-escritorio"]);
});

test("--user-data-dir exige '=' y resuelve la ruta desde cwd", () => {
  assert.equal(dev("--user-data-dir=/tmp/x/../datos").datos, "/tmp/datos");
  assert.equal(analizar(["e", ".", "--user-data-dir=relativa"], { cwd: "/tmp/cwd" }).datos, "/tmp/cwd/relativa");
  assert.equal(dev("--user-data-dir=").errorDatos !== null, true);
  const separada = analizar(["e", ".", "--user-data-dir", "perfil", "cancion.mp3"], { cwd: "/tmp/cwd" });
  assert.equal(separada.datos, null);
  assert.deepEqual(separada.archivos, ["perfil", "cancion.mp3"]);
  assert.match(separada.errorDatos, /--user-data-dir=<ruta>/);
  assert.match(dev("--user-data-dir").errorDatos, /--user-data-dir=<ruta>/);
  assert.match(dev("--user-data-dir", "").errorDatos, /--user-data-dir=<ruta>/);
  assert.equal(pkg("--user-data-dir=/tmp/d").datos, "/tmp/d");
});

test("las opciones desconocidas (también las de Chromium) se ignoran; tras «--» todo son archivos", () => {
  const r = dev("--ozone-platform=wayland", "-x", "/m/a.mp3", "--", "--smoke", "-raro.mp3");
  assert.equal(r.smoke, false);
  assert.deepEqual(r.archivos, ["/m/a.mp3", "--smoke", "-raro.mp3"]);
});

test("valores que no son texto o vacíos se ignoran", () => {
  assert.deepEqual(analizar(["e", ".", "", undefined, 3, "a.mp3"]).archivos, ["a.mp3"]);
});

test("archivos con espacios, acentos y URLs file:// se pasan tal cual (rutas.js los valida)", () => {
  assert.deepEqual(dev("/m/dos  espacios ñ.mp3", "file:///m/a%20b.mp3", "relativa con espacio.flac").archivos,
    ["/m/dos  espacios ñ.mp3", "file:///m/a%20b.mp3", "relativa con espacio.flac"]);
});

test("argv de una segunda instancia (con opciones que añade Chromium y «--») da solo los archivos", () => {
  const r = pkg("--enable-features=X", "/m/a.mp3", "--user-data-dir=/tmp/d", "/m/b c.ogg");
  assert.deepEqual(r.archivos, ["/m/a.mp3", "/m/b c.ogg"]);
  assert.equal(r.smoke, false);

  const conSeparador = pkg("--enable-features=X", "--", "/m/a.mp3", "--raro.mp3", "/m/b c.ogg");
  assert.deepEqual(conSeparador.archivos, ["/m/a.mp3", "--raro.mp3", "/m/b c.ogg"]);
  assert.equal(conSeparador.smoke, false);
  assert.equal(conSeparador.instalarEscritorio, false);

  // Chromium antepone flags y desplaza los posicionales; el error no consume la canción.
  const flagSeparado = pkg("--user-data-dir", "cancion.mp3", "/tmp/perfil");
  assert.match(flagSeparado.errorDatos, /--user-data-dir=<ruta>/);
  assert.deepEqual(flagSeparado.archivos, ["cancion.mp3", "/tmp/perfil"]);
});
