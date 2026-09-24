// Blockville models — VEGETATION: trees, bushes, rocks, flowers.
//
// Target look: ref06 of Pablo Gamedev's "Isometric City Voxel" — chunky CUBOID
// canopies in lime/yellow-green with a darker lower band and a few darker
// "pixel" dots, square orange-brown trunks with a visible branch fork, cube
// bushes, grey stepped rock clusters and tiny plus-shaped voxel flowers.
//
// Everything is authored at res 4 (4 voxels per world unit) as a short list of
// boxes, so the SAME shape feeds two consumers:
//   vegModel(kind)      voxel model (res 4) — near LOD, real AO, pixel dots
//   vegFarBoxes(kind)   the same boxes in world units, minus the dots — far
//                       LOD for render/props.js (≈ 6-10 boxes, one silhouette)
// World sizes match the legacy res-1 trees (5 x 9 x 5), so props.js's size
// ladders and main.js's TREE tiles keep their scale.
//
// treeModel(variant) keeps its old contract: any int, deterministic, ≥5 shapes.

import { C, grid, mulberry32 } from './core.js';

const RES = 4;

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------
const LIME = { leaf: C.vegLeaf, band: C.vegLeafBand, dot: C.vegLeafDot };
const PINE = { leaf: C.vegPine, band: C.vegPineBand, dot: C.vegPineDot };
const BLOOM = { leaf: C.vegBloom, band: C.vegBloomBand, dot: C.vegBloomDot };

