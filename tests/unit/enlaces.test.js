// Registro de videos enlazados (electron/lib/enlaces.js): persistencia, permisos 0600, escritura atómica, ids opacos.
// No necesita Electron: usa una carpeta temporal real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Enlaces, esId } = require("../../electron/lib/enlaces");

const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "enlaces-prueba-")));
test.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
let n = 0;
const carpeta = () => { const d = path.join(raiz, `datos-${n++}`); fs.mkdirSync(d); return d; };
const video = (nombre, bytes = 100) => {
  const p = path.join(raiz, nombre);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  const st = fs.statSync(p);
  return { ruta: p, nombre, tamano: st.size, fecha: Math.floor(st.mtimeMs), tipo: "video/mp4", clase: "video" };
};

test("enlaces: ids de 32 hex, distintos aunque sea el mismo archivo; se guardan y se recargan", async () => {
  const d = carpeta();
  const archivo = path.join(d, "enlaces.json");
  const e = await new Enlaces(archivo).cargar();
  assert.equal(e.tamano, 0, "sin archivo, vacío");
  const v = video("uno.mp4");
  const id1 = await e.registrar(v);
  const id2 = await e.registrar(v);
  assert.ok(esId(id1) && esId(id2));
  assert.notEqual(id1, id2);
  assert.ok(!id1.includes("uno"));
  assert.deepEqual(e.obtener(id1), { ruta: v.ruta, tamano: 100, fecha: v.fecha, tipo: "video/mp4" });

  const otra = await new Enlaces(archivo).cargar(); // como tras reiniciar la app
  assert.equal(otra.tamano, 2);
  assert.equal(otra.obtener(id2).ruta, v.ruta);
  assert.equal(otra.obtener("0".repeat(32)), null);
  assert.equal(otra.obtener(id1.toUpperCase()), null);
  assert.equal(otra.obtener({ toString: () => id1 }), null);
});

test("enlaces: el archivo tiene permisos 0600 y no quedan temporales", async () => {
  const d = carpeta();
  const archivo = path.join(d, "enlaces.json");
  const e = await new Enlaces(archivo).cargar();
  const mascara = process.umask(0); // aunque la umask lo permitiera todo
  try { await e.registrar(video("dos.mp4")); } finally { process.umask(mascara); }
  assert.equal(fs.statSync(archivo).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(d), ["enlaces.json"]);
});

test("enlaces: crea la carpeta de datos si falta (0700)", async () => {
  const d = path.join(carpeta(), "nueva");
  const e = await new Enlaces(path.join(d, "enlaces.json")).cargar();
  await e.registrar(video("tres.mp4"));
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
});

test("enlaces: olvidar y vaciar persisten; ids inventados no hacen nada", async () => {
  const archivo = path.join(carpeta(), "enlaces.json");
  const e = await new Enlaces(archivo).cargar();
  const a = await e.registrar(video("a.mp4"));
  const b = await e.registrar(video("b.mp4"));
  assert.equal(await e.olvidar("f".repeat(32)), false);
  assert.equal(await e.olvidar("../a"), false);
  assert.equal(await e.olvidar(a), true);
  assert.equal(await e.olvidar(a), false);
  assert.equal((await new Enlaces(archivo).cargar()).obtener(b).ruta, path.join(raiz, "b.mp4"));
  assert.equal((await new Enlaces(archivo).cargar()).obtener(a), null);
  await e.vaciar();
  assert.equal((await new Enlaces(archivo).cargar()).tamano, 0);
});

test("enlaces: escrituras seguidas sin esperar quedan todas (en fila, la última gana)", async () => {
  const archivo = path.join(carpeta(), "enlaces.json");
  const e = await new Enlaces(archivo).cargar();
  const v = video("muchos.mp4");
  const ids = await Promise.all(Array.from({ length: 30 }, () => e.registrar(v)));
  await Promise.all(ids.slice(0, 10).map((id) => e.olvidar(id)));
  const otra = await new Enlaces(archivo).cargar();
  assert.equal(otra.tamano, 20);
  assert.ok(ids.slice(10).every((id) => otra.obtener(id)));
});

test("enlaces: JSON corrupto → registro vacío sin romper el arranque, y el corrupto se aparta", async () => {
  for (const basura of ["{no es json", "null", "[]", '"texto"', '{"enlaces": 5}', ""]) {
    const d = carpeta();
    const archivo = path.join(d, "enlaces.json");
    fs.writeFileSync(archivo, basura);
    const e = await new Enlaces(archivo).cargar();
    assert.equal(e.tamano, 0, basura);
    assert.ok(fs.existsSync(`${archivo}.corrupto`), basura);
    await e.registrar(video("tras-corrupto.mp4"));
    assert.equal((await new Enlaces(archivo).cargar()).tamano, 1);
  }
});

test("enlaces: entradas con ids no hex o datos raros se descartan; las buenas se conservan", async () => {
  const archivo = path.join(carpeta(), "enlaces.json");
  const bueno = "a".repeat(32);
  fs.writeFileSync(archivo, JSON.stringify({ formato: 1, enlaces: {
    [bueno]: { ruta: "/m/v.mp4", tamano: 5, fecha: 1, tipo: "video/mp4" },
    ["A".repeat(32)]: { ruta: "/m/v.mp4", tamano: 5, fecha: 1 },
    "../../etc/passwd": { ruta: "/etc/passwd", tamano: 5, fecha: 1 },
    ["b".repeat(32)]: { ruta: "relativa/v.mp4", tamano: 5, fecha: 1 },
    ["c".repeat(32)]: { ruta: "/m/v.mp4", tamano: -1, fecha: 1 },
    ["d".repeat(32)]: { ruta: "/m/v\0.mp4", tamano: 5, fecha: 1 },
    ["e".repeat(32)]: null,
    __proto__: { ruta: "/x", tamano: 1, fecha: 1 },
  } }));
  const e = await new Enlaces(archivo).cargar();
  assert.equal(e.tamano, 1);
  assert.equal(e.obtener(bueno).ruta, "/m/v.mp4");
  assert.ok(!fs.existsSync(`${archivo}.corrupto`));
});

test("enlaces: estado distingue ok, falta, cambiado y desconocido", async () => {
  const e = await new Enlaces(path.join(carpeta(), "enlaces.json")).cargar();
  const ok = await e.registrar(video("ok.mp4"));
  const vf = video("falta.mp4");
  const falta = await e.registrar(vf);
  fs.rmSync(vf.ruta);
  const vc = video("cambia.mp4");
  const cambiado = await e.registrar(vc);
  fs.appendFileSync(vc.ruta, "más");
  const otro = "9".repeat(32);
  assert.deepEqual(await e.estado([ok, falta, cambiado, otro, "nada", 5]), { [ok]: "ok", [falta]: "falta", [cambiado]: "cambiado", [otro]: "desconocido" });
  assert.deepEqual(await e.estado("no es lista"), {});
});
