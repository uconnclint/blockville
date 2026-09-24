#!/usr/bin/env node
// Hash every voxel model the public models API can produce, so a refactor of
// src/models.js / src/models/*.js can be PROVEN output-identical.
//
//   node tools/rendertest/modelhash.mjs            -> prints the summary hash
//   node tools/rendertest/modelhash.mjs --out F    -> also writes per-item hashes to F
//   node tools/rendertest/modelhash.mjs --diff A B -> compare two --out files
//
// The hash covers the RAW model objects (sx/sy/sz/res/tw/td + blocks in their
// emitted ORDER — block order changes the mesher's vertex order, so it matters),
// catalogAnim parts + pivots, PALETTE, CATALOG metadata, the export list, and
// _selfTest(). Rotation is applied by the engine (mesh.rotation.y), not by the
// models module, so every model is hashed once per (id, variant).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--diff') {
  const load = (f) => new Map(readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t')));
  const a = load(argv[1]), b = load(argv[2]);
  let bad = 0;
  for (const [k, h] of a) if (b.get(k) !== h) { bad++; console.log('DIFF', k, h, b.get(k)); }
  for (const k of b.keys()) if (!a.has(k)) { bad++; console.log('NEW ', k); }
  console.log(bad ? `${bad} differences` : `identical (${a.size} items)`);
  process.exit(bad ? 1 : 0);
}
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const M = await import(pathToFileURL(join(root, 'src', 'models.js')).href);

const items = [];
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const modelStr = (m) => m == null ? 'null' : JSON.stringify({
  sx: m.sx, sy: m.sy, sz: m.sz, res: m.res, tw: m.tw, td: m.td, blocks: m.blocks,
});
const add = (name, fn) => {
  let s;
  try { s = modelStr(fn()); } catch (e) { s = 'THREW ' + e; }
  items.push([name, h(s)]);
};

items.push(['exports', h(JSON.stringify(Object.keys(M).sort()))]);
items.push(['PALETTE', h(JSON.stringify(M.PALETTE))]);
items.push(['CATALOG', h(JSON.stringify(M.CATALOG))]);

for (const z of ['R', 'C', 'I']) for (let l = 1; l <= 3; l++) for (let v = 0; v < 8; v++)
  add(`building(${z},${l},${v})`, () => M.buildingModel(z, l, v));
for (const k of ['park', 'school', 'fire', 'fountain', 'stadium', 'power', 'zzz'])
  for (let v = 0; v < 4; v++) add(`service(${k},${v})`, () => M.serviceModel(k, v));
for (let v = -2; v <= 10; v++) add(`tree(${v})`, () => M.treeModel(v));
for (let m = 0; m <= 16; m++) add(`road(${m})`, () => M.roadModel(m));
for (let v = -2; v <= 12; v++) add(`car(${v})`, () => M.carModel(v));
for (let v = 0; v <= 16; v++) add(`person(${v})`, () => M.personModel(v));
add('bird', () => M.birdModel());
for (let v = -1; v <= 6; v++) add(`cloud(${v})`, () => M.cloudModel(v));
add('smoke', () => M.smokePuffModel());
add('construction', () => M.constructionModel());
for (let m = 0; m <= 15; m++) add(`bridge(${m})`, () => M.bridgeModel(m));
for (let v = -2; v <= 6; v++) add(`boat(${v})`, () => M.boatModel(v));
for (let v = -2; v <= 8; v++) add(`dog(${v})`, () => M.dogModel(v));
for (let v = -2; v <= 10; v++) add(`balloon(${v})`, () => M.balloonModel(v));
for (let v = -2; v <= 12; v++) add(`spark(${v})`, () => M.sparkModel(v));

let nCat = 0;
for (const cat of Object.keys(M.CATALOG)) for (const e of M.CATALOG[cat]) {
  for (let v = 0; v < e.variants; v++) { add(`catalog(${e.id},${v})`, () => M.catalogModel(e.id, v)); nCat++; }
  const a = M.catalogAnim(e.id);
  items.push([`anim(${e.id})`, h(a ? JSON.stringify({ ...a, part: modelStr(a.part) }) : 'null')]);
}
items.push(['selfTest', h(JSON.stringify(M._selfTest()))]);

const summary = h(items.map((i) => i.join('\t')).join('\n'));
if (OUT) writeFileSync(OUT, items.map((i) => i.join('\t')).join('\n') + '\n');
const st = M._selfTest();
console.log(JSON.stringify({ summary, items: items.length, catalogModels: nCat, selfTest: st.ok, selfTestErrors: st.errors.slice(0, 5) }));
