// Imagen en imagen (Picture-in-Picture) sobre el deck activo de video.

const isPipSupported = () =>
  Boolean(document.pictureInPictureEnabled) && typeof media?.requestPictureInPicture === "function";

const pipElement = () => document.pictureInPictureElement || null;

const isPipActive = () => {
  const el = pipElement();
  return !!el && decks.includes(el);
};

function exitPictureInPicture() {
  if (!pipElement() || typeof document.exitPictureInPicture !== "function") return Promise.resolve();
  try {
    return Promise.resolve(document.exitPictureInPicture()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

// Alterna Picture-in-Picture sobre el deck activo. Solo entra si la pista es de video y el entorno lo soporta.
function togglePictureInPicture() {
  if (pipElement()) return exitPictureInPicture();
  if (!isVideoTrack(state.tracks[state.index]) || !isPipSupported() || media.disablePictureInPicture) {
    return Promise.resolve();
  }
  try {
    return Promise.resolve(media.requestPictureInPicture()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function syncPipButtons() {
  const video = isVideoTrack(state.tracks[state.index]);
  const show = video && isPipSupported();
  const active = video && pipElement() === media;
  for (const id of ["pip-btn", "fs-pip"]) {
    const btn = els[id];
    if (!btn) continue;
    btn.classList.toggle("oculto", !show);
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

// Mantiene PiP alineado con el deck activo y la pista actual: si cambia el deck o pasa a audio, sale de PiP.
function syncPip() {
  const pipEl = pipElement();
  if (pipEl && (pipEl !== media || !isVideoTrack(state.tracks[state.index]))) {
    exitPictureInPicture();
  }
  syncPipButtons();
}

function wirePip() {
  els["pip-btn"]?.addEventListener("click", togglePictureInPicture);
  for (const d of decks) {
    d.addEventListener("enterpictureinpicture", syncPip);
    d.addEventListener("leavepictureinpicture", syncPip);
  }
  syncPipButtons();
}
