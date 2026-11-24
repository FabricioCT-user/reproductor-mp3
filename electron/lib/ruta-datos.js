// El nombre viejo se conserva a propósito: Electron cambiando de paquete usaría otro userData
// y dejaría invisibles los perfiles 1.0.0 con su IndexedDB y localStorage.
"use strict";

const path = require("node:path");

function rutaDatos({ xdgConfigHome, home, userDataDir, appData, cwd = process.cwd() } = {}) {
  if (typeof userDataDir === "string" && userDataDir.length > 0) {
    return path.resolve(cwd, userDataDir);
  }
  const base = typeof xdgConfigHome === "string" && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : typeof appData === "string" && path.isAbsolute(appData)
      ? appData
      : typeof home === "string" && path.isAbsolute(home)
        ? path.join(home, ".config")
        : require("node:os").tmpdir();
  return path.join(base, "reproductor-mp3");
}

module.exports = { rutaDatos };
