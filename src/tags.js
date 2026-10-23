// Lectura de etiquetas para FLAC, Ogg (Vorbis/Opus) y MP4/M4A. MP3 se delega en id3.js.
// Devuelve siempre { title, artist, album, cover, lyrics } (cover es un Blob o null).
const Tags = (() => {
  const MAX_BLOCK = 64 * 1024 * 1024; // protección frente a archivos corruptos

  const bytes = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const utf8 = (b) => new TextDecoder("utf-8").decode(b);
  const empty = () => ({ title: "", artist: "", album: "", cover: null, lyrics: "" });

  // Prefiere la letra sincronizada (LRC) frente a la de texto plano.
  const setLyrics = (meta, val) => {
    if (val && (!meta.lyrics || (!Lyrics.looksSynced(meta.lyrics) && Lyrics.looksSynced(val)))) meta.lyrics = val;
  };

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /* ----- Vorbis comments (FLAC y Ogg) ----- */

  // Estructura de imagen de FLAC (también usada en METADATA_BLOCK_PICTURE de Ogg).
  // Devuelve { type, from, to }: la imagen ocupa b[from..to).
  function locateFlacPicture(b) {
    let o = 4; // tipo de imagen
    const mimeLen = be32(b, o); o += 4;
    const mime = ascii(b, o, mimeLen); o += mimeLen;
    const descLen = be32(b, o); o += 4 + descLen;
    o += 16; // ancho, alto, profundidad, colores
    const len = be32(b, o); o += 4;
    return { type: mime && mime !== "-->" ? mime : "image/jpeg", from: o, to: o + len };
  }

  function parseVorbisComment(b, meta) {
    let o = 4 + le32(b, 0); // tras la cadena del fabricante
    const count = le32(b, o); o += 4;
    let albumArtist = "";
    for (let i = 0; i < count && o + 4 <= b.length; i++) {
      const len = le32(b, o); o += 4;
      const entry = utf8(b.subarray(o, o + len)); o += len;
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const val = entry.slice(eq + 1);
      if (key === "TITLE") meta.title ||= val;
      else if (key === "ARTIST") meta.artist ||= val;
      else if (key === "ALBUMARTIST") albumArtist ||= val;
      else if (key === "ALBUM") meta.album ||= val;
      else if (key === "LYRICS" || key === "UNSYNCEDLYRICS" || key === "SYNCEDLYRICS") setLyrics(meta, val);
      else if (key === "METADATA_BLOCK_PICTURE" && !meta.cover) {
        try {
          const b = Uint8Array.from(atob(val), (c) => c.charCodeAt(0));
          const { type, from, to } = locateFlacPicture(b);
          meta.cover = new Blob([b.slice(from, to)], { type });
        } catch { /* imagen inválida */ }
      }
    }
    meta.artist ||= albumArtist;
  }

  async function readFlac(file, meta) {
    let off = 4;
    for (let i = 0; i < 64; i++) {
      const h = await bytes(file, off, 4);
      if (h.length < 4) break;
      const last = h[0] & 0x80;
      const type = h[0] & 0x7f;
      const len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 4) parseVorbisComment(await bytes(file, off + 4, len), meta);
      else if (type === 6 && !meta.cover) {
        // La carátula es un trozo del propio archivo: no se copia a memoria.
        const { type: mime, from, to } = locateFlacPicture(await bytes(file, off + 4, Math.min(len, 65536)));
        meta.cover = file.slice(off + 4 + from, off + 4 + to, mime);
      }
      off += 4 + len;
      if (last) break;
    }
  }

  /* ----- Ogg ----- */

  async function readOgg(file, meta) {
    // Reensambla los dos primeros paquetes: identificación y comentarios.
    const packets = [];
    let cur = [];
    let off = 0;
    for (let pages = 0; packets.length < 2 && pages < 20000 && off < MAX_BLOCK; pages++) {
      const h = await bytes(file, off, 27);
      if (h.length < 27 || ascii(h, 0, 4) !== "OggS") return;
      const nseg = h[26];
      const segs = await bytes(file, off + 27, nseg);
      const total = segs.reduce((n, l) => n + l, 0);
      const body = await bytes(file, off + 27 + nseg, total);
      let p = 0;
      for (const l of segs) {
        cur.push(body.subarray(p, p + l));
        p += l;
        if (l < 255) { packets.push(concat(cur)); cur = []; }
      }
      off += 27 + nseg + total;
    }
    const c = packets[1];
    if (!c) return;
    if (c[0] === 3 && ascii(c, 1, 6) === "vorbis") parseVorbisComment(c.subarray(7), meta);
    else if (ascii(c, 0, 8) === "OpusTags") parseVorbisComment(c.subarray(8), meta);
  }

  /* ----- MP4 / M4A ----- */

  function* boxes(b, start = 0, end = b.length) {
    let o = start;
    while (o + 8 <= end) {
      const size = be32(b, o);
      if (size < 8 || o + size > end) return;
      yield { type: ascii(b, o + 4, 4), start: o + 8, end: o + size };
      o += size;
    }
  }

  const child = (b, parent, type) => {
    for (const bx of boxes(b, parent.start, parent.end)) if (bx.type === type) return bx;
  };

  function parseMoov(moov, meta, file, base) {
    const root = { start: 0, end: moov.length };
    const udta = child(moov, root, "udta");
    const metaBox = udta && child(moov, udta, "meta");
    if (!metaBox) return;
    const ilst = child(moov, { start: metaBox.start + 4, end: metaBox.end }, "ilst"); // «meta» lleva 4 bytes de versión
    if (!ilst) return;
    let albumArtist = "";
    for (const item of boxes(moov, ilst.start, ilst.end)) {
      const data = child(moov, item, "data");
      if (!data) continue;
      const flags = be32(moov, data.start) & 0xffffff;
      const payload = moov.subarray(data.start + 8, data.end);
      if (item.type === "©nam") meta.title ||= utf8(payload);
      else if (item.type === "©ART") meta.artist ||= utf8(payload);
      else if (item.type === "aART") albumArtist ||= utf8(payload);
      else if (item.type === "©alb") meta.album ||= utf8(payload);
      else if (item.type === "©lyr") setLyrics(meta, utf8(payload));
      else if (item.type === "covr" && !meta.cover) meta.cover = file.slice(base + data.start + 8, base + data.end, flags === 14 ? "image/png" : "image/jpeg");
    }
    meta.artist ||= albumArtist;
  }

  async function readMp4(file, meta) {
    let off = 0;
    for (let i = 0; i < 64; i++) {
      const h = await bytes(file, off, 16);
      if (h.length < 8) return;
      let size = be32(h, 0);
      let hdr = 8;
      if (size === 1) { size = be32(h, 8) * 2 ** 32 + be32(h, 12); hdr = 16; }
      else if (size === 0) size = file.size - off;
      if (size < hdr) return;
      if (ascii(h, 4, 4) === "moov") {
        if (size <= MAX_BLOCK) parseMoov(await bytes(file, off + hdr, size - hdr), meta, file, off + hdr);
        return;
      }
      off += size;
    }
  }

  /* ----- Entrada ----- */

  async function read(file) {
    const meta = empty();
    try {
      const head = await bytes(file, 0, 12);
      if (ascii(head, 0, 4) === "fLaC") await readFlac(file, meta);
      else if (ascii(head, 0, 4) === "OggS") await readOgg(file, meta);
      else if (ascii(head, 4, 4) === "ftyp") await readMp4(file, meta);
      else return await ID3.read(file);
    } catch {
      // Etiquetas corruptas: se usa el nombre de archivo.
    }
    return meta;
  }

  return { read };
})();
