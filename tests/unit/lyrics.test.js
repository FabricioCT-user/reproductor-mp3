const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./helpers");

const { parse, looksSynced } = load("lyrics.js")("Lyrics");
const lines = (r) => plain(r.lines.map((l) => (r.synced ? `${l.t}|${l.text}` : l.text)));

test("LRC sincronizado: tiempos y texto, ordenado por tiempo", () => {
  const r = parse("[00:10.00]Segunda\n[00:01.50]Primera\n[01:02.25]Tercera");
  assert.equal(r.synced, true);
  assert.deepEqual(lines(r), ["1.5|Primera", "10|Segunda", "62.25|Tercera"]);
});

test("varias marcas de tiempo en la misma línea repiten el texto", () => {
  const r = parse("[00:05.00][00:20.00]Estribillo");
  assert.deepEqual(lines(r), ["5|Estribillo", "20|Estribillo"]);
});

test("las fracciones aceptan 1, 2 o 3 dígitos y también «:»", () => {
  const r = parse("[00:01.5]a\n[00:02.05]b\n[00:03.500]c\n[00:04:25]d");
  assert.deepEqual(lines(r), ["1.5|a", "2.05|b", "3.5|c", "4.25|d"]);
});

test("etiquetas de metadatos [ar:], [ti:]… no aparecen como letra", () => {
  const r = parse("[ar:Alguien]\n[ti:Algo]\n[al:Disco]\n[00:01.00]Hola");
  assert.deepEqual(lines(r), ["1|Hola"]);
});

test("[offset:] adelanta (positivo) o retrasa (negativo) la letra y no baja de cero", () => {
  assert.deepEqual(lines(parse("[offset:+500]\n[00:01.00]a\n[00:00.20]b")), ["0|b", "0.5|a"]);
  assert.deepEqual(lines(parse("[offset:-500]\n[00:01.00]a")), ["1.5|a"]);
});

test("tiempos por palabra (LRC extendido) se eliminan", () => {
  assert.deepEqual(lines(parse("[00:01.00]<00:01.00>Con <00:01.50>palabras")), ["1|Con palabras"]);
});

test("las líneas vacías con tiempo se conservan (pausas instrumentales)", () => {
  const r = parse("[00:01.00]a\n[00:05.00]\n[00:09.00]b");
  assert.deepEqual(lines(r), ["1|a", "5|", "9|b"]);
});

test("texto plano: no sincronizado, sin vacíos al principio ni al final", () => {
  const r = parse("\n\nuno\ndos\n\ntres\n\n");
  assert.equal(r.synced, false);
  assert.deepEqual(lines(r), ["uno", "dos", "", "tres"]);
});

test("acepta BOM, CRLF y CR antiguos", () => {
  assert.deepEqual(lines(parse("﻿[00:01.00]a\r\n[00:02.00]b\r[00:03.00]c")), ["1|a", "2|b", "3|c"]);
});

test("una línea que parece etiqueta pero lleva texto no sincronizado se mantiene en texto plano", () => {
  assert.deepEqual(lines(parse("[Estribillo]\nhola")), ["[Estribillo]", "hola"]);
});

test("entrada vacía no falla", () => {
  assert.deepEqual(plain(parse("").lines), []);
});

test("looksSynced distingue LRC de texto plano", () => {
  assert.equal(looksSynced("[00:01.00]hola"), true);
  assert.equal(looksSynced("[1:23]hola"), true);
  assert.equal(looksSynced("hola\nmundo"), false);
  assert.equal(looksSynced("[Verso 1]"), false);
});
