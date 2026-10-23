// Parser de letras: formato LRC sincronizado ([mm:ss.xx]texto) o texto plano.
// Devuelve { synced, lines: [{ t, text }] } (t solo si está sincronizada, en segundos).
const Lyrics = (() => {
  const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const WORD_STAMP = /<\d+:\d+(?:[.:]\d+)?>/g; // LRC "enhanced": tiempos por palabra
  const ID_TAG = /^\[[a-z]{2,}:[^\]]*\]\s*$/i;  // [ar:..] [ti:..] [al:..]
  const OFFSET = /^\[offset:\s*([+-]?\d+)\]/i;

  const looksSynced = (raw) => /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(raw);

  function parse(raw) {
    const lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
    const timed = [];
    const plain = [];
    let offset = 0;

    for (const line of lines) {
      const off = line.match(OFFSET);
      if (off) { offset = Number(off[1]) / 1000; continue; }
      if (ID_TAG.test(line)) continue;

      const stamps = [...line.matchAll(STAMP)];
      const text = line.replace(STAMP, "").replace(WORD_STAMP, "").trim();
      if (stamps.length) {
        for (const m of stamps) {
          const frac = m[3] ? Number("0." + m[3]) : 0;
          timed.push({ t: Math.max(0, Number(m[1]) * 60 + Number(m[2]) + frac - offset), text });
        }
      } else {
        plain.push({ text });
      }
    }

    if (timed.length) return { synced: true, lines: timed.sort((a, b) => a.t - b.t) };

    while (plain.length && !plain[0].text) plain.shift();
    while (plain.length && !plain[plain.length - 1].text) plain.pop();
    return { synced: false, lines: plain };
  }

  return { parse, looksSynced };
})();
