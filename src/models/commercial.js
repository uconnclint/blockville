// Blockville models — SHOPS / FOOD / COMMERCIAL: zoned C growth (commercial) +
// catalog 'shops' (+ the barber-pole spinner part).
//
// Round 9: the r8 critic's gap was flat, empty grey roofs, repeated grids of
// identical windows and warped chunky lettering. Roofs are now divided into
// cells, each holding one module (roofScape: garden beds of cube bushes, tiled
// patios, HVAC pads, solar, stair houses, pergolas, tanks, courts) inside a
// light rim and a white overhanging parapet cap; upper windows come in groups
// between pilasters under a white cornice; names use a bold 5×7 font on a
// proud bordered sign panel.
//
// Round 7: the r6 critic's gap was frontage density — separate boxes on
// mostly-empty lots, big flat upper walls with a few chunky windows. Now every
// 1×1 shop fills its LOT WIDTH (party walls: a row reads as one continuous
// ref05 street frontage), floors are UP = 16 (was 26) with many small framed
// windows, sills, belt courses, quoins, balconies and blade signs, roofs get
// paver lines + planter runs, and both 12-deep aprons are packed by `apron()`
// (goods displays under every awning + slot items: stalls, carts, tables,
// bikes, parked cars, people).
//
// Round 6: everything here is authored at res 8 (64 fine voxels per tile; a
// 1×1 canvas is 63×63, the cinema 127×63, the mall 191×191), like the homes.
// The r5 critic's verdict was that the res-4 shops were "3-4x too coarse": a
// blank box with 2-3 big panes per face, a blurry pictogram on a pole and a
// bare roof. At res 8 every shop is built from the Isometric City Voxel kit:
//   * the frontage is divided into many framed glass BAYS (1-voxel frames,
//     mullions, a transom, a kick plate, a glint), each with its own striped
//     sloped AWNING, between wall piers, with proud corner piers;
//   * the name is crisp 5×7 LETTERING on a fascia band (a stripe below, a
//     cornice above) that runs round the building; the sides carry 7×7 logo
//     tiles (like ref05's 'M' tiles) instead of floating icon boards;
//   * upper storeys have framed sash windows with sills, shutters and flower
//     boxes, belt courses and a cornice;
//   * roofs have a parapet with coping, AC units with fan grilles and louvres,
//     mushroom vents, hatches, skylights, solar arrays, tanks, and TERRACES
//     with tables, parasols and planters;
//   * the lot carries the life: paving grids, café sets with parasols,
//     planters, benches, bins, bikes, lamps, trees, people, striped parking
//     with the traffic's cars, market stalls.
//
// Coordinates (pre-flipZ, entrance toward min-Z; FINE voxels): the lot plinth
// is 4 rows (0.5 units, top surface y 3); everything stands on y G = 4.
// Ground floor rows (t = extra height of a tall shop):
//   4..5 base course, 5 bay-frame sill, 6..7 kick plates, 8..23+t glass,
//   24+t frame head, 25..26+t awning root, 27+t accent stripe (proud 1),
//   28..36+t fascia band (proud 1, lettering 29..35+t), 37+t cornice (proud 2)
//   = the GF roof deck; parapet 38..39+t, coping 40+t; roof props stand on 38+t.
// Upper storeys are UP = 26 rows each above the GF cornice.
//
// Budget: greedy meshing makes flat faces ~free; detail costs triangles where
// it breaks a surface. Frames and mullions sit FLUSH with the wall (the glass
// is recessed), stripes run along faces, and nothing is a checkerboard.

import { C, PALETTE, pk, facade, lotPlinth, solarPanel, signLit, flipZ } from './core.js';
import { stampCar, stampPerson } from './vehicles.js';
import { stampVeg } from './vegetation.js';

const R = 8;          // voxels per world unit for every model in this file
const G = 4;          // stand height: top of the 0.5-unit lot plinth
const LT = G - 1;     // lot surface row
const UP = 16;        // upper storey height (r7: was 26; finer ref05 floor rhythm)

// ---------------------------------------------------------------------------
// Fast voxel grid (typed array; same API as core's grid): res-8 shops set
// 30k-300k voxels, which the Map-of-strings grid is slow at.
// ---------------------------------------------------------------------------
function grid(sx, sy, sz) {
  const cell = new Uint8Array(sx * sy * sz);
  const I = (x, y, z) => (y * sz + z) * sx + x;
  const self = {
    sx, sy, sz, res: R,
    set(x, y, z, c) {
      x = Math.round(x); y = Math.round(y); z = Math.round(z);
      if (c == null || x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      cell[I(x, y, z)] = c + 1;
    },
    get(x, y, z) {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null;
      const v = cell[I(x, y, z)]; return v ? v - 1 : null;
    },
    del(x, y, z) {
      x = Math.round(x); y = Math.round(y); z = Math.round(z);
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      cell[I(x, y, z)] = 0;
    },
    box(x0, y0, z0, x1, y1, z1, c) {
      if (c == null) return;
      if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      if (z0 > z1) { const t = z0; z0 = z1; z1 = t; }
      x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0)); z0 = Math.max(0, Math.round(z0));
      x1 = Math.min(sx - 1, Math.round(x1)); y1 = Math.min(sy - 1, Math.round(y1)); z1 = Math.min(sz - 1, Math.round(z1));
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const b = I(0, y, z); cell.fill(c + 1, b + x0, b + x1 + 1); }
    },
    clearBox(x0, y0, z0, x1, y1, z1) {
      for (let y = Math.max(0, y0); y <= Math.min(sy - 1, y1); y++) for (let z = Math.max(0, z0); z <= Math.min(sz - 1, z1); z++)
        for (let x = Math.max(0, x0); x <= Math.min(sx - 1, x1); x++) cell[I(x, y, z)] = 0;
    },
    walls(x0, y0, z0, x1, y1, z1, c) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) { this.set(x, y, z0, c); this.set(x, y, z1, c); }
        for (let z = z0; z <= z1; z++) { this.set(x0, y, z, c); this.set(x1, y, z, c); }
      }
    },
    done() {
      const blocks = [];
      for (let y = 0, i = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++, i++) {
        const v = cell[i];
        if (v) blocks.push([x, y, z, v - 1]);
      }
      const m = { sx, sy, sz, blocks, res: R };
      // w4r4: the res-16 FINE part (sign lettering) rides along as model.parts;
      // stored UNflipped here — the catalog wrapper (BUILDERS) flips it with the base
      if (self.__fine) { const p = self.__fine.done(); if (p.blocks.length) { m.parts = [p]; m.__fine = p; } }
      return m;
    },
  };
  return self;
}
// ---------------------------------------------------------------------------
// w4r4 FINE SIGN PART (res 16 = half a shop voxel). Critics w4r2 + w4r3 +
// coordinator 21:15: our names were "chunky, low-resolution pixel lettering"
// while ref05's Mac Auto / SUPERMARKET signs are thin crisp letters on a slim
// panel. A res-8 voxel is too coarse for a 5x7 glyph at 1/4-storey size, so
// the name panels (board + frame + letters) are laid into a sparse res-16
// grid that becomes model.parts (engine: a child mesh on the same footprint,
// as civic hiText / industrial hiRes). Sparse: only sign voxels are stored and
// the part's height is trimmed to its highest voxel.
// ---------------------------------------------------------------------------
const RF = 2 * R;
function fineGrid(g) {
  if (!g.__fine) {
    const sx = g.sx * 2, sz = g.sz * 2, m = new Map();
    g.__fine = {
      sx, sz, res: RF,
      set(x, y, z, c) {
        x = Math.round(x); y = Math.round(y); z = Math.round(z);
        if (c == null || x < 0 || y < 0 || z < 0 || x >= sx || z >= sz) return;
        m.set((y * sz + z) * sx + x, c);
      },
      done() {
        const blocks = []; let my = 0;
        for (const [k, c] of m) {
          const x = k % sx, t = (k - x) / sx, z = t % sz, y = (t - z) / sz;
          blocks.push([x, y, z, c]); if (y > my) my = y;
        }
        return { sx, sy: my + 1, sz, blocks, res: RF };
      },
    };
  }
  return g.__fine;
}
// Fine facade from a res-8 facade handle: u / y in FINE voxels (res-8 u spans
// fine 2u, 2u+1); o = fine layers out, o 0 = the OUTER fine layer of the wall
// voxel itself, so a res-8 layer `out` k is fine o 2k-1 (inner) + 2k (outer).
function fineFace(f) {
  const H = fineGrid(f.g), p = f.plane, alongX = f.side === 'front' || f.side === 'back';
  const neg = f.side === 'front' || f.side === 'left', w0 = neg ? 2 * p : 2 * p + 1, sg = neg ? -1 : 1;
  const set = (u, y, o, c) => { const w = w0 + sg * o; if (alongX) H.set(u, y, w, c); else H.set(w, y, u, c); };
  return {
    rd: f.rd, set,
    box(u0, y0, o0, u1, y1, o1, c) {
      for (let o = Math.min(o0, o1); o <= Math.max(o0, o1); o++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) set(u, y, o, c);
    },
  };
}
const paint = (g, x0, z0, x1, z1, c) => g.box(x0, LT, z0, x1, LT, z1, c);
// z-mirrored view of a grid (lot dressing for the back apron)
function mirrorZ(g) {
  const Z = g.sz - 1;
  return {
    sx: g.sx, sy: g.sy, sz: g.sz, res: g.res, __base: g, __Z: Z,   // lot parts (cars, people) stamp into __base
    set: (x, y, z, c) => g.set(x, y, Z - z, c), get: (x, y, z) => g.get(x, y, Z - z), del: (x, y, z) => g.del(x, y, Z - z),
    box: (x0, y0, z0, x1, y1, z1, c) => g.box(x0, y0, Z - z1, x1, y1, Z - z0, c),
    clearBox: (x0, y0, z0, x1, y1, z1) => g.clearBox(x0, y0, Z - z1, x1, y1, Z - z0),
    walls: (x0, y0, z0, x1, y1, z1, c) => g.walls(x0, y0, Z - z1, x1, y1, Z - z0, c),
  };
}
const SETT = C.stone, SETT_J = C.concrete;   // w4r2 shop-lot setts + joints
function lot(g, x1, z1, fill = C.lotPave) { lotPlinth(g, 0, 0, x1, z1, { h: G, fill }); }
// light paving grid (1-unit slabs) over an area
function paveGrid(g, x0, z0, x1, z1, c = C.lotPaveDark, step = 8) {
  for (let x = x0 + step - 1; x < x1; x += step) paint(g, x, z0, x, z1, c);
  for (let z = z0 + step - 1; z < z1; z += step) paint(g, x0, z, x1, z, c);
}

// ---------------------------------------------------------------------------
// Lettering: a 5×7 font for names (crisp at res 8) and the 3×5 font for
// long words. Drawn FLAT on the band face (lesson r1-r5: proud letters and
// letters touching a same-colour ring read as gibberish).
// ---------------------------------------------------------------------------
const F7 = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],   // w4r4: full diagonal (DINER read DIHER)
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['..', '..', '..', '..', '..', '..', '..'],
  "'": ['#', '#', '.', '.', '.', '.', '.'],
  '&': ['.##..', '#..#.', '.##..', '.#...', '#.#.#', '#..#.', '.##.#'],
};
const F5 = {
  A: '.#.#.#####.##.#', B: '##.#.###.#.###.', C: '.###..#..#...##', D: '##.#.##.##.###.',
  E: '####..##.#..###', F: '####..##.#..#..', G: '.###..#.##.#.##', H: '#.##.#####.##.#',
  I: '###.#..#..#.###', J: '..#..#..##.#.#.', K: '#.###.#..##.#.#', L: '#..#..#..#..###',
  N: '##.#.##.##.##.#', O: '.#.#.##.##.#.#.', P: '##.#.###.#..#..',
  Q: '.#.#.##.###..##', R: '##.#.###.#.##.#', S: '.###...#...###.', T: '###.#..#..#..#.',
  U: '#.##.##.##.####', V: '#.##.##.##.#.#.', X: '#.##.#.#.#.##.#',
  Y: '#.##.#.#..#..#.', Z: '###..#.#.#..###', ' ': '...............', '&': '.#.#.#.#.#.##.#',
};
const WIDE5 = { W: ['#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'], M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'] };
function glyph(ch, big) {
  if (big) return F7[ch] || F7[' '];
  if (WIDE5[ch]) return WIDE5[ch];
  const s = F5[ch] || F5[' '];
  return [s.slice(0, 3), s.slice(3, 6), s.slice(6, 9), s.slice(9, 12), s.slice(12, 15)];
}
function textW(s, big, sc = 1) {
  let w = -1;
  for (const ch of String(s).toUpperCase()) w += glyph(ch, big)[0].length + 1;
  return w * sc;
}
// Centred text on a facade; y = bottom row. Returns the width.
function text(f, cu, y, s, c, out, big, sc = 1) {
  s = String(s).toUpperCase();
  c = signLit(c);   // [night] sign letters light up after dusk; same colour by day
  const w = textW(s, big, sc);
  let u = cu - f.rd * Math.floor((w - 1) / 2);
  for (const ch of s) {
    const rows = glyph(ch, big), gw = rows[0].length, gh = rows.length;
    for (let r = 0; r < gh; r++) for (let i = 0; i < gw; i++) if (rows[r][i] === '#')
      for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) f.set(u + f.rd * (i * sc + a), y + (gh - 1 - r) * sc + b, out, c);
    u += f.rd * (gw + 1) * sc;
  }
  return w;
}
// (r8-r9 bold 2× sign fonts removed in r10: signs are small boards now)

// 7×7 logos for the band tiles / blade signs ('.' = tile background).
const LOGO = {
  donut: [['.ooooo.', 'oo#s#oo', 'o#...#o', 'os...so', 'o#...#o', 'oo#s#oo', '.ooooo.'], { o: C.comDough, '#': C.comIcing, s: C.signWhite }],
  cone: [['..ppp..', '.ppppp.', '.pwppp.', '.ccccc.', '..ccc..', '..ccc..', '...c...'], { p: C.pink, w: C.signWhite, c: C.comCone }],
  burger: [['.bbbbb.', 'bbwbwbb', 'lllllll', 'ppppppp', 'yyyyyyy', 'bbbbbbb', '.bbbbb.'], { b: C.comDough, w: C.signWhite, l: C.comLettuce, p: C.comPatty, y: C.comCheese }],
  pizza: [['ddddddd', '.yryry.', '.yyyyy.', '..yry..', '..yyy..', '...y...', '...y...'], { d: C.comDough, y: C.comCheese, r: C.red }],
  cup: [['.s.s...', '..s.s..', 'wwwww..', 'wwwwwww', 'wwwww.w', 'wwwwww.', '.www...'], { s: C.stone, w: C.comChoco }],
  blocks: [['rrr.bbb', 'rrr.bbb', 'rrr.bbb', '.......', '..yyy..', '..yyy..', '..yyy..'], { r: C.red, b: C.blue, y: C.yellow }],
  paw: [['.o.o.o.', '.......', 'o.....o', '..ooo..', '.ooooo.', '.ooooo.', '..ooo..'], { o: C.roofBrown }],
  book: [['.......', 'rwwrwwr', 'rwwrwwr', 'rwwrwwr', 'rwwrwwr', 'rrrrrrr', '.......'], { r: C.red, w: C.cream }],
  flower: [['..p.p..', '.ppppp.', '..pyp..', '.ppppp.', '..p.p..', '...g...', '..gg...'], { p: C.pink, y: C.yellow, g: C.leafMid }],
  cart: [['c......', '.cccccc', '.cwcwcc', '.cccccc', '..cccc.', '.......', '..k..k.'], { c: C.roofGreen, w: C.signWhite, k: C.black }],
  joy: [['...r...', '..rrr..', '...k...', '...k...', '.kkkkk.', 'kkkkkkk', 'kkkkkkk'], { r: C.red, k: C.black }],
  lolly: [['.rrrr..', 'rwwwwr.', 'rwrrwr.', 'rwrwwr.', '.rrrr..', '....w..', '.....w.'], { r: C.red, w: C.signWhite }],
  note: [['..nnnnn', '..n...n', '..n...n', '..n...n', 'nnn.nnn', 'nnn.nnn', '.......'], { n: C.purple }],
  ball: [['..www..', '.wkkkw.', 'wwwkwww', 'wkwwwkw', 'wwkkkww', '.wwkww.', '..www..'], { w: C.signWhite, k: C.black }],
  scissor: [['k.....k', '.k...k.', '..k.k..', '...k...', '.rr.rr.', 'r..r..r', '.rr.rr.'], { k: C.stoneDark, r: C.red }],
  star: [['...y...', '...y...', 'yyyyyyy', '.yyyyy.', '..yyy..', '.yy.yy.', '.y...y.'], { y: C.yellow }],
  film: [['kwkwkwk', 'kkkkkkk', 'wwwwwww', 'wkkkkkw', 'wkkkkkw', 'wkkkkkw', 'wwwwwww'], { w: C.signWhite, k: C.black }],
  bag: [['..k.k..', '.k...k.', 'rrrrrrr', 'rrrrrrr', 'rrwwwrr', 'rrrrrrr', 'rrrrrrr'], { k: C.comFrame, r: C.red, w: C.signWhite }],
  apple: [['...g...', '..gr...', '.rrrrr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..r.r..'], { g: C.leafMid, r: C.red }],
  shop: [['.......', 'bbbbbbb', 'b.b.b.b', '.......', '.wwwww.', '.w.w.w.', '.wwwww.'], { b: C.red, w: C.navy }],
};
// 9×9 tile (1-voxel border + 7×7 art on bg), flat at `out`; (cu, y0) = bottom centre.
function logoTile(f, cu, y0, logo, bg, bd, out = 1) {
  f.box(cu - 4, y0, out, cu + 4, y0 + 8, out, bd);
  f.box(cu - 3, y0 + 1, out, cu + 3, y0 + 7, out, bg);
  if (!logo) return;
  const [rows, map] = logo;
  for (let r = 0; r < 7; r++) for (let i = 0; i < 7; i++) {
    const c = map[rows[r][i]];
    if (c != null) f.set(cu + f.rd * (i - 3), y0 + 7 - r, out, c);
  }
}

// r10 SMALL SIGN BOARD. The r9 critic: "huge blocky pixel-font signs fill the
// shop facades ... ref05's shops have small, crisp signs" (and r2, r3, r7 said
// the same). ref02's SHOP and ref05's Mac Auto are compact boards with small
// lettering. This is a 1-voxel-thick board, 7 rows: a 1-voxel frame round the
// 3×5 lettering (5 rows, 1/3 of a storey) with 2 columns of margin each side.
// The letters are FLUSH in the board face (same depth, only a colour change),
// so no AO or ink edge eats the 1-voxel strokes (the r7 lesson came from
// letters standing proud of the band). (cu, y0) = bottom centre; returns the
// board's width.
const lum = (c) => { const h = PALETTE[c] || 0; return (0.3 * (h >> 16) + 0.59 * ((h >> 8) & 255) + 0.11 * (h & 255)) / 255; };
function signBoard(f, cu, y0, s, o) {
  s = String(s).toUpperCase();
  const w = textW(s, false), out = o.out != null ? o.out : 2, pad = o.pad != null ? o.pad : 2;
  const ua = cu - f.rd * (Math.floor((w - 1) / 2) + pad + 1), ub = ua + f.rd * (w + 2 * pad + 1);
  if (o.thick) f.box(ua, y0, out - o.thick, ub, y0 + 6, out - 1, o.bd);
  f.box(ua, y0, out, ub, y0 + 6, out, o.bd);
  f.box(ua + f.rd, y0 + 1, out, ub - f.rd, y0 + 5, out, o.bg);
  text(f, cu, y0 + 1, s, o.fg, out, false);
  if (o.lamps) for (const u of [ua, ub]) f.set(u, y0 + 7, out, C.lamp);
  return w + 2 * pad + 2;
}
const boardW = (s) => textW(s, false) + 6;
// r11 BOLD SIGN. The r10 critic: "the BAKERY fascia letters are mushy and hard
// to read ... ref02 does it with one bold, crisp white-on-dark SHOP sign; make
// the sign letters thicker and higher-contrast so they read at gallery zoom".
// The 5×7 font faux-bolded (every '#' also inks the column to its right), so
// every vertical stroke is 2 voxels and the counters stay open: B = '##..##'.
// 7 rows tall (not the r8/r9 10-row 2× fonts the r9 critic called billboards),
// 1 clear column between letters, white on a near-black board (C.black; the palette is full at 200).
function boldGlyph(ch) {
  const rows = F7[ch] || F7[' '];
  return rows.map((r) => { let o = ''; for (let i = 0; i <= r.length; i++) o += (r[i] === '#' || r[i - 1] === '#') ? '#' : '.'; return o; });
}
function boldW(s) { let w = -1; for (const ch of String(s).toUpperCase()) w += boldGlyph(ch)[0].length + 1; return w; }
const boldBoardW = (s) => boldW(s) + 8;         // frame 1 + margin 3 each side
function boldText(f, cu, y, s, c, out) {
  s = String(s).toUpperCase();
  const w = boldW(s);
  let u = cu - f.rd * Math.floor((w - 1) / 2);
  for (const ch of s) {
    const rows = boldGlyph(ch), gw = rows[0].length;
    for (let r = 0; r < 7; r++) for (let i = 0; i < gw; i++) if (rows[r][i] === '#') f.set(u + f.rd * i, y + 6 - r, out, c);
    u += f.rd * (gw + 1);
  }
  return w;
}
// w2r1 SLIM BOLD FASCIA LETTERING. The consensus across critics: one slim,
// bold, legible sign — letters 1/4-1/3 of a storey (UP = 16, so 5 rows) on a
// contrasting panel (ref05 SUPERMARKET / Mac Auto, ref02 SHOP). The r11 7-row
// bold board (plus a 10-row band) read as a billboard; the r10 3×5 letters with
// 1-voxel strokes read as mush. This font is 5 rows tall with 2-voxel vertical
// stems and 1-voxel bars (the ref02 pixel-font look), so strokes survive the
// AO / edge pass and the counters stay open.
const F5B = {
  A: ['.###.', '##.##', '#####', '##.##', '##.##'], B: ['####.', '##.##', '####.', '##.##', '####.'],
  C: ['.####', '##...', '##...', '##...', '.####'], D: ['####.', '##.##', '##.##', '##.##', '####.'],
  E: ['#####', '##...', '####.', '##...', '#####'], F: ['#####', '##...', '####.', '##...', '##...'],
  G: ['.####', '##...', '##.##', '##.##', '.####'], H: ['##.##', '##.##', '#####', '##.##', '##.##'],
  I: ['##', '##', '##', '##', '##'], J: ['...##', '...##', '...##', '##.##', '.###.'],
  K: ['##..#', '##.#.', '###..', '##.#.', '##..#'], L: ['##...', '##...', '##...', '##...', '#####'],
  M: ['##...##', '###.###', '##.#.##', '##...##', '##...##'], N: ['##...##', '###..##', '##.#.##', '##..###', '##...##'],
  O: ['.###.', '##.##', '##.##', '##.##', '.###.'], P: ['####.', '##.##', '####.', '##...', '##...'],
  Q: ['.###.', '##.##', '##.##', '##.#.', '.##.#'], R: ['####.', '##.##', '####.', '##.#.', '##.##'],
  S: ['.####', '##...', '.###.', '...##', '####.'], T: ['######', '..##..', '..##..', '..##..', '..##..'],
  U: ['##.##', '##.##', '##.##', '##.##', '.###.'], V: ['##.##', '##.##', '##.##', '.###.', '..#..'],
  W: ['##...##', '##...##', '##.#.##', '###.###', '##...##'], X: ['##.##', '.###.', '..#..', '.###.', '##.##'],
  Y: ['##..##', '##..##', '.####.', '..##..', '..##..'], Z: ['#####', '...##', '.###.', '##...', '#####'],
  ' ': ['...', '...', '...', '...', '...'], '&': ['.##..', '#..#.', '.##.#', '#..#.', '.##.#'],
};
// w4r3 FINE SIGN FONT (critic w4r2: "the block-letter signs are oversized and
// chunky"; ref05's Mac Auto / SUPERMARKET lettering is thin white strokes on a
// coloured panel). 4×5 glyphs with 1-voxel strokes, FLUSH in the panel face
// (so no AO / edge pass eats them) — at the 2x shots a voxel is ~9 px, so the
// strokes stay crisp while the panel shrinks by a third. (The r10 3×5 font
// read mushy at 1x: 3-wide counters close up; 4-wide ones stay open.)
const F5T = {
  A: ['.##.', '#..#', '####', '#..#', '#..#'], B: ['###.', '#..#', '###.', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '.###'], D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'], F: ['####', '#...', '###.', '#...', '#...'],
  G: ['.###', '#...', '#.##', '#..#', '.###'], H: ['#..#', '#..#', '####', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '###'], J: ['...#', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'], L: ['#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'], P: ['###.', '#..#', '###.', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#.#.', '.#.#'], R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '###.'], T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  U: ['#..#', '#..#', '#..#', '#..#', '.##.'], V: ['#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'], X: ['#..#', '#..#', '.##.', '#..#', '#..#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'], Z: ['####', '...#', '.##.', '#...', '####'],
  ' ': ['..', '..', '..', '..', '..'], '&': ['.#..', '#.#.', '.#.#', '#.#.', '.#.#'],
};
const SF = F5T;
function stemW(s) { let w = -1; for (const ch of String(s).toUpperCase()) w += (SF[ch] || SF[' '])[0].length + 1; return w; }
function stemText(f, cu, y, s, c, out) {
  s = String(s).toUpperCase();
  const w = stemW(s);
  let u = cu - f.rd * Math.floor((w - 1) / 2);
  for (const ch of s) {
    const rows = SF[ch] || SF[' '], gw = rows[0].length;
    for (let r = 0; r < 5; r++) for (let i = 0; i < gw; i++) if (rows[r][i] === '#') f.set(u + f.rd * i, y + 4 - r, out, c);
    u += f.rd * (gw + 1);
  }
  return w;
}
// w4r4 FINE NAME PANEL (res-16 part, see fineFace). Replaces the w2r1-w4r3
// res-8 9-row panel whose 5-row 1-voxel-stroke letters the w4r2/w4r3 critics
// called "oversized, chunky, low-resolution pixel lettering". Now: the 5x7
// font (F7) with 1-FINE-voxel strokes (half a shop voxel), 7 fine rows tall
// (~1/5 of a storey, Mac Auto size), FLUSH in a 1-fine-thick board face, a
// 1-fine frame standing one fine layer proud, 2 fine rows / 3 columns of
// padding: 13 fine rows = 6.5 shop rows (was 9). Still called with res-8
// (cu, y0) and still returns / is sized by its width in res-8 voxels.
const panelFW = (s) => textW(s, true) + 8;
const panelW = (s) => Math.ceil(panelFW(s) / 2);
function namePanel(f, cu, y0, s, o) {
  s = String(s).toUpperCase();
  const H = fineFace(f), out = o.out != null ? o.out : 2;
  const PW = panelFW(s), lo = 2 * cu + 1 - (PW >> 1), hi = lo + PW - 1;
  // the board sits on the wall / band face: out k (res-8 layer k) -> the first
  // fine layer in front of res-8 layer k-1 (out 0 = flush boxes: just proud)
  const yb = 2 * y0 + (o.fy != null ? o.fy : 2), yt = yb + 12, ob = Math.max(1, 2 * out - 1);
  H.box(lo, yb, ob, hi, yt, ob, o.bg);                         // board face
  H.box(lo, yb, ob + 1, hi, yb, ob + 1, o.bd); H.box(lo, yt, ob + 1, hi, yt, ob + 1, o.bd);   // proud frame
  H.box(lo, yb, ob + 1, lo, yt, ob + 1, o.bd); H.box(hi, yb, ob + 1, hi, yt, ob + 1, o.bd);
  const fg = signLit(o.fg);
  let u = f.rd > 0 ? lo + 4 : hi - 4;
  for (const ch of s) {
    const rows = glyph(ch, true), gw = rows[0].length;
    for (let r = 0; r < 7; r++) for (let i = 0; i < gw; i++) if (rows[r][i] === '#') H.set(u + f.rd * i, yb + 9 - r, ob, fg);
    u += f.rd * (gw + 1);
  }
  if (o.lamps) for (const lu of [lo + 6, hi - 6]) { H.box(lu, yt + 1, ob + 1, lu, yt + 2, ob + 3, C.comFrame); H.set(lu, yt, ob + 3, C.lamp); }
  return panelW(s);
}

// 11-row board (y0..y0+10): a 1-voxel frame, 1 row / 3 columns of margin,
// the bold letters flush in the face; 2 voxels thick so it stands proud of the
// fascia and throws a crisp shadow line.
function boldBoard(f, cu, y0, s, o) {
  s = String(s).toUpperCase();
  const w = boldW(s), out = o.out != null ? o.out : 2;
  const ua = cu - f.rd * (Math.floor((w - 1) / 2) + 4), ub = ua + f.rd * (w + 7);
  f.box(ua, y0, out - 1, ub, y0 + 10, out, o.bd);
  f.box(ua + f.rd, y0 + 1, out, ub - f.rd, y0 + 9, out, o.bg);
  boldText(f, cu, y0 + 2, s, o.fg, out);
  if (o.lamps) for (const u of [ua + f.rd * 3, ub - f.rd * 3]) { f.set(u, y0 + 11, out, C.comFrame); f.set(u, y0 + 11, out + 1, C.lamp); }
  return w + 8;
}

// ---------------------------------------------------------------------------
// FACADE KIT (u along the wall, y up, out = voxels away from the wall)
// ---------------------------------------------------------------------------
// Framed glass bay: glass a..b × y0..y1 recessed 1; a frame ring flush with the
// wall; mullions so no pane is wider than ~5; a transom 4 below the head; a
// 2-row kick plate; a white glint in every other pane.
function bay(f, a, b, y0, y1, o) {
  if (b < a) return;
  const fr = o.frame, mu = o.mull != null ? o.mull : fr;
  f.box(a - 1, y0 - 1, 0, b + 1, y1 + 1, 0, fr);
  f.clear(a, y0, 0, b, y1, 0);
  f.box(a, y0, -1, b, y1, -1, o.glass != null ? o.glass : C.winCool);
  let g0 = y0;
  if (o.kick != null && y1 - y0 > 8) { f.box(a, y0, 0, b, y0 + 1, 0, o.kick); g0 = y0 + 2; f.box(a, g0, 0, b, g0, 0, fr); g0++; }
  const w = b - a + 1, np = Math.max(1, Math.round((w + 1) / (o.pane || 6)));
  const cuts = [];
  for (let i = 1; i < np; i++) cuts.push(a + Math.round(i * (w + 1) / np) - 1);
  for (const u of cuts) f.box(u, g0, 0, u, y1, 0, mu);
  const hasTr = o.transom !== false && y1 - g0 >= 10, tr = y1 - 4;
  if (hasTr) f.box(a, tr, 0, b, tr, 0, mu);
  // r10 DISPLAY WINDOW (critic r9: "display windows"): a shelf line across the
  // lower glass and small goods standing on it, drawn in the glass plane so
  // they read as the shop's wares behind the pane.
  if (o.goods && o.goods.length && y1 - g0 >= 8) {
    const sy = g0 + 2;
    f.box(a, sy, -1, b, sy, -1, fr);
    let i = 0;
    for (let u = a + 1; u + 1 <= b - 1; u += 3) {
      const c = o.goods[i++ % o.goods.length], h = 1 + ((u * 7 + a) % 3 === 0 ? 1 : 0);
      f.box(u, sy + 1, -1, u + 1, sy + h, -1, c);
    }
  }
  if (o.glint === false) return;
  const edges = [a - 1, ...cuts, b + 1], yt = (hasTr ? tr : y1 + 1) - 2;
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const pa = edges[i] + 1, pb = edges[i + 1] - 1;
    for (let k = 0; k < 3; k++) if (pa + k <= pb && yt - k > g0 + 1) f.set(pa + k, yt - k, -1, C.dtGlassHi);
  }
}
// Split [a0, a1] into framed bays (frames included) with `pier` of wall between.
function splitBays(a0, a1, target = 10, pier = 3) {
  const L = a1 - a0 + 1;
  if (L < 5) return [];
  let n = Math.max(1, Math.round((L + pier) / (target + 2 + pier)));
  let w = Math.floor((L - (n - 1) * pier) / n) - 2;
  while (n > 1 && w < 4) { n--; w = Math.floor((L - (n - 1) * pier) / n) - 2; }
  if (w < 2) return [];
  const used = n * (w + 2) + (n - 1) * pier, off = Math.floor((L - used) / 2);
  const out = [];
  for (let i = 0; i < n; i++) { const fa = a0 + off + i * (w + 2 + pier); out.push([fa + 1, fa + w]); }
  return out;
}
// Sloped striped awning over u a..b: root at ytop (out 1), falls 1 per row for
// d rows (2 thick, no see-through stair), a valance row with scallops.
// r8: the r7 critic read our 2-voxel brown/cream stripes as "slats that blur
// into the facade". Now SOLID (cols[0]) by default, or WIDE stripes when
// o.stripe is given; closed triangular end cheeks and a straight valance so
// each awning reads as one chunky shape with a clean top and a shaded
// underside (ref02).
function awning(f, a, b, ytop, d, cols, o = {}) {
  const st = o.stripe || 0;
  const cOf = (u) => (st ? cols[Math.floor((u - a) / st) % cols.length] : cols[0]);
  for (let k = 0; k < d; k++) for (let u = a; u <= b; u++) {
    const c = cOf(u);
    f.set(u, ytop - k, k + 1, c); f.set(u, ytop - k - 1, k + 1, c);
  }
  const lip = o.lip != null ? o.lip : null;
  for (let u = a; u <= b; u++) f.set(u, ytop - d - 1, d, lip != null ? lip : cOf(u));
  // end cheeks: fill the triangle under the slope at both ends
  for (const u of [a, b]) for (let k = 0; k < d; k++) for (let y = ytop - d - 1; y < ytop - k - 1; y++) f.set(u, y, k + 1, cOf(u));
}
// Flat canopy (door hood): slab at y, out 1..d, with a lip row.
function canopy(f, a, b, y, d, c, lip) {
  f.box(a, y, 1, b, y, d, c);
  f.box(a, y - 1, d, b, y - 1, d, lip != null ? lip : c);
}
// Glass double door, opening du..du+7, y G..y1: frame ring, leaves with
// stiles and rails, push bars, a threshold and a mat on the lot.
function glassDoor(f, du, y1, o) {
  const fr = o.frame, dc = o.doorC != null ? o.doorC : fr;
  f.box(du - 1, G, 0, du + 8, y1 + 1, 0, fr);
  f.clear(du, G, 0, du + 7, y1, 0);
  f.box(du, G, -1, du + 7, y1, -1, C.winCool);
  for (const k of [0, 3, 4, 7]) f.box(du + k, G, -1, du + k, y1 - 5, -1, dc);
  f.box(du, G, -1, du + 7, G + 1, -1, dc);
  f.box(du, y1 - 4, -1, du + 7, y1 - 4, -1, dc);
  f.box(du + 2, G + 8, 0, du + 2, G + 10, 0, C.gold); f.box(du + 5, G + 8, 0, du + 5, G + 10, 0, C.gold);
  f.set(du + 1, y1 - 2, -1, C.dtGlassHi); f.set(du + 2, y1 - 3, -1, C.dtGlassHi); f.set(du + 5, y1 - 2, -1, C.dtGlassHi);
  f.box(du - 1, LT, 1, du + 8, LT, 2, C.lotRim);
  if (o.mat != null) f.box(du, LT, 1, du + 7, LT, 3, o.mat);
}
// Solid service door (u..u+5, y G..G+15) with a small hood and a lamp.
function serviceDoor(f, u, o = {}) {
  const fr = o.frame != null ? o.frame : C.comFrame;
  f.box(u - 1, G, 0, u + 6, G + 16, 0, fr);
  f.clear(u, G, 0, u + 5, G + 15, 0);
  f.box(u, G, -1, u + 5, G + 15, -1, o.color != null ? o.color : C.stoneDark);
  f.box(u + 1, G + 9, -1, u + 4, G + 13, -1, C.winCool);
  f.set(u + 4, G + 7, 0, C.gold);
  f.box(u - 2, G + 18, 1, u + 7, G + 18, 3, o.hood != null ? o.hood : C.comFrame);
  f.set(u + 2, G + 17, 1, C.lamp); f.set(u + 3, G + 17, 1, C.lamp);
  f.box(u - 1, LT, 1, u + 6, LT, 2, C.lotRim);
}
// ref02 wall AC: 7 × 5, 3 deep, a dark fan ring on the front, feet on a bracket.
function wallAC(f, u, y) {
  f.box(u, y, 1, u + 6, y + 4, 3, C.offwhite);
  f.box(u + 1, y + 1, 4, u + 3, y + 3, 4, C.darkGray);
  f.set(u + 2, y + 2, 4, C.stone);
  for (let yy = y + 1; yy <= y + 3; yy += 2) f.box(u + 5, yy, 4, u + 5, yy, 4, C.stone);
  f.box(u, y - 1, 1, u, y - 1, 3, C.comFrame); f.box(u + 6, y - 1, 1, u + 6, y - 1, 3, C.comFrame);
}
function drainPipe(f, u, y0, y1) { f.box(u, y0, 1, u, y1, 1, C.comFrame); }
function wallLamp(f, u, y) { f.box(u, y, 1, u, y, 2, C.comFrame); f.set(u, y - 1, 2, C.lamp); }

