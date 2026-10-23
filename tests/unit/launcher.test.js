// Servidor local y lanzador («Abrir con…»). Se prueban de verdad: se arranca el servidor Python y se le hacen peticiones.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const SERVIDOR = path.join(ROOT, "launcher", "servidor.py");
const LANZADOR = path.join(ROOT, "launcher", "reproductor");
const INSTALAR = path.join(ROOT, "launcher", "instalar.sh");

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reproductor-test-"));
let contador = 0;

// Cada prueba tiene su propia carpeta de caché (XDG_CACHE_HOME): su cola y su pid nunca se mezclan ni tocan los reales.
function entorno() {
  const cache = path.join(tmp, `cache${++contador}`);
  const env = { ...process.env, XDG_CACHE_HOME: cache, REPRODUCTOR_ESPERA: "1", REPRODUCTOR_NO_ABRIR: "1" };
  delete env.REPRODUCTOR_COLA;
  return { env, cola: path.join(cache, "reproductor-mp3", "cola") };
}

const children = [];
test.after(() => {
  children.forEach((c) => c.kill());
  fs.rmSync(tmp, { recursive: true, force: true });
});

function file(name, bytes = crypto.randomBytes(2000)) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return { p, bytes };
}

function startServer(ctx = entorno()) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SERVIDOR, "--port", "0"], { env: ctx.env });
    children.push(child);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/PUERTO=(\d+)/);
      if (m) resolve({ port: Number(m[1]), child, ...ctx });
    });
    child.on("error", reject);
    child.on("exit", (c) => reject(new Error(`el servidor terminó (${c})`)));
  });
}

function request(port, p, { host, headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: host ?? `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
const json = async (port, p, o) => JSON.parse((await request(port, p, o)).body.toString());

// Asíncrono: algunas pruebas tienen un servidor de Node en este mismo proceso y no se puede bloquear.
const lanzar = (args, env) => new Promise((resolve) => {
  const child = spawn("python3", [LANZADOR, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), 20000);
  child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Servidor ---------- */

test("el servidor sirve la aplicación, el manifest con su tipo y un estado propio", { skip: !hasPython }, async () => {
  const { port } = await startServer();
  const index = await request(port, "/index.html");
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /Reproductor MP3/);
  assert.match((await request(port, "/manifest.webmanifest")).headers["content-type"], /manifest\+json/);
  assert.deepEqual(await json(port, "/__reproductor"), { app: "reproductor-mp3", version: 1, pagina_conectada: false });
});

test("rechaza cualquier petición con un Host que no sea localhost / 127.0.0.1 de su puerto (DNS rebinding)", { skip: !hasPython }, async () => {
  const { port } = await startServer();
  for (const p of ["/", "/index.html", "/__reproductor", "/__abrir/esperar"]) {
    assert.equal((await request(port, p, { host: `evil.example:${port}` })).status, 403, `Host falso aceptado en ${p}`);
    assert.equal((await request(port, p, { host: "localhost" })).status, 403, `Host sin puerto aceptado en ${p}`);
  }
  assert.equal((await request(port, "/__reproductor", { host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await request(port, "/", { method: "HEAD", host: "evil.example" })).status, 403);
});

test("los endpoints /__abrir rechazan peticiones de otros sitios", { skip: !hasPython }, async () => {
  const { port } = await startServer();
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await request(port, "/__abrir/esperar", { headers: { "Sec-Fetch-Site": site } })).status, 403);
  }
  assert.equal((await request(port, "/__abrir/esperar", { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
});

test("no sale de su carpeta: rutas con .. no devuelven archivos del sistema", { skip: !hasPython }, async () => {
  const { port } = await startServer();
  for (const p of ["/..%2f..%2f..%2f..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/__abrir/archivo/..%2f..%2fetc%2fpasswd"]) {
    const r = await request(port, p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.toString().includes("root:"), `se filtró /etc/passwd con ${p}`);
  }
});

/* ---------- Lanzador + cola ---------- */

test("lanzador → cola → servidor: el archivo llega idéntico una sola vez, en orden y con su tipo", { skip: !hasPython }, async () => {
  const { port, env } = await startServer();
  const a = file("uno.mp3");
  const b = file("dos.flac");
  const r = await lanzar(["--puerto", String(port), a.p, b.p], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Listo/);

  const items = await json(port, "/__abrir/esperar");
  assert.deepEqual(items.map((i) => i.name), ["uno.mp3", "dos.flac"]);
  assert.deepEqual(items.map((i) => i.type), ["audio/mpeg", "audio/flac"]);
  assert.equal(items[0].size, a.bytes.length);
  assert.ok(Math.abs(items[0].mtime - fs.statSync(a.p).mtimeMs / 1000) < 1);

  const got = await request(port, `/__abrir/archivo/${items[0].id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers["content-type"], "audio/mpeg");
  assert.ok(got.body.equals(a.bytes), "el contenido no coincide");
  assert.equal((await request(port, `/__abrir/archivo/${items[0].id}`)).status, 404, "se entregó dos veces");

  assert.deepEqual((await json(port, "/__abrir/esperar")).map((i) => i.name), ["dos.flac"]); // el segundo sigue pendiente
});