// ---------------------------------------------------------------------------
// Shapes — fine-voxel boxes [x0, y0, z0, x1, y1, z1] (inclusive).
// Grid sx x H x sz fine (20-26 = 5-6.5 world); X/Z centre is at sx/2, sz/2.
//   L = leaf canopy lobe (lower band + pixel dots), T = trunk / branch,
//   S = solid (explicit colour in p[7])
// ---------------------------------------------------------------------------
// Proportions measured off ref06: a LOLLIPOP — the visible trunk is ~40% of
// the height and ~1/4 of the canopy width (3 fine voxels under an 11-wide
// canopy); canopies are chunky cuboids 1-2x as tall as they are wide.
// Round 3 (critic: "a smooth lime box on an orange stick"): branches are now
// as thick as ref06's (2-3 voxels, not 0.5 units hidden under the canopy),
// they fork BELOW the canopy so the Y reads in the iso view, and the round /
// cluster / blossom / pine canopies are 2-4 offset lobes, each with its own
// band, so every tree has visible steps and creases instead of one box.
const SHAPES = {
  // Round 6 (critic: "park trees look soft and undersized, thin dark trunks,
  // no visible fork"): every canopy is ~1.3x wider (11 -> 14 fine voxels),
  // trunks are 4x4 (a full world unit, ~0.29 of the canopy as in ref06) and
  // each fork sits 3-5 voxels BELOW its lobes, so the Y / loop shows under
  // the band in the iso view instead of hiding inside the canopy.
  //
  // ref06 tree 1: one tall column canopy on a long straight trunk
  column: {
    sx: 20, sy: 42, sz: 20, pal: LIME, dots: 1.0,
    parts: [
      ['T', 8, 0, 8, 11, 18, 11],
      ['L', 3, 17, 3, 16, 41, 16],
    ],
  },
  // ref06 tree 2 (two lobes): a big cube canopy + a lower half-width lobe out
  // to one side; a thick branch leaves the trunk well under the canopy, runs
  // sideways and steps up into that lobe, leaving ref06's rectangular "loop"
  // of sky between branch, trunk and canopy. 21 fine wide x 35 tall
  // (street max 0.58 -> 3.05 x 5.08 world, under the selfTest's house size).
  round: {
    sx: 22, sy: 35, sz: 22, pal: LIME, dots: 1.0,
    parts: [
      // The side lobe sits on a DIAGONAL corner (-x, +z) so that under three
      // of the four 90-degree scatter yaws it shows left, right or in front
      // of the main cube instead of hiding behind it.
      ['T', 12, 0, 6, 15, 21, 9],     // trunk, up into the main cube
      ['T', 3, 13, 7, 11, 14, 8],     // branch out along x, 5 under the canopy ...
      ['T', 3, 13, 7, 4, 14, 16],     // ... round the corner along z ...
      ['T', 3, 13, 15, 4, 19, 16],    // ... and up into the side lobe
      ['L', 0, 19, 13, 7, 30, 20],    // side lobe: 8 wide, top 4 under the main top
      ['L', 7, 19, 1, 20, 34, 14],    // main cube (14 x 16 x 14)
    ],
  },
  // ref06 tree 3 (three lobes): a Y-forked trunk under a tall back lobe and
  // two lower side lobes; both fork arms run out under the side lobes and
  // step up into them, so the Y shows below the bands.
  // r12 (critic: "the small twin-cube tree is copied too often ... ref06
  // mixes clustered 3-cube crowns"): the two side lobes used to sit 3.5
  // voxels in FRONT of the tall lobe's centre (z 9-18 vs 5-16), so under two
  // of the four scatter yaws one of them slid in front of the tall lobe and
  // the crown read as a twin. Now both sit on the tall lobe's own z line, one
  // each side, pushed out to +-10 voxels: whichever 90-degree turn an
  // instance gets, one lobe shows left of the tall one and one right of it,
  // always a three-cube crown.
  cluster: {
    sx: 28, sy: 40, sz: 28, pal: PINE, dots: 0.9,   // the greener lime: a wood is not one flat tone
    parts: [
      ['T', 12, 0, 12, 15, 23, 15],   // trunk + leader into the tall lobe
      ['T', 4, 14, 13, 11, 15, 14],   // left arm, low
      ['T', 4, 14, 13, 5, 19, 14],    //   up into the left lobe
      ['T', 16, 15, 13, 23, 16, 14],  // right arm, one higher
      ['T', 22, 15, 13, 23, 20, 14],  //   up into the right lobe
      ['L', 8, 23, 8, 19, 39, 19],    // tall centre lobe (12 x 17 x 12)
      ['L', 0, 19, 9, 8, 29, 18],     // left lobe (9 x 11 x 10)
      ['L', 19, 20, 9, 27, 31, 18],   // right lobe
    ],
  },
  // ref06 tree 4: a young sapling — thin stem with a side shoot, a small
  // column canopy with a heavy band, a grass tuft at its foot
  sapling: {
    sx: 20, sy: 32, sz: 20, pal: LIME, dots: 0.8,
    parts: [
      ['T', 9, 0, 9, 11, 14, 11],
      ['T', 12, 5, 10, 14, 6, 11],
      ['T', 13, 5, 10, 14, 11, 11],
      ['S', 12, 0, 12, 13, 1, 13, C.vegTuft],
      ['S', 7, 0, 12, 8, 0, 13, C.vegTuft],
      ['L', 5, 12, 5, 15, 31, 15],
    ],
  },
  // 'pine' is what the conifer field scatters. ref05/06 have no tiered
  // conifers, so it is a slender cuboid poplar in a deeper yellow-green:
  // one tall narrow block with its band (a poplar next to the column tree).
  pine: {
    sx: 20, sy: 40, sz: 20, pal: PINE, dots: 0.8,
    parts: [
      ['T', 8, 0, 8, 11, 14, 11],
      ['L', 4, 13, 4, 15, 39, 15],
    ],
  },
  // pink blossom: ref06 tree 2 mirrored — main cube + a lower side lobe on a
  // branch loop the other way, plus a short stub.
  blossom: {
    sx: 22, sy: 35, sz: 22, pal: BLOOM, dots: 0.8,
    parts: [
      ['T', 6, 0, 8, 9, 20, 11],
      ['T', 10, 13, 9, 18, 14, 10],   // branch out under the side lobe
      ['T', 17, 13, 9, 18, 18, 10],   //   and up into it
      ['T', 3, 15, 9, 5, 16, 10],     // a stub the other way
      ['L', 14, 17, 6, 21, 27, 14],
      ['L', 1, 19, 3, 14, 34, 16],
    ],
  },
  // ref06 bush 1: a cube with a little cube at its foot (2.25 x 1.75 x 2.25)
  // r10 (critic: "our bushes are plain cubes, ref06 bushes have side nubs and
  // a stepped silhouette"): the main cube now carries a low 2-high ledge
  // along one side (ref06 bush 2) and a half-height cube stepped out of the
  // opposite corner (bush 1), so every yaw shows a step and a nub.
  shrub: {
    sx: 10, sy: 7, sz: 10, pal: null, bush: true,
    parts: [
      ['S', 1, 0, 1, 7, 6, 7, C.vegBush],          // main cube (7 x 7 x 7)
      ['S', 6, 0, 6, 9, 3, 9, C.vegBush],          // foot cube, +x +z corner
      ['S', 0, 0, 2, 0, 2, 6, C.vegBush],          // low ledge along -x
      ['S', 2, 0, 0, 4, 1, 0, C.vegBush],          // small nub on -z
    ],
  },
  // r13 (critic r12: "the cube bushes read well but vary little"): ref06
  // bush 3 — a tall block (6 x 9 x 6) with a half-height cube at its foot
  // (a second corner cube read as a little face, so just the one). props.js deals half the
  // scattered shrubs into this shape.
  bushTall: {
    sx: 10, sy: 9, sz: 10, pal: null, bush: true,
    parts: [
      ['S', 1, 0, 1, 6, 8, 6, C.vegBush],          // tall block
      ['S', 6, 0, 4, 9, 4, 8, C.vegBush],          // foot cube, out of the +x face past its corner
    ],
  },
  // ref06 bush 2, stretched into a planted hedge (5.25 x 2 x 1.25)
  hedge: {
    sx: 21, sy: 7, sz: 5, pal: null, bush: true,
    parts: [
      ['S', 0, 0, 0, 11, 6, 4, C.vegBush],
      ['S', 12, 0, 0, 20, 4, 4, C.vegBush],
      ['S', 15, 5, 1, 18, 5, 3, C.vegBush],
    ],
  },
  // ref06 rock 1 / 2. History: r3-r7 many 1-voxel pieces + seams ("busy
  // pile"), r8 five big blocks ("too few"), r9-r11 chips a voxel CLEAR of
  // the mass + carved notches ("rubble, black gaps"), r12 seven big touching
  // blocks ("only two or three grey cubes, soft bevelled edges").
  // r13 (critic r12: "ref06 rocks are sharp-edged stepped clusters: one large
  // block with a mid ledge and 5-8 small offset chips around the base, top /
  // left / right in three clearly separate tones"): one tall block, a
  // half-height ledge block stepped out of its front, two low shoulder
  // steps, two small cubes up on the ledges, and 8 chips (2-3 voxels) round
  // the foot. Every chip TOUCHES the mass face-on (no 1-voxel slits for the
  // AO to fill black) but is offset along it, so the base reads as a broken
  // stepped rim. Sharpness is the mesher's job (props.js ROCK_AO: a crisp
  // 1-voxel crease line, no ground gradient).
  rock: {
    sx: 22, sy: 11, sz: 22, pal: null,
    parts: [
      ['S', 4, 0, 4, 16, 3, 16, C.vegRock],        // low platform (13 x 4 x 13)
      ['S', 5, 0, 5, 13, 10, 12, C.vegRock],       // THE big block, back-left (9 x 11 x 8, not a tower)
      ['S', 10, 0, 10, 17, 6, 16, C.vegRock],      // mid ledge block, front-right (top at ~2/3 height)
      ['S', 3, 0, 11, 8, 4, 17, C.vegRock],        // shoulder step, -x / +z
      ['S', 13, 0, 3, 18, 5, 8, C.vegRock],        // shoulder step, +x / -z
      ['S', 14, 7, 12, 16, 8, 14, C.vegRock],      // small cube up on the mid ledge
      ['S', 16, 6, 4, 17, 7, 5, C.vegRock],        // small cube on the back shoulder
      // chips round the foot (each touches one face, offset along it)
      ['S', 1, 0, 6, 3, 2, 8, C.vegRock],
      ['S', 0, 0, 13, 2, 1, 15, C.vegRock],
      ['S', 5, 0, 18, 7, 2, 20, C.vegRock],
      ['S', 11, 0, 17, 13, 1, 19, C.vegRock],
      ['S', 18, 0, 11, 20, 2, 13, C.vegRock],
      ['S', 19, 0, 5, 20, 1, 7, C.vegRock],
      ['S', 8, 0, 1, 10, 2, 3, C.vegRock],
    ],
  },
};

