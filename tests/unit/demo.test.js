const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const demo = path.join(root, "ejemplos");
const context = vm.createContext({ TextDecoder, TextEncoder, Uint8Array, DataView, Blob, atob });
vm.runInContext(fs.readFileSync(path.join(root, "src/id3.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(root, "src/tags.js"), "utf8"), context);
const Tags = vm.runInContext("Tags", context);

function asFile(name) {
  const bytes = fs.readFileSync(path.join(demo, name));
  const blob = new Blob([bytes], { type: name.endsWith(".flac") ? "audio/flac" : "audio/mpeg" });
  blob.name = name;
  return blob;
}

function mp3Info(bytes) {
  let offset = 0;
  if (bytes.toString("ascii", 0, 3) === "ID3") {
    const size = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
    offset = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
  }
  const ratesV1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const ratesV2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let frames = 0, sampleRate = 0, bitrate = 0;
  while (offset + 4 <= bytes.length) {
    const h = bytes.readUInt32BE(offset);
    const version = (h >>> 19) & 3;
    const layer = (h >>> 17) & 3;
    const bi = (h >>> 12) & 15;
    const si = (h >>> 10) & 3;
    if ((h >>> 21) !== 0x7ff || version === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) break;
    const baseRate = [44100, 48000, 32000][si];
    sampleRate = version === 3 ? baseRate : version === 2 ? baseRate / 2 : baseRate / 4;
    bitrate = (version === 3 ? ratesV1 : ratesV2)[bi] * 1000;
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((h >>> 9) & 1);
    if (frameLength < 4 || offset + frameLength > bytes.length) break;
    frames++;
    offset += frameLength;
  }
  return { codec: "mp3", sampleRate, bitrate, duration: frames * (sampleRate >= 32000 ? 1152 : 576) / sampleRate };
}

function flacInfo(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "fLaC");
  const blockType = bytes[4] & 0x7f;
  const length = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  assert.equal(blockType, 0);
  assert.equal(length, 34);
  const start = 8;
  const sampleRate = (bytes[start + 10] << 12) | (bytes[start + 11] << 4) | (bytes[start + 12] >>> 4);
  const packed = BigInt(`0x${bytes.subarray(start + 10, start + 18).toString("hex")}`);
  const durationSamples = Number(packed & ((1n << 36n) - 1n));
  return { codec: "flac", sampleRate, duration: durationSamples / sampleRate };
}

function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    }
    const length = bytes.readUInt16BE(i + 2);
    i += length + 2;
  }
  return null;
}

test("ejemplos: codecs, duración, frecuencia, tamaño y carátulas leídas por Tags", async () => {
  const names = ["Brisa.mp3", "Brisa.lrc", "Jardín.flac", "Nubes.mp3", "Paseo.webm", "Paseo.vtt"];
  let total = 0;
  for (const name of names) {
    const size = fs.statSync(path.join(demo, name)).size;
    assert.ok(size > 0, `falta ${name}`);
    total += size;
  }
  assert.ok(total < 4 * 1024 * 1024, `los medios pesan ${total} bytes`);

  for (const [name, codec] of [["Brisa.mp3", mp3Info], ["Jardín.flac", flacInfo], ["Nubes.mp3", mp3Info]]) {
    const bytes = fs.readFileSync(path.join(demo, name));
    const info = codec(bytes);
    assert.ok(info.duration >= 27.9 && info.duration <= 28.1, `${name}: ${info.duration}s`);
    assert.equal(info.sampleRate, 44100);
    if (name.endsWith(".mp3")) assert.ok(info.bitrate >= 160000);
    const tags = await Tags.read(asFile(name));
    assert.equal(tags.title, name.slice(0, name.indexOf(".")));
    assert.equal(tags.artist, "Tarareo (ejemplo)");
    assert.equal(tags.album, "Pequeños paisajes");
    assert.ok(tags.cover, `${name}: falta carátula incrustada según Tags`);
    assert.equal(tags.cover.type, "image/jpeg");
    assert.deepEqual(jpegSize(Buffer.from(await tags.cover.arrayBuffer())), { width: 640, height: 640 });
  }
  const lrc = fs.readFileSync(path.join(demo, "Brisa.lrc"), "utf8");
  assert.equal((lrc.match(/^\[\d{2}:\d{2}\.\d{2}\]/gm) || []).length, 8);
});
