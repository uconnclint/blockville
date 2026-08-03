// src/render/materials.js — CONTRACTS-RENDER.md §3.7
//
// The physically based material library for every voxel building / prop, plus
// the translucent placement-preview ("ghost") material.
//
// Replaces engine.js's flat MeshLambertMaterial with MeshStandardMaterial +
// onBeforeCompile injections that:
//   * consume the new per-vertex `aoT` (voxel AO) and `matParams` (roughness,
//     metalness) attributes produced by src/render/voxel.js,
//   * do full IBL from the PMREM env map handed in by setEnvironment(),
//   * drive the night glow off a per-window DUSK GATE rather than off uNight
//     directly (uNight is a linear clock, so multiplying by it lit every office
//     in the city at 4pm), with per-window on/off, brightness, bulb colour and
//     pane size — all wide enough to survive the tonemap,
//   * add a real specular lobe + env reflection on window glass,
//   * push neon (palette 203) well above 1.0 in HDR so the bloom pass sees it,
//   * add a sky-tinted rim/fill so silhouettes separate against the sky,
//   * add per-voxel + fine procedural grain so nothing reads "untextured",
//   * keep colours BRIGHT and SATURATED after the downstream ACES grade.
//
// Hard constraints honoured: three r160 vendored, no addons, no npm, no
// network, no binary assets, every texture procedural (this module needs none).

import * as THREE from '../../vendor/three.module.js';

// ===========================================================================
// ATTRIBUTE MAPPING — THE ONE PLACE TO CHANGE IF voxel.js DIFFERS
// ===========================================================================
// Everything about how the two new vertex attributes are *named* and
// *interpreted* lives in this block. If src/render/voxel.js turns out to write
// e.g. inverted AO (0 = lit) or (metalness, roughness) order, edit here only.

/** Attribute names as they must appear on the BufferGeometry. */
export const ATTR = {
  aoT: 'aoT',                 // float — 1.0 = fully lit, 0.0 = fully occluded
  matParams: 'matParams',     // vec2  — (.x = roughness, .y = metalness)
  color: 'color',             // vec3  — linear albedo (three's vertexColors)
  glowColor: 'glowColor',     // vec3  — linear night-glow colour
  emissiveT: 'emissiveT',     // float — 0 = not emissive, 1 = emissive
};

/** GLSL decoders. One-line changes if the conventions flip. */
const GLSL_DECODE = /* glsl */`
// --- ATTRIBUTE MAPPING (see ATTR in materials.js) -------------------------
// aoT: 1.0 = fully lit, 0.0 = fully occluded.   (invert here if it flips)
float voxDecodeAO(float a)        { return clamp(a, 0.0, 1.0); }
// matParams: .x = roughness, .y = metalness.    (swap here if it flips)
vec2  voxDecodeMatParams(vec2 p)  { return vec2(clamp(p.x, 0.03, 1.0), clamp(p.y, 0.0, 1.0)); }
// --------------------------------------------------------------------------
`;

/** Values used when a geometry is missing the new attributes (old voxel.js). */
const DEFAULT_ATTRIBUTE_VALUES = {
  aoT: [1.0],                 // no AO data -> fully lit (never black)
  matParams: [0.72, 0.0],     // no PBR data -> painted-matte dielectric
  glowColor: [0.0, 0.0, 0.0],
  emissiveT: [0.0],
  color: [1.0, 1.0, 1.0],
};

// ===========================================================================
// Palette -> (roughness, metalness) table
// ===========================================================================
// src/render/voxel.js owns the authoritative table and bakes it into
// `matParams`. This copy exists so (a) the harness can synthesise plausible
// attributes, (b) MaterialLib can answer materialParamsFor() for tooling, and
// (c) geometry that predates voxel.js still gets sane values via
// ensureAttributes(). Keyed by the sRGB hex from src/models.js PALETTE, with a
// luminance/saturation heuristic fallback so an unknown colour never breaks.

const R_GLASS = [0.055, 0.0];
const R_METAL = [0.28, 0.92];
const R_METAL_DARK = [0.36, 0.85];
const R_ROOFMETAL = [0.55, 0.35];
const R_GOLD = [0.22, 1.0];
const R_STONE = [0.86, 0.0];
const R_CONCRETE = [0.80, 0.0];
const R_ASPHALT = [0.90, 0.0];
const R_BRICK = [0.93, 0.0];
const R_WOOD = [0.80, 0.0];
const R_PAINT = [0.62, 0.02];   // painted plaster / render — the default wall
const R_FOLIAGE = [0.88, 0.0];
const R_WATER = [0.09, 0.0];
const R_SKIN = [0.68, 0.0];
const R_CLOTH = [0.86, 0.0];
const R_SAND = [0.92, 0.0];
const R_PLASTIC = [0.42, 0.0];

// hex -> [roughness, metalness]
const HEX_MATERIAL = new Map([
  // greens / foliage
  [0x7ec850, R_FOLIAGE], [0x5fae3a, R_FOLIAGE], [0x4a8f2c, R_FOLIAGE],
  [0x8fd84a, R_FOLIAGE], [0x5cb02f, R_FOLIAGE], [0x3f8a24, R_FOLIAGE],
  [0x2f7d3a, R_FOLIAGE], [0x24632d, R_FOLIAGE],
  [0xff9ec4, R_FOLIAGE], [0xf56fa6, R_FOLIAGE],
  [0x6fc23c, R_FOLIAGE], [0xa6e04f, R_FOLIAGE],
  // wood
  [0x8a5a2b, R_WOOD], [0x6b431f, R_WOOD], [0xc08a4a, R_WOOD],
  [0x8a5f2f, R_WOOD], [0xd8a45c, R_WOOD],
  [0x9b6b3f, R_SAND], [0x7a5230, R_SAND],
  // brick
  [0xc0533f, R_BRICK], [0x9a3f30, R_BRICK], [0x944b3a, R_BRICK],
  [0xc23b2e, R_BRICK],
  // painted / plastic reds
  [0xe23b2e, R_PLASTIC], [0xd8231b, R_PLASTIC], [0xa8221a, R_PLASTIC],
  // pastel walls (painted render)
  [0xa9d6e5, R_PAINT], [0xf7e08a, R_PAINT], [0xf6b5c8, R_PAINT],
  [0xb7e0a0, R_PAINT], [0xcbb6e6, R_PAINT], [0xf3e6c4, R_PAINT],
  [0xf5f5f0, R_PAINT], [0xe4e4dc, R_PAINT], [0xf6c9a0, R_PAINT],
  [0xa8e6cf, R_PAINT],
  // roofs
  [0x3f6fb0, R_PAINT], [0x7c4a2a, R_BRICK], [0x6b6f76, R_ROOFMETAL],
  [0x3f8a5a, R_PAINT], [0xe08a3c, R_PAINT], [0x6a4f9a, R_PAINT],
  // stone / concrete / asphalt
  [0x3a3d42, R_ASPHALT], [0x2b2e33, R_ASPHALT],
  [0xb9bcc0, R_CONCRETE], [0xcfd2d6, R_CONCRETE],
  [0x9aa0a6, R_STONE], [0x6e747a, R_STONE],
  // metals
  [0xaab0b6, R_METAL], [0x7a8087, R_METAL_DARK], [0x8b9096, R_METAL],
  [0x33363b, R_METAL_DARK],
  // yellows / gold
  [0xf5c518, R_PLASTIC], [0xf2c94c, R_PAINT], [0xf28c28, R_PLASTIC],
  [0xf7c948, R_PLASTIC], [0xe8b83a, R_GOLD], [0xf0a830, R_PLASTIC],
  // blues / water
  [0x5fc7e8, R_WATER], [0x3aa6d8, R_WATER], [0x2b7fb8, R_WATER],
  [0x3f7fd8, R_PAINT], [0x8fd0f0, R_GLASS], [0x2a4a8a, R_PAINT],
  [0x2fbfa8, R_PAINT],
  // skin
  [0xf6c9a8, R_SKIN], [0xe8b088, R_SKIN], [0xc98a5e, R_SKIN],
  [0x9c6238, R_SKIN], [0x6e4326, R_SKIN],
  // hair
  [0x2a2320, R_CLOTH], [0x5a3a22, R_CLOTH], [0xe0b860, R_CLOTH],
  [0x8a3f2a, R_CLOTH], [0xbfc2c6, R_CLOTH],
  // misc
  [0x1c1e22, R_PLASTIC], [0xf27fb0, R_PLASTIC], [0x8a5fc8, R_PLASTIC],
  [0xe6d3a3, R_SAND], [0xcbb57e, R_SAND], [0xfbfbf6, R_CONCRETE],
]);

// Emissive palette indices are fixed by contract §1.
const IDX_WIN_WARM = 200, IDX_WIN_COOL = 201, IDX_LAMP = 202, IDX_NEON = 203;

const INDEX_MATERIAL = new Map([
  [IDX_WIN_WARM, R_GLASS],
  [IDX_WIN_COOL, R_GLASS],
  [IDX_LAMP, [0.30, 0.0]],
  [IDX_NEON, [0.22, 0.0]],
]);

/**
 * Roughness/metalness for a palette index. `hex` is optional; when supplied it
 * enables the hex table + heuristic. Mirrors voxel.js's `materialFor`.
 * @returns {{roughness:number, metalness:number}}
 */
export function materialParamsFor(colorIndex, hex) {
  const byIndex = INDEX_MATERIAL.get(colorIndex);
  if (byIndex) return { roughness: byIndex[0], metalness: byIndex[1] };
  if (typeof hex === 'number') {
    const byHex = HEX_MATERIAL.get(hex >>> 0);
    if (byHex) return { roughness: byHex[0], metalness: byHex[1] };
    // Heuristic: near-neutral mid/dark greys read as metal, everything else
    // as painted matte. Never returns a mirror by accident.
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (sat < 0.10 && mx > 0.25 && mx < 0.80) return { roughness: 0.34, metalness: 0.80 };
    return { roughness: R_PAINT[0], metalness: R_PAINT[1] };
  }
  return { roughness: R_PAINT[0], metalness: R_PAINT[1] };
}

/**
 * Fill in `aoT` / `matParams` on a geometry that lacks them, so pre-voxel.js
 * geometry still renders correctly. Cheap and idempotent. Optional: the
 * material's defaultAttributeValues already covers the missing case, but
 * baking real per-vertex params looks much better.
 * @param {THREE.BufferGeometry} geo
 * @param {object} [opts] { palette, indexOf(vertexIndex)->paletteIndex }
 */