// Upper-storey window (r7: the ref05 row look is MANY SMALL framed windows):
// glass u..u+w-1 × y..y+h-1 recessed 1, a flush frame ring, a transom 3 below
// the head, a centre bar on pairs (w >= 6), a proud sill one wider each side;
// optional lintel, 1-wide shutters, a flower box, a balcony.
function upWin(f, u, y, w, h, o) {
  const fr = o.frame;
  // r11 INSET GLAZING (critic r10: "the window reveals and sills are
  // shallower than the reference's inset glazing"): the glass sits 2 deep
  // behind a 1-voxel reveal ring in the frame colour, the bars 1 deep, so
  // every window shows a lit head/jamb reveal and a shadowed pane.
  f.box(u - 1, y - 1, 0, u + w, y + h, 0, fr);
  f.clear(u, y, 0, u + w - 1, y + h - 1, 0);
  f.box(u - 1, y - 1, -1, u + w, y + h, -1, o.reveal != null ? o.reveal : fr);
  f.clear(u, y, -1, u + w - 1, y + h - 1, -1);
  f.box(u, y, -2, u + w - 1, y + h - 1, -2, o.glass != null ? o.glass : C.winCool);
  if (o.arch && w >= 6) {                        // w4r1: round-headed window (ref05 brick café)
    const hc = [[0, 1], [0, 2], [1, 1]];
    for (const [du, dy] of hc) for (const uu of [u + du, u + w - 1 - du]) { f.set(uu, y + h - dy, 0, fr); f.set(uu, y + h - dy, -1, fr); }
  }
  const bar = o.bar != null ? o.bar : fr;
  if (w >= 6) f.box(u + (w >> 1), y, -1, u + (w >> 1), y + h - 1, -1, bar);
  if (h >= 8) f.box(u, y + h - 3, -1, u + w - 1, y + h - 3, -1, bar);
  // w4r2 GLINT (critic w4r1: "reflective blue glass with highlights"): a
  // diagonal sky streak across the lower sash of every pane (1 wide, down
  // to the right) plus a short parallel one, instead of two stray dots
  const gTop = h >= 8 ? y + h - 4 : y + h - 1, sw = w >= 6 ? (w >> 1) : w;
  for (const p0 of w >= 6 ? [u, u + (w >> 1) + 1] : [u]) {
    const pw = w >= 6 ? sw - (p0 === u ? 0 : 1) : sw;
    for (let i = 0; i < Math.min(pw, gTop - y + 1, 4); i++) f.set(p0 + i, gTop - i, -2, C.dtGlassHi);
    for (let i = 0; i < 2 && i + 3 < pw; i++) f.set(p0 + 3 + i, gTop - i, -2, C.dtGlassHi);
  }
  if (h >= 8) f.set(u, y + h - 2, -2, C.dtGlassHi);
  if (o.balc) {                                   // slab + glass balustrade + rails
    const a = u - 2, b = u + w + 1, rc = o.rail != null ? o.rail : C.signWhite;
    f.box(a, y - 1, 1, b, y - 1, 3, o.sill != null ? o.sill : fr);
    f.box(a, y, 3, b, y + 2, 3, C.dtGlassHi);
    f.box(a, y + 3, 3, b, y + 3, 3, rc);
    f.box(a, y, 1, a, y + 3, 2, rc); f.box(b, y, 1, b, y + 3, 2, rc);
    if (o.box) { const fl = o.flowers || [C.pink, C.red]; f.box(a + 1, y, 2, a + 2, y, 2, C.vegBush); f.set(a + 1, y + 1, 2, fl[0]); f.set(b - 1, y, 2, C.vegBush); }
    return;
  }
  f.box(u - 2, y - 1, 1, u + w + 1, y - 1, 2, o.sill != null ? o.sill : fr);     // r11: sill 2 proud
  if (o.lintel != null) f.box(u - 1, y + h, 1, u + w, y + h, 1, o.lintel);
  if (o.shutter != null) { f.box(u - 2, y, 0, u - 2, y + h - 1, 0, o.shutter); f.box(u + w + 1, y, 0, u + w + 1, y + h - 1, 0, o.shutter); }
  if (o.box) {
    f.box(u - 1, y - 3, 1, u + w, y - 2, 2, C.woodDark);
    const fl = o.flowers || [C.pink, C.red];
    // w4r2: deep-green foliage with blooms every 2 (the lime vegBush row read
    // as a neon bar under the window in-game)
    f.box(u - 1, y - 1, 2, u + w, y - 1, 2, C.leafDark);
    for (let uu = u, i = 0; uu <= u + w - 1; uu += 2, i++) f.set(uu, y - 1, 2, fl[i % fl.length]);
  }
  if (o.awn) awning(f, u - 1, u + w, y + h + 1, 2, o.awn);
}
// window sizes per style: [w, h, pitch]
// w4r1 'big': wide picture windows (centre bar + transom) for the first floor
// over the shop, so floors differ in window size (critic w3: "uniform grids
// of identical small windows; vary window sizes between floors")
// w4r1 'arch': tall round-headed windows (ref05's brick café); 'mix' is a
// deliberate rhythm of narrow / wide / narrow windows (see upRow)
const WSTYLE = { arch: [8, 11, 12], big: [9, 11, 13], grid: [4, 8, 7], tall: [4, 10, 7], pair: [7, 8, 10], shutter: [4, 8, 9], balc: [5, 10, 9], sash: [5, 9, 8] };
// Row of upper windows along [u0, u1] (style: WSTYLE key | 'ribbon'); returns
// the window starts.
function upRow(f, u0, u1, y, st, o) {
  if (st === 'ribbon') {
    const bays = splitBays(u0 + 1, u1 - 1, 5, 1);
    if (!bays.length) return [];
    f.box(bays[0][0] - 1, y - 1, 0, bays[bays.length - 1][1] + 1, y + 9, 0, o.frame);
    for (const [a, b] of bays) { f.clear(a, y, 0, b, y + 8, 0); f.box(a, y, -1, b, y + 8, -1, C.winCool); f.set(a, y + 7, -1, C.dtGlassHi); f.set(a + 1, y + 6, -1, C.dtGlassHi); }
    f.box(bays[0][0] - 2, y - 1, 1, bays[bays.length - 1][1] + 2, y - 1, 1, o.sill != null ? o.sill : o.frame);
    if (o.planters) for (let u = bays[0][0]; u <= bays[bays.length - 1][1]; u++) f.set(u, y, 1, (u % 6) ? C.vegBush : (o.flowers || [C.pink])[0]);
    return bays.map((b) => b[0]);
  }
  if (st === 'mix') {
    // w4r1 (critic w3: "facades are uniform grids of identical small
    // windows"): narrow 4-wide and wide 10-wide windows alternate, narrow at
    // both ends, 4 apart, centred — one composed front instead of a grid
    const WN = 4, WW = 10, GAP = 4, H = 10, Lm = u1 - u0 + 1;
    let m = 1;
    const spanM = (k) => { let t = 0; for (let i = 0; i < k; i++) t += i % 2 ? WW : WN; return t + (k - 1) * GAP; };
    while (spanM(m + 2) <= Lm - 2) m += 2;
    if (spanM(m) > Lm - 2) return [];
    let u = u0 + ((Lm - spanM(m)) >> 1);
    const out = []; out.pils = [];
    for (let i = 0; i < m; i++) {
      const w = i % 2 ? WW : WN;
      upWin(f, u, y, w, H, { frame: o.frame, reveal: o.reveal, sill: o.sill, lintel: o.lintel, box: o.boxes && i % 2 === 1, flowers: o.flowers, awn: i % 2 ? o.winAwn : null });
      out.push(u); u += w + GAP;
    }
    return out;
  }
  const [w, h, pitch] = WSTYLE[st] || WSTYLE.grid;
  // r9: windows come in GROUPS of o.group with a wider wall between groups,
  // where the caller stands a pilaster (returned in out.pils) — the r8 critic:
  // "repeated grids of identical windows; the reference has pilasters".
  const L = u1 - u0 + 1, k = o.group || 0, GP = 5;
  const span = (m) => (m - 1) * pitch + w + (k ? (Math.ceil(m / k) - 1) * GP : 0);
  let n = Math.max(0, Math.floor((L - w - 2) / pitch) + 1);
  while (n > 0 && span(n) > L - 2) n--;
  if (!n) return [];
  const s = u0 + Math.floor((L - span(n)) / 2);
  const out = [];
  out.pils = [];
  for (let i = 0; i < n; i++) {
    const u = s + i * pitch + (k ? Math.floor(i / k) * GP : 0);
    if (k && i > 0 && i % k === 0) out.pils.push(Math.floor((out[i - 1] + w + u - 1) / 2));
    const balc = st === 'balc' && (o.balcAll || (i % 2 === (n % 2 ? 0 : 1)) || n <= 2);
    upWin(f, u, y, w, h, { frame: o.frame, reveal: o.reveal, sill: o.sill, lintel: o.lintel, rail: o.rail, shutter: st === 'shutter' ? o.shutter : null, arch: st === 'arch',
      box: o.boxes && (balc || i % 2 === 0), flowers: o.flowers, awn: o.winAwn, balc });
    out.push(u);
  }
  return out;
}
// Projecting blade sign: a 2-thick board sticking OUT of the wall at u..u+1
// (out 2..12, bottom row y) on a bracket, the logo on both of its faces.
function bladeSign(g, side, plane, u, y, logo, bg, bd) {
  const f = facade(g, side, plane);
  f.box(u, y + 11, 1, u + 1, y + 11, 10, C.comFrame);
  f.box(u, y, 2, u + 1, y + 10, 10, bd);
  if (!logo) return;
  const n = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] }[side];
  if (n[0] === 0) { const zc = plane + n[1] * 6; logoTile(facade(g, 'left', u), zc, y + 1, logo, bg, bd, 0); logoTile(facade(g, 'right', u + 1), zc, y + 1, logo, bg, bd, 0); }
  else { const xc = plane + n[0] * 6; logoTile(facade(g, 'front', u), xc, y + 1, logo, bg, bd, 0); logoTile(facade(g, 'back', u + 1), xc, y + 1, logo, bg, bd, 0); }
}

// ---------------------------------------------------------------------------
// ROOF KIT
// ---------------------------------------------------------------------------
// ref02 AC unit 7 × 5 × 6: base, louvres, a dark fan ring on top.
function acUnit(g, x, y, z) {
  g.box(x, y, z, x + 6, y + 4, z + 5, C.offwhite);
  g.box(x, y, z, x + 6, y, z + 5, C.concrete);
  g.box(x + 1, y + 4, z + 1, x + 4, y + 4, z + 4, C.darkGray);
  g.box(x + 2, y + 4, z + 2, x + 3, y + 4, z + 3, C.stone);
  for (const yy of [y + 1, y + 3]) { g.box(x + 1, yy, z, x + 5, yy, z, C.stone); g.box(x + 6, yy, z + 1, x + 6, yy, z + 4, C.stone); }
}
// Big two-fan condenser 13 × 5 × 7.
function acBig(g, x, y, z) {
  g.box(x, y, z, x + 12, y + 4, z + 6, C.offwhite);
  g.box(x, y, z, x + 12, y, z + 6, C.concrete);
  for (const fx of [x + 1, x + 7]) { g.box(fx, y + 4, z + 1, fx + 4, y + 4, z + 5, C.darkGray); g.box(fx + 2, y + 4, z + 3, fx + 2, y + 4, z + 3, C.stone); }
  for (const yy of [y + 1, y + 3]) { g.box(x + 1, yy, z, x + 11, yy, z, C.stone); g.box(x + 12, yy, z + 1, x + 12, yy, z + 5, C.stone); }
}
function vent(g, x, y, z, h = 4) {
  g.box(x, y, z, x + 1, y + h - 1, z + 1, C.offwhite);
  g.box(x - 1, y + h, z - 1, x + 2, y + h, z + 2, C.concrete);
}
function hatch(g, x, y, z) {
  g.box(x, y, z, x + 6, y, z + 6, C.concrete);
  g.box(x + 1, y + 1, z + 1, x + 5, y + 1, z + 5, C.offwhite);
  g.box(x + 3, y + 2, z + 2, x + 3, y + 2, z + 4, C.stone);
}
function skylight(g, x, y, z, w = 12, d = 9) {
  g.box(x, y, z, x + w - 1, y + 1, z + d - 1, C.offwhite);
  g.box(x + 1, y + 1, z + 1, x + w - 2, y + 1, z + d - 2, C.winCool);
  for (let xx = x + 4; xx < x + w - 2; xx += 4) g.box(xx, y + 1, z + 1, xx, y + 1, z + d - 2, C.offwhite);
}
// r8: ref02 solar = SEPARATE framed panels with gaps (one 26×16 slab read as a
// flat blue blob): 2 × 2 panels, white frames, dark cells + lighter grid, and
// a tilt (the back half one row higher).
function solar(g, x, y, z, w = 14, d = 10, nx0, nz0) {
  const nx = nx0 || (w >= 20 ? 2 : 1), nz = nz0 || (d >= 14 ? 2 : 1);
  const pw = Math.floor((w - (nx - 1) * 2) / nx), pd = Math.floor((d - (nz - 1) * 2) / nz);
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const px = x + i * (pw + 2), pz = z + k * (pd + 2), h = (pd >> 1);
    g.box(px + 1, y, pz + 1, px + pw - 2, y, pz + pd - 2, C.concrete);
    solarPanel(g, px, pz, px + pw - 1, pz + h - 1, y + 1, { cell: 4, colors: [C.navy, C.roofBlue], frame: C.stone });
    solarPanel(g, px, pz + h, px + pw - 1, pz + pd - 1, y + 2, { cell: 4, colors: [C.navy, C.roofBlue], frame: C.stone });
    g.box(px, y + 1, pz + h, px + pw - 1, y + 1, pz + pd - 1, C.stone);
  }
}
function tank(g, x, y, z) {                         // 9 × 9 water tank on legs
  for (const [lx, lz] of [[x + 1, z + 1], [x + 7, z + 1], [x + 1, z + 7], [x + 7, z + 7]]) g.box(lx, y, lz, lx, y + 3, lz, C.stoneDark);
  const cx = x + 4, cz = z + 4;
  for (let yy = y + 4; yy <= y + 12; yy++) for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++)
    if (dx * dx + dz * dz <= 18) g.set(cx + dx, yy, cz + dz, yy === y + 8 ? C.stone : C.offwhite);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx * dx + dz * dz <= 9) g.set(cx + dx, y + 13, cz + dz, C.concrete);
  g.box(cx, y + 14, cz, cx, y + 14, cz, C.stone);
}
function duct(g, x, y, z, len) {
  g.box(x, y + 2, z, x + len - 1, y + 4, z + 2, C.offwhite);
  g.box(x, y, z, x + 2, y + 1, z + 2, C.offwhite);
  for (let xx = x + 5; xx < x + len - 1; xx += 6) g.box(xx, y + 2, z, xx, y + 4, z + 2, C.concrete);
  for (let xx = x + 6; xx < x + len - 1; xx += 12) g.box(xx, y, z + 1, xx, y + 1, z + 1, C.stoneDark);
}
function potPlant(g, x, y, z, fl) {                 // 3×3 pot + bush (+ flower)
  g.box(x, y, z, x + 2, y + 2, z + 2, C.comTerra);
  g.box(x, y + 3, z, x + 2, y + 5, z + 2, C.vegBush);
  g.box(x, y + 3, z, x + 2, y + 3, z + 2, C.vegBushDark);
  if (fl != null) { g.set(x + 1, y + 6, z + 1, fl); g.set(x, y + 5, z, fl); }
}
// Roof stair bulkhead 10 × 12 × 9: a box with a door, a vent and a cap.
function stairHouse(g, x, y, z) {
  g.box(x, y, z, x + 9, y + 11, z + 8, C.offwhite);
  g.box(x - 1, y + 12, z - 1, x + 10, y + 12, z + 9, C.concrete);
  g.box(x + 3, y, z - 1, x + 6, y + 8, z - 1, C.comFrame);
  g.box(x + 4, y + 5, z - 1, x + 5, y + 7, z - 1, C.winCool);
  g.box(x + 10, y + 6, z + 3, x + 10, y + 8, z + 5, C.stone);
  g.box(x + 7, y + 13, z + 5, x + 8, y + 15, z + 6, C.offwhite);
}
// Roof planter 12 × 5: a white box, shrubs, flowers.
function roofPlanter(g, x, y, z) {
  g.box(x, y, z, x + 11, y + 2, z + 4, C.offwhite);
  g.box(x + 1, y + 3, z + 1, x + 10, y + 4, z + 3, C.vegBush);
  g.box(x + 1, y + 3, z + 1, x + 10, y + 3, z + 3, C.vegBushDark);
  for (let i = 1; i <= 10; i += 3) g.set(x + i, y + 5, z + 2, [C.pink, C.yellow, C.vegPetalR, C.signWhite][(i / 3) | 0]);
}
const GEAR = {
  stair: [11, 10, stairHouse], garden: [12, 5, roofPlanter],
  ac: [7, 6, acUnit], acBig: [13, 7, acBig], vent: [2, 2, (g, x, y, z) => vent(g, x, y, z, 4)],
  vent2: [2, 2, (g, x, y, z) => vent(g, x, y, z, 7)], hatch: [7, 7, hatch], sky: [12, 9, skylight],
  solar: [14, 10, solar], solarBig: [26, 16, (g, x, y, z) => solar(g, x, y, z, 26, 16)], tank: [9, 9, tank], duct: [18, 3, (g, x, y, z) => duct(g, x, y, z, 18)],
  pot: [3, 3, (g, x, y, z) => potPlant(g, x, y, z, C.pink)],
};
// Pack gear onto a deck (x0..x1, z0..z1 inside the parapet), props on y.
// list: kind names (or [kind, pref]); pref 'back' (default) | 'front'.
function roofGear(g, x0, z0, x1, z1, y, list, seed = 0) {
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  if (W < 4 || D < 4) return;
  const occ = new Uint8Array(W * D);
  const ok = (x, z, w, d) => {
    if (x < x0 || z < z0 || x + w - 1 > x1 || z + d - 1 > z1) return false;
    for (let i = Math.max(x0, x - 2); i <= Math.min(x1, x + w + 1); i++) for (let k = Math.max(z0, z - 2); k <= Math.min(z1, z + d + 1); k++)
      if (occ[(k - z0) * W + (i - x0)]) return false;
    return true;
  };
  const mark = (x, z, w, d) => { for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) occ[(k - z0) * W + (i - x0)] = 1; };
  if (Array.isArray(list.block)) for (const [bx0, bz0, bx1, bz1] of list.block) mark(Math.max(x0, bx0), Math.max(z0, bz0), Math.min(x1, bx1) - Math.max(x0, bx0) + 1, Math.min(z1, bz1) - Math.max(z0, bz0) + 1);
  let n = seed;
  for (const it of list) {
    const [kind, pref] = Array.isArray(it) ? it : [it, 'back'];
    const spec = GEAR[kind]; if (!spec) continue;
    const [w, d, draw] = spec;
    let done = false;
    const zs = [];
    for (let z = z0 + 1; z + d - 1 <= z1 - 1; z++) zs.push(z);
    if (pref !== 'front') zs.reverse();
    const xs = [];
    for (let x = x0 + 1; x + w - 1 <= x1 - 1; x++) xs.push(x);
    if ((n++ & 1) === 1) xs.reverse();
    for (const z of zs) { for (const x of xs) if (ok(x, z, w, d)) { draw(g, x, y, z); mark(x, z, w, d); done = true; break; } if (done) break; }
  }
}
// Roof terrace: a tiled or boarded deck, table sets (optional parasols),
// planters in the corners, a glass rail on top of the parapet on `rail` sides.
function roofTerrace(g, rng, x0, z0, x1, z1, y, o = {}) {
  const deck = o.deck != null ? o.deck : C.sand, line = o.line != null ? o.line : C.sandDark;
  g.box(x0, y - 1, z0, x1, y - 1, z1, deck);
  if (o.boards) for (let x = x0 + 3; x < x1; x += 4) g.box(x, y - 1, z0, x, y - 1, z1, line);
  else { for (let x = x0 + 5; x < x1; x += 6) g.box(x, y - 1, z0, x, y - 1, z1, line); for (let z = z0 + 5; z < z1; z += 6) g.box(x0, y - 1, z, x1, y - 1, z, line); }
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const px = 14, pz = o.parasol === false ? 10 : 14;
  const nx = Math.max(1, Math.floor((W - 6) / px)), nz = Math.max(1, Math.floor((D - 4) / pz));
  const sx = x0 + Math.floor((W - (nx - 1) * px) / 2), sz = z0 + Math.floor((D - (nz - 1) * pz) / 2);
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const par = o.parasol === false ? false : o.parasol === 'alt' ? ((i + k) & 1) === 0 : true;
    tableSet(g, sx + i * px, sz + k * pz, y, { top: o.top, chair: o.chair, par, cols: o.cols, r: 4 });
    if (rng() < (o.guests != null ? o.guests : 0.5)) person(g, rng, sx + i * px + 3, sz + k * pz + 2, y);
  }
  if (o.pots === true) for (const [x, z] of [[x0, z0], [x1 - 2, z1 - 2]]) potPlant(g, x, y, z, pk(rng, [C.pink, C.vegPetalR, C.yellow, C.signWhite]));
}

