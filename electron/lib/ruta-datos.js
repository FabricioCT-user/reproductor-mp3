// El nombre viejo se conserva a propósito: Electron cambiando de paquete usaría otro userData
// y dejaría invisibles los perfiles 1.0.0 con su IndexedDB y localStorage.
"use strict";

const path = require("node:path");

function rutaDatos({ xdgConfigHome, home, userDataDir } = {}) {
  if (typeof userDataDir === "string" && path.isAbsolute(userDataDir)) return path.resolve(userDataDir);
  const base = typeof xdgConfigHome === "string" && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(home || require("node:os").homedir(), ".config");
  return path.join(base, "reproductor-mp3");
}

module.exports = { rutaDatos };
