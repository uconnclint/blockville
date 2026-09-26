// Blockville models — INDUSTRIAL / UTILITY: zoned I growth (industrial) +
// catalog 'factories' + wind-power (and its rotor spinner part).
//
// Everything here is authored at res 4 (32 fine voxels per tile) on its own
// lot (lotPlinth), in the "Isometric City Voxel" style: clean white / pastel
// halls with blue ribbon glazing and pilasters, sawtooth roofs, banded smoke
// stacks, domed tanks, pipe runs, loading docks with trucks, striped parking.
// Kid-friendly themes (toys, chocolate, crayons…) are told through signage and
// giant rooftop props, never through grime.
//
// Layout convention for a 1×1 plant (fine voxels, front toward min-Z): see
// plant() below — hall in the middle, yards on the front / left / back, hero
// prop on the roof. Every side is dressed: the iso camera may see any two.

import { stampCar, stampLotCar } from './vehicles.js';
import {
  C, grid, pk, lotPlinth, facade, door, signPanel, pixelText, wallLamp, flipZ,
  acBox, solarPanel, ventPipe, bench, wallAC,
} from './core.js';

const R = 4;                       // voxels per world unit for every model here

// ===========================================================================
// ROUND SHAPES (discs / rings / cylinders / domes / cones)
// ===========================================================================
const _disc = new Map(), _ring = new Map();
// offsets of a filled disc of radius r (integer centre voxel; odd widths)
function discOff(r) {
  const k = Math.round(r * 4) / 4;
  let d = _disc.get(k);
  if (d) return d;
  d = [];
  const n = Math.ceil(k) + 1, lim = k * k + k * 0.9;
  for (let x = -n; x <= n; x++) for (let z = -n; z <= n; z++) if (x * x + z * z <= lim) d.push([x, z]);
  _disc.set(k, d);
  return d;
}
// the 4-connected outline of discOff(r) (a watertight 1-voxel shell)
function ringOff(r) {
  const k = Math.round(r * 4) / 4;
  let d = _ring.get(k);
  if (d) return d;
  const s = new Set(discOff(k).map(([x, z]) => x + ',' + z));
  d = discOff(k).filter(([x, z]) => !s.has((x + 1) + ',' + z) || !s.has((x - 1) + ',' + z) || !s.has(x + ',' + (z + 1)) || !s.has(x + ',' + (z - 1)));
  _ring.set(k, d);
  return d;
}
function disc(g, cx, cz, r, y, c) { for (const [dx, dz] of discOff(r)) g.set(cx + dx, y, cz + dz, c); }
function ring(g, cx, cz, r, y0, y1, c) {
  const o = ringOff(r);
  for (let y = y0; y <= y1; y++) for (const [dx, dz] of o) g.set(cx + dx, y, cz + dz, c);
}
// hollow vertical cylinder with a closed top (cap colour, false = open)
function cylinder(g, cx, cz, r, y0, y1, c, cap) {
  ring(g, cx, cz, r, y0, y1, c);
  if (cap !== false) disc(g, cx, cz, r, y1, cap == null ? c : cap);
}
function dome(g, cx, cz, r, y0, c) {
  const h = Math.max(1, Math.round(r * 0.5));
  for (let i = 0; i < h; i++) disc(g, cx, cz, r * Math.sqrt(1 - Math.pow((i + 1) / (h + 1), 2)), y0 + i, c);
  return y0 + h;
}
function cone(g, cx, cz, r, y0, h, c) {
  for (let i = 0; i < h; i++) disc(g, cx, cz, Math.max(0, r * (1 - i / h)), y0 + i, c);
  return y0 + h;
}

// ===========================================================================
// INDUSTRIAL KIT
// ===========================================================================

// Hall: hollow box with a slate plinth band, proud corner pilasters, a 2-high
// parapet with light coping, and a roof deck. Returns the y rooftop gear
// stands on. o: { wall, trim, roof, base, band:[y,colour], pil (spacing) }
function hall(g, x0, z0, x1, z1, y0, h, o = {}) {
  const wall = o.wall != null ? o.wall : C.indWall;
  const trim = o.trim != null ? o.trim : C.indShade;
  const roof = o.roof != null ? o.roof : C.indRoof;
  const base = o.base != null ? o.base : C.indBase;
  const yT = y0 + h - 1;
  g.walls(x0, y0, z0, x1, yT, z1, wall);
  g.walls(x0, y0, z0, x1, y0 + 1, z1, base);
  if (o.band) g.walls(x0, o.band[0], z0, x1, o.band[0] + (o.band[2] || 1) - 1, z1, o.band[1]);
  g.walls(x0, yT, z0, x1, yT, z1, o.coping != null ? o.coping : C.white);
  g.box(x0 + 1, yT - 2, z0 + 1, x1 - 1, yT - 2, z1 - 1, roof);
  // proud corner pilasters (+ optional intermediate ones on every face)
  const pil = (x, z) => g.box(x, y0, z, x, yT - 1, z, trim);
  for (const [x, z] of [[x0 - 1, z0], [x0, z0 - 1], [x1 + 1, z0], [x1, z0 - 1], [x0 - 1, z1], [x0, z1 + 1], [x1 + 1, z1], [x1, z1 + 1]]) pil(x, z);
  if (o.pil) {
    for (let x = x0 + o.pil; x < x1 - 2; x += o.pil) { pil(x, z0 - 1); pil(x, z1 + 1); }
    for (let z = z0 + o.pil; z < z1 - 2; z += o.pil) { pil(x0 - 1, z); pil(x1 + 1, z); }
  }
  return yT - 1;
}

// Ribbon glazing: recessed glass with mullions on the 1-world-unit lattice
// (every 4 fine voxels, so each pane lights as one night cell), proud sill,
// lintel. u0/u1/y are absolute (u = x on front/back, z on left/right).
function ribbon(f, u0, u1, y0, h, o = {}) {
  const glass = o.glass != null ? o.glass : C.winCool;
  const frame = o.frame != null ? o.frame : C.indShade;
  f.box(u0 - 1, y0 - 1, 1, u1 + 1, y0 - 1, 1, o.sill != null ? o.sill : C.white);
  f.box(u0 - 1, y0 + h, 0, u1 + 1, y0 + h, 0, frame);
  for (let u = u0 - 1; u <= u1 + 1; u++) {
    const mull = u < u0 || u > u1 || (u & 3) === 0;
    for (let y = y0; y < y0 + h; y++) {
      if (mull) f.set(u, y, 0, frame);
      else { f.del(u, y, 0); f.set(u, y, -1, o.transom && y === y0 + (h >> 1) ? frame : glass); }
    }
  }
}

// Roll-up door: frame, recessed slatted shutter, proud hood, hazard bollards.
function rollDoor(f, u0, u1, y0, h, o = {}) {
  const c = o.color != null ? o.color : C.indShade;
  const slat = o.slat != null ? o.slat : C.indBase;
  const frame = o.frame != null ? o.frame : C.indBase;
  f.box(u0 - 1, y0, 0, u1 + 1, y0 + h, 0, frame);
  f.clear(u0, y0, 0, u1, y0 + h - 1, 0);
  for (let y = y0; y < y0 + h; y++) f.box(u0, y, -1, u1, y, -1, (y - y0) % 4 === 3 ? slat : c);
  f.box(u0 - 1, y0 + h + 1, 1, u1 + 1, y0 + h + 1, 2, o.hood != null ? o.hood : C.indRoof);
  if (o.bollards !== false) for (const u of [u0 - 2, u1 + 2]) for (let y = y0; y < y0 + 4; y++) f.set(u, y, 2, (y - y0) & 1 ? C.black : C.yellow);
}

// Hazard stripes painted on the lot surface (y = lot top layer).
function hazard(g, x0, z0, x1, z1, y) {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) g.set(x, y, z, ((x + z) >> 1) & 1 ? C.black : C.yellow);
}
// Asphalt patch with white bay lines. axis 'x' = lines run along z every `pitch` in x.
function parking(g, x0, z0, x1, z1, y, axis, pitch, o = {}) {
  g.box(x0, y, z0, x1, y, z1, C.lotAsphalt);
  if (axis === 'x') {
    for (let x = x0 + 1; x <= x1 - 1; x += pitch) for (let z = z0 + (o.open ? 0 : 1); z <= z1 - 1; z++) g.set(x, y, z, C.lotLine);
  } else {
    for (let z = z0 + 1; z <= z1 - 1; z += pitch) for (let x = x0 + (o.open ? 0 : 1); x <= x1 - 1; x++) g.set(x, y, z, C.lotLine);
  }
}

// Sign board with pixel lettering on any facade. (uc = centre along u)
function sign(f, uc, y0, text, o = {}) {
  const w = text.length * 4 - 1, pad = o.pad != null ? o.pad : 2, out = o.out || 1;
  const u0 = uc - (w >> 1) - pad, u1 = u0 + w - 1 + 2 * pad;
  signPanel(f, u0, u1, y0, y0 + 8, o.bg != null ? o.bg : C.indBlue, { border: o.border, out });
  pixelText(f, f.rd > 0 ? u0 + pad : u1 - pad, y0 + 2, text, o.fg != null ? o.fg : C.signWhite, out + 1);
  return [u0, u1];
}
// Free-standing sign on two posts facing the front, board centred on x = xc.
function postSign(g, xc, z, yBase, yBoard, text, o = {}) {
  const f = facade(g, 'front', z + 1);
  const [u0, u1] = sign(f, xc, yBoard, text, o);
  for (const x of [u0 + 2, u1 - 2]) g.box(x, yBase, z + 1, x, yBoard - 1, z + 1, o.post != null ? o.post : C.darkGray);
}

// Smoke stack: concrete foot, light body, striped top, dark rim + sooty hole.
function stack(g, cx, cz, r, y0, y1, o = {}) {
  const body = o.body != null ? o.body : C.indTank;
  const stripe = o.stripe != null ? o.stripe : C.orange;
  const bands = o.bands != null ? o.bands : 2, bh = o.bandH || 6;
  cylinder(g, cx, cz, r + 1, y0, y0 + 3, C.indShade);
  ring(g, cx, cz, r, y0 + 4, y1, body);
  for (let k = 0; k < bands; k++) {
    const top = y1 - 3 - k * 2 * bh;
    ring(g, cx, cz, r, top - bh + 1, top, stripe);
  }
  ring(g, cx, cz, r + 1, y1 - 2, y1, C.indBase);                     // light rim, soot-grey mouth
  disc(g, cx, cz, r, y1 - 1, C.darkGray);
  if (o.ladder !== false) g.box(cx + r + 1, y0 + 4, cz, cx + r + 1, y1 - 4, cz, C.metalDark); // ladder rail
}

// Vertical tank: foot ring, body, painted bands, dome, ladder.
function tank(g, cx, cz, r, y0, h, o = {}) {
  const c = o.c != null ? o.c : C.indTank;
  cylinder(g, cx, cz, r + 1, y0, y0, C.indShade);
  cylinder(g, cx, cz, r, y0 + 1, y0 + h - 1, c);
  for (const by of (o.bands || [])) ring(g, cx, cz, r, y0 + by, y0 + by + (o.bandW || 2) - 1, o.band != null ? o.band : C.red);
  const top = dome(g, cx, cz, r, y0 + h, o.top != null ? o.top : c);
  if (o.ladder !== false) for (let y = y0 + 2; y < y0 + h; y++) g.set(cx + r + 1, y, cz - 1, C.metalDark);
  return top;
}




// Pipe rack: n parallel 2×2 pipes (colours `cols`) on portal frames every `step`.
// axis 'x' → runs along x at z = w0.., axis 'z' → along z at x = w0...
function pipeRack(g, axis, a0, a1, w0, y, cols, yg, step = 8) {
  const W = cols.length * 3 - 1;
  const P = (a, yy, w, c) => (axis === 'x' ? g.set(a, yy, w, c) : g.set(w, yy, a, c));
  for (let a = a0; a <= a1; a++) cols.forEach((c, i) => { for (const dw of [0, 1]) for (const dy of [0, 1]) P(a, y + dy, w0 + i * 3 + dw, c); });
  if (yg != null) for (let a = a0 + 1; a <= a1 - 1; a += step) {
    for (let yy = yg; yy < y; yy++) { P(a, yy, w0 - 1, C.metalDark); P(a, yy, w0 + W, C.metalDark); }
    for (let w = w0 - 1; w <= w0 + W; w++) P(a, y - 1, w, C.metalDark);
  }
}

// Transformer (substation): cabinet body, cooling fins both sides, three
// white insulator bushings on top, yellow warning plate. 6×5 footprint.
function transformer(g, x, y, z, o = {}) {
  const body = o.c != null ? o.c : C.indShade;
  g.box(x, y, z, x + 5, y + 5, z + 4, body);
  g.box(x, y + 5, z, x + 5, y + 5, z + 4, C.indWall);
  for (const xx of [x - 1, x + 6]) for (let zz = z; zz <= z + 4; zz += 2) g.box(xx, y + 1, zz, xx, y + 4, zz, C.indBase);
  for (const bx of [x + 1, x + 3, x + 5]) { g.box(bx, y + 6, z + 2, bx, y + 9, z + 2, C.white); g.set(bx, y + 7, z + 2, C.roofBrown); g.set(bx, y + 10, z + 2, C.metalDark); }
  g.box(x + 2, y + 2, z - 1, x + 3, y + 3, z - 1, C.yellow);
  g.box(x + 2, y + 2, z + 5, x + 3, y + 3, z + 5, C.yellow);
}
// Switchgear row: little grey cabinets with a dark door stripe, along x.
function switchgear(g, x0, y, z, n) {
  for (let i = 0; i < n; i++) {
    const x = x0 + i * 4;
    g.box(x, y, z, x + 2, y + 5, z + 2, C.indShade);
    g.box(x, y + 6, z, x + 2, y + 6, z + 2, C.indWall);
    g.box(x + 1, y + 1, z - 1, x + 1, y + 4, z - 1, C.indBase);
    g.box(x + 1, y + 1, z + 3, x + 1, y + 4, z + 3, C.indBase);
  }
}
// Line gantry: two posts + cross beam across z at x, wires strung along x to x2.
function gantry(g, x, z0, z1, y, h) {
  g.box(x, y, z0, x, y + h, z0, C.indShade); g.box(x, y, z1, x, y + h, z1, C.indShade);
  g.box(x, y + h, z0, x, y + h, z1, C.indShade);
  for (let z = z0 + 2; z < z1; z += 3) { g.set(x, y + h - 1, z, C.white); }
}

// Yellow machinery: a generator skid / small crane, hazard-striped.
function genset(g, x, y, z, axis = 'x') {
  const P = lf(g, x, y, z, axis, 1, 9);
  P.box(0, 0, 0, 8, 0, 4, C.darkGray);
  P.box(0, 1, 0, 6, 4, 4, C.yellow);
  P.box(7, 1, 0, 8, 5, 4, C.orange);
  for (let a = 1; a <= 5; a += 2) { P.box(a, 2, -1, a, 3, -1, C.darkGray); P.box(a, 2, 5, a, 3, 5, C.darkGray); }
  P.box(1, 5, 1, 2, 7, 2, C.metalDark); P.set(1, 8, 1, C.darkGray);
}
function gasBottles(g, x, y, z, n, c) {
  for (let i = 0; i < n; i++) { g.box(x + i * 2, y, z, x + i * 2, y + 4, z, c); g.set(x + i * 2, y + 5, z, C.metalDark); }
  g.box(x - 1, y + 3, z - 1, x + n * 2 - 1, y + 3, z - 1, C.metalDark);
}

// Glass curtain-wall block (ref05's blue office by the tower): blue glazing,
// white mullions every 4, white floor bands, a plinth and a parapet band.
function glassBlock(g, x0, z0, x1, z1, y0, h, o = {}) {
  const frame = o.frame != null ? o.frame : C.white, glass = o.glass != null ? o.glass : C.winCool;
  const fl = o.floor || 6, yT = y0 + h - 1;
  g.walls(x0, y0, z0, x1, yT, z1, glass);
  for (let y = y0; y <= yT; y++) {
    for (let x = x0; x <= x1; x += 4) { g.set(x, y, z0, frame); g.set(x, y, z1, frame); }
    for (let z = z0; z <= z1; z += 4) { g.set(x0, y, z, frame); g.set(x1, y, z, frame); }
    g.set(x1, y, z0, frame); g.set(x1, y, z1, frame); g.set(x0, y, z1, frame);
  }
  for (let y = y0 + fl; y < yT - 2; y += fl) g.walls(x0, y, z0, x1, y, z1, frame);
  g.walls(x0, y0, z0, x1, y0 + 1, z1, o.base != null ? o.base : C.indBase);
  g.walls(x0, yT - 2, z0, x1, yT, z1, frame);
  g.box(x0 + 1, yT - 2, z0 + 1, x1 - 1, yT - 2, z1 - 1, o.roof != null ? o.roof : C.indRoofLt);
  return yT - 1;
}

// 2× pixel lettering (6×10 glyphs) — readable signage at gallery zoom. M and
// W get 5-wide glyphs (10 voxels): at 3 wide they read as H (critic: "POHER").
const WIDE = {
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
};
const bigAdv = (ch) => (WIDE[ch] ? 12 : 8);
function bigText(f, u, y, text, c, out = 2) {
  const s = String(text).toUpperCase();
  let col = 0;
  for (const ch of s) {
    const px = [];
    if (WIDE[ch]) WIDE[ch].forEach((row, r) => { for (let i = 0; i < 5; i++) if (row[i] === '#') px.push([i, 4 - r]); });
    else {
      const tmp = { rd: 1, set(uu, yy) { px.push([uu, yy]); } };
      pixelText(tmp, 0, 0, ch === 'O' ? '0' : ch, c, out);        // square O reads better at 2×
    }
    for (const [pu, py] of px) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) f.set(u + f.rd * (col + pu * 2 + a), y + py * 2 + b, out, c);
    col += bigAdv(ch);
  }
  return col - 2;
}
// Big sign board (dark board, white 2× letters, bright border) centred on uc.
function bigSign(f, uc, y0, text, o = {}) {
  const w = [...String(text).toUpperCase()].reduce((t, ch) => t + bigAdv(ch), 0) - 2;
  const pad = o.pad != null ? o.pad : 3, out = o.out || 1;
  const u0 = uc - (w >> 1) - pad, u1 = u0 + w - 1 + 2 * pad;
  signPanel(f, u0, u1, y0, y0 + 15, o.bg != null ? o.bg : C.navy, { border: o.border != null ? o.border : C.yellow, out });
  // letters inlaid flush with the board: counters (P, R, O) stay crisp instead
  // of filling with AO as they did when the letters stood proud
  bigText(f, f.rd > 0 ? u0 + pad : u1 - pad, y0 + 3, text, o.fg != null ? o.fg : C.signWhite, out);
  return [u0, u1];
}

// Pipes (2×2) + support posts down to `yg`.
function pipeX(g, x0, x1, y, z, c, yg, step = 10) {
  g.box(x0, y, z, x1, y + 1, z + 1, c);
  if (yg != null) for (let x = x0 + 2; x <= x1 - 1; x += step) g.box(x, yg, z, x, y - 1, z, C.metalDark);
}
function pipeZ(g, z0, z1, y, x, c, yg, step = 10) {
  g.box(x, y, z0, x + 1, y + 1, z1, c);
  if (yg != null) for (let z = z0 + 2; z <= z1 - 1; z += step) g.box(x, yg, z, x, y - 1, z, C.metalDark);
}

// Sawtooth roof: teeth run along x; the vertical glazed faces look at the front (-z).
function sawtooth(g, x0, x1, z0, z1, y, o = {}) {
  const D = o.D || 7, H = o.H || 4;
  const roof = o.roof != null ? o.roof : C.indRoofLt, glass = o.glass != null ? o.glass : C.winCool;
  const frame = o.frame != null ? o.frame : C.white;
  for (let zs = z0; zs + D - 1 <= z1; zs += D) {
    for (let j = 0; j < H; j++) {
      const ze = zs + Math.max(1, Math.round((D - 1) * (1 - j / H)));
      g.box(x0, y + j, zs, x1, y + j, ze, roof);
      for (let x = x0; x <= x1; x++) g.set(x, y + j, zs, j === H - 1 || x === x0 || x === x1 || (x & 3) === 0 ? frame : glass);
    }
  }
}

// Skylight strip (raised glass with a frame) on a roof.
function skylight(g, x0, z0, x1, z1, y) {
  g.box(x0, y, z0, x1, y, z1, C.white);
  g.box(x0 + 1, y, z0 + 1, x1 - 1, y, z1 - 1, C.winCool);
}

// ---- props: a local frame so a prop can lie along x or z ----------------
// a = along the length (a=0 is the front/cab end), w = across, dir ±1.
function lf(g, x0, y0, z0, axis, dir = 1, len = 0) {
  const ax = axis === 'x';
  const A = (a) => (dir > 0 ? a : len - 1 - a);
  return {
    set(a, y, w, c) { const aa = A(a); g.set(ax ? x0 + aa : x0 + w, y0 + y, ax ? z0 + w : z0 + aa, c); },
    box(a0, ya, w0, a1, yb, w1, c) {
      for (let a = Math.min(a0, a1); a <= Math.max(a0, a1); a++) for (let y = ya; y <= yb; y++) for (let w = Math.min(w0, w1); w <= Math.max(w0, w1); w++) this.set(a, y, w, c);
    },
  };
}
// Box truck, 6 wide × 18 long × 9 tall. (x0,z0) = min corner; cab at a=0.
function truck(g, x0, y, z0, axis, dir, o = {}) {
  const L = o.len || 18, W = 6, P = lf(g, x0, y, z0, axis, dir, L);
  const cab = o.cab != null ? o.cab : C.white, box = o.box != null ? o.box : C.orange;
  for (const a of (L >= 16 ? [1, 2, L - 7, L - 6, L - 4, L - 3] : [1, 2, L - 4, L - 3])) { P.set(a, 0, 0, C.black); P.set(a, 0, W - 1, C.black); P.set(a, 1, 0, C.black); P.set(a, 1, W - 1, C.black); }
  P.box(0, 1, 1, L - 1, 1, W - 2, C.darkGray);                  // chassis
  P.box(0, 2, 0, 4, 5, W - 1, cab);                             // cab
  P.box(0, 4, 1, 0, 5, W - 2, C.winCool);                       // windscreen
  P.box(1, 4, 0, 2, 5, 0, C.winCool); P.box(1, 4, W - 1, 2, 5, W - 1, C.winCool);
  P.box(1, 6, 0, 4, 6, W - 1, cab);                             // cab roof
  P.set(0, 2, 0, C.lamp); P.set(0, 2, W - 1, C.lamp);           // headlights
  P.box(0, 2, 2, 0, 2, W - 3, C.darkGray);                      // grille
  if (o.flat) {                                                 // flatbed (logs / cars ride on it)
    P.box(6, 2, 0, L - 1, 2, W - 1, box);
    return;
  }
  P.box(6, 2, 0, L - 1, 8, W - 1, box);                         // cargo box
  P.box(6, 6, 0, L - 1, 6, W - 1, o.stripe != null ? o.stripe : C.white);
  P.box(L - 1, 2, 1, L - 1, 7, W - 2, o.rear != null ? o.rear : C.indShade);
  if (o.logo != null) { const l0 = Math.min(9, L - 6); P.box(l0, 3, 0, l0 + Math.min(4, L - 8), 4, 0, o.logo); P.box(l0, 3, W - 1, l0 + Math.min(4, L - 8), 4, W - 1, o.logo); }
}
// r9 (critic r8: the yard trucks were "oversized, featureless cubes, about a
// third of the building height"; ref05's trucks are small and scattered):
// yard vehicles are drawn in the res-8 FINE part with the same voxel art, so
// they come out HALF size — a box truck 0.75 wide × 1.1 tall, a semi ~2.9
// long, the traffic's scale. Coordinates are COARSE design coords (fractions
// ok, snapped to the fine grid); lengths are in FINE voxels.
const fq = (v) => Math.round(2 * v);
function fTruck(H, x0, y, z0, axis, dir, o = {}) { H.fine((F) => { truck(F, fq(x0), fq(y), fq(z0), axis, dir, o); truckTrim(F, fq(x0), fq(y), fq(z0), axis, dir, o); }); }
function fTanker(H, x0, y, z0, axis, dir, o = {}) { H.fine((F) => { tanker(F, fq(x0), fq(y), fq(z0), axis, dir, o); truckTrim(F, fq(x0), fq(y), fq(z0), axis, dir, o); }); }
function fTrailer(H, x0, y, z0, axis, dir, len, c, o = {}) { H.fine((F) => trailer(F, fq(x0), fq(y), fq(z0), axis, dir, len, c, o)); }
// mirrors, marker lamps and a roof fairing: the small bits a half-size cab
// needs to read as a truck, not a box
function truckTrim(F, x0, y, z0, axis, dir, o = {}) {
  const L = o.len || 18, W = 6, P = lf(F, x0, y, z0, axis, dir, L);
  P.set(1, 5, -1, C.darkGray); P.set(1, 5, W, C.darkGray);                    // mirrors
  P.set(1, 4, -1, C.darkGray); P.set(1, 4, W, C.darkGray);
  P.box(1, 7, 1, 3, 7, W - 2, o.cab != null ? o.cab : C.white);                   // roof fairing
  P.set(0, 3, 1, C.metal); P.set(0, 3, W - 2, C.metal);                          // bumper ends
  if (!o.flat && !o.tank) { P.set(L - 1, 2, 0, C.red); P.set(L - 1, 2, W - 1, C.red); }
}
// Tanker truck (milk / juice): round-ish tank instead of the box.
function tanker(g, x0, y, z0, axis, dir, o = {}) {
  const L = o.len || 18;
  truck(g, x0, y, z0, axis, dir, { cab: o.cab, box: C.darkGray, flat: true, len: L });
  const P = lf(g, x0, y, z0, axis, dir, L);
  const c = o.tank != null ? o.tank : C.indTank;
  P.box(6, 3, 0, L - 1, 7, 5, c); P.box(6, 2, 1, L - 1, 8, 4, c);
  P.box(6, 5, 0, L - 1, 5, 0, o.band != null ? o.band : C.indBlue); P.box(6, 5, 5, L - 1, 5, 5, o.band != null ? o.band : C.indBlue);
  P.box(Math.min(10, L - 4), 9, 2, Math.min(12, L - 2), 9, 3, C.metal);   // hatch
}
// Little car in a 5 × 9 spot / van in a 5 × 10 spot. (life r5) Both are the
// shared res-8 lot vehicles now (vehicles.js stampLotCar / stampCar: glazed
// cabin, wheels, lights, liveries), centred in the old footprint; a = 0 (the
// nose) at the min end when dir > 0, as before.
function car(g, x0, y, z0, axis, dir, c) {
  const seed = x0 * 73 + z0 * 151 + (c | 0);
  if (axis === 'x') stampLotCar(g, x0, y, z0 + 0.5, dir > 0 ? 3 : 1, c, seed);
  else stampLotCar(g, x0 + 0.5, y, z0, dir > 0 ? 0 : 2, c, seed);
}
function van(g, x0, y, z0, axis, dir, c, o = {}) {
  const v = 11 + 14 * ((x0 * 7 + z0 * 3) & 7);                  // panel van kind, livery varies
  if (axis === 'x') stampCar(g, v, x0 + 0.5, y, z0 + 0.5, dir > 0 ? 3 : 1, c);
  else stampCar(g, v, x0 + 0.5, y, z0 + 0.5, dir > 0 ? 0 : 2, c);
}
// Forklift 2 wide × 5 long × 4 tall (r9: was 4 × 7 × 9 — next to the half-size
// fine trucks it read as a yellow crate the height of a truck).
function forklift(g, x0, y, z0, axis, dir) {
  const P = lf(g, x0, y, z0, axis, dir, 5);
  P.box(2, 0, 0, 4, 1, 1, C.yellow);                            // body
  P.box(4, 2, 0, 4, 2, 1, C.darkGray);                          // counterweight top
  P.set(2, 2, 0, C.darkGray); P.set(2, 2, 1, C.darkGray);       // guard posts
  P.box(2, 3, 0, 3, 3, 1, C.darkGray);                          // overhead guard
  P.box(1, 0, 0, 1, 3, 1, C.metalDark);                         // mast
  P.set(0, 0, 0, C.metalDark); P.set(0, 0, 1, C.metalDark);     // forks
}
// The full-detail forklift (4 × 7 × 9 voxels), drawn in the FINE part: half
// size, ~0.5 × 0.9 × 1.1 units, next to the half-size trucks.
function fForklift(H, x0, y, z0, axis, dir) {
  H.fine((F) => {
    const P = lf(F, fq(x0), fq(y), fq(z0), axis, dir, 7);
    P.set(1, 0, 0, C.black); P.set(1, 0, 3, C.black); P.set(5, 0, 0, C.black); P.set(5, 0, 3, C.black);
    P.box(1, 1, 0, 6, 3, 3, C.yellow);
    P.box(3, 4, 0, 3, 7, 0, C.darkGray); P.box(3, 4, 3, 3, 7, 3, C.darkGray); P.box(3, 8, 0, 6, 8, 3, C.darkGray);
    P.box(0, 1, 0, 0, 6, 3, C.darkGray);
    P.set(-1, 0, 1, C.metalDark); P.set(-1, 0, 2, C.metalDark); P.set(-2, 0, 1, C.metalDark); P.set(-2, 0, 2, C.metalDark);
  });
}
// Stack of crates on a pallet. (w×d footprint, n layers)
function crates(g, x0, y, z0, w, d, n, cols) {
  g.box(x0, y, z0, x0 + w - 1, y, z0 + d - 1, C.woodDark);
  for (let k = 0; k < n; k++) {
    const c = cols[k % cols.length];
    g.box(x0, y + 1 + k * 3, z0, x0 + w - 1, y + 3 + k * 3, z0 + d - 1, c);
    g.box(x0, y + 3 + k * 3, z0, x0 + w - 1, y + 3 + k * 3, z0 + d - 1, c === C.wood ? C.plank : c);
  }
}
// Gift box (for toy yard): cube with a ribbon cross on top.
function gift(g, x0, y, z0, s, c, rib) {
  g.box(x0, y, z0, x0 + s - 1, y + s - 1, z0 + s - 1, c);
  const m = x0 + (s >> 1), n = z0 + (s >> 1);
  g.box(m, y, z0, m, y + s - 1, z0, rib); g.box(x0, y, n, x0, y + s - 1, n, rib);
  g.box(m, y + s - 1, z0, m, y + s - 1, z0 + s - 1, rib); g.box(x0, y + s - 1, n, x0 + s - 1, y + s - 1, n, rib);
  g.set(m, y + s, n, rib);
}
function barrel(g, x, y, z, c) { g.box(x, y, z, x + 1, y + 2, z + 1, c); g.box(x, y + 3, z, x + 1, y + 3, z + 1, C.darkGray); }
function bollard(g, x, y, z) { for (let k = 0; k < 4; k++) g.set(x, y + k, z, k & 1 ? C.black : C.yellow); }
// Chunky voxel tree (lime canopy, darker skirt, pixel dots, square trunk).
function tree(g, x, y, z, s = 6) {
  g.box(x, y, z, x + 1, y + 3, z + 1, C.trunk);
  const x0 = x - (s >> 1) + 1, z0 = z - (s >> 1) + 1;
  g.box(x0, y + 4, z0, x0 + s - 1, y + 4, z0 + s - 1, C.leafMid);
  g.box(x0, y + 5, z0, x0 + s - 1, y + 3 + s, z0 + s - 1, C.lime);
  g.set(x0, y + 6, z0 + 1, C.leafMid); g.set(x0 + s - 1, y + 7, z0 + 2, C.leafMid); g.set(x0 + 2, y + 3 + s, z0 + 1, C.leafLight);
}
function bush(g, x0, y, z0, x1, z1) { g.box(x0, y, z0, x1, y + 2, z1, C.bush); g.box(x0, y, z0, x1, y, z1, C.leafMid); }
// Chain-link style fence: posts every 4 + top rail.
function fenceX(g, x0, x1, y, z) { for (let x = x0; x <= x1; x++) { g.set(x, y + 3, z, C.metal); if ((x - x0) % 4 === 0) g.box(x, y, z, x, y + 3, z, C.metalDark); } }
function fenceZ(g, z0, z1, y, x) { for (let z = z0; z <= z1; z++) { g.set(x, y + 3, z, C.metal); if ((z - z0) % 4 === 0) g.box(x, y, z, x, y + 3, z, C.metalDark); } }