test("la espera larga avisa de que hay una página conectada y devuelve [] si no llega nada", { skip: !hasPython }, async () => {
  const { port } = await startServer();
  const espera = request(port, "/__abrir/esperar");
  await wait(300);
  assert.equal((await json(port, "/__reproductor")).pagina_conectada, true);
  assert.deepEqual(JSON.parse((await espera).body.toString()), []);
  assert.equal((await json(port, "/__reproductor")).pagina_conectada, false);
});

test("una espera larga recibe al instante un archivo que llega mientras espera", { skip: !hasPython }, async () => {
  const { port, env } = await startServer();
  const espera = json(port, "/__abrir/esperar");
  await wait(300);
  await lanzar(["--puerto", String(port), file("tarde.mp3").p], env);
  assert.deepEqual((await espera).map((i) => i.name), ["tarde.mp3"]);
});

test("el lanzador ignora lo que no es audio (y falla si no queda nada)", { skip: !hasPython }, async () => {
  const { port, env } = await startServer();
  const txt = file("nota.txt");
  const soloTxt = await lanzar(["--puerto", String(port), txt.p], env);
  assert.equal(soloTxt.status, 1);
  assert.match(soloTxt.stderr, /no es un archivo de audio/);
  const mixto = await lanzar(["--puerto", String(port), txt.p, file("bien.wav").p, path.join(tmp, "no-existe.mp3")], env);
  assert.equal(mixto.status, 0);
  assert.deepEqual((await json(port, "/__abrir/esperar")).map((i) => i.name), ["bien.wav"]);
});

test("el servidor descarta entradas de cola trucadas aunque alguien las escriba a mano", { skip: !hasPython }, async () => {
  const { port, cola } = await startServer();
  const bueno = file("real.ogg");
  const ahora = Date.now() / 1000;
  const id = () => crypto.randomBytes(16).toString("hex");
  const escribe = (nombre, datos) => fs.writeFileSync(path.join(cola, nombre), JSON.stringify(datos));
  const malos = {
    sinAudio: { path: "/etc/hostname", name: "hostname.mp3", t: ahora },          // extensión real no es de audio
    noExiste: { path: path.join(tmp, "fantasma.mp3"), name: "fantasma.mp3", t: ahora },
    relativa: { path: "real.ogg", name: "real.ogg", t: ahora },
    nombreConRuta: { path: bueno.p, name: "../../x.ogg", t: ahora },
    caducada: { path: bueno.p, name: "real.ogg", t: ahora - 3600 },
  };
  for (const d of Object.values(malos)) escribe(`${id()}.json`, d);
  escribe("no-es-un-id.json", { path: bueno.p, name: "real.ogg", t: ahora });
  fs.writeFileSync(path.join(cola, `${id()}.json`), "{esto no es json");

  assert.deepEqual(await json(port, "/__abrir/esperar"), []);
  assert.deepEqual(fs.readdirSync(cola).filter((f) => f.endsWith(".json") && f !== "no-es-un-id.json"), [], "no se limpiaron las entradas inválidas");
  // Entrada válida pero FUERA de la cola (un nivel más arriba): el id con «../» no debe poder alcanzarla.
  const fuera = id();
  fs.writeFileSync(path.join(path.dirname(cola), `${fuera}.json`), JSON.stringify({ path: bueno.p, name: "real.ogg", t: ahora }));
  // (http.request de Node no normaliza la ruta: llega tal cual, como la enviaría un cliente malicioso)
  for (const ruta of [`/__abrir/archivo/../${fuera}`, `/__abrir/archivo/..%2f${fuera}`]) {
    assert.equal((await request(port, ruta)).status, 404, `el id con ../ alcanzó un archivo fuera de la cola (${ruta})`);
  }
  // y el id manipulado en la URL tampoco entrega nada
  for (const malId of ["../x", "no-es-un-id", "A".repeat(32), "0".repeat(31)]) {
    assert.equal((await request(port, `/__abrir/archivo/${encodeURIComponent(malId)}`)).status, 404, malId);
  }
});

