// Blockville models — INFRASTRUCTURE: roadModel, bridgeModel, constructionModel.

import { C, grid } from './core.js';

// ---------------------------------------------------------------------------
// roadModel(mask) — 8x1x8 flat slab. bit1=N(-Z), 2=E(+X), 4=S(+Z), 8=W(-X)
// ---------------------------------------------------------------------------
export function roadModel(mask) {
  mask = (mask | 0) & 15;
  const N = mask & 1, E = mask & 2, S = mask & 4, W = mask & 8;
  const g = grid(8, 1, 8);
  g.slab(0, 0, 0, 7, 7, C.asphalt);
  // subtle asphalt texture
  g.set(2, 0, 5, C.asphaltDark); g.set(5, 0, 2, C.asphaltDark);
  // sidewalk border on edges with no road neighbor
  if (!N) for (let x = 0; x < 8; x++) g.set(x, 0, 0, C.sidewalk);
  if (!S) for (let x = 0; x < 8; x++) g.set(x, 0, 7, C.sidewalk);
  if (!W) for (let z = 0; z < 8; z++) g.set(0, 0, z, C.sidewalk);
  if (!E) for (let z = 0; z < 8; z++) g.set(7, 0, z, C.sidewalk);
  // dashed yellow centre lines toward each connected direction
  if (N) for (let z = 0; z <= 3; z++) if (z % 2 === 0) { g.set(3, 0, z, C.roadLine); g.set(4, 0, z, C.roadLine); }
  if (S) for (let z = 4; z <= 7; z++) if (z % 2 === 0) { g.set(3, 0, z, C.roadLine); g.set(4, 0, z, C.roadLine); }
  if (W) for (let x = 0; x <= 3; x++) if (x % 2 === 0) { g.set(x, 0, 3, C.roadLine); g.set(x, 0, 4, C.roadLine); }
  if (E) for (let x = 4; x <= 7; x++) if (x % 2 === 0) { g.set(x, 0, 3, C.roadLine); g.set(x, 0, 4, C.roadLine); }
  // crosswalks at 4-way intersections
  if (mask === 15) {
    for (let x = 1; x <= 6; x++) if (x % 2 === 0) { g.set(x, 0, 1, C.signWhite); g.set(x, 0, 6, C.signWhite); }
    for (let z = 1; z <= 6; z++) if (z % 2 === 0) { g.set(1, 0, z, C.signWhite); g.set(6, 0, z, C.signWhite); }
  }
  return g.done();
}

// ---------------------------------------------------------------------------
// constructionModel() — dirt base, wooden scaffold, orange crane arm
// ---------------------------------------------------------------------------
export function constructionModel() {
  const g = grid(7, 10, 7);
  // dirt lot
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++)
    g.set(x, 0, z, (x + z) % 3 === 0 ? C.dirtDark : C.dirt);
  // scaffold corner poles + top ring
  const corners = [[1, 1], [5, 1], [1, 5], [5, 5]];
  for (const [x, z] of corners) for (let y = 1; y <= 5; y++) g.set(x, y, z, C.plank);
  for (let x = 1; x <= 5; x++) { g.set(x, 5, 1, C.wood); g.set(x, 5, 5, C.wood); }
  for (let z = 1; z <= 5; z++) { g.set(1, 5, z, C.wood); g.set(5, 5, z, C.wood); }
  g.set(3, 3, 1, C.wood); // a cross brace
  // a partly-built wall
  g.box(2, 1, 5, 4, 2, 5, C.concrete);
  // orange crane: mast + horizontal jib + hook
  const mx = 5, mz = 5;
  for (let y = 1; y <= 8; y++) g.set(mx, y, mz, C.orange);
  for (let x = mx; x >= 1; x--) g.set(x, 8, mz, C.orange);
  g.set(1, 7, mz, C.metalDark); // hook line
  g.set(1, 6, mz, C.metalDark);
  g.set(mx, 8, mz, C.amber);    // counterweight cap
  return g.done();
}

// ---------------------------------------------------------------------------
// bridgeModel(mask) — road-over-water piece, 8×3×8. Warm wooden plank deck at
// y=0, low railings (y 1..2) with corner posts along the NON-connected edges.
// mask bits match roadModel: 1=N(-Z), 2=E(+X), 4=S(+Z), 8=W(-X).
// ---------------------------------------------------------------------------
export function bridgeModel(mask) {
  mask = (mask | 0) & 15;
  const N = mask & 1, E = mask & 2, S = mask & 4, W = mask & 8;
  const g = grid(8, 3, 8);
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) g.set(x, 0, z, (x + z) & 1 ? C.plank : C.wood); // warm deck
  if (N || S) { for (let z = 0; z < 8; z++) if (z % 2 === 0) { g.set(3, 0, z, C.woodDark); g.set(4, 0, z, C.woodDark); } }
  else if (E || W) { for (let x = 0; x < 8; x++) if (x % 2 === 0) { g.set(x, 0, 3, C.woodDark); g.set(x, 0, 4, C.woodDark); } }
  const rail = C.woodDark, post = C.trunkDark;
  const railZ = z => { for (let x = 0; x < 8; x++) { g.set(x, 1, z, rail); if (x % 2 === 0) g.set(x, 2, z, post); } };
  const railX = x => { for (let z = 0; z < 8; z++) { g.set(x, 1, z, rail); if (z % 2 === 0) g.set(x, 2, z, post); } };
  if (!N) railZ(0);
  if (!S) railZ(7);
  if (!W) railX(0);
  if (!E) railX(7);
  for (const [cx, cz] of [[0, 0], [7, 0], [0, 7], [7, 7]]) { g.set(cx, 1, cz, post); g.set(cx, 2, cz, post); }
  return g.done();
}
