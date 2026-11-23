const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { cat, enc, fakeAudio } = h;

const MKV = h.load("mkv.js")("MKV");

// Codifica un tamaño EBML VINT (1, 2, 4 u 8 bytes).
function vintSize(n, width = 0) {
  const w = width || (n < 0x7f ? 1 : n < 0x3fff ? 2 : 4);
  if (w === 1) return [0x80 | n];
  if (w === 2) return [0x40 | ((n >>> 8) & 0x3f), n & 0xff];
  if (w === 4) return [0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  if (w === 8) return [0x01, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  throw new Error(`ancho no soportado: ${w}`);
}

const UNKNOWN_8 = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const elem = (id, body, sizeBytes) => {
  const b = cat(body);
  return cat(id, sizeBytes || vintSize(b.length), b);
};

const ebmlHead = (docType = "matroska") =>
  elem([0x1a, 0x45, 0xdf, 0xa3], cat(
    elem([0x42, 0x86], [1]),
    elem([0x42, 0x82], enc.encode(docType)),
  ));

const trackEntry = (codecId, { trackType = 0, extra = [], sizeBytes } = {}) =>
  elem([0xae], cat(
    elem([0xd7], [1]), // TrackNumber
    ...(trackType ? [elem([0x83], [trackType])] : []),
    elem([0x86], enc.encode(codecId)),
    ...extra,
  ), sizeBytes);

const tracksElem = (entries, sizeBytes) => elem([0x16, 0x54, 0xae, 0x6b], cat(...entries), sizeBytes);
const segmentElem = (children, sizeBytes) => elem([0x18, 0x53, 0x80, 0x67], cat(...children), sizeBytes);
const infoElem = () => elem([0x15, 0x49, 0xa9, 0x66], elem([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]));
const seekHeadElem = () => elem([0x11, 0x4d, 0x9b, 0x74], new Uint8Array(24));
const voidElem = (n) => elem([0xec], new Uint8Array(n));
const clusterElem = (data, sizeBytes) => elem([0x1f, 0x43, 0xb6, 0x75], data, sizeBytes);

test("WebM solo audio (A_OPUS y A_VORBIS) se detecta como audio con su CodecID", () => {
  const opus = cat(ebmlHead("webm"), segmentElem([infoElem(), tracksElem([trackEntry("A_OPUS", { trackType: 2 })])], UNKNOWN_8));
  assert.deepEqual(h.plain(MKV.parse(opus)), { kind: "audio", codecs: "A_OPUS" });

  const vorbis = cat(ebmlHead("webm"), segmentElem([tracksElem([trackEntry("A_VORBIS", { trackType: 2 })])]));
  assert.deepEqual(h.plain(MKV.parse(vorbis)), { kind: "audio", codecs: "A_VORBIS" });
});

test("WebM con video (V_VP8/V_VP9/V_AV1 + A_OPUS) se detecta como video y guarda CodecIDs", () => {
  const vp9 = cat(
    ebmlHead("webm"),
    segmentElem([
      seekHeadElem(),
      infoElem(),
      tracksElem([
        trackEntry("V_VP9", { trackType: 1, extra: [elem([0x63, 0xa2], new Uint8Array(32))] }),
        trackEntry("A_OPUS", { trackType: 2 }),
      ]),
      clusterElem(fakeAudio(200), UNKNOWN_8),
    ], UNKNOWN_8),
  );
  assert.deepEqual(h.plain(MKV.parse(vp9)), { kind: "video", codecs: "V_VP9, A_OPUS" });

  // Orden audio antes que video: sigue siendo video
  const av1 = cat(
    ebmlHead("webm"),
    segmentElem([
      tracksElem([
        trackEntry("A_OPUS"),
        trackEntry("V_AV1"),
      ]),
    ]),
  );
  assert.deepEqual(h.plain(MKV.parse(av1)), { kind: "video", codecs: "A_OPUS, V_AV1" });
});

test("MKV HEVC, AVC, AC-3 e ignora pistas de subtítulos (S_…)", () => {
  const hevc = cat(
    ebmlHead("matroska"),
    segmentElem([
      seekHeadElem(),
      voidElem(64),
      infoElem(),
      tracksElem([
        trackEntry("V_MPEGH/ISO/HEVC", { trackType: 1 }),
        trackEntry("A_AC3", { trackType: 2 }),
        trackEntry("S_TEXT/UTF8", { trackType: 17 }),
      ]),
    ]),
  );
  assert.deepEqual(h.plain(MKV.parse(hevc)), { kind: "video", codecs: "V_MPEGH/ISO/HEVC, A_AC3" });

  // CodecID con relleno NUL al final (permitido en EBML) y pistas duplicadas
  const avcNul = cat(
    ebmlHead("matroska"),
    segmentElem([
      tracksElem([
        elem([0xae], elem([0x86], cat(enc.encode("V_MPEG4/ISO/AVC"), [0, 0]))),
        trackEntry("A_AAC"),
        trackEntry("A_AAC"),
      ]),
    ]),
  );
  assert.deepEqual(h.plain(MKV.parse(avcNul)), { kind: "video", codecs: "V_MPEG4/ISO/AVC, A_AAC" });

  // Solo subtítulos sin V_ ni A_ → indeterminado
  const onlySubs = cat(ebmlHead("matroska"), segmentElem([tracksElem([trackEntry("S_TEXT/UTF8", { trackType: 17 })])]));
  const subsRes = MKV.parse(onlySubs);
  assert.equal(subsRes.kind, undefined);
  assert.equal(subsRes.codecs, "");
});

test("tamaños EBML de longitud variable (1, 2, 4 y 8 bytes) y tamaños desconocidos", () => {
  const cid = elem([0x86], enc.encode("V_MPEGH/ISO/HEVC"), vintSize(16, 4));
  const te1 = elem([0xae], cid, vintSize(cid.length, 8));
  const te2 = elem([0xae], elem([0x86], enc.encode("A_FLAC"), vintSize(6, 2)), [0xff]); // TrackEntry de tamaño desconocido
  const trk = tracksElem([te1, te2], [0xff]); // Tracks de tamaño desconocido, seguido de Cluster
  const buf = cat(
    ebmlHead("matroska"),
    segmentElem([infoElem(), trk, clusterElem(fakeAudio(40), UNKNOWN_8)], UNKNOWN_8),
  );
  assert.deepEqual(h.plain(MKV.parse(buf)), { kind: "video", codecs: "V_MPEGH/ISO/HEVC, A_FLAC" });
});

test("robustez: truncado en cualquier byte nunca lanza ni emite CodecID a medias", () => {
  const valid = cat(
    ebmlHead("matroska"),
    segmentElem([
      infoElem(),
      tracksElem([
        trackEntry("V_MPEGH/ISO/HEVC", { extra: [elem([0x63, 0xa2], fakeAudio(80))] }),
        trackEntry("A_OPUS"),
      ]),
    ], UNKNOWN_8),
  );
  for (let len = 0; len <= valid.length; len++) {
    const res = MKV.parse(valid.subarray(0, len));
    assert.ok(res && typeof res.codecs === "string", `falló en longitud ${len}`);
    if (res.codecs) {
      for (const c of res.codecs.split(", ")) {
        assert.ok(c === "V_MPEGH/ISO/HEVC" || c === "A_OPUS", `CodecID truncado en len=${len}: ${c}`);
      }
    }
  }
  // Truncado después del CodecID dentro de un TrackEntry cuyo CodecPrivate se corta: igualmente extrae el CodecID
  const cutAfterCodec = valid.subarray(0, valid.length - 60);
  assert.deepEqual(h.plain(MKV.parse(cutAfterCodec)), { kind: "video", codecs: "V_MPEGH/ISO/HEVC" });
});

test("robustez: basura, entradas vacías, tamaños gigantes/desbordados y muchos Void no lanzan", () => {
  for (const input of [
    null,
    undefined,
    new Uint8Array(0),
    new Uint8Array([0x1a, 0x45]),
    new Uint8Array(256).fill(0),
    new Uint8Array(256).fill(0xff),
    enc.encode("esto no es un archivo matroska ni webm"),
    // Cabecera EBML válida seguida de tamaño de 8 bytes > MAX_SAFE_INTEGER y basura
    cat(ebmlHead("matroska"), [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0x16, 0x54, 0xae, 0x6b, 0x00]),
    // Miles de elementos Void vacíos (2 bytes cada uno)
    cat(ebmlHead("matroska"), segmentElem([cat(...Array.from({ length: 6000 }, () => [0xec, 0x80]))], UNKNOWN_8)),
  ]) {
    const res = MKV.parse(input);
    assert.equal(res.kind, undefined);
    assert.equal(res.codecs, "");
  }
});

test("probe lee como máximo 256 KiB y devuelve indeterminado si Tracks queda más allá", async () => {
  const mkvBytes = cat(
    ebmlHead("webm"),
    segmentElem([
      tracksElem([trackEntry("V_VP8"), trackEntry("A_OPUS")]),
      clusterElem(new Uint8Array(400 * 1024)),
    ], UNKNOWN_8),
  );
  const inner = new File([mkvBytes], "clip.webm", { type: "video/webm" });
  const log = { read: 0 };
  const spy = {
    size: inner.size,
    slice(a, b) {
      const s = inner.slice(a, b);
      log.read += s.size;
      return s;
    },
  };
  const info = await MKV.probe(spy);
  assert.deepEqual(h.plain(info), { kind: "video", codecs: "V_VP8, A_OPUS" });
  assert.equal(log.read, MKV.MAX_PROBE);

  // Tracks después de 256 KiB → indeterminado sin leer todo el archivo
  const late = new File([cat(
    ebmlHead("matroska"),
    segmentElem([
      voidElem(300 * 1024),
      tracksElem([trackEntry("V_MPEG4/ISO/AVC")]),
    ], UNKNOWN_8),
  )], "tarde.mkv", { type: "video/x-matroska" });
  const lateRes = await MKV.probe(late);
  assert.equal(lateRes.kind, undefined);
  assert.equal(lateRes.codecs, "");
});
