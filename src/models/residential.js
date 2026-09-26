// Blockville models — RESIDENTIAL: zoned R growth (residential) + catalog 'homes'.
//
// Round 4: everything here is authored at res 8 (64 fine voxels per tile; a
// 1×1 canvas is 63×63, a 2×2 is 127×127). The r3 critic's verdict was that the
// res-4 homes were "about 2x too coarse" next to the Isometric City Voxel
// reference: a window was one fat block and a roof a few thick slabs. At res 8
// every detail is authored at the reference's scale — 1-voxel (1/8 unit)
// frames, sills, sash bars, verge boards and tile lips, thin 1/4-unit roof
// courses, 5×9 windows, small quoins — and there is room on each lot for the
// reference's density: paving, drives with a parked car, beds, fences, bins,
// planters, patios and rooftop gear.
//
// Each home brings its own lot plinth (lot) at the shared 0.5-unit height and
// dresses it. Front toward min-Z as always (catalogModel flips it onto +Z).
// All four sides are dressed because the iso camera can land on any of them.
//
// Budget: greedy meshing makes flat walls ~free; detail costs triangles where
// it breaks a surface (AO ramps). Colour stripes run ALONG faces (they merge);
// no checkerboards. Tall volumes are built as thick shells (solid()) so the
// voxel grid stays small.

import {
  C, lotPlinth, facade, door, awning, wallAC, acBox, solarPanel, ventPipe, bench, signPanel,
} from './core.js';
import { stampCar } from './vehicles.js';
import { stampVeg } from './vegetation.js';

// (r7) Every home is authored on the r4-r6 res-8 canvas (63 per tile) but
// published at res RP = 12: the house and its garden shrink to 2/3 of their
// r6 world size (1/12-unit frames and sills — the finer window rhythm of
// ref05), centred on a full-tile lot whose outer ring (LR voxels) is the
// home's own paved margin. The r6 critic: 'houses drawn at roughly twice the
// reference scale, packed shoulder to shoulder ... each ref05 home is clearly
// separated with its own lot edge and paving'.
// (r10) 10, was 12: the homes grow 1.2x on their lots (r9 critic: 'the house
// covers only about a third of its lot'); r6 at res 8 was 'twice the reference
// scale', so this is the midpoint. The small house authors its own res-12 tile.
const R = 10;  // published voxels per world unit (the authoring canvas is the old res-8 one)
// top of the lot plinth (0.5 units): buildings stand on y = G. (r10) 5 at res
// 10; bSmallHouse switches it to 6 while it builds its res-12 tile.
let G = 5;
// House lawns: lotGrass renders neon lime (#b5fc15) on a lot next to the calm
// terrain grass (r3 critic: "oversaturated"); the pastel green renders a
// fresh lawn in the same family as the ground.
const LAWN = C.resLawn;

// ---------------------------------------------------------------------------
// Colour schemes — every home uses a controlled 3-tone palette like ref04:
// base (wall) / light trim (quoins, sills, door surrounds) / dark accent
// (frames, cornice, eaves, verge boards), plus a tile roof with a shadow tone.
// ---------------------------------------------------------------------------
// Roof pairs: [tile, shadow course / ridge].
const ROOF = {
  tile: [C.resTile, C.resTileDk],
  red: [C.resRoofRed, C.resTileDk],
  orange: [C.roofOrange, C.resTileOrangeDk],
  slate: [C.resSlate, C.resSlateDk],
  blue: [C.roofBlue, C.navy],
  green: [C.roofGreen, C.resTileGreenDk],
  sage: [C.resSage, C.resTileGreenDk],   // (r7) a light roof: the r6 critic found the dark roofs dominated
  brown: [C.shingle, C.roofBrown],
};
const FLOWERS = [
  [C.vegPetalR, C.vegPetalW, C.vegPollen],
  [C.pink, C.vegPetalW, C.amber],
  [C.purple, C.pink, C.vegPollen],
  [C.vegPetalB, C.vegPetalW, C.pink],
];
function scheme(o) {
  const s = Object.assign({ trim: C.white, base: C.stone, glass: C.win, shutter: C.roofBlue, flowers: FLOWERS[0] }, o);
  if (s.quoin == null) s.quoin = s.trim;
  return s;
}
const vOf = (variant, n) => (((variant | 0) % n) + n) % n;

// ---------------------------------------------------------------------------
// Fast voxel grid: the same API and semantics as core's grid() (later writes
// win, out-of-range writes are ignored, done() stamps res), backed by a typed
// array instead of a Map of string keys — res-8 homes set 50k-600k voxels and
// the Map version spent 20-430 ms per model on key strings.
// ---------------------------------------------------------------------------
// (r7) grid(): the builder's canvas (sx × sz, e.g. 63 × 63 for a 1×1) sits
// centred on the full-tile res-R grid; every write is offset by (ox, 0, oz).
// g.raw is the un-offset grid (the lot ring and lot cars use it).
function grid(sx, sy, sz, res) {
  const tw = Math.round((sx + 1) / 64), td = Math.round((sz + 1) / 64);
  const X = tw * 8 * res - 1, Z = td * 8 * res - 1;
  const ox = (X - sx) >> 1, oz = (Z - sz) >> 1;
  const raw = rawGrid(X, sy, Z, res);
  const g = {
    sx, sy, sz, res, raw, ox, oz,
    set(x, y, z, c) { raw.set(x + ox, y, z + oz, c); },
    del(x, y, z) { raw.del(x + ox, y, z + oz); },
    get(x, y, z) { return raw.get(x + ox, y, z + oz); },
    box(x0, y0, z0, x1, y1, z1, c) { raw.box(x0 + ox, y0, z0 + oz, x1 + ox, y1, z1 + oz, c); },
    walls(x0, y0, z0, x1, y1, z1, c) {
      raw.box(x0 + ox, y0, z0 + oz, x1 + ox, y1, z0 + oz, c); raw.box(x0 + ox, y0, z1 + oz, x1 + ox, y1, z1 + oz, c);
      raw.box(x0 + ox, y0, z0 + oz, x0 + ox, y1, z1 + oz, c); raw.box(x1 + ox, y0, z0 + oz, x1 + ox, y1, z1 + oz, c);
    },
    slab(x0, y, z0, x1, z1, c) { this.box(x0, y, z0, x1, y, z1, c); },
    // (r8) garden lots are dressed wall to wall at the end (dressYard)
    done() { if (g.yard != null) dressYard(g, g.yard); if (g.groove) grooveLot(raw); return raw.done(); },
  };
  return g;
}
// (w4r4) Every home's lot is its OWN plinth: the sides and back stop GI
// voxels short of the tile edge, so two neighbouring homes stand on two
// plinths with a narrow grass channel and their darker side bands between
// them (three critics in a row: 'packed shoulder to shoulder on one shared
// plinth ... no house reads as a separate lot'). The front stays flush with
// the kerb. Only the plinth and low ground clutter in the channel are cut;
// canopies above it stay. Keeps >= 90% plinth cover (engine._lotInfo).
const GI = 2;
function grooveLot(W) {
  const X = W.sx - 1, Z = W.sz - 1, gy = G - 1;
  const cut = (x0, z0, x1, z1) => { for (let y = 0; y <= G + 2; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) W.del(x, y, z); };
  cut(0, 0, GI - 1, Z); cut(X - GI + 1, 0, X, Z); cut(0, Z - GI + 1, X, Z);
  const a = GI, b = X - GI, c = Z - GI;
  // new outer faces: the dark side band, with the light rim two voxels wide on top
  for (let y = 0; y < gy; y++) {
    W.box(a, y, 0, a, y, c, C.lotSide); W.box(b, y, 0, b, y, c, C.lotSide); W.box(a, y, c, b, y, c, C.lotSide);
  }
  W.box(a, gy, 0, a + 1, gy, c, C.lotRim); W.box(b - 1, gy, 0, b, gy, c, C.lotRim); W.box(a, gy, c - 1, b, gy, c, C.lotRim);
}
function rawGrid(sx, sy, sz, res) {
  const cell = new Uint8Array(sx * sy * sz);           // palette index + 1 (0 = empty)
  const I = (x, y, z) => (y * sz + z) * sx + x;
  return {
    sx, sy, sz, res,
    set(x, y, z, c) {
      x = Math.round(x); y = Math.round(y); z = Math.round(z);
      if (c == null || x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      cell[I(x, y, z)] = c + 1;
    },
    del(x, y, z) {
      x = Math.round(x); y = Math.round(y); z = Math.round(z);
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      cell[I(x, y, z)] = 0;
    },
    get(x, y, z) {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null;
      const v = cell[I(x, y, z)];
      return v ? v - 1 : null;
    },
    box(x0, y0, z0, x1, y1, z1, c) {
      if (c == null) return;
      if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      if (z0 > z1) { const t = z0; z0 = z1; z1 = t; }
      x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0)); z0 = Math.max(0, Math.round(z0));
      x1 = Math.min(sx - 1, Math.round(x1)); y1 = Math.min(sy - 1, Math.round(y1)); z1 = Math.min(sz - 1, Math.round(z1));
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const b = I(0, y, z);
        cell.fill(c + 1, b + x0, b + x1 + 1);
      }
    },
    walls(x0, y0, z0, x1, y1, z1, c) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) { this.set(x, y, z0, c); this.set(x, y, z1, c); }
        for (let z = z0; z <= z1; z++) { this.set(x0, y, z, c); this.set(x1, y, z, c); }
      }
    },
    slab(x0, y, z0, x1, z1, c) { this.box(x0, y, z0, x1, y, z1, c); },
    done() {
      const blocks = [];
      for (let y = 0, i = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++, i++) {
        const v = cell[i];
        if (v) blocks.push([x, y, z, v - 1]);
      }
      const m = { sx, sy, sz, blocks };
      if (res !== 1) m.res = res;
      return m;
    },
  };
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------
// Solid block, built as a `t`-thick shell when it is big (the inside is never
// seen; windows recess at most 2 voxels) so tall towers stay cheap to grid.
function solid(g, x0, y0, z0, x1, y1, z1, c, t = 4) {
  if (x1 - x0 < 2 * t + 2 || z1 - z0 < 2 * t + 2 || y1 - y0 < 2 * t + 2) { g.box(x0, y0, z0, x1, y1, z1, c); return; }
  for (let k = 0; k < t; k++) g.walls(x0 + k, y0, z0 + k, x1 - k, y1, z1 - k, c);
  g.box(x0, y1 - t + 1, z0, x1, y1, z1, c);
}
// Wall block with a base course in S.base: a flush band by default (a proud
// ring at ground level costs ~1.5k triangles of AO ramps at res 8), proud
// with o.proud.
function body(g, x0, z0, x1, z1, y0, y1, S, o = {}) {
  solid(g, x0, y0, z0, x1, y1, z1, S.wall);
  const bh = o.baseH || 3, p = o.proud ? 1 : 0;
  if (S.base != null) g.walls(x0 - p, y0, z0 - p, x1 + p, y0 + bh - 1, z1 + p, S.base);
}
// Proud trim ring (belt course) around a block at height y.
function belt(g, x0, z0, x1, z1, y, c, h = 1, out = 1) { g.walls(x0 - out, y, z0 - out, x1 + out, y + h - 1, z1 + out, c); }
// Flush colour line in the wall plane (costs ~nothing: it merges).
function line(g, x0, z0, x1, z1, y, c, h = 1) { g.walls(x0, y, z0, x1, y + h - 1, z1, c); }
// Two-step cornice: a proud band at y, a wider band above it.
function cornice(g, x0, z0, x1, z1, y, c, c2 = c) {
  g.walls(x0 - 1, y, z0 - 1, x1 + 1, y, z1 + 1, c);
  g.walls(x0 - 2, y + 1, z0 - 2, x1 + 2, y + 2, z1 + 2, c2);
}
// Stacked quoins at the four corners (ref04's signature, at half the r3 size):
// blocks bh-1 tall with a one-voxel joint, alternating long / short arms.
// Proud 1 on both faces (costly: ~1.1-1.5k tris per house at res 8), or with
// flat = true painted into the wall plane (~0.3k) — the same stacked pattern.
// flat may also be a number: how many voxels proud (r6: 2 = ref04's chunky
// blocks; the r5 critic found the 1-proud / flat quoins too faint).
function quoins(g, x0, z0, x1, z1, y0, y1, c, bh = 5, lens = [4, 3], flat = false) {
  let k = 0;
  const p = flat === true ? 0 : typeof flat === 'number' ? flat : 1;
  const t = Math.max(0, p - 1);                        // extra thickness back to the wall
  for (let y = y0; y + bh - 2 <= y1; y += bh, k++) {
    const L = lens[k % 2], ye = y + bh - 2;
    for (const [cx, cz, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
      const ox = cx - dx * p, oz = cz - dz * p;
      g.box(ox, y, oz, ox + dx * L, ye, oz + dz * t, c);
      g.box(ox, y, oz, ox + dx * t, ye, oz + dz * L, c);
    }
  }
}
// Slim corner pilasters (proud 1 on both faces, w wide), with a cap block.
function pilasters(g, x0, z0, x1, z1, y0, y1, c, w = 2) {
  for (const [cx, cz, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
    const ox = cx - dx, oz = cz - dz;
    g.box(ox, y0, oz, ox + dx * (w - 1), y1, oz, c);
    g.box(ox, y0, oz, ox, y1, oz + dz * (w - 1), c);
  }
}

// ---------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------
// Axis helper: one roof routine runs with its ridge along X or along Z
// (a = along the ridge, b = across it).
function axisBox(g, axis) {
  return axis === 'x'
    ? (a0, y0, b0, a1, y1, b1, c) => g.box(a0, y0, b0, a1, y1, b1, c)
    : (a0, y0, b0, a1, y1, b1, c) => g.box(b0, y0, a0, b1, y1, a1, c);
}
// Stepped gable roof. The wall block spans a0..a1 along the ridge and b0..b1
// across it, top at wallTop. Each tile course is `rise` voxels tall and `run`
// deep: a lit tile row over a one-voxel shadow lip (ref05's thin tile rows —
// stripes run along the slope, so they merge). Verge boards in the roof's
// shadow tone, fascia boards, a ridge cap. The gable triangles are `fill`.
function gableRoof(g, axis, a0, a1, b0, b1, wallTop, s) {
  const B = axisBox(g, axis);
  // (r10) default 45° single-voxel courses: the r9 critic read the old
  // rise-2 steps as 'ribbed and striped' slopes instead of broad planes
  const ov = s.ov != null ? s.ov : 3, ova = s.ova != null ? s.ova : 2, rise = s.rise || 1, run = s.run || 1;
  const aa = a0 - ova, ab = a1 + ova, ba = b0 - ov, bb = b1 + ov;
  const y0 = wallTop + 1 - Math.ceil(ov / run) * rise;
  const [tc, td] = s.roof;
  const fill = s.fill, edge = s.edge != null ? td : null;
  let k = 0;
  for (; ba + k * run <= bb - k * run; k++) {
    const yk = y0 + k * rise, y1 = yk + rise - 1, bf = ba + k * run, br = bb - k * run;
    const bf1 = Math.min(bf + run - 1, br), br0 = Math.max(br - run + 1, bf);
    if (bf1 + 1 <= br0 - 1 && fill != null) B(a0, yk, bf1 + 1, a1, y1, br0 - 1, fill);
    const c = s.band && k % s.band === s.band - 1 ? td : tc;
    const lp = rise === 1 ? c : s.lip != null ? s.lip : td;
    B(aa, yk, bf, ab, yk, bf1, lp); B(aa, yk, br0, ab, yk, br, lp);
    if (rise > 1) { B(aa, yk + 1, bf, ab, y1, bf1, c); B(aa, yk + 1, br0, ab, y1, br, c); }
    if (edge != null) {
      for (const a of [aa, ab]) { B(a, yk, bf, a, y1, bf1, edge); B(a, yk, br0, a, y1, br, edge); }
    }
  }
  k--;
  const top = y0 + k * rise + rise - 1;
  const kb0 = ba + k * run, kb1 = bb - k * run;
  const rc = s.ridge != null ? s.ridge : td;
  B(aa, top + 1, kb0, ab, top + 1, kb1, rc);
  if (s.caps !== false) { B(aa, top + 2, kb0, aa + 1, top + 2, kb1, rc); B(ab - 1, top + 2, kb0, ab, top + 2, kb1, rc); }
  if (s.fascia != null) { B(aa, y0 - 1, ba, ab, y0 - 1, ba, s.fascia); B(aa, y0 - 1, bb, ab, y0 - 1, bb, s.fascia); }
  return {
    axis, y0, top: top + 1, rise, run, ba, bb, aa, ab,
    // y of the roof's top surface above across-coordinate b
    yAt: (b) => y0 + rise * Math.floor(Math.max(0, Math.min(b - ba, bb - b)) / run) + rise - 1,
  };
}
// Stepped hip roof over x0..x1 × z0..z1 (all four sides slope), tile course
// over a shadow lip per layer, fascia ring and a ridge cap.
function hipRoof(g, x0, x1, z0, z1, wallTop, s) {
  const ov = s.ov != null ? s.ov : 3, rise = s.rise || 1, run = s.run || 1;
  const xa = x0 - ov, xb = x1 + ov, za = z0 - ov, zb = z1 + ov;
  const y0 = wallTop + 1 - Math.ceil(ov / run) * rise;
  const [tc, td] = s.roof;
  let k = 0;
  while (xa + k * run <= xb - k * run && za + k * run <= zb - k * run) {
    const y = y0 + k * rise, i = k * run;
    // rise 1: one-voxel courses, a shadow-tone course every third (fine bands)
    // (r10) clean planes: no shadow course every third row unless s.band
    g.box(xa + i, y, za + i, xb - i, y, zb - i, rise > 1 ? (s.lip != null ? s.lip : td) : s.band && k % s.band === s.band - 1 ? td : tc);
    if (rise > 1) g.box(xa + i, y + 1, za + i, xb - i, y + rise - 1, zb - i, s.band && k % s.band === s.band - 1 ? td : tc);
    k++;
  }
  k--;
  const top = y0 + k * rise + rise - 1, i = k * run;
  if (s.ridge !== false) g.box(xa + i, top + 1, za + i, xb - i, top + 1, zb - i, s.ridge != null ? s.ridge : td);
  if (s.fascia != null) g.walls(xa, y0 - 1, za, xb, y0 - 1, zb, s.fascia);
  return {
    y0, top: top + 1, rise, run, xa, xb, za, zb,
    // a hip's front/back slopes seen as a gable-X roof (for dormers / panels)
    ba: za, bb: zb, yAt: (b) => y0 + rise * Math.floor(Math.max(0, Math.min(b - za, zb - b)) / run) + rise - 1,
  };
}
// Flush solar panels laid into a gable-X roof's slope: the tile rows of a few
// courses turn navy, their lips sky blue (the cell lines), a metal frame at
// the ends. Costs almost nothing and reads as panels, not a bump.
function roofPanels(g, roof, x0, x1, b0, b1) {
  for (let b = Math.min(b0, b1); b <= Math.max(b0, b1); b++) {
    const y = roof.yAt(b);
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1;
      g.set(x, y, b, edge ? C.metal : C.navy);
      if (roof.rise > 1) g.set(x, y - 1, b, edge ? C.metal : C.skyBlue);
    }
  }
}
// Gabled dormer on a gable-X (or hip) roof's front (min-Z) / back (max-Z)
// slope: a little walled box with a framed window and its own tiled gable.
function dormer(g, roof, xc, w, h, S, side = 'front') {
  const x0 = xc - (w >> 1), x1 = x0 + w - 1;
  const back = side === 'back';
  const zf = back ? roof.bb - 5 : roof.ba + 5;
  const y0 = roof.yAt(zf) - 1;
  const depth = Math.ceil((h + (w >> 1) + 4) / roof.rise) * roof.run + 2;
  const zi = back ? zf - depth : zf + depth;
  const za = Math.min(zf, zi), zb = Math.max(zf, zi);
  g.box(x0, y0, za, x1, y0 + h - 1, zb, S.wall);
  const F = facade(g, side, zf);
  F.box(0 + x0, y0, 1, x0, y0 + h - 1, 1, S.trim); F.box(x1, y0, 1, x1, y0 + h - 1, 1, S.trim);   // cheek boards
  win(F, x0 + 3, y0 + 3, w - 6, h - 5, S, { mullion: w - 6 >= 5 ? 'cross' : 'h', sill: false });
  gableRoof(g, 'z', back ? za : za + 0, back ? zb : zb, x0, x1, y0 + h - 1, { roof: S.roof, fill: S.wall, edge: true, ov: 2, ova: 1, rise: 2, run: 2, caps: false, fascia: S.trim });
}
// Flat-roofed box dormer (r3 style, ~40% of a gabled one's triangles): a
// walled box with a framed window, a trim band and a tile-coloured cap that
// overhangs the face and cheeks by one voxel.
function boxDormer(g, roof, xc, w, h, S, side = 'front') {
  const x0 = xc - (w >> 1), x1 = x0 + w - 1;
  const back = side === 'back';
  const zf = back ? roof.bb - 5 : roof.ba + 5;
  const y0 = roof.yAt(zf) - 1;
  const depth = Math.ceil((h + 2) / roof.rise) * roof.run + 2;
  const zi = back ? zf - depth : zf + depth, zo = back ? zf + 1 : zf - 1;
  g.box(x0, y0, Math.min(zf, zi), x1, y0 + h - 1, Math.max(zf, zi), S.wall);
  win(facade(g, side, zf), x0 + 3, y0 + 3, w - 6, h - 6, S, { mullion: w - 6 >= 5 ? 'cross' : 'h', sill: false });
  g.box(x0 - 1, y0 + h, Math.min(zo, zi), x1 + 1, y0 + h, Math.max(zo, zi), S.trim);
  g.box(x0 - 1, y0 + h + 1, Math.min(zo, zi), x1 + 1, y0 + h + 1, Math.max(zo, zi), S.roof[1]);
}
// Brick chimney: proud cap course, a stone band, two terracotta flue pots.
function chimney(g, x0, z0, w, d, yb, yt, c = C.brick, cap = C.concrete) {
  g.box(x0, yb, z0, x0 + w - 1, yt, z0 + d - 1, c);
  g.box(x0 - 1, yt - 1, z0 - 1, x0 + w, yt, z0 + d, cap);
  g.walls(x0, yt - 6, z0, x0 + w - 1, yt - 6, z0 + d - 1, cap);
  g.box(x0 + 1, yt + 1, z0 + 1, x0 + 2, yt + 3, z0 + 2, C.resTileOrangeDk);
  if (w >= 5) g.box(x0 + w - 3, yt + 1, z0 + d - 3, x0 + w - 2, yt + 2, z0 + d - 2, C.resTileOrangeDk);
}

// ---------------------------------------------------------------------------
// Facade kit (all sizes in res-8 voxels; F = facade(g, side, plane))
// ---------------------------------------------------------------------------
// ref04 window. Default (cheap at res 8, ~120-160 tris): a frame ring in the
// wall plane, the glass recessed one voxel behind it with a sash bar, a proud
// sill ledge. o.proud: the frame ring stands one voxel proud and the glass
// sits in the wall plane (hero faces; ~280 tris). Optional head moulding,
// shutters and a flower box.
// o: { glass, frame, sill (false = none), mullion 'cross'|'h'|'v'|null|<n>,
//      head, shutters, box, proud }
function win(F, u0, y0, w, h, S, o = {}) {
  const glass = o.glass != null ? o.glass : S.glass;
  const fr = o.frame != null ? o.frame : (S.frame != null ? S.frame : S.trim);
  const sill = o.sill != null && o.sill !== false ? o.sill : (S.sill != null ? S.sill : (S.quoin != null ? S.quoin : fr));
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  const fOut = o.proud ? 1 : 0, gOut = fOut - 1;
  F.box(u0 - 1, y0 - 1, fOut, u1 + 1, y1 + 1, fOut, fr);
  F.clear(u0, y0, gOut + 1, u1, y1, fOut);
  F.box(u0, y0, gOut, u1, y1, gOut, glass);
  const m = o.mullion !== undefined ? o.mullion : 'h';
  if (m === 'cross' || m === 'v') F.box(u0 + (w >> 1), y0, gOut, u0 + (w >> 1), y1, gOut, fr);
  if (m === 'cross' || m === 'h') F.box(u0, y0 + (h >> 1), gOut, u1, y0 + (h >> 1), gOut, fr);
  if (typeof m === 'number' && m > 1) for (let u = u0 + m; u < u1; u += m + 1) F.box(u, y0, gOut, u, y1, gOut, fr);
  if (o.sill !== false) F.box(u0 - 2, y0 - 2, 1, u1 + 2, y0 - 2, 1 + fOut, sill);
  if (o.head) F.box(u0 - 2, y1 + 2, fOut, u1 + 2, y1 + 2, 1, sill);
  if (o.shutters) {
    const sc = S.shutter != null ? S.shutter : fr;
    F.box(u0 - 3, y0 - 1, 1, u0 - 2, y1 + 1, 1, sc);
    F.box(u1 + 2, y0 - 1, 1, u1 + 3, y1 + 1, 1, sc);
  }
  if (o.box) flowerBox(F, u0 - 1, u1 + 1, y0 - 3, S.flowers || FLOWERS[0], S.box != null ? S.box : C.woodDark);
}
// Flower box hanging under a sill at y (its top): a wood box, a leafy top
// row out in front of the sill and flowers dotted along it.
function flowerBox(F, u0, u1, y, fl, boxC = C.woodDark) {
  F.box(u0, y - 2, 1, u1, y, 3, boxC);
  F.box(u0, y + 1, 3, u1, y + 1, 3, C.vegBush);
  for (let u = u0 + 1, i = 0; u < u1; u += 2, i++) F.set(u, y + 2, 3, fl[i % 2]);
}
// Flush tower window (cheap): glass in an in-plane frame ring (frame given),
// or recessed plain glass (no frame).
function towerWin(F, u0, y0, w, h, glass, frame) {
  if (frame != null) {
    F.box(u0 - 1, y0 - 1, 0, u0 + w, y0 + h, 0, frame);
    F.box(u0, y0, 0, u0 + w - 1, y0 + h - 1, 0, glass);
    return;
  }
  F.clear(u0, y0, 0, u0 + w - 1, y0 + h - 1, 0);
  F.box(u0, y0, -1, u0 + w - 1, y0 + h - 1, -1, glass);
}
// Bracket lamp (ref04): arm + cap in the trim colour, a 2×3 amber lantern
// with a glowing base.
function lamp(F, u, y, S) {
  F.box(u, y + 2, 1, u + 1, y + 2, 3, S.trim);
  F.box(u, y - 1, 2, u + 1, y + 1, 3, C.amber);
  F.box(u, y - 1, 2, u + 1, y - 1, 3, C.lamp);
}
// Grand entry: a proud surround, the door (core door: frame, recess, knob,
// step, mat), lamps either side, an optional flat canopy or gabled hood.
// o: { color, double, glass, lamps, canopy, hood, stepDepth, step, mat }
function entry(F, u0, y0, w, h, S, o = {}) {
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  F.box(u0 - 2, y0, 1, u1 + 2, y1 + 3, 1, o.surround != null ? o.surround : S.trim);
  F.clear(u0 - 1, y0, 1, u1 + 1, y1 + 1, 1);
  door(F, u0, y0, w, h, {
    color: o.color != null ? o.color : S.door, frame: S.quoin != null ? S.quoin : S.trim,
    knob: o.knob != null ? o.knob : C.gold, glass: o.glass, double: o.double,
    step: o.step === undefined ? C.concrete : o.step, stepDepth: o.stepDepth || 4,
    mat: o.mat !== undefined ? o.mat : C.red,
  });
  if (o.lamps !== false) { lamp(F, u0 - 6, y0 + h - 5, S); lamp(F, u1 + 5, y0 + h - 5, S); }
  if (o.canopy != null) {
    F.box(u0 - 4, y1 + 4, 1, u1 + 4, y1 + 4, 6, S.trim);
    F.box(u0 - 4, y1 + 5, 1, u1 + 4, y1 + 5, 6, o.canopy);
  }
  if (o.hood != null) hood(F, u0 - 4, u1 + 4, y1 + 4, 6, o.hood, S.trim);
}
// Gabled hood over a door on two brackets: a stepped 45° roof (tile) over a
// trim tympanum.
function hood(F, u0, u1, y, depth, roofC, trim) {
  F.box(u0 + 1, y - 4, 1, u0 + 1, y - 1, 2, trim); F.box(u1 - 1, y - 4, 1, u1 - 1, y - 1, 2, trim);
  for (let k = 0; u0 + k <= u1 - k; k++) {
    F.box(u0 + k, y + k, 1, u1 - k, y + k, depth - 1, trim);
    F.box(u0 + k, y + k, 1, u0 + k, y + k, depth, roofC); F.box(u1 - k, y + k, 1, u1 - k, y + k, depth, roofC);
  }
}
// Railing balcony: slab (+ lip), posts every 2, a top rail.
function railBalcony(F, u0, u1, y, depth, slab, rail, o = {}) {
  F.box(u0, y - 1, 1, u1, y - 1, depth, slab);
  F.box(u0, y - 2, depth, u1, y - 2, depth, slab);
  const rh = o.h || 6;
  if (o.glass != null) {
    F.box(u0, y, depth, u1, y + rh - 2, depth, o.glass);
    F.box(u0, y, 1, u0, y + rh - 2, depth, o.glass); F.box(u1, y, 1, u1, y + rh - 2, depth, o.glass);
  } else {
    for (let u = u0; u <= u1; u += 2) F.box(u, y, depth, u, y + rh - 2, depth, rail);
    F.box(u1, y, depth, u1, y + rh - 2, depth, rail);
    for (let o2 = 1; o2 < depth; o2 += 2) { F.box(u0, y, o2, u0, y + rh - 2, o2, rail); F.box(u1, y, o2, u1, y + rh - 2, o2, rail); }
  }
  F.box(u0, y + rh - 1, depth, u1, y + rh - 1, depth, rail);
  F.box(u0, y + rh - 1, 1, u0, y + rh - 1, depth, rail); F.box(u1, y + rh - 1, 1, u1, y + rh - 1, depth, rail);
}
// Down pipe from the eave to the ground, with a hopper head and a shoe.
function downpipe(F, u, y0, y1, c) {
  F.box(u, y0, 1, u, y1, 1, c);
  F.box(u - 1, y1 - 1, 1, u + 1, y1, 2, c);
  F.box(u, y0, 2, u, y0, 2, c);
}

// ---------------------------------------------------------------------------
// Lot + garden kit
// ---------------------------------------------------------------------------
// The shared 0.5-unit lot plinth with a 2-voxel (1/4 unit) light rim, the same
// world size as the res-4 lots next door. fill: 'pave' | 'grass' | colour.
// (r7) The full-tile plinth goes on g.raw; the authoring canvas sits in its
// middle and the ring around it (g.ox / g.oz voxels) is the home's own margin:
//  * garden lots ('grass' / sand): the ring continues the garden on the sides
//    and back (no kerb between them), with a few ref06 shrubs and saplings
//    at the back corners, and a paved front strip (flagstone joints) with a
//    light kerb where the front garden starts;
//  * paved lots: flagstones all round and a light kerb framing the canvas.
// Between two homes that is: fence | garden verge | lot rim | lot rim | verge
// | fence — each home reads as its own lot (r6 critic).
function lot(g, x1, z1, fill = 'pave', seed = 0) {
  const W = g.raw ? g.raw : g;
  const X = W.sx - 1, Z = W.sz - 1;
  const garden = fill !== 'pave';
  const gc = fill === 'grass' ? LAWN : fill === 'pave' ? C.lotPave : fill;
  lotPlinth(W, 0, 0, X, Z, { h: G, fill: gc });
  W.walls(1, G - 1, 1, X - 1, G - 1, Z - 1, C.lotRim);
  if (!g.raw) return;
  g.groove = true;
  g.yard = seed | 0;                    // (r8) dressYard acts on any lawn left bare
  const ox = g.ox, oz = g.oz, st = 8;
  const y = G - 1;
  if (garden) {
    // paved front strip + a kerb along the garden's front edge
    W.box(2, y, 2, X - 2, y, oz - 1, C.lotPave);
    for (let x = 2 + st; x < X - 1; x += st) W.box(x, y, 2, x, y, oz - 2, C.lotPaveDark);
    W.box(2, y, oz - 1, X - 2, y, oz - 1, C.lotRim);
    g.box(0, y, 0, x1, y, z1, gc);
    // back-corner planting in the verge (varies by variant)
    const k = ((seed | 0) % 3 + 3) % 3, h = ox >> 1;
    const back = Z - (oz >> 1) - 1;
    if (k === 1) gardenTree(W, h + 2, back - 1, seed + 3); else stampVeg(W, ['shrub', 'sapling', 'bushTall'][k], h + 1, G, back, seed + 3, 1);
    if (k === 0) gardenTree(W, X - h - 2, back - 1, seed + 7); else stampVeg(W, 'shrub', X - h - 1, G, back, seed + 7, 1);
    if (k !== 1) stampVeg(W, 'shrub', h + 1, G, oz + (z1 >> 1), seed + 11, 1);
    streetTree(W, Math.max(h + 1, 11), oz >> 1, seed + 5);
  } else {
    for (let x = 2 + st; x < X - 1; x += st) { W.box(x, y, 2, x, y, oz - 2, C.lotPaveDark); W.box(x, y, oz + z1 + 2, x, y, Z - 2, C.lotPaveDark); }
    for (let z = 2 + st; z < Z - 1; z += st) { W.box(2, y, z, ox - 2, y, z, C.lotPaveDark); W.box(ox + x1 + 2, y, z, X - 2, y, z, C.lotPaveDark); }
    g.box(0, y, 0, x1, y, z1, gc);
    g.walls(0, y, 0, x1, y, z1, C.lotRim);
    streetTree(W, Math.max((ox >> 1) + 1, 11), oz >> 1, seed + 5);
  }
}
// Flush patch on the lot surface (inside the rim: 2..sx-3).
function patch(g, x0, z0, x1, z1, c) { g.box(x0, G - 1, z0, x1, G - 1, z1, c); }
// Flagstone paving: joint lines every `step` in the darker pave (ref05's
// paved lots read as a slab grid, not one flat grey sheet). Lines, not a
// checkerboard, so each slab still merges into one quad (~4 tris a joint).
function paving(g, x0, z0, x1, z1, step = 8, c = C.lotPaveDark) {
  for (let x = x0 + step; x < x1; x += step) patch(g, x, z0, x, z1, c);
  for (let z = z0 + step; z < z1; z += step) patch(g, x0, z, x1, z, c);
}
// Fire hydrant (red, with a cap and side nozzles).
function hydrant(g, x, z) {
  g.box(x, G, z, x + 1, G + 4, z + 1, C.red);
  g.box(x - 1, G + 2, z, x + 2, G + 2, z + 1, C.red);
  g.box(x, G + 5, z, x + 1, G + 5, z + 1, C.signWhite);
}
// Street tree in a square kerbed pit (a small round canopy).
function streetTree(g, x, z, seed = 0) {
  g.walls(x - 3, G, z - 3, x + 3, G, z + 3, C.concrete);
  patch(g, x - 2, z - 2, x + 2, z + 2, C.dirtDark);
  gardenTree(g, x, z, seed);
}
// (r8) Garden tree — r7 critic: 'the trees next to the houses are bare lime
// cubes that look plain beside the detailed buildings'. A trunk with a side
// branch under a clustered crown: a main lobe, a lower side lobe and a small
// top lobe, each with ref06's darker foot band, leaf dots, and fruit or
// blossom dotted on the faces (apples / oranges / pink or white blossom).
const TREE_PAL = [
  [C.vegLeaf, C.vegBush, C.vegLeafBand, C.vegPetalR],     // apple
  [C.vegPine, C.vegBush, C.vegPineBand, C.orange],        // orange
  [C.vegLeaf, C.vegPine, C.vegLeafBand, C.vegPetalW],     // white blossom
  [C.vegPine, C.vegBush, C.vegPineBand, C.pink],          // pink blossom
];
function gardenTree(g, x, z, seed = 0, y = G) {
  const h = ((seed * 2654435761) >>> 0), P = TREE_PAL[h % TREE_PAL.length];
  const s = (h >> 4) & 1 ? 1 : -1;                        // mirror the crown
  g.box(x - 1, y, z - 1, x + 1, y + 13, z + 1, C.vegTrunk);
  g.box(x + s * 2, y + 8, z, x + s * 4, y + 9, z + 1, C.vegTrunk);          // side branch
  const lobe = (x0, y0, z0, x1, y1, z1, c) => {
    g.box(Math.min(x0, x1), y0 + 2, z0, Math.max(x0, x1), y1, z1, c);
    g.box(Math.min(x0, x1), y0, z0, Math.max(x0, x1), y0 + 1, z1, P[2]);
  };
  // a clustered crown: two low darker lobes, the main lobe, a small top knot
  lobe(x - s * 7, y + 10, z - 2, x - s * 1, y + 17, z + 5, P[1]);
  lobe(x + s * 1, y + 11, z - 6, x + s * 7, y + 18, z + 0, P[1]);
  lobe(x - 5, y + 14, z - 4, x + 4, y + 24, z + 4, P[0]);
  lobe(x + s * 1, y + 16, z + 1, x + s * 6, y + 21, z + 6, P[0]);
  lobe(x - 2, y + 25, z - 2, x + 2, y + 28, z + 2, P[0]);
  // fruit / blossom dots on the crown's surface
  const leaf = (c) => c === P[0] || c === P[1];
  for (let i = 0, n = 0; i < 90 && n < 16; i++) {
    const k = ((h ^ (i * 2246822519)) * 2654435761) >>> 0;
    const px = x - 7 + (k % 15), py = y + 12 + ((k >> 8) % 17), pz = z - 6 + ((k >> 16) % 13);
    if (!leaf(g.get(px, py, pz))) continue;
    if (g.get(px - 1, py, pz) != null && g.get(px + 1, py, pz) != null && g.get(px, py, pz - 1) != null && g.get(px, py, pz + 1) != null && g.get(px, py + 1, pz) != null) continue;
    g.set(px, py, pz, P[3]); n++;
  }
}
// Paved path / drive with a darker kerb line along both long edges.
function path(g, x0, z0, x1, z1, c = C.lotPave, edge = C.lotPaveDark) {
  patch(g, x0, z0, x1, z1, c);
  if (x1 - x0 >= z1 - z0) { patch(g, x0, z0, x1, z0, edge); patch(g, x0, z1, x1, z1, edge); }
  else { patch(g, x0, z0, x0, z1, edge); patch(g, x1, z0, x1, z1, edge); }
}
// Garden fence: posts every `step`, a bottom rail and a top rail (no pickets:
// they read as clutter and cost AO). gap = [a, b] leaves a gate opening.
function fence(g, axis, a0, a1, b, c, o = {}) {
  const B = (p, q, y0, y1) => (axis === 'x' ? g.box(p, y0, b, q, y1, b, c) : g.box(b, y0, p, b, y1, q, c));
  const h = o.h || 6, step = o.step || 6, y = G;
  const runs = o.gap ? [[a0, o.gap[0] - 1], [o.gap[1] + 1, a1]] : [[a0, a1]];
  for (const [p, q] of runs) {
    if (q < p) continue;
    B(p, q, y + 1, y + 1); B(p, q, y + h - 2, y + h - 2);
    for (let a = p; a <= q; a += step) B(a, a, y, y + h - 1);
    B(q, q, y, y + h - 1);
    if (o.pickets) for (let a = p + 1; a < q; a += 2) B(a, a, y + 2, y + h - 3);
  }
}
// Clipped hedge with a darker foot band.
function hedge(g, x0, z0, x1, z1, h = 6) {
  g.box(x0, G, z0, x1, G + h - 1, z1, C.vegBush);
  g.box(x0, G, z0, x1, G, z1, C.vegBushDark);
}
// ref04's potted topiary: a red pot with a crimson rim, a lime column.
function topiary(g, x, y, z, h = 10) {
  g.box(x, y, z, x + 3, y + 2, z + 3, C.red);
  g.walls(x, y + 3, z, x + 3, y + 3, z + 3, C.crimson);
  g.box(x + 1, y + 3, z + 1, x + 2, y + 4, z + 2, C.vegTrunk);
  g.box(x, y + 5, z, x + 3, y + 4 + h, z + 3, C.lime);
}
// ref06 tree / bush / rock from the vegetation module, at its authored res-4
// voxel count (so at res 8 it is a compact half-size lot tree).
function tree(g, x, z, kind = 'round', seed = 0) {
  if (kind === 'round' || kind === 'column' || kind === 'sapling' || kind === 'pine') gardenTree(g, x, z, seed);
  else stampVeg(g, kind, x, G, z, seed, 1);
}
// Cube bush (ref06).
function bush(g, x, z, s = 5, h = 5) { g.box(x, G, z, x + s - 1, G + h - 1, z + s - 1, C.vegBush); g.box(x, G, z, x + s - 1, G, z + s - 1, C.vegBushDark); }
// Flower bed: a timber border, dark soil, clumps of leaves with flowers.
function flowerBed(g, x0, z0, x1, z1, fl, border = C.woodDark) {
  g.walls(x0, G, z0, x1, G + 1, z1, border);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G, z1 - 1, C.dirtDark);
  let i = 0;
  for (let x = x0 + 1; x < x1 - 1; x += 3) for (let z = z0 + 1; z < z1 - 1; z += 3) {
    g.box(x, G + 1, z, x + 1, G + 2, z + 1, C.vegStem);
    g.set(x + (i & 1), G + 3, z + ((i >> 1) & 1), fl[i % fl.length]); i++;
  }
}
// Vegetable rows: dark soil, leafy rows along X with the odd tomato / carrot.
function vegRows(g, x0, z0, x1, z1, border = C.woodDark) {
  g.walls(x0, G, z0, x1, G + 1, z1, border);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G, z1 - 1, C.dirtDark);
  let r = 0;
  for (let z = z0 + 2; z < z1 - 1; z += 3, r++) {
    g.box(x0 + 2, G + 1, z, x1 - 2, G + 2, z, C.vegBush);
    for (let x = x0 + 3; x < x1 - 2; x += 4) g.set(x, G + 3, z, r % 2 ? C.orange : C.vegPetalR);
  }
}
function mailbox(g, x, z, c = C.blue) {
  g.box(x, G, z, x, G + 6, z, C.darkGray);
  g.box(x - 1, G + 7, z - 2, x + 1, G + 9, z + 1, c);
  g.box(x + 2, G + 8, z, x + 2, G + 11, z, C.red);
}
// Two wheelie bins (green + blue) with lids.
function bins(g, x, z) {
  g.box(x, G, z, x + 3, G + 5, z + 3, C.roofGreen); g.box(x, G + 6, z, x + 3, G + 6, z + 4, C.resTileGreenDk);
  g.box(x + 5, G, z, x + 8, G + 5, z + 3, C.roofBlue); g.box(x + 5, G + 6, z, x + 8, G + 6, z + 4, C.navy);
}
// A res-8 car (the same model as the traffic, lights off), long axis along Z
// (dir 0) or along X (dir 1), standing on y. (life r6: the traffic is res 12
// now; carModelAt resamples it to this res-8 grid so it keeps traffic size.)
// (life r8) now laid as the full-detail res-15 lot part (vehicles.js
// stampCar), centred on the old 6 × 14 resampled footprint: the res-8
// resample read as a stepped lump on the drive.
function car(g, x, z, variant, dir = 0, y = G) {
  const W = g.raw || g, ox = g.raw ? g.ox : 0, oz = g.raw ? g.oz : 0;
  if (dir) stampCar(W, variant, x + ox + 7 - 9, y, z + oz + 3 - 4, 3);
  else stampCar(W, variant, x + ox + 3 - 4, y, z + oz + 7 - 9, 0);
}
// Striped patio umbrella on a pole.
function umbrella(g, x, z, c1, c2 = C.signWhite, r = 6, y = G) {
  g.box(x, y, z, x, y + 12, z, C.signWhite);
  for (let dx = -r; dx <= r; dx++) g.box(x + dx, y + 13, z - r, x + dx, y + 13, z + r, ((dx + r) >> 1) % 2 ? c2 : c1);
  g.box(x - r + 2, y + 14, z - r + 2, x + r - 2, y + 14, z + r - 2, c1);
  g.box(x - 1, y + 15, z - 1, x + 1, y + 15, z + 1, c1);
}
function lounger(g, x, z, c = C.signWhite, y = G) {
  g.box(x, y, z, x, y + 1, z, C.metalDark); g.box(x + 3, y, z, x + 3, y + 1, z, C.metalDark);
  g.box(x, y + 2, z, x + 3, y + 2, z + 11, c);
  g.box(x, y + 3, z + 9, x + 3, y + 5, z + 11, c);
}
// Satellite dish on a stub mast, facing -Z.
function dish(g, x, y, z) {
  g.box(x, y, z, x, y + 3, z, C.metalDark);
  g.box(x - 2, y + 4, z - 1, x + 2, y + 8, z - 1, C.signWhite);
  g.box(x - 1, y + 5, z - 2, x + 1, y + 7, z - 2, C.signWhite);
  g.set(x, y + 6, z - 4, C.metalDark); g.set(x, y + 6, z - 3, C.darkGray);
}
function waterTank(g, x, z, y) {
  for (const [dx, dz] of [[0, 0], [7, 0], [0, 7], [7, 7]]) g.box(x + dx, y, z + dz, x + dx, y + 5, z + dz, C.metalDark);
  g.box(x, y + 6, z, x + 7, y + 16, z + 7, C.wood);
  for (const yy of [y + 8, y + 13]) g.walls(x, yy, z, x + 7, yy, z + 7, C.woodDark);
  g.box(x + 1, y + 17, z + 1, x + 6, y + 17, z + 6, C.roofGray);
  g.box(x + 3, y + 18, z + 3, x + 4, y + 18, z + 4, C.roofGray);
}
// Patio set: a small table with two stools and an optional umbrella.
function patioSet(g, x, z, c, umb, y = G) {
  g.box(x, y, z, x, y + 4, z, C.darkGray); g.box(x - 2, y + 5, z - 2, x + 2, y + 5, z + 2, C.signWhite);
  g.box(x - 5, y, z - 1, x - 4, y + 2, z, c); g.box(x + 4, y, z - 1, x + 5, y + 2, z, c);
  if (umb != null) umbrella(g, x, z, umb, C.signWhite, 5, y + 6 - 6);
}
// Raised solar array for a flat roof: two tilted rows on legs.
function solarArray(g, x0, z0, x1, z1, y) {
  const zm = z0 + ((z1 - z0) >> 1);
  for (let x = x0; x <= x1; x += 5) { g.box(x, y, z1, x, y + 2, z1, C.metalDark); g.box(x, y, z0, x, y + 1, z0, C.metalDark); }
  solarPanel(g, x0, z0, x1, zm, y + 2, { colors: [C.navy, C.skyBlue], cell: 4 });
  solarPanel(g, x0, zm + 1, x1, z1, y + 3, { colors: [C.navy, C.skyBlue], cell: 4 });
}
function bbq(g, x, z) {
  g.box(x, G, z, x, G + 4, z, C.darkGray); g.box(x + 4, G, z, x + 4, G + 4, z, C.darkGray);
  g.box(x, G + 5, z - 1, x + 4, G + 7, z + 1, C.black);
  g.box(x + 1, G + 8, z, x + 3, G + 8, z, C.metal);
}
// Rooftop planter with a clipped shrub (ref05 rooftop gardens).
function roofPlanter(g, x0, z0, x1, z1, y, box = C.woodDark, h = 4) {
  g.walls(x0, y, z0, x1, y + 2, z1, box);
  g.box(x0 + 1, y, z0 + 1, x1 - 1, y + 1, z1 - 1, C.dirtDark);
  g.box(x0 + 1, y + 2, z0 + 1, x1 - 1, y + 2 + h, z1 - 1, C.vegBush);
  g.box(x0 + 1, y + 2, z0 + 1, x1 - 1, y + 2, z1 - 1, C.vegBushDark);
}
// Garden shed with a door and a tiny gable (ridge along X).
function shed(g, x0, z0, x1, z1, wall, roof, trim = C.white) {
  const h = 12;
  g.box(x0, G, z0, x1, G + h, z1, wall);
  const F = facade(g, 'front', z0);
  const du = (x0 + x1 >> 1) - 1;
  F.box(du - 1, G, 1, du + 3, G + 9, 1, trim); F.clear(du, G, 1, du + 2, G + 8, 1);
  F.box(du, G, 0, du + 2, G + 8, 0, C.woodDark);
  gableRoof(g, 'x', x0, x1, z0, z1, G + h, { roof, fill: wall, edge: true, ov: 2, ova: 1, rise: 2, run: 2, caps: false });
}
// Trampoline (kid-friendly back garden treat).
function trampoline(g, cx, cz, r = 8) {
  for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
    const d = Math.hypot(x, z);
    if (d <= r - 1.5) g.set(cx + x, G + 4, cz + z, C.darkGray);
    else if (d <= r) g.set(cx + x, G + 4, cz + z, C.vehBlue);
  }
  for (const [dx, dz] of [[-r + 2, 0], [r - 2, 0], [0, -r + 2], [0, r - 2]]) g.box(cx + dx, G, cz + dz, cx + dx, G + 3, cz + dz, C.metalDark);
}