// Standard rooftop kit on a deck (keeps rooftops busy, never a bare slab).
function roofKit(g, x0, z0, x1, z1, y, rng) {
  acBox(g, x0 + 1, y, z1 - 5, { w: 6, d: 5, h: 4 });
  if (x1 - x0 > 14) acBox(g, x0 + 9, y, z1 - 5, { w: 5, d: 4, h: 3, body: C.indShade });
  ventPipe(g, x1 - 2, z0 + 2, y, y + 3);
  if (rng() < 0.6) ventPipe(g, x1 - 5, z0 + 2, y, y + 2, C.metalDark, C.darkGray);
}

// Trim the canvas height to the tallest voxel (keeps sy honest for the engine).
function fin(g) {
  let my = 0;
  for (const k of g.map.keys()) { const y = +k.split(',')[1]; if (y > my) my = y; }
  g.sy = my + 1;
  return g.done();
}


// ===========================================================================
// SHARED 1×1 WORKS — round 5. The r4 critic picked ref05 again: our plants were
// "plain white and grey boxes … the frame is filled with huge, garish
// block-letter signs"; ref05's industry has "long warehouse facades with rows
// of roll-up loading bays and trucks backed into them, rooftops covered in HVAC
// units, vents and skylight strips, glass curtain-wall office wings, pipe racks
// and catwalks linking the tanks, yards packed with crates and pallets", in a
// restrained grey-blue with orange only on stacks and trucks. So every works is
// now a functional grey-blue plant of one of two kinds; the theme is told by
// ONE small sign (1× letters on a white board), trailer / truck livery, tank
// paint and the goods in the yard — never by wall colour or giant words.
//   'dock'    hall x 2..21 (h 20): 3 dock bays under a canopy, trailers backed
//             in, pallets + forklift, sign over the canopy; roof = skylight
//             strips or a sawtooth + HVAC pads + stacks. Glass curtain-wall
//             office x 22..29 z 13..21 (h 26), a piped tank behind it, the
//             theme truck parked in front of it.
//   'process' hall x 2..18 (h 19): 2 dock bays + trailer, glass office wing
//             rising at its back-left; a bunded farm of 4 tanks (x 20..29)
//             with a top catwalk spine, ladders, a pipe rack into the hall;
//             a tanker under a loading gantry in front.
//   full      (warehouse) hall across the whole lot, 4 bays, office wing
//             rising at the back-right.
// T: kind text accent wall saw stacks stack{body,stripe,bands,bandH,gap}
//    stackH tank tank2 tankH trailers truck{cab,box,stripe,logo,tanker}
//    crates goods(p) extra(p) full h
// ===========================================================================
const WZ0 = 13, WZ1 = 28;                               // hall front / back walls
const WK = { dock: { hx1: 21, h: 20 }, process: { hx1: 18, h: 19 } };
// stack spots (voxel index) on the hall roof, per kind — shared with VENTS
const WSTACK = { dock: [[4, 25], [8, 25]], process: [[15, 25], [15, 19]] };
const W_STACK_H = 50;

// Small sign: white board, 1× letters inlaid flush in the accent colour
// (ref05's "POLICE STATION" / red "EPS" boards), 7 voxels tall.
// M and W get 5-wide glyphs (the 3-wide W reads as H: "POHER").
function tag(f, uc, y0, text, o = {}) {
  const s = String(text).toUpperCase(), adv = (ch) => (WIDE[ch] ? 6 : 4);
  const w = [...s].reduce((t, ch) => t + adv(ch), 0) - 1, pad = o.pad != null ? o.pad : 1;
  const u0 = Math.round(uc - (w + 2 * pad) / 2), u1 = u0 + w + 2 * pad - 1;
  // r11 (critic r10: "signage (DEPOT, MEGA, TOYS) is blurry, low-res voxel
  // text"): thin accent strokes on a white board lost to the grade and AA.
  // Reversed out now — a solid accent board with WHITE letters (ref05's blue
  // "STATION" board), the strongest value step the 1-voxel strokes can get.
  const inv = o.inv !== false, acc = o.fg != null ? o.fg : C.navy;
  const fg = inv ? C.signWhite : acc;
  // r7 (critic r6: signs "read as flat decals"): the board stands proud (out 2)
  // in a darker frame with an accent top rail and two stub brackets under it
  f.box(u0 - 1, y0 - 1, 1, u1 + 1, y0 + 7, 1, o.frame != null ? o.frame : C.indBase);
  f.box(u0 - 1, y0 + 7, 2, u1 + 1, y0 + 7, 2, inv ? C.indBase : fg);
  for (const u of [u0 + 1, u1 - 1]) f.box(u, y0 - 3, 1, u, y0 - 2, 2, C.indBase);
  f.box(u0, y0, 2, u1, y0 + 6, 2, o.bg != null ? o.bg : inv ? acc : C.signWhite);
  if (!inv) f.box(u0, y0, 2, u1, y0, 2, o.edge != null ? o.edge : C.indShade);
  const us = f.rd > 0 ? u0 + pad : u1 - pad;
  let col = 0;
  for (const ch of s) {
    if (WIDE[ch]) WIDE[ch].forEach((row, r) => { for (let i = 0; i < 5; i++) if (row[i] === '#') f.set(us + f.rd * (col + i), y0 + 5 - r, 2, fg); });
    else pixelText(f, us + f.rd * col, y0 + 1, ch, fg, 2);
    col += adv(ch);
  }
  return [u0, u1];
}
// Raised skylight strip: white frame, pale glass, a cross bar every 4.
function skyStrip(g, x0, z0, x1, z1, y) {
  g.box(x0, y, z0, x1, y, z1, C.white);
  for (let x = x0 + 1; x < x1; x++) if ((x - x0) % 4) for (let z = z0 + 1; z < z1; z++) g.set(x, y, z, C.winCool);
}
// HVAC unit on a light pad (ref05: every roof module carries one).
function hvacPad(g, x, y, z, w = 6, d = 5) {
  g.box(x, y, z, x + w - 1, y, z + d - 1, C.indShade);
  acBox(g, x + 1, y + 1, z + 1, { w: w - 2, d: d - 2, h: 3, body: C.indRoof, trim: C.black });
}
// Roof access hut with a door and a vent.
function roofHut(g, x, y, z) {
  g.box(x, y, z, x + 3, y + 4, z + 3, C.indShade);
  g.box(x, y + 5, z, x + 3, y + 5, z + 3, C.indBase);
  facade(g, 'front', z).box(x + 1, y, 0, x + 2, y + 3, 0, C.indBase);
}
// w2 r1 (coordinator 22:35, ref05 crop: "big BLUE GLASS curtain walls … strong
// value + hue contrast"): every pane is a saturated mid blue (dtGlass — civGlass
// graded to a pale blue-grey that read as wall), crossed by a pale diagonal
// reflection streak (dtGlassHi) with a deep blue foot row, set between DARK
// navy mullions and spandrels; the light concrete only frames the glass.
// A sprinkle of winCool panes lights at night.
function igl(u, y, foot) {
  const k = (((u - y) % 10) + 10) % 10;
  if (k === 0) return C.dtGlassHi;
  if (k < 3) return C.civGlass;
  if (foot) return C.dtGlassDeep;
  return ((u * 7 + y * 13) % 23) === 5 ? C.winCool : C.dtGlass;
}
// Glass curtain-wall block (ref05's blue office wings): a solid core, glass
// recessed one voxel between flush dark-navy mullions every 3, a navy spandrel
// per floor, light corner frames, dark base, white parapet. Glass only above
// `from` (a wing rising out of a hall roof).
function glassOffice(g, x0, z0, x1, z1, y0, h, o = {}) {
  const yT = y0 + h - 1, fl = o.floor || 5, from = Math.max(o.from != null ? o.from : 0, y0 + 2);
  const frame = C.indWall, mullC = C.dtGlassDeep;
  g.box(x0, y0, z0, x1, yT - 2, z1, o.core != null ? o.core : C.indShade);
  g.walls(x0, y0, z0, x1, y0 + 1, z1, C.indBase);
  g.walls(x0, yT - 1, z0, x1, yT - 1, z1, C.indWall);
  g.walls(x0, yT, z0, x1, yT, z1, C.white);
  g.box(x0 + 1, yT - 2, z0 + 1, x1 - 1, yT - 2, z1 - 1, C.indYard);
  for (const side of (o.sides || ['front', 'back', 'left', 'right'])) {
    const ax = side === 'front' || side === 'back';
    const f = facade(g, side, { front: z0, back: z1, left: x0, right: x1 }[side]);
    const a = ax ? x0 : z0, b = ax ? x1 : z1;
    for (let u = a + 1; u < b; u++) {
      const mul = (u - a) % 4 === 0 && u < b - 1;
      for (let y = from; y <= yT - 3; y++) {
        const r = (y - y0 - 2) % fl;
        if (r === fl - 1) { f.set(u, y, 0, C.dtNavyPanel); continue; }
        f.set(u, y, 0, mul ? mullC : igl(u, y, r === 0));
      }
    }
    f.box(a, from, 0, a, yT - 2, 0, frame); f.box(b, from, 0, b, yT - 2, 0, frame);
    f.box(a, yT - 2, 0, b, yT - 2, 0, frame);
  }
  return yT - 1;
}
// Tall glazed bays between proud pilasters (ref05's warehouse long faces):
// a pilaster every `pitch`, a 4-wide recessed glass strip in each bay from y0
// to y1 with a dark navy transom every 4 rows.
function glazeBays(f, u0, u1, y0, y1, pitch = 5, skip = [], pc = C.indWall) {
  for (let u = u0; u <= u1; u += pitch) {
    f.box(u, y0 - 2, 1, u, y1 + 1, 1, pc);
    // r9 (critic r8: ref05's works have "glazed blue curtain-wall facades"):
    // 3 of every 5 columns are glass (was 2)
    // r12 (critic r11: ref05's "blue glass curtain walls"): 4 of every 5 columns glass
    const a = pitch >= 5 ? u + 1 : u + 2, b = pitch >= 5 ? u + 4 : u + 3;
    if (b >= u1 || skip.some(([s0, s1]) => b >= s0 && a <= s1)) continue;
    for (let uu = a; uu <= b; uu++) for (let y = y0; y <= y1; y++) {
      const r = (y - y0) % 4;
      if (r === 3) { f.set(uu, y, 0, C.dtGlassDeep); continue; }
      f.del(uu, y, 0);
      f.set(uu, y, -1, igl(uu, y, r === 0));
    }
    f.box(a, y0 - 1, 1, b, y0 - 1, 1, C.white);
    f.box(a, y1 + 1, 0, b, y1 + 1, 0, C.dtNavyPanel);
  }
}
// r10: a continuous curtain-wall band (ref05's warehouse: blue glass between
// mullions, one per 3 voxels, a mid transom, white sill and head).
function curtainBand(f, u0, u1, y0, y1, o = {}) {
  const mull = C.dtGlassDeep, ym = y0 + ((y1 - y0) >> 1);
  f.box(u0 - 1, y0 - 1, 1, u1 + 1, y0 - 1, 1, C.white);
  f.box(u0 - 1, y1 + 1, 1, u1 + 1, y1 + 1, 1, o.mull != null ? o.mull : C.indWall);
  for (let u = u0; u <= u1; u++) {
    if ((u - u0) % 4 === 0 || u === u1) { f.box(u, y0, 0, u, y1, 0, mull); continue; }
    for (let y = y0; y <= y1; y++) f.set(u, y, 0, y === ym ? C.dtNavyPanel : igl(u, y, y === y0));
  }
}
// r7 cladding schemes (critic r6: "every factory sits on the same white-plinth-
// plus-white-box template … swap some of the all-white walls for darker steel,
// navy or corrugated grey"). wall = the sheet colour, pil = pilasters / ribs,
// seam = the horizontal panel joints painted on the bare wall.
const CLAD = {
  steel: () => ({ wall: C.indSteel, pil: C.indSteelDk, seam: C.indSteelDk }),
  navy: () => ({ wall: C.indNavy, pil: C.indNavyDk, seam: C.indNavyDk }),
  corr: () => ({ wall: C.indCorr, pil: C.indCorrDk, seam: C.indCorrDk }),
  white: () => ({ wall: C.indWall, pil: C.indShade, seam: C.indShade }),
  concrete: () => ({ wall: C.indCorr, pil: C.indWall, seam: C.indShade }),
  // r11 (critic r10: "the industrial buildings share one grey-blue palette with
  // orange accents, so the factories look too alike"): warm families borrowed
  // from the shared palette — terracotta brick, limestone cream, sage.
  brick: () => ({ wall: C.resTerracotta, pil: C.resTerraTrim, seam: C.resTerraTrim }),
  cream: () => ({ wall: C.dtLime, pil: C.dtLimeShade, seam: C.dtLimeShade }),
  sage: () => ({ wall: C.resSage, pil: C.resTileGreenDk, seam: C.resTileGreenDk }),
};
// Horizontal panel joints on a hall's bare wall voxels (only where the wall
// colour still shows, so glazing / doors / signs are untouched): a flush seam
// course every `every` rows — reads as big cladding sheets, not per-voxel grid.
function gget(g, x, y, z) {
  if (g.rot180) { x = g.sx - 1 - Math.round(x); z = g.sz - 1 - Math.round(z); }
  return g.map.get(Math.round(x) + ',' + y + ',' + Math.round(z));
}
function panelSeams(g, x0, z0, x1, z1, y0, y1, wall, seam, every = 6) {
  for (let y = y0 + every; y < y1; y += every) {
    for (let x = x0; x <= x1; x++) for (const z of [z0, z1]) if (gget(g, x, y, z) === wall) g.set(x, y, z, seam);
    for (let z = z0; z <= z1; z++) for (const x of [x0, x1]) if (gget(g, x, y, z) === wall) g.set(x, y, z, seam);
  }
}
// Pipe run along a facade: two proud pipes (out 2) on brackets every 5, with a
// drop down to a pump skid on the ground at the u1 end (ref05: every process
// hall has piping on its walls linking it to the yard).
function wallPipes(f, u0, u1, y, yg, cols = [C.yellow, C.indShade]) {
  cols.forEach((c, i) => f.box(u0, y - i * 2, 2, u1, y - i * 2, 2, c));
  for (let u = u0; u <= u1; u += 5) f.box(u, y - cols.length * 2 + 1, 1, u, y + 1, 1, C.indBase);
  f.box(u1, yg + 2, 2, u1, y, 2, cols[0]);
  f.box(u1 - 1, yg, 2, u1 + 1, yg + 1, 4, C.indBase);
  f.box(u1 - 1, yg + 2, 3, u1 + 1, yg + 2, 4, C.indBlue);
}
// Crate / pallet yard: rows of pallets with 1–2 crate layers (ref05's yards).
function palletYard(g, x0, z0, x1, z1, y, cols, rng) {
  for (let x = x0; x + 2 <= x1; x += 4) for (let z = z0; z + 2 <= z1; z += 4) {
    const n = 1 + ((rng() * 2.4) | 0);
    crates(g, x, y, z, 3, 3, n, [cols[(x + z) % cols.length], cols[(x + z + 1) % cols.length]]);
  }
}

// Smooth tank farm (surf): 4 tanks on skirts, a catwalk spine along z across
// their tops with cross links + handrails, a caged ladder up the front end.
function surfTankFarm(M, g, sp) {
  const r = 2.1, top = g + sp.th;
  const pts = [[23.2, 17, sp.tk], [27.6, 17, sp.tk2], [23.2, 25, sp.tk2], [27.6, 25, sp.tk]];
  for (const [cx, cz, t] of pts) surfSilo(M, cx, cz, g, r, sp.th, { legs: 1.4, seg: 32, hut: false, coneH: 1.1, tip: 0.6, ladderA: Math.PI, seam: false, cage: false, ...t });
  const yw = top + 0.3, xs = 25.4;
  M.box(xs - 0.45, yw, 14.2, xs + 0.45, yw + 0.3, 27.8, C.indBase);             // spine over the rims
  for (const [cx, cz] of pts) M.box(cx - 0.5, top + 1.1, cz - 0.5, cx + 0.5, top + 1.9, cz + 0.5, C.indShade);   // roof hatches
  for (const s of [-1, 1]) {
    M.beam([xs + s * 0.45, yw + 1.1, 14.2], [xs + s * 0.45, yw + 1.1, 27.8], 0.14, C.yellow);
    for (let z = 14.4; z <= 27.8; z += 2.7) M.beam([xs + s * 0.45, yw + 0.3, z], [xs + s * 0.45, yw + 1.1, z], 0.12, C.yellow);
  }
  // ladder + cage hoops up the spine's front end, a landing
  M.beam([xs, g, 14.0], [xs, yw, 14.0], 0.35, C.indBase);
  for (let y = g + 4; y < yw - 1; y += 2.5) M.lathe(xs, 13.8, () => 0.55, y, y + 0.18, 1, C.yellow, { seg: 8 });
  M.box(xs - 1, yw, 13.4, xs + 1, yw + 0.3, 14.6, C.indBase);
}

// Box trailer (no tractor): ref05's parked orange trailers. len along axis;
// a=0 is the nose (landing legs), wheels at the rear, doors at a = len-1.
function trailer(g, x0, y, z0, axis, dir, len, c, o = {}) {
  const W = o.w || 5, P = lf(g, x0, y, z0, axis, dir, len);
  for (const a of [len - 4, len - 3]) { P.box(a, 0, 0, a, 1, 0, C.black); P.box(a, 0, W - 1, a, 1, W - 1, C.black); }
  P.box(1, 0, 1, 1, 1, 1, C.indBase); P.box(1, 0, W - 2, 1, 1, W - 2, C.indBase);   // landing legs
  P.box(0, 2, 0, len - 1, 8, W - 1, c);
  P.box(0, 2, 0, len - 1, 2, W - 1, C.darkGray);                                   // chassis rail
  P.box(0, 7, 0, len - 1, 7, W - 1, o.stripe != null ? o.stripe : C.white);
  P.box(0, 8, 0, len - 1, 8, W - 1, o.roof != null ? o.roof : C.indWall);
  P.box(len - 1, 3, 1, len - 1, 6, W - 2, C.indShade);                            // rear doors
  P.set(len - 1, 3, 0, C.red); P.set(len - 1, 3, W - 1, C.red);
}
// r6 roof forms for the 1×1 works. A barrel vault (ribbed, light) or a slate
// gable spanning the hall x0..x1 (axis along x) inside its parapet, with
// white end fascias and a glazed lunette / vent in each gable end.
function shapedRoof(g, x0, z0, x1, z1, top, kind, accent) {
  const zc = (z0 + z1) / 2, half = (z1 - z0) / 2, Hr = kind === 'vault' ? 6 : 7;
  const prof = (z) => {
    const t = Math.abs(z - zc) / (half + 0.5);
    return Math.max(0, Math.round(kind === 'vault' ? Hr * Math.sqrt(Math.max(0, 1 - t * t)) : Hr * (1 - t)));
  };
  for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) {
    const yv = prof(z);
    const end = x === x0 + 1 || x === x1 - 1;
    const rib = kind === 'vault' && (x - x0) % 5 === 0;
    for (let y = top; y <= top + yv; y++) {
      let c = kind === 'vault' ? C.indRoofLt : C.indRoof;
      if (y === top + yv) c = rib ? C.white : kind === 'gable' && Math.abs(z - zc) < 1 ? C.indWall : c;
      if (end) c = y >= top + yv - 1 ? C.white : kind === 'vault' ? C.civGlass : C.indWall;
      g.set(x, y, z, c);
    }
  }
  // gable ends: an accent band + vent / lunette mullions
  for (const x of [x0 + 1, x1 - 1]) {
    for (let z = z0 + 2; z <= z1 - 2; z++) g.set(x, top, z, accent);
    for (let z = Math.ceil(zc) - 2; z <= Math.floor(zc) + 2; z += 2) for (let y = top + 1; y < top + prof(z) - 1; y++) g.set(x, y, z, C.white);
  }
  if (kind === 'gable') for (let x = x0 + 4; x <= x1 - 4; x += 5) { g.box(x, top + Hr + 1, Math.floor(zc), x + 1, top + Hr + 2, Math.ceil(zc), C.indShade); g.set(x, top + Hr + 3, Math.floor(zc), C.indBase); }
}
// Tall hopper / mill tower at the hall's back-left with an inclined conveyor
// gallery running down to the roof (flour for the bakery, sorting for ECO).
function hopperTower(g, top, accent, o = {}) {
  const x0 = 3, x1 = 8, z0 = 21, z1 = 27, ht = o.h || 22, yt = top + ht;
  g.box(x0, top, z0, x1, yt, z1, o.wall != null ? o.wall : C.indWall);
  g.walls(x0, yt - 3, z0, x1, yt - 3, z1, accent);
  g.walls(x0 - 1, yt + 1, z0 - 1, x1 + 1, yt + 1, z1 + 1, C.white);
  g.box(x0, yt + 1, z0, x1, yt + 1, z1, C.indRoofLt);
  for (let y = top + 3; y < yt - 5; y += 5) {
    for (let z = z0 + 1; z < z1; z += 2) g.set(x0 - 0, y, z, C.civGlass), g.set(x0, y + 1, z, C.civGlass);
    for (let x = x0 + 1; x < x1; x += 2) g.set(x, y, z0, C.civGlass), g.set(x, y + 1, z0, C.civGlass);
    g.walls(x0, y + 3, z0, x1, y + 3, z1, C.indShade);
  }
  g.box(x0 + 1, yt + 2, z0 + 2, x0 + 3, yt + 4, z0 + 4, C.indShade); g.set(x1 - 1, yt + 2, z1 - 1, C.metalDark); g.set(x1 - 1, yt + 3, z1 - 1, C.metalDark);
  // conveyor gallery: 3-wide box stepping down from the tower to the roof
  const zc = 23, a0 = x1 + 1, a1 = x1 + 10;
  for (let x = a0; x <= a1; x++) {
    const y = Math.round(yt - 4 - (x - a0) * (ht - 7) / (a1 - a0));
    g.box(x, y, zc, x, y + 2, zc + 2, C.indShade);
    g.set(x, y + 2, zc + 1, C.indWall); g.set(x, y + 1, zc, x & 1 ? C.civGlass : C.indShade); g.set(x, y + 1, zc + 2, x & 1 ? C.civGlass : C.indShade);
    if ((x - a0) % 4 === 3) g.box(x, top, zc + 1, x, y - 1, zc + 1, C.indBase);
  }
  g.box(a1 + 1, top, zc - 1, a1 + 3, top + 3, zc + 3, accent);
}
// Yellow portal gantry crane over the truck yard (a big, readable silhouette).
function gantryCrane(g, y0, o = {}) {
  const xa = o.x0 != null ? o.x0 : 1, xb = o.x1 != null ? o.x1 : 21, za = 2, zb = 9, yt = y0 + (o.h || 17);
  for (const x of [xa, xb]) {
    for (const z of [za, zb]) { g.box(x, y0, z, x, yt, z, C.yellow); g.set(x, y0, z, C.darkGray); }
    g.box(x, y0 + 1, za, x, y0 + 1, zb, C.darkGray);                       // bogie beam
    for (let k = 0; k < 4; k++) g.set(x, yt - 1 - k, za + 1 + k, C.yellow);   // knee braces
  }
  g.box(xa, yt + 1, za, xb, yt + 2, za + 1, C.yellow); g.box(xa, yt + 1, zb - 1, xb, yt + 2, zb, C.yellow);
  for (let x = xa; x <= xb; x += 2) g.set(x, yt + 1, za + 1, C.black), g.set(x + 1, yt + 1, zb - 1, C.black);
  const tx = Math.round((xa + xb) / 2) + (o.t || 0);
  g.box(tx - 1, yt + 1, za + 2, tx + 2, yt + 3, zb - 2, C.orange);            // trolley + cab
  g.box(tx - 1, yt - 1, za + 2, tx, yt, za + 3, C.orange); g.set(tx - 1, yt, za + 2, C.civGlass);
  for (let y = y0 + 11; y <= yt; y++) g.set(tx + 1, y, za + 4, C.metalDark);   // hoist rope
  g.box(tx, y0 + 9, za + 3, tx + 2, y0 + 10, za + 5, C.darkGray);               // hook block
  if (o.load) { g.box(tx, y0 + 6, za + 3, tx + 2, y0 + 8, za + 5, o.load); g.box(tx, y0 + 8, za + 3, tx + 2, y0 + 8, za + 5, C.indShade); }   // a crate on the hook (w2 r1: was a 5-cube toy block)
}

