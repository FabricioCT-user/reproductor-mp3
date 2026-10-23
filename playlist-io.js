// Serialización de listas de reproducción: JSON propio (con todas las listas) y M3U8 estándar.
// Las canciones se identifican por datos portables (nombre de archivo, tamaño, título, artista),
// porque los ids internos de la biblioteca no valen en otro navegador.
const PlaylistIO = (() => {
  const FORMAT = "reproductor-mp3-playlists";

  // lists: [{ name, refs: [{ file, size, title, artist }] }]
  function toJSON(lists) {
    return JSON.stringify(
      { format: FORMAT, version: 1, exported: new Date().toISOString(), playlists: lists.map((l) => ({ name: l.name, tracks: l.refs })) },
      null, 2
    );
  }

  function parseJSON(text) {
    const data = JSON.parse(text);
    if (data?.format !== FORMAT || !Array.isArray(data.playlists)) throw new Error("No es un archivo de listas de este reproductor");
    return data.playlists
      .filter((p) => p && typeof p.name === "string" && Array.isArray(p.tracks))
      .map((p) => ({
        name: p.name.trim() || "Lista importada",
        refs: p.tracks
          .filter((r) => r && (typeof r.file === "string" || typeof r.title === "string"))
          .map((r) => ({
            file: typeof r.file === "string" ? r.file : "",
            size: Number.isFinite(r.size) ? r.size : null,
            title: typeof r.title === "string" ? r.title : "",
            artist: typeof r.artist === "string" ? r.artist : "",
          })),
      }));
  }

  function toM3U(refs) {
    const lines = ["#EXTM3U"];
    for (const r of refs) {
      lines.push(`#EXTINF:-1,${[r.artist, r.title].filter(Boolean).join(" - ")}`, r.file);
    }
    return lines.join("\n") + "\n";
  }

  // Devuelve una lista con las rutas del M3U reducidas al nombre de archivo.
  function parseM3U(text, name) {
    const refs = [];
    let info = null;
    for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        const label = line.slice(line.indexOf(",") + 1).trim();
        const sep = label.indexOf(" - ");
        info = sep > 0 ? { artist: label.slice(0, sep), title: label.slice(sep + 3) } : { artist: "", title: label };
        continue;
      }
      if (line.startsWith("#")) continue;
      let file = line.split(/[\\/]/).pop();
      try { file = decodeURIComponent(file); } catch { /* se deja tal cual */ }
      refs.push({ file, size: null, title: info?.title || "", artist: info?.artist || "" });
      info = null;
    }
    return [{ name, refs }];
  }

  return { toJSON, parseJSON, toM3U, parseM3U };
})();