// ===========================================================================
// Round 5 kit — facade + lot density (r4 critic: "large blank stucco planes
// with 2-3 small windows", "lots mostly empty grass"). Every home now gets:
// window rows on every face and floor (with sills AND heads), gutters with
// downpipes, a chimney plus a second roof element (dormer / vent / skylight),
// foundation shrubs, a fenced lot and yard clutter.
// ===========================================================================
// Evenly spaced window positions across a wall span a0..a1 (the wall's own
// ends): returns the u of each window's glass left edge. m = margin kept clear
// at each corner (quoins), gap = wall between two glass edges; windows that
// would touch a `skip` range [p, q] (doors, bays) are dropped.
function spread(a0, a1, w, o = {}) {
  const m = o.m != null ? o.m : 5, gap = o.gap != null ? o.gap : 4;
  const span = a1 - a0 + 1 - 2 * m;
  const n = o.n || Math.max(1, Math.floor((span + gap) / (w + gap)));
  const tot = n * w + (n - 1) * gap;
  const s = a0 + m + Math.floor((span - tot) / 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = s + i * (w + gap);
    if (!(o.skip || []).some(([p, q]) => u + w + 1 >= p && u - 2 <= q)) out.push(u);
  }
  return out;
}
// A row of framed windows (sill + head by default) across a wall span.
function winRow(F, a0, a1, y, w, h, S, o = {}) {
  const us = spread(a0, a1, w, o);
  for (const u of us) win(F, u, y, w, h, S, Object.assign({ head: true }, o));
  return us;
}
// Gutter + downpipes for a gable roof built with gableRoof(): a 1-voxel gutter
// under each eave (outside the fascia), and downpipes at the given along-ridge
// positions that swan-neck back to the wall (b0 / b1 planes) and drop to the
// ground. Pure 1-voxel lines: cheap, and they break up the long eave walls.
function gutters(g, roof, b0, b1, pipes, c = C.offwhite, ground = G) {
  const B = axisBox(g, roof.axis);
  const y = roof.y0 - 1;
  B(roof.aa, y, roof.ba - 1, roof.ab, y, roof.ba - 1, c);
  B(roof.aa, y, roof.bb + 1, roof.ab, y, roof.bb + 1, c);
  for (const a of pipes || []) {
    for (const [bo, bw] of [[roof.ba - 1, b0 - 1], [roof.bb + 1, b1 + 1]]) {
      B(a, y - 1, Math.min(bo, bw), a, y - 1, Math.max(bo, bw), c);
      B(a, ground, bw, a, y - 1, bw, c);
      B(a, ground, bw + (bw < b0 ? -1 : 1), a, ground, bw + (bw < b0 ? -1 : 1), c);
    }
  }
}
// Gutter ring + four corner downpipes for a hip roof over x0..x1 × z0..z1.
function hipGutters(g, roof, x0, x1, z0, z1, c = C.offwhite, ground = G) {
  const y = roof.y0 - 1;
  g.walls(roof.xa - 1, y, roof.za - 1, roof.xb + 1, y, roof.zb + 1, c);
  for (const [x, zw, zo] of [[x0 + 1, z0 - 1, roof.za - 1], [x1 - 1, z0 - 1, roof.za - 1], [x0 + 1, z1 + 1, roof.zb + 1], [x1 - 1, z1 + 1, roof.zb + 1]]) {
    g.box(x, y - 1, Math.min(zw, zo), x, y - 1, Math.max(zw, zo), c);
    g.box(x, ground, zw, x, y - 1, zw, c);
  }
}
// Soil-stack vent on a sloped roof (a 2×2 pipe with a wider cap) at x, z.
function roofVent(g, roof, x, z, h = 5) {
  const y = roof.yAt(z) + 1;
  g.box(x, y - 1, z, x + 1, y + h, z + 1, C.metal);
  g.box(x - 1, y + h + 1, z - 1, x + 2, y + h + 1, z + 2, C.metalDark);
}
// Flush skylight laid into a gable-X roof's slope: glass rows in a white frame.
function skylight(g, roof, x0, x1, b0, b1) {
  const lo = Math.min(b0, b1), hi = Math.max(b0, b1);
  for (let b = lo; b <= hi; b++) {
    const y = roof.yAt(b);
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || b === lo || b === hi;
      g.set(x, y, b, edge ? C.signWhite : C.winCool);
      if (roof.rise > 1) g.set(x, y - 1, b, edge ? C.signWhite : C.skyBlue);
    }
  }
}
// Foundation planting along a wall: clipped shrubs of alternating height with
// the odd flower, standing on the lot from a0..a1, depth d out from the wall.
// axis 'x': the strip runs along X at z = b..b+dir*(d-1); 'z': along Z.
function shrubs(g, axis, a0, a1, b, dir, fl, d = 3) {
  let i = 0;
  for (let a = a0; a + 2 <= a1; a += 5, i++) {
    const h = i % 2 ? 3 : 5, w = Math.min(4, a1 - a + 1);
    const b0 = b, b1 = b + dir * (d - 1);
    if (axis === 'x') g.box(a, G, Math.min(b0, b1), a + w - 1, G + h - 1, Math.max(b0, b1), C.vegBush);
    else g.box(Math.min(b0, b1), G, a, Math.max(b0, b1), G + h - 1, a + w - 1, C.vegBush);
    if (fl && i % 2 === 0) {
      const fa = a + 1, fb = b + dir * (d >> 1);
      if (axis === 'x') g.set(fa, G + h, fb, fl[i % fl.length]); else g.set(fb, G + h, fa, fl[i % fl.length]);
    }
  }
}
// Board fence: a solid run of boards (merges to a few quads, ~1/3 the
// triangles of a post-and-rail run) with taller posts every `step`.
function boardFence(g, axis, a0, a1, b, c, o = {}) {
  const B = (p, q, y0, y1, cc) => (axis === 'x' ? g.box(p, y0, b, q, y1, b, cc) : g.box(b, y0, p, b, y1, q, cc));
  const h = o.h || 5, step = o.step || 8;
  const runs = o.gap ? [[a0, o.gap[0] - 1], [o.gap[1] + 1, a1]] : [[a0, a1]];
  for (const [p, q] of runs) {
    if (q < p) continue;
    B(p, q, G, G + h - 2, c);
    for (let a = p; a <= q; a += step) B(a, a, G, G + h, o.post != null ? o.post : c);
    B(q, q, G, G + h, o.post != null ? o.post : c);
  }
}
// Fence the lot's sides and back (x = 2 / x = 60 / z = 60 on a 1×1 lot) with
// board fences. sides: any of 'l', 'r', 'b'; from = the z the side runs start at.
function lotFence(g, c, o = {}) {
  const sides = o.sides || 'lrb', z0 = o.from != null ? o.from : 3, e = o.end != null ? o.end : 60;
  const fo = { step: o.step || 8, h: o.h || 5, post: o.post };
  if (sides.includes('l')) boardFence(g, 'z', z0, e, 2, c, Object.assign({}, fo, o.gapL ? { gap: o.gapL } : {}));
  if (sides.includes('r')) boardFence(g, 'z', z0, e, e, c, Object.assign({}, fo, o.gapR ? { gap: o.gapR } : {}));
  if (sides.includes('b')) boardFence(g, 'x', 2, e, e, c, Object.assign({}, fo, o.gapB ? { gap: o.gapB } : {}));
}
// Stack of wooden crates (1-3), 4 voxels each with a dark top band.
function crates(g, x, z, n = 2, y = G) {
  for (let i = 0; i < n; i++) {
    const cx = x + (i === 1 ? 5 : 0), cy = y + (i === 2 ? 4 : 0), cz = z;
    g.box(cx, cy, cz, cx + 3, cy + 3, cz + 3, C.wood);
    g.walls(cx, cy + 3, cz, cx + 3, cy + 3, cz + 3, C.woodDark);
  }
}
// Terracotta flower pot with a leafy ball and a flower on top.
function pot(g, x, z, fl = C.vegPetalR, y = G) {
  g.box(x, y, z, x + 2, y + 2, z + 2, C.resTileOrangeDk);
  g.box(x, y + 3, z, x + 2, y + 4, z + 2, C.vegBush);
  g.set(x + 1, y + 5, z + 1, fl);
}
// Doghouse (ridge along X, door toward -Z) with a bowl.
function doghouse(g, x, z, wall, roof) {
  g.box(x, G, z, x + 6, G + 5, z + 6, wall);
  g.box(x + 2, G, z, x + 4, G + 3, z, C.black);
  for (let k = 0; k < 4; k++) { g.box(x - 1 + k, G + 6 + k, z - 1, x - 1 + k, G + 6 + k, z + 7, roof); g.box(x + 7 - k, G + 6 + k, z - 1, x + 7 - k, G + 6 + k, z + 7, roof); }
  g.box(x + 3, G + 6, z, x + 3, G + 9, z + 6, wall);
  g.box(x + 3, G + 10, z - 1, x + 3, G + 10, z + 7, roof);
  g.box(x + 8, G, z - 3, x + 9, G, z - 2, C.red);
}
// Clothesline between two T-posts along X with colourful washing.
function clothesline(g, x0, x1, z) {
  for (const x of [x0, x1]) { g.box(x, G, z, x, G + 14, z, C.metal); g.box(x, G + 14, z - 2, x, G + 14, z + 2, C.metal); }
  g.box(x0 + 1, G + 14, z - 2, x1 - 1, G + 14, z - 2, C.signWhite);
  const cols = [C.vehRed, C.signWhite, C.vehBlue, C.yellow, C.pink, C.teal];
  for (let x = x0 + 2, i = 0; x + 2 < x1; x += 5, i++) g.box(x, G + 9 + (i % 2) * 2, z - 2, x + 3, G + 13, z - 2, cols[i % cols.length]);
}
// Bicycle (along X) leaning on its stand.
function bike(g, x, z, c = C.vehRed) {
  for (const wx of [x, x + 6]) { g.box(wx, G, z, wx + 2, G, z, C.black); g.box(wx, G + 2, z, wx + 2, G + 2, z, C.black); g.set(wx, G + 1, z, C.black); g.set(wx + 2, G + 1, z, C.black); }
  g.box(x + 2, G + 3, z, x + 6, G + 3, z, c); g.box(x + 4, G + 1, z, x + 4, G + 3, z, c);
  g.set(x + 3, G + 4, z, C.black); g.box(x + 6, G + 4, z, x + 6, G + 5, z, c); g.set(x + 7, G + 5, z, C.black);
}
// Wheelbarrow with a load (soil / flowers).
function wheelbarrow(g, x, z, c = C.roofGreen) {
  g.box(x, G + 2, z, x + 5, G + 4, z + 3, c);
  g.box(x + 1, G + 4, z + 1, x + 4, G + 4, z + 2, C.dirtDark);
  g.set(x + 2, G + 5, z + 1, C.vegBush); g.set(x + 3, G + 5, z + 2, C.pink);
  g.box(x - 1, G, z + 1, x - 1, G + 1, z + 2, C.darkGray);
  g.box(x + 6, G + 2, z, x + 8, G + 2, z, C.woodDark); g.box(x + 6, G + 2, z + 3, x + 8, G + 2, z + 3, C.woodDark);
  g.box(x + 4, G, z, x + 4, G + 1, z, C.woodDark); g.box(x + 4, G, z + 3, x + 4, G + 1, z + 3, C.woodDark);
}
// Covered woodpile along Z against a fence or wall.
function woodpile(g, x, z0, z1, roofC) {
  g.box(x, G, z0, x + 3, G + 5, z1, C.woodDark);
  for (let z = z0; z <= z1; z += 2) for (let y = G + 1; y <= G + 5; y += 2) g.set(x, y, z, C.plank);
  g.box(x - 1, G + 6, z0 - 1, x + 4, G + 6, z1 + 1, roofC);
}
// Little greenhouse: glass box in a white frame with a glass ridge roof and
// plants inside (ridge along X).
function greenhouse(g, x0, z0, x1, z1) {
  const h = 9;
  g.box(x0, G, z0, x1, G + h, z1, C.skyBlue);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G + 2, z1 - 1, C.vegBush);
  for (let x = x0; x <= x1; x += 4) { g.box(x, G, z0, x, G + h, z0, C.signWhite); g.box(x, G, z1, x, G + h, z1, C.signWhite); }
  for (const x of [x0, x1]) g.box(x, G, z0, x, G + h, z1, C.signWhite);
  g.walls(x0, G + h, z0, x1, G + h, z1, C.signWhite);
  const half = (z1 - z0) >> 1;
  for (let k = 1; k <= half; k++) {
    g.box(x0, G + h + k, z0 + k, x1, G + h + k, z0 + k, C.skyBlue); g.box(x0, G + h + k, z1 - k, x1, G + h + k, z1 - k, C.skyBlue);
    g.set(x0, G + h + k, z0 + k, C.signWhite); g.set(x1, G + h + k, z0 + k, C.signWhite); g.set(x0, G + h + k, z1 - k, C.signWhite); g.set(x1, G + h + k, z1 - k, C.signWhite);
  }
  g.box(x0, G + h + half + 1, z0 + half, x1, G + h + half + 1, z0 + half, C.signWhite);
  g.box(x0 + 1, G + h, z0 + 1, x1 - 1, G + h + half, z1 - 1, C.skyBlue);
}
// Pergola over a patio: four posts, two beams, slats, a vine along one beam.
function pergola(g, x0, z0, x1, z1, c = C.white, h = 16, y = G) {
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.box(x, y, z, x, y + h - 1, z, c);
  g.box(x0 - 1, y + h, z0, x1 + 1, y + h, z0, c); g.box(x0 - 1, y + h, z1, x1 + 1, y + h, z1, c);
  for (let x = x0; x <= x1; x += 3) g.box(x, y + h + 1, z0 - 1, x, y + h + 1, z1 + 1, c);
  g.box(x0, y + h + 2, z0, x1, y + h + 2, z0 + 1, C.vegBush);
  for (let x = x0 + 1; x < x1; x += 4) g.set(x, y + h + 3, z0, C.pink);
}
// Wall trellis with a climbing vine (flush lattice + leaf clumps one proud).
function trellis(F, u0, u1, y0, y1, fl, c = C.signWhite) {
  for (let u = u0; u <= u1; u += 3) F.box(u, y0, 1, u, y1, 1, c);
  for (let y = y0; y <= y1; y += 4) F.box(u0, y, 1, u1, y, 1, c);
  for (let u = u0, i = 0; u < u1; u += 2, i++) {
    const yt = y0 + ((i * 7) % (y1 - y0 - 2));
    F.box(u, y0, 2, u + 1, yt, 2, C.vegBush);
    if (i % 2 === 0) F.set(u, yt + 1, 2, fl);
  }
}
// House-number plaque by the door.
function plaque(F, u, y, c = C.signWhite, t = C.navy) { F.box(u, y, 1, u + 2, y + 2, 1, c); F.set(u + 1, y + 1, 1, t); }
// Sandbox with a red bucket.
function sandbox(g, x0, z0, x1, z1) {
  g.walls(x0, G, z0, x1, G + 1, z1, C.wood);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G, z1 - 1, C.sand);
  g.box(x0 + 2, G + 1, z0 + 2, x0 + 3, G + 2, z0 + 3, C.vehRed);
  g.box(x1 - 4, G + 1, z1 - 3, x1 - 2, G + 1, z1 - 2, C.sandDark);
}
// Garden-hose reel against a wall-side post.
function hoseReel(g, x, z) {
  g.box(x, G, z, x, G + 5, z, C.darkGray);
  g.box(x - 1, G + 2, z + 1, x + 1, G + 4, z + 1, C.roofGreen);
  g.set(x, G + 3, z + 2, C.vegTrunk);
}
// Compost bins: two slatted wooden boxes.
function compost(g, x, z) {
  for (const dx of [0, 6]) { g.walls(x + dx, G, z, x + dx + 4, G + 4, z + 4, C.wood); g.box(x + dx + 1, G, z + 1, x + dx + 3, G + 3, z + 3, C.dirtDark); }
}

