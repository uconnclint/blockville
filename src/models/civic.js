// Blockville models — CIVIC / SERVICES: serviceModel (park, school, fire, fountain,
// stadium, power) — backs the catalog park/school/fire-station/fountain entries —
// plus the fountain spray spinner part, and the shared civic+fun prop helpers
// (trees, bushes, lamps, cars, fire trucks, umbrellas, loungers, flags …) that
// fun.js reuses.
//
// Catalog buildings here are authored at res 4 (32 fine voxels per tile) in the
// Isometric City Voxel style (ART-DIRECTION.md): every model brings its own
// lotPlinth, the entrance faces min-Z (flipZ moves it to +Z), detail comes from
// geometry (frames, sills, cornices, rooftop gear, props on the lot) never from
// per-voxel noise.

import {
  C, grid, mulberry32, windowsOn, pk, facade, windowFramed, door, awning, signPanel,
  pixelText, wallLamp, wallAC, acBox, parapet, solarPanel, ventPipe, planter, bench,
  lotPlinth, pyramidRoof, flipZ, signLit,
} from './core.js';
import { miniTree, stampVeg } from './vegetation.js';
import { stampCar, stampPerson } from './vehicles.js';

// ---------------------------------------------------------------------------
// Shared palette picks (vegetation colours when that block exists, so our trees
// match the city's; safe fallbacks otherwise).
// ---------------------------------------------------------------------------
const pick = (...ks) => { for (const k of ks) if (C[k] != null) return C[k]; return C.leafMid; };
export const V = {
  leaf: pick('vegLeaf', 'lime'), leafBand: pick('vegLeafBand', 'leafMid'), leafDot: pick('vegLeafDot', 'leafDark'),
  // (w4r5) clipped hedges / bushes on civic & fun lots use the canopy's olive
  // band, not vegBush: vegBush rendered neon (124,255,81) beside ref05's olive
  // monument hedge (~130,170,30 lit / 40,58,18 shade).
  trunk: pick('vegTrunk', 'trunk'), bush: pick('vegLeafBand', 'leafMid'), bushDark: pick('leafDark', 'vegBushDark'),
  rock: pick('vegRock', 'stone'), rockLight: pick('vegRockLight', 'concrete'),
  stem: pick('vegStem', 'leafMid'),
  petals: [pick('vegPetalW', 'signWhite'), pick('vegPetalB', 'blue'), pick('vegPetalR', 'red'), C.yellow, C.pink],
};

// ---------------------------------------------------------------------------
// PROP HELPERS (res 4 fine voxels; author space: front = min-Z)
// ---------------------------------------------------------------------------

// Chunky cuboid tree centred on (x, z), standing on y. o: { w canopy width
// (odd, default 9), h canopy height, trunk height, tier (small top box) }
export function tree(g, x, y, z, o = {}) {
  const w = o.w || 9, h = o.h || w, th = o.trunk != null ? o.trunk : 5;
  const r = w >> 1;
  const leaf = o.leaf != null ? o.leaf : V.leaf, band = o.band != null ? o.band : V.leafBand;
  g.box(x - 1, y, z - 1, x, y + th + 1, z, V.trunk);                          // 2×2 trunk
  const y0 = y + th;
  g.box(x - r, y0, z - r, x + r - (w & 1 ? 0 : 1), y0 + h - 1, z + r - (w & 1 ? 0 : 1), leaf);
  g.box(x - r, y0, z - r, x + r - (w & 1 ? 0 : 1), y0 + 1, z + r - (w & 1 ? 0 : 1), band); // darker lower band
  if (o.tier !== false && w >= 7) {
    const r2 = r - 2;
    g.box(x - r2, y0 + h, z - r2, x + r2 - (w & 1 ? 0 : 1), y0 + h + 1, z + r2 - (w & 1 ? 0 : 1), leaf);
  }
  // a few darker "pixel" dots on the two faces the camera usually sees
  const d = V.leafDot;
  g.set(x - r, y0 + 3, z - 1, d); g.set(x - r, y0 + h - 3, z + 2, d);
  g.set(x + 1, y0 + 4, z - r, d); g.set(x - 2, y0 + h - 2, z - r, d);
  g.set(x + r - (w & 1 ? 0 : 1), y0 + 3, z + 1, d); g.set(x + 2, y0 + 3, z + r - (w & 1 ? 0 : 1), d);
}

// Cube bush / hedge block (inclusive box), darker bottom band.
export function bush(g, x0, y, z0, x1, z1, h, o = {}) {
  const c = o.c != null ? o.c : V.bush, dark = o.dark != null ? o.dark : V.bushDark;
  g.box(x0, y, z0, x1, y + h - 1, z1, c);
  g.box(x0, y, z0, x1, y, z1, dark);
  if (o.flowers) fineBlooms(g, x0, z0, x1, z1, y + h, o.flowers);   // (r9) fine blooms, not res-4 cubes
}
// (r9) Scatter fine (res-8) blooms over the res-4 rect x0..x1 × z0..z1 on
// res-4 row y (a bed or bush top): single fine petals on a staggered grid
// with a few two-voxel clumps, so beds read as flowers, not coloured crates.
export function fineBlooms(g, x0, z0, x1, z1, y, cols, step = 3) {
  const H = hiGrid(g), Y = 2 * y;
  let i = 0;
  for (let X = 2 * x0 + 1; X <= 2 * x1; X += step) for (let Z = 2 * z0 + 1 + ((X >> 1) % 2); Z <= 2 * z1; Z += step) {
    const c = cols[(i++ * 7 + (X ^ Z)) % cols.length];
    H.set(X, Y, Z, c);
    if (((X * 3 + Z) % 5) === 0) H.set(X, Y + 1, Z, c);
  }
}

// Little flower clump (stem + petal) at (x, z) on y.
export function flower(g, x, y, z, c) { g.set(x, y, z, V.stem); g.set(x, y + 1, z, c); }

// Street/park lamp: 3×3 foot, slim pole, cap + glowing lamp (202).
// o.small: a park lamp (1-voxel foot, lantern head) for lot dressing.
export function lampPost(g, x, y, z, h = 16, o = {}) {
  const pole = o.pole != null ? o.pole : C.darkGray;
  if (o.small) {
    g.set(x, y, z, pole); g.box(x, y + 1, z, x, y + h - 2, z, pole);
    g.set(x, y + h - 1, z, C.lamp); g.set(x, y + h, z, pole);
    return;
  }
  g.box(x - 1, y, z - 1, x + 1, y, z + 1, pole);
  g.box(x, y + 1, z, x, y + h - 2, z, pole);
  g.box(x - 1, y + h - 1, z - 1, x + 1, y + h - 1, z + 1, C.lamp);
  g.box(x - 1, y + h, z - 1, x + 1, y + h, z + 1, pole);
}

// Rubbish bin 2×2×3 (green body, dark lid).
export function bin(g, x, y, z) { g.box(x, y, z, x + 1, y + 1, z + 1, C.roofGreen); g.box(x, y + 2, z, x + 1, y + 2, z + 1, C.darkGray); }

// Fire hydrant (1×1×3, people scale).
export function hydrant(g, x, y, z) {
  g.box(x, y, z, x, y + 1, z, C.yellow); g.set(x, y + 2, z, C.gold);
}

// ---- busy-lot dressing (critic r4: our lots read as empty islands) ----------
// A visitor, people scale: legs, shirt, head (3 voxels).
// (life r8) now the shared life.js figure (vehicles.js stampPerson: head,
// shirt, arms, legs) in the lot part instead of a 3-voxel peg; returns false
// when the spot was too close to another visitor.
export function person(g, x, y, z, shirt, legs) {
  const seed = ((x * 73856093) ^ (z * 19349663) ^ ((shirt | 0) * 83492791)) >>> 0;
  return stampPerson(g, x + 0.5, y, z + 0.5, seed, seed >>> 29);
}
const SHIRTS = () => [C.red, C.civSeat, C.yellow, C.signWhite, C.roofGreen, C.orange, C.pink, C.teal, C.purple];
// Scatter up to n visitors over rects [[x0,z0,x1,z1],…] standing on y: only on
// dry, clear ground and never shoulder to shoulder, so crowds read as people
// rather than noise. Deterministic per seed. Returns the number placed.
export function crowd(g, rects, y, n, seed = 1, o = {}) {
  const cols = o.shirts || SHIRTS();
  let s = (seed * 9301 + 49297) & 0x7fffffff;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const has = (x, yy, z) => g.map.has(x + ',' + yy + ',' + z);
  let placed = 0;
  for (let i = 0; i < n * 40 && placed < n; i++) {
    const [x0, z0, x1, z1] = rects[Math.floor(rnd() * rects.length)];
    const x = x0 + Math.floor(rnd() * (x1 - x0 + 1)), z = z0 + Math.floor(rnd() * (z1 - z0 + 1));
    const gc = g.map.get(x + ',' + (y - 1) + ',' + z);
    if (gc == null || gc === C.civPool || gc === C.civPoolLt) continue;
    let bad = false;
    for (let yy = y; yy <= y + 3 && !bad; yy++) if (has(x, yy, z)) bad = true;
    for (let dx = -1; dx <= 1 && !bad; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx || dz) && has(x + dx, y + 1, z + dz)) { bad = true; break; }
    if (bad) continue;
    if (person(g, x, y, z, cols[(placed + seed) % cols.length], (placed % 3) === 0 ? C.darkGray : C.civNavy) === false) continue;
    placed++;
  }
  return placed;
}
// Food / ticket kiosk (x0,z0 min corner, w × d): white box with serving
// windows on BOTH long faces (the gallery lens can see either), a striped
// overhanging canopy and a colour sign board on the roof.
export function kiosk(g, x0, y, z0, w, d, c, o = {}) {
  const x1 = x0 + w - 1, z1 = z0 + d - 1, h = o.h || 6;
  g.box(x0, y, z0, x1, y + h - 1, z1, C.signWhite);
  g.box(x0, y, z0, x1, y, z1, c);
  for (const z of [z0, z1]) { g.box(x0 + 1, y + 2, z, x1 - 1, y + 3, z, C.civGlass); }
  for (const [z, dz] of [[z0 - 1, -1], [z1 + 1, 1]]) g.box(x0 + 1, y + 1, z, x1 - 1, y + 1, z, C.wood);
  for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) g.set(x, y + h, z, ((x - x0) >> 1) & 1 ? C.signWhite : c);
  if (o.sign !== false) { g.box(x0 + 1, y + h + 1, (z0 + z1) >> 1, x1 - 1, y + h + 3, (z0 + z1) >> 1, o.signC != null ? o.signC : C.yellow); g.box(x0 + 2, y + h + 2, ((z0 + z1) >> 1), x1 - 2, y + h + 2, ((z0 + z1) >> 1), c); }
}
// Café table under a striped umbrella, two stools.
export function umbTable(g, x, y, z, c1, c2 = C.signWhite) {
  g.box(x - 1, y + 2, z - 1, x + 1, y + 2, z + 1, C.signWhite);
  g.set(x - 2, y, z, c1); g.set(x + 2, y, z, c1);
  umbrella(g, x, y, z, c1, c2, 6, 2);
}
// Row of parking bays on asphalt: n bays along X (each 6 wide), cars nose to
// -Z, white bay lines; `cars` colours (null = empty bay).
export function parkingRow(g, x0, y, z0, n, cars, seed = 0) {
  const x1 = x0 + n * 6, z1 = z0 + 11;
  g.box(x0, y - 1, z0, x1, y - 1, z1, C.lotAsphalt);
  for (let i = 0; i <= n; i++) g.box(x0 + i * 6, y - 1, z0 + 1, x0 + i * 6, y - 1, z1, C.lotLine);
  for (let i = 0; i < n; i++) { const c = cars[i % cars.length]; if (c != null) car(g, x0 + 1 + i * 6, y, z0 + 2, 'z', c, { seed: seed + i, rev: ((i + seed) & 1) === 1 }); }
}

// People-scale park bench (res 4: a person is 3 voxels tall, a lot car 9
// long): `len` long along `axis`, seat 1 up, backrest on the +side.
export function benchS(g, x0, y, z0, axis = 'x', len = 4, o = {}) {
  const seat = o.seat != null ? o.seat : C.wood, leg = o.leg != null ? o.leg : C.darkGray;
  const P = (a, yy, b, c) => (axis === 'x' ? g.set(x0 + a, yy, z0 + b, c) : g.set(x0 + b, yy, z0 + a, c));
  const back = o.flip ? 0 : 1, front = 1 - back;
  for (const a of [0, len - 1]) P(a, y, front, leg);
  for (let a = 0; a < len; a++) { P(a, y + 1, front, seat); P(a, y + 1, back, seat); P(a, y + 2, back, seat); }
  for (const a of [0, len - 1]) P(a, y, back, leg);
}

// Parked lot car, delegated to the vehicles piece so lots match traffic
// (4 wide × 4 tall × 9 long). axis 'x' | 'z'; (x0, z0) = min corner.
// `col` picks a kind: C.fireRed → fire van, C.signWhite → white van, else a car.
export function car(g, x0, y, z0, axis, col, o = {}) {
  const GEN = [0, 3, 5, 9, 10, 13], h = (col | 0) + (o.seed | 0);
  const kind = o.kind != null ? o.kind : col === C.fireRed ? 4 : col === C.signWhite ? 8 : GEN[h % 6] + 14 * (h % 5);
  stampCar(g, kind, x0, y, z0, axis === 'x' ? (o.rev ? 3 : 1) : (o.rev ? 2 : 0));
}

// Fire engine, to the lot-car scale: L long × 6 wide × 8 tall, cab at a = 0
// (axis 'x' → length along +X, 'z' → along +Z). Chrome ladder on top, white
// waist stripe, locker seams, light bar, black tyres.
export function fireTruck(g, x0, y, z0, axis, o = {}) {
  // (life r7) the shared ladder engine from vehicles.js (res-15: cab-over,
  // light bar, chrome lockers, roof ladder on a turntable), centred in the old
  // L × 6 footprint — the res-4 block truck read as an "oversized toy".
  const L = o.len || 15, W = 6;
  const ca = (L - 9) / 2, cb = (W - 4) / 2;                       // stamp footprint 4 × 9
  if (axis === 'x') stampCar(g, 4, x0 + ca, y, z0 + cb, o.rev ? 1 : 3);
  else stampCar(g, 4, x0 + cb, y, z0 + ca, o.rev ? 2 : 0);
}

// Striped beach umbrella, people scale: pole + (2r+1)² canopy in alternating
// rings with a raised centre. h = pole height.
export function umbrella(g, x, y, z, c1, c2 = C.signWhite, h = 6, r = 2) {
  g.box(x, y, z, x, y + h, z, C.signWhite);
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const ring = Math.max(Math.abs(dx), Math.abs(dz));
    if (ring === r && Math.abs(dx) === r && Math.abs(dz) === r && r > 1) continue;  // clip corners
    g.set(x + dx, y + h, z + dz, ring === r ? c1 : c2);            // (r8) banded, not checkered: the checker read as pixel noise
  }
  g.box(x - 1, y + h + 1, z - 1, x + 1, y + h + 1, z + 1, c1);
  g.set(x, y + h + 2, z, c2);
}

// (r9) Fine res-8 beach umbrella (ref05's pool umbrellas): a 1-fine pole on
// res-4 cell (x, z) from res-4 row y, an octagonal canopy in eight alternating
// segments that steps up to a point, a finial. h = pole height in res-4 rows.
export function fineUmbrella(g, x, y, z, c1, c2 = C.signWhite, h = 6, r = 5) {
  const H = hiGrid(g), X = 2 * x + 1, Z = 2 * z + 1, Y = 2 * y, top = Y + 2 * h;
  H.box(X, Y, Z, X, top, Z, C.signWhite);
  H.box(X - 1, Y, Z - 1, X + 1, Y, Z + 1, C.metalDark);
  for (const [rr, yy] of [[r, top - 1], [r - 2, top], [r - 4, top + 1]]) {
    if (rr < 0) continue;
    for (let i = -rr; i <= rr; i++) for (let k = -rr; k <= rr; k++) {
      if (Math.abs(i) + Math.abs(k) > rr * 1.45) continue;           // octagon
      const sec = Math.floor(((Math.atan2(k, i) + Math.PI) / (2 * Math.PI)) * 8 + 0.5) & 7;
      H.set(X + i, yy, Z + k, (sec & 1) ? c1 : c2);
    }
  }
  H.set(X, top + 2, Z, c1);
}
// (r9) Fine sun lounger: 3 × 9 fine along axis ('x' | 'z') from res-4 min
// corner (x0, z0), a raised back rest at the head, a towel stripe.
export function fineLounger(g, x0, y, z0, axis, col, towel) {
  const H = hiGrid(g), X = 2 * x0, Z = 2 * z0, Y = 2 * y;
  const P = (a, yy, b, c) => (axis === 'x' ? H.set(X + a, yy, Z + b, c) : H.set(X + b, yy, Z + a, c));
  for (let a = 0; a < 9; a++) for (let b = 0; b < 3; b++) P(a, Y + 1, b, (towel != null && a >= 3 && a <= 6) ? towel : col);
  for (const a of [1, 7]) for (const b of [0, 2]) P(a, Y, b, C.metalDark);
  for (let b = 0; b < 3; b++) { P(0, Y + 2, b, col); P(0, Y + 3, b, col); P(1, Y + 2, b, col); }
}
// Sun lounger along axis ('x' | 'z'), 2 wide × 5 long, head (raised) at a = 0.
export function lounger(g, x0, y, z0, axis, col) {
  const P = (a, yy, b, c) => (axis === 'x' ? g.set(x0 + a, yy, z0 + b, c) : g.set(x0 + b, yy, z0 + a, c));
  for (let a = 0; a < 5; a++) for (let b = 0; b < 2; b++) P(a, y, b, a === 0 ? col : C.signWhite);
  for (let b = 0; b < 2; b++) { P(0, y + 1, b, col); P(1, y + 1, b, col); }
}

