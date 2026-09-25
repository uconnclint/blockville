// Blockville models — CORE: palette, PRNG, voxel grid, shared + detail helpers.
// PURE DATA + tiny functions. No three.js, no DOM.
// Every generator returns { sx, sy, sz, blocks:[[x,y,z,colorIndex], ...], res? }
// with integer coords inside [0,size) and colorIndex valid in PALETTE.
//
// Determinism: generators seed a tiny mulberry32 PRNG from their `variant` int,
// so the same variant always rebuilds byte-for-byte identically after save/load.
// No Math.random at module load.
//
// ===========================================================================
// AUTHORING GUIDE — finer voxel resolution (`res`)
// ===========================================================================
// A tile is 8 world units. Legacy models use 1 voxel = 1 world unit (8 per
// tile). A model may instead declare `res` = voxels per world unit:
//
//     res 1 →  8 voxels per tile (default; every legacy model)
//     res 2 → 16 voxels per tile
//     res 4 → 32 voxels per tile   (≈ the Pablo Gamedev reference density)
//
// Just pass it to grid():   const g = grid(sx, sy, sz, 4);
// All coordinates / sizes (sx, sy, sz, every g.set/box/helper call) are then
// in FINE voxels; g.done() stamps `res` on the model and the whole pipeline
// (mesher, engine placement, ghost, rotation, construction pop-up, spinners)
// handles the scale. World size = voxels / res.
//
// Limits (checked by _selfTest; the footprint tw×td comes from CATALOG):
//   width  sx ≤ tw*8*res - 1,  depth sz ≤ td*8*res - 1   (res 1: 7 per tile,
//          res 2: 15, res 4: 31 — the -1 keeps a hairline gap to neighbours)
//   height sy ≤ HCAP[max(tw,td)] * res   (1×1: 48 world units = 192 @ res 4)
// Front convention is unchanged: author the entrance toward min-Z (z≈0);
// catalogModel's flipZ mirrors it onto +Z.
//
// Rendering notes:
//  * Meshing at res > 1 is greedy (coplanar same-colour faces with identical
//    AO merge), so big flat walls cost ~2 triangles no matter the res. Detail
//    costs triangles only where it breaks a surface — spend it on silhouettes
//    and edges (frames, sills, cornices, rooftop gear), not on noise or
//    checkerboards of alternating colours (those defeat merging).
//  * AO reach scales with res (the contact-shadow ramp stays ~1 world unit
//    wide), so recesses 1 fine voxel deep already read nicely.
//  * The material's per-cell effects (night window on/off, floor banding) use
//    1-world-unit cells = res×res fine voxels anchored at the model's min
//    corner. A window pane that sits inside ONE cell (e.g. at res 4: glass on
//    u in [4k+1, 4k+2]) lights as a unit; a pane spanning cells may light
//    partially at night — cheerful, but keep hero windows cell-aligned.
//  * Glow colours (200 warm window, 201 cool window, 202 lamp, 203 neon)
//    work at any res.
//  * Animated parts (catalogAnim): the part model may have its own res; the
//    ox/oy/oz offsets stay in WORLD units.
//
// Detail helpers (below, "DETAIL HELPERS"): all take fine-voxel coordinates
// and work at any res; sizes suggested for res 4 in each comment. Facade
// helpers take a facade(g, side, plane) handle so the same call decorates any
// wall: u runs along the wall, y is up, `out` steps away from the building
// (0 = in the wall plane, 1 = one voxel proud, -1 = recessed into the wall).
//   facade        wall handle: set/del/box in (u, y, out) space
//   windowFramed  recessed glass + frame ring + sill + lintel (+ mullions / shutters)
//   door          recessed door, frame, knob, step, optional canopy
//   awning        sloped striped awning with valance
//   signPanel     bordered sign board (+ pixelText for 3×5 lettering)
//   pixelText     3×5 pixel font (A–Z, 0–9, some punctuation)
//   wallLamp      small bracket lamp (202 glows at night)
//   wallAC        window/wall AC unit with grille
//   acBox         rooftop condenser: louvred box with a fan on top
//   parapet       roof edge wall with coping
//   solarPanel    navy panel with a light grid
//   ventPipe      rooftop pipe with a cap
//   planter       planter box with soil + flowers/shrubs
//   paving        lot paving slab with a kerb rim
//   bench         little street bench
// See commercial.js bBakery for a complete worked example at res 4.
// ===========================================================================

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
  // lot plinths (see lotPlinth) — Isometric City Voxel look
  lotRim: 0xdcd8cc, lotSide: 0xa9a59a, lotPave: 0xc9c6bc, lotPaveDark: 0xb3b0a6,
  lotAsphalt: 0x2a2c30, lotLine: 0xf4f4ee, lotGrass: 0x96b03d,   // coherence 09-25: 0x9fcb45 rendered neon #b6f972 next to the #b0d26a field
  // ---- ARTIST ADDITIONS: append new colours ONLY inside your own block, keys
  // prefixed with your category (e.g. resTerracotta). Indices must stay < 200.
  // [residential]  ref04 / ref05 houses (palette is shared + capped at 200: reuse first)
  // (the grade + warm key push saturation up ~1.6x on walls and more on roofs,
  // so these are authored muted: they render as ref04's terracotta / cream)
  resTerracotta: 0xcf9e80, resTerraTrim: 0xb47755, resTileOrangeDk: 0xbb5f2b,
  resSlate: 0x9aa3ad, resSlateDk: 0x78808e, resTileGreenDk: 0x4d7a5e,
  resTile: 0xbf8062, resTileDk: 0x8a5646, resQuoin: 0xeedfc4, resButter: 0xeedaa8, resSage: 0xb5c6a4,
  resRoofRed: 0xa0605a, resLawn: 0x95b368,   // coherence 09-25: was 0x9cc77e (rendered mint #b6f888 once the field went back to lime)
  // [commercial]  shops & food (ref05 diner / supermarket, ref02 shop)
  comRoof: 0xb7bcc2, comFrame: 0x3b4047, comDough: 0xe2a458, comIcing: 0xff8cc6,
  comChoco: 0x6e3b22, comCone: 0xebb86a, comConeDk: 0xc48845, comPatty: 0x5c3420,
  comCheese: 0xffc93c, comLettuce: 0x86d23a, comTerra: 0xd9774e,
  // [downtown]  ref05 bank / hotel / hospital / apartment tower look (r8: dtPad + dtGlassDark lightened — critic r7: ONYX read near-black)
  dtGlass: 0x4f86bd, dtGlassHi: 0x9ad2f2, dtGlassDeep: 0x2a5b9f, dtGlassTeal: 0x238f9c,
  dtGlassDark: 0x2b4776, dtGlassGreen: 0x49ae88, dtLime: 0xece5d4, dtLimeShade: 0xd3c6ab,
  dtTerra: 0xb8645a, dtCopper: 0x5fb9a3, dtPad: 0x5b6476, dtFrame: 0xf4f5f1,
  dtNavyPanel: 0x34496b, dtStone: 0xc6ccd4,
  // [civic+fun]  ref05 stadium / fire station / monument plaza / pool
  civPitchA: 0x93cc3c, civPitchB: 0x7fbb33, civSeat: 0x3b9de0, civSeatAlt: 0xf26a2b,
  civRoof: 0xeff2f5, civNavy: 0x33445e, civPanel: 0xc8ccd2, civGlass: 0x5cb3ea,
  // (r10) critic r9: fire station "red and teal run together", city hall
  // "pale blue washes out" -> deeper brick, darker sage trim/deck, cream hall
  // walls with strong grey-teal pilasters and a dark teal slate (ref05)
  civBrick: 0xc23d25, civCornice: 0x4f806a, civApron: 0x243a35, civPool: 0x2ea3ee,
  civPoolLt: 0x86d4f7, civPlaza: 0xdcad7a, civMarble: 0xefece5, civRubber: 0xe4644c,
  civFireRoof: 0x5f8a74,
  civHall: 0xe4e3d3, civHallDk: 0x5f8f8e, civConcourse: 0x4b535f, civConcourseLt: 0x6d7682,
  civSign: 0x2c3e66, civBronze: 0x6f8f86, civSlate: 0x3f6269, civStone: 0xd9d3c3,
  // [industrial]
  // r12 (critic r11: "almost all of our industrial district is pale white or
  // light grey … no sense of heavy material"; ref05: dark charcoal + steel
  // roofs, weathered bronze / black stacks): roofs and hoods go charcoal /
  // mid steel, the old cheese slot is the stacks' weathered bronze
  indWall: 0xe6eaee, indShade: 0xb9c4cf, indBase: 0x76869a, indRoof: 0x3d444e,
  indRoofLt: 0x6b7683, indTank: 0xa9b4c0, indBlue: 0x2f78d0, indChoco: 0x6e3b1f,
  indChocoLt: 0x9a5a32, indBronze: 0x9c6843, indBlade: 0xf7f8fa,
  indPave: 0xe2dac8, indLine: 0xf7c843,   // r7: ref05's warm beige plant paving + yellow lane paint
  // r7 cladding (critic r6: "swap the all-white walls for darker steel, navy or
  // corrugated grey") — all saturated enough to stay paint, not metal
  // r9 (critic r8 + coordinator: ref05's works are LIGHT grey / white concrete with
  // glazed blue facades; the dark navy bodies read muddy): the clad keys keep
  // their names but are now light bodies with a colourful blue-grey dark tone
  // r12: the clad families carry real MASS again, but as mid steel (not r8's
  // muddy navy): steel = mid blue-grey sheet, navy = a blue steel, corr = a
  // light concrete; roof decks are charcoal
  indSteel: 0x6b7887, indSteelDk: 0x46515f, indNavy: 0x4f5d70, indNavyDk: 0x323d4c,
  indCorr: 0xd2d8de, indCorrDk: 0x8a9aad, indYard: 0x30363e,   // r11: a step darker (critic r10: ref05's slate roofs + dark yards vs light walls)
  // [vegetation]  ref06: lime cuboid canopies, tan-brown trunks, grey rocks
  // Rendered steps (grade compresses albedo steps ~2x): band ~0.85x the leaf,
  // dots ~0.9x (ref06: band #6c930c on #85ab00, dots barely darker than the
  // face). Trunk albedo is desaturated because the grade's vibrance /
  // shadowSat push a plain orange-brown to a saturated orange (#c15406).
  // r5: the three face tones (top / lit / shade) come from props.js's
  // aVegTone shader term; leaf is a touch greener so the lit face is not
  // grass-coloured, bush a brighter mid-green (ref06 lit #62c700).
  // r6 (critic: band / dots barely show, trunks thin dark maroon): band and
  // dots are a darker, OLIVE step (ref06's band is olive, not a greener
  // green: a saturated band read as a hue stripe, not a shadow); trunk moved
  // to an orange-brown albedo that renders ~#c0703c lit (the grade drops
  // blue hard, so the old 0xb07c6c rendered pink-maroon #bf6340).
  // r7 (critic: sides read as one mid-green under a neon top): the face
  // tones now come from props.js's per-channel lime term solved against
  // ref06's rendered pixels; band / dots are ~0.6-0.7x the leaf in LINEAR
  // (ref06 band ~0.7-0.8x of its face) instead of r6's 0.3x, which rendered
  // near-black #263e00 on the shade face.
  vegLeaf: 0xaac80a, vegLeafBand: 0x7a9814, vegLeafDot: 0x76960e,
  vegPine: 0x9cc814, vegPineBand: 0x6d9619, vegPineDot: 0x689216,
  vegBloom: 0xf8a9cc, vegBloomBand: 0xb2527c, vegBloomDot: 0xc86892,
  vegTrunk: 0xb48a60,
  vegBush: 0x5eb814, vegBushDark: 0x47980c,
  vegRock: 0x94979a, vegRockLight: 0x909397, vegRockDark: 0x46494e,
  vegPetalW: 0xf0f0ec, vegPetalB: 0x2b9ff0, vegPetalR: 0xe8290e,
  vegPollen: 0xf0e024, vegStem: 0x3faa12, vegTuft: 0x6fcf1e,
  // [vehicles]  ref05: crisp little cars. The palette is capped at 200 and this
  // block sits LAST, so it keeps only what the base palette lacks (glass x3,
  // two paints, silver); vehicles.js reuses black / darkGray / red / white /
  // navy / orange / teal / skyBlue / plank ... for everything else.
  // r10: dark window strips (ref05's cars: "dark window strips"; the r9 blue
  // glass merged with blue / navy paint)
  // r13 (the r12 critic: "a candy palette of pink vans, lime and teal
  // hatchbacks ... no dark windshield or side glass"): near-black glass that
  // reads on any paint even on a sunlit top face, and real car paints — the
  // two ex-glass slots are now charcoal + metallic silver body colours.
  // r14: glass a deep navy (0x141a26 read as black holes once the flanks lit;
  // ref05's cabs are dark BLUE glass; 0x1b3050 already graded to lavender)
  vehGlass: 0x17233c, vehCharcoal: 0x3b3f46, vehPearl: 0xb3b8bf,
  vehRed: 0xd83a31, vehBlue: 0x4f9ff0, vehGreen: 0x3a7a4a, vehSilver: 0xc6cbd2,   // vehBlue stays (residential props use it); car blue = C.blue
  // [infra] coherence 09-25: bridge deck asphalt — the darkest neutral, so the
  // voxel deck (lifted by materials' dark floor + sky fill) lands near roads.js.
  infraDeck: 0x121316,
};

