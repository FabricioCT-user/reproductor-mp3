// Archivos que el sistema entregó a la app y la interfaz aún no ha recogido. Sin Electron: se prueba con node:test.
// La ruta real se queda aquí; la interfaz solo recibe { id, name, size, lastModified, type, kind, rel? } y pide los
// bytes por id (una sola vez). Los ids caducan: un id viejo, repetido o inventado no lee nada.
// Los videos no se leen ni se copian: la interfaz los enlaza (tomar(id, ["video"]) → enlaces.js, T2.1) y se sirven
// por app://reproductor/__media/<linkId>.
"use strict";

const crypto = require("node:crypto");

const ID = /^[0-9a-f]{32}$/;
const CADUCIDAD_MS = 10 * 60 * 1000;
const MAXIMO = 10000;
const LEIBLES = new Set(["audio", "letra", "subtitulo"]);

class Entregas {
  constructor({ ahora = () => Date.now(), caducidad = CADUCIDAD_MS, maximo = MAXIMO } = {}) {
    this.ahora = ahora;
    this.caducidad = caducidad;
    this.maximo = maximo;
    this.mapa = new Map();
  }

  // Resultado de rutas.validar (+ rel opcional) → objeto público para la interfaz (sin la ruta).
  registrar(v) {
    this.limpiar();
    while (this.mapa.size >= this.maximo) this.mapa.delete(this.mapa.keys().next().value);
    const id = crypto.randomBytes(16).toString("hex");
    this.mapa.set(id, { ruta: v.ruta, clase: v.clase, tamano: v.tamano, fecha: v.fecha, hasta: this.ahora() + this.caducidad });
    const pub = { id, name: v.nombre, size: v.tamano, lastModified: v.fecha, type: v.tipo, kind: v.clase };
    if (typeof v.rel === "string") pub.rel = v.rel;
    return pub;
  }

  // id → entrada { ruta, clase, tamano, fecha } si existe, no ha caducado y es de una de las `clases` (por defecto,
  // las que se leen: nunca video). Se consume.
  tomar(id, clases = LEIBLES) {
    this.limpiar();
    if (typeof id !== "string" || !ID.test(id)) return null;
    const e = this.mapa.get(id);
    if (!e || !new Set(clases).has(e.clase)) return null;
    this.mapa.delete(id);
    return e;
  }

  limpiar() {
    const t = this.ahora();
    for (const [id, e] of this.mapa) if (e.hasta <= t) this.mapa.delete(id);
  }

  get tamano() { return this.mapa.size; }
}

module.exports = { Entregas, CADUCIDAD_MS };