// Solid hipped roof on a box (x0..x1, z0..z1) from y, `h` layers, each layer
// inset one; the last layer is a flat top in `top` (defaults to c).
export function hipRoof(g, x0, z0, x1, z1, y, h, c, top) {
  let k = 0;
  for (; k < h && x0 + k <= x1 - k && z0 + k <= z1 - k; k++) g.box(x0 + k, y + k, z0 + k, x1 - k, y + k, z1 - k, c);
  if (top != null && k > 0) g.box(x0 + k, y + k - 1, z0 + k, x1 - k, y + k - 1, z1 - k, top);
  return y + k;
}

// Flag on a pole: pole at (x, z) from y up h; flag w × fh hanging toward +x.
export function flagPole(g, x, y, z, h, cols, o = {}) {
  g.box(x - 1, y, z - 1, x + 1, y, z + 1, C.stone);
  g.box(x, y + 1, z, x, y + h, z, C.signWhite);
  g.set(x, y + h + 1, z, C.gold);
  const w = o.w || 8, fh = o.fh || 5, dir = o.dir || 1;
  for (let i = 0; i < w; i++) for (let j = 0; j < fh; j++) {
    const c = cols[Math.floor(j * cols.length / fh)];
    g.set(x + dir * (i + 1), y + h - j - ((i >> 2) & 1), z, c);   // gentle wave
  }
}

// Filled disc at y (centre may be fractional), r radius.
export function disc(g, cx, y, cz, r, c, r0 = -1) {
  const R2 = r * r + r * 0.6, R02 = r0 >= 0 ? r0 * r0 + r0 * 0.6 : -1;
  for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++)
    for (let z = Math.floor(cz - r - 1); z <= Math.ceil(cz + r + 1); z++) {
      const d2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (d2 <= R2 && d2 > R02) g.set(x, y, z, c);
    }
}

// Signed distance to a rounded rectangle (centre cx,cz; half extents hx,hz; corner r).
export function rrDist(x, z, cx, cz, hx, hz, r) {
  const qx = Math.abs(x - cx) - (hx - r), qz = Math.abs(z - cz) - (hz - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
}

// Row of dark-framed flat solar/skylight strips etc. are in core; small AC box:
export function roofBox(g, x0, y, z0, w, d, h, c = C.offwhite) { g.box(x0, y, z0, x0 + w - 1, y + h - 1, z0 + d - 1, c); g.box(x0 + 1, y + h - 1, z0 + 1, x0 + w - 2, y + h - 1, z0 + d - 2, C.metalDark); }

// ---------------------------------------------------------------------------
// serviceModel(kind, variant)
// ---------------------------------------------------------------------------
export function serviceModel(kind, variant) {
  const k = String(kind == null ? 'park' : kind).toLowerCase();
  const v = (variant | 0);
  const rng = mulberry32(((v) >>> 0) + 7);
  switch (k) {
    case 'school': return svcSchool(rng, v);
    case 'fire': return svcFire(rng, v);
    case 'fountain': return svcFountain(rng, v);
    case 'stadium': return svcStadium(rng);
    case 'power': return svcPower(rng);
    case 'park': default: return svcPark(rng, v);
  }
}

// ---- shared civic dressing ---------------------------------------------------
// Pilaster strips proud of a facade at each u in `us`, from y0 to y1.
function pilasters(f, us, y0, y1, c) { for (const u of us) f.box(u, y0, 1, u, y1, 1, c); }
// A course (band) one voxel proud all round a box footprint at height y.
function course(g, x0, z0, x1, z1, y, c, out = 1) { g.walls(x0 - out, y, z0 - out, x1 + out, y, z1 + out, c); }
// Clear 3×5 lettering; the core font's S reads as "I" at gallery zoom, so S
// gets a squarer glyph here and everything else defers to pixelText.
// (w4r8) critic w4r7 read FIRE STATION as "FISE STATION": the core R's open
// bowl + slanted leg read as S at gallery zoom. R gets a closed box bowl and
// a stepped leg (a P with a kick) so it can't be taken for S.
const GLYPHS = { S: '####..###..####', R: '###' + '#.#' + '###' + '##.' + '#.#' };
export function civText(f, u, y, text, c, out = 2) {
  c = signLit(c);   // [night] lit sign letters (same colour by day)
  let col = 0;
  for (const ch of String(text).toUpperCase()) {
    const gl = GLYPHS[ch];
    if (gl) {
      for (let r = 0; r < 5; r++) for (let i = 0; i < 3; i++)
        if (gl[r * 3 + i] === '#') f.set(u + f.rd * (col + i), y + 4 - r, out, c);
    } else pixelText(f, u + f.rd * col, y, ch, c, out);
    col += 4;
  }
  return Math.max(0, col - 1);
}
// (civic r7) Crisp name lettering at res 8 (half a res-4 voxel). The 3×5
// font at res 4 spans a whole facade and read as a billboard (critic r3); at
// res 8 a word is a name plate the size of ref05's POLICE / STATION. The
// letters go into a res-8 part (engine: model.parts, same footprint) that is
// stored pre-flipped because catalogModel only flipZ()s the base (as
// industrial.js hiRes). side/plane as facade(); uc = the res-4 u of the text
// centre (voxel 15 spans 15..16, so the lot centre is 15.5); y4 = the res-4
// row the letters' baseline sits on; out = the res-4 layer the letters sit in
// front of (0 = the wall itself, 1 = a plate one proud, ...).
export function hiText(g, side, plane, uc, y4, text, c, out = 0) {
  if (!g.__hi) g.__hi = grid(g.sx * 2, g.sy * 2, g.sz * 2, (g.res || 1) * 2);
  const H = g.__hi;
  const alongX = side === 'front' || side === 'back';
  const rd = { front: 1, back: -1, left: -1, right: 1 }[side];
  const p8 = (side === 'front' || side === 'left') ? 2 * (plane - out) - 1 : 2 * (plane + out) + 2;
  const y8 = Math.round(2 * y4);
  const W8 = 4 * String(text).length - 1;
  const s0 = rd > 0 ? Math.round(2 * uc - W8 / 2) : Math.round(2 * uc + W8 / 2) - 1;
  const F8 = { rd, set(u, yy, o, col) { if (alongX) H.set(u, yy, p8, col); else H.set(p8, yy, u, col); } };
  civText(F8, s0, y8, text, c, 0);
  return W8 / 2;                                                 // width in res-4 voxels
}
// ---- (civic r9) FINE TRIM at res 8 ---------------------------------------
// Critic r8: "built from coarse voxels … in ref05 every building is covered in
// small detail: fine window grids, cornices, pilasters". The res-4 base keeps
// the massing; this res-8 grid (the same part hiText writes into, finished by
// doneHi) carries the half-voxel trim: window frames + glazing bars, sills,
// hoods, dentils, balustrades, carved stairs and the monument core.
export function hiGrid(g, sy8) {
  // sy8: optional fine height cap (the part's mesh cost scales with its grid
  // volume, so a tall model with only low trim can ask for a short part)
  if (!g.__hi) g.__hi = grid(g.sx * 2, sy8 || g.sy * 2, g.sz * 2, (g.res || 1) * 2);
  return g.__hi;
}
// Fine facade on res-4 wall plane `plane` (same side names as facade()):
// u, y in fine units (res-4 voxel u spans fine 2u, 2u+1); out 0 = the first
// fine layer IN FRONT of the wall, out -1 = the wall's own outer skin (hidden
// inside the base unless the base was opened there), out 1 further proud.
export function hiFacade(g, side, plane) {
  const p8 = (side === 'front' || side === 'left') ? 2 * plane - 1 : 2 * plane + 2;
  return facade(hiGrid(g), side, p8);
}
// A classical window. The res-4 base gets the glass flush in the wall
// (u0..u0+w-1, y0..y0+h-1); the fine part lays a thin architrave ring round
// it one fine voxel proud (so the glass reads set back in its frame),
// glazing bars (a transom at 2/3 height; a centre mullion when w ≥ 3, two
// when w = 5), a fine sill and a hood moulding (optional keystone). ~70
// tris a window: glass fills the opening, so the facade reads as glass in
// thin frames, not white slabs (critic r8: "fine window grids").
// o: { glass, frame (bars), surround (ring colour, default frame), trim
//      (sill/hood), key (colour | false), hood: false, transom: false }
export function fineWin(g, side, plane, u0, y0, w, h, o = {}) {
  // (r10) critic r9: "deep dark window reveals, dark outlines on its trim".
  // The architrave ring is now a DARK reveal (o.surround, default INK) two
  // fine layers deep (one res-4 voxel), so the flush glass sits in a real
  // box; the sill and hood step one fine further out; a pale glint in the
  // top-left pane reads as glass (ref05's windows are dark with a highlight).
  // (w4r3) critic w4r2: "flat slabs with dark punched window holes … in
  // ref05 windows are glassy blue with light reflections". Dark glass is now
  // only on request: the default is a mid reflective blue whose top res-4 row
  // catches the sky (lighter), crossed by a fine diagonal reflection streak
  // (ref05's glass highlight), still inside the dark reveal.
  const F = facade(g, side, plane), E = hiFacade(g, side, plane);
  const glass = o.glass != null ? o.glass : C.dtGlass;
  const frame = o.frame != null ? o.frame : C.signWhite, trim = o.trim != null ? o.trim : frame;
  const sc = o.surround != null ? o.surround : INK();
  // (w4r3) the reveal is one fine deep by default: at two, its side and top
  // faces hid most of the glass at the iso angle (the "punched holes")
  const D = o.deep === true ? 1 : 0;
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  // (w4r12) critic w4r11: "shallow facades … in ref05 window reveals are
  // recessed". o.recess: the glass sits one res-4 voxel INTO the wall (the
  // wall voxels in front are cleared), so every opening is a real 2-fine
  // reveal behind the proud frame ring; bars and glint move onto the glass.
  const RZ = o.recess ? -1 : 0, EZ = o.recess ? -2 : 0;
  if (RZ) F.clear(u0, y0, 0, u1, y1, 0);
  F.box(u0, y0, RZ, u1, y1, RZ, glass);
  if (o.sky !== false && h >= 3 && glass !== C.dtGlassHi) F.box(u0, y1, RZ, u1, y1, RZ, C.civGlass);
  const a0 = 2 * u0, a1 = 2 * u1 + 1, b0 = 2 * y0, b1 = 2 * y1 + 1;
  if (o.glint !== false && h >= 3) {                                // the diagonal reflection streak
    const Wf = a1 - a0 + 1, Hf = b1 - b0 + 1, k = Math.round((Wf + Hf) * 0.42);
    for (let x = a0; x <= a1; x++) for (let yy = b0; yy <= b1 - 2; yy++) {
      const s = (x - a0) + (yy - b0);
      if (s === k || s === k + 1 || (Wf >= 5 && s === k + 4)) E.set(x, yy, EZ, C.dtGlassHi);
    }
  }
  E.box(a0 - 1, b0 - 1, 0, a0 - 1, b1 + 1, D, sc); E.box(a1 + 1, b0 - 1, 0, a1 + 1, b1 + 1, D, sc);
  E.box(a0, b1 + 1, 0, a1, b1 + 1, D, sc);
  if (h >= 4 && o.transom !== false) { const t = b0 + Math.round((b1 - b0) * 0.62); E.box(a0, t, EZ, a1, t, EZ, frame); }
  if (o.mullion === false) { /* (w2r1) open panes: the glass reads dark */ }
  else if (w === 3) E.box(a0 + 2, b0, EZ, a0 + 3, b1, EZ, frame);
  else if (w === 4) E.box(a0 + 3, b0, EZ, a0 + 4, b1, EZ, frame);
  else if (w === 5) { E.box(a0 + 3, b0, EZ, a0 + 3, b1, EZ, frame); E.box(a0 + 6, b0, EZ, a0 + 6, b1, EZ, frame); }
  else if (w >= 6) for (let m = a0 + 3; m < a1 - 1; m += 4) E.box(m, b0, EZ, m, b1, EZ, frame);
  E.box(a0 - 1, b0 - 1, 0, a1 + 1, b0 - 1, D, trim);               // sill
  E.box(a0 - 2, b0 - 2, 0, a1 + 2, b0 - 2, D + 1, trim);            // + a proud lip
  E.box(a0 - 2, b0 - 3, 0, a1 + 2, b0 - 3, 0, INK());               // its dark shadow line
  if (o.hood !== false) {
    E.box(a0 - 2, b1 + 2, 0, a1 + 2, b1 + 2, D + 1, trim);          // hood moulding
    E.box(a0 - 2, b1 + 3, 0, a1 + 2, b1 + 3, 0, INK());
    if (o.key !== false && o.key != null) { const m = (a0 + a1) >> 1; E.box(m, b1 + 1, D + 1, m + 1, b1 + 2, D + 1, o.key); }
  }
}
// (r10) INK: the dark outline colour of ref05's trim ("dark outlines on its
// cornices and trim, dark edge lines" - critic r9).
export const INK = () => C.civNavy;
// A dark fine line round a res-4 box footprint (x0..x1, z0..z1) at fine row
// y8: `rows` tall, `out` fine layers proud. Put it under every cornice and
// string course so each reads with a crisp dark edge.
export function inkBand(g, x0, z0, x1, z1, y8, rows = 1, out = 1) { fineBand(g, x0, z0, x1, z1, y8, INK(), rows, out); }
// Dark vertical edge beads on the four corners of a res-4 box from res-4 row
// y0 to y1 (inclusive): an L of fine voxels hugging both faces, so every
// building corner carries a thin dark outline like ref05's clock tower.
export function inkEdges(g, x0, z0, x1, z1, y0, y1, c) {
  const H = hiGrid(g), col = c != null ? c : INK();
  const X0 = 2 * x0 - 1, X1 = 2 * x1 + 2, Z0 = 2 * z0 - 1, Z1 = 2 * z1 + 2, Y0 = 2 * y0, Y1 = 2 * y1 + 1;
  for (const [x, z, dx, dz] of [[X0, Z0, 1, 1], [X1, Z0, -1, 1], [X0, Z1, 1, -1], [X1, Z1, -1, -1]]) {
    H.box(x, Y0, z + dz, x, Y1, z + dz, col); H.box(x + dx, Y0, z, x + dx, Y1, z, col);
  }
}
// (r10) Brick coursing (critic r9: ref05's fire station has "sharp brick
// coursing"): a fine course line one fine proud of every EXPOSED `wallC`
// res-4 face on facade (side, plane), every `step` fine rows over res-4 rows
// y0..y1 and res-4 u0..u1. It skips any cell whose base voxel isn't brick or
// that already carries something in front (windows, piers, trim), so the
// lines break cleanly at every opening.
export function brickCourse(g, side, plane, u0, u1, y0, y1, wallC, c, step = 4, phase = 2) {
  const H = hiGrid(g);
  const D = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] }[side];
  const alongX = D[0] === 0;
  const key4 = (u, yy, out) => (alongX ? u + ',' + yy + ',' + (plane + D[1] * out) : (plane + D[0] * out) + ',' + yy + ',' + u);
  const p8 = (side === 'front' || side === 'left') ? 2 * plane - 1 : 2 * plane + 2;
  const key8 = (u, yy, out) => (alongX ? u + ',' + yy + ',' + (p8 + D[1] * out) : (p8 + D[0] * out) + ',' + yy + ',' + u);
  for (let r = 2 * y0 + phase; r <= 2 * y1 + 1; r += step) {
    const yy = r >> 1;
    for (let u = 2 * u0; u <= 2 * u1 + 1; u++) {
      const b = u >> 1;
      if (g.map.get(key4(b, yy, 0)) !== wallC || g.map.has(key4(b, yy, 1))) continue;
      if (H.map.has(key8(u, r, 0)) || H.map.has(key8(u, r - 1, 0)) || H.map.has(key8(u, r + 1, 0))) continue;
      const x = alongX ? u : p8 + D[0] * 0, z = alongX ? p8 + D[1] * 0 : u;
      H.set(x, r, z, c);
    }
  }
}
// Fine hipped roof over a res-4 box (x0..x1, z0..z1) from res-4 row y4:
// 1-fine steps (twice as many as a res-4 hipRoof, so the slope reads fine),
// h4 res-4 voxels tall; a flat `top` cap when it runs out of height.
export function fineHipRoof(g, x0, z0, x1, z1, y4, h4, c, top) {
  const H = hiGrid(g);
  const X0 = 2 * x0, X1 = 2 * x1 + 1, Z0 = 2 * z0, Z1 = 2 * z1 + 1, Y = 2 * y4;
  let k = 0;
  for (; k < 2 * h4 && X0 + k <= X1 - k && Z0 + k <= Z1 - k; k++) {
    const last = k === 2 * h4 - 1 || X0 + k + 1 > X1 - k - 1 || Z0 + k + 1 > Z1 - k - 1;
    H.box(X0 + k, Y + k, Z0 + k, X1 - k, Y + k, Z1 - k, last && top != null ? top : c);   // solid: no hidden inner faces
  }
  return y4 + k / 2;
}
// (r9) Fine (res-8) dome: a smooth hemispherical shell of radius R4 res-4
// voxels centred over res-4 cell (cx, cz), springing from res-4 row y4, with
// `ribs` proud meridian ribs in `rib` colour and a lantern ring. Returns the
// fine row of its crown.
export function fineDome(g, cx, cz, y4, R4, c, rib, ribs = 8) {
  const H = hiGrid(g), X = 2 * cx + 1, Z = 2 * cz + 1, Y = 2 * y4, R = 2 * R4;
  for (let k = 0; k <= R; k++) {
    const r = Math.sqrt(Math.max(0, R * R - k * k)) + 0.35, r0 = Math.max(0, r - 3);
    for (let i = -R - 2; i <= R + 1; i++) for (let j = -R - 2; j <= R + 1; j++) {
      const d = Math.hypot(i + 0.5, j + 0.5);
      if (d > r + 1 || d < r0) continue;
      const a = Math.atan2(j + 0.5, i + 0.5) * ribs / (2 * Math.PI);
      const onRib = rib != null && Math.abs(a - Math.round(a)) * (2 * Math.PI * d / ribs) < 0.9 && k < R - 2;
      if (d < r) H.set(X - 1 + i + 1, Y + k, Z - 1 + j + 1, onRib ? rib : c);
      else if (onRib) H.set(X + i, Y + k, Z + j, rib);
    }
  }
  return Y + R;
}
// (r9) Fine mouldings on a res-4 column (x0..x1, z0..z1, rows y0..y1): a
// torus + plinth at the foot, an echinus + abacus under the head, and
// shallow flutes (fine fillets) up the shaft — classical at res 8.
export function fineColumn(g, x0, z0, x1, z1, y0, y1, c, flute = null) {
  const H = hiGrid(g), X0 = 2 * x0, X1 = 2 * x1 + 1, Z0 = 2 * z0, Z1 = 2 * z1 + 1, Y0 = 2 * y0, Y1 = 2 * y1 + 1;
  H.box(X0 - 1, Y0, Z0 - 1, X1 + 1, Y0 + 1, Z1 + 1, c);              // plinth
  H.box(X0 - 1, Y0 + 2, Z0 - 1, X1 + 1, Y0 + 2, Z1 + 1, c);
  H.box(X0 - 1, Y1 - 2, Z0 - 1, X1 + 1, Y1 - 1, Z1 + 1, c);          // echinus
  H.box(X0 - 2, Y1, Z0 - 2, X1 + 2, Y1, Z1 + 2, c);                  // abacus
  if (flute != null) {
    for (let x = X0 + 1; x < X1; x += 2) { H.box(x, Y0 + 3, Z0 - 1, x, Y1 - 3, Z0 - 1, flute); H.box(x, Y0 + 3, Z1 + 1, x, Y1 - 3, Z1 + 1, flute); }
    for (let z = Z0 + 1; z < Z1; z += 2) { H.box(X0 - 1, Y0 + 3, z, X0 - 1, Y1 - 3, z, flute); H.box(X1 + 1, Y0 + 3, z, X1 + 1, Y1 - 3, z, flute); }
  }
}
// Row of fine dentils (1 on, 1 off) round a res-4 box footprint, one fine
// layer proud of its walls, at fine row y8 (two rows tall).
export function fineDentils(g, x0, z0, x1, z1, y8, c, rows = 2) {
  const H = hiGrid(g);
  const X0 = 2 * x0 - 1, X1 = 2 * x1 + 2, Z0 = 2 * z0 - 1, Z1 = 2 * z1 + 2;
  for (let yy = y8; yy < y8 + rows; yy++) {
    for (let x = X0; x <= X1; x += 2) { H.set(x, yy, Z0, c); H.set(x, yy, Z1, c); }
    for (let z = Z0; z <= Z1; z += 2) { H.set(X0, yy, z, c); H.set(X1, yy, z, c); }
  }
}
// Fine band (moulding) round a res-4 box footprint: `rows` fine rows from y8,
// `out` fine layers proud (1 = one fine voxel beyond the wall).
export function fineBand(g, x0, z0, x1, z1, y8, c, rows = 1, out = 1) {
  const H = hiGrid(g);
  for (let k = 1; k <= out; k++) H.walls(2 * x0 - k, y8, 2 * z0 - k, 2 * x1 + 1 + k, y8 + rows - 1, 2 * z1 + 1 + k, c);
}
// Fine balustrade on a flat roof edge: plinth rail, balusters every other
// fine voxel, top rail — 4 fine (two res-4 voxels) tall, set `inset` fine
// voxels in from the res-4 box's outer face. y8 = the fine row it stands on.
export function fineBalustrade(g, x0, z0, x1, z1, y8, c, inset = 0, gaps = []) {
  const H = hiGrid(g);
  const X0 = 2 * x0 + inset, X1 = 2 * x1 + 1 - inset, Z0 = 2 * z0 + inset, Z1 = 2 * z1 + 1 - inset;
  const skip = (x, z) => gaps.some(([a, b, cc, d]) => x >= a && x <= cc && z >= b && z <= d);
  const P = (x, z) => {
    if (skip(x, z)) return;
    const corner = (x === X0 || x === X1) && (z === Z0 || z === Z1);
    H.set(x, y8, z, c); H.set(x, y8 + 3, z, c);
    if (corner || (((x + z) % 3) === 0)) { H.set(x, y8 + 1, z, c); H.set(x, y8 + 2, z, c); }
  };
  for (let x = X0; x <= X1; x++) { P(x, Z0); P(x, Z1); }
  for (let z = Z0; z <= Z1; z++) { P(X0, z); P(X1, z); }
}
// A fine rooftop AC unit (res-8): body, dark fan grille, a pipe stub.
export function fineAC(g, x8, y8, z8, w = 6, d = 5, c = C.offwhite) {
  const H = hiGrid(g);
  H.box(x8, y8, z8, x8 + w - 1, y8 + 3, z8 + d - 1, c);
  H.box(x8 + 1, y8 + 4, z8 + 1, x8 + 3, y8 + 4, z8 + 3, C.metalDark);
  H.set(x8 + 2, y8 + 4, z8 + 2, C.darkGray);
  H.box(x8 + w - 2, y8 + 4, z8 + d - 2, x8 + w - 2, y8 + 5, z8 + d - 2, C.metal);
}