// ---------------------------------------------------------------------------
// r9 ROOFSCAPE. The r8 critic: "the shop rooftops are large, flat, empty grey
// slabs with one or two props; in the reference every roof has rooftop
// gardens, terrace seating, parapet trim and HVAC clusters". (r7's critic
// had the opposite complaint — many small planter boxes read as noise.) The
// midpoint: the deck is divided into a few CELLS (~18 × 15) with 2-voxel
// walkways between them, and each cell holds ONE coherent module that fills
// it — a raised garden bed of chunky ref06 bushes, a tiled patio with parasol
// tables, an HVAC cluster on a concrete pad, a 2 × 2 solar array, a stair
// house, a pergola, a water tank, skylights, a mini court. Big, legible,
// organised blocks instead of scattered small boxes.
// ---------------------------------------------------------------------------
function tiles(g, a0, b0, a1, b1, y, deck, line, step = 6) {
  g.box(a0, y, b0, a1, y, b1, deck);
  for (let x = a0 + step - 1; x < a1; x += step) g.box(x, y, b0, x, y, b1, line);
  for (let z = b0 + step - 1; z < b1; z += step) g.box(a0, y, z, a1, y, z, line);
}
const BUSHC = [[C.vegBush, C.vegBushDark], [C.leafMid, C.leafDark], [C.lime, C.bush]];
const ROOFMOD = {
  // raised bed (white rim, 2 high) of lawn with chunky bushes and flowers
  garden(g, r, a0, b0, a1, b1, y, o) {
    const bed = o.bed != null ? o.bed : C.offwhite;
    g.walls(a0 + 1, y, b0 + 1, a1 - 1, y + 1, b1 - 1, bed);
    g.box(a0 + 2, y, b0 + 2, a1 - 2, y, b1 - 2, C.woodDark);
    g.box(a0 + 2, y + 1, b0 + 2, a1 - 2, y + 1, b1 - 2, C.lotGrass);
    // a lumpy mass of 4×4 cube bushes (ref05 roof gardens / ref06 bushes):
    // one green per bed, lighter tops over a darker lower band, heights 2-6,
    // a few gaps of lawn with flowers
    const ia = a0 + 2, ib = b0 + 2, ja = a1 - 2, jb = b1 - 2, sd = (r() * 97) | 0, pal = sd % 3;
    for (let x = ia; x <= ja; x += 4) for (let z = ib; z <= jb; z += 4) {
      const hsh = (x * 7 + z * 13 + sd) % 11;
      const sx = Math.min(4, ja - x + 1), sz = Math.min(4, jb - z + 1);
      if (hsh === 0 || hsh === 5) { g.set(x + 1, y + 2, z + 1, [C.pink, C.yellow, C.signWhite][hsh % 3]); if (sx > 2 && sz > 2) g.set(x + 2, y + 2, z + 2, C.vegPetalR); continue; }
      const h = 2 + (hsh % 5);
      const [lt, dk] = BUSHC[pal];
      g.box(x, y + 2, z, x + sx - 1, y + 1 + h, z + sz - 1, lt);
      g.box(x, y + 2, z, x + sx - 1, y + 1 + Math.max(1, h >> 1), z + sz - 1, dk);
      if (hsh === 3 && sx >= 3) g.set(x + 1, y + 2 + h, z + 1, C.pink);
    }
  },
  // tiled patio with parasol tables and pots in two corners
  patio(g, r, a0, b0, a1, b1, y, o) {
    const t = o.terrace || {};
    tiles(g, a0, b0, a1, b1, y - 1, t.deck != null ? t.deck : C.sand, t.line != null ? t.line : C.sandDark);
    const W = a1 - a0 + 1, D = b1 - b0 + 1;
    const nx = Math.max(1, Math.floor((W - 3) / 12)), nz = Math.max(1, Math.floor((D - 3) / 12));
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const x = a0 + Math.round((i + 0.5) * W / nx), z = b0 + Math.round((k + 0.5) * D / nz);
      tableSet(g, x, z, y, { top: t.top, chair: t.chair, par: t.parasol !== false, cols: t.cols, r: 4 });
      if (r() < 0.6) person(g, r, x - 1, z + 2, y);
    }
    const fl = pk(r, [C.pink, C.vegPetalR, C.yellow, C.signWhite]);
    potPlant(g, a0 + 1, y, b0 + 1, fl); potPlant(g, a1 - 3, y, b1 - 3, fl);
  },
  // HVAC cluster on a raised concrete pad: a big condenser, small units,
  // a duct, vents and a pipe run
  hvac(g, r, a0, b0, a1, b1, y) {
    g.box(a0 + 1, y, b0 + 1, a1 - 1, y, b1 - 1, C.concrete);
    const yy = y + 1, W = a1 - a0 + 1, D = b1 - b0 + 1;
    if (W >= 17 && D >= 14) {
      acBig(g, a0 + 2, yy, b0 + 1);
      acUnit(g, a0 + 2, yy, b0 + 8); if (W >= 19) acUnit(g, a0 + 10, yy, b0 + 8);
      vent(g, a1 - 3, yy, b0 + 3, 6); vent(g, a1 - 3, yy, b1 - 4, 3);
      g.box(a0 + 15, yy, b0 + 6, a1 - 4, yy + 1, b0 + 6, C.stone);
    } else if (W >= 15 && D >= 8) {
      acBig(g, a0 + 1, yy, b0 + 1);
      vent(g, a1 - 2, yy, b0 + 2, 5);
    } else { acUnit(g, a0 + 2, yy, b0 + 1); vent(g, a1 - 3, yy, b0 + 2, 4); }
  },
  // 2 × 2 tilted solar panels (ref02)
  solar(g, r, a0, b0, a1, b1, y) {
    const W = a1 - a0 - 1, D = b1 - b0 - 1;
    solar(g, a0 + 1, y, b0 + 1, W, D, Math.max(1, Math.floor((W + 2) / 9)), Math.max(1, Math.floor((D + 2) / 8)));
  },
  // stair bulkhead with vents
  stair(g, r, a0, b0, a1, b1, y) {
    stairHouse(g, a0 + 2, y, b0 + 3);
    if (a1 - a0 >= 16) { vent(g, a1 - 3, y, b0 + 3, 7); vent(g, a1 - 3, y, b1 - 4, 4); }
    if (b1 - b0 >= 16) acUnit(g, a0 + 2, y, b1 - 6);
  },
  // water tank on legs, a hatch or a vent
  tank(g, r, a0, b0, a1, b1, y) {
    tank(g, a0 + 2, y, b0 + 2);
    vent(g, a1 - 3, y, b0 + 3, 5);
    if (b1 - b0 >= 14) hatch(g, a1 - 8, y, b1 - 8); else vent(g, a1 - 3, y, b1 - 3, 3);
  },
  sky(g, r, a0, b0, a1, b1, y) {
    const D = b1 - b0 - 2, d = Math.max(5, (D - 2) >> 1);
    skylight(g, a0 + 2, y, b0 + 2, a1 - a0 - 3, d);
    if (D >= 2 * d + 2) skylight(g, a0 + 2, y, b0 + 4 + d, a1 - a0 - 3, d);
  },
  // wooden pergola over a boarded deck: posts, beams, slats with vines, a bench
  pergola(g, r, a0, b0, a1, b1, y, o) {
    tiles(g, a0, b0, a1, b1, y - 1, C.plank, C.wood, 4);
    const x0 = a0 + 1, x1 = a1 - 1, z0 = b0 + 1, z1 = b1 - 1, h = 11;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.box(x, y, z, x, y + h - 1, z, C.woodDark);
    for (const z of [z0, z1]) g.box(x0, y + h, z, x1, y + h, z, C.woodDark);
    for (let x = x0; x <= x1; x += 3) g.box(x, y + h + 1, z0 - 1, x, y + h + 1, z1 + 1, C.wood);
    for (let x = x0; x <= x1; x += 3) for (let z = z0; z <= z1; z += 2) if (((x * 7 + z * 3) % 5) < 2) g.set(x, y + h + 2, z, (x + z) % 3 ? C.leafMid : C.pink);
    for (const x of [x0, x1]) g.box(x, y + 4, z0, x, y + h - 1, z0, C.leafMid);
    const bl = Math.min(9, x1 - x0 - 5), bz = z1 - 4;       // bench (seat + back) at deck level
    g.box(x0 + 3, y, bz, x0 + 3, y + 1, bz + 2, C.comFrame); g.box(x0 + 2 + bl, y, bz, x0 + 2 + bl, y + 1, bz + 2, C.comFrame);
    g.box(x0 + 3, y + 2, bz, x0 + 2 + bl, y + 2, bz + 2, C.wood); g.box(x0 + 3, y + 3, bz + 2, x0 + 2 + bl, y + 4, bz + 2, C.wood);
    g.box(x0 + 3, y, z0 + 3, x0 + 3 + Math.min(8, x1 - x0 - 6), y + 1, z0 + 5, C.offwhite);
    g.box(x0 + 4, y + 2, z0 + 4, x0 + 2 + Math.min(8, x1 - x0 - 6), y + 3, z0 + 4, C.vegBush);
    if (r() < 0.7) person(g, r, x1 - 5, z0 + 5, y);
  },
  // decorative tiled pad (under a roof sculpture): tiles + corner pots; never
  // skipped by blocks, the sculpture is drawn over it afterwards
  pad(g, r, a0, b0, a1, b1, y, o) {
    const t = o.terrace || {};
    tiles(g, a0 + 1, b0 + 1, a1 - 1, b1 - 1, y - 1, t.deck != null ? t.deck : C.sand, t.line != null ? t.line : C.sandDark, 4);
    const fl = pk(r, [C.pink, C.vegPetalR, C.yellow]);
    potPlant(g, a0 + 1, y, b0 + 1, fl); potPlant(g, a1 - 3, y, b1 - 3, fl);
  },
  // painted mini court with a hoop
  court(g, r, a0, b0, a1, b1, y) {
    g.box(a0 + 1, y - 1, b0 + 1, a1 - 1, y - 1, b1 - 1, C.roofBlue);
    g.walls(a0 + 2, y - 1, b0 + 2, a1 - 2, y - 1, b1 - 2, C.lotLine);
    const cx = (a0 + a1) >> 1;
    g.box(cx, y - 1, b0 + 2, cx, y - 1, b1 - 2, C.lotLine);
    const hz = (b0 + b1) >> 1;
    g.box(a1 - 1, y, hz, a1 - 1, y + 12, hz, C.darkGray);
    g.box(a1 - 2, y + 10, hz - 3, a1 - 2, y + 15, hz + 3, C.signWhite);
    g.box(a1 - 2, y + 11, hz - 1, a1 - 2, y + 13, hz + 1, C.red);
    g.walls(a1 - 5, y + 11, hz - 1, a1 - 3, y + 11, hz + 1, C.orange);
    g.box(a0 + 5, y, hz + 2, a0 + 6, y + 1, hz + 3, C.orange);
    person(g, r, cx - 3, hz - 2, y);
  },
};
// Divide the deck (x0..x1, z0..z1 inside the parapet; deck surface y - 1)
// into cells and draw one module per cell. plan: module names (row-major,
// front row first; null = leave empty). Cells overlapping a `block` rect
// (sculptures, sign legs) are skipped; the leftovers get small gear.
function roofScape(g, rng, x0, z0, x1, z1, y, plan, o = {}) {
  const cw = o.cell || 19, cd = o.cellD || 17;
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  if (W < 8 || D < 6) return;
  const nx = Math.max(1, Math.round(W / cw)), nz = Math.max(1, Math.round(D / cd));
  const blocks = (o.block || []).slice(), drawn = [];
  let n = 0;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const a0 = x0 + Math.floor(i * W / nx), a1 = x0 + Math.floor((i + 1) * W / nx) - 1;
    const b0 = z0 + Math.floor(k * D / nz), b1 = z0 + Math.floor((k + 1) * D / nz) - 1;
    const kind = plan[n++ % plan.length];
    if (!kind || !ROOFMOD[kind]) continue;
    if (kind !== 'pad' && blocks.some(([p0, q0, p1, q1]) => p0 < a1 && p1 > a0 && q0 < b1 && q1 > b0)) continue;
    ROOFMOD[kind](g, rng, a0, b0, a1, b1, y, o);
    drawn.push([a0, b0, a1, b1]);
  }
  const gear = (o.extra || ['ac', 'vent', 'hatch', 'vent2', 'vent']).slice();
  gear.block = blocks.concat(drawn);
  roofGear(g, x0, z0, x1, z1, y, gear, (rng() * 4) | 0);
}
// ---------------------------------------------------------------------------
// w2r1 CLEAN ROOF. Consensus (r7, r8, r10 critics + coordinator): ref02 has a
// smooth light deck with 3-4 DELIBERATE props (a 2×2 solar array, an AC unit,
// a vent, a hatch) and breathing room; our r9 cell grid filled every roof edge
// to edge. Now each shop lists 3-4 props with an anchor on the deck; each one
// is placed at its anchor (or the nearest free spot, 3 voxels clear of the
// others) and the rest of the deck stays clean.
// ---------------------------------------------------------------------------
// w4r1 (critic w3: "large blank pale-grey roof slabs with one or two small
// props ... ref05 crowds its roofs with AC clusters, vents, sign frames,
// patio seating and coloured clutter"). Bigger COMPOSITE props, each one a
// legible cluster, so a roof carries 5-7 of them and reads full without
// turning into r7's field of little planter boxes. `o` = the shop's colours.
// Raised plant room (a parapet step in the roofline) 16 × 12 × 10: wall with
// a brand-colour band under a light cap, a door + louvre, an AC and a vent on top.
function plantRoom(g, x, y, z, o = {}) {
  const w = o.wall != null ? o.wall : C.offwhite, acc = o.acc != null ? o.acc : C.stone;
  g.box(x, y, z, x + 15, y + 8, z + 11, w);
  g.walls(x, y + 7, z, x + 15, y + 8, z + 11, acc);
  g.box(x - 1, y + 9, z - 1, x + 16, y + 9, z + 12, C.signWhite);
  for (const zz of [z, z + 11]) {
    g.box(x + 3, y, zz, x + 6, y + 5, zz, C.comFrame); g.box(x + 4, y + 3, zz, x + 5, y + 4, zz, C.winCool);
    for (let yy = y + 1; yy <= y + 5; yy += 2) g.box(x + 9, yy, zz, x + 13, yy, zz, C.stone);
  }
  for (const xx of [x, x + 15]) for (let yy = y + 1; yy <= y + 5; yy += 2) g.box(xx, yy, z + 3, xx, yy, z + 8, C.stone);
  acUnit(g, x + 2, y + 10, z + 3);
  vent(g, x + 12, y + 10, z + 4, 3);
}
// HVAC cluster 22 × 10 on a concrete pad: a big condenser, an AC unit, a pipe run.
function hvacPad(g, x, y, z) {
  g.box(x, y, z, x + 21, y, z + 9, C.concrete);
  acBig(g, x + 1, y + 1, z + 1);
  acUnit(g, x + 15, y + 1, z + 1);
  g.box(x + 1, y + 2, z + 9, x + 20, y + 2, z + 9, C.stone);
  for (const xx of [x + 2, x + 10, x + 19]) g.box(xx, y + 1, z + 9, xx, y + 1, z + 9, C.stoneDark);
  g.box(x + 20, y + 2, z + 8, x + 20, y + 6, z + 9, C.stone);
}
// Stock on a pallet 11 × 7: cardboard boxes, a brand-colour crate, a gas bottle.
function stockPile(g, x, y, z, o = {}) {
  const a = o.acc != null ? o.acc : C.red, b = o.acc2 != null ? o.acc2 : C.yellow;
  g.box(x, y, z, x + 10, y, z + 6, C.wood);
  g.box(x + 1, y + 1, z + 1, x + 4, y + 4, z + 3, C.comDough);
  g.box(x + 1, y + 1, z + 4, x + 4, y + 3, z + 5, C.comDough);
  g.box(x + 2, y + 4, z + 4, x + 3, y + 4, z + 5, C.signWhite);
  g.box(x + 5, y + 1, z + 1, x + 8, y + 3, z + 5, a);
  g.box(x + 5, y + 4, z + 2, x + 7, y + 6, z + 4, b);
  g.box(x + 9, y + 1, z + 2, x + 10, y + 5, z + 3, C.teal);
  g.box(x + 9, y + 6, z + 2, x + 10, y + 6, z + 3, C.stone);
}
// Roof café corner 25 × 13: a tiled deck, two parasol tables in the shop's
// colours, a planter bench along the back, two pots.
function roofCafe(g, x, y, z, rng, o = {}) {
  tiles(g, x, z, x + 24, z + 12, y - 1, o.deck != null ? o.deck : C.sand, o.line != null ? o.line : C.sandDark);
  const cols = o.cols || [C.red, C.signWhite];
  // w4r3: no parasols on roofs — small striped r4 domes seen from above read
  // as FLOWERS (w4r2: "clumps of mismatched props (flowers, ...)"); ref05's
  // Mac Auto roof terrace is plain tables and chairs on a warm deck
  for (const tx of [x + 5, x + 12, x + 19]) tableSet(g, tx, z + 5, y, { top: C.signWhite, chair: o.chair != null ? o.chair : C.wood, par: false, cols, r: 4 });
  g.box(x + 2, y, z + 10, x + 22, y + 1, z + 11, C.offwhite);
  g.box(x + 3, y + 2, z + 10, x + 21, y + 3, z + 11, C.leafMid);     // w4r4: leafMid (the lime vegBush run read as a neon bar)
  g.box(x + 3, y + 2, z + 10, x + 21, y + 2, z + 11, C.leafDark);
  // w4r3: one bloom colour, no corner pots (w4r2: "noisy mismatched props")
  for (let i = 0; i < 5; i++) g.set(x + 4 + i * 4, y + 4, z + 11 - (i & 1), i & 1 ? C.signWhite : C.pink);
  if (rng && rng() < 0.7) person(g, rng, x + 10, z + 4, y);
}
// Satellite dish 6 × 6 on a stand.
function dish(g, x, y, z) {
  g.box(x + 2, y, z + 2, x + 3, y + 2, z + 3, C.stone);
  g.box(x, y + 3, z + 1, x + 5, y + 6, z + 4, C.signWhite);
  g.box(x + 1, y + 4, z, x + 4, y + 5, z, C.signWhite);
  g.box(x + 2, y + 4, z + 5, x + 3, y + 5, z + 5, C.stone);
  g.box(x + 2, y + 5, z - 1, x + 3, y + 5, z - 1, C.darkGray);
}
// Sign frame 14 × 4: a steel frame behind a lit logo board (both faces).
function signFrame(g, x, y, z, o = {}) {
  const bd = o.bd != null ? o.bd : C.comFrame, bg = o.bg != null ? o.bg : C.signWhite;
  for (const xx of [x + 2, x + 11]) {
    g.box(xx, y, z + 1, xx, y + 6, z + 2, C.stoneDark);
    g.box(xx, y, z, xx, y + 1, z, C.stoneDark); g.box(xx, y, z + 3, xx, y + 1, z + 3, C.stoneDark);
  }
  g.box(x + 2, y + 4, z + 1, x + 11, y + 4, z + 2, C.stoneDark);
  g.box(x, y + 7, z + 1, x + 13, y + 17, z + 2, bd);
  if (o.logo) { logoTile(facade(g, 'front', z + 1), x + 7, y + 8, o.logo, bg, bd, 0); logoTile(facade(g, 'back', z + 2), x + 7, y + 8, o.logo, bg, bd, 0); }
  g.box(x + 1, y + 18, z + 1, x + 12, y + 18, z + 2, C.signWhite);
}
const RPROP = {
  plant: [16, 12, (g, x, y, z, r, o) => plantRoom(g, x, y, z, o)],
  hvac: [22, 10, hvacPad],
  stock: [11, 7, (g, x, y, z, r, o) => stockPile(g, x, y, z, o)],
  cafe: [25, 13, (g, x, y, z, r, o) => roofCafe(g, x, y, z, r, o)],
  dish: [6, 7, dish],
  frame: [14, 4, (g, x, y, z, r, o) => signFrame(g, x, y, z, o)],
  solar: [20, 16, (g, x, y, z) => solar(g, x, y, z, 20, 16, 2, 2)],
  solar2: [20, 8, (g, x, y, z) => solar(g, x, y, z, 20, 8, 2, 1)],
  ac: [7, 6, acUnit], acBig: [13, 7, acBig], hatch: [7, 7, hatch], tank: [9, 9, tank],
  vent: [4, 4, (g, x, y, z) => vent(g, x + 1, y, z + 1, 5)],
  vents: [9, 4, (g, x, y, z) => { vent(g, x + 1, y, z + 1, 6); vent(g, x + 6, y, z + 1, 4); }],
  stair: [12, 10, (g, x, y, z) => stairHouse(g, x + 1, y, z + 1)],
  sky: [12, 9, (g, x, y, z) => skylight(g, x, y, z, 12, 9)],
  garden: [16, 11, (g, x, y, z, r) => ROOFMOD.garden(g, r, x, z, x + 15, z + 10, y, {})],
  gardenL: [22, 13, (g, x, y, z, r) => ROOFMOD.garden(g, r, x, z, x + 21, z + 12, y, {})],
  planter: [12, 5, roofPlanter],
  // w4r4 SIGNATURE roof pieces (critic w4r3: "almost every roof carries the
  // same grey AC and vent clutter ... give each shop a distinct rooftop"):
  // each catalog shop now gets ONE themed piece + 1-2 small neutral units
  flue: [7, 7, (g, x, y, z) => flue(g, x, y, z)],
  dogrun: [26, 16, (g, x, y, z, r, o) => dogRun(g, x, y, z, r, o)],
  play: [26, 16, (g, x, y, z) => playMat(g, x, y, z)],
  court: [30, 18, (g, x, y, z, r) => ROOFMOD.court(g, r, x, z, x + 29, z + 17, y)],
  herbs: [24, 12, (g, x, y, z) => herbBeds(g, x, y, z)],
};
// brick chimney stack with a dark cap (bakery / pizza oven) — no smoke puff:
// the w4r3 critic read the diner's grey smoke blob as a rock pile
function flue(g, x, y, z) {
  g.box(x + 1, y, z + 1, x + 5, y + 13, z + 5, C.brickDark);
  g.box(x + 1, y + 11, z + 1, x + 5, y + 11, z + 5, C.brick);
  g.box(x, y + 14, z, x + 6, y + 14, z + 6, C.stoneDark);
  g.box(x + 2, y + 15, z + 2, x + 4, y + 15, z + 4, C.comFrame);
}
// roof dog run 26 × 16: lawn inside a low white fence, a red kennel, a bone
function dogRun(g, x, y, z, r, o = {}) {
  g.box(x, y - 1, z, x + 25, y - 1, z + 15, C.lotGrass);
  g.walls(x, y, z, x + 25, y + 2, z + 15, C.signWhite);
  g.box(x + 11, y, z, x + 14, y + 2, z, null);
  for (let xx = x + 2; xx < x + 25; xx += 3) { g.set(xx, y + 1, z, null); g.set(xx, y + 1, z + 15, null); }
  const kc = o.acc != null ? o.acc : C.red;
  g.box(x + 16, y, z + 7, x + 23, y + 5, z + 13, kc);
  g.box(x + 15, y + 6, z + 6, x + 24, y + 6, z + 14, C.signWhite);
  g.box(x + 17, y + 7, z + 7, x + 22, y + 7, z + 13, C.signWhite);
  g.box(x + 18, y, z + 7, x + 21, y + 3, z + 7, C.comFrame);
  g.box(x + 4, y, z + 5, x + 7, y, z + 5, C.signWhite); g.set(x + 3, y, z + 5, C.signWhite); g.set(x + 8, y, z + 5, C.signWhite);
  g.box(x + 4, y, z + 10, x + 6, y, z + 12, C.blue);
  if (r) person(g, r, x + 9, z + 9, y);
}
// soft play mat 26 × 16: four big coloured rubber squares in a white rim,
// a mini slide and a soft block
function playMat(g, x, y, z) {
  const cs = [C.red, C.yellow, C.blue, C.roofGreen];
  g.box(x, y - 1, z, x + 25, y - 1, z + 15, C.signWhite);
  for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) g.box(x + 1 + i * 12, y - 1, z + 1 + k * 7, x + 12 + i * 12, y - 1, z + 7 + k * 7, cs[i * 2 + k]);
  g.box(x + 13, y, z + 6, x + 15, y + 7, z + 9, C.signWhite);
  g.box(x + 13, y + 7, z + 6, x + 16, y + 7, z + 9, C.red);
  for (let k = 0; k < 6; k++) g.box(x + 16 + k, y + 6 - k, z + 6, x + 16 + k, y + 6 - k, z + 9, C.yellow);
  g.box(x + 4, y, z + 4, x + 8, y + 4, z + 8, C.signWhite); g.box(x + 4, y + 5, z + 4, x + 8, y + 5, z + 8, C.blue);
}
// kitchen herb garden 24 × 12: three raised timber beds of lettuce/tomato rows
function herbBeds(g, x, y, z) {
  const rows = [[C.leafMid, C.leafDark], [C.red, C.leafDark], [C.lime, C.leafMid]];
  for (let i = 0; i < 3; i++) {
    const bx = x + i * 8;
    g.walls(bx, y, z, bx + 6, y + 1, z + 11, C.wood);
    g.box(bx + 1, y, z + 1, bx + 5, y + 1, z + 10, C.woodDark);
    for (let k = z + 2; k <= z + 9; k += 2) { g.box(bx + 2, y + 2, k, bx + 4, y + 2, k, rows[i][1]); g.box(bx + 3, y + 3, k, bx + 3, y + 3, k, rows[i][0]); }
  }
}
function roofProps(g, rng, x0, z0, x1, z1, y, list, block = [], opt = {}) {
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  if (W < 8 || D < 6) return;
  const occ = new Uint8Array(W * D);
  const mark = (x, z, w, d, pad = 0) => {
    for (let i = Math.max(x0, x - pad); i <= Math.min(x1, x + w - 1 + pad); i++)
      for (let k = Math.max(z0, z - pad); k <= Math.min(z1, z + d - 1 + pad); k++) occ[(k - z0) * W + (i - x0)] = 1;
  };
  for (const [bx0, bz0, bx1, bz1] of block) mark(bx0, bz0, bx1 - bx0 + 1, bz1 - bz0 + 1, 1);
  const free = (x, z, w, d) => {
    if (x < x0 + 2 || z < z0 + 2 || x + w - 1 > x1 - 2 || z + d - 1 > z1 - 2) return false;
    for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) if (occ[(k - z0) * W + (i - x0)]) return false;
    return true;
  };
  const m = 2;
  for (const it of list) {
    const [kind, an] = Array.isArray(it) ? it : [it, 'c'];
    const spec = RPROP[kind]; if (!spec) continue;
    const [w, d, draw] = spec;
    const xl = x0 + m, xr = x1 - m - w + 1, xc = (x0 + x1 - w + 1) >> 1;
    const zf = z0 + m, zb = z1 - m - d + 1, zc = (z0 + z1 - d + 1) >> 1;
    const ax = an.includes('l') ? xl : an.includes('r') ? xr : xc;
    const az = an[0] === 'f' ? zf : an[0] === 'b' ? zb : zc;
    let best = null;
    for (let rad = 0; rad <= 24 && !best; rad++) {
      for (let dx = -rad; dx <= rad && !best; dx++) {
        const rz = rad - Math.abs(dx);
        for (const dz of rz ? [-rz, rz] : [0]) if (free(ax + dx, az + dz, w, d)) { best = [ax + dx, az + dz]; break; }
      }
    }
    if (globalThis.__RPLOG) globalThis.__RPLOG.push(best ? kind : '!' + kind);
    if (!best) continue;
    draw(g, best[0], y, best[1], rng, opt);
    mark(best[0], best[1], w, d, list.gap != null ? list.gap : 2);
  }
}
// default kits (3-4 props) for shops without their own list (zoned C growth)
// w4r1: 5-6 composite props per roof (plant room, HVAC pad, café corner,
// stock, dish, sign frame, solar) instead of 3-4 small ones
// w4r3 (critic w4r2: "clumps of mismatched props (flowers, cubes, AC units)
// look noisy next to the reference's tidy roofs"): 4 neutral pieces, no
// coloured stock piles or flower beds
const ROOFKITS = [
  // w4r4: one themed piece + 1-2 small neutral units (critic w4r3: the same
  // grey AC / vent clutter on every roof)
  [['solar', 'fl'], ['ac', 'bl']],
  [['cafe', 'fl'], ['ac', 'bl']],
  [['garden', 'fl'], ['sky', 'fr'], ['ac', 'bl']],
  [['herbs', 'fl'], ['solar2', 'fr'], ['ac', 'bl']],
];
// light rim band inside the parapet (ref02) on the deck row y
const ROOFPLANS = [
  ['garden', 'hvac', 'solar', 'stair', 'patio', 'garden'],
  ['patio', 'garden', 'hvac', 'solar', 'stair', 'garden'],
  ['hvac', 'garden', 'patio', 'garden', 'solar', 'stair'],
  ['garden', 'solar', 'hvac', 'pergola', 'stair', 'garden'],
];
function roofRim(g, x0, z0, x1, z1, y, c = C.offwhite) {
  g.box(x0, y, z0, x1, y, z0 + 1, c); g.box(x0, y, z1 - 1, x1, y, z1, c);
  g.box(x0, y, z0, x0 + 1, y, z1, c); g.box(x1 - 1, y, z0, x1, y, z1, c);
}