// ===========================================================================
// Round 9 kit — facade + rooftop richness. r8 critic: "house and apartment
// facades are big flat, evenly lit fields of stone or siding with a sparse
// grid of small dark-blue windows and plain roof slopes ... ref05 packs every
// facade with framed and silled windows, striped awnings, shopfronts and
// balconies, and their rooftops are cluttered with AC units, planters, water
// tanks and railings". So: bigger windows in a proud frame with a moulded
// hood + keystone and sill brackets, each carrying one accessory (shutters,
// flower box, striped awning, Juliet balcony, AC unit); rusticated bases;
// railed, cluttered flat roofs.
// ===========================================================================
// Rich window. kind: 'shut' | 'box' | 'awn' | 'jul' | 'ac' | null.
// S.awn = awning colours, S.rail = balcony rail, S.key = keystone colour.
function rwin(F, u0, y0, w, h, S, kind, o = {}) {
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  const sc = S.sill != null ? S.sill : (S.quoin != null ? S.quoin : S.trim);
  win(F, u0, y0, w, h, S, Object.assign({
    proud: true, sill: kind === 'jul' ? false : undefined, shutters: kind === 'shut', box: kind === 'box',
    mullion: w >= 6 ? 'cross' : 'h',
  }, o));
  if (kind === 'awn') {
    awning(F, u0 - 2, u1 + 2, y1 + 5, 3, { colors: S.awn || [C.red, C.signWhite], stripe: 1 });
    F.box(u0 - 2, y1 + 6, 1, u1 + 2, y1 + 6, 1, sc);
  } else if (o.hood !== false) {
    F.box(u0 - 2, y1 + 2, 1, u1 + 2, y1 + 2, 2, sc);                 // hood moulding
    F.box(u0 - 1, y1 + 3, 1, u1 + 1, y1 + 3, 1, sc);
    const uc = u0 + ((w - 1) >> 1);
    F.box(uc, y1 + 1, 2, uc + (w % 2 ? 0 : 1), y1 + 4, 2, S.key != null ? S.key : sc);   // keystone
  }
  if (kind !== 'jul' && kind !== 'box') { F.set(u0 - 1, y0 - 3, 1, sc); F.set(u1 + 1, y0 - 3, 1, sc); }   // sill brackets
  if (kind === 'jul') {
    const rc = S.rail != null ? S.rail : S.trim;
    F.box(u0 - 2, y0 - 2, 1, u1 + 2, y0 - 2, 3, sc);
    F.box(u0 - 2, y0 - 3, 3, u1 + 2, y0 - 3, 3, sc);
    for (let u = u0 - 2; u <= u1 + 2; u += 2) F.box(u, y0 - 1, 3, u, y0 + 3, 3, rc);
    F.box(u1 + 2, y0 - 1, 3, u1 + 2, y0 + 3, 3, rc);
    F.box(u0 - 2, y0 + 4, 3, u1 + 2, y0 + 4, 3, rc);
    F.box(u0 - 2, y0 + 4, 1, u0 - 2, y0 + 4, 3, rc); F.box(u1 + 2, y0 + 4, 1, u1 + 2, y0 + 4, 3, rc);
    F.set(u0 - 1, y0 - 1, 2, C.resTileOrangeDk); F.box(u0 - 1, y0, 2, u0, y0 + 1, 2, C.vegBush);   // a pot plant
  }
  if (kind === 'ac') wallAC(F, u0 + ((w - 5) >> 1), y0 - 8, { w: 5, h: 4, d: 3 });
}
// One floor of rich windows across a wall span. The accessory of window i is
// kinds[(i + k0) % kinds.length], so floors and faces can rotate the set.
function richRow(F, a0, a1, y, w, h, S, kinds, o = {}) {
  const us = spread(a0, a1, w, o);
  us.forEach((u, i) => rwin(F, u, y, w, h, S, kinds[(i + (o.k0 || 0)) % kinds.length], o.win));
  return us;
}
// Rusticated base: recessed joint lines every `step` round a block (the
// outer shell voxel is removed, the one behind it painted c).
function rustic(g, x0, z0, x1, z1, y0, y1, c, step = 3) {
  for (let y = y0 + step - 1; y <= y1; y += step) {
    g.walls(x0 + 1, y, z0 + 1, x1 - 1, y, z1 - 1, c);
    for (let x = x0; x <= x1; x++) { g.del(x, y, z0); g.del(x, y, z1); }
    for (let z = z0; z <= z1; z++) { g.del(x0, y, z); g.del(x1, y, z); }
  }
}
// Balustrade round a flat roof (posts every 3, a bottom and a top rail).
function roofRail(g, x0, z0, x1, z1, y, c, h = 5) {
  g.walls(x0, y, z0, x1, y, z1, c);
  g.walls(x0, y + h - 1, z0, x1, y + h - 1, z1, c);
  for (let x = x0; x <= x1; x += 3) { g.box(x, y + 1, z0, x, y + h - 2, z0, c); g.box(x, y + 1, z1, x, y + h - 2, z1, c); }
  for (let z = z0; z <= z1; z += 3) { g.box(x0, y + 1, z, x0, y + h - 2, z, c); g.box(x1, y + 1, z, x1, y + h - 2, z, c); }
}
// Roof stair house: a walled box, a door on its min-Z face, an overhanging cap.
function stairHouse(g, x0, z0, x1, z1, y, wall, trim, h = 13) {
  g.box(x0, y, z0, x1, y + h, z1, wall);
  g.box(x0 - 1, y + h + 1, z0 - 1, x1 + 1, y + h + 1, z1 + 1, trim);
  door(facade(g, 'front', z0), x0 + 2, y, 5, 10, { color: C.metalDark, frame: trim, step: null });
  wallAC(facade(g, 'front', z0), x1 - 5, y + 6, { w: 4, h: 3, d: 2 });
}
// Lattice mast with cross bars and a red tip.
function antenna(g, x, y, z, h = 18) {
  g.box(x, y, z, x, y + h, z, C.metalDark);
  g.box(x - 2, y + h - 5, z, x + 2, y + h - 5, z, C.metalDark);
  g.box(x - 1, y + h - 2, z, x + 1, y + h - 2, z, C.metalDark);
  g.set(x, y + h + 1, z, C.red);
}
// Deck chair (along X, back toward +Z).
function deckChair(g, x, z, c, y) {
  g.box(x, y, z, x + 3, y + 1, z + 3, c);
  g.box(x, y + 2, z + 3, x + 3, y + 4, z + 3, c);
}
// A busy flat roof over x0..x1 × z0..z1 standing on y (ref05's rooftops):
// a balustrade, a stair house, a row of AC condensers, a water tank on legs
// or a solar array, and a roof garden (plank deck, planters, an umbrella and
// chairs), plus vents and a mast. `seed` mirrors and swaps the pieces.
function roofTop(g, x0, z0, x1, z1, y, S, seed = 0, o = {}) {
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const flip = (seed & 1) === 1;
  const X = (a, w) => (flip ? x1 - (a - x0) - (w - 1) : a);    // mirror a piece of width w
  if (o.rail !== false) roofRail(g, x0, z0, x1, z1, y, o.railC != null ? o.railC : S.trim);
  const hx = Math.min(12, (W >> 2) + 2), hz = Math.min(11, D >> 1);
  stairHouse(g, X(x0 + 3, hx), z1 - hz - 1, X(x0 + 3, hx) + hx - 1, z1 - 2, y, o.houseC != null ? o.houseC : S.wall, S.trim, 12);
  const acX = X(x0 + hx + 6, 17);
  acBox(g, acX, y, z1 - 8, { w: 8, d: 6, h: 5 });
  if (W > 34) acBox(g, acX + 9, y, z1 - 8, { w: 8, d: 6, h: 5 });
  ventPipe(g, X(x1 - 4, 1), z1 - 12, y, y + 5);
  ventPipe(g, X(x0 + hx + 6, 1), z1 - 12, y, y + 3);
  const kind = o.kind || ['garden', 'tank', 'solar'][((seed >> 1) % 3 + 3) % 3];
  const fz0 = z0 + 3, fz1 = Math.min(z1 - hz - 4, z0 + 17);
  if (kind === 'tank' || kind === 'garden') {
    // roof garden deck along the front
    const gx0 = X(x0 + 2, W > 36 ? 22 : 18), gx1 = gx0 + (W > 36 ? 22 : 18) - 1;
    g.box(gx0, y - 1, fz0 - 1, gx1, y - 1, fz1, C.plank);
    roofPlanter(g, gx0, fz0 - 1, gx0 + 4, fz1, y, C.woodDark, 3);
    for (let z = fz0 + 1; z < fz1; z += 3) g.set(gx0 + 2, y + 6, z, (S.flowers || FLOWERS[0])[z % 3]);
    umbrella(g, gx0 + 12, fz0 + 6, S.awn ? S.awn[0] : C.orange, C.signWhite, 4, y);
    deckChair(g, gx0 + 7, fz0, C.signWhite, y); deckChair(g, gx0 + 14, fz0, C.signWhite, y);
    pot(g, gx1 - 3, fz1 - 3, C.pink, y);
    if (kind === 'tank') waterTank(g, X(x1 - 11, 8), fz0, y);
    else { roofPlanter(g, X(x1 - 12, 10), fz0, X(x1 - 12, 10) + 9, fz0 + 5, y); antenna(g, X(x1 - 5, 1), y, fz1 + 1, 16); }
  } else {
    solarArray(g, X(x0 + 3, W - 16), fz0, X(x0 + 3, W - 16) + W - 17, fz1, y);
    roofPlanter(g, X(x1 - 10, 8), fz0, X(x1 - 10, 8) + 7, fz0 + 6, y);
    dish(g, X(x1 - 6, 1), y, fz1 + 2);
  }
}

// ===========================================================================
// Round 8 — the yard dresser. r7 critic: "our residential lots are mostly
// flat, empty lime-green lawn ... in ref05 every square of the lot is used:
// paved paths, fenced garden beds, patio furniture ... cut the open lawn to
// about a third of the lot and fill the rest with paving, beds, fences and
// yard props". ref05's farmhouse lot is the model: warm cobbled paving, raised
// timber beds of crops and roses, a small timber-edged lawn, crates.
// It runs at g.done() on every garden lot, AFTER the builder has placed the
// house and its hand-authored props, and looks only at lawn that is still
// bare (nothing within 20 voxels above it):
//  1. the largest free rectangles become, in turn, one or two timber-edged
//     lawn patches with stepping stones (~30% of the bare area), then raised
//     vegetable beds, flower beds, patios with a table / umbrella, box
//     planters, crate stacks and pots (a per-lot rotation, so neighbours
//     differ);
//  2. everything left over — the 1-voxel margins round every feature, the
//     strips along walls and fences — is warm brick paving laid in courses.
// Lines of one colour and long boxes only, so it all greedy-merges.
// ===========================================================================
function yardRng(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Largest all-ones rectangle (both sides >= mn) in a 0/1 mask, X wide.
function largestRect(mask, X, Z, mn = 5) {
  const h = new Int32Array(X), st = new Int32Array(X + 1);
  let best = null, bestA = 0;
  for (let z = 0; z < Z; z++) {
    for (let x = 0; x < X; x++) h[x] = mask[z * X + x] ? h[x] + 1 : 0;
    let sp = 0;
    for (let x = 0; x <= X; x++) {
      const cur = x < X ? h[x] : 0;
      while (sp > 0 && h[st[sp - 1]] >= cur) {
        const hh = h[st[--sp]], left = sp > 0 ? st[sp - 1] + 1 : 0, w = x - left;
        if (w >= mn && hh >= mn && w * hh > bestA) { bestA = w * hh; best = { x0: left, x1: x - 1, z0: z - hh + 1, z1: z }; }
      }
      st[sp++] = x;
    }
  }
  return best;
}
// Raised timber vegetable bed: plank-capped wood sides, dark soil, crop rows
// along the long axis (leaf colour + produce dots vary per row).
const CROPS = [
  [C.vegBush, C.vegPetalR], [C.vegTuft, C.orange], [C.vegStem, C.purple],
  [C.vegBush, C.vegPollen], [C.vegTuft, C.vegPetalR], [C.vegStem, C.pink],
];
function vegBed(g, x0, z0, x1, z1, k = 0) {
  // (w4) darker timber (woodDark rendered orange next to the cabin / porch
  // timber) and ONE produce colour per bed, sparser: the multi-colour dots on
  // every row of every bed read as confetti across the block
  g.walls(x0, G, z0, x1, G + 1, z1, C.trunkDark);
  g.walls(x0, G + 2, z0, x1, G + 2, z1, C.trunk);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G + 1, z1 - 1, C.dirtDark);
  const alongX = x1 - x0 >= z1 - z0;
  const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const B = (a, b, aa, bb, y0, y1, c) => (alongX ? g.box(a, y0, b, aa, y1, bb, c) : g.box(b, y0, a, bb, y1, aa, c));
  for (let b = b0 + 2, r = 0; b <= b1 - 2; b += 3, r++) {
    const leaf = CROPS[(k + r) % CROPS.length][0], fruit = CROPS[k % CROPS.length][1];
    B(a0 + 2, b, a1 - 2, b, G + 2, G + 3, leaf);
    if (r % 2 === 0) for (let a = a0 + 4; a <= a1 - 4; a += 6) B(a, b, a, b, G + 4, G + 4, fruit);
  }
}
// Timber-edged lawn patch with stepping stones and corner posts; big ones get
// a bird bath or a small tree.
function lawnPatch(g, x0, z0, x1, z1, rnd) {
  // a flush timber edging strip (a raised one cost ~500 tris of AO ramps per
  // lot) with a post at two corners
  g.walls(x0, G - 1, z0, x1, G - 1, z1, C.wood);
  for (const [x, z] of [[x0, z0], [x1, z1]]) g.box(x, G, z, x, G + 2, z, C.woodDark);
  const alongX = x1 - x0 >= z1 - z0, w = x1 - x0 + 1, d = z1 - z0 + 1;
  if (alongX) { const zc = (z0 + z1 >> 1) - 1; for (let x = x0 + 2; x + 2 < x1; x += 5) patch(g, x, zc, x + 2, zc + 2, C.lotPave); }
  else { const xc = (x0 + x1 >> 1) - 1; for (let z = z0 + 2; z + 2 < z1; z += 5) patch(g, xc, z, xc + 2, z + 2, C.lotPave); }
  if (Math.min(w, d) >= 20 && rnd() < 0.5) gardenTree(g, (x0 + x1) >> 1, (z0 + z1) >> 1, (rnd() * 997) | 0);
  else if (w >= 12 && d >= 12) {                                 // a clipped bush / a sun lounger off to one side
    const bx = alongX ? x1 - 6 : x0 + 2, bz = alongX ? z0 + 2 : z1 - 6;
    if (rnd() < 0.6) stampVeg(g, rnd() < 0.5 ? 'shrub' : 'bushTall', bx + 2, G, bz + 2, (rnd() * 97) | 0, 1);
    else lounger(g, alongX ? x1 - 5 : x0 + 2, alongX ? z0 + 1 : z1 - 12, C.signWhite);
  }
}
// (w4) Yard flower bed: a light concrete kerb (ref05's lot rims) round one
// clipped mass of low shrubs, sprinkled with a single flower colour — one big
// calm shape instead of a grid of stems each topped by a different dot.
function yardBed(g, x0, z0, x1, z1, fl) {
  g.walls(x0, G, z0, x1, G, z1, C.lotRim);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G + 2, z1 - 1, C.vegBush);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G, z1 - 1, C.vegBushDark);
  let i = 0;
  for (let x = x0 + 2; x < x1 - 1; x += 4) for (let z = z0 + 2 + ((x >> 2) & 1) * 2; z < z1 - 1; z += 4) if ((i++ % 3) !== 2) g.set(x, G + 3, z, fl);
}
// Oak barrel (planter or rain butt).
function barrel(g, x, z, top = C.vegBush) {
  g.box(x, G, z, x + 2, G + 3, z + 2, C.wood);
  g.walls(x, G + 1, z, x + 2, G + 1, z + 2, C.woodDark);
  g.box(x, G + 4, z, x + 2, G + 4, z + 2, top);
}
function dressYard(g, seed) {
  const W = g.raw, X = W.sx, Z = W.sz, y = G - 1, H = 20, N = X * Z;
  const free = new Uint8Array(N);
  let A = 0;
  for (let z = 2; z < Z - 2; z++) for (let x = 2; x < X - 2; x++) {
    if (W.get(x, y, z) !== LAWN) continue;
    let ok = true;
    for (let yy = G; yy < G + H; yy++) if (W.get(x, yy, z) != null) { ok = false; break; }
    if (ok) { free[z * X + x] = 1; A++; }
  }
  // lot cars / visitors live in a separate lot part (vehicles.js), not in the
  // voxels: keep their spots clear too
  const res = [];
  for (const c of W.__lotCars || []) {
    if (c.rect) res.push([c.rect[0] - 1, c.rect[1] - 1, c.rect[2] + 1, c.rect[3] + 1]);
    else if (c.wx != null) res.push([c.wx - 4, c.wz - 4, c.wx + 4, c.wz + 4]);
  }
  for (const [ax, az, bx, bz] of res) for (let z = Math.max(0, Math.floor(az)); z <= Math.min(Z - 1, Math.ceil(bz)); z++)
    for (let x = Math.max(0, Math.floor(ax)); x <= Math.min(X - 1, Math.ceil(bx)); x++) if (free[z * X + x]) { free[z * X + x] = 0; A--; }
  // feature cells keep one voxel of paving between them and anything else
  const core = new Uint8Array(N);
  for (let z = 1; z < Z - 1; z++) for (let x = 1; x < X - 1; x++) {
    let ok = 1;
    for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1; dx++) if (!free[(z + dz) * X + x + dx]) { ok = 0; break; }
    core[z * X + x] = ok;
  }
  const keep = new Uint8Array(N);
  const rnd = yardRng((seed | 0) * 7919 + 1301);
  // (r10) fewer, larger features (r9 critic: 'many small voxel props look noisy')
  const MENU = ['veg', 'flower', 'patio', 'veg', 'flower'];
  let k = ((seed | 0) * 4) % MENU.length, lawn = 0, bed = (seed | 0) * 2;
  const target = A * (X > 120 ? 0.6 : 0.5);             // an estate keeps more lawn
  // caps: [long side, short side]
  const CAP = { lawn: [30, 24], veg: [22, 11], flower: [15, 8], patio: [16, 14], planter: [16, 6], crates: [10, 7], pots: [9, 5] };
  const MIN = { lawn: [12, 12], veg: [10, 7], flower: [8, 6], patio: [13, 13], planter: [8, 5], crates: [9, 5], pots: [5, 5] };
  for (let it = 0; it < 80; it++) {
    const r = largestRect(core, X, Z, 5);
    if (!r) break;
    const w = r.x1 - r.x0 + 1, d = r.z1 - r.z0 + 1, lo = Math.min(w, d), hi = Math.max(w, d);
    const fits = (kd) => hi >= MIN[kd][0] && lo >= MIN[kd][1];
    let kind = null;
    if (lawn < target && fits('lawn')) kind = 'lawn';
    else {
      for (let t = 0; t < MENU.length && !kind; t++) { const c = MENU[(k + t) % MENU.length]; if (fits(c)) { kind = c; k = k + t + 1; } }
    }
    if (!kind) kind = 'pots';
    const [cl, cs] = CAP[kind];
    const fw = w >= d ? Math.min(w, cl) : Math.min(w, cs), fd = w >= d ? Math.min(d, cs) : Math.min(d, cl);
    // hug a random corner of the free rectangle (the rest stays for the next pick)
    const fx0 = rnd() < 0.5 ? r.x0 : r.x1 - fw + 1, fz0 = rnd() < 0.5 ? r.z0 : r.z1 - fd + 1;
    const fx1 = fx0 + fw - 1, fz1 = fz0 + fd - 1;
    for (let z = fz0 - 1; z <= fz1 + 1; z++) for (let x = fx0 - 1; x <= fx1 + 1; x++) if (x >= 0 && z >= 0 && x < X && z < Z) core[z * X + x] = 0;
    const ax = fw >= fd;
    if (kind === 'lawn') {
      for (let z = fz0; z <= fz1; z++) for (let x = fx0; x <= fx1; x++) keep[z * X + x] = 1;
      lawn += fw * fd;
      lawnPatch(W, fx0, fz0, fx1, fz1, rnd);
    } else if (kind === 'veg') vegBed(W, fx0, fz0, fx1, fz1, bed++);
    else if (kind === 'flower') yardBed(W, fx0, fz0, fx1, fz1, FLOWERS[(bed++) % FLOWERS.length][0]);
    else if (kind === 'patio') {
      W.box(fx0, y, fz0, fx1, y, fz1, C.lotPave);
      W.walls(fx0, y, fz0, fx1, y, fz1, C.lotPaveDark);
      const cx = (fx0 + fx1) >> 1, cz = (fz0 + fz1) >> 1;
      const umb = [C.resTerraTrim, C.red, C.teal, C.roofGreen, C.orange][(bed++) % 5];
      patioSet(W, cx, cz, C.wood, umb);
    } else if (kind === 'planter') {
      if (ax) for (let x = fx0; x + 4 <= fx1; x += 6) roofPlanter(W, x, fz0, Math.min(fx1, x + 4), fz1, G, C.woodDark, 2 + (x & 1));
      else for (let z = fz0; z + 4 <= fz1; z += 6) roofPlanter(W, fx0, z, fx1, Math.min(fz1, z + 4), G, C.woodDark, 2 + (z & 1));
    } else if (kind === 'crates') {
      crates(W, fx0, fz0, ax ? 2 + (bed & 1) : 1);
      barrel(W, ax ? fx1 - 2 : fx0, ax ? fz1 - 2 : fz1 - 2, (bed++) % 2 ? C.vegBush : C.woodDark);
    } else {
      pot(W, fx0, fz0, FLOWERS[bed % 4][0]);
      if (fw >= 8 || fd >= 8) pot(W, ax ? fx1 - 2 : fx0, ax ? fz0 : fz1 - 2, FLOWERS[bed % 4][1]);
      bed++;
    }
  }
  // warm brick paving everywhere else that is still bare lawn
  const alongX = (seed | 0) % 2 === 0;
  for (let z = 2; z < Z - 2; z++) for (let x = 2; x < X - 2; x++) {
    const i = z * X + x;
    if (!free[i] || keep[i] || W.get(x, y, z) !== LAWN) continue;
    const a = alongX ? z : x, b = alongX ? x : z;
    // (w1) light sandy paving with warm joint courses: ref05's farmhouse yard
    // measures #f0cc78-#f0e49c; the orange brick (plank) rendered #f0903c and
    // turned every garden into an orange sea
    W.set(x, y, z, a % 6 === 0 ? C.plank : C.sand);
  }
  // Paved lots (apartments, towers, townhouses): the side and back paving
  // gets street furniture — box planters, benches with pots, bike racks,
  // street trees in kerbed pits, crates — every other free rectangle, so some
  // open flagstones stay (ref05's paved forecourts are furnished, not full).
  const pv = new Uint8Array(N);
  let P = 0;
  for (let z = g.oz + 12; z < Z - 2; z++) for (let x = 2; x < X - 2; x++) {
    const c = W.get(x, y, z);
    if (c !== C.lotPave && c !== C.lotPaveDark) continue;
    if (res.some(([ax, az, bx, bz]) => x >= ax && x <= bx && z >= az && z <= bz)) continue;
    let ok = true;
    for (let yy = G; yy < G + H; yy++) if (W.get(x, yy, z) != null) { ok = false; break; }
    if (ok) { pv[z * X + x] = 1; P++; }
  }
  if (P < 200) return;
  const pc = new Uint8Array(N);
  for (let z = 1; z < Z - 1; z++) for (let x = 1; x < X - 1; x++) {
    let ok = 1;
    for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= X || zz >= Z || !pv[zz * X + xx]) { ok = 0; break; }
    }
    pc[z * X + x] = ok;
  }
  const URB = ['planter', 'bench', 'tree', 'bikes', 'planter', 'crates', 'bench', 'pots'];
  let u = (seed | 0) % URB.length, placed = 0;
  const maxN = Math.max(2, Math.floor(P / 340));
  for (let it = 0; it < 40 && placed < maxN; it++) {
    const r = largestRect(pc, X, Z, 5);
    if (!r) break;
    const w = r.x1 - r.x0 + 1, d = r.z1 - r.z0 + 1, ax = w >= d, hi = Math.max(w, d), lo = Math.min(w, d);
    let kind = URB[u++ % URB.length];
    if (kind === 'tree' && lo < 9) kind = 'planter';
    if ((kind === 'bench' || kind === 'bikes') && hi < 12) kind = 'pots';
    const fl = Math.min(hi, kind === 'tree' ? 9 : 16), fs = Math.min(lo, kind === 'tree' ? 9 : 5);
    const fw = ax ? fl : fs, fd = ax ? fs : fl;
    const fx0 = rnd() < 0.5 ? r.x0 : r.x1 - fw + 1, fz0 = rnd() < 0.5 ? r.z0 : r.z1 - fd + 1;
    const fx1 = fx0 + fw - 1, fz1 = fz0 + fd - 1;
    // leave a generous walkway round each piece
    for (let z = fz0 - 6; z <= fz1 + 6; z++) for (let x = fx0 - 6; x <= fx1 + 6; x++) if (x >= 0 && z >= 0 && x < X && z < Z) pc[z * X + x] = 0;
    placed++;
    if (kind === 'planter') roofPlanter(W, fx0, fz0, fx1, fz1, G, C.stoneDark, 3);
    else if (kind === 'tree') streetTree(W, (fx0 + fx1) >> 1, (fz0 + fz1) >> 1, seed * 13 + placed);
    else if (kind === 'bench') {
      bench(W, ax ? fx0 + 3 : fx0, G, ax ? fz0 : fz0 + 3, ax ? 'x' : 'z', Math.min(10, hi - 6), { seat: C.wood });
      pot(W, fx0, fz0, FLOWERS[placed % 4][0]);
      pot(W, ax ? fx1 - 2 : fx0, ax ? fz0 : fz1 - 2, FLOWERS[placed % 4][1]);
    } else if (kind === 'bikes') {
      for (let a = 0; a + 1 < Math.min(hi, 14); a += 3) (ax ? W.box(fx0 + a, G, fz0, fx0 + a, G + 4, fz0 + 2, C.darkGray) : W.box(fx0, G, fz0 + a, fx0 + 2, G + 4, fz0 + a, C.darkGray));
      const bc = [C.vehRed, C.teal, C.yellow, C.vehBlue];
      if (ax) { bike(W, fx0 + 1, fz0 + 3, bc[placed % 4]); } else { W.box(fx0 + 3, G + 1, fz0 + 2, fx0 + 3, G + 3, fz0 + 8, bc[placed % 4]); }
    } else if (kind === 'crates') crates(W, fx0, fz0, ax ? 2 : 1);
    else { pot(W, fx0, fz0, FLOWERS[placed % 4][0]); pot(W, fx0 + (ax ? 4 : 0), fz0 + (ax ? 0 : 4), FLOWERS[placed % 4][2]); }
  }
}

