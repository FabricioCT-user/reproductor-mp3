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
  store.set("lyrics", els.lyrics.hidden ? "0" : "1");
  if (!els.lyrics.hidden) { lyricCursor = -1; syncLyrics(); }
}

// Botón de letra, cargar / quitar .lrc y seguimiento de la línea actual.
function wireLyrics() {
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
}
