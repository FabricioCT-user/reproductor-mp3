// Cabeceras Range (electron/lib/rango.js) y el servidor de videos enlazados (electron/lib/medios.js).
// No necesitan Electron: medios.js usa un archivo temporal real y se cuentan los descriptores abiertos (/proc/self/fd).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rango = require("../../electron/lib/rango");
const medios = require("../../electron/lib/medios");

/* ----- rango.js ----- */

const a = (cab, tam = 1000) => rango.analizar(cab, tam);

test("rango: sin cabecera o con otra unidad, el archivo entero (200)", () => {
  for (const c of [undefined, null, "", "   "]) assert.deepEqual(a(c), { estado: 200 });
  assert.deepEqual(a("items=0-5"), { estado: 200 });
});

test("rango: rangos válidos, abiertos y de sufijo", () => {
  assert.deepEqual(a("bytes=0-99"), { estado: 206, inicio: 0, fin: 99 });
  assert.deepEqual(a("bytes=0-0"), { estado: 206, inicio: 0, fin: 0 });
  assert.deepEqual(a("BYTES = 10-19"), { estado: 206, inicio: 10, fin: 19 });
  assert.deepEqual(a("bytes=500-"), { estado: 206, inicio: 500, fin: 999 });
  assert.deepEqual(a("bytes=0-"), { estado: 206, inicio: 0, fin: 999 });
  assert.deepEqual(a("bytes=-100"), { estado: 206, inicio: 900, fin: 999 });
  assert.deepEqual(a("bytes=-5000"), { estado: 206, inicio: 0, fin: 999 }, "sufijo mayor que el archivo: entero");
  assert.deepEqual(a("bytes=990-5000"), { estado: 206, inicio: 990, fin: 999 }, "el final se recorta");
  assert.deepEqual(a("bytes=999-999"), { estado: 206, inicio: 999, fin: 999 });
});

test("rango: fuera del archivo o mal formado → 416", () => {
  for (const c of ["bytes=1000-", "bytes=1000-1001", "bytes=5000-", "bytes=-0", "bytes=5-2", "bytes=", "bytes=-",
    "bytes=a-b", "bytes=1.5-2", "bytes=-1-2", "bytes=0x10-", "bytes=1e3-", "bytes=99999999999999999-", "basura", "bytes=0-1;x"]) {
    assert.deepEqual(a(c), { estado: 416 }, c);
  }
  assert.deepEqual(a("bytes=0-", 0), { estado: 416 }, "archivo vacío");
  assert.deepEqual(a("bytes=-1", 0), { estado: 416 });
});

test("rango: varios rangos → el primero que se pueda servir; ninguno → 416", () => {
  assert.deepEqual(a("bytes=0-9, 20-29"), { estado: 206, inicio: 0, fin: 9 });
  assert.deepEqual(a("bytes=2000-3000,-10"), { estado: 206, inicio: 990, fin: 999 });
  assert.deepEqual(a("bytes=2000-,3000-"), { estado: 416 });
  assert.deepEqual(a("bytes=0-9,x"), { estado: 416 }, "una parte mal formada invalida la cabecera");
});

test("rango: cabeceras de 200, 206 y 416", () => {
  const h200 = rango.cabeceras({ estado: 200 }, 1000, "video/mp4");
  assert.equal(h200["Content-Length"], "1000");
  assert.equal(h200["Accept-Ranges"], "bytes");
  assert.equal(h200["Content-Type"], "video/mp4");
  assert.equal(h200["Content-Range"], undefined);
  const h206 = rango.cabeceras({ estado: 206, inicio: 10, fin: 19 }, 1000, "video/webm");
  assert.equal(h206["Content-Range"], "bytes 10-19/1000");
  assert.equal(h206["Content-Length"], "10");
  assert.equal(h206["X-Content-Type-Options"], "nosniff");
  const h416 = rango.cabeceras({ estado: 416 }, 1000, "video/mp4");
  assert.equal(h416["Content-Range"], "bytes */1000");
  assert.equal(h416["Content-Length"], undefined);
  assert.equal(rango.cabeceras({ estado: 200 }, 5)["Content-Type"], "application/octet-stream");
});

/* ----- medios.js ----- */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "medios-prueba-")));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TAM = 3 * 1024 * 1024 + 123;
const datos = Buffer.alloc(TAM);
for (let i = 0; i < TAM; i++) datos[i] = (i * 31 + (i >> 8)) & 255;
const video = path.join(dir, "película.mp4");
fs.writeFileSync(video, datos);
const entrada = { ruta: video, tamano: TAM, fecha: 0, tipo: "video/mp4" };