// g.done() plus the hiText part (pre-flipped). Setting m.parts goes through
// vehicles.js's accessor when the lot has cars/people (it keeps both).
export function doneHi(g) {
  const m = g.done();
  if (g.__hi) { const p = g.__hi.done(); flipZ(p); if (p.blocks.length) m.parts = [p]; }
  return m;
}
// Clock face (5×5 white disc look, dark hands) on a facade, centred at u.
function clockFace(f, u, y, frame) {
  // (r9) a fine res-8 dial: round bezel in the frame colour (proud), white
  // face, hour marks, two hands and a gold boss — the old 7×7 res-4 square
  // frame read as a dark block.
  const E = hiFacade(f.g, f.side, f.plane), cu = 2 * u + 1, cy = 2 * y + 1;
  for (let i = cu - 7; i <= cu + 7; i++) for (let j = cy - 7; j <= cy + 7; j++) {
    const d = Math.hypot(i + 0.5 - cu, j + 0.5 - cy);
    if (d < 5.9) E.set(i, j, 0, C.signWhite);
    else if (d < 6.9) { E.set(i, j, 0, frame); E.set(i, j, 1, frame); }
  }
  for (const [di, dj] of [[0, 4], [0, -5], [4, 0], [-5, 0]]) E.set(cu + di + (di < 0 ? 0 : 0), cy + dj, 1, C.darkGray);
  E.box(cu - 1, cy - 1, 1, cu - 1, cy + 3, 1, C.darkGray);          // minute hand
  E.box(cu - 1, cy - 1, 1, cu + (f.rd > 0 ? 2 : -3) , cy - 1, 1, C.darkGray);   // hour hand
  E.set(cu - 1, cy - 1, 2, C.gold);
}
// Compact lot tree in the vegetation style (half-scale ref06 specimen).
export function lotTree(g, kind, x, y, z, seed) {
  try { stampVeg(g, kind, x, y, z, seed, 0.5); } catch (e) { tree(g, x, y, z, { w: 7, h: 7, trunk: 5 }); }
}

// ---- PARK (1×1): three themed gardens, not a tree grid ----------------------
// v0 bandstand green, v1 duck pond + bridge, v2 formal parterre + statue.
function svcPark(rng, v) {
  const g = grid(31, 44, 31, 4);
  const y = lotPlinth(g, 0, 0, 30, 30, { fill: 'grass' });
  const kind = ((v % 3) + 3) % 3;
  const path = C.lotPave, edge = C.lotRim;
  // perimeter walk + a hedge border with gaps at the gates
  g.walls(1, y - 1, 1, 29, y - 1, 29, path); g.walls(2, y - 1, 2, 28, y - 1, 28, path);
  for (const [x0, z0, x1, z1] of [[3, 3, 11, 4], [19, 3, 27, 4], [3, 26, 11, 27], [19, 26, 27, 27], [3, 5, 4, 11], [3, 19, 4, 25], [26, 5, 27, 11], [26, 19, 27, 25]])
    bush(g, x0, y, z0, x1, z1, 3);
  if (kind === 0) {
    // cross paths to an octagonal bandstand (white posts, red tiered roof)
    g.box(13, y - 1, 3, 17, y - 1, 27, path); g.box(3, y - 1, 13, 27, y - 1, 17, path);
    disc(g, 15, y - 1, 15, 8, path);
    disc(g, 15, y, 15, 6.5, C.civMarble); disc(g, 15, y + 1, 15, 6.5, C.civMarble);
    disc(g, 15, y + 1, 15, 5.5, C.plank);
    for (let a = 0; a < 8; a++) {
      const t = a / 8 * Math.PI * 2 + Math.PI / 8, px = Math.round(15 + Math.cos(t) * 5.5), pz = Math.round(15 + Math.sin(t) * 5.5);
      g.box(px, y + 2, pz, px, y + 11, pz, C.signWhite);
      g.set(px, y + 4, pz, C.gold);
    }
    for (let a = 0; a < 48; a++) {                                   // railing
      const t = a / 48 * Math.PI * 2, px = Math.round(15 + Math.cos(t) * 5.5), pz = Math.round(15 + Math.sin(t) * 5.5);
      if (Math.abs(px - 15) <= 1 && pz < 15) continue;
      g.set(px, y + 4, pz, C.signWhite);
    }
    disc(g, 15, y + 12, 15, 7.5, C.signWhite);
    for (let k = 0; k < 5; k++) disc(g, 15, y + 13 + k, 15, 7 - k * 1.5, (k & 1) ? C.signWhite : C.roofRed);
    g.box(15, y + 18, 15, 15, y + 21, 15, C.gold);
    benchS(g, 6, y, 11, 'x', 4, { seat: C.wood }); benchS(g, 19, y, 18, 'x', 4, { seat: C.wood });
    lotTree(g, 'round', 6, y, 24, 3); lotTree(g, 'round', 25, y, 5, 5); lotTree(g, 'round', 5, y, 8, 7);   // (r7) none on the lens corner
    // (w4r14) planter + lamps gone (critic w4r13: fun/park lots "a scatter of
    // tiny props with no hierarchy — 2-3 purposeful props each")
  } else if (kind === 1) {
    // kidney pond with a stone rim, lily pads, ducks, arched red bridge
    const cx = 15, cz = 16;
    for (let x = 3; x <= 27; x++) for (let z = 5; z <= 26; z++) {
      const a = Math.atan2(z - cz, x - cx), r = 7.5 + Math.sin(a * 2 + 0.6) * 1.6;
      const d = Math.hypot((x - cx) * 0.9, z - cz);
      if (d < r - 1) g.set(x, y - 1, z, C.civPool);
      else if (d < r + 0.6) { g.set(x, y - 1, z, V.rock); g.set(x, y, z, ((x * 5 + z * 3) % 4) ? V.rockLight : V.rock); }
    }
    for (const [lx, lz] of [[10, 12], [19, 20], [20, 11]]) { g.box(lx, y - 1, lz, lx + 1, y - 1, lz + 1, C.leafMid); }
    g.set(20, y, 20, C.pink);
    for (const [dx, dz, c] of [[12, 19, C.signWhite], [18, 13, C.yellow]]) {
      g.box(dx, y - 1, dz, dx + 2, y, dz + 1, c); g.box(dx + 2, y + 1, dz, dx + 2, y + 2, dz, c); g.set(dx + 3, y + 1, dz, C.orange);
    }
    for (let x = 4; x <= 26; x++) {                                  // bridge across the waist
      const h = Math.round(4 - Math.abs(x - 15) * 0.35);
      g.box(x, y + Math.max(0, h - 1), 15, x, y + Math.max(0, h), 17, C.roofRed);
      g.set(x, y + h + 2, 15, C.signWhite); g.set(x, y + h + 2, 17, C.signWhite);
      if (x % 3 === 0) { g.box(x, y + h + 1, 15, x, y + h + 1, 15, C.signWhite); g.box(x, y + h + 1, 17, x, y + h + 1, 17, C.signWhite); }
    }
    lotTree(g, 'pine', 5, y, 24, 2); lotTree(g, 'round', 24, y, 5, 4); lotTree(g, 'round', 6, y, 6, 6);
    rocksAt(g, 7, y, 24);
    g.box(21, y - 1, 16, 22, y, 17, C.signWhite); g.box(22, y + 1, 16, 22, y + 2, 16, C.signWhite); g.set(23, y + 1, 16, C.orange);
    lampPost(g, 27, y, 13, 9, { small: true });
  } else {
    // (w4r7) v2 is a paved pocket plaza, not a memorial. The gallery splits
    // neighbouring landmarks with 1-tile park strips, and the v2 grey
    // terrace + stone figure + corner groups read as a second, clumsier
    // monument beside the obelisk (critic w4r4 "planters blur into one
    // mass"). ref05 fills the space between its civic buildings with tan
    // plaza paving, low hedges, cafe tables and a small fountain, so v2 is
    // that: tan paving inside the hedge border, a low round fountain, cafe
    // umbrellas, benches facing the water, cone topiaries (no tall trees).
    const pave = C.civPlaza;
    g.box(2, y - 1, 2, 28, y - 1, 28, pave);
    g.walls(5, y - 1, 5, 25, y - 1, 25, C.lotRim);                  // a pale band framing the square
    disc(g, 15, y - 1, 15, 7.6, C.lotRim);
    disc(g, 15, y, 15, 6.2, C.signWhite); disc(g, 15, y, 15, 5.2, null);
    for (let x = 9; x <= 21; x++) for (let z = 9; z <= 21; z++) {
      const d = Math.hypot(x - 15, z - 15);
      if (d < 5.2) { g.del(x, y, z); g.set(x, y - 1, z, d < 2.6 ? C.civPoolLt : C.civPool); }
    }
    g.box(14, y, 14, 16, y + 1, 16, C.civMarble);                    // a low two-bowl fountain
    g.box(13, y + 2, 13, 17, y + 2, 17, C.signWhite);
    g.box(15, y + 3, 15, 15, y + 4, 15, C.civMarble);
    g.box(14, y + 5, 14, 16, y + 5, 16, C.signWhite);
    g.set(15, y + 6, 15, C.civPoolLt);
    // (w4r14) calm: the fountain, two benches and one column tree only (the
    // corner planters, lamps and extra benches read as confetti, w4r13)
    for (const [bx, bz, ax, fl] of [[13, 7, 'x', true], [13, 23, 'x', false]]) benchS(g, bx, y, bz, ax, 5, { seat: C.wood, flip: fl });
    lotTree(g, 'column', 26, y, 26, 1);
  }
  crowd(g, [[1, 1, 29, 29]], y, 4, 51 + kind);
  return doneHi(g);
}
function rocksAt(g, x, y, z) {
  g.box(x - 2, y, z - 1, x + 2, y + 1, z + 1, V.rock); g.box(x - 1, y, z - 2, x + 1, y + 2, z + 2, V.rock);
  g.box(x - 1, y + 2, z - 1, x, y + 3, z, V.rockLight);
}

