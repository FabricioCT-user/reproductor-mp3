// Recorrido de átomos («cajas») MP4/M4A/MOV sobre un Blob/File, sin DOM y con lectura incremental:
// solo se leen las cabeceras (8 o 16 bytes) y se salta el contenido que no interesa (mdat, stbl…),
// de modo que no hace falta cargar el archivo entero (ni el moov completo).
//
// Un átomo es { type, start, end, hdr }: el contenido ocupa [start, end) (posiciones absolutas
// en el archivo) y su cabecera mide `hdr` bytes (8, o 16 con tamaño de 64 bits).
const MP4 = (() => {
  const MAX_BLOCK = 64 * 1024 * 1024; // protección frente a archivos corruptos
  const MAX_BOXES = 4096; // tope de hijos por nivel

  const bytes = async (file, start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  // El tipo son 4 bytes Latin-1 (p. ej. «©nam» = A9 6E 61 6D).
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

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

  return { MAX_BLOCK, DESCEND, header, children, find, findPath, payload, moov, kind, readTree };
})();
