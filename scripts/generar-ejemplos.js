#!/usr/bin/node
// Genera los medios de demo desde osciladores y formas geométricas propios. Requiere ffmpeg.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "ejemplos");
fs.mkdirSync(dir, { recursive: true });

function ffmpeg(args) {
  const run = spawnSync("timeout", ["60", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`ffmpeg terminó con código ${run.status}`);
}

const covers = [
  ["Brisa", "#154c55", "#8fd9c7", "#f3d58a"],
  ["Jardín", "#31513a", "#b9cf87", "#e9a86f"],
  ["Nubes", "#59415e", "#d2a9c2", "#eac779"],
  ["Paseo", "#373d69", "#a4a9e8", "#f2bf89"],
];
for (const [name, bg, a, b] of covers) {
  ffmpeg(["-f", "lavfi", "-i", `color=c=${bg}:s=320x320:d=1`, "-vf",
    `drawbox=x=36:y=36:w=248:h=248:color=${a}@0.92:t=fill,drawbox=x=82:y=82:w=156:h=156:color=${b}@0.95:t=fill,drawbox=x=116:y=116:w=88:h=88:color=${bg}@0.9:t=fill`,
    "-frames:v", "1", path.join(dir, `${name}-portada.png`)]);
}

const audio = "sine=frequency=220:sample_rate=44100:duration=24";
const chords = "[0:a]volume=0.22[a0];sine=frequency=277.18:sample_rate=44100:duration=24,volume=0.12[a1];sine=frequency=329.63:sample_rate=44100:duration=24,volume=0.10[a2];[a0][a1][a2]amix=inputs=3:normalize=0,afade=t=in:st=0:d=2,afade=t=out:st=21:d=3[a]";
ffmpeg(["-f", "lavfi", "-i", audio, "-i", path.join(dir, "Brisa-portada.png"), "-filter_complex", chords,
  "-map", "[a]", "-map", "1:v", "-c:a", "libmp3lame", "-b:a", "96k", "-c:v", "mjpeg", "-id3v2_version", "3",
  "-metadata", "title=Brisa", "-metadata", "artist=Tarareo (ejemplo)", "-metadata", "album=Pequeños paisajes",
  "-metadata:s:v", "title=Portada", "-metadata:s:v", "comment=Cover (front)", path.join(dir, "Brisa.mp3")]);

const flac = "[0:a]volume=0.16[a0];sine=frequency=261.63:sample_rate=44100:duration=24,volume=0.10[a1];sine=frequency=392:sample_rate=44100:duration=24,volume=0.08[a2];[a0][a1][a2]amix=inputs=3:normalize=0,afade=t=in:st=0:d=2,afade=t=out:st=21:d=3[a]";
ffmpeg(["-f", "lavfi", "-i", audio, "-i", path.join(dir, "Jardín-portada.png"), "-filter_complex", flac,
  "-map", "[a]", "-map", "1:v", "-c:a", "flac", "-c:v", "mjpeg", "-disposition:v", "attached_pic",
  "-metadata", "title=Jardín", "-metadata", "artist=Tarareo (ejemplo)", "-metadata", "album=Pequeños paisajes",
  "-metadata:s:v", "title=Portada", path.join(dir, "Jardín.flac")]);

const third = "[0:a]volume=0.16[a0];sine=frequency=293.66:sample_rate=44100:duration=24,volume=0.10[a1];sine=frequency=440:sample_rate=44100:duration=24,volume=0.08[a2];[a0][a1][a2]amix=inputs=3:normalize=0,afade=t=in:st=0:d=2,afade=t=out:st=21:d=3[a]";
ffmpeg(["-f", "lavfi", "-i", audio, "-i", path.join(dir, "Nubes-portada.png"), "-filter_complex", third,
  "-map", "[a]", "-map", "1:v", "-c:a", "libmp3lame", "-b:a", "96k", "-c:v", "mjpeg", "-id3v2_version", "3",
  "-metadata", "title=Nubes", "-metadata", "artist=Tarareo (ejemplo)", "-metadata", "album=Pequeños paisajes",
  "-metadata:s:v", "title=Portada", "-metadata:s:v", "comment=Cover (front)", path.join(dir, "Nubes.mp3")]);

const video = "color=c=#24324a:s=320x180:r=12:d=24,drawbox=x='40+90*sin(t/3)':y=40:w=70:h=70:color=#f2bf89@0.8:t=fill,drawbox=x='190-60*sin(t/4)':y=100:w=50:h=50:color=#a4a9e8@0.9:t=fill";
ffmpeg(["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", "sine=frequency=196:sample_rate=48000:duration=24",
  "-vf", "format=yuv420p", "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "3", "-b:v", "180k",
  "-c:a", "libopus", "-b:a", "48k", "-metadata", "title=Paseo", "-metadata", "artist=Tarareo (ejemplo)",
  "-metadata", "album=Pequeños paisajes", path.join(dir, "Paseo.webm")]);

fs.writeFileSync(path.join(dir, "Brisa.lrc"), "[ti:Brisa]\n[ar:Tarareo (ejemplo)]\n[00:02.00]La tarde baja despacio\n[00:08.00]y el aire aprende a cantar\n[00:14.00]cada ventana es un faro\n[00:19.00]que invita a descansar\n", "utf8");
fs.writeFileSync(path.join(dir, "Paseo.vtt"), "WEBVTT\n\n00:00:02.000 --> 00:00:08.000\nPasos tranquilos, luz de abril.\n\n00:00:10.000 --> 00:00:17.000\nLa ciudad respira en calma.\n\n00:00:18.000 --> 00:00:23.000\nSeguimos un poco más.\n", "utf8");
