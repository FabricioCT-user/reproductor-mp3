// npm run smoke:app — ejecuta tests/smoke.html dentro de Electron (sin mostrar ventana) con una carpeta
// de datos temporal, y sale con 0 (todo bien) o 1. La prueba vacía la base de datos: nunca usa la real.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const electron = require("electron"); // en Node, el paquete devuelve la ruta del binario
const raiz = path.join(__dirname, "..");
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "reproductor-smoke-"));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const hijo = spawn(electron, [raiz, "--smoke", `--user-data-dir=${datos}`], { stdio: "inherit", env });
const limpiar = () => fs.rmSync(datos, { recursive: true, force: true });
hijo.on("error", (e) => { console.error(e); limpiar(); process.exit(1); });
hijo.on("exit", (codigo, senal) => {
  limpiar();
  if (senal) console.error(`Electron terminó por la señal ${senal}`);
  process.exit(codigo === 0 ? 0 : 1);
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => hijo.kill(s));