function works(rng, T = {}) {
  const S = 31, kind = T.kind || 'dock', proc = kind === 'process', full = !!T.full;
  const accent = T.accent != null ? T.accent : C.indBlue;
  const h = T.h || WK[kind].h, hx1 = full ? 29 : WK[kind].hx1;
  const nst = T.stacks != null ? T.stacks : 1;
  const stk = Object.assign({ body: C.white, stripe: C.orange, bands: 2, bandH: 3, gap: 3 }, T.stack || {});   // r12: white/orange → surfStack's bronze style
  const spec = {
    kind, h, hx1, full, nst, stk, stackH: T.stackH || W_STACK_H,
    tk: T.tank || { c: C.indTank, band: accent }, tk2: T.tank2 || T.tank || { c: C.indTank, band: accent },
    th: T.tankH || 18, saw: !!T.saw, text: T.text || '', fg: T.signFg != null ? T.signFg : accent,
    silo: !proc && !full && !T.hopper,
    roofK: T.roof || (T.saw ? 'saw' : 'flat'), clad: T.clad || 'concrete', hop: T.hopper ? T.hopper.h || 22 : 0,
    trl: T.trailers || null, trk: T.truck || null,               // r9: yard vehicles live in the fine part
  };
  const H = hiRes(S, 160, 'works:' + JSON.stringify(spec), false), g = H.g;
  const y0 = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: C.indPave });
  const yl = y0 - 1;
  const cl = CLAD[T.clad || 'concrete'](), wall = cl.wall;   // r7: steel / navy / corrugated cladding
  // r10 (critic r9: pale boxes with thin accent pinstripes): no pinstripe band,
  // a dark slate roof deck under the light rooftop plant (ref05's value contrast)
  const top = hall(g, 2, WZ0, hx1, WZ1, y0, h, { wall, trim: cl.pil, roof: C.indYard, base: C.indBase });
  const F = facade(g, 'front', WZ0), L = facade(g, 'left', 2), B = facade(g, 'back', WZ1), Rt = facade(g, 'right', hx1);
  const p = { g, H, y0, yl, top, h, hx1, F, L, B, Rt, accent, rng, T, kind, cl };
  // free yard in front of the loading bay nobody is backed onto (theme goods)
  [p.gx0, p.gz0, p.gx1, p.gz1] = proc ? [10, 6, 18, 9] : [15, 6, 19, 9];

  // ---- truck yard: bay lines, a yellow lane, recessed dock (r10) ----
  // r10 (critic r9: "lots are mostly loose clutter, with no clear dock or yard
  // layout"): the dock bays are real recesses cut into the hall front with
  // trucks backed into them, the yard in front is kept clear — striped bays,
  // a dashed lane, the forklift and the theme goods at the free bay only.
  g.box(1, yl, 1, 29, yl, WZ0 - 1, C.lotAsphalt);   // r12: near-black asphalt truck yard (ref05)
  const bays = proc ? [3, 10] : full ? [3, 9, 15, 21] : [3, 9, 15];
  for (const u of bays) for (let z = 5; z <= WZ0 - 1; z++) { g.set(u - 1, yl, z, C.lotLine); g.set(u + 5, yl, z, C.lotLine); }
  for (let x = 1; x <= 29; x++) if (x % 4 < 2) g.set(x, yl, 3, C.indLine);
  const RD = 3;
  for (const u of bays) {
    F.clear(u, y0, -(RD - 1), u + 4, y0 + 7, 0);
    F.box(u - 1, y0, -RD, u - 1, y0 + 8, -1, C.indBase); F.box(u + 5, y0, -RD, u + 5, y0 + 8, -1, C.indBase);
    F.box(u, y0 + 8, -RD, u + 4, y0 + 8, -1, C.indYard);                         // soffit
    F.box(u, y0, -RD, u + 4, y0 + 3, -RD, C.darkGray);                           // open: dark interior
    for (let y = y0 + 4; y <= y0 + 7; y++) F.box(u, y, -RD, u + 4, y, -RD, (y - y0) & 1 ? C.indShade : C.indWall);
    F.box(u, yl, -(RD - 1), u + 4, yl, 1, C.lotAsphalt);                          // drive well
    for (const x of [u - 1, u + 5]) { F.box(x, y0, 1, x, y0 + 7, 1, C.black); F.set(x, y0 + 1, 2, C.yellow); }
    F.set(u + 2, y0 + 9, 1, C.lamp);
  }
  const lastU = bays[bays.length - 1] + 6;
  if (lastU + 3 <= hx1) door(F, lastU + 1, y0 + 3, 2, 7, { color: accent, frame: C.white, step: null });
  // w2 r1 (coordinator 22:35: "big BLUE GLASS curtain walls on office/hall
  // fronts"): a continuous glass band across the hall front over the dock
  // canopy; the sign board stands proud of it
  curtainBand(F, 3, hx1 - 1, y0 + 13, y0 + h - 3);
  g.box(2, y0 + 12, WZ0 - 3, hx1, y0 + 12, WZ0 - 1, C.indRoof);                   // dock canopy
  g.box(2, y0 + 11, WZ0 - 3, hx1, y0 + 12, WZ0 - 3, C.indWall);                   // its fascia
  for (let x = 2; x <= hx1; x += 6) g.box(x, y0 + 11, WZ0 - 1, x, y0 + 11, WZ0 - 2, C.indBase); // brackets
  // the sign lives in the res-8 part: 1× letters there are HALF the size of
  // res-4 ones (r4 critic: "shrink the signs"), front over the canopy + back
  if (T.text) H.fine((Fg) => {
    tag(facade(Fg, 'front', 2 * WZ0), hx1 + 3, 2 * y0 + 28, T.text, { fg: spec.fg });
    if (!proc) tag(facade(Fg, 'back', 2 * WZ1 + 1), (full ? 21 : hx1) + 3, 2 * (y0 + h) - 10, T.text, { fg: spec.fg });
  });

  // ---- trailers backed onto the bays, pallets + forklift at a free bay ----
  const tcol = T.trailers || [C.orange, C.white, C.orange];
  const used = proc ? [0] : full ? [0, 1, 3] : [0, 1];
  used.forEach((i, k) => { const c = tcol[k % tcol.length]; fTruck(H, bays[i] + 1, y0, WZ0 - 6.5, 'z', 1, { len: 16, cab: k & 1 ? accent : C.white, box: c, stripe: c === C.white ? accent : C.white, logo: c === C.white ? accent : C.white }); });
  const fb = bays[proc ? 1 : 2];
  crates(g, fb, y0, WZ0 + 1, 2, 2, 2, T.crates || [C.wood, C.plank]);             // pallets inside the free bay
  crates(g, fb + 3, y0, WZ0 + 1, 2, 2, 1, [C.indBlue]);
  fForklift(H, fb, y0, 4, 'x', 1);
  if (T.goods) T.goods(p);
  // r12: no default pallet heap in the yard — the stalls stay quiet

  // ---- hall sides + back: clerestory glazing, pilasters, downpipes, doors ----
  if (!proc) glazeBays(L, WZ0 + 1, WZ1, y0 + 4, y0 + h - 6, 5, [], cl.pil);
  else { glazeBays(L, WZ0 + 1, 21, y0 + 4, y0 + h - 6, 5, [], cl.pil); }
  const bx1 = proc ? hx1 : full ? 21 : hx1;
  const bx0 = proc ? 10 : 2;
  rollDoor(B, bx0 + 2, bx0 + 6, y0, 9, { hood: C.indRoof, color: C.indWall, slat: C.indShade, frame: C.indBase });
  if (bx1 - 2 >= bx0 + 9) glazeBays(B, bx0 + 9, bx1, y0 + 4, y0 + h - 7, 5, [], cl.pil);
  for (let x = bx0 + 9; x <= bx1 - 2; x += 4) crates(g, x, y0, WZ1 + 1, 2, 1, 1, T.crates || [C.wood, C.plank]);

  // ---- roof: skylights or sawtooth up front, HVAC pads + stacks at the back ----
  const rx0 = 3, rx1 = hx1 - 1;
  const zm = WZ0 + 7;
  // r6 (critic r5: the 1×1 works were "near-identical white boxes that differ
  // only in sign colour"): the roof FORM varies by theme — flat + skylights,
  // sawtooth, a barrel vault or a slate gable — so silhouettes differ.
  const roofK = T.roof || (T.saw ? 'saw' : 'flat');
  if (roofK === 'vault' || roofK === 'gable') shapedRoof(g, proc ? 10 : 2, WZ0, hx1, WZ1, top, roofK, accent);
  else {
    if (roofK === 'saw') sawtooth(g, rx0, rx1, WZ0 + 1, zm, top, { D: 4, H: 3, roof: C.indRoofLt, glass: C.civGlass });
    else skyStrip(g, rx0 + 1, WZ0 + 2, rx1 - 1, WZ0 + 4, top);
    let pads = [];
    if (proc) pads = [];                              // r8: the fine roof plant fills it
    else if (full) pads = [];
    else pads = nst > 1 ? [[11, 6]] : nst ? [[8, 6], [15, 6]] : [[4, 6], [11, 6]];
    if (spec.silo) pads = nst ? [[16, 5]] : [[3, 6], [16, 5]];
    if (T.hopper) pads = [[11, 6]];
    for (const [x, w] of pads) hvacPad(g, x, top, zm + 2, w, 5);
    if (!proc && !full && !spec.silo) { ventPipe(g, 19, zm + 2, top, top + 3); ventPipe(g, 19, WZ1 - 2, top, top + 2, C.metalDark, C.darkGray); }
    if (spec.silo) { ventPipe(g, 20, WZ1 - 1, top, top + 3); acBox(g, 16, top, WZ1 - 1 - 1, { w: 3, d: 2, h: 2, body: C.indShade }); }
    if (full) roofHut(g, 4, top, zm + 2);
    if (proc && nst < 2) { ventPipe(g, 16, zm + 7, top, top + 3); }
  }
  if (T.hopper) hopperTower(g, top, accent, { wall: T.clad === 'navy' || T.clad === 'steel' ? C.indCorr : C.indWall, ...T.hopper });
  if (T.crane) gantryCrane(g, y0, T.crane);
  const spots = WSTACK[kind].slice(0, nst);
  if (spots.length) H.surf((M) => { for (const [x, z] of spots) surfStack(M, x + 0.5, z + 0.5, top, 1.8, spec.stackH, stk); });
  panelSeams(g, 2, WZ0, hx1, WZ1, y0 + 2, y0 + h - 4, wall, cl.seam, 5);
  // r8 (critic r7: MILK / ART / POP / DEPOT / ECO were "big clean boxes: flat
  // grey roofs with a few AC cubes, long bare wall faces"): a dense fine-scale
  // roof plant over every free bit of deck, fans along vault / gable ridges,
  // and downpipes, pipe runs, AC boxes and a ladder on the side + back walls
  H.fine((Fg) => {
    if (roofK === 'gable') { /* ridge vents are in the base */ } else if (roofK === 'vault') {
      const hx0 = proc ? 10 : 2, zc = (WZ0 + WZ1) / 2, ry = top + 7;
      for (let x = hx0 + 3; x + 3 <= hx1 - 2; x += 5) {
        fineItem(Fg, 2 * x, Math.round(2 * zc) - 3, 6, 6, 2 * ry, (x & 1) ? 'fan' : 'vents', srng(x * 31 + hx1), { accent, pad: C.indBase });
      }
    } else fineRoof(Fg, g, rx0, WZ0 + 1, rx1, WZ1 - 1, top, { accent, seed: spec.text.length });
    const skipB = [[bx0 + 1, bx0 + 7]];
    fineWall(Fg, 'left', 2, WZ0, proc ? 20 : WZ1, y0, top - 1, { ac: 1, pc: accent === C.indBlue ? C.yellow : accent, ladder: !proc });
    fineWall(Fg, 'back', WZ1, proc ? bx0 : 2, bx1, y0, top - 1, { ac: 1, skip: skipB, ladder: false, pipe: bx1 - bx0 > 12 });
  });

  if (full) {
    // warehouse: a glass office wing rising out of the hall's back-right
    const ot = glassOffice(g, 22, 21, 29, 28, y0, h + 6, { from: top, mull: cl.seam, core: cl.wall });
    hvacPad(g, 23, ot, 22, 5, 4); g.box(28, ot, 27, 28, ot + 6, 27, C.metalDark);
    H.fine((Fg) => fineRoof(Fg, g, 23, 22, 28, 27, ot, { accent, kinds: ['cond', 'fan', 'vents', 'wtank'] }));
    ribbon(Rt, WZ0 + 2, 19, y0 + 12, 3, { glass: C.dtGlass, frame: C.indWall });
    door(Rt, 16, y0, 3, 7, { color: accent, frame: C.white, step: C.indShade });
    if (T.extra) T.extra(p);
    yardFill(g, y0, rng, { maxL: 10, skip: [[1, 1, 29, WZ0 - 1]] });
    return p;
  }
  if (!proc) {
    // ---- glass office (front right) + a piped process tank behind it ----
    const ot = glassOffice(g, 22, WZ0, 29, 21, y0, 26, { mull: cl.seam, core: cl.wall });
    door(facade(g, 'front', WZ0), 24, y0, 3, 7, { color: C.civGlass, frame: C.white, glass: C.winCool, step: C.indShade, canopy: accent });
    hvacPad(g, 23, ot, 14, 5, 4);
    g.box(28, ot, 19, 28, ot + 7, 19, C.metalDark); g.set(28, ot + 8, 19, C.red);
    H.fine((Fg) => fineRoof(Fg, g, 23, WZ0 + 1, 28, 20, ot, { accent, kinds: ['cond', 'fan', 'vents', 'wtank', 'tank'] }));
    for (const x of [22, 23, 27, 28, 29]) { g.set(x, y0, WZ0 - 1, C.leafMid); g.set(x, y0 + 1, WZ0 - 1, C.bush); }
    g.box(22, yl, 23, 29, yl, 29, C.indShade);
    if (spec.silo) {
      // r7 (critic r6: "link the buildings on each lot with pipe runs, catwalks
      // and conveyors"): the silo rises above the hall and an enclosed conveyor
      // gallery climbs to it from a head-house on the hall roof
      const hh = top + 6;
      g.box(11, top, 22, 15, hh, 27, wall);
      g.walls(11, hh, 22, 15, hh, 27, C.white); g.box(12, hh, 23, 14, hh, 26, C.indRoofLt);
      for (let z = 23; z <= 26; z += 3) g.box(11, top + 2, z, 11, top + 3, z + 1, C.civGlass);
      g.box(12, top + 2, 22, 14, top + 3, 22, C.civGlass);
      g.box(13, hh + 1, 24, 13, hh + 3, 24, C.metalDark);
      const ya = top + 2, yb = y0 + 23;
      for (let x = 16; x <= 23; x++) {
        const y = Math.round(ya + (x - 16) * (yb - ya) / 7);
        g.box(x, y, 24, x, y + 2, 26, C.indShade);
        g.box(x, y + 3, 24, x, y + 3, 26, C.indWall);
        if (x & 1) { g.set(x, y + 1, 24, C.civGlass); g.set(x, y + 1, 26, C.civGlass); }
        g.box(x, y - 1, 25, x, y - 1, 25, C.indBase);
      }
      g.box(22, y0, 25, 22, y0 + 20, 25, C.indBase); g.box(22, y0, 25, 22, y0 + 1, 25, C.yellow);   // trestle
    }
    H.surf((M) => {
      surfSilo(M, 26, 26, y0, 2.6, spec.silo ? 25 : 13, { legs: 1.4, seg: 32, hut: false, coneH: 1.2, tip: 0.6, ladderA: Math.PI, seam: false, ribs: spec.silo, ...spec.tk });
      M.beam([hx1 + 1, y0 + 8.5, 24.5], [23.6, y0 + 8.5, 24.5], 0.7, C.indShade);
      M.beam([23.9, y0 + 8.5, 24.5], [23.9, y0, 24.5], 0.5, C.indBase);
    });
    ribbon(Rt, 23, WZ1 - 1, y0 + 12, 3, { glass: C.dtGlass, frame: C.indWall });
    // theme truck parked in front of the office (or the theme's own lot)
    const tk = T.truck || { cab: C.white, box: accent, stripe: C.white };
    g.box(22, yl, 1, 29, yl, 10, C.lotAsphalt);
    for (let z = 1; z <= 10; z++) g.set(29, yl, z, C.lotLine);
    if (T.lot) T.lot(p);
    else if (tk.tanker) fTanker(H, 24, y0, 2, 'z', 1, { ...tk, len: 16 });
    else fTruck(H, 24, y0, 2, 'z', 1, { ...tk, len: 16 });
  } else {
    // ---- office wing rising at the hall's back-left ----
    const ot = glassOffice(g, 2, 21, 9, WZ1, y0, h + 7, { from: top, mull: cl.seam, core: cl.wall });
    hvacPad(g, 3, ot, 22, 5, 4); g.box(8, ot, 27, 8, ot + 6, 27, C.metalDark); g.set(8, ot + 7, 27, C.red);
    H.fine((Fg) => fineRoof(Fg, g, 3, 22, 8, 27, ot, { accent, kinds: ['cond', 'fan', 'vents', 'wtank'] }));
    // ---- bunded tank farm, pipe rack into the hall ----
    g.box(20, yl, WZ0, 29, yl, 29, C.indShade);
    g.walls(20, y0, WZ0, 29, y0, 29, C.indBase);
    g.box(19, y0 + 10, WZ0 + 1, 20, y0 + 11, WZ1, C.yellow);                        // pipe rack
    for (let z = WZ0 + 2; z <= WZ1; z += 5) { g.box(19, y0, z, 19, y0 + 9, z, C.indBase); g.set(19, y0 + 12, z, C.indBase); }
    Rt.box(WZ0 + 3, y0 + 9, 1, WZ0 + 3, y0 + 12, 1, C.indBase);
    ribbon(Rt, WZ0 + 6, WZ1 - 2, y0 + 13, 3, { glass: C.dtGlass, frame: C.indWall });
    H.surf((M) => {
      surfTankFarm(M, y0, spec);
      for (const cz of [17, 25]) M.beam([21.2, y0 + 10.5, cz], [20.9, y0 + 10.5, cz], 0.6, C.indShade);
      M.beam([22.3, y0, 13.6], [22.3, y0 + 14.6, 13.6], 0.6, C.indShade);           // fill line to the gantry
      M.beam([22.3, y0 + 14.6, 13.9], [22.3, y0 + 14.6, 6.5], 0.6, C.indShade);
    });
    // ---- tanker under a loading gantry ----
    const tk = T.truck || { tanker: true, cab: accent, tank: C.indTank, band: accent };
    g.box(20, yl, 1, 29, yl, WZ0 - 1, C.lotAsphalt);
    for (let z = 1; z <= 11; z++) { g.set(21, yl, z, C.lotLine); g.set(28, yl, z, C.lotLine); }
    if (tk.tanker) fTanker(H, 23.5, y0, 2, 'z', 1, { ...tk, len: 18 });
    else fTruck(H, 23.5, y0, 2, 'z', 1, { ...tk, len: 18 });
    // w2 r1: a tanker LOADING RACK (was an empty portal frame that read as a
    // bare blue-grey box in every process lot): a steel tower on the yard's
    // left edge, a railed platform, a charcoal canopy over it only, a riser
    // manifold down to a pump skid and two yellow loading arms dropped onto
    // the tanker's hatches
    for (const x of [20, 22]) for (const z of [4, 10]) g.box(x, y0, z, x, y0 + 12, z, C.indBase);
    for (const x of [20, 22]) for (const z of [4, 10]) g.box(x, y0, z, x, y0 + 1, z, C.yellow);
    g.box(20, y0 + 8, 4, 22, y0 + 8, 10, C.indShade);                                // platform deck
    for (let z = 4; z <= 10; z++) g.set(22, y0 + 10, z, C.yellow);                  // handrail
    g.box(20, y0 + 13, 3, 24, y0 + 13, 11, C.indRoof);                              // canopy
    g.walls(20, y0 + 13, 3, 24, y0 + 13, 11, C.indWall);
    g.box(21, y0, 5, 21, y0 + 7, 5, C.yellow); g.box(21, y0, 7, 21, y0 + 7, 7, C.indBlue);   // risers
    g.box(20, y0, 5, 21, y0 + 1, 8, C.indBase); g.box(20, y0 + 2, 6, 20, y0 + 2, 7, C.indBlue);   // pump skid
    for (const z of [5, 8]) {
      g.box(22, y0 + 9, z, 24, y0 + 9, z, C.yellow);                                 // arm over the tanker
      g.box(24, y0 + 6, z, 24, y0 + 8, z, C.yellow);                                 // drop to the hatch
    }
    for (let y = y0 + 1; y <= y0 + 7; y += 2) g.box(19, y, 9, 19, y, 10, C.indBase);  // stair treads
    bollard(g, 19, y0, 2); bollard(g, 28, y0, 2); bollard(g, 28, y0, 11);
  }
  if (T.extra) T.extra(p);
  yardFill(g, y0, rng, { maxL: 10, skip: [[1, 1, proc ? 19 : hx1, WZ0 - 1]] });   // r7: no bare paving; r10: truck yard stays clear
  return p;
}

// ===========================================================================
// ZONED INDUSTRIAL GROWTH (level 1..3)
// ===========================================================================
export function industrial(level, rng) {
  const accent = pk(rng, [C.indBlue, C.orange, C.red, C.teal, C.roofGreen]);
  const kind = level === 2 ? pk(rng, ['dock', 'process']) : level >= 3 ? 'process' : 'dock';
  const p = works(rng, {
    kind, accent, clad: pk(rng, ['steel', 'navy', 'corr', 'concrete', 'brick', 'cream']), roof: pk(rng, ['flat', 'saw', 'saw', 'vault', 'gable']),
    stacks: level === 1 ? 0 : level === 2 ? 1 : 2, h: level === 1 ? 16 : undefined,
    trailers: [pk(rng, [C.orange, C.white]), pk(rng, [C.white, C.indBlue, C.orange])],
    truck: kind === 'process' ? { tanker: true, cab: accent, tank: C.indTank, band: accent } : { cab: C.white, box: pk(rng, [C.orange, C.indBlue, C.white]), stripe: accent },
  });
  return p.H.done();
}

// ===========================================================================
// THEMED WORKS — the shared works + a theme told by a small sign, trailer and
// truck liveries, tank paint and the goods in the yard.
// ===========================================================================
function bToyFactory(rng) {
  const p = works(rng, {
    kind: 'dock', accent: C.red, text: 'TOYS', clad: 'navy', stacks: 0, roof: 'vault',
    trailers: [C.red, C.white], truck: { cab: C.white, box: C.yellow, stripe: C.red, logo: C.red },
    tank: { c: C.indTank, band: C.red, top: C.yellow },
    goods: (q) => {                                   // gift boxes on pallets
      const { g, y0 } = q;
      gift(g, 15, y0, 6, 3, C.red, C.yellow); gift(g, 18, y0, 7, 2, C.indBlue, C.yellow); gift(g, 15, y0 + 3, 7, 2, C.roofGreen, C.red);
    },
  });
  return p.H.done();
}

function bChocolate(rng) {
  const p = works(rng, {
    kind: 'process', accent: C.indChoco, text: 'CHOCO', clad: 'brick', signFg: C.indChoco, stacks: 1, roof: 'gable',
    stack: { body: C.brick, stripe: C.indChoco, bands: 1, bandH: 2.5 },          // r12: cocoa-brick flue (was a candy cane)
    tank: { c: C.indChocoLt, band: C.pink, top: C.indChoco }, tank2: { c: C.cream, band: C.indChoco, top: C.indChoco },
    trailers: [C.cream], truck: { tanker: true, cab: C.indChoco, tank: C.indChocoLt, band: C.pink }, crates: [C.indChoco, C.pink],
  });
  return p.H.done();
}

function bRobotFactory(rng) {
  const p = works(rng, {
    kind: 'dock', accent: C.orange, text: 'ROBOT', clad: 'steel', saw: true, stacks: 2,
    trailers: [C.orange, C.white], truck: { cab: C.indBlue, box: C.white, stripe: C.indBlue, logo: C.orange },
    goods: (q) => {                                   // orange robot arm lifting a crate
      const { g, y0 } = q, ax = 16, az = 7;
      g.box(ax - 1, y0, az - 1, ax + 2, y0, az + 2, C.darkGray);
      g.box(ax, y0 + 1, az, ax + 1, y0 + 6, az + 1, C.orange);
      for (let k = 0; k < 3; k++) g.box(ax + k, y0 + 6 + k, az, ax + k + 1, y0 + 7 + k, az + 1, C.orange);
      g.box(ax + 3, y0 + 5, az - 1, ax + 4, y0 + 8, az + 2, C.darkGray);
    },
  });
  return p.H.done();
}

function bRecycling(rng) {
  const p = works(rng, {
    kind: 'dock', accent: C.roofGreen, text: 'ECO', clad: 'sage', stacks: 0, hopper: { h: 18 },
    trailers: [C.roofGreen, C.white], truck: { cab: C.roofGreen, box: C.roofGreen, stripe: C.white, logo: C.white },
    tank: { c: C.indTank, band: C.roofGreen, top: C.roofGreen },
    goods: (q) => {                                   // bales of paper, cans and bottles
      const { g, y0 } = q;
      const bale = (x, y, z, c) => { g.box(x, y, z, x + 2, y + 2, z + 2, c); g.box(x, y + 1, z, x + 2, y + 1, z + 2, C.indShade); };
      bale(15, y0, 6, C.indBlue); bale(18, y0, 6, C.yellow); bale(16, y0 + 3, 6, C.roofGreen);
    },
  });
  return p.H.done();
}

function bCheese(rng) {
  const p = works(rng, {
    kind: 'process', accent: C.indBlue, text: 'MILK', clad: 'white', stacks: 0, tankH: 27,
    tank: { c: C.white, stripes: [[4.2, 3, C.indBlue]], top: C.indBlue }, tank2: { c: C.white, stripes: [[4.2, 3, C.indBlue], [8, 7, C.indBlue]], top: C.indBlue },
    trailers: [C.white], truck: { tanker: true, cab: C.indBlue, tank: C.indTank, band: C.indBlue }, crates: [C.gold, C.amber],
  });
  return p.H.done();
}

function bCrayon(rng) {
  const pal = [C.red, C.indBlue, C.roofGreen, C.yellow, C.purple, C.orange];
  const k = (rng() * 6) | 0;
  // tanks dressed as giant crayons: paper wrapper with black rings, coloured tip
  const cray = (c) => ({ c: C.signWhite, stripes: [[3, 1.4, c], [10, 9, C.black], [5, 4, C.black]], top: c, coneH: 2.4, tip: 0.5, tipC: c, rail: false });
  const p = works(rng, {
    kind: 'process', accent: C.purple, text: 'ART', clad: 'navy', stacks: 0, tankH: 18,
    tank: cray(pal[k % 6]), tank2: cray(pal[(k + 1) % 6]),
    trailers: [C.yellow], truck: { cab: C.white, box: C.signWhite, stripe: C.purple, logo: C.yellow }, crates: [C.red, C.indBlue, C.yellow],
  });
  return p.H.done();
}

function bBalloonFactory(rng) {
  const p = works(rng, {
    kind: 'process', accent: C.pink, text: 'POP!', clad: 'steel', stacks: 1, tankH: 16,
    tank: { c: C.indTank, band: C.pink, top: C.pink }, tank2: { c: C.indTank, band: C.skyBlue, top: C.skyBlue },
    trailers: [C.pink], truck: { cab: C.white, box: C.pink, stripe: C.white, logo: C.yellow },
    goods: (q) => {                                   // helium bottles + three balloons
      const { g, y0 } = q;
      gasBottles(g, 11, y0, 7, 3, C.pink); gasBottles(g, 11, y0, 9, 3, C.skyBlue);
      const cols = [C.red, C.yellow, C.indBlue];
      [[16, 14, 7], [18, 12, 8], [17, 16, 9]].forEach(([bx, by, bz], i) => {
        for (let dy = -1; dy <= 1; dy++) disc(g, bx, bz, dy === 0 ? 1.5 : 0.9, y0 + by + dy, cols[i]);
        for (let y = y0 + 5; y < y0 + by - 1; y++) g.set(bx, y, bz, C.signWhite);
      });
    },
  });
  return p.H.done();
}

function bCarFactory(rng) {
  const cc = [C.red, C.indBlue, C.yellow, C.teal, C.purple, C.orange, C.white, C.pink];
  let k = (rng() * 8) | 0;
  const p = works(rng, {
    kind: 'dock', accent: C.red, text: 'CARS', clad: 'steel', stacks: 2, roof: 'gable',
    trailers: [C.white, C.orange],
    lot: (q) => {                                     // brand-new cars lined up by the office
      for (let i = 0; i < 2; i++) car(q.g, 21, q.y0, 1 + i * 5, 'x', 1, cc[(k + i) % 8]);
    },
  });
  return p.H.done();
}

function bBakeryPlant(rng) {
  const p = works(rng, {
    kind: 'process', accent: C.pink, text: 'YUM', signFg: C.pink, stacks: 1, clad: 'cream', roof: 'vault',
    stack: { body: C.brick, stripe: C.brickDark, bands: 1, bandH: 2 }, stackH: 44,
    tank: { c: C.cream, band: C.gold, top: C.plank }, tank2: { c: C.cream, band: C.pink, top: C.plank },   // flour silos
    trailers: [C.pink], truck: { cab: C.white, box: C.pink, stripe: C.white, logo: C.gold }, crates: [C.plank, C.wood],
  });
  return p.H.done();
}

function bJuiceFactory(rng) {
  const juice = pk(rng, [C.orange, C.red, C.purple]);
  const fruit = (c) => ({ c: C.indTank, stripes: [[4, 1.6, c]], top: c, tipC: C.roofGreen });
  const p = works(rng, {
    kind: 'process', accent: juice, text: 'JUICE', clad: 'corr', stacks: 0, tankH: 13, crane: { x0: 1, x1: 19, h: 16, load: C.orange },
    tank: fruit(C.orange), tank2: fruit(C.red),
    trailers: [C.orange], truck: { tanker: true, cab: juice, tank: C.indTank, band: juice }, crates: [C.orange, C.roofGreen],
  });
  return p.H.done();
}

function bCookieFactory(rng) {
  const p = works(rng, {
    kind: 'dock', accent: C.indChocoLt, text: 'NOM', signFg: C.indChoco, saw: true, stacks: 0, hopper: { h: 24 },
    stack: { body: C.brick, stripe: C.brickDark, bands: 1, bandH: 2 }, stackH: 44, clad: 'cream',
    trailers: [C.cream, C.orange], truck: { cab: C.indChocoLt, box: C.cream, stripe: C.indChocoLt, logo: C.indChoco },
    tank: { c: C.amber, band: C.indChoco, top: C.indChocoLt }, crates: [C.plank, C.indChocoLt],
  });
  return p.H.done();
}

// ===========================================================================
// CATALOG FACTORIES
// ===========================================================================
function bWorkshop(rng) {
  const accent = pk(rng, [C.orange, C.indBlue, C.red]);
  const p = works(rng, {
    kind: 'dock', accent, text: 'TOOLS', clad: 'corr', saw: true, stacks: 1, h: 17, stackH: 40, crane: { h: 18, load: C.indBlue },
    trailers: [C.white, C.orange], truck: { cab: accent, box: C.white, stripe: accent, logo: accent },
    goods: (q) => { const { g, y0 } = q; for (const [x, z, c] of [[18, 6, C.indBlue], [18, 8, C.red]]) barrel(g, x, y0, z, c); crates(g, 15, y0, 6, 3, 3, 2, [C.wood, C.plank]); },
  });
  return p.H.done();
}

