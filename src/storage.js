// Persistencia de la biblioteca en IndexedDB (solo en este navegador).
//
// Esquema v2 (base «reproductor-mp3»):
//   tracks: { id, name, type, size, lastModified, kind, source, linkId?, lyrics?, edits?, meta?, subs?, thumb? }
//           — solo metadatos: leer o guardar una letra nunca toca el archivo.
//   files:  { id, blob } — el archivo, con la misma clave que su registro de `tracks`; solo para source "blob".
// source: "blob" (copiado aquí) | "link" (enlazado por la app de escritorio mediante `linkId`, un id opaco;
// la ruta nunca se guarda en IndexedDB) | "session" (no se pudo guardar: solo para esta sesión).
//
// v1 guardaba el archivo dentro del registro (`tracks.blob`); la migración lo mueve a `files`.
const Storage = (() => {
  const NAME = "reproductor-mp3";
  const VERSION = 2;
  let dbPromise;

  // v1 → v2 para un registro: separa el archivo de los metadatos. Devuelve null si no tiene un archivo válido
  // (ese registro se deja tal cual; el arranque decide qué hacer con él).
  function migrateRecord(rec) {
    if (!rec || typeof rec !== "object" || !(rec.blob instanceof Blob)) return null;
    const { blob, ...rest } = rec;
    const track = { ...rest, type: rec.type || blob.type || "", size: blob.size, kind: rec.kind || "audio", source: "blob" };
    if (Number.isFinite(blob.lastModified)) track.lastModified = blob.lastModified;
    return { track, file: { id: rec.id, blob } };
  }

  // Se ejecuta dentro de la transacción de actualización: si algo falla, se deshace entera y la base sigue en v1.
  function upgrade(db, t, oldVersion) {
    if (oldVersion < 1) db.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
    if (oldVersion < 2) {
      const files = db.createObjectStore("files", { keyPath: "id" });
      if (oldVersion < 1) return;
      t.objectStore("tracks").openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        const m = migrateRecord(cursor.value);
        if (m) { files.put(m.file); cursor.update(m.track); }
        cursor.continue();
      };
    }
  }

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => {
      // Si otra pestaña pide actualizar o borrar la base, se cierra esta conexión para no bloquearla.
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });

  function open() {
    dbPromise ??= (async () => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => upgrade(req.result, req.transaction, e.oldVersion);
      try {
        return await request(req);
      } catch (err) {
        // Si la migración no se pudo completar (p. ej. sin espacio) o la base es de una versión más nueva,
        // se abre tal como esté: los datos siguen intactos y se usan en su formato (ver `hasFiles`).
        try { return await request(indexedDB.open(NAME)); } catch { throw err; }
      }
    })().catch((err) => { dbPromise = null; throw err; }); // permite reintentar
    return dbPromise;
  }

  // ¿La base ya tiene el almacén de archivos? (no, si sigue en v1 porque la migración falló).
  const hasFiles = (db) => db.objectStoreNames.contains("files");

  // Ejecuta fn(stores) en una transacción sobre los almacenes que existan y devuelve lo que deje en `out.result`.
  async function tx(mode, fn) {
    const db = await open();
    const names = hasFiles(db) ? ["tracks", "files"] : ["tracks"];
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      const out = {};
      fn({ tracks: t.objectStore("tracks"), files: names.length > 1 ? t.objectStore("files") : null }, out);
      t.oncomplete = () => resolve(out.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // Guarda un archivo nuevo. `extra` permite fijar otros metadatos (kind, source "link" + linkId…).
  // Devuelve el id.
  const add = (file, extra = {}) => tx("readwrite", ({ tracks, files }, out) => {
    if (!files) { // base aún en v1
      tracks.add({ name: file.name, blob: file, type: file.type }).onsuccess = (e) => (out.result = e.target.result);
      return;
    }
    const rec = { name: file.name, type: file.type, size: file.size, kind: "audio", source: "blob", ...extra };
    if (Number.isFinite(file.lastModified)) rec.lastModified ??= file.lastModified;
    tracks.add(rec).onsuccess = (e) => {
      out.result = e.target.result;
      if (rec.source === "blob") files.put({ id: out.result, blob: file });
    };
  });

  // El archivo de una pista (perezoso: solo se lee cuando hace falta). null si no hay.
  const getFile = (id) => tx("readonly", ({ tracks, files }, out) => {
    let rec, stored;
    out.result = null;
    const done = () => {
      const blob = stored?.blob instanceof Blob ? stored.blob : rec?.blob instanceof Blob ? rec.blob : null;
      if (!blob || !rec) return;
      out.result = blob instanceof File ? blob
        : new File([blob], rec.name || "", { type: rec.type || blob.type || "", lastModified: rec.lastModified });
    };
    // Las peticiones de una transacción terminan en el orden en que se hicieron: se resuelve en la última.
    tracks.get(id).onsuccess = (e) => { rec = e.target.result; if (!files) done(); };
    if (files) files.get(id).onsuccess = (e) => { stored = e.target.result; done(); };
  });

  // Guarda (o borra, con null) un campo del registro de la pista: letra cargada, ediciones de etiquetas…
  // Solo toca `tracks`: el archivo no se lee ni se reescribe.
  const setField = (id, key, value) => tx("readwrite", ({ tracks }) => {
    const get = tracks.get(id);
    get.onsuccess = () => {
      const rec = get.result;
      if (!rec) return;
      if (value) rec[key] = value; else delete rec[key];
      tracks.put(rec);
    };
  });

  return {
    setLyrics: (id, text) => setField(id, "lyrics", text),
    setEdits: (id, edits) => setField(id, "edits", edits),
    add,
    getFile,
    remove: (id) => tx("readwrite", ({ tracks, files }) => { tracks.delete(id); files?.delete(id); }),
    clear: () => tx("readwrite", ({ tracks, files }) => { tracks.clear(); files?.clear(); }),
    // Solo los metadatos (sin el archivo, también si la base sigue en v1); el archivo se pide con getFile(id).
    all: () => tx("readonly", ({ tracks }, out) => {
      tracks.getAll().onsuccess = (e) => (out.result = e.target.result.map(({ blob, ...rec }) => rec));
    }),
    migrateRecord, // para las pruebas
  };
})();
