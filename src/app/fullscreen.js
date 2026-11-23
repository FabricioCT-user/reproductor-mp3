// Pantalla completa sobre el escenario de video (#stage), barra de controles superpuesta e inactividad del ratón.

const FS_IDLE_MS = 3000;

let fsIdleTimer = 0;
let fsPointerDown = false;

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

const isFullscreen = () => fsElement() === els.stage;

function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (!fn) return Promise.resolve();
  try {
    return Promise.resolve(fn.call(document)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

// Alterna pantalla completa sobre #stage. Solo entra si la pista actual es de video; siempre permite salir.
function toggleFullscreen() {
  const stage = els.stage;
  if (!stage) return Promise.resolve();
  if (fsElement()) return exitFullscreen();
  if (!isVideoTrack(state.tracks[state.index])) return Promise.resolve();
  const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (!req) return Promise.resolve();
  try {
    return Promise.resolve(req.call(stage)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function clearFullscreenIdle() {
  if (!fsIdleTimer) return;
  clearTimeout(fsIdleTimer);
  fsIdleTimer = 0;
}

function hideFullscreenControls() {
  fsIdleTimer = 0;
  if (!isFullscreen() || fsPointerDown) return;
  els.stage.classList.add("fs-inactivo");
  if (els["fs-controls"].contains(document.activeElement)) document.activeElement.blur();
}

function scheduleFullscreenHide() {
  clearFullscreenIdle();
  if (!isFullscreen() || fsPointerDown) return;
  fsIdleTimer = setTimeout(hideFullscreenControls, FS_IDLE_MS);
}

function showFullscreenControls() {
  if (!isFullscreen()) return;
  els.stage.classList.remove("fs-inactivo");
  scheduleFullscreenHide();
}

function syncFsPlay() {
  els["fs-play-icon"].innerHTML = media.paused ? ICON_PLAY : ICON_PAUSE;
}

function syncFsVolume() {
  els["fs-volume"].value = media.volume;
  els["fs-mute"].classList.toggle("silenciado", media.muted);
  els["fs-mute"].setAttribute("aria-pressed", String(media.muted));
}

function syncFsProgress() {
  const hasTrack = !!state.tracks[state.index];
  const dur = media.duration;
  const validDur = Number.isFinite(dur) && dur > 0;
  els["fs-seek"].disabled = !hasTrack;
  els["fs-current"].textContent = formatTime(media.currentTime);
  els["fs-duration"].textContent = validDur ? formatTime(dur) : "0:00";
  els["fs-seek"].value = validDur ? (media.currentTime / dur) * 100 : 0;
}

function syncFullscreenControls() {
  syncFsPlay();
  syncFsVolume();
  syncFsProgress();
}

// Mantiene la barra y el estado de pantalla completa alineados con el DOM y la pista activa.
function syncFullscreen() {
  const active = isFullscreen();
  if (active && !isVideoTrack(state.tracks[state.index])) {
    clearFullscreenIdle();
    fsPointerDown = false;
    els.stage.classList.remove("fs-inactivo");
    els["fs-controls"].classList.add("oculto");
    exitFullscreen();
    return;
  }
  els["fs-controls"].classList.toggle("oculto", !active);
  if (active) {
    syncFullscreenControls();
    showFullscreenControls();
  } else {
    clearFullscreenIdle();
    fsPointerDown = false;
    els.stage.classList.remove("fs-inactivo");
    if (els["fs-controls"].contains(document.activeElement)) document.activeElement.blur();
  }
}

// Controles superpuestos de pantalla completa, eventos de actividad e integración con fullscreenchange.
function wireFullscreen() {
  const stage = els.stage;
  const bar = els["fs-controls"];

  // Evita que clics o dobles clics en la barra suban al escenario (#stage).
  bar.addEventListener("click", (e) => e.stopPropagation());
  bar.addEventListener("dblclick", (e) => e.stopPropagation());

  // Reusa las funciones del reproductor sin duplicar lógica.
  els["fs-play"].addEventListener("click", togglePlay);
  els["fs-mute"].addEventListener("click", toggleMute);
  els["fs-volume"].addEventListener("input", () => applyVolume(els["fs-volume"].value));
  els["fs-seek"].addEventListener("input", () => seekToPercent(els["fs-seek"].value));
  els["fs-exit"].addEventListener("click", toggleFullscreen);

  // Refleja el estado real del reproductor.
  onMedia("play", syncFsPlay);
  onMedia("pause", syncFsPlay);
  onMedia("volumechange", syncFsVolume);
  onMedia("timeupdate", syncFsProgress);
  onMedia("loadedmetadata", syncFsProgress);
  onMedia("durationchange", syncFsProgress);
  onMedia("seeked", syncFsProgress);
  onMedia("emptied", syncFullscreenControls);

  // Muestra la barra y el cursor al mover el ratón o interactuar; oculta tras 3 s de inactividad.
  stage.addEventListener("mousemove", showFullscreenControls);
  stage.addEventListener("pointermove", (e) => { if (e.pointerType !== "mouse") showFullscreenControls(); });
  stage.addEventListener("touchstart", showFullscreenControls, { passive: true });
  bar.addEventListener("input", showFullscreenControls);
  bar.addEventListener("focusin", showFullscreenControls);

  // No ocultar mientras la persona mantiene pulsado un deslizador o botón.
  bar.addEventListener("pointerdown", () => {
    fsPointerDown = true;
    showFullscreenControls();
  });
  const endPointer = () => {
    if (!fsPointerDown) return;
    fsPointerDown = false;
    scheduleFullscreenHide();
  };
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  document.addEventListener("fullscreenchange", syncFullscreen);
  document.addEventListener("webkitfullscreenchange", syncFullscreen);
  // En navegadores Escape sale de forma nativa; en Electron la ventana no lo intercepta sola.
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && isFullscreen()) exitFullscreen();
  });

  syncFullscreenControls();
}