function bRocketLab(rng) {                                        // 2×2
  const S = 63;
  const accent = pk(rng, [C.indBlue, C.red]);
  const H = hiRes(S, 200, 'rocket:' + accent, false), g = H.g;   // rocket → fine part
  const y0 = lotPlinth(g, 0, 0, S - 1, S - 1, {});
  // --- mission control (front right) ---
  const x0 = 36, x1 = 59, z0 = 5, z1 = 24;
  const top = hall(g, x0, z0, x1, z1, y0, 28, { wall: C.indNavy, trim: C.indShade, band: [23, C.white, 2] });
  const F = facade(g, 'front', z0), L = facade(g, 'left', x0), Rt = facade(g, 'right', x1), B = facade(g, 'back', z1);
  ribbon(F, x0 + 3, x0 + 6, 7, 6); ribbon(F, x1 - 6, x1 - 3, 7, 6);
  door(F, 45, y0, 6, 11, { double: true, color: C.winCool, frame: C.white, glass: C.winCool, step: C.indShade, stepDepth: 3, canopy: accent });
  // w2 r1: a blue curtain band across mission control's front + back (ref05's
  // glazed office fronts) and a half-size SPACE tag (the coarse yellow-bordered
  // board read as a toy billboard)
  for (const f of [F, B]) curtainBand(f, x0 + 2, x1 - 2, y0 + 16, y0 + 19);
  H.fine((Fg) => {
    tag(facade(Fg, 'front', 2 * z0), 97, 2 * y0 + 24, 'SPACE', { fg: C.navy });
    tag(facade(Fg, 'back', 2 * z1 + 1), 97, 2 * y0 + 24, 'SPACE', { fg: C.navy });
  });
  ribbon(B, x0 + 3, x0 + 6, 7, 5); ribbon(B, x1 - 6, x1 - 3, 7, 5);
  for (const f of [L, Rt]) glazeBays(f, z0 + 1, z1, y0 + 4, y0 + 19, 5);
  // radar dish + mast + condensers on the roof
  const dx = x0 + 7, dz = z0 + 10;
  g.box(dx, top, dz, dx + 1, top + 5, dz + 1, C.metalDark);
  disc(g, dx, dz, 3, top + 6, C.white);
  ring(g, dx, dz, 5, top + 7, top + 7, C.white); ring(g, dx, dz, 6, top + 8, top + 8, C.white);
  disc(g, dx, dz, 4, top + 7, C.indShade);
  g.box(dx, top + 7, dz, dx, top + 12, dz, C.metalDark); g.set(dx, top + 13, dz, C.red);
  acBox(g, x1 - 8, top, z1 - 7, { w: 6, d: 5, h: 4 });
  solarPanel(g, x1 - 8, z0 + 2, x1 - 2, z0 + 8, top, { cell: 3 });
  g.box(x0 + 15, top, z0 + 3, x0 + 15, top + 16, z0 + 3, C.metal); g.set(x0 + 15, top + 17, z0 + 3, C.lamp);
  // --- rocket assembly hangar (back right): tall hall, giant door toward the pad ---
  const ax0 = 44, ax1 = 59, az0 = 33, az1 = 58;
  const atop = hall(g, ax0, az0, ax1, az1, y0, 44, { wall: C.indCorr, trim: C.indCorrDk, band: [38, accent, 2] });
  const AL = facade(g, 'left', ax0), AB = facade(g, 'back', az1), AF = facade(g, 'front', az0), AR = facade(g, 'right', ax1);
  AL.clear(38, y0, 0, 53, y0 + 32, 0);
  for (let z = 38; z <= 53; z++) for (let y = y0; y <= y0 + 32; y++) AL.set(z, y, -1, (z - 38) % 4 === 3 ? C.indBase : C.indShade);
  AL.box(37, y0, 0, 37, y0 + 33, 0, C.indBase); AL.box(54, y0, 0, 54, y0 + 33, 0, C.indBase); AL.box(37, y0 + 33, 0, 54, y0 + 33, 0, C.indBase);
  for (let k = 0; k < 3; k++) AB.box(ax0 + 2, 6 + k * 3, 0, ax1 - 2, 7 + k * 3, 0, [C.red, C.white, C.indBlue][k]);
  sign(AF, 52, 30, 'BV', { bg: accent, border: C.white, out: 1 });
  sign(AB, 52, 30, 'BV', { bg: accent, border: C.white, out: 1 });
  glazeBays(AR, az0 + 1, az1, y0 + 5, y0 + 34, 5, [], C.indCorrDk);
  panelSeams(g, ax0, az0, ax1, az1, y0 + 2, y0 + 36, C.indCorr, C.indCorrDk, 6);
  panelSeams(g, x0, z0, x1, z1, y0 + 2, y0 + 22, C.indNavy, C.indNavyDk, 6);
  acBox(g, ax0 + 2, atop, az0 + 3, { w: 6, d: 5, h: 4 });
  H.fine((Fg) => {
    fineRoof(Fg, g, ax0 + 1, az0 + 1, ax1 - 1, az1 - 1, atop, { accent });
    fineRoof(Fg, g, x0 + 1, z0 + 1, x1 - 1, z1 - 1, top, { accent, kinds: ['cond', 'fan', 'vents', 'cab', 'wtank'] });
    fineWall(Fg, 'right', ax1, az0, az1, y0, atop - 1, { ac: 2, pipeY: y0 + 18 });
    fineWall(Fg, 'back', az1, ax0, ax1, y0, atop - 1, { ac: 1, pipe: false });
    fineWall(Fg, 'left', x0, z0, z1, y0, top - 1, { ac: 2, pipeY: y0 + 9 });
    fineWall(Fg, 'right', x1, z0, z1, y0, top - 1, { ac: 1, pipeY: y0 + 9, ladder: false });
  });
  // --- launch pad (centre left) ---
  const rx = 22, rz = 38;
  cylinder(g, rx, rz, 12, y0, y0 + 1, C.indShade);
  ring(g, rx, rz, 12, y0 + 1, y0 + 1, C.white);
  ring(g, rx, rz, 9, y0 + 1, y0 + 1, C.yellow);
  g.box(rx - 3, y0 + 1, rz - 3, rx + 3, y0 + 1, rz + 3, C.darkGray);
  g.box(rx + 13, y0 - 1, rz - 2, ax0 - 1, y0 - 1, rz + 2, C.lotPaveDark);   // crawlerway to the hangar
  const pb = y0 + 2;
  for (const [ex, ez] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) g.box(rx + ex - 1, pb, rz + ez - 1, rx + ex + 1, pb + 1, rz + ez + 1, C.darkGray);
  // r8 (critic r7: the rocket "is taller than everything else and pulls
  // attention away from the industrial theme"): rocket 92 → 48, gantry 104 → 56
  const rb = pb + 3, rt = rb + 48, GH = 56;
  H.fine((F) => fineRocket(F, 2 * rx + 1, 2 * rz + 1, 2 * rb, 2 * rt, accent));
  // service gantry on the hangar side (red lattice) + swing arms
  const gx0 = rx + 7, gx1 = rx + 13, gz0 = rz - 3, gz1 = rz + 3;
  for (const [px, pz] of [[gx0, gz0], [gx1, gz0], [gx0, gz1], [gx1, gz1]]) g.box(px, pb, pz, px, pb + GH, pz, C.indSteelDk);   // r12: steel lattice (critic r11: red rocket rig read as a theme-park piece)
  for (let y = pb + 8; y <= pb + GH; y += 8) g.walls(gx0, y, gz0, gx1, y, gz1, C.indSteelDk);
  for (let y = pb + 4; y <= pb + GH - 4; y += 8) for (let t = 0; t <= gz1 - gz0; t++) { g.set(gx0, y + (t >> 1) - 2, gz0 + t, C.indBase); g.set(gx1, y + (t >> 1) - 2, gz0 + t, C.indBase); }
  for (const ay of [pb + 28, pb + 44]) g.box(rx + 5, ay, rz - 1, gx0 - 1, ay + 1, rz + 1, C.metalDark);
  g.box(gx0, pb + GH + 1, gz0, gx1, pb + GH + 1, gz1, C.darkGray);
  g.box(gx1, pb + GH + 2, rz, gx1, pb + GH + 8, rz, C.metalDark); g.set(gx1, pb + GH + 9, rz, C.lamp);
  // fuel farm (back left) + pipe to the pad
  H.surf((M) => {                                // r6: ribbed domed fuel tanks (were lumpy voxel domes)
    surfDomeTank(M, 7.5, 56.5, y0, 4, 11, { band: accent, bands: [[2.5, 3.5], [7, 8]], seg: 24, legs: 2 });
    surfDomeTank(M, 18.5, 56.5, y0, 4, 11, { band: C.orange, bands: [[2.5, 3.5], [7, 8]], seg: 24, legs: 2 });
  });
  pipeX(g, 7, 30, y0 + 6, 53, C.metal, y0);
  pipeZ(g, 49, 54, y0 + 6, 29, C.metal, null);
  fenceX(g, 3, 36, y0, 61); fenceZ(g, 26, 61, y0, 1);
  // --- visitor parking (front left) + trees ---
  parking(g, 3, 2, 32, 14, y0 - 1, 'x', 6);
  const cc = [C.red, C.indBlue, C.yellow, C.teal, C.white];
  for (let i = 0; i < 4; i++) if (i !== 2 || rng() < 0.5) car(g, 5 + i * 6, y0, 4, 'z', 1, cc[(i + ((rng() * 5) | 0)) % 5]);
  van(g, 29, y0, 3, 'z', 1, C.white, { stripe: accent });
  hazard(g, 43, 1, 52, 3, y0 - 1);
  for (const [tx, tz] of [[4, 19], [11, 19], [30, 19], [36, 29], [4, 29]]) tree(g, tx, y0, tz, 5);
  bush(g, 15, y0, 18, 28, 19);
  crates(g, 31, y0, 56, 3, 3, 2, [C.indShade, C.indBlue]);
  yardFill(g, y0, rng, { keep: [[rx + 0.5, rz + 0.5, 13.5], [7.5, 56.5, 6], [18.5, 56.5, 6]], skip: [[rx + 13, rz - 3, ax0 - 1, rz + 3]] });
  return H.done();
}

function bSawmill(rng) {
  const H = hiRes(31, 80, 'sawmill', false), g = H.g;
  const y0 = lotPlinth(g, 0, 0, 30, 30, {});
  const roofC = pk(rng, [C.indRoof, C.indSteelDk, C.indRoof]);   // r12: steel / charcoal roofs (a red stepped gable read as an amphitheatre)
  // w2 r1: the all-orange timber barn + sand yard graded to one loud orange
  // blob next to the grey works; now a cream mill hall on beige plant paving
  // with a sawdust patch under the log piles only (the logs tell the story)
  g.box(1, y0 - 1, 1, 29, y0 - 1, 29, C.indPave);
  g.box(1, y0 - 1, 11, 11, y0 - 1, 29, C.sand);
  // timber barn (ridge along z), gable ends front + back, open saw bay in front
  const x0 = 13, x1 = 27, z0 = 11, z1 = 27, bh = 15;
  g.walls(x0, y0, z0, x1, y0 + bh - 1, z1, C.dtLime);
  g.walls(x0, y0, z0, x1, y0 + 1, z1, C.indBase);
  for (let z = z0; z <= z1; z += 4) { g.box(x0, y0, z, x0, y0 + bh - 1, z, C.dtLimeShade); g.box(x1, y0, z, x1, y0 + bh - 1, z, C.dtLimeShade); }
  for (let x = x0; x <= x1; x += 4) { g.box(x, y0, z0, x, y0 + bh - 1, z0, C.dtLimeShade); g.box(x, y0, z1, x, y0 + bh - 1, z1, C.dtLimeShade); }
  for (let q = 0; q <= 9; q++) {
    const y = y0 + bh + q, a = x0 - 1 + q, b = x1 + 1 - q;
    if (a > b) break;
    g.box(a, y, z0 - 1, a, y, z1 + 1, roofC); g.box(b, y, z0 - 1, b, y, z1 + 1, roofC);
    if (a + 1 <= b - 1) { g.box(a + 1, y, z0, b - 1, y, z0, C.dtLime); g.box(a + 1, y, z1, b - 1, y, z1, C.dtLime); }
  }
  const ridge = y0 + bh + 8;
  g.box(x0 + 7, ridge, z0 - 1, x0 + 7, ridge, z1 + 1, C.indChoco);
  const L = facade(g, 'left', x0), F = facade(g, 'front', z0), B = facade(g, 'back', z1);
  for (const f of [L]) { ribbon(f, 14, 17, 6, 4, { glass: C.dtGlass, frame: C.indBase, sill: C.white }); ribbon(f, 21, 24, 6, 4, { glass: C.dtGlass, frame: C.indBase, sill: C.white }); }
  F.clear(x0 + 3, y0, 0, x1 - 3, y0 + 9, 0);
  g.box(x0 + 3, y0, z0 + 1, x1 - 3, y0, z0 + 8, C.woodDark);
  // w2 r1: the coarse WOOD board read as a big orange frame with stray cream
  // strokes; a half-size tag like every other works (fine part)
  H.fine((Fg) => {
    tag(facade(Fg, 'front', 2 * z0), 41, 2 * (y0 + bh) - 9, 'WOOD', { fg: C.indChoco });
    tag(facade(Fg, 'back', 2 * z1 + 1), 41, 2 * (y0 + bh) - 9, 'WOOD', { fg: C.indChoco });
  });
  door(B, 18, y0, 5, 10, { color: C.woodDark, frame: C.plank, step: null });
  // giant saw blade in the bay (disc in X/Y facing front)
  const sx = 20, sy = y0 + 5;
  for (const [ddx, ddz] of discOff(4)) g.set(sx + ddx, sy + ddz, z0 + 2, C.metal);
  for (const [ddx, ddz] of ringOff(4)) if (((ddx + ddz) & 1) === 0) g.set(sx + ddx, sy + ddz, z0 + 1, C.indShade);
  g.set(sx, sy, z0 + 1, C.darkGray);
  // log piles (left): logs along z with light end-grain on both ends
  const log = (lx, ly, lz0, lz1) => {
    g.box(lx, ly, lz0, lx + 2, ly + 2, lz1, C.trunkDark);   // w2 r1: C.trunk graded to an orange slab
    g.box(lx, ly, lz0, lx + 2, ly + 2, lz0, C.plank); g.set(lx + 1, ly + 1, lz0, C.wood);
    g.box(lx, ly, lz1, lx + 2, ly + 2, lz1, C.plank); g.set(lx + 1, ly + 1, lz1, C.wood);
  };
  for (let r = 0; r < 3; r++) for (let i = 0; i < 3 - r; i++) log(2 + i * 3 + r, y0 + r * 3, 13, 28);
  for (let r = 0; r < 2; r++) for (let i = 0; i < 2 - r; i++) log(2 + i * 3 + r, y0 + r * 3, 2, 10);
  // conveyor from the pile into the barn
  for (let x = 11; x <= 12; x++) g.box(x, y0 + 5, 18, x, y0 + 5, 21, C.darkGray);
  g.box(11, y0, 18, 11, y0 + 4, 18, C.metalDark);
  // plank stacks + forklift in front of the bay; flatbed with logs at the back
  for (const [px, pz] of [[8, 2]]) for (let q = 0; q < 4; q++) g.box(px, y0 + q, pz, px + 3, y0 + q, pz + 6, q & 1 ? C.plank : C.wood);
  forklift(g, 13, y0, 3, 'z', 1);
  for (let q = 0; q < 2; q++) g.box(19 + q * 3, y0, 2, 20 + q * 3, y0 + 2 - (q & 1), 8, q & 1 ? C.plank : C.wood);
  // sawdust cyclone on legs + duct up to the barn roof (a working mill)
  const cx = 26, cz = 5, cy = y0 + 8;
  for (const [lx, lz] of [[24, 3], [28, 3], [24, 7], [28, 7]]) g.box(lx, y0, lz, lx, cy + 1, lz, C.metalDark);
  for (let i = 0; i < 4; i++) disc(g, cx, cz, 0.8 + i * 0.6, cy + i, C.indShade);
  cylinder(g, cx, cz, 2.5, cy + 4, cy + 11, C.roofGreen, C.indShade);
  ring(g, cx, cz, 2.5, cy + 8, cy + 8, C.yellow);
  g.box(cx, cy + 12, cz, cx, cy + 14, cz, C.metal);
  g.box(cx - 5, cy + 14, cz, cx, cy + 15, cz + 1, C.metal);
  g.box(cx - 5, cy + 14, cz, cx - 4, cy + 15, z0 + 3, C.metal);
  g.box(27, y0, 9, 28, y0 + 3, 10, C.woodDark);                   // sawdust bin
  g.box(27, y0 + 4, 9, 28, y0 + 4, 10, C.sandDark);
  return H.done();
}

// Logistics depot (ref05's truck yard in miniature): the shared works laid
// across the whole lot — four dock bays with trailers backed in, a glass
// office wing rising at the back-right, HVAC pads and skylights on the roof.
function bWarehouse(rng) {
  const accent = pk(rng, [C.indBlue, C.orange, C.roofGreen]);
  const p = works(rng, {
    kind: 'dock', full: true, accent, text: 'DEPOT', clad: 'navy', stacks: 0,
    trailers: [C.orange, C.white, pk(rng, [C.orange, C.indBlue])],
  });
  return p.H.done();
}

function bMegaFactory(rng, variant) {                            // 3×3
  if (globalThis.__IND_MEGA_V != null) variant = globalThis.__IND_MEGA_V;   // dev: force a variant in shots
  return (variant | 0) % 2 === 1 ? powerPlant(rng) : megaWorks(rng, variant | 0);
}

// Author a layout in "design" coords and store it turned 180° (a proper
// rotation, so facade lettering still reads correctly). The mega layouts are
// designed with the yard, signs and docks toward design +z / -x — after the
// turn they face the road (front) and the right, which is the side the
// default iso camera looks at.
function rot180(g) {
  const s0 = g.set, d0 = g.del, X = g.sx - 1, Z = g.sz - 1;
  g.set = (x, y, z, c) => s0(X - Math.round(x), y, Z - Math.round(z), c);
  g.del = (x, y, z) => d0(X - Math.round(x), y, Z - Math.round(z));
  g.rot180 = true;
  return g;
}

// ===========================================================================
// HI-RES PART (res 8) — round 3. The power plant's hero shapes (cooling
// tower, domed tanks, silos) are surfaces of revolution; at res 4 their voxel
// rings stair-step irregularly from layer to layer and shade as "melted wax"
// streaks. They are drawn natively at res 8 into a separate PART model that
// rides on the res-4 building (model.parts → child meshes in engine.js), so
// the boxy rest of the plant keeps res-4 triangle counts (a plain box costs
// ~14× the triangles at res 8 once AO ramps are meshed).
//   const H = hiRes(S, SY, 'key');   // H.g = res-4 design view (rot180)
//   H.fine((F) => ...);              // F = res-8 design view (fine = 2× coarse)
//   return H.done();                 // base model with .parts = [fine part]
// The part is deterministic (no rng) and cached per key, so the engine's
// geometry cache hits on every rebuild of the base (ghost hover, placement).
// It is stored pre-flipped because catalogModel only flipZ()s the base.
// ===========================================================================
const _partCache = new Map();
function hiRes(S, SY, key, rot = true) {
  if (globalThis.__IND_FLIP && S > 64) { rot = !rot; key += '~flip'; }   // dev: view a mega lot's other side in shots
  const T = rot ? rot180 : (q) => q;
  const g = T(grid(S, SY, S, R));
  const ops = [], sops = [];
  return {
    g,
    fine(fn) { ops.push(fn); },
    surf(fn) { sops.push(fn); },                 // smooth part: fn(M), M = surfKit (coarse design coords)
    done() {
      const base = fin(g);
      if (globalThis.__IND_NOFINE) return base;
      const parts = [];
      if (ops.length) {
        let part = _partCache.get(key);
        if (!part) {
          const F = T(grid(2 * S, 2 * SY, 2 * S, 2 * R));
          for (const fn of ops) fn(F);
          part = fin(F);
          flipZ(part);
          _partCache.set(key, part);
        }
        if (part.blocks.length) parts.push(part);
      }
      if (sops.length) {
        let sp = _partCache.get(key + '~surf');
        if (!sp) {
          const M = surfKit(S, SY, rot);
          for (const fn of sops) fn(M);
          sp = M.done();
          _partCache.set(key + '~surf', sp);
        }
        parts.push(sp);
      }
      if (parts.length) base.parts = parts;
      return base;
    },
  };
}

