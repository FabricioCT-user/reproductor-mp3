// Biblioteca: canciones (con sus ediciones), importación, lista en pantalla, reordenar y selección múltiple.

const META_VERSION = 2;
const trackMeta = (m, file) => ({
  title: m.title || "", artist: m.artist || "", album: m.album || "", lyrics: m.lyrics || "",
  hasCover: !!(m.hasCover ?? m.cover), duration: m.duration ?? null, kind: m.kind || (file.type.startsWith("video/") ? "video" : "audio"),
  width: m.width ?? null, height: m.height ?? null, codecs: m.codecs ?? null,
  year: m.year || "", genre: m.genre || "", description: m.description || "", show: m.show || "",
  season: m.season ?? null, episode: m.episode ?? null, rotation: m.rotation ?? 0, chapters: m.chapters || [],
});

// Video enlazado por la app de escritorio (T2.1): se comporta como un File de solo lectura (name, size, type,
// lastModified, slice().arrayBuffer()) pero no se copia nunca: sus bytes se piden por Range a
// app://reproductor/__media/<linkId>, que sirve el proceso principal. Antes de enlazarlo solo lleva el id de la
// entrega (`entrega`) que mandó el principal. La ruta del disco no llega nunca a la página.
class LinkedFile {
  constructor(info, { linkId = null, entrega = null, offset = 0 } = {}) {
    this.name = String(info.name || "");
    this.size = Number(info.size) || 0;
    this.type = info.type || "";
    this.lastModified = Number(info.lastModified) || 0;
    this.linkId = linkId;
    this.entrega = entrega;
    this.offset = offset;
  }

  get url() { return `__media/${this.linkId}`; }

  slice(start = 0, end = this.size, type = "") {
    const at = (n) => (n < 0 ? Math.max(this.size + n, 0) : Math.min(n, this.size));
    const a = at(start);
    const b = Math.max(a, at(end));
    const info = { name: this.name, size: b - a, type, lastModified: this.lastModified };
    return new LinkedFile(info, { linkId: this.linkId, offset: this.offset + a });
  }

  async arrayBuffer() {
    if (!this.size) return new ArrayBuffer(0);
    const res = await fetch(this.url, { headers: { Range: `bytes=${this.offset}-${this.offset + this.size - 1}` } });
    if (res.status !== 206) throw new Error(`No se pudo leer el video enlazado (${res.status})`);
    return res.arrayBuffer();
  }
}

// Registro guardado con source "link" → su LinkedFile (o null si el registro no tiene un id válido).
const linkedFile = (rec) => (/^[0-9a-f]{32}$/.test(rec.linkId || "")
  ? new LinkedFile({ name: rec.name, size: rec.size, type: rec.type, lastModified: rec.lastModified }, { linkId: rec.linkId })
  : null);

// En la app de escritorio los videos se enlazan en vez de copiarse. Devuelve el LinkedFile enlazado, o null si hay que
// copiarlo como siempre (versión web, audio, o un File sin ruta en el disco, p. ej. uno creado por la página).
async function linkVideo(file) {
  const app = window.reproductor;
  if (!app?.enlazar || !isVideo(file)) return null;
  if (file instanceof LinkedFile && file.linkId) return file;
  const info = await app.enlazar(file instanceof LinkedFile ? file.entrega : file).catch(() => null);
  if (!info?.linkId) {
    if (file instanceof LinkedFile) throw new Error("no se pudo enlazar"); // sin bytes que copiar
    return null;
  }
  const linked = new LinkedFile(info, { linkId: info.linkId });
  linked.relPath = pathOf(file);
  if (Array.isArray(info.subtitulos) && info.subtitulos.length) linked.companionSubs = info.subtitulos;
  return linked;
}

const forgetLink = (t) => { if (t.linkId) window.reproductor?.olvidar?.(t.linkId).catch(() => {}); };

const isMp4File = (f) => /\.(mp4|m4v|m4a|mov)$/i.test(f.name)
  || /^video\/(mp4|quicktime|x-m4v)$/i.test(f.type || "")
  || /^audio\/(mp4|x-m4a)$/i.test(f.type || "");

const isMkvFile = (f) => /\.(webm|mkv)$/i.test(f.name)
  || /^(video|audio)\/(webm|x-matroska)$/i.test(f.type || "");

