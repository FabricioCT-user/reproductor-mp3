// Utilidades de las pruebas: carga los scripts del navegador en Node y construye archivos de audio sintéticos.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

/**
 * Ejecuta scripts clásicos (los mismos que carga index.html) en un contexto aislado, en orden,
 * y devuelve una función para leer sus constantes globales: `g("ID3")`.
 */
function load(...files) {
  const ctx = vm.createContext({ Blob, File, TextDecoder, TextEncoder, atob, btoa, URL, console });
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  return (name) => vm.runInContext(name, ctx);
}

/* ---------- Bytes ---------- */

const enc = new TextEncoder();
const flat = (parts) => parts.flatMap((p) => (typeof p === "string" ? [...enc.encode(p)] : [...p]));
const cat = (...parts) => Uint8Array.from(flat(parts));
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const utf16le = (s) => [...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]);
const utf16be = (s) => [...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]);

// Los objetos creados dentro del contexto aislado tienen otros prototipos: se normalizan antes de comparar.
const plain = (x) => JSON.parse(JSON.stringify(x));
const latin1 = (s) => [...s].map((c) => c.charCodeAt(0));
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// «Audio» falso reconocible: no hace falta que decodifique, solo que se conserve idéntico.
const fakeAudio = (n = 600) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
// Imagen falsa (no se decodifica en las pruebas).
const fakeImage = (n = 300, seed = 5) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 255);

/* ---------- ID3 ---------- */

// Unsincroniza: inserta 0x00 tras cada 0xFF que pudiera confundirse con una cabecera MPEG.
function unsyncBytes(b) {
  const out = [];
  b.forEach((x, i) => {
    out.push(x);
    if (x === 0xff && (i + 1 === b.length || b[i + 1] >= 0xe0 || b[i + 1] === 0)) out.push(0);
  });
  return Uint8Array.from(out);
}

