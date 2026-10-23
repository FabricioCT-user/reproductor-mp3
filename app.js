const $ = (id) => document.getElementById(id);

// Dos elementos de audio: uno suena y el otro entra durante un fundido cruzado (ver «Fundido»).
const decks = [$("audio"), $("audio-b")];
let audio = decks[0]; // el deck activo: lo que muestran la barra de progreso, los controles, etc.
const otherDeck = () => decks[audio === decks[0] ? 1 : 0];
const onAudio = (type, fn) => decks.forEach((d) => d.addEventListener(type, (e) => { if (d === audio) fn(e); }));
const setVolume = (v) => decks.forEach((d) => (d.volume = v));
const setMuted = (m) => decks.forEach((d) => (d.muted = m));
const els = Object.fromEntries(
  ["dropzone", "backdrop", "cover", "title", "artist", "viz", "seek", "current", "duration", "play", "play-icon",
   "prev", "next", "shuffle", "repeat", "mute", "volume", "filter", "file-input", "clear", "playlist",
   "view", "pl-new", "pl-more", "pl-import", "pl-rename", "pl-delete", "menu",
   "eq-toggle", "eq-panel", "eq-preset", "eq-on", "eq-reset", "eq-bands",
   "lyrics", "lyrics-body", "lyrics-toggle", "lyrics-clear", "lrc-input", "toast", "folder-input",
   "speed-btn", "sleep-btn", "theme-btn", "xfade-btn",
   "select-btn", "select-bar", "select-count", "select-all", "select-none", "select-edit", "select-done",
   "edit-heading", "edit-note", "edit-dialog", "edit-form", "edit-cover", "edit-cover-input", "edit-cover-clear", "edit-title", "edit-artist", "edit-album", "edit-reset", "edit-cancel", "edit-download"]
    .map((id) => [id, $(id)])
);

const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

const state = {
  tracks: [],
  index: -1,
  shuffle: localStorage.getItem("shuffle") === "1",
  repeat: localStorage.getItem("repeat") === "1",
  filter: "",
  queue: [],
  speed: Number(localStorage.getItem("speed")) || 1,
  crossfade: Number(localStorage.getItem("crossfade")) || 0,
  selecting: false,
  selected: new Set(), // pistas marcadas en el modo de selección
  anchor: null,        // última marcada, para seleccionar rangos con Mayús
  playlists: JSON.parse(localStorage.getItem("playlists") || "[]"),
  view: "all",      // "all" o id de lista: lo que se muestra
  playView: "all",  // vista desde la que se inició la reproducción (define siguiente/anterior)
};

const formatTime = (s) => {
  if (!isFinite(s)) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/* ---------- Biblioteca ---------- */

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

const isAudio = (f) => f.type.startsWith("audio/") || /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|weba)$/i.test(f.name);

// Ruta relativa de un archivo importado desde una carpeta (o solo su nombre).
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
const pathOf = (f) => f.relPath || f.webkitRelativePath || f.name;
const dirOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const byPath = (a, b) => pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true, sensitivity: "base" });

async function addFiles(fileList) {
  const all = [...fileList];
  // Con carpetas, ordena por ruta para que los álbumes queden en orden (01, 02, … 10).
  if (all.some((f) => pathOf(f).includes("/"))) all.sort(byPath);
  const lrcFiles = all.filter((f) => /\.lrc$/i.test(f.name));
  const listFiles = all.filter((f) => /\.(json|m3u8?)$/i.test(f.name));
  const files = all.filter(isAudio);

  let added = 0;
  let dupes = 0;
  for (const [i, file] of files.entries()) {
    if (state.tracks.some((t) => t.key === fileKey(file))) { dupes++; continue; }
    if (files.length > 5 && i % 10 === 0) toast(`Importando ${i + 1}/${files.length}…`, 60000);
    let id = null;
    try { id = await Storage.add(file); } catch { /* sin persistencia: se usa solo en memoria */ }
    state.tracks.push(await makeTrack(id, file));
    added++;
    if (added % 25 === 0) render();
  }

  const resolved = added ? resolvePending() : 0;
  const lyr = lrcFiles.length ? await attachLrcFiles(lrcFiles) : null;
  const imp = listFiles.length ? await importPlaylistFiles(listFiles) : null;
  render();
  if (state.index === -1 && state.tracks.length) loadTrack(0, false, "all");

  const msg = [];
  if (added) msg.push(`${added} canción(es) añadida(s)`);
  if (dupes) msg.push(`${dupes} ya estaba(n) en la biblioteca`);
  if (lyr?.matched) msg.push(`letra para ${lyr.matched}`);
  if (lyr?.missed) msg.push(`${lyr.missed} .lrc sin pareja`);
  if (resolved) msg.push(`${resolved} canción(es) completan listas importadas`);
  if (imp) msg.push(...importSummary(imp));
  if (all.length && !files.length && !lrcFiles.length && !listFiles.length) msg.push("No se encontró ningún archivo de audio");
  if (msg.length && !(added === 1 && all.length === 1)) toast(msg.join(" · "));
  else els.toast.hidden = true;
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

/* ---------- Letras ---------- */

let toastTimer;
function toast(msg, ms = 3500) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

const lyricsOf = (t) => t?.userLyrics || t?.embeddedLyrics || "";

// Letra analizada, con caché por texto.
function parsedLyrics(t) {
  const raw = lyricsOf(t);
  if (!raw) return null;
  if (t._parsed?.raw !== raw) t._parsed = { raw, value: Lyrics.parse(raw) };
  return t._parsed.value.lines.length ? t._parsed.value : null;
}

async function setUserLyrics(t, text) {
  t.userLyrics = text;
  if (t.id != null) await Storage.setLyrics(t.id, text || null).catch(() => {});
  if (t === state.tracks[state.index]) renderLyrics();
}

// Empareja cada .lrc con una pista por nombre de archivo (o, si no, por título).
async function attachLrcFiles(lrcFiles) {
  let matched = 0;
  for (const f of lrcFiles) {
    const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
    const dir = dirOf(pathOf(f));
    // Mismo nombre y, si hay varios (p. ej. «01» en distintos álbumes), la misma carpeta.
    const same = state.tracks.filter((x) => x.fileBase === base);
    const t = same.find((x) => x.dir === dir) || same[0] || state.tracks.find((x) => x.title.toLowerCase() === base);
    if (!t) continue;
    await setUserLyrics(t, await f.text());
    matched++;
  }
  return { matched, missed: lrcFiles.length - matched };
}

let lyricCursor = -1;

function renderLyrics() {
  const t = state.tracks[state.index];
  const L = parsedLyrics(t);
  els["lyrics-toggle"].classList.toggle("active", !!L);
  els["lyrics-clear"].hidden = !t?.userLyrics;
  lyricCursor = -1;

  if (!L) {
    const p = document.createElement("p");
    p.className = "lyrics-empty";
    p.textContent = t ? "No hay letra para esta canción. Carga un archivo .lrc, o súbelo junto al audio con el mismo nombre." : "";
    els["lyrics-body"].replaceChildren(p);
    return;
  }

  els["lyrics-body"].classList.toggle("synced", L.synced);
  els["lyrics-body"].replaceChildren(
    ...L.lines.map((line) => {
      const d = document.createElement("div");
      d.className = "lyric-line" + (line.text ? "" : " gap");
      d.textContent = line.text || "♪";
      if (L.synced) d.addEventListener("click", () => { audio.currentTime = line.t; });
      return d;
    })
  );
  els["lyrics-body"].scrollTop = 0;
  syncLyrics();
}

// Marca la línea actual y la centra en el panel.
function syncLyrics() {
  if (els.lyrics.hidden) return;
  const L = parsedLyrics(state.tracks[state.index]);
  if (!L?.synced) return;
  let idx = -1;
  for (let i = 0; i < L.lines.length && L.lines[i].t <= audio.currentTime + 0.15; i++) idx = i;
  if (idx === lyricCursor) return;
  lyricCursor = idx;
  const nodes = els["lyrics-body"].children;
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].classList.toggle("active", i === idx);
    nodes[i].classList.toggle("past", i < idx);
  }
  const el = nodes[idx];
  if (el) els["lyrics-body"].scrollTo({ top: el.offsetTop - els["lyrics-body"].clientHeight / 2 + el.offsetHeight / 2, behavior: "smooth" });
}

