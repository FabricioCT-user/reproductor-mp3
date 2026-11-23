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

const isSubtitle = (f) => /\.(srt|vtt)$/i.test(f.name);

const isCompanion = (f) => isLrc(f) || isSubtitle(f);

const isListFile = (f) => /\.(json|m3u8?)$/i.test(f.name);

// Los .m3u8 a veces llegan con tipo audio/*: no son canciones.
const isAudio = (f) => !isCompanion(f) && !isListFile(f) && (f.type.startsWith("audio/") || /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|weba)$/i.test(f.name));

const isVideo = (f) => !isCompanion(f) && !isListFile(f) && (f.type.startsWith("video/") || /\.(mp4|m4v|webm|mov|mkv)$/i.test(f.name));
const isMedia = (f) => isAudio(f) || isVideo(f);

const SUB_LANGS = {
  es: "Español", spa: "Español", en: "Inglés", eng: "Inglés", fr: "Francés", fra: "Francés", fre: "Francés",
  de: "Alemán", deu: "Alemán", ger: "Alemán", it: "Italiano", ita: "Italiano", pt: "Portugués", por: "Portugués",
  ja: "Japonés", jpn: "Japonés", ko: "Coreano", kor: "Coreano", zh: "Chino", zho: "Chino", chi: "Chino",
  ru: "Ruso", rus: "Ruso", ca: "Catalán", cat: "Catalán", gl: "Gallego", glg: "Gallego", eu: "Euskera", eus: "Euskera",
  nl: "Neerlandés", pl: "Polaco", sv: "Sueco", ar: "Árabe",
};
const SUB_NON_LANG = new Set(["sdh", "cc", "hi", "sub", "srt", "vtt", "raw", "old", "new", "dvd", "web", "rip", "hd", "mp4", "mkv", "mov", "m4v", "webm"]);

// Extrae etiqueta legible e idioma opcional (BCP-47) a partir del nombre de un .srt/.vtt y la base del video.
function subtitleLabel(fileName, trackBase = "") {
  const stem = String(fileName || "").replace(/\.[^.]+$/, "").trim();
  const lower = stem.toLowerCase();
  const base = String(trackBase || "").toLowerCase();
  let suffix = stem;
  if (base && lower === base) suffix = "";
  else if (base && lower.startsWith(base + ".")) suffix = stem.slice(base.length + 1);
  const parts = suffix.split(".").map((p) => p.trim()).filter(Boolean);
  if (base && parts.length > 1 && /^(mp4|m4v|webm|mov|mkv)$/i.test(parts[0])) parts.shift();

  let lang;
  if (parts.length) {
    const candidate = base ? parts[0] : (parts.length > 1 ? parts[parts.length - 1] : parts[0]);
    const head = candidate.split("-")[0].toLowerCase();
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(candidate) && !SUB_NON_LANG.has(head) && (head.length === 2 || Object.hasOwn(SUB_LANGS, head))) {
      lang = candidate.toLowerCase();
    }
  }

  let label;
  if (!parts.length) {
    label = "Subtítulos";
  } else if (base && lang && parts[0].toLowerCase() === lang) {
    const langName = SUB_LANGS[lang.split("-")[0]] || lang;
    const region = lang.includes("-") ? ` (${lang.slice(lang.indexOf("-") + 1).toUpperCase()})` : "";
    const rest = parts.slice(1).join(" ");
    label = `${langName}${region}${rest ? ` · ${rest}` : ""}`;
  } else {
    label = parts.join(" ");
  }
  return lang ? { label, lang } : { label };
}

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

const isAc3Codec = (c) => /^(ac-3|ec-3|mp4a\.a5|mp4a\.a6|a_e?ac3)(\.|$)/i.test(String(c || "").trim());

const isMkvCodec = (c) => /^[VA]_/i.test(String(c || "").trim());

