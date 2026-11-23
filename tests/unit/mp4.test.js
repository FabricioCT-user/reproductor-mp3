const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { cat, be32, fakeAudio, bytesOf, sameBytes } = h;

const MP4 = h.load("mp4.js")("MP4");

const fourcc = (t) => [...t].map((c) => c.charCodeAt(0));
const box = (type, ...content) => {
  const body = cat(...content);
  return cat(be32(8 + body.length), fourcc(type), body);
};
// Átomo con tamaño de 64 bits (size = 1).
const box64 = (type, ...content) => {
  const body = cat(...content);
  return cat(be32(1), fourcc(type), be32(0), be32(16 + body.length), body);
};
// Átomo con size = 0 (hasta el final del padre).
const boxToEnd = (type, ...content) => cat(be32(0), fourcc(type), ...content);
const file = (...parts) => new File([cat(...parts)], "x.mp4");
const types = (list) => Array.from(list, (b) => b.type);

test("children: lista los átomos de nivel superior con posiciones absolutas", async () => {
  const f = file(box("ftyp", "isom", be32(0)), box("mdat", fakeAudio(50)), box("moov", box("mvhd", [1, 2, 3])));
  const top = await MP4.children(f);
  assert.deepEqual(types(top), ["ftyp", "mdat", "moov"]);
  assert.equal(top[0].start, 8);
  assert.equal(top[1].end - top[1].start, 50);
  assert.equal(top[2].end, f.size);
});

test("tamaños de 64 bits en el nivel superior y también en hijos", async () => {
  const f = file(box("ftyp", "isom"), box64("moov", box64("udta", box("free", [9, 9])), box("mvhd", [0])));
  const moov = await MP4.moov(f);
  assert.equal(moov.hdr, 16);
  const kids = await MP4.children(f, moov);
  assert.deepEqual(types(kids), ["udta", "mvhd"]);
  assert.equal(kids[0].hdr, 16);
  assert.deepEqual(types(await MP4.children(f, kids[0])), ["free"]);
});

test("size = 0 llega hasta el final del padre (nivel superior y en hijos)", async () => {
  const f = file(box("ftyp", "isom"), boxToEnd("moov", box("mvhd", [0]), boxToEnd("udta", [1, 2, 3, 4, 5])));
  const moov = await MP4.moov(f);
  assert.equal(moov.end, f.size);
  const [mvhd, udta] = await MP4.children(f, moov);
  assert.equal(mvhd.type, "mvhd");
  assert.equal(udta.type, "udta");
  assert.equal(udta.end, moov.end);
  assert.equal(udta.end - udta.start, 5);
});

test("átomos truncados o con tamaño inválido detienen el recorrido sin lanzar", async () => {
  const bad = cat(box("ftyp", "isom"), be32(5), fourcc("junk"), [0, 0]); // size < 8
  assert.deepEqual(types(await MP4.children(new File([bad], "a.mp4"))), ["ftyp"]);
  const over = cat(box("ftyp", "isom"), be32(9999), fourcc("moov"), [1, 2]); // se sale del archivo
  assert.equal(await MP4.moov(new File([over], "b.mp4")), undefined);
  assert.equal((await MP4.children(new File([Uint8Array.of(1, 2, 3)], "c.mp4"))).length, 0);
});

test("find y findPath: ruta anidada, «meta» salta sus 4 bytes de versión", async () => {
  const ilst = box("ilst", box("©nam", box("data", be32(1), be32(0), "Hola")));
  const f = file(box("ftyp", "M4A "), box("moov", box("trak", box("tkhd", [0])), box("udta", box("meta", be32(0), ilst))));
  const moov = await MP4.moov(f);
  const found = await MP4.findPath(f, moov, ["udta", "meta", "ilst"]);
  assert.equal(found.type, "ilst");
  assert.equal(await MP4.findPath(f, moov, ["udta", "nada"]), undefined);
  assert.equal(await MP4.find(f, moov, "trak").then((b) => b.type), "trak");
  const [item] = await MP4.children(f, found);
  assert.equal(item.type, "©nam");
});

