// Listas de reproducción con nombre, y exportar / importar (JSON y M3U8).

const currentPlaylist = () => state.playlists.find((p) => p.id === state.view);

function listTracks(view) {
  const p = state.playlists.find((x) => x.id === view);
  if (!p) return state.tracks;
  return p.ids.map((id) => state.tracks.find((t) => t.id === id)).filter(Boolean);
}

const savePlaylists = () => store.set("playlists", JSON.stringify(state.playlists));

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

const refOf = (t) => ({ file: t.fileName, size: t.size, title: t.title, artist: t.artist });

const refsOf = (p) => [...listTracks(p.id).map(refOf), ...(p.pending || [])];

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

// Selector de lista, crear / renombrar / eliminar, menú de exportar e importar.
function wirePlaylists() {
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
}