// ---- SCHOOL (2×2): ref05 city hall at its real scale — broad and low.
// (civic r8) Critic r7: "narrow, tall towers sitting on tiny one-tile lots …
// in ref05 the civic buildings are broad and low … each lot is packed with a
// use-specific forecourt". So the school is now a 2×2 lot: a 49-wide three-
// storey hall on a marble podium (wings projecting front and back, a giant-
// order portico with a pediment and the SCHOOL name on its entablature, a
// grand stair down to a hedged forecourt with lawns, lamps and a flag), a
// slate hip roof with a clock tower on the ridge, and a school yard behind
// (painted ball court with hoops, a play frame with slides and swings, bike
// racks, benches) reached by a back porch. Both long faces are finished,
// since the gallery lens sees either.
const SLATE = () => (C.resSlate != null ? C.resSlate : C.roofGray);
// Navy sign plate on a facade (u0..u1, y0..y0+2) with a row of small light
// "lettering" marks: reads as a name plate, never as a billboard.
export function signPlate(f, u0, u1, y0, o = {}) {
  const bg = o.bg != null ? o.bg : C.civNavy, fg = o.fg != null ? o.fg : C.signWhite, out = o.out || 1;
  const rim = o.rim != null ? o.rim : null;
  f.box(u0, y0, out, u1, y0 + 2, out, bg);
  if (rim != null) { f.box(u0 - 1, y0 - 1, out, u1 + 1, y0 - 1, out, rim); f.box(u0 - 1, y0 + 3, out, u1 + 1, y0 + 3, out, rim); f.box(u0 - 1, y0, out, u0 - 1, y0 + 2, out, rim); f.box(u1 + 1, y0, out, u1 + 1, y0 + 2, out, rim); }
  const pat = o.pat || '##.###.##..###.#.##.###';
  const n = u1 - u0 - 1, off = Math.max(0, (pat.length - n) >> 1);
  for (let i = 0; i < n; i++) if (pat[i + off] === '#') f.set(u0 + 1 + i, y0 + 1, out, fg);
}
// Low post-and-rail fence (res 4) along an axis-aligned run.
function railRun(g, x0, z0, x1, z1, y, post, rail, h = 3) {
  const alongX = z0 === z1, a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1;
  for (let a = a0; a <= a1; a++) {
    const P = (yy, c) => (alongX ? g.set(a, yy, z0, c) : g.set(x0, yy, a, c));
    P(y + h - 1, rail);
    if ((a - a0) % 4 === 0 || a === a1) for (let yy = y; yy < y + h; yy++) P(yy, post);
  }
}
// Cone topiary in a stone pot.
function topiary(g, x, y, z, h = 6) {
  g.box(x - 1, y, z - 1, x + 1, y, z + 1, C.civPanel);
  g.box(x - 1, y + 1, z - 1, x + 1, y + h - 3, z + 1, V.bush);
  g.box(x, y + h - 2, z, x, y + h, z, V.bush);
  g.set(x - 1, y + 1, z - 1, V.bushDark); g.set(x + 1, y + 1, z + 1, V.bushDark);
}
function svcSchool(rng, v) {
  const g = grid(63, 84, 63, 4);
  const y = lotPlinth(g, 0, 0, 62, 62, { fill: C.civPlaza });
  const vi = ((v % 3) + 3) % 3;
  // (r10) critic r9: "the pale blue city hall washes out … ref05's city hall
  // has strong grey-green pilasters and a clock tower with dark edge lines".
  // Every variant is now a light wall with DARK pilasters/quoins and a dark
  // slate roof, all trim ink-edged: v0 ref05 cream + grey-teal, v1 red brick
  // + cream stone, v2 sandstone + navy.
  // (w2r1) the gallery shows v2: it now carries ref05's mint-grey hall wall
  // (the cream civStone read as white-on-white behind white trim); v0 cream.
  // (w4r4) critic w4r3: "the school facade reads as one flat blue-grey …
  // give it warm stone or cream walls with contrasting trim". ref05's hall
  // (PIL: walls #f0f0e0 warm cream, pilasters #709080 mint-grey, roof #104050)
  // → v0 (the variant the gallery shows) is now warm cream walls with the
  // grey-teal pilasters under the dark slate; civStone read cool grey-blue.
  // Measured (visible fine faces, v0): white trim was 25-35% of every side
  // vs 15-22% wall, so cream-on-white still read white-grey in game. v0 is
  // now warm sandstone walls with cream stone trim.
  // The gallery shows v2, so v2 carries ref05's hall directly: warm butter
  // walls, mint-grey pilasters, cream trim (it was mint wall + dark civSlate
  // pilasters, which read as the cool blue-grey slab).
  const wall = [C.sand, C.civBrick, C.resButter][vi];
  const trim = [C.cream, C.cream, C.cream][vi];   // (w4r4) white trim on v2 read white/cool again in game
  const quoin = [C.civHallDk, C.brickDark, C.civHall][vi];
  const accent = [C.civSlate, C.roofGreen, C.civNavy][vi];
  const slate = [C.civSlate, C.civSlate, C.civSlate][vi], slateTop = C.stone, mb = C.civMarble, mbDk = C.civPanel;
  // (w2r1) ref05's hall windows are DARK navy glass in white frames
  const winG = C.dtGlass;                                         // (w4r3) glassy blue, reflection streak (fineWin)
  // ---- massing: main block, two end wings (proud front and back), centre
  // pavilion (proud front and back), all three storeys
  const MX0 = 5, MX1 = 57, MZ0 = 16, MZ1 = 38;                    // main block (r10: wider, taller)
  const WZ0 = 13, WZ1 = 41;                                        // wings
  const WINGS = [[5, 17], [45, 57]];
  const PX0 = 24, PX1 = 38, PZ0 = 14, PZ1 = 40;                   // pavilion
  const PY = y + 4, G = PY, FL = 9, FRZ = G + 3 * FL, TOP = FRZ + 3;
  const fy = (k) => G + 2 + k * FL;
  // ---- podium: marble, dark foot band, white lip
  g.box(3, y, 11, 59, PY - 1, 43, mb);
  g.walls(3, y, 11, 59, y, 43, mbDk);
  g.walls(3, PY - 1, 11, 59, PY - 1, 43, C.signWhite);
  inkBand(g, 3, 11, 59, 43, 2 * PY - 3, 1, 0);
  // portico platform + grand stair (front), a shallower stair at the back
  g.box(21, y, 7, 41, PY - 1, 11, mb);
  g.box(21, PY - 1, 7, 41, PY - 1, 7, C.signWhite);
  { // (r9) a fine 8-step stair (1 fine rise) instead of three res-4 blocks
    const Hs = hiGrid(g);
    for (let k = 0; k < 8; k++) { Hs.box(42, 2 * y, 2 + Math.round(k * 1.5), 83, 2 * y + k, 13, mb); Hs.box(42, 2 * y + k, 2 + Math.round(k * 1.5), 83, 2 * y + k, 2 + Math.round(k * 1.5), C.signWhite); }
  }
  for (const cx of [20, 42]) { g.box(cx, y, 1, cx, PY, 11, mbDk); g.box(cx, PY + 1, 7, cx, PY + 1, 11, mb); }
  for (let s = 0; s < 3; s++) g.box(26, y, 44 + s, 36, PY - 2 - s, 44 + s, (s & 1) ? mb : C.signWhite);
  // ---- a finished box: wall, plinth course, string courses, quoins, frieze,
  // dentil cornice, slate hip roof
  const mass = (x0, z0, x1, z1, roofH, proud = false) => {
    g.box(x0, G, z0, x1, TOP - 1, z1, wall);
    course(g, x0, z0, x1, z1, G, mbDk);
    fineBand(g, x0, z0, x1, z1, 2 * (G + FL) - 2, trim, 2, 1);     // (r9) slim fine string courses
    fineBand(g, x0, z0, x1, z1, 2 * (G + 2 * FL) - 2, trim, 2, 1);
    inkBand(g, x0, z0, x1, z1, 2 * (G + FL) - 3, 1, 1); inkBand(g, x0, z0, x1, z1, 2 * (G + 2 * FL) - 3, 1, 1);
    course(g, x0, z0, x1, z1, FRZ, trim);
    inkBand(g, x0, z0, x1, z1, 2 * FRZ - 1, 1, 0);
    // (r10) solid corner pilasters in the dark pilaster colour (ref05)
    for (const [x, z, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
      g.box(x, G + 1, z, x, FRZ - 1, z, quoin); g.box(x + dx, G + 1, z, x + dx, FRZ - 1, z, quoin); g.box(x, G + 1, z + dz, x, FRZ - 1, z + dz, quoin);
    }
    inkEdges(g, x0, z0, x1, z1, G + 1, FRZ - 1);
    // (w4r12) critic w4r11: "shallow facades … ref05 has cornices that
    // project". Outer masses get PROUD corner pilasters (an L one voxel out,
    // two storeys of shadow down each corner), and every cornice is a
    // three-step corbel: a res-4 bed one out, fine dentils under it, a slab
    // three out with a dark drip line under its lip.
    if (proud) for (const [x, z, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
      g.box(x, G + 1, z - dz, x + dx, FRZ - 1, z - dz, quoin); g.box(x - dx, G + 1, z - dz, x - dx, FRZ - 1, z + dz, quoin);
      g.box(x - dx, G, z - dz, x - dx, G, z - dz, mbDk);
    }
    fineDentils(g, x0, z0, x1, z1, 2 * (TOP - 2), trim);
    inkBand(g, x0, z0, x1, z1, 2 * (TOP - 2) - 1, 1, 1);
    course(g, x0, z0, x1, z1, TOP - 1, trim, 1);
    course(g, x0, z0, x1, z1, TOP, trim, 3); course(g, x0, z0, x1, z1, TOP, trim, 2); g.box(x0 - 1, TOP, z0 - 1, x1 + 1, TOP, z1 + 1, trim);
    inkBand(g, x0 - 2, z0 - 2, x1 + 2, z1 + 2, 2 * TOP - 1, 1, 1);
    fineBand(g, x0 - 3, z0 - 3, x1 + 3, z1 + 3, 2 * TOP + 1, trim, 1, 1);
    fineBalustrade(g, x0 - 1, z0 - 1, x1 + 1, z1 + 1, 2 * TOP + 2, trim);
    fineHipRoof(g, x0, z0, x1, z1, TOP + 1, roofH, slate, slateTop);
  };
  mass(MX0, MZ0, MX1, MZ1, 7);
  for (const [a, b] of WINGS) mass(a, WZ0, b, WZ1, 8, true);
  mass(PX0, PZ0, PX1, PZ1, 8);
  // (r9) fine windows: thin white frame + glazing bars, fine sill and hood,
  // a keystone on the piano nobile (critic r8: "coarse voxels … fine window
  // grids" in ref05)
  // (r11) critic r10: "low-contrast blue-grey slits on white walls … ref05
  // has dark, glassy, framed windows set into the walls, a strong grid". Dark
  // glass (winG) in a LIGHT proud frame ring (surround = trim), so each
  // opening reads as a dark recess framed in white.
  // (w2r1) no centre mullion on 3-wide windows: in game the white bars and
  // ring covered the glass, so the facade read as white blocks (ref05: dark
  // glass in thin white frames)
  // (w4r4) v0: the white rings + sills covered almost every cream voxel, so in
  // game the facade read as white-grey with navy reveals ("one flat blue-grey",
  // critic w4r3). The ring/transom is now the cream wall; sills, hoods and
  // keystones stay white, so it reads as ref05's cream wall with white trim.
  const wfr = vi === 1 ? trim : wall;
  const win = (f, u, k, w = 2, h = 5) => fineWin(g, f.side, f.plane, u, fy(k), w, h, { frame: wfr, trim, surround: trim, glass: winG, key: k === 1 ? trim : false, mullion: false, recess: true });
  // ---- long faces (front and back): wings, recessed runs, pavilion
  for (const back of [false, true]) {
    const side = back ? 'back' : 'front';
    const Z = (z) => (back ? 54 - z : z);                          // mirror about the block's mid-plane (Z 27)
    for (const [a] of WINGS) {
      const F = facade(g, side, Z(WZ0));
      for (let k = 0; k < 3; k++) { win(F, a + 2, k, 3); win(F, a + 8, k, 3); }   // (r11) 3-wide bays: more glass, stronger grid
      F.box(a + 6, G + 1, 1, a + 6, FRZ - 1, 2, quoin);              // (r10) dark pilaster between the bays; (w4r12) two deep
      F.box(a + 5, G, 1, a + 7, G, 3, mbDk); F.box(a + 5, FRZ - 1, 1, a + 7, FRZ - 1, 3, trim);   // its base and capital
    }
    const M = facade(g, side, Z(MZ0));
    for (let k = 0; k < 3; k++) { win(M, 19, k, 3); win(M, 41, k, 3); }
    const P = facade(g, side, Z(PZ0));
    win(P, 26, 2); win(P, 30, 2, 3); win(P, 35, 2);
    for (const u of [PX0, PX1]) P.box(u, G, 1, u, FRZ - 1, 1, quoin);
    if (vi === 1) brickCourse(g, side, Z(WZ0), 5, 57, G + 1, FRZ - 1, wall, C.brickDark, 4);
    if (!back) {
      // giant-order portico: four 2×2 columns (bases, capitals), entablature
      // with the SCHOOL name, stepped pediment against the third storey
      for (let k = 0; k < 2; k++) { win(P, 25, k); win(P, 36, k); }
      door(P, 29, G, 5, 8, { color: winG, frame: trim, step: null, glass: C.pBlue, double: true });
      win(P, 30, 1, 3);
      for (const c0 of [23, 27, 34, 38]) {
        g.box(c0, G, 9, c0 + 1, G, 10, mbDk);
        g.box(c0, G + 1, 9, c0 + 1, G + 2 * FL - 2, 10, trim);
        g.box(c0 - 1, G + 2 * FL - 1, 8, c0 + 2, G + 2 * FL - 1, 11, trim);
        fineColumn(g, c0, 9, c0 + 1, 10, G + 1, G + 2 * FL - 2, trim, trim);   // (r9) fine base, capital, flutes
      }
      const EY = G + 2 * FL;                                       // entablature EY..EY+2
      g.box(22, EY, 8, 40, EY + 2, 13, trim);
      g.box(22, EY + 3, 7, 40, EY + 3, 13, trim);
      const E = facade(g, 'front', 8);
      E.box(24, EY, 1, 38, EY + 2, 1, C.civNavy);
      hiText(g, 'front', 8, 31.5, EY + 0.5, 'SCHOOL', C.signWhite, 1);
      // (r9) fine pediment: 1-fine steps, a raking cornice proud of a
      // recessed tympanum, a fine slate roof behind, a gold crest
      const Hh = hiGrid(g), PY0 = 2 * (EY + 4);
      Hh.box(43, PY0 - 2, 13, 82, PY0 - 1, 29, trim);               // horizontal cornice
      for (let k = 0; k < 20; k++) {
        const a = 44 + 2 * k, b = 81 - 2 * k, yy = PY0 + k;
        if (a > b) break;
        Hh.box(a, yy, 16, b, yy, 29, slate);
        Hh.box(a, yy, 14, Math.min(b, a + 3), yy, 15, trim); Hh.box(Math.max(a, b - 3), yy, 14, b, yy, 15, trim);
        if (a + 4 <= b - 4) Hh.box(a + 4, yy, 15, b - 4, yy, 15, wall);
      }
      for (const [dx, dy] of [[0, 1], [-1, 2], [0, 2], [1, 2], [-2, 3], [-1, 3], [0, 3], [1, 3], [2, 3], [-1, 4], [0, 4], [1, 4], [0, 5]]) Hh.box(62 + dx, PY0 + dy, 14, 63 + dx, PY0 + dy, 14, C.gold);
    } else {
      // back porch onto the yard: door, canopy on two posts, name plate
      for (let k = 0; k < 3; k++) { win(P, 25, k); win(P, 36, k); }
      for (let k = 1; k < 3; k++) win(P, 30, k, 3);
      door(P, 29, G, 5, 7, { color: accent, frame: trim, step: null, glass: C.pBlue, double: true });
      g.box(27, G + 8, 41, 35, G + 8, 43, trim);
      for (const px of [27, 35]) g.box(px, G, 43, px, G + 7, 43, trim);
      const B = facade(g, 'back', 40);
      B.box(26, FRZ, 1, 36, FRZ + 2, 1, C.civNavy);
      hiText(g, 'back', 40, 31.5, FRZ + 0.5, 'SCHOOL', C.signWhite, 1);
    }
    // dormers on the main slope, one each side of the tower
    for (const x of [20, 40]) {
      const zz = Z(MZ0 + 2);
      g.box(x, TOP + 2, Math.min(zz, Z(MZ0 + 4)), x + 2, TOP + 5, Math.max(zz, Z(MZ0 + 4)), trim);
      g.box(x + 1, TOP + 3, zz + (back ? 1 : -1) * 0, x + 1, TOP + 4, zz, winG);
      g.box(x - 1, TOP + 6, Math.min(zz, Z(MZ0 + 5)), x + 3, TOP + 6, Math.max(zz, Z(MZ0 + 5)), slate);
    }
  }
  // ---- ends (left/right faces of the wings)
  for (const right of [false, true]) {
    const F = facade(g, right ? 'right' : 'left', right ? 57 : 5);
    for (let k = 0; k < 3; k++) for (const u of [15, 19, 22, 32, 35, 39]) win(F, u, k);
    for (let k = 1; k < 3; k++) win(F, 26, k, 3);
    door(F, 26, G, 3, 6, { color: accent, frame: trim, step: null, glass: C.pBlue, canopy: trim });
    const cx = right ? 59 : 3;
    g.box(right ? 60 : 2, y, 25, right ? 60 : 2, PY - 2, 29, mb);
    g.box(cx, PY - 1, 25, cx, PY - 1, 29, C.signWhite);
  }
  // ---- clock tower on the ridge: shaft with quoins, clocks front/back and
  // louvres on the ends, open belfry with a bell, hip cap, gold finial
  const TX0 = 27, TX1 = 35, TZ0 = 23, TZ1 = 31, TC = 31, TB = TOP + 5, TT = TOP + 22;
  g.box(TX0, TB, TZ0, TX1, TT, TZ1, wall);
  for (const [x, z] of [[TX0, TZ0], [TX1, TZ0], [TX0, TZ1], [TX1, TZ1]]) g.box(x, TB, z, x, TT, z, quoin);
  inkEdges(g, TX0, TZ0, TX1, TZ1, TB, TT);
  for (const yy of [TT - 10, TT, TT + 1]) inkBand(g, TX0 - 1, TZ0 - 1, TX1 + 1, TZ1 + 1, 2 * yy - 1, 1, 0);
  course(g, TX0, TZ0, TX1, TZ1, TT - 10, trim);
  course(g, TX0, TZ0, TX1, TZ1, TT, trim); course(g, TX0, TZ0, TX1, TZ1, TT + 1, trim, 2);
  for (const f of [facade(g, 'front', TZ0), facade(g, 'back', TZ1)]) { clockFace(f, TC, TT - 5, accent); fineWin(g, f.side, f.plane, TC - 1, TT - 13, 3, 3, { frame: trim, trim, glass: winG, hood: false }); }
  for (const f of [facade(g, 'right', TX1), facade(g, 'left', TX0)]) { f.box(26, TT - 8, 1, 28, TT - 2, 1, trim); for (let yy = TT - 7; yy <= TT - 3; yy += 2) f.set(27, yy, 1, winG); f.box(26, TB + 2, 0, 28, TT - 12, 0, winG); }
  const BX0 = TX0 + 1, BX1 = TX1 - 1, BZ0 = TZ0 + 1, BZ1 = TZ1 - 1, BT = TT + 9;
  g.box(BX0, TT + 2, BZ0, BX1, BT, BZ1, trim);
  for (let yy = TT + 3; yy <= BT - 2; yy++) { for (let z = BZ0 + 2; z < BZ1 - 1; z++) { g.del(BX0, yy, z); g.del(BX1, yy, z); } for (let x = BX0 + 2; x < BX1 - 1; x++) { g.del(x, yy, BZ0); g.del(x, yy, BZ1); } }
  gclr(g, BX0 + 1, TT + 3, BZ0 + 1, BX1 - 1, BT - 2, BZ1 - 1);
  g.box(TC - 1, BT - 4, 26, TC + 1, BT - 2, 28, C.gold);
  course(g, BX0, BZ0, BX1, BZ1, BT, trim);
  fineHipRoof(g, BX0 - 1, BZ0 - 1, BX1 + 1, BZ1 + 1, BT + 1, 4, accent);
  g.box(TC, BT + 5, 27, TC, BT + 8, 27, C.gold);
  // roof gear, kept to a couple of quiet pieces (critic r7: noisy roofs)
  for (const x of [12, 50]) ventPipe(g, x, 27, TOP + 7, TOP + 8);
  // (w4r2) critic: ref05's civic roofs carry "rooftop AC units, vents and roof
  // clutter". AC banks and a skylight on the main block's flat top, each side
  // of the tower (fine x 24..47 and 78..101, z 46..63 are the free flats).
  { const Hr = hiGrid(g), RY = 2 * (TOP + 1) + 14;
    for (const [ax, az] of [[27, 48], [35, 48], [84, 48], [92, 48], [27, 56], [92, 56]]) fineAC(g, ax, RY, az, 6, 5);
    for (const sx of [36, 82]) { Hr.box(sx, RY, 56, sx + 7, RY, 62, trim); Hr.box(sx + 1, RY + 1, 57, sx + 6, RY + 1, 61, C.civGlass); }
  }
  // ---- forecourt: two lawns boxed by clipped hedges with flower beds, cone
  // topiaries, lamps at the stair, benches, a flag, kids on the stair
  for (const [a, b] of [[2, 18]]) {
    g.box(a, y - 1, 2, b, y - 1, 9, C.lotGrass);
    bush(g, a, y, 2, b, 2, 2); bush(g, a, y, 2, a, 9, 2); bush(g, b, y, 2, b, 9, 2);
    g.box(a + 2, y - 1, 4, b - 2, y - 1, 7, V.bushDark != null ? V.stem : C.lotGrass);   // (r9) a planted bed with fine blooms
    fineBlooms(g, a + 2, 4, b - 2, 7, y, [V.petals[0], V.petals[2], V.petals[3], V.petals[1]], 2);
    topiary(g, a === 2 ? 15 : 57, y, 7, 7);
    benchS(g, a === 2 ? 4 + 6 : 47, y, 8, 'x', 4, { seat: C.wood, flip: true });
  }
  // (w4r6) critic w4r5: "fill … the school forecourt" with vehicles and
  // props (ref05 lots carry their service vehicles). The right lawn is now a
  // painted bus drop-off: asphalt bay, yellow kerb line, a white bay, a school
  // bus at the kerb, a glazed shelter with a bench, a bike rack and kids.
  g.box(44, y - 1, 1, 61, y - 1, 9, C.lotAsphalt);
  g.box(44, y - 1, 9, 61, y - 1, 9, C.yellow);
  g.box(45, y - 1, 3, 56, y - 1, 3, C.lotLine); g.box(45, y - 1, 3, 45, y - 1, 8, C.lotLine); g.box(56, y - 1, 3, 56, y - 1, 8, C.lotLine);
  stampCar(g, 12, 46, y, 4, 1);
  { const sx0 = 56, sx1 = 60;                                     // bus shelter on the kerb strip
    g.box(sx0, y - 1, 10, sx1, y - 1, 10, C.lotPave);
    for (const x of [sx0, sx1]) g.box(x, y, 10, x, y + 6, 10, C.metalDark);
    g.box(sx0 + 1, y + 1, 10, sx1 - 1, y + 5, 10, C.civGlass);
    g.box(sx0 - 1, y + 7, 9, sx1 + 1, y + 7, 10, accent); g.box(sx0 - 1, y + 7, 9, sx1 + 1, y + 7, 9, C.signWhite); }
  for (let k = 0; k < 4; k++) g.box(47 + 2 * k, y, 10, 47 + 2 * k, y + 2, 10, C.metal);   // bike rack hoops
  g.box(47, y + 2, 10, 53, y + 2, 10, C.metal);
  for (const lx of [19, 43]) lampPost(g, lx, y, 3, 13, { small: true });
  flagPole(g, 9, y, 6, 20, [C.red, C.signWhite, C.civSeat], { w: 6, fh: 4 });   // (w4r6) 26/9×6 read as a billboard
  // side strips along the podium: hedges and small trees
  for (const [a, b] of [[1, 1], [61, 61]]) {
    bush(g, a, y, 12, b, 22, 3, { flowers: [C.red, C.yellow, C.signWhite] });
    bush(g, a, y, 32, b, 42, 3, { flowers: [C.red, C.yellow, C.signWhite] });
  }
  // ---- school yard behind: ball court (right), play frame (left), path
  // to the back porch, bike racks, benches, a low rail round the yard
  const CT0 = 38, CT1 = 60, CZ0 = 48, CZ1 = 60;
  g.box(CT0, y - 1, CZ0, CT1, y - 1, CZ1, C.civSeat);
  g.walls(CT0 + 1, y - 1, CZ0 + 1, CT1 - 1, y - 1, CZ1 - 1, C.signWhite);
  g.box(49, y - 1, CZ0 + 1, 49, y - 1, CZ1 - 1, C.signWhite);
  ringH4(g, 49, y - 1, 54, 2.2, 3.2, C.signWhite);
  for (const [hx, dir] of [[CT0 + 1, 1], [CT1 - 1, -1]]) {
    g.box(hx, y, 54, hx, y + 9, 54, C.darkGray);
    g.box(hx + dir, y + 8, 53, hx + dir, y + 11, 55, C.signWhite);
    g.set(hx + 2 * dir, y + 8, 54, C.orange);
  }
  // play frame on rubber: deck on posts, slide, climbing net, swings
  g.box(3, y - 1, 48, 24, y - 1, 60, C.civRubber);
  for (const [px, pz] of [[6, 51], [11, 51], [6, 56], [11, 56]]) g.box(px, y, pz, px, y + 9, pz, C.signWhite);
  g.box(6, y + 5, 51, 11, y + 5, 56, C.plank);
  g.walls(6, y + 6, 51, 11, y + 7, 56, accent);
  gclr(g, 6, y + 6, 51, 6, y + 7, 56);
  for (let k = 0; k < 4; k++) g.box(5 + k, y + 10 + k, 50 + k, 12 - k, y + 10 + k, 57 - k, (k & 1) ? C.signWhite : C.red);
  for (let i = 0; i < 7; i++) g.box(12 + i, y + 5 - Math.round(i * 0.75), 53, 12 + i, y + 5 - Math.round(i * 0.75), 55, C.yellow);
  for (let i = 0; i < 6; i++) { g.set(5 - (i >> 1), y + 5 - i, 52, C.darkGray); g.set(5 - (i >> 1), y + 5 - i, 55, C.darkGray); }
  for (const px of [16, 23]) { g.box(px, y, 57, px, y + 9, 57, C.civNavy); }
  g.box(16, y + 10, 57, 23, y + 10, 57, C.civNavy);
  for (const [sx, c] of [[18, C.red], [21, C.yellow]]) { g.box(sx, y + 3, 57, sx, y + 9, 57, C.darkGray); g.box(sx, y + 2, 56, sx, y + 2, 58, c); }
  // path from the porch
  g.box(26, y - 1, 47, 36, y - 1, 61, C.lotPaveDark != null ? C.lotPaveDark : C.lotPave);
  for (const bx of [27, 31]) { for (let k = 0; k < 3; k++) g.box(bx + k * 2 - 1, y, 59, bx + k * 2 - 1, y + 2, 59, C.metal); }
  benchS(g, 27, y, 49, 'z', 4, { seat: C.wood }); benchS(g, 35, y, 49, 'z', 4, { seat: C.wood, flip: true });
  railRun(g, 2, 47, 24, 47, y, C.signWhite, accent); railRun(g, 38, 47, 60, 47, y, C.signWhite, accent);
  railRun(g, 1, 47, 1, 61, y, C.signWhite, accent); railRun(g, 61, 47, 61, 61, y, C.signWhite, accent);
  lotTree(g, 'round', 3, y, 44, 4); lotTree(g, 'round', 59, y, 44, 6);
  // ---- people: parents at the stair, kids on the forecourt and in the yard
  crowd(g, [[4, 10, 18, 10], [56, 3, 60, 8]], y, 8, 7 + vi);
  crowd(g, [[4, 49, 24, 60], [39, 49, 59, 59], [27, 48, 35, 58]], y, 16, 3 + vi, { shirts: [C.red, C.yellow, C.civSeat, C.pink, C.roofGreen, C.orange] });
  crowd(g, [[22, 8, 40, 10]], PY, 5, 11 + vi);
  return doneHi(g);
}

// Yellow school bus parked along +Z (nose at z0): 5 wide × 7 tall × 13 long.
function schoolBus(g, x0, y, z0) {
  const L = 13, W = 5, Y = C.taxiYellow;
  g.box(x0 + 1, y, z0 + 1, x0 + W - 2, y, z0 + L - 2, C.darkGray);
  g.box(x0, y + 1, z0, x0 + W - 1, y + 5, z0 + L - 1, Y);
  for (const z of [z0 + 2, z0 + L - 3]) for (const x of [x0, x0 + W - 1]) g.box(x, y, z, x, y + 1, z + 1, C.black);
  for (const x of [x0, x0 + W - 1]) { g.box(x, y + 4, z0 + 2, x, y + 5, z0 + L - 2, C.civGlass); for (let z = z0 + 4; z < z0 + L - 1; z += 3) g.box(x, y + 4, z, x, y + 5, z, Y); g.box(x, y + 2, z0, x, y + 2, z0 + L - 1, C.black); }
  g.box(x0 + 1, y + 4, z0, x0 + W - 2, y + 5, z0, C.civGlass);
  g.set(x0, y + 2, z0, C.lamp); g.set(x0 + W - 1, y + 2, z0, C.lamp);
  g.box(x0 + 1, y + 6, z0 + 1, x0 + W - 2, y + 6, z0 + L - 2, C.signWhite);
  g.set(x0 + 1, y + 6, z0 + 1, C.red); g.set(x0 + W - 2, y + 6, z0 + 1, C.red);
  g.box(x0 + 1, y + 2, z0 + L - 1, x0 + W - 2, y + 2, z0 + L - 1, C.red);
}
// Horizontal ring (annulus) at y for res-4 lot paint.
function ringH4(g, cx, y, cz, r0, r1, c) {
  for (let x = Math.floor(cx - r1 - 1); x <= Math.ceil(cx + r1 + 1); x++)
    for (let z = Math.floor(cz - r1 - 1); z <= Math.ceil(cz + r1 + 1); z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d >= r0 && d < r1) g.set(x, y, z, c);
    }
}

// ---- FIRE STATION (2×2): ref05 — a broad, low brick engine house across a
// square lot with a corner watch tower, four roll-up bays opening onto big
// dark-green aprons with painted yellow bays and fire engines nosing out.
// (civic r8) Critic r7: the 1×1 station was "a narrow tall tower on a tiny
// lot" with a "cluttered, noisy" roof. Now: a 54-wide two-storey hall (bays
// 11 high, one office storey over them), a continuous FIRE STATION name on
// the frieze (like ref05's POLICE STATION), a clean green deck with three
// AC boxes, and a single tower silhouette. Drive-through, so both long
// faces carry bays and both aprons carry engines (the lens sees either).
function svcFire(rng, v) {
  // (civic r10) Critic r9: "the fire station's red and teal run together …
  // in ref05 the fire station has sharp brick coursing, deep dark window
  // reveals, dark outlines on its cornices and trim, and a busy apron with
  // fire trucks … make the civic landmarks bigger". So: a deeper, taller
  // three-storey hall (bays + two office floors) that fills the middle of the
  // lot, deep-red brick with darker brick piers and fine coursing, cream
  // stone bands each underlined in ink, a dark-sage cornice, dark-reveal
  // windows, a taller tower, and near-black aprons with a pale forecourt
  // strip in front of the doors so building and apron separate crisply.
  const g = grid(63, 84, 63, 4);
  const y = lotPlinth(g, 0, 0, 62, 62, { fill: C.civApron });
  const vi = ((v % 3) + 3) % 3;
  const wall = [C.civBrick, C.brick, C.civBrick][vi];
  // (w4r14) critic w4r13: "a flat, oversaturated red block. The ref version
  // has brick tone variation, cream trim and a green roof". civBrick is now
  // ref05's orange-red (PIL lit face ~(215,116,77)); piers + coursing step
  // down to a brown-red brick instead of crimson (which rendered (249,38,41)).
  const pierC = C.shingle != null ? C.shingle : C.brickDark;   // brown-red brick
  const stone = [C.cream, C.signWhite, C.cream][vi];
  const corn = C.civCornice, deck = C.civFireRoof, ink = INK();
  // (w4) broad and LOW (coordinator: 2-3 storeys, sprawl not up): a deeper
  // two-storey hall — the engine bays plus one office floor — under the tower.
  // (w4r2) critic: "tiny models on oversized lots … buildings should take
  // ~80% of the lot". The hall now runs kerb to kerb across X (2..60) and is
  // 39 deep (12..50): with the aprons full of engines it fills the lot.
  const X0 = 2, X1 = 60, Z0 = 12, Z1 = 50;
  const BAYH = 11, SB = y + BAYH, UW = SB + 2, FRZ = y + 19, TOP = y + 23;
  const PIERS = [22, 31, 40, 49, 58], BAYS = [[24, 30], [33, 39], [42, 48], [51, 57]];
  // ---- aprons: yellow bay lines to the kerb, white centre dashes, a pale
  // forecourt strip at the doors, a hatched box in front of the office
  for (const back of [false, true]) {
    const Z = (z) => (back ? 62 - z : z);
    g.box(19, y - 1, Z(Z0 - 4), 57, y - 1, Z(Z0 - 1), C.lotPave);
    g.box(19, y - 1, Z(Z0 - 4), 57, y - 1, Z(Z0 - 4), C.lotRim);
    for (const p of PIERS) g.box(p, y - 1, Z(2), p + 1, y - 1, Z(Z0 - 5), C.yellow);
    for (const [u0, u1] of BAYS) {
      const m = (u0 + u1) >> 1;
      for (let z = 2; z < Z0 - 5; z += 3) g.set(m, y - 1, Z(z), C.signWhite);
    }
    // (w4r6) critic w4r5: "fill the fire station apron … parked ambulances
    // and fire trucks" (ref05). The hatched keep-clear box in front of the
    // tower read as yellow clutter; it is now two marked service bays (an
    // ambulance and the chief's red SUV) beside a paved walk to the tower door.
    for (const x of [10, 16, 21]) g.box(x, y - 1, Z(1), x, y - 1, Z(8), C.lotLine);
    g.box(10, y - 1, Z(1), 21, y - 1, Z(1), C.lotLine);
    if (!back) g.box(4, y - 1, 1, 8, y - 1, 8, C.lotPave);
  }
  // (w4r8) one ambulance per apron (critic w4r7: "cut cars on civic lots";
  // ref05's apron holds three trucks and nothing else)
  stampCar(g, 7, 11.5, y, 0, 0); stampCar(g, 7, 11.5, y, 53, 2);
  // ---- the hall
  g.box(X0, y, Z0, X1, TOP, Z1, wall);
  course(g, X0, Z0, X1, Z1, y, C.civPanel);
  course(g, X0, Z0, X1, Z1, SB, stone);                           // stone band over the bays
  course(g, X0, Z0, X1, Z1, FRZ - 1, stone);
  // (w4r12) critic w4r11: "cornices that project". A three-step corbel: a
  // bed one out, the slab three out (was two), with a dark drip under it.
  course(g, X0, Z0, X1, Z1, TOP - 1, corn); course(g, X0, Z0, X1, Z1, TOP, corn, 3); course(g, X0, Z0, X1, Z1, TOP, corn, 2); course(g, X0, Z0, X1, Z1, TOP, corn);
  // ink under every stone band and under the cornice (ref05's dark trim lines)
  for (const yy of [SB, FRZ - 1]) inkBand(g, X0 - 1, Z0 - 1, X1 + 1, Z1 + 1, 2 * yy - 1, 1, 0);
  fineDentils(g, X0, Z0, X1, Z1, 2 * (TOP - 2), stone);
  fineBand(g, X0, Z0, X1, Z1, 2 * (TOP - 2) + 2, stone, 1, 1);
  inkBand(g, X0 - 1, Z0 - 1, X1 + 1, Z1 + 1, 2 * (TOP - 1) - 1, 1, 0);
  inkBand(g, X0 - 2, Z0 - 2, X1 + 2, Z1 + 2, 2 * TOP - 1, 1, 1);       // drip under the slab lip
  g.walls(X0, TOP + 1, Z0, X1, TOP + 1, Z1, wall);                 // parapet + coping
  g.walls(X0, TOP + 2, Z0, X1, TOP + 2, Z1, stone);
  g.box(X0 + 1, TOP + 1, Z0 + 1, X1 - 1, TOP + 1, Z1 - 1, deck);
  inkEdges(g, X0, Z0, X1, Z1, y + 1, SB - 1);
  const win = (f, u, fy, w = 3, h = 5) => fineWin(g, f.side, f.plane, u, fy, w, h, { frame: C.signWhite, trim: stone, key: stone, recess: true });
  // ---- both long faces: brick piers with stone quoins, four bays, office end
  for (const back of [false, true]) {
    const side = back ? 'back' : 'front', PZ = back ? Z1 : Z0;
    const F = facade(g, side, PZ);
    // (w4r12) critic w4r11: "shallow facades … deep relief". The piers now
    // stand TWO voxels proud (was one) on a stone plinth block, so each bay
    // is a deep brick recess with its door and window set back in shadow.
    for (const u of PIERS) {
      F.box(u, y, 1, u + 1, FRZ - 2, 2, pierC);
      F.box(u, y, 1, u + 1, y + 1, 3, C.civPanel);
      const Eq = hiFacade(g, side, PZ);
      // (r11) critic r10: the cream quoin ladder on every pier made the
      // front garish. ref05's piers are plain brick with two slim white
      // bands (at the bay head and the office sill) and a dark-green cap.
      for (const r of [2 * UW - 3]) Eq.box(2 * u - 1, r, 4, 2 * u + 4, r + 1, 4, stone);
      Eq.box(2 * u - 1, 2 * (FRZ - 2) + 1, 4, 2 * u + 4, 2 * (FRZ - 2) + 2, 5, corn);   // capital
      Eq.box(2 * u - 1, 2 * (FRZ - 2), 4, 2 * u + 4, 2 * (FRZ - 2), 4, ink);
    }
    BAYS.forEach(([u0, u1], i) => {
      F.box(u0 - 1, SB, 1, u1 + 1, SB, 1, stone);
      F.set((u0 + u1) >> 1, SB + 1, 1, stone);
      F.clear(u0, y, 0, u1, SB - 1, 0);
      const open = back ? i === 1 : i === 2;
      const E = hiFacade(g, side, PZ);
      E.box(2 * u0 - 1, 2 * y, 0, 2 * u0 - 1, 2 * SB - 1, 1, ink);  // dark door reveals
      E.box(2 * u1 + 2, 2 * y, 0, 2 * u1 + 2, 2 * SB - 1, 1, ink);
      if (open) {
        F.clear(u0, y, -1, u1, SB - 1, -6);
        F.box(u0, y, -7, u1, SB - 1, -7, C.darkGray);
        F.box(u0, SB - 1, -6, u1, SB - 1, -1, C.offwhite);
        F.box(u0, y - 1, 0, u1, y - 1, -6, C.concrete);
        F.box(u0, SB - 2, -1, u1, SB - 2, -1, C.civPanel);
      } else {
        F.box(u0, y, -1, u1, SB - 1, -1, C.signWhite);
        for (let r = 2 * y + 2; r < 2 * SB - 1; r += 3) E.box(2 * u0, r, -2, 2 * u1 + 1, r, -2, C.civPanel);
        E.box(2 * u0 + 2, 2 * y + 12, -2, 2 * u1 - 1, 2 * y + 13, -2, C.dtGlassDark);
        E.box(2 * u0, 2 * y, -2, 2 * u1 + 1, 2 * y, -2, C.darkGray);
      }
      win(F, u0 + 2, UW);
    });
    door(F, 17, y, 2, 7, { color: C.crimson, frame: stone, step: null, canopy: corn });
    win(F, 16, UW, 3);
    wallLamp(F, 32, SB - 1); wallLamp(F, 50, SB - 1);
    // frieze: the name in red on a cream band, ink-edged
    F.box(14, FRZ, 1, X1, FRZ + 2, 1, stone);
    F.box(25, FRZ, 1, 57, FRZ + 2, 1, C.signWhite);
    hiText(g, side, PZ, 41, FRZ + 0.5, 'FIRE STATION', C.fireRed, 1);
    brickCourse(g, side, PZ, X0, X1, y + 1, FRZ - 2, wall, pierC);
  }
  // ---- ends
  const R = facade(g, 'right', X1);
  // (w4r12) the end wall gets the same proud piers (corners + door pair)
  for (const u of [12, 27, 33, 49]) { R.box(u, y, 1, u + 1, FRZ - 2, 2, pierC); R.box(u, y, 1, u + 1, y + 1, 3, C.civPanel); R.box(u, FRZ - 2, 3, u + 1, FRZ - 2, 3, corn); }
  for (const u of [15, 20, 25, 36, 41, 46]) win(R, u, UW, 2);
  door(R, 30, y, 2, 7, { color: C.crimson, frame: stone, step: null, canopy: corn });
  for (const u of [16, 24, 37, 45]) win(R, u, y + 3, 2, 4);
  wallAC(R, 20, y + 8, { w: 3, h: 2, d: 1 }); wallAC(R, 40, y + 8, { w: 3, h: 2, d: 1 });
  brickCourse(g, 'right', X1, Z0, Z1, y + 1, FRZ - 2, wall, pierC);
  inkEdges(g, X0, Z0, X1, Z1, SB + 1, FRZ - 2);
  // ---- watch tower on the left end, proud of the front: quoins, stone
  // bands, tall windows, clocks front and back, a louvred lantern and flag
  const tx0 = 2, tx1 = 12, tz0 = 9, tz1 = 25, TT = TOP + 13;
  g.box(tx0, y, tz0, tx1, TT, tz1, wall);
  course(g, tx0, tz0, tx1, tz1, y, C.civPanel);
  for (const [x, z] of [[tx0, tz0], [tx1, tz0], [tx0, tz1], [tx1, tz1]]) g.box(x, y + 1, z, x, TT - 3, z, pierC);   // (r11) plain dark-brick corners, no quoin ladder
  course(g, tx0, tz0, tx1, tz1, SB, stone); course(g, tx0, tz0, tx1, tz1, FRZ - 1, stone); course(g, tx0, tz0, tx1, tz1, TOP + 2, stone);
  course(g, tx0, tz0, tx1, tz1, TT - 2, corn); course(g, tx0, tz0, tx1, tz1, TT - 1, corn); course(g, tx0, tz0, tx1, tz1, TT, corn, 2);
  for (const yy of [SB, FRZ - 1, TOP + 2]) inkBand(g, tx0 - 1, tz0 - 1, tx1 + 1, tz1 + 1, 2 * yy - 1, 1, 0);
  inkBand(g, tx0 - 1, tz0 - 1, tx1 + 1, tz1 + 1, 2 * (TT - 2) - 1, 1, 0);
  g.box(tx0, TT + 1, tz0, tx1, TT + 1, tz1, stone);
  inkEdges(g, tx0, tz0, tx1, tz1, TOP + 3, TT - 3);
  { const f = facade(g, 'front', tz0);
    door(f, 6, y, 3, 8, { color: C.crimson, frame: stone, step: null, glass: C.civGlass });
    win(f, 6, UW, 3, 5); win(f, 6, TOP + 4, 3, 6);
    clockFace(f, 7, TT - 6, C.civNavy);
    brickCourse(g, 'front', tz0, tx0, tx1, y + 1, TT - 3, wall, pierC); }
  { const f = facade(g, 'back', tz1); win(f, 6, TOP + 4, 3, 6); clockFace(f, 7, TT - 6, C.civNavy); }
  { const f = facade(g, 'left', tx0);
    for (const u of [13, 19]) { win(f, u, y + 3, 2, 5); win(f, u, UW, 2, 5); win(f, u, TOP + 4, 2, 6); }
    for (const u of [29, 34, 39, 44]) { win(f, u, y + 3, 2, 5); win(f, u, UW, 2, 5); }
    brickCourse(g, 'left', tx0, tz0, Z1, y + 1, TT - 3, wall, pierC); }
  { const f = facade(g, 'right', tx1); for (const u of [13, 19]) win(f, u, TOP + 4, 2, 6);
    brickCourse(g, 'right', tx1, tz0, tz1, TOP + 3, TT - 3, wall, pierC); }
  // lantern + hip cap + flag (one clean silhouette)
  g.box(tx0 + 2, TT + 2, tz0 + 2, tx1 - 2, TT + 7, tz1 - 2, corn);
  for (const [sd, pl, u0, u1] of [['front', tz0 + 2, tx0 + 2, tx1 - 2], ['back', tz1 - 2, tx0 + 2, tx1 - 2], ['left', tx0 + 2, tz0 + 2, tz1 - 2], ['right', tx1 - 2, tz0 + 2, tz1 - 2]]) {
    const E = hiFacade(g, sd, pl);
    for (let u = 2 * u0 + 2; u + 1 <= 2 * u1 - 1; u += 4) {
      E.box(u, 2 * TT + 6, -1, u + 1, 2 * TT + 12, -1, C.civNavy);
      for (let r = 2 * TT + 7; r <= 2 * TT + 11; r += 2) E.box(u, r, 0, u + 1, r, 0, stone);
    }
    E.box(2 * u0, 2 * TT + 14, 0, 2 * u1 + 1, 2 * TT + 14, 0, stone);
    E.box(2 * u0, 2 * TT + 13, 0, 2 * u1 + 1, 2 * TT + 13, 0, ink);
  }
  inkEdges(g, tx0 + 2, tz0 + 2, tx1 - 2, tz1 - 2, TT + 2, TT + 6);
  fineHipRoof(g, tx0 + 1, tz0 + 1, tx1 - 1, tz1 - 1, TT + 8, 4, deck);
  flagPole(g, 7, TT + 12, 17, 8, [C.red, C.signWhite, C.civSeat], { w: 6, fh: 4 });
  // ---- roof (w4r11). Critic w4r10: "the fire station roof is a big flat
  // mint-green slab with a few grey boxes and solar panels … ref05 has dense
  // rooftop equipment and railings … break up civic roofs with parapets,
  // varied equipment and colour changes". The deck is a darker sage (ref05
  // PIL ~(100,136,98); ours rendered (120,191,136)), the pale paver grid that
  // tiled it mint is gone, and the roof is zoned: a cream plant-room
  // penthouse (its own parapet, ink line, door, louvres, AC units on top)
  // beside the tower, a railed front walk, a bank of white condensers with
  // red caps on a grey pad, a glazed ridge skylight, a grey solar pad, the
  // water tank and a mast, joined by grey paver walks and duct runs.
  { const PX0 = 14, PX1 = 26, PZ0 = 30, PZ1 = 47, PT = TOP + 6;
    g.box(PX0, TOP + 2, PZ0, PX1, PT - 1, PZ1, stone);
    g.box(PX0 + 1, PT - 1, PZ0 + 1, PX1 - 1, PT - 1, PZ1 - 1, C.civPanel);
    g.walls(PX0, PT, PZ0, PX1, PT, PZ1, stone);
    inkBand(g, PX0, PZ0, PX1, PZ1, 2 * PT - 1, 1, 0);
    inkBand(g, PX0, PZ0, PX1, PZ1, 2 * (TOP + 2), 1, 0);
    inkEdges(g, PX0, PZ0, PX1, PZ1, TOP + 2, PT - 1);
    const pf = facade(g, 'front', PZ0);
    pf.box(18, TOP + 2, 0, 20, TOP + 4, 0, C.civNavy); pf.box(17, TOP + 5, 1, 21, TOP + 5, 1, corn);
    pf.box(23, TOP + 3, 0, 24, TOP + 4, 0, C.metal);
    const pr = facade(g, 'right', PX1);
    for (const u of [33, 38, 43]) { pr.box(u, TOP + 3, 0, u + 2, TOP + 4, 0, C.metalDark); pr.box(u, TOP + 3, 1, u + 2, TOP + 3, 1, C.metal); }
    const pb = facade(g, 'back', PZ1); pb.box(18, TOP + 3, 0, 22, TOP + 4, 0, C.metalDark);
  }
  { const Hr = hiGrid(g), RY = 2 * (TOP + 2), PY = 2 * (TOP + 6);
    // pale walk inside the parapet on all four sides, with a fine guard rail
    // on the coping along the two lens-facing edges (front + right)
    Hr.box(26, RY, 26, 117, RY, 27, C.civPanel); Hr.box(26, RY, 98, 117, RY, 99, C.civPanel);
    Hr.box(116, RY, 26, 117, RY, 99, C.civPanel);
    const CY = 2 * (TOP + 3);                                        // top of the stone coping
    for (let x = 26; x <= 120; x += 6) Hr.box(x, CY, 24, x, CY + 3, 24, C.metalDark);
    Hr.box(26, CY + 3, 24, 121, CY + 3, 24, C.metal);
    for (let z = 24; z <= 102; z += 6) Hr.box(120, CY, z, 120, CY + 3, z, C.metalDark);
    Hr.box(120, CY + 3, 24, 120, CY + 3, 102, C.metal);
    // grey paver walks: penthouse door → condenser pad → tank
    Hr.box(36, RY, 28, 39, RY, 59, C.civPanel);
    Hr.box(40, RY, 56, 103, RY, 59, C.civPanel);
    // condenser pad (grey) with 2 × 5 white units, red caps, fan grilles
    Hr.box(44, RY, 30, 99, RY, 52, C.concrete);
    for (const az of [32, 43]) for (let ax = 46; ax <= 90; ax += 11) {
      Hr.box(ax, RY + 1, az, ax + 7, RY + 5, az + 7, C.offwhite);
      Hr.box(ax, RY + 6, az, ax + 7, RY + 6, az + 7, C.civPanel);
      Hr.box(ax + 2, RY + 6, az + 2, ax + 5, RY + 6, az + 5, C.metalDark);
      Hr.box(ax + 3, RY + 7, az + 3, ax + 4, RY + 7, az + 4, C.metal);
      Hr.box(ax + 1, RY + 4, az - 1, ax + 3, RY + 4, az - 1, C.fireRed);   // a small red badge (ref05)
      Hr.box(ax, RY + 1, az, ax + 7, RY + 1, az, C.darkGray);
    }
    // plant-room roof: three AC units and a vent stack
    fineAC(g, 31, PY, 64, 6, 6); fineAC(g, 40, PY, 64, 6, 6); fineAC(g, 31, PY, 80, 6, 6);
    Hr.box(44, PY, 84, 45, PY + 6, 85, C.metal); Hr.box(43, PY + 7, 83, 46, PY + 7, 86, C.metalDark);
    // glazed ridge skylight down the middle of the back half
    Hr.box(60, RY, 66, 99, RY + 1, 92, stone);
    Hr.box(61, RY + 2, 67, 98, RY + 2, 91, C.civGlass);
    Hr.box(61, RY + 3, 72, 98, RY + 3, 86, C.civGlass);
    Hr.box(61, RY + 4, 77, 98, RY + 4, 81, stone);
    for (let x = 64; x <= 96; x += 5) Hr.box(x, RY + 2, 67, x, RY + 3, 91, stone);
    // solar pad on the right (grey gravel, three framed rows)
    Hr.box(104, RY, 62, 115, RY, 96, C.concrete);
    for (let r = 0; r < 4; r++) {
      const z0 = 63 + r * 8;
      Hr.box(105, RY + 1, z0, 114, RY + 1, z0 + 5, C.metalDark);
      Hr.box(105, RY + 2, z0, 114, RY + 2, z0 + 5, C.civNavy);
      Hr.box(105, RY + 2, z0 + 2, 114, RY + 2, z0 + 2, C.civGlass);
    }
    // water tank on four legs (front-right, next to the pad)
    { const tx = 104, tz = 34;
      for (const [lx, lz] of [[0, 0], [7, 0], [0, 7], [7, 7]]) Hr.box(tx + lx, RY, tz + lz, tx + lx, RY + 5, tz + lz, C.metalDark);
      Hr.box(tx - 1, RY + 6, tz - 1, tx + 8, RY + 13, tz + 8, C.offwhite);
      Hr.box(tx - 1, RY + 9, tz - 1, tx + 8, RY + 9, tz + 8, C.fireRed);
      Hr.box(tx, RY + 14, tz, tx + 7, RY + 14, tz + 7, C.metalDark); }
    // duct run from the condensers to the plant room, on low stands
    Hr.box(52, RY + 2, 62, 55, RY + 3, 95, C.metal);
    for (let z = 64; z <= 94; z += 8) Hr.box(52, RY, z, 55, RY + 1, z, C.metalDark);
    Hr.box(50, RY + 2, 62, 55, RY + 3, 63, C.metal);
    // vents + a stair hatch + the radio mast
    for (const [vx, vz] of [[30, 34], [104, 50], [70, 96]]) { Hr.box(vx, RY, vz, vx + 1, RY + 4, vz + 1, C.metal); Hr.box(vx - 1, RY + 5, vz - 1, vx + 2, RY + 5, vz + 2, C.metalDark); }
    Hr.box(88, RY, 94, 95, RY + 3, 97, C.offwhite); Hr.box(88, RY + 4, 94, 95, RY + 4, 97, C.metalDark);
    Hr.box(112, RY, 92, 112, RY + 22, 92, C.metalDark);
    for (const yy of [RY + 8, RY + 15]) Hr.box(110, yy, 90, 114, yy, 94, C.metal);
    Hr.set(112, RY + 23, 92, C.red);
  }
  // ---- engines nosing out onto both aprons, a chief's car, ambulance,
  // hydrants, cones, hose reels, bollards, crew
  // (w4r2) the aprons are 11 deep now: engines (9 long) fill each bay to
  // the kerb, and the one in the open bay noses half out of the door.
  // (w4r8) critic w4r7: "cut trees and cars on civic lots by ~60% … the fire
  // station's apron with three trucks" (ref05). Two engines per apron (one
  // at the kerb, one nosing out of the open bay) + one ambulance, so the
  // yellow bay lines and the doors read; the chief's cars and cones are gone.
  fireTruck(g, 24, y, 1, 'z', { len: 11 }); fireTruck(g, 42, y, 6, 'z', { len: 11 });
  fireTruck(g, 51, y, 51, 'z', { len: 11, rev: true }); fireTruck(g, 33, y, 46, 'z', { len: 11, rev: true });
  hydrant(g, 61, y, 10); hydrant(g, 61, y, 52); hydrant(g, 1, y, 52);
  for (const z of [9, 51]) { g.box(19, y, z, 21, y + 2, z + 1, C.fireRed); g.box(20, y + 1, z, 20, y + 1, z + 1, C.metal); }
  benchS(g, 2, y, 2, 'z', 4, { seat: C.wood, flip: true }); bin(g, 2, y, 7);
  for (const z of [1, 61]) { g.box(9, y, z, 9, y + 2, z, C.yellow); g.set(9, y + 2, z, C.signWhite); }
  crowd(g, [[4, 2, 8, 7], [3, 53, 9, 60], [22, 8, 58, 10], [22, 52, 58, 54]], y, 6, 61 + vi, { shirts: [C.civNavy, C.fireRed, C.yellow] });
  return doneHi(g);
}

// ---- FOUNTAIN (2×2): the ref05 monument plaza (civic r9 rebuild).
// Critic r8 (worst case): "a stack of plain grey slabs around a flat blue
// pool. The reference has a carved, stepped obelisk on a terracotta plaza
// with statues, twin fountains and a hedge border." So: a warm terracotta
// plaza ringed by a lumpy clipped hedge, a two-tier WHITE marble base (no
// grey risers) dressed at res 8 with plinth mouldings, pilasters and a
// cornice, a finely stepped 22-step stair with sloped cheeks and lamp newels
// on every side, raised twin pools with little jets beside each stair,
// white raised-arm statues on the tier corners, and a res-8 core: a three-
// stage carved pedestal (plaques, corner pilasters, a fluted collar) under
// a chamfered, tapering obelisk with a carved band, relief panels and a
// pyramidion. The fountain is a narrow round channel round the pedestal
// with a ring of sixteen arcing jets (the spinner) — no flat top pool.
// Heroic standing figure (res 4, ~11 tall) on y: two legs, a cloaked torso,
// head, one arm raised toward `dir` (±1 along X).
function statueFig(g, x, y, z, c, dir = 1) {
  g.box(x - 1, y, z, x - 1, y + 3, z, c); g.box(x + 1, y, z, x + 1, y + 3, z, c);
  g.box(x - 1, y + 1, z - 1, x + 1, y + 2, z - 1, c);                 // cloak hem
  g.box(x - 1, y + 4, z - 1, x + 1, y + 7, z + 1, c);
  g.box(x, y + 8, z, x, y + 9, z, c); g.set(x, y + 8, z - 1, c);
  g.box(x + 2 * dir, y + 6, z, x + 2 * dir, y + 10, z, c); g.set(x + 2 * dir, y + 11, z, C.gold);
  g.box(x - 2 * dir, y + 4, z, x - 2 * dir, y + 6, z, c);
}
// Res-8 figure with both arms raised (ref05's monument statues), centred on
// fine cell (x, z), standing on fine row y. ~15 fine (under half a tile) tall.
export function fineStatue(H, x, y, z, c) {
  H.box(x - 1, y, z, x - 1, y + 4, z, c); H.box(x + 1, y, z, x + 1, y + 4, z, c);
  H.box(x - 1, y + 3, z - 1, x + 1, y + 9, z + 1, c);
  H.box(x, y + 10, z - 1, x, y + 11, z, c);
  for (const s of [-1, 1]) {
    H.set(x + 2 * s, y + 8, z, c); H.set(x + 2 * s, y + 9, z, c); H.set(x + 2 * s, y + 10, z, c);
    H.set(x + 3 * s, y + 11, z, c); H.set(x + 3 * s, y + 12, z, c); H.set(x + 4 * s, y + 13, z, c);
  }
}
// Lumpy clipped hedge (ref05 monument border): a row of 4-voxel cubes of
// staggered heights with rounded tops and a darker foot, along the longer
// axis of x0..x1 × z0..z1.
export function lumpHedge(g, x0, z0, x1, z1, y, seed = 0, hmax = 99, col = V.bush, foot = V.bushDark) {
  const alongX = (x1 - x0) >= (z1 - z0);
  const a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1, HS = [5, 6, 5, 6, 4, 6, 5].map((h) => Math.min(h, hmax));   // (w4r5) a touch taller, like ref05's shrub row
  const B = (p0, yy0, p1, yy1, c) => (alongX ? g.box(p0, yy0, z0, p1, yy1, z1, c) : g.box(x0, yy0, p0, x1, yy1, p1, c));
  for (let a = a0, i = seed; a <= a1; a += 4, i++) {
    const b = Math.min(a1, a + 2), h = HS[i % HS.length];
    B(a, y, b, y + h - 1, col);                                    // a clipped cube
    B(a, y, b, y, foot);                                           // darker foot
    if (b + 1 <= a1) { B(b + 1, y, b + 1, y + h - 3, col); B(b + 1, y, b + 1, y, foot); }   // the dip between lumps
    const m = (a + b) >> 1;
    if (alongX) { g.set(m, y + h - 2, z0, V.leafDot); g.set(a, y + 1, z1, V.leafDot); } else { g.set(x0, y + h - 2, m, V.leafDot); g.set(x1, y + 1, a, V.leafDot); }
  }
}
// Delete an inclusive box of voxels (grid.box ignores a null colour).
export function gclr(g, x0, y0, z0, x1, y1, z1) {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) g.del(x, y, z);
}
// (w4r11) Continuous shrub row, ref05's monument hedge: critic w4r10 read the
// lumpHedge cubes (gaps between them, one flat dark colour) as "loose
// blocks". A solid 3-high body runs the whole length; rounded 3-wide lumps
// (centre column full height, shoulders one lower) rise from it in the
// canopy olive with a darker foot row and a few dark leaf dots.
export function shrubRow(g, x0, z0, x1, z1, y, seed = 0, hmax = 6, col = V.bush, foot = V.bushDark) {
  const alongX = (x1 - x0) >= (z1 - z0);
  const a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1;
  const B = (p0, yy0, p1, yy1, c, q0, q1) => {
    const lo = q0 != null ? q0 : (alongX ? z0 : x0), hi = q1 != null ? q1 : (alongX ? z1 : x1);
    return alongX ? g.box(p0, yy0, lo, p1, yy1, hi, c) : g.box(lo, yy0, p0, hi, yy1, p1, c);
  };
  B(a0, y, a1, y + 2, col); B(a0, y, a1, y, foot);
  const HS = [0, 1, 0, 1, 1, 0, 1];
  const Hh = hiGrid(g), lo = alongX ? z0 : x0, hi = alongX ? z1 : x1;
  const FB = (p0, yy0, p1, yy1, q0, q1, c) => (alongX ? Hh.box(p0, yy0, q0, p1, yy1, q1, c) : Hh.box(q0, yy0, p0, q1, yy1, p1, c));
  for (let a = a0, i = seed; a <= a1; a += 3, i++) {
    const e = Math.min(a1, a + 2), h = hmax - HS[i % HS.length];
    B(a, y + 3, e, y + h - 2, col);                                  // the lump body
    // a fine rounded crown (one inset fine layer) so the tops read as
    // clipped round shrubs, not battlements
    const r = 2 * (y + h - 1);
    FB(2 * a + 1, r, 2 * e, r, 2 * lo + 1, 2 * hi, col);
    if (alongX) { g.set(a, y + h - 3, z0, V.leafDot); g.set(e, y + 1, z1, V.leafDot); }
    else { g.set(x0, y + h - 3, a, V.leafDot); g.set(x1, y + 1, e, V.leafDot); }
  }
}
const FT_WATER = 21;                         // fine (res-8) row: top of the channel water (T2 - 1)
const FT_SY = 6;                             // spinner height, fine voxels
function svcFountain(rng, v) {
  const g = grid(63, 96, 63, 4);
  const y = lotPlinth(g, 0, 0, 62, 62, { fill: C.civPlaza });
  const vi = ((v % 3) + 3) % 3;
  const mb = C.civMarble, lip = C.signWhite, relief = C.civStone != null ? C.civStone : C.cream;
  // (w4) gold plaques rendered as flat orange tiles on the white pedestal
  // (gallery shows v1); ref05's reliefs are dark carved panels.
  // (w4r8) bronze plaques read as teal tiles on the white pedestal; ref05's
  // pedestal panels are carved in the same pale stone.
  const plaque = relief;
  const c = 31, H = hiGrid(g), O = 63;
  // fine helpers: x/z are centre-relative fine offsets, y absolute fine rows,
  // all ranges half-open. sb() boxes in a side frame: `a` outward along the
  // side normal n, `b` across it (tangent (-nz, nx)).
  const hb = (x0, x1, y0, y1, z0, z1, col) => {
    if (!(x1 > x0 && y1 > y0 && z1 > z0)) return;
    if (col != null) { H.box(O + x0, y0, O + z0, O + x1 - 1, y1 - 1, O + z1 - 1, col); return; }
    for (let xx = x0; xx < x1; xx++) for (let yy = y0; yy < y1; yy++) for (let zz = z0; zz < z1; zz++) H.del(O + xx, yy, O + zz);
  };
  const sq = (s, y0, y1, col) => hb(-s, s, y0, y1, -s, s, col);
  const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const sb = ([nx, nz], a0, a1, b0, b1, y0, y1, col) => {
    const tx = -nz, tz = nx;
    const xs = [nx * a0 + tx * b0, nx * a1 + tx * b1], zs = [nz * a0 + tz * b0, nz * a1 + tz * b1];
    hb(Math.min(...xs), Math.max(...xs), y0, y1, Math.min(...zs), Math.max(...zs), col);
  };
  const sbm = (n, a0, a1, b0, b1, y0, y1, col) => { sb(n, a0, a1, b0, b1, y0, y1, col); sb(n, a0, a1, -b1, -b0, y0, y1, col); };
  // res-4 cell rect for a side-frame offset box (offsets in res-4 units from the lot centre 31.5)
  const cellRect = ([nx, nz], a0, a1, b0, b1) => {
    const tx = -nz, tz = nx;
    const xs = [nx * a0 + tx * b0, nx * a1 + tx * b1], zs = [nz * a0 + tz * b0, nz * a1 + tz * b1];
    return [Math.ceil(31.5 + Math.min(...xs)), Math.ceil(31.5 + Math.min(...zs)), Math.floor(31.5 + Math.max(...xs)) - 1, Math.floor(31.5 + Math.max(...zs)) - 1];
  };
  const F0 = 2 * y, T1 = 2 * (y + 5), T2 = 2 * (y + 9);        // fine: plaza, tier-1 top, tier-2 top
  // ---- lumpy hedge border with gaps at the four stair walks
  // (w4r6) tall clipped lumps at the corners only; a LOW box hedge in front
  // of the twin pools so the water reads over it (ref05's pools show over a
  // low shrub edge)
  // (w4r9) critic w4r8: "ref05's version sits on warm brown earth inside a
  // dark green hedge ring that frames it" — the ring is now dark olive
  // civHedge (it was the lime canopy band) and runs unbroken except at the
  // four walks.
  // (w4r11) civHedge re-tuned 0x2e420a → 0x587810: the dark value rendered
  // blue-green (88,135,96) and the canopy band renders lime; ref05 ~(87,130,23)
  const HG = C.civHedge != null ? C.civHedge : V.bush;
  // (w4r10) critic w4r9: the monument was "boxed in by hedges" — the corner
  // lumps are capped at 5 (were 6) and the corner shrub clumps thinned.
  // (w4r11) critic w4r10: "the monument plaza's hedges … look like loose
  // blocks". One continuous rounded shrub row per edge segment (ref05 PIL:
  // hedge median (87,130,23) — ours rendered blue-green (88,135,96) from the
  // dark civHedge, so the body is the canopy olive with a dark foot).
  for (const [p0, p1] of [[1, 23], [39, 61]]) {
    shrubRow(g, p0, 1, p1, 3, y, p0, 6, HG, HG); shrubRow(g, p0, 59, p1, 61, y, p0 + 2, 6, HG, HG);
    shrubRow(g, 1, p0, 3, p1, y, p0 + 1, 6, HG, HG); shrubRow(g, 59, p0, 61, p1, y, p0 + 3, 6, HG, HG);
  }
  // ---- (w4r13) critic w4r12: "the monument lot is mostly flat pale beige
  // … colour variety in the paving". A paved processional walk from each
  // hedge gap to its stair: warm stone slabs with a brick-red edge course and
  // a tan band every 3 (grey slabs added to the 'grey' read), so the earth plaza is quartered by designed walks
  // (ref05's plaza has paths to the stairs between the planted quarters).
  for (const n of SIDES) {
    const [ax0, az0, ax1, az1] = cellRect(n, 21.5, 31.5, -7, 7);
    g.box(ax0, y - 1, az0, ax1, y - 1, az1, C.civStone != null ? C.civStone : C.lotPave);
    const alongX = n[0] !== 0;
    for (let a = alongX ? ax0 : az0; a <= (alongX ? ax1 : az1); a += 3) {
      if (alongX) g.box(a, y - 1, az0 + 1, a, y - 1, az1 - 1, C.civPlaza); else g.box(ax0 + 1, y - 1, a, ax1 - 1, y - 1, a, C.civPlaza);
    }
    // (w4r14) pale kerb edge (the brick-red course added to w4r13's "red
    // scatter" read)
    if (alongX) { g.box(ax0, y - 1, az0, ax1, y - 1, az0, C.lotRim); g.box(ax0, y - 1, az1, ax1, y - 1, az1, C.lotRim); }
    else { g.box(ax0, y - 1, az0, ax0, y - 1, az1, C.lotRim); g.box(ax1, y - 1, az0, ax1, y - 1, az1, C.lotRim); }
  }
  // (w4r14) critic w4r13: "let the monument plaza be symmetric paving and
  // water" (ref05: pools flank the base). The corner statue groups among
  // shrubs are gone; the reflecting pools moved into them (below), one in each
  // corner between two stairs, so every snap sees the same symmetric plaza.
  // ---- two-tier white base (res 4) with the stair notches cut out
  // (w4r9) the base shrank (tier 1 ±18.5 → ±16, tier 2 ±14.5 → ±12.5) so the
  // warm earth plaza shows round it, as in ref05 (critic w4r8: "pale")
  g.box(16, y, 16, 47, y + 4, 47, mb);
  g.box(19, y + 5, 19, 44, y + 8, 44, mb);
  gclr(g, 25, y, 16, 37, y + 4, 18); gclr(g, 25, y, 45, 37, y + 4, 47);
  gclr(g, 16, y, 25, 18, y + 4, 37); gclr(g, 45, y, 25, 47, y + 4, 37);
  gclr(g, 20, y + 8, 20, 43, y + 8, 43);                     // the fine core takes over here
  // ---- res-8 dressing of the tiers: plinth moulding, pilasters, cornice
  for (const n of SIDES) {
    sbm(n, 32, 33, 13, 33, F0, F0 + 2, mb);                        // tier 1 (face at a 32)
    sbm(n, 32, 34, 13, 34, T1 - 3, T1, lip);
    // (w4r8) critic w4r7: "the monument's lower tiers are a busy mass of
    // small grey blocks; the reference uses fewer, larger stepped tiers".
    // The tier pilasters, quoin strips, lamp newels, pool jets, tier-2 posts
    // and pedestal buttresses are gone: two broad clean tiers (plinth
    // moulding + cornice only), a plain stair with sloped cheeks, and a
    // three-step pedestal.
    sbm(n, 25, 26, 13, 26, T1, T1 + 2, mb);                        // tier 2 (face at a 25)
    sbm(n, 25, 27, 13, 27, T2 - 3, T2, lip);
    // ---- the stair: 18 fine steps from the plaza to the tier-2 top
    for (let s = 0; s < 18; s++) sb(n, 42 - s, 43 - s, -11, 11, F0, F0 + 1 + s, mb);
    for (let s = 0; s < 18; s += 2) sb(n, 42 - s, 43 - s, -11, 11, F0 + s, F0 + 1 + s, lip);   // pale nosings
    // sloped cheeks with a white coping
    for (let a = 25; a < 43; a++) {
      const ct = Math.min(T2 + 3, Math.max(F0 + 5, F0 + 1 + (42 - a) + 3));
      sbm(n, a, a + 1, 11, 13, F0, ct - 1, mb); sbm(n, a, a + 1, 11, 13, ct - 1, ct, lip);
    }
    // ---- (w4r6) TWIN reflecting pools flanking every stair, ref05: critic
    // w4r5 "the reference monument plaza has blue pool fountains at its base,
    // while ours reads mostly white/grey with small blue accents". Each pool
    // now fills the plaza between the tier-1 face and the hedge (15 × 22 fine,
    // was one 12 × 20 pool per side) in ref05's bright cyan (PIL ref pool
    // ~(88,210,220)): a white kerb, cyan water with a pale sheen band and one
    // low jet in the middle.
    // (w4r11) critic w4r10: the pools "look like loose blocks" — the basins
    // now butt against the tier-1 plinth (were 3 fine clear of it), so they
    // read as carved into the monument's base, as in ref05.
    // (w4r12) critic w4r11: "the base is cluttered with blue fountain pools
    // … ref05's monument is slender and elegant". ONE pool per face (a
    // pinwheel, so the two faces the lens sees each show one, as in ref05)
    // instead of a twin pair; the other side of each stair is open earth.

    // ---- relief plaques on the pedestal's first stage
    // (w4r12) the pedestal is slimmer (stages 22/18/16 fine wide, were
    // 28/24/22 over a 30-wide foot) so the needle rises out of a light base
    sb(n, 11, 12, -7, 7, T2 + 3, T2 + 9, lip);
    sb(n, 12, 13, -5, 5, T2 + 4, T2 + 8, plaque);
    // raised panels on the second stage, flutes on the collar
    sb(n, 9, 10, -4, 4, T2 + 12, T2 + 18, lip);
    sb(n, 10, 11, -2, 2, T2 + 13, T2 + 17, relief);
    for (let b = -7; b <= 6; b += 3) sb(n, 8, 9, b, b + 1, T2 + 20, T2 + 24, lip);
  }
  // ---- (w4r14) four square reflecting pools, one in each plaza corner
  // between two stairs (fine 32..52 from the centre): white kerb, a bright
  // civPoolLt sheet with a 1-fine waterLight edge (waterLight alone rendered
  // royal blue in the tier's shade), a small white jet in the middle.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const box = (a0, a1, y0, y1, col) => hb(sx > 0 ? a0 : -a1, sx > 0 ? a1 : -a0, y0, y1, sz > 0 ? a0 : -a1, sz > 0 ? a1 : -a0, col);
    box(33, 53, F0, F0 + 3, lip);
    box(34, 52, F0, F0 + 2, C.waterLight); box(34, 52, F0 + 2, F0 + 3, null);
    box(35, 51, F0 + 1, F0 + 2, C.civPoolLt);
    box(42, 44, F0 + 2, F0 + 5, lip); box(42, 44, F0 + 5, F0 + 6, C.civPoolLt);
  }
  // ---- tier-1 corner statues (white, arms raised) and tier-2 corner posts
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const cx = sx * 29, cz = sz * 29;
    hb(cx - 3, cx + 3, T1, T1 + 6, cz - 3, cz + 3, mb); hb(cx - 4, cx + 4, T1 + 6, T1 + 7, cz - 4, cz + 4, lip);
    fineStatue(H, O + cx, T1 + 7, O + cz, lip);
  }
  // ---- the core floor: marble, a narrow round water channel, a white rim
  for (let i = -25; i < 25; i++) for (let k = -25; k < 25; k++) {
    const r = Math.hypot(i + 0.5, k + 0.5);
    if (r >= 20.5 && r < 24) {
      H.set(O + i, T2 - 2, O + k, (r < 21.3 || r >= 23.2) ? C.civPool : C.civPoolLt);
    } else {
      H.set(O + i, T2 - 2, O + k, mb); H.set(O + i, T2 - 1, O + k, mb);
      if (r >= 24 && r < 25.2) H.set(O + i, T2, O + k, lip);
    }
  }
  // ---- pedestal: three carved stages. (w4) Broader and more decisive, like
  // ref05's: a wide plaque stage, a buttressed middle stage, a fluted collar,
  // then a THICK shaft (the r10 one was a slim banded column — "lighthouse").
  sq(13, T2, T2 + 2, mb); sq(11, T2 + 2, T2 + 10, mb);
  sq(12, T2 + 10, T2 + 11, lip);
  sq(9, T2 + 11, T2 + 19, mb);
  sq(10, T2 + 19, T2 + 20, lip);
  sq(8, T2 + 20, T2 + 25, mb);
  sq(9, T2 + 25, T2 + 26, lip);
  // ---- obelisk (w4r7). Critic w4r6: "the monument's obelisk is a plain grey
  // stack of blocks with little carved detail". The old shaft stepped in four
  // times (18 → 10 fine) and every set-back drew a lit ledge, so it read as
  // stacked blocks; its framed relief panel read as a window. Now: a carved
  // lower drum (sunken panels holding a proud laurel wreath with ribbon tails,
  // a dentilled collar), then ONE smooth shaft that tapers only by its
  // growing corner chamfer (no ledges) with a long sunken flute on every face
  // (two vertical shadow lines, dressed stone), a chamfered pyramidion and a
  // gold tip. Raised-arm figures stand on the four pedestal buttresses round
  // the shaft foot, like ref05's.
  // (w4r9) critic w4r8 pair: our obelisk stood ~1.4 lot widths tall and
  // twice ref05's girth (a "lighthouse"); ref05's is a slim needle about
  // 0.6 lot widths over the plaza. Drum 30 → 16 fine, shaft 16 → 12 fine
  // wide and 74 → 50 tall.
  // (w4r12) critic w4r11: "its obelisk is squat … ref05's is slender".
  // Same overall height, but the pedestal is lower and slimmer, the drum
  // 14 wide (was 18) and the shaft 10 wide (was 12) and 70 tall (was 50):
  // ~1:7, ref05's needle.
  const S0 = T2 + 26, SM = S0 + 12, S1 = SM + 70;
  const csq = (h, y0, y1, cf, col) => {                             // chamfered square, corner cut cf
    for (let yy = y0; yy < y1; yy++) for (let i = -h; i < h; i++) for (let k = -h; k < h; k++) {
      const ex = Math.min(i + h, h - 1 - i), ez = Math.min(k + h, h - 1 - k);
      if (ex + ez < cf) continue;
      H.set(O + i, yy, O + k, col);
    }
  };
  csq(7, S0, SM, 1, mb);                                            // lower drum
  for (let yy = SM; yy < S1; yy++) csq(5, yy, yy + 1, 1 + Math.floor(2 * (yy - SM) / (S1 - SM)), mb);
  sq(8, S0, S0 + 2, lip);                                           // base moulding
  csq(8, SM - 2, SM - 1, 1, lip); csq(7, SM - 1, SM, 1, lip);       // collar
  for (const n of SIDES) {
    for (let b = -6; b <= 5; b += 2) sb(n, 7, 8, b, b + 1, SM - 3, SM - 2, lip);   // dentils under it
    // a sunken panel on the drum with a small carved tablet
    sb(n, 6, 7, -4, 4, S0 + 3, SM - 4, null);
    sb(n, 5, 6, -4, 4, S0 + 3, SM - 4, relief);
    sb(n, 6, 7, -2, 2, S0 + 5, S0 + 7, mb);                          // tablet
    // the long flute up each face of the shaft (a shadow line)
    sb(n, 4, 5, -1, 1, SM + 5, S1 - 8, null);
  }
  for (let k = 0; k < 5; k++) csq(5 - k, S1 + 2 * k, S1 + 2 * k + 2, Math.max(0, 2 - k), k === 4 ? lip : mb);   // pyramidion
  sq(1, S1 + 10, S1 + 13, C.gold);
  // ---- benches and lamps on the plaza, visitors on the walks and tiers
  // (w4r6) the plaza benches gave way to the twin pools (ref05 has none)
  const walk = SIDES.map((n) => cellRect(n, 22.5, 27, -5, 5));
  crowd(g, walk, y, 6, 71 + vi);
  crowd(g, SIDES.flatMap((n) => [cellRect(n, 13, 15.5, 7, 12), cellRect(n, 13, 15.5, -12, -7)]), y + 5, 3, 17 + vi);
  return doneHi(g);
}

