// Persistencia de la biblioteca en IndexedDB (los archivos se guardan como Blob, solo en este navegador).
const Storage = (() => {
  let dbPromise;

  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("reproductor-mp3", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("tracks", mode);
      const result = fn(t.objectStore("tracks"));
      t.oncomplete = () => resolve(result.result);
      t.onerror = () => reject(t.error);
    });
  }

  // Guarda (o borra, con null) la letra cargada por el usuario en el registro de la pista.
  async function setLyrics(id, text) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("tracks", "readwrite");
      const store = t.objectStore("tracks");
      const get = store.get(id);
      get.onsuccess = () => {
        const rec = get.result;
        if (!rec) return;
        if (text) rec.lyrics = text; else delete rec.lyrics;
        store.put(rec);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  return {
    setLyrics,
    add: (file) => tx("readwrite", (s) => s.add({ name: file.name, blob: file, type: file.type })),
    remove: (id) => tx("readwrite", (s) => s.delete(id)),
    clear: () => tx("readwrite", (s) => s.clear()),
    all: () => tx("readonly", (s) => s.getAll()),
  };
})();
