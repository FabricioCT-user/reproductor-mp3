// Pico TE.0: puente mínimo. Con sandbox: true solo hay electron (parcial) y process limitado.
"use strict";
const { contextBridge, webUtils } = require("electron");
contextBridge.exposeInMainWorld("pico", {
  ruta: (file) => webUtils.getPathForFile(file),
  sandboxed: process.sandboxed === true,
  versiones: { electron: process.versions.electron, chrome: process.versions.chrome },
});
