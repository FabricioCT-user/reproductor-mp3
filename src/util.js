// Funciones puras (sin DOM ni estado): se pueden probar desde Node.

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Descarta entradas que no tengan la forma esperada (datos antiguos o editados a mano).
function cleanPlaylists(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.ids))
    .map((p) => ({ ...p, pending: Array.isArray(p.pending) ? p.pending.filter((r) => r && typeof r.file === "string") : [] }));
}

const formatTime = (s) => {
  if (!isFinite(s)) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

const isLrc = (f) => /\.lrc$/i.test(f.name);

const isListFile = (f) => /\.(json|m3u8?)$/i.test(f.name);

// Los .m3u8 a veces llegan con tipo audio/*: no son canciones.
const isAudio = (f) => !isLrc(f) && !isListFile(f) && (f.type.startsWith("audio/") || /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|weba)$/i.test(f.name));

const isVideo = (f) => !isLrc(f) && !isListFile(f) && (f.type.startsWith("video/") || /\.(mp4|m4v|webm|mov|mkv)$/i.test(f.name));
const isMedia = (f) => isAudio(f) || isVideo(f);

// Clave para no importar dos veces el mismo archivo.
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

// Ruta relativa de un archivo importado desde una carpeta (o solo su nombre).
const pathOf = (f) => f.relPath || f.webkitRelativePath || f.name;

const dirOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

const byPath = (a, b) => pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true, sensitivity: "base" });

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "lista";

const fmtFreq = (f) => (f >= 1000 ? `${f / 1000}k` : f);

const fmtGain = (g) => (g > 0 ? `+${g}` : `${g}`);

const fmtSpeed = (v) => `${Number(v.toFixed(2))}×`;

