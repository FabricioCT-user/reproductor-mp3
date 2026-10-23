const $ = (id) => document.getElementById(id);

const audio = $("audio");
const els = Object.fromEntries(
  ["dropzone", "backdrop", "cover", "title", "artist", "viz", "seek", "current", "duration", "play", "play-icon",
   "prev", "next", "shuffle", "repeat", "mute", "volume", "filter", "file-input", "clear", "playlist",
   "view", "pl-new", "pl-rename", "pl-delete", "menu",
   "eq-toggle", "eq-panel", "eq-preset", "eq-on", "eq-reset", "eq-bands"]
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
  playlists: JSON.parse(localStorage.getItem("playlists") || "[]"),
  view: "all",      // "all" o id de lista: lo que se muestra
  playView: "all",  // vista desde la que se inició la reproducción (define siguiente/anterior)
};

const formatTime = (s) => {
  if (!isFinite(s)) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/* ---------- Biblioteca ---------- */

async function makeTrack(id, file) {
  const meta = await ID3.read(file);
  const fallback = file.name.replace(/\.[^.]+$/, "");
  return {
    id,
    url: URL.createObjectURL(file),
    title: meta.title || fallback,
    artist: meta.artist,
    album: meta.album,
    coverUrl: meta.cover ? URL.createObjectURL(meta.cover) : null,
  };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("audio/"));
  for (const file of files) {
    let id = null;
    try { id = await Storage.add(file); } catch { /* sin persistencia: se usa solo en memoria */ }
    state.tracks.push(await makeTrack(id, file));
  }
  render();
  if (state.index === -1 && state.tracks.length) loadTrack(0, false, "all");
}

