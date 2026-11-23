// Reproducción: cargar y avanzar pistas, grafo de Web Audio (ecualizador + visualizador) y velocidad.

const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';

const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

const isVideoTrack = (t) => t?.meta?.kind === "video";

// Muestra el escenario (solo el deck activo) y oculta el visualizador mientras suena un video.
function syncStage(t) {
  const video = isVideoTrack(t);
  els.stage?.classList.toggle("oculto", !video);
  els.cover.classList.toggle("video-mode", video);
  decks.forEach((d) => d.classList.toggle("oculto", d !== media));
  els.viz.hidden = video;
  if (video) {
    vizRunning = false;
    ctx2d.clearRect(0, 0, els.viz.width, els.viz.height);
  } else if (analyser && !media.paused && !vizRunning) {
    vizRunning = true;
    draw();
  }
  if (typeof syncSubtitles === "function") syncSubtitles();
  if (typeof syncFullscreen === "function") syncFullscreen();
  if (typeof syncPip === "function") syncPip();
}

let stageClickTimer = 0;

// Retrasar el clic simple para que el segundo clic de un doble clic no alterne reproducción.
function wireStage() {
  const stage = $("stage");
  stage.addEventListener("click", (e) => {
    if (!e.target.closest("video")) return;
    if (e.detail > 1) return;
    clearTimeout(stageClickTimer);
    stageClickTimer = setTimeout(() => { stageClickTimer = 0; togglePlay(); }, 500);
  });
  stage.addEventListener("dblclick", (e) => {
    if (!e.target.closest("video")) return;
    clearTimeout(stageClickTimer);
    stageClickTimer = 0;
    if (typeof toggleFullscreen === "function") toggleFullscreen();
  });
}

// Título, artista y carátula (lo que cambia al editar etiquetas sin reiniciar la reproducción).
function showMeta(t) {
  if (t) loadCover(t);
  els.title.textContent = t ? t.title : "Nada en reproducción";
  els.artist.textContent = t ? [t.artist, t.album].filter(Boolean).join(" · ") || "Artista desconocido" : "Añade música para empezar";
  els.cover.style.backgroundImage = t?.coverUrl ? `url(${t.coverUrl})` : "";
  els.cover.classList.toggle("has-art", !!t?.coverUrl);
  els.backdrop.style.backgroundImage = t?.coverUrl ? `url(${t.coverUrl})` : "";
  els.backdrop.classList.toggle("on", !!t?.coverUrl);
  document.title = t ? `${t.title} · Reproductor` : "Reproductor";

  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({
          title: t.title, artist: t.artist, album: t.album,
          artwork: t.coverUrl ? [{ src: t.coverUrl }] : [],
        })
      : null;
  }
}

function showTrack(t) {
  showMeta(t);
  els.seek.disabled = !t;
  els.seek.value = 0;
  els.current.textContent = els.duration.textContent = "0:00";
  syncStage(t);
  renderLyrics();
}

function updatePositionState() {
  if (!("mediaSession" in navigator)) return;
  const duration = media.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: media.playbackRate,
      position: Math.min(duration, Math.max(0, Number.isFinite(media.currentTime) ? media.currentTime : 0)),
    });
  } catch { /* El navegador puede no admitir el estado de posición. */ }
}

let warnedAc3 = false;
let warnedNoVideo = false;

function warnIfAc3(t) {
  if (!t || warnedAc3) return;
  const ac3 = t.ac3Unsupported || (!!t.meta?.codecs && checkCompatibility({
    kind: t.meta.kind,
    ext: extOf(t.fileName),
    codecs: t.meta.codecs,
  }, (type) => media.canPlayType(type)).ac3Unsupported);
  if (!ac3) return;
  warnedAc3 = true;
  toast(t.meta?.kind === "video" ? "El audio AC-3 no es compatible (el video se verá sin sonido)" : "El audio AC-3 no es compatible", 6000);
}

function loadTrack(i, autoplay, view = "all") {
  clearTimeout(stageClickTimer);
  pendingNext = null;
  warnedAc3 = false;
  warnedNoVideo = false;
  const t = state.tracks[i];
  if (xfade && (!xfade.starting || isVideoTrack(t))) endCrossfade(); // un cambio manual o un video corta el fundido
  if (!t || t.unavailable) return;
  state.index = i;
  state.playView = view;
  media.src = t.url;
  media.playbackRate = state.speed;
  showTrack(t);
  render();
  store.set("lastId", t.id ?? "");
  if (autoplay) play();
}