export const PALETTE = [];
export const C = {};
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
export function mulberry32(a) {
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
// `res` (optional, default 1) = voxels per world unit — see AUTHORING GUIDE.
export function grid(sx, sy, sz, res) {
  const map = new Map();
  res = (typeof res === 'number' && res > 1) ? Math.round(res) : 1;
  return {
    sx, sy, sz, res, map,
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
      const m = { sx: this.sx, sy: this.sy, sz: this.sz, blocks };
      if (this.res !== 1) m.res = this.res;   // res-1 models stay byte-identical
      return m;
    },
  };
}

// Hipped pyramid roof (closed on all four sides, overhangs an inset body).
export function pyramidRoof(g, x0, z0, x1, z1, baseY, c, cap) {
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
export function gableRoof(g, fx0, fx1, z0, z1, baseY, wallC, roofC, cap) {
  let y = baseY;
  while (z0 <= z1 && y < cap) {
    for (let z = z0; z <= z1; z++) { g.set(fx0, y, z, wallC); g.set(fx1, y, z, wallC); }
    for (let x = fx0; x <= fx1; x++) { g.set(x, y, z0, roofC); g.set(x, y, z1, roofC); }
    z0++; z1--; y++;
  }
  return y;
}

// Windows stamped in a grid on the four perimeter walls at given Y rows.
export function windowsOn(g, x0, z0, x1, z1, yRows, win, step) {
  step = step || 2;
  for (const y of yRows) {
    for (let x = x0 + 1; x <= x1 - 1; x += step) { g.set(x, y, z0, win); g.set(x, y, z1, win); }
    for (let z = z0 + 1; z <= z1 - 1; z += step) { g.set(x0, y, z, win); g.set(x1, y, z, win); }
  }
}

// Small rooftop AC / vent box.
export function acUnit(g, x, y, z, c) { g.box(x, y, z, x + 1, y, z + 1, c); }

// ===========================================================================
// SANDBOX CATALOG — directly-placeable buildings (CONTRACTS-SANDBOX.md)
// Every type instantly recognizable + different from its neighbours.
// Footprints tw×td tiles. Voxel canvas ≤ (tw*8*res-1) wide/deep; height caps by
// max(tw,td): 1→48, 2→64, 3→56, 4→64 world units (×res voxels) (v3.2). catalogModel(id, variant) is
// deterministic via catRng; see _selfTest for the authoritative cap table.
// ===========================================================================

// deterministic PRNG seeded from a catalog id string + variant int
export function catRng(id, variant) {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h = (h ^ Math.imul((variant | 0) + 1, 0x9e3779b1)) >>> 0;
  return mulberry32(h || 1);
}
export const pk = (rng, a) => a[(rng() * a.length) | 0];

// FRONT NORMALIZATION (v2.1): every builder authors its front (door / entrance /
// sign / awning / marquee / gate) toward min-Z (z≈0). flipZ mirrors the model on
// the Z axis so the front lands on the +Z face (max-Z) for EVERY catalog model,
// as required by the facing convention. Determinism preserved (pure mirror).
export function flipZ(m) {
  const sz = m.sz;
  for (const b of m.blocks) b[2] = sz - 1 - b[2];
  return m;
}
// small flat rooftop sign board helper
export function signBoard(g, x0, x1, y, z, c) { for (let x = x0; x <= x1; x++) g.set(x, y, z, c); }

// ===========================================================================
// DETAIL HELPERS — resolution-agnostic building dressing (see AUTHORING GUIDE)
// ===========================================================================
// Sizes in the comments are suggestions for res 4 (32 voxels per tile). All
// helpers only call g.set/g.del, so they are deterministic and clip safely at
// the grid bounds.

// Wall handle. side: 'front' (the min-Z entrance face, pre-flipZ), 'back'
// (max-Z), 'left' (min-X), 'right' (max-X); plane = the wall's z (front/back)
// or x (left/right). Coordinates: u = x (front/back) or z (left/right), y up,
// out = voxels away from the building (1 = proud, -1 = recessed).
// `rd` is the viewer's left→right reading direction along u on the FINAL
// (flipped) model — pixelText uses it so lettering never comes out mirrored.
export function facade(g, side, plane) {
  const D = { front: [0, -1, 1], back: [0, 1, -1], left: [-1, 0, -1], right: [1, 0, 1] }[side];
  if (!D) throw new Error('facade: bad side ' + side);
  const alongX = D[0] === 0;
  const px = (u, out) => (alongX ? u : plane + D[0] * out);
  const pz = (u, out) => (alongX ? plane + D[1] * out : u);
  return {
    g, side, plane, rd: D[2],
    set(u, y, out, c) { g.set(px(u, out), y, pz(u, out), c); },
    del(u, y, out) { g.del(px(u, out), y, pz(u, out)); },
    box(u0, y0, o0, u1, y1, o1, c) {
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      if (o0 > o1) { const t = o0; o0 = o1; o1 = t; }
      for (let o = o0; o <= o1; o++) for (let y = y0; y <= y1; y++) for (let u = u0; u <= u1; u++) this.set(u, y, o, c);
    },
    clear(u0, y0, o0, u1, y1, o1) {
      if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      if (o0 > o1) { const t = o0; o0 = o1; o1 = t; }
      for (let o = o0; o <= o1; o++) for (let y = y0; y <= y1; y++) for (let u = u0; u <= u1; u++) this.del(u, y, o);
    },
  };
}

// Framed window: glass recessed one voxel into the wall, a frame ring in the
// wall plane, a proud sill below and (optionally) a lintel above.
// (u0, y0) = bottom-left glass voxel; w×h = glass size (res 4: 3×6 … 11×11).
// o: { glass=winCool, frame=white, sill=frame, lintel=true, recess=true,
//      mullion: 'cross'|'v'|'h'|<spacing>, shutters: colour }
export function windowFramed(f, u0, y0, w, h, o = {}) {
  const glass = o.glass != null ? o.glass : C.winCool;
  const frame = o.frame != null ? o.frame : C.white;
  const sill = o.sill != null ? o.sill : frame;
  const gOut = o.recess === false ? 0 : -1;
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  f.box(u0 - 1, y0 - 1, 0, u1 + 1, y1 + 1, 0, frame);               // frame ring
  f.clear(u0, y0, 0, u1, y1, 0);                                    // open the wall
  f.box(u0, y0, gOut, u1, y1, gOut, glass);
  const m = o.mullion;
  if (m === 'cross' || m === 'v') f.box(u0 + (w >> 1), y0, gOut, u0 + (w >> 1), y1, gOut, frame);
  if (m === 'cross' || m === 'h') f.box(u0, y0 + (h >> 1), gOut, u1, y0 + (h >> 1), gOut, frame);
  if (typeof m === 'number' && m > 1) for (let u = u0 + m - 1; u < u1; u += m) f.box(u, y0, gOut, u, y1, gOut, frame);
  f.box(u0 - 1, y0 - 1, 1, u1 + 1, y0 - 1, 1, sill);                // sill
  if (o.lintel !== false) f.box(u0 - 1, y1 + 1, 1, u1 + 1, y1 + 1, 1, frame);
  if (o.shutters != null) {
    f.box(u0 - 2, y0, 1, u0 - 2, y1, 1, o.shutters);
    f.box(u1 + 2, y0, 1, u1 + 2, y1, 1, o.shutters);
  }
}

// Door: recessed panel with frame, knob, a step and optional canopy.
// (u0, y0) = bottom-left of the door opening; res 4: w 4–6, h 10–13.
// o: { color=woodDark, frame=white, knob=gold, glass (upper-pane colour),
//      double=false, step=concrete (null = none), stepDepth=2, mat (colour),
//      canopy (colour) }
export function door(f, u0, y0, w, h, o = {}) {
  const col = o.color != null ? o.color : C.woodDark;
  const frame = o.frame != null ? o.frame : C.white;
  const knob = o.knob != null ? o.knob : C.gold;
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  f.box(u0 - 1, y0, 0, u1 + 1, y1 + 1, 0, frame);
  f.clear(u0, y0, 0, u1, y1, 0);
  f.box(u0, y0, -1, u1, y1, -1, col);
  if (o.glass != null) {
    const gy0 = y0 + Math.ceil(h * 0.55), gy1 = y1 - 1;
    if (o.double) { f.box(u0 + 1, gy0, -1, (u0 + u1 >> 1) - 1, gy1, -1, o.glass); f.box((u0 + u1 + 1 >> 1) + 1, gy0, -1, u1 - 1, gy1, -1, o.glass); }
    else f.box(u0 + 1, gy0, -1, u1 - 1, gy1, -1, o.glass);
  }
  const ky = y0 + (h >> 1) - 1;
  if (o.double) {
    f.box(u0 + (w >> 1), y0, -1, u0 + (w >> 1), y1, -1, frame);    // meeting stile
    f.set(u0 + (w >> 1) - 1, ky, 0, knob); f.set(u0 + (w >> 1) + 1, ky, 0, knob);
  } else {
    f.set(f.rd > 0 ? u1 - 1 : u0 + 1, ky, 0, knob);
  }
  const step = o.step === undefined ? C.concrete : o.step;
  const sd = o.stepDepth || 2;
  if (step != null && y0 > 0) f.box(u0 - 1, 0, 1, u1 + 1, y0 - 1, sd, step);
  if (o.mat != null && y0 > 0) f.box(u0, y0 - 1, 1, u1, y0 - 1, Math.max(1, sd - 1), o.mat);
  if (o.canopy != null) f.box(u0 - 2, y1 + 2, 1, u1 + 2, y1 + 2, 2, o.canopy);
}

// Sloped, striped awning. Top edge at y (against the wall, out 1), falling
// one voxel per voxel out for `depth` rows, with a scalloped valance.
// res 4: depth 3–5, stripe 2. o: { colors:[a,b], stripe=2, valance=true }
export function awning(f, u0, u1, y, depth, o = {}) {
  const cols = o.colors || [C.red, C.signWhite];
  const stripe = o.stripe || 2;
  const cOf = (u) => cols[(Math.floor(Math.abs(u - u0) / stripe)) % cols.length];
  for (let k = 0; k < depth; k++) {
    for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) {
      f.set(u, y - k, k + 1, cOf(u));
      if (k < depth - 1) f.set(u, y - k - 1, k + 1, cOf(u));   // 2-thick: no see-through stair
    }
  }
  if (o.valance !== false) {
    const yv = y - depth;
    for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) if (((u - u0) & 1) === 0) f.set(u, yv, depth, cOf(u));
  }
}

