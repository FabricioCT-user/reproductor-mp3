"use strict";
// Esquema v2 de IndexedDB y migración v1 → v2 (src/storage.js) sobre una IndexedDB falsa en memoria.
// La migración real en el navegador se prueba además en tests/smoke.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createFakeIndexedDB } = require("./fake-idb");
const { bytesOf, sameBytes, fakeAudio } = require("./helpers");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "src", "storage.js"), "utf8");
const NAME = "reproductor-mp3";

// Un Storage nuevo (como al recargar la página) sobre la IndexedDB falsa indicada.
function loadStorage(idb) {
  const ctx = vm.createContext({ Blob, File, indexedDB: idb, setTimeout, console });
  vm.runInContext(SRC, ctx, { filename: "storage.js" });
  return vm.runInContext("Storage", ctx);
}

// Los objetos creados dentro del contexto aislado tienen otros prototipos: se copian (sin tocar los Blob) antes de comparar.
const norm = (v) => (v instanceof Blob || v === null || typeof v !== "object" ? v
  : Array.isArray(v) ? v.map(norm) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])));

const song = (name, n = 600, mtime = 1234) => new File([fakeAudio(n)], name, { type: "audio/mpeg", lastModified: mtime });

// Lo que hay guardado de verdad en la base (sin pasar por Storage).
const raw = (idb, store) => [...(idb.dbs.get(NAME)?.stores.get(store)?.data.values() ?? [])];
const version = (idb) => idb.dbs.get(NAME)?.version;

