const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain, latin1, utf16le, utf16be, cat } = require("./helpers");

const { parse, decode, toVtt } = load("subtitles.js")("Subtitles");
const cues = (t) => plain(parse(t).cues);

test("SRT básico: índices, comas en milisegundos, texto multilínea", () => {
  const r = cues("1\n00:00:01,500 --> 00:00:03,000\nHola\nmundo\n\n2\n00:01:02,250 --> 01:00:04,000\nAdiós\n");
  assert.deepEqual(r, [
    { start: 1.5, end: 3, text: "Hola\nmundo" },
    { start: 62.25, end: 3604, text: "Adiós" },
  ]);
});

test("CRLF, CR suelto, BOM y líneas vacías de más", () => {
  const r = cues("﻿\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,000\r\nUno\r\n\r\n\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\rDos\r\r");
  assert.deepEqual(r.map((c) => c.text), ["Uno", "Dos"]);
});

test("índices ausentes y fracciones de 1 a 3 dígitos", () => {
  const r = cues("00:00:01,5 --> 00:00:02,25\na\n\n00:00:03 --> 00:00:04,125\nb");
  assert.deepEqual(r, [{ start: 1.5, end: 2.25, text: "a" }, { start: 3, end: 4.125, text: "b" }]);
});

test("falta la línea vacía entre cues: el número es el índice de la siguiente", () => {
  const r = cues("1\n00:00:01,000 --> 00:00:02,000\nUno\n2\n00:00:03,000 --> 00:00:04,000\nDos");
  assert.deepEqual(r.map((c) => c.text), ["Uno", "Dos"]);
});

test("VTT con cabecera, NOTE, STYLE, REGION, horas opcionales y ajustes de cue", () => {
  const vtt = [
    "WEBVTT - Título", "Kind: captions", "",
    "STYLE", "::cue { color: red }", "", "",
    "NOTE esto es", "un comentario", "",
    "REGION", "id:r1", "",
    "intro", "00:01.000 --> 00:03.500 align:start position:10%", "<v Ana>Hola <c.rojo>mundo</c>", "",
    "01:00:00.000 --> 01:00:01.000", "Tarde", "",
  ].join("\n");
  assert.deepEqual(cues(vtt), [
    { start: 1, end: 3.5, text: "Hola mundo" },
    { start: 3600, end: 3601, text: "Tarde" },
  ]);
});

test("conserva <i> <b> <u>, quita otras etiquetas y órdenes ASS, decodifica entidades", () => {
  const r = cues("00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Hola</i> <font color=\"red\">tú</font> &amp; yo &lt;3");
  assert.equal(r[0].text, "<i>Hola</i> tú & yo <3");
});

test("solapes: se conservan y quedan ordenadas por inicio; se descartan vacías o con fin <= inicio", () => {
  const r = cues([
    "00:00:05,000 --> 00:00:09,000", "B", "",
    "00:00:01,000 --> 00:00:06,000", "A", "",
    "00:00:02,000 --> 00:00:02,000", "cero", "",
    "00:00:03,000 --> 00:00:04,000", "", "",
  ].join("\n"));
  assert.deepEqual(r.map((c) => c.text), ["A", "B"]);
});

test("archivo corrupto: devuelve lo que pueda y no lanza", () => {
  assert.deepEqual(cues(""), []);
  assert.deepEqual(cues("basura sin tiempos\n\n--> -->\n00:xx --> yy"), []);
  const r = cues("1\n00:00:01,000 --> 00:00:02,000\nBien\n\n2\n00:00:0 -> roto\nmal\n\n3\n00:00:05,000 --> 00:00:06,000\nOtra bien");
  assert.deepEqual(r.map((c) => c.text), ["Bien", "Otra bien"]);
  for (const x of [null, undefined, 42, {}, "\0\0\0�"]) assert.doesNotThrow(() => parse(x));
  assert.doesNotThrow(() => toVtt(null));
  assert.doesNotThrow(() => decode(new Uint8Array(0)));
  assert.doesNotThrow(() => decode(null));
});

test("entradas hostiles: líneas enormes y miles de cues", () => {
  const big = "x".repeat(2_000_000);
  const r = parse(`00:00:01,000 --> 00:00:02,000\n${big}\n`).cues;
  assert.equal(r.length, 1);
  assert.ok(r[0].text.length <= 5000);
  assert.doesNotThrow(() => parse(big));
  assert.doesNotThrow(() => parse("0".repeat(100000) + ":" + "0".repeat(100000) + " --> "));
  assert.doesNotThrow(() => parse("<".repeat(100000)));

  const many = [];
  for (let i = 0; i < 120000; i++) many.push(`${i}\n00:00:01,000 --> 00:00:02,000\nl${i}\n`);
  const t0 = Date.now();
  const n = parse(many.join("\n")).cues.length;
  assert.ok(n > 1000 && n <= 50000);
  assert.ok(Date.now() - t0 < 5000);
});

test("decode: UTF-8, UTF-8 con BOM, UTF-16 LE/BE con BOM", () => {
  assert.equal(decode(new TextEncoder().encode("Canción ñ ✓")), "Canción ñ ✓");
  assert.equal(decode(cat([0xef, 0xbb, 0xbf], "Canción")), "Canción");
  assert.equal(decode(cat([0xff, 0xfe], utf16le("Añoranza"))), "Añoranza");
  assert.equal(decode(cat([0xfe, 0xff], utf16be("Añoranza"))), "Añoranza");
  assert.equal(decode(new TextEncoder().encode("abc").buffer), "abc");
});

test("decode: SRT en Latin-1/windows-1252 (muy habitual en español)", () => {
  const srt = cat("1\n00:00:01,000 --> 00:00:02,000\n", latin1("¿Qué pasó, niño? Adiós «sí»"), "\n");
  const text = decode(srt);
  assert.ok(text.includes("¿Qué pasó, niño?"));
  assert.ok(!text.includes("�"));
  assert.equal(cues(text)[0].text, "¿Qué pasó, niño? Adiós «sí»");
});

test("toVtt: cabecera, formato de tiempos y escape salvo <i> <b> <u>", () => {
  const out = toVtt([{ start: 1.5, end: 3661.0049, text: "a < b & c <i>x</i> <b>y</b> <u>z</u> <script>" }]);
  assert.equal(out,
    "WEBVTT\n\n00:00:01.500 --> 01:01:01.005\na &lt; b &amp; c <i>x</i> <b>y</b> <u>z</u> &lt;script&gt;\n");
});

test("toVtt: desfase, sin tiempos negativos y sin cues que quedan fuera", () => {
  const src = [
    { start: 1, end: 2, text: "fuera" },
    { start: 2, end: 6, text: "recortada" },
    { start: 10, end: 12, text: "dentro" },
  ];
  assert.equal(toVtt(src, -4), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nrecortada\n\n00:00:06.000 --> 00:00:08.000\ndentro\n");
  assert.equal(toVtt(src, 1.5).split("\n")[2], "00:00:02.500 --> 00:00:03.500");
  assert.equal(toVtt(src, -100), "WEBVTT\n");
  assert.equal(toVtt(src, NaN), toVtt(src, 0));
});

test("toVtt: «-->» y líneas vacías en el texto no rompen la cue; ida y vuelta con parse", () => {
  const out = toVtt([{ start: 1, end: 2, text: "a --> b\n\n\nc" }]);
  assert.ok(!/a --> b/.test(out));
  const back = parse(out).cues;
  assert.equal(back.length, 1);
  assert.equal(back[0].text, "a --> b\nc");
});