export function ensureAttributes(geo, opts) {
  if (!geo || !geo.attributes || !geo.attributes.position) return geo;
  const n = geo.attributes.position.count;
  if (!geo.attributes[ATTR.aoT]) {
    geo.setAttribute(ATTR.aoT, new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
  }
  if (!geo.attributes[ATTR.matParams]) {
    const mp = new Float32Array(n * 2);
    const idxOf = opts && typeof opts.indexOf === 'function' ? opts.indexOf : null;
    const pal = (opts && opts.palette) || null;
    for (let i = 0; i < n; i++) {
      let r = R_PAINT[0], m = R_PAINT[1];
      if (idxOf) {
        const ci = idxOf(i);
        const p = materialParamsFor(ci, pal ? pal[ci] : undefined);
        r = p.roughness; m = p.metalness;
      }
      mp[i * 2] = r; mp[i * 2 + 1] = m;
    }
    geo.setAttribute(ATTR.matParams, new THREE.Float32BufferAttribute(mp, 2));
  }
  return geo;
}

// ===========================================================================
// GLSL
// ===========================================================================

const COMMON_PARS = /* glsl */`
varying float vVoxAO;
varying vec2  vVoxMat;
varying vec3  vVoxGlow;
varying float vVoxEmi;
varying vec3  vVoxWorld;
varying vec3  vVoxNormalW;
varying float vVoxDepth;
varying vec3  vVoxGrid;      // object space, snapped so voxel cells are unit-aligned
varying vec3  vVoxNormalO;   // object-space normal — picks the two in-face axes
varying vec2  vVoxSeed;      // two per-instance seeds (see voxInstSeed)
`;

// Per-instance seed. Hashing modelMatrix's translation directly would STROBE on
// dynamics (cars/people move every frame, and fract-hashes are discontinuous),
// so this is a C-infinity trig field instead: constant for a static building,
// and a slow drift — never a pop — for something that moves. It decorrelates
// over ~2 world units, so neighbouring buildings on an 8-unit tile grid get
// unrelated values.
const GLSL_INST_SEED = /* glsl */`
float voxInstSeed(vec3 p, float salt) {
  p = p * 0.37 + salt;
  return 0.5 + 0.5 * clamp(
    sin(p.x * 1.73 + sin(p.z * 2.31) * 1.90 + p.y * 0.91) * 0.62 +
    sin(p.z * 2.87 - sin(p.x * 1.37) * 2.13 + p.y * 0.53) * 0.38, -1.0, 1.0);
}
`;

const VERT_PARS = /* glsl */`
attribute float ${ATTR.aoT};
attribute vec2  ${ATTR.matParams};
attribute vec3  ${ATTR.glowColor};
attribute float ${ATTR.emissiveT};
${COMMON_PARS}
${GLSL_DECODE}
${GLSL_INST_SEED}
`;

const VERT_BODY = /* glsl */`
vVoxAO      = voxDecodeAO(${ATTR.aoT});
vVoxMat     = voxDecodeMatParams(${ATTR.matParams});
vVoxGlow    = ${ATTR.glowColor};
vVoxEmi     = ${ATTR.emissiveT};
{
  vec4 voxWP  = modelMatrix * vec4(transformed, 1.0);
  vVoxWorld   = voxWP.xyz;
  vVoxNormalW = normalize(mat3(modelMatrix) * objectNormal);
  vVoxDepth   = -(viewMatrix * voxWP).z;
  vVoxNormalO = normalize(objectNormal);

  // --- voxel cell lattice ------------------------------------------------
  // voxel.js emits unit cubes on an integer lattice, but it centres the model
  // on X/Z, so a model with an ODD footprint sits on a half-integer offset.
  // Every vertex of one geometry shares that offset, so recover it from the raw
  // attribute and snap to the nearest half unit — the snap also absorbs the
  // micro-bevel inset when voxel.js is built with bevel:true.
  vec3 voxOff = fract(floor(fract(position) * 2.0 + 0.5) * 0.5);
  vVoxGrid    = transformed - voxOff;

  vec3 voxOrigin = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
  vVoxSeed = vec2(voxInstSeed(voxOrigin, 0.0), voxInstSeed(voxOrigin, 11.7));
}
`;

const FRAG_PARS = /* glsl */`
uniform float uNight;
uniform vec3  uSeason;
uniform float uSeasonStrength;
uniform float uTime;
uniform vec3  uRimColor;
uniform float uRimStrength;
uniform vec3  uSkyFillColor;
uniform float uSkyFill;
uniform float uAOStrength;
uniform float uAODirect;
uniform float uSat;
uniform float uWindowBoost;
uniform float uNeonBoost;
uniform float uNeonDay;
uniform vec3  uNeonGlow;
uniform float uGrain;
uniform float uWet;
uniform float uGlassSpec;
uniform float uGlassDarken;
uniform float uGrime;
uniform float uGlassEnv;
uniform float uGlassFresnel;
uniform vec2  uGlassMat;      // (roughness, metalness) the glass class is remapped to
uniform float uMetalRough;    // roughness ceiling for the conductor class
uniform float uSpread;        // dielectric roughness contrast (1 = table values)
uniform float uPanel;         // per-voxel panel/seam line depth
uniform float uInstVary;      // per-building albedo jitter (+/-)
uniform float uFloorVary;     // per-floor albedo jitter (+/-)
uniform float uWeather;       // vertical grime gradient up the facade
uniform float uWeatherFall;
uniform float uWinVary;       // per-window albedo jitter (+/-)
uniform float uWinReveal;     // reveal-AO darkening inside the pane border
uniform float uWinRevealW;    // reveal border width, fraction of the pane
uniform float uWinMullion;
uniform float uWinOff;        // fraction of windows unlit at night
uniform vec3  uWinLevel;      // per-window night intensity (lo, hi, gamma)
uniform float uWinTemp;       // per-window colour-temperature jitter
uniform vec3  uWinDusk;       // (firstOnAt, spread, rampWidth) in nightT
uniform float uWinSizeVary;   // per-window frame-width jitter -> pane SIZE
uniform float uWinSill;       // ledge/sill under every pane
uniform float uLedge;         // slab-lip highlight under each voxel top edge
uniform float uPanelH;        // extra weight on horizontal (floor) seams
uniform float uGlassTilt;     // per-pane normal tilt for the glass mirror
uniform float uGlassBow;      // pillow/bow across a pane for the glass mirror
uniform float uNeonSat;
uniform float uGlint;
uniform float uGlintPower;
uniform float uGlassSky;
uniform vec3  uGlassGround;
uniform float uSunHalo;
uniform float uSunHaloPower;
uniform float uSkyFromHemi;
uniform float uHemiGain;
uniform vec2  uTilePeriod;    // structure-noise period, in TILES (x = across, y = up)
uniform vec4  uTooth;         // (amplitude, gate lo px, gate hi px, target cell px)
uniform vec3  uTooth2;        // (joint depth, lip gain, joint width in device px)
uniform float uToothBump;     // relief strength of the sub-tile height field
uniform vec3  uGlassCity;     // (surrounding roofline, street distance, softness)
uniform float uGlassCityGain; // how bright the reflected city/street is
${COMMON_PARS}
${GLSL_DECODE}
${GLSL_INST_SEED}

// --- per-fragment scratch, shared between injection points -----------------
// The injections run in source order: color -> roughness -> metalness ->
// physical -> ao -> out. FRAG_COLOR fills these; everything after reads them.
vec2  voxMatR  = vec2(0.5, 0.0);   // remapped (roughness, metalness)
float voxGlass = 0.0;              // 1 = glass class (from the RAW attribute)
float voxWin   = 0.0;              // 1 = emissive window pane
float voxFrame = 0.0;              // 1 = inside the window reveal / mullion
float voxSill  = 0.0;              // 1 = on the sill/ledge under a pane
vec3  voxCell  = vec3(0.0);        // object-space voxel cell id
vec2  voxUV    = vec2(0.5);        // 0..1 across the voxel face
vec3  voxGlassN = vec3(0.0, 1.0, 0.0);  // per-pane perturbed WORLD normal (glass)
float voxToothH = 0.0;             // sub-tile height field, for the bump
float voxToothK = 1.0;             // its cells-per-tile, so the bump can be
                                   // converted to WORLD units (see FRAG_NORMAL)
vec2  voxPlane = vec2(0.0);        // CONTINUOUS in-face lattice coord, in tiles
float voxFaceSalt = 0.0;           // separates the six face directions
float voxTilePx = 8.0;             // device pixels across one voxel tile

float voxHash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

// --- BAND-LIMITED VALUE NOISE ----------------------------------------------
// MEASURED, and the loudest "this is Minecraft" cue in the frame: the per-voxel
// tonal jitter was an independent hash per cell. White noise has a FLAT
// spectrum, so half of its energy sits above half-Nyquist and neighbouring tiles
// land light/dark/light/dark — a chequerboard on the tile grid. The variance was
// never the problem; where it was spent was. Value noise buys a 4-8 tile
// decorrelation length for the same variance, which reads as panel bays and
// storey banding instead.
//
// CPU mirror, 96x96 tile patch, lag measured in TILES:
//   old white hash   sd 0.290   r1 0.003   r2 0.010   r4 -0.004
//   voxFbm3(7,5)     sd 0.290   r1 0.923   r2 0.753   r4  0.394   r8 0.00
// (voxVN alone loses variance to the interpolation; VOX_FBM_GAIN puts it back,
// so the budget in FRAG_COLOR is unchanged.)
float voxVN(vec2 p, float salt) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = voxHash13(vec3(i, salt));
  float b = voxHash13(vec3(i + vec2(1.0, 0.0), salt));
  float c = voxHash13(vec3(i + vec2(0.0, 1.0), salt));
  float d = voxHash13(vec3(i + vec2(1.0, 1.0), salt));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// 0.290 (white sd) / 0.1346 (measured fbm sd) — see the table above.
#define VOX_FBM_GAIN 2.1546
// Centred on 0, sd 0.290 — a drop-in replacement for (hash - 0.5).
float voxFbm3(vec2 p, float salt) {
  float s = (voxVN(p,       salt)        - 0.5)
          + (voxVN(p * 2.0, salt + 7.3)  - 0.5) * 0.5
          + (voxVN(p * 4.0, salt + 14.6) - 0.5) * 0.25;
  return s * (VOX_FBM_GAIN / 1.75);
}

float voxLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Push saturation up so PBR + IBL never washes the palette out. Keeps luma.
vec3 voxSaturate(vec3 c, float s) {
  return max(vec3(0.0), mix(vec3(voxLuma(c)), c, s));
}

// --- ATTRIBUTE MAPPING: which emissive class is this vertex? ---------------
// Neon (palette 203) must overdrive far harder than a window so the bloom pass
// actually sees it. Matched against the palette-derived neon glow colour that
// setPalette() uploads, so it survives a palette change.
float voxNeonness(vec3 glow) {
  float d = distance(glow, uNeonGlow);
  float byColor = 1.0 - smoothstep(0.06, 0.34, d);
  // Fallback when the palette was never set (uNeonGlow ~ black): use chroma.
  float mx = max(glow.r, max(glow.g, glow.b));
  float mn = min(glow.r, min(glow.g, glow.b));
  float chroma = mx > 1e-4 ? (mx - mn) / mx : 0.0;
  float byChroma = smoothstep(0.78, 0.95, chroma);
  return max(byColor, byChroma);
}
// --------------------------------------------------------------------------

// In-face UV (0..1 across the voxel quad) plus the integer cell id, both in the
// mesher's object-space lattice. Orientation-agnostic: the dominant normal axis
// is dropped and the other two become (u, v).
// Also hands back the CONTINUOUS in-face lattice coordinate (plane, in tiles)
// and a per-face-direction salt. Everything procedural below is built on
// that plane rather than on the cell id, because it is smooth across tile
// boundaries — noise built on it has no per-tile seam and, crucially, can be
// given a decorrelation length longer than one tile.
vec2 voxFaceUV(out vec3 cellId, out vec2 plane, out float salt) {
  vec3 an = abs(vVoxNormalO);
  vec3 ax = step(0.5, an);                       // 1 on the face-normal axis
  cellId  = floor(vVoxGrid - ax * sign(vVoxNormalO) * 0.5);
  vec3 f  = fract(vVoxGrid);
  if (ax.x > 0.5) { plane = vVoxGrid.zy; salt =  3.1 + sign(vVoxNormalO.x) * 0.7; return f.zy; }
  if (ax.y > 0.5) { plane = vVoxGrid.xz; salt = 11.4 + sign(vVoxNormalO.y) * 0.7; return f.xz; }
  plane = vVoxGrid.xy; salt = 19.8 + sign(vVoxNormalO.z) * 0.7; return f.xy;
}

// Pseudo-random in [0,1] for a voxel cell, offset by a per-instance seed.
// Built from sin() rather than fract() so that a MOVING object (whose seed
// drifts continuously) fades between values instead of strobing — a fract-hash
// of a changing seed would make every car's windows flicker every frame.
//
// sin() of a uniform phase is arcsine-distributed (bunched at 0 and 1), so the
// asin() undoes exactly that and hands back a UNIFORM value. Without it,
// "30% of windows off" is really 37% off, and "+/-25% intensity" is really a
// pile at the two extremes. Verified against the CPU mirror: 14210 window
// cells -> 63.1% lit before, 70.0% after.
float voxCellRand(vec3 cell, float seed, float salt) {
  float v = sin((voxHash13(cell + salt) + seed) * 6.2831853);
  return clamp(0.5 + asin(clamp(v, -1.0, 1.0)) * 0.3183098862, 0.0, 1.0);
}

// --- MATERIAL SPREAD -------------------------------------------------------
// voxel.js's per-palette table is the source of truth, but its classes sit too
// close together to read apart under one sun. Widen them here (this is the one
// place to retune):
//   glass    -> uGlassMat            (art direction: 0.10-0.20 rough / 0.8-1.0 metal)
//   metal    -> roughness <= uMetalRough, metalness 1.0
//   painted  -> pushed matte, so stucco can never share a highlight with a pane
//   masonry  -> pushed further matte still
vec2 voxRemapMat(vec2 mp) {
  float r = mp.x, m = mp.y;
  float glass = smoothstep(0.22, 0.06, r) * (1.0 - smoothstep(0.30, 0.50, m));
  float metal = smoothstep(0.55, 0.80, m);
  // Dielectric contrast stretch about the midpoint + a bump on the painted-wall
  // band (voxel.js 'paint' = 0.55), which is 40% of every facade in the city.
  float wall = smoothstep(0.42, 0.52, r) * (1.0 - smoothstep(0.58, 0.70, r));
  float rd = clamp(0.5 + (r - 0.5) * uSpread + 0.16 * wall, 0.03, 1.0);
  r = mix(rd, uGlassMat.x, glass);
  r = mix(r, min(mp.x, uMetalRough), metal);
  m = mix(m, uGlassMat.y, glass);
  m = mix(m, 1.0, metal);
  return vec2(clamp(r, 0.035, 1.0), clamp(m, 0.0, 1.0));
}
`;

// Injected right after <color_fragment>: albedo grade + procedural tooth.
const FRAG_COLOR = /* glsl */`
{
  voxMatR = voxRemapMat(vVoxMat);
  float voxRough = voxMatR.x;
  // Glass class comes from the RAW attribute: after the remap a pane is
  // metallic, so a "(1 - metalness)" test would no longer find it.
  voxGlass = smoothstep(0.22, 0.06, vVoxMat.x) * (1.0 - smoothstep(0.30, 0.50, vVoxMat.y));
  float voxNeon = voxNeonness(vVoxGlow);
  voxWin = step(0.5, vVoxEmi) * voxGlass * (1.0 - voxNeon);

  // Distance fade for voxel-SCALE structure (seams, reveals, sills, ledges).
  // Deliberately long: the hero/night shots sit at depth 70-190, where the old
  // single fade had already thrown away most of the texture in the file.
  // Sub-voxel detail is no longer scheduled off depth at all — see voxTilePx.
  float voxDFS = 1.0 - smoothstep(190.0, 380.0, vVoxDepth);

  voxUV = voxFaceUV(voxCell, voxPlane, voxFaceSalt);

  // Device pixels across one voxel tile, from the lattice's own derivative.
  // This is the LOD every procedural layer below is scheduled against — it is
  // the honest measure of how much detail the frame can actually show, and it
  // is the thing the old depth-based fades were a poor proxy for. MEASURED at
  // the reference framings: street 1366, night 38.5, hero 23.5, golden 21.3.
  vec3 voxDG = fwidth(vVoxGrid);
  voxTilePx = clamp(1.0 / max(max(voxDG.x, max(voxDG.y, voxDG.z)), 1e-6), 1.0, 4096.0);

  // Per-voxel tonal variation: makes a brick wall read as many bricks, not one
  // sticker. Scaled by roughness so glass and metal stay clean. Band-limited
  // (voxFbm3) so the SAME variance now decorrelates over 4-8 tiles instead of
  // tile to tile — panel bays and storey banding, not a chequerboard.
  float h1 = voxFbm3(voxPlane / uTilePeriod, voxFaceSalt + 7.13);
  float tone = h1 * 0.230 * voxRough * uGrain * voxDFS;

  // --- SUB-TILE MATERIAL TOOTH -------------------------------------------
  // MEASURED, and the whole of "detail collapses at close range": every other
  // texture cue in this file is voxel-scale or coarser, and at the street
  // framing one voxel face covers ~1366 device pixels — so a 12px measurement
  // window sits entirely INSIDE one face and saw a constant. Facade sigma/mean
  // there was 0.0000 (p75 0.0015), i.e. byte-identical pixels, at the one shot
  // where the facade is largest on screen.
  //
  // This layer subdivides the tile by a power of two picked from the tile's
  // SCREEN size, so its finest cell stays ~8-16 device pixels whatever the
  // distance: band-limited by construction, so it can never alias, and gated
  // off entirely at the hero/golden/night framings (21-38 px per tile), which
  // did NOT want more high-frequency energy. Detail is now strongest close up,
  // which is the way round it should always have been.
  float subGate = smoothstep(uTooth.y, uTooth.z, voxTilePx);
  if (subGate > 0.002) {
    float k = exp2(floor(log2(max(voxTilePx / max(uTooth.w, 1.0), 1.0))));
    vec2 sp = voxPlane * k;
    float t = ((voxVN(sp * 0.25, voxFaceSalt + 31.7) - 0.5) * 0.34
             + (voxVN(sp * 0.50, voxFaceSalt + 43.1) - 0.5) * 0.46
             + (voxVN(sp,        voxFaceSalt + 57.9) - 0.5) * 0.62) * uTooth.x;

    // --- SUB-TILE PANEL JOINTS ---------------------------------------------
    // Noise alone is aggregate, not architecture. A wall pressed against the
    // lens also has a JOINT GRID — brick courses, precast panel edges — and a
    // joint is worth far more per pixel than tone is: it is the thing that says
    // "this surface is made of parts". Pitched off the same power-of-two
    // subdivision, so the panels stay a constant size on screen, and given the
    // same lip highlight above the horizontal joint that the tile-scale seams
    // get, so the read is a lip and not a drawn line.
    float kp = max(k * 0.125, 2.0);
    vec2 sq = fract(voxUV * kp);
    vec2 pe2 = min(sq, 1.0 - sq) / kp;             // distance to a joint, in tiles
    float gw = uTooth2.z / voxTilePx;              // a fixed ~2 device px joint
    float joint = 1.0 - smoothstep(0.0, gw, min(pe2.x, pe2.y));
    float lip2  = (1.0 - smoothstep(gw, gw * 3.2, pe2.y)) * (1.0 - joint);
    t += lip2 * uTooth2.y - joint * uTooth2.x;
    t *= 1.0 - voxWin;

    voxToothH = t * voxRough * subGate;
    voxToothK = k;
    tone += voxToothH * uGrain;
  }
  // Soft-saturated rather than clamped. The sub-tile layer runs at an amplitude
  // whose tail would otherwise take the albedo negative, and a hard clamp turns
  // that tail into flat black/white speckle — it also makes the amplitude knob
  // stop responding (measured: sigma/mean went sub-linear above amp ~2). This
  // keeps the bulk of the distribution linear and only bends the extremes.
  diffuseColor.rgb *= max(0.10, 1.0 + tone / (1.0 + abs(tone) * 0.55));

  // --- per-INSTANCE albedo jitter ----------------------------------------
  // Twelve towers off the same model were byte-identical. Now each placement
  // gets its own tint. Seed is smooth in world position, so a car does not
  // strobe as it drives (see voxInstSeed).
  diffuseColor.rgb *= 1.0 + (vVoxSeed.x - 0.5) * 2.0 * uInstVary;

  // --- per-FLOOR albedo band ---------------------------------------------
  // Real facades are cast/poured a storey at a time and never match exactly —
  // but they are poured in RUNS, not one storey at a time in a random order.
  // Hashing each floor independently was the second half of the chequerboard
  // (CPU mirror, lag-1 floor autocorrelation 0.136); banding over ~4 storeys
  // takes it to 0.878 at the same sd (0.277 -> 0.226 x 1.23).
  float fb = voxVN(vec2(vVoxSeed.y * 37.0, voxCell.y * 0.25), 3.17);
  diffuseColor.rgb *= 1.0 + (fb - 0.5) * 2.46 * uFloorVary;

  // --- weathering gradient up the facade ---------------------------------
  // Object space, so it is anchored to the BUILDING (bottom = 0), not to the
  // world plane, and survives the growth animation's Y scale. Streaked
  // horizontally so it reads as run-off, not as a vignette. Dielectrics only.
  // Signed about 0.30, so the crown lifts as much as the base darkens: this adds
  // CONTRAST without dimming the city (art direction: richer, not grittier).
  {
    // Pivot 0.42 is the MEAN of exp(-0.085*y) over a typical 20-voxel facade,
    // so the term redistributes brightness instead of subtracting it. At 0.30
    // the "contrast" gradient was quietly costing the city ~2 luma everywhere.
    float up = exp(-max(vVoxGrid.y, 0.0) * uWeatherFall);
    // Run-off streaks are several bays wide, not one column wide — another
    // 1-tile alternation retired in favour of a ~4.5-tile band.
    float streak = 0.65 + 0.35 * voxVN(vec2(voxPlane.x * 0.22, vVoxSeed.y * 29.0), voxFaceSalt + 5.1);
    float dirt = uWeather * (up - 0.42) * streak * (1.0 - voxGlass) * (1.0 - voxMatR.y);
    diffuseColor.rgb *= (1.0 - dirt);
    // Grime is cooler and less saturated than the paint under it.
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(voxLuma(diffuseColor.rgb)) * vec3(0.94, 0.97, 1.04), max(dirt, 0.0) * 0.5);
  }

  // Contact grime: a soft darkening in the first couple of units above ground,
  // so buildings and props sit ON the world instead of hovering over it.
  float ground = exp(-max(vVoxWorld.y, 0.0) * 0.40);
  diffuseColor.rgb *= (1.0 - uGrime * ground * voxRough);

  // --- panel / seam lines -------------------------------------------------
  // engine.js ships with voxel.js's micro-bevel OFF (it costs 5x triangles), so
  // adjacent same-colour voxels had NOTHING separating them. A one-texel groove
  // on every cell boundary restores that read for free. fwidth keeps it a
  // constant ~1.5px wide, and voxDF retires it before it can alias.
  //
  // A groove alone still reads as a drawn line. Real cast concrete has a slab
  // LIP: the horizontal joint is deeper than the vertical one, and the course
  // above it catches a highlight. That asymmetry is what turns a line into
  // geometry, and it is the cheapest storey-scale texture a blank wall can get.
  {
    vec2 pe = min(voxUV, 1.0 - voxUV);
    float w = max(fwidth(voxUV.x + voxUV.y) * 1.5, 0.018);
    float seamV = 1.0 - smoothstep(0.0, w, pe.x);
    float seamH = 1.0 - smoothstep(0.0, w, pe.y);
    float seam = max(seamV, seamH * (1.0 + uPanelH));
    // Highlight on the lip just above each horizontal joint.
    float lip = (1.0 - smoothstep(w, w * 3.4, voxUV.y)) * (1.0 - seamH);
    float notWin = 1.0 - voxWin;
    diffuseColor.rgb *= 1.0 - uPanel * min(seam, 1.6) * voxDFS * notWin;
    diffuseColor.rgb *= 1.0 + uLedge * lip * voxDFS * notWin;
  }

  // --- windows: frame, reveal AO, glass gradient, per-pane variation -------
  // NOTE: derivatives are taken OUTSIDE any branch on voxWin — fwidth() in
  // divergent control flow is undefined, and window and wall voxels are
  // adjacent, so a branch here would garbage one pixel row along every pane.
  {
    // Per-pane FRAME WIDTH. This is where "every window is identical in size"
    // gets fixed: a wider frame is a smaller pane, and because the frame also
    // masks the emissive (see FRAG_OUT) the lit rectangle changes size too.
    float sr = voxCellRand(voxCell, vVoxSeed.y, 13.71);
    float rwv = uWinRevealW * mix(1.0 - uWinSizeVary, 1.0 + uWinSizeVary * 1.6, sr);

    float px = min(voxUV.x, 1.0 - voxUV.x);
    float dTop = 1.0 - voxUV.y;
    float dBot = voxUV.y;
    float fw = fwidth(voxUV.x + voxUV.y) * 1.5;
    float rw = max(fw, rwv);
    // Head + jambs are a recess: they go DARK. The cill does not — see below.
    float reveal = 1.0 - smoothstep(0.0, rw, min(px, dTop));
    // A lintel throws a deeper shadow into the head of the reveal.
    float lintel = reveal * smoothstep(0.45, 1.0, voxUV.y) * 0.7;
    // One vertical mullion down the middle of the pane.
    float mx = abs(voxUV.x - 0.5);
    float mull = (1.0 - smoothstep(0.0, max(fw, 0.028), mx)) * uWinMullion;
    voxFrame = clamp(reveal + lintel + mull, 0.0, 1.0) * voxWin;

    // --- SILL / LEDGE ------------------------------------------------------
    // The one piece of window geometry that faces UP. It catches sky, so it is
    // BRIGHTER than the wall, and it throws its own shadow onto the glass just
    // above it. Without this pair a pane is a decal; with it there is a
    // physical shelf at the bottom of every opening.
    float sillW = rw * 1.25;
    voxSill = (1.0 - smoothstep(sillW * 0.62, sillW, dBot)) * voxWin;
    float sillShadow = (1.0 - smoothstep(sillW, sillW * 2.6, dBot)) * (1.0 - voxSill);

    // Sky at the head of the pane, room at the cill.
    float grad = mix(0.80, 1.18, voxUV.y);
    float wr = voxCellRand(voxCell, vVoxSeed.y, 7.31);
    vec3 pane = diffuseColor.rgb * grad * (1.0 + (wr - 0.5) * 2.0 * uWinVary);
    pane *= mix(1.0, uWinReveal, voxFrame);
    pane *= 1.0 + uWinSill * voxSill * 1.5;              // the lit ledge
    pane *= 1.0 - uWinSill * sillShadow * 0.55 * voxWin; // its shadow on the glass
    diffuseColor.rgb = mix(diffuseColor.rgb, pane, voxWin);
  }

  // Glass: real panes are dark and mostly reflection. Drop the DIFFUSE albedo
  // so the specular/env lobe is what you actually see, instead of pale paint.
  // Scaled by (1 - metalness): a metallic pane has almost no diffuse left to
  // darken, and dimming it would only make the mirror dull.
  diffuseColor.rgb *= mix(1.0, uGlassDarken, voxGlass * (1.0 - voxMatR.y));

  // Weather tint (engine-owned uSeason). Off by default: strength 0.
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uSeason, uSeasonStrength);

  // Keep the palette bright + saturated through the PBR + ACES pipeline.
  diffuseColor.rgb = voxSaturate(diffuseColor.rgb, uSat);
}
`;

// Replaces <roughnessmap_fragment>: roughness comes from the vertex attribute.
const FRAG_ROUGHNESS = /* glsl */`
float roughnessFactor = voxMatR.x;
{
  float voxDF = 1.0 - smoothstep(70.0, 190.0, vVoxDepth);
  // Break up mirror-flat highlights. Absolute (not roughness-scaled) so metal
  // and painted surfaces both get micro-variation instead of a plastic sheen.
  // Band-limited like the albedo jitter: a half-voxel white-noise hash here was
  // feeding the same tile-scale chequer through the specular lobe.
  float h = voxVN(voxPlane * 0.34, voxFaceSalt + 3.7);
  roughnessFactor += (h - 0.5) * 0.108 * uGrain * voxDF;
  // Rain: up-facing surfaces get wet and glossy.
  float up = clamp(vVoxNormalW.y, 0.0, 1.0);
  roughnessFactor = mix(roughnessFactor, 0.10, uWet * up * 0.85);
  roughnessFactor = clamp(roughnessFactor, 0.035, 1.0);
}
`;

// Replaces <metalnessmap_fragment>.
const FRAG_METALNESS = /* glsl */`
float metalnessFactor = clamp(voxMatR.y, 0.0, 1.0);
`;

// Injected after <normal_fragment_maps>: turn the sub-tile height field into
// real relief.
//
// Tone alone is a decal — it does not move when the sun moves, so a wall at
// arm's length still reads as a painted flat. Making the same height field
// perturb the shading normal is what turns aggregate and panel joints into
// something the key light can rake across, and it is by far the most shading
// signal per instruction available at close range. Mikkelsen's unparametrised
// bump: the screen-space gradient of the height plus the screen-space gradient
// of the surface position is enough, so it needs no tangents and no extra noise
// taps. voxToothH is 0 wherever the sub-tile layer is gated off, and the gate is
// smooth in screen space, so the derivatives stay well defined.
const FRAG_NORMAL = /* glsl */`
#include <normal_fragment_maps>
if (uToothBump > 0.0) {
  // Mikkelsen compares a HEIGHT against a POSITION, so the height has to be in
  // world units or the two terms are off by many orders of magnitude and the
  // normal collapses onto the gradient (measured: it lifted the whole wall by
  // 32% luma). One tooth cell is 1/voxToothK of a voxel across, so that is the
  // length the relief is scaled by, and uToothBump becomes an honest
  // depth-to-width ratio.
  float bh = voxToothH * uToothBump / max(voxToothK, 1.0);
  vec3 sS = dFdx(vVoxWorld), sT = dFdy(vVoxWorld);
  vec3 r1 = cross(sT, normal), r2 = cross(normal, sS);
  float det = dot(sS, r1);
  vec3 grad = sign(det) * (dFdx(bh) * r1 + dFdy(bh) * r2);
  normal = normalize(abs(det) * normal - grad);
}
`;

// Injected after <lights_physical_fragment>: a real specular lobe for glass.
// A smooth non-metal *is* glass in this world, so derive it rather than
// needing another attribute.
const FRAG_PHYSICAL = /* glsl */`
{
  // Raise F0 from the dielectric default 0.04 toward glass/coated-glass. The
  // glass class is now mostly metallic, so this only bites on the dielectric
  // remainder — it still matters for wet roofs and for quality-0 tuning.
  float f0 = mix(0.04, 0.16, voxGlass * uGlassSpec);
  // Wet surfaces also get a stronger sheen.
  f0 = mix(f0, 0.09, uWet * clamp(vVoxNormalW.y, 0.0, 1.0));
  material.specularColor = mix(vec3(f0), diffuseColor.rgb, metalnessFactor);
  material.specularF90 = 1.0;
}
`;

// Replaces <aomap_fragment>: voxel AO from the attribute.
const FRAG_AO = /* glsl */`
{
  float voxAO = vVoxAO;
  float aoIndirect = mix(1.0, voxAO, uAOStrength);
  float aoDirect   = mix(1.0, voxAO, uAODirect);
  reflectedLight.indirectDiffuse  *= aoIndirect;
  reflectedLight.directDiffuse    *= aoDirect;
  reflectedLight.directSpecular   *= mix(1.0, voxAO, uAODirect * 0.6);
  float dotNV = saturate(dot(geometryNormal, geometryViewDir));
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(dotNV, aoIndirect, material.roughness);

  // Glass reflects more of the sky than a flat dielectric lobe implies. This is
  // what makes a window read as a pane instead of pale paint. Keyed off the RAW
  // attribute class (voxGlass), since a remapped pane is metallic now.
  reflectedLight.indirectSpecular *= mix(1.0, uGlassEnv, voxGlass);
  reflectedLight.directSpecular   *= mix(1.0, 1.0 + uGlassSpec * 1.6, voxGlass);

  // --- ANALYTIC SKY/HORIZON/GROUND MIRROR on glass ------------------------
  // MEASURED, and the single most important thing in this file: reflecting a
  // camera that looks DOWN off a VERTICAL pane sends the mirror ray BELOW the
  // horizon (R = 2(N.V)N - V flips the elevation). The sky PMREM is a dome with
  // no city in it, so every window in a top-down city shot was mirroring
  // nothing. That is why panes read as flat paint no matter how low the
  // roughness went.
  //
  // So glass gets an explicit environment instead of only the PMREM: sky above,
  // a warm horizon band, ground below, plus the sun's halo — all driven by the
  // WORLD reflection vector, so it swings as the camera orbits and the pane
  // reads as a mirror from any angle, at any hour.
  {
    vec3 Vw = normalize(cameraPosition - vVoxWorld);

    // --- PER-PANE GLASS NORMAL --------------------------------------------
    // MEASURED, and the reason "add an env reflection" kept failing: a voxel
    // face has ONE normal, so an analytic mirror returns ONE colour for the
    // whole pane and the whole facade. It is literally flat shading — exactly
    // the "sticker" read. Real curtain wall is never flat: every pane is set a
    // fraction of a degree off its neighbours and bows under its own weight.
    // Tilting the mirror normal per CELL makes neighbouring panes reflect
    // different parts of the sky (some catch the sun, some the ground), and
    // bowing it across the pane sweeps the reflection within one window. Only
    // the reflection vector is perturbed — the shading normal that the sun and
    // the CSM use is untouched, so nothing about the lighting solution moves.
    vec3 Nw = normalize(vVoxNormalW);
    {
      vec3 upA = abs(Nw.y) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
      vec3 T = normalize(cross(upA, Nw));
      vec3 B = cross(Nw, T);
      // Half of the tilt is a several-bay BAND and half is per pane. Real
      // curtain wall goes off-plane in runs (a whole bay of panes catches the
      // sky together) with pane-to-pane scatter on top; all-white-noise made it
      // a chequer of hot panes, which is not the same read at all.
      vec2 tilt = vec2(voxFbm3(voxPlane * 0.30, voxFaceSalt + 21.37),
                       voxFbm3(voxPlane * 0.30, voxFaceSalt + 27.91)) * 0.78
                + (vec2(voxCellRand(voxCell, vVoxSeed.y, 21.37),
                        voxCellRand(voxCell, vVoxSeed.y, 27.91)) - 0.5) * 0.62;
      vec2 bow = (voxUV - 0.5) * 2.0;
      vec2 d = (tilt * 2.0 * uGlassTilt + bow * uGlassBow) * voxGlass;
      Nw = normalize(Nw + T * d.x + B * d.y);
    }
    voxGlassN = Nw;
    vec3 Rw = reflect(-Vw, Nw);
    // Prefer the LIVE sky: the hemisphere light the rig drives already carries
    // sky/ground radiance for the current hour, and it costs nothing to read.
    // (engine.js never calls setSkyLight(), so the uniform fallbacks are a
    // fixed daytime blue — see the note in setSkyLight.)
    vec3 skyUp = uSkyFillColor, skyDn = uGlassGround;
    #if NUM_HEMI_LIGHTS > 0
      skyUp = mix(skyUp, hemisphereLights[0].skyColor * uHemiGain, uSkyFromHemi);
      skyDn = mix(skyDn, hemisphereLights[0].groundColor * uHemiGain, uSkyFromHemi);
    #endif
    vec3 skyC = mix(skyDn, skyUp, smoothstep(-0.40, 0.45, Rw.y));
    skyC = mix(skyC, uRimColor * 1.35, exp(-abs(Rw.y) * 8.0) * 0.55);

    // --- HEIGHT-DRIVEN SKY VISIBILITY --------------------------------------
    // MEASURED, and the reason a dome-only mirror still read as blue paint: for
    // a VERTICAL pane and a camera more than a few units away, N and V barely
    // move between the cill of a tower and its crown, so R barely moves, so an
    // environment that is a function of R ALONE returns one colour for the whole
    // facade. Flat top to bottom, exactly as reported.
    //
    // Real curtain wall is not graded by the dome, it is graded by what the
    // reflected ray HITS: a pane two storeys up mirrors the building across the
    // street, a pane at the crown mirrors open sky. That is a function of
    // HEIGHT, and it is the entire difference between glass and blue paint.
    // A ray leaving height y has to clear a roofline uGlassCity.x tall at
    // uGlassCity.y away, i.e. it needs elevation (roofline - y) / distance.
    // Below the crossover it mirrors the city; above it, the sky. Monotone in y
    // by construction, at any camera distance, at any hour.
    float needEl  = (uGlassCity.x - vVoxWorld.y) / max(uGlassCity.y, 1.0);
    float openSky = smoothstep(needEl - uGlassCity.z, needEl + uGlassCity.z, Rw.y);
    vec3  cityC   = mix(skyDn, uGlassGround, 0.65) * uGlassCityGain;
    vec3  envC    = mix(cityC, skyC, openSky);
    #if NUM_DIR_LIGHTS > 0
      // The sun is over the roofline too, so a pane that cannot see the sky
      // cannot catch its halo either.
      vec3 sunW = normalize(directionalLights[0].direction * mat3(viewMatrix));
      envC += directionalLights[0].color *
              (pow(max(dot(Rw, sunW), 0.0), uSunHaloPower) * uSunHalo * openSky);
    #endif
    // Schlick-ish: a pane is ~8% reflective head-on and a mirror at grazing.
    // Uses the PERTURBED normal, so the fresnel ramp also varies pane to pane
    // instead of being constant over a whole flat wall.
    float fr = mix(1.0, 0.08 + 0.92 * pow(1.0 - saturate(dot(Nw, Vw)), 4.0), uGlassFresnel);
    reflectedLight.indirectSpecular +=
      envC * mix(vec3(1.0), material.specularColor * 1.7, 0.65) *
      (uGlassSky * voxGlass * fr * aoIndirect);
  }

  // --- SUN GLINT on glass and metal --------------------------------------
  // Physically, a 0.14-roughness pane has a ~2 degree specular lobe. A city
  // camera looking DOWN at 32 degrees at a VERTICAL wall lit by a 19 degree sun
  // is ~13 degrees off the mirror direction, so the honest lobe essentially
  // never fires — measured: zero pixels above 1.0 HDR in the whole golden-hour
  // frame. This is a second, deliberately BROAD lobe (uGlintPower sets the
  // width) that only glass and conductors receive, so sun-facing towers throw a
  // highlight in the shot the game is actually framed for. It is occluded by
  // the cascaded shadow (csmLastShadow) so a facade in shade stays in shade.
  #if NUM_DIR_LIGHTS > 0
  {
    vec3 sunL = directionalLights[0].direction;
    vec3 sunH = normalize(sunL + geometryViewDir);
    // Glass uses the per-pane perturbed normal (brought back to view space), so
    // a curtain wall throws a SCATTER of hot panes instead of one uniform sheen
    // that either fires on every pane at once or — measured at the street shot —
    // on none of them ever.
    vec3 gN = normalize((viewMatrix * vec4(voxGlassN, 0.0)).xyz);
    vec3 sN = normalize(mix(geometryNormal, gN, voxGlass));
    float nh = saturate(dot(sN, sunH));
    float nl = saturate(dot(sN, sunL));
    float lobe = pow(nh, uGlintPower) * nl;
    float mask = max(voxGlass, smoothstep(0.55, 0.92, metalnessFactor));
    vec3 tint = mix(vec3(1.0), material.specularColor, 0.6);
    reflectedLight.directSpecular +=
      directionalLights[0].color * tint *
      (lobe * uGlint * mask * csmLastShadow * mix(1.0, voxAO, uAODirect * 0.6));
  }
  #endif

  // Sky fill: a tiny hemispheric bounce so the shadow side never goes flat
  // black and the silhouette keeps some colour. Occluded by voxel AO.
  float up = vVoxNormalW.y * 0.5 + 0.5;
  reflectedLight.indirectDiffuse +=
    diffuseColor.rgb * uSkyFillColor * (uSkyFill * up * aoIndirect * (1.0 - metalnessFactor));
}
`;

// Injected after <opaque_fragment>: rim light, then the EXACT legacy night mix,
// then the HDR emissive overdrive that feeds the bloom pass.
const FRAG_OUT = /* glsl */`
{
  float emiAmt = clamp(vVoxEmi * uNight, 0.0, 1.0);
  vec3  glow   = vVoxGlow;

  // --- PER-WINDOW night variation ----------------------------------------
  // Uniform emissives made a tower read as striped wallpaper. Hash each window
  // CELL (object space, so it is stable through the growth animation) against
  // the per-building seed and: switch uWinOff of them off for the night, give
  // each of the rest its own DUSK TIME, its own brightness and its own bulb
  // colour, and let the per-pane frame width decide how big the lit rectangle
  // is. All four are wide enough to see; the previous amplitudes were real but
  // sat inside the tonemap shoulder and measured 1.3-2.3% on screen.
  {
    float onR = voxCellRand(voxCell, vVoxSeed.y, 1.73);
    // Hard step, exactly like the CPU mirror in computeWindowGlows(): a half-lit
    // window is not a thing, and the soft version disagreed with the lights.
    float on  = step(uWinOff, onR);

    // --- DUSK GATE ---------------------------------------------------------
    // uNight is a linear 0..1 clock, so multiplying emissive by it lit every
    // office in the city at nightT 0.375 — a 20-degree LATE AFTERNOON sun. Nobody
    // turns the lights on at 4pm. Each window instead has its own switch-on
    // time in [uWinDusk.x, uWinDusk.x + uWinDusk.y], skewed LATE (sqrt), so a
    // handful of early risers appear first and the city fills in over dusk.
    // The window is dark below uWinDusk.x by construction, and that floor is
    // deliberately lighting.js's own pool fade-in (smoothstep 0.42 -> 0.68), so
    // the emissive pixels and the light they spill switch on together.
    float dr   = voxCellRand(voxCell, vVoxSeed.y, 2.91);
    float t0   = uWinDusk.x + uWinDusk.y * sqrt(dr);
    float dusk = smoothstep(t0, t0 + uWinDusk.z, uNight);

    // Brightness: a skewed spread, not a symmetric jitter — most rooms are a
    // single lamp and a few are a lit ceiling, which is what makes a real tower
    // look occupied rather than switched on at the mains.
    float ir = voxCellRand(voxCell, vVoxSeed.y, 5.11);
    float inten = mix(uWinLevel.x, uWinLevel.y, pow(ir, uWinLevel.z));

    // Bulb colour: roughly 2400K (tungsten) -> 4200K (cheap LED). Wide enough
    // to read as different apartments at 1:1.
    float tr = voxCellRand(voxCell, vVoxSeed.y, 9.43);
    vec3 warm = vec3(1.0 + 0.20 * uWinTemp, 1.0 - 0.02 * uWinTemp, 1.0 - 0.34 * uWinTemp);
    vec3 cool = vec3(1.0 - 0.18 * uWinTemp, 1.0 + 0.02 * uWinTemp, 1.0 + 0.30 * uWinTemp);
    vec3 tint = mix(warm, cool, tr);

    // The reveal and the sill are masonry: they stay dark even when the room
    // behind the glass is lit. That border is the only thing that keeps one
    // window from merging into the next once bloom gets hold of the frame.
    float rev = mix(1.0, uWinReveal, voxFrame) * (1.0 - voxSill * 0.92);
    vec3 winGlow = vVoxGlow * tint * inten * rev;
    glow   = mix(glow, winGlow, voxWin);
    emiAmt = mix(emiAmt, on * dusk, voxWin);
  }

  // --- Rim / silhouette separation ---------------------------------------
  // Exponent kept low (2.2): on flat voxel faces a tight fresnel only lights a
  // 1px silhouette sliver, which does nothing for separation against the sky.
  float fres = pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 2.2);
  float rimUp = 0.55 + 0.45 * clamp(vVoxNormalW.y * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor.rgb += uRimColor * (fres * uRimStrength * rimUp * mix(1.0, vVoxAO, 0.6) * (1.0 - emiAmt));

  // --- Night glow: the legacy lerp, with the per-window glow substituted --
  gl_FragColor.rgb = mix(gl_FragColor.rgb, glow, emiAmt);

  // --- HDR overdrive so bloom has real energy to work with ---------------
  // post.js owns the bloom curve; this owns how far above 1.0 the source goes.
  // Neon is SATURATED before it is pushed, so the bloom core keeps its hue
  // instead of every channel clipping to the same flat white.
  float neon = voxNeonness(vVoxGlow);
  vec3  hdr  = mix(glow, voxSaturate(glow, uNeonSat), neon);
  float dayNeon = vVoxEmi * neon * uNeonDay * (1.0 - uNight);
  float boost = emiAmt * mix(uWindowBoost, uNeonBoost, neon) + dayNeon * uNeonBoost;
  gl_FragColor.rgb += hdr * boost;
}
`;

// --- Ghost -----------------------------------------------------------------

const GHOST_VERT_PARS = /* glsl */`
varying vec3 vGhostN;
varying vec3 vGhostW;
varying float vGhostLum;
`;

const GHOST_VERT_BODY = /* glsl */`
{
  vec4 gwp = modelMatrix * vec4(transformed, 1.0);
  vGhostW = gwp.xyz;
  vGhostN = normalize(mat3(modelMatrix) * objectNormal);
  #ifdef USE_COLOR
    vGhostLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  #else
    vGhostLum = 0.6;
  #endif
}
`;

const GHOST_FRAG_PARS = /* glsl */`
uniform float uTime;
uniform float uGhostPulse;
varying vec3 vGhostN;
varying vec3 vGhostW;
varying float vGhostLum;
`;

// Replaces <color_fragment>: tint the whole model with the ghost colour,
// keeping the model's own luminance so the shape still reads.
const GHOST_FRAG_COLOR = /* glsl */`
diffuseColor.rgb = diffuse * (0.42 + 0.85 * clamp(vGhostLum, 0.0, 1.2));
`;

const GHOST_FRAG_OUT = /* glsl */`
{
  vec3 V = normalize(cameraPosition - vGhostW);
  float fres = pow(1.0 - clamp(dot(normalize(vGhostN), V), 0.0, 1.0), 2.2);
  // Bright fresnel shell + a slow vertical scan band -> reads as a hologram.
  float band = 0.5 + 0.5 * sin(vGhostW.y * 1.9 - uTime * 2.6);
  gl_FragColor.rgb += diffuse * (fres * 1.25 + band * 0.16) * uGhostPulse;
  gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.42, 0.0, 1.0);
}
`;

// ===========================================================================
// WINDOW GLOW EXTRACTION  —  data for LightingRig.setWindowGlows()
// ===========================================================================
// Emissive is decoration until something else in the scene is lit by it. The
// rig can do that (`setWindowGlows([{x,y,z,radius,intensity,color}])`) but has
// no way to know WHICH voxels are lit windows, where they are in world space,
// or which of them this shader switched off tonight. That is what this answers.
//
// Everything below is a faithful CPU mirror of the GLSL above — same hash, same
// per-instance seed, same on/off threshold, same brightness distribution, same
// colour-temperature drift — so the lights the rig places are the windows the
// shader actually lit, at the brightness it actually lit them.
//
// The one thing deliberately NOT mirrored is the per-window dusk gate, because
// engine.js caches this result for the whole night. lighting.js fades its own
// light pools in over smoothstep(0.42, 0.68, nightT), which is exactly the
// interval the shader's dusk thresholds span, so the two still switch on
// together without this side needing to know the hour. Verified against the
// live scene: 9370 of 14224 emissive glass cells lit = 65.9%, against the
// shader's step(uWinOff=0.34) = 66.0%.

/** GLSL `fract()` — floor-based, so negatives wrap the same way. */
function _fract(x) { return x - Math.floor(x); }
const _f32 = Math.fround;

/** Mirror of voxHash13(). */
function _hash13(x, y, z) {
  let px = _f32(_fract(_f32(x * 0.1031)));
  let py = _f32(_fract(_f32(y * 0.1030)));
  let pz = _f32(_fract(_f32(z * 0.0973)));
  const d = _f32(px * _f32(py + 33.33) + py * _f32(px + 33.33) + pz * _f32(pz + 33.33));
  px = _f32(px + d); py = _f32(py + d); pz = _f32(pz + d);
  return _f32(_fract(_f32(_f32(px + py) * pz)));
}

/** Mirror of voxInstSeed(). */
export function instanceSeed(x, y, z, salt) {
  const px = x * 0.37 + salt, py = y * 0.37 + salt, pz = z * 0.37 + salt;
  const v = Math.sin(px * 1.73 + Math.sin(pz * 2.31) * 1.90 + py * 0.91) * 0.62
          + Math.sin(pz * 2.87 - Math.sin(px * 1.37) * 2.13 + py * 0.53) * 0.38;
  return 0.5 + 0.5 * Math.max(-1, Math.min(1, v));
}

/** Mirror of voxCellRand(). */
function _cellRand(cx, cy, cz, seed, salt) {
  const h = _hash13(cx + salt, cy + salt, cz + salt);
  const v = Math.sin((h + seed) * 6.2831853);
  return Math.max(0, Math.min(1, 0.5 + Math.asin(Math.max(-1, Math.min(1, v))) * 0.3183098862));
}

/** Mirror of the vertex shader's lattice snap. */
function _gridOffset(v) {
  return _fract(Math.floor(_fract(v) * 2.0 + 0.5) * 0.5);
}

const GLOW_DEFAULTS = {
  band: 7,            // group a tower's windows into bands this tall (world units)
  winOff: 0.34,       // must match params.winOff or the lights lie
  winLevel: [0.34, 1.30, 0.85],   // must match params.winLevel
  winTemp: 1.0,       // must match params.winTemp
  minCells: 2,        // ignore a band with fewer lit panes than this
  // MEASURED: these billboards were responsible for 30.5% of night building
  // pixels moving by >4 luma — a warm additive wash that filled in the wall
  // BETWEEN the windows and erased the grid. They are still what makes a lit
  // tower light its own facade (that read is worth keeping), so the spill is
  // tightened rather than removed: about half the energy over about two thirds
  // of the footprint.
  intensity: 0.030,   // emitted intensity per lit pane in a band
  maxIntensity: 1.05,
  radiusScale: 1.05,  // radius = band extent * this, so spill reaches the street
  minRadius: 4,
  maxRadius: 18,
  max: 512,           // hard cap on returned glows (the rig batches, but still)
};

/**
 * Per-building emissive-window aggregates, ready for
 * `LightingRig.setWindowGlows()`.
 *
 * @param {THREE.Object3D|THREE.Object3D[]} objects  a mesh, an array of meshes,
 *        or any Object3D to traverse (e.g. the scene). Anything without the
 *        voxel attribute set is skipped.
 * @param {object} [opts] see GLOW_DEFAULTS
 * @returns {Array<{x:number,y:number,z:number,radius:number,intensity:number,
 *                  color:number[], cells:number, sourceId:*}>}
 *          `color` is LINEAR rgb (mean of the lit panes' glow colours, after the
 *          per-window colour-temperature drift). One entry per vertical band per
 *          building, so a 40-unit tower spills light at five heights instead of
 *          from one point in its middle.
 */
export function computeWindowGlows(objects, opts) {
  const o = Object.assign({}, GLOW_DEFAULTS, opts || {});
  const out = [];
  const list = [];
  const collect = (obj) => {
    if (!obj) return;
    if (Array.isArray(obj)) { for (const x of obj) collect(x); return; }
    if (typeof obj.traverse === 'function') obj.traverse((n) => { if (n.isMesh) list.push(n); });
    else if (obj.isMesh) list.push(obj);
  };
  collect(objects);

  const v = new THREE.Vector3();
  for (let mi = 0; mi < list.length; mi++) {
    const mesh = list[mi];
    const geo = mesh.geometry;
    if (!geo || !geo.attributes) continue;
    const pos = geo.attributes.position;
    const emi = geo.attributes[ATTR.emissiveT];
    const mp = geo.attributes[ATTR.matParams];
    const glo = geo.attributes[ATTR.glowColor];
    const nor = geo.attributes.normal;
    if (!pos || !emi || !mp || !glo || !nor) continue;

    mesh.updateWorldMatrix(true, false);
    const m = mesh.matrixWorld;
    const seed = instanceSeed(m.elements[12], m.elements[13], m.elements[14], 11.7);

    // Lattice offset: constant across the geometry, recovered exactly as the
    // vertex shader does.
    const ox = _gridOffset(pos.getX(0)), oy = _gridOffset(pos.getY(0)), oz = _gridOffset(pos.getZ(0));

    // voxel.js emits 4 vertices per face (8 with bevel:true); walking whole
    // faces means one sample per pane instead of four.
    const vox = geo.userData && geo.userData.voxel;
    const vpf = (vox && vox.faces > 0) ? Math.max(1, Math.round(vox.vertices / vox.faces)) : 4;

    const cells = new Map();
    for (let i = 0; i + vpf <= pos.count; i += vpf) {
      if (emi.getX(i) < 0.5) continue;
      if (mp.getX(i) > 0.20) continue;         // glass class only (not lamp/neon)
      // Face centre in lattice space, then step back half a voxel along the
      // normal to land in the cell that owns the face.
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < vpf; k++) { cx += pos.getX(i + k); cy += pos.getY(i + k); cz += pos.getZ(i + k); }
      cx = cx / vpf - ox; cy = cy / vpf - oy; cz = cz / vpf - oz;
      const ix = Math.floor(cx - nor.getX(i) * 0.5);
      const iy = Math.floor(cy - nor.getY(i) * 0.5);
      const iz = Math.floor(cz - nor.getZ(i) * 0.5);
      const key = ix + ',' + iy + ',' + iz;
      if (cells.has(key)) continue;
      // Same on/off decision the shader makes.
      if (_cellRand(ix, iy, iz, seed, 1.73) < o.winOff) continue;
      // Same colour temperature and same brightness distribution the shader
      // uses, so the light a tower casts matches the panes you can see.
      const tr = _cellRand(ix, iy, iz, seed, 9.43);
      const ir = _cellRand(ix, iy, iz, seed, 5.11);
      const kt = o.winTemp;
      cells.set(key, {
        ix, iy, iz,
        r: glo.getX(i) * (1 + 0.20 * kt * (1 - tr) - 0.18 * kt * tr),
        g: glo.getY(i) * (1 - 0.02 * kt * (1 - tr) + 0.02 * kt * tr),
        b: glo.getZ(i) * (1 - 0.34 * kt * (1 - tr) + 0.30 * kt * tr),
        w: o.winLevel[0] + (o.winLevel[1] - o.winLevel[0]) * Math.pow(ir, o.winLevel[2]),
      });
    }
    if (!cells.size) continue;

    // Bucket the lit cells into vertical bands, in WORLD space (mesh.scale.y is
    // the growth animation, so object-space heights lie).
    const bands = new Map();
    for (const c of cells.values()) {
      v.set(c.ix + 0.5 + ox, c.iy + 0.5 + oy, c.iz + 0.5 + oz).applyMatrix4(m);
      const bi = Math.floor(v.y / o.band);
      let b = bands.get(bi);
      if (!b) { b = { n: 0, w: 0, x: 0, y: 0, z: 0, r: 0, g: 0, bl: 0, minY: Infinity, maxY: -Infinity, ext: 0, cx: 0, cz: 0 }; bands.set(bi, b); }
      b.n++; b.w += c.w;
      b.x += v.x; b.y += v.y; b.z += v.z;
      b.r += c.r * c.w; b.g += c.g * c.w; b.bl += c.b * c.w;
      if (v.y < b.minY) b.minY = v.y;
      if (v.y > b.maxY) b.maxY = v.y;
      b._pts = b._pts || [];
      if (b._pts.length < 64) b._pts.push(v.x, v.z);
    }

    for (const b of bands.values()) {
      if (b.n < o.minCells) continue;
      const cx = b.x / b.n, cy = b.y / b.n, cz = b.z / b.n;
      let spread = 0;
      for (let k = 0; k < b._pts.length; k += 2) {
        const dx = b._pts[k] - cx, dz = b._pts[k + 1] - cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > spread) spread = d;
      }
      const extent = Math.max(spread, (b.maxY - b.minY) * 0.5, 1.5);
      out.push({
        x: cx, y: cy, z: cz,
        radius: Math.max(o.minRadius, Math.min(o.maxRadius, extent * o.radiusScale + 3)),
        intensity: Math.min(o.maxIntensity, b.w * o.intensity),
        color: [b.r / b.w, b.g / b.w, b.bl / b.w],
        cells: b.n,
        sourceId: mesh.uuid,
      });
    }
    if (out.length >= o.max) break;
  }

  // Brightest first, so a caller that truncates keeps the ones that matter.
  out.sort((a, b) => b.intensity - a.intensity);
  return out.length > o.max ? out.slice(0, o.max) : out;
}