const TREE_KINDS = ['column', 'round', 'cluster', 'sapling', 'pine', 'blossom'];

// ~16% of the lobe height, never less than 3 fine voxels (0.75 units).
// r14 (critic r13: "the darker lower band is faint next to ref06's clear
// two-tone band"): min 2 -> 3, so the round / cluster / blossom lobes (11-16
// rows) carry a band as deep as ref06's (~0.2 of the face, sapling ~0.21).
function bandRows(h) { return Math.max(3, Math.round(h * 0.16)); }

function paint(g, parts) {
  for (const p of parts) {
    const [k, x0, y0, z0, x1, y1, z1] = p;
    if (k === 'T') g.box(x0, y0, z0, x1, y1, z1, C.vegTrunk);
    else if (k === 'S') g.box(x0, y0, z0, x1, y1, z1, p[7]);
  }
}

// Each lobe: dark band along its bottom rows, leaf above. Leaf always wins
// over another lobe's band (so a band never paints a stripe across a lobe it
// is buried in) and a band only fills air or trunk.
function paintLeaves(g, parts, pal) {
  const key = (x, y, z) => x + ',' + y + ',' + z;
  for (const p of parts) {
    if (p[0] !== 'L') continue;
    const [, x0, y0, z0, x1, y1, z1] = p;
    g.box(x0, y0 + bandRows(y1 - y0 + 1), z0, x1, y1, z1, pal.leaf);
  }
  for (const p of parts) {
    if (p[0] !== 'L') continue;
    const [, x0, y0, z0, x1, y1, z1] = p;
    const yb = y0 + bandRows(y1 - y0 + 1) - 1;
    for (let y = y0; y <= yb; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const c = g.map.get(key(x, y, z));
      if (c == null || c === C.vegTrunk) g.set(x, y, z, pal.band);
    }
  }
}

