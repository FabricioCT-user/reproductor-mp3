// Temporizador de apagado y fundido entre canciones.

const FADE_MS = 8000;

let sleep = null; // { endAt } (tiempo) o { track: true } (al terminar la canción)

function renderSleep() {
  els["sleep-btn"].classList.toggle("active", !!sleep);
  els["sleep-btn"].textContent = !sleep ? "⏲" : sleep.track ? "⏲ Fin de pista" : `⏲ ${fmtClock(sleep.endAt - Date.now())}`;
}

function setSleep(minutes) {
  const wasFading = sleep?.endAt && sleep.endAt - Date.now() < FADE_MS;
  sleep = minutes === "track" ? { track: true } : minutes ? { endAt: Date.now() + minutes * 60000 } : null;
  if (wasFading || !sleep) setVolume(+els.volume.value); // deshace un fundido a medias
  renderSleep();
}

// Detiene la reproducción y restaura el volumen.
function finishSleep() {
  sleep = null;
  media.pause();
  setVolume(+els.volume.value);
  renderSleep();
  toast("Temporizador de apagado: música detenida");
}

function sleepTick() {
  if (!sleep) return;
  if (sleep.track) return;
  const left = sleep.endAt - Date.now();
  if (left <= 0) return finishSleep();
  // Fundido de salida durante los últimos segundos.
  if (left < FADE_MS && !media.paused) setVolume(+els.volume.value * (left / FADE_MS));
  renderSleep();
}

const XFADES = [0, 2, 4, 6, 8, 12];

let xfade = null; // { out, inn, secs, starting, timer } mientras dura un fundido

function renderCrossfade() {
  els["xfade-btn"].textContent = state.crossfade ? `⇄ ${state.crossfade}s` : "⇄";
  els["xfade-btn"].classList.toggle("active", state.crossfade > 0);
}

function setCrossfade(s) {
  state.crossfade = s;
  store.set("crossfade", s);
  renderCrossfade();
}

// ¿Pasará la reproducción sola a otra canción al terminar esta? (misma lógica que «ended»)
function hasNext() {
  const current = state.tracks[state.index];
  if (isVideoTrack(current)) return false;
  if (state.queue.length) {
    const queued = state.queue.find((q) => !q.unavailable);
    if (queued) return !isVideoTrack(queued);
  }
  const list = contextList();
  if (!list.length) return false;
  if (state.repeat && !state.shuffle && list.length === 1) return false; // esa canción se repite sin fundido
  const pos = list.indexOf(current);
  const last = pos === list.length - 1;
  if (last && !state.repeat && !state.shuffle) return false;
  const next = peekNext();
  if (!next || isVideoTrack(next)) return false;
  return true;
}

function crossfadeCheck() {
  if (!state.crossfade || xfade || !analyser || media.paused || sleep?.track || isVideoTrack(state.tracks[state.index])) return;
  const dur = media.duration;
  if (!isFinite(dur) || dur < 3) return;
  const remaining = (dur - media.currentTime) / media.playbackRate; // tiempo real, no de la pista
  if (remaining > Math.min(state.crossfade, dur / 3) || !hasNext()) return;
  startCrossfade(Math.max(0.5, remaining));
}

function startCrossfade(secs) {
  const out = media;
  const inn = otherDeck();
  if (typeof clearSubTracks === "function") clearSubTracks(out);
  xfade = { out, inn, secs, starting: true, timer: 0 };
  media = inn; // la canción nueva pasa a ser la activa
  inn._gain.gain.cancelScheduledValues(0);
  inn._gain.gain.value = 0;
  step(1); // carga la siguiente en `inn` y la arranca en silencio
  xfade.starting = false;
  inn.addEventListener("playing", () => rampCrossfade(inn), { once: true });
  xfade.timer = setTimeout(endCrossfade, secs * 1000 + 2500); // red de seguridad si la pista nueva no llega a sonar
}

// Cuando la pista nueva ya suena: sube una y baja la otra con curvas de potencia constante.
function rampCrossfade(inn) {
  const x = xfade;
  if (!x || x.inn !== inn) return;
  const ac = analyser.context;
  const pts = 64;
  const up = Float32Array.from({ length: pts }, (_, i) => Math.sin((i / (pts - 1)) * Math.PI / 2));
  const down = Float32Array.from({ length: pts }, (_, i) => Math.cos((i / (pts - 1)) * Math.PI / 2));
  const t0 = ac.currentTime + 0.02;
  x.out._gain.gain.cancelScheduledValues(0);
  x.out._gain.gain.setValueAtTime(1, ac.currentTime);
  x.out._gain.gain.setValueCurveAtTime(down, t0, x.secs);
  x.inn._gain.gain.setValueCurveAtTime(up, t0, x.secs);
  clearTimeout(x.timer);
  x.timer = setTimeout(endCrossfade, x.secs * 1000 + 300);
}

function endCrossfade() {
  const x = xfade;
  if (!x) return;
  xfade = null;
  clearTimeout(x.timer);
  x.out.pause();
  const now = analyser.context.currentTime;
  for (const d of [x.out, x.inn]) {
    d._gain.gain.cancelScheduledValues(0);
    d._gain.gain.setValueAtTime(1, now);
  }
}

// Temporizadores periódicos y menús del temporizador y del fundido.
function wireFades() {
  setInterval(sleepTick, 500);

  els["sleep-btn"].addEventListener("click", (e) => {
    const mark = (on) => (on ? "✓" : "\u2003");
    showMenu(e.currentTarget, [
      ...(sleep ? [{ label: sleep.track ? "✕ Cancelar (al terminar la pista)" : `✕ Cancelar (quedan ${fmtClock(sleep.endAt - Date.now())})`, fn: () => setSleep(null) }] : []),
      ...[15, 30, 45, 60, 90].map((m) => ({ label: `${mark(false)} ${m} minutos`, fn: () => setSleep(m) })),
      { label: `${mark(sleep?.track)} Al terminar la pista`, fn: () => setSleep("track") },
      { label: `${mark(false)} Personalizado…`, fn: async () => {
          const res = await pedirTexto({ titulo: "¿Cuántos minutos?", valor: "20" });
          const m = parseFloat(String(res ?? "").replace(",", "."));
          if (m > 0 && m <= 720) setSleep(m);
        } },
    ]);
  });

  setInterval(crossfadeCheck, 200);

  els["xfade-btn"].addEventListener("click", (e) => {
    showMenu(e.currentTarget, [
      ...XFADES.map((s) => ({ label: `${state.crossfade === s ? "✓" : "\u2003"} ${s ? `${s} segundos` : "Sin fundido"}`, fn: () => setCrossfade(s) })),
      { label: "Solo al pasar sola a la siguiente pista", disabled: true },
    ]);
  });
}