function removeTrack(i) {
  const [t] = state.tracks.splice(i, 1);
  state.queue = state.queue.filter((q) => q !== t);
  if (t.id != null) { state.playlists.forEach((p) => (p.ids = p.ids.filter((id) => id !== t.id))); savePlaylists(); }
  if (t.id != null) Storage.remove(t.id).catch(() => {});
  URL.revokeObjectURL(t.url);
  if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);

  if (i === state.index) {
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
  audio.pause();
  audio.removeAttribute("src");
  state.tracks.forEach((t) => { URL.revokeObjectURL(t.url); t.coverUrl && URL.revokeObjectURL(t.coverUrl); });
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
      : "Tu biblioteca está vacía. Arrastra archivos de audio aquí o pulsa «+ Añadir».";
    els.playlist.replaceChildren(li);
    return;
  }

  const current = state.tracks[state.index];
  els.playlist.replaceChildren(
    ...rows.map(({ t, pos }) => {
      const i = state.tracks.indexOf(t);
      const li = document.createElement("li");
      li.classList.toggle("active", t === current);

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
      const pb = btn("t-btn", "Añadir a una lista", "♫", (b) => openMenu(b, t));
      const rm = pl
        ? btn("t-btn remove", "Quitar de esta lista", "✕", () => removeFromPlaylist(pl, t))
        : btn("t-btn remove", "Quitar de la biblioteca", "✕", () => removeTrack(i));

      li.append(thumb, text, qb, pb, rm);
      li.addEventListener("click", () => loadTrack(i, true, state.view));

      if (!q) {
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
    })
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

function openMenu(anchor, t) {
  const m = els.menu;
  m.replaceChildren();
  const item = (label, fn, disabled) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener("click", () => { closeMenu(); fn(); });
    m.append(b);
  };
  if (t.id == null) {
    item("No disponible: el navegador no permite guardar la biblioteca", () => {}, true);
  } else {
    for (const p of state.playlists) item(`${p.ids.includes(t.id) ? "✓" : " "} ${p.name}`, () => togglePlaylistMember(p, t));
    item("+ Nueva lista…", () => { const p = createPlaylist(); if (p) togglePlaylistMember(p, t); });
  }
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

function showTrack(t) {
  els.title.textContent = t ? t.title : "Nada en reproducción";
  els.artist.textContent = t ? [t.artist, t.album].filter(Boolean).join(" · ") || "Artista desconocido" : "Añade música para empezar";
  els.cover.style.backgroundImage = t?.coverUrl ? `url(${t.coverUrl})` : "";
  els.cover.classList.toggle("has-art", !!t?.coverUrl);
  els.backdrop.style.backgroundImage = t?.coverUrl ? `url(${t.coverUrl})` : "";
  els.backdrop.classList.toggle("on", !!t?.coverUrl);
  els.seek.disabled = !t;
  els.seek.value = 0;
  els.current.textContent = els.duration.textContent = "0:00";
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

function loadTrack(i, autoplay, view = "all") {
  state.index = i;
  state.playView = view;
  const t = state.tracks[i];
  audio.src = t.url;
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
  let node = ac.createMediaElementSource(audio);
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
  audio.addEventListener("play", () => ac.resume());
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
els.clear.addEventListener("click", clearLibrary);
els.view.addEventListener("change", () => setView(els.view.value));
els["pl-new"].addEventListener("click", () => { const p = createPlaylist(); if (p) setView(p.id); });
els["pl-rename"].addEventListener("click", renamePlaylist);
els["pl-delete"].addEventListener("click", deletePlaylist);
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
  addFiles(e.dataTransfer.files);
});

els.play.addEventListener("click", togglePlay);
els.prev.addEventListener("click", () => { audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1); });
els.next.addEventListener("click", () => step(1));
els.shuffle.addEventListener("click", () => setToggle(els.shuffle, "shuffle", !state.shuffle));
els.repeat.addEventListener("click", () => setToggle(els.repeat, "repeat", !state.repeat));

els.volume.value = localStorage.getItem("volume") ?? 1;
audio.volume = els.volume.value;
els.volume.addEventListener("input", () => {
  audio.volume = els.volume.value;
  audio.muted = false;
  localStorage.setItem("volume", els.volume.value);
});
els.mute.addEventListener("click", () => (audio.muted = !audio.muted));
audio.addEventListener("volumechange", () => (els.mute.style.opacity = audio.muted ? 0.35 : ""));

els.seek.addEventListener("input", () => {
  if (audio.duration) audio.currentTime = (els.seek.value / 100) * audio.duration;
});

audio.addEventListener("play", () => (els["play-icon"].innerHTML = ICON_PAUSE));
audio.addEventListener("pause", () => (els["play-icon"].innerHTML = ICON_PLAY));
audio.addEventListener("loadedmetadata", () => (els.duration.textContent = formatTime(audio.duration)));
audio.addEventListener("timeupdate", () => {
  els.current.textContent = formatTime(audio.currentTime);
  if (audio.duration) els.seek.value = (audio.currentTime / audio.duration) * 100;
});
audio.addEventListener("ended", () => {
  const list = contextList();
  const last = list.indexOf(state.tracks[state.index]) === list.length - 1;
  if (state.repeat && !state.shuffle && list.length === 1) { audio.currentTime = 0; play(); return; }
  if (last && !state.repeat && !state.shuffle && !state.queue.length) return;
  step(1);
});
audio.addEventListener("error", () => { if (audio.src) step(1); });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
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
  }
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
}

/* ---------- Arranque ---------- */

(async function init() {
  els.shuffle.setAttribute("aria-pressed", state.shuffle);
  els.repeat.setAttribute("aria-pressed", state.repeat);
  try {
    const saved = await Storage.all();
    const order = JSON.parse(localStorage.getItem("order") || "[]");
    const rank = (r) => { const k = order.indexOf(r.id); return k < 0 ? order.length + r.id : k; };
    saved.sort((a, b) => rank(a) - rank(b));
    for (const rec of saved) state.tracks.push(await makeTrack(rec.id, rec.blob));
    const last = state.tracks.findIndex((t) => String(t.id) === localStorage.getItem("lastId"));
    if (state.tracks.length) loadTrack(last >= 0 ? last : 0, false, "all");
    const ids = new Set(state.tracks.map((t) => t.id));
    state.playlists.forEach((p) => (p.ids = p.ids.filter((id) => ids.has(id))));
    savePlaylists();
  } catch { /* IndexedDB no disponible */ }
  buildEqUi();
  renderViews();
  render();
})();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
