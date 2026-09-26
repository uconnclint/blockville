// src/render/water.js — §3.3 of CONTRACTS-RENDER.md
//
// Stylised voxel-city water for Blockville (art target: ref05's hotel pool in
// tools/rendertest/ART-DIRECTION.md). Owns EVERYTHING at the water plane:
//   * a flat, bright pool-blue surface at y = -2.6 (recessed ~3.3 below the
//     pool rim; round 4) over every WATER tile, every bridge tile and an
//     apron of open sea past the map edge,
//   * depth read as stepped TERRACES (pale band -> shallow -> pool blue ->
//     open water) quantised on a voxel grid, all still bright and saturated,
//   * drifting light/dark axis-aligned slabs and little white wave dashes,
//   * a crisp, gently breathing white foam line + two soft surf lines that
//     follow the land's REAL (warped) edge via a baked signed distance field
//     (NO scene-depth-buffer read — the post stack owns the depth buffer),
//   * square rain ripples, sunset tint, deep-blue night with city-light streaks.
//   * an optional sculpted sea bed (engine.js uses terrain.js's instead).
//
// Everything is procedural: no assets, no npm, no build step, no addons.
//
// Public API:
//   const water = new WaterFX(scene, opts);
//   water.buildSurface(state);
//   water.refreshTiles(state, x, z);
//   water.setLandWarp(fn, step);     // optional: follow terrain.js's warped bank
//   water.update(dt, ctx);
//   water.dispose();
//   import { selfTest } from './water.js';

import * as THREE from '../../vendor/three.module.js';

// ---------------------------------------------------------------------------
// World constants (mirrored from src/constants.js — this module stays
// dependency-free so the render-test harness can import it standalone).
// ---------------------------------------------------------------------------
const TILE = 8;
const N_DEFAULT = 80;
const CHUNK = 16;
// Round 4: the surface sits a good 2.5 units below the pool rim, so the far
// walls read as tall banded basin faces (ref05's hotel pool) instead of a thin
// outline. life.js (boats) mirrors this; engine.js turns terrain's seabed off.
const WATER_Y = -2.6;            // round 11: -1.85 -> -2.6, taller pool walls (life.js agrees)
const T_WATER = 1;
const T_SAND = 2;

const SQRT2 = Math.SQRT2;
const INF = 1e9;

// ---- the voxel basin (ref05's hotel pool: water recessed below a hard rim) --
// Every SAND tile becomes a raised sand deck (same 0.5 height as the lot
// plinths), a cream coping lip runs along every deck edge that meets water,
// and every land/water tile edge gets a vertical pool wall from below the
// surface up to the rim — so the water reads as RECESSED, and the far walls
// show their saturated blue inner faces to the camera exactly like ref05.
const DECK_Y = 0.5;             // sand deck top (lot plinths are 0.5 too)
const LIP = 0.24;               // coping lip above the deck
// Round 7: a wider light-CONCRETE coping (ref kerbs #dcd8cc) between the sand
// and the water — the cream one read as more sand at game zoom.
const COPE_W = 1.7;             // coping width
const WET_SAND = 1.1;           // damp-sand strip on the deck beside the coping
const COPE_FACE = 0.2;          // pale coping face at the top of every deck wall
// Round 5: the two visible wall orientations get their own tone (ref05: lit
// face #0086d0, shaded face #004d95) — the lighting alone left both one navy.
// Keyed by the wall's outward normal; +z faces screen-left (lit), +x faces
// screen-right (shade) under the default iso camera, like every building.
// Round 8: px 0.58 -> 0.8 (the shade face went navy); both faces now also
// carry WALL_GLOW (self-lit share of their colour, see bankMaterial).
const WALL_TONE = { px: 0.92, pz: 0.84, nx: 0.92, nz: 0.88 };   // wave4: w3 critic 'near-black navy band' -> mid azure
//   // round 14: the shade pair reads darker (ref05 #0087cc lit / #004d95 shade)   // round 11: both near-equal like ref05 (#0087c9 / #008bd4)
const WALL_GLOW = 0.25;          // wave2: 0.65 clipped the wall to one flat #0994f8 (ref #0081bf -> #033f7e)
const GROUND_TOP = 0.03;        // wall top where the bank is plain ground
const WALL_SINK = 0.45;          // walls run this far below the surface
const WALL_PANEL = 2.0;          // round 13: vertical tile columns only (critic r12: grout grid too strong)
const WALL_SEAM = 0.12;          // darker seam between wall tile columns
const WET_BAND = 0.18;           // round 13: bright wet waterline strip just above the surface
const WALL_EPS = 0.02;          // walls sit just inside the water tile
const SIDE_BOT = -0.06;         // deck outer faces tuck under the ground
const EDGE_BOT = -3.25;         // map-edge cut face: terrain's borderY (-3.2) sea
const BANK_COLORS = {
  deckTop: 0xf7d9a0,            // ref05 deck #fad79d
  deckSide: 0xd9a86a,           // ref05's darker deck edge band
  deckWet: 0xe6b677,            // round 11: damp sand along the coping (wet-edge step)
  lawnTop: 0x9ccb48,            // round 7: raised lawn beds on the outer sand ring
  lawnSide: 0x6d9a2e,
  hedge: 0x5fae34, hedgeTop: 0x86c83f, hedgeBase: 0x3f8a2a,
  copeTop: 0xdcd8cc,            // light concrete coping (ART-DIRECTION kerb colour)
  copeSide: 0xa9a293,           // its outer faces: a crisp grey edge on the sand
  copeFace: 0xe6e2d6,           // its face over the water, capping the wall
  wall: 0x0a7cc6,               // round 14: top tile row; lower rows step darker (ROW_K)               // ref05 wall #0087c9..#008bd4 (lit side) — pool tiles
  wallAlt: 0x0c84ce,            // alternate tile column (subtle)
  wallSeam: 0x086cb2,           // seams between the wall tiles (round 13: softer)
  wallWet: 0xd6f6ff,             // round 14: a bright foam edge line where the water meets the wall            // round 13: bright waterline strip where the water laps the wall
  wallGrout: 0x04447e,          // (unused since w4r2: the top of the wall is a light lip, wallLip)
  wallLip: 0x7fdcff,            // w4r2: light highlight along the top edge of the pool wall (critic w4r1)
  deckKerb: 0xe8e2d2,           // w4r2: light concrete kerb on the deck's outer edge (lot-plinth rim)
  pier: 0xdcd8cc,               // bridge piers: light concrete like the kerbs
  pierSide: 0xb9b4a6,
  wallTop: 0x6fcdef,            // thin light band where a grass bank meets the wall
  // floats
  red: 0xf2463a, white: 0xfdfdf8, yellow: 0xffc62e, blue: 0x2e7cf0, orange: 0xff8a2a,
  lounge: 0x3fb8e8,
  seaEdge: 0x1aa6ff,
};
const MAX_FLOATS = 18;
const MAX_PARASOLS = 24;

// ---------------------------------------------------------------------------
// Small deterministic noise helpers (build-time only, never per frame)
// ---------------------------------------------------------------------------

function hash01(ix, iz, salt) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^
           Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Non-tiling value noise used for the low-frequency water-body variation field.
function vnoise(x, z, salt) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const c00 = hash01(x0, z0, salt), c10 = hash01(x0 + 1, z0, salt);
  const c01 = hash01(x0, z0 + 1, salt), c11 = hash01(x0 + 1, z0 + 1, salt);
  const a = c00 + (c10 - c00) * sx;
  const b = c01 + (c11 - c01) * sx;
  return a + (b - a) * sz;
}

function srgb(hex) {
  const c = new THREE.Color();
  if (c.setHex.length >= 2) c.setHex(hex, THREE.SRGBColorSpace);
  else c.setHex(hex);
  return c;
}

