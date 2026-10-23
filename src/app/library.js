// Biblioteca: canciones (con sus ediciones), importación, lista en pantalla, reordenar y selección múltiple.

async function makeTrack(id, file, userLyrics = "", edits = null) {
  const meta = await Tags.read(file);
  const fallback = file.name.replace(/\.[^.]+$/, "");
  const t = {
    id,
    file,                 // el archivo original, para poder generar copias con etiquetas
    fileBase: fallback.toLowerCase(),
    fileName: file.name,
    size: file.size,
    key: fileKey(file),   // para no importar dos veces el mismo archivo
    dir: dirOf(pathOf(file)),
    embeddedLyrics: meta.lyrics,
    userLyrics,
    url: URL.createObjectURL(file),
    // Datos del archivo; lo que se muestra (title, artist, album, coverUrl) sale de aplicar las ediciones encima.
    orig: { title: meta.title || fallback, artist: meta.artist, album: meta.album, coverUrl: meta.cover ? URL.createObjectURL(meta.cover) : null },
    edits,
  };
  applyEdits(t);
  return t;
}

// ediciones: { title?, artist?, album?, cover?: Blob | false (quitar) } — solo los campos que difieren del archivo.
function applyEdits(t) {
  const e = t.edits || {};
  t.title = e.title || t.orig.title;
  t.artist = e.artist ?? t.orig.artist;
  t.album = e.album ?? t.orig.album;
  if (e.cover instanceof Blob) {
    if (t._editCoverBlob !== e.cover) {
      if (t._editCoverUrl) URL.revokeObjectURL(t._editCoverUrl);
      t._editCoverBlob = e.cover;
      t._editCoverUrl = URL.createObjectURL(e.cover);
    }
    t.coverUrl = t._editCoverUrl;
  } else {
    if (t._editCoverUrl) URL.revokeObjectURL(t._editCoverUrl);
    t._editCoverUrl = t._editCoverBlob = null;
    t.coverUrl = e.cover === false ? null : t.orig.coverUrl;
  }
}

const revokeCovers = (t) => [t.orig.coverUrl, t._editCoverUrl].forEach((u) => u && URL.revokeObjectURL(u));

async function addFiles(fileList) {
  const all = [...fileList];
  // Con carpetas, ordena por ruta para que los álbumes queden en orden (01, 02, … 10).
  if (all.some((f) => pathOf(f).includes("/"))) all.sort(byPath);
  const lrcFiles = all.filter(isLrc);
  const listFiles = all.filter(isListFile);
  const files = all.filter(isAudio);

  let added = 0;
  let dupes = 0;
  let failed = 0;
  const keys = new Set(state.tracks.map((t) => t.key));
  for (const [i, file] of files.entries()) {
    const key = fileKey(file);
    if (keys.has(key)) { dupes++; continue; }
    keys.add(key);
    if (files.length > 5 && i % 10 === 0) toast(`Importando ${i + 1}/${files.length}…`, 60000);
    let id = null;
    try {
      try { id = await Storage.add(file); } catch { /* sin persistencia: se usa solo en memoria */ }
      state.tracks.push(await makeTrack(id, file));
      added++;
      if (added % 25 === 0) render();
    } catch {
      failed++; // un archivo ilegible no debe detener el resto de la importación
      keys.delete(key);
      if (id != null) Storage.remove(id).catch(() => {});
    }
  }

  const resolved = added ? resolvePending() : 0;
  const lyr = lrcFiles.length ? await attachLrcFiles(lrcFiles) : null;
  const imp = listFiles.length ? await importPlaylistFiles(listFiles) : null;
  render();
  if (state.index === -1 && state.tracks.length) loadTrack(0, false, "all");

  const msg = [];
  if (added) msg.push(`${added} canción(es) añadida(s)`);
  if (dupes) msg.push(`${dupes} ya estaba(n) en la biblioteca`);
  if (failed) msg.push(`${failed} no se pudieron leer`);
  if (lyr?.matched) msg.push(`letra para ${lyr.matched}`);
  if (lyr?.missed) msg.push(`${lyr.missed} .lrc sin pareja`);
  if (resolved) msg.push(`${resolved} canción(es) completan listas importadas`);
  if (imp) msg.push(...importSummary(imp));
  if (all.length && !files.length && !lrcFiles.length && !listFiles.length) msg.push("No se encontró ningún archivo de audio");
  if (msg.length && !(added === 1 && all.length === 1)) toast(msg.join(" · "));
  else els.toast.hidden = true;
}

// Archivos que el sistema entrega a la app instalada («Abrir con…» o doble clic en un archivo de audio):
// se añaden a la biblioteca, suena el primero y los demás quedan en la cola.
async function openFromSystem(files) {
  const audioFiles = files.filter(isAudio);
  if (!audioFiles.length) return;
  await addFiles(audioFiles);
  const trackOf = (f) => state.tracks.find((t) => t.key === fileKey(f));
  const first = trackOf(audioFiles[0]);
  if (!first) return;
  loadTrack(state.tracks.indexOf(first), true, "all");
  for (const f of audioFiles.slice(1)) {
    const t = trackOf(f);
    if (t && t !== first && !state.queue.includes(t)) state.queue.push(t);
  }
  render();
}