function play() {
  startAnalyser();
  return media.play().then(ensureSound).catch((e) => {
    if (e?.name === "NotAllowedError") toast("El navegador bloqueó la reproducción automática: pulsa ▶", 5000);
  });
}

// Con Web Audio, un contexto suspendido deja el audio mudo aunque el elemento «suene» (pasa si algo empieza sin que
// la persona haya tocado la página, p. ej. al abrir un archivo desde el sistema). Se intenta reanudar y, si no se
// puede, se pausa y se avisa en vez de «reproducir» en silencio.
async function ensureSound() {
  const ctx = analyser?.context;
  if (!ctx || ctx.state === "running") return;
  await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
  if (ctx.state !== "running") {
    media.pause();
    toast("El navegador bloqueó el sonido automático: pulsa ▶ para empezar", 5000);
  }
}

// Pistas entre las que se navega: la vista desde la que se empezó a reproducir.
const contextList = () => listTracks(state.playView).filter((t) => !t.unavailable);

let pendingNext = null;

// Elige (y fija en modo aleatorio) la siguiente pista para dir > 0 sin alterar la cola ni el estado.
function peekNext() {
  if (!state.tracks.length) return null;
  if (state.queue.length) {
    const queued = state.queue.find((q) => !q.unavailable);
    if (queued) return queued;
  }
  const list = contextList();
  const n = list.length;
  if (!n) return null;
  const current = state.tracks[state.index];
  const pos = list.indexOf(current);
  if (pos < 0) return list[0];
  if (state.shuffle && n > 1) {
    if (!pendingNext || pendingNext.unavailable || pendingNext === current || !list.includes(pendingNext)) {
      do { pendingNext = list[Math.floor(Math.random() * n)]; } while (pendingNext === current);
    }
    return pendingNext;
  }
  return list[(pos + 1) % n];
}

function step(dir) {
  if (!state.tracks.length) return;
  if (dir > 0 && state.queue.length) {
    while (state.queue.length) {
      const queued = state.queue.shift();
      if (!queued.unavailable) return loadTrack(state.tracks.indexOf(queued), true, state.playView);
    }
  }
  const list = contextList();
  const n = list.length;
  if (!n) return;
  const current = state.tracks[state.index];
  const pos = list.indexOf(current);
  let next;
  if (dir > 0) {
    next = peekNext();
  } else if (pos < 0) {
    next = list[0];
  } else if (state.shuffle && n > 1) {
    do { next = list[Math.floor(Math.random() * n)]; } while (next === current);
  } else {
    next = list[(pos + dir + n) % n];
  }
  if (!next) return;
  loadTrack(state.tracks.indexOf(next), true, state.playView);
}

function togglePlay() {
  const playable = state.tracks.findIndex((t) => !t.unavailable);
  if (playable < 0) return;
  if (state.index === -1 || state.tracks[state.index]?.unavailable) return loadTrack(playable, true, "all");
  media.paused ? play() : media.pause();
}

function setToggle(btn, key, value) {
  state[key] = value;
  btn.setAttribute("aria-pressed", value);
  store.set(key, value ? "1" : "0");
}

let analyser, freq;

let audioGraphFailed = false; // sin Web Audio la música suena igual, solo faltan ecualizador, visualizador y fundido

let vizRunning = false;

const ctx2d = els.viz.getContext("2d");

function startAnalyser() {
  if (analyser || audioGraphFailed) return;
  let ac;
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioGraphFailed = true; return; }
  analyser = ac.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.8;
  freq = new Uint8Array(analyser.frequencyBinCount);

  // fuente → 10 filtros → preamp → analizador → salida
  // Cada deck tiene su propia ganancia (para el fundido) y ambos entran al mismo ecualizador.
  const eqIn = ac.createGain();
  for (const d of decks) {
    d._gain = ac.createGain();
    ac.createMediaElementSource(d).connect(d._gain);
    d._gain.connect(eqIn);
  }
  let node = eqIn;
  eqFilters = EQ_BANDS.map((f, i) => {
    const filter = ac.createBiquadFilter();
    filter.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
    filter.frequency.value = f;
    filter.Q.value = 1.4;
    node.connect(filter);
    node = filter;
    return filter;
  });
  eqPreamp = ac.createGain();
  node.connect(eqPreamp);
  eqPreamp.connect(analyser);
  analyser.connect(ac.destination);
  applyEq();
  decks.forEach((d) => d.addEventListener("play", () => ac.resume()));
}

