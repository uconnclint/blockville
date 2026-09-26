// Blockville models — FUN / PARKS / DECO: catalog 'fun' attractions (playground,
// pool, ferris wheel, zoo, carousel, …, stadium) + catalog 'deco' 1×1 charm,
// plus the ferris-wheel and carousel spinner parts.
//
// Authored at res 4 (32 fine voxels per tile) to the Isometric City Voxel look
// (ART-DIRECTION.md): every attraction brings its own lotPlinth; fronts face
// min-Z (flipZ puts them on +Z). Deco items are small props with no plinth so
// fences / hedges / paths tile seamlessly edge to edge.

import {
  C, grid, pk, facade, windowFramed, door, awning, signPanel, pixelText, wallLamp,
  acBox, parapet, ventPipe, planter, bench, lotPlinth, pyramidRoof, solarPanel,
} from './core.js';
import {
  V, tree, bush, flower, lampPost, bin, car, umbrella, lounger, flagPole, disc, rrDist, roofBox, civText, benchS, hipRoof,
  person, crowd, kiosk, umbTable, parkingRow, hiText, doneHi,
  hiGrid, hiFacade, fineWin, lotTree, INK, inkBand, inkEdges, brickCourse, fineUmbrella, fineLounger, fineAC, fineBand, fineDentils, fineBalustrade, fineHipRoof, gclr, lumpHedge, fineDome, fineBlooms, fineColumn, fineStatue,
} from './civic.js';

const R4 = 4;
const mod = (a, n) => ((a % n) + n) % n;

// ---- small shared bits -----------------------------------------------------
// Post-and-rail fence along a straight line (x0,z0)→(x1,z1) (axis-aligned).
function fenceRun(g, x0, z0, x1, z1, y, o = {}) {
  const post = o.post != null ? o.post : C.woodDark, rail = o.rail != null ? o.rail : C.wood;
  const h = o.h || 4, step = o.step || 4;
  const alongX = z0 === z1;
  const a0 = alongX ? Math.min(x0, x1) : Math.min(z0, z1), a1 = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
  const P = (a, yy, c) => (alongX ? g.set(a, yy, z0, c) : g.set(x0, yy, a, c));
  for (let a = a0; a <= a1; a++) {
    P(a, y + h - 1, rail);
    if (o.mid !== false) P(a, y + (h >> 1) - 1, rail);
    if ((a - a0) % step === 0 || a === a1) for (let yy = y; yy <= y + h; yy++) P(a, yy, post);
  }
}
// Stepped grey rock pile centred (x, z), w wide.
function rocks(g, x, y, z, w = 7, h = 4) {
  const r = w >> 1;
  g.box(x - r, y, z - r + 1, x + r, y + h - 2, z + r - 1, V.rock);
  g.box(x - r + 1, y, z - r, x + r - 1, y + h - 1, z + r, V.rock);
  g.box(x - r + 2, y + h - 1, z - r + 1, x + r - 1, y + h, z + r - 2, V.rockLight);
}
// Round-ish ring (annulus) in a horizontal plane.
function ringH(g, cx, y, cz, r0, r1, c) {
  for (let x = Math.floor(cx - r1 - 1); x <= Math.ceil(cx + r1 + 1); x++)
    for (let z = Math.floor(cz - r1 - 1); z <= Math.ceil(cz + r1 + 1); z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d >= r0 && d < r1) g.set(x, y, z, typeof c === 'function' ? c(x, z) : c);
    }
}
// Balloon bunch on a stick at (x, z).
function balloons(g, x, y, z, cols) {
  g.box(x, y, z, x, y + 9, z, C.signWhite);
  const off = [[-2, 12, 0], [1, 13, -1], [0, 15, 1], [2, 11, 1]];
  off.forEach(([dx, dy, dz], i) => { g.box(x + dx, y + dy, z + dz, x + dx + 1, y + dy + 2, z + dz + 1, cols[i % cols.length]); g.set(x + dx, y + dy - 1, z + dz, C.signWhite); });
}

// Swimmers: a head (and a bright cap on some) bobbing on open water.
function swimmers(g, x0, z0, x1, z1, y, n, seed = 1) {
  let s = seed * 7919 + 13;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0, k = 0; i < n * 30 && k < n; i++) {
    const x = x0 + Math.floor(rnd() * (x1 - x0 + 1)), z = z0 + Math.floor(rnd() * (z1 - z0 + 1));
    if (g.map.get(x + ',' + (y - 1) + ',' + z) !== C.civPool || g.map.has(x + ',' + y + ',' + z)) continue;
    // (r9) a fine head (2×2×2 res 8) with a cap or hair, and a ripple ring:
    // the old res-4 cube heads read as crates floating in the pool
    const H = hiGrid(g), X = 2 * x, Z = 2 * z, Y = 2 * y;
    H.box(X, Y, Z, X + 1, Y + 1, Z + 1, C.skin1);
    H.box(X, Y + 1, Z, X + 1, Y + 1, Z + 1, (k % 3) ? C.hairBrown : [C.red, C.yellow][k % 2]);
    for (const [dx, dz] of [[-1, 0], [2, 1], [0, 2], [1, -1]]) H.set(X + dx, Y, Z + dz, C.civPoolLt);
    k++;
  }
}

// =============================================================================
// FUN
// =============================================================================

// ---- PLAYGROUND (1×1): one bold silhouette — a two-tower play castle with
// battlements and pointed roofs, a rope bridge between the towers, a wide wave
// slide down the front and a striped tube slide down the lit side, on a
// poured-rubber floor; swings and a few benches round the edge.
function bPlayground(rng, v) {
  const g = grid(31, 44, 31, R4);
  const y = lotPlinth(g, 0, 0, 30, 30, { fill: 'grass' });
  const vi = mod(v, 3);
  // two hues + white per variant (critic r4: the four-colour castle read as
  // a jumble of saturated blocks with no clear silhouette)
  // (r10) critic r9 read the castle as "a jumble of red, teal and white
  // blocks with no clear building silhouette": the keeps are now SOLID
  // cream stone towers (not posts + panels), ink-edged, under one roof
  // colour per variant, so the frame reads as one castle.
  const floorA = [C.civRubber, C.civSeat, C.roofGreen][vi], floorB = [C.lotPave, C.lotPave, C.lotPave][vi];
  const post = C.signWhite, panel = C.cream, stoneDk = C.sandDark;
  const roofA = [C.red, C.roofBlue, C.red][vi], roofB = roofA;
  g.box(2, y - 1, 2, 28, y - 1, 28, floorA);                         // poured rubber
  disc(g, 13, y - 1, 7, 5.5, floorB); disc(g, 13, y - 1, 7, 3.5, floorA);
  // a castle tower: 2×2 posts, plank deck, panelled walls with portholes,
  // crenellated top, stepped pointed roof, pennant
  const tower = (x0, z0, x1, z1, deck, rc) => {
    g.box(x0, y, z0, x1, deck + 4, z1, panel);                       // solid stone keep
    g.walls(x0, y, z0, x1, y, z1, stoneDk);
    g.walls(x0 - 1, deck, z0 - 1, x1 + 1, deck, z1 + 1, panel);      // corbelled walk
    for (let x = x0 - 1; x <= x1 + 1; x += 2) { g.set(x, deck + 1, z0 - 1, panel); g.set(x, deck + 1, z1 + 1, panel); }
    for (let z = z0 - 1; z <= z1 + 1; z += 2) { g.set(x0 - 1, deck + 1, z, panel); g.set(x1 + 1, deck + 1, z, panel); }
    inkBand(g, x0 - 1, z0 - 1, x1 + 1, z1 + 1, 2 * deck - 1, 1, 0);
    inkEdges(g, x0, z0, x1, z1, y + 1, deck - 1);
    const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
    for (const d of [-2, 2]) { g.box(mx + d, deck - 5, z0, mx + d, deck - 3, z0, C.civNavy); g.box(x1, deck - 5, mz + d, x1, deck - 3, mz + d, C.civNavy); g.box(mx + d, deck - 5, z1, mx + d, deck - 3, z1, C.civNavy); g.box(x0, deck - 5, mz + d, x0, deck - 3, mz + d, C.civNavy); }   // arrow slits
    g.box(mx - 1, y, z0, mx + 1, y + 4, z0, C.civNavy); g.box(x1, y, mz - 1, x1, y + 4, mz + 1, C.civNavy);   // arched doors
    g.set(mx, y + 5, z0, C.civNavy); g.set(x1, y + 5, mz, C.civNavy);
    let k = 0;
    for (; x0 + k <= x1 - k && z0 + k <= z1 - k; k++) g.box(x0 + k, deck + 3 + 2 * k, z0 + k, x1 - k, deck + 4 + 2 * k, z1 - k, k === 0 ? C.signWhite : rc);
    const top = deck + 4 + 2 * (k - 1);
    g.box(mx, top + 1, mz, mx, top + 5, mz, C.signWhite);
    g.box(mx + 1, top + 3, mz, mx + 3, top + 5, mz, rc === roofA ? roofB : roofA);
    return { mx, mz };
  };
  tower(8, 14, 16, 22, y + 9, roofA);                               // main keep
  tower(20, 19, 26, 25, y + 12, roofB);                             // little tower
  // rope bridge between the decks
  for (let x = 17; x <= 19; x++) { const dy = y + 9 + Math.round((x - 16) * 1); g.box(x, dy, 20, x, dy, 22, C.wood); g.set(x, dy + 3, 20, C.darkGray); g.set(x, dy + 3, 22, C.darkGray); }
  // climbing wall up the keep's left side
  g.box(7, y, 16, 7, y + 8, 20, C.civPanel);
  [[17, 2], [19, 4], [16, 5], [18, 7], [20, 1], [17, 8]].forEach(([hz, hy], i) => g.set(6, y + hy, hz, [C.red, C.yellow, C.roofGreen, C.civSeat][i % 4]));
  // wide wave slide off the keep's front, down toward the road
  for (let i = 0; i <= 9; i++) {
    const zz = 13 - i, sy = y + 9 - i + (i > 6 ? 1 : 0) - (i > 8 ? 1 : 0);
    g.box(10, Math.max(y, sy - 1), zz, 14, Math.max(y, sy), zz, post);
    g.box(10, sy + 1, zz, 10, sy + 2, zz, C.signWhite); g.box(14, sy + 1, zz, 14, sy + 2, zz, C.signWhite);
  }
  g.box(11, y + 9, 13, 13, y + 9, 13, C.plank);
  // striped tube slide from the little tower down the right side
  for (let i = 0; i <= 13; i++) {
    const zz = 18 - i, ty = y + 12 - Math.round(i * 0.85);
    g.box(26, Math.max(y, ty - 1), zz, 28, ty + 1, zz, (i >> 1) & 1 ? C.signWhite : roofB);
  }
  g.box(26, y, 4, 28, y, 5, C.sand);
  // swing set on the front-left
  for (const px of [2, 7]) { g.box(px, y, 2, px, y + 10, 2, panel); g.box(px, y, 6, px, y + 10, 6, panel); g.box(px, y + 11, 2, px, y + 11, 6, panel); }
  g.box(2, y + 12, 4, 7, y + 12, 4, panel);
  for (const [sx, c] of [[3, C.red], [5, C.yellow]]) { g.box(sx, y + 4, 4, sx, y + 11, 4, C.darkGray); g.box(sx, y + 3, 3, sx + 1, y + 3, 5, c); }
  // sandpit + springy duck at the back, benches, a shade tree, a low fence
  g.walls(19, y, 4, 24, y, 10, C.wood); g.box(20, y, 5, 23, y, 9, C.sand); g.box(21, y + 1, 6, 22, y + 2, 7, C.red);
  g.box(3, y, 25, 3, y + 2, 25, C.metal); g.box(2, y + 3, 24, 5, y + 5, 26, C.yellow); g.set(5, y + 5, 25, C.orange);
  benchS(g, 22, y, 27, 'x', 4, { seat: C.wood, flip: false });
  tree(g, 3, y, 13, { w: 5, h: 5, trunk: 5, tier: false });
  for (const [a, b, c, d] of [[1, 29, 29, 29], [29, 1, 29, 29], [1, 9, 1, 29]]) fenceRun(g, a, b, c, d, y, { post: C.signWhite, rail: panel, h: 3, step: 4 });
  crowd(g, [[2, 2, 28, 28]], y, 10, 41 + vi, { shirts: [C.red, C.yellow, C.civSeat, C.pink, C.roofGreen, C.orange] });
  return doneHi(g);
}

