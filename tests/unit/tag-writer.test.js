const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { cat, bytesOf, sameBytes, fakeImage, fakeAudio, flacPicture, flacFile, flacBlocks, id3Tag, textFrame, apicFrame, id3Frame, mp3File, plain, STREAMINFO } = h;

const g = h.load("lyrics.js", "id3.js", "tags.js", "tag-writer.js");
const Tags = g("Tags");
const ID3 = g("ID3");
const TagWriter = g("TagWriter");

const imageBlob = (bytes, type = "image/png") => new Blob([bytes], { type });
const reread = (blob, name = "copia.mp3") => Tags.read(new File([blob], name));
const text = (m) => plain([m.title, m.artist, m.album]);
const tail = async (blob, n) => (await bytesOf(blob)).subarray(-n);

/* ---------- kind ---------- */

test("kind: reconoce FLAC y MP3 y rechaza el resto", async () => {
  assert.equal(await TagWriter.kind(flacFile({})), "flac");
  assert.equal(await TagWriter.kind(mp3File(id3Tag({ ver: 3 }))), "mp3");
  assert.equal(await TagWriter.kind(mp3File(cat([0xff, 0xfb, 0x90, 0], fakeAudio(20)), fakeAudio(1))), "mp3"); // sin etiqueta, con sincronía MPEG
  assert.equal(await TagWriter.kind(mp3File(id3Tag({ ver: 3 }), fakeAudio(), "pista.bin")), null);
  assert.equal(await TagWriter.kind(new File([cat("RIFF....WAVE")], "x.wav")), null);
  assert.equal(await TagWriter.kind(h.oggVorbisFile(["TITLE=x"])), null);
});

/* ---------- MP3 ---------- */

test("MP3 v2.3: cambia título/artista/álbum, conserva el resto de marcos byte a byte y el audio", async () => {
  const audio = fakeAudio(900);
  const tcon = textFrame(3, "TCON", "Rock", 0);
  const trck = textFrame(3, "TRCK", "7/12", 0);
  const file = mp3File(id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "Viejo"), textFrame(3, "TPE1", "Viejo artista"), tcon, trck, textFrame(3, "TALB", "Viejo álbum")] }), audio);

  const out = await TagWriter.write(file, "mp3", { title: "Nuevo ñ 日本", artist: "Nuevo artista", album: "Nuevo álbum" });
  assert.deepEqual(text(await reread(out)), ["Nuevo ñ 日本", "Nuevo artista", "Nuevo álbum"]);

  const parsed = await ID3.parse(new File([out], "x.mp3"));
  assert.equal(parsed.version, 3);
  const raw = Object.fromEntries(parsed.frames.map((f) => [f.id, f.raw]));
  assert.ok(sameBytes(raw.TCON, tcon), "TCON cambió");
  assert.ok(sameBytes(raw.TRCK, trck), "TRCK cambió");
  assert.ok(sameBytes(await tail(out, audio.length), audio), "el audio cambió");
  assert.equal(parsed.frames.filter((f) => f.id === "TIT2").length, 1);
});

test("MP3 v2.4 se mantiene en v2.4 y usa UTF-8", async () => {
  const file = mp3File(id3Tag({ ver: 4, frames: [textFrame(4, "TIT2", "Viejo")] }));
  const out = await TagWriter.write(file, "mp3", { title: "Título ñ 日本" });
  const parsed = await ID3.parse(new File([out], "x.mp3"));
  assert.equal(parsed.version, 4);
  assert.equal((await reread(out)).title, "Título ñ 日本");
  assert.equal(parsed.frames.find((f) => f.id === "TIT2").data[0], 3); // codificación UTF-8
});

test("MP3: un artista o álbum vacío elimina la etiqueta; lo no editado se queda", async () => {
  const file = mp3File(id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "T"), textFrame(3, "TPE1", "A"), textFrame(3, "TALB", "L")] }));
  const out = await TagWriter.write(file, "mp3", { artist: "", album: "" });
  const parsed = await ID3.parse(new File([out], "x.mp3"));
  assert.deepEqual(plain(parsed.frames.map((f) => f.id)), ["TIT2"]);
  assert.deepEqual(text(await reread(out)), ["T", "", ""]);
});