// ===========================================================================
// SMOOTH SURFACE PART — round 4. Round heroes (cooling tower, domed tanks,
// silos, stacks) as real surfaces of revolution instead of voxel rings: the
// r3 critic still read the res-8 voxel tower as "a lumpy stack of vertical
// white voxel columns, ribbed stepping, jagged rim" next to ref05's smooth
// hyperboloid with confident gradient shading. A lathe with analytic normals
// gives exactly that gradient, crisp colour bands (rings duplicated at every
// band edge) and ~1/10 of the voxel part's triangles. The engine turns
// `{surf}` parts into voxel-material geometry (engine._getSurfGeometry).
//   M.lathe(cx, cz, rOf, y0, y1, steps, colour, {seg, in, ao})
//   M.disc(cx, cz, r0, r1, y, colour, {down})   M.box(...)   M.beam(p0, p1, w, c)
// Coordinates are the model's COARSE design coords (floats; voxel v spans
// [v, v+1]; y in voxels), mapped like the voxel grid: rot180 (if rot) and the
// catalog's flipZ, then centred and divided by R to world units. Winding is
// fixed at the end from the normals, so the mirror in that map is harmless.
// ===========================================================================
function surfKit(S, SY, rot) {
  const P = [], Nn = [], CI = [], AO = [], I = [];
  const wx = rot ? (x) => (S / 2 - x) / R : (x) => (x - S / 2) / R;
  const wz = rot ? (z) => (z - S / 2) / R : (z) => (S / 2 - z) / R;
  const nsx = rot ? -1 : 1, nsz = rot ? 1 : -1;
  const vtx = (x, y, z, nx, ny, nz, c, ao) => {
    P.push(wx(x), y / R, wz(z)); Nn.push(nx * nsx, ny, nz * nsz); CI.push(c); AO.push(ao == null ? 1 : ao);
    return P.length / 3 - 1;
  };
  const quad = (a, b, c, d) => I.push(a, b, c, a, c, d);
  const col = (c, y) => (typeof c === 'function' ? c(y) : c);
  const M = {
    // surface of revolution r = rOf(y), y0..y1 in `steps` rings; o.in = inner wall
    lathe(cx, cz, rOf, y0, y1, steps, c, o = {}) {
      const seg = o.seg || 48, a0 = o.a0 || 0, s = o.in ? -1 : 1;
      if (o.flat) {
        // r6: FLAT-SHADED facets (own vertices + facet normal per quad) — the
        // crisp vertical fluting of ref05's voxel towers / tanks, without the
        // jagged stair-stepping of real voxel rings. o.ca(q, y) = per-facet
        // colour (dashes, stripes round the ring).
        const da = 2 * Math.PI / seg, hc = Math.cos(da / 2);
        for (let k = 0; k < steps; k++) {
          const ya = y0 + (y1 - y0) * k / steps, yb = y0 + (y1 - y0) * (k + 1) / steps;
          const ra = rOf(ya), rb = rOf(yb);
          const dr = (rb - ra) * hc / Math.max(1e-4, yb - ya);
          const L = Math.hypot(1, dr), nr = s / L, ny = -dr / L * s;
          const aoa = o.ao ? o.ao(ya) : 1, aob = o.ao ? o.ao(yb) : 1;
          const cm = col(c, (ya + yb) / 2);
          for (let q = 0; q < seg; q++) {
            const a1 = a0 + q * da, a2 = a1 + da, am = a1 + da / 2;
            const nx = Math.cos(am) * nr, nz = Math.sin(am) * nr, cc = o.ca ? o.ca(q, (ya + yb) / 2) : cm;
            const V = (a, r, y, ao) => vtx(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, nx, ny, nz, cc, ao);
            quad(V(a1, ra, ya, aoa), V(a2, ra, ya, aoa), V(a2, rb, yb, aob), V(a1, rb, yb, aob));
          }
        }
        return;
      }
      let prev = null;
      for (let k = 0; k <= steps; k++) {
        const y = y0 + (y1 - y0) * k / steps, r = rOf(y), e = 0.02;
        const dr = (rOf(y + e) - rOf(y - e)) / (2 * e);
        const L = Math.hypot(1, dr), ny = -dr / L * s, nr = s / L;
        const yc = k === steps ? y1 - 1e-3 : y + 1e-3;
        const cc = col(c, k === steps ? y1 - 1e-3 : y), ao = o.ao ? o.ao(y) : 1;
        const row = [];
        for (let q = 0; q < seg; q++) {
          const a = a0 + q / seg * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
          row.push(vtx(cx + ca * r, y, cz + sa * r, ca * nr, ny, sa * nr, typeof c === 'function' ? col(c, yc) : cc, ao));
        }
        if (prev) for (let q = 0; q < seg; q++) quad(prev[q], prev[(q + 1) % seg], row[(q + 1) % seg], row[q]);
        prev = row;
      }
    },
    // flat annulus (r0 = 0: a disc) facing up (or down)
    disc(cx, cz, r0, r1, y, c, o = {}) {
      const seg = o.seg || 48, ny = o.down ? -1 : 1;
      const outer = [], inner = [];
      for (let q = 0; q < seg; q++) {
        const a = (o.a0 || 0) + q / seg * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
        outer.push(vtx(cx + ca * r1, y, cz + sa * r1, 0, ny, 0, c, o.ao));
        if (r0 > 0) inner.push(vtx(cx + ca * r0, y, cz + sa * r0, 0, ny, 0, c, o.ao));
      }
      if (r0 > 0) for (let q = 0; q < seg; q++) quad(inner[q], inner[(q + 1) % seg], outer[(q + 1) % seg], outer[q]);
      else { const m = vtx(cx, y, cz, 0, ny, 0, c, o.ao); for (let q = 0; q < seg; q++) I.push(m, outer[q], outer[(q + 1) % seg]); }
    },
    // r11: annulus SECTOR a0..a1 (radians) as a slab of thickness th under y —
    // landings / catwalk decks that wrap part of a tank. Flat top + outer rim.
    arc(cx, cz, r0, r1, a0, a1, y, th, c, seg = 8) {
      const P = (a, r, yy) => [cx + Math.cos(a) * r, yy, cz + Math.sin(a) * r];
      for (let q = 0; q < seg; q++) {
        const aa = a0 + (a1 - a0) * q / seg, ab = a0 + (a1 - a0) * (q + 1) / seg, am = (aa + ab) / 2;
        const t = [P(aa, r0, y), P(ab, r0, y), P(ab, r1, y), P(aa, r1, y)].map(([x, yy, z]) => vtx(x, yy, z, 0, 1, 0, c));
        quad(t[0], t[1], t[2], t[3]);
        const nx = Math.cos(am), nz = Math.sin(am);
        const s = [P(aa, r1, y - th), P(ab, r1, y - th), P(ab, r1, y), P(aa, r1, y)].map(([x, yy, z]) => vtx(x, yy, z, nx, 0, nz, c));
        quad(s[0], s[1], s[2], s[3]);
      }
    },
    // axis-aligned box (flat faces)
    box(x0, y0, z0, x1, y1, z1, c) {
      const F = [
        [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
        [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
        [[-1, 0, 0], [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]],
        [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
        [[0, 0, -1], [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]],
      ];
      for (const [n, vs] of F) { const ids = vs.map(([x, y, z]) => vtx(x, y, z, n[0], n[1], n[2], c)); quad(ids[0], ids[1], ids[2], ids[3]); }
    },
    // square-section beam of width w from p0 to p1 (legs, braces, ladders)
    beam(p0, p1, w, c) {
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      const t = [d[0] / dl, d[1] / dl, d[2] / dl];
      const ref = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      let u = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
      const ul = Math.hypot(u[0], u[1], u[2]); u = u.map((q) => q / ul);
      const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
      const h = w / 2;
      for (const [n, a, b] of [[u, u, v], [v, v, u], [u.map((q) => -q), u.map((q) => -q), v], [v.map((q) => -q), v.map((q) => -q), u]]) {
        const ids = [];
        for (const [sa, sb, p] of [[1, -1, p0], [1, 1, p0], [1, 1, p1], [1, -1, p1]]) {
          ids.push(vtx(p[0] + h * (a[0] * sa + b[0] * sb), p[1] + h * (a[1] * sa + b[1] * sb), p[2] + h * (a[2] * sa + b[2] * sb), n[0], n[1], n[2], c));
        }
        quad(ids[0], ids[1], ids[2], ids[3]);
      }
    },
    done() {
      // winding from the normals (front = the side the normals point to)
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
        const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const m = [Nn[a] + Nn[b] + Nn[c], Nn[a + 1] + Nn[b + 1] + Nn[c + 1], Nn[a + 2] + Nn[b + 2] + Nn[c + 2]];
        if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) { const q = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = q; }
      }
      return {
        sx: S, sy: SY, sz: S, res: R, blocks: [],
        surf: { pos: new Float32Array(P), nrm: new Float32Array(Nn), ci: new Uint16Array(CI), ao: new Float32Array(AO), idx: new Uint32Array(I) },
      };
    },
  };
  return M;
}

// A NESTED family of round cross-sections: shape k is shape k-1 eroded by one
// voxel (cross or 3×3 kernel, whichever stays closer to a true disc of radius
// r0-k). Stepping a tower between neighbouring shapes therefore always removes
// a uniform 1-voxel ring — clean horizontal ledges all the way round, never
// the ragged, drippy staircases of independently rounded discs.
const _nest = new Map();
function nestedShapes(r0, n) {
  const key = r0 + ':' + n;
  if (_nest.has(key)) return _nest.get(key);
  const K = (x, z) => x + ',' + z;
  const toSet = (arr) => new Set(arr.map(([x, z]) => K(x, z)));
  let cur = toSet(discOff(r0));
  const sets = [cur];
  const erode = (s, sq) => {
    const out = new Set();
    for (const k of s) {
      const [x, z] = k.split(',').map(Number);
      let keep = s.has(K(x + 1, z)) && s.has(K(x - 1, z)) && s.has(K(x, z + 1)) && s.has(K(x, z - 1));
      if (keep && sq) keep = s.has(K(x + 1, z + 1)) && s.has(K(x - 1, z + 1)) && s.has(K(x + 1, z - 1)) && s.has(K(x - 1, z - 1));
      if (keep) out.add(k);
    }
    return out;
  };
  for (let k = 1; k <= n; k++) {
    const ideal = toSet(discOff(Math.max(0.5, r0 - k)));
    const diff = (s) => { let d = 0; for (const q of s) if (!ideal.has(q)) d++; for (const q of ideal) if (!s.has(q)) d++; return d; };
    const a = erode(cur, false), b = erode(cur, true);
    cur = diff(a) <= diff(b) ? a : b;
    sets.push(cur);
  }
  const shapes = sets.map((s) => [...s].map((k) => k.split(',').map(Number)));
  const rings = sets.map((s, i) => (i + 1 < sets.length ? shapes[i].filter(([x, z]) => !sets[i + 1].has(K(x, z))) : shapes[i]));
  const res = { shapes, rings, sets };
  _nest.set(key, res);
  return res;
}

// ---- smooth heroes (surfKit, coarse design units; g = ground y) ----------

// ref05's cooling tower, r6 (critic r5: "a smooth, featureless lathed cone";
// ref05 "builds the cooling tower from stepped voxel rings, with a legged,
// fluted base and a textured rim"). Still a clean surface (r1-r3 critics
// hated jagged voxel rings), but now: 40 FLAT facets (vertical fluting), the
// hyperboloid quantised into 2.75-high stepped rings with lit ledges, grey
// stripes round the lower third, a colonnade of 36 chunky raked columns on
// yellow feet in front of a dark core, a ring beam with red dashes, two red
// bands under a crenellated white lip, and a textured spray deck (nozzle
// boxes on a mid-grey floor) down the throat. Returns the lip height.
function surfCoolingTower(M, cx, cz, g, o = {}) {
  const L = o.legs || 10, Hs = o.h || 62, rb = o.rb || 18.5, rw = o.rw || 12.6;
  const yw = Hs * 0.8, cc = yw / Math.sqrt((rb / rw) * (rb / rw) - 1);
  const rAt = (j) => rw * Math.sqrt(1 + ((j - yw) / cc) * ((j - yw) / cc));
  const ys = g + L, seg = 40, F = { seg, flat: true };
  // basin: yellow kerb ring round a pale concrete floor
  M.lathe(cx, cz, () => rb + 2.4, g, g + 0.9, 1, C.yellow, F);
  M.disc(cx, cz, rb + 1.6, rb + 2.4, g + 0.9, C.yellow, { seg });
  M.lathe(cx, cz, () => rb + 1.6, g + 0.4, g + 0.9, 1, C.indShade, { ...F, in: true });
  M.disc(cx, cz, 0, rb + 1.6, g + 0.4, C.indShade, { seg });
  // colonnade: dark core seen between chunky raked columns on yellow feet
  const rTop = rAt(0);
  M.lathe(cx, cz, () => rTop - 3.2, g + 0.4, ys + 0.5, 2, C.indRoof, { ...F, ao: (y) => 0.35 + 0.35 * (y - g) / L });
  M.disc(cx, cz, 0, rTop - 3.2, ys + 0.5, C.indRoof, { seg, down: true });
  const nl = o.nl || 36;
  for (let k = 0; k < nl; k++) {
    const a = (k + 0.5) / nl * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
    M.beam([cx + ca * (rb + 0.2), g + 0.4, cz + sa * (rb + 0.2)], [cx + ca * (rTop - 1.2), ys + 0.4, cz + sa * (rTop - 1.2)], 1.15, C.indTank);
    if (!(k & 1)) M.beam([cx + ca * (rb + 0.35), g + 0.4, cz + sa * (rb + 0.35)], [cx + ca * (rb + 0.25), g + 1.5, cz + sa * (rb + 0.25)], 1.6, C.yellow);
  }
  // ring beam over the columns: grey soffit, white beam with red dashes
  M.lathe(cx, cz, () => rTop + 0.7, ys, ys + 0.8, 1, C.indBase, F);
  M.disc(cx, cz, rTop - 3.2, rTop + 0.7, ys, C.indBase, { seg, down: true });
  M.lathe(cx, cz, () => rTop + 0.7, ys + 0.8, ys + 2.6, 1, C.white, { ...F, ca: (q) => (q & 1 ? C.red : C.white) });
  // shell: stepped rings (radius constant per ring, ledge where it changes)
  const stp = 2.75, j0 = 2.6, nst = Math.floor((Hs - 1.2 - j0) / stp);
  const jTop = j0 + nst * stp;
  const spans = [];
  for (let k = 0; k < 4; k++) { const a = 4.2 + k * 2 * stp; spans.push([a, a + 1.1, C.indRoofLt]); }
  spans.push([jTop - 8.2, jTop - 7.2, C.red], [jTop - 5.4, jTop - 4.4, C.red]);
  const colAt = (j) => { for (const [a, b, c] of spans) if (j >= a && j < b) return c; return C.indTank; };
  let rPrev = null;
  for (let i = 0; i < nst; i++) {
    const ja = j0 + i * stp, jb = ja + stp, r = rAt((ja + jb) / 2);
    // split the ring at colour-span edges so bands stay crisp
    const cuts = [ja, jb];
    for (const [a, b] of spans) for (const e of [a, b]) if (e > ja + 1e-3 && e < jb - 1e-3) cuts.push(e);
    cuts.sort((p, q) => p - q);
    for (let t = 0; t + 1 < cuts.length; t++) M.lathe(cx, cz, () => r, ys + cuts[t], ys + cuts[t + 1], 1, colAt((cuts[t] + cuts[t + 1]) / 2), F);
    // r7 (critic r6: the tower "is large and has little surface detail"):
    // proud vertical ribs on every 4th facet edge, stepping with the rings
    for (let q = 0; q < seg; q += 4) {
      const a = q * 2 * Math.PI / seg, ca = Math.cos(a), sa = Math.sin(a), rr = r + 0.18;
      M.beam([cx + ca * rr, ys + ja, cz + sa * rr], [cx + ca * rr, ys + jb, cz + sa * rr], 0.55, colAt((ja + jb) / 2) === C.red ? C.red : C.indWall);
    }
    const rb0 = rPrev == null ? rTop + 0.7 : rPrev;
    if (rb0 > r + 1e-3) M.disc(cx, cz, r, rb0, ys + ja, rPrev == null ? C.white : C.indTank, { seg });      // lit ledge
    else if (r > rb0 + 1e-3) M.disc(cx, cz, rb0, r, ys + ja, C.indTank, { seg, down: true });             // flare: shadowed lip
    rPrev = r;
  }
  // r7: a caged service ladder up the shell with two ring walkways (railed)
  {
    const aL = o.ladderA != null ? o.ladderA : Math.PI * 0.25, ca = Math.cos(aL), sa = Math.sin(aL);
    for (let i = 0; i < nst; i++) {
      const ja = j0 + i * stp, jb = ja + stp, rr = rAt((ja + jb) / 2) + 0.9;
      for (const d of [-0.5, 0.5]) M.beam([cx + ca * rr - sa * d, ys + ja, cz + sa * rr + ca * d], [cx + ca * rr - sa * d, ys + jb, cz + sa * rr + ca * d], 0.22, C.indBase);
      M.lathe(cx + ca * (rr + 0.2), cz + sa * (rr + 0.2), () => 0.75, ys + ja + 1.2, ys + ja + 1.5, 1, C.yellow, { seg: 8, flat: true });
    }
    for (const f of [0.34, 0.68]) {
      const j = j0 + Math.round(f * nst) * stp, rr = rAt(j + stp / 2);
      M.disc(cx, cz, rr, rr + 1.3, ys + j, C.indBase, { seg });
      M.disc(cx, cz, rr, rr + 1.3, ys + j - 0.25, C.indBase, { seg, down: true });
      M.lathe(cx, cz, () => rr + 1.3, ys + j - 0.25, ys + j, 1, C.indBase, F);
      M.lathe(cx, cz, () => rr + 1.25, ys + j + 1.0, ys + j + 1.25, 1, C.yellow, F);
      for (let q = 0; q < seg; q += 2) { const a = q * 2 * Math.PI / seg; M.beam([cx + Math.cos(a) * (rr + 1.25), ys + j, cz + Math.sin(a) * (rr + 1.25)], [cx + Math.cos(a) * (rr + 1.25), ys + j + 1.1, cz + Math.sin(a) * (rr + 1.25)], 0.14, C.yellow); }
    }
  }
  // proud white lip, crenellated rim, inner wall, textured spray deck
  const yt = ys + jTop + 1.2, rt = rPrev;
  M.disc(cx, cz, rt, rt + 0.5, ys + jTop, C.indTank, { seg, down: true });
  M.lathe(cx, cz, () => rt + 0.5, ys + jTop, yt, 1, C.white, F);
  M.disc(cx, cz, rt - 0.9, rt + 0.5, yt, C.white, { seg });
  const ncr = 40;
  for (let k = 0; k < ncr; k++) {
    if (k % 2) continue;
    const a = (k + 0.5) / ncr * 2 * Math.PI, x = cx + Math.cos(a) * (rt - 0.2), z = cz + Math.sin(a) * (rt - 0.2);
    M.box(x - 0.45, yt, z - 0.45, x + 0.45, yt + 0.7, z + 0.45, C.indTank);
  }
  const yd = yt - 12;
  M.lathe(cx, cz, () => rt - 0.9, yt - 2.5, yt, 1, C.indShade, { ...F, in: true });
  M.lathe(cx, cz, () => rt - 0.9, yd, yt - 2.5, 3, C.indRoofLt, { ...F, in: true, ao: (y) => 0.55 + 0.45 * (y - yd) / 9.5 });
  const rd = rt - 0.9;
  M.disc(cx, cz, 0, rd, yd, C.indBase, { seg, ao: 0.85 });
  // nozzle field: concentric rings of little boxes + spokes = a busy, textured deck
  for (const [f, n] of [[0.28, 8], [0.5, 14], [0.72, 20], [0.9, 26]]) {
    const rr = rd * f;
    for (let k = 0; k < n; k++) {
      const a = (k + (f * 7 % 1)) / n * 2 * Math.PI, x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      const s = 0.35 + (k % 3) * 0.08;
      M.box(x - s, yd, z - s, x + s, yd + 0.5 + (k % 2) * 0.3, z + s, k % 4 === 0 ? C.indRoof : C.indShade);
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    M.beam([cx + Math.cos(a) * 1.4, yd + 0.25, cz + Math.sin(a) * 1.4], [cx + Math.cos(a) * (rd - 0.3), yd + 0.25, cz + Math.sin(a) * (rd - 0.3)], 0.45, C.indRoof);
  }
  M.lathe(cx, cz, () => 1.4, yd, yd + 1.6, 1, C.indBlue, { seg: 12, flat: true });
  M.disc(cx, cz, 0, 1.4, yd + 1.6, C.indBlue, { seg: 12 });
  return yt;
}

// Domed storage tank, r6 (critic r5: ref05's "domed tanks have ribbed, fluted
// voxel sides"): concrete pad, a colonnade skirt of light columns round a dark
// core, a ring beam, a FLAT-faceted drum with a proud rib on every facet edge
// and crisp red bands, a faceted dome ribbed like an orange (meridian ribs
// down to the eaves), crown vent, and a stair rail spiralling up the side.
function surfDomeTank(M, cx, cz, g, r, h, o = {}) {
  const seg = o.seg || 28, F = { seg, flat: true }, L = o.legs || 3;
  const band = o.band != null ? o.band : C.red, body = o.c != null ? o.c : C.indTank;
  const da = 2 * Math.PI / seg, P = (a, rr, y) => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
  M.lathe(cx, cz, () => r + 1.4, g, g + 0.5, 1, C.indShade, F);
  M.disc(cx, cz, 0, r + 1.4, g + 0.5, C.indShade, { seg });
  M.lathe(cx, cz, () => r - 1.1, g + 0.5, g + L, 1, C.indRoof, { ...F, ao: (y) => 0.45 + 0.4 * (y - g) / L });
  const nleg = Math.round(seg * 0.75);
  for (let k = 0; k < nleg; k++) { const a = (k + 0.5) / nleg * Math.PI * 2; M.beam(P(a, r - 0.35, g + 0.5), P(a, r - 0.35, g + L), 0.8, C.indTank); }
  const b0 = g + L, bands = o.bands || [[1.8, 2.8], [h - 3.4, h - 2.4]];
  M.lathe(cx, cz, () => r + 0.3, b0, b0 + 0.7, 1, C.indShade, F);
  M.disc(cx, cz, r - 0.4, r + 0.3, b0, C.indShade, { seg, down: true });
  M.disc(cx, cz, r, r + 0.3, b0 + 0.7, C.indShade, { seg });
  const cuts = [[0.7, bands[0][0], body]];
  for (let i = 0; i < bands.length; i++) { cuts.push([bands[i][0], bands[i][1], band]); cuts.push([bands[i][1], i + 1 < bands.length ? bands[i + 1][0] : h, body]); }
  for (const [j0, j1, c] of cuts) M.lathe(cx, cz, () => r, b0 + j0, b0 + j1, 1, c, F);
  // flutes: a proud rib on every facet edge (breaks the drum into bright / shaded strips)
  for (let q = 0; q < seg; q++) M.beam(P(q * da, r + 0.12, b0 + 0.7), P(q * da, r + 0.12, b0 + h), 0.42, C.white);
  // dome: faceted spherical cap of height hd, ribbed along its meridians
  const hd = o.dome || r * 0.45, Rs = (r * r + hd * hd) / (2 * hd), yc = b0 + h + hd - Rs;
  const rs = (yy) => Math.sqrt(Math.max(0, Rs * Rs - (yy - yc) * (yy - yc)));
  const yT = b0 + h + hd - 0.3;
  M.disc(cx, cz, r - 0.2, r + 0.35, b0 + h, C.white, { seg });                    // eaves ledge
  M.lathe(cx, cz, rs, b0 + h, yT, 5, C.white, F);
  M.disc(cx, cz, 0, rs(yT), yT, C.white, { seg });
  const nr = seg / 2, K = 5;
  for (let q = 0; q < nr; q++) {
    const a = q * 2 * da;
    for (let k = 0; k < K; k++) {
      const ya = b0 + h + (yT - 0.2 - b0 - h) * k / K, yb = b0 + h + (yT - 0.2 - b0 - h) * (k + 1) / K;
      M.beam(P(a, rs(ya) + 0.1, ya + 0.12), P(a, rs(yb) + 0.1, yb + 0.12), 0.4, C.indTank);
    }
  }
  const cr = Math.max(0.9, r * 0.16);
  M.lathe(cx, cz, () => cr, yT - 0.3, yT + 0.6, 1, C.indShade, { seg: 12, flat: true });
  M.disc(cx, cz, 0, cr, yT + 0.6, C.indShade, { seg: 12 });
  M.box(cx - 0.3, yT + 0.6, cz - 0.3, cx + 0.3, yT + 1.8, cz + 0.3, C.indBase);
  // stair rail spiralling up the side
  const a0 = o.stairA != null ? o.stairA : Math.PI * 0.75;
  for (let k = 0; k < 6; k++) {
    const t0 = k / 6, t1 = (k + 1) / 6, rr = r + 0.6;
    M.beam(P(a0 + t0 * 1.6, rr, b0 + 0.8 + t0 * (h - 1)), P(a0 + t1 * 1.6, rr, b0 + 0.8 + t1 * (h - 1)), 0.45, C.indBase);
  }
  return b0 + h + hd;
}

// Tall silo: column skirt, collar, clean body with a seam and a crisp band,
// cone roof with an eaves rail, roof hut and a ladder. r6: flat-faceted body
// (o.smooth = old round shading), o.ribs = proud flutes on every other facet
// edge, o.plinth = ref05's wide stepped round base, o.flatTop = a flat
// textured roof (walkway ring, vents, filter boxes) instead of the cone.
// r11 (critic r10: "our silos and tanks are smooth plain cylinders … give the
// tanks ribs and bands, catwalks, ladders and roof domes"): proud stiffener
// rings round the shell, a caged ladder (rails, hoops, cage bars) with railed
// rest landings, used by every surf silo / tank taller than 9.
function tankDress(M, cx, cz, r, yb, yt, o = {}) {
  const seg = o.seg || 24, F = { seg, flat: true }, rc = o.ringC != null ? o.ringC : C.indShade;
  const Hh = yt - yb, la = o.la != null ? o.la : Math.PI;
  const n = Math.max(2, Math.round(Hh / 3.4));
  for (let k = 1; k < n; k++) {
    const y = yb + Hh * k / n;
    M.lathe(cx, cz, () => r + 0.2, y - 0.2, y + 0.2, 1, rc, F);             // (no top disc: 0.2 proud, never seen — half the tris)
  }
  if (o.cage === false) return;
  // caged ladder
  const ca = Math.cos(la), sa = Math.sin(la), tx = -sa, tz = ca;
  const at = (rr, t, y) => [cx + ca * rr + tx * t, y, cz + sa * rr + tz * t];
  const ry = r + 0.35, cy = r + 1.25, lc = C.indBase, cc = o.cageC != null ? o.cageC : C.yellow;
  for (const t of [-0.3, 0.3]) M.beam(at(ry, t, yb), at(ry, t, yt + 1.2), 0.16, lc);
  const c0 = yb + Math.min(3, Hh * 0.25);
  for (const t of [-0.6, 0, 0.6]) M.beam(at(cy, t, c0), at(cy, t, yt + 1.2), 0.12, cc);
  for (let y = c0; y <= yt + 0.6; y += 2.2) {
    M.beam(at(ry, -0.6, y), at(cy, -0.6, y), 0.13, cc);
    M.beam(at(cy, -0.6, y), at(cy, 0.6, y), 0.13, cc);
    M.beam(at(ry, 0.6, y), at(cy, 0.6, y), 0.13, cc);
  }
  // railed rest landings on a long climb (every ~12)
  const nl = o.landings != null ? o.landings : Math.floor(Hh / 12);
  for (let k = 1; k <= nl; k++) {
    const y = yb + Hh * k / (nl + 1), a0 = la + 0.18, a1 = la + 0.18 + Math.min(1.1, 5 / r);
    M.arc(cx, cz, r, r + 1.4, a0, a1, y, 0.25, C.indShade, 4);
    M.arc(cx, cz, r + 1.28, r + 1.42, a0, a1, y + 1.1, 0.14, cc, 4);
    for (const a of [a1, (a0 + a1) / 2]) M.beam([cx + Math.cos(a) * (r + 1.35), y, cz + Math.sin(a) * (r + 1.35)], [cx + Math.cos(a) * (r + 1.35), y + 1.1, cz + Math.sin(a) * (r + 1.35)], 0.12, cc);
  }
}

function surfSilo(M, cx, cz, g, r, h, o = {}) {
  const seg = o.seg || 24, body = o.c != null ? o.c : C.indTank, L = o.legs || 3.5;
  const F = o.smooth ? { seg } : { seg, flat: true }, da = 2 * Math.PI / seg;
  const P = (a, rr, y) => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
  if (o.plinth) {
    M.lathe(cx, cz, () => r + 2.6, g, g + 1, 1, C.indShade, F); M.disc(cx, cz, r + 1.6, r + 2.6, g + 1, C.indShade, { seg });
    M.lathe(cx, cz, () => r + 1.6, g + 1, g + 2.2, 1, C.indTank, F); M.disc(cx, cz, 0, r + 1.6, g + 2.2, C.indTank, { seg });
    g += 2.2;
  } else { M.lathe(cx, cz, () => r + 1, g, g + 0.5, 1, C.indShade, F); M.disc(cx, cz, 0, r + 1, g + 0.5, C.indShade, { seg }); }
  M.lathe(cx, cz, () => r - 0.7, g + 0.5, g + L, 1, C.indRoof, { ...F, ao: (y) => 0.5 + 0.5 * (y - g) / L });
  const nleg = o.nleg || Math.max(6, Math.round(r * 2.4));
  for (let k = 0; k < nleg; k++) { const a = (k + 0.5) / nleg * Math.PI * 2; M.beam(P(a, r - 0.4, g + 0.5), P(a, r - 0.4, g + L), 0.65, o.plinth ? C.indTank : C.indShade); }
  M.lathe(cx, cz, () => r + 0.35, g + L, g + L + 0.8, 1, C.indShade, F); M.disc(cx, cz, r, r + 0.35, g + L + 0.8, C.indShade, { seg });
  M.disc(cx, cz, r - 0.7, r + 0.35, g + L, C.indShade, { seg, down: true });
  const top = g + h, seam = g + L + (h - L) * 0.45;
  // stripes: [down-from-top 0, down-from-top 1, colour] (default: one band near the top)
  const st = (o.stripes || (o.band != null ? [[4.2, 3, o.band]] : [])).map(([a, b, c]) => [top - a, top - b, c]).sort((p, q) => p[0] - q[0]);
  const cuts = [];
  let y = g + L + 0.8;
  const run = (y1) => { if (y1 > y + 1e-3) { if (seam > y && seam + 0.4 < y1 && o.seam !== false) { cuts.push([y, seam, body], [seam, seam + 0.4, C.indShade]); y = seam + 0.4; } cuts.push([y, y1, body]); y = y1; } };
  for (const [a, b, c] of st) { run(a); cuts.push([a, b, c]); y = b; }
  run(top);
  for (const [y0, y1, c] of cuts) M.lathe(cx, cz, () => r, y0, y1, 1, c, F);
  if (o.ribs) for (let q = 0; q < seg; q += 2) M.beam(P(q * da, r + 0.1, g + L + 0.8), P(q * da, r + 0.1, top), 0.36, C.white);
  const la = o.ladderA != null ? o.ladderA : Math.PI;
  if (o.dress !== false && h >= 9) tankDress(M, cx, cz, r, g + L + 0.8, top, { la, seg, ringC: o.ringC, landings: o.landings, cage: o.cage });
  else M.beam(P(la, r + 0.4, g + L + 0.8), P(la, r + 0.4, top + 0.6), 0.4, C.indBase);
  if (o.flatTop) {
    // flat roof: light rim + rail, darker deck carrying filter boxes and vents
    M.lathe(cx, cz, () => r + 0.3, top, top + 0.7, 1, C.white, F);
    M.disc(cx, cz, r - 0.6, r + 0.3, top + 0.7, C.white, { seg });
    M.lathe(cx, cz, () => r - 0.6, top + 0.2, top + 0.7, 1, C.indShade, { ...F, in: true });
    M.disc(cx, cz, 0, r - 0.6, top + 0.2, C.indRoofLt, { seg });
    for (let q = 0; q < seg; q += 2) M.beam(P(q * da, r + 0.1, top + 0.7), P(q * da, r + 0.1, top + 1.6), 0.18, C.indBase);
    M.lathe(cx, cz, () => r + 0.1, top + 1.5, top + 1.75, 1, C.indBase, F);
    const bx = [[-0.45, -0.3, 0.9, 1.1, C.indShade], [0.35, 0.25, 0.8, 0.8, C.indTank], [-0.2, 0.45, 0.6, 1.4, C.indBase], [0.5, -0.45, 0.5, 0.6, C.indShade]];
    for (const [fx, fz, s, hh, c] of bx) { const x = cx + fx * r, z = cz + fz * r; M.box(x - s, top + 0.2, z - s, x + s, top + 0.2 + hh, z + s, c); }
    M.box(cx - 0.25, top + 0.2, cz - 0.25, cx + 0.25, top + 2.4, cz + 0.25, C.indBase);
    return top + 2.4;
  }
  if (o.domeTop) {
    // r11: ribbed spherical roof dome (ref05's tank farm) with an eaves
    // walkway + handrail ring, a crown hatch and a vent
    const hd = r * 0.42, Rs = (r * r + hd * hd) / (2 * hd), yc = top + hd - Rs;
    const rs = (yy) => Math.sqrt(Math.max(0, Rs * Rs - (yy - yc) * (yy - yc)));
    const yT = top + hd - 0.25, dc = o.top != null ? o.top : C.white;
    M.disc(cx, cz, r - 0.2, r + 0.9, top, C.indShade, { seg });                         // eaves walkway
    M.lathe(cx, cz, () => r + 0.9, top - 0.3, top, 1, C.indShade, F);
    M.lathe(cx, cz, () => r + 0.85, top + 1.0, top + 1.2, 1, C.indBase, F);              // handrail
    for (let q = 0; q < seg; q += 3) M.beam(P(q * da, r + 0.85, top), P(q * da, r + 0.85, top + 1.1), 0.12, C.indBase);
    M.lathe(cx, cz, rs, top, yT, 4, dc, F);
    M.disc(cx, cz, 0, rs(yT), yT, dc, { seg });
    for (let q = 0; q < seg; q += 2) {
      const a = q * da;
      for (let k = 0; k < 4; k++) {
        const ya = top + (yT - 0.15 - top) * k / 4, yb = top + (yT - 0.15 - top) * (k + 1) / 4;
        M.beam(P(a, rs(ya) + 0.08, ya + 0.1), P(a, rs(yb) + 0.08, yb + 0.1), 0.26, o.ribC != null ? o.ribC : C.indShade);
      }
    }
    const cr = Math.max(0.8, r * 0.2);
    M.lathe(cx, cz, () => cr, yT - 0.2, yT + 0.5, 1, C.indShade, { seg: 12, flat: true });
    M.disc(cx, cz, 0, cr, yT + 0.5, C.indRoofLt, { seg: 12 });
    M.box(cx + r * 0.35 - 0.3, top + hd * 0.5, cz - 0.3, cx + r * 0.35 + 0.3, top + hd + 0.9, cz + 0.3, C.indBase);
    return yT + 0.5;
  }
  const hc = o.coneH || r * 0.45, tipR = o.tip != null ? o.tip : 0.75;
  M.lathe(cx, cz, (yy) => r + 0.15 - (r + 0.15 - tipR) * (yy - top) / hc, top, top + hc, 2, o.top != null ? o.top : C.white, F);
  M.disc(cx, cz, 0, tipR, top + hc, o.tipC != null ? o.tipC : C.indShade, { seg: 16 });
  if (o.rail !== false) M.lathe(cx, cz, () => r + 0.35, top + 0.5, top + 0.9, 1, C.indBase, F);      // eaves rail
  if (o.hut !== false) {
    const hw = Math.min(1, r * 0.3);
    M.box(cx - hw, top + hc * 0.4, cz - hw - 0.2, cx + hw, top + hc + 1.2, cz + hw * 0.6, C.indShade);   // roof hut
    M.box(cx - hw - 0.1, top + hc + 1.2, cz - hw - 0.3, cx + hw + 0.1, top + hc + 1.5, cz + hw * 0.6 + 0.1, C.indBase);
  }
  return top + hc + 1.5;
}

// Round smoke stack: concrete foot, clean body, crisp stripes near the top,
// a light rim and a soot-grey mouth.
function surfStack(M, cx, cz, g, r, top, o = {}) {
  const seg = o.seg || 28;
  M.lathe(cx, cz, () => r + 0.7, g, g + 1.5, 1, C.indShade, { seg }); M.disc(cx, cz, r, r + 0.7, g + 1.5, C.indShade, { seg });
  const cuts = [];
  if (o.style === 'classic' || (o.body != null && o.body !== C.white && o.body !== C.indTank)) {
    // brick / coloured flue (bakery, cookie): body + a few painted bands
    const body = o.body != null ? o.body : C.indTank, stripe = o.stripe != null ? o.stripe : C.orange;
    const nb = o.bands != null ? o.bands : 2, bh = o.bandH || 5, gap = o.gap || bh;
    let y = top - 1.5;
    for (let k = 0; k < nb; k++) { cuts.push([y - bh, y, stripe]); y -= bh; if (k + 1 < nb) { cuts.push([y - gap, y, body]); y -= gap; } }
    cuts.push([g + 1.5, y, body]);
    for (const [y0, y1, c] of cuts) M.lathe(cx, cz, () => r, y0, y1, 1, c, { seg });
    M.lathe(cx, cz, () => r + 0.4, top - 1.5, top, 1, C.indBase, { seg });
  } else {
    // r12 (critic r11: "every stack uses the same orange/white or pink/white
    // candy stripe … toy-like next to the ref's weathered bronze/black
    // stacks"): ref05's power stacks — a concrete foot, a long weathered
    // bronze shaft, one wide white band, a black band and a black cap lip
    // w2 r1 (coordinator 22:35, ref05 crop: "tall white with bold orange
    // bands and a dark cap"): white head band under the dark cap, a long
    // orange band, a second white band, orange down to the concrete foot
    const L = top - g, bh = Math.max(2.5, L * 0.075), oc = o.stripe != null && o.stripe !== C.orange ? o.stripe : C.indBronze;
    const yCap = top - 1.6, yW1 = yCap - bh * 1.3, yO1 = yW1 - bh * 2.6, yW2 = yO1 - bh * 1.1, yFoot = g + 1.5 + L * 0.1;
    cuts.push([yW1, yCap, C.white], [yO1, yW1, oc], [yW2, yO1, C.white], [yFoot, yW2, oc], [g + 1.5, yFoot, C.indShade]);
    for (const [y0, y1, c] of cuts) if (y1 > y0) M.lathe(cx, cz, () => r, y0, y1, 1, c, { seg });
    M.lathe(cx, cz, () => r + 0.3, yFoot - 0.3, yFoot, 1, C.indBase, { seg });            // foot collar
    M.lathe(cx, cz, () => r + 0.4, yCap, top, 1, C.darkGray, { seg });                    // black cap lip
  }
  M.disc(cx, cz, r - 0.4, r + 0.4, top, o.style === 'classic' ? C.indBase : C.vehCharcoal, { seg });
  M.lathe(cx, cz, () => r - 0.4, top - 1.2, top, 1, C.darkGray, { seg, in: true });
  M.disc(cx, cz, 0, r - 0.4, top - 1.2, C.darkGray, { seg });
  return top;
}

// Smooth rocket in fine voxels (res 8): white body r 8 with crisp red rings,
// a porthole band, "BV" wrapped round the hull on all four sides, a nested
// nose cone, four red fins and two side boosters with red noses.
function fineRocket(F, cx, cz, yb, yt, accent) {
  const r = 8, L = yt - yb, jf = (f) => Math.round(f * L);
  for (let y = yb; y <= yt; y++) {
    const j = y - yb;
    let c = C.white;
    if (j < 10 || (j >= jf(0.435) && j < jf(0.435) + 6) || (j >= jf(0.9) && j < jf(0.9) + 4)) c = C.darkGray;   // r12: launcher black bands, not toy red
    else if (j === jf(0.63) || j === jf(0.63) + 1) c = C.indBase;
    ring(F, cx, cz, r, y, y, c);
  }
  disc(F, cx, cz, r, yt, C.white);
  // wrap text / windows onto the hull: colour the outermost voxel along each axis
  const ro = ringOff(r);
  const paint = (side, du, y, c) => {
    let best = null;
    for (const [dx, dz] of ro) {
      const along = side === 'front' || side === 'back' ? dx : dz;
      if (along !== du) continue;
      const depth = side === 'front' ? -dz : side === 'back' ? dz : side === 'left' ? -dx : dx;
      if (!best || depth > best[2]) best = [dx, dz, depth];
    }
    if (best) F.set(cx + best[0], y, cz + best[1], c);
  };
  const glyph = (ch) => { const px = []; pixelText({ rd: 1, set(u, y) { px.push([u, y]); } }, 0, 0, ch, 0, 0); return px; };
  for (const side of ['front', 'back', 'left', 'right']) {
    const flip = side === 'back' || side === 'left' ? -1 : 1;
    for (const [ch, y] of [['B', yb + 40], ['V', yb + 24]]) for (const [pu, py] of glyph(ch)) {
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) paint(side, flip * (pu * 2 + a - 3), y + py * 2 + b, accent);
    }
    const wy = yb + jf(0.72);
    for (let du = -2; du <= 2; du++) for (let y = wy; y <= wy + 5; y++) paint(side, du, y, du === -2 || du === 2 || y === wy || y === wy + 5 ? C.indShade : C.winCool);
  }
  // nose cone: nested shapes, one ring in every 4 layers
  const fam = nestedShapes(r, r);
  const hc = 32;
  for (let i = 0; i < hc; i++) {
    const e = Math.min(r, Math.round(r * Math.pow(i / hc, 1.3)));
    if (!fam.shapes[e] || !fam.shapes[e].length) break;
    for (const [dx, dz] of fam.shapes[e]) F.set(cx + dx, yt + 1 + i, cz + dz, i < 4 ? C.indWall : C.indBase);
  }
  F.box(cx, yt + hc, cz, cx, yt + hc + 8, cz, C.indShade);
  // fins (2 thick) on the four axes
  for (let q = 0; q < 24; q++) {
    const reach = Math.max(1, Math.round(10 * (1 - q / 24)));
    for (let t = r + 1; t <= r + reach; t++) for (const w of [0, 1]) {
      F.set(cx + t, yb + q, cz + w, C.darkGray); F.set(cx - t, yb + q, cz - w, C.darkGray);
      F.set(cx + w, yb + q, cz + t, C.darkGray); F.set(cx - w, yb + q, cz - t, C.darkGray);
    }
  }
  // side boosters
  for (const sgn of [-1, 1]) {
    const bz = cz + sgn * 14, br = 4;
    const bh = jf(0.45);
    for (let y = yb; y <= yb + bh; y++) ring(F, cx, bz, br, y, y, y - yb < 8 ? C.indBase : (y - yb >= bh - 14 && y - yb < bh - 10) ? accent : C.indWall);
    const bf = nestedShapes(br, br);
    for (let i = 0; i < 12; i++) { const e = Math.min(br, Math.round(br * i / 12)); if (!bf.shapes[e].length) break; for (const [dx, dz] of bf.shapes[e]) F.set(cx + dx, yb + bh + 1 + i, bz + dz, C.indBase); }
  }
}


// ===========================================================================
// YARD FILL — r6. The r5 critic: our power plant was "a few clean primitives
// on a sparse grey plinth with empty paving between the buildings"; ref05
// "fills every gap on the lot with pipe racks, crates, small blue and white
// tanks, rooftop HVAC boxes, fences, and yellow hazard clutter". After a big
// lot is laid out, yardFill() finds every free rectangle of paving (nothing
// in the first few voxels above the lot, not a lane, not under a smooth
// hero) and drops a tidy cluster sized to it: a fenced row of blue / white
// tanks, a pipe rack over yellow skids, a row of chiller boxes, a pallet
// yard, or small stuff (drums, gas bottles, a hazard-painted cabinet).
//   o.keep = [[cx, cz, r], ...] circles to leave clear (surf heroes)
//   o.box  = [x0, z0, x1, z1] region to fill (design coords)
//   o.skip = [[x0, z0, x1, z1], ...] rects to leave clear (truck yards, drives)
// Works on a plain grid or a rot180 view (g.rot180 = true).
// ===========================================================================
function yardFill(g, y0, rng, o = {}) {
  const S = g.sx, rot = !!g.rot180, yl = y0 - 1;
  const key = (x, y, z) => (rot ? (S - 1 - x) + ',' + y + ',' + (S - 1 - z) : x + ',' + y + ',' + z);
  const [bx0, bz0, bx1, bz1] = o.box || [2, 2, S - 3, S - 3];
  const busy = new Uint8Array(S * S);
  const keep = o.keep || [];
  const laneC = new Set([C.indLine, C.lotAsphalt, C.lotLine, C.yellow, C.black, C.indYard, C.lotGrass, C.lotRim]);   // r9: + planted strips / kerbs
  const col = new Uint8Array(S * S);            // any voxel in the column above the lot (halls are hollow!)
  for (const k of g.map.keys()) {
    const i1 = k.indexOf(','), i2 = k.indexOf(',', i1 + 1);
    if (+k.slice(i1 + 1, i2) < y0) continue;
    let x = +k.slice(0, i1), z = +k.slice(i2 + 1);
    if (rot) { x = S - 1 - x; z = S - 1 - z; }
    col[z * S + x] = 1;
  }
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) {
    let b = x < bx0 || x > bx1 || z < bz0 || z > bz1 || !!col[z * S + x];
    if (!b && laneC.has(g.map.get(key(x, yl, z)))) { busy[z * S + x] = 2; continue; }   // paint: busy, no walkway
    if (!b) for (const [cx, cz, r] of keep) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) < r) { b = true; break; }
    if (!b) for (const [p0, q0, p1, q1] of (o.skip || [])) if (x >= p0 && x <= p1 && z >= q0 && z <= q1) { b = true; break; }
    if (b) busy[z * S + x] = 1;
  }
  // grow the busy mask by 1 (a clear walkway round everything)
  const occ = busy.slice();
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) if (busy[z * S + x] === 1) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Z = z + dz; if (X >= 0 && Z >= 0 && X < S && Z < S) occ[Z * S + X] = 1; }
  }
  const free = (x, z) => x >= 0 && z >= 0 && x < S && z < S && !occ[z * S + x];
  const mark = (x0, z0, x1, z1) => { for (let z = z0 - 1; z <= z1 + 1; z++) for (let x = x0 - 1; x <= x1 + 1; x++) if (x >= 0 && z >= 0 && x < S && z < S) occ[z * S + x] = 1; };
  const maxL = o.maxL || 20;
  let n = 0;
  for (let z = bz0; z <= bz1; z++) for (let x = bx0; x <= bx1; x++) {
    if (!free(x, z)) continue;
    // the largest-area free rectangle anchored at (x, z)
    let wc = maxL, w = 0, d = 0, best = 0;
    for (let dd = 0; dd < maxL; dd++) {
      let run = 0; while (run < wc && free(x + run, z + dd)) run++;
      wc = run; if (!wc) break;
      const ar = wc * (dd + 1), ok = Math.min(wc, dd + 1) >= 4 ? 2 : Math.min(wc, dd + 1) >= 3 ? 1 : 0;
      const sc = ok * 10000 + ar;
      if (ok && sc > best) { best = sc; w = wc; d = dd + 1; }
    }
    if (!best) continue;
    // r12 (critic r11: "the lots are packed wall to wall with forklifts,
    // crates and trucks, so there is no quiet paved space"; ref05: open
    // asphalt yards with white stall lines + green strips): calm mode —
    // slivers become planted strips, every other big rect a striped stall
    // bay, and only the rest a process house / tank bund / pipe rack
    if (o.calm !== false) {
      // w2 r1 (coordinator 22:35: "yards packed with pipe racks, tanks,
      // crates"): the midpoint — slivers stay planted, one big rect in four
      // is a striped stall bay, the rest carry plant
      if (w < 3 || d < 3) calmStrip(g, x, z, w, d, y0);
      else if (w < 4 || d < 4) smallStuff(g, x, z, w, d, y0, rng);
      else if ((w * d < 30 && n % 2 === 1) || n % 4 === 3) calmStalls(g, x, z, w, d, y0);
      else cluster(g, x, z, w, d, y0, rng, n);
      n++; mark(x, z, x + w - 1, z + d - 1); continue;
    }
    if (w < 4 || d < 4) { smallStuff(g, x, z, w, d, y0, rng); mark(x, z, x + w - 1, z + d - 1); n++; continue; }
    cluster(g, x, z, w, d, y0, rng, n++);
    mark(x, z, x + w - 1, z + d - 1);
  }
  return n;
}
// r12 calm yard pieces: a kerbed planted strip with clipped shrubs, and an
// asphalt bay with white stall lines (ref05's truck yards)
function calmStrip(g, x, z, w, d, y0) {
  const yl = y0 - 1;
  g.box(x, yl, z, x + w - 1, yl, z + d - 1, C.lotGrass);
  if (w >= 2 && d >= 2) for (let a = 0; a < Math.max(w, d); a += 3) {
    const [p, q] = w >= d ? [x + a, z + ((d - 1) >> 1)] : [x + ((w - 1) >> 1), z + a];
    if (p < x + w && q < z + d) g.set(p, y0, q, C.bush);
  }
}
function calmStalls(g, x, z, w, d, y0) {
  const yl = y0 - 1, ax = w >= d;
  g.box(x, yl, z, x + w - 1, yl, z + d - 1, C.lotAsphalt);
  if (ax) { for (let u = x + 1; u <= x + w - 2; u += 4) for (let v = z + 1; v <= z + d - 1; v++) g.set(u, yl, v, C.lotLine); }
  else for (let v = z + 1; v <= z + d - 2; v += 4) for (let u = x + 1; u <= x + w - 1; u++) g.set(u, yl, v, C.lotLine);
}
// local frame helper: a along the long side, b across; returns design (x, z)
function _yf(x, z, w, d) {
  const ax = w >= d;
  return { A: ax ? w : d, B: ax ? d : w, ax, at: (a, b) => (ax ? [x + a, z + b] : [x + b, z + a]) };
}
function cluster(g, x, z, w, d, y0, rng, i) {
  const f = _yf(x, z, w, d), { A, B } = f;
  let k = rng();
  const box = (a0, ya, b0, a1, yb, b1, c) => { const [p, q] = f.at(a0, b0), [r, s] = f.at(a1, b1); g.box(p, ya, q, r, yb, s, c); };
  const pad = (c) => box(0, y0 - 1, 0, A - 1, y0 - 1, B - 1, c);
  if (A >= 10 && B >= 8 && (k < 0.3 || i % 3 === 0)) {
    // r7 (critic r6: ref05's plant lots are "filled to their edges" with mid-size
    // process buildings): a small navy / white / steel process house with white
    // pilasters, a roll door, a band, a roof unit and a vent, piped to the ground
    const L = Math.min(A, 16), Wd = Math.min(B, 11), h = 9 + ((i * 5) % 7);
    const [p0, q0] = f.at(0, 0), [p1, q1] = f.at(L - 1, Wd - 1);
    const xa = Math.min(p0, p1), xb = Math.max(p0, p1), za = Math.min(q0, q1), zb = Math.max(q0, q1);
    const wall = [C.indCorr, C.indWall, C.indSteel][i % 3];   // w2 r1: light bodies (coordinator 22:35)
    const t = hall(g, xa + 1, za + 1, xb - 1, zb - 1, y0, h, { wall, trim: wall === C.indWall ? C.indShade : C.indWall, roof: C.indRoofLt, band: [y0 + h - 3, wall === C.indWall ? C.indBlue : C.white, 1] });
    if (xb - xa >= 6) {
      const Fz = facade(g, 'front', za + 1), Bz = facade(g, 'back', zb - 1);
      rollDoor(Fz, xa + 3, xa + 5, y0, 5, { bollards: false, hood: C.indBlue });
      ribbon(Bz, xa + 3, xb - 3, y0 + 4, 2, { glass: C.dtGlass, frame: C.indWall });
    }
    if (zb - za >= 6) { ribbon(facade(g, 'left', xa + 1), za + 3, zb - 3, y0 + 4, 2, { glass: C.dtGlass, frame: C.indWall }); ribbon(facade(g, 'right', xb - 1), za + 3, zb - 3, y0 + 4, 2, { glass: C.dtGlass, frame: C.indWall }); }
    acBox(g, xa + 2, t, za + 2, { w: Math.min(5, xb - xa - 3), d: Math.min(4, zb - za - 3), h: 3, body: C.offwhite });
    if (xb - xa >= 9) ventPipe(g, xb - 2, zb - 2, t, t + 4);
    return;
  }
  k = rng();
  if (A >= 10 && B >= 6 && k < 0.34) {
    // fenced bund with a row of small blue / white tanks + a header pipe
    pad(C.indShade);
    const fx = (a0, a1, b) => { for (let a = a0; a <= a1; a++) { const [p, q] = f.at(a, b); g.set(p, y0 + 3, q, C.metal); if ((a - a0) % 3 === 0) g.box(p, y0, q, p, y0 + 3, q, C.metalDark); } };
    const fb = (b0, b1, a) => { for (let b = b0; b <= b1; b++) { const [p, q] = f.at(a, b); g.set(p, y0 + 3, q, C.metal); if ((b - b0) % 3 === 0) g.box(p, y0, q, p, y0 + 3, q, C.metalDark); } };
    fx(0, A - 1, 0); fx(0, A - 1, B - 1); fb(0, B - 1, 0); fb(0, B - 1, A - 1);
    const nt = Math.floor((A - 2) / 6), off = Math.floor((A - nt * 6) / 2) + 2, bc = Math.floor(B / 2);
    for (let t = 0; t < nt; t++) {
      const [cx, cz] = f.at(off + t * 6, bc), blue = (t + i) % 3 === 1, h = 5 + ((t + i) % 2) * 2;
      cylinder(g, cx, cz, 2, y0, y0 + h, blue ? C.indBlue : C.indTank, blue ? C.white : C.indBlue);
      ring(g, cx, cz, 2, y0 + 1, y0 + 1, blue ? C.white : C.indBlue);
      disc(g, cx, cz, 1, y0 + h + 1, blue ? C.indShade : C.white);
      g.set(cx, y0 + h + 2, cz, C.indBase);
    }
    if (B >= 7) box(1, y0 + 4, B - 2, A - 2, y0 + 4, B - 2, C.yellow);
    return;
  }
  if (A >= 12 && k < 0.6) {
    // pipe rack along the long side, yellow skids + pumps underneath
    const cols = [C.yellow, C.indShade, C.indBlue].slice(0, Math.max(1, Math.min(3, Math.floor((B - 1) / 3))));
    const W = cols.length * 3 - 1, b0 = Math.max(1, (B - W) >> 1);
    const [p0, q0] = f.at(0, 0);
    if (f.ax) pipeRack(g, 'x', x, x + A - 1, z + b0, y0 + 8, cols, y0, 6);
    else pipeRack(g, 'z', z, z + A - 1, x + b0, y0 + 8, cols, y0, 6);
    for (let a = 2; a + 3 < A - 1; a += 6) {
      box(a, y0, b0, a + 2, y0 + 1, b0 + Math.min(W - 1, 2), a % 12 === 2 ? C.yellow : C.indBlue);
      box(a + 1, y0 + 2, b0 + 1, a + 1, y0 + 3, b0 + 1, C.indBase);
    }
    return;
  }
  if (A >= 11 && B >= 5 && k < 0.8) {
    // chiller / HVAC row on a raised pad
    pad(C.indBase);
    for (let a = 0; a + 4 < A; a += 6) {
      const [p, q] = f.at(a, 0), [r, s] = f.at(a + 4, Math.min(B - 1, 4));
      acBox(g, Math.min(p, r), y0, Math.min(q, s), { w: Math.abs(r - p) + 1, d: Math.abs(s - q) + 1, h: 4, body: (a / 6 + i) % 2 ? C.indRoof : C.vehCharcoal, trim: C.black });
    }
    return;
  }
  if (A >= 7 && B >= 6) {
    const cols = pk(rng, [[C.white, C.offwhite], [C.wood, C.plank], [C.indBlue, C.white], [C.offwhite, C.indShade]]);
    const x1 = x + w - 1, z1 = z + d - 1;
    palletYard(g, x, z, x1, z1, y0, cols, rng);
    if (w >= 11 && d >= 8) forklift(g, x + w - 5, y0, z + d - 1 - 4, 'x', -1);
    return;
  }
  smallStuff(g, x, z, w, d, y0, rng);
}
function smallStuff(g, x, z, w, d, y0, rng) {
  // a strip: one small thing every 6 voxels along its long side
  const ax = w >= d, A = ax ? w : d;
  for (let a = 0; a + 3 <= A; a += 6) {
    const L = Math.min(5, A - a);
    if (ax) smallOne(g, x + a, z, L, Math.min(d, 5), y0, rng);
    else smallOne(g, x, z + a, Math.min(w, 5), L, y0, rng);
  }
}
function smallOne(g, x, z, w, d, y0, rng) {
  const k = rng();
  if (k < 0.3) { for (let a = 0; a + 1 < w; a += 3) for (let b = 0; b + 1 < d; b += 3) barrel(g, x + a, y0, z + b, (a + b) % 6 ? C.yellow : C.indBlue); return; }
  if (k < 0.55 && w >= 5) { gasBottles(g, x + 1, y0, z + 1, Math.min(4, (w - 1) >> 1), pk(rng, [C.orange, C.indBlue, C.yellow])); return; }
  if (k < 0.8) {
    hazard(g, x, z, x + Math.min(w, 5) - 1, z + Math.min(d, 5) - 1, y0 - 1);
    g.box(x + 1, y0, z + 1, x + Math.min(w, 5) - 2, y0 + 3, z + Math.min(d, 5) - 2, C.indShade);
    g.box(x + 1, y0 + 4, z + 1, x + Math.min(w, 5) - 2, y0 + 4, z + Math.min(d, 5) - 2, C.yellow);
    return;
  }
  for (let a = 0; a + 1 < w; a += 3) g.box(x + a, y0, z + 1, x + a + 1, y0 + 1, z + Math.min(d, 3) - 1, a % 6 ? C.yellow : C.orange);
}

