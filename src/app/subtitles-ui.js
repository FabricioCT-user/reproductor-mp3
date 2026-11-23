// Subtítulos en el reproductor: pistas WebVTT en <track> sobre el deck activo, menú, desfase y persistencia.

const MAX_SUB_BYTES = 5 * 1024 * 1024;
const parsedSubsCache = new WeakMap();
const deckSubUrls = new WeakMap();

function cuesOf(sub) {
  if (!sub?.text) return [];
  const cached = parsedSubsCache.get(sub);
  if (cached && cached.text === sub.text) return cached.cues;
  const cues = Subtitles.parse(sub.text).cues;
  parsedSubsCache.set(sub, { text: sub.text, cues });
  return cues;
}

function normalizeSubs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== "object" || typeof s.text !== "string") continue;
    const entry = {
      label: typeof s.label === "string" && s.label.trim() ? s.label.trim().slice(0, 120) : "Subtítulos",
      text: s.text,
      offset: Number.isFinite(Number(s.offset)) ? Math.round(Number(s.offset) * 1000) / 1000 : 0,
    };
    if (typeof s.lang === "string" && s.lang.trim()) entry.lang = s.lang.trim().slice(0, 32);
    out.push(entry);
  }
  return out;
}

function fmtSubOffset(offset) {
  const n = Number.isFinite(offset) ? Math.round(offset * 10) / 10 : 0;
  const clean = Object.is(n, -0) ? 0 : n;
  const sign = clean > 0 ? "+" : clean < 0 ? "−" : "";
  return `${sign}${Math.abs(clean).toFixed(1).replace(".", ",")} s`;
}

// Quita todos los <track> de un deck y revoca sus blob: URL.
function clearSubTracks(deck) {
  if (!deck) return;
  for (const tr of [...deck.querySelectorAll("track")]) tr.remove();
  const urls = deckSubUrls.get(deck);
  if (urls) {
    for (const u of urls) URL.revokeObjectURL(u);
    urls.length = 0;
  }
}

function syncSubButtons() {
  const t = state.tracks[state.index];
  const video = isVideoTrack(t);
  const active = video && t.subIndex >= 0 && !!t.subs?.[t.subIndex];
  if (video) {
    els["lyrics-toggle"].classList.toggle("active", active);
    els["lyrics-toggle"].setAttribute("aria-pressed", String(active));
  }
  if (els["fs-subs"]) {
    els["fs-subs"].classList.toggle("oculto", !video);
    els["fs-subs"].classList.toggle("active", active);
    els["fs-subs"].setAttribute("aria-pressed", String(active));
  }
}

// Monta el <track> de subtítulos activo sobre el deck actual y limpia el anterior.
function syncSubtitles() {
  clearSubTracks(otherDeck());
  clearSubTracks(media);
  const t = state.tracks[state.index];
  if (!isVideoTrack(t) || !t.subs?.length || t.subIndex < 0 || t.subIndex >= t.subs.length) {
    syncSubButtons();
    return;
  }
  const sub = t.subs[t.subIndex];
  const vtt = Subtitles.toVtt(cuesOf(sub), sub.offset);
  const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
  const urls = deckSubUrls.get(media) || [];
  urls.push(url);
  deckSubUrls.set(media, urls);

  const tr = document.createElement("track");
  tr.kind = "subtitles";
  tr.label = sub.label;
  if (sub.lang) tr.srclang = sub.lang;
  tr.default = true;
  tr.src = url;
  tr.addEventListener("load", () => { if (tr.track && tr.isConnected) tr.track.mode = "showing"; }, { once: true });
  media.append(tr);
  if (tr.track) tr.track.mode = "showing";
  syncSubButtons();
}

async function saveSubs(t) {
  if (t?.id != null) await Storage.setSubs(t.id, t.subs).catch(() => {});
}

// Añade una pista de subtítulos a `t` (evitando duplicados exactos) y la persiste.
async function addSubTrack(t, rawText, meta = {}, { activate = false } = {}) {
  if (!t || typeof rawText !== "string") return null;
  const cues = Subtitles.parse(rawText).cues;
  if (!cues.length) return null;
  t.subs ||= [];

  const existingIdx = t.subs.findIndex((s) => s.text === rawText);
  if (existingIdx >= 0) {
    if (activate) {
      t.subIndex = existingIdx;
      t._lastSubIndex = existingIdx;
      if (t === state.tracks[state.index]) syncSubtitles();
    }
    return t.subs[existingIdx];
  }

  let baseLabel = typeof meta.label === "string" && meta.label.trim() ? meta.label.trim().slice(0, 120) : "Subtítulos";
  let label = baseLabel;
  let n = 2;
  while (t.subs.some((s) => s.label === label)) label = `${baseLabel} (${n++})`;

  const entry = { label, text: rawText, offset: 0 };
  if (typeof meta.lang === "string" && meta.lang.trim()) entry.lang = meta.lang.trim().slice(0, 32);
  parsedSubsCache.set(entry, { text: rawText, cues });
  t.subs.push(entry);

  const idx = t.subs.length - 1;
  if (activate || t.subIndex == null || t.subIndex < 0) {
    t.subIndex = idx;
    t._lastSubIndex = idx;
  }
  await saveSubs(t);
  if (t === state.tracks[state.index]) syncSubtitles();
  return entry;
}

