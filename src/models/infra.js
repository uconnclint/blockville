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
// bridgeModel(mask) — road-over-water piece, one tile (res 4: 32 voxels/tile).
// mask bits match roadModel: 1=N(-Z), 2=E(+X), 4=S(+Z), 8=W(-X).
//
// coherence 09-25: the old res-1 wooden plank deck (checkered orange planks
// with post "crenellations") predated the render overhaul and read as a
// different game next to roads.js's near-black asphalt, light kerbs and white
// dashes. This one continues the street across the water: asphalt deck with
// a white centre dash and yellow edge lines, raised light-concrete sidewalks
// and a low parapet on the open sides, a lot-side-grey deck band and two
// concrete piers standing in the pool.
//
// The model is authored from the basin floor up and carries yOffset = -DROP
// (engine.addProp honours it), so the deck top lands on the road surface
// (y ~ 0) and the piers reach down past the water (water.js WATER_Y -2.6).
// ---------------------------------------------------------------------------
const BR_RES = 4, BR_N = 32;
const BR_DROP = 2.75;                    // world units the model is lowered by
const BR_DECK0 = 8, BR_DECK1 = 10;       // deck slab layers (top at 11/4 - 2.75 = 0)
const BR_WALK = 11;                      // sidewalk layer (top +0.25, roads.js kerb is 0.30)
const _bridgeCache = new Map();
export function bridgeModel(mask) {
  mask = (mask | 0) & 15;
  const hit = _bridgeCache.get(mask);
  if (hit) return hit;    // one model per mask: engine caches geometry by model object
  const N = mask & 1, E = mask & 2, S = mask & 4, W = mask & 8;
  // Run direction: along Z when it links N/S (or nothing links), along X
  // when it only links E/W. A junction on a bridge keeps both open.
  const alongZ = !!(N || S) || !(E || W);
  const alongX = !!(E || W);
  const g = grid(BR_N, 15, BR_N, BR_RES);
  const L = BR_N - 1;
  const ASPH = C.infraDeck, RIM = C.lotRim, SIDE = C.lotSide, LINE = C.roadLine;   // deck: darkest paint (materials' dark floor lifts it) to sit near roads.js asphalt
  // deck slab + side band
  g.box(0, BR_DECK0, 0, L, BR_DECK1, L, ASPH);
  g.walls(0, BR_DECK0, 0, L, BR_DECK1 - 1, L, SIDE);
  g.box(0, BR_DECK0 - 1, 0, L, BR_DECK0 - 1, L, C.stoneDark);   // girder shadow line under the band
  // open (non-connected) sides: sidewalk strip + parapet
  const WALK_W = 3;   // 0.75 units, like roads.js's kerb band
  const edge = (open, fn) => { if (open) for (let a = 0; a <= L; a++) for (let d = 0; d < WALK_W; d++) fn(a, d); };
  const walk = (x, z, d) => {
    g.set(x, BR_WALK, z, RIM);
    g.set(x, BR_DECK1, z, SIDE);
    if (d === 0) { g.set(x, BR_WALK + 1, z, C.concrete); g.set(x, BR_WALK + 2, z, C.concrete); }
  };
  edge(!N, (a, d) => walk(a, d, d));
  edge(!S, (a, d) => walk(a, L - d, d));
  edge(!W, (a, d) => walk(d, a, d));
  edge(!E, (a, d) => walk(L - d, a, d));
  // markings (roads.js: yellow edge line inside the kerb, white centre dash)
  const y = BR_DECK1;
  if (alongZ && !alongX) {
    for (let z = 0; z <= L; z++) {
      g.set(WALK_W + 1, y, z, LINE); g.set(L - WALK_W - 1, y, z, LINE);
      if ((z >> 2) % 2 === 0) { g.set(15, y, z, C.signWhite); g.set(16, y, z, C.signWhite); }
    }
  } else if (alongX && !alongZ) {
    for (let x = 0; x <= L; x++) {
      g.set(x, y, WALK_W + 1, LINE); g.set(x, y, L - WALK_W - 1, LINE);
      if ((x >> 2) % 2 === 0) { g.set(x, y, 15, C.signWhite); g.set(x, y, 16, C.signWhite); }
    }
  }
  // two square concrete piers under the deck, on the cross axis
  const pier = (cx, cz) => g.box(cx - 2, 0, cz - 2, cx + 1, BR_DECK0 - 2, cz + 1, C.concrete);
  if (alongZ && !alongX) { pier(7, 16); pier(25, 16); }
  else if (alongX && !alongZ) { pier(16, 7); pier(16, 25); }
  else { pier(7, 7); pier(25, 25); }
  const m = g.done();
  m.yOffset = -BR_DROP;
  _bridgeCache.set(mask, m);
  return m;
}