test("payload devuelve el contenido sin cabecera y respeta el máximo", async () => {
  const f = file(box("ftyp", "isom"), box("free", [7, 8, 9]));
  const free = (await MP4.children(f))[1];
  assert.deepEqual([...(await MP4.payload(f, free))], [7, 8, 9]);
  assert.equal(await MP4.payload(f, free, 2), null);
});

// Archivo que cuenta cuántos bytes se leen de verdad.
function spyFile(parts) {
  const inner = new File([cat(...parts)], "v.mp4");
  const log = { read: 0 };
  return {
    log,
    size: inner.size,
    slice(a, b) {
      const s = inner.slice(a, b);
      log.read += s.size;
      return s;
    },
  };
}

test("lectura incremental: no lee mdat ni stbl al recorrer el moov", async () => {
  const bigStbl = box("stbl", box("stsd", fakeAudio(200000)));
  const parts = [
    box("ftyp", "isom"),
    box("mdat", fakeAudio(500000)),
    box("moov", box("mvhd", [0]), box("trak", box("mdia", box("minf", bigStbl))), box("udta", box("free", [1]))),
  ];
  const f = spyFile(parts);
  const tree = await MP4.readTree(f);
  assert.ok(f.log.read < 2000, `leyó ${f.log.read} bytes`);
  const trak = tree.children.find((c) => c.type === "trak");
  const minf = trak.children[0].children[0];
  assert.equal(minf.type, "minf");
  assert.deepEqual(types(minf.children), ["stbl"]);
  assert.equal(minf.children[0].children, undefined); // no se entró en stbl
  assert.ok(tree.children.some((c) => c.type === "udta" && c.children[0].type === "free"));
});

test("readTree: con descend ampliado sí entra en stbl; sin moov devuelve null", async () => {
  const f = file(box("ftyp", "isom"), box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stsd", [0])))))));
  const tree = await MP4.readTree(f, { descend: [...MP4.DESCEND, "stbl"] });
  const stbl = tree.children[0].children[0].children[0].children[0];
  assert.equal(stbl.type, "stbl");
  assert.deepEqual(types(stbl.children), ["stsd"]);
  assert.equal(await MP4.readTree(file(box("ftyp", "isom"))), null);
});

test("kind clasifica por hdlr: MP4 solo audio y MP4 con pista vide", async () => {
  const track = (handler) => box("trak", box("mdia", box("hdlr", be32(0), be32(0), handler, [0, 0, 0, 0])));
  const audio = file(box("ftyp", "isom"), box("mdat", fakeAudio(50000)), box("moov", track("soun")));
  const video = file(box("ftyp", "isom"), box("moov", track("vide"), track("soun")));
  assert.equal(await MP4.kind(audio), "audio");
  assert.equal(await MP4.kind(video), "video");
});

test("moov tras un mdat enorme (64 bits) se alcanza saltando, sin leerlo", async () => {
  const f = spyFile([box("ftyp", "isom"), box64("mdat", fakeAudio(300000)), box("moov", box("mvhd", [0]))]);
  const moov = await MP4.moov(f);
  assert.equal(moov.type, "moov");
  assert.ok(f.log.read < 200);
});

test("carátula: payload idéntico al original", async () => {
  const img = fakeAudio(64);
  const f = file(box("ftyp", "isom"), box("moov", box("free", img)));
  const free = await MP4.find(f, await MP4.moov(f), "free");
  assert.ok(sameBytes(await MP4.payload(f, free), img));
  assert.ok(sameBytes(await bytesOf(f.slice(free.start, free.end)), img));
});

test("findPath sin padre (archivo sin moov) no busca en la raíz", async () => {
  const f = file(box("ftyp", "isom"), box("udta", box("free", [1])));
  assert.equal(await MP4.moov(f), undefined);
  assert.equal(await MP4.findPath(f, await MP4.moov(f), ["udta"]), undefined);
});