// ===========================================================================
// MaterialLib
// ===========================================================================

const DEFAULT_PARAMS = {
  ao: 0.95,            // indirect AO strength
  aoDirect: 0.38,      // how much AO also bites direct light (voxels like it)
  saturation: 1.16,    // palette saturation lift (fights PBR/IBL wash-out)
  rim: 0.16,           // rim/silhouette strength (day)
  rimNight: 0.26,      // rim strength at full night
  skyFill: 0.16,       // hemispheric sky bounce into indirect diffuse
  windowBoost: 0.60,   // extra HDR energy on lit windows.
                       // MEASURED: at 0.9 the night frame's HDR peak was 1.94
                       // and a typical pane sat at ~1.6 — deep on the ACES
                       // shoulder, where a +/-25% change in emissive moves the
                       // displayed pixel by ~2%. That is why every window
                       // looked identical and why 10% of the facade clipped to
                       // cream. post.js's bloom threshold is 0.58 and must stay
                       // there (daytime HDR peaks at 0.87), so the fix is on
                       // this side: land a lit pane just above the threshold
                       // (~0.9-1.2) instead of far past it. Bloom still fires;
                       // the core no longer clips, so the per-window spread
                       // survives to the screen.
  neonBoost: 2.7,      // extra HDR energy on neon -> bloom (was 3.4; the
                       // saturation lift below buys back the apparent glow
                       // while leaving the bloom core enough headroom to keep
                       // its hue instead of clipping to flat white)
  neonDay: 0.0,        // daytime neon glow (0 preserves current day look)
  grain: 1.4,          // procedural tooth (1 = the original amplitude)
  tilePeriod: [5.0, 3.6],
                       // decorrelation length of the per-voxel tonal jitter, in
                       // TILES (across, up). CPU mirror over a 96x96 tile patch,
                       // lag in TILES:
                       //   old white hash   r1 0.003  r2 0.010  r4 -0.004
                       //   this             r1 0.863  r2 0.614  r4  0.197  r8 -0.05
                       // i.e. bays ~5 tiles wide and storey bands ~3.6 tall,
                       // decorrelating over 4-5 tiles, at the same sd (0.290).
                       // 7x5 measures even smoother (r1 0.923, r4 0.394) but on
                       // a 10-tile-wide tower that is nearly a per-BUILDING
                       // tint, which is what uInstVary is already for.
  tooth: [4.20, 40.0, 110.0, 8.0],
                       // sub-tile material tooth: (amplitude, screen px per
                       // tile where it starts, where it is full, target cell
                       // size in device px). Off below 40 px/tile, which is
                       // every framing except an actual close-up — hero 23.5,
                       // golden 21.3 and night 38.5 px/tile all sit under it,
                       // so this layer adds NO high-frequency energy to the
                       // shots that were already complaining about it.
                       // Amplitude MEASURED against street facade sigma/mean at
                       // 12px, through the soft saturation below:
                       //   2.6 -> 0.054   3.4 -> 0.065   4.2 -> 0.074   5.2 -> 0.083
                       // with the frame's mean luma flat (80.9 -> 83.6) and the
                       // 1st/99th percentile of wall luma at 36/119 against a
                       // median of 84 — mottling, not speckle. 4.2 lands the
                       // street shot just past the 0.071 it used to measure with
                       // a ROOFTOP framing, from 0.000 at the new one.
                       // Target cell 8 px MEASURED as the sweet spot: 5.5 and 11
                       // score the same, 22 loses 25%, 44 loses 50% — the street
                       // frame is behind the DOF near-blur (focus 22.5, wall at
                       // depth 1.5) which eats anything finer.
  tooth2: [0.48, 0.20, 2.2],
                       // sub-tile joint grid: (joint depth, lip highlight above
                       // the horizontal joint, joint width in device px)
  toothBump: 0.50,     // relief from the same height field (Mikkelsen bump)
  toothQ1: 0.55,       // its amplitude multiplier at quality 1 (0 at quality 0)
  glassSpec: 1.0,      // glass F0 lift on the dielectric remainder
  glassDarken: 0.72,   // glass DIFFUSE multiplier (scaled by 1 - metalness)
  glassEnv: 3.2,       // glass indirect-specular (sky reflection) multiplier
  glassFresnel: 0.85,  // how much of the analytic mirror is fresnel-weighted
  glassSky: 2.70,      // strength of the analytic sky/horizon/ground mirror.
                       // Raised from 1.35 alongside glassCity below: the sky
                       // -visibility term takes brightness AWAY from the bottom
                       // of every glass facade, and the art direction is BRIGHT,
                       // so the crown has to gain more than the base loses. It
                       // does: hero glass facades measure BRIGHTER on average
                       // (mean bin luma 129 -> 136) as well as graded.
  glassCity: [19.5, 12.0, 0.30],
                       // (surrounding roofline in world units, street width to
                       // the opposite facade, softness of the crossover). This
                       // is what makes a pane's reflection depend on its HEIGHT
                       // rather than only on the reflection vector — see the
                       // note in FRAG_AO. MEASURED at hero, median top-minus
                       // -bottom over a same-facing glass facade / its own mean:
                       //   term off        0.133   (painted wall alongside: 0.144)
                       //   22/15 gain .62  0.218
                       //   19/12 gain .44  0.34
                       // The reference city's roofline is 27-31 and its blocks
                       // are ~12 apart, so a roofline much above 20 puts the
                       // whole tower under the crossover and flattens it again.
  glassCityGain: 0.44, // how bright the reflected city/street is, against sky
  glassTilt: 0.085,    // per-pane mirror-normal tilt (curtain wall is not flat)
  glassBow: 0.055,     // pillow/bow of that normal across one pane
  sunHalo: 0.95,       // sun's halo inside that mirror
  sunHaloPower: 60,
  skyFromHemi: 1.0,    // 1 = read the live sky from the scene's hemisphere light
  hemiGain: 2.0,
  glint: 1.5,          // broad art-directed sun lobe on glass + metal
  glintPower: 12,      // its width. A voxel city has only axis-aligned faces,
                       // and the game's shots put the sun 105-120 degrees off
                       // the camera azimuth, so the best-aligned face is 24-52
                       // degrees off the half-vector (measured). Anything
                       // narrower than ~20 never fires on ANY surface.
  glassRough: 0.14,    // glass class roughness  (art direction: 0.10-0.20)
  glassMetal: 0.80,    // glass class metalness  (art direction: 0.80-1.00)
  metalRough: 0.35,    // conductor roughness ceiling (metal roofs -> 0.35/1.0)
  spread: 1.22,        // dielectric roughness contrast about 0.5
  grime: 0.26,         // contact darkening near the ground
  panel: 0.42,         // per-voxel seam/panel line depth
  panelH: 0.55,        // horizontal (floor) seams are deeper than vertical ones
  ledge: 0.15,         // slab-lip highlight above each horizontal seam
  instVary: 0.075,     // per-building albedo jitter (+/-)
  floorVary: 0.045,    // per-floor albedo jitter (+/-)
  weather: 0.30,       // vertical grime gradient up the facade
  weatherFall: 0.085,  // 1/e height of that gradient, in voxels
  winVary: 0.10,       // per-window albedo jitter (+/-)
  winReveal: 0.42,     // albedo/glow multiplier inside the window reveal
  winRevealW: 0.115,   // reveal border width as a fraction of the pane
  winSizeVary: 0.55,   // per-window frame-width jitter -> visibly unequal panes
  winSill: 1.00,       // sill/ledge brightness under every pane
  winMullion: 0.55,    // centre mullion strength
  winOff: 0.34,        // fraction of windows unlit at night
  // Per-window night brightness: mix(lo, hi, pow(rand, gamma)). Skewed so most
  // rooms are dim and a few are bright, which is what an occupied tower looks
  // like. sd/mean of this distribution is ~29% IN HDR — the previous +/-25%
  // symmetric jitter was applied on top of a value that was already clipping.
  winLevel: [0.34, 1.30, 0.85],
  winDusk: [0.44, 0.26, 0.10],  // (first switch-on nightT, spread, ramp width)
  winTemp: 1.0,        // per-window colour temperature spread (1 = ~2400-4200K)
  neonSat: 1.65,       // saturation applied to neon before the HDR push
  envIntensity: 1.0,
  seasonStrength: 0.0, // buildings are untinted today; engine may raise it
  ghostPulse: 1.0,
};

