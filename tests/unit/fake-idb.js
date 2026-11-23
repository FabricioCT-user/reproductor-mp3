// IndexedDB falsa y mínima, en memoria, para probar src/storage.js en Node (sin dependencias).
// Imita lo que importa para la migración: versiones y `onupgradeneeded`, transacciones atómicas
// (si una petición falla, la transacción se deshace entera), peticiones en orden, cursores y autoIncrement.
// Los valores se copian al guardar y al leer (como el clonado estructurado), salvo los Blob, que se comparten.

const clone = (v) => {
  if (v instanceof Blob || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
};
const domError = (name) => Object.assign(new Error(name), { name });

function createFakeIndexedDB() {
  const dbs = new Map(); // name → { version, stores: Map(name → { keyPath, autoIncrement, next, data: Map }) }
  const fake = { dbs, fail: null }; // fail(storeName, op, value) → nombre de error para simular un fallo

  const snapshot = (stores) => new Map([...stores].map(([n, s]) => [n, { ...s, data: new Map([...s.data].map(([k, v]) => [k, clone(v)])) }]));

  function makeTx(state, names, mode, onDone) {
    const work = snapshot(state.stores); // se trabaja sobre una copia: se aplica al completar
    const queue = [];
    const tx = { mode, error: null, oncomplete: null, onerror: null, onabort: null };
    let finished = false;
    const listeners = { complete: [] };
    tx.addEventListener = (type, fn) => listeners[type]?.push(fn);

    const request = (op) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, transaction: tx };
      queue.push({ req, op });
      return req;
    };

    const storeApi = (name) => {
      if (names ? !names.includes(name) : !work.has(name)) throw domError("NotFoundError");
      const s = () => work.get(name);
      const write = (op, value, mustBeNew) => request(() => {
        if (mode === "readonly") throw domError("ReadOnlyError");
        const st = s();
        const v = clone(value);
        let key = st.keyPath ? v[st.keyPath] : undefined;
        if (key === undefined && st.autoIncrement) { key = st.next; v[st.keyPath] = key; }
        if (key === undefined) throw domError("DataError");
        if (typeof key === "number" && key >= st.next) st.next = Math.floor(key) + 1;
        if (mustBeNew && st.data.has(key)) throw domError("ConstraintError");
        const err = fake.fail?.(name, op, value);
        if (err) throw domError(err);
        st.data.set(key, v);
        return key;
      });
      return {
        name,
        transaction: tx,
        add: (v) => write("add", v, true),
        put: (v) => write("put", v, false),
        get: (k) => request(() => clone(s().data.get(k))),
        getAll: () => request(() => [...s().data.keys()].sort((a, b) => a - b).map((k) => clone(s().data.get(k)))),
        delete: (k) => request(() => { if (mode === "readonly") throw domError("ReadOnlyError"); s().data.delete(k); }),
        clear: () => request(() => { if (mode === "readonly") throw domError("ReadOnlyError"); s().data.clear(); }),
        openCursor: () => {
          const keys = [...s().data.keys()].sort((a, b) => a - b);
          let i = 0;
          let req;
          const step = () => {
            if (i >= keys.length) return null;
            const key = keys[i++];
            return {
              key,
              value: clone(s().data.get(key)),
              update: (v) => write("put", { ...v }, false),
              continue: () => queue.push({ req, op: step }),
            };
          };
          req = request(step);
          return req;
        },
      };
    };

    tx.objectStore = storeApi;
    tx.db = state;

    const abort = (error) => {
      finished = true;
      tx.error = error;
      tx.onerror?.({ target: tx });
      tx.onabort?.({ target: tx });
      onDone(error);
    };

    tx.run = (beforeFirst) => setTimeout(() => {
      try { beforeFirst?.(); } catch (e) { return abort(e); }
      while (queue.length && !finished) {
        const { req, op } = queue.shift();
        try { req.result = op(); } catch (e) {
          req.error = e;
          req.onerror?.({ target: req });
          return abort(e);
        }
        try { req.onsuccess?.({ target: req }); } catch (e) { return abort(e); }
      }
      if (finished) return;
      finished = true;
      state.stores = work; // se aplica todo de golpe
      listeners.complete.forEach((fn) => fn({ target: tx }));
      onDone(null);
      tx.oncomplete?.({ target: tx });
    });
    tx.work = work;
    return tx;
  }

  function makeDb(name, state) {
    const db = {
      name,
      get version() { return state.version; },
      objectStoreNames: { contains: (n) => state.stores.has(n), get length() { return state.stores.size; } },
      onversionchange: null,
      close() {},
      transaction(names, mode = "readonly") {
        names = [].concat(names);
        for (const n of names) if (!state.stores.has(n)) throw domError("NotFoundError");
        const tx = makeTx(state, names, mode, () => {});
        tx.run();
        return tx;
      },
    };
    return db;
  }

  fake.open = (name, version) => {
    const req = { result: null, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    setTimeout(() => {
      let state = dbs.get(name);
      const oldVersion = state?.version ?? 0;
      const target = version ?? (oldVersion || 1);
      if (target < oldVersion) { req.error = domError("VersionError"); req.onerror?.({ target: req }); return; }
      if (!state) state = { version: 0, stores: new Map() };
      if (target === oldVersion) {
        dbs.set(name, state);
        req.result = makeDb(name, state);
        req.onsuccess?.({ target: req });
        return;
      }
      // Actualización: la transacción «versionchange» puede crear almacenes y abarca todos.
      const temp = { version: oldVersion, stores: snapshot(state.stores) };
      const db = makeDb(name, temp);
      const tx = makeTx(temp, null, "versionchange", (err) => {
        req.transaction = null;
        if (err) {
          req.error = domError("AbortError");
          req.onerror?.({ target: req });
          return;
        }
        temp.version = target;
        dbs.set(name, temp);
        req.onsuccess?.({ target: req });
      });
      db.createObjectStore = (n, opts = {}) => {
        if (tx.work.has(n)) throw domError("ConstraintError");
        tx.work.set(n, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, next: 1, data: new Map() });
        return tx.objectStore(n);
      };
      // Durante la actualización los almacenes nuevos se ven ya en objectStoreNames.
      db.objectStoreNames = { contains: (n) => tx.work.has(n), get length() { return tx.work.size; } };
      req.result = db;
      req.transaction = tx;
      tx.run(() => req.onupgradeneeded?.({ target: req, oldVersion, newVersion: target }));
    });
    return req;
  };

  return fake;
}

module.exports = { createFakeIndexedDB };