/* ---------- Arranque y parada desde el lanzador ---------- */

test("sin servidor en marcha, el lanzador lo arranca solo y --detener lo apaga", { skip: !hasPython }, async () => {
  const port = await freePort();
  const { env } = entorno();
  const r = await lanzar(["--puerto", String(port), file("auto.mp3").p], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await json(port, "/__reproductor")).app, "reproductor-mp3");
  assert.deepEqual((await json(port, "/__abrir/esperar")).map((i) => i.name), ["auto.mp3"]);

  assert.match((await lanzar(["--detener"], env)).stdout, /detenido/);
  await wait(500);
  await assert.rejects(request(port, "/__reproductor"));
});

test("si el puerto lo ocupa otro programa, el lanzador lo dice en vez de pisarlo", { skip: !hasPython }, async () => {
  const { env } = entorno();
  const otro = http.createServer((q, s) => { s.statusCode = 404; s.end("otro"); });
  await new Promise((r) => otro.listen(0, "127.0.0.1", r));
  children.push({ kill: () => otro.close() });
  const r = await lanzar(["--puerto", String(otro.address().port), file("x.mp3").p], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ocupa otro programa/);
});

/* ---------- Instalador del acceso en el escritorio ---------- */

test("instalar.sh crea un .desktop válido solo en la carpeta de usuario y --quitar lo elimina", { skip: !hasPython }, () => {
  const datos = path.join(tmp, "datos");
  const e = { ...entorno().env, XDG_DATA_HOME: datos, XDG_CONFIG_HOME: path.join(tmp, "config") };
  const r = spawnSync("bash", [INSTALAR], { env: e, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  const desktop = path.join(datos, "applications", "reproductor-mp3.desktop");
  const txt = fs.readFileSync(desktop, "utf8");
  assert.match(txt, /^Exec="[^"]+\/launcher\/reproductor" %F$/m);
  assert.match(txt, /^MimeType=.*audio\/mpeg;.*audio\/flac;/m);
  assert.match(txt, /^Icon=.*icon-512\.png$/m);
  assert.ok(fs.existsSync(txt.match(/^Exec="([^"]+)"/m)[1]), "el ejecutable del Exec no existe");
  assert.ok(fs.existsSync(txt.match(/^Icon=(.+)$/m)[1]), "el icono no existe");
  if (spawnSync("which", ["desktop-file-validate"]).status === 0) {
    assert.equal(spawnSync("desktop-file-validate", [desktop]).status, 0, "el .desktop no valida");
  }

  assert.equal(spawnSync("bash", [INSTALAR, "--quitar"], { env: e }).status, 0);
  assert.ok(!fs.existsSync(desktop));
  assert.equal(spawnSync("bash", [INSTALAR, "--cosa-rara"], { env: e }).status, 1);
});

test("instalar.sh --predeterminado fija el programa por defecto (solo en la configuración de prueba)", { skip: !hasPython || spawnSync("which", ["xdg-mime"]).status !== 0 }, () => {
  const e = { ...entorno().env, XDG_DATA_HOME: path.join(tmp, "datos2"), XDG_CONFIG_HOME: path.join(tmp, "config2"), HOME: path.join(tmp, "home2") };
  fs.mkdirSync(e.HOME, { recursive: true });
  const r = spawnSync("bash", [INSTALAR, "--predeterminado"], { env: e, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const q = spawnSync("xdg-mime", ["query", "default", "audio/mpeg"], { env: e, encoding: "utf8" });
  assert.equal(q.stdout.trim(), "reproductor-mp3.desktop");
});