// ---- legacy res-1 service models kept for serviceModel('stadium'|'power') --
function svcStadium(rng) {
  const g = grid(7, 8, 7);
  const seatCols = [C.red, C.blue, C.yellow, C.pGreen, C.orange, C.teal];
  for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) g.set(x, 0, z, (x + z) % 2 ? C.grassMid : C.grassLight);
  g.walls(0, 0, 0, 6, 1, 6, C.concrete);
  for (const r of [{ inset: 1, y: 1 }, { inset: 0, y: 2 }]) {
    const a = r.inset, b = 6 - r.inset;
    for (let x = a; x <= b; x++) { g.set(x, r.y, a, seatCols[x % 6]); g.set(x, r.y, b, seatCols[(x + 2) % 6]); }
    for (let z = a; z <= b; z++) { g.set(a, r.y, z, seatCols[(z + 1) % 6]); g.set(b, r.y, z, seatCols[(z + 3) % 6]); }
  }
  for (const [cx, cz] of [[0, 0], [6, 0], [0, 6], [6, 6]]) { for (let y = 2; y <= 5; y++) g.set(cx, y, cz, C.metalDark); g.set(cx, 6, cz, C.lamp); }
  g.set(3, 7, 0, C.red); g.set(3, 7, 6, C.blue);
  return g.done();
}
function svcPower(rng) {
  const g = grid(7, 14, 3);
  const tx = 3, tz = 1, hubY = 11;
  g.box(2, 0, 0, 4, 0, 2, C.concrete);
  for (let y = 0; y < hubY; y++) g.set(tx, y, tz, C.white);
  g.set(tx + 1, hubY, tz, C.metalDark);
  for (let y = hubY + 1; y <= hubY + 2; y++) g.set(tx, y, tz, C.offwhite);
  g.set(tx - 1, hubY - 1, tz, C.offwhite); g.set(tx - 2, hubY - 1, tz, C.offwhite); g.set(tx - 2, hubY - 2, tz, C.offwhite);
  g.set(tx + 1, hubY - 1, tz, C.offwhite); g.set(tx + 2, hubY - 1, tz, C.offwhite); g.set(tx + 2, hubY - 2, tz, C.offwhite);
  g.set(tx, hubY, tz, C.signWhite);
  return g.done();
}

