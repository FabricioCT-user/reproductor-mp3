// Recorrido de átomos («cajas») MP4/M4A/MOV sobre un Blob/File, sin DOM y con lectura incremental:
// solo se leen las cabeceras (8 o 16 bytes) y se salta el contenido que no interesa (mdat, stbl…),
// de modo que no hace falta cargar el archivo entero (ni el moov completo).
//
// Un átomo es { type, start, end, hdr }: el contenido ocupa [start, end) (posiciones absolutas
// en el archivo) y su cabecera mide `hdr` bytes (8, o 16 con tamaño de 64 bits).
const MP4 = (() => {
  const MAX_BLOCK = 64 * 1024 * 1024; // protección frente a archivos corruptos
  const MAX_STSD = 64 * 1024; // tope para la tabla de descripción de muestras (stsd)
  const MAX_BOXES = 4096; // tope de hijos por nivel

  const bytes = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  // El tipo son 4 bytes Latin-1 (p. ej. «©nam» = A9 6E 61 6D).
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
  const pad2 = (n) => String(n).padStart(2, "0");

  // Lee la cabecera del átomo que empieza en `off` dentro de un padre que acaba en `end`.
  // Admite tamaño de 64 bits (size = 1) y «hasta el final del padre» (size = 0).
  // Devuelve null si no cabe, está truncado o es inválido.
  async function header(file, off, end) {
    if (off + 8 > end) return null;
    const h = await bytes(file, off, 16);
    if (h.length < 8) return null;
    let size = be32(h, 0);
    let hdr = 8;
    if (size === 1) {
      if (h.length < 16) return null;
      size = be32(h, 8) * 2 ** 32 + be32(h, 12);
      hdr = 16;
    } else if (size === 0) size = end - off;
    if (size < hdr || !Number.isSafeInteger(size) || off + size > end) return null;
    return { type: fourcc(h, 4), start: off + hdr, end: off + size, hdr };
  }

  // Átomos hijos de [start, end) (por defecto, los de nivel superior del archivo).
  // `parent` puede ser un átomo (se recorre su contenido) o, para «meta», pasa `skip: 4`.
  async function children(file, parent, skip = 0) {
    const out = [];
    let off = (parent ? parent.start : 0) + skip;
    const end = parent ? parent.end : file.size;
    while (out.length < MAX_BOXES) {
      const bx = await header(file, off, end);
      if (!bx) break;
      out.push(bx);
      off = bx.end;
    }
    return out;
  }

  // Primer hijo de ese tipo, o undefined. Se detiene al encontrarlo: no recorre el resto.
  async function find(file, parent, type, skip = 0) {
    let off = (parent ? parent.start : 0) + skip;
    const end = parent ? parent.end : file.size;
    for (let i = 0; i < MAX_BOXES; i++) {
      const bx = await header(file, off, end);
      if (!bx) return undefined;
      if (bx.type === type) return bx;
      off = bx.end;
    }
  }

  // Sigue una ruta de tipos desde `parent`: findPath(file, moov, ["udta", "meta", "ilst"]).
  // «meta» (con versión y banderas) se atraviesa saltando sus 4 bytes de cabecera extra.
  async function findPath(file, parent, path) {
    if (!parent) return undefined; // sin padre (p. ej. no hay moov) no se busca en la raíz
    let cur = parent;
    let skip = 0;
    for (const type of path) {
      cur = await find(file, cur, type, skip);
      if (!cur) return undefined;
      skip = cur.type === "meta" ? 4 : 0;
    }
    return cur;
  }

  // Contenido de un átomo (sin cabecera), acotado por `max`.
  async function payload(file, bx, max = MAX_BLOCK) {
    if (bx.end - bx.start > max) return null;
    return bytes(file, bx.start, bx.end - bx.start);
  }

  const moov = (file) => find(file, null, "moov");

  // Clasifica el contenedor consultando solo las cajas de pista y los 12 bytes
  // iniciales de hdlr. No lee mdat ni las tablas de muestras.
  async function kind(file) {
    const root = await moov(file);
    if (!root) return undefined;
    let audio = false;
    for (const trak of await children(file, root)) {
      if (trak.type !== "trak") continue;
      const mdia = await find(file, trak, "mdia");
      const hdlr = mdia && await find(file, mdia, "hdlr");
      if (!hdlr || hdlr.end - hdlr.start < 12) continue;
      const handler = String.fromCharCode(...await bytes(file, hdlr.start + 8, 4));
      if (handler === "vide") return "video";
      if (handler === "soun") audio = true;
    }
    return audio ? "audio" : undefined;
  }

  // Recorre cajas MP4 ya cargadas en memoria (para el interior de stsd).
  function memBoxes(buf, start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end && out.length < 64) {
      let size = be32(buf, off);
      let hdr = 8;
      if (size === 1) {
        if (off + 16 > end) break;
        size = be32(buf, off + 8) * 2 ** 32 + be32(buf, off + 12);
        hdr = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < hdr || !Number.isSafeInteger(size) || off + size > end) break;
      out.push({ type: fourcc(buf, off + 4), data: buf.subarray(off + hdr, off + size) });
      off += size;
    }
    return out;
  }

  function reverseBits32(n) {
    let r = 0;
    for (let i = 0; i < 32; i++) r = r * 2 + ((n >>> i) & 1);
    return r >>> 0;
  }

  // avcC (ISO 14496-15): [version, profile, compat, level, …] → «avc1.640028».
  function codecAvc(type, data) {
    if (!data || data.length < 4) return type;
    return `${type}.${hex2(data[1])}${hex2(data[2])}${hex2(data[3])}`;
  }

  // hvcC (ISO 14496-15 anexo E.3): perfil, banderas de compatibilidad invertidas, nivel y restricciones.
  function codecHevc(type, data) {
    if (!data || data.length < 13) return type;
    const space = ["", "A", "B", "C"][(data[1] >> 6) & 3];
    const tier = data[1] & 0x20 ? "H" : "L";
    const profile = data[1] & 0x1f;
    const compat = reverseBits32(be32(data, 2)).toString(16).toUpperCase();
    const level = data[12];
    let last = 5;
    while (last >= 0 && data[6 + last] === 0) last--;
    let constraints = "";
    for (let i = 0; i <= last; i++) constraints += `.${data[6 + i].toString(16).toUpperCase()}`;
    return `${type}.${space}${profile}.${compat}.${tier}${level}${constraints}`;
  }

  // av1C (especificación AV1-ISOBMFF): «av01.P.LLT.DD».
  function codecAv1(data) {
    if (!data || data.length < 4) return "av01";
    const profile = (data[1] >> 5) & 7;
    const level = data[1] & 0x1f;
    const tier = data[2] & 0x80 ? "H" : "M";
    const high = !!(data[2] & 0x40);
    const twelve = !!(data[2] & 0x20);
    const depth = profile === 2 && high ? (twelve ? 12 : 10) : high ? 10 : 8;
    return `av01.${profile}.${pad2(level)}${tier}.${pad2(depth)}`;
  }

  // vpcC (FullBox): [ver, flags×3, profile, level, bitDepth<<4|…] → «vp09.PP.LL.DD».
  function codecVp09(data) {
    if (!data || data.length < 7) return "vp09";
    return `vp09.${pad2(data[4])}.${pad2(data[5])}.${pad2(data[6] >> 4)}`;
  }

  // Descriptor MPEG-4 (tag + longitud variable de 1–4 bytes) dentro de esds.
  function readDesc(b, off, end) {
    if (off >= end) return null;
    const tag = b[off++];
    let size = 0;
    for (let i = 0; i < 4; i++) {
      if (off >= end) return null;
      const x = b[off++];
      size = (size << 7) | (x & 0x7f);
      if (!(x & 0x80)) break;
    }
    if (off + size > end) return null;
    return { tag, start: off, end: off + size };
  }

  // esds (FullBox): ES_Descriptor (0x03) → DecoderConfigDescriptor (0x04) → DecoderSpecificInfo (0x05).
  function codecMp4a(data) {
    if (!data || data.length < 6) return "mp4a";
    let d4 = null;
    const top = readDesc(data, 4, data.length);
    if (!top) return "mp4a";
    if (top.tag === 0x04) {
      d4 = top;
    } else if (top.tag === 0x03) {
      let pos = top.start + 2;
      if (pos >= top.end) return "mp4a";
      const flags = data[pos++];
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) {
        if (pos >= top.end) return "mp4a";
        pos += 1 + data[pos];
      }
      if (flags & 0x20) pos += 2;
      while (pos < top.end) {
        const sub = readDesc(data, pos, top.end);
        if (!sub) break;
        if (sub.tag === 0x04) { d4 = sub; break; }
        pos = sub.end;
      }
    }
    if (!d4 || d4.end - d4.start < 13) return "mp4a";
    const oti = data[d4.start];
    if (oti !== 0x40) return `mp4a.${oti.toString(16)}`;
    let pos = d4.start + 13;
    while (pos < d4.end) {
      const sub = readDesc(data, pos, d4.end);
      if (!sub) break;
      if (sub.tag === 0x05 && sub.end > sub.start) {
        let aot = data[sub.start] >> 3;
        if (aot === 31 && sub.end - sub.start >= 2) {
          aot = 32 + (((data[sub.start] & 7) << 3) | (data[sub.start + 1] >> 5));
        }
        if (aot > 0) return `mp4a.40.${aot}`;
      }
      pos = sub.end;
    }
    return "mp4a.40";
  }

  // Extrae las cadenas de códecs RFC 6381 del contenido (sin cabecera de caja) de un átomo stsd.
  function parseStsd(buf, handler = "") {
    if (!buf || buf.length < 8) return [];
    const count = Math.min(be32(buf, 4), 64);
    const entries = memBoxes(buf, 8, buf.length).slice(0, count);
    const out = [];
    const push = (c) => { if (c && !out.includes(c)) out.push(c); };
    for (const { type, data } of entries) {
      if (type === "avc1" || type === "avc3") {
        const avcC = data.length >= 78 ? memBoxes(data, 78, data.length).find((b) => b.type === "avcC") : null;
        push(codecAvc(type, avcC?.data));
      } else if (type === "hvc1" || type === "hev1") {
        const hvcC = data.length >= 78 ? memBoxes(data, 78, data.length).find((b) => b.type === "hvcC") : null;
        push(codecHevc(type, hvcC?.data));
      } else if (type === "av01") {
        const av1C = data.length >= 78 ? memBoxes(data, 78, data.length).find((b) => b.type === "av1C") : null;
        push(codecAv1(av1C?.data));
      } else if (type === "vp09") {
        const vpcC = data.length >= 78 ? memBoxes(data, 78, data.length).find((b) => b.type === "vpcC") : null;
        push(codecVp09(vpcC?.data));
      } else if (type === "mp4a") {
        const ver = data.length >= 10 ? (data[8] << 8) | data[9] : 0;
        const skip = ver === 1 ? 44 : ver === 2 ? 64 : 28;
        const kids = data.length >= skip ? memBoxes(data, skip, data.length) : [];
        let esds = kids.find((b) => b.type === "esds");
        if (!esds) {
          const wave = kids.find((b) => b.type === "wave");
          if (wave) esds = memBoxes(wave.data, 0, wave.data.length).find((b) => b.type === "esds");
        }
        push(codecMp4a(esds?.data));
      } else if (type === "Opus") {
        push("opus");
      } else if (type === "ac-3" || type === "ec-3") {
        push(type);
      } else if (type === "fLaC") {
        push("flac");
      } else if (handler === "vide" || handler === "soun") {
        const clean = type.trim();
        if (/^[\x20-\x7e]{2,4}$/.test(clean)) push(clean);
      }
    }
    return out;
  }

  // Recorre las pistas del moov una sola vez: obtiene el tipo (video/audio) y la cadena de códecs desde stsd
  // sin leer mdat ni las tablas de muestras (stts, stsz, stco…).
  async function probe(file) {
    const root = await moov(file);
    if (!root) return { kind: undefined, codecs: "" };
    let hasVideo = false;
    let hasAudio = false;
    const list = [];
    const push = (c) => { if (c && !list.includes(c)) list.push(c); };
    for (const trak of await children(file, root)) {
      if (trak.type !== "trak") continue;
      const mdia = await find(file, trak, "mdia");
      if (!mdia) continue;
      const hdlr = await find(file, mdia, "hdlr");
      let handler = "";
      if (hdlr && hdlr.end - hdlr.start >= 12) {
        handler = String.fromCharCode(...await bytes(file, hdlr.start + 8, 4));
      }
      if (handler === "vide") hasVideo = true;
      else if (handler === "soun") hasAudio = true;
      else if (handler) continue; // ignora pistas de texto, subtítulos, código de tiempo…
      const stsd = await findPath(file, mdia, ["minf", "stbl", "stsd"]);
      if (!stsd) continue;
      const buf = await payload(file, stsd, MAX_STSD);
      for (const c of parseStsd(buf, handler)) {
        push(c);
        if (!handler) {
          if (/^(avc[13]|hvc1|hev1|av01|vp09)(\.|$)/.test(c)) hasVideo = true;
          else if (/^(mp4a|opus|ac-3|ec-3|flac)(\.|$)/.test(c)) hasAudio = true;
        }
      }
    }
    return { kind: hasVideo ? "video" : hasAudio ? "audio" : undefined, codecs: list.join(", ") };
  }

  async function codecs(file) {
    return (await probe(file)).codecs;
  }

  // Árbol del moov leyendo solo cabeceras. Desciende por los contenedores de `descend`
  // (por defecto los que llevan metadatos y pistas) y NO entra en el resto (stbl, mdat…),
  // salvo que se pidan: readTree(file, { descend: [...DESCEND, "stbl"] }).
  // Cada nodo: { type, start, end, hdr, children? }.
  const DESCEND = ["moov", "trak", "mdia", "minf", "udta", "edts", "dinf"];
  async function readTree(file, { descend = DESCEND } = {}) {
    const root = await moov(file);
    if (!root) return null;
    const set = new Set(descend);
    const fill = async (node, depth) => {
      if (!set.has(node.type) || depth > 16) return node;
      node.children = await children(file, node);
      for (const c of node.children) await fill(c, depth + 1);
      return node;
    };
    return fill(root, 0);
  }

  return { MAX_BLOCK, DESCEND, header, children, find, findPath, payload, moov, kind, parseStsd, codecs, probe, readTree };
})();
