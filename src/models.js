// Blockville — voxel art catalog. PURE DATA + tiny functions.
// No three.js, no DOM. May import ./constants.js (not required for art, but allowed).
// Every generator returns { sx, sy, sz, blocks:[[x,y,z,colorIndex], ...] }
// with integer coords inside [0,size) and colorIndex valid in PALETTE.
//
// Determinism: generators seed a tiny mulberry32 PRNG from their `variant` int,
// so the same variant always rebuilds byte-for-byte identically after save/load.
// No Math.random at module load.

// ---------------------------------------------------------------------------
// PALETTE — bright, saturated, kid-friendly. Sparse array so 200-203 exist.
// Indices 200..203 are special glow colors (engine renders them emissive at
// night): 200 warm window, 201 cool window, 202 streetlight glow, 203 neon.
// ---------------------------------------------------------------------------
const _colors = {
  // greens (grass + foliage)
  grassLight: 0x7ec850, grassMid: 0x5fae3a, grassDark: 0x4a8f2c,
  leafLight: 0x8fd84a, leafMid: 0x5cb02f, leafDark: 0x3f8a24,
  pine: 0x2f7d3a, pineDark: 0x24632d,
  blossom: 0xff9ec4, blossomDark: 0xf56fa6,
  bush: 0x6fc23c, lime: 0xa6e04f,
  // browns + wood
  trunk: 0x8a5a2b, trunkDark: 0x6b431f,
  wood: 0xc08a4a, woodDark: 0x8a5f2f, plank: 0xd8a45c,
  dirt: 0x9b6b3f, dirtDark: 0x7a5230,
  // reds + brick
  brick: 0xc0533f, brickDark: 0x9a3f30,
  roofRed: 0xc23b2e, red: 0xe23b2e, fireRed: 0xd8231b, crimson: 0xa8221a,
  // pastel walls
  pBlue: 0xa9d6e5, pYellow: 0xf7e08a, pPink: 0xf6b5c8, pGreen: 0xb7e0a0,
  pPurple: 0xcbb6e6, cream: 0xf3e6c4, white: 0xf5f5f0, offwhite: 0xe4e4dc,
  peach: 0xf6c9a0, mint: 0xa8e6cf,
  // roofs
  roofBlue: 0x3f6fb0, roofBrown: 0x7c4a2a, roofGray: 0x6b6f76,
  roofGreen: 0x3f8a5a, roofOrange: 0xe08a3c, roofPurple: 0x6a4f9a,
  shingle: 0x944b3a,
  // grays / stone / metal
  asphalt: 0x3a3d42, asphaltDark: 0x2b2e33, sidewalk: 0xb9bcc0,
  concrete: 0xcfd2d6, stone: 0x9aa0a6, stoneDark: 0x6e747a,
  metal: 0xaab0b6, metalDark: 0x7a8087, steel: 0x8b9096, darkGray: 0x33363b,
  // yellows / orange / gold
  yellow: 0xf5c518, roadLine: 0xf2c94c, orange: 0xf28c28,
  taxiYellow: 0xf7c948, gold: 0xe8b83a, amber: 0xf0a830,
  // blues
  waterLight: 0x5fc7e8, waterMid: 0x3aa6d8, waterDark: 0x2b7fb8,
  blue: 0x3f7fd8, skyBlue: 0x8fd0f0, navy: 0x2a4a8a, teal: 0x2fbfa8,
  // skin tones (respectful range)
  skin1: 0xf6c9a8, skin2: 0xe8b088, skin3: 0xc98a5e, skin4: 0x9c6238, skin5: 0x6e4326,
  // hair
  hairBlack: 0x2a2320, hairBrown: 0x5a3a22, hairBlonde: 0xe0b860,
  hairAuburn: 0x8a3f2a, hairGray: 0xbfc2c6,
  // misc
  black: 0x1c1e22, pink: 0xf27fb0, purple: 0x8a5fc8,
  sand: 0xe6d3a3, sandDark: 0xcbb57e, signWhite: 0xfbfbf6,
};

export const PALETTE = [];
const C = {};
{
  let i = 0;
  for (const k in _colors) { C[k] = i; PALETTE[i] = _colors[k]; i++; }
}
// Special emissive glow colors (fixed indices per contract).
C.win = 200;     PALETTE[200] = 0xffd98a; // warm window
C.winCool = 201; PALETTE[201] = 0xbfeaff; // cool window
C.lamp = 202;    PALETTE[202] = 0xffe9a8; // streetlight glow
C.neon = 203;    PALETTE[203] = 0xff3fb4; // neon sign

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function mulberry32(a) {
  a = (a >>> 0) || 1;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Voxel grid using a Map keyed by "x,y,z" so later writes overwrite earlier
// ones cleanly (windows over walls) and duplicate positions never appear.
function grid(sx, sy, sz) {
  const map = new Map();
  return {
    sx, sy, sz, map,
    set(x, y, z, c) {
      x = Math.round(x); y = Math.round(y); z = Math.round(z);
      if (c == null) return;
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      map.set(x + ',' + y + ',' + z, c);
    },
    del(x, y, z) { map.delete(Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z)); },
    // solid box (inclusive, order-safe)
    box(x0, y0, z0, x1, y1, z1, c) {
      if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      if (z0 > z1) { const t = z0; z0 = z1; z1 = t; }
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          for (let z = z0; z <= z1; z++) this.set(x, y, z, c);
    },
    // 4 vertical wall faces only (hollow)
    walls(x0, y0, z0, x1, y1, z1, c) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) { this.set(x, y, z0, c); this.set(x, y, z1, c); }
        for (let z = z0; z <= z1; z++) { this.set(x0, y, z, c); this.set(x1, y, z, c); }
      }
    },
    // horizontal slab at height y
    slab(x0, y, z0, x1, z1, c) {
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) this.set(x, y, z, c);
    },
    done() {
      const blocks = [];
      for (const [k, c] of this.map) {
        const p = k.split(',');
        blocks.push([+p[0], +p[1], +p[2], c]);
      }
      return { sx: this.sx, sy: this.sy, sz: this.sz, blocks };
    },
  };
}

// Hipped pyramid roof (closed on all four sides, overhangs an inset body).
function pyramidRoof(g, x0, z0, x1, z1, baseY, c, cap) {
  let y = baseY;
  while (x0 <= x1 && z0 <= z1 && y < cap) {
    for (let x = x0; x <= x1; x++) { g.set(x, y, z0, c); g.set(x, y, z1, c); }
    for (let z = z0; z <= z1; z++) { g.set(x0, y, z, c); g.set(x1, y, z, c); }
    x0++; x1--; z0++; z1--; y++;
  }
  return y;
}

// Gable roof: ridge along X, triangular slopes down the Z axis, gable end
// walls closed with wall color.
function gableRoof(g, fx0, fx1, z0, z1, baseY, wallC, roofC, cap) {
  let y = baseY;
  while (z0 <= z1 && y < cap) {
    for (let z = z0; z <= z1; z++) { g.set(fx0, y, z, wallC); g.set(fx1, y, z, wallC); }
    for (let x = fx0; x <= fx1; x++) { g.set(x, y, z0, roofC); g.set(x, y, z1, roofC); }
    z0++; z1--; y++;
  }
  return y;
}

// Windows stamped in a grid on the four perimeter walls at given Y rows.
function windowsOn(g, x0, z0, x1, z1, yRows, win, step) {
  step = step || 2;
  for (const y of yRows) {
    for (let x = x0 + 1; x <= x1 - 1; x += step) { g.set(x, y, z0, win); g.set(x, y, z1, win); }
    for (let z = z0 + 1; z <= z1 - 1; z += step) { g.set(x0, y, z, win); g.set(x1, y, z, win); }
  }
}

// Small rooftop AC / vent box.
function acUnit(g, x, y, z, c) { g.box(x, y, z, x + 1, y, z + 1, c); }

// ---------------------------------------------------------------------------
// buildingModel(zone, level, variant)
// ---------------------------------------------------------------------------
export function buildingModel(zone, level, variant) {
  let Z = String(zone == null ? 'R' : zone).toUpperCase();
  if (Z !== 'R' && Z !== 'C' && Z !== 'I') Z = 'R';
  let L = Math.round(Number(level));
  if (!Number.isFinite(L)) L = 1;
  L = Math.min(3, Math.max(1, L));
  const seed = ((((variant | 0) >>> 0) ^ (Z.charCodeAt(0) * 131) ^ (L * 977)) >>> 0) || 1;
  const rng = mulberry32(seed);
  if (Z === 'R') return residential(L, rng);
  if (Z === 'C') return commercial(L, rng);
  return industrial(L, rng);
}

function residential(level, rng) {
  const pick = a => a[(rng() * a.length) | 0];
  const ri = (lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0);
  const walls = [C.pBlue, C.pYellow, C.pPink, C.pGreen, C.pPurple, C.cream, C.peach, C.mint, C.brick, C.offwhite];
  const roofs = [C.roofRed, C.roofBlue, C.roofBrown, C.roofGray, C.roofGreen, C.roofOrange, C.shingle, C.roofPurple];
  const wc = pick(walls), rc = pick(roofs), win = rng() < 0.5 ? C.win : C.winCool;
  const door = pick([C.woodDark, C.roofRed, C.roofBlue, C.trunkDark]);

  if (level === 1) {
    // Little house with pitched roof, chimney, door + windows.
    const cap = 8, fw = ri(5, 6), fd = ri(5, 6), bh = ri(3, 4);
    const g = grid(fw, cap, fd);
    g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);      // foundation
    g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, wc);       // walls
    if (rng() < 0.55) gableRoof(g, 0, fw - 1, 0, fd - 1, bh, wc, rc, cap);
    else pyramidRoof(g, 0, 0, fw - 1, fd - 1, bh, rc, cap);
    // door (2 tall, centered front)
    const dx = fw >> 1;
    g.set(dx, 0, 0, door); if (bh > 2) g.set(dx, 1, 0, door);
    // windows
    windowsOn(g, 0, 0, fw - 1, fd - 1, bh > 3 ? [1, 2] : [1], win);
    // chimney
    const cx = rng() < 0.5 ? 1 : fw - 2, cz = rng() < 0.5 ? 1 : fd - 2;
    for (let y = bh; y < Math.min(cap, bh + 3); y++) g.set(cx, y, cz, C.brickDark);
    return g.done();
  }

  if (level === 2) {
    // Townhouse — taller, two window rows, small entry canopy.
    const cap = 14, fw = ri(5, 6), fd = ri(5, 6), bh = ri(7, 9);
    const g = grid(fw, cap, fd);
    g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);
    g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, wc);
    // accent trim band
    const band = pick([C.brick, C.roofBrown, C.stoneDark, C.navy]);
    for (let x = 0; x < fw; x++) { g.set(x, 3, 0, band); g.set(x, 3, fd - 1, band); }
    for (let z = 0; z < fd; z++) { g.set(0, 3, z, band); g.set(fw - 1, 3, z, band); }
    if (rng() < 0.5) { g.slab(0, bh, 0, fw - 1, fd - 1, rc); g.walls(0, bh, 0, fw - 1, bh, fd - 1, band); }
    else gableRoof(g, 0, fw - 1, 0, fd - 1, bh, wc, rc, cap);
    const dx = fw >> 1;
    g.set(dx, 0, 0, door); g.set(dx, 1, 0, door);
    g.set(dx - 1, 2, 0, band); g.set(dx, 2, 0, band); g.set(dx + 1, 2, 0, band); // canopy
    windowsOn(g, 0, 0, fw - 1, fd - 1, [1, 2, 4, 5].filter(y => y < bh), win);
    // chimney
    for (let y = bh; y < Math.min(cap, bh + 3); y++) g.set(fw - 2, y, 1, C.brickDark);
    return g.done();
  }

  // level 3 — small apartment block: grid of windows, roof railing + tank.
  const cap = 22, fw = ri(6, 6), fd = ri(6, 6), bh = ri(13, 16);
  const g = grid(fw, cap, fd);
  const body = pick([C.cream, C.offwhite, C.brick, C.peach, C.pBlue, C.pYellow]);
  g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);
  g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, body);
  // full window grid every other floor
  const rows = [];
  for (let y = 2; y < bh - 1; y += 2) rows.push(y);
  windowsOn(g, 0, 0, fw - 1, fd - 1, rows, win, 2);
  // ground-floor entrance
  const dx = fw >> 1;
  g.box(dx - 1, 0, 0, dx + 1, 1, 0, C.stoneDark);
  g.set(dx, 0, 0, door); g.set(dx, 1, 0, door);
  // flat roof + parapet + water tank + AC
  g.slab(0, bh, 0, fw - 1, fd - 1, C.concrete);
  g.walls(0, bh + 1, 0, fw - 1, bh + 1, fd - 1, C.stoneDark);
  for (let y = bh + 1; y < Math.min(cap, bh + 4); y++) g.box(1, y, 1, 2, y, 2, C.metalDark); // tank
  acUnit(g, fw - 3, bh + 1, fd - 3, C.metal);
  return g.done();
}

function commercial(level, rng) {
  const pick = a => a[(rng() * a.length) | 0];
  const ri = (lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0);
  const wall = pick([C.pBlue, C.pYellow, C.pPink, C.cream, C.mint, C.peach, C.offwhite, C.brick]);
  const accent = pick([C.red, C.blue, C.orange, C.teal, C.purple, C.crimson, C.roofGreen]);
  const win = C.winCool;

  if (level === 1) {
    // Corner kiosk / shop with striped awning + little rooftop sign.
    const cap = 8, fw = 5, fd = 5, bh = 4;
    const g = grid(fw, cap, fd);
    g.walls(0, 0, 1, fw - 1, bh - 1, fd - 1, wall);   // body starts at z=1
    g.slab(0, 0, 1, fw - 1, fd - 1, C.concrete);       // floor
    g.slab(0, bh, 1, fw - 1, fd - 1, wall);            // flat roof
    // shop windows across the front (z=1)
    for (let x = 1; x < fw - 1; x++) { g.set(x, 1, 1, win); g.set(x, 2, 1, win); }
    g.set(fw >> 1, 0, 1, C.woodDark);                  // door
    // striped awning sticking out front (z=0)
    for (let x = 0; x < fw; x++) g.set(x, 3, 0, x % 2 ? accent : C.signWhite);
    g.set(0, 2, 0, C.metalDark); g.set(fw - 1, 2, 0, C.metalDark); // posts
    // rooftop sign board
    for (let x = 1; x < fw - 1; x++) { g.set(x, bh + 1, 2, accent); g.set(x, bh + 2, 2, C.signWhite); }
    return g.done();
  }

  if (level === 2) {
    // Store with big glass front, awning and a proud sign band.
    const cap = 14, fw = 6, fd = 6, bh = ri(8, 10);
    const g = grid(fw, cap, fd);
    g.walls(0, 0, 1, fw - 1, bh - 1, fd - 1, wall);
    g.slab(0, 0, 1, fw - 1, fd - 1, C.concrete);
    g.slab(0, bh, 1, fw - 1, fd - 1, wall);
    // ground-floor storefront glass
    for (let x = 1; x < fw - 1; x++) { g.set(x, 1, 1, win); g.set(x, 2, 1, win); }
    g.set(1, 0, 1, C.woodDark); g.set(1, 1, 1, C.woodDark); // door
    // upper windows
    windowsOn(g, 0, 1, fw - 1, fd - 1, [4, 6].filter(y => y < bh), win);
    // sign band above storefront
    for (let x = 0; x < fw; x++) g.set(x, 3, 1, accent);
    // awning
    for (let x = 0; x < fw; x++) g.set(x, 3, 0, x % 2 ? accent : C.signWhite);
    // rooftop billboard
    for (let x = 1; x < fw - 1; x++) for (let y = bh + 1; y <= bh + 2; y++) g.set(x, y, 3, C.signWhite);
    g.set(2, bh + 1, 3, accent); g.set(3, bh + 2, 3, accent);
    acUnit(g, fw - 3, bh, fd - 2, C.metal);
    return g.done();
  }

  // level 3 — little commercial tower with neon.
  const cap = 22, fw = 5, fd = 5, bh = ri(16, 19);
  const g = grid(fw, cap, fd);
  const body = pick([C.navy, C.roofBlue, C.stoneDark, C.teal, C.brick]);
  g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, body);
  g.slab(0, 0, 0, fw - 1, fd - 1, C.concrete);
  // window grid every floor
  const rows = [];
  for (let y = 2; y < bh - 1; y += 2) rows.push(y);
  windowsOn(g, 0, 0, fw - 1, fd - 1, rows, win, 1);
  // glowing neon corner strips
  for (let y = 2; y < bh - 1; y++) { g.set(0, y, 0, C.neon); g.set(fw - 1, y, 0, C.neon); }
  // entrance
  g.set(fw >> 1, 0, 0, C.black); g.set(fw >> 1, 1, 0, C.winCool);
  // rooftop neon sign + antenna
  g.slab(0, bh, 0, fw - 1, fd - 1, C.concrete);
  for (let x = 1; x < fw - 1; x++) { g.set(x, bh + 1, 2, C.neon); g.set(x, bh + 2, 2, C.neon); }
  for (let y = bh + 1; y < Math.min(cap, bh + 4); y++) g.set(fw - 2, y, 1, C.metalDark);
  return g.done();
}

function industrial(level, rng) {
  const pick = a => a[(rng() * a.length) | 0];
  const ri = (lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0);
  const wall = pick([C.concrete, C.stone, C.steel, C.metal, C.brick, C.sandDark]);
  const roof = pick([C.metalDark, C.stoneDark, C.roofGray, C.darkGray]);
  const door = pick([C.orange, C.red, C.amber, C.metalDark]);
  const win = C.winCool;

  if (level === 1) {
    // Small workshop with roll-up door and a roof vent.
    const cap = 8, fw = 5, fd = 5, bh = 5;
    const g = grid(fw, cap, fd);
    g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, wall);
    g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);
    g.slab(0, bh, 0, fw - 1, fd - 1, roof);
    // roll-up garage door
    g.box(1, 0, 0, fw - 2, 2, 0, door);
    // clerestory windows
    for (let x = 1; x < fw - 1; x++) { g.set(x, 3, fd - 1, win); }
    // roof vent + short stack
    acUnit(g, 1, bh, 1, C.metalDark);
    for (let y = bh; y < Math.min(cap, bh + 2); y++) g.set(fw - 2, y, 1, C.metal);
    return g.done();
  }

  if (level === 2) {
    // Factory with a tall smoking chimney and rooftop vents.
    const cap = 14, fw = 6, fd = 6, bh = ri(6, 8);
    const g = grid(fw, cap, fd);
    g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, wall);
    g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);
    g.slab(0, bh, 0, fw - 1, fd - 1, roof);
    g.box(1, 0, 0, 3, 3, 0, door);                    // big door
    windowsOn(g, 0, 0, fw - 1, fd - 1, [2, 4].filter(y => y < bh), win);
    // chimney (brick) with dark rim near the roof
    const cx = fw - 2, cz = 1;
    for (let y = bh; y < cap - 1; y++) g.set(cx, y, cz, C.brick);
    g.set(cx, cap - 2, cz, C.brickDark);
    acUnit(g, 1, bh, fd - 3, C.metalDark);
    acUnit(g, 3, bh, fd - 3, C.metal);
    return g.done();
  }

  // level 3 — big factory: multiple chimneys, vents, pipes.
  const cap = 22, fw = 7, fd = 7, bh = ri(8, 10);
  const g = grid(fw, cap, fd);
  g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, wall);
  g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);
  g.slab(0, bh, 0, fw - 1, fd - 1, roof);
  // two big bay doors
  g.box(1, 0, 0, 2, 3, 0, door);
  g.box(4, 0, 0, 5, 3, 0, door);
  windowsOn(g, 0, 0, fw - 1, fd - 1, [2, 4, 6].filter(y => y < bh), win, 1);
  // twin chimneys
  for (const cx of [1, fw - 2]) {
    for (let y = bh; y < cap - 2; y++) g.set(cx, y, 1, C.brick);
    g.set(cx, cap - 3, 1, C.brickDark);
  }
  // rooftop pipe run + vents
  for (let x = 1; x < fw - 1; x++) g.set(x, bh, fd - 2, C.metalDark);
  acUnit(g, 2, bh + 1, fd - 3, C.metal);
  acUnit(g, fw - 4, bh + 1, fd - 3, C.metal);
  return g.done();
}