// Fountain spray (civic r9): a ring of sixteen fine (res-8) jets round the
// pedestal, each rising from the channel water at r 21 fine and arcing out to
// fall back in at r 23.7 (the channel is 20.5..24). Spins slowly about Y.
// 48 fine wide so its cells sit on the same half-voxel lattice as the base.
function _fountainSpinner() {
  const W = 48, g = grid(W, FT_SY, W, 8), c = W / 2;
  // (w4r12) 8 low arcs (were 16 tall ones): the ring of jets read as blue
  // clutter round the pedestal (critic w4r11 "calm and elegant")
  const arc = [[21, 0], [21.3, 1], [21.8, 2], [22.4, 3], [22.9, 3], [23.4, 2], [23.7, 1], [23.7, 0]];
  for (let k = 0; k < 8; k++) {
    const a = (k + 0.5) * Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a);
    arc.forEach(([r, yy], i) => g.set(Math.floor(c + ca * r), yy, Math.floor(c + sa * r), (i === 3 || i === 4) ? C.signWhite : C.civPoolLt));
  }
  return g.done();
}

// ---------------------------------------------------------------------------
// Registry: catalog id -> builder (rng, variant, entry) => model. Merged by
// catalog.js; CATALOG metadata (name/emoji/footprint/cap) stays in catalog.js.
// ---------------------------------------------------------------------------
export const BUILDERS = {
  'park': (rng, v) => serviceModel('park', v),
  'school': (rng, v) => serviceModel('school', v),
  'fire-station': (rng, v) => serviceModel('fire', v),
  'fountain': (rng, v) => serviceModel('fountain', v),
};

// Animated parts: id -> () => { part, ox,oy,oz (WORLD units), ax,ay,az, speed }
// fountain: channel water top at res-8 row FT_WATER → part bottom FT_WATER / 8
// world; the part is FT_SY res-8 voxels tall → its centre FT_SY / 16 above.
export const ANIMS = {
  'fountain': () => ({ part: _fountainSpinner(), ox: 0, oy: FT_WATER / 8 + FT_SY / 16, oz: 0, ax: 0, ay: 1, az: 0, speed: 0.5 }),
};
