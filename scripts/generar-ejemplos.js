#!/usr/bin/node
// Sintetiza los ejemplos en PCM determinista; FFmpeg solo codifica y mide.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "ejemplos");
const temp = path.join(root, ".tmp");
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(temp, { recursive: true });
const RATE = 44100;
const DURATION = 28;
const TAU = Math.PI * 2;

function ffmpeg(args) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "info", "-y", ...args], { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`ffmpeg terminó con código ${run.status}`);
}

async function ffmpegVideo(args, frameCount, frameAt) {
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-y", ...args], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg terminó con código ${code}`)));
  });
  for (let i = 0; i < frameCount; i++) {
    if (!child.stdin.write(frameAt(i))) await once(child.stdin, "drain");
  }
  child.stdin.end();
  await done;
}

function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 0x100000000) * 2 - 1;
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
function envelope(t, duration, attack = 0.018, release = 0.16) {
  return smooth(t / attack) * smooth((duration - t) / release);
}
function adsr(t, duration, attack, decay, sustain, release) {
  if (t < 0 || t >= duration) return 0;
  const a = smooth(t / attack);
  const d = smooth((t - attack) / decay);
  const r = smooth((duration - t) / release);
  return Math.min(a, 1) * (1 - (1 - sustain) * d) * r;
}

const scales = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 9, 10],
};
function phrase(bpm, bars, progression, scale, rootMidi, melodySteps) {
  const beat = 60 / bpm;
  const bar = beat * 4;
  return {
    beat, bar, progression: progression.map((ch) => ch.map((n) => rootMidi + scales[scale][(n % 7 + 7) % 7] + 12 * Math.floor(n / 7))),
    bars, melody: melodySteps.map(([step, len, note]) => [step * beat / 2, len * beat / 2, rootMidi + scales[scale][note % 7] + 12 * Math.floor(note / 7), step]),
  };
}