test("MP3: carátula nueva, reemplazada y eliminada", async () => {
  const antigua = fakeImage(300, 1);
  const nueva = fakeImage(450, 2);
  const file = mp3File(id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "T"), apicFrame(3, antigua)] }));

  const reemplazada = await TagWriter.write(file, "mp3", { cover: imageBlob(nueva) });
  const m = await reread(reemplazada);
  assert.equal(m.cover.type, "image/png");
  assert.ok(sameBytes(await bytesOf(m.cover), nueva));
  assert.equal((await ID3.parse(new File([reemplazada], "x.mp3"))).frames.filter((f) => f.id === "APIC").length, 1);

  const quitada = await TagWriter.write(file, "mp3", { cover: false });
  assert.equal((await reread(quitada)).cover, null);
  assert.equal((await reread(quitada)).title, "T");

  const sinCambios = await TagWriter.write(file, "mp3", { title: "Otro" }); // no se toca la carátula
  assert.ok(sameBytes(await bytesOf((await reread(sinCambios)).cover), antigua));
});

test("MP3 sin etiqueta: se crea una ID3v2.4 solo con lo editado", async () => {
  const audio = cat([0xff, 0xfb, 0x90, 0x00], fakeAudio(300));
  const file = new File([audio], "limpio.mp3");
  assert.equal(await TagWriter.kind(file), "mp3");
  const out = await TagWriter.write(file, "mp3", { title: "Nuevo", cover: imageBlob(fakeImage(100)) });
  const parsed = await ID3.parse(new File([out], "x.mp3"));
  assert.equal(parsed.version, 4);
  assert.equal((await reread(out)).title, "Nuevo");
  assert.ok(sameBytes(await tail(out, audio.length), audio));
});

test("MP3 con ID3v2.2: se escribe v2.4 con lo editado y el audio intacto", async () => {
  const audio = fakeAudio(200);
  const file = mp3File(id3Tag({ ver: 2, frames: [textFrame(2, "TT2", "Viejo"), textFrame(2, "TP1", "Artista viejo")] }), audio);
  const out = await TagWriter.write(file, "mp3", { title: "Nuevo" });
  assert.equal((await ID3.parse(new File([out], "x.mp3"))).version, 4);
  assert.equal((await reread(out)).title, "Nuevo");
  assert.ok(sameBytes(await tail(out, audio.length), audio));
});

test("MP3 con unsincronización y cabecera extendida: la copia sale limpia y conserva los demás marcos", async () => {
  const audio = fakeAudio(300);
  const tcon = textFrame(3, "TCON", "Jazz", 1); // con BOM FF FE: obliga a unsincronizar
  const file = mp3File(id3Tag({ ver: 3, unsyncTag: true, extHeader: true, frames: [textFrame(3, "TIT2", "Viejo"), textFrame(3, "TPE1", "Artista"), tcon] }), audio);
  const out = await TagWriter.write(file, "mp3", { title: "Nuevo" });

  const bytes = await bytesOf(out);
  assert.equal(bytes[5], 0, "las banderas de unsincronización/extendida deberían estar a cero");
  const parsed = await ID3.parse(new File([out], "x.mp3"));
  assert.ok(sameBytes(parsed.frames.find((f) => f.id === "TCON").raw, tcon));
  assert.deepEqual(text(await reread(out)), ["Nuevo", "Artista", ""]);
  assert.ok(sameBytes(await tail(out, audio.length), audio));
});

test("MP3 v2.4 con pie: el pie viejo no se arrastra al audio", async () => {
  const audio = fakeAudio(200);
  const file = mp3File(id3Tag({ ver: 4, footer: true, frames: [textFrame(4, "TIT2", "Viejo")] }), audio);
  const out = await TagWriter.write(file, "mp3", { title: "Nuevo" });
  const parsed = await ID3.parse(new File([out], "x.mp3"));
  assert.ok(sameBytes(await bytesOf(out.slice(parsed.audioStart)), audio));
});

test("MP3: sin ediciones la copia se lee igual", async () => {
  const file = mp3File(id3Tag({ ver: 3, frames: [textFrame(3, "TIT2", "T"), textFrame(3, "TPE1", "A"), apicFrame(3, fakeImage(80))] }));
  const out = await TagWriter.write(file, "mp3", {});
  assert.deepEqual(text(await reread(out)), ["T", "A", ""]);
  assert.ok((await reread(out)).cover);
});

/* ---------- FLAC ---------- */

