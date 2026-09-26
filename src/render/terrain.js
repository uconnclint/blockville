// src/render/terrain.js — AAA ground / mountain meshing for Blockville.
// Implements CONTRACTS-RENDER.md §3.4.
//
// Owns: grass / sand / road-base ground, shore banks, map-border cliffs, the
// sea/lake bed, and MOUNTAIN rock columns.
// Does NOT own: the water surface at y=-0.35 (src/render/water.js) or road
// asphalt + sidewalks (src/render/roads.js). This module emits the ground
// *underneath* roads and the banks *around* water, nothing more.
//
// Everything is procedural: three small tileable RGBA textures are generated at
// runtime (512² / 256² / 128²) and combined in a MeshStandardMaterial shader
// injection. Mip-mapping + a camera-distance fade keep the detail from ever
// aliasing at max zoom-out.
//
// SHADER INJECTION DISCIPLINE (read before touching _makeMaterial):
// every onBeforeCompile replace() must re-emit the `#include <...>` it matched
// and only APPEND after it. Dropping the include silently deletes whatever that
// chunk defined; dropping <lights_fragment_begin> in particular deletes
// getShadow() and the ground stops receiving cast shadows while still looking
// completely fine. selfTest() reads the compiled shader back and asserts the
// shadow path survived — keep that assertion green.
//
// Only dependency: vendored three.js r160 + shared constants.

import * as THREE from '../../vendor/three.module.js';
import { TILE, N, CHUNK } from '../constants.js';

const CHUNKS = Math.ceil(N / CHUNK);

// Tile type ids (mirrors constants.T — kept local so this file reads standalone)
const T_GRASS = 0, T_WATER = 1, T_SAND = 2, T_ROAD = 3;
const T_BLDG = 7, T_TREE = 8, T_MOUNTAIN = 15;

// Surface class ids used for blending.
const C_GRASS = 0, C_SAND = 1, C_DIRT = 2, C_ROCK = 3, C_WATER = 4;

const WATER_Y = -0.35;          // water surface (water.js owns the quad)
const BED_NEAR = -1.15;         // sea/lake bed right at the shore
const BED_FAR = -2.30;          // ... and out in deep water

// Swash slope (see _shoreDip). How far the beach drops as it reaches the
// waterline. It stops 0.03 units ABOVE WATER_Y on purpose: the land must never
// go below the water surface, or any stretch water.js's fringe does not cover
// is a dry trench under the water line. 0.32 is enough to bury the bank's
// vertical face, which is the thing that was drawing the black rim.
const SWASH = 0.32;             // => the beach lip sits at y = -0.32 > WATER_Y

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0, e1, x) => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Deterministic value noise (JS side: textures + mountain silhouette jitter)
// ---------------------------------------------------------------------------

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^
           Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Non-periodic value noise in world space.
function vnoiseW(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed);
  const u = a + (b - a) * sx, w = c + (d - c) * sx;
  return u + (w - u) * sz;
}

// Tileable fbm rendered straight into a size² Float32Array. Each octave builds
// its lattice once (px·pz hashes) and then only does array reads per pixel —
// ~15× faster than hashing per pixel per octave, which matters because this
// runs synchronously at boot.
function fbmField(size, px, pz, oct, seed, gain) {
  gain = gain || 0.5;
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, fx = px, fz = pz;
  for (let o = 0; o < oct; o++) {
    const lat = new Float32Array(fx * fz);
    for (let j = 0; j < fz; j++) {
      for (let i = 0; i < fx; i++) lat[j * fx + i] = hash2(i, j, seed + o * 7919);
    }
    const sx = fx / size, sz = fz / size;
    for (let y = 0; y < size; y++) {
      const gz = y * sz;
      const z0 = Math.floor(gz), tz = gz - z0;
      const wz = tz * tz * (3 - 2 * tz);
      const z0i = (z0 % fz) * fx, z1i = ((z0 + 1) % fz) * fx;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const gx = x * sx;
        const x0 = Math.floor(gx), tx = gx - x0;
        const wx = tx * tx * (3 - 2 * tx);
        const x0i = x0 % fx, x1i = (x0 + 1) % fx;
        const a = lat[z0i + x0i], b = lat[z0i + x1i];
        const c = lat[z1i + x0i], d = lat[z1i + x1i];
        const u = a + (b - a) * wx, v = c + (d - c) * wx;
        out[row + x] += amp * (u + (v - u) * wz);
      }
    }
    norm += amp; amp *= gain; fx *= 2; fz *= 2;
  }
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function encodeNormal(dst, size, height, strength) {
  // Central-difference gradient of `height` (Float32Array size²) into dst.b/.a.
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1) + size) % size, yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = ((x - 1) + size) % size, xp = (x + 1) % size;
      const gx = (height[y * size + xp] - height[y * size + xm]) * 0.5;
      const gz = (height[yp * size + x] - height[ym * size + x]) * 0.5;
      const o = (y * size + x) * 4;
      dst[o + 2] = Math.round(clamp01(0.5 - gx * strength) * 255);
      dst[o + 3] = Math.round(clamp01(0.5 - gz * strength) * 255);
    }
  }
}

function makeTexture(data, size, aniso) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso || 4;
  t.colorSpace = THREE.NoColorSpace;   // data, not colour
  t.needsUpdate = true;
  return t;
}

// R = fine turf, G = mid patchiness, BA = turf normal xz.
function buildDetailTexture(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  // Isotropic fbm + a stretched "blade" layer that gives the turf direction.
  const base = fbmField(size, 16, 16, 4, 1201, 0.55);
  // ISOTROPIC. This used to be fbmField(size, 40, 10, ...) — a deliberate 4:1
  // stretch, sold as "gives the turf direction". On a ground plane it stretches
  // along world Z, and a reviewer measuring the fine residual's autocorrelation
  // found it smeared along one axis and gone along the other. Turf has no grain
  // at this scale; direction is the normal map's job, not the albedo's.
  const blade = fbmField(size, 26, 26, 2, 3307, 0.5);
  const patch = fbmField(size, 5, 5, 3, 5501, 0.55);
  for (let i = 0; i < size * size; i++) {
    const turf = clamp01((base[i] * 0.68 + blade[i] * 0.32 - 0.5) * 1.55 + 0.5);
    h[i] = turf;
    data[i * 4] = (turf * 255) | 0;
    data[i * 4 + 1] = (clamp01((patch[i] - 0.5) * 1.3 + 0.5) * 255) | 0;
  }
  encodeNormal(data, size, h, 9.0);
  return makeTexture(data, size, aniso);
}

// R = rock mottle, G = ridged cracks, BA = rock normal xz.
function buildRockTexture(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const mot = fbmField(size, 10, 10, 4, 8101, 0.55);
  const rid = fbmField(size, 6, 6, 3, 9203, 0.5);
  for (let i = 0; i < size * size; i++) {
    const mottle = clamp01((mot[i] - 0.5) * 1.45 + 0.5);
    // Ridged noise reads as fractures.
    const crack = Math.pow(clamp01(1 - Math.abs(2 * rid[i] - 1)), 2.4);
    h[i] = mottle * 0.62 + (1 - crack) * 0.38;
    data[i * 4] = (mottle * 255) | 0;
    data[i * 4 + 1] = (clamp01(1 - crack) * 255) | 0;
  }
  encodeNormal(data, size, h, 14.0);
  return makeTexture(data, size, aniso);
}

// Four decorrelated low-frequency fields for macro colour variety.
function buildMacroTexture(size, aniso) {
  const data = new Uint8Array(size * size * 4);
  const a = fbmField(size, 3, 3, 3, 211, 0.55);
  const b = fbmField(size, 5, 5, 3, 613, 0.55);
  const c = fbmField(size, 2, 2, 2, 977, 0.5);
  const d = fbmField(size, 8, 8, 3, 1409, 0.55);
  for (let i = 0; i < size * size; i++) {
    data[i * 4]     = (clamp01((a[i] - 0.5) * 1.5 + 0.5) * 255) | 0;
    data[i * 4 + 1] = (clamp01((b[i] - 0.5) * 1.4 + 0.5) * 255) | 0;
    data[i * 4 + 2] = (clamp01((c[i] - 0.5) * 1.6 + 0.5) * 255) | 0;
    data[i * 4 + 3] = (d[i] * 255) | 0;
  }
  return makeTexture(data, size, aniso);
}

// ---------------------------------------------------------------------------
// Palette (sRGB hexes -> linear via THREE.Color)
// ---------------------------------------------------------------------------

// Grass hues are deliberately in the 75-110 deg band.
//
// These are ALBEDOS, and the number that matters is what lands on screen after
// this scene's very blue hemisphere fill + IBL + the post grade. Measured on
// the reference city at the hero pose (96^2 backing-pixel patches, 5 of them):
//
//   original astroturf ....... sat 0.88  hue 113  blue/green 0.12
//   first pass (over-bounced)  sat 0.36  hue 115  blue/green 0.64   <- too drab
//   now ...................... sat 0.53  hue 96   blue/green 0.47
//
// Note that for any green foliage blue is the darkest channel, so HSV
// saturation and the blue/green ratio are not independent: sat == 1 - (b/g)
// exactly. "sat 0.5-0.65" therefore REQUIRES blue/green 0.35-0.50; a
// blue/green of 0.20 would put saturation back at 0.80, i.e. astroturf. The
// saturation target wins and the ratio follows from it.
const PAL = {
  // Stylised palette (ART-DIRECTION.md). Albedos are chosen so the lit TOP
  // face lands on the reference's lime lawn (~#9fcb45-#b3d65a on screen) after
  // this scene's key + fill + ACES + grade.
  grassDeep: 0x6fa83a,   // (legacy uniform; unused by the stylised shader)
  // r9 (critic r8: "a flat sage/khaki green … push toward lime"; r6 said "too
  // saturated and yellow" at screen #a8c85c): aim between, screen ~#a6c266.
  // r7's 0x8d9677 had drifted to #aec678 under today's brighter light.
  // r12 (critic r11: "slightly more saturated and bluer-green than the
  // reference's paler yellow-lime, about #a8c86a"): screen was #acd06c,
  // ref05's field modal is #a4bc70 — green pulled down ~6%, a touch warmer.
  // coherence (09-25): the light/post retunes after r12 had drifted this albedo
  // to a washed #c4dc8b on screen — paler than every lot lawn, hedge and tree
  // canopy around it (two-greens clash). Re-solved so the field lands back on
  // ~#b0d26a, the same family as models' C.lotGrass (re-solved together).
  grassMid:  0x718445,
  grassLit:  0x758546,   // the lawn's warm end of the (very slow) tonal drift
  grassRich: 0x7db83c,   // (legacy)
  grassDry:  0xa8c450,   // (legacy)
  worn:      0x9b8566,   // (legacy)
  pebble:    0x9d968a,   // (legacy)
  seaFar:    0x2d97df,   // off-map open water, pool blue like water.js
  sand:      0xf0d998,   // clean warm beach sand
  sandWet:   0xdcc084,   // damp band at the waterline (subtle)
  dirt:      0x9a7654,   // soil: map-border cliff faces, lake bed
  rockA:     0x808286,   // light rock block (r14: 0x9d9ea0 landed ~#d0d9ce on screen, paler than the lawn; ref06 rock tops sit ~0.8x grass value)
  rockB:     0x707275,   // darker rock block (r14: was 0x8b8c8e)
  rockC:     0xc4986a,   // (legacy)
  scree:     0xb3a794,   // (legacy)
  snow:      0xeef3f8,
};

// Lot paint (sRGB). ART-DIRECTION.md: every building model brings its OWN
// lotPlinth (light rim, darker side band, dressed top). Terrain contributes two
// things only:
//   * a FOOTING under each building — a plain lotSide-coloured block LOT_Y
//     tall, so the model's plinth side band reads as one taller, clearer band
//     (the r1 critic: "thin grey slivers that barely rise off the grass");
//   * VACANT LOTS — empty grass tiles inside a road-enclosed city block get a
//     plinth of their own at the same height as a building's, dressed as a
//     pocket park / plaza / parking / garden / playground. ref05 has no bare
//     lawn inside a block; every tile is a lot.
const LOT_PAL = {
  rim:      0xefebe1,   // light concrete kerb (ref05 plinth rim)
  side:     0xa9a59a,   // == models/core.js C.lotSide, so footing + model read as one band
  seam:     0x8e8a80,   // footing top seen in the joint between two building lots
  lawn:     0x80976a,   // lot lawn. r9 (critic r8: park lots "mix two greens that clash"): less saturated, so it sits in the field's family
  paving:   0xd6c9a9,   // warm plaza paving — must read apart from the rim
  paveDark: 0xc0b192,
  asphalt:  0x3a3d44,   // lot parking: a step lighter than the street, so a car park reads as a LOT
  dirtPath: 0xc9a476,
  cropDark: 0x3f8f2e,
  wheat:    0xe9c552,
  pumpkin:  0xf08a2c,
  cabbage:  0x92c252,
  barn:     0xc8423a,
  crate:    0xc79257,
  yard:     0xd2b183,   // packed-dirt works yard
  barrel:   0x6d7480,
  court:    0x4a8a66,
  courtIn:  0x5a9a76,
  pitch:    0x72965a,
  cobble:   0xa9a7a2,   // market square cobbles (grid lines are 'line')
  line:     0xf2f2ea,
  hedge:    0x4f8d33,
  hedgeTop: 0x5f9f3b,
  canopy:   0x9cc93e,
  canopyLo: 0x7aa932,
  trunk:    0x7a5234,
  soil:     0x7d5436,
  crop:     0x62a23e,
  sand:     0xecd59a,
  water:    0x2ea3ee,
  wood:     0xa0703f,
  red:      0xe0483c,
  white:    0xf4f1e8,
  yellow:   0xf3c63a,
  blue:     0x3f86dc,
  pink:     0xf08cb4,
  teal:     0x2fb3a8,
  orange:   0xf08a2c,
  glass:    0x2d4660,
  // outskirts parcels (ground r4)
  lawnLo:   0x738f50,   // mowing stripe / orchard lane
  hay:      0xe8c65a,
  hayEnd:   0xd4ab3e,
  silo:     0xc9d0d6,
  wool:     0xf3f0e6,
  muzzle:   0x3a3434,
  tractor:  0xd8452f,
  tyre:     0x2a2b2e,
  fruit:    0xe8452e,
  lily:     0x5fae3a,
  straw:    0xd9c27a,   // farmstead paddock (ground r5)
  // ground r7 (critic r6: "pale-cream slabs with thin rims … fill the lots
  // with patterned or zoned paving plus hedge borders, strengthen the rim and
  // side band"). ref05's vacant-style blocks: grey concrete kerb, darker grey
  // side, terracotta dirt round the monument, grey tile walks, hedge rows.
  curb:     0xdddbd3,   // lot rim: light grey concrete (was cream 'rim')
  curbSide: 0x86847f,   // lot side band under the rim: clearly darker grey
  terra:    0xd0b08a,   // packed terracotta dirt (ref05 monument / camp paths)
  terraLo:  0xbf9d78,
  tileA:    0xb4b2ab,   // grey tile walk
  tileB:    0xa3a19b,   // its darker tile / joint band
  deckA:    0xe2cfa6,   // lido deck, two warm tones in bands
  deckB:    0xd3bd91,
  stone:    0xb9b8b3,   // statue / monument stone
  hedgeHi:  0x6caf3d,   // hedge cube highlights
  lawnHi:   0x859e66,   // lot lawn bed (a touch brighter than 'lawn')
  // ground r8 (critic r7: "our ground looks like one tile repeated … in ref05
  // each lot's ground differs: tan dirt, sandy paving, grey concrete, dark
  // grass verges edged with hedges"). One dominant ground per design family.
  camp:     0xd6b889,   // camper park: light tan packed dirt (ref05 trailer park)
  campPad:  0x86a553,   // its grass pitch pads
  depot:    0x7b848e,   // truck depot: mid grey concrete (ref05 warehouse yard)
  depotLn:  0xe8e8e2,
  sandPave: 0xe3cfa0,   // garden plaza: sandy paving (ref05 tower lot)
  sandEdge: 0xcdb68a,
  sandPave2: 0xcdb685,  // r9: its second paving tone
  lawnDk:   0x5a8636,   // dark grass verge bed
  van:      0xf3f1ea,
  vanRoof:  0xc9cdd2,
  rock:     0xb2b3b4,
  rockDk:   0x8d8e90,
  // ground r11 (critic r10: "every lot top is a big flat single-colour slab …
  // in ref05 the ground itself carries the detail: cobbled paving, dirt yards,
  // planter beds along the rims"). Sub-zone grounds.
  cobJoint: 0x878b92,   // market cobble joints (ref05 market: mid grey setts)
  cobA:     0xa8acb2,
  cobB:     0x989ca3,
  cobC:     0xbcbfc4,
  walk:     0xf0eee7,   // light cream walkway bands between the market beds
  terraTile: 0xc4764c,  // café terrace terracotta tiles
  terraTile2: 0xa9613f,
  track:    0xc9674a,   // running track round a pitch
  pitchLt:  0x7ca062,   // mowing stripe
  gravel:   0xb9b3a4,   // camper-park gravel lanes
  dirtDk:   0xb89a70,   // worn dirt patch
  flowerBed: 0x8c6444,
  // ground r13 (critic r12: "pool lots, pitch, park squares … mostly flat
  // plain green or grey … ref05 fills every lot edge to edge: warm tan and
  // light grey paving tiles, planters, parked cars and props").
  waterLt:  0x5cc3f5,   // pool mosaic: lighter tile over the pool blue
  depot2:   0x87909a,   // depot concrete: second slab tone
  depotJt:  0x6a727b,   // slab joints
  seatA:    0x2f7fd0,   // stadium seats
  seatB:    0xe0483c,
  roofGrey: 0xc9ccd0,
  pallet:   0xb88a55,
};

// Height of the building FOOTING — THE height buildings stand on (engine.js
// lifts every building mesh by this). A model's own lotPlinth is 2 voxels at
// res 4 = 0.5 units, so a building lot's top is LOT_TOP; vacant lots match it.
export const LOT_Y = 0.42;
export const LOT_TOP = LOT_Y + 0.5;
const LOT_RIM_H = 0.25;      // light band at the top of a vacant lot's side (== 1 model voxel)
const LOT_KERB_H = 0.12;     // r7: the rim ring stands this proud of the lot top — a crisp kerb edge with an AO line inside
const LOT_RIM_W = 0.8;       // vacant / parcel lot rim width in world units (TILE = 8); r5: wider, ref05 rims read bold
// Verge kerb on open land beside a road: flush with roads.js's sidewalk top
// (yOffset 0.02 + CURB_H 0.35), so road sidewalk + this band read as one rim.
const KERB_Y = 0.37;
const KERB_W = 0.7;
// Round 10 (roads piece): roads.js now draws a real sidewalk on every
// grass-facing road side (SW_G, lit top + dark outer face). This verge band laid
// flush beside it doubled the pale strip to 1.7 units -- the r9 roads critic:
// "too wide, flat and washed-out beige ... no crisp kerb step". Off; the
// _verge bits / lot keys stay so the chunk still rebuilds when a road changes.
const VERGE_KERB = false;

// Vacant-lot design tables: [design id, weight] per neighbourhood (the
// majority catalog category of the buildings around the rect). Singles are
// one tile; multi covers 2x1 / 1x2 / 2x2 rects. See _vacantRect for ids:
//   0 pocket park  1 plaza  2 parking  3 garden beds  4 playground  5 pool
//   6 crop rows    7 works yard  8 court
//   10 car park   11 market square  12 allotments + shed  13 town park  14 sports
const LOT_SINGLE = {
  downtown:  [[1, 3], [2, 3], [0, 2], [8, 1], [3, 1]],
  shops:     [[2, 3], [1, 3], [3, 1], [0, 1], [5, 1]],
  homes:     [[3, 2], [6, 2], [4, 2], [5, 1], [0, 2], [7, 1]],
  fun:       [[4, 2], [0, 2], [8, 2], [1, 1]],
  factories: [[7, 3], [2, 2]],
  none:      [[0, 2], [3, 1], [2, 1], [1, 1], [6, 1]],
};
const LOT_MULTI = {
  downtown:  [[13, 2], [10, 2], [11, 2], [19, 3], [14, 1]],
  shops:     [[10, 2], [11, 2], [19, 2], [13, 1], [18, 1]],
  homes:     [[12, 2], [13, 2], [17, 2], [14, 1], [11, 1], [19, 1]],
  fun:       [[13, 2], [14, 2], [17, 1], [19, 1]],
  factories: [[18, 3], [10, 2]],           // industry r5: paved truck yards, never crop rows
  none:      [[13, 2], [12, 1], [10, 1], [11, 1], [17, 1], [19, 1]],
};

// Whole-block lots (r6: an empty block is ONE plinth, w*d > 4 tiles). ref05's
// block tops: car parks with white bays, a market, a lido, a paved civic
// plaza with planters, a park with hedges, a pitch, allotments.
//   15 lido  16 civic plaza
// r8 (critic r7: "our ground looks like one tile repeated"): three new
// ground families from ref05 — 17 camper park (tan dirt), 18 truck depot
// (grey concrete), 19 garden plaza (sandy paving + dark grass hedged beds).
const LOT_BIG = {
  downtown:  [[10, 2], [16, 2], [19, 3], [13, 1], [11, 1], [18, 1], [15, 1]],
  shops:     [[10, 2], [11, 1], [19, 2], [18, 2], [16, 1], [13, 1], [15, 1]],
  homes:     [[13, 2], [17, 3], [16, 1], [12, 1], [14, 1], [19, 1], [11, 1], [15, 1], [10, 1]],
  fun:       [[13, 2], [14, 2], [17, 2], [16, 1], [15, 1], [19, 1]],
  factories: [[18, 4], [10, 2]],           // industry r5: truck depots / car parks only
  none:      [[13, 2], [10, 2], [17, 2], [18, 2], [19, 2], [12, 1], [16, 1], [14, 1], [11, 1], [15, 1]],
};
// Designs that read as the same ground at a glance (for the no-repeat rule).
const LOT_FAMILY = { 2: 10, 10: 10, 6: 12, 12: 12, 20: 12 };
const LONG_LOT_DESIGNS = new Set([10, 13, 17, 18, 19]);   // r12: designs that tile along a 7x3 lot
const lotFam = (d) => LOT_FAMILY[d] != null ? LOT_FAMILY[d] : d;

// Mountain level -> world units. The sim's heights are 2..16 LEVELS on 8-unit
// tiles; at 1 unit per level a range read as a flat grey quarry from the iso
// camera. Two units per level makes every step a real wall (ref06 rock look).
const MTN_VS = 4.0;
const MTN_PEAK_K = 1.3;      // r8: summit up to 2.3x its linear height ...
const MTN_PEAK_MAX = 96;     // ... but never above this many world units
const MTN_SUB = 2.0;         // wave-2: half-tile cells snap to 2-unit terraces
const MTN_APRON = 10;        // wave-2: tiles of off-map apron a border range steps down over
// Mountain stone strata (sRGB). Two bands per zone alternate every MTN_SUB
// units up a riser. Values are pre-lighting albedos: under this scene's sun a
// 0x6e6a64 top lands ~#aaa6a0 on screen (ref06 rock tops ~0.8x grass value).
const STONE_HEX = {
  earth: [0x756857, 0x6f6352],   // warm earthy stone at the foot (ties to the lime field)
  warm:  [0x686460, 0x63605b],   // warm grey mid-slopes
  cool:  [0x62666f, 0x5d616a],   // cool blue-grey under the snow
  turf:  [0x6f8c3c, 0x6f8c3c],   // grass lip down a terrace riser
};

const LK_FOOT = 1, LK_VACANT = 2, LK_PARCEL = 3;   // PARCEL: a raised outskirts lot (parcelPlan)
const LK_GREEN = 4;          // a GREEN outskirts lot: park / pitch / orchard drawn flush on the field
                             // (r10: no longer produced — green parcels are raised like every lot)
const LK_LAWN = 5;           // r10: open lawn the town has closed in on, raised to LOT_TOP (lawnMask)
const GREEN_Y = 0.03;        // ground level for a green lot's paths and props

function lin(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }
const LOT_RGB = {};
for (const k in LOT_PAL) { const c = lin(LOT_PAL[k]); LOT_RGB[k] = [c.r, c.g, c.b, 1]; }
const STONE = {};
for (const k in STONE_HEX) STONE[k] = STONE_HEX[k].map((hx) => { const c = lin(hx); return [c.r, c.g, c.b, 1]; });

/**
 * City-block mask (pure; shared with props.js). 1 on every EMPTY grass tile of
 * a small land region that roads close in on — i.e. the unbuilt tiles of a
 * city block. Regions touching the map border, bigger than 40 tiles, or bounded
 * mostly by water/rock (a strip of coast) are open country and stay meadow.
 */
export function cityBlockMask(state, out) {
  const nn = N * N;
  const mask = out || new Uint8Array(nn);
  mask.fill(0);
  const map = state && state.map;
  if (!map || map.length < nn) return mask;
  const occ = state.occ, bridge = state.bridge, level = state.level;
  const land = (i) => {
    const m = map[i];
    return m !== T_ROAD && m !== T_WATER && m !== T_MOUNTAIN && !(bridge && bridge[i] === 1);
  };
  const seen = new Uint8Array(nn);
  const stack = [], cells = [];
  for (let s = 0; s < nn; s++) {
    if (seen[s] || !land(s)) continue;
    stack.length = 0; cells.length = 0;
    stack.push(s); seen[s] = 1;
    let border = false, roadE = 0, otherE = 0;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const x = i % N, z = (i / N) | 0;
      if (x === 0 || z === 0 || x === N - 1 || z === N - 1) border = true;
      const nb = [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, z > 0 ? i - N : -1, z < N - 1 ? i + N : -1];
      for (const j of nb) {
        if (j < 0) continue;
        if (land(j)) { if (!seen[j]) { seen[j] = 1; stack.push(j); } }
        else if (map[j] === T_ROAD) roadE++;
        else otherE++;
      }
    }
    if (border || cells.length > 40 || roadE < 0.7 * (roadE + otherE)) continue;
    for (const i of cells) {
      if (map[i] !== T_GRASS) continue;
      if (occ && occ[i] !== 0) continue;
      if (level && level[i] !== 0) continue;
      mask[i] = 1;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Outskirts PARCELS (ground r4, reworked r5). The open land within PARCEL_RING
// tiles of any road is laid out on the road grid's own lattice (pitch 4, phase
// taken from the avenues), and each 3x3 cell between the extended avenue lines
// gets ONE of three fates:
//   * RAISED lot — a crisp plinth with a light concrete rim, a visible side
//     band and a BUSY non-grass top: farm field, farmstead yard, allotments,
//     car park, market. Neighbouring raised cells often merge across the
//     lattice line into one big 7x3 lot (ref05's farm and market slabs).
//   * GREEN lot — a park, pitch, orchard or pond laid FLUSH on the field
//     grass: no plinth, no rim, no lawn infill; only its paths, trees,
//     fountain and lines. The field grass flows straight through it.
//   * MEADOW — plain open field with a sparse even sprinkle of trees, rocks
//     and bushes (props.js).
// The r4 critic: "the open ground … is cut into a grid of thin pale-beige rim
// lines and grass-on-grass plinths … ref05 does the opposite: large unbroken
// flat grass fields with a few lots, each one a crisp raised slab with a bright
// concrete rim, a visible side band and a densely paved top full of props."
// The lattice line beside a raised lot is its tree row (mask 2); every other
// lattice tile is meadow. The coast, mountains, sim forest and the map edge
// are left natural. Pure function of state; shared with props.js.
//   mask: 0 none, 1 raised lot, 2 tree-row strip, 3 green (flush) lot, 4 meadow
// ---------------------------------------------------------------------------
const PARCEL_RING = 11;      // tiles (Chebyshev) from the nearest road
const PARCEL_COAST = 2;      // keep this many tiles of natural ground at water / sand / rock
const PARCEL_PITCH = 4;
// Design ids >= 20 are the rural designs in _vacantRect:
//   20 farm field  21 orchard  22 farmstead  23 pond meadow
// RAISED tops are never grass; GREEN designs are drawn flush on the field.
const PARCEL_RAISED = {
  // r8: + 17 camper park (tan dirt) and 18 truck depot (grey concrete)
  edge:   [[10, 2], [20, 3], [11, 1], [22, 2], [12, 1], [17, 3], [18, 2]],
  fringe: [[20, 4], [22, 3], [12, 2], [17, 3], [10, 1]],
  rural:  [[20, 5], [22, 3], [12, 1], [17, 1]],
  small:  [[12, 3], [20, 3], [10, 1]],
  // merged 7x3 slabs: a car park that size reads as a stray road
  big:    [[20, 4], [22, 3], [12, 2], [17, 3], [18, 2]],
  bigRural: [[20, 5], [22, 3], [12, 1], [17, 2]],
};
const PARCEL_GREEN = {
  edge:   [[13, 3], [14, 3], [23, 2], [21, 1]],
  fringe: [[21, 3], [23, 2], [13, 1], [14, 1]],
  rural:  [[21, 3], [23, 2], [14, 1]],
  small:  [[21, 1]],
};
// Share of full cells that become [raised, green] lots, by distance to road
// (the rest stay meadow).
// r12 (critic r11: "no open terrain … wide stretches of flat, pale lime grass
// between blocks … leave some unbuilt grass tiles (no plinths)"): the open
// belt is mostly MEADOW now — a lot here and there, not a lot per cell.
const PARCEL_FATE = { edge: [0.20, 0.07], fringe: [0.10, 0.04], rural: [0.05, 0.02] };
const GREEN_DESIGNS = new Set([13, 14, 21, 23]);

function chebDist(isSeed, out) {
  const nn = N * N, BIG = 1e4;
  const d = out || new Float32Array(nn);
  for (let i = 0; i < nn; i++) d[i] = isSeed(i) ? 0 : BIG;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x; let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (z > 0) { v = Math.min(v, d[i - N] + 1); if (x > 0) v = Math.min(v, d[i - N - 1] + 1); if (x < N - 1) v = Math.min(v, d[i - N + 1] + 1); }
      d[i] = v;
    }
  }
  for (let z = N - 1; z >= 0; z--) {
    for (let x = N - 1; x >= 0; x--) {
      const i = z * N + x; let v = d[i];
      if (x < N - 1) v = Math.min(v, d[i + 1] + 1);
      if (z < N - 1) { v = Math.min(v, d[i + N] + 1); if (x < N - 1) v = Math.min(v, d[i + N + 1] + 1); if (x > 0) v = Math.min(v, d[i + N - 1] + 1); }
      d[i] = v;
    }
  }
  return d;
}

// Height of the off-map skirt beside a LAND border at world (wx, wz) — the
// near-field part of Terrain._skirtY (r8), shared with props.js so the
// off-map countryside scatter stands on it. Valid out to ~250 units.
const SKIRT_DROP = -3.2;
export function skirtLandY(wx, wz) {
  const W = N * TILE;
  const dx = Math.max(0, -wx, wx - W), dz = Math.max(0, -wz, wz - W);
  const d = Math.sqrt(dx * dx + dz * dz);
  return SKIRT_DROP * sstep(60, 200, d) - d * 0.0015;
}

export function parcelPlan(state, block) {
  const nn = N * N;
  const mask = new Uint8Array(nn);
  const rects = [];
  const plan = { mask, rects, px: 0, pz: 0 };
  const map = state && state.map;
  if (!map || map.length < nn) return plan;
  let roads = 0;
  for (let i = 0; i < nn; i++) if (map[i] === T_ROAD) roads++;
  if (!roads) return plan;
  // The belt grows with the town: a first street gets a few lots around it,
  // a full grid gets the whole PARCEL_RING.
  const ring = Math.min(PARCEL_RING, 3 + Math.floor(roads / 12));
  block = block || cityBlockMask(state);
  const occ = state.occ, bridge = state.bridge, level = state.level;
  const seed = (state.seed >>> 0) || 1;
  const dR = chebDist((i) => map[i] === T_ROAD);
  const dC = chebDist((i) => map[i] === T_WATER || map[i] === T_SAND || map[i] === T_MOUNTAIN ||
    !!(bridge && bridge[i] === 1));
  // Lattice phase from the avenues: a road tile with road on both sides along
  // z is part of a north-south avenue at x; tally x mod 4 (and z likewise).
  const tx = [0, 0, 0, 0], tz = [0, 0, 0, 0];
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const i = z * N + x;
      if (map[i] !== T_ROAD) continue;
      if (map[i - N] === T_ROAD && map[i + N] === T_ROAD) tx[x & 3]++;
      if (map[i - 1] === T_ROAD && map[i + 1] === T_ROAD) tz[z & 3]++;
    }
  }
  let px = 0, pz = 0;
  for (let k = 1; k < 4; k++) { if (tx[k] > tx[px]) px = k; if (tz[k] > tz[pz]) pz = k; }
  plan.px = px; plan.pz = pz;
  const ok = new Uint8Array(nn), lat = new Uint8Array(nn);
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const i = z * N + x;
      if (map[i] !== T_GRASS || block[i]) continue;
      if (occ && occ[i] !== 0) continue;
      if (level && level[i] !== 0) continue;
      if (dR[i] > ring) continue;
      // r8 (critic r7: "the green between the beach and the blocks is bare
      // flat lime"): the coastal strip stays natural (no lots) but is open
      // MEADOW, so props.js gives it ref05's tree / rock sprinkle.
      if (dC[i] <= PARCEL_COAST) { mask[i] = 4; continue; }
      ok[i] = 1;
      if ((x & 3) === px || (z & 3) === pz) lat[i] = 1;
    }
  }
  const okAt = (x, z) => x >= 0 && z >= 0 && x < N && z < N && ok[z * N + x] === 1 && !lat[z * N + x];
  const okLat = (x, z) => x >= 0 && z >= 0 && x < N && z < N && ok[z * N + x] === 1;
  const isRoad = (x, z) => x >= 0 && z >= 0 && x < N && z < N && map[z * N + x] === T_ROAD;
  const zoneOf = (minR) => minR <= 1 ? 'edge' : minR <= 5 ? 'fringe' : 'rural';
  const P = PARCEL_PITCH, CW = P - 1;
  const addRect = (x, z, w, d, green, small) => {
    let minR = 1e4;
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) {
      mask[zz * N + xx] = green ? 3 : 1; minR = Math.min(minR, dR[zz * N + xx]);
    }
    // Street side: the side with the most road; else the side facing the
    // nearest road (down the distance gradient); else a hash.
    let nN = 0, nS = 0, nW = 0, nE = 0;
    for (let k = 0; k < w; k++) { nN += isRoad(x + k, z - 1); nS += isRoad(x + k, z + d); }
    for (let k = 0; k < d; k++) { nW += isRoad(x - 1, z + k); nE += isRoad(x + w, z + k); }
    const hs = hash2(x, z, seed ^ 0x61c3);
    let rot = ((hs * 4096) | 0) & 3, best = 0;
    for (const [n, rr] of [[nN, 0], [nE, 1], [nS, 2], [nW, 3]]) if (n > best) { best = n; rot = rr; }
    if (!best) {
      const cx = Math.min(N - 1, x + (w >> 1)), cz = Math.min(N - 1, z + (d >> 1));
      const s = (xx, zz) => (xx < 0 || zz < 0 || xx >= N || zz >= N) ? 1e4 : dR[zz * N + xx];
      const cands = [[s(cx, z - 2), 0], [s(x + w + 1, cz), 1], [s(cx, z + d + 1), 2], [s(x - 2, cz), 3]];
      let lo = 1e4;
      for (const [v, rr] of cands) if (v < lo) { lo = v; rot = rr; }
    }
    const zone = small ? 'small' : (!green && w * d > 9) ? (minR <= 1 ? 'big' : 'bigRural') : zoneOf(minR);
    const table = (green ? PARCEL_GREEN : PARCEL_RAISED)[zone];
    let tot = 0;
    for (const e of table) tot += e[1];
    const hd = hash2(x * 3 + 7, z * 5 + 11, seed ^ 0x2f17);
    let acc = 0, di = 0;
    for (let k = 0; k < table.length; k++) { acc += table[k][1]; if (hd * tot < acc) { di = k; break; } }
    // No nearby parcels of the same design family (reads as tiling). r8:
    // look 4 tiles out (was 1), so the next lot but one differs too.
    for (const RR of [4, 1]) {
      const nbD = new Set();
      for (const q of rects) {
        if (q.x <= x + w + RR && x <= q.x + q.w + RR && q.z <= z + d + RR && z <= q.z + q.d + RR) nbD.add(lotFam(q.design));
      }
      let k = 0;
      for (; k < table.length && nbD.has(lotFam(table[di][0])); k++) di = (di + 1) % table.length;
      if (k < table.length) break;
    }
    rects.push({
      x, z, w, d, rot, design: table[di][0], flush: 0, green: green ? 1 : 0,   // r10: green parcels are raised like every lot
      h: (hash2(x, z, seed ^ 0x5bd1) * 4294967296) >>> 0, parcel: 1,
    });
  };
  // Pass 1: a fate per lattice cell.
  const cells = new Map();
  const cellKey = (x0, z0) => (z0 + P) * 1024 + (x0 + P);
  for (let z0 = ((pz + 1) % P) - P; z0 < N; z0 += P) {
    for (let x0 = ((px + 1) % P) - P; x0 < N; x0 += P) {
      let n = 0, minR = 1e4;
      for (let dz = 0; dz < CW; dz++) for (let dx = 0; dx < CW; dx++) {
        if (okAt(x0 + dx, z0 + dz)) { n++; minR = Math.min(minR, dR[(z0 + dz) * N + x0 + dx]); }
      }
      if (!n) continue;
      const hc = hash2(x0, z0, seed ^ 0x1d2b);
      if (n === CW * CW) {
        const f = PARCEL_FATE[zoneOf(minR)];
        const fate = hc < f[0] ? 1 : hc < f[0] + f[1] ? 3 : 0;
        cells.set(cellKey(x0, z0), { x0, z0, full: 1, fate, done: 0 });
        continue;
      }
      // Partial cell (forest / coast / building nearby): its largest clean
      // rect may become a small raised lot or an orchard; mostly meadow.
      let bA = 0, bR = null;
      for (let z = 0; z < CW; z++) for (let x = 0; x < CW; x++) {
        for (let d = 1; z + d <= CW; d++) for (let w = 1; x + w <= CW; w++) {
          if (w * d <= bA) continue;
          let all = true;
          for (let zz = 0; zz < d && all; zz++) for (let xx = 0; xx < w; xx++) {
            if (!okAt(x0 + x + xx, z0 + z + zz)) { all = false; break; }
          }
          if (all) { bA = w * d; bR = [x0 + x, z0 + z, w, d]; }
        }
      }
      if (bR && bA >= 4 && hc < 0.40) addRect(bR[0], bR[1], bR[2], bR[3], hc > 0.30, true);
    }
  }
  // Pass 2: neighbouring raised cells merge across the lattice line into one
  // big slab (7x3 or 3x7) about half the time — ref05's farm and market lots
  // are big, and every merge is one rim line fewer.
  const span = (x, z, w, d) => {
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (!okLat(xx, zz)) return false;
    return true;
  };
  for (const c of cells.values()) {
    if (c.done || c.fate !== 1) continue;
    c.done = 1;
    const hm = hash2(c.x0 * 5 + 3, c.z0 * 7 + 1, seed ^ 0x4a7f);
    const e = cells.get(cellKey(c.x0 + P, c.z0)), s = cells.get(cellKey(c.x0, c.z0 + P));
    if (hm < 0.55 && e && !e.done && e.fate === 1 && span(c.x0, c.z0, 2 * CW + 1, CW)) {
      e.done = 1; addRect(c.x0, c.z0, 2 * CW + 1, CW, false, false);
    } else if (hm < 0.55 && s && !s.done && s.fate === 1 && span(c.x0, c.z0, CW, 2 * CW + 1)) {
      s.done = 1; addRect(c.x0, c.z0, CW, 2 * CW + 1, false, false);
    } else addRect(c.x0, c.z0, CW, CW, false, false);
  }
  for (const c of cells.values()) if (c.fate === 3) addRect(c.x0, c.z0, CW, CW, true, false);
  // Pass 3: the lattice line beside a raised lot is its tree row; every other
  // clean open tile is meadow.
  const raisedAt = (x, z) => x >= 0 && z >= 0 && x < N && z < N && mask[z * N + x] === 1;
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const i = z * N + x;
      if (!ok[i] || mask[i]) continue;
      mask[i] = (lat[i] && (raisedAt(x - 1, z) || raisedAt(x + 1, z) || raisedAt(x, z - 1) || raisedAt(x, z + 1))) ? 2 : 4;
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// LAWN PLINTHS (ground r10). The r9 critic: "the park and grass lots … sit
// almost level with the asphalt … only a thin grey kerb line and no visible
// raised plinth side band … in ref05 every lot is a chunky slab with a light
// rim and a clear side face, and the lime grass on top stays evenly bright".
// Open grass that the town has closed in on — a pocket of lawn between roads
// and the beach, a half-built block, the green between two streets — is raised
// to the same height as a building lot (LOT_TOP) and rimmed exactly like one,
// with the FIELD grass itself on top (no painted lot green, so it can never
// clash with the meadow). Open country (anything that reaches the map border,
// or a big region) stays at ground level.
// A region is a 4-connected run of open lawn: GRASS or sim TREE tiles that
// carry no building (a 1x1 deco item stands on the lawn), are not a city-block
// vacant lot and not a raised / green outskirts parcel. Pure function of
// state; shared with props.js (its scatter stands on the lawn top).
// ---------------------------------------------------------------------------
const LAWN_MAX = 30;         // tiles: bigger open regions are open field, not a lot (r12: was 90)
const LAWN_ROAD_MIN = 0.2;   // share of the region's boundary that must be road

export function lawnMask(state, block, pmask, out) {
  const nn = N * N;
  const mask = out || new Uint8Array(nn);
  mask.fill(0);
  const map = state && state.map;
  if (!map || map.length < nn) return mask;
  const occ = state.occ, bridge = state.bridge;
  const deco = new Set();
  const bs = state.buildings;
  if (Array.isArray(bs)) for (const b of bs) if (b && b.cat === 'deco') deco.add(b.bid);
  const cand = (i) => {
    const m = map[i];
    if (m !== T_GRASS && m !== T_TREE) return false;
    if (bridge && bridge[i] === 1) return false;
    if (block && block[i]) return false;
    if (pmask && (pmask[i] === 1 || pmask[i] === 3)) return false;
    if (occ && occ[i] !== 0 && !deco.has(occ[i])) return false;
    return true;
  };
  const seen = new Uint8Array(nn);
  const stack = [], cells = [];
  for (let s = 0; s < nn; s++) {
    if (seen[s] || !cand(s)) continue;
    stack.length = 0; cells.length = 0;
    stack.push(s); seen[s] = 1;
    let border = false, roadE = 0, allE = 0;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const x = i % N, z = (i / N) | 0;
      if (x === 0 || z === 0 || x === N - 1 || z === N - 1) border = true;
      const nb = [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, z > 0 ? i - N : -1, z < N - 1 ? i + N : -1];
      for (const j of nb) {
        if (j < 0) continue;
        if (cand(j)) { if (!seen[j]) { seen[j] = 1; stack.push(j); } continue; }
        allE++;
        if (map[j] === T_ROAD) roadE++;
      }
    }
    if (border || cells.length > LAWN_MAX || roadE < LAWN_ROAD_MIN * allE || roadE < 2) continue;
    for (const i of cells) mask[i] = 1;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// r11 LAWN PARK plan (pure; shared with props.js). Critic r10: "the park lots
// by the beach are plain lime grass with trees and rocks spaced evenly, like a
// grid … break each lot top into sub-zones (paths, dirt patches, planter
// borders, clumped tree groves instead of even spacing)". Each lawn region
// gets a footpath network (tile-centre to tile-centre, from a hub near its
// middle out to up to three street entrances), a small paved hub, and every
// other tile a zone: GROVE (a tight clump of trees), CLEARING (open lawn with
// a rock group) or FLOWERS (planted beds).
//   path[i]: bits 1 = to z-1, 2 = to z+1, 4 = to x-1, 8 = to x+1
//   zone[i]: 0 none, 1 grove, 2 clearing, 3 flowers, 4 hub, 5 picnic (dirt patch + table)
// ---------------------------------------------------------------------------
export const LZ_GROVE = 1, LZ_CLEAR = 2, LZ_FLOWER = 3, LZ_HUB = 4, LZ_PICNIC = 5;
export function lawnPark(state, lawn) {
  const nn = N * N;
  const path = new Uint8Array(nn), zone = new Uint8Array(nn);
  const map = state && state.map;
  if (!map || !lawn) return { path, zone };
  const occ = state.occ;
  const seed = (state.seed >>> 0) || 1;
  const plain = (i) => map[i] === T_GRASS && !(occ && occ[i]);
  const seen = new Uint8Array(nn);
  const dist = new Int32Array(nn), par = new Int32Array(nn);
  const stack = [];
  for (let s = 0; s < nn; s++) {
    if (!lawn[s] || seen[s]) continue;
    const cells = [];
    stack.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); cells.push(i);
      const x = i % N, z = (i / N) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, z > 0 ? i - N : -1, z < N - 1 ? i + N : -1]) {
        if (j >= 0 && lawn[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    // hub: the plain tile nearest the region's centroid
    let sx = 0, sz = 0;
    for (const i of cells) { sx += i % N; sz += (i / N) | 0; }
    sx /= cells.length; sz /= cells.length;
    let hub = -1, hd = 1e9;
    for (const i of cells) {
      if (!plain(i)) continue;
      const d = (i % N - sx) ** 2 + (((i / N) | 0) - sz) ** 2;
      if (d < hd) { hd = d; hub = i; }
    }
    if (hub >= 0 && cells.length >= 3) {
      // BFS over plain lawn from the hub
      for (const i of cells) { dist[i] = -1; par[i] = -1; }
      const q = [hub]; dist[hub] = 0;
      for (let h = 0; h < q.length; h++) {
        const i = q[h], x = i % N, z = (i / N) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, z > 0 ? i - N : -1, z < N - 1 ? i + N : -1]) {
          if (j >= 0 && lawn[j] && plain(j) && dist[j] < 0) { dist[j] = dist[i] + 1; par[j] = i; q.push(j); }
        }
      }
      const ents = [];
      for (const i of cells) {
        if (dist[i] < 0) continue;
        const x = i % N, z = (i / N) | 0;
        const road = (x > 0 && map[i - 1] === T_ROAD) || (x < N - 1 && map[i + 1] === T_ROAD) ||
          (z > 0 && map[i - N] === T_ROAD) || (z < N - 1 && map[i + N] === T_ROAD);
        if (road) ents.push(i);
      }
      const chosen = [];
      const want = cells.length >= 12 ? 3 : 2;
      while (chosen.length < want && ents.length) {
        let best = -1, bs = -1;
        for (const e of ents) {
          if (chosen.includes(e)) continue;
          const ex = e % N, ez = (e / N) | 0;
          let m = chosen.length ? 1e9 : dist[e];
          for (const c of chosen) m = Math.min(m, Math.abs(ex - c % N) + Math.abs(ez - ((c / N) | 0)));
          if (m > bs) { bs = m; best = e; }
        }
        if (best < 0 || (chosen.length && bs < 2)) break;
        chosen.push(best);
      }
      const bit = (from, to) => to === from - N ? 1 : to === from + N ? 2 : to === from - 1 ? 4 : 8;
      for (const e of chosen) {
        let i = e;
        // out to the street on the entrance tile
        const x = i % N, z = (i / N) | 0;
        if (z > 0 && map[i - N] === T_ROAD) path[i] |= 1;
        else if (z < N - 1 && map[i + N] === T_ROAD) path[i] |= 2;
        else if (x > 0 && map[i - 1] === T_ROAD) path[i] |= 4;
        else if (x < N - 1 && map[i + 1] === T_ROAD) path[i] |= 8;
        while (par[i] >= 0) { const p = par[i]; path[i] |= bit(i, p); path[p] |= bit(p, i); i = p; }
      }
      zone[hub] = LZ_HUB;
    }
    // zones for the rest, from a 2x2-tile patch hash so groves CLUMP
    for (const i of cells) {
      if (zone[i]) continue;
      const x = i % N, z = (i / N) | 0;
      const hp = hash2(x >> 1, z >> 1, seed ^ 0x6a2d), ht = hash2(x, z, seed ^ 0x1b77);
      if (path[i]) zone[i] = ht < 0.35 ? LZ_FLOWER : LZ_GROVE;
      else zone[i] = hp < 0.5 ? LZ_GROVE : (ht < 0.3 ? LZ_FLOWER : ht < 0.6 ? LZ_PICNIC : LZ_CLEAR);
    }
  }
  return { path, zone };
}

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

const VS_HEAD = /* glsl */`
attribute vec4 aTerr;   // (grass, sand, dirt, rock) blend weights
attribute vec4 aMask;   // (ao, wet, snow, rock tone)
attribute vec4 aPaint;  // (linear rgb, weight) — lot plinths
varying vec4 vPaint;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec4 vTerr;
varying vec4 vMask;
`;

const VS_BODY = /* glsl */`
  vTerr = aTerr;
  vMask = aMask;
  vPaint = aPaint;
  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;

const FS_HEAD = /* glsl */`
uniform sampler2D uDetail;
uniform sampler2D uRock;
uniform sampler2D uMacro;
uniform vec3 uCamPos;
uniform vec3 uTint;
uniform float uDetailAmt;
uniform float uSnowCover;
uniform float uWetGlobal;
uniform float uNight;
uniform float uAOStrength;
uniform vec2 uFine;      // (micro amplitude, meso amplitude)
uniform vec4 uLock;      // (microPeriodPx, microLod, mesoPeriodPx, mesoLod)
uniform vec4 uFineK;     // (coarsePeriodPx, coarseLod, coarseAmp, hazeCompCap)
uniform float uBiome;    // 0..1 master weight on the large-scale biome mask
uniform float uHorizonLift;
uniform vec2 uHorizonRamp;
uniform vec4 uDbg;       // (mode, scale, -, -) dev-only distance visualisation
uniform vec3 uSkyBounce;
uniform vec3 uNightTint;
uniform vec3 uNightSky;
uniform float uNightChroma;
uniform vec3 uGrassDeep, uGrassMid, uGrassLit, uGrassRich, uGrassDry;
uniform vec3 uGrassShade;
uniform float uGrassAoUndo;
uniform float uGrassShadeK;
uniform vec3 uWorn, uPebble, uSeaFar;
uniform vec3 uSand, uSandWet, uDirt;
uniform vec3 uRockA, uRockB, uRockC, uScree, uSnow;
uniform vec3 uRockFill;
uniform float uNightLotK;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec4 vTerr;
varying vec4 vMask;
varying vec4 vPaint;

vec3 thAlbedo;
float thGrassW = 0.0;   // r10: how much of this fragment is up-facing field grass
float thRockWall = 0.0; // wave-2: rock riser weight (uRockFill)
float thRough;
float thAO;
vec3 thNrm;
// three's fog factor for this fragment, computed ONCE at <color_fragment> (the
// first injection point where <fog_pars_fragment> has already declared fogNear /
// fogFar / vFogDepth) and reused by both thTerrain() and the <fog_fragment>
// horizon lift. thTerrain needs it because aerial perspective is a lerp, and a
// lerp scales every high-frequency residual the ground has by (1 - fogT).
float thFogT = 0.0;
// Dev-only: whatever uDbg.x asks for, written straight to the framebuffer after
// <dithering_fragment> so no tonemap / colour-space / dither touches it. -1 is
// "nothing to show". See BVFOG.dbgDepth() in tools/rendertest/fogmeter.js.
float thDbgOut = -1.0;

// r10: soften the SUN's cast shadow on open lawn (critic r9: "lighten the
// grass shadows and push them toward green"). lighting.js's CSM splice (which
// is prepended ahead of this header) calls csmApply() for the sun inside
// <lights_fragment_begin>; the macro below routes that one call through this
// wrapper, which hands back uGrassShadeK of the shadow on grass. Because it
// rewrites csmLastShadow, the shadowed-fill terms lighting.js derives from it
// soften by the same amount. Every other surface is untouched (thGrassW = 0).
#ifdef CSM_MAX_CASCADES
vec3 thCsmApply( const in vec3 lightColor, const in vec3 viewNormal, const in vec3 viewLightDir ) {
  vec3 r = csmApply( lightColor, viewNormal, viewLightDir );
  float k = uGrassShadeK * thGrassW * ( 1.0 - uNight );
  if ( k <= 0.0001 || uCsmMisc.y > 0.5 ) return r;
  // r14 (critic r13: "big soft blobby tree shadows … make them smaller and
  // crisper"): on lawn, re-ramp the PCSS penumbra so its soft outer halo
  // reads as lit and the core edge is short — a smaller, cleaner silhouette.
  float thShW = thGrassW * ( 1.0 - uNight );
  csmLastShadow = mix( csmLastShadow, smoothstep( 0.10, 0.52, csmLastShadow ), thShW );
  csmLastShadow = mix( csmLastShadow, 1.0, k );
  csmLastProx *= 1.0 - k;
  return lightColor * csmLastShadow;
}
#define csmApply thCsmApply
#endif

// Screen-space derivatives are core in GLSL ES 3.00 (three compiles every
// non-raw material to '#version 300 es' on WebGL2). On a WebGL1 fallback the
// OES_standard_derivatives pragma cannot be injected from onBeforeCompile
// without landing after the precision block, so degrade to the fixed width —
// the result is the old (aliasing but correct) behaviour, never a compile error.
#if __VERSION__ >= 300
  #define TH_FW( x ) fwidth( x )
#else
  #define TH_FW( x ) 0.0
#endif

// Screen-space-aware material boundary.
//
// Grass/road and grass/sand transitions are SHADER-space transitions inside a
// single continuous mesh, so MSAA cannot touch them: the polygon has no edge
// there to sample. A fixed-width smoothstep on a per-vertex blend weight
// therefore collapses to sub-pixel — and crawls — as soon as the camera pulls
// back. Widen the ramp until it spans >= ~2 px of screen (2*d / fwidth(w) px),
// and damp the organic noise erosion by the same factor so the noise itself
// never becomes the new aliasing frequency.
float thEdge( float w, float noise, float centre, float halfW ) {
  float d = max( halfW, TH_FW( w ) );
  float k = clamp( halfW / d, 0.0, 1.0 );
  return smoothstep( centre - d, centre + d, w + noise * k );
}

void thTerrain() {
  vec3 wn = normalize( vWNrm );
  // ==========================================================================
  // STYLISED GROUND (art direction: Pablo Gamedev "Isometric City Voxel").
  //
  // The reference ground is FLAT, CONFIDENT COLOUR: one lime/yellow-green lawn,
  // one clean sand, grey block rock with white caps, light concrete lot
  // plinths. No turf texture, no normal detail, no speckle, no grime — every
  // big face reads as one colour and the lighting does the rest. The previous
  // photoreal stack (screen-locked micro detail, biome mask, hedgerows, desire
  // paths, wear patches, pebbles) is gone on purpose; it measured as "noisy,
  // dark, mottled" against the reference in every blind pair.
  //
  // The only variation left on the grass is a VERY low-frequency (~130-unit, r6)
  // tonal drift of a couple of percent, so a full-map frame is not a single
  // flat swatch, but no two neighbouring tiles ever visibly differ.
  // ==========================================================================
  vec4 macP = texture2D( uMacro, vWPos.xz * 0.0075 );
  vec4 macR = texture2D( uMacro, vWPos.xz * 0.0017 + vec2( 0.37, 0.61 ) );

  // ---- grass ----------------------------------------------------------------
  float gDrift = clamp( 0.5 + ( macP.r - 0.5 ) * 0.9 + ( macR.g - 0.5 ) * 0.7, 0.0, 1.0 );
  vec3 grass = mix( uGrassMid, uGrassLit, gDrift * uBiome );
  grass *= 1.0 + ( macR.r - 0.5 ) * 0.035 * uBiome;

  // ---- sand (+ a soft damp band at the waterline) ----------------------------
  float wet = clamp( vMask.y, 0.0, 1.0 );
  vec3 sand = uSand;
  sand = mix( sand, uSandWet, thEdge( wet, 0.0, 0.55, 0.10 ) * 0.85 );

  // ---- soil (map-border cliff faces, under-water bed) ----------------------
  vec3 dirt = uDirt;

  // ---- rock: flat grey blocks, a per-column tone from the mesher -------------
  // vMask.w is the column's tone hash (0..1); the steps between columns are
  // what reads as "stepped voxel rock", not texture.
  vec3 rock = mix( uRockB, uRockA, clamp( vMask.w, 0.0, 1.0 ) );
  // r8 (ref06 rocks): the TOP of every step is clearly the lightest face, so
  // a range reads as stacked blocks, not one grey heap.
  rock *= 1.0 + 0.14 * clamp( wn.y, 0.0, 1.0 );

  // ---- composite: crisp class boundaries (small organic wobble only) --------
  float nz = macP.g - 0.5;
  float wS = thEdge( vTerr.y, nz * 0.10, 0.50, 0.06 );
  float wD = thEdge( vTerr.z, 0.0, 0.50, 0.06 );
  float wR = clamp( vTerr.w, 0.0, 1.0 );

  vec3 alb = grass;
  alb = mix( alb, sand, wS );
  alb = mix( alb, dirt, wD );
  alb = mix( alb, rock, wR );

  // ---- snow: authored caps + weather accumulation on up-facing faces --------
  float sBase = clamp( vMask.z, 0.0, 1.0 ) + uSnowCover * clamp( wn.y, 0.0, 1.0 );
  float snowAmt = thEdge( sBase, 0.0, 0.50, 0.04 );
  alb = mix( alb, uSnow, snowAmt );

  // ---- painted surfaces (lot plinths: rim / paving / lawn / sides) ----------
  // Authored per vertex as linear RGB + weight by the plinth mesher. Snow still
  // settles on the top of a plinth, never on its side.
  float paint = clamp( vPaint.a, 0.0, 1.0 );
  alb = mix( alb, mix( vPaint.rgb, uSnow, uSnowCover * 0.85 * step( 0.5, wn.y ) ), paint );
  // wave-2: painted rock tops are the brightest face (ref06 three-tone)
  alb *= 1.0 + 0.22 * wR * paint * clamp( wn.y, 0.0, 1.0 ) * ( 1.0 - snowAmt );

  // ---- off-map open sea ------------------------------------------------------
  float sea = clamp( vMask.y - 1.0, 0.0, 1.0 );
  alb = mix( alb, uSeaFar, sea );
  thGrassW = ( 1.0 - wS ) * ( 1.0 - wD ) * ( 1.0 - wR ) * ( 1.0 - snowAmt ) * ( 1.0 - paint ) *
             ( 1.0 - sea ) * smoothstep( 0.7, 0.95, wn.y );

  // Legacy knobs kept alive as no-ops so external tuning code does not throw.
  float thFine = 0.0 * ( uFine.x + uLock.x + uFineK.x + uDetailAmt + uHorizonLift + uCamPos.x );
  alb *= 1.0 + thFine;

  // ---- roughness ---------------------------------------------------------
  float rough = 0.96;
  rough = mix( rough, 0.92, wS );
  rough = mix( rough, 0.88, wR );
  rough = mix( rough, 0.70, snowAmt );
  rough = mix( rough, 0.86, paint );
  rough = mix( rough, 0.16, sea );
  rough *= 1.0 - uWetGlobal * 0.35;
  thRough = clamp( rough, 0.10, 1.0 );

  // ---- normal: the geometric one. Flat faces stay flat. ----------------------
  thNrm = wn;

  // ---- stylised face tones (ref04/ref06: top brightest, left mid, right
  // darkest). Keyed on the VIEW-space normal so it holds at every iso snap:
  // walls facing screen-left keep ~88 %, walls facing screen-right ~70 %.
  // The scene lighting still does its part on top; this only guarantees the
  // separation the reference reads by, on rock steps and plinth sides alike.
  {
    vec3 vn = ( viewMatrix * vec4( wn, 0.0 ) ).xyz;
    float vert = 1.0 - clamp( abs( wn.y ), 0.0, 1.0 );
    float thRight = smoothstep( -0.25, 0.25, vn.x );
    float faceK = mix( 0.88, 0.70, thRight );
    // wave-2: rock risers take ref06's stronger split (left ~0.80, right ~0.64).
    faceK = mix( faceK, mix( 0.80, 0.64, thRight ), wR * ( 1.0 - snowAmt ) );
    alb *= mix( 1.0, faceK, vert );
    thRockWall = wR * ( 1.0 - snowAmt ) * mix( 0.35, thRight, vert );
  }

  // ---- sky bounce (tiny; the scene's hemisphere fill already does most) ----
  alb += uSkyBounce * dot( alb, vec3( 0.299, 0.587, 0.114 ) ) *
         pow( clamp( 0.5 + 0.5 * wn.y, 0.0, 1.0 ), 0.40 );

  // ---- ambient occlusion + grade ------------------------------------------
  float ao = clamp( 1.0 - ( 1.0 - clamp( vMask.x, 0.0, 1.0 ) ) * uAOStrength, 0.0, 1.0 );
  thAO = ao;
  alb *= mix( 1.0, ao, 0.10 );
  float lum = dot( alb, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 nAlb = mix( vec3( lum ), alb, uNightChroma ) * uNightTint;
  // wave-2 (coherence #6): painted lot tops/rims read ~1.5x brighter than the
  // building models' own lotPlinths at night (rim #9c9cc0 vs #6c6ca8); the
  // models' night path is darker, so painted terrain dims to match.
  nAlb *= mix( 1.0, uNightLotK, paint );
  alb = mix( alb, nAlb, uNight );
  alb *= uTint;
  thAlbedo = clamp( alb, 0.0, 1.6 );
}
`;

// ---------------------------------------------------------------------------

// Small quad accumulator used by the rock and lot meshers. quad() orients
// each quad so its winding agrees with the supplied normal (front faces are
// CCW), which keeps the callers free of winding bookkeeping.
class GeoBuf {
  constructor() {
    this.pos = []; this.nrm = []; this.terr = []; this.mask = []; this.paint = []; this.idx = [];
    this.n = 0;
  }
  quad(p, nr, t, m, pc) {
    const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const flip = (cx * nr[0] + cy * nr[1] + cz * nr[2]) < 0;
    const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    const per = Array.isArray(m[0]);
    const base = this.n;
    for (const k of order) {
      const q = p[k];
      this.pos.push(q[0], q[1], q[2]);
      this.nrm.push(nr[0], nr[1], nr[2]);
      this.terr.push(t[0], t[1], t[2], t[3]);
      const mm = per ? m[k] : m;
      this.mask.push(mm[0], mm[1], mm[2], mm[3]);
      if (pc) this.paint.push(pc[0], pc[1], pc[2], pc[3]);
      else this.paint.push(0, 0, 0, 0);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.n += 4;
  }
  geometry(terr) {
    return terr._makeGeometry(this.pos, this.nrm, this.terr, this.mask, this.idx, this.paint);
  }
}

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] { sub, seabed, borderY, aniso, snowLine, uniforms }
   */
  constructor(scene, opts) {
    const o = opts || {};
    this.scene = scene;
    // Ground grid subdivisions per tile (2 => a 4-world-unit vertex grid).
    this.sub = Math.max(1, Math.min(4, o.sub | 0 || 2));
    this.seabed = o.seabed !== false;
    this.borderY = (typeof o.borderY === 'number') ? o.borderY : -3.2;
    this.snowY0 = (typeof o.snowY0 === 'number') ? o.snowY0 : 9.4;
    this.snowY1 = (typeof o.snowY1 === 'number') ? o.snowY1 : 13.2;
    this.snowLevel = (typeof o.snowLevel === 'number') ? o.snowLevel : 9;   // mountain level
    this.aoRadius = 2;                                   // tiles
    this.rugged = (typeof o.rugged === 'number') ? o.rugged : 0;   // (legacy jitter; stepped rock ignores it)
    // Shoreline warp amplitude, in TILES (see _warp). 0 restores the old
    // perfectly rectilinear, grid-locked land/water boundary.
    this.shoreWarp = (typeof o.shoreWarp === 'number') ? o.shoreWarp : 0.90;
    // Swash slope amplitude in world units (see _shoreDip). 0 restores the old
    // vertical bank lip — and the black rim that came with it.
    this.swash = (typeof o.swash === 'number') ? o.swash : SWASH;
    // Noise-widened beach (see _beach). false keeps sand exactly on the map's
    // SAND tiles — water.js draws its own hard-edged voxel sand deck there.
    this.beachNoise = o.beachNoise !== false;
    // Horizon skirt (see _buildSkirt). 2400 clears engine.js's worst-case
    // fog.far of camDist*4.2 + 224 = 1820 at the 380 orbit cap with margin.
    this.skirt = o.skirt !== false;
    this.skirtRadius = (typeof o.skirtRadius === 'number') ? o.skirtRadius : 2400;
    this._aniso = o.aniso || 8;
    this._envIntensity = (typeof o.envIntensity === 'number') ? o.envIntensity : 0.6;

    // --- textures ---------------------------------------------------------
    this.texDetail = buildDetailTexture(512, this._aniso);
    this.texRock = buildRockTexture(256, this._aniso);
    this.texMacro = buildMacroTexture(128, 2);

    // --- shared uniforms --------------------------------------------------
    const shared = (o.uniforms && typeof o.uniforms === 'object') ? o.uniforms : {};
    this.uniforms = {
      uDetail: { value: this.texDetail },
      uRock: { value: this.texRock },
      uMacro: { value: this.texMacro },
      uCamPos: { value: new THREE.Vector3(N * TILE * 0.5, 200, N * TILE * 0.5) },
      uTint: shared.uSeason || { value: new THREE.Vector3(1, 1, 1) },
      uDetailAmt: { value: 1 },
      uSnowCover: { value: 0 },
      uWetGlobal: { value: 0 },
      uNight: shared.uNight || { value: 0 },

      uAOStrength: { value: 1 },
      // Screen-locked micro/meso detail (see thTerrain). Amplitudes multiply
      // (sample - 0.5), and the detail texture's fbm only has sigma ~0.078
      // once mipped to the locked scale, so 0.52 lands on sigma ~4 % of albedo
      // / peak ~+-12 %. Measured, not guessed: at 0.60 the hero meadow's
      // high-pass residual moved 7.58 -> 9.09 counts.
      uFine: { value: new THREE.Vector2(1.15, 0.45) },
      // (micro period in screen px, its LOD, meso period in px, its LOD).
      // LOD = log2(texSize / periodPx) so one texel lands on one pixel; the
      // detail texture's base lattice is 16 cells per period, so the dominant
      // feature is periodPx/16 ~= 2.5 px for the micro layer, ~9 px for meso.
      uLock: {
        value: new THREE.Vector4(
          40, Math.log2(512 / 40),
          144, Math.log2(512 / 144)
        ),
      },
      // Third screen-locked octave + haze compensation.
      //   x = coarse period in screen px (160 px / 16 lattice cells ~ 10 px
      //       features: the band between micro's 2.5 px and meso's ~29 px that
      //       the distant skirt had nothing in),
      //   y = its LOD, z = its amplitude,
      //   w = the cap on the 1/(1-fogT) haze compensation. 3.2 restores detail
      //       out to fogT ~0.69; past that the ground is mostly sky anyway and
      //       an uncapped divide would turn quantisation noise into speckle.
      uFineK: {
        value: new THREE.Vector4(160, Math.log2(512 / 160), 0.52, 3.2),
      },
      // Master weight on the biome mask (see thTerrain). 0 = the old
      // single-green meadow; this is the A/B switch the hero grass chroma is
      // measured against, and the knob to pull if a future palette change
      // pushes the hero patch off its measured hue/saturation.
      uBiome: { value: 1.0 },
      // Aerial perspective (see the <fog_fragment> injection in _makeMaterial).
      // uHorizonLift is how much brighter than scene.fog.color the sky dome
      // actually draws at dir.y == 0; uHorizonRamp is the fog-factor window
      // over which the fade re-targets from the fog colour onto that value, so
      // mid-distance haze is untouched.
      uHorizonLift: { value: 5.6 },
      uHorizonRamp: { value: new THREE.Vector2(0.55, 1.0) },
      // Dev-only distance visualisation. mode 0 = off (ship state), 1 = the
      // fog varying vFogDepth, 2 = |vWPos - uCamPos|, 3 = fog factor, 4 = the
      // horizon ramp. uDbg.y is the world-unit scale for modes 1/2.
      uDbg: { value: new THREE.Vector4(0, 2048, 0, 0) },
      // Additive hemispherical bounce on up-facing ground (linear).
      // Keep this SMALL. The scene's own hemisphere fill + IBL already deliver
      // most of the sky bounce (with this term at zero the ground still
      // measures blue/green 0.52); the first tuning pass at (0.014,0.034,0.112)
      // stacked a second full bounce on top and pushed the meadow to sat 0.36 /
      // hue 116 — grey-green, the opposite failure from astroturf.
      uSkyBounce: { value: new THREE.Vector3(0.011, 0.016, 0.036) },
      // NOTE these look almost neutral, and that is deliberate: the scene's own
      // night key + hemisphere fill are already strongly blue, and the post
      // grade (saturation 1.05 + punch) amplifies whatever hue survives at low
      // luminance. Tinting hard toward blue HERE as well drove the red channel
      // to a measured literal 0 and saturation to 1.0 — a pure blue silhouette,
      // not a moonlit field. These only need to nudge.
      uNightTint: { value: new THREE.Vector3(0.96, 0.88, 1.04) },
      // coherence 09-25: 0.16 -> 0.6. Building lots, props and trees keep their
      // hue at night (materials.js / props.js); at 0.16 every terrain lot, hedge,
      // pitch and pool went grey-lavender next to them. 0.6 keeps the family.
      uNightChroma: { value: 0.6 },
      // Moon/sky indirect floor so night ground is blue-grey, not literally 0.
      // Measured night meadow: (0, 2.2, 17) sat 1.00 -> (26, 31, 42) sat 0.38
      // hue 223, i.e. a readable moonlit surface at ~30% of the day luminance.
      uNightSky: { value: new THREE.Vector3(0.110, 0.105, 0.150) },   // night r1 (coherence #6): 0.162/0.166/0.191 -> violet and ~0.65x; terrain parks/vacant lots matched the building lots' night value
      uGrassDeep: { value: lin(PAL.grassDeep) },
      uGrassMid: { value: lin(PAL.grassMid) },
      uGrassLit: { value: lin(PAL.grassLit) },
      // r10 (critic r9: tree shadows "spread across the lawn as large,
      // desaturated olive-grey blotches … ref05's grass stays evenly bright with
      // only light, soft shadows"): on up-facing grass, the fill light in cast
      // shadow is multiplied by this (a lift pushed toward green), and x of
      // uGrassAoUndo is how much of lighting.js's world AO is taken back off
      // open lawn (it pooled as dirty dark halos round every tree).
      uGrassShade: { value: new THREE.Vector3(1.02, 1.10, 0.84) },   // wave-2: less blue so big cast shadows (mountain) read as green shade, not a pale haze band
      uGrassAoUndo: { value: 0.65 },
      // Share of the sun's cast shadow handed back on open lawn (0 = full
      // shadow, 1 = none). Applied to the shadow term itself (thCsmApply), so
      // lighting.js's shadowed-fill terms soften with it.
      uGrassShadeK: { value: 0.50 },   // r14: 0.45 -> 0.50 (lighter lawn shadows)
      uGrassRich: { value: lin(PAL.grassRich) },
      uGrassDry: { value: lin(PAL.grassDry) },
      uWorn: { value: lin(PAL.worn) },
      uPebble: { value: lin(PAL.pebble) },
      uSeaFar: { value: lin(PAL.seaFar) },
      uSand: { value: lin(PAL.sand) },
      uSandWet: { value: lin(PAL.sandWet) },
      uDirt: { value: lin(PAL.dirt) },
      uRockA: { value: lin(PAL.rockA) },
      uRockB: { value: lin(PAL.rockB) },
      uRockC: { value: lin(PAL.rockC) },
      uScree: { value: lin(PAL.scree) },
      uSnow: { value: lin(PAL.snow) },
      // wave-2: sky fill on rock RISERS (x albedo). The mountain's shade side
      // measured near-black (#1c1f24) beside colourful building shade faces;
      // this lifts it into a readable cool stone tone (ART-DIRECTION: "the
      // dark side is still colourful, never muddy or black").
      uRockFill: { value: new THREE.Vector3(0.40, 0.41, 0.47) },
      uNightLotK: { value: 0.66 },
    };
    this._sharedNight = !!shared.uNight;
    // uTint may arrive as a Vector3-valued uniform from engine.js (uSeason).
    if (!(this.uniforms.uTint.value instanceof THREE.Vector3) &&
        !(this.uniforms.uTint.value instanceof THREE.Color)) {
      this.uniforms.uTint = { value: new THREE.Vector3(1, 1, 1) };
    }

    this.material = this._makeMaterial();

    // --- per-map scratch fields (allocated once, reused) -------------------
    const nn = N * N;
    this._cls = new Uint8Array(nn);
    this._occH = new Float32Array(nn);
    this._distWater = new Float32Array(nn);
    this._distLand = new Float32Array(nn);
    this._occNear = new Uint8Array(nn);
    this._noWarp = new Uint8Array(nn);
    this._noDip = new Uint8Array(nn);
    // Lot plinths: per-tile kind (0 none, else a LOT_KIND index) and a grouping
    // key (the building id, so one building = one pad with one rim).
    this._lotKind = new Uint8Array(nn);
    this._lotKey = new Int32Array(nn);
    this._builtKey = new Int32Array(nn);   // key each tile's chunk was BUILT with
    this._block = new Uint8Array(nn);      // cityBlockMask()
    this._parcel = new Uint8Array(nn);     // parcelPlan().mask
    this._lawn = new Uint8Array(nn);       // lawnMask(): raised lawn plinth tiles (r10)
    this._parcelRects = [];
    this._verge = new Uint8Array(nn);      // road-side bits of open land tiles (kerb band)
    this._rectAt = new Array(nn).fill(null); // vacant tile -> its merged lot rect
    this._dirty = new Set();               // tile indices awaiting a lot refresh
    // Parked cars of vacant-lot car parks, for life.js to draw as its res-8
    // vehicles (life sets lotCarsExternal; then car() records instead of
    // drawing boxes). rect origin tile -> [{x, z, y, h, k}] world units,
    // h = heading 0 N(-Z) 1 E 2 S 3 W. lotCarsVersion bumps on any change.
    this.lotCars = new Map();
    this.lotCarsVersion = 0;
    this.lotCarsExternal = false;
    this._state = null;
    this._lotScratch = [0, 0];
    this._mtnMax = 0;
    this._wp = [0, 0];                 // scratch for _warp
    this._fieldsValid = false;

    this._chunks = new Map();        // "cx,cz" -> { ground, rock }
    this._skirt = null;              // horizon skirt mesh (one, not chunked)
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    if (scene) scene.add(this.group);

    this._lastBuildMs = 0;
    this._lastRefreshMs = 0;
    this._quality = 2;
  }

  // -------------------------------------------------------------------------
  // Material
  // -------------------------------------------------------------------------

  _makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
      side: THREE.FrontSide,
      dithering: false,   // night r1: the scene target is half-float (no banding), and three's +/-0.5/255 dither sat under the tonemap's black plateau, then sparkled as grain wherever a lamp pool lifted the asphalt out of it
    });
    mat.envMapIntensity = (typeof this._envIntensity === 'number') ? this._envIntensity : 0.6;
    mat.name = 'terrain';
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      for (const k in U) shader.uniforms[k] = U[k];
      shader.vertexShader = VS_HEAD + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + VS_BODY
      );
      let fs = FS_HEAD + shader.fragmentShader;
      // thFogT has to exist BEFORE thTerrain() runs: the detail layer needs it
      // to compensate for the haze lerp (see the screen-locked block). This is
      // the first injection point after <fog_pars_fragment> has declared
      // fogNear / fogFar / fogDensity / vFogDepth, so it is computed here and
      // the <fog_fragment> injection below just reuses the value.
      fs = fs.replace(
        '#include <color_fragment>',
        '#ifdef USE_FOG\n' +
        '  #ifdef FOG_EXP2\n' +
        '    thFogT = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );\n' +
        '  #else\n' +
        '    thFogT = smoothstep( fogNear, fogFar, vFogDepth );\n' +
        '  #endif\n' +
        '#endif\n' +
        '#include <color_fragment>\n  thTerrain();\n  diffuseColor.rgb = thAlbedo;'
      );
      fs = fs.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = thRough;'
      );
      fs = fs.replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n' +
        '  normal = normalize( ( viewMatrix * vec4( thNrm, 0.0 ) ).xyz );\n' +
        '  nonPerturbedNormal = normal;'
      );
      // Baked AO is an AMBIENT term: it may only scale indirect light. The
      // directional sun is already occluded by the real shadow map inside
      // <lights_fragment_begin>; multiplying directDiffuse by thAO as well
      // double-darkens exactly where a building's contact AO and its cast
      // shadow overlap, and it flattens the cast shadow into the AO blob.
      // Composition is therefore: shadow -> sun, AO -> sky. They multiply in
      // different domains, so deep shade = "in shadow AND occluded" without
      // ever removing the same photon twice.
      fs = fs.replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n' +
        '  float thAOa = clamp( thAO * thAO * ( 3.0 - 2.0 * thAO ), 0.0, 1.0 );\n' +
        '  reflectedLight.indirectDiffuse *= thAOa;\n' +
        '  reflectedLight.indirectSpecular *= mix( 1.0, thAOa, 0.8 );\n' +
        // r10: soft, green-leaning shade on open lawn (see uGrassShade). The
        // cast shadow and lighting.js's world AO are both known here (they are
        // lighting.js globals once its CSM splice is in), so the lawn's shade
        // is re-graded without touching any other surface.
        '#ifdef CSM_MAX_CASCADES\n' +
        '  if ( thGrassW > 0.001 ) {\n' +
        '    float thSh = ( 1.0 - csmLastShadow ) * thGrassW * ( 1.0 - uNight );\n' +
        '    reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), uGrassShade, thSh );\n' +
        '    float thWao = clamp( csmAoDirect( geometryNormal ), 0.35, 1.0 );\n' +
        '    float thUn = uGrassAoUndo * thGrassW;\n' +
        '    reflectedLight.directDiffuse /= mix( 1.0, thWao, thUn );\n' +
        // csmAoIndirect also carries a hue/saturation factor that is there
        // even in the open; divide it out so only the occlusion is undone.
        '    float thL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );\n' +
        '    vec3 thSat = mix( vec3( 1.0 ), clamp( diffuseColor.rgb / max( thL, 0.02 ), vec3( 0.55 ), vec3( 1.9 ) ), uAoTune.w );\n' +
        '    vec3 thIao = clamp( csmAoIndirect( geometryNormal, diffuseColor.rgb ) / max( thSat, vec3( 0.05 ) ), vec3( 0.35 ), vec3( 1.0 ) );\n' +
        '    reflectedLight.indirectDiffuse /= mix( vec3( 1.0 ), thIao, thUn );\n' +
        '  }\n' +
        '#endif\n' +
        // A moon/sky indirect floor. Without it the measured night ground was
        // (0,24,2) — the red channel had literally quantised to zero, so the
        // night grade had nothing left to shift. This is an INDIRECT term, so
        // it is occluded by the baked AO and never lights a shadowed crevice.
        //
        // Ramped, NOT linear in uNight. At dusk (nightEff ~0.38) the sky is
        // still doing the lighting, and a linear floor there measured +15%
        // luminance for -16% turf contrast — it was paying full price to fix a
        // problem that only exists after dark. smoothstep reaches exactly 1.0
        // by 0.92, which is where the night grade is measured.
        '  float thNightFloor = smoothstep( 0.45, 0.92, uNight );\n' +
        '  reflectedLight.indirectDiffuse += uNightSky * thNightFloor * diffuseColor.rgb * thAOa;\n' +
        '  reflectedLight.indirectDiffuse += diffuseColor.rgb * uRockFill * thRockWall * thAOa * ( 1.0 - 0.85 * uNight );'
      );
      // ---- aerial perspective at the horizon --------------------------------
      // three's <fog_fragment> converges distant geometry on scene.fog.color.
      // engine.js sets that from sky.update()'s fogColor, which IS a horizon
      // sample of the dome — but the dome does not DRAW that value: sky.js
      // pins itself only 62 % of the way to it in a narrow band around
      // dir.y == 0 (`anchor = exp(-|dir.y|*34)*0.62`) and then adds the Mie
      // forward-scatter and city-glow terms on top. So the sky at the skyline
      // is materially brighter than the fog colour, and the land underneath it
      // fades to something darker than the sky it is supposed to be dissolving
      // into. Measured on the waterfront shot: sky 157.6, land 103.3 — a
      // 54-count cliff along the whole skyline, which reads as a dark navy
      // band of "distant land" instead of haze. (water.js hit exactly this and
      // fixed it the same way for the lake surface.)
      //
      // APPEND-ONLY: <fog_fragment> still runs untouched. Because it is a
      // lerp, re-targeting it is a pure addition —
      //   mix(c, haze, t) == mix(c, fogColor, t) + (haze - fogColor) * t
      // — so nothing has to be un-mixed and nothing can go negative.
      //
      // The lift is ramped in on fogT itself so only the LAST stretch of the
      // fade moves: mid-distance land keeps today's haze (a flat lift there
      // would wash the whole map out), and only what is actually meeting the
      // skyline converges on the sky's true horizon radiance.
      fs = fs.replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\n' +
        '#ifdef USE_FOG\n' +
        '  float thHz = smoothstep( uHorizonRamp.x, uHorizonRamp.y, thFogT );\n' +
        '  gl_FragColor.rgb += fogColor * ( uHorizonLift - 1.0 ) * thHz * thFogT;\n' +
        '  if ( uDbg.x > 0.5 ) {\n' +
        '    thDbgOut = ( uDbg.x < 1.5 ) ? vFogDepth / uDbg.y\n' +
        '             : ( uDbg.x < 2.5 ) ? distance( vWPos, uCamPos ) / uDbg.y\n' +
        '             : ( uDbg.x < 3.5 ) ? thFogT : thHz;\n' +
        '  }\n' +
        '#endif'
      );
      // Dev-only debug readout, AFTER dithering so the value is bit-exact.
      fs = fs.replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\n' +
        '  if ( thDbgOut >= 0.0 ) {\n' +
        '    float thD = clamp( thDbgOut, 0.0, 1.0 ) * 255.0;\n' +
        '    gl_FragColor = vec4( floor( thD ) / 255.0, fract( thD ), 0.0, 1.0 );\n' +
        '  }\n'
      );
      shader.fragmentShader = fs;
      this._shader = shader;
    };
    return mat;
  }

  // -------------------------------------------------------------------------
  // Map-derived fields
  // -------------------------------------------------------------------------

  _isWater(state, i) {
    return state.map[i] === T_WATER || (state.bridge && state.bridge[i] === 1);
  }

  _classAt(x, z) {
    if (x < 0) x = 0; else if (x >= N) x = N - 1;
    if (z < 0) z = 0; else if (z >= N) z = N - 1;
    return this._cls[z * N + x];
  }

  // Building id -> building record, for lot kinds (rebuilt per call: cheap).
  _bmap(state) {
    const bm = new Map();
    const bs = state && state.buildings;
    if (Array.isArray(bs)) for (const b of bs) if (b) bm.set(b.bid, b);
    return bm;
  }

  // Lot kind + key for tile i into out[0], out[1]. Pure function of state
  // (+ the block mask _computeFields derived from it).
  _lotInfo(state, i, bm, out) {
    out[0] = 0; out[1] = 0;
    const m = state.map[i];
    if (m === T_WATER || m === T_MOUNTAIN || m === T_ROAD) return out;
    if (state.bridge && state.bridge[i] === 1) return out;
    const o = state.occ ? state.occ[i] : 0;
    if (m === T_TREE) {
      // open land (a lawn plinth, or a verge kerb — below)
    } else if (o) {
      const b = bm.get(o);
      // Decorations (benches, hedges, ponds …) are dressing on the open lawn.
      if (!(b && b.cat === 'deco')) { out[0] = LK_FOOT; out[1] = o; return out; }
    } else if ((m >= 4 && m <= 7) || (m >= 9 && m <= 14)) {
      out[0] = LK_FOOT; out[1] = -(m + 1); return out;
    } else if (this._block[i]) {
      // Final key (the merged rect) is assigned by _partitionLots.
      out[0] = LK_VACANT; out[1] = -(100 + i); return out;
    } else if (this._parcel[i] === 1) {
      // Final key (the parcel rect) is assigned in _computeFields.
      out[0] = LK_PARCEL; out[1] = -(200 + i); return out;
    } else if (this._parcel[i] === 3) {
      // r10: green parcels (park / pitch / orchard / pond) stand on a raised
      // plinth like every other lot (critic r9: "give grass and park lots the
      // same raised plinth as building lots, with a visible side band").
      out[0] = LK_PARCEL; out[1] = -(200 + i); return out;
    }
    // Open land beside a road: the key carries the kerb sides, so painting or
    // bulldozing a road next to it rebuilds its chunk.
    const x = i % N, z = (i / N) | 0, map = state.map;
    const vm = (z > 0 && map[i - N] === T_ROAD ? 1 : 0) | (z < N - 1 && map[i + N] === T_ROAD ? 2 : 0) |
      (x > 0 && map[i - 1] === T_ROAD ? 4 : 0) | (x < N - 1 && map[i + 1] === T_ROAD ? 8 : 0);
    if (this._lawn[i]) {
      // r11: the key also carries the tile's park path bits and zone, so a
      // road or building that re-routes the paths rebuilds the chunk.
      const lp = this._lpark;
      out[0] = LK_LAWN; out[1] = -(40000 + vm + (lp ? lp.path[i] * 16 + lp.zone[i] * 256 : 0)); return out;
    }
    if (vm) out[1] = -(10000 + vm);
    return out;
  }

  _computeFields(state) {
    this._state = state;
    let mm = 0;
    if (state.variant) for (let i = 0; i < N * N; i++) if (state.map[i] === T_MOUNTAIN && state.variant[i] > mm) mm = state.variant[i];
    this._mtnMax = mm;
    const map = state.map;
    const variant = state.variant;
    const occ = state.occ;
    const cls = this._cls, occH = this._occH;
    const bm = this._bmap(state), li = this._lotScratch;
    cityBlockMask(state, this._block);
    const plan = parcelPlan(state, this._block);
    this._parcel.set(plan.mask);
    this._parcelRects = plan.rects;
    lawnMask(state, this._block, this._parcel, this._lawn);
    this._lpark = lawnPark(state, this._lawn);
    for (let i = 0; i < N * N; i++) {
      this._lotInfo(state, i, bm, li);
      this._lotKind[i] = li[0];
      this._lotKey[i] = li[1];
      this._verge[i] = (li[0] === 0 && li[1] <= -10001 && li[1] >= -10015) ? -li[1] - 10000 : 0;
      const m = map[i];
      let c;
      if (this._isWater(state, i)) c = C_WATER;
      else if (m === T_MOUNTAIN) c = C_ROCK;
      else if (m === T_SAND) c = C_SAND;
      else if (m === T_ROAD) c = C_DIRT;
      else c = C_GRASS;
      cls[i] = c;

      // Occluder height (drives baked contact AO).
      let h = 0;
      if (m === T_MOUNTAIN) h = (variant && variant[i] > 0) ? variant[i] : 4;
      else if (occ && occ[i] !== 0) h = 7;
      else if (m === T_BLDG) h = 7;
      else if (m === T_TREE) h = 2;
      else if (m >= 9 && m <= 14) h = 6;   // park/school/fire/fountain/stadium/power
      else if (this._lotKind[i] === LK_VACANT || this._lotKind[i] === LK_PARCEL || this._lotKind[i] === LK_LAWN) h = 1;
      occH[i] = h;
    }
    // Merge vacant tiles into rects, pick their designs, assign rect keys.
    this._partitionLots(state, bm);
    // Outskirts parcels: one rect object per parcel, keyed like vacant rects
    // (origin, size, street side and design) so any change rebuilds its chunks.
    for (const r of this._parcelRects) {
      r.o = r.z * N + r.x;
      const k = -(20000000 + ((r.o * 64 + (r.w - 1) * 8 + (r.d - 1)) * 4 + r.rot) * 32 + (r.design & 31));
      for (let zz = r.z; zz < r.z + r.d; zz++) {
        for (let xx = r.x; xx < r.x + r.w; xx++) {
          const j = zz * N + xx;
          if (this._lotKind[j] !== LK_PARCEL && this._lotKind[j] !== LK_GREEN) continue;
          this._rectAt[j] = r; this._lotKey[j] = k;
        }
      }
    }
    this._chamfer(this._distWater, (i) => cls[i] === C_WATER);
    this._chamfer(this._distLand, (i) => cls[i] !== C_WATER);

    // Dilated "an occluder is within aoRadius of this tile" flag. Most of the
    // map is empty meadow, so this lets the per-vertex AO scan early-out.
    const near = this._occNear, R = this.aoRadius;
    near.fill(0);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        if (occH[i] <= 0 && cls[i] !== C_WATER) continue;
        const z0 = Math.max(0, z - R), z1 = Math.min(N - 1, z + R);
        const x0 = Math.max(0, x - R), x1 = Math.min(N - 1, x + R);
        for (let nz = z0; nz <= z1; nz++) {
          for (let nx = x0; nx <= x1; nx++) near[nz * N + nx] = 1;
        }
      }
    }

    // "Keep this ground on the tile grid" mask, dilated by 2 tiles.
    // Roads (roads.js), bridge decks (map says ROAD) and mountain columns (our
    // own rock pass) are all meshed on the raw grid and are NOT warped, so the
    // ground has to arrive at them unwarped or a T-junction crack opens. The
    // field is bilinearly sampled, so the warp eases off over a tile rather
    // than switching off.
    const nw = this._noWarp, RW = 2;
    const nd = this._noDip;
    nw.fill(0); nd.fill(0);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const m = map[i];
        const grid = (m === T_ROAD || m === T_MOUNTAIN || this._lotKind[i] > 0);
        // The swash slope lowers the GROUND, so anything bottom-anchored at
        // y = 0 has to veto it too or it is left floating over its own shadow.
        const anchored = grid || occH[i] > 0;
        if (!anchored) continue;
        const z0 = Math.max(0, z - RW), z1 = Math.min(N - 1, z + RW);
        const x0 = Math.max(0, x - RW), x1 = Math.min(N - 1, x + RW);
        for (let nz = z0; nz <= z1; nz++) {
          for (let nx = x0; nx <= x1; nx++) {
            const j = nz * N + nx;
            if (grid) nw[j] = 1;
            nd[j] = 1;
          }
        }
      }
    }
    // Any tile whose lot changed since its chunk was built (a road closed a
    // block, a building went up or was bulldozed) queues a coalesced rebuild.
    for (let i = 0; i < N * N; i++) if (this._lotKey[i] !== this._builtKey[i]) this._dirty.add(i);
    this._fieldsValid = true;
  }

  // Two-pass chamfer distance transform (tile units, ~3% error vs Euclidean).
  _chamfer(out, isSeed) {
    const BIG = 1e4, D1 = 1.0, D2 = 1.41421356;
    for (let i = 0; i < N * N; i++) out[i] = isSeed(i) ? 0 : BIG;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        let v = out[i];
        if (x > 0) v = Math.min(v, out[i - 1] + D1);
        if (z > 0) v = Math.min(v, out[i - N] + D1);
        if (x > 0 && z > 0) v = Math.min(v, out[i - N - 1] + D2);
        if (x < N - 1 && z > 0) v = Math.min(v, out[i - N + 1] + D2);
        out[i] = v;
      }
    }
    for (let z = N - 1; z >= 0; z--) {
      for (let x = N - 1; x >= 0; x--) {
        const i = z * N + x;
        let v = out[i];
        if (x < N - 1) v = Math.min(v, out[i + 1] + D1);
        if (z < N - 1) v = Math.min(v, out[i + N] + D1);
        if (x < N - 1 && z < N - 1) v = Math.min(v, out[i + N + 1] + D2);
        if (x > 0 && z < N - 1) v = Math.min(v, out[i + N - 1] + D2);
        out[i] = v;
      }
    }
  }

  // Bilinear sample of a per-tile field at continuous tile coords (u,v),
  // where tile (tx,tz) is centred at (tx+0.5, tz+0.5).
  _bilin(field, u, v) {
    const a = u - 0.5, b = v - 0.5;
    let i0 = Math.floor(a), j0 = Math.floor(b);
    const fx = sstep(0, 1, a - i0), fz = sstep(0, 1, b - j0);
    const i1 = i0 + 1, j1 = j0 + 1;
    const cx0 = i0 < 0 ? 0 : (i0 > N - 1 ? N - 1 : i0);
    const cx1 = i1 < 0 ? 0 : (i1 > N - 1 ? N - 1 : i1);
    const cz0 = j0 < 0 ? 0 : (j0 > N - 1 ? N - 1 : j0);
    const cz1 = j1 < 0 ? 0 : (j1 > N - 1 ? N - 1 : j1);
    const p = field[cz0 * N + cx0] + (field[cz0 * N + cx1] - field[cz0 * N + cx0]) * fx;
    const q = field[cz1 * N + cx0] + (field[cz1 * N + cx1] - field[cz1 * N + cx0]) * fx;
    return p + (q - p) * fz;
  }

  // Blend weights (grass, sand, dirt, rock) at continuous tile coords.
  _blendAt(u, v, out) {
    const a = u - 0.5, b = v - 0.5;
    const i0 = Math.floor(a), j0 = Math.floor(b);
    const fx = sstep(0, 1, a - i0), fz = sstep(0, 1, b - j0);
    const w = [(1 - fx) * (1 - fz), fx * (1 - fz), (1 - fx) * fz, fx * fz];
    const xs = [i0, i0 + 1, i0, i0 + 1];
    const zs = [j0, j0, j0 + 1, j0 + 1];
    let g = 0, s = 0, d = 0, r = 0;
    for (let k = 0; k < 4; k++) {
      const c = this._classAt(xs[k], zs[k]);
      const ww = w[k];
      if (c === C_GRASS) g += ww;
      else if (c === C_SAND) s += ww;
      else if (c === C_DIRT) g += ww;   // roads.js covers it; no brown verge
      else if (c === C_ROCK) r += ww;
      else { s += ww * 0.80; d += ww * 0.20; }   // water reads as wet sand/silt
    }
    out[0] = g; out[1] = s; out[2] = d; out[3] = r;
  }

  // -------------------------------------------------------------------------
  // Shoreline: getting the land/water boundary OFF the tile grid
  // -------------------------------------------------------------------------
  // Both round-1 reviewers called the lake "a rectilinear swimming pool": the
  // shore was a run of hard 90 deg steps with a constant-width sand band
  // tracing them exactly. That silhouette is this module's — water.js can only
  // move its fringe vertices ONSHORE (retreating its surface uncovers our bank),
  // so the outline is our bank's, and the band is our sand's.
  //
  // Fixed in three places:
  //   1. _warp()  — a horizontal displacement of the ground lattice near the
  //                 shore, so the boundary polygon itself meanders.
  //   2. _beach() — beach WIDTH is a noise field that also erodes the authored
  //                 sand ring, so the band stops being a constant offset.
  //   3. _wetAt() — the damp-sand band gets the same treatment.
  //
  // (1) is the delicate one. Rules it must obey:
  //   * pure function of world (x,z) — every duplicate of a shared lattice
  //     point (chunk seams, bank tops, bed corners) must land on the SAME
  //     value or the mesh cracks;
  //   * land may only ADVANCE toward the water, never retreat: water.js's
  //     surface never extends past the tile boundary offshore, so a retreating
  //     bank would uncover itself and the sea bed from under the water;
  //   * zero at the map border (the horizon skirt is not warped) and zero near
  //     roads/bridges/mountains (meshed on the grid by other passes);
  //   * zero across water narrow enough for two opposing shores to close it.

  // Signed shore field in tiles: > 0 on land, < 0 on water, 0 at the boundary.
  _signed(u, v) {
    return this._bilin(this._distWater, u, v) - this._bilin(this._distLand, u, v);
  }

  /**
   * Horizontal shoreline displacement. Writes the warped world position of
   * (wx,wz) into `out` and returns it.
   * @param {number} wx @param {number} wz @param {number[]} out [x,z]
   */
  _warp(wx, wz, out) {
    out[0] = wx; out[1] = wz;
    const amp0 = this.shoreWarp;
    if (!(amp0 > 0) || !this._fieldsValid) return out;
    const W = N * TILE;
    // The horizon skirt meets the border cliffs exactly on the map boundary
    // and is not warped, so the boundary must stay put.
    const gEdge = sstep(0, 24, Math.min(wx, wz, W - wx, W - wz));
    if (gEdge <= 0) return out;
    const u = wx / TILE, v = wz / TILE;
    // Cheap per-tile reject before any bilinear work. Most of an 80x80 map is
    // nowhere near water and this runs for every lattice vertex of every
    // rebuild, so the early-out is what keeps build() off the placement path.
    let ci = (v | 0), cj = (u | 0);
    if (cj < 0) cj = 0; else if (cj > N - 1) cj = N - 1;
    if (ci < 0) ci = 0; else if (ci > N - 1) ci = N - 1;
    const ti = ci * N + cj;
    if (Math.abs(this._distWater[ti] - this._distLand[ti]) > 5.0) return out;
    const s0 = this._signed(u, v);
    // Every gate below is deliberately a WIDE ramp. The displacement is applied
    // to a 4-unit lattice, so the sum of |d(displacement)/dx| over all the
    // gates has to stay well under 1 or a ground triangle folds over itself —
    // which shows as a black shard in the beach. selfTest() checks for folds.
    const gBand = sstep(3.4, 0.50, Math.abs(s0));
    if (gBand <= 0) return out;                       // early-out: most of the map
    const gFree = 1 - clamp01(this._bilin(this._noWarp, u, v));
    if (gFree <= 0.001) return out;
    // Gradient of the signed field. Direction points INLAND; the magnitude is
    // in units of "S per tile" and is the whole trick, see below.
    const H = 0.85;
    let gx = this._signed(u + H, v) - this._signed(u - H, v);
    let gz = this._signed(u, v + H) - this._signed(u, v - H);
    const m = Math.sqrt(gx * gx + gz * gz);
    if (m < 1e-4) return out;
    const grad = m / (2 * H);
    gx /= m; gz /= m;
    // The high-frequency octave matters more than the amplitude: the staircase
    // step is one TILE, so the displacement has to change materially WITHIN a
    // tile or every step just slides sideways intact.
    let n = vnoiseW(wx * 0.0260, wz * 0.0260, 6151) * 0.56 +
            vnoiseW(wx * 0.0560, wz * 0.0560, 2803) * 0.44;
    n = clamp01((n - 0.20) * 1.62);
    // This is a LEVEL-SET shift, not a fixed offset. `lvl` is how far the shore
    // contour moves measured IN THE FIELD, and the world distance that works
    // out to is lvl / |grad S|. That difference is what actually erodes the
    // staircase rather than sliding it sideways intact: a one-tile bump or
    // notch has a steep field (S swings from +1 to -1 across a single tile), a
    // smooth run of coast a gentle one, so the same contour shift moves the
    // straight stretches further than the corners and the boundary relaxes
    // toward the smooth contour.
    const lvl = 0.55 + 1.15 * n;
    // How much open water there is to advance into, 1.15 tiles offshore: a
    // 1-tile river must not be pinched shut from both banks. Floored rather
    // than zeroed, because the places this gate fires hardest are exactly the
    // 1-tile inlets whose 90 deg notches read worst; 0.35 of the amplitude
    // still leaves >half a tile of open water in the narrowest channel.
    const room = 0.55 + 0.45 * clamp01(
      (this._bilin(this._distLand, u - gx * 1.15, v - gz * 1.15) - 0.45) / 1.80);
    let a = lvl / Math.max(grad, 0.75);              // tiles
    if (a > amp0) a = amp0;                          // hard cap, in tiles
    a *= TILE * gBand * gEdge * gFree * room;
    if (a <= 0) return out;
    out[0] = wx - gx * a;
    out[1] = wz - gz * a;
    return out;
  }

  // -------------------------------------------------------------------------
  // Swash slope: killing the black rim on the water/sand boundary
  // -------------------------------------------------------------------------
  // The bank was a VERTICAL wall from the sea bed up to y = 0, so its top
  // 0.35 units stood proud of the water surface all the way round every lake.
  // Measured at 3x on a concave notch of the lower-left lake: terrain alone
  // there renders (47,73,66), the water alone renders (40,109,143) — and the
  // COMPOSITE renders (26,36,31), i.e. darker than either layer. That is not a
  // blend; that is post.js's SSAO biting on the depth cliff between the water
  // surface and the bank face behind it. A z-gap, exactly as predicted.
  //
  // The earlier proposal — a raised swash skirt drawn OVER the beach — was
  // rejected because it is only watertight where the land's advance exceeds the
  // ramp width, and it needed a horizontal offset that leaves wedge gaps at
  // convex corners. This does it the other way round and needs no offset at
  // all: the ground LATTICE ITSELF dips as it approaches the waterline, and
  // the bank's top edge follows the same pure function, so the two agree by
  // construction and nothing can crack. What is left of the vertical face is
  // 0.03 units tall — sub-pixel at every shot distance — and the surface SSAO
  // sees across the shore is now a continuous 2-degree ramp with no cliff in it.
  //
  // Rules, same shape as _warp():
  //   * pure function of world (x,z) — every duplicate of a shared lattice
  //     point must land on the same value;
  //   * never below WATER_Y (no dry trench under the water line);
  //   * zero at the map border (the horizon skirt and the border cliffs are
  //     flat at borderY there);
  //   * zero near roads / bridges / mountains / buildings, which are all
  //     authored at y = 0 and would be left floating.
  // Returns a POSITIVE drop; the ground sits at -_shoreDip().
  _shoreDip(wx, wz) {
    if (!(this.swash > 0) || !this._fieldsValid) return 0;
    const u = wx / TILE, v = wz / TILE;
    let ci = (v | 0), cj = (u | 0);
    if (cj < 0) cj = 0; else if (cj > N - 1) cj = N - 1;
    if (ci < 0) ci = 0; else if (ci > N - 1) ci = N - 1;
    // Cheap per-tile reject: only tiles within ~2 of water can dip at all.
    if (this._distWater[ci * N + cj] > 2.6) return 0;
    const dw = this._bilin(this._distWater, u, v);
    // dw is 0.5 exactly on a land/water tile edge and 1.0 at a land tile
    // centre, so the ramp has to start below 0.55 to reach full drop there.
    const t = 1 - sstep(0.50, 1.85, dw);
    if (t <= 0) return 0;
    const free = 1 - clamp01(this._bilin(this._noDip, u, v));
    if (free <= 0.001) return 0;
    const W = N * TILE;
    const gEdge = sstep(0, 24, Math.min(wx, wz, W - wx, W - wz));
    return this.swash * t * free * gEdge;
  }

  // Noise-varied beach: redistributes the grass/sand split of a ground vertex.
  // `dw` is the bilinear distance-to-water in tiles at (u,v).
  _beach(u, v, dw, blend) {
    if (!this.beachNoise) return;
    const land = blend[0] + blend[1];
    if (land <= 1e-4) return;
    const wx = u * TILE, wz = v * TILE;
    // Beach WIDTH as a field: ~0.1 tiles (grass to the waterline) to ~2.2.
    const bn = vnoiseW(wx * 0.0125, wz * 0.0125, 8821) * 0.68 +
               vnoiseW(wx * 0.0410, wz * 0.0410, 3313) * 0.32;
    const bw = 0.38 + 2.30 * Math.pow(clamp01(bn), 1.5);
    const beach = sstep(bw + 0.55, bw - 0.55, dw);
    // ...and it ERODES the authored ring where it is narrow. Without this the
    // map's own constant-width sand tiles keep tracing the staircase
    // underneath, and widening the band only makes the step pattern louder.
    // Floored at 0.35 — deleting the strand outright just swaps a rectilinear
    // beach for a rectilinear grass-to-water cut.
    const en = vnoiseW(wx * 0.0090 + 3.1, wz * 0.0090 - 1.7, 5107);
    const erode = 0.35 + 0.65 * clamp01((en - 0.25) * 1.80);
    const sAuth = blend[1] / land;
    const mix = clamp01(Math.max(beach, sAuth * erode));
    blend[1] = land * mix;
    blend[0] = land - blend[1];
  }

  // Damp-sand band width, also a noise field rather than a constant ring.
  _wetAt(u, v, dw) {
    const n = vnoiseW(u * TILE * 0.0230 - 5.3, v * TILE * 0.0230 + 2.9, 9137);
    return sstep(0.55 + 1.45 * n, 0.08, dw);
  }

  // Baked contact AO at continuous tile coords.
  _aoAt(u, v) {
    const R = this.aoRadius;
    let cu = Math.floor(u), cv = Math.floor(v);
    if (cu < 0) cu = 0; else if (cu > N - 1) cu = N - 1;
    if (cv < 0) cv = 0; else if (cv > N - 1) cv = N - 1;
    if (!this._occNear[cv * N + cu]) return 1;      // nothing near: full light
    const tx0 = Math.floor(u) - R, tx1 = Math.floor(u) + R;
    const tz0 = Math.floor(v) - R, tz1 = Math.floor(v) + R;
    let occAmt = 0;
    for (let tz = tz0; tz <= tz1; tz++) {
      if (tz < 0 || tz >= N) continue;
      for (let tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || tx >= N) continue;
        const i = tz * N + tx;
        const h = this._occH[i];
        const cx = tx + 0.5 - u, cz = tz + 0.5 - v;
        const d = Math.sqrt(cx * cx + cz * cz);
        if (h > 0) {
          const w = sstep(1.25, 0.20, d);
          if (w > 0) occAmt += w * Math.min(1, h / 7) * 0.56;
        }
        if (this._cls[i] === C_WATER) {
          const w = sstep(1.00, 0.15, d);
          if (w > 0) occAmt += w * 0.12;
        }
      }
    }
    if (occAmt > 0.55) occAmt = 0.55;
    return 1 - occAmt;
  }

  // Mountain silhouette jitter — a pure function of (worldX, worldZ) so shared
  // corners between columns always agree (no cracks).
  _disp(wx, wz) {
    const a = vnoiseW(wx * 0.055, wz * 0.055, 771) - 0.5;
    const b = vnoiseW(wx * 0.170, wz * 0.170, 913) - 0.5;
    return (a * 1.25 + b * 0.45) * this.rugged;   // |d| < 0.85 keeps quads valid
  }

  // Snow mask (0..1) for a rock surface at world height y.
  _snowAt(wx, wz, y) {
    const j = (vnoiseW(wx * 0.09, wz * 0.09, 4441) - 0.5) * 3.0;
    return sstep(this.snowY0 + j, this.snowY1 + j, y);
  }

  _mtnH(state, x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return null;
    const i = z * N + x;
    if (state.map[i] !== T_MOUNTAIN) return 0;
    const h = state.variant ? state.variant[i] : 0;
    return this._mtnY(h > 0 ? h : 4);
  }

  // Mountain level -> world height. r8 (critic r7: "the grey mountain reads
  // as a flat stepped heap with a white blotch, not a rock formation"): the
  // sim's levels are a gentle cone (2..9 over ~23 tiles in the demo), which
  // at 4 units a level is a low mesa. Keep the foothills as they were and
  // steepen toward the summit (quadratic in the map's own level range), so a
  // range rises to a craggy peak with tall cliff steps near the top. The
  // summit gains at most MTN_PEAK_K x and never tops MTN_PEAK_MAX units.
  _mtnY(lv) {
    const mx = Math.max(4, this._mtnMax || 9);
    const k = Math.max(0, Math.min(MTN_PEAK_K, MTN_PEAK_MAX / (mx * MTN_VS) - 1));
    const t = Math.max(0, (lv - 2) / (mx - 2));
    return lv * MTN_VS * (1 + k * t * t);
  }

  // Bed height under a water tile (deeper offshore).
  _bedY(x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return this.borderY;
    const d = this._distLand[z * N + x];
    return BED_NEAR + (BED_FAR - BED_NEAR) * sstep(0.6, 4.5, d);
  }

  // Top surface height of a tile as seen from a neighbour (for skirts).
  _topY(state, x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return this.borderY;
    const i = z * N + x;
    if (this._cls[i] === C_WATER) return this.seabed ? this._bedY(x, z) : WATER_Y;
    if (state.map[i] === T_MOUNTAIN) {
      const h = state.variant && state.variant[i] > 0 ? state.variant[i] : 4;
      return this._mtnY(h);
    }
    return 0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  build(state) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._disposeChunks();
    this._computeFields(state);
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) this._buildChunk(state, cx, cz);
    }
    this._buildSkirt();
    this._dirty.clear();
    const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._lastBuildMs = t1 - t0;
    return this._lastBuildMs;
  }

  refreshTile(state, x, z) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._computeFields(state);
    const list = this._chunksFor(x, z);
    for (const [ax, az] of list) {
      this._disposeChunk(ax + ',' + az);
      this._buildChunk(state, ax, az);
    }
    // The skirt continues the class of the nearest border tile, so it only has
    // to be rebuilt when a border tile itself changed.
    if (x <= 1 || z <= 1 || x >= N - 2 || z >= N - 2) this._buildSkirt();
    for (const i of this._dirty) if (this._lotKey[i] === this._builtKey[i]) this._dirty.delete(i);
    const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._lastRefreshMs = t1 - t0;
    return this._lastRefreshMs;
  }

  /**
   * Engine hook: a building mesh was just added over tiles [x, x+w) x [z, z+d).
   * main.js does not refreshTile() on a 'placed' event, so without this a new
   * building would stand on bare grass until something else rebuilt its chunk.
   * Cheap and idempotent: only tiles whose lot key differs from what their
   * chunk was BUILT with are queued, and update() coalesces the rebuilds (a
   * full-city rebuildAllVisuals() therefore queues nothing — buildGround() ran
   * first against the same state).
   */
  /** Top of the ground at tile (x, z) for overlays (placement flash, ghost cells). */
  cellTopY(x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return 0;
    const k = this._lotKind[z * N + x];
    return (k === LK_VACANT || k === LK_PARCEL || k === LK_LAWN) ? LOT_TOP : k === LK_FOOT ? LOT_Y : 0;
  }

  /**
   * r10 engine hook: the height a 1x1 prop or deco item at tile (x, z) stands
   * on, relative to where it would stand on open grass. A sim tree / deco item
   * on a raised lawn plinth is lifted by the plinth's height.
   */
  lawnLift(x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return 0;
    const i = z * N + x;
    if (this._lotKind[i] !== LK_LAWN) return 0;
    // The kind may predate a building just placed here: only open lawn, a sim
    // tree or a deco item stands on the plinth top.
    const st = this._state, o = st && st.occ ? st.occ[i] : 0;
    if (o) {
      const bs = st.buildings;
      const b = Array.isArray(bs) ? bs.find((q) => q && q.bid === o) : null;
      if (!b || b.cat !== 'deco') return 0;
    }
    return LOT_TOP;
  }

  noteTiles(x, z, w, d) {
    const st = this._state;
    if (!st || !st.map) return;
    const bm = this._bmap(st), li = this._lotScratch;
    for (let tz = z; tz < z + (d || 1); tz++) {
      for (let tx = x; tx < x + (w || 1); tx++) {
        if (tx < 0 || tz < 0 || tx >= N || tz >= N) continue;
        const i = tz * N + tx;
        this._lotInfo(st, i, bm, li);
        if (li[1] !== this._builtKey[i]) this._dirty.add(i);
      }
    }
  }

  _flushDirty() {
    const st = this._state;
    if (!this._dirty.size || !st) return;
    this._computeFields(st);
    const keys = new Set();
    for (const i of this._dirty) {
      for (const [ax, az] of this._chunksFor(i % N, (i / N) | 0)) keys.add(ax + ',' + az);
    }
    this._dirty.clear();
    for (const k of keys) {
      const [ax, az] = k.split(',').map(Number);
      this._disposeChunk(k);
      this._buildChunk(st, ax, az);
    }
  }

  // Chunks a change at tile (x,z) can reach (its own + AO/blend bleed).
  _chunksFor(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const M = this.aoRadius;                     // blend/AO bleed, in tiles
    const list = [[cx, cz]];
    if (lx < M && cx > 0) list.push([cx - 1, cz]);
    if (lx >= CHUNK - M && cx < CHUNKS - 1) list.push([cx + 1, cz]);
    if (lz < M && cz > 0) list.push([cx, cz - 1]);
    if (lz >= CHUNK - M && cz < CHUNKS - 1) list.push([cx, cz + 1]);
    if (lx < M && lz < M && cx > 0 && cz > 0) list.push([cx - 1, cz - 1]);
    if (lx >= CHUNK - M && lz < M && cx < CHUNKS - 1 && cz > 0) list.push([cx + 1, cz - 1]);
    if (lx < M && lz >= CHUNK - M && cx > 0 && cz < CHUNKS - 1) list.push([cx - 1, cz + 1]);
    if (lx >= CHUNK - M && lz >= CHUNK - M && cx < CHUNKS - 1 && cz < CHUNKS - 1) list.push([cx + 1, cz + 1]);
    return list;
  }

  setWeather(w) {
    w = w || {};
    if (Array.isArray(w.tint)) {
      const v = this.uniforms.uTint.value;
      const r = typeof w.tint[0] === 'number' ? w.tint[0] : 1;
      const g = typeof w.tint[1] === 'number' ? w.tint[1] : 1;
      const b = typeof w.tint[2] === 'number' ? w.tint[2] : 1;
      if (v && v.setRGB) v.setRGB(r, g, b); else if (v && v.set) v.set(r, g, b);
    }
    if (typeof w.snow === 'number') this._targetSnow = clamp01(w.snow);
    if (typeof w.rain === 'number') this._targetWet = clamp01(w.rain);
  }

  setQuality(level) {
    this._quality = level | 0;
    const amt = this._quality <= 0 ? 0.45 : (this._quality === 1 ? 0.8 : 1.0);
    this.uniforms.uDetailAmt.value = amt;
    this.uniforms.uAOStrength.value = this._quality <= 0 ? 0.8 : 1.0;
  }

  update(dt, ctx) {
    if (this._dirty.size) this._flushDirty();
    if (!ctx) return;
    if (ctx.camera && ctx.camera.position) this.uniforms.uCamPos.value.copy(ctx.camera.position);
    if (typeof ctx.quality === 'number' && ctx.quality !== this._quality) this.setQuality(ctx.quality);
    if (typeof ctx.nightEff === 'number' && this.uniforms.uNight) {
      // Only drive it if engine.js did not hand us its own shared uniform.
      if (!this._sharedNight) this.uniforms.uNight.value = ctx.nightEff;
    }
    if (ctx.weather) {
      if (typeof ctx.weather.snow === 'number') this._targetSnow = clamp01(ctx.weather.snow);
      if (typeof ctx.weather.rain === 'number') this._targetWet = clamp01(ctx.weather.rain);
      if (Array.isArray(ctx.weather.tint)) this.setWeather({ tint: ctx.weather.tint });
    }
    // Snow / wetness ease in and out so weather changes never pop.
    const k = Math.min(1, (dt || 0.016) * 0.6);
    const ts = this._targetSnow || 0, tw = this._targetWet || 0;
    const u = this.uniforms;
    u.uSnowCover.value += (ts - u.uSnowCover.value) * k;
    u.uWetGlobal.value += (tw - u.uWetGlobal.value) * k;
  }

  dispose() {
    this._disposeChunks();
    this._disposeSkirt();
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    if (this.material) this.material.dispose();
    if (this.texDetail) this.texDetail.dispose();
    if (this.texRock) this.texRock.dispose();
    if (this.texMacro) this.texMacro.dispose();
    this.material = null;
    this._shader = null;
  }

  // -------------------------------------------------------------------------
  // Meshing
  // -------------------------------------------------------------------------

  _disposeChunk(key) {
    const c = this._chunks.get(key);
    if (!c) return;
    for (const m of [c.ground, c.rock, c.lots]) {
      if (!m) continue;
      this.group.remove(m);
      if (m.geometry) m.geometry.dispose();
    }
    this._chunks.delete(key);
  }

  _disposeChunks() {
    for (const key of Array.from(this._chunks.keys())) this._disposeChunk(key);
    this._chunks.clear();
  }

  // -------------------------------------------------------------------------
  // Horizon skirt
  // -------------------------------------------------------------------------
  // The 640x640 map used to simply STOP: at the region shot the terrain
  // silhouette was a hard straight diagonal with a constant-colour void behind
  // it (a literally flat fill, sigma 0.04/0.09/0.15), i.e. a slab floating in
  // nothing. This extends the ground outward as gently rolling lowland that
  // runs past engine.js's fog far plane — `fog.far = camDist * 4.2 + 224`, so
  // at most ~1820 world units at the 380 orbit cap — and therefore fades to
  // `fog.color` (the sky's own horizon sample) before it ever ends. The world
  // now has an edge that recedes instead of one that stops.

  // Graded coordinate axis: 0..640 across the map, then rings outward, dense
  // near the border (the only band that is not fully fogged) and sparse far.
  _skirtCoords() {
    const W = N * TILE;
    const R = this.skirtRadius;
    const out = [8, 20, 44, 92, 180, 340, 620, 1080, R];
    const c = [];
    for (let k = out.length - 1; k >= 0; k--) c.push(-out[k]);
    for (let i = 0; i <= 8; i++) c.push(W * i / 8);
    for (let k = 0; k < out.length; k++) c.push(W + out[k]);
    return c;
  }

  // Distance (world units) that (wx,wz) lies OUTSIDE the map box.
  _outDist(wx, wz) {
    const W = N * TILE;
    const dx = Math.max(0, -wx, wx - W);
    const dz = Math.max(0, -wz, wz - W);
    return Math.sqrt(dx * dx + dz * dz);
  }

  // Skirt height. Exactly `borderY` at the map boundary (which is where every
  // border cliff quad and every border bed wall already terminates, so the two
  // meet without a crack), then rolls away and down.
  _skirtY(wx, wz) {
    const d = this._outDist(wx, wz);
    const n = vnoiseW(wx * 0.0030, wz * 0.0030, 5309) * 0.66 +
              vnoiseW(wx * 0.0092, wz * 0.0092, 7717) * 0.34;
    // Stylised: the lawn simply continues, flat (a gentle roll far out only,
    // where the fog has it). Rolling hills near the border shaded the skirt
    // into a darker, mottled band around the map.
    const ramp = sstep(260, 900, d);
    // r8 (critic r7: "a thin outline marks the map square"): beside a LAND
    // border the skirt starts level with the lawn (y = 0) instead of at the
    // sunken borderY, so the border cliff hides under it and the field simply
    // runs on; it eases down to borderY further out. Water borders keep
    // borderY (the sea bed and the off-map sea need it).
    let tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
    if (tx < 0) tx = 0; else if (tx > N - 1) tx = N - 1;
    if (tz < 0) tz = 0; else if (tz > N - 1) tz = N - 1;
    const land = this._fieldsValid && this._cls[tz * N + tx] !== C_WATER;
    const base = land ? SKIRT_DROP * sstep(60, 200, d) : this.borderY;
    return base - d * 0.0015 - ramp * (2 + 10 * (1 - n));
  }

  // Blend weights + wet mask for a skirt vertex: continue whatever the nearest
  // border tile is (so an ocean edge does not become a green field one metre
  // past the border), then dissolve into generic lowland over ~420 units.
  _skirtWeights(wx, wz, out) {
    let tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
    if (tx < 0) tx = 0; else if (tx > N - 1) tx = N - 1;
    if (tz < 0) tz = 0; else if (tz > N - 1) tz = N - 1;
    const c = this._fieldsValid ? this._cls[tz * N + tx] : C_GRASS;
    if (c === C_WATER) {
      // Open water runs all the way out — it must NOT dissolve into grassland
      // 400 units past the shore. wet = 2 is the off-map "deep sea" flag the
      // shader reads (everything else clamps vMask.y to 0..1, so nothing that
      // already exists sees a difference).
      out[0] = 0; out[1] = 0.60; out[2] = 0.40; out[3] = 0;
      return 2;
    }
    let a;
    if (c === C_ROCK) a = [0.16, 0.00, 0.16, 0.68];
    else if (c === C_SAND) a = [0.14, 0.80, 0.06, 0.00];
    else if (c === C_DIRT) a = [0.96, 0.02, 0.02, 0.00];
    else a = [0.90, 0.03, 0.04, 0.03];
    const k = sstep(60, 420, this._outDist(wx, wz));
    const L = [0.93, 0.02, 0.04, 0.01];   // generic lowland far out
    for (let i = 0; i < 4; i++) out[i] = a[i] + (L[i] - a[i]) * k;
    return 0;
  }

  _buildSkirt() {
    this._disposeSkirt();
    if (!this.skirt) return null;
    const W = N * TILE;
    const cs = this._skirtCoords();
    const M = cs.length;
    const pos = [], nrm = [], terr = [], mask = [], idx = [];
    const t = [0, 0, 0, 0];
    const H = 24;   // central-difference step for the analytic normal
    for (let j = 0; j < M; j++) {
      const wz = cs[j];
      for (let i = 0; i < M; i++) {
        const wx = cs[i];
        pos.push(wx, this._skirtY(wx, wz), wz);
        const gx = (this._skirtY(wx + H, wz) - this._skirtY(wx - H, wz)) / (2 * H);
        const gz = (this._skirtY(wx, wz + H) - this._skirtY(wx, wz - H)) / (2 * H);
        const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        nrm.push(-gx * il, il, -gz * il);
        const wet = this._skirtWeights(wx, wz, t);
        terr.push(t[0], t[1], t[2], t[3]);
        mask.push(1, wet, 0, 0);
      }
    }
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < M - 1; i++) {
        // The map interior is owned by the chunk meshes.
        if (cs[i] >= 0 && cs[i + 1] <= W && cs[j] >= 0 && cs[j + 1] <= W) continue;
        const a = j * M + i, b = (j + 1) * M + i;
        const c = (j + 1) * M + i + 1, d = j * M + i + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    const geo = this._makeGeometry(pos, nrm, terr, mask, idx);
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'terrain-skirt';
    // Never a caster: it would push every cascade's frustum out to 2400 units
    // and destroy the shadow resolution over the city for zero visual gain.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this._skirt = mesh;
    return mesh;
  }

  _disposeSkirt() {
    if (!this._skirt) return;
    this.group.remove(this._skirt);
    if (this._skirt.geometry) this._skirt.geometry.dispose();
    this._skirt = null;
  }

  _buildChunk(state, cx, cz) {
    const S = this.sub;
    const step = TILE / S;
    const x0t = cx * CHUNK, z0t = cz * CHUNK;
    const x1t = Math.min(N, x0t + CHUNK), z1t = Math.min(N, z0t + CHUNK);
    const tw = x1t - x0t, td = z1t - z0t;

    // ===== Ground: one shared indexed grid (water + mountain tiles are holes)
    const gw = tw * S + 1, gd = td * S + 1;
    const nv = gw * gd;
    const gPos = [], gNrm = [], gTerr = [], gMask = [], gIdx = [];
    const blend = [0, 0, 0, 0];

    const wp = this._wp;
    for (let j = 0; j < gd; j++) {
      const v = z0t + j / S;
      for (let i = 0; i < gw; i++) {
        const u = x0t + i / S;
        this._warp(u * TILE, v * TILE, wp);
        // The swash slope is evaluated at the WARPED position, exactly like the
        // bank tops in wallStrip() below, so the two always agree.
        gPos.push(wp[0], -this._shoreDip(wp[0], wp[1]), wp[1]);
        // Deliberately left at (0,1,0): the ramp is ~2 degrees, which is below
        // the shader's own normal perturbation, and an exact up-normal is what
        // selfTest()'s fold check keys on.
        gNrm.push(0, 1, 0);
        // Material weights are sampled at the UNWARPED lattice coords, so the
        // grass/sand/road bands travel with the geometry — warp the vertex and
        // the band it carries meanders with it. Contact AO is sampled at the
        // WARPED position instead: it has to stay under the building that
        // casts it, not slide with the shoreline.
        this._blendAt(u, v, blend);
        const dw = this._bilin(this._distWater, u, v);
        this._beach(u, v, dw, blend);
        gTerr.push(blend[0], blend[1], blend[2], blend[3]);
        const ao = this._aoAt(wp[0] / TILE, wp[1] / TILE);
        gMask.push(ao, this._wetAt(u, v, dw), 0, 0);
      }
    }
    // Quads, skipping water + mountain tiles.
    for (let tz = z0t; tz < z1t; tz++) {
      for (let tx = x0t; tx < x1t; tx++) {
        const ti = tz * N + tx;
        const c = this._cls[ti];
        if (c === C_WATER || c === C_ROCK) continue;
        const bi = (tx - x0t) * S, bj = (tz - z0t) * S;
        for (let sj = 0; sj < S; sj++) {
          for (let si = 0; si < S; si++) {
            const a = (bj + sj) * gw + (bi + si);
            const b = (bj + sj + 1) * gw + (bi + si);
            const cc = (bj + sj + 1) * gw + (bi + si + 1);
            const d = (bj + sj) * gw + (bi + si + 1);
            gIdx.push(a, b, cc, a, cc, d);
          }
        }
      }
    }

    // ===== Loose quads appended after the grid: banks, seabed, border cliffs
    let next = nv;
    const pushV = (x, y, z, nx, ny, nz, t, m) => {
      gPos.push(x, y, z); gNrm.push(nx, ny, nz);
      gTerr.push(t[0], t[1], t[2], t[3]);
      gMask.push(m[0], m[1], m[2], m[3]);
      return next++;
    };
    // A vertical wall along a tile edge, from (ax,az) to (bx,bz), subdivided
    // into `S` columns and warped through _warp() exactly like the ground
    // lattice. The subdivision is not cosmetic: the ground grid runs at
    // TILE/S, so a full-tile chord would leave the lattice midpoint hanging
    // off it and the shoreline warp would tear that T-junction open into a
    // crack as wide as the displacement.
    // `dipTop` makes the strip's TOP edge follow the swash slope (_shoreDip) at
    // each subdivided point instead of sitting flat at yTop. The ground lattice
    // does the same at the same world positions, so the seam stays welded.
    const wallStrip = (ax, az, bx, bz, yBot, yTop, nx, nz, t, mBot, mTop, dipTop) => {
      let px = 0, pz = 0, pTop = yTop;
      for (let k = 0; k <= S; k++) {
        const f = k / S;
        this._warp(ax + (bx - ax) * f, az + (bz - az) * f, wp);
        const qx = wp[0], qz = wp[1];
        const qTop = dipTop ? yTop - this._shoreDip(qx, qz) : yTop;
        if (k > 0) {
          const ia = pushV(px, yBot, pz, nx, 0, nz, t, mBot);
          const ib = pushV(qx, yBot, qz, nx, 0, nz, t, mBot);
          const ic = pushV(qx, qTop, qz, nx, 0, nz, t, mTop);
          const id = pushV(px, pTop, pz, nx, 0, nz, t, mTop);
          gIdx.push(ia, ib, ic, ia, ic, id);
        }
        px = qx; pz = qz; pTop = qTop;
      }
    };
    // A flat S x S patch on the same lattice (sea/lake bed tops), likewise
    // warped so it stays welded to the bank strips around it.
    const flatPatch = (px0, pz0, y, t, m) => {
      const base = next;
      for (let j = 0; j <= S; j++) {
        for (let i = 0; i <= S; i++) {
          this._warp(px0 + i * step, pz0 + j * step, wp);
          pushV(wp[0], y, wp[1], 0, 1, 0, t, m);
        }
      }
      const R = S + 1;
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const a = base + j * R + i, b = base + (j + 1) * R + i;
          const c = base + (j + 1) * R + i + 1, d = base + j * R + i + 1;
          gIdx.push(a, b, c, a, c, d);
        }
      }
    };

    const T_BANK = [0, 0.86, 0.14, 0];      // damp sand bank (was 0.55 sand /
                                            // 0.45 dirt, i.e. mud, which is
                                            // what made it read as a black rim)
    const T_CLIFF = [1, 0, 0, 0];           // map-border face: lawn-coloured,
                                            // so the edge melts into the skirt
    const T_BED = [0, 0.62, 0.38, 0];

    for (let tz = z0t; tz < z1t; tz++) {
      for (let tx = x0t; tx < x1t; tx++) {
        const ti = tz * N + tx;
        const c = this._cls[ti];
        const wx0 = tx * TILE, wx1 = wx0 + TILE;
        const wz0 = tz * TILE, wz1 = wz0 + TILE;

        if (c === C_WATER) {
          // Sea/lake bed (below the water surface owned by water.js).
          if (this.seabed) {
            const y = this._bedY(tx, tz);
            const aoB = 0.62 + 0.30 * sstep(0.5, 5.0, this._distLand[ti]);
            const mm = [aoB, 1, 0, 0];
            flatPatch(wx0, wz0, y, T_BED, mm);
            // Bed step walls toward deeper neighbours so there are no gaps.
            const nb = [[1, 0], [-1, 0], [0, -1], [0, 1]];
            for (const [dx, dz] of nb) {
              const nx = tx + dx, nz = tz + dz;
              let ny;
              if (nx < 0 || nz < 0 || nx >= N || nz >= N) ny = this.borderY;
              else if (this._cls[nz * N + nx] === C_WATER) ny = this._bedY(nx, nz);
              else continue;
              if (ny >= y - 1e-4) continue;
              const mLo = [0.55, 1, 0, 0];
              if (dx === 1) wallStrip(wx1, wz1, wx1, wz0, ny, y, 1, 0, T_BED, mLo, mm);
              else if (dx === -1) wallStrip(wx0, wz0, wx0, wz1, ny, y, -1, 0, T_BED, mLo, mm);
              else if (dz === -1) wallStrip(wx1, wz0, wx0, wz0, ny, y, 0, -1, T_BED, mLo, mm);
              else wallStrip(wx0, wz1, wx1, wz1, ny, y, 0, 1, T_BED, mLo, mm);
            }
          }
          continue;
        }

        if (c === C_ROCK) continue;   // handled by the rock pass

        // Land tile: skirts wherever a neighbour is lower (water bank / border).
        const topY = 0;
        const sides = [
          [1, 0, this._topY(state, tx + 1, tz)],
          [-1, 0, this._topY(state, tx - 1, tz)],
          [0, -1, this._topY(state, tx, tz - 1)],
          [0, 1, this._topY(state, tx, tz + 1)],
        ];
        for (const [dx, dz, lowY] of sides) {
          if (lowY >= topY - 1e-4) continue;
          const border = (tx + dx < 0 || tz + dz < 0 || tx + dx >= N || tz + dz >= N);
          const tt = border ? T_CLIFF : T_BANK;
          // Dark at the foot, lighter at the lip — reads as a real bank.
          //
          // A reviewer saw "a pure-black vertical bank wall with a hard black
          // outline" along the north shore. Three things stacked up: this face
          // is authored fully WET (the darkest albedo in the palette), it
          // carried a 0.45 contact-AO cut, and being vertical it got zero of
          // the sky-bounce term. The bounce weight is fixed in thTerrain(); the
          // other two are here — the AO eases off (a bank is an exposed
          // convex face, not a crevice) and only its foot stays soaked.
          //
          // With the swash slope in, a water bank's top edge is dragged down to
          // ~WATER_Y, so the whole face is submerged and it is the up-facing
          // beach ramp above it that the camera sees. Author it fully wet
          // (it is) and drop the contact-AO cut that used to bruise it: the
          // AO belongs to the crevice at the foot, not to the whole wall.
          const mBot = border ? [0.55, 1, 0, 0] : [0.86, 1.00, 0, 0];
          const mTop = border ? [0.88, 0, 0, 0] : [0.98, 0.92, 0, 0];
          const dip = !border;
          if (dx === 1) wallStrip(wx1, wz1, wx1, wz0, lowY, topY, 1, 0, tt, mBot, mTop, dip);
          else if (dx === -1) wallStrip(wx0, wz0, wx0, wz1, lowY, topY, -1, 0, tt, mBot, mTop, dip);
          else if (dz === -1) wallStrip(wx1, wz0, wx0, wz0, lowY, topY, 0, -1, tt, mBot, mTop, dip);
          else wallStrip(wx0, wz1, wx1, wz1, lowY, topY, 0, 1, tt, mBot, mTop, dip);
        }
      }
    }

    const groundGeo = this._makeGeometry(gPos, gNrm, gTerr, gMask, gIdx);
    let ground = null;
    if (groundGeo) {
      ground = new THREE.Mesh(groundGeo, this.material);
      ground.name = 'terrain-ground-' + cx + ',' + cz;
      ground.castShadow = false;
      ground.receiveShadow = true;
      ground.matrixAutoUpdate = false;
      ground.updateMatrix();
      this.group.add(ground);
    }

    // ===== Rock pass (mountains) — separate mesh so it can cast shadows.
    const rock = this._buildRock(state, x0t, z0t, x1t, z1t, cx, cz);

    // ===== Lot plinths — raised concrete pads under every building.
    const lots = this._buildLots(state, x0t, z0t, x1t, z1t, cx, cz);

    this._chunks.set(cx + ',' + cz, { ground, rock, lots });
  }

  // -------------------------------------------------------------------------
  // Mountains: stepped voxel rock (ref06). Flat caps at the column's integer
  // height, flat walls, a per-column grey tone so the steps read, chunky
  // sub-blocks on the caps for an irregular silhouette, and whole-block snow
  // caps (top white + a white lip down the side) above the snow line.
  // -------------------------------------------------------------------------
  // Wave-2 r1 (coherence: "mountains are flat grey blocks with near-black
  // sides … no hue; reads as unfinished next to the lime field"). The range
  // is now meshed on a HALF-TILE grid (4-unit cells): each cell samples its
  // tile's height bilinearly a quarter of the way toward its neighbours and
  // snaps to 2-unit steps, so every level change becomes two terraces and the
  // silhouette reads as ref06's stepped rock instead of 8x8 grey towers. A
  // hash adds the odd crag / notch. Colour is authored per face through
  // aPaint (STONE strata: warm earthy stone at the foot, warm grey, then a
  // cool blue-grey under the snow, alternating light/dark bands every step),
  // foothill terraces and some ledges wear the field's own grass with a lip
  // down the riser, the summit terraces are snow with a snow lip. The shade
  // side is lifted by uRockFill in the shader so it stays colourful.
  _rockSubH(state, sx, sz, memo) {
    const key = sz * 4096 + sx;
    if (memo.has(key)) return memo.get(key);
    const tx = sx >> 1, tz = sz >> 1;
    const h = this._mtnH(state, tx, tz);
    let q;
    if (h === null) {
      // OFF-MAP APRON: sim ranges hug the map corners, so every range was cut
      // by the border into a sheer cliff down to the skirt. Continue the
      // range past the border instead, stepping down to the skirt lawn over
      // ~6-10 tiles, so the mountain reads as a whole landform in iso-wide.
      const M = N * 2;
      const csx = sx < 0 ? 0 : sx >= M ? M - 1 : sx, csz = sz < 0 ? 0 : sz >= M ? M - 1 : sz;
      const qe = this._rockSubH(state, csx, csz, memo);
      if (!qe) q = 0;
      else {
        const d = Math.max(Math.abs(sx - csx), Math.abs(sz - csz));
        const D = 12 + 8 * vnoiseW(sx * 0.13, sz * 0.13, 2203);
        const st = MTN_SUB;
        q = Math.round(qe * Math.max(0, 1 - d / D) * (1 - 0.35 * Math.min(1, d / D)) / st) * st;
        const r = hash2(sx, sz, 6607);
        if (q > st * 2) { if (r < 0.06) q += st; else if (r > 0.95) q -= st; }
        if (q < st) q = 0;
      }
    }
    else if (h <= 0) q = 0;
    else {
      const dx = (sx & 1) ? 1 : -1, dz = (sz & 1) ? 1 : -1;
      const g = (x, z) => { const v = this._mtnH(state, x, z); return v === null ? h : v; };
      const v = h * 0.5625 + (g(tx + dx, tz) + g(tx, tz + dz)) * 0.1875 + g(tx + dx, tz + dz) * 0.0625;
      const st = MTN_SUB;
      q = Math.round(v / st) * st;
      const r = hash2(sx, sz, 6607);
      if (q > st * 2) { if (r < 0.06) q += st; else if (r > 0.95) q -= st; }
      q = Math.max(st, q);
    }
    memo.set(key, q);
    return q;
  }

  _stone(y, hTop) {
    // strata: band index every MTN_SUB units, zone by height fraction
    const t = hTop > 0 ? y / hTop : 0;
    const band = Math.floor(y / (MTN_SUB * 2) + 1e-4);
    const z = t < 0.18 ? STONE.earth : t < 0.55 ? STONE.warm : STONE.cool;
    return z[band & 1];
  }

  _buildRock(state, x0t, z0t, x1t, z1t, cx, cz) {
    const B = new GeoBuf();
    const TR = [0, 0, 0, 1], TG = [1, 0, 0, 0];
    const LIP = 1.2, GLIP = 0.7;
    const st = MTN_SUB;
    const memo = new Map();
    const H = (sx, sz) => this._rockSubH(state, sx, sz, memo);
    const peak = Math.max(8, this._mtnY(Math.max(4, this._mtnMax || 9)));
    const sl = Math.max(6, Math.min(this.snowLevel, this._mtnMax - 2));
    const snowH = this._mtnY(sl) - st * 0.5;
    const grassH = this._mtnY(2) + 0.1;
    // Height where a neighbour cell's wall should stop (ground / bed / border).
    const baseOf = (nsx, nsz, nh) => {
      if (nh === null) return this.borderY;
      if (nh > 0) return nh;
      const ntx = nsx >> 1, ntz = nsz >> 1;
      if (ntx < 0 || ntz < 0 || ntx >= N || ntz >= N) return Math.min(0, skirtLandY(nsx * 4 + 2, nsz * 4 + 2)) - 0.05;
      if (this._cls[ntz * N + ntx] === C_WATER) return this.seabed ? this._bedY(ntx, ntz) : WATER_Y;
      return 0;
    };
    const S = 4;   // world units per cell
    // Border chunks also mesh the off-map apron (see _rockSubH).
    const AP = MTN_APRON * 2;
    const sx0 = x0t === 0 ? -AP : x0t * 2, sx1 = x1t === N ? N * 2 + AP : x1t * 2;
    const sz0 = z0t === 0 ? -AP : z0t * 2, sz1 = z1t === N ? N * 2 + AP : z1t * 2;
    for (let sz = sz0; sz < sz1; sz++) {
      for (let sx = sx0; sx < sx1; sx++) {
        // an off-map cell belongs to this chunk only along its own border span
        if ((sx < 0 || sx >= N * 2) && (sz >= 0 && sz < N * 2) && (sz < z0t * 2 || sz >= z1t * 2)) continue;
        if ((sz < 0 || sz >= N * 2) && (sx >= 0 && sx < N * 2) && (sx < x0t * 2 || sx >= x1t * 2)) continue;
        const q = H(sx, sz);
        if (!q) continue;
        const wx0 = sx * S, wx1 = wx0 + S, wz0 = sz * S, wz1 = wz0 + S;
        const tone = 0.30 + 0.40 * hash2(sx, sz, 1777);
        const snowy = q >= snowH + (hash2(sx, sz, 4441) - 0.5) * st * 1.2 ? 1 : 0;
        const hg = hash2(sx >> 1, sz >> 1, 5153);
        // green lower slopes thinning out with height (tile-clustered ledges)
        const tq = q / peak;
        const grassy = !snowy && (q <= grassH || (q <= grassH + st * 1.5 && hg < 0.6) ||
          hash2(sx >> 1, sz >> 1, 8123) < 0.62 * (1 - sstep(0.12, 0.50, tq)));
        const capCol = this._stone(q - 0.01, peak);
        // cap, with AO in corners that meet a taller cell
        const cAO = (dx, dz) => {
          const a = H(sx + dx, sz), b = H(sx, sz + dz), d = H(sx + dx, sz + dz);
          let n = 0;
          if (a !== null && a > q) n++;
          if (b !== null && b > q) n++;
          if (d !== null && d > q && n === 0) n = 0.6;
          return 1 - Math.min(0.34, n * 0.2);
        };
        const m00 = cAO(-1, -1), m01 = cAO(-1, 1), m11 = cAO(1, 1), m10 = cAO(1, -1);
        const capPaint = (snowy || grassy) ? null : capCol;
        B.quad([[wx0, q, wz0], [wx0, q, wz1], [wx1, q, wz1], [wx1, q, wz0]], [0, 1, 0],
          grassy ? TG : TR,
          [[m00, 0, snowy, tone], [m01, 0, snowy, tone], [m11, 0, snowy, tone], [m10, 0, snowy, tone]], capPaint);

        // walls (+X, -X, -Z, +Z) down to each lower neighbour, cut into strata bands
        const walls = [
          [sx + 1, sz, [wx1, wz1], [wx1, wz0], [1, 0, 0]],
          [sx - 1, sz, [wx0, wz0], [wx0, wz1], [-1, 0, 0]],
          [sx, sz - 1, [wx1, wz0], [wx0, wz0], [0, 0, -1]],
          [sx, sz + 1, [wx0, wz1], [wx1, wz1], [0, 0, 1]],
        ];
        for (const [nsx, nsz, a, b, n] of walls) {
          const nh = H(nsx, nsz);
          const bY = baseOf(nsx, nsz, nh);
          if (bY >= q - 1e-4) continue;
          const onRock = nh !== null && nh > 0;
          const lip = snowy ? LIP : grassy ? GLIP : 0;
          const top = Math.max(bY, q - lip);
          // strata bands from the foot to the lip
          let y = bY;
          while (y < top - 1e-4) {
            const yb = Math.max(y, 0);
            const next = Math.min(top, (Math.floor(yb / st + 1e-4) + 1) * st);
            const ao0 = y === bY ? (onRock ? 0.84 : 0.80) : 1;
            const col = this._stone(Math.max(0.01, (y + next) * 0.5), peak);
            B.quad([[a[0], y, a[1]], [b[0], y, b[1]], [b[0], next, b[1]], [a[0], next, a[1]]], n, TR,
              [[ao0, 0, 0, tone], [ao0, 0, 0, tone], [1, 0, 0, tone], [1, 0, 0, tone]], col);
            y = next;
          }
          if (top < q) {
            // snow lip (mask) or a painted turf lip, so the rock fill keeps
            // the shade-side lip a clear green instead of a black outline
            B.quad([[a[0], top, a[1]], [b[0], top, b[1]], [b[0], q, b[1]], [a[0], q, a[1]]], n,
              TR, [1, 0, snowy, tone], snowy ? null : STONE.turf[0]);
          }
        }

        // the odd boulder on a bare rock ledge
        if (!grassy && !snowy) {
          const r = hash2(sx, sz, 991);
          if (r < 0.08) {
            const hs = (k) => hash2(sx * 7 + k, sz * 13 - k, 211);
            const bx = 1.2 + Math.floor(hs(1) * 2) * 0.6, bz = 1.2 + Math.floor(hs(2) * 2) * 0.6;
            const by = 0.8 + Math.floor(hs(3) * 2) * 0.6;
            const ox = 0.3 + hs(4) * (S - bx - 0.6), oz = 0.3 + hs(5) * (S - bz - 0.6);
            this._box(B, wx0 + ox, q, wz0 + oz, bx, by, bz, TR, tone, 0, LIP, this._stone(q + 1.0, peak));
          }
        }
      }
    }
    const geo = B.geometry(this);
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'terrain-rock-' + cx + ',' + cz;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    return mesh;
  }

  // An axis-aligned rock box standing on y0 (top + 4 walls, no bottom).
  _box(B, x0, y0, z0, sx, sy, sz, T, tone, snowy, lip, pc) {
    const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
    B.quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], T, [1, 0, snowy, tone], snowy ? null : pc);
    const split = snowy && sy > lip + 0.2 ? y1 - lip * 0.8 : y1;
    const walls = [
      [[x1, z1], [x1, z0], [1, 0, 0]], [[x0, z0], [x0, z1], [-1, 0, 0]],
      [[x1, z0], [x0, z0], [0, 0, -1]], [[x0, z1], [x1, z1], [0, 0, 1]],
    ];
    for (const [a, b, n] of walls) {
      B.quad([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], split, b[1]], [a[0], split, a[1]]], n, T,
        [[0.72, 0, 0, tone], [0.72, 0, 0, tone], [1, 0, 0, tone], [1, 0, 0, tone]], pc);
      if (split < y1) B.quad([[a[0], split, a[1]], [b[0], split, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], n, T, [1, 0, 1, tone]);
    }
  }

  // -------------------------------------------------------------------------
  // Lots (ref05). Kinds, see LOT_PAL:
  //   LK_FOOT   — the footing under a building: a plain lotSide block LOT_Y
  //               tall. The model's own lotPlinth sits on it, so together they
  //               read as one clear side band under a light rim.
  //   LK_VACANT — empty tiles inside a city block. _partitionLots() merges
  //               them into RECTS (1x1, 2x1, 1x2, 2x2) and gives each rect one
  //               plinth at the same height as a building lot (LOT_TOP), one
  //               light rim around the whole rect, and one dressed top picked
  //               from the neighbourhood around it: parking with bays and
  //               cars, a market square, allotments / crop rows, a town park,
  //               a sports court or pitch, a plaza, a pool deck, a yard …
  //               (r2 critic: "every lot is the same … in ref05 the lots are
  //               large, crisply rimmed plinths with varied, readable surfaces
  //               that carry about half the image's detail".)
  //   verge     — kind 0 land tiles touching a road get a light concrete KERB
  //               band on the road side (r2 critic: "terrain meets the road
  //               … with no kerb or lot rim, so the city reads as a slab
  //               pasted onto a green sheet").
  // -------------------------------------------------------------------------
  _buildLots(state, x0t, z0t, x1t, z1t, cx, cz) {
    const B = new GeoBuf();
    const kindA = this._lotKind, keyA = this._lotKey;
    const T = [1, 0, 0, 0], UP = [0, 1, 0];
    const P = LOT_RGB;
    const yB = -0.05;
    const kindAt = (x, z) => (x < 0 || z < 0 || x >= N || z >= N) ? 0 : kindA[z * N + x];
    const topOf = (k) => (k === LK_VACANT || k === LK_PARCEL || k === LK_LAWN) ? LOT_TOP : k === LK_FOOT ? LOT_Y : 0;
    const sideM = [[0.70, 0, 0, 0], [0.70, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const flatM = [1, 0, 0, 0];
    // A vertical face from (ax,az) to (bx,bz), y0..y1, outward normal n.
    const wall = (ax, az, bx, bz, y0, y1, n, col, m) => {
      B.quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], n, T, m || sideM, col);
    };
    const seed = (state.seed >>> 0) || 1;
    for (const o of this.lotCars.keys()) {           // this chunk re-dresses its rects
      const ox = o % N, oz = (o / N) | 0;
      if (ox >= x0t && ox < x1t && oz >= z0t && oz < z1t) { this.lotCars.delete(o); this.lotCarsVersion++; }
    }

    for (let tz = z0t; tz < z1t; tz++) {
      for (let tx = x0t; tx < x1t; tx++) {
        const i = tz * N + tx;
        this._builtKey[i] = keyA[i];
        const kind = kindA[i];
        if (!kind) {
          const vm = this._verge[i];
          if (vm && VERGE_KERB) this._vergeKerb(B, tx, tz, vm);
          continue;
        }
        if (kind === LK_LAWN) { this._lawnTile(B, tx, tz); continue; }
        const wx0 = tx * TILE, wx1 = wx0 + TILE, wz0 = tz * TILE, wz1 = wz0 + TILE;
        const top = topOf(kind);
        // Outer faces wherever the neighbour stands lower.
        const nbs = [
          [kindAt(tx + 1, tz), wx1, wz1, wx1, wz0, [1, 0, 0]],
          [kindAt(tx - 1, tz), wx0, wz0, wx0, wz1, [-1, 0, 0]],
          [kindAt(tx, tz - 1), wx1, wz0, wx0, wz0, [0, 0, -1]],
          [kindAt(tx, tz + 1), wx0, wz1, wx1, wz1, [0, 0, 1]],
        ];
        for (const [nk, ax, az, bx, bz, n] of nbs) {
          if (kind === LK_GREEN) break;
          const lo = nk ? topOf(nk) : yB;
          if (lo >= top - 1e-4) continue;
          if (kind === LK_VACANT || kind === LK_PARCEL) {
            const yr = top - LOT_RIM_H;
            // r7: grey kerb band over a clearly darker grey side (ref05).
            if (lo < yr) wall(ax, az, bx, bz, lo, yr, n, P.curbSide);
            wall(ax, az, bx, bz, Math.max(lo, yr), top + LOT_KERB_H, n, P.curb, flatM);
          } else {
            wall(ax, az, bx, bz, lo, top, n, P.side);
          }
        }
        if (kind === LK_GREEN) {
          // Flush on the field: no plinth, no rim — only the design's props.
          const r = this._rectAt[i];
          if (r && r.o === i) this._vacantRect(B, state, r, seed);
          continue;
        }
        if (kind === LK_FOOT) {
          B.quad([[wx0, top, wz0], [wx0, top, wz1], [wx1, top, wz1], [wx1, top, wz0]], UP, T, flatM, P.seam);
          continue;
        }
        // Vacant: the rect's ORIGIN tile dresses the whole rect (it may reach
        // into the next chunk; the key of every tile in the rect encodes the
        // rect, so any change rebuilds both chunks).
        const r = this._rectAt[i];
        if (r && r.o === i) this._vacantRect(B, state, r, seed);
      }
    }
    const geo = B.geometry(this);
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'terrain-lots-' + cx + ',' + cz;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    return mesh;
  }

  // r10 LAWN PLINTH tile: the field grass itself (unpainted, so it is the
  // meadow's exact colour and drift) lifted to LOT_TOP, with the vacant lots'
  // grey concrete kerb ring and darker side band wherever the ground next to
  // it is lower (road, sand, water, open field). Next to a building footing or
  // another lot (same top) it runs straight on, so a building's own plinth rim
  // is not doubled. The kerb is traced per tile: straight bands on the low
  // edges, trimmed inner faces at outer corners, a filler square at inner
  // corners and a cap where a band stops against a building lot.
  _lawnTile(B, tx, tz) {
    const P = LOT_RGB, T = [1, 0, 0, 0], UP = [0, 1, 0];
    const kindA = this._lotKind, cls = this._cls;
    const top = LOT_TOP, K = top + LOT_KERB_H, R = LOT_RIM_W, yr = top - LOT_RIM_H, H = TILE / 2;
    const inb = (x, z) => x >= 0 && z >= 0 && x < N && z < N;
    const low = (x, z) => { if (!inb(x, z)) return true; const k = kindA[z * N + x]; return k === 0 || k === LK_GREEN; };
    const isLawn = (x, z) => inb(x, z) && kindA[z * N + x] === LK_LAWN;
    const loY = (x, z) => (!inb(x, z)) ? this.borderY : cls[z * N + x] === C_WATER ? WATER_Y - 0.25 : -0.05;
    const flatM = [1, 0, 0, 0];
    const sideM = [[0.70, 0, 0, 0], [0.70, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const IN = [[0.66, 0, 0, 0], [0.66, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const cx = (tx + 0.5) * TILE, cz = (tz + 0.5) * TILE;
    // the lawn: unpainted field grass (paint weight 0)
    B.quad([[cx - H, top, cz - H], [cx - H, top, cz + H], [cx + H, top, cz + H], [cx + H, top, cz - H]], UP, T, flatM);
    // a vertical face between world points a, b from y0 to y1, facing n
    const face = (ax, az, bx, bz, y0, y1, n, col, m) =>
      B.quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], n, T, m, col);
    const band = (ax0, az0, ax1, az1) => {
      const x0 = Math.min(ax0, ax1), x1 = Math.max(ax0, ax1), z0 = Math.min(az0, az1), z1 = Math.max(az0, az1);
      B.quad([[x0, K, z0], [x0, K, z1], [x1, K, z1], [x1, K, z0]], UP, T, flatM, P.curb);
    };
    const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (const [ox, oz] of DIRS) {
      if (!low(tx + ox, tz + oz)) continue;
      const px = -oz, pz = ox;                          // tangent
      // local (s along the edge, d inward from it) -> world
      const W = (sv, d) => [cx + ox * (H - d) + px * sv, cz + oz * (H - d) + pz * sv];
      // outer wall: dark side band, then the light kerb band on top
      const lo = loY(tx + ox, tz + oz);
      const a = W(-H, 0), b = W(H, 0), n = [ox, 0, oz];
      if (lo < yr) face(a[0], a[1], b[0], b[1], lo, yr, n, P.curbSide, sideM);
      face(a[0], a[1], b[0], b[1], Math.max(lo, yr), K, n, P.curb, flatM);
      // kerb top
      const c = W(H, R);
      band(a[0], a[1], c[0], c[1]);
      // inner face, trimmed where the perpendicular edge is low (outer corner)
      const lowL = low(tx - px, tz - pz), lowR = low(tx + px, tz + pz);
      const sa = lowL ? -H + R : -H, sb = lowR ? H - R : H;
      const ia = W(sa, R), ib = W(sb, R);
      face(ia[0], ia[1], ib[0], ib[1], top, K, [-ox, 0, -oz], P.curbSide, IN);
      // end caps where the band stops against a building / lot of the same top
      for (const e of [-1, 1]) {
        const nx = tx + px * e, nz = tz + pz * e;
        if (low(nx, nz)) continue;                      // outer corner: the other band covers it
        if (isLawn(nx, nz) && (low(nx + ox, nz + oz) || isLawn(nx + ox, nz + oz))) continue;   // runs on / turns
        const p0 = W(H * e, 0), p1 = W(H * e, R);
        face(p0[0], p0[1], p1[0], p1[1], top, K, [px * e, 0, pz * e], P.curbSide, IN);
      }
    }
    // inner (concave) corners: both neighbours lawn, the diagonal low
    for (const ax of [-1, 1]) {
      for (const az of [-1, 1]) {
        if (!isLawn(tx + ax, tz) || !isLawn(tx, tz + az) || !low(tx + ax, tz + az)) continue;
        const X = cx + ax * H, Z = cz + az * H;         // the shared corner point
        const Xi = X - ax * R, Zi = Z - az * R;
        band(X, Z, Xi, Zi);
        face(Xi, Z, Xi, Zi, top, K, [-ax, 0, 0], P.curbSide, IN);
        face(X, Zi, Xi, Zi, top, K, [0, 0, -az], P.curbSide, IN);
      }
    }
    this._lawnPark(B, tx, tz, low);
  }

  // r11 lawn park dressing (lawnPark plan): tan footpaths centre to centre,
  // a paved hub with a fountain or gazebo, flower beds along the paths,
  // picnic spots on worn dirt. Groves / clearings are planted by props.js.
  _lawnPark(B, tx, tz, low) {
    const lp = this._lpark;
    if (!lp) return;
    const i = tz * N + tx, pb = lp.path[i], zn = lp.zone[i];
    if (!pb && zn !== LZ_HUB && zn !== LZ_FLOWER && zn !== LZ_PICNIC) return;
    const P = LOT_RGB, T = [1, 0, 0, 0], UP = [0, 1, 0], flatM = [1, 0, 0, 0];
    const AOB = [[0.62, 0, 0, 0], [0.62, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const top = LOT_TOP, K = top + LOT_KERB_H, R = LOT_RIM_W, H = TILE / 2, E = 0.012;
    const cx = (tx + 0.5) * TILE, cz = (tz + 0.5) * TILE;
    const fl = (x0, z0, x1, z1, y, col) => B.quad([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], UP, T, flatM, col);
    const box = (x0, z0, x1, z1, y0, y1, col, topCol) => {
      B.quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], UP, T, flatM, topCol || col);
      B.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], T, AOB, col);
      B.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], T, AOB, col);
      B.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], T, AOB, col);
      B.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], T, AOB, col);
    };
    const hh = (k) => hash2(tx * 13 + k, tz * 7 - k, 0x2f1d);
    const FLW = [P.red, P.white, P.yellow, P.blue, P.pink, P.orange];
    // a kerbed flower bed: soil with a checker of blooms and leaves
    const fbed = (x0, z0, x1, z1, k) => {
      box(x0, z0, x1, z1, top, top + 0.2, P.curb, P.flowerBed);
      const c = FLW[k % FLW.length], c2 = FLW[(k + 2) % FLW.length];
      const nx = Math.max(1, Math.round((x1 - x0 - 0.2) / 0.7)), nz = Math.max(1, Math.round((z1 - z0 - 0.2) / 0.7));
      const sx = (x1 - x0 - 0.2) / nx, sz = (z1 - z0 - 0.2) / nz;
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        const g = ((a + b) % 3) === 1;
        const xx = x0 + 0.1 + (a + 0.5) * sx, zz = z0 + 0.1 + (b + 0.5) * sz;
        box(xx - 0.27, zz - 0.27, xx + 0.27, zz + 0.27, top + 0.2, top + (g ? 0.5 : 0.62), g ? P.crop : ((a + b) & 1 ? c2 : c));
      }
    };
    // paths: a darker edge strip under a lighter tread
    if (pb) {
      const W = 0.8, Wb = 0.95, yb = top + E, yt = top + 2 * E;
      const segs = [];
      segs.push([-1, -1, 1, 1]);
      if (pb & 1) segs.push([-1, -H, 1, -1]);
      if (pb & 2) segs.push([-1, 1, 1, H]);
      if (pb & 4) segs.push([-H, -1, -1, 1]);
      if (pb & 8) segs.push([1, -1, H, 1]);
      for (const [a0, b0, a1, b1] of segs) {
        const ex = (v, w) => Math.abs(v) === 1 ? v * w : v;
        fl(cx + ex(a0, Wb), cz + ex(b0, Wb), cx + ex(a1, Wb), cz + ex(b1, Wb), yb, P.terraLo);
        fl(cx + ex(a0, W), cz + ex(b0, W), cx + ex(a1, W), cz + ex(b1, W), yt, P.terra);
      }
      // entrance: carry the tread over the kerb where the path meets the street
      const DIRS = [[1, 0, -1], [2, 0, 1], [4, -1, 0], [8, 1, 0]];
      for (const [bt, ox, oz] of DIRS) {
        if (!(pb & bt) || !low(tx + ox, tz + oz)) continue;
        if (ox) { const x0 = cx + ox * H, x1 = cx + ox * (H - R); fl(Math.min(x0, x1), cz - W, Math.max(x0, x1), cz + W, K + 0.006, P.terra); }
        else { const z0 = cz + oz * H, z1 = cz + oz * (H - R); fl(cx - W, Math.min(z0, z1), cx + W, Math.max(z0, z1), K + 0.006, P.terra); }
      }
    }
    if (zn === LZ_HUB) {
      // paved round-ish plaza with a fountain or a gazebo, benches
      const r0 = 2.5, r1 = 1.9, yp = top + 3 * E;
      fl(cx - r0, cz - r1, cx + r0, cz + r1, yp, P.tileA);
      fl(cx - r1, cz - r0, cx + r1, cz + r0, yp, P.tileA);
      fl(cx - r1 + 0.3, cz - r1 + 0.3, cx + r1 - 0.3, cz + r1 - 0.3, yp + E, P.tileB);
      if (hh(1) < 0.55) {
        box(cx - 1.3, cz - 1.3, cx + 1.3, cz + 1.3, top, top + 0.32, P.curb);
        fl(cx - 1.0, cz - 1.0, cx + 1.0, cz + 1.0, top + 0.33, P.water);
        box(cx - 0.2, cz - 0.2, cx + 0.2, cz + 0.2, top, top + 1.0, P.curb);
        box(cx - 0.35, cz - 0.35, cx + 0.35, cz + 0.35, top + 1.0, top + 1.12, P.water);
      } else {
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          box(cx + dx * 1.15 - 0.09, cz + dz * 1.15 - 0.09, cx + dx * 1.15 + 0.09, cz + dz * 1.15 + 0.09, top, top + 1.5, P.white);
        }
        box(cx - 1.3, cz - 1.3, cx + 1.3, cz + 1.3, top, top + 0.14, P.curb);
        box(cx - 1.55, cz - 1.55, cx + 1.55, cz + 1.55, top + 1.5, top + 1.72, P.white, P.red);
        box(cx - 0.8, cz - 0.8, cx + 0.8, cz + 0.8, top + 1.72, top + 2.0, P.red);
      }
      for (const s of [-1, 1]) {
        box(cx - 0.8, cz + s * 2.1 - 0.18, cx + 0.8, cz + s * 2.1 + 0.18, top + 0.25, top + 0.36, P.wood);
        box(cx - 0.7, cz + s * 2.1 - 0.12, cx - 0.55, cz + s * 2.1 + 0.12, top, top + 0.25, P.side);
        box(cx + 0.55, cz + s * 2.1 - 0.12, cx + 0.7, cz + s * 2.1 + 0.12, top, top + 0.25, P.side);
      }
      return;
    }
    if (zn === LZ_FLOWER) {
      // beds in the quadrants beside the paths (all four on an open tile)
      let k = (hh(2) * 6) | 0;
      const o0 = pb ? 1.25 : 0.55, o1 = H - (R + 0.35);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const long = ((k + sx + sz) & 1) === 0;
        const xa = cx + sx * o0, xb = cx + sx * (long ? o1 : o0 + 1.3);
        const za = cz + sz * o0, zb = cz + sz * (long ? o0 + 1.3 : o1);
        fbed(Math.min(xa, xb), Math.min(za, zb), Math.max(xa, xb), Math.max(za, zb), k++);
      }
      return;
    }
    if (zn === LZ_PICNIC) {
      // a worn dirt patch (two offset rects, not a square) with a picnic table
      const ox = (hh(3) - 0.5) * 1.6, oz = (hh(4) - 0.5) * 1.6, px = cx + ox, pz = cz + oz;
      fl(px - 2.1, pz - 1.4, px + 1.7, pz + 1.3, top + E, P.dirtDk);
      fl(px - 1.3, pz - 2.0, px + 1.2, pz + 1.9, top + E, P.dirtDk);
      fl(px - 1.6, pz - 1.0, px + 1.2, pz + 0.9, top + 2 * E, P.terra);
      box(px - 0.8, pz - 0.45, px + 0.8, pz + 0.45, top + 0.5, top + 0.62, P.wood);
      box(px - 0.8, pz - 0.95, px + 0.8, pz - 0.7, top + 0.25, top + 0.35, P.wood);
      box(px - 0.8, pz + 0.7, px + 0.8, pz + 0.95, top + 0.25, top + 0.35, P.wood);
      box(px - 0.1, pz - 0.1, px + 0.1, pz + 0.1, top, top + 0.5, P.wood);
    }
  }

  // Verge kerb: a light concrete band KERB_W wide along each road-facing edge
  // of an open land tile, flush with the road's own sidewalk top, so the two
  // read as ONE lot-rim-width light line between asphalt and lawn (ref05's
  // grass blocks are rimmed exactly like its building lots).
  // vm bits: 1 road at z-1, 2 road at z+1, 4 road at x-1, 8 road at x+1.
  _vergeKerb(B, tx, tz, vm) {
    const P = LOT_RGB, T = [1, 0, 0, 0], UP = [0, 1, 0];
    const Y = KERB_Y, W = KERB_W;
    const x0 = tx * TILE, x1 = x0 + TILE, z0 = tz * TILE, z1 = z0 + TILE;
    const flatM = [1, 0, 0, 0];
    const faceM = [[0.62, 0, 0, 0], [0.62, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const vAt = (x, z) => (x < 0 || z < 0 || x >= N || z >= N) ? 0 : this._verge[z * N + x];
    const top = (ax0, az0, ax1, az1) =>
      B.quad([[ax0, Y, az0], [ax0, Y, az1], [ax1, Y, az1], [ax1, Y, az0]], UP, T, flatM, P.rim);
    const face = (ax, az, bx, bz, n) =>
      B.quad([[ax, 0, az], [bx, 0, bz], [bx, Y, bz], [ax, Y, az]], n, T, faceM, P.rim);
    if (vm & 1) {       // road to the north (z-1)
      top(x0, z0, x1, z0 + W);
      face(x0, z0 + W, x1, z0 + W, [0, 0, 1]);
      if (!(vAt(tx - 1, tz) & 1)) face(x0, z0, x0, z0 + W, [-1, 0, 0]);
      if (!(vAt(tx + 1, tz) & 1)) face(x1, z0, x1, z0 + W, [1, 0, 0]);
    }
    if (vm & 2) {       // road to the south (z+1)
      top(x0, z1 - W, x1, z1);
      face(x0, z1 - W, x1, z1 - W, [0, 0, -1]);
      if (!(vAt(tx - 1, tz) & 2)) face(x0, z1 - W, x0, z1, [-1, 0, 0]);
      if (!(vAt(tx + 1, tz) & 2)) face(x1, z1 - W, x1, z1, [1, 0, 0]);
    }
    if (vm & 4) {       // road to the west (x-1)
      top(x0, z0, x0 + W, z1);
      face(x0 + W, z0, x0 + W, z1, [1, 0, 0]);
      if (!(vAt(tx, tz - 1) & 4)) face(x0, z0, x0 + W, z0, [0, 0, -1]);
      if (!(vAt(tx, tz + 1) & 4)) face(x0, z1, x0 + W, z1, [0, 0, 1]);
    }
    if (vm & 8) {       // road to the east (x+1)
      top(x1 - W, z0, x1, z1);
      face(x1 - W, z0, x1 - W, z1, [-1, 0, 0]);
      if (!(vAt(tx, tz - 1) & 8)) face(x1 - W, z0, x1, z0, [0, 0, -1]);
      if (!(vAt(tx, tz + 1) & 8)) face(x1 - W, z1, x1, z1, [0, 0, 1]);
    }
  }

  // Merge the vacant tiles into rects and choose each rect's street side,
  // neighbourhood and design. Deterministic (scan order + hashes of the map).
  // Writes this._rectAt[i] (shared rect object per tile) and the rect-encoding
  // lot key of every tile in it.
  _partitionLots(state, bm) {
    const kind = this._lotKind, key = this._lotKey, rectAt = this._rectAt;
    rectAt.fill(null);
    const map = state.map, occ = state.occ;
    const seed = (state.seed >>> 0) || 1;
    const free = (x, z) => x >= 0 && z >= 0 && x < N && z < N &&
      kind[z * N + x] === LK_VACANT && !rectAt[z * N + x];
    const isRoad = (x, z) => x >= 0 && z >= 0 && x < N && z < N && map[z * N + x] === T_ROAD;
    const ZONE = { 4: 'homes', 5: 'shops', 6: 'factories' };
    const placed = [], parcels = this._parcelRects;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        if (kind[i] !== LK_VACANT || rectAt[i]) continue;
        const hs = hash2(x, z, seed ^ 0x77a1);
        let w = 1, d = 1;
        // r6: one plinth per block. The r5 critic: "in ref05 the ground is
        // tiled edge to edge with separate plinths, one per block" — an empty
        // 3x3 block used to split into four rimmed 2x2/2x1/1x1 lots that read
        // as busy tiling. Take the biggest free rect first (up to 4x4);
        // leftovers fall through to the small greedy merge.
        // r12 (critic r11: "every block is the same diamond size … vary lot
        // and block sizes"): a long block (two blocks joined, 7x3 / 3x7) is
        // ONE long lot now; rects run to 8 tiles a side, 24 tiles at most.
        let bw = 0;
        while (bw < 8 && free(x + bw, z)) bw++;
        let bd = 1;
        while (bd < 8 && bw * (bd + 1) <= 24) {
          let ok = true;
          for (let k = 0; k < bw; k++) if (!free(x + k, z + bd)) { ok = false; break; }
          if (!ok) break;
          bd++;
        }
        if (bw >= 2 && bd >= 2 && bw * bd > 4) { w = bw; d = bd; }
        else if (free(x + 1, z) && free(x, z + 1) && free(x + 1, z + 1)) { w = 2; d = 2; }
        else {
          const hx = free(x + 1, z), hz = free(x, z + 1);
          if (hx && hz) { if (hs < 0.5) w = 2; else d = 2; }
          else if (hx) w = 2;
          else if (hz) d = 2;
        }
        // Street side: the side with the most road along it.
        let nN = 0, nS = 0, nW = 0, nE = 0;
        for (let k = 0; k < w; k++) { nN += isRoad(x + k, z - 1); nS += isRoad(x + k, z + d); }
        for (let k = 0; k < d; k++) { nW += isRoad(x - 1, z + k); nE += isRoad(x + w, z + k); }
        let rot = ((hs * 4096) | 0) & 3, best = 0;
        for (const [n, rr] of [[nN, 0], [nE, 1], [nS, 2], [nW, 3]]) if (n > best) { best = n; rot = rr; }
        // Neighbourhood: the buildings in the ring around the rect.
        const tally = {};
        const big = w * d > 4;
        const rg = big ? 2 : 1;   // a whole-block lot looks across the street for its neighbourhood
        for (let zz = z - rg; zz < z + d + rg; zz++) {
          for (let xx = x - rg; xx < x + w + rg; xx++) {
            if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
            if (xx >= x && xx < x + w && zz >= z && zz < z + d) continue;
            const j = zz * N + xx;
            const o = occ ? occ[j] : 0;
            let c = null;
            if (o) { const b = bm.get(o); c = b && b.cat; }
            else c = ZONE[map[j]] || null;
            if (c && c !== 'deco') tally[c] = (tally[c] || 0) + 1;
          }
        }
        let dist = 'none', dn = 0;
        for (const c in tally) if (tally[c] > dn) { dn = tally[c]; dist = c; }
        const multi = w * d > 1;
        const TB = big ? LOT_BIG : multi ? LOT_MULTI : LOT_SINGLE;
        const table0 = TB[dist] || TB.none;
        // r12: a long joined-block lot (7x3) takes only designs that TILE along
        // their length (car park, camper park, truck depot, garden plaza, town
        // park); a market turns into stall confetti, and the lido / civic
        // plaza / pitch stretch into bare slabs around one feature.
        const LONG_OK = LONG_LOT_DESIGNS;
        const tl = w * d > 12 ? table0.filter((e) => LONG_OK.has(e[0])) : table0;
        const table = tl.length ? tl : table0;
        const hd = hash2(x * 3 + 1, z * 5 + 2, seed ^ 0x3e91);
        // r8 (critic r7: "our ground looks like one tile repeated"): no design
        // FAMILY repeats within a few tiles of any lot already placed (vacant
        // or outskirts parcel), so a row of blocks reads as different grounds.
        // Weighted pick among the families not seen nearby; widen the
        // tolerance only if the table runs dry.
        const gapTo = (q) => Math.max(q.x - (x + w), x - (q.x + q.w), q.z - (z + d), z - (q.z + q.d));
        const nearF = (R) => {
          const f = new Set();
          for (const q of placed) if (gapTo(q) <= R) f.add(lotFam(q.design));
          if (parcels) for (const q of parcels) if (gapTo(q) <= R) f.add(lotFam(q.design));
          return f;
        };
        let di = -1;
        for (const R of [big ? 9 : multi ? 4 : 2, big ? 5 : 1, 1, -1]) {
          const ban = R >= 0 ? nearF(R) : new Set();
          let tot = 0;
          for (const e of table) if (!ban.has(lotFam(e[0]))) tot += e[1];
          if (!tot) continue;
          let acc = 0;
          for (let k = 0; k < table.length; k++) {
            if (ban.has(lotFam(table[k][0]))) continue;
            acc += table[k][1]; di = k;
            if (hd * tot < acc) break;
          }
          break;
        }
        const design = table[di][0];
        const r = { o: i, x, z, w, d, rot, design, h: (hash2(x, z, seed ^ 0x5bd1) * 4294967296) >>> 0 };
        placed.push(r);
        const shape = (w - 1) * 8 + (d - 1);   // w, d <= 8
        const k = -(100000000 + ((i * 64 + shape) * 4 + rot) * 32 + design);
        for (let zz = z; zz < z + d; zz++) {
          for (let xx = x; xx < x + w; xx++) { rectAt[zz * N + xx] = r; key[zz * N + xx] = k; }
        }
      }
    }
  }

  // One vacant rect: rim ring + a dressed interior. Authored in a local frame
  // (u along the street 0..L, v away from it 0..D, v = 0 is the street side)
  // and turned onto the world by `rot`.
  _vacantRect(B, state, r, seed) {
    const P = LOT_RGB, T = [1, 0, 0, 0];
    // A GREEN parcel (r.flush) lies on the field grass itself: no rim ring, no
    // lawn infill, its paths and props at ground level (r4 critic: "drop the
    // rim outlines from grass-topped lots so park and farm grass flows into
    // the terrain grass").
    const flush = !!r.flush;
    const Y = flush ? GREEN_Y : LOT_TOP, R = flush ? 0.9 : LOT_RIM_W, E = 0.012;
    const wx0 = r.x * TILE, wz0 = r.z * TILE;
    const WX = r.w * TILE, WZ = r.d * TILE;
    const rot = r.rot, h = r.h;
    const L = (rot & 1) ? WZ : WX, D = (rot & 1) ? WX : WZ;
    const hr = (k) => hash2(r.x * 7 + k, r.z * 13 - k, seed ^ 0x2c1b);
    const tr = (u, v) => rot === 0 ? [u, v] : rot === 1 ? [WX - v, u] : rot === 2 ? [WX - u, WZ - v] : [v, WZ - u];
    const rectW = (u0, v0, u1, v1) => {
      const a = tr(u0, v0), b = tr(u1, v1);
      return [wx0 + Math.min(a[0], b[0]), wz0 + Math.min(a[1], b[1]), wx0 + Math.max(a[0], b[0]), wz0 + Math.max(a[1], b[1])];
    };
    const flat = (u0, v0, u1, v1, y, col) => {
      const [x0, z0, x1, z1] = rectW(u0, v0, u1, v1);
      B.quad([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], [0, 1, 0], T, [1, 0, 0, 0], col);
    };
    const AOB = [[0.62, 0, 0, 0], [0.62, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
    const box = (u0, v0, u1, v1, y0, y1, col, topCol) => {
      const [x0, z0, x1, z1] = rectW(u0, v0, u1, v1);
      B.quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], T, [1, 0, 0, 0], topCol || col);
      B.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], T, AOB, col);
      B.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], T, AOB, col);
      B.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], T, AOB, col);
      B.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], T, AOB, col);
    };
    // ref06 tree: square trunk, cuboid lime canopy with a darker lower band.
    const tree = (u, v, s) => {
      s = s || 1;
      const t = 0.26 * s, c = 1.0 * s;
      box(u - t, v - t, u + t, v + t, Y, Y + 1.5 * s, P.trunk);
      box(u - c, v - c, u + c, v + c, Y + 1.3 * s, Y + 1.7 * s, P.canopyLo);
      box(u - c, v - c, u + c, v + c, Y + 1.7 * s, Y + 3.0 * s, P.canopy);
      // veg r11 (critic: "the bushes on the parking islands are plain single
      // cubes; ref06 bushes have an offset smaller sub-cube or ledge that
      // breaks the silhouette"): a lower half-size lobe stepped out of one
      // corner, band under it, like ref06 tree 2 / bush 1.
      const o0 = u + 0.3 * c, o1 = u + 1.45 * c, p0 = v + 0.3 * c, p1 = v + 1.45 * c;
      box(o0, p0, o1, p1, Y + 1.0 * s, Y + 1.3 * s, P.canopyLo);
      box(o0, p0, o1, p1, Y + 1.3 * s, Y + 2.2 * s, P.canopy);
    };
    const hedge = (u0, v0, u1, v1) => box(u0, v0, u1, v1, Y, Y + 0.55, P.hedge, P.hedgeTop);
    const flowers = [P.red, P.white, P.yellow, P.blue, P.pink];
    const bed = (u0, v0, u1, v1, k) => {
      box(u0, v0, u1, v1, Y, Y + 0.22, P.soil);
      const c = flowers[k % flowers.length];
      const nu = Math.max(1, Math.floor((u1 - u0) / 0.7)), nv = Math.max(1, Math.floor((v1 - v0) / 0.7));
      const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
      for (let a = 0; a < nu; a++) {
        for (let b = 0; b < nv; b++) {
          const uu = u0 + (a + 0.5) * du, vv = v0 + (b + 0.5) * dv;
          const green = ((a + b + k) & 1) === 0;
          box(uu - 0.2, vv - 0.2, uu + 0.2, vv + 0.2, Y + 0.22, Y + (green ? 0.5 : 0.62), green ? P.crop : c);
        }
      }
    };
    const carCols = [P.red, P.blue, P.yellow, P.white, P.teal, P.orange];
    // A parked car, long along v (nose-in to a bay), centred on (u, v).
    const car = (u, v, col) => {
      if (this.lotCarsExternal) {                    // life.js draws it (res-8 vehicle)
        const [lx, lz] = tr(u, v);
        const mid = D >= 20 && Math.abs(v - D / 2) < 4.4;
        const hv = [2, 3, 0, 1][rot & 3], h = ((v > D / 2) !== mid) ? hv : (hv + 2) & 3;
        let list = this.lotCars.get(r.o);
        if (!list) this.lotCars.set(r.o, list = []);
        list.push({ x: wx0 + lx, z: wz0 + lz, y: Y, h, k: (r.o * 31 + list.length * 7 + carCols.indexOf(col)) | 0 });
        this.lotCarsVersion++;
        return;
      }
      box(u - 0.45, v - 0.95, u + 0.45, v + 0.95, Y + 0.08, Y + 0.5, col);
      box(u - 0.38, v - 0.45, u + 0.38, v + 0.5, Y + 0.5, Y + 0.82, P.glass, col);
    };
    const umbrella = (u, v, col) => {
      box(u - 0.06, v - 0.06, u + 0.06, v + 0.06, Y, Y + 1.5, P.white);
      box(u - 0.85, v - 0.85, u + 0.85, v + 0.85, Y + 1.5, Y + 1.72, col);
    };
    const bench = (u0, v, u1) => {
      box(u0, v - 0.2, u1, v + 0.2, Y + 0.25, Y + 0.36, P.wood);
      box(u0 + 0.1, v - 0.15, u0 + 0.25, v + 0.15, Y, Y + 0.25, P.side);
      box(u1 - 0.25, v - 0.15, u1 - 0.1, v + 0.15, Y, Y + 0.25, P.side);
    };
    const lineU = (u0, u1, v, y) => flat(u0, v - 0.07, u1, v + 0.07, y, P.line);
    const lineV = (u, v0, v1, y) => flat(u - 0.07, v0, u + 0.07, v1, y, P.line);
    // Market stall: a table of produce under a two-tone striped awning.
    const produce = [P.red, P.orange, P.yellow, P.crop, P.pink];
    const stall = (u, v, col, k) => {
      box(u - 0.9, v - 0.55, u + 0.9, v + 0.55, Y, Y + 0.55, P.wood);
      for (let q = 0; q < 3; q++) {
        const uu = u - 0.6 + q * 0.6;
        box(uu - 0.24, v - 0.4, uu + 0.24, v + 0.4, Y + 0.55, Y + 0.78, produce[(k + q) % produce.length]);
      }
      for (const [du, dv] of [[-0.95, -0.6], [0.95, -0.6], [-0.95, 0.6], [0.95, 0.6]]) {
        box(u + du - 0.06, v + dv - 0.06, u + du + 0.06, v + dv + 0.06, Y, Y + 1.55, P.white);
      }
      box(u - 1.15, v - 0.85, u - 0.38, v + 0.85, Y + 1.55, Y + 1.8, col);
      box(u - 0.38, v - 0.85, u + 0.38, v + 0.85, Y + 1.55, Y + 1.8, P.white);
      box(u + 0.38, v - 0.85, u + 1.15, v + 0.85, Y + 1.55, Y + 1.8, col);
    };
    const crateStack = (u, v, n) => {
      for (let q = 0; q < n; q++) {
        const du = (q % 2) * 0.9, dv = ((q >> 1) % 2) * 0.9, dy = q >= 4 ? 0.7 : 0;
        box(u + du - 0.4, v + dv - 0.4, u + du + 0.4, v + dv + 0.4, Y + dy, Y + dy + 0.7, P.wood, P.crate);
      }
    };
    const shed = (u0, v0, u1, v1, wallC, roofC) => {
      box(u0, v0, u1, v1, Y, Y + 1.6, wallC);
      box(u0 - 0.15, v0 - 0.15, u1 + 0.15, v1 + 0.15, Y + 1.6, Y + 1.85, roofC);
      box((u0 + u1) / 2 - 0.4, v0 - 0.02, (u0 + u1) / 2 + 0.4, v0 + 0.05, Y, Y + 1.2, P.white);
    };
    // Crop rows along u, from v0 to v1, in the given colours (cycled).
    const cropRows = (u0, u1, v0, v1, cols, tall) => {
      const pitch = 1.05;
      let k = 0;
      for (let v = v0 + 0.15; v + 0.6 <= v1; v += pitch, k++) {
        const c = cols[k % cols.length];
        box(u0, v, u1, v + 0.6, Y, Y + (tall ? 0.55 : 0.34), c);
      }
    };

    // ---- r7 dressing helpers ---------------------------------------------
    // A hedge row the way ref05 draws them: a dark green base with a run of
    // chunky cube bushes on top, not a smooth green bar. Runs along the
    // longer axis of the rect.
    const hedgeRow = (u0, v0, u1, v1, k) => {
      k = k || 0;
      box(u0, v0, u1, v1, Y, Y + 0.5, P.hedge, P.hedge);
      const alongU = (u1 - u0) >= (v1 - v0);
      const len = alongU ? u1 - u0 : v1 - v0;
      const n = Math.max(1, Math.round(len / 1.05));
      const st = len / n;
      for (let q = 0; q < n; q++) {
        const hq = hr(200 + k * 31 + q);
        const ht = Y + 0.85 + hq * 0.35, g = 0.08 + hq * 0.06;
        const c0 = alongU ? u0 + q * st + g : u0 - 0.08, c1 = alongU ? u0 + (q + 1) * st - g : u1 + 0.08;
        const d0 = alongU ? v0 - 0.08 : v0 + q * st + g, d1 = alongU ? v1 + 0.08 : v0 + (q + 1) * st - g;
        box(c0, d0, c1, d1, Y + 0.3, ht, P.hedge, hq < 0.3 ? P.hedgeHi : P.hedgeTop);
      }
    };
    // Hedges lining the inside of a rect (inset `i0`, thickness `t`), with an
    // entrance gap `g` wide centred on the street side (v = v0) and, when
    // `all` is set, on every side.
    const hedgeBorder = (u0, v0, u1, v1, t, g, all) => {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, hg = g / 2;
      const runU = (v, k, gap) => {
        if (gap && u1 - u0 > g + 2) { hedgeRow(u0, v, cu - hg, v + t, k); hedgeRow(cu + hg, v, u1, v + t, k + 1); }
        else hedgeRow(u0, v, u1, v + t, k);
      };
      const runV = (u, k, gap) => {
        const a0 = v0 + t, a1 = v1 - t;
        if (gap && a1 - a0 > g + 2) { hedgeRow(u, a0, u + t, cv - hg, k); hedgeRow(u, cv + hg, u + t, a1, k + 1); }
        else if (a1 > a0 + 0.5) hedgeRow(u, a0, u + t, a1, k);
      };
      runU(v0, 1, true);
      runU(v1 - t, 3, all);
      runV(u0, 5, all);
      runV(u1 - t, 7, all);
    };
    // Paving laid as big square tiles in two tones on a joint grid — zoned
    // paving with a visible pattern, never one flat cream sheet.
    const tiles = (u0, v0, u1, v1, y, cA, cB, step) => {
      flat(u0, v0, u1, v1, y, cA);
      step = step || 2.0;
      const nu = Math.max(1, Math.round((u1 - u0) / step)), nv = Math.max(1, Math.round((v1 - v0) / step));
      const su = (u1 - u0) / nu, sv = (v1 - v0) / nv;
      for (let p = 0; p < nu; p++) {
        for (let q = 0; q < nv; q++) {
          if ((p + q) & 1) flat(u0 + p * su + 0.06, v0 + q * sv + 0.06, u0 + (p + 1) * su - 0.06, v0 + (q + 1) * sv - 0.06, y + E, cB);
        }
      }
    };
    // Grey block statue on a pedestal (ref05's monument figures).
    const statue = (u, v, s) => {
      s = s || 1;
      box(u - 0.55 * s, v - 0.55 * s, u + 0.55 * s, v + 0.55 * s, Y, Y + 0.6 * s, P.side, P.curb);
      box(u - 0.3 * s, v - 0.22 * s, u + 0.3 * s, v + 0.22 * s, Y + 0.6 * s, Y + 1.5 * s, P.stone);
      box(u - 0.18 * s, v - 0.16 * s, u + 0.18 * s, v + 0.16 * s, Y + 1.5 * s, Y + 1.85 * s, P.stone, P.white);
    };
    // Cube-bush clump (2-4 cubes) for planters and grass beds.
    const bushes = (u, v, k) => {
      const n = 2 + ((hr(300 + k) * 3) | 0);
      for (let q = 0; q < n; q++) {
        const du = (q & 1) * 0.9 - 0.45, dv = (q >> 1) * 0.9 - 0.45, hq = hr(320 + k * 5 + q);
        const r0 = 0.38 + hq * 0.12;
        box(u + du - r0, v + dv - r0, u + du + r0, v + dv + r0, Y + 0.1, Y + 0.7 + hq * 0.35, P.hedge, hq < 0.4 ? P.hedgeHi : P.hedgeTop);
      }
    };
    const lamp = (u, v) => {
      box(u - 0.07, v - 0.07, u + 0.07, v + 0.07, Y, Y + 2.1, P.barrel);
      box(u - 0.17, v - 0.17, u + 0.17, v + 0.17, Y + 2.1, Y + 2.35, P.white);
    };
    // ---- r8 dressing helpers ---------------------------------------------
    // ref06 grey stepped rock cluster: a big block, a mid one leaning on it
    // and a pebble, lighter tops over darker sides.
    const rocks = (u, v, k) => {
      const f = (hr(400 + k) < 0.5) ? 1 : -1, s = 0.8 + hr(410 + k) * 0.4;
      box(u - 0.6 * s, v - 0.55 * s, u + 0.6 * s, v + 0.55 * s, Y, Y + 0.95 * s, P.rockDk, P.rock);
      box(u + f * 0.5 * s, v + 0.2 * s, u + f * 1.25 * s, v + 0.9 * s, Y, Y + 0.6 * s, P.rockDk, P.rock);
      box(u - f * 0.95 * s, v + 0.5 * s, u - f * 0.55 * s, v + 0.9 * s, Y, Y + 0.35 * s, P.rockDk, P.rock);
    };
    // Caravan / mobile home, long along v, centred on (u, v): white body with
    // a coloured stripe, grey roof, dark window band, wheels, and an awning
    // on the +u side.
    const caravan = (u, v, col, awn) => {
      box(u - 0.5, v - 0.45, u + 0.5, v + 0.45, Y, Y + 0.3, P.tyre);
      box(u - 0.62, v - 1.25, u + 0.62, v + 1.25, Y + 0.25, Y + 1.35, P.van, P.vanRoof);
      box(u - 0.64, v - 1.27, u + 0.64, v + 1.27, Y + 0.62, Y + 0.78, col);
      box(u - 0.64, v - 0.9, u + 0.64, v + 0.2, Y + 0.88, Y + 1.12, P.glass);
      box(u - 0.35, v - 0.6, u + 0.35, v + 0.3, Y + 1.35, Y + 1.5, P.vanRoof, P.white);
      if (awn) box(u + 0.64, v - 1.0, u + 1.45, v + 0.6, Y + 1.12, Y + 1.2, awn);
    };
    // Box truck, long along v, cab toward -v when `nose` < 0, else +v.
    const truck = (u, v, col, nose) => {
      const s = nose < 0 ? -1 : 1;
      box(u - 0.55, v - 1.9, u + 0.55, v + 1.9, Y + 0.4, Y + 1.9, col, P.white);
      box(u - 0.5, v + s * 1.95 - 0.55, u + 0.5, v + s * 1.95 + 0.55, Y + 0.35, Y + 1.45, P.white);
      box(u - 0.52, v + s * 2.35 - 0.12, u + 0.52, v + s * 2.35 + 0.12, Y + 0.95, Y + 1.35, P.glass);
      for (const dv of [-1.3, 1.1, s * 1.95]) box(u - 0.58, v + dv - 0.28, u + 0.58, v + dv + 0.28, Y, Y + 0.45, P.tyre);
    };
    // Café table under a parasol, with two stools.
    const cafe = (u, v, col) => {
      umbrella(u, v, col);
      box(u - 0.45, v - 0.45, u + 0.45, v + 0.45, Y + 0.55, Y + 0.65, P.white);
      box(u - 0.1, v - 0.1, u + 0.1, v + 0.1, Y, Y + 0.55, P.white);
      box(u - 1.0, v - 0.2, u - 0.65, v + 0.2, Y, Y + 0.4, P.wood);
      box(u + 0.65, v - 0.2, u + 1.0, v + 0.2, Y, Y + 0.4, P.wood);
    };

    // ---- r13 fill helpers (critic r12: "every lot filled edge to edge") ---
    // Pool water laid as ref05's mosaic: pool blue with lighter tiles in a
    // loose checker, so a big pool is not one flat sheet.
    const poolWater = (u0, v0, u1, v1, y) => {
      flat(u0, v0, u1, v1, y, P.water);
      const st = 1.25;
      const nu = Math.max(1, Math.round((u1 - u0) / st)), nv = Math.max(1, Math.round((v1 - v0) / st));
      const su = (u1 - u0) / nu, sv = (v1 - v0) / nv;
      for (let p = 0; p < nu; p++) for (let q = 0; q < nv; q++) {
        const hq = hash2(r.x * 131 + p, r.z * 71 + q, seed ^ 0x7a11);
        if (((p + q) & 1) === 0 && hq < 0.7) flat(u0 + p * su, v0 + q * sv, u0 + (p + 1) * su, v0 + (q + 1) * sv, y + E, P.waterLt);
      }
    };
    // Beach ball: a white cube with a coloured band.
    const ball = (u, v, y, col) => {
      box(u - 0.26, v - 0.26, u + 0.26, v + 0.26, y, y + 0.5, P.white, col);
      box(u - 0.27, v - 0.1, u + 0.27, v + 0.1, y + 0.02, y + 0.48, col);
    };
    // Sun lounger pair under a parasol (ref05 lido deck).
    const loungers = (u, v, col, lc) => {
      box(u - 0.95, v - 0.8, u - 0.25, v + 0.8, Y, Y + 0.24, lc, lc);
      box(u - 0.95, v + 0.5, u - 0.25, v + 0.8, Y + 0.24, Y + 0.5, lc);
      box(u + 0.25, v - 0.8, u + 0.95, v + 0.8, Y, Y + 0.24, lc, lc);
      box(u + 0.25, v + 0.5, u + 0.95, v + 0.8, Y + 0.24, Y + 0.5, lc);
      box(u - 0.06, v - 0.06, u + 0.06, v + 0.06, Y, Y + 1.55, P.white);
      box(u - 0.9, v - 0.9, u + 0.9, v + 0.9, Y + 1.55, Y + 1.72, col);
      box(u - 0.9, v - 0.22, u + 0.9, v + 0.22, Y + 1.57, Y + 1.74, P.white);
      box(u - 0.22, v - 0.9, u + 0.22, v + 0.9, Y + 1.57, Y + 1.74, P.white);
    };
    // Planter box with a small tree (paved lots' tree pits).
    const treeBox = (u, v, s) => {
      box(u - 0.75, v - 0.75, u + 0.75, v + 0.75, Y, Y + 0.4, P.curb, P.lawnDk);
      tree(u, v, s || 0.55);
    };
    // Floodlight mast.
    const flood = (u, v) => {
      box(u - 0.1, v - 0.1, u + 0.1, v + 0.1, Y, Y + 4.6, P.barrel);
      box(u - 0.55, v - 0.2, u + 0.55, v + 0.2, Y + 4.6, Y + 5.1, P.barrel, P.white);
    };
    // Pallet of goods (depot / works yards).
    const pallet = (u, v, col) => {
      box(u - 0.5, v - 0.5, u + 0.5, v + 0.5, Y, Y + 0.14, P.pallet);
      box(u - 0.42, v - 0.42, u + 0.42, v + 0.42, Y + 0.14, Y + 0.72, col || P.crate, P.wood);
    };
    // Shipping container, long along u.
    const container = (u0, v0, u1, v1, y0, col) => {
      box(u0, v0, u1, v1, y0, y0 + 1.25, col, P.white);
      const n = Math.max(2, Math.round((u1 - u0) / 0.6));
      for (let q = 1; q < n; q += 2) {
        const uu = u0 + q * (u1 - u0) / n;
        box(uu - 0.05, v0 - 0.02, uu + 0.05, v1 + 0.02, y0 + 0.08, y0 + 1.17, col, col);
      }
    };

    // ---- r11 sub-zone helpers (critic r10: "break up each lot top") -------
    // Cobbled setts: a joint-coloured bed with running-bond stones in three
    // greys on it, so a paved zone reads as ref05's cobbles, not a flat sheet.
    let cobK = 0;
    const cobbles = (u0, v0, u1, v1, y, cA, cB, cC, cJ) => {
      flat(u0, v0, u1, v1, y, cJ || P.cobJoint);
      const sw = 0.8, sd = 0.56, g = 0.05;
      const cols = [cA || P.cobA, cB || P.cobB, cC || P.cobC];
      let row = 0;
      for (let v = v0; v < v1 - 0.12; v += sd, row++) {
        const vb = Math.min(v1, v + sd);
        const off = (row & 1) ? sw / 2 : 0;
        for (let u = u0 - off; u < u1 - 0.12; u += sw) {
          const ua = Math.max(u0, u), ub = Math.min(u1, u + sw);
          if (ub - ua < 0.25) continue;
          const hq = hash2(r.x * 977 + (cobK++), r.z * 331 + row, seed ^ 0x51c3);
          flat(ua + g, v + g, ub - g, vb - g, y + E, cols[hq < 0.45 ? 0 : hq < 0.8 ? 1 : 2]);
        }
      }
    };
    // ref05 produce bed: a low wooden platform packed with crates, each
    // heaped with one colour, the bed split into two or three colour patches.
    const PRODUCE = [[0x7cc53a, 0xf08a2c], [0xe0483c, 0x7cc53a], [0xf3c63a, 0x3f8f2e],
      [0xa45cc8, 0x92c252], [0xf08a2c, 0xe0483c], [0x3f8f2e, 0xf08cb4]].map((cc) => cc.map((c) => { const l = lin(c); return [l.r, l.g, l.b, 1]; }));
    const produceBed = (u0, v0, u1, v1, k) => {
      box(u0, v0, u1, v1, Y, Y + 0.26, P.wood, P.trunk);
      const set = PRODUCE[k % PRODUCE.length];
      const nu = Math.max(1, Math.round((u1 - u0 - 0.2) / 1.25)), nv = Math.max(1, Math.round((v1 - v0 - 0.2) / 1.25));
      const su = (u1 - u0 - 0.2) / nu, sv = (v1 - v0 - 0.2) / nv;
      const split = hr(960 + k) < 0.5;
      for (let p = 0; p < nu; p++) {
        for (let q = 0; q < nv; q++) {
          const ca = u0 + 0.1 + p * su + 0.07, cb = u0 + 0.1 + (p + 1) * su - 0.07;
          const da = v0 + 0.1 + q * sv + 0.07, db = v0 + 0.1 + (q + 1) * sv - 0.07;
          const c = set[(split ? p < nu / 2 : q < nv / 2) ? 0 : 1];
          box(ca, da, cb, db, Y + 0.26, Y + 0.62, P.crate, c);
          // a heap of voxel produce: four chunky cubes at staggered heights
          const hu = (cb - ca) / 2, hv = (db - da) / 2;
          for (let w = 0; w < 4; w++) {
            const eu = ca + (w & 1) * hu + 0.08, ev = da + (w >> 1) * hv + 0.08;
            const ht = 0.12 + ((p * 3 + q * 5 + w * 7 + k) % 4) * 0.04;
            box(eu, ev, eu + hu - 0.16, ev + hv - 0.16, Y + 0.62, Y + 0.62 + ht, c);
          }
        }
      }
    };
    // White canopy tent (w along u, d along v) over a table of goods.
    const tent = (u, v, w, d, k) => {
      const hw = w / 2, hd = d / 2;
      for (const [du, dv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        box(u + du * (hw - 0.1) - 0.06, v + dv * (hd - 0.1) - 0.06, u + du * (hw - 0.1) + 0.06, v + dv * (hd - 0.1) + 0.06, Y, Y + 1.5, P.white);
      }
      box(u - hw * 0.8, v - hd * 0.45, u + hw * 0.8, v + hd * 0.45, Y, Y + 0.55, P.wood, P.crate);
      const set = PRODUCE[(k + 2) % PRODUCE.length];
      box(u - hw * 0.7, v - hd * 0.35, u - 0.05, v + hd * 0.35, Y + 0.55, Y + 0.7, set[0]);
      box(u + 0.05, v - hd * 0.35, u + hw * 0.7, v + hd * 0.35, Y + 0.55, Y + 0.7, set[1]);
      box(u - hw, v - hd, u + hw, v + hd, Y + 1.5, Y + 1.72, P.white, P.white);
      box(u - hw * 0.6, v - hd, u + hw * 0.6, v + hd, Y + 1.72, Y + 1.95, P.vanRoof, P.white);
    };
    // Red/white (or teal/white) striped parasol over a table with crates.
    const parasolTable = (u, v, col) => {
      box(u - 0.06, v - 0.06, u + 0.06, v + 0.06, Y, Y + 1.6, P.white);
      box(u - 0.95, v - 0.95, u + 0.95, v + 0.95, Y + 1.6, Y + 1.78, col);
      box(u - 0.95, v - 0.24, u + 0.95, v + 0.24, Y + 1.62, Y + 1.8, P.white);
      box(u - 0.24, v - 0.95, u + 0.24, v + 0.95, Y + 1.62, Y + 1.8, P.white);
      box(u - 0.3, v - 0.3, u + 0.3, v + 0.3, Y + 1.78, Y + 1.9, col);
      box(u - 0.75, v - 0.5, u + 0.75, v + 0.5, Y, Y + 0.5, P.wood, P.crate);
      const set = PRODUCE[((u * 7 + v * 3) | 0) % PRODUCE.length];
      box(u - 0.6, v - 0.38, u - 0.05, v + 0.38, Y + 0.5, Y + 0.64, set[0]);
      box(u + 0.05, v - 0.38, u + 0.6, v + 0.38, Y + 0.5, Y + 0.64, set[1]);
    };
    // Planter strip along the inside of the rim: a kerbed dark-grass bed with
    // cube bushes and flower clumps in turn, with a gap every few units.
    const planterRun = (u0, v0, u1, v1, k) => {
      box(u0, v0, u1, v1, Y, Y + 0.22, P.curb, P.lawnDk);
      const alongU = (u1 - u0) >= (v1 - v0);
      const len = alongU ? u1 - u0 : v1 - v0, t = alongU ? v1 - v0 : u1 - u0;
      const n = Math.max(1, Math.round(len / 1.3)), st = len / n;
      for (let q = 0; q < n; q++) {
        const hq = hr(1100 + k * 37 + q);
        const c0 = (alongU ? u0 : v0) + q * st + 0.18, c1 = c0 + st - 0.36;
        const w0 = (alongU ? v0 : u0) + 0.15, w1 = w0 + t - 0.3;
        const bx = (lo0, lo1, hi0, hi1, y0, y1v, sc, tc) => alongU ? box(lo0, hi0, lo1, hi1, y0, y1v, sc, tc) : box(hi0, lo0, hi1, lo1, y0, y1v, sc, tc);
        if (hq < 0.55) bx(c0, c1, w0, w1, Y + 0.2, Y + 0.7 + hq * 0.5, P.hedge, hq < 0.2 ? P.hedgeHi : P.hedgeTop);
        else if (hq < 0.85) {
          const fc = flowers[(k + q) % flowers.length];
          const m = (c0 + c1) / 2, wm = (w0 + w1) / 2;
          bx(m - 0.3, m - 0.02, wm - 0.25, wm + 0.02, Y + 0.22, Y + 0.48, fc);
          bx(m + 0.05, m + 0.33, wm - 0.02, wm + 0.28, Y + 0.22, Y + 0.44, P.crop);
          bx(m - 0.1, m + 0.2, wm + 0.05, wm + 0.3, Y + 0.22, Y + 0.52, fc);
        }
      }
    };

    // Rim ring, then the infill. A flush green lot has neither: the field
    // grass is its lawn. r7: the rim is a grey concrete KERB standing
    // LOT_KERB_H proud of the lot top (its outer face is the lot wall's top
    // band), so every lot has a crisp light edge with a shadow line inside.
    if (!flush) {
      const K = Y + LOT_KERB_H;
      flat(0, 0, L, R, K, P.curb); flat(0, D - R, L, D, K, P.curb);
      flat(0, R, R, D - R, K, P.curb); flat(L - R, R, L, D - R, K, P.curb);
      const IN = [[0.66, 0, 0, 0], [0.66, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
      const inner = (u0, v0, u1, v1) => {
        const p = tr(u0, v0), q = tr(u1, v1);
        const ax = wx0 + p[0], az = wz0 + p[1], bx = wx0 + q[0], bz = wz0 + q[1];
        // outward normal of the face = toward the lot interior's opposite;
        // the face points INTO the lot, i.e. perpendicular to (a->b), toward
        // the rect centre.
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const cxw = wx0 + WX / 2, czw = wz0 + WZ / 2;
        let nx = -(bz - az), nz = bx - ax;
        const ln = Math.hypot(nx, nz) || 1; nx /= ln; nz /= ln;
        if (nx * (cxw - mx) + nz * (czw - mz) < 0) { nx = -nx; nz = -nz; }
        // wind the quad so its front faces +n
        const f = (nx * (bz - az) - nz * (bx - ax)) < 0;
        const A = f ? [ax, az] : [bx, bz], Bq = f ? [bx, bz] : [ax, az];
        B.quad([[A[0], Y, A[1]], [Bq[0], Y, Bq[1]], [Bq[0], K, Bq[1]], [A[0], K, A[1]]], [nx, 0, nz], T, IN, P.curbSide);
      };
      inner(R, R, L - R, R); inner(R, D - R, L - R, D - R);
      inner(R, R, R, D - R); inner(L - R, R, L - R, D - R);
    }
    // r10: lot lawns are the FIELD grass itself (unpainted), so a park lot and
    // the meadow can never read as two clashing greens (critics r5, r8, r9).
    const lawn = (u0, v0, u1, v1) => { if (!flush) flat(u0, v0, u1, v1, Y, null); };
    const a = R, bU = L - R, bV = D - R;       // interior extent
    const y1 = Y + E, y2 = Y + 2 * E;

    const mir = (h >>> 17) & 1;
    const U = (u) => mir ? L - u : u;          // mirror along the street
    const Uc = (u0, u1) => mir ? [L - u1, L - u0] : [u0, u1];
    let design = r.design;
    // r8 designs need room: a depot wants two bay depths, a camper park a
    // grid of pitches. On a narrow rect fall back to their small cousins.
    if (design === 18 && D < 14) design = 10;
    if (design === 17 && Math.min(L, D) < 12) design = 3;

    if (design === 0) {
      // Pocket park: lawn, an L of paved path from the street, hedged back
      // edge, two trees, a flower bed and a bench.
      flat(a, a, bU, bV, Y, null);
      let [p0, p1] = Uc(3.4, 4.6);
      flat(p0, a, p1, 5.6, y1, P.terra);
      [p0, p1] = Uc(3.4, bU);
      flat(p0, 4.4, p1, 5.6, y1, P.terra);
      hedge(a + 0.1, bV - 0.7, bU - 0.1, bV - 0.1);
      [p0, p1] = Uc(a + 0.1, a + 0.7);
      hedge(p0, a + 1.4, p1, bV - 0.8);
      tree(U(2.0), 6.1, 0.9);
      tree(U(6.1), 6.4, 0.75);
      [p0, p1] = Uc(5.3, 6.9);
      bed(p0, 1.1, p1, 2.7, hr(1) * 5 | 0);
      [p0, p1] = Uc(1.6, 2.9);
      bench(p0, 2.2, p1);
    } else if (design === 1) {
      // Paved plaza: paving with a darker border band, central fountain,
      // two café umbrellas and planters with trees on the back corners.
      tiles(a, a, bU, bV, Y, P.paving, P.paveDark, 1.6);
      flat(a + 0.5, a + 0.5, bU - 0.5, a + 0.8, y1, P.paveDark);
      flat(a + 0.5, bV - 0.8, bU - 0.5, bV - 0.5, y1, P.paveDark);
      flat(a + 0.5, a + 0.8, a + 0.8, bV - 0.8, y1, P.paveDark);
      flat(bU - 0.8, a + 0.8, bU - 0.5, bV - 0.8, y1, P.paveDark);
      box(2.7, 2.7, 5.3, 3.0, Y, Y + 0.35, P.rim); box(2.7, 5.0, 5.3, 5.3, Y, Y + 0.35, P.rim);
      box(2.7, 3.0, 3.0, 5.0, Y, Y + 0.35, P.rim); box(5.0, 3.0, 5.3, 5.0, Y, Y + 0.35, P.rim);
      flat(3.0, 3.0, 5.0, 5.0, Y + 0.2, P.water);
      box(3.8, 3.8, 4.2, 4.2, Y, Y + 0.9, P.rim);
      box(3.7, 3.7, 4.3, 4.3, Y + 0.9, Y + 1.05, P.water);
      const cA = [P.red, P.teal, P.orange][hr(2) * 3 | 0];
      umbrella(U(1.5), 1.5, cA);
      umbrella(U(6.5), 1.5, P.white);
      let [p0, p1] = Uc(1.0, 2.4);
      box(p0, 5.9, p1, 7.3, Y, Y + 0.4, P.side, P.lawn);
      tree(U(1.7), 6.6, 0.7);
      [p0, p1] = Uc(5.6, 7.0);
      box(p0, 5.9, p1, 7.3, Y, Y + 0.4, P.side, P.lawn);
      tree(U(6.3), 6.6, 0.7);
    } else if (design === 2 || design === 10) {
      // Parking: asphalt, white-lined bays in a back row (and a front row
      // when the lot is deep enough), cars in most bays, a drive aisle with an
      // arrow, a hedge planter with a tree at the end of each row.
      flat(a, a, bU, bV, Y, P.asphalt);
      const bayW = 1.5, bayD = 4.2;
      const rows = [[bV - 0.3 - bayD, bV - 0.3]];
      if (D >= 14) rows.push([a + 0.3, a + 0.3 + bayD]);
      // r6: a whole-block car park gets a middle double row, so it reads as a
      // full lot of bays (ref05) instead of a wide empty slab of asphalt.
      const midRows = D >= 20;
      if (midRows) rows.push([D / 2 - bayD - 0.05, D / 2 - 0.05], [D / 2 + 0.05, D / 2 + bayD + 0.05]);
      const nb = Math.max(2, Math.floor((bU - a - 1.8) / bayW));
      const u0 = a + 0.3;
      let ck = 0;
      for (const [v0, v1] of rows) {
        const front = v0 < D / 2 && rows.length > 1;
        for (let q = 0; q <= nb; q++) lineV(u0 + q * bayW, v0, v1, y1);
        lineU(u0, u0 + nb * bayW, front ? v1 : v0, y1);
        for (let q = 0; q < nb; q++) {
          if (hr(10 + ck++) < 0.12) continue;             // (life r7) busier lots: r6 critic "lines but almost no cars"
          car(u0 + (q + 0.5) * bayW, (v0 + v1) / 2, carCols[(hr(40 + ck) * carCols.length) | 0]);
        }
        const pu = u0 + nb * bayW + 0.25;
        if (bU - pu > 0.9) {
          box(pu, v0 + 0.2, bU - 0.15, v1 - 0.2, Y, Y + 0.35, P.side, P.lawn);
          tree((pu + bU - 0.15) / 2, (v0 + v1) / 2, 0.6);
        }
      }
      // aisle: centre dashes + a painted arrow toward the street
      const vas = midRows ? [(a + 0.3 + bayD + D / 2 - bayD) / 2, (D / 2 + bayD + bV - 0.3 - bayD) / 2]
        : [rows.length > 1 ? D / 2 : (a + rows[0][0]) / 2];
      for (const va of vas) for (let uu = a + 0.8; uu + 1.0 < bU - 1.2; uu += 2.0) lineU(uu, uu + 1.0, va, y1);
      if (rows.length === 1) {
        flat(L / 2 - 0.4, 1.6, L / 2 + 0.4, 1.75, y1, P.line);
        flat(L / 2 - 0.07, 1.0, L / 2 + 0.07, 2.4, y1, P.line);
      }
    } else if (design === 3) {
      // Community garden: paving walks between three planted beds, a hedge
      // on one flank and a shade tree.
      tiles(a, a, bU, bV, Y, P.tileA, P.tileB, 1.6);
      const k0 = hr(3) * 5 | 0;
      let [p0, p1] = Uc(1.0, 4.4);
      bed(p0, 1.1, p1, 2.6, k0);
      bed(p0, 3.3, p1, 4.8, k0 + 1);
      bed(p0, 5.5, p1, 7.0, k0 + 2);
      [p0, p1] = Uc(bU - 0.7, bU - 0.1);
      hedge(p0, a + 0.1, p1, bV - 0.1);
      tree(U(5.9), 5.9, 0.85);
      [p0, p1] = Uc(5.1, 6.6);
      bench(p0, 2.0, p1);
    } else if (design === 5) {
      // Pool deck: paving, a bright pool with a white coping, loungers and a
      // parasol, a hedge along the back.
      tiles(a, a, bU, bV, Y, P.deckA, P.deckB, 1.6);
      let [p0, p1] = Uc(1.0, 5.2);
      box(p0, 1.0, p1, 1.25, Y, Y + 0.14, P.white);
      box(p0, 4.75, p1, 5.0, Y, Y + 0.14, P.white);
      box(p0, 1.25, p0 + 0.25, 4.75, Y, Y + 0.14, P.white);
      box(p1 - 0.25, 1.25, p1, 4.75, Y, Y + 0.14, P.white);
      flat(p0 + 0.25, 1.25, p1 - 0.25, 4.75, Y + 0.06, P.water);
      const lc = [P.white, P.orange, P.blue][hr(4) * 3 | 0];
      for (const lv of [1.5, 2.7, 3.9]) {
        [p0, p1] = Uc(5.9, 7.2);
        box(p0, lv, p1, lv + 0.7, Y, Y + 0.22, lc);
      }
      umbrella(U(6.5), 5.7, P.red);
      hedge(a + 0.1, bV - 0.7, bU - 0.1, bV - 0.1);
    } else if (design === 4) {
      // Playground: lawn, a sand pit with a slide and a climbing frame,
      // trees on the back corners.
      flat(a, a, bU, bV, Y, null);
      let [p0, p1] = Uc(1.0, 5.6);
      flat(p0, 1.0, p1, 5.0, y1, P.sand);
      box(p0, 1.0, p1, 1.2, Y, Y + 0.18, P.wood);
      const su = U(2.2);
      box(su - 0.5, 2.2, su + 0.5, 3.2, Y, Y + 1.4, P.red, P.yellow);
      box(su - 0.3, 3.2, su + 0.3, 3.9, Y, Y + 1.0, P.blue);
      box(su - 0.3, 3.9, su + 0.3, 4.6, Y, Y + 0.55, P.blue);
      const fu = U(4.5);
      for (const [du, dv] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
        box(fu + du - 0.08, 2.4 + dv - 0.08, fu + du + 0.08, 2.4 + dv + 0.08, Y, Y + 1.3, P.teal);
      }
      box(fu - 0.7, 1.7, fu + 0.7, 3.1, Y + 1.3, Y + 1.45, P.orange);
      tree(U(6.3), 6.2, 0.8);
      tree(U(1.8), 6.5, 0.65);
      [p0, p1] = Uc(6.0, 7.2);
      bench(p0, 3.0, p1);
    } else if (design === 6 || design === 12) {
      // Allotments / crop rows (ref05's farm lots): brown soil, rows of
      // crops in two or three bands of colour, a paved path from the street
      // and — on a big lot — a little red shed.
      flat(a, a, bU, bV, Y, P.soil);
      const pw = 1.1;
      const pu = L / 2 - pw / 2;
      flat(pu, a, pu + pw, bV, y1, P.dirtPath);
      const sets = [[P.crop, P.cropDark], [P.wheat], [P.crop, P.pumpkin], [P.cabbage, P.crop]];
      const s0 = (hr(5) * sets.length) | 0;
      const big = L * D > 70;
      const v1 = big ? bV - 0.2 : bV - 0.2;
      cropRows(a + 0.3, pu - 0.3, a + 0.3, v1, sets[s0], s0 === 1);
      if (big) {
        const shU = mir ? [pu + pw + 0.6, pu + pw + 3.4] : [bU - 3.4, bU - 0.6];
        cropRows(mir ? shU[1] + 0.4 : pu + pw + 0.3, mir ? bU - 0.3 : shU[0] - 0.4, a + 0.3, v1,
          sets[(s0 + 1) % sets.length], (s0 + 1) % sets.length === 1);
        shed(shU[0], bV - 3.0, shU[1], bV - 0.6, P.barn, P.white);
        box(shU[0], a + 0.6, shU[0] + 0.8, a + 1.4, Y, Y + 0.7, P.wood, P.crate);
      } else {
        cropRows(pu + pw + 0.3, bU - 0.3, a + 0.3, v1, sets[(s0 + 1) % sets.length], (s0 + 1) % sets.length === 1);
      }
    } else if (design === 15) {
      // Lido (ref05's pool block), r7: a two-tone tiled deck inside a hedge
      // border (entrance on the street), one big pool with a white coping and
      // lane lines, a kid pool, a lawn bed with trees on the spare flank and a
      // row of loungers under parasols along the back, a kiosk in the corner.
      tiles(a, a, bU, bV, Y, P.deckA, P.deckB, 1.6);
      hedgeBorder(a + 0.15, a + 0.15, bU - 0.15, bV - 0.15, 0.75, 3.0, false);
      const a2 = a + 1.3, bU2 = bU - 1.3, bV2 = bV - 1.2;
      const pu0 = a2 + 0.8, pv0 = a2 + 0.8;
      const pu1 = Math.min(bU2 - 0.8, pu0 + 11.5), pv1 = Math.min(Math.max(pv0 + 4, bV2 - 4.2), pv0 + 8);
      if (bU2 - pu1 > 4.2) {
        box(pu1 + 1.2, pv0 - 0.2, bU2, pv1 + 0.2, Y, Y + 0.3, P.side, P.lawnHi);
        for (let vv = pv0 + 1.2; vv < pv1 - 0.6; vv += 2.6) tree((pu1 + 1.2 + bU2) / 2, vv, 0.7);
        bushes((pu1 + 1.2 + bU2) / 2, pv1 - 0.4, 3);
      }
      if (bV2 - 4.2 - pv1 > 2.5) {
        let [p0, p1] = Uc(a2 + 0.6, a2 + 4.6);
        box(p0, pv1 + 1.0, p1, pv1 + 1.2, Y, Y + 0.12, P.white);
        flat(p0, pv1 + 1.2, p1, Math.min(bV2 - 4.0, pv1 + 3.4), Y + 0.05, P.water);
        [p0, p1] = Uc(a2 + 5.4, bU2 - 0.4);
        if (p1 - p0 > 2) {
          box(p0, pv1 + 1.0, p1, Math.min(bV2 - 4.0, pv1 + 3.4), Y, Y + 0.3, P.side, P.lawnHi);
          bushes((p0 + p1) / 2, pv1 + 2.2, 4);
        }
      }
      box(pu0 - 0.3, pv0 - 0.3, pu1 + 0.3, pv0, Y, Y + 0.14, P.white);
      box(pu0 - 0.3, pv1, pu1 + 0.3, pv1 + 0.3, Y, Y + 0.14, P.white);
      box(pu0 - 0.3, pv0, pu0, pv1, Y, Y + 0.14, P.white);
      box(pu1, pv0, pu1 + 0.3, pv1, Y, Y + 0.14, P.white);
      // r13: ref05's pool is a two-tone mosaic with beach balls and rings
      // floating in it, not a flat blue sheet with lane lines.
      poolWater(pu0, pv0, pu1, pv1, Y + 0.05);
      const fl = [P.red, P.yellow, P.orange, P.pink, P.teal];
      const nb = 3 + ((pu1 - pu0) * (pv1 - pv0) > 60 ? 2 : 0);
      for (let q = 0; q < nb; q++) {
        const uu = pu0 + 1.0 + hr(70 + q) * (pu1 - pu0 - 2), vv = pv0 + 0.9 + hr(80 + q) * (pv1 - pv0 - 1.8);
        if (q & 1) {
          const c = fl[q % fl.length];
          box(uu - 0.45, vv - 0.45, uu + 0.45, vv - 0.2, Y + 0.02, Y + 0.24, c); box(uu - 0.45, vv + 0.2, uu + 0.45, vv + 0.45, Y + 0.02, Y + 0.24, c);
          box(uu - 0.45, vv - 0.2, uu - 0.2, vv + 0.2, Y + 0.02, Y + 0.24, P.white); box(uu + 0.2, vv - 0.2, uu + 0.45, vv + 0.2, Y + 0.02, Y + 0.24, P.white);
        } else ball(uu, vv, Y - 0.1, fl[q % fl.length]);
      }
      // diving board + ladder at the deep end
      const dvm = (pv0 + pv1) / 2;
      box(pu1 - 0.2, dvm - 0.35, pu1 + 1.2, dvm + 0.35, Y + 0.45, Y + 0.6, P.white, P.blue);
      box(pu1 + 0.7, dvm - 0.3, pu1 + 1.2, dvm + 0.3, Y, Y + 0.45, P.side);
      box(pu0 - 0.3, pv0 + 0.9, pu0 + 0.05, pv0 + 1.1, Y, Y + 0.7, P.white);
      box(pu0 - 0.3, pv0 + 1.5, pu0 + 0.05, pv0 + 1.7, Y, Y + 0.7, P.white);
      // back deck: lounger pairs under striped parasols, shoulder to shoulder
      const lc = [P.white, P.orange, P.blue][hr(4) * 3 | 0];
      let k = 0;
      for (let uu = a2 + 1.2; uu + 1.0 < bU2 - 3.0; uu += 2.3, k++) {
        loungers(uu, bV2 - 2.1, [P.red, P.teal, P.yellow, P.orange][k % 4], lc);
      }
      shed(bU2 - 2.6, bV2 - 2.6, bU2, bV2, P.white, P.teal);
      // front deck strip: towels and a ball on the tiles
      for (let uu = pu0 + 0.6, q = 0; uu + 1.0 < pu1; uu += 2.6, q++) {
        if (pv0 - 0.3 - (a2 - 0.2) < 1.0) break;
        flat(uu, a2 - 0.1, uu + 0.8, pv0 - 0.45, Y + 3 * E, fl[q % fl.length]);
      }
    } else if (design === 16) {
      // Civic monument (ref05's obelisk block), r7: a grey tiled walk round
      // the edge, a hedge ring with a gap on every side, terracotta ground
      // inside, a stepped monument in the middle with statues on its
      // corners, twin pools in front, lawn beds with bush clumps behind,
      // trees and lamps on the walk.
      tiles(a, a, bU, bV, Y, P.tileA, P.tileB, 2.0);
      const cu = L / 2, cv = D / 2;
      const wk = 1.5, ht = 0.8;
      const i0u = a + wk, i1u = bU - wk, i0v = a + wk, i1v = bV - wk;
      const t0u = i0u + ht, t1u = i1u - ht, t0v = i0v + ht, t1v = i1v - ht;
      // r13b: the terracotta ground is laid in small two-tone tiles, not a
      // flat sheet (critic r12: lots "mostly flat plain … grey").
      tiles(t0u, t0v, t1u, t1v, y1, P.terra, P.terraLo, 1.2);
      tiles(cu - 1.7, i0v, cu + 1.7, i1v, y1 + E, P.terra, P.terraLo, 1.2);
      tiles(i0u, cv - 1.7, i1u, cv + 1.7, y1 + E, P.terra, P.terraLo, 1.2);
      hedgeBorder(i0u, i0v, i1u, i1v, ht, 3.4, true);
      // walk: a tree at each corner, lamps between
      for (const [pu, pv] of [[a + 0.75, a + 0.75], [bU - 0.75, a + 0.75], [a + 0.75, bV - 0.75], [bU - 0.75, bV - 0.75]]) {
        box(pu - 0.6, pv - 0.6, pu + 0.6, pv + 0.6, Y, Y + 0.3, P.side, P.lawnHi);
        tree(pu, pv, 0.55);
      }
      for (const uu of [cu - 3.2, cu + 3.2]) { lamp(uu, a + 0.6); lamp(uu, bV - 0.6); }
      for (const vv of [cv - 3.2, cv + 3.2]) { lamp(a + 0.6, vv); lamp(bU - 0.6, vv); }
      // monument
      const m = Math.min(t1u - t0u, t1v - t0v);
      const s0 = Math.max(1.6, Math.min(4.0, m * 0.26));
      box(cu - s0, cv - s0, cu + s0, cv + s0, Y, Y + 0.35, P.stone, P.curb);
      box(cu - s0 * 0.74, cv - s0 * 0.74, cu + s0 * 0.74, cv + s0 * 0.74, Y + 0.35, Y + 0.75, P.stone, P.curb);
      box(cu - s0 * 0.5, cv - s0 * 0.5, cu + s0 * 0.5, cv + s0 * 0.5, Y + 0.75, Y + 1.2, P.stone, P.white);
      // front stair
      box(cu - 0.9, cv - s0 - 0.6, cu + 0.9, cv - s0, Y, Y + 0.18, P.stone, P.curb);
      if (hr(9) < 0.6) {
        const ob = Math.max(0.35, s0 * 0.16);
        box(cu - ob * 1.4, cv - ob * 1.4, cu + ob * 1.4, cv + ob * 1.4, Y + 1.2, Y + 1.9, P.stone);
        box(cu - ob, cv - ob, cu + ob, cv + ob, Y + 1.9, Y + 1.9 + s0 * 1.9, P.white);
        box(cu - ob * 0.55, cv - ob * 0.55, cu + ob * 0.55, cv + ob * 0.55, Y + 1.9 + s0 * 1.9, Y + 2.4 + s0 * 1.9, P.stone);
      } else {
        box(cu - s0 * 0.42, cv - s0 * 0.42, cu + s0 * 0.42, cv + s0 * 0.42, Y + 1.2, Y + 1.45, P.white);
        flat(cu - s0 * 0.34, cv - s0 * 0.34, cu + s0 * 0.34, cv + s0 * 0.34, Y + 1.46, P.water);
        box(cu - 0.25, cv - 0.25, cu + 0.25, cv + 0.25, Y + 1.2, Y + 2.4, P.stone);
        box(cu - 0.45, cv - 0.45, cu + 0.45, cv + 0.45, Y + 2.4, Y + 2.55, P.water);
      }
      if (s0 >= 2.4) for (const [du, dv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) statue(cu + du * s0 * 0.87, cv + dv * s0 * 0.87, 0.6);
      // twin pools in front of the monument, lawn beds + bushes behind
      const fv0 = t0v + 0.5, fv1 = cv - s0 - 0.8;
      const lu0 = t0u + 0.5, lu1 = cu - 2.0, ru0 = cu + 2.0, ru1 = t1u - 0.5;
      if (fv1 - fv0 >= 1.8 && lu1 - lu0 >= 1.8) {
        for (const [p0, p1] of [[lu0, lu1], [ru0, ru1]]) {
          const q1 = Math.min(p1, p0 + 5), q0 = Math.max(p0, p1 - 5);
          const [e0, e1] = p0 === lu0 ? [q0, p1] : [p0, q1];
          box(e0, fv0, e1, fv1, Y, Y + 0.2, P.white);
          flat(e0 + 0.25, fv0 + 0.25, e1 - 0.25, fv1 - 0.25, Y + 0.21, P.water);
        }
      }
      const bv0 = cv + s0 + 0.8, bv1 = t1v - 0.5;
      if (bv1 - bv0 >= 1.8 && lu1 - lu0 >= 1.8) {
        let kq = 0;
        for (const [p0, p1] of [[lu0, lu1], [ru0, ru1]]) {
          box(p0, bv0, p1, bv1, Y, Y + 0.18, P.side, P.lawnHi);
          for (let uu = p0 + 0.9; uu < p1 - 0.5; uu += 2.2) {
            for (let vv = bv0 + 0.9; vv < bv1 - 0.5; vv += 2.2) bushes(uu, vv, kq++);
          }
        }
      }
      // flank beds either side of the monument
      if (cu - s0 - 1.2 - t0u >= 2.2) {
        const k0 = (hr(8) * 5) | 0;
        bed(t0u + 0.5, cv - 1.0, cu - s0 - 1.2, cv + 1.0, k0);
        bed(cu + s0 + 1.2, cv - 1.0, t1u - 0.5, cv + 1.0, k0 + 2);
      }
      bench(cu - 1.0, bV - 0.55, cu + 1.0);
    } else if (design === 7) {
      // Works yard: packed dirt, a shipping container, stacked crates and a
      // few barrels — the industrial lot.
      // r13b (critic r12: "large empty areas … a big flat lot"): the yard is
      // laid as two-tone concrete slabs, and pallet rows fill the open middle
      // either side of a forklift lane, so no tan sheet is left bare.
      tiles(a, a, bU, bV, Y, P.yard, P.dirtDk, 2.0);
      const cc = [P.blue, P.red, P.teal, P.orange][(hr(6) * 4) | 0];
      let [p0, p1] = Uc(a + 0.4, a + 5.4);
      box(p0, bV - 2.4, p1, bV - 0.4, Y, Y + 2.0, cc, P.white);
      for (let q = 0; q < 4; q++) flat(p0 + 0.5 + q * 1.2, bV - 2.45, p0 + 0.62 + q * 1.2, bV - 0.35, Y + 2.01, P.line);
      crateStack(U(5.6) - 0.45, 3.0, 5);
      for (let q = 0; q < 3; q++) {
        const uu = U(1.4 + q * 0.9);
        box(uu - 0.35, 1.2, uu + 0.35, 1.9, Y, Y + 0.9, q === 1 ? P.yellow : P.barrel);
      }
      {
        const pc = [P.crate, P.blue, P.crate, P.teal, P.crate, P.red];
        const lane = (a + bV) / 2;
        let q = 0;
        // keep-out rects (unmirrored u): container, crate stack, barrels
        const keep = [[a + 0.4, bV - 2.4, a + 5.4, bV - 0.4], [5.15, 2.6, 6.95, 4.4], [1.05, 1.2, 3.55, 1.9]];
        const busy = (uu, vv) => keep.some(([k0, l0, k1, l1]) => uu > k0 - 0.55 && uu < k1 + 0.55 && vv > l0 - 0.55 && vv < l1 + 0.55);
        for (let uu = a + 0.75; uu < bU - 0.6; uu += 1.35) {
          for (let vv = a + 0.8; vv < bV - 0.6; vv += 1.3) {
            if (bU > 11 && Math.abs(vv - lane) < 1.1) continue;
            if (busy(uu, vv)) continue;
            const hq = hr(1200 + q++);
            if (hq < 0.2) continue;
            pallet(U(uu), vv, pc[(hq * 97 | 0) % pc.length]);
            if (hq > 0.75) box(U(uu) - 0.38, vv - 0.38, U(uu) + 0.38, vv + 0.38, Y + 0.72, Y + 1.25, P.crate, P.wood);
          }
        }
        // stripe the forklift lane and park a forklift in it
        if (bU > 11) for (let uu = 7.2; uu < bU - 0.8; uu += 1.6) flat(U(uu) - 0.35, lane - 0.06, U(uu) + 0.35, lane + 0.06, y2, P.line);
        if (bU > 11) {
          const fu = U(Math.min(bU - 2, 10.5));
          box(fu - 0.45, lane - 0.35, fu + 0.45, lane + 0.35, Y + 0.12, Y + 0.7, P.yellow);
          box(fu - 0.3, lane - 0.3, fu + 0.2, lane + 0.3, Y + 0.7, Y + 1.2, P.glass, P.barrel);
          box(fu + 0.45, lane - 0.3, fu + 0.55, lane + 0.3, Y, Y + 1.3, P.barrel);
        }
      }
    } else if (design === 8) {
      // Basketball court: paving, a coloured court with white lines and a hoop.
      tiles(a, a, bU, bV, Y, P.tileA, P.tileB, 1.6);
      flat(a + 0.5, a + 0.5, bU - 0.5, bV - 0.5, y1, P.court);
      flat(a + 1.0, a + 1.0, bU - 1.0, bV - 1.0, y2, P.courtIn);
      lineU(a + 0.5, bU - 0.5, a + 0.5, y2); lineU(a + 0.5, bU - 0.5, bV - 0.5, y2);
      lineV(a + 0.5, a + 0.5, bV - 0.5, y2); lineV(bU - 0.5, a + 0.5, bV - 0.5, y2);
      lineU(a + 0.5, bU - 0.5, D / 2, y2 + E);
      box(L / 2 - 0.1, bV - 0.9, L / 2 + 0.1, bV - 0.7, Y, Y + 2.4, P.white);
      box(L / 2 - 0.6, bV - 1.0, L / 2 + 0.6, bV - 0.9, Y + 2.0, Y + 2.7, P.white);
      box(L / 2 - 0.25, bV - 1.45, L / 2 + 0.25, bV - 1.0, Y + 2.0, Y + 2.08, P.orange);
    } else if (design === 11) {
      // Market square, r11 (critic r10: "bare pale grey with stalls on it";
      // ref05's market is mid-grey cobbled setts cut into blocks by light
      // cream walkways, and every block holds a DIFFERENT stand -- a big
      // wooden produce bed of colourful crates, a pair of white canopy
      // tents, a cluster of striped parasols over tables, awning stalls).
      const wk = 1.1, m0 = a + 0.15;
      const spanU = bU - 0.15 - m0, spanV = bV - 0.15 - m0;
      const nU = Math.max(1, Math.round((spanU - wk) / 7.0)), nV = Math.max(1, Math.round((spanV - wk) / 5.6));
      const cw = (spanU - wk * (nU + 1)) / nU, cd = (spanV - wk * (nV + 1)) / nV;
      cobbles(a, a, bU, bV, Y);
      // thin light walk lines in the gaps between the blocks (ref05)
      const wl = 0.55;
      for (let q = 0; q <= nU; q++) { const u = m0 + q * (cw + wk) + (wk - wl) / 2; flat(u, m0, u + wl, bV - 0.15, Y + 3 * E, P.walk); }
      for (let q = 0; q <= nV; q++) { const v = m0 + q * (cd + wk) + (wk - wl) / 2; flat(m0, v, bU - 0.15, v + wl, Y + 4 * E, P.walk); }
      let k = (hr(7) * 5) | 0;
      const kinds = [0, 1, 0, 2, 0, 3, 1, 2];     // produce beds dominate, like ref05
      const ko = (hr(17) * kinds.length) | 0;
      for (let q = 0; q < nU; q++) {
        for (let e = 0; e < nV; e++) {
          const u0 = m0 + wk + q * (cw + wk), v0 = m0 + wk + e * (cd + wk), u1 = u0 + cw, v1 = v0 + cd;
          const kind = kinds[(ko + q * 3 + e * 5 + ((hr(900 + q * 7 + e) * 2) | 0)) % kinds.length];
          const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
          if (kind === 0) {
            produceBed(u0 + 0.15, v0 + 0.15, u1 - 0.15, v1 - 0.15, k++);
          } else if (kind === 1) {
            // r13b (critic r12: lots with "big blank areas"): white canopy
            // tents packed in a grid that fills the block, not a lone pair
            const nu = Math.max(1, Math.floor(cw / 2.5)), nv = Math.max(1, Math.floor(cd / 2.7));
            const tw = cw / nu, td = cd / nv;
            for (let p = 0; p < nu; p++) for (let o = 0; o < nv; o++) {
              tent(u0 + (p + 0.5) * tw, v0 + (o + 0.5) * td, tw - 0.35, Math.min(2.5, td - 0.4), k++);
            }
          } else if (kind === 2) {
            // striped parasols over tables on a grid that fills the block
            const nu = Math.max(1, Math.floor(cw / 2.3)), nv = Math.max(1, Math.floor(cd / 2.3));
            for (let p = 0; p < nu; p++) for (let o = 0; o < nv; o++) {
              const uu = u0 + (p + 0.5) * cw / nu, vv = v0 + (o + 0.5) * cd / nv;
              parasolTable(uu, vv, [P.red, P.teal, P.orange, P.yellow][(k + p + o) % 4]);
            }
            k++;
          } else {
            // rows of awning stalls back to back
            const nu = Math.max(1, Math.floor(cw / 2.5)), nv = Math.max(1, Math.floor(cd / 2.1));
            for (let p = 0; p < nu; p++) for (let o = 0; o < nv; o++) {
              stall(u0 + (p + 0.5) * cw / nu, v0 + (o + 0.5) * cd / nv, [P.red, P.teal, P.orange, P.blue, P.pink][(k + p + o * 2) % 5], k + p + o);
            }
            k++;
          }
          // sacks / barrels at the walk corner
          if (hr(950 + q * 11 + e) < 0.5) box(u1 - 0.55, v0 + 0.15, u1 - 0.15, v0 + 0.55, Y, Y + 0.5, P.barrel, P.wood);
        }
      }
      // planters with trees on the back corners, cube-bush planter along the back
      box(a + 0.2, bV - 1.6, a + 1.6, bV - 0.2, Y, Y + 0.4, P.side, P.lawnDk);
      tree(a + 0.9, bV - 0.9, 0.7);
      box(bU - 1.6, bV - 1.6, bU - 0.2, bV - 0.2, Y, Y + 0.4, P.side, P.lawnDk);
      tree(bU - 0.9, bV - 0.9, 0.7);
    } else if (design === 13) {
      // Town park, r7 (ref05 park / camp blocks): lawn inside a hedge ring
      // with a gap on every side, terracotta dirt paths in a cross through
      // the gaps, a fountain where they meet, tree rows and bush clumps in the
      // quadrants, flower beds, benches and lamps. Flush on the field it
      // keeps its paths, fountain and trees but no hedge ring or lawn.
      // r13 (critic r12: "park squares … mostly flat plain green inside a thin
      // hedge ring"): the square is PAVED in warm tan tiles; the lawn is only
      // kerbed grass beds in the quadrants, so paving, beds, paths and props
      // fill it edge to edge like ref05's monument / tower lots.
      if (flush) lawn(a, a, bU, bV);
      else tiles(a, a, bU, bV, Y, P.sandPave, P.sandPave2, 2.0);
      const grassBed = (u0, v0, u1, v1) => {
        box(u0, v0, u1, v1, Y, Y + 0.14, P.curb);
        flat(u0 + 0.22, v0 + 0.22, u1 - 0.22, v1 - 0.22, Y + 0.145, null);
      };
      const cu = L / 2, cv = D / 2, pw = 0.8;
      const ht = 0.75, g = 2.6;
      // r8: grey stone paths (the terracotta ground belongs to the civic
      // monument, 16) so a park and a plaza never read as the same lot.
      flat(cu - pw, a, cu + pw, bV, y2, P.tileA);
      flat(a, cv - pw, bU, cv + pw, y2, P.tileA);
      if (!flush) {
        hedgeBorder(a + 0.1, a + 0.1, bU - 0.1, bV - 0.1, ht, g, true);
        // grey paved apron round the fountain
        tiles(cu - 2.4, cv - 2.4, cu + 2.4, cv + 2.4, Y + 3 * E, P.tileA, P.tileB, 1.6);
      }
      box(cu - 1.5, cv - 1.5, cu + 1.5, cv + 1.5, Y, Y + 0.3, P.curb);
      flat(cu - 1.2, cv - 1.2, cu + 1.2, cv + 1.2, Y + 0.31, P.water);
      box(cu - 0.2, cv - 0.2, cu + 0.2, cv + 0.2, Y, Y + 1.0, P.curb);
      box(cu - 0.3, cv - 0.3, cu + 0.3, cv + 0.3, Y + 1.0, Y + 1.12, P.water);
      const in0 = a + (flush ? 0.6 : 1.3), in1u = bU - (flush ? 0.6 : 1.3), in1v = bV - (flush ? 0.6 : 1.3);
      // quadrants: [u0,u1] x [v0,v1] between hedge and paths
      const quads = [[in0, cu - pw - 0.4, in0, cv - pw - 0.4], [cu + pw + 0.4, in1u, in0, cv - pw - 0.4],
        [in0, cu - pw - 0.4, cv + pw + 0.4, in1v], [cu + pw + 0.4, in1u, cv + pw + 0.4, in1v]];
      const k0 = (hr(8) * 5) | 0;
      let kq = 0;
      quads.forEach(([u0, u1, v0, v1], qi) => {
        if (u1 - u0 < 1.6 || v1 - v0 < 1.6) return;
        const mode = (qi + (hr(12) * 4 | 0)) & 3;
        if (!flush && mode !== 1 && mode !== 2) grassBed(u0, v0, u1, v1);
        else if (!flush && mode === 2) grassBed(qi & 1 ? u1 - 2.2 : u0, v0, qi & 1 ? u1 : u0 + 2.2, v1);
        const outerU = qi & 1 ? u1 - 1.0 : u0 + 1.0;       // tree row on the outer flank
        for (let vv = v0 + 1.0; vv < v1 - 0.6; vv += 2.8) tree(outerU, vv, 0.72);
        const iu0 = qi & 1 ? u0 : u0 + 2.2, iu1 = qi & 1 ? u1 - 2.2 : u1;
        if (iu1 - iu0 < 1.4) return;
        if (mode === 0 && !flush) {
          bed(iu0 + 0.3, v0 + 0.3, Math.min(iu1 - 0.3, iu0 + 4.2), Math.min(v1 - 0.3, v0 + 2.0), k0 + qi);
          if (v1 - v0 > 4.2) bed(iu0 + 0.3, v1 - 2.0, Math.min(iu1 - 0.3, iu0 + 4.2), v1 - 0.3, k0 + qi + 2);
          if (iu1 - iu0 > 5.4) bushes(iu1 - 1.0, (v0 + v1) / 2, 60 + qi);
        }
        else if (mode === 1 && !flush) {
          // r11: the shrubbery stands in a kerbed dark-grass bed (a sub-zone)
          box(iu0 + 0.2, v0 + 0.2, iu1 - 0.2, v1 - 0.2, Y, Y + 0.14, P.curb, P.lawnDk);
          for (let uu = iu0 + 0.8; uu < iu1 - 0.4; uu += 2.4) for (let vv = v0 + 0.8; vv < v1 - 0.4; vv += 2.6) bushes(uu, vv, kq++);
        } else if (mode === 2) {
          // r11: a worn terracotta picnic yard with a bench and a table
          flat(iu0 + 0.2, v0 + 0.2, iu1 - 0.2, v1 - 0.2, Y + 3 * E, P.terra);
          flat(iu0 + 0.5, v0 + 0.5, iu1 - 0.5, v1 - 0.5, Y + 4 * E, P.terraLo);
          const bv = qi < 2 ? v1 - 0.6 : v0 + 0.6;
          bench(iu0 + 0.5, bv, Math.min(iu1 - 0.3, iu0 + 1.9));
          const pu = (iu0 + iu1) / 2 + 0.6, pv = (v0 + v1) / 2;
          if (iu1 - iu0 > 3.2 && v1 - v0 > 2.6) {
            box(pu - 0.8, pv - 0.45, pu + 0.8, pv + 0.45, Y + 0.5, Y + 0.62, P.wood);
            box(pu - 0.8, pv - 0.95, pu + 0.8, pv - 0.7, Y + 0.25, Y + 0.35, P.wood);
            box(pu - 0.8, pv + 0.7, pu + 0.8, pv + 0.95, Y + 0.25, Y + 0.35, P.wood);
            box(pu - 0.1, pv - 0.1, pu + 0.1, pv + 0.1, Y, Y + 0.5, P.wood);
          }
        } else {
          // r13b: an orchard grid of trees with bushes in the gaps fills the
          // bed (one tree row left most of it plain green)
          const nr = Math.max(1, Math.floor((v1 - v0) / 2.4));
          let kk = 0;
          for (let j = 0; j < nr; j++) {
            const vv = v0 + (j + 0.5) * (v1 - v0) / nr;
            for (let uu = iu0 + 0.9 + (j & 1) * 1.3; uu < iu1 - 0.6; uu += 2.6, kk++) {
              if (hr(1300 + qi * 41 + kk) < 0.75) tree(uu, vv, 0.56);
              else bushes(uu, vv, 70 + qi * 9 + kk);
            }
          }
        }
      });
      lamp(cu + pw + 0.3, cv - 2.9); lamp(cu - pw - 0.3, cv + 2.9);
    } else if (design === 14) {
      // Sports: a pitch with white lines and goals when there is room for
      // one, otherwise a tennis court; a small stand along the back. Flush
      // on the field the pitch lies straight on the grass (no paved apron).
      if (!flush) tiles(a, a, bU, bV, Y, P.tileA, P.tileB, 2.0);
      const pitch = L >= 15 && D >= 15;
      // r8: over the tiles' second tone (y + E) -- was y1 and z-fought into a checkerboard
      let y3 = Y + 3 * E;
      let u0 = a + 1.0, u1 = bU - 1.0, v0 = a + 1.0, v1 = bV - 2.4;
      // r13 (critic r12: "the football pitch … mostly flat plain green inside
      // a thin ring … ref05 packs something distinct into every block"): on a
      // big lot the track + pitch shrink to make room for a car park along the
      // street, a clubhouse with floodlights down one flank and a real
      // stepped stand with coloured seats along the back.
      let ta0 = a + 0.6, ta1 = bU - 0.6, tb0 = a + 0.6, tb1 = bV - 2.0;
      const club = pitch && !flush && L >= 20 && D >= 20;
      if (club) {
        const pk = 5.0, cw = 3.6, st = 3.4;
        // car park strip along the street
        flat(a + 0.3, a + 0.3, bU - 0.3, a + pk, y1, P.asphalt);
        const nbay = Math.floor((bU - a - 3.0) / 1.5);
        const bu0 = a + 1.5 + ((bU - a - 3.0) - nbay * 1.5) / 2;
        for (let q = 0; q <= nbay; q++) flat(bu0 + q * 1.5 - 0.06, a + 0.5, bu0 + q * 1.5 + 0.06, a + 4.2, y2, P.line);
        for (let q = 0; q < nbay; q++) if (hr(1300 + q) < 0.9) car(bu0 + (q + 0.5) * 1.5, a + 2.4, carCols[(hr(1320 + q) * carCols.length) | 0]);
        box(a + 0.3, a + pk - 0.05, bU - 0.3, a + pk + 0.55, Y, Y + 0.3, P.curb, P.lawnDk);
        for (let uu = a + 1.0, q = 0; uu < bU - 0.8; uu += 1.1, q++) {
          if (q % 4 === 2) continue;   // gaps to walk through
          box(uu - 0.38, a + pk + 0.02, uu + 0.38, a + pk + 0.48, Y + 0.3, Y + 0.75 + hr(1340 + q) * 0.25, P.hedge, P.hedgeTop);
        }
        // clubhouse on one flank, floodlights at the corners
        const [c0, c1] = Uc(a + 0.4, a + cw);
        const cv0 = a + pk + 1.3, cv1 = Math.min(bV - st - 0.6, cv0 + 6.5);
        box(c0, cv0, c1, cv1, Y, Y + 2.2, P.white, P.roofGrey);
        box(c0 - 0.15, cv0 - 0.15, c1 + 0.15, cv1 + 0.15, Y + 2.2, Y + 2.4, P.seatA);
        box(c0 - 0.02, cv0 + 0.6, c1 + 0.02, cv1 - 0.6, Y + 0.9, Y + 1.7, P.glass);
        box(c0 + 0.6, cv0 + 1.0, c0 + 1.5, cv0 + 1.9, Y + 2.4, Y + 2.8, P.barrel);
        const [f0, f1] = Uc(a + 0.4, a + cw);
        if (bV - st - 0.6 - cv1 > 2.2) treeBox((f0 + f1) / 2, (cv1 + bV - st - 0.6) / 2, 0.55);
        for (let q = 0; q < 2; q++) pallet(mir ? c0 - 0.6 : c1 + 0.6, cv0 + 0.8 + q * 1.2, [P.blue, P.orange][q]);
        // stand along the back: 4 stepped rows of coloured seats + a roof
        const sv0 = bV - st, su0 = a + 0.5, su1 = bU - 0.5;
        for (let q = 0; q < 4; q++) {
          const vv0 = sv0 + q * 0.7, vv1 = vv0 + 0.7, hy = Y + 0.35 + q * 0.4;
          box(su0, vv0, su1, vv1, Y, hy, P.side, P.curb);
          const ns = Math.max(4, Math.round((su1 - su0) / 0.55));
          for (let j = 0; j < ns; j += 2) {
            const s0 = su0 + j * (su1 - su0) / ns, s1 = s0 + (su1 - su0) / ns * 0.8;
            const c = ((j >> 1) + q) % 7 === 0 ? P.white : (q & 1 ? P.seatB : P.seatA);
            box(s0, vv0 + 0.1, s1, vv0 + 0.4, hy, hy + 0.18, c);
          }
        }
        for (const uu of [su0 + 0.2, (su0 + su1) / 2, su1 - 0.2]) box(uu - 0.1, bV - 0.5, uu + 0.1, bV - 0.3, Y, Y + 3.3, P.white);
        box(su0, bV - 1.6, su1, bV - 0.2, Y + 3.3, Y + 3.5, P.white, P.roofGrey);
        // track + pitch fill what is left
        const [t0, t1] = Uc(a + cw + 0.6, bU - 0.6);
        ta0 = t0; ta1 = t1; tb0 = a + pk + 1.0; tb1 = sv0 - 0.5;
        flood(mir ? ta1 + 0.3 : ta0 - 0.3, tb0 + 0.3);
        flood(mir ? ta0 - 0.3 : ta1 + 0.3, tb0 + 0.3);
        flood(mir ? ta1 + 0.3 : ta0 - 0.3, tb1 - 0.3);
        flood(mir ? ta0 - 0.3 : ta1 + 0.3, tb1 - 0.3);
        v1 = tb1;
      }
      if (pitch) {
        // r11: a red running track round a mown-striped pitch, so the lot is
        // not one flat green sheet (critic r10: "no large single-colour area")
        flat(ta0, tb0, ta1, tb1, y2, P.track);
        const t0u = ta0 + 0.8, t0v = tb0 + 0.8, t1u = ta1 - 0.8, t1v = tb1 - 0.8;
        lineU(t0u, t1u, t0v, y2 + E); lineU(t0u, t1u, t1v, y2 + E); lineV(t0u, t0v, t1v, y2 + E); lineV(t1u, t0v, t1v, y2 + E);
        const g0u = ta0 + 1.7, g1u = ta1 - 1.7, g0v = tb0 + 1.7, g1v = tb1 - 1.7;
        flat(g0u, g0v, g1u, g1v, Y + 4 * E, P.pitch);
        const longU = (g1u - g0u) >= (g1v - g0v);
        const span = longU ? g1u - g0u : g1v - g0v, ns = Math.max(4, Math.round(span / 1.8));
        for (let q = 1; q < ns; q += 2) {
          const s0 = q * span / ns, s1 = (q + 1) * span / ns;
          if (longU) flat(g0u + s0, g0v, g0u + s1, g1v, Y + 5 * E, P.pitchLt);
          else flat(g0u, g0v + s0, g1u, g0v + s1, Y + 5 * E, P.pitchLt);
        }
        u0 = g0u + 0.4; u1 = g1u - 0.4; v0 = g0v + 0.4; v1 = g1v - 0.4; y3 = Y + 6 * E;
      } else flat(a + 0.6, a + 0.6, bU - 0.6, bV - 2.0, y2, P.court);
      lineU(u0, u1, v0, y3); lineU(u0, u1, v1, y3); lineV(u0, v0, v1, y3); lineV(u1, v0, v1, y3);
      const long = (u1 - u0) >= (v1 - v0);
      if (long) lineV((u0 + u1) / 2, v0, v1, y3); else lineU(u0, u1, (v0 + v1) / 2, y3);
      if (pitch) {
        const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
        lineU(mu - 1.2, mu + 1.2, mv - 1.2, y3); lineU(mu - 1.2, mu + 1.2, mv + 1.2, y3);
        lineV(mu - 1.2, mv - 1.2, mv + 1.2, y3); lineV(mu + 1.2, mv - 1.2, mv + 1.2, y3);
        for (const gu of [u0, u1]) {
          box(gu - 0.08, mv - 1.3, gu + 0.08, mv - 1.14, Y, Y + 1.0, P.white);
          box(gu - 0.08, mv + 1.14, gu + 0.08, mv + 1.3, Y, Y + 1.0, P.white);
          box(gu - 0.08, mv - 1.3, gu + 0.08, mv + 1.3, Y + 1.0, Y + 1.14, P.white);
        }
      } else if (long) {
        const mu = (u0 + u1) / 2;
        box(mu - 0.06, v0 - 0.3, mu + 0.06, v1 + 0.3, Y + 0.3, Y + 0.6, P.white);
      } else {
        const mv = (v0 + v1) / 2;
        box(u0 - 0.3, mv - 0.06, u1 + 0.3, mv + 0.06, Y + 0.3, Y + 0.6, P.white);
      }
      // stand: three stepped benches along the back
      if (!club) for (let q = 0; q < 3; q++) {
        box(a + 1.0, bV - 1.8 + q * 0.5, bU - 1.0, bV - 1.3 + q * 0.5, Y, Y + 0.3 + q * 0.3,
          q === 1 ? P.blue : P.white);
      }
    } else if (design === 17) {
      // Camper park (ref05's trailer park, r8): light tan packed dirt, a
      // hedge-cube border open to the street, a grid of grass pitches each
      // with a white caravan (coloured stripe, awning), the odd car and
      // picnic table, and a green with a gazebo in the middle of a big lot.
      flat(a, a, bU, bV, Y, P.camp);
      if (!flush) hedgeBorder(a + 0.1, a + 0.1, bU - 0.1, bV - 0.1, 0.6, 3.0, false);
      const iu0 = a + 1.0, iu1 = bU - 1.0, iv0 = a + 1.3, iv1 = bV - 1.0;
      const pu = 3.4, pv = 4.2;
      const nu = Math.max(1, Math.floor((iu1 - iu0) / pu)), nv = Math.max(1, Math.floor((iv1 - iv0) / pv));
      const ou = iu0 + (iu1 - iu0 - nu * pu) / 2 + pu / 2, ov = iv0 + (iv1 - iv0 - nv * pv) / 2 + pv / 2;
      const gq = nu >= 3 && nv >= 3 ? [(nu - 1) >> 1, (nv - 1) >> 1] : null;
      // r11: grey gravel lanes between the pitch rows and a wider one in from
      // the street, so the tan ground is cut into sub-zones like ref05's park
      for (let k = 0; k <= nv; k++) { const vv = ov - pv / 2 + k * pv; flat(iu0 - 0.3, vv - 0.34, iu1 + 0.3, vv + 0.34, y1, P.gravel); }
      { const lu = ou - pu / 2 + Math.floor(nu / 2) * pu; flat(lu - 0.5, a, lu + 0.5, iv1, y2, P.gravel); }
      const stripes = [P.teal, P.red, P.blue, P.orange, P.yellow];
      const awns = [P.teal, P.red, P.yellow, P.blue, P.white, 0];
      for (let q = 0; q < nu; q++) {
        for (let k = 0; k < nv; k++) {
          const cu = ou + q * pu, cv = ov + k * pv, hk = hr(500 + q * 13 + k);
          if (gq && q === gq[0] && k === gq[1]) {
            // the park green: lawn, gazebo, flower beds
            flat(cu - 1.55, cv - 1.9, cu + 1.55, cv + 1.9, y1, P.campPad);
            for (const [du, dv] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
              box(cu + du - 0.08, cv + dv - 0.08, cu + du + 0.08, cv + dv + 0.08, Y, Y + 1.4, P.white);
            }
            box(cu - 0.9, cv - 0.9, cu + 0.9, cv + 0.9, Y, Y + 0.12, P.curb);
            box(cu - 1.2, cv - 1.2, cu + 1.2, cv + 1.2, Y + 1.4, Y + 1.6, P.white, P.red);
            box(cu - 0.6, cv - 0.6, cu + 0.6, cv + 0.6, Y + 1.6, Y + 1.9, P.red);
            continue;
          }
          flat(cu - 1.4, cv - 1.75, cu + 1.4, cv + 1.75, y1, P.campPad);
          if (hk < 0.82) {
            const aw = awns[(hr(520 + q * 7 + k) * awns.length) | 0];
            caravan(cu - 0.45, cv, stripes[(hr(540 + q + k * 5) * stripes.length) | 0], aw || null);
            if (hk < 0.18) car(cu + 1.0, cv + 0.2, carCols[(hr(560 + q + k) * carCols.length) | 0]);
          } else if (hk < 0.92) {
            bushes(cu, cv, q * 7 + k);
          } else {
            // picnic table
            box(cu - 0.8, cv - 0.45, cu + 0.8, cv + 0.45, Y + 0.5, Y + 0.62, P.wood);
            box(cu - 0.8, cv - 0.95, cu + 0.8, cv - 0.7, Y + 0.25, Y + 0.35, P.wood);
            box(cu - 0.8, cv + 0.7, cu + 0.8, cv + 0.95, Y + 0.25, Y + 0.35, P.wood);
            box(cu - 0.1, cv - 0.1, cu + 0.1, cv + 0.1, Y, Y + 0.5, P.wood);
          }
        }
      }
    } else if (design === 18) {
      // Truck depot (ref05's warehouse yard, r8): mid grey concrete, rows of
      // white-lined truck bays with orange / white box trucks nose-in, green
      // planter strips between the rows, a planter hedge with trees along the
      // street and a small glass-fronted office at one front corner.
      // r13: two-tone concrete slabs (ref05's yard is a paved grid), not one sheet
      tiles(a, a, bU, bV, Y, P.depot, P.depot2, 3.2);
      // street planter: kerbed lawn strip with trees and hedge cubes
      const sv1 = a + 1.3;
      box(a + 0.3, a + 0.3, bU - 0.3, sv1, Y, Y + 0.28, P.curb, P.lawnDk);
      for (let uu = a + 1.4, q = 0; uu < bU - 1.0; uu += 2.2, q++) {
        if (q % 3 === 1) tree(uu, (a + 0.3 + sv1) / 2, 0.5);
        else box(uu - 0.45, a + 0.4, uu + 0.45, sv1 - 0.1, Y + 0.28, Y + 0.95 + hr(600 + q) * 0.3, P.hedge, P.hedgeTop);
      }
      // office at the front corner
      const ow = Math.min(5.0, (bU - a) * 0.3);
      let [o0, o1] = Uc(a + 0.5, a + 0.5 + ow);
      const ov0 = sv1 + 0.6, ov1 = ov0 + 3.0;
      box(o0, ov0, o1, ov1, Y, Y + 2.3, P.white, P.vanRoof);
      box(o0 - 0.02, ov0 - 0.02, o1 + 0.02, ov1 + 0.02, Y + 0.9, Y + 1.8, P.glass);
      box(o0 + 0.4, ov0 + 0.5, o0 + 1.2, ov0 + 1.3, Y + 2.3, Y + 2.7, P.barrel);
      // bay rows
      const bayW = 1.7, bayD = 5.6, plW = 0.9;
      const rows = [[bV - 0.3 - bayD, bV - 0.3, 1]];
      if (bV - a > 2 * bayD + plW + 6.5) rows.push([rows[0][0] - plW - bayD, rows[0][0] - plW, -1]);
      const uStart = mir ? a + 0.5 : a + 0.5 + ow + 0.8, uEnd = mir ? bU - 0.5 - ow - 0.8 : bU - 0.5;
      const tc = [P.orange, P.white, P.orange, P.teal, P.white, P.red];
      let ck = 0;
      rows.forEach(([v0, v1, dir], ri) => {
        const lo = ri === 0 ? uStart : a + 0.5, hi = ri === 0 ? uEnd : bU - 0.5;
        const nb = Math.max(1, Math.floor((hi - lo) / bayW));
        const u0 = lo + (hi - lo - nb * bayW) / 2;
        for (let q = 0; q <= nb; q++) flat(u0 + q * bayW - 0.07, v0, u0 + q * bayW + 0.07, v1, y1, P.depotLn);
        const vEdge = dir > 0 ? v0 : v1;
        flat(u0, vEdge - 0.07, u0 + nb * bayW, vEdge + 0.07, y1, P.depotLn);
        for (let q = 0; q < nb; q++) {
          if (hr(620 + ck++) < 0.3) continue;
          truck(u0 + (q + 0.5) * bayW, (v0 + v1) / 2 + (dir > 0 ? 0.25 : -0.25), tc[(hr(640 + ck) * tc.length) | 0], dir > 0 ? -1 : 1);
        }
        if (ri === 1) {
          // green planter strip between the two rows (back to back)
          box(u0, v1 + 0.1, u0 + nb * bayW, v1 + plW - 0.1, Y, Y + 0.25, P.curb, P.lawnDk);
          for (let uu = u0 + 1.2; uu < u0 + nb * bayW - 0.8; uu += 3.4) tree(uu, v1 + plW / 2, 0.42);
        }
      });
      // r13 (critic r12: "a big grey truck lot … large empty areas"): the
      // front aisle carries staff parking beside the office and a stacked
      // container yard at the far end, so the yard is full edge to edge.
      let aisleLo = sv1;
      if (rows.length > 1 && rows[1][0] - sv1 > 8.0) {
        const pv0 = sv1 + 0.5, pv1 = pv0 + 4.2;
        const cL = Math.min(9.0, (bU - a) * 0.3);
        const pu0 = mir ? a + 0.5 + cL + 0.6 : o1 + 0.8, pu1 = mir ? o0 - 0.8 : bU - 0.5 - cL - 0.6;
        const nb = Math.max(0, Math.floor((pu1 - pu0) / 1.5));
        for (let q = 0; q <= nb; q++) flat(pu0 + q * 1.5 - 0.06, pv0, pu0 + q * 1.5 + 0.06, pv1, y1, P.depotLn);
        for (let q = 0; q < nb; q++) if (hr(1400 + q) < 0.9) car(pu0 + (q + 0.5) * 1.5, (pv0 + pv1) / 2 - 0.2, carCols[(hr(1420 + q) * carCols.length) | 0]);
        // container yard: two rows, stacked two high here and there
        const cu0 = mir ? a + 0.5 : bU - 0.5 - cL, cu1 = cu0 + cL;
        const ccol = [P.blue, P.red, P.teal, P.orange, P.yellow];
        for (let row = 0; row < 2; row++) {
          const cv0 = pv0 + row * 1.9, cv1 = cv0 + 1.6;
          const nC = Math.max(1, Math.floor(cL / 4.4));
          const cs = cL / nC;
          for (let q = 0; q < nC; q++) {
            const u0c = cu0 + q * cs + 0.15, u1c = cu0 + (q + 1) * cs - 0.15;
            container(u0c, cv0, u1c, cv1, Y, ccol[(hr(1440 + row * 7 + q) * 5) | 0]);
            if (hr(1460 + row * 7 + q) < 0.55) container(u0c, cv0, u1c, cv1, Y + 1.25, ccol[(hr(1480 + row * 7 + q) * 5) | 0]);
          }
        }
        // pallets along the office wall
        for (let q = 0; q < 3; q++) pallet(o0 + 0.6 + q * 1.15, ov1 + 0.9, [P.crate, P.blue, P.crate][q]);
        aisleLo = pv1 + 0.2;
      }
      // aisle dashes
      const aisleV = rows.length > 1 ? (aisleLo + rows[1][0]) / 2 + (aisleLo === sv1 ? 0.8 : 0) : (ov1 + rows[0][0]) / 2;
      for (let uu = a + 1.0; uu + 1.0 < bU - 1.0; uu += 2.2) flat(uu, aisleV - 0.07, uu + 1.0, aisleV + 0.07, y1, P.yellow);
    } else if (design === 19) {
      // Garden plaza, r11 (critic r10: "sand-coloured lots with only a few
      // hedge rows on plain beige"): the lot is cut into SUB-ZONES the way
      // ref05's lots are. Sandy two-tone paving is only the walks; a grey
      // cobbled cross walk with a terracotta fountain court in the middle
      // splits it into quadrants, and each quadrant is a different ground:
      // hedged lawn bed, flower garden rows, a terracotta café terrace, a
      // clumped tree grove or a sand-pit playground. Planter strips of cube
      // bushes and flowers line the rim on the three non-street sides.
      tiles(a, a, bU, bV, Y, P.sandPave, P.sandPave2, 2.0);
      const pl = 0.9;                                   // rim planter width
      const i0u = a + pl + 0.35, i1u = bU - pl - 0.35, i0v = a + 0.6, i1v = bV - pl - 0.35;
      planterRun(a + 0.15, a + 1.8, a + 0.15 + pl, bV - 0.15 - pl, 1);
      planterRun(bU - 0.15 - pl, a + 1.8, bU - 0.15, bV - 0.15 - pl, 2);
      planterRun(a + 0.15, bV - 0.15 - pl, L / 2 - 1.3, bV - 0.15, 3);
      planterRun(L / 2 + 1.3, bV - 0.15 - pl, bU - 0.15, bV - 0.15, 4);
      const cw = 2.0;                                   // cross walk width
      const twoU = i1u - i0u >= 11, twoV = i1v - i0v >= 11;
      const cu = (i0u + i1u) / 2, cv = (i0v + i1v) / 2;
      if (twoU) cobbles(cu - cw / 2, a, cu + cw / 2, bV, y1, P.tileA, P.tileB, P.cobC, P.cobB);
      if (twoV) cobbles(i0u, cv - cw / 2, i1u, cv + cw / 2, y1 + 2 * E, P.tileA, P.tileB, P.cobC, P.cobB);
      if (twoU && twoV) {
        // terracotta fountain court where the walks cross
        flat(cu - 2.4, cv - 1.8, cu + 2.4, cv + 1.8, y1 + 4 * E, P.terra);
        flat(cu - 1.8, cv - 2.4, cu + 1.8, cv + 2.4, y1 + 4 * E, P.terra);
        box(cu - 1.3, cv - 1.3, cu + 1.3, cv + 1.3, Y, Y + 0.3, P.curb);
        flat(cu - 1.0, cv - 1.0, cu + 1.0, cv + 1.0, Y + 0.31, P.water);
        box(cu - 0.2, cv - 0.2, cu + 0.2, cv + 0.2, Y, Y + 0.95, P.curb);
        box(cu - 0.32, cv - 0.32, cu + 0.32, cv + 0.32, Y + 0.95, Y + 1.07, P.water);
      }
      const qs = [];
      const us = twoU ? [[i0u, cu - cw / 2 - 0.4], [cu + cw / 2 + 0.4, i1u]] : [[i0u, i1u]];
      const vs = twoV ? [[i0v + 0.6, cv - cw / 2 - 0.4], [cv + cw / 2 + 0.4, i1v]] : [[i0v + 0.6, i1v]];
      for (const [v0, v1] of vs) for (const [u0, u1] of us) qs.push([u0, v0, u1, v1]);
      const ZN = 5, zo = (hr(19) * ZN) | 0;
      const cols = [P.red, P.teal, P.white, P.orange];
      qs.forEach(([u0, v0, u1, v1], qi) => {
        if (u1 - u0 < 2.5 || v1 - v0 < 2.5) return;
        const zone = (zo + qi * 2) % ZN;
        const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
        if (zone === 0) {
          // hedged lawn bed, r13b (critic r12: "mostly flat plain green"):
          // a hedge along the back, a flower border along the front, and an
          // orderly row of shade trees with bushes between them in the middle
          box(u0, v0, u1, v1, Y, Y + 0.16, P.curb, P.lawnDk);
          hedgeRow(u0 + 0.15, v1 - 0.8, u1 - 0.15, v1 - 0.15, 10 + qi);
          if (v1 - v0 > 3.4) bed(u0 + 0.25, v0 + 0.25, u1 - 0.25, v0 + 1.0, (hr(44 + qi) * 5) | 0);
          const tv = v0 + (v1 - v0 > 3.4 ? 1.0 : 0) + (v1 - 0.8 - v0 - (v1 - v0 > 3.4 ? 1.0 : 0)) / 2;
          const nt = Math.max(1, Math.round((u1 - u0 - 0.6) / 2.4));
          for (let q = 0; q < nt; q++) {
            const uu = u0 + 0.3 + (q + 0.5) * (u1 - u0 - 0.6) / nt;
            if (q & 1) bushes(uu, tv, 20 + qi * 7 + q);
            else tree(uu, tv, 0.58);
          }
        } else if (zone === 1) {
          // flower garden: soil rows of alternating blooms
          let k = (hr(40 + qi) * 5) | 0;
          for (let vv = v0; vv + 0.9 <= v1; vv += 1.35) bed(u0, vv, u1, vv + 0.9, k++);
        } else if (zone === 2) {
          // café terrace on terracotta tiles
          tiles(u0, v0, u1, v1, Y + 3 * E, P.terraTile, P.terraTile2, 1.0);
          const nc = Math.max(1, Math.floor((u1 - u0) / 2.8)), nr = Math.max(1, Math.floor((v1 - v0) / 2.8));
          for (let p = 0; p < nc; p++) for (let q = 0; q < nr; q++) {
            cafe(u0 + (p + 0.5) * (u1 - u0) / nc, v0 + (q + 0.5) * (v1 - v0) / nr, cols[(p + q + qi) % cols.length]);
          }
        } else if (zone === 3) {
          // a clumped grove on dark grass: a few trees shoulder to shoulder,
          // bushes and a rock group round them (not an even grid)
          // r13b (critic r12: "big blank areas"): the grove fills its bed on a
          // loose 2.3-unit grid (tree, or a bush / rock group in a gap), so no
          // plain green is left between the canopies.
          box(u0, v0, u1, v1, Y, Y + 0.16, P.curb, P.lawnDk);
          const nu = Math.max(1, Math.floor((u1 - u0) / 2.3)), nv = Math.max(1, Math.floor((v1 - v0) / 2.3));
          const su = (u1 - u0) / nu, sv = (v1 - v0) / nv;
          let kk = 0;
          for (let p = 0; p < nu; p++) for (let q = 0; q < nv; q++) {
            const hq = hr(60 + qi * 37 + kk++);
            const tu = u0 + (p + 0.5) * su + (hq - 0.5) * 0.4, tv = v0 + (q + 0.5) * sv + (hr(90 + kk) - 0.5) * 0.4;
            if (hq < 0.68) tree(tu, tv, 0.48 + hr(70 + kk + qi * 9) * 0.22);
            else if (hq < 0.9) bushes(tu, tv, 30 + qi * 11 + kk);
            else rocks(tu, tv, 5 + qi + kk);
          }
        } else {
          // sand-pit playground with a slide and a climbing frame
          box(u0, v0, u1, v1, Y, Y + 0.12, P.wood, P.sand);
          const Ys = 0.12;
          const su = u0 + 1.2;
          box(su - 0.5, mv - 0.9, su + 0.5, mv + 0.1, Y + Ys, Y + 1.4, P.red, P.yellow);
          box(su - 0.3, mv + 0.1, su + 0.3, mv + 0.8, Y + Ys, Y + 0.9, P.blue);
          const fu = Math.min(u1 - 1.0, su + 2.6);
          for (const [du, dv] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
            box(fu + du - 0.08, mv + dv - 0.08, fu + du + 0.08, mv + dv + 0.08, Y + Ys, Y + 1.3, P.teal);
          }
          box(fu - 0.7, mv - 0.7, fu + 0.7, mv + 0.7, Y + 1.3, Y + 1.45, P.orange);
          if (v1 - v0 > 4) bench(u0 + 0.6, v1 - 0.4, Math.min(u1 - 0.4, u0 + 2.2));
        }
      });
      lamp(i0u - 0.1, a + 0.9); lamp(i1u + 0.1, a + 0.9);
    }
    // ---- outskirts parcel designs (ground r4) --------------------------------
    // Crop rows running AWAY from the street (along v), stepping along u.
    const rowsV = (u0, u1, v0, v1, cols, hgt) => {
      const pitch = 1.05;
      let k = 0;
      for (let u = u0 + 0.15; u + 0.6 <= u1; u += pitch, k++) {
        box(u, v0, u + 0.6, v1, Y, Y + hgt, cols[k % cols.length]);
      }
    };
    const hay = (u, v) => {
      box(u - 0.55, v - 0.45, u + 0.55, v + 0.45, Y, Y + 0.8, P.hayEnd, P.hay);
    };
    const sheep = (u, v, k) => {
      const f = (k & 1) ? 1 : -1;
      box(u - 0.55, v - 0.35, u + 0.55, v + 0.35, Y + 0.3, Y + 0.85, P.wool);
      box(u + f * 0.55 - 0.18, v - 0.2, u + f * 0.55 + 0.18, v + 0.2, Y + 0.5, Y + 0.9, P.muzzle);
      box(u - 0.4, v - 0.25, u - 0.25, v + 0.25, Y, Y + 0.3, P.muzzle);
      box(u + 0.25, v - 0.25, u + 0.4, v + 0.25, Y, Y + 0.3, P.muzzle);
    };
    const fenceU = (u0, u1, v) => {
      for (let u = u0; u <= u1 + 1e-3; u += 1.6) box(u - 0.08, v - 0.08, u + 0.08, v + 0.08, Y, Y + 0.7, P.white);
      box(u0, v - 0.05, u1, v + 0.05, Y + 0.5, Y + 0.62, P.white);
    };
    const fenceV = (u, v0, v1) => {
      for (let v = v0; v <= v1 + 1e-3; v += 1.6) box(u - 0.08, v - 0.08, u + 0.08, v + 0.08, Y, Y + 0.7, P.white);
      box(u - 0.05, v0, u + 0.05, v1, Y + 0.5, Y + 0.62, P.white);
    };
    if (design === 20) {
      // Farm field (ref05's bottom-left farm lots): brown soil, a dirt track
      // in from the street, two or three bands of crop rows running away from
      // the road, hay bales on the wheat and, now and then, a little tractor.
      flat(a, a, bU, bV, Y, P.soil);
      const sets = [[P.crop, P.cropDark], [P.wheat], [P.cropDark, P.pumpkin], [P.cabbage, P.crop], [P.crop]];
      const tw = 1.4;
      const [t0, t1] = Uc(a + 0.4, a + 0.4 + tw);
      flat(t0, a, t1, bV, y1, P.dirtPath);
      const f0 = a + 0.4 + tw + 0.3, f1 = bU - 0.3;
      const nb = (f1 - f0) >= 13 ? 3 : (f1 - f0) >= 7 ? 2 : 1;
      const bw = (f1 - f0) / nb;
      let s0 = (hr(21) * sets.length) | 0;
      for (let q = 0; q < nb; q++) {
        const s = sets[(s0 + q * 2) % sets.length];
        let [b0, b1] = Uc(f0 + q * bw, f0 + (q + 1) * bw - (q < nb - 1 ? 0.5 : 0));
        const wheat = s.length === 1 && s[0] === P.wheat;
        if (wheat) {
          // wheat reads as one golden block with shallow furrows
          box(b0 + 0.1, a + 0.4, b1 - 0.1, bV - 0.4, Y, Y + 0.42, P.hayEnd, P.wheat);
          for (let u = b0 + 1.2; u < b1 - 0.6; u += 1.4) flat(u, a + 0.4, u + 0.18, bV - 0.4, Y + 0.425, P.hayEnd);
          if (bV - a > 9 && hr(22 + q) < 0.8) { hay((b0 + b1) / 2 - 1.2, a + 2.4); hay((b0 + b1) / 2 + 1.0, a + 3.6); }
        } else {
          rowsV(b0, b1, a + 0.4, bV - 0.4, s, s[0] === P.cabbage ? 0.42 : 0.36);
          if (s[1] === P.pumpkin) {
            for (let u = b0 + 0.35; u + 0.4 < b1; u += 2.1) {
              for (let v = a + 1.2; v < bV - 1.0; v += 1.9) box(u, v, u + 0.5, v + 0.5, Y + 0.36, Y + 0.7, P.pumpkin);
            }
          }
        }
      }
      if (hr(23) < 0.45 && bV - a > 8) {
        // tractor parked on the track
        const tu = (t0 + t1) / 2, tv = a + 3.2;
        box(tu - 0.6, tv - 1.1, tu + 0.6, tv + 0.9, Y + 0.35, Y + 1.05, P.tractor);
        box(tu - 0.5, tv + 0.1, tu + 0.5, tv + 0.9, Y + 1.05, Y + 1.8, P.glass, P.white);
        for (const [du, dv, r] of [[-0.72, 0.5, 0.55], [0.72, 0.5, 0.55], [-0.68, -0.8, 0.35], [0.68, -0.8, 0.35]]) {
          box(tu + du - 0.14, tv + dv - r, tu + du + 0.14, tv + dv + r, Y, Y + r * 2, P.tyre);
        }
      }
    } else if (design === 21) {
      // Orchard: striped lawn, fruit trees on a strict grid, a hedge along
      // the back and a stack of fruit crates by the gate. Flush on the
      // field it is just the tree grid and the crates.
      lawn(a, a, bU, bV);
      const pu = 4.2, pv = 4.2;
      const nu = Math.max(1, Math.floor((bU - a - 1.0) / pu)), nv = Math.max(1, Math.floor((bV - a - 2.2) / pv));
      const ou = a + (bU - a - (nu - 1) * pu) / 2, ov = a + 1.4 + (bV - a - 2.2 - (nv - 1) * pv) / 2;
      for (let q = 0; q < nu; q++) {
        const uu = ou + q * pu;
        if (!flush) flat(uu - 1.0, a + 0.6, uu + 1.0, bV - 1.0, y1, P.lawnLo);
        for (let k = 0; k < nv; k++) {
          const vv = ov + k * pv;
          tree(uu, vv, 0.62);
          const top = Y + 3.0 * 0.62 + 0.01;
          const fc = (hr(30 + q * 7 + k) < 0.5) ? P.fruit : P.orange;
          flat(uu - 0.4, vv - 0.3, uu - 0.15, vv - 0.05, top, fc);
          flat(uu + 0.1, vv + 0.15, uu + 0.35, vv + 0.4, top, fc);
        }
      }
      if (!flush) hedge(a + 0.1, bV - 0.7, bU - 0.1, bV - 0.1);
      crateStack(U(bU - 1.6) - 0.45, a + 0.5, 3);
    } else if (design === 22) {
      // Farmstead, r11 (critic r10: lots that are one flat colour; the r10
      // farmstead was a plain tan yard over a plain straw paddock). Now the
      // front is a packed yard with a grey gravel drive up to a red barn, a
      // silo, a stacked hay rick, a kitchen garden and a tractor; the back is
      // split into a fenced green pasture with sheep and a water trough, and
      // a strip of crop rows.
      const vy = Math.min(bV - 3.0, a + Math.max(5.2, (bV - a) * 0.45));
      flat(a, a, bU, vy, Y, P.yard);
      const bl = Math.min(7.0, (bU - a) * 0.5);
      let [b0, b1] = Uc(a + 0.8, a + 0.8 + bl);
      const bv0 = a + 2.2, bv1 = Math.min(vy - 0.6, bv0 + 4.2);
      // gravel drive from the street to the barn doors, widening into a turn
      const dm = (b0 + b1) / 2;
      flat(dm - 0.9, a, dm + 0.9, bv0, y1, P.gravel);
      flat(dm - 2.2, a + 0.4, dm + 2.2, a + 1.9, y1 + E, P.gravel);
      box(b0, bv0, b1, bv1, Y, Y + 2.2, P.barn);
      box(b0 - 0.2, bv0 - 0.2, b1 + 0.2, bv1 + 0.2, Y + 2.2, Y + 2.45, P.white);
      box(b0 + 0.6, bv0 + 0.5, b1 - 0.6, bv1 - 0.5, Y + 2.45, Y + 3.1, P.barn, P.red);
      box(dm - 0.9, bv0 - 0.06, dm + 0.9, bv0 + 0.02, Y, Y + 1.7, P.white);
      const su = mir ? b0 - 1.7 : b1 + 1.7, sv = (bv0 + bv1) / 2;
      if (su - 1.1 > a && su + 1.1 < bU) {
        box(su - 1.0, sv - 1.0, su + 1.0, sv + 1.0, Y, Y + 4.4, P.silo);
        box(su - 1.1, sv - 1.1, su + 1.1, sv + 1.1, Y + 4.4, Y + 4.7, P.blue);
        box(su - 0.6, sv - 0.6, su + 0.6, sv + 0.6, Y + 4.7, Y + 5.1, P.blue);
      }
      // the spare side of the yard: hay rick + kitchen garden
      const [g0, g1] = mir ? [a + 0.5, Math.min(su - 1.5, b0 - 0.6)] : [Math.max(su + 1.5, b1 + 0.6), bU - 0.5];
      if (g1 - g0 > 2.6) {
        const nh = Math.max(1, Math.min(3, Math.floor((g1 - g0) / 1.15)));
        for (let q = 0; q < nh; q++) hay(g0 + 0.6 + q * 1.15, a + 1.0);
        if (nh >= 2) box(g0 + 0.65, a + 0.6, g0 + 1.7, a + 1.4, Y + 0.8, Y + 1.45, P.hayEnd, P.hay);
        if (vy - (a + 2.4) > 2) {
          flat(g0, a + 2.4, g1, vy - 0.4, y1, P.soil);
          let k = 0;
          const gc = [[P.cabbage, P.crop], [P.crop, P.pumpkin], [P.cropDark, P.cabbage]][(hr(26) * 3) | 0];
          for (let u = g0 + 0.25; u + 0.5 <= g1 - 0.2; u += 0.95, k++) box(u, a + 2.6, u + 0.5, vy - 0.6, Y, Y + 0.34, gc[k & 1]);
        }
      }
      if (hr(27) < 0.6) {
        const tu = dm + (mir ? -1 : 1) * 1.6, tv = a + 1.15;
        box(tu - 1.0, tv - 0.55, tu + 0.9, tv + 0.55, Y + 0.35, Y + 1.0, P.tractor);
        box(tu + 0.05, tv - 0.5, tu + 0.85, tv + 0.5, Y + 1.0, Y + 1.7, P.glass, P.white);
        for (const [du, dv, rr] of [[0.5, -0.7, 0.5], [0.5, 0.7, 0.5], [-0.75, -0.65, 0.33], [-0.75, 0.65, 0.33]]) {
          box(tu + du - rr, tv + dv - 0.13, tu + du + rr, tv + dv + 0.13, Y, Y + rr * 2, P.tyre);
        }
      }
      // back: pasture | crop strip, fenced
      const fv = vy + 0.4;
      const split = bU - a > 11;
      const cw = split ? Math.min(6.5, (bU - a) * 0.4) : 0;
      const [pa0, pa1] = split ? Uc(a, bU - cw) : [a, bU];
      const [cr0, cr1] = split ? Uc(bU - cw, bU) : [0, 0];
      flat(pa0, vy, pa1, bV, Y, P.lawnDk);
      if (split) {
        flat(cr0, vy, cr1, bV, Y, P.soil);
        const cs = [[P.wheat], [P.crop, P.cropDark], [P.cabbage, P.crop]][(hr(28) * 3) | 0];
        if (cs[0] === P.wheat) {
          box(cr0 + 0.4, fv + 0.5, cr1 - 0.4, bV - 0.5, Y, Y + 0.42, P.hayEnd, P.wheat);
          for (let u = cr0 + 1.4; u < cr1 - 0.8; u += 1.4) flat(u, fv + 0.5, u + 0.18, bV - 0.5, Y + 0.425, P.hayEnd);
        } else rowsV(cr0 + 0.3, cr1 - 0.3, fv + 0.5, bV - 0.5, cs, 0.38);
      }
      fenceU(pa0 + 0.5, pa1 - 0.5, fv);
      fenceU(pa0 + 0.5, pa1 - 0.5, bV - 0.5);
      fenceV(pa0 + 0.5, fv, bV - 0.5);
      fenceV(pa1 - 0.5, fv, bV - 0.5);
      // trampled dirt by the gate + a water trough
      const gu = (pa0 + pa1) / 2;
      flat(gu - 1.6, fv + 0.2, gu + 1.4, fv + 1.8, y1, P.dirtDk);
      flat(gu - 1.0, fv + 0.2, gu + 2.0, fv + 1.2, y2, P.dirtDk);
      box(gu - 0.9, fv + 0.7, gu + 0.9, fv + 1.3, Y, Y + 0.45, P.wood);
      flat(gu - 0.75, fv + 0.8, gu + 0.75, fv + 1.2, Y + 0.46, P.water);
      const ns = 3 + ((hr(24) * 4) | 0);
      for (let q = 0; q < ns; q++) {
        const uu = pa0 + 1.8 + hr(25 + q) * (pa1 - pa0 - 3.6), vv = fv + 2.4 + hr(35 + q) * Math.max(0.1, bV - fv - 3.8);
        sheep(uu, vv, q);
      }
      if (bV - fv > 5) tree(mir ? pa1 - 2.0 : pa0 + 2.0, bV - 2.2, 0.8);
    } else if (design === 23) {
      // Pond garden, r13 (critic r12: "the grass plinth on the left is mostly
      // flat plain green inside a thin hedge ring, with big blank areas";
      // ref05 fills every lot edge to edge). Warm tan paving over the whole
      // lot; planter strips of cube bushes and flowers along the three
      // non-street sides; a grey cobbled walk in from the street; the pond
      // sits in a kerbed dark-grass bed with reeds and lily pads; a
      // terracotta café terrace with parasol tables fills the free front
      // corner; boxed trees, benches and lamps along the walk.
      if (flush) lawn(a, a, bU, bV);
      else tiles(a, a, bU, bV, Y, P.sandPave, P.sandPave2, 2.0);
      const pl = 0.9;
      if (!flush) {
        planterRun(a + 0.15, bV - 0.15 - pl, bU - 0.15, bV - 0.15, 1);
        planterRun(a + 0.15, a + 2.2, a + 0.15 + pl, bV - 0.2 - pl, 2);
        planterRun(bU - 0.15 - pl, a + 2.2, bU - 0.15, bV - 0.2 - pl, 3);
      }
      const in0 = a + (flush ? 0.4 : pl + 0.45), in1 = bU - (flush ? 0.4 : pl + 0.45), iv1 = bV - (flush ? 0.4 : pl + 0.45);
      const pw = 1.6;
      const [p0, p1] = Uc(in0 + 2.2, in0 + 2.2 + pw);
      if (!flush) cobbles(p0, a, p1, iv1, y1, P.tileA, P.tileB, P.cobC, P.cobB);
      // pond bed: the far side of the walk, back two thirds of the lot
      const q0 = mir ? in0 + 0.3 : p1 + 1.3, q1 = mir ? p0 - 1.3 : in1 - 0.3;
      const w0 = a + Math.max(3.8, (bV - a) * 0.34), w1 = iv1 - 0.4;
      if (q1 - q0 > 4 && w1 - w0 > 4) {
        box(q0, w0, q1, w1, Y, Y + 0.16, P.curb, P.lawnDk);
        // r13b: the pond takes ~60% of the bed; a little grove of trees fills
        // the far end so it reads as a pond in a garden, not a pool on a slab
        const gW = (q1 - q0) > 9 ? Math.min(5.0, (q1 - q0) * 0.38) : 0;
        const k0 = q0 + 0.9 + (mir ? gW : 0), k1 = q1 - 0.9 - (mir ? 0 : gW), x0 = w0 + 0.9, x1 = w1 - 0.9;
        if (gW) {
          const gu0 = mir ? q0 : q1 - gW, gu1 = gu0 + gW;
          for (let vv = w0 + 1.4, q = 0; vv < w1 - 0.9; vv += 2.6, q++) {
            tree((gu0 + gu1) / 2 + ((q & 1) ? 0.9 : -0.9), vv, 0.55 + hr(1500 + q) * 0.15);
          }
          rocks((gu0 + gu1) / 2, w1 - 1.0, 3);
        }
        const kh = 0.3, Yb = Y + 0.16;
        box(k0, x0, k1, x0 + 0.35, Yb, Yb + kh, P.stone, P.curb); box(k0, x1 - 0.35, k1, x1, Yb, Yb + kh, P.stone, P.curb);
        box(k0, x0 + 0.35, k0 + 0.35, x1 - 0.35, Yb, Yb + kh, P.stone, P.curb); box(k1 - 0.35, x0 + 0.35, k1, x1 - 0.35, Yb, Yb + kh, P.stone, P.curb);
        poolWater(k0 + 0.35, x0 + 0.35, k1 - 0.35, x1 - 0.35, Yb + 0.1);
        {
          // stone fountain island in the middle of the pond
          const fu = (k0 + k1) / 2, fv = (x0 + x1) / 2;
          box(fu - 0.7, fv - 0.7, fu + 0.7, fv + 0.7, Yb, Yb + 0.35, P.stone, P.curb);
          box(fu - 0.18, fv - 0.18, fu + 0.18, fv + 0.18, Yb + 0.35, Yb + 1.3, P.stone, P.white);
          box(fu - 0.4, fv - 0.4, fu + 0.4, fv + 0.4, Yb + 1.3, Yb + 1.42, P.waterLt);
        }
        for (let q = 0; q < 4; q++) {
          const uu = k0 + 1.0 + hr(50 + q) * (k1 - k0 - 2.0), vv = x0 + 1.0 + hr(55 + q) * (x1 - x0 - 2.0);
          flat(uu - 0.35, vv - 0.35, uu + 0.35, vv + 0.35, Yb + 0.11, P.lily);
          if (q === 1) box(uu - 0.1, vv - 0.1, uu + 0.1, vv + 0.1, Yb + 0.11, Yb + 0.3, P.pink);
        }
        // reeds and cube bushes on the bed round the pond
        for (let q = 0; q < 8; q++) {
          const side = q & 3, t = 0.1 + hr(90 + q) * 0.8;
          const ru = side === 0 ? q0 + 0.45 : side === 1 ? q1 - 0.45 : q0 + 0.45 + t * (q1 - q0 - 0.9);
          const rv = side === 2 ? w0 + 0.45 : side === 3 ? w1 - 0.45 : w0 + 0.45 + t * (w1 - w0 - 0.9);
          if (q < 4) box(ru - 0.22, rv - 0.22, ru + 0.22, rv + 0.22, Y + 0.16, Y + 0.85 + hr(95 + q) * 0.4, P.cropDark, P.crop);
          else box(ru - 0.36, rv - 0.36, ru + 0.36, rv + 0.36, Y + 0.16, Y + 0.8 + hr(96 + q) * 0.3, P.hedge, hr(97 + q) < 0.4 ? P.hedgeHi : P.hedgeTop);
        }
        // a little timber jetty from the walk side
        const ju = mir ? k1 : k0, jd = mir ? -1 : 1;
        box(Math.min(ju, ju + jd * 1.8), (x0 + x1) / 2 - 0.45, Math.max(ju, ju + jd * 1.8), (x0 + x1) / 2 + 0.45, Y, Yb + 0.34, P.wood, P.crate);
      }
      // front corner beside the pond bed: a café terrace
      if (!flush) {
        const c0 = q0, c1 = q1, e0 = a + 0.4, e1 = w0 - 0.5;
        if (c1 - c0 > 3 && e1 - e0 > 2.2) {
          tiles(c0, e0, c1, e1, Y + 3 * E, P.terraTile, P.terraTile2, 1.0);
          const cols = [P.red, P.teal, P.white, P.orange];
          const nc = Math.max(1, Math.floor((c1 - c0) / 2.8)), nr = Math.max(1, Math.floor((e1 - e0) / 2.9));
          for (let q = 0; q < nc; q++) for (let j = 0; j < nr; j++) {
            cafe(c0 + (q + 0.5) * (c1 - c0) / nc, e0 + (j + 0.5) * (e1 - e0) / nr, cols[(q + j + (hr(29) * 4 | 0)) % 4]);
          }
        }
        // the walk's other side: boxed trees and benches down its length
        const su = mir ? p1 + 1.0 : p0 - 1.0, bu0 = mir ? p1 + 0.3 : p0 - 1.8;
        let q = 0;
        for (let vv = a + 1.6; vv < iv1 - 1.0; vv += 3.2, q++) {
          if (q & 1) bench(bu0, vv, bu0 + 1.5);
          else if (Math.abs(su - in0) > 0.4) treeBox(su, vv, 0.5);
        }
        lamp(mir ? p0 - 0.3 : p1 + 0.3, a + 1.0);
        lamp(mir ? p0 - 0.3 : p1 + 0.3, iv1 - 1.2);
        // the strip between the walk and the side planter: flower bed + bins
        const fu0 = mir ? p1 + 0.3 : in0, fu1 = mir ? in1 : p0 - 0.3;
        if (fu1 - fu0 > 3.2) {
          bed(fu0 + 0.2, iv1 - 2.6, fu1 - 0.2, iv1 - 0.5, (hr(97) * 5) | 0);
          for (let vv = a + 1.4, j = 0; vv < iv1 - 3.4; vv += 3.2, j++) treeBox((fu0 + fu1) / 2 + (mir ? -0.8 : 0.8), vv, 0.5);
        }
      } else {
        for (let uu = a + 2.2; uu < bU - 1.5; uu += 3.6) tree(uu, bV - 1.9, 0.72);
      }
    }
    // r8 (critic r7: "its open grass also has trees and small grey rocks
    // scattered over it"): a flush green lot is open field around its
    // feature, so its free corners get ref06 rock clusters and cube bushes.
    if (flush && (design === 13 || design === 21 || design === 23 || design === 14)) {
      const spots = [[a + 1.2, a + 1.3], [bU - 1.4, a + 1.2], [a + 1.3, bV - 1.2], [bU - 1.2, bV - 1.4]];
      spots.forEach(([u, v], q) => {
        const hq = hr(800 + q);
        if (hq < 0.4) rocks(u, v, q);
        else if (hq < 0.65) bushes(u, v, 40 + q);
      });
    }
    void y2;
  }

  _makeGeometry(pos, nrm, terr, mask, idx, paint) {
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aTerr', new THREE.Float32BufferAttribute(terr, 4));
    geo.setAttribute('aMask', new THREE.Float32BufferAttribute(mask, 4));
    // aPaint (linear rgb + weight): only the lot plinths author it; every other
    // surface gets zeros (the shader's class blend then decides the colour).
    const nv = pos.length / 3;
    const pa = (paint && paint.length === nv * 4) ? paint : new Float32Array(nv * 4);
    geo.setAttribute('aPaint', new THREE.Float32BufferAttribute(pa, 4));
    geo.setIndex(pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(idx, 1)
      : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  stats() {
    let verts = 0, tris = 0, meshes = 0, skirtTris = 0;
    const tally = (m) => {
      if (!m || !m.geometry) return 0;
      meshes++;
      verts += m.geometry.getAttribute('position').count;
      const t = m.geometry.index.count / 3;
      tris += t;
      return t;
    };
    let lotTris = 0;
    for (const c of this._chunks.values()) { tally(c.ground); tally(c.rock); lotTris += tally(c.lots); }
    skirtTris = tally(this._skirt);
    return {
      meshes, verts, tris, skirtTris, lotTris,
      buildMs: this._lastBuildMs,
      refreshMs: this._lastRefreshMs,
      chunks: this._chunks.size,
    };
  }
}

// ---------------------------------------------------------------------------
// selfTest (CONTRACTS-RENDER.md §4)
// ---------------------------------------------------------------------------

function synthState() {
  const nn = N * N;
  const st = {
    map: new Uint8Array(nn),
    variant: new Uint8Array(nn),
    occ: new Int32Array(nn),
    bridge: new Uint8Array(nn),
  };
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      if (z < 6) st.map[i] = T_WATER;
      else if (z < 8) st.map[i] = T_SAND;
      else if (x % 10 === 0) st.map[i] = T_ROAD;
      else if (x > N - 14 && z > N - 14) {
        st.map[i] = T_MOUNTAIN;
        st.variant[i] = 2 + ((x + z) % 13);
      } else st.map[i] = T_GRASS;
    }
  }
  st.occ[40 * N + 40] = 7;
  st.map[40 * N + 40] = T_BLDG;
  return st;
}

export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  let scene = null, terr = null;
  try {
    scene = new THREE.Scene();
    terr = new Terrain(scene, { aniso: 1 });
    ok('constructed; 3 procedural textures generated');

    const st = synthState();
    const t0 = performance.now();
    terr.build(st);
    const buildMs = performance.now() - t0;
    ok('build(80x80) in ' + buildMs.toFixed(1) + ' ms');

    const s = terr.stats();
    if (s.chunks !== CHUNKS * CHUNKS) fail('expected ' + (CHUNKS * CHUNKS) + ' chunks, got ' + s.chunks);
    else ok(s.chunks + ' chunks, ' + s.meshes + ' meshes, ' + s.verts + ' verts, ' + s.tris + ' tris');

    // ---- horizon skirt ----------------------------------------------------
    // It must exist, must reach past the worst-case fog far plane, and must be
    // flush with the border cliff foot (borderY) at the map boundary — a gap
    // there shows as a bright slit of sky along the whole map edge.
    if (!terr._skirt) fail('no horizon skirt mesh — the map is a floating slab again');
    else {
      const bb = terr._skirt.geometry.boundingBox;
      const reach = Math.min(-bb.min.x, -bb.min.z, bb.max.x - N * TILE, bb.max.z - N * TILE);
      if (reach < 1900) fail('skirt only reaches ' + reach.toFixed(0) + ' units past the map ' +
                             'border; engine.js fog.far tops out at ~1820');
      // r8: beside a LAND border tile the skirt meets the lawn itself (y = 0,
      // the cliff hides under it); beside water it meets the cliff foot.
      const edgeY = (wx, wz) => {
        const tx = Math.min(N - 1, Math.max(0, Math.floor(wx / TILE)));
        const tz = Math.min(N - 1, Math.max(0, Math.floor(wz / TILE)));
        return terr._cls[tz * N + tx] === C_WATER ? terr.borderY : 0;
      };
      let worst = 0;
      for (const w of [0, 137, 320, 501, N * TILE]) {
        worst = Math.max(worst, Math.abs(terr._skirtY(w, 0) - edgeY(w, 0)));
        worst = Math.max(worst, Math.abs(terr._skirtY(0, w) - edgeY(0, w)));
        worst = Math.max(worst, Math.abs(terr._skirtY(w, N * TILE) - edgeY(w, N * TILE)));
      }
      if (worst > 1e-6) fail('skirt is ' + worst.toFixed(3) + ' units off the border ground at the map ' +
                             'boundary — that is a visible slit along the whole edge');
      else ok('skirt: ' + s.skirtTris + ' tris, reaches ' + reach.toFixed(0) +
              ' units out, flush with borderY at the boundary');
    }

    // ---- shoreline warp ---------------------------------------------------
    // (a) pure + bounded, (b) never retreats inland, (c) exactly zero on the
    // map boundary (the horizon skirt is not warped), (d) it actually got the
    // land/water silhouette off the tile grid.
    {
      const W = N * TILE, cap = terr.shoreWarp * TILE + 1e-6;
      const p = [0, 0], q = [0, 0];
      let maxD = 0, bad = 0, edge = 0, inland = 0;
      for (let k = 0; k < 4000; k++) {
        const wx = (k * 97.13) % W, wz = (k * 53.71 + 11) % W;
        terr._warp(wx, wz, p);
        terr._warp(wx, wz, q);
        if (p[0] !== q[0] || p[1] !== q[1]) bad++;
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) bad++;
        const d = Math.hypot(p[0] - wx, p[1] - wz);
        if (d > maxD) maxD = d;
        // The displacement may only run DOWN the signed shore field (toward
        // water). Retreating uncovers the bank from under water.js's surface.
        // (tolerance: the field is piecewise-bilinear, so a normalised gradient
        // step can nudge uphill by a fraction of a tile near a saddle)
        if (d > 1e-4 && terr._signed(p[0] / TILE, p[1] / TILE) >
                        terr._signed(wx / TILE, wz / TILE) + 0.05) inland++;
      }
      for (const w of [0, 111, 320, 517, W]) {
        for (const [a, b] of [[0, w], [W, w], [w, 0], [w, W]]) {
          terr._warp(a, b, p);
          if (p[0] !== a || p[1] !== b) edge++;
        }
      }
      if (bad) fail(bad + ' shoreline warp samples were impure or non-finite');
      else if (maxD > cap) fail('shoreline warp exceeded its amplitude cap: ' +
                                maxD.toFixed(2) + ' > ' + cap.toFixed(2));
      else if (edge) fail(edge + ' map-boundary points were warped — that is a ' +
                          'crack against the (unwarped) horizon skirt');
      else if (inland > 0) fail(inland + ' warp samples moved INLAND; water.js ' +
                                'never extends its surface offshore, so a retreating ' +
                                'bank uncovers itself and the sea bed');
      else ok('shoreline warp pure, <= ' + maxD.toFixed(2) + ' units, seaward only, ' +
              'zero on the map boundary');

      // Silhouette: walk the bank tops the mesher emits and check they are no
      // longer a run of axis-aligned tile edges.
      const segs = [];
      const isW = (x, z) => (x < 0 || z < 0 || x >= N || z >= N)
        ? false : terr._cls[z * N + x] === C_WATER;
      const S2 = terr.sub;
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          if (terr._cls[z * N + x] === C_WATER) continue;
          const a0 = x * TILE, a1 = a0 + TILE, b0 = z * TILE, b1 = b0 + TILE;
          const sides = [];
          if (isW(x + 1, z)) sides.push([a1, b1, a1, b0]);
          if (isW(x - 1, z)) sides.push([a0, b0, a0, b1]);
          if (isW(x, z - 1)) sides.push([a1, b0, a0, b0]);
          if (isW(x, z + 1)) sides.push([a0, b1, a1, b1]);
          for (const [ax, az, bx, bz] of sides) {
            for (let k = 0; k < S2; k++) {
              terr._warp(ax + (bx - ax) * k / S2, az + (bz - az) * k / S2, p);
              terr._warp(ax + (bx - ax) * (k + 1) / S2, az + (bz - az) * (k + 1) / S2, q);
              segs.push([p[0], p[1], q[0], q[1]]);
            }
          }
        }
      }
      // Fold check. The warp is applied to a TILE/sub lattice, so if any gate
      // ramps faster than the lattice spacing a ground triangle turns inside
      // out — which renders as a black shard in the beach. Every up-facing
      // ground triangle must keep the winding the mesher emitted.
      let flipped = 0, tested = 0;
      for (const c of terr._chunks.values()) {
        const g = c.ground && c.ground.geometry;
        if (!g) continue;
        const pa = g.getAttribute('position').array;
        const na = g.getAttribute('normal').array;
        const ia = g.index.array;
        for (let k = 0; k < ia.length; k += 3) {
          const a = ia[k], b = ia[k + 1], c2 = ia[k + 2];
          if (na[a * 3 + 1] < 0.999) continue;              // up-facing only
          const ax = pa[a * 3], az = pa[a * 3 + 2];
          const s = (pa[b * 3] - ax) * (pa[c2 * 3 + 2] - az) -
                    (pa[b * 3 + 2] - az) * (pa[c2 * 3] - ax);
          tested++;
          if (s >= 0) flipped++;                            // emitted winding is < 0
        }
      }
      if (flipped) fail(flipped + '/' + tested + ' up-facing ground triangles are ' +
                        'inverted — the shoreline warp folded the lattice');
      else ok('no folded ground triangles over ' + tested + ' up-facing tris');

      // ---- swash slope (the water/sand black-rim fix) ---------------------
      // Pure, bounded, never below the water surface, zero on the map border,
      // and — the one that matters — every bank-top vertex the mesher emitted
      // must sit at or below WATER_Y, because anything above it is exposed
      // vertical wall and that is what SSAO turns into a black outline.
      {
        let bad = 0, tooDeep = 0, edge = 0, over = 0;
        const W2 = N * TILE;
        for (let k = 0; k < 4000; k++) {
          const wx = (k * 91.7) % W2, wz = (k * 47.3 + 7) % W2;
          const d1 = terr._shoreDip(wx, wz), d2 = terr._shoreDip(wx, wz);
          if (d1 !== d2 || !Number.isFinite(d1)) bad++;
          if (d1 < 0 || d1 > terr.swash + 1e-9) bad++;
          if (-d1 < WATER_Y - 1e-9) tooDeep++;
        }
        for (const w of [0, 111, 320, 517, W2]) {
          for (const [a, b] of [[0, w], [W2, w], [w, 0], [w, W2]]) {
            if (terr._shoreDip(a, b) !== 0) edge++;
          }
        }
        // Coverage: walk the same water-facing bank tops the mesher emits and
        // count how many are actually pulled under the waterline. It can never
        // be 100 % — the dip is vetoed within 2 tiles of anything meshed at
        // y = 0 (roads, bridge decks, mountains, buildings) and at the map
        // border — but if it collapses the black rim is back everywhere.
        let lips = 0, sunk = 0;
        const isW2 = (x, z) => (x < 0 || z < 0 || x >= N || z >= N)
          ? false : terr._cls[z * N + x] === C_WATER;
        for (let z = 0; z < N; z++) {
          for (let x = 0; x < N; x++) {
            if (terr._cls[z * N + x] === C_WATER) continue;
            const a0 = x * TILE, a1 = a0 + TILE, b0 = z * TILE, b1 = b0 + TILE;
            const sd = [];
            if (isW2(x + 1, z)) sd.push([a1, b1, a1, b0]);
            if (isW2(x - 1, z)) sd.push([a0, b0, a0, b1]);
            if (isW2(x, z - 1)) sd.push([a1, b0, a0, b0]);
            if (isW2(x, z + 1)) sd.push([a0, b1, a1, b1]);
            for (const [ax, az, bx, bz] of sd) {
              for (let k = 0; k <= terr.sub; k++) {
                const f = k / terr.sub;
                terr._warp(ax + (bx - ax) * f, az + (bz - az) * f, p);
                lips++;
                if (-terr._shoreDip(p[0], p[1]) <= WATER_Y + 0.06) sunk++;
              }
            }
          }
        }
        const sunkPct = 100 * sunk / Math.max(1, lips);
        if (bad) fail(bad + ' swash-slope samples were impure, negative or over the cap');
        else if (tooDeep) fail(tooDeep + ' swash samples put the beach BELOW the water ' +
                               'surface — that is a dry trench under the waterline');
        else if (edge) fail(edge + ' map-boundary points were dipped — that cracks ' +
                            'against the border cliffs and the horizon skirt');
        else if (terr.swash > 0 && sunkPct < 35) {
          fail('only ' + sunkPct.toFixed(0) + '% of bank tops are pulled under ' +
               'WATER_Y — the exposed vertical lip that draws the black rim on ' +
               'the water/sand boundary is back over most of the shore');
        } else {
          ok('swash slope pure, <= ' + terr.swash.toFixed(2) + ' units, never below ' +
             'WATER_Y, zero on the map boundary; ' + sunkPct.toFixed(0) +
             '% of bank tops submerged (' + lips + ' sampled)');
        }
      }

      let axis = 0;
      for (const [ax, az, bx, bz] of segs) {
        const a = Math.abs(Math.atan2(bz - az, bx - ax) * 180 / Math.PI) % 90;
        if (Math.min(a, 90 - a) < 1.0) axis++;
      }
      const pct = 100 * axis / Math.max(1, segs.length);
      if (segs.length && terr.shoreWarp > 0 && pct > 70) {
        fail('shoreline is still ' + pct.toFixed(0) + '% axis-aligned tile edges ' +
             '— the rectilinear-swimming-pool silhouette is back');
      } else if (segs.length) {
        ok('shoreline silhouette: ' + segs.length + ' segments, ' +
           pct.toFixed(0) + '% still axis-aligned');
      }
    }

    // Attribute integrity: counts match, no NaN/Inf.
    let checked = 0;
    for (const c of terr._chunks.values()) {
      for (const m of [c.ground, c.rock, c.lots]) {
        if (!m) continue;
        const g = m.geometry;
        const p = g.getAttribute('position'), nA = g.getAttribute('normal');
        const tA = g.getAttribute('aTerr'), mA = g.getAttribute('aMask');
        if (!p || !nA || !tA || !mA) { fail('missing attribute on ' + m.name); continue; }
        if (nA.count !== p.count || tA.count !== p.count || mA.count !== p.count) {
          fail('attribute count mismatch on ' + m.name);
        }
        for (const at of [p, nA, tA, mA]) {
          const arr = at.array;
          for (let k = 0; k < arr.length; k++) {
            if (!Number.isFinite(arr[k])) { fail('non-finite value in ' + m.name); k = arr.length; }
          }
        }
        const ix = g.index;
        if (!ix) fail('geometry not indexed: ' + m.name);
        else {
          let bad = 0;
          for (let k = 0; k < ix.count; k++) if (ix.array[k] >= p.count) bad++;
          if (bad) fail(bad + ' out-of-range indices in ' + m.name);
        }
        checked++;
      }
    }
    ok('attribute/index integrity verified on ' + checked + ' meshes');

    // refreshTile: interior + chunk-border cases.
    const before = terr.stats().tris;
    st.map[41 * N + 41] = T_ROAD;
    const r0 = performance.now();
    terr.refreshTile(st, 41, 41);
    const refreshMs = performance.now() - r0;
    ok('refreshTile(interior) in ' + refreshMs.toFixed(2) + ' ms');
    terr.refreshTile(st, 16, 16);   // chunk corner -> 4 chunks rebuilt
    terr.refreshTile(st, 0, 0);
    terr.refreshTile(st, N - 1, N - 1);
    if (terr.stats().chunks !== CHUNKS * CHUNKS) fail('chunk count changed after refreshTile');
    else ok('refreshTile keeps the chunk grid intact (before ' + before + ' tris)');

    // Lots r3/r6: an empty 3x3 block closed by roads is one rect (3x3), every rect tile carries its rect's key, and open land beside a
    // road carries the kerb bits in its key.
    {
      const lt = synthState();
      for (let z = 20; z <= 24; z++) for (let x = 21; x <= 25; x++) {
        const edge = z === 20 || z === 24 || x === 21 || x === 25;
        lt.map[z * N + x] = edge ? T_ROAD : T_GRASS;
      }
      terr._computeFields(lt);
      const r0 = terr._rectAt[21 * N + 22];
      let tiles = 0, keyed = true;
      for (let z = 21; z <= 23; z++) for (let x = 22; x <= 24; x++) {
        const r = terr._rectAt[z * N + x];
        if (!r) continue;
        tiles++;
        if (terr._lotKey[z * N + x] !== terr._lotKey[r.o]) keyed = false;
      }
      // r6: an empty block is ONE plinth (one 3x3 rect), not four.
      if (r0 && r0.w === 3 && r0.d === 3 && tiles === 9 && keyed) ok('3x3 vacant block -> one 3x3 lot, rect keys shared');
      else fail('vacant rect merge wrong (' + (r0 ? r0.w + 'x' + r0.d : 'none') + ', ' + tiles + ' tiles, keyed ' + keyed + ')');
      const vm = terr._verge[22 * N + 26];     // just east of the ring road
      if (vm === 4 && terr._lotKey[22 * N + 26] === -(10000 + 4)) ok('verge tile beside a road gets a west kerb');
      else fail('verge kerb bits wrong: ' + vm);
      terr._computeFields(st);
      for (const i of terr._dirty) if (terr._lotKey[i] === terr._builtKey[i]) terr._dirty.delete(i);
    }

    // Outskirts parcels (ground r4): lots only on clean open grass off the
    // lattice lines, strips only ON them, nothing at the coast.
    {
      const ps = synthState();
      const plan = parcelPlan(ps);
      let bad = 0, onLine = 0, strip = 0, coast = 0;
      for (const r of plan.rects) {
        for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) {
          const i = z * N + x;
          if (ps.map[i] !== T_GRASS || ps.occ[i]) bad++;
          // a merged 7x3 / 3x7 slab spans one lattice line on purpose
          if (r.w <= 3 && r.d <= 3 && ((x & 3) === plan.px || (z & 3) === plan.pz)) onLine++;
          if (z < 8 + PARCEL_COAST) coast++;
        }
      }
      for (let i = 0; i < N * N; i++) {
        if (plan.mask[i] === 2 && !(((i % N) & 3) === plan.px || ((((i / N) | 0)) & 3) === plan.pz)) strip++;
      }
      let meadow = 0;
      for (let i = 0; i < N * N; i++) if (plan.mask[i] === 4) meadow++;
      if (plan.rects.length > 4 && meadow > 20 && !bad && !onLine && !strip && !coast) ok('outskirts parcels: ' + plan.rects.length + ' lots on the road lattice, ' + meadow + ' open-field tiles, strips on its lines, coast left natural');
      else fail('parcel plan wrong (' + plan.rects.length + ' rects, meadow ' + meadow + ', bad ' + bad + ', onLine ' + onLine + ', strip ' + strip + ', coast ' + coast + ')');
      const none = parcelPlan({ map: new Uint8Array(N * N) });
      if (!none.rects.length) ok('no roads -> no parcels (open country stays meadow)');
      else fail('parcels without any road');
    }

    // r10 lawn plinths: open lawn closed in by road + beach is raised; open
    // country that reaches the map border is not.
    {
      const ls = { map: new Uint8Array(N * N), occ: new Uint32Array(N * N) };
      ls.map.fill(T_GRASS);
      // r12: 5x5 (LAWN_MAX is 30 now; bigger pockets stay open field)
      for (let z = 30; z <= 36; z++) for (let x = 30; x <= 36; x++) {
        const edge = z === 30 || x === 30 || x === 36;
        ls.map[z * N + x] = edge ? T_ROAD : z === 36 ? T_SAND : T_GRASS;
      }
      for (let x = 29; x <= 37; x++) ls.map[37 * N + x] = T_WATER;
      for (let z = 30; z <= 37; z++) { ls.map[z * N + 29] = T_WATER; ls.map[z * N + 37] = T_WATER; }
      const lm = lawnMask(ls, null, null);
      let inner = 0, outer = 0;
      for (let z = 31; z <= 35; z++) for (let x = 31; x <= 35; x++) inner += lm[z * N + x];
      for (let i = 0; i < N * N; i++) outer += lm[i];
      if (inner === 25 && outer === 25) ok('lawn plinth: a 5x5 lawn between roads and a beach is raised, open country is not');
      else fail('lawn mask wrong (inner ' + inner + '/25, total ' + outer + ')');
    }

    // Weather / quality switching must not reallocate the world.
    const trisA = terr.stats().tris;
    terr.setWeather({ tint: [1.05, 0.98, 0.9], snow: 1, rain: 0.5 });
    for (let q = 0; q <= 2; q++) terr.setQuality(q);
    terr.update(0.5, {
      camera: { position: new THREE.Vector3(100, 80, 100) },
      quality: 2, nightEff: 0.5, weather: { rain: 0, snow: 0, tint: [1, 1, 1] },
    });
    if (terr.stats().tris !== trisA) fail('quality/weather switch reallocated geometry');
    else ok('quality 0/1/2 + weather switch without reallocation');

    // ---- Material must not opt out of shadow receiving ---------------------
    // (Cheap JS-side half of the shadow regression check; the GLSL half is
    // below. A stray shadowSide / depthWrite / custom define here silently
    // kills or inverts ground shadows.)
    {
      const m = terr.material;
      if (m.shadowSide !== null && m.shadowSide !== undefined) {
        fail('material.shadowSide is set (' + m.shadowSide + ') — leave it null');
      }
      if (m.depthWrite !== true) fail('material.depthWrite must stay true');
      // MeshStandardMaterial ships { STANDARD: '' } (and PHYSICAL on Physical);
      // anything else is ours and can change the program variant behind our back.
      const stockDefines = { STANDARD: 1, PHYSICAL: 1 };
      const extra = Object.keys(m.defines || {}).filter((k) => !stockDefines[k]);
      if (extra.length) fail('material.defines has non-stock keys: ' + extra.join(','));
      let bad = 0;
      for (const c of terr._chunks.values()) {
        for (const msh of [c.ground, c.rock]) if (msh && !msh.receiveShadow) bad++;
      }
      if (bad) fail(bad + ' terrain meshes have receiveShadow === false');
      if (pass) ok('material/mesh shadow flags clean (no shadowSide, all receiveShadow)');
    }

    // Shader compile + SHADOW PATH REGRESSION (needs a real renderer).
    if (renderer && renderer.compile) {
      const cam = new THREE.PerspectiveCamera(40, 1, 1, 2000);
      cam.position.set(320, 200, 320); cam.lookAt(320, 0, 320);
      // A shadow-casting directional light is what makes three compile the
      // USE_SHADOWMAP variant — the variant the game actually uses.
      const dl = new THREE.DirectionalLight(0xffffff, 1);
      dl.position.set(120, 320, 90);
      dl.castShadow = true;
      scene.add(dl);
      scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b8f4e, 0.6));
      const prevShadows = renderer.shadowMap.enabled;
      renderer.shadowMap.enabled = true;
      const errs = [];
      const oldErr = console.error;
      console.error = (...a) => { errs.push(a.join(' ')); };
      try { renderer.compile(scene, cam); } finally { console.error = oldErr; }
      if (errs.length) fail('shader compile reported: ' + errs[0].slice(0, 300));
      else ok('terrain shader compiles clean');

      // ---- THE regression assertion ----------------------------------------
      // Read the shader source three actually handed to the driver and prove
      // the directional-shadow code survived the onBeforeCompile injection.
      // History: an injection that *replaces* rather than appends one of
      // <normal_fragment_begin> / <lights_fragment_begin> / <aomap_fragment>
      // silently deletes getShadow() and the ground stops receiving shadows
      // while still looking perfectly fine. Never again.
      let prog = null;
      const progs = (renderer.info && renderer.info.programs) ? renderer.info.programs : null;
      if (progs) for (const p of progs) if (p.name === 'terrain') prog = p;
      const gl = renderer.getContext ? renderer.getContext() : null;
      if (!prog || !gl || typeof gl.getShaderSource !== 'function') {
        fail('could not reach the compiled terrain program — shadow path UNVERIFIED');
      } else {
        const fs = gl.getShaderSource(prog.fragmentShader) || '';
        const vs = gl.getShaderSource(prog.vertexShader) || '';
        const nFail = () => notes.reduce((n, s) => n + (s.indexOf('FAIL') === 0 ? 1 : 0), 0);
        const failBefore = nFail();
        const need = (src, what, where) => {
          if (src.indexOf(what) === -1) fail('compiled ' + where + ' lacks `' + what + '`');
        };
        // 1. We are looking at OUR material, not a stock fallback.
        need(fs, 'thTerrain', 'fragment shader');
        // 1b. The derivative-widened material boundary survived (see thEdge):
        //     without it every grass/road and grass/sand blend goes sub-pixel
        //     at region zoom and crawls, and MSAA cannot help a shader-space
        //     edge inside a continuous mesh.
        need(fs, 'thEdge', 'fragment shader');
        if (fs.indexOf('#version 300 es') === 0 && fs.indexOf('fwidth(') === -1) {
          fail('GLSL3 shader has no fwidth() — thEdge degraded to the fixed width');
        }
        // 1b2. The stylised look: lot-plinth paint channel is wired through.
        need(fs, 'vPaint', 'fragment shader');
        need(vs, 'aPaint', 'vertex shader');
        // 1c. The horizon aerial-perspective re-target survived AND three's own
        //     fog mix is still there underneath it (it is append-only: the lift
        //     is a correction term, not a replacement).
        need(fs, 'uHorizonLift', 'fragment shader');
        need(fs, 'thFogT', 'fragment shader');
        if (fs.indexOf('#define USE_FOG') !== -1 &&
            fs.indexOf('mix( gl_FragColor.rgb, fogColor, fogFactor )') === -1 &&
            fs.indexOf('mix(gl_FragColor.rgb,fogColor,fogFactor)') === -1) {
          fail('three\'s <fog_fragment> mix is gone — the horizon lift replaced ' +
               'the fog instead of correcting it');
        }
        // 2. three compiled the shadow variant at all.
        need(fs, '#define USE_SHADOWMAP', 'fragment shader');
        need(fs, 'directionalShadowMap', 'fragment shader');
        need(fs, 'vDirectionalShadowCoord', 'fragment shader');
        need(vs, 'vDirectionalShadowCoord', 'vertex shader');
        // 3. The vertex shader still writes the shadow coord (worldpos_vertex /
        //    shadowmap_vertex not clobbered by the begin_vertex injection).
        need(vs, 'directionalShadowMatrix', 'vertex shader');
        // 4. getShadow is both DEFINED and CALLED in the direct-light loop.
        const calls = (fs.match(/getShadow\s*\(/g) || []).length;
        if (calls < 2) {
          fail('getShadow() appears ' + calls + 'x in the fragment shader — the ' +
               'directional shadow lookup was removed (expect >= 2: definition + call)');
        }
        if (fs.indexOf('receiveShadow ) ? getShadow(') === -1) {
          fail('the <lights_fragment_begin> shadow multiply is gone — ' +
               'directLight.color is never attenuated by the shadow map');
        }
        // 5. The chunks we inject into are still intact around our additions.
        need(fs, 'nonPerturbedNormal', 'fragment shader');   // normal_fragment_begin
        need(fs, 'roughnessFactor', 'fragment shader');      // roughnessmap_fragment
        need(fs, 'geometryNormal', 'fragment shader');       // lights_fragment_begin
        if (nFail() === failBefore) {
          ok('shadow path intact: USE_SHADOWMAP + ' + calls + 'x getShadow + ' +
             'directLight attenuation + shadow coord varying');
        }
      }
      renderer.shadowMap.enabled = prevShadows;

      const info = renderer.info;
      if (info && info.programs && info.programs.length > 3) {
        notes.push('note: ' + info.programs.length + ' programs live (expect ~1-3 for terrain)');
      }
    } else {
      notes.push('note: no renderer passed — shader compile not verified');
    }

    // Leak check: 100 rebuild cycles must not grow the chunk registry.
    for (let k = 0; k < 100; k++) terr.refreshTile(st, 20 + (k % 40), 20 + (k % 40));
    if (terr._chunks.size !== CHUNKS * CHUNKS) fail('chunk registry leaked over 100 refresh cycles');
    else ok('no chunk leak over 100 refresh cycles');

    terr.dispose();
    if (terr._chunks.size !== 0) fail('dispose() left chunks behind');
    else if (terr._skirt) fail('dispose() left the horizon skirt behind');
    else ok('dispose() clean');
    terr = null;
  } catch (e) {
    fail('threw: ' + (e && e.message ? e.message : String(e)));
    notes.push(e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : '');
  } finally {
    if (terr) { try { terr.dispose(); } catch (e) { /* ignore */ } }
  }
  return { pass, notes };
}