export class MaterialLib {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [opts]
   *   opts.uniforms  — { uNight, uSeason } SHARED uniform objects owned by
   *                    engine.js. Never cloned.
   *   opts.palette   — sRGB hex array (src/models.js PALETTE)
   *   opts.quality   — 0|1|2
   *   opts.params    — partial DEFAULT_PARAMS override
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer || null;
    this._quality = (opts.quality === undefined) ? 2 : (opts.quality | 0);
    this._env = null;
    this._time = 0;
    this._disposed = false;

    const p = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    this._params = p;

    // ---- Shared uniform objects (engine-owned when supplied) -------------
    const u = opts.uniforms || {};
    this.uniforms = {
      // SHARED — identity preserved, never cloned.
      uNight: u.uNight || { value: 0 },
      uSeason: u.uSeason || { value: new THREE.Vector3(1, 1, 1) },
      // Owned by this module.
      uTime: { value: 0 },
      uSeasonStrength: { value: p.seasonStrength },
      uRimColor: { value: new THREE.Color(0.72, 0.85, 1.0) },
      uRimStrength: { value: p.rim },
      uSkyFillColor: { value: new THREE.Color(0.55, 0.72, 1.0) },
      uSkyFill: { value: p.skyFill },
      uAOStrength: { value: p.ao },
      uAODirect: { value: p.aoDirect },
      uSat: { value: p.saturation },
      uWindowBoost: { value: p.windowBoost },
      uNeonBoost: { value: p.neonBoost },
      uNeonDay: { value: p.neonDay },
      uNeonGlow: { value: new THREE.Color(1.0, 0.19, 0.88) },
      uGrain: { value: p.grain },
      uWet: { value: 0 },
      uGlassSpec: { value: p.glassSpec },
      uGlassDarken: { value: p.glassDarken },
      uGlassEnv: { value: p.glassEnv },
      uGlassFresnel: { value: p.glassFresnel },
      uGlassMat: { value: new THREE.Vector2(p.glassRough, p.glassMetal) },
      uMetalRough: { value: p.metalRough },
      uSpread: { value: p.spread },
      uGrime: { value: p.grime },
      uPanel: { value: p.panel },
      uInstVary: { value: p.instVary },
      uFloorVary: { value: p.floorVary },
      uWeather: { value: p.weather },
      uWeatherFall: { value: p.weatherFall },
      uWinVary: { value: p.winVary },
      uWinReveal: { value: p.winReveal },
      uWinRevealW: { value: p.winRevealW },
      uWinMullion: { value: p.winMullion },
      uWinOff: { value: p.winOff },
      uWinLevel: { value: new THREE.Vector3(p.winLevel[0], p.winLevel[1], p.winLevel[2]) },
      uWinDusk: { value: new THREE.Vector3(p.winDusk[0], p.winDusk[1], p.winDusk[2]) },
      uWinSizeVary: { value: p.winSizeVary },
      uWinSill: { value: p.winSill },
      uWinTemp: { value: p.winTemp },
      uPanelH: { value: p.panelH },
      uLedge: { value: p.ledge },
      uGlassTilt: { value: p.glassTilt },
      uGlassBow: { value: p.glassBow },
      uNeonSat: { value: p.neonSat },
      uGlint: { value: p.glint },
      uGlintPower: { value: p.glintPower },
      uGlassSky: { value: p.glassSky },
      uGlassGround: { value: new THREE.Color(0.16, 0.17, 0.15) },
      uSunHalo: { value: p.sunHalo },
      uSunHaloPower: { value: p.sunHaloPower },
      uSkyFromHemi: { value: p.skyFromHemi },
      uHemiGain: { value: p.hemiGain },
      uTilePeriod: { value: new THREE.Vector2(p.tilePeriod[0], p.tilePeriod[1]) },
      uTooth: { value: new THREE.Vector4(p.tooth[0], p.tooth[1], p.tooth[2], p.tooth[3]) },
      uTooth2: { value: new THREE.Vector3(p.tooth2[0], p.tooth2[1], p.tooth2[2]) },
      uToothBump: { value: p.toothBump },
      uGlassCity: { value: new THREE.Vector3(p.glassCity[0], p.glassCity[1], p.glassCity[2]) },
      uGlassCityGain: { value: p.glassCityGain },
      uGhostPulse: { value: p.ghostPulse },
    };