// ===========================================================================
// FINE DETAIL KIT — r8. The r7 critic: our industry was "big clean boxes: flat
// grey roofs with a few AC cubes, long bare wall faces"; ref05's district
// "covers every roof and yard with small parts: exposed pipe runs linking
// buildings, catwalks and gantries, clusters of small tanks and vents on
// rooftops … our scale is chunkier, so ours reads as toy blocks". So roofs and
// walls are now dressed in the res-8 FINE part (half-size voxels: small parts
// at ref05's scale) and pipe bridges between buildings are smooth surf beams.
// Both parts are cached per model key, so everything here is deterministic
// (seeded from its own coordinates) and only reads base voxels that are
// themselves deterministic (halls, pads — never rng-placed clutter).
// ===========================================================================
function srng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hseed = (...a) => a.reduce((h, v) => (Math.imul(h ^ Math.round(v * 16), 2654435761) >>> 0), 2166136261);

// One rooftop item in a fine rect (x, z, w×d) standing on Y. Kinds:
// condenser, fan, vents, tank, duct, cabinets, glass, water tower.
function fineItem(F, x, z, w, d, Y, kind, rnd, o = {}) {
  const x1 = x + w - 1, z1 = z + d - 1, acc = o.accent != null ? o.accent : C.indBlue;
  // w2 r1 (coordinator 22:35: "mid grey roofs densely covered in DARKER
  // grey/charcoal equipment"): light concrete curbs carrying charcoal units
  F.box(x, Y, z, x1, Y, z1, o.pad != null ? o.pad : C.indShade);          // module pad / curb
  const y = Y + 1;
  switch (kind) {
    case 'cond': {                                                         // condenser, louvred, 1-2 fans
      const h = 3 + (rnd() < 0.5 ? 1 : 0), body = rnd() < 0.6 ? C.indRoof : C.vehCharcoal;
      F.box(x + 1, y, z + 1, x1 - 1, y + h - 1, z1 - 1, body);
      for (let yy = y + 1; yy < y + h - 1; yy += 2) { F.box(x + 2, yy, z + 1, x1 - 2, yy, z + 1, C.black); F.box(x + 2, yy, z1 - 1, x1 - 2, yy, z1 - 1, C.black); }
      const nf = w >= 10 ? 2 : 1, cz = (z + z1) >> 1;
      for (let i = 0; i < nf; i++) {
        const cx = x + 1 + Math.round((i + 0.5) * (w - 2) / nf);
        disc(F, cx, cz, Math.min(2, (d - 3) / 2), y + h - 1, C.black); F.set(cx, y + h - 1, cz, C.indBase);
      }
      break;
    }
    case 'fan': {                                                          // round fan housing on a curb
      const cx = (x + x1) >> 1, cz = (z + z1) >> 1, r = Math.min(w, d) / 2 - 1.2;
      F.box(cx - 2, y, cz - 2, cx + 2, y, cz + 2, C.indBase);
      cylinder(F, cx, cz, r, y + 1, y + 3, C.indRoof, false);
      disc(F, cx, cz, r - 1, y + 2, C.black);
      F.box(cx - 1, y + 3, cz, cx + 1, y + 3, cz, C.indBase); F.box(cx, y + 3, cz - 1, cx, y + 3, cz + 1, C.indBase);
      break;
    }
    case 'vents': {                                                        // cluster of little vent stacks
      for (let a = x + 1; a <= x1 - 1; a += 3) for (let b = z + 1; b <= z1 - 1; b += 3) {
        if (rnd() < 0.25) continue;
        const h = 2 + ((rnd() * 5) | 0);
        F.box(a, y, b, a, y + h, b, rnd() < 0.5 ? C.indRoof : C.indBase);
        if (rnd() < 0.6) F.box(a - 1, y + h + 1, b - 1, a + 1, y + h + 1, b + 1, C.vehCharcoal);
        else F.set(a, y + h + 1, b, C.black);
      }
      break;
    }
    case 'tank': {                                                         // small vertical tank, band, ladder
      const cx = (x + x1) >> 1, cz = (z + z1) >> 1, r = Math.min(w, d) / 2 - 1.3, h = 6 + ((rnd() * 5) | 0);
      const c = rnd() < 0.35 ? acc : C.indTank;
      cylinder(F, cx, cz, r, y, y + h, c, C.indShade);
      ring(F, cx, cz, r, y + h - 2, y + h - 2, c === acc ? C.white : acc);
      disc(F, cx, cz, Math.max(0.5, r - 1.5), y + h + 1, C.indShade);
      F.box(cx + Math.round(r) + 1, y, cz, cx + Math.round(r) + 1, y + h, cz, C.yellow);
      break;
    }
    case 'duct': {                                                         // duct run with an elbow + hood
      const ax = w >= d, L = ax ? w : d;
      const P = lf(F, x, y, z, ax ? 'x' : 'z', 1, L), wd = ax ? d : w, b0 = (wd - 3) >> 1;
      P.box(1, 0, b0, 1, 3, b0 + 2, C.indBase);
      P.box(1, 1, b0, L - 3, 3, b0 + 2, C.indBase);
      P.box(L - 4, 4, b0, L - 2, 6, b0 + 2, C.indBase);
      P.box(L - 5, 7, b0 - 1, L - 1, 7, b0 + 3, C.vehCharcoal);
      for (let a = 3; a < L - 4; a += 4) P.box(a, 1, b0 - 1, a, 3, b0 + 3, C.indRoof);   // flanges
      break;
    }
    case 'cab': {                                                          // electrical cabinets + conduit
      for (let a = x + 1; a + 2 <= x1 - 1; a += 4) {
        const h = 3 + ((rnd() * 3) | 0);
        F.box(a, y, z + 1, a + 2, y + h, z1 - 1, rnd() < 0.5 ? C.indRoof : C.vehCharcoal);
        F.box(a + 1, y + 1, z, a + 1, y + h - 1, z, C.black);
        F.box(a + 1, y + 1, z1, a + 1, y + h - 1, z1, C.black);
      }
      F.box(x + 1, y + 6, (z + z1) >> 1, x1 - 1, y + 6, (z + z1) >> 1, C.yellow);
      break;
    }
    case 'glass': {                                                        // glazed roof light, raised ridge
      F.box(x + 1, y, z + 1, x1 - 1, y, z1 - 1, C.white);
      for (let a = x + 2; a <= x1 - 2; a++) if ((a - x) % 3) for (let b = z + 2; b <= z1 - 2; b++) F.set(a, y, b, (a + b) % 5 ? C.dtGlass : C.dtGlassHi);
      F.box(x + 1, y + 1, (z + z1) >> 1, x1 - 1, y + 1, (z + z1) >> 1, C.white);
      break;
    }
    default: {                                                             // water tank on legs
      const cx = (x + x1) >> 1, cz = (z + z1) >> 1;
      for (const [a, b] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) F.box(cx + a, y, cz + b, cx + a, y + 3, cz + b, C.metalDark);
      F.box(cx - 2, y + 4, cz - 2, cx + 2, y + 4, cz + 2, C.indBase);
      cylinder(F, cx, cz, 2.2, y + 5, y + 9, acc, C.white);
      F.set(cx, y + 10, cz, C.indShade);
    }
  }
}
const FINE_KINDS = ['cond', 'cond', 'fan', 'vents', 'tank', 'duct', 'cab', 'glass', 'wtank'];

// Dense rooftop plant in the FINE part over a hall's roof deck: rows of
// module pads each carrying a unit, with pipe pairs laid along the aisles.
// Coarse rect (x0..x1, z0..z1) = the deck cells items may stand on; top =
// coarse y of the first free layer. Skips any cell the base already uses
// (pads, stacks' feet, sawtooth teeth) and o.keep circles (surf heroes).
function fineRoof(F, g, x0, z0, x1, z1, top, o = {}) {
  const rnd = srng(hseed(x0, z0, x1, z1, top, o.seed || 7));
  const X0 = 2 * x0, Z0 = 2 * z0, X1 = 2 * x1 + 1, Z1 = 2 * z1 + 1, Y = 2 * top;
  const W = X1 - X0 + 1, D = Z1 - Z0 + 1;
  if (W < 6 || D < 6) return;
  const occ = new Uint8Array(W * D), keep = o.keep || [];
  for (let fz = Z0; fz <= Z1; fz++) for (let fx = X0; fx <= X1; fx++) {
    const cx = fx >> 1, cz = fz >> 1;
    let b = gget(g, cx, top, cz) != null || gget(g, cx, top + 1, cz) != null;
    if (!b) for (const [kx, kz, r] of keep) if (Math.hypot((fx + 0.5) / 2 - kx, (fz + 0.5) / 2 - kz) < r) { b = true; break; }
    if (b) occ[(fz - Z0) * W + (fx - X0)] = 1;
  }
  const free = (x, z, w, d) => {
    for (let b = z; b < z + d; b++) for (let a = x; a < x + w; a++) {
      if (a < X0 || b < Z0 || a > X1 || b > Z1) { if (a >= x && a < x + w && b >= z && b < z + d) return false; continue; }
      if (occ[(b - Z0) * W + (a - X0)]) return false;
    }
    return true;
  };
  const take = (x, z, w, d) => { for (let b = z; b < z + d; b++) for (let a = x; a < x + w; a++) if (a >= X0 && b >= Z0 && a <= X1 && b <= Z1) occ[(b - Z0) * W + (a - X0)] = 1; };
  const kinds = o.kinds || FINE_KINDS;
  if (globalThis.__IND_DBG) { let rows = []; for (let fz = Z0; fz <= Z1; fz += 2) { let r = ''; for (let fx = X0; fx <= X1; fx += 2) r += occ[(fz - Z0) * W + (fx - X0)] ? '#' : '.'; rows.push(r); } console.log('fineRoof', x0, z0, x1, z1, top, '\n' + rows.join('\n')); }
  const base = occ.slice();
  // pipe pairs along reserved aisles (every ~16 fine voxels), laid after the units
  const pipes = [];
  // r12 (critic r11: "cut the small rooftop clutter" — ref05's roofs read as
  // calm charcoal decks with a few big units): only a share of the free
  // module slots gets a unit; the rest stays bare deck
  const dens = o.density != null ? o.density : 0.72;   // w2 r1: loaded roofs (coordinator 22:35)
  if (D >= 34 && dens > 0.3) for (let z = Z0 + 8 + ((rnd() * 5) | 0); z + 1 <= Z1 - 4; z += 15 + ((rnd() * 6) | 0)) {
    let fr = 0; for (let x = X0; x <= X1; x++) if (!base[(z - Z0) * W + (x - X0)] && !base[(z + 1 - Z0) * W + (x - X0)]) fr++;
    if (fr < W * 0.5) continue;
    pipes.push(z); for (let x = X0; x <= X1; x++) for (const zz of [z, z + 1]) occ[(zz - Z0) * W + (x - X0)] = 1; }
  // greedy scan: at every free cell try a unit, shrinking it until it fits,
  // so pads pack round skylights, stacks and huts instead of leaving gaps
  const sizeOf = (k) => (k === 'duct' ? [12 + ((rnd() * 6) | 0), 5] : k === 'cond' || k === 'cab' || k === 'glass' ? [8 + ((rnd() * 5) | 0), 6 + ((rnd() * 3) | 0)] : [7, 7]);
  for (let z = Z0 + 1; z + 4 <= Z1; z++) for (let x = X0 + 1; x + 4 <= X1; x++) {
    if (occ[(z - Z0) * W + (x - X0)]) continue;
    const kind = kinds[(rnd() * kinds.length) | 0];
    let [w, d] = sizeOf(kind);
    if (rnd() < 0.5 && kind !== 'duct') [w, d] = [d, w];
    let ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      const ww = Math.min(w - t * 2, X1 - x), dd = Math.min(d - t, Z1 - z);
      if (ww >= 5 && dd >= 5 && free(x, z, ww, dd)) { w = ww; d = dd; ok = true; }
    }
    if (!ok && free(x, z, 4, 4)) { if (rnd() < dens * 0.5) fineItem(F, x, z, 4, 4, Y, 'vents', rnd, o); take(x - 1, z - 1, 6, 6); continue; }
    if (!ok) continue;
    if (rnd() > dens) { take(x - 1, z - 1, w + 3, d + 3); continue; }
    fineItem(F, x, z, w, d, Y, w < 7 || d < 6 ? (kind === 'duct' || kind === 'glass' ? 'vents' : kind) : kind, rnd, o);
    take(x - 1, z - 1, w + 3, d + 3);                   // + a 2-voxel aisle
  }
  const pc = o.pipes || [C.yellow, C.indShade];
  for (const pz of pipes) {
    let run = [];
    const flush = () => {
      if (run.length >= 8) {
        const a = run[0], b = run[run.length - 1];
        F.box(a, Y + 2, pz, b, Y + 2, pz, pc[0]); F.box(a, Y + 1, pz + 1, b, Y + 1, pz + 1, pc[1]);
        for (let s = a + 1; s < b; s += 6) F.box(s, Y, pz, s, Y + 1, pz, C.indBase);
      }
      run = [];
    };
    for (let x = X0; x <= X1; x++) {
      const ok = pz + 1 <= Z1 && !base[(pz - Z0) * W + (x - X0)] && !base[(pz + 1 - Z0) * W + (x - X0)];
      if (ok) run.push(x); else flush();
    }
    flush();
  }
}

// Wall dressing in the FINE part: downpipes with brackets, a pipe pair along
// the wall that drops to a pump skid, wall-mounted AC boxes and an access
// ladder, so no long facade stays one plain surface. Coarse inputs: side +
// plane (the hall wall), u0..u1 span, y0 ground, y1 top of the wall.
function fineWall(F, side, plane, u0, u1, y0, y1, o = {}) {
  const rnd = srng(hseed(plane, u0, u1, y0, y1, side.length, o.seed || 3));
  const fp = side === 'back' || side === 'right' ? 2 * plane + 1 : 2 * plane;
  const f = facade(F, side, fp), U0 = 2 * u0, U1 = 2 * u1 + 1, Y0 = 2 * y0, Y1 = 2 * y1;
  const skip = (o.skip || []).map(([a, b]) => [2 * a - 1, 2 * b + 2]);
  const clear = (u) => !skip.some(([a, b]) => u >= a && u <= b);
  const dp = o.down != null ? o.down : C.indShade;
  // downpipes every ~14-20 fine voxels
  for (let u = U0 + 3 + ((rnd() * 4) | 0); u <= U1 - 2; u += 14 + ((rnd() * 7) | 0)) {
    if (!clear(u)) continue;
    f.box(u, Y0 + 1, 2, u, Y1 - 1, 2, dp);
    f.box(u - 1, Y1 - 2, 1, u + 1, Y1, 3, dp);                                // hopper head
    for (let y = Y0 + 6; y < Y1 - 3; y += 9) f.set(u, y, 1, C.indBase);
    f.box(u, Y0, 2, u, Y0, 3, dp);
  }
  // a pipe pair along the wall + a drop to a pump skid at one end
  if (o.pipe !== false && U1 - U0 >= 16) {
    const py = o.pipeY != null ? 2 * o.pipeY : Y0 + Math.round((Y1 - Y0) * (0.42 + rnd() * 0.2));
    const a = U0 + 2, b = U1 - 2, c0 = o.pc || C.yellow, c1 = o.pc2 || C.indBlue;
    f.box(a, py, 3, b, py, 3, c0); f.box(a, py - 2, 3, b, py - 2, 3, c1);
    for (let u = a + 2; u < b; u += 8) f.box(u, py - 3, 1, u, py + 1, 2, C.indBase);
    const du = rnd() < 0.5 ? a : b, dir = du === a ? 1 : -1;
    if (clear(du)) {
      f.box(du, Y0 + 3, 3, du, py, 3, c0); f.box(du + dir * 2, Y0 + 3, 3, du + dir * 2, py - 2, 3, c1);
      f.box(du - 1, Y0, 3, du + dir * 4, Y0 + 2, 6, C.indBase);
      f.box(du, Y0 + 3, 4, du + dir * 3, Y0 + 3, 5, C.indBlue);
    }
  }
  // wall AC boxes + an access ladder
  const nac = o.ac != null ? o.ac : 2;
  for (let i = 0; i < nac; i++) {
    const u = U0 + 6 + Math.round((i + 0.5) * (U1 - U0 - 12) / nac) + ((rnd() * 4) | 0) - 2;
    if (!clear(u) || !clear(u + 4)) continue;
    const y = Y0 + 8 + ((rnd() * Math.max(1, Y1 - Y0 - 20)) | 0);
    f.box(u, y, 1, u + 4, y + 3, 3, C.indShade); f.box(u + 1, y + 1, 3, u + 2, y + 2, 3, C.metalDark);
    f.box(u + 4, y + 1, 3, u + 4, y + 2, 3, C.indShade);
  }
  if (o.ladder !== false) {
    const u = o.ladderU != null ? 2 * o.ladderU : U1 - 5;
    if (clear(u) && clear(u + 2)) {
      f.box(u, Y0 + 4, 2, u, Y1 + 3, 2, C.indBase); f.box(u + 2, Y0 + 4, 2, u + 2, Y1 + 3, 2, C.indBase);
      for (let y = Y0 + 10; y < Y1; y += 6) { f.box(u - 1, y, 4, u + 3, y, 4, C.yellow); f.set(u - 1, y, 3, C.yellow); f.set(u + 3, y, 3, C.yellow); }
    }
  }
}

// Pipe bridge (surf): n pipes on portal frames along a polyline of coarse
// [x, z] points at height y (coarse voxels), legs down to g every ~7.
function surfPipeBridge(M, pts, g, y, o = {}) {
  const cols = o.cols || [C.yellow, C.indShade, C.indBlue], sp = o.sp || 0.75, w = o.w || 0.5;
  const off = (i) => (i - (cols.length - 1) / 2) * sp;
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L;
    cols.forEach((c, i) => M.beam([ax + nx * off(i), y + (i & 1) * 0.1, az + nz * off(i)], [bx + nx * off(i), y + (i & 1) * 0.1, bz + nz * off(i)], w, c));
    const half = (cols.length - 1) / 2 * sp + 0.45, n = Math.max(1, Math.round(L / (o.step || 7)));
    for (let k = s === 0 ? 0 : 1; k <= n; k++) {
      if (o.legs === false) break;
      const t = k / n, px = ax + dx * t, pz = az + dz * t;
      if ((k === 0 && o.noStart) || (s + 2 === pts.length && k === n && o.noEnd)) continue;
      for (const sg of [-1, 1]) M.beam([px + nx * half * sg, g, pz + nz * half * sg], [px + nx * half * sg, y - 0.3, pz + nz * half * sg], 0.32, C.indBase);
      M.beam([px - nx * half, y - 0.45, pz - nz * half], [px + nx * half, y - 0.45, pz + nz * half], 0.3, C.indBase);
    }
  }
  if (o.walk) {                                                         // a catwalk riding on top, yellow handrails
    for (let s = 0; s + 1 < pts.length; s++) {
      const [px, pz] = pts[s], [qx, qz] = pts[s + 1];
      const dx = qx - px, dz = qz - pz, L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L;
      const yw = y + 0.6;
      M.beam([px, yw, pz], [qx, yw, qz], 1.2, C.indBase);
      for (const sg of [-1, 1]) M.beam([px + nx * 0.6 * sg, yw + 1.1, pz + nz * 0.6 * sg], [qx + nx * 0.6 * sg, yw + 1.1, qz + nz * 0.6 * sg], 0.14, C.yellow);
    }
  }
}

