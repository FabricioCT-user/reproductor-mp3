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

/* ---------- stsd y cadenas de códecs (T3.1) ---------- */

const visualEntry = (type, ...children) => box(type, new Uint8Array(78), ...children);
const audioEntry = (type, ...children) => box(type, new Uint8Array(28), ...children);
const stsdPayload = (...entries) => cat(be32(0), be32(entries.length), ...entries);
const stsdTrack = (handler, ...entries) =>
  box("trak", box("mdia",
    ...(handler ? [box("hdlr", be32(0), be32(0), handler, [0, 0, 0, 0])] : []),
    box("minf", box("stbl", box("stsd", stsdPayload(...entries))))
  ));

// Construye un descriptor MPEG-4 (tag + longitud de 1 byte o 4 bytes al estilo ffmpeg).
const desc = (tag, body, longLen = false) => {
  const b = cat(body);
  const len = longLen ? [0x80, 0x80, 0x80, b.length] : [b.length];
  return cat([tag], len, b);
};

test("stsd: avc1 desde avcC y fallback sin avcC", () => {
  const avcC = box("avcC", [1, 0x64, 0x00, 0x28, 0xff]);
  const avcCMain = box("avcC", [1, 0x4d, 0x40, 0x1f]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("avc1", avcC)), "vide")), ["avc1.640028"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("avc1", avcCMain)), "vide")), ["avc1.4D401F"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("avc1")), "vide")), ["avc1"]);
});

test("stsd: hvc1 y hev1 desde hvcC (perfil, compatibilidad invertida, nivel y restricciones)", () => {
  // Main (1), tier L (0), compat 0x60000000 → invertido 0x6, constraints [0xB0,0,0,0,0,0], level 93 (3.1)
  const hvcCMain = box("hvcC", [1, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0, 0, 0, 0, 0, 93]);
  // Space A (1<<6), tier H (1<<5), Main 10 (2) → 0x62; compat 0x20000000 → 4; constraints [0x90, 0x00, 0x08, 0,0,0]; level 120
  const hvcCMain10 = box("hvcC", [1, 0x62, 0x20, 0x00, 0x00, 0x00, 0x90, 0x00, 0x08, 0, 0, 0, 120]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("hvc1", hvcCMain)), "vide")), ["hvc1.1.6.L93.B0"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("hev1", hvcCMain10)), "vide")), ["hev1.A2.4.H120.90.0.8"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("hvc1", box("hvcC", [1, 2]))), "vide")), ["hvc1"]);
});

test("stsd: av01 desde av1C y vp09 desde vpcC", () => {
  // av01: profile 0, level 4, tier M, 8-bit → av01.0.04M.08; profile 2, level 12, tier H, 12-bit → av01.2.12H.12
  const av1C8 = box("av1C", [0x81, 0x04, 0x0c, 0x00]);
  const av1C12 = box("av1C", [0x81, (2 << 5) | 12, 0xe0, 0x00]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("av01", av1C8)), "vide")), ["av01.0.04M.08"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("av01", av1C12)), "vide")), ["av01.2.12H.12"]);

  // vp09: vpcC es FullBox (ver=1, flags=0), profile 0, level 10, bitDepth 8 → vp09.00.10.08
  const vpcC8 = box("vpcC", [1, 0, 0, 0, 0, 10, 0x80, 0]);
  const vpcC10 = box("vpcC", [1, 0, 0, 0, 2, 41, 0xa0, 0]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("vp09", vpcC8)), "vide")), ["vp09.00.10.08"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(visualEntry("vp09", vpcC10)), "vide")), ["vp09.02.41.10"]);
});

test("stsd: mp4a desde esds (AAC-LC, HE-AAC, AOT extendido, MP3, QuickTime wave)", () => {
  const esdsBox = (oti, dsi = null, longLen = false) => {
    const d5 = dsi ? desc(0x05, dsi, longLen) : [];
    const d4 = desc(0x04, cat([oti], new Uint8Array(12), d5), longLen);
    const d3 = desc(0x03, cat([0, 1, 0], d4), longLen);
    return box("esds", be32(0), d3);
  };
  // AAC-LC: aot=2 → byte 0 = 2<<3 = 0x10 (con longitudes de 4 bytes como escribe ffmpeg)
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("mp4a", esdsBox(0x40, [0x11, 0x90], true))), "soun")), ["mp4a.40.2"]);
  // HE-AAC: aot=5 → 5<<3 = 0x28
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("mp4a", esdsBox(0x40, [0x2b, 0x92]))), "soun")), ["mp4a.40.5"]);
  // AOT extendido: 31 + 10 = 42 → top 5 bits = 31 (0xF8), siguiente 6 bits = 10 → [0xF9, 0x40]
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("mp4a", esdsBox(0x40, [0xf9, 0x40]))), "soun")), ["mp4a.40.42"]);
  // MP3 en MP4: oti = 0x6b
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("mp4a", esdsBox(0x6b))), "soun")), ["mp4a.6b"]);
  // QuickTime MOV v1 (header 44 bytes) con esds dentro de wave
  const qtHeader = new Uint8Array(44);
  qtHeader[9] = 1; // version = 1
  const qtMp4a = box("mp4a", qtHeader, box("wave", esdsBox(0x40, [0x12, 0x10])));
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(qtMp4a), "soun")), ["mp4a.40.2"]);
  // Sin esds → fallback
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("mp4a")), "soun")), ["mp4a"]);
});

test("stsd: Opus, ac-3 y ec-3", () => {
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("Opus")), "soun")), ["opus"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("ac-3")), "soun")), ["ac-3"]);
  assert.deepEqual(h.plain(MP4.parseStsd(stsdPayload(audioEntry("ec-3")), "soun")), ["ec-3"]);
});

test("codecs y probe: combina pistas vide/soun, ignora subtítulos y lee de forma incremental", async () => {
  const avcC = box("avcC", [1, 0x64, 0x00, 0x28]);
  const d4 = desc(0x04, cat([0x40], new Uint8Array(12), desc(0x05, [0x11, 0x90])));
  const esds = box("esds", be32(0), desc(0x03, cat([0, 1, 0], d4)));
  const bigStsz = box("stsz", fakeAudio(100000));
  const vTrak = box("trak", box("mdia",
    box("hdlr", be32(0), be32(0), "vide", [0, 0, 0, 0]),
    box("minf", box("stbl", box("stsd", stsdPayload(visualEntry("avc1", avcC))), bigStsz))
  ));
  const aTrak = stsdTrack("soun", audioEntry("mp4a", esds));
  const subTrak = stsdTrack("sbtl", box("tx3g", new Uint8Array(32)));
  const f = spyFile([box("ftyp", "isom"), box("mdat", fakeAudio(400000)), box("moov", vTrak, aTrak, subTrak)]);

  const info = await MP4.probe(f);
  assert.equal(info.kind, "video");
  assert.equal(info.codecs, "avc1.640028, mp4a.40.2");
  assert.ok(f.log.read < 2500, `leyó demasiados bytes: ${f.log.read}`);

  const ac3File = file(box("ftyp", "isom"), box("moov", stsdTrack("vide", visualEntry("avc1", avcC)), stsdTrack("soun", audioEntry("ac-3"))));
  assert.equal(await MP4.codecs(ac3File), "avc1.640028, ac-3");
  assert.equal(await MP4.codecs(file(box("ftyp", "isom"))), "");
});