// Sign board (proud of the wall), optional 1-voxel border.
// o: { border (colour), out=1 }
export function signPanel(f, u0, u1, y0, y1, bg, o = {}) {
  const out = o.out || 1;
  f.box(u0, y0, out, u1, y1, out, bg);
  if (o.border != null) {
    f.box(u0, y0, out, u1, y0, out, o.border); f.box(u0, y1, out, u1, y1, out, o.border);
    f.box(u0, y0, out, u0, y1, out, o.border); f.box(u1, y0, out, u1, y1, out, o.border);
  }
}

// 3×5 pixel font. Each glyph: 5 rows top→bottom, '#' = voxel.
const FONT = {
  A: '.#.#.#####.##.#', B: '##.#.###.#.###.', C: '.###..#..#...##', D: '##.#.##.##.###.',
  E: '####..##.#..###', F: '####..##.#..#..', G: '.###..#.##.#.##', H: '#.##.#####.##.#',
  I: '###.#..#..#.###', J: '..#..#..##.#.#.', K: '#.##.###.#.##.#', L: '#..#..#..#..###',
  M: '#.########.##.#', N: '##.#.##.##.##.#', O: '.#.#.##.##.#.#.', P: '##.#.###.#..#..',
  Q: '.#.#.##.###..##', R: '##.#.###.#.##.#', S: '.###...#...###.', T: '###.#..#..#..#.',
  U: '#.##.##.##.####', V: '#.##.##.##.#.#.', W: '#.##.########.#', X: '#.##.#.#.#.##.#',
  Y: '#.##.#.#..#..#.', Z: '###..#.#.#..###', '0': '####.##.##.####', '1': '.#.##..#..#.###',
  '2': '##...#.#.#..###', '3': '##...#.#...###.', '4': '#.##.####..#..#',
  '5': '####..##...###.', '6': '.###..####.####', '7': '###..#.#..#..#.',
  '8': '####.#####.####', '9': '####.####..###.', '!': '.#..#..#.....#.',
  '-': '......###......', '.': '.............#.', ' ': '...............',
};