// ---------------------------------------------------------------------------
// serviceModel(kind, variant)
// ---------------------------------------------------------------------------
export function serviceModel(kind, variant) {
  const k = String(kind == null ? 'park' : kind).toLowerCase();
  const rng = mulberry32(((variant | 0) >>> 0) + 7);
  switch (k) {
    case 'school': return svcSchool(rng);
    case 'fire': return svcFire(rng);
    case 'fountain': return svcFountain(rng);
    case 'stadium': return svcStadium(rng);
    case 'power': return svcPower(rng);
    case 'park': default: return svcPark(rng);
  }
}

// small tree cluster helper used by park/stadium landscaping
function miniTree(g, cx, cz, foliage) {
  g.set(cx, 0, cz, C.trunk); g.set(cx, 1, cz, C.trunk);
  g.box(cx - 1, 2, cz - 1, cx + 1, 2, cz + 1, foliage);
  g.set(cx, 3, cz, foliage);
  g.del(cx - 1, 2, cz - 1); g.del(cx + 1, 2, cz - 1);
  g.del(cx - 1, 2, cz + 1); g.del(cx + 1, 2, cz + 1);
}

function svcPark(rng) {
  const g = grid(7, 5, 7);
  // grassy base with dabs
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) {
    const c = rng() < 0.18 ? C.grassLight : rng() < 0.12 ? C.grassDark : C.grassMid;
    g.set(x, 0, z, c);
  }
  // little pond
  for (let x = 4; x <= 6; x++) for (let z = 0; z <= 1; z++) g.set(x, 0, z, rng() < 0.5 ? C.waterLight : C.waterMid);
  // winding path
  for (let z = 2; z <= 6; z++) g.set(2, 0, z, C.sand);
  for (let x = 2; x <= 5; x++) g.set(x, 0, 4, C.sand);
  // trees
  miniTree(g, 1, 5, C.leafMid);
  miniTree(g, 5, 5, C.blossom);
  if (rng() < 0.6) miniTree(g, 1, 2, C.leafDark);
  // bench (wood): seat + back + legs
  g.set(4, 1, 6, C.wood); g.set(5, 1, 6, C.wood);
  g.set(4, 2, 6, C.woodDark); g.set(5, 2, 6, C.woodDark);
  // lamp post with glow
  g.set(0, 1, 3, C.metalDark); g.set(0, 2, 3, C.metalDark); g.set(0, 3, 3, C.lamp);
  return g.done();
}

function svcSchool(rng) {
  const g = grid(7, 12, 7);
  const wall = rng() < 0.5 ? C.brick : C.cream;
  const bh = 6;
  g.walls(0, 0, 0, 6, bh - 1, 6, wall);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.slab(0, bh, 0, 6, 6, C.roofRed);
  // big windows (schools have lots)
  for (let x = 1; x <= 5; x++) { g.set(x, 2, 0, C.winCool); g.set(x, 3, 0, C.winCool); }
  windowsOn(g, 0, 0, 6, 6, [2, 4], C.winCool, 2);
  // double doors + steps
  g.box(2, 0, 0, 4, 0, 0, C.stoneDark);
  g.set(3, 1, 0, C.woodDark); g.set(3, 2, 0, C.woodDark);
  // clock / crest above door
  g.set(3, bh, 3, C.gold);
  // flag pole with red flag (the star of the show)
  const px = 6;
  for (let y = 0; y < 10; y++) g.set(px, y, 0, C.metal);
  g.set(px, 9, 0, C.red); g.set(px - 1, 9, 0, C.red);
  g.set(px, 8, 0, C.red); g.set(px - 1, 8, 0, C.red);
  return g.done();
}

function svcFire(rng) {
  const g = grid(7, 11, 7);
  const bh = 6;
  g.walls(0, 0, 0, 6, bh - 1, 6, C.fireRed);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.slab(0, bh, 0, 6, 6, C.crimson);
  // big white garage door(s)
  g.box(1, 0, 0, 3, 3, 0, C.offwhite);
  g.box(4, 0, 0, 5, 3, 0, C.offwhite);
  // upstairs windows
  windowsOn(g, 0, 0, 6, 6, [4], C.winCool, 2);
  // white trim band
  for (let x = 0; x < 7; x++) g.set(x, bh - 1, 0, C.signWhite);
  // hose/watch tower with a little siren light
  for (let y = 0; y < 9; y++) g.box(5, y, 5, 6, y, 6, C.crimson);
  g.set(5, 9, 5, C.red); g.set(6, 9, 6, C.lamp);
  // sign
  g.set(3, bh, 3, C.signWhite);
  return g.done();
}

function svcFountain(rng) {
  const g = grid(5, 6, 5);
  // stone base ring with water pool
  g.walls(0, 0, 0, 4, 0, 4, C.stone);
  for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) g.set(x, 0, z, C.waterLight);
  g.slab(0, 1, 0, 4, 4, null); // (no-op, keeps intent clear)
  g.walls(0, 1, 0, 4, 1, 4, C.stoneDark);
  // central pedestal
  g.box(2, 1, 2, 2, 2, 2, C.stone);
  // upper tiered basin
  g.walls(1, 3, 1, 3, 3, 3, C.stone);
  g.set(2, 3, 2, C.waterMid);
  g.box(2, 4, 2, 2, 4, 2, C.stone);
  // water spout on top
  g.set(2, 5, 2, C.waterLight);
  return g.done();
}

function svcStadium(rng) {
  // Chunky oval-ish arena, fits 7x7. Colored seats, green pitch.
  const g = grid(7, 8, 7);
  const seatCols = [C.red, C.blue, C.yellow, C.pGreen, C.orange, C.teal];
  // pitch
  for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++)
    g.set(x, 0, z, (x + z) % 2 ? C.grassMid : C.grassLight);
  // midline
  g.set(3, 0, 1, C.signWhite); g.set(3, 0, 3, C.signWhite); g.set(3, 0, 5, C.signWhite);
  // outer wall ring
  g.walls(0, 0, 0, 6, 1, 6, C.concrete);
  // tiered stands rising outward (3 rings of colored seats)
  const rings = [
    { inset: 1, y: 1 },
    { inset: 0, y: 2 },
  ];
  for (const r of rings) {
    const a = r.inset, b = 6 - r.inset;
    for (let x = a; x <= b; x++) {
      g.set(x, r.y, a, seatCols[(x) % seatCols.length]);
      g.set(x, r.y, b, seatCols[(x + 2) % seatCols.length]);
    }
    for (let z = a; z <= b; z++) {
      g.set(a, r.y, z, seatCols[(z + 1) % seatCols.length]);
      g.set(b, r.y, z, seatCols[(z + 3) % seatCols.length]);
    }
  }
  // corner light towers with glow
  for (const [cx, cz] of [[0, 0], [6, 0], [0, 6], [6, 6]]) {
    for (let y = 2; y <= 5; y++) g.set(cx, y, cz, C.metalDark);
    g.set(cx, 6, cz, C.lamp);
  }
  // roof canopy fragments over stands (front/back)
  for (let x = 1; x <= 5; x++) { g.set(x, 4, 0, C.steel); g.set(x, 4, 6, C.steel); }
  // a couple of flags
  g.set(3, 7, 0, C.red); g.set(3, 7, 6, C.blue);
  return g.done();
}

function svcPower(rng) {
  // White wind turbine — tower + nacelle + 3 static blades.
  const g = grid(7, 14, 3);
  const tx = 3, tz = 1, hubY = 11;
  // base pad
  g.box(2, 0, 0, 4, 0, 2, C.concrete);
  // tower
  for (let y = 0; y < hubY; y++) g.set(tx, y, tz, C.white);
  g.set(tx, 1, tz, C.offwhite);
  // nacelle
  g.box(tx, hubY, tz, tx, hubY, tz, C.metal);
  g.set(tx + 1, hubY, tz, C.metalDark);
  // 3 blades in a Y pose (in the X/Y plane)
  // blade up
  for (let y = hubY + 1; y <= hubY + 2 && y < 14; y++) g.set(tx, y, tz, C.offwhite);
  // blade lower-left
  g.set(tx - 1, hubY - 1, tz, C.offwhite); g.set(tx - 2, hubY - 1, tz, C.offwhite);
  g.set(tx - 2, hubY - 2, tz, C.offwhite);
  // blade lower-right
  g.set(tx + 1, hubY - 1, tz, C.offwhite); g.set(tx + 2, hubY - 1, tz, C.offwhite);
  g.set(tx + 2, hubY - 2, tz, C.offwhite);
  // hub
  g.set(tx, hubY, tz, C.signWhite);
  return g.done();
}

// ---------------------------------------------------------------------------
// treeModel(variant) — ≥5 variants
// ---------------------------------------------------------------------------
function leafRing(g, cx, cz, y, r, c, rng, alt) {
  for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) {
    // rounded: skip far corners
    if (Math.abs(x - cx) === r && Math.abs(z - cz) === r) continue;
    g.set(x, y, z, rng && rng() < 0.22 && alt != null ? alt : c);
  }
}

export function treeModel(variant) {
  const v = (((variant | 0) % 5) + 5) % 5;
  const rng = mulberry32(((variant | 0) >>> 0) + 101);
  if (v === 0) {
    // round oak
    const g = grid(5, 9, 5);
    for (let y = 0; y < 4; y++) g.set(2, y, 2, C.trunk);
    leafRing(g, 2, 2, 4, 2, C.leafMid, rng, C.leafLight);
    leafRing(g, 2, 2, 5, 2, C.leafMid, rng, C.leafDark);
    leafRing(g, 2, 2, 6, 2, C.leafMid, rng, C.leafLight);
    leafRing(g, 2, 2, 7, 1, C.leafMid, rng, C.leafDark);
    g.set(2, 8, 2, C.leafMid);
    return g.done();
  }
  if (v === 1) {
    // tall pine
    const g = grid(5, 11, 5);
    for (let y = 0; y < 3; y++) g.set(2, y, 2, C.trunkDark);
    leafRing(g, 2, 2, 3, 2, C.pine, rng, C.pineDark);
    leafRing(g, 2, 2, 4, 1, C.pine, rng, C.pineDark);
    leafRing(g, 2, 2, 5, 2, C.pine, rng, C.pineDark);
    leafRing(g, 2, 2, 6, 1, C.pine, rng, C.pineDark);
    leafRing(g, 2, 2, 7, 2, C.pine, rng, C.pineDark);
    leafRing(g, 2, 2, 8, 1, C.pine, rng, C.pineDark);
    g.set(2, 9, 2, C.pine); g.set(2, 10, 2, C.pineDark);
    return g.done();
  }
  if (v === 2) {
    // cherry blossom
    const g = grid(5, 9, 5);
    for (let y = 0; y < 4; y++) g.set(2, y, 2, C.trunk);
    leafRing(g, 2, 2, 4, 2, C.blossom, rng, C.blossomDark);
    leafRing(g, 2, 2, 5, 2, C.blossom, rng, C.blossomDark);
    leafRing(g, 2, 2, 6, 2, C.blossom, rng, C.blossomDark);
    leafRing(g, 2, 2, 7, 1, C.blossom, rng, C.blossomDark);
    g.set(2, 8, 2, C.blossom);
    return g.done();
  }
  if (v === 3) {
    // bushy — wide and low
    const g = grid(5, 5, 5);
    g.set(2, 0, 2, C.trunk);
    leafRing(g, 2, 2, 1, 2, C.bush, rng, C.leafDark);
    leafRing(g, 2, 2, 2, 2, C.bush, rng, C.leafLight);
    leafRing(g, 2, 2, 3, 2, C.bush, rng, C.leafDark);
    g.set(2, 4, 2, C.bush);
    return g.done();
  }
  // sapling — tiny
  const g = grid(3, 4, 3);
  g.set(1, 0, 1, C.trunkDark); g.set(1, 1, 1, C.trunk);
  leafRing(g, 1, 1, 2, 1, C.leafLight, rng, C.leafMid);
  g.set(1, 3, 1, C.leafMid);
  return g.done();
}

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
// carModel(variant) — cute chunky vehicles facing -Z. size 3(x) x 4(y) x 6(z)
// ---------------------------------------------------------------------------
function carWheels(g, len, c) {
  for (const z of [1, len - 2]) { g.set(0, 0, z, c); g.set(2, 0, z, c); }
}

export function carModel(variant) {
  const v = (((variant | 0) % 6) + 6) % 6;
  const rng = mulberry32(((variant | 0) >>> 0) + 51);
  const pick = a => a[(rng() * a.length) | 0];

  if (v === 0 || v === 5) {
    // sedan / hatchback in a random cheerful color
    const len = 6, body = v === 5
      ? pick([C.red, C.blue, C.teal, C.orange, C.purple, C.pGreen, C.gold])
      : pick([C.red, C.blue, C.teal, C.roofGreen, C.amber, C.navy, C.pink]);
    const g = grid(3, 4, len);
    g.box(0, 1, 0, 2, 1, len - 1, body);          // lower body
    g.box(0, 2, 1, 2, 2, len - 2, body);          // cabin
    // windows
    for (let x = 0; x <= 2; x++) { g.set(x, 2, 1, C.winCool); g.set(x, 2, len - 2, C.winCool); }
    g.set(0, 2, 2, C.winCool); g.set(2, 2, 2, C.winCool);
    g.set(0, 2, 3, C.winCool); g.set(2, 2, 3, C.winCool);
    g.box(0, 3, 2, 2, 3, 3, body);                // roof
    carWheels(g, len, C.black);
    g.set(0, 1, 0, C.win); g.set(2, 1, 0, C.win); // headlights (front = -Z)
    g.set(0, 1, len - 1, C.red); g.set(2, 1, len - 1, C.red); // tail lights
    return g.done();
  }

  if (v === 1) {
    // taxi — yellow with a roof sign
    const len = 6, body = C.taxiYellow;
    const g = grid(3, 4, len);
    g.box(0, 1, 0, 2, 1, len - 1, body);
    g.box(0, 2, 1, 2, 2, len - 2, body);
    for (let x = 0; x <= 2; x++) { g.set(x, 2, 1, C.winCool); g.set(x, 2, len - 2, C.winCool); }
    g.set(0, 2, 2, C.winCool); g.set(2, 2, 2, C.winCool);
    g.box(0, 3, 2, 2, 3, 3, body);
    g.set(1, 3, 2, C.black); g.set(1, 3, 3, C.signWhite); // rooftop TAXI sign
    // checker stripe
    g.set(0, 1, 3, C.black); g.set(2, 1, 3, C.black);
    carWheels(g, len, C.black);
    g.set(0, 1, 0, C.win); g.set(2, 1, 0, C.win);
    return g.done();
  }

  if (v === 2) {
    // bus — long, lots of windows
    const len = 6, body = pick([C.red, C.roofGreen, C.blue, C.orange]);
    const g = grid(3, 4, len);
    g.box(0, 1, 0, 2, 2, len - 1, body);
    // window band all around
    for (let z = 1; z <= len - 2; z++) { g.set(0, 2, z, C.winCool); g.set(2, 2, z, C.winCool); }
    for (let x = 0; x <= 2; x++) g.set(x, 2, 0, C.winCool);
    g.box(0, 3, 1, 2, 3, len - 2, body);          // roof
    g.set(1, 1, 0, C.win); g.set(1, 1, len - 1, C.red);
    g.set(2, 1, len - 3, C.woodDark);             // door
    carWheels(g, len, C.black);
    return g.done();
  }

  if (v === 3) {
    // ice-cream truck — white body, pink roof, a cone!
    const len = 6;
    const g = grid(3, 4, len);
    g.box(0, 1, 0, 2, 2, len - 1, C.signWhite);
    for (let x = 0; x <= 2; x++) g.set(x, 2, 1, C.winCool);   // windshield
    g.set(0, 2, 3, C.pink); g.set(2, 2, 3, C.pink);            // serving hatch trim
    g.set(2, 1, 3, C.winCool);                                // serving window
    g.box(0, 3, 2, 2, 3, len - 2, C.blossom);                 // pink roof
    g.set(1, 3, len - 2, C.amber); g.set(1, 3 + 0, len - 1, C.amber); // cone-ish topper
    g.set(1, 3, len - 3, C.pink);
    carWheels(g, len, C.black);
    g.set(0, 1, 0, C.win); g.set(2, 1, 0, C.win);
    return g.done();
  }

  // v === 4 — little firetruck OR blue pickup, alternate by variant parity
  if ((variant | 0) % 2 === 0) {
    // red firetruck with a ladder
    const len = 6;
    const g = grid(3, 4, len);
    g.box(0, 1, 0, 2, 2, len - 1, C.fireRed);
    for (let x = 0; x <= 2; x++) g.set(x, 2, 1, C.winCool);   // cab window
    g.box(0, 2, 3, 2, 2, len - 1, C.crimson);                // rear bay
    // ladder along the top
    for (let z = 2; z <= len - 1; z++) g.set(1, 3, z, C.metal);
    g.set(1, 3, 1, C.lamp);                                  // beacon
    carWheels(g, len, C.black);
    g.set(0, 1, 0, C.win); g.set(2, 1, 0, C.win);
    return g.done();
  }
  // blue pickup: cab up front, open bed at back
  const len = 6;
  const g = grid(3, 4, len);
  g.box(0, 1, 0, 2, 1, len - 1, C.roofBlue);       // chassis full length
  g.box(0, 2, 0, 2, 2, 2, C.roofBlue);             // cab
  for (let x = 0; x <= 2; x++) g.set(x, 2, 1, C.winCool);
  g.box(0, 3, 1, 2, 3, 2, C.roofBlue);             // cab roof
  // bed walls
  g.set(0, 2, len - 1, C.roofBlue); g.set(2, 2, len - 1, C.roofBlue);
  g.set(0, 2, 4, C.roofBlue); g.set(2, 2, 4, C.roofBlue);
  carWheels(g, len, C.black);
  g.set(0, 1, 0, C.win); g.set(2, 1, 0, C.win);
  return g.done();
}

// ---------------------------------------------------------------------------
// personModel(variant) — tiny people ~2x5x1, varied skin/shirt/hair
// ---------------------------------------------------------------------------
export function personModel(variant) {
  const rng = mulberry32(((variant | 0) >>> 0) + 201);
  const pick = a => a[(rng() * a.length) | 0];
  const skin = pick([C.skin1, C.skin2, C.skin3, C.skin4, C.skin5]);
  const shirt = pick([C.red, C.blue, C.teal, C.orange, C.purple, C.pGreen, C.pink,
    C.gold, C.roofGreen, C.navy, C.crimson, C.pYellow]);
  const pants = pick([C.navy, C.trunkDark, C.stoneDark, C.roofBlue, C.darkGray, C.brick]);
  const hair = pick([C.hairBlack, C.hairBrown, C.hairBlonde, C.hairAuburn, C.hairGray]);
  const g = grid(2, 5, 1);
  // legs
  g.set(0, 0, 0, pants); g.set(1, 0, 0, pants);
  // torso (two rows)
  g.set(0, 1, 0, shirt); g.set(1, 1, 0, shirt);
  g.set(0, 2, 0, shirt); g.set(1, 2, 0, shirt);
  // head
  g.set(0, 3, 0, skin); g.set(1, 3, 0, skin);
  // hair on top (sometimes a hat)
  if (rng() < 0.22) { const hat = pick([C.red, C.blue, C.gold, C.pGreen]); g.set(0, 4, 0, hat); g.set(1, 4, 0, hat); }
  else { g.set(0, 4, 0, hair); g.set(1, 4, 0, hair); }
  return g.done();
}

// ---------------------------------------------------------------------------
// birdModel / cloudModel / smokePuffModel
// ---------------------------------------------------------------------------
export function birdModel() {
  const g = grid(3, 2, 3);
  g.set(1, 0, 1, C.darkGray);   // body
  g.set(1, 1, 1, C.stoneDark);  // head
  g.set(0, 1, 1, C.darkGray);   // wings
  g.set(2, 1, 1, C.darkGray);
  g.set(1, 0, 0, C.orange);     // beak (front)
  return g.done();
}

export function cloudModel(variant) {
  const v = (((variant | 0) % 4) + 4) % 4;
  const rng = mulberry32(((variant | 0) >>> 0) + 301);
  const w = 4 + v, d = 3 + (v % 2), h = 2;
  const g = grid(w + 1, h, d + 1);
  for (let x = 1; x < w; x++) for (let z = 1; z < d; z++) g.set(x, 0, z, C.white);
  // puffy bumps on top
  const bumps = 2 + v;
  for (let i = 0; i < bumps; i++) {
    const bx = 1 + ((rng() * (w - 1)) | 0), bz = 1 + ((rng() * (d - 1)) | 0);
    g.set(bx, 1, bz, rng() < 0.3 ? C.offwhite : C.white);
  }
  return g.done();
}

