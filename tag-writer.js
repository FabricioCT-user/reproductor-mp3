// Escribe etiquetas en una COPIA de un MP3 (ID3v2.3/2.4) o de un FLAC (comentarios Vorbis + imagen).
// Nunca modifica el archivo original: devuelve un Blob nuevo con la cabecera reescrita y el audio intacto.
//
// edits: { title?, artist?, album?, cover?: Blob | false }  (solo los campos presentes se tocan;
//        un artista/álbum vacío elimina la etiqueta; cover false elimina la carátula)
const TagWriter = (() => {
  const bytes = async (blob, start, len) => new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const utf8 = (s) => new TextEncoder().encode(s);
  const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const utf16le = (s) => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { out[i * 2] = s.charCodeAt(i) & 0xff; out[i * 2 + 1] = s.charCodeAt(i) >> 8; }
    return out;
  };
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const putBe32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const putLe32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const putSyncsafe = (n) => Uint8Array.of((n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127);

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Formato que sabemos escribir ("mp3" | "flac") o null.
  async function kind(file) {
    const h = await bytes(file, 0, 4);
    if (ascii(h, 0, 4) === "fLaC") return "flac";
    if (/\.mp3$/i.test(file.name) && (ascii(h, 0, 3) === "ID3" || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0))) return "mp3";
    return null;
  }

  /* ----- MP3 / ID3v2 ----- */

  // Deshace la «unsincronización» de ID3 (0xFF 0x00 → 0xFF).
  function unsync(b) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
      out.push(b[i]);
      if (b[i] === 0xff && b[i + 1] === 0) i++;
    }
    return Uint8Array.from(out);
  }

  async function writeMp3(file, edits) {
    const head = await bytes(file, 0, 10);
    let audioStart = 0;
    let ver = 4;
    let frames = []; // { id, raw } — se conservan byte a byte los que no se editan

    if (ascii(head, 0, 3) === "ID3") {
      const v = head[3];
      const flags = head[5];
      const size = syncsafe(head, 6);
      audioStart = 10 + size + (v === 4 && flags & 0x10 ? 10 : 0); // pie opcional de ID3v2.4
      if (v === 3 || v === 4) {
        ver = v;
        let b = await bytes(file, 10, size);
        if (v === 3 && flags & 0x80) b = unsync(b);
        let pos = 0;
        if (flags & 0x40) pos = v === 4 ? syncsafe(b, 0) : be32(b, 0) + 4; // se descarta la cabecera extendida
        while (pos + 10 <= b.length && b[pos] !== 0) {
          const id = ascii(b, pos, 4);
          const fsize = v === 4 ? syncsafe(b, pos + 4) : be32(b, pos + 4);
          if (!/^[A-Z0-9]{4}$/.test(id) || pos + 10 + fsize > b.length) break;
          frames.push({ id, raw: b.subarray(pos, pos + 10 + fsize) });
          pos += 10 + fsize;
        }
      }
      // ID3v2.2 (marcos de 3 letras): no se puede reutilizar tal cual, así que solo se escriben las etiquetas editadas.
    }

    const drop = new Set();
    if ("title" in edits) drop.add("TIT2");
    if ("artist" in edits) drop.add("TPE1");
    if ("album" in edits) drop.add("TALB");
    if ("cover" in edits) drop.add("APIC");
    frames = frames.filter((f) => !drop.has(f.id));

    const frame = (id, body) =>
      concat([utf8(id), ver === 4 ? putSyncsafe(body.length) : putBe32(body.length), Uint8Array.of(0, 0), body]);
    // v2.3: UTF-16 con BOM; v2.4: UTF-8.
    const text = (id, value) =>
      value ? frame(id, ver === 4 ? concat([Uint8Array.of(3), utf8(value)]) : concat([Uint8Array.of(1, 0xff, 0xfe), utf16le(value)])) : null;

    const added = [
      "title" in edits && text("TIT2", edits.title),
      "artist" in edits && text("TPE1", edits.artist),
      "album" in edits && text("TALB", edits.album),
    ];
    if (edits.cover instanceof Blob) {
      const img = await bytes(edits.cover, 0, edits.cover.size);
      added.push(frame("APIC", concat([Uint8Array.of(0), latin1(edits.cover.type || "image/jpeg"), Uint8Array.of(0, 3, 0), img])));
    }

    const body = concat([...frames.map((f) => f.raw), ...added.filter(Boolean)]);
    const header = concat([utf8("ID3"), Uint8Array.of(ver, 0, 0), putSyncsafe(body.length)]);
    return new Blob([header, body, file.slice(audioStart)], { type: file.type || "audio/mpeg" });
  }

  /* ----- FLAC ----- */

  async function imageSize(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      return [bmp.width, bmp.height];
    } catch {
      return [0, 0];
    }
  }

  function parseVorbis(d) {
    const vlen = le32(d, 0);
    const vendor = d.subarray(4, 4 + vlen);
    let o = 4 + vlen;
    const count = le32(d, o);
    o += 4;
    const entries = [];
    for (let i = 0; i < count && o + 4 <= d.length; i++) {
      const len = le32(d, o);
      entries.push(d.subarray(o + 4, o + 4 + len));
      o += 4 + len;
    }
    return { vendor, entries };
  }

  const buildVorbis = ({ vendor, entries }) =>
    concat([putLe32(vendor.length), vendor, putLe32(entries.length), ...entries.flatMap((e) => [putLe32(e.length), e])]);

  const keyOf = (entry) => {
    const s = new TextDecoder().decode(entry);
    const eq = s.indexOf("=");
    return (eq < 0 ? s : s.slice(0, eq)).toUpperCase();
  };

  async function writeFlac(file, edits) {
    let off = 4;
    const blocks = []; // { type, data }
    for (;;) {
      const h = await bytes(file, off, 4);
      if (h.length < 4) throw new Error("FLAC incompleto");
      const last = h[0] & 0x80;
      const len = (h[1] << 16) | (h[2] << 8) | h[3];
      blocks.push({ type: h[0] & 0x7f, data: await bytes(file, off + 4, len) });
      off += 4 + len;
      if (last) break;
    }
    if (!blocks.length || blocks[0].type !== 0) throw new Error("Falta STREAMINFO");

    // Comentarios Vorbis: se sustituyen solo las claves editadas y se conserva el resto.
    const vi = blocks.findIndex((b) => b.type === 4);
    const vorbis = vi >= 0 ? parseVorbis(blocks[vi].data) : { vendor: utf8("reproductor-mp3"), entries: [] };
    for (const [field, key] of [["title", "TITLE"], ["artist", "ARTIST"], ["album", "ALBUM"]]) {
      if (!(field in edits)) continue;
      vorbis.entries = vorbis.entries.filter((e) => keyOf(e) !== key);
      if (edits[field]) vorbis.entries.push(utf8(`${key}=${edits[field]}`));
    }
    const vorbisBlock = { type: 4, data: buildVorbis(vorbis) };

    let out = blocks.filter((b) => b.type !== 1 && b.type !== 4); // se descarta el relleno
    out.splice(1, 0, vorbisBlock); // justo después de STREAMINFO

    if ("cover" in edits) {
      out = out.filter((b) => b.type !== 6);
      if (edits.cover instanceof Blob) {
        const img = await bytes(edits.cover, 0, edits.cover.size);
        const mime = latin1(edits.cover.type || "image/jpeg");
        const [w, h] = await imageSize(edits.cover);
        out.push({
          type: 6,
          data: concat([putBe32(3), putBe32(mime.length), mime, putBe32(0), putBe32(w), putBe32(h), putBe32(24), putBe32(0), putBe32(img.length), img]),
        });
      }
    }

    const parts = [utf8("fLaC")];
    out.forEach((b, i) => {
      if (b.data.length >= 1 << 24) throw new Error("Bloque FLAC demasiado grande");
      const isLast = i === out.length - 1;
      parts.push(Uint8Array.of((isLast ? 0x80 : 0) | b.type, (b.data.length >>> 16) & 255, (b.data.length >>> 8) & 255, b.data.length & 255), b.data);
    });
    parts.push(file.slice(off));
    return new Blob(parts, { type: file.type || "audio/flac" });
  }

  async function write(file, format, edits) {
    return format === "flac" ? writeFlac(file, edits) : writeMp3(file, edits);
  }

  return { kind, write };
})();