// ======================= HOMES =============================================

// ---------------------------------------------------------------------------
// (r10) ref04 kit — FEWER, LARGER relief elements. The r9 critic (one small
// house vs ref04): our house covered a third of its lot, its cool grey walls
// ran into a near-black band along the ground floor, and fences / beds / bins
// / a car / shrubs crowded round it; ref04 is big, clean, warm stucco faces,
// chunky cream quoins, thick raised window and door frames, wall lamps and a
// bold stepped parapet + roof-deck silhouette. This kit draws exactly those.
// ---------------------------------------------------------------------------
// Chunky continuous corner quoins: courses bh tall, arms alternating long /
// short (and swapped between the two faces of a corner), proud p on both
// faces — ref04's stacked cream blocks. No gap rows: the stagger alone draws
// the joints, so each course merges into a few big quads.
function bigQuoins(g, x0, z0, x1, z1, y0, y1, c, bh = 4, L = [8, 5], p = 2) {
  for (let y = y0, k = 0; y <= y1; y += bh, k++) {
    const ye = Math.min(y1, y + bh - 1), la = L[k % 2], lb = L[(k + 1) % 2];
    for (const [cx, cz, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
      // the block's top row steps back one voxel: a joint line that reads
      // as ref04's separate stacked stones
      const yb = ye > y && p > 1 ? ye - 1 : ye;
      g.box(cx - dx * p, y, cz - dz * p, cx + dx * (la - 1), yb, cz - dz, c);
      g.box(cx - dx * p, y, cz - dz * p, cx - dx, yb, cz + dz * (lb - 1), c);
      if (yb < ye) {
        g.box(cx - dx * (p - 1), ye, cz - dz * (p - 1), cx + dx * (la - 2), ye, cz - dz, c);
        g.box(cx - dx * (p - 1), ye, cz - dz * (p - 1), cx - dx, ye, cz + dz * (lb - 2), c);
      }
    }
  }
}
// Quoin post caps: a block one course proud of the post on top, and a
// smaller block above it (ref04's stepped post tops).
function postCaps(g, x0, z0, x1, z1, y, c, p = 2, s = 5) {
  for (const [cx, cz, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
    const ax = cx - dx * p, az = cz - dz * p, bx = ax + dx * (s + p - 1), bz = az + dz * (s + p - 1);
    g.box(ax, y, az, bx, y + 2, bz, c);
    g.box(ax + dx * 1, y + 3, az + dz * 1, bx - dx * 1, y + 4, bz - dz * 1, c);
  }
}
// ref04 window: a 2-voxel raised outer frame, a 1-voxel inner step in the
// wall plane, the glass recessed one voxel with a transom bar, and a deep
// sill ledge in the quoin tone.
function bigWin(F, u0, y0, w, h, S, o = {}) {
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  const fr = o.frame != null ? o.frame : S.frame, sl = o.sill != null ? o.sill : S.quoin;
  F.box(u0 - 2, y0 - 2, 1, u1 + 2, y1 + 2, 1, fr);
  F.clear(u0 - 1, y0 - 1, 1, u1 + 1, y1 + 1, 1);
  F.box(u0 - 1, y0 - 1, 0, u1 + 1, y1 + 1, 0, fr);
  F.clear(u0, y0, 0, u1, y1, 0);
  F.box(u0, y0, -1, u1, y1, -1, o.glass != null ? o.glass : S.glass);
  if (h >= 9) F.box(u0, y0 + ((h * 3) >> 2) - 1, -1, u1, y0 + ((h * 3) >> 2) - 1, 0, fr);
  if (w >= 9) F.box(u0 + (w >> 1), y0, -1, u0 + (w >> 1), y1, 0, fr);
  if (o.sill !== false) F.box(u0 - 3, y0 - 3, 1, u1 + 3, y0 - 3, 2, sl);
}
// ref04 double door: a thick raised surround, an inner step, two cream
// leaves with bar handles, and a red mat laid into the ground in front.
function bigDoor(F, u0, y0, w, h, S, o = {}) {
  const u1 = u0 + w - 1, y1 = y0 + h - 1, fr = S.frame;
  F.box(u0 - 3, y0, 1, u1 + 3, y1 + 3, 1, fr);
  F.clear(u0 - 1, y0, 1, u1 + 1, y1 + 1, 1);
  F.box(u0 - 1, y0, 0, u1 + 1, y1 + 1, 0, fr);
  F.clear(u0, y0, 0, u1, y1, 0);
  F.box(u0, y0, -1, u1, y1, -1, S.door);
  if (w >= 8) {
    const um = u0 + (w >> 1);
    F.box(um - 1, y0, -1, um - 1, y1, -1, fr);
    F.box(um - 3, y0 + (h >> 1) - 2, 0, um - 3, y0 + (h >> 1) + 1, 0, fr);
    F.box(um + 1, y0 + (h >> 1) - 2, 0, um + 1, y0 + (h >> 1) + 1, 0, fr);
  } else F.box(u1 - 2, y0 + (h >> 1) - 1, 0, u1 - 2, y0 + (h >> 1) + 1, 0, fr);
  if (o.mat !== false) F.box(u0 - 2, y0 - 1, 1, u1 + 2, y0 - 1, 5, C.red);
}
// ref04 wall lamp: a bracket arm off the wall and a 3×3 amber lantern with
// a glowing underside.
function bigLamp(F, u, y, S) {
  F.box(u, y + 3, 1, u, y + 3, 3, S.frame);
  F.box(u, y + 3, 1, u, y + 5, 1, S.frame);
  F.box(u - 1, y, 2, u + 1, y + 2, 4, C.amber);
  F.box(u - 1, y, 2, u + 1, y, 4, C.lamp);
}
// Potted topiary (ref04: a red box pot and a tall clipped lime column).
function potTopiary(g, x, z, pot = C.red, h = 12, y = G) {
  g.box(x - 2, y, z - 2, x + 2, y + 3, z + 2, pot);
  g.box(x - 1, y + 3, z - 1, x + 1, y + 3, z + 1, C.dirtDark);
  g.box(x, y + 4, z, x, y + 5, z, C.vegTrunk);
  g.box(x - 1, y + 6, z - 1, x + 1, y + 5 + h, z + 1, C.vegTuft);
}
// Clean wall block with ref04's trim: flush base line, bold cornice band
// (proud 1, 3 tall) under the eaves, chunky quoins.
function ref04Block(g, x0, z0, x1, z1, y0, y1, S, o = {}) {
  solid(g, x0, y0, z0, x1, y1, z1, S.wall);
  g.walls(x0, y0, z0, x1, y0, z1, S.frame);
  if (o.refQ && o.cornice !== false) {
    // (w4r3) ONE bold band (3 tall, 2 proud) — ref04's cornice; the w4r2
    // 2-step band + curb + rail read as a stack of thin lines
    g.walls(x0 - 2, y1 - 2, z0 - 2, x1 + 2, y1, z1 + 2, S.frame);
  } else if (o.cornice !== false) {
    // (w4r2) a 2-step cornice: a 1-proud band with a 2-proud lip on top, so
    // the ledge throws ref04's deep soft AO line onto the plain wall below
    g.walls(x0 - 1, y1 - 3, z0 - 1, x1 + 1, y1, z1 + 1, S.frame);
    g.walls(x0 - 2, y1 - 1, z0 - 2, x1 + 2, y1, z1 + 2, S.frame);
  }
  if (o.refQ) refQuoins(g, x0, z0, x1, z1, y0, o.qTop != null ? o.qTop : y1, S.quoin, o.refQ);
  else bigQuoins(g, x0, z0, x1, z1, y0, o.qTop != null ? o.qTop : y1, S.quoin, o.bh || 4, o.L || [8, 5], 2);
}
// ref04's roof deck over a block whose walls top out at y: a cream deck, a
// low curb in the frame tone, quoin posts rising above it with stepped caps,
// and a rail between the posts.
function roofDeck(g, x0, z0, x1, z1, y, S, o = {}) {
  g.box(x0, y + 1, z0, x1, y + 1, z1, S.deck);
  g.walls(x0 - 1, y + 1, z0 - 1, x1 + 1, y + 2, z1 + 1, S.frame);     // the cornice rises into a curb
  const ph = o.ph || 5;
  postCaps(g, x0, z0, x1, z1, y + 1, S.quoin, 2, 5);
  if (ph > 5) bigQuoins(g, x0, z0, x1, z1, y + 4, y + ph - 2, S.quoin, 4, [5, 5], 2);
  if (o.rail !== false) {
    g.walls(x0 + 2, y + ph + 1, z0 + 2, x1 - 2, y + ph + 2, z1 - 2, S.frame);
    for (const [a, b] of [[x0 + 2, z0 + 2], [x1 - 2, z0 + 2], [x0 + 2, z1 - 2], [x1 - 2, z1 - 2]]) g.box(a, y + 3, b, a, y + ph, b, S.frame);
  }
}

// (w4) The apartment's bold flat-roof crown as a kit piece — FEWER, BIGGER
// relief trims (critic consensus) in place of r9's thin balustrades and
// bracket rows: a 2-step cornice under the roof line, a deck, a 5-tall
// parapet standing 2 proud in the light tone, a coping in the accent tone and
// ref04's stepped corner post caps. The block's walls top out at `top`.
function boldCrown(g, x0, z0, x1, z1, top, pc, tc, o = {}) {
  cornice(g, x0, z0, x1, z1, top - 3, tc, tc);
  g.box(x0, top + 1, z0, x1, top + 1, z1, o.deck != null ? o.deck : C.stone);
  g.walls(x0 - 2, top, z0 - 2, x1 + 2, top + 4, z1 + 2, pc);
  g.walls(x0 - 3, top + 5, z0 - 3, x1 + 3, top + 5, z1 + 3, tc);
  postCaps(g, x0 - 1, z0 - 1, x1 + 1, z1 + 1, top + 5, pc, 2, 6);
}
// (w4) A solid low parapet along the two open (min-X / min-Z) edges of a
// setback terrace, with a coping — one bold band instead of r9's post rails.
function ledgeWall(g, x0, z0, x1, z1, y, pc, tc, h = 4) {
  g.box(x0, y, z0, x1, y + h - 1, z0, pc); g.box(x0, y, z0, x0, y + h - 1, z1, pc);
  g.box(x0 - 1, y + h, z0 - 1, x1, y + h, z0 + 1, tc); g.box(x0 - 1, y + h, z0 - 1, x0 + 1, y + h, z1, tc);
}
// (w4) The apartment's paired window (w1) as a kit piece: two 3-wide panes
// sharing a mullion (7 wide) inside one flush accent frame ring, recessed
// glass with a transom, a proud head and sill in the light tone. `hsh`
// picks a warm pane now and then; o.bal hangs a railed balcony instead of
// the sill, o.box a flower box under it.
function pairWin(Fc, u, y, wh, W, hsh, o = {}) {
  Fc.box(u - 1, y - 1, 0, u + 7, y + wh, 0, W.frame);
  for (const w0 of [u, u + 4]) {
    const glass = ((hsh >> (3 + w0 - u)) & 3) === 0 ? C.win : W.glass;
    Fc.clear(w0, y, 0, w0 + 2, y + wh - 1, 0);
    Fc.box(w0, y, -1, w0 + 2, y + wh - 1, -1, glass);
    Fc.box(w0, y + wh - 4, -1, w0 + 2, y + wh - 4, -1, W.frame);    // transom
  }
  if (o.head !== false) Fc.box(u - 2, y + wh + 1, 1, u + 8, y + wh + 1, 1, W.pil);
  if (o.bal) {
    railBalcony(Fc, u - 3, u + 9, y, 5, W.slab, W.rail, { h: 7 });
    Fc.box(u - 2, y, 3, u - 1, y + 1, 4, C.resTerraTrim); Fc.box(u - 2, y + 2, 3, u - 1, y + 3, 4, C.vegBush);
  } else {
    Fc.box(u - 2, y - 2, 1, u + 8, y - 2, 2, W.pil);
    if (o.box || (o.box == null && (hsh >> 9) % 5 === 0)) flowerBox(Fc, u, u + 6, y - 3, FLOWERS[(hsh >> 11) & 3]);
  }
}
const whash = (a) => ((a | 0) * 2654435761) >>> 0;

// (w4r3) ref04 measured on its own voxel grid (the w4r2 critic: our quoins
// and windows were "small ... noise at game zoom"). ref04's corner is a
// continuous core post (arm ~5, 1 proud) with big square blocks (arm ~9,
// 3 proud, 4 tall) every 6 rows, so each block stands alone with a dark
// recessed neck under it — not bigQuoins' flat long/short stagger.
function refQuoins(g, x0, z0, x1, z1, y0, y1, c, o = {}) {
  const ca = o.ca || 4, cp = o.cp || 1, ba = o.ba || 7, bp = o.bp || 2, bh = o.bh || 4, per = o.per || 7;
  for (const [cx, cz, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
    const col = (a, p, ya, yb) => {
      g.box(cx - dx * p, ya, cz - dz * p, cx + dx * (a - 1), yb, cz - dz, c);
      g.box(cx - dx * p, ya, cz - dz * p, cx - dx, yb, cz + dz * (a - 1), c);
    };
    col(ca, cp, y0, y1);
    // blocks hang from the top so the last one caps the column under the cornice
    for (let yt = y1; yt - bh + 1 >= y0; yt -= per) col(ba, bp, yt - bh + 1, yt);
  }
}
// (w4r3) ref04's fat window: a 1-wide outer lip 1 proud, a 2-wide main frame
// 2 proud, a one-voxel reveal and the glass behind the wall plane, split by
// one bold 2-tall bar (a sash window — no mullion grid). Outer size w+6 × h+6.
function fatWin(F, u0, y0, w, h, S, o = {}) {
  const u1 = u0 + w - 1, y1 = y0 + h - 1, fr = o.frame != null ? o.frame : S.frame;
  const lip = o.lip != null ? o.lip : fr;
  F.box(u0 - 3, y0 - 3, 1, u1 + 3, y1 + 3, 1, lip);
  F.box(u0 - 2, y0 - 2, 2, u1 + 2, y1 + 2, 2, fr);
  F.box(u0 - 2, y0 - 2, 1, u1 + 2, y1 + 2, 1, fr);
  F.clear(u0, y0, 0, u1, y1, 2);
  F.box(u0, y0, -1, u1, y1, -1, o.glass != null ? o.glass : S.glass);
  const ym = y0 + (h >> 1);
  F.box(u0, ym - 1, -1, u1, ym, 0, fr);
  // a pale reflection streak in the upper pane (ref05's glassy windows)
  if (w >= 5 && h >= 10) F.box(u0 + 1, y1 - 2, -1, u0 + 1, y1 - 1, -1, C.winCool);
}
// (w4r3) ref04 flat roof: the cornice rises into a 2-tall curb, big stepped
// post caps on the quoin columns, and a solid 2×2 rail spanning post to post
// along the outer edge with open air under it.
function refDeck(g, x0, z0, x1, z1, y, S, o = {}) {
  const ba = o.ba || 7, bp = o.bp || 2;
  g.box(x0, y + 1, z0, x1, y + 1, z1, o.deck != null ? o.deck : S.deck);   // the cornice band's orange top frames it
  for (const [cx, cz, dx, dz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) {
    const ax = cx - dx * bp, az = cz - dz * bp, bx = cx + dx * (ba - 1), bz = cz + dz * (ba - 1);
    g.box(ax, y + 1, az, bx, y + 6, bz, S.quoin);                                   // post
    g.box(ax + dx * 2, y + 7, az + dz * 2, bx - dx * 2, y + 9, bz - dz * 2, S.quoin);   // stepped cap
  }
  if (o.rail !== false) {
    // a solid 2 x 2 rail between the posts, one voxel in from the cornice
    // edge, with open air (the deck) under it
    const ry = y + (o.ry || 4);
    g.walls(x0, ry, z0, x1, ry + 1, z1, S.frame);
    g.walls(x0 + 1, ry, z0 + 1, x1 - 1, ry + 1, z1 - 1, S.frame);
  }
}

// Small House — ref04 at street scale: one clean warm stucco storey that
// fills its lot, chunky cream quoins, thick raised window and door frames,
// wall lamps, a bold cornice, and a roof with real form. The lot is calm:
// lawn, a paved path to a red mat, potted topiaries at the door, one garden
// tree and a back patio — no fences, bins or car crowding the house.
//   v0 sage stucco, cream quoins, tile gable with a front dormer + chimney
//   v1 ref04 itself: terracotta stucco, roof deck, stair house with AC
//   v2 yellow stucco, red hip roof with a box dormer
//   v3 cream stucco, terracotta quoins, slate gable + solar panels
const SMALL = [
  scheme({ wall: C.resSage, quoin: C.cream, frame: C.resTileGreenDk, trim: C.resTileGreenDk, door: C.cream, deck: C.cream, roof: ROOF.tile, glass: C.win, pot: C.resTerraTrim, flowers: FLOWERS[0], kind: 'gable' }),
  scheme({ wall: C.resTerracotta, quoin: C.resQuoin, frame: C.roofBrown, trim: C.roofBrown, door: C.resQuoin, deck: C.resQuoin, roof: ROOF.tile, glass: C.win, pot: C.red, flowers: FLOWERS[1], kind: 'deck' }),
  scheme({ wall: C.pYellow, quoin: C.white, frame: C.resTerraTrim, trim: C.resTerraTrim, door: C.roofGreen, deck: C.white, roof: ROOF.red, glass: C.win, pot: C.resTerraTrim, flowers: FLOWERS[2], kind: 'hip' }),
  scheme({ wall: C.cream, quoin: C.resTerraTrim, frame: C.roofBlue, trim: C.roofBlue, door: C.white, deck: C.white, roof: ROOF.slate, glass: C.win, pot: C.roofBlue, flowers: FLOWERS[3], kind: 'gable' }),  // (w4r2) peach read grey, royal-blue roof was loud
];
function bSmallHouse(rng, variant) {
  const G0 = G;
  G = 6;                                        // 0.5 units at res 12
  try { return smallHouse(variant); } finally { G = G0; }
}
function smallHouse(variant) {
  const v = vOf(variant, 4), S = SMALL[v];
  const g = grid(63, 110, 63, 12);            // authored on the full res-12 tile (95 voxels)
  const W = g.raw, X = W.sx - 1, Z = W.sz - 1, ox = g.ox, oz = g.oz;
  // a calm lawn lot on the raw tile grid (no dressYard pass)
  lotPlinth(W, 0, 0, X, Z, { h: G, fill: LAWN });
  W.walls(1, G - 1, 1, X - 1, G - 1, Z - 1, C.lotRim);
  g.groove = true;
  // (w4r2) ref04 is a tall, confident mass (w4r1 critic: ours was 'squat').
  // (w4r3) The w4r2 critic: our windows were 'thin ... fine mullions' and the
  // quoin steps small, so both turned to noise at game zoom. Now drawn from
  // ref04 measured on its own voxel grid (it maps ~1:1 onto this res-12
  // body): ONE row of big sash windows per face (outer 12 × 22, a 3-voxel
  // stepped frame, one bold bar), refQuoins' big square blocks on a core
  // post, and a solid rail on refDeck. The wall faces stay plain.
  // (w4r4) The w4r3 critic: 'a plain square block ... big walls are mostly
  // flat stucco with a few windows'; w4r2: 'fewer, larger windows with fat
  // frames'. Midpoint: the SAME fat ref04 windows, one row per storey, with
  // a bold 2-tall string course between the storeys — the house now reads
  // as two storeys and every face carries 3-4 big windows. Body +4 taller.
  const x0 = 20, x1 = 75, z0 = 22, z1 = 69, top = G + 52;
  const B = (a, b, c, d, e, f, col) => W.box(a, b, c, d, e, f, col);
  const gw = W;                           // authored straight on the tile grid
  ref04Block(gw, x0, z0, x1, z1, G, top, S, { refQ: {} });
  const wy = G + 8, wh = 13;              // ground-floor glass (outer G+5..G+23)
  const uy = G + 33, uh = 12;             // upper-floor glass (outer G+30..G+47)
  const L = facade(gw, 'left', x0), Rt = facade(gw, 'right', x1);
  const F = facade(gw, 'front', z0), Bk = facade(gw, 'back', z1);
  // string course between the quoin columns (the quoins keep their own colour)
  for (const [f, a, b] of [[F, x0, x1], [Bk, x0, x1], [L, z0, z1], [Rt, z0, z1]]) {
    f.box(a + 7, G + 27, 1, b - 7, G + 28, 1, S.frame);
    f.box(a + 7, G + 26, 1, b - 7, G + 26, 1, S.quoin);
  }

  // FRONT: a window on the left, the double door on the right with a lamp
  // either side (ref04's door face), two windows upstairs with flower boxes;
  // the back mirrors it.
  const dm = 56;
  for (const f of [F, Bk]) {
    fatWin(f, x0 + 13, wy, 7, wh, S);
    bigDoor(f, dm - 5, G, 10, 21, S, { mat: f === F });
    bigLamp(f, dm - 10, G + 15, S); bigLamp(f, dm + 9, G + 15, S);
    for (const u of [x0 + 13, dm - 3]) {
      fatWin(f, u, uy, 7, uh, S);
      if (f === F) flowerBox(f, u - 2, u + 8, G + 29, S.flowers, S.frame);
    }
  }
  // SIDES: two big windows side by side on each storey (ref04's window face)
  for (const f of [L, Rt]) for (const y of [wy, uy]) { fatWin(f, z0 + 12, y, 7, y === wy ? wh : uh, S); fatWin(f, z1 - 18, y, 7, y === wy ? wh : uh, S); }

  // ROOF
  if (S.kind === 'deck') {
    refDeck(gw, x0, z0, x1, z1, top, S);
    // stair house at the back-left: its own smaller quoins, cornice, deck and posts
    const sx0 = x0 + 6, sx1 = x0 + 39, sz0 = z0 + 16, sz1 = z1 - 6, st = top + 22;
    const sq = { ca: 3, cp: 1, ba: 6, bp: 2, bh: 3, per: 6 };
    ref04Block(gw, sx0, sz0, sx1, sz1, top + 2, st, S, { refQ: sq });
    refDeck(gw, sx0, sz0, sx1, sz1, st, S, { ba: 6, bp: 2, deck: S.wall });   // ref04: a wall-tone roof with its own rail
    const SF = facade(gw, 'front', sz0);
    bigDoor(SF, sx1 - 14, top + 2, 5, 15, S);
    fatWin(facade(gw, 'right', sx1), ((sz0 + sz1) >> 1) - 2, top + 8, 4, 8, S);
    wallAC(SF, sx0 + 9, top + 10, { w: 7, h: 5, d: 3 });
    // deck life: potted topiaries, two loungers under an umbrella
    potTopiary(gw, sx1 + 8, sz0 - 6, S.pot, 7, top + 2);
    potTopiary(gw, x1 - 14, z0 + 12, S.pot, 7, top + 2);
    umbrella(W, x1 - 14, z1 - 13, C.red, C.signWhite, 6, top + 2);
    lounger(W, x1 - 24, z1 - 16, C.signWhite, top + 2);
  } else {
    let roof;
    const rs = { roof: S.roof, fill: S.wall, edge: true, fascia: S.frame, ov: 3, ova: 3, rise: 1, run: 1, lip: S.roof[0] };
    if (S.kind === 'hip') {
      roof = hipRoof(gw, x0, x1, z0, z1, top, { roof: S.roof, ov: 3, rise: 1, run: 1, fascia: S.frame, ridge: S.roof[1] });
      boxDormer(gw, roof, (x0 + x1) >> 1, 13, 11, Object.assign({}, S, { trim: S.quoin }), 'front');
    } else {
      roof = gableRoof(gw, 'x', x0, x1, z0, z1, top, rs);
      // gable-end windows
      for (const f of [L, Rt]) bigWin(f, ((z0 + z1) >> 1) - 3, top + 4, 6, 7, S, { sill: false });
      if (v === 0) dormer(gw, roof, (x0 + x1) >> 1, 15, 12, Object.assign({}, S, { trim: S.quoin }), 'front');
    }
    // chimney through the back slope
    const cz = z1 - 12, cx = v === 3 ? x0 + 10 : x1 - 16;
    chimney(gw, cx, cz, 6, 6, top, roof.top + 4, v === 2 ? C.brickDark : C.brick, S.quoin);
    if (v === 3) roofPanels(gw, roof, x0 + 22, x1 - 8, z1 - 16, z1 - 4);
  }

  // LOT: a paved path from the kerb to the mat, topiaries at the door, a
  // garden tree at one front corner, a clipped hedge block at the other,
  // a back patio with a table and umbrella, and flower borders under the
  // side windows (low, colourful, no dark foundation band).
  B(dm - 5, G - 1, 2, dm + 5, G - 1, z0 - 7, C.lotPave);
  for (let z = 6; z < z0 - 7; z += 5) B(dm - 5, G - 1, z, dm + 5, G - 1, z, C.lotPaveDark);
  potTopiary(gw, dm - 12, z0 - 6, S.pot); potTopiary(gw, dm + 12, z0 - 6, S.pot);
  gardenTree(W, v % 2 ? 8 : X - 8, 10, v + 3);
  stampVeg(W, 'shrub', v % 2 ? X - 9 : 9, G, 9, v + 5, 1);
  B(22, G - 1, z1 + 8, 50, G - 1, z1 + 21, C.lotPave);
  W.walls(22, G - 1, z1 + 8, 50, G - 1, z1 + 21, C.lotPaveDark);
  B(dm - 5, G - 1, z1 + 6, dm + 5, G - 1, z1 + 12, C.lotPave);      // back step to the patio
  patioSet(W, 36, z1 + 14, C.wood, [C.red, C.teal, C.resTerraTrim, C.roofGreen][v]);
  gardenTree(W, X - 10, Z - 10, v + 9);
  // flower borders under the side windows, clear of the quoin blocks
  for (const [a, b] of [[z0 + 9, z0 + 21], [z1 - 21, z1 - 9]]) {
    for (const [xa, xb] of [[x0 - 6, x0 - 4], [x1 + 4, x1 + 6]]) {
      B(xa, G, a, xb, G + 1, b, C.vegBush);
      for (let z = a + 1, i = 0; z < b; z += 3, i++) W.set(xa + 1, G + 2, z, S.flowers[i % 2]);
    }
  }
  return g.done();
}

// ---- APARTMENTS -----------------------------------------------------------
// The ref05 mid-rise: a darker ground floor (shopfronts with striped awnings
// or a lobby), four upper floors of small framed windows in a regular grid on
// every face — slim corner pilasters, flush floor lines, sill courses,
// balconies on the centre bays, wall AC units — a crowning cornice, a parapet
// with coping, and a busy roof: a stair house, AC condensers, a water tank or
// solar array, and a roof garden. Tall faces use the flush tower window
// (frame ring in the wall plane) so the grid stays cheap.
const APT = [
  // (w1) warm clean walls, warm bases (v2's slate base read cold / grey).
  // NB resButter and peach render near-neutral grey-white under the grade;
  // cream renders the warm tan of ref05's apartments.
  { wall: C.cream, frame: C.resTileGreenDk, trim: C.resTileDk, base: C.resTerraTrim, pil: C.resTerraTrim, glass: C.winCool, rail: C.resTileGreenDk, slab: C.resQuoin, awn: [C.roofGreen, C.signWhite], ground: 'shops' },   // (w4) white quoins / parapet read grey-white
  { wall: C.resTerraTrim, frame: C.resQuoin, trim: C.brickDark, base: C.brickDark, pil: C.resQuoin, glass: C.win, rail: C.resQuoin, slab: C.cream, awn: [C.red, C.signWhite], ground: 'cafe' },
  { wall: C.resSage, frame: C.resTileGreenDk, trim: C.resTerraTrim, base: C.resTerraTrim, pil: C.cream, glass: C.winCool, rail: C.resTileGreenDk, slab: C.cream, awn: [C.resTerraTrim, C.signWhite], ground: 'lobby' },   // (w4) white rails read grey
];
function bApartment(rng, variant) {
  const v = vOf(variant, 3), A = APT[v];
  const S = scheme({ wall: A.wall, quoin: A.pil, trim: A.trim, frame: A.frame, glass: A.glass, base: A.base, sill: A.pil, flowers: FLOWERS[v] });
  const g = grid(63, 150, 63, R);
  lot(g, 62, 62, 'pave', v);
  paving(g, 2, 2, 60, 60, 7);
  const x0 = 7, x1 = 55, z0 = 12, z1 = 52, gh = 26, fh = 22, nf = 4;
  const g1 = G + gh, top = g1 + nf * fh;                      // 118
  solid(g, x0, G, z0, x1, top, z1, A.wall);
  solid(g, x0, G, z0, x1, g1 - 1, z1, A.base);
  cornice(g, x0, z0, x1, z1, g1 - 2, A.pil, A.trim);
  // (w1) FEWER, BIGGER relief trims (critic consensus): chunky 2-proud
  // quoins up the four corners in place of the slim pilasters, a proud
  // string course per floor, and a bold crown — a 2-step cornice, a tall
  // proud parapet with a coping and ref04's stepped corner post caps.
  for (let f = 1; f < nf; f++) belt(g, x0, z0, x1, z1, g1 + f * fh - 1, A.pil, 2);
  bigQuoins(g, x0, z0, x1, z1, g1, top - 4, A.pil, 4, [6, 3], 2);
  cornice(g, x0, z0, x1, z1, top - 3, A.trim, A.trim);
  g.box(x0, top + 1, z0, x1, top + 1, z1, C.stone);
  g.walls(x0 - 2, top, z0 - 2, x1 + 2, top + 4, z1 + 2, A.pil);                 // parapet
  g.walls(x0 - 3, top + 5, z0 - 3, x1 + 3, top + 5, z1 + 3, A.trim);            // coping
  postCaps(g, x0 - 1, z0 - 1, x1 + 1, z1 + 1, top + 5, A.pil, 2, 6);

  const F = facade(g, 'front', z0), B = facade(g, 'back', z1);
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1);
  // (w1) finer window rhythm (critic consensus): PAIRS of 3-wide windows
  // sharing a mullion — three pairs front / back, two on the sides — each a
  // flush accent frame ring round recessed glass with a transom, on a proud
  // sill and under a head in the trim tone. Wall piers stay between pairs
  // (w1-b: single windows at a 6 pitch turned the whole facade white).
  const pairsX = [15, 27, 39], pairsZ = [22, 34];
  // --- upper floors ---
  for (let f = 0; f < nf; f++) {
    const y = g1 + 5 + f * fh;
    for (const [Fc, pairs, fb] of [[F, pairsX, true], [B, pairsX, true], [L, pairsZ, false], [Rt, pairsZ, false]]) {
      // the front / back get one balcony per floor, moving between pairs
      const bp = fb ? (f + (Fc === B ? 1 : 0)) % 3 : -1;
      pairs.forEach((u, i) => {
        const bal = i === bp;
        const hsh = ((f * 7 + i * 13 + (Fc === B ? 5 : Fc === L ? 11 : Fc === Rt ? 17 : 0) + v * 3) * 2654435761) >>> 0;
        const wh = bal ? 14 : 11;
        Fc.box(u - 1, y - 1, 0, u + 7, y + wh, 0, A.frame);
        for (const w0 of [u, u + 4]) {
          const glass = ((hsh >> (3 + w0 - u)) & 3) === 0 ? C.win : A.glass;
          Fc.clear(w0, y, 0, w0 + 2, y + wh - 1, 0);
          Fc.box(w0, y, -1, w0 + 2, y + wh - 1, -1, glass);
          Fc.box(w0, y + wh - 4, -1, w0 + 2, y + wh - 4, -1, A.frame);    // transom
        }
        Fc.box(u - 2, y + wh + 1, 1, u + 8, y + wh + 1, 1, A.pil);         // head
        if (bal) {
          railBalcony(Fc, u - 3, u + 9, y, 5, A.slab, A.rail, { h: 7 });
          Fc.box(u - 2, y, 3, u - 1, y + 1, 4, C.resTerraTrim); Fc.box(u - 2, y + 2, 3, u - 1, y + 3, 4, C.vegBush);
        } else {
          Fc.box(u - 2, y - 2, 1, u + 8, y - 2, 2, A.pil);                 // sill
          if ((hsh >> 9) % 5 === 0) flowerBox(Fc, u, u + 6, y - 3, FLOWERS[(hsh >> 11) & 3]);
        }
      });
    }
    if (f % 2 === 1) wallAC(Rt, 29, y - 7, { w: 5, h: 4, d: 3 });
    else wallAC(L, 29, y - 7, { w: 5, h: 4, d: 3 });
  }
  downpipe(Rt, 15, g1, top - 4, A.trim);
  // --- ground floor ---
  const gy = G + 3;
  if (A.ground === 'shops' || A.ground === 'cafe') {
    // two shopfronts either side of the lobby: big glazing, a sign band, awnings
    for (const [u0, u1] of [[10, 25], [37, 52]]) {
      F.clear(u0, gy, 0, u1, gy + 13, 0);
      F.box(u0, gy, -1, u1, gy + 13, -1, C.winCool);
      F.box(u0 - 1, gy - 1, 0, u1 + 1, gy - 1, 0, A.pil); F.box(u0 - 1, gy + 14, 0, u1 + 1, gy + 14, 0, A.pil);
      for (let u = u0 + 5; u < u1; u += 5) F.box(u, gy, -1, u, gy + 13, -1, A.pil);
      awning(F, u0 - 1, u1 + 1, gy + 18, 4, { colors: A.awn, stripe: 2 });
      signPanel(F, u0 + 2, u1 - 2, gy + 19, gy + 21, C.signWhite, { border: A.trim });
    }
    // planters + a café table out front (v1)
    if (A.ground === 'cafe') { patioSet(g, 17, 5, C.resTerraTrim, C.red); patioSet(g, 45, 5, C.resTerraTrim, null); }
    else for (const px of [11, 41]) roofPlanter(g, px, 3, px + 10, 7, G, C.stoneDark, 3);
  } else {
    for (const u of [11, 20, 38, 47]) towerWin(F, u, gy + 2, 4, 11, C.winCool, A.pil);
    for (const px of [10, 44]) roofPlanter(g, px, 3, px + 8, 8, G, A.trim, 4);
  }
  // lobby: glass double door, canopy on posts, number plate
  entry(F, 28, G + 1, 7, 16, S, { color: C.darkGray, double: true, glass: C.winCool, lamps: false, stepDepth: 3, surround: A.pil });
  F.box(24, G + 21, 1, 38, G + 21, 8, A.trim); F.box(24, G + 22, 1, 38, G + 22, 8, A.pil);
  for (const u of [24, 38]) F.box(u, G, 8, u, G + 20, 8, A.rail);
  signPanel(F, 29, 34, G + 24, G + 27, C.signWhite, { border: A.trim });
  lamp(F, 25, G + 12, S); lamp(F, 36, G + 12, S);
  // sides + back of the ground floor
  // side shopfronts: two glazed bays with sign bands and striped awnings
  for (const Fc of [L, Rt]) for (const [u0, u1] of [[15, 29], [37, 49]]) {
    Fc.clear(u0, gy, 0, u1, gy + 12, 0); Fc.box(u0, gy, -1, u1, gy + 12, -1, C.winCool);
    Fc.box(u0 - 1, gy - 1, 0, u1 + 1, gy - 1, 0, A.pil); Fc.box(u0 - 1, gy + 13, 0, u1 + 1, gy + 13, 0, A.pil);
    for (let u = u0 + 4; u < u1; u += 5) Fc.box(u, gy, -1, u, gy + 12, -1, A.pil);
    awning(Fc, u0 - 1, u1 + 1, gy + 17, 4, { colors: Fc === L ? A.awn : [C.teal, C.signWhite], stripe: 2 });
  }
  for (const [x, z] of [[2, 18], [2, 44], [57, 20], [57, 46]]) pot(g, x, z, C.vegPetalR);
  crates(g, 57, 34, 1); crates(g, 57, 39, 1);
  for (const u of [11, 38, 47]) towerWin(B, u, gy + 4, 4, 9, C.winCool, A.pil);
  door(B, 20, G, 6, 15, { color: C.metalDark, frame: A.pil, step: null });
  awning(B, 18, 28, G + 20, 3, { colors: A.awn, stripe: 2 });

  // --- roof ---
  const ry = top + 2;
  g.box(10, ry, 36, 22, ry + 14, 49, A.wall); g.box(9, ry + 15, 35, 23, ry + 15, 50, A.trim);
  door(facade(g, 'front', 36), 14, ry, 5, 11, { color: C.metalDark, frame: A.pil, step: null });
  acBox(g, 27, ry, 42, { w: 8, d: 6, h: 5 }); acBox(g, 38, ry, 42, { w: 8, d: 6, h: 5 });
  ventPipe(g, 51, 47, ry, ry + 4);
  if (v === 0) {
    waterTank(g, 12, 18, ry);
    for (const [px, pz] of [[28, 16], [42, 16]]) roofPlanter(g, px, pz, px + 9, pz + 6, ry);
    umbrella(g, 36, 30, C.roofGreen, C.signWhite, 5, ry);
  } else if (v === 1) {                                         // roof garden
    g.box(26, ry - 1, 15, 52, ry - 1, 36, C.plank);
    for (const [px, pz] of [[26, 15], [44, 15], [44, 29]]) roofPlanter(g, px, pz, px + 8, pz + 7, ry);
    stampVeg(g, 'sapling', 16, ry, 22, 5, 1);
    umbrella(g, 34, 26, C.red, C.signWhite, 5, ry);
    bench(g, 30, ry, 33, 'x', 8, { seat: C.wood });
  } else {                                                      // solar + dish
    solarArray(g, 26, 15, 52, 32, ry);
    dish(g, 14, ry, 26);
    roofPlanter(g, 11, 15, 20, 20, ry);
  }
  // --- lot: planters, trees, bike rack, benches ---
  // back yard: a clipped hedge along the boundary with flower beds, two
  // street trees in kerbed pits, a covered bike rack, recycling bins, a bench
  hedge(g, 2, 59, 60, 60, 5);
  flowerBed(g, 40, 54, 52, 57, S.flowers);
  streetTree(g, 8, 56, 3); streetTree(g, 57, 56, 5);
  for (let x = 20; x <= 32; x += 3) g.box(x, G, 55, x, G + 5, 57, C.darkGray);     // bike rack
  g.box(18, G + 9, 54, 34, G + 9, 58, A.trim); for (const x of [18, 34]) g.box(x, G, 58, x, G + 8, 58, A.rail);
  g.box(23, G + 1, 55, 25, G + 4, 57, C.vehRed); g.box(29, G + 1, 55, 31, G + 4, 57, C.teal);
  pot(g, 13, 53, S.flowers[1]); pot(g, 36, 53, S.flowers[0]);
  bench(g, 2 + 1, G, 28, 'z', 10, { seat: C.wood });
  bench(g, 58, G, 22, 'z', 10, { seat: C.wood });
  // (r6) a busy street front like ref05's paved lots: bikes, bins, hydrant,
  // a news box and café chairs, so no slab of the lot is left bare
  bike(g, 2, 4, [C.vehRed, C.teal, C.yellow][v]); bike(g, 2, 8, C.vehBlue);
  bins(g, 52, 3);
  hydrant(g, 58, 9);
  g.box(52, G, 8, 54, G + 5, 10, C.vehBlue); g.box(52, G + 6, 8, 54, G + 6, 10, C.navy);   // news box
  if (A.ground !== 'cafe') { pot(g, 22, 3, S.flowers[0]); pot(g, 39, 3, S.flowers[1]); }
  crates(g, 2, 48, 1); crates(g, 2, 13, 1);
  return g.done();
}

// Cottage — storybook half-timber (the ref05 farmhouse look): a stone
// plinth, a timber frame over plaster (sole plate, wall plate, corner posts,
// studs and diagonal braces painted flush), a steep thin-coursed roof with
// dormers, an exterior stone chimney, shuttered windows with flower boxes and
// an arched door under a gabled hood. A cottage garden: stepping stones,
// flower beds, a picket fence, and a per-variant treat.
//   v0 cream + brown shingle, rose arbor gate, bird bath
//   v1 sage + slate, two box dormers, wishing well
//   v2 butter + tile, vegetable patch + wheelbarrow of flowers
const COTTAGE = [
  scheme({ wall: C.cream, quoin: C.resQuoin, trim: C.woodDark, roof: ROOF.brown, door: C.roofGreen, shutter: C.roofGreen, base: C.stone, flowers: FLOWERS[0] }),
  scheme({ wall: C.resSage, quoin: C.cream, trim: C.woodDark, roof: ROOF.blue, door: C.brick, shutter: C.cream, base: C.stone, flowers: FLOWERS[3] }),
  scheme({ wall: C.resButter, quoin: C.cream, trim: C.woodDark, roof: ROOF.tile, door: C.resSlate, shutter: C.resTerraTrim, base: C.stone, flowers: FLOWERS[1] }),
];
function bCottage(rng, variant) {
  const v = vOf(variant, 3), S = COTTAGE[v];
  const g = grid(63, 110, 63, R);
  lot(g, 62, 62, 'grass', v);
  const x0 = 12, x1 = 47, z0 = 24, z1 = 46, top = G + 26, sole = G + 6;
  body(g, x0, z0, x1, z1, G, top, S, { baseH: 6 });
  belt(g, x0, z0, x1, z1, sole, S.trim);
  belt(g, x0, z0, x1, z1, top, S.trim);
  const F = facade(g, 'front', z0), B = facade(g, 'back', z1);
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1);
  // timber frame, flush: corner posts, studs, mid rail
  for (const [Fc, a, b] of [[F, x0, x1], [B, x0, x1], [L, z0, z1], [Rt, z0, z1]]) {
    Fc.box(a, sole + 1, 0, a + 1, top - 1, 0, S.trim); Fc.box(b - 1, sole + 1, 0, b, top - 1, 0, S.trim);
    Fc.box(a, sole + 13, 0, b, sole + 13, 0, S.trim);
  }
  for (const Fc of [F, B]) for (const u of [25, 34]) Fc.box(u, sole + 1, 0, u, top - 1, 0, S.trim);
  for (const Fc of [L, Rt]) Fc.box(35, sole + 1, 0, 35, top - 1, 0, S.trim);
  const roof = gableRoof(g, 'x', x0, x1, z0, z1, top, { roof: S.roof, fill: S.wall, edge: true, fascia: S.trim, ov: 4, ova: 3 });
  gutters(g, roof, z0, z1, [x1 - 1], C.woodDark);
  // king post + collar beam in both gables, two attic windows
  for (const Fc of [L, Rt]) {
    Fc.box(35, top + 1, 0, 35, roof.top - 5, 0, S.trim);
    Fc.box(28, top + 12, 0, 42, top + 12, 0, S.trim);
    win(Fc, 30, top + 3, 3, 6, S, { mullion: null, sill: false, frame: S.trim });
    win(Fc, 38, top + 3, 3, 6, S, { mullion: null, sill: false, frame: S.trim });
  }
  // front: arched door under a hood, four shuttered windows with flower boxes
  F.clear(26, sole, 1, 33, sole, 1);
  door(F, 27, sole - 3, 6, 15, { color: S.door, frame: S.trim, glass: null, step: C.stone, stepDepth: 4, mat: C.red, knob: C.gold });
  F.set(27, sole + 11, -1, S.trim); F.set(32, sole + 11, -1, S.trim);
  F.box(29, sole + 5, -1, 30, sole + 8, -1, C.win);                       // peephole light
  hood(F, 25, 34, sole + 15, 5, S.roof[0], S.trim);
  for (const u of [15, 20, 38, 43]) win(F, u, sole + 3, 3, 8, S, { box: true, frame: S.trim, head: true, mullion: 'h' });
  if (v === 0) dormer(g, roof, 30, 11, 12, S, 'front');
  else if (v === 1) { boxDormer(g, roof, 20, 11, 11, S, 'front'); boxDormer(g, roof, 40, 11, 11, S, 'front'); skylight(g, roof, 24, 33, 38, 43); }
  else { dormer(g, roof, 30, 11, 12, S, 'back'); boxDormer(g, roof, 30, 11, 11, S, 'front'); }
  roofVent(g, roof, 42, 41);
  // sides: two shuttered windows each (+ a trellis vine on the right)
  for (const f of [L, Rt]) for (const u of [28, 40]) win(f, u, sole + 3, 4, 8, S, { shutters: true, frame: S.trim, head: true, box: f === Rt && v !== 1 });
  trellis(Rt, 33, 37, sole + 1, sole + 16, S.flowers[0], S.trim);
  // back: four windows + stable door, a lamp, a wall AC
  for (const u of [15, 20, 38, 43]) win(B, u, sole + 3, 3, 8, S, { frame: S.trim, head: true, box: u === 15 || u === 43 });
  door(B, 28, sole - 3, 5, 14, { color: S.shutter, frame: S.trim, step: C.stone, stepDepth: 3 });
  B.box(28, sole + 4, -1, 32, sole + 4, -1, S.trim);
  B.clear(27, sole, 1, 33, sole, 1);
  lamp(B, 34 - 0, sole + 7, S);
  // exterior stone chimney on the left gable
  // (r7) warm brick with cream bands: the r6 grey stacks read as heavy blobs
  g.box(x0 - 6, G, 30, x0 - 1, G + 8, 39, C.brickDark);
  g.box(x0 - 5, G + 9, 31, x0 - 1, roof.top + 3, 38, C.brick);
  for (let y = G + 16; y < roof.top; y += 10) g.box(x0 - 5, y, 31, x0 - 5, y, 38, S.quoin);
  g.box(x0 - 6, roof.top + 3, 30, x0, roof.top + 4, 39, S.quoin);
  g.box(x0 - 4, roof.top + 5, 33, x0 - 3, roof.top + 7, 35, C.resTileOrangeDk);
  // foundation shrubs: right side + back
  shrubs(g, 'z', z0 + 1, 31, x1 + 1, 1, S.flowers, 2);
  shrubs(g, 'x', x0 + 1, 24, z1 + 1, 1, S.flowers, 2);
  shrubs(g, 'x', 36, x1 - 1, z1 + 1, 1, S.flowers, 2);

  // garden: stepping stones, picket fence all round, beds, per-variant treat
  for (let z = 3; z < 19; z += 4) patch(g, 27, z, 32, z + 2, C.lotPave);    // stepping stones
  fence(g, 'x', 2, 60, 3, C.white, { gap: [25, 34], pickets: true });
  lotFence(g, C.white, { from: 3, pickets: true, gapR: [40, 46] });
  flowerBed(g, 4, 7, 22, 17, S.flowers);
  flowerBed(g, 37, 7, 58, 17, [S.flowers[1], S.flowers[0]]);
  bush(g, 54, 53, 5, 6); bush(g, 49, 56, 4, 4);
  bins(g, 50, 40 - 1);
  hoseReel(g, 50, 21);
  if (v === 0) {                                               // rose arbor, bird bath, greenhouse
    for (const x of [25, 34]) g.box(x, G, 3, x, G + 16, 4, C.white);
    g.box(25, G + 17, 2, 34, G + 18, 5, C.white);
    for (const x of [26, 29, 32]) g.set(x, G + 19, 3, C.vegPetalR);
    g.box(25, G + 19, 4, 34, G + 19, 4, C.vegBush);
    g.box(54, G, 29, 55, G + 5, 30, C.stone); g.box(52, G + 6, 27, 57, G + 6, 32, C.stone);
    g.box(53, G + 6, 28, 56, G + 6, 31, C.waterLight);
    greenhouse(g, 6, 50, 21, 58);
    for (const px of [25, 29, 33]) pot(g, px, 55, S.flowers[px % 2]);
    bench(g, 38, G, 56, 'x', 9, { seat: C.wood });
  } else if (v === 1) {                                        // wishing well, clothesline, doghouse
    g.walls(51, G, 25, 58, G + 5, 32, C.stone); g.box(52, G + 5, 26, 57, G + 5, 31, C.waterMid);
    for (const z of [25, 32]) g.box(54, G + 6, z, 55, G + 14, z, C.woodDark);
    for (let k = 0; k < 4; k++) g.box(50 + k, G + 15 + k, 24, 59 - k, G + 15 + k, 33, S.roof[k % 2]);
    g.box(54, G + 11, 26, 55, G + 11, 31, C.woodDark); g.box(54, G + 8, 28, 55, G + 10, 29, C.wood);
    clothesline(g, 6, 34, 52);
    doghouse(g, 38, 52, C.cream, C.resSlateDk);
    bush(g, 3, 55, 5, 5);
  } else {                                                     // veg patch, barrow, compost, crates
    vegRows(g, 3, 50, 30, 59);
    wheelbarrow(g, 51, 27);
    compost(g, 33, 52);
    crates(g, 46, 49, 2);
  }
  return g.done();
}

// Big House — two storeys: flush quoins, a belt course between floors, an
// eave cornice, a columned porch carrying a railed balcony with a balcony
// door, a gable / hip roof with a gabled dormer and chimney, an attached
// garage with a panelled door, a flat roof with solar + a condenser; a paved
// drive with the car, a path, hedges, bins and a per-variant back garden.
const BIG = [
  scheme({ wall: C.peach, quoin: C.white, trim: C.resSlateDk, base: C.resSlate, roof: ROOF.tile, door: C.brick, flowers: FLOWERS[0], car: 10, shutter: C.resSlateDk, lower: C.resSlate, joint: C.resSlateDk, awn: [C.resTerraTrim, C.signWhite], sill: C.white }),
  scheme({ wall: C.cream, quoin: C.resQuoin, trim: C.resTerraTrim, base: C.resTerraTrim, roof: ROOF.tile, door: C.roofGreen, flowers: FLOWERS[1], car: 9, shutter: C.roofGreen, lower: C.resTerracotta, joint: C.resTerraTrim, awn: [C.roofGreen, C.signWhite] }),
  scheme({ wall: C.resTerracotta, quoin: C.resQuoin, trim: C.resTerraTrim, base: C.stone, roof: ROOF.brown, door: C.resQuoin, flowers: FLOWERS[2], car: 19, shutter: C.resTileGreenDk, lower: C.resQuoin, joint: C.stone, awn: [C.red, C.signWhite] }),
];
function bBigHouse(rng, variant) {
  const v = vOf(variant, 3), S = BIG[v];
  const g = grid(63, 130, 63, R);
  lot(g, 62, 62, 'grass', v);
  const x0 = 4, x1 = 38, z0 = 24, z1 = 50, fh = 22, top = G + 2 * fh + 1;
  body(g, x0, z0, x1, z1, G, top, S);
  g.walls(x0, G + 3, z0, x1, G + fh - 1, z1, S.lower);                 // (r9) rusticated ground floor
  rustic(g, x0, z0, x1, z1, G + 3, G + fh - 2, S.joint, 3);
  quoins(g, x0, z0, x1, z1, G + 3, top - 1, S.quoin, 6, [6, 3], 2);
  belt(g, x0, z0, x1, z1, G + fh, S.trim);
  cornice(g, x0, z0, x1, z1, top, S.trim, S.quoin);
  const roof = v === 1
    ? hipRoof(g, x0, x1, z0, z1, top + 2, { roof: S.roof, ov: 3, fascia: S.trim, ridge: S.trim })
    : gableRoof(g, 'x', x0, x1, z0, z1, top + 2, { roof: S.roof, fill: S.wall, edge: true, fascia: S.trim, ov: 3, ova: 2 });
  if (v === 1) hipGutters(g, roof, x0, x1, z0, z1); else gutters(g, roof, z0, z1, [x0 + 1]);

  const F = facade(g, 'front', z0);
  entry(F, 18, G + 2, 6, 16, S, { glass: C.win, lamps: false, stepDepth: 2 });
  for (const u of [8, 31]) { rwin(F, u - 1, G + 6, 5, 12, S, 'box'); rwin(F, u - 1, G + fh + 5, 5, 12, S, 'shut'); }
  win(F, 18, G + fh + 3, 6, 15, S, { glass: C.win, mullion: 'v', sill: false, proud: true });        // balcony door
  // porch: floor, two columns with bases + capitals, a railed balcony on top
  g.box(12, G, 16, 29, G + 1, z0 - 1, C.concrete);
  for (const px of [13, 28]) {
    g.box(px, G + 2, 17, px + 1, G + fh - 2, 18, S.quoin);
    g.box(px - 1, G + 2, 16, px + 2, G + 2, 19, S.trim); g.box(px - 1, G + fh - 2, 16, px + 2, G + fh - 1, 19, S.trim);
  }
  railBalcony(F, 12, 29, G + fh + 2, 8, S.quoin, S.trim);
  lamp(F, 15, G + 13, S); lamp(F, 26, G + 13, S);
  pot(g, 14, 19, S.flowers[0], G + 2); pot(g, 25, 19, S.flowers[1], G + 2);
  if (v === 0) { dormer(g, roof, 21, 11, 12, S, 'front'); skylight(g, roof, 26, 33, 42, 47); roofVent(g, roof, 28, 46); }
  if (v === 1) { boxDormer(g, roof, 21, 11, 11, S, 'front'); boxDormer(g, roof, 21, 11, 11, S, 'back'); }
  if (v === 2) { boxDormer(g, roof, 13, 9, 11, S, 'front'); boxDormer(g, roof, 29, 9, 11, S, 'front'); dish(g, 12, roof.yAt(47) + 1, 47); roofVent(g, roof, 26, 45); }

  // garage wing (right): lower flat roof with a parapet, panelled door
  const gx0 = 39, gx1 = 58, gz0 = 28, gz1 = 50, gt = G + 22;
  g.box(gx0, G, gz0, gx1, gt, gz1, S.wall);
  line(g, gx0, gz0, gx1, gz1, G, S.base, 3);
  g.box(gx0, gt + 1, gz0, gx1, gt + 1, gz1, C.stone);
  cornice(g, gx0, gz0, gx1, gz1, gt, S.trim, S.quoin);
  const GF = facade(g, 'front', gz0);
  GF.box(42, G, 0, 55, G + 16, 0, S.trim);
  GF.clear(43, G, 0, 54, G + 15, 0);
  GF.box(43, G, -1, 54, G + 15, -1, C.offwhite);
  for (let y = G + 3; y <= G + 15; y += 4) GF.box(43, y, -1, 54, y, -1, C.concrete);  // panel lines
  lamp(GF, 48, G + 20, S);
  // basketball hoop over the garage door
  GF.box(47, G + 18, 1, 50, G + 21, 1, C.signWhite); GF.box(48, G + 18, 2, 49, G + 18, 3, C.orange);
  if (v !== 1) solarArray(g, 42, 32, 56, 42, gt + 3);
  else roofPlanter(g, 42, 32, 56, 38, gt + 2);
  acBox(g, 44, gt + 2, 44, { w: 8, d: 5, h: 5 });

  // sides + back: window rows on both floors, a back deck + balcony
  const L = facade(g, 'left', x0), GR = facade(g, 'right', gx1), B = facade(g, 'back', z1), RB = facade(g, 'right', x1);
  richRow(L, z0, z1, G + 6, 5, 12, S, ['shut'], { n: 2, gap: 7, m: 3 });
  richRow(L, z0, z1, G + fh + 5, 5, 12, S, ['box', 'jul', 'box'], { n: 3, gap: 3, m: 3 });
  if (v !== 1) { win(L, 33, top + 10, 3, 6, S, { mullion: null, sill: false }); win(L, 41, top + 10, 3, 6, S, { mullion: null, sill: false }); }
  for (const [u, k] of [[27, 'awn'], [43, 'box']]) rwin(RB, u, G + fh + 5, 5, 12, S, k);      // above the garage roof
  wallAC(L, 45 - 10, G + 3 - 0, { w: 5, h: 4, d: 3 });
  win(GR, 33, G + 7, 5, 8, S, { mullion: 'v', head: true }); win(GR, 42, G + 7, 5, 8, S, { mullion: 'v', head: true });
  richRow(B, x0, x1, G + 6, 5, 12, S, ['shut', 'box'], { n: 4, gap: 3, m: 3, skip: [[17, 24]] });
  door(B, 18, G + 2, 6, 15, { color: C.white, frame: S.trim, glass: S.glass, double: true, step: null });
  const bu = richRow(B, x0, x1, G + fh + 5, 5, 12, S, ['awn', 'box'], { n: 4, gap: 3, m: 3, skip: [[15, 27]] });
  win(B, 17, G + fh + 3, 8, 14, S, { mullion: 'v', sill: false });               // balcony doors
  railBalcony(B, 14, 28, G + fh + 2, 5, S.quoin, S.trim);
  // back deck with a rail and steps
  g.box(10, G, z1 + 1, 32, G + 1, z1 + 6, C.plank);
  for (let x = 10; x <= 32; x += 2) g.box(x, G + 2, z1 + 6, x, G + 6, z1 + 6, C.wood);
  g.box(10, G + 7, z1 + 6, 32, G + 7, z1 + 6, C.woodDark);
  for (let x = 20; x <= 23; x++) for (let y = G + 2; y <= G + 7; y++) g.del(x, y, z1 + 6);
  door(facade(g, 'back', gz1), 47, G + 1, 5, 15, { color: C.white, frame: S.trim, step: C.concrete });
  win(facade(g, 'back', gz1), 53, G + 7, 3, 8, S, { head: true });
  const cyb = v === 1 ? roof.top - 8 : roof.yAt(z1 - 4) - 2;
  chimney(g, 7, z1 - 6, 5, 5, cyb, roof.top + 5, C.brick, S.quoin);

  // lot: drive + car, path, hedges, bed, fenced back garden
  path(g, 40, 2, 57, gz0 - 1);
  car(g, 45, 5, S.car);
  path(g, 18, 2, 23, 15);
  hedge(g, 2, 4, 15, 6, 6); hedge(g, 26, 4, 37, 6, 6);
  flowerBed(g, 3, 10, 11, 20, S.flowers);
  topiary(g, 30, G, 11, 8);
  pot(g, 33, 17, S.flowers[1]);
  lotFence(g, S.trim, { sides: 'lb', from: 8 });
  boardFence(g, 'z', gz1 + 1, 60, 60, S.trim);
  bins(g, 50, 53);
  hoseReel(g, 59, 30);
  shrubs(g, 'z', z0 + 1, z1 - 1, x0 - 1, -1, S.flowers, 2);
  if (v === 0) {                                             // swing set + sandbox
    for (const x of [36, 46]) { g.box(x, G, 54, x, G + 16, 54, C.red); g.box(x, G, 59, x, G + 16, 59, C.red); }
    g.box(36, G + 17, 54, 46, G + 17, 59, C.red);
    for (const x of [39, 43]) { g.box(x, G + 6, 56, x, G + 16, 56, C.darkGray); g.box(x - 1, G + 5, 55, x + 1, G + 5, 57, C.vehBlue); }
    sandbox(g, 3, 53, 9, 59);
  } else if (v === 1) {                                      // small pool
    patch(g, 3, 57 - 5, 44, 61, C.lotPave);
    g.walls(34, G, 53, 46, G, 60, C.signWhite);
    g.box(35, G - 1, 54, 45, G - 1, 59, C.civPool);
    lounger(g, 4, 49 + 0, C.signWhite);
    umbrella(g, 12, 56, C.orange, C.signWhite, 5);
  } else {                                                   // bbq + clothesline
    patch(g, 34, 52, 48, 61, C.lotPave);
    bbq(g, 36, 57); patioSet(g, 44, 56, C.resTerraTrim, C.orange);
    woodpile(g, 4, 52, 59, S.roof[1]);
  }
  return g.done();
}

// Townhouse — tall brownstone with a raised, rusticated ground floor: a stoop
// with railings, a two-storey bay window, and (r9) every face packed like a
// ref05 row house: proud-framed windows with moulded hoods and keystones, each
// floor with its own accessory (flower boxes + Juliet balconies on the piano
// nobile, striped awnings on the middle floor, AC units / boxes on top),
// string courses, a bracketed cornice, and a busy railed roof (stair house,
// condensers, roof garden, water tank or solar) instead of a flat cap.
const TOWN = [
  // (w4) warm, clean two-tone schemes: no white (the r9/w1 white pilasters,
  // belts and balustrade read grey-white in every gallery shot). frame = the
  // accent ring round the paired windows, pil = their heads + sills.
  scheme({ wall: C.resTerraTrim, quoin: C.cream, trim: C.cream, base: C.resQuoin, joint: C.resTerracotta, door: C.resTileGreenDk, glass: C.win, sill: C.cream, flowers: FLOWERS[0], shutter: C.resTileGreenDk, awn: [C.roofGreen, C.signWhite], rail: C.cream, frame: C.resTileDk, pil: C.cream, slab: C.cream, win2: C.winCool }),
  scheme({ wall: C.resSage, quoin: C.cream, trim: C.cream, base: C.resTerraTrim, joint: C.resTileDk, door: C.brick, glass: C.win, sill: C.cream, flowers: FLOWERS[1], shutter: C.resTerraTrim, awn: [C.red, C.signWhite], rail: C.resTileGreenDk, frame: C.resTileGreenDk, pil: C.cream, slab: C.cream, win2: C.winCool }),
  scheme({ wall: C.pYellow, quoin: C.cream, trim: C.resTerraTrim, base: C.resTerraTrim, joint: C.resTileDk, door: C.roofGreen, glass: C.winCool, sill: C.cream, flowers: FLOWERS[2], shutter: C.roofGreen, awn: [C.teal, C.signWhite], rail: C.resTerraTrim, frame: C.resTerraTrim, pil: C.cream, slab: C.cream, win2: C.winCool }),
];
function bTownhouse(rng, variant) {
  const v = vOf(variant, 3), S = TOWN[v];
  const g = grid(63, 130, 63, R);
  lot(g, 62, 62, 'pave', v);
  const x0 = 8, x1 = 54, z0 = 18, z1 = 48, fh = 22;
  const f1 = G + 10, top = f1 + 3 * fh;                        // raised ground floor
  body(g, x0, z0, x1, z1, G, top, S, { baseH: 10 });
  rustic(g, x0, z0, x1, z1, G + 1, f1 - 2, S.joint, 3);        // (r9) rusticated base
  line(g, x0, z0, x1, z1, f1 - 1, S.trim);
  // (w4) fewer, bigger relief trims: chunky 2-proud quoins up the corners
  // (not r9's slim white pilasters), 2-tall string courses, and the
  // apartment's bold crown instead of the bracket cornice + balustrade
  bigQuoins(g, x0, z0, x1, z1, f1 + 1, top - 4, S.quoin, 4, [5, 3], 2);
  for (let f = 1; f < 3; f++) belt(g, x0, z0, x1, z1, f1 + f * fh - 2, S.trim, 2);
  belt(g, x0, z0, x1, z1, f1, S.trim, 2);
  boldCrown(g, x0, z0, x1, z1, top, S.quoin, [C.resTileDk, C.resTileGreenDk, C.resTileDk][v]);

  const F = facade(g, 'front', z0);
  // stoop: steps climbing to the raised door, railings
  const du = 13;
  for (let s = 0; s < 9; s++) F.box(du - 1, G, 1 + s, du + 6, f1 - 1 - s, 1 + s, C.stone);
  for (const u of [du - 2, du + 7]) for (let s = 0; s < 9; s++) F.box(u, f1 - s + 1, 1 + s, u, f1 - s + 5, 1 + s, S.trim);
  door(F, du, f1, 6, 16, { color: S.door, frame: S.trim, glass: C.win, step: null, knob: C.gold });
  F.box(du - 2, f1 + 18, 1, du + 7, f1 + 18, 3, S.trim);        // door pediment
  F.box(du - 1, f1 + 19, 1, du + 6, f1 + 19, 2, S.trim);
  lamp(F, du + 8, f1 + 10, S);
  win(F, 38, G + 2, 8, 5, S, { mullion: 'v', sill: false });   // garden-level window
  // (w4) the apartment's window language on every face: PAIRS of 3-wide
  // panes in one accent frame ring with a light head + sill, wall piers
  // between the pairs (critic consensus: finer window rhythm, fewer small
  // trims — r9's hoods, keystones, brackets, awnings and AC units per window
  // read as confetti). One railed balcony per floor moves between pairs.
  const W = { frame: S.frame, glass: S.glass, pil: S.pil, slab: S.slab, rail: S.rail };
  const hs = (f, i, k) => whash(f * 7 + i * 13 + k * 5 + v * 3 + 1);
  // bay window over the raised floor + floor 2
  const bu0 = 32, bu1 = 49, byT = f1 + 2 * fh - 3;
  if (v !== 1) {
    F.box(bu0, f1, 1, bu1, byT, 5, S.wall);
    F.box(bu0 - 1, f1 - 1, 1, bu1 + 1, f1, 6, S.trim);
    F.box(bu0 - 1, byT + 1, 1, bu1 + 1, byT + 1, 6, S.trim);
    F.box(bu0 - 1, byT + 2, 1, bu1 + 1, byT + 2, 6, S.quoin);
    const BF = facade(g, 'front', z0 - 5);
    for (let f = 0; f < 2; f++) for (const [i, u] of [[0, 33], [1, 42]]) pairWin(BF, u, f1 + 5 + f * fh, 12, W, hs(f, i, 9), { box: f === 0, head: false });
  } else {
    for (let f = 0; f < 2; f++) for (const [i, u] of [[0, 33], [1, 42]]) pairWin(F, u, f1 + 5 + f * fh, 12, W, hs(f, i, 9), { box: f === 0 });
    awning(F, 34, 48, G + 9, 4, { colors: S.awn, stripe: 2 });
  }
  // the rest of the front
  for (let f = 0; f < 3; f++) {
    const y = f1 + 5 + f * fh;
    if (f === 2) for (const [i, u] of [[0, 33], [1, 42]]) pairWin(F, u, y, 12, W, hs(f, i, 0));
    if (f > 0) pairWin(F, 14, y, 12, W, hs(f, 2, 0), { bal: f === 1 });
    pairWin(F, 24, y, 12, W, hs(f, 3, 0));
  }
  // sides + back: one pair centred on each side (the wall must lead), three across the back
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1), B = facade(g, 'back', z1);
  for (let f = 0; f < 3; f++) {
    const y = f1 + 5 + f * fh;
    for (const [Fc, k] of [[L, 1], [Rt, 2]]) pairWin(Fc, 30, y, 12, W, hs(f, 0, k), { bal: f === (k === 1 ? 1 : 2) });
    [14, 27, 40].forEach((u, i) => { if (f !== 0 || i !== 1) pairWin(B, u, y, 12, W, hs(f, i, 3), { bal: i === (f + 1) % 3 }); });
  }
  // garden-level windows in the rusticated base (sides + back)
  for (const Fc of [L, Rt]) for (const u of [23, 40]) win(Fc, u, G + 3, 5, 4, S, { mullion: 'v', sill: false });
  door(B, 24, G + 1, 5, 15, { color: C.woodDark, frame: S.trim, step: C.stone, stepDepth: 3 });
  awning(B, 22, 30, G + 20, 3, { colors: S.awn, stripe: 1 });
  lamp(B, 31, G + 11, S);
  // one party-wall chimney stack + (r9) a busy railed roof
  chimney(g, x0 + 1, 27, 6, 8, top + 2, top + 12, C.brickDark, C.concrete);
  const ry = top + 2;
  roofTop(g, x0, z0, x1, z1, ry, S, v === 0 ? 2 : v === 1 ? 5 : 1, { houseC: S.wall, rail: false });
  // lot: railing, tree pit, bins, bike; side strips; fenced back garden
  fence(g, 'x', 2, 60, 3, S.trim, { gap: [11, 20], h: 6, step: 4 });
  g.box(52, G - 1, 5, 59, G - 1, 12, C.dirtDark);
  tree(g, 56, 9, 'column', 31);
  bins(g, 24, 6);
  for (const px of [30, 35]) pot(g, px, 8, S.flowers[px % 3]);
  bike(g, 40, 7, C.vehBlue);
  shrubs(g, 'z', z0 + 2, z1 - 2, x0 - 2, -1, S.flowers, 3);
  shrubs(g, 'z', z0 + 2, 40, x1 + 2, 1, S.flowers, 3);
  hoseReel(g, 58, 44);
  patch(g, 2, 51, 60, 60, LAWN);
  hedge(g, 2, 58, 60, 60, 5);
  boardFence(g, 'z', 49, 57, 2, C.woodDark); boardFence(g, 'z', 49, 57, 60, C.woodDark);
  path(g, 20, 49, 28, 57);
  if (v === 0) { bench(g, 34, G, 54, 'x', 10, { seat: C.wood }); tree(g, 8, 54, 'round', 32); clothesline(g, 44, 58, 53); }
  else if (v === 1) { umbrella(g, 42, 54, C.roofGreen, C.signWhite, 5); topiary(g, 6, G, 52, 8); compost(g, 50, 51); crates(g, 12, 52, 2); }
  else { shed(g, 40, 51, 52, 57, C.wood, ROOF.slate, C.white); sandbox(g, 5, 51, 14, 57); pot(g, 32, 53, C.pink); }
  return g.done();
}

// Duplex — twin mirrored halves under one long roof, each with its own
// front-gable bay, door, colours of door + flowers, path and mailbox; a
// shared canopy, a hedge between the lawns, and two back patios.
const DUPLEX = [
  scheme({ wall: C.resButter, quoin: C.cream, trim: C.resTerraTrim, roof: ROOF.tile, doors: [C.brick, C.resSlate], flowers: FLOWERS[0], base: C.resTerraTrim, lower: C.resTerracotta, joint: C.resTerraTrim, shutter: C.roofGreen, awn: [C.roofGreen, C.signWhite] }),
  scheme({ wall: C.resSage, quoin: C.cream, trim: C.resTileGreenDk, roof: ROOF.red, doors: [C.resTerraTrim, C.cream], flowers: FLOWERS[1], base: C.stoneDark, lower: C.resQuoin, joint: C.stone, shutter: C.resTerraTrim, awn: [C.red, C.signWhite] }),
  scheme({ wall: C.cream, quoin: C.resQuoin, trim: C.resSlateDk, roof: ROOF.sage, doors: [C.roofGreen, C.resSlate], flowers: FLOWERS[3], base: C.stone, lower: C.resTerraTrim, joint: C.resTileDk, shutter: C.resTileGreenDk, awn: [C.teal, C.signWhite] }),
];
function bDuplex(rng, variant) {
  const v = vOf(variant, 3), S = DUPLEX[v];
  const g = grid(63, 120, 63, R);
  lot(g, 62, 62, 'grass', v);
  const x0 = 4, x1 = 58, z0 = 26, z1 = 50, fh = 22, top = G + 2 * fh;
  body(g, x0, z0, x1, z1, G, top, S);
  // (r9) two-tone: a rusticated stone ground floor under the painted upper one
  const lower = (a0, b0, a1, b1) => { g.walls(a0, G + 3, b0, a1, G + fh - 1, b1, S.lower); rustic(g, a0, b0, a1, b1, G + 3, G + fh - 2, S.joint, 3); };
  lower(x0, z0, x1, z1);
  quoins(g, x0, z0, x1, z1, G + 3, top - 1, S.quoin, 6, [6, 3], 2);
  belt(g, x0, z0, x1, z1, G + fh, S.trim);
  belt(g, x0, z0, x1, z1, top, S.trim);
  const roof = gableRoof(g, 'x', x0, x1, z0, z1, top, { roof: S.roof, fill: S.wall, edge: true, fascia: S.trim, ov: 3, ova: 1 });
  // two front-gable bays
  const BF = facade(g, 'front', 16);
  for (const [bx0, bx1] of [[4, 19], [43, 58]]) {
    body(g, bx0, 16, bx1, z0, G, top, S);
    lower(bx0, 16, bx1, z0 + 2);
    // (w4) no quoins on the bays: three quoined blocks side by side read
    // as a mottled stone pile — the main block's corners carry them
    belt(g, bx0, 16, bx1, z0, G + fh, S.trim);
    gableRoof(g, 'z', 16, z0 + 8, bx0, bx1, top, { roof: S.roof, fill: S.wall, edge: true, fascia: S.trim, ov: 2, ova: 2 });
    rwin(BF, bx0 + 4, G + 6, 8, 12, S, 'awn');
    rwin(BF, bx0 + 5, G + fh + 5, 6, 12, S, 'shut');
    win(BF, bx0 + 6, top + 4, 4, 5, S, { mullion: null, sill: false });
    const bs = facade(g, bx0 < 30 ? 'left' : 'right', bx0 < 30 ? bx0 : bx1);
    rwin(bs, 19, G + fh + 5, 4, 11, S, 'box');
  }
  const F = facade(g, 'front', z0);
  g.box(31, G, z0, 31, top, z0, S.trim);                           // party line
  for (const [i, du] of [[0, 24], [1, 34]]) {
    door(F, du, G + 2, 5, 15, { color: S.doors[i], frame: S.quoin, glass: C.win, step: C.concrete, stepDepth: 4, mat: C.red });
  }
  if (v === 1) { hood(F, 21, 30, G + 20, 5, S.roof[0], S.trim); hood(F, 32, 41, G + 20, 5, S.roof[0], S.trim); }
  else { F.box(21, G + 20, 1, 41, G + 20, 6, S.trim); F.box(21, G + 21, 1, 41, G + 21, 6, S.roof[1]); for (const u of [21, 41]) F.box(u, G, 6, u, G + 19, 6, S.trim); }
  lamp(F, 29, G + 12, S); lamp(F, 32, G + 12, S);
  rwin(F, 23, G + fh + 5, 5, 12, S, 'jul'); rwin(F, 35, G + fh + 5, 5, 12, S, 'jul');
  // sides + back (r9): rich windows — shutters below, boxes / balconies
  // above; five on the back's upper floor around the balcony
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1), B = facade(g, 'back', z1);
  for (const f of [L, Rt]) {
    richRow(f, z0, z1, G + 6, 5, 12, S, ['shut'], { n: 2, gap: 7, m: 3 });
    richRow(f, z0, z1, G + fh + 5, 5, 12, S, ['box', 'ac'], { n: 2, gap: 7, m: 3, k0: f === L ? 1 : 0 });
  }
  richRow(B, x0, x1, G + fh + 5, 5, 12, S, ['shut', 'box', 'shut', 'box'], { n: 5, gap: 6, m: 3, skip: [[25, 37]] });
  for (const [u, k] of [[9, 'box'], [14, 'awn'], [45, 'awn'], [50, 'box']]) rwin(B, u, G + 6, 4, 12, S, k);
  for (const [i, du] of [[0, 22], [1, 36]]) {
    door(B, du, G + 2, 5, 15, { color: S.doors[i], frame: S.quoin, glass: C.win, step: C.concrete, stepDepth: 3, mat: null });
    lamp(B, du + (i ? 8 : -4), G + 12, S);
  }
  railBalcony(B, 26, 36, G + fh + 2, 4, S.quoin, S.trim);
  win(B, 29, G + fh + 3, 5, 14, S, { mullion: 'v', sill: false });
  pergola(g, 18, z1 + 2, 44, z1 + 8, S.quoin, 17);
  wallAC(L, 28, G + 3, { w: 5, h: 4, d: 3 }); wallAC(Rt, 44, G + 3, { w: 5, h: 4, d: 3 });
  for (const cx of [12, 47]) chimney(g, cx, z1 - 6, 4, 4, roof.yAt(z1 - 6) - 2, roof.top + 5, C.brick);
  gutters(g, roof, z0, z1, [31]);
  boxDormer(g, roof, 22, 9, 11, S, 'back'); boxDormer(g, roof, 40, 9, 11, S, 'back');
  dormer(g, roof, 31, 11, 12, S, 'front');                           // (r9) shared front dormer
  roofVent(g, roof, 25, 33); roofVent(g, roof, 37, 33);
  skylight(g, roof, 13, 18, 38, 42); skylight(g, roof, 44, 49, 38, 42);
  if (v === 2) dish(g, 30, roof.yAt(z1 - 2) + 1, z1 - 2);
  if (v !== 2) roofPanels(g, roof, 26, 36, 43, z1 + 3);
  else antenna(g, 48, roof.top, 38, 12);
  shrubs(g, 'z', z0 + 1, z1 - 1, x0 - 1, -1, S.flowers, 2);
  shrubs(g, 'z', z0 + 1, z1 - 1, x1 + 1, 1, S.flowers, 2);
  // lot: two paths, dividing hedge, mailboxes, beds; fenced back yards
  path(g, 24, 2, 28, 21); path(g, 34, 2, 38, 21);
  hedge(g, 30, 2, 32, 14, 6);
  mailbox(g, 21, 5, S.doors[0]); mailbox(g, 41, 5, S.doors[1]);
  flowerBed(g, 4, 5, 18, 12, S.flowers); flowerBed(g, 44, 5, 58, 12, [S.flowers[1], S.flowers[0]]);
  lotFence(g, C.white, { from: 14, pickets: true });
  boardFence(g, 'z', 52, 60, 31, C.white);
  patch(g, 18, 52, 44, 59, C.lotPave);
  patioSet(g, 24, 56, S.doors[0], null); patioSet(g, 38, 56, S.doors[1], null);
  bins(g, 4 + 1, 52); bike(g, 49, 58, C.vehBlue);
  if (v === 1) { trampoline(g, 9, 56 - 1, 5); clothesline(g, 46, 58, 54); }
  else if (v === 2) { bbq(g, 5, 57); lounger(g, 50, 49 + 0, C.signWhite); crates(g, 12, 56, 2); }
  else { sandbox(g, 4, 53, 13, 59); pot(g, 52, 53, C.pink); pot(g, 56, 53, C.vegPetalR); }
  return g.done();
}