// ---------------------------------------------------------------------------
// LOT PROPS (stand on y = G unless given)
// ---------------------------------------------------------------------------
const SHIRTS = [C.red, C.blue, C.yellow, C.teal, C.orange, C.purple, C.pink, C.roofGreen, C.signWhite];
const SKINS = [C.skin1, C.skin2, C.skin3, C.skin4, C.skin5];
// (life r8) the shared life.js figure (vehicles.js stampPerson: head, shirt,
// arms, legs) in the lot part, centred on the old 2×2 spot; four rng draws as
// before so the rest of each building's layout is unchanged. The old 2×2×9
// columns were the "pedestrians are voxel pegs" the r7 critic flagged.
function person(g, rng, x, z, y = G) {
  const a = rng(), b = rng(), c = rng(); rng();
  const seed = ((a * 4096) | 0) * 64 + ((b * 64) | 0), dir = (c * 4) | 0;
  // a z-mirrored view (back apron): the 2×2 spot z..z+1 is real z Z-z-1..Z-z
  if (g.__base) stampPerson(g.__base, x + 1, y, g.__Z - z, seed, (dir + 2) % 4);
  else stampPerson(g, x + 1, y, z + 1, seed, dir);
}
// Scatter n people on free paving in a rect (2×2 footprint, 10 rows clear).
function crowd(g, rng, x0, z0, x1, z1, n) {
  for (let t = 0, k = 0; t < n * 12 && k < n; t++) {
    const x = x0 + ((rng() * (x1 - x0)) | 0), z = z0 + ((rng() * (z1 - z0)) | 0);
    let ok = g.get(x, LT, z) != null && g.get(x, LT, z) !== C.lotAsphalt;
    for (let dx = -1; ok && dx <= 2; dx++) for (let dz = -1; ok && dz <= 2; dz++) for (let y = G; ok && y <= G + 10; y++) if (g.get(x + dx, y, z + dz) != null) ok = false;
    if (!ok) continue;
    person(g, rng, x, z); k++;
  }
}
// Café set: 3×3 table, a chair each side (along x), optional parasol.
function tableSet(g, x, z, y = G, o = {}) {
  const top = o.top != null ? o.top : C.signWhite;
  let chair = o.chair != null ? o.chair : C.wood;
  if (chair === C.signWhite || chair === top) chair = o.cols ? o.cols[0] : C.wood;
  g.box(x, y, z, x, y + 3, z, C.comFrame);
  g.box(x - 1, y + 4, z - 1, x + 1, y + 4, z + 1, top);
  for (const s of [-1, 1]) {
    const cx = x + s * 3;
    g.box(cx, y, z - 1, cx, y + 2, z, chair);
    g.box(cx + s, y + 3, z - 1, cx + s, y + 5, z, chair);
    g.box(cx + s, y, z - 1, cx + s, y + 2, z - 1, chair);
  }
  if (o.par === false) return;
  const [cA, cB] = o.cols || [C.red, C.signWhite];
  const r = o.r || 5;
  g.box(x, y + 5, z, x, y + 12, z, C.comFrame);
  parasolTop(g, x, y + 13, z, r, cA, cB);
}
// Round parasol dome: a skirt ring one row lower, three shrinking tiers,
// eight alternating segments, a finial.
function parasolTop(g, x, y, z, r, cA, cB) {
  const inside = (dx, dz, rr) => dx * dx + dz * dz <= rr * rr + rr * 0.8;
  for (let t = 0; t < 2; t++) {
    const rr = r - t * (r > 4 ? 2 : 1.6);
    if (rr < 0.5) break;
    const n = Math.ceil(rr);
    for (let dx = -n; dx <= n; dx++) for (let dz = -n; dz <= n; dz++) {
      if (!inside(dx, dz, rr)) continue;
      const a = Math.atan2(dz, dx) + Math.PI + Math.PI / 8;
      const c = (Math.floor(a / (Math.PI / 4)) & 1) ? cA : cB;
      g.set(x + dx, y + t, z + dz, c);
      if (t === 0 && !inside(dx, dz, rr - 1.2)) g.set(x + dx, y - 1, z + dz, c);
    }
  }
  g.set(x, y + 2, z, cA);
}
function bench(g, x, z, axis = 'x', len = 8, seat = C.wood) {   // back on the +side
  const P = (a, yy, b, c) => (axis === 'x' ? g.set(x + a, G + yy, z + b, c) : g.set(x + b, G + yy, z + a, c));
  for (const a of [0, len - 1]) for (let yy = 0; yy < 2; yy++) { P(a, yy, 0, C.comFrame); P(a, yy, 2, C.comFrame); }
  for (let a = 0; a < len; a++) { P(a, 2, 0, seat); P(a, 2, 1, seat); P(a, 2, 2, seat); P(a, 3, 2, seat); P(a, 4, 2, seat); }
}
function bin(g, x, z, c = C.roofGreen) { g.box(x, G, z, x + 2, G + 4, z + 2, c); g.box(x, G + 5, z, x + 2, G + 5, z + 2, C.comFrame); }
function lamp(g, x, z, h = 24, dir = 1) {
  g.box(x, G, z, x, G + h, z, C.comFrame);
  g.box(x, G + h, z, x + dir * 3, G + h, z, C.comFrame);
  g.box(x + dir * 2, G + h - 1, z, x + dir * 3, G + h - 1, z, C.lamp);
}
function bollard(g, x, z) { g.box(x, G, z, x + 1, G + 3, z + 1, C.offwhite); g.box(x, G + 4, z, x + 1, G + 4, z + 1, C.comFrame); }
function planter(g, x0, z0, x1, z1, fl, box = C.offwhite) {
  g.box(x0, G, z0, x1, G + 2, z1, box);
  g.box(x0 + 1, G + 3, z0 + 1, x1 - 1, G + 4, z1 - 1, C.vegBush);
  g.box(x0 + 1, G + 3, z0 + 1, x1 - 1, G + 3, z1 - 1, C.vegBushDark);
  let i = 0;
  if (fl) for (let x = x0 + 1; x < x1; x += 2) for (let z = z0 + 1; z < z1; z += 2) if (((x + z) >> 1) % 2 === 0) g.set(x, G + 5, z, fl[i++ % fl.length]);
}
function hedge(g, x0, z0, x1, z1, h = 4) {
  g.box(x0, G, z0, x1, G + h - 1, z1, C.vegBush);
  g.box(x0, G, z0, x1, G, z1, C.vegBushDark);
}
function tree(g, x, z, kind = 'round', seed = 0) { stampVeg(g, kind, x, G, z, seed, 1); }
function bike(g, x, z, c) {                          // along z, 10 long, at column x
  for (const zc of [z + 2, z + 7]) {
    for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dy) + Math.abs(dz) >= 2 && Math.abs(dy) + Math.abs(dz) <= 3 && !(Math.abs(dy) === 2 && Math.abs(dz) === 2)) g.set(x, G + 2 + dy, zc + dz, C.black);
  }
  g.box(x, G + 3, z + 3, x, G + 3, z + 6, c); g.set(x, G + 4, z + 4, c); g.set(x, G + 5, z + 4, C.black);
  g.box(x, G + 4, z + 7, x, G + 5, z + 7, c); g.box(x, G + 6, z + 6, x, G + 6, z + 8, C.darkGray);
}
function bikeRack(g, x, z, n, cols) {                // hoops along x every 3, bikes parked in them
  for (let i = 0; i < n; i++) {
    const xx = x + i * 3;
    g.box(xx, G, z + 3, xx, G + 3, z + 3, C.comFrame); g.box(xx, G, z + 6, xx, G + 3, z + 6, C.comFrame); g.box(xx, G + 4, z + 3, xx, G + 4, z + 6, C.comFrame);
    if (cols && cols[i] != null) bike(g, xx + 1, z, cols[i]);
  }
}
function aboard(g, x, z, face = C.comFrame) {         // chalk A-frame, facing -z
  g.box(x, G, z, x + 3, G + 5, z + 1, C.woodDark);
  g.box(x, G + 1, z, x + 3, G + 4, z, face);
  g.set(x + 1, G + 3, z, C.signWhite); g.set(x + 2, G + 2, z, C.signWhite);
}
function crate(g, x, z, w, d, fruit, fruit2, y = G) {
  g.box(x, y, z, x + w - 1, y + 2, z + d - 1, C.wood);
  g.box(x, y + 1, z, x + w - 1, y + 1, z + d - 1, C.woodDark);
  g.box(x, y + 3, z, x + w - 1, y + 3, z + d - 1, fruit);
  if (fruit2 != null) for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) if ((i * 3 + k * 5) % 4 === 0) g.set(i, y + 3, k, fruit2);
}
// The traffic's car (resampled to res 8), long axis along z (dir 0) or x.
const CARV = [0, 5, 9, 10, 13, 14, 19, 23, 24, 27, 33, 37, 38, 41, 47, 51];
// (life r8) stamped as the full-detail res-15 lot part (vehicles.js stampCar)
// centred on the old 6 × 14 resampled footprint — the res-8 resample read as
// stepped lumps next to the traffic.
function car(g, x, z, variant, dir = 0) {
  if (g.__base) {                       // z-mirrored view: footprint [z-2, z+16) -> real [Z-z-15, Z-z+3)
    if (dir) stampCar(g.__base, variant, x + 7 - 9, G, g.__Z - z - 6, 3);
    else stampCar(g.__base, variant, x + 3 - 4, G, g.__Z - z - 15, 2);
    return;
  }
  if (dir) stampCar(g, variant, x + 7 - 9, G, z + 3 - 4, 3);
  else stampCar(g, variant, x + 3 - 4, G, z + 7 - 9, 0);
}
// Nose-in parking across x0..x1 (bays 11 wide, lines along z, wheel stops at
// the building end z1); `walk` = bay index painted as a zebra walk-in.
function parking(g, rng, x0, z0, x1, z1, o = {}) {
  paint(g, x0, z0, x1, z1, C.lotAsphalt);
  const bw = 11, n = Math.floor((x1 - x0) / bw), s = x0 + Math.floor((x1 - x0 - n * bw) / 2);
  for (let k = 0; k <= n; k++) paint(g, s + k * bw, z0 + 2, s + k * bw, z1, C.lotLine);
  let ci = (rng() * CARV.length) | 0;
  for (let k = 0; k < n; k++) {
    const x = s + k * bw;
    if (k === o.walk) { for (let z = z0 + 1; z <= z1; z += 3) paint(g, x + 2, z, x + bw - 2, z + 1, C.lotLine); continue; }
    if (o.disabled === k) { paint(g, x + 4, z1 - 8, x + 7, z1 - 5, C.blue); }
    g.box(x + 3, G, z1 - 1, x + 8, G, z1 - 1, C.concrete);
    if (rng() < (o.fill != null ? o.fill : 0.75)) car(g, x + 3, Math.max(z0 + 1, z1 - 19), CARV[ci++ % CARV.length], 0);
  }
  return { s, n, bw };
}
function zebra(g, x0, z0, x1, z1, alongX = true) {
  if (alongX) for (let x = x0; x <= x1; x += 3) paint(g, x, z0, Math.min(x1, x + 1), z1, C.lotLine);
  else for (let z = z0; z <= z1; z += 3) paint(g, x0, z, x1, Math.min(z1, z + 1), C.lotLine);
}
// Terrace on the lot: warm tiles with a rim and a grid of table sets.
function lotTerrace(g, rng, x0, z0, x1, z1, o = {}) {
  if (x1 - x0 < 8 || z1 - z0 < 6) return;
  const tile = o.tile != null ? o.tile : C.sand, rim = o.rim != null ? o.rim : C.sandDark;
  paint(g, x0, z0, x1, z1, tile);
  for (let x = x0 + 4; x < x1; x += 5) paint(g, x, z0, x, z1, rim);
  g.box(x0, LT, z0, x1, LT, z0, rim); g.box(x0, LT, z1, x1, LT, z1, rim);
  const px = o.px || 13, pz = o.pz || (o.par === false ? 8 : 13);
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const nx = Math.max(1, Math.floor((W - 8) / px) + 1), nz = Math.max(1, Math.floor((D - 5) / pz) + 1);
  const sx = x0 + Math.floor((W - (nx - 1) * px) / 2), sz = z0 + Math.floor((D - (nz - 1) * pz) / 2);
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const par = o.par === false ? false : o.par === 'alt' ? ((i + k) & 1) === 0 : true;
    tableSet(g, sx + i * px, sz + k * pz, G, { top: o.top, chair: o.chair, par, cols: o.cols, r: o.r || 5 });
    if (rng() < (o.guests != null ? o.guests : 0.55)) person(g, rng, sx + i * px - 1, sz + k * pz + 2);
  }
}

// ---------------------------------------------------------------------------
// r7 DENSE APRONS. The r6 critic: "every lot in ref05 is filled edge to edge
// with stalls, crates, umbrellas and people; ours sits alone on bare paving".
// An apron is a SIDEWALK band under the awnings (a goods display in front of
// every bay) + an OUTER band packed with slot items left and right of the
// door path. Everything is small, separate and colourful.
// ---------------------------------------------------------------------------
// Parallel-parked car (long axis x, footprint x..x+18, z..z+8).
function pcar(g, x, z, variant) {
  if (g.__base) stampCar(g.__base, variant, x, G, g.__Z - z - 8, 3);
  else stampCar(g, variant, x, G, z, 1);
}
// ref05 market stall: counter with separate produce crates, 4 posts, a
// striped canopy (stripes along x) with a valance.
function miniStall(g, x0, z0, x1, z1, cA, goods) {
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.box(x, G, z, x, G + 11, z, C.woodDark);
  g.box(x0 + 1, G, z0 + 1, x1 - 1, G + 3, z1 - 1, C.wood);
  g.box(x0 + 1, G + 1, z0 + 1, x1 - 1, G + 1, z1 - 1, C.woodDark);
  for (let x = x0 + 1, i = 0; x + 1 <= x1 - 1; x += 3, i++) {
    const p = goods[i % goods.length];
    g.box(x, G + 4, z0 + 1, x + 1, G + 4, z1 - 1, p[0]);
    g.set(x, G + 5, z0 + 2, p[1]); if (z1 - z0 > 3) g.set(x + 1, G + 5, z1 - 2, p[0]);
  }
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    const c = ((x - x0 + 1) >> 1) & 1 ? C.signWhite : cA;
    g.box(x, G + 12, z0 - 1, x, G + 12, z1 + 1, c);
    g.set(x, G + 13, (z0 + z1) >> 1, c);
    if (!(((x - x0 + 1) >> 1) & 1)) { g.set(x, G + 11, z0 - 1, cA); g.set(x, G + 11, z1 + 1, cA); }
  }
}
// Food cart: a box on wheels with a striped roof on poles and a goods top.
function foodCart(g, x, z, body, cA, goods) {
  g.box(x, G + 2, z, x + 9, G + 6, z + 4, body);
  g.box(x, G + 6, z, x + 9, G + 6, z + 4, cA);
  g.box(x + 1, G + 7, z + 1, x + 8, G + 7, z + 3, goods);
  for (const xx of [x + 1, x + 8]) { g.box(xx, G, z, xx, G + 1, z, C.black); g.box(xx, G, z + 4, xx, G + 1, z + 4, C.black); }
  for (const xx of [x, x + 9]) g.box(xx, G + 7, z + 2, xx, G + 12, z + 2, C.comFrame);
  for (let xx = x - 1; xx <= x + 10; xx++) g.box(xx, G + 13, z - 1, xx, G + 13, z + 5, ((xx - x + 1) >> 1) & 1 ? C.signWhite : cA);
}
// Sidewalk displays in front of a bay (u a..b), 3 deep from z.
const DISPLAY = {
  crates(g, a, b, z, r, o) {
    let i = (r() * 7) | 0;
    for (let x = a; x + 2 <= b; x += 4) { const p = PRODUCE[i++ % PRODUCE.length]; crate(g, x, z, 3, 3, p[0], p[1]); if ((x >> 2) & 1) crate(g, x, z + 1, 3, 2, p[1], null, G + 4); }
  },
  bistro(g, a, b, z, r, o) {
    const n = Math.max(1, Math.floor((b - a + 2) / 10));
    const s = a + Math.floor((b - a + 1 - (n - 1) * 10) / 2);
    for (let k = 0; k < n; k++) tableSet(g, s + k * 10, z + 1, G, { par: false, top: o.top, chair: o.chair, cols: o.cols });
  },
  flowers(g, a, b, z, r, o) {
    const fl = o.flowers || [C.pink, C.yellow, C.vegPetalR, C.purple, C.signWhite];
    for (let x = a, i = 0; x + 1 <= b; x += 3, i++) {
      const t = i % 2;
      g.box(x, G, z + t, x + 1, G + 1 + t * 2, z + t + 1, t ? C.woodDark : C.comTerra);
      g.box(x, G + 2 + t * 2, z + t, x + 1, G + 2 + t * 2, z + t + 1, C.vegBush);
      g.set(x, G + 3 + t * 2, z + t, fl[i % fl.length]); g.set(x + 1, G + 3 + t * 2, z + t + 1, fl[(i + 2) % fl.length]);
    }
  },
  books(g, a, b, z, r, o) {
    const bc = [C.red, C.blue, C.gold, C.roofGreen, C.purple, C.orange, C.cream];
    const x1 = Math.min(b, a + 11);
    g.box(a, G + 2, z, x1, G + 4, z + 2, C.woodDark);
    for (const x of [a, x1]) g.box(x, G, z, x, G + 1, z + 2, C.woodDark);
    for (let x = a; x <= x1; x++) g.box(x, G + 5, z + 1, x, G + 6 + (x % 3 === 0 ? 1 : 0), z + 2, bc[x % bc.length]);
  },
  bread(g, a, b, z, r, o) {
    const x1 = Math.min(b, a + 11);
    g.box(a, G, z, x1, G + 5, z + 2, C.wood); g.box(a, G + 3, z, x1, G + 3, z, C.woodDark);
    for (let x = a + 1; x < x1; x += 2) { g.box(x, G + 6, z, x, G + 6, z + 2, C.comDough); g.set(x, G + 7, z + 1, x % 4 === 1 ? C.comChoco : C.comDough); }
  },
  toys(g, a, b, z, r, o) {
    const tc = [C.red, C.blue, C.yellow, C.roofGreen, C.pink, C.orange];
    for (let x = a, i = 0; x + 2 <= b; x += 4, i++) { g.box(x, G, z, x + 2, G + 2, z + 2, tc[i % tc.length]); if (i & 1) g.box(x + 1, G + 3, z + 1, x + 2, G + 4, z + 2, tc[(i + 3) % tc.length]); }
  },
  bench(g, a, b, z, r, o) { const L = Math.min(9, b - a + 1); if (L >= 6) bench(g, ((a + b) >> 1) - (L >> 1), z, 'x', L, o.seat); },
  planter(g, a, b, z, r, o) { if (b - a >= 4) planter(g, a, z, b, z + 2, o.flowers || [C.pink, C.yellow]); },
  none() {},
};
// Outer-band slot items: [width, draw(g, x, rng, o)] (band z 1..7).
const SLOT = {
  table: [12, (g, x, r, o) => { tableSet(g, x + 5, 4, G, { par: true, cols: o.cols, chair: o.chair, top: o.top, r: 4 }); if (r() < 0.6) person(g, r, x + 1, 6); }],
  bistro: [9, (g, x, r, o) => { tableSet(g, x + 4, 4, G, { par: false, cols: o.cols, chair: o.chair, top: o.top }); }],
  stall: [14, (g, x, r, o) => { miniStall(g, x + 1, 2, x + 12, 6, o.stall || C.red, [PRODUCE[(x >> 2) % 7], PRODUCE[(x >> 3) % 7 + 0], PRODUCE[(x + 3) % 7]]); }],
  cart: [14, (g, x, r, o) => { foodCart(g, x + 2, 2, o.cartBody || C.signWhite, o.cartA || C.red, o.cartGoods || C.comDough); person(g, r, x + 6, 8); }],
  planter: [8, (g, x, r, o) => planter(g, x + 1, 2, x + 6, 6, o.flowers || [C.pink, C.yellow])],
  shrub: [8, (g, x, r, o) => { g.box(x + 1, G, 2, x + 6, G + 2, 6, C.offwhite); g.box(x + 2, G + 3, 3, x + 5, G + 8, 5, C.vegBush); g.box(x + 2, G + 3, 3, x + 5, G + 3, 5, C.vegBushDark); g.box(x + 3, G + 9, 3, x + 4, G + 9, 5, C.vegBush); }],
  bikes: [11, (g, x, r, o) => bikeRack(g, x + 1, 0, 3, [pk(r, SHIRTS), null, pk(r, SHIRTS)])],
  bench: [11, (g, x, r, o) => { bench(g, x + 1, 3, 'x', 9, o.seat); person(g, r, x + 4, 1); }],
  lamp: [3, (g, x, r, o) => lamp(g, x + 1, 2, 24, 1)],
  board: [6, (g, x, r, o) => aboard(g, x + 1, 5, o.board)],
  bins: [5, (g, x, r, o) => { bin(g, x + 1, 3, o.bin || C.roofGreen); }],
  crates: [11, (g, x, r, o) => { let i = (r() * 7) | 0; for (let k = 0; k < 3; k++) { const p = PRODUCE[i++ % 7]; crate(g, x + 1 + k * 3, 3, 3, 3, p[0], p[1]); } const p = PRODUCE[i % 7]; crate(g, x + 2, 3, 3, 3, p[0], p[1], G + 4); }],
  car: [20, (g, x, r, o) => { paint(g, x, 1, x + 19, 8, C.lotAsphalt); paint(g, x, 1, x, 8, C.lotLine); paint(g, x + 19, 1, x + 19, 8, C.lotLine); if (r() < 0.85) pcar(g, x + 1, 1, CARV[(r() * CARV.length) | 0]); }],
  people: [6, (g, x, r, o) => { person(g, r, x + 1, 3); person(g, r, x + 3, 6); }],
  ride: [12, (g, x, r, o) => {                     // coin kiddie ride: a red car on a yellow base
    g.box(x + 1, G, 2, x + 10, G, 7, C.yellow);
    g.box(x + 2, G + 1, 3, x + 9, G + 4, 6, C.red); g.box(x + 4, G + 5, 3, x + 7, G + 7, 6, C.red); g.box(x + 5, G + 5, 3, x + 6, G + 7, 6, C.winCool);
    for (const [a, b] of [[x + 3, 3], [x + 8, 3], [x + 3, 6], [x + 8, 6]]) g.box(a, G + 1, b === 3 ? 2 : 7, a, G + 2, b === 3 ? 2 : 7, C.black);
    person(g, r, x + 1, 9);
  }],
  dogpen: [17, (g, x, r, o) => {                   // little fenced dog run: grass, doghouse, two dogs
    const xa = x + 1, xb = x + 15;
    paint(g, xa, 1, xb, 7, C.lotGrass);
    for (let xx = xa; xx <= xb; xx++) for (const z of [1, 7]) { g.set(xx, G + 3, z, C.signWhite); if ((xx - xa) % 3 === 0) g.box(xx, G, z, xx, G + 3, z, C.signWhite); }
    for (const xx of [xa, xb]) for (let z = 1; z <= 7; z++) { g.set(xx, G + 3, z, C.signWhite); if (z % 3 === 1) g.box(xx, G, z, xx, G + 3, z, C.signWhite); }
    g.box(xb - 6, G, 2, xb - 2, G + 4, 5, C.red);
    for (let k = 0; k < 3; k++) g.box(xb - 7 + k, G + 5 + k, 2, xb - 1 - k, G + 5 + k, 5, C.roofBrown);
    g.box(xb - 5, G, 2, xb - 3, G + 2, 2, C.black);
    const dog = (dx, dz, col) => { g.box(dx, G + 2, dz, dx + 4, G + 3, dz + 1, col); for (const a of [dx, dx + 4]) g.box(a, G, dz, a, G + 1, dz + 1, col); g.box(dx - 2, G + 3, dz, dx, G + 5, dz + 1, col); g.set(dx - 3, G + 4, dz, C.black); g.box(dx + 5, G + 4, dz, dx + 5, G + 5, dz, col); };
    dog(xa + 4, 3, pk(r, [C.comDough, C.signWhite, C.roofBrown])); dog(xa + 4, 6 - 1, pk(r, [C.hairBlack, C.comDough]));
    g.box(xa + 2, G, 2, xa + 3, G, 3, C.blue);
  }],
  lolly: [8, (g, x, r, o) => {                     // giant swirl lollipop
    const cx = x + 4, cz = 4;
    g.box(cx, G, cz, cx, G + 10, cz, C.signWhite);
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 10) g.set(cx + dx, G + 14 + dy, cz, ((dx * dx + dy * dy) >> 2) & 1 ? C.signWhite : (o.lolly != null ? o.lolly : C.red));
  }],
  busker: [13, (g, x, r, o) => {                   // busker's pitch: rug, amp, open case, a crowd of two
    paint(g, x + 1, 2, x + 11, 7, C.red);
    g.box(x + 2, G, 3, x + 4, G + 4, 5, C.black); g.box(x + 2, G + 4, 3, x + 4, G + 4, 5, C.darkGray);
    g.box(x + 8, G, 2, x + 10, G, 4, C.black); g.set(x + 9, G + 1, 3, C.gold);
    person(g, r, x + 5, 4); person(g, r, x + 9, 8);
  }],
  hoop: [13, (g, x, r, o) => {                     // a basketball pitch with a hoop
    paint(g, x + 1, 1, x + 11, 7, C.roofBlue); paint(g, x + 1, 7, x + 11, 7, C.lotLine); paint(g, x + 4, 1, x + 8, 4, C.navy);
    g.box(x + 6, G, 1, x + 6, G + 20, 1, C.darkGray);
    g.box(x + 3, G + 18, 2, x + 9, G + 24, 2, C.signWhite); g.box(x + 5, G + 19, 2, x + 7, G + 21, 2, C.red);
    g.walls(x + 5, G + 18, 3, x + 7, G + 18, 5, C.orange);
    g.box(x + 9, G, 5, x + 10, G + 1, 6, C.orange);
    person(g, r, x + 2, 5);
  }],
  // w4r1 (critic w3: "lots are mostly plain cream pavement ... ref05's busy
  // seating"): a little ref05 street tree in a kerb planter, and a row of
  // potted round shrubs (ref05 brick café's terrace edge)
  tree: [9, (g, x, r, o) => {
    g.box(x + 1, G, 2, x + 7, G + 1, 7, C.offwhite); paint(g, x + 2, 3, x + 6, 6, C.lotGrass);
    g.box(x + 3, G + 2, 4, x + 4, G + 8, 5, C.vegTrunk);
    g.box(x + 1, G + 9, 2, x + 7, G + 15, 7, C.vegLeaf); g.box(x + 1, G + 9, 2, x + 7, G + 10, 7, C.vegLeafBand);
    g.box(x + 2, G + 16, 3, x + 6, G + 16, 6, C.vegLeaf);
    g.set(x + 1, G + 13, 3, C.vegLeafDot); g.set(x + 5, G + 12, 2, C.vegLeafDot); g.set(x + 7, G + 14, 5, C.vegLeafDot);
  }],
  pots: [13, (g, x, r, o) => {
    for (let k = 0; k < 3; k++) {
      const px = x + 1 + k * 4;
      g.box(px, G, 3, px + 2, G + 2, 5, k === 1 ? C.comTerra : C.offwhite);
      g.box(px - (k === 1 ? 0 : 0), G + 3, 3, px + 2, G + 5, 5, C.vegBush); g.box(px, G + 3, 3, px + 2, G + 3, 5, C.vegBushDark);
      if (k !== 1) g.set(px + 1, G + 6, 4, C.vegBush);
      else g.set(px + 1, G + 6, 4, (o.flowers || [C.pink])[0]);
    }
  }],
  balloons: [8, (g, x, r, o) => { g.box(x + 3, G, 4, x + 3, G + 15, 4, C.signWhite); for (const [dx, dy, dz, col] of [[-2, 16, -1, C.red], [1, 18, 0, C.blue], [-1, 21, 1, C.yellow], [2, 20, -2, C.pink]]) g.box(x + 3 + dx, G + dy, 4 + dz, x + 4 + dx, G + dy + 2, 5 + dz, col); }],
};
function packSlots(g, rng, xa, xb, items, o) {
  const list = [];
  let used = 0;
  for (const it of items) { const s = SLOT[it]; if (!s) continue; if (used + s[0] > xb - xa + 1) break; list.push(s); used += s[0]; }
  if (!list.length) return;
  // r11: spread the items evenly with clear paving between them (the r10
  // critic: "a few separate props with empty space between them"; r7-r10
  // packed them from the left 3 apart, which read as one blob)
  const span = xb - xa + 1, n = list.length;
  const gap = Math.min(10, Math.floor((span - used) / (n + 1)));
  let x = xa + ((span - used - gap * (n - 1)) >> 1);
  for (const [w, draw] of list) { draw(g, x, rng, o); x += w + gap; }
}
// The r7 apron: sidewalk band (z0-5..z0-1) + door path + displays + slots.
function apron(c, sp) {
  const { g, rng, du, z0 } = c;
  paint(g, 1, z0 - 6, 61, z0 - 1, sp.walk != null ? sp.walk : C.lotPave);   // w4r2: a light sidewalk band on the setts
  paint(g, 1, z0 - 6, 61, z0 - 6, C.lotRim);
  if (du != null) paint(g, du - 1, 1, du + 8, z0 - 1, sp.path != null ? sp.path : C.lotRim);
  const disp = DISPLAY[sp.display || 'planter'];
  // r11: goods displays in front of every OTHER bay (or sp.dispBays), so
  // the shopfront glass and awnings read between them
  (c.bays || []).forEach(([a, b], i) => {
    if (a < (sp.dispFrom || 0)) return;
    if (sp.dispBays ? !sp.dispBays.includes(i) : (i % 2) === 1) return;
    disp(g, a, b, z0 - 4, rng, sp);
  });
  const L = sp.left || [], Rr = sp.right || [];
  if (du == null) packSlots(g, rng, 2, 60, L.concat(Rr), sp);
  else { packSlots(g, rng, 2, du - 3, L, sp); packSlots(g, rng, du + 10, 60, Rr, sp); }
}

