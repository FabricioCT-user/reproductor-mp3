// Base compartida: acceso seguro a localStorage, elementos de audio y del DOM, estado global, avisos y menús.

const $ = (id) => document.getElementById(id);

// localStorage puede estar bloqueado (modo privado) o tener datos corruptos: nunca debe romper la aplicación.
const store = {
  get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* sin espacio o bloqueado */ } },
  json(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
};

// Dos elementos multimedia (<video>, que también reproduce audio): uno suena y el otro entra durante un fundido
// cruzado (ver «Fundido»). Viven fijos en el escenario (#stage): sacarlos del DOM los pausaría, así que mientras la
// pista es de audio el escenario solo se oculta con CSS.
const decks = [$("deck-a"), $("deck-b")];

let media = decks[0]; // el deck activo: lo que muestran la barra de progreso, los controles, etc.

const otherDeck = () => decks[media === decks[0] ? 1 : 0];

const onMedia = (type, fn) => decks.forEach((d) => d.addEventListener(type, (e) => { if (d === media) fn(e); }));

const setVolume = (v) => decks.forEach((d) => (d.volume = v));

const setMuted = (m) => decks.forEach((d) => (d.muted = m));

const els = Object.fromEntries(
  ["dropzone", "backdrop", "cover", "stage", "fs-controls", "fs-current", "fs-seek", "fs-duration", "fs-play", "fs-play-icon",
   "fs-mute", "fs-volume", "fs-subs", "fs-exit",
   "title", "artist", "viz", "seek", "current", "duration", "play", "play-icon",
   "prev", "next", "shuffle", "repeat", "mute", "volume", "filter", "file-input", "clear", "playlist",
   "view", "media-filter", "pl-new", "pl-more", "pl-import", "pl-rename", "pl-delete", "menu",
   "eq-toggle", "eq-panel", "eq-preset", "eq-on", "eq-reset", "eq-bands",
   "lyrics", "lyrics-body", "lyrics-toggle", "lyrics-clear", "lrc-input", "sub-input", "toast", "folder-input",
   "speed-btn", "sleep-btn", "theme-btn", "xfade-btn",
   "select-btn", "select-bar", "select-count", "select-all", "select-none", "select-edit", "select-done",
   "edit-heading", "edit-note", "edit-dialog", "edit-form", "edit-cover", "edit-cover-input", "edit-cover-clear", "edit-title", "edit-artist", "edit-album", "edit-reset", "edit-cancel", "edit-download",
   "prompt-dialog", "prompt-form", "prompt-title", "prompt-input", "prompt-cancel"]
    .map((id) => [id, $(id)])
);

const state = {
  tracks: [],
  index: -1,
  shuffle: store.get("shuffle") === "1",
  repeat: store.get("repeat") === "1",
  filter: "",
  mediaFilter: store.get("mediaFilter", "all"),
  queue: [],
  speed: clamp(Number(store.get("speed")) || 1, 0.25, 2),
  crossfade: clamp(Math.round(Number(store.get("crossfade")) || 0), 0, 12),
  selecting: false,
  selected: new Set(), // pistas marcadas en el modo de selección
  anchor: null,        // última marcada, para seleccionar rangos con Mayús
  playlists: cleanPlaylists(store.json("playlists", [])),
  view: "all",      // "all" o id de lista: lo que se muestra
  playView: "all",  // vista desde la que se inició la reproducción (define siguiente/anterior)
};

let toastTimer;

function toast(msg, ms = 3500) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

function download(name, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Menú flotante genérico: items = [{ label, fn, disabled, keepOpen }].
function showMenu(anchor, items) {
  const m = els.menu;
  const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
  if (m.parentElement !== host) host.append(m);
  m.replaceChildren(
    ...items.map(({ label, fn, disabled, keepOpen }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener("click", () => { if (!keepOpen) closeMenu(); fn?.(); });
      return b;
    })
  );
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${r.bottom + m.offsetHeight + 8 > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4}px`;
}

function closeMenu() {
  els.menu.hidden = true;
  if (els.menu.parentElement !== document.body) document.body.append(els.menu);
}

// Cierra el menú flotante al hacer clic fuera o con Escape.
function wireMenu() {
  document.addEventListener("click", (e) => { if (!els.menu.contains(e.target)) closeMenu(); }, true);

  document.addEventListener("keydown", (e) => { if (e.code === "Escape") closeMenu(); });

  els["prompt-form"].addEventListener("submit", (e) => {
    e.preventDefault();
    finishPrompt(els["prompt-input"].value);
    els["prompt-dialog"].close();
  });
  els["prompt-cancel"].addEventListener("click", () => {
    finishPrompt(null);
    els["prompt-dialog"].close();
  });
  els["prompt-dialog"].addEventListener("close", () => finishPrompt(null));
}

let promptResolve = null;

function finishPrompt(value) {
  const resolve = promptResolve;
  if (!resolve) return;
  promptResolve = null;
  resolve(value);
}

// Diálogo modal propio para pedir un texto (sustituye a window.prompt, ausente en Electron).
function pedirTexto({ titulo = "", valor = "", placeholder = "" } = {}) {
  finishPrompt(null);
  const dlg = els["prompt-dialog"];
  const input = els["prompt-input"];
  els["prompt-title"].textContent = titulo;
  input.value = valor ?? "";
  input.placeholder = placeholder ?? "";
  return new Promise((resolve) => {
    promptResolve = resolve;
    dlg.showModal();
    input.focus();
    input.select();
  });
}