// Log Cabin — log courses (two log rows over a dark chink line), crossed log
// ends at the corners, a deep porch with posts, a rail and a lean-to roof, an
// exterior stone chimney; a woodpile, a stump with an axe, pines, and a
// per-variant treat (picnic table / fire pit / canoe).
const CABIN = [
  // (w1) no plank-orange logs: they turned the cabin + porch + fence into one
  // orange blob; timber tones are the ref05 farmhouse browns
  { roof: ROOF.green, logs: [C.wood, C.woodDark], door: C.resTerraTrim },
  { roof: ROOF.slate, logs: [C.woodDark, C.trunkDark], door: C.brick },
  { roof: ROOF.tile, logs: [C.woodDark, C.trunkDark], door: C.roofGreen },
];
function bCabin(rng, variant) {
  const v = vOf(variant, 3), K = CABIN[v];
  const S = scheme({ wall: K.logs[0], trim: C.woodDark, quoin: C.plank, frame: C.woodDark, glass: C.win, roof: K.roof, flowers: FLOWERS[v], shutter: K.door });
  const g = grid(63, 100, 63, R);
  lot(g, 62, 62, 'grass', v);
  const x0 = 12, x1 = 48, z0 = 28, z1 = 50, top = G + 32;
  g.box(x0 - 1, G, z0 - 1, x1 + 1, G + 2, z1 + 1, C.stone);           // stone footing
  for (let y = G + 3, i = 0; y + 2 <= top; y += 3, i++) {
    g.box(x0, y, z0, x1, y + 2, z1, K.logs[0]);
    line(g, x0, z0, x1, z1, y, K.logs[1]);                           // chink line
    const e = i % 2 ? 3 : 2;                                          // crossed log ends
    for (const [cx, cz, dx, dz] of [[x0, z0, -1, -1], [x1, z0, 1, -1], [x0, z1, -1, 1], [x1, z1, 1, 1]]) {
      if (i % 2) g.box(cx + dx, y + 1, cz - dz * 1, cx + dx * e, y + 2, cz, C.plank);
      else g.box(cx, y + 1, cz + dz, cx - dz * 0 + 0, y + 2, cz + dz * e, C.plank);
    }
  }
  const roof = gableRoof(g, 'x', x0, x1, z0, z1, top, { roof: K.roof, fill: K.logs[1], edge: true, fascia: C.woodDark, ov: 4, ova: 3 });
  // porch: deck, posts, rail, lean-to roof
  // (w4) a flagstone porch on a stone footing: the r-w1 plank deck made logs,
  // porch, fences and bed frames one orange mass
  g.box(x0 - 4, G, 13, x1 + 4, G + 3, z0 - 1, C.stone);
  g.box(x0 - 3, G + 3, 14, x1 + 3, G + 3, z0 - 1, C.lotPave);
  for (let x = x0 - 1; x <= x1 + 3; x += 6) g.box(x, G + 3, 14, x, G + 3, z0 - 1, C.lotPaveDark);
  for (const px of [x0 - 3, 30, x1 + 3]) g.box(px, G + 4, 14, px + 1, G + 27, 15, C.woodDark);
  for (const [a, b] of [[x0 - 1, 23], [37, x1 + 1]]) { g.box(a, G + 11, 14, b, G + 11, 14, C.woodDark); for (let x = a; x <= b; x += 3) g.box(x, G + 4, 14, x, G + 10, 14, C.wood); }
  for (let k = 0; k < 8; k++) g.box(x0 - 5, G + 28 + k, 12 + k * 2, x1 + 5, G + 28 + k, 13 + k * 2, k % 2 ? K.roof[0] : K.roof[1]);
  g.box(x0 - 5, G + 27, 12, x1 + 5, G + 27, 13, C.woodDark);

  const F = facade(g, 'front', z0);
  door(F, 28, G + 4, 6, 16, { color: K.door, frame: C.woodDark, glass: C.win, step: null, mat: C.red });
  for (const u of [14, 19, 37, 42]) win(F, u, G + 10, 4, 8, S, { mullion: 'cross', box: true, head: true });
  lamp(F, 25, G + 15, S);
  g.box(18, G + 4, 17, 21, G + 5, 19, C.wood); g.box(18, G + 6, 19, 21, G + 9, 19, C.wood);          // rocking chair
  g.box(41, G + 4, 18, 44, G + 7, 20, C.woodDark);                                                // side table
  pot(g, 36, 18, C.vegPetalR, G + 4);
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1), B = facade(g, 'back', z1);
  richRow(L, z0, z1, G + 10, 4, 9, S, ['shut'], { n: 2, gap: 7, win: { mullion: 'cross' } });
  for (const u of [30, 44]) rwin(Rt, u, G + 10, 4, 9, S, 'box', { mullion: 'cross' });
  for (const f of [L, Rt]) { win(f, 35, top + 5, 3, 5, S, { mullion: null, sill: false }); win(f, 41, top + 5, 3, 5, S, { mullion: null, sill: false }); }
  richRow(B, x0, x1, G + 10, 4, 9, S, ['box', null], { n: 4, gap: 5, skip: [[27, 33]], win: { mullion: 'cross' } });
  door(B, 28, G + 3, 5, 15, { color: K.door, frame: C.woodDark, step: C.stone, stepDepth: 3 });
  lamp(B, 34, G + 14, S);
  gutters(g, roof, z0, z1, [x0 + 1], C.woodDark);
  boxDormer(g, roof, 30, 11, 10, S, 'back');
  roofVent(g, roof, 20, 44, 7);
  // (r9) no plain roof slopes: front dormers + panels / a skylight at the back
  if (v === 1) dormer(g, roof, 30, 11, 11, S, 'front');
  else { boxDormer(g, roof, 20, 9, 10, S, 'front'); boxDormer(g, roof, 40, 9, 10, S, 'front'); }
  if (v === 2) roofPanels(g, roof, 36, 46, 44, 53); else skylight(g, roof, 38, 44, 44, 48);
  // exterior stone chimney on the right gable
  // (r7) warm sandstone, not the r6 grey stack
  g.box(x1 + 1, G, 35, x1 + 6, G + 9, 43, C.resTerraTrim);
  g.box(x1 + 1, G + 10, 36, x1 + 5, roof.top + 3, 42, C.resQuoin);
  for (let y = G + 16; y < roof.top; y += 9) g.box(x1 + 5, y, 36, x1 + 5, y, 42, C.resTerraTrim);
  g.box(x1, roof.top + 3, 35, x1 + 6, roof.top + 4, 43, C.resTerraTrim);
  g.box(x1 + 2, roof.top + 5, 38, x1 + 3, roof.top + 6, 39, C.resTileOrangeDk);
  // woodpile under a little roof, stump + axe, pines, path
  g.box(3, G, 30, 8, G + 9, 46, C.woodDark);
  for (let z = 31; z <= 45; z += 3) for (let y = G + 1; y <= G + 9; y += 3) g.box(8, y, z, 8, y + 1, z + 1, C.plank);
  for (let k = 0; k < 3; k++) g.box(2, G + 10 + k, 29 + k, 9, G + 10 + k, 47 - k, K.roof[k % 2]);
  g.box(52, G, 5, 56, G + 4, 9, C.wood); g.box(52, G + 4, 5, 56, G + 4, 9, C.plank);
  g.box(54, G + 5, 7, 54, G + 10, 7, C.woodDark); g.box(54, G + 9, 5, 54, G + 11, 6, C.metal);
  path(g, 28, 2, 33, 12, C.dirt, C.dirtDark);
  tree(g, 8, 8, 'pine', 41); tree(g, 7, 56, 'pine', 43); bush(g, 54, 54, 5, 6);
  lotFence(g, C.woodDark, { from: 3, step: 8 });
  fence(g, 'x', 2, 60, 3, C.woodDark, { gap: [25, 36], step: 8 });
  mailbox(g, 24, 6, C.roofGreen);
  crates(g, 40, 5, 2); wheelbarrow(g, 44, 10);
  g.box(52, G, 20, 57, G + 3, 24, C.wood); g.box(52, G + 3, 20, 57, G + 3, 24, C.plank);   // chopping block
  shrubs(g, 'x', x0 + 1, x1 - 1, z1 + 1, 1, [C.vegPetalW, C.vegPetalB], 2);
  if (v === 0) {                                               // picnic table
    g.box(22, G, 54, 40, G + 5, 58, C.wood); g.box(24, G, 54, 38, G + 4, 58, C.dirt);
    g.box(22, G + 5, 55, 40, G + 5, 57, C.plank);
    g.box(22, G + 2, 52, 40, G + 2, 53, C.wood); g.box(22, G + 2, 59, 40, G + 2, 60, C.wood);
    g.box(24, G, 54, 38, G + 4, 58, C.wood); g.box(25, G, 54, 37, G + 4, 58, LAWN);
  } else if (v === 1) {                                        // fire pit + log seats
    g.walls(26, G, 52, 34, G + 2, 60, C.stone); g.box(27, G, 53, 33, G + 1, 59, C.darkGray);
    g.box(29, G + 2, 55, 31, G + 3, 57, C.orange); g.set(30, G + 4, 56, C.yellow); g.set(29, G + 3, 55, C.red);
    g.box(18, G, 53, 21, G + 3, 59, C.wood); g.box(39, G, 53, 42, G + 3, 59, C.wood);
  } else {                                                     // canoe
    g.box(18, G, 55, 44, G + 3, 59, C.red); g.box(20, G + 1, 56, 42, G + 3, 58, C.darkGray);
    g.box(16, G + 1, 56, 17, G + 2, 58, C.red); g.box(45, G + 1, 56, 46, G + 2, 58, C.red);
    g.box(24, G + 4, 56, 38, G + 4, 57, C.plank); g.box(30, G + 4, 55, 31, G + 4, 60, C.woodDark);
  }
  return g.done();
}

