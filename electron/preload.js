// Puente mínimo entre la interfaz y el proceso principal (sandbox: solo electron parcial, sin Node).
// La interfaz nunca recibe rutas: solo { id, name, size, lastModified, type, kind, rel? } y pide los bytes por id.
// Videos (T2.1): no se copian; se enlazan y la interfaz recibe un linkId opaco que sirve app://reproductor/__media/<id>.
"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const info = ipcRenderer.sendSync("reproductor:info") || {};
const lista = (x) => (Array.isArray(x) ? x : []);
const ID = /^[0-9a-f]{32}$/;

// Ruta de un File real (arrastrado o de un <input>) sin que la página la vea; "" si es sintético o no es un File.
function rutaDe(archivo) {
  try { return archivo instanceof File ? webUtils.getPathForFile(archivo) || "" : ""; } catch { return ""; }
}
let abrir = null;

// Archivos que llegan del sistema (argv al arrancar, «Abrir con…» con la app abierta). Se recogen al registrar
// el manejador (lo que llegó antes de cargar la página) y cada vez que el principal avisa.
// Sin manejador (p. ej. la página de pruebas) no se recoge nada: se quedan para la próxima página que lo registre.
async function recoger() {
  if (!abrir) return;
  const items = lista(await ipcRenderer.invoke("reproductor:pendientes"));
  if (items.length) abrir(items);
}
ipcRenderer.on("reproductor:hay-archivos", () => { recoger().catch(() => {}); });

contextBridge.exposeInMainWorld("reproductor", Object.freeze({
  esApp: true,
  version: typeof info.version === "string" ? info.version : null,
  // Un solo manejador por página.
  onAbrir(cb) {
    if (typeof cb !== "function" || abrir) return;
    abrir = cb;
    recoger().catch(() => {});
  },
  // Diálogo nativo (multiselección; { carpeta: true } elige carpetas y recorre sus subcarpetas). [] si se cancela.
  elegirArchivos: (opciones) => ipcRenderer.invoke("reproductor:elegir", { carpeta: opciones?.carpeta === true }).then(lista),
  // Bytes (Uint8Array) de un archivo entregado, o null; cada id sirve una vez. Los videos no se leen (T2.1 los enlazará).
  leer: (id) => ipcRenderer.invoke("reproductor:leer", typeof id === "string" ? id : ""),
  // Enlaza un video: el id de una entrega (kind "video") o un File con ruta real. → { linkId, name, size, lastModified,
  // type } o null (no es un video válido, File sintético, id usado o caducado). La ruta no vuelve nunca a la página.
  async enlazar(x) {
    if (typeof x === "string") return ID.test(x) ? ipcRenderer.invoke("reproductor:enlazar", { entrega: x }) : null;
    const ruta = rutaDe(x);
    return ruta ? ipcRenderer.invoke("reproductor:enlazar", { ruta }) : null;
  },
  // Quita un enlace del registro (al borrar la pista). → true si existía.
  olvidar: (linkId) => ipcRenderer.invoke("reproductor:olvidar", typeof linkId === "string" ? linkId : ""),
  // ids → { id: "ok" | "falta" | "cambiado" | "desconocido" } (para T2.2).
  estadoEnlaces: (ids) => ipcRenderer.invoke("reproductor:estado-enlaces", lista(ids).filter((i) => typeof i === "string")),
}));