function toggleLyrics(force) {
  els.lyrics.hidden = force ?? !els.lyrics.hidden;
  els["lyrics-toggle"].setAttribute("aria-pressed", !els.lyrics.hidden);
  localStorage.setItem("lyrics", els.lyrics.hidden ? "0" : "1");
  if (!els.lyrics.hidden) { lyricCursor = -1; syncLyrics(); }
}

els["lyrics-toggle"].addEventListener("click", () => toggleLyrics());
els["lyrics-clear"].addEventListener("click", () => { const t = state.tracks[state.index]; if (t) setUserLyrics(t, ""); });
els["lrc-input"].addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  const t = state.tracks[state.index];
  if (!f || !t) return;
  await setUserLyrics(t, await f.text());
  toast("Letra cargada");
});
setInterval(syncLyrics, 120);

function removeTrack(i) {
  const [t] = state.tracks.splice(i, 1);
  state.queue = state.queue.filter((q) => q !== t);
  if (t.id != null) { state.playlists.forEach((p) => (p.ids = p.ids.filter((id) => id !== t.id))); savePlaylists(); }
  if (t.id != null) Storage.remove(t.id).catch(() => {});
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

const currentPlaylist = () => state.playlists.find((p) => p.id === state.view);

function listTracks(view) {
  const p = state.playlists.find((x) => x.id === view);
  if (!p) return state.tracks;
  return p.ids.map((id) => state.tracks.find((t) => t.id === id)).filter(Boolean);
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
  els.playlist.replaceChildren(
    ...rows.map(({ t, pos }) => {
      const i = state.tracks.indexOf(t);
      const li = document.createElement("li");
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
  localStorage.setItem("order", JSON.stringify(state.tracks.map((x) => x.id).filter((id) => id != null)));
  render();
}

/* ---------- Listas de reproducción ---------- */

const savePlaylists = () => localStorage.setItem("playlists", JSON.stringify(state.playlists));

function renderViews() {
  els.view.replaceChildren(
    new Option("Biblioteca", "all"),
    ...state.playlists.map((p) => new Option(`${p.name} (${p.ids.length})`, p.id))
  );
  els.view.value = state.view;
  const inList = !!currentPlaylist();
  els["pl-rename"].hidden = els["pl-delete"].hidden = !inList;
  els.clear.hidden = inList;
}

function setView(v) {
  state.view = state.playlists.some((p) => p.id === v) ? v : "all";
  state.filter = els.filter.value = "";
  renderViews();
  render();
}

function createPlaylist() {
  const name = prompt("Nombre de la nueva lista:")?.trim();
  if (!name) return null;
  const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, ids: [] };
  state.playlists.push(p);
  savePlaylists();
  renderViews();
  return p;
}

function renamePlaylist() {
  const p = currentPlaylist();
  const name = p && prompt("Nuevo nombre:", p.name)?.trim();
  if (!name) return;
  p.name = name;
  savePlaylists();
  renderViews();
}

function deletePlaylist() {
  const p = currentPlaylist();
  if (!p || !confirm(`¿Eliminar la lista «${p.name}»? Las canciones se conservan en la biblioteca.`)) return;
  state.playlists = state.playlists.filter((x) => x !== p);
  savePlaylists();
  if (state.playView === p.id) state.playView = "all";
  setView("all");
}

function removeFromPlaylist(p, t) {
  p.ids = p.ids.filter((id) => id !== t.id);
  savePlaylists();
  renderViews();
  render();
}

function togglePlaylistMember(p, t) {
  p.ids.includes(t.id) ? (p.ids = p.ids.filter((id) => id !== t.id)) : p.ids.push(t.id);
  savePlaylists();
  renderViews();
  render();
}

/* ---------- Exportar / importar listas ---------- */

const refOf = (t) => ({ file: t.fileName, size: t.size, title: t.title, artist: t.artist });
const refsOf = (p) => [...listTracks(p.id).map(refOf), ...(p.pending || [])];

function download(name, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "lista";

function exportPlaylists(lists, format) {
  lists = lists.filter(Boolean);
  if (!lists.length) return;
  if (format === "m3u8") {
    download(`${safeName(lists[0].name)}.m3u8`, PlaylistIO.toM3U(refsOf(lists[0])), "audio/x-mpegurl");
  } else {
    const name = lists.length === 1 ? safeName(lists[0].name) : "listas-reproductor";
    download(`${name}.json`, PlaylistIO.toJSON(lists.map((p) => ({ name: p.name, refs: refsOf(p) }))), "application/json");
  }
  toast(`${lists.length} lista(s) exportada(s)`);
}

// Busca en la biblioteca la canción a la que se refiere una entrada exportada.
function findTrack(ref) {
  const lib = state.tracks.filter((t) => t.id != null);
  const file = ref.file.toLowerCase();
  if (file) {
    const same = lib.filter((t) => t.fileName.toLowerCase() === file);
    const exact = same.find((t) => ref.size == null || t.size === ref.size);
    if (exact) return exact;
    if (same.length === 1) return same[0];
  }
  if (ref.title) {
    const byTitle = lib.filter((t) => t.title.toLowerCase() === ref.title.toLowerCase()
      && (!ref.artist || t.artist.toLowerCase() === ref.artist.toLowerCase()));
    if (byTitle.length === 1) return byTitle[0];
  }
  return null;
}

// Las canciones que aún no están en la biblioteca quedan como «pendientes» y se enlazan al importarlas.
function resolvePending() {
  let n = 0;
  for (const p of state.playlists) {
    if (!p.pending?.length) continue;
    p.pending = p.pending.filter((ref) => {
      const t = findTrack(ref);
      if (!t) return true;
      if (!p.ids.includes(t.id)) p.ids.push(t.id);
      n++;
      return false;
    });
  }
  if (n) { savePlaylists(); renderViews(); }
  return n;
}

const uniqueName = (name) => {
  const taken = new Set(state.playlists.map((p) => p.name.toLowerCase()));
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name} (${i})`;
  return out;
};

async function importPlaylistFiles(files) {
  const res = { lists: 0, matched: 0, pending: 0, bad: 0 };
  for (const f of files) {
    let parsed;
    try {
      const text = await f.text();
      parsed = /\.json$/i.test(f.name) ? PlaylistIO.parseJSON(text) : PlaylistIO.parseM3U(text, f.name.replace(/\.[^.]+$/, ""));
    } catch {
      res.bad++;
      continue;
    }
    for (const { name, refs } of parsed) {
      const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: uniqueName(name), ids: [], pending: [] };
      for (const ref of refs) {
        const t = findTrack(ref);
        if (t) { if (!p.ids.includes(t.id)) { p.ids.push(t.id); res.matched++; } }
        else { p.pending.push(ref); res.pending++; }
      }
      state.playlists.push(p);
      res.lists++;
    }
  }
  savePlaylists();
  renderViews();
  return res;
}

function importSummary({ lists, matched, pending, bad }) {
  const out = [];
  if (lists) out.push(`${lists} lista(s) importada(s) con ${matched} canción(es)`);
  if (pending) out.push(`${pending} pendiente(s): se enlazarán al importar esos archivos`);
  if (bad) out.push(`${bad} archivo(s) de listas no válido(s)`);
  return out;
}

function pendingNote(pl) {
  if (!pl?.pending?.length) return [];
  const li = document.createElement("li");
  li.className = "empty pending";
  li.textContent = `${pl.pending.length} canción(es) pendiente(s): aparecerán cuando importes esos archivos.`;
  li.title = pl.pending.map((r) => r.file || r.title).join("\n");
  return [li];
}

function openMenu(anchor, t) {
  showMenu(anchor, t.id == null
    ? [{ label: "No disponible: el navegador no permite guardar la biblioteca", disabled: true }]
    : [
        ...state.playlists.map((p) => ({ label: `${p.ids.includes(t.id) ? "✓" : "\u2003"} ${p.name}`, fn: () => togglePlaylistMember(p, t) })),
        { label: "+ Nueva lista…", fn: () => { const p = createPlaylist(); if (p) togglePlaylistMember(p, t); } },
      ]);
}

// Menú flotante genérico: items = [{ label, fn, disabled }].
function showMenu(anchor, items) {
  const m = els.menu;
  m.replaceChildren(
    ...items.map(({ label, fn, disabled }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener("click", () => { closeMenu(); fn?.(); });
      return b;
    })
  );
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${r.bottom + m.offsetHeight + 8 > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4}px`;
}

const closeMenu = () => (els.menu.hidden = true);
document.addEventListener("click", (e) => { if (!els.menu.contains(e.target)) closeMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.code === "Escape") closeMenu(); });

function toggleQueue(t) {
  const i = state.queue.indexOf(t);
  i >= 0 ? state.queue.splice(i, 1) : state.queue.push(t);
  render();
}

/* ---------- Reproducción ---------- */

// Título, artista y carátula (lo que cambia al editar etiquetas sin reiniciar la reproducción).
function showMeta(t) {
  els.title.textContent = t ? t.title : "Nada en reproducción";
  els.artist.textContent = t ? [t.artist, t.album].filter(Boolean).join(" · ") || "Artista desconocido" : "Añade música para empezar";
  els.cover.style.backgroundImage = t?.coverUrl ? `url(${t.coverUrl})` : "";
  els.cover.classList.toggle("has-art", !!t?.coverUrl);
  els.backdrop.style.backgroundImage = t?.coverUrl ? `url(${t.coverUrl})` : "";
  els.backdrop.classList.toggle("on", !!t?.coverUrl);
  document.title = t ? `${t.title} · Reproductor MP3` : "Reproductor MP3";

  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({
          title: t.title, artist: t.artist, album: t.album,
          artwork: t.coverUrl ? [{ src: t.coverUrl }] : [],
        })
      : null;
  }
}

function showTrack(t) {
  showMeta(t);
  els.seek.disabled = !t;
  els.seek.value = 0;
  els.current.textContent = els.duration.textContent = "0:00";
  renderLyrics();
}

function loadTrack(i, autoplay, view = "all") {
  if (xfade && !xfade.starting) endCrossfade(); // un cambio manual corta el fundido en curso
  state.index = i;
  state.playView = view;
  const t = state.tracks[i];
  audio.src = t.url;
  audio.playbackRate = state.speed;
  showTrack(t);
  render();
  localStorage.setItem("lastId", t.id ?? "");
  if (autoplay) play();
}

function play() {
  startAnalyser();
  audio.play().catch(() => {});
}

// Pistas entre las que se navega: la vista desde la que se empezó a reproducir.
const contextList = () => listTracks(state.playView);

function step(dir) {
  if (!state.tracks.length) return;
  if (dir > 0 && state.queue.length) return loadTrack(state.tracks.indexOf(state.queue.shift()), true, state.playView);
  const list = contextList();
  const n = list.length;
  if (!n) return;
  const current = state.tracks[state.index];
  const pos = list.indexOf(current);
  let next;
  if (pos < 0) next = list[0];
  else if (state.shuffle && n > 1) {
    do { next = list[Math.floor(Math.random() * n)]; } while (next === current);
  } else {
    next = list[(pos + dir + n) % n];
  }
  loadTrack(state.tracks.indexOf(next), true, state.playView);
}

function togglePlay() {
  if (!state.tracks.length) return;
  if (state.index === -1) return loadTrack(0, true, "all");
  audio.paused ? play() : audio.pause();
}

function setToggle(btn, key, value) {
  state[key] = value;
  btn.setAttribute("aria-pressed", value);
  localStorage.setItem(key, value ? "1" : "0");
}

/* ---------- Ecualizador ---------- */

const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  "Plano": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Graves": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  "Agudos": [0, 0, 0, 0, 0, 1, 3, 5, 6, 6],
  "Voz": [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  "Rock": [4, 3, 2, -1, -2, -1, 2, 3, 4, 4],
  "Pop": [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  "Electrónica": [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
  "Clásica": [3, 2, 1, 1, 0, 0, -1, -1, 2, 3],
};

let eqFilters = [], eqPreamp;
const eqSaved = JSON.parse(localStorage.getItem("eq") || "null");
state.eq = { on: eqSaved?.on ?? true, gains: eqSaved?.gains?.length === EQ_BANDS.length ? eqSaved.gains : EQ_PRESETS.Plano.slice() };

const fmtFreq = (f) => (f >= 1000 ? `${f / 1000}k` : f);
const fmtGain = (g) => (g > 0 ? `+${g}` : `${g}`);

function applyEq() {
  const gains = state.eq.on ? state.eq.gains : EQ_PRESETS.Plano;
  eqFilters.forEach((f, i) => (f.gain.value = gains[i]));
  // Reduce el nivel a la mitad del mayor realce para evitar saturación.
  if (eqPreamp) eqPreamp.gain.value = 10 ** (-0.5 * Math.max(0, ...gains) / 20);
}

function saveEq() {
  localStorage.setItem("eq", JSON.stringify(state.eq));
  applyEq();
  syncEqUi();
}

function syncEqUi() {
  els["eq-on"].checked = state.eq.on;
  els["eq-panel"].classList.toggle("off", !state.eq.on);
  els["eq-toggle"].setAttribute("aria-pressed", !els["eq-panel"].hidden);
  els["eq-toggle"].classList.toggle("active", state.eq.on && state.eq.gains.some((g) => g !== 0));
  const match = Object.entries(EQ_PRESETS).find(([, g]) => g.every((v, i) => v === state.eq.gains[i]));
  els["eq-preset"].value = match ? match[0] : "custom";
  els["eq-bands"].querySelectorAll(".eq-band").forEach((el, i) => {
    el.querySelector("input").value = state.eq.gains[i];
    el.querySelector(".eq-gain").textContent = fmtGain(state.eq.gains[i]);
  });
}

function buildEqUi() {
  els["eq-preset"].replaceChildren(...Object.keys(EQ_PRESETS).map((n) => new Option(n, n)), new Option("Personalizado", "custom"));
  els["eq-bands"].replaceChildren(
    ...EQ_BANDS.map((f, i) => {
      const col = document.createElement("div");
      col.className = "eq-band";
      const gain = document.createElement("span");
      gain.className = "eq-gain";
      const input = document.createElement("input");
      input.type = "range";
      input.min = -12; input.max = 12; input.step = 1;
      input.setAttribute("aria-label", `${fmtFreq(f)} Hz`);
      input.addEventListener("input", () => { state.eq.gains[i] = +input.value; saveEq(); });
      input.addEventListener("dblclick", () => { state.eq.gains[i] = 0; saveEq(); });
      const label = document.createElement("span");
      label.className = "eq-freq";
      label.textContent = fmtFreq(f);
      col.append(gain, input, label);
      return col;
    })
  );
  syncEqUi();
}

els["eq-toggle"].addEventListener("click", () => {
  els["eq-panel"].hidden = !els["eq-panel"].hidden;
  syncEqUi();
});
els["eq-on"].addEventListener("change", () => { state.eq.on = els["eq-on"].checked; saveEq(); });
els["eq-reset"].addEventListener("click", () => { state.eq.gains = EQ_PRESETS.Plano.slice(); saveEq(); });
els["eq-preset"].addEventListener("change", () => {
  const g = EQ_PRESETS[els["eq-preset"].value];
  if (!g) return;
  state.eq.gains = g.slice();
  state.eq.on = true;
  saveEq();
});

/* ---------- Visualizador ---------- */

let analyser, freq;
const ctx2d = els.viz.getContext("2d");

function startAnalyser() {
  if (analyser) return;
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  analyser = ac.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.8;
  freq = new Uint8Array(analyser.frequencyBinCount);

  // fuente → 10 filtros → preamp → analizador → salida
  // Cada deck tiene su propia ganancia (para el fundido) y ambos entran al mismo ecualizador.
  const eqIn = ac.createGain();
  for (const d of decks) {
    d._gain = ac.createGain();
    ac.createMediaElementSource(d).connect(d._gain);
    d._gain.connect(eqIn);
  }
  let node = eqIn;
  eqFilters = EQ_BANDS.map((f, i) => {
    const filter = ac.createBiquadFilter();
    filter.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
    filter.frequency.value = f;
    filter.Q.value = 1.4;
    node.connect(filter);
    node = filter;
    return filter;
  });
  eqPreamp = ac.createGain();
  node.connect(eqPreamp);
  eqPreamp.connect(analyser);
  analyser.connect(ac.destination);
  applyEq();
  decks.forEach((d) => d.addEventListener("play", () => ac.resume()));
  draw();
}

function draw() {
  requestAnimationFrame(draw);
  const { width: w, height: h } = els.viz;
  ctx2d.clearRect(0, 0, w, h);
  if (audio.paused) return;

  analyser.getByteFrequencyData(freq);
  const bars = 48;
  const gap = 4;
  const bw = (w - gap * (bars - 1)) / bars;
  ctx2d.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  for (let i = 0; i < bars; i++) {
    const v = freq[Math.floor((i / bars) * freq.length * 0.75)] / 255;
    const bh = Math.max(3, v * h);
    ctx2d.globalAlpha = 0.45 + v * 0.55;
    ctx2d.fillRect(i * (bw + gap), h - bh, bw, bh);
  }
  ctx2d.globalAlpha = 1;
}

/* ---------- Eventos ---------- */

els["file-input"].addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
els["folder-input"].addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
els.clear.addEventListener("click", clearLibrary);
els.view.addEventListener("change", () => setView(els.view.value));
els["pl-new"].addEventListener("click", () => { const p = createPlaylist(); if (p) setView(p.id); });
els["pl-rename"].addEventListener("click", renamePlaylist);
els["pl-delete"].addEventListener("click", deletePlaylist);
els["pl-more"].addEventListener("click", (e) => {
  const pl = currentPlaylist();
  showMenu(e.currentTarget, [
    { label: "Exportar esta lista (.json)", fn: () => exportPlaylists([pl], "json"), disabled: !pl },
    { label: "Exportar esta lista (.m3u8)", fn: () => exportPlaylists([pl], "m3u8"), disabled: !pl },
    { label: "Exportar todas las listas (.json)", fn: () => exportPlaylists(state.playlists, "json"), disabled: !state.playlists.length },
    { label: "Importar listas…", fn: () => els["pl-import"].click() },
  ]);
});
els["pl-import"].addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
els.filter.addEventListener("input", () => { state.filter = els.filter.value; render(); });

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types.includes("Files");
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

els.play.addEventListener("click", togglePlay);
els.prev.addEventListener("click", () => { audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1); });
els.next.addEventListener("click", () => step(1));
els.shuffle.addEventListener("click", () => setToggle(els.shuffle, "shuffle", !state.shuffle));
els.repeat.addEventListener("click", () => setToggle(els.repeat, "repeat", !state.repeat));

els.volume.value = localStorage.getItem("volume") ?? 1;
setVolume(els.volume.value);
els.volume.addEventListener("input", () => {
  setVolume(els.volume.value);
  setMuted(false);
  localStorage.setItem("volume", els.volume.value);
});
els.mute.addEventListener("click", () => setMuted(!audio.muted));
onAudio("volumechange", () => (els.mute.style.opacity = audio.muted ? 0.35 : ""));

els.seek.addEventListener("input", () => {
  if (audio.duration) audio.currentTime = (els.seek.value / 100) * audio.duration;
});

onAudio("play", () => (els["play-icon"].innerHTML = ICON_PAUSE));
onAudio("pause", () => { els["play-icon"].innerHTML = ICON_PLAY; if (xfade) endCrossfade(); });
onAudio("loadedmetadata", () => (els.duration.textContent = formatTime(audio.duration)));
onAudio("timeupdate", () => {
  els.current.textContent = formatTime(audio.currentTime);
  if (audio.duration) els.seek.value = (audio.currentTime / audio.duration) * 100;
});
onAudio("ended", () => {
  if (sleep?.track) { finishSleep(); return; }
  const list = contextList();
  const last = list.indexOf(state.tracks[state.index]) === list.length - 1;
  if (state.repeat && !state.shuffle && list.length === 1) { audio.currentTime = 0; play(); return; }
  if (last && !state.repeat && !state.shuffle && !state.queue.length) return;
  step(1);
});
onAudio("error", () => { if (audio.src) step(1); });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("dialog")) return;
  const typing = e.target.tagName === "INPUT" && e.target.type !== "range";
  if (typing) return;
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

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
}