// ---- SWIMMING POOL (2×2): ref05 lido — a big L-shaped pool on a warm sun
// deck, rows of striped umbrellas over loungers, clipped hedge beds, a kiddie
// pool, and ONE clean pool house: a low white two-storey pavilion with a
// glazed ground floor, a colour band, a roof-top café terrace under
// umbrellas and a broad open stair down to the deck (ref05's hotel pool).
// (civic r8) Critic r7: the 1×1 pool was "a narrow tall tower on a tiny lot"
// and "the pool building has cluttered, noisy detail with no single
// readable silhouette". The tall diving tower is gone; the house sits in the
// back-left corner, low enough not to hide the water from any snap.
function bSwimmingPool(rng, v) {
  const g = grid(63, 40, 63, R4);
  const y = lotPlinth(g, 0, 0, 62, 62, { fill: C.lotRim });
  const vi = mod(v, 3);
  const umb = [[C.red, C.signWhite], [C.civSeat, C.signWhite], [C.red, C.signWhite]][vi];   // (r8) ref05 red/white; teal read as trees
  const band = [C.civSeat, C.teal, C.civBrick][vi];
  const lcol = C.civPoolLt;                                                        // (r8) white loungers, pale towel: brown read as mud, red as blobs
  g.box(1, y - 1, 1, 61, y - 1, 61, C.sand);                                       // warm sun deck (palette is full: reuse sand)
  // ---- the L-shaped pool: coping, lanes, steps corner, deep-end tiles
  const inPool = (x, z) => (x >= 4 && x <= 42 && z >= 4 && z <= 20) || (x >= 28 && x <= 42 && z >= 21 && z <= 33);
  for (let x = 3; x <= 43; x++) for (let z = 3; z <= 34; z++) {
    if (inPool(x, z)) { g.set(x, y - 1, z, C.civPool); continue; }
    let edge = false;
    for (let dx = -1; dx <= 1 && !edge; dx++) for (let dz = -1; dz <= 1; dz++) if (inPool(x + dx, z + dz)) { edge = true; break; }
    if (edge) g.set(x, y, z, C.signWhite);
  }
  // (r9) fine floating lane ropes (res 8, one fine voxel above the water)
  { const Hp = hiGrid(g); for (const lz of [8, 12, 16]) for (let x = 10; x < 56; x++) Hp.set(x, 2 * y, 2 * lz + 1, ((x >> 1) & 1) ? C.red : C.signWhite); }
  for (let x = 6; x < 27; x += 4) g.set(x, y - 1, 5, C.civPoolLt);
  for (let i = 0; i < 3; i++) g.box(29, y - 1, 31 - i, 31 + i, y - 1, 31 - i, C.civPoolLt);               // steps into the leisure leg
  for (let z = 22; z <= 32; z += 3) for (let x = 30; x <= 40; x += 3) g.set(x + ((z >> 1) & 1), y - 1, z, C.civPoolLt);
  // floats, ball, ladders, two springboards off the back edge of the lanes
  { const Hf = hiGrid(g); for (const [fx, fz, fc] of [[73, 25, C.orange], [69, 53, C.yellow], [30, 40, C.red]]) for (let i = -4; i < 4; i++) for (let k = -4; k < 4; k++) { const d = Math.hypot(i + 0.5, k + 0.5); if (d >= 1.6 && d < 3.6) Hf.set(fx + i, 2 * y, fz + k, (i < 0) === (k < 0) ? fc : C.signWhite); } }   // (r9) fine rubber rings
  g.box(20, y - 1, 10, 21, y, 11, C.red); g.set(20, y, 10, C.signWhite);
  for (const lx of [10, 22]) { g.box(lx, y, 21, lx, y + 2, 21, C.metal); g.box(lx, y + 2, 20, lx, y + 2, 21, C.metal); }
  for (const bx of [6, 14]) { g.box(bx, y + 1, 18, bx + 2, y + 1, 23, C.civSeat); g.box(bx, y, 22, bx + 2, y, 23, C.civPanel); }
  // lifeguard chair on the lanes' right edge
  for (const [px, pz] of [[44, 9], [46, 9], [44, 11], [46, 11]]) g.box(px, y, pz, px, y + 6, pz, C.signWhite);
  g.box(44, y + 7, 9, 46, y + 7, 11, lcol); g.box(46, y + 8, 9, 46, y + 9, 11, lcol);
  // ---- pool hall along the back-left: one clean broad low block (r8 critic:
  // the old roof terrace + outside stair read as noise). Glazed ground floor
  // between white piers, a colour band carrying POOL, a window band, a roof
  // slab with a white parapet and a stepped glass barrel skylight on top.
  // (civic r10) critic r9: the pool hall was "small … soft and low in
  // contrast … no crisp outline". Now three storeys (a glazed arcade and two
  // office floors), a grid of colour-band pilasters between dark-reveal
  // windows, and an ink line under every band, canopy and the roof lip.
  const HX0 = 2, HX1 = 30, HZ0 = 41, HZ1 = 60, G2 = y + 8, RT = y + 22, ink = INK();
  g.box(HX0, y, HZ0, HX1, RT - 1, HZ1, C.signWhite);
  g.box(HX0, G2 - 1, HZ0, HX1, G2 - 1, HZ1, band);
  g.walls(HX0 - 1, RT, HZ0 - 1, HX1 + 1, RT, HZ1 + 1, C.signWhite);                 // roof slab lip
  g.box(HX0, RT, HZ0, HX1, RT, HZ1, C.civPanel);
  inkEdges(g, HX0, HZ0, HX1, HZ1, G2, RT - 1);
  for (const [side, pl, u0, u1] of [['front', HZ0, HX0, HX1], ['right', HX1, HZ0, HZ1], ['back', HZ1, HX0, HX1], ['left', HX0, HZ0, HZ1]]) {
    const F = facade(g, side, pl);
    F.clear(u0 + 1, y, 0, u1 - 1, y + 5, 0);
    F.box(u0 + 1, y, -1, u1 - 1, y + 5, -1, C.dtGlass);
    for (let u = u0; u <= u1; u += 4) F.box(u, y, 0, u, y + 5, 0, C.signWhite);
    F.box(u0, y + 6, 1, u1, y + 6, 2, C.signWhite);                                  // canopy all round
    const E = hiFacade(g, side, pl);
    for (let u = u0; u + 4 <= u1; u += 4) {
      E.box(2 * u + 4, 2 * y, -1, 2 * u + 5, 2 * y + 11, -1, C.signWhite);
      E.box(2 * u + 2, 2 * y + 8, -1, 2 * u + 7, 2 * y + 8, -1, C.signWhite);
    }
    E.box(2 * u0, 2 * (y + 6) - 1, 0, 2 * u1 + 1, 2 * (y + 6) - 1, 4, ink);            // shadow line under the canopy
    E.box(2 * u0, 2 * y + 11, -1, 2 * u1 + 1, 2 * y + 11, -1, ink);                  // dark head of the arcade glazing
    // two office floors: pilasters in the band colour, dark-reveal windows
    for (let u = u0 + 4; u < u1; u += 4) F.box(u, G2, 1, u, RT - 2, 1, band);
    for (const u of [u0, u1]) F.box(u, G2, 1, u, RT - 2, 1, band);
    for (const fy of [G2 + 1, G2 + 7]) for (let u = u0 + 1; u + 2 < u1; u += 4) fineWin(g, side, pl, u, fy, 3, 5, { frame: C.signWhite, trim: C.signWhite, glass: C.dtGlass, hood: false });
    E.box(2 * u0 - 2, 2 * (G2 + 6), 0, 2 * u1 + 3, 2 * (G2 + 6), 2, C.signWhite);    // floor ledge
    E.box(2 * u0 - 2, 2 * (G2 + 6) - 1, 0, 2 * u1 + 3, 2 * (G2 + 6) - 1, 0, ink);
  }
  const FB = facade(g, 'front', HZ0);
  FB.box(9, G2 - 2, 2, 23, G2, 2, band);
  hiText(g, 'front', HZ0, 16, G2 - 1.5, 'POOL', C.signWhite, 2);
  const FL = facade(g, 'left', HX0);
  FL.box(43, G2 - 2, 2, 57, G2, 2, band);
  hiText(g, 'left', HX0, 50, G2 - 1.5, 'POOL', C.signWhite, 2);
  const FK = facade(g, 'back', HZ1);
  FK.box(9, G2 - 2, 2, 23, G2, 2, band);
  hiText(g, 'back', HZ1, 16, G2 - 1.5, 'POOL', C.signWhite, 2);
  fineDentils(g, HX0, HZ0, HX1, HZ1, 2 * (RT - 1), C.signWhite);
  fineBand(g, HX0, HZ0, HX1, HZ1, 2 * (RT - 1) - 1, band, 1, 1);
  inkBand(g, HX0, HZ0, HX1, HZ1, 2 * (RT - 1) - 2, 1, 1);
  inkBand(g, HX0 - 1, HZ0 - 1, HX1 + 1, HZ1 + 1, 2 * RT - 1, 1, 0);
  inkBand(g, HX0, HZ0, HX1, HZ1, 2 * (G2 - 1) - 1, 1, 0);
  { const Hb = hiGrid(g), yb = 2 * (y + 7);
    const X0 = 2 * HX0 - 4, X1 = 2 * HX1 + 5, Z0 = 2 * HZ0 - 4, Z1 = 2 * HZ1 + 5;
    Hb.walls(X0, yb, Z0, X1, yb + 1, Z1, C.civPoolLt); Hb.walls(X0, yb + 2, Z0, X1, yb + 2, Z1, C.signWhite);
    for (let x = X0; x <= X1; x += 4) { Hb.box(x, yb, Z0, x, yb + 1, Z0, C.signWhite); Hb.box(x, yb, Z1, x, yb + 1, Z1, C.signWhite); }
    for (let z = Z0; z <= Z1; z += 4) { Hb.box(X0, yb, z, X0, yb + 1, z, C.signWhite); Hb.box(X1, yb, z, X1, yb + 1, z, C.signWhite); } }
  // roof: white parapet, a glass barrel vault over the pool hall, two AC units
  g.walls(HX0, RT + 1, HZ0, HX1, RT + 1, HZ1, C.signWhite);
  // (r9) a smooth fine glass barrel vault: semicircular section, white ribs
  // every 4 fine, a ridge rail and a white curb (the res-4 vault was steps)
  { const Hp = hiGrid(g), Y0 = 2 * (RT + 1), Zc = 2 * 50 + 1, R = 8;
    Hp.box(10, Y0, Zc - R - 1, 55, Y0, Zc + R, C.signWhite);
    for (let x = 10; x <= 55; x++) for (let k = -R; k < R; k++) {
      const zc = k + 0.5, hgt = Math.sqrt(Math.max(0, R * R - zc * zc));
      const top = Y0 + 1 + Math.round(hgt * 0.9);
      const rib = (x - 10) % 5 === 0 || x === 55;
      for (let yy = Y0 + 1; yy <= top; yy++) {
        const surf = yy >= top - 1 || Math.abs(k + 0.5) >= R - 1.5;
        if (!surf && !rib) continue;
        Hp.set(x, yy, Zc + k, rib ? C.signWhite : (yy === top && Math.abs(zc) < 1) ? C.signWhite : (k < 0 ? C.civGlass : C.civPoolLt));
      }
    }
  }
  for (const [ax, az] of [[10, 112], [18, 112], [46, 112], [54, 112], [10, 84], [54, 84]]) fineAC(g, ax, 2 * (RT + 1), az, 6, 5);   // (r9) fine roof gear
  // ---- kiddie pool with a mushroom fountain, back-middle
  g.walls(35, y, 42, 48, y, 55, C.signWhite);
  g.box(36, y - 1, 43, 47, y - 1, 54, C.civPoolLt);
  g.box(39, y - 1, 46, 44, y - 1, 51, C.civPool);
  g.box(41, y, 48, 42, y + 3, 49, C.signWhite); g.box(39, y + 4, 46, 44, y + 4, 51, C.red); g.box(40, y + 5, 47, 43, y + 5, 50, C.red);
  for (const [dx, dz] of [[40, 47], [43, 50]]) g.set(dx, y + 5, dz, C.signWhite);
  // ---- sun deck on the right: umbrellas over pairs of loungers
  for (const [ux, uz, k] of [[50, 8, 0], [57, 8, 1], [50, 20, 1], [57, 20, 0], [50, 32, 0], [57, 32, 1], [55, 46, 1], [55, 57, 0]]) {
    fineUmbrella(g, ux, y, uz + 2, umb[k], umb[1 - k], 5, 5);        // (r9) fine umbrellas + loungers
    fineLounger(g, ux - 3, y, uz, 'z', C.signWhite, umb[k]); fineLounger(g, ux + 2, y, uz, 'z', C.signWhite, C.civSeat);
  }
  // ---- clipped hedge beds (ref05) along the front and the deck edges
  for (const [x0, z0, x1, z1] of [[2, 1, 12, 1], [16, 1, 30, 1], [34, 1, 46, 1], [33, 60, 48, 60], [4, 25, 20, 26]])
    bush(g, x0, y, z0, x1, z1, 3);
  for (const [x0, z0, x1, z1] of [[5, 29, 12, 35], [15, 29, 22, 35]]) {
    g.walls(x0, y, z0, x1, y, z1, C.lotRim); g.box(x0 + 1, y, z0 + 1, x1 - 1, y + 1, z1 - 1, V.bush);
    fineBlooms(g, x0 + 1, z0 + 1, x1 - 1, z1 - 1, y + 2, [V.petals[0], V.petals[2], V.petals[3], V.petals[4]]);
  }
  tree(g, 23, y, 32, { w: 5, h: 4, trunk: 8, tier: false }); tree(g, 59, y, 40, { w: 5, h: 4, trunk: 8, tier: false });
  bin(g, 45, y, 38); bin(g, 3, y, 22);
  // ---- people: bathers on the deck and terrace, swimmers
  crowd(g, [[48, 2, 61, 40], [3, 22, 26, 27], [44, 38, 60, 44], [26, 36, 44, 40]], y, 12, 6 + vi);
  swimmers(g, 5, 5, 41, 32, y, 16, 1 + vi);
  swimmers(g, 37, 44, 46, 53, y, 4, 5 + vi);
  return doneHi(g);
}

