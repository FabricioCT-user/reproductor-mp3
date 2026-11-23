// Validación de rutas que llegan del sistema (electron/lib/rutas.js) y registro de entregas (electron/lib/entregas.js).
// No necesitan Electron: usan una carpeta temporal real (enlaces simbólicos, carpetas, nombres con espacios).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const rutas = require("../../electron/lib/rutas");
const { Entregas } = require("../../electron/lib/entregas");
const { load } = require("./helpers");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rutas-prueba-")));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const crear = (rel, datos = "x") => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, datos);
  return p;
};

test("clasificar: por extensión, sin distinguir mayúsculas; las falsas no valen", () => {
  assert.deepEqual(rutas.clasificar("a.mp3"), { clase: "audio", tipo: "audio/mpeg" });
  assert.deepEqual(rutas.clasificar("/x/Canción.FLAC"), { clase: "audio", tipo: "audio/flac" });
  assert.equal(rutas.clasificar("peli.mkv").clase, "video");
  assert.equal(rutas.clasificar("letra.lrc").clase, "letra");
  assert.equal(rutas.clasificar("s.srt").clase, "subtitulo");
  assert.equal(rutas.clasificar("s.vtt").clase, "subtitulo");
  for (const n of ["cancion.mp3.txt", "mp3", ".mp3", "a.mp3.", "a.exe", "a", "a.toString", "a.constructor", "a.__proto__"]) {
    assert.equal(rutas.clasificar(n), null, n);
  }
});

