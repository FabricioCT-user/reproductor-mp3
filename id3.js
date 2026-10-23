// Lector mínimo de etiquetas ID3v2 (v2.2, v2.3 y v2.4): título, artista, álbum y carátula.
const ID3 = (() => {
  const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const int24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const int32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  const DECODERS = ["iso-8859-1", "utf-16", "utf-16be", "utf-8"];
  const decode = (enc, bytes) =>
    new TextDecoder(DECODERS[enc] ?? "utf-8").decode(bytes).replace(/\0+$/, "").trim();

  // Posición del terminador de cadena según la codificación (2 bytes en UTF-16).
  function findEnd(b, start, enc) {
    const wide = enc === 1 || enc === 2;
    for (let i = start; i < b.length - (wide ? 1 : 0); i += wide ? 2 : 1) {
      if (b[i] === 0 && (!wide || b[i + 1] === 0)) return i;
    }
    return b.length;
  }

  function parseText(data) {
    return decode(data[0], data.subarray(1));
  }

  function parsePicture(data, v22) {
    const enc = data[0];
    let pos = 1;
    let mime;
    if (v22) {
      mime = "image/" + String.fromCharCode(...data.subarray(1, 4)).toLowerCase().replace("jpg", "jpeg");
      pos = 4;
    } else {
      const end = findEnd(data, 1, 0);
      mime = decode(0, data.subarray(1, end)) || "image/jpeg";
      pos = end + 1;
    }
    pos += 1; // tipo de imagen
    const descEnd = findEnd(data, pos, enc);
    pos = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
    return new Blob([data.slice(pos)], { type: mime });
  }

  // USLT: codificación, idioma (3), descriptor terminado, letra.
  function parseLyrics(data) {
    const enc = data[0];
    const end = findEnd(data, 4, enc);
    return decode(enc, data.subarray(end + (enc === 1 || enc === 2 ? 2 : 1)));
  }

  async function read(file) {
    const meta = { title: "", artist: "", album: "", cover: null, lyrics: "" };
    try {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (String.fromCharCode(...head.subarray(0, 3)) !== "ID3") return meta;

      const version = head[3];
      const size = syncsafe(head, 6);
      const tag = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      const v22 = version === 2;
      const idLen = v22 ? 3 : 4;
      const hdrLen = v22 ? 6 : 10;

      let pos = 0;
      while (pos + hdrLen <= tag.length && tag[pos] !== 0) {
        const id = String.fromCharCode(...tag.subarray(pos, pos + idLen));
        const fsize = v22 ? int24(tag, pos + 3) : version === 4 ? syncsafe(tag, pos + 4) : int32(tag, pos + 4);
        const data = tag.subarray(pos + hdrLen, pos + hdrLen + fsize);
        pos += hdrLen + fsize;
        if (!data.length) continue;

        if (id === "TIT2" || id === "TT2") meta.title = parseText(data);
        else if (id === "TPE1" || id === "TP1") meta.artist = parseText(data);
        else if (id === "TALB" || id === "TAL") meta.album = parseText(data);
        else if ((id === "USLT" || id === "ULT") && !meta.lyrics) meta.lyrics = parseLyrics(data);
        else if ((id === "APIC" || id === "PIC") && !meta.cover) meta.cover = parsePicture(data, v22);
      }
    } catch {
      // Etiquetas corruptas: se usa el nombre de archivo.
    }
    return meta;
  }

  return { read };
})();