// Lean-to annex (base voxels) against a hall wall: mono-pitch roof, a door,
// a louvre and a vent — the small outbuildings ref05 packs round each hall.
function leanTo(g, side, plane, u0, u1, y0, h, dep, o = {}) {
  const wallC = o.wall != null ? o.wall : C.indShade;
  const f = facade(g, side, plane);
  for (let k = 1; k <= dep; k++) f.box(u0, y0, k, u1, y0 + h - 1 - ((k - 1) >> 1), k, wallC);
  for (let k = 1; k <= dep; k++) f.box(u0, y0 + h - ((k - 1) >> 1), k, u1, y0 + h - ((k - 1) >> 1), k, o.roof != null ? o.roof : C.indRoofLt);
  const doorU = u0 + 1;
  f.box(doorU, y0, dep, doorU + 1, y0 + 4, dep, o.door != null ? o.door : C.indBlue);
  if (u1 - u0 >= 6) f.box(u1 - 3, y0 + 2, dep, u1 - 1, y0 + 3, dep, C.metalDark);
  f.box(u0, y0, dep, u1, y0, dep, C.indBase);
}

function powerPlant(rng) {
  // Design coords (see rot180): the camera-facing sides are design +z / -x.
  // Screen: top = design (94,0), right = (0,0), left = (94,94), bottom = (0,94).
  // The tower stands at the top; the strip of lot running from it toward the
  // viewer is kept LOW (small tanks, substation, parking) so its legs show.
  // Stored at res 8 (hiRes): boxy parts on the res-4 view `g`, the round
  // heroes (tower, domed tanks, silos) natively fine.
  const S = 95;
  const H = hiRes(S, 224, 'power'), g = H.g;
  const y0 = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: C.indPave });
  const yl = y0 - 1;
  const Y0 = 2 * y0;                                                  // fine ground

  // ---- cooling tower: the hero (smooth surface part, round 4) ----
  const TXc = 68.75, TZc = 26.75;
  H.surf((M) => surfCoolingTower(M, TXc, TZc, y0, { rb: 18.5, rw: 12.6, h: 62, legs: 10 }));
  // ---- blue glass office + slim red/white chimney ----
  {
  const gtop = glassOffice(g, 30, 3, 45, 18, y0, 38);
  acBox(g, 32, gtop, 5, { w: 6, d: 5, h: 4 });
  H.fine((Fg) => fineRoof(Fg, g, 31, 4, 44, 17, gtop, { accent: C.indBlue, kinds: ['cond', 'fan', 'vents', 'cab', 'wtank'] }));
  g.box(32, gtop, 12, 37, gtop + 5, 16, C.indShade); g.box(32, gtop + 6, 12, 37, gtop + 6, 16, C.indRoofLt);
  g.box(42, gtop, 15, 42, gtop + 14, 15, C.indBase); g.set(42, gtop + 15, 15, C.red);
  door(facade(g, 'back', 18), 36, y0, 5, 9, { double: true, color: C.winCool, frame: C.white, glass: C.winCool, step: C.indShade, stepDepth: 2, canopy: C.indBlue });
  door(facade(g, 'left', 30), 9, y0, 4, 9, { color: C.winCool, frame: C.white, glass: C.winCool, step: C.indShade, canopy: C.indBlue });
  H.surf((M) => surfStack(M, 41.5, 29.5, y0, 2.4, 104, {}));
  }
  // ---- silos (smooth) + bridge ----
  {
  H.surf((M) => {
    for (const cx of [9.75, 21.75]) surfSilo(M, cx, 10.75, y0, 5, 38, { band: C.red, ladderA: 0, plinth: true, flatTop: true, ribs: true, seg: 28 });
    M.box(14.5, y0 + 41, 9.5, 17, y0 + 41.8, 12, C.indShade);
  });
  }
  // ---- turbine hall + boiler house (right side, big POWER sign to the viewer) ----
  {
  const hx0 = 4, hx1 = 30, hz0 = 22, hz1 = 66;
  // r7 (critic r6: ref05's tower "is surrounded by dense blue and white process
  // buildings"): navy turbine hall, steel boiler house, both with white pilasters
  const htop = hall(g, hx0, hz0, hx1, hz1, y0, 28, { wall: C.indNavy, trim: C.indShade, band: [26, C.white, 1], roof: C.indYard });
  const HB = facade(g, 'back', hz1), HL = facade(g, 'left', hx0), HF = facade(g, 'front', hz0), HR = facade(g, 'right', hx1);
  const bx0 = 4, bx1 = 22, bz0 = 22, bz1 = 40;
  const btop = hall(g, bx0, bz0, bx1, bz1, y0, 42, { wall: C.indBase, trim: C.indShade, base: C.indYard, band: [36, C.red, 2], roof: C.indYard });
  H.fine((Fg) => tag(facade(Fg, 'left', 2 * hx0), 104, 2 * y0 + 40, 'POWER', { fg: C.indBlue }));
  glazeBays(HL, bz1 + 1, hz1, y0 + 4, y0 + 16, 5, [[46, 58]]);
  glazeBays(HR, hz0 + 1, hz1, y0 + 12, y0 + 22, 5);
  glazeBays(HB, hx0 + 1, hx1, y0 + 13, y0 + 22, 5);
  rollDoor(HB, 8, 15, y0, 10, { hood: C.indBlue }); rollDoor(HB, 19, 26, y0, 10, { hood: C.indBlue });
  hazard(g, 7, 68, 27, 70, yl);
  ribbon(HF, bx1 + 3, hx1 - 3, 8, 5);
  const BL = facade(g, 'left', bx0), BB = facade(g, 'back', bz1), BR = facade(g, 'right', bx1);
  for (const [f, a, b] of [[BL, bz0, bz1], [BR, bz0, bz1], [BB, bx0, bx1]]) ribbon(f, a + 3, b - 3, 32, 3);
  // r6: the boiler house's tall faces were bare grey slabs in the gallery view —
  // tall glazed bays + a pair of riser pipes down the outside, like ref05's plant
  glazeBays(BL, bz0 + 1, bz1, y0 + 5, y0 + 26, 5);
  glazeBays(BB, bx0 + 1, bx1 - 4, y0 + 13, y0 + 26, 5);
  for (const z of [bz0 + 3, bz0 + 4]) g.box(bx0 - 2, y0, z, bx0 - 2, y0 + 38, z, z === bz0 + 3 ? C.yellow : C.indBlue);
  for (let y = y0 + 6; y <= y0 + 36; y += 10) g.box(bx0 - 1, y, bz0 + 2, bx0 - 1, y, bz0 + 5, C.indBase);
  panelSeams(g, hx0, hz0, hx1, hz1, y0 + 2, y0 + 25, C.indNavy, C.indNavyDk, 6);
  panelSeams(g, bx0, bz0, bx1, bz1, y0 + 2, y0 + 35, C.indSteel, C.indSteelDk, 6);
  H.fine((Fg) => {
    fineRoof(Fg, g, bx0 + 1, bz0 + 1, bx1 - 1, bz1 - 1, btop, { accent: C.red });
    fineRoof(Fg, g, hx0 + 1, hz0 + 1, hx1 - 1, hz1 - 1, htop, { accent: C.indBlue });
    fineWall(Fg, 'right', hx1, hz0, hz1, y0, htop - 1, { pipeY: y0 + 9, ac: 2 });
    fineWall(Fg, 'back', hz1, hx0, hx1, y0, htop - 1, { pipeY: y0 + 11, ac: 1, skip: [[7, 27]], ladder: false });
    fineWall(Fg, 'right', bx1, bz0, bz1, htop, btop - 1, { ac: 1, pipe: false });
    fineWall(Fg, 'front', bz0, bx0, bx1, y0, btop - 1, { pipeY: y0 + 20, ac: 1 });
    fineWall(Fg, 'front', hz0, bx1 + 1, hx1, y0, htop - 1, { pipeY: y0 + 14, ac: 0, ladder: false });
  });
  // truck / dock yard under the hall's back doors
  g.box(2, yl, 71, 34, yl, 93, C.indShade);                          // light concrete yard
  for (let z = 71; z <= 93; z += 11) for (let x = 2; x <= 34; x++) g.set(x, yl, z, C.indLine);
  fTanker(H, 4, y0, 74, 'x', 1, { len: 20, cab: C.indBlue, tank: C.indTank, band: C.red });
  fTruck(H, 4, y0, 86, 'x', 1, { len: 20, cab: C.white, box: C.orange, stripe: C.white, logo: C.indBlue });
  genset(g, 24, y0, 74, 'x'); crates(g, 25, y0, 86, 3, 3, 2, [C.wood, C.plank]); crates(g, 29, y0, 86, 3, 3, 1, [C.indBlue]);
  // r9: half-size trucks left the yard bare — a planted island between the lanes,
  // a hedge along the rim and a third (outbound) truck
  g.box(2, yl, 80, 20, yl, 83, C.lotGrass); g.walls(2, yl, 80, 20, yl, 83, C.lotRim);
  for (let x = 3; x <= 19; x++) if (x % 5) g.set(x, y0, 81, C.bush);
  tree(g, 6, y0, 82, 3); tree(g, 16, y0, 82, 3);
  for (let x = 2; x <= 34; x++) g.set(x, y0, 93, C.leafMid);
  fTruck(H, 14, y0, 89.5, 'x', -1, { len: 18, cab: C.red, box: C.white, stripe: C.red, logo: C.red });
  // silo → boiler pipes
  pipeRack(g, 'z', 13, 21, 12, y0 + 8, [C.indShade, C.yellow], null);

  }
  // ---- substation in front of the tower (kept low, light gravel) ----
  {
  g.box(40, yl, 53, 61, yl, 72, C.indShade);
  fenceX(g, 40, 61, y0, 53); fenceX(g, 40, 61, y0, 72); fenceZ(g, 53, 72, y0, 40); fenceZ(g, 53, 72, y0, 61);
  transformer(g, 43, y0, 56); transformer(g, 52, y0, 56, { c: C.pBlue });
  switchgear(g, 42, y0, 67, 5);
  for (const x of [43, 50, 57]) gantry(g, x, 63, 70, y0, 12);
  for (const z of [65, 68]) g.box(43, y0 + 11, z, 60, y0 + 11, z, C.indBase);
  }
  // ---- one tidy pipe rack beside the tank farm (nothing crosses the
  // tower's front, so its leg skirt reads) ----
  {
    pipeRack(g, 'z', 55, 90, 74, y0 + 12, [C.indShade], y0, 12);
    for (const z of [60, 82]) g.box(76, y0 + 12, z, 77, y0 + 13, z + 1, C.indShade);
  }
  // ---- tidy rows of small process tanks + skids (ref05: blue-capped drums) ----
  {
    for (let i = 0; i < 4; i++) {
      const tx = 38 + i * 7;
      cylinder(g, tx, 44, 2, y0, y0 + 4, C.indTank, C.indBlue);
      ring(g, tx, 44, 2, y0 + 1, y0 + 1, C.indShade);
      disc(g, tx, 44, 1, y0 + 5, C.indBlue);
    }
    for (let i = 0; i < 3; i++) g.box(36 + i * 5, y0, 38, 38 + i * 5, y0 + 1, 39, C.yellow);   // skid row
    crates(g, 80, y0, 46, 3, 3, 2, [C.indShade, C.indBlue]); barrel(g, 84, y0, 47, C.yellow); barrel(g, 86, y0, 46, C.indBlue);
  }
  // ---- domed storage tanks (smooth) on concrete pads ----
  H.surf((M) => {
    for (const cz of [60.75, 82.75]) {
      surfDomeTank(M, 84.75, cz, y0, 8, 13, { stairA: Math.PI * 0.6 });
      // r5: piped into the rack (critic: "bare cylinders with no pipes")
      M.beam([75.9, y0 + 5.5, cz], [77.4, y0 + 5.5, cz], 0.9, C.yellow);
      M.beam([75.9, y0 + 12.5, cz + 2.5], [77.6, y0 + 12.5, cz + 2.5], 0.7, C.indShade);
      M.beam([76.3, y0, cz], [76.3, y0 + 5.5, cz], 0.5, C.indBase);
    }
    // r8: a pipe bridge from the turbine hall across the yard to the tank rack
    surfPipeBridge(M, [[30.9, 49.5], [74.5, 49.5]], y0, y0 + 15, { step: 11, noStart: true, noEnd: true });
    M.beam([78.4, y0 + 17.2, 60.75], [78.4, y0 + 17.2, 82.75], 0.8, C.indShade);    // walkway between the domes
    for (const s of [-1, 1]) M.beam([78.4 + s * 0.4, y0 + 18.2, 60.75], [78.4 + s * 0.4, y0 + 18.2, 82.75], 0.14, C.yellow);
  });
  // ---- small switch house + parking at the front (low) ----
  {
  const atop = hall(g, 40, 77, 60, 91, y0, 16, { wall: C.indCorr, trim: C.indCorrDk, roof: C.indYard });
  H.fine((Fg) => { fineRoof(Fg, g, 41, 78, 59, 90, atop, { accent: C.indBlue }); fineWall(Fg, 'right', 60, 77, 91, y0, atop - 1, { ac: 1 }); fineWall(Fg, 'front', 77, 40, 60, y0, atop - 1, { ac: 1, ladder: false }); });
  const AB = facade(g, 'back', 91), AL = facade(g, 'left', 40);
  rollDoor(AB, 44, 50, y0, 8, { hood: C.indBlue }); ribbon(AB, 53, 57, 6, 3); ribbon(AL, 80, 88, 6, 3);
  // bunded tank farm (ref05: tidy rows of small blue-capped tanks) + skids
  g.box(62, yl, 56, 72, yl, 92, C.indShade);
  for (let z = 56; z <= 92; z++) { g.set(62, y0, z, C.indBase); g.set(72, y0, z, C.indBase); }
  for (let x = 62; x <= 72; x++) { g.set(x, y0, 56, C.indBase); g.set(x, y0, 92, C.indBase); }
  for (const tz of [60, 67, 74]) for (const tx of [65, 70]) {
    cylinder(g, tx, tz, 2, y0, y0 + 7, C.indTank, C.indBlue);
    ring(g, tx, tz, 2, y0 + 2, y0 + 2, C.indBlue);
    disc(g, tx, tz, 1, y0 + 8, C.indBlue);
  }
  pipeZ(g, 58, 78, y0 + 9, 67, C.yellow, y0, 7);
  genset(g, 63, y0, 79, 'x');
  gasBottles(g, 64, y0, 87, 4, C.orange);
  for (let i = 0; i < 3; i++) g.box(64 + i * 3, y0, 90, 65 + i * 3, y0 + 1, 91, C.yellow);
  }
  // ---- machinery + stores round the tower foot (kept off its front) ----
  {
  genset(g, 88, y0, 32, 'z');
  gasBottles(g, 58, y0, 3, 6, C.indBlue); gasBottles(g, 74, y0, 3, 6, C.orange);
  crates(g, 88, y0, 4, 3, 3, 2, [C.indShade, C.indBlue]); crates(g, 88, y0, 12, 3, 3, 1, [C.yellow]);
  crates(g, 34, y0, 24, 3, 3, 2, [C.wood, C.plank]);
  for (const [x, z] of [[32, 30], [34, 31], [32, 33]]) barrel(g, x, y0, z, C.yellow);
  fForklift(H, 89, y0, 19, 'z', 1);
  fenceX(g, 2, 92, y0, 1);
  for (const [x, z] of [[50, 5], [84, 6]]) { cylinder(g, x, z, 2, y0, y0 + 5, C.indTank, C.indBlue); disc(g, x, z, 1, y0 + 6, C.indBlue); }
  for (let i = 0; i < 4; i++) g.box(62 + i * 3, y0, 4, 63 + i * 3, y0 + 1, 5, i & 1 ? C.orange : C.yellow);
  crates(g, 90, y0, 24, 3, 3, 2, [C.indBlue, C.indShade]); barrel(g, 91, y0, 39, C.yellow); barrel(g, 89, y0, 40, C.indBlue);
  for (const [tx, tz] of [[27, 5], [91, 46], [2, 20]]) tree(g, tx, y0, tz, 5);
  }
  // ---- r6: fill every remaining gap with tidy industrial clutter ----
  yardFill(g, y0, rng, {
    keep: [[TXc, TZc, 21.8], [84.75, 60.75, 10.2], [84.75, 82.75, 10.2], [9.75, 10.75, 8.2], [21.75, 10.75, 8.2], [41.5, 29.5, 3.6], [77, 71.75, 3]],
    skip: [[2, 70, 36, 93], [31, 48, 74, 51]],
  });
  return H.done();
}

function megaWorks(rng, variant) {
  // r5 (critic r4: "plain white and grey boxes … huge garish signs … tanks are
  // bare cylinders"): paved lot, concrete walls with tall glazed bays between
  // white pilasters, small white-board signs, a blue curtain-wall office, a
  // canopied dock with trucks backed in, pipe racks + a conveyor gallery + a
  // stair tower at the silos, laddered tanks piped into the dock shed.
  const S = 95;
  const accent = pk(rng, [C.indBlue, C.orange]);
  const H = hiRes(S, 224, 'mega:' + accent + ':' + variant), g = H.g;
  const y0 = lotPlinth(g, 0, 0, S - 1, S - 1, { fill: C.indPave });
  const yl = y0 - 1;
  // ---- main works: central block with a raised stack house + 4 banded chimneys ----
  // r10 (critic r9: "one pale white-grey stepped block with thin orange
  // pinstripes"; ref05's works: blue glass curtain walls, darker steel-grey
  // massing against light concrete, dark roof decks under light plant): the
  // accent pinstripe bands are gone, every roof deck is dark slate (the light
  // rooftop plant pops off it), the works hall carries a continuous blue
  // clerestory curtain band above the wings, and the stack house is a darker
  // steel volume with tall glazed bays between light pilasters.
  const mx0 = 30, mx1 = 66, mz0 = 22, mz1 = 52;
  const PQX = 58.5, PPZ = 64.5;                  // the tank → stack pipe main (see below)
  const pipeKeep = (x0, x1, z0, z1) => { const k = []; for (let x = x0; x <= x1; x += 1.5) for (let z = z0; z <= z1; z += 1.5) k.push([x, z, 2]); return k; };
  const mtop = hall(g, mx0, mz0, mx1, mz1, y0, 32, { wall: C.indCorr, trim: C.indWall, roof: C.indYard });
  const MB = facade(g, 'back', mz1), ML = facade(g, 'left', mx0), MF = facade(g, 'front', mz0), MR = facade(g, 'right', mx1);
  for (const f of [ML, MR]) glazeBays(f, mz0 + 1, mz1, y0 + 4, y0 + 17, 5);
  for (const f of [MB, MF]) glazeBays(f, mx0 + 1, mx1, y0 + 4, y0 + 17, 5, [[44, 52]]);
  for (const [f, a, b] of [[ML, mz0, mz1], [MR, mz0, mz1], [MB, mx0, mx1], [MF, mx0, mx1]]) curtainBand(f, a + 2, b - 2, y0 + 21, y0 + 28);
  rollDoor(MB, 45, 51, y0, 11, { hood: C.indRoof, color: C.indWall, slat: C.indShade, frame: C.indBase });
  const sx0 = 34, sx1 = 64, sz0 = 26, sz1 = 46;
  const stop = hall(g, sx0, sz0, sx1, sz1, y0, 50, { wall: C.indBase, trim: C.indShade, base: C.indYard, roof: C.indYard });
  for (const side of ['left', 'back', 'front', 'right']) {
    const pl = { left: sx0, right: sx1, back: sz1, front: sz0 }[side];
    const f = facade(g, side, pl), a = side === 'left' || side === 'right' ? sz0 : sx0, b = side === 'left' || side === 'right' ? sz1 : sx1;
    glazeBays(f, a + 1, b, y0 + 33, y0 + 45, 5, side === 'back' || side === 'front' ? [[40, 56]] : [], C.indShade);
    f.box(a, y0 + 46, 1, b, y0 + 46, 1, C.indShade);                                  // light cornice under the coping
  }
  // signs in the res-8 part: half-size 1× letters (r4 critic: "shrink the signs")
  const fsign = (side, plane, uc, y, text, fg) => H.fine((Fg) => tag(facade(Fg, side, side === 'back' || side === 'right' ? 2 * plane + 1 : 2 * plane), Math.round(2 * uc), Math.round(2 * y), text, { fg }));
  fsign('back', sz1, 49, y0 + 34, 'MEGA', accent);
  fsign('front', sz0, 49, y0 + 34, 'MEGA', accent);
  H.surf((M) => {                                 // smooth banded chimneys
    for (const [cx, cz, h] of [[41, 31, 96], [49, 31, 88], [57, 31, 92], [49, 40, 84]]) surfStack(M, cx + 0.75, cz + 0.75, stop, 3, h, { seg: 32 });
  });
  // r8 (critic r7: "flat grey roofs with a few AC cubes"): every roof carries a
  // dense fine-scale plant — module pads with condensers, fans, vent clusters,
  // small tanks, ducts, cabinets — and pipe pairs along the aisles
  const chim = [[41, 31, 96], [49, 31, 88], [57, 31, 92], [49, 40, 84]];
  H.fine((Fg) => {
    fineRoof(Fg, g, mx0 + 1, mz0 + 1, mx1 - 1, mz1 - 1, mtop, { accent, keep: pipeKeep(PQX, PQX, sz1, mz1) });
    fineRoof(Fg, g, sx0 + 1, sz0 + 1, sx1 - 1, sz1 - 1, stop, { accent, keep: chim.map(([x, z]) => [x + 0.75, z + 0.75, 4.6]).concat(pipeKeep(PQX, PQX, 34, sz1)), kinds: ['cond', 'fan', 'vents', 'vents', 'tank', 'duct', 'cab'] });
    // stack-house + works walls: downpipes, wall pipes, AC boxes, ladders
    for (const [side, pl, a, b] of [['left', sx0, sz0, sz1], ['right', sx1, sz0, sz1], ['front', sz0, sx0, sx1], ['back', sz1, sx0, sx1]]) fineWall(Fg, side, pl, a, b, mtop + 1, stop - 1, { pipe: false, ac: 1, skip: side === 'front' ? [[45, 54]] : side === 'back' ? [[45, 54], [56, 61]] : [] });
    for (const [side, pl, a, b] of [['left', mx0, mz0, mz1], ['right', mx1, mz0, mz1], ['front', mz0, mx0, mx1], ['back', mz1, mx0, mx1]]) fineWall(Fg, side, pl, a, b, y0, mtop - 1, { pipeY: y0 + 13, ladder: side !== 'back', skip: side === 'back' ? [[43, 53], [56, 61]] : [] });
  });
  // ---- sawtooth assembly wing (left) ----
  const wx0 = 8, wx1 = 26, wz0 = 22, wz1 = 52;
  // r7: the wings are clad (corrugated grey assembly wing, navy dock shed) so the
  // white stack house stands out of a mixed steel / navy / glass works (ref05)
  const wtop = hall(g, wx0, wz0, wx1, wz1, y0, 22, { wall: C.indCorr, trim: C.indCorrDk, roof: C.indYard });
  sawtooth(g, wx0 + 1, wx1 - 1, wz0 + 1, wz1 - 1, wtop, { D: 7, H: 4, roof: C.indRoofLt });
  const WL = facade(g, 'left', wx0), WB = facade(g, 'back', wz1);
  glazeBays(WL, wz0 + 1, wz1, y0 + 4, y0 + 15, 5, [], C.indCorrDk);
  panelSeams(g, wx0, wz0, wx1, wz1, y0 + 2, y0 + 15, C.indCorr, C.indCorrDk, 5);
  rollDoor(WB, 13, 21, y0, 10, { hood: C.indRoof, color: C.indWall, slat: C.indShade, frame: C.indBase });
  // ---- logistics shed: canopied dock with trucks backed in (faces the viewer) ----
  const dx0 = 8, dx1 = 66, dz0 = 61, dz1 = 71;
  const dtop = hall(g, dx0, dz0, dx1, dz1, y0, 22, { wall: C.indNavy, trim: C.indShade, roof: C.indYard });
  const DB = facade(g, 'back', dz1), DL = facade(g, 'left', dx0);
  // r10 (critic r9: "cut the dock face into real recessed bays with trucks
  // nosed in"): nine bays, each a 1-unit-deep recess into the shed — dark
  // steel-lined sides and soffit, a half-open roll door at the back showing
  // the dark interior, black dock seals + yellow bumpers on the piers, a drive
  // well in front — with half-size semis backed right into six of them.
  const RD = 4, bays = [];
  for (let u = dx0 + 3; u + 4 <= dx1 - 3; u += 6) {
    bays.push(u);
    DB.clear(u, y0, -(RD - 1), u + 3, y0 + 7, 0);
    DB.box(u - 1, y0, -RD, u - 1, y0 + 8, -1, C.indBase);                     // side linings
    DB.box(u + 4, y0, -RD, u + 4, y0 + 8, -1, C.indBase);
    DB.box(u, y0 + 8, -RD, u + 3, y0 + 8, -1, C.indYard);                     // soffit
    DB.box(u, y0, -RD, u + 3, y0 + 3, -RD, C.darkGray);                       // open lower half: dark interior
    for (let y = y0 + 4; y <= y0 + 7; y++) DB.box(u, y, -RD, u + 3, y, -RD, (y - y0) & 1 ? C.indShade : C.indWall);   // rolled-up shutter
    DB.box(u, yl, -(RD - 1), u + 3, yl, 3, C.lotAsphalt);                     // drive well
    DB.box(u - 1, y0, 1, u - 1, y0 + 7, 1, C.black); DB.box(u + 4, y0, 1, u + 4, y0 + 7, 1, C.black);   // dock seals
    DB.box(u - 1, y0 + 1, 2, u - 1, y0 + 1, 2, C.yellow); DB.box(u + 4, y0 + 1, 2, u + 4, y0 + 1, 2, C.yellow);   // bumpers
    DB.set(u + 1, y0 + 9, 1, C.lamp);                                          // dock light
  }
  g.box(dx0, y0 + 11, dz1 + 1, dx1, y0 + 11, dz1 + 3, C.indRoof);             // dock canopy + fascia
  g.box(dx0, y0 + 10, dz1 + 3, dx1, y0 + 11, dz1 + 3, C.indWall);
  fsign('back', dz1, 60, y0 + 14.5, 'DOCK', C.indBlue);
  curtainBand(DB, dx0 + 2, 54, y0 + 14, y0 + 19);                             // glazed band over the canopy (ref05)
  glazeBays(DL, dz0 + 1, dz1, y0 + 4, y0 + 15, 5);
  // r8: small lean-to annexes against the long side walls (ref05's outbuildings)
  leanTo(g, 'left', dx0, 62, 69, y0, 7, 3, { wall: C.indSteel, door: C.orange });
  leanTo(g, 'left', wx0, 30, 37, y0, 6, 3, { wall: C.indShade, door: C.indBlue });
  leanTo(g, 'left', wx0, 45, 50, y0, 8, 3, { wall: C.indNavy, door: C.yellow });
  panelSeams(g, dx0, dz0, dx1, dz1, y0 + 2, y0 + 15, C.indNavy, C.indNavyDk, 5);
  for (let x = dx0 + 12; x + 5 <= dx1 - 2; x += 24) hvacPad(g, x, dtop, dz1 - 5, 6, 4);
  H.fine((Fg) => {
    fineRoof(Fg, g, dx0 + 1, dz0 + 1, dx1 - 1, dz1 - 1, dtop, { accent, seed: 11, keep: pipeKeep(PQX, dx1, PPZ, PPZ) });
    fineWall(Fg, 'left', dx0, dz0, dz1, y0, dtop - 1, { pipeY: y0 + 16, ac: 1 });
    fineWall(Fg, 'right', dx1, dz0, dz1, y0, dtop - 1, { pipeY: y0 + 10, ac: 1 });
    fineWall(Fg, 'front', dz0, dx0, dx1, y0, dtop - 1, { pipeY: y0 + 12, ac: 3 });
    fineWall(Fg, 'left', wx0, wz0, wz1, y0, wtop - 1, { pipeY: y0 + 9, ac: 2, pc: C.orange });
    fineWall(Fg, 'front', wz0, wx0, wx1, y0, wtop - 1, { pipeY: y0 + 10, ac: 1 });
  });
  // pipe bridges linking the halls (critic r7: "exposed pipe runs linking
  // buildings"): works ↔ dock shed, works ↔ sawtooth wing, works ↔ sheds
  H.surf((M) => {
    for (const x of [36.5, 58.5]) surfPipeBridge(M, [[x, mz1 + 0.9], [x, dz0 + 0.1]], y0, y0 + 17, { legs: false });
    surfPipeBridge(M, [[47.5, mz1 + 0.9], [47.5, dz0 + 0.1]], y0, y0 + 12.5, { legs: false, cols: [C.orange, C.indShade] });
    for (const z of [29.5, 45.5]) surfPipeBridge(M, [[wx1 + 0.9, z], [mx0 + 0.1, z]], y0, y0 + 14, { legs: false, cols: [C.indBlue, C.yellow] });
    surfPipeBridge(M, [[mx1 + 0.9, 37.5], [71.9, 37.5]], y0, y0 + 11, { legs: false, cols: [C.yellow, C.indShade] });
    surfPipeBridge(M, [[mx1 + 0.9, 55.5], [69, 55.5], [69, 65.5], [74.2, 65.5]], y0, y0 + 9, { cols: [C.indShade, C.orange], noStart: true, noEnd: true });
  });
  // ---- truck apron: shallow, bay lines, half-size semis backed in ----
  const AZ1 = 85;                                                             // apron back edge
  g.box(2, yl, 75, 66, yl, AZ1, C.lotAsphalt);
  for (const u of bays) for (let z = 75; z <= AZ1 - 2; z++) { g.set(u - 1, yl, z, C.lotLine); g.set(u + 4, yl, z, C.lotLine); }
  for (let x = 2; x <= 66; x++) if (!bays.some((u) => x >= u && x <= u + 3)) { g.set(x, yl, 72, C.yellow); g.set(x, yl, 73, x & 1 ? C.black : C.yellow); }
  const tcols = [C.orange, C.white, C.indBlue, C.orange, C.red, C.white];
  bays.forEach((u, i) => {
    const k = (i + variant) % 9;
    if (k === 2 || k === 5 || k === 7) {                                       // an empty bay: chevrons in the well
      for (let z = 74; z <= 79; z += 2) g.box(u, yl, z, u + 3, yl, z, C.yellow);
      return;
    }
    const c = tcols[(i + variant) % 6];
    // semi backed INTO the recess: rear 1.5 units inside the bay (dir -1 → a=0 at max z)
    fTruck(H, u + 0.5, y0, dz1 - 2, 'z', -1, { len: 20, cab: i & 1 ? accent : C.white, box: c, stripe: c === C.white ? accent : C.white, logo: c === C.white ? accent : C.white });
  });
  fTruck(H, 1, y0, 81, 'x', 1, { len: 18, cab: C.red, box: C.white, stripe: accent, logo: accent });   // one pulling out
  // ---- planted strip + walkway between the apron and the lot rim ----
  g.box(2, yl, AZ1 + 1, 92, yl, 93, C.lotGrass);
  g.box(2, yl, AZ1 + 1, 92, yl, AZ1 + 1, C.lotRim);                            // kerb
  g.box(2, yl, 91, 92, yl, 91, C.lotPave);                                     // footpath along it
  for (const x of [22, 23, 46, 47]) g.box(x, yl, AZ1 + 1, x, yl, 93, C.lotPave); // crossing walkways
  // low clipped hedges (1 wide, 1-2 high) along both kerbs + a few small trees
  const walk = (x) => x >= 21 && x <= 24 || x >= 45 && x <= 48;
  for (let x = 3; x <= 91; x++) if (!walk(x)) {
    g.set(x, y0, AZ1 + 2, C.leafDark); if (x % 3) g.set(x, y0 + 1, AZ1 + 2, C.leafMid);
    g.set(x, y0, 93, C.leafDark);
  }
  for (const x of [9, 33, 57, 78]) tree(g, x, y0, 88, 3);
  for (const x of [15, 28, 39, 53, 63, 70, 86]) { g.box(x, y0, 88, x + 2, y0, 89, C.leafMid); g.box(x, y0 + 1, 88, x + 2, y0 + 1, 89, C.bush); }
  // ---- tank + pipe corner (was a trailer park) ----
  g.box(68, yl, 75, 92, yl, AZ1, C.lotPaveDark);
  g.walls(68, y0, 75, 92, y0, AZ1, C.indBase);                                 // bund wall
  H.surf((M) => {
    for (const [cx, cz, r, hh, b] of [[72, 80, 2.4, 11, C.orange], [77.5, 80, 2.4, 11, C.white], [83, 80, 2.4, 14, accent], [88.5, 80, 2.4, 11, C.orange]]) {
      surfSilo(M, cx, cz, y0, r, hh, { legs: 1.2, band: b, hut: false, ladderA: -Math.PI / 2, seam: false, seg: 24, domeTop: true });
    }
    M.beam([69, y0 + 8, 83.6], [92, y0 + 8, 83.6], 0.5, C.yellow);
    M.beam([69, y0 + 7, 83.6], [92, y0 + 7, 83.6], 0.5, C.indShade);
    for (let x = 70; x <= 91; x += 5) M.beam([x, y0, 83.6], [x, y0 + 8.5, 83.6], 0.35, C.indBase);
  });
  // ---- silo cluster: walkways, stair tower, conveyor gallery, pipe rack ----
  H.surf((M) => {
    for (const [cx, cz] of [[76.75, 8.75], [87.75, 8.75], [76.75, 19.75], [87.75, 19.75]]) surfSilo(M, cx, cz, y0, 5, 44, { band: accent, hut: false, ladderA: cz < 14 ? -Math.PI / 2 : Math.PI / 2, ribs: true, seg: 28, domeTop: true, landings: 2 });
    const yw = y0 + 44 + 2.3;
    for (const z of [8.75, 19.75]) M.box(75.5, yw, z - 1, 89, yw + 0.8, z + 1, C.indShade);
    M.box(81.3, yw, 8.75, 83.2, yw + 0.8, 19.75, C.indShade);
    M.box(80, yw + 0.8, 7, 84.5, yw + 3.5, 10.5, C.indWall); M.box(79.8, yw + 3.5, 6.8, 84.7, yw + 3.9, 10.7, C.indBase);
    for (const z of [7.9, 9.6, 18.9, 20.6]) M.beam([75.5, yw + 1.9, z], [89, yw + 1.9, z], 0.18, C.yellow);   // handrails
    // round process tanks by the dock shed, laddered and piped into it
    for (const [cx, cz, r, hh, b] of [[78.5, 66.5, 4, 16, C.orange], [88.5, 66.5, 3, 12, accent]]) {
      surfSilo(M, cx, cz, y0, r, hh, { legs: 1.5, band: b, hut: false, coneH: 1.4, ladderA: Math.PI, seam: false });
      M.beam([cx - r - 0.1, y0 + 6.5, cz], [dx1 + 1, y0 + 6.5, cz], 0.8, C.indShade);
    }
    M.beam([84.5, y0 + 9.5, 66.5], [85.5, y0 + 9.5, 66.5], 0.7, C.indShade);
  });
  // stair tower beside the silos (open steel frame, a landing every 8)
  for (const [x, z] of [[70, 12], [73, 12], [70, 15], [73, 15]]) g.box(x, y0, z, x, y0 + 46, z, C.indBase);
  for (let y = y0 + 6; y <= y0 + 46; y += 8) { g.walls(70, y, 12, 73, y, 15, C.indBase); g.box(71, y, 13, 72, y, 14, C.yellow); }
  g.box(70, y0 + 46, 12, 75, y0 + 46, 15, C.indShade);
  // enclosed conveyor gallery from the silo tops down to the works roof
  for (let q = 0; q <= 8; q++) {
    g.box(mx1 + 1 + q, y0 + 29 + q * 2, 12, mx1 + 1 + q, y0 + 32 + q * 2, 14, C.indShade);
    g.box(mx1 + 1 + q, y0 + 29 + q * 2, 12, mx1 + 1 + q, y0 + 29 + q * 2, 14, C.indBase);
  }
  // pipe rack from the silos to the works (two pipes on portal frames)
  g.box(mx1 + 1, y0 + 14, 22, 74, y0 + 15, 23, C.yellow);
  g.box(mx1 + 1, y0 + 14, 25, 74, y0 + 15, 26, C.indShade);
  for (let x = mx1 + 3; x <= 74; x += 4) { g.box(x, y0, 21, x, y0 + 13, 21, C.indBase); g.box(x, y0, 27, x, y0 + 13, 27, C.indBase); g.box(x, y0 + 13, 21, x, y0 + 13, 27, C.indBase); }
  // ---- outbuildings on a paved service yard ----
  g.box(70, yl, 28, 92, yl, 60, C.lotPaveDark);
  const shed = (x0, z0, x1, z1, h, c) => {
    const t = hall(g, x0, z0, x1, z1, y0, h, { wall: c, trim: C.indWall, roof: C.indRoofLt });
    glazeBays(facade(g, 'left', x0), z0 + 1, z1, y0 + 4, y0 + h - 6, 5); ribbon(facade(g, 'back', z1), x0 + 2, x1 - 2, y0 + 5, 3, { glass: C.dtGlass, frame: C.indWall });
    H.fine((Fg) => { fineRoof(Fg, g, x0 + 1, z0 + 1, x1 - 1, z1 - 1, t, { accent }); fineWall(Fg, 'right', x1, z0, z1, y0, t - 1, { ac: 1 }); fineWall(Fg, 'front', z0, x0, x1, y0, t - 1, { ac: 1, ladder: false }); });
  };
  shed(72, 30, 90, 44, 16, C.indSteel);
  shed(74, 50, 90, 58, 12, C.indNavy);
  // ---- curtain-wall office + visitor parking (road side) ----
  const otop = glassOffice(g, 8, 4, 24, 16, y0, 30);
  hvacPad(g, 9, otop, 6, 6, 4);
  g.box(22, otop, 5, 22, otop + 9, 5, C.metalDark); g.set(22, otop + 10, 5, C.red);
  H.fine((Fg) => fineRoof(Fg, g, 9, 5, 23, 15, otop, { accent, kinds: ['cond', 'fan', 'vents', 'cab', 'wtank'] }));
  door(facade(g, 'front', 4), 14, y0, 5, 9, { double: true, color: C.civGlass, frame: C.white, glass: C.winCool, step: C.indShade, canopy: accent });
  fsign('back', 16, 16.5, otop - 6, 'WORKS', accent);
  // r10 (critic r9: "fill the lot with yards, containers and cranes instead of
  // plain paving"): the old car park is a container yard under a portal crane
  containerYard(H, g, 29, 2, 67, 17, y0, variant);
  // tank farm → dock roof → works → stack house: one visible pipe main
  // (critic r9: "run visible pipes between the tanks and the stacks")
  H.surf((M) => {
    const yA = y0 + 26, yB = y0 + 37, px = 68.4, pz = PPZ, qx = PQX;
    const cols = [C.indBlue, C.yellow, C.indShade];
    for (let i = 0; i < 3; i++) M.beam([px + (i - 1) * 0.75, y0 + 7, 84.2], [px + (i - 1) * 0.75, yA, 84.2], 0.5, cols[i]);   // risers off the manifold
    surfPipeBridge(M, [[px, 84.2], [px, pz], [qx, pz], [qx, mz1 + 1.4]], y0, yA, { cols, legs: false });
    for (const z of [84.2, 76, pz]) for (const s of [-1, 1]) M.beam([px + s * 1.25, y0, z], [px + s * 1.25, yA - 0.4, z], 0.34, C.indBase);
    for (const z of [84.2, 76, pz]) M.beam([px - 1.4, yA - 0.5, z], [px + 1.4, yA - 0.5, z], 0.34, C.indBase);
    for (let x = qx + 5; x < px - 1; x += 6) for (const s of [-1, 1]) M.beam([x, dtop, pz + s * 1.25], [x, yA - 0.4, pz + s * 1.25], 0.3, C.indBase);
    for (const s of [-1, 1]) M.beam([qx + s * 1.25, dtop, pz], [qx + s * 1.25, yA - 0.4, pz], 0.3, C.indBase);
    // up the works' back wall, over its roof edge, into the stack house
    for (let i = 0; i < 3; i++) M.beam([qx + (i - 1) * 0.75, yA, mz1 + 1.4], [qx + (i - 1) * 0.75, yB, mz1 + 1.4], 0.5, cols[i]);
    surfPipeBridge(M, [[qx, mz1 + 1.4], [qx, sz1 + 1.1]], y0, yB, { cols, legs: false });
    for (const s of [-1, 1]) M.beam([qx + s * 1.25, mtop, sz1 + 3], [qx + s * 1.25, yB - 0.4, sz1 + 3], 0.3, C.indBase);
    // a big flue duct up the stack house and across its roof into a chimney
    M.box(qx - 1.2, yB - 1, sz1 + 1, qx + 1.2, stop + 3, sz1 + 2.6, C.indShade);
    M.box(qx - 1.2, stop + 1, 34.2, qx + 1.2, stop + 3.4, sz1 + 2.6, C.indShade);
    for (const s of [-1, 1]) M.beam([qx + s * 0.9, stop, 40], [qx + s * 0.9, stop + 1, 40], 0.4, C.indBase);
    for (const y of [yB + 2, yB + 6, stop - 2]) M.box(qx - 1.45, y, sz1 + 0.9, qx + 1.45, y + 0.5, sz1 + 2.85, C.indBase);
  });
  // yards packed with pallets and crates
  palletYard(g, 27, 55, 30, 59, y0, [C.wood, C.plank, C.indBlue], rng);
  palletYard(g, 70, 62, 73, 70, y0, [C.orange, C.indShade, C.wood], rng);
  fForklift(H, 68, y0, 70, 'z', 1);
  gasBottles(g, 3, y0, 24, 5, C.indBlue); gasBottles(g, 3, y0, 44, 5, C.orange);
  for (const [tx, tz] of [[4, 5], [4, 60], [92, 72]]) tree(g, tx, y0, tz, 5);
  fenceZ(g, 20, 76, y0, 1);
  yardFill(g, y0, rng, { keep: [[76.75, 8.75, 6.4], [87.75, 8.75, 6.4], [76.75, 19.75, 6.4], [87.75, 19.75, 6.4], [78.5, 66.5, 5.4], [88.5, 66.5, 4.4], [72, 80, 3.4], [77.5, 80, 3.4], [83, 80, 3.4], [88.5, 80, 3.4]], skip: [[67, 54, 71, 67], [67, 64, 75, 67], [2, 86, 92, 93], [68, 83, 92, 85], [28, 1, 68, 18], [66, 62, 71, 86]] });
  return H.done();
}