const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? h + ":" : ""}${m}:${String(s % 60).padStart(2, "0")}`;
};

const extOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || "").trim());
  return m ? m[1].toLowerCase() : "";
};

const UNSUPPORTED_VIDEO_EXT = new Set(["avi", "wmv", "flv", "ts", "m2ts", "mts", "vob", "mpg", "mpeg", "ogv", "rmvb", "3gp"]);

const isAc3Codec = (c) => /^(ac-3|ec-3|mp4a\.a5|mp4a\.a6)(\.|$)/i.test(String(c || "").trim());

// Explica en español por qué un medio puede fallar o ha fallado según tipo, extensión y cadena de códecs.
function explainFailure(kind, ext, codecs) {
  const e = String(ext || "").replace(/^\./, "").toLowerCase();
  const list = (Array.isArray(codecs) ? codecs : String(codecs || "").split(","))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const isVid = kind === "video";

  if (e === "mkv") {
    return "El contenedor MKV puede no ser compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.mkv -c copy salida.mp4";
  }
  if (UNSUPPORTED_VIDEO_EXT.has(e)) {
    return `El formato ${e.toUpperCase()} no es compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.${e} -c copy salida.mp4`;
  }

  if (list.length) {
    const reasons = [];
    const hasHevc = list.some((c) => /^(hvc1|hev1)(\.|$)/i.test(c));
    const hasAv1 = list.some((c) => /^av01(\.|$)/i.test(c));
    const hasVp9 = list.some((c) => /^vp09(\.|$)/i.test(c));
    const hasAc3 = list.some((c) => /^(ac-3|mp4a\.a5)(\.|$)/i.test(c));
    const hasEac3 = list.some((c) => /^(ec-3|mp4a\.a6)(\.|$)/i.test(c));
    const hasDts = list.some((c) => /^(dtsc|dtse|dtsh|dtsl|dts\+)(\.|$)/i.test(c));

    if (hasHevc) reasons.push("el códec de video HEVC (H.265) no es compatible");
    if (hasAv1) reasons.push("el códec de video AV1 no es compatible");
    if (hasVp9) reasons.push("el códec de video VP9 no es compatible");
    if (hasAc3 || hasEac3) {
      const detail = [];
      if (hasEac3 && !hasAc3) detail.push("E-AC-3");
      if (isVid) detail.push("el video se verá sin sonido");
      reasons.push(`el audio AC-3 no es compatible${detail.length ? ` (${detail.join("; ")})` : ""}`);
    }
    if (hasDts) reasons.push(isVid ? "el audio DTS no es compatible (el video se verá sin sonido)" : "el audio DTS no es compatible");

    if (!reasons.length) {
      const exotic = list.filter((c) => !/^(avc[13]|mp4a|opus|flac)(\.|$)/i.test(c));
      if (exotic.length) reasons.push(`códec no compatible (${exotic.join(", ")})`);
    }
    if (reasons.length) {
      const msg = reasons.join("; ");
      return msg[0].toUpperCase() + msg.slice(1);
    }
    if (e === "mov") {
      return "El archivo MOV puede no ser compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.mov -c copy salida.mp4";
    }
    return `No se puede reproducir este ${e ? e.toUpperCase() : "archivo"} (códecs: ${list.join(", ")})`;
  }

  if (e === "mov") {
    return "El archivo MOV puede no ser compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.mov -c copy salida.mp4";
  }
  if (isVid) return e ? `El video ${e.toUpperCase()} no se puede reproducir en este reproductor` : "El video no se puede reproducir en este reproductor";
  return e ? `El formato ${e.toUpperCase()} no se puede reproducir en este reproductor` : "No se puede reproducir este archivo en este reproductor";
}

// Comprueba compatibilidad antes de reproducir usando canPlayType. Devuelve { ok, reason, ac3Unsupported }.
function checkCompatibility({ kind = "", ext = "", mime = "", codecs = "" } = {}, canPlayType) {
  const e = String(ext || "").replace(/^\./, "").toLowerCase();
  const list = (Array.isArray(codecs) ? codecs : String(codecs || "").split(","))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const test = typeof canPlayType === "function" ? (t) => String(canPlayType(t) || "") : () => "maybe";

  if (list.length) {
    const container = kind === "audio" ? "audio/mp4" : "video/mp4";
    const combined = test(`${container}; codecs="${list.join(", ")}"`);
    const ac3Fail = list.filter((c) => isAc3Codec(c) && !test(`audio/mp4; codecs="${c}"`) && !test(`video/mp4; codecs="${c}"`));

    if (combined === "" || ac3Fail.length) {
      const failing = list.filter((c) => {
        if (isAc3Codec(c)) return !test(`audio/mp4; codecs="${c}"`) && !test(`video/mp4; codecs="${c}"`);
        if (/^(mp4a|opus|flac|alac|dtsc|dtse|dtsh|dtsl|dts\+)(\.|$)/i.test(c)) {
          return !test(`${container}; codecs="${c}"`) && !test(`audio/mp4; codecs="${c}"`);
        }
        return !test(`${container}; codecs="${c}"`);
      });
      const target = failing.length ? failing : ac3Fail.length ? ac3Fail : list;
      return { ok: false, reason: explainFailure(kind, e, target), ac3Unsupported: ac3Fail.length > 0 };
    }
    return { ok: true, reason: "", ac3Unsupported: false };
  }

  if (UNSUPPORTED_VIDEO_EXT.has(e)) {
    return { ok: false, reason: explainFailure(kind || "video", e, ""), ac3Unsupported: false };
  }
  if (e === "mkv" && test("video/x-matroska") === "") {
    return { ok: false, reason: explainFailure(kind || "video", "mkv", ""), ac3Unsupported: false };
  }
  if (mime && !/^video\/(quicktime|x-m4v)$/i.test(mime) && !/^audio\/x-flac$/i.test(mime) && test(mime) === "") {
    return { ok: false, reason: explainFailure(kind, e, ""), ac3Unsupported: false };
  }
  return { ok: true, reason: "", ac3Unsupported: false };
}
