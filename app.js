const $ = (id) => document.getElementById(id);

const audio = $("audio");
const els = Object.fromEntries(
  ["dropzone", "backdrop", "cover", "title", "artist", "viz", "seek", "current", "duration", "play", "play-icon",
   "prev", "next", "shuffle", "repeat", "mute", "volume", "filter", "file-input", "clear", "playlist"]
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
  if (state.index === -1 && state.tracks.length) loadTrack(0, false);
}

function removeTrack(i) {
  const [t] = state.tracks.splice(i, 1);
  state.queue = state.queue.filter((q) => q !== t);
  if (t.id != null) Storage.remove(t.id).catch(() => {});
  URL.revokeObjectURL(t.url);
  if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);

  if (i === state.index) {
    audio.pause();
    audio.removeAttribute("src");
    state.index = -1;
    showTrack(null);
    if (state.tracks.length) loadTrack(Math.min(i, state.tracks.length - 1), false);
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
  state.index = -1;
  await Storage.clear().catch(() => {});
  showTrack(null);
  render();
}

function render() {
  const q = state.filter.toLowerCase();
  const rows = state.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));

  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = state.tracks.length ? "Sin resultados." : "Tu biblioteca está vacía. Arrastra archivos de audio aquí o pulsa «+ Añadir».";
    els.playlist.replaceChildren(li);
    return;
  }

  els.playlist.replaceChildren(
    ...rows.map(({ t, i }) => {
      const li = document.createElement("li");
      li.classList.toggle("active", i === state.index);

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

      const qb = document.createElement("button");
      qb.className = "t-btn";
      qb.title = qpos ? "Quitar de la cola" : "Reproducir a continuación";
      qb.textContent = qpos ? "−" : "+";
      qb.addEventListener("click", (e) => { e.stopPropagation(); toggleQueue(t); });

      const rm = document.createElement("button");
      rm.className = "t-btn remove";
      rm.title = "Quitar de la biblioteca";
      rm.textContent = "✕";
      rm.addEventListener("click", (e) => { e.stopPropagation(); removeTrack(i); });

      li.append(thumb, text, qb, rm);
      li.addEventListener("click", () => loadTrack(i, true));

      if (!q) {
        li.draggable = true;
        li.addEventListener("dragstart", (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
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
          moveTrack(dragFrom, i + (dropBefore(e, li) ? 0 : 1));
        });
      }
      return li;
    })
  );
}

let dragFrom = -1;
const dropBefore = (e, li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
const clearDropMarks = () => els.playlist.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));

function moveTrack(from, to) {
  if (to > from) to--;
  if (to === from) return render();
  const current = state.tracks[state.index];
  const [t] = state.tracks.splice(from, 1);
  state.tracks.splice(to, 0, t);
  state.index = state.tracks.indexOf(current);
  localStorage.setItem("order", JSON.stringify(state.tracks.map((x) => x.id).filter((id) => id != null)));
  render();
}

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

function loadTrack(i, autoplay) {
  state.index = i;
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

function step(dir) {
  const n = state.tracks.length;
  if (!n) return;
  if (dir > 0 && state.queue.length) return loadTrack(state.tracks.indexOf(state.queue.shift()), true);
  let i;
  if (state.shuffle && n > 1) {
    do { i = Math.floor(Math.random() * n); } while (i === state.index);
  } else {
    i = (state.index + dir + n) % n;
  }
  loadTrack(i, true);
}

function togglePlay() {
  if (!state.tracks.length) return;
  if (state.index === -1) return loadTrack(0, true);
  audio.paused ? play() : audio.pause();
}

function setToggle(btn, key, value) {
  state[key] = value;
  btn.setAttribute("aria-pressed", value);
  localStorage.setItem(key, value ? "1" : "0");
}

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
  ac.createMediaElementSource(audio).connect(analyser);
  analyser.connect(ac.destination);
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
  const last = state.index === state.tracks.length - 1;
  if (state.repeat && !state.shuffle && state.tracks.length === 1) { audio.currentTime = 0; play(); return; }
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
    if (state.tracks.length) loadTrack(last >= 0 ? last : 0, false);
  } catch { /* IndexedDB no disponible */ }
  render();
})();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