// ---- STADIUM (4×4): the ref05 showpiece — oval bowl, two tiers, roof ring -----
function bStadium(rng, v) {
  const S = 127, g = grid(S, 100, S, R4);
  const Y = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: C.civConcourse });   // ref05: dark concourse round the bowl
  const vi = mod(v, 2);
  // Both variants keep the ref05 blue bowl (critic: colours must read as the
  // same stadium from shot to shot); v1 swaps the orange aisles for white.
  const seat = C.civSeat, seatAlt = C.civSeatAlt;               // ref05: blue bowl, orange aisles
  const panelTop = vi ? C.civNavy : C.civSeat;
  const cx = 63, cz = 63, HX = 31, HZ = 23, RR = 6, DMAX = 27;
  const A = HX - RR, B = HZ - RR;
  // (w2r1) Continuous loop parameter round the rounded rect at ring d, with
  // every corner arc stretched to a whole number of periods P, so stripes,
  // piers and roof panels run round the corners with no seams (4A+4B = 168 is
  // a multiple of 8, 12 and 14). This let the corner ramp towers go: ref05's
  // bowl is one smooth rounded mass.
  const loopS = (x, z, d, P) => {
    const px = x - cx, pz = z - cz;
    const L = P * Math.max(1, Math.round(Math.PI / 2 * (RR + d) / P));
    const Q = (a, b) => Math.atan2(a, b) / (Math.PI / 2) * L;
    if (pz < -B && px >= -A && px <= A) return px + A;
    if (px > A && pz < -B) return 2 * A + Q(px - A, -(pz + B));
    if (px > A && pz <= B) return 2 * A + L + (pz + B);
    if (px > A) return 2 * A + L + 2 * B + Q(pz - B, px - A);
    if (pz > B && px >= -A) return 2 * A + 2 * L + 2 * B + (A - px);
    if (pz > B) return 4 * A + 2 * B + 2 * L + Q(-(px + A), pz - B);
    if (px < -A && pz >= -B) return 4 * A + 2 * B + 3 * L + (B - pz);
    return 4 * A + 4 * B + 3 * L + Q(-(pz + B), -(px + A));
  };
  const perim = (x, z, d = DMAX, P = 8) => Math.floor(loopS(x, z, d, P));
  // True on ONE cell-wide line every P along the loop (phase-matched to the
  // ring dRef), at any ring d: on the corner arcs the parameter is rescaled
  // to cells so voxel staircases don't sprout double ribs.
  const lineAt = (x, z, d, dRef, P) => {
    const onArc = Math.abs(x - cx) > A && Math.abs(z - cz) > B;
    const h = onArc ? 0.5 : 0;
    const t = loopS(x + h, z + h, dRef, P) / P;
    const off = Math.abs(t - Math.round(t)) * P;
    const k = onArc ? (Math.PI / 2 * (RR + d + 0.5)) / (P * Math.max(1, Math.round(Math.PI / 2 * (RR + dRef) / P))) : 1;
    return off * k < 0.5;
  };
  const topOf = (d) => d <= 1 ? Y + 2 : d <= 13 ? Y + 4 + 2 * ((d - 2) >> 1) : d <= 15 ? Y + 15
    : d === 16 ? Y + 21 : d <= 24 ? Y + 22 + 3 * ((d - 17) >> 1) : Y + 33;
  const stripe = (s) => mod(s, 14) < 3;
  const ads = [C.red, C.signWhite, C.civSeat, C.yellow];
  const PX0 = 37, PX1 = 89, PZ0 = 45, PZ1 = 81;
  const onLine = (x, z) => {
    const inPitch = x >= PX0 && x <= PX1 && z >= PZ0 && z <= PZ1;
    if (!inPitch) return false;
    if (x === PX0 || x === PX1 || z === PZ0 || z === PZ1 || x === cx) return true;
    if (Math.abs(Math.hypot(x - cx, z - cz) - 6) < 0.5) return true;
    if (x === cx && z === cz) return true;
    for (const [gx, dir] of [[PX0, 1], [PX1, -1]]) {
      const fx = (x - gx) * dir;
      if (fx >= 0 && fx <= 9 && Math.abs(z - cz) === 11) return true;
      if (fx === 9 && Math.abs(z - cz) <= 11) return true;
      if (fx >= 0 && fx <= 3 && Math.abs(z - cz) === 5) return true;
      if (fx === 3 && Math.abs(z - cz) <= 5) return true;
      if (fx === 6 && z === cz) return true;
    }
    return false;
  };
  // (w2r1) ref05 facade: horizontal bands, dark over light — a dark arcade at
  // the base, a white ledge, a navy glazed band, pale panels, a blue glazed
  // band, a white string course, a deep navy band under the white roof lip.
  // Piers are pale grey, not white, so the drum reads banded, not white.
  const facadeCol = (k, s) => {
    const m = mod(s, 8);
    if (k <= 7) {                                                    // arcade: grey piers, arched dark bays
      if (m < 2 || k === 7) return C.civPanel;
      if (k === 6) return (m === 2 || m === 7) ? C.civPanel : C.civNavy;
      if (k === 5) return (m === 2 || m === 7) ? C.civPanel : C.darkGray;
      return (k >= 2 && m >= 4 && m <= 5) ? C.civGlass : C.darkGray;
    }
    if (k <= 9) return C.civRoof;
    if (k <= 14) return (k >= 11 && k <= 13 && m >= 3 && m <= 6) ? C.civGlass : C.darkGray;
    if (k <= 16) return C.civPanel;
    if (k <= 21) return m === 0 ? C.civPanel : (k === 21 ? C.civNavy : C.civGlass);
    if (k <= 23) return C.civRoof;
    if (k <= 31) return (k >= 26 && k <= 28 && m >= 2 && m <= 6) ? C.civNavy : C.darkGray;   // (w2r1) civNavy renders mid-blue in game: the dark bands are darkGray
    return C.civRoof;
  };
  for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) {
    const dist = rrDist(x, z, cx, cz, HX, HZ, RR);
    const px = x - cx, pz = z - cz;
    if (dist < 0) {                                                  // pitch + runoff
      const inPitch = x >= PX0 && x <= PX1 && z >= PZ0 && z <= PZ1;
      g.set(x, Y - 1, z, onLine(x, z) ? C.lotLine : inPitch ? (((x - PX0) / 6 | 0) & 1 ? C.civPitchA : C.civPitchB) : C.civPitchB);
      continue;
    }
    const d = Math.floor(dist);
    if (d > DMAX + 2) continue;
    const s = perim(x, z, Math.min(d, DMAX), 8);
    const s14 = perim(x, z, d, 14);
    // players' tunnel through the lower tier at the +x end
    if (px > A && Math.abs(pz) <= 3 && d <= 12) {
      if (Math.abs(pz) === 3) g.box(x, Y, z, x, topOf(d), z, C.civNavy);
      else if (d === 12) g.box(x, Y, z, x, topOf(d), z, C.darkGray);
      else g.set(x, Y - 1, z, C.civNavy);
      continue;
    }
    if (d === DMAX + 2) {                                            // concourse balcony lip + rail
      g.set(x, Y + 8, z, C.civPanel); g.set(x, Y + 10, z, C.signWhite);
      if (mod(s, 4) === 0) g.set(x, Y + 9, z, C.signWhite);
      continue;
    }
    if (d === DMAX + 1) {                                            // proud grey ribs + concourse deck
      g.set(x, Y + 8, z, C.civPanel);
      if (lineAt(x, z, d, DMAX, 8)) g.box(x, Y + 9, z, x, Y + 31, z, C.civPanel);
      continue;
    }
    const top = topOf(d);
    if (d <= 1) { g.box(x, Y, z, x, top, z, d === 0 ? ads[mod(s14 >> 3, 4)] : C.civNavy); continue; }
    if (d <= 13) { g.set(x, top, z, stripe(s14) ? seatAlt : seat); g.set(x, top - 1, z, C.civNavy); continue; }
    if (d <= 15) { g.set(x, top, z, C.civPanel); g.set(x, top - 1, z, C.civNavy); continue; }
    if (d === 16) {
      for (let yy = Y + 14; yy <= top; yy++) g.set(x, yy, z, (yy >= Y + 17 && yy <= Y + 20 && mod(s14, 7) !== 0) ? C.civGlass : C.civNavy);
    } else if (d <= 24) {
      const sc = stripe(s14) ? seatAlt : seat;
      g.set(x, top, z, sc); g.set(x, top - 1, z, sc); g.set(x, top - 2, z, C.civNavy);
    } else if (d < DMAX) {
      g.box(x, Y + 30, z, x, top, z, C.civNavy);
    } else {
      for (let yy = Y; yy <= top; yy++) g.set(x, yy, z, facadeCol(yy - Y, s));
    }
    if (d >= 16) {
      // (w2r1) ref05 roof ring: WIDE (d 16..27, ~45% of the bowl), white,
      // panelled by raised white radial ribs every 8 and a ring rib at d 22 —
      // translucent BLUE panels on the outer half, pale panels on the inner
      // half, a raised white lip on both edges, floodlights along the inner lip.
      const sR = perim(x, z, 22, 8);
      const rib = d === 22 || lineAt(x, z, d, 22, 8);
      g.set(x, Y + 34, z, C.civRoof);
      if (d <= 17 || d === DMAX) { g.set(x, Y + 35, z, C.civRoof); g.set(x, Y + 36, z, C.civRoof); }
      else if (rib) { g.set(x, Y + 35, z, C.civRoof); g.set(x, Y + 36, z, C.civRoof); }
      else g.set(x, Y + 35, z, d >= 23 ? C.civGlass : C.civPanel);
      if (d === 16) g.set(x, Y + 33, z, mod(sR, 12) === 6 ? C.lamp : C.civRoof);
    }
  }
  // (r9) fine facade trim on the four straight sides (critic r8: "its facade
  // is coarser"): a fine sill ledge + glazing mullions in each window bay of
  // the two glass bands, fine dentils under the navy band, fine capitals
  // and bases on the white piers
  hiGrid(g, 2 * (Y + 44));
  { // (r10) dark ink lines under the roof ring's inner lip (the cantilever's
    // shadow edge) so the ring reads crisply against the seats
    const H = hiGrid(g);
    for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) {
      const dd = rrDist(x, z, cx, cz, HX, HZ, RR);
      if (dd >= 16 && dd < 17) for (const [i, k] of [[0, 0], [1, 0], [0, 1], [1, 1]]) H.set(2 * x + i, 2 * (Y + 34) - 1, 2 * z + k, INK());
    }
  }
  // (w2r1) fine trim on the four straight sides, phased by the same loop
  // parameter as the res-4 bands: sill ledges under both glazed bands,
  // mullions, and fine white dentils under the white string course.
  for (const [side, pl, u0, u1] of [['front', cz - HZ - DMAX, cx - A, cx + A], ['back', cz + HZ + DMAX, cx - A, cx + A], ['left', cx - HX - DMAX, cz - B, cz + B], ['right', cx + HX + DMAX, cz - B, cz + B]]) {
    const E = hiFacade(g, side, pl);
    const xz = side === 'front' || side === 'back';
    for (let u = u0; u <= u1; u++) {
      const m = mod(xz ? perim(u, pl, DMAX, 8) : perim(pl, u, DMAX, 8), 8);
      if (m === 0) { E.box(2 * u, 2 * (Y + 22), 2, 2 * u + 1, 2 * (Y + 23) + 1, 2, C.civRoof); continue; }   // rib capital
      if (m >= 3 && m <= 6) {
        E.box(2 * u, 2 * (Y + 11) - 1, 0, 2 * u + 1, 2 * (Y + 11) - 1, 1, C.signWhite);
        if (m === 3 || m === 5) E.box(2 * u + 1, 2 * (Y + 11), 0, 2 * u + 1, 2 * (Y + 14) - 1, 0, C.civPanel);
      }
      E.box(2 * u, 2 * (Y + 17) - 1, 0, 2 * u + 1, 2 * (Y + 17) - 1, 1, C.signWhite);
      if (m === 4) E.box(2 * u, 2 * (Y + 17), 0, 2 * u, 2 * (Y + 21) - 1, 0, C.civPanel);
      if ((u & 1) === 0) E.box(2 * u, 2 * (Y + 22) - 1, 0, 2 * u, 2 * (Y + 22) - 1, 0, C.signWhite);
    }
  }
  // concourse paving joints + the match-day crowd milling round the base
  for (let x = 1; x < S - 1; x++) for (let z = 1; z < S - 1; z++) {
    if ((x % 12 && z % 12) || rrDist(x, z, cx, cz, HX, HZ, RR) <= DMAX + 2) continue;
    if (!g.map.has(x + ',' + Y + ',' + z)) g.set(x, Y - 1, z, C.civConcourseLt);
  }
  // goals
  for (const [gx, dir] of [[PX0, -1], [PX1, 1]]) {
    for (const gz of [cz - 4, cz + 4]) { g.box(gx + dir, Y, gz, gx + dir, Y + 3, gz, C.signWhite); g.box(gx + dir * 3, Y, gz, gx + dir * 3, Y + 3, gz, C.metal); }
    g.box(gx + dir, Y + 3, cz - 4, gx + dir, Y + 3, cz + 4, C.signWhite);
    g.box(gx + dir * 3, Y + 3, cz - 4, gx + dir * 3, Y + 3, cz + 4, C.metal);
  }
  // entrances + STADIUM signs on the front and back facades, white canopies
  for (const side of ['front', 'back']) {
    const zF = side === 'front' ? cz - HZ - DMAX : cz + HZ + DMAX;        // d = 27 plane
    const out = side === 'front' ? -1 : 1;
    for (let x = cx - 10; x <= cx + 10; x++) for (let k = 0; k <= 6; k++) g.set(x, Y + k, zF, (x - cx) % 4 === 0 || k === 6 ? C.civRoof : C.civGlass);
    g.box(cx - 13, Y + 8, zF + out, cx + 13, Y + 8, zF + out * 4, C.civRoof);
    // no billboard lettering (critic r2): a crest roundel over the gate
    const F = facade(g, side, zF + out);
    F.box(-4 + cx, Y + 17, 1, 4 + cx, Y + 25, 1, C.civNavy); F.box(-3 + cx, Y + 16, 1, 3 + cx, Y + 26, 1, C.civNavy);
    F.box(-2 + cx, Y + 18, 2, 2 + cx, Y + 24, 2, C.civSeat); F.box(-1 + cx, Y + 19, 3, 1 + cx, Y + 23, 3, C.signWhite);
    F.set(cx, Y + 21, 4, C.civSeatAlt);
  }
  // plaza clutter: flag row, food kiosks with umbrellas, benches, lamp masts
  const flagCols = [C.civSeat, C.civSeatAlt, C.signWhite, C.yellow, C.red, C.roofGreen];
  [24, 32, 88, 96, 104].forEach((fx, i) => { g.box(fx, Y, 6, fx, Y + 18, 6, C.signWhite); g.box(fx + 1, Y + 13, 6, fx + 5, Y + 18, 6, flagCols[i]); });
  for (const [ux, uz, c] of [[30, 16, C.civSeatAlt], [96, 16, C.civSeat], [8, 60, C.red], [118, 66, C.yellow]]) {
    g.box(ux - 2, Y, uz - 2, ux + 2, Y + 4, uz + 2, C.signWhite); g.box(ux - 2, Y + 2, uz - 3, ux + 2, Y + 3, uz - 3, c);
    umbrella(g, ux + 5, Y, uz + 3, c, C.signWhite, 7);
  }
  for (const [bx, bz] of [[26, 3], [94, 3]]) benchS(g, bx, Y, bz, 'x', 5, { seat: C.wood });
  for (const [lx, lz] of [[3, 30], [123, 30], [3, 96], [123, 96]]) lampPost(g, lx, Y, lz, 13, { small: true });
  for (const [tx, tz] of [[8, 8], [118, 8], [8, 118], [118, 118]]) tree(g, tx, Y, tz, { w: 9, h: 9, trunk: 6 });
  // front plaza: trees, ticket kiosks, bollards; back: parking with cars
  for (const tx of [22, 104]) { tree(g, tx, Y, 6, { w: 9, h: 8, trunk: 6 }); tree(g, tx, Y, 120, { w: 9, h: 8, trunk: 6 }); }
  for (const kx of [40, 80]) {
    g.box(kx, Y, 3, kx + 6, Y + 7, 7, C.civNavy);
    g.box(kx + 1, Y + 3, 2, kx + 5, Y + 5, 2, C.civGlass);
    g.box(kx - 1, Y + 8, 2, kx + 7, Y + 8, 8, seat);
  }
  for (let bx = 50; bx <= 76; bx += 5) g.box(bx, Y, 4, bx, Y + 2, 4, C.civRoof);
  const carCols = [C.red, C.civSeat, C.signWhite, C.yellow, C.roofGreen, C.orange];
  g.box(30, Y - 1, 117, 96, Y - 1, 125, C.lotAsphalt);
  for (let i = 0; i <= 8; i++) g.box(30 + i * 8, Y - 1, 117, 30 + i * 8, Y - 1, 125, C.lotLine);
  for (let i = 0; i < 8; i++) if ((i * 5 + vi) % 3 !== 1) car(g, 32 + i * 8, Y, 117, 'z', carCols[(i + vi) % carCols.length], { seed: i, rev: (i & 2) > 0 });
  // crowd: fans in team colours, mostly near the gates and along the front
  const shirts = [C.civSeat, C.civSeat, C.civSeatAlt, C.signWhite, C.red, C.yellow];
  let seed = 1234 + vi;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // (r9) the shared life.js figure (head, arms, legs) instead of 260 res-4
  // pegs, fewer of them (they read as a heap of crates round the gates)
  for (let i = 0, placed = 0; i < 8000 && placed < 64; i++) {
    const x = 2 + Math.floor(rnd() * (S - 4)), z = 2 + Math.floor(rnd() * (S - 4));
    const d = rrDist(x, z, cx, cz, HX, HZ, RR);
    if (d <= DMAX + 3 || (z >= 115 && x >= 28 && x <= 98)) continue;
    const nearGate = Math.abs(x - cx) < 22 || Math.abs(z - cz) < 16;
    if (!nearGate && rnd() < 0.6) continue;
    if (g.map.has(x + ',' + Y + ',' + z) || g.map.has(x + ',' + (Y + 2) + ',' + z)) continue;
    if (person(g, x, Y, z, shirts[placed % shirts.length], C.civNavy) === false) continue;
    placed++;
  }
  return doneHi(g);
}

// ---- FERRIS WHEEL (3×3): A-frames, boarding deck, queue, booth; wheel spins --
const FW_HUB = 80;                                                  // fine voxels (20 world)
function bFerrisWheel(rng, v) {
  const S = 95, g = grid(S, 120, S, R4);
  const y = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: 'pave' });
  const vi = mod(v, 2);
  const frame = vi ? C.civSeat : C.signWhite, accent = vi ? C.yellow : C.red;
  const cx = 47, cz = 47;
  disc(g, cx, y - 1, cz, 30, C.lotPaveDark); disc(g, cx, y - 1, cz, 28, C.civPlaza);
  g.box(cx - 6, y - 1, 1, cx + 6, y - 1, cz - 20, C.civPlaza);
  // boarding deck + front stairs + railing
  g.box(cx - 14, y, cz - 11, cx + 14, y + 7, cz + 11, C.civPanel);
  g.box(cx - 14, y + 7, cz - 11, cx + 14, y + 7, cz + 11, C.plank);
  g.walls(cx - 14, y + 7, cz - 11, cx + 14, y + 7, cz + 11, accent);
  for (let i = 0; i < 7; i++) g.box(cx - 5, y, cz - 12 - i, cx + 5, y + 6 - i, cz - 12 - i, C.civMarble);
  for (let x = cx - 14; x <= cx + 14; x++) if (Math.abs(x - cx) > 5) { g.set(x, y + 10, cz - 11, C.signWhite); if (x % 3 === 0) g.box(x, y + 8, cz - 11, x, y + 9, cz - 11, C.signWhite); }
  for (let x = cx - 14; x <= cx + 14; x++) { g.set(x, y + 10, cz + 11, C.signWhite); if (x % 3 === 0) g.box(x, y + 8, cz + 11, x, y + 9, cz + 11, C.signWhite); }
  for (let z = cz - 11; z <= cz + 11; z++) for (const x of [cx - 14, cx + 14]) { g.set(x, y + 10, z, C.signWhite); if (z % 3 === 0) g.box(x, y + 8, z, x, y + 9, z, C.signWhite); }
  // two A-frames either side of the wheel plane + axle
  for (const zL of [cz - 10, cz + 9]) {
    for (let yy = y; yy <= FW_HUB; yy++) {
      const off = Math.round(34 * (1 - (yy - y) / (FW_HUB - y)));
      g.box(cx - off - 1, yy, zL, cx - off + 1, yy, zL + 1, frame);
      g.box(cx + off - 1, yy, zL, cx + off + 1, yy, zL + 1, frame);
    }
    for (const ty of [y + 30, y + 56]) {
      const off = Math.round(34 * (1 - (ty - y) / (FW_HUB - y)));
      g.box(cx - off, ty, zL, cx + off, ty + 1, zL + 1, frame);
    }
    for (const sx of [-35, 35]) g.box(cx + sx - 3, y, zL - 2, cx + sx + 3, y + 2, zL + 3, C.concrete);
  }
  g.box(cx - 2, FW_HUB - 2, cz - 12, cx + 2, FW_HUB + 2, cz + 11, C.metalDark);
  g.box(cx - 3, FW_HUB - 3, cz - 13, cx + 3, FW_HUB + 3, cz - 13, C.gold);
  g.box(cx - 3, FW_HUB - 3, cz + 12, cx + 3, FW_HUB + 3, cz + 12, C.gold);
  // queue rails (zig-zag) in front of the stairs
  for (const qz of [14, 20, 26]) {
    for (let x = 36; x <= 58; x++) if (!(qz === 20 ? x > 55 : x < 39)) { g.set(x, y + 3, qz, C.red); if (x % 4 === 0) g.box(x, y, qz, x, y + 3, qz, C.metal); }
  }
  // ticket booth (front-left) with striped roof + FUN sign
  g.box(8, y, 8, 20, y + 9, 16, C.signWhite);
  g.box(10, y + 4, 7, 18, y + 7, 7, C.civGlass);
  g.box(8, y + 3, 6, 20, y + 3, 7, C.wood);
  for (let x = 7; x <= 21; x++) for (let z = 6; z <= 18; z++) g.set(x, y + 10, z, ((x >> 1) & 1) ? accent : C.signWhite);
  g.box(9, y + 11, 8, 19, y + 17, 8, C.civNavy);
  pixelText(facade(g, 'front', 8), 9 + 1, y + 12, 'FUN', C.yellow, 1);
  // a funfair lot filled edge to edge (critic r4): food court front-right,
  // visitor car park back-left, garden + popcorn cart back-right, bunting
  // masts along the front, lamps, and a crowd round the queue and stalls.
  for (const [lx, lz] of [[24, 30], [70, 30], [24, 66], [70, 66]]) lampPost(g, lx, y, lz, 10, { small: true });
  for (const [tx, tz] of [[8, 48], [86, 48]]) tree(g, tx, y, tz, { w: 9, h: 8, trunk: 6 });
  // food court: two striped kiosks, café tables, bins
  g.box(64, y - 1, 2, 92, y - 1, 22, C.civPlaza);
  for (let x = 64; x <= 92; x += 7) g.box(x, y - 1, 2, x, y - 1, 22, C.lotPave);
  kiosk(g, 65, y, 3, 10, 6, C.red, { signC: C.yellow });
  kiosk(g, 80, y, 3, 10, 6, C.civSeat, { signC: C.signWhite });
  [[68, 15, C.red], [76, 19, C.yellow], [84, 14, C.civSeat], [90, 19, C.red]].forEach(([ux, uz, c]) => umbTable(g, ux, y, uz, c));
  bin(g, 92, y, 10); bin(g, 63, y, 12);
  balloons(g, 59, y, 5, [C.red, C.yellow, C.civSeat, C.pink]);
  // visitor car park (back-left): two rows of bays behind a clipped hedge
  parkingRow(g, 3, y, 70, 4, [C.red, C.civSeat, null, C.yellow], vi);
  parkingRow(g, 3, y, 82, 4, [C.roofGreen, C.orange, C.signWhite, null], vi + 3);
  bush(g, 28, y, 70, 30, 93, 3);
  // back-right garden: trees, flower beds, benches, popcorn cart
  for (const [tx, tz] of [[88, 88], [68, 88]]) tree(g, tx, y, tz, { w: 9, h: 8, trunk: 6 });
  bush(g, 68, y, 72, 78, 74, 3, { flowers: [C.pink, C.yellow, C.signWhite] });
  bush(g, 82, y, 72, 92, 74, 3, { flowers: [C.red, C.signWhite, C.yellow] });
  benchS(g, 70, y, 78, 'x', 5); benchS(g, 84, y, 78, 'x', 5);
  kiosk(g, 76, y, 84, 6, 5, C.yellow, { h: 5, signC: C.red });
  bush(g, 40, y, 88, 58, 91, 4, { flowers: [C.pink, C.yellow, C.signWhite] });
  // bunting masts along the front edge
  const bunt = [C.red, C.yellow, C.civSeat, C.roofGreen, C.pink];
  for (let i = 0; i < 4; i++) { const bx = 26 + i * 6; g.box(bx, y, 2, bx, y + 12, 2, C.signWhite); g.box(bx + 1, y + 9, 2, bx + 3, y + 11, 2, bunt[i]); }
  // the crowd: queue, stair foot, deck, food court, gardens
  crowd(g, [[30, 8, 62, 28], [28, 28, 66, 34], [64, 10, 92, 24], [66, 66, 92, 86], [12, 20, 30, 64], [64, 30, 82, 64]], y, 80, 11 + vi);
  crowd(g, [[cx - 13, cz - 10, cx + 13, cz + 10]], y + 8, 14, 5 + vi);
  return doneHi(g);
}