// Consumidor de launchQueue: recibe los manejadores de archivo y los convierte en File.
async function consumeLaunch({ files: handles = [] } = {}) {
  const files = [];
  for (const h of handles) {
    try { files.push(await h.getFile()); } catch { /* el archivo ya no está o no hay permiso */ }
  }
  await openFromSystem(files);
}

// Recorre arrastres que incluyen carpetas (webkitGetAsEntry) y devuelve todos los archivos con su ruta.
async function filesFromDrop(dt) {
  // Las entradas hay que leerlas de forma síncrona, antes de cualquier await.
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];

  const out = [];
  const readAll = (reader) => new Promise((resolve, reject) => {
    const acc = [];
    const next = () => reader.readEntries((batch) => (batch.length ? (acc.push(...batch), next()) : resolve(acc)), reject);
    next();
  });
  async function walk(entry) {
    if (entry.isFile) {
      const f = await new Promise((resolve, reject) => entry.file(resolve, reject));
      f.relPath = entry.fullPath.replace(/^\//, "");
      out.push(f);
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

function removeTrack(i) {
  const [t] = state.tracks.splice(i, 1);
  state.queue = state.queue.filter((q) => q !== t);
  if (t.id != null) {
    state.playlists.forEach((p) => (p.ids = p.ids.filter((id) => id !== t.id)));
    savePlaylists();
    Storage.remove(t.id).catch(() => {});
  }
  URL.revokeObjectURL(t.url);
  revokeCovers(t);

  if (i === state.index) {
    endCrossfade();
    audio.pause();
    audio.removeAttribute("src");
    state.index = -1;
    showTrack(null);
    if (state.tracks.length) loadTrack(Math.min(i, state.tracks.length - 1), false, "all");
  } else if (i < state.index) {
    state.index--;
  }
  render();
}

async function clearLibrary() {
  if (!state.tracks.length || !confirm("¿Vaciar toda la biblioteca?")) return;
  endCrossfade();
  audio.pause();
  audio.removeAttribute("src");
  state.tracks.forEach((t) => { URL.revokeObjectURL(t.url); revokeCovers(t); });
  state.tracks = [];
  state.queue = [];
  state.playlists.forEach((p) => (p.ids = []));
  savePlaylists();
  state.index = -1;
  await Storage.clear().catch(() => {});
  showTrack(null);
  render();
}

function render() {
  if (state.selecting) {
    for (const t of state.selected) if (!state.tracks.includes(t)) state.selected.delete(t);
    updateSelectBar();
  }
  const q = state.filter.toLowerCase();
  const pl = currentPlaylist();
  const rows = listTracks(state.view)
    .map((t, pos) => ({ t, pos }))
    .filter(({ t }) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));

  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = q ? "Sin resultados."
      : pl ? "Esta lista está vacía. Usa el botón ♫ de una canción para añadirla."
      : "Tu biblioteca está vacía. Arrastra archivos o carpetas aquí, o usa «+ Añadir» / «+ Carpeta».";
    els.playlist.replaceChildren(li, ...pendingNote(pl));
    return;
  }

  const current = state.tracks[state.index];
  const shown = rows.map((r) => r.t);
  const indexOf = new Map(state.tracks.map((t, n) => [t, n])); // evita un indexOf por fila en bibliotecas grandes
  els.playlist.replaceChildren(
    ...rows.map(({ t, pos }) => {
      const i = indexOf.get(t);
      const li = document.createElement("li");
      li.tabIndex = 0; // se puede recorrer con Tab y activar con Intro
      li.classList.toggle("active", t === current);
      li.classList.toggle("selected", state.selected.has(t));
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "t-check";
      check.checked = state.selected.has(t);
      check.tabIndex = -1;

      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (t.coverUrl) thumb.style.backgroundImage = `url(${t.coverUrl})`;
      else thumb.textContent = "♪";

      const text = document.createElement("div");
      text.className = "t-text";
      const name = document.createElement("div");
      name.className = "t-name";
      name.textContent = t.title;
      const sub = document.createElement("div");
      sub.className = "t-sub";
      const qpos = state.queue.indexOf(t) + 1;
      sub.textContent = (qpos ? `En cola #${qpos} · ` : "") + ([t.artist, t.album].filter(Boolean).join(" · ") || "Artista desconocido");
      text.append(name, sub);

      const btn = (cls, title, label, fn) => {
        const b = document.createElement("button");
        b.className = cls;
        b.title = title;
        b.textContent = label;
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        return b;
      };
      const qb = btn("t-btn", qpos ? "Quitar de la cola" : "Reproducir a continuación", qpos ? "−" : "+", () => toggleQueue(t));
      const eb = btn("t-btn", "Editar etiquetas", "✎", () => openEditor(t));
      const pb = btn("t-btn", "Añadir a una lista", "♫", (b) => openMenu(b, t));
      const rm = pl
        ? btn("t-btn remove", "Quitar de esta lista", "✕", () => removeFromPlaylist(pl, t))
        : btn("t-btn remove", "Quitar de la biblioteca", "✕", () => removeTrack(i));

      li.append(...(state.selecting ? [check] : []), thumb, text, qb, pb, eb, rm);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === li) li.click(); });
      li.addEventListener("click", (e) => {
        if (state.selecting) return toggleSelect(t, shown, e.shiftKey);
        if (e.ctrlKey || e.metaKey) { setSelecting(true); return toggleSelect(t, shown, false); } // atajo para entrar en el modo
        loadTrack(i, true, state.view);
      });

      if (!q && !state.selecting) {
        li.draggable = true;
        li.addEventListener("dragstart", (e) => { dragFrom = pos; e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
        li.addEventListener("dragend", () => { dragFrom = -1; li.classList.remove("dragging"); clearDropMarks(); });
        li.addEventListener("dragover", (e) => {
          if (dragFrom < 0) return;
          e.preventDefault();
          clearDropMarks();
          li.classList.add(dropBefore(e, li) ? "drop-before" : "drop-after");
        });
        li.addEventListener("drop", (e) => {
          if (dragFrom < 0) return;
          e.preventDefault();
          e.stopPropagation();
          moveTrack(dragFrom, pos + (dropBefore(e, li) ? 0 : 1));
        });
      }
      return li;
    }),
    ...pendingNote(pl)
  );
}