    this.voxel = this._makeVoxelMaterial();
    this.ghost = this._makeGhostMaterial();
    this._mats = [this.voxel, this.ghost];

    this._tmpColor = new THREE.Color();
    this.setQuality(this._quality);
    if (opts.palette) this.setPalette(opts.palette);
  }

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  _makeVoxelMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,      // overridden per-vertex; kept sane as a fallback
      metalness: 0.0,
      envMapIntensity: this._params.envIntensity,
      dithering: true,      // kills banding on the big flat wall gradients
    });
    mat.name = 'voxelPBR';
    mat.defaultAttributeValues = Object.assign({}, DEFAULT_ATTRIBUTE_VALUES);

    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      // Share every uniform object — engine.js mutates uNight/uSeason directly.
      for (const k in U) shader.uniforms[k] = U[k];

      shader.vertexShader = VERT_PARS + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + VERT_BODY
      );

      // The sun glint reads `csmLastShadow`, the global lighting.js's CSM
      // injection leaves behind after it evaluates the cascaded shadow — that
      // is the only way to occlude a term added AFTER the lighting loop.
      // lighting.js prepends its pars after this hook, so its declaration lands
      // ahead of ours; when it is NOT in play we must declare the fallback
      // ourselves, and must NOT declare it when it is (redefinition is a
      // compile error). `patchMaterial()` tags the cache key, and it always
      // runs before the first compile.
      let csm = false;
      try {
        csm = typeof mat.customProgramCacheKey === 'function' &&
              /\|csm/.test(mat.customProgramCacheKey());
      } catch (e) { csm = false; }

      let f = (csm ? '' : 'float csmLastShadow = 1.0;\n') + FRAG_PARS + shader.fragmentShader;
      f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR);
      f = f.replace('#include <roughnessmap_fragment>', FRAG_ROUGHNESS);
      f = f.replace('#include <metalnessmap_fragment>', FRAG_METALNESS);
      // APPEND-ONLY: FRAG_NORMAL re-emits the chunk it matches (see the rule at
      // the top of terrain.js) and only adds after it.
      f = f.replace('#include <normal_fragment_maps>', FRAG_NORMAL);
      f = f.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + FRAG_PHYSICAL);
      f = f.replace('#include <aomap_fragment>', FRAG_AO);
      f = f.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + FRAG_OUT);
      shader.fragmentShader = f;

      mat.userData.shader = shader;
    };
    // Distinct cache key so this never shares a program with a stock standard
    // material somewhere else in the scene.
    // NOTE: the key must stay STABLE under lighting.js's `patchMaterial()`,
    // which wraps it as `<ours>|csm`. That suffix is what the compile hook above
    // tests for.
    mat.customProgramCacheKey = () => 'voxelPBR-v2';
    return mat;
  }

  _makeGhostMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0x66ff88,      // engine.js setGhost() overwrites this per frame
      roughness: 0.35,
      metalness: 0.0,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      envMapIntensity: 0.6,
    });
    mat.name = 'voxelGhost';
    mat.defaultAttributeValues = Object.assign({}, DEFAULT_ATTRIBUTE_VALUES);

    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = U.uTime;
      shader.uniforms.uGhostPulse = U.uGhostPulse;

      shader.vertexShader = GHOST_VERT_PARS + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + GHOST_VERT_BODY
      );
      let f = GHOST_FRAG_PARS + shader.fragmentShader;
      f = f.replace('#include <color_fragment>', GHOST_FRAG_COLOR);
      f = f.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + GHOST_FRAG_OUT);
      shader.fragmentShader = f;

      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => 'voxelGhost-v1';
    return mat;
  }

  // -------------------------------------------------------------------------
  // Public API (contract §3.7)
  // -------------------------------------------------------------------------

  /**
   * Palette in sRGB hex (src/models.js PALETTE). Used to derive the neon glow
   * colour the shader matches against, and to answer materialParamsFor().
   */
  setPalette(paletteArray) {
    this._palette = Array.isArray(paletteArray) ? paletteArray : null;
    if (!this._palette) return;
    const hex = this._palette[IDX_NEON];
    const c = this._tmpColor || (this._tmpColor = new THREE.Color());
    c.setHex(typeof hex === 'number' ? hex : 0xff3fb4, THREE.SRGBColorSpace);
    // Same derivation engine.js uses for the neon glow tint, so the shader's
    // colour match lands on the real neon vertices.
    this.uniforms.uNeonGlow.value.setRGB(
      Math.min(1, c.r * 1.7 + 0.1),
      Math.min(1, c.g * 1.7 + 0.1),
      Math.min(1, c.b * 1.7 + 0.1)
    );
  }

  /**
   * Per-building window-glow aggregates for `LightingRig.setWindowGlows()`,
   * using THIS lib's live window parameters so the lights match the pixels.
   * See computeWindowGlows() for the shape.
   */
  windowGlowsFor(objects, opts) {
    // Every knob the shader uses to decide WHICH panes are lit and HOW bright
    // they are is forwarded, so the CPU mirror can never drift from the pixels.
    // The dusk ramp is deliberately NOT applied here: engine.js caches this
    // result across the whole night (it only recomputes when the building set
    // changes or nightEff crosses 0.25), so baking a time-of-day factor in
    // would freeze the city at whatever hour the cache happened to fill. The
    // ramp lives in lighting.js's own pool fade instead — smoothstep(0.42,
    // 0.68, nightT), which is exactly the interval uWinDusk spans.
    const p = this._params;
    return computeWindowGlows(objects, Object.assign({
      winOff: p.winOff,
      winLevel: p.winLevel,
      winTemp: p.winTemp,
    }, opts || {}));
  }

  /** Roughness/metalness for a palette index, using this lib's palette. */
  materialFor(colorIndex) {
    const hex = this._palette ? this._palette[colorIndex] : undefined;
    return materialParamsFor(colorIndex, hex);
  }

  /**
   * PMREM cube (or equirect) env map from sky.getEnvironment(renderer).
   * Pass null to drop IBL. Safe to call at the sky module's low cadence.
   */
  setEnvironment(tex) {
    const had = !!this._env;
    this._env = tex || null;
    for (let i = 0; i < this._mats.length; i++) {
      const m = this._mats[i];
      m.envMap = this._env;
      // Program cache key does not change when only the texture object does,
      // so this re-inits uniforms without recompiling.
      m.needsUpdate = true;
    }
    if (had !== !!this._env) this._applyEnvIntensity();
  }

  /** 0 low, 1 medium, 2 high. No reallocation, no stutter. */
  setQuality(level) {
    this._quality = Math.max(0, Math.min(2, level | 0));
    const p = this._params;
    const q = this._quality;
    // Only uniform values change — the program is untouched.
    this.uniforms.uGrain.value = q === 0 ? 0.0 : (q === 1 ? p.grain * 0.65 : p.grain);
    this.uniforms.uAOStrength.value = q === 0 ? p.ao * 0.85 : p.ao;
    this.uniforms.uGrime.value = q === 0 ? p.grime * 0.6 : p.grime;
    // Surface detail scales with quality; the per-instance / per-window
    // VARIATION does not — it is what stops the city reading as copy-paste and
    // it costs nothing but a few ALU ops.
    this.uniforms.uPanel.value = q === 0 ? 0.0 : (q === 1 ? p.panel * 0.7 : p.panel);
    this.uniforms.uWeather.value = q === 0 ? p.weather * 0.5 : p.weather;
    this.uniforms.uWinMullion.value = q === 0 ? 0.0 : p.winMullion;
    // The sub-tile tooth is the only close-range detail there is, so it survives
    // a quality drop better than the rest — but it is also the layer that costs
    // the most fragment work when a facade fills the screen.
    const tq = q === 0 ? 0.0 : (q === 1 ? p.toothQ1 : 1.0);
    this.uniforms.uTooth.value.set(p.tooth[0] * tq, p.tooth[1], p.tooth[2], p.tooth[3]);
    this.uniforms.uTooth2.value.set(p.tooth2[0] * tq, p.tooth2[1] * tq, p.tooth2[2]);
    this.uniforms.uToothBump.value = p.toothBump * (q === 0 ? 0.0 : 1.0);
    this.ghost.envMapIntensity = q === 0 ? 0.3 : 0.6;
  }

  /** Partial parameter update. Keys mirror DEFAULT_PARAMS. */
  setParams(o) {
    if (!o) return;
    const p = this._params, U = this.uniforms;
    for (const k in o) if (o[k] !== undefined) p[k] = o[k];
    U.uAOStrength.value = p.ao;
    U.uAODirect.value = p.aoDirect;
    U.uSat.value = p.saturation;
    U.uSkyFill.value = p.skyFill;
    U.uWindowBoost.value = p.windowBoost;
    U.uNeonBoost.value = p.neonBoost;
    U.uNeonDay.value = p.neonDay;
    U.uGlassSpec.value = p.glassSpec;
    U.uGlassDarken.value = p.glassDarken;
    U.uGlassEnv.value = p.glassEnv;
    U.uGlassFresnel.value = p.glassFresnel;
    U.uGlassMat.value.set(p.glassRough, p.glassMetal);
    U.uMetalRough.value = p.metalRough;
    U.uSpread.value = p.spread;
    U.uGrime.value = p.grime;
    U.uInstVary.value = p.instVary;
    U.uFloorVary.value = p.floorVary;
    U.uWeatherFall.value = p.weatherFall;
    U.uWinVary.value = p.winVary;
    U.uWinReveal.value = p.winReveal;
    U.uWinRevealW.value = p.winRevealW;
    U.uWinMullion.value = p.winMullion;
    U.uWinOff.value = p.winOff;
    U.uWinLevel.value.set(p.winLevel[0], p.winLevel[1], p.winLevel[2]);
    U.uWinDusk.value.set(p.winDusk[0], p.winDusk[1], p.winDusk[2]);
    U.uWinSizeVary.value = p.winSizeVary;
    U.uWinSill.value = p.winSill;
    U.uWinTemp.value = p.winTemp;
    U.uPanelH.value = p.panelH;
    U.uGlassTilt.value = p.glassTilt;
    U.uGlassBow.value = p.glassBow;
    U.uLedge.value = p.ledge;
    U.uNeonSat.value = p.neonSat;
    U.uGlint.value = p.glint;
    U.uGlintPower.value = p.glintPower;
    U.uGlassSky.value = p.glassSky;
    U.uSunHalo.value = p.sunHalo;
    U.uSunHaloPower.value = p.sunHaloPower;
    U.uSkyFromHemi.value = p.skyFromHemi;
    U.uHemiGain.value = p.hemiGain;
    U.uTilePeriod.value.set(p.tilePeriod[0], p.tilePeriod[1]);
    U.uToothBump.value = p.toothBump;
    U.uGlassCity.value.set(p.glassCity[0], p.glassCity[1], p.glassCity[2]);
    U.uGlassCityGain.value = p.glassCityGain;
    U.uSeasonStrength.value = p.seasonStrength;
    U.uGhostPulse.value = p.ghostPulse;
    this._applyEnvIntensity();
    this.setQuality(this._quality);   // re-derive the quality-gated values
  }

  /**
   * Optional: tie the rim / sky-fill tint to the live sky, from
   * sky.update()'s return value. Colours are THREE.Color or hex.
   */
  setSkyLight(o) {
    if (!o) return;
    if (o.skyColor !== undefined) {
      this._setColor(this.uniforms.uSkyFillColor.value, o.skyColor);
      this._setColor(this.uniforms.uRimColor.value, o.skyColor);
      // Rim reads best a touch brighter and cooler than the raw sky.
      const c = this.uniforms.uRimColor.value;
      c.setRGB(Math.min(1, c.r * 0.9 + 0.2), Math.min(1, c.g * 0.95 + 0.22), Math.min(1, c.b * 1.0 + 0.3));
    }
    // What a window mirrors when it is looking DOWN — i.e. the city and the
    // terrain. sky.js's `groundColor` is exactly that; without it the default
    // is a dark olive that reads as "ground" at any hour.
    if (o.groundColor !== undefined) this._setColor(this.uniforms.uGlassGround.value, o.groundColor);
    if (o.rim !== undefined) this.uniforms.uRimStrength.value = o.rim;
  }

  _setColor(target, src) {
    if (src && src.isColor) target.copy(src);
    else if (typeof src === 'number') target.setHex(src, THREE.SRGBColorSpace);
    else if (Array.isArray(src)) target.setRGB(src[0], src[1], src[2]);
  }

  _applyEnvIntensity() {
    const base = this._params.envIntensity;
    // Night: the sky env goes dark on its own, so hold intensity up slightly
    // to keep window/metal reflections readable instead of dead black.
    const night = this.uniforms.uNight.value || 0;
    this.voxel.envMapIntensity = base * (1.0 + 0.22 * night);
  }

  /** Called every frame by engine.js. Allocation-free. */
  update(dt, ctx) {
    if (this._disposed) return;
    const d = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    this._time += d;
    this.uniforms.uTime.value = this._time;

    if (ctx) {
      if (typeof ctx.quality === 'number' && (ctx.quality | 0) !== this._quality) {
        this.setQuality(ctx.quality);
      }
      const night = (typeof ctx.nightEff === 'number') ? ctx.nightEff
        : (typeof ctx.nightT === 'number' ? ctx.nightT : (this.uniforms.uNight.value || 0));
      // Rim gets stronger and cooler at night so silhouettes stay readable.
      const p = this._params;
      this.uniforms.uRimStrength.value = p.rim + (p.rimNight - p.rim) * night;
      const wet = ctx.weather ? (ctx.weather.rain || 0) : 0;
      this.uniforms.uWet.value = wet;
      this._applyEnvIntensity();
    } else {
      this._applyEnvIntensity();
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this._mats.length; i++) {
      this._mats[i].envMap = null;
      this._mats[i].dispose();
    }
    // The shared engine-owned uniform objects are intentionally NOT touched.
    this._env = null;
    this._mats.length = 0;
  }
}