// ---- ZOO (3×3): gate arch, sand paths, four themed enclosures ----------------
function giraffe(g, x, y, z) {
  const B = C.taxiYellow, S = C.trunk;
  for (const [lx, lz] of [[x, z], [x, z + 2], [x + 6, z], [x + 6, z + 2]]) g.box(lx, y, lz, lx, y + 8, lz, B);
  g.box(x, y + 9, z, x + 7, y + 12, z + 2, B);
  for (const [a, b, c2] of [[1, 11, 0], [4, 10, 0], [6, 12, 0], [2, 10, 2], [5, 11, 2], [3, 12, 1], [7, 15, 1], [6, 18, 1]]) g.set(x + a, y + b, z + c2, S);
  g.box(x + 6, y + 13, z + 1, x + 7, y + 21, z + 1, B);
  g.box(x + 5, y + 14, z + 1, x + 5, y + 20, z + 1, S);             // mane
  g.box(x + 6, y + 21, z, x + 9, y + 23, z + 2, B);
  g.set(x + 9, y + 22, z + 1, C.sand);
  g.set(x + 8, y + 23, z, C.black); g.set(x + 8, y + 23, z + 2, C.black);
  g.set(x + 6, y + 24, z, S); g.set(x + 6, y + 24, z + 2, S);
  g.box(x - 1, y + 9, z + 1, x - 1, y + 11, z + 1, S);
}
function elephant(g, x, y, z) {
  const B = C.stone, D = C.stoneDark;
  for (const [lx, lz] of [[x, z], [x, z + 5], [x + 8, z], [x + 8, z + 5]]) g.box(lx, y, lz, lx + 1, y + 4, lz + 1, D);
  g.box(x - 1, y + 5, z - 0, x + 10, y + 11, z + 6, B);
  g.box(x + 11, y + 6, z + 1, x + 14, y + 12, z + 5, B);
  g.box(x + 11, y + 6, z - 1, x + 12, y + 12, z - 1, D); g.box(x + 11, y + 6, z + 7, x + 12, y + 12, z + 7, D); // ears
  g.box(x + 15, y + 2, z + 3, x + 15, y + 9, z + 3, B); g.set(x + 16, y + 2, z + 3, B);          // trunk
  g.set(x + 15, y + 7, z + 1, C.signWhite); g.set(x + 15, y + 7, z + 5, C.signWhite);            // tusks
  g.set(x + 14, y + 10, z + 1, C.black); g.set(x + 14, y + 10, z + 5, C.black);
  g.box(x - 2, y + 8, z + 3, x - 2, y + 10, z + 3, D);
}
function lion(g, x, y, z) {
  const B = C.gold, M = C.hairAuburn;
  for (const [lx, lz] of [[x, z], [x, z + 3], [x + 6, z], [x + 6, z + 3]]) g.box(lx, y, lz, lx, y + 2, lz, B);
  g.box(x, y + 3, z, x + 7, y + 6, z + 3, B);
  g.box(x + 7, y + 3, z - 1, x + 9, y + 9, z + 4, M);
  g.box(x + 10, y + 4, z + 0, x + 11, y + 8, z + 3, B);
  g.set(x + 12, y + 5, z + 1, C.black); g.set(x + 12, y + 5, z + 2, C.black);
  g.set(x + 11, y + 7, z, C.black); g.set(x + 11, y + 7, z + 3, C.black);
  g.box(x - 3, y + 6, z + 1, x - 1, y + 6, z + 1, B); g.box(x - 4, y + 6, z + 1, x - 4, y + 7, z + 1, M);
}
function penguin(g, x, y, z) {
  g.box(x, y, z, x + 2, y + 5, z + 2, C.black);
  g.box(x, y, z, x + 2, y + 4, z, C.signWhite);
  g.box(x, y + 4, z + 2, x + 2, y + 4, z + 2, C.signWhite);
  g.set(x + 1, y + 4, z - 1, C.orange); g.box(x, y, z - 1, x + 2, y, z - 1, C.orange);
  g.set(x - 1, y + 2, z + 1, C.black); g.set(x + 3, y + 2, z + 1, C.black);
}
function bZoo(rng, v) {
  // (w2r1) Rebuilt as a landscaped zoo: the brown picket fences that boxed
  // every pen (the whole lot read as orange fencing) became low stone kerb
  // walls with a slim dark railing, like ref05's lot rims; the perimeter is a
  // clipped hedge; each enclosure has its own ground (savanna, dirt + pond,
  // rock + sand, ice + pool) with stamped vegetation trees and rocks; a
  // green-roofed entrance pavilion with the ZOO name carries the gate.
  const S = 95, g = grid(S, 64, S, R4);
  const y = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: C.civPlaza });
  const vi = mod(v, 2);
  const path = C.lotPave, cx = 47;
  // enclosure grounds (the plinth top row is y - 1)
  const ground = (x0, z0, x1, z1, c) => g.box(x0, y - 1, z0, x1, y - 1, z1, c);
  ground(3, 3, 41, 40, C.lotGrass);                                   // giraffes: grassland
  ground(53, 3, 91, 40, C.lotGrass);                                  // elephants: grass + dirt + pond
  ground(3, 54, 41, 91, C.sand);                                      // lions: sand + rock
  ground(53, 54, 91, 91, C.signWhite);                                // penguins: ice
  // savanna patches + a worn dirt track in the grass pens
  for (const [x0, z0, x1, z1] of [[8, 20, 20, 30], [22, 8, 34, 16], [58, 8, 70, 18], [60, 26, 66, 36]]) ground(x0, z0, x1, z1, C.dirt);
  // perimeter hedge (gap at the front gate) + avenues
  lumpHedge(g, 1, 1, cx - 10, 2, y, 0); lumpHedge(g, cx + 10, 1, S - 2, 2, y, 3);
  lumpHedge(g, 1, S - 3, S - 2, S - 2, y, 1);
  lumpHedge(g, 1, 3, 2, S - 4, y, 2); lumpHedge(g, S - 3, 3, S - 2, S - 4, y, 4);
  g.box(cx - 5, y - 1, 1, cx + 5, y - 1, S - 4, path);                // main avenue
  g.box(3, y - 1, 43, S - 4, y - 1, 51, path);                        // cross avenue
  disc(g, cx, y - 1, 47, 11, path);
  for (let z = 4; z < S - 4; z += 6) g.box(cx - 5, y - 1, z, cx + 5, y - 1, z, C.lotPaveDark);   // paving joints
  // enclosure walls: stone kerb (2 high, pale coping) + a slim dark railing
  const Hz = hiGrid(g);
  const wallRun = (x0, z0, x1, z1) => {
    g.box(x0, y, z0, x1, y, z1, C.lotSide);
    g.box(x0, y + 1, z0, x1, y + 1, z1, C.lotRim);
    // a slim FINE railing (res 8): posts every 2 res-4 voxels, one top rail
    const alongX = z0 === z1, a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1, c = alongX ? z0 : x0;
    const top = 2 * (y + 4);
    for (let a = 2 * a0; a <= 2 * a1 + 1; a++) {
      const set = (yy) => (alongX ? Hz.set(a, yy, 2 * c + 1, C.metalDark) : Hz.set(2 * c + 1, yy, a, C.metalDark));
      set(top);
      if (a % 4 === 0) for (let yy = 2 * (y + 2); yy < top; yy++) set(yy);
    }
  };
  const pen = (x0, z0, x1, z1) => { wallRun(x0, z0, x1, z0); wallRun(x0, z1, x1, z1); wallRun(x0, z0, x0, z1); wallRun(x1, z0, x1, z1); };
  // front-left: giraffes among tall trees
  pen(3, 3, 41, 40);
  giraffe(g, 12, y, 14); giraffe(g, 24, y, 25);
  lotTree(g, 'column', 33, y, 11, 3); lotTree(g, 'round', 10, y, 33, 5); lotTree(g, 'cluster', 34, y, 32, 7);
  rocks(g, 9, y, 8, 5, 3);
  bush(g, 16, y, 34, 24, 37, 4); g.box(24, y, 8, 28, y + 1, 11, C.woodDark);       // feeding trough
  g.box(21, y + 12, 7, 31, y + 12, 12, C.roofGreen); for (const [px, pz] of [[21, 7], [31, 7], [21, 12], [31, 12]]) g.box(px, y, pz, px, y + 11, pz, C.woodDark);   // feeding platform
  // front-right: elephants + pond with a rock rim
  pen(53, 3, 91, 40);
  g.box(72, y - 1, 23, 88, y - 1, 37, C.civPool); g.walls(71, y - 1, 22, 89, y - 1, 38, C.civPoolLt);
  g.box(74, y - 1, 25, 80, y - 1, 29, C.civPoolLt);
  elephant(g, 58, y, 12); if (vi === 0) elephant(g, 74, y, 10);
  rocks(g, 62, y, 32, 9, 5); rocks(g, 88, y, 22, 5, 3);
  lotTree(g, 'round', 85, y, 11, 2); lotTree(g, 'cluster', 57, y, 26, 4);
  // back-left: lions on a big stepped rock
  pen(3, 54, 41, 91);
  rocks(g, 22, y, 76, 15, 7); rocks(g, 27, y + 7, 78, 7, 3); rocks(g, 12, y, 84, 7, 4);
  lion(g, 20, y + 7, 72); lion(g, 9, y, 60);
  lotTree(g, 'round', 34, y, 62, 8); bush(g, 30, y, 84, 38, 88, 3);
  // back-right: penguin pool with an ice floe
  pen(53, 54, 91, 91);
  g.box(59, y - 1, 60, 85, y - 1, 85, C.civPool); g.walls(58, y - 1, 59, 86, y - 1, 86, C.civPoolLt);
  g.box(66, y, 66, 74, y + 2, 74, C.civPoolLt); g.box(68, y + 3, 68, 72, y + 4, 72, C.signWhite);
  for (const [px, pz] of [[67, 65], [70, 67], [73, 69], [56, 57], [61, 88], [88, 61], [56, 70]]) penguin(g, px, y + (px > 60 && px < 80 && pz > 60 && pz < 80 ? 5 : 0), pz);
  // centre: café kiosk with a green roof, umbrella tables round the roundel
  g.box(cx - 3, y, 44, cx + 3, y + 6, 50, C.cream);
  g.box(cx - 3, y + 2, 43, cx + 3, y + 4, 43, C.civGlass); g.box(cx - 3, y + 2, 51, cx + 3, y + 4, 51, C.civGlass);
  g.box(cx - 5, y + 7, 42, cx + 5, y + 7, 52, C.roofGreen); g.box(cx - 3, y + 8, 44, cx + 3, y + 8, 50, C.roofGreen);
  g.box(cx - 1, y + 9, 46, cx + 1, y + 9, 48, C.signWhite);
  for (const [ux, uz] of [[cx - 9, 40], [cx + 9, 55], [cx + 9, 40], [cx - 9, 55]]) umbTable(g, ux, y, uz, (ux + uz) & 2 ? C.yellow : C.red);
  // entrance pavilion + gate: two cream booths with green hip roofs linked
  // by a green arch beam carrying the ZOO name on a yellow board
  for (const gx of [cx - 13, cx + 7]) {
    g.box(gx, y, 1, gx + 6, y + 9, 7, C.cream);
    g.box(gx + 1, y + 3, 0, gx + 5, y + 6, 0, C.civGlass);
    g.box(gx - 1, y + 10, 0, gx + 7, y + 10, 8, C.roofGreen);
    hipRoof(g, gx, 1, gx + 6, 7, y + 11, 3, C.roofGreen);
  }
  g.box(cx - 7, y + 12, 2, cx + 7, y + 14, 5, C.roofGreen);
  g.box(cx - 6, y + 15, 3, cx + 6, y + 21, 4, C.yellow);
  g.box(cx - 7, y + 22, 3, cx + 7, y + 22, 4, C.roofGreen);
  for (const ex of [cx - 7, cx + 7]) g.box(ex, y + 15, 3, ex, y + 22, 4, C.roofGreen);
  const Fg = facade(g, 'front', 3);
  pixelText(Fg, cx - 5, y + 16, 'ZOO', C.roofGreen, 1);
  const Bg = facade(g, 'back', 4);
  pixelText(Bg, cx + 5, y + 16, 'ZOO', C.roofGreen, 1);
  for (let x = cx - 5; x <= cx + 5; x += 2) g.box(x, y, 2, x, y + 1, 2, C.metal);                  // turnstiles
  // lamps + benches + flower beds along the avenues
  for (const [lx, lz] of [[cx - 7, 20], [cx + 7, 70], [20, 42], [74, 52], [cx + 7, 24], [cx - 7, 76]]) lampPost(g, lx, y, lz, 10, { small: true });
  benchS(g, cx - 14, y, 52, 'x', 5); benchS(g, cx + 9, y, 36, 'x', 5); benchS(g, cx + 9, y, 58, 'x', 5);
  bush(g, cx + 7, y, 9, cx + 9, 18, 3, { flowers: [C.pink, C.yellow] }); bush(g, cx - 9, y, 60, cx - 7, 90, 3, { flowers: [C.pink, C.yellow] });
  bush(g, cx - 9, y, 9, cx - 7, 18, 3); bush(g, cx + 7, y, 60, cx + 9, 90, 3);
  crowd(g, [[cx - 5, 6, cx + 5, 90], [4, 43, 90, 51]], y, 50, 21 + vi);
  return doneHi(g);
}

// ---- CAROUSEL (2×2): round base, fence ring, booth; canopy+horses spin ------
function bCarousel(rng, v) {
  const S = 63, g = grid(S, 24, S, R4);
  const y = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: 'pave' });
  const vi = mod(v, 2);
  const cx = 31, cz = 31;
  disc(g, cx, y, cz, 27, C.civMarble);                                  // step ring
  disc(g, cx, y + 1, cz, 25, C.civPanel); disc(g, cx, y + 2, cz, 25, C.civMarble);
  for (let i = 0; i < 3; i++) g.box(cx - 5, y, cz - 28 - i, cx + 5, y + 2 - i, cz - 28 - i, C.civMarble);
  ringH(g, cx, y + 2, cz, 25, 26, C.gold);
  // fence ring (gold posts, white rail), gap at the front
  for (let a = 0; a < 72; a++) {
    const t = a / 72 * Math.PI * 2, fx = Math.round(cx + Math.cos(t) * 29.5), fz = Math.round(cz + Math.sin(t) * 29.5);
    if (Math.abs(fx - cx) <= 5 && fz < cz) continue;
    g.set(fx, y + 3, fz, C.signWhite);
    if (a % 3 === 0) g.box(fx, y, fz, fx, y + 3, fz, C.gold);
  }
  // every corner of the square lot does something (critic r4: no empty
  // paving round the ring): ticket booth, ice-cream kiosk, popcorn kiosk,
  // café tables, a tree in a planter; a bulb-lit gate arch; a crowd.
  const ca = vi ? C.civSeat : C.red, cb = vi ? C.yellow : C.civSeat;
  for (const [x0, z0] of [[1, 1], [49, 1], [1, 49], [49, 49]]) {           // two-tone corner paving
    for (let x = x0; x <= x0 + 12; x++) for (let z = z0; z <= z0 + 12; z++) if (Math.hypot(x - cx, z - cz) > 30.5) g.set(x, y - 1, z, ((x >> 2) + (z >> 2)) & 1 ? C.civPlaza : C.lotPave);
  }
  g.box(2, y, 2, 10, y + 8, 10, ca);                                    // ticket booth
  g.box(3, y + 3, 1, 9, y + 5, 1, C.civGlass); g.box(1, y + 3, 3, 1, y + 5, 9, C.civGlass);
  for (let x = 1; x <= 11; x++) for (let z = 1; z <= 11; z++) g.set(x, y + 9, z, ((x + z) >> 1) & 1 ? C.signWhite : C.yellow);
  g.box(4, y + 10, 5, 8, y + 12, 5, C.civNavy); g.box(5, y + 11, 5, 7, y + 11, 5, C.yellow);
  kiosk(g, 52, y, 2, 8, 5, cb, { signC: C.pink });                       // ice cream
  g.box(55, y + 10, 4, 56, y + 12, 5, C.pink); g.box(55, y + 13, 4, 56, y + 13, 5, C.signWhite);
  kiosk(g, 2, y, 53, 5, 8, C.red, { signC: C.yellow });                  // popcorn
  umbTable(g, 55, y, 55, ca); umbTable(g, 58, y, 49, cb); umbTable(g, 49, y, 58, C.yellow);
  tree(g, 57, y, 59, { w: 7, h: 7, trunk: 5 });
  g.walls(54, y, 56, 60, y, 62, C.civPanel);
  // gate arch over the front stair: two striped posts, a bulb-lit lintel
  for (const px of [cx - 7, cx + 6]) for (let yy = y; yy <= y + 16; yy++) g.box(px, yy, 1, px + 1, yy, 2, ((yy - y) >> 1) & 1 ? C.signWhite : ca);
  g.box(cx - 8, y + 17, 1, cx + 8, y + 20, 2, ca);
  for (let x = cx - 8; x <= cx + 8; x += 2) { g.set(x, y + 20, 0, C.lamp); g.set(x, y + 17, 0, C.lamp); g.set(x, y + 20, 3, C.lamp); }
  g.box(cx - 2, y + 21, 1, cx + 2, y + 23, 2, C.gold); g.set(cx, y + 24, 1, C.gold);
  for (const [lx, lz] of [[46, 12], [12, 46], [50, 46]]) lampPost(g, lx, y, lz, 10, { small: true });
  bush(g, 16, y, 1, 22, 2, 3, { flowers: [C.pink, C.signWhite] }); bush(g, 40, y, 1, 46, 2, 3, { flowers: [C.yellow, C.signWhite] });
  bush(g, 1, y, 16, 2, 22, 3, { flowers: [C.yellow, C.red] }); bush(g, 60, y, 16, 61, 22, 3, { flowers: [C.pink, C.yellow] });
  balloons(g, 14, y, 5, [C.red, C.yellow, C.civSeat, C.pink]);
  crowd(g, [[1, 1, 61, 12], [1, 1, 12, 61], [50, 1, 61, 61], [1, 50, 61, 61]], y, 46, 3 + vi);
  return doneHi(g);
}