export function smokePuffModel() {
  const g = grid(2, 2, 2);
  g.set(0, 0, 0, C.stoneDark); g.set(1, 0, 1, C.stone);
  g.set(1, 1, 0, C.sidewalk); g.set(0, 1, 1, C.offwhite);
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

// ===========================================================================
// SANDBOX CATALOG — directly-placeable buildings (CONTRACTS-SANDBOX.md)
// Every type instantly recognizable + different from its neighbours.
// Footprints tw×td tiles. Voxel canvas ≤ (tw*8-1) wide/deep; height caps by
// max(tw,td): 1→48, 2→64, 3→56, 4→64 (v3.2). catalogModel(id, variant) is
// deterministic via catRng; see _selfTest for the authoritative cap table.
// ===========================================================================

// deterministic PRNG seeded from a catalog id string + variant int
function catRng(id, variant) {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h = (h ^ Math.imul((variant | 0) + 1, 0x9e3779b1)) >>> 0;
  return mulberry32(h || 1);
}
const pk = (rng, a) => a[(rng() * a.length) | 0];

// FRONT NORMALIZATION (v2.1): every builder authors its front (door / entrance /
// sign / awning / marquee / gate) toward min-Z (z≈0). flipZ mirrors the model on
// the Z axis so the front lands on the +Z face (max-Z) for EVERY catalog model,
// as required by the facing convention. Determinism preserved (pure mirror).
function flipZ(m) {
  const sz = m.sz;
  for (const b of m.blocks) b[2] = sz - 1 - b[2];
  return m;
}

// --- shared shop shell: body from z=1, glass storefront, striped awning ------
function shopShell(fw, fd, bh, wall, accent) {
  const g = grid(fw, 12, fd), win = C.winCool;
  g.walls(0, 0, 1, fw - 1, bh - 1, fd - 1, wall);
  g.slab(0, 0, 1, fw - 1, fd - 1, C.concrete);
  g.slab(0, bh, 1, fw - 1, fd - 1, wall);
  for (let x = 1; x < fw - 1; x++) { g.set(x, 1, 1, win); g.set(x, 2, 1, win); }
  g.set(fw >> 1, 0, 1, C.woodDark);                       // door
  for (let x = 0; x < fw; x++) g.set(x, 3, 0, x % 2 ? accent : C.signWhite); // awning
  g.set(0, 2, 0, C.metalDark); g.set(fw - 1, 2, 0, C.metalDark);
  return g;
}
// small flat rooftop sign board helper
function signBoard(g, x0, x1, y, z, c) { for (let x = x0; x <= x1; x++) g.set(x, y, z, c); }

// ---- HOMES ----------------------------------------------------------------
function bSmallHouse(rng) {
  const wc = pk(rng, [C.pBlue, C.pYellow, C.pPink, C.pGreen, C.mint, C.peach, C.cream]);
  const rc = pk(rng, [C.roofRed, C.roofBlue, C.roofGreen, C.roofOrange, C.shingle, C.roofBrown]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const g = grid(5, 12, 5), bh = 4;
  g.slab(0, 0, 0, 4, 4, C.stoneDark);
  g.walls(0, 0, 0, 4, bh - 1, 4, wc);
  gableRoof(g, 0, 4, 0, 4, bh, wc, rc, 11);
  g.set(2, 0, 0, C.woodDark); g.set(2, 1, 0, C.woodDark);  // door
  g.set(1, 1, 0, win); g.set(3, 1, 0, win); g.set(1, 2, 0, win); g.set(3, 2, 0, win);
  for (let y = bh; y < bh + 3; y++) g.set(1, y, 1, C.brickDark); // chimney
  return g.done();
}
function bCottage(rng) {
  const wc = pk(rng, [C.cream, C.peach, C.mint, C.pYellow]);
  const rc = pk(rng, [C.roofBrown, C.shingle, C.roofRed]);
  const g = grid(5, 11, 5), bh = 4;
  g.slab(0, 0, 0, 4, 4, C.stoneDark);
  g.walls(0, 0, 0, 4, bh - 1, 4, wc);
  pyramidRoof(g, 0, 0, 4, 4, bh, rc, 10);
  g.set(2, 0, 0, C.woodDark); g.set(2, 1, 0, C.woodDark);
  g.set(1, 1, 0, C.win); g.set(3, 1, 0, C.win); g.set(1, 2, 0, C.win); g.set(3, 2, 0, C.win);
  g.set(1, 0, 0, C.blossom); g.set(3, 0, 0, C.red);       // window flower boxes
  for (let y = bh; y < bh + 2; y++) g.set(1, y, 1, C.brickDark);
  return g.done();
}
function bBigHouse(rng) {
  const wc = pk(rng, [C.pBlue, C.cream, C.peach, C.pGreen]);
  const rc = pk(rng, [C.roofRed, C.roofBlue, C.roofBrown]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const g = grid(6, 15, 6), bh = 7;
  g.slab(0, 0, 0, 5, 5, C.stoneDark);
  g.walls(0, 0, 0, 5, bh - 1, 5, wc);
  gableRoof(g, 0, 5, 0, 5, bh, wc, rc, 14);
  g.set(2, 0, 0, C.woodDark); g.set(2, 1, 0, C.woodDark);  // door
  g.set(4, 0, 0, C.stoneDark); g.set(4, 1, 0, C.stoneDark); // garage
  windowsOn(g, 0, 0, 5, 5, [1, 3, 4, 5], win);
  for (let y = bh; y < bh + 3; y++) g.set(4, y, 1, C.brickDark);
  return g.done();
}
function bTownhouse(rng) {
  const wc = pk(rng, [C.brick, C.peach, C.pPurple, C.pGreen]);
  const rc = pk(rng, [C.roofBrown, C.roofGray, C.shingle]);
  const band = pk(rng, [C.navy, C.stoneDark, C.brickDark]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const g = grid(5, 16, 6), bh = 11;
  g.slab(0, 0, 0, 4, 5, C.stoneDark);
  g.walls(0, 0, 0, 4, bh - 1, 5, wc);
  for (let x = 0; x < 5; x++) g.set(x, 3, 0, band);       // trim band
  g.slab(0, bh, 0, 4, 5, rc); g.walls(0, bh, 0, 4, bh, 5, band);
  g.set(2, 0, 0, C.woodDark); g.set(2, 1, 0, C.woodDark);
  windowsOn(g, 0, 0, 4, 5, [1, 4, 6, 8].filter(y => y < bh), win);
  for (let y = bh; y < bh + 3; y++) g.set(3, y, 1, C.brickDark);
  return g.done();
}
function bDuplex(rng) {
  const wc = pk(rng, [C.pYellow, C.mint, C.pPink, C.pBlue]);
  const rc = pk(rng, [C.roofRed, C.roofGreen, C.roofBlue]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const g = grid(7, 12, 5), bh = 5;
  g.slab(0, 0, 0, 6, 4, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 4, wc);
  gableRoof(g, 0, 6, 0, 4, bh, wc, rc, 11);
  for (let y = 0; y < bh; y++) g.set(3, y, 0, C.woodDark); // centre seam
  g.set(1, 0, 0, C.roofRed); g.set(1, 1, 0, C.roofRed);    // two doors
  g.set(5, 0, 0, C.roofBlue); g.set(5, 1, 0, C.roofBlue);
  g.set(2, 2, 0, win); g.set(4, 2, 0, win); g.set(2, 3, 0, win); g.set(4, 3, 0, win);
  return g.done();
}
function bCabin(rng) {
  const log = C.woodDark, log2 = C.trunk;
  const g = grid(5, 11, 5), bh = 4;
  g.slab(0, 0, 0, 4, 4, C.trunkDark);
  for (let y = 0; y < bh; y++) g.walls(0, y, 0, 4, y, 4, y % 2 ? log : log2); // log stripes
  gableRoof(g, 0, 4, 0, 4, bh, log, C.roofBrown, 10);
  g.set(2, 0, 0, C.trunkDark); g.set(2, 1, 0, C.trunkDark);
  g.set(1, 1, 0, C.win); g.set(3, 1, 0, C.win); g.set(1, 2, 0, C.win); g.set(3, 2, 0, C.win);
  for (let y = 1; y < bh + 3; y++) g.set(0, y, 2, C.stone); // stone chimney
  return g.done();
}
function bFarmhouse(rng) {
  const wc = pk(rng, [C.offwhite, C.cream, C.pYellow]);
  const g = grid(7, 13, 5), bh = 5;
  g.slab(0, 0, 0, 4, 4, C.stoneDark);
  g.walls(0, 0, 0, 4, bh - 1, 4, wc);
  gableRoof(g, 0, 4, 0, 4, bh, wc, C.roofRed, 11);
  g.set(2, 0, 0, C.woodDark); g.set(2, 1, 0, C.woodDark);
  g.set(1, 1, 0, C.win); g.set(3, 1, 0, C.win); g.set(1, 3, 0, C.win); g.set(3, 3, 0, C.win);
  for (let y = 0; y < 9; y++) g.box(5, y, 1, 6, y, 2, C.metal);  // silo
  g.box(5, 9, 1, 6, 9, 2, C.metalDark);                          // silo dome
  return g.done();
}
function bBeachHouse(rng) {
  const wc = pk(rng, [C.pBlue, C.mint, C.skyBlue, C.pYellow]);
  const rc = pk(rng, [C.roofBlue, C.teal, C.roofOrange]);
  const g = grid(6, 14, 6), base = 2, bh = 6;
  for (const [x, z] of [[0, 0], [5, 0], [0, 5], [5, 5]])
    for (let y = 0; y < base; y++) g.set(x, y, z, C.trunkDark);  // stilts
  g.slab(0, base - 1, 0, 5, 5, C.plank);                         // deck
  g.walls(0, base, 0, 5, base + bh - 1, 5, wc);
  g.slab(0, base + bh, 0, 5, 5, rc);
  g.set(2, base, 0, C.woodDark); g.set(2, base + 1, 0, C.woodDark);
  windowsOn(g, 0, 0, 5, 5, [base + 1, base + 3], C.winCool);
  g.set(2, 0, 0, C.wood); g.set(2, 1, 0, C.wood);                // steps
  return g.done();
}
function bApartment(rng) {
  const body = pk(rng, [C.brick, C.cream, C.offwhite, C.peach]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const g = grid(6, 18, 6), bh = 14;
  g.slab(0, 0, 0, 5, 5, C.stoneDark);
  g.walls(0, 0, 0, 5, bh - 1, 5, body);
  const rows = []; for (let y = 2; y < bh - 1; y += 2) rows.push(y);
  windowsOn(g, 0, 0, 5, 5, rows, win, 2);
  g.set(2, 0, 0, C.woodDark); g.set(3, 0, 0, C.woodDark);
  g.slab(0, bh, 0, 5, 5, C.concrete); g.walls(0, bh + 1, 0, 5, bh + 1, 5, C.stoneDark);
  acUnit(g, 1, bh + 1, 1, C.metal);
  return g.done();
}
function bTallApartment(rng) {
  const body = pk(rng, [C.pBlue, C.navy, C.teal, C.stoneDark]);
  const g = grid(6, 26, 6), bh = 22;
  g.slab(0, 0, 0, 5, 5, C.stoneDark);
  g.walls(0, 0, 0, 5, bh - 1, 5, body);
  const rows = []; for (let y = 2; y < bh - 1; y += 2) rows.push(y);
  windowsOn(g, 0, 0, 5, 5, rows, C.winCool, 1);
  g.box(2, 0, 0, 3, 1, 0, C.winCool);
  g.slab(0, bh, 0, 5, 5, C.concrete); g.walls(0, bh + 1, 0, 5, bh + 1, 5, C.stoneDark);
  g.box(1, bh + 1, 1, 2, bh + 3, 2, C.metalDark);                // water tank
  return g.done();
}
function bCondoTower(rng) {                                       // 2×2, tall toward the 34 cap
  const body = pk(rng, [C.pBlue, C.offwhite, C.teal, C.cream]);
  const S = 15, bh = 30;
  const g = grid(S, 34, S);
  g.slab(0, 0, 0, S - 1, S - 1, C.stoneDark);
  g.walls(0, 0, 0, S - 1, bh - 1, S - 1, body);
  const rows = []; for (let y = 2; y < bh - 1; y += 3) rows.push(y);
  windowsOn(g, 0, 0, S - 1, S - 1, rows, C.winCool, 2);
  for (let y = 4; y < bh; y += 3)                                // balconies on front
    for (let x = 2; x <= 12; x += 4) {
      g.set(x, y - 1, 0, C.concrete); g.set(x + 1, y - 1, 0, C.concrete);
      g.set(x, y, 0, C.metalDark); g.set(x + 1, y, 0, C.metalDark);
    }
  g.box(6, 0, 0, 8, 2, 0, C.winCool);                            // glass entrance
  g.slab(0, bh, 0, S - 1, S - 1, C.concrete); g.walls(0, bh + 1, 0, S - 1, bh + 1, S - 1, C.stoneDark);
  g.box(3, bh + 1, 3, 4, bh + 3, 4, C.metalDark);                // rooftop water tank
  return g.done();
}
function bMansion(rng) {
  const wall = pk(rng, [C.cream, C.offwhite, C.pYellow]);
  const roof = pk(rng, [C.roofRed, C.roofBlue, C.roofGray]);
  const g = grid(15, 18, 13), bh = 8;
  g.slab(0, 0, 0, 14, 12, C.stoneDark);
  g.walls(3, 0, 0, 11, bh - 1, 10, wall); g.slab(3, bh, 0, 11, 10, roof);      // centre
  g.walls(0, 0, 2, 3, 5, 8, wall); g.slab(0, 6, 2, 3, 8, roof);                // left wing
  g.walls(11, 0, 2, 14, 5, 8, wall); g.slab(11, 6, 2, 14, 8, roof);            // right wing
  for (const cx of [4, 6, 8, 10]) for (let y = 0; y < bh - 1; y++) g.set(cx, y, 0, C.signWhite); // columns
  signBoard(g, 4, 10, bh - 1, 0, wall);                          // portico beam
  g.box(6, 0, 0, 8, 2, 0, C.woodDark);                           // grand door
  windowsOn(g, 3, 0, 11, 10, [2, 4].filter(y => y < bh), C.win, 2);
  g.box(6, bh + 1, 4, 8, bh + 2, 6, roof); g.set(7, bh + 3, 5, C.gold);        // pediment
  // wing windows on every wall face (fixes the "plain box from behind")
  for (const wz of [3, 5, 7]) {
    g.set(0, 2, wz, C.win); g.set(0, 4, wz, C.win);              // left wing outer
    g.set(14, 2, wz, C.win); g.set(14, 4, wz, C.win);           // right wing outer
    g.set(2, 2, wz, C.win); g.set(12, 2, wz, C.win);            // wing back faces
  }
  g.set(1, 2, 2, C.win); g.set(13, 2, 2, C.win);                // wing front faces
  g.set(2, 2, 8, C.win); g.set(12, 2, 8, C.win);
  // hedge garden hugging the front + rear
  for (const gx of [1, 5, 9, 13]) { g.set(gx, 0, 0, C.leafMid); g.set(gx, 0, 12, C.leafDark); }
  return g.done();
}

// ---- SHOPS ----------------------------------------------------------------
function bBakery(rng) {
  const g = shopShell(5, 5, 5, pk(rng, [C.cream, C.peach]), C.roofBrown);
  g.box(1, 6, 2, 3, 6, 2, C.wood); g.set(2, 7, 2, C.woodDark);   // bread loaf sign
  g.set(1, 7, 2, C.plank); g.set(3, 7, 2, C.plank);
  return g.done();
}
function bIceCream(rng) {
  const g = shopShell(5, 5, 5, pk(rng, [C.pPink, C.pBlue, C.mint]), C.pink);
  const s1 = pk(rng, [C.blossom, C.red, C.pYellow]), s2 = pk(rng, [C.mint, C.teal, C.gold]);
  g.set(2, 6, 2, C.amber);                                       // giant cone
  g.box(1, 7, 1, 3, 7, 3, C.amber);
  g.box(1, 8, 1, 3, 8, 3, s1); g.box(1, 9, 1, 3, 9, 3, s2); g.set(2, 10, 2, C.red); // scoops + cherry
  return g.done();
}
function bPizza(rng) {
  const g = shopShell(5, 5, 5, C.offwhite, C.red);
  g.box(1, 6, 2, 3, 6, 2, C.gold);                               // crust
  g.set(1, 7, 2, C.red); g.set(2, 7, 2, C.red); g.set(2, 8, 2, C.red); // slice tip
  g.set(1, 6, 2, C.crimson); g.set(3, 6, 2, C.crimson);          // pepperoni
  return g.done();
}
function bBurger(rng) {
  const g = shopShell(5, 5, 5, C.pYellow, C.roofRed);
  g.box(1, 6, 2, 3, 6, 2, C.amber); g.box(1, 7, 2, 3, 7, 2, C.trunkDark); // bun + patty
  g.box(1, 8, 2, 3, 8, 2, C.roofGreen); g.box(1, 9, 2, 3, 9, 2, C.amber); // lettuce + bun
  return g.done();
}
function bCafe(rng) {
  const g = shopShell(5, 5, 5, C.peach, C.teal);
  g.box(1, 6, 2, 2, 7, 2, C.signWhite); g.set(1, 6, 2, C.woodDark); // coffee cup
  g.set(3, 6, 2, C.signWhite);                                   // handle
  g.set(1, 8, 2, C.offwhite);                                    // steam
  return g.done();
}
function bToyStore(rng) {
  const g = shopShell(5, 5, 5, C.pGreen, pk(rng, [C.orange, C.red, C.blue]));
  g.set(1, 6, 2, C.red); g.set(2, 6, 2, C.blue); g.set(3, 6, 2, C.yellow); // blocks
  g.set(1, 7, 2, C.pGreen); g.set(2, 7, 2, C.orange);
  g.set(3, 8, 2, C.red); g.set(3, 7, 2, C.metalDark);            // balloon
  return g.done();
}
function bPetShop(rng) {
  const g = shopShell(5, 5, 5, C.pBlue, C.roofBrown);
  g.box(1, 6, 2, 3, 7, 2, C.woodDark); g.set(2, 6, 2, C.black);  // doghouse
  g.set(1, 8, 2, C.roofRed); g.set(2, 8, 2, C.roofRed); g.set(3, 8, 2, C.roofRed);
  g.set(0, 6, 2, C.signWhite);                                   // bone
  return g.done();
}
function bBookShop(rng) {
  const g = shopShell(5, 5, 5, C.cream, C.navy);
  g.box(1, 6, 1, 1, 6, 3, C.signWhite); g.box(3, 6, 1, 3, 6, 3, C.signWhite); // open pages
  g.set(2, 6, 2, C.woodDark); g.set(2, 7, 2, C.navy);            // spine
  return g.done();
}
function bFlowerShop(rng) {
  const g = shopShell(5, 5, 5, C.mint, C.pink);
  g.set(1, 0, 0, C.blossom); g.set(2, 0, 0, C.pYellow); g.set(3, 0, 0, C.red); // window boxes
  g.set(2, 7, 2, C.gold);                                        // big daisy
  g.set(1, 7, 2, C.pink); g.set(3, 7, 2, C.pink); g.set(2, 6, 2, C.leafMid); g.set(2, 8, 2, C.pink);
  return g.done();
}
function bGrocery(rng) {
  const g = shopShell(6, 5, 5, C.offwhite, C.roofGreen);
  g.set(0, 0, 0, C.orange); g.set(5, 0, 0, C.red);               // produce bins
  signBoard(g, 1, 4, 6, 3, C.roofGreen); g.set(2, 7, 3, C.signWhite); g.set(3, 7, 3, C.signWhite);
  return g.done();
}
function bMarketStall(rng) {
  const canopy = pk(rng, [C.red, C.blue, C.roofGreen, C.orange]);
  const g = grid(6, 6, 5);
  for (const [x, z] of [[0, 0], [5, 0], [0, 4], [5, 4]]) for (let y = 0; y < 4; y++) g.set(x, y, z, C.woodDark);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 5; z++) g.set(x, 4, z, x % 2 ? canopy : C.signWhite);
  g.box(0, 0, 0, 5, 1, 0, C.wood);                               // counter
  g.set(1, 2, 0, C.red); g.set(2, 2, 0, C.orange); g.set(3, 2, 0, C.roofGreen); g.set(4, 2, 0, C.pYellow);
  return g.done();
}
function bArcade(rng) {
  const g = grid(5, 13, 5), bh = 7;
  g.walls(0, 0, 0, 4, bh - 1, 4, C.navy);
  g.slab(0, 0, 0, 4, 4, C.concrete); g.slab(0, bh, 0, 4, 4, C.darkGray);
  for (let y = 1; y < bh; y++) { g.set(0, y, 0, C.neon); g.set(4, y, 0, C.neon); } // corner neon
  g.set(2, 0, 0, C.black); g.set(2, 1, 0, C.winCool);            // entrance
  for (let x = 1; x < 4; x++) { g.set(x, 2, 0, C.neon); g.set(x, 3, 0, C.win); g.set(x, 5, 0, C.win); }
  g.box(1, bh + 1, 2, 3, bh + 2, 2, C.neon); g.set(2, bh + 3, 2, C.win); // sign + star
  return g.done();
}
function bCinema(rng) {                                          // 2×1
  const wall = pk(rng, [C.crimson, C.navy, C.roofPurple]);
  const g = grid(13, 12, 6), bh = 7;
  g.walls(0, 0, 1, 12, bh - 1, 5, wall);
  g.slab(0, 0, 1, 12, 5, C.concrete); g.slab(0, bh, 1, 12, 5, C.darkGray);
  for (let x = 0; x < 13; x++) { g.set(x, 4, 0, C.gold); g.set(x, 3, 0, x % 2 ? C.win : C.neon); } // marquee
  g.set(0, 3, 0, C.metalDark); g.set(12, 3, 0, C.metalDark);
  for (let x = 2; x < 11; x += 2) g.set(x, 5, 1, C.neon);        // letters
  g.box(5, 0, 1, 7, 2, 1, C.black);                              // doors
  g.set(2, 1, 1, C.win); g.set(10, 1, 1, C.win);                 // posters
  for (let y = bh + 1; y < bh + 4; y++) g.set(6, y, 3, C.neon);  // vertical sign
  return g.done();
}
function bMall(rng) {                                            // 3×3, wide with skylit atrium
  const wall = pk(rng, [C.concrete, C.offwhite, C.pBlue]);
  const S = 23;
  const g = grid(S, 24, S), bh = 10;
  g.slab(0, 0, 0, S - 1, S - 1, C.stoneDark);
  g.walls(0, 0, 0, S - 1, bh - 1, S - 1, wall); g.slab(0, bh, 0, S - 1, S - 1, wall);
  for (let x = 3; x <= S - 4; x += 2) for (let z = 3; z <= S - 4; z += 2) g.set(x, bh, z, C.winCool); // skylit atrium roof
  for (let x = 2; x <= S - 3; x++) for (let y = 1; y <= 3; y++) g.set(x, y, 0, C.winCool);            // storefront glass row (front)
  g.box(10, 0, 0, 12, 2, 0, C.woodDark);                        // entry doors
  windowsOn(g, 0, 0, S - 1, S - 1, [5, 7].filter(y => y < bh), C.winCool, 2);
  for (let x = 2; x <= S - 3; x++) g.set(x, 4, 0, x % 2 ? C.red : C.blue); // entry canopy
  signBoard(g, 7, 15, bh + 1, 11, C.signWhite); g.set(11, bh + 2, 11, C.red); // rooftop sign
  acUnit(g, 4, bh, 4, C.metal); acUnit(g, S - 5, bh, S - 5, C.metal);
  return g.done();
}

function bCandyShop(rng) {
  const g = shopShell(5, 5, 5, pk(rng, [C.pPink, C.pPurple, C.mint]), pk(rng, [C.red, C.blossom, C.teal]));
  for (let y = 6; y <= 8; y++) g.set(2, y, 2, C.signWhite);      // lollipop stick
  g.box(1, 9, 1, 3, 10, 3, C.blossom);                          // candy swirl ball
  g.set(2, 9, 2, C.red); g.set(1, 9, 2, C.pYellow); g.set(3, 9, 2, C.teal); g.set(2, 10, 2, C.pink);
  g.set(1, 0, 0, C.red); g.set(3, 0, 0, C.teal);                // candy jars in the window
  return g.done();
}
function bMusicStore(rng) {
  const g = shopShell(5, 5, 5, pk(rng, [C.navy, C.roofPurple, C.roofBlue]), pk(rng, [C.gold, C.pink, C.orange]));
  for (let y = 6; y <= 9; y++) g.set(3, y, 2, C.black);        // note stem
  g.box(1, 6, 2, 2, 7, 2, C.black);                           // note head
  g.set(1, 6, 2, C.neon);                                     // glowing head accent
  g.set(3, 9, 2, C.black); g.set(4, 8, 2, C.black);           // flag
  return g.done();
}
function bSportsShop(rng) {
  const g = shopShell(5, 5, 5, pk(rng, [C.pGreen, C.pBlue]), pk(rng, [C.orange, C.red, C.navy]));
  const ball = pk(rng, [C.signWhite, C.orange, C.red]);
  g.box(1, 6, 1, 3, 8, 3, ball);                              // big ball on roof
  g.set(1, 7, 2, C.black); g.set(3, 7, 2, C.black);           // seams
  g.set(2, 6, 2, C.black); g.set(2, 8, 2, C.black);
  return g.done();
}
function bBarber(rng) {
  const g = shopShell(5, 5, 5, pk(rng, [C.offwhite, C.pBlue]), C.red);
  // the striped barber pole is the animated part (catalogAnim); base keeps shop + sign
  g.set(1, 6, 2, C.metal); g.set(3, 6, 2, C.metal); g.set(2, 7, 2, C.metalDark); // scissors sign
  return g.done();
}
function bDiner(rng) {
  const g = grid(6, 12, 5), bh = 6;
  g.walls(0, 0, 1, 5, bh - 1, 4, C.metal);                     // chrome body
  g.slab(0, 0, 1, 5, 4, C.concrete);
  g.slab(0, bh, 1, 5, 4, C.signWhite);                         // white roof
  for (let x = 0; x < 6; x++) g.set(x, 2, 1, x % 2 ? C.red : C.metal); // red diner stripe
  for (let x = 1; x < 5; x++) { g.set(x, 1, 1, C.winCool); g.set(x, 3, 1, C.winCool); g.set(x, 4, 1, C.winCool); } // big windows
  g.set(2, 0, 1, C.woodDark); g.set(3, 0, 1, C.woodDark);      // door
  for (let x = 1; x <= 4; x++) g.set(x, bh + 1, 2, C.red);     // rooftop sign board
  for (let x = 1; x <= 4; x += 2) g.set(x, bh + 2, 2, C.neon); // neon letters
  return g.done();
}
function bFruitStand(rng) {
  const canopy = pk(rng, [C.red, C.roofGreen, C.orange]);
  const g = grid(6, 7, 5);
  for (const [x, z] of [[0, 0], [5, 0], [0, 4], [5, 4]]) for (let y = 0; y < 4; y++) g.set(x, y, z, C.wood);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 5; z++) g.set(x, 4, z, x % 2 ? canopy : C.signWhite); // canopy
  g.box(0, 0, 0, 5, 1, 0, C.woodDark);                         // counter (front)
  g.set(1, 2, 0, C.red); g.set(2, 2, 0, C.orange); g.set(3, 2, 0, C.roofGreen); g.set(4, 2, 0, C.pYellow);
  g.set(1, 3, 0, C.crimson); g.set(4, 3, 0, C.leafMid);        // stacked fruit
  g.set(2, 5, 2, C.red); g.set(3, 5, 2, C.red); g.set(2, 6, 2, C.leafMid); // big apple sign
  return g.done();
}

// ---- FACTORIES ------------------------------------------------------------
// shared factory shell: walls + slab roof + roll-up door authored at the front
function facShell(fw, fd, bh, wall, roof, door) {
  const g = grid(fw, 14, fd);
  g.walls(0, 0, 0, fw - 1, bh - 1, fd - 1, wall);
  g.slab(0, 0, 0, fw - 1, fd - 1, C.stoneDark);
  g.slab(0, bh, 0, fw - 1, fd - 1, roof);
  g.box(1, 0, 0, 3, 2, 0, door);                               // roll-up door (front)
  return g;
}
function bWorkshop(rng) {
  const wall = pk(rng, [C.brick, C.concrete, C.sandDark]);
  const g = grid(5, 10, 5), bh = 6;
  g.walls(0, 0, 0, 4, bh - 1, 4, wall);
  g.slab(0, 0, 0, 4, 4, C.stoneDark); g.slab(0, bh, 0, 4, 4, C.metalDark);
  g.box(1, 0, 0, 3, 2, 0, pk(rng, [C.orange, C.red, C.blue]));  // roll-up door
  for (let x = 1; x < 4; x++) { g.set(x, 3, 4, C.winCool); g.set(x, 4, 4, C.winCool); }
  acUnit(g, 1, bh, 1, C.metal);
  for (let y = bh; y < bh + 2; y++) g.set(3, y, 1, C.metal);
  return g.done();
}
function bToyFactory(rng) {
  const wall = pk(rng, [C.pBlue, C.pYellow, C.pGreen, C.pPink]);
  const g = grid(6, 14, 6), bh = 8;
  g.walls(0, 0, 0, 5, bh - 1, 5, wall);
  g.slab(0, 0, 0, 5, 5, C.stoneDark); g.slab(0, bh, 0, 5, 5, C.roofRed);
  g.box(1, 0, 0, 3, 2, 0, C.woodDark);
  windowsOn(g, 0, 0, 5, 5, [2, 4, 6].filter(y => y < bh), C.win, 2);
  g.box(1, bh + 1, 2, 2, bh + 2, 3, C.red); g.set(1, bh + 1, 2, C.yellow); // toy block
  g.set(4, bh, 3, C.trunk); g.set(4, bh + 1, 3, C.trunk);        // teddy head
  for (let y = bh; y < bh + 3; y++) g.set(4, y, 1, C.brick);
  return g.done();
}
function bChocolate(rng) {
  const g = grid(6, 15, 6), bh = 6;
  g.walls(0, 0, 0, 5, bh - 1, 5, C.woodDark);
  g.slab(0, 0, 0, 5, 5, C.trunkDark); g.slab(0, bh, 0, 5, 5, C.roofBrown);
  g.box(1, 0, 0, 3, 3, 0, C.dirtDark);
  windowsOn(g, 0, 0, 5, 5, [2, 4].filter(y => y < bh), C.win);
  g.box(3, bh, 1, 5, bh + 2, 3, C.trunk); g.set(4, bh + 3, 2, C.dirtDark); // choc vat drum
  for (const [x, y] of [[1, bh], [1, bh + 1], [2, bh + 2], [2, bh + 3], [1, bh + 4], [1, bh + 5]])
    g.set(x, y, 1, C.stoneDark);                                 // curly chimney
  g.set(1, bh + 6, 1, C.dirt);                                   // choc puff
  return g.done();
}
function bRobotFactory(rng) {
  const g = grid(6, 15, 6), bh = 8;
  g.walls(0, 0, 0, 5, bh - 1, 5, C.steel);
  g.slab(0, 0, 0, 5, 5, C.stoneDark); g.slab(0, bh, 0, 5, 5, C.metalDark);
  g.box(1, 0, 0, 3, 2, 0, C.darkGray);
  windowsOn(g, 0, 0, 5, 5, [2, 4, 6].filter(y => y < bh), C.winCool, 1);
  g.box(1, bh + 1, 2, 3, bh + 3, 4, C.metal);                    // robot head
  g.set(1, bh + 2, 2, C.winCool); g.set(3, bh + 2, 2, C.winCool); // eyes
  g.set(2, bh + 4, 3, C.metalDark); g.set(2, bh + 5, 3, C.red);  // antenna
  g.set(4, 3, 0, C.gold);                                        // gear
  return g.done();
}
function bRocketLab(rng) {                                        // 2×2, taller gantry + bigger rocket
  const S = 15;
  const g = grid(S, 34, S), bh = 6;
  // control building on the left/front (min-Z)
  g.walls(0, 0, 0, 6, bh - 1, S - 1, C.offwhite);
  g.slab(0, 0, 0, 6, S - 1, C.stoneDark); g.slab(0, bh, 0, 6, S - 1, C.metal);
  g.box(2, 0, 0, 4, 2, 0, C.steel); g.set(3, 3, 0, C.winCool);   // door + window (front)
  windowsOn(g, 0, 0, 6, S - 1, [2, 4].filter(y => y < bh), C.winCool, 2);
  // launch pad + big rocket
  const rx = 10, rz = 8;
  g.box(rx - 2, 0, rz - 2, rx + 2, 0, rz + 2, C.metalDark);      // launch pad
  for (let y = 1; y <= 22; y++) g.set(rx, y, rz, C.signWhite);   // tall rocket body
  for (let y = 6; y <= 16; y++) {                                // fatter mid-section
    g.set(rx - 1, y, rz, C.offwhite); g.set(rx + 1, y, rz, C.offwhite);
    g.set(rx, y, rz - 1, C.offwhite); g.set(rx, y, rz + 1, C.offwhite);
  }
  g.set(rx, 10, rz, C.red); g.set(rx, 15, rz, C.red); g.set(rx, 12, rz, C.winCool); // bands + window
  g.set(rx, 23, rz, C.red); g.set(rx, 24, rz, C.crimson);        // nose cone
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { g.set(rx + dx, 1, rz + dz, C.red); g.set(rx + dx, 2, rz + dz, C.crimson); } // fins
  // service gantry tower beside the rocket
  const tx = 13;
  for (let y = 0; y <= 20; y++) g.set(tx, y, rz, C.metalDark);
  for (let y = 4; y <= 20; y += 4) for (let x = rx + 2; x <= tx; x++) g.set(x, y, rz, C.steel); // gantry arms
  return g.done();
}
function bSawmill(rng) {
  const g = grid(7, 10, 5), bh = 4;
  g.walls(0, 0, 0, 4, bh - 1, 4, C.wood);
  g.slab(0, 0, 0, 4, 4, C.trunkDark);
  gableRoof(g, 0, 4, 0, 4, bh, C.wood, C.roofBrown, 10);
  g.box(1, 0, 0, 3, 2, 0, C.trunkDark);
  g.set(5, 0, 3, C.trunkDark); g.set(6, 0, 3, C.trunk); g.set(5, 1, 3, C.trunk); // log pile
  g.set(6, 1, 3, C.trunkDark);
  g.set(5, 2, 1, C.metal); g.set(6, 2, 1, C.metalDark); g.set(5, 3, 1, C.metal); // saw blade
  return g.done();
}
function bWarehouse(rng) {
  const wall = pk(rng, [C.sandDark, C.metal, C.stone]);
  const g = grid(7, 11, 6), bh = 7;
  g.walls(0, 0, 0, 6, bh - 1, 5, wall);
  g.slab(0, 0, 0, 6, 5, C.stoneDark); g.slab(0, bh, 0, 6, 5, C.roofGray);
  g.box(1, 0, 0, 2, 4, 0, C.metalDark); g.box(4, 0, 0, 5, 4, 0, C.metalDark); // tall roll doors
  for (let x = 1; x < 6; x++) { g.set(x, 5, 5, C.winCool); g.set(x, 6, 5, C.winCool); }
  g.box(1, bh + 1, 2, 2, bh + 1, 3, C.wood); g.set(4, bh + 1, 3, C.woodDark); // crates
  return g.done();
}
function bRecycling(rng) {
  const g = grid(6, 10, 6), bh = 4;
  g.walls(0, 0, 1, 5, bh - 1, 5, C.offwhite);
  g.slab(0, 0, 1, 5, 5, C.stoneDark); g.slab(0, bh, 1, 5, 5, C.roofGreen);
  g.box(2, 0, 1, 3, 2, 1, C.woodDark);
  g.box(0, 0, 0, 1, 2, 0, C.blue); g.box(2, 0, 0, 3, 2, 0, C.roofGreen); g.box(4, 0, 0, 5, 2, 0, C.yellow); // bins
  g.set(2, bh + 1, 3, C.roofGreen); g.set(3, bh + 1, 3, C.leafMid); // recycle arrows
  g.set(2, bh + 2, 3, C.leafMid); g.set(3, bh + 2, 3, C.roofGreen);
  return g.done();
}
function bMegaFactory(rng) {                                     // 3×3, tall & bulky
  const wall = pk(rng, [C.concrete, C.steel, C.sandDark]);
  const S = 23;
  const g = grid(S, 34, S), bh = 14;
  g.walls(0, 0, 0, S - 1, bh - 1, S - 1, wall);
  g.slab(0, 0, 0, S - 1, S - 1, C.stoneDark); g.slab(0, bh, 0, S - 1, S - 1, C.roofGray);
  for (const x0 of [1, 6, 11, 16]) g.box(x0, 0, 0, x0 + 2, 4, 0, C.orange);   // loading bays (front)
  windowsOn(g, 0, 0, S - 1, S - 1, [3, 6, 9, 12].filter(y => y < bh), C.winCool, 2);
  for (const [cx, cz] of [[3, 3], [11, 3], [19, 3], [7, 19], [15, 19]]) {     // chimney stacks
    for (let y = bh; y < 28; y++) g.set(cx, y, cz, C.brick);
    g.set(cx, 28, cz, C.brickDark);
  }
  for (const [tx, tz] of [[4, 14], [9, 14], [14, 14]]) {                      // storage tanks
    g.box(tx, bh, tz, tx + 2, bh + 4, tz + 2, C.metal);
    g.slab(tx, bh + 5, tz, tx + 2, tz + 2, C.metalDark);
  }
  for (let x = 1; x < S - 1; x++) g.set(x, bh, 11, C.metalDark); // pipe runs
  for (let z = 1; z < S - 1; z++) g.set(11, bh, z, C.steel);
  return g.done();
}

function bCheese(rng) {
  const g = facShell(6, 5, 5, C.pYellow, C.gold, C.woodDark);
  windowsOn(g, 0, 0, 5, 4, [3], C.win);
  for (let x = 1; x <= 4; x++) for (let y = 6; y <= 6 + (4 - x); y++) g.set(x, y, 2, C.yellow); // cheese wedge
  g.set(2, 6, 2, C.gold); g.set(3, 7, 2, C.gold); g.set(1, 7, 2, C.amber); // holes
  return g.done();
}
function bCrayon(rng) {
  const g = facShell(6, 5, 5, C.offwhite, C.roofBlue, C.red);
  windowsOn(g, 0, 0, 5, 4, [3], C.winCool);
  const cols = [C.red, C.blue, C.roofGreen, C.orange, C.purple]; let i = 0;
  for (const x of [1, 3]) {
    const c = cols[(i++ + (rng() * 5 | 0)) % cols.length];
    for (let y = 6; y <= 9; y++) g.set(x, y, 2, c);            // crayon body
    g.set(x, 6, 2, C.signWhite);                              // label band
    g.set(x, 10, 2, C.trunkDark);                            // pointed tip
  }
  return g.done();
}
function bBalloonFactory(rng) {
  const g = facShell(6, 5, 5, C.pPink, C.pPurple, C.blue);
  windowsOn(g, 0, 0, 5, 4, [3], C.win);
  const cols = [C.red, C.blue, C.roofGreen, C.pYellow, C.pink]; let i = 0;
  for (const [x, top] of [[1, 8], [3, 10], [4, 8], [2, 9]]) {
    for (let y = 6; y < top; y++) g.set(x, y, 2, C.signWhite); // string
    g.set(x, top, 2, cols[i++ % cols.length]);               // balloon
    g.set(x, top + 1, 2, cols[i % cols.length]);
  }
  return g.done();
}
function bCarFactory(rng) {
  const g = grid(7, 12, 6), bh = 7;
  g.walls(0, 0, 0, 6, bh - 1, 5, C.steel);
  g.slab(0, 0, 0, 6, 5, C.stoneDark); g.slab(0, bh, 0, 6, 5, C.metalDark);
  g.box(1, 0, 0, 2, 3, 0, C.blue); g.box(4, 0, 0, 5, 3, 0, C.blue); // two bay doors
  windowsOn(g, 0, 0, 6, 5, [4, 6].filter(y => y < bh), C.winCool, 1);
  g.box(2, bh + 1, 2, 4, bh + 1, 2, C.red); g.set(2, bh + 2, 2, C.red); g.set(3, bh + 2, 2, C.winCool); // little car sign
  g.set(2, bh, 2, C.black); g.set(4, bh, 2, C.black);          // wheels
  return g.done();
}
function bBakeryPlant(rng) {
  const g = facShell(6, 5, 5, C.cream, C.roofBrown, C.woodDark);
  windowsOn(g, 0, 0, 5, 4, [3], C.win);
  const cx = 2, cy = 8;                                        // giant frosted donut sign
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]])
    g.set(cx + dx, cy + dy, 2, C.pink);
  g.set(cx - 1, cy + 1, 2, C.signWhite); g.set(cx + 1, cy - 1, 2, C.red); // sprinkles
  for (let y = 5; y < 8; y++) g.set(4, y, 1, C.brick);         // oven stack
  return g.done();
}
function bGreenhouse(rng) {
  const g = grid(7, 9, 6), bh = 4;
  g.walls(0, 0, 0, 6, bh - 1, 5, C.winCool);                   // glass walls
  g.slab(0, 0, 0, 6, 5, C.dirtDark);
  gableRoof(g, 0, 6, 0, 5, bh, C.metal, C.winCool, 9);         // glass gable roof
  g.set(3, 0, 0, C.woodDark); g.set(3, 1, 0, C.woodDark);      // door (front)
  for (let x = 1; x <= 5; x += 2) for (let z = 1; z <= 4; z += 2) { g.set(x, 1, z, C.leafMid); g.set(x, 2, z, C.leafLight); }
  g.set(1, 2, 1, C.red); g.set(5, 2, 3, C.blossom); g.set(3, 2, 3, C.orange); // crops
  return g.done();
}

// ---- FUN ------------------------------------------------------------------
function bPlayground(rng) {
  const g = grid(7, 7, 7);
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) g.set(x, 0, z, rng() < 0.2 ? C.grassLight : C.grassMid);
  for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) g.set(x, 0, z, C.sand); // sandbox
  g.set(1, 1, 1, C.metalDark); g.set(1, 2, 1, C.metalDark); g.set(1, 3, 1, C.red);  // slide ladder
  g.set(1, 3, 2, C.red); g.set(2, 2, 2, C.yellow); g.set(2, 1, 3, C.yellow); g.set(3, 1, 3, C.red); // slope
  g.set(4, 1, 1, C.wood); g.set(6, 1, 1, C.wood); signBoard(g, 4, 6, 3, 1, C.wood); // swing frame
  g.set(5, 2, 1, C.metalDark); g.set(5, 1, 1, C.blue);          // swing seat
  g.set(3, 1, 5, C.orange); g.set(4, 1, 5, C.orange);           // see-saw
  return g.done();
}
function bSwimmingPool(rng) {
  const g = grid(7, 5, 7);
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) g.set(x, 0, z, C.concrete);
  for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) g.set(x, 0, z, rng() < 0.4 ? C.waterLight : C.waterMid);
  g.set(2, 0, 2, C.signWhite); g.set(4, 0, 4, C.signWhite);     // lane lines
  g.set(6, 1, 3, C.metalDark); g.set(5, 2, 3, C.signWhite); g.set(4, 2, 3, C.signWhite); // diving board
  g.set(1, 1, 1, C.metal);                                      // ladder
  g.set(0, 1, 6, C.metalDark); g.set(0, 2, 6, C.metalDark); g.box(0, 3, 5, 1, 3, 6, C.red); // umbrella
  return g.done();
}
function bFerrisWheel(rng) {                                     // 3×3 — big wheel is animated (catalogAnim)
  const S = 23;
  const g = grid(S, 26, S);
  const cx = 11, hubY = 20;
  g.box(5, 0, 5, 17, 0, 17, C.concrete);                        // base pad
  for (const lz of [7, 15]) {                                   // two A-frames flanking the wheel plane (z=11)
    for (let i = 0; i <= hubY; i++) {
      const t = i / hubY;
      g.set(Math.round(cx - 7 + 7 * t), i, lz, C.steel);
      g.set(Math.round(cx + 7 - 7 * t), i, lz, C.steel);
    }
  }
  for (let z = 7; z <= 15; z++) g.set(cx, hubY, z, C.metalDark); // axle
  g.box(cx - 1, 0, 0, cx + 1, 2, 0, C.red); g.set(cx, 1, 0, C.winCool); // ticket booth (front)
  signBoard(g, cx - 1, cx + 1, 3, 0, C.gold);
  return g.done();
}
function bZoo(rng) {                                             // 3×3 — bigger grounds, chunky animals, pond, paths
  const S = 23;
  const g = grid(S, 14, S);
  for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) g.set(x, 0, z, rng() < 0.15 ? C.grassLight : C.grassMid);
  for (let x = 0; x < S; x += 2) { g.set(x, 1, 0, C.wood); g.set(x, 1, S - 1, C.wood); } // perimeter fence
  for (let z = 0; z < S; z += 2) { g.set(0, 1, z, C.wood); g.set(S - 1, 1, z, C.wood); }
  const gc = 11;                                                // gate (front min-Z)
  g.set(gc - 1, 1, 0, C.woodDark); g.set(gc + 1, 1, 0, C.woodDark);
  g.set(gc - 1, 2, 0, C.woodDark); g.set(gc + 1, 2, 0, C.woodDark);
  signBoard(g, gc - 2, gc + 2, 3, 0, C.red);                    // arch sign
  for (let z = 1; z < S - 1; z++) g.set(gc, 0, z, C.sand);      // paths
  for (let x = 1; x < S - 1; x++) g.set(x, 0, 11, C.sand);
  for (let x = 3; x <= 7; x++) for (let z = 15; z <= 19; z++) g.set(x, 0, z, rng() < 0.5 ? C.waterLight : C.waterMid); // pond
  // giraffe (tall yellow)
  const gx = 5, gz = 5;
  g.box(gx, 1, gz, gx + 2, 3, gz + 1, C.gold);
  for (let y = 4; y <= 8; y++) g.set(gx + 2, y, gz, C.gold);
  g.set(gx + 2, 9, gz, C.gold); g.set(gx + 3, 9, gz, C.gold); g.set(gx + 3, 8, gz, C.trunkDark);
  // elephant (gray)
  const ex = 15, ez = 6;
  g.box(ex, 1, ez, ex + 3, 3, ez + 2, C.stone);
  g.set(ex - 1, 2, ez, C.stone); g.set(ex - 2, 1, ez, C.stone); g.set(ex - 2, 2, ez, C.stoneDark);
  g.set(ex + 3, 4, ez, C.stoneDark);
  // lion (brown with mane)
  const lx = 15, lz = 15;
  g.box(lx, 1, lz, lx + 2, 2, lz + 1, C.trunk);
  g.set(lx - 1, 1, lz, C.trunk); g.set(lx - 1, 2, lz, C.hairAuburn); g.set(lx - 1, 2, lz + 1, C.hairAuburn);
  miniTree(g, 3, 3, C.leafMid); miniTree(g, 19, 4, C.blossom); miniTree(g, 19, 19, C.leafDark);
  return g.done();
}