function synth(track) {
  const count = RATE * DURATION;
  const L = new Float32Array(count);
  const R = new Float32Array(count);
  const random = rng(track.seed);
  const bars = Math.floor(DURATION / (60 / track.bpm * 4));
  const p = phrase(track.bpm, bars, track.chords, track.scale, track.root, track.melody);
  const dominant = [4, 6, 1].map((n) => track.root + scales[track.scale][n % 7] + 12 * Math.floor(n / 7));
  const tonic = p.progression[0];
  const chordAt = (time) => {
    const bar = Math.min(bars - 1, Math.floor(time / p.bar));
    if (bar >= bars - 1) return tonic;
    if (bar === bars - 2) return dominant;
    return p.progression[bar % p.progression.length];
  };
  const voices = [];

  // Bajo cálido y pulsos por negra en las tres piezas.
  for (let step = 0; step < bars * 4; step++) {
    const start = step * p.beat;
    const dur = p.beat * 0.78;
    const note = chordAt(start)[0] - 24;
    voices.push({ start, dur, note, kind: "bass", pan: (step % 2 ? 0.12 : -0.12) });
  }
  // Melodía con descansos y respuesta; las notas pertenecen a la tonalidad.
  const phraseBars = Math.ceil(Math.max(...track.melody.map(([step, len]) => step + len)) / 8);
  for (let repeat = 0; repeat * phraseBars * p.bar < bars * p.bar; repeat++) {
    const offset = repeat * phraseBars * p.bar + p.bar * 0.5;
    for (const [at, len, note, step] of p.melody) {
      const start = at + offset;
      if (start + len * 0.88 > DURATION - 0.03) continue;
      const chord = chordAt(start);
      const chordNotes = chord.flatMap((n) => [n - 12, n, n + 12]);
      const pitch = step % 2 === 0 ? chordNotes.reduce((best, n) => Math.abs(n - note) < Math.abs(best - note) ? n : best) : note;
      if (step % 2 === 0 && !chordNotes.includes(pitch)) throw new Error(`${track.name}: nota fuerte fuera del acorde`);
      voices.push({ start, dur: len * 0.88, note: pitch, kind: track.voice, pan: 0.1 });
    }
  }
  // Acordes sostenidos, una nueva inversión cada compás.
  for (let bar = 0; bar < bars; bar++) {
    const chord = chordAt(bar * p.bar);
    chord.slice(0, 3).forEach((note, i) => voices.push({ start: bar * p.bar, dur: Math.min(p.bar * 0.94, DURATION - bar * p.bar), note: note + 12, kind: track.pad, pan: (i - 1) * 0.3, index: i }));
  }

  const sampleVoice = (v, t) => {
    const local = t - v.start;
    if (local < 0 || local >= v.dur) return 0;
    const f = hz(v.note);
    const e = v.kind === "pad" ? adsr(local, v.dur, 0.55, 0.4, 0.58, 0.9) : envelope(local, v.dur, 0.012, 0.18);
    if (v.kind === "bass") return (Math.sin(TAU * f * local) * 0.76 + Math.sin(TAU * f * 2 * local) * 0.16) * e * 0.22;
    if (v.kind === "pad") return (Math.sin(TAU * f * local) * 0.72 + Math.sin(TAU * f * 2 * local) * 0.16) * e * 0.052;
    if (v.kind === "pluck") {
      // Karplus–Strong: cuerda aleatoria filtrada en bucle, semilla fija por voz.
      if (!v.ks) {
        const r = rng(track.seed + Math.round(v.start * 100) + v.note);
        const size = Math.max(2, Math.round(RATE / f));
        v.ks = Float32Array.from({ length: size }, () => r());
        v.ksAt = 0;
      }
      const at = v.ksAt++ % v.ks.length;
      const out = v.ks[at];
      v.ks[at] = (out + v.ks[(at + 1) % v.ks.length]) * 0.497;
      return out * e * 0.19;
    }
    if (v.kind === "ep") {
      const tremolo = 0.82 + 0.18 * Math.sin(TAU * 4.8 * local);
      return (Math.sin(TAU * f * local) * 0.63 + Math.sin(TAU * f * 2 * local) * 0.22 + Math.sin(TAU * f * 3.01 * local) * 0.08) * e * tremolo * 0.13;
    }
    // Campanas de parciales inarmónicos para Jardín.
    return (Math.sin(TAU * f * local) * 0.68 + Math.sin(TAU * f * 2.71 * local) * 0.18 + Math.sin(TAU * f * 5.08 * local) * 0.08) * e * 0.14;
  };

  // Percusión corta, nunca abrupta, y acentos cada negra.
  const hits = [];
  for (let beat = 0; beat < bars * 4; beat++) {
    if (track.rhythm === "none") continue;
    if (track.rhythm === "light" && beat % 2 === 1) continue;
    hits.push({ start: beat * p.beat, dur: track.rhythm === "light" ? 0.12 : 0.07, type: beat % 4 === 0 ? "kick" : "tap" });
  }
  // Bounces de reverberación hechos aquí en PCM, con colas decrecientes.
  const dry = new Float32Array(count);
  for (const v of voices) {
    const from = Math.max(0, Math.floor(v.start * RATE));
    const to = Math.min(count, Math.ceil((v.start + v.dur) * RATE));
    for (let n = from; n < to; n++) dry[n] += sampleVoice(v, n / RATE);
  }
  for (const hit of hits) {
    const from = Math.floor(hit.start * RATE);
    const len = Math.ceil(hit.dur * RATE);
    let z = 0;
    for (let k = 0; k < len && from + k < count; k++) {
      const t = k / RATE;
      const e = envelope(t, hit.dur, 0.002, hit.dur * 0.65);
      const noise = random();
      const kick = Math.sin(TAU * (75 - 35 * t / hit.dur) * t);
      dry[from + k] += (hit.type === "kick" ? kick * 0.2 : noise * 0.1) * e;
      z = z * 0.86 + noise * 0.14;
    }
  }
  const delayA = Math.round(RATE * track.delay);
  const delayB = Math.round(RATE * track.delay * 1.47);
  let peak = 0;
  for (let n = 0; n < count; n++) {
    const t = n / RATE;
    const fade = smooth(t / 1.1) * smooth((DURATION - t) / 0.55);
    const a = dry[n] + (n >= delayA ? dry[n - delayA] * 0.22 : 0) + (n >= delayB ? dry[n - delayB] * 0.12 : 0);
    const pan = track.stereo ? Math.sin(TAU * t / 11) * 0.18 : 0;
    L[n] = a * fade * (0.92 - pan);
    R[n] = a * fade * (0.92 + pan);
    peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]));
  }
  const gain = Math.min(track.gain, 0.89 / peak);
  const pcm = Buffer.allocUnsafe(count * 8);
  for (let n = 0; n < count; n++) { pcm.writeFloatLE(L[n] * gain, n * 8); pcm.writeFloatLE(R[n] * gain, n * 8 + 4); }
  return pcm;
}

function cover(name, colors, seed) {
  const size = 640;
  const data = Buffer.alloc(size * size * 3);
  const top = colors[0], middle = colors[1], bottom = colors[2];
  const rand = rng(seed);
  const noise = new Float32Array(size * size);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * 5;
  const lerp = (a, b, t) => a + (b - a) * t;
  const ridge = (x, phase, amp, base) => base + Math.sin(x * 0.009 + phase) * amp + Math.sin(x * 0.022 + phase * 1.8) * amp * 0.35;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 3;
    let c;
    const f = y / 430;
    if (y < 430) c = top.map((v, k) => lerp(v, middle[k], f));
    else c = middle.map((v, k) => lerp(v, bottom[k], (y - 430) / 210));
    const sunX = 430 + Math.sin(seed) * 65;
    const sunY = 190;
    const radius = 82;
    if ((x - sunX) ** 2 + (y - sunY) ** 2 < radius ** 2) c = colors[3];
    const h1 = ridge(x, seed, 48, 445);
    const h2 = ridge(x, seed * 1.3, 63, 520);
    const h3 = ridge(x, seed * 0.67, 40, 585);
    if (y > h1) c = colors[4];
    if (y > h2) c = colors[5];
    if (y > h3) c = colors[6];
    const grain = noise[y * size + x];
    for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, Math.round(c[k] + grain)));
  }
  return Buffer.concat([Buffer.from(`P6\n${size} ${size}\n255\n`), data]);
}

