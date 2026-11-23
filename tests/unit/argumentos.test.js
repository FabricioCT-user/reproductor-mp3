// Argumentos del proceso principal de la app de escritorio (electron/lib/argumentos.js). No necesita Electron.
const test = require("node:test");
const assert = require("node:assert/strict");
const { analizar } = require("../../electron/lib/argumentos");

const dev = (...a) => analizar(["/ruta/electron", ".", ...a]);
const pkg = (...a) => analizar(["/opt/Reproductor/reproductor", ...a], { empaquetada: true });

test("sin argumentos", () => {
  assert.deepEqual(dev(), { smoke: false, instalarEscritorio: false, datos: null, archivos: [] });
  assert.deepEqual(pkg(), { smoke: false, instalarEscritorio: false, datos: null, archivos: [] });
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

test("--user-data-dir solo con ruta absoluta, normalizada", () => {
  assert.equal(dev("--user-data-dir=/tmp/x/../datos").datos, "/tmp/datos");
  assert.equal(dev("--user-data-dir=relativa").datos, null);
  assert.equal(dev("--user-data-dir=").datos, null);
  assert.equal(dev("--user-data-dir", "/tmp/x").datos, null); // solo la forma con «=»
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

test("argv de una segunda instancia (con opciones que añade Chromium) da solo los archivos", () => {
  const r = pkg("--enable-features=X", "/m/a.mp3", "--user-data-dir=/tmp/d", "/m/b c.ogg");
  assert.deepEqual(r.archivos, ["/m/a.mp3", "/m/b c.ogg"]);
  assert.equal(r.smoke, false);
});
