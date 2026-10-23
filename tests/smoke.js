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

/* ---------- Marco de pruebas ---------- */

// Se vacía el almacén en vez de borrar la base: borrarla se queda bloqueada si otra pestaña la tiene abierta.
const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open("reproductor-mp3", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function resetStorage() {
  localStorage.clear();
  const db = await openDb();
  await new Promise((resolve) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").clear();
    tx.oncomplete = tx.onerror = resolve;
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
    .replace("<head>", '<head><base href="../">');
  const frame = document.createElement("iframe");
  frame.srcdoc = html;
  document.body.append(frame);
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  const win = frame.contentWindow;
  const ready = await waitReady(win);
  win.prompt = () => "Mi lista";
  win.confirm = () => true;
  return { frame, win, ready, ev: (code) => win.eval(code) };
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
  await until(() => Number.isFinite(ev("audio.duration")) && ev("audio.duration") > 0);
  ev(`audio.currentTime = audio.duration - ${secondsLeft}`);
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
    check("reproducir: el tiempo avanza", await until(() => ev("audio.currentTime") > 0.4), ev("audio.currentTime"));
    check("reproducir: el icono pasa a pausa", ev("els['play-icon'].innerHTML").includes("M6 5h4"));
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
    const wasPaused = ev("audio.paused");
    space(win.document.body);
    check("atajo Espacio: alterna la reproducción", ev("audio.paused") !== wasPaused, `pausado antes=${wasPaused}`);
    space(win.document.body);
    await until(() => !ev("audio.paused"));
    const before = ev("audio.paused");
    space(ev("els.clear"));
    check("Espacio sobre un botón no dispara el atajo global", ev("audio.paused") === before, "se alternó la reproducción");

    // última pista sin repetir: se detiene; con repetir vuelve a la primera
    await seekNearEnd(ev, 0.4);
    await sleep(1200);
    check("última canción sin repetir: se detiene", ev("audio.paused") && ev("state.index") === 2, `paused=${ev("audio.paused")} idx=${ev("state.index")}`);
    ev("els.repeat.click()");
    win.loadTrack(2, true, "all");
    await seekNearEnd(ev, 0.4);
    check("repetir: vuelve a la primera", await until(() => ev("state.index") === 0, 3000), ev("state.index"));
    ev("els.repeat.click()");
  });

  await scenario("Listas, exportar e importar", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { mtime: 1 }), wav(win, "b.wav", { freq: 550, mtime: 2 }), wav(win, "c.wav", { freq: 660, mtime: 3 })]);
    const p = win.createPlaylist();
    check("crear lista", p && ev("state.playlists.length") === 1);
    win.togglePlaylistMember(p, ev("state.tracks[2]"));
    win.togglePlaylistMember(p, ev("state.tracks[0]"));
    win.setView(p.id);
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
    ev("audio.currentTime = 2.3");
    await until(() => ev("document.querySelector('.lyric-line.active')?.textContent") === "Dos", 2500);
    check("la línea actual se resalta", ev("document.querySelector('.lyric-line.active')?.textContent") === "Dos", ev("document.querySelector('.lyric-line.active')?.textContent"));
    ev("document.querySelectorAll('.lyric-line')[2].click()");
    check("pulsar una línea salta a ese momento", ev("audio.currentTime") >= 3.9, ev("audio.currentTime"));
    ev("audio.pause()");
  });

  await scenario("Velocidad, temporizador y fundido", async ({ win, ev }) => {
    await win.addFiles([wav(win, "a.wav", { seconds: 8, mtime: 1 }), wav(win, "b.wav", { seconds: 8, freq: 550, mtime: 2 }), wav(win, "c.wav", { seconds: 8, freq: 660, mtime: 3 })]);
    win.setSpeed(1.5);
    win.loadTrack(1, false, "all");
    check("velocidad: se conserva al cambiar de pista", ev("audio.playbackRate") === 1.5 && ev("localStorage.getItem('speed')") === "1.5",
      `playbackRate=${ev("audio.playbackRate")} guardado=${ev("localStorage.getItem('speed')")} estado=${ev("state.speed")}`);
    win.setSpeed(1);

    win.loadTrack(0, true, "all");
    await until(() => ev("audio.currentTime") > 0.3);
    ev("setSleep(0.05)"); // 3 s
    check("temporizador: muestra la cuenta atrás", /⏲ 0:0\d/.test(ev("els['sleep-btn'].textContent")), ev("els['sleep-btn'].textContent"));
    await sleep(4000);
    check("temporizador: detiene la música y restaura el volumen", ev("audio.paused") && ev("audio.volume") === +ev("els.volume.value"), `paused=${ev("audio.paused")} vol=${ev("audio.volume")}`);

    win.setCrossfade(2);
    const first = ev("audio");
    win.loadTrack(0, true, "all");
    await until(() => ev("audio.currentTime") > 0.3);
    await seekNearEnd(ev, 3.3);
    check("fundido: empieza al acercarse al final", await until(() => ev("xfade !== null"), 3500));
    check("fundido: la canción nueva pasa a ser la activa (otro deck)", ev("audio") !== first && ev("state.index") === 1, ev("state.index"));
    await until(() => ev("xfade === null"), 4000);
    check("fundido: al terminar, el deck anterior queda pausado y ambos con ganancia 1", ev("otherDeck().paused") && ev("decks.every(d => d._gain.gain.value === 1)"));
    win.setCrossfade(0);
    ev("audio.pause()");
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

  await scenario("Robustez: un registro dañado no impide cargar el resto", async ({ ev }) => {
    check("se carga la canción buena aunque haya un registro sin archivo", ev("state.tracks.length") === 1 && ev("state.tracks[0].fileName") === "bueno.wav", ev("state.tracks.map(t => t.fileName).join(',')"));
  }, async () => {
    const db = await openDb();
    await new Promise((res) => {
      const tx = db.transaction("tracks", "readwrite");
      const s = tx.objectStore("tracks");
      s.add({ name: "roto.mp3", type: "audio/mpeg" }); // sin blob
      s.add({ name: "bueno.wav", blob: new File([wavBytes({ seconds: 1 })], "bueno.wav", { type: "audio/wav" }), type: "audio/wav" });
      tx.oncomplete = res;
    });
    db.close();
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