// Paint text on a facade; (u, y) = the viewer-LEFT, BOTTOM corner. Glyphs are
// 3 wide + 1 gap, 5 tall. Returns the width in voxels.
export function pixelText(f, u, y, text, c, out = 2) {
  const s = String(text).toUpperCase();
  let col = 0;
  for (const ch of s) {
    const gl = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) for (let i = 0; i < 3; i++)
      if (gl[r * 3 + i] === '#') f.set(u + f.rd * (col + i), y + 4 - r, out, c);
    col += 4;
  }
  return Math.max(0, col - 1);
}

// Bracket lamp: arm at out 1, glowing lamp (202) at out 2, dark cap above.
export function wallLamp(f, u, y, o = {}) {
  const arm = o.arm != null ? o.arm : C.darkGray;
  f.set(u, y, 1, arm);
  f.set(u, y + 1, 2, arm);
  f.box(u, y - 1, 2, u, y, 2, o.glow != null ? o.glow : C.lamp);
}

// Window/wall AC unit hanging on a facade: w×h face, d proud, a dark fan disc
// on one half and louvre lines on the other. res 4: w 4–5, h 3, d 2.
export function wallAC(f, u0, y0, o = {}) {
  const w = o.w || 4, h = o.h || 3, d = o.d || 2;
  const body = o.body != null ? o.body : C.offwhite, grille = o.grille != null ? o.grille : C.metalDark;
  f.box(u0, y0, 1, u0 + w - 1, y0 + h - 1, d, body);
  const half = w >> 1;
  f.box(u0, y0 + (h > 2 ? 1 : 0), d, u0 + half - 1, y0 + h - 1 - (h > 2 ? 1 : 0), d, grille);
  for (let y = y0; y < y0 + h; y += 2) f.box(u0 + half, y, d, u0 + w - 1, y, d, C.stone);
}