// El color de acento solo se vuelve a leer cuando cambia el tema.
let accent = "";

let accentTheme = "";

function accentColor() {
  const theme = document.documentElement.dataset.theme;
  if (theme !== accentTheme) {
    accentTheme = theme;
    accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  }
  return accent;
}

// El bucle de dibujo solo corre mientras suena algo (se reanuda con el evento «play»).
function draw() {
  const { width: w, height: h } = els.viz;
  ctx2d.clearRect(0, 0, w, h);
  if (media.paused || isVideoTrack(state.tracks[state.index])) { vizRunning = false; return; }
  requestAnimationFrame(draw);

  analyser.getByteFrequencyData(freq);
  const bars = 48;
  const gap = 4;
  const bw = (w - gap * (bars - 1)) / bars;
  ctx2d.fillStyle = accentColor();
  for (let i = 0; i < bars; i++) {
    const v = freq[Math.floor((i / bars) * freq.length * 0.75)] / 255;
    const bh = Math.max(3, v * h);
    ctx2d.globalAlpha = 0.45 + v * 0.55;
    ctx2d.fillRect(i * (bw + gap), h - bh, bw, bh);
  }
  ctx2d.globalAlpha = 1;
}

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function setSpeed(v) {
  v = Math.min(2, Math.max(0.25, Math.round(v * 100) / 100));
  state.speed = v;
  for (const d of decks) {
    d.defaultPlaybackRate = v; // se conserva al cambiar de pista
    d.playbackRate = v;
    d.preservesPitch = true;   // cambia el tempo sin cambiar el tono
  }
  store.set("speed", v);
  els["speed-btn"].textContent = fmtSpeed(v);
  els["speed-btn"].classList.toggle("active", v !== 1);
  updatePositionState();
}

// Salta a la velocidad predefinida anterior / siguiente.
function stepSpeed(dir) {
  const next = dir > 0 ? SPEEDS.find((s) => s > state.speed + 0.001) : [...SPEEDS].reverse().find((s) => s < state.speed - 0.001);
  if (next) { setSpeed(next); toast(`Velocidad ${fmtSpeed(next)}`, 1200); }
}

// Si una canción no se puede reproducir se salta, pero sin dar vueltas para siempre si ninguna funciona.
let failures = 0;

function applyVolume(v) {
  const val = clamp(Number(v), 0, 1);
  els.volume.value = val;
  setVolume(val);
  setMuted(false);
  store.set("volume", val);
}

function toggleMute() {
  setMuted(!media.muted);
}

function seekToPercent(pct) {
  const p = clamp(Number(pct), 0, 100);
  if (media.duration) media.currentTime = (p / 100) * media.duration;
}

