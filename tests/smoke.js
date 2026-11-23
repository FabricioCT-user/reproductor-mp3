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

async function openApp(prepare) {
  await resetStorage();
  if (prepare) await prepare();
  // La página real lleva una CSP sin «unsafe-eval», y estas pruebas necesitan eval para leer sus variables internas:
  // se carga la misma página sin esa etiqueta (la CSP se comprueba aparte, en las pruebas unitarias y en el navegador).
  const html = (await (await fetch("../index.html", { cache: "no-cache" })).text())
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace("<head>", '<head><base href="../">')
    .replace('<script src="src/app/main.js"></script>', '<script>const __tagsRead = Tags.read; window.__tagsReadCount = 0; Tags.read = (...a) => { window.__tagsReadCount++; return __tagsRead(...a); };</script><script src="src/app/main.js"></script>');
  const frame = document.createElement("iframe");
  frame.srcdoc = html;
  document.body.append(frame);
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  const win = frame.contentWindow;
  const ready = await waitReady(win);
  win.confirm = () => true;
  return { frame, win, ready, ev: (code) => win.eval(code) };
}

async function responderDialogo(win, valor) {
  await until(() => win.document.getElementById("prompt-dialog")?.open, 2000, 20);
  if (valor === null) { win.document.getElementById("prompt-cancel").click(); return; }
  win.document.getElementById("prompt-input").value = valor;
  // Enter en el campo = envío implícito del formulario; requestSubmit() es ese mismo camino
  // (un keydown sintético no dispara el envío implícito en ningún navegador).
  win.document.getElementById("prompt-form").requestSubmit();
}

