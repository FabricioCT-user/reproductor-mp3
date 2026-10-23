const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./helpers");

const IO = load("playlist-io.js")("PlaylistIO");
const ref = (file, title = "", artist = "", size = null) => ({ file, size, title, artist });

test("JSON: ida y vuelta conserva nombre, orden y datos de cada canción", () => {
  const lists = [
    { name: "Favoritas", refs: [ref("b.mp3", "B", "Art", 20), ref("a.flac", "Ñandú ü", "Música", 10)] },
    { name: "Vacía", refs: [] },
  ];
  const back = IO.parseJSON(IO.toJSON(lists));
  assert.deepEqual(plain(back), lists);
});

test("JSON: rechaza archivos que no son de este reproductor", () => {
  assert.throws(() => IO.parseJSON('{"hola":1}'));
  assert.throws(() => IO.parseJSON('{"format":"otro","playlists":[]}'));
  assert.throws(() => IO.parseJSON("no es json"));
});

test("JSON: ignora entradas mal formadas y rellena valores por defecto", () => {
  const text = JSON.stringify({
    format: "reproductor-mp3-playlists",
    playlists: [
      { name: "  ", tracks: [{ file: "a.mp3" }, null, { size: 3 }, { title: "Solo título" }] },
      { tracks: [] },
      null,
      { name: "Mala", tracks: "no" },
    ],
  });
  assert.deepEqual(plain(IO.parseJSON(text)), [
    { name: "Lista importada", refs: [ref("a.mp3"), ref("", "Solo título")] },
  ]);
});

test("M3U: exporta con EXTINF «Artista - Título» y la ruta (nombre de archivo)", () => {
  const out = IO.toM3U([ref("01 Intro.mp3", "Intro", "Banda"), ref("x.flac", "Solo título", "")]);
  assert.equal(out, "#EXTM3U\n#EXTINF:-1,Banda - Intro\n01 Intro.mp3\n#EXTINF:-1,Solo título\nx.flac\n");
});

test("M3U: lee rutas de Windows y Linux, %20, comentarios y líneas vacías", () => {
  const text = [
    "\uFEFF#EXTM3U",
    "",
    "#EXTINF:123,Banda - Tema Uno",
    "C:\\Música\\Disco 1\\01 Tema Uno.mp3",
    "# comentario cualquiera",
    "/home/yo/Mi%20M%C3%BAsica/02.flac",
    "#EXTINF:5,Sin separador",
    "03.ogg",
  ].join("\r\n");
  const [list] = IO.parseM3U(text, "Mi mezcla");
  assert.equal(list.name, "Mi mezcla");
  assert.deepEqual(plain(list.refs), [
    ref("01 Tema Uno.mp3", "Tema Uno", "Banda"),
    ref("02.flac"),
    ref("03.ogg", "Sin separador"),
  ]);
});

test("M3U: el EXTINF solo vale para la ruta siguiente", () => {
  const [list] = IO.parseM3U("#EXTINF:1,A - B\na.mp3\nb.mp3\n", "x");
  assert.equal(list.refs[0].title, "B");
  assert.equal(list.refs[1].title, "");
});

test("M3U: ida y vuelta", () => {
  const refs = [ref("a.mp3", "Tema", "Banda"), ref("b.mp3", "Otro", "")];
  const [back] = IO.parseM3U(IO.toM3U(refs), "lista");
  assert.deepEqual(plain(back.refs), refs);
});
