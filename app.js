const $ = (id) => document.getElementById(id);

const audio = $("audio");
const els = {
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  title: $("title"),
  seek: $("seek"),
  current: $("current"),
  duration: $("duration"),
  play: $("play"),
  prev: $("prev"),
  next: $("next"),
  shuffle: $("shuffle"),
  repeat: $("repeat"),
  volume: $("volume"),
  playlist: $("playlist"),
};

const state = { tracks: [], index: -1, shuffle: false, repeat: false };

const formatTime = (s) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("audio/"));
  for (const file of files) {
    state.tracks.push({
      name: file.name.replace(/\.[^.]+$/, ""),
      url: URL.createObjectURL(file),
    });
  }
  renderPlaylist();
  if (state.index === -1 && state.tracks.length) loadTrack(0, true);
}

function renderPlaylist() {
  if (!state.tracks.length) {
    els.playlist.innerHTML = '<li class="empty">Arrastra archivos de audio aquí o usa «Añadir canciones».</li>';
    return;
  }
  els.playlist.replaceChildren(
    ...state.tracks.map((t, i) => {
      const li = document.createElement("li");
      li.textContent = t.name;
      li.classList.toggle("active", i === state.index);
      li.addEventListener("click", () => loadTrack(i, true));
      return li;
    })
  );
}

function loadTrack(i, autoplay) {
  state.index = i;
  const track = state.tracks[i];
  audio.src = track.url;
  els.title.textContent = track.name;
  els.seek.disabled = false;
  renderPlaylist();
  if (autoplay) audio.play();
}

function step(dir) {
  const n = state.tracks.length;
  if (!n) return;
  let i;
  if (state.shuffle && n > 1) {
    do { i = Math.floor(Math.random() * n); } while (i === state.index);
  } else {
    i = (state.index + dir + n) % n;
  }
  loadTrack(i, true);
}

els.fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

els.play.addEventListener("click", () => {
  if (!state.tracks.length) return;
  audio.paused ? audio.play() : audio.pause();
});
els.prev.addEventListener("click", () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else step(-1);
});
els.next.addEventListener("click", () => step(1));

els.shuffle.addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  els.shuffle.setAttribute("aria-pressed", state.shuffle);
});
els.repeat.addEventListener("click", () => {
  state.repeat = !state.repeat;
  els.repeat.setAttribute("aria-pressed", state.repeat);
});

els.volume.addEventListener("input", () => (audio.volume = els.volume.value));
els.seek.addEventListener("input", () => {
  if (audio.duration) audio.currentTime = (els.seek.value / 100) * audio.duration;
});

audio.addEventListener("play", () => (els.play.textContent = "⏸"));
audio.addEventListener("pause", () => (els.play.textContent = "▶"));
audio.addEventListener("loadedmetadata", () => (els.duration.textContent = formatTime(audio.duration)));
audio.addEventListener("timeupdate", () => {
  els.current.textContent = formatTime(audio.currentTime);
  if (audio.duration) els.seek.value = (audio.currentTime / audio.duration) * 100;
});
audio.addEventListener("ended", () => {
  const last = state.index === state.tracks.length - 1;
  if (last && !state.repeat && !state.shuffle) return;
  step(1);
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.code === "Space") { e.preventDefault(); els.play.click(); }
  if (e.code === "ArrowRight") audio.currentTime += 5;
  if (e.code === "ArrowLeft") audio.currentTime -= 5;
});