function bCarousel(rng) {                                        // 2×2 — canopy + horses are animated (catalogAnim)
  const S = 15, cx = 7, cz = 7;
  const g = grid(S, 16, S);
  for (let x = 1; x < S - 1; x++) for (let z = 1; z < S - 1; z++) {
    const d = (x - cx) ** 2 + (z - cz) ** 2;
    if (d <= 36) g.set(x, 0, z, (x + z) % 2 ? C.signWhite : C.red);   // round platform
    else if (d <= 44) g.set(x, 0, z, C.stoneDark);                     // step ring
  }
  for (let y = 1; y <= 12; y++) g.set(cx, y, cz, C.gold);      // center pole
  g.set(cx, 0, 0, C.neon);                                     // entrance marker (front)
  return g.done();
}
function bWaterSlide(rng) {
  const g = grid(7, 12, 7);
  for (let x = 0; x <= 6; x++) for (let z = 0; z <= 1; z++) g.set(x, 0, z, rng() < 0.4 ? C.waterLight : C.waterMid); // splash pool (front)
  for (let x = 0; x <= 6; x++) g.set(x, 0, 2, C.concrete);
  for (let y = 0; y <= 9; y++) g.set(5, y, 5, C.metalDark);     // tower (back)
  for (let y = 1; y <= 8; y++) g.set(6, y, 5, C.metal);         // ladder
  g.box(4, 9, 4, 6, 9, 6, C.signWhite);                         // top platform
  for (const [x, y, z] of [[5, 8, 5], [4, 7, 4], [4, 6, 3], [3, 5, 3], [3, 4, 2], [2, 3, 1], [2, 2, 1], [2, 1, 0]])
    g.set(x, y, z, C.blue);                                     // winding blue flume
  g.set(1, 1, 0, C.waterLight); g.set(3, 4, 2, C.waterLight);   // water highlights
  return g.done();
}
function bMiniGolf(rng) {
  const g = grid(7, 6, 7);
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) g.set(x, 0, z, (x + z) % 2 ? C.grassMid : C.grassLight);
  g.set(5, 0, 5, C.sand); g.set(5, 0, 6, C.sand); g.set(1, 0, 5, C.waterMid); // trap + water
  g.set(3, 0, 1, C.black);                                      // hole (front)
  for (let y = 1; y <= 3; y++) g.set(3, y, 1, C.signWhite);     // flag pole
  g.set(2, 3, 1, C.red); g.set(2, 2, 1, C.red);                 // flag
  for (let y = 1; y <= 3; y++) g.set(5, y, 3, C.woodDark);      // windmill tower
  g.set(4, 4, 3, C.red); g.set(6, 4, 3, C.red); g.set(5, 3, 3, C.signWhite); g.set(5, 5, 3, C.signWhite); // blades
  return g.done();
}
function bSkatePark(rng) {
  const g = grid(7, 5, 7);
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) g.set(x, 0, z, C.concrete);
  for (let x = 2; x <= 4; x++) for (let z = 2; z <= 4; z++) g.set(x, 0, z, C.stoneDark); // bowl
  for (let x = 0; x < 7; x++) { g.set(x, 1, 6, C.steel); g.set(x, 2, 6, C.metal); }       // quarter-pipe (back)
  for (let z = 0; z < 7; z++) g.set(6, 1, z, C.steel);
  for (let x = 1; x <= 5; x++) g.set(x, 1, 3, C.yellow);        // grind rail
  for (let x = 0; x < 7; x++) g.set(x, 1, 0, C.neon);           // neon lip (front)
  g.set(1, 0, 1, C.red); g.set(5, 0, 5, C.blue);                // graffiti dabs
  return g.done();
}
function bMuseum(rng) {                                          // 3×2 — grand columned portico, dome, wide steps
  const SX = 23, SZ = 15;
  const wall = pk(rng, [C.offwhite, C.cream, C.white]);
  const g = grid(SX, 22, SZ), bh = 10;
  g.slab(0, 0, 0, SX - 1, SZ - 1, C.stone);                     // base platform
  for (let s = 0; s < 3; s++) for (let x = s; x < SX - s; x++) g.set(x, 0, s, C.stone); // wide front steps
  g.walls(2, 0, 3, SX - 3, bh - 1, SZ - 1, wall);               // main hall, set back
  g.slab(2, bh, 3, SX - 3, SZ - 1, C.stone);
  for (let cx = 3; cx <= SX - 4; cx += 2) for (let y = 0; y < bh; y++) g.set(cx, y, 3, C.signWhite); // grand columns (front)
  signBoard(g, 3, SX - 4, bh, 3, C.cream);                      // architrave
  for (let t = 0; t < 4; t++) for (let x = 8 + t; x <= SX - 9 - t; x++) g.set(x, bh + 1 + t, 4, C.cream); // pediment
  g.box(10, 0, 3, 12, 3, 3, C.woodDark);                        // grand doors
  windowsOn(g, 2, 3, SX - 3, SZ - 1, [3, 5].filter(y => y < bh), C.win, 3);
  const dcx = 11, dcz = 9;                                      // gold dome
  g.box(dcx - 2, bh, dcz - 2, dcx + 2, bh, dcz + 2, C.gold);
  g.box(dcx - 1, bh + 1, dcz - 1, dcx + 1, bh + 2, dcz + 1, C.gold);
  g.set(dcx, bh + 3, dcz, C.amber); g.set(dcx, bh + 4, dcz, C.gold);
  return g.done();
}
function bCarnival(rng) {                                        // 2×1
  const g = grid(13, 9, 5);
  for (let x = 0; x < 13; x++) for (let z = 0; z < 5; z++) g.set(x, 0, z, x % 2 ? C.sand : C.sandDark);
  const cols = [C.red, C.blue, C.roofGreen];
  for (let b = 0; b < 3; b++) {
    const x0 = b * 4 + 1, c = cols[b];
    g.box(x0, 1, 1, x0 + 2, 3, 1, C.wood);                      // booth back wall
    g.box(x0, 1, 0, x0 + 2, 1, 0, C.woodDark);                  // counter (front)
    for (let x = x0; x <= x0 + 2; x++) g.set(x, 4, 0, x % 2 ? c : C.signWhite); // striped awning
    g.set(x0, 3, 1, c); g.set(x0 + 2, 3, 1, c);                 // posts
    g.set(x0 + 1, 2, 1, C.win);                                 // prize target (glow)
  }
  for (let x = 3; x <= 9; x += 3) { g.set(x, 5, 2, C.pink); g.set(x, 6, 2, C.pink); g.set(x, 7, 2, C.neon); } // balloons + sign
  return g.done();
}