// Equivalencia de CodecID Matroska/WebM → tipos MIME que entiende HTMLMediaElement.canPlayType.
function mkvCodecMimes(codecId) {
  const c = String(codecId || "").trim().toUpperCase();
  if (!c) return null;
  if (c === "V_MPEG4/ISO/AVC") return ['video/mp4; codecs="avc1.42E01E"'];
  if (c === "V_MPEGH/ISO/HEVC") return ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'];
  if (c === "V_VP8") return ['video/webm; codecs="vp8"'];
  if (c === "V_VP9") return ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'];
  if (c === "V_AV1") return ['video/webm; codecs="av01.0.04M.08"', 'video/mp4; codecs="av01.0.04M.08"'];
  if (c === "V_THEORA") return ['video/ogg; codecs="theora"'];
  if (/^V_MPEG4\/ISO\/(SP|ASP|AP)$/.test(c)) return ['video/mp4; codecs="mp4v.20.8"'];
  if (c === "A_OPUS") return ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'];
  if (c === "A_VORBIS") return ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'];
  if (c === "A_AAC" || c.startsWith("A_AAC/")) return ['audio/mp4; codecs="mp4a.40.2"'];
  if (c === "A_MPEG/L3" || c === "A_MPEG/L2" || c === "A_MPEG/L1") return ["audio/mpeg"];
  if (c === "A_FLAC") return ["audio/flac", 'audio/mp4; codecs="flac"'];
  if (c === "A_AC3") return ['audio/mp4; codecs="ac-3"', 'video/mp4; codecs="ac-3"'];
  if (c === "A_EAC3") return ['audio/mp4; codecs="ec-3"', 'video/mp4; codecs="ec-3"'];
  if (c === "A_DTS" || c.startsWith("A_DTS/")) return ['audio/mp4; codecs="dtsc"'];
  if (c === "A_ALAC") return ['audio/mp4; codecs="alac"'];
  if (c.startsWith("A_PCM/")) return ["audio/wav"];
  return null;
}

// Explica en español por qué un medio puede fallar o ha fallado según tipo, extensión y cadena de códecs.
function explainFailure(kind, ext, codecs) {
  const e = String(ext || "").replace(/^\./, "").toLowerCase();
  const list = (Array.isArray(codecs) ? codecs : String(codecs || "").split(","))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const isVid = kind === "video";

  if (UNSUPPORTED_VIDEO_EXT.has(e)) {
    return `El formato ${e.toUpperCase()} no es compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.${e} -c copy salida.mp4`;
  }

  if (list.length) {
    const reasons = [];
    const hasHevc = list.some((c) => /^(hvc1|hev1)(\.|$)|^V_MPEGH\/ISO\/HEVC$/i.test(c));
    const hasAv1 = list.some((c) => /^av01(\.|$)|^V_AV1$/i.test(c));
    const hasVp9 = list.some((c) => /^vp09(\.|$)|^V_VP9$/i.test(c));
    const hasAc3 = list.some((c) => /^(ac-3|mp4a\.a5)(\.|$)|^A_AC3$/i.test(c));
    const hasEac3 = list.some((c) => /^(ec-3|mp4a\.a6)(\.|$)|^A_EAC3$/i.test(c));
    const hasDts = list.some((c) => /^(dtsc|dtse|dtsh|dtsl|dts\+)(\.|$)|^A_DTS(\/|$)/i.test(c));

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
      const exotic = list.filter((c) => !/^(avc[13]|mp4a|opus|flac)(\.|$)|^(V_MPEG4\/ISO\/AVC|V_VP8|A_OPUS|A_VORBIS|A_AAC(\/|$)|A_FLAC|A_MPEG\/L[123]|A_PCM\/)/i.test(c));
      if (exotic.length) reasons.push(`códec no compatible (${exotic.join(", ")})`);
    }
    if (reasons.length) {
      const msg = reasons.join("; ");
      return msg[0].toUpperCase() + msg.slice(1);
    }
    if (e === "mkv") {
      return "El contenedor MKV puede no ser compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.mkv -c copy salida.mp4";
    }
    if (e === "mov") {
      return "El archivo MOV puede no ser compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.mov -c copy salida.mp4";
    }
    return `No se puede reproducir este ${e ? e.toUpperCase() : "archivo"} (códecs: ${list.join(", ")})`;
  }

  if (e === "mkv") {
    return "El contenedor MKV puede no ser compatible. Prueba a remuxear sin recodificar: ffmpeg -i entrada.mkv -c copy salida.mp4";
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
    if (list.some(isMkvCodec)) {
      if (e === "mkv" && test("video/x-matroska") === "" && (kind !== "audio" || test("audio/x-matroska") === "")) {
        return { ok: false, reason: explainFailure(kind || "video", "mkv", ""), ac3Unsupported: false };
      }
      const failing = [];
      const ac3Fail = [];
      for (const c of list) {
        const mimes = mkvCodecMimes(c);
        if (!mimes) continue;
        if (!mimes.some((m) => test(m) !== "")) {
          failing.push(c);
          if (isAc3Codec(c)) ac3Fail.push(c);
        }
      }
      if (failing.length || ac3Fail.length) {
        return { ok: false, reason: explainFailure(kind, e, failing.length ? failing : ac3Fail), ac3Unsupported: ac3Fail.length > 0 };
      }
      return { ok: true, reason: "", ac3Unsupported: false };
    }

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