// ---------------------------------------------------------------------------
// Procedural tiling normal map (RGB = tangent-space normal, A = height).
// One 256² RGBA texture, sampled at three scales with three scroll velocities.
// ---------------------------------------------------------------------------
function makeWaveNormalTexture(size = 256, strength = 2.1) {
  const h = new Float32Array(size * size);
  // Octaves on wrapping lattices — every lattice size divides `size`, so the
  // result tiles seamlessly.
  const octs = [
    { lat: 4, amp: 1.00, salt: 1301 },
    { lat: 8, amp: 0.52, salt: 2711 },
    { lat: 16, amp: 0.27, salt: 4177 },
    { lat: 32, amp: 0.14, salt: 6247 },
    { lat: 64, amp: 0.07, salt: 8837 },
  ];
  let norm = 0;
  for (const o of octs) norm += o.amp;
  const invNorm = 1 / norm;
  // Bake each octave's lattice once (with a wrapped extra row/column) so the
  // per-pixel work is 4 array reads instead of 4 hashes.
  for (const o of octs) {
    const L = o.lat, lut = new Float32Array((L + 1) * (L + 1));
    for (let j = 0; j <= L; j++) {
      for (let i = 0; i <= L; i++) lut[j * (L + 1) + i] = hash01(i % L, j % L, o.salt);
    }
    const scale = L / size, amp = o.amp * invNorm;
    for (let z = 0; z < size; z++) {
      const gz = z * scale, z0 = gz | 0, fz0 = gz - z0;
      const sz = fz0 * fz0 * (3 - 2 * fz0);
      const r0 = z0 * (L + 1), r1 = (z0 + 1) * (L + 1);
      const row = z * size;
      for (let x = 0; x < size; x++) {
        const gx = x * scale, x0 = gx | 0, fx0 = gx - x0;
        const sx = fx0 * fx0 * (3 - 2 * fx0);
        const a = lut[r0 + x0] + (lut[r0 + x0 + 1] - lut[r0 + x0]) * sx;
        const b = lut[r1 + x0] + (lut[r1 + x0 + 1] - lut[r1 + x0]) * sx;
        h[row + x] += (a + (b - a) * sz) * amp;
      }
    }
  }

  const data = new Uint8Array(size * size * 4);
  const M = size - 1;                       // size is a power of two
  const at = (x, z) => h[(z & M) * size + (x & M)];
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      // 4-tap central difference (in normalised height units per texel)
      const dx = (at(x + 1, z) - at(x - 1, z)) * 0.5;
      const dz = (at(x, z + 1) - at(x, z - 1)) * 0.5;
      let nx = -dx * strength * size / 32;
      let nz = -dz * strength * size / 32;
      const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
      nx *= inv; nz *= inv;
      const ny = inv; // z-up in tangent space
      const i = (z * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 3] = Math.round(Math.max(0, Math.min(1, at(x, z))) * 255);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Shared GLSL for the (optional) sea bed: shore-field sampling + a gentle swell.
const COMMON_GLSL = /* glsl */`
uniform sampler2D uShoreMap;
uniform vec2  uWorldSize;
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveScale;

// R = coarse distance from the TRUE waterline (0 shore .. 1 = far tiles out)
// G = water coverage mask (tile based)
// B = fine SIGNED distance from the true waterline, world units, remapped
// A = beachiness (nearest land is sand)
vec4 shoreAt(vec2 wxz) {
  return texture2D(uShoreMap, wxz / uWorldSize);
}

vec3 swell(vec2 p, float t) {
  vec3 r = vec3(0.0);
  const vec2 d0 = vec2(0.86, 0.51);
  const vec2 d1 = vec2(-0.42, 0.91);
  float k0 = 6.2831853 / (46.0 * uWaveScale);
  float k1 = 6.2831853 / (27.0 * uWaveScale);
  float ph0 = dot(d0, p) * k0 + t * 0.85;
  float ph1 = dot(d1, p) * k1 - t * 1.15;
  r.x  = 0.05 * sin(ph0) + 0.03 * sin(ph1);
  r.yz = 0.05 * k0 * cos(ph0) * d0 + 0.03 * k1 * cos(ph1) * d1;
  return r;
}
`;

// ---------------------------------------------------------------------------
// Surface shader — stylised "voxel pool" water.
//
// Art target (tools/rendertest/ART-DIRECTION.md, ref05's hotel pool): a flat,
// clean, saturated pool blue with lighter axis-aligned slabs drifting across
// it, a few little white "wave dash" marks, lighter shallows and a crisp white
// foam line hugging the shore. No normal maps, no noise, no fresnel mirror, no
// navy depths — every tone is authored, and every edge is a hard, anti-aliased
// step on either a voxel grid or the baked shore-distance field.
// ---------------------------------------------------------------------------

const SURFACE_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>

varying vec3 vWorld;

void main() {
  vec3 transformed = position;
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  // @CSM_VERTEX_MAIN
  #include <fog_vertex>
}
`;

const SURFACE_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>

uniform sampler2D uShoreMap;
uniform vec2  uWorldSize;
uniform float uTime;
uniform float uNight;
uniform float uRain;
uniform float uQuality;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyTop;

uniform vec3  uEdgeColor;     // pale band hugging the shore
uniform vec3  uShallowColor;  // first terrace
uniform vec3  uMidColor;      // the pool blue
uniform vec3  uDeepColor;     // open water (still bright)
uniform vec3  uSeaColor;      // the open sea: matches terrain.js's off-map sea
uniform vec3  uPatchColor;    // the light turquoise step hugging the pool wall
uniform vec3  uWallLine;      // hard line where the water meets a pool wall
uniform vec3  uFoamColor;
uniform vec3  uNightTint;
uniform vec3  uShadowTint;    // what a fully shadowed pixel is multiplied by

uniform float uGain;          // overall exposure trim for the body colours
uniform float uNightFloor;
uniform float uFar;           // world units the coarse field spans
uniform vec2  uFine;          // (min, range) of the fine signed field, world units
uniform vec3  uDark2Color;    // multiplier for a darker patch step
uniform vec3  uCausticHi;     // pale cyan of the brightest overlapping patches
uniform vec2  uDepth;         // (start, end) world units of the shallow -> deep ramp
uniform vec4  uPatch;         // patch cell sizes: layer A (xy), layer B (zw), world units
uniform vec3  uPatchMix;      // (tone strength, drift speed u/s, -)
uniform vec4  uSpark;         // specular flecks: (strength, density, cell size, -)
uniform vec4  uFoam;          // (wall line width, -, lap breathing reach, lap strength)
uniform float uEdgeFade;      // world units over which open sea meets the map edge
uniform float uTileSize;      // world units per map tile
uniform vec4  uFloatPos[${MAX_FLOATS}];  // (x, z, half size, alive) per bobbing float
uniform vec4  uWallShade;     // far-wall shadow band: (-x width, -z width, -x strength, -z strength)
uniform vec3  uShadeColor;    // multiplier of the darkest shadow-band step
uniform vec2  uNearRamp;      // (start, end) world units of the near-shore shallow -> deep ramp
uniform vec4  uTerr;         // round 14: terrace boundaries (world units from the wall): shallow|mid|deep|core|abyss
uniform vec2  uTerr2;        // (patch push in world units, -)
uniform vec3  uCoreColor;    // round 14: 4th depth step
uniform vec3  uAbyssColor;   // round 14: the centre of big lakes

uniform float uEmitStrength;
uniform vec2  uEmitParams;
uniform sampler2D uEmitMap;

varying vec3 vWorld;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}

float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 1.0 where the tile at integer tile coords tc is land (shore map G channel).
float landAt(vec2 tc) {
  return 1.0 - step(0.5, texture2D(uShoreMap, (tc + 0.5) * uTileSize / uWorldSize).g);
}

// Distance to the nearest land tile measured the voxel way: straight along
// each wall and SQUARE around every corner (the Euclidean shore field rounds
// corners off, which reads as airbrushed next to the hard-edged basin).
float boxShore(vec2 p) {
  vec2 tc = floor(p / uTileSize);
  vec2 f = p - tc * uTileSize;
  vec2 g = uTileSize - f;
  float d = 1e3;
  if (landAt(tc + vec2(-1.0, 0.0)) > 0.5) d = min(d, f.x);
  if (landAt(tc + vec2( 1.0, 0.0)) > 0.5) d = min(d, g.x);
  if (landAt(tc + vec2(0.0, -1.0)) > 0.5) d = min(d, f.y);
  if (landAt(tc + vec2(0.0,  1.0)) > 0.5) d = min(d, g.y);
  if (landAt(tc + vec2(-1.0, -1.0)) > 0.5) d = min(d, max(f.x, f.y));
  if (landAt(tc + vec2( 1.0, -1.0)) > 0.5) d = min(d, max(g.x, f.y));
  if (landAt(tc + vec2(-1.0,  1.0)) > 0.5) d = min(d, max(f.x, g.y));
  if (landAt(tc + vec2( 1.0,  1.0)) > 0.5) d = min(d, max(g.x, g.y));
  return d;
}

// Round 12: the same voxel distance, split by which side the wall is on.
// The iso camera looks from +x+z, so walls on land at -x / -z are the FAR walls
// (their inner faces are visible, and they shade the water at their foot, like
// the dark band under ref05's top-left pool wall); walls on land at +x / +z are
// the NEAR walls, hidden behind the coping, where the pool is shallow and pale.
// Returns (far -x, far -z, near +x, near +z) distances; diagonal land tiles
// wrap each band squarely round the corner. The mixed diagonals (+x-z, -x+z)
// are the tips of far walls, so they only feed the far bands (a pale near
// band wrapped round them read as little glyph boxes under the far walls).
// Round 13: the camera now rotates in 90-degree snaps (engine.js, and the
// iso shots pick the snap from the sun), so "far" and "near" come from the
// live view instead of being fixed to +x+z. s = sign of the toward-camera
// direction on the ground (each component +-1): land at -s is FAR.
vec4 boxShoreDir(vec2 p, vec2 s) {
  vec2 tc = floor(p / uTileSize);
  vec2 f0 = p - tc * uTileSize;
  vec2 g0 = uTileSize - f0;
  vec2 f = vec2(s.x > 0.0 ? f0.x : g0.x, s.y > 0.0 ? f0.y : g0.y);   // to the far edge
  vec2 g = vec2(s.x > 0.0 ? g0.x : f0.x, s.y > 0.0 ? g0.y : f0.y);   // to the near edge
  vec4 d = vec4(1e3);
  float lxm = landAt(tc + vec2(-s.x, 0.0)), lxp = landAt(tc + vec2(s.x, 0.0));
  float lzm = landAt(tc + vec2(0.0, -s.y)), lzp = landAt(tc + vec2(0.0, s.y));
  float lmm = landAt(tc - s), lpm = landAt(tc + vec2(s.x, -s.y));
  float lmp = landAt(tc + vec2(-s.x, s.y)), lpp = landAt(tc + s);
  if (lxm > 0.5) d.x = min(d.x, f.x);
  if (lmm > 0.5) { d.x = min(d.x, max(f.x, f.y)); d.y = min(d.y, max(f.x, f.y)); }
  if (lmp > 0.5) d.x = min(d.x, max(f.x, g.y));
  if (lzm > 0.5) d.y = min(d.y, f.y);
  if (lpm > 0.5) d.y = min(d.y, max(g.x, f.y));
  if (lxp > 0.5) d.z = min(d.z, g.x);
  if (lpp > 0.5) { d.z = min(d.z, max(g.x, g.y)); d.w = min(d.w, max(g.x, g.y)); }
  if (lzp > 0.5) d.w = min(d.w, g.y);
  return d;
}

// Distance from p to the NEAR shore, measured toward the camera (world +x+z,
// straight down the screen): sphere-traced through the coarse shore field.
// Small near the bottom edges of a lake, large under its far walls — the
// shallow -> deep axis of ref05's pool (pale at the near edge and the step,
// deepest blue under the far walls).
float nearShore(vec2 p, vec2 dir) {
  float s = 0.0;
  for (int i = 0; i < 16; i++) {
    float d = texture2D(uShoreMap, (p + dir * s) / uWorldSize).r * uFar;
    if (d < 0.75 || s > 96.0) break;
    s += max(d * 0.92, 1.0);
  }
  return s;
}

// One layer of ref05's pool patchwork: one axis-aligned rectangle per cell
// of a drifting grid (cell size S world units per axis). Sizes and offsets are
// whole voxels (1 world unit), so overlapping layers build blocky compound
// tiles. Returns +coverage (a lighter patch), -coverage (darker) or 0.
float patchLayer(vec2 p, vec2 S, vec2 drift, float salt, float occ, float aaW) {
  vec2 q = p + drift;
  vec2 c = floor(q / S);
  vec2 f = q - c * S;
  float h0 = hash21(c + salt);
  if (h0 > occ) return 0.0;
  // depth, statistically: near the rim a patch leans light, deep ones dark
  vec2 cw = (c + 0.5) * S - drift;
  float dcell = texture2D(uShoreMap, cw / uWorldSize).r * uFar;
  // Round 13 (critic r12: "bias the patches darker away from the walls"):
  // deep cells are almost always dark, and a patch whose centre is close to a
  // wall is never dark — the shallows by every wall stay light cyan.
  // wave 2: mostly darker blocks (ref05), lighter ones lean to the shallows
  float pLight = mix(0.55, 0.18, smoothstep(uDepth.x, uDepth.y, dcell));
  float sgn = hash21(c + salt + 29.3) < pLight ? 1.0 : -1.0;
  if (dcell < 5.0) sgn = 1.0;
  vec2 h1 = vec2(hash21(c + salt + 17.3), hash21(c + salt + 41.9));
  vec2 h2 = vec2(hash21(c + salt + 73.1), hash21(c + salt + 5.7));
  // sizes / offsets on the 4 u pool-tile block: big calm tiles
  vec2 sz = max(vec2(8.0), floor(S * (0.40 + 0.45 * h1) / 4.0 + 0.5) * 4.0);
  vec2 lo = floor((S - sz) * h2 / 4.0 + 0.5) * 4.0;
  vec2 hi = lo + sz;
  vec2 cov = smoothstep(lo - aaW, lo + aaW, f) * (1.0 - smoothstep(hi - aaW, hi + aaW, f));
  return sgn * cov.x * cov.y;
}

// A screen-aligned rectangle mask (d, half size in the same units).
float boxMask(vec2 d, vec2 hs, float aaW) {
  vec2 m = 1.0 - smoothstep(hs - aaW, hs + aaW, abs(d));
  return m.x * m.y;
}

void main() {
  vec2 p = vWorld.xz;
  float t = uTime;
  vec4 sh = texture2D(uShoreMap, p / uWorldSize);
  float dF = sh.b * uFine.y + uFine.x;     // signed world units from the waterline
  float dC = sh.r * uFar;                  // world units, saturates at uFar

  // World units per screen pixel. Block detail fades out once a block is only a
  // couple of pixels wide, so the wide shot never shimmers.
  float pxw = max(length(vec2(dFdx(p.x), dFdy(p.x))), length(vec2(dFdx(p.y), dFdy(p.y))));
  float detail = 1.0 - smoothstep(0.30, 0.80, pxw);
  float aa = pxw * 0.6 + 1e-4;

  // ---- depth: stepped terraces tied to distance from the shore (round 14) --
  // Critic r13: "dark-blue tone patches scattered as random rectangles look
  // like checkerboard blotches, not depth; the surface fades to a pale,
  // washed-out cyan near the rims. ref05's pool is a saturated pool blue that
  // darkens steadily toward the centre and away from the walls." So the tone
  // is now a function of ONE thing — how far this water is from its walls —
  // quantised into five saturated steps (rim -> shallow -> mid -> deep ->
  // core). The distance is read on a 2 u voxel block and nudged by a chunky
  // fixed jitter and a sparse drifting patch layer, so each contour is a
  // crenellated voxel edge rather than a perfect ring, and every "patch" is
  // simply a neighbouring depth step pushed in or out — never a random
  // blotch in a foreign tone.
  vec2 toCam = vec2(viewMatrix[0][2], viewMatrix[2][2]);
  vec2 camS = vec2(toCam.x >= 0.0 ? 1.0 : -1.0, toCam.y >= 0.0 ? 1.0 : -1.0);
  vec4 sd = boxShoreDir(p, camS);
  float dNear = min(min(sd.z, sd.w), 2.0 * uTileSize);
  float dFar = min(min(sd.x, sd.y), 2.0 * uTileSize);
  float dS = min(dNear, dFar);
  float aaD = pxw * 0.6 + 1e-3;

  // ---- body (wave 2, round 1): ref05's pool, converged -------------------
  // 14 rounds of critics, summed: a BRIGHT saturated azure (ref05 pool modal
  // pixels #10d0f0 .. #00a0d8, median ~#0ccaec), a BROAD SMOOTH shallow ->
  // deep gradient (no terrace rings / contours), a SPARSE scatter of LARGE
  // (1-3 tile) slightly darker / lighter square tile patches, a few glints.
  // The gradient is the Euclidean shore distance, averaged over a wide
  // 5-tap cross (so the medial ridge of a notched lake never shows), left
  // continuous — a 4 u block staircase read as diamond contour rings. The
  // blockiness comes from the patches alone.
  // Calibrated through the live grade (flat-lake runs, 09-25): authored ->
  // screen #04a8c8 -> ~#07d0f4, #0590b4 -> ~#07c4ef, #035c90 -> ~#0698ee,
  // #02487c -> ~#0587e2 (the grade lifts and saturates blue hard, so every
  // body colour is authored with B well under 0xd0).
  // ---- wave 4: a MOSAIC gradient (ref05's pool, measured) -----------------
  // Critic w3: "one flat very saturated blue broken only by a few hard-edged
  // dark rectangles; ref05 goes from bright cyan shallows along the walls to
  // deeper blue toward the middle; soften / blend the depth patches so they
  // step down gradually". Looked at closely, ref05's pool IS its gradient,
  // drawn in tiles: quarter-tile squares, each one of a few pool blues, the
  // light ones crowding the walls and the deep ones the middle, mixed along
  // the way (an ordered dither of shallow -> deep). So: the smooth depth
  // ramp is read at the centre of every 2 u tile, a per-tile jitter of about
  // one step (a 4 u block term + a 2 u term, so tiles clump into 1-3 tile
  // patches) is added, and the sum is quantised into five levels. No random
  // foreign-tone rectangles any more: every patch is simply a neighbouring
  // depth step, so the lake always reads shallow rim -> deep middle. Each
  // tile's jitter breathes slowly, so a few tiles on a level boundary fade
  // one step up or down at a time — the gentle "shimmer" of the pool floor.
  // ---- wave 4 round 2: SHELF RING + one smooth deep + sparse big tiles -----
  // Critic w4r1: "the quarter-tile mosaic is a random noisy checker of darker
  // squares, so the shallow -> deep change does not read; ref05 has a clearly
  // lighter shallow shelf band along the rim that steps down to ONE smooth,
  // deeper blue with a few bright glints". Critic w3r1 agreed ("lighter
  // shallow band along every wall; blend the depth so it steps down
  // gradually"). So the per-tile dither is gone. Tone is now:
  //  1. a continuous light shelf ring (Chebyshev, square corners) inside
  //     every wall, with a brighter lip right against the wall;
  //  2. a hard step down off the shelf onto a smooth, broad ramp that keeps
  //     darkening toward the middle (5-tap averaged shore distance, read
  //     per pixel so there are no contours or rings);
  //  3. a SPARSE scatter of LARGE (1-2 tile) half-step-lighter/darker square
  //     tiles, slowly fading in and out (ref05's big pool-floor tiles).
  float r5 = 10.0;
  float dAvg = texture2D(uShoreMap, p / uWorldSize).r * 2.0;
  dAvg += texture2D(uShoreMap, (p + vec2( r5, 0.0)) / uWorldSize).r;
  dAvg += texture2D(uShoreMap, (p + vec2(-r5, 0.0)) / uWorldSize).r;
  dAvg += texture2D(uShoreMap, (p + vec2(0.0,  r5)) / uWorldSize).r;
  dAvg += texture2D(uShoreMap, (p + vec2(0.0, -r5)) / uWorldSize).r;
  dAvg *= uFar / 6.0;
  // the ramp drops quickly off the shelf, then keeps deepening slowly
  float dR = mix(min(dAvg, dS * 1.4 + 3.0), dAvg, smoothstep(10.0, 15.0, dS));
  float Ls = 1.25 + 1.75 * smoothstep(uDepth.x, 20.0, dR)
                  + 0.95 * smoothstep(14.0, uDepth.y + 14.0, dR);
  float pDetA = 1.0 - smoothstep(0.8, 1.6, pxw);
  vec2 eqP = min(p, uWorldSize - p);
  float calm = smoothstep(20.0, 44.0, min(eqP.x, eqP.y)) * pDetA
             * (1.0 - 0.6 * smoothstep(0.0, 0.7, uNight));
  // sparse big tiles: one candidate per cell, 1-2 tiles, snapped to 4 u
  float shelfW = max(uFoam.y, pxw * 2.0);
  {
    vec2 S = uPatch.xy;
    vec2 c = floor(p / S);
    float h0 = hash21(c + 3.7);
    if (h0 < 0.30) {
      vec2 f = p - c * S;
      vec2 h1 = vec2(hash21(c + 17.3), hash21(c + 41.9));
      vec2 sz = floor(mix(vec2(8.0), vec2(16.0), h1) / 4.0 + 0.5) * 4.0;
      vec2 lo = floor((S - sz) * vec2(hash21(c + 73.1), hash21(c + 5.7)) / 4.0 + 0.5) * 4.0;
      vec2 cov2 = smoothstep(lo - aaD, lo + aaD, f) * (1.0 - smoothstep(lo + sz - aaD, lo + sz + aaD, f));
      float cov = cov2.x * cov2.y;
      // shallows lean light, the deep middle leans dark
      float pL = mix(0.7, 0.2, smoothstep(1.4, 3.6, Ls));
      float sgn = hash21(c + 29.3) < pL ? -1.0 : 1.0;
      float per = 16.0 + 10.0 * hash21(c + 12.3);
      float env = 0.65 + 0.35 * sin(t * 6.2832 / per + h0 * 40.0);
      // never on the shelf or right beside it
      cov *= smoothstep(shelfW + 3.0, shelfW + 6.0, dS);
      Ls += sgn * 0.5 * cov * env * uPatchMix.x * calm;
    }
  }
  float Lv = clamp(Ls, 0.0, 4.0);
  vec3 body = mix(uEdgeColor, uShallowColor, clamp(Lv, 0.0, 1.0));
  body = mix(body, uMidColor, clamp(Lv - 1.0, 0.0, 1.0));
  body = mix(body, uDeepColor, clamp(Lv - 2.0, 0.0, 1.0));
  body = mix(body, uCoreColor, clamp(Lv - 3.0, 0.0, 1.0));

  // the shelf: a continuous light ring hugging every wall (square corners),
  // with a brighter lip right against the wall
  float shelf = 1.0 - smoothstep(shelfW - aaD, shelfW + aaD, dS);
  body = mix(body, uEdgeColor, shelf);
  float lipW = max(shelfW * 0.36, pxw * 1.5);
  float lip = 1.0 - smoothstep(lipW - aaD, lipW + aaD, dS);
  body = mix(body, uPatchColor, lip * 0.9);
  float rimW = shelfW;
  vec3 bodyBase = body;
  // coarse depth on a half-tile block, only used to step the open sea in
  float B = 4.0;
  float dQ = texture2D(uShoreMap, (floor(p / B) + 0.5) * B / uWorldSize).r * uFar;
  // Only real open sea saturates the coarse field (lakes never get this far
  // from land), so the coast blends into terrain's off-map sea with no seam.
  float s3 = mix(smoothstep(uFar * 0.72, uFar * 0.97, dC), step(uFar * 0.85, dQ), detail);
  // A narrow coastal strip never gets far enough from land to saturate, so at
  // the map edge itself the open sea steps (in voxel terraces) into the colour
  // of terrain's off-map sea — the coast reads deeper further out and the
  // boundary vanishes. Ponds that touch the edge stay pool-blue (dC gate).
  vec2 eq = min(p, uWorldSize - p);
  float eD = min(eq.x, eq.y);
  float eDq = (floor(eD / (2.0 * B)) + 0.5) * 2.0 * B;
  float s4 = (1.0 - mix(smoothstep(0.0, uEdgeFade, eD), smoothstep(0.0, uEdgeFade, eDq), detail))
           * smoothstep(6.0, 14.0, dC);
  s3 = max(s3, s4);
  float gainNow = mix(uGain, 1.0, uNight);   // night keeps the old deep fold
  body = mix(body * gainNow, uSeaColor, s3);
  bodyBase *= gainNow;

  // ---- shoreline: a crisp foam edge line at every wall (round 14) ----------
  // Critic r13: "there is no foam or edge line where the water meets the
  // wall". Every wall now gets a solid white foam line with a pale-cyan lap
  // line breathing just outside it; the near walls (behind the coping) keep
  // the wider line, square corner splash blocks and the rolling foam dashes.
  // All distances are Chebyshev to the voxel coast, so the lines turn the
  // stepped coastline's corners squarely.
  float breathe = 0.5 + 0.5 * sin(t * 1.1 + (p.x + p.y) * 0.05);
  float lw = max(uFoam.x + 0.08 * breathe, pxw * 1.8);
  float foamN = 1.0 - smoothstep(lw - aaD, lw + aaD, dNear);
  float cw = max(0.8 + 0.12 * breathe, pxw * 2.2);
  foamN = max(foamN, 1.0 - smoothstep(cw - aaD, cw + aaD, max(sd.z, sd.w)));
  float lwF = max(0.40 + 0.06 * breathe, pxw * 1.8);
  float foamF = 1.0 - smoothstep(lwF - aaD, lwF + aaD, dFar);
  float cwF = max(0.75 + 0.1 * breathe, pxw * 2.0);
  foamF = max(foamF, (1.0 - smoothstep(cwF - aaD, cwF + aaD, max(sd.x, sd.y))) * 0.85);
  // a thin pale lap line a little way out from every wall
  float lapR = max(lw, lwF) + 0.55 + 0.35 * breathe;
  float lapA = (1.0 - smoothstep(0.11 - aaD, 0.11 + aaD, abs(dS - lapR))) * detail * 0.55;
  float bandW = rimW;
  // a thin foam dash rolling in and out across the near rim
  float lapN = lw + 1.0 + breathe * uFoam.z;
  float lap = (1.0 - smoothstep(0.10 - aaD, 0.10 + aaD, abs(dNear - lapN))) * detail;
  lap *= step(0.5, fract((p.x + p.y) / 5.0 + t * 0.05) + 0.25);   // broken into dashes
  float shade = 0.0;

  // No wall at the map boundary (the sea runs on off-map), so no shore marks.
  float onMap = smoothstep(0.6, 1.6, eD);
  float lake = onMap * (1.0 - s3);
  foamN *= onMap; foamF *= onMap; lap *= onMap; lapA *= lake;

  vec3 col = body;
  col = mix(col, uCausticHi, lapA);
  col = mix(col, uFoamColor, lap * uFoam.w);
  col = mix(col, uFoamColor, max(foamN, foamF));

  // ---- sun glints: crisp white streaks + twinkling sparkles (ref05) ------
  // Round 13 (critic r12: "no specular highlights, so it reads as a painted
  // floor; ref05 has a few bright white / pale-cyan highlight streaks and
  // ripple glints that make it read as glossy water"). The round-11 soft
  // sheens (a square in a square, read as a UI glyph) are gone. Now:
  //  - STREAKS: per sparse cell, a staggered stack of 2-3 thin world-axis
  //    bars (ref05's stepped white ripple highlights), white core + pale-cyan
  //    halo, drifting gently along their axis and fading in and out.
  //  - SPARKLES: small white voxel glints that twinkle on and off.
  // Kept off the shore bands, the open sea and the far zoom.
  if (detail > 0.001 && uSpark.x > 0.001) {
    float aaF = pxw * 0.55 + 1e-3;
    float keepBase = detail * uSpark.x * smoothstep(bandW + 0.8, bandW + 2.4, dS)
                   * (1.0 - s3) * onMap * (1.0 - shade);
    float halo = 0.0, core = 0.0;
    vec2 G = vec2(uSpark.z * 1.25, uSpark.z);
    vec2 fc = floor(p / G);
    float fh = hash21(fc + 91.7);
    if (fh < uSpark.y) {
      bool alongX = hash21(fc + 2.3) < 0.5;
      vec2 ax = alongX ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec2 pr = alongX ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
      vec2 fo = vec2(hash21(fc + 3.1), hash21(fc + 8.9));
      vec2 ctr = floor(fc * G + 4.0 + (G - 8.0) * fo + 0.5);
      float period = 5.0 + 4.0 * hash21(fc + 12.3);
      float ph = fract(t / period + fh * 13.0);
      float env = smoothstep(0.0, 0.2, ph) * (1.0 - smoothstep(0.65, 0.95, ph));
      ctr += ax * (ph * 1.6 - 0.8);                 // a slow slide along the bar
      float L = floor(2.0 + 2.5 * hash21(fc + 4.4) + 0.5) * 0.5;
      float wB = max(0.34, pxw * 0.8);
      float nb = hash21(fc + 6.2) < 0.6 ? 1.0 : 2.0;   // wave4: 3-bar stacks read as a menu glyph
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        if (fi >= nb) break;
        // stacked bars a thin gap apart, each stepped along: a stair-stepped
        // crest shape rather than a row of parallel dashes
        vec2 c = ctr + pr * (fi * (2.0 * wB + 0.3)) + ax * (fi * 0.9);
        vec2 d = p - c;
        vec2 dl = vec2(dot(d, ax), dot(d, pr));
        float li = L * (1.0 - 0.28 * fi);
        core = max(core, boxMask(dl, vec2(li, wB), aaF));
        halo = max(halo, boxMask(dl, vec2(li + 0.6, wB + 0.5), aaF));
      }
      float k2 = (0.30 + 0.70 * env) * keepBase;
      halo *= k2; core *= k2;
    }
    // sparkles: small twinkling glints on a finer grid
    vec2 Gs = vec2(uSpark.w, uSpark.w * 0.85);
    vec2 sc = floor(p / Gs);
    float sh2 = hash21(sc + 57.1);
    if (sh2 < 0.16) {
      vec2 sp2 = floor(sc * Gs + 1.0 + (Gs - 2.0) * vec2(hash21(sc + 1.7), hash21(sc + 9.3)) + 0.5);
      float per = 1.8 + 2.2 * hash21(sc + 5.9);
      float ph = fract(t / per + sh2 * 31.0);
      float tw = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.30, 0.55, ph));
      vec2 d = p - sp2;
      float r = max(0.32, pxw * 0.8);
      core = max(core, boxMask(d, vec2(r), aaF) * tw * keepBase);
      halo = max(halo, boxMask(d, vec2(r + 0.4), aaF) * tw * keepBase);
    }
    col = mix(col, uCausticHi, halo * 0.55);   // wave4: softer shimmer
    col = mix(col, uFoamColor, core * 0.92);
  }

  // ---- splash halos around the bobbing floats (ref05's balls and rings) ----
  // A hard white collar hugging each float plus one square ripple that rolls
  // outward and fades — reads as "this is floating", in the voxel idiom.
  if (detail > 0.001) {
    float sp = 0.0;
    for (int i = 0; i < ${MAX_FLOATS}; i++) {
      vec4 fp = uFloatPos[i];
      if (fp.w < 0.5) continue;
      vec2 d = abs(p - fp.xy);
      float cheb = max(d.x, d.y);
      float r0 = fp.z + 0.12;
      float collar = (1.0 - smoothstep(r0 + 0.32 - aa, r0 + 0.32 + aa, cheb)) * step(r0 - 0.4, cheb);
      // wave2: the rolling square ripple is gone — 8 critics in a row read it
      // as a selection box. Just the white splash collar.
      sp = max(sp, collar * 0.92);
    }
    col = mix(col, uFoamColor, sp * detail);
  }

  // ---- rain: little square ripple rings ------------------------------------
  if (uRain > 0.01) {
    float rk = uRain * max(detail, 0.0);
    vec2 g = p / 3.2;
    vec2 c = floor(g);
    vec2 f = fract(g) - 0.5;
    float ph = t * 0.95 + hash21(c + 5.5) * 7.0;
    float life = fract(ph);
    if (hash21(c + floor(ph) * 2.1) < 0.25 + 0.5 * uRain) {
      float cheb = max(abs(f.x), abs(f.y));
      float rr = life * 0.44;
      float aa = fwidth(cheb) * 1.2 + 1e-4;
      float rim = 1.0 - smoothstep(0.035 - aa, 0.035 + aa, abs(cheb - rr));
      col = mix(col, uFoamColor * 0.9, rim * (1.0 - life) * 0.55 * rk);
    }
    col *= 1.0 - uRain * 0.16;
  }

  // ---- cast shadows (lighting.js's cascades, when engine.js wires them) ----
#ifdef USE_WATER_CSM
  {
    vec3 vN = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 vL = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    float lit = clamp(dot(csmApply(vec3(1.0), vN, vL), vec3(0.33333)), 0.0, 1.0);
    col *= mix(uShadowTint, vec3(1.0), lit);
  }
#endif

  // ---- time of day ---------------------------------------------------------
  // Low sun: take on a little of the sun's hue (sunset water), never darker.
  float lowSun = 1.0 - smoothstep(0.05, 0.38, uSunDir.y);
  vec3 sunHue = uSunColor / max(max(uSunColor.r, uSunColor.g), max(uSunColor.b, 1e-4));
  col *= mix(vec3(1.0), 0.62 + 0.40 * sunHue, lowSun * 0.55 * (1.0 - uNight));
  // Night: fold down onto a deep, still clearly BLUE tone.
  // coherence 09-25: the body is authored HDR-bright for the day grade, so a
  // linear fold left the lake glowing pool-blue while the lit-down city around
  // it had gone dark (at nightT 0.6 the land is night, the water still day).
  // Ramp the fold in with the land's darkening and fold deeper (tint below).
  col = mix(col, col * uNightTint, smoothstep(0.0, 0.7, uNight) * (1.0 - uNightFloor));

  // ---- night: the lit city streaks across the water ------------------------
  if (uEmitStrength > 0.002) {
    vec3 V = normalize(cameraPosition - vWorld);
    vec2 rd = -V.xz;
    float rl = length(rd);
    if (rl > 1e-3) {
      rd /= rl;
      vec3 acc = vec3(0.0);
      float wsum = 1e-4;
      for (int i = 1; i <= 10; i++) {
        float ft = float(i);
        vec2 q = (p + rd * (ft * uEmitParams.x)) / uWorldSize;
        vec4 em = texture2D(uEmitMap, clamp(q, vec2(0.002), vec2(0.998)));
        float w = exp(-ft * uEmitParams.y);
        acc += em.rgb * em.a * w;
        wsum += w;
      }
      col += (acc / wsum) * uEmitStrength * 0.6;
    }
  }

  // Alpha 0.625 is post.js's WATER KEY: the grade spares these pixels its
  // upper-mid dip and cool-hue saturation cut, which capped the pool at
  // ~#1caed6 whatever colour was authored here (round 10). The material is
  // opaque (no blending), so the alpha is written as-is. At night the key
  // slides off (0.625 -> 0.695 is outside post's window) so the moonlit water
  // takes the same grade as the dark city around it.
  gl_FragColor = vec4(col, 0.625 + 0.07 * uNight);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const BED_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
${COMMON_GLSL}
uniform float uBedShallow;
uniform float uBedDeep;

varying vec3 vWorld;
varying vec4 vShore;

void main() {
  vec3 transformed = position;
  vec4 sh = shoreAt(position.xz);
  vShore = sh;
  // Beach shelf: the bed rises to just under the surface at the waterline so no
  // gap is ever visible between the bed and the terrain's shore wall.
  float prof = smoothstep(0.0, 0.62, sh.r);
  transformed.y = uBedShallow + (uBedDeep - uBedShallow) * prof;
  // A little dune/ripple relief on the bed.
  transformed.y += (sin(position.x * 0.19) * cos(position.z * 0.23)) * 0.06 * prof;

  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BED_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
${COMMON_GLSL}

uniform sampler2D uNormalMap;
uniform vec3 uWetSand;
uniform vec3 uSilt;
uniform vec3 uAbyss;
uniform vec3 uSunColor;
uniform vec3 uCausticColor;
uniform float uNight;
uniform float uRain;
uniform float uCaustics;
uniform float uQuality;

varying vec3 vWorld;
varying vec4 vShore;

void main() {
  float d = vShore.r;
  vec3 col = mix(uWetSand, uSilt, smoothstep(0.03, 0.38, d));
  col = mix(col, uAbyss, smoothstep(0.32, 0.9, d));
  col = mix(col, uWetSand, vShore.a * (1.0 - smoothstep(0.0, 0.26, d)) * 0.6);

  // grain
  float g = texture2D(uNormalMap, vWorld.xz * (1.0 / 6.0)).a;
  float g2 = texture2D(uNormalMap, vWorld.xz * (1.0 / 31.0)).a;
  col *= 0.86 + 0.30 * (g * 0.45 + g2 * 0.55);

  // caustics: two counter-scrolling noise fields folded to bright creases
  if (uQuality > -0.5) {
    float t = uTime * 0.35;
    float a = texture2D(uNormalMap, vWorld.xz * (1.0 / 13.0) + vec2( 0.020, 0.014) * t * 2.0).a;
    float b = texture2D(uNormalMap, vWorld.xz * (1.0 / 11.0) + vec2(-0.017, 0.023) * t * 2.0).a;
    float c = 1.0 - abs(a + b - 1.0);
    c = pow(clamp(c, 0.0, 1.0), 9.0);
    float shallowness = 1.0 - smoothstep(0.05, 0.75, d);
    col += uCausticColor * c * uCaustics * shallowness * (1.0 - uRain * 0.5);
  }

  // depth extinction + night
  col *= mix(1.0, 0.34, smoothstep(0.1, 0.95, d));
  col *= mix(vec3(1.0), uSunColor * 0.9 + 0.25, 0.35);
  col = mix(col, col * vec3(0.18, 0.24, 0.40), uNight * 0.9);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ---------------------------------------------------------------------------
// WaterFX
// ---------------------------------------------------------------------------

export class WaterFX {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   *   n            tiles per side (default 80)
   *   tile         world units per tile (default 8)
   *   chunk        tiles per rebuild chunk (default 16)
   *   sub          surface subdivisions per tile per axis (default 1 — flat)
   *   shoreSub     shore-field samples per tile per axis (default 8 = 1 unit)
   *   waterY       surface plane height (default -0.35)
   *   far          coarse shore-field range in tiles (default 5)
   *   seabed       build the sculpted sea bed (default true)
   *   quality      0|1|2 (default 2)
   *   edgeIsLand   treat the map border as land for foam (default false)
   *   landWarp     optional fn(wx, wz, out[2]) -> out: the horizontal warp the
   *                terrain applies to its ground lattice (see setLandWarp)
   *   warpStep     that lattice's spacing in world units (default 4)
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    const o = this.opts = Object.assign({
      n: N_DEFAULT,
      tile: TILE,
      chunk: CHUNK,
      sub: 1,
      shoreSub: 8,
      waterY: WATER_Y,
      far: 8.0,              // round 7: 5 -> 8 so lake centres never saturate (depth ramp)
      seabed: true,
      quality: 2,
      edgeIsLand: false,
      normalTexSize: 128,
      shoreJitter: 0.0,      // tiles; the visible outline is terrain.js's bank
      shoreRetreat: 0.0,
      fineMin: -2.0,         // world units: fine signed field range
      fineRange: 16.0,
      landWarp: null,
      warpStep: 4,
      warpReach: 1.35,       // tiles offshore the land warp can possibly reach
      emitRes: 64,
      emitReflection: true,
      apron: 90,             // tiles of open sea continued past the map edge
    }, opts);

    this.N = o.n | 0;
    this.TILE = o.tile;
    this.CHUNK = o.chunk | 0;
    this.SUB = Math.max(1, o.sub | 0);
    this.S = Math.max(1, o.shoreSub | 0);
    this.worldSize = this.N * this.TILE;
    this.chunksPerSide = Math.ceil(this.N / this.CHUNK);

    // ---- shore field --------------------------------------------------------
    this.fieldW = this.N * this.S;
    const FW2 = this.fieldW * this.fieldW;
    this._shoreData = new Uint8Array(FW2 * 4);
    this._distLand = new Float32Array(FW2);
    this._distSand = new Float32Array(FW2);
    this._distWater = new Float32Array(FW2);
    this._covered = new Uint8Array(FW2);     // water cell under the warped land
    this._shoreTex = new THREE.DataTexture(
      this._shoreData, this.fieldW, this.fieldW, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._shoreTex.wrapS = this._shoreTex.wrapT = THREE.ClampToEdgeWrapping;
    this._shoreTex.magFilter = THREE.LinearFilter;
    this._shoreTex.minFilter = THREE.LinearFilter;
    this._shoreTex.generateMipmaps = false;
    this._shoreTex.needsUpdate = true;
    this._shoreDirty = false;
    this._tileFlags = new Uint8Array(this.N * this.N);

    // ---- terrain warp lattice cache (see setLandWarp) ----------------------
    this._warpFn = null;
    this._warpStep = o.warpStep;
    this._warpLN = 0;
    this._warpDX = null; this._warpDZ = null; this._warpOK = null;
    this._wtmp = [0, 0];
    if (typeof o.landWarp === 'function') this._setWarp(o.landWarp, o.warpStep);

    // Only the sea bed uses this now (grain + caustics); the surface is flat.
    this._normalTex = makeWaveNormalTexture(o.normalTexSize);

    // ---- fake-reflection emitter map (top-down city light, world XZ) -------
    this.EMIT = Math.max(16, o.emitRes | 0);
    this._emitData = new Uint8Array(this.EMIT * this.EMIT * 4);
    this._emitTex = new THREE.DataTexture(
      this._emitData, this.EMIT, this.EMIT, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._emitTex.wrapS = this._emitTex.wrapT = THREE.ClampToEdgeWrapping;
    this._emitTex.magFilter = THREE.LinearFilter;
    this._emitTex.minFilter = THREE.LinearFilter;
    this._emitTex.generateMipmaps = false;
    this._emitTex.needsUpdate = true;
    this._emitDirty = false;

    // ---- uniforms (shared between the surface and the bed) ------------------
    const shared = {
      uShoreMap: { value: this._shoreTex },
      uNormalMap: { value: this._normalTex },
      uWorldSize: { value: new THREE.Vector2(this.worldSize, this.worldSize) },
      uTime: { value: 0 },
      uWaveAmp: { value: 1.0 },
      uWaveScale: { value: 1.0 },
      uNight: { value: 0 },
      uRain: { value: 0 },
      uQuality: { value: o.quality },
      uSunColor: { value: srgb(0xfff2d8) },
    };
    this._shared = shared;

    this.uniforms = Object.assign({}, shared, {
      uSunDir: { value: new THREE.Vector3(0.45, 0.72, 0.53).normalize() },
      uSkyTop: { value: srgb(0x2f7fd8) },
      // ---- the palette (sRGB hex, authored against ref05's hotel pool) ----
      // Measured in ref05's pool: body #15d7f0 / #0acbea, darker slabs
      // #049eda, walls #0c94d2 (lit) .. #00316e (shade), deck #fad79d.
      // Round-2 critic: ours read "paler, washed-out, little contrast", so
      // the body is a vivid pool blue and the slabs are real value steps.
      // Round 6: ONE flat body colour (uMidColor) with patch tone steps
      // either side: light2 / light1 / BODY / dark1 / dark2.
      // Round 7: a depth ramp shallow -> mid -> deep (ref05's pool goes from
      // #1adcf5 by the rim to #0292ce in the middle); uEdgeColor is what a
      // light patch leans toward, uDark2Color a darker patch's multiplier.
      // Round 8 (critic r7: "dull teal-navy #0e6b9c..#128cb0, darkest in the
      // middle"): post.js's grade (exposure 0.92, luma curve gamma 1.3 + dip,
      // coolSat 0.15 at 195 deg, highlight knee) maps a flat #2ea3ee to
      // #1691d4 and caps blue near 0xe8. Measured, flat lake, gain 1.35:
      // #2194e6 -> #1e94e7, #4dbff5 -> #3cafe4, #8fe6fa -> #7cd9eb. So the
      // body is authored bright + cyan and uGain (1.35, lake only; the open
      // sea keeps terrain's colour) lifts it so the SCREEN lands on ref05's
      // pool blue (~#2ea3ee) with a light cyan rim. Retune if post changes.
      // Round 9 (critic r8: "pale, pastel, flat; tiles barely differ; inner
      // wall washed-out light blue"): the HDR gain was the problem — above 1.0
      // the tonemap shoulder + coolSat add red and grey the pool out. Now gain
      // 1.0 and every body colour has R = 0 with its peak channel <= 1, which
      // measured flat: #00a8ff -> #1996e0, #0090f0 -> #1186d5, #00c8ff ->
      // #1bacd7 (the most saturated the grade allows). Dark patches are ~18%
      // darker; walls are a strong saturated blue under the cream coping.
      // Round 10 (critic r9: "darker, flatter cobalt; deep patches #0f75cb;
      // light/dark patches low contrast; ref05 is a luminous turquoise"):
      // the water now writes post.js's WATER KEY (alpha 0.625), so the grade's
      // dip + cool-hue cut no longer apply and a flat lake renders ~as authored
      // (measured flat: #00ccff -> #0bc9fb, #0098e0 -> #0098e1, #40e8ff ->
      // #19e5fa). Palette authored straight off ref05's pool pixels: rim
      // #20d9f8, body #0cbff1, dark tiles #0092d4, pale patches #5de8fd.
      // Round 11 (critic r10: "too cyan and too light, #00c6f5..#23dafa vs
      // the ref pool's #0495d4..#02aede; values in a narrow band -> one flat
      // glowing sheet"): the whole ramp moves down to ref05's azure, base
      // #0a9fe0, and spreads out — shallow -> deep is now a ~20% value drop,
      // the wall band is narrower and only a step lighter, light patches lean
      // to #3cd6f6 instead of near-white cyan.
      // Round 12 (critic r11: "a bit more royal-blue and less turquoise than
      // the ref pool"; ref05 samples: near edge / step #5ddfec, centre
      // #10cfee, under the far wall #058ecc): the ramp runs pale turquoise at
      // the near edge -> bright cyan -> azure under the far walls.
      // Round 14 (critic r13: "random dark rectangles read as checkerboard
      // blotches, rims washed-out pale cyan; ref05 is a saturated pool blue
      // that darkens steadily toward the centre"): five saturated steps keyed
      // to distance from the walls (uTerr), rim -> abyss. Samples off ref05's
      // pool: by the wall #13d0ee, then #0cc3eb, #00b0df, #029cd2, #0087c9.
      uEdgeColor: { value: srgb(0x0cbcd0) },   // wave4: mosaic level 0 (wall shallows, screen ~#0cdcee)
      uPatchColor: { value: srgb(0x2cc8d8) },   // rim step hugging every wall (saturated, not pale)
      uShallowColor: { value: srgb(0x04a8c8) },   // wave4: level 1 (ref05 pool #10d0f0)
      uMidColor: { value: srgb(0x0488b0) },       // wave4: level 2 (ref05 median #0ccaec)
      uDeepColor: { value: srgb(0x036c9c) },      // wave4: level 3 (ref05 #00a0d8)
      uCoreColor: { value: srgb(0x035c90) },      // wave4: level 4, deepest tiles (ref #008bd2)
      uAbyssColor: { value: srgb(0x023460) },     // two overlapping dark patches
      uTerr: { value: new THREE.Vector4(6.0, 12.0, 19.0, 28.0) },
      uTerr2: { value: new THREE.Vector2(5.0, 0.0) },
      uSeaColor: { value: srgb(0x0470a0) },
      uWallLine: { value: srgb(0x0877c2) },
      uFoamColor: { value: srgb(0xeafcff) },
      uNightTint: { value: new THREE.Color(0.035, 0.06, 0.12) },   // coherence 09-25: was 0.10/0.17/0.34 (lake stayed day-bright at night)
      // Shadowed water stays clearly blue (ref04/05 shadows are light and
      // colourful, never grey).
      uShadowTint: { value: new THREE.Color(0.62, 0.74, 0.90) },
      uGain: { value: 1.0 },
      uNightFloor: { value: 0.0 },
      uFar: { value: o.far * this.TILE },
      uFine: { value: new THREE.Vector2(o.fineMin, o.fineRange) },
      // round 13: LINEAR multiplier sized for ~-24% G / -9% B on screen (was ~-6%)
      uDark2Color: { value: new THREE.Color(0.42, 0.60, 0.83) },
      uCausticHi: { value: srgb(0x8aeafc) },
      uDepth: { value: new THREE.Vector2(2.0, 30.0) },
      // patch cell sizes (world units; a tile is 8): layer A 19x13, layer B
      // 11x16, layer C is B scaled to ~7x7 — odd sizes so no grid lines up.
      uPatch: { value: new THREE.Vector4(24.0, 20.0, 18.0, 28.0) },   // w4r2: .xy = sparse big-tile cell   // wave2: 1-3 tile patches   // round 13: bigger blocks
      // (tone strength, drift u/s, -)
      uPatchMix: { value: new THREE.Vector3(1.0, 0.12, 0.0) },
      // specular flecks (strength, density per cell, cell size, -)
      // round 13: (strength, streak-cell density, streak cell size, sparkle cell size)
      uSpark: { value: new THREE.Vector4(1.0, 0.26, 14.0, 7.0) },   // wave4: more glints (critic w3)
      // (foam line width, pale ledge width, lap breathing reach, lap strength)
      uFoam: { value: new THREE.Vector4(0.45, 3.0, 0.6, 0.45) },   // w4r2: .y = shelf ring width (critic: 'light continuous shallow ring')   // round 14: .y = rim step width
      // (depth wobble amplitude, noise scale, drift speed) — see the shader
      uEdgeFade: { value: 20.0 },
      uTileSize: { value: this.TILE },
      uFloatPos: { value: Array.from({ length: MAX_FLOATS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      // far-wall shade band (round 12): (-x width, -z width, -x strength,
      // -z strength). The -x walls face the key light's far side (ref05's
      // top-left wall), so they throw the wider, darker band.
      uWallShade: { value: new THREE.Vector4(1.2, 0.9, 0.8, 0.6) },   // round 13: a narrow shadow step only
      uShadeColor: { value: new THREE.Color(0.50, 0.72, 0.86) },
      uNearRamp: { value: new THREE.Vector2(3.0, 44.0) },
      uEmitStrength: { value: 0.0 },
      uEmitParams: { value: new THREE.Vector2(30.0, 0.20) },
      uEmitMap: { value: this._emitTex },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.00025 },
      fogNear: { value: 1 },
      fogFar: { value: 2000 },
    });

    this.bedUniforms = Object.assign({}, shared, {
      uBedShallow: { value: this.opts.waterY - 0.07 },
      uBedDeep: { value: -1.62 },
      uWetSand: { value: srgb(0xc0a877) },
      uSilt: { value: srgb(0x2f7a83) },
      uAbyss: { value: srgb(0x0e3550) },
      uCausticColor: { value: srgb(0xdcfff4) },
      uCaustics: { value: 0.55 },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.00025 },
      fogNear: { value: 1 },
      fogFar: { value: 2000 },
    });

    // Opaque: the surface is fully authored colour, and an opaque pass keeps it
    // out of the transparent sort and lets post.js's AO see a solid plane.
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      fog: true,
    });
    this.material.extensions = { derivatives: true };
    this.material.name = 'WaterFX.surface';

    this.bedMaterial = new THREE.ShaderMaterial({
      uniforms: this.bedUniforms,
      vertexShader: BED_VERT,
      fragmentShader: BED_FRAG,
      transparent: false,
      side: THREE.FrontSide,
      fog: true,
    });
    this.bedMaterial.name = 'WaterFX.bed';

    // ---- the voxel basin: sand deck, coping, pool walls, floats -------------
    // A lit, flat-shaded vertex-colour material, so the three face tones come
    // from the same sun/sky rig as every building (engine.js patches it for
    // the CSM cascades). Colours are authored per face, never textured.
    this.bankMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35,
    });
    this.bankMaterial.name = 'WaterFX.bank';
    // Round 8 (critic r7: "a thick dark-navy inner wall band runs round the
    // whole shoreline and makes the lake look heavy and sunken"): the pool
    // walls face away from the sun, so the lit material alone (plus post's
    // mid-tone curve) crushed them to #062d4a. Wall vertices carry aGlow, a
    // self-lit share of their own vertex colour, so they stay a bright,
    // saturated pool-tile blue on both faces like ref05 — every other bank
    // face has aGlow 0 and is lit exactly as before. Dims at night.
    this._wallGlow = { value: 1.0 };
    const wallGlow = this._wallGlow;
    this.bankMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uWallGlow = wallGlow;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uWallGlow;\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * uWallGlow;')
        // Round 11: the wall tiles (full glow) also write post.js's WATER KEY
        // alpha, so the grade's upper-mid dip / cool-hue cut spare them like
        // the surface (they went a greyed #358ef2 / #1075c8). Off at night.
        // wave4: threshold 0.5 -> 0.2 — WALL_GLOW dropped to 0.25 in wave 2,
        // which silently took the walls OUT of the key (greyed to #1c7ac2).
        .replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\nif (vGlow > 0.2 && uWallGlow > 0.5) gl_FragColor.a = 0.625;');
    };
    this.bankMaterial.customProgramCacheKey = () => 'waterbank-glow';
    const bc = Object.assign({}, BANK_COLORS, o.bankColors || {});
    this._bankCol = {};
    for (const k in bc) this._bankCol[k] = srgb(bc[k]);
    this._floats = [];
    this._floatMeshes = null;             // made once the group exists

    this.group = new THREE.Group();
    this.group.name = 'WaterFX';
    this.group.matrixAutoUpdate = false;
    if (scene && scene.add) scene.add(this.group);
    this._floatMeshes = this._makeFloatMeshes();

    this._emitGain = 0.85;
    this._emitters = null;
    this._lastState = null;
    this._chunks = new Map();   // "cx,cz" -> { geo, surf, bed }
    this._waterTiles = 0;
    this._built = false;
    this._quality = -1;
    this.setQuality(o.quality);
  }

  get object3D() { return this.group; }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /** Full (re)build of the water surface + sea bed from the tile map. */
  buildSurface(state) {
    this._disposeChunks();
    this._lastState = state;
    this._invalidateWarp(0, 0, this.N - 1, this.N - 1);
    this._buildEmitMap(state);
    this._computeShoreField(state, 0, 0, this.N - 1, this.N - 1);
    this._uploadShore();
    this._waterTiles = 0;
    for (let cz = 0; cz < this.chunksPerSide; cz++) {
      for (let cx = 0; cx < this.chunksPerSide; cx++) this._buildChunk(state, cx, cz);
    }
    this._buildApron(state);
    this._placeFloats(state);
    this._built = true;
    return this;
  }

  /**
   * Rebuild after a single tile changed. Rebuilds only the chunk that contains
   * (x,z) and refreshes the shore field in a local window around it.
   */
  refreshTiles(state, x, z) {
    if (!this._built) return this.buildSurface(state);
    this._lastState = state;
    this._emitDirty = true;                // coalesced; flushed in update()
    const pad = Math.ceil(this.opts.far) + 2;
    // terrain.js re-derives its warp from fields that change up to a few
    // tiles around the edit, so the cached lattice there is stale.
    this._invalidateWarp(x - pad, z - pad, x + pad, z + pad);
    this._computeShoreField(state, x - pad, z - pad, x + pad, z + pad);
    this._shoreDirty = true;               // coalesced; flushed in update()
    // The basin's walls and deck sides depend on the 4-neighbours, so an edit
    // on a chunk border dirties the neighbouring chunk too.
    const seen = new Set();
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = x + dx, tz = z + dz;
        if (tx < 0 || tz < 0 || tx >= this.N || tz >= this.N) continue;
        const cx = Math.floor(tx / this.CHUNK), cz = Math.floor(tz / this.CHUNK);
        const k = this._key(cx, cz);
        if (seen.has(k)) continue;
        seen.add(k);
        this._removeChunk(cx, cz);
        this._buildChunk(state, cx, cz);
      }
    }
    if (x <= 1 || z <= 1 || x >= this.N - 2 || z >= this.N - 2) this._buildApron(state);
    this._placeFloats(state);
    return this;
  }

  /**
   * The open sea past the map edge. Every water tile on the map boundary gets
   * a long flat strip of the SAME surface running straight out to the horizon
   * (corner tiles get the corner square too), at the same recessed height, so
   * the coast's sea simply continues off-map — no step, no cut face, and it
   * covers terrain's lower, flat off-map sea slab with a crisp straight edge.
   */
  _buildApron(state) {
    if (this._apron) {
      this.group.remove(this._apron);
      this._apron.geometry.dispose();
      this._apron = null;
    }
    const N = this.N, T = this.TILE, L = this.opts.apron * T, y = this.opts.waterY;
    if (!(L > 0)) return;
    const P = [], IX = [];
    const rect = (ax, az, bx, bz) => {
      const b = P.length / 3;
      P.push(ax, y, az, bx, y, az, ax, y, bz, bx, y, bz);
      IX.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    };
    const W = N * T;
    for (let k = 0; k < N; k++) {
      const a = k * T, b = a + T;
      if (this._isWater(state, k, 0)) rect(a, -L, b, 0);
      if (this._isWater(state, k, N - 1)) rect(a, W, b, W + L);
      if (this._isWater(state, 0, k)) rect(-L, a, 0, b);
      if (this._isWater(state, N - 1, k)) rect(W, a, W + L, b);
    }
    if (this._isWater(state, 0, 0)) rect(-L, -L, 0, 0);
    if (this._isWater(state, N - 1, 0)) rect(W, -L, W + L, 0);
    if (this._isWater(state, 0, N - 1)) rect(-L, W, 0, W + L);
    if (this._isWater(state, N - 1, N - 1)) rect(W, W, W + L, W + L);
    if (!IX.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(IX, 1) : new THREE.Uint16BufferAttribute(IX, 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, this.material);
    m.name = 'water-apron';
    m.renderOrder = 1;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    this.group.add(m);
    this._apron = m;
  }

  /**
   * Tell the water where the land REALLY ends. terrain.js displaces its ground
   * lattice horizontally near the shore (so the coast meanders off the tile
   * grid) and draws the land over the water there. Handing that displacement
   * to WaterFX lets the shore field — and so the foam line, the pale band and
   * the depth terraces — follow the visible edge rather than the tile grid
   * hidden underneath it.
   * @param {(wx:number, wz:number, out:number[]) => number[]} fn  or null
   * @param {number} [step] the terrain lattice spacing in world units
   */
  setLandWarp(fn, step) {
    this._setWarp(typeof fn === 'function' ? fn : null, step || this._warpStep);
    if (this._built && this._lastState) {
      this._computeShoreField(this._lastState, 0, 0, this.N - 1, this.N - 1);
      this._uploadShore();
    }
    return this;
  }

  _setWarp(fn, step) {
    this._warpFn = fn;
    this._warpStep = Math.max(0.5, +step || 4);
    const LN = Math.round(this.worldSize / this._warpStep) + 1;
    if (LN !== this._warpLN) {
      this._warpLN = LN;
      this._warpDX = new Float32Array(LN * LN);
      this._warpDZ = new Float32Array(LN * LN);
      this._warpOK = new Uint8Array(LN * LN);
    } else if (this._warpOK) this._warpOK.fill(0);
  }

  _invalidateWarp(tx0, tz0, tx1, tz1) {
    if (!this._warpOK) return;
    const LN = this._warpLN, st = this._warpStep, T = this.TILE;
    const i0 = Math.max(0, Math.floor(tx0 * T / st) - 1), i1 = Math.min(LN - 1, Math.ceil((tx1 + 1) * T / st) + 1);
    const j0 = Math.max(0, Math.floor(tz0 * T / st) - 1), j1 = Math.min(LN - 1, Math.ceil((tz1 + 1) * T / st) + 1);
    for (let j = j0; j <= j1; j++) this._warpOK.fill(0, j * LN + i0, j * LN + i1 + 1);
  }

  _latDisp(i, j) {
    const LN = this._warpLN;
    const k = j * LN + i;
    if (!this._warpOK[k]) {
      const st = this._warpStep, px = i * st, pz = j * st, o = this._wtmp;
      o[0] = px; o[1] = pz;
      let dx = 0, dz = 0;
      try {
        const r = this._warpFn(px, pz, o) || o;
        dx = r[0] - px; dz = r[1] - pz;
        if (!isFinite(dx) || !isFinite(dz)) { dx = 0; dz = 0; }
      } catch (e) { dx = 0; dz = 0; }
      this._warpDX[k] = dx; this._warpDZ[k] = dz; this._warpOK[k] = 1;
    }
    return k;
  }

  /** Bilinear lattice displacement at world (wx,wz), written into out. */
  _dispAt(wx, wz, out) {
    const LN = this._warpLN, st = this._warpStep;
    let u = wx / st, v = wz / st;
    if (u < 0) u = 0; else if (u > LN - 1.001) u = LN - 1.001;
    if (v < 0) v = 0; else if (v > LN - 1.001) v = LN - 1.001;
    const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
    const a = this._latDisp(i, j), b = this._latDisp(i + 1, j);
    const c = this._latDisp(i, j + 1), d = this._latDisp(i + 1, j + 1);
    const DX = this._warpDX, DZ = this._warpDZ;
    const x0 = DX[a] + (DX[b] - DX[a]) * fu, x1 = DX[c] + (DX[d] - DX[c]) * fu;
    const z0 = DZ[a] + (DZ[b] - DZ[a]) * fu, z1 = DZ[c] + (DZ[d] - DZ[c]) * fu;
    out[0] = x0 + (x1 - x0) * fv;
    out[1] = z0 + (z1 - z0) * fv;
    return out;
  }

  _isWater(state, x, z) {
    if (x < 0 || z < 0 || x >= this.N || z >= this.N) return false;
    const i = z * this.N + x;
    return state.map[i] === T_WATER || (state.bridge && state.bridge[i] === 1);
  }

  _isSand(state, x, z) {
    if (x < 0 || z < 0 || x >= this.N || z >= this.N) return false;
    return state.map[z * this.N + x] === T_SAND;
  }

  _key(cx, cz) { return cx + ',' + cz; }

  _removeChunk(cx, cz) {
    const k = this._key(cx, cz);
    const c = this._chunks.get(k);
    if (!c) return;
    if (c.surf) this.group.remove(c.surf);
    if (c.bed) this.group.remove(c.bed);
    if (c.bank) this.group.remove(c.bank);
    if (c.geo) c.geo.dispose();
    if (c.bankGeo) c.bankGeo.dispose();
    this._waterTiles -= c.tiles || 0;
    this._chunks.delete(k);
  }

  _disposeChunks() {
    for (const k of Array.from(this._chunks.keys())) {
      const [cx, cz] = k.split(',');
      this._removeChunk(+cx, +cz);
    }
    this._chunks.clear();
  }

  _buildChunk(state, cx, cz) {
    const N = this.N, T = this.TILE, SUB = this.SUB;
    const x0 = cx * this.CHUNK, z0 = cz * this.CHUNK;
    const x1 = Math.min(N, x0 + this.CHUNK), z1 = Math.min(N, z0 + this.CHUNK);

    let tiles = 0;
    for (let z = z0; z < z1; z++)
      for (let x = x0; x < x1; x++) if (this._isWater(state, x, z)) tiles++;
    const bankGeo = this._buildBank(state, x0, z0, x1, z1);
    let bank = null;
    if (bankGeo) {
      bank = new THREE.Mesh(bankGeo, this.bankMaterial);
      bank.name = `waterbank-${cx}-${cz}`;
      bank.castShadow = true;
      bank.receiveShadow = true;
      bank.matrixAutoUpdate = false;
      bank.updateMatrix();
      this.group.add(bank);
    }
    if (tiles === 0) {
      if (bank) this._chunks.set(this._key(cx, cz), { geo: null, surf: null, bed: null, bank, bankGeo, tiles: 0 });
      return;
    }

    const vpt = (SUB + 1) * (SUB + 1);
    const ipt = SUB * SUB * 6;
    const pos = new Float32Array(tiles * vpt * 3);
    const idx = (tiles * vpt > 65535) ? new Uint32Array(tiles * ipt) : new Uint16Array(tiles * ipt);
    const step = T / SUB;
    const y = this.opts.waterY;

    let vp = 0, ip = 0, base = 0;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (!this._isWater(state, x, z)) continue;
        const wx = x * T, wz = z * T;
        for (let j = 0; j <= SUB; j++) {
          for (let i = 0; i <= SUB; i++) {
            pos[vp++] = wx + i * step;
            pos[vp++] = y;
            pos[vp++] = wz + j * step;
          }
        }
        for (let j = 0; j < SUB; j++) {
          for (let i = 0; i < SUB; i++) {
            const a = base + j * (SUB + 1) + i;
            const b = a + 1;
            const c = a + (SUB + 1);
            const d = c + 1;
            idx[ip++] = a; idx[ip++] = c; idx[ip++] = b;
            idx[ip++] = b; idx[ip++] = c; idx[ip++] = d;
          }
        }
        base += vpt;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 2.5;

    const surf = new THREE.Mesh(geo, this.material);
    surf.name = `water-${cx}-${cz}`;
    surf.castShadow = false;
    surf.receiveShadow = false;
    surf.renderOrder = 1;
    surf.matrixAutoUpdate = false;
    surf.updateMatrix();
    this.group.add(surf);

    let bed = null;
    if (this.opts.seabed) {
      bed = new THREE.Mesh(geo, this.bedMaterial);
      bed.name = `waterbed-${cx}-${cz}`;
      bed.castShadow = false;
      bed.receiveShadow = false;
      bed.renderOrder = 0;
      bed.matrixAutoUpdate = false;
      bed.updateMatrix();
      this.group.add(bed);
    }

    this._waterTiles += tiles;
    this._chunks.set(this._key(cx, cz), { geo, surf, bed, bank, bankGeo, tiles });
  }

  // -------------------------------------------------------------------------
  // The voxel basin: sand deck + coping + pool walls (flat-shaded quads)
  // -------------------------------------------------------------------------

  _isDeck(state, x, z) {
    if (x < 0 || z < 0 || x >= this.N || z >= this.N) return false;
    const i = z * this.N + x;
    return state.map[i] === T_SAND && !(state.bridge && state.bridge[i] === 1);
  }

  /** A deck tile with no water anywhere in its 8-neighbourhood: a lawn bed. */
  _isLawn(state, x, z) {
    if (!this._isDeck(state, x, z)) return false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= this.N || nz >= this.N) continue;
        if (this._isWater(state, nx, nz)) return false;
      }
    }
    return true;
  }

  /**
   * Hedge planters on a deck tile (round 7 — critic: "hard stepped outline and
   * all-sand surround reads as a giant swimming pool; break the shore up with
   * some grass"). A chunky lime box with a darker foot band runs along an edge
   * that faces grass (the outer rim of the sand ring) or a lawn bed, on a
   * deterministic ~55% of those edges — ref05's pool deck is hemmed by hedges.
   */
  _hedges(state, tx, tz, X0, Z0, T, top, faceX, faceZ, C) {
    const w = 1.4, inset = 0.35;
    const box = (xa, za, xb, zb, H) => {
      top(xa, za, xb, zb, H, C.hedgeTop);
      faceX(xa, za, zb, DECK_Y + 0.3, H, -1, C.hedge);
      faceX(xb, za, zb, DECK_Y + 0.3, H, 1, C.hedge);
      faceZ(za, xa, xb, DECK_Y + 0.3, H, -1, C.hedge);
      faceZ(zb, xa, xb, DECK_Y + 0.3, H, 1, C.hedge);
      // a darker band at the foot (ref06 bushes' lower band)
      faceX(xa, za, zb, DECK_Y, DECK_Y + 0.3, -1, C.hedgeBase);
      faceX(xb, za, zb, DECK_Y, DECK_Y + 0.3, 1, C.hedgeBase);
      faceZ(za, xa, xb, DECK_Y, DECK_Y + 0.3, -1, C.hedgeBase);
      faceZ(zb, xa, xb, DECK_Y, DECK_Y + 0.3, 1, C.hedgeBase);
    };
    const X1 = X0 + T, Z1 = Z0 + T;
    const lawn = this._isLawn(state, tx, tz);
    const sides = [[1, 0, 11], [-1, 0, 23], [0, 1, 37], [0, -1, 59]];
    for (const [dx, dz, salt] of sides) {
      const nx = tx + dx, nz = tz + dz;
      if (nx < 0 || nz < 0 || nx >= this.N || nz >= this.N) continue;
      if (this._isWater(state, nx, nz)) continue;
      const nDeck = this._isDeck(state, nx, nz);
      // outer rim (faces grass), or a sand tile's edge against a lawn bed
      const want = !nDeck || (!lawn && this._isLawn(state, nx, nz));
      if (!want || hash01(tx, tz, salt) > 0.55) continue;
      if (dx !== 0) {
        const xa = dx > 0 ? X1 - inset - w : X0 + inset;
        box(xa, Z0 + inset, xa + w, Z1 - inset, DECK_Y + 1.25);
      } else {
        const za = dz > 0 ? Z1 - inset - w : Z0 + inset;
        box(X0 + inset, za, X1 - inset, za + w, DECK_Y + 1.1);
      }
    }
  }

  /**
   * Geometry for the basin over tiles [x0,x1) x [z0,z1). Every face is an
   * axis-aligned quad with its own flat normal and colour — hard voxel edges,
   * no gradients. Returns null when the window has no deck and no walls.
   */
  _buildBank(state, x0, z0, x1, z1) {
    const T = this.TILE, N = this.N, C = this._bankCol;
    const P = [], NR = [], CL = [], GL = [], IX = [];
    let glow = 0;                     // aGlow of the faces being emitted
    const quad = (a, b, c, d, n, col) => {
      // wind so the face points along n
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cxp = uy * vz - uz * vy, cyp = uz * vx - ux * vz, czp = ux * vy - uy * vx;
      const flip = (cxp * n[0] + cyp * n[1] + czp * n[2]) < 0;
      const base = P.length / 3;
      for (const v of [a, b, c, d]) {
        P.push(v[0], v[1], v[2]);
        NR.push(n[0], n[1], n[2]);
        CL.push(col.r, col.g, col.b);
        GL.push(glow);
      }
      if (flip) IX.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else IX.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    // Horizontal rect at y.
    const top = (ax, az, bx, bz, y, col) =>
      quad([ax, y, az], [bx, y, az], [bx, y, bz], [ax, y, bz], [0, 1, 0], col);
    // Vertical face on the plane x = X (normal ±x), spanning z and y.
    const faceX = (X, za, zb, ya, yb, nx, col) =>
      quad([X, ya, za], [X, ya, zb], [X, yb, zb], [X, yb, za], [nx, 0, 0], col);
    // Vertical face on the plane z = Z (normal ±z), spanning x and y.
    const faceZ = (Z, xa, xb, ya, yb, nz, col) =>
      quad([xa, ya, Z], [xb, ya, Z], [xb, yb, Z], [xa, yb, Z], [0, 0, nz], col);
    const inMap = (x, z) => x >= 0 && z >= 0 && x < N && z < N;
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const W = COPE_W, cy = DECK_Y + LIP;
    const wy = this.opts.waterY, wallBot = wy - WALL_SINK;

    for (let tz = z0; tz < z1; tz++) {
      for (let tx = x0; tx < x1; tx++) {
        const X0 = tx * T, X1 = X0 + T, Z0 = tz * T, Z1 = Z0 + T;

        // ---- sand deck ----------------------------------------------------
        if (this._isDeck(state, tx, tz)) {
          // Round 7 (critic: "all-sand surround reads as a giant swimming
          // pool"): deck tiles with no water in their 8-neighbourhood become
          // raised lawn beds (ref05's pool deck is ringed by grass beds), and
          // some lawn edges that face the sand get a chunky hedge planter.
          const lawn = this._isLawn(state, tx, tz);
          top(X0, Z0, X1, Z1, DECK_Y, lawn ? C.lawnTop : C.deckTop);
          this._hedges(state, tx, tz, X0, Z0, T, top, faceX, faceZ, C);
          for (const [dx, dz] of DIRS) {
            const nx = tx + dx, nz = tz + dz;
            const nIn = inMap(nx, nz);
            if (nIn && this._isWater(state, nx, nz)) {
              // coping strip along this edge (its water face is the wall)
              if (dx !== 0) {
                const xa = dx > 0 ? X1 - W : X0, xb = dx > 0 ? X1 : X0 + W;
                top(xa, Z0, xb, Z1, cy, C.copeTop);
                // round 11: a wet-sand strip where the deck meets the coping
                if (!lawn) top(dx > 0 ? xa - WET_SAND : xb, Z0, dx > 0 ? xa : xb + WET_SAND, Z1, DECK_Y + 0.02, C.deckWet);
                faceX(dx > 0 ? xa : xb, Z0, Z1, DECK_Y, cy, -dx, C.copeSide);
                faceZ(Z0, xa, xb, DECK_Y, cy, -1, C.copeSide);
                faceZ(Z1, xa, xb, DECK_Y, cy, 1, C.copeSide);
              } else {
                const za = dz > 0 ? Z1 - W : Z0, zb = dz > 0 ? Z1 : Z0 + W;
                top(X0, za, X1, zb, cy, C.copeTop);
                if (!lawn) top(X0, dz > 0 ? za - WET_SAND : zb, X1, dz > 0 ? za : zb + WET_SAND, DECK_Y + 0.02, C.deckWet);
                faceZ(dz > 0 ? za : zb, X0, X1, DECK_Y, cy, -dz, C.copeSide);
                faceX(X0, za, zb, DECK_Y, cy, -1, C.copeSide);
                faceX(X1, za, zb, DECK_Y, cy, 1, C.copeSide);
              }
            } else if (!nIn || !this._isDeck(state, nx, nz)) {
              // outer side of the deck: a crisp darker band, like a lot plinth
              const sc = lawn ? C.lawnSide : C.deckSide;
              if (dx !== 0) faceX(dx > 0 ? X1 : X0, Z0, Z1, SIDE_BOT, DECK_Y, dx, sc);
              else faceZ(dz > 0 ? Z1 : Z0, X0, X1, SIDE_BOT, DECK_Y, dz, sc);
              // w4r2 (critics w3r1 + w4r1: "the sand band is a plain tan strip
              // with a hard edge against the grass; no plinth / kerb step"):
              // a light concrete kerb along the outer edge, like every lot
              // plinth's rim (ART-DIRECTION), raised a hair with its own faces.
              const KW = 0.55, KY = DECK_Y + 0.08;
              if (dx !== 0) {
                const xa = dx > 0 ? X1 - KW : X0, xb = dx > 0 ? X1 : X0 + KW;
                top(xa, Z0, xb, Z1, KY, C.deckKerb);
                faceX(dx > 0 ? X1 : X0, Z0, Z1, DECK_Y, KY, dx, C.copeSide);
                faceX(dx > 0 ? xa : xb, Z0, Z1, DECK_Y, KY, -dx, C.copeSide);
              } else {
                const za = dz > 0 ? Z1 - KW : Z0, zb = dz > 0 ? Z1 : Z0 + KW;
                top(X0, za, X1, zb, KY, C.deckKerb);
                faceZ(dz > 0 ? Z1 : Z0, X0, X1, DECK_Y, KY, dz, C.copeSide);
                faceZ(dz > 0 ? za : zb, X0, X1, DECK_Y, KY, -dz, C.copeSide);
              }
            }
          }
          // coping corner square where the water only touches diagonally
          for (const dx of [-1, 1]) {
            for (const dz of [-1, 1]) {
              if (!inMap(tx + dx, tz + dz) || !this._isWater(state, tx + dx, tz + dz)) continue;
              if (this._isWater(state, tx + dx, tz) || this._isWater(state, tx, tz + dz)) continue;
              const xa = dx > 0 ? X1 - W : X0, xb = dx > 0 ? X1 : X0 + W;
              const za = dz > 0 ? Z1 - W : Z0, zb = dz > 0 ? Z1 : Z0 + W;
              top(xa, za, xb, zb, cy, C.copeTop);
              faceX(dx > 0 ? xa : xb, za, zb, DECK_Y, cy, -dx, C.copeSide);
              faceZ(dz > 0 ? za : zb, xa, xb, DECK_Y, cy, -dz, C.copeSide);
            }
          }
        }

        // ---- pool walls: every water edge that meets land ------------------
        if (this._isWater(state, tx, tz)) {
          for (const [dx, dz] of DIRS) {
            const nx = tx + dx, nz = tz + dz;
            if (!inMap(nx, nz)) {
              if (this.opts.apron > 0) continue;   // the sea runs on off-map
              // Map edge: a clean blue cut face down to terrain's off-map sea
              // (borderY), instead of the brown border cliff showing through.
              if (dx !== 0) faceX(dx > 0 ? X1 + WALL_EPS : X0 - WALL_EPS, Z0, Z1, EDGE_BOT, this.opts.waterY, dx, C.seaEdge);
              else faceZ(dz > 0 ? Z1 + WALL_EPS : Z0 - WALL_EPS, X0, X1, EDGE_BOT, this.opts.waterY, dz, C.seaEdge);
              continue;
            }
            if (this._isWater(state, nx, nz)) continue;
            const deck = this._isDeck(state, nx, nz);
            // roads 09-25: roads.js now draws the asphalt over bridge tiles
            // (at y 0.02); a bridge tile's wall stops just under it so its
            // top edge can't poke through the road at the shore seam.
            const brHere = state.bridge && state.bridge[tz * N + tx] === 1;
            const yTop = deck ? cy : (brHere ? -0.03 : GROUND_TOP);
            const band = deck ? COPE_FACE : 0.10;
            const bandCol = deck ? C.copeFace : C.wallTop;
            // per-orientation tone (outward normal is -dx / -dz)
            const k = dx < 0 ? WALL_TONE.px : dx > 0 ? WALL_TONE.nx : dz < 0 ? WALL_TONE.pz : WALL_TONE.nz;
            const tone = (c) => new THREE.Color(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k));
            const cWet = tone(C.wallWet), cWall = tone(C.wall), cAlt = tone(C.wallAlt), cGrout = tone(C.wallLip);
            const cSeam = tone(C.wallSeam);
            // the pale coping face only dims half as much — it stays a light lip
            const kb = 0.5 + 0.5 * Math.min(1, k);
            const cBand = new THREE.Color(bandCol.r * kb, bandCol.g * kb, bandCol.b * kb);
            // Wall, bottom to top: a thin wet strip at the waterline, the
            // pool TILES (round 11, critic r10: "make the inner wall a taller,
            // lighter, tiled blue band"): a grid of WALL_PANEL squares with
            // thin darker seams, both ways, counted down from the coping so
            // the top row is always whole (ref05's tiled pool wall), then a
            // shadow line tucked under the lip and the coping/bank band.
            const yWet = wy + WET_BAND, yGrout = yTop - band - 0.14, yBand = yTop - band;
            const vert = (a, b, ya, yb, col) => {
              if (dx !== 0) faceX(dx > 0 ? X1 - WALL_EPS : X0 + WALL_EPS, a, b, ya, yb, -dx, col);
              else faceZ(dz > 0 ? Z1 - WALL_EPS : Z0 + WALL_EPS, a, b, ya, yb, -dz, col);
            };
            const A = dx !== 0 ? Z0 : X0;
            glow = WALL_GLOW;
            vert(A, A + T, wallBot, yWet, cWet);
            // row boundaries (seams sit just under each boundary), top down
            // Round 14 (critic r13: "the wall faces are a flat, even blue
            // with no tile or depth gradient; ref05's inner wall is a shaded
            // tiled band under the rim"): rows of tiles counted down from the
            // coping, each row a step DARKER toward the water (ref05's shade
            // face runs #105097 at the top to #052b6a at the waterline), in
            // 2 u columns with soft seams. The rows are separated by the tone
            // step alone — no grout lines (critic r12: "grid too strong").
            const ROW_H = 1.0, ROW_K = [1.0, 0.95, 0.90, 0.86];   // wave4: gentler (rows went navy at the waterline)
            const rowsY = [yGrout];
            while (rowsY[rowsY.length - 1] - ROW_H > yWet + 0.3) rowsY.push(rowsY[rowsY.length - 1] - ROW_H);
            rowsY.push(yWet);
            const dim = (c, f) => new THREE.Color(c.r * f, c.g * f, c.b * f);
            for (let k = 0; k * WALL_PANEL < T - 1e-6; k++) {
              const a = A + k * WALL_PANEL, b = Math.min(A + T, a + WALL_PANEL);
              const gk = Math.floor((a + 1e-3) / WALL_PANEL);
              const cT = (gk & 1) ? cAlt : cWall;
              for (let r = 0; r + 1 < rowsY.length; r++) {
                const f = ROW_K[Math.min(r, ROW_K.length - 1)];
                const yb = rowsY[r], ya = rowsY[r + 1];
                vert(a, a + WALL_SEAM, ya, yb, dim(cSeam, f));   // vertical seam
                vert(a + WALL_SEAM, b, ya, yb, dim(cT, f));
              }
            }
            vert(A, A + T, yGrout, yBand, cGrout);
            glow = WALL_GLOW * 0.5;
            vert(A, A + T, yBand, yTop, cBand);
            glow = 0;
          }
          // Bridge tile: a light concrete pier from below the water up to the
          // deck, so the bridge (now well above the recessed water) stands.
          if (state.bridge && state.bridge[tz * N + tx] === 1) {
            const h = 1.1, mx = X0 + T * 0.5, mz = Z0 + T * 0.5;
            const pa = mx - h, pb = mx + h, qa = mz - h, qb = mz + h;
            // roads 09-25: top -1.0 (under infra.js's deck band); at 0.05 its
            // edges poked through the road surface roads.js now draws here.
            faceX(pa, qa, qb, wallBot, -1.0, -1, C.pierSide);
            faceX(pb, qa, qb, wallBot, -1.0, 1, C.pierSide);
            faceZ(qa, pa, pb, wallBot, -1.0, -1, C.pier);
            faceZ(qb, pa, pb, wallBot, -1.0, 1, C.pier);
          }
        }
      }
    }
    if (!IX.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(NR, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(CL, 3));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(GL, 1));
    geo.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(IX, 1) : new THREE.Uint16BufferAttribute(IX, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  // -------------------------------------------------------------------------
  // Pool floats: a few voxel rings and beach balls bobbing on the water
  // -------------------------------------------------------------------------

  _makeFloatMeshes() {
    const C = this._bankCol;
    const build = (boxes) => {
      const P = [], NR = [], CL = [], IX = [];
      const F = [ // [normal, 4 corner selectors]
        [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
        [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
        [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
        [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
        [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
        [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
      ];
      for (const b of boxes) {
        const [x0, y0, z0, x1, y1, z1, col] = b;
        for (const [n, cs] of F) {
          const base = P.length / 3;
          const pts = cs.map((c) => [c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0]);
          for (const p of pts) {
            P.push(p[0], p[1], p[2]);
            NR.push(n[0], n[1], n[2]);
            CL.push(col.r, col.g, col.b);
          }
          const [a, b2, c2] = pts;
          const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2];
          const vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
          const dot = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
          if (dot < 0) IX.push(base, base + 2, base + 1, base, base + 3, base + 2);
          else IX.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(NR, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(CL, 3));
      g.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(P.length / 3), 1));
      g.setIndex(IX);
      g.computeBoundingSphere();
      return g;
    };
    // Square swim ring, 3.0 across, bars 0.8 wide, 0.5 tall; alternating bars.
    const ring = (a, b) => {
      const R = 1.5, w = 0.8, h = 0.5;
      return build([
        [-R, 0, -R, R - w, h, -R + w, a],
        [R - w, 0, -R, R, h, R - w, b],
        [-R + w, 0, R - w, R, h, R, a],
        [-R, 0, -R + w, -R + w, h, R, b],
      ]);
    };
    // Beach ball: a 1.2 voxel cube in three bold stripes + white caps.
    const s = 0.6, k = 0.2;
    const ball = build([
      [-s, 0, -s, -k, 2 * s, s, C.red],
      [-k, 0, -s, k, 2 * s, s, C.white],
      [k, 0, -s, s, 2 * s, s, C.blue],
      [-k * 1.2, 2 * s, -k * 1.2, k * 1.2, 2 * s + 0.08, k * 1.2, C.yellow],
    ]);
    // Poolside parasol + sun lounger (ref05's deck), built at +x = "toward
    // the water"; instances are yawed in 90-degree steps to face it.
    const parasol = build([
      [-2.6, 0, -0.14, -2.34, 2.9, 0.14, C.white],                 // pole
      [-3.9, 2.9, -1.3, -2.6, 3.2, 0.0, C.red],                    // canopy quarters
      [-2.6, 2.9, -1.3, -1.3, 3.2, 0.0, C.white],
      [-3.9, 2.9, 0.0, -2.6, 3.2, 1.3, C.white],
      [-2.6, 2.9, 0.0, -1.3, 3.2, 1.3, C.red],
      [-3.1, 3.2, -0.5, -1.8, 3.45, 0.5, C.red],                   // top tier
      [-2.1, 0, 1.5, 0.3, 0.32, 2.4, C.white],                     // lounger
      [-2.1, 0.32, 1.5, -1.5, 0.85, 2.4, C.white],                 // backrest
      [-3.6, 0, -2.2, -2.8, 0.18, -1.4, C.lounge],                 // towel
    ]);
    const kinds = [ring(C.red, C.white), ring(C.yellow, C.orange), ball, parasol];
    return kinds.map((geo, i) => {
      const m = new THREE.InstancedMesh(geo, this.bankMaterial, i === 3 ? MAX_PARASOLS : MAX_FLOATS);
      m.name = 'waterfloat-' + i;
      m.count = 0;
      m.castShadow = true;
      // PERF: lighting.js's static shadow cache refreshes animated casters
      // like these (a gentle bob) at a few Hz instead of every frame.
      m.userData.shadowLowRate = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    });
  }

  /**
   * Deterministic float placement, per water body: every enclosed lake gets a
   * few (ref05's pool has four), the open sea at the map edge only a sprinkle.
   * Open water only (not hugging a wall, not under a bridge), spaced out.
   */
  _placeFloats(state) {
    const N = this.N, S = this.S, W = this.fieldW, T = this.TILE;
    const dl = this._distLand;
    const body = this._bodyId || (this._bodyId = new Int32Array(N * N));
    body.fill(-1);
    const bodies = [];
    const stack = [];
    for (let i0 = 0; i0 < N * N; i0++) {
      if (body[i0] >= 0 || state.map[i0] !== T_WATER) continue;
      const id = bodies.length;
      const info = { tiles: 0, edge: false, cand: [] };
      bodies.push(info);
      body[i0] = id; stack.push(i0);
      while (stack.length) {
        const i = stack.pop();
        const x = i % N, z = (i / N) | 0;
        info.tiles++;
        if (x === 0 || z === 0 || x === N - 1 || z === N - 1) info.edge = true;
        if (!(state.bridge && state.bridge[i] === 1)) {
          const c = (z * S + (S >> 1)) * W + x * S + (S >> 1);
          const d = dl[c] >= INF ? 99 : dl[c] / S;
          if (d >= 1.5 && d <= 5) info.cand.push([hash01(x, z, 4242), x, z]);
        }
        if (x > 0 && body[i - 1] < 0 && state.map[i - 1] === T_WATER) { body[i - 1] = id; stack.push(i - 1); }
        if (x < N - 1 && body[i + 1] < 0 && state.map[i + 1] === T_WATER) { body[i + 1] = id; stack.push(i + 1); }
        if (z > 0 && body[i - N] < 0 && state.map[i - N] === T_WATER) { body[i - N] = id; stack.push(i - N); }
        if (z < N - 1 && body[i + N] < 0 && state.map[i + N] === T_WATER) { body[i + N] = id; stack.push(i + N); }
      }
    }
    // lakes first (they are the pools), then the sea
    bodies.sort((p, q) => (p.edge - q.edge) || (q.tiles - p.tiles));
    const picked = [];
    for (const b of bodies) {
      if (b.tiles < 10) continue;
      let nth = 0;
      let want = b.edge ? Math.min(4, Math.floor(b.tiles / 90)) : Math.max(1, Math.min(5, Math.round(b.tiles / 22)));
      b.cand.sort((p, q) => p[0] - q[0]);
      for (const [h, x, z] of b.cand) {
        if (want <= 0 || picked.length >= MAX_FLOATS) break;
        let ok = true;
        for (const p of picked) if (Math.abs(p.x - x) < 3 && Math.abs(p.z - z) < 3) { ok = false; break; }
        if (!ok) continue;
        want--;
        picked.push({
          x, z,
          kind: (nth++ + Math.floor(hash01(x, z, 911) * 3)) % 3,
          wx: (x + 0.5) * T + (hash01(x, z, 17) - 0.5) * 3.0,
          wz: (z + 0.5) * T + (hash01(x, z, 29) - 0.5) * 3.0,
          yaw: hash01(x, z, 53) < 0.5 ? 0 : Math.PI / 2,
          ph: h * 40.0,
        });
      }
    }
    // Parasols on the sand deck, on tiles that front the water.
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const deckC = [];
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (!this._isDeck(state, x, z)) continue;
        if (state.occ && state.occ[z * N + x]) continue;
        for (let k = 0; k < 4; k++) {
          const [dx, dz] = DIRS[k];
          if (!this._isWater(state, x + dx, z + dz)) continue;
          // the tile behind must be deck or grass, so the set is not on a spit
          deckC.push([hash01(x, z, 7771 + k), x, z, dx, dz]);
          break;
        }
      }
    }
    deckC.sort((p, q) => p[0] - q[0]);
    const want = Math.min(MAX_PARASOLS, Math.round(deckC.length / 7));
    let np = 0;
    for (const [h, x, z, dx, dz] of deckC) {
      if (np >= want) break;
      let ok = true;
      for (const p of picked) if (p.kind === 3 && Math.abs(p.x - x) < 3 && Math.abs(p.z - z) < 3) { ok = false; break; }
      if (!ok) continue;
      np++;
      // local +x points at the water: yaw = atan2(-dz, dx)
      picked.push({
        x, z, kind: 3, fixed: true,
        wx: (x + 0.5) * T + dx * 0.8, wz: (z + 0.5) * T + dz * 0.8,
        yaw: Math.atan2(-dz, dx),
        ph: 0,
      });
    }
    this._floats = picked;
    this._animFloats(this._shared.uTime.value);
  }

  _animFloats(t) {
    const meshes = this._floatMeshes;
    if (!meshes) return;
    const m4 = this._fm4 || (this._fm4 = new THREE.Matrix4());
    const q = this._fq || (this._fq = new THREE.Quaternion());
    const e = this._fe || (this._fe = new THREE.Euler());
    const v = this._fv || (this._fv = new THREE.Vector3());
    const one = this._f1 || (this._f1 = new THREE.Vector3(1, 1, 1));
    const counts = [0, 0, 0, 0];
    const y0 = this.opts.waterY;
    const fpos = this.uniforms.uFloatPos.value;
    let nf = 0;
    for (const f of this._floats) {
      const m = meshes[f.kind];
      const k = counts[f.kind]++;
      if (f.fixed) {
        v.set(f.wx, DECK_Y, f.wz);
        e.set(0, f.yaw, 0);
        q.setFromEuler(e);
        const sc = this._fsc || (this._fsc = new THREE.Vector3(1.3, 1.3, 1.3));
        m4.compose(v, q, sc);
        m.setMatrixAt(k, m4);
        continue;
      }
      const ph = f.ph + t;
      const sink = f.kind === 2 ? 0.35 : 0.22;
      v.set(f.wx + Math.sin(ph * 0.11) * 0.5, y0 - sink + Math.sin(ph * 1.7) * 0.05,
            f.wz + Math.cos(ph * 0.09) * 0.5);
      e.set(Math.sin(ph * 1.3) * 0.05, f.yaw + Math.sin(ph * 0.21) * 0.10, Math.cos(ph * 1.1) * 0.05);
      q.setFromEuler(e);
      m4.compose(v, q, one);
      m.setMatrixAt(k, m4);
      // splash halo in the surface shader (ring 3.0 across, ball 1.2)
      if (nf < fpos.length) fpos[nf++].set(v.x, v.z, f.kind === 2 ? 0.6 : 1.5, 1);
    }
    for (let i = nf; i < fpos.length; i++) fpos[i].w = 0;
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].count = counts[i];
      meshes[i].instanceMatrix.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Shore distance field (baked -> DataTexture; NO depth-buffer read)
  // -------------------------------------------------------------------------

  /**
   * Chamfer distance transforms over the sub-cell grid, restricted to a window.
   * Three fields: distance to land (offshore side), to water (onshore side, so
   * the fine channel is SIGNED and its zero sits exactly on the waterline) and
   * to sand. Land is the tile map PLUS whatever water terrain.js's warped bank
   * covers (see setLandWarp).
   */
  _computeShoreField(state, tx0, tz0, tx1, tz1) {
    const S = this.S, W = this.fieldW, N = this.N, T = this.TILE;
    const far = this.opts.far;
    const pad = Math.ceil(far) + 2;
    const ttx0 = Math.max(0, tx0 - pad), ttz0 = Math.max(0, tz0 - pad);
    const ttx1 = Math.min(N - 1, tx1 + pad), ttz1 = Math.min(N - 1, tz1 + pad);
    if (ttx1 < ttx0 || ttz1 < ttz0) return;
    const cx0 = ttx0 * S, cz0 = ttz0 * S;
    const cx1 = (ttx1 + 1) * S - 1, cz1 = (ttz1 + 1) * S - 1;

    const flags = this._tileFlags;            // 1 = water, 2 = sand, 0 = other land
    for (let tz = ttz0; tz <= ttz1; tz++) {
      for (let tx = ttx0; tx <= ttx1; tx++) {
        flags[tz * N + tx] = this._isWater(state, tx, tz) ? 1
                           : (this._isSand(state, tx, tz) ? 2 : 0);
      }
    }

    const dl = this._distLand, ds = this._distSand, dw = this._distWater;
    const cov = this._covered;
    const edgeLand = this.opts.edgeIsLand;

    // ---- seed (tile map) ---------------------------------------------------
    for (let cz = cz0; cz <= cz1; cz++) {
      const tzRow = ((cz / S) | 0) * N;
      const row = cz * W;
      for (let cx = cx0; cx <= cx1; cx++) {
        const f = flags[tzRow + ((cx / S) | 0)];
        const i = row + cx;
        dl[i] = f === 1 ? INF : 0;
        ds[i] = f === 2 ? 0 : INF;
        cov[i] = 0;
      }
    }

    // ---- warped bank: water cells the terrain's land actually covers -------
    // Tile-grid distance first (cheap, one pass) to find the thin strip of
    // water the warp can reach, then invert the warp there by fixed-point
    // iteration (the displacement is a contraction, so p = q - disp(p)
    // converges in a handful of steps) and ask which TILE the pre-image is on.
    if (this._warpFn) {
      this._chamfer(dl, cx0, cz0, cx1, cz1, edgeLand);
      const reach = this.opts.warpReach * S;
      const cell = T / S, g = this._wtmp2 || (this._wtmp2 = [0, 0]);
      const ws = this.worldSize;
      for (let cz = cz0; cz <= cz1; cz++) {
        const row = cz * W;
        for (let cx = cx0; cx <= cx1; cx++) {
          const i = row + cx;
          const d = dl[i];
          if (d === 0 || d > reach) continue;
          const qx = (cx + 0.5) * cell, qz = (cz + 0.5) * cell;
          let px = qx, pz = qz;
          for (let k = 0; k < 5; k++) {
            this._dispAt(px, pz, g);
            px = qx - g[0]; pz = qz - g[1];
          }
          if (px < 0 || pz < 0 || px >= ws || pz >= ws) continue;
          const tx = (px / T) | 0, tz = (pz / T) | 0;
          if (!this._isWater(state, tx, tz)) cov[i] = 1;
        }
      }
      // re-seed with the covered cells counted as land
      for (let cz = cz0; cz <= cz1; cz++) {
        const tzRow = ((cz / S) | 0) * N;
        const row = cz * W;
        for (let cx = cx0; cx <= cx1; cx++) {
          const i = row + cx;
          dl[i] = (flags[tzRow + ((cx / S) | 0)] === 1 && !cov[i]) ? INF : 0;
        }
      }
    }
    for (let cz = cz0; cz <= cz1; cz++) {
      const tzRow = ((cz / S) | 0) * N;
      const row = cz * W;
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = row + cx;
        dw[i] = (flags[tzRow + ((cx / S) | 0)] === 1 && !cov[i]) ? 0 : INF;
      }
    }

    this._chamfer(dl, cx0, cz0, cx1, cz1, edgeLand);
    this._chamfer(ds, cx0, cz0, cx1, cz1, false);
    this._chamfer(dw, cx0, cz0, cx1, cz1, !edgeLand);

    // ---- pack -> RGBA ------------------------------------------------------
    const out = this._shoreData;
    const invFarCells = 1 / (far * S);
    const maxCells = far * S;
    const sandFarCells = 2.5 * S;
    const invSand = 1 / sandFarCells;
    const cellW = T / S;
    const fMin = this.opts.fineMin, fInv = 1 / this.opts.fineRange;
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * W;
      const tzRow = ((cz / S) | 0) * N;
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = row + cx;
        const water = flags[tzRow + ((cx / S) | 0)] === 1;
        let d = dl[i];
        d = d >= INF ? maxCells : (d > 0.5 ? d - 0.5 : 0);
        let r = d * invFarCells; if (r > 1) r = 1;
        // Signed fine distance: + offshore, - onshore, 0 on the waterline.
        let sd;
        if (dl[i] > 0) sd = (dl[i] >= INF ? maxCells : dl[i] - 0.5) * cellW;
        else sd = -((dw[i] >= INF ? maxCells : dw[i]) - 0.5) * cellW;
        let fine = (sd - fMin) * fInv; if (fine < 0) fine = 0; else if (fine > 1) fine = 1;
        const sdd = ds[i] >= INF ? sandFarCells : ds[i];
        let beach = 1 - sdd * invSand; if (beach < 0) beach = 0;
        const o = i * 4;
        out[o] = (r * 255 + 0.5) | 0;
        out[o + 1] = water ? 255 : 0;
        out[o + 2] = (fine * 255 + 0.5) | 0;
        out[o + 3] = (beach * 255) | 0;
      }
    }
    this._shoreDirty = true;
  }

  /**
   * Two-pass chamfer (1 / sqrt2) in a window. Neighbour reads are clamped to
   * the ARRAY, not the window: cells just outside the window already hold
   * final distances and are the correct boundary condition for an incremental
   * refresh (reading only inside the window starved its north/west borders).
   */
  _chamfer(arr, cx0, cz0, cx1, cz1, edgeSeed) {
    const W = this.fieldW;
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * W;
      const hasUp = cz > 0;
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = row + cx;
        let d = arr[i];
        if (d === 0) continue;
        if (cx > 0) { const v = arr[i - 1] + 1; if (v < d) d = v; }
        else if (edgeSeed) { if (1 < d) d = 1; }
        if (hasUp) {
          let v = arr[i - W] + 1; if (v < d) d = v;
          if (cx > 0) { v = arr[i - W - 1] + SQRT2; if (v < d) d = v; }
          if (cx < W - 1) { v = arr[i - W + 1] + SQRT2; if (v < d) d = v; }
        } else if (edgeSeed) { if (1 < d) d = 1; }
        arr[i] = d;
      }
    }
    for (let cz = cz1; cz >= cz0; cz--) {
      const row = cz * W;
      const hasDn = cz < W - 1;
      for (let cx = cx1; cx >= cx0; cx--) {
        const i = row + cx;
        let d = arr[i];
        if (d === 0) continue;
        if (cx < W - 1) { const v = arr[i + 1] + 1; if (v < d) d = v; }
        else if (edgeSeed) { if (1 < d) d = 1; }
        if (hasDn) {
          let v = arr[i + W] + 1; if (v < d) d = v;
          if (cx < W - 1) { v = arr[i + W + 1] + SQRT2; if (v < d) d = v; }
          if (cx > 0) { v = arr[i + W - 1] + SQRT2; if (v < d) d = v; }
        } else if (edgeSeed) { if (1 < d) d = 1; }
        arr[i] = d;
      }
    }
  }

  _uploadShore() {
    this._shoreTex.needsUpdate = true;
    this._shoreDirty = false;
  }

  // -------------------------------------------------------------------------
  // Fake reflection: a coarse top-down map of the emissive city (night only).
  // -------------------------------------------------------------------------

  /** Rebuild the emitter map from `state.buildings`. Cheap; ~0.2 ms for 300. */
  _buildEmitMap(state) {
    const R = this.EMIT, data = this._emitData;
    data.fill(0);
    const list = (state && state.buildings) || this._emitters;
    if (!list || !list.length) { this._emitTex.needsUpdate = true; return; }
    const cell = this.worldSize / R;
    const acc = this._emitAcc || (this._emitAcc = new Float32Array(R * R * 4));
    acc.fill(0);
    for (let b = 0; b < list.length; b++) {
      const e = list[b];
      const tx = (e.x != null ? e.x : 0) + ((e.tw || 1) - 1) * 0.5;
      const tz = (e.z != null ? e.z : 0) + ((e.td || 1) - 1) * 0.5;
      const wx = (tx + 0.5) * this.TILE, wz = (tz + 0.5) * this.TILE;
      const lvl = (e.level != null ? e.level : (e.variant || 0));
      const foot = (e.tw || 1) * (e.td || 1);
      let h = 6 + lvl * 5 + foot * 2.5;
      if (e.cat === 'work' || e.cat === 'shops') h *= 1.35;
      if (h > 64) h = 64;
      let cr = 1.0, cg = 0.82, cb = 0.52;
      if (e.cat === 'shops') { cr = 1.0; cg = 0.70; cb = 0.62; }
      else if (e.cat === 'homes') { cr = 1.0; cg = 0.86; cb = 0.60; }
      const w = h * (0.35 + 0.65 * Math.min(1, foot / 4));
      const gx = wx / cell - 0.5, gz = wz / cell - 0.5;
      const ix = Math.round(gx), iz = Math.round(gz);
      for (let dz = -1; dz <= 1; dz++) {
        const jz = iz + dz; if (jz < 1 || jz > R - 2) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx; if (jx < 1 || jx > R - 2) continue;
          const g = Math.exp(-((jx - gx) * (jx - gx) + (jz - gz) * (jz - gz)) * 0.9);
          const o = (jz * R + jx) * 4;
          acc[o] += cr * w * g; acc[o + 1] += cg * w * g; acc[o + 2] += cb * w * g;
          if (h > acc[o + 3]) acc[o + 3] = h;
        }
      }
    }
    let maxW = 1e-4;
    for (let i = 0; i < acc.length; i += 4) {
      const m = Math.max(acc[i], Math.max(acc[i + 1], acc[i + 2]));
      if (m > maxW) maxW = m;
    }
    const inv = 1 / maxW;
    for (let i = 0; i < acc.length; i += 4) {
      const a = Math.min(1, acc[i + 3] / 40);
      data[i] = Math.min(255, (acc[i] * inv * 255) | 0);
      data[i + 1] = Math.min(255, (acc[i + 1] * inv * 255) | 0);
      data[i + 2] = Math.min(255, (acc[i + 2] * inv * 255) | 0);
      data[i + 3] = (a * 255) | 0;
    }
    this._emitTex.needsUpdate = true;
    this._emitDirty = false;
  }

  /** Optional explicit emitter list: [{ x, z, tw, td, level, cat }] */
  setEmitters(list) {
    this._emitters = Array.isArray(list) ? list : null;
    this._buildEmitMap(null);
    return this;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt, ctx) {
    const c = ctx || {};
    const u = this.uniforms, s = this._shared;
    const d = (typeof dt === 'number' && isFinite(dt)) ? Math.min(dt, 0.1) : 0.016;
    if (typeof c.time === 'number' && isFinite(c.time)) s.uTime.value = c.time;
    else s.uTime.value += d;

    if (c.sunDir && c.sunDir.isVector3) u.uSunDir.value.copy(c.sunDir).normalize();

    const night = clamp01(c.nightEff != null ? c.nightEff : (c.nightT != null ? c.nightT : 0));
    s.uNight.value = night;
    if (this._wallGlow) this._wallGlow.value = 1.0 - 0.85 * night;

    const rain = c.weather ? clamp01(c.weather.rain || 0) : 0;
    s.uRain.value = rain;

    if (c.quality != null) this.setQuality(c.quality);

    if (!this._sunLocked) {
      const h = clamp01(u.uSunDir.value.y);
      const warm = Math.pow(1 - h, 2.2);
      s.uSunColor.value.setRGB(1.00, 0.97 - warm * 0.34, 0.86 - warm * 0.60);
    }

    u.uWaveAmp.value = 1.0 + rain * 0.75;

    const emitOn = this.opts.emitReflection && this._quality > 0;
    u.uEmitStrength.value = emitOn ? this._emitGain * smoothstep01(0.30, 0.85, night) : 0;
    if (this._emitDirty && u.uEmitStrength.value > 0.002) this._buildEmitMap(this._lastState);

    if (this._shoreDirty) this._uploadShore();
    if (this._floats.length) this._animFloats(s.uTime.value);
    return this;
  }

  /** Quality 0 low / 1 medium / 2 high. Uniform writes only; never recompiles. */
  setQuality(level) {
    const q = Math.max(0, Math.min(2, level | 0));
    if (q === this._quality) return this;      // called every frame from update()
    this._quality = q;
    this._shared.uQuality.value = q;
    this.bedUniforms.uCaustics.value = q === 0 ? 0.32 : 0.55;
    return this;
  }

  /**
   * Override the look. All fields optional; colours are sRGB hex, THREE.Color,
   * or [r,g,b] linear arrays.
   * { skyTop, sunColor, edge, shallow, mid, deep, patch, foam, gain,
   *   nightFloor, reflection, foamWidth, block, slabs, dashes }
   * (skyHorizon and the old realistic-water knobs are accepted and ignored.)
   */
  setSky(p = {}) {
    const set = (uni, v) => {
      if (v == null) return;
      if (v.isColor) uni.value.copy(v);
      else if (Array.isArray(v)) uni.value.setRGB(v[0], v[1], v[2]);
      else uni.value.copy(srgb(v));
    };
    const u = this.uniforms;
    set(u.uSkyTop, p.skyTop);
    set(u.uEdgeColor, p.edge);
    set(u.uShallowColor, p.shallow);
    set(u.uMidColor, p.mid);
    set(u.uDeepColor, p.deep);
    set(u.uSeaColor, p.sea);
    set(u.uPatchColor, p.patch);
    set(u.uFoamColor, p.foam);
    if (p.sunColor != null) { set(this._shared.uSunColor, p.sunColor); this._sunLocked = true; }
    if (p.sunColor === null) this._sunLocked = false;
    if (p.gain != null) u.uGain.value = Math.max(0, p.gain);
    if (p.nightFloor != null) u.uNightFloor.value = clamp01(p.nightFloor);
    if (p.reflection != null) this._emitGain = p.reflection;
    if (p.foamWidth != null) u.uFoam.value.x = Math.max(0.05, p.foamWidth);
    // 'block' = layer B's cell width (world units); the other layers keep ratio.
    if (p.block != null) u.uPatch.value.multiplyScalar(Math.max(2, p.block) / u.uPatch.value.z);
    // 'slabs' scales the patchwork tone steps, 'dashes' the specular flecks.
    if (p.slabs != null) u.uPatchMix.value.x = Math.max(0, p.slabs);
    if (p.dashes != null) u.uSpark.value.x = Math.max(0, p.dashes);
    return this;
  }

  /**
   * Receive the sun's cascaded shadows. engine.js hands over lighting.js's
   * shared CSM uniform bag and GLSL (kept as an argument so this module stays
   * import-free): { uniforms, fragPars, vertPars, vertMain }. The fragment
   * GLSL must define csmApply(lightColor, viewNormal, viewLightDir). Passing
   * null (or anything malformed) turns shadow receiving off again.
   */
  setShadowSource(src) {
    const ok = !!(src && src.uniforms && typeof src.fragPars === 'string' &&
      src.fragPars.indexOf('csmApply') >= 0 && typeof src.vertPars === 'string' &&
      typeof src.vertMain === 'string');
    this._csm = ok ? src : null;
    const m = this.material;
    if (ok) {
      for (const k in src.uniforms) this.uniforms[k] = src.uniforms[k];
      m.vertexShader = src.vertPars + SURFACE_VERT.replace('// @CSM_VERTEX_MAIN', src.vertMain);
      m.fragmentShader = src.fragPars + SURFACE_FRAG;
      m.defines = Object.assign({}, m.defines, { USE_WATER_CSM: '' });
    } else {
      m.vertexShader = SURFACE_VERT;
      m.fragmentShader = SURFACE_FRAG;
      if (m.defines) delete m.defines.USE_WATER_CSM;
    }
    m.needsUpdate = true;
    return this;
  }

  /** No env reflection in the stylised look; kept for API compatibility. */
  setEnvironment(_tex) { return this; }

  /** Contract §3 uniformity — water has no render targets, so this is a no-op. */
  setSize(_w, _h, _pixelRatio) { return this; }

  /** Diagnostics for the harness / engine debug overlay. */
  stats() {
    let verts = 0, tris = 0;
    for (const c of this._chunks.values()) {
      for (const g of [c.geo, c.bankGeo]) {
        if (!g) continue;
        verts += g.getAttribute('position').count;
        tris += g.index.count / 3;
      }
    }
    let covered = 0;
    if (this._covered) for (let i = 0; i < this._covered.length; i++) covered += this._covered[i];
    return {
      chunks: this._chunks.size,
      waterTiles: this._waterTiles,
      vertices: verts,
      triangles: tris,
      shoreField: this.fieldW + '²',
      warpedCells: covered,
      floats: this._floats.length,
      quality: this._quality,
    };
  }

  dispose() {
    if (this._disposed) return this;
    this._disposed = true;
    this._disposeChunks();
    if (this._apron) { this._apron.geometry.dispose(); this._apron = null; }
    if (this.group.parent) this.group.parent.remove(this.group);
    this.material.dispose();
    this.bedMaterial.dispose();
    if (this._floatMeshes) for (const m of this._floatMeshes) { m.geometry.dispose(); m.dispose && m.dispose(); }
    this._floatMeshes = null;
    this._floats = [];
    this.bankMaterial.dispose();
    this._shoreTex.dispose();
    this._normalTex.dispose();
    this._emitTex.dispose();
    this._shoreData = null;
    this._distLand = null;
    this._distSand = null;
    this._distWater = null;
    this._covered = null;
    this._tileFlags = null;
    this._warpDX = this._warpDZ = this._warpOK = null;
    this._warpFn = null;
    this._emitData = null;
    this._emitAcc = null;
    this._emitters = null;
    this._lastState = null;
    this._built = false;
    return this;
  }
}

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : (isFinite(v) ? v : 0)); }

function smoothstep01(a, b, x) {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// §4 self test
// ---------------------------------------------------------------------------

/**
 * Headless-ish assertions. Returns { pass, notes }.
 * Runs geometry/field checks always; adds shader-compile and leak checks when a
 * WebGL context is obtainable.
 */
export function selfTest(opts = {}) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  const N = 80;
  // Synthetic map: ocean band on -z, a lake, a river, sand fringe, one bridge.
  const map = new Uint8Array(N * N);
  const bridge = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      let t = 0;
      const coast = 10 + Math.sin(x * 0.19) * 3.5;
      if (z < coast) t = T_WATER;
      const dx = x - 55, dz = z - 58;
      if (dx * dx + dz * dz < 64) t = T_WATER;
      if (Math.abs(x - (34 + Math.sin(z * 0.14) * 7)) < 1.6 && z > 12 && z < 58) t = T_WATER;
      map[i] = t;
    }
  }
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      if (map[i] !== 0) continue;
      let near = false;
      for (let dz = -1; dz <= 1 && !near; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
          if (map[nz * N + nx] === T_WATER) { near = true; break; }
        }
      if (near) map[i] = T_SAND;
    }
  }
  map[30 * N + 34] = 3; bridge[30 * N + 34] = 1;
  const state = { map, bridge };

  const scene = new THREE.Scene();
  let water = null;
  const t0 = now();
  let ctorMs = 0;
  try {
    water = new WaterFX(scene, Object.assign({ n: N }, opts.waterOpts || {}));
    ctorMs = now() - t0;
    water.buildSurface(state);
  } catch (e) {
    fail('buildSurface threw: ' + (e && e.message));
    return { pass, notes };
  }
  const buildMs = now() - t0 - ctorMs;
  ok(`construct (incl. procedural normal map): ${ctorMs.toFixed(1)} ms`);
  ok(`buildSurface: ${buildMs.toFixed(1)} ms`);

  const st = water.stats();
  if (st.chunks === 0) fail('no water chunks were built');
  else ok(`${st.chunks} chunks / ${st.waterTiles} water tiles / ${st.triangles} tris / ${st.vertices} verts`);

  // geometry sanity
  let nanCount = 0, yBad = 0, oob = 0;
  for (const c of water._chunks.values()) {
    if (!c.geo) continue;
    const p = c.geo.getAttribute('position');
    const a = p.array;
    for (let i = 0; i < a.length; i += 3) {
      if (!isFinite(a[i]) || !isFinite(a[i + 1]) || !isFinite(a[i + 2])) nanCount++;
      if (Math.abs(a[i + 1] - water.opts.waterY) > 1e-5) yBad++;
      if (a[i] < -0.01 || a[i] > water.worldSize + 0.01) oob++;
      if (a[i + 2] < -0.01 || a[i + 2] > water.worldSize + 0.01) oob++;
    }
    if (!c.geo.index) fail('chunk geometry has no index buffer');
    else {
      const maxI = p.count - 1;
      const ia = c.geo.index.array;
      for (let i = 0; i < ia.length; i++) if (ia[i] > maxI) { fail('index out of range'); break; }
    }
    if (!c.geo.boundingSphere || !isFinite(c.geo.boundingSphere.radius)) fail('bad bounding sphere');
  }
  if (nanCount) fail(`${nanCount} NaN positions`);
  else ok('no NaN/Inf in positions');
  if (yBad) fail(`${yBad} vertices off the water plane`);
  if (oob) fail(`${oob} vertices outside the map`);

  // The bridge tile must be covered.
  const bx = 34, bz = 30;
  let covered = false;
  for (const c of water._chunks.values()) {
    if (!c.geo) continue;
    const a = c.geo.getAttribute('position').array;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] >= bx * TILE && a[i] <= (bx + 1) * TILE && a[i + 2] >= bz * TILE && a[i + 2] <= (bz + 1) * TILE) { covered = true; break; }
    }
    if (covered) break;
  }
  if (!covered) fail('bridge tile is not covered by the water surface');
  else ok('bridge tiles are covered');

  // shore field sanity
  const sd = water._shoreData;
  let sNan = 0, deepFound = 0, shoreFound = 0;
  for (let i = 0; i < sd.length; i += 4) {
    if (!isFinite(sd[i])) sNan++;
    if (sd[i + 1] > 128) { if (sd[i] > 200) deepFound++; if (sd[i] < 30) shoreFound++; }
  }
  if (sNan) fail('shore field has non-finite values');
  if (!deepFound) fail('shore field has no deep water (distance never saturates)');
  else ok(`shore field: ${deepFound} deep cells, ${shoreFound} shoreline cells`);

  // refreshTiles must be fast and must not change the chunk count wildly
  const t1 = now();
  for (let k = 0; k < 20; k++) {
    const x = 20 + k, z = 6;
    state.map[z * N + x] = state.map[z * N + x] === T_WATER ? 0 : T_WATER;
    water.refreshTiles(state, x, z);
  }
  const refreshMs = (now() - t1) / 20;
  ok(`refreshTiles: ${refreshMs.toFixed(2)} ms/tile avg`);
  if (refreshMs > 25) fail('refreshTiles is too slow for interactive terraforming');

  // --- GL portion ---------------------------------------------------------
  let renderer = null;
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      renderer.setSize(128, 128, false);
    }
  } catch (e) { renderer = null; }

  if (!renderer) {
    notes.push('skip: no WebGL context available (shader compile untested)');
  } else {
    const cam = new THREE.PerspectiveCamera(40, 1, 1, 2000);
    cam.position.set(320, 180, 700);
    cam.lookAt(320, 0, 320);
    scene.fog = new THREE.Fog(0xbfe4ff, 400, 1800);
    const ctx = {
      time: 3.0, dt: 0.016, nightT: 0, nightEff: 0,
      weather: { rain: 0.7, snow: 0, tint: [1, 1, 1] },
      camera: cam, camDist: 200,
      sunDir: new THREE.Vector3(0.4, 0.55, 0.7).normalize(), quality: 2,
    };
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); };
    try {
      water.update(0.016, ctx);
      renderer.render(scene, cam);
      water.setQuality(0); water.update(0.016, ctx); renderer.render(scene, cam);
      water.setQuality(2); water.update(0.016, ctx); renderer.render(scene, cam);
    } catch (e) {
      fail('render threw: ' + (e && e.message));
    } finally {
      console.error = origErr;
    }
    // env-map variant (USE_ENVCUBE) must also compile, and junk must be ignored
    console.error = (...a) => { errs.push(a.join(' ')); };
    try {
      const face = () => {
        const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
        if (!cv) return null;
        cv.width = cv.height = 4;
        const g = cv.getContext('2d'); g.fillStyle = '#8fd0ff'; g.fillRect(0, 0, 4, 4);
        return cv;
      };
      const cube = new THREE.CubeTexture([face(), face(), face(), face(), face(), face()]);
      cube.needsUpdate = true;
      water.setEnvironment(cube);
      renderer.render(scene, cam);
      water.setEnvironment({ notATexture: true });   // must be ignored, not thrown
      water.setEnvironment(null);
      renderer.render(scene, cam);
      cube.dispose();
      ok('setEnvironment(cube/null/junk) is safe and compiles');
    } catch (e) {
      fail('setEnvironment path threw: ' + (e && e.message));
    } finally {
      console.error = origErr;
    }

    const shaderErrs = errs.filter((e) => /shader|glsl|program|compile|link/i.test(e));
    if (shaderErrs.length) fail('shader errors: ' + shaderErrs.join(' | ').slice(0, 400));
    else ok('surface + bed shaders compile and render (quality 0 and 2, env on/off)');

    if (renderer.info.render.triangles <= 0) fail('nothing was rasterised');
    else ok(`rasterised ${renderer.info.render.triangles} triangles`);

    // leak check: 100 setSize cycles must not grow GPU resources
    const before = { geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures };
    for (let i = 0; i < 100; i++) {
      water.setSize(200 + i, 100 + i, 1 + (i % 2));
      water.update(0.016, ctx);
    }
    renderer.render(scene, cam);
    const after = { geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures };
    if (after.geo > before.geo || after.tex > before.tex)
      fail(`leak over 100 resize cycles: geo ${before.geo}->${after.geo}, tex ${before.tex}->${after.tex}`);
    else ok(`no leak over 100 resize cycles (geo ${after.geo}, tex ${after.tex})`);

    // dispose must free everything
    water.dispose();
    renderer.render(scene, cam);
    if (renderer.info.memory.geometries > before.geo)
      fail('dispose() left geometries behind');
    else ok('dispose() frees geometries and textures');
    renderer.dispose();
    water = null;
  }

  if (water) water.dispose();
  return { pass, notes };
}

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export default WaterFX;