function bStadium(rng) {                                         // 4×4 — the showpiece: big raked bowl + floodlights
  const S = 31, C0 = 15;
  const g = grid(S, 34, S);
  const teamA = pk(rng, [C.red, C.blue, C.navy, C.crimson, C.roofPurple]);
  const teamB = pk(rng, [C.gold, C.orange, C.teal, C.roofGreen, C.pYellow]);
  const F0 = 9, F1 = 21;                                        // 13×13 playing field
  for (let x = F0; x <= F1; x++) for (let z = F0; z <= F1; z++)
    g.set(x, 0, z, (x + z) & 1 ? C.grassMid : C.grassLight);
  for (let k = 0; k < 20; k++) {                                // center circle
    const a = k / 20 * Math.PI * 2;
    g.set(Math.round(C0 + Math.cos(a) * 3), 0, Math.round(C0 + Math.sin(a) * 3), C.signWhite);
  }
  for (let x = F0; x <= F1; x++) g.set(x, 0, C0, C.signWhite);  // halfway line
  g.set(C0, 1, F0, C.signWhite); g.set(C0, 1, F1, C.signWhite); // goals
  for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) {     // raked seating bowl rising outward
    const fx = x < F0 ? F0 - x : x > F1 ? x - F1 : 0;
    const fz = z < F0 ? F0 - z : z > F1 ? z - F1 : 0;
    const d = Math.max(fx, fz);
    if (d === 0) continue;
    const h = Math.min(27, d * 3);
    g.box(x, 0, z, x, h - 1, z, C.concrete);                    // stand structure
    g.set(x, h, z, (d & 1) ? teamA : teamB);                    // team-colored seat rows
  }
  const carve = cells => { for (const [x, z] of cells) for (let y = 1; y <= 33; y++) g.del(x, y, z); };
  for (let z = 0; z < F0; z++) carve([[C0 - 1, z], [C0, z], [C0 + 1, z]]);         // vomitory tunnels
  for (let z = F1 + 1; z < S; z++) carve([[C0 - 1, z], [C0, z], [C0 + 1, z]]);
  for (let x = 0; x < F0; x++) carve([[x, C0 - 1], [x, C0], [x, C0 + 1]]);
  for (let x = F1 + 1; x < S; x++) carve([[x, C0 - 1], [x, C0], [x, C0 + 1]]);
  for (const [tx, tz] of [[3, 3], [S - 4, 3], [3, S - 4], [S - 4, S - 4]]) {       // floodlight towers
    for (let y = 0; y <= 30; y++) g.set(tx, y, tz, C.metalDark);
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) g.set(tx + dx, 31, tz + dz, C.lamp);
  }
  for (let x = 0; x < S; x++) { g.set(x, 25, 0, C.steel); g.set(x, 25, S - 1, C.steel); } // roof rim over the top ring
  for (let z = 0; z < S; z++) { g.set(0, 25, z, C.steel); g.set(S - 1, 25, z, C.steel); }
  g.set(5, 26, 0, teamA); g.set(S - 6, 26, S - 1, teamB);       // flags
  return g.done();
}

// wind-power base: tower + nacelle only (the 3-blade rotor is the animated part).
function bWindPower(rng) {
  const g = grid(7, 14, 3);
  const tx = 3, tz = 1, hubY = 11;
  g.box(2, 0, 0, 4, 0, 2, C.concrete);          // base pad
  for (let y = 0; y < hubY; y++) g.set(tx, y, tz, C.white); // tower
  g.set(tx, 1, tz, C.offwhite);
  g.set(tx, hubY, tz, C.metal);                 // nacelle
  g.set(tx + 1, hubY, tz, C.metalDark);
  return g.done();
}

// ---- DECO (1×1 charm, cap 0) ----------------------------------------------
// Fronts (where meaningful) authored toward min-Z; catalogModel's flipZ lands
// them on +Z (bench faces +Z, mailbox door +Z).
function dFlowerBed(rng) {
  const g = grid(5, 3, 5);
  for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) g.set(x, 0, z, C.dirtDark); // soil
  for (let x = 0; x < 5; x++) { g.set(x, 0, 0, C.wood); g.set(x, 0, 4, C.wood); }        // wood border
  for (let z = 0; z < 5; z++) { g.set(0, 0, z, C.wood); g.set(4, 0, z, C.wood); }
  const flowers = [C.red, C.pYellow, C.pink, C.blue, C.orange, C.purple, C.blossom, C.gold];
  for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) {
    g.set(x, 1, z, C.leafMid);                                     // greenery
    if (((x + z) & 1) === 0) g.set(x, 2, z, pk(rng, flowers));     // mixed bright blooms
  }
  return g.done();
}
function dBench(rng) {
  const wood = pk(rng, [C.wood, C.woodDark, C.plank, C.roofBrown]);
  const g = grid(5, 3, 3);
  for (const x of [0, 4]) { g.set(x, 0, 1, C.stoneDark); g.set(x, 0, 2, C.stoneDark); } // legs
  for (let x = 0; x < 5; x++) { g.set(x, 1, 1, wood); g.set(x, 1, 2, wood); }           // seat
  for (let x = 0; x < 5; x++) g.set(x, 2, 2, wood);                                     // backrest (-> back at -Z, sit facing +Z)
  return g.done();
}
function dFence(rng) {
  const c = pk(rng, [C.signWhite, C.white, C.offwhite, C.cream]);
  const g = grid(5, 3, 1);
  for (let x = 0; x < 5; x++) {
    g.set(x, 0, 0, c); g.set(x, 1, 0, c);
    if (x % 2 === 0) g.set(x, 2, 0, c);                            // pointed pickets
  }
  return g.done();
}
function dHedge(rng) {
  const g = grid(5, 3, 5);
  const a = pk(rng, [C.bush, C.leafMid, C.leafDark, C.pine]);
  const b = pk(rng, [C.leafLight, C.lime, C.grassLight, C.leafMid]);
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
    g.set(x, 0, z, a);
    g.set(x, 1, z, rng() < 0.3 ? b : a);
  }
  for (let x = 1; x < 4; x++) for (let z = 1; z < 4; z++) g.set(x, 2, z, rng() < 0.4 ? b : a);
  return g.done();
}
function dStreetlight(rng) {
  const g = grid(3, 7, 3);
  const pole = pk(rng, [C.metalDark, C.darkGray, C.steel]);
  for (let y = 0; y <= 5; y++) g.set(1, y, 1, pole);             // slim pole
  g.set(1, 6, 1, C.lamp); g.set(1, 6, 2, C.lamp);               // 202 glow lamp head
  return g.done();
}
function dStatue(rng) {
  const g = grid(3, 6, 3);
  const stone = pk(rng, [C.stone, C.stoneDark, C.metal, C.concrete]);
  g.box(0, 0, 0, 2, 1, 2, C.stoneDark);                         // plinth
  g.set(1, 2, 1, stone); g.set(1, 3, 1, stone);                 // body
  g.set(1, 4, 1, stone);                                        // head
  g.set(0, 3, 1, stone); g.set(2, 3, 1, stone);                 // arms
  return g.done();
}
function dStonePath(rng) {
  const g = grid(5, 1, 5);
  const a = pk(rng, [C.sidewalk, C.stone, C.concrete]), b = pk(rng, [C.stoneDark, C.sidewalk, C.metal]);
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) g.set(x, 0, z, (x + z) & 1 ? a : b); // flat pavers
  return g.done();
}
function dPicnicTable(rng) {
  const g = grid(5, 3, 5);
  const leg = C.woodDark;
  for (const [x, z] of [[1, 1], [3, 1], [1, 3], [3, 3]]) { g.set(x, 0, z, leg); g.set(x, 1, z, leg); }
  for (let x = 0; x < 5; x++) for (let z = 1; z <= 3; z++) g.set(x, 2, z, (x + z) & 1 ? C.red : C.signWhite); // red-checkered top
  for (let x = 0; x < 5; x++) { g.set(x, 1, 0, C.wood); g.set(x, 1, 4, C.wood); }        // benches
  return g.done();
}
function dMailbox(rng) {
  const g = grid(3, 4, 3);
  const box = pk(rng, [C.blue, C.red, C.roofGreen, C.navy]);
  g.set(1, 0, 1, C.woodDark); g.set(1, 1, 1, C.woodDark);       // post
  g.box(0, 2, 0, 2, 3, 1, box);                                 // box body
  g.set(1, 2, 0, C.signWhite);                                  // door/slot (front -> +Z)
  g.set(2, 3, 0, C.red);                                        // little flag
  return g.done();
}
function dPond(rng) {
  const g = grid(5, 2, 5);
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
    const edge = x === 0 || z === 0 || x === 4 || z === 4;
    g.set(x, 0, z, edge ? C.stone : (rng() < 0.5 ? C.waterLight : C.waterMid));
  }
  g.set(2, 1, 2, C.leafMid);                                    // lily pad
  if (rng() < 0.7) g.set(3, 1, 3, C.blossom); else g.set(3, 1, 3, C.leafDark); // lily flower
  return g.done();
}
function dFlagPole(rng) {
  const g = grid(4, 8, 3);
  const flag = pk(rng, [C.red, C.blue, C.roofGreen, C.gold, C.purple, C.orange]);
  for (let y = 0; y < 7; y++) g.set(0, y, 1, C.metal);          // pole
  g.set(0, 7, 1, C.gold);                                       // finial
  g.set(1, 6, 1, flag); g.set(2, 6, 1, flag); g.set(1, 5, 1, flag); g.set(2, 5, 1, flag); g.set(3, 5, 1, flag); g.set(1, 4, 1, flag); // waving flag
  return g.done();
}