function assessTrackCompat(t) {
  const res = checkCompatibility({
    kind: t.meta?.kind,
    ext: extOf(t.fileName),
    mime: t.file?.type || "",
    codecs: t.meta?.codecs || "",
  }, (type) => media.canPlayType(type));
  t.compatWarning = res.ok ? null : res.reason;
  t.ac3Unsupported = res.ac3Unsupported;
}

async function makeTrack(id, file, userLyrics = "", edits = null, cachedMeta = null, savedSubs = []) {
  const meta = cachedMeta || await Tags.read(file);
  let probedCached = false;
  if (isMp4File(file) && (!cachedMeta || cachedMeta.codecs == null)) {
    try {
      const info = await MP4.probe(file);
      if (info.kind) meta.kind = info.kind;
      meta.codecs = info.codecs;
      probedCached = !!cachedMeta;
    } catch { /* tipo MIME como alternativa */ }
  } else if (isMkvFile(file) && (!cachedMeta || cachedMeta.codecs == null)) {
    try {
      const info = await MKV.probe(file);
      if (info.kind) meta.kind = info.kind;
      meta.codecs = info.codecs;
      probedCached = !!cachedMeta;
    } catch { /* tipo MIME como alternativa */ }
  }
  if (!meta.kind && isVideo(file)) meta.kind = "video";
  const savedMeta = trackMeta(meta, file);
  if (probedCached && id != null) Storage.setMeta(id, savedMeta, META_VERSION).catch(() => {});
  const fallback = file.name.replace(/\.[^.]+$/, "");
  const subs = typeof normalizeSubs === "function" ? normalizeSubs(savedSubs) : [];
  const t = {
    id,
    file,                 // el archivo original, para poder generar copias con etiquetas
    fileBase: fallback.toLowerCase(),
    fileName: file.name,
    size: file.size,
    key: fileKey(file),   // para no importar dos veces el mismo archivo
    dir: dirOf(pathOf(file)),
    embeddedLyrics: savedMeta.lyrics,
    meta: savedMeta,
    userLyrics,
    subs,
    subIndex: subs.length ? 0 : -1,
    _lastSubIndex: 0,
    url: file instanceof LinkedFile ? file.url : URL.createObjectURL(file),
    linkId: file instanceof LinkedFile ? file.linkId : null,
    // Datos del archivo; lo que se muestra (title, artist, album, coverUrl) sale de aplicar las ediciones encima.
    orig: { title: savedMeta.title || fallback, artist: savedMeta.artist, album: savedMeta.album, coverUrl: null },
    edits,
  };
  applyEdits(t);
  assessTrackCompat(t);
  return t;
}