// Rooftop condenser: box with louvred sides and a dark fan disc on top.
// (x0,y0,z0) = min corner; res 4: w 6, d 5, h 4.
export function acBox(g, x0, y0, z0, o = {}) {
  const w = o.w || 6, d = o.d || 5, h = o.h || 4;
  const body = o.body != null ? o.body : C.offwhite, fan = o.fan != null ? o.fan : C.darkGray;
  const trim = o.trim != null ? o.trim : C.metalDark;
  const x1 = x0 + w - 1, z1 = z0 + d - 1, y1 = y0 + h - 1;
  g.box(x0, y0, z0, x1, y1, z1, body);
  for (let y = y0 + 1; y < y1; y += 2) {                       // louvres all round
    for (let x = x0 + 1; x < x1; x++) { g.set(x, y, z0, trim); g.set(x, y, z1, trim); }
    for (let z = z0 + 1; z < z1; z++) { g.set(x0, y, z, trim); g.set(x1, y, z, trim); }
  }
  g.box(x0 + 1, y1, z0 + 1, x1 - 1, y1, z1 - 1, fan);         // fan well
  g.set((x0 + x1) >> 1, y1, (z0 + z1) >> 1, trim);            // hub
}

// Parapet: a ring wall h voxels tall standing ON y, with a coping course on top.
export function parapet(g, x0, z0, x1, z1, y, h, c, coping) {
  g.walls(x0, y, z0, x1, y + h - 1, z1, c);
  if (coping != null) g.walls(x0, y + h, z0, x1, y + h, z1, coping);
}

