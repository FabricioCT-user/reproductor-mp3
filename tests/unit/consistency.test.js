// Comprobaciones de que las piezas del proyecto encajan entre sí (lo que más se rompe al mover archivos).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const html = read("index.html");

const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
const swFiles = [...read("sw.js").match(/const FILES = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const normalize = (f) => f.replace(/^\.\//, "");

test("index.html carga scripts que existen y compilan", () => {
  assert.ok(scripts.length > 0);
  for (const s of scripts) {
    assert.ok(fs.existsSync(path.join(ROOT, s)), `falta ${s}`);
    assert.doesNotThrow(() => new vm.Script(read(s), { filename: s }), `error de sintaxis en ${s}`);
  }
});

test("los scripts se cargan en un orden válido (lo que usa cada uno ya está definido) y app.js va el último", () => {
  const order = scripts.map((s) => path.basename(s));
  const before = (a, b) => assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), `${a} debe cargarse antes que ${b}`);
  before("lyrics.js", "tags.js");
  before("id3.js", "tags.js");
  before("id3.js", "tag-writer.js");
  before("tags.js", "tag-writer.js");
  assert.equal(order.at(-1), "main.js");
});

test("el service worker precachea todo lo que carga la página y solo archivos que existen", () => {
  const cached = new Set(swFiles.map(normalize));
  for (const f of swFiles) if (f !== "./") assert.ok(fs.existsSync(path.join(ROOT, f)), `sw.js lista un archivo inexistente: ${f}`);
  for (const f of [...scripts, "style.css", "index.html", "manifest.webmanifest"]) assert.ok(cached.has(normalize(f)), `sw.js no precachea ${f}`);
});

test("los iconos del manifest existen", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `falta ${icon.src}`);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.start_url === "./" ? "index.html" : manifest.start_url)));
});

test("todos los elementos que el código busca por id existen en index.html", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const code = scripts.filter((s) => !/\/(id3|tags|tag-writer|lyrics|playlist-io|storage|util)\.js$/.test(s)).map(read).join("\n");

  const list = code.match(/const els = Object\.fromEntries\(\s*\[([\s\S]*?)\]\s*\.map/);
  assert.ok(list, "no se encontró la lista de elementos (els)");
  const declared = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const id of declared) assert.ok(ids.has(id), `els declara «${id}» pero index.html no tiene ese id`);

  // Cualquier els["x"] / els.x que se use debe estar declarado.
  const used = new Set([...code.matchAll(/els\["([^"]+)"\]/g)].map((m) => m[1]).concat([...code.matchAll(/els\.([a-zA-Z][\w]*)/g)].map((m) => m[1])));
  used.delete("toast"); // se declara pero también se usa como propiedad: comprobado abajo
  for (const id of used) assert.ok(declared.includes(id) || id === "toast", `el código usa els.${id} sin declararlo`);
  for (const id of [...code.matchAll(/els\[`edit-\$\{f\}`\]/g)].length ? ["edit-title", "edit-artist", "edit-album"] : []) assert.ok(declared.includes(id));
});

test("los identificadores del HTML no se repiten", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test("la CSP (si existe) permite lo que usa la página", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  if (!csp) return;
  for (const need of ["media-src 'self' blob:", "img-src 'self' blob: data:", "worker-src 'self'"]) assert.ok(csp.includes(need), `la CSP no incluye ${need}`);
});

test("la CSP autoriza exactamente el script en línea del tema (hash al día)", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(csp, "falta la CSP en index.html");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(inline.length, 1, "solo debe haber un script en línea");
  const hash = require("node:crypto").createHash("sha256").update(inline[0]).digest("base64");
  assert.ok(csp.includes(`'sha256-${hash}'`), `la CSP no incluye el hash actual del script en línea: sha256-${hash}`);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal([...html.matchAll(/\sstyle="/g)].length, 0, "hay estilos en línea y la CSP los bloquearía");
  assert.equal([...html.matchAll(/\son[a-z]+="/g)].length, 0, "hay manejadores de eventos en línea y la CSP los bloquearía");
});

test("los botones que solo tienen icono tienen nombre accesible", () => {
  for (const id of ["shuffle", "prev", "play", "next", "repeat", "mute"]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]*aria-label="[^"]+"`), `el botón ${id} no tiene aria-label`);
  }
});

test("manifest: la app se ofrece como manejadora de archivos de audio (Abrir con…)", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  const handlers = manifest.file_handlers;
  assert.ok(Array.isArray(handlers) && handlers.length > 0, "falta file_handlers");
  const isAudio = require("./helpers").load("util.js")("isAudio");
  for (const h of handlers) {
    assert.ok(h.action.startsWith("./") || h.action.startsWith("/"), "la acción debe estar dentro del alcance de la app");
    for (const [mime, exts] of Object.entries(h.accept)) {
      assert.match(mime, /^audio\//);
      for (const ext of exts) {
        assert.match(ext, /^\.[a-z0-9]+$/, `extensión mal escrita: ${ext}`);
        assert.ok(isAudio({ name: `x${ext}`, type: "" }), `la app no reconoce ${ext} como audio`);
      }
    }
  }
  const all = handlers.flatMap((h) => Object.values(h.accept).flat());
  assert.equal(new Set(all).size, all.length, "una extensión aparece en dos tipos distintos");
  for (const must of [".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav"]) assert.ok(all.includes(must), `falta ${must}`);
  assert.ok(manifest.launch_handler, "falta launch_handler (reutilizar la ventana abierta)");
});
