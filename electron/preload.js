// Puente mínimo entre la interfaz y el proceso principal (sandbox: solo electron parcial, sin Node).
// La API crece en TE.2 (abrir archivos) y T2.1 (videos enlazados).
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("reproductor:info") || {};

contextBridge.exposeInMainWorld("reproductor", Object.freeze({
  esApp: true,
  version: typeof info.version === "string" ? info.version : null,
}));