// ---- WATER SLIDE (1×1): tower, straight drop slide + turning slide, pool ----
function slideSeg(g, pts, col) {
  // pts: [x, y, z, axis] centre-line points; axis 'x' → chute runs along x.
  for (const [x, y, z, ax] of pts) {
    if (ax === 'x') { g.box(x, y, z - 1, x, y, z + 1, col); g.box(x, y + 1, z - 1, x, y + 2, z - 1, col); g.box(x, y + 1, z + 1, x, y + 2, z + 1, col); g.set(x, y + 1, z, C.civPoolLt); }
    else { g.box(x - 1, y, z, x + 1, y, z, col); g.box(x - 1, y + 1, z, x - 1, y + 2, z, col); g.box(x + 1, y + 1, z, x + 1, y + 2, z, col); g.set(x, y + 1, z, C.civPoolLt); }
  }
}
function bWaterSlide(rng, v) {
  const g = grid(31, 56, 31, R4);
  const y = lotPlinth(g, 0, 0, 30, 30, { fill: C.sand });
  const vi = mod(v, 3);
  const cA = [C.civSeat, C.roofGreen, C.purple][vi], cB = [C.yellow, C.orange, C.pink][vi];
  // pool
  g.walls(1, y, 1, 24, y, 14, C.signWhite);
  g.box(2, y - 1, 2, 23, y - 1, 13, C.civPool);
  g.box(20, y - 1, 2, 23, y - 1, 5, C.civPoolLt); g.box(4, y - 1, 5, 6, y - 1, 8, C.civPoolLt);   // splash foam
  // tower x 16..27, z 17..28, deck at H
  const H = y + 26, tx0 = 17, tx1 = 27, tz0 = 17, tz1 = 28;
  for (const [px, pz] of [[tx0, tz0], [tx1 - 1, tz0], [tx0, tz1 - 1], [tx1 - 1, tz1 - 1]]) { g.box(px, y, pz, px + 1, H, pz + 1, cB); g.box(px, H + 1, pz, px, H + 11, pz, C.signWhite); }
  for (const yy of [y + 9, y + 18]) { g.walls(tx0, yy, tz0, tx1, yy, tz1, C.signWhite); }
  for (let k = 0; k < 9; k++) { g.set(tx0 + 1 + k, y + k, tz0, C.signWhite); g.set(tx0 + 1 + k, y + 9 + k, tz0, C.signWhite); g.set(tx1, y + k, tz0 + 1 + k, C.signWhite); g.set(tx1, y + 9 + k, tz0 + 1 + k, C.signWhite); }   // cross braces
  g.box(tx0, H, tz0, tx1, H, tz1, cA);
  g.walls(tx0, H + 1, tz0, tx1, H + 3, tz1, C.signWhite);
  for (let x = tx0 + 1; x < tx1; x++) for (let z = tz0 + 1; z < tz1; z++) g.del(x, H + 2, z);
  for (let x = tx0 + 1; x < tx1; x++) for (let z = tz0 + 1; z < tz1; z++) g.del(x, H + 1, z);
  gclr(g, tx0, H + 1, tz0, tx0 + 3, H + 3, tz0);
  for (let x = tx0 - 1; x <= tx1 + 1; x++) for (let z = tz0 - 1; z <= tz1 + 1; z++) g.set(x, H + 12, z, ((x + z) >> 1) & 1 ? cB : C.signWhite);
  g.box(tx0 + 2, H + 13, tz0 + 2, tx1 - 2, H + 13, tz1 - 2, cB);
  g.box(22, H + 14, 22, 22, H + 16, 22, C.red);
  // zig-zag stair up the right side (x 28..29)
  for (let i = 0; i < 26; i++) {
    const z = i < 13 ? 28 - i : 16 + (i - 13);
    g.box(28, y + i, z, 29, y + i, z, C.signWhite);
    if (i === 12) g.box(28, y + i, 15, 29, y + i + 1, 16, C.signWhite);
  }
  g.box(29, y, 16, 29, y + 26, 16, cB); g.box(29, y, 28, 29, y + 26, 28, cB);
  // slide A (straight steep drop, runs -z into the pool)
  const pa = [];
  for (let i = 0; i <= 14; i++) pa.push([22, Math.max(y - 1, H - 1 - Math.round(i * 1.9)), tz0 - 1 - i, 'z']);
  for (let i = 0; i < pa.length; i++) { const [x, yy, z] = pa[i]; if (i < pa.length - 1) g.box(x - 1, yy - 1, z, x + 1, yy - 1, z, cA); }
  slideSeg(g, pa, cA);
  // slide B: out of the tower's left face along -x, then turn and run -z
  const pb = [];
  let yy = H - 1;
  for (let x = tx0 - 1; x >= 5; x--) { pb.push([x, yy, 22, 'x']); yy -= 1; }
  for (let z = 21; z >= 6; z--) { pb.push([5, Math.max(y - 1, yy), z, 'z']); yy -= 1; }
  slideSeg(g, pb, cB);
  for (const [x, y2, z] of pb) if (y2 > y + 1 && ((x + z) % 6 === 0)) g.box(x, y, z, x, y2 - 1, z, C.metal);   // support legs
  g.box(5, yy + 14, 22, 5, yy + 14, 22, cB);
  // loungers, umbrella, splash
  for (const lz of [2, 8]) { lounger(g, 26, y, lz, 'z', C.red); lounger(g, 28, y, lz, 'z', C.civSeat); }
  umbrella(g, 27, y, 14, C.red, C.signWhite, 6, 2);
  // snack hut under slide B's run, a lifeguard chair, palms + hedge
  g.box(7, y, 25, 14, y + 6, 29, C.signWhite); g.box(7, y, 25, 14, y, 29, cA);
  g.box(6, y + 7, 24, 15, y + 7, 29, cB);
  const Hf = facade(g, 'front', 25); Hf.box(9, y + 2, 0, 12, y + 4, 0, C.civGlass); Hf.box(8, y + 1, 1, 13, y + 1, 1, C.wood);
  awning(Hf, 7, 14, y + 6, 2, { colors: [cA, C.signWhite] });
  g.box(1, y, 16, 1, y + 4, 16, C.signWhite); g.box(1, y + 5, 15, 2, y + 5, 17, C.red);
  tree(g, 2, y, 27, { w: 5, h: 4, trunk: 8, tier: false }); tree(g, 26, y, 20, { w: 5, h: 4, trunk: 7, tier: false });
  bush(g, 1, y, 29, 5, 29, 3);
  crowd(g, [[24, 1, 29, 16], [1, 15, 16, 24]], y, 9, 4 + vi);
  swimmers(g, 2, 2, 23, 13, y, 6, 2 + vi);
  return doneHi(g);
}

// ---- MINI GOLF (1×1): four felt holes packed edge to edge — a windmill hole,
// a castle-gate hole, an island green and a pond hole with a bridge — plus a
// striped lighthouse, a little clubhouse with an awning and sand paths.
function bMiniGolf(rng, v) {
  const g = grid(31, 44, 31, R4);
  const y = lotPlinth(g, 0, 0, 30, 30, { fill: C.civPlaza });
  const vi = mod(v, 3);
  const felt = C.civPitchA, feltDk = C.civPitchB, kerb = [C.wood, C.signWhite, C.civBrick][vi];
  const fair = (x0, z0, x1, z1) => { g.box(x0, y - 1, z0, x1, y - 1, z1, felt); g.walls(x0 - 1, y, z0 - 1, x1 + 1, y, z1 + 1, kerb); };
  const cup = (x, z, fc) => { g.set(x, y - 1, z, C.black); g.box(x, y, z, x, y + 5, z, C.signWhite); g.box(x + 1, y + 4, z, x + 2, y + 5, z, fc); };
  const tee = (x, z) => { g.set(x, y - 1, z, feltDk); g.set(x, y, z, C.signWhite); };
  // grass verges between the holes
  g.box(1, y - 1, 23, 29, y - 1, 29, C.lotGrass);
  // hole A (front): long run with a windmill straddling it
  fair(2, 2, 16, 6); tee(3, 4); cup(15, 4, C.red);
  const wx = 10;
  g.box(wx - 2, y, 1, wx + 2, y + 9, 1, C.red); g.box(wx - 2, y, 7, wx + 2, y + 9, 7, C.red);
  g.box(wx - 2, y + 3, 2, wx + 2, y + 9, 6, C.red); g.box(wx - 2, y + 3, 2, wx + 2, y + 3, 6, C.signWhite);
  hipRootLike(g, wx - 3, 0, wx + 3, 8, y + 10, C.signWhite);
  g.set(wx, y + 7, 0, C.darkGray);
  for (let k = -5; k <= 5; k++) { g.set(wx + k, y + 7, 0, C.signWhite); g.set(wx, y + 7 + k, 0, C.signWhite); }
  g.set(wx, y + 7, 0, C.yellow);
  // hole B (front-right): wide green with a pond + bridge
  fair(19, 2, 28, 12); tee(20, 3); cup(27, 11, C.yellow);
  g.box(22, y - 1, 5, 26, y - 1, 8, C.civPool); g.walls(21, y - 1, 4, 27, y - 1, 9, V.rock);
  g.box(23, y, 6, 23, y, 7, V.rockLight);
  for (let z = 4; z <= 9; z++) g.box(20, y, z, 20, y, z, C.wood);
  g.box(24, y, 4, 24, y + 1, 9, C.woodDark); g.box(24, y + 2, 4, 24, y + 2, 9, C.wood);
  // hole C (left): through a little castle gate
  fair(2, 9, 7, 21); tee(4, 10); cup(5, 20, C.civSeat);
  g.box(1, y, 14, 3, y + 7, 16, C.stone); g.box(6, y, 14, 8, y + 7, 16, C.stone);
  g.box(1, y + 5, 14, 8, y + 7, 16, C.stone);
  for (let x = 1; x <= 8; x += 2) { g.set(x, y + 8, 14, C.stone); g.set(x, y + 8, 16, C.stone); }
  g.box(4, y + 8, 15, 4, y + 11, 15, C.woodDark); g.box(5, y + 10, 15, 6, y + 11, 15, C.red);
  // hole D (middle): island green in a pond with a plank bridge
  g.box(10, y - 1, 10, 17, y - 1, 20, C.civPool); g.walls(9, y, 9, 18, y, 21, V.rock);
  g.box(12, y - 1, 13, 15, y - 1, 18, felt); g.walls(11, y, 12, 16, y, 19, kerb);
  g.box(13, y, 9, 14, y, 12, C.plank);
  cup(14, 16, C.orange);
  // lighthouse (back-left) — tall red/white landmark
  for (let yy = y; yy <= y + 20; yy++) disc(g, 5, yy, 26, yy > y + 14 ? 1.6 : 2.2, ((yy - y) >> 2) & 1 ? C.signWhite : C.red);
  disc(g, 5, y + 21, 26, 2.6, C.darkGray); g.box(4, y + 22, 25, 6, y + 23, 27, C.lamp); g.box(4, y + 24, 25, 6, y + 24, 27, C.red); g.set(5, y + 25, 26, C.red);
  // clubhouse (back-right): white hut, green awning, rooftop rail, putters rack
  g.box(19, y, 23, 29, y + 7, 29, C.signWhite); g.box(19, y, 23, 29, y, 29, C.roofGreen);
  g.box(19, y + 8, 23, 29, y + 8, 29, C.roofGreen);
  const F = facade(g, 'front', 23);
  door(F, 21, y, 2, 5, { color: C.woodDark, frame: C.roofGreen, step: null });
  F.box(24, y + 2, 0, 27, y + 4, 0, C.civGlass); F.box(24, y + 1, 1, 27, y + 1, 1, C.wood);
  awning(F, 19, 29, y + 7, 2, { colors: [C.roofGreen, C.signWhite] });
  acBox(g, 26, y + 9, 26, { w: 3, d: 3, h: 2 });
  flagPole(g, 21, y + 9, 27, 6, [C.red, C.signWhite], { w: 3, fh: 2 });
  for (let x = 20; x <= 22; x++) g.box(x, y, 20, x, y + 3, 20, C.metal);
  // trees + flowers + bench on the verges
  tree(g, 11, y, 26, { w: 5, h: 5, trunk: 4, tier: false }); tree(g, 16, y, 27, { w: 5, h: 4, trunk: 3, tier: false });
  for (let x = 9; x <= 17; x += 2) flower(g, x, y, 23, V.petals[x % V.petals.length]);
  benchS(g, 19, y, 16, 'z', 4, { seat: C.wood });
  crowd(g, [[1, 1, 29, 29]], y, 8, 9 + vi);
  return doneHi(g);
}
// Small solid hip used for the windmill cap.
function hipRootLike(g, x0, z0, x1, z1, y, c) { hipRoof(g, x0, z0, x1, z1, y, 4, c); }

// ---- SKATE PARK (1×1): a painted mini-ramp across the back, a street
// section in front (fun box + rail, kicker, stair set with a handrail, ledge),
// a skate-shop kiosk, bright graffiti on every ramp side, bench + lamp + trees.
function bSkatePark(rng, v) {
  const g = grid(31, 36, 31, R4);
  const y = lotPlinth(g, 0, 0, 30, 30, { fill: C.lotPaveDark });
  const vi = mod(v, 3);
  const graf = [[C.pink, C.teal, C.yellow], [C.orange, C.civSeat, C.roofGreen], [C.purple, C.yellow, C.red]][vi];
  const surf = [C.civSeat, C.teal, C.orange][vi];
  const deckC = C.civPanel;
  // painted floor graphics
  ringH(g, 15, y - 1, 10, 3, 4.2, graf[0]); disc(g, 15, y - 1, 10, 1.6, graf[2]);
  for (let x = 3; x <= 27; x += 2) g.set(x, y - 1, 15, C.yellow);
  // mini-ramp across the back (z 17..29): front quarter 5 high, back quarter 8
  const prof = [5, 4, 3, 2, 1, 0, 0, 0, 1, 2, 4, 6, 8];
  for (let i = 0; i < prof.length; i++) {
    const z = 17 + i, h = prof[i];
    for (let x = 3; x <= 27; x++) {
      if (h > 0) g.box(x, y, z, x, y + h - 1, z, C.concrete);
      g.set(x, y + h, z, h ? surf : C.lotPaveDark);
    }
    for (const x of [2, 28]) g.box(x, y, z, x, y + Math.max(h, 1), z, graf[(i >> 2) % 3]);   // painted cheeks
  }
  g.box(3, y + 5, 17, 27, y + 5, 17, C.metal); g.box(3, y + 8, 29, 27, y + 8, 29, C.metal);   // coping
  g.box(2, y + 9, 29, 28, y + 10, 29, C.signWhite);                                         // back rail
  for (let x = 2; x <= 28; x += 4) g.box(x, y + 9, 29, x, y + 10, 29, C.darkGray);
  for (let x = 4; x <= 26; x += 6) g.box(x, y + 1, 29, x + 3, y + 6, 29, graf[(x >> 2) % 3]); // graffiti wall
  // street section: fun box with a rail + launch ramps
  g.box(12, y, 5, 18, y + 2, 9, deckC); g.box(12, y + 1, 5, 18, y + 1, 5, graf[0]); g.box(12, y + 1, 9, 18, y + 1, 9, graf[1]);
  for (let i = 0; i < 3; i++) { g.box(11 - i, y, 5, 11 - i, y + 2 - i, 9, surf); g.box(19 + i, y, 5, 19 + i, y + 2 - i, 9, surf); }
  g.box(12, y + 4, 7, 18, y + 4, 7, C.metal); g.set(12, y + 3, 7, C.metal); g.set(18, y + 3, 7, C.metal);
  // kicker (front-right) + a flat rail
  for (let i = 0; i < 4; i++) g.box(24, y, 2 + i, 28, y + (i >> 1), 2 + i, graf[2]);
  g.box(23, y + 1, 9, 29, y + 1, 9, C.yellow); g.set(23, y, 9, C.darkGray); g.set(29, y, 9, C.darkGray);
  // stair set + handrail + ledge (left)
  for (let i = 0; i < 3; i++) g.box(2, y, 9 + i * 2, 8, y + i, 10 + i * 2, deckC);
  g.box(2, y, 15, 8, y + 3, 15, C.concrete);
  for (let i = 0; i <= 5; i++) g.set(5, y + 2 + (i >> 1), 9 + i, C.yellow);
  // skate-shop kiosk (front-left corner) with a striped awning
  g.box(1, y, 1, 7, y + 6, 6, C.signWhite); g.box(1, y, 1, 7, y, 6, graf[1]); g.box(1, y + 7, 1, 7, y + 7, 6, C.darkGray);
  const K = facade(g, 'right', 7);
  K.box(2, y + 2, 0, 5, y + 4, 0, C.civGlass);
  awning(K, 1, 6, y + 6, 2, { colors: [graf[0], C.signWhite], stripe: 1 });
  g.box(2, y + 1, 7, 2, y + 3, 7, C.red); g.box(3, y + 1, 7, 3, y + 3, 7, C.yellow);    // boards in the rack
  // bench, lamp, bin, trees in the right-back corner, a board on the floor
  benchS(g, 24, y, 13, 'x', 4, { seat: C.woodDark });
  lampPost(g, 21, y, 14, 10, { small: true });
  bin(g, 29, y, 12);
  g.box(14, y, 12, 17, y, 12, C.red); g.set(14, y, 12, C.black); g.set(17, y, 12, C.black);
  crowd(g, [[1, 1, 29, 16]], y, 7, 12 + vi);
  return doneHi(g);
}

