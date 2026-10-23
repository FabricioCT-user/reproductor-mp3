// Editor de etiquetas (una canción o varias a la vez) y copias con las etiquetas escritas.

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

// Formulario, carátula, restaurar y descargar copias.
function wireEditor() {
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
}