// Solar panel: navy cells with a light grid every `cell` voxels, on short legs
// when y > the roof. o: { cell=3, colors:[panel, line], frame }
export function solarPanel(g, x0, z0, x1, z1, y, o = {}) {
  const cell = o.cell || 3;
  const [pc, lc] = o.colors || [C.navy, C.skyBlue];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const line = (x - x0) % cell === cell - 1 || (z - z0) % cell === cell - 1;
    g.set(x, y, z, line && x < x1 && z < z1 ? lc : pc);
  }
  if (o.frame != null) g.walls(x0, y, z0, x1, y, z1, o.frame);
}

// Rooftop vent pipe with a 3×3 cap.
export function ventPipe(g, x, z, y0, y1, c = C.metal, cap = C.metalDark) {
  for (let y = y0; y <= y1; y++) g.set(x, y, z, c);
  g.box(x - 1, y1 + 1, z - 1, x + 1, y1 + 1, z + 1, cap);
}

// Planter box (h tall) standing on y, soil in the top layer, plants poking up.
// o: { box=woodDark, soil=dirtDark, leaf=leafMid, flowers:[...], h=2, rng }
export function planter(g, x0, z0, x1, z1, y, o = {}) {
  const h = o.h || 2;
  const box = o.box != null ? o.box : C.woodDark;
  const soil = o.soil != null ? o.soil : C.dirtDark;
  const leaf = o.leaf != null ? o.leaf : C.leafMid;
  const flowers = o.flowers || [C.pink, C.yellow, C.signWhite];
  g.walls(x0, y, z0, x1, y + h - 1, z1, box);
  g.box(x0 + 1, y, z0 + 1, x1 - 1, y + h - 1, z1 - 1, soil);
  let i = 0;
  for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) {
    const r = o.rng ? o.rng() : ((x * 7 + z * 13) % 10) / 10;
    g.set(x, y + h, z, leaf);
    if (r < 0.45) g.set(x, y + h + 1, z, flowers[i++ % flowers.length]);
    else if (r < 0.7) g.set(x, y + h + 1, z, leaf);
  }
}