const tracks = [
  { name: "Brisa", bpm: 90, root: 57, scale: "major", seed: 371, voice: "pluck", pad: "pad", rhythm: "sparse", delay: 0.28, stereo: true, gain: 1.43,
    chords: [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]], melody: [[0,2,4],[3,1,5],[6,2,4],[10,2,2],[14,2,1],[18,2,2],[22,2,4],[26,2,5],[32,2,4],[36,2,5],[40,2,7],[44,2,5],[48,2,4],[52,2,2],[56,2,1],[60,4,0]],
    colors: [[19,54,65],[91,156,142],[235,190,119],[247,218,151],[54,111,105],[37,87,88],[20,58,65]] },
  { name: "Jardín", bpm: 110, root: 60, scale: "major", seed: 813, voice: "bell", pad: "pad", rhythm: "light", delay: 0.19, stereo: true, gain: 1.25,
    chords: [[0,2,4],[3,5,0],[4,6,1],[0,2,4]], melody: [[0,2,7],[2,1,5],[4,2,4],[7,1,5],[8,2,7],[12,2,9],[16,2,7],[20,2,5],[24,2,4],[28,2,7],[32,2,9],[36,2,11],[40,2,9],[44,2,7],[48,2,5],[52,2,4],[56,4,0]],
    colors: [[54,84,66],[152,177,110],[221,178,111],[247,209,129],[96,135,91],[57,101,72],[37,77,60]] },
  { name: "Nubes", bpm: 72, root: 53, scale: "minor", seed: 1229, voice: "ep", pad: "pad", rhythm: "none", delay: 0.54, stereo: true, gain: 1.38,
    chords: [[0,2,4],[5,0,2],[3,5,0],[4,6,1]], melody: [[0,4,4],[8,4,2],[16,4,1],[24,4,2],[32,4,4],[40,4,5],[48,4,4],[56,8,2]],
    colors: [[49,59,93],[123,139,174],[190,170,174],[238,211,154],[87,100,139],[66,80,123],[44,59,101]] },
];

for (const track of tracks) {
  const pcmPath = path.join(temp, `${track.name}.f32le`);
  const coverPath = path.join(temp, `${track.name}.ppm`);
  fs.writeFileSync(pcmPath, synth(track));
  fs.writeFileSync(coverPath, cover(track.name, track.colors, track.seed));
  const output = path.join(dir, track.name === "Jardín" ? "Jardín.flac" : `${track.name}.mp3`);
  const args = ["-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", pcmPath, "-i", coverPath, "-map", "0:a", "-map", "1:v",
    "-metadata", `title=${track.name}`, "-metadata", "artist=Tarareo (ejemplo)", "-metadata", "album=Pequeños paisajes", "-metadata:s:v", "title=Portada", "-metadata:s:v", "comment=Cover (front)"];
  if (track.name === "Jardín") args.push("-sample_fmt", "s16", "-c:a", "flac", "-c:v", "mjpeg", "-disposition:v", "attached_pic");
  else args.push("-c:a", "libmp3lame", "-b:a", "160k", "-id3v2_version", "4", "-c:v", "mjpeg", "-disposition:v", "attached_pic");
  args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11,ebur128=peak=true:framelog=quiet", "-ar", String(RATE), output);
  ffmpeg(args);
}

