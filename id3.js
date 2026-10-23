// Lector de etiquetas ID3v2 (v2.2, v2.3 y v2.4): título, artista, álbum, carátula y letra.
// `parse` expone también los marcos en bruto, que reutiliza tag-writer.js para reescribir etiquetas.
const ID3 = (() => {
  const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const int24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const int32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const bytes = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());

  const isWide = (enc) => enc === 1 || enc === 2; // UTF-16: terminadores de 2 bytes

  // Decodifica según la codificación del marco; entiende el BOM en ambos órdenes y
  // une con « / » los valores múltiples separados por NUL (típico de ID3v2.4).
  function decode(enc, b) {
    let label = enc === 3 ? "utf-8" : enc === 0 ? "iso-8859-1" : "utf-16le";
    if (isWide(enc) && b.length >= 2) {
      if (b[0] === 0xfe && b[1] === 0xff) { label = "utf-16be"; b = b.subarray(2); }
      else if (b[0] === 0xff && b[1] === 0xfe) b = b.subarray(2);
      else if (enc === 2) label = "utf-16be";
    }
    return new TextDecoder(label).decode(b).split("\0").map((s) => s.trim()).filter(Boolean).join(" / ");
  }

  // Posición del terminador de cadena según la codificación (2 bytes en UTF-16).
  function findEnd(b, start, enc) {
    const wide = isWide(enc);
    for (let i = start; i < b.length - (wide ? 1 : 0); i += wide ? 2 : 1) {
      if (b[i] === 0 && (!wide || b[i + 1] === 0)) return i;
    }
    return b.length;
  }

  // Deshace la «unsincronización» (0xFF 0x00 → 0xFF).
  function unsync(b) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
      out.push(b[i]);
      if (b[i] === 0xff && b[i + 1] === 0) i++;
    }
    return Uint8Array.from(out);
  }

  /**
   * Analiza la etiqueta ID3v2 del principio de un archivo. Devuelve null si no hay.
   * { version, audioStart, frames: [{ id, raw, data, offset, copied }] }
   *   raw    marco completo en bruto (cabecera + datos), en el tag ya sin unsincronizar si procede
   *   data   contenido del marco listo para interpretar (null si está comprimido o cifrado)
   *   offset posición de `data` respecto al byte 10 del archivo (válida si !copied)
   *   copied true si `data` no es un trozo literal del archivo (había que deshacer unsincronización)
   */
  async function parse(file) {
    const head = await bytes(file, 0, 10);
    if (ascii(head, 0, 3) !== "ID3") return null;

    const version = head[3];
    const flags = head[5];
    const size = syncsafe(head, 6);
    const tag = { version, frames: [], audioStart: 10 + size + (version === 4 && flags & 0x10 ? 10 : 0) }; // pie opcional de v2.4
    if (version < 2 || version > 4 || (version === 2 && flags & 0x40)) return tag; // desconocida o comprimida

    let body = await bytes(file, 10, size);
    let tagCopied = false;
    if (version < 4 && flags & 0x80) { body = unsync(body); tagCopied = true; } // v2.2/2.3: unsincronización de toda la etiqueta

    let pos = 0;
    if (flags & 0x40 && version > 2) pos = version === 4 ? syncsafe(body, 0) : int32(body, 0) + 4; // cabecera extendida: se salta
    const idLen = version === 2 ? 3 : 4;
    const hdrLen = version === 2 ? 6 : 10;

    while (pos + hdrLen <= body.length && body[pos] !== 0) {
      const id = ascii(body, pos, idLen);
      const fsize = version === 2 ? int24(body, pos + 3) : version === 4 ? syncsafe(body, pos + 4) : int32(body, pos + 4);
      if (!/^[A-Z0-9]+$/.test(id) || pos + hdrLen + fsize > body.length) break;

      const fl = version === 2 ? 0 : (body[pos + 8] << 8) | body[pos + 9];
      // v2.3: 0x0080 comprimido, 0x0040 cifrado · v2.4: 0x0008 comprimido, 0x0004 cifrado, 0x0002 unsincronizado, 0x0001 con longitud
      const unusable = version === 3 ? fl & 0x00c0 : version === 4 ? fl & 0x000c : 0;
      let offset = pos + hdrLen;
      let data = body.subarray(offset, offset + fsize);
      let copied = tagCopied;
      if (version === 4 && fl & 0x01) { data = data.subarray(4); offset += 4; }
      if (version === 4 && fl & 0x02) { data = unsync(data); copied = true; }

      tag.frames.push({ id, raw: body.subarray(pos, pos + hdrLen + fsize), data: unusable ? null : data, offset, copied });
      pos += hdrLen + fsize;
    }
    return tag;
  }

  const parseText = (data) => decode(data[0], data.subarray(1));

  // Devuelve { mime, from, to }: la imagen ocupa data[from..to).
  function locatePicture(data, v22) {
    const enc = data[0];
    let pos;
    let mime;
    if (v22) {
      mime = "image/" + ascii(data, 1, 3).toLowerCase().replace("jpg", "jpeg");
      pos = 4;
    } else {
      const end = findEnd(data, 1, 0);
      mime = decode(0, data.subarray(1, end)) || "image/jpeg";
      pos = end + 1;
    }
    pos += 1; // tipo de imagen
    const descEnd = findEnd(data, pos, enc);
    return { mime, from: descEnd + (isWide(enc) ? 2 : 1), to: data.length };
  }

  // USLT: codificación, idioma (3), descriptor terminado, letra.
  function parseLyrics(data) {
    const enc = data[0];
    const end = findEnd(data, 4, enc);
    return decode(enc, data.subarray(end + (isWide(enc) ? 2 : 1)));
  }

  async function read(file) {
    const meta = { title: "", artist: "", album: "", cover: null, lyrics: "" };
    try {
      const tag = await parse(file);
      if (!tag) return meta;
      const v22 = tag.version === 2;
      for (const { id, data, offset, copied } of tag.frames) {
        if (!data?.length) continue;
        if (id === "TIT2" || id === "TT2") meta.title = parseText(data);
        else if (id === "TPE1" || id === "TP1") meta.artist = parseText(data);
        else if (id === "TALB" || id === "TAL") meta.album = parseText(data);
        else if ((id === "USLT" || id === "ULT") && !meta.lyrics) meta.lyrics = parseLyrics(data);
        else if ((id === "APIC" || id === "PIC") && !meta.cover) {
          const { mime, from, to } = locatePicture(data, v22);
          // Si el marco está tal cual en el archivo, la carátula es un trozo del archivo y no ocupa memoria.
          meta.cover = copied
            ? new Blob([data.slice(from, to)], { type: mime })
            : file.slice(10 + offset + from, 10 + offset + to, mime);
        }
      }
    } catch {
      // Etiquetas corruptas: se usa el nombre de archivo.
    }
    return meta;
  }

  return { read, parse };
})();
