// Detección mínima y acotada para contenedores Matroska/WebM (EBML), sin DOM.
// Lee como máximo los primeros 256 KiB y extrae los CodecID (0x86) dentro de Tracks (0x1654AE6B):
// - algún «V_…» → kind "video"
// - solo «A_…» → kind "audio"
// - nada (sin Tracks en cabecera, corrupto o truncado) → kind undefined (indeterminado)
const MKV = (() => {
  const MAX_PROBE = 256 * 1024;
  const MAX_ELEMENTS = 4096;
  const MAX_CODEC_LEN = 128;

  const ID_EBML = 0x1a45dfa3;
  const ID_SEGMENT = 0x18538067;
  const ID_TRACKS = 0x1654ae6b;
  const ID_TRACK_ENTRY = 0xae;
  const ID_CODEC_ID = 0x86;
  // Elementos hijos directos de Segment (para acotar Tracks/TrackEntry de tamaño desconocido).
  const LEVEL1_IDS = new Set([
    0x114d9b74, // SeekHead
    0x1549a966, // Info
    0x1654ae6b, // Tracks
    0x1f43b675, // Cluster
    0x1c53bb6b, // Cues
    0x1941a469, // Attachments
    0x1043a770, // Chapters
    0x1254c367, // Tags
  ]);

  function vintLen(b) {
    if (b === 0) return 0;
    let len = 1;
    let mask = 0x80;
    while ((b & mask) === 0) {
      mask >>= 1;
      len++;
    }
    return len;
  }

  // Element ID EBML (1–4 bytes; conserva el bit marcador).
  function readId(buf, off, end) {
    if (off >= end) return null;
    const len = vintLen(buf[off]);
    if (len === 0 || len > 4 || off + len > end) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + buf[off + i];
    return { id, next: off + len };
  }

  // Element Data Size EBML (1–8 bytes; quita el bit marcador y detecta tamaño desconocido).
  function readSize(buf, off, end) {
    if (off >= end) return null;
    const len = vintLen(buf[off]);
    if (len === 0 || off + len > end) return null;
    const mask = (1 << (8 - len)) - 1;
    const first = buf[off] & mask;
    let allOnes = first === mask;
    let size = first;
    for (let i = 1; i < len; i++) {
      const b = buf[off + i];
      if (b !== 0xff) allOnes = false;
      size = size * 256 + b;
    }
    if (allOnes) return { size: -1, unknown: true, overflow: false, next: off + len };
    if (!Number.isSafeInteger(size)) return { size: -1, unknown: false, overflow: true, next: off + len };
    return { size, unknown: false, overflow: false, next: off + len };
  }

  function readElem(buf, off, end) {
    const idRes = readId(buf, off, end);
    if (!idRes) return null;
    const szRes = readSize(buf, idRes.next, end);
    if (!szRes) return null;
    const start = szRes.next;
    if (szRes.unknown || szRes.overflow) {
      return { id: idRes.id, start, end, size: -1, unknown: szRes.unknown, knownEnd: false };
    }
    const exactEnd = start + szRes.size;
    return {
      id: idRes.id,
      start,
      end: Math.min(end, exactEnd),
      size: szRes.size,
      unknown: false,
      knownEnd: exactEnd <= end,
    };
  }

  function decodeCodecId(buf, start, end) {
    let stop = end;
    while (stop > start && buf[stop - 1] === 0) stop--;
    if (stop <= start || stop - start > MAX_CODEC_LEN) return "";
    let s = "";
    for (let i = start; i < stop; i++) {
      const c = buf[i];
      if (c < 0x20 || c > 0x7e) return "";
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  // Función pura sobre un Uint8Array / ArrayBuffer: nunca lee fuera de límites ni lanza.
  function parse(input) {
    const empty = { kind: undefined, codecs: "" };
    if (!input) return empty;
    const buf = input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : null;
    if (!buf || buf.length < 4) return empty;

    const head = readElem(buf, 0, buf.length);
    if (!head || head.id !== ID_EBML) return empty;

    let steps = 0;
    let hasVideo = false;
    let hasAudio = false;
    const list = [];
    const push = (c) => { if (c && !list.includes(c)) list.push(c); };

    function parseTrackEntry(start, end, unknownParent) {
      let off = start;
      while (off < end && steps++ < MAX_ELEMENTS) {
        const idPeek = readId(buf, off, end);
        if (!idPeek) return end;
        if (unknownParent && (idPeek.id === ID_TRACK_ENTRY || LEVEL1_IDS.has(idPeek.id))) return off;
        const el = readElem(buf, off, end);
        if (!el) return end;
        if (el.id === ID_CODEC_ID && !el.unknown && el.knownEnd && el.size > 0 && el.size <= MAX_CODEC_LEN) {
          const cid = decodeCodecId(buf, el.start, el.end);
          if (cid.startsWith("V_")) { hasVideo = true; push(cid); }
          else if (cid.startsWith("A_")) { hasAudio = true; push(cid); }
        }
        if (el.unknown || !el.knownEnd) return end;
        off = el.end;
      }
      return off;
    }

    function parseTracks(start, end, unknownParent) {
      let off = start;
      while (off < end && steps++ < MAX_ELEMENTS) {
        const idPeek = readId(buf, off, end);
        if (!idPeek) break;
        if (unknownParent && LEVEL1_IDS.has(idPeek.id)) break;
        const el = readElem(buf, off, end);
        if (!el) break;
        if (el.id === ID_TRACK_ENTRY) {
          const next = parseTrackEntry(el.start, el.end, el.unknown);
          if (el.unknown) {
            if (next <= off) break;
            off = next;
            continue;
          }
          if (!el.knownEnd) break;
          off = el.end;
        } else {
          if (el.unknown || !el.knownEnd) break;
          off = el.end;
        }
      }
    }

    function parseSegment(start, end) {
      let off = start;
      while (off < end && steps++ < MAX_ELEMENTS) {
        const el = readElem(buf, off, end);
        if (!el) break;
        if (el.id === ID_TRACKS) {
          parseTracks(el.start, el.end, el.unknown);
          if (hasVideo || hasAudio || el.unknown || !el.knownEnd) break;
          off = el.end;
        } else {
          if (el.unknown || !el.knownEnd) break;
          off = el.end;
        }
      }
    }

    if (head.unknown || !head.knownEnd) return empty;
    let off = head.end;
    while (off < buf.length && steps++ < MAX_ELEMENTS) {
      const el = readElem(buf, off, buf.length);
      if (!el) break;
      if (el.id === ID_SEGMENT) {
        parseSegment(el.start, el.end);
        break;
      }
      if (el.unknown || !el.knownEnd) break;
      off = el.end;
    }

    return {
      kind: hasVideo ? "video" : hasAudio ? "audio" : undefined,
      codecs: list.join(", "),
    };
  }

  async function probe(file) {
    if (!file || !file.size) return { kind: undefined, codecs: "" };
    const slice = file.slice(0, Math.min(file.size, MAX_PROBE));
    const buf = new Uint8Array(await slice.arrayBuffer());
    return parse(buf);
  }

  return { MAX_PROBE, parse, probe };
})();