// ref06 bushes: a thin darker skirt along the ground so a bush separates
// from the grass it stands in.
function bushSkirt(g) {
  for (const [k, c] of g.map) if (c === C.vegBush && k.split(',')[1] === '0') g.map.set(k, C.vegBushDark);
}

// Darker "pixel" dots on the exposed side faces of every canopy lobe, as
// sparse as ref06: 2-4 on a big face (the tall column), 1-2 on a small lobe,
// every one a single crisp voxel (1/11 of the face width, ref06's big dot)
// in a colour only ~12% darker than the leaf. Round 3 painted 2-8 per face
// incl. 1x2 dashes in the band colour: the critic counted 8-15 per face and
// read the canopies as busy. Dots keep a 2-voxel clear margin from each other
// and from the face edges / band, and only land on plain leaf with open air
// in front, so each one is visible and none sits in a crease.
function sprinkleDots(g, parts, pal, rng, k) {
  const at = (x, y, z) => g.map.get(x + ',' + y + ',' + z);
  for (const p of parts) {
    if (p[0] !== 'L') continue;
    const [, x0, y0, z0, x1, y1, z1] = p;
    const b = bandRows(y1 - y0 + 1);
    const ya = y0 + b + 2, yb = y1 - 2;
    if (yb < ya) continue;
    const faces = [
      ['x', x0, -1, z0, z1], ['x', x1, 1, z0, z1],
      ['z', z0, -1, x0, x1], ['z', z1, 1, x0, x1],
    ];
    for (const [ax, f, o, u0, u1] of faces) {
      const area = (u1 - u0 - 3) * (yb - ya + 1);
      if (area <= 0) continue;
      // r8 (critic: "canopies missing the dark pixel dots, look flatter"):
      // up to 5 per big face (ref06's tall column shows 5-8), and on faces
      // with room ~1 in 4 is ref06's bigger 2x2 dot. Spacing 4 keeps them
      // separate squares.
      const n = Math.min(5, Math.round((area / 26) * k * (0.75 + rng() * 0.5)));
      const used = [];
      const xyz = (uu, yy) => ax === 'x' ? [f, yy, uu] : [uu, yy, f];
      const plain = (uu, yy) => {
        const [x, y3, z] = xyz(uu, yy);
        const ox = ax === 'x' ? x + o : x, oz = ax === 'z' ? z + o : z;
        return at(x, y3, z) === pal.leaf && at(ox, y3, oz) == null;
      };
      const big = (u1 - u0) >= 11;
      for (let i = 0, tries = 0; i < n && tries < n * 12; tries++) {
        const u = u0 + 2 + Math.floor(rng() * Math.max(1, u1 - u0 - 4));
        const y = ya + Math.floor(rng() * (yb - ya));
        if (used.some(([a, c]) => Math.abs(a - u) < 4 && Math.abs(c - y) < 4)) continue;
        if (!plain(u, y)) continue;
        const cells = [[u, y]];
        if (big && rng() < 0.25 && plain(u + 1, y) && plain(u, y + 1) && plain(u + 1, y + 1)) {
          cells.push([u + 1, y], [u, y + 1], [u + 1, y + 1]);
        }
        for (const [cu, cy] of cells) { const [x, yy, z] = xyz(cu, cy); g.set(x, yy, z, pal.dot); }
        used.push([u, y]);
        i++;
      }
    }
  }
}

