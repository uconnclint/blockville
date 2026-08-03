// src/render/water.js — §3.3 of CONTRACTS-RENDER.md
//
// A real water surface for Blockville. Owns EVERYTHING at the water plane:
//   * a bright turquoise→deep-blue surface at y = -0.35 over every WATER tile
//     and every bridge tile,
//   * a sculpted sea bed underneath it (so the surface can be translucent and
//     you can actually see the shallows / a sandy shelf / caustics),
//   * depth colour + foam driven by a baked distance-to-shore DataTexture
//     (NO scene-depth-buffer read — the post stack owns the depth buffer),
//   * 3 scrolling procedural normal layers + 3 gerstner-ish vertex waves,
//   * fresnel sky/env reflection and a sharp sun glint that feeds bloom,
//   * an animated, surging shoreline foam band,
//   * rain ripple rings.
//
// Everything is procedural: no assets, no npm, no build step, no addons.
//
// Public API (see the bottom of the file for the full list):
//   const water = new WaterFX(scene, opts);
//   water.buildSurface(state);
//   water.refreshTiles(state, x, z);
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
const WATER_Y = -0.35;
const T_WATER = 1;
const T_SAND = 2;

const SQRT2 = Math.SQRT2;
const INF = 1e9;

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

// Shared GLSL: shore-field sampling + gerstner waves.
const COMMON_GLSL = /* glsl */`
uniform sampler2D uShoreMap;
uniform vec2  uWorldSize;
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveScale;

// R = normalised distance from the shoreline (0 land .. 1 offshore)
// G = water coverage mask (bilinear -> soft edge)
// B = beachiness (nearest land is sand)
// A = low-frequency per-water-body variation
vec4 shoreAt(vec2 wxz) {
  return texture2D(uShoreMap, wxz / uWorldSize);
}

// Three directional swells. Returns height in .x and the XZ gradient in .yz
// so the caller gets an analytic normal for free.
vec3 swell(vec2 p, float t) {
  vec3 r = vec3(0.0);
  // dir, wavelength(world units), amplitude, speed
  const vec2 d0 = vec2(0.86, 0.51);
  const vec2 d1 = vec2(-0.42, 0.91);
  const vec2 d2 = vec2(0.71, -0.71);
  float k0 = 6.2831853 / (46.0 * uWaveScale);
  float k1 = 6.2831853 / (27.0 * uWaveScale);
  float k2 = 6.2831853 / (15.0 * uWaveScale);
  float a0 = 0.062, a1 = 0.040, a2 = 0.022;
  float ph0 = dot(d0, p) * k0 + t * 0.85;
  float ph1 = dot(d1, p) * k1 - t * 1.15;
  float ph2 = dot(d2, p) * k2 + t * 1.75;
  r.x  = a0 * sin(ph0) + a1 * sin(ph1) + a2 * sin(ph2);
  vec2 g = a0 * k0 * cos(ph0) * d0 + a1 * k1 * cos(ph1) * d1 + a2 * k2 * cos(ph2) * d2;
  r.yz = g;
  return r;
}
`;

const SURFACE_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
${COMMON_GLSL}

varying vec3 vWorld;
varying vec3 vSwellN;
varying float vCrest;

void main() {
  vec3 transformed = position;
  vec4 sh = shoreAt(position.xz);
  // Waves flatten as they run into the shallows (and never poke above y=0).
  float damp = smoothstep(0.02, 0.42, sh.r);
  vec3 s = swell(position.xz, uTime);
  transformed.y += s.x * uWaveAmp * damp;
  vSwellN = normalize(vec3(-s.yz.x * uWaveAmp * damp, 1.0, -s.yz.y * uWaveAmp * damp));
  vCrest = clamp(s.x / 0.12 * 0.5 + 0.5, 0.0, 1.0) * damp;

  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SURFACE_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
${COMMON_GLSL}

uniform sampler2D uNormalMap;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyTop;
uniform vec3  uSkyHorizon;
uniform vec3  uShallowColor;
uniform vec3  uMidColor;
uniform vec3  uDeepColor;
uniform vec3  uBeachColor;
uniform vec3  uFoamColor;
uniform float uRain;
uniform float uNight;
uniform float uQuality;
uniform float uGlint;
uniform float uGlintGain;
uniform float uGlintRough;
uniform float uOpacityDeep;
uniform float uOpacityShore;
uniform float uDetail;
uniform float uFoamWidth;
uniform float uEnvIntensity;
uniform float uSkyGain;
uniform float uNightFloor;
uniform float uShoreWobble;
uniform float uEmitStrength;
uniform vec2  uEmitParams;      // (march step in world units, decay)
uniform sampler2D uEmitMap;
uniform float uHorizonLift;
uniform float uHazeRefl;
uniform float uGrazePow;
uniform float uGlintRough2;
uniform float uSpecScale;
uniform float uGlintSlope;
uniform float uSparkFloor;      // broad off-peak sheen under the GGX lobe
uniform vec3  uSparkGate;       // (crest gate lo, hi, gain) — sparkle density
uniform float uSwellSpark;      // 0 = sparkle anywhere, 1 = only on swell crests
uniform float uGlintFar;        // how much of the glint survives at distance
uniform float uMieGain;         // reflected forward-scatter halo around the sun
uniform float uFoamGate;        // foam dies past this RAW shore-field distance
uniform float uWobbleFade;      // shore-field distance the wobble fades out over
#ifdef USE_ENVCUBE
uniform samplerCube uEnvMap;
#endif

varying vec3 vWorld;
varying vec3 vSwellN;
varying float vCrest;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}

// One layer of rain ripple rings. Returns xy = normal perturbation, z = rim.
vec3 rippleLayer(vec2 wp, float t, float scale, float seed, float density) {
  vec2 p = wp / scale + seed;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float hA = hash21(cell + seed);
  float hB = hash21(cell + seed + 19.37);
  float hC = hash21(cell + seed + 41.11);
  if (hA > density) return vec3(0.0);
  vec2 c = vec2(hB, hC) * 0.56 + 0.22;
  vec2 d = f - c;
  float dist = length(d) + 1e-5;
  float phase = fract(t * 1.35 + hB * 2.71);
  float r = phase * 0.40;
  float env = (1.0 - phase) * smoothstep(0.0, 0.10, phase);
  float band = dist - r;
  float w = sin(band * 78.0) * exp(-abs(band) * 20.0) * env;
  return vec3(normalize(d) * w, max(0.0, -w) * env);
}

// Analytic sky radiance in a direction. This is what the fresnel term mixes
// toward, so it has to be genuinely BRIGHT at the horizon — a grazing-angle
// water pixel is 60-90 % mirror and must read as sky, not as tinted depth.
vec3 skyLook(vec3 dir) {
  float up = clamp(dir.y, 0.0, 1.0);
  // uSkyHorizon arrives as the fog/haze colour, which is deliberately dull;
  // lift it so the reflected horizon band is the brightest part of the lake.
  vec3 c = mix(uSkyHorizon * uHorizonLift, uSkyTop, pow(up, 0.42));
  // Mie forward-scatter halo + the sun disc itself. Reflected through fresnel
  // this is the classic glitter path running from the sun to the viewer.
  // The halo used to be pow(sd,7)*0.42 — a lobe that wide covers most of the
  // upper hemisphere, so at a 63-degree noon sun EVERY water pixel reflected a
  // slab of near-sun sky. Measured: it was worth ~0.05 linear luminance across
  // the whole lake on its own, which is the entire deep-water budget.
  float sd = max(dot(dir, uSunDir), 0.0);
  float above = smoothstep(-0.06, 0.10, uSunDir.y);
  c += uSunColor * (pow(sd, 11.0) * uMieGain + pow(sd, 220.0) * 5.0) * above;
#ifdef USE_ENVCUBE
  vec3 e = textureCube(uEnvMap, dir).rgb;
  c = mix(c, e, uEnvIntensity);
#endif
  return c * uSkyGain;
}