// Conserva en la biblioteca los metadatos de un registro cuyo archivo ya no está disponible.
async function makeUnavailableTrack(rec) {
  const meta = rec.meta || {};
  const fileName = rec.name || "Archivo sin nombre";
  const fallback = fileName.replace(/\.[^.]+$/, "");
  const subs = typeof normalizeSubs === "function" ? normalizeSubs(rec.subs) : [];
  const t = {
    id: rec.id, file: null, fileBase: fallback.toLowerCase(), fileName,
    size: rec.size || 0, key: `${fileName}|${rec.size || 0}|${rec.lastModified || 0}`,
    meta,
    dir: "", embeddedLyrics: null, userLyrics: rec.lyrics || "", subs, subIndex: subs.length ? 0 : -1, _lastSubIndex: 0,
    url: null, unavailable: true,
    linkId: rec.source === "link" ? rec.linkId : null,
    orig: { title: meta.title || fallback, artist: meta.artist || "", album: meta.album || "", coverUrl: null },
    edits: rec.edits || null,
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

// Lee la carátula una sola vez por pista y comparte la lectura entre la lista, el reproductor y el editor.
function loadCover(t) {
  if (!t || !state.tracks.includes(t) || !t.file || !t.meta?.hasCover || t.edits?.cover === false) return Promise.resolve();
  if (t._coverLoaded) return Promise.resolve();
  if (t._coverPromise) return t._coverPromise;
  t._coverPromise = Tags.readCover(t.file).then(async (cover) => {
    if (cover && !(cover instanceof Blob)) cover = new Blob([await cover.arrayBuffer()], { type: cover.type }); // enlazado
    if (!state.tracks.includes(t)) return;
    t._coverLoaded = true;
    if (cover) t.orig.coverUrl = URL.createObjectURL(cover);
    applyEdits(t);
    if (state.tracks[state.index] === t) showMeta(t);
    render();
  }).catch(() => {}).finally(() => { t._coverPromise = null; });
  return t._coverPromise;
}

async function addFiles(fileList) {
  const all = [...fileList];
  // Con carpetas, ordena por ruta para que los álbumes queden en orden (01, 02, … 10).
  if (all.some((f) => pathOf(f).includes("/"))) all.sort(byPath);
  const companionFiles = all.filter(isCompanion);
  const listFiles = all.filter(isListFile);
  const files = all.filter(isMedia);
  const unsupportedVideos = all.filter((f) => !isMedia(f) && !isCompanion(f) && !isListFile(f) && UNSUPPORTED_VIDEO_EXT.has(extOf(f.name)));

  let added = 0;
  let dupes = 0;
  let failed = 0;
  let noSpace = 0;
  let storeErr = 0;
  let compatWarned = 0;
  let lastCompatReason = "";
  const linkedSubs = [];
  const keys = new Set(state.tracks.map((t) => t.key));
  for (const [i, file] of files.entries()) {
    const key = fileKey(file);
    if (keys.has(key)) { dupes++; continue; }
    keys.add(key);
    if (files.length > 5 && i % 10 === 0) toast(`Importando ${i + 1}/${files.length}…`, 60000);
    let id = null;
    let storeFail = null;
    let link = null;
    try {
      link = await linkVideo(file);
      const src = link || file;
      const track = await makeTrack(null, src);
      const extra = link ? { source: "link", linkId: link.linkId, kind: track.meta.kind } : {};
      try { id = await Storage.add(src, { meta: track.meta, metaVersion: META_VERSION, ...extra }); track.id = id; }
      catch (e) { storeFail = e?.name === "QuotaExceededError" ? "quota" : "other"; }
      state.tracks.push(track);
      if (link?.companionSubs?.length) linkedSubs.push({ track, items: link.companionSubs });
      added++;
      if (track.compatWarning) { compatWarned++; lastCompatReason = track.compatWarning; }
      if (storeFail === "quota") noSpace++;
      else if (storeFail) storeErr++;
      if (added % 25 === 0) render();
    } catch {
      failed++; // un archivo ilegible no debe detener el resto de la importación
      keys.delete(key);
      if (id != null) Storage.remove(id).catch(() => {});
      if (link) window.reproductor.olvidar(link.linkId).catch(() => {});
    }
  }

  const resolved = added ? resolvePending() : 0;
  const comp = companionFiles.length ? await attachCompanionFiles(companionFiles) : null;
  let autoSubs = 0;
  for (const { track, items } of linkedSubs) {
    for (const it of items) {
      if (!it?.id || it.kind !== "subtitulo") continue;
      try {
        const bytes = await window.reproductor.leer(it.id);
        if (!bytes) continue;
        const text = Subtitles.decode(bytes);
        const before = track.subs.length;
        const addedSub = await addSubTrack(track, text, subtitleLabel(it.name, track.fileBase));
        if (addedSub && track.subs.length > before) autoSubs++;
      } catch { /* subtítulo acompañante ilegible o caducado: se omite */ }
    }
  }
  const imp = listFiles.length ? await importPlaylistFiles(listFiles) : null;
  render();
  if (state.index === -1 && state.tracks.length) loadTrack(0, false, "all");

  const msg = [];
  if (added) msg.push(`${added} pista(s) añadida(s)`);
  if (dupes) msg.push(`${dupes} ya estaba(n) en la biblioteca`);
  if (failed) msg.push(`${failed} no se pudieron leer`);
  if (noSpace) msg.push(`${noSpace} ${noSpace === 1 ? "pista" : "pistas"} solo para esta sesión: no hay espacio`);
  if (storeErr) msg.push(`${storeErr} ${storeErr === 1 ? "pista" : "pistas"} solo para esta sesión: no se pudo guardar`);
  if (compatWarned === 1 && added === 1 && !dupes && !failed && !noSpace && !storeErr) {
    msg.length = 0;
    msg.push(`Puede no reproducirse: ${lastCompatReason}`);
  } else if (compatWarned) {
    msg.push(`${compatWarned} puede(n) no reproducirse`);
  }
  if (comp?.lyricsMatched) msg.push(`letra para ${comp.lyricsMatched}`);
  if (comp?.lyricsMissed) msg.push(`${comp.lyricsMissed} .lrc sin pareja`);
  const subsMatched = (comp?.subsMatched || 0) + autoSubs;
  if (subsMatched) msg.push(`subtítulos para ${subsMatched}`);
  if (comp?.subsMissed) msg.push(`${comp.subsMissed} subtítulo(s) sin pareja`);
  if (resolved) msg.push(`${resolved} pista(s) completan listas importadas`);
  if (imp) msg.push(...importSummary(imp));
  if (unsupportedVideos.length && !added && !dupes && !failed && !companionFiles.length && !listFiles.length) {
    msg.push(explainFailure("video", extOf(unsupportedVideos[0].name), ""));
  } else if (unsupportedVideos.length) {
    msg.push(`${unsupportedVideos.length} formato(s) no compatible(s) (${extOf(unsupportedVideos[0].name).toUpperCase()})`);
  } else if (all.length && !files.length && !companionFiles.length && !listFiles.length) {
    msg.push("No se encontró ningún archivo multimedia");
  }
  const warnImportant = noSpace > 0 || storeErr > 0 || compatWarned > 0 || unsupportedVideos.length > 0;
  if (msg.length && (warnImportant || !(added === 1 && all.length === 1 && !autoSubs))) toast(msg.join(" · "), warnImportant ? 6000 : undefined);
  else els.toast.hidden = true;
}

// Archivos que el sistema entrega a la app instalada («Abrir con…» o doble clic en un archivo de audio):
// se añaden a la biblioteca, suena el primero y los demás quedan en la cola.
// Los .lrc/.srt/.vtt que llegan junto al medio se asocian por nombre.
async function openFromSystem(files) {
  const mediaFiles = files.filter(isMedia);
  if (!mediaFiles.length) return;
  await addFiles([...mediaFiles, ...files.filter(isCompanion)]);
  const trackOf = (f) => state.tracks.find((t) => t.key === fileKey(f));
  const first = trackOf(mediaFiles[0]);
  if (!first) return;
  loadTrack(state.tracks.indexOf(first), true, "all");
  for (const f of mediaFiles.slice(1)) {
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

// App de escritorio (window.reproductor): el proceso principal entrega { id, name, size, lastModified, type, kind, rel? }
// (nunca rutas). El audio y las letras se piden por id para copiarlos a IndexedDB; los videos no se leen: quedan como
// LinkedFile pendiente y addFiles los enlaza (solo si de verdad entran en la biblioteca).
async function filesFromApp(items) {
  const files = [];
  for (const it of items || []) {
    if (it?.kind === "video" && typeof it.id === "string") {
      const f = new LinkedFile(it, { entrega: it.id });
      if (typeof it.rel === "string") f.relPath = it.rel;
      files.push(f);
      continue;
    }
    if (it?.kind !== "audio" && it?.kind !== "letra" && it?.kind !== "subtitulo") continue;
    try {
      const bytes = await window.reproductor.leer(it.id);
      if (!bytes) continue; // el archivo ya no está o el id caducó
      const f = new File([bytes], it.name, { type: it.type || "", lastModified: it.lastModified });
      if (typeof it.rel === "string") f.relPath = it.rel;
      files.push(f);
    } catch { /* el archivo ya no está o el id caducó: se omite */ }
  }
  return files;
}

// Fuentes de «Abrir con…»/doble clic: launchQueue (app web instalada en Chrome o Edge) y la app de escritorio.
function wireSystemOpen(ready) {
  if ("launchQueue" in window) window.launchQueue.setConsumer((params) => ready.then(() => consumeLaunch(params)));

  const app = window.reproductor;
  if (!app?.onAbrir) return;
  let chain = ready; // de uno en uno, en el orden en que llegan
  app.onAbrir((items) => { chain = chain.then(() => filesFromApp(items)).then(openFromSystem).catch(() => {}); });

  // En la app, «+ Añadir» y «+ Carpeta» abren el diálogo nativo (así los videos podrán enlazarse en T2.1).
  for (const [input, carpeta] of [[els["file-input"], false], [els["folder-input"], true]]) {
    input.closest("label").addEventListener("click", (e) => {
      if (e.target === input) return;
      e.preventDefault();
      app.elegirArchivos({ carpeta })
        .catch(() => { input.click(); return []; }) // si el diálogo nativo falla, el selector de siempre
        .then(filesFromApp)
        .then((files) => (files.length ? addFiles(files) : undefined))
        .catch(() => {});
    });
  }
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
  forgetLink(t);
  URL.revokeObjectURL(t.url);
  revokeCovers(t);

  if (i === state.index) {
    endCrossfade();
    media.pause();
    media.removeAttribute("src");
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
  media.pause();
  media.removeAttribute("src");
  state.tracks.forEach((t) => { URL.revokeObjectURL(t.url); revokeCovers(t); forgetLink(t); });
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
  const kind = state.mediaFilter;
  const pl = currentPlaylist();
  const tracks = listTracks(state.view);
  const rows = tracks
    .map((t, pos) => ({ t, pos }))
    .filter(({ t }) => (kind === "all" || (t.meta?.kind || "audio") === kind)
      && (!q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)));

  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = tracks.length && (q || kind !== "all") ? "Sin resultados."
      : pl ? "Esta lista está vacía. Usa el botón ♫ de una pista para añadirla."
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
      li.classList.toggle("unavailable", t.unavailable);
      li.classList.toggle("compat-warn", !!t.compatWarning);
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
      if (t.meta?.kind === "video") {
        thumb.classList.add("video-thumb");
        const playMark = document.createElement("span");
        playMark.className = "video-mark";
        playMark.setAttribute("aria-hidden", "true");
        playMark.textContent = "▶";
        thumb.append(playMark);
      }
      if (t.meta?.hasCover && t.edits?.cover !== false) loadCover(t);
      if (t.coverUrl) thumb.style.backgroundImage = `url(${t.coverUrl})`;
      else if (t.meta?.kind !== "video") {
        thumb.textContent = "♪";
      }

      const text = document.createElement("div");
      text.className = "t-text";
      const name = document.createElement("div");
      name.className = "t-name";
      name.textContent = t.title;
      const sub = document.createElement("div");
      sub.className = "t-sub";
      const qpos = state.queue.indexOf(t) + 1;
      const video = t.meta?.kind === "video";
      const shortEdge = video && t.meta.width > 0 && t.meta.height > 0 ? Math.min(t.meta.width, t.meta.height) : 0;
      const resolution = shortEdge ? `${[2160, 1440, 1080, 720, 480, 360].find((n) => shortEdge >= n) || Math.round(shortEdge)}p` : "";
      const program = video
        ? (t.meta.show
          ? `${t.meta.show}${t.meta.season != null ? ` · T${t.meta.season}` : ""}${t.meta.episode != null ? ` · E${t.meta.episode}` : ""}`
          : [t.artist, t.meta?.year].filter(Boolean).join(" · "))
        : [t.artist, t.album].filter(Boolean).join(" · ");
      sub.textContent = (t.unavailable ? "No disponible · " : "") + (qpos ? `En cola #${qpos} · ` : "")
        + [resolution, program || (!video && t.album ? t.album : "Artista desconocido")].filter(Boolean).join(" · ");
      text.append(name, sub);
      if (t.compatWarning) {
        const warn = document.createElement("div");
        warn.className = "t-warn";
        warn.textContent = `⚠ Puede no reproducirse: ${t.compatWarning}`;
        warn.title = warn.textContent;
        text.append(warn);
      }

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
      qb.disabled = eb.disabled = !!t.unavailable;
      const pb = btn("t-btn", "Añadir a una lista", "♫", (b) => openMenu(b, t));
      const rm = pl
        ? btn("t-btn remove", "Quitar de esta lista", "✕", () => removeFromPlaylist(pl, t))
        : btn("t-btn remove", "Quitar de la biblioteca", "✕", () => removeTrack(i));

      li.append(...(state.selecting ? [check] : []), thumb, text, qb, pb, eb, rm);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === li) li.click(); });
      li.addEventListener("click", (e) => {
        if (t.unavailable) { toast("Este archivo no está disponible", 4000); return; }
        if (state.selecting) return toggleSelect(t, shown, e.shiftKey);
        if (e.ctrlKey || e.metaKey) { setSelecting(true); return toggleSelect(t, shown, false); } // atajo para entrar en el modo
        loadTrack(i, true, state.view);
      });

      if (!q && kind === "all" && !state.selecting) {
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

const shownTracks = () => listTracks(state.view).filter((t) => (state.mediaFilter === "all" || (t.meta?.kind || "audio") === state.mediaFilter) && matchesFilter(t));

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

  els["media-filter"].value = ["all", "audio", "video"].includes(state.mediaFilter) ? state.mediaFilter : "all";
  state.mediaFilter = els["media-filter"].value;
  els["media-filter"].addEventListener("change", () => {
    state.mediaFilter = els["media-filter"].value;
    store.set("mediaFilter", state.mediaFilter);
    render();
  });

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
