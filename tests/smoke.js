"use strict";
// Pruebas de humo: cargan la aplicación real en un iframe y la manejan como una persona.
// Los objetos que se pasan a la aplicación se crean con SU realm (win.File, win.Blob) para que `instanceof` funcione.

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail) }); window.__results = results; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};

/* ---------- Datos de prueba ---------- */

// WAV de 8 bits mono: suena de verdad y no necesita herramientas externas.
function wavBytes({ seconds = 3, freq = 440, rate = 8000 } = {}) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(60 * Math.sin((2 * Math.PI * freq * i) / rate)));
  return new Uint8Array(buf);
}
const wav = (win, name, opts = {}) => new win.File([wavBytes(opts)], name, { type: "audio/wav", lastModified: opts.mtime ?? 1 });

// MP3 «de mentira»: etiqueta ID3v2.3 real + bytes de audio cualesquiera (basta para probar el escritor de etiquetas).
function fakeMp3(win, name, title) {
  const text = new TextEncoder().encode(title);
  const body = new Uint8Array([0, ...text]);
  const frame = new Uint8Array([...new TextEncoder().encode("TIT2"), 0, 0, 0, body.length, 0, 0, ...body]);
  const head = new Uint8Array([73, 68, 51, 3, 0, 0, 0, 0, 0, frame.length]);
  return new win.File([head, frame, wavBytes({ seconds: 1 })], name, { type: "audio/mpeg", lastModified: 77 });
}

function fakeMp3WithCover(win, name) {
  const enc = new TextEncoder();
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const picture = new Uint8Array([0, ...enc.encode("image/png"), 0, 3, 0, ...image]);
  const frame = new Uint8Array([...enc.encode("APIC"), 0, 0, 0, picture.length, 0, 0, ...picture]);
  const head = new Uint8Array([73, 68, 51, 3, 0, 0, 0, 0, 0, frame.length]);
  return new win.File([head, frame, wavBytes({ seconds: 1 })], name, { type: "audio/mpeg", lastModified: 78 });
}

// WebM sintético generado en el propio navegador (canvas + AudioContext + MediaRecorder).
async function makeWebm(win, name, { withVideo = true, seconds = 2.6, mtime } = {}) {
  const ac = new win.AudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const dest = ac.createMediaStreamDestination();
  osc.frequency.value = 440;
  gain.gain.value = 0.25;
  osc.connect(gain);
  gain.connect(dest);
  osc.start();

  const tracks = [...dest.stream.getAudioTracks()];
  let timer = 0;
  if (withVideo) {
    const canvas = win.document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    let frameIdx = 0;
    const paint = () => {
      ctx.fillStyle = "#162030";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#4fa3ff";
      ctx.fillRect((frameIdx++ * 6) % 48, 20, 16, 24);
    };
    paint();
    timer = win.setInterval(paint, 100);
    tracks.unshift(...canvas.captureStream(10).getVideoTracks());
  }

  const stream = new win.MediaStream(tracks);
  const mime = withVideo ? "video/webm" : "audio/webm";
  const rec = win.MediaRecorder.isTypeSupported(mime) ? new win.MediaRecorder(stream, { mimeType: mime }) : new win.MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  await sleep(seconds * 1000);
  rec.stop();
  await stopped;
  if (timer) win.clearInterval(timer);
  tracks.forEach((t) => t.stop());
  await ac.close().catch(() => {});
  return new win.File(chunks, name, { type: mime, lastModified: mtime ?? (withVideo ? 101 : 102) });
}

/* ---------- Marco de pruebas ---------- */

// Se vacían los almacenes en vez de borrar la base: borrarla se queda bloqueada si otra pestaña la tiene abierta.
const DB = "reproductor-mp3";
const idbReq = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const openDb = () => {
  const req = indexedDB.open(DB, 2);
  req.onupgradeneeded = (e) => {
    // Solo pasa si la base no existía: los datos de una v1 se migran al abrir la app, no aquí.
    if (e.oldVersion < 1) req.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
    if (e.oldVersion < 2) req.result.createObjectStore("files", { keyPath: "id" });
  };
  return idbReq(req);
};
// La base tal como esté (sin pedir versión): para inspeccionar lo que dejó la app.
const openDbAsIs = () => idbReq(indexedDB.open(DB));
const storeNames = (db) => [...db.objectStoreNames].sort().join(",");
const getAll = (db, store) => idbReq(db.transaction(store).objectStore(store).getAll());

async function resetStorage() {
  localStorage.clear();
  const db = await openDb();
  await new Promise((resolve) => {
    const tx = db.transaction(["tracks", "files"], "readwrite");
    tx.objectStore("tracks").clear();
    tx.objectStore("files").clear();
    tx.oncomplete = tx.onerror = resolve;
  });
  db.close();
}

