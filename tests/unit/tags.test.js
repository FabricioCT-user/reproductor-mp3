const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { cat, bytesOf, sameBytes, fakeImage, flacPicture, flacFile, oggVorbisFile, opusFile, mp4File, mp3File, id3Tag, textFrame, plain } = h;

const g = h.load("lyrics.js", "id3.js", "tags.js");
const Tags = g("Tags");
const text = (m) => plain([m.title, m.artist, m.album]);

test("FLAC: comentarios Vorbis (las claves no distinguen mayúsculas)", async () => {
  const m = await Tags.read(flacFile({ entries: ["title=Tema ñ", "ARTIST=Banda", "Album=Disco 日本", "GENRE=Rock"] }));
  assert.deepEqual(text(m), ["Tema ñ", "Banda", "Disco 日本"]);
});

test("FLAC: si falta ARTIST se usa ALBUMARTIST", async () => {
  const m = await Tags.read(flacFile({ entries: ["TITLE=x", "ALBUMARTIST=Colectivo"] }));
  assert.equal(m.artist, "Colectivo");
});

test("FLAC: prefiere la letra sincronizada a la de texto plano", async () => {
  const m = await Tags.read(flacFile({ entries: ["LYRICS=Verso uno\nVerso dos", "SYNCEDLYRICS=[00:01.00]Verso uno"] }));
  assert.equal(m.lyrics, "[00:01.00]Verso uno");
  assert.equal((await Tags.read(flacFile({ entries: ["UNSYNCEDLYRICS=Solo texto"] }))).lyrics, "Solo texto");
});

test("FLAC: carátula con el mismo contenido y MIME", async () => {
  const img = fakeImage(700);
  const m = await Tags.read(flacFile({ entries: ["TITLE=x"], pictures: [flacPicture(img, { mime: "image/jpeg", desc: "portada" })] }));
  assert.equal(m.cover.type, "image/jpeg");
  assert.ok(sameBytes(await bytesOf(m.cover), img));
});

test("FLAC: sin comentarios o truncado no falla", async () => {
  assert.deepEqual(text(await Tags.read(flacFile({}))), ["", "", ""]);
  const f = flacFile({ entries: ["TITLE=x"] });
  const truncado = new File([(await bytesOf(f)).subarray(0, 20)], "t.flac");
  assert.deepEqual(text(await Tags.read(truncado)), ["", "", ""]);
});

test("Ogg Vorbis y Opus", async () => {
  const entries = ["TITLE=Tema", "ARTIST=Banda", "ALBUM=Disco"];
  assert.deepEqual(text(await Tags.read(oggVorbisFile(entries))), ["Tema", "Banda", "Disco"]);
  assert.deepEqual(text(await Tags.read(opusFile(entries))), ["Tema", "Banda", "Disco"]);
});

test("Ogg: paquete de comentarios largo repartido en varios segmentos", async () => {
  const letra = "[00:01.00]" + "línea larga ".repeat(120);
  const m = await Tags.read(oggVorbisFile(["TITLE=Largo", `LYRICS=${letra}`]));
  assert.equal(m.title, "Largo");
  assert.equal(m.lyrics, letra);
});

test("Ogg: carátula en METADATA_BLOCK_PICTURE (base64)", async () => {
  const img = fakeImage(400, 9);
  const b64 = Buffer.from(flacPicture(img, { mime: "image/png" })).toString("base64");
  for (const make of [oggVorbisFile, opusFile]) {
    const m = await Tags.read(make(["TITLE=x", `METADATA_BLOCK_PICTURE=${b64}`]));
    assert.equal(m.cover.type, "image/png");
    assert.ok(sameBytes(await bytesOf(m.cover), img));
  }
});

test("M4A: etiquetas, letra y carátula, con el índice (moov) al final o al principio", async () => {
  const img = fakeImage(350, 3);
  const items = [
    ["©nam", h.enc.encode("Tema ñ")], ["©ART", h.enc.encode("Banda")], ["©alb", h.enc.encode("Disco")],
    ["©lyr", h.enc.encode("[00:01.00]Hola")], ["covr", img, 14],
  ];
  for (const moovAtEnd of [true, false]) {
    const m = await Tags.read(mp4File(items, { moovAtEnd }));
    assert.deepEqual(text(m), ["Tema ñ", "Banda", "Disco"], `moovAtEnd=${moovAtEnd}`);
    assert.equal(m.lyrics, "[00:01.00]Hola");
    assert.equal(m.cover.type, "image/png");
    assert.ok(sameBytes(await bytesOf(m.cover), img));
  }
});

test("M4A: usa aART si no hay ©ART y JPEG por defecto", async () => {
  const m = await Tags.read(mp4File([["aART", h.enc.encode("Del álbum")], ["covr", fakeImage(50), 13]]));
  assert.equal(m.artist, "Del álbum");
  assert.equal(m.cover.type, "image/jpeg");
});

test("MP3 se delega en el lector ID3", async () => {
  const m = await Tags.read(mp3File(id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "Desde ID3")] })));
  assert.equal(m.title, "Desde ID3");
});

test("formatos desconocidos devuelven etiquetas vacías", async () => {
  const m = await Tags.read(new File([cat("RIFF....WAVEfmt ")], "x.wav"));
  assert.deepEqual(plain({ ...m, cover: null }), { title: "", artist: "", album: "", cover: null, lyrics: "" });
});
