const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("ejemplos de demo: medios, parejas y generador reproducible", () => {
  const demo = path.join(root, "ejemplos");
  const names = ["Brisa.mp3", "Brisa.lrc", "Jardín.flac", "Nubes.mp3", "Paseo.webm", "Paseo.vtt"];
  for (const name of names) assert.ok(fs.statSync(path.join(demo, name)).size > 0, `falta ${name}`);
  assert.ok(names.reduce((sum, name) => sum + fs.statSync(path.join(demo, name)).size, 0) < 4 * 1024 * 1024);
  assert.match(read("scripts/generar-ejemplos.js"), /spawnSync\("timeout"/);
  assert.match(read("scripts/generar-ejemplos.js"), /stdio: \["ignore"/);
  assert.match(read("ejemplos/LEEME.md"), /licencia del repositorio/);
});

test("demo: el HTML, el importador y la CSP son mismo origen y fuera del paquete", () => {
  const html = read("index.html");
  const app = read("src/app/library.js");
  const sw = read("sw.js");
  const pkg = JSON.parse(read("package.json"));
  assert.match(html, /id="demo-examples"[^>]*hidden/);
  assert.match(html, /id="demo-status"[^>]*role="status"/);
  assert.match(app, /new URL\("ejemplos\/", document\.baseURI\)/);
  assert.match(app, /await Promise\.all\(names\.map/);
  assert.match(app, /state\.tracks\.length > 0/);
  assert.match(app, /window\.reproductor \|\| state\.tracks\.length/);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(sw, /ejemplos\//);
  assert.ok(!pkg.build.files.some((f) => f.startsWith("ejemplos/")));
});

test("smoke: comprueba visibilidad, doble clic, error de red y asociación de acompañantes", () => {
  const smoke = read("tests/smoke.js");
  for (const text of [
    "demo web: botón visible con biblioteca vacía",
    "demo: doble clic lanza una sola descarga por archivo",
    "demo error: mensaje claro y botón recuperado",
    "demo error: no deja pistas a medias",
    "demo: letra LRC emparejada",
    "demo: subtítulos VTT emparejados",
  ]) assert.ok(smoke.includes(text), `falta comprobación de humo: ${text}`);
});

test("service worker solo limpia cachés propias y recupera desde VERSION", async () => {
  const sw = read("sw.js");
  const handlers = {};
  const removed = [];
  const opened = [];
  const context = {
    self: { addEventListener: (name, fn) => { handlers[name] = fn; }, clients: { claim: async () => {} } },
    caches: {
      keys: async () => ["v8", "v10", "cache-de-otro-proyecto", "user-data"],
      delete: async (key) => { removed.push(key); return true; },
      open: async (key) => { opened.push(key); return { match: async () => ({ cached: key }) }; },
    },
    location: { origin: "https://example.test" },
    fetch: async () => { throw new TypeError("offline"); },
    URL,
  };
  vm.runInNewContext(sw, context);
  let activation;
  handlers.activate({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(removed, ["v8"]);

  let response;
  handlers.fetch({
    request: { method: "GET", url: "https://example.test/ejemplos/Brisa.mp3", mode: "cors" },
    respondWith: (promise) => { response = promise; },
  });
  assert.deepEqual(await response, { cached: "v10" });
  assert.deepEqual(opened, ["v10"]);
});