// ---------------------------------------------------------------------------
// shop(rng, S) — one res-8 1×1 shop.
//   S.body [x0,z0,x1,z1]; S.tall (extra GF rows); S.floors (1-3); S.up (upper
//   block rect, default = body); colours: wall, base, trim (piers, cornice),
//   frame (bay frames), kick, band, stripe, upper, upTrim, awn [a,b];
//   S.name, S.nameFg, S.logo (LOGO key) + logoBg/logoBd; S.door 'C'|'L'|'R'|
//   'none' (+ doorOff), S.doorC, S.mat, S.doorAwn; S.back 'shop'|'service';
//   S.sides [left, right] each 'shop'|'plain'|'none'; S.upStyle, shutter,
//   boxes, flowers; S.roof (gear list for the top deck), S.terrace (GF roof
//   terrace options when the upper block is set back), S.roofTerrace (rect on
//   a 1-storey roof), S.lot(ctx), S.after(ctx).
// ---------------------------------------------------------------------------
function levels(t = 0) {
  const GY1 = 19 + t;                     // r7: GF glass 6..19 (was 6..23): finer storeys
  // r8: the fascia band is 12 rows (was 9) so the name fits in BOLD 10-row letters
  // r10: the fascia is SLIM again (6 rows, was 12): the r9 critic found the
  // bold names "cover whole storeys and swamp the architecture". The name is a
  // small 7-row board (signBoard) on it, STR..B1.
  // r11: the fascia is 10 rows (B0..B1) so the 11-row BOLD board (boldBoard,
  // 7-row letters with 2-voxel stems) fits on it, STR..B1; the r10 critic
  // found the 3×5 1-voxel letters "mushy and hard to read at this scale".
  // w2r1: SLIM fascia again — an 8-row band (B0..B1) carrying the 9-row name
  // panel (namePanel, 5-row letters) STR..B1; the white cornice is TOP.
  return { GY0: 6, GY1, AWT: GY1 + 3, STR: GY1 + 4, B0: GY1 + 5, B1: GY1 + 12, TOP: GY1 + 13 };
}
// r7 default body: the FULL lot width (party walls, so a row of shops reads as
// one continuous street frontage like ref05's market block) and 36 deep, so
// both aprons are 12 deep and get packed edge to edge.
const BODY = [1, 13, 61, 49];
function shop(rng, S) {
  const [x0, z0, x1, z1] = S.body || BODY;
  const L = levels(S.tall || 0);
  const floors = Math.max(1, Math.min(5, S.floors || 1));
  const up = S.up || [x0, z0, x1, z1];
  const topY = L.TOP + (floors - 1) * UP;
  const g = grid(63, topY + (S.headroom || 44), 63);
  // w4r2 CONTRASTING PAVING (critic w4r1: "the pale cream paving in front of
  // the shops blends into the walls"): shop lots are a mid-grey setts plaza
  // with light joints (ref05's market-street cobbles), so the cream/white
  // walls, the light kerb rim and the white parking lines all stand off it
  lot(g, 62, 62, S.fill != null ? S.fill : SETT);
  if (S.grid !== false) paveGrid(g, 1, 1, 61, 61, SETT_J);

  const wall = S.wall, trim = S.trim != null ? S.trim : C.signWhite, frame = S.frame != null ? S.frame : C.comFrame;
  const band = S.band != null ? S.band : S.stripe, stripe = S.stripe != null ? S.stripe : trim;
  const base = S.base != null ? S.base : C.comFrame;
  const cx = (x0 + x1) >> 1;
  // w4r3 LOW RETAIL BOX (coordinator 17:20 + critics w3r1/w4r1/w4r2: "repeated
  // grids of blue windows on flat pale upper floors"; ref05's supermarket and
  // Mac Auto are ONE tall glazed storey): a 1-storey shop gets a full-height
  // shopfront of wide bays with FINE mullions (a pane every 5) and 2-wide piers
  const low = floors === 1;
  const bo = { frame, kick: S.kick != null ? S.kick : base, mull: S.mull, pane: S.pane || (low ? 5 : undefined), goods: S.goods };
  const edgeL = x0 <= 3, edgeR = x1 >= 59;          // party walls: no side awnings (they would clip)

  // ---- GF shell --------------------------------------------------------------
  g.walls(x0, G, z0, x1, L.TOP, z1, wall);
  g.walls(x0, G, z0, x1, G + 1, z1, base);
  g.box(x0 + 1, L.TOP, z0 + 1, x1 - 1, L.TOP, z1 - 1, C.comRoof);
  const pier = S.pier != null ? S.pier : trim;
  for (const [px, pz, sx, sz] of [[x0 - 1, z0 - 1, 1, 1], [x1 + 1, z0 - 1, -1, 1], [x0 - 1, z1 + 1, 1, -1], [x1 + 1, z1 + 1, -1, -1]]) {
    g.box(px, G, pz, px + sx * 2, L.STR - 1, pz, pier);
    g.box(px, G, pz, px, L.STR - 1, pz + sz * 2, pier);
  }
  g.walls(x0 - 1, L.STR, z0 - 1, x1 + 1, L.STR, z1 + 1, stripe);
  g.walls(x0 - 1, L.B0, z0 - 1, x1 + 1, L.B1, z1 + 1, band);
  // w4r4 FINE TRIM (critic w4r3: "thin white trim bands" on ref05's Mac Auto):
  // a 1-row white pinstripe along the foot of a coloured fascia band, so the
  // band reads framed white-top (cornice) and white-bottom
  const pinC = S.pin !== undefined ? S.pin : (lum(band) < 0.7 ? C.signWhite : null);
  if (pinC != null) g.walls(x0 - 1, L.B0, z0 - 1, x1 + 1, L.B0, z1 + 1, pinC);
  g.walls(x0 - 2, L.TOP, z0 - 2, x1 + 2, L.TOP, z1 + 2, trim);

  const F = facade(g, 'front', z0), B = facade(g, 'back', z1), Lf = facade(g, 'left', x0), Rf = facade(g, 'right', x1);
  const awn = S.awn;
  // r8 awnings: solid brand colour (default), wide 4-voxel stripes (S.awnStripe),
  // or one solid colour per bay cycling through S.awn (S.awnCycle)
  // w2r1: consensus "a few clean SOLID awnings" — stripes only on request
  // (S.awnStripe === 'force'); otherwise one solid colour with a light lip
  const ao = { stripe: S.awnStripe === 'force' ? (S.awnStripeW || 4) : 0, lip: S.awnLip != null ? S.awnLip : (S.awnStripe && awn && awn[1] != null ? awn[1] : null) };
  let awnI = 0;
  const awnCols = () => (S.awnCycle ? [awn[awnI++ % awn.length]] : awn);
  const runBays = (f, a0, a1, withAwn = true, out) => {
    // w2r1: BIG glass bays (one per side of the door on a 1×1 front, mullions
    // every ~5) — "mostly-glass shopfronts with mullions", fewer awnings
    for (const [a, b] of splitBays(a0, a1, S.bayW || (low ? 20 : 16), S.pierW || (low ? 2 : 3))) {
      bay(f, a, b, L.GY0, L.GY1, bo);
      const skip = S.noAwn && b + 1 >= S.noAwn[0] && a - 1 <= S.noAwn[1];
      if (awn && withAwn && !skip) awning(f, a - 1, b + 1, L.AWT, S.awnD || 4, awnCols(), ao);
      if (out) out.push([a, b]);
    }
  };
  // ---- front: bays either side of the door, the door, the name --------------
  const dm = S.door || 'C';
  const du = dm === 'none' ? null : dm === 'L' ? x0 + (S.doorOff != null ? S.doorOff : 5)
    : dm === 'R' ? x1 - (S.doorOff != null ? S.doorOff : 5) - 7 : cx - 3;
  const storefront = (f, d, u0, u1, out) => {
    if (d == null) runBays(f, u0, u1, true, out);
    else {
      runBays(f, u0, d - 3, true, out); runBays(f, d + 10, u1, true, out);
      glassDoor(f, d, L.GY1, { frame, doorC: S.doorC, mat: S.mat });
      if (S.doorAwn && awn) awning(f, d - 1, d + 8, L.AWT, S.awnD || 4, S.doorAwn === true ? awnCols() : S.doorAwn, ao);
      else canopy(f, d - 2, d + 9, L.GY1 + 2, 4, S.canopy != null ? S.canopy : stripe, trim);
      wallLamp(f, d - 2, L.GY1 - 1); wallLamp(f, d + 9, L.GY1 - 1);
    }
  };
  const frontBays = [], backBays = [];
  storefront(F, du, x0 + 3, x1 - 3, frontBays);
  const logo = S.logo ? LOGO[S.logo] : null, lbg = S.logoBg != null ? S.logoBg : C.signWhite, lbd = S.logoBd != null ? S.logoBd : stripe;
  // w2r1: no blade signs by default (one sign per face; the blade competed
  // with the fascia name and hid the facade behind it)
  const blades = logo && floors > 1 && S.blade === true;
  // r10: the name is a SMALL board (signBoard, 7 rows, about a third of the
  // frontage) on the slim fascia, over the door; no band logo tiles (the
  // logo lives on the blade sign / gable). Default: a white board with the
  // lettering in the band colour (dark if the band is pale) and a frame in the
  // stripe colour; S.signBg / S.signFg / S.signBd override.
  // (r10 wip: white boards with band-coloured 1-voxel letters lost contrast
  // on the shaded side; light-on-dark reads crisp, like ref02's SHOP sign)
  const sBg = S.signBg != null ? S.signBg : C.black;
  let sFg = S.signFg != null ? S.signFg : C.signWhite;
  if (Math.abs(lum(sFg) - lum(sBg)) < 0.3) sFg = lum(sBg) > 0.5 ? C.comFrame : C.signWhite;
  let sBd = S.signBd != null ? S.signBd : stripe;
  if (S.signBd == null && (sBd === sFg || sBd === sBg || sBd === band)) sBd = sFg === C.comFrame || sBg === C.comFrame ? (band === C.gold ? C.yellow : C.gold) : C.comFrame;
  const sign = { bg: sBg, fg: sFg, bd: sBd, lamps: S.signLamps };
  const nameOn = (f, u0, u1, str = S.name, at = null) => {
    if (!str) return;
    // w2r1: the slim 9-row name panel (5-row stem-bold letters) on the
    // 8-row fascia; the small 3×5 board only when a word will not fit
    const slim = panelW(str) + 4 <= u1 - u0 + 1;
    const bw = slim ? panelW(str) : boardW(str);
    if (bw + 4 > u1 - u0 + 1) return;
    let cu = at != null ? at : (u0 + u1 + (f.rd < 0 ? 1 : 0)) >> 1;
    const h = (bw >> 1) + 2;
    cu = Math.max(Math.min(u0, u1) + h, Math.min(Math.max(u0, u1) - h, cu));
    if (slim) namePanel(f, cu, L.STR, str, sign);
    else signBoard(f, cu, L.STR + 1, str, { ...sign, thick: 1 });
  };
  const doorCu = (d) => (d == null ? null : d + 4);
  nameOn(F, x0 + 1, x1 - 1, S.name, S.signAt != null ? S.signAt : doorCu(du));
  // ---- back ------------------------------------------------------------------
  const backKind = S.back || 'shop';
  const bdu = backKind === 'shop' ? (S.backDoor === 'L' ? x0 + 5 : S.backDoor === 'R' ? x1 - 12 : S.backDoor === 'C' ? cx - 3 : du) : null;
  if (backKind === 'shop') { storefront(B, bdu, x0 + 3, x1 - 3, backBays); nameOn(B, x0 + 1, x1 - 1, S.name, S.signAt != null ? S.signAt : doorCu(bdu)); }
  else if (backKind === 'service') {
    const sd = S.backDoorU != null ? S.backDoorU : x0 + 6;
    serviceDoor(B, sd, { color: S.doorC != null ? S.doorC : C.stoneDark, hood: stripe });
    runBays(B, sd + 10, x1 - 14, false, backBays);
    wallAC(B, x1 - 11, L.GY1 - 8);
    drainPipe(B, x1 - 2, G, L.STR - 1);
    if (S.name) nameOn(B, x0 + 1, x1 - 1);
  }
  // ---- sides -----------------------------------------------------------------
  const sides = S.sides || ['shop', 'shop'];
  [[Lf, sides[0], edgeL], [Rf, sides[1], edgeR]].forEach(([f, k, edge]) => {
    if (k === 'none') return;
    const zb = S.sideBack != null ? S.sideBack : z1 - 3;
    if (k === 'shop') runBays(f, z0 + 3, zb, !edge);
    else if (k === 'half') { runBays(f, z0 + 3, (z0 + z1) >> 1, !edge); if (S.halfAC !== false) wallAC(f, z1 - 10, L.GY1 - 8); }
    else { runBays(f, z0 + 3, zb, false); }
    if (S.sideName) nameOn(f, z0 + 1, z1 - 1, S.sideName === true ? S.name : S.sideName);
  });

  // ---- upper storeys (r7: many small framed windows, sills, belt courses,
  // corner quoins, balconies; the ref05 row-house rhythm) ----------------------
  const [ux0, uz0, ux1, uz1] = up;
  const upper = S.upper != null ? S.upper : wall, upTrim = S.upTrim != null ? S.upTrim : trim;
  // r9: crisp WHITE cornice + parapet cap (S.cornice), contrasting belt
  // courses (upTrim), pilasters between window groups (S.pilaster)
  const corn = S.cornice != null ? S.cornice : (upTrim === C.cream ? C.cream : C.signWhite);
  // w4r2 CRISP WINDOWS (critic w4r1: "dark, crisp window frames and outlines";
  // w3r1: "uniform grids of identical small blue windows"): every upper window
  // gets a DARK frame + reveal (S.upFrame, default the charcoal comFrame) set
  // in a LIGHT surround — a proud white sill and head (S.sill / S.lintel,
  // default the cornice colour) — so each window reads as a sharp dark-glass
  // rectangle on the wall, like ref05's terraces, not a pale grid.
  const upFr = S.upFrame != null ? S.upFrame : C.comFrame;
  const uo = { frame: upFr, reveal: S.reveal != null ? S.reveal : upFr, bar: S.upBar, sill: S.sill != null ? S.sill : corn,
    lintel: S.lintel !== undefined ? S.lintel : corn, rail: S.rail, shutter: S.shutter, boxes: S.boxes, flowers: S.flowers, planters: S.planters, winAwn: S.winAwn };
  const st = S.upStyle || 'grid';
  const sideSt = st === 'balc' || st === 'pair' ? 'grid' : st;
  // w4r1: COLOURED pilasters (the belt-course colour) unless it is white/cream
  const pilC = S.pilaster != null ? S.pilaster : (upTrim === C.signWhite || upTrim === C.cream || upTrim === C.offwhite ? corn : upTrim);
  const grp = S.winGroup != null ? S.winGroup : 2;
  for (let k = 1; k < floors; k++) {
    const yb = L.TOP + (k - 1) * UP;
    g.walls(ux0, yb + 1, uz0, ux1, yb + UP, uz1, upper);
    if (S.upBase != null) g.walls(ux0, yb + 1, uz0, ux1, yb + 1, uz1, S.upBase);
    const last = k === floors - 1;
    if (!last) g.walls(ux0 - 1, yb + UP, uz0 - 1, ux1 + 1, yb + UP, uz1 + 1, upTrim);        // belt course
    else { g.walls(ux0 - 1, yb + UP - 1, uz0 - 1, ux1 + 1, yb + UP - 1, uz1 + 1, upTrim); g.walls(ux0 - 2, yb + UP, uz0 - 2, ux1 + 2, yb + UP, uz1 + 2, corn); }
    // corner quoins: 2 wide, proud 1
    if (S.quoins !== false) for (const [px, pz, sx, sz] of [[ux0 - 1, uz0 - 1, 1, 1], [ux1 + 1, uz0 - 1, -1, 1], [ux0 - 1, uz1 + 1, 1, -1], [ux1 + 1, uz1 + 1, -1, -1]]) {
      g.box(px, yb + 1, pz, px + sx * 2, yb + UP - 1, pz, upTrim);
      g.box(px, yb + 1, pz, px, yb + UP - 1, pz + sz * 2, upTrim);
    }
    const wy = yb + 4;
    const Fu = facade(g, 'front', uz0), Bu = facade(g, 'back', uz1), Lu = facade(g, 'left', ux0), Ru = facade(g, 'right', ux1);
    const kst = S.upStyles ? S.upStyles[(k - 1) % S.upStyles.length] : st;
    // w4r2 PER-FLOOR TREATMENT (critic w4r1: "a different treatment on each
    // floor ... balconies, planters and sign bands"): S.floorO[k-1] overrides
    // the window options for that storey (window awnings on one, flower
    // boxes on the next, shutters, ...), on the front and back
    const fo = (S.floorO && S.floorO[k - 1]) || {}, uk = { ...uo, ...fo };
    if (kst === 'curtain') {
      // w4r3 GLASS PAVILION (ref05 Mac Auto's upper box): the whole storey is
      // glazing in wide bays with fine dark mullions, thin light piers between
      const cfr = S.upFrame != null ? S.upFrame : C.comFrame;
      for (const [f, a0, a1] of [[Fu, ux0 + 2, ux1 - 2], [Bu, ux0 + 2, ux1 - 2], [Lu, uz0 + 2, uz1 - 2], [Ru, uz0 + 2, uz1 - 2]])
        for (const [a, b] of splitBays(a0, a1, S.curtainW || 20, 2)) bay(f, a, b, yb + 3, yb + UP - 3, { frame: cfr, pane: 5, transom: false });
      continue;
    }
    const rF = upRow(Fu, ux0 + 4, ux1 - 4, wy, kst, { ...uk, group: grp });
    const rB = upRow(Bu, ux0 + 4, ux1 - 4, wy, kst, { ...uk, group: grp, boxes: kst === 'balc' || fo.boxes ? uk.boxes : false });
    for (const [f, r] of [[Fu, rF], [Bu, rB]]) for (const pc of (r.pils || [])) f.box(pc - 1, yb + 1, 1, pc + 1, yb + UP - (last ? 2 : 1), 1, pilC);
    upRow(Lu, uz0 + 4, uz1 - 4, wy, sideSt, { ...uo, shutter: fo.shutter !== undefined ? fo.shutter : uo.shutter, boxes: false });
    upRow(Ru, uz0 + 4, uz1 - 4, wy, sideSt, { ...uo, shutter: fo.shutter !== undefined ? fo.shutter : uo.shutter, boxes: false });
    if (k === 1 && S.upAC !== false) { wallAC(Ru, uz1 - 9, yb + 3); wallAC(Lu, uz0 + 3, yb + 3); }
    if (k === 1 && S.drain !== false) { drainPipe(Fu, ux1 - 4, L.TOP + 1, topY); drainPipe(Bu, ux0 + 4, L.TOP + 1, topY); }
  }
  // ---- roofs -----------------------------------------------------------------
  // r9 parapet: a coloured trim row (S.coping, default the stripe) under a crisp
  // WHITE CAP 3 wide that overhangs the wall by 1 (ref05's white roof edges)
  const par = S.parapet != null ? S.parapet : trim;
  const cap = (ax0, az0, ax1, az1, yy) => { for (const d of [-1, 0, 1]) g.walls(ax0 + d, yy, az0 + d, ax1 - d, yy, az1 - d, corn); };
  const upSame = ux0 === x0 && uz0 === z0 && ux1 === x1 && uz1 === z1;
  if (floors === 1 || !upSame) {
    g.walls(x0, L.TOP + 1, z0, x1, L.TOP + 1, z1, par);
    g.walls(x0, L.TOP + 2, z0, x1, L.TOP + 2, z1, S.coping != null ? S.coping : stripe);
    cap(x0, z0, x1, z1, L.TOP + 3);
  }
  if (floors > 1) {
    g.box(ux0 + 1, topY, uz0 + 1, ux1 - 1, topY, uz1 - 1, C.comRoof);
    g.walls(ux0, topY + 1, uz0, ux1, topY + 1, uz1, S.upParapet != null ? S.upParapet : upper);
    g.walls(ux0, topY + 2, uz0, ux1, topY + 2, uz1, S.frieze != null ? S.frieze : upTrim);
    cap(ux0, uz0, ux1, uz1, topY + 3);
    if (!upSame) for (let k = L.TOP + 1; k <= L.TOP + 3; k++) g.walls(ux0, k, uz0, ux1, k, uz1, upper);
  }
  // ---- r10 upper-floor VARIETY (critic r9: "identical repeating window grids
  // ... vary the upper floors between buildings: cornices, balconies,
  // different window rhythms"; "varied rooflines") -----------------------------
  if (floors > 1 && S.oriel) {
    // a projecting bay window (oriel) up the middle of the front and back
    const ow = S.oriel === true ? 10 : S.oriel, ocu = (ux0 + ux1) >> 1;
    for (const [f, pl] of [[facade(g, 'front', uz0), uz0 - 3], [facade(g, 'back', uz1), uz1 + 3]]) {
      f.box(ocu - ow, L.TOP + 1, 1, ocu + ow, L.TOP + 1, 2, upTrim);
      f.box(ocu - ow, L.TOP + 2, 1, ocu + ow, topY - 2, 3, S.orielC != null ? S.orielC : upper);
      f.box(ocu - ow - 1, topY - 1, 1, ocu + ow + 1, topY - 1, 4, corn);
      const fo = facade(g, f.side, pl);
      for (let k = 1; k < floors; k++) {
        const yb = L.TOP + (k - 1) * UP;
        if (k > 1) f.box(ocu - ow, yb, 1, ocu + ow, yb, 4, upTrim);
        upRow(fo, ocu - ow + 1, ocu + ow - 1, yb + 4, S.orielWin || 'tall', { ...uo, boxes: false, group: 0 });
      }
    }
  }
  if (floors > 1 && S.balcRun) {
    // a continuous balcony along the front and back of the given floors
    const rc = S.rail != null ? S.rail : C.signWhite;
    for (const k of S.balcRun) {
      if (k < 1 || k >= floors) continue;
      const yb = L.TOP + (k - 1) * UP;
      for (const f of [facade(g, 'front', uz0), facade(g, 'back', uz1)]) {
        const a = ux0 + 3, b = ux1 - 3;
        f.box(a, yb + 1, 1, b, yb + 1, 3, upTrim);
        f.box(a, yb + 2, 3, b, yb + 4, 3, C.dtGlassHi);
        f.box(a, yb + 5, 3, b, yb + 5, 3, rc);
        for (let u = a; u <= b; u += 6) f.box(u, yb + 2, 3, u, yb + 4, 3, rc);
        f.box(b, yb + 2, 3, b, yb + 4, 3, rc);
        f.box(a, yb + 2, 1, a, yb + 5, 2, rc); f.box(b, yb + 2, 1, b, yb + 5, 2, rc);
        const fl = S.flowers || [C.pink, C.red];
        for (let u = a + 4, i = 0; u < b - 3; u += 13, i++) { f.box(u, yb + 2, 1, u + 1, yb + 3, 2, C.vegBush); f.set(u, yb + 4, 2, fl[i % fl.length]); }
      }
    }
  }
  if (floors > 1 && S.dentil) {
    // dentil course under the top cornice
    const yd = topY - 2;
    for (const f of [facade(g, 'front', uz0), facade(g, 'back', uz1)])
      for (let u = ux0 + 1; u <= ux1 - 1; u += 2) f.set(u, yd, 1, corn);
  }
  if (S.gable) {
    // raised parapet centred on the front and back walls: a Dutch stepped
    // gable, a pediment with a round window, or a flat nameplate; the logo
    // sits on it (ref05's rooflines are all different)
    const [gx0, gz0, gx1, gz1] = floors > 1 ? [ux0, uz0, ux1, uz1] : [x0, z0, x1, z1];
    const gy = topY + 1, gcu = (gx0 + gx1) >> 1, gc = S.gableC != null ? S.gableC : (floors > 1 ? upper : wall);
    // the INNER face of each gable shows over the roof from the other iso
    // side (r10 wip: a blank slab), so it gets the logo too
    const inner = [facade(g, 'back', gz0 + 1), facade(g, 'front', gz1 - 1)];
    [facade(g, 'front', gz0), facade(g, 'back', gz1)].forEach((f, fi) => {
      const fin = inner[fi];
      if (S.gable === 'step') {
        f.box(gcu - 13, gy, -1, gcu + 13, gy + 6, 0, gc);
        f.box(gcu - 14, gy + 7, -1, gcu + 14, gy + 7, 1, corn);
        f.box(gcu - 8, gy + 8, -1, gcu + 8, gy + 18, 0, gc);
        f.box(gcu - 9, gy + 19, -1, gcu + 9, gy + 19, 1, corn);
        if (logo) { logoTile(f, gcu, gy + 9, logo, lbg, lbd, 1); logoTile(fin, gcu, gy + 9, logo, lbg, lbd, 1); }
        for (const u of [gcu - 11, gcu + 9]) upWin(f, u, gy + 1, 2, 4, { frame: corn, sill: corn });
      } else if (S.gable === 'pediment') {
        // solid triangle, 2 voxels in per row, with a flush 2-wide cap along
        // both slopes (proud trim on each step read as a ragged sawtooth)
        for (let k = 0; k <= 9; k++) {
          const hw = 18 - 2 * k;
          if (hw < 1) break;
          f.box(gcu - hw, gy + k, -1, gcu + hw, gy + k, 0, gc);
          f.box(gcu - hw, gy + k, -1, gcu - hw + 2, gy + k, 0, corn); f.box(gcu + hw - 2, gy + k, -1, gcu + hw, gy + k, 0, corn);
        }
        f.box(gcu - 18, gy, 1, gcu + 18, gy, 1, corn);
        // round window (oculus)
        const oc = ['.###.', '#####', '#####', '#####', '.###.'];
        for (let r = 0; r < 5; r++) for (let i = 0; i < 5; i++) if (oc[r][i] === '#') f.set(gcu - 2 + i, gy + 6 - r, 0, (r === 2 || i === 2) ? corn : C.winCool);
        f.set(gcu - 3, gy + 4, 0, corn); f.set(gcu + 3, gy + 4, 0, corn); f.set(gcu, gy + 7, 0, corn); f.set(gcu, gy + 1, 0, corn);
      } else {
        f.box(gcu - 8, gy, -1, gcu + 8, gy + 11, 0, gc);
        f.box(gcu - 9, gy + 12, -1, gcu + 9, gy + 12, 1, corn);
        if (logo) { logoTile(f, gcu, gy + 2, logo, lbg, lbd, 1); logoTile(fin, gcu, gy + 2, logo, lbg, lbd, 1); }
      }
    });
  }
  // blade signs on the first upper storey (front near max-X, back near min-X)
  // (a blade projects toward the lens and hides the wall ~10 voxels down and
  // along from it, so it sits at the far end, above the fascia lettering)
  if (blades) {
    const by = floors > 2 ? L.TOP + 12 : L.TOP + 4;
    if (uz0 === z0) bladeSign(g, 'front', uz0, ux1 - 3, by, logo, lbg, lbd);
    if (uz1 === z1) bladeSign(g, 'back', uz1, ux0 + 2, by, logo, lbg, lbd);
  }
  const ry = topY + 1;
  // r9 ROOFSCAPE: a light rim inside the parapet, then the deck is divided into
  // cells, each holding one module (garden bed, patio, HVAC pad, solar,
  // stair house, pergola, tank, skylights, court) — see roofScape().
  const [rx0, rz0, rx1, rz1] = floors > 1 ? [ux0 + 1, uz0 + 1, ux1 - 1, uz1 - 1] : [x0 + 1, z0 + 1, x1 - 1, z1 - 1];
  roofRim(g, rx0, rz0, rx1, rz1, topY);
  const rblock = (S.roofBlock || []).slice();
  if (S.roofTerrace) {
    const [tx0, tz0, tx1, tz1] = S.roofTerrace;
    roofTerrace(g, rng, tx0, tz0, tx1, tz1, ry, S.roofTerraceO || {});
    rblock.push([tx0 - 1, tz0 - 1, tx1 + 1, tz1 + 1]);
  }
  const cr = S.roofRect || [rx0 + 2, rz0 + 2, rx1 - 2, rz1 - 2];
  if (S.roofPlan && !S.roofKit) roofScape(g, rng, cr[0], cr[1], cr[2], cr[3], ry, S.roofPlan,
    { block: rblock, terrace: S.roofTerraceO, extra: S.roofExtra, bed: S.bed, cell: S.roofCell, cellD: S.roofCellD });
  else {
    // w4r1: the composite props take the shop's own colours (plant-room band,
    // café parasols, stock crates, the sign frame's logo)
    const bc = band === C.black || band === wall ? stripe : band;
    const ro = { acc: bc, acc2: stripe === bc ? C.yellow : stripe, cols: awn && awn[0] != null ? [awn[0], C.signWhite] : [bc, C.signWhite], chair: bc,
      logo, bg: lbg, bd: lbd, ...(S.roofO || {}) };
    roofProps(g, rng, cr[0], cr[1], cr[2], cr[3], ry, S.roofKit || pk(rng, ROOFKITS), rblock, ro);
  }
  if (floors > 1 && uz0 > z0 + 6) {
    const to = S.terrace || {};
    if (to.kind === 'garden') {
      g.box(x0 + 1, L.TOP, z0 + 1, x1 - 1, L.TOP, uz0 - 1, C.vegBushDark);
      for (let x = x0 + 2; x < x1 - 2; x += 6) potPlant(g, x, L.TOP + 1, z0 + 2, pk(rng, [C.pink, C.yellow, C.vegPetalR]));
    } else roofTerrace(g, rng, x0 + 1, z0 + 1, x1 - 1, uz0 - 2, L.TOP + 1, to);
    if (S.glassRail !== false) glassRail(g, x0, z0, x1, uz0 - 1, L.TOP + 4);
  }
  const ctx = { g, rng, x0, z0, x1, z1, du, bdu, cx, F, B, L: Lf, Rt: Rf, lv: L, topY, ry, wall, trim, frame, stripe, band, up, back: false, bays: frontBays };
  if (S.lot) {
    S.lot(ctx);
    if (S.mirror !== false) S.lot({ ...ctx, g: mirrorZ(g), z0: 62 - z1, z1: 62 - z0, du: bdu != null ? bdu : du, back: true, F: null, B: null, bays: backBays });
  }
  if (S.after) S.after(ctx);
  if (S.crowd !== 0) {
    const n = S.crowd != null ? S.crowd : 2;     // w2r1: fewer loiterers (breathing room)
    crowd(g, rng, 2, 1, 60, z0 - 2, n);
    if (S.mirror !== false) crowd(mirrorZ(g), rng, 2, 1, 60, 62 - z1 - 2, n);
  }
  return g.done();
}
// Glass balustrade on top of a parapet ring (open terrace side: front + sides
// from z0 to z1): posts every 5, pale glass, a light top rail.
function glassRail(g, x0, z0, x1, z1, y) {
  const seg = (xa, za, xb, zb) => {
    const n = Math.max(Math.abs(xb - xa), Math.abs(zb - za));
    for (let i = 0; i <= n; i++) {
      const x = xa + Math.sign(xb - xa) * i, z = za + Math.sign(zb - za) * i;
      const post = i % 5 === 0 || i === n;
      g.box(x, y, z, x, y + 2, z, post ? C.offwhite : C.dtGlassHi);
      g.set(x, y + 3, z, C.offwhite);
    }
  };
  seg(x0, z0, x1, z0); seg(x0, z0, x0, z1); seg(x1, z0, x1, z1);
}


