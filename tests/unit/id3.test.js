const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { plain, cat, textFrame, apicFrame, id3Frame, id3Tag, mp3File, bytesOf, sameBytes, fakeImage, fakeAudio } = h;

const ID3 = h.load("id3.js")("ID3");
const read = async (tag, audio) => plain({ ...(await ID3.read(mp3File(tag, audio))), cover: undefined });

test("v2.3 con UTF-16 (BOM little-endian): título, artista y álbum", async () => {
  const tag = id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "Canción ñ 日本"), textFrame(3, "TPE1", "Ünico"), textFrame(3, "TALB", "Álbum")] });
  const m = await read(tag);
  assert.deepEqual([m.title, m.artist, m.album], ["Canción ñ 日本", "Ünico", "Álbum"]);
});

test("UTF-16 con BOM big-endian (usado por algunos programas)", async () => {
  const m = await read(id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "Año nuevo ñ", 2)] }));
  assert.equal(m.title, "Año nuevo ñ");
});

test("Latin-1 y NUL final se descartan", async () => {
  const m = await read(id3Tag({ ver: 3, frames: [id3Frame(3, "TIT2", cat([0], h.latin1("Cañón"), [0]))] }));
  assert.equal(m.title, "Cañón");
});

test("v2.4 con UTF-8; varios valores separados por NUL se unen con « / »", async () => {
  const m = await read(id3Tag({ ver: 4, frames: [textFrame(4, "TIT2", "Tema"), textFrame(4, "TPE1", "Uno\u0000Dos")] }));
  assert.deepEqual([m.title, m.artist], ["Tema", "Uno / Dos"]);
});

test("v2.2 (marcos de 3 letras)", async () => {
  const m = await read(id3Tag({ ver: 2, frames: [textFrame(2, "TT2", "Viejo"), textFrame(2, "TP1", "Artista"), textFrame(2, "TAL", "Disco")] }));
  assert.deepEqual([m.title, m.artist, m.album], ["Viejo", "Artista", "Disco"]);
});

test("carátula APIC: mismo contenido y tipo MIME (v2.3, v2.4 y v2.2)", async () => {
  const img = fakeImage(500);
  for (const ver of [2, 3, 4]) {
    const meta = await ID3.read(mp3File(id3Tag({ ver, frames: [textFrame(ver, ver === 2 ? "TT2" : "TIT2", "x"), apicFrame(ver, img, "image/png")] })));
    assert.ok(meta.cover, `v2.${ver} sin carátula`);
    assert.equal(meta.cover.type, ver === 2 ? "image/jpeg" : "image/png");
    assert.ok(sameBytes(await bytesOf(meta.cover), img), `v2.${ver} imagen distinta`);
  }
});

test("letra USLT", async () => {
  const body = cat([1], "eng", [0xff, 0xfe, 0, 0], [0xff, 0xfe], h.utf16le("[00:01.00]Hola\n[00:02.00]Adiós"));
  const m = await read(id3Tag({ ver: 3, frames: [id3Frame(3, "USLT", body)] }));
  assert.equal(m.lyrics, "[00:01.00]Hola\n[00:02.00]Adiós");
});

test("unsincronización de toda la etiqueta (v2.3): texto y carátula se leen bien", async () => {
  const img = Uint8Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? 0xff : i)); // muchos 0xFF
  const tag = id3Tag({ ver: 3, unsyncTag: true, frames: [textFrame(3, "TIT2", "Título"), textFrame(3, "TPE1", "Artista"), apicFrame(3, img)] });
  const meta = await ID3.read(mp3File(tag));
  assert.equal(meta.title, "Título");
  assert.equal(meta.artist, "Artista");
  assert.ok(sameBytes(await bytesOf(meta.cover), img));
});

test("unsincronización por marco (v2.4, indicador 0x0002)", async () => {
  const raw = cat([1, 0xff, 0xfe], h.utf16le("Con FF"));
  const frame = id3Frame(4, "TIT2", h.unsyncBytes(raw), [0, 2]);
  assert.equal((await read(id3Tag({ ver: 4, frames: [frame] }))).title, "Con FF");
});

test("la cabecera extendida se salta (v2.3 y v2.4)", async () => {
  for (const ver of [3, 4]) {
    const m = await read(id3Tag({ ver, extHeader: true, frames: [textFrame(ver, "TIT2", "Con extendida")] }));
    assert.equal(m.title, "Con extendida", `v2.${ver}`);
  }
});

test("los marcos comprimidos o cifrados se ignoran sin fallar", async () => {
  const comprimido = id3Frame(3, "TIT2", cat([0], "basura"), [0, 0x80]);
  const m = await read(id3Tag({ ver: 3, frames: [comprimido, textFrame(3, "TPE1", "Sigue bien")] }));
  assert.equal(m.title, "");
  assert.equal(m.artist, "Sigue bien");
});

test("ID3v2.4 con pie: el audio empieza después", async () => {
  const tag = id3Tag({ ver: 4, footer: true, frames: [textFrame(4, "TIT2", "x")] });
  const audio = fakeAudio(50);
  const parsed = await ID3.parse(mp3File(tag, audio));
  assert.equal(parsed.audioStart, tag.length);
  assert.equal(parsed.version, 4);
});

test("archivos sin etiqueta o con etiquetas rotas no lanzan errores", async () => {
  const vacio = { title: "", artist: "", album: "", lyrics: "" };
  assert.deepEqual(await read(cat("sin etiqueta ID3, solo bytes")), vacio);
  // tamaño de marco absurdo
  const roto = cat("ID3", [3, 0, 0], h.syncsafe(30), "TIT2", h.be32(9999), [0, 0], new Array(16).fill(65));
  assert.deepEqual(await read(roto), vacio);
  // etiqueta truncada a mitad
  const tag = id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "Completo")] });
  const m = await read(tag.subarray(0, 14));
  assert.equal(m.title, "");
  // versión desconocida
  assert.deepEqual(await read(cat("ID3", [9, 0, 0], h.syncsafe(4), [1, 2, 3, 4])), vacio);
});

test("parse devuelve los marcos en bruto y la versión", async () => {
  const f1 = textFrame(3, "TIT2", "a");
  const f2 = textFrame(3, "TCON", "Rock", 0);
  const parsed = await ID3.parse(mp3File(id3Tag({ ver: 3, frames: [f1, f2] })));
  assert.deepEqual(plain(parsed.frames.map((f) => f.id)), ["TIT2", "TCON"]);
  assert.ok(sameBytes(parsed.frames[1].raw, f2));
  assert.equal(await ID3.parse(new File([cat("nada")], "x.mp3")), null);
});