async function removeSubTrack(t, idx) {
  if (!t?.subs || idx < 0 || idx >= t.subs.length) return;
  t.subs.splice(idx, 1);
  if (!t.subs.length) {
    t.subIndex = -1;
    t._lastSubIndex = 0;
  } else if (t.subIndex === idx) {
    t.subIndex = Math.min(idx, t.subs.length - 1);
    t._lastSubIndex = t.subIndex;
  } else if (t.subIndex > idx) {
    t.subIndex--;
    t._lastSubIndex = t.subIndex;
  }
  await saveSubs(t);
  if (t === state.tracks[state.index]) syncSubtitles();
}

function setActiveSub(t, idx) {
  if (!t?.subs) return;
  if (idx < 0 || idx >= t.subs.length) {
    if (t.subIndex >= 0) t._lastSubIndex = t.subIndex;
    t.subIndex = -1;
  } else {
    t.subIndex = idx;
    t._lastSubIndex = idx;
  }
  if (t === state.tracks[state.index]) syncSubtitles();
}

async function setSubOffset(t, value) {
  if (!t?.subs || t.subIndex < 0 || t.subIndex >= t.subs.length) return null;
  const rounded = Math.round(Number(value) * 10) / 10;
  const next = Number.isFinite(rounded) ? (Object.is(rounded, -0) ? 0 : rounded) : 0;
  const sub = t.subs[t.subIndex];
  sub.offset = next;
  await saveSubs(t);
  if (t === state.tracks[state.index]) syncSubtitles();
  return next;
}

function adjustSubOffset(t, delta) {
  if (!t?.subs || t.subIndex < 0 || t.subIndex >= t.subs.length) return Promise.resolve(null);
  return setSubOffset(t, (t.subs[t.subIndex].offset || 0) + delta);
}

function stepSubOffset(delta) {
  const t = state.tracks[state.index];
  if (!isVideoTrack(t) || !t.subs?.length || t.subIndex < 0) return;
  adjustSubOffset(t, delta).then((off) => {
    if (off != null) toast(`Desfase de subtítulos: ${fmtSubOffset(off)}`, 1500);
  });
}

function toggleSubtitles() {
  const t = state.tracks[state.index];
  if (!isVideoTrack(t)) return;
  if (!t.subs?.length) {
    toast("No hay subtítulos para este video", 2000);
    return;
  }
  if (t.subIndex >= 0) {
    setActiveSub(t, -1);
    toast("Subtítulos desactivados", 1500);
  } else {
    const restore = t._lastSubIndex >= 0 && t._lastSubIndex < t.subs.length ? t._lastSubIndex : 0;
    setActiveSub(t, restore);
    toast(`Subtítulos: ${t.subs[restore].label}`, 1500);
  }
}

async function loadSubtitleFiles(t, fileList) {
  if (!t) return 0;
  let loaded = 0;
  let invalid = 0;
  for (const f of [...fileList]) {
    if (!f || f.size > MAX_SUB_BYTES) { invalid++; continue; }
    try {
      const text = Subtitles.decode(await f.arrayBuffer());
      const added = await addSubTrack(t, text, subtitleLabel(f.name, t.fileBase), { activate: true });
      if (added) loaded++;
      else invalid++;
    } catch {
      invalid++;
    }
  }
  if (loaded) toast(loaded === 1 ? "Subtítulos cargados" : `${loaded} pistas de subtítulos cargadas`);
  else if (invalid) toast("No se encontraron subtítulos válidos");
  return loaded;
}

function openSubtitlesMenu(anchor) {
  const t = state.tracks[state.index];
  if (!isVideoTrack(t)) return;
  const subs = t.subs || [];
  const active = t.subIndex >= 0 && subs[t.subIndex] ? subs[t.subIndex] : null;
  const mark = (on) => (on ? "✓" : "\u2003");
  const items = [];

  if (subs.length) {
    items.push({ label: `${mark(t.subIndex === -1)} Desactivados`, fn: () => setActiveSub(t, -1) });
    subs.forEach((s, idx) => {
      items.push({ label: `${mark(t.subIndex === idx)} ${s.label}`, fn: () => setActiveSub(t, idx) });
    });
    if (active) {
      items.push({ label: `Desfase: ${fmtSubOffset(active.offset)}`, disabled: true });
      items.push({ label: "Adelantar −0,1 s (Z)", keepOpen: true, fn: () => { adjustSubOffset(t, -0.1).then(() => { if (!els.menu.hidden) openSubtitlesMenu(anchor); }); } });
      items.push({ label: "Retrasar +0,1 s (X)", keepOpen: true, fn: () => { adjustSubOffset(t, 0.1).then(() => { if (!els.menu.hidden) openSubtitlesMenu(anchor); }); } });
      if (active.offset) {
        items.push({ label: "Restablecer desfase (0,0 s)", keepOpen: true, fn: () => { setSubOffset(t, 0).then(() => { if (!els.menu.hidden) openSubtitlesMenu(anchor); }); } });
      }
      items.push({ label: "Quitar esta pista", fn: () => removeSubTrack(t, t.subIndex) });
    }
  } else {
    items.push({ label: "Sin subtítulos", disabled: true });
  }

  items.push({ label: "Cargar subtítulos…", fn: () => els["sub-input"].click() });
  showMenu(anchor, items);
}

function wireSubtitles() {
  els["sub-input"].addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    const t = state.tracks[state.index];
    if (!files.length || !t) return;
    await loadSubtitleFiles(t, files);
  });
}