// ===========================================================================
// ZONED C GROWTH (not flipped; front toward min-Z)
// L1 a shop with one flat above, L2 two flats, L3 a 4-storey block. Full lot
// width (party walls) so zoned rows read as one continuous street frontage.
// ===========================================================================
export function commercial(level, rng) {
  const wall = pk(rng, [C.signWhite, C.cream, C.pBlue, C.pYellow, C.mint, C.resSage, C.resButter]);
  const accent = pk(rng, [C.red, C.blue, C.orange, C.teal, C.purple, C.crimson, C.roofGreen]);
  const name = pk(rng, ['SHOP', 'DELI', 'MART', 'GIFTS', 'OPEN', 'SHOES', 'HATS', 'TOYS', 'GAMES']);
  // w4r3: L1 is a low glazed retail box (ref05's shops), L2/L3 add storeys
  const floors = level === 1 ? 1 : level === 2 ? 2 : 3;
  const logo = pk(rng, ['star', 'cart', 'flower', 'ball', 'book', 'cup', 'bag', 'shop']);
  const kind = pk(rng, ['cafe', 'market', 'park', 'plaza']);
  // w2r1: one or two distinct props per side with clear paving between
  const slots = {
    cafe: [['table', 'tree'], ['bistro', 'planter']],
    market: [['stall'], ['crates', 'tree']],
    park: [['car'], ['bench', 'tree']],
    plaza: [['planter', 'pots'], ['bikes', 'tree']],
  }[kind];
  const darkSign = rng() < 0.5;
  const ust = pk(rng, ['grid', 'shutter', 'pair', 'balc', 'mix', 'arch', 'mix']), bigFirst = rng() < 0.6;
  return shop(rng, {
    floors, tall: floors === 1 ? 6 : 0, wall, stripe: accent, band: accent, awn: rng() < 0.85 ? [accent, C.signWhite] : null, awnStripe: rng() < 0.5,
    frame: darkSign ? C.comFrame : C.signWhite,   // w4r1: half the zoned shops get light shopfront frames
    name, logo, logoBd: accent, signBg: darkSign ? C.black : C.comFrame, signFg: C.signWhite, signBd: darkSign ? accent : C.signWhite,
    upper: pk(rng, [C.brickDark, C.cream, C.resTerracotta, C.resSage, C.brickDark, C.signWhite, C.resButter]),
    upStyle: ust, upStyles: floors >= 3 && ust !== 'balc' && bigFirst ? ['big', ust] : null, shutter: pk(rng, [C.roofGreen, C.navy, C.crimson]), boxes: rng() < 0.6,
    upTrim: pk(rng, [C.signWhite, C.cream]),
    // r10: vary the upper floors + roofline between neighbours
    gable: pk(rng, [null, null, 'step', 'pediment']), oriel: rng() < 0.3 ? 8 : 0, balcRun: rng() < 0.3 ? [floors - 1] : null, dentil: rng() < 0.5,
    goods: rng() < 0.7 ? [accent, C.signWhite, pk(rng, [C.yellow, C.pink, C.lime])] : null,
    lot: (c) => apron(c, { display: kind === 'market' ? 'crates' : 'none', dispBays: [0], cols: [accent, C.signWhite], chair: accent, stall: accent, left: slots[0], right: slots[1] }),
  });
}

// ===========================================================================
// CATALOG SHOPS (r7). Every 1×1 shop fills its lot WIDTH (a row of them is one
// continuous ref05 street frontage), is 36 deep, and is 2-4 storeys of fine
// floors (UP = 16) with many small framed windows, sills, belt courses,
// quoins, balconies and a blade sign. Both 12-deep aprons are packed.
// ===========================================================================
// bBakery — the worked example: a cream shop with two terracotta flats above
// (shuttered windows with flower boxes), framed bays with brown/cream awnings,
// BAKERY on a chocolate fascia front and back, donut tiles and blade signs,
// bread racks under the awnings, parasol tables and a bread cart on each
// apron, a boarded roof terrace, AC units, a stair house and planters.
function bBakery(rng) {
  // r11 (critic r10: the shopfront was "visual noise" — striped awnings, red
  // parasols and an orange cart ran into one red-orange blob; mushy letters;
  // an overloaded roof; flat pink upper floors). Now, like ref02: a calm
  // cream shopfront with big framed glass under SOLID red awnings (a cream
  // valance, deep enough to shade the glass), one bold white-on-dark BAKERY
  // board, 3 separate props per apron (a bistro set, a bench, a planter) with
  // clear paving between; brick or terracotta flats with inset sash windows;
  // a flat roof with a white rim and 3-4 items.
  const wall = pk(rng, [C.cream, C.resButter, C.cream]);
  // (comChoco renders salmon under the grade and merged with the red awnings
  // in r11 wip, so the frames are the ref02 dark slate and the fascia is the
  // wall colour: the board is the only thing on it)
  const upper = pk(rng, [C.brickDark, C.resSage, C.brickDark]);   // w4r2: brick (terracotta read washed-out salmon, brick tomato-red)
  return shop(rng, {
    // w4r1: WHITE shopfront frames + a red kick plate (the dark frames under the deep
    // red awnings read as one slate void, not 'mostly glass')
    floors: 2, tall: 2, wall, base: C.comFrame, kick: C.red, trim: C.signWhite, frame: C.signWhite, pier: C.signWhite,
    stripe: C.comDough, band: wall, name: 'BAKERY', logo: 'donut', logoBg: C.cream, logoBd: C.comDough,
    awn: [C.red, C.signWhite], awnStripe: 'force', awnLip: C.red, awnD: 5, door: 'C', doorC: C.comFrame, mat: C.red, canopy: C.red,
    signBg: C.black, signFg: C.signWhite, signBd: C.comDough, signLamps: true,
    upper, upTrim: C.cream, upStyle: 'big', shutter: C.roofGreen, boxes: false, floorO: [{ boxes: true, flowers: [C.pink, C.signWhite] }],
    lintel: C.cream, dentil: true, goods: [C.comDough, C.comChoco, C.comIcing, C.comDough], upAC: false,
    // w4r4: a Mac Auto roof terrace over the front half (red/white tables on a
    // warm deck), the oven flue and one AC behind
    roofTerrace: [4, 16, 44, 32], roofTerraceO: { deck: C.sand, line: C.sandDark, cols: [C.red, C.signWhite], chair: C.red, top: C.signWhite, parasol: false, guests: 0.5 },
    roofKit: [['flue', 'br'], ['ac', 'fr']],
    crowd: 2,
    lot: (c) => apron(c, { display: 'none', cols: [C.red, C.cream], chair: C.wood, top: C.signWhite, seat: C.wood,
      left: ['bistro', 'board'], right: ['bench', 'tree'], flowers: [C.pink, C.signWhite] }),
  });
}

// Small 3D cone sculpture (crisp at res 8): waffle cone + two scoops + cherry.
function coneSculpture(g, x, y, z, scoop, scoop2) {
  g.box(x - 3, y, z - 3, x + 3, y + 1, z + 3, C.signWhite);
  for (let k = 0; k < 10; k++) {
    const r = 0.6 + k * 0.42;
    const n = Math.ceil(r);
    for (let dx = -n; dx <= n; dx++) for (let dz = -n; dz <= n; dz++) if (dx * dx + dz * dz <= r * r + r * 0.5)
      g.set(x + dx, y + 2 + k, z + dz, ((dx + dz + k) & 3) === 0 ? C.comConeDk : C.comCone);
  }
  const ball = (cy, rr, c) => { const n = Math.ceil(rr); for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (let dz = -n; dz <= n; dz++) if (dx * dx + dy * dy + dz * dz <= rr * rr + rr * 0.5) g.set(x + dx, cy + dy, z + dz, c); };
  ball(y + 14, 4.4, scoop); ball(y + 20, 3.6, scoop2);
  g.box(x, y + 24, z, x, y + 25, z, C.red); g.set(x + 1, y + 26, z, C.leafMid);
}
// bIceCream — a pastel parlour with a flat above (French balconies), a crisp
// 3D cone on the roof, pink awnings over every bay, pink bistro sets under
// them, parasol tables and an ice-cream cart on each apron.
function bIceCream(rng) {
  const wall = pk(rng, [C.pPink, C.mint, C.signWhite]);
  const accent = pk(rng, [C.pink, C.teal, C.blossomDark]);
  const s1 = accent === C.teal ? C.mint : C.pink, s2 = pk(rng, [C.comChoco, C.cream, C.mint]);
  return shop(rng, {
    floors: 1, tall: 6, wall, trim: C.signWhite, stripe: accent, band: C.comChoco, frame: C.signWhite, kick: accent, base: accent,
    awn: [accent, C.signWhite], awnStripe: 'force', awnLip: accent, name: 'SCOOPS', logo: 'cone', logoBg: C.signWhite, logoBd: accent, doorC: C.signWhite, mat: accent,
    upper: pk(rng, [C.signWhite, C.resButter, C.signWhite]), upTrim: accent, upStyle: 'grid', boxes: false, goods: [C.pink, C.mint, C.comCone, C.pYellow],
    signBg: accent, signFg: C.signWhite, signBd: C.comChoco,
    roofBlock: [[43, 22, 55, 40]], roofKit: [['ac', 'bl'], ['vent', 'br']],
    roofTerrace: [4, 16, 38, 31], roofTerraceO: { deck: C.pPink, line: C.signWhite, cols: [accent, C.signWhite], chair: accent, top: C.signWhite, parasol: false, guests: 0.5 },
    lot: (c) => apron(c, { display: 'none', cols: [accent, C.signWhite], chair: C.signWhite, top: C.pYellow, walk: C.pPink,
      cartBody: C.signWhite, cartA: accent, cartGoods: C.comCone, left: ['table'], right: ['cart'] }),
    after: (c) => coneSculpture(c.g, 49, c.ry, 31, s1, s2),
  });
}

// bPizza — a trattoria with a brick flat above (paired windows, green
// shutters), green/white awnings, a red fascia, parallel parking on one side
// of the door and checked tables on the other; a brick oven flue.
function bPizza(rng) {
  const wall = pk(rng, [C.offwhite, C.cream, C.resButter]);
  return shop(rng, {
    floors: 2, wall, stripe: C.signWhite, band: C.roofGreen, trim: C.signWhite, frame: C.roofGreen, kick: C.brick, base: C.brick,
    signBg: C.red, signFg: C.signWhite, signBd: C.signWhite,
    awn: [C.roofGreen, C.signWhite], awnStripe: 'force', awnLip: C.roofGreen, name: 'PIZZA', logo: 'pizza', logoBg: C.signWhite, logoBd: C.roofGreen, door: 'L', doorOff: 30, doorC: C.roofGreen, mat: C.red,
    upper: pk(rng, [C.brickDark, C.brickDark, C.cream]), upTrim: C.signWhite, upStyle: 'arch', boxes: false, floorO: [{ boxes: true, flowers: [C.red, C.signWhite] }], dentil: true,   // w4r4: no pediment (its back read as a red staircase)
    roofBlock: [[48, 34, 56, 42]], roofKit: [['herbs', 'fl'], ['gardenL', 'fr'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'none', cols: [C.red, C.signWhite], chair: C.roofGreen, top: C.signWhite, left: ['car'], right: ['table', 'planter'] }),
    after: (c) => {
      const { g, ry } = c;
      const zm = 38;
      g.box(50, ry - 3, zm - 2, 54, ry + 10, zm + 2, C.brick);
      g.box(49, ry + 11, zm - 3, 55, ry + 11, zm + 3, C.brickDark);
      g.box(51, ry + 12, zm - 1, 53, ry + 12, zm + 1, C.darkGray);
    },
  });
}

// 3D burger (crisp): bun, cheese, patty, lettuce, bun with sesame.
function burgerSculpture(g, x, y, z, r = 7) {
  const disc = (yy, rr, c) => { const n = Math.ceil(rr); for (let dx = -n; dx <= n; dx++) for (let dz = -n; dz <= n; dz++) if (dx * dx + dz * dz <= rr * rr + rr * 0.4) g.set(x + dx, yy, z + dz, typeof c === 'function' ? c(dx, dz) : c); };
  disc(y, r - 1, C.comDough); disc(y + 1, r, C.comDough);
  disc(y + 2, r + 0.4, C.comCheese); disc(y + 3, r, C.comPatty); disc(y + 4, r, C.comPatty);
  disc(y + 5, r + 0.6, C.comLettuce);
  disc(y + 6, r, C.comDough); disc(y + 7, r, (dx, dz) => ((dx * 3 + dz * 5) % 7 === 0 ? C.signWhite : C.comDough));
  disc(y + 8, r - 1.4, (dx, dz) => ((dx * 5 + dz * 3) % 7 === 0 ? C.signWhite : C.comDough)); disc(y + 9, r - 3, C.comDough);
}
// bBurger — ref05 "Mac Auto": a white glass box with a red band, a yellow
// stripe and burger tiles; the upper block is set back behind a terrace of
// red tables; a BURGER sign box with a 3D burger on the roof; parallel
// parking out front; the drive-thru lane with a car at the window behind.
function bBurger(rng) {
  const band = pk(rng, [C.red, C.red, C.crimson]);
  return shop(rng, {
    floors: 2, up: [1, 29, 61, 49], wall: C.signWhite, trim: C.signWhite, pier: band, stripe: C.yellow, band, frame: C.signWhite,
    kick: band, base: band, upper: C.signWhite, upTrim: band, upStyle: 'curtain', quoins: false, upAC: false, mirror: false, blade: false,
    logo: 'burger', logoBg: C.signWhite, logoBd: C.yellow, name: null, door: 'L', doorOff: 24, doorC: band, mat: band, canopy: band,
    sides: ['shop', 'shop'], sideTiles: true,
    terrace: { deck: C.sand, line: C.sandDark, cols: [band, C.signWhite], chair: band, top: C.signWhite, parasol: false },
    roofBlock: [[5, 38, 57, 47]], roofRect: [4, 29, 58, 39], roofKit: Object.assign([['ac', 'cl'], ['vents', 'c'], ['ac', 'cr'], ['vent', 'l'], ['vents', 'r']], { gap: 3 }),
    lot: (c) => {
      const { g, rng: r } = c;
      apron(c, { display: 'none', cols: [band, C.signWhite], chair: band, top: C.signWhite, left: ['car'], right: ['car'] });
      // back apron: the drive-thru lane (asphalt, yellow edge, arrows), a car
      // at the pick-up window, the lit menu board, a hedge strip on the kerb
      paint(g, 1, 50, 61, 61, C.lotAsphalt); paint(g, 1, 50, 61, 50, C.yellow);
      for (let x = 6; x < 58; x += 14) { paint(g, x, 56, x + 5, 56, C.lotLine); paint(g, x + 4, 55, x + 4, 57, C.lotLine); }
      pcar(mirrorZ(g), 30, 3, CARV[(r() * CARV.length) | 0]); pcar(mirrorZ(g), 6, 3, CARV[(r() * CARV.length) | 0]);
      g.box(53, G, 58, 53, G + 8, 58, C.comFrame); g.box(51, G + 9, 58, 57, G + 17, 59, C.comFrame); g.box(52, G + 10, 58, 56, G + 16, 58, C.winCool);
      for (let y = G + 11; y <= G + 15; y += 2) g.box(52, y, 58, 55, y, 58, C.lamp);
      const Bk = facade(g, 'back', 49);
      Bk.box(38, 8, 1, 46, 8, 3, C.yellow); Bk.box(37, 22, 1, 47, 22, 5, band); Bk.box(37, 21, 5, 47, 21, 5, C.yellow);
      person(g, r, 40, 51);
    },
    after: ({ g, topY, F, lv }) => {
      // r10: ref05 Mac Auto — a compact red box with the name and the big
      // icon standing on it. w2r1: the box carries the ONE name (slim 5-row
      // stem letters); the fascia is a plain red band with burger logo tiles
      // at the corners, like Mac Auto's 'M' tiles (DRIVE IN + BURGERS was two
      // names on one building).
      const sy = topY + 3, sz = 40, bc = 31, hw = 24;
      g.box(bc - hw, topY + 1, sz, bc + hw, sy + 10, sz + 4, band);
      g.box(bc - hw - 1, sy + 11, sz - 1, bc + hw + 1, sy + 11, sz + 5, C.signWhite);
      g.box(bc - hw, sy - 1, sz - 1, bc + hw, sy - 1, sz + 5, C.yellow);
      const so = { bg: band, fg: C.signWhite, bd: C.yellow, out: 0 };
      namePanel(facade(g, 'front', sz), bc, sy + 1, 'BURGERS', so);
      namePanel(facade(g, 'back', sz + 4), bc, sy + 1, 'BURGERS', so);
      burgerSculpture(g, bc, sy + 12, sz + 2, 7);
      for (const u of [8, 54]) logoTile(F, u, lv.STR, LOGO.burger, C.signWhite, C.yellow, 2);
    },
  });
}