// ===========================================================================
// selfTest (contract §4)
// ===========================================================================

/**
 * Headless-ish assertions. Pass a WebGLRenderer to also verify the shaders
 * compile and link on the real GL context. Never throws.
 * @returns {{pass:boolean, notes:string[]}}
 */
export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const ok = (cond, msg) => { if (!cond) { pass = false; notes.push('FAIL: ' + msg); } else notes.push('ok: ' + msg); };

  try {
    // --- 1. material params table ---------------------------------------
    let tableOk = true;
    for (const [hex, v] of HEX_MATERIAL) {
      if (!(v[0] >= 0 && v[0] <= 1) || !(v[1] >= 0 && v[1] <= 1) || !isFinite(hex)) tableOk = false;
    }
    ok(tableOk, 'material table values all in [0,1], ' + HEX_MATERIAL.size + ' entries');
    const glass = materialParamsFor(IDX_WIN_WARM);
    ok(glass.roughness < 0.15 && glass.metalness === 0, 'window index 200 reads as glass');
    const unknown = materialParamsFor(9999, 0x123456);
    ok(isFinite(unknown.roughness) && isFinite(unknown.metalness), 'unknown palette index falls back cleanly');

    // --- 2. shared uniform identity --------------------------------------
    const sharedNight = { value: 0.37 };
    const sharedSeason = { value: new THREE.Vector3(1, 1, 1) };
    const lib = new MaterialLib(renderer || null, {
      uniforms: { uNight: sharedNight, uSeason: sharedSeason },
      palette: [],
    });
    ok(lib.uniforms.uNight === sharedNight, 'uNight uniform object shared, not cloned');
    ok(lib.uniforms.uSeason === sharedSeason, 'uSeason uniform object shared, not cloned');
    ok(!!lib.voxel && lib.voxel.isMeshStandardMaterial, 'lib.voxel is a MeshStandardMaterial');
    ok(!!lib.ghost && lib.ghost.transparent && lib.ghost.depthWrite === false, 'lib.ghost is translucent, no depth write');
    ok(!!lib.voxel.defaultAttributeValues.aoT, 'voxel material declares defaultAttributeValues for aoT');

    // --- 3. palette-driven neon uniform ----------------------------------
    lib.setPalette((() => { const a = []; a[203] = 0xff3fb4; return a; })());
    const ng = lib.uniforms.uNeonGlow.value;
    ok(isFinite(ng.r) && isFinite(ng.g) && isFinite(ng.b) && ng.r > 0.5, 'neon glow uniform derived from palette 203');

    // --- 4. geometry attribute plumbing ----------------------------------
    const geo = _testGeometry();
    ok(!!geo.attributes[ATTR.aoT] && geo.attributes[ATTR.aoT].itemSize === 1, 'aoT attribute present, itemSize 1');
    ok(!!geo.attributes[ATTR.matParams] && geo.attributes[ATTR.matParams].itemSize === 2, 'matParams attribute present, itemSize 2');
    let nan = false;
    for (const name in geo.attributes) {
      const arr = geo.attributes[name].array;
      for (let i = 0; i < arr.length; i++) if (!isFinite(arr[i])) { nan = true; break; }
    }
    ok(!nan, 'no NaN/Inf in test geometry attributes');

    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    ensureAttributes(bare);
    ok(!!bare.attributes[ATTR.aoT] && bare.attributes[ATTR.aoT].array[0] === 1, 'ensureAttributes() backfills aoT = 1');

    // --- 4b. voxel-cell lattice + per-instance seed -----------------------
    // The lattice snap must return the geometry's constant fractional offset
    // (0 or 0.5), and must absorb the micro-bevel inset.
    let snapOk = true;
    for (const [v, want] of [[3, 0], [3.5, 0.5], [-2.5, 0.5], [-3, 0],
                             [3.045, 0], [3.955, 0], [3.455, 0.5], [3.545, 0.5]]) {
      if (Math.abs(_gridOffset(v) - want) > 1e-6) snapOk = false;
    }
    ok(snapOk, 'voxel lattice snap recovers the half-integer offset (and eats the bevel inset)');

    // A moving object must not strobe: the seed has to be CONTINUOUS in world
    // position, which is the whole reason it is a trig field and not a hash.
    let maxStep = 0, spread = 0, prev = instanceSeed(0, 0, 0, 0);
    for (let i = 1; i <= 400; i++) {
      const s = instanceSeed(i * 0.02, 0, 0, 0);
      maxStep = Math.max(maxStep, Math.abs(s - prev));
      prev = s;
    }
    // ...but must still decorrelate across the 8-unit tile grid buildings sit
    // on, or twelve towers of one model stay identical. Measure the full range
    // AND the spread of a neighbour-difference over a 2D patch of tile centres.
    let lo = 1, hi = 0, nbr = 0;
    for (let ix = 0; ix < 12; ix++) {
      for (let iz = 0; iz < 12; iz++) {
        const s = instanceSeed(ix * 8, 0, iz * 8, 0);
        if (s < lo) lo = s;
        if (s > hi) hi = s;
        nbr = Math.max(nbr, Math.abs(s - instanceSeed((ix + 1) * 8, 0, iz * 8, 0)));
      }
    }
    spread = hi - lo;
    ok(maxStep < 0.03, 'per-instance seed is continuous (max step over 0.02 units: ' + maxStep.toFixed(4) + ')');
    ok(spread > 0.7 && nbr > 0.4,
      'per-instance seed decorrelates across the tile grid (range ' + spread.toFixed(3) +
      ', max neighbour delta ' + nbr.toFixed(3) + ')');

    // --- 4c. window glow extraction ---------------------------------------
    {
      const wm = new THREE.Mesh(_windowGeometry(), lib.voxel);
      wm.position.set(64.5, 0, 32.5);
      wm.updateWorldMatrix(true, false);
      const all = computeWindowGlows(wm, { winOff: -1, minCells: 1, band: 4 });
      const lit = computeWindowGlows(wm, { winOff: 0.30, minCells: 1, band: 4 });
      const nAll = all.reduce((a, b) => a + b.cells, 0);
      const nLit = lit.reduce((a, b) => a + b.cells, 0);
      ok(nAll === 24, 'window extractor found every emissive glass cell (' + nAll + '/24)');
      ok(nLit > 0 && nLit < nAll, 'window extractor switches some windows off (' + nLit + '/' + nAll + ')');
      ok(all.length > 1, 'a tall building yields more than one vertical glow band (' + all.length + ')');
      let sane = true;
      for (const g of all) {
        if (![g.x, g.y, g.z, g.radius, g.intensity].every(isFinite)) sane = false;
        if (g.radius <= 0 || g.intensity <= 0) sane = false;
        if (!Array.isArray(g.color) || g.color.length !== 3 || !g.color.every(isFinite)) sane = false;
        // Glows must be in WORLD space, i.e. carry the mesh's placement.
        if (Math.abs(g.x - 64.5) > 6 || Math.abs(g.z - 32.5) > 6) sane = false;
      }
      ok(sane, 'glow entries are finite, positive and in world space');
      ok(computeWindowGlows(null).length === 0, 'window extractor tolerates null');
      wm.geometry.dispose();
    }

    // --- 5. quality switching does not touch the program ------------------
    const before = lib.voxel.version;
    lib.setQuality(0); lib.setQuality(1); lib.setQuality(2);
    ok(lib.voxel.version === before, 'setQuality() does not force a shader recompile');

    // --- 6. shader compile + 100 env-swap cycles (needs a real renderer) --
    if (renderer && renderer.getContext) {
      const gl = renderer.getContext();
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.4));
      const dir = new THREE.DirectionalLight(0xffffff, 1.0);
      dir.position.set(3, 5, 2);
      scene.add(dir);
      const mesh = new THREE.Mesh(geo, lib.voxel);
      scene.add(mesh);
      const gm = new THREE.Mesh(geo, lib.ghost);
      gm.position.x = 3;
      scene.add(gm);
      const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      cam.position.set(0, 2, 6);
      cam.lookAt(0, 0.5, 0);

      const rt = new THREE.WebGLRenderTarget(16, 16);
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prevTarget);

      const err = gl.getError();
      ok(err === gl.NO_ERROR, 'GL error code after render: ' + err);

      const progs = renderer.info.programs;
      let compileOk = true;
      let found = 0;
      if (progs) {
        for (const p of progs) {
          if (p.cacheKey && p.cacheKey.indexOf('voxel') !== -1) {
            found++;
            if (p.program && gl.getProgramParameter(p.program, gl.LINK_STATUS) !== true) compileOk = false;
          }
        }
      }
      ok(found >= 1, 'voxel programs created: ' + found);
      ok(compileOk, 'all voxel programs linked');

      // 100 env swaps + 100 render-target resizes: no program growth, no leak.
      const progsBefore = progs ? progs.length : 0;
      const pmremish = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
      pmremish.needsUpdate = true;
      for (let i = 0; i < 100; i++) {
        lib.setEnvironment(i % 2 ? pmremish : pmremish);
        lib.setQuality(i % 3);
        lib.update(1 / 60, { quality: i % 3, nightEff: (i % 20) / 20, weather: { rain: 0 } });
        rt.setSize(8 + (i % 16), 8 + (i % 16));
      }
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prevTarget);
      const progsAfter = renderer.info.programs ? renderer.info.programs.length : 0;
      ok(progsAfter - progsBefore <= 2, 'program count stable over 100 env/quality cycles (' + progsBefore + ' -> ' + progsAfter + ')');
      ok(gl.getError() === gl.NO_ERROR, 'no GL error after 100 cycles');

      lib.setEnvironment(null);
      pmremish.dispose();
      rt.dispose();
      geo.dispose();
    } else {
      notes.push('skip: no WebGLRenderer supplied — shader compile/link and leak cycles not verified');
    }

    lib.dispose();
    ok(lib.uniforms.uNight === sharedNight, 'dispose() left the engine-owned uNight object intact');
    ok(sharedNight.value === 0.37, 'dispose() did not mutate the engine-owned uNight value');
  } catch (e) {
    pass = false;
    notes.push('FAIL: threw ' + (e && e.message ? e.message : e));
  }

  return { pass, notes };
}