// `flip` transposes x <-> z: the same tree mirrored on screen (its side lobe
// swaps from the left to the right of the trunk in the iso view). Tile trees
// (main.js T.TREE) are never rotated, so this is their only source of mirror
// variety.
function transposed(s) {
  const t = (p) => [p[0], p[3], p[2], p[1], p[6], p[5], p[4], ...p.slice(7)];
  return { ...s, sx: s.sz, sz: s.sx, parts: s.parts.map(t),
    carve: s.carve && s.carve.map((c) => [c[2], c[1], c[0], c[5], c[4], c[3]]) };
}

function buildShape(kind, seed, flip) {
  const s = flip ? transposed(SHAPES[kind]) : SHAPES[kind];
  const g = grid(s.sx, s.sy, s.sz, RES);
  paint(g, s.parts);
  if (s.pal) {
    paintLeaves(g, s.parts, s.pal);
    sprinkleDots(g, s.parts, s.pal, mulberry32(seed >>> 0), s.dots || 1);
  }
  if (s.bush) bushSkirt(g);
  if (s.carve) for (const c of s.carve) {
    for (let x = c[0]; x <= c[3]; x++) for (let y = c[1]; y <= c[4]; y++) for (let z = c[2]; z <= c[5]; z++) g.del(x, y, z);
  }
  return g.done();
}