// ---- MUSEUM (3×2): classical hall, portico + pediment, dome, dino on lawn ----
function bMuseum(rng, v) {
  const SX = 95, SZ = 63, g = grid(SX, 72, SZ, R4);
  const y = lotPlinth(g, 0, 0, SX - 1, SZ - 1, { fill: 'pave' });
  const vi = mod(v, 2);
  const wall = vi ? C.cream : C.civMarble, trim = C.signWhite, domeC = vi ? C.gold : C.civCornice;
  const banners = [C.red, C.civSeat, C.roofGreen, C.orange];
  const X0 = 10, X1 = 84, Z0 = 20, Z1 = 57, TOP = y + 30;
  // podium + front stairs
  g.box(X0 - 2, y, Z0 - 6, X1 + 2, y + 3, Z1 + 1, C.civPanel);
  g.box(X0 - 2, y + 3, Z0 - 6, X1 + 2, y + 3, Z1 + 1, C.civMarble);
  for (let i = 0; i < 4; i++) g.box(26, y, Z0 - 7 - i, 68, y + 3 - i, Z0 - 7 - i, C.civMarble);
  const yb = y + 4;
  // main hall
  g.walls(X0, yb, Z0, X1, TOP, Z1, wall);
  g.box(X0 + 1, TOP + 1, Z0 + 1, X1 - 1, TOP + 1, Z1 - 1, C.roofGray);
  g.walls(X0 - 1, TOP - 1, Z0 - 1, X1 + 1, TOP, Z1 + 1, trim);          // cornice
  parapet(g, X0, Z0, X1, Z1, TOP + 1, 2, wall, trim);
  fineDentils(g, X0, Z0, X1, Z1, 2 * (TOP - 2), trim);                 // (r9) fine dentils + necking band
  fineBand(g, X0, Z0, X1, Z1, 2 * (TOP - 2) - 2, trim, 1, 1);
  g.walls(X0 - 1, yb, Z0 - 1, X1 + 1, yb + 1, Z1 + 1, C.civPanel);     // base course
  // pilasters + tall windows on all four walls
  const F = facade(g, 'front', Z0), Bk = facade(g, 'back', Z1), L = facade(g, 'left', X0), R = facade(g, 'right', X1);
  for (const f of [F, Bk]) for (let u = X0 + 4; u <= X1 - 6; u += 8) {
    if (f === F && u > 22 && u < 70) continue;
    if (f === Bk && u > 38 && u < 56) continue;
    fineWin(g, f.side, f.plane, u, yb + 6, 3, 13, { frame: trim, trim, glass: C.civGlass, key: trim });   // (r9) fine windows
    f.box(u + 5, yb, 1, u + 5, TOP - 2, 1, trim);
  }
  for (const f of [L, R]) for (let u = Z0 + 5; u <= Z1 - 6; u += 8) {
    fineWin(g, f.side, f.plane, u, yb + 6, 3, 13, { frame: trim, trim, glass: C.civGlass, key: trim });
    f.box(u - 2, yb, 1, u - 2, TOP - 2, 1, trim);
  }
  // portico: 9 columns, entablature, pediment
  const P0 = 26, P1 = 68, PZ = Z0 - 5;
  g.box(P0, yb, PZ, P1, yb, Z0 - 1, C.civMarble);
  for (let k = 0; k < 9; k++) {
    const x = P0 + 2 + k * 5;
    g.box(x - 1, yb + 1, PZ + 1, x + 1, TOP - 3, PZ + 2, trim);
    fineColumn(g, x - 1, PZ + 1, x + 1, PZ + 2, yb + 2, TOP - 4, trim, trim);   // (r9)
    g.box(x - 2, yb + 1, PZ, x + 2, yb + 1, PZ + 3, C.civMarble);
    g.box(x - 2, TOP - 3, PZ, x + 2, TOP - 3, PZ + 3, C.civMarble);
    if (k < 8) g.box(x + 2, yb + 9, Z0 - 1, x + 3, TOP - 6, Z0 - 1, banners[k % 4]);   // hanging banners
  }
  g.box(P0 - 1, TOP - 2, PZ - 1, P1 + 1, TOP + 1, Z0 - 1, trim);         // entablature
  g.box(P0 - 1, TOP - 1, PZ - 2, P1 + 1, TOP - 1, PZ - 2, C.civMarble);
  for (let x = P0 + 1; x <= P1 - 1; x += 3) if (x < 37 || x > 58) g.set(x, TOP, PZ - 2, C.gold);   // frieze studs
  // (r7) MUSEUM name plate on the entablature, res-8 lettering (the old res-4
  // billboard on the back read as a toy sign)
  facade(g, 'front', PZ - 1).box(37, TOP - 2, 1, 58, TOP, 1, C.civNavy);
  hiText(g, 'front', PZ - 1, 47.5, TOP - 1.75, 'MUSEUM', C.gold, 1);
  // (r9) fine pediment + gable roof: 1-fine steps, a raking cornice proud
  // of the tympanum, a gold relief group, a fine slate roof running back
  { const Hm = hiGrid(g), PY0 = 2 * (TOP + 2), ZF = 2 * PZ - 2, ZB = 2 * (Z0 + 12) + 1;
    Hm.box(2 * (P0 - 1), PY0, ZF - 2, 2 * (P1 + 1) + 1, PY0 + 1, ZB, trim);
    for (let k = 2; k < 42; k++) {
      const a = 2 * (P0 - 1) + 2 * (k - 2), b = 2 * (P1 + 1) + 1 - 2 * (k - 2), yy = PY0 + k;
      if (a > b) break;
      Hm.box(a, yy, ZF, b, yy, ZB - 1, C.roofGray);
      Hm.box(a, yy, ZB, b, yy, ZB, wall);
      Hm.box(a, yy, ZF - 2, Math.min(b, a + 3), yy, ZF - 1, trim); Hm.box(Math.max(a, b - 3), yy, ZF - 2, b, yy, ZF - 1, trim);
      if (a + 4 <= b - 4) Hm.box(a + 4, yy, ZF, b - 4, yy, ZF, C.civMarble);
    }
    const mx = P0 + P1 + 1, my = PY0 + 11;                            // a gold medallion + laurel
    for (let i = -7; i <= 7; i++) for (let j = -7; j <= 7; j++) {
      const d = Math.hypot(i + 0.5, j + 0.5);
      if (d < 3.2 || (d >= 4.6 && d < 6.2)) Hm.set(mx + i, my + j, ZF - 1, C.gold);
    }
    for (let i = 8; i <= 20; i += 3) for (const sgn of [-1, 1]) Hm.box(mx + sgn * i - (sgn < 0 ? 1 : 0), PY0 + 3, ZF - 1, mx + sgn * i - (sgn < 0 ? 1 : 0), PY0 + 3 + Math.max(1, 5 - ((i - 8) >> 2)), ZF - 1, C.gold);
  }
  const D = facade(g, 'front', Z0);
  door(D, 44, yb, 7, 14, { color: C.woodDark, frame: C.gold, double: true, step: null });
  // rear entrance: doors, canopy on two columns, lamps, planters
  door(Bk, 44, yb, 7, 11, { color: C.woodDark, frame: trim, double: true, step: null, canopy: trim });
  for (const u of [41, 53]) Bk.box(u, yb, 1, u + 1, yb + 12, 2, trim);
  wallLamp(Bk, 39, yb + 9); wallLamp(Bk, 56, yb + 9);
  signPanel(Bk, 38, 57, yb + 15, yb + 19, C.civNavy, { border: C.gold });
  hiText(g, 'back', Z1, 47.5, yb + 16.25, 'MUSEUM', C.gold, 1);
  planter(g, 20, 59, 36, 61, y, { box: C.civPanel, flowers: [C.red, C.yellow, C.signWhite] });
  planter(g, 58, 59, 74, 61, y, { box: C.civPanel, flowers: [C.red, C.yellow, C.signWhite] });
  // dome on a drum
  const dx = 47, dz = 40, TR = 12;
  for (let yy = TOP + 2; yy <= TOP + 8; yy++) ringH(g, dx, yy, dz, TR - 2, TR + 0.5, (x, z) => (yy >= TOP + 4 && yy <= TOP + 7 && mod(Math.round(Math.atan2(z - dz, x - dx) * 4), 2) === 0) ? C.civGlass : wall);
  ringH(g, dx, TOP + 9, dz, 0, TR + 1.5, trim);
  // (r9) a smooth fine dome with ribs and an open lantern (the res-4 dome
  // read as a lumpy gold blob)
  { const Hm = hiGrid(g), top = fineDome(g, dx, dz, TOP + 10, TR, domeC, trim, 8), X = 2 * dx + 1, Z = 2 * dz + 1;
    Hm.box(X - 3, top - 1, Z - 3, X + 2, top, Z + 2, trim);
    for (const [ax, az] of [[-3, -3], [2, -3], [-3, 2], [2, 2]]) Hm.box(X + ax, top + 1, Z + az, X + ax, top + 5, Z + az, trim);
    Hm.box(X - 1, top + 1, Z - 1, X, top + 4, Z, C.civGlass);
    Hm.box(X - 4, top + 6, Z - 4, X + 3, top + 6, Z + 3, trim); Hm.box(X - 2, top + 7, Z - 2, X + 1, top + 8, Z + 1, domeC);
    Hm.box(X - 1, top + 9, Z - 1, X, top + 12, Z, C.gold); }
  // roof gear
  acBox(g, 14, TOP + 2, 46, { w: 6, d: 5, h: 4 }); acBox(g, 72, TOP + 2, 46, { w: 6, d: 5, h: 4 });
  solarPanel(g, 70, 24, 80, 32, TOP + 2);
  // lawn with a dinosaur (T-rex statue) + planters, lamps, banners on poles
  g.box(2, y - 1, 2, 22, y - 1, 12, C.lotGrass);
  g.box(72, y - 1, 2, 92, y - 1, 12, C.lotGrass);
  const rx = 76, rz = 6, dc = C.roofGreen;
  g.box(rx, y, rz, rx + 1, y + 6, rz + 1, dc); g.box(rx + 5, y, rz, rx + 6, y + 6, rz + 1, dc);   // legs
  g.box(rx - 1, y + 7, rz - 1, rx + 8, y + 12, rz + 2, dc);                                       // body
  g.box(rx + 8, y + 11, rz - 1, rx + 10, y + 17, rz + 2, dc);                                     // neck
  g.box(rx + 9, y + 15, rz - 1, rx + 14, y + 19, rz + 2, dc);                                     // head
  g.set(rx + 12, y + 18, rz - 2, C.black); g.set(rx + 12, y + 18, rz + 3, C.black);
  g.box(rx + 11, y + 15, rz - 1, rx + 14, y + 15, rz + 2, C.signWhite);
  for (let i = 0; i < 9; i++) g.box(rx - 2 - i, y + 10 - (i >> 1), rz, rx - 2 - i, y + 11 - (i >> 1), rz + 1, dc); // tail
  g.box(rx + 8, y + 9, rz - 1, rx + 9, y + 9, rz - 1, dc); g.box(rx + 8, y + 9, rz + 2, rx + 9, y + 9, rz + 2, dc);
  tree(g, 8, y, 7, { w: 9, h: 8, trunk: 6 }); tree(g, 88, y, 56, { w: 9, h: 8, trunk: 6 }); tree(g, 5, y, 56, { w: 9, h: 8, trunk: 6 });
  bush(g, 14, y, 3, 22, 5, 3, { flowers: [C.red, C.yellow] });
  for (const lx of [24, 70]) lampPost(g, lx, y, 4, 12, { small: true });
  for (const [bx, c] of [[30, banners[0]], [64, banners[1]]]) { g.box(bx, y, 3, bx, y + 22, 3, C.darkGray); g.box(bx + 1, y + 12, 3, bx + 3, y + 21, 3, c); }
  crowd(g, [[2, 1, 92, 12], [24, 13, 70, 14], [2, 58, 92, 61]], y, 34, 17 + vi);
  return doneHi(g);
}

// ---- CARNIVAL GAMES (2×1): three booths, prize shelves, high striker --------
function bCarnival(rng, v) {
  const SX = 63, SZ = 31, g = grid(SX, 64, SZ, R4);
  const y = lotPlinth(g, 0, 0, SX - 1, SZ - 1, { fill: C.civPlaza });
  const vi = mod(v, 2);
  const cols = vi ? [C.purple, C.civSeat, C.orange] : [C.red, C.civSeat, C.roofGreen];
  const toys = [C.pink, C.yellow, C.civSeat, C.roofGreen, C.orange, C.purple, C.red];
  for (let b = 0; b < 3; b++) {
    const x0 = 14 + b * 16, x1 = x0 + 14, c = cols[b], z0 = 12, z1 = 27;
    g.walls(x0, y, z0, x1, y + 14, z1, c);
    for (let x = x0 + 1; x < x1; x++) for (let yy = y + 5; yy <= y + 13; yy++) g.del(x, yy, z0);
    g.box(x0 + 1, y, z0, x1 - 1, y + 4, z0, C.signWhite);               // counter
    g.box(x0 + 1, y + 5, z0 - 1, x1 - 1, y + 5, z0, C.wood);
    g.box(x0 + 1, y, z0 + 1, x1 - 1, y, z1 - 1, C.plank);
    // prize shelves on the back wall with plushies
    for (const sy of [y + 6, y + 10]) {
      g.box(x0 + 1, sy, z1 - 2, x1 - 1, sy, z1 - 1, C.wood);
      for (let x = x0 + 2; x < x1 - 1; x += 3) g.box(x, sy + 1, z1 - 2, x + 1, sy + 2, z1 - 2, toys[(x + sy + b) % toys.length]);
    }
    // game props on the counter
    if (b === 0) for (let x = x0 + 3; x < x1 - 1; x += 3) { g.box(x, y + 6, z0 + 1, x, y + 8, z0 + 1, C.roofGreen); g.set(x, y + 9, z0 + 1, C.signWhite); }
    if (b === 1) for (let x = x0 + 2; x < x1 - 1; x += 2) g.set(x, y + 12, z1 - 3, toys[x % toys.length]);
    if (b === 2) { g.box(x0 + 2, y + 5, z0 + 1, x1 - 2, y + 5, z0 + 3, C.civPool); for (let x = x0 + 3; x < x1 - 2; x += 3) g.box(x, y + 6, z0 + 2, x + 1, y + 6, z0 + 2, C.yellow); }
    // striped awning + roof + bulb string
    const F = facade(g, 'front', z0);
    awning(F, x0, x1, y + 16, 3, { colors: [c, C.signWhite], stripe: 2 });
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) g.set(x, y + 15, z, ((x - x0) >> 1) & 1 ? c : C.signWhite);
    for (let t = 0; t < 4; t++) for (let x = x0 + t; x <= x1 - t; x++) g.box(x, y + 16 + t, z0 + 2, x, y + 16 + t, z1, ((x - x0) >> 1) & 1 ? C.signWhite : c);
    for (let x = x0; x <= x1; x += 2) g.set(x, y + 14, z0 - 1, C.lamp);
    // little two-sided sign on the roof ridge
    g.box(x0 + 3, y + 20, z0 + 8, x1 - 3, y + 24, z0 + 8, C.signWhite);
    g.box(x0 + 4, y + 21, z0 + 7, x1 - 4, y + 23, z0 + 7, c);
    g.box(x0 + 4, y + 21, z0 + 9, x1 - 4, y + 23, z0 + 9, c);
    // back + side walls: painted circus stripes, a stage door, bulbs on the eave
    for (let x = x0; x <= x1; x++) if (((x - x0) >> 1) & 1) g.box(x, y + 2, z1, x, y + 13, z1, C.signWhite);
    for (let z = z0 + 1; z < z1; z++) if (((z - z0) >> 1) & 1) { g.box(x0, y + 2, z, x0, y + 13, z, C.signWhite); g.box(x1, y + 2, z, x1, y + 13, z, C.signWhite); }
    g.box(x0 + 5, y, z1, x1 - 5, y + 1, z1, C.darkGray);
    g.box(x0 + 6, y + 2, z1 + 1, x1 - 6, y + 8, z1 + 1, C.woodDark); g.box(x0 + 6, y + 9, z1 + 1, x1 - 6, y + 9, z1 + 1, C.gold);
    for (let x = x0; x <= x1; x += 2) g.set(x, y + 14, z1 + 1, C.lamp);
    g.box(x0, y, z0, x1, y + 1, z0, c);
  }
  // high striker on the left: base pad, tall scale column, bell
  g.box(2, y, 16, 10, y + 1, 24, C.wood);
  g.box(5, y + 2, 20, 7, y + 3, 22, C.darkGray);
  for (let yy = y + 2; yy <= y + 44; yy++) g.box(5, yy, 23, 7, yy, 24, ((yy - y) >> 2) & 1 ? C.red : C.signWhite);
  g.box(4, y + 45, 22, 8, y + 47, 25, C.gold);
  g.box(6, y + 20, 22, 6, y + 21, 22, C.yellow);
  g.box(3, y + 2, 18, 3, y + 8, 18, C.woodDark); g.box(2, y + 8, 17, 4, y + 9, 19, C.metalDark); // mallet
  // entrance arch with GAMES + bulbs
  for (const px of [2, 11]) g.box(px, y, 3, px + 1, y + 26, 4, C.gold);
  g.box(1, y + 27, 3, 13, y + 33, 4, C.red);
  const Fa = facade(g, 'front', 3);
  for (let x = 1; x <= 13; x += 2) { g.set(x, y + 33, 2, C.lamp); g.set(x, y + 27, 2, C.lamp); }
  pixelText(Fa, 3, y + 28, 'FUN', C.yellow, 1);
  pixelText(facade(g, 'back', 4), 11, y + 28, 'FUN', C.yellow, 1);
  balloons(g, 32, y, 4, [C.red, C.yellow, C.civSeat, C.pink]);
  bin(g, 58, y, 4);
  for (const lx of [22, 50]) lampPost(g, lx, y, 5, 10, { small: true });
  crowd(g, [[1, 1, 62, 11]], y, 18, 31 + vi);
  return doneHi(g);
}