// ---- animated part models (catalogAnim) -----------------------------------
// Each part is authored so its natural pivot IS its model center.
function _ferrisSpinner() {                       // big wheel + gondolas, X/Y plane, spins about Z
  const R = 16, S = R * 2 + 1;                     // 33-wide disc
  const g = grid(S, S, 1);
  const cx = R, cy = R;
  const cols = [C.red, C.blue, C.yellow, C.roofGreen, C.orange, C.teal, C.pink, C.purple];
  const spokes = 16;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    g.set(Math.round(cx + Math.cos(a) * R), Math.round(cy + Math.sin(a) * R), 0, C.steel);              // rim
    g.set(Math.round(cx + Math.cos(a) * (R - 1)), Math.round(cy + Math.sin(a) * (R - 1)), 0, cols[i % cols.length]); // gondola
    for (let r = 2; r < R - 1; r++) g.set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 0, C.metal); // spoke
  }
  for (let i = 0; i < spokes * 2; i++) {                        // fuller rim between spokes
    const a = (i / (spokes * 2)) * Math.PI * 2;
    g.set(Math.round(cx + Math.cos(a) * R), Math.round(cy + Math.sin(a) * R), 0, C.steel);
  }
  g.set(cx, cy, 0, C.gold);                                     // hub
  return g.done();
}
function _carouselSpinner() {                     // larger canopy + horses, spins about Y (pole axis)
  const S = 15, cx = 7, cz = 7;
  const g = grid(S, 13, S);
  const cols = [C.red, C.blue, C.pYellow, C.pink, C.roofGreen, C.purple, C.orange, C.teal]; let i = 0;
  const R = 5;
  for (let k = 0; k < 8; k++) {                                 // ring of horses
    const a = k / 8 * Math.PI * 2;
    const hx = Math.round(cx + Math.cos(a) * R), hz = Math.round(cz + Math.sin(a) * R);
    for (let y = 2; y <= 6; y++) g.set(hx, y, hz, C.metal);     // hanging pole
    g.set(hx, 3, hz, cols[i++ % cols.length]);                  // horse body
    g.set(hx, 4, hz, cols[i % cols.length]);
  }
  for (let ring = 0; ring < 3; ring++) {                        // striped cone canopy
    const rr = 6 - ring * 2, yy = 8 + ring;
    for (let x = cx - rr; x <= cx + rr; x++) for (let z = cz - rr; z <= cz + rr; z++)
      if ((x - cx) ** 2 + (z - cz) ** 2 <= rr * rr) g.set(x, yy, z, (x + z) % 2 ? C.red : C.signWhite);
  }
  g.set(cx, 11, cz, C.gold); g.set(cx, 12, cz, C.red);          // finial flag
  return g.done();
}
function _windSpinner() {                         // 3-blade rotor, X/Y plane, spins about Z (front axis)
  const g = grid(7, 7, 1);
  const cx = 3, cy = 3;
  for (let k = 0; k < 3; k++) {
    const a = k * 2 * Math.PI / 3 - Math.PI / 2;
    for (let r = 1; r <= 3; r++) g.set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 0, C.offwhite);
  }
  return g.done();
}
function _fountainSpinner() {                      // sparkle ring of water-blue, spins about Y
  const g = grid(5, 1, 5);
  const w = [C.waterLight, C.waterMid, C.skyBlue, C.winCool];
  const ring = [[0, 2], [4, 2], [2, 0], [2, 4], [1, 1], [3, 3], [1, 3], [3, 1]];
  let i = 0; for (const [x, z] of ring) g.set(x, 0, z, w[i++ % w.length]);
  return g.done();
}
function _barberSpinner() {                        // striped pole, spins about Y (fast)
  const g = grid(1, 6, 1);
  const cols = [C.red, C.signWhite, C.blue];
  for (let y = 0; y <= 4; y++) g.set(0, y, 0, cols[y % 3]);
  g.set(0, 5, 0, C.metalDark);                                  // cap
  return g.done();
}

// ---- DOWNTOWN (offices + skyscrapers) -------------------------------------
// Fronts authored toward min-Z (z≈0); flipZ lands the glass lobby / doors on the
// +Z face. Dense 200/201 glass grids on ALL four faces so the whole skyline
// lights up at night; 203 neon for rooftop signage & spire beacons. Grid height
// is declared at the footprint's height cap (1×1→48, 2×1/2×2→64) so towers can be
// tall; any voxel above the grid is silently clipped by g.set.
function _winRows(y0, y1, step) { const r = []; for (let y = y0; y <= y1; y += step) r.push(y); return r; }
// steel corner mullions running the full height (reads as a curtain-wall tower)
function _mullions(g, x0, z0, x1, z1, bh, c) {
  for (let y = 0; y < bh; y++)
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.set(cx, y, cz, c);
}

// 1×1 slim — small mid-rise office, stone/concrete, warm-lit grid.
function bSmallOffice(rng) {
  const body = pk(rng, [C.concrete, C.offwhite, C.sandDark, C.stone]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const bh = 26 + ((rng() * 6) | 0);                              // 26..31
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 6, body);
  windowsOn(g, 0, 0, 6, 6, _winRows(2, bh - 2, 2), win, 1);
  for (let x = 1; x <= 5; x++) g.set(x, 1, 0, C.winCool);         // ground lobby glass
  g.box(3, 0, 0, 3, 1, 0, C.woodDark);                           // door
  g.slab(0, bh, 0, 6, 6, C.concrete);                            // roof deck
  g.walls(0, bh + 1, 0, 6, bh + 1, 6, C.stoneDark);              // parapet
  acUnit(g, 2, bh + 1, 2, C.metal);
  for (let y = bh + 1; y < bh + 4; y++) g.set(5, y, 5, C.metalDark); // antenna
  return g.done();
}
// 1×1 slim — blue glass office, full curtain wall, red beacon.
function bGlassOffice(rng) {
  const glass = pk(rng, [C.pBlue, C.skyBlue, C.roofBlue]);
  const bh = 38 + ((rng() * 5) | 0);                              // 38..42
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 6, glass);
  windowsOn(g, 0, 0, 6, 6, _winRows(1, bh - 2, 2), C.winCool, 1);
  _mullions(g, 0, 0, 6, 6, bh, C.steel);
  g.box(2, 0, 0, 4, 2, 0, C.winCool); g.set(3, 0, 0, C.darkGray); // glass lobby + door
  g.slab(0, bh, 0, 6, 6, C.metalDark);
  g.box(2, bh + 1, 2, 4, bh + 2, 4, C.steel);                    // setback cap
  for (let y = bh + 3; y < bh + 5; y++) g.set(3, y, 3, C.metal);
  g.set(3, bh + 5, 3, C.neon);                                   // beacon
  return g.done();
}
// 1×1 slim — brick pre-war highrise, warm windows, cornice + water tank.
function bBrickHighrise(rng) {
  const brick = pk(rng, [C.brick, C.brickDark]);
  const bh = 30 + ((rng() * 6) | 0);                              // 30..35
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 6, brick);
  windowsOn(g, 0, 0, 6, 6, _winRows(2, bh - 2, 2), C.win, 1);
  g.walls(0, (bh >> 1), 0, 6, (bh >> 1), 6, C.stone);            // mid stone band
  g.box(2, 0, 0, 4, 2, 0, C.woodDark); g.set(3, 2, 0, C.win);    // arched lobby
  g.slab(0, bh, 0, 6, 6, C.stone);                               // cornice
  g.walls(0, bh + 1, 0, 6, bh + 1, 6, C.brickDark);
  g.box(2, bh + 1, 2, 3, bh + 4, 3, C.woodDark);                 // wooden water tank
  g.slab(2, bh + 5, 2, 3, 3, C.metalDark);
  return g.done();
}
// 1×1 slim — art-deco stepped tower with gold piers + spire.
function bDecoTower(rng) {
  const stone = pk(rng, [C.cream, C.offwhite, C.sandDark]);
  const t1 = 22, t2 = 34, t3 = 42;
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, t1 - 1, 6, stone);
  g.walls(1, 0, 1, 5, t2 - 1, 5, stone);
  g.walls(2, 0, 2, 4, t3 - 1, 4, stone);
  windowsOn(g, 0, 0, 6, 6, _winRows(2, t1 - 2, 2), C.win, 1);
  windowsOn(g, 1, 1, 5, 5, _winRows(t1 + 1, t2 - 2, 2), C.win, 1);
  windowsOn(g, 2, 2, 4, 4, _winRows(t2 + 1, t3 - 2, 2), C.win, 1);
  g.slab(0, t1, 0, 6, 6, C.stone);                               // setback ledges
  g.slab(1, t2, 1, 5, 5, C.stone);
  g.slab(2, t3, 2, 4, 4, C.stone);
  for (let y = 0; y < t1; y++) { g.set(1, y, 0, C.gold); g.set(5, y, 0, C.gold); } // deco piers
  g.box(2, 0, 0, 4, 2, 0, C.gold); g.set(3, 0, 0, C.darkGray);   // grand entrance
  for (let y = t3; y < t3 + 5; y++) g.set(3, y, 3, C.gold);      // spire
  g.set(3, t3 + 5, 3, C.neon);
  return g.done();
}
// 1×1 slim — green glass tower, very dense cool grid, sloped glass crown.
function bGreenGlassTower(rng) {
  const glass = pk(rng, [C.roofGreen, C.teal, C.mint]);
  const bh = 36 + ((rng() * 6) | 0);                              // 36..41
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 6, glass);
  windowsOn(g, 0, 0, 6, 6, _winRows(1, bh - 2, 1), C.winCool, 1); // every floor
  _mullions(g, 0, 0, 6, 6, bh, C.steel);
  g.box(2, 0, 0, 4, 2, 0, C.winCool);                            // lobby
  g.slab(0, bh, 0, 6, 6, glass);                                 // stepped glass crown
  g.box(1, bh + 1, 1, 5, bh + 1, 5, glass);
  g.box(2, bh + 2, 2, 4, bh + 2, 4, glass);
  for (let y = bh + 3; y < bh + 6; y++) g.set(3, y, 3, C.metalDark); // antenna
  return g.done();
}
// 1×1 slim — bank clock tower, stone with a glowing clock face on the front.
function bClockTower(rng) {
  const stone = pk(rng, [C.stone, C.concrete, C.offwhite]);
  const bh = 34 + ((rng() * 4) | 0);                              // 34..37
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 6, stone);
  windowsOn(g, 0, 0, 6, 6, _winRows(3, bh - 5, 3), C.win, 2);
  for (const cx of [1, 3, 5]) for (let y = 0; y < 4; y++) g.set(cx, y, 0, C.offwhite); // columns
  g.box(2, 0, 0, 4, 2, 0, C.gold);                               // grand door
  const cy = bh - 3;                                             // clock face (front)
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) g.set(3 + dx, cy + dy, 0, C.gold);
  g.set(3, cy, 0, C.win);                                        // lit dial
  g.slab(0, bh, 0, 6, 6, C.stoneDark);                           // cornice
  g.walls(1, bh + 1, 1, 5, bh + 3, 5, stone);                    // cupola
  g.slab(1, bh + 4, 1, 5, 5, C.gold);
  for (let y = bh + 5; y < bh + 7; y++) g.set(3, y, 3, C.gold);  // finial
  return g.done();
}
// 1×1 slim — round glass tower, lit ring on every floor, dome + beacon.
function bRoundTower(rng) {
  const glass = pk(rng, [C.pBlue, C.skyBlue, C.winCool]);
  const bh = 36 + ((rng() * 6) | 0);                              // 36..41
  const g = grid(7, 48, 7);
  const cx = 3, cz = 3, R = 3;
  const inside = (x, z) => (x - cx) * (x - cx) + (z - cz) * (z - cz) <= R * R + 1;
  for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) if (inside(x, z)) g.set(x, 0, z, C.stoneDark);
  for (let y = 0; y < bh; y++) for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) {
    if (!inside(x, z)) continue;
    const edge = !inside(x + 1, z) || !inside(x - 1, z) || !inside(x, z + 1) || !inside(x, z - 1);
    if (edge) g.set(x, y, z, y % 2 ? glass : C.winCool);         // alternating lit ring
  }
  g.set(3, 0, 0, C.darkGray); g.set(3, 1, 0, C.winCool);         // lobby door
  for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++)
    if (inside(x, z) && (x - cx) * (x - cx) + (z - cz) * (z - cz) <= 4) g.set(x, bh, z, C.steel); // dome
  g.box(2, bh + 1, 2, 4, bh + 1, 4, C.steel);
  for (let y = bh + 2; y < bh + 6; y++) g.set(3, y, 3, C.metal);
  g.set(3, bh + 6, 3, C.neon);                                   // beacon
  return g.done();
}
// 1×1 slim — hotel with a vertical neon sign + balcony bands.
function bHotel(rng) {
  const body = pk(rng, [C.crimson, C.navy, C.roofBrown, C.purple]);
  const bh = 36 + ((rng() * 5) | 0);                              // 36..40
  const g = grid(7, 48, 7);
  g.slab(0, 0, 0, 6, 6, C.stoneDark);
  g.walls(0, 0, 0, 6, bh - 1, 6, body);
  windowsOn(g, 0, 0, 6, 6, _winRows(3, bh - 2, 2), C.win, 1);
  for (let y = 3; y < bh; y += 2) for (let x = 1; x <= 5; x++) g.set(x, y - 1, 0, C.offwhite); // balconies
  for (let x = 1; x <= 5; x++) g.set(x, 3, 0, x % 2 ? C.gold : C.signWhite); // canopy
  g.box(2, 0, 0, 4, 2, 0, C.gold);                               // entrance
  for (let y = 4; y < bh - 1; y++) g.set(0, y, 0, C.neon);       // vertical neon sign
  g.slab(0, bh, 0, 6, 6, C.stoneDark);
  signBoard(g, 1, 5, bh + 1, 3, C.neon); signBoard(g, 1, 5, bh + 2, 3, C.neon); // roof sign
  return g.done();
}
// 2×1 — wide mid-rise office block.
function bOfficeBlock(rng) {
  const body = pk(rng, [C.concrete, C.stone, C.offwhite, C.sandDark]);
  const win = rng() < 0.5 ? C.win : C.winCool;
  const bh = 26 + ((rng() * 8) | 0);                              // 26..33
  const g = grid(15, 64, 7);
  g.slab(0, 0, 0, 14, 6, C.stoneDark);
  g.walls(0, 0, 0, 14, bh - 1, 6, body);
  windowsOn(g, 0, 0, 14, 6, _winRows(2, bh - 2, 2), win, 1);
  for (let x = 1; x < 14; x++) g.set(x, 1, 0, C.winCool);        // lobby glass band
  g.box(6, 0, 0, 8, 1, 0, C.darkGray);                           // entrance
  g.slab(0, bh, 0, 14, 6, C.concrete);
  g.walls(0, bh + 1, 0, 14, bh + 1, 6, C.stoneDark);
  acUnit(g, 3, bh + 1, 3, C.metal); acUnit(g, 10, bh + 1, 3, C.metal);
  signBoard(g, 5, 9, bh + 2, 3, C.neon);                         // rooftop sign
  return g.done();
}
// 2×1 — retail base + office floors, neon storefront band.
function bShoppingOffice(rng) {
  const body = pk(rng, [C.pBlue, C.teal, C.stone, C.cream]);
  const bh = 26 + ((rng() * 6) | 0);                              // 26..31
  const g = grid(15, 64, 7);
  g.slab(0, 0, 0, 14, 6, C.stoneDark);
  g.walls(0, 0, 0, 14, bh - 1, 6, body);
  for (let x = 1; x < 14; x++) { g.set(x, 1, 0, C.winCool); g.set(x, 2, 0, C.winCool); } // storefront
  for (let x = 0; x < 15; x++) g.set(x, 3, 0, x % 2 ? C.neon : C.signWhite);             // neon marquee
  g.box(3, 0, 0, 4, 1, 0, C.darkGray); g.box(10, 0, 0, 11, 1, 0, C.darkGray);            // doors
  windowsOn(g, 0, 0, 14, 6, _winRows(5, bh - 2, 2), C.win, 1);   // offices above
  g.slab(0, bh, 0, 14, 6, C.concrete);
  g.walls(0, bh + 1, 0, 14, bh + 1, 6, C.stoneDark);
  acUnit(g, 7, bh + 1, 3, C.metal);
  return g.done();
}
// 2×2 big — blue glass skyscraper, curtain wall, helipad + antenna.
function bGlassSkyscraper(rng) {
  const glass = pk(rng, [C.pBlue, C.skyBlue, C.roofBlue]);
  const bh = 50 + ((rng() * 6) | 0);                              // 50..55
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.stoneDark);
  g.walls(0, 0, 0, 14, bh - 1, 14, glass);
  windowsOn(g, 0, 0, 14, 14, _winRows(2, bh - 2, 1), C.winCool, 1); // dense, every floor
  _mullions(g, 0, 0, 14, 14, bh, C.steel);
  for (let x = 4; x <= 10; x++) { g.set(x, 1, 0, C.winCool); g.set(x, 2, 0, C.winCool); } // 2-story lobby
  g.box(6, 0, 0, 8, 2, 0, C.darkGray);
  g.slab(0, bh, 0, 14, 14, C.metalDark);                         // roof deck
  g.walls(3, bh + 1, 3, 11, bh + 3, 11, glass);                  // setback crown
  windowsOn(g, 3, 3, 11, 11, _winRows(bh + 1, bh + 2, 1), C.winCool, 1);
  g.slab(3, bh + 4, 3, 11, 11, C.concrete);
  for (const dx of [-1, 0, 1]) g.set(7 + dx, bh + 4, 7, C.signWhite); // helipad H
  for (let y = bh + 5; y < bh + 8; y++) g.set(7, y, 7, C.metal); // antenna
  g.set(7, bh + 8, 7, C.neon);
  return g.done();
}
// 2×2 big — modern black-glass skyscraper, glowing accent stripes.
function bDarkSkyscraper(rng) {
  const body = pk(rng, [C.darkGray, C.black, C.stoneDark]);
  const bh = 52 + ((rng() * 6) | 0);                              // 52..57
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.black);
  g.walls(0, 0, 0, 14, bh - 1, 14, body);
  windowsOn(g, 0, 0, 14, 14, _winRows(2, bh - 2, 1), C.winCool, 2);
  for (let y = 2; y < bh - 1; y++) { g.set(3, y, 0, C.win); g.set(11, y, 0, C.win); g.set(0, y, 7, C.win); g.set(14, y, 7, C.win); } // accent stripes on faces
  for (let x = 5; x <= 9; x++) { g.set(x, 1, 0, C.winCool); g.set(x, 2, 0, C.winCool); }
  g.box(6, 0, 0, 8, 2, 0, C.steel);
  g.slab(0, bh, 0, 14, 14, C.darkGray);                          // tapered top
  g.walls(4, bh + 1, 4, 10, bh + 3, 10, body);
  windowsOn(g, 4, 4, 10, 10, _winRows(bh + 1, bh + 2, 1), C.winCool, 1);
  g.slab(4, bh + 4, 4, 10, 10, C.black);
  for (let y = bh + 4; y < bh + 6; y++) g.set(7, y, 7, C.steel);
  g.set(7, bh + 6, 7, C.neon);
  return g.done();
}
// 2×2 big — two-tone corporate HQ: tall dark slab behind a shorter glass wing.
function bCorporateHQ(rng) {
  const glassA = pk(rng, [C.pBlue, C.skyBlue, C.teal]);
  const glassB = pk(rng, [C.navy, C.darkGray, C.stoneDark]);
  const bh = 48 + ((rng() * 6) | 0);                              // 48..53 main slab
  const wh = (bh * 0.6) | 0;                                      // front wing
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.stoneDark);
  g.walls(0, 0, 6, 14, bh - 1, 14, glassB);                      // tall slab (back)
  windowsOn(g, 0, 6, 14, 14, _winRows(2, bh - 2, 1), C.winCool, 1);
  g.walls(0, 0, 0, 14, wh - 1, 6, glassA);                       // glass wing (front)
  windowsOn(g, 0, 0, 14, 6, _winRows(2, wh - 2, 1), C.win, 1);
  for (let y = 0; y < bh; y++) { g.set(0, y, 0, C.steel); g.set(14, y, 0, C.steel); }
  for (let x = 4; x <= 10; x++) { g.set(x, 1, 0, C.winCool); g.set(x, 2, 0, C.winCool); }
  g.box(6, 0, 0, 8, 2, 0, C.darkGray);                           // lobby
  g.slab(0, wh, 0, 14, 6, C.metalDark);                          // wing roof
  g.slab(0, bh, 6, 14, 14, C.metalDark);                         // slab roof
  signBoard(g, 5, 9, bh + 1, 7, C.neon); signBoard(g, 5, 9, bh + 2, 7, C.neon); // rooftop logo
  for (let y = bh + 1; y < bh + 5; y++) g.set(7, y, 11, C.metal); // antenna
  return g.done();
}
// 2×2 big — art-deco twin-setback towers on a shared podium, gold pinnacles.
function bTwinSetback(rng) {
  const stone = pk(rng, [C.cream, C.offwhite, C.sandDark, C.stone]);
  const bh = 52 + ((rng() * 6) | 0);                              // 52..57
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.stoneDark);
  g.walls(0, 0, 0, 14, 9, 14, stone);                            // shared podium
  windowsOn(g, 0, 0, 14, 14, _winRows(2, 8, 2), C.win, 1);
  for (const px of [0, 4, 10, 14]) for (let y = 0; y < 10; y++) g.set(px, y, 0, C.gold); // deco piers
  g.box(6, 0, 0, 8, 3, 0, C.gold); g.set(7, 0, 0, C.darkGray);   // grand entrance
  for (const [x0, x1] of [[1, 6], [8, 13]]) {                    // twin towers
    g.walls(x0, 10, 1, x1, bh - 15, 13, stone);
    windowsOn(g, x0, 1, x1, 13, _winRows(11, bh - 17, 2), C.win, 1);
    g.slab(x0, bh - 15, 1, x1, 13, stone);                       // setback ledge
    g.walls(x0 + 1, bh - 15, 3, x1 - 1, bh - 1, 11, stone);
    windowsOn(g, x0 + 1, 3, x1 - 1, 11, _winRows(bh - 13, bh - 3, 2), C.win, 1);
    g.slab(x0 + 1, bh, 3, x1 - 1, 11, stone);                    // crown cap
    const px = (x0 + x1) >> 1;
    for (let y = bh; y < bh + 4; y++) g.set(px, y, 7, C.gold);   // pinnacle
    g.set(px, bh + 4, 7, C.neon);
  }
  return g.done();
}
// 2×2 big — the TALLEST: tapered spire tower with antenna reaching the 64 cap.
function bSpireTower(rng) {
  const glass = pk(rng, [C.navy, C.roofBlue, C.darkGray, C.teal]);
  const bh = 52 + ((rng() * 5) | 0);                              // 52..56
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.stoneDark);
  g.walls(0, 0, 0, 14, bh - 1, 14, glass);
  windowsOn(g, 0, 0, 14, 14, _winRows(2, bh - 2, 1), C.winCool, 1);
  _mullions(g, 0, 0, 14, 14, bh, C.steel);
  for (let x = 4; x <= 10; x++) { g.set(x, 1, 0, C.winCool); g.set(x, 2, 0, C.winCool); }
  g.box(6, 0, 0, 8, 2, 0, C.darkGray);                           // lobby
  g.slab(0, bh, 0, 14, 14, C.metalDark);
  g.walls(3, bh, 3, 11, bh + 3, 11, glass);                      // setback 1
  windowsOn(g, 3, 3, 11, 11, _winRows(bh + 1, bh + 2, 1), C.winCool, 1);
  g.walls(5, bh + 3, 5, 9, bh + 6, 9, glass);                    // setback 2
  g.slab(5, bh + 6, 5, 9, 9, C.metalDark);
  for (let y = bh + 7; y < 63; y++) g.set(7, y, 7, C.steel);     // spire to the cap
  g.set(7, 60, 7, C.win);                                        // lit ring
  g.set(7, 63, 7, C.neon);                                       // top beacon (y=63 of 64)
  return g.done();
}
// 2×2 big — wide tech campus, mid-height, sunshade bands + green roof.
function bTechCampus(rng) {
  const glass = pk(rng, [C.skyBlue, C.mint, C.pBlue, C.teal]);
  const bh = 30 + ((rng() * 6) | 0);                              // 30..35
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.stoneDark);
  g.walls(0, 0, 0, 14, bh - 1, 14, glass);
  windowsOn(g, 0, 0, 14, 14, _winRows(2, bh - 2, 1), C.winCool, 1);
  for (let y = 4; y < bh; y += 4) {                              // white sunshade bands (all faces)
    for (let x = 0; x < 15; x++) { g.set(x, y, 0, C.offwhite); g.set(x, y, 14, C.offwhite); }
    for (let z = 0; z < 15; z++) { g.set(0, y, z, C.offwhite); g.set(14, y, z, C.offwhite); }
  }
  for (let x = 5; x <= 9; x++) for (let yy = 1; yy <= 3; yy++) g.set(x, yy, 0, C.winCool); // atrium
  g.box(6, 0, 0, 8, 1, 0, C.darkGray);
  g.slab(0, bh, 0, 14, 14, C.roofGreen);                         // green roof
  for (let x = 1; x < 14; x += 2) for (let z = 1; z < 14; z += 3) g.set(x, bh + 1, z, (x + z) % 2 ? C.grassMid : C.leafMid);
  for (let x = 2; x < 12; x += 2) g.box(x, bh + 2, 10, x, bh + 2, 12, C.navy); // solar panels
  signBoard(g, 5, 9, bh + 3, 3, C.neon);                         // logo sign
  return g.done();
}
// 2×2 big — grand columned city bank with a central tower + gold dome & clock.
function bCityBank(rng) {
  const stone = pk(rng, [C.offwhite, C.cream, C.stone]);
  const tower = pk(rng, [C.stone, C.concrete, C.sandDark]);
  const bh = 46 + ((rng() * 6) | 0);                              // 46..51
  const g = grid(15, 64, 15);
  g.slab(0, 0, 0, 14, 14, C.stoneDark);
  g.walls(0, 0, 0, 14, 6, 14, stone);                            // columned podium
  for (let cx = 1; cx < 14; cx += 2) for (let y = 0; y < 6; y++) g.set(cx, y, 0, C.signWhite); // columns
  for (let x = 0; x < 15; x++) g.set(x, 6, 0, stone);            // portico beam
  g.set(7, 7, 0, C.gold);                                        // pediment peak
  g.box(6, 0, 0, 8, 3, 0, C.gold); g.box(5, 0, 0, 9, 0, 0, C.stoneDark); // doors + steps
  g.walls(3, 7, 3, 11, bh - 1, 11, tower);                       // central tower
  windowsOn(g, 3, 3, 11, 11, _winRows(9, bh - 2, 2), C.win, 1);
  const cy = bh - 4;                                             // tower clock (front face z=3)
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) g.set(7 + dx, cy + dy, 3, C.gold);
  g.set(7, cy, 3, C.win);
  g.slab(3, bh, 3, 11, 11, C.stone);                             // cornice
  for (let r = 3; r >= 1; r--) {                                 // gold dome
    for (let x = 7 - r; x <= 7 + r; x++) for (let z = 7 - r; z <= 7 + r; z++)
      if ((x - 7) * (x - 7) + (z - 7) * (z - 7) <= r * r) g.set(x, bh + (3 - r) + 1, z, C.gold);
  }
  for (let y = bh + 4; y < bh + 7; y++) g.set(7, y, 7, C.gold);  // finial
  return g.done();
}