/* ---------- Velocidad ---------- */

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const fmtSpeed = (v) => `${Number(v.toFixed(2))}×`;

function setSpeed(v) {
  v = Math.min(2, Math.max(0.25, Math.round(v * 100) / 100));
  state.speed = v;
  for (const d of decks) {
    d.defaultPlaybackRate = v; // se conserva al cambiar de pista
    d.playbackRate = v;
    d.preservesPitch = true;   // cambia el tempo sin cambiar el tono
  }
  localStorage.setItem("speed", v);
  els["speed-btn"].textContent = fmtSpeed(v);
  els["speed-btn"].classList.toggle("active", v !== 1);
}

// Salta a la velocidad predefinida anterior / siguiente.
function stepSpeed(dir) {
  const next = dir > 0 ? SPEEDS.find((s) => s > state.speed + 0.001) : [...SPEEDS].reverse().find((s) => s < state.speed - 0.001);
  if (next) { setSpeed(next); toast(`Velocidad ${fmtSpeed(next)}`, 1200); }
}

els["speed-btn"].addEventListener("click", (e) => {
  showMenu(e.currentTarget, [
    ...SPEEDS.map((s) => ({ label: `${Math.abs(s - state.speed) < 0.001 ? "✓" : "\u2003"} ${fmtSpeed(s)}${s === 1 ? " (normal)" : ""}`, fn: () => setSpeed(s) })),
    ...(SPEEDS.includes(state.speed) ? [] : [{ label: `✓ ${fmtSpeed(state.speed)} (personalizada)`, disabled: true }]),
  ]);
});