// bCafe — a 3-storey corner café: sash windows with flower boxes above a
// dark shopfront, bistro sets under every awning, parasol terraces filling
// both aprons.
function bCafe(rng) {
  const wall = pk(rng, [C.mint, C.resSage, C.cream]);
  const accent = pk(rng, [C.teal, C.roofGreen, C.navy]);
  return shop(rng, {
    floors: 1, tall: 6, wall, stripe: C.cream, band: accent, nameFg: C.signWhite, frame: C.comFrame, kick: C.comFrame, base: C.comFrame,
    signBg: C.comFrame, signFg: C.signWhite, signBd: C.cream,
    awn: [accent], awnLip: C.cream, name: 'CAFE', logo: 'cup', logoBg: C.cream, logoBd: accent, doorC: accent, mat: accent,
    upper: pk(rng, [C.cream, C.signWhite, C.resButter]), upTrim: C.signWhite, upStyles: ['big', 'sash'], boxes: false, floorO: [{ winAwn: [accent] }, { boxes: true }], flowers: [C.pink, C.signWhite], lintel: C.signWhite, oriel: 9, goods: [C.comDough, C.comIcing, C.comChoco],
    // w4r3: a low glass café with a Mac Auto roof terrace (tiled deck, parasol
    // tables, a glass rail on the parapet) over the front half, plant behind
    roofTerrace: [3, 15, 59, 31], roofTerraceO: { deck: C.sand, line: C.sandDark, cols: [accent, C.signWhite], chair: C.wood, top: C.signWhite, parasol: false, guests: 0.4 },
    roofKit: [['ac', 'bl'], ['vent', 'br']],
    lot: (c) => apron(c, { display: 'none', cols: [accent, C.cream], chair: accent, left: ['table', 'tree'], right: ['bistro', 'bikes'] }),
    after: ({ g, x0, x1, z0, lv }) => glassRail(g, x0, z0, x1, 32, lv.TOP + 4),
  });
}

// ABC blocks sculpture (crisp cubes with letters on the faces).
function abcBlocks(g, x, y, z) {
  const cube = (bx, by, bz, c, ch) => {
    g.box(bx, by, bz, bx + 8, by + 8, bz + 8, c);
    g.walls(bx, by, bz, bx + 8, by, bz + 8, C.signWhite); g.walls(bx, by + 8, bz, bx + 8, by + 8, bz + 8, C.signWhite);
    for (const f of [facade(g, 'front', bz), facade(g, 'right', bx + 8), facade(g, 'left', bx), facade(g, 'back', bz + 8)]) {
      const cu = f.side === 'front' || f.side === 'back' ? bx + 4 : bz + 4;
      text(f, cu, by + 2, ch, C.signWhite, 0, false);
    }
  };
  cube(x, y, z, C.red, 'A'); cube(x + 10, y, z + 1, C.blue, 'B'); cube(x + 5, y + 9, z, C.yellow, 'C');
}
// bToyStore — a tall display storey under rainbow awnings with a flat above,
// TOYS on a blue fascia, toy piles under the awnings, balloons, a kiddie
// ride and bikes on the aprons, ABC blocks on the roof.
function bToyStore(rng) {
  const wall = pk(rng, [C.pYellow, C.pBlue, C.signWhite]);
  return shop(rng, {
    tall: 8, floors: 1, wall, stripe: C.red, band: C.blue, nameFg: C.yellow, signBg: C.red, signFg: C.signWhite, signBd: C.yellow, trim: C.signWhite, frame: C.blue, kick: C.red, base: C.red, pier: C.red,
    awn: [C.red, C.yellow, C.blue], awnCycle: true, name: 'TOYS', logo: 'blocks', logoBg: C.signWhite, logoBd: C.red, doorC: C.red, mat: C.yellow,
    upper: pk(rng, [C.signWhite, C.signWhite, C.resButter]), upTrim: C.red, upStyle: 'mix', goods: [C.red, C.yellow, C.blue, C.roofGreen],
    roofBlock: [[34, 18, 57, 32]], roofKit: [['play', 'fl'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'none', left: ['balloons', 'pots'], right: ['ride', 'bench'], flowers: [C.red, C.yellow, C.blue] }),
    after: (c) => abcBlocks(c.g, 37, c.ry, 20),
  });
}

// bPetShop — a brown-and-cream shop with a flat above, pet-food crates under
// the awnings, a little fenced dog pen with a doghouse and dogs on each apron.
function bPetShop(rng) {
  const wall = pk(rng, [C.pBlue, C.mint, C.cream]);
  return shop(rng, {
    floors: 1, tall: 6, wall, stripe: C.comDough, band: C.roofBrown, nameFg: C.signWhite, frame: C.roofBrown, kick: C.roofBrown, base: C.roofBrown,
    signBg: C.orange, signFg: C.signWhite, signBd: C.cream,
    awn: [C.comDough], awnLip: C.roofBrown, name: 'PETS', logo: 'paw', logoBg: C.cream, logoBd: C.comDough, door: 'R', doorOff: 8, doorC: C.roofBrown, mat: C.comDough,
    upper: pk(rng, [C.brickDark, C.cream, C.resSage]), upTrim: C.cream, upStyle: 'shutter', shutter: C.roofBrown, boxes: false, goods: [C.comDough, C.roofBrown, C.red],
    roofKit: [['dogrun', 'fl'], ['ac', 'bl'], ['sky', 'br']],
    lot: (c) => apron(c, { display: 'none', flowers: [C.yellow, C.pink], left: ['dogpen', 'tree'], right: ['bench', 'board'] }),
  });
}

// bBookShop — a four-storey townhouse: a dark shopfront with gold frames,
// three floors of shuttered windows and flower boxes, book carts under the
// awnings, benches and shrubs on the aprons.
function bBookShop(rng) {
  const wall = pk(rng, [C.navy, C.roofGreen, C.crimson]);
  return shop(rng, {
    floors: 3, wall, stripe: C.gold, band: wall, nameFg: C.signWhite, trim: C.cream, frame: C.gold, kick: C.woodDark, base: C.woodDark, pier: C.cream,
    signBg: C.black, signFg: C.gold, signBd: C.gold,
    awn: [C.cream, wall], awnStripe: true, name: 'BOOKS', logo: 'book', logoBg: C.cream, logoBd: C.gold, doorC: C.gold, mat: C.red,
    upper: pk(rng, [C.cream, C.brickDark, C.resButter]), upTrim: C.signWhite, upFrame: wall, upStyles: ['big', 'shutter'], shutter: wall, boxes: true, flowers: [C.vegPetalR, C.signWhite], lintel: C.signWhite, oriel: 8, dentil: true, goods: [C.red, C.navy, C.gold, C.roofGreen],
    roofKit: [['gardenL', 'fl'], ['tank', 'br'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'books', dispBays: [0], left: ['bench', 'board'], right: ['tree', 'shrub'] }),
  });
}

// bFlowerShop — a white shop with French balconies full of flowers, tiered
// flower buckets under the awnings, a flower stall and planters on each
// apron, and a glass conservatory on the roof.
function bFlowerShop(rng) {
  const wall = pk(rng, [C.signWhite, C.pPink, C.mint]);
  const petal = pk(rng, [C.pink, C.vegPetalR, C.purple]);
  return shop(rng, {
    floors: 1, tall: 4, wall, stripe: C.pink, band: C.roofGreen, frame: C.roofGreen, kick: C.roofGreen, base: C.roofGreen,
    signBg: C.pink, signFg: C.signWhite, signBd: C.roofGreen,
    awn: [C.pink], awnLip: C.signWhite, name: 'ROSES', logo: 'flower', logoBg: C.signWhite, logoBd: C.pink, door: 'L', doorOff: 8, doorC: C.roofGreen, mat: C.pink,
    upper: pk(rng, [C.signWhite, C.resSage, C.cream]), upTrim: C.roofGreen, upStyle: 'balc', rail: C.roofGreen, boxes: true, flowers: [petal, C.yellow, C.signWhite], goods: [petal, C.yellow, C.vegBush],
    roofBlock: [[22, 16, 60, 46]], roofKit: Object.assign([['ac', 'bl'], ['ac', 'fl'], ['vent', 'l']], { gap: 2 }),
    lot: (c) => apron(c, { display: 'flowers', dispBays: [0], flowers: [petal, C.yellow, C.vegPetalR, C.signWhite, C.purple], stall: C.pink,
      left: [], right: ['stall', 'board', 'tree'] }),
    after: (c) => {
      const { g, ry } = c;
      const gx0 = 27, gx1 = 55, gz0 = 18, gz1 = 44, gy = ry + 12;
      for (let y = ry; y <= gy; y++) for (let x = gx0; x <= gx1; x++) for (let z = gz0; z <= gz1; z++) {
        if (x !== gx0 && x !== gx1 && z !== gz0 && z !== gz1) continue;
        const post = ((x - gx0) % 4 === 0 || x === gx1) && (z === gz0 || z === gz1) || ((z - gz0) % 4 === 0 || z === gz1) && (x === gx0 || x === gx1) || y === ry || y === gy;
        g.set(x, y, z, post ? C.signWhite : C.winCool);
      }
      for (let k = 0; k <= 6; k++) g.box(gx0 + k, gy + 1 + k, gz0, gx1 - k, gy + 1 + k, gz1, k === 6 ? C.signWhite : C.winCool);
      for (let z = gz0; z <= gz1; z += 4) for (let k = 0; k <= 6; k++) { g.set(gx0 + k, gy + 1 + k, z, C.signWhite); g.set(gx1 - k, gy + 1 + k, z, C.signWhite); }
      for (let z = gz0 + 2; z < gz1 - 1; z += 3) for (const x of [gx0 + 2, gx1 - 2]) g.box(x, ry, z, x, ry + 3, z + 1, (z & 1) ? petal : C.vegBush);
    },
  });
}

// bGrocery — the ref05 SUPERMARKET: a long, tall, fully glazed box with a
// green band and SUPERMARKET front and back, produce crates under the awnings,
// parallel parking and fruit stalls on the aprons; a roof full of skylights,
// AC and solar; a lit cart pylon.
function bGrocery(rng) {
  const wall = pk(rng, [C.signWhite, C.cream, C.offwhite]);
  return shop(rng, {
    tall: 6, wall, stripe: C.lime, band: C.roofGreen, trim: C.signWhite, frame: C.roofGreen, kick: C.roofGreen, base: C.stoneDark,
    awn: [C.roofGreen, C.signWhite], awnStripe: true, name: 'GROCERY', logo: 'cart', logoBg: C.signWhite, logoBd: C.lime, doorC: C.roofGreen, mat: C.lime, canopy: C.roofGreen,
    signBg: C.roofGreen, signFg: C.signWhite, signBd: C.lime,
    sides: ['shop', 'shop'], bayW: 12, pierW: 2, stall: C.roofGreen, goods: [C.red, C.orange, C.lime, C.yellow],
    roofKit: [['solar', 'fl'], ['solar', 'fr'], ['sky', 'bl'], ['ac', 'br']],
    lot: (c) => apron(c, { display: 'crates', dispBays: [0], stall: C.roofGreen, left: ['car'], right: ['stall'] }),
  });
}

// ---- open-air: market square + fruit stand ----------------------------------
const PRODUCE = [[C.red, C.crimson], [C.orange, C.yellow], [C.lime, C.leafMid], [C.yellow, C.gold], [C.purple, C.pink], [C.roofGreen, C.lime], [C.vegPetalR, C.red]];
function produceBed(g, x, z, w, d, p, y = G) {
  g.box(x, y, z, x + w - 1, y + 3, z + d - 1, C.wood);
  g.box(x, y + 1, z, x + w - 1, y + 1, z + d - 1, C.woodDark);
  for (let i = 1; i < w - 1; i++) for (let k = 1; k < d - 1; k++) {
    g.set(x + i, y + 4, z + k, (i * 3 + k * 5) % 5 === 0 ? p[1] : p[0]);
    if (i > 1 && i < w - 2 && k > 1 && k < d - 2 && ((i + k) & 1)) g.set(x + i, y + 5, z + k, p[0]);
  }
  g.box(x, y + 4, z, x + w - 1, y + 4, z, C.wood);
  g.set(x + 1, y + 5, z, C.signWhite);
}
// striped canopy stall: posts, counters front AND back with produce, a
// stripy two-step roof (reads from either iso side)
function stall(g, x0, z0, x1, z1, cA, goods) {
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.box(x, G, z, x, G + 16, z, C.woodDark);
  for (const [za, zb] of [[z0, z0 + 3], [z1 - 3, z1]]) {
    g.box(x0 + 1, G, za, x1 - 1, G + 5, zb, C.wood); g.box(x0 + 1, G + 5, za, x1 - 1, G + 5, zb, C.plank);
    for (let x = x0 + 1; x < x1; x++) for (let z = za; z <= zb; z++) if ((x + z) % 2) g.set(x, G + 6, z, goods[((x - x0) >> 1) % goods.length][(z & 1)]);
  }
  for (let k = 0; k < 3; k++) for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1 + k * 2; z <= z1 + 1 - k * 2; z++)
    g.set(x, G + 17 + k, z, ((x - x0 + 1) >> 1) & 1 ? C.signWhite : cA);
  for (let x = x0 - 1; x <= x1 + 1; x++) if ((((x - x0 + 1) >> 1) & 1) === 0) { g.set(x, G + 16, z0 - 1, cA); g.set(x, G + 16, z1 + 1, cA); }
}
// bMarketStall — ref05's market square: paving grid packed with produce beds,
// striped stalls down the middle, small parasols, crates, barrels, shoppers.
function bMarketStall(rng) {
  const cols = [pk(rng, [C.red, C.roofGreen, C.orange]), pk(rng, [C.teal, C.blue, C.red])];
  const g = grid(63, 40, 63);
  lot(g, 62, 62);
  paveGrid(g, 1, 1, 61, 61, C.lotPaveDark, 6);
  for (const k of [21, 41]) { paint(g, k - 1, 1, k, 61, C.lotRim); paint(g, 1, k - 1, 61, k, C.lotRim); }
  let i = (rng() * 7) | 0;
  for (const [x0, x1, cc] of [[3, 17, cols[0]], [24, 38, cols[1]], [45, 59, cols[0]]]) stall(g, x0, 24, x1, 38, cc, [PRODUCE[i++ % 7], PRODUCE[i++ % 7], PRODUCE[i++ % 7]]);
  for (const cz of [3, 44]) for (const cx of [3, 24, 45]) {
    produceBed(g, cx, cz, 14, 6, PRODUCE[i++ % 7]);
    produceBed(g, cx, cz + 9, 14, 6, PRODUCE[i++ % 7]);
    if (((cx + cz) >> 2) % 3 !== 1) { g.box(cx + 7, G, cz + 7, cx + 7, G + 13, cz + 7, C.signWhite); parasolTop(g, cx + 7, G + 14, cz + 7, 6, cols[(cx >> 3) & 1], C.signWhite); }
    else { crate(g, cx + 2, cz + 7, 3, 1, C.orange, null); crate(g, cx + 9, cz + 7, 3, 1, C.lime, null); crate(g, cx + 9, cz + 7, 3, 1, C.red, null, G + 4); }
  }
  for (const [x, z, c] of [[20, 5, C.red], [40, 14, C.yellow], [20, 46, C.lime], [42, 56, C.orange], [1, 22, C.purple], [59, 40, C.red]]) crate(g, x, z, 2, 3, c, null);
  for (const [x, z] of [[21, 42], [42, 20]]) { g.box(x - 1, G, z - 1, x + 1, G + 5, z + 1, C.woodDark); g.box(x - 1, G + 2, z - 1, x + 1, G + 2, z + 1, C.stoneDark); g.box(x - 1, G + 6, z - 1, x + 1, G + 6, z + 1, C.red); }
  for (const [x, z] of [[19, 11], [40, 8], [21, 26], [11, 21], [50, 21], [30, 42], [19, 52], [42, 50], [8, 41], [55, 41], [30, 20], [1, 9], [60, 12], [11, 60], [52, 60], [30, 60], [9, 30], [33, 31]]) person(g, rng, x, z);
  lamp(g, 1, 1, 24, 1); lamp(g, 61, 61, 24, -1); lamp(g, 61, 1, 24, -1); lamp(g, 1, 61, 24, 1);
  return g.done();
}
// bFruitStand — a big striped stand with produce tiers rising to the middle
// from both sides, a FRUIT sign board with an apple on top, melon carts and
// crates on both aprons.
function bFruitStand(rng) {
  const cA = pk(rng, [C.red, C.roofGreen, C.orange]);
  const g = grid(63, 64, 63);
  lot(g, 62, 62);
  paveGrid(g, 1, 1, 61, 61);
  const x0 = 8, x1 = 54, z0 = 14, z1 = 48;
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.box(x, G, z, x, G + 26, z, C.wood);
  for (let t = 0; t < 3; t++) for (const side of [0, 1]) {
    const zs = side === 0 ? z0 + 2 + t * 5 : z1 - 6 - t * 5, top = G + 2 + t * 5;
    g.box(x0 + 1, G, zs, x1 - 1, top, zs + 4, C.woodDark);
    for (let k = 0; k < 6; k++) {
      const p = PRODUCE[(k + t * 2 + side * 3) % 7], cx = x0 + 2 + k * 7;
      g.box(cx, top + 1, zs, cx + 5, top + 1, zs + 4, p[0]);
      for (let a = 0; a < 6; a++) for (let b = 0; b < 5; b++) if ((a + b) % 2 === 0) g.set(cx + a, top + 2, zs + b, (a * 3 + b) % 5 === 0 ? p[1] : p[0]);
      g.set(cx, top + 2, side === 0 ? zs : zs + 4, C.signWhite);
    }
  }
  for (const z of [z0, z1]) g.box(x0, G, z, x1, G + 3, z, C.wood);
  for (let k = 0; k < 4; k++) for (let x = x0 - 2; x <= x1 + 2; x++) for (let z = z0 - 2 + k * 3; z <= z1 + 2 - k * 3; z++)
    g.set(x, G + 27 + k, z, ((x - x0) >> 2) & 1 ? C.signWhite : cA);
  for (let x = x0 - 2; x <= x1 + 2; x++) if (!(((x - x0) >> 2) & 1)) { g.box(x, G + 25, z0 - 2, x, G + 26, z0 - 2, cA); g.box(x, G + 25, z1 + 2, x, G + 26, z1 + 2, cA); }
  const top = G + 31, bz = 30;
  for (const x of [16, 46]) g.box(x, top, bz, x, top + 4, bz + 1, C.woodDark);
  g.box(12, top + 5, bz, 50, top + 17, bz + 1, C.woodDark); g.box(13, top + 6, bz, 49, top + 16, bz + 1, C.cream);
  for (const f of [facade(g, 'front', bz), facade(g, 'back', bz + 1)]) {
    text(f, f.rd > 0 ? 26 : 36, top + 8, 'FRUIT', C.red, 0, true);
    logoTile(f, f.rd > 0 ? 43 : 19, top + 7, LOGO.apple, C.cream, C.cream, 0);
  }
  for (const M of [g, mirrorZ(g)]) {
    M.box(4, G + 2, 2, 20, G + 6, 8, C.wood);
    for (const x of [5, 19]) { M.box(x, G, 2, x, G + 1, 2, C.black); M.box(x, G, 8, x, G + 1, 8, C.black); }
    for (let x = 6; x <= 18; x += 4) M.box(x, G + 7, 3, x + 2, G + 9, 7, C.roofGreen);
    crate(M, 36, 3, 5, 5, C.red, C.crimson); crate(M, 43, 3, 5, 5, C.yellow, C.gold); crate(M, 39, 3, 5, 5, C.orange, C.yellow, G + 4);
    aboard(M, 26, 4);
    for (const [x, z] of [[24, 10], [32, 9], [50, 10], [12, 11]]) person(M, rng, x, z);
    lamp(M, 1, 1, 24, 1);
  }
  hedge(g, 1, 20, 4, 42, 4); hedge(g, 58, 20, 61, 42, 4); tree(g, 3, 31, 'round', 1); tree(g, 59, 31, 'round', 2);
  return g.done();
}

// bArcade — a tall dark box with neon trim and a ribbon-glass games floor
// above, a marquee of bulbs, ARCADE in neon; parking and bikes on the aprons.
function bArcade(rng) {
  const wall = pk(rng, [C.navy, C.roofPurple, C.darkGray]);
  return shop(rng, {
    tall: 8, floors: 1, wall, trim: C.purple, frame: C.black, stripe: C.neon, band: C.black, nameFg: C.neon, pier: C.purple, kick: C.purple, base: C.black,
    awn: null, name: 'ARCADE', logo: 'joy', logoBg: C.signWhite, logoBd: C.neon, doorC: C.neon, mat: C.purple, canopy: C.purple,
    upper: wall, upTrim: C.purple, upFrame: C.neon, upStyle: 'ribbon', parapet: wall, coping: C.neon, quoins: false, signBg: C.black, signFg: C.neon, signBd: C.purple,
    roofKit: [['frame', 'fl'], ['solar', 'fr'], ['dish', 'bl'], ['ac', 'br']],
    lot: (c) => apron(c, { display: 'none', walk: C.lotPaveDark, bin: C.purple, left: ['car'], right: ['bikes', 'tree'] }),
    after: ({ F, B, x0, x1, lv }) => {
      for (const f of [F, B]) for (let u = x0 + 3; u <= x1 - 3; u += 3) f.set(u, lv.GY1 + 2, 1, C.lamp);
    },
  });
}

// bCandyShop — a candy-pink shop with a striped-awning flat above, giant
// lollipops, a candy-floss cart and pink parasol tables on the aprons.
function bCandyShop(rng) {
  const wall = pk(rng, [C.pPink, C.mint, C.signWhite]);
  const a = pk(rng, [C.red, C.blossomDark, C.teal]);
  return shop(rng, {
    floors: 1, tall: 6, wall, stripe: C.pink, band: a, frame: C.signWhite, kick: C.pink, base: a,
    signBg: a, signFg: C.signWhite, signBd: C.pink,
    awn: [a, C.signWhite], awnStripe: 'force', awnLip: a, name: 'CANDY', logo: 'lolly', logoBg: C.signWhite, logoBd: C.pink, doorC: a, mat: C.pink,
    upper: pk(rng, [C.signWhite, C.resButter, C.signWhite]), upTrim: C.pink, upStyle: 'mix', winAwn: [a], boxes: false, gable: 'step', goods: [C.pink, C.red, C.mint, C.yellow],
    roofKit: [['garden', 'fl'], ['frame', 'fr'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'bistro', cols: [C.pink, C.signWhite], chair: C.signWhite, walk: C.pPink, cartBody: C.signWhite, cartA: C.pink, cartGoods: C.blossom, lolly: a,
      display: 'none', left: ['lolly', 'pots'], right: ['cart'] }),
  });
}

// bMusicStore — a purple shop with a ribbon-glass studio and a flat above, a
// busker's pitch, benches and bikes on the aprons.
function bMusicStore(rng) {
  const wall = pk(rng, [C.roofPurple, C.navy, C.roofBlue]);
  const a = pk(rng, [C.gold, C.pink, C.orange]);
  return shop(rng, {
    floors: 2, tall: 2, wall, stripe: a, band: C.black, nameFg: a, frame: C.black, kick: a, base: C.black, trim: C.signWhite,
    awn: [a], awnLip: C.black, name: 'MUSIC', logo: 'note', logoBg: C.signWhite, logoBd: a, doorC: C.black, mat: a,
    upper: pk(rng, [C.brickDark, C.cream, C.signWhite]), upTrim: C.signWhite, upFrame: C.comFrame, upStyles: ['ribbon', 'pair'], planters: true, flowers: [a, C.pink], boxes: false, signBg: C.comFrame, signFg: a, signBd: a === C.gold ? C.signWhite : C.gold, goods: [a, C.comFrame],
    roofKit: [['solar', 'fl'], ['frame', 'fr'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'none', left: ['busker', 'board'], right: ['bikes', 'tree'] }),
  });
}

// bSportsShop — a shop with a paired-window flat above, balls and kit under
// the awnings, a basketball hoop pitch and bikes on each apron.
function bSportsShop(rng) {
  const wall = pk(rng, [C.signWhite, C.pGreen, C.pBlue]);
  const a = pk(rng, [C.orange, C.red, C.navy]);
  const bnd = a === C.navy ? C.red : C.navy;
  return shop(rng, {
    floors: 1, tall: 6, wall, stripe: a, band: bnd, frame: bnd, kick: a, base: bnd,
    signBg: bnd, signFg: C.signWhite, signBd: a,
    awn: [a, C.signWhite], awnStripe: true, name: 'SPORTS', logo: 'ball', logoBg: C.signWhite, logoBd: a, door: 'R', doorOff: 8, doorC: bnd, mat: a,
    upper: pk(rng, [C.signWhite, C.cream, C.brickDark]), upTrim: bnd, upStyle: 'mix', goods: [C.orange, C.signWhite, C.blue],
    roofKit: [['court', 'fl'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'none', left: ['hoop', 'board'], right: ['bikes', 'tree'] }),
  });
}

// bBarber — a small shop with a flat above, door LEFT; the animated pole
// (catalogAnim) stands on the paving left of the front door (no awning over
// it); waiting benches under the awnings, bikes and planters.
const BARBER = { body: [1, 13, 61, 49], doorOff: 11 };
function bBarber(rng) {
  const wall = pk(rng, [C.signWhite, C.pBlue, C.cream]);
  const du = BARBER.body[0] + BARBER.doorOff;
  return shop(rng, {
    body: BARBER.body, floors: 1, wall, stripe: C.red, band: C.navy, frame: C.navy, kick: C.red, base: C.navy,
    signBg: C.navy, signFg: C.signWhite, signBd: C.red,
    awn: [C.red, C.signWhite, C.blue, C.signWhite], awnStripe: true, name: 'BARBER', logo: 'scissor', logoBg: C.signWhite, logoBd: C.red,
    door: 'L', doorOff: BARBER.doorOff, doorC: C.navy, mat: C.red, noAwn: [du - 9, du - 1],
    upper: pk(rng, [C.brickDark, C.cream, C.resSage]), upTrim: C.signWhite, upStyle: 'shutter', shutter: C.navy, boxes: false, gable: 'pediment', dentil: true,
    roofKit: [['garden', 'fl'], ['solar2', 'fr'], ['ac', 'bl']],
    lot: (c) => apron(c, { display: 'none', dispFrom: c.back ? 0 : du, left: [], right: ['bench', 'tree', 'planter'] }),
    after: (c) => {
      const { g, z0 } = c;
      g.box(du - 5, 29, z0 - 1, du - 5, 29, z0 - 5, C.comFrame);        // bracket over the pole top
    },
  });
}

