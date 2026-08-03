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
  grassDeep: 0x4d7d2c,   // shaded turf, hue ~97
  grassMid:  0x82c043,   // the "average lawn", hue ~93
  grassLit:  0xacd160,   // sunlit yellow-green highlight patches, hue ~85
  grassRich: 0x599b36,   // lush region: deeper + greener, hue ~100
  grassDry:  0xacbc5e,   // sun-bleached straw region, hue ~71
  worn:      0x8f7d5e,   // trampled bare earth (wear patches / kerbs)
  pebble:    0x9d968a,   // small stone / gravel breakup
  seaFar:    0x2f7cc4,   // off-map open water (water.js stops at the map edge)
  sand:      0xf7dd8f,   // warm golden beach sand
  // Damp sand at the waterline. Real wet sand is ~65-75 % of the dry albedo,
  // not 35 %: the old 0x8a7247 was so dark that the vertical bank face (which
  // is authored fully wet at its foot, gets no sky-bounce term and carries the
  // contact AO) rendered as a literal black wall with a hard outline against
  // the lit water. Keep the darkening, lose the silhouette.
  sandWet:   0xb2986a,
  dirt:      0x8a7355,   // gravel / road sub-base
  rockA:     0xb9b3a6,   // warm granite
  rockB:     0x615c55,   // shadowed rock
  rockC:     0xc4986a,   // warm strata band
  scree:     0xb3a794,
  snow:      0xfbfdff,
};