// Farmhouse — clapboard two-storey (siding lines painted flush), corner
// boards, a wraparound porch with posts, rail and a lean-to roof, a steep
// roof with a weathervane; veggie rows, a rail fence, hay bales, and a silo /
// chicken coop / red barn per variant.
const FARM = [
  scheme({ wall: C.white, roof: ROOF.red, trim: C.resSlateDk, quoin: C.signWhite, corner: C.signWhite, door: C.brick, siding: C.offwhite, silo: C.metal, shutter: C.resSlateDk, flowers: FLOWERS[0] }),
  scheme({ wall: C.resButter, roof: ROOF.green, trim: C.resTileGreenDk, quoin: C.white, corner: C.white, door: C.roofGreen, siding: C.cream, silo: C.resTerraTrim, shutter: C.resTileGreenDk, flowers: FLOWERS[1] }),
  scheme({ wall: C.peach, roof: ROOF.slate, trim: C.resSlateDk, quoin: C.white, corner: C.white, door: C.resTerraTrim, siding: C.white, silo: C.metal, shutter: C.white, flowers: FLOWERS[3] }),
];
function bFarmhouse(rng, variant) {
  const v = vOf(variant, 3), S = FARM[v];
  const g = grid(63, 130, 63, R);
  lot(g, 62, 62, 'grass', v);
  const x0 = 4, x1 = 36, z0 = 30, z1 = 54, fh = 22, top = G + 2 * fh + 1;
  g.box(x0, G, z0, x1, top, z1, S.wall);
  line(g, x0, z0, x1, z1, G, C.stone, 3);
  for (let y = G + 6; y < top - 1; y += 4) line(g, x0, z0, x1, z1, y, S.siding);   // clapboard lines
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1), B = facade(g, 'back', z1), F = facade(g, 'front', z0);
  for (const [Fc, a, b] of [[F, x0, x1], [B, x0, x1], [L, z0, z1], [Rt, z0, z1]]) { Fc.box(a, G + 3, 0, a + 1, top, 0, S.corner); Fc.box(b - 1, G + 3, 0, b, top, 0, S.corner); }
  belt(g, x0, z0, x1, z1, top, S.trim);
  belt(g, x0, z0, x1, z1, G + fh + 1, S.corner);                   // (r8) floor string course
  const roof = gableRoof(g, 'x', x0, x1, z0, z1, top, { roof: S.roof, fill: S.wall, edge: true, fascia: S.trim, ov: 3, ova: 2 });
  // weathervane
  g.box(20, roof.top + 1, 42, 20, roof.top + 9, 42, C.darkGray);
  g.box(16, roof.top + 9, 42, 24, roof.top + 9, 42, C.darkGray); g.box(23, roof.top + 10, 42, 24, roof.top + 11, 42, C.gold);
  g.box(20, roof.top + 6, 40, 20, roof.top + 6, 44, C.darkGray);
  // wraparound porch (front + left side): posts, rail, lean-to roof
  g.box(x0 - 2, G, 16, x1 + 2, G + 2, z0 - 1, C.plank);
  for (let x = x0; x <= x1; x += 8) g.box(x, G + 3, 17, x, G + fh - 5, 17, S.trim);
  g.box(x1, G + 3, 17, x1, G + fh - 5, 17, S.trim);
  for (const [a, b] of [[x0, 15], [26, x1]]) { g.box(a, G + 9, 17, b, G + 9, 17, S.quoin); for (let x = a; x <= b; x += 2) g.box(x, G + 3, 17, x, G + 8, 17, S.quoin); }
  for (let k = 0; k < 8; k++) g.box(x0 - 2, G + fh - 3 + k, 15 + k * 2, x1 + 2, G + fh - 3 + k, 16 + k * 2, k ? S.roof[0] : S.roof[1]);
  g.box(x0 - 2, G + fh - 4, 15, x1 + 2, G + fh - 4, 16, S.trim);
  door(F, 17, G + 3, 6, 16, { color: S.door, frame: S.trim, glass: C.win, step: null, mat: C.red });
  lamp(F, 13, G + 14, S);
  for (const u of [8, 28]) rwin(F, u, G + 7, 5, 11, S, 'shut');
  for (const u of [8, 18, 28]) rwin(F, u, G + fh + 6, 5, 11, S, u === 18 ? 'box' : 'shut');
  g.box(6, G + 3, 20, 12, G + 5, 22, C.wood); g.box(6, G + 6, 22, 12, G + 9, 22, C.wood);    // porch bench
  for (const f of [L, Rt]) { richRow(f, z0, z1, G + 7, 4, 11, S, ['box', 'ac', 'box'], { n: 3, gap: 3, m: 4, k0: f === L ? 1 : 0 }); richRow(f, z0, z1, G + fh + 6, 4, 11, S, [null, 'box', null], { n: 3, gap: 3, m: 4 }); }
  win(L, 38, top + 8, 3, 6, S, { mullion: null, sill: false }); win(L, 44, top + 8, 3, 6, S, { mullion: null, sill: false });
  win(Rt, 38, top + 8, 3, 6, S, { mullion: null, sill: false }); win(Rt, 44, top + 8, 3, 6, S, { mullion: null, sill: false });
  richRow(B, x0, x1, G + 7, 4, 11, S, ['awn', 'box'], { n: 4, gap: 4, skip: [[16, 24]] });
  richRow(B, x0, x1, G + fh + 6, 4, 11, S, ['box', 'jul', 'box', 'box'], { n: 4, gap: 4 });
  door(B, 18, G + 1, 5, 15, { color: S.trim, frame: S.quoin, step: C.concrete, stepDepth: 3 });
  B.box(16, G + 18, 1, 24, G + 18, 5, S.trim); B.box(16, G + 19, 1, 24, G + 19, 5, S.roof[1]);
  gutters(g, roof, z0, z1, [x1 - 1]);
  dormer(g, roof, 20, 11, 12, S, 'front');
  roofVent(g, roof, 10, 49);
  wallAC(Rt, 33, G + 3, { w: 5, h: 4, d: 3 });
  chimney(g, 26, z1 - 7, 4, 4, roof.yAt(z1 - 7) - 2, roof.top + 5, C.brick);

  if (v === 0) {                                               // silo
    const cx = 51, cz = 47, r = 7.2;
    for (let y = G; y < G + 64; y++) for (let x = cx - 8; x <= cx + 8; x++) for (let z = cz - 8; z <= cz + 8; z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d <= r && d > r - 2.5) g.set(x, y, z, (y - G) % 12 === 11 ? C.metalDark : S.silo);
    }
    for (let y = 0; y < 6; y++) for (let x = cx - 8; x <= cx + 8; x++) for (let z = cz - 8; z <= cz + 8; z++)
      if (Math.hypot(x - cx, z - cz) <= r - y * 1.3) g.set(x, G + 64 + y, z, C.metalDark);
    for (let y = G; y < G + 60; y += 3) g.set(cx - 8, y, cz, C.darkGray);         // ladder
    for (const [x, z] of [[40, 38], [44, 38]]) g.box(x, G, z, x + 3, G + 3, z + 5, C.sand);
  } else if (v === 1) {                                        // chicken coop + run
    g.box(42, G + 3, 38, 56, G + 12, 48, C.brick);
    for (const [x, z] of [[42, 38], [56, 38], [42, 48], [56, 48]]) g.box(x, G, z, x, G + 2, z, C.woodDark);
    gableRoof(g, 'x', 42, 56, 38, 48, G + 12, { roof: ROOF.brown, fill: C.brick, edge: true, ov: 2, ova: 1, caps: false });
    door(facade(g, 'front', 38), 47, G + 3, 3, 5, { color: C.darkGray, frame: C.white, step: null });
    for (let k = 0; k < 4; k++) g.box(47 - 1 + 0, G + k, 37 - k * 2, 49, G + k, 36 - k * 2, C.wood);
    fence(g, 'x', 40, 60, 28, C.white, { step: 4 }); fence(g, 'z', 28, 36, 40, C.white, { step: 4 }); fence(g, 'z', 28, 36, 60, C.white, { step: 4 });
    for (const [x, z] of [[44, 31], [50, 33], [55, 30]]) { g.box(x, G, z, x + 2, G + 2, z + 1, C.signWhite); g.set(x + 2, G + 3, z, C.red); g.set(x + 3, G + 2, z, C.orange); }
  } else {                                                     // little red barn
    g.box(41, G, 32, 60, G + 18, 58, C.brick);
    line(g, 41, 32, 60, 58, G + 9, C.white);
    const BF = facade(g, 'front', 32);
    BF.box(45, G, 1, 56, G + 14, 1, C.white); BF.clear(46, G, 1, 55, G + 13, 1);
    BF.box(46, G, 0, 55, G + 13, 0, C.brickDark);
    for (let k = 0; k < 10; k++) { BF.set(46 + k, G + k + 2, 0, C.white); BF.set(55 - k, G + k + 2, 0, C.white); }
    BF.box(49, G + 16, 0, 52, G + 19, 0, C.white); BF.box(50, G + 17, 0, 51, G + 18, 0, C.darkGray);
    gableRoof(g, 'z', 32, 58, 41, 60, G + 18, { roof: S.roof, fill: C.brick, edge: true, ov: 2, ova: 1, rise: 2, run: 2 });
  }
  // veggie rows, rail fence, hay bales, path
  vegRows(g, 40, 4, 60, 24);
  fence(g, 'x', 2, 60, 2 + 0, C.woodDark, { gap: [16, 24], step: 5 });
  for (const [x, z] of [[4, 5], [9, 5]]) { g.box(x, G, z, x + 3, G + 3, z + 6, C.sand); g.box(x, G + 1, z, x + 3, G + 1, z + 6, C.sandDark); }
  path(g, 17, 3, 22, 15, C.dirt, C.dirtDark);
  lotFence(g, C.woodDark, { sides: 'lb', from: 3, step: 5 });
  mailbox(g, 26, 6, S.door);
  crates(g, 29, 9, 3);
  for (const [x, z] of [[33, 6], [36, 8], [31, 12]]) { g.box(x, G, z, x + 2, G + 2, z + 2, C.orange); g.set(x + 1, G + 3, z + 1, C.vegStem); }   // pumpkins
  wheelbarrow(g, 5, 12);
  shrubs(g, 'x', x0 + 1, x1 - 1, z1 + 1, 1, S.flowers, 2);
  return g.done();
}