let dragFrom = -1;

const dropBefore = (e, li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;

const clearDropMarks = () => els.playlist.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));

// Reordena dentro de la vista actual (biblioteca o lista).
function moveTrack(from, to) {
  if (to > from) to--;
  if (to === from) return render();
  const pl = currentPlaylist();
  if (pl) {
    pl.ids.splice(to, 0, ...pl.ids.splice(from, 1));
    savePlaylists();
    return render();
  }
  const current = state.tracks[state.index];
  const [t] = state.tracks.splice(from, 1);
  state.tracks.splice(to, 0, t);
  state.index = state.tracks.indexOf(current);
  store.set("order", JSON.stringify(state.tracks.map((x) => x.id).filter((id) => id != null)));
  render();
}

function toggleQueue(t) {
  const i = state.queue.indexOf(t);
  i >= 0 ? state.queue.splice(i, 1) : state.queue.push(t);
  render();
}

let dragDepth = 0;

const hasFiles = (e) => e.dataTransfer?.types.includes("Files");

const matchesFilter = (t) => {
  const q = state.filter.toLowerCase();
  return !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q);
};

const shownTracks = () => listTracks(state.view).filter(matchesFilter);

function updateSelectBar() {
  const n = state.selected.size;
  els["select-count"].textContent = `${n} seleccionada${n === 1 ? "" : "s"}`;
  els["select-edit"].disabled = n === 0;
}

function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  state.anchor = null;
  els["select-bar"].hidden = !on;
  els["select-btn"].setAttribute("aria-pressed", on);
  els.playlist.classList.toggle("selecting", on);
  render();
  updateSelectBar();
}

// Clic marca o desmarca; con Mayús marca todo el rango desde la última pulsada.
function toggleSelect(t, shown, range) {
  if (range && state.anchor && shown.includes(state.anchor)) {
    const a = shown.indexOf(state.anchor);
    const b = shown.indexOf(t);
    shown.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => state.selected.add(x));
  } else {
    state.selected.has(t) ? state.selected.delete(t) : state.selected.add(t);
  }
  state.anchor = t;
  render();
}

// Importar (selector, carpetas, arrastrar), vaciar y filtrar.
function wireLibrary() {
  els["file-input"].addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

  els["folder-input"].addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

  els.clear.addEventListener("click", clearLibrary);

  els.filter.addEventListener("input", () => { state.filter = els.filter.value; render(); });

  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.dropzone.classList.add("dragover"); });

  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });

  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove("dragover"); } });

  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("dragover");
    filesFromDrop(e.dataTransfer).then(addFiles).catch(() => addFiles(e.dataTransfer.files));
  });
}

// Modo de selección múltiple.
function wireSelection() {
  els["select-btn"].addEventListener("click", () => setSelecting(!state.selecting));

  els["select-done"].addEventListener("click", () => setSelecting(false));

  els["select-all"].addEventListener("click", () => { shownTracks().forEach((t) => state.selected.add(t)); render(); });

  els["select-none"].addEventListener("click", () => { state.selected.clear(); render(); });

  els["select-edit"].addEventListener("click", () => {
    // Se editan en el orden en que aparecen en la lista.
    const picked = state.tracks.filter((t) => state.selected.has(t));
    if (picked.length) openEditor(picked);
  });
}
