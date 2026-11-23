// Punto de entrada: conecta todas las piezas y carga la biblioteca guardada.
// Los demás archivos solo declaran; el cableado de eventos se hace aquí, al final, cuando todo existe.

// Atajos de teclado.
function wireShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("dialog")) return;
    const typing = e.target.tagName === "INPUT" && e.target.type !== "range";
    if (typing) return;
    if (e.code === "Space" && e.target.closest?.("button, select, a, summary")) return; // activa el control enfocado
    switch (e.code) {
      case "Space": e.preventDefault(); togglePlay(); break;
      case "ArrowRight": media.currentTime += 5; break;
      case "ArrowLeft": media.currentTime -= 5; break;
      case "ArrowUp": e.preventDefault(); els.volume.value = Math.min(1, +els.volume.value + 0.05); els.volume.dispatchEvent(new Event("input")); break;
      case "ArrowDown": e.preventDefault(); els.volume.value = Math.max(0, +els.volume.value - 0.05); els.volume.dispatchEvent(new Event("input")); break;
      case "KeyN": step(1); break;
      case "KeyP": els.prev.click(); break;
      case "KeyS": els.shuffle.click(); break;
      case "KeyR": els.repeat.click(); break;
      case "KeyM": els.mute.click(); break;
      case "KeyL": toggleLyrics(); break;
      case "BracketLeft": stepSpeed(-1); break;
      case "BracketRight": stepSpeed(1); break;
    }
  });
}

wireMenu();
wireLibrary();
wireSelection();
wirePlaylists();
wirePlayer();
wireEq();
wireFades();
wireLyrics();
wireEditor();
wireTheme();
wireShortcuts();

// Promesa que se cumple cuando la biblioteca guardada ya está cargada y pintada (la usan las pruebas).
const appReady = (async function init() {
  els.shuffle.setAttribute("aria-pressed", state.shuffle);
  els.repeat.setAttribute("aria-pressed", state.repeat);
  try {
    const saved = await Storage.all();
    const order = [].concat(store.json("order", [])).filter(Number.isFinite);
    const rank = (r) => { const k = order.indexOf(r.id); return k < 0 ? order.length + r.id : k; };
    saved.sort((a, b) => rank(a) - rank(b));
    const linked = []; // pistas enlazadas por la app de escritorio: se conservan aunque aquí aún no se abran
    for (const rec of saved) {
      if (rec.source === "link") { linked.push(rec.id); continue; }
      let file = null;
      if (rec.source !== "session") {
        try { file = await Storage.getFile(rec.id); } catch { /* se muestra como no disponible; el registro no se borra */ }
      }
      if (!file) { state.tracks.push(await makeUnavailableTrack(rec)); continue; }
      try {
        let meta = rec.metaVersion === META_VERSION ? rec.meta : null;
        if (!meta) {
          const parsed = await Tags.read(file);
          meta = trackMeta({ ...parsed, hasCover: !!parsed.cover }, file);
          Storage.setMeta(rec.id, meta, META_VERSION).catch(() => {});
        }
        state.tracks.push(await makeTrack(rec.id, file, rec.lyrics || "", rec.edits || null, meta));
      } catch { /* este archivo no se puede cargar: se omite */ }
    }
    const last = state.tracks.findIndex((t) => String(t.id) === store.get("lastId") && !t.unavailable);
    const firstPlayable = state.tracks.findIndex((t) => !t.unavailable);
    if (firstPlayable >= 0) loadTrack(last >= 0 ? last : firstPlayable, false, "all");
    const ids = new Set([...state.tracks.map((t) => t.id), ...linked]);
    state.playlists.forEach((p) => (p.ids = p.ids.filter((id) => ids.has(id))));
    savePlaylists();
  } catch { /* IndexedDB no disponible */ }
  buildEqUi();
  setSpeed(Number(store.get("speed")) || 1);
  renderCrossfade();
  renderSleep();
  toggleLyrics(store.get("lyrics") !== "1");
  renderViews();
  render();
})();

// Archivos abiertos desde el sistema (solo con la app instalada en Chrome o Edge de escritorio).
if ("launchQueue" in window) window.launchQueue.setConsumer((params) => appReady.then(() => consumeLaunch(params)));

// Archivos que entrega el lanzador local de launcher/ (Abrir con… en Firefox u otros navegadores).
appReady.then(runLauncher);

// En la app de escritorio (window.reproductor) no hace falta y complicaría el protocolo propio.
if ("serviceWorker" in navigator && !window.reproductor && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
