// Subtítulos: lectura de SRT y WebVTT, decodificación de bytes y generación de WebVTT limpio.
// Módulo puro (sin DOM). Tolerante: ante un archivo corrupto devuelve lo que pueda, nunca lanza.
//   Subtitles.decode(bytes)            → string (UTF-8, UTF-16 con BOM o windows-1252)
//   Subtitles.parse(text, nameHint)    → { cues: [{ start, end, text }] } (segundos, ordenados por inicio)
//   Subtitles.toVtt(cues, offset)      → string WebVTT (offset en segundos, sin tiempos negativos)
const Subtitles = (() => {
  const MAX_CUES = 50000;       // límites contra entradas hostiles
  const MAX_LINE = 5000;
  const MAX_TEXT = 5000;

  // [horas:]mm:ss[.,]mmm  (las horas y los milisegundos son opcionales)
  const TIME = "(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{1,2})(?:[.,](\\d{1,3}))?";
  const TIMING = new RegExp("^\\s*" + TIME + "\\s*-->\\s*" + TIME);
  const BLOCK_SKIP = /^(NOTE|STYLE|REGION)(\s|$)/;

  const seconds = (h, m, s, ms) =>
    Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, "0")) / 1000 : 0);

  const ENTITIES = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "", rlm: "" };
  const decodeEntities = (s) => s.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, n) => ENTITIES[n]);

  // Quita etiquetas que no sean <i> <b> <u> (font, c.clase, v, marcas <00:01.000>) y órdenes ASS {\an8}.
  function cleanText(lines) {
    const t = lines.join("\n")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/<\/?(?![ibu]>)[a-zA-Z][^<>\n]{0,200}>|<\d+:\d+(?:[.:]\d+)*>/gi, "");
    return decodeEntities(t).trim().slice(0, MAX_TEXT);
  }

  function decode(bytes) {
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8.subarray(2));
      if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder("utf-16be").decode(u8.subarray(2));
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(u8).replace(/^﻿/, "");
      } catch {
        return new TextDecoder("windows-1252").decode(u8);
      }
    } catch {
      return "";
    }
  }

  function parse(text, nameHint) { // nameHint (nombre del archivo) no hace falta: ambos formatos se leen igual
    const cues = [];
    try {
      const lines = String(text == null ? "" : text).replace(/^﻿/, "").split(/\r\n|\r|\n/);
      let i = 0;
      while (i < lines.length && cues.length < MAX_CUES) {
        const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
        const m = TIMING.exec(line);
        if (!m) {
          // Bloques sin tiempos (cabecera WEBVTT, NOTE, STYLE, REGION): se saltan enteros hasta la línea vacía.
          if (BLOCK_SKIP.test(line.trim()) || /^WEBVTT/.test(line)) {
            while (i < lines.length && lines[i].trim() !== "") i++;
          } else {
            i++;
          }
          continue;
        }
        i++;
        const body = [];
        while (i < lines.length && lines[i].trim() !== "") {
          const l = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
          if (TIMING.test(l)) break; // falta la línea vacía: empieza otra cue (la línea anterior era su índice)
          body.push(l);
          i++;
        }
        // Si la última línea es solo un número y justo después viene otra cue, es el índice de la siguiente.
        if (body.length && i < lines.length && TIMING.test(lines[i]) && /^\d+$/.test(body[body.length - 1].trim())) body.pop();
        const start = seconds(m[1], m[2], m[3], m[4]);
        const end = seconds(m[5], m[6], m[7], m[8]);
        const t = cleanText(body);
        if (t && end > start) cues.push({ start, end, text: t });
      }
    } catch {
      // devolvemos lo reunido hasta aquí
    }
    return { cues: cues.sort((a, b) => a.start - b.start) };
  }

  const pad = (n, w) => String(n).padStart(w, "0");
  function stamp(sec) {
    const total = Math.round(sec * 1000);
    const ms = total % 1000;
    const s = Math.floor(total / 1000);
    return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}.${pad(ms, 3)}`;
  }

  // Escapa & < > salvo las etiquetas <i> <b> <u>; «-->» y las líneas vacías romperían la cue.
  function escapeText(t) {
    return t.split(/(<\/?[ibu]>)/i).map((part, k) =>
      k % 2 ? part.toLowerCase() : part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    ).join("").split("\n").filter((l) => l.trim() !== "").join("\n");
  }

  function toVtt(cues, offset) {
    const off = Number.isFinite(offset) ? offset : 0;
    const out = ["WEBVTT", ""];
    for (const c of Array.isArray(cues) ? cues : []) {
      if (!c || !Number.isFinite(c.start) || !Number.isFinite(c.end)) continue;
      const start = Math.max(0, c.start + off);
      const end = Math.max(0, c.end + off);
      const text = escapeText(String(c.text == null ? "" : c.text));
      if (end <= start || !text) continue;
      out.push(`${stamp(start)} --> ${stamp(end)}`, text, "");
    }
    return out.join("\n");
  }

  return { parse, decode, toVtt };
})();
