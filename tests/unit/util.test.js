const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./helpers");

const g = load("util.js");
const U = Object.fromEntries(["clamp", "cleanPlaylists", "formatTime", "isLrc", "isListFile", "isAudio", "fileKey", "pathOf", "dirOf", "byPath", "safeName", "fmtFreq", "fmtGain", "fmtSpeed", "fmtClock"].map((n) => [n, g(n)]));
const file = (name, type = "", extra = {}) => ({ name, type, size: 10, lastModified: 5, ...extra });

test("isAudio: por tipo MIME o por extensión", () => {
  assert.equal(U.isAudio(file("a.mp3", "audio/mpeg")), true);
  assert.equal(U.isAudio(file("a.flac", "")), true); // algunos sistemas no informan del tipo
  assert.equal(U.isAudio(file("A.M4A", "")), true);
  assert.equal(U.isAudio(file("a.opus", "audio/ogg")), true);
  assert.equal(U.isAudio(file("foto.jpg", "image/jpeg")), false);
  assert.equal(U.isAudio(file("notas.txt", "text/plain")), false);
});

test("isAudio: letras y listas nunca son canciones, aunque el sistema las marque como audio/*", () => {
  assert.equal(U.isAudio(file("lista.m3u8", "audio/x-mpegurl")), false);
  assert.equal(U.isAudio(file("lista.m3u", "audio/mpegurl")), false);
  assert.equal(U.isAudio(file("copia.json", "audio/x-whatever")), false);
  assert.equal(U.isAudio(file("a.lrc", "audio/x-lrc")), false);
  assert.equal(U.isLrc(file("a.LRC")), true);
  assert.equal(U.isListFile(file("x.M3U8")), true);
  assert.equal(U.isListFile(file("x.mp3")), false);
});

test("rutas: pathOf, dirOf y orden natural por ruta", () => {
  assert.equal(U.pathOf(file("a.mp3")), "a.mp3");
  assert.equal(U.pathOf(file("a.mp3", "", { webkitRelativePath: "Disco/a.mp3" })), "Disco/a.mp3");
  assert.equal(U.pathOf(file("a.mp3", "", { relPath: "X/Y/a.mp3", webkitRelativePath: "ignorada/a.mp3" })), "X/Y/a.mp3");
  assert.equal(U.dirOf("A/B/c.mp3"), "A/B");
  assert.equal(U.dirOf("c.mp3"), "");
  const names = ["Disco/10.mp3", "Disco/2.mp3", "disco/1.mp3", "Disco/CD2/1.mp3"].map((n) => file(n.split("/").pop(), "", { relPath: n }));
  assert.deepEqual(plain(names.sort(U.byPath).map(U.pathOf)), ["disco/1.mp3", "Disco/2.mp3", "Disco/10.mp3", "Disco/CD2/1.mp3"]);
});

test("fileKey distingue por nombre, tamaño y fecha", () => {
  const a = U.fileKey(file("a.mp3"));
  assert.notEqual(a, U.fileKey(file("a.mp3", "", { size: 11 })));
  assert.notEqual(a, U.fileKey(file("a.mp3", "", { lastModified: 6 })));
  assert.equal(a, U.fileKey(file("a.mp3")));
});

test("cleanPlaylists descarta basura y rellena lo que falta", () => {
  assert.deepEqual(plain(U.cleanPlaylists("no")), []);
  assert.deepEqual(plain(U.cleanPlaylists(null)), []);
  const out = U.cleanPlaylists([
    { id: "a", name: "Buena", ids: [1, 2] },
    { id: 5, name: "id numérico", ids: [] },
    { id: "b", name: "sin ids" },
    null,
    { id: "c", name: "Con pendientes", ids: [], pending: [{ file: "x.mp3" }, { file: 3 }, null] },
  ]);
  assert.deepEqual(plain(out), [
    { id: "a", name: "Buena", ids: [1, 2], pending: [] },
    { id: "c", name: "Con pendientes", ids: [], pending: [{ file: "x.mp3" }] },
  ]);
});

test("formatos de tiempo, velocidad y bandas", () => {
  assert.equal(U.formatTime(0), "0:00");
  assert.equal(U.formatTime(75.9), "1:15");
  assert.equal(U.formatTime(3725), "62:05");
  assert.equal(U.formatTime(NaN), "0:00");
  assert.equal(U.formatTime(Infinity), "0:00");
  assert.equal(U.fmtClock(0), "0:00");
  assert.equal(U.fmtClock(59_001), "1:00");
  assert.equal(U.fmtClock(3_661_000), "1:01:01");
  assert.equal(U.fmtSpeed(1), "1×");
  assert.equal(U.fmtSpeed(1.25), "1.25×");
  assert.equal(U.fmtSpeed(1.5000001), "1.5×");
  assert.equal(U.fmtFreq(500), 500);
  assert.equal(U.fmtFreq(16000), "16k");
  assert.equal(U.fmtGain(3), "+3");
  assert.equal(U.fmtGain(-2), "-2");
  assert.equal(U.fmtGain(0), "0");
});

test("safeName quita caracteres no válidos en nombres de archivo y nunca queda vacío", () => {
  assert.equal(U.safeName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(U.safeName("  Mi lista  "), "Mi lista");
  assert.equal(U.safeName("///"), "_");
  assert.equal(U.safeName("   "), "lista");
});

test("clamp", () => {
  assert.equal(U.clamp(5, 0, 2), 2);
  assert.equal(U.clamp(-1, 0, 2), 0);
  assert.equal(U.clamp(1.5, 0, 2), 1.5);
});