// ---------------------------------------------------------------------------
// Flowers — ref06: a plus of petals round a yellow eye, sitting straight on a
// little plus-shaped green leaf clump (1-2 voxels tall, no bare stem), 3 x 3
// grid voxels across. vegFlower itself works at any res.
// r14 (critic r13: "flowers as big as a tree canopy ... read as giant toys;
// in ref06 a flower is a tiny ankle-height accent, ~1/4 of a cube bush"):
// the patch is now authored at res 4 (a flower is 0.75 units before the
// instance scale, ~0.5 in the world — r13's were 1.5-2) and is a small loose
// group of five on the ground instead of three big ones.
// ---------------------------------------------------------------------------
export function vegFlower(g, x, y, z, petal, leafH = 1) {
  for (let i = 0; i < leafH; i++) {                      // leaf clump: a plus
    const yy = y + i;
    g.set(x, yy, z, C.vegStem);
    g.set(x - 1, yy, z, C.vegStem); g.set(x + 1, yy, z, C.vegStem);
    g.set(x, yy, z - 1, C.vegStem); g.set(x, yy, z + 1, C.vegStem);
  }
  const yp = y + leafH;                                  // petals right on top
  g.set(x - 1, yp, z, petal); g.set(x + 1, yp, z, petal);
  g.set(x, yp, z - 1, petal); g.set(x, yp, z + 1, petal);
  g.set(x, yp, z, C.vegPollen);
}

function flowersModel(seed) {
  const g = grid(14, 3, 14, RES);
  const rng = mulberry32((seed >>> 0) + 7);
  const cols = [C.vegPetalW, C.vegPetalR, C.vegPetalB];
  // Five flowers loosely dropped over a ~3.5 x 3.5-unit spot (x the instance
  // scale), every pair >= 3 voxels apart in x or z so no two pluses touch
  // (each reads as its own little flower, never a heap). Leaf clumps are 1
  // or 2 voxels tall (same triangle count) so the heads sit at two heights.
  const spots = [[2, 3], [7, 1], [11, 6], [5, 8], [10, 11]];
  const k = Math.floor(rng() * 3);
  for (let i = 0; i < spots.length; i++) {
    vegFlower(g, spots[i][0], 0, spots[i][1], cols[(i + k) % cols.length], rng() < 0.5 ? 1 : 2);
  }
  return g.done();
}

// ---------------------------------------------------------------------------
// Public: models + far-LOD boxes
// ---------------------------------------------------------------------------
const _cache = new Map();

/**
 * Voxel model for a vegetation kind: 'column' | 'round' | 'cluster' |
 * 'sapling' | 'pine' | 'blossom' | 'shrub' | 'bushTall' | 'hedge' | 'rock' |
 * 'flowers'.
 * Deterministic; cached (callers must not mutate the result).
 */
export function vegModel(kind, seed, flip = false) {
  seed = (seed | 0) >>> 0;
  const key = kind + ':' + seed + (flip ? ':f' : '');
  let m = _cache.get(key);
  if (m) return m;
  if (kind === 'flowers') m = flowersModel(seed);
  else m = buildShape(SHAPES[kind] ? kind : 'round', seed + 101, !!flip);
  _cache.set(key, m);
  return m;
}

/**
 * The same shape as world-unit boxes (bottom at y=0, X/Z centred), no dots:
 * [{x0,y0,z0,x1,y1,z1,ci}]. For the far impostor in render/props.js.
 */
export function vegFarBoxes(kind) {
  const s = SHAPES[kind];
  if (!s) return null;
  const hx = s.sx / 2, hz = s.sz / 2;
  const out = [];
  const add = (x0, y0, z0, x1, y1, z1, ci) => out.push({
    x0: (x0 - hx) / RES, y0: y0 / RES, z0: (z0 - hz) / RES,
    x1: (x1 + 1 - hx) / RES, y1: (y1 + 1) / RES, z1: (z1 + 1 - hz) / RES, ci,
  });
  for (const p of s.parts) {
    const [k, x0, y0, z0, x1, y1, z1] = p;
    // Every branch too: the Y-fork under the canopy is what tells ref06's
    // tree shapes apart at the overview zoom (iso-park is drawn on this LOD).
    if (k === 'T') add(x0, y0, z0, x1, y1, z1, C.vegTrunk);
    else if (k === 'S') add(x0, y0, z0, x1, y1, z1, p[7]);
    else {
      const b = bandRows(y1 - y0 + 1);
      add(x0, y0, z0, x1, y0 + b - 1, z1, s.pal.band);
      add(x0, y0 + b, z0, x1, y1, z1, s.pal.leaf);
    }
  }
  return out;
}