// Beach House — on white stilts over a sand lot: a wraparound deck with a
// glass rail and lifebuoy, stairs down, siding lines, big sliding doors, a
// roof per variant; umbrella, loungers, towel, surfboards, a ball, a palm.
const BEACH = [
  scheme({ wall: C.pBlue, roof: ROOF.slate, trim: C.white, stripe: C.white, glass: C.winCool, umb: C.vehRed }),
  scheme({ wall: C.resSage, roof: ROOF.tile, trim: C.white, stripe: C.cream, glass: C.winCool, umb: C.vehBlue }),
  scheme({ wall: C.resButter, roof: ROOF.green, trim: C.white, stripe: C.white, glass: C.winCool, umb: C.pink }),
];
function palm(g, px, pz, h = 30) {
  for (let y = G; y < G + h; y++) {
    const o = y > G + h * 0.5 ? 1 : 0, o2 = y > G + h * 0.8 ? 1 : 0;
    g.box(px + o + o2, y, pz, px + 2 + o + o2, y, pz + 2, (y - G) % 5 === 4 ? C.woodDark : C.vegTrunk);
  }
  const tx = px + 3, tz = pz + 1, ty = G + h;
  g.box(tx - 2, ty, tz - 2, tx + 2, ty + 2, tz + 2, C.vegLeafBand);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
    for (let i = 1; i <= 7; i++) {
      const x = tx + dx * (i + 1), z = tz + dz * (i + 1), y = ty + 2 - (i >> 1);
      g.box(Math.min(x, x + (dz ? 1 : 0)), y, Math.min(z, z + (dx ? 1 : 0)), Math.max(x, x + (dz ? 1 : 0)), y, Math.max(z, z + (dx ? 1 : 0)), C.vegLeaf);
    }
  }
  g.box(tx - 1, ty - 1, tz + 1, tx, ty, tz + 2, C.woodDark);         // coconuts
}
function bBeachHouse(rng, variant) {
  const v = vOf(variant, 3), S = BEACH[v];
  const g = grid(63, 110, 63, R);
  lot(g, 62, 62, C.sand, v);
  const x0 = 16, x1 = 54, z0 = 28, z1 = 56, dy = G + 16;                // deck level
  for (const x of [11, 32, 55]) for (const z of [15, 36, 57]) g.box(x, G, z, x + 1, dy - 2, z + 1, C.white);
  g.box(10, dy - 2, 14, 57, dy - 2, 58, C.wood);
  g.box(10, dy - 1, 14, 57, dy, 58, C.plank);
  // glass rail on the front + left, lifebuoy
  g.box(10, dy + 1, 14, 57, dy + 6, 14, C.skyBlue); g.box(10, dy + 1, 14, 10, dy + 6, 58, C.skyBlue);
  g.box(10, dy + 7, 14, 57, dy + 7, 14, S.trim); g.box(10, dy + 7, 14, 10, dy + 7, 58, S.trim);
  g.box(57, dy + 1, 14, 57, dy + 7, 27, S.trim);
  for (let x = 10; x <= 57; x += 8) g.box(x, dy + 1, 14, x, dy + 6, 14, S.trim);
  g.walls(18, dy + 1, 13, 23, dy + 6, 13, C.red); g.box(18, dy + 1, 13, 18, dy + 2, 13, C.signWhite); g.box(23, dy + 5, 13, 23, dy + 6, 13, C.signWhite);
  g.del(20, dy + 3, 13); g.del(21, dy + 3, 13); g.del(20, dy + 4, 13); g.del(21, dy + 4, 13);
  // stairs down the left side toward the front
  for (let s = 0; s < 16; s++) g.box(3, G + s, 22 + s, 8, G + s, 25 + s, C.plank);
  g.box(3, dy - 1, 40, 9, dy, 45, C.plank);
  for (let s = 0; s < 16; s += 3) g.box(2, G + s + 1, 22 + s, 2, G + s + 7, 22 + s, S.trim);
  for (let s = 0; s < 16; s++) g.set(2, G + s + 7, 22 + s, S.trim);
  // house with siding lines + corner boards
  const top = dy + 28;
  g.box(x0, dy + 1, z0, x1, top, z1, S.wall);
  for (let y = dy + 4; y < top; y += 4) line(g, x0, z0, x1, z1, y, S.stripe);
  const F = facade(g, 'front', z0), L = facade(g, 'left', x0), Rt = facade(g, 'right', x1), B = facade(g, 'back', z1);
  for (const [Fc, a, b] of [[F, x0, x1], [B, x0, x1], [L, z0, z1], [Rt, z0, z1]]) { Fc.box(a, dy + 1, 0, a + 1, top, 0, S.trim); Fc.box(b - 1, dy + 1, 0, b, top, 0, S.trim); }
  if (v === 0) { const r = hipRoof(g, x0, x1, z0, z1, top, { roof: S.roof, ov: 4, fascia: S.trim, ridge: S.trim }); hipGutters(g, r, x0, x1, z0, z1, C.signWhite, dy + 1); boxDormer(g, r, 35, 11, 10, S, 'front'); }
  else if (v === 2) { const r = gableRoof(g, 'x', x0, x1, z0, z1, top, { roof: S.roof, fill: S.wall, edge: true, fascia: S.trim, ov: 4, ova: 2 }); gutters(g, r, z0, z1, [x1 - 1], C.signWhite, dy + 1); roofVent(g, r, 22, 50); skylight(g, r, 30, 40, 22 + 6, 33); for (const f of [facade(g, 'left', x0), facade(g, 'right', x1)]) win(f, 40, top + 6, 4, 7, S, { mullion: 'v', sill: false }); }
  else {                                                        // flat roof deck
    belt(g, x0, z0, x1, z1, top, S.trim);
    g.box(x0, top + 1, z0, x1, top + 1, z1, C.plank);
    g.box(x0, top + 2, z0, x1, top + 5, z0, C.skyBlue); g.box(x0, top + 2, z0, x0, top + 5, z1, C.skyBlue); g.box(x1, top + 2, z0, x1, top + 5, z1, C.skyBlue);
    g.box(x0, top + 6, z0, x1, top + 6, z0, S.trim); g.box(x0, top + 6, z0, x0, top + 6, z1, S.trim); g.box(x1, top + 6, z0, x1, top + 6, z1, S.trim);
    g.box(x0, top + 2, z1, x1, top + 6, z1, S.trim);
    umbrella(g, 34, 36, S.umb, C.signWhite, 5, top + 2);
    lounger(g, 42, 31, C.signWhite, top + 2); lounger(g, 47, 31, C.signWhite, top + 2);
    g.box(19, top + 2, 43, 29, top + 20, 53, S.wall); g.box(18, top + 21, 42, 30, top + 21, 54, S.trim);     // stair hut
    door(facade(g, 'front', 43), 22, top + 2, 5, 14, { color: S.trim, frame: S.trim, glass: S.glass, step: null });
  }
  win(F, 20, dy + 2, 18, 17, S, { mullion: 4, sill: false, frame: S.trim, proud: true });            // sliding doors
  for (const u of [42, 48]) win(F, u, dy + 8, 4, 10, S, { mullion: 'h', head: true });
  door(L, 44, dy + 1, 6, 17, { color: S.trim, frame: S.trim, glass: S.glass, step: null });
  for (const u of [31, 37]) win(L, u, dy + 8, 4, 10, S, { mullion: 'h', head: true });
  win(Rt, 32, dy + 7, 11, 11, S, { mullion: 5, head: true });
  for (const u of [46, 51 - 0]) win(Rt, u - 1, dy + 8, 3, 10, S, { head: true });
  winRow(B, x0, x1, dy + 8, 4, 10, S, { n: 4, gap: 5, skip: [[29, 37]] });
  wallAC(B, 31, dy + 5, { w: 5, h: 4, d: 3 });
  // deck furniture
  for (const x of [43, 50]) g.box(x, dy + 1, 18, x + 3, dy + 5, 21, C.signWhite);
  g.box(43, dy + 5, 17, 53, dy + 5, 22, C.wood);
  // beach: umbrella, loungers, towel, surfboards, ball, palm, sandcastle
  umbrella(g, 30, 6, S.umb);
  lounger(g, 16, 2 + 0, C.signWhite); lounger(g, 38, 2, C.signWhite);
  g.box(44, G - 1, 3, 52, G - 1, 10, S.umb); g.box(44, G - 1, 5, 52, G - 1, 5, C.signWhite);
  for (const [z, c] of [[40, S.umb], [45, C.teal]]) { g.box(60, G, z, 60, G + 20, z + 3, c); g.box(60, G + 6, z + 1, 60, G + 16, z + 2, C.signWhite); }
  g.box(12, G, 8, 14, G + 2, 10, C.red); g.set(13, G + 2, 9, C.signWhite); g.box(12, G, 8, 12, G + 1, 8, C.blue);
  g.box(54, G, 3, 59, G + 3, 8, C.sandDark); g.box(55, G + 4, 4, 58, G + 6, 7, C.sandDark); g.set(56, G + 7, 5, C.red);
  palm(g, 3, 6, 30);
  // beach clutter: cooler, bucket + spade, outdoor shower, kayak, dune grass
  g.box(40, G, 10, 43, G + 3, 12, C.vehBlue); g.box(40, G + 4, 10, 43, G + 4, 12, C.signWhite);
  g.box(8, G, 18, 9, G + 2, 19, C.yellow); g.set(10, G + 3, 18, C.vehRed);
  g.box(59, G, 50, 59, G + 22, 50, C.metal); g.box(56, G + 22, 50, 59, G + 22, 50, C.metal); g.box(56, G + 20, 50, 57, G + 21, 51, C.metalDark);
  g.box(57, G - 1, 46, 60, G - 1, 54, C.plank);
  g.box(20, G, 60, 44, G + 2, 61, C.orange); g.box(22, G + 1, 60, 42, G + 2, 60, C.darkGray);
  for (const [x, z] of [[4, 30], [6, 48], [14, 58], [48, 60], [26, 20], [60, 30]]) { g.box(x, G, z, x + 1, G + 3, z, C.vegTuft); g.box(x + 1, G, z + 1, x + 1, G + 2, z + 1, C.vegTuft); }
  return g.done();
}

// (r9) One floor of a residential tower face. a..b = the face's wall ends,
// y = the floor's sill line. r8 critic: 'the towers are repetitive stacked
// blue window bands with little silhouette variation' — so each floor picks
// one of three styles and the pattern shifts per face:
//   'punch'  framed windows with a proud sill + head, and per window (hash) a
//            flower box, a wall AC unit, a small striped awning or nothing
//   'loggia' a full-width balcony: slab, bar or glass rail, a potted plant
//   'corner' balconies on the two end bays only, the middle bays punched
function towerFloor(Fc, a, b, y, A, style, seed, m = 5) {
  // (w1) finer window rhythm + fewer small props (critic consensus: the
  // 5-wide windows with blinds / boxes / AC / awnings read as confetti on
  // 'stacked blue bands'): pairs of 3-wide windows sharing a mullion (9
  // wide) with 3-voxel wall piers between pairs, flush frame rings, sills and
  // heads that run together per pair, and only an occasional flower box or
  // AC unit.
  const us = [], span = b - a - 2 * m + 1;
  const np = Math.max(1, Math.floor((span + 3) / 12));
  for (let i = 0, u = a + m + ((span - (np * 12 - 3)) >> 1) + 1; i < np; i++, u += 12) us.push(u, u + 4);
  const n = us.length;
  us.forEach((u, i) => {
    const h = ((((seed | 0) * 131 + i * 977 + 7) >>> 0) * 2654435761) >>> 0;
    const balc = style === 'loggia' || (style === 'corner' && (i <= 1 || i >= n - 2));
    const wh = balc ? 15 : 12;
    towerWin(Fc, u, y + 1, 3, wh, (h >> 3) % 4 === 0 ? C.win : A.glass, A.frame);
    Fc.box(u, y + (balc ? 10 : 9), 0, u + 2, y + (balc ? 10 : 9), 0, A.frame);   // transom
    if (balc) return;
    Fc.box(u - 2, y, 1, u + 4, y, 2, A.trim);                            // sill (runs into a course)
    Fc.box(u - 2, y + wh + 2, 1, u + 4, y + wh + 2, 1, A.trim);          // head (runs into a course)
    const k = (h >> 10) % 9;
    if (k === 0) flowerBox(Fc, u - 1, u + 3, y - 1, FLOWERS[(h >> 13) & 3]);
    else if (k === 1) wallAC(Fc, u - 1, y - 6, { w: 5, h: 4, d: 3 });
  });
  const bal = (u0, u1, glass, pl) => {
    Fc.box(u0, y - 1, 1, u1, y, 5, A.slab);
    if (glass) {
      Fc.box(u0, y + 1, 5, u1, y + 5, 5, C.skyBlue);
      Fc.box(u0, y + 1, 1, u0, y + 5, 4, C.skyBlue); Fc.box(u1, y + 1, 1, u1, y + 5, 4, C.skyBlue);
    } else {
      for (let u = u0; u <= u1; u += 2) Fc.box(u, y + 1, 5, u, y + 5, 5, A.rail);
      Fc.box(u1, y + 1, 5, u1, y + 5, 5, A.rail);
      for (const u of [u0, u1]) { Fc.box(u, y + 1, 1, u, y + 5, 1, A.rail); Fc.box(u, y + 1, 3, u, y + 5, 3, A.rail); }
    }
    Fc.box(u0, y + 6, 5, u1, y + 6, 5, A.rail);
    Fc.box(u0, y + 6, 1, u0, y + 6, 5, A.rail); Fc.box(u1, y + 6, 1, u1, y + 6, 5, A.rail);
    if (pl) { Fc.box(pl, y + 1, 2, pl + 2, y + 2, 4, C.resTileOrangeDk); Fc.box(pl, y + 3, 2, pl + 2, y + 6, 4, C.vegBush); Fc.set(pl + 1, y + 7, 3, FLOWERS[seed & 3][0]); }
  };
  if (style === 'loggia') bal(a + 1, b - 1, (seed & 1) === 0, a + 3 + ((seed * 8) % Math.max(1, b - a - 8)));
  else if (style === 'corner' && n >= 2) {
    bal(us[0] - 2, us[1] + 4, (seed & 2) === 0, us[0] + 4);
    bal(us[n - 2] - 2, us[n - 1] + 4, (seed & 2) === 0, null);
  }
}
const TSTYLE = ['punch', 'corner', 'punch', 'loggia', 'punch', 'punch', 'corner', 'loggia'];

// Tall Apartments — an eleven-storey slab in the ref05 tower language. (r9)
// No longer one stacked grid: a projecting coloured bay runs up the front,
// every floor and face mixes punched windows (boxes, AC units, awnings),
// corner balconies and full loggias, the top three floors step back to an
// L-shaped terrace (deck, rails, planters, umbrella), and a busy railed roof
// (stair house, condensers, tank / garden / solar) crowns it.
const TALL = [
  // (w4) warm accent frames + light warm sills instead of all-white (the
  // white frames, rails and slabs read as 'stacked blue-and-white bands');
  // v1's white quoins on sage read grey -> cream.
  { wall: C.cream, trim: C.resQuoin, pil: C.resTerraTrim, base: C.resTerraTrim, glass: C.winCool, awn: [C.roofGreen, C.signWhite], frame: C.resTerracotta, slab: C.resQuoin, rail: C.resTerracotta, bay: C.resTerracotta, cap: C.resTileDk },
  { wall: C.resSage, trim: C.cream, pil: C.cream, base: C.resTerraTrim, glass: C.winCool, awn: [C.teal, C.signWhite], frame: C.resTileGreenDk, slab: C.cream, rail: C.resTileGreenDk, bay: C.resQuoin, cap: C.resTileGreenDk },
  { wall: C.resQuoin, trim: C.cream, pil: C.resTerraTrim, base: C.brickDark, glass: C.win, awn: [C.red, C.signWhite], frame: C.brickDark, slab: C.cream, rail: C.brickDark, bay: C.resButter, cap: C.brickDark },
];
function bTallApartment(rng, variant) {
  const v = vOf(variant, 3), A = TALL[v];
  const S = scheme({ wall: A.wall, quoin: A.trim, trim: A.pil, frame: A.trim, glass: A.glass, awn: A.awn, flowers: FLOWERS[v] });
  const g = grid(63, 340, 63, R);
  lot(g, 62, 62, 'pave', v);
  const x0 = 8, x1 = 54, z0 = 10, z1 = 54, gh = 26, fh = 22, nf = 11, ns = 8, sb = 7;
  const g1 = G + gh, top = g1 + nf * fh, ys = g1 + ns * fh;     // ys: the setback terrace level
  const xs = x0 + sb, zs = z0 + sb;
  solid(g, x0, G, z0, x1, ys - 1, z1, A.wall);
  solid(g, xs, ys, zs, x1, top, z1, A.wall);
  solid(g, x0, G, z0, x1, g1 - 1, z1, A.base);
  cornice(g, x0, z0, x1, z1, g1 - 2, A.trim, A.pil);
  for (let f = 1; f < nf; f++) {
    const yy = g1 + f * fh - 1;
    if (f < ns) line(g, x0, z0, x1, z1, yy, A.trim); else line(g, xs, zs, x1, z1, yy, A.trim);
  }
  // (w1) chunky 2-proud quoins instead of slim pilasters (critic consensus:
  // fewer but bigger relief trims)
  bigQuoins(g, x0, z0, x1, z1, g1 + 1, ys - 4, A.pil, 4, [5, 3], 2);
  bigQuoins(g, xs, zs, x1, z1, ys + 1, top - 4, A.pil, 4, [5, 3], 2);
  cornice(g, x0, z0, x1, z1, ys - 2, A.pil, A.trim);
  boldCrown(g, xs, zs, x1, z1, top, A.pil, A.cap);                // (w4) bold parapet crown

  // projecting bay up the front (floors 1 .. ns-1), in the accent colour
  const bx0 = 23, bx1 = 39, by0 = g1 + fh - 2, by1 = ys - 3;
  g.box(bx0, by0, z0 - 4, bx1, by1, z0 - 1, A.bay);
  g.box(bx0 - 1, by0 - 1, z0 - 5, bx1 + 1, by0 - 1, z0 - 1, A.trim);
  g.box(bx0 - 1, by1 + 1, z0 - 5, bx1 + 1, by1 + 2, z0 - 1, A.trim);
  const BY = facade(g, 'front', z0 - 4);
  const faces = (f) => f < ns
    ? [[facade(g, 'front', z0), x0, x1, 0], [facade(g, 'back', z1), x0, x1, 1], [facade(g, 'left', x0), z0, z1, 2], [facade(g, 'right', x1), z0, z1, 3]]
    : [[facade(g, 'front', zs), xs, x1, 0], [facade(g, 'back', z1), xs, x1, 1], [facade(g, 'left', xs), zs, z1, 2], [facade(g, 'right', x1), zs, z1, 3]];
  for (let f = 0; f < nf; f++) {
    const y = g1 + 3 + f * fh;
    for (const [Fc, a, b, k] of faces(f)) {
      const st = f === 0 ? 'punch' : TSTYLE[(f + k * 3 + v) % TSTYLE.length];
      if (k === 0 && f >= 1 && f < ns) {                        // front: the bay splits it
        towerFloor(Fc, a, bx0 - 1, y, A, 'punch', f * 5 + k + v);
        towerFloor(Fc, bx1 + 1, b, y, A, 'punch', f * 7 + k + v);
        towerFloor(BY, bx0 - 3, bx1 + 3, y, A, f % 2 ? 'punch' : 'corner', f * 3 + v);
      } else towerFloor(Fc, a, b, y, A, st, f * 11 + k * 5 + v);
    }
  }
  // setback terrace: deck, a rail round the ledge, planters, umbrella, loungers
  g.box(x0, ys - 1, z0, x1, ys - 1, zs - 1, C.plank); g.box(x0, ys - 1, zs, xs - 1, ys - 1, z1, C.plank);
  ledgeWall(g, x0, z0, x1, z1, ys, A.pil, A.cap);                  // (w4) a solid parapet, not post rails
  roofPlanter(g, x0 + 1, z0 + 1, x0 + 5, z0 + 5, ys);
  roofPlanter(g, x1 - 12, z0 + 1, x1 - 2, z0 + 4, ys);
  roofPlanter(g, x0 + 1, z1 - 12, x0 + 5, z1 - 2, ys);
  umbrella(g, 22, z0 + 3, A.awn[0], C.signWhite, 3, ys);
  deckChair(g, 28, z0 + 1, C.signWhite, ys); deckChair(g, 33, z0 + 1, C.signWhite, ys);
  lounger(g, x0 + 2, 26, C.signWhite, ys);
  pot(g, x0 + 2, 40, C.pink, ys);
  // lobby: glass front, double door, canopy, sign; a corner shop with an awning
  const F = facade(g, 'front', z0), B = facade(g, 'back', z1);
  const L = facade(g, 'left', x0), Rt = facade(g, 'right', x1);
  const gy = G + 3;
  F.clear(20, gy, 0, 42, gy + 15, 0); F.box(20, gy, -1, 42, gy + 15, -1, C.winCool);
  for (let u = 20; u <= 42; u += 5) F.box(u, gy, -1, u, gy + 15, -1, A.trim);
  F.box(19, gy + 16, 0, 43, gy + 16, 0, A.trim);
  door(F, 28, G, 7, 15, { color: C.darkGray, frame: A.trim, glass: C.winCool, double: true, step: C.concrete, stepDepth: 3, mat: C.red });
  F.box(16, G + 20, 1, 46, G + 20, 9, A.trim); F.box(16, G + 21, 1, 46, G + 21, 9, A.pil);
  for (const u of [16, 46]) F.box(u, G, 9, u, G + 19, 9, C.darkGray);
  signPanel(F, 26, 36, G + 23, G + 25, C.signWhite, { border: A.pil });
  for (const u of [11, 49]) towerWin(F, u, gy + 2, 4, 12, C.winCool, A.trim);
  L.clear(22, gy, 0, 48, gy + 14, 0); L.box(22, gy, -1, 48, gy + 14, -1, C.winCool);
  for (let u = 22; u <= 48; u += 6) L.box(u, gy, -1, u, gy + 14, -1, A.trim);
  awning(L, 21, 49, gy + 19, 4, { colors: A.awn, stripe: 2 });
  signPanel(L, 27, 43, gy + 20, gy + 22, C.signWhite, { border: A.pil });
  for (const u of [15, 23, 31, 39, 47]) { towerWin(Rt, u, gy + 4, 4, 10, C.winCool, A.trim); if (u < 40) towerWin(B, u - 2, gy + 4, 4, 10, C.winCool, A.trim); }
  awning(Rt, 13, 28, gy + 17, 3, { colors: A.awn, stripe: 2 });
  door(B, 42, G, 6, 15, { color: C.metalDark, frame: A.trim, step: null });
  // busy railed roof
  roofTop(g, xs + 1, zs + 1, x1 - 1, z1 - 1, top + 2, Object.assign({}, S, { wall: A.bay, trim: A.trim }), v * 2 + 1, { kind: ['tank', 'garden', 'solar'][v], rail: false });
  // lot
  paving(g, 2, 2, 60, 60, 7);
  patch(g, 2, 56, 60, 60, LAWN);
  hedge(g, 2, 60, 60, 60, 4);
  streetTree(g, 5, 5, 61); tree(g, 57, 30, 'column', 62);
  roofPlanter(g, 48, 2, 58, 7, G, C.stoneDark, 4);
  bins(g, 49, 55); hydrant(g, 58, 12); pot(g, 3, 46, C.pink); pot(g, 57, 46, C.vegPetalR); pot(g, 11, 3, C.vegPetalW);
  bench(g, 20, G, 57, 'x', 10, { seat: C.wood }); bench(g, 36, G, 57, 'x', 10, { seat: C.wood });
  for (let x = 4; x <= 12; x += 3) g.box(x, G, 57, x, G + 5, 59, C.darkGray);
  return g.done();
}