/* ---------- Temporizador de apagado ---------- */

const FADE_MS = 8000;
let sleep = null; // { endAt } (tiempo) o { track: true } (al terminar la canción)

const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? h + ":" : ""}${m}:${String(s % 60).padStart(2, "0")}`;
};

function renderSleep() {
  els["sleep-btn"].classList.toggle("active", !!sleep);
  els["sleep-btn"].textContent = !sleep ? "⏲" : sleep.track ? "⏲ Fin de canción" : `⏲ ${fmtClock(sleep.endAt - Date.now())}`;
}

function setSleep(minutes) {
  const wasFading = sleep?.endAt && sleep.endAt - Date.now() < FADE_MS;
  sleep = minutes === "track" ? { track: true } : minutes ? { endAt: Date.now() + minutes * 60000 } : null;
  if (wasFading || !sleep) setVolume(+els.volume.value); // deshace un fundido a medias
  renderSleep();
}

// Detiene la reproducción y restaura el volumen.
function finishSleep() {
  sleep = null;
  audio.pause();
  setVolume(+els.volume.value);
  renderSleep();
  toast("Temporizador de apagado: música detenida");
}

function sleepTick() {
  if (!sleep) return;
  if (sleep.track) return;
  const left = sleep.endAt - Date.now();
  if (left <= 0) return finishSleep();
  // Fundido de salida durante los últimos segundos.
  if (left < FADE_MS && !audio.paused) setVolume(+els.volume.value * (left / FADE_MS));
  renderSleep();
}
setInterval(sleepTick, 500);

els["sleep-btn"].addEventListener("click", (e) => {
  const mark = (on) => (on ? "✓" : "\u2003");
  showMenu(e.currentTarget, [
    ...(sleep ? [{ label: sleep.track ? "✕ Cancelar (al terminar la canción)" : `✕ Cancelar (quedan ${fmtClock(sleep.endAt - Date.now())})`, fn: () => setSleep(null) }] : []),
    ...[15, 30, 45, 60, 90].map((m) => ({ label: `${mark(false)} ${m} minutos`, fn: () => setSleep(m) })),
    { label: `${mark(sleep?.track)} Al terminar la canción`, fn: () => setSleep("track") },
    { label: `${mark(false)} Personalizado…`, fn: () => {
        const m = parseFloat(String(prompt("¿Cuántos minutos?", "20")).replace(",", "."));
        if (m > 0 && m <= 720) setSleep(m);
      } },
  ]);
});

/* ---------- Fundido entre canciones ---------- */

const XFADES = [0, 2, 4, 6, 8, 12];
let xfade = null; // { out, inn, secs, starting, timer } mientras dura un fundido

function renderCrossfade() {
  els["xfade-btn"].textContent = state.crossfade ? `⇄ ${state.crossfade}s` : "⇄";
  els["xfade-btn"].classList.toggle("active", state.crossfade > 0);
}

function setCrossfade(s) {
  state.crossfade = s;
  localStorage.setItem("crossfade", s);
  renderCrossfade();
}

// ¿Pasará la reproducción sola a otra canción al terminar esta? (misma lógica que «ended»)
function hasNext() {
  const list = contextList();
  if (!list.length) return false;
  if (state.repeat && !state.shuffle && list.length === 1) return false; // esa canción se repite sin fundido
  const last = list.indexOf(state.tracks[state.index]) === list.length - 1;
  return !(last && !state.repeat && !state.shuffle && !state.queue.length);
}

function crossfadeCheck() {
  if (!state.crossfade || xfade || !analyser || audio.paused || sleep?.track) return;
  const dur = audio.duration;
  if (!isFinite(dur) || dur < 3) return;
  const remaining = (dur - audio.currentTime) / audio.playbackRate; // tiempo real, no de la pista
  if (remaining > Math.min(state.crossfade, dur / 3) || !hasNext()) return;
  startCrossfade(Math.max(0.5, remaining));
}
setInterval(crossfadeCheck, 200);

function startCrossfade(secs) {
  const out = audio;
  const inn = otherDeck();
  xfade = { out, inn, secs, starting: true, timer: 0 };
  audio = inn; // la canción nueva pasa a ser la activa
  inn._gain.gain.cancelScheduledValues(0);
  inn._gain.gain.value = 0;
  step(1); // carga la siguiente en `inn` y la arranca en silencio
  xfade.starting = false;
  inn.addEventListener("playing", () => rampCrossfade(inn), { once: true });
  xfade.timer = setTimeout(endCrossfade, secs * 1000 + 2500); // red de seguridad si la pista nueva no llega a sonar
}

// Cuando la pista nueva ya suena: sube una y baja la otra con curvas de potencia constante.
function rampCrossfade(inn) {
  const x = xfade;
  if (!x || x.inn !== inn) return;
  const ac = analyser.context;
  const pts = 64;
  const up = Float32Array.from({ length: pts }, (_, i) => Math.sin((i / (pts - 1)) * Math.PI / 2));
  const down = Float32Array.from({ length: pts }, (_, i) => Math.cos((i / (pts - 1)) * Math.PI / 2));
  const t0 = ac.currentTime + 0.02;
  x.out._gain.gain.cancelScheduledValues(0);
  x.out._gain.gain.setValueAtTime(1, ac.currentTime);
  x.out._gain.gain.setValueCurveAtTime(down, t0, x.secs);
  x.inn._gain.gain.setValueCurveAtTime(up, t0, x.secs);
  clearTimeout(x.timer);
  x.timer = setTimeout(endCrossfade, x.secs * 1000 + 300);
}

function endCrossfade() {
  const x = xfade;
  if (!x) return;
  xfade = null;
  clearTimeout(x.timer);
  x.out.pause();
  const now = analyser.context.currentTime;
  for (const d of [x.out, x.inn]) {
    d._gain.gain.cancelScheduledValues(0);
    d._gain.gain.setValueAtTime(1, now);
  }
}

els["xfade-btn"].addEventListener("click", (e) => {
  showMenu(e.currentTarget, [
    ...XFADES.map((s) => ({ label: `${state.crossfade === s ? "✓" : "\u2003"} ${s ? `${s} segundos` : "Sin fundido"}`, fn: () => setCrossfade(s) })),
    { label: "Solo al pasar sola a la siguiente canción", disabled: true },
  ]);
});

/* ---------- Selección múltiple ---------- */

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

els["select-btn"].addEventListener("click", () => setSelecting(!state.selecting));
els["select-done"].addEventListener("click", () => setSelecting(false));
els["select-all"].addEventListener("click", () => { shownTracks().forEach((t) => state.selected.add(t)); render(); });
els["select-none"].addEventListener("click", () => { state.selected.clear(); render(); });
els["select-edit"].addEventListener("click", () => {
  // Se editan en el orden en que aparecen en la lista.
  const picked = state.tracks.filter((t) => state.selected.has(t));
  if (picked.length) openEditor(picked);
});

/* ---------- Editor de etiquetas ---------- */

// editing: { tracks, batch, touched, cover, previewUrl }
//   touched: campos que el usuario ha tocado (en lote solo se cambian esos)
//   cover: undefined (sin cambios) | Blob | false (quitar)
let editing = null;
const FIELDS = ["title", "artist", "album"];
const sameValue = (tracks, get) => {
  const v = get(tracks[0]);
  return tracks.every((t) => get(t) === v) ? v : null;
};

function paintEditCover() {
  const c = editing.cover;
  let url = null;
  if (c instanceof Blob) url = editing.previewUrl ??= URL.createObjectURL(c);
  else if (c === undefined) url = editing.batch ? null : editing.tracks[0].orig.coverUrl;
  els["edit-cover"].style.backgroundImage = url ? `url(${url})` : "";
  els["edit-cover"].classList.toggle("has-art", !!url);
}

function setDraftCover(v) {
  if (editing.previewUrl) URL.revokeObjectURL(editing.previewUrl);
  editing.previewUrl = null;
  editing.cover = v;
  paintEditCover();
}

// Abre el editor para una canción o, con varias, en modo lote.
function openEditor(target) {
  const tracks = Array.isArray(target) ? target : [target];
  const batch = tracks.length > 1;
  editing = { tracks, batch, touched: new Set(), cover: batch ? undefined : tracks[0].edits?.cover, previewUrl: null };
  els["edit-heading"].textContent = batch ? `Editar ${tracks.length} canciones` : "Editar etiquetas";
  els["edit-note"].textContent = batch
    ? "Solo se cambian los campos que modifiques; el resto se queda como está. Tus archivos originales no se modifican."
    : "Los cambios se guardan en esta aplicación; tus archivos originales no se modifican.";
  els["edit-reset"].textContent = batch ? "Restaurar originales" : "Restaurar original";
  for (const f of FIELDS) {
    const v = batch ? sameValue(tracks, (t) => t[f]) : tracks[0][f];
    els[`edit-${f}`].value = v ?? "";
    els[`edit-${f}`].placeholder = batch && v === null ? "(varios valores)" : "";
  }
  paintEditCover();
  els["edit-download"].hidden = true;
  els["edit-download"].textContent = batch ? "Guardar y descargar copias" : "Guardar y descargar copia";
  Promise.all(tracks.map((t) => TagWriter.kind(t.file))).then((kinds) => {
    if (editing?.tracks === tracks) els["edit-download"].hidden = !kinds.some(Boolean); // solo MP3 y FLAC
  });
  els["edit-dialog"].showModal();
  const first = els[batch ? "edit-artist" : "edit-title"];
  first.focus();
  first.select();
}

// Reduce las imágenes grandes para no inflar el almacenamiento ni las miniaturas.
async function shrinkImage(file, max = 800) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400 * 1024) return file;
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  } catch {
    return null;
  }
}

// Guarda las ediciones de una pista (null = sin ediciones) y refresca lo que se muestra.
function commitEdits(tracks, apply) {
  for (const t of tracks) {
    const e = apply(t);
    t.edits = e && Object.keys(e).length ? e : null;
    applyEdits(t);
    if (t.id != null) Storage.setEdits(t.id, t.edits).catch(() => {});
  }
  const current = state.tracks[state.index];
  if (tracks.includes(current)) showMeta(current);
  render();
}

function saveEditor() {
  const { tracks, batch, touched, cover } = editing;
  const values = Object.fromEntries(FIELDS.map((f) => [f, els[`edit-${f}`].value.trim()]));
  commitEdits(tracks, (t) => {
    const e = { ...t.edits };
    for (const f of FIELDS) {
      if (batch && !touched.has(f)) continue; // en lote, lo que no se toca se deja como está
      const changed = f === "title" ? values.title && values.title !== t.orig.title : values[f] !== t.orig[f];
      if (changed) e[f] = values[f]; else delete e[f];
    }
    if (cover !== undefined) e.cover = cover;
    else if (!batch) delete e.cover;
    return e;
  });
  if (batch) toast(`${tracks.length} canciones actualizadas`);
  els["edit-dialog"].close();
  return tracks;
}

/* ---------- Copias con etiquetas escritas (MP3 y FLAC) ---------- */

// Genera una copia del archivo con las ediciones escritas dentro. Devuelve "ok", "sin-formato" o "sin-cambios".
async function downloadEditedCopy(t) {
  const format = await TagWriter.kind(t.file);
  if (!format) return "sin-formato";
  const e = t.edits;
  if (!e) return "sin-cambios";
  const edits = {};
  for (const f of FIELDS) if (f in e) edits[f] = e[f];
  if ("cover" in e) edits.cover = e.cover;

  const blob = await TagWriter.write(t.file, format, edits);

  // Comprobación: se vuelve a leer la copia con nuestro lector y debe mostrar lo mismo que la app.
  const check = await Tags.read(new File([blob], t.fileName));
  const wrong = FIELDS.some((f) => f in edits && check[f] !== t[f])
    || (edits.cover instanceof Blob && check.cover?.size !== edits.cover.size)
    || (edits.cover === false && check.cover);
  if (wrong) throw new Error("La copia no coincide con las ediciones");

  const ext = (t.fileName.match(/\.[^.]+$/) || [""])[0];
  download(`${t.fileName.replace(/\.[^.]+$/, "")} (editado)${ext}`, blob);
  return "ok";
}

async function downloadCopies(tracks) {
  const n = { ok: 0, "sin-formato": 0, "sin-cambios": 0, error: 0 };
  for (const t of tracks) {
    try { n[await downloadEditedCopy(t)]++; } catch { n.error++; }
    if (tracks.length > 1) await new Promise((r) => setTimeout(r, 400)); // el navegador agrupa las descargas múltiples
  }
  const msg = [];
  if (n.ok) msg.push(`${n.ok} copia(s) descargada(s)`);
  if (n["sin-cambios"]) msg.push(`${n["sin-cambios"]} sin ediciones`);
  if (n["sin-formato"]) msg.push(`${n["sin-formato"]} no son MP3/FLAC`);
  if (n.error) msg.push(`${n.error} con error`);
  toast(msg.join(" · "), 5000);
}

els["edit-form"].addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
els["edit-cancel"].addEventListener("click", () => els["edit-dialog"].close());
els["edit-download"].addEventListener("click", async () => downloadCopies(saveEditor()));
els["edit-dialog"].addEventListener("click", (e) => { if (e.target === els["edit-dialog"]) els["edit-dialog"].close(); }); // clic fuera
els["edit-dialog"].addEventListener("close", () => {
  if (editing?.previewUrl) URL.revokeObjectURL(editing.previewUrl);
  editing = null;
});
for (const f of FIELDS) els[`edit-${f}`].addEventListener("input", () => editing?.touched.add(f));
els["edit-reset"].addEventListener("click", () => {
  const { tracks, batch } = editing;
  if (batch) {
    if (!confirm(`¿Restaurar los datos originales de ${tracks.length} canciones? Se pierden sus ediciones.`)) return;
    commitEdits(tracks, () => null);
    toast(`${tracks.length} canciones restauradas`);
    els["edit-dialog"].close();
    return;
  }
  for (const f of FIELDS) els[`edit-${f}`].value = tracks[0].orig[f];
  setDraftCover(undefined);
});
els["edit-cover-clear"].addEventListener("click", () => setDraftCover(false));
els["edit-cover-input"].addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !f.type.startsWith("image/")) return;
  const img = await shrinkImage(f);
  if (img && editing) setDraftCover(img); else toast("No se pudo leer la imagen");
});
// Doble clic sobre el título o el artista de la canción actual abre el editor.
els.title.parentElement.addEventListener("dblclick", () => { const t = state.tracks[state.index]; if (t) openEditor(t); });

/* ---------- Tema ---------- */

// Preferencia: "auto" (sigue al sistema), "light" o "dark". El tema efectivo vive en <html data-theme>.
const THEMES = { auto: ["◐", "Automático (sigue al sistema)"], light: ["☀", "Claro"], dark: ["☾", "Oscuro"] };
const themeQuery = matchMedia("(prefers-color-scheme: light)");

function applyTheme(pref) {
  if (!THEMES[pref]) pref = "auto";
  const effective = pref === "auto" ? (themeQuery.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = effective;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effective === "light" ? "#eceef5" : "#0e1015");
  els["theme-btn"].textContent = THEMES[pref][0];
  els["theme-btn"].title = `Tema: ${THEMES[pref][1]} (clic para cambiar)`;
  els["theme-btn"].dataset.pref = pref;
}

els["theme-btn"].addEventListener("click", () => {
  const order = Object.keys(THEMES);
  const next = order[(order.indexOf(els["theme-btn"].dataset.pref) + 1) % order.length];
  localStorage.setItem("theme", next);
  applyTheme(next);
  toast(`Tema: ${THEMES[next][1]}`, 1500);
});
themeQuery.addEventListener("change", () => applyTheme(localStorage.getItem("theme") || "auto"));
applyTheme(localStorage.getItem("theme") || "auto");

/* ---------- Arranque ---------- */

(async function init() {
  els.shuffle.setAttribute("aria-pressed", state.shuffle);
  els.repeat.setAttribute("aria-pressed", state.repeat);
  try {
    const saved = await Storage.all();
    const order = JSON.parse(localStorage.getItem("order") || "[]");
    const rank = (r) => { const k = order.indexOf(r.id); return k < 0 ? order.length + r.id : k; };
    saved.sort((a, b) => rank(a) - rank(b));
    for (const rec of saved) state.tracks.push(await makeTrack(rec.id, rec.blob, rec.lyrics || "", rec.edits || null));
    const last = state.tracks.findIndex((t) => String(t.id) === localStorage.getItem("lastId"));
    if (state.tracks.length) loadTrack(last >= 0 ? last : 0, false, "all");
    const ids = new Set(state.tracks.map((t) => t.id));
    state.playlists.forEach((p) => (p.ids = p.ids.filter((id) => ids.has(id))));
    savePlaylists();
  } catch { /* IndexedDB no disponible */ }
  buildEqUi();
  setSpeed(Number(localStorage.getItem("speed")) || 1);
  renderCrossfade();
  renderSleep();
  toggleLyrics(localStorage.getItem("lyrics") !== "1");
  renderViews();
  render();
})();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
