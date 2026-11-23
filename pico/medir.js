// Pico TE.0: arnés de medición (no es parte de la app). Lo llama main.js.
// PICO_FASE: "a" = puntos 1, 3, 4, 5, 6, 7 + escribe persistencia; "b" = lee persistencia (punto 2);
// "rango" = solo puntos 3 y 4 (para comparar PICO_RANGO=net y propio).
"use strict";
const { app, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FASE = process.env.PICO_FASE || "a";
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function memoria() {
  const ms = app.getAppMetrics();
  const porTipo = {};
  let total = 0;
  for (const p of ms) { const kb = p.memory.workingSetSize; total += kb; porTipo[p.type] = (porTipo[p.type] || 0) + kb; }
  const mb = (kb) => Math.round(kb / 1024);
  return { totalMB: mb(total), porTipoMB: Object.fromEntries(Object.entries(porTipo).map(([k, v]) => [k, mb(v)])),
    principalRssMB: Math.round(process.memoryUsage().rss / 1048576) };
}

// ---- Funciones que se ejecutan en la página (se serializan con toString) ----

async function enPaginaVideo({ url, segundos, saltos, eq }) {
  const ev = (el, ok, ms = 15000) => new Promise((res) => {
    const t = setTimeout(() => res("timeout"), ms);
    const fin = (e) => { clearTimeout(t); el.removeEventListener(ok, fin); el.removeEventListener("error", fin); res(e.type); };
    el.addEventListener(ok, fin); el.addEventListener("error", fin);
  });
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const r = { url };
  const v = document.createElement("video");
  v.preload = "auto"; v.style.width = "160px";
  document.body.append(v);
  const ac = new AudioContext();
  r.estadoContexto = ac.state;
  const src = ac.createMediaElementSource(v);
  const filtro = ac.createBiquadFilter(); filtro.type = "peaking"; filtro.frequency.value = 440; filtro.Q.value = 1;
  const an = ac.createAnalyser(); an.fftSize = 2048;
  const mudo = ac.createGain(); mudo.gain.value = 0; // la persona no oye nada; el analizador mide antes
  src.connect(filtro).connect(an).connect(mudo).connect(ac.destination);
  const buf = new Float32Array(an.fftSize);
  const rms = async (ms) => { let s = 0, n = 0; const fin = performance.now() + ms;
    while (performance.now() < fin) { an.getFloatTimeDomainData(buf); for (const x of buf) { s += x * x; n++; } await dormir(50); }
    return Math.sqrt(s / n); };
  let t0 = performance.now();
  v.src = url;
  r.carga = await ev(v, "canplay");
  r.msHastaCanplay = Math.round(performance.now() - t0);
  if (v.error) { r.error = `${v.error.code} ${v.error.message}`; v.remove(); ac.close(); return r; }
  r.duracion = v.duration; r.tamVideo = `${v.videoWidth}x${v.videoHeight}`;
  t0 = performance.now();
  try { await v.play(); } catch (e) { r.errorPlay = String(e); }
  r.msHastaPlay = Math.round(performance.now() - t0);
  await dormir(segundos * 1000);
  r.tiempoTrasReproducir = +v.currentTime.toFixed(2);
  if (eq) {
    filtro.gain.value = 0; r.rmsEq0 = +(await rms(800)).toFixed(4);
    filtro.gain.value = 12; await dormir(150); r.rmsEqMas12 = +(await rms(800)).toFixed(4);
    filtro.gain.value = -12; await dormir(150); r.rmsEqMenos12 = +(await rms(800)).toFixed(4);
    filtro.gain.value = 0;
  } else r.rms = +(await rms(800)).toFixed(4);
  r.saltos = [];
  for (const f of saltos) {
    const destino = v.duration * f; t0 = performance.now();
    v.currentTime = destino;
    const e1 = await ev(v, "seeked");
    const msSeeked = Math.round(performance.now() - t0);
    const antes = v.currentTime; await dormir(700);
    r.saltos.push({ a: +destino.toFixed(1), evento: e1, msSeeked, avanza: +(v.currentTime - antes).toFixed(2) });
  }
  const q = v.getVideoPlaybackQuality();
  r.cuadros = q.totalVideoFrames; r.cuadrosPerdidos = q.droppedVideoFrames;
  r.decodedAudioBytes = v.webkitAudioDecodedByteCount;
  if (!eq) r.rmsFinal = +(await rms(500)).toFixed(4);
  v.pause(); v.removeAttribute("src"); v.load(); v.remove(); await ac.close();
  return r;
}

function enPaginaCodecs() {
  const v = document.createElement("video");
  const t = ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.640028"', 'audio/mp4; codecs="mp4a.40.2"',
    'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="av01.0.05M.08"',
    'video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="av01.0.05M.08"',
    'audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ec-3"', 'video/x-matroska; codecs="avc1.42E01E, mp4a.40.2"',
    "video/x-matroska", "video/quicktime", "audio/flac", "audio/ogg; codecs=opus"];
  return Object.fromEntries(t.map((x) => [x, v.canPlayType(x) || "(vacío)"]));
}