function lin(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

const VS_HEAD = /* glsl */`
attribute vec4 aTerr;   // (grass, sand, dirt, rock) blend weights
attribute vec4 aMask;   // (ao, wet, snow, scree)
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec4 vTerr;
varying vec4 vMask;
`;

const VS_BODY = /* glsl */`
  vTerr = aTerr;
  vMask = aMask;
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
uniform vec3 uWorn, uPebble, uSeaFar;
uniform vec3 uSand, uSandWet, uDirt;
uniform vec3 uRockA, uRockB, uRockC, uScree, uSnow;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec4 vTerr;
varying vec4 vMask;

vec3 thAlbedo;
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
  float camD = distance( vWPos, uCamPos );
  // Detail contrast is NOT collapsed with distance any more. The mip chain
  // already averages the detail textures toward their mean as they shrink, so
  // the term self-flattens for free AND without aliasing; the old
  // mix(1.0, 0.22, smoothstep(70,300)) additionally threw the contrast away at
  // hero range, where the turf is supposed to read.
  float fade = uDetailAmt;
  // The perturbed normal is the one term that genuinely sparkles at extreme
  // zoom-out (it swings the specular lobe, which the mip average cannot damp),
  // so it keeps a mild distance falloff.
  float nFade = uDetailAmt * mix( 1.0, 0.55, smoothstep( 150.0, 360.0, camD ) );

  // ---- macro fields --------------------------------------------------------
  // Three scales off one 128^2 four-channel noise texture:
  //   macP ~80 world units  - patch structure (8 patches across a 640 map)
  //   macR ~270 world units - regional hue drift, so the map is not one green
  //   macF ~24 world units  - wear / gravel breakup
  // The old single 294-unit sample gave TWO tiles over the whole map: a
  // gradient, not patches.
  vec4 macP = texture2D( uMacro,  vWPos.xz * 0.0125 );
  vec4 macR = texture2D( uMacro,  vWPos.xz * 0.0037 + vec2( 0.37, 0.61 ) );
  vec4 macF = texture2D( uMacro,  vWPos.xz * 0.0420 + vec2( 0.71, 0.23 ) );
  vec4 det  = texture2D( uDetail, vWPos.xz * 0.0850 );
  vec4 det2 = texture2D( uDetail, vWPos.xz * 0.0225 + vec2( 0.13, 0.77 ) );

  // ---- rock (triplanar-lite: our mountain faces are axis aligned) ----------
  vec3 an = abs( wn );
  vec2 ruv = ( an.y > 0.5 ) ? vWPos.xz : ( ( an.x > 0.5 ) ? vWPos.zy : vWPos.xy );
  vec4 rk  = texture2D( uRock, ruv * 0.105 );
  vec4 rk2 = texture2D( uRock, ruv * 0.031 + vec2( 0.41, 0.19 ) );
  float rmot = mix( rk.r, rk2.r, 0.5 );
  // Strata: a function of world Y only, so bands line up across every face.
  float warp = ( macR.b - 0.5 ) * 1.9 + ( rk2.r - 0.5 ) * 0.9;
  float band = fract( vWPos.y * 0.38 + warp );
  float bandT = smoothstep( 0.02, 0.30, band ) * ( 1.0 - smoothstep( 0.48, 0.82, band ) );
  vec3 rock = mix( uRockB, uRockA, rmot );
  rock = mix( rock, uRockC, bandT * mix( 0.22, 0.62, macP.a ) );
  rock *= 0.78 + 0.40 * mix( 0.5, rk.g, max( fade, 0.45 ) );   // fracture darkening
  rock = mix( rock, uScree * ( 0.82 + 0.36 * rmot ), clamp( vMask.w, 0.0, 1.0 ) * 0.85 );

  // ---- grass --------------------------------------------------------------
  float turf = mix( 0.5, mix( det.r, det2.r, 0.42 ), fade );
  // Regional species drift first (lowest frequency), then patches, then blades.
  vec3 grass = mix( uGrassDeep, uGrassMid, smoothstep( 0.20, 0.80, macP.r ) );
  grass = mix( grass, uGrassRich, smoothstep( 0.44, 0.94, macR.r ) * 0.58 );
  grass = mix( grass, uGrassDry,  smoothstep( 0.52, 0.96, macR.g ) * 0.40 );
  grass = mix( grass, uGrassLit,  smoothstep( 0.54, 0.96, macP.g ) * 0.50 );
  // Fine turf contrast. Pulled back from +-31% to +-20%: this is a WORLD-space
  // sample, so at a grazing angle it is exactly the term the mip chain smears
  // along one screen axis, and it was large enough to dominate the residual's
  // autocorrelation on its own. The high-frequency budget it gives up is paid
  // back — isotropically — by the screen-locked micro layer below.
  grass *= 0.80 + 0.40 * turf;
  // A coarser luminance breakup that SURVIVES the mip chain at region zoom,
  // so the ground still has structure when the fine turf has averaged out.
  grass *= 0.83 + 0.34 * macP.b;
  // dry yellow-green patches
  grass = mix( grass, grass * vec3( 1.09, 1.02, 0.80 ), smoothstep( 0.58, 0.96, macP.a ) * 0.38 );

  // ---- BIOME MASK ---------------------------------------------------------
  // ~70 % of the region frame used to be one untextured green. macP (80 u) and
  // macR (270 u) above only ever RECOLOUR that green; what was missing is
  // REGIONS — stretches of ground that are a different KIND of surface, with
  // their own albedo AND roughness and a boundary you can actually see.
  //
  // This is a domain-warped low-frequency field: ~190-unit regions (so a
  // 640-unit map carries 3-4 of them per axis), displaced by up to +-160 units
  // by a second field so the borders meander instead of reading as texture
  // tiles. Four overlapping biomes, then hedgerow-style field boundaries drawn
  // on the CONTOUR of the field and worn desire paths from ridged noise.
  //
  // Deliberately plausible under scattered vegetation: props.js is dropping
  // instanced trees on top of this, and the woodland biome is exactly where
  // they should look at home (leaf litter, thin turf, no lawn stripes).
  vec2 bWarp = ( vec2( macR.b, macR.a ) - 0.5 ) * 160.0;
  vec4 bio  = texture2D( uMacro, ( vWPos.xz + bWarp ) * 0.0052 + vec2( 0.19, 0.83 ) );
  vec4 bio2 = texture2D( uMacro, ( vWPos.xz + bWarp * 0.42 ) * 0.0128 + vec2( 0.61, 0.07 ) );
  float bMeadow = smoothstep( 0.44, 0.76, bio.r );
  float bHeath  = smoothstep( 0.55, 0.85, bio.g * 0.72 + bio2.a * 0.28 );
  float bWood   = smoothstep( 0.57, 0.87, bio.b * 0.70 + bio2.g * 0.30 );
  float bStone  = smoothstep( 0.72, 0.95, bio.a * 0.62 + bio2.r * 0.38 );
  // Resolve overlaps so two biomes never average into a fifth mud colour.
  bHeath  *= 1.0 - bStone * 0.75;
  bWood   *= 1.0 - bStone * 0.85;
  bMeadow *= ( 1.0 - bHeath ) * ( 1.0 - bWood ) * ( 1.0 - bStone );
  // One knob for the whole mask: 0 restores the single-green meadow, and it is
  // what the hero-chroma A/B is measured against. The mask also fades out over
  // exactly the window the horizon lift fades IN: past fogT 0.55 the ground is
  // supposed to be converging on the sky's radiance, and the woodland biome
  // landing on the horizon skirt measured 0.09 off the land/sky ratio for
  // detail the haze had already swallowed.
  float bW = uBiome * ( 1.0 - smoothstep( uHorizonRamp.x, uHorizonRamp.y, thFogT ) );
  bMeadow *= bW; bHeath *= bW; bWood *= bW; bStone *= bW;

  // lush pasture: greener and a touch deeper
  grass = mix( grass, mix( grass, uGrassRich, 0.52 ) * 1.03, bMeadow * 0.70 );
  // dry heath / rough grazing: straw, patchier
  grass = mix( grass, mix( grass, uGrassDry, 0.60 ) * ( 0.93 + 0.18 * turf ), bHeath * 0.92 );
  // woodland floor: darker, browner, leaf-litter mottle
  vec3 bLitter = mix( uGrassDeep, uWorn, 0.44 ) * ( 0.82 + 0.40 * mix( det.r, macF.a, 0.5 ) );
  grass = mix( grass, bLitter, bWood * 0.78 );
  // stony outcrop: thin turf over rock, with the rock texture showing through
  vec3 bStony = mix( uPebble, uRockA, 0.45 ) * ( 0.72 + 0.50 * rmot );
  bStony = mix( bStony, grass * 0.92, smoothstep( 0.52, 0.94, det2.r ) * 0.38 );
  grass = mix( grass, bStony, bStone * 0.86 );

  // Field boundaries: the CONTOUR of the biome field, widened to stay at least
  // ~a pixel wide (same reasoning as thEdge) so it never crawls at region zoom.
  // Reads as a hedgerow / unmown verge separating two fields.
  float bHW = max( 0.030, TH_FW( bio.r ) * 1.6 );
  float bHedge = ( 1.0 - smoothstep( 0.0, bHW, abs( bio.r - 0.44 ) ) ) * ( 1.0 - bStone );
  grass = mix( grass, mix( uGrassDeep, uWorn, 0.24 ) * 0.84, bHedge * 0.55 );
  // Desire paths: ridged noise gives a CONNECTED network of thin worn lines
  // rather than the rash of dots a thresholded fbm would give.
  float bPN = 1.0 - abs( 2.0 * macP.b - 1.0 );
  float bPW = max( 0.020, TH_FW( bPN ) * 1.6 );
  float bPath = smoothstep( 0.955 - bPW, 0.955 + bPW, bPN ) * ( 1.0 - bWood * 0.5 );
  grass = mix( grass, uWorn * ( 0.86 + 0.34 * turf ), bPath * 0.70 );

  // ---- ground variety: wear, kerb scuffing, pebbles -----------------------
  // Bare-earth patches where the turf has been walked off.
  float wearN = macF.a * 0.42 + macP.a * 0.34 + det2.g * 0.24;
  float wear = smoothstep( 0.64, 0.90, wearN );
  // vTerr.z (the dirt/road blend weight) is only non-zero within one tile of a
  // road, so it IS "how close am I to the kerb" — free, no new attribute.
  float kerb = smoothstep( 0.03, 0.34, vTerr.z ) * ( 1.0 - smoothstep( 0.45, 0.86, vTerr.z ) );
  wear = clamp( wear + kerb * ( 0.30 + 0.55 * macF.b ), 0.0, 1.0 );
  vec3 wornC = uWorn * ( 0.78 + 0.44 * turf );
  grass = mix( grass, wornC, wear * 0.62 );
  // Darker, compacted ground right at the kerb line.
  grass *= 1.0 - kerb * 0.16;
  // Occasional pebble / gravel scatter (rock texture at ground scale gives
  // ~1-unit stones; macF gates them into clusters instead of a uniform rash).
  float peb = smoothstep( 0.70, 0.92, rk.r ) *
              max( smoothstep( 0.46, 0.80, macF.r ), bStone * 0.9 );
  grass = mix( grass, uPebble * ( 0.74 + 0.52 * rk.r ), peb * 0.50 * fade );

  // ---- sand (+ wet beach band) -------------------------------------------
  float wet = clamp( vMask.y, 0.0, 1.0 );
  float wetN = clamp( wet * wet + ( det2.r - 0.5 ) * 0.22, 0.0, 1.0 );
  vec3 sand = mix( uSand * 0.92, uSand * 1.08, mix( 0.5, det.r, fade ) );
  sand = mix( sand, sand * vec3( 1.05, 0.98, 0.86 ), smoothstep( 0.5, 1.0, macR.a ) * 0.5 );
  sand = mix( sand, uSandWet, thEdge( wetN, 0.0, 0.46, 0.32 ) );

  // ---- dirt / road sub-base ----------------------------------------------
  vec3 dirt = mix( uDirt * 0.82, uDirt * 1.18, mix( 0.5, det.r, fade ) );

  // ---- composite with noise-eroded (organic) borders ----------------------
  float nzS = mix( 0.5, det2.g, fade );
  float nzD = mix( 0.5, macP.b, fade );
  float wS = thEdge( vTerr.y, ( nzS - 0.5 ) * 0.50, 0.50, 0.22 );
  float wD = thEdge( vTerr.z, ( nzD - 0.5 ) * 0.38, 0.50, 0.20 );
  float wR = clamp( vTerr.w, 0.0, 1.0 );

  vec3 alb = grass;
  alb = mix( alb, sand, wS );
  alb = mix( alb, dirt, wD );
  alb = mix( alb, rock, wR );

  // ---- snow: baked alpine mask + weather accumulation on up-facing only ---
  float sBase = clamp( vMask.z, 0.0, 1.0 ) + uSnowCover * clamp( wn.y, 0.0, 1.0 );
  // The noisy edge only exists where snow already wants to be — otherwise the
  // noise alone would sprinkle white patches over the meadow.
  float sNoise = smoothstep( 0.0, 0.18, sBase ) * (
                  ( det2.g - 0.5 ) * 0.40
                + ( macP.a - 0.5 ) * 0.52
                + ( macR.b - 0.5 ) * 0.26
                + ( mix( 0.5, det.r, fade ) - 0.5 ) * 0.20 );
  float snowAmt = thEdge( sBase, sNoise, 0.47, 0.19 );
  // Snow is not flat white: drifted shading + a cool tint in the hollows.
  float drift = mix( 0.5, det2.r * 0.6 + macP.g * 0.4, fade );
  vec3 snowC = uSnow * ( 0.82 + 0.26 * drift );
  snowC *= mix( vec3( 0.80, 0.86, 1.02 ), vec3( 1.0 ), clamp( vMask.x, 0.0, 1.0 ) );
  alb = mix( alb, snowC, snowAmt );

  // ---- off-map open sea ---------------------------------------------------
  // water.js only builds a surface over the 640x640 tile map, so where the map
  // border IS ocean the horizon skirt has to read as open water by itself —
  // otherwise the sea ends in a brown mud flat one tile past the border.
  // vMask.y > 1 is the flag; every other consumer clamps it to 0..1.
  float sea = clamp( vMask.y - 1.0, 0.0, 1.0 );
  alb = mix( alb, uSeaFar * ( 0.86 + 0.30 * det2.r ), sea );

  // ---- screen-locked micro detail -----------------------------------------
  // Everything above is sampled in WORLD space, and on a ground plane seen at
  // a grazing angle the mip chain eats world-space detail ANISOTROPICALLY: the
  // texel footprint is long along the view direction and short across it, so
  // what survives is smeared along one screen axis and gone along the other.
  // Measured on the hero meadow before this block: autocorrelation
  // x = 0.69 / 0.37 / 0.17 against y = 0.27 / -0.15 / -0.21. No choice of
  // world-space frequency can fix that, because the cause is the projection,
  // not the texture — and it is why the turf reads as "out-of-focus green
  // paint" at zoom and the horizon skirt reads as camo blobs.
  //
  // Fix: sample the same texture at a scale LOCKED TO THE PIXEL FOOTPRINT, so
  // a feature is a fixed number of SCREEN pixels across at every distance. A
  // pixel is isotropic, so the residual is too, and the mip chain can never
  // average it away. Two octaves — ~2.5 px (the missing high frequency) and
  // ~9 px (the missing mid frequency the skirt has none of).
  //
  // The scale is quantised to a power of two and cross-faded on the fraction,
  // so the pattern does not visibly breathe while orbiting; the LOD is passed
  // explicitly because the quantisation step would otherwise spike fwidth() on
  // one row of pixels and blur it out.
  float thFine = 0.0;
  float thDbg = 0.0;
  if ( abs( uFine.x ) + abs( uFine.y ) > 0.0 ) {
#if __VERSION__ >= 300
    // The pixel footprint on a ground plane is an ELLIPSE, not a circle: at a
    // grazing angle one screen axis covers many more world units than the
    // other. The first version of this block took ONE scalar,
    // max(fwidth(x), fwidth(z)), so the pattern stayed isotropic in WORLD space
    // and therefore landed on screen stretched by exactly the projection's
    // aspect ratio. That is why the hero patch measured ACF y/x 1.00 (a
    // near-vertical view, aspect ~1) while the distant skirt — the same code,
    // seen at ~10 degrees — measured 0.76.
    //
    // Fix: give world X and world Z their OWN footprints and correct the
    // aspect between them. fxp / fzp are world units per pixel along each
    // world axis (the larger of the two screen derivatives, so the stretched
    // screen direction wins); sG is their geometric mean and rq is the aspect.
    //
    // CRITICAL — rq and the scale ladder are both QUANTISED TO POWERS OF TWO,
    // i.e. piecewise CONSTANT. That is not a performance shortcut, it is the
    // whole thing working at all: the sample coordinate is an ABSOLUTE world
    // position, so a continuously varying scale s(x) contributes a spurious
    // gradient of |pos| * ds/dpixel on top of the gradient we want. At 400
    // units out that term measured ~2.4x the wanted one and it lands entirely
    // on the depth axis. Two continuous versions of this correction were built
    // and measured before this one — an orthogonal frame from dFdx, and an
    // exact SVD frame of the footprint ellipse (which is isotropic on paper) —
    // and both made the skirt WORSE, taking ACF y/x from 0.45 to 0.25 and to
    // -0.02 respectively. Piecewise-constant scales have zero spurious
    // gradient, so the correction lands where the algebra says it should.
    //
    // The overall scale still cross-fades on the fraction of its own ladder
    // (fr is a blend WEIGHT, not a coordinate, so it may vary continuously),
    // which is what stops the pattern breathing while orbiting.
    float fxp = max( fwidth( vWPos.x ), 1e-5 );
    float fzp = max( fwidth( vWPos.z ), 1e-5 );
    // The overall scale stays at max() near the camera — exactly as before, so
    // the hero patch is untouched (using the geometric mean there made the
    // pattern ~2x finer for 20 % more residual and a WORSE ratio) — and eases
    // onto the geometric mean at distance, where the isotropic-equivalent
    // footprint is what the aspect correction below is derived against.
    float sG = max( fxp, fzp );
    // ...and it is ramped in with distance. At hero range the footprint is
    // already near-circular and the shipped world-isotropic path measures
    // ACF y/x 1.00 there, so the correction has nothing to win and a power-of-
    // two step to lose (measured: -7.6 % on the hero ratio when applied flat).
    // rqW = 0 collapses rq to exactly 1, i.e. bit-identical to the old path.
    float rqW = smoothstep( 190.0, 430.0, camD );
    sG = mix( sG, sqrt( fxp * fzp ), rqW );
    float rq = exp2( floor( 0.5 * log2( fxp / fzp ) * rqW + 0.5 ) );
    vec2 P = vec2( vWPos.x / rq, vWPos.z * rq );
    // Dev A/B only (uDbg.z): the previous world-isotropic path, so the skirt
    // anisotropy and the haze wash-out can be measured on the same frame.
    if ( uDbg.z > 0.5 ) {
      sG = max( fwidth( vWPos.x ), fwidth( vWPos.z ) );
      P = vWPos.xz;
    }
    float lg = log2( max( sG, 1e-5 ) );
    float fl = floor( lg );
    float fr = lg - fl;
    float s0 = exp2( fl ), s1 = s0 * 2.0;
    vec2 q0 = P / ( s0 * uLock.x );
    vec2 q1 = P / ( s1 * uLock.x );
    float micro = mix( textureLod( uDetail, q0, uLock.y ).r,
                       textureLod( uDetail, q1, uLock.y ).r, fr );
    float k = uLock.x / uLock.z;
    float meso = mix( textureLod( uDetail, q0 * k, uLock.w ).g,
                      textureLod( uDetail, q1 * k, uLock.w ).g, fr );
    // A third octave between the other two. The .r lattice is 16 cells per
    // period, so micro (40 px) lands on ~2.5 px features and this one
    // (~160 px) on ~10 px — the band the distant skirt had nothing in at all,
    // which is why it read as smooth camo blobs rather than ground.
    float kc = uLock.x / max( uFineK.x, 1.0 );
    float coarse = mix( textureLod( uDetail, q0 * kc, uFineK.y ).r,
                        textureLod( uDetail, q1 * kc, uFineK.y ).r, fr );
    float thLeg = step( uDbg.z, 0.5 );      // 1 = current, 0 = legacy A/B
    // The coarse octave exists for the DISTANT ground, so it is ramped in on
    // the fog factor. At the hero pose that is ~0.08, i.e. off: measured, a
    // flat coarse amplitude cost the hero patch ACF y/x 0.631 -> 0.603 for
    // detail it does not need, while the skirt gains the whole of it.
    float thCoarse = uFineK.z * smoothstep( 0.04, 0.30, thFogT );
    thFine = ( micro - 0.5 ) * uFine.x + ( meso - 0.5 ) * uFine.y
           + ( coarse - 0.5 ) * thCoarse * thLeg;
    // Aerial perspective is a LERP, so it scales EVERY residual the ground has
    // by (1 - fogT). On the far skirt that factor is ~0.1, which is the whole
    // reason the skirt measured 1.9 % residual — effectively untextured — no
    // matter how much detail this block emitted. Pre-divide by the same factor
    // (capped) so high-frequency content survives the haze instead of being
    // erased by it. This cannot alias: the layer is locked to the pixel
    // footprint, so its frequency is fixed in SCREEN space at every distance.
    thFine *= mix( 1.0, min( uFineK.w, 1.0 / max( 0.10, 1.0 - thFogT ) ), thLeg );
    thFine *= uDetailAmt * ( 1.0 - sea );
    thDbg = micro;
#endif
  }
  alb *= 1.0 + thFine;
  // debug hook: uFine.y < 0 paints the raw micro layer (dev only, never shipped
  // with a negative meso amplitude)
  if ( uFine.y < 0.0 ) alb = vec3( thDbg );

  // ---- roughness ----------------------------------------------------------
  float rough = 0.97;
  // Per-biome material response (CONTRACTS-RENDER.md §5: "materials that respond
  // to light differently from each other"). Applied to the GRASS base only —
  // the sand / road / rock / snow mixes below still override it.
  rough = mix( rough, 0.90, bHeath * 0.55 );    // dry straw scatters wider
  rough = mix( rough, 0.995, bWood * 0.60 );    // leaf litter is dead matte
  rough = mix( rough, 0.70, bStone * 0.70 );    // exposed rock takes a sheen
  rough = mix( rough, 0.88, bPath * 0.55 );     // compacted bare earth
  rough = mix( rough, mix( 0.92, 0.62, smoothstep( 0.15, 0.85, wetN ) ), wS );
  rough = mix( rough, 0.93, wD );
  rough = mix( rough, 0.84 - 0.14 * rk.g, wR );
  rough = mix( rough, 0.62, snowAmt );
  rough = mix( rough, 0.16, sea );
  rough *= 1.0 - uWetGlobal * 0.35;
  thRough = clamp( rough, 0.10, 1.0 );

  // ---- normal detail ------------------------------------------------------
  // The FINE normal layer (11.8-unit period) is sub-pixel from hero range out,
  // where it stops being turf relief and becomes another anisotropically
  // mip-smeared world-space signal swinging the specular lobe. Keep it at
  // street range, where it is genuinely resolved, and hand the job over to the
  // coarser det2 layer beyond that.
  float nFine = mix( 1.0, 0.25, smoothstep( 55.0, 190.0, camD ) );
  vec2 g = ( det.ba * 2.0 - 1.0 ) * mix( 0.95, 0.45, wS ) * nFine + ( det2.ba * 2.0 - 1.0 ) * 0.35;
  g = mix( g, ( rk.ba * 2.0 - 1.0 ) * 1.65 + ( rk2.ba * 2.0 - 1.0 ) * 0.7, wR );
  g *= nFade * ( 1.0 - snowAmt * 0.55 ) * ( 1.0 - sea * 0.85 );
  vec3 tg = ( abs( wn.y ) > 0.5 ) ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
  vec3 bt = normalize( cross( wn, tg ) );
  tg = cross( bt, wn );
  thNrm = normalize( wn + tg * g.x + bt * g.y );

  // ---- sky bounce ---------------------------------------------------------
  // Open ground under a blue sky is never as saturated as its own pigment:
  // hemispherical bounce lifts the blue channel hard. Without this the ground
  // measured blue at 0.12 of green — i.e. no sky in the scene at all.
  //
  // The weight is the sky's SOLID-ANGLE VISIBILITY, (1 + n.y) / 2, not
  // clamp(n.y). Those agree exactly on flat ground (n.y == 1 -> 1.0, so the
  // measured meadow chroma cannot move), but a vertical face sees half the sky
  // hemisphere and used to get literally none of it — which is the other half
  // of why the shore bank read as a black wall.
  //
  // The exponent then leans it further toward the vertical faces still: those
  // are shore banks and cliff walls, and half of them face away from the sun on
  // any given frame, so the hemisphere fill is literally all the light they
  // get. pow() is chosen because it is EXACTLY 1.0 at n.y == 1 — the measured
  // meadow cannot move no matter what the exponent is.
  alb += uSkyBounce * dot( alb, vec3( 0.299, 0.587, 0.114 ) ) *
         pow( clamp( 0.5 + 0.5 * wn.y, 0.0, 1.0 ), 0.40 );

  // ---- ambient occlusion + grade ------------------------------------------
  // Baked contact AO occludes *ambient* light only. It must NOT be folded into
  // the albedo (albedo multiplies the sun too) and it must NOT be multiplied
  // into reflectedLight.directDiffuse — the real cast shadow already removes
  // the sun there, and doing both darkens the base of every building twice.
  // See the aomap_fragment injection in _makeMaterial().
  float ao = clamp( 1.0 - ( 1.0 - clamp( vMask.x, 0.0, 1.0 ) ) * uAOStrength, 0.0, 1.0 );
  thAO = ao;
  // A whisper of AO in the albedo only — reads as dirt collecting in the
  // crevice, not as a second shadow.
  alb *= mix( 1.0, ao, 0.14 );
  // ---- night grade --------------------------------------------------------
  // Not a luminance multiply. Scotopic vision drops chroma to a fraction and
  // shifts what is left toward blue (Purkinje), so the ground has to
  // DESATURATE and ROTATE, not just darken: the old path kept the green hue
  // and simply scaled it, which is why night grass read as dark green paint.
  // Target ~hue 220 / ~sat 0.35-0.45 in the albedo.
  float lum = dot( alb, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 nAlb = mix( vec3( lum ), alb, uNightChroma ) * uNightTint;
  alb = mix( alb, nAlb, uNight );
  alb *= uTint;
  thAlbedo = clamp( alb, 0.0, 1.6 );
}
`;

// ---------------------------------------------------------------------------

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
    this.aoRadius = 2;                                   // tiles
    this.rugged = (typeof o.rugged === 'number') ? o.rugged : 1;   // mountain jitter
    // Shoreline warp amplitude, in TILES (see _warp). 0 restores the old
    // perfectly rectilinear, grid-locked land/water boundary.
    this.shoreWarp = (typeof o.shoreWarp === 'number') ? o.shoreWarp : 0.90;
    // Swash slope amplitude in world units (see _shoreDip). 0 restores the old
    // vertical bank lip — and the black rim that came with it.
    this.swash = (typeof o.swash === 'number') ? o.swash : SWASH;
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
      uNightChroma: { value: 0.16 },
      // Moon/sky indirect floor so night ground is blue-grey, not literally 0.
      // Measured night meadow: (0, 2.2, 17) sat 1.00 -> (26, 31, 42) sat 0.38
      // hue 223, i.e. a readable moonlit surface at ~30% of the day luminance.
      uNightSky: { value: new THREE.Vector3(0.190, 0.195, 0.225) },
      uGrassDeep: { value: lin(PAL.grassDeep) },
      uGrassMid: { value: lin(PAL.grassMid) },
      uGrassLit: { value: lin(PAL.grassLit) },
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
      dithering: true,
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
        '  reflectedLight.indirectDiffuse += uNightSky * thNightFloor * diffuseColor.rgb * thAOa;'
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

  _computeFields(state) {
    const map = state.map;
    const variant = state.variant;
    const occ = state.occ;
    const cls = this._cls, occH = this._occH;
    for (let i = 0; i < N * N; i++) {
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
      else if (m === T_TREE) h = 5;
      else if (m >= 9 && m <= 14) h = 6;   // park/school/fire/fountain/stadium/power
      occH[i] = h;
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
        const grid = (m === T_ROAD || m === T_MOUNTAIN);
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
      else if (c === C_DIRT) d += ww;
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
    return h > 0 ? h : 4;
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
      return h;
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
    const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._lastBuildMs = t1 - t0;
    return this._lastBuildMs;
  }

  refreshTile(state, x, z) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._computeFields(state);
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
    for (const [ax, az] of list) {
      this._disposeChunk(ax + ',' + az);
      this._buildChunk(state, ax, az);
    }
    // The skirt continues the class of the nearest border tile, so it only has
    // to be rebuilt when a border tile itself changed.
    if (x <= 1 || z <= 1 || x >= N - 2 || z >= N - 2) this._buildSkirt();
    const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    this._lastRefreshMs = t1 - t0;
    return this._lastRefreshMs;
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
    for (const m of [c.ground, c.rock]) {
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
    if (d <= 0) return this.borderY;
    const n = vnoiseW(wx * 0.0030, wz * 0.0030, 5309) * 0.66 +
              vnoiseW(wx * 0.0092, wz * 0.0092, 7717) * 0.34;
    const ramp = Math.min(1, d / 110);
    return this.borderY - d * 0.0045 - ramp * (1.6 + 15 * (1 - n));
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
    else if (c === C_DIRT) a = [0.55, 0.05, 0.40, 0.00];
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
    const T_CLIFF = [0, 0.15, 0.55, 0.30];  // map-border dirt+rock
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

    this._chunks.set(cx + ',' + cz, { ground, rock });
  }

  _buildRock(state, x0t, z0t, x1t, z1t, cx, cz) {
    const pos = [], nrm = [], terr = [], mask = [], idx = [];
    let next = 0;
    const TR = [0, 0, 0, 1];

    let TC = TR;   // active terrain-weight vector for the quad being pushed
    const pushV = (x, y, z, nx, ny, nz, m) => {
      pos.push(x, y, z); nrm.push(nx, ny, nz);
      terr.push(TC[0], TC[1], TC[2], TC[3]);
      mask.push(m[0], m[1], m[2], m[3]);
      return next++;
    };
    const quad = (p, nx, ny, nz, m, t) => {
      TC = t || TR;
      const ia = pushV(p[0], p[1], p[2], nx, ny, nz, m[0]);
      const ib = pushV(p[3], p[4], p[5], nx, ny, nz, m[1]);
      const ic = pushV(p[6], p[7], p[8], nx, ny, nz, m[2]);
      const id = pushV(p[9], p[10], p[11], nx, ny, nz, m[3]);
      idx.push(ia, ib, ic, ia, ic, id);
      TC = TR;
    };

    for (let tz = z0t; tz < z1t; tz++) {
      for (let tx = x0t; tx < x1t; tx++) {
        const ti = tz * N + tx;
        if (state.map[ti] !== T_MOUNTAIN) continue;
        const hv = state.variant ? state.variant[ti] : 0;
        const h = hv > 0 ? hv : 4;
        const wx0 = tx * TILE, wx1 = wx0 + TILE;
        const wz0 = tz * TILE, wz1 = wz0 + TILE;

        // Neighbour surface heights (0 for land, negative for water, taller for rock).
        const nE = this._mtnH(state, tx + 1, tz), nW = this._mtnH(state, tx - 1, tz);
        const nN = this._mtnH(state, tx, tz - 1), nS = this._mtnH(state, tx, tz + 1);
        const base = (nh, ox, oz) => {
          if (nh === null) return this.borderY;
          if (nh > 0) return nh;
          const i2 = (tz + oz) * N + (tx + ox);
          if (this._cls[i2] === C_WATER) return this.seabed ? this._bedY(tx + ox, tz + oz) : WATER_Y;
          return 0;
        };
        const bE = base(nE, 1, 0), bW = base(nW, -1, 0);
        const bN = base(nN, 0, -1), bS = base(nS, 0, 1);
        const lowest = Math.min(bE, bW, bN, bS, 0);

        // Concavity: how many neighbours are taller (drives crevice AO).
        let taller = 0;
        for (const nh of [nE, nW, nN, nS]) if (nh !== null && nh > h) taller++;
        const capAO = 1 - Math.min(0.45, taller * 0.16);

        // ---- top cap (displaced for a rugged silhouette) ------------------
        const d00 = this._disp(wx0, wz0), d01 = this._disp(wx0, wz1);
        const d11 = this._disp(wx1, wz1), d10 = this._disp(wx1, wz0);
        const y00 = h + d00, y01 = h + d01, y11 = h + d11, y10 = h + d10;
        // Face normal from the displaced corners.
        const ax = 0, ay = y01 - y00, az = TILE;      // (A->B)
        const bx = TILE, by = y11 - y00, bz = TILE;   // (A->C)
        let fnx = ay * bz - az * by;
        let fny = az * bx - ax * bz;
        let fnz = ax * by - ay * bx;
        const fl = Math.hypot(fnx, fny, fnz) || 1;
        fnx /= fl; fny /= fl; fnz /= fl;
        if (fny < 0) { fnx = -fnx; fny = -fny; fnz = -fnz; }
        // Low outlying columns keep a grassy/scree top so the range's foot
        // merges into the meadow instead of stopping as a brown plateau.
        const rw = sstep(1.6, 4.8, h);
        const capT = [1 - rw, 0, 0, rw];
        const capScree = sstep(6.0, 2.0, h) * 0.55;
        const capM = [
          [capAO, 0, this._snowAt(wx0, wz0, y00), capScree],
          [capAO, 0, this._snowAt(wx0, wz1, y01), capScree],
          [capAO, 0, this._snowAt(wx1, wz1, y11), capScree],
          [capAO, 0, this._snowAt(wx1, wz0, y10), capScree],
        ];
        quad([wx0, y00, wz0, wx0, y01, wz1, wx1, y11, wz1, wx1, y10, wz0], fnx, fny, fnz, capM, capT);

        // ---- exposed side walls, one quad per voxel level ------------------
        const sideQuad = (dir, L, y0, y1) => {
          // Snow only dusts the very top ledge of a wall; scree piles at the foot.
          const snowTop = (L + 1 >= h) ? 0.55 : (L + 2 >= h ? 0.18 : 0.0);
          const s0 = (x, z, y) => this._snowAt(x, z, y) * snowTop;
          const aoFor = (y) => {
            const a = 1 - 0.42 * sstep(3.0, 0.0, y - lowest);
            return a * (1 - 0.10 * sstep(h, lowest, y));
          };
          const screeFor = (y) => sstep(2.6, 0.15, y - lowest) * 0.9;
          const mk = (x, z, y) => [aoFor(y), 0, s0(x, z, y), screeFor(y)];
          if (dir === 0) {          // East +X
            quad([wx1, y0, wz1, wx1, y0, wz0, wx1, y1, wz0, wx1, y1, wz1], 1, 0, 0,
              [mk(wx1, wz1, y0), mk(wx1, wz0, y0), mk(wx1, wz0, y1), mk(wx1, wz1, y1)]);
          } else if (dir === 1) {   // West -X
            quad([wx0, y0, wz0, wx0, y0, wz1, wx0, y1, wz1, wx0, y1, wz0], -1, 0, 0,
              [mk(wx0, wz0, y0), mk(wx0, wz1, y0), mk(wx0, wz1, y1), mk(wx0, wz0, y1)]);
          } else if (dir === 2) {   // North -Z
            quad([wx1, y0, wz0, wx0, y0, wz0, wx0, y1, wz0, wx1, y1, wz0], 0, 0, -1,
              [mk(wx1, wz0, y0), mk(wx0, wz0, y0), mk(wx0, wz0, y1), mk(wx1, wz0, y1)]);
          } else {                  // South +Z
            quad([wx0, y0, wz1, wx1, y0, wz1, wx1, y1, wz1, wx0, y1, wz1], 0, 0, 1,
              [mk(wx0, wz1, y0), mk(wx1, wz1, y0), mk(wx1, wz1, y1), mk(wx0, wz1, y1)]);
          }
        };
        // Each side runs from the neighbour's surface up to this column's top.
        // The bottom edge is displaced only when it sits on another rock cap
        // (which was displaced by the same function) — otherwise it stays flush
        // with the flat ground/bed, so no cracks ever appear.
        const runs = [[0, nE, bE], [1, nW, bW], [2, nN, bN], [3, nS, bS]];
        for (const [dir, nh, bY] of runs) {
          if (bY >= h - 1e-4) continue;
          const rockBottom = (nh !== null && nh > 0);
          const startL = rockBottom ? nh : Math.floor(bY);
          for (let L = startL; L < h; L++) {
            let y0 = L, y1 = L + 1;
            if (L === startL) y0 = rockBottom ? bY : bY;      // exact neighbour surface
            if (L + 1 >= h) y1 = h;
            // Displace the shared edges consistently with the caps.
            const dispTop = (L + 1 >= h);
            const dispBot = (L === startL && rockBottom);
            if (dispTop || dispBot) {
              // Emit as a displaced quad (corner-wise) — handled below.
              this._sideDisplaced(quad, dir, wx0, wx1, wz0, wz1, y0, y1,
                dispBot, dispTop, h, lowest, this);
              continue;
            }
            sideQuad(dir, L, y0, y1);
          }
        }
      }
    }

    const geo = this._makeGeometry(pos, nrm, terr, mask, idx);
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

  // A side quad whose top and/or bottom edge follows the displaced cap surface.
  _sideDisplaced(quad, dir, wx0, wx1, wz0, wz1, y0, y1, dispBot, dispTop, h, lowest, self) {
    const D = (x, z) => self._disp(x, z);
    const snowTop = (y1 >= h - 1e-4) ? 0.55 : 0.0;
    const aoFor = (y) => (1 - 0.42 * sstep(3.0, 0.0, y - lowest)) * (1 - 0.10 * sstep(h, lowest, y));
    const screeFor = (y) => sstep(2.6, 0.15, y - lowest) * 0.9;
    const mk = (x, z, y) => [aoFor(y), 0, self._snowAt(x, z, y) * snowTop, screeFor(y)];
    // corner (x,z) pairs per direction, in the legacy winding order A,B,C,D
    let c;
    if (dir === 0)      c = [[wx1, wz1], [wx1, wz0], [wx1, wz0], [wx1, wz1]];  // +X
    else if (dir === 1) c = [[wx0, wz0], [wx0, wz1], [wx0, wz1], [wx0, wz0]];  // -X
    else if (dir === 2) c = [[wx1, wz0], [wx0, wz0], [wx0, wz0], [wx1, wz0]];  // -Z
    else                c = [[wx0, wz1], [wx1, wz1], [wx1, wz1], [wx0, wz1]];  // +Z
    const ya = dispBot ? y0 + D(c[0][0], c[0][1]) : y0;
    const yb = dispBot ? y0 + D(c[1][0], c[1][1]) : y0;
    const yc = dispTop ? y1 + D(c[2][0], c[2][1]) : y1;
    const yd = dispTop ? y1 + D(c[3][0], c[3][1]) : y1;
    const nx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    const nz = dir === 2 ? -1 : dir === 3 ? 1 : 0;
    quad([c[0][0], ya, c[0][1], c[1][0], yb, c[1][1], c[2][0], yc, c[2][1], c[3][0], yd, c[3][1]],
      nx, 0, nz,
      [mk(c[0][0], c[0][1], ya), mk(c[1][0], c[1][1], yb),
       mk(c[2][0], c[2][1], yc), mk(c[3][0], c[3][1], yd)]);
  }

  _makeGeometry(pos, nrm, terr, mask, idx) {
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aTerr', new THREE.Float32BufferAttribute(terr, 4));
    geo.setAttribute('aMask', new THREE.Float32BufferAttribute(mask, 4));
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
    for (const c of this._chunks.values()) { tally(c.ground); tally(c.rock); }
    skirtTris = tally(this._skirt);
    return {
      meshes, verts, tris, skirtTris,
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
      let worst = 0;
      for (const w of [0, 137, 320, 501, N * TILE]) {
        worst = Math.max(worst, Math.abs(terr._skirtY(w, 0) - terr.borderY));
        worst = Math.max(worst, Math.abs(terr._skirtY(0, w) - terr.borderY));
        worst = Math.max(worst, Math.abs(terr._skirtY(w, N * TILE) - terr.borderY));
      }
      if (worst > 1e-6) fail('skirt is ' + worst.toFixed(3) + ' units off borderY at the map ' +
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
      for (const m of [c.ground, c.rock]) {
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
        // 1b2. The screen-locked detail layer survived. Without it the fine
        //      residual is whatever the mip chain leaves of the world-space
        //      textures, which on a grazing ground plane is smeared along one
        //      screen axis and absent along the other.
        need(fs, 'uFine', 'fragment shader');
        if (fs.indexOf('#version 300 es') === 0 && fs.indexOf('textureLod(') === -1) {
          fail('GLSL3 shader has no textureLod() — the screen-locked micro ' +
               'detail layer is gone and the turf residual is anisotropic again');
        }
        // 1b3. The footprint-frame correction. Without dFdy the locked layer is
        //      isotropic in WORLD space, which on a grazing ground plane means
        //      it arrives on screen stretched by the projection aspect — the
        //      skirt anisotropy (ACF y/x 0.76) this replaced.
        need(fs, 'uFineK', 'fragment shader');
        if (fs.indexOf('#version 300 es') === 0 && fs.indexOf('dFdy(') === -1) {
          fail('GLSL3 shader has no dFdy() — the screen-locked layer lost its ' +
               'footprint-frame correction and is world-isotropic again');
        }
        // 1b4. The biome mask (CONTRACTS-RENDER.md §3.4 "soft colour variety at
        //      distance"): without it the meadow is one mottled sheet.
        need(fs, 'bMeadow', 'fragment shader');
        need(fs, 'bStone', 'fragment shader');
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