export const VEG_TREE_KINDS = TREE_KINDS;

/**
 * Stamp a ready-made ref06 tree / bush / rock into a res-4 building grid, so
 * lot planting matches the scattered vegetation exactly (band, dots, forks).
 * (x, z) is the model's X/Z centre, y its base; `scale` 0.5 halves it for a
 * compact lot tree (every other voxel, band and dots survive). Returns g.
 */
export function stampVeg(g, kind, x, y, z, seed = 0, scale = 1) {
  const m = vegModel(kind, seed);
  const k = scale >= 1 ? 1 : Math.max(1, Math.round(1 / scale));
  const ox = x - Math.floor(m.sx / 2 / k), oz = z - Math.floor(m.sz / 2 / k);
  if (k === 1) {
    for (const [bx, by, bz, c] of m.blocks) g.set(ox + bx, y + by, oz + bz, c);
    return g;
  }
  // Downsample by k: each coarse cell takes its corner voxel's colour, but a
  // pixel dot anywhere in the cell wins (plain point sampling dropped every
  // dot that sat on an odd coordinate, so half-scale lot trees came out as
  // plain lime boxes).
  const DOTS = new Set([C.vegLeafDot, C.vegPineDot, C.vegBloomDot]);
  const cells = new Map();
  const cellKey = (bx, by, bz) => ((bx / k) | 0) + ',' + ((by / k) | 0) + ',' + ((bz / k) | 0);
  for (const [bx, by, bz, c] of m.blocks) {
    if (!(bx % k || by % k || bz % k)) cells.set(cellKey(bx, by, bz), c);
  }
  // only recolour a cell that is solid anyway, so a dot never adds a bump
  for (const [bx, by, bz, c] of m.blocks) {
    if (!DOTS.has(c)) continue;
    const key = cellKey(bx, by, bz);
    if (cells.has(key)) cells.set(key, c);
  }
  for (const [key, c] of cells) {
    const [cx, cy, cz] = key.split(',').map(Number);
    g.set(ox + cx, y + cy, oz + cz, c);
  }
  return g;
}

// ---------------------------------------------------------------------------
// miniTree — tiny cuboid tree for park / stadium landscaping. Works on any
// grid res: at res 1 it is a 1-voxel trunk under a 3x3x2 block; at res > 1
// the same proportions in fine voxels. `foliage` picks the palette family.
// ---------------------------------------------------------------------------
function familyFor(c) {
  if (c === C.blossom || c === C.blossomDark || c === C.pink || c === C.vegBloom) return BLOOM;
  if (c === C.pine || c === C.pineDark || c === C.vegPine) return PINE;
  return LIME;
}

export function miniTree(g, cx, cz, foliage) {
  const r = g.res || 1;
  const pal = familyFor(foliage);
  if (r === 1) {
    g.set(cx, 0, cz, C.vegTrunk); g.set(cx, 1, cz, C.vegTrunk);
    g.box(cx - 1, 2, cz - 1, cx + 1, 2, cz + 1, pal.band);
    g.box(cx - 1, 3, cz - 1, cx + 1, 3, cz + 1, pal.leaf);
    return;
  }
  const tw = Math.max(1, r >> 1), cw = 3 * r;
  const t0 = cx - (tw >> 1), c0 = cx - (cw >> 1);
  const tz0 = cz - (tw >> 1), cz0 = cz - (cw >> 1);
  g.box(t0, 0, tz0, t0 + tw - 1, 2 * r, tz0 + tw - 1, C.vegTrunk);
  const b = Math.max(1, Math.round(r * 0.5));
  g.box(c0, 2 * r, cz0, c0 + cw - 1, 2 * r + b - 1, cz0 + cw - 1, pal.band);
  g.box(c0, 2 * r + b, cz0, c0 + cw - 1, 4 * r + b - 1, cz0 + cw - 1, pal.leaf);
  if (r >= 4) {
    g.set(c0, 3 * r, cz0 + 2, pal.dot);
    g.set(c0 + cw - 1, 3 * r + 1, cz0 + cw - 3, pal.dot);
  }
}

