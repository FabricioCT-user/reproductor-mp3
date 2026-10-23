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
