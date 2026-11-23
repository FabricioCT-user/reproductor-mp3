// Registro de videos enlazados: id opaco → ruta real del archivo. Sin Electron: se prueba con node:test.
// Vive solo en el proceso principal, en userData/enlaces.json (permisos 0600, escritura atómica: temporal + rename).
// La interfaz guarda en IndexedDB { source: "link", linkId } y pide los bytes por app://reproductor/__media/<id>:
// la ruta nunca sale de aquí. Solo se registran archivos que la persona eligió (diálogo, «Abrir con…», arrastrar).
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID = /^[0-9a-f]{32}$/;
const FORMATO = 1;

const esId = (id) => typeof id === "string" && ID.test(id);

// Entrada leída del JSON → entrada válida o null (lo que no encaja se descarta sin romper el resto).
function limpiarEntrada(e) {
  if (!e || typeof e !== "object") return null;
  const { ruta, tamano, fecha, tipo } = e;
  if (typeof ruta !== "string" || !path.isAbsolute(ruta) || ruta.includes("\0")) return null;
  if (!Number.isSafeInteger(tamano) || tamano < 0 || !Number.isFinite(fecha)) return null;
  return { ruta, tamano, fecha, tipo: typeof tipo === "string" ? tipo : "" };
}

class Enlaces {
  constructor(archivo) {
    this.archivo = archivo;
    this.mapa = new Map();
    this.cola = Promise.resolve();
  }

  // Lee el registro. Si no existe, vacío; si está corrupto, se aparta (enlaces.json.corrupto) y se empieza vacío:
  // nunca rompe el arranque. Devuelve this.
  async cargar() {
    let texto;
    try { texto = await fs.promises.readFile(this.archivo, "utf8"); } catch { return this; }
    let datos = null;
    try { datos = JSON.parse(texto); } catch { /* corrupto */ }
    if (!datos || typeof datos !== "object" || !datos.enlaces || typeof datos.enlaces !== "object") {
      await fs.promises.rename(this.archivo, `${this.archivo}.corrupto`).catch(() => {});
      return this;
    }
    for (const [id, e] of Object.entries(datos.enlaces)) {
      const v = esId(id) && limpiarEntrada(e);
      if (v) this.mapa.set(id, v);
    }
    return this;
  }

  // Resultado de rutas.validar (un video) → id nuevo. Cada pista tiene su id: olvidar uno no afecta a otra.
  async registrar(v) {
    const e = limpiarEntrada({ ruta: v.ruta, tamano: v.tamano, fecha: v.fecha, tipo: v.tipo });
    if (!e) throw new Error("entrada no válida");
    let id;
    do id = crypto.randomBytes(16).toString("hex"); while (this.mapa.has(id));
    this.mapa.set(id, e);
    await this.guardar();
    return id;
  }

  obtener(id) {
    return esId(id) ? this.mapa.get(id) ?? null : null;
  }

  async olvidar(id) {
    if (!esId(id) || !this.mapa.delete(id)) return false;
    await this.guardar();
    return true;
  }

  async vaciar() {
    this.mapa.clear();
    await this.guardar();
  }

  // ids → { id: "ok" | "falta" | "cambiado" | "desconocido" } (T2.2 lo usará para marcar «no encontrado»).
  async estado(ids) {
    const out = {};
    for (const id of Array.isArray(ids) ? ids.slice(0, 100000) : []) {
      if (!esId(id)) continue;
      const e = this.mapa.get(id);
      if (!e) { out[id] = "desconocido"; continue; }
      const st = await fs.promises.stat(e.ruta).catch(() => null);
      if (!st?.isFile()) out[id] = "falta";
      else out[id] = st.size === e.tamano && Math.floor(st.mtimeMs) === Math.floor(e.fecha) ? "ok" : "cambiado";
    }
    return out;
  }

  get tamano() { return this.mapa.size; }

  // Escrituras en fila (cada una con el estado del momento): nunca dos a la vez sobre el mismo temporal.
  guardar() {
    const texto = JSON.stringify({ formato: FORMATO, enlaces: Object.fromEntries(this.mapa) });
    const escribir = () => escribirAtomico(this.archivo, texto);
    this.cola = this.cola.then(escribir, escribir);
    return this.cola;
  }
}

async function escribirAtomico(archivo, texto) {
  await fs.promises.mkdir(path.dirname(archivo), { recursive: true, mode: 0o700 });
  const tmp = `${archivo}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fh = await fs.promises.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(texto, "utf8");
    await fh.chmod(0o600); // por si la umask quitó algo (nunca añade: 0600 es lo máximo)
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  try { await fs.promises.rename(tmp, archivo); } catch (e) { await fs.promises.rm(tmp, { force: true }); throw e; }
}

module.exports = { Enlaces, esId };