test("FLAC: sustituye solo las claves editadas (sin distinguir mayúsculas) y conserva las demás", async () => {
  const audio = fakeAudio(800);
  const file = flacFile({ entries: ["title=Viejo", "Artist=Viejo artista", "ARTIST=Segundo artista", "GENRE=Rock", "TRACKNUMBER=7", "COMMENT=Se queda"], audio });
  const out = await TagWriter.write(file, "flac", { title: "Nuevo ñ 日本", artist: "Nuevo artista", album: "Nuevo álbum" });

  assert.deepEqual(text(await reread(out, "x.flac")), ["Nuevo ñ 日本", "Nuevo artista", "Nuevo álbum"]);
  const { blocks } = flacBlocks(await bytesOf(out));
  const comments = new TextDecoder().decode(blocks.find((b) => b.type === 4).data);
  for (const keep of ["GENRE=Rock", "TRACKNUMBER=7", "COMMENT=Se queda"]) assert.ok(comments.includes(keep), keep);
  assert.ok(!comments.includes("Viejo") && !comments.includes("Segundo"), "quedan valores viejos");
  assert.ok(sameBytes(await tail(out, audio.length), audio));
});

test("FLAC: estructura válida (STREAMINFO primero e intacto, un solo bloque «último», sin relleno)", async () => {
  const file = flacFile({ entries: ["TITLE=x"], padding: 4096, apps: [cat("abcd", [1, 2, 3])], pictures: [flacPicture(fakeImage(100))] });
  const out = await TagWriter.write(file, "flac", { title: "y" });
  const { blocks, audioStart } = flacBlocks(await bytesOf(out));
  assert.equal(blocks[0].type, 0);
  assert.ok(sameBytes(blocks[0].data, STREAMINFO));
  assert.deepEqual(plain(blocks.map((b) => b.last)), blocks.map((_, i) => i === blocks.length - 1));
  assert.ok(!blocks.some((b) => b.type === 1), "el relleno debería haberse eliminado");
  assert.ok(blocks.some((b) => b.type === 2), "se perdió el bloque APPLICATION");
  assert.equal(audioStart, (await bytesOf(out)).length - 600);
});

test("FLAC: carátula nueva sustituye a todas las anteriores; false las quita; sin tocar se conserva", async () => {
  const frontal = fakeImage(200, 1);
  const trasera = fakeImage(150, 2);
  const nueva = fakeImage(260, 3);
  const file = flacFile({ entries: ["TITLE=x"], pictures: [flacPicture(frontal, { type: 3 }), flacPicture(trasera, { type: 4 })] });

  const reemplazada = await TagWriter.write(file, "flac", { cover: imageBlob(nueva, "image/jpeg") });
  const pics = flacBlocks(await bytesOf(reemplazada)).blocks.filter((b) => b.type === 6);
  assert.equal(pics.length, 1);
  const m = await reread(reemplazada, "x.flac");
  assert.equal(m.cover.type, "image/jpeg");
  assert.ok(sameBytes(await bytesOf(m.cover), nueva));

  assert.equal((await reread(await TagWriter.write(file, "flac", { cover: false }), "x.flac")).cover, null);
  const intacta = await reread(await TagWriter.write(file, "flac", { title: "otro" }), "x.flac");
  assert.ok(sameBytes(await bytesOf(intacta.cover), frontal));
});

test("FLAC sin comentarios: se crea el bloque Vorbis", async () => {
  const out = await TagWriter.write(flacFile({}), "flac", { title: "Nuevo", artist: "Artista" });
  assert.deepEqual(text(await reread(out, "x.flac")), ["Nuevo", "Artista", ""]);
  const vendor = new TextDecoder().decode(flacBlocks(await bytesOf(out)).blocks.find((b) => b.type === 4).data);
  assert.ok(vendor.includes("reproductor-mp3"));
});

test("FLAC: escribir dos veces lo mismo no hace crecer el archivo", async () => {
  const once = await TagWriter.write(flacFile({ entries: ["TITLE=a"] }), "flac", { title: "b" });
  const twice = await TagWriter.write(new File([once], "x.flac"), "flac", { title: "b" });
  assert.equal(twice.size, once.size);
});

test("FLAC: archivos incompletos o sin STREAMINFO se rechazan en vez de generar basura", async () => {
  await assert.rejects(TagWriter.write(new File([cat("fLaC", [0x80 | 4, 0, 0, 4], "abcd")], "x.flac"), "flac", { title: "x" }));
  await assert.rejects(TagWriter.write(new File([cat("fLaC")], "x.flac"), "flac", { title: "x" }));
});

test("el original nunca se modifica", async () => {
  const bytes = await bytesOf(flacFile({ entries: ["TITLE=x"] }));
  const file = new File([bytes], "x.flac");
  await TagWriter.write(file, "flac", { title: "y", cover: imageBlob(fakeImage(50)) });
  assert.ok(sameBytes(await bytesOf(file), bytes));
});