test("clasificar: las extensiones de audio son las mismas que reconoce la interfaz (isAudio de util.js)", () => {
  const isAudio = load("util.js")("isAudio");
  const audio = Object.keys(rutas.EXTENSIONES).filter((e) => rutas.EXTENSIONES[e][0] === "audio");
  for (const e of audio) assert.equal(isAudio({ name: `a${e}`, type: "" }), true, e);
  for (const e of ["mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "wav", "weba"]) assert.ok(audio.includes(`.${e}`), e);
});

test("aRuta: absolutas, relativas a la carpeta de trabajo y file:// (con espacios y acentos)", () => {
  assert.equal(rutas.aRuta("/m/a b/c.mp3", "/x"), "/m/a b/c.mp3");
  assert.equal(rutas.aRuta("/m/./sub/../c.mp3", "/x"), "/m/c.mp3");
  assert.equal(rutas.aRuta("sub dir/c.mp3", "/home/ana"), "/home/ana/sub dir/c.mp3");
  assert.equal(rutas.aRuta("c.mp3", "relativa"), null);
  assert.equal(rutas.aRuta("c.mp3", undefined), null);
  assert.equal(rutas.aRuta("file:///m/a%20b/Canci%C3%B3n.mp3"), "/m/a b/Canción.mp3");
  assert.equal(rutas.aRuta(pathToFileURL("/m/dos espacios  ñ.mp3").href), "/m/dos espacios  ñ.mp3");
  assert.equal(rutas.aRuta("file://localhost/m/c.mp3"), "/m/c.mp3");
});

test("aRuta: nada que no sea un archivo local", () => {
  for (const a of ["file://otro-equipo/m/c.mp3", "http://localhost/c.mp3", "smb://nas/c.mp3", "mailto:a@b.mp3", "", "/m/a\0b.mp3", null, 3]) {
    assert.equal(rutas.aRuta(a, "/x"), null, String(a));
  }
});

test("validar: archivo regular de medio → datos con la ruta real", async () => {
  const p = crear("con espacios/Canción uno.mp3", "12345");
  const v = await rutas.validar(p);
  assert.equal(v.ruta, p);
  assert.equal(v.nombre, "Canción uno.mp3");
  assert.equal(v.tamano, 5);
  assert.equal(v.tipo, "audio/mpeg");
  assert.equal(v.clase, "audio");
  assert.equal(v.fecha, Math.floor(fs.statSync(p).mtimeMs));
  assert.equal((await rutas.validar(rutas.aRuta(pathToFileURL(p).href))).ruta, p);
});

test("validar: rechaza lo que no existe, carpetas, extensiones falsas y rutas relativas", async () => {
  crear("nota.mp3.txt");
  fs.mkdirSync(path.join(dir, "carpeta.mp3"));
  for (const p of [path.join(dir, "no-existe.mp3"), path.join(dir, "carpeta.mp3"), path.join(dir, "nota.mp3.txt"), "relativa.mp3", "", null]) {
    assert.equal(await rutas.validar(p), null, String(p));
  }
});

test("validar: enlaces simbólicos se resuelven y cuenta la extensión del destino", async () => {
  const real = crear("real.flac");
  const secreto = crear("secreto.txt");
  fs.symlinkSync(real, path.join(dir, "enlace con espacios.mp3"));
  fs.symlinkSync(secreto, path.join(dir, "disfrazado.mp3"));
  fs.symlinkSync(path.join(dir, "no-existe.mp3"), path.join(dir, "roto.mp3"));
  fs.symlinkSync(path.join(dir, "con espacios"), path.join(dir, "a-carpeta.mp3"));
  const v = await rutas.validar(path.join(dir, "enlace con espacios.mp3"));
  assert.equal(v.ruta, real);
  assert.equal(v.nombre, "real.flac");
  assert.equal(v.tipo, "audio/flac");
  for (const n of ["disfrazado.mp3", "roto.mp3", "a-carpeta.mp3"]) assert.equal(await rutas.validar(path.join(dir, n)), null, n);
});

test("recorrer: subcarpetas en orden natural, con ruta relativa; sin ocultos, sin repetidos y sin seguir enlaces a carpetas", async () => {
  const raiz = path.join(dir, "Álbum");
  crear("Álbum/10 diez.mp3");
  crear("Álbum/2 dos.mp3");
  crear("Álbum/2 dos.lrc");
  crear("Álbum/portada.jpg");
  crear("Álbum/.oculto.mp3");
  crear("Álbum/.oculta/x.mp3");
  crear("Álbum/CD 2/1 uno.ogg");
  fs.symlinkSync(path.join(raiz, "2 dos.mp3"), path.join(raiz, "z-enlace.mp3"));
  fs.symlinkSync(raiz, path.join(raiz, "bucle"));
  const r = await rutas.recorrer(raiz);
  assert.deepEqual(r.map((x) => x.rel), ["Álbum/2 dos.lrc", "Álbum/2 dos.mp3", "Álbum/10 diez.mp3", "Álbum/CD 2/1 uno.ogg"]);
  assert.ok(r.every((x) => x.ruta.startsWith(raiz)));
  assert.deepEqual(await rutas.recorrer(path.join(raiz, "2 dos.mp3")), [], "un archivo no es una carpeta");
  assert.deepEqual(await rutas.recorrer(path.join(dir, "no-existe")), []);
});

test("recorrer: respeta los límites de archivos y profundidad", async () => {
  crear("hondo/a.mp3");
  crear("hondo/1/b.mp3");
  crear("hondo/1/2/c.mp3");
  const raiz = path.join(dir, "hondo");
  assert.deepEqual((await rutas.recorrer(raiz, { archivos: 100, profundidad: 2 })).map((x) => x.rel), ["hondo/1/b.mp3", "hondo/a.mp3"]);
  assert.equal((await rutas.recorrer(raiz, { archivos: 1, profundidad: 8 })).length, 1);
});

test("leer: devuelve los bytes; falla con enlaces simbólicos, carpetas o por encima del límite", async () => {
  const p = crear("leer.mp3", "hola");
  assert.equal((await rutas.leer(p)).toString(), "hola");
  fs.symlinkSync(p, path.join(dir, "leer-enlace.mp3"));
  await assert.rejects(rutas.leer(path.join(dir, "leer-enlace.mp3")));
  await assert.rejects(rutas.leer(path.join(dir, "con espacios")));
  await assert.rejects(rutas.leer(p, { limite: 3 }));
});

/* ----- entregas.js ----- */

const v = (extra = {}) => ({ ruta: "/m/a.mp3", nombre: "a.mp3", tamano: 3, fecha: 1700000000500, tipo: "audio/mpeg", clase: "audio", ...extra });

test("entregas: la interfaz recibe un id y datos, nunca la ruta", () => {
  const e = new Entregas();
  const pub = e.registrar(v({ rel: "Álbum/a.mp3" }));
  assert.match(pub.id, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...pub, id: 0 }, { id: 0, name: "a.mp3", size: 3, lastModified: 1700000000500, type: "audio/mpeg", kind: "audio", rel: "Álbum/a.mp3" });
  assert.ok(!JSON.stringify(pub).includes("/m/"));
  assert.notEqual(e.registrar(v()).id, pub.id);
});

test("entregas: cada id se toma una sola vez; inventados o mal formados no valen", () => {
  const e = new Entregas();
  const { id } = e.registrar(v());
  assert.equal(e.tomar("0".repeat(32)), null);
  assert.equal(e.tomar(id.toUpperCase()), null);
  assert.equal(e.tomar({ toString: () => id }), null);
  assert.equal(e.tomar(id).ruta, "/m/a.mp3");
  assert.equal(e.tomar(id), null);
});

test("entregas: los videos no se leen; solo se toman para enlazarlos (y el audio no se enlaza)", () => {
  const e = new Entregas();
  const pub = e.registrar(v({ clase: "video", nombre: "p.mp4", tipo: "video/mp4" }));
  assert.equal(pub.kind, "video");
  assert.equal(e.tomar(pub.id), null);
  assert.equal(e.tamano, 1);
  assert.ok(e.tomar(e.registrar(v({ clase: "letra" })).id));
  const audio = e.registrar(v());
  assert.equal(e.tomar(audio.id, ["video"]), null);
  assert.equal(e.tomar(pub.id, ["video"]).ruta, "/m/a.mp3");
  assert.equal(e.tomar(pub.id, ["video"]), null, "una sola vez");
});

test("entregas: caducan y hay un máximo (se descartan las más viejas)", () => {
  let t = 1000;
  const e = new Entregas({ ahora: () => t, caducidad: 100, maximo: 2 });
  const a = e.registrar(v());
  t += 100;
  assert.equal(e.tomar(a.id), null, "caducada");
  const b = e.registrar(v());
  const c = e.registrar(v());
  const d = e.registrar(v());
  assert.equal(e.tamano, 2);
  assert.equal(e.tomar(b.id), null);
  assert.ok(e.tomar(c.id) && e.tomar(d.id));
});