// --- builder dispatch + catalog entries ------------------------------------
const BUILDERS = {
  // homes
  'small-house': bSmallHouse, 'cottage': bCottage, 'big-house': bBigHouse,
  'townhouse': bTownhouse, 'duplex': bDuplex, 'cabin': bCabin,
  'farmhouse': bFarmhouse, 'beach-house': bBeachHouse, 'apartment': bApartment,
  'tall-apartment': bTallApartment, 'condo-tower': bCondoTower, 'mansion': bMansion,
  // shops
  'bakery': bBakery, 'ice-cream': bIceCream, 'pizza': bPizza, 'burger': bBurger,
  'cafe': bCafe, 'toy-store': bToyStore, 'pet-shop': bPetShop, 'book-shop': bBookShop,
  'flower-shop': bFlowerShop, 'grocery': bGrocery, 'market-stall': bMarketStall,
  'arcade': bArcade, 'cinema': bCinema, 'mall': bMall,
  'candy-shop': bCandyShop, 'music-store': bMusicStore, 'sports-shop': bSportsShop,
  'barber': bBarber, 'diner': bDiner, 'fruit-stand': bFruitStand,
  // factories
  'workshop': bWorkshop, 'toy-factory': bToyFactory, 'chocolate-factory': bChocolate,
  'robot-factory': bRobotFactory, 'rocket-lab': bRocketLab, 'sawmill': bSawmill,
  'warehouse': bWarehouse, 'recycling-center': bRecycling,
  'mega-factory': bMegaFactory,
  'cheese-factory': bCheese, 'crayon-factory': bCrayon, 'balloon-factory': bBalloonFactory,
  'car-factory': bCarFactory, 'bakery-plant': bBakeryPlant, 'greenhouse-farm': bGreenhouse,
  // fun (park/school/fire/fountain/power/stadium wrap serviceModel)
  'park': (rng, v) => serviceModel('park', v),
  'school': (rng, v) => serviceModel('school', v),
  'fire-station': (rng, v) => serviceModel('fire', v),
  'fountain': (rng, v) => serviceModel('fountain', v),
  'wind-power': bWindPower,
  'stadium': bStadium,
  'playground': bPlayground, 'swimming-pool': bSwimmingPool,
  'ferris-wheel': bFerrisWheel, 'zoo': bZoo,
  'carousel': bCarousel, 'water-slide': bWaterSlide, 'mini-golf': bMiniGolf,
  'skate-park': bSkatePark, 'museum': bMuseum, 'carnival-games': bCarnival,
  // deco (1×1 charm)
  'flower-bed': dFlowerBed, 'bench': dBench, 'fence': dFence, 'hedge': dHedge,
  'streetlight': dStreetlight, 'statue': dStatue, 'stone-path': dStonePath,
  'picnic-table': dPicnicTable, 'mailbox': dMailbox, 'pond': dPond, 'flag-pole': dFlagPole,
  // downtown (offices + skyscrapers)
  'small-office': bSmallOffice, 'glass-office': bGlassOffice, 'brick-highrise': bBrickHighrise,
  'deco-tower': bDecoTower, 'green-glass-tower': bGreenGlassTower, 'clock-tower': bClockTower,
  'round-tower': bRoundTower, 'hotel': bHotel, 'office-block': bOfficeBlock,
  'shopping-office': bShoppingOffice, 'glass-skyscraper': bGlassSkyscraper,
  'dark-skyscraper': bDarkSkyscraper, 'corporate-hq': bCorporateHQ, 'twin-setback': bTwinSetback,
  'spire-tower': bSpireTower, 'tech-campus': bTechCampus, 'city-bank': bCityBank,
};