// Crea una base v1 exactamente como la dejaba la versión anterior y le mete estos registros.
async function seedV1(idb, records) {
  const db = await new Promise((resolve, reject) => {
    const req = idb.open(NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const t = db.transaction("tracks", "readwrite");
    for (const r of records) t.objectStore("tracks").add(r);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

test("base nueva: crea v2 con los almacenes tracks y files", async () => {
  const idb = createFakeIndexedDB();
  const S = loadStorage(idb);
  assert.deepEqual([...(await S.all())], []);
  assert.equal(version(idb), 2);
  assert.ok(idb.dbs.get(NAME).stores.has("tracks") && idb.dbs.get(NAME).stores.has("files"));
});

test("add: los metadatos van a tracks y el archivo a files, con la misma clave", async () => {
  const idb = createFakeIndexedDB();
  const S = loadStorage(idb);
  const f = song("uno.mp3", 700, 1700000000500);
  const id = await S.add(f);
  assert.equal(typeof id, "number");
  const [rec] = raw(idb, "tracks");
  assert.deepEqual(rec, { id, name: "uno.mp3", type: "audio/mpeg", size: 700, lastModified: 1700000000500, kind: "audio", source: "blob" });
  assert.equal(raw(idb, "files")[0].id, id);
  assert.equal(raw(idb, "files")[0].blob, f);

  const all = await S.all();
  assert.equal(all.length, 1);
  assert.equal("blob" in all[0], false, "all() no devuelve el archivo");
  const got = await S.getFile(id);
  assert.ok(got instanceof File);
  assert.equal(got.name, "uno.mp3");
  assert.ok(sameBytes(await bytesOf(got), fakeAudio(700)));
});

test("add con source «link»: no se guarda ningún archivo; getFile devuelve null", async () => {
  const idb = createFakeIndexedDB();
  const S = loadStorage(idb);
  const id = await S.add(song("video.mp4"), { kind: "video", source: "link", linkId: "a1b2" });
  assert.equal(raw(idb, "files").length, 0);
  const [rec] = await S.all();
  assert.equal(rec.source, "link");
  assert.equal(rec.linkId, "a1b2");
  assert.equal(rec.kind, "video");
  assert.equal(await S.getFile(id), null);
  assert.equal(await S.getFile(999), null, "un id que no existe");
});

test("add solo persiste campos permitidos y descarta rutas", async () => {
  const idb = createFakeIndexedDB();
  const S = loadStorage(idb);
  const id = await S.add(song("local.mp3"), {
    kind: "audio", source: "link", linkId: "opaque-123", meta: { title: "Título" }, lyrics: "letra",
    id: 987, name: "sobrescrito.mp3", type: "application/octet-stream", size: 1, lastModified: 1,
    path: "/home/persona/música/local.mp3", filePath: "C:\\Users\\persona\\local.mp3", directory: "/privada",
  });
  const [rec] = raw(idb, "tracks");
  assert.equal(rec.id, id);
  assert.equal(rec.name, "local.mp3");
  assert.equal(rec.type, "audio/mpeg");
  assert.equal(rec.size, 600);
  assert.equal(rec.lastModified, 1234);
  assert.equal(rec.id, id, "extra no puede sobrescribir la identidad de la pista");
  assert.equal(rec.source, "link");
  assert.equal(rec.linkId, "opaque-123");
  assert.deepEqual(norm(rec.meta), { title: "Título" });
  assert.equal(rec.lyrics, "letra");
  for (const key of ["path", "filePath", "directory"]) assert.equal(key in rec, false, `${key} no se persiste`);
  assert.equal(raw(idb, "files").length, 0, "un link no copia el archivo");
});

test("setLyrics / setEdits solo tocan tracks: el archivo guardado no se reescribe", async () => {
  const idb = createFakeIndexedDB();
  const S = loadStorage(idb);
  const f = song("uno.mp3");
  const id = await S.add(f);
  let filePuts = 0;
  idb.fail = (store, op) => { if (store === "files") filePuts++; return null; };
  await S.setLyrics(id, "[00:01.00]Hola");
  await S.setEdits(id, { title: "Otro" });
  assert.equal(filePuts, 0);
  let [rec] = raw(idb, "tracks");
  assert.equal(rec.lyrics, "[00:01.00]Hola");
  assert.deepEqual(norm(rec.edits), { title: "Otro" });
  assert.equal("blob" in rec, false);
  await S.setLyrics(id, null);
  [rec] = raw(idb, "tracks");
  assert.equal("lyrics" in rec, false, "null borra el campo");
  assert.equal(raw(idb, "files")[0].blob, f);
});

test("remove y clear borran en los dos almacenes", async () => {
  const idb = createFakeIndexedDB();
  const S = loadStorage(idb);
  const a = await S.add(song("a.mp3"));
  await S.add(song("b.mp3"));
  await S.add(song("c.mp3"));
  await S.remove(a);
  assert.deepEqual(raw(idb, "tracks").map((r) => r.name), ["b.mp3", "c.mp3"]);
  assert.equal(raw(idb, "files").length, 2);
  assert.equal(raw(idb, "files").some((r) => r.id === a), false);
  await S.clear();
  assert.equal(raw(idb, "tracks").length, 0);
  assert.equal(raw(idb, "files").length, 0);
});

test("migración v1 → v2: mueve cada archivo a files y conserva todo lo demás", async () => {
  const idb = createFakeIndexedDB();
  const a = song("a.mp3", 500, 111);
  const b = song("b.flac", 900, 222);
  const cover = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  await seedV1(idb, [
    { name: "a.mp3", blob: a, type: "audio/mpeg", lyrics: "[00:00.50]Hola", edits: { title: "Título", cover } },
    { name: "b.flac", blob: b, type: "audio/flac" },
  ]);
  assert.equal(version(idb), 1);

  const S = loadStorage(idb);
  const all = await S.all();
  assert.equal(version(idb), 2);
  assert.deepEqual(all.map((r) => r.id), [1, 2], "los ids no cambian (el orden y las listas los usan)");
  assert.deepEqual(norm(all[0]), { id: 1, name: "a.mp3", type: "audio/mpeg", lyrics: "[00:00.50]Hola", edits: { title: "Título", cover }, size: 500, lastModified: 111, kind: "audio", source: "blob" });
  assert.equal(all[0].edits.cover, cover, "la carátula editada se conserva");
  assert.deepEqual(norm(all[1]), { id: 2, name: "b.flac", type: "audio/flac", size: 900, lastModified: 222, kind: "audio", source: "blob" });
  assert.ok(raw(idb, "tracks").every((r) => !("blob" in r)), "tracks ya no guarda archivos");
  assert.deepEqual(raw(idb, "files").map((r) => [r.id, r.blob]), [[1, a], [2, b]]);

  assert.equal(await S.getFile(1), a);
  assert.ok(sameBytes(await bytesOf(await S.getFile(2)), fakeAudio(900)));

  // Lo nuevo sigue numerándose después de lo migrado.
  assert.equal(await S.add(song("c.mp3")), 3);

  // Reabrir no vuelve a migrar ni cambia nada.
  const before = JSON.stringify(raw(idb, "tracks"));
  const S2 = loadStorage(idb);
  assert.equal((await S2.all()).length, 3);
  assert.equal(JSON.stringify(raw(idb, "tracks")), before);
});

test("migración v1 → v2 con registros corruptos: se dejan tal cual y no impiden migrar el resto", async () => {
  const idb = createFakeIndexedDB();
  const good = song("bueno.mp3", 400, 5);
  await seedV1(idb, [
    { name: "roto.mp3", type: "audio/mpeg" },              // sin blob
    { name: "texto.mp3", blob: "no soy un archivo" },       // blob que no es Blob
    { name: "nulo.mp3", blob: null, lyrics: "letra" },
    { name: "bueno.mp3", blob: good, type: "audio/mpeg" },
  ]);
  const S = loadStorage(idb);
  const all = await S.all();
  assert.equal(version(idb), 2);
  assert.equal(all.length, 4, "no se borra nada al migrar");
  assert.deepEqual(raw(idb, "tracks").slice(0, 3), [
    { id: 1, name: "roto.mp3", type: "audio/mpeg" },
    { id: 2, name: "texto.mp3", blob: "no soy un archivo" },
    { id: 3, name: "nulo.mp3", blob: null, lyrics: "letra" },
  ]);
  assert.equal(raw(idb, "tracks")[3].source, "blob");
  assert.deepEqual(raw(idb, "files").map((r) => r.id), [4]);
  for (const id of [1, 2, 3]) assert.equal(await S.getFile(id), null);
  assert.equal(await S.getFile(4), good);
});

test("si la migración falla (p. ej. sin espacio), la base sigue en v1 intacta y se usa tal cual", async () => {
  const idb = createFakeIndexedDB();
  const a = song("a.mp3", 300, 1);
  const b = song("b.mp3", 300, 2);
  await seedV1(idb, [
    { name: "a.mp3", blob: a, type: "audio/mpeg", lyrics: "uno" },
    { name: "b.mp3", blob: b, type: "audio/mpeg" },
  ]);
  const before = raw(idb, "tracks");
  idb.fail = (store, op, value) => (store === "files" && value.id === 2 ? "QuotaExceededError" : null);

  const S = loadStorage(idb);
  const all = await S.all();
  assert.equal(version(idb), 1, "la actualización se deshace entera");
  assert.equal(idb.dbs.get(NAME).stores.has("files"), false);
  assert.deepEqual(raw(idb, "tracks"), before, "ningún registro ha cambiado");
  assert.deepEqual(all.map((r) => r.name), ["a.mp3", "b.mp3"]);
  assert.equal("blob" in all[0], false);

  // La app sigue funcionando con la base en v1.
  assert.equal(await S.getFile(1), a);
  assert.equal(await S.getFile(2), b);
  await S.setLyrics(2, "dos");
  assert.equal(raw(idb, "tracks")[1].blob, b, "en v1 la letra se guarda sin perder el archivo");
  assert.equal(raw(idb, "tracks")[1].lyrics, "dos");
  const id = await S.add(song("c.mp3"));
  assert.equal(raw(idb, "tracks")[2].blob instanceof Blob, true, "en v1 lo nuevo se guarda en formato v1");
  await S.remove(id);
  assert.equal(raw(idb, "tracks").length, 2);

  // Al volver a abrir con espacio, la migración se completa.
  idb.fail = null;
  const S2 = loadStorage(idb);
  await S2.all();
  assert.equal(version(idb), 2);
  assert.deepEqual(raw(idb, "files").map((r) => r.blob), [a, b]);
  assert.equal(raw(idb, "tracks")[1].lyrics, "dos");
});

test("migrateRecord: Blob sin fecha y valores raros", () => {
  const S = loadStorage(createFakeIndexedDB());
  const blob = new Blob([new Uint8Array(10)], { type: "audio/ogg" });
  const m = S.migrateRecord({ id: 7, name: "x.ogg", blob });
  assert.deepEqual(norm(m.track), { id: 7, name: "x.ogg", type: "audio/ogg", size: 10, kind: "audio", source: "blob" });
  assert.deepEqual(norm(m.file), { id: 7, blob });
  for (const bad of [null, undefined, 5, "x", {}, { blob: {} }, { blob: [1, 2] }]) assert.equal(S.migrateRecord(bad), null);
});

test("getFile envuelve un Blob sin nombre en un File con el nombre del registro", async () => {
  const idb = createFakeIndexedDB();
  await seedV1(idb, [{ name: "suelto.ogg", blob: new Blob([new Uint8Array(4)], { type: "audio/ogg" }), type: "audio/ogg" }]);
  const S = loadStorage(idb);
  const f = await S.getFile(1);
  assert.ok(f instanceof File);
  assert.equal(f.name, "suelto.ogg");
  assert.equal(f.type, "audio/ogg");
  assert.equal(f.size, 4);
});