// ---- diner (1×1): ref05 "Mac Auto" as a 50s diner — a white glass box with a
// red band and yellow pin-stripes; r10: a SMALL lit DINER board over the door
// (the r9 critic: "FRIES/EAT lettering is crude next to ref02's small backlit
// SHOP sign"), a compact red roof box with small lettering under a big 3D gold
// star (the Mac Auto 'M'), a roof patio; nose-in parking with a zebra walk in
// front, a parasol terrace with planters down the side, a drive-thru lane
// with a menu board behind, a pole sign by the road.
const STAR = ['.....#.....', '....###....', '....###....', '###########', '.#########.', '..#######..', '...#####...', '..###.###..', '..##...##..', '.##.....##.', '.#.......#.'];
function star3d(g, cx, y, z, c, d = 2) {
  for (let r = 0; r < 11; r++) for (let i = 0; i < 11; i++) if (STAR[r][i] === '#') g.box(cx - 5 + i, y + 10 - r, z, cx - 5 + i, y + 10 - r, z + d, c);
}
// w4r1: a 3D milkshake (the r10 star read as a little running figure at iso
// angles): white foot + stem, a flared striped cup, a cream dome, a cherry and
// a red-white straw. Square cross-section, centred on (cx, cz); ~19 tall.
// w4r4: a crisp SODA CUP (the w4r3 critic read the milkshake's white cream
// dome as a grey "smoke blob ... rock pile"): a tapered red cup with a white
// band, a flat lid and a tall striped straw — no round blobs
function shake3d(g, cx, y, cz, cup = C.red, stripe = C.signWhite) {
  g.box(cx - 3, y, cz - 3, cx + 3, y, cz + 3, C.comFrame);
  for (let k = 0; k < 13; k++) {
    const h = 3 + Math.floor(k / 5), yy = y + 1 + k;
    g.box(cx - h, yy, cz - h, cx + h, yy, cz + h, k >= 5 && k <= 8 ? stripe : cup);
  }
  g.box(cx - 6, y + 14, cz - 6, cx + 6, y + 14, cz + 6, C.signWhite);
  g.box(cx - 5, y + 15, cz - 5, cx + 5, y + 15, cz + 5, C.signWhite);
  for (let k = 0; k < 9; k++) g.box(cx + 1, y + 16 + k, cz, cx + 2, y + 16 + k, cz + 1, (k >> 1) % 2 ? C.signWhite : C.red);
  g.box(cx + 3, y + 24, cz, cx + 4, y + 24, cz + 1, C.red);
}
function bDiner(rng) {
  const band = pk(rng, [C.red, C.red, C.teal]);
  const accent = band === C.red ? C.yellow : C.signWhite;
  return shop(rng, {
    body: [13, 19, 49, 43], tall: 6, wall: C.signWhite, trim: C.signWhite, stripe: accent, band, frame: C.comFrame, pier: C.signWhite, kick: band, base: band,
    awn: [band, C.signWhite], awnStripe: 'force', awnLip: band, awnD: 3, bayW: 12, pierW: 2, name: null, logo: 'star', logoBg: C.signWhite, logoBd: accent,
    door: 'R', doorOff: 6, doorC: band, mat: band, doorAwn: true, signBg: band, signFg: C.signWhite, signBd: accent === C.yellow ? C.yellow : C.comFrame, signLamps: true,
    goods: [C.comCheese, C.red, C.comDough], mirror: false, crowd: 0,
    coping: band, roofBlock: [[14, 28, 48, 34]], roofRect: [15, 35, 47, 41], roofKit: [['ac', 'cl'], ['vents', 'cr']],
    roofTerrace: [16, 21, 46, 26], roofTerraceO: { cols: [band, C.signWhite], chair: band, top: C.signWhite, deck: C.sand, line: C.sandDark, parasol: false, pots: false },
    lot: (c) => {
      const { g, rng: r, z0 } = c;
      parking(g, r, 13, 1, 50, z0 - 3, { walk: 2, fill: 0.9 });
      // kerb planters between the bays and the building
      for (const x of [20, 31]) planter(g, x - 3, z0 - 2, x + 3, z0 - 1, [C.pink, C.yellow]);
    },
    after: (c) => {
      const { g, rng: r, ry, topY, z0, z1, x0, x1 } = c;
      // side terrace: tiles, tables with alternating parasols, planter edges
      // r10: the iso snap shows either flank, so BOTH get a parasol terrace
      // w2r1: two plain red table sets per flank (Mac Auto's lot is calm:
      // parking, a few red tables, clean paving), a planter at each end
      for (const [tx0, tx1, px] of [[1, 10, 11], [52, 61, 50]]) {
        paint(g, tx0, 20, tx1, 42, C.lotPave);
        for (const z of [25, 37]) tableSet(g, (tx0 + tx1) >> 1, z, G, { par: false, top: C.signWhite, chair: band });
        for (const z of [12, 50]) planter(g, tx0 + 1, z - 3, tx1 - 1, z + 3, [C.pink, C.yellow, C.signWhite]);
        void px;
      }
      g.walls(x0 - 1, G + 2, z0 - 1, x1 + 1, G + 2, z1 + 1, accent);
      lamp(g, 11, 60, 26, 1); lamp(g, 51, 60, 26, -1);
      // (w2r1: the r10 OPEN pole sign is gone — one name per building)
      // Mac Auto 'M' tiles: star logo tiles at the fascia corners
      const lv = c.lv;
      for (const [f, us] of [[c.F, [x0 + 7, x1 - 7]], [c.B, [x0 + 7, x1 - 7]]]) for (const u of us) logoTile(f, u, lv.STR, LOGO.burger, C.signWhite, accent, 2);
      // back: a drive-thru lane with arrows, the menu board, a car at the
      // window, a planter strip along the building
      const zb = z1 + 2;
      paint(g, 11, zb + 3, 51, 61, C.lotAsphalt); paint(g, 11, zb + 3, 51, zb + 3, C.yellow);
      for (let x = 16; x < 46; x += 14) { paint(g, x, 55, x + 5, 55, C.lotLine); paint(g, x + 4, 54, x + 4, 56, C.lotLine); }
      for (const x of [20, 42]) planter(g, x - 4, zb, x + 4, zb + 1, [C.red, C.yellow]);
      pcar(g, 22, 51, CARV[(r() * CARV.length) | 0]);
      g.box(47, G, 60, 47, G + 8, 60, C.comFrame); g.box(44, G + 9, 60, 51, G + 17, 61, C.comFrame); g.box(45, G + 10, 60, 50, G + 16, 61, C.winCool); g.box(44, G + 9, 60, 51, G + 9, 61, C.comFrame);
      for (let y = G + 11; y <= G + 15; y += 2) g.box(46, y, 60, 49, y, 61, C.lamp);
      for (const [x, z] of [[38, 3], [56, 30]]) person(g, r, x, z);
      // roof: the ONE name — a red box with the slim DINER panel + a big 3D
      // gold star standing on it (Mac Auto's roof sign + 'M')
      const sy = ry + 1, zs = 29, bx0 = 13, bx1 = 49, bc = 31;
      g.box(bx0, ry, zs, bx1, sy + 10, zs + 4, band);
      g.box(bx0 - 1, sy + 11, zs - 1, bx1 + 1, sy + 11, zs + 5, C.signWhite);
      g.box(bx0, sy - 1, zs - 1, bx1, sy - 1, zs + 5, accent);
      const so = { bg: band, fg: C.signWhite, bd: accent, out: 0 };
      namePanel(facade(g, 'front', zs), bc, sy + 1, 'DINER', so);
      namePanel(facade(g, 'back', zs + 4), bc, sy + 1, 'DINER', so);
      shake3d(g, bc, sy + 12, zs + 2, C.red, C.signWhite);
      void topY;
    },
  });
}
// ---- cinema (2×1) ------------------------------------------------------------
// A tall box with a glass entrance hall, a marquee of bulbs over the doors,
// CINEMA in big letters on a fascia, poster lightboxes, a ticket booth, a red
// carpet plaza with stanchions, a popcorn cart; ribs down the blank flanks;
// a roof with AC units, a duct and a clapper tile.
function bCinema(rng) {
  const wall = pk(rng, [C.crimson, C.navy, C.roofPurple]);
  const accent = wall === C.navy ? C.red : C.gold;
  const g = grid(127, 120, 63);
  lot(g, 126, 62);
  paveGrid(g, 1, 1, 125, 61);
  // r7: body centred in z so BOTH long faces are entrance fronts (the iso
  // snap shows either); each apron is a 15-deep red-carpet plaza.
  const x0 = 8, x1 = 118, z0 = 16, z1 = 46, H = 76;
  g.walls(x0, G, z0, x1, H, z1, wall);
  g.walls(x0, G, z0, x1, G + 1, z1, C.comFrame);
  g.box(x0 + 1, H, z0 + 1, x1 - 1, H, z1 - 1, C.comRoof);
  g.walls(x0 - 2, H, z0 - 2, x1 + 2, H, z1 + 2, C.signWhite);
  g.walls(x0, H + 1, z0, x1, H + 2, z1, wall); g.walls(x0, H + 3, z0, x1, H + 3, z1, C.signWhite);
  // belt courses + pilasters break the big wall into panels
  for (const y of [44, 54, 74]) g.walls(x0 - 1, y, z0 - 1, x1 + 1, y, z1 + 1, C.signWhite);
  const F = facade(g, 'front', z0), B = facade(g, 'back', z1), Lf = facade(g, 'left', x0), Rf = facade(g, 'right', x1);
  const bo = { frame: C.gold, kick: C.comFrame };
  const posters = [[C.blue, C.yellow], [C.purple, C.pink], [C.roofGreen, C.yellow], [C.red, C.signWhite]];
  for (const f of [F, B]) {
    for (const u of [12, 24, 94, 106]) f.box(u - 2, G + 2, 1, u - 2, 73, 1, C.signWhite);   // pilasters
    for (const [a, b2] of splitBays(36, 90, 8, 2)) bay(f, a, b2, 6, 40, { ...bo, transom: true });
    for (const d of [45, 59, 73]) glassDoor(f, d, 21, { frame: C.gold, doorC: C.comFrame, mat: C.red });
    // marquee: a deep canopy with bulbs and NOW SHOWING
    f.box(34, 42, 1, 92, 43, 10, accent);
    f.box(34, 45, 10, 92, 52, 11, C.signWhite); f.box(35, 46, 11, 91, 51, 11, C.comFrame);
    for (let u = 34; u <= 92; u += 2) { f.set(u, 44, 12, C.lamp); f.set(u, 53, 12, C.lamp); }
    text(f, 63, 47, 'NOW SHOWING', C.lamp, 11, false);
    f.box(35, 41, 1, 91, 41, 9, C.lamp);
    // r10: a compact lit CINEMA board (5×7, 1-voxel strokes, flush) in place
    // of the r9 79×17 fascia of double-size letters; windows either side
    const cw = textW('CINEMA', true) + 8, c0 = 63 - (cw >> 1), c1 = c0 + cw - 1;
    f.box(c0, 57, 1, c1, 67, 2, accent);
    f.box(c0 + 1, 58, 2, c1 - 1, 66, 2, C.comFrame);
    text(f, 63, 59, 'CINEMA', C.lamp, 2, true);
    for (let u = c0 + 1; u <= c1 - 1; u += 3) { f.set(u, 68, 2, C.lamp); f.set(u, 56, 2, C.lamp); }
    for (const u of [32, 88]) upWin(f, u, 58, 6, 11, { frame: C.signWhite, sill: C.signWhite });
    // poster lightboxes + upper windows left and right of the hall
    [[12, 0], [22, 1], [96, 2], [106, 3]].forEach(([u, k]) => {
      f.box(u - 1, 8, 1, u + 8, 34, 1, C.gold);
      f.box(u, 9, 2, u + 7, 33, 2, posters[k][0]);
      f.box(u, 28, 2, u + 7, 31, 2, C.signWhite);
      f.box(u + 2, 13, 2, u + 5, 22, 2, posters[k][1]); f.box(u + 1, 16, 2, u + 6, 18, 2, posters[k][1]);
      upWin(f, u + 1, 58, 6, 11, { frame: C.signWhite, sill: C.signWhite });
    });
  }
  // flanks: ribs, exit doors, a vertical blade sign on the left, a fire ladder
  for (const f of [Lf, Rf]) {
    for (let u = z0 + 4; u <= z1 - 4; u += 6) f.box(u, G + 2, 1, u, H - 4, 1, C.signWhite);
    serviceDoor(f, z1 - 12, { hood: accent });
    for (const y of [48, 60]) for (let u = z0 + 6; u + 3 <= z1 - 6; u += 6) upWin(f, u, y, 3, 7, { frame: C.signWhite, sill: C.signWhite });
  }
  Lf.box(z0 + 2, 28, 1, z0 + 2, 74, 1, C.comFrame);
  Lf.box(z0 + 2, 30, 2, z0 + 2, 72, 9, C.signWhite); Lf.box(z0 + 2, 31, 3, z0 + 2, 71, 8, C.red);
  for (let y = 32; y <= 70; y += 4) Lf.set(z0 + 2, y, 10, C.lamp);
  for (let y = G + 10; y <= H + 2; y += 3) Rf.box(z0 + 6, y, 1, z0 + 9, y, 1, C.comFrame);
  Rf.box(z0 + 6, G + 10, 2, z0 + 6, H + 2, 2, C.comFrame); Rf.box(z0 + 9, G + 10, 2, z0 + 9, H + 2, 2, C.comFrame);
  // plazas (front, then the back through mirrorZ): red carpet, stanchions,
  // a ticket booth, a popcorn cart, planters, a queue, lamps
  for (const M of [g, mirrorZ(g)]) {
    paint(M, 40, 1, 86, z0 - 1, C.comTerra); paint(M, 50, 1, 76, z0 - 1, C.red);
    for (const xs of [42, 84]) for (let z = 2; z <= 13; z++) { if ((z - 2) % 4 === 0) M.box(xs, G, z, xs, G + 5, z, C.gold); else M.set(xs, G + 4, z, C.red); }
    M.box(12, G, 3, 24, G + 16, 11, C.red); M.box(14, G + 6, 3, 22, G + 12, 3, C.winCool); M.box(11, G + 17, 2, 25, G + 18, 12, C.gold); M.box(13, G + 5, 1, 23, G + 5, 2, C.signWhite);
    M.box(100, G + 2, 4, 110, G + 11, 9, C.signWhite);
    for (let x = 100; x <= 110; x += 2) M.box(x, G + 2, 4, x, G + 11, 4, C.red);
    M.box(100, G + 12, 4, 110, G + 12, 9, C.yellow);
    for (const x of [101, 109]) { M.box(x, G, 4, x, G + 1, 4, C.black); M.box(x, G, 9, x, G + 1, 9, C.black); }
    M.box(103, G + 13, 5, 107, G + 20, 8, C.winCool); M.box(102, G + 21, 4, 108, G + 21, 9, C.red);
    for (let i = 0; i < 8; i++) person(M, rng, 55 + (i % 4) * 4, 3 + (i >> 2) * 5);
    person(M, rng, 27, 8); person(M, rng, 96, 10);
    for (const x of [32, 92]) planter(M, x - 4, 3, x + 4, 9, [C.pink, C.yellow]);
    tableSet(M, 118, 6, G, { cols: [accent, C.signWhite], chair: accent, r: 4 });
    tableSet(M, 5, 6, G, { cols: [accent, C.signWhite], chair: accent, r: 4 });
    lamp(M, 2, 13, 26, 1); lamp(M, 124, 13, 26, -1);
  }
  // side strips: benches, bins, trees
  for (const x of [2, 121]) { bench(g, x, 26, 'z', 9); bin(g, x, 38, C.roofGreen); }
  // roof
  roofRim(g, x0 + 1, z0 + 1, x1 - 1, z1 - 1, H);
  roofScape(g, rng, x0 + 3, z0 + 3, x1 - 3, z1 - 3, H + 1, ['hvac', 'solar', 'garden', 'stair', 'solar', 'hvac'], { cellD: 25 });
  return g.done();
}

// ---- mall (3×3) ----------------------------------------------------------------
// A long two-level block at the back of a big car park: a tall glazed entrance
// hall with MALL on its fascia, shop units down the whole frontage (each a
// framed bay with its own awning and name panel), trees and benches along the
// walk, loading docks on the max-X flank, a roof of skylights, AC and solar.
function bMall(rng) {
  const wall = pk(rng, [C.offwhite, C.signWhite, C.pBlue]);
  const accent = pk(rng, [C.red, C.roofGreen, C.blue]);
  const S = 191, g = grid(S, 140, S);
  lot(g, S - 1, S - 1);
  paveGrid(g, 1, 1, S - 2, S - 2, C.lotPaveDark, 16);
  // ---- car park z 4..86 --------------------------------------------------------
  paint(g, 4, 4, 186, 86, C.lotAsphalt);
  const r1 = parking(g, rng, 8, 4, 182, 24, { fill: 0.7 });
  for (let x = 10; x < 180; x += 10) paint(g, x, 44, x + 4, 44, C.yellow);
  parking(g, rng, 8, 46, 182, 66, { fill: 0.7 });
  for (let x = 12; x < 182; x += 11) g.box(x, G, 66, x + 6, G, 66, C.concrete);
  zebra(g, 88, 67, 102, 86, false);
  for (const x of [4, 186]) for (let z = 10; z <= 80; z += 35) lamp(g, x, z, 30, x < 90 ? 1 : -1);
  for (const x of [50, 140]) { g.box(x - 6, LT, 30, x + 6, LT + 1, 38, C.lotRim); hedge(g, x - 5, 31, x + 5, 37, 4); tree(g, x, 34, 'round', x); }
  // glass-roofed trolley shelters on the car-park islands + a lit MALL pylon by the road
  for (const x of [22, 168]) {
    g.box(x - 7, LT, 29, x + 7, LT, 39, C.lotRim);
    for (const [px, pz] of [[x - 6, 30], [x + 6, 30], [x - 6, 38], [x + 6, 38]]) g.box(px, G, pz, px, G + 12, pz, C.comFrame);
    g.box(x - 7, G + 13, 29, x + 7, G + 13, 39, C.winCool); g.walls(x - 7, G + 13, 29, x + 7, G + 13, 39, C.comFrame);
    for (let k = 0; k < 4; k++) g.box(x - 5 + k * 3, G + 1, 32, x - 4 + k * 3, G + 4, 36, C.red);
  }
  {
    const px = 95, pz = 30;
    g.box(px - 1, G, pz, px + 1, G + 30, pz + 2, C.comFrame);
    g.box(px - 12, G + 31, pz - 1, px + 12, G + 48, pz + 3, accent);
    g.box(px - 11, G + 32, pz - 1, px + 11, G + 47, pz + 3, C.winCool);
    g.box(px - 11, G + 36, pz - 1, px + 11, G + 45, pz + 3, accent);
    for (const f of [facade(g, 'front', pz - 1), facade(g, 'back', pz + 3)]) text(f, px, G + 37, 'MALL', C.signWhite, 0, true);
  }
  void r1;
  // walk in front of the building z 88..100
  paint(g, 2, 88, 188, 100, C.lotPave);
  for (let x = 14; x < 180; x += 34) { planter(g, x - 5, 91, x + 5, 97, [C.pink, C.yellow]); }
  for (let x = 30; x < 170; x += 34) bench(g, x - 4, 93, 'x', 9);
  bikeRack(g, 150, 90, 5, [C.red, C.blue, null, C.yellow, C.teal]);
  for (let i = 0; i < 10; i++) person(g, rng, 12 + ((rng() * 166) | 0), 89 + ((rng() * 10) | 0));
  // ---- main block + entrance hall ------------------------------------------
  const x0 = 6, x1 = 184, z0 = 104, z1 = 182, H = 64;
  g.walls(x0, G, z0, x1, H, z1, wall);
  g.walls(x0, G, z0, x1, G + 1, z1, C.comFrame);
  g.box(x0 + 1, H, z0 + 1, x1 - 1, H, z1 - 1, C.comRoof);
  g.walls(x0 - 2, H, z0 - 2, x1 + 2, H, z1 + 2, C.signWhite);
  g.walls(x0, H + 1, z0, x1, H + 2, z1, wall); g.walls(x0, H + 3, z0, x1, H + 3, z1, accent);
  g.walls(x0 - 1, 36, z0 - 1, x1 + 1, 36, z1 + 1, accent);                     // level-2 belt
  const F = facade(g, 'front', z0), Bk = facade(g, 'back', z1), Lf = facade(g, 'left', x0), Rf = facade(g, 'right', x1);
  const unitCols = [C.orange, C.teal, C.purple, C.roofGreen, C.pink, C.blue, C.red, C.yellow];
  const unitNames = ['TOYS', 'PETS', 'HATS', 'TEA', 'SPA', 'SHOES', 'GIFTS', 'BAGS', 'CAKE', 'BOOKS', 'GAMES', 'TECH'];
  let ni = (rng() * 12) | 0;
  const unitRow = (f, a0, a1, lvl2) => {
    for (const [a, b] of splitBays(a0, a1, 16, 4)) {
      const c = unitCols[ni % unitCols.length], nm = unitNames[ni++ % unitNames.length];
      bay(f, a, b, 6, 24, { frame: C.comFrame, kick: c });
      awning(f, a - 1, b + 1, 27, 4, [c, C.signWhite]);
      f.box(a - 1, 28, 1, b + 1, 34, 1, c);
      text(f, (a + b + (f.rd < 0 ? 1 : 0)) >> 1, 30, nm, C.signWhite, 1, false);
      if (lvl2) for (const [p, q] of splitBays(a, b, 4, 2)) bay(f, p, q, 40, 56, { frame: C.comFrame, transom: false });
    }
  };
  const ex0 = 70, ex1 = 120;
  unitRow(F, x0 + 4, ex0 - 4, true); unitRow(F, ex1 + 4, x1 - 4, true);
  // entrance hall block (taller, glazed)
  const EH = 92;
  g.walls(ex0, G, z0 - 6, ex1, EH, z0 + 30, wall);
  g.box(ex0 + 1, EH, z0 - 5, ex1 - 1, EH, z0 + 29, C.comRoof);
  g.walls(ex0 - 2, EH, z0 - 8, ex1 + 2, EH, z0 + 32, C.signWhite);
  g.walls(ex0, EH + 1, z0 - 6, ex1, EH + 2, z0 + 30, wall); g.walls(ex0, EH + 3, z0 - 6, ex1, EH + 3, z0 + 30, accent);
  const E = facade(g, 'front', z0 - 6);
  for (const f of [facade(g, 'left', ex0), facade(g, 'right', ex1)]) for (const [a, b] of splitBays(z0 - 3, z0 + 27, 4, 2)) bay(f, a, b, H + 6, EH - 6, { frame: C.comFrame, transom: false });
  for (const [a, b] of splitBays(ex0 + 3, ex1 - 3, 4, 2)) bay(facade(g, 'back', z0 + 30), a, b, H + 6, EH - 6, { frame: C.comFrame, transom: false });
  for (const [a, b] of splitBays(ex0 + 3, ex1 - 3, 5, 1)) bay(E, a, b, 30, 70, { frame: C.comFrame, transom: false });
  E.box(ex0 + 2, 28, 0, ex1 - 2, 28, 0, C.comFrame);
  for (const d of [80, 91, 102]) glassDoor(E, d, 22, { frame: C.comFrame, doorC: C.comFrame, mat: accent });
  for (const [a, b] of [[ex0 + 3, 78], [111, ex1 - 3]]) bay(E, a, b, 6, 22, { frame: C.comFrame, kick: C.comFrame });
  canopy(E, ex0 + 2, ex1 - 2, 25, 8, accent, C.signWhite);
  // r10: a small MALL board (was 2× letters on a 47×19 panel)
  E.box(ex0 + 2, 72, 1, ex1 - 2, 73, 1, accent);
  E.box(ex0 + 2, 88, 1, ex1 - 2, 89, 1, accent);
  E.box(95 - 13, 76, 1, 95 + 13, 86, 2, accent);
  E.box(95 - 12, 77, 2, 95 + 12, 85, 2, C.signWhite);
  text(E, 95, 78, 'MALL', accent, 2, true);
  logoTile(E, ex0 + 7, 77, LOGO.bag, C.signWhite, accent); logoTile(E, ex1 - 7, 77, LOGO.bag, C.signWhite, accent);
  // flanks: min-X shop units, max-X loading docks
  unitRow(Lf, z0 + 4, z1 - 30, true);
  serviceDoor(Lf, z1 - 16, { hood: accent });
  for (const u of [z0 + 10, z0 + 30, z0 + 50]) {
    Rf.box(u - 1, G, 1, u + 14, G + 22, 1, C.comFrame); Rf.box(u, G, 2, u + 13, G + 21, 2, C.offwhite);
    for (let y = G + 2; y < G + 21; y += 3) Rf.box(u, y, 2, u + 13, y, 2, C.concrete);
    Rf.box(u - 1, G + 24, 1, u + 14, G + 24, 5, accent);
  }
  for (const [a, b] of splitBays(z0 + 4, z1 - 4, 4, 3)) bay(Rf, a, b, 42, 54, { frame: C.comFrame, transom: false });
  // back: a second row of units + a rear entrance
  unitRow(Bk, x0 + 4, 84, true); unitRow(Bk, 106, x1 - 4, true);
  glassDoor(Bk, 91, 22, { frame: C.comFrame, doorC: C.comFrame, mat: accent }); canopy(Bk, 88, 102, 25, 6, accent, C.signWhite);
  logoTile(Bk, 95, 28, LOGO.bag, C.signWhite, accent);
  // back yard
  for (const x of [10, 180]) tree(g, x, 186, 'round', x);
  for (const x of [40, 150]) planter(g, x - 6, 184, x + 6, 188, [C.pink, C.yellow]);
  bench(g, 70, 184, 'x', 9); bench(g, 112, 184, 'x', 9);
  // ---- roofs ------------------------------------------------------------------
  const list = ['sky', 'sky', 'sky', 'sky', 'acBig', 'acBig', 'acBig', 'solarBig', 'solarBig', 'solarBig', 'duct', 'hatch', 'tank'];
  list.block = [[ex0 - 2, z0 - 8, ex1 + 2, z0 + 32]];
  roofRim(g, x0 + 1, z0 + 1, x1 - 1, z1 - 1, H);
  roofScape(g, rng, x0 + 3, z0 + 3, x1 - 3, z1 - 3, H + 1,
    ['sky', 'hvac', 'sky', 'solar', 'garden', 'hvac', 'solar', 'patio', 'garden', 'hvac', 'sky', 'solar', 'garden', 'stair', 'hvac', 'sky', 'solar', 'garden'],
    { cell: 30, cellD: 24, block: list.block, terrace: { cols: [accent, C.signWhite], chair: accent } });
  roofGear(g, ex0 + 1, z0 - 5, ex1 - 1, z0 + 29, EH + 1, ['acBig', 'ac', 'ac', 'vent', 'tank', 'hatch']);
  return g.done();
}

// ---------------------------------------------------------------------------
// Barber pole spinner: res 4, 3 × 12 × 3 (0.75 × 3 × 0.75 units).
// ---------------------------------------------------------------------------
function _barberSpinner() {
  const g = { sx: 3, sy: 12, sz: 3, blocks: [], res: 4 };
  const cols = [C.red, C.signWhite, C.blue, C.signWhite];
  for (let y = 1; y <= 10; y++) for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
    if (x === 1 && z === 1) continue;
    const a = Math.round(Math.atan2(z - 1, x - 1) / (Math.PI / 4)) + 8;
    g.blocks.push([x, y, z, cols[Math.floor((y + a) / 2) % 4]]);
  }
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { g.blocks.push([x, 0, z, C.comFrame]); g.blocks.push([x, 11, z, C.comFrame]); }
  g.blocks.push([1, 11, 1, C.lamp]);
  return g;
}

// ---------------------------------------------------------------------------
// Registry: catalog id -> builder (rng, variant, entry) => model.
// ---------------------------------------------------------------------------
// w4r4: catalogModel flipZ()s only the base, so the fine sign part (built
// unflipped, matching the zoned commercial() path) is mirrored here too
const flipFine = (b) => (...a) => { const m = b(...a); if (m && m.__fine) { flipZ(m.__fine); delete m.__fine; } return m; };
const _BUILDERS = {
  'bakery': bBakery, 'ice-cream': bIceCream, 'pizza': bPizza, 'burger': bBurger,
  'cafe': bCafe, 'toy-store': bToyStore, 'pet-shop': bPetShop, 'book-shop': bBookShop,
  'flower-shop': bFlowerShop, 'grocery': bGrocery, 'market-stall': bMarketStall,
  'arcade': bArcade, 'cinema': bCinema, 'mall': bMall,
  'candy-shop': bCandyShop, 'music-store': bMusicStore, 'sports-shop': bSportsShop,
  'barber': bBarber, 'diner': bDiner, 'fruit-stand': bFruitStand,
};
export const BUILDERS = Object.fromEntries(Object.entries(_BUILDERS).map(([k, b]) => [k, flipFine(b)]));

// Animated parts: id -> () => { part, ox,oy,oz (WORLD units), ax,ay,az, speed }
// Barber pole: it stands on the paving left of the door, 6 fine voxels
// (0.75 u) square, pre-flip x du-6..du-1, z z0-4..z0-... ; centre (pxc, pzc) in
// continuous fine coordinates; after flipZ z' = 63 - z; the geometry is X/Z
// centred and the spinner pivots on its middle: oy = 0.5 + 3/2.
const _bdu = BARBER.body[0] + BARBER.doorOff;          // door opening u (fine x)
const _pxc = _bdu - 5, _pzc = BARBER.body[1] - 4.5;
export const ANIMS = {
  'barber': () => ({ part: _barberSpinner(), ox: (_pxc - 31.5) / R, oy: G / R + 1.5, oz: (31.5 - _pzc) / R, ax: 0, ay: 1, az: 0, speed: 2.5 }),
};