// Deja una base v1 (como la guardaba la versión anterior: el archivo dentro del registro) con estos registros.
// Para eso hay que borrar la base; la app cierra su conexión cuando se lo piden, así que no se bloquea.
async function seedV1(records) {
  await Promise.race([
    idbReq(indexedDB.deleteDatabase(DB)),
    sleep(5000).then(() => { throw new Error("no se pudo borrar la base (¿otra pestaña del reproductor abierta?)"); }),
  ]);
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
  const db = await idbReq(req);
  await new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    records.forEach((r) => tx.objectStore("tracks").add(r));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function waitReady(win) {
  if (!(await until(() => { try { return win.eval("typeof appReady") === "object"; } catch { return false; } }, 6000))) return false;
  await win.eval("appReady");
  return true;
}

async function openApp(prepare, reset = true, options = {}) {
  if (reset) await resetStorage();
  if (prepare) await prepare();
  // La página real lleva una CSP sin «unsafe-eval», y estas pruebas necesitan eval para leer sus variables internas:
  // se carga la misma página sin esa etiqueta (la CSP se comprueba aparte, en las pruebas unitarias y en el navegador).
  const pauseStorage = options.pauseStorage
    ? "const __storageAll = Storage.all; Storage.all = () => new Promise(resolve => { window.__releaseStorageAll = () => __storageAll().then(resolve); });"
    : "";
  const html = (await (await fetch("../index.html", { cache: "no-cache" })).text())
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace("<head>", '<head><base href="../">')
    .replace('<script src="src/app/main.js"></script>', `<script>const __tagsRead = Tags.read; window.__tagsReadCount = 0; Tags.read = (...a) => { window.__tagsReadCount++; return __tagsRead(...a); }; ${pauseStorage}</script><script src="src/app/main.js"></script>`);
  const frame = document.createElement("iframe");
  frame.srcdoc = html;
  document.body.append(frame);
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  const win = frame.contentWindow;
  const ready = options.waitReady === false ? null : await waitReady(win);
  win.confirm = () => true;
  return { frame, win, ready, hostApp: !!window.reproductor, ev: (code) => win.eval(code) };
}

async function responderDialogo(win, valor) {
  await until(() => win.document.getElementById("prompt-dialog")?.open, 2000, 20);
  if (valor === null) { win.document.getElementById("prompt-cancel").click(); return; }
  win.document.getElementById("prompt-input").value = valor;
  // Enter en el campo = envío implícito del formulario; requestSubmit() es ese mismo camino
  // (un keydown sintético no dispara el envío implícito en ningún navegador).
  win.document.getElementById("prompt-form").requestSubmit();
}

async function scenario(title, fn, prepare, options = {}) {
  let app;
  document.getElementById("summary").textContent = `Ejecutando: ${title}…`;
  (window.__log ||= []).push(`${new Date().toISOString().slice(11, 19)} ${title}`);
  try {
    app = await openApp(prepare, true, options);
    if (options.waitReady !== false && !app.ready) { check(`${title}: la aplicación arranca`, false, "no llegó a inicializarse (¿error al cargar?)"); return; }
    await Promise.race([fn(app), sleep(40000).then(() => { throw new Error("tiempo agotado"); })]);
  } catch (e) {
    check(`${title}: sin excepciones`, false, e.stack || e);
  } finally {
    app?.frame.remove();
    await sleep(100);
  }
}

// Captura lo que la aplicación descargaría.
function captureDownloads(win) {
  const got = [];
  win.download = (name, content) => { got.push({ name, content }); };
  return got;
}

// Firefox puede devolver una cadena vacía de estilo calculado para nodos ya retirados.
function demoButtonHidden(button, win) {
  return !button?.isConnected || button.hidden || win.getComputedStyle(button).display === "none";
}

// Salta cerca del final de la pista actual (espera a conocer la duración).
async function seekNearEnd(ev, secondsLeft) {
  await until(() => Number.isFinite(ev("media.duration")) && ev("media.duration") > 0);
  ev(`media.currentTime = media.duration - ${secondsLeft}`);
}

const asText = async (c) => (typeof c === "string" ? c : c.text());
const titles = (ev, expr = "state.tracks") => ev(`${expr}.map(t => t.title).join(",")`);

/* ---------- Escenarios ---------- */

(async function run() {
  await scenario("Ejemplos de demo", async ({ win, ev, hostApp }) => {
    const button = win.document.getElementById("demo-examples");
    if (hostApp) {
      ev("delete window.reproductor; libraryReady = true; render()");
      const originalAddFiles = win.addFiles;
      let imported = 0;
      win.fetch = async () => ({ ok: true, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => new ArrayBuffer(0) });
      win.addFiles = async (files, isCurrent) => { imported = files.length; check("demo app: la importación mantiene vigente su generación", isCurrent()); };
      button.click();
      await until(() => !button.disabled);
      check("demo app: la demo se ejerce con fetch simulado sin ampliar app://", !!button && imported === 6);
      win.addFiles = originalAddFiles;
      return;
    }
    check("demo web: botón visible con biblioteca vacía", !!button && !demoButtonHidden(button, win));
    ev("window.reproductor = {}; render()");
    check("demo: botón oculto en app de escritorio", demoButtonHidden(button, win));
    ev("delete window.reproductor; render()");
    ev("state.filter = els.filter.value = 'sin resultados'; render()");
    check("demo: botón oculto con un filtro", demoButtonHidden(button, win));
    ev("state.filter = els.filter.value = ''; state.playlists.push({ id: 'demo-vacia', name: 'Vacía', ids: [] }); state.view = 'demo-vacia'; render()");
    check("demo: botón oculto en una lista vacía", demoButtonHidden(button, win));
    ev("state.playlists.pop(); state.view = 'all'; render()");

    const realFetch = win.fetch.bind(win);
    let calls = 0;
    win.fetch = (...args) => { calls++; return realFetch(...args); };
    button.click();
    button.click();
    check("demo: doble clic bloquea la segunda importación", button.disabled);
    check("demo: estado de carga accesible", button.getAttribute("aria-busy") === "true" && !win.document.getElementById("demo-status").hidden);
    await until(() => ev("state.tracks.length") === 4 && !button.disabled, 15000);
    win.fetch = realFetch;
    check("demo: se importan las tres pistas y el vídeo", ev("state.tracks.length") === 4, titles(ev));
    check("demo: las pistas de audio tienen artista y álbum de ejemplo", ev("state.tracks.filter(t => t.meta.kind === 'audio').length === 3 && state.tracks.filter(t => t.meta.kind === 'audio').every(t => t.meta.artist === 'Tarareo (ejemplo)' && t.meta.album === 'Pequeños paisajes')"));
    check("demo: las tres pistas de audio tienen carátula", ev("state.tracks.filter(t => t.meta.kind === 'audio').length === 3 && state.tracks.filter(t => t.meta.kind === 'audio').every(t => t.meta.hasCover)"));
    check("demo: doble clic lanza una sola descarga por archivo", calls === 6, `fetch=${calls}`);
    check("demo: letra LRC emparejada", ev("state.tracks.find(t => t.fileName === 'Brisa.mp3')?.userLyrics?.includes('La tarde se inclina al mar')"));
    check("demo: subtítulos VTT emparejados", ev("state.tracks.find(t => t.fileName === 'Paseo.webm')?.subs?.length") > 0);
    check("demo: no comienza la reproducción", ev("media.paused") && ev("state.index") === 0);
    check("demo: botón desaparece tras la importación", demoButtonHidden(button, win));
    await win.clearLibrary();
    check("demo: al vaciar se limpia el estado de importación", win.document.getElementById("demo-status").hidden
      && !win.document.getElementById("demo-status").textContent.includes("Ejemplos añadidos"));
  });

  await scenario("Botón de demo espera la biblioteca guardada", async ({ win, ev }) => {
    const button = win.document.getElementById("demo-examples");
    check("demo: botón oculto mientras se lee una biblioteca guardada", demoButtonHidden(button, win) && !ev("libraryReady"));
    ev("__releaseStorageAll()");
    await win.eval("appReady");
    check("demo: biblioteca guardada cargada impide ofrecer demo", ev("libraryReady && state.tracks.length === 1")
      && demoButtonHidden(button, win));
  }, async () => {
    const db = await openDb();
    const file = new File([wavBytes({ seconds: 1 })], "guardada.wav", { type: "audio/wav" });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["tracks", "files"], "readwrite");
      const request = tx.objectStore("tracks").add({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, kind: "audio", source: "blob" });
      request.onsuccess = () => tx.objectStore("files").put({ id: request.result, blob: file });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { pauseStorage: true, waitReady: false });

  await scenario("Pistas añadidas durante la descarga de ejemplos", async ({ win, ev }) => {
    const button = win.document.getElementById("demo-examples");
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    win.fetch = () => pending;
    button.click();
    await win.addFiles([wav(win, "durante.wav", { mtime: 441 })]);
    release({ ok: true, headers: { get: () => "audio/mpeg" }, arrayBuffer: async () => new ArrayBuffer(0) });
    await until(() => !button.disabled);
    check("demo: una pista ajena durante la descarga cancela la importación", ev("state.tracks.length === 1 && state.tracks[0].fileName === 'durante.wav'")
      && !button.disabled && win.document.getElementById("demo-status").textContent.includes("no se añadieron los ejemplos"));
  });

  await scenario("Vaciar durante la descarga de ejemplos", async ({ win, ev }) => {
    const button = win.document.getElementById("demo-examples");
    ev("delete window.reproductor");
    const releases = [];
    const originalAddFiles = win.addFiles;
    let addFilesCalls = 0;
    win.addFiles = (...args) => { addFilesCalls++; return originalAddFiles(...args); };
    win.fetch = () => new Promise((resolve) => { releases.push(resolve); });
    button.click();
    const started = await until(() => releases.length === 6);
    check("demo: empiezan las seis descargas", started, `fetch=${releases.length}`);
    await win.addFiles([wav(win, "previa.wav", { mtime: 442 })]);
    win.confirm = () => true;
    await win.clearLibrary();
    const wavResponse = () => ({ ok: true, headers: { get: () => "audio/wav" }, arrayBuffer: async () => wavBytes({ seconds: 1 }) });
    releases.forEach((release) => release(wavResponse()));
    const finished = await until(() => !button.disabled);
    check("demo: descarga cancelada termina", finished);
    win.addFiles = originalAddFiles;
    check("demo: vaciar durante la descarga invalida los ejemplos", addFilesCalls === 0
      && ev("state.tracks.length === 0") && win.document.getElementById("demo-status").hidden, `addFiles=${addFilesCalls}`);
  });

  await scenario("Vaciar durante la importación de ejemplos", async ({ win, ev }) => {
    const button = win.document.getElementById("demo-examples");
    ev("delete window.reproductor");
    const originalMakeTrack = win.makeTrack;
    let release;
    let calls = 0;
    win.makeTrack = async (...args) => {
      calls++;
      if (calls === 2) await new Promise((resolve) => { release = resolve; });
      return originalMakeTrack(...args);
    };
    const response = async () => ({ ok: true, headers: { get: () => "audio/wav" }, arrayBuffer: async () => wavBytes({ seconds: 1 }) });
    win.fetch = (url) => response(String(url));
    button.click();
    const secondStarted = await until(() => !!release);
    check("demo: la segunda pista queda detenida en makeTrack", secondStarted);
    const firstEntered = await until(() => ev("state.tracks.length === 1"));
    check("demo: la primera pista entra antes de vaciar", firstEntered, `tracks=${ev("state.tracks.length")}`);
    win.confirm = () => true;
    await win.clearLibrary();
    release();
    const finished = await until(() => !button.disabled);
    check("demo: importación cancelada termina", finished);
    win.makeTrack = originalMakeTrack;
    const db = await openDbAsIs();
    const emptyDb = (await getAll(db, "tracks")).length === 0;
    db.close();
    check("demo: vaciar durante addFiles cancela las pistas pendientes", ev("state.tracks.length === 0") && win.document.getElementById("demo-status").hidden && emptyDb,
      `state=${ev("state.tracks.length")} dbEmpty=${emptyDb}`);
  });

  await scenario("Fallo de red en ejemplos", async ({ win, ev, hostApp }) => {
    const button = win.document.getElementById("demo-examples");
    if (hostApp) {
      check("demo app: no afecta a la biblioteca del smoke", !!button && ev("state.tracks.length") === 0);
      return;
    }
    const old = win.fetch;
    win.fetch = async () => { throw new TypeError("offline"); };
    button.click();
    await until(() => !button.disabled, 3000);
    check("demo error: mensaje claro y botón recuperado", !button.disabled && !demoButtonHidden(button, win)
      && win.document.getElementById("demo-status").textContent.includes("Comprueba la conexión"));
    check("demo error: no deja pistas a medias", ev("state.tracks.length") === 0);
    win.fetch = old;
  });

  await scenario("Importar", async ({ win, ev }) => {
    const files = [wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 }), wav(win, "c.wav", { freq: 660, mtime: 3 })];
    const lrc = new win.File(["[00:00.50]Hola\n"], "a.lrc");
    const m3u8 = new win.File(["#EXTM3U\n"], "lista.m3u8", { type: "audio/x-mpegurl" }); // algunos sistemas lo marcan como audio/*
    const noAudio = new win.File(["texto"], "notas.txt", { type: "text/plain" });
    await win.addFiles([...files, lrc, m3u8, noAudio]);
    check("importar: 3 canciones (ni .m3u8 ni .txt cuentan como audio)", ev("state.tracks.length") === 3, titles(ev) + " / " + ev("state.tracks.length"));
    check("importar: la lista exportada vacía (.m3u8) no se añade como canción", !ev("state.tracks.some(t => /m3u8/.test(t.fileName))"));
    check("importar: el .lrc se empareja con su canción", !!ev("state.tracks[0].userLyrics"));
    await win.addFiles(files);
    check("reimportar: no duplica", ev("state.tracks.length") === 3);
    check("importar: la primera canción queda cargada", ev("state.index") === 0);
  });

  await scenario("Caché MP4 y álbum de audio", async ({ win, ev }) => {
    const m4a = new win.File([new Uint8Array([
      0, 0, 0, 16, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0,
    ])], "cache.m4a", { type: "audio/mp4", lastModified: 9 });
    await win.addFiles([m4a]);
    const firstReads = ev("window.__tagsReadCount");
    ev("state.tracks[0].orig.artist = 'Artista'; state.tracks[0].orig.album = 'Álbum'; applyEdits(state.tracks[0]); render()");
    check("biblioteca: segunda línea de audio conserva artista · álbum",
      ev("els.playlist.querySelector('li:not(.empty) .t-sub')?.textContent") === "Artista · Álbum",
      ev("els.playlist.querySelector('li:not(.empty) .t-sub')?.textContent"));

    const previousFrame = win.frameElement;
    previousFrame.remove();
    await sleep(100);
    const restarted = await openApp(null, false);
    check("caché: el segundo arranque no vuelve a leer las etiquetas MP4",
      firstReads > 0 && restarted.ready && restarted.ev("window.__tagsReadCount") === 0,
      `ready=${restarted.ready}, lecturas=${restarted.ev("window.__tagsReadCount")}, primera carga=${firstReads}`);
    restarted.frame.remove();
  });

  await scenario("Reproducción", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 }), wav(win, "c.wav", { freq: 660, mtime: 3 })]);
    win.loadTrack(0, true, "all");
    check("reproducir: el tiempo avanza", await until(() => ev("media.currentTime") > 0.4), ev("media.currentTime"));
    check("reproducir: el icono pasa a pausa", ev("els['play-icon'].innerHTML").includes("M6 5h4"));
    check("decks: dos <video> en el escenario, oculto mientras suena audio",
      ev("decks.every(d => d.tagName === 'VIDEO' && d.parentElement === $('stage'))") && ev("getComputedStyle($('stage')).display") === "none");
    ev("els.next.click()");
    check("siguiente", ev("state.index") === 1);
    await sleep(500);
    ev("els.prev.click()");
    check("anterior (con menos de 3 s)", ev("state.index") === 0, ev("state.index"));
    ev("toggleQueue(state.tracks[2])");
    ev("els.next.click()");
    check("la cola va antes que el orden normal", ev("state.index") === 2 && ev("state.queue.length") === 0);

    // Espacio en el documento alterna; sobre un botón no debe alternar (activa el botón)
    const space = (target) => target.dispatchEvent(new win.KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }));
    const wasPaused = ev("media.paused");
    space(win.document.body);
    check("atajo Espacio: alterna la reproducción", ev("media.paused") !== wasPaused, `pausado antes=${wasPaused}`);
    space(win.document.body);
    await until(() => !ev("media.paused"));
    const before = ev("media.paused");
    space(ev("els.clear"));
    check("Espacio sobre un botón no dispara el atajo global", ev("media.paused") === before, "se alternó la reproducción");

    // última pista sin repetir: se detiene; con repetir vuelve a la primera
    await seekNearEnd(ev, 0.4);
    await sleep(1200);
    check("última canción sin repetir: se detiene", ev("media.paused") && ev("state.index") === 2, `paused=${ev("media.paused")} idx=${ev("state.index")}`);
    ev("els.repeat.click()");
    win.loadTrack(2, true, "all");
    await seekNearEnd(ev, 0.4);
    check("repetir: vuelve a la primera", await until(() => ev("state.index") === 0, 3000), ev("state.index"));
    ev("els.repeat.click()");
  });

  await scenario("Listas, exportar e importar", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 }), wav(win, "c.wav", { freq: 660, mtime: 3 })]);
    const cancelCreate = win.createPlaylist();
    await responderDialogo(win, null);
    check("crear lista: cancelar no crea nada", (await cancelCreate) === null && ev("state.playlists.length") === 0);

    // Escape: el navegador lanza «cancel» y cierra el <dialog> sin pasar por el formulario.
    const escCreate = win.createPlaylist();
    await until(() => win.document.getElementById("prompt-dialog")?.open, 2000, 20);
    const dlg = win.document.getElementById("prompt-dialog");
    win.document.getElementById("prompt-input").value = "No debe crearse";
    dlg.dispatchEvent(new win.Event("cancel", { cancelable: true }));
    dlg.close();
    check("diálogo: Escape cancela y no crea nada", (await escCreate) === null && ev("state.playlists.length") === 0 && !dlg.open);

    const createP = win.createPlaylist();
    await until(() => win.document.getElementById("prompt-dialog")?.open, 2000, 20);
    check("diálogo: foco en el campo", win.document.activeElement === win.document.getElementById("prompt-input"));
    await responderDialogo(win, "Mi lista");
    const p = await createP;
    check("crear lista", p && ev("state.playlists.length") === 1);
    win.togglePlaylistMember(p, ev("state.tracks[2]"));
    win.togglePlaylistMember(p, ev("state.tracks[0]"));
    win.setView(p.id);
    const cancelRename = win.renamePlaylist();
    await responderDialogo(win, null);
    await cancelRename;
    check("renombrar lista: cancelar mantiene el nombre", ev("state.playlists[0].name") === "Mi lista");
    const doRename = win.renamePlaylist();
    await responderDialogo(win, "Renombrada");
    await doRename;
    check("renombrar lista: aceptar cambia el nombre", ev("state.playlists[0].name") === "Renombrada");
    const restoreRename = win.renamePlaylist();
    await responderDialogo(win, "Mi lista");
    await restoreRename;
    check("la lista muestra sus canciones en su orden", titles(ev, "listTracks(state.view)") === "c,a", titles(ev, "listTracks(state.view)"));
    win.moveTrack(1, 0);
    check("reordenar dentro de la lista", titles(ev, "listTracks(state.view)") === "a,c");
    check("la biblioteca no cambia al reordenar la lista", titles(ev) === "a,b,c");
    win.loadTrack(ev("state.tracks.indexOf(listTracks(state.view)[0])"), false, p.id);
    ev("els.next.click()");
    check("siguiente respeta la lista (a → c, no b)", ev("state.tracks[state.index].title") === "c");

    const got = captureDownloads(win);
    win.exportPlaylists(ev("state.playlists"), "json");
    win.exportPlaylists([ev("state.playlists[0]")], "m3u8");
    const json = await asText(got[0].content);
    const m3u = await asText(got[1].content);
    check("exportar JSON y M3U8", got[0].name.endsWith(".json") && got[1].name.endsWith(".m3u8") && m3u.includes("a.wav") && m3u.startsWith("#EXTM3U"), got.map((g) => g.name));

    await win.clearLibrary();
    ev("state.playlists = []; savePlaylists(); renderViews();");
    await win.addFiles([new win.File([json], "listas.json")]);
    check("importar listas con la biblioteca vacía: todo queda pendiente", ev("state.playlists[0].pending.length") === 2 && ev("state.playlists[0].ids.length") === 0);
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 }), wav(win, "c.wav", { freq: 660, mtime: 3 })]);
    check("al importar la música, la lista se completa sola y conserva el orden", titles(ev, `listTracks(state.playlists[0].id)`) === "a,c" && ev("state.playlists[0].pending.length") === 0,
      titles(ev, `listTracks(state.playlists[0].id)`));
    await win.addFiles([new win.File([json], "listas.json")]);
    check("reimportar crea «Mi lista (2)» sin pisar la existente", ev("state.playlists.map(p => p.name).join('|')") === "Mi lista|Mi lista (2)", ev("state.playlists.map(p => p.name).join('|')"));
    await win.addFiles([new win.File(["{\"hola\":1}"], "raro.json")]);
    check("un .json que no es de listas se rechaza sin romper nada", ev("state.playlists.length") === 2 && ev("els.toast.textContent").includes("no válido"));
  });

  await scenario("Etiquetas y persistencia", async ({ win, ev, frame }) => {
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 }), fakeMp3(win, "copia.mp3", "Original")]);
    const t = ev("state.tracks[0]");
    win.openEditor(t);
    ev("els['edit-title'].value = 'Título nuevo'; els['edit-artist'].value = 'Artista nuevo'");
    ev("els['edit-form'].requestSubmit()");
    check("editar una canción: se ve en la lista y en el reproductor", ev("state.tracks[0].title") === "Título nuevo" && ev("els.title.textContent") === "Título nuevo");
    win.openEditor([ev("state.tracks[0]"), ev("state.tracks[1]")]);
    check("lote: los valores distintos se muestran como «varios valores»", ev("els['edit-title'].placeholder") === "(varios valores)");
    ev("els['edit-album'].value = 'Álbum común'; els['edit-album'].dispatchEvent(new Event('input', {bubbles:true}))");
    ev("els['edit-form'].requestSubmit()");
    check("lote: solo cambia el campo tocado", ev("state.tracks[0].album") === "Álbum común" && ev("state.tracks[1].album") === "Álbum común" && ev("state.tracks[1].title") === "b" && ev("state.tracks[0].artist") === "Artista nuevo", titles(ev));

    // copia con etiquetas dentro (MP3 sintético)
    const mp3 = ev("state.tracks[2]");
    ev("commitEdits([state.tracks[2]], () => ({ title: 'Cambiado ñ 日本', artist: 'Alguien' }))");
    const got = captureDownloads(win);
    const status = await win.downloadEditedCopy(mp3);
    const copy = got[0];
    const reread = copy ? await ev("Tags").read(new win.File([copy.content], "x.mp3")) : null;
    check("descargar copia: nombre y etiquetas escritas dentro", status === "ok" && copy.name === "copia (editado).mp3" && reread.title === "Cambiado ñ 日本" && reread.artist === "Alguien", `${status} ${copy?.name} ${reread?.title}`);
    check("descargar copia: un WAV se rechaza por formato", (await win.downloadEditedCopy(ev("state.tracks[1]"))) === "sin-formato");

    // ajustes que deben recordarse
    ev("els.volume.value = 0.4; els.volume.dispatchEvent(new Event('input'))");
    ev("els['theme-btn'].click(); els['theme-btn'].click()"); // claro → oscuro
    win.setCrossfade(4);
    ev("els.shuffle.click()");

    // persistencia tras recargar
    frame.contentWindow.location.reload();
    await sleep(300);
    await waitReady(frame.contentWindow);
    const e2 = (c) => frame.contentWindow.eval(c);
    check("las ediciones sobreviven a recargar", e2("state.tracks.find(t => t.fileName === 'a.wav').title") === "Título nuevo" && e2("state.tracks.find(t => t.fileName === 'b.wav').album") === "Álbum común");

    check("los ajustes sobreviven a recargar (volumen, tema, fundido, aleatorio)",
      e2("els.volume.value") === "0.4" && e2("document.documentElement.dataset.theme") === "dark" && e2("state.crossfade") === 4 && e2("state.shuffle") === true,
      `vol=${e2("els.volume.value")} tema=${e2("document.documentElement.dataset.theme")} fundido=${e2("state.crossfade")} aleatorio=${e2("state.shuffle")}`);

    // restaurar en lote
    frame.contentWindow.confirm = () => true;
    frame.contentWindow.openEditor(e2("state.tracks"));
    e2("els['edit-reset'].click()");
    check("restaurar originales en lote", e2("state.tracks.every(t => t.edits === null)") && e2("state.tracks[0].title") === "a");
  });

  await scenario("Letras", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { seconds: 6, mtime: 1 })]);
    ev("setUserLyrics(state.tracks[0], '[00:00.50]Uno\\n[00:02.00]Dos\\n[00:04.00]Tres')");
    ev("toggleLyrics(false)");
    win.loadTrack(0, true, "all");
    ev("media.currentTime = 2.3");
    await until(() => ev("document.querySelector('.lyric-line.active')?.textContent") === "Dos", 2500);
    check("la línea actual se resalta", ev("document.querySelector('.lyric-line.active')?.textContent") === "Dos", ev("document.querySelector('.lyric-line.active')?.textContent"));
    ev("document.querySelectorAll('.lyric-line')[2].click()");
    check("pulsar una línea salta a ese momento", ev("media.currentTime") >= 3.9, ev("media.currentTime"));
    ev("media.pause()");
  });

  await scenario("Velocidad, temporizador y fundido", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { seconds: 8, mtime: 1 }), wav(win, "b.wav", { seconds: 8, freq: 550, mtime: 2 }), wav(win, "c.wav", { seconds: 8, freq: 660, mtime: 3 })]);
    win.setSpeed(1.5);
    win.loadTrack(1, false, "all");
    check("velocidad: se conserva al cambiar de pista", ev("media.playbackRate") === 1.5 && ev("localStorage.getItem('speed')") === "1.5",
      `playbackRate=${ev("media.playbackRate")} guardado=${ev("localStorage.getItem('speed')")} estado=${ev("state.speed")}`);
    win.setSpeed(1);

    win.loadTrack(0, true, "all");
    await until(() => ev("media.currentTime") > 0.3);
    ev("setSleep(0.05)"); // 3 s
    check("temporizador: muestra la cuenta atrás", /⏲ 0:0\d/.test(ev("els['sleep-btn'].textContent")), ev("els['sleep-btn'].textContent"));
    await sleep(4000);
    check("temporizador: detiene la música y restaura el volumen", ev("media.paused") && ev("media.volume") === +ev("els.volume.value"), `paused=${ev("media.paused")} vol=${ev("media.volume")}`);

    ev("els['sleep-btn'].click()");
    ev("[...els.menu.querySelectorAll('button')].find(b => b.textContent.includes('Personalizado')).click()");
    await responderDialogo(win, null);
    check("temporizador personalizado: cancelar no lo activa", ev("sleep === null"));
    ev("els['sleep-btn'].click()");
    ev("[...els.menu.querySelectorAll('button')].find(b => b.textContent.includes('Personalizado')).click()");
    await responderDialogo(win, "15");
    check("temporizador personalizado: aceptar lo activa", ev("sleep !== null") && /⏲ 14:5\d|⏲ 15:00/.test(ev("els['sleep-btn'].textContent")), ev("els['sleep-btn'].textContent"));
    ev("setSleep(null)");

    win.setCrossfade(2);
    const first = ev("media");
    win.loadTrack(0, true, "all");
    await until(() => ev("media.currentTime") > 0.3);
    await seekNearEnd(ev, 3.3);
    check("fundido: empieza al acercarse al final", await until(() => ev("xfade !== null"), 3500));
    check("fundido: la canción nueva pasa a ser la activa (otro deck)", ev("media") !== first && ev("state.index") === 1, ev("state.index"));
    await until(() => ev("xfade === null"), 4000);
    // la ganancia vuelve a 1 en el siguiente ciclo de audio, no en el mismo instante
    const settled = await until(() => ev("decks.every(d => Math.abs(d._gain.gain.value - 1) < 0.001)"), 1500);
    check("fundido: al terminar, el deck anterior queda pausado y ambos con ganancia 1", ev("otherDeck().paused") && settled, `ganancias=${ev("decks.map(d => d._gain.gain.value.toFixed(3)).join('/')")}`);

    ev("els.shuffle.click()");
    const beforeShuffle = ev("media");
    win.loadTrack(0, true, "all");
    await until(() => ev("media.currentTime") > 0.3);
    await seekNearEnd(ev, 3.3);
    check("fundido con aleatorio (solo audio): empieza al acercarse al final", await until(() => ev("xfade !== null"), 3500));
    check("fundido con aleatorio (solo audio): pasa a otra pista en el otro deck", ev("media") !== beforeShuffle && ev("state.index !== 0"), ev("state.index"));
    await until(() => ev("xfade === null"), 4000);

    // La pista que anuncia peekNext() es la que carga step(1), y alternar el aleatorio descarta la elección.
    const peeked = ev("state.tracks.indexOf(peekNext())");
    check("aleatorio: peekNext es estable mientras no se avanza", ev("state.tracks.indexOf(peekNext())") === peeked);
    ev("step(1)");
    check("aleatorio: step(1) carga la pista que anunció peekNext", ev("state.index") === peeked, `${ev("state.index")} vs ${peeked}`);
    ev("peekNext()");
    ev("els.shuffle.click()");
    check("aleatorio: desactivarlo descarta la elección pendiente", ev("pendingNext") === null);
    ev("els.shuffle.click()");
    ev("els.shuffle.click()");

    win.setCrossfade(0);
    ev("media.pause()");
  });

  await scenario("Tema y selección", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { mtime: 2 }), wav(win, "c.wav", { mtime: 3 }), wav(win, "d.wav", { mtime: 4 })]);
    const seen = [];
    for (let i = 0; i < 3; i++) { ev("els['theme-btn'].click()"); seen.push(ev("els['theme-btn'].dataset.pref") + ":" + ev("document.documentElement.dataset.theme")); }
    check("tema: recorre claro → oscuro → automático", seen[0] === "light:light" && seen[1] === "dark:dark" && seen[2].startsWith("auto:"), seen.join(" "));

    ev("els['select-btn'].click()");
    const rows = () => [...win.document.querySelectorAll("#playlist li")];
    rows()[0].click();
    rows()[2].dispatchEvent(new win.MouseEvent("click", { bubbles: true, shiftKey: true }));
    check("selección: rango con Mayús", ev("state.selected.size") === 3);
    ev("els['select-none'].click(); els['select-all'].click()");
    check("selección: «Todas»", ev("state.selected.size") === 4);
    ev("els['select-done'].click()");
    check("selección: «Listo» sale del modo y limpia", !ev("state.selecting") && ev("state.selected.size") === 0);
  });

  await scenario("Abrir desde el sistema (Abrir con…)", async ({ win, ev }) => {
    const handle = (f) => ({ getFile: async () => f });
    const a = wav(win, "abierto1.wav", { mtime: 11 });
    const b = wav(win, "abierto2.wav", { freq: 550, mtime: 12 });
    await win.consumeLaunch({
      files: [handle(a), handle(b), handle(new win.File(["x"], "nota.txt", { type: "text/plain" })), { getFile: async () => { throw new Error("sin permiso"); } }],
    });
    check("abrir archivos del sistema: se añaden a la biblioteca (solo el audio legible)", ev("state.tracks.length") === 2, ev("state.tracks.map(t => t.fileName).join(',')"));
    check("abrir archivos del sistema: suena el primero", (await until(() => !ev("media.paused") && ev("media.currentTime") > 0.3)) && ev("state.tracks[state.index].fileName") === "abierto1.wav");
    check("abrir varios: los demás quedan en la cola", ev("state.queue.length") === 1 && ev("state.queue[0].fileName") === "abierto2.wav");
    ev("media.pause()");
    await win.consumeLaunch({ files: [handle(b)] });
    check("volver a abrir un archivo: no se duplica y suena ese", ev("state.tracks.length") === 2 && ev("state.tracks[state.index].fileName") === "abierto2.wav");
    await win.consumeLaunch({ files: [] });
    await win.consumeLaunch();
    check("sin archivos no hace nada", ev("state.tracks.length") === 2);
    ev("media.pause()");

    // Si el navegador no deja sonar sin un clic previo, no se «reproduce» en silencio: se pausa y se avisa.
    const ctx = ev("analyser.context");
    await ctx.suspend();
    ctx.resume = () => new Promise(() => {}); // simula que el navegador no lo permite
    await win.play();
    check("sonido bloqueado por el navegador: pausa y avisa en vez de sonar mudo", ev("media.paused") && /bloque/i.test(ev("els.toast.textContent")), `pausado=${ev("media.paused")} aviso=${ev("els.toast.textContent")}`);
  });

  /* ----- Casos de robustez (fallos que se encontraron en la revisión) ----- */

  await scenario("Robustez: archivos que no se pueden reproducir", async ({ win, ev }) => {
    const bad = (n) => new win.File([new Uint8Array(2000).fill(7)], n, { type: "audio/mpeg", lastModified: Number(n.match(/\d/)) });
    await win.addFiles([bad("mala1.mp3"), bad("mala2.mp3"), bad("mala3.mp3")]);
    let loads = 0;
    const real = win.loadTrack;
    win.loadTrack = (...a) => { loads++; return real(...a); };
    real(0, true, "all");
    await sleep(2500);
    win.loadTrack = real;
    check("si ninguna canción se puede reproducir, no entra en bucle infinito", loads <= 8, `${loads} cargas en 2,5 s`);
    check("avisa de que no se puede reproducir", /reproduc/i.test(ev("els.toast.textContent")), ev("els.toast.textContent"));
  });

  await scenario("Robustez: datos guardados corruptos", async ({ win, ev }) => {
    check("arranca con listas/ecualizador/orden corruptos en localStorage", ev("Array.isArray(state.playlists)") && ev("state.eq.gains.length") === 10);
  }, async () => {
    localStorage.setItem("playlists", "{esto no es json");
    localStorage.setItem("eq", "[[[");
    localStorage.setItem("order", "no");
  });

  await scenario("Caché de metadatos al arrancar", async ({ frame, win, ev }) => {
    await win.addFiles([wav(win, "cache.wav")]);
    await until(async () => {
      const db = await openDbAsIs();
      const found = (await getAll(db, "tracks")).some((r) => r.name === "cache.wav" && r.metaVersion === 2);
      db.close();
      return found;
    });
    // «load» en el elemento iframe: el de contentWindow puede quedarse en la ventana vieja y no llegar nunca.
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    frame.contentWindow.location.reload();
    await loaded;
    await waitReady(frame.contentWindow);
    const reloaded = frame.contentWindow;
    check("arranque con metaVersion coincidente no llama Tags.read", reloaded.__tagsReadCount === 0, reloaded.__tagsReadCount);
    const db = await openDbAsIs();
    const rec = (await getAll(db, "tracks")).find((r) => r.name === "cache.wav");
    db.close();
    check("importación guarda los campos de meta y metaVersion", rec?.metaVersion === 2 && ["title", "artist", "album", "lyrics", "hasCover", "duration", "kind", "width", "height", "codecs"].every((k) => k in rec.meta), JSON.stringify(rec?.meta));
  });

  await scenario("Carátula perezosa en reproductor y Media Session", async ({ win, ev }) => {
    await win.addFiles([fakeMp3WithCover(win, "portada.mp3")]);
    const ready = await until(() => ev("!!state.tracks[0].coverUrl && !!els.cover.style.backgroundImage"));
    const artwork = ev("navigator.mediaSession?.metadata?.artwork || []");
    check("la carátula perezosa aparece en el reproductor", ready && ev("els.cover.classList.contains('has-art')"), ev("els.cover.style.backgroundImage"));
    check("la carátula perezosa llega a Media Session", artwork.length > 0 && artwork[0].src === ev("state.tracks[0].coverUrl"), JSON.stringify(artwork));
  });

  await scenario("Robustez: un registro dañado no impide cargar el resto", async ({ ev }) => {
    check("se conserva y marca como no disponible la pista sin archivo", ev("state.tracks.length") === 2 && ev("state.tracks.find(t => t.fileName === 'roto.mp3')?.unavailable === true"), ev("state.tracks.map(t => `${t.fileName}:${!!t.unavailable}`).join(',')"));
    check("la canción buena sigue cargada", ev("state.tracks.some(t => t.fileName === 'bueno.wav' && !t.unavailable)"), ev("state.tracks.map(t => t.fileName).join(',')"));
    const db = await openDbAsIs();
    const broken = (await getAll(db, "tracks")).find((t) => t.name === "roto.mp3");
    db.close();
    check("sus letras y ediciones siguen en IndexedDB", broken?.lyrics === "letra conservada" && broken?.edits?.title === "Título conservado", JSON.stringify(broken));
  }, async () => {
    const db = await openDb();
    await new Promise((res) => {
      const tx = db.transaction(["tracks", "files"], "readwrite");
      const s = tx.objectStore("tracks");
      s.add({ name: "roto.mp3", type: "audio/mpeg", source: "blob", lyrics: "letra conservada", edits: { title: "Título conservado" } }); // sin archivo en «files»
      s.add({ name: "bueno.wav", type: "audio/wav", size: 8044, kind: "audio", source: "blob" }).onsuccess = (e) =>
        tx.objectStore("files").put({ id: e.target.result, blob: new File([wavBytes({ seconds: 1 })], "bueno.wav", { type: "audio/wav" }) });
      tx.oncomplete = res;
    });
    db.close();
  });

  await scenario("Robustez: sin espacio al guardar (solo esta sesión)", async ({ win, ev }) => {
    ev("Storage.add = () => Promise.reject(new DOMException('sin espacio', 'QuotaExceededError'))");
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 })]);
    const toastText = ev("els.toast.textContent");
    check("avisa cuando falla por cuota (QuotaExceededError)", !ev("els.toast.hidden") && /2 pistas solo para esta sesión: no hay espacio/.test(toastText), toastText);
    check("las pistas quedan en la sesión", ev("state.tracks.length") === 2 && ev("state.tracks[0].id") === null);
    win.loadTrack(0, true, "all");
    check("la pista se reproduce igualmente", await until(() => ev("media.currentTime") > 0.2), ev("media.currentTime"));

    // Otro error distinto de QuotaExceededError (con 1 solo archivo también debe avisar)
    ev("Storage.add = () => Promise.reject(new Error('fallo de disco'))");
    await win.addFiles([wav(win, "c.wav", { freq: 660, mtime: 3 })]);
    const toastOther = ev("els.toast.textContent");
    check("distingue otros errores de guardado", !ev("els.toast.hidden") && /1 pista solo para esta sesión: no se pudo guardar/.test(toastOther), toastOther);
  });

  /* ----- Migración de la base v1 (archivo dentro del registro) a v2 (metadatos y archivos separados) ----- */

  await scenario("Migración v1 → v2", async ({ frame, win, ev }) => {
    check("migración: se cargan las 2 canciones en el orden guardado", ev("state.tracks.map(t => t.fileName).join(',')") === "b.wav,a.wav", ev("state.tracks.map(t => t.fileName).join(',')"));
    const a = "state.tracks.find(t => t.fileName === 'a.wav')";
    check("migración: se conservan las ediciones", ev(`${a}.title`) === "Editado" && ev(`${a}.artist`) === "Alguien", `${ev(`${a}.title`)} / ${ev(`${a}.artist`)}`);
    check("migración: se conserva la letra", ev(`${a}.userLyrics`) === "[00:00.50]Hola", ev(`${a}.userLyrics`));
    check("migración: se recuerda la última pista", ev("state.tracks[state.index]?.fileName") === "a.wav", ev("state.tracks[state.index]?.fileName"));
    const db = await openDbAsIs();
    const [tracks, files] = [await getAll(db, "tracks"), await getAll(db, "files")];
    db.close();
    check("migración: la base pasa a v2 con «tracks» y «files»", db.version === 2 && storeNames(db) === "files,tracks", `v${db.version} ${storeNames(db)}`);
    check("migración: los archivos están en «files» y ya no en «tracks»",
      files.length === 2 && files.every((f) => f.blob instanceof Blob && f.blob.size > 0) && tracks.every((t) => !("blob" in t) && t.source === "blob" && t.kind === "audio"),
      JSON.stringify(tracks));
    win.loadTrack(ev("state.tracks.findIndex(t => t.fileName === 'a.wav')"), true, "all");
    check("migración: la canción migrada suena", await until(() => !ev("media.paused") && ev("media.currentTime") > 0.3), `paused=${ev("media.paused")} t=${ev("media.currentTime")}`);

    // Tras migrar, editar y poner letra sigue guardándose.
    ev("commitEdits([state.tracks.find(t => t.fileName === 'b.wav')], () => ({ title: 'B nuevo' }))");
    ev("setUserLyrics(state.tracks.find(t => t.fileName === 'b.wav'), 'letra de b')");
    await sleep(300);
    frame.contentWindow.location.reload();
    await sleep(300);
    await waitReady(frame.contentWindow);
    const e2 = (c) => frame.contentWindow.eval(c);
    check("migración: lo editado después se conserva al recargar",
      e2("state.tracks.length") === 2 && e2("state.tracks.find(t => t.fileName === 'b.wav').title") === "B nuevo"
        && e2("state.tracks.find(t => t.fileName === 'b.wav').userLyrics") === "letra de b" && e2("state.tracks.find(t => t.fileName === 'a.wav').title") === "Editado",
      e2("state.tracks.map(t => t.fileName + ':' + t.title).join(',')"));
  }, async () => {
    await seedV1([
      { name: "a.wav", blob: new File([wavBytes({ seconds: 3 })], "a.wav", { type: "audio/wav", lastModified: 1 }), type: "audio/wav",
        lyrics: "[00:00.50]Hola", edits: { title: "Editado", artist: "Alguien" } },
      { name: "b.wav", blob: new File([wavBytes({ seconds: 3, freq: 550 })], "b.wav", { type: "audio/wav", lastModified: 2 }), type: "audio/wav" },
    ]);
    localStorage.setItem("order", "[2,1]");
    localStorage.setItem("lastId", "1");
  });

  await scenario("Migración v1 → v2 con un registro corrupto", async ({ ev }) => {
    check("migración con corruptos: conserva y marca el registro sin archivo", ev("state.tracks.length === 3 && state.tracks.filter(t => t.unavailable).length === 2"), ev("state.tracks.map(t => `${t.fileName}:${!!t.unavailable}`).join(',')"));
    check("migración con corruptos: la canción disponible sigue cargada", ev("state.tracks.some(t => t.fileName === 'bueno.wav' && !t.unavailable)"), ev("state.tracks.map(t => t.fileName).join(',')"));
    let left = null;
    const ok = await until(async () => {
      const db = await openDbAsIs();
      left = [db.version, (await getAll(db, "tracks")).map((t) => t.name).join(","), (await getAll(db, "files")).length];
      db.close();
      return left[0] === 2 && left[1] === "roto.mp3,texto.mp3,bueno.wav" && left[2] === 1;
    });
    check("migración con corruptos: la base queda en v2 y conserva los registros sin archivo", ok, JSON.stringify(left));
  }, async () => {
    await seedV1([
      { name: "roto.mp3", type: "audio/mpeg" },                           // sin blob
      { name: "texto.mp3", blob: "no soy un archivo", type: "audio/mpeg" }, // blob que no es Blob
      { name: "bueno.wav", blob: new File([wavBytes({ seconds: 1 })], "bueno.wav", { type: "audio/wav" }), type: "audio/wav" },
    ]);
  });

  await scenario("Video en el escenario", async ({ win, ev }) => {
    const videoFile = await makeWebm(win, "clip.webm", { withVideo: true, seconds: 2.6 });
    const audioWebm = await makeWebm(win, "solo-audio.webm", { withVideo: false, seconds: 1.5 });
    await win.addFiles([
      wav(win, "a.wav", { seconds: 3, mtime: 1 }),
      videoFile,
      wav(win, "b.wav", { seconds: 3, freq: 550, mtime: 2 }),
      audioWebm,
    ]);

    let xfades = 0;
    const realXfade = win.startCrossfade;
    win.startCrossfade = (...a) => { xfades++; return realXfade(...a); };
    win.setCrossfade(2);

    // 1. Audio inicial: escenario oculto, visualizador visible, botón «Letra»
    win.loadTrack(0, true, "all");
    await until(() => ev("!media.paused && media.currentTime > 0.2"));
    check("video: en audio el escenario está oculto y el visualizador visible",
      ev("getComputedStyle($('stage')).display === 'none' && !els.viz.hidden && els['lyrics-toggle'].textContent === 'Letra'"));

    // 2. Transición audio → video sin fundido
    await seekNearEnd(ev, 0.8);
    check("video: pasa de audio a video al terminar", await until(() => ev("state.index === 1"), 4000), ev("state.index"));
    check("video: audio → video no intenta fundido", xfades === 0 && ev("xfade === null"), `xfades=${xfades}`);

    // 3. Reproduciendo video: videoWidth > 0, deck activo visible, visualizador parado, EQ conectado, botón «Subtítulos»
    check("video: tiene videoWidth > 0", await until(() => ev("media.videoWidth > 0 && media.currentTime > 0.2"), 4000), ev("media.videoWidth"));
    check("video: escenario visible con solo el deck activo",
      ev("getComputedStyle($('stage')).display !== 'none' && !media.classList.contains('oculto') && otherDeck().classList.contains('oculto')"));
    check("video: carátula en formato 16:9", ev("getComputedStyle(els.cover).aspectRatio === '16 / 9' || getComputedStyle(els.cover).aspectRatio === '1.77778'"), ev("getComputedStyle(els.cover).aspectRatio"));
    check("video: visualizador oculto y draw() parado", ev("els.viz.hidden && !vizRunning"));
    check("video: botón pasa a Subtítulos y no abre el panel de letra",
      (() => { ev("els['lyrics-toggle'].click()"); return ev("els['lyrics-toggle'].textContent === 'Subtítulos' && els.lyrics.hidden"); })());
    const eqSignal = await until(() => ev("(() => { if (!analyser || !eqFilters.length) return false; const b = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(b); return b.some(v => v > 0); })()"), 3000);
    check("video: el EQ sigue conectado al grafo de Web Audio", eqSignal && ev("eqFilters.length === 10 && decks.every(d => d._gain)"));

    const videoDeck = ev("media");
    videoDeck.pause();
    videoDeck.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    check("escenario: clic simple alterna reproducir", await until(() => ev("!media.paused"), 1500));
    videoDeck.pause();
    let fullscreenCalls = 0;
    const realToggleFullscreen = win.toggleFullscreen;
    win.toggleFullscreen = () => { fullscreenCalls++; };
    const click = (detail) => videoDeck.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail }));
    click(1);
    await sleep(350);
    click(2);
    videoDeck.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    await sleep(550);
    check("escenario: doble clic llama fullscreen sin alternar reproducción", fullscreenCalls === 1 && ev("media.paused"), `llamadas=${fullscreenCalls}, pausado=${ev("media.paused")}`);
    win.toggleFullscreen = realToggleFullscreen;
    win.eval("play()");

    // 4. Transición video → audio sin fundido
    await seekNearEnd(ev, 0.8);
    check("video: pasa de video a audio al terminar", await until(() => ev("state.index === 2"), 4000), ev("state.index"));
    check("video: video → audio no intenta fundido", xfades === 0 && ev("xfade === null"), `xfades=${xfades}`);
    check("video: al volver a audio se oculta el escenario y vuelve el visualizador",
      await until(() => ev("getComputedStyle($('stage')).display === 'none' && !els.viz.hidden && vizRunning && els['lyrics-toggle'].textContent === 'Letra'"), 2500));

    const mediaFilter = ev("els['media-filter']");
    const beforeShortcut = ev("({ time: media.currentTime, volume: els.volume.value, muted: media.muted })");
    const selectKeys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space", "KeyM"];
    const leakedShortcut = selectKeys.some((code) => {
      const e = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, code });
      mediaFilter.dispatchEvent(e);
      return e.defaultPrevented;
    });
    check("biblioteca: atajos globales dejan usar el selector de medios", !leakedShortcut
      && ev("els.volume.value") === beforeShortcut.volume
      && ev("media.currentTime") === beforeShortcut.time
      && ev("media.muted") === beforeShortcut.muted, `preventDefault=${leakedShortcut}`);
    check("biblioteca: el selector tiene foco visible", ev("[...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } }).some(r => r.selectorText?.includes('select:focus-visible'))"));
    const unavailable = await ev("makeUnavailableTrack({ id: 909, name: 'offline.webm', size: 10, meta: { kind: 'video', width: 1920, height: 1080 } })");
    check("biblioteca: video no disponible conserva clasificación y resolución", unavailable.meta.kind === "video"
      && unavailable.meta.width === 1920 && unavailable.meta.height === 1080);
    // 5. .webm solo audio (videoWidth === 0) se reclasifica a audio, repinta la fila y se guarda en meta.kind
    mediaFilter.value = "video";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));
    win.loadTrack(3, true, "all");
    check("video: .webm sin imagen se reclasifica a audio",
      await until(() => ev("state.tracks[3].meta.kind === 'audio' && getComputedStyle($('stage')).display === 'none' && !els.viz.hidden && [...els.playlist.querySelectorAll('li:not(.empty)')].every(li => !li.textContent.includes('solo-audio'))"), 4000),
      ev("state.tracks[3].meta.kind"));
    mediaFilter.value = "all";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));
    const saved = await until(async () => {
      const db = await openDbAsIs();
      const rec = (await getAll(db, "tracks")).find((r) => r.name === "solo-audio.webm");
      db.close();
      return rec?.meta?.kind === "audio";
    }, 3000);
    check("video: la reclasificación a audio se guarda en meta.kind", saved);

    mediaFilter.value = "video";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));
    const videoRows = ev("[...els.playlist.querySelectorAll('li:not(.empty)')]");
    check("biblioteca: filtro Videos muestra solo videos con icono accesible y resolución única", videoRows.length === 1
      && videoRows[0].querySelector(".video-mark")?.textContent === "▶"
      && videoRows[0].querySelector(".video-mark")?.getAttribute("aria-hidden") === "true"
      && !videoRows[0].querySelector(".video-size")
      && videoRows[0].querySelector(".t-sub")?.textContent.includes(`${Math.min(ev("state.tracks[1].meta.width"), ev("state.tracks[1].meta.height"))}p`),
      `${videoRows.length} filas`);
    mediaFilter.value = "audio";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));
    check("biblioteca: filtro Música excluye videos", ev("els.playlist.querySelectorAll('li:not(.empty)').length") === 3);
    const oldTracks = ev("state.tracks.slice()");
    ev("state.tracks.length = 0; render()");
    check("biblioteca: filtro persistido conserva el mensaje de biblioteca vacía", ev("els.playlist.querySelector('.empty')?.textContent.includes('Tu biblioteca está vacía')"));
    win.__oldTracks = oldTracks;
    ev("state.tracks.push(...window.__oldTracks); render(); delete window.__oldTracks");
    mediaFilter.value = "all";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));

    // 6. Aleatorio con biblioteca audio + video: nunca inicia fundido hacia un video
    ev("state.playlists.push({ id: 'mix-av', name: 'Mix AV', ids: [state.tracks[0].id, state.tracks[1].id] })");
    ev("els.shuffle.click()");
    win.loadTrack(0, true, "mix-av");
    await until(() => ev("!media.paused && media.currentTime > 0.2"));
    await seekNearEnd(ev, 0.8);
    check("video: con aleatorio hacia video pasa al video al terminar", await until(() => ev("state.index === 1"), 4000), ev("state.index"));
    check("video: con aleatorio hacia video no intenta fundido", xfades === 0 && ev("xfade === null"), `xfades=${xfades}`);
    ev("els.shuffle.click()");

    win.startCrossfade = realXfade;
    win.setCrossfade(0);
    ev("media.pause()");
  });

  await scenario("Pantalla completa", async ({ win, ev }) => {
    check("pantalla completa: toggleFullscreen existe como función global", typeof win.toggleFullscreen === "function");

    const videoFile = await makeWebm(win, "fs-clip.webm", { withVideo: true, seconds: 2.2, mtime: 201 });
    await win.addFiles([wav(win, "fs-audio.wav", { seconds: 3, mtime: 200 }), videoFile]);

    const stage = ev("els.stage");
    const bar = ev("els['fs-controls']");
    let fsEl = null;
    const reqTargets = [];
    let exitCalls = 0;

    Object.defineProperty(win.document, "fullscreenElement", { configurable: true, get: () => fsEl });
    stage.requestFullscreen = () => {
      reqTargets.push(stage);
      fsEl = stage;
      win.document.dispatchEvent(new win.Event("fullscreenchange"));
      return Promise.resolve();
    };
    for (const d of ev("decks")) {
      d.requestFullscreen = () => { reqTargets.push(d); return Promise.resolve(); };
    }
    win.document.exitFullscreen = () => {
      exitCalls++;
      fsEl = null;
      win.document.dispatchEvent(new win.Event("fullscreenchange"));
      return Promise.resolve();
    };

    const pressF = (target) => target.dispatchEvent(new win.KeyboardEvent("keydown", { code: "KeyF", bubbles: true, cancelable: true }));

    // 1. Con pista de audio, F y toggleFullscreen no actúan.
    win.loadTrack(0, false, "all");
    pressF(win.document.body);
    await win.toggleFullscreen();
    check("pantalla completa: F y toggleFullscreen no actúan con pistas de audio",
      reqTargets.length === 0 && !ev("isFullscreen()") && bar.classList.contains("oculto"),
      `req=${reqTargets.length}`);

    // 2. Con pista de video, F ignorado dentro de inputs (incluidos range) o select, y activo fuera.
    win.loadTrack(1, true, "all");
    await until(() => ev("media.videoWidth > 0 && media.currentTime > 0.2"), 4000);
    pressF(ev("els.filter"));
    pressF(ev("els.seek"));
    pressF(ev("els.volume"));
    pressF(ev("els.view"));
    check("pantalla completa: F no actúa cuando el foco está en un input (incluidos range) o select", reqTargets.length === 0);

    pressF(win.document.body);
    check("pantalla completa: F llama requestFullscreen sobre #stage (no sobre <video>) y muestra la barra",
      reqTargets.length === 1 && reqTargets[0] === stage && ev("isFullscreen()") && !bar.classList.contains("oculto"),
      `targets=${reqTargets.map((t) => t.id).join(",")}`);
    check("pantalla completa: botón de subtítulos visible y botón de PiP visible solo si pictureInPictureEnabled",
      ev("!!$('fs-subs') && !$('fs-subs').classList.contains('oculto') && getComputedStyle($('fs-subs')).display !== 'none' && !!$('fs-pip') && $('fs-pip').classList.contains('oculto') === !isPipSupported()"));

    // 3. Los controles reflejan el estado real y reusan la lógica del reproductor; no propagan clic/doble clic a #stage.
    let stageClicks = 0;
    let stageDblclicks = 0;
    stage.addEventListener("click", () => stageClicks++);
    stage.addEventListener("dblclick", () => stageDblclicks++);
    ev("els['fs-play'].click()");
    const fsPaused = await until(() => ev("media.paused && els['fs-play-icon'].innerHTML.includes('M8 5v14') && els['play-icon'].innerHTML.includes('M8 5v14')"), 1500);
    check("pantalla completa: play/pausa en la barra pausa el medio y actualiza ambos iconos", fsPaused,
      `paused=${ev("media.paused")} fs=${ev("els['fs-play-icon'].innerHTML")} main=${ev("els['play-icon'].innerHTML")}`);
    bar.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    check("pantalla completa: clics y doble clic en la barra no suben a #stage", stageClicks === 0 && stageDblclicks === 0,
      `clicks=${stageClicks} dbl=${stageDblclicks}`);

    ev("els['fs-volume'].value = '0.35'; els['fs-volume'].dispatchEvent(new Event('input', { bubbles: true }))");
    check("pantalla completa: volumen sincronizado con el reproductor y guardado",
      Math.abs(ev("media.volume") - 0.35) < 0.001 && Math.abs(+ev("els.volume.value") - 0.35) < 0.001 && ev("localStorage.getItem('volume')") === "0.35",
      `vol=${ev("media.volume")} main=${ev("els.volume.value")}`);

    ev("els['fs-mute'].click()");
    const fsMuted = await until(() => ev("media.muted && els['fs-mute'].classList.contains('silenciado') && !els['fs-mute'].getAttribute('style')"), 1500);
    check("pantalla completa: silenciar sincroniza estado y usa clase (sin style inline)", fsMuted,
      `muted=${ev("media.muted")} cls=${ev("els['fs-mute'].className")}`);
    ev("els['fs-mute'].click()");
    const fsUnmuted = await until(() => ev("!media.muted && !els['fs-mute'].classList.contains('silenciado')"), 1500);
    check("pantalla completa: quitar silencio restaura el botón", fsUnmuted);

    const hasDur = await until(() => Number.isFinite(ev("media.duration")) && ev("media.duration") > 0, 2000);
    if (hasDur) {
      ev("els['fs-seek'].value = '50'; els['fs-seek'].dispatchEvent(new Event('input', { bubbles: true }))");
      check("pantalla completa: progreso busca en el medio real",
        Math.abs(ev("media.currentTime") - ev("media.duration") * 0.5) < 0.25,
        `t=${ev("media.currentTime")} dur=${ev("media.duration")}`);
    } else {
      // Algunos MediaRecorder dejan duration = Infinity: probamos con una pista de duración conocida sin romper.
      check("pantalla completa: barra de progreso habilitada para la pista activa", !ev("els['fs-seek'].disabled"));
    }

    // Con foco en los controles range (#fs-seek y #fs-volume), F no sale de pantalla completa, pero otros atajos siguen activos.
    const fsSeek = ev("els['fs-seek']");
    const fsVolume = ev("els['fs-volume']");
    fsSeek.focus();
    pressF(fsSeek);
    fsVolume.focus();
    pressF(fsVolume);
    check("pantalla completa: F no sale de pantalla completa con foco en #fs-seek o #fs-volume",
      exitCalls === 0 && ev("isFullscreen()"),
      `exits=${exitCalls} fs=${ev("isFullscreen()")}`);
    fsVolume.dispatchEvent(new win.KeyboardEvent("keydown", { code: "KeyM", bubbles: true, cancelable: true }));
    const mutedFromRange = ev("media.muted");
    fsVolume.dispatchEvent(new win.KeyboardEvent("keydown", { code: "KeyM", bubbles: true, cancelable: true }));
    check("pantalla completa: otros atajos (M) siguen funcionando sobre input[type=range]",
      mutedFromRange && !ev("media.muted"),
      `mutedAfterFirst=${mutedFromRange} mutedAfterSecond=${ev("media.muted")}`);

    // 4. Inactividad de 3 s (con temporizadores controlados): oculta barra y cursor; mousemove los recupera.
    const realSetTimeout = win.setTimeout;
    const realClearTimeout = win.clearTimeout;
    const timers = new Map();
    let nextTimerId = 10000;
    try {
      win.setTimeout = (fn, ms, ...args) => {
        if (ms === ev("FS_IDLE_MS")) {
          const id = nextTimerId++;
          timers.set(id, { fn, ms, args });
          return id;
        }
        return realSetTimeout.call(win, fn, ms, ...args);
      };
      win.clearTimeout = (id) => {
        if (timers.has(id)) { timers.delete(id); return; }
        return realClearTimeout.call(win, id);
      };

      stage.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }));
      const [firstId, firstTimer] = [...timers.entries()].at(-1) || [];
      check("pantalla completa: programa el ocultado a los 3000 ms", !!firstTimer && firstTimer.ms === 3000, firstTimer?.ms);

      // Dispara el temporizador de inactividad
      timers.delete(firstId);
      firstTimer.fn(...firstTimer.args);
      check("pantalla completa: tras 3 s sin mover el ratón se ocultan barra y cursor (con clases, sin style inline)",
        stage.classList.contains("fs-inactivo")
        && win.getComputedStyle(stage).cursor === "none"
        && win.getComputedStyle(bar).display === "none"
        && !stage.getAttribute("style") && !bar.getAttribute("style"),
        `cls=${stage.className} cursor=${win.getComputedStyle(stage).cursor} disp=${win.getComputedStyle(bar).display}`);

      // Mover el ratón vuelve a mostrar barra y cursor y reinicia el temporizador
      stage.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 60, clientY: 40 }));
      check("pantalla completa: al mover el ratón reaparecen la barra y el cursor y se reprograma el temporizador",
        !stage.classList.contains("fs-inactivo")
        && win.getComputedStyle(stage).cursor !== "none"
        && win.getComputedStyle(bar).display !== "none"
        && timers.size === 1,
        `cls=${stage.className} disp=${win.getComputedStyle(bar).display} timers=${timers.size}`);

      // 5. Botón salir y cambio a pista de audio salen de pantalla completa.
      ev("els['fs-exit'].click()");
      check("pantalla completa: botón salir llama exitFullscreen, oculta la barra y cancela el temporizador",
        exitCalls === 1 && !ev("isFullscreen()") && bar.classList.contains("oculto") && !stage.classList.contains("fs-inactivo") && timers.size === 0,
        `exits=${exitCalls} timers=${timers.size}`);

      await win.toggleFullscreen();
      check("pantalla completa: toggleFullscreen vuelve a entrar en video", ev("isFullscreen()") && !bar.classList.contains("oculto"));
      win.document.dispatchEvent(new win.KeyboardEvent("keydown", { code: "Escape", bubbles: true, cancelable: true }));
      check("pantalla completa: Escape sale de pantalla completa (necesario en Electron)",
        exitCalls === 2 && !ev("isFullscreen()") && bar.classList.contains("oculto"),
        `exits=${exitCalls}`);

      await win.toggleFullscreen();
      win.loadTrack(0, false, "all");
      check("pantalla completa: pasar a pista de audio sale de pantalla completa",
        exitCalls === 3 && !ev("isFullscreen()") && bar.classList.contains("oculto"),
        `exits=${exitCalls}`);
    } finally {
      win.setTimeout = realSetTimeout;
      win.clearTimeout = realClearTimeout;
    }

    ev("media.pause()");
  });

  await scenario("Compatibilidad de códecs", async ({ win, ev }) => {
    // MP4 sintético con pista de video H.264 + pista de audio AC-3 (stsd real).
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const str = (s) => [...s].map((c) => c.charCodeAt(0));
    const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
    const box = (type, ...content) => {
      const body = cat(...content);
      return cat(u32(8 + body.length), str(type), body);
    };
    const avcC = box("avcC", [1, 0x64, 0x00, 0x28]);
    const stsdV = box("stsd", u32(0), u32(1), box("avc1", new Uint8Array(78), avcC));
    const stsdA = box("stsd", u32(0), u32(1), box("ac-3", new Uint8Array(28)));
    const trak = (h, stsd) => box("trak", box("mdia", box("hdlr", u32(0), u32(0), str(h), [0, 0, 0, 0]), box("minf", box("stbl", stsd))));
    const ac3Mp4 = new win.File([box("ftyp", str("isom"), u32(0)), box("moov", trak("vide", stsdV), trak("soun", stsdA))], "peli-ac3.mp4", { type: "video/mp4", lastModified: 301 });

    await win.addFiles([ac3Mp4]);
    const rowWarn = ev("els.playlist.querySelector('li .t-warn')?.textContent || ''");
    check("compatibilidad: MP4 con AC-3 se importa y muestra «puede no reproducirse» con motivo en la fila",
      ev("state.tracks.length === 1 && state.tracks[0].meta.codecs === 'avc1.640028, ac-3'")
      && /puede no reproducirse/i.test(rowWarn) && /AC-3/i.test(rowWarn),
      `${ev("state.tracks[0]?.meta?.codecs")} | ${rowWarn}`);

    // loadedmetadata en pista de video conocida (MP4) con videoWidth === 0 → «se oye pero el códec de video no es compatible».
    ev("els.toast.hidden = true; loadTrack(0, false, 'all')");
    ev("media.dispatchEvent(new Event('loadedmetadata'))");
    check("compatibilidad: video conocido con videoWidth === 0 avisa códec de video incompatible sin reclasificar a audio",
      !ev("els.toast.hidden") && /se oye pero el códec de video no es compatible/i.test(ev("els.toast.textContent"))
      && ev("state.tracks[0].meta.kind === 'video'"),
      ev("els.toast.textContent"));

    // Error al reproducir MKV → sugerencia de remux sin recodificar.
    const badMkv = new win.File([new Uint8Array(256).fill(1)], "peli.mkv", { type: "video/x-matroska", lastModified: 302 });
    await win.addFiles([badMkv]);
    ev("els.toast.hidden = true; loadTrack(1, false, 'all'); media.dispatchEvent(new Event('error'))");
    check("compatibilidad: error en MKV sugiere remux sin recodificar",
      !ev("els.toast.hidden") && ev("els.toast.textContent").includes("ffmpeg -i entrada.mkv -c copy salida.mp4"),
      ev("els.toast.textContent"));

    // MKV con pista de video detectada (V_MPEGH/ISO/HEVC) y videoWidth === 0 → avisa y NO reclasifica a audio.
    const ebml = (id, body) => { const b = cat(...body); return cat(id, [0x80 | b.length], b); };
    const hevcMkvBytes = cat(
      ebml([0x1a, 0x45, 0xdf, 0xa3], [ebml([0x42, 0x82], [str("matroska")])]),
      ebml([0x18, 0x53, 0x80, 0x67], [ebml([0x16, 0x54, 0xae, 0x6b], [
        ebml([0xae], [ebml([0x86], [str("V_MPEGH/ISO/HEVC")])]),
        ebml([0xae], [ebml([0x86], [str("A_AAC")])]),
      ])]),
    );
    const hevcMkv = new win.File([hevcMkvBytes], "hevc.mkv", { type: "video/x-matroska", lastModified: 304 });
    await win.addFiles([hevcMkv]);
    ev("els.toast.hidden = true; loadTrack(2, false, 'all'); media.dispatchEvent(new Event('loadedmetadata'))");
    check("compatibilidad: MKV con video detectado y videoWidth === 0 avisa y no reclasifica a audio",
      ev("state.tracks[2].meta.kind === 'video' && state.tracks[2].meta.codecs === 'V_MPEGH/ISO/HEVC, A_AAC'")
      && !ev("els.toast.hidden") && /se oye pero el códec de video no es compatible/i.test(ev("els.toast.textContent")),
      `${ev("state.tracks[2]?.meta?.kind")} | ${ev("state.tracks[2]?.meta?.codecs")} | ${ev("els.toast.textContent")}`);

    // WebM indeterminado (sin Tracks en cabecera) con videoWidth === 0 → sigue reclasificando a audio (T1.3).
    const indetWebm = new win.File([new Uint8Array(64).fill(9)], "indet.webm", { type: "video/webm", lastModified: 305 });
    await win.addFiles([indetWebm]);
    ev("els.toast.hidden = true; loadTrack(3, false, 'all'); media.dispatchEvent(new Event('loadedmetadata'))");
    check("compatibilidad: WebM indeterminado con videoWidth === 0 se reclasifica a audio sin aviso",
      ev("state.tracks[3].meta.kind === 'audio' && state.tracks[3].meta.codecs === ''") && ev("els.toast.hidden"),
      `${ev("state.tracks[3]?.meta?.kind")} | hidden=${ev("els.toast.hidden")}`);

    // Archivo AVI con tipo vacío → rechazado con consejo de remux.
    const avi = new win.File([new Uint8Array(64)], "viejo.avi", { type: "", lastModified: 303 });
    await win.addFiles([avi]);
    check("compatibilidad: AVI no soportado muestra sugerencia de remux",
      !ev("els.toast.hidden") && ev("els.toast.textContent").includes("ffmpeg -i entrada.avi -c copy salida.mp4"),
      ev("els.toast.textContent"));
  });

  await scenario("Subtítulos", async ({ frame, win, ev }) => {
    const videoFile = await makeWebm(win, "sub-clip.webm", { withVideo: true, seconds: 3.6, mtime: 401 });
    // SRT en Latin-1/windows-1252 para comprobar decodificación + emparejado por nombre al importar.
    const latin1Bytes = (s) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xff));
    const srtBytes = latin1Bytes("1\n00:00:00,400 --> 00:00:01,800\n¿Hola, niño?\n");
    const companionSrt = new win.File([srtBytes], "sub-clip.es.srt", { type: "application/x-subrip", lastModified: 402 });

    await win.addFiles([videoFile, companionSrt]);
    check("subtítulos: .srt acompañante se empareja al importar, decodifica windows-1252 y extrae idioma",
      ev("state.tracks.length === 1 && state.tracks[0].subs.length === 1 && state.tracks[0].subs[0].lang === 'es' && state.tracks[0].subs[0].label === 'Español' && state.tracks[0].subs[0].text.includes('¿Hola, niño?')"),
      JSON.stringify(ev("state.tracks[0]?.subs")));

    // Cargar un VTT adicional (como con «Cargar subtítulos…»).
    const vttText = "WEBVTT\n\n00:00:00.500 --> 00:00:01.800\nPrimera línea\n\n00:00:02.200 --> 00:00:03.200\nSegunda línea\n";
    const vttFile = new win.File([vttText], "extra.en.vtt", { type: "text/vtt", lastModified: 403 });
    await win.loadSubtitleFiles(ev("state.tracks[0]"), [vttFile]);
    check("subtítulos: cargar VTT lo añade, lo activa y monta <track kind='subtitles' src='blob:…'>",
      ev("state.tracks[0].subs.length === 2 && state.tracks[0].subIndex === 1 && media.querySelectorAll('track').length === 1 && media.querySelector('track').kind === 'subtitles' && media.querySelector('track').src.startsWith('blob:')"),
      ev("media.querySelector('track')?.outerHTML || 'sin track'"));

    // Comprobar activeCues en el tiempo esperado.
    win.loadTrack(0, true, "all");
    await until(() => ev("media.readyState >= 2"), 4000);
    ev("media.pause(); media.currentTime = 1.0;");
    const activeAt1 = await until(() => ev("media.textTracks[0]?.activeCues?.length === 1 && media.textTracks[0].activeCues[0].text === 'Primera línea'"), 3000);
    check("subtítulos: activeCues muestra la cue esperada en t = 1,0 s", activeAt1,
      ev("JSON.stringify([...(media.textTracks[0]?.activeCues || [])].map(c => c.text))"));

    // Desfase (+1,5 s mediante pasos y ajuste guardado): la cue se desplaza de 0,5–1,8 s a 2,0–3,3 s.
    await win.adjustSubOffset(ev("state.tracks[0]"), 1.4);
    ev("els['lyrics-toggle'].click()");
    const menuBtns = ev("[...els.menu.querySelectorAll('button')].map(b => b.textContent)");
    check("subtítulos: el menú ofrece pistas, desactivar, desfase y «Cargar subtítulos…»",
      menuBtns.some((t) => /Desactivados/.test(t)) && menuBtns.some((t) => /Español/.test(t))
      && menuBtns.some((t) => /Desfase: \+1,4 s/.test(t)) && menuBtns.some((t) => /Cargar subtítulos/.test(t)),
      menuBtns.join(" | "));
    ev("[...els.menu.querySelectorAll('button')].find(b => b.textContent.includes('+0,1 s')).click()");
    await until(() => ev("state.tracks[0].subs[1].offset === 1.5"), 1500);
    ev("closeMenu()");

    ev("media.currentTime = 1.0;");
    const emptyAt1 = await until(() => ev("media.textTracks[0]?.cues?.length > 0 && media.textTracks[0].activeCues.length === 0"), 3000);
    ev("media.currentTime = 2.5;");
    const shiftedAt25 = await until(() => ev("media.textTracks[0]?.activeCues?.length === 1 && media.textTracks[0].activeCues[0].text === 'Primera línea'"), 3000);
    check("subtítulos: el desfase (+1,5 s) desplaza activeCues al tiempo esperado", emptyAt1 && shiftedAt25,
      `emptyAt1=${emptyAt1} shiftedAt25=${shiftedAt25} offset=${ev("state.tracks[0].subs[1].offset")}`);

    // Desactivar subtítulos (menú / tecla C) quita el <track> y revoca la blob: URL.
    const revoked = [];
    const realRevoke = win.URL.revokeObjectURL.bind(win.URL);
    win.URL.revokeObjectURL = (u) => { revoked.push(u); return realRevoke(u); };
    const trackUrlBeforeOff = ev("media.querySelector('track')?.src || ''");
    win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", { code: "KeyC", bubbles: true, cancelable: true }));
    check("subtítulos: tecla C desactiva, quita <track> y revoca su blob: URL",
      ev("state.tracks[0].subIndex === -1 && media.querySelectorAll('track').length === 0 && els['lyrics-toggle'].getAttribute('aria-pressed') === 'false'")
      && revoked.includes(trackUrlBeforeOff),
      `revoked=${revoked.length}`);
    win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", { code: "KeyC", bubbles: true, cancelable: true }));
    check("subtítulos: volver a pulsar C restaura la pista activa",
      ev("state.tracks[0].subIndex === 1 && media.querySelectorAll('track').length === 1 && els['lyrics-toggle'].getAttribute('aria-pressed') === 'true'"));

    // Cambio de deck: quitar <track> del deck anterior y revocar su URL.
    const oldDeck = ev("media");
    const oldUrl = oldDeck.querySelector("track")?.src || "";
    ev("const prev = media; media = otherDeck(); syncSubtitles();");
    check("subtítulos: al cambiar de deck se quitan los <track> del anterior y se revoca su URL",
      oldDeck.querySelectorAll("track").length === 0 && revoked.includes(oldUrl) && ev("media.querySelectorAll('track').length === 1"),
      `oldTracks=${oldDeck.querySelectorAll("track").length} revoked=${revoked.includes(oldUrl)}`);
    win.URL.revokeObjectURL = realRevoke;

    // Botón #fs-subs en pantalla completa abre el menú dentro de #stage.
    const stage = ev("els.stage");
    let fsEl = null;
    Object.defineProperty(win.document, "fullscreenElement", { configurable: true, get: () => fsEl });
    stage.requestFullscreen = () => { fsEl = stage; win.document.dispatchEvent(new win.Event("fullscreenchange")); return Promise.resolve(); };
    win.document.exitFullscreen = () => { fsEl = null; win.document.dispatchEvent(new win.Event("fullscreenchange")); return Promise.resolve(); };
    await win.toggleFullscreen();
    ev("els['fs-subs'].click()");
    check("subtítulos: en pantalla completa #fs-subs es visible y abre el menú dentro de #stage",
      ev("!els['fs-subs'].classList.contains('oculto') && !els.menu.hidden && els.stage.contains(els.menu) && els.menu.textContent.includes('Cargar subtítulos')"));
    await win.exitFullscreen();

    // Recarga: conserva subtítulos y desfase en IndexedDB.
    await sleep(200);
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    frame.contentWindow.location.reload();
    await loaded;
    await waitReady(frame.contentWindow);
    const e2 = (c) => frame.contentWindow.eval(c);
    check("subtítulos: tras recargar se conservan pistas, textos y desfase guardado",
      e2("state.tracks.length === 1 && state.tracks[0].subs.length === 2 && state.tracks[0].subs[0].label === 'Español' && state.tracks[0].subs[1].offset === 1.5"),
      JSON.stringify(e2("state.tracks[0]?.subs?.map(s => ({ label: s.label, lang: s.lang, offset: s.offset }))")));

    // Seleccionar la pista con desfase +1,5 s tras recargar y comprobar activeCues.
    e2("setActiveSub(state.tracks[0], 1)");
    await until(() => e2("media.readyState >= 2"), 4000);
    e2("media.currentTime = 2.5;");
    const activeAfterReload = await until(() => e2("media.textTracks[0]?.activeCues?.length === 1 && media.textTracks[0].activeCues[0].text === 'Primera línea'"), 3000);
    check("subtítulos: tras recargar el <track> aplica el desfase guardado en activeCues", activeAfterReload,
      e2("JSON.stringify([...(media.textTracks[0]?.activeCues || [])].map(c => c.text))"));
    e2("media.pause()");
  });

  await scenario("Miniaturas de video", async ({ frame, win, ev }) => {
    // Video cuyos primeros ~0,5 s son negros y el resto brillante (para probar también el salto si el fotograma en 10 % es casi negro).
    async function makeDarkStartWebm(name, seconds = 2.4) {
      const canvas = win.document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext("2d");
      const t0 = Date.now();
      const paint = () => {
        const elapsed = (Date.now() - t0) / 1000;
        ctx.fillStyle = elapsed < 0.5 ? "#000000" : "#40b8ff";
        ctx.fillRect(0, 0, 64, 36);
      };
      paint();
      const timer = win.setInterval(paint, 50);
      const stream = canvas.captureStream(20);
      const mime = "video/webm";
      const rec = win.MediaRecorder.isTypeSupported(mime) ? new win.MediaRecorder(stream, { mimeType: mime }) : new win.MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start();
      await sleep(seconds * 1000);
      rec.stop();
      await stopped;
      win.clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      return new win.File(chunks, name, { type: mime, lastModified: 501 });
    }

    // MP4 con pista de video (hdlr="vide", tkhd 320×180, mvhd 125 s) y átomo covr JPEG.
    function makeMp4WithCovr(name) {
      const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      const u16 = (n) => [(n >>> 8) & 255, n & 255];
      const str = (s) => [...s].map((c) => c.charCodeAt(0));
      const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
      const box = (type, ...content) => { const b = cat(...content); return cat(u32(8 + b.length), str(type), b); };
      const mvhd = box("mvhd", u32(0), u32(0), u32(0), u32(1000), u32(125000), new Uint8Array(80));
      const matrix = cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));
      const tkhd = box("tkhd", u32(3), u32(0), u32(0), u32(1), u32(0), u32(125000), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(320 << 16), u32(180 << 16));
      const hdlr = box("hdlr", u32(0), u32(0), str("vide"), new Uint8Array(12), [0]);
      const trak = box("trak", tkhd, box("mdia", hdlr));
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
      const covr = box("covr", box("data", u32(13), u32(0), jpegBytes));
      const udta = box("udta", box("meta", u32(0), box("ilst", covr)));
      return new win.File([box("ftyp", str("isom"), u32(0)), box("moov", mvhd, trak, udta)], name, { type: "video/mp4", lastModified: 502 });
    }

    const createdUrls = [];
    const revokedUrls = [];
    const realCreate = win.URL.createObjectURL.bind(win.URL);
    const realRevoke = win.URL.revokeObjectURL.bind(win.URL);
    win.URL.createObjectURL = (obj) => { const u = realCreate(obj); createdUrls.push({ u, obj }); return u; };
    win.URL.revokeObjectURL = (u) => { revokedUrls.push(u); return realRevoke(u); };

    let captureCalls = 0;
    let activeCaptures = 0;
    let maxActiveCaptures = 0;
    const realCapture = win.captureVideoThumb;
    win.captureVideoThumb = async (...a) => {
      captureCalls++;
      activeCaptures++;
      maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
      try {
        return await realCapture(...a);
      } finally {
        activeCaptures--;
      }
    };

    const darkStartVideo = await makeDarkStartWebm("sin-covr.webm", 2.4);
    const secondVideo = await makeWebm(win, "segundo.webm", { withVideo: true, seconds: 1.4, mtime: 504 });
    const covrVideo = makeMp4WithCovr("con-covr.mp4");
    const audioTrack = wav(win, "cancion.wav", { seconds: 2, mtime: 503 });

    await win.addFiles([darkStartVideo, secondVideo, covrVideo, audioTrack]);

    // Esperar a que la cola en segundo plano termine las miniaturas de los dos videos sin covr.
    const thumbReady = await until(() => ev("state.tracks[0]?.thumb instanceof Blob && state.tracks[0].thumb.size > 0 && state.tracks[1]?.thumb instanceof Blob && state.tracks[1].thumb.size > 0"), 12000);
    const t0Thumb = ev("state.tracks[0]?.thumb");
    check("miniaturas: tras importar un video sin covr, thumb es un Blob image/jpeg no vacío",
      thumbReady && t0Thumb instanceof win.Blob && t0Thumb.type === "image/jpeg" && t0Thumb.size > 0,
      `type=${t0Thumb?.type} size=${t0Thumb?.size}`);
    check("miniaturas: la cola procesa los videos de uno en uno en segundo plano",
      maxActiveCaptures === 1 && captureCalls === 2,
      `maxActive=${maxActiveCaptures} calls=${captureCalls}`);

    // Comprobar que el fotograma capturado mide 320 px de ancho y que evitó el inicio negro (luminancia media > 16).
    if (t0Thumb instanceof win.Blob && t0Thumb.size > 0) {
      const bmp = await win.createImageBitmap(t0Thumb);
      const c = win.document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const cx = c.getContext("2d");
      cx.drawImage(bmp, 0, 0);
      const luma = win.meanLuminance(cx.getImageData(0, 0, c.width, c.height).data);
      check("miniaturas: canvas de 320 px de ancho y evita fotograma casi negro probando otro punto",
        bmp.width === 320 && luma >= 16,
        `width=${bmp.width} height=${bmp.height} luma=${luma.toFixed(1)}`);
    } else {
      check("miniaturas: canvas de 320 px de ancho y evita fotograma casi negro probando otro punto", false, "sin blob");
    }

    // En la web, el blob URL temporal del <video> auxiliar se revoca al terminar.
    const fileUrls = createdUrls.filter((x) => x.obj === darkStartVideo).map((x) => x.u);
    check("miniaturas: en la web el blob URL del <video> auxiliar se revoca al terminar",
      fileUrls.length >= 2 && fileUrls.some((u) => revokedUrls.includes(u)),
      `fileUrls=${fileUrls.length} revoked=${revokedUrls.length}`);

    // Si hay covr, se usa y no se captura fotograma con <video>.
    await until(() => ev("!!state.tracks[2]?.coverUrl"), 3000);
    check("miniaturas: si hay covr se usa y no genera fotograma con <video>",
      captureCalls === 2 && ev("state.tracks[2].meta.hasCover === true && state.tracks[2].thumb === null && !!state.tracks[2].orig.coverUrl"),
      `captureCalls=${captureCalls} hasCover=${ev("state.tracks[2]?.meta?.hasCover")}`);

    // En Electron (LinkedFile) usa __media/<id> sin crear blob URL, y respeta el tiempo límite por video.
    const linkedProbe = ev("new LinkedFile({ name: 'enlazado.mp4', size: 1024, type: 'video/mp4' }, { linkId: 'a'.repeat(32) })");
    const urlsBeforeLinked = createdUrls.length;
    const linkedRes = await realCapture({ file: linkedProbe, meta: { duration: 20 } }, 150);
    check("miniaturas: LinkedFile usa __media/<id> sin crear blob URL y corta al superar el tiempo límite",
      linkedRes === null && createdUrls.length === urlsBeforeLinked,
      `res=${linkedRes} urlsDelta=${createdUrls.length - urlsBeforeLinked}`);

    // En la lista: miniatura 16:9 en lugar del cuadrado para los videos, con la duración encima.
    const uiInfo = ev(`(() => {
      const items = [...els.playlist.querySelectorAll("li:not(.empty)")];
      const v0 = items[0]?.querySelector(".thumb");
      const v2 = items[2]?.querySelector(".thumb");
      const a0 = items[3]?.querySelector(".thumb");
      return {
        v0Ratio: v0 ? v0.offsetWidth / v0.offsetHeight : 0,
        v0Bg: v0?.style.backgroundImage || "",
        v0Dur: v0?.querySelector(".video-duration")?.textContent || "",
        v2Dur: v2?.querySelector(".video-duration")?.textContent || "",
        a0Square: a0 ? a0.offsetWidth === 40 && a0.offsetHeight === 40 : false,
      };
    })()`);
    check("miniaturas: en la lista los videos tienen miniatura 16:9 (no cuadrada) con la duración encima",
      Math.abs(uiInfo.v0Ratio - 16 / 9) < 0.06 && uiInfo.v0Bg.includes("blob:") && /^\d+:\d{2}$/.test(uiInfo.v0Dur)
      && uiInfo.v2Dur === "2:05" && uiInfo.a0Square,
      JSON.stringify(uiInfo));

    // Se guarda en tracks.thumb en IndexedDB.
    const savedInDb = await until(async () => {
      const db = await openDbAsIs();
      const rec = (await getAll(db, "tracks")).find((r) => r.name === "sin-covr.webm");
      db.close();
      return rec?.thumb instanceof Blob && rec.thumb.type === "image/jpeg" && rec.thumb.size > 0;
    }, 3000);
    check("miniaturas: se guarda en tracks.thumb en IndexedDB", savedInDb);

    // Al recargar, no se regenera si ya existe en tracks.thumb.
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    frame.contentWindow.location.reload();
    await loaded;
    await waitReady(frame.contentWindow);
    const w2 = frame.contentWindow;
    const e2 = (c) => w2.eval(c);
    let regenCalls = 0;
    const realCap2 = w2.captureVideoThumb;
    w2.captureVideoThumb = (...a) => { regenCalls++; return realCap2(...a); };
    await sleep(300);
    check("miniaturas: al recargar se restaura tracks.thumb y no se regenera",
      regenCalls === 0 && e2("state.tracks[0]?.thumb instanceof Blob && state.tracks[0].thumb.type === 'image/jpeg' && !!state.tracks[0].thumbUrl && !!state.tracks[0].coverUrl"),
      `regenCalls=${regenCalls}`);

    // Al quitar una pista, se revocan sus URL (archivo y miniatura).
    const revokedOnRemove = [];
    const realRev2 = w2.URL.revokeObjectURL.bind(w2.URL);
    w2.URL.revokeObjectURL = (u) => { revokedOnRemove.push(u); return realRev2(u); };
    const trackUrl = e2("state.tracks[0].url");
    const thumbUrl = e2("state.tracks[0].thumbUrl");
    e2("removeTrack(0)");
    check("miniaturas: al quitar una pista se revocan sus URL (pista y miniatura)",
      !!trackUrl && !!thumbUrl && revokedOnRemove.includes(trackUrl) && revokedOnRemove.includes(thumbUrl),
      `revoked=${JSON.stringify(revokedOnRemove)}`);
    w2.URL.revokeObjectURL = realRev2;
  });

  await scenario("Picture-in-picture y atajos", async ({ win, ev }) => {
    const audioLong = wav(win, "largo.wav", { seconds: 45, mtime: 500 });
    const video1 = await makeWebm(win, "pip-uno.webm", { withVideo: true, seconds: 2.0, mtime: 501 });
    const video2 = await makeWebm(win, "pip-dos.webm", { withVideo: true, seconds: 1.6, mtime: 502 });
    await win.addFiles([audioLong, video1, video2]);

    let pipEnabled = true;
    let pipEl = null;
    const pipReqTargets = [];
    let pipExitCalls = 0;

    Object.defineProperty(win.document, "pictureInPictureEnabled", { configurable: true, get: () => pipEnabled });
    Object.defineProperty(win.document, "pictureInPictureElement", { configurable: true, get: () => pipEl });
    win.document.exitPictureInPicture = () => {
      pipExitCalls++;
      const prev = pipEl;
      pipEl = null;
      if (prev) prev.dispatchEvent(new win.Event("leavepictureinpicture"));
      return Promise.resolve();
    };
    for (const d of ev("decks")) {
      d.requestPictureInPicture = () => {
        pipReqTargets.push(d);
        pipEl = d;
        d.dispatchEvent(new win.Event("enterpictureinpicture"));
        return Promise.resolve({});
      };
    }

    const sendKey = (target, init) => {
      const e = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    };

    // 1. Con pista de audio: botones PiP ocultos, I no actúa, ,/. no actúan en pausa, Mayús+←/→ salta ±30 s.
    win.loadTrack(0, false, "all");
    await until(() => ev("media.readyState >= 1 && Number.isFinite(media.duration) && media.duration > 40"), 4000);
    check("PiP: botones ocultos con pista de audio",
      ev("els['pip-btn'].classList.contains('oculto') && els['fs-pip'].classList.contains('oculto')"));
    sendKey(win.document.body, { code: "KeyI" });
    check("PiP: atajo I no actúa con pista de audio", pipReqTargets.length === 0 && !pipEl);

    ev("media.pause(); media.currentTime = 5;");
    const audioBeforeFrame = ev("media.currentTime");
    sendKey(win.document.body, { code: "Period" });
    sendKey(win.document.body, { code: "Comma" });
    check("atajos: , y . no actúan en pista de audio", Math.abs(ev("media.currentTime") - audioBeforeFrame) < 0.001,
      `t=${ev("media.currentTime")}`);

    sendKey(win.document.body, { code: "ArrowRight", shiftKey: true });
    const afterPlus30 = ev("media.currentTime");
    sendKey(win.document.body, { code: "ArrowLeft", shiftKey: true });
    const afterMinus30 = ev("media.currentTime");
    check("atajos: Mayús+→ y Mayús+← saltan ±30 s",
      Math.abs(afterPlus30 - 35) < 0.2 && Math.abs(afterMinus30 - 5) < 0.2,
      `+30=${afterPlus30} -30=${afterMinus30}`);

    // 2. Sin pictureInPictureEnabled: botones ocultos e I no actúa ni en video.
    win.loadTrack(1, true, "all");
    await until(() => ev("media.videoWidth > 0 && media.currentTime > 0.3"), 4000);
    pipEnabled = false;
    ev("syncPipButtons()");
    check("PiP: sin document.pictureInPictureEnabled ambos botones permanecen ocultos",
      ev("els['pip-btn'].classList.contains('oculto') && els['fs-pip'].classList.contains('oculto')"));
    sendKey(win.document.body, { code: "KeyI" });
    check("PiP: sin pictureInPictureEnabled el atajo I no llama requestPictureInPicture", pipReqTargets.length === 0);

    // 3. Con pictureInPictureEnabled en video: botones visibles, I entra sobre el deck activo, audio sigue por EQ.
    pipEnabled = true;
    ev("syncPipButtons()");
    check("PiP: con pictureInPictureEnabled en video ambos botones están visibles",
      ev("!els['pip-btn'].classList.contains('oculto') && !els['fs-pip'].classList.contains('oculto')"));

    // Exclusiones de foco: inputs (texto y range), select, textarea, dialog y modificadores (Ctrl+Mayús+I, Ctrl+R, F11).
    sendKey(ev("els.filter"), { code: "KeyI" });
    sendKey(ev("els.seek"), { code: "KeyI" });
    sendKey(ev("els.view"), { code: "KeyI" });
    sendKey(ev("els['edit-title']"), { code: "KeyI" });
    sendKey(win.document.body, { code: "KeyI", ctrlKey: true, shiftKey: true });
    check("PiP: I no actúa con foco en inputs/select/dialog ni con Ctrl+Mayús+I", pipReqTargets.length === 0);

    const repeatBefore = ev("state.repeat");
    sendKey(win.document.body, { code: "KeyR", ctrlKey: true });
    const f11Ev = sendKey(win.document.body, { code: "F11" });
    check("atajos: Ctrl+R y F11 no chocan con los atajos del reproductor",
      ev("state.repeat") === repeatBefore && !f11Ev.defaultPrevented);

    const deckBefore = ev("media");
    sendKey(win.document.body, { code: "KeyI" });
    check("PiP: I llama requestPictureInPicture sobre el deck activo y marca botones activos",
      pipReqTargets.length === 1 && pipReqTargets[0] === deckBefore && ev("isPipActive()")
      && ev("els['pip-btn'].getAttribute('aria-pressed') === 'true' && els['fs-pip'].getAttribute('aria-pressed') === 'true'"),
      `reqs=${pipReqTargets.length}`);
    check("PiP: el audio sigue pasando por el grafo del ecualizador",
      ev("!!analyser && eqFilters.length === 10 && analyser.context.state === 'running'"));

    // 4. Cambiar de video sin fundido mantiene el mismo deck y conserva el PiP.
    win.loadTrack(2, true, "all");
    await until(() => ev("media.videoWidth > 0 && media.currentTime > 0.2"), 4000);
    check("PiP: al cambiar de pista de video sin fundido se reutiliza el deck y el PiP sigue activo",
      ev("media") === deckBefore && pipExitCalls === 0 && pipEl === deckBefore && ev("isPipActive()"),
      `exits=${pipExitCalls}`);

    // 5. Botón #fs-pip en la barra de pantalla completa sale y vuelve a entrar.
    ev("els['fs-pip'].click()");
    check("PiP: pulsar #fs-pip sale del PiP y actualiza aria-pressed",
      pipExitCalls === 1 && !pipEl && ev("els['pip-btn'].getAttribute('aria-pressed') === 'false' && els['fs-pip'].getAttribute('aria-pressed') === 'false'"));
    ev("els['fs-pip'].click()");
    check("PiP: volver a pulsar #fs-pip reactiva PiP sobre el deck activo",
      pipReqTargets.length === 2 && pipEl === ev("media") && ev("isPipActive()"));

    // 6. Si el deck activo cambia, sale del PiP.
    ev("media = otherDeck(); syncPip();");
    check("PiP: al cambiar el deck activo sale del PiP",
      pipExitCalls === 2 && !pipEl && !ev("isPipActive()"),
      `exits=${pipExitCalls}`);
    ev("media = decks[0]; syncStage(state.tracks[state.index]);");

    // 7. Pasar a pista de audio mientras está en PiP sale del PiP.
    ev("els['pip-btn'].click()");
    check("PiP: botón #pip-btn vuelve a entrar en PiP", pipReqTargets.length === 3 && ev("isPipActive()"));
    win.loadTrack(0, false, "all");
    check("PiP: al cambiar a pista de audio sale del PiP y oculta botones",
      pipExitCalls === 3 && !pipEl && ev("els['pip-btn'].classList.contains('oculto') && els['fs-pip'].classList.contains('oculto')"));

    // 8. Fotograma anterior/siguiente (, / .) y Mayús+←/→ en pista de video.
    win.loadTrack(1, true, "all");
    await until(() => ev("media.videoWidth > 0 && media.currentTime > 0.3"), 4000);
    const playPeriod = sendKey(win.document.body, { code: "Period" });
    check("atajos: , y . no actúan mientras el video está reproduciendo", !playPeriod.defaultPrevented);

    ev("media.pause(); media.currentTime = 0.8;");
    await until(() => ev("Math.abs(media.currentTime - 0.8) < 0.05"), 1500);
    const t0 = ev("media.currentTime");
    sendKey(ev("els.filter"), { code: "Period" });
    sendKey(ev("els.seek"), { code: "Period" });
    sendKey(ev("els.view"), { code: "Comma" });
    sendKey(ev("els['edit-title']"), { code: "Period" });
    sendKey(ev("els.filter"), { code: "ArrowRight", shiftKey: true });
    sendKey(ev("els.seek"), { code: "ArrowRight", shiftKey: true });
    check("atajos: , / . y Mayús+←/→ no actúan con foco en inputs, select o dialog",
      Math.abs(ev("media.currentTime") - t0) < 0.005,
      `t0=${t0} t=${ev("media.currentTime")}`);

    const dotEv = sendKey(win.document.body, { code: "Period" });
    const tNext = ev("media.currentTime");
    const commaEv = sendKey(win.document.body, { code: "Comma" });
    const tPrev = ev("media.currentTime");
    check("atajos: . avanza y , retrocede un fotograma (1/30 s) en video en pausa",
      dotEv.defaultPrevented && commaEv.defaultPrevented
      && Math.abs(tNext - (t0 + 1 / 30)) < 0.015 && Math.abs(tPrev - t0) < 0.015,
      `t0=${t0} next=${tNext} prev=${tPrev}`);

    const shiftRightEv = sendKey(win.document.body, { code: "ArrowRight", shiftKey: true });
    const tAfterJump = ev("media.currentTime");
    const shiftLeftEv = sendKey(win.document.body, { code: "ArrowLeft", shiftKey: true });
    const tAfterBack = ev("media.currentTime");
    check("atajos: Mayús+→ y Mayús+← actúan en pista de video",
      shiftRightEv.defaultPrevented && shiftLeftEv.defaultPrevented && tAfterJump > t0 && tAfterBack === 0,
      `t0=${t0} jump=${tAfterJump} back=${tAfterBack}`);

    ev("media.pause()");
  });

  await scenario("Versión web: tope de 2 GB, persist() y avisos", async ({ frame, win, ev }) => {
    delete win.reproductor;
    check("web 2 GB: window.reproductor está ausente", !("reproductor" in win));

    if (!win.navigator.storage) {
      Object.defineProperty(win.navigator, "storage", { configurable: true, value: {} });
    }

    const TWO_GB = 2 * 1024 * 1024 * 1024;
    const baseVideo = await makeWebm(win, "base-2gb.webm", { withVideo: true, seconds: 1.8, mtime: 600 });
    const fakeSizeVideo = (name, size, mtime, type = "video/webm", content = baseVideo) => {
      const f = new win.File([content], name, { type, lastModified: mtime });
      Object.defineProperty(f, "size", { configurable: true, get: () => size });
      f.__fullReads = 0;
      f.__slicedBytes = 0;
      const realSlice = f.slice.bind(f);
      f.slice = (start = 0, end = size, ct = "") => {
        const a = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
        const b = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
        f.__slicedBytes += Math.max(0, b - a);
        return realSlice(start, end, ct);
      };
      if (size > TWO_GB) {
        f.arrayBuffer = () => {
          f.__fullReads++;
          return win.Promise.reject(new win.Error("no debe leerse el archivo entero de > 2 GB"));
        };
      }
      return f;
    };

    // 1. persist() ausente, que lanza síncronamente, que rechaza asíncronamente y que queda pendiente (sin bloquear).
    let persistCalls = 0;
    let persistImpl = () => win.Promise.resolve(true);
    const installPersist = () => {
      Object.defineProperty(win.navigator.storage, "persist", {
        configurable: true,
        value: () => { persistCalls++; return persistImpl(); },
      });
    };

    // 1a. Importar solo audio no pide navigator.storage.persist().
    installPersist();
    await win.addFiles([wav(win, "solo-audio-web.wav", { seconds: 2, mtime: 601 })]);
    check("web 2 GB: importar audio no pide navigator.storage.persist()",
      persistCalls === 0 && ev("state.tracks.length === 1 && state.tracks[0].source === 'blob'"),
      `persistCalls=${persistCalls}`);

    // 1b. persist() ausente: la importación de video sigue igual.
    Object.defineProperty(win.navigator.storage, "persist", { configurable: true, value: undefined });
    ev("videoPersistRequested = false");
    await win.addFiles([fakeSizeVideo("sin-persist.webm", 1024, 602)]);
    check("web 2 GB: si navigator.storage.persist() no existe, la importación de video sigue igual",
      ev("videoPersistRequested === true && state.tracks.find(t => t.fileName === 'sin-persist.webm')?.source === 'blob'"),
      ev("state.tracks.find(t => t.fileName === 'sin-persist.webm')?.source"));

    // 1c. persist() que lanza síncronamente: se captura y no interrumpe la importación.
    installPersist();
    persistImpl = () => { throw new win.Error("fallo síncrono en persist"); };
    ev("videoPersistRequested = false");
    await win.addFiles([fakeSizeVideo("persist-lanza.webm", 1025, 603)]);
    check("web 2 GB: si navigator.storage.persist() lanza síncronamente, se captura y el video se guarda",
      persistCalls === 1 && ev("state.tracks.find(t => t.fileName === 'persist-lanza.webm')?.source === 'blob'"),
      `persistCalls=${persistCalls}`);

    // 1d. persist() que rechaza asíncronamente: se captura sin unhandledrejection y no interrumpe la importación.
    let unhandledRejections = 0;
    const onUnhandled = () => { unhandledRejections++; };
    win.addEventListener("unhandledrejection", onUnhandled);
    persistImpl = () => win.Promise.reject(new win.Error("permiso persist denegado"));
    ev("videoPersistRequested = false");
    await win.addFiles([fakeSizeVideo("persist-rechaza.webm", 1026, 604)]);
    win.removeEventListener("unhandledrejection", onUnhandled);
    check("web 2 GB: si navigator.storage.persist() rechaza, se captura sin unhandledrejection y el video se guarda",
      persistCalls === 2 && unhandledRejections === 0
      && ev("state.tracks.find(t => t.fileName === 'persist-rechaza.webm')?.source === 'blob'"),
      `persistCalls=${persistCalls} unhandled=${unhandledRejections}`);

    // 2. Video de 2 GB exactos con persist() que queda pendiente (nunca resuelve): no bloquea la importación,
    // se pide una sola vez y el video se copia a IndexedDB.
    persistCalls = 0;
    persistImpl = () => new win.Promise(() => {});
    ev("videoPersistRequested = false");
    const exact2Gb = fakeSizeVideo("exacto-2gb.webm", TWO_GB, 605);
    await win.addFiles([exact2Gb]);
    check("web 2 GB: una promesa pendiente de navigator.storage.persist() no bloquea la importación",
      persistCalls === 1 && ev("state.tracks.some(t => t.fileName === 'exacto-2gb.webm')"),
      `persistCalls=${persistCalls}`);

    const db1 = await openDbAsIs();
    const [tracks1, files1] = [await getAll(db1, "tracks"), await getAll(db1, "files")];
    db1.close();
    const recExact = tracks1.find((r) => r.name === "exacto-2gb.webm");
    const fileExact = files1.find((f) => f.id === recExact?.id);
    check("web 2 GB: video de 2 GB exactos se copia a IndexedDB (source «blob»)",
      recExact?.source === "blob" && recExact?.size === TWO_GB && recExact?.kind === "video"
      && fileExact?.blob instanceof Blob
      && ev("state.tracks.find(t => t.fileName === 'exacto-2gb.webm')?.source === 'blob' && state.tracks.find(t => t.fileName === 'exacto-2gb.webm')?.id != null"),
      JSON.stringify({ recExact, hasFile: !!fileExact }));

    // 3. Video de 2 GB + 1 byte: no lee el archivo entero, no se copia a IndexedDB, queda de sesión con aviso
    // que recomienda la app de escritorio, no vuelve a pedir persist(), y se reproduce igual en la sesión.
    const over2Gb = fakeSizeVideo("mayor-2gb.webm", TWO_GB + 1, 606);
    await win.addFiles([over2Gb]);
    const toastOver = ev("els.toast.textContent");
    const db2 = await openDbAsIs();
    const [tracks2, files2] = [await getAll(db2, "tracks"), await getAll(db2, "files")];
    db2.close();
    const trackOver = ev("(() => { const t = state.tracks.find(x => x.fileName === 'mayor-2gb.webm'); return t ? { id: t.id, source: t.source, size: t.size, kind: t.meta?.kind } : null; })()");
    check("web 2 GB: video de 2 GB + 1 byte no se copia a IndexedDB y queda con source «session»",
      !tracks2.some((r) => r.name === "mayor-2gb.webm") && files2.length === files1.length
      && trackOver?.id === null && trackOver?.source === "session" && trackOver?.size === TWO_GB + 1 && trackOver?.kind === "video",
      JSON.stringify({ inDb: tracks2.map((r) => r.name), filesCount: files2.length, trackOver }));
    check("web 2 GB: video de más de 2 GB no lee el archivo entero (solo cabeceras acotadas)",
      over2Gb.__fullReads === 0 && over2Gb.__slicedBytes > 0 && over2Gb.__slicedBytes <= 256 * 1024 + 64,
      `fullReads=${over2Gb.__fullReads} slicedBytes=${over2Gb.__slicedBytes}`);
    check("web 2 GB: muestra aviso visible que recomienda la app de escritorio",
      !ev("els.toast.hidden") && /2 GB/i.test(toastOver) && /solo para esta sesión/i.test(toastOver) && /app de escritorio/i.test(toastOver),
      toastOver);

    // Un segundo video ≤ 2 GB tampoco vuelve a pedir persist().
    await win.addFiles([fakeSizeVideo("segundo-video.webm", 1024, 607)]);
    check("web 2 GB: navigator.storage.persist() se pide una sola vez",
      persistCalls === 1,
      `persistCalls=${persistCalls}`);

    // El video de > 2 GB se reproduce normalmente en la sesión.
    const overIdx = ev("state.tracks.findIndex(t => t.fileName === 'mayor-2gb.webm')");
    win.loadTrack(overIdx, true, "all");
    check("web 2 GB: el video de más de 2 GB se reproduce en la sesión",
      await until(() => ev("!media.paused && media.videoWidth > 0 && media.currentTime > 0.2"), 4000),
      `paused=${ev("media.paused")} width=${ev("media.videoWidth")} t=${ev("media.currentTime")}`);
    ev("media.pause()");

    // 4. Archivos de > 2 GB que parecen video por extensión o por MIME aunque la detección por contenido falle
    // tampoco se copian a IndexedDB; un archivo que la detección confirma como solo audio sigue como audio.
    const corruptBytes = new Uint8Array(64).fill(0x55);
    const overFailedExt = fakeSizeVideo("fallo-ext-2gb.mp4", TWO_GB + 10, 608, "", corruptBytes);
    const overFailedMime = fakeSizeVideo("fallo-mime-2gb.bin", TWO_GB + 20, 609, "video/mp4", corruptBytes);
    const overFailedSlice = fakeSizeVideo("fallo-lectura-2gb.mkv", TWO_GB + 30, 610, "application/octet-stream", corruptBytes);
    overFailedSlice.slice = () => ({ arrayBuffer: () => win.Promise.reject(new win.Error("cabecera ilegible")) });
    const confirmedAudioWebm = await makeWebm(win, "confirmado-solo-audio.webm", { withVideo: false, seconds: 1.2, mtime: 611 });

    const dbBeforeFailed = await openDbAsIs();
    const filesCountBeforeFailed = (await getAll(dbBeforeFailed, "files")).length;
    dbBeforeFailed.close();

    await win.addFiles([overFailedExt, overFailedMime, overFailedSlice, confirmedAudioWebm]);
    const toastFailed = ev("els.toast.textContent");
    const dbAfterFailed = await openDbAsIs();
    const [tracksAfterFailed, filesAfterFailed] = [await getAll(dbAfterFailed, "tracks"), await getAll(dbAfterFailed, "files")];
    dbAfterFailed.close();
    const failedNames = ["fallo-ext-2gb.mp4", "fallo-mime-2gb.bin", "fallo-lectura-2gb.mkv"];
    const failedState = ev(`JSON.stringify(["fallo-ext-2gb.mp4", "fallo-mime-2gb.bin", "fallo-lectura-2gb.mkv"].map(n => {
      const t = state.tracks.find(x => x.fileName === n);
      return t ? { name: t.fileName, id: t.id, source: t.source, kind: t.meta?.kind } : null;
    }))`);
    const parsedFailedState = JSON.parse(failedState);
    check("web 2 GB: archivos > 2 GB que parecen video por MIME o extensión con detección fallida no se copian a IndexedDB",
      parsedFailedState.every((t) => t && t.id === null && t.source === "session" && t.kind === "video")
      && !tracksAfterFailed.some((r) => failedNames.includes(r.name))
      && filesAfterFailed.length === filesCountBeforeFailed + 1
      && overFailedExt.__fullReads === 0 && overFailedMime.__fullReads === 0 && overFailedSlice.__fullReads === 0
      && /3 videos de más de 2 GB solo para esta sesión: usa la app de escritorio/.test(toastFailed),
      `${failedState} | toast=${toastFailed}`);
    check("web 2 GB: un archivo cuya detección por contenido confirma que es solo audio sigue como audio y se guarda",
      ev("state.tracks.find(t => t.fileName === 'confirmado-solo-audio.webm')?.meta?.kind === 'audio' && state.tracks.find(t => t.fileName === 'confirmado-solo-audio.webm')?.source === 'blob'")
      && tracksAfterFailed.some((r) => r.name === "confirmado-solo-audio.webm" && r.kind === "audio" && r.source === "blob"),
      JSON.stringify(tracksAfterFailed.find((r) => r.name === "confirmado-solo-audio.webm")));

    // 5. Mantiene el aviso de cuota (QuotaExceededError) y el resumen de importación cuenta bien ambos casos.
    const realAdd = ev("Storage.add");
    ev("Storage.add = () => Promise.reject(new DOMException('sin espacio', 'QuotaExceededError'))");
    await win.addFiles([
      wav(win, "sin-cuota.wav", { seconds: 1, mtime: 612 }),
      fakeSizeVideo("otro-mayor-2gb.webm", TWO_GB + 50, 613),
    ]);
    const toastBoth = ev("els.toast.textContent");
    win.__realStorageAdd = realAdd;
    ev("Storage.add = window.__realStorageAdd; delete window.__realStorageAdd");
    check("web 2 GB: el resumen de importación cuenta por separado > 2 GB y QuotaExceededError",
      !ev("els.toast.hidden")
      && /2 pista\(s\) añadida\(s\)/.test(toastBoth)
      && /1 video de más de 2 GB solo para esta sesión: usa la app de escritorio/.test(toastBoth)
      && /1 pista solo para esta sesión: no hay espacio/.test(toastBoth),
      toastBoth);

    // 6. launchQueue (consumeLaunch) acepta video/mp4 y video/webm.
    const handle = (f) => ({ getFile: async () => f });
    const launchWebm = fakeSizeVideo("launch.webm", baseVideo.size, 614, "video/webm");
    const launchMp4 = fakeSizeVideo("launch.mp4", baseVideo.size, 615, "video/mp4");
    await win.consumeLaunch({ files: [handle(launchWebm), handle(launchMp4)] });
    check("web 2 GB: launchQueue acepta video/webm y video/mp4, reproduce el primero y encola el segundo",
      (await until(() => ev("!media.paused && state.tracks[state.index]?.fileName === 'launch.webm' && media.currentTime > 0.2"), 4000))
      && ev("state.tracks.some(t => t.fileName === 'launch.mp4') && state.queue.some(t => t.fileName === 'launch.mp4')"),
      ev("state.tracks.map(t => t.fileName).join(',')"));
    ev("media.pause()");

    // 7. Registro en caché con meta.kind "audio" y codecs null, nombre .mp4 y detección no concluyente:
    // tras recargar conserva "audio" y lo guardado en IndexedDB no cambia.
    const cachedAudioMeta = {
      title: "Grabación", artist: "Autor", album: "", lyrics: "", hasCover: false,
      duration: 12, kind: "audio", width: null, height: null, codecs: null,
      year: "", genre: "", description: "", show: "", season: null, episode: null,
      rotation: 0, chapters: [],
    };
    const dbSeed = await openDb();
    await new Promise((res, rej) => {
      const tx = dbSeed.transaction(["tracks", "files"], "readwrite");
      const req = tx.objectStore("tracks").add({
        name: "grabacion.mp4", type: "video/mp4", size: corruptBytes.byteLength, lastModified: 616,
        kind: "audio", source: "blob", metaVersion: 2, meta: cachedAudioMeta,
      });
      req.onsuccess = (e) => {
        tx.objectStore("files").put({
          id: e.target.result,
          blob: new File([corruptBytes], "grabacion.mp4", { type: "video/mp4", lastModified: 616 }),
        });
      };
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    dbSeed.close();

    const loaded = new Promise((r) => frame.addEventListener("load", () => {
      frame.contentWindow.eval('const __realMp4Probe = MP4.probe; MP4.probe = async (f) => (f?.name === "grabacion.mp4" ? { kind: undefined, codecs: null } : __realMp4Probe(f));');
      r();
    }, { once: true }));
    frame.contentWindow.location.reload();
    await loaded;
    await waitReady(frame.contentWindow);
    await sleep(150);
    const e2 = (c) => frame.contentWindow.eval(c);
    const dbAfterReload = await openDbAsIs();
    const recAfterReload = (await getAll(dbAfterReload, "tracks")).find((r) => r.name === "grabacion.mp4");
    dbAfterReload.close();
    check("web 2 GB: registro con meta.kind «audio» y codecs null (.mp4 con detección no concluyente) sigue «audio» tras recargar y lo guardado no cambia",
      e2("state.tracks.find(t => t.fileName === 'grabacion.mp4')?.meta?.kind === 'audio'")
      && recAfterReload?.kind === "audio"
      && recAfterReload?.meta?.kind === "audio"
      && recAfterReload?.meta?.codecs === null,
      JSON.stringify({ memKind: e2("state.tracks.find(t => t.fileName === 'grabacion.mp4')?.meta?.kind"), recMeta: recAfterReload?.meta }));
  });

  await scenario("Editor con video", async ({ frame, win, ev }) => {
    // 1. Preparar pistas: un video, un MP3 sintético y un WAV
    const video = await makeWebm(win, "clip-editor.webm", { withVideo: true, seconds: 1.8, mtime: 601 });
    const mp3 = fakeMp3(win, "audio-editor.mp3", "Título MP3 Original");
    const audioWav = wav(win, "audio-editor.wav", { mtime: 602 });
    await win.addFiles([video, mp3, audioWav]);

    // Esperar a que la miniatura del video esté lista
    await until(() => ev("state.tracks[0]?.thumb instanceof Blob && state.tracks[0].thumb.size > 0"), 8000);
    const initialThumb = ev("state.tracks[0].thumb");

    // 2. Editar un video individual: botón de descarga oculto, textos adaptados
    win.openEditor(ev("state.tracks[0]"));
    check("editor video: botón de descargar copia oculto para video", ev("els['edit-download'].hidden === true"));
    check("editor video: texto adaptado a «Quitar miniatura»", ev("els['edit-cover-clear'].textContent") === "Quitar miniatura");
    check("editor video: muestra miniatura en el recuadro", ev("els['edit-cover'].classList.contains('has-art') && els['edit-cover'].style.backgroundImage.includes('blob:')"));

    // Editar título, artista y álbum
    ev("els['edit-title'].value = 'Video Editado'; els['edit-title'].dispatchEvent(new Event('input'))");
    ev("els['edit-artist'].value = 'Director Uno'; els['edit-artist'].dispatchEvent(new Event('input'))");
    ev("els['edit-album'].value = 'Temporada 1'; els['edit-album'].dispatchEvent(new Event('input'))");

    // Quitar miniatura: debe vaciar la carátula sin perder tracks.thumb
    ev("els['edit-cover-clear'].click()");
    check("editor video: quitar miniatura quita la imagen de muestra y pone icono de video",
      !ev("els['edit-cover'].classList.contains('has-art')") && ev("els['edit-cover'].style.backgroundImage") === "" && ev("els['edit-cover'].querySelector('span').textContent") === "▶");

    // Guardar
    ev("els['edit-form'].requestSubmit()");
    check("editor video: guardar actualiza título, artista y álbum en state",
      ev("state.tracks[0].title") === "Video Editado" && ev("state.tracks[0].artist") === "Director Uno" && ev("state.tracks[0].album") === "Temporada 1");
    check("editor video: quitar miniatura deja coverUrl en null pero conserva tracks.thumb",
      ev("state.tracks[0].coverUrl") === null && ev("state.tracks[0].thumb") === initialThumb);

    // Lista y reproductor muestran el resultado (sin carátula)
    win.loadTrack(0, false, "all");
    check("editor video: reproductor muestra título y carátula vacía tras quitar miniatura",
      ev("els.title.textContent") === "Video Editado" && !ev("els.cover.classList.contains('has-art')"));
    const listThumb = ev("els.playlist.querySelectorAll('li:not(.empty)')[0]?.querySelector('.thumb')");
    check("editor video: lista no muestra imagen de fondo en la miniatura cuando coverUrl es null",
      listThumb && !listThumb.style.backgroundImage);

    // Cambiar carátula por una imagen nueva
    win.openEditor(ev("state.tracks[0]"));
    const customImg = new win.Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
    win.setDraftCover(customImg);
    check("editor video: poner imagen propia activa muestra con has-art",
      ev("els['edit-cover'].classList.contains('has-art') && els['edit-cover'].style.backgroundImage.includes('blob:')"));
    ev("els['edit-form'].requestSubmit()");

    check("editor video: carátula personalizada se refleja en reproductor y conserva tracks.thumb original",
      ev("state.tracks[0].coverUrl !== null && els.cover.classList.contains('has-art')") && ev("state.tracks[0].thumb") === initialThumb);

    // Esperar a que se escriba en IndexedDB antes de recargar
    await until(async () => {
      const db = await openDbAsIs();
      const rec = (await getAll(db, "tracks")).find((r) => r.name === "clip-editor.webm");
      db.close();
      return rec?.edits?.title === "Video Editado";
    }, 4000);

    // Persistencia tras recargar
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    frame.contentWindow.location.reload();
    await loaded;
    await waitReady(frame.contentWindow);
    const w2 = frame.contentWindow;
    const e2 = (c) => w2.eval(c);

    const t0 = e2("state.tracks.find(t => t.fileName === 'clip-editor.webm')");
    check("editor video: persistencia tras recargar (título, artista, álbum y carátula)",
      t0?.title === "Video Editado" && t0?.artist === "Director Uno"
      && t0?.album === "Temporada 1" && !!t0?.coverUrl);
    check("editor video: tracks.thumb persiste como Blob tras recargar",
      t0?.thumb instanceof w2.Blob && t0?.thumb.size > 0);

    // Restaurar original devuelve la miniatura capturada
    w2.openEditor(t0);
    e2("els['edit-reset'].click()");
    check("editor video: restaurar original recupera la miniatura generada en el editor",
      e2("els['edit-cover'].classList.contains('has-art') && els['edit-cover'].style.backgroundImage.includes('blob:')")
      && e2("els['edit-title'].value") === "clip-editor");
    e2("els['edit-form'].requestSubmit()");
    check("editor video: guardar tras restaurar original restablece coverUrl a thumbUrl",
      t0.coverUrl === t0.thumbUrl && t0.title === "clip-editor");

    // 3. Edición múltiple mezclada (audio MP3 + video)
    const vTrack = e2("state.tracks.find(t => t.fileName === 'clip-editor.webm')");
    const mp3Track = e2("state.tracks.find(t => t.fileName === 'audio-editor.mp3')");
    w2.openEditor([vTrack, mp3Track]);
    await until(() => !e2("els['edit-download'].hidden"), 3000);
    check("edición múltiple mezclada: botón de descargar copia visible si hay algún audio MP3/FLAC",
      e2("els['edit-download'].hidden === false"));
    check("edición múltiple mezclada: texto «Editar 2 pistas» y «Quitar carátula o miniatura»",
      e2("els['edit-heading'].textContent") === "Editar 2 pistas" && e2("els['edit-cover-clear'].textContent") === "Quitar carátula o miniatura");

    // Modificar campo en lote
    e2("els['edit-album'].value = 'Álbum Mixto'; els['edit-album'].dispatchEvent(new Event('input', { bubbles: true }))");
    const gotMixed = captureDownloads(w2);
    await e2("downloadCopies(saveEditor())");

    check("edición múltiple mezclada: ambos cambiaron el álbum en lote",
      vTrack.album === "Álbum Mixto" && mp3Track.album === "Álbum Mixto");
    check("edición múltiple mezclada: descarga copia del MP3 y salta el video sin error",
      gotMixed.length === 1 && gotMixed[0].name === "audio-editor (editado).mp3",
      `descargas=${gotMixed.length} nombres=${gotMixed.map((d) => d.name).join(",")}`);
    check("edición múltiple mezclada: aviso toast indica copia descargada y video sin formato",
      e2("els.toast.textContent").includes("copia(s) descargada(s)") && e2("els.toast.textContent").includes("no son MP3/FLAC"),
      e2("els.toast.textContent"));

    // 4. Video enlazado sin file (y pistas no disponibles)
    const linkedTrack = await w2.makeUnavailableTrack({
      id: 9999,
      name: "enlazado-remoto.mp4",
      source: "link",
      linkId: "c".repeat(32),
      meta: { kind: "video", title: "Enlazado Remoto" },
      thumb: new w2.Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    });
    e2("state.tracks").push(linkedTrack);

    let openedWithoutError = false;
    try {
      w2.openEditor(linkedTrack);
      openedWithoutError = true;
    } catch {
      openedWithoutError = false;
    }
    check("video enlazado sin file: el editor abre sin error y no lee t.file", openedWithoutError);
    check("video enlazado sin file: botón de descargar copia oculto", e2("els['edit-download'].hidden === true"));
    check("video enlazado sin file: botón Quitar miniatura adaptado", e2("els['edit-cover-clear'].textContent") === "Quitar miniatura");

    e2("els['edit-title'].value = 'Enlazado Renombrado'; els['edit-title'].dispatchEvent(new Event('input'))");
    e2("els['edit-form'].requestSubmit()");
    check("video enlazado sin file: guarda título sin romper", linkedTrack.title === "Enlazado Renombrado" && linkedTrack.edits?.title === "Enlazado Renombrado");

    const dlLinked = await w2.downloadEditedCopy(linkedTrack);
    check("video enlazado sin file: downloadEditedCopy devuelve sin-formato sin leer t.file", dlLinked === "sin-formato");
    e2("state.tracks.pop()"); // limpiar

    // 5. Audio sin cambios
    // Single MP3: botón visible
    w2.openEditor(mp3Track);
    await until(() => !e2("els['edit-download'].hidden"), 3000);
    check("audio sin cambios: MP3 tiene botón de descarga visible", e2("els['edit-download'].hidden === false"));
    check("audio sin cambios: texto es «Quitar carátula» e icono «♪»",
      e2("els['edit-cover-clear'].textContent") === "Quitar carátula" && e2("els['edit-cover'].querySelector('span').textContent") === "♪");
    e2("els['edit-cancel'].click()");

    // Single WAV: botón oculto
    const wavTrack = e2("state.tracks.find(t => t.fileName === 'audio-editor.wav')");
    w2.openEditor(wavTrack);
    check("audio sin cambios: WAV tiene botón de descarga oculto (solo MP3/FLAC)", e2("els['edit-download'].hidden === true"));
    const cancelClosed = new Promise((r) => e2("els['edit-dialog']").addEventListener("close", r, { once: true }));
    e2("els['edit-cancel'].click()");
    await cancelClosed;

    // 6. Guardar y reabrir de inmediato: el evento «close» atrasado no debe limpiar la sesión nueva ni fugar previewUrl
    const revokedInReopen = [];
    const realRevokeReopen = w2.URL.revokeObjectURL.bind(w2.URL);
    w2.URL.revokeObjectURL = (u) => { revokedInReopen.push(u); return realRevokeReopen(u); };
    try {
      w2.openEditor(vTrack);
      w2.setDraftCover(new w2.Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }));
      const firstPreviewUrl = e2("editing?.previewUrl");
      e2("els['edit-title'].value = 'Antes de reabrir'; els['edit-title'].dispatchEvent(new Event('input'))");
      const lateClose = new Promise((r) => e2("els['edit-dialog']").addEventListener("close", r, { once: true }));
      e2("els['edit-form'].requestSubmit()");
      w2.openEditor(vTrack);
      const secondPreviewUrl = e2("editing?.previewUrl");
      await lateClose;
      check("reabrir inmediato: revoca previewUrl anterior y el evento close atrasado mantiene vivo el editor",
        !!firstPreviewUrl && revokedInReopen.includes(firstPreviewUrl)
        && !!secondPreviewUrl && !revokedInReopen.includes(secondPreviewUrl)
        && e2("els['edit-dialog'].open && editing !== null && editing.tracks[0] === state.tracks[0]"));
      e2("els['edit-title'].value = 'Guardado tras close'; els['edit-title'].dispatchEvent(new Event('input'))");
      e2("els['edit-form'].requestSubmit()");
      check("reabrir inmediato: tras pasar el evento close el editor sigue guardando cambios",
        vTrack.title === "Guardado tras close");
    } finally {
      w2.URL.revokeObjectURL = realRevokeReopen;
    }
  });

  /* ---------- Resultado ---------- */
  const fails = results.filter((r) => !r.ok);
  document.getElementById("summary").textContent = fails.length ? `${fails.length} FALLO(S) de ${results.length}` : `Todo correcto: ${results.length} comprobaciones`;
  document.getElementById("summary").className = fails.length ? "fail" : "ok";
  document.getElementById("results").innerHTML = results.map((r) => `<li class="${r.ok ? "ok" : "fail"}">${r.ok ? "✔" : "✖"} ${r.name}${r.detail ? ` <small>— ${r.detail.replace(/</g, "&lt;")}</small>` : ""}</li>`).join("");
  document.title = (fails.length ? "FALLOS " + fails.length : "OK") + " · pruebas de humo";
  window.__results = results;
  window.__done = true;
})();