export const CATALOG = {
  homes: [
    { id: 'small-house', name: 'Small House', emoji: '🏠', tw: 1, td: 1, cap: 3, variants: 4 },
    { id: 'cottage', name: 'Cottage', emoji: '🏡', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'big-house', name: 'Big House', emoji: '🏘️', tw: 1, td: 1, cap: 5, variants: 3 },
    { id: 'townhouse', name: 'Townhouse', emoji: '🏙️', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'duplex', name: 'Duplex', emoji: '🏚️', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'cabin', name: 'Log Cabin', emoji: '🛖', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'farmhouse', name: 'Farmhouse', emoji: '🚜', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'beach-house', name: 'Beach House', emoji: '🏖️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'apartment', name: 'Apartment', emoji: '🏢', tw: 1, td: 1, cap: 12, variants: 3 },
    { id: 'tall-apartment', name: 'Tall Apartments', emoji: '🏬', tw: 1, td: 1, cap: 18, variants: 3 },
    { id: 'condo-tower', name: 'Condo Tower', emoji: '🌆', tw: 2, td: 2, cap: 30, variants: 2 },
    { id: 'mansion', name: 'Mansion', emoji: '🏰', tw: 2, td: 2, cap: 10, variants: 2 },
  ],
  shops: [
    { id: 'bakery', name: 'Bakery', emoji: '🥐', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'ice-cream', name: 'Ice Cream', emoji: '🍦', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'pizza', name: 'Pizza Place', emoji: '🍕', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'burger', name: 'Burger Joint', emoji: '🍔', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'cafe', name: 'Café', emoji: '☕', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'toy-store', name: 'Toy Store', emoji: '🧸', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'pet-shop', name: 'Pet Shop', emoji: '🐾', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'book-shop', name: 'Book Shop', emoji: '📚', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'flower-shop', name: 'Flower Shop', emoji: '🌸', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'grocery', name: 'Grocery', emoji: '🛒', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'market-stall', name: 'Market Stall', emoji: '🍎', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'arcade', name: 'Arcade', emoji: '🕹️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'cinema', name: 'Cinema', emoji: '🎬', tw: 2, td: 1, cap: 6, variants: 2 },
    { id: 'mall', name: 'Mall', emoji: '🏬', tw: 3, td: 3, cap: 10, variants: 2 },
    { id: 'candy-shop', name: 'Candy Shop', emoji: '🍭', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'music-store', name: 'Music Store', emoji: '🎵', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'sports-shop', name: 'Sports Shop', emoji: '⚽', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'barber', name: 'Barber Shop', emoji: '💈', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'diner', name: 'Diner', emoji: '🍽️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'fruit-stand', name: 'Fruit Stand', emoji: '🍎', tw: 1, td: 1, cap: 2, variants: 3 },
  ],
  factories: [
    { id: 'workshop', name: 'Workshop', emoji: '🔧', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'toy-factory', name: 'Toy Factory', emoji: '🎁', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'chocolate-factory', name: 'Chocolate Factory', emoji: '🍫', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'robot-factory', name: 'Robot Factory', emoji: '🤖', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'rocket-lab', name: 'Rocket Lab', emoji: '🚀', tw: 2, td: 2, cap: 6, variants: 2 },
    { id: 'sawmill', name: 'Sawmill', emoji: '🪵', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'warehouse', name: 'Warehouse', emoji: '📦', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'recycling-center', name: 'Recycling Center', emoji: '♻️', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'mega-factory', name: 'Mega Factory', emoji: '🏭', tw: 3, td: 3, cap: 10, variants: 2 },
    { id: 'cheese-factory', name: 'Cheese Factory', emoji: '🧀', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'crayon-factory', name: 'Crayon Factory', emoji: '🖍️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'balloon-factory', name: 'Balloon Factory', emoji: '🎈', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'car-factory', name: 'Car Factory', emoji: '🚗', tw: 1, td: 1, cap: 5, variants: 3 },
    { id: 'bakery-plant', name: 'Bakery Plant', emoji: '🍩', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'greenhouse-farm', name: 'Greenhouse Farm', emoji: '🌱', tw: 1, td: 1, cap: 3, variants: 3 },
  ],
  fun: [
    { id: 'park', name: 'Park', emoji: '🌳', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'school', name: 'School', emoji: '🏫', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'fire-station', name: 'Fire Station', emoji: '🚒', tw: 1, td: 1, cap: 5, variants: 3 },
    { id: 'fountain', name: 'Fountain', emoji: '⛲', tw: 1, td: 1, cap: 1, variants: 3 },
    { id: 'playground', name: 'Playground', emoji: '🛝', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'swimming-pool', name: 'Swimming Pool', emoji: '🏊', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'wind-power', name: 'Wind Power', emoji: '🌬️', tw: 1, td: 1, cap: 1, variants: 3 },
    { id: 'stadium', name: 'Stadium', emoji: '🏟️', tw: 4, td: 4, cap: 10, variants: 2 },
    { id: 'ferris-wheel', name: 'Ferris Wheel', emoji: '🎡', tw: 3, td: 3, cap: 8, variants: 2 },
    { id: 'zoo', name: 'Zoo', emoji: '🦒', tw: 3, td: 3, cap: 8, variants: 2 },
    { id: 'carousel', name: 'Carousel', emoji: '🎠', tw: 2, td: 2, cap: 3, variants: 2 },
    { id: 'water-slide', name: 'Water Slide', emoji: '🛝', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'mini-golf', name: 'Mini Golf', emoji: '⛳', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'skate-park', name: 'Skate Park', emoji: '🛹', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'museum', name: 'Museum', emoji: '🏛️', tw: 3, td: 2, cap: 8, variants: 2 },
    { id: 'carnival-games', name: 'Carnival Games', emoji: '🎪', tw: 2, td: 1, cap: 6, variants: 2 },
  ],
  deco: [
    { id: 'flower-bed', name: 'Flower Bed', emoji: '🌼', tw: 1, td: 1, cap: 0, variants: 4 },
    { id: 'bench', name: 'Bench', emoji: '🪑', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'fence', name: 'Picket Fence', emoji: '🚧', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'hedge', name: 'Hedge', emoji: '🌳', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'streetlight', name: 'Streetlight', emoji: '💡', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'statue', name: 'Statue', emoji: '🗿', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'stone-path', name: 'Stone Path', emoji: '🪨', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'picnic-table', name: 'Picnic Table', emoji: '🧺', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'mailbox', name: 'Mailbox', emoji: '📮', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'pond', name: 'Pond', emoji: '🦆', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'flag-pole', name: 'Flag Pole', emoji: '🚩', tw: 1, td: 1, cap: 0, variants: 4 },
  ],
  downtown: [
    // 1×1 slim towers
    { id: 'small-office', name: 'Small Office', emoji: '🏢', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'glass-office', name: 'Glass Office', emoji: '🔷', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'brick-highrise', name: 'Brick Highrise', emoji: '🧱', tw: 1, td: 1, cap: 7, variants: 3 },
    { id: 'deco-tower', name: 'Deco Tower', emoji: '🗼', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'green-glass-tower', name: 'Green Tower', emoji: '🟢', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'clock-tower', name: 'Clock Tower', emoji: '🕰️', tw: 1, td: 1, cap: 7, variants: 3 },
    { id: 'round-tower', name: 'Round Tower', emoji: '🛢️', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'hotel', name: 'Grand Hotel', emoji: '🏨', tw: 1, td: 1, cap: 7, variants: 3 },
    // 2×1 office blocks
    { id: 'office-block', name: 'Office Block', emoji: '🏢', tw: 2, td: 1, cap: 8, variants: 2 },
    { id: 'shopping-office', name: 'Shops & Offices', emoji: '🛍️', tw: 2, td: 1, cap: 8, variants: 2 },
    // 2×2 big skyscrapers
    { id: 'glass-skyscraper', name: 'Glass Skyscraper', emoji: '🏙️', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'dark-skyscraper', name: 'Black Tower', emoji: '🌃', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'corporate-hq', name: 'Corporate HQ', emoji: '🏦', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'twin-setback', name: 'Twin Towers', emoji: '🏬', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'spire-tower', name: 'Spire Tower', emoji: '📡', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'tech-campus', name: 'Tech Campus', emoji: '💻', tw: 2, td: 2, cap: 9, variants: 2 },
    { id: 'city-bank', name: 'City Bank', emoji: '🏛️', tw: 2, td: 2, cap: 10, variants: 2 },
  ],
};

// flat id -> entry lookup (built once)
const _ENTRY_BY_ID = {};
for (const cat in CATALOG) for (const e of CATALOG[cat]) _ENTRY_BY_ID[e.id] = e;

// catalogModel(id, variant) -> voxel model with tw/td set, or null for unknown id
export function catalogModel(id, variant) {
  const key = String(id == null ? '' : id);
  const entry = _ENTRY_BY_ID[key];
  const build = BUILDERS[key];
  if (!entry || !build) return null;
  const v = (variant | 0);
  const m = build(catRng(key, v), v, entry);
  if (!m || typeof m !== 'object') return null;
  flipZ(m);                 // normalize: front -> +Z (max-Z) face
  m.tw = entry.tw; m.td = entry.td;
  return m;
}

// ---------------------------------------------------------------------------
// catalogAnim(id) -> null | { part, ox,oy,oz, ax,ay,az, speed }
// part = voxel model of the MOVING piece only (the matching catalogModel base
// no longer contains it). (ox,oy,oz) = part-center offset in WORLD units from
// the footprint center at ground. (ax,ay,az) = unit axis in MODEL-LOCAL space.
// Each part is authored so its own model center is the natural pivot.
// ---------------------------------------------------------------------------
export function catalogAnim(id) {
  switch (String(id == null ? '' : id)) {
    case 'ferris-wheel': return { part: _ferrisSpinner(), ox: 0, oy: 20, oz: 0, ax: 0, ay: 0, az: 1, speed: 0.3 };
    case 'carousel': return { part: _carouselSpinner(), ox: 0, oy: 7, oz: 0, ax: 0, ay: 1, az: 0, speed: 0.6 };
    case 'wind-power': return { part: _windSpinner(), ox: 0, oy: 11, oz: 0, ax: 0, ay: 0, az: 1, speed: 1.4 };
    case 'fountain': return { part: _fountainSpinner(), ox: 0, oy: 5, oz: 0, ax: 0, ay: 1, az: 0, speed: 0.5 };
    case 'barber': return { part: _barberSpinner(), ox: -2, oy: 2.5, oz: 2, ax: 0, ay: 1, az: 0, speed: 2.5 };
    default: return null;
  }
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

// ---------------------------------------------------------------------------
// boatModel(variant) — ≥3 boats facing -Z (like cars), ≤6 long, hull bottom ~y0
// ---------------------------------------------------------------------------
export function boatModel(variant) {
  const v = (((variant | 0) % 3) + 3) % 3;
  const rng = mulberry32(((variant | 0) >>> 0) + 401);
  const pick = a => a[(rng() * a.length) | 0];
  if (v === 0) {
    // sailboat with a white sail
    const g = grid(3, 7, 6);
    const hull = pick([C.woodDark, C.roofBrown, C.trunk, C.red]);
    g.set(1, 1, 1, hull);                                       // bow tip (front -Z)
    for (let z = 2; z < 6; z++) { g.set(0, 1, z, hull); g.set(1, 1, z, hull); g.set(2, 1, z, hull); }
    for (let z = 1; z < 6; z++) g.set(1, 0, z, hull);           // keel
    for (let y = 2; y <= 5; y++) g.set(1, y, 3, C.trunkDark);   // mast
    for (let y = 2; y <= 4; y++) for (let z = 3; z <= 4; z++) g.set(1, y, z, C.signWhite); // sail
    g.set(1, 5, 3, C.red);                                      // pennant
    return g.done();
  }
  if (v === 1) {
    // little rowboat
    const g = grid(3, 3, 6);
    const hull = pick([C.wood, C.plank, C.roofBrown, C.orange]);
    for (let z = 1; z < 5; z++) { g.set(0, 1, z, hull); g.set(2, 1, z, hull); g.set(1, 0, z, hull); }
    g.set(1, 1, 0, hull); g.set(1, 1, 5, hull);                 // bow / stern caps
    g.set(1, 1, 2, C.woodDark); g.set(1, 1, 3, C.woodDark);     // seats
    g.set(0, 1, 2, C.trunkDark); g.set(2, 1, 3, C.trunkDark);   // oars
    return g.done();
  }
  // mini-ferry
  const g = grid(3, 4, 6);
  const hull = pick([C.blue, C.roofBlue, C.navy, C.teal]);
  for (let x = 0; x < 3; x++) for (let z = 1; z < 6; z++) g.set(x, 0, z, hull); // wide flat hull
  for (let x = 0; x < 3; x++) g.set(x, 1, 1, C.signWhite);      // bow rail (front -Z)
  g.box(0, 1, 2, 2, 2, 4, C.offwhite);                          // cabin
  for (let x = 0; x < 3; x++) g.set(x, 2, 3, C.winCool);        // windows
  g.set(1, 3, 3, C.red);                                        // funnel
  return g.done();
}

// ---------------------------------------------------------------------------
// dogModel(variant) — ≥3 tiny dogs (≤3×3×4), varied coats, facing -Z
// ---------------------------------------------------------------------------
export function dogModel(variant) {
  const coats = [C.trunk, C.woodDark, C.dirt, C.hairBlack, C.offwhite, C.sandDark, C.hairAuburn];
  const vi = (((variant | 0) % coats.length) + coats.length) % coats.length;
  const coat = coats[vi];
  const g = grid(3, 3, 4);
  g.set(1, 1, 1, coat); g.set(1, 1, 2, coat);                   // body
  g.set(0, 0, 1, coat); g.set(2, 0, 1, coat); g.set(0, 0, 2, coat); g.set(2, 0, 2, coat); // legs
  g.set(1, 2, 0, coat); g.set(1, 1, 0, vi % 2 ? C.black : coat); // head + nose (front -Z)
  g.set(1, 2, 3, coat);                                         // tail (+Z)
  return g.done();
}

// ---------------------------------------------------------------------------
// balloonModel(variant) — ≥5 bright single balloons + a 1-voxel string, ≤3×6×3
// ---------------------------------------------------------------------------
export function balloonModel(variant) {
  const cols = [C.red, C.blue, C.roofGreen, C.pYellow, C.pink, C.purple, C.orange, C.teal];
  const c = cols[(((variant | 0) % cols.length) + cols.length) % cols.length];
  const g = grid(3, 6, 3);
  g.box(0, 3, 1, 2, 5, 1, c);                                   // balloon body
  g.set(1, 3, 0, c); g.set(1, 3, 2, c); g.set(1, 4, 0, c); g.set(1, 4, 2, c);
  g.set(1, 2, 1, c);                                            // knot
  g.set(1, 1, 1, C.signWhite); g.set(1, 0, 1, C.signWhite);    // string line
  return g.done();
}

// ---------------------------------------------------------------------------
// sparkModel(variant) — ≥6 tiny 2×2×2 glowing burst cubes (vivid palette + 203)
// ---------------------------------------------------------------------------
export function sparkModel(variant) {
  const cols = [C.red, C.yellow, C.blue, C.roofGreen, C.orange, C.pink, C.purple, C.neon, C.gold, C.teal];
  const c = cols[(((variant | 0) % cols.length) + cols.length) % cols.length];
  const g = grid(2, 2, 2);
  g.box(0, 0, 0, 1, 1, 1, c);
  return g.done();
}

// ---------------------------------------------------------------------------
// _selfTest — iterate every generator, verify bounds + palette validity.
// ---------------------------------------------------------------------------
export function _selfTest() {
  const errors = [];
  const validColor = c => typeof PALETTE[c] === 'number';
  const check = (name, m) => {
    if (!m || typeof m !== 'object') { errors.push(name + ': not an object'); return; }
    const { sx, sy, sz, blocks } = m;
    if (!(Number.isInteger(sx) && sx > 0)) errors.push(name + ': bad sx=' + sx);
    if (!(Number.isInteger(sy) && sy > 0)) errors.push(name + ': bad sy=' + sy);
    if (!(Number.isInteger(sz) && sz > 0)) errors.push(name + ': bad sz=' + sz);
    if (!Array.isArray(blocks)) { errors.push(name + ': blocks not array'); return; }
    if (blocks.length === 0) errors.push(name + ': empty (no blocks)');
    for (const b of blocks) {
      if (!Array.isArray(b) || b.length !== 4) { errors.push(name + ': bad block ' + JSON.stringify(b)); continue; }
      const [x, y, z, c] = b;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z))
        errors.push(name + ': non-int coord ' + JSON.stringify(b));
      else if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz)
        errors.push(name + ': OOB ' + JSON.stringify(b) + ' size ' + sx + 'x' + sy + 'x' + sz);
      if (!validColor(c)) errors.push(name + ': bad color index ' + c);
    }
  };

  const wrap = (name, fn) => { try { check(name, fn()); } catch (e) { errors.push(name + ': threw ' + e); } };

  // buildings — every zone/level and several variants + hostile inputs
  for (const z of ['R', 'C', 'I', 'r', 'x', null, undefined]) {
    for (const l of [1, 2, 3, 0, 4, -1, 2.7, NaN]) {
      for (const v of [0, 1, 2, 3, 4, 5, 7, 255, -1, 999]) {
        wrap('building(' + z + ',' + l + ',' + v + ')', () => buildingModel(z, l, v));
      }
    }
  }
  // services
  for (const k of ['park', 'school', 'fire', 'fountain', 'stadium', 'power', 'zzz', null]) {
    for (const v of [0, 1, 2, 3, -1, 99]) wrap('service(' + k + ',' + v + ')', () => serviceModel(k, v));
  }
  // trees
  for (let v = -2; v <= 10; v++) wrap('tree(' + v + ')', () => treeModel(v));
  // roads — all 16 masks (+ out-of-range)
  for (let mask = 0; mask <= 16; mask++) wrap('road(' + mask + ')', () => roadModel(mask));
  // cars
  for (let v = -2; v <= 12; v++) wrap('car(' + v + ')', () => carModel(v));
  // people
  for (let v = 0; v <= 16; v++) wrap('person(' + v + ')', () => personModel(v));
  // birds / clouds / smoke / construction
  wrap('bird', () => birdModel());
  for (let v = -1; v <= 6; v++) wrap('cloud(' + v + ')', () => cloudModel(v));
  wrap('smoke', () => smokePuffModel());
  wrap('construction', () => constructionModel());

  // catalog — every entry × every variant, validate entry fields + footprint
  const seenIds = new Set();
  for (const cat of ['homes', 'shops', 'factories', 'fun', 'deco', 'downtown']) {
    const list = CATALOG[cat];
    if (!Array.isArray(list)) { errors.push('catalog: missing category ' + cat); continue; }
    for (const e of list) {
      if (!e || typeof e.id !== 'string' || !e.id) { errors.push('catalog(' + cat + '): bad id'); continue; }
      if (seenIds.has(e.id)) errors.push('catalog: duplicate id ' + e.id);
      seenIds.add(e.id);
      if (typeof e.name !== 'string' || !e.name) errors.push(e.id + ': bad name');
      if (typeof e.emoji !== 'string' || !e.emoji) errors.push(e.id + ': bad emoji');
      if (![1, 2, 3, 4].includes(e.tw) || ![1, 2, 3, 4].includes(e.td)) errors.push(e.id + ': bad tw/td');
      const capLo = cat === 'homes' ? 2 : cat === 'deco' ? 0 : 1;
      const capHi = cat === 'homes' ? 30 : cat === 'deco' ? 0 : 10;
      if (!(Number.isInteger(e.cap) && e.cap >= capLo && e.cap <= capHi)) errors.push(e.id + ': bad cap ' + e.cap);
      const minVar = (e.tw > 1 || e.td > 1) ? 2 : 3;
      if (!(Number.isInteger(e.variants) && e.variants >= minVar)) errors.push(e.id + ': bad variants ' + e.variants);
      // v3.1: height cap keyed by the larger footprint dimension.
      const HCAP = { 1: 48, 2: 64, 3: 56, 4: 64 };  // v3.2: raised so downtown towers can be dramatic
      const maxX = e.tw * 8 - 1, maxZ = e.td * 8 - 1, maxH = HCAP[Math.max(e.tw, e.td)];
      for (let v = 0; v < (e.variants | 0); v++) {
        wrap('catalog(' + e.id + ',' + v + ')', () => {
          const m = catalogModel(e.id, v);
          if (!m) throw 'null model';
          if (m.tw !== e.tw || m.td !== e.td) throw 'tw/td mismatch (' + m.tw + ',' + m.td + ')';
          if (m.sx > maxX) throw 'sx ' + m.sx + ' > ' + maxX;
          if (m.sz > maxZ) throw 'sz ' + m.sz + ' > ' + maxZ;
          if (m.sy > maxH) throw 'height ' + m.sy + ' > ' + maxH;
          return m;
        });
      }
    }
  }
  if (catalogModel('does-not-exist', 0) !== null) errors.push('catalogModel: unknown id must return null');
  if (catalogModel(null, 0) !== null) errors.push('catalogModel: null id must return null');

  // ---- v2.1 category counts -------------------------------------------------
  const need = { homes: 12, shops: 18, factories: 14, fun: 14, deco: 10, downtown: 16 };
  for (const cat in need) {
    const n = (CATALOG[cat] || []).length;
    if (n < need[cat]) errors.push('count ' + cat + '=' + n + ' < ' + need[cat]);
  }

  // ---- v2.1 front-face heuristic --------------------------------------------
  // Facing convention: the front (door / storefront / windows) lands on the +Z
  // face. For homes + glass-fronted shops, verify the +Z half of the model is
  // glazed — it holds ≥1 glowing window/neon voxel. (A uniform window grid can be
  // a hair denser at the back from even-spacing rounding, so we require the front
  // be lit rather than a strict front>back count; "front is glazed at all" is the
  // load-bearing signal that the flip put the entrance on +Z.) Stalls skipped.
  const glow = new Set([200, 201, 203]);
  const openAir = new Set(['market-stall', 'fruit-stand']);
  for (const cat of ['homes', 'shops']) {
    for (const e of CATALOG[cat]) {
      if (openAir.has(e.id)) continue;
      for (let v = 0; v < (e.variants | 0); v++) {
        const m = catalogModel(e.id, v);
        if (!m) continue;
        let lit = false;
        for (const b of m.blocks) if (glow.has(b[3]) && b[2] * 2 >= m.sz) { lit = true; break; }
        if (!lit) errors.push('front-face ' + e.id + '#' + v + ': +Z face not glazed');
      }
    }
  }

  // ---- v2.2 new generators --------------------------------------------------
  // (deco entries validated by the catalog loop above under cat 'deco'.)
  // bridges — all 16 masks: deck present, 8×?×8 footprint, y >= 0.
  for (let mask = 0; mask <= 15; mask++) {
    wrap('bridge(' + mask + ')', () => {
      const m = bridgeModel(mask);
      if (m.sx !== 8 || m.sz !== 8) throw 'bridge not 8x?x8 (' + m.sx + 'x' + m.sz + ')';
      return m;
    });
  }
  // boats / dogs / balloons / sparks (hostile inputs included)
  for (let v = -2; v <= 6; v++) wrap('boat(' + v + ')', () => boatModel(v));
  for (let v = -2; v <= 8; v++) wrap('dog(' + v + ')', () => {
    const m = dogModel(v); if (m.sx > 3 || m.sy > 3 || m.sz > 4) throw 'dog too big'; return m;
  });
  for (let v = -2; v <= 10; v++) wrap('balloon(' + v + ')', () => {
    const m = balloonModel(v); if (m.sx > 3 || m.sy > 6 || m.sz > 3) throw 'balloon too big'; return m;
  });
  for (let v = -2; v <= 12; v++) wrap('spark(' + v + ')', () => {
    const m = sparkModel(v); if (m.sx > 2 || m.sy > 2 || m.sz > 2) throw 'spark not 2x2x2'; return m;
  });

  // catalogAnim — parts are valid models with finite offsets/axis; base+part
  // each non-empty; and the base no longer contains the part's silhouette.
  const animIds = ['ferris-wheel', 'carousel', 'wind-power', 'fountain', 'barber'];
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  for (const id of animIds) {
    const a = catalogAnim(id);
    if (!a) { errors.push('anim ' + id + ': returned null'); continue; }
    if (!finite(a.ox) || !finite(a.oy) || !finite(a.oz)) errors.push('anim ' + id + ': non-finite offset');
    if (!finite(a.ax) || !finite(a.ay) || !finite(a.az)) errors.push('anim ' + id + ': non-finite axis');
    if ((a.ax * a.ax + a.ay * a.ay + a.az * a.az) < 0.5) errors.push('anim ' + id + ': zero-length axis');
    if (!finite(a.speed) || a.speed <= 0) errors.push('anim ' + id + ': bad speed ' + a.speed);
    // v3.1: offsets must sit within the resized footprint's world extent + height cap.
    const ae = _ENTRY_BY_ID[id];
    if (ae) {
      const span = Math.max(ae.tw, ae.td) * 8, hcap = ({ 1: 48, 2: 64, 3: 56, 4: 64 })[Math.max(ae.tw, ae.td)];
      if (Math.abs(a.ox) > span || Math.abs(a.oz) > span) errors.push('anim ' + id + ': lateral offset out of footprint');
      if (a.oy < 0 || a.oy > hcap + 12) errors.push('anim ' + id + ': oy ' + a.oy + ' out of range');
    }
    check('anim-part ' + id, a.part);
    const base = catalogModel(id, 0);
    if (!base) { errors.push('anim ' + id + ': base model null'); continue; }
    if (!(base.blocks && base.blocks.length >= 1)) errors.push('anim ' + id + ': empty base');
    if (!(a.part && a.part.blocks && a.part.blocks.length >= 1)) errors.push('anim ' + id + ': empty part');
    // map part voxels into the base-local frame and count coincidences
    const baseSet = new Set(base.blocks.map(b => b[0] + ',' + b[1] + ',' + b[2]));
    const pcx = (a.part.sx - 1) / 2, pcy = (a.part.sy - 1) / 2, pcz = (a.part.sz - 1) / 2;
    const bcx = (base.sx - 1) / 2, bcz = (base.sz - 1) / 2;
    let overlap = 0;
    for (const b of a.part.blocks) {
      const bx = Math.round(b[0] - pcx + a.ox + bcx);
      const by = Math.round(b[1] - pcy + a.oy);
      const bz = Math.round(b[2] - pcz + a.oz + bcz);
      if (baseSet.has(bx + ',' + by + ',' + bz)) overlap++;
    }
    if (overlap * 2 >= a.part.blocks.length)
      errors.push('anim ' + id + ': base still contains part (' + overlap + '/' + a.part.blocks.length + ')');
  }
  // non-animated ids return null
  for (const id of ['small-house', 'bakery', 'park', 'bench', 'stadium', 'does-not-exist'])
    if (catalogAnim(id) !== null) errors.push('catalogAnim(' + id + ') should be null');

  return { ok: errors.length === 0, errors };
}