// =============================================================================
// DECO (1×1 charm, cap 0) — props with no lot; fronts toward min-Z.
// People scale (critic r2: our benches were nearly car-sized): at res 4 a
// person is 3 voxels tall and a lot car 4 × 4 × 9, so a bench seat is ~5
// long, a fence ~5 tall, a streetlight ~16.
// =============================================================================
function dFlowerBed(rng, v) {
  // Low stone kerb, dark soil, chunky 3×3 flower clumps round a clipped shrub.
  const g = grid(25, 8, 25, R4);
  const vi = mod(v, 4);
  const edge = [C.lotRim, C.brick, C.civMarble, C.stone][vi];
  const sets = [[C.red, C.yellow, C.signWhite], [C.pink, C.purple, C.signWhite], [C.civSeat, C.yellow, C.orange], [C.red, C.pink, C.yellow]][vi];
  g.walls(0, 0, 0, 24, 1, 24, edge);
  g.box(1, 0, 1, 23, 0, 23, C.dirtDark);
  g.box(9, 1, 9, 15, 3, 15, V.bush); g.box(9, 1, 9, 15, 1, 15, V.bushDark); g.box(10, 4, 10, 14, 4, 14, V.bush);
  fineBlooms(g, 10, 10, 14, 14, 5, sets, 3);                        // (r9) fine blooms
  let k = 0;
  for (let x = 2; x <= 19; x += 4) for (let z = 2; z <= 19; z += 4) {
    if (x >= 6 && x <= 15 && z >= 6 && z <= 15) continue;
    const c = sets[k++ % 3];
    g.box(x, 1, z, x + 2, 1, z + 2, V.bush);
    fineBlooms(g, x, z, x + 2, z + 2, 2, [c, c, C.signWhite], 2);
  }
  return doneHi(g);
}
function dBench(rng, v) {
  // (civic r7) a pocket plaza instead of one bench on a tiny pad (the r6
  // gallery read it as "a bench on a whole empty lawn"): a paved square with
  // a light kerb, two people-scale benches facing each other across a planter
  // bed, a park lamp, a bin, and a little tree or flower urns per variant.
  const g = grid(23, 16, 17, R4);
  const vi = mod(v, 3);
  const wood = [C.wood, C.plank, C.civSeat][vi], iron = [C.darkGray, C.roofGreen, C.darkGray][vi];
  const pave = [C.lotPave, C.sand, C.lotPave][vi];
  g.box(0, 0, 0, 22, 0, 16, pave); g.walls(0, 0, 0, 22, 0, 16, C.lotRim);
  for (let x = 2; x <= 20; x += 6) g.box(x, 0, 1, x, 0, 15, C.lotPaveDark);          // paving joints
  // centre bed: low kerb, clipped shrubs and flowers
  g.walls(7, 1, 6, 15, 1, 10, C.lotRim); g.box(8, 1, 7, 14, 1, 9, C.dirtDark);
  g.box(8, 2, 7, 14, 2, 9, V.bush); g.box(9, 3, 8, 13, 3, 8, V.bush);
  for (const [fx, c] of [[8, C.red], [10, C.yellow], [12, C.signWhite], [14, C.pink]]) g.set(fx, 3, fx & 2 ? 7 : 9, c);
  // two benches facing the bed (5-voxel seats, backs outward)
  const benchAt = (x0, z0, back) => {
    for (const x of [x0, x0 + 4]) { g.set(x, 1, z0, iron); g.set(x, 1, z0 + back, iron); g.set(x, 2, z0 + back, iron); g.set(x, 3, z0 + back, iron); }
    g.box(x0, 2, z0, x0 + 4, 2, z0 + back, wood);
    g.box(x0, 3, z0 + back, x0 + 4, 4, z0 + back, wood);
  };
  benchAt(9, 3, -1); benchAt(9, 13, 1);
  // lamp, bin, corner feature
  g.set(3, 1, 3, iron); g.box(3, 2, 3, 3, 11, 3, iron); g.box(2, 12, 3, 4, 12, 3, iron); g.set(2, 11, 3, C.lamp); g.set(4, 11, 3, C.lamp);
  g.box(19, 1, 13, 20, 2, 14, C.roofGreen); g.box(19, 3, 13, 20, 3, 14, C.darkGray);
  if (vi === 0) { tree(g, 19, 1, 3, { w: 5, h: 5, trunk: 5, tier: false }); }
  else if (vi === 1) { for (const [ux, uz] of [[19, 3], [3, 13]]) { g.box(ux - 1, 1, uz - 1, ux + 1, 2, uz + 1, C.civMarble); g.box(ux - 1, 3, uz - 1, ux + 1, 3, uz + 1, V.bush); g.set(ux, 4, uz, C.pink); } }
  else { g.box(18, 1, 2, 20, 1, 4, C.civMarble); g.box(19, 2, 3, 19, 3, 3, C.civMarble); g.box(18, 4, 2, 20, 4, 4, C.civPool); g.set(19, 5, 3, C.civPoolLt); }
  return doneHi(g);
}
function dFence(rng, v) {
  const g = grid(31, 8, 3, R4);
  const vi = mod(v, 3);
  if (vi === 0) {                                            // white picket
    for (let x = 0; x < 31; x += 3) { g.box(x, 0, 1, x, 4, 1, C.signWhite); g.set(x, 5, 1, C.signWhite); }
    g.box(0, 1, 2, 30, 1, 2, C.signWhite); g.box(0, 3, 2, 30, 3, 2, C.signWhite);
  } else if (vi === 1) {                                     // ranch rail
    for (const x of [0, 10, 20, 30]) g.box(x, 0, 1, x, 5, 1, C.woodDark);
    for (const yy of [2, 4]) g.box(0, yy, 1, 30, yy, 1, C.wood);
  } else {                                                   // iron with gold tips
    for (let x = 0; x < 31; x += 2) { g.box(x, 0, 1, x, 5, 1, C.darkGray); g.set(x, 6, 1, C.gold); }
    g.box(0, 1, 1, 30, 1, 1, C.darkGray); g.box(0, 5, 1, 30, 5, 1, C.darkGray);
    for (const x of [0, 30]) g.box(x, 0, 0, x, 6, 2, C.darkGray);
  }
  return doneHi(g);
}
function dHedge(rng, v) {
  // Clipped hedge ~1.2 units tall: dark foot band, lumpy crown, pixel dots.
  const g = grid(31, 10, 7, R4);
  const vi = mod(v, 3);
  bush(g, 0, 0, 1, 30, 5, 5);
  g.box(0, 0, 1, 30, 0, 5, V.bushDark);
  for (let x = 0; x < 31; x += 6) g.box(x + 1, 5, 2, x + 4, 5, 4, V.bush);         // lumpy crown
  for (let x = 3; x < 31; x += 6) g.box(x + 1, 2, 0, x + 2, 3, 0, V.bush);         // bulges on the faces
  for (let x = 0; x < 31; x += 6) g.box(x + 2, 2, 6, x + 3, 3, 6, V.bush);
  g.set(4, 3, 1, V.leafDot); g.set(17, 2, 1, V.leafDot); g.set(25, 3, 1, V.leafDot); g.set(10, 3, 5, V.leafDot);
  if (vi === 1) fineBlooms(g, 0, 1, 30, 5, 5, [C.pink, C.signWhite, C.red], 3);
  if (vi === 2) for (const x of [4, 15, 26]) { g.box(x - 2, 6, 2, x + 2, 7, 4, V.bush); g.box(x - 1, 8, 2, x + 1, 9, 4, V.bush); }
  return doneHi(g);
}
function dStreetlight(rng, v) {
  // (w2r1) A lamp corner, not a lone pole on the grass: a round paved pad
  // with a light kerb, a clipped flower ring, and an ornate park lamp on a
  // stepped plinth — v0 twin lanterns on a scrolled crossbar, v1 a
  // four-lantern cluster, v2 a tall single lantern carrying two banners —
  // plus a bench and a bin at the pad's edge. Fine (res-8) lanterns + pole.
  const G = grid(23, 24, 23, R4);
  const vi = mod(v, 3), c = 11;
  disc(G, c, 0, c, 10.6, C.lotRim); disc(G, c, 0, c, 9.6, C.lotPave);
  for (let x = 1; x < 22; x += 5) for (let z = 1; z < 22; z++) if (Math.hypot(x - c, z - c) < 9.4) G.set(x, 0, z, C.lotPaveDark);
  // flower ring round the lamp
  for (let a = 0; a < 28; a++) {
    const t = a / 28 * Math.PI * 2, fx = Math.round(c + Math.cos(t) * 4.2), fz = Math.round(c + Math.sin(t) * 4.2);
    G.set(fx, 1, fz, V.bush);
  }
  disc(G, c, 1, c, 3.3, C.dirtDark);
  fineBlooms(G, c - 3, c - 3, c + 3, c + 3, 2, [C.red, C.yellow, C.signWhite, C.pink], 2);
  const pole = [C.darkGray, C.roofGreen, C.civNavy][vi];
  // stepped plinth
  G.box(c - 1, 1, c - 1, c + 1, 2, c + 1, C.civMarble); G.box(c - 1, 3, c - 1, c + 1, 3, c + 1, C.signWhite);
  const H = hiGrid(G), X = 2 * c, Z = 2 * c;                         // fine lamp: centre cells X..X+1
  const top = vi === 2 ? 44 : 38;
  H.box(X - 1, 8, Z - 1, X + 2, 11, Z + 2, pole);                   // base collar
  H.box(X, 12, Z, X + 1, top, Z + 1, pole);                          // shaft
  H.box(X - 1, 20, Z - 1, X + 2, 20, Z + 2, pole);                   // ring
  const lantern = (lx, ly, lz) => {
    H.box(lx - 1, ly, lz - 1, lx + 2, ly, lz + 2, pole);
    H.box(lx - 1, ly + 1, lz - 1, lx + 2, ly + 3, lz + 2, C.lamp);
    H.box(lx - 1, ly + 4, lz - 1, lx + 2, ly + 4, lz + 2, pole); H.box(lx, ly + 5, lz, lx + 1, ly + 5, lz + 1, pole);
  };
  if (vi === 0) {
    H.box(X - 6, top - 3, Z, X + 7, top - 3, Z + 1, pole);          // crossbar
    H.set(X - 5, top - 4, Z, pole); H.set(X + 6, top - 4, Z, pole); // scrolls
    lantern(X - 6, top - 9, Z); lantern(X + 6, top - 9, Z);
    for (const lx of [X - 6, X + 7]) H.box(lx, top - 4, Z, lx, top - 4, Z + 1, pole);
    H.box(X, top + 1, Z, X + 1, top + 2, Z + 1, C.gold);
  } else if (vi === 1) {
    for (const [dx, dz] of [[-5, 0], [5, 0], [0, -5], [0, 5]]) {
      H.box(Math.min(X, X + dx), top - 2, Math.min(Z, Z + dz), Math.max(X + 1, X + 1 + dx), top - 2, Math.max(Z + 1, Z + 1 + dz), pole);
      lantern(X + dx, top - 1, Z + dz);
    }
    lantern(X, top + 1, Z);
  } else {
    lantern(X, top + 1, Z);
    for (const [dz, col] of [[-1, C.red], [2, C.civSeat]]) {
      H.box(X, top - 3, Z + dz, X + 1, top - 3, Z + dz + (dz < 0 ? -5 : 5) , pole);
      const z0 = dz < 0 ? Z + dz - 5 : Z + dz + 1, z1 = dz < 0 ? Z + dz - 1 : Z + dz + 5;
      H.box(X, top - 12, Math.min(z0, z1), X + 1, top - 4, Math.max(z0, z1), col);
      H.box(X, top - 8, Math.min(z0, z1), X + 1, top - 8, Math.max(z0, z1), C.signWhite);
    }
  }
  // bench + bin on the pad edge (away from the lens corner)
  benchS(G, 6, 1, 17, 'x', 5, { seat: C.wood });
  G.box(17, 1, 17, 18, 2, 18, C.roofGreen); G.box(17, 3, 17, 18, 3, 18, C.darkGray);
  return doneHi(G);
}
function dStatue(rng, v) {
  // ref05 memorial in miniature (critic r4: "a thin white column on a small
  // ring of hedge"): a square paved plaza, a three-tier marble terrace with a
  // stair cut into every side, reflecting pools in two corners, bronze groups
  // on the lower tier's corners and the monument on a tall pedestal —
  // v0 hero figure, v1 obelisk, v2 victory column.
  const vi = mod(v, 3);
  const g = grid(31, 60, 31, R4);
  const cx = 15, cz = 15, mb = C.civMarble, mbDk = C.civPanel, bz = vi === 0 ? C.civBronze : C.gold;
  g.box(0, 0, 0, 30, 0, 30, C.civPlaza); g.walls(0, 0, 0, 30, 0, 30, C.lotRim);
  for (let x = 1; x < 30; x += 6) g.box(x, 0, 1, x, 0, 29, C.lotPave);
  for (const [a, b, h0] of [[4, 26, 1], [7, 23, 3], [10, 20, 5]]) {
    g.box(a, h0, a, b, h0 + 1, b, mb);
    g.walls(a, h0, a, b, h0, b, mbDk);
    g.walls(a, h0 + 1, a, b, h0 + 1, b, C.signWhite);
  }
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) for (let r = 5; r <= 11; r++) {
    const top = 1 + (11 - r) - 1;
    for (let w = -2; w <= 2; w++) {
      const x = cx + dx * r + (dz ? w : 0), z = cz + dz * r + (dx ? w : 0);
      gclr(g, x, top + 1, z, x, 7, z); g.box(x, 1, z, x, top, z, ((11 - r) & 1) ? mb : C.signWhite);
    }
  }
  // reflecting pools in the front-left and back-right corners, hedge cubes in the others
  for (const [x0, z0] of [[1, 1], [22, 22]]) { g.walls(x0, 1, z0, x0 + 7, 1, z0 + 7, C.signWhite); g.box(x0 + 1, 0, z0 + 1, x0 + 6, 0, z0 + 6, C.civPool); g.box(x0 + 1, 0, z0 + 1, x0 + 6, 0, z0 + 1, C.civPoolLt); g.set(x0 + 4, 1, z0 + 4, C.civPoolLt); g.set(x0 + 4, 2, z0 + 4, C.signWhite); }
  for (const [x0, z0] of [[1, 24], [24, 1]]) { bush(g, x0, 1, z0, x0 + 5, z0 + 5, 4); bush(g, x0 + 1, 5, z0 + 1, x0 + 4, z0 + 4, 1); }
  // bronze groups on the lower tier's corners
  for (const [sx, sz] of [[6, 6], [24, 6], [6, 24], [24, 24]]) {
    g.box(sx - 1, 3, sz - 1, sx + 1, 4, sz + 1, mb);
    fineStatue(hiGrid(g), 2 * sx + 1, 10, 2 * sz + 1, C.signWhite);   // (r9) fine white figure (bronze read as green cacti)
  }
  // pedestal with cornices + plaques on all four faces
  const P = 7;
  g.box(12, P, 12, 18, P, 18, mbDk); g.box(13, P + 1, 13, 17, P + 7, 17, mb); g.box(12, P + 8, 12, 18, P + 8, 18, mb);
  g.box(14, P + 3, 12, 16, P + 5, 12, C.civBronze); g.box(14, P + 3, 18, 16, P + 5, 18, C.civBronze);
  g.box(12, P + 3, 14, 12, P + 5, 16, C.civBronze); g.box(18, P + 3, 14, 18, P + 5, 16, C.civBronze);
  const T = P + 9;
  if (vi === 1) {                                                       // obelisk + gilt tip
    for (let yy = T; yy < T + 30; yy++) { const i = yy < T + 16 ? 0 : 1; g.box(13 + i, yy, 13 + i, 17 - i, yy, 17 - i, mb); }
    g.box(14, T + 30, 14, 16, T + 31, 16, mb); g.set(15, T + 32, 15, C.gold);
    g.walls(13, T, 13, 17, T, 17, mbDk);
  } else if (vi === 0) {                                                // hero figure, arm raised
    g.box(14, T, 14, 14, T + 4, 15, bz); g.box(16, T, 14, 16, T + 4, 15, bz);
    g.box(13, T + 5, 13, 17, T + 10, 16, bz);
    g.box(15, T + 11, 14, 15, T + 13, 15, bz); g.box(14, T + 12, 14, 16, T + 13, 15, bz);
    g.box(18, T + 9, 14, 18, T + 16, 15, bz); g.box(12, T + 5, 14, 12, T + 9, 15, bz);
    g.set(18, T + 17, 14, C.gold);
  } else {                                                              // victory column + gilded figure
    for (let yy = T; yy < T + 24; yy++) g.box(14, yy, 14, 16, yy, 16, (yy % 5 === 0) ? mbDk : mb);
    g.box(13, T + 24, 13, 17, T + 24, 17, mb);
    g.box(15, T + 25, 15, 15, T + 29, 15, bz); g.box(14, T + 26, 15, 16, T + 28, 15, bz);
    g.box(13, T + 28, 15, 13, T + 29, 15, bz); g.box(17, T + 28, 15, 17, T + 29, 15, bz);
  }
  for (const [lx, lz] of [[10, 2], [20, 2], [10, 28], [20, 28]]) { g.box(lx, 1, lz, lx, 2, lz, C.darkGray); g.set(lx, 3, lz, C.lamp); }
  return doneHi(g);
}
function dStonePath(rng, v) {
  const vi = mod(v, 3);
  const g = grid(31, 2, 31, R4);
  if (vi === 0) {                                            // square pavers with grout
    g.box(0, 0, 0, 30, 0, 30, C.lotPaveDark);
    for (let x = 0; x < 31; x += 8) for (let z = 0; z < 31; z += 8) g.box(x, 1, z, Math.min(30, x + 6), 1, Math.min(30, z + 6), C.lotPave);
  } else if (vi === 1) {                                     // stepping stones
    for (const [x, z, w] of [[8, 2, 6], [18, 8, 7], [9, 15, 6], [18, 22, 6], [10, 26, 5]]) { g.box(x, 0, z, x + w - 1, 0, z + w - 2, V.rock); g.box(x + 1, 1, z, x + w - 2, 1, z + w - 3, V.rockLight); }
  } else {                                                   // brick walk with kerbs
    g.box(9, 0, 0, 21, 0, 30, C.brick);
    for (let z = 1; z < 31; z += 4) g.box(10, 1, z, 20, 1, z + 2, C.civBrick);
    g.box(8, 0, 0, 8, 1, 30, C.lotRim); g.box(22, 0, 0, 22, 1, 30, C.lotRim);
  }
  return doneHi(g);
}
function dPicnicTable(rng, v) {
  // Gravel pad with a people-scale picnic table (7 long, top 3 up).
  const vi = mod(v, 3);
  const g = grid(15, vi === 2 ? 14 : 6, 13, R4);
  const w = [C.wood, C.plank, C.woodDark][vi];
  g.box(0, 0, 0, 14, 0, 12, C.sand); g.walls(0, 0, 0, 14, 0, 12, C.sandDark);
  for (const x of [4, 10]) { g.box(x, 1, 5, x, 2, 5, w); g.box(x, 1, 7, x, 2, 7, w); g.box(x, 1, 3, x, 1, 9, w); }
  g.box(4, 3, 5, 10, 3, 7, vi === 1 ? C.red : w);                    // table top
  if (vi === 1) for (let x = 4; x <= 10; x += 2) g.set(x, 3, 6, C.signWhite);
  g.box(4, 2, 3, 10, 2, 3, w); g.box(4, 2, 9, 10, 2, 9, w);          // benches
  if (vi === 2) umbrella(g, 7, 4, 6, C.civSeat, C.signWhite, 5, 2);
  else { g.set(6, 4, 6, C.red); g.set(8, 4, 5, C.signWhite); }
  return doneHi(g);
}
function dMailbox(rng, v) {
  const vi = mod(v, 3);
  const g = grid(9, 10, 9, R4);
  g.box(0, 0, 0, 8, 0, 8, C.lotPave); g.walls(0, 0, 0, 8, 0, 8, C.lotRim);
  if (vi === 0) {                                            // blue street box on legs
    for (const [x, z] of [[3, 3], [5, 3], [3, 5], [5, 5]]) g.set(x, 1, z, C.darkGray);
    g.box(3, 2, 3, 5, 5, 5, C.civSeat); g.box(3, 6, 4, 5, 6, 5, C.civSeat);
    g.box(3, 5, 2, 5, 5, 2, C.darkGray); g.set(4, 3, 2, C.signWhite);
  } else if (vi === 1) {                                     // red pillar box
    g.box(3, 1, 3, 5, 6, 5, C.red); g.box(3, 7, 3, 5, 7, 5, C.red); g.set(4, 8, 4, C.red);
    g.box(3, 5, 2, 5, 5, 2, C.black); g.set(4, 3, 2, C.gold);
  } else {                                                   // country mailbox on a post
    g.box(4, 1, 4, 4, 4, 4, C.woodDark);
    g.box(3, 5, 2, 5, 6, 6, C.signWhite); g.box(4, 7, 2, 4, 7, 6, C.signWhite);
    g.box(6, 6, 4, 6, 8, 4, C.red); g.set(6, 8, 5, C.red);
  }
  g.box(7, 1, 1, 7, 2, 2, V.bush);
  return doneHi(g);
}
function dPond(rng, v) {
  const vi = mod(v, 3);
  const g = grid(29, 8, 29, R4);
  const cx = 14, cz = 14;
  for (let x = 0; x < 29; x++) for (let z = 0; z < 29; z++) {
    const a = Math.atan2(z - cz, x - cx), r = 11.5 + Math.sin(a * 3 + vi) * 1.5;
    const d = Math.hypot(x - cx, z - cz);
    if (d < r - 1.2) g.set(x, 0, z, C.civPool);
    else if (d < r + 1) { g.set(x, 0, z, V.rock); if (((x * 7 + z * 3) % 5) < 2) g.set(x, 1, z, V.rockLight); }
  }
  for (const [lx, lz] of [[9, 10], [17, 18], [19, 9]]) { g.box(lx, 0, lz, lx + 1, 0, lz + 1, C.leafMid); }
  g.set(17, 1, 18, C.pink);
  for (const [rx, rz] of [[5, 16], [6, 18], [22, 6], [23, 8]]) g.box(rx, 1, rz, rx, 4, rz, C.leafMid);
  g.set(5, 5, 16, C.trunk); g.set(22, 5, 6, C.trunk);
  if (vi !== 1) {                                            // duck
    const dc = vi === 0 ? C.signWhite : C.yellow;
    g.box(12, 1, 13, 14, 1, 14, dc); g.box(14, 2, 13, 14, 3, 13, dc); g.set(15, 3, 13, C.orange); g.set(13, 2, 13, dc);
  } else {                                                   // little spout
    g.box(14, 0, 14, 14, 2, 14, V.rock); g.set(14, 3, 14, C.civPoolLt); g.set(14, 4, 14, C.signWhite);
  }
  return doneHi(g);
}
function dFlagPole(rng, v) {
  const vi = mod(v, 4);
  const g = grid(17, 34, 7, R4);
  g.box(0, 0, 0, 6, 0, 6, C.civPanel); g.box(1, 1, 1, 5, 1, 5, C.civMarble);
  g.box(3, 2, 3, 3, 31, 3, C.signWhite); g.set(3, 32, 3, C.gold);
  const W = 11, H = 7, fx = 4, fy = 24;
  for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
    let c;
    if (vi === 0) c = (j >> 1) & 1 ? C.signWhite : C.red;                                // stripes
    else if (vi === 1) c = C.civSeat;                                                   // blue + star
    else if (vi === 2) c = [C.red, C.orange, C.yellow, C.roofGreen, C.civSeat, C.purple][Math.floor(j * 6 / H)]; // rainbow
    else c = i < 4 ? C.roofGreen : i < 8 ? C.signWhite : C.orange;                      // tricolour
    g.set(fx + i, fy + H - 1 - j - ((i >> 2) & 1), 3, c);
  }
  if (vi === 1) for (const [a, b] of [[5, 3], [4, 3], [6, 3], [5, 2], [5, 4]]) g.set(fx + a, fy + b - ((a >> 2) & 1), 3, C.signWhite);
  return doneHi(g);
}