// Descriptores de este proceso que apuntan al archivo (Linux).
const abiertos = () => {
  let n = 0;
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    try { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === video) n++; } catch { /* ya cerrado */ }
  }
  return n;
};
const leerTodo = async (flujo) => Buffer.concat(await Array.fromAsync(flujo));
const esperar = () => new Promise((r) => setTimeout(r, 20));

test("medios: 206 con los bytes exactos y el tipo por extensión; el descriptor se cierra al terminar", async () => {
  const r = await medios.servir(entrada, "GET", "bytes=1000-1999999", { trozo: 64 * 1024 });
  assert.equal(r.estado, 206);
  assert.equal(r.cabeceras["Content-Type"], "video/mp4");
  assert.equal(r.cabeceras["Content-Range"], `bytes 1000-1999999/${TAM}`);
  assert.ok(abiertos() === 1);
  const b = await leerTodo(r.cuerpo);
  assert.equal(b.length, 1999000);
  assert.ok(b.equals(datos.subarray(1000, 2000000)));
  await esperar();
  assert.equal(abiertos(), 0);
});

test("medios: sin Range, 200 con el archivo entero; HEAD y 416 no dejan nada abierto", async () => {
  const r = await medios.servir(entrada, "GET", null);
  assert.equal(r.estado, 200);
  assert.ok((await leerTodo(r.cuerpo)).equals(datos));
  const h = await medios.servir(entrada, "HEAD", "bytes=0-9");
  assert.equal(h.estado, 206);
  assert.equal(h.cuerpo, null);
  const f = await medios.servir(entrada, "GET", `bytes=${TAM}-`);
  assert.equal(f.estado, 416);
  assert.equal(f.cabeceras["Content-Range"], `bytes */${TAM}`);
  assert.equal(f.cuerpo, null);
  await esperar();
  assert.equal(abiertos(), 0);
});

test("medios: lee por trozos, sin adelantarse (contrapresión) y cancelar cierra el descriptor", async () => {
  const trozo = 256 * 1024;
  const r = await medios.servir(entrada, "GET", "bytes=0-", { trozo });
  const lector = r.cuerpo.getReader();
  const { value } = await lector.read();
  assert.equal(value.length, trozo);
  assert.ok(Buffer.from(value).equals(datos.subarray(0, trozo)));
  await esperar();
  assert.ok(r.cuerpo.locked);
  assert.equal(abiertos(), 1);
  await lector.cancel();
  await esperar();
  assert.equal(abiertos(), 0, "cancel() cierra el archivo");
});

test("medios: muchas peticiones canceladas a medias (saltos) no dejan descriptores abiertos", async () => {
  for (let i = 0; i < 60; i++) {
    const inicio = Math.floor((i / 60) * TAM);
    const r = await medios.servir(entrada, "GET", `bytes=${inicio}-`, { trozo: 128 * 1024 });
    const lector = r.cuerpo.getReader();
    await lector.read();
    if (i % 3 === 0) await lector.read();
    await lector.cancel();
  }
  await esperar();
  assert.equal(abiertos(), 0);
});

test("medios: ids no registrados, rutas que ya no existen, carpetas, enlaces simbólicos y métodos raros", async () => {
  assert.equal((await medios.servir(null, "GET", null)).estado, 404);
  assert.equal((await medios.servir({ ...entrada, ruta: path.join(dir, "no.mp4") }, "GET", null)).estado, 404);
  assert.equal((await medios.servir({ ...entrada, ruta: dir }, "GET", null)).estado, 404);
  const enlace = path.join(dir, "enlace.mp4");
  fs.symlinkSync(video, enlace);
  assert.equal((await medios.servir({ ...entrada, ruta: enlace }, "GET", null)).estado, 404, "O_NOFOLLOW");
  assert.equal((await medios.servir(entrada, "POST", null)).estado, 405);
  await esperar();
  assert.equal(abiertos(), 0);
});

test("medios: si el archivo se acorta mientras se sirve, el flujo termina sin colgarse", async () => {
  const corto = path.join(dir, "corto.webm");
  fs.writeFileSync(corto, datos.subarray(0, 600000));
  const r = await medios.servir({ ...entrada, ruta: corto }, "GET", null, { trozo: 100000 });
  assert.equal(r.cabeceras["Content-Type"], "video/webm");
  fs.truncateSync(corto, 250000);
  assert.equal((await leerTodo(r.cuerpo)).length, 250000);
});