async function scenario(title, fn, prepare) {
  let app;
  document.getElementById("summary").textContent = `Ejecutando: ${title}…`;
  (window.__log ||= []).push(`${new Date().toISOString().slice(11, 19)} ${title}`);
  try {
    app = await openApp(prepare);
    if (!app.ready) { check(`${title}: la aplicación arranca`, false, "no llegó a inicializarse (¿error al cargar?)"); return; }
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

// Salta cerca del final de la pista actual (espera a conocer la duración).
async function seekNearEnd(ev, secondsLeft) {
  await until(() => Number.isFinite(ev("media.duration")) && ev("media.duration") > 0);
  ev(`media.currentTime = media.duration - ${secondsLeft}`);
}

const asText = async (c) => (typeof c === "string" ? c : c.text());
const titles = (ev, expr = "state.tracks") => ev(`${expr}.map(t => t.title).join(",")`);

/* ---------- Escenarios ---------- */

(async function run() {
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

  await scenario("Lanzador local (Abrir con… en Firefox)", async ({ win, ev }) => {
    const bytes = wavBytes({ seconds: 2 });
    const item = { id: "a".repeat(32), name: "externo.wav", type: "audio/wav", mtime: 1700000000.5, size: bytes.length };
    const json = (body, status = 200) => new win.Response(JSON.stringify(body), { status });
    const stub = (items) => async (url) => (url.endsWith("/esperar") ? json(items) : new win.Response(bytes, { status: 200 }));

    check("lanzador: la página recibe el archivo, lo añade y suena", (await win.launcherStep(stub([item]))) === "items" && ev("state.tracks.length") === 1
      && ev("state.tracks[0].fileName") === "externo.wav" && (await until(() => !ev("media.paused") && ev("media.currentTime") > 0.2)), ev("state.tracks.length"));
    check("lanzador: conserva la fecha del archivo (así no se duplica al reabrirlo)", ev("state.tracks[0].key") === `externo.wav|${bytes.length}|1700000000500`, ev("state.tracks[0].key"));
    ev("media.pause()");
    check("lanzador: sin archivos pendientes no hace nada", (await win.launcherStep(stub([]))) === "idle" && ev("state.tracks.length") === 1);
    check("lanzador: reabrir el mismo archivo no lo duplica", (await win.launcherStep(stub([item]))) === "items" && ev("state.tracks.length") === 1);
    check("lanzador: con un servidor sin la cola (404) se desactiva solo", (await win.launcherStep(async () => json({}, 404))) === "unsupported");
    let fallo = false;
    try { await win.launcherStep(async () => json({}, 500)); } catch { fallo = true; }
    check("lanzador: un error del servidor se notifica para reintentar", fallo);
    const roto = { ...item, id: "b".repeat(32), name: "roto.wav" };
    check("lanzador: si un archivo no se puede descargar, se omite sin romper el resto",
      (await win.launcherStep(async (url) => (url.endsWith("/esperar") ? json([roto, item]) : url.includes("b".repeat(32)) ? new win.Response("", { status: 404 }) : new win.Response(bytes)))) === "items" && ev("state.tracks.length") === 1);
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
      const found = (await getAll(db, "tracks")).some((r) => r.name === "cache.wav" && r.metaVersion === 1);
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
    check("importación guarda los campos de meta y metaVersion", rec?.metaVersion === 1 && ["title", "artist", "album", "lyrics", "hasCover", "duration", "kind", "width", "height", "codecs"].every((k) => k in rec.meta), JSON.stringify(rec?.meta));
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
    async function makeWebm(name, { withVideo = true, seconds = 2.6 } = {}) {
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
      return new win.File(chunks, name, { type: mime, lastModified: withVideo ? 101 : 102 });
    }

    const videoFile = await makeWebm("clip.webm", { withVideo: true, seconds: 2.6 });
    const audioWebm = await makeWebm("solo-audio.webm", { withVideo: false, seconds: 1.5 });
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
    win.toggleFullscreen = () => { fullscreenCalls++; };
    const click = () => videoDeck.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    click(); click();
    videoDeck.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    await sleep(350);
    check("escenario: doble clic llama fullscreen sin alternar reproducción", fullscreenCalls === 1 && ev("media.paused"), `llamadas=${fullscreenCalls}, pausado=${ev("media.paused")}`);
    delete win.toggleFullscreen;
    win.eval("play()");

    // 4. Transición video → audio sin fundido
    await seekNearEnd(ev, 0.8);
    check("video: pasa de video a audio al terminar", await until(() => ev("state.index === 2"), 4000), ev("state.index"));
    check("video: video → audio no intenta fundido", xfades === 0 && ev("xfade === null"), `xfades=${xfades}`);
    check("video: al volver a audio se oculta el escenario y vuelve el visualizador",
      await until(() => ev("getComputedStyle($('stage')).display === 'none' && !els.viz.hidden && vizRunning && els['lyrics-toggle'].textContent === 'Letra'"), 2500));

    // 5. .webm solo audio (videoWidth === 0) se reclasifica a audio y se guarda en meta.kind
    win.loadTrack(3, true, "all");
    check("video: .webm sin imagen se reclasifica a audio",
      await until(() => ev("state.tracks[3].meta.kind === 'audio' && getComputedStyle($('stage')).display === 'none' && !els.viz.hidden"), 4000),
      ev("state.tracks[3].meta.kind"));
    const saved = await until(async () => {
      const db = await openDbAsIs();
      const rec = (await getAll(db, "tracks")).find((r) => r.name === "solo-audio.webm");
      db.close();
      return rec?.meta?.kind === "audio";
    }, 3000);
    check("video: la reclasificación a audio se guarda en meta.kind", saved);

    const mediaFilter = ev("els['media-filter']");
    mediaFilter.value = "video";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));
    const videoRows = ev("[...els.playlist.querySelectorAll('li:not(.empty)')]");
    check("biblioteca: filtro Videos muestra solo videos y su icono ▶", videoRows.length === 1
      && videoRows[0].querySelector(".video-mark")?.textContent === "▶"
      && videoRows[0].querySelector(".video-size")?.textContent === `${ev("state.tracks[1].meta.width")}×${ev("state.tracks[1].meta.height")}`,
      `${videoRows.length} filas`);
    mediaFilter.value = "audio";
    mediaFilter.dispatchEvent(new win.Event("change", { bubbles: true }));
    check("biblioteca: filtro Música excluye videos", ev("els.playlist.querySelectorAll('li:not(.empty)').length") === 3);
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

  /* ---------- Resultado ---------- */
  const fails = results.filter((r) => !r.ok);
  document.getElementById("summary").textContent = fails.length ? `${fails.length} FALLO(S) de ${results.length}` : `Todo correcto: ${results.length} comprobaciones`;
  document.getElementById("summary").className = fails.length ? "fail" : "ok";
  document.getElementById("results").innerHTML = results.map((r) => `<li class="${r.ok ? "ok" : "fail"}">${r.ok ? "✔" : "✖"} ${r.name}${r.detail ? ` <small>— ${r.detail.replace(/</g, "&lt;")}</small>` : ""}</li>`).join("");
  document.title = (fails.length ? "FALLOS " + fails.length : "OK") + " · pruebas de humo";
  window.__results = results;
  window.__done = true;
})();
