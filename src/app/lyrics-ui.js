// Letras: panel sobre la carátula, resaltado de la línea actual y letras cargadas por el usuario.

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

// Empareja archivos acompañantes (.lrc, .srt, .vtt) con pistas de la biblioteca por nombre (o título).
function matchCompanionTrack(f, { allowPrefix = false } = {}) {
  const stem = f.name.replace(/\.[^.]+$/, "").toLowerCase();
  const dir = dirOf(pathOf(f));
  const matches = (base) => base && (stem === base || (allowPrefix && stem.startsWith(base + ".")));
  const rank = (list, keyFn) => list.slice().sort((a, b) => {
    const lenDiff = keyFn(b).length - keyFn(a).length;
    if (lenDiff) return lenDiff;
    const dirDiff = (b.dir === dir ? 1 : 0) - (a.dir === dir ? 1 : 0);
    if (dirDiff) return dirDiff;
    if (allowPrefix) return (isVideoTrack(b) ? 1 : 0) - (isVideoTrack(a) ? 1 : 0);
    return 0;
  })[0];

  const byFile = state.tracks.filter((x) => matches(x.fileBase));
  if (byFile.length) return rank(byFile, (x) => x.fileBase);
  const byTitle = state.tracks.filter((x) => matches(x.title.toLowerCase()));
  return byTitle.length ? rank(byTitle, (x) => x.title.toLowerCase()) : null;
}

async function attachCompanionFiles(companionFiles) {
  let lyricsMatched = 0;
  let lyricsMissed = 0;
  let subsMatched = 0;
  let subsMissed = 0;
  for (const f of companionFiles) {
    if (isLrc(f)) {
      const t = matchCompanionTrack(f, { allowPrefix: false });
      if (!t) { lyricsMissed++; continue; }
      await setUserLyrics(t, await f.text());
      lyricsMatched++;
    } else if (isSubtitle(f)) {
      const t = matchCompanionTrack(f, { allowPrefix: true });
      if (!t || f.size > MAX_SUB_BYTES) { subsMissed++; continue; }
      try {
        const text = Subtitles.decode(await f.arrayBuffer());
        const added = await addSubTrack(t, text, subtitleLabel(f.name, t.fileBase));
        if (added) subsMatched++;
        else subsMissed++;
      } catch {
        subsMissed++;
      }
    }
  }
  return { lyricsMatched, lyricsMissed, subsMatched, subsMissed };
}

async function attachLrcFiles(lrcFiles) {
  const r = await attachCompanionFiles(lrcFiles);
  return { matched: r.lyricsMatched, missed: r.lyricsMissed };
}

let lyricCursor = -1;

function renderLyrics() {
  const t = state.tracks[state.index];
  const video = isVideoTrack(t);
  const btn = els["lyrics-toggle"];
  btn.textContent = video ? "Subtítulos" : "Letra";
  btn.title = video ? "Subtítulos (C)" : "Letra (L)";
  if (video) {
    els.lyrics.hidden = true;
    if (typeof syncSubButtons === "function") syncSubButtons();
    else {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", false);
    }
    return;
  }
  const L = parsedLyrics(t);
  btn.classList.toggle("active", !!L);
  els["lyrics-clear"].hidden = !t?.userLyrics;
  lyricCursor = -1;

  if (!L) {
    const p = document.createElement("p");
    p.className = "lyrics-empty";
    p.textContent = t ? "No hay letra para esta pista. Carga un archivo .lrc, o súbelo junto al audio con el mismo nombre." : "";
    els["lyrics-body"].replaceChildren(p);
    return;
  }

  els["lyrics-body"].classList.toggle("synced", L.synced);
  els["lyrics-body"].replaceChildren(
    ...L.lines.map((line) => {
      const d = document.createElement("div");
      d.className = "lyric-line" + (line.text ? "" : " gap");
      d.textContent = line.text || "♪";
      if (L.synced) d.addEventListener("click", () => { media.currentTime = line.t; });
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
  for (let i = 0; i < L.lines.length && L.lines[i].t <= media.currentTime + 0.15; i++) idx = i;
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
  if (isVideoTrack(state.tracks[state.index])) return;
  els.lyrics.hidden = force ?? !els.lyrics.hidden;
  els["lyrics-toggle"].setAttribute("aria-pressed", !els.lyrics.hidden);
  store.set("lyrics", els.lyrics.hidden ? "0" : "1");
  if (!els.lyrics.hidden) { lyricCursor = -1; syncLyrics(); }
}

// Botón de letra, cargar / quitar .lrc y seguimiento de la línea actual.
function wireLyrics() {
  els["lyrics-toggle"].addEventListener("click", (e) => {
    if (isVideoTrack(state.tracks[state.index])) {
      if (typeof openSubtitlesMenu === "function") openSubtitlesMenu(e.currentTarget);
    } else {
      toggleLyrics();
    }
  });

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
}
