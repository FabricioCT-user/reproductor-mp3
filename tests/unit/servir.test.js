// Protocolo app://reproductor/ de la app de escritorio (electron/lib/servir.js). No necesita Electron.
const test = require("node:test");
const assert = require("node:assert/strict");
const servir = require("../../electron/lib/servir");

const SW = 'const VERSION = "v9";\nconst FILES = [\n  "./",\n  "index.html",\n  "style.css",\n  "src/util.js",\n  "src/app/main.js",\n  "icon.svg",\n];\n';
const lista = servir.listaBlanca(SW);
const URL_APP = "app://reproductor";
const get = (ruta, metodo = "GET", l = lista) => servir.resolver(URL_APP + ruta, metodo, l);

test("listaBlanca: FILES de sw.js + index.html, sin «./»", () => {
  assert.deepEqual([...lista].sort(), ["icon.svg", "index.html", "src/app/main.js", "src/util.js", "style.css"]);
  assert.throws(() => servir.listaBlanca("const OTRA = []"), /FILES/);
});

test("listaBlanca: los archivos de prueba solo con --smoke", () => {
  for (const f of servir.PRUEBAS) assert.ok(!lista.has(f));
  const conSmoke = servir.listaBlanca(SW, { smoke: true });
  for (const f of servir.PRUEBAS) assert.ok(conSmoke.has(f));
  assert.equal(get("/tests/smoke.html").estado, 404);
  assert.equal(get("/tests/smoke.html", "GET", conSmoke).rel, "tests/smoke.html");
});

test("sirve los archivos de la lista con su tipo", () => {
  assert.deepEqual(get("/index.html"), { estado: 200, rel: "index.html", tipo: "text/html; charset=utf-8" });
  assert.equal(get("/src/app/main.js").tipo, "text/javascript; charset=utf-8");
  assert.equal(get("/style.css").tipo, "text/css; charset=utf-8");
  assert.equal(get("/icon.svg").tipo, "image/svg+xml");
  assert.equal(get("/index.html", "HEAD").estado, 200);
});

test("la raíz es index.html; la consulta y el fragmento se ignoran", () => {
  assert.equal(get("/").rel, "index.html");
  assert.equal(get("").rel, "index.html");
  assert.equal(get("/index.html?x=1#y").rel, "index.html");
});

test("rechaza lo que no está en la lista: otros archivos, mayúsculas, barra final, directorios", () => {
  for (const r of ["/sw.js", "/package.json", "/electron/main.js", "/src", "/src/", "/src/app/",
    "/INDEX.HTML", "/Style.css", "/index.html/", "/style.css/.", "/.git/config", "/index.htm", "/style.css%00"]) {
    assert.equal(get(r).estado, 404, r);
  }
});

test("rechaza el recorrido de directorios en todas sus formas", () => {
  for (const r of ["/../package.json", "/src/../../etc/passwd", "/%2e%2e/package.json", "/%2E%2E/%2e%2e/etc/passwd",
    "/src/%2e%2e%2f%2e%2e%2fetc/passwd", "/src%2f..%2f..%2fetc%2fpasswd", "/..%5c..%5cetc%5cpasswd", "/src\\..\\index.html",
    "//etc/passwd", "/%2fetc/passwd", "/C:/Windows/win.ini", "/c%3a/x", "/%00index.html"]) {
    const r2 = get(r);
    // Una URL como /src/../index.html la normaliza el propio analizador a /index.html (archivo legítimo): eso sí vale.
    assert.ok(r2.estado !== 200 || r2.rel === "index.html", `${r} → ${JSON.stringify(r2)}`);
    assert.ok(!r2.rel || lista.has(r2.rel));
  }
  assert.equal(get("/%2e%2e/package.json").estado, 404);
  assert.equal(get("/src%2f..%2f..%2fetc%2fpasswd").estado, 404);
});

test("codificación inválida → 400; métodos que no son GET/HEAD → 405", () => {
  assert.equal(get("/%E0%A4%A").estado, 400);
  assert.equal(get("/%zz").estado, 400);
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS", "get"]) assert.equal(get("/index.html", m).estado, 405, m);
});

test("solo el host reproductor del esquema app:", () => {
  for (const u of ["app://otro/index.html", "app://reproductor.evil/index.html", "app://reproductor:8000/index.html",
    "app://x@reproductor/index.html", "file:///index.html", "http://reproductor/index.html", "https://localhost/index.html", "no es url"]) {
    assert.equal(servir.resolver(u, "GET", lista).estado, 404, u);
    assert.equal(servir.esUrlDeApp(u), false, u);
  }
  assert.equal(servir.esUrlDeApp("app://reproductor/index.html"), true);
  // Chromium ya entrega el host en minúsculas (esquema estándar); Node no lo normaliza en esquemas no especiales: estricto.
  assert.equal(servir.esUrlDeApp("app://REPRODUCTOR/index.html"), false);
});

test("__media/<id>: solo ids de 32 hex en minúsculas (lo sirve T2.1)", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(get(`/__media/${id}`), { estado: 200, medio: id });
  for (const r of ["/__media/", "/__media/abc", `/__media/${id.toUpperCase()}`, `/__media/${id}0`, `/__media/${id}/x`,
    `/__media/${id.slice(1)}g`, "/__media/..%2fpackage.json", `/__media/%2e%2e/${id}`]) {
    assert.equal(get(r).estado, 404, r);
  }
});

test("cabeceras: CSP idéntica a la del meta salvo en las páginas de prueba; nosniff siempre", () => {
  const csp = servir.cspDeHtml('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; object-src \'none\'">');
  assert.equal(csp, "default-src 'self'; object-src 'none'");
  assert.equal(servir.cspDeHtml("<html></html>"), null);
  const h = servir.cabeceras("index.html", csp);
  assert.equal(h["Content-Security-Policy"], csp);
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Content-Type"], "text/html; charset=utf-8");
  assert.equal(servir.cabeceras("tests/smoke.html", csp)["Content-Security-Policy"], undefined);
  assert.equal(servir.cabeceras("tests/smoke.js", csp)["X-Content-Type-Options"], "nosniff");
  assert.equal(servir.tipoDe("x.desconocido"), "application/octet-stream");
});