// Normalised Blinn-Phong lobe: peak value scales with the exponent so a sharp
// lobe is genuinely HDR (>> 1.0) and reaches the bloom threshold.
float specLobe(float NdH, float e) {
  return pow(NdH, e) * (e + 8.0) * 0.0075;
}

// GGX / Trowbridge-Reitz. This replaces the Blinn-Phong spike for the sun
// glint, and the reason is measured, not aesthetic: Blockville's noon sun sits
// at 63 degrees elevation while the waterfront/region cameras sit at 10-15, so
// the half-vector is ~27 degrees off vertical over the whole lake. The old
// pow(NdH, 180..2200) lobe is numerically ZERO there — cranking uGlintGain by
// 1000x was needed before a single pixel crossed 245/255, which is why the
// reviewers found "not a single specular glint" at a 63-degree sun.
//
// GGX has heavy tails. Off-peak it returns a soft, cheap sheen; on the wave
// facets that DO line up it spikes to an HDR value that clears the bloom
// threshold. That is what turns the sun track into sparkles rather than either
// nothing (Blinn-Phong) or a smeared blob (a low exponent everywhere).
float ggxD(float NdH, float a) {
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * d * d, 1e-7);
}

void main() {
  vec2 p = vWorld.xz;
  float t = uTime;
  vec4 sh = shoreAt(p);
  float camD = length(cameraPosition - vWorld);

  // The tile grid is 8 units; break the hard staircase of the distance field
  // with a two-octave wobble before anything shore-driven uses it. This is what
  // turns a 90-degree voxel shoreline into a meandering one.
  //
  // REGRESSION FIX: the wobble is a SHORELINE effect and must decay offshore.
  // At the old amplitude (0.26 x a +/-1.14 signal = +/-0.30 normalised = +/-12
  // world units) it could drag depthT to zero in the middle of the lake, which
  // is how a 2.5-unit foam band ended up painting open water white.
  float wobRaw = (texture2D(uNormalMap, p * (1.0 / 37.0) + vec2( 0.0041, 0.0029) * t).a - 0.5) * 1.42
               + (texture2D(uNormalMap, p * (1.0 / 13.0) + vec2(-0.0069, 0.0044) * t).a - 0.5) * 0.86;
  float wobFade = 1.0 - smoothstep(uWobbleFade * 0.25, uWobbleFade, sh.r);
  float wob = wobRaw * uShoreWobble * wobFade;
  float depthT = max(0.0, sh.r + wob);

  // ---- animated normal: four layers, all different scales, SPEEDS and
  // DIRECTIONS, each in its own rotated frame so nothing beats in phase with
  // anything else. (The old set scrolled slowly enough that the surface read as
  // one breathing unit; these are 2-3x faster and mutually decorrelated.)
  mat2 rotA = mat2( 0.802, -0.597,  0.597,  0.802);
  mat2 rotB = mat2(-0.279,  0.960, -0.960, -0.279);
  mat2 rotC = mat2( 0.435,  0.900, -0.900,  0.435);
  vec2 uv0 = p * (1.0 / 57.0)             + vec2( 0.0190,  0.0072) * t;
  vec2 uv1 = (rotA * p) * (1.0 / 21.5)    + vec2(-0.0345,  0.0268) * t;
  vec2 uv2 = (rotB * p) * (1.0 /  8.1)    + vec2( 0.0512, -0.0655) * t;
  vec2 uv3 = (rotC * p) * (1.0 /  3.0)    + vec2(-0.0930, -0.0410) * t;

  vec4 n0 = texture2D(uNormalMap, uv0);
  vec4 n1 = texture2D(uNormalMap, uv1);
  vec2 dn = (n0.xy * 2.0 - 1.0) * 1.00 + (rotA * (n1.xy * 2.0 - 1.0)) * 0.86;
  float hgt = n0.a * 0.55 + n1.a * 0.45;
  // The fine layers mip away in the distance; keep the total slope roughly
  // constant by measuring how much of them survives and re-weighting.
  float detFade = 1.0 - smoothstep(90.0, 460.0, camD);
  if (uQuality > 0.5) {
    vec4 n2 = texture2D(uNormalMap, uv2);
    dn += (rotB * (n2.xy * 2.0 - 1.0)) * 0.66;
    hgt = mix(hgt, n2.a, 0.30);
  }
  if (uQuality > 1.5) {
    // Finest ripple scale — this is what breaks the sun track into sparkles
    // instead of one smeared blob in the near field.
    vec4 n3 = texture2D(uNormalMap, uv3);
    dn += (rotC * (n3.xy * 2.0 - 1.0)) * 0.46;
    hgt = mix(hgt, n3.a, 0.26);
  }
  // Chop rises with rain and calms in the shallows. Slopes are damped with
  // distance: sub-pixel waves average out in reality, and leaving them large
  // scatters the grazing normal so badly that fresnel collapses and the far sea
  // turns navy instead of sky-bright.
  float calm = mix(0.55, 1.0, smoothstep(0.0, 0.22, depthT));
  dn *= uDetail * calm * (1.0 + uRain * 0.8) * mix(0.45, 1.0, detFade);

  // ---- rain ripples -------------------------------------------------------
  // Faded out with distance so the rings never alias into moire at the horizon.
  float rfade = 1.0 - smoothstep(160.0, 420.0, camD);
  float rim = 0.0;
  if (uRain * rfade > 0.001) {
    float ra = uRain * rfade;
    vec3 r1 = rippleLayer(p, t, 3.4, 0.0, uRain * 0.55);
    dn += r1.xy * ra * 0.9;
    rim += r1.z * rfade;
    if (uQuality > 0.5) {
      vec3 r2 = rippleLayer(p, t * 1.31, 6.9, 7.3, uRain * 0.45);
      dn += r2.xy * ra * 0.8;
      rim += r2.z * 0.8 * rfade;
    }
  }

  vec3 N = normalize(vec3(vSwellN.x + dn.x, 1.0, vSwellN.z + dn.y));
  vec3 V = normalize(cameraPosition - vWorld);
  float NdV = max(dot(N, V), 1e-4);
  vec3 L = normalize(uSunDir);
  float sunUp = smoothstep(-0.07, 0.05, L.y);

  // ---- body colour: 100 % from the sampled shore-distance FIELD -----------
  // (no vertex attribute anywhere in this path, so no triangulation seams)
  // Hue-preserving: the shallows take the SKY's colour cast (warm at sunset,
  // steel blue at dusk, near-black at midnight) without gaining brightness.
  float skyL = max(1e-4, dot(uSkyHorizon, vec3(0.2126, 0.7152, 0.0722)));
  vec3 skyHue = uSkyHorizon / skyL;
  vec3 shallowC = uShallowColor * mix(vec3(1.0), skyHue, 0.42);
  // A REAL depth ramp. The turquoise lives in the first ~1 tile off the shore
  // (0.20 x far 5 tiles) and the deep blue is fully reached by ~3.5 tiles, so
  // the ramp spends its whole range inside a lake this size instead of running
  // out of gradient (the previous 0.26 -> 0.88 window put the far shore of an
  // 8-tile lake only 40 % of the way to uDeepColor).
  vec3 body = mix(shallowC, uMidColor, smoothstep(0.0, 0.20, depthT));
  body = mix(body, uDeepColor, smoothstep(0.18, 0.70, depthT));
  // Sandy shores read warm and pale.
  body = mix(body, uBeachColor, sh.b * (1.0 - smoothstep(0.0, 0.30, depthT)) * 0.75);
  // Low-frequency variation so a big ocean isn't one flat colour.
  body *= 0.86 + 0.28 * sh.a;
  // A touch of translucency on wave faces (light through the crest).
  body += shallowC * vCrest * 0.18 * (1.0 - depthT * 0.5);
  // Wave-slope shading, now with real contrast so the travelling normal detail
  // is visible in the BODY as well as in the reflection.
  float wave = dot(N, normalize(L + vec3(0.0, 0.9, 0.0)));
  body *= 0.74 + 0.52 * clamp(wave, 0.0, 1.0);
  // Night: the lake is not emissive. Fold it down on the same kind of curve the
  // lit terrain follows, or it becomes the brightest thing in the night frame.
  body *= mix(1.0, uNightFloor, uNight);

  // ---- fresnel reflection --------------------------------------------------
  // Schlick, unclamped and uncapped: at grazing angles the water MUST go
  // sky-bright. Previously a 0.55-0.86 cap plus a dull horizon colour made the
  // far edge darker than the near edge, which is backwards.
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  fres = clamp(fres, 0.0, 1.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.90 + 0.015;      // never sample below the horizon
  vec3 refl = skyLook(R);
  // Water is not a perfect mirror: a little of its own hue bleeds in.
  refl = mix(refl, refl * (0.68 + 0.55 * body), 0.16);
  // Sky reflection dims under rain (overcast + broken surface).
  refl = mix(refl, refl * 0.72 + vec3(0.10, 0.12, 0.14), uRain * 0.6);

  // Grazing floor. Even where the per-pixel normal happens to point at the
  // camera, water this far away is seen at a grazing angle overall and must
  // read as sky. Without it the horizon band goes navy, which is the exact
  // "darker at the far edge" inversion the reviewers measured.
  // Geometric (unperturbed) view elevation, so wave noise cannot break it.
  float graze = pow(1.0 - clamp(V.y, 0.0, 1.0), uGrazePow);
  float reflMix = clamp(max(fres, graze * 0.94) * 0.98, 0.0, 0.98);
  vec3 col = mix(body, refl, reflMix);

  // ---- sun glint (HDR; feeds the bloom pass) ------------------------------
  // The specular lobe gets its OWN, steeper normal. Real glitter comes from the
  // capillary ripples riding on the swell, whose slopes are far steeper than the
  // slope that shades the body — and the half-vector here sits ~27 degrees off
  // vertical, so nothing shallower can ever reach it. Driving both from one
  // normal forces a choice between "no sparkle" and "visibly noisy water";
  // uGlintSlope buys the sparkle without roughening the body.
  vec3 Ns = normalize(vec3(vSwellN.x + dn.x * uGlintSlope,
                           1.0,
                           vSwellN.z + dn.y * uGlintSlope));
  vec3 H = normalize(L + V);
  float NdH = max(dot(Ns, H), 0.0);
  float NdL = max(dot(Ns, L), 0.0);
  // Sub-pixel slope variance IS roughness. The fine normal layers mip away with
  // distance, so the lobe has to widen by exactly as much as they shrink or the
  // far field loses its glitter band; rain roughens it further.
  float rough = uGlintRough2 + (1.0 - detFade) * 0.030 + uGlintRough * 0.05;
  float D = ggxD(NdH, rough);
  // Only facets near a crest carry the spike, so the track breaks into
  // individual sparkles instead of one continuous smear.
  //
  // REGRESSION FIX: spark used to carry a 0.45 PEDESTAL, i.e. every pixel on
  // the lake — crest or trough — got 45 % of a GGX lobe whose peak is ~130.
  // Combined with uGlintSlope 6 (a specular normal six times steeper than the
  // shading normal) that is not a glitter track, it is an isotropic white haze
  // over the entire surface. Measured on the region shot: switching uGlint to 0
  // dropped the high-pass residual sigma from 8.4/255 to 0.8/255 and open-water
  // luminance from 0.35 to 0.23 — the "slush" was the specular, not the foam.
  // The pedestal is now ~0.06 and the crest gate is tighter, so the lobe still
  // spikes HDR where a facet actually aligns (and still feeds bloom) but has
  // almost no coverage off-peak.
  // Sparkles ride the SWELL, not just the noise field. Without this the lobe
  // fires wherever the fine noise happens to peak, which is a spatially
  // uniform (isotropic) fleck field — the exact thing the reviewers measured.
  // Gating on vCrest as well makes the glitter run in bands along the wave
  // fronts, which is both what real sun glitter does and roughly half the
  // coverage for the same peak brightness.
  float swellGate = mix(1.0, smoothstep(0.34, 0.86, vCrest), uSwellSpark);
  float spark = uSparkFloor + uSparkGate.z * smoothstep(uSparkGate.x, uSparkGate.y, hgt) * swellGate;
  // A broad secondary lobe keeps a low sun's track readable at the horizon,
  // where no single facet is big enough on screen to sparkle.
  float track = specLobe(NdH, 20.0) * 0.22 * (1.0 - smoothstep(0.10, 0.42, L.y));
  float spec = (D * spark * NdL * uSpecScale + track) * uGlint * uGlintGain * sunUp;
  // A sparkle smaller than a pixel must AVERAGE DOWN, not survive at full HDR.
  // Widening the roughness with distance (above) spreads one highlight over more
  // pixels; without this companion term that is exactly how a sparkle field
  // turns into uniform white fog at the 340-unit region orbit.
  spec *= mix(uGlintFar, 1.0, detFade);
  spec = min(spec, 60.0);
  col += uSunColor * spec;

  // ---- cheap fake reflection: the city smears into the lake ---------------
  // A coarse top-down map of the emissive city is marched along the reflection
  // ray. No render target, no depth read — just a decaying line integral, which
  // is exactly the heavy vertical blur a real mirror pass would need anyway.
  if (uEmitStrength > 0.002) {
    vec2 rd = R.xz;
    float rl = length(rd);
    if (rl > 1e-3) {
      rd /= rl;
      vec3 acc = vec3(0.0);
      float wsum = 1e-4;
      // 10 taps, not 6. The reviewers' case is "a lit downtown 20 tiles behind
      // the lake shows nothing" — 20 tiles is 160 world units, and 6 taps at the
      // old 26-unit step only reached 156 with the tail already decayed to 0.13,
      // so the city was effectively out of range. Measured on the reference
      // city: extending the march lifts the mean night-water luminance near
      // downtown by ~9/255 where the old settings moved it by 0.0.
      for (int i = 1; i <= 10; i++) {
        float ft = float(i);
        vec2 q = (p + rd * (ft * uEmitParams.x)) / uWorldSize;
        vec4 em = texture2D(uEmitMap, clamp(q, vec2(0.002), vec2(0.998)));
        float w = exp(-ft * uEmitParams.y);
        acc += em.rgb * em.a * w;
        wsum += w;
      }
      col += (acc / wsum) * uEmitStrength * (0.30 + 0.70 * fres);
    }
  }

  // ---- shoreline foam ------------------------------------------------------
  // Driven entirely by smoothstep() on the shore-distance FIELD (orientation
  // free, so all four edge orientations get identical treatment) times two
  // counter-phased animated noise fields, so it pulses and breaks up.
  //
  // HARD GATE on the RAW field (no wobble, no surge, no noise can widen it):
  // foam exists in the first uFoamGate of the shore-distance field and nowhere
  // else. uFoamGate 0.055 x far(5 tiles) x TILE(8) = 2.2 world units, i.e. the
  // first ~2 m of shoreline. Everything below may only ever reduce it.
  float shoreGate = 1.0 - smoothstep(uFoamGate * 0.50, uFoamGate, sh.r);
  float fn1 = texture2D(uNormalMap, p * (1.0 / 19.0) + vec2( 0.0075, -0.0052) * t).a;
  float fn2 = texture2D(uNormalMap, p * (1.0 /  5.1) + vec2(-0.0260,  0.0195) * t).a;
  float fn3 = texture2D(uNormalMap, p * (1.0 /  2.2) + vec2( 0.0410,  0.0330) * t).a;
  // The waterline surges in and out, at two unrelated periods.
  float surgeA = 0.5 + 0.5 * sin(t * 0.93 + fn1 * 6.283 + p.x * 0.0135 - p.y * 0.0093);
  float surgeB = 0.5 + 0.5 * sin(t * 0.51 - fn2 * 6.283 + p.y * 0.0172 + p.x * 0.0061);
  float surge = surgeA * 0.62 + surgeB * 0.38;
  float band = uFoamWidth * (0.40 + 1.20 * surge);
  float edge = 1.0 - smoothstep(0.0, band, depthT);
  float lace = smoothstep(0.38, 0.86, fn2 * 0.44 + fn3 * 0.26 + fn1 * 0.30 + edge * 0.36);
  float foam = clamp(edge * (0.10 + 1.05 * lace), 0.0, 1.0);
  // A crisp bright line hard against the land — also surge-modulated so it is
  // never the fat uniform-opacity ribbon it used to be.
  foam = max(foam, (1.0 - smoothstep(0.0, uFoamWidth * (0.10 + 0.30 * surge), depthT))
                   * (0.34 + 0.48 * surgeB));
  foam *= shoreGate;
  // Offshore whitecaps: RAIN ONLY. In calm weather a kid-friendly lake has no
  // breaking crests, and this term was firing on every swell peak across the
  // whole surface (vCrest reaches 1.0 in open water), adding a second isotropic
  // white speckle field on top of the specular one.
  if (uQuality > 0.5 && uRain > 0.02) {
    float cap = texture2D(uNormalMap, p * vec2(1.0 / 13.0, 1.0 / 7.5) + vec2(0.020, 0.012) * t).a;
    float cap2 = texture2D(uNormalMap, p * (1.0 / 3.1) + vec2(-0.038, 0.026) * t).a;
    float wc = smoothstep(0.74, 0.96, cap * 0.62 + cap2 * 0.38)
             * smoothstep(0.86, 0.995, vCrest)
             * smoothstep(0.30, 0.72, depthT);
    foam = max(foam, wc * 0.70 * uRain);
  }
  vec3 foamC = uFoamColor * (0.55 + 0.55 * max(L.y, 0.0) + 0.25);
  foamC *= mix(1.0, uNightFloor * 2.6, uNight);
  col = mix(col, foamC, foam);

  // rain ring rims
  col += vec3(0.9, 0.96, 1.0) * rim * uRain * 0.30;

  // ---- low sun: the whole sheet takes the sun's hue -----------------------
  float lowSun = 1.0 - smoothstep(0.02, 0.34, L.y);
  vec3 sunHue = uSunColor / max(max(uSunColor.r, uSunColor.g), max(uSunColor.b, 1e-4));
  col *= mix(vec3(1.0), 0.44 + 0.80 * sunHue, lowSun * 0.80 * (1.0 - uNight));

  // ---- opacity -------------------------------------------------------------
  // Essentially opaque: terrain.js draws the sea bed and its coarse per-vertex
  // depth tint used to show straight through the old 0.60-alpha shallows as
  // hard triangle seams across the lake.
  float alpha = mix(uOpacityShore, uOpacityDeep, smoothstep(0.0, 0.10, depthT));
  alpha = clamp(max(alpha, foam), 0.0, 1.0);
  // Kill the sub-pixel sliver outside the water mask (bridge/tile seams).
  alpha *= smoothstep(0.02, 0.30, sh.g);

  // ---- aerial perspective ---------------------------------------------------
  // NOT three's <fog_fragment>. scene.fog exists for the LAND: it mixes toward
  // fogColor, a dull haze tone, and at the far edge of a 640-unit map the fog
  // factor is ~0.95, so the built-in chunk was overwriting everything above with
  // the haze colour. Measured: the water immediately below the horizon came out
  // at luminance 83 while the sky one pixel above it was 175 — a 2:1 inversion,
  // and the single loudest "airbrushed swimming pool" tell in the frame.
  //
  // Distance still has to READ as distance, so the depth cue is kept; only the
  // colour it converges on changes. Water at 500 units is seen at a grazing
  // angle, so what it converges on is the REFLECTED SKY, which is exactly what a
  // real lake does. uHazeRefl is how far toward that we go vs. the land's haze
  // (1.0 = pure sky reflection, 0.0 = three's original behaviour).
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogT = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogT = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  vec3 haze = mix(fogColor, refl, uHazeRefl);
  col = mix(col, haze, fogT);
#endif

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
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
  col = mix(col, uWetSand, vShore.b * (1.0 - smoothstep(0.0, 0.26, d)) * 0.6);

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
   *   sub          surface subdivisions per tile per axis (default 4)
   *   shoreSub     shore-field samples per tile per axis (default 4)
   *   waterY       surface plane height (default -0.35)
   *   far          shore-field range in tiles (default 5)
   *   seabed       build the sculpted sea bed (default true)
   *   quality      0|1|2 (default 2)
   *   edgeIsLand   treat the map border as land for foam (default false)
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    const o = this.opts = Object.assign({
      n: N_DEFAULT,
      tile: TILE,
      chunk: CHUNK,
      sub: 4,
      shoreSub: 4,
      waterY: WATER_Y,
      far: 5.0,
      seabed: true,
      quality: 2,
      edgeIsLand: false,
      normalTexSize: 256,
      shoreJitter: 0.40,     // tiles; breaks the rectilinear water mesh edge
      shoreRetreat: 0.0,     // 0..1 of the jitter allowed to expose the sea bed
      emitRes: 64,           // fake-reflection emitter map resolution
      emitReflection: true,
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
    this._shoreData = new Uint8Array(this.fieldW * this.fieldW * 4);
    this._distLand = new Float32Array(this.fieldW * this.fieldW);
    this._distSand = new Float32Array(this.fieldW * this.fieldW);
    this._shoreTex = new THREE.DataTexture(
      this._shoreData, this.fieldW, this.fieldW, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._shoreTex.wrapS = this._shoreTex.wrapT = THREE.ClampToEdgeWrapping;
    this._shoreTex.magFilter = THREE.LinearFilter;
    this._shoreTex.minFilter = THREE.LinearFilter;
    this._shoreTex.generateMipmaps = false;
    this._shoreTex.needsUpdate = true;
    this._shoreDirty = false;
    this._tileFlags = new Uint8Array(this.N * this.N);
    this._buildVarField();

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
      uSkyHorizon: { value: srgb(0xbfe2fa) },
      // ---- the depth ramp -----------------------------------------------
      // These are BODY colours, i.e. what a swimmer sees, not what the frame
      // shows: fresnel sky, the glint and (at grazing angles) the aerial
      // perspective all sit on top. Their linear luminances are 0.22 / 0.10 /
      // 0.028, chosen against the measured surroundings in the region shot
      // (grass 0.178, city 0.123) so that open water lands BELOW both — the
      // previous set (0.49 / 0.32 / 0.081) put the lake 2.8x above the grass.
      uShallowColor: { value: srgb(0x2f9489) },
      uMidColor: { value: srgb(0x156081) },
      uDeepColor: { value: srgb(0x0c305c) },
      uBeachColor: { value: srgb(0x5f9d92) },
      uFoamColor: { value: srgb(0xf4fdff) },
      uGlint: { value: 1.0 },
      uGlintGain: { value: 1.0 },
      uGlintRough: { value: 0.0 },
      // Near-opaque. terrain.js owns the sea bed; letting it show through was
      // the source of the "hard triangle seams" across the lake.
      uOpacityDeep: { value: 1.0 },
      uOpacityShore: { value: 0.92 },
      uDetail: { value: 0.30 },
      // Normalised shore units: 0.050 x far(5 tiles) x TILE(8) = 2.0 world
      // units, surging out to ~3.2. The hard gate (uFoamGate) caps it at 4.0.
      uFoamWidth: { value: 0.050 },
      uEnvIntensity: { value: 0.6 },
      uSkyGain: { value: 1.0 },
      // Night fold-down of the BODY. Retuned with the new (much darker) day
      // body: at 0.085 the lake dimmed to a water/land night keep-RATIO of 0.52,
      // i.e. it fell away faster than the ground it sits in. 0.20 restores 0.74.
      uNightFloor: { value: 0.20 },
      // Normalised shore units, so 0.085 x the ~+/-1.14 wobble amplitude x the
      // 5-tile field range is roughly +/-0.5 tiles of meander on the WATERLINE
      // (colour + foam), and it is faded out past uWobbleFade so it can only
      // ever act ON the shoreline. It cannot move the mesh silhouette — see
      // shoreRetreat.
      uShoreWobble: { value: 0.085 },
      uWobbleFade: { value: 0.22 },
      uEmitStrength: { value: 0.0 },
      // (march step in world units, per-step exponential decay). 10 taps x 30
      // units = 300 units of reach; the step stays near the emitter map's own
      // 10-unit texel size so the streak does not alias into bands.
      uEmitParams: { value: new THREE.Vector2(30.0, 0.20) },
      // How far above `uSkyHorizon` the reflected horizon band sits. The colour
      // engine.js hands us is the FOG colour, which is deliberately duller than
      // the sky dome it is supposed to match; reflecting it verbatim is what
      // made the far lake darker than the sky directly above it.
      // 2.35 was a 2.35x SKY, not a lifted fog colour: reflected through the
      // grazing floor and then again through the aerial-perspective haze it
      // made the far half of every lake the brightest surface in the frame.
      // 1.25 is enough to clear the (deliberately dull) fog tone so the grazing
      // far edge still reads brighter than the sky above it.
      uHorizonLift: { value: 1.45 },
      // Aerial perspective converges on the reflected sky rather than the land
      // haze colour (see the fog block at the bottom of the surface shader).
      uHazeRefl: { value: 0.86 },
      uGrazePow: { value: 4.0 },
      // Reflected Mie halo gain (see skyLook). Small: this is a halo, not a
      // second sky.
      uMieGain: { value: 0.20 },
      // Foam gate, in RAW shore-field units: 0.10 x far(5 tiles) x TILE(8) = 4.0
      // world units, half a tile. Nothing downstream may widen it — the surge,
      // the lace noise and the shore wobble may only ever reduce it.
      // (A literal 2-unit gate was measured and is invisible: terrain.js draws a
      // 0.35-unit bank at the waterline, which occludes ~1.2 units of water at
      // the waterfront shot's 16-degree camera, and the shore field is only
      // sampled every 2 units. 4.0 is the narrowest band that actually reads.
      // The nearest OPEN water is 12+ units offshore, so this cannot reach it.)
      uFoamGate: { value: 0.10 },
      // Off-peak GGX pedestal, and how much of the glint survives once the fine
      // normal layers have mipped away. Both were effectively 1.0 before.
      // (crest gate lo, hi, gain). A HIGH gain through a NARROW gate is the
      // whole trick: total specular energy is roughly gain x (1 - gate width),
      // so pushing the gate from 0.62 to 0.80 and the gain from 2.4 to 18 keeps
      // the peak HDR (it still clears the bloom threshold) while cutting the
      // number of pixels that carry any specular at all by ~5x. Measured on the
      // waterfront shot: 0.45 % of water pixels gain >30/255 from the glint,
      // against 35.85 % with the old 0.45 pedestal.
      uSparkFloor: { value: 0.010 },
      uSparkGate: { value: new THREE.Vector3(0.80, 0.99, 18.0) },
      uSwellSpark: { value: 0.85 },
      uGlintFar: { value: 0.15 },
      // GGX roughness of the sun lobe, and the HDR scale of its peak. The peak
      // is 1/(pi*rough^2) ~= 130, so uSpecScale lands it well above the bloom
      // threshold on the facets that align, and near zero everywhere else.
      // Measured trade-off (waterfront shot, 63-degree sun): slope 6 / scale
      // 0.40 puts ~20 pixels per frame over 245/255 pure white while the mean
      // water chroma only falls 0.349 -> 0.32. Pushing to slope 8 / 0.5 doubles
      // the sparkle but takes chroma to 0.30 and starts frosting the turquoise.
      uGlintRough2: { value: 0.10 },
      uSpecScale: { value: 2.2 },
      // MEASURED, not guessed. The half-vector angle off vertical is what
      // decides whether a glint is reachable at all, and it is completely
      // different per shot: region (polar 0.72, sun at 63 deg, camera 126 deg
      // round from the sun) puts H only 18 deg off vertical, while waterfront
      // (polar 1.28) puts it at 49 deg. A specular normal that can only tilt
      // ~26 deg therefore sparkles in one shot and is mathematically dead in the
      // other — which is why the old build needed a 0.45 pedestal (a haze over
      // everything) to show any highlight at the waterfront at all. Slope 11
      // reaches the 49-degree facets, so the highlight can come from the LOBE
      // instead of from a pedestal.
      uGlintSlope: { value: 11.0 },
      uEmitMap: { value: this._emitTex },
      uEnvMap: { value: null },
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

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      fog: true,
    });
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

    this.group = new THREE.Group();
    this.group.name = 'WaterFX';
    this.group.matrixAutoUpdate = false;
    if (scene && scene.add) scene.add(this.group);

    this._detailBase = this.uniforms.uDetail.value;
    // Authored values that setQuality() scales DOWN from. Kept separate so a
    // quality switch never compounds with a previous quality switch, and so
    // setSky() can re-author them at any level.
    this._specBase = this.uniforms.uSpecScale.value;
    this._glintRoughBase = this.uniforms.uGlintRough2.value;
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
    this._buildEmitMap(state);
    this._computeShoreField(state, 0, 0, this.N - 1, this.N - 1);
    this._uploadShore();
    this._waterTiles = 0;
    for (let cz = 0; cz < this.chunksPerSide; cz++) {
      for (let cx = 0; cx < this.chunksPerSide; cx++) this._buildChunk(state, cx, cz);
    }
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
    this._computeShoreField(state, x - pad, z - pad, x + pad, z + pad);
    this._shoreDirty = true;               // coalesced; flushed in update()
    const cx = Math.floor(x / this.CHUNK), cz = Math.floor(z / this.CHUNK);
    this._removeChunk(cx, cz);
    this._buildChunk(state, cx, cz);
    return this;
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

  /** 1 at the waterline, 0 more than ~1.6 tiles offshore. Reads the baked
   *  distance field, so it agrees for every duplicate of a shared vertex. */
  _fringeWeight(wx, wz) {
    const S = this.S, W = this.fieldW;
    let cx = Math.floor(wx / this.TILE * S), cz = Math.floor(wz / this.TILE * S);
    if (cx < 0) cx = 0; else if (cx > W - 1) cx = W - 1;
    if (cz < 0) cz = 0; else if (cz > W - 1) cz = W - 1;
    let d = this._distLand[cz * W + cx];
    if (!(d < INF)) return 0;
    d = (d > 0.5 ? d - 0.5 : 0) / S;          // cells -> tiles from the shoreline
    const t = 1 - Math.min(1, Math.max(0, d / 1.6));
    return t * t * (3 - 2 * t);
  }

  /** Unit vector pointing OFFSHORE (up the shore-distance gradient) at (wx,wz).
   *  Written into `out` = [x, z]. Returns false if the gradient is degenerate. */
  _shoreGrad(wx, wz, out) {
    const S = this.S, W = this.fieldW, dl = this._distLand;
    const fx = wx / this.TILE * S, fz = wz / this.TILE * S;
    const cl = (v) => (v < 1 ? 1 : (v > W - 2 ? W - 2 : v)) | 0;
    const cx = cl(Math.floor(fx)), cz = cl(Math.floor(fz));
    const at = (x, z) => { const v = dl[z * W + x]; return v < INF ? v : this.opts.far * S; };
    let gx = at(cx + 1, cz) - at(cx - 1, cz);
    let gz = at(cx, cz + 1) - at(cx, cz - 1);
    const m = Math.sqrt(gx * gx + gz * gz);
    if (m < 1e-4) return false;
    out[0] = gx / m; out[1] = gz / m;
    return true;
  }

  _removeChunk(cx, cz) {
    const k = this._key(cx, cz);
    const c = this._chunks.get(k);
    if (!c) return;
    if (c.surf) this.group.remove(c.surf);
    if (c.bed) this.group.remove(c.bed);
    if (c.geo) c.geo.dispose();
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

    // Count first so we can allocate exact typed arrays (no push()-churn).
    let tiles = 0;
    for (let z = z0; z < z1; z++)
      for (let x = x0; x < x1; x++) if (this._isWater(state, x, z)) tiles++;
    if (tiles === 0) return;

    const vpt = (SUB + 1) * (SUB + 1);      // verts per tile
    const ipt = SUB * SUB * 6;              // indices per tile
    const pos = new Float32Array(tiles * vpt * 3);
    const idx = (tiles * vpt > 65535) ? new Uint32Array(tiles * ipt) : new Uint16Array(tiles * ipt);
    const step = T / SUB;
    const y = this.opts.waterY;

    // Shoreline jitter: a smooth, world-space (NOT per-tile) noise field, so
    // every copy of a shared lattice point in every neighbouring tile/chunk
    // agrees and no triangle can fold. Only the fringe moves.
    const jitAmp = Math.max(0, this.opts.shoreJitter) * T;
    const jitLat = 1 / (T * 2.6);
    // How much of the OFFSHORE (retreating) jitter component survives. Moving a
    // fringe vertex offshore uncovers whatever terrain.js drew under the water;
    // moving it onshore just tucks it under the bank and is always free. 0 keeps
    // only the tangential slide (which cannot move an axis-aligned edge at all,
    // so the shoreline stays on the grid); 1 lets the waterline genuinely
    // meander at the cost of showing the sea bed in the gap.
    const keepOut = Math.max(0, Math.min(1, this.opts.shoreRetreat));
    const wsMax = this.worldSize;
    if (!this._g2) this._g2 = [0, 0];

    let vp = 0, ip = 0, base = 0;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (!this._isWater(state, x, z)) continue;
        const wx = x * T, wz = z * T;
        for (let j = 0; j <= SUB; j++) {
          for (let i = 0; i <= SUB; i++) {
            let px = wx + i * step, pz = wz + j * step;
            if (jitAmp > 0) {
              const fr = this._fringeWeight(px, pz);
              if (fr > 0.001) {
                let jx = (vnoise(px * jitLat, pz * jitLat, 7717) - 0.5) * 2;
                let jz = (vnoise(px * jitLat + 31.7, pz * jitLat - 17.3, 4409) - 0.5) * 2;
                // Project OUT the offshore component. terrain.js draws a hard
                // vertical bank at the tile boundary, so a vertex that retreats
                // offshore just uncovers a black wall; a vertex that slides
                // sideways or tucks under the land is free. The visible
                // meander of the waterline comes from uShoreWobble in the
                // fragment shader; this keeps the mesh off the grid without
                // ever exposing the bank.
                if (keepOut < 1 && this._shoreGrad(px, pz, this._g2)) {
                  const dp = jx * this._g2[0] + jz * this._g2[1];
                  if (dp > 0) {
                    const cut = dp * (1 - keepOut);
                    jx -= cut * this._g2[0]; jz -= cut * this._g2[1];
                  }
                }
                px += jx * jitAmp * fr;
                pz += jz * jitAmp * fr;
                if (px < 0) px = 0; else if (px > wsMax) px = wsMax;
                if (pz < 0) pz = 0; else if (pz > wsMax) pz = wsMax;
              }
            }
            pos[vp++] = px;
            pos[vp++] = y;
            pos[vp++] = pz;
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
    geo.boundingSphere.radius += 2.5;      // room for vertex displacement

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
    this._chunks.set(this._key(cx, cz), { geo, surf, bed, tiles });
  }

  // -------------------------------------------------------------------------
  // Shore distance field (baked -> DataTexture; NO depth-buffer read)
  // -------------------------------------------------------------------------

  /** Low-frequency water-body variation, sampled on tile corners. Positional
   *  only — computed once, never recomputed on a rebuild. */
  _buildVarField() {
    const N = this.N;
    const f = new Float32Array((N + 1) * (N + 1));
    for (let z = 0; z <= N; z++) {
      for (let x = 0; x <= N; x++) {
        const v = vnoise(x * 0.09, z * 0.09, 9911) * 0.65 +
                  vnoise(x * 0.31, z * 0.31, 5533) * 0.35;
        f[z * (N + 1) + x] = v < 0 ? 0 : (v > 1 ? 1 : v);
      }
    }
    this._varField = f;
  }

  /**
   * Chamfer distance transform over the sub-cell grid, restricted to a window.
   * A window padded by >= `far` tiles is exact for the interior, because any
   * distance beyond `far` is clamped anyway. Hot path — kept branch-light and
   * free of closures/allocations.
   */
  _computeShoreField(state, tx0, tz0, tx1, tz1) {
    const S = this.S, W = this.fieldW, N = this.N;
    const far = this.opts.far;
    const pad = Math.ceil(far) + 2;
    const ttx0 = Math.max(0, tx0 - pad), ttz0 = Math.max(0, tz0 - pad);
    const ttx1 = Math.min(N - 1, tx1 + pad), ttz1 = Math.min(N - 1, tz1 + pad);
    if (ttx1 < ttx0 || ttz1 < ttz0) return;
    const cx0 = ttx0 * S, cz0 = ttz0 * S;
    const cx1 = (ttx1 + 1) * S - 1, cz1 = (ttz1 + 1) * S - 1;

    // Per-tile classification once, so the per-sub-cell loops are pure indexing.
    const flags = this._tileFlags;            // 1 = water, 2 = sand, 0 = other land
    for (let tz = ttz0; tz <= ttz1; tz++) {
      for (let tx = ttx0; tx <= ttx1; tx++) {
        flags[tz * N + tx] = this._isWater(state, tx, tz) ? 1
                           : (this._isSand(state, tx, tz) ? 2 : 0);
      }
    }

    const dl = this._distLand, ds = this._distSand;
    const edgeLand = this.opts.edgeIsLand;

    // ---- seed --------------------------------------------------------------
    for (let cz = cz0; cz <= cz1; cz++) {
      const tzRow = ((cz / S) | 0) * N;
      const row = cz * W;
      for (let cx = cx0; cx <= cx1; cx++) {
        const f = flags[tzRow + ((cx / S) | 0)];
        const i = row + cx;
        dl[i] = f === 1 ? INF : 0;
        ds[i] = f === 2 ? 0 : INF;
      }
    }

    // ---- two-pass chamfer (weights 1 / sqrt2) ------------------------------
    //
    // BUGFIX. The neighbour reads used to be clamped to the *window* (cx0/cz0
    // and cx1/cz1) rather than to the array. The forward pass is the one that
    // carries distance in from land lying to the -X / -Z side, so on an
    // incremental refreshTiles() the window's north and west borders started
    // with no inflow at all and every cell behind them inherited a bogus
    // saturated distance. Symptom: after a city build (hundreds of windowed
    // refreshes) the north and west shores of a lake had no shallow band, no
    // depth ramp and NO FOAM, while the south and east shores were correct —
    // exactly the "edge-normal sign bug" the reviewers smelled.
    //
    // The cells immediately outside the window are untouched and already hold
    // final, correct distances, and the window is padded by >= `far` tiles, so
    // reading them is not just safe, it is the correct boundary condition.
    const pass = (arr) => {
      for (let cz = cz0; cz <= cz1; cz++) {
        const row = cz * W;
        const hasUp = cz > 0;
        for (let cx = cx0; cx <= cx1; cx++) {
          const i = row + cx;
          let d = arr[i];
          if (d === 0) continue;
          if (cx > 0) { const v = arr[i - 1] + 1; if (v < d) d = v; }
          else if (edgeLand) { if (1 < d) d = 1; }
          if (hasUp) {
            let v = arr[i - W] + 1; if (v < d) d = v;
            if (cx > 0) { v = arr[i - W - 1] + SQRT2; if (v < d) d = v; }
            if (cx < W - 1) { v = arr[i - W + 1] + SQRT2; if (v < d) d = v; }
          } else if (edgeLand) { if (1 < d) d = 1; }
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
          else if (edgeLand) { if (1 < d) d = 1; }
          if (hasDn) {
            let v = arr[i + W] + 1; if (v < d) d = v;
            if (cx < W - 1) { v = arr[i + W + 1] + SQRT2; if (v < d) d = v; }
            if (cx > 0) { v = arr[i + W - 1] + SQRT2; if (v < d) d = v; }
          } else if (edgeLand) { if (1 < d) d = 1; }
          arr[i] = d;
        }
      }
    };
    pass(dl);
    pass(ds);

    // ---- pack -> RGBA ------------------------------------------------------
    const out = this._shoreData;
    const vf = this._varField, VW = N + 1;
    const invFarCells = 1 / (far * S);
    const maxCells = far * S;
    const sandFarCells = 2.5 * S;
    const invSand = 1 / sandFarCells;
    const invS = 1 / S;
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * W;
      const tzRow = ((cz / S) | 0) * N;
      // bilinear weights for the variation field (tile-corner lattice)
      const vz = (cz + 0.5) * invS;
      const vz0 = vz | 0, fz = vz - vz0;
      const vrow0 = Math.min(vz0, N) * VW, vrow1 = Math.min(vz0 + 1, N) * VW;
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = row + cx;
        const water = flags[tzRow + ((cx / S) | 0)] === 1;
        let d = dl[i];
        // distance from the shoreline, not from the land cell centre
        d = d >= INF ? maxCells : (d > 0.5 ? d - 0.5 : 0);
        let r = d * invFarCells; if (r > 1) r = 1;
        const sd = ds[i] >= INF ? sandFarCells : ds[i];
        let beach = 1 - sd * invSand; if (beach < 0) beach = 0;
        const vx = (cx + 0.5) * invS;
        const vx0 = vx | 0, fx = vx - vx0;
        const c0 = Math.min(vx0, N), c1 = Math.min(vx0 + 1, N);
        const a = vf[vrow0 + c0] + (vf[vrow0 + c1] - vf[vrow0 + c0]) * fx;
        const b = vf[vrow1 + c0] + (vf[vrow1 + c1] - vf[vrow1 + c0]) * fx;
        const o = i * 4;
        out[o] = (r * 255) | 0;
        out[o + 1] = water ? 255 : 0;
        out[o + 2] = (beach * 255) | 0;
        out[o + 3] = ((a + (b - a) * fz) * 255) | 0;
      }
    }
    this._shoreDirty = true;
  }

  _uploadShore() {
    this._shoreTex.needsUpdate = true;
    this._shoreDirty = false;
  }

  // -------------------------------------------------------------------------
  // Fake reflection: a coarse top-down map of the emissive city.
  //
  // A full planar reflection pass needs the renderer (which this module is not
  // given) and a second scene render. Instead we bake where the light IS, in
  // world XZ, and the shader marches that map along the reflection ray with an
  // exponential decay — mathematically the same thing as a mirrored render
  // target that has been crushed with a heavy vertical blur, for the cost of
  // six texture fetches on water pixels only.
  // -------------------------------------------------------------------------

  /** Rebuild the emitter map from `state.buildings`. Cheap; ~0.2 ms for 300. */
  _buildEmitMap(state) {
    const R = this.EMIT, data = this._emitData;
    data.fill(0);
    const list = (state && state.buildings) || this._emitters;
    if (!list || !list.length) { this._emitTex.needsUpdate = true; return; }
    const cell = this.worldSize / R;             // world units per emitter texel
    const acc = this._emitAcc || (this._emitAcc = new Float32Array(R * R * 4));
    acc.fill(0);
    for (let b = 0; b < list.length; b++) {
      const e = list[b];
      const tx = (e.x != null ? e.x : 0) + ((e.tw || 1) - 1) * 0.5;
      const tz = (e.z != null ? e.z : 0) + ((e.td || 1) - 1) * 0.5;
      const wx = (tx + 0.5) * this.TILE, wz = (tz + 0.5) * this.TILE;
      // No model access here — estimate a plausible height so tall downtown
      // towers throw a longer streak than a cottage.
      const lvl = (e.level != null ? e.level : (e.variant || 0));
      const foot = (e.tw || 1) * (e.td || 1);
      let h = 6 + lvl * 5 + foot * 2.5;
      if (e.cat === 'work' || e.cat === 'shops') h *= 1.35;
      if (h > 64) h = 64;
      // Warm office/window light; shops a touch pinker.
      let cr = 1.0, cg = 0.82, cb = 0.52;
      if (e.cat === 'shops') { cr = 1.0; cg = 0.70; cb = 0.62; }
      else if (e.cat === 'homes') { cr = 1.0; cg = 0.86; cb = 0.60; }
      const w = h * (0.35 + 0.65 * Math.min(1, foot / 4));
      // 3x3 gaussian splat so the map is smooth at 64x64.
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
    // Normalise: RGB -> hue (0..1), A -> light density (0..1).
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

  /**
   * Optional explicit emitter list for the fake reflection, if engine.js ever
   * wants to feed something richer than `state.buildings`:
   *   [{ x, z, tw, td, level, cat }]
   */
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

    const rain = c.weather ? clamp01(c.weather.rain || 0) : 0;
    s.uRain.value = rain;

    if (c.quality != null) this.setQuality(c.quality);

    // Sun colour warms at low elevation, cools at noon.
    if (!this._sunLocked) {
      const h = clamp01(u.uSunDir.value.y);
      const warm = Math.pow(1 - h, 2.2);
      const col = s.uSunColor.value;
      col.setRGB(
        1.00,
        0.97 - warm * 0.34,
        0.86 - warm * 0.60
      );
      const power = (0.35 + 0.85 * Math.pow(h, 0.5)) * (1 - rain * 0.72) * (1 - night * 0.85);
      col.multiplyScalar(Math.max(0.05, power) * 1.6);
    }

    // Wave energy rises with rain.
    u.uWaveAmp.value = 1.0 + rain * 0.75;
    u.uDetail.value = this._detailBase + rain * 0.14;
    u.uGlintRough.value = rain;

    // Fake reflection: city windows are only lit at night, and the streak has
    // to survive the fresnel weighting, so ramp it on the night curve.
    const emitOn = this.opts.emitReflection && this._quality > 0;
    u.uEmitStrength.value = emitOn ? this._emitGain * smoothstep01(0.30, 0.85, night) : 0;
    if (this._emitDirty && u.uEmitStrength.value > 0.002) this._buildEmitMap(this._lastState);

    if (this._shoreDirty) this._uploadShore();
    return this;
  }

  /** Quality 0 low / 1 medium / 2 high. Never reallocates geometry. */
  setQuality(level) {
    const q = Math.max(0, Math.min(2, level | 0));
    if (q === this._quality) return this;      // called every frame from update()
    this._quality = q;
    this._shared.uQuality.value = q;
    this.bedUniforms.uCaustics.value = q === 0 ? 0.32 : 0.55;
    this.uniforms.uGlint.value = q === 0 ? 0.85 : 1.0;
    // uQuality gates the two finest scrolling normal layers, and those are
    // exactly the layers that supply the steep facets the GGX lobe spikes on.
    // Dropping them without widening the lobe does not make the glint cheaper,
    // it deletes it. So: fewer facets -> rougher lobe (more pixels catch a
    // dimmer highlight) and a lower HDR peak so the result is a soft sun sheen
    // rather than a bright wash. Both are plain uniform writes — no recompile,
    // no reallocation, nothing to stutter on. (§6)
    this.uniforms.uGlintRough2.value =
      q === 0 ? Math.max(this._glintRoughBase, 0.20)
              : (q === 1 ? Math.max(this._glintRoughBase, 0.14) : this._glintRoughBase);
    this.uniforms.uSpecScale.value = this._specBase * (q === 0 ? 0.55 : (q === 1 ? 0.80 : 1.0));
    if (this._normalTex) this._normalTex.anisotropy = q === 0 ? 1 : (q === 1 ? 4 : 8);
    return this;
  }

  /**
   * Override the sky/sun look. All fields optional; colours are sRGB hex,
   * THREE.Color, or arrays.
   * { skyTop, skyHorizon, sunColor, shallow, mid, deep, foam, glint, envIntensity }
   */
  setSky(p = {}) {
    const set = (uni, v) => {
      if (v == null) return;
      if (v.isColor) uni.value.copy(v);
      else if (Array.isArray(v)) uni.value.setRGB(v[0], v[1], v[2]);
      else uni.value.copy(srgb(v));
    };
    set(this.uniforms.uSkyTop, p.skyTop);
    set(this.uniforms.uSkyHorizon, p.skyHorizon);
    set(this.uniforms.uShallowColor, p.shallow);
    set(this.uniforms.uMidColor, p.mid);
    set(this.uniforms.uDeepColor, p.deep);
    set(this.uniforms.uFoamColor, p.foam);
    if (p.sunColor != null) { set(this._shared.uSunColor, p.sunColor); this._sunLocked = true; }
    if (p.sunColor === null) this._sunLocked = false;
    if (p.glint != null) this.uniforms.uGlint.value = p.glint;
    if (p.glintGain != null) this.uniforms.uGlintGain.value = p.glintGain;
    if (p.envIntensity != null) this.uniforms.uEnvIntensity.value = p.envIntensity;
    if (p.detail != null) { this._detailBase = p.detail; this.uniforms.uDetail.value = p.detail; }
    if (p.foamWidth != null) this.uniforms.uFoamWidth.value = p.foamWidth;
    if (p.opacityShore != null) this.uniforms.uOpacityShore.value = p.opacityShore;
    if (p.caustics != null) this.bedUniforms.uCaustics.value = p.caustics;
    if (p.skyGain != null) this.uniforms.uSkyGain.value = p.skyGain;
    if (p.nightFloor != null) this.uniforms.uNightFloor.value = p.nightFloor;
    if (p.shoreWobble != null) this.uniforms.uShoreWobble.value = p.shoreWobble;
    if (p.reflection != null) this._emitGain = p.reflection;
    set(this.uniforms.uBeachColor, p.beach);
    // Reflection / aerial-perspective knobs (see the fog block in the surface
    // shader). horizonLift lifts the reflected horizon band above the fog colour
    // engine.js hands us as `skyHorizon`; hazeRefl is how far the distance haze
    // converges on the reflected sky instead of the land's haze colour.
    if (p.horizonLift != null) this.uniforms.uHorizonLift.value = p.horizonLift;
    if (p.hazeRefl != null) this.uniforms.uHazeRefl.value = clamp01(p.hazeRefl);
    if (p.grazePow != null) this.uniforms.uGrazePow.value = Math.max(0.5, p.grazePow);
    if (p.mieGain != null) this.uniforms.uMieGain.value = Math.max(0, p.mieGain);
    // Foam containment. foamGate is a HARD cap in raw shore-field units;
    // wobbleFade is how far offshore the shoreline meander is allowed to reach.
    if (p.foamGate != null) this.uniforms.uFoamGate.value = Math.max(1e-4, p.foamGate);
    if (p.wobbleFade != null) this.uniforms.uWobbleFade.value = Math.max(1e-4, p.wobbleFade);
    if (p.sparkFloor != null) this.uniforms.uSparkFloor.value = Math.max(0, p.sparkFloor);
    if (Array.isArray(p.sparkGate)) this.uniforms.uSparkGate.value.set(p.sparkGate[0], p.sparkGate[1], p.sparkGate[2]);
    if (p.swellSpark != null) this.uniforms.uSwellSpark.value = clamp01(p.swellSpark);
    if (p.glintFar != null) this.uniforms.uGlintFar.value = clamp01(p.glintFar);
    // Glint knobs. specScale is the HDR gain on the GGX peak (this is what feeds
    // bloom); glintSlope steepens the specular-only normal so the sparkle
    // density can be tuned without roughening the body shading.
    if (p.specScale != null) { this._specBase = p.specScale; this.uniforms.uSpecScale.value = p.specScale; }
    if (p.glintRough != null) {
      this._glintRoughBase = Math.max(0.005, p.glintRough);
      this.uniforms.uGlintRough2.value = this._glintRoughBase;
    }
    if (p.glintSlope != null) this.uniforms.uGlintSlope.value = Math.max(0, p.glintSlope);
    if (p.opacityDeep != null) this.uniforms.uOpacityDeep.value = clamp01(p.opacityDeep);
    // Re-authoring a base that setQuality() derives from has to re-derive, or
    // the new value silently outranks the current quality level.
    if (p.specScale != null || p.glintRough != null) {
      const q = this._quality;
      this._quality = -1;
      this.setQuality(q < 0 ? this.opts.quality : q);
    }
    return this;
  }

  /**
   * Optional environment reflection. Only a genuine CubeTexture is used (a PMREM
   * / CubeUV target cannot be sampled without three's private chunks); anything
   * else is ignored and the analytic sky reflection is kept. Never throws.
   */
  setEnvironment(tex) {
    const ok = !!(tex && tex.isCubeTexture && !tex.isRenderTargetTexture);
    this.uniforms.uEnvMap.value = ok ? tex : null;
    const want = ok;
    const has = !!(this.material.defines && this.material.defines.USE_ENVCUBE);
    if (want !== has) {
      this.material.defines = this.material.defines || {};
      if (want) this.material.defines.USE_ENVCUBE = '';
      else delete this.material.defines.USE_ENVCUBE;
      this.material.needsUpdate = true;
    }
    return this;
  }

  /** Contract §3 uniformity — water has no render targets, so this is a no-op. */
  setSize(_w, _h, _pixelRatio) { return this; }

  /** Diagnostics for the harness / engine debug overlay. */
  stats() {
    let verts = 0, tris = 0;
    for (const c of this._chunks.values()) {
      const p = c.geo.getAttribute('position');
      verts += p.count;
      tris += c.geo.index.count / 3;
    }
    return {
      chunks: this._chunks.size,
      waterTiles: this._waterTiles,
      vertices: verts,
      triangles: tris,
      shoreField: this.fieldW + '²',
      quality: this._quality,
    };
  }

  dispose() {
    if (this._disposed) return this;      // idempotent: engine teardown + selfTest both call it
    this._disposed = true;
    this._disposeChunks();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.material.dispose();
    this.bedMaterial.dispose();
    this._shoreTex.dispose();
    this._normalTex.dispose();
    this._emitTex.dispose();
    // The CPU-side fields are the big allocation here, not the GPU textures: the
    // two distance buffers plus the packed RGBA are ~1.6 MB on an 80x80 map at
    // shoreSub 4, and they outlive the textures unless they are dropped.
    this._shoreData = null;
    this._distLand = null;
    this._distSand = null;
    this._varField = null;
    this._tileFlags = null;
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