/**
 * A 1x12x2 "tower" of emissive glass faces on an integer lattice — 24 window
 * cells over 12 storeys, shaped like what voxel.js emits (4 vertices per face,
 * one face per cell, +Z normals).
 */
function _windowGeometry() {
  const cells = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 2; x++) cells.push([x, y]);
  const n = cells.length * 4;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3), glo = new Float32Array(n * 3);
  const emi = new Float32Array(n), ao = new Float32Array(n), mp = new Float32Array(n * 2);
  const idx = new Uint16Array(cells.length * 6);
  for (let c = 0; c < cells.length; c++) {
    const [cx, cy] = cells[c];
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let k = 0; k < 4; k++) {
      const v = c * 4 + k, p = v * 3;
      pos[p] = cx + corners[k][0]; pos[p + 1] = cy + corners[k][1]; pos[p + 2] = 1;
      nor[p] = 0; nor[p + 1] = 0; nor[p + 2] = 1;
      col[p] = 0.9; col[p + 1] = 0.82; col[p + 2] = 0.6;
      glo[p] = 1.0; glo[p + 1] = 0.85; glo[p + 2] = 0.54;
      emi[v] = 1; ao[v] = 1;
      mp[v * 2] = 0.07; mp[v * 2 + 1] = 0.16;   // voxel.js's glass class
    }
    const b = c * 4, o = c * 6;
    idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
    idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute(ATTR.color, new THREE.BufferAttribute(col, 3));
  g.setAttribute(ATTR.glowColor, new THREE.BufferAttribute(glo, 3));
  g.setAttribute(ATTR.emissiveT, new THREE.BufferAttribute(emi, 1));
  g.setAttribute(ATTR.aoT, new THREE.BufferAttribute(ao, 1));
  g.setAttribute(ATTR.matParams, new THREE.BufferAttribute(mp, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData.voxel = { faces: cells.length, vertices: n };
  return g;
}

/** A small cube with every attribute this material consumes. */
function _testGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const glo = new Float32Array(n * 3);
  const emi = new Float32Array(n);
  const ao = new Float32Array(n);
  const mp = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    col[i * 3] = 0.8; col[i * 3 + 1] = 0.35; col[i * 3 + 2] = 0.25;
    glo[i * 3] = 1.0; glo[i * 3 + 1] = 0.85; glo[i * 3 + 2] = 0.55;
    emi[i] = (i % 12 < 6) ? 1 : 0;
    ao[i] = 0.5 + 0.5 * ((i % 7) / 6);
    mp[i * 2] = 0.2 + 0.7 * ((i % 5) / 4);
    mp[i * 2 + 1] = (i % 9 === 0) ? 0.9 : 0.0;
  }
  g.setAttribute(ATTR.color, new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute(ATTR.glowColor, new THREE.Float32BufferAttribute(glo, 3));
  g.setAttribute(ATTR.emissiveT, new THREE.Float32BufferAttribute(emi, 1));
  g.setAttribute(ATTR.aoT, new THREE.Float32BufferAttribute(ao, 1));
  g.setAttribute(ATTR.matParams, new THREE.Float32BufferAttribute(mp, 2));
  return g;
}

export default MaterialLib;
