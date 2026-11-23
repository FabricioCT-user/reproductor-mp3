const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./helpers");

const g = load("util.js");
const U = Object.fromEntries(["clamp", "cleanPlaylists", "formatTime", "isLrc", "isListFile", "isAudio", "isVideo", "isMedia", "fileKey", "pathOf", "dirOf", "byPath", "safeName", "fmtFreq", "fmtGain", "fmtSpeed", "fmtClock", "extOf", "explainFailure", "checkCompatibility"].map((n) => [n, g(n)]));
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

test("isVideo: por tipo MIME o extensión, e isMedia admite audio y video", () => {
  for (const ext of ["mp4", "m4v", "webm", "mov", "mkv"]) {
    assert.equal(U.isVideo(file(`x.${ext}`, "")), true, ext);
    assert.equal(U.isMedia(file(`x.${ext}`, "")), true, ext);
  }
  assert.equal(U.isVideo(file("clip.bin", "video/mp4")), true);
  assert.equal(U.isVideo(file("a.mp3", "audio/mpeg")), false);
  assert.equal(U.isVideo(file("lista.m3u8", "video/mp4")), false);
  assert.equal(U.isMedia(file("cancion.mp3", "audio/mpeg")), true);
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

test("extOf extrae la extensión en minúsculas sin punto", () => {
  assert.equal(U.extOf("pelicula.MKV"), "mkv");
  assert.equal(U.extOf("video.final.mp4"), "mp4");
  assert.equal(U.extOf("sin-extension"), "");
  assert.equal(U.extOf(""), "");
});

test("explainFailure: MKV, AVI y MOV sugieren remux sin recodificar", () => {
  const mkv = U.explainFailure("video", "mkv", "");
  assert.match(mkv, /MKV/);
  assert.match(mkv, /remux/i);
  assert.ok(mkv.includes("ffmpeg -i entrada.mkv -c copy salida.mp4"), mkv);

  const avi = U.explainFailure("video", ".AVI", null);
  assert.match(avi, /AVI/);
  assert.ok(avi.includes("ffmpeg -i entrada.avi -c copy salida.mp4"), avi);

  const mov = U.explainFailure("video", "mov", "");
  assert.match(mov, /MOV/);
  assert.ok(mov.includes("ffmpeg -i entrada.mov -c copy salida.mp4"), mov);
});

test("explainFailure: códecs HEVC, AC-3, E-AC-3, AV1, VP9 y combinaciones", () => {
  assert.match(U.explainFailure("video", "mp4", "hvc1.1.6.L93.B0, mp4a.40.2"), /HEVC/i);
  assert.match(U.explainFailure("video", "mp4", "hev1.1.6.L93.B0"), /HEVC/i);

  const ac3Video = U.explainFailure("video", "mp4", "avc1.640028, ac-3");
  assert.match(ac3Video, /el audio AC-3 no es compatible/i);
  assert.match(ac3Video, /sin sonido/i);

  const eac3Video = U.explainFailure("video", "mp4", ["avc1.640028", "ec-3"]);
  assert.match(eac3Video, /el audio AC-3 no es compatible/i);
  assert.match(eac3Video, /E-AC-3/);

  const ac3Audio = U.explainFailure("audio", "m4a", "ac-3");
  assert.match(ac3Audio, /el audio AC-3 no es compatible/i);
  assert.doesNotMatch(ac3Audio, /video/i);

  const both = U.explainFailure("video", "mp4", "hvc1.1.6.L93.B0, ac-3");
  assert.match(both, /HEVC/i);
  assert.match(both, /AC-3/i);

  assert.match(U.explainFailure("video", "mp4", "av01.0.04M.08"), /AV1/);
  assert.match(U.explainFailure("video", "mp4", "vp09.00.10.08"), /VP9/);
  assert.match(U.explainFailure("video", "mp4", "mp4v"), /mp4v/);
  assert.match(U.explainFailure("video", "mp4", "avc1.640028, mp4a.40.2"), /avc1\.640028/);
  assert.match(U.explainFailure("audio", "mp3", ""), /MP3/);
  assert.match(U.explainFailure("", "", ""), /reproducir/i);
});

test("checkCompatibility: evalúa canPlayType combinado e individual (incluyendo AC-3 mudo)", () => {
  // Simula Electron 45.4.1 (TE.0): H.264, HEVC y AAC sí; AC-3 y E-AC-3 no; MKV «maybe»; QuickTime «»
  const electronCanPlay = (t) => {
    if (/ac-3|ec-3/i.test(t)) return "";
    if (/video\/x-matroska/i.test(t)) return "maybe";
    if (/video\/quicktime/i.test(t)) return "";
    if (/video\/x-msvideo/i.test(t)) return "";
    return "probably";
  };

  assert.equal(U.checkCompatibility({ kind: "video", ext: "mp4", codecs: "avc1.640028, mp4a.40.2" }, electronCanPlay).ok, true);

  const ac3 = U.checkCompatibility({ kind: "video", ext: "mp4", codecs: "avc1.640028, ac-3" }, electronCanPlay);
  assert.equal(ac3.ok, false);
  assert.equal(ac3.ac3Unsupported, true);
  assert.match(ac3.reason, /el audio AC-3 no es compatible/i);

  // Con HEVC soportado + AC-3 no soportado: solo culpa a AC-3, no a HEVC
  const hevcAc3 = U.checkCompatibility({ kind: "video", ext: "mp4", codecs: "hvc1.1.6.L93.B0, ac-3" }, electronCanPlay);
  assert.equal(hevcAc3.ok, false);
  assert.equal(hevcAc3.ac3Unsupported, true);
  assert.match(hevcAc3.reason, /AC-3/i);
  assert.doesNotMatch(hevcAc3.reason, /HEVC/i);

  // Sin soporte HEVC: señala HEVC
  const sinHevc = (t) => (/hvc1|hev1/i.test(t) ? "" : "probably");
  const hevcFail = U.checkCompatibility({ kind: "video", ext: "mp4", codecs: "hvc1.1.6.L93.B0, mp4a.40.2" }, sinHevc);
  assert.equal(hevcFail.ok, false);
  assert.equal(hevcFail.ac3Unsupported, false);
  assert.match(hevcFail.reason, /HEVC/i);

  // MKV en Electron se intenta; en navegador sin MKV avisa antes
  assert.equal(U.checkCompatibility({ kind: "video", ext: "mkv", mime: "video/x-matroska" }, electronCanPlay).ok, true);
  const mkvNo = U.checkCompatibility({ kind: "video", ext: "mkv", mime: "video/x-matroska" }, () => "");
  assert.equal(mkvNo.ok, false);
  assert.ok(mkvNo.reason.includes("ffmpeg -i entrada.mkv -c copy salida.mp4"));

  // AVI siempre avisa; MOV sin códecs no se rechaza falsamente por video/quicktime === ""
  assert.equal(U.checkCompatibility({ kind: "video", ext: "avi", mime: "video/x-msvideo" }, electronCanPlay).ok, false);
  assert.equal(U.checkCompatibility({ kind: "video", ext: "mov", mime: "video/quicktime" }, electronCanPlay).ok, true);
});
