// Puente mínimo entre la interfaz y el proceso principal (sandbox: solo electron parcial, sin Node).
// La interfaz nunca recibe rutas: solo { id, name, size, lastModified, type, kind, rel? } y pide los bytes por id.
// La API crece en T2.1 (videos enlazados).
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("reproductor:info") || {};
const lista = (x) => (Array.isArray(x) ? x : []);
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
}));