// Transporte, volumen, progreso, eventos de audio, teclas multimedia y menú de velocidad.
function wirePlayer() {
  els.play.addEventListener("click", togglePlay);

  els.prev.addEventListener("click", () => { media.currentTime > 3 ? (media.currentTime = 0) : step(-1); });

  els.next.addEventListener("click", () => step(1));

  els.shuffle.addEventListener("click", () => {
    pendingNext = null;
    setToggle(els.shuffle, "shuffle", !state.shuffle);
  });

  els.repeat.addEventListener("click", () => setToggle(els.repeat, "repeat", !state.repeat));

  els.volume.value = store.get("volume") ?? 1;

  setVolume(els.volume.value);

  els.volume.addEventListener("input", () => applyVolume(els.volume.value));

  els.mute.addEventListener("click", toggleMute);

  onMedia("volumechange", () => (els.mute.style.opacity = media.muted ? 0.35 : ""));

  els.seek.addEventListener("input", () => seekToPercent(els.seek.value));

  onMedia("play", () => {
    els["play-icon"].innerHTML = ICON_PAUSE;
    updatePositionState();
    const t = state.tracks[state.index];
    if (analyser && !vizRunning && !isVideoTrack(t)) { vizRunning = true; draw(); }
    warnIfAc3(t);
  });

  onMedia("pause", () => { els["play-icon"].innerHTML = ICON_PLAY; updatePositionState(); if (xfade) endCrossfade(); });

  onMedia("loadedmetadata", () => {
    els.duration.textContent = formatTime(media.duration);
    updatePositionState();
    const t = state.tracks[state.index];
    if (t && isVideoTrack(t) && media.videoWidth > 0 && media.videoHeight > 0
      && (t.meta.width !== media.videoWidth || t.meta.height !== media.videoHeight)) {
      t.meta.width = media.videoWidth;
      t.meta.height = media.videoHeight;
      if (t.id != null) Storage.setMeta(t.id, t.meta, META_VERSION).catch(() => {});
      render();
    }
    if (t && isVideoTrack(t) && media.videoWidth === 0) {
      const indeterminateMkv = (/\.(webm|mkv)$/i.test(t.fileName)
        || /^(video|audio)\/(webm|x-matroska)$/i.test(t.file?.type || "")) && !t.meta.codecs;
      if (indeterminateMkv) {
        t.meta.kind = "audio";
        if (t.id != null) Storage.setMeta(t.id, t.meta, META_VERSION).catch(() => {});
        syncStage(t);
        renderLyrics();
        render();
      } else if (!warnedNoVideo) {
        warnedNoVideo = true;
        const msg = "Se oye pero el códec de video no es compatible";
        if (!t.compatWarning) { t.compatWarning = msg; render(); }
        toast(msg, 6000);
      }
    }
    if (!media.paused) warnIfAc3(t);
  });

  onMedia("timeupdate", () => {
    els.current.textContent = formatTime(media.currentTime);
    if (media.duration) els.seek.value = (media.currentTime / media.duration) * 100;
    updatePositionState();
  });

  onMedia("ratechange", updatePositionState);

  onMedia("ended", () => {
    if (sleep?.track) { finishSleep(); return; }
    const list = contextList();
    const last = list.indexOf(state.tracks[state.index]) === list.length - 1;
    if (state.repeat && !state.shuffle && list.length === 1) { media.currentTime = 0; play(); return; }
    if (last && !state.repeat && !state.shuffle && !state.queue.length) return;
    step(1);
  });

  onMedia("playing", () => { failures = 0; });

  onMedia("error", () => {
    if (!media.getAttribute("src")) return;
    const t = state.tracks[state.index];
    const title = t?.title ?? "la pista";
    const reason = t ? explainFailure(t.meta?.kind, extOf(t.fileName), t.meta?.codecs) : "";
    if (t && reason && !t.compatWarning) { t.compatWarning = reason; render(); }
    const limit = Math.max(1, contextList().length);
    if (++failures >= limit) {
      failures = 0;
      toast(limit > 1 ? "Ninguna pista de la lista se puede reproducir en este reproductor" : `No se puede reproducir «${title}»: ${reason}`, 7000);
      return;
    }
    toast(`No se puede reproducir «${title}» (${reason}); se salta`, 5000);
    step(1);
  });

  if ("mediaSession" in navigator) {
    const setHandler = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Acción no disponible en este navegador. */ }
    };
    setHandler("play", play);
    setHandler("pause", () => media.pause());
    setHandler("previoustrack", () => step(-1));
    setHandler("nexttrack", () => step(1));
    setHandler("seekto", ({ seekTime, fastSeek }) => {
      if (!Number.isFinite(seekTime) || !Number.isFinite(media.duration)) return;
      if (fastSeek && typeof media.fastSeek === "function") media.fastSeek(seekTime);
      else media.currentTime = Math.min(media.duration, Math.max(0, seekTime));
      updatePositionState();
    });
    setHandler("seekbackward", ({ seekOffset = 10 } = {}) => {
      if (!Number.isFinite(media.duration)) return;
      media.currentTime = Math.max(0, media.currentTime - (Number.isFinite(seekOffset) ? seekOffset : 10));
      updatePositionState();
    });
    setHandler("seekforward", ({ seekOffset = 10 } = {}) => {
      if (!Number.isFinite(media.duration)) return;
      media.currentTime = Math.min(media.duration, media.currentTime + (Number.isFinite(seekOffset) ? seekOffset : 10));
      updatePositionState();
    });
    setHandler("stop", () => { media.pause(); media.currentTime = 0; updatePositionState(); });
  }

  els["speed-btn"].addEventListener("click", (e) => {
    showMenu(e.currentTarget, [
      ...SPEEDS.map((s) => ({ label: `${Math.abs(s - state.speed) < 0.001 ? "✓" : "\u2003"} ${fmtSpeed(s)}${s === 1 ? " (normal)" : ""}`, fn: () => setSpeed(s) })),
      ...(SPEEDS.includes(state.speed) ? [] : [{ label: `✓ ${fmtSpeed(state.speed)} (personalizada)`, disabled: true }]),
    ]);
  });
}