// Condo Tower (2×2) — a fifteen-storey tower and an eight-storey wing on a
// glass lobby podium, and a resort lot: pool with loungers + umbrellas (v0)
// or tennis court (v1), a residents' park, a drop-off. (r9) The r8 critic
// read the old wrap-around glass balcony on every floor as 'repetitive
// stacked blue window bands with little silhouette variation': now each
// block mixes punched windows (boxes, AC units, awnings), corner balconies
// and loggias floor by floor, the tower carries two projecting accent bays
// and steps back twice (terraces with decks, planters, umbrellas), and every
// roof is railed and busy.
const CONDO = [
  // (w4) warm accent frames (were white); v1's slate bands -> brick
  { wall: C.cream, trim: C.resQuoin, band: C.resTerraTrim, glass: C.winCool, rail: C.resTerraTrim, crown: C.resTerraTrim, frame: C.resTerraTrim, slab: C.resQuoin, bay: C.resTerracotta, awn: [C.roofGreen, C.signWhite], cap: C.resTileDk },
  { wall: C.resTerraTrim, trim: C.cream, band: C.brickDark, glass: C.winCool, rail: C.cream, crown: C.cream, frame: C.cream, slab: C.cream, bay: C.cream, awn: [C.teal, C.signWhite], cap: C.brickDark },
];
function bCondoTower(rng, variant) {
  const v = vOf(variant, 2), A = CONDO[v];
  const S = scheme({ wall: A.wall, trim: A.trim, quoin: A.trim, awn: A.awn, flowers: FLOWERS[v + 1] });
  const g = grid(127, 380, 127, R);
  lot(g, 126, 126, 'pave', v);
  const fh = 22, g1 = G + 26;
  // block: x0..x1 × z0..z1 with nf floors; steps: [[floor, dx0, dz0]] insets
  // of the front (min-Z) and left (min-X) faces from that floor up
  const block = (x0, z0, x1, z1, nf, steps, seed, bays) => {
    const top = g1 + nf * fh;
    const inset = (f) => { let dx = 0, dz = 0; for (const [sf, sx, sz] of steps) if (f >= sf) { dx = sx; dz = sz; } return [dx, dz]; };
    // massing, one slab per step
    const cuts = [0, ...steps.map((s) => s[0]), nf];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [dx, dz] = inset(cuts[i]);
      const ya = i === 0 ? G : g1 + cuts[i] * fh, yb = cuts[i + 1] === nf ? top : g1 + cuts[i + 1] * fh - 1;
      solid(g, x0 + dx, ya, z0 + dz, x1, yb, z1, A.wall);
      if (i > 0) {
        const [px, pz] = inset(cuts[i - 1]);
        // terrace on the ledge: deck, rail, planters, an umbrella
        g.box(x0 + px, ya - 1, z0 + pz, x1, ya - 1, z0 + dz - 1, C.plank);
        g.box(x0 + px, ya - 1, z0 + pz, x0 + dx - 1, ya - 1, z1, C.plank);
        ledgeWall(g, x0 + px, z0 + pz, x1, z1, ya, A.trim, A.cap);     // (w4) solid parapet
        roofPlanter(g, x0 + px + 1, z0 + pz + 1, x0 + px + 5, z0 + pz + 5, ya);
        roofPlanter(g, x1 - 12, z0 + pz + 1, x1 - 2, z0 + pz + 4, ya);
        umbrella(g, x0 + px + ((x1 - x0) >> 1), z0 + pz + 3, A.awn[0], C.signWhite, 3, ya);
        deckChair(g, x0 + px + ((x1 - x0) >> 1) + 6, z0 + pz + 1, C.signWhite, ya);
        pot(g, x0 + px + 2, z1 - 8, C.pink, ya);
      }
      if (cuts[i + 1] === nf) boldCrown(g, x0 + dx, z0 + dz, x1, z1, top, A.trim, A.cap);   // (w4)
      else cornice(g, x0 + dx, z0 + dz, x1, z1, yb - 1, A.crown, A.trim);
    }
    solid(g, x0, G, z0, x1, g1 - 1, z1, A.band);
    for (let f = 1; f < nf; f++) { const [dx, dz] = inset(f); line(g, x0 + dx, z0 + dz, x1, z1, g1 + f * fh - 1, A.band); }
    // projecting accent bays on the front, floors 1 .. first step
    const bf1 = steps.length ? steps[0][0] : nf;
    const BYF = facade(g, 'front', z0 - 4);
    for (const [ba, bb] of bays) {
      g.box(ba, g1 + fh - 2, z0 - 4, bb, g1 + bf1 * fh - 3, z0 - 1, A.bay);
      g.box(ba - 1, g1 + fh - 3, z0 - 5, bb + 1, g1 + fh - 3, z0 - 1, A.trim);
      g.box(ba - 1, g1 + bf1 * fh - 2, z0 - 5, bb + 1, g1 + bf1 * fh - 1, z0 - 1, A.trim);
    }
    for (let f = 0; f < nf; f++) {
      const y = g1 + 3 + f * fh, [dx, dz] = inset(f);
      const faces = [[facade(g, 'front', z0 + dz), x0 + dx, x1, 0], [facade(g, 'back', z1), x0 + dx, x1, 1],
        [facade(g, 'left', x0 + dx), z0 + dz, z1, 2], [facade(g, 'right', x1), z0 + dz, z1, 3]];
      for (const [Fc, a, b, k] of faces) {
        const st = f === 0 ? 'punch' : TSTYLE[(f + k * 3 + seed) % TSTYLE.length];
        if (k === 0 && f >= 1 && f < bf1 && bays.length) {
          let u = a;
          for (const [ba, bb] of bays) { towerFloor(Fc, u, ba - 1, y, A, st === 'loggia' ? 'punch' : st, f * 5 + seed + ba, 3); towerFloor(BYF, ba, bb, y, A, f % 2 ? 'punch' : 'corner', f * 3 + seed + ba, 2); u = bb + 1; }
          towerFloor(Fc, u, b, y, A, st === 'loggia' ? 'punch' : st, f * 7 + seed, 3);
        } else towerFloor(Fc, a, b, y, A, st, f * 11 + k * 5 + seed);
      }
    }
    const [dx, dz] = inset(nf - 1);
    return { top, rx0: x0 + dx, rz0: z0 + dz };
  };
  const T = block(14, 30, 64, 80, 13, [[9, 0, 7], [11, 8, 14]], v, [[16, 32], [46, 62]]);
  const Wg = block(80, 38, 116, 88, 7, [[5, 0, 8]], v + 3, []);
  // lobby podium between the two
  g.box(64, G, 42, 80, g1 + 4, 70, A.band);
  g.box(63, g1 + 5, 41, 81, g1 + 5, 71, A.trim);
  const P = facade(g, 'front', 42);
  P.clear(66, G + 2, 0, 78, G + 18, 0); P.box(66, G + 2, -1, 78, G + 18, -1, C.winCool);
  for (let u = 66; u <= 78; u += 4) P.box(u, G + 2, -1, u, G + 18, -1, A.trim);
  door(P, 69, G, 7, 15, { color: C.darkGray, frame: A.trim, glass: C.winCool, double: true, step: null });
  P.box(62, G + 22, 1, 82, G + 22, 12, A.trim); P.box(62, G + 23, 1, 82, G + 23, 12, A.crown);
  for (const u of [62, 82]) P.box(u, G, 12, u, G + 21, 12, C.darkGray);
  signPanel(P, 66, 78, G + 25, G + 28, C.signWhite, { border: A.crown });
  roofPlanter(g, 66, 50, 78, 56, g1 + 6, C.woodDark, 3);
  // ground-floor shopfronts with awnings on the tower's front + the wing's
  const TF = facade(g, 'front', 30), WF = facade(g, 'front', 38);
  for (const [Fc, u0, u1, c] of [[TF, 18, 34, A.awn], [TF, 44, 60, [C.red, C.signWhite]], [WF, 84, 112, [C.orange, C.signWhite]]]) {
    Fc.clear(u0, G + 3, 0, u1, G + 15, 0); Fc.box(u0, G + 3, -1, u1, G + 15, -1, C.winCool);
    for (let u = u0; u <= u1; u += 4) Fc.box(u, G + 3, -1, u, G + 15, -1, A.trim);
    awning(Fc, u0 - 1, u1 + 1, G + 20, 4, { colors: c, stripe: 2 });
    signPanel(Fc, u0 + 2, u1 - 2, G + 21, G + 23, C.signWhite, { border: A.crown });
  }
  // roofs: railed and busy
  roofTop(g, T.rx0 + 1, T.rz0 + 1, 63, 79, T.top + 2, Object.assign({}, S, { wall: A.bay }), 3, { kind: 'tank', rail: false });
  antenna(g, 40, T.top + 16, 70, 24);
  roofTop(g, Wg.rx0 + 1, Wg.rz0 + 1, 115, 87, Wg.top + 2, Object.assign({}, S, { wall: A.bay }), 4 + v, { kind: v ? 'solar' : 'garden', rail: false });
  // resort lot
  if (v === 0) {
    patch(g, 72, 3, 122, 32, C.plank);
    g.walls(76, G - 1, 7, 118, G - 1, 24, C.signWhite);
    g.box(77, G - 2, 8, 117, G - 1, 23, C.civPool);
    for (let x = 78; x <= 114; x += 9) lounger(g, x, 26 - 0, C.signWhite);
    umbrella(g, 82, 28, C.orange, C.signWhite, 5); umbrella(g, 112, 28, C.teal, C.signWhite, 5);
  } else {                                                      // tennis court
    patch(g, 72, 3, 122, 34, C.roofGreen);
    patch(g, 76, 6, 118, 31, C.teal);
    g.walls(76, G - 1, 6, 118, G - 1, 31, C.signWhite);
    patch(g, 97, 6, 97, 31, C.signWhite); patch(g, 76, 18, 118, 19, C.signWhite);
    g.box(97, G, 4, 97, G + 5, 33, C.darkGray); g.box(97, G + 6, 4, 97, G + 6, 33, C.signWhite);
    g.set(86, G, 12, C.yellow);
  }
  // (r6) the back garden was one bare lawn with six trees (res critic r5:
  // 'no lot surface left bare'): now a residents' park — a paved walk with
  // a cross path, a playground (swings, slide, sandbox), allotment beds,
  // picnic tables, a pergola, flower beds, a few trees at the edges.
  patch(g, 2, 90, 124, 124, LAWN);
  path(g, 4, 92, 122, 96); path(g, 58, 96, 64, 124);
  for (const [x, z] of [[118, 112], [6, 60], [6, 118]]) tree(g, x, z, x % 3 ? 'round' : 'column', x);
  vegRows(g, 8, 100, 30, 112); vegRows(g, 34, 100, 52, 112);
  patioSet(g, 16, 118, C.resTerraTrim, null); patioSet(g, 36, 118, C.resTerraTrim, v ? C.teal : C.orange);
  patioSet(g, 50, 119, C.resTerraTrim, null);
  patch(g, 70, 100, 106, 122, C.sand);                          // playground
  for (const x of [72, 84]) { g.box(x, G, 104, x, G + 16, 104, C.red); g.box(x, G, 110, x, G + 16, 110, C.red); }
  g.box(72, G + 17, 104, 84, G + 17, 110, C.red);
  for (const x of [76, 80]) { g.box(x, G + 6, 107, x, G + 16, 107, C.darkGray); g.box(x - 1, G + 5, 106, x + 1, G + 5, 108, C.vehBlue); }
  g.box(92, G, 104, 97, G + 12, 108, C.yellow);                 // slide tower + chute
  for (let k = 0; k < 10; k++) g.box(98 + k, G + 11 - k, 105, 98 + k, G + 11 - k, 107, C.teal);
  sandbox(g, 88, 114, 98, 120);
  trampoline(g, 76, 117, 5);
  pergola(g, 110, 100, 122, 108, C.white, 14);
  flowerBed(g, 110, 112, 122, 116, FLOWERS[v + 1]);
  for (const x of [8, 30, 90, 110]) bench(g, x, G, 98, 'x', 8, { seat: C.wood });
  paving(g, 2, 2, 124, 88, 8);
  patch(g, 10, 3, 66, 24, C.lotAsphalt);
  for (let x = 14; x <= 62; x += 12) patch(g, x, 5, x + 6, 5, C.lotLine);
  car(g, 22, 8, 1, 1); car(g, 44, 8, 13 + 14, 1);
  for (const px of [2, 118]) roofPlanter(g, px, 30, px + 6, 44, G);
  bins(g, 4, 76); bike(g, 118, 50, C.vehRed); bike(g, 118, 54, C.teal); hydrant(g, 8, 28);
  return g.done();
}

// Mansion (2×2) — a grand two-storey centre block with a columned portico +
// pediment, two lower wings, hipped thin-coursed roofs with box dormers and
// chimneys, a grand stair, a fountain court on a looping drive, gate piers
// with lamps, iron railings, side gardens, and a pool terrace at the back
// (v1 adds a gazebo, v0 a topiary garden).
const MANSION = [
  // (w1) warm roof + cream quoins: the slate roof + white trim read as one grey-white pile
  scheme({ wall: C.cream, roof: ROOF.red, trim: C.white, quoin: C.resQuoin, base: C.stone, glass: C.win, shutter: C.resTileGreenDk, frame: C.resTerraTrim, car: 10 }),
  scheme({ wall: C.resButter, roof: ROOF.tile, trim: C.white, quoin: C.white, base: C.stone, glass: C.win, shutter: C.resTileGreenDk, car: 0 }),
];
function bMansion(rng, variant) {
  const v = vOf(variant, 2), S = MANSION[v];
  const g = grid(127, 170, 127, R);
  lot(g, 126, 126, 'grass', v);
  const fh = 26, top = G + 2 * fh + 2;
  const cx0 = 40, cx1 = 86, cz0 = 42, cz1 = 80;
  body(g, cx0, cz0, cx1, cz1, G, top, S, { baseH: 5 });
  quoins(g, cx0, cz0, cx1, cz1, G + 5, top - 1, S.quoin, 6, [6, 3], 2);
  belt(g, cx0, cz0, cx1, cz1, G + fh + 1, S.trim);
  cornice(g, cx0, cz0, cx1, cz1, top, S.trim);
  const roof = hipRoof(g, cx0, cx1, cz0, cz1, top + 2, { roof: S.roof, ov: 3, fascia: S.trim });
  // wings
  const wt = G + fh + 18;
  for (const [wx0, wx1] of [[12, 39], [87, 114]]) {
    body(g, wx0, 50, wx1, 74, G, wt, S, { baseH: 5 });
    quoins(g, wx0, 50, wx1, 74, G + 5, wt - 1, S.quoin, 6, [5, 3], true);
    cornice(g, wx0, 50, wx1, 74, wt, S.trim);
    hipRoof(g, wx0, wx1, 50, 74, wt + 2, { roof: S.roof, ov: 3, fascia: S.trim });
    const WF = facade(g, 'front', 50), WB = facade(g, 'back', 74);
    for (const u of [wx0 + 5, wx0 + 13, wx0 + 21]) {
      rwin(WF, u, G + 9, 5, 12, S, 'box'); rwin(WF, u, G + fh + 5, 5, 11, S, null);
      rwin(WB, u, G + 9, 5, 12, S, u === wx0 + 13 ? 'awn' : null); rwin(WB, u, G + fh + 5, 5, 11, S, 'box');
    }
    const side = wx0 < 40 ? facade(g, 'left', wx0) : facade(g, 'right', wx1);
    for (const u of [54, 61, 68 - 0]) { rwin(side, u - 1, G + 9, 4, 12, S, 'box'); rwin(side, u - 1, G + fh + 5, 4, 11, S, null); }
    const wr = { xa: wx0 - 3, xb: wx1 + 3, za: 47, zb: 77, y0: wt + 2 + 1 - 3 };
    hipGutters(g, wr, wx0, wx1, 50, 74, C.signWhite);
    railBalcony(WB, wx0 + 12, wx0 + 18, G + fh + 4, 4, S.trim, S.trim, { h: 6 });
  }
  // centre windows
  const F = facade(g, 'front', cz0), B = facade(g, 'back', cz1);
  for (const u of [44, 51, 75, 82]) { rwin(F, u, G + 10, 5, 13, S, 'box'); rwin(F, u, G + fh + 8, 5, 12, S, null); }
  for (const [i, u] of [45, 54, 63, 72, 80].entries()) { rwin(B, u, G + 10, 5, 13, S, u === 63 ? null : i % 2 ? 'awn' : 'box'); if (u !== 63) rwin(B, u, G + fh + 8, 5, 12, S, i % 2 ? 'box' : null); }
  door(F, 59, G + 5, 9, 20, { color: C.woodDark, frame: S.trim, glass: C.win, double: true, step: null, knob: C.gold });
  win(F, 60, G + fh + 8, 7, 14, S, { mullion: 'cross', proud: true, head: true });
  door(B, 59, G + 5, 8, 18, { color: C.white, frame: S.trim, glass: S.glass, double: true, step: C.stone, stepDepth: 4 });
  // portico: 4 columns, entablature, pediment (ridge along Z)
  const pz0 = 28, pTop = G + fh + 18;
  g.box(46, G, pz0, 80, G + 4, cz0 - 1, S.base);
  for (const x of [48, 56, 70, 78]) {
    g.box(x - 1, G + 5, pz0 + 2, x + 1, pTop - 3, pz0 + 4, S.trim);
    g.box(x - 2, G + 5, pz0 + 1, x + 2, G + 6, pz0 + 5, S.trim); g.box(x - 2, pTop - 3, pz0 + 1, x + 2, pTop - 1, pz0 + 5, S.trim);
  }
  g.box(45, pTop, pz0, 81, pTop + 3, cz0, S.trim);
  gableRoof(g, 'z', pz0, cz0 + 6, 45, 81, pTop + 3, { roof: S.roof, fill: S.trim, edge: true, ov: 2, ova: 1, rise: 1, run: 2, caps: false });
  const PF = facade(g, 'front', pz0);
  PF.box(60, pTop + 6, 0, 66, pTop + 9, 1, C.gold);                   // crest
  for (let s = 0; s < 4; s++) g.box(50 - s * 2, G + 3 - s, pz0 - 2 - s * 2, 76 + s * 2, G + 3 - s, pz0 - 1 - s * 2, S.base);   // grand stair
  lamp(PF, 44, G + 16, S); lamp(PF, 81, G + 16, S);
  // dormers + chimneys on the centre roof
  for (const xc of [50, 76]) boxDormer(g, roof, xc, 11, 12, S, 'front');
  for (const xc of [52, 74]) boxDormer(g, roof, xc, 11, 12, S, 'back');
  hipGutters(g, roof, cx0, cx1, cz0, cz1, C.signWhite);
  railBalcony(B, 56, 70, G + fh + 4, 6, S.trim, S.trim);
  for (const x of [45, 79]) chimney(g, x, 58, 5, 7, top, roof.top + 7, C.brick);
  // front court: looping drive, fountain, gate piers, railings, car
  path(g, 56, 2, 70, 14);
  patch(g, 20, 14, 106, 24, C.lotPave); patch(g, 20, 14, 30, 40, C.lotPave); patch(g, 96, 14, 106, 40, C.lotPave);
  const fx = 63, fz = 6 + 0;
  g.walls(fx - 7, G, fz - 3 + 0, fx + 7, G + 2, fz + 5, C.signWhite);
  g.box(fx - 6, G, fz - 2, fx + 6, G + 1, fz + 4, C.civPool);
  g.box(fx - 1, G, fz, fx + 1, G + 8, fz + 2, C.signWhite); g.box(fx - 3, G + 9, fz - 2, fx + 3, G + 9, fz + 4, C.signWhite);
  g.box(fx - 1, G + 10, fz, fx + 1, G + 12, fz + 2, C.waterLight);
  for (const px of [48, 78]) { g.box(px - 2, G, 2, px + 2, G + 16, 5, C.stone); g.box(px - 3, G + 17, 1, px + 3, G + 18, 6, S.trim); g.box(px - 1, G + 19, 3, px + 1, G + 21, 4, C.lamp); }
  fence(g, 'x', 2, 45, 2, C.white, { h: 7, step: 4 }); fence(g, 'x', 81, 124, 2, C.white, { h: 7, step: 4 });
  car(g, 34, 16, S.car, 1);
  hedge(g, 34, 27, 44, 30, 6); hedge(g, 82, 27, 92, 30, 6);
  for (const [x, z] of [[8, 20], [118, 20], [36, 116], [120, 104]]) tree(g, x, z, z > 60 ? 'round' : 'column', x + z);
  flowerBed(g, 4, 34, 22, 44, FLOWERS[0]); flowerBed(g, 104, 34, 122, 44, FLOWERS[3]);
  // back terrace + pool
  patch(g, 34, 86, 92, 122, C.lotPave);
  g.walls(42, G - 1, 92, 84, G - 1, 112, C.signWhite);
  g.box(43, G - 2, 93, 83, G - 1, 111, C.civPool);
  for (const lx of [44, 52, 60]) lounger(g, lx, 114 - 0, C.signWhite);
  umbrella(g, 76, 118, C.red, C.signWhite, 5);
  // formal parterre (left back): gravel walks, clipped box-hedge beds with
  // roses, a statue on a plinth, benches; an orangery behind it
  patch(g, 4, 82, 31, 109, C.lotPave);
  for (const [bx, bz] of [[6, 84], [19, 84], [6, 97], [19, 97]]) {
    g.walls(bx, G, bz, bx + 10, G + 2, bz + 10, C.vegBush);
    g.box(bx + 1, G, bz + 1, bx + 9, G, bz + 9, C.dirtDark);
    for (let x = bx + 2; x < bx + 9; x += 3) for (let z = bz + 2; z < bz + 9; z += 3) { g.set(x, G + 1, z, C.vegStem); g.set(x, G + 2, z, (x + z) % 2 ? C.vegPetalR : C.pink); }
  }
  g.box(17, G, 94, 19, G + 3, 96, C.stone); g.box(17, G + 4, 94, 19, G + 9, 96, C.signWhite); g.box(18, G + 10, 95, 18, G + 11, 95, C.signWhite);
  bench(g, 8, G, 111 - 0, 'x', 9, { seat: C.wood });
  greenhouse(g, 4, 112, 30, 122);
  // right-side garden: rose pergola walk, beds and a bench
  pergola(g, 96, 80, 122, 86, S.trim, 16);
  patch(g, 94, 80 - 0, 123, 88, C.lotPave);
  flowerBed(g, 116, 46, 123, 76, FLOWERS[1]);
  flowerBed(g, 3, 46, 10, 76, FLOWERS[2]);
  // tall clipped boundary hedge along the back, iron fence down the sides
  hedge(g, 2, 122, 124, 124, 7);
  hedge(g, 2, 30, 3, 121, 6); hedge(g, 123, 30, 124, 121, 6);
  // cone topiaries + lamp posts along the drive
  for (const x of [34, 42, 84, 92]) topiary(g, x, G, 11, 7);
  for (const [x, z] of [[18, 26], [108, 26]]) { g.box(x, G, z, x + 1, G + 16, z + 1, C.darkGray); g.box(x - 1, G + 17, z - 1, x + 2, G + 19, z + 2, C.lamp); g.box(x - 1, G + 20, z - 1, x + 2, G + 20, z + 2, C.darkGray); }
  if (v === 1) {                                                // gazebo
    patch(g, 96, 94, 118, 116, C.lotPave);
    for (const [x, z] of [[98, 96], [116, 96], [98, 114], [116, 114]]) g.box(x, G, z, x + 1, G + 18, z + 1, S.trim);
    g.box(98, G, 96, 117, G, 115, C.plank);
    for (let k = 0; k < 10; k++) g.box(96 + k, G + 19 + k, 94 + k, 119 - k, G + 19 + k, 117 - k, k % 2 ? S.roof[1] : S.roof[0]);
    g.box(107, G + 29, 105, 108, G + 31, 106, C.gold);
  } else {                                                      // topiary garden
    for (const [x, z] of [[98, 96], [110, 96], [98, 108], [110, 108]]) { hedge(g, x - 2, z - 2, x + 5, z + 5, 3); topiary(g, x, G + 3, z, 10); }
  }
  return g.done();
}

// ---------------------------------------------------------------------------
// Zoned R growth: level 1 houses, level 2 townhouses / duplexes / big houses,
// level 3 apartments — the same res-8 homes, picked + varied by the zone's rng.
// ---------------------------------------------------------------------------
export function residential(level, rng) {
  const v = (rng() * 12) | 0;
  if (level === 1) return (rng() < 0.7 ? bSmallHouse : bCottage)(rng, v);
  if (level === 2) return (rng() < 0.5 ? bTownhouse : rng() < 0.5 ? bDuplex : bBigHouse)(rng, v);
  return bApartment(rng, v);
}

// ---------------------------------------------------------------------------
// Registry: catalog id -> builder (rng, variant, entry) => model. Merged by
// catalog.js; CATALOG metadata (name/emoji/footprint/cap) stays in catalog.js.
// ---------------------------------------------------------------------------
export const BUILDERS = {
  'small-house': bSmallHouse, 'cottage': bCottage, 'big-house': bBigHouse,
  'townhouse': bTownhouse, 'duplex': bDuplex, 'cabin': bCabin,
  'farmhouse': bFarmhouse, 'beach-house': bBeachHouse, 'apartment': bApartment,
  'tall-apartment': bTallApartment, 'condo-tower': bCondoTower, 'mansion': bMansion,
};