function id3Frame(ver, id, body, flags = [0, 0]) {
  if (ver === 2) return cat(id, [(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255], body);
  return cat(id, ver === 4 ? syncsafe(body.length) : be32(body.length), flags, body);
}

// Marco de texto. enc: 0 latin1, 1 UTF-16 con BOM LE, 2 UTF-16 BE con BOM, 3 UTF-8.
function textFrame(ver, id, text, e = ver === 4 ? 3 : 1) {
  const body = e === 0 ? [0, ...[...text].map((c) => c.charCodeAt(0))]
    : e === 1 ? [1, 0xff, 0xfe, ...utf16le(text)]
    : e === 2 ? [1, 0xfe, 0xff, ...utf16be(text)]
    : [3, ...enc.encode(text)];
  return id3Frame(ver, id, Uint8Array.from(body));
}

function apicFrame(ver, image, mime = "image/jpeg") {
  if (ver === 2) return id3Frame(2, "PIC", cat([0], "JPG", [3, 0], image));
  return id3Frame(ver, "APIC", cat([0], mime, [0, 3, 0], image));
}

// opts: { ver, frames, unsyncTag, extHeader, footer }
function id3Tag({ ver = 3, frames = [], unsyncTag = false, extHeader = false, footer = false } = {}) {
  let body = cat(...frames);
  if (extHeader) body = cat(ver === 4 ? [...syncsafe(6), 1, 0] : [...be32(6), 0, 0, ...be32(0)].slice(0, 10), body);
  if (unsyncTag) body = unsyncBytes(body);
  const flags = (unsyncTag ? 0x80 : 0) | (extHeader ? 0x40 : 0) | (footer ? 0x10 : 0);
  const head = cat("ID3", [ver, 0, flags], syncsafe(body.length));
  return cat(head, body, footer ? cat("3DI", [ver, 0, flags], syncsafe(body.length)) : []);
}

const mp3File = (tag, audio = fakeAudio(), name = "pista.mp3") => new File([tag, audio], name, { type: "audio/mpeg" });

/* ---------- FLAC ---------- */

const flacBlock = (type, data, last = false) => cat([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255], data);

const vorbisBody = (entries, vendor = "pruebas") =>
  cat(le32(vendor.length), vendor, le32(entries.length), ...entries.map((e) => cat(le32(enc.encode(e).length), e)));

const flacPicture = (image, { type = 3, mime = "image/png", desc = "" } = {}) =>
  cat(be32(type), be32(mime.length), mime, be32(desc.length), desc, be32(100), be32(100), be32(24), be32(0), be32(image.length), image);

const STREAMINFO = Uint8Array.from({ length: 34 }, (_, i) => (i * 7 + 1) & 255);

// opts: { entries, picture, pictures, padding, apps, audio }
function flacFile({ entries = [], pictures = [], padding = 0, apps = [], audio = fakeAudio(), name = "pista.flac", vendor } = {}) {
  const blocks = [[0, STREAMINFO]];
  if (entries.length || vendor) blocks.push([4, vorbisBody(entries, vendor)]);
  if (padding) blocks.push([1, new Uint8Array(padding)]);
  for (const a of apps) blocks.push([2, a]);
  for (const p of pictures) blocks.push([6, p]);
  const body = blocks.map(([t, d], i) => flacBlock(t, d, i === blocks.length - 1));
  return new File([cat("fLaC", ...body), audio], name, { type: "audio/flac" });
}

// Lee la estructura de bloques de un FLAC: [{ type, last, data }].
function flacBlocks(bytes) {
  const out = [];
  let o = 4;
  for (;;) {
    const last = !!(bytes[o] & 0x80);
    const len = (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    out.push({ type: bytes[o] & 0x7f, last, data: bytes.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
    if (last) return { blocks: out, audioStart: o };
  }
}

/* ---------- Ogg ---------- */

// Una página Ogg por paquete (con encadenado de segmentos de 255 bytes).
function oggPages(packets) {
  return cat(...packets.map((p, n) => {
    const segs = [];
    for (let left = p.length; ; left -= 255) { segs.push(Math.min(left, 255)); if (left < 255) break; }
    // un paquete de múltiplo exacto de 255 necesita un segmento final de 0
    return cat("OggS", [0, n === 0 ? 2 : 0], new Array(8).fill(0), le32(1), le32(n), le32(0), [segs.length], segs, p);
  }));
}

const vorbisComment = (entries, vendor = "pruebas") => vorbisBody(entries, vendor);
const oggVorbisFile = (entries, name = "pista.ogg") =>
  new File([oggPages([cat([1], "vorbis", new Array(23).fill(0)), cat([3], "vorbis", vorbisComment(entries), [1]), cat([5], "vorbis", [0, 0])])], name);
const opusFile = (entries, name = "pista.opus") =>
  new File([oggPages([cat("OpusHead", [1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]), cat("OpusTags", vorbisComment(entries))])], name);

/* ---------- MP4 ---------- */

// El tipo de caja son 4 bytes Latin-1 (p. ej. «©nam» = A9 6E 61 6D), no UTF-8.
const fourcc = (type) => [...type].map((c) => c.charCodeAt(0));
const box = (type, ...content) => {
  const body = cat(...content);
  return cat(be32(8 + body.length), fourcc(type), body);
};
const mp4Item = (type, payload, flags = 1) => box(type, box("data", be32(flags), [0, 0, 0, 0], payload));

// items: [[tipo, payload, flags?]]; moovAtEnd: mdat antes que moov (lo habitual sin «faststart»)
function mp4File(items, { moovAtEnd = true, name = "pista.m4a" } = {}) {
  const ilst = box("ilst", ...items.map(([t, p, f]) => mp4Item(t, p, f)));
  const moov = box("moov", box("udta", box("meta", [0, 0, 0, 0], ilst)));
  const ftyp = box("ftyp", "M4A ", be32(0), "M4A ");
  const mdat = box("mdat", fakeAudio(400));
  return new File(moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat], name, { type: "audio/mp4" });
}

module.exports = {
  load, plain, enc, cat, latin1, be32, le32, syncsafe, utf16le, utf16be, bytesOf, sameBytes, fakeAudio, fakeImage,
  unsyncBytes, id3Frame, textFrame, apicFrame, id3Tag, mp3File,
  flacBlock, flacPicture, flacFile, flacBlocks, vorbisBody, STREAMINFO,
  oggVorbisFile, opusFile, mp4File,
};
