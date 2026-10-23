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
      case "ArrowRight": audio.currentTime += 5; break;
      case "ArrowLeft": audio.currentTime -= 5; break;
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
    for (const rec of saved) {
      if (!(rec.blob instanceof Blob)) { Storage.remove(rec.id).catch(() => {}); continue; } // registro sin archivo: se descarta
      try { state.tracks.push(await makeTrack(rec.id, rec.blob, rec.lyrics || "", rec.edits || null)); } catch { /* este archivo no se puede cargar: se omite */ }
    }
    const last = state.tracks.findIndex((t) => String(t.id) === store.get("lastId"));
    if (state.tracks.length) loadTrack(last >= 0 ? last : 0, false, "all");
    const ids = new Set(state.tracks.map((t) => t.id));
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

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