// ---------------------------------------------------------------------------
// treeModel(variant) — 6 shapes (≥5 per contract), any int, deterministic.
// ---------------------------------------------------------------------------
// r12 (critic: "the small twin-cube tree is copied too often in a tight
// grid, so the park looks cloned; ref06 mixes tall single blocks, clustered
// 3-cube crowns and small ones more evenly"): main.js tiles pick
// treeModel(hash % 8) and never rotate them, so the old 6-entry list dealt
// the two-lobe 'round' tree (and the poplar) 2 of every 8 tiles, always
// with its lobe on the same side. Now 8 entries, one per hash bucket:
// tall column, poplar, 3-lobe cluster (both mirrors), round (both mirrors),
// sapling, blossom — every shape at most 2/8, and a twin is mirrored.
const TREE_BY_VARIANT = [
  ['round', false], ['column', false], ['cluster', false], ['sapling', false],
  ['round', true], ['pine', false], ['cluster', true], ['blossom', false],
];

export function treeModel(variant) {
  const n = TREE_BY_VARIANT.length;
  const v = (((variant | 0) % n) + n) % n;
  const [kind, flip] = TREE_BY_VARIANT[v];
  return vegModel(kind, ((variant | 0) >>> 0) % 997, flip);
}

// ---------------------------------------------------------------------------
// Deco catalog pieces (1×1, cap 0) in the ref06 style. Builder signature
// matches the catalog registry: (rng, variant) => model. res 4, 5 x 5 world.
// ---------------------------------------------------------------------------

// ref06 bushes: 0 = cube + little cube, 1 = long bush with a front ledge,
// 2 = tall bush with a little cube at its foot.
export function decoBush(rng, variant) {
  const v = ((((variant | 0) % 3) + 3) % 3);
  const g = grid(20, 16, 20, RES);
  const B = C.vegBush;
  if (v === 0) {
    g.box(2, 0, 2, 14, 11, 14, B);
    g.box(12, 0, 12, 18, 5, 18, B);
  } else if (v === 1) {
    g.box(1, 0, 4, 18, 8, 13, B);
    g.box(1, 0, 14, 10, 3, 17, B);
    g.box(14, 0, 13, 18, 4, 17, B);
  } else {
    g.box(3, 0, 3, 12, 15, 12, B);
    g.box(10, 0, 10, 16, 7, 16, B);
  }
  return g.done();
}

// A kerbed flower bed: light concrete rim, soil, rows of ref06 voxel flowers
// with a cube bush in one corner. Colours shuffle per rng.
export function decoFlowerBed(rng, variant) {
  const R = rng || mulberry32(((variant | 0) >>> 0) + 17);
  const g = grid(20, 10, 20, RES);
  g.box(0, 0, 0, 19, 2, 19, C.lotRim);          // kerb
  g.box(1, 0, 1, 18, 2, 18, C.dirtDark);        // soil, one voxel below the rim
  for (let x = 1; x <= 18; x++) for (let z = 1; z <= 18; z++) g.del(x, 2, z);
  const petals = [C.vegPetalW, C.vegPetalR, C.vegPetalB, C.vegPollen, C.vegPetalW, C.vegBloom];
  const off = Math.floor(R() * petals.length);
  let i = 0;
  for (const z of [4, 9, 14]) for (const x of [4, 9, 14]) {
    if (x === 14 && z === 4) continue;           // the bush's corner
    vegFlower(g, x + ((z / 5) & 1), 2, z, petals[(off + i++) % petals.length], 2);
  }
  g.box(12, 2, 2, 17, 6, 7, C.vegBush);
  return g.done();
}