// =============================================================================
// animated part models (catalogAnim) — each part's pivot IS its model centre.
// =============================================================================
function _ferrisSpinner() {                       // big wheel + gondolas, X/Y plane, spins about Z
  const R = 64, S = 2 * R + 1, D = 11, c = R;
  const g = grid(S, S, D, R4);
  const cols = [C.red, C.civSeat, C.yellow, C.roofGreen, C.orange, C.teal, C.pink, C.purple];
  const ringV = (plane, r0, r1, col) => {
    for (let x = 0; x < S; x++) for (let yy = 0; yy < S; yy++) {
      const d = Math.hypot(x - c, yy - c);
      if (d >= r0 && d < r1) g.set(x, yy, plane, col);
    }
  };
  const N = 16;
  for (const plane of [1, 9]) {
    ringV(plane, 54.5, 57, C.signWhite);
    ringV(plane, 37.5, 39, C.civPanel);
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2;
      for (let r = 5; r <= 55; r++) g.set(Math.round(c + Math.cos(a) * r), Math.round(c + Math.sin(a) * r), plane, C.civPanel);
    }
  }
  for (let i = 0; i < 32; i++) {                                 // rim lights on the outer faces
    const a = i / 32 * Math.PI * 2, x = Math.round(c + Math.cos(a) * 56), yy = Math.round(c + Math.sin(a) * 56);
    g.set(x, yy, 0, C.lamp); g.set(x, yy, D - 1, C.lamp);
  }
  for (let i = 0; i < N; i++) {                                  // gondolas between the rims
    const a = (i + 0.5) / N * Math.PI * 2, gx = Math.round(c + Math.cos(a) * 59), gy = Math.round(c + Math.sin(a) * 59);
    const col = cols[i % cols.length];
    g.box(gx - 3, gy - 3, 2, gx + 3, gy + 3, 8, col);
    g.box(gx - 2, gy - 1, 2, gx + 2, gy + 1, 2, C.civGlass); g.box(gx - 2, gy - 1, 8, gx + 2, gy + 1, 8, C.civGlass);
    const ix = Math.round(c + Math.cos(a) * 55), iy = Math.round(c + Math.sin(a) * 55);
    g.box(ix, iy, 1, ix, iy, 9, C.metal);
  }
  for (let z = 0; z < D; z++) for (let x = c - 6; x <= c + 6; x++) for (let yy = c - 6; yy <= c + 6; yy++) {
    const d = Math.hypot(x - c, yy - c);
    if (d <= 6.3) g.set(x, yy, z, (z === 0 || z === D - 1) ? (d < 2.5 ? C.signWhite : C.gold) : C.metalDark);
  }
  return g.done();
}
function _carouselSpinner(vi = 0) {               // platform + horses + striped canopy, spins about Y
  const R = 26, S = 2 * R + 1, H = 50, c = R;
  const g = grid(S, H, S, R4);
  const canopyA = C.red, canopyB = C.signWhite;
  disc(g, c, 0, c, 24, C.plank);
  ringH(g, c, 0, c, 22.8, 24.9, C.gold);
  for (let yy = 1; yy <= 38; yy++) disc(g, c, yy, c, 4, ((yy / 4) | 0) & 1 ? C.gold : C.civGlass);
  const horseCols = [C.signWhite, C.pink, C.civSeat, C.yellow, C.signWhite, C.civPoolLt, C.orange, C.purple];
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2 + Math.PI / 8;
    const hx = Math.round(c + Math.cos(a) * 17), hz = Math.round(c + Math.sin(a) * 17);
    g.box(hx, 1, hz, hx, 38, hz, C.gold);
    const yb = 9 + (k & 1) * 4, col = horseCols[k];
    // horse body runs along the axis closest to the tangent
    const tx = Math.abs(Math.sin(a)) > Math.abs(Math.cos(a)) ? 1 : 0;
    const sgn = tx ? (Math.sin(a) > 0 ? -1 : 1) : (Math.cos(a) > 0 ? 1 : -1);
    const P = (u, yy, w, cc) => (tx ? g.set(hx + u * sgn, yy, hz + w, cc) : g.set(hx + w, yy, hz + u * sgn, cc));
    for (let u = -3; u <= 3; u++) for (let w = -1; w <= 1; w++) for (let yy = yb; yy <= yb + 3; yy++) P(u, yy, w, col);
    for (const u of [-3, 3]) for (const w of [-1, 1]) for (let yy = yb - 4; yy < yb; yy++) P(u, yy, w, col);
    for (let yy = yb + 3; yy <= yb + 6; yy++) for (let w = -1; w <= 1; w++) { P(3, yy, w, col); P(4, yy, w, col); }
    for (let w = -1; w <= 1; w++) { P(5, yb + 5, w, col); P(5, yb + 6, w, col); P(6, yb + 5, w, col); }
    P(2, yb + 5, 0, C.hairBrown); P(2, yb + 6, 0, C.hairBrown); P(3, yb + 7, 0, C.hairBrown);
    P(-4, yb + 2, 0, C.hairBrown); P(-4, yb + 1, 0, C.hairBrown);
    for (let u = -1; u <= 1; u++) for (let w = -1; w <= 1; w++) P(u, yb + 4, w, C.red);
    P(5, yb + 6, -1, C.black); P(5, yb + 6, 1, C.black);
  }
  // canopy: valance ring with lamps, then a striped cone
  const sector = (x, z) => mod(Math.floor((Math.atan2(z - c, x - c) + Math.PI) / (Math.PI * 2) * 12), 12);
  ringH(g, c, 38, c, 0, 25.9, (x, z) => (sector(x, z) & 1 ? canopyA : canopyB));
  for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) {
    const d = Math.hypot(x - c, z - c);
    if (d >= 24.5 && d < 25.9) g.set(x, 37, z, (x + z) % 4 === 0 ? C.lamp : (sector(x, z) & 1 ? canopyA : canopyB));
  }
  for (let k = 1; k <= 5; k++) {
    const r = 25.5 - k * 4.2;
    for (const dy of [0, 1]) ringH(g, c, 37 + 2 * k + dy, c, Math.max(0, r - 4.5), r, (x, z) => (sector(x, z) & 1 ? canopyA : canopyB));
  }
  g.box(c - 1, 48, c - 1, c + 1, 48, c + 1, C.gold); g.set(c, 49, c, C.gold);
  return g.done();
}

// ---------------------------------------------------------------------------
// Registry: catalog id -> builder (rng, variant, entry) => model. Merged by
// catalog.js; CATALOG metadata (name/emoji/footprint/cap) stays in catalog.js.
// ---------------------------------------------------------------------------
export const BUILDERS = {
  'stadium': bStadium,
  'playground': bPlayground, 'swimming-pool': bSwimmingPool,
  'ferris-wheel': bFerrisWheel, 'zoo': bZoo,
  'carousel': bCarousel, 'water-slide': bWaterSlide, 'mini-golf': bMiniGolf,
  'skate-park': bSkatePark, 'museum': bMuseum, 'carnival-games': bCarnival,
  // deco (1×1 charm)
  'flower-bed': dFlowerBed, 'bench': dBench, 'fence': dFence, 'hedge': dHedge,
  'streetlight': dStreetlight, 'statue': dStatue, 'stone-path': dStonePath,
  'picnic-table': dPicnicTable, 'mailbox': dMailbox, 'pond': dPond, 'flag-pole': dFlagPole,
};

// Animated parts: id -> () => { part, ox,oy,oz (WORLD units), ax,ay,az, speed }
// ferris: hub voxel y = FW_HUB on the base → centre (FW_HUB + 0.5) / 4 world.
// carousel: base platform top = 5 fine voxels (1.25 world); part 50 tall.
export const ANIMS = {
  'ferris-wheel': () => ({ part: _ferrisSpinner(), ox: 0, oy: (FW_HUB + 0.5) / R4, oz: 0, ax: 0, ay: 0, az: 1, speed: 0.3 }),
  'carousel': () => ({ part: _carouselSpinner(), ox: 0, oy: 1.25 + 50 / (2 * R4), oz: 0, ax: 0, ay: 1, az: 0, speed: 0.6 }),
};
