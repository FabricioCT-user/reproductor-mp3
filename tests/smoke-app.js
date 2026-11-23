// npm run smoke:app — ejecuta tests/smoke.html dentro de Electron (sin mostrar ventana) con una carpeta
// de datos temporal, y sale con 0 (todo bien) o 1. La prueba vacía la base de datos: nunca usa la real.
// También lanza la app con archivos en argv (TE.2): se generan en otra carpeta temporal (con espacios en la ruta).
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const electron = require("electron"); // en Node, el paquete devuelve la ruta del binario
const raiz = path.join(__dirname, "..");
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "reproductor-smoke-"));
const medios = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reproductor-smoke-medios-")), "carpeta con espacios");

// WAV PCM 16 bits mono con un seno.
function wav(segundos, freq) {
  const tasa = 22050;
  const n = Math.round(segundos * tasa);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(tasa, 24); b.writeUInt32LE(tasa * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / tasa)), 44 + i * 2);
  return b;
}

const escribir = (rel, contenido) => {
  const p = path.join(medios, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contenido);
  return p;
};
const uno = escribir("uno.wav", wav(8, 440));
const dos = escribir("dos con espacios ñ.wav", wav(3, 550));
escribir("tres.wav", wav(8, 660)); // lo abre la segunda instancia
escribir("sub/cuatro.wav", wav(1, 330)); // solo al elegir la carpeta
const lrc = escribir("uno.lrc", "[00:00.00]Hola\n[00:02.00]mundo\n");
const nota = escribir("nota.mp3.txt", "no es audio");
const video = escribir("video.mp4", Buffer.alloc(2000, 1));
fs.symlinkSync(uno, path.join(medios, "enlace.wav"));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// uno.wav debe ir primero (la prueba deduce de él la carpeta de los medios).
const archivos = [uno, pathToFileURL(dos).href, lrc, path.join(medios, "no-existe.mp3"), nota, video, medios];
const hijo = spawn(electron, [raiz, "--smoke", `--user-data-dir=${datos}`, ...archivos], { stdio: "inherit", env });
const limpiar = () => {
  fs.rmSync(datos, { recursive: true, force: true });
  fs.rmSync(path.dirname(medios), { recursive: true, force: true });
};
hijo.on("error", (e) => { console.error(e); limpiar(); process.exit(1); });
hijo.on("exit", (codigo, senal) => {
  limpiar();
  if (senal) console.error(`Electron terminó por la señal ${senal}`);
  process.exit(codigo === 0 ? 0 : 1);
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => hijo.kill(s));