// ---- Orquestación ----

module.exports = function medir(win, { stats, modo, medios }) {
  const wc = win.webContents;
  const res = { fase: FASE, modo, versiones: { ...process.versions }, plataforma: { XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, ozone: app.commandLine.getSwitchValue("ozone-platform"),
    noSandbox: app.commandLine.hasSwitch("no-sandbox") } };
  const consola = [];
  wc.on("console-message", (e, nivel, mensaje, linea, fuente) => {
    const lv = e.level ?? nivel; const msg = e.message ?? mensaje;
    consola.push({ nivel: lv, mensaje: String(msg).slice(0, 300), fuente: e.sourceId ?? fuente, linea: e.lineNumber ?? linea });
  });
  wc.on("render-process-gone", (_e, d) => { res.rendererCaido = d; });
  const salir = (codigo = 0) => {
    fs.writeFileSync(process.env.PICO_SALIDA || path.join(__dirname, "resultado.json"), JSON.stringify(res, null, 2));
    app.exit(codigo);
  };
  setTimeout(() => { res.abortado = "timeout global 240 s"; salir(2); }, 240000);
  const js = (fn, arg) => wc.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, true);

  wc.once("did-finish-load", async () => {
    try {
      await esperar(2000);
      // Punto 1: carga, CSP intacta, consola limpia
      res.p1 = await js(() => ({ url: location.href, origen: location.origin, cspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
        titulo: document.title, botones: document.querySelectorAll("button").length, swRegistrado: !!navigator.serviceWorker?.controller }));
      res.p1.consola = consola.slice();

      // Punto 2: persistencia
      if (FASE === "a") {
        res.p2escritura = await js(async () => {
          const marca = String(Date.now());
          localStorage.setItem("pico-marca", marca);
          await new Promise((ok, mal) => { const r = indexedDB.open("pico-db", 1);
            r.onupgradeneeded = () => r.result.createObjectStore("s");
            r.onsuccess = () => { const tx = r.result.transaction("s", "readwrite"); tx.objectStore("s").put(marca, "marca");
              tx.oncomplete = () => { r.result.close(); ok(); }; tx.onerror = mal; }; r.onerror = mal; });
          return { marca, bases: (await indexedDB.databases()).map((d) => `${d.name} v${d.version}`) };
        });
      }
      if (FASE === "b") {
        res.p2lectura = await js(async () => {
          const ls = localStorage.getItem("pico-marca");
          const idb = await new Promise((ok) => { const r = indexedDB.open("pico-db", 1);
            r.onupgradeneeded = () => r.result.createObjectStore("s");
            r.onsuccess = () => { const q = r.result.transaction("s").objectStore("s").get("marca"); q.onsuccess = () => ok(q.result ?? null); q.onerror = () => ok(null); };
            r.onerror = () => ok(null); });
          return { localStorage: ls, indexedDB: idb, bases: (await indexedDB.databases()).map((d) => `${d.name} v${d.version}`), origen: location.origin };
        });
        return salir(0);
      }

      // ¿net.fetch(file://) reenvía Range? (comprobación directa en el principal)
      if (medios) {
        const f = pathToFileURL(path.join(medios, "grande.mp4")).href;
        const r = await net.fetch(f, { headers: { Range: "bytes=1000-1999" } });
        const cuerpo = Buffer.from(await r.arrayBuffer());
        res.netFetchFileRange = { status: r.status, contentRange: r.headers.get("content-range"), acceptRanges: r.headers.get("accept-ranges"),
          contentLength: r.headers.get("content-length"), bytesRecibidos: cuerpo.length };
      }

      // Puntos 3 y 4: video + Web Audio, midiendo memoria (pequeño primero como referencia, luego el grande dos veces)
      const corrida = async (archivo, saltos) => {
        stats.peticiones = 0; stats.bytes = 0; stats.rangos = [];
        const antes = memoria(); const muestras = [];
        const muestreo = setInterval(() => muestras.push(memoria()), 500);
        const r = await js(enPaginaVideo, { url: `app://reproductor/__media/${archivo}`, segundos: 3, saltos, eq: true });
        clearInterval(muestreo);
        r.memAntes = antes; r.memDespues = memoria();
        r.memMaxTotalMB = Math.max(...muestras.map((m) => m.totalMB));
        r.memMaxPrincipalRssMB = Math.max(...muestras.map((m) => m.principalRssMB));
        r.servido = { peticiones: stats.peticiones, bytesMB: Math.round(stats.bytes / 1048576), rangos: stats.rangos.slice(0, 16) };
        return r;
      };
      res.p3peq = await corrida("h264-aac.mp4", [0.5, 0.1, 0.9]);
      res.p3p4 = await corrida("grande.mp4", [0.5, 0.1, 0.9, 0.99, 0.3]);
      res.p3grande2 = await corrida("grande.mp4", [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]);
      if (FASE === "rango") return salir(0);

      // Punto 5: códecs
      res.p5canPlay = await js(enPaginaCodecs);
      res.p5real = {};
      for (const f of ["h264-aac.mp4", "hevc-aac.mp4", "av1-aac.mp4", "vp9-opus.webm", "h264-ac3.mp4", "h264-eac3.mp4", "h264-aac.mkv"])
        res.p5real[f] = await js(enPaginaVideo, { url: `app://reproductor/__media/${f}`, segundos: 1.5, saltos: [0.6], eq: false });

      // Punto 6: webUtils.getPathForFile con <input> y con soltar (vía protocolo de DevTools)
      const muestra = path.join(medios, "h264-aac.mp4");
      await js(() => {
        const i = document.createElement("input"); i.type = "file"; i.id = "pico-input"; document.body.append(i);
        const z = document.createElement("div"); z.id = "pico-zona";
        Object.assign(z.style, { position: "fixed", inset: "0", zIndex: "99999" });
        document.body.append(z);
        window.__soltado = null;
        z.addEventListener("dragover", (e) => e.preventDefault());
        z.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0];
          window.__soltado = f ? { nombre: f.name, tam: f.size, ruta: window.pico.ruta(f) } : { sinArchivos: true }; });
      });
      wc.debugger.attach("1.3");
      const cdp = (m, p) => wc.debugger.sendCommand(m, p);
      const { root } = await cdp("DOM.getDocument", {});
      const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#pico-input" });
      await cdp("DOM.setFileInputFiles", { nodeId, files: [muestra] });
      res.p6input = await js(() => { const f = document.getElementById("pico-input").files[0];
        return f ? { nombre: f.name, tam: f.size, ruta: window.pico.ruta(f), rutaArchivoSintetico: window.pico.ruta(new File(["x"], "x.txt")) } : null; });
      const datos = { items: [], files: [muestra], dragOperationsMask: 1 };
      try {
        for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: 100, y: 100, data: datos });
        await esperar(300);
        res.p6soltar = await js(() => window.__soltado);
      } catch (e) { res.p6soltar = { errorCdp: String(e) }; }
      wc.debugger.detach();
      res.p6esperada = muestra;

      // Punto 7: sandbox real del renderer
      const pid = wc.getOSProcessId();
      const leer = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return `(${e.code})`; } };
      const st = leer(`/proc/${pid}/status`);
      const ns = (p, n) => { try { return fs.readlinkSync(`/proc/${p}/ns/${n}`); } catch (e) { return `(${e.code})`; } };
      res.p7 = { pidRenderer: pid, preloadSandboxed: await js(() => window.pico.sandboxed),
        seccomp: /Seccomp:\s*(\d+)/.exec(st)?.[1], noNewPrivs: /NoNewPrivs:\s*(\d+)/.exec(st)?.[1],
        nsUserRenderer: ns(pid, "user"), nsUserPrincipal: ns(process.pid, "user"), nsPidRenderer: ns(pid, "pid"), nsPidPrincipal: ns(process.pid, "pid"),
        nsNetRenderer: ns(pid, "net"), nsNetPrincipal: ns(process.pid, "net"),
        chromeSandbox: (() => { try { const s = fs.statSync(path.join(path.dirname(process.execPath), "chrome-sandbox")); return { modo: s.mode.toString(8), uid: s.uid }; } catch (e) { return e.code; } })(),
        userns: leer("/proc/sys/kernel/unprivileged_userns_clone").trim(), maxUserNs: leer("/proc/sys/user/max_user_namespaces").trim(),
        gpu: app.getGPUFeatureStatus() };
      res.consolaFinal = consola.filter((c) => c.nivel !== "info" && c.nivel !== 0 && c.nivel !== 1);
      salir(0);
    } catch (e) { res.excepcion = String(e.stack || e); salir(1); }
  });
};