// Lot paving: a slab at y with an optional kerb rim of a different colour.
export function paving(g, x0, z0, x1, z1, y, c = C.sidewalk, rim = C.concrete) {
  g.box(x0, y, z0, x1, y, z1, c);
  if (rim != null) g.walls(x0, y, z0, x1, y, z1, rim);
}

// Street bench on y: seat along `axis` ('x' | 'z'), `len` long, backrest on
// the +side (back = +z for axis 'x', +x for axis 'z'). res 4: len 6–8.
export function bench(g, x0, y, z0, axis = 'x', len = 6, o = {}) {
  const seat = o.seat != null ? o.seat : C.wood, leg = o.leg != null ? o.leg : C.darkGray;
  const alongX = axis === 'x';
  const P = (a, yy, b, c) => (alongX ? g.set(x0 + a, yy, z0 + b, c) : g.set(x0 + b, yy, z0 + a, c));
  for (const a of [0, len - 1]) { P(a, y, 0, leg); P(a, y + 1, 0, leg); P(a, y, 1, leg); P(a, y + 1, 1, leg); P(a, y + 2, 2, leg); }
  for (let a = 0; a < len; a++) { P(a, y + 2, 0, seat); P(a, y + 2, 1, seat); P(a, y + 3, 2, seat); P(a, y + 4, 2, seat); }
}

// Lot plinth — THE shared building-lot convention (ART-DIRECTION.md "Lots").
// Every building model sits on one of these covering its whole footprint:
// a raised slab `h` fine voxels tall (res 4: h=2 → 0.5 world units) with a
// light concrete rim 1 voxel wide on top and a darker side band, and an inner
// surface of `fill`: 'pave' (light paving), 'grass', 'asphalt' (parking; draw
// your own lotLine stripes on top), or a palette index. Returns the y of the
// top surface to build on (= h).
export function lotPlinth(g, x0, z0, x1, z1, o = {}) {
  const h = o.h != null ? o.h : 2;
  const fill = o.fill === 'grass' ? C.lotGrass : o.fill === 'asphalt' ? C.lotAsphalt
    : typeof o.fill === 'number' ? o.fill : C.lotPave;
  for (let y = 0; y < h - 1; y++) g.walls(x0, y, z0, x1, y, z1, C.lotSide);
  if (h > 1) g.box(x0 + 1, 0, z0 + 1, x1 - 1, h - 2, z1 - 1, C.lotSide);
  g.box(x0, h - 1, z0, x1, h - 1, z1, fill);
  g.walls(x0, h - 1, z0, x1, h - 1, z1, C.lotRim);
  return h;
}