// Paseo: paisaje animado sintético con varias capas, parallax y sol desplazándose.
const videoPcm = path.join(temp, "Paseo.f32le");
const vcount = 48000 * 24;
const vraw = Buffer.alloc(vcount * 8);
const videoProgression = [[0, 3, 7], [5, 8, 12], [3, 7, 10], [4, 7, 11]];
for (let n = 0; n < vcount; n++) {
  const t = n / 48000;
  const beat = t * 72 / 60;
  const beatNo = Math.floor(beat);
  const barIndex = Math.floor(beat / 4);
  const chord = barIndex >= 7 ? videoProgression[0] : barIndex >= 6 ? videoProgression[3] : videoProgression[barIndex % 4];
  const root = hz(38 + chord[0]);
  const third = hz(50 + chord[1]);
  const fifth = hz(50 + chord[2]);
  const melody = hz(62 + [0, 3, 5, 7, 10, 7, 5, 3][Math.floor(beat * 2) % 8]);
  const fade = smooth(t / 1.2) * smooth((24 - t) / 1.8);
  const bass = Math.sin(TAU * root * t) * (0.075 + (beatNo % 4 === 0 ? 0.025 : 0));
  const harmony = Math.sin(TAU * third * t) * 0.035 + Math.sin(TAU * fifth * t) * 0.025;
  const pluck = Math.sin(TAU * melody * t) * Math.exp(-((beat * 2) % 1) * 3) * 0.035;
  const value = (bass + harmony + pluck) * fade;
  vraw.writeFloatLE(value, n * 8); vraw.writeFloatLE(value, n * 8 + 4);
}
fs.writeFileSync(videoPcm, vraw);
const vw = 1280, vh = 720;
const skyTop = [39,54,91], skyLow = [137,151,183];
const hills = [[79,100,142],[55,78,128],[35,56,101]];
const frameAt = (frame) => {
  const t = frame / 24;
  const frameData = Buffer.allocUnsafe(vw * vh * 3);
  const sunX = 48 + 220 * frame / 575;
  const sunY = 43 + Math.sin(t / 8) * 5;
  const ridges = new Array(vw);
  for (let x = 0; x < vw; x++) {
    ridges[x] = [
      420 + Math.sin((x + t * 8.8) * 0.023) * 44 + Math.sin((x + t * 8.8) * 0.052) * 16,
      520 + Math.sin((x + t * 5.2) * 0.019 + 1.4) * 52 + Math.sin((x + t * 5.2) * 0.043) * 20,
      612 + Math.sin((x + t * 2.4) * 0.027 + 2.6) * 28,
    ];
  }
  for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
    const o = (y * vw + x) * 3;
    const f = Math.min(1, y / 448);
    let red = skyTop[0] + (skyLow[0] - skyTop[0]) * f;
    let green = skyTop[1] + (skyLow[1] - skyTop[1]) * f;
    let blue = skyTop[2] + (skyLow[2] - skyTop[2]) * f;
    const dx = x - sunX * 4, dy = y - sunY * 4;
    const d2 = dx * dx + dy * dy;
    let sun = 0;
    if (d2 < 85 * 85) sun = d2 < 83 * 83 ? 1 : smooth((84.8 - Math.sqrt(d2)) / 1.6);
    if (sun) { red += (249 - red) * sun; green += (218 - green) * sun; blue += (157 - blue) * sun; }
    for (let layer = 0; layer < 3; layer++) {
      const distance = y - ridges[x][layer];
      if (distance > -0.8) {
        const edge = distance >= 0.8 ? 1 : smooth((distance + 0.8) / 1.6);
        red += (hills[layer][0] - red) * edge;
        green += (hills[layer][1] - green) * edge;
        blue += (hills[layer][2] - blue) * edge;
      }
    }
    frameData[o] = Math.round(red);
    frameData[o + 1] = Math.round(green);
    frameData[o + 2] = Math.round(blue);
  }
  return frameData;
};
void ffmpegVideo(["-f", "f32le", "-ar", "48000", "-ac", "2", "-i", videoPcm,
  "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${vw}x${vh}`, "-framerate", "24", "-i", "pipe:0",
  "-map", "1:v", "-map", "0:a", "-t", "24", "-vf", "format=yuv420p", "-r", "24",
  "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "4", "-b:v", "260k", "-c:a", "libopus", "-b:a", "64k", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,ebur128=peak=true:framelog=quiet",
  "-metadata", "title=Paseo", "-metadata", "artist=Tarareo (ejemplo)", "-metadata", "album=Pequeños paisajes", "-ar", "48000", path.join(dir, "Paseo.webm")], 576, frameAt)
  .catch((error) => { console.error(error); process.exitCode = 1; });

fs.writeFileSync(path.join(dir, "Brisa.lrc"), "[ti:Brisa]\n[ar:Tarareo (ejemplo)]\n[00:02.00]La tarde se inclina al mar\n[00:05.00]la cuerda despierta al sol\n[00:08.00]un paso comienza a andar\n[00:11.00]y el viento responde en do\n[00:14.00]las hojas giran al pasar\n[00:17.00]la luz se posa en la piel\n[00:20.00]la noche nos ve llegar\n[00:24.00]y el aire nos mece otra vez\n", "utf8");
fs.writeFileSync(path.join(dir, "Paseo.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:06.000\nEl sol acompaña el paseo.\n\n00:00:07.000 --> 00:00:13.000\nLas colinas cambian con cada paso.\n\n00:00:14.000 --> 00:00:20.000\nLa tarde descansa sobre el agua.\n\n00:00:21.000 --> 00:00:24.000\nVolvemos despacio.\n", "utf8");