// r10: container yard (coarse rect x0..x1 × z0..z1 on the lot top y0) — rows
// of stacked 20/40-ft boxes in the FINE part (half size, truck scale), a
// truck lane with a flatbed under a big orange portal crane (surf), crane
// rails and yellow lane paint on dark concrete. Deterministic (cached part).
const CONT_COLS = () => [C.orange, C.indBlue, C.red, C.teal, C.orange, C.offwhite, C.yellow, C.indBlue];
function container(F, x, y, z, len, c, axis = 'x') {
  const L = lf(F, x, y, z, axis, 1, len);
  L.box(0, 0, 0, len - 1, 4, 4, c);
  L.box(0, 0, 0, 0, 4, 4, C.indShade); L.box(len - 1, 0, 0, len - 1, 4, 4, C.indShade);   // corner frames
  L.box(len - 1, 1, 1, len - 1, 3, 1, C.indBase); L.box(len - 1, 1, 3, len - 1, 3, 3, C.indBase);   // door bars
  if (len >= 16) { L.box(3, 2, -1, 5, 2, -1, C.white); L.box(3, 2, 5, 5, 2, 5, C.white); }       // logo patch
}
function containerYard(H, g, x0, z0, x1, z1, y0, variant) {
  const yl = y0 - 1, cols = CONT_COLS();
  g.box(x0, yl, z0, x1, yl, z1, C.lotPaveDark);
  const laneZ0 = z0 + 10, laneZ1 = z0 + 13;                        // coarse truck lane
  for (let x = x0; x <= x1; x++) { g.set(x, yl, laneZ0 - 1, C.yellow); g.set(x, yl, laneZ1 + 1, C.yellow); if (x % 4 < 2) g.set(x, yl, (laneZ0 + laneZ1) >> 1, C.white); }
  for (let x = x0; x <= x1; x++) { g.set(x, yl, z0, C.darkGray); g.set(x, yl, z1, C.darkGray); }  // crane rails
  H.fine((F) => {
    const FX0 = 2 * x0 + 2, FX1 = 2 * x1 - 1, Y = 2 * y0;
    const rows = [2 * z0 + 3, 2 * z0 + 9, 2 * z0 + 15, 2 * laneZ1 + 5];
    rows.forEach((fz, r) => {
      if (fz + 4 > 2 * z1 - 1) return;
      let fx = FX0 + ((r * 3 + variant) % 4), k = r * 7 + variant * 3;
      while (fx < FX1) {
        const len = (k % 3 === 1) ? 10 : 20;
        if (fx + len - 1 > FX1) break;
        const n = 1 + ((k * 5 + r) % 3) + (r === 0 ? 0 : (k & 1));
        if ((k % 11) !== 4) for (let s = 0; s < n; s++) container(F, fx, Y + 5 * s, fz, len, cols[(k + s * 3) % cols.length]);
        fx += len + 2; k++;
      }
    });
    // flatbed under the crane with a box on it
    const tx = 2 * 46, tz = 2 * laneZ0 + 1;
    truck(F, tx, Y, tz, 'x', 1, { len: 26, cab: C.indBlue, box: C.darkGray, flat: true });
    truckTrim(F, tx, Y, tz, 'x', 1, { len: 26, cab: C.indBlue, flat: true });
    container(F, tx + 6, Y + 3, tz + 1 - 1, 20, C.orange);
  });
  // portal crane straddling the yard (legs on the rails), trolley + spreader
  H.surf((M) => {
    const cx0 = 49, cx1 = 55, ca = z0 + 0.5, cb = z1 + 0.5, top = y0 + 24, oc = C.orange;
    for (const x of [cx0, cx1]) for (const z of [ca, cb]) M.beam([x, y0, z], [x, top, z], 0.9, oc);
    for (const z of [ca, cb]) {
      M.beam([cx0, top - 0.5, z], [cx1, top - 0.5, z], 0.9, oc);
      M.beam([cx0, y0 + 3, z], [cx1, y0 + 3, z], 0.6, oc);                        // sill beams on bogies
      M.box(cx0 - 0.9, y0, z - 0.7, cx0 + 0.9, y0 + 1.2, z + 0.7, C.darkGray);
      M.box(cx1 - 0.9, y0, z - 0.7, cx1 + 0.9, y0 + 1.2, z + 0.7, C.darkGray);
    }
    for (const x of [cx0, cx1]) M.box(x - 0.6, top, ca - 1.5, x + 0.6, top + 1.4, cb + 1.5, oc);   // main girders
    for (const x of [cx0, cx1]) for (let z = ca; z < cb - 1; z += 3) M.beam([x, top, z], [x, top + 1.4, z + 1.5], 0.2, C.yellow);
    const tz = (z0 + z1) / 2 - 1;
    M.box(cx0 - 0.3, top + 1.4, tz - 1.6, cx1 + 0.3, top + 3.2, tz + 1.6, C.yellow);               // trolley
    M.box(cx1 - 2.2, top - 3.2, cb - 2, cx1 + 0.3, top - 0.9, cb + 0.2, C.indBlue);                // operator cab
    M.box(cx1 - 2, top - 2.6, cb - 0.1, cx1, top - 1.4, cb + 0.25, C.winCool);
    for (const dx of [-1.5, 1.5]) M.beam([(cx0 + cx1) / 2 + dx, top + 1.4, tz], [(cx0 + cx1) / 2 + dx, y0 + 11, tz], 0.12, C.darkGray);
    M.box((cx0 + cx1) / 2 - 3, y0 + 10.2, tz - 0.8, (cx0 + cx1) / 2 + 3, y0 + 11, tz + 0.8, C.yellow);  // spreader
    M.box((cx0 + cx1) / 2 - 2.6, y0 + 7.6, tz - 0.9, (cx0 + cx1) / 2 + 2.6, y0 + 10.2, tz + 0.9, C.teal);   // box on the hook
    for (const x of [cx0, cx1]) M.box(x - 0.2, top + 3.2, ca - 1.2, x + 0.2, top + 3.6, ca - 0.8, C.red);   // beacons
  });
}

function bGreenhouse(rng) {
  const H = hiRes(31, 50, 'greenhouse', false), g = H.g;
  const y0 = lotPlinth(g, 0, 0, 30, 30, { fill: 'grass' });
  const house = (x0, x1, z0, z1) => {
    g.box(x0 - 1, y0 - 1, z0 - 1, x1 + 1, y0 - 1, z1 + 1, C.lotPave);
    g.walls(x0, y0, z0, x1, y0 + 8, z1, C.winCool);
    g.walls(x0, y0, z0, x1, y0, z1, C.white);
    for (let z = z0; z <= z1; z += 4) { g.box(x0, y0, z, x0, y0 + 8, z, C.white); g.box(x1, y0, z, x1, y0 + 8, z, C.white); }
    for (let x = x0; x <= x1; x += 4) { g.box(x, y0, z0, x, y0 + 8, z0, C.white); g.box(x, y0, z1, x, y0 + 8, z1, C.white); }
    const w = x1 - x0;
    for (let q = 0; q <= (w >> 1); q++) {
      const y = y0 + 9 + q, a = x0 + q, b = x1 - q;
      g.box(a, y, z0, a, y, z1, C.winCool); g.box(b, y, z0, b, y, z1, C.winCool);
      g.box(a, y, z0, b, y, z0, C.winCool); g.box(a, y, z1, b, y, z1, C.winCool);
      for (let z = z0; z <= z1; z += 4) { g.set(a, y, z, C.white); g.set(b, y, z, C.white); }
    }
    g.box(x0 + (w >> 1), y0 + 9 + (w >> 1), z0, x0 + (w >> 1), y0 + 9 + (w >> 1), z1, C.white);
    const crop = [C.red, C.orange, C.yellow, C.blossom];
    for (let x = x0 + 2; x <= x1 - 2; x += 3) for (let z = z0 + 2; z <= z1 - 2; z++) {
      g.set(x, y0 + 1, z, C.leafMid); g.set(x, y0 + 2, z, (z & 3) === 0 ? crop[(x + z) % 4] : C.leafLight);
    }
    for (const [side, pl] of [['front', z0], ['back', z1]]) {
      const f = facade(g, side, pl);
      f.clear(x0 + (w >> 1) - 1, y0 + 1, 0, x0 + (w >> 1) + 1, y0 + 6, 0);
      f.box(x0 + (w >> 1) - 1, y0 + 1, -1, x0 + (w >> 1) + 1, y0 + 6, -1, C.roofGreen);
    }
  };
  house(2, 12, 11, 27);
  house(16, 26, 11, 27);
  // farm stand + veg crates, tractor, water tank, hay
  const veg = [C.red, C.orange, C.roofGreen, C.yellow];
  for (let i = 0; i < 4; i++) { g.box(2 + i * 4, y0, 3, 4 + i * 4, y0 + 2, 5, C.wood); g.box(2 + i * 4, y0 + 3, 3, 4 + i * 4, y0 + 3, 5, veg[(i + ((rng() * 4) | 0)) % 4]); }
  sign(facade(g, 'front', 8), 8, y0 + 5, 'FARM', { bg: C.roofGreen, fg: C.signWhite, border: C.white, pad: 1 });
  g.box(2, y0, 7, 2, y0 + 4, 7, C.woodDark); g.box(16, y0, 7, 16, y0 + 4, 7, C.woodDark);
  // r9: the tractor is drawn in the res-8 fine part (half size — it stood as tall as the greenhouse eaves)
  H.fine((F) => {
    const T = lf(F, 44, 2 * y0, 6, 'x', 1, 9);
    T.box(0, 0, 0, 1, 3, 1, C.black); T.box(0, 0, 4, 1, 3, 5, C.black);
    T.box(6, 0, 0, 7, 1, 0, C.black); T.box(6, 0, 5, 7, 1, 5, C.black);
    T.box(1, 2, 1, 8, 4, 4, C.red); T.box(1, 5, 1, 3, 8, 4, C.winCool); T.box(1, 9, 1, 3, 9, 4, C.red);
    T.box(7, 5, 2, 7, 7, 2, C.darkGray);
  });
  tank(g, 28, 7, 2, y0, 12, { c: C.indBlue, bands: [8], band: C.white, ladder: false });
  for (const [hx, hz] of [[27, 28], [27, 25]]) { g.box(hx, y0, hz, hx + 2, y0 + 2, hz + 2, C.gold); g.box(hx, y0 + 1, hz, hx + 2, y0 + 1, hz + 2, C.amber); }
  tree(g, 13, y0, 3, 5);
  return H.done();
}

// ===========================================================================
// WIND POWER — tower + nacelle; the 3-blade rotor is the animated part.
// Base authored with the nacelle nose toward min-Z (flipped to +Z).
// ===========================================================================
const WP_HUB_Y = 132, WP_NOSE_Z = 9, WP_TX = 15, WP_TZ = 17;
function bWindPower(rng) {
  const g = grid(31, WP_HUB_Y + 8, 31, R);
  const y0 = lotPlinth(g, 0, 0, 30, 30, { fill: 'grass' });
  const trim = pk(rng, [C.roofGreen, C.indBlue, C.teal]);
  g.box(13, y0 - 1, 1, 17, y0 - 1, 12, C.lotPave);
  cylinder(g, WP_TX, WP_TZ, 6, y0, y0 + 1, C.indShade);
  ring(g, WP_TX, WP_TZ, 6, y0 + 1, y0 + 1, C.white);
  // tapered tower in clean turned sections (r 3 → 2 → 1.5) with collars
  const t1 = y0 + 44, t2 = y0 + 96;
  ring(g, WP_TX, WP_TZ, 3, y0 + 2, t1, C.indBlade);
  ring(g, WP_TX, WP_TZ, 2, t1 + 1, t2, C.indBlade);
  ring(g, WP_TX, WP_TZ, 1.5, t2 + 1, WP_HUB_Y - 4, C.indBlade);
  ring(g, WP_TX, WP_TZ, 3, t1, t1, C.indShade); ring(g, WP_TX, WP_TZ, 2, t2, t2, C.indShade);
  ring(g, WP_TX, WP_TZ, 3, y0 + 2, y0 + 7, trim);
  ring(g, WP_TX, WP_TZ, 3, y0 + 9, y0 + 9, trim);
  const TF = facade(g, 'front', WP_TZ - 3);
  TF.box(WP_TX - 1, y0 + 2, 0, WP_TX + 1, y0 + 7, 0, C.indBase);
  g.box(WP_TX - 1, y0, WP_TZ - 5, WP_TX + 1, y0 + 1, WP_TZ - 4, C.indShade);
  g.box(WP_TX - 3, WP_HUB_Y - 3, WP_NOSE_Z + 1, WP_TX + 3, WP_HUB_Y + 3, WP_TZ + 6, C.indBlade);
  g.box(WP_TX - 3, WP_HUB_Y - 3, WP_TZ + 6, WP_TX + 3, WP_HUB_Y - 3, WP_TZ + 6, C.indShade);
  g.box(WP_TX - 3, WP_HUB_Y + 1, WP_NOSE_Z + 3, WP_TX + 3, WP_HUB_Y + 1, WP_TZ + 5, trim);
  g.box(WP_TX - 1, WP_HUB_Y + 4, WP_TZ + 2, WP_TX + 1, WP_HUB_Y + 4, WP_TZ + 4, C.indShade);
  g.set(WP_TX, WP_HUB_Y + 5, WP_TZ + 4, C.red);
  g.box(22, y0, 4, 27, y0 + 5, 8, C.indShade);
  g.box(22, y0 + 6, 4, 27, y0 + 6, 8, C.indRoof);
  g.box(23, y0 + 2, 3, 26, y0 + 3, 3, C.yellow);
  fenceX(g, 21, 28, y0, 2);
  bush(g, 3, y0, 3, 7, 6);
  // info board + bench on a little paved nook at the back left
  g.box(2, y0 - 1, 21, 10, y0 - 1, 29, C.lotPave);
  const IB = facade(g, 'back', 27);
  g.box(4, y0, 27, 4, y0 + 5, 27, C.darkGray); g.box(9, y0, 27, 9, y0 + 5, 27, C.darkGray);
  signPanel(IB, 3, 10, y0 + 6, y0 + 12, trim, { border: C.white, out: 0 });
  signPanel(facade(g, 'front', 27), 3, 10, y0 + 6, y0 + 12, trim, { border: C.white, out: 0 });
  for (const [x, y] of [[6, 8], [7, 9], [7, 10], [6, 10], [5, 9]]) { g.set(x, y0 + y, 26, C.lime); g.set(x, y0 + y, 28, C.lime); }
  bench(g, 3, y0, 22, 'x', 6, {});
  tree(g, 26, y0, 26, 6); tree(g, 4, y0, 13, 5);
  for (const [x, z] of [[20, 27], [22, 28]]) { g.box(x, y0, z, x + 2, y0 + 1, z + 1, C.stone); g.set(x + 1, y0 + 2, z, C.stoneDark); }
  for (const [x, z, c] of [[4, 22, C.yellow], [7, 25, C.signWhite], [24, 24, C.red], [26, 20, C.blossom], [5, 12, C.signWhite]]) { g.set(x, y0, z, C.leafMid); g.set(x, y0 + 1, z, c); }
  return g.done();
}
function _windSpinner() {                         // 3-blade rotor in the X/Y plane, spins about Z
  const Lb = 52, S = 2 * Lb + 1, c = Lb;
  const g = grid(S, S, 5, R);
  for (let q = 0; q < 3; q++) {
    const a = -Math.PI / 2 + q * 2 * Math.PI / 3;
    const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    for (let r = 3; r <= Lb; r += 0.5) {
      const w = r < 14 ? 3.2 : 3.2 - 1.9 * (r - 14) / (Lb - 14);   // chord tapers root → tip
      for (let s = -w; s <= w * 0.5; s += 0.5) {
        const x = Math.round(c + ux * r + px * s), y = Math.round(c + uy * r + py * s);
        const col = r > Lb - 7 ? C.red : C.indBlade;
        g.set(x, y, 2, col); if (s < w * 0.2) g.set(x, y, 1, col);
      }
    }
  }
  for (let z = 0; z < 5; z++) {
    const rr = z < 3 ? 3 : z === 3 ? 2 : 1;
    for (const [ddx, ddy] of discOff(rr)) g.set(c + ddx, c + ddy, z, z >= 3 ? C.indShade : C.indBlade);
  }
  return g.done();
}

// ---------------------------------------------------------------------------
// Registry: catalog id -> builder (rng, variant, entry) => model. Merged by
// catalog.js; CATALOG metadata (name/emoji/footprint/cap) stays in catalog.js.
// ---------------------------------------------------------------------------
export const BUILDERS = {
  'workshop': bWorkshop, 'toy-factory': bToyFactory, 'chocolate-factory': bChocolate,
  'robot-factory': bRobotFactory, 'rocket-lab': bRocketLab, 'sawmill': bSawmill,
  'juice-factory': bJuiceFactory, 'cookie-factory': bCookieFactory,
  'warehouse': bWarehouse, 'recycling-center': bRecycling,
  'mega-factory': bMegaFactory,
  'cheese-factory': bCheese, 'crayon-factory': bCrayon, 'balloon-factory': bBalloonFactory,
  'car-factory': bCarFactory, 'bakery-plant': bBakeryPlant, 'greenhouse-farm': bGreenhouse,
  'wind-power': bWindPower,
};

// Animated parts: id -> () => { part, ox,oy,oz (WORLD units), ax,ay,az, speed }
// Rotor centre: hub voxel (WP_TX, WP_HUB_Y) in the base, in front of the
// nacelle nose. After flipZ the nose sits at z' = 30 - WP_NOSE_Z; the rotor's
// 5-deep part centre (z 2) sits 2 voxels further out.
// Chimney mouths, for life.js smoke: id -> (variant) => [[ox, oy, oz], ...]
// in WORLD units from the footprint centre at ground, model-local AFTER the
// catalog's flipZ (the ANIMS offset convention). Puffs come out of the real
// stacks instead of hanging mid-air over every tile. [] = a clean building.
const _vent = (S, x, y, z) => [(x - (S - 1) / 2) / R, (y + 1) / R, ((S - 1) / 2 - z) / R];
const _wv = (kind, n, H) => () => WSTACK[kind].slice(0, n).map(([x, z]) => _vent(31, x, H || W_STACK_H, z));
export const VENTS = {
  // w2 r1: one puff source per works, two on the mega (life's puffs read as
  // floating white cubes when every stack in a packed district smokes)
  'workshop': _wv('dock', 1, 40), 'robot-factory': _wv('dock', 1), 'car-factory': _wv('dock', 1),
  'cookie-factory': () => [], 'chocolate-factory': _wv('process', 1),
  'balloon-factory': _wv('process', 1), 'bakery-plant': _wv('process', 1, 44),
  'toy-factory': () => [], 'crayon-factory': () => [],
  'recycling-center': () => [], 'cheese-factory': () => [], 'juice-factory': () => [],
  'sawmill': () => [], 'warehouse': () => [], 'greenhouse-farm': () => [],
  'rocket-lab': () => [], 'wind-power': () => [],
  // mega: design coords turned 180° (rot180) → stored x' = 94 - x, z' = 94 - z
  'mega-factory': (variant) => ((variant | 0) % 2 === 1
    ? [_vent(95, 94 - 41, 104, 94 - 29), _vent(95, 94 - 68.25, 74, 94 - 26.25)]
    : [[41, 31, 96], [57, 31, 92]].map(([x, z, y]) => _vent(95, 94 - x, y, 94 - z))),
};

export const ANIMS = {
  'wind-power': () => ({
    part: _windSpinner(),
    ox: (WP_TX - 15) / R, oy: (WP_HUB_Y + 0.5) / R, oz: ((30 - WP_NOSE_Z) + 2 - 15) / R,
    ax: 0, ay: 0, az: 1, speed: 1.4,
  }),
};

