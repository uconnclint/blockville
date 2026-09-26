// src/render/sky.js — CONTRACTS-RENDER.md §3.2
//
// Atmospheric sky dome for the voxel city.
//
//   • Preetham-style analytic single-scattering (written here, not imported —
//     nothing from three/addons is vendored, so THREE.Sky does not exist).
//   • Sun disc with limb darkening + Mie forward-scatter glow.
//   • Spectacular sunrise / sunset: warm horizon band, purple counter-glow.
//   • Deep magical night: gradient, procedural twinkling stars, nebula wash,
//     crater-mapped moon with halo.
//   • Puffy cumulus cloud layer: pseudo-volumetric, but DOME-MAPPED — the deck
//     is a spherical shell over a curved planet, not a flat plane projected by
//     dir.xz/dir.y. That projection has a pole at the horizon, which is why the
//     previous build faded cloud alpha out below ~17° elevation.
//   • Stars + a LOW moon, gated so they cost nothing during the day.
//   • City sky glow via setCityGlow({x, z, amount}).
//   • PMREM environment map regenerated on a low cadence for IBL.
//
// ---------------------------------------------------------------------------
// TWO RULES THIS FILE NOW OBEYS (both were measured defects)
//
// 1. EVERY band that hugs the horizon is pow(1 - max(dir.y, 0), k).
//    Nothing here may use exp(-(y/s)^p) with p > 1, or smoothstep in y, for a
//    horizon band: both are FLAT at dir.y == 0 (zero derivative), and the only
//    sky this game's camera ever frames is 0..6 deg. Every one of them
//    quantised into a frame-wide constant plate — measured 45 identical device
//    rows — and then terminated in a near-zero-width edge. See horizonBand().
//
// 2. The dome draws uHorizonRef * uHorizonLift at dir.y == 0, and
//    uHorizonLift MUST equal terrain.js's uniform of the same name (engine.js
//    sets it to 2.2). terrain.js adds that lift to its own <fog_fragment>
//    result so distant land does not fade darker than the sky; the dome used to
//    converge only 62 % of the way to plain fogColor, so the land skirt sat at
//    2.2x and the dome above it at 1.0x — a 57/255 cliff along the whole
//    skyline. If either number moves, they must move together.
//
// ---------------------------------------------------------------------------
// THE CONSTRAINT THAT SHAPES EVERYTHING HERE
//
// The game's orbit camera is clamped to polar 0.35..1.2 with a 40° vertical
// FOV. At polar 1.2 — the most horizontal the player can ever get — the top of
// the frame sits about 1° BELOW the horizon at frame centre and ~4° above it in
// the corners. The demo `waterfront` shot (polar 1.28) tops out at +3.3°.
// Measured, not assumed: unproject(0, 1) on the live camera.
//
// So the entire visual budget of this module has to be spent between 0° and
// roughly 6° of elevation. A sun disc at 19° (golden hour), a moon mirrored
// 60° opposite the sun, and a cloud deck that fades below 17° are all
// mathematically invisible in this game. Hence:
//   - clouds run all the way down to dir.y == 0 and get DENSER toward it,
//   - the sun's contribution at these angles is the Mie forward-scatter band,
//     not the disc,
//   - the moon rides an authored low arc (~4°) rather than the sun's mirror,
//   - the below-horizon hemisphere is a real graded band, because at polar
//     0.72 it is 100% of the frame behind the map.
//
// The dome is fog-exempt (RawShader-ish ShaderMaterial with no fog chunks) and
// never touches scene.fog — engine.js keeps ownership of that. `update()`
// hands back a lighting suggestion instead.
//
// No npm, no build step, no network, no binary assets: the only texture is a
// 256² tileable fBm/cellular atlas generated on the CPU at construction.

import * as THREE from '../../vendor/three.module.js';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Physical-ish constants (shared by the GLSL and the JS mirror)
// ---------------------------------------------------------------------------

// Total Rayleigh scattering at sea level, per metre, for (680,550,450)nm.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
// Mie (aerosol) magnitude constant; scaled by turbidity + mieCoefficient.
const MIE_CONST = 1.8399918514433978e14;
const RAYLEIGH_ZENITH = 8.4e3;   // metres
const MIE_ZENITH = 1.25e3;       // metres
const SUN_EE = 1000.0;
const CUTOFF_ANGLE = 1.74;   // ~99.7° — a wider twilight than Preetham's 92.3°,
                             // so dusk keeps colour well after the sun crosses.
const STEEPNESS = 1.5;

// ---------------------------------------------------------------------------
// Procedural noise atlas (CPU, 256², RGBA)
//   R = 5-octave tileable value-noise fBm    (cumulus base shape)
//   G = 4-octave fBm, higher base frequency  (erosion)
//   B = inverted tileable cellular / worley  (puffy blobs)
//   A = 3-octave high-frequency fBm          (edge detail / wisps)
// ---------------------------------------------------------------------------

function ihash(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function wrapi(v, p) { return ((v % p) + p) % p; }

function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrapi(xi, period), x1 = wrapi(xi + 1, period);
  const y0 = wrapi(yi, period), y1 = wrapi(yi + 1, period);
  const n00 = ihash(x0, y0, seed), n10 = ihash(x1, y0, seed);
  const n01 = ihash(x0, y1, seed), n11 = ihash(x1, y1, seed);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

function fbm(u, v, baseFreq, octaves, seed) {
  let amp = 0.5, sum = 0, norm = 0, f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * f, v * f, f, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// Tileable cellular noise: `cells`×`cells` grid, one feature point per cell.
function cellular(u, v, cells, seed) {
  const cx = Math.floor(u * cells), cy = Math.floor(v * cells);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx, gy = cy + dy;
      const wx = wrapi(gx, cells), wy = wrapi(gy, cells);
      const px = (gx + ihash(wx, wy, seed)) / cells;
      const py = (gy + ihash(wx, wy, seed + 77)) / cells;
      const ddx = u - px, ddy = v - py;
      const d = ddx * ddx + ddy * ddy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best) * cells;   // ~0..1.2
}

function makeNoiseTexture(size, seed) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const r = fbm(u, v, 4, 5, seed);
      const g = fbm(u, v, 8, 4, seed + 911);
      const c = cellular(u, v, 8, seed + 313);
      const b = 1.0 - Math.min(1, c);          // inverted worley → round blobs
      const a = fbm(u, v, 24, 3, seed + 2027);
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp(r, 0, 1) * 255);
      data[i + 1] = Math.round(clamp(g, 0, 1) * 255);
      data[i + 2] = Math.round(clamp(b, 0, 1) * 255);
      data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  // The dome is a unit sphere scaled uniformly and re-centred on the camera,
  // so object-space position IS the world view direction. Works identically
  // for the tiny copy used by the PMREM cube camera.
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uMoonU;
uniform vec3  uMoonV;
uniform float uTime;
uniform float uNight;        // 0 day .. 1 full night
uniform float uOvercast;     // 0 clear .. 1 solid grey lid
uniform float uSnowy;        // cools + brightens the overcast lid
uniform sampler2D uNoise;

uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uMieG;
uniform float uSunE;
uniform float uSunUpFade;    // ~1 while the sun is above the horizon
uniform float uHorizFade;    // pow(1 - max(sunY,0), 5)
uniform float uExposure;
uniform float uSaturation;

uniform float uSunDiscSize;
uniform float uSunDiscPower;
uniform vec3  uSunTint;
uniform float uMieGlow;      // strength of the horizon forward-scatter band

uniform float uCloudScale;
uniform float uCloudCoverage;
uniform float uCloudSharp;
uniform float uCloudR;       // planet radius / deck altitude — controls how fast
                             // the deck converges toward the horizon
uniform vec2  uWind;
uniform float uCloudLightStep;
uniform float uHighCloud;

uniform float uStars;
uniform vec3  uNightZenith;
uniform vec3  uNightHorizon;
uniform vec3  uHorizonRef;   // linear colour the dome MUST show at dir.y == 0.
                             // engine.js drives scene.fog.color from the same
                             // value, so terrain and sky meet without a seam.
uniform float uHorizonLift;  // how much BRIGHTER than scene.fog.color the dome
                             // draws at dir.y == 0. terrain.js adds exactly the
                             // same lift to its own <fog_fragment> result
                             // (uHorizonLift, set to 2.2 by engine.js), so the
                             // land skirt and the dome behind it land on the
                             // same radiance instead of a 57/255 cliff.
uniform float uHazeK;        // horizon-glow falloff exponent, pow(1-dir.y, k)
uniform float uGroundK;      // below-horizon aerial-perspective exponent
uniform float uMieK;         // Mie forward-scatter band falloff exponent
uniform float uCityK;        // city-glow band falloff exponent
uniform float uCityBelowK;   // city-glow decay BELOW the horizon
uniform float uDither;       // low-bit dither amplitude (fraction of the value)
uniform vec3  uWarmHue;      // luminance-normalised warm-horizon hue
uniform float uWarm;         // 0 = high sun .. 1 = golden hour (mirrors
                             // lighting.js's _skylightWarmAmount ramp, 34->18 deg)
uniform vec3  uGroundDeep;   // dome colour looking straight down
uniform vec4  uCityGlow;     // xy = unit horizontal dir to the city centroid,
                             // z = amount 0..1, w = directional focus exponent
uniform vec3  uCityGlowColor;
// Art-directed IBL (ENV_PASS only — the PMREM bake, never the visible dome).
// See "DAYTIME ART DIRECTION" in the Sky constructor.
uniform float uEnvArt;       // 0 = physical sky IBL .. 1 = the authored studio dome
uniform vec3  uEnvUp;        // radiance straight up
uniform vec3  uEnvHor;       // radiance at the horizon
uniform vec3  uEnvGnd;       // radiance straight down (sunlit ground bounce)
uniform vec3  uEnvSun;       // broad lobe toward the key (colour * strength)
uniform float uEnvUpPow;     // zenith concentration of the up-dome gradient (higher = top-heavier)

const float PI = 3.141592653589793;

// ---- helpers --------------------------------------------------------------

float rayleighPhase(float c) { return (3.0 / (16.0 * PI)) * (1.0 + c * c); }

float hgPhase(float c, float g) {
  float g2 = g * g;
  float d = max(1e-4, 1.0 + g2 - 2.0 * g * c);
  return (1.0 / (4.0 * PI)) * ((1.0 - g2) / (d * sqrt(d)));
}

float opticalMass(float cosZ) {
  float deg = degrees(acos(clamp(cosZ, -1.0, 1.0)));
  return 1.0 / (cosZ + 0.15 * pow(max(0.001, 93.885 - deg), -1.253));
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---- the one horizon profile every band in this shader is built from -------
//
// THE SHAPE OF THIS FUNCTION IS THE FIX FOR THE HORIZON SEAM.
//
// Everything that used to hug the horizon here — the fog anchor
// (exp(-|y|*34)*0.62), the Mie forward-scatter band (exp(-(y/0.26)^1.6)), the
// city-glow band (exp(-(y/0.075)^1.4)) and the below-horizon ramp
// (smoothstep(0, 0.66, -y)) — shared two defects:
//
//   1. exp(-(y/s)^p) with p > 1 has ZERO derivative at y == 0. Its interior is
//      mathematically constant for the first few degrees, which is precisely
//      the band this game's camera lives in (0..6 deg). Measured: 45 identical
//      rows. Likewise smoothstep(0, 0.66, dn) moves by 0.007 over the 1.8 deg
//      of dip the frame actually contains — a flat plate.
//   2. They were then terminated by a narrow smoothstep in y (-0.09..0.0,
//      -0.05..0.01), i.e. a near-zero-width edge across the whole frame.
//
// pow(1 - max(dir.y, 0), k) has neither problem: its derivative at the horizon
// is -k (never flat), it is monotone over the whole 0..90 deg range, and it
// reaches ~0 by 35 deg for k in 6..10 without any cutoff to terminate it.
float horizonBand(float y, float k) {
  return pow(max(1.0 - clamp(y, 0.0, 1.0), 0.0), k);
}

// Rotate c toward uWarmHue at c's own luminance. Same trick lighting.js uses
// for the skylight fill: the swing is (nearly) pure chroma, so warming the sky
// does not quietly darken it.
vec3 warmRot(vec3 c, float w) {
  return mix(c, uWarmHue * luma(c), clamp(w, 0.0, 1.0));
}

// The radiance the dome MUST draw at dir.y == 0 for the land to dissolve into.
vec3 hazeColor() { return uHorizonRef * uHorizonLift; }

// ---- atmosphere -----------------------------------------------------------

vec3 atmosphere(vec3 dir) {
  float cosZ = max(dir.y, 0.0);
  float m = opticalMass(cosZ);
  vec3 Fex = exp(-(uBetaR * (${RAYLEIGH_ZENITH.toFixed(1)} * m) + uBetaM * (${MIE_ZENITH.toFixed(1)} * m)));

  float cosTheta = dot(dir, uSunDir);
  vec3 bR = uBetaR * rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 bM = uBetaM * hgPhase(cosTheta, uMieG);
  vec3 tot = uBetaR + uBetaM;

  vec3 Lin = pow(max(vec3(0.0), uSunE * ((bR + bM) / tot) * (1.0 - Fex)), vec3(1.5));
  Lin *= mix(vec3(1.0),
             pow(max(vec3(0.0), uSunE * ((bR + bM) / tot) * Fex), vec3(0.5)),
             uHorizFade);
  return Lin;
}

// ---- stars ----------------------------------------------------------------

// Stars are sized in *screen* terms: the game's visible sky is only a few
// degrees tall and post.js puts the whole dome behind the tilt-shift focus
// plane, so a 1-pixel pinprick is blurred to nothing. These are deliberately
// fat and bright — this is a kid's magical night sky, not an astronomy sim.
float starLayer(vec3 dir, float cells, float thresh, float rad, float seed) {
  vec3 d = dir * cells + seed;
  vec3 cell = floor(d);
  vec3 f = fract(d);
  vec3 h = hash33(cell);
  float present = step(thresh, h.z);
  vec3 sp = 0.2 + 0.6 * vec3(h.x, h.y, fract(h.z * 73.7));
  float dist = length(f - sp);
  float mag = 0.45 + 0.55 * h.y * h.y;
  float tw = 0.45 + 0.55 * sin(uTime * (1.1 + h.x * 3.4) + h.y * 41.0);
  float core = smoothstep(rad, rad * 0.12, dist);
  float glow = smoothstep(rad * 4.0, 0.0, dist) * 0.30;
  // Four-point diffraction spike on the brightest stars — survives the DOF
  // blur far better than a round dot of the same energy.
  vec2 q = (f.xy - sp.xy) / rad;
  float spike = exp(-abs(q.x) * 3.0) * exp(-abs(q.y) * 26.0)
              + exp(-abs(q.y) * 3.0) * exp(-abs(q.x) * 26.0);
  return present * mag * tw * (core + glow + spike * 0.10 * step(0.62, h.y));
}

vec3 starField(vec3 dir) {
  float s = starLayer(dir, 58.0, 0.905, 0.150, 0.0)
          + starLayer(dir, 118.0, 0.945, 0.105, 17.0) * 0.70;
  // Faint colour variety: warm giants / blue-white dwarfs.
  vec3 tint = mix(vec3(1.0, 0.84, 0.66), vec3(0.72, 0.85, 1.0),
                  hash33(floor(dir * 30.0)).x);
  // Denser toward a soft "milky way" great circle for a magical read.
  float band = exp(-pow(dot(dir, normalize(vec3(0.55, 0.30, -0.78))) * 3.1, 2.0));
  return s * tint * (0.75 + 0.9 * band);
}

// ---- moon -----------------------------------------------------------------

vec3 moon(vec3 dir) {
  float cd = dot(dir, uMoonDir);
  float ang = acos(clamp(cd, -1.0, 1.0));
  float R = 0.052;
  float disc = smoothstep(R, R * 0.94, ang);
  // Local sphere normal across the disc.
  float u = dot(dir, uMoonU) / R;
  float v = dot(dir, uMoonV) / R;
  float r2 = clamp(u * u + v * v, 0.0, 1.0);
  vec3 nrm = normalize(vec3(u, v, sqrt(max(0.0001, 1.0 - r2))));
  // Craters / maria from the noise atlas, projected on the disc.
  vec4 nz = texture2D(uNoise, vec2(u, v) * 0.34 + 0.5);
  float maria = smoothstep(0.38, 0.66, nz.r) * 0.42;
  float craters = smoothstep(0.45, 0.92, nz.b) * 0.34;
  float shade = 0.40 + 0.60 * clamp(dot(nrm, normalize(vec3(0.45, 0.36, 0.82))), 0.0, 1.0);
  shade *= (1.0 - maria) * (1.0 - craters * 0.7);
  // Kept just under 1 so the craters survive instead of clipping to a white pill.
  vec3 body = vec3(0.99, 0.96, 0.88) * shade * disc * 0.88;
  float halo = exp(-ang * 6.5) * 0.16 + exp(-ang * 15.0) * 0.34 + exp(-ang * 42.0) * 0.60;
  return body + vec3(0.72, 0.80, 1.0) * halo;
}

// ---- clouds ---------------------------------------------------------------

// Distance along dir from a ground observer to a spherical shell of altitude
// h over a planet of radius R (both in units of the deck's base altitude).
//
// This is what replaced the old dir.xz/dir.y flat-plane projection. That
// projection has a pole at dir.y == 0: the deck goes edge-on and its uv runs to
// infinity, which is why the previous build had to fade cloud alpha out below
// ~17° elevation — and why the clouds were invisible at every camera angle the
// game can actually produce (the visible sky band is 0..6° at the game's
// maximum polar of 1.2). On a shell the distance is bounded: t == h overhead,
// t == sqrt(2Rh + h²) at the horizon. Clouds simply *compress* toward the
// horizon, exactly like a real cumulus deck, and never blow up.
float shellT(float y, float R, float h) {
  return -R * y + sqrt(max(1e-6, R * R * y * y + 2.0 * R * h + h * h));
}

// Two decorrelated taps of the one 256² atlas, at incommensurate scales and
// rotated relative to each other. A single tap tiles visibly: at the camera
// angles this game uses, the deck spans ~30 texture periods around the horizon
// and the repeat reads as wallpaper. Two rotated octaves plus the caller's
// domain warp break it.
float cloudSample(vec2 uv, float cov, float bias, float sharp) {
  mat2 R = mat2(0.80, -0.60, 0.60, 0.80);
  vec4 n = texture2D(uNoise, uv, bias);
  vec4 m = texture2D(uNoise, R * uv * 0.53 + vec2(0.61, 0.29), bias);
  // Inverted-worley blobs carry the rounded cumulus shape; fBm breaks the edges.
  float blob = 0.58 * n.b + 0.42 * m.b;
  float shape = 0.55 * n.r + 0.45 * m.r;
  float d = blob * 0.70 + shape * 0.30;
  d = d - (1.0 - cov);
  d -= m.g * 0.15 * (1.0 - cov * 0.55);   // erode the fringes
  d -= n.a * 0.07;
  return clamp(d * uCloudSharp * sharp, 0.0, 1.0);
}

// One extra tap at an incommensurate scale modulates coverage over a much
// longer period, which hides the 1-tile repeat of the 256² atlas.
float coverageMod(vec2 uv) {
  return texture2D(uNoise, uv * 0.121 + vec2(0.31, 0.67)).r;
}

// Returns rgb = lit cloud colour, a = coverage alpha.
vec4 cloudLayer(vec3 dir, float scale, vec2 wind, float cov, float thick,
                vec3 sunCol, vec3 skyCol, float lightStep, float altScale) {
  float y = dir.y;
  float R = uCloudR;
  float t0 = shellT(y, R, altScale);
  // How edge-on we are: 0 overhead, 1 at the horizon. Drives LOD bias, extra
  // optical depth, and the haze wash — instead of an alpha fade to nothing.
  float graze = clamp((t0 / altScale - 1.0) / (sqrt(2.0 * R / altScale + 1.0) - 1.0), 0.0, 1.0);
  // Compressed uv needs a matching mip or it aliases into grey static.
  float bias = clamp(log2(t0 / altScale) * 0.62, 0.0, 2.0);
  // Mip-blurring the density field also flattens its contrast, which is what
  // turned the horizon band into a featureless grey lid. Push the sharpening
  // back up by the same amount so distant cumulus keep their edges.
  float sharp = 1.0 + 1.35 * graze;

  vec2 base = dir.xz * (t0 * scale) + wind;
  // Big soft cloudy / clear regions, and no visible tile seam.
  // A grazing ray threads a long chord through the deck and clips many more
  // clouds, so coverage genuinely RISES toward the horizon. This is what turns
  // the deck into a proper bank of cumulus sitting on the skyline instead of
  // thinning out exactly where this game's camera is looking.
  cov = clamp(cov * (0.60 + 0.85 * coverageMod(base)) * (1.0 + 0.85 * graze * graze * graze), 0.0, 1.0);
  // Low-frequency domain warp, applied identically to every shell so the
  // parallax survives. This is what stops the deck reading as a grid.
  vec2 warp = (texture2D(uNoise, base * 0.081 + vec2(0.21, 0.53), bias).ra - 0.5) * 0.80;

  // Pseudo-volume: N shells climbing the slab. The parallax between them is
  // large near the horizon (you look *through* the deck) and small overhead,
  // which is exactly the free volumetric cue we want.
  // Shell spacing is deliberately tight: at grazing angles the parallax
  // between two widely-separated shells becomes a long radial smear, which
  // reads as streaks rather than as volume.
  vec2 p1 = dir.xz * (shellT(y, R, altScale * 1.045) * scale) + wind;
  vec2 p2 = dir.xz * (shellT(y, R, altScale * 1.095) * scale) + wind;
  float d0 = cloudSample(base + warp, cov, bias, sharp);
#if QSLICES >= 2
  float d1 = cloudSample(p1 + warp, cov, bias, sharp);
#else
  float d1 = d0;
#endif
#if QSLICES >= 3
  float d2 = cloudSample(p2 + warp, cov, bias, sharp);
#else
  float d2 = d1;
#endif
  float dens = (d0 + d1 + d2) / 3.0;
  float top = max(d0, max(d1, d2));

  // One cheap light step toward the sun for self-shadowing.
  vec2 sdir = normalize(uSunDir.xz + vec2(1e-4, 1e-4));
  float ls = cloudSample(base + warp + sdir * lightStep, cov, bias, sharp);

  // Grazing rays cut a much longer chord through the deck.
  float depth = thick * mix(1.0, 2.3, graze);
  float beer = exp(-1.8 * ls * depth);
  float powder = 1.0 - exp(-4.0 * dens * depth);
  // Shells climb in altitude, so (top shell - bottom shell) tells us whether we
  // are looking at a sunlit cauliflower crown or a shaded cloud base.
  float rise = clamp((d2 - d0) * 4.5 + 0.55, 0.0, 1.0);
  // Kid-friendly cumulus: mostly bright white, soft blue-grey undersides.
  float lightAmt = mix(0.28, 1.0, beer) * mix(0.78, 1.0, powder) * mix(0.60, 1.0, rise);

  // Sun-facing rim ("silver lining").
  float fwd = pow(max(dot(dir, uSunDir), 0.0), 5.0);
  float rim = fwd * max(0.0, top - dens) * 4.5;

  // A low sun does not light cumulus mint-white — it lights them gold. Without
  // this rotation the lit face measured (240,253,248) at golden hour (R/B 0.968,
  // clipping in green) because uSunTint is raised to the 0.35 power and lands
  // near white, and 1.62x of near-white blows straight through the top of the
  // grade. Rotate the key toward the warm horizon hue at constant luminance and
  // trim the gain, so the crown reads gold instead of clipping.
  vec3 keyCol = warmRot(sunCol, uWarm * 0.62);
  vec3 lit = keyCol * mix(1.62, 1.42, uWarm) + vec3(0.11, 0.12, 0.14) * (1.0 - uNight * 0.80);
  // Soft luminance shoulder: cumulus stay the brightest thing in frame but stop
  // running off the end of the grade in a single channel.
  float Ll = luma(lit);
  lit *= (Ll / (1.0 + max(0.0, Ll - 0.92) * 1.20)) / max(Ll, 1e-4);
  vec3 shadowRef = warmRot(vec3(0.46, 0.52, 0.64), uWarm * 0.45);
  vec3 shadow = mix(skyCol * 0.95, shadowRef, 0.55) * (1.0 - 0.30 * uOvercast);
  vec3 col = mix(shadow, lit, clamp(lightAmt, 0.0, 1.0));
  col += keyCol * rim * (1.0 - uOvercast * 0.8);

  // Aerial perspective: distant (grazing) cloud washes into the horizon haze
  // instead of disappearing. The alpha stays up so the deck still reads as a
  // solid bank of cumulus sitting on the skyline. Both washes target the same
  // hazeColor() the clear sky converges on, so a cloud base and the sky beside
  // it meet the skyline on one value.
  vec3 hz = hazeColor();
  col = mix(col, hz, pow(graze, 4.0) * 0.26 * (1.0 - uNight * 0.55));
  // horizonBand, not smoothstep: smoothstep(0, 0.055, y) is flat at both ends,
  // so the cloud base picked up its own constant plate right on the skyline.
  col = mix(col, hz, horizonBand(dir.y, 26.0) * 0.55 * (1.0 - uNight * 0.5));

  float alpha = smoothstep(0.03, 0.34, dens);
  // Grazing rays accumulate more cloud, so coverage RISES toward the horizon —
  // but only a little, or the whole sky band turns into an overcast lid and the
  // vivid blue this game is supposed to have never gets to show.
  alpha = mix(alpha, min(1.0, alpha * 1.22 + 0.04 * graze), graze);
  // The deck must survive all the way down to the horizon line — but it must
  // not butt into it, or the cloud base reads as a hard bright rim sitting on
  // the skyline. Ease it on over the last ~2.5 deg and wash the last of it into
  // the horizon colour, which is how a real cumulus bank meets the horizon.
  alpha *= smoothstep(-0.006, 0.042, dir.y);
  // At night the deck thins right out: a magical starfield with a low moon is
  // the picture, and a lit cloud lid reads as smog.
  alpha *= 1.0 - uNight * 0.55;
  return vec4(col, alpha);
}

// ---------------------------------------------------------------------------

void main() {
  vec3 dir = normalize(vDir);
  float sunUp = max(uSunDir.y, 0.0);

  // ---- daytime scattering -------------------------------------------------
  // Low sun ⇒ far less light reaches the sky, so open up the "aperture".
  float expo = uExposure * mix(8.0, 1.0, smoothstep(0.0, 0.60, uSunDir.y));
  vec3 Lin = atmosphere(dir);
  vec3 texColor = Lin * 0.04 * expo + vec3(0.0, 0.00035, 0.0009);
  // Preetham's display curve...
  vec3 disp = pow(max(texColor, vec3(0.0)), vec3(1.0 / (1.2 + 1.2 * uSunUpFade)));

  // ---- twilight art direction ---------------------------------------------
  // Preetham's hues along grazing paths drift green/khaki, which reads as a
  // muddy render rather than a sunset. Near the horizon at low sun we keep its
  // LUMINANCE (so the glow gradient survives) and substitute an authored hue
  // ramp: hot orange toward the sun, violet opposite, deep blue overhead.
  float lowSun = smoothstep(0.20, -0.02, uSunDir.y) * smoothstep(-0.30, -0.10, uSunDir.y);
  if (lowSun > 0.001) {
    vec2 dh = normalize(dir.xz + vec2(1e-5));
    vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
    float az = dot(dh, sh);                       // -1 anti-solar .. 1 sunward
    vec3 tw = mix(vec3(0.55, 0.31, 0.64), vec3(1.00, 0.52, 0.17),
                  smoothstep(-0.45, 0.90, az));
    tw = mix(tw, vec3(0.26, 0.33, 0.80), smoothstep(0.06, 0.58, dir.y));
    // Cover the whole hemisphere: any patch left on Preetham's own hue goes
    // khaki-green next to the authored ramp and instantly reads as a bug.
    float band = smoothstep(1.05, -0.06, dir.y);
    float Lt = luma(disp);
    disp = mix(disp, tw * (Lt / max(luma(tw), 1e-4)), lowSun * band * 0.94);
  }
  // A tight blaze right at the sun so the horizon still burns.
  float warmBand = smoothstep(0.22, -0.02, abs(dir.y)) * pow(max(dot(dir, uSunDir), 0.0), 3.0);
  disp += vec3(0.55, 0.24, 0.05) * warmBand * lowSun * 0.75;
  // Soft shoulder on LUMINANCE only. A per-channel shoulder crushes blue and
  // green together and turns the whole sky teal — this keeps the hue.
  float Ld = luma(disp);
  disp *= (Ld / (1.0 + max(0.0, Ld - 0.66) * 1.55)) / max(Ld, 1e-4);
  // Preetham saturates every channel near the horizon, which reads as a dirty
  // grey wash. Re-tint that band cool so it reads as atmospheric haze instead.
  // Skipped at low sun, where the horizon is supposed to be on fire.
  float hz = smoothstep(0.34, -0.06, dir.y);
  disp *= mix(vec3(1.0), vec3(0.70, 0.86, 1.05),
              hz * (1.0 - uNight * 0.75) * (1.0 - lowSun * 0.85));
  // ...then straight back to linear, so the result plays nicely with
  // SRGBColorSpace output AND with an HDR post target.
  vec3 sky = pow(max(disp, vec3(0.0)), vec3(2.2));

  // ---- night --------------------------------------------------------------
  float upT = smoothstep(-0.12, 0.62, dir.y);
  vec3 nightSky = mix(uNightHorizon, uNightZenith, upT);
  // The star field costs ~6 hashes + a texture tap per pixel. uStars is exactly
  // zero for the whole day, and this branch is uniform-driven (so it is fully
  // coherent across every warp) — at noon the cost is one comparison.
  // Stars and the moon disc are held OUT of nightSky and re-added after the
  // horizon haze below. The haze band now reaches ~0.5 by 3 deg, and the only
  // sky this camera frames is 0..6 deg — folding the celestial bodies into the
  // colour that gets mixed toward the haze would have washed the entire visible
  // starfield out. They are point/disc sources: haze sits BEHIND them.
  vec3 celestial = vec3(0.0);
  if (uStars > 0.002) {
    // Faint nebula wash so the sky is deep, never flat black.
    vec4 nb = texture2D(uNoise, dir.xz * 0.55 + dir.y * 0.25 + vec2(0.13, 0.41));
    nightSky += vec3(0.034, 0.029, 0.070) * smoothstep(0.45, 0.95, nb.r) * upT;
    celestial = starField(dir) * uStars * (0.30 + 0.70 * upT) * 3.1
              + moon(dir) * uStars;
  }

  vec3 col = mix(sky, nightSky, uNight);
  // Overcast greys the visible sky between the clouds, not just the deck.
  col = mix(col, vec3(luma(col)) * mix(vec3(0.95, 0.98, 1.04), vec3(1.04, 1.03, 1.0), uSnowy),
            uOvercast * 0.72);

  // ---- sun disc -----------------------------------------------------------
  float sang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  float r = clamp(sang / uSunDiscSize, 0.0, 1.0);
  float limb = pow(max(0.0, 1.0 - r * r), 0.36);
  float disc = smoothstep(1.0, 0.86, r) * limb;
  float above = smoothstep(-0.055, 0.045, uSunDir.y);
  vec3 discCol = uSunTint * disc * uSunDiscPower * above * (1.0 - uOvercast * 0.92);
  col += discCol;
  // Aureole: a tight core for the bloom pass plus a broad soft halo.
  float sdot = max(dot(dir, uSunDir), 0.0);
  col += uSunTint * (pow(sdot, 260.0) * 0.70 + pow(sdot, 26.0) * 0.13)
         * above * (1.0 - uOvercast * 0.85);

  // ---- clouds -------------------------------------------------------------
  // At night the clouds are lit by nothing but a little moonlight.
  vec3 sunCol = mix(uSunTint * (0.80 + 0.50 * sunUp), vec3(0.050, 0.062, 0.105), uNight);
  sunCol = mix(sunCol, vec3(0.54, 0.57, 0.63) * mix(1.0, 1.18, uSnowy), uOvercast * 0.85);
  // Ambient the clouds are sitting in. At twilight that is a violet-grey, not
  // the daytime blue — otherwise orange key + blue fill reads as hot magenta.
  vec3 skyRef = mix(mix(warmRot(vec3(0.30, 0.45, 0.72), uWarm * 0.40),
                        vec3(0.33, 0.25, 0.36), lowSun),
                    vec3(0.06, 0.09, 0.20), uNight);

  // Keep a little structure in the lid: a dead-flat 0.97 reads as a bug.
  float cov = mix(uCloudCoverage, 0.90, uOvercast);
  float thick = mix(1.0, 2.1, uOvercast);
  float c0a = 0.0;
  if (dir.y > -0.030) {
    vec4 c0 = cloudLayer(dir, uCloudScale, uWind * uTime, cov, thick,
                         sunCol, skyRef, uCloudLightStep, 1.0);
    c0a = clamp(c0.a, 0.0, 1.0);
    col = mix(col, c0.rgb, c0a);

#if HIGHLAYER
    // A thinner, higher, faster deck. Its shell sits 2.6x further up, so it
    // converges on the horizon behind the cumulus and gives the band depth.
    vec4 c1 = cloudLayer(dir, uCloudScale * 0.42, uWind * uTime * 1.7 + vec2(37.0, 11.0),
                         mix(uCloudCoverage * 0.60, 0.85, uOvercast), 0.55,
                         sunCol, skyRef, uCloudLightStep * 0.7, 2.6);
    col = mix(col, c1.rgb, clamp(c1.a, 0.0, 1.0) * uHighCloud * (1.0 - c0a * 0.85));
#endif
  }

  // ---- kid-friendly grade -------------------------------------------------
  // Ease the saturation boost off at twilight — the authored ramp is already
  // saturated and doubling up turns the sky fluorescent.
  float sat = mix(uSaturation, 1.12, lowSun * 0.75);
  float l = luma(col);
  col = mix(vec3(l), col, sat);

  // ---- horizon haze -------------------------------------------------------
  // engine.js drives scene.fog.color straight from the fogColor this module
  // returns, and terrain.js then ADDS uHorizonLift (2.2, set by engine.js) to
  // its own fog result so the land does not fade to something darker than the
  // sky. The dome used to converge only 62 % of the way to fogColor over a
  // 1.7 deg e-fold, so the land skirt sat at 2.2x fogColor and the dome just
  // above it at 1.0x — measured in the HDR scene buffer as
  //   land (0.3872, 0.6201, 1.0303)  vs  dome (0.1801, 0.2957, 0.4910)
  // i.e. exactly 2.2x, an 8-device-row / 57-count cliff running the full width
  // of every frame. THAT is the seam. The dome now converges on the same lifted
  // value, over the whole 0..35 deg range, with a profile that has a non-zero
  // derivative at the horizon (see horizonBand()).
  vec3 haze = hazeColor();
  // Clouds in front of the haze keep some of their own colour; and the sun disc
  // is in FRONT of the haze, not behind it — without the disc term a sunset
  // (sun elevation ~0, hazeW == 1) would dissolve the disc completely.
  float hazeW = horizonBand(dir.y, uHazeK) * (1.0 - c0a * 0.45) * (1.0 - disc * 0.92);
  col = mix(col, haze, hazeW);
  // Stars / moon ride on top of the haze rather than through it.
  col += celestial * uNight * (1.0 - uOvercast * 0.9);

  // ---- Mie forward-scatter + city glow (additive, outside the anchor) ------
  // A broad warm brightening of the sky toward the sun's AZIMUTH, strongest at
  // the horizon. This is the term that gives the sky a light source even when
  // the sun disc itself is far above the top of the frame — which, at the
  // game's camera polars, it almost always is.
  //
  // Deliberately additive AFTER the anchor and deliberately NOT mirrored into
  // fogColor: it is strongly directional, and folding it into the fog would
  // raise the haze over the whole map to the brightness of the sky right next
  // to the sun. The isotropic floor is only 0.10, so away from the sun the sky
  // and the fog still land within ~2/255 of each other; toward the sun the sky
  // is brighter than the distant terrain, which is the correct direction.
  vec2 dh = normalize(dir.xz + vec2(1e-5, 1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5, 1e-5));
  float azSun = max(dot(dh, sh), 0.0);
  // Was exp(-(y/0.26)^1.6) * smoothstep(-0.09, 0.0, y): flat for the first few
  // degrees (zero derivative at y == 0) and then terminated by a 5 deg-wide
  // cutoff below the horizon. Same monotone profile as the haze now, and NO
  // cutoff — below the horizon it simply carries its horizon value into the
  // ground band, which is continuous by construction (see below).
  float hBand = horizonBand(dir.y, uMieK);
  float mie = (0.10 + 0.90 * pow(azSun, 3.0)) * hBand
            * smoothstep(-0.16, 0.10, uSunDir.y) * (1.0 - uNight)
            * (1.0 - uOvercast * 0.55);
  col += warmRot(uSunTint, uWarm * 0.75) * mie * uMieGlow;

  if (uCityGlow.z > 0.0005) {
    float azCity = max(dot(dh, uCityGlow.xy), 0.0);
    // Above the horizon: the same monotone band as everything else. BELOW it,
    // the glow has to die away — the sodium dome is airglow ABOVE the city, and
    // what you are looking at below the horizon is distant land in front of it.
    // Measured: leaving it at full strength below dir.y == 0 (which is what a
    // band with no y-dependence there does) put the dome 40 counts of red over
    // the land skirt at the night shot and simply moved the seam. pow(1+y,k) is 1
    // at the horizon, so this cannot re-introduce a step of its own.
    float cBand = horizonBand(dir.y, uCityK)
                * pow(max(1.0 + min(dir.y, 0.0), 0.0), uCityBelowK);
    col += uCityGlowColor * uCityGlow.z * 0.22 * cBand
         * (0.25 + 0.75 * pow(azCity, uCityGlow.w)) * uNight;
  }

  // ---- below the horizon --------------------------------------------------
  // NOT a constant fill, and NOT switched on by a smoothstep either.
  //
  // The old form was mix(col, mix(uHorizonRef, uGroundDeep, smoothstep(0, 0.66,
  // dn)), smoothstep(0.004, -0.055, dir.y)). Two separate flat spots: the
  // 0..0.66 ramp moves by 0.007 over the 1.8 deg of dip a shot at polar 1.30
  // actually contains, and the outer smoothstep is flat at both of its ends.
  // Result: 66 device rows within +/-1 count — the "plate above the step" the
  // reviewer measured at (130,159,194).
  //
  // Now the ramp STARTS FROM col ITSELF, so it is exactly continuous with the
  // sky at dir.y == 0 with no blend weight to schedule, and it uses the same
  // pow profile as the haze so it has a real gradient in the first few degrees.
  if (dir.y < 0.0) {
    float dn = clamp(-dir.y, 0.0, 1.0);
    float k = 1.0 - pow(max(1.0 - dn, 0.0), uGroundK);
    vec3 g = mix(col, uGroundDeep, k);
    // Distant-land mottling — cheap, but it is the difference between "haze"
    // and "flat fill". Same shell mapping as the clouds, mirrored below.
    float gt = shellT(max(dn, 0.004), uCloudR * 0.5, 1.0);
    vec2 guv = dir.xz * (gt * uCloudScale * 2.6) + vec2(11.3, 4.7);
    float gb = clamp(log2(gt) * 0.7, 0.0, 2.0);
    vec4 gn = texture2D(uNoise, guv, gb);
    vec4 gm = texture2D(uNoise, guv * 0.37 + vec2(0.53, 0.19), gb);
    // Two octaves: broad landmass-scale patches plus a finer break-up. Without
    // this the band measures as a literally constant fill (sigma < 0.1/255).
    // Faded in over the first ~1.7 deg so it cannot re-introduce a step at the
    // horizon line itself.
    float mot = 0.62 * gm.r + 0.38 * gn.b;
    g *= 1.0 + (mot - 0.5) * 0.40 * smoothstep(0.0, 0.030, dn);
    // Aerial perspective is brighter and warmer toward the sun.
    g *= mix(vec3(1.0), vec3(1.10, 1.03, 0.92),
             pow(azSun, 2.0) * 0.45 * (1.0 - uNight) * (1.0 - k * 0.7));
    col = g;
  }

  col = max(col, vec3(0.0));

#ifdef ENV_PASS
  // ---- authored daytime IBL ("Isometric City Voxel" studio sky) -----------
  // The physical dome is a saturated Rayleigh blue over a dark ground; as an
  // irradiance source that is exactly the blue-grey cast the art direction
  // bans: every shadow and every away-facing wall is lit by it and nothing
  // else. The reference is a Blender-style render: a bright, nearly WHITE
  // sky, a light warm ground bounce, and a broad glow on the key side, so the
  // walls facing the key get more fill than the walls facing away (that is
  // half of the three-tone separation). Only the PMREM sees this; the dome the
  // player can see is untouched.
  if (uEnvArt > 0.0) {
    float yUp = clamp(dir.y, -1.0, 1.0);
    vec3 art;
    if (yUp >= 0.0) art = mix(uEnvHor, uEnvUp, pow(yUp, uEnvUpPow));
    else art = mix(uEnvHor, uEnvGnd, smoothstep(0.0, 0.22, -yUp));
    vec3 kd = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.05), uSunDir.z));
    float lobe = max(dot(dir, kd), 0.0);
    art += uEnvSun * (lobe * lobe) * smoothstep(-0.15, 0.10, yUp);
    col = mix(col, art, uEnvArt);
  }
#endif

  // ---- low-bit dither -----------------------------------------------------
  // Belt and braces on top of the profiles above: a sub-count, value-relative
  // triangular dither so that even a stretch of sky whose analytic gradient is
  // under 1/255 per row cannot quantise into a visible plate. Proportional, so
  // it is invisible in the bright haze band and vanishes in the deep night sky.
  vec3 dh3 = hash33(vec3(gl_FragCoord.xy, 1.0));
  float dth = (dh3.x + dh3.y) - 1.0;            // triangular, -1..1
  col *= 1.0 + dth * uDither;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   *   renderer          WebGLRenderer — lets update() refresh the PMREM itself.
   *   quality           0|1|2 (default 2)
   *   turbidity         aerosol amount (default 2.4 — clean, vivid blue)
   *   exposure          sky brightness multiplier (default 1.0)
   *   saturation        grade saturation (default 1.22)
   *   cloudCoverage     0..1 clear-sky coverage (default 0.46)
   *   cloudScale        cloud plane uv scale (default 0.055)
   *   windSpeed         uv/sec drift (default 0.0035)
   *   envSize           PMREM source cube size (default 128)
   *   envInterval       seconds between PMREM refreshes (default 2)
   *   envNightDelta     nightT delta that forces a refresh (default 0.02)
   *   azimuth           sun azimuth at noon, radians (default 2.3)
   *   maxElevation      sun elevation at noon, radians (default 1.31 ≈ 75°)
   *   radiusFactor      dome scale as a fraction of camera.far (default 0.4)
   *   applyEnvironment  if true, Sky assigns scene.environment itself
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;

    this._quality = clamp(opts.quality != null ? opts.quality | 0 : 2, 0, 2);
    this._renderer = opts.renderer || null;
    this._radiusFactor = opts.radiusFactor != null ? opts.radiusFactor : 0.4;
    this._applyEnv = !!opts.applyEnvironment;

    this._azimuth = opts.azimuth != null ? opts.azimuth : 2.3;
    this._maxElev = opts.maxElevation != null ? opts.maxElevation : 1.10;
    this._azSweep = opts.azimuthSweep != null ? opts.azimuthSweep : 1.9;

    this._turbidity = opts.turbidity != null ? opts.turbidity : 2.6;
    this._rayleigh = opts.rayleigh != null ? opts.rayleigh : 3.8;
    this._mieCoef = opts.mieCoefficient != null ? opts.mieCoefficient : 0.0028;

    // ---- horizon seam / warm rotation -------------------------------------
    // How much brighter than the returned fogColor the dome draws at the
    // horizon. This is NOT free: terrain.js adds exactly the same lift to its
    // own fog result (its `uHorizonLift`, which engine.js sets to 2.2), and
    // water.js does the equivalent for the lake surface. If any of those move,
    // this must move with them or the skyline gets a step again.
    this._horizonLift = opts.horizonLift != null ? opts.horizonLift : 2.2;

    // Mirrors lighting.js's `_skylightWarmAmount()` — same 34 deg -> 18 deg
    // ramp on SUN ELEVATION, so the sky, the fog and the skylight fill all
    // start rotating warm at the same moment instead of the ground going amber
    // under an ice-blue dome.
    this._warmHi = opts.warmElevationHi != null ? opts.warmElevationHi : 34;
    this._warmLo = opts.warmElevationLo != null ? opts.warmElevationLo : 18;
    this._warmMaster = opts.skylightWarmth != null ? opts.skylightWarmth : 1.0;
    // Fraction of the rotation that reaches the returned fogColor. 0.74 lands
    // linear R/B at ~1.20 and G/B at ~1.15 for a 20 deg sun (it was 0.376 — an
    // ice-blue haze under a 2.83:1 warm key).
    this._fogWarm = opts.fogWarmth != null ? opts.fogWarmth : 0.74;
    // ...and how much reaches the dome / clouds. Higher: the dome is what the
    // player looks at, and it is the horizon BAND that has to read gold.
    this._domeWarm = opts.domeWarmth != null ? opts.domeWarmth : 0.80;
    // TWO warm targets, and the difference matters.
    //   fog/haze  -> a warm CREAM. The fog starts strongly blue (R/G/B
    //                0.38:0.60:1.0), and a luminance-preserving rotation toward
    //                lighting.js's saturated #ff8f3f passes through MAUVE on its
    //                way: at the R/B ≈ 1.2 the brief asks for, that target lands
    //                G *below* B and the whole far field prints pink. #ffdcb0
    //                has enough green to keep R > G > B at that same R/B.
    //   clouds/Mie -> a proper gold. Sunlit cumulus and the forward-scatter
    //                band are lit by the key light, not by haze, so they take
    //                the saturated hue.
    this._warmHue = new THREE.Color().setHex(
      opts.warmHorizonHex != null ? opts.warmHorizonHex : 0xffdcb0, THREE.SRGBColorSpace);
    this._warmCloudHue = new THREE.Color().setHex(
      opts.warmCloudHex != null ? opts.warmCloudHex : 0xffb877, THREE.SRGBColorSpace);
    this._skyWarm = 0;

    // ---- DAYTIME ART DIRECTION ---------------------------------------------
    // Target: Pablo Gamedev's "Isometric City Voxel" (tools/rendertest/
    // ART-DIRECTION.md). The physical model above is right about the SKY and
    // wrong about the LIGHT for this look: at a 63 deg noon it hands back a
    // key of linear (1.00, 0.75, 0.40) — orange — over a Rayleigh zenith of
    // (0.07, 0.45, 1.14) that fills every shadow and every away-facing wall.
    // Orange key + blue fill is the blue-grey murk the art direction bans.
    //
    // The reference is lit like a Blender product render: one warm-WHITE key
    // and a bright, nearly neutral sky, so each block shows three clean tones
    // of its own colour (top brightest, key-side wall mid, far wall darkest but
    // still saturated) and shadows are light and soft. So, by day, the LIGHTS
    // (not the dome — water and the visible sky keep the physical colours) are
    // pulled onto an authored key/fill, and the PMREM is baked from an authored
    // studio sky (ENV_PASS in FRAG). `artAmount` fades it out over sun
    // elevation 24 -> 12 deg and into the night so dusk and night keep their
    // physical, warm/cool grade untouched.
    //
    // Levels are LINEAR and in the engine's final units (engine.js applies no
    // further gain to the art values — see _applySkyLighting).
    //
    // The fill is deliberately TOP-HEAVY: a bright sky (hemi up + env upper
    // dome) over a DIM ground bounce. Tops and open ground get lots of fill
    // (light, soft cast shadows) while walls, which see half sky / half ground,
    // get much less — so the key still separates the two walls. Tuned on
    // probe cubes (white/orange/red/blue/lime, 8^3, open grass, iso view),
    // sRGB luma top : key wall : far wall, measured after post:
    //   physical noon (before)   red 66/76/73   blue 114/76/65 (far wall > key wall)
    //   authored, this block     red 108/84/61  blue 122/95/71  org 161/144/114
    // i.e. ~1 : 0.80 : 0.60 (saturated) .. 1 : 0.89 : 0.71 (light), against
    // ref04 (Blender) ~1 : 0.92 : 0.75. Lit lime grass lands (176,215,85).
    // The fill is NEUTRAL, not sky-blue: a cool fill is exactly what turned
    // every far wall blue-grey (white block far wall measured (140,148,150)
    // with a #eef4fb/#dce8f6 fill).
    // Symmetric fill (hemi/ambient) changes the two walls equally and moves
    // that ratio by < 2 luma — the separation lives in the key direction and
    // the env's key-side lobe (`envSun`).
    //
    // Round 3 (critic: "buildings cast almost no visible shadow", "the white
    // and cream facades read at nearly the same value on both visible sides",
    // "slightly soft, low-contrast, faintly hazy"). Measured with the fill
    // switched off piece by piece: the KEY was only ~1/3 of what lit open
    // ground, and the fill alone (hemi + a studio env whose HORIZON was the
    // brightest band, #fbf7ee) lit a top face to 223/226 — so tops sat in the
    // tone curve's shoulder, walls facing away got as much horizon fill as
    // walls facing the key, and a cast shadow only removed a sliver of the
    // light. Now the key carries the frame and the fill is genuinely
    // top-heavy: bright zenith, a DIM horizon (#7a776f) and a near-black
    // ground (#1a1914) for both hemi and env, so a vertical wall sees about
    // half the fill a roof does. Probe cubes, sRGB luma top/left/right:
    //   r2 authored   cream 226/206/158 (.91/.70)  brick 107/93/71 (.87/.66)
    //   r3 authored   cream 225/189/130 (.84/.58)  brick 103/86/53 (.83/.51)
    // and open-ground cast shadow / lit ground 0.60 -> 0.54 (clearer but still
    // light and colourful; lit grass unchanged at ~184). Then +15% on key and
    // fill together (3.0 / 1.6 / env 1.03): iso-mid frame p50 0.453 -> 0.475,
    // p90 0.78 -> 0.85 (ref05 0.548 / 0.895) — tops read bright again.
    // Round 6 (critic r5: "left and right walls nearly the same light grey";
    // wants the right face ~25-30% darker than the left and slightly cool, tops
    // the lightest plane). With the key moved to 30 deg off the left-wall
    // normal (engine.js, 3.2), the fill had to stop lighting walls as much as
    // roofs: the env's up-dome gradient pow(y, 0.55) -> pow(y, 1.0) keeps the
    // bright part near the zenith (tops) so a vertical wall integrates less of
    // it, and the sky side gets a touch cooler so the far wall reads as a cool,
    // darker version of its colour (ref05 bank right face ~ (137,162,168)).
    // iso-mid SKY tower lit/away 216/140 -> 231/135, away (126,136,149).
    const A = opts.art || {};
    const hex = (h, d) => new THREE.Color().setHex(h != null ? h : d, THREE.SRGBColorSpace);
    this._art = {
      amount: A.amount != null ? A.amount : 1.0,
      // Light wave-2 r1: the authored rig now runs through golden hour and
      // hands over to the physical solution only as the sun reaches the
      // horizon (was 24 -> 12 deg). Physical dusk was an orange key over a
      // fill rotated toward #ff8f3f — every face, lit or shaded, went the
      // same salmon (coherence #5). Dusk is now the authored DUSK palette
      // below: a golden key on lit faces, a cool fill on shade faces.
      elevLo: A.elevLo != null ? A.elevLo : -6,     // deg: fully physical at/below
      elevHi: A.elevHi != null ? A.elevHi : 0,      // deg: fully authored at/above
      // Dusk ramp (deg of key elevation): 0 at/above duskHi, 1 at/below duskLo.
      duskHi: A.duskHi != null ? A.duskHi : 32,
      duskLo: A.duskLo != null ? A.duskLo : 6,
      duskKey: hex(A.duskKeyHex, 0xffc584),         // golden amber, not orange-red
      duskKeyScale: A.duskKeyScale != null ? A.duskKeyScale : 0.66,
      duskSky: hex(A.duskSkyHex, 0xbfc8ec),         // cool lavender-blue fill: shade faces keep their hue, go cool
      duskGnd: hex(A.duskGroundHex, 0x54463a),      // warm bounce off sunlit ground
      duskFillScale: A.duskFillScale != null ? A.duskFillScale : 0.72,
      key: hex(A.keyHex, 0xfffaf2),                 // warm white (neutrals measured B-R -10 at #fff6ea; ref05 is 0)
      keyI: A.keyIntensity != null ? A.keyIntensity : 3.3,  // r8: 3.2 -> 3.3 (key at 50 deg: tops keep their value)             // r4: 3.0 -> 2.6; r5: 2.9 (bounce trimmed + deeper open shadows, see engine.js DAY_BOUNCE_SCALE)
      sky: hex(A.skyHex, 0xe4ecf6),                 // hemisphere up: near-white, a touch cool (r6: #f1f3f4)
      gnd: hex(A.groundHex, 0x4a463c),              // hemisphere down: warm grey bounce (r3 #1a1914 read navy/black in canyons)
      hemiI: A.hemiIntensity != null ? A.hemiIntensity : 1.85,         // r4: 1.6 -> 1.75 + brighter ground (light, airy shade sides like ref05)
      amb: hex(A.ambientHex, 0xf2f0ea),
      ambI: A.ambientIntensity != null ? A.ambientIntensity : 0.03,
      envUp: hex(A.envUpHex, 0xe2eaf4),             // r6: #eceef0
      envHor: hex(A.envHorizonHex, 0x7a776f),        // r3: was the brightest band (#fbf7ee)
      envGnd: hex(A.envGroundHex, 0x4a463c),
      envLevel: A.envLevel != null ? A.envLevel : 1.2,                // r4: 1.03 -> 1.2
      envSun: A.envSun != null ? A.envSun : 1.0,    // key-side lobe, x key colour
      envUpPow: A.envUpPow != null ? A.envUpPow : 1.0,   // r6: 0.55 -> 1.0 (zenith-heavier: walls see less of it)
    };
    this._artAmt = 0;
    this._keyColor = new THREE.Color(1, 1, 1);
    this._fillSky = new THREE.Color(1, 1, 1);
    this._fillGround = new THREE.Color(0.5, 0.5, 0.4);
    this._fillAmbient = new THREE.Color(1, 1, 1);

    // ---- scratch (never allocate per frame) -------------------------------
    // Moon elevation at deep night, radians. Deliberately LOW: the game camera
    // tops out at polar 1.2, which puts the top of the frame ~4° above the
    // horizon, so a physically-mirrored moon (≈60° up, opposite the sun) is
    // never once in shot. A low moon is also the better picture.
    this._moonElev = opts.moonElevation != null ? opts.moonElevation : 0.075;

    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._moonDir = new THREE.Vector3(0, -1, 0);
    this._keyDir = new THREE.Vector3(0, 1, 0);
    this._moonU = new THREE.Vector3(1, 0, 0);
    this._moonV = new THREE.Vector3(0, 1, 0);

    // City sky glow (§ setCityGlow). Centroid in world XZ + 0..1 amount.
    this._cityX = 320; this._cityZ = 320; this._cityAmt = 0;
    this._cityDir = new THREE.Vector2(0, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._rgb = [0, 0, 0];
    this._rgb2 = [0, 0, 0];

    this._sunColor = new THREE.Color(1, 1, 1);
    this._skyColor = new THREE.Color(0.35, 0.55, 0.9);
    this._groundColor = new THREE.Color(0.35, 0.4, 0.28);
    this._fogColor = new THREE.Color(0.6, 0.75, 0.95);
    this._ambientColor = new THREE.Color(0.2, 0.26, 0.4);

    this._out = {
      sunDir: this._sunDir,
      sunColor: this._sunColor,
      skyColor: this._skyColor,
      groundColor: this._groundColor,
      intensity: 1,
      // extras (engine may use or ignore)
      fogColor: this._fogColor,
      hemiIntensity: 0.6,
      ambientColor: this._ambientColor,
      ambientIntensity: 0.18,
      envIntensity: 1,
      nightAmount: 0,
      sunElevation: Math.PI / 2,   // radians above the horizon (can be negative)
      sunHeight: 1,                // == sunDir.y == sin(sunElevation)
      overcast: 0,
      // --- celestial agreement with lighting.js (CONTRACTS-RENDER §3.8.2) ---
      // `sunDir` stays the true solar vector (it is what drives the scattering
      // and what shadows should follow by day). At night the sun is far below
      // the horizon and there is nothing to key off, so we also publish where
      // the MOON actually is — the disc we draw in the dome. `keyDir` is the
      // one engine.js should hand to rig.setSunDirection(): sun by day, moon by
      // night, always above the horizon while a body is up. Both are unit
      // vectors pointing FROM the scene TOWARD the body.
      moonDir: this._moonDir,
      keyDir: this._keyDir,
      isMoon: false,
      // --- authored daytime light (see DAYTIME ART DIRECTION) ---------------
      // 0..1: how far the lights should be pulled from the physical solution
      // above onto these. engine.js does the blend; the values are final.
      artAmount: 0,
      keyColor: this._keyColor,
      keyIntensity: 3.0,
      fillSky: this._fillSky,
      fillGround: this._fillGround,
      fillAmbient: this._fillAmbient,
      fillHemiIntensity: 1.6,
      fillAmbientIntensity: 0.03,
    };

    // ---- state ------------------------------------------------------------
    this._time = 0;
    this._nightT = 0;
    this._nightAmt = 0;
    this._overcast = 0;
    this._overcastTarget = 0;
    this._snow = 0;
    this._rain = 0;
    this._disposed = false;

    // ---- textures & material ---------------------------------------------
    this._noise = makeNoiseTexture(256, opts.noiseSeed != null ? opts.noiseSeed | 0 : 1337);

    const betaM = this._mieForTurbidity(this._turbidity);
    const betaR = this._rayleighVec();

    this.uniforms = {
      uSunDir: { value: this._sunDir },
      uMoonDir: { value: this._moonDir },
      uMoonU: { value: this._moonU },
      uMoonV: { value: this._moonV },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uOvercast: { value: 0 },
      uSnowy: { value: 0 },
      uNoise: { value: this._noise },
      uBetaR: { value: new THREE.Vector3(betaR[0], betaR[1], betaR[2]) },
      uBetaM: { value: new THREE.Vector3(betaM[0], betaM[1], betaM[2]) },
      uMieG: { value: opts.mieG != null ? opts.mieG : 0.72 },
      uSunE: { value: SUN_EE },
      uSunUpFade: { value: 1 },
      uHorizFade: { value: 0 },
      uExposure: { value: opts.exposure != null ? opts.exposure : 0.045 },
      uSaturation: { value: opts.saturation != null ? opts.saturation : 1.42 },
      uSunDiscSize: { value: opts.sunDiscSize != null ? opts.sunDiscSize : 0.030 },
      uSunDiscPower: { value: opts.sunDiscPower != null ? opts.sunDiscPower : 14.0 },
      uSunTint: { value: new THREE.Vector3(1, 0.96, 0.88) },
      uMieGlow: { value: opts.mieGlow != null ? opts.mieGlow : 0.30 },
      // Texture repeats per unit of shell distance. The deck's own altitude is
      // the unit, so this is "how big is a cloud compared to how high it flies".
      uCloudScale: { value: opts.cloudScale != null ? opts.cloudScale : 1.05 },
      uCloudCoverage: { value: opts.cloudCoverage != null ? opts.cloudCoverage : 0.30 },
      uCloudSharp: { value: opts.cloudSharp != null ? opts.cloudSharp : 4.4 },
      // Planet radius in deck altitudes. Bigger = the deck stays overhead
      // longer and piles up into a tighter band right on the horizon.
      uCloudR: { value: opts.cloudRadius != null ? opts.cloudRadius : 13.0 },
      uWind: { value: new THREE.Vector2(1, 0.36).multiplyScalar(opts.windSpeed != null ? opts.windSpeed : 0.010) },
      uCloudLightStep: { value: opts.cloudLightStep != null ? opts.cloudLightStep : 0.11 },
      uHighCloud: { value: opts.highCloud != null ? opts.highCloud : 0.38 },
      uStars: { value: 0 },
      // night r1: blue-VIOLET rather than navy. This is also the night hemi
      // fill (engine copies the zenith into hemi.color), so it is the colour
      // every shaded face and every roof takes at night.
      uNightZenith: { value: new THREE.Vector3(0.024, 0.024, 0.086) },
      uNightHorizon: { value: new THREE.Vector3(0.058, 0.054, 0.150) },
      uHorizonRef: { value: new THREE.Vector3(0.20, 0.31, 0.44) },
      // MUST track terrain.js's uHorizonLift (engine.js sets it to 2.2). See
      // the "horizon haze" block in main() — this is the seam fix.
      uHorizonLift: { value: this._horizonLift },
      uHazeK: { value: opts.hazeExponent != null ? opts.hazeExponent : 12.0 },
      uGroundK: { value: opts.groundExponent != null ? opts.groundExponent : 7.0 },
      uMieK: { value: opts.mieExponent != null ? opts.mieExponent : 5.0 },
      uCityK: { value: opts.cityExponent != null ? opts.cityExponent : 22.0 },
      uCityBelowK: { value: opts.cityBelowExponent != null ? opts.cityBelowExponent : 60.0 },
      uDither: { value: opts.dither != null ? opts.dither : 0.040 },
      uWarmHue: { value: new THREE.Vector3(1, 1, 1) },
      uWarm: { value: 0 },
      uGroundDeep: { value: new THREE.Vector3(0.10, 0.16, 0.22) },
      uCityGlow: { value: new THREE.Vector4(0, 1, 0, 3.0) },
      uCityGlowColor: { value: new THREE.Vector3(1.00, 0.62, 0.28) },
      uEnvArt: { value: 0 },
      uEnvUp: { value: new THREE.Vector3(1, 1, 1) },
      uEnvHor: { value: new THREE.Vector3(1, 1, 1) },
      uEnvGnd: { value: new THREE.Vector3(0.5, 0.5, 0.4) },
      uEnvSun: { value: new THREE.Vector3(0, 0, 0) },
      uEnvUpPow: { value: 0.55 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      transparent: false,
      toneMapped: false,
      defines: this._definesFor(this._quality),
    });

    this._geo = new THREE.SphereGeometry(1, 48, 32);

    this.mesh = new THREE.Mesh(this._geo, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.scale.setScalar(1000);
    scene.add(this.mesh);

    // The sky dome replaces scene.background entirely.
    this._prevBackground = scene.background;
    scene.background = null;

    // ---- PMREM ------------------------------------------------------------
    this._envSize = opts.envSize != null ? opts.envSize : 128;
    this._envInterval = opts.envInterval != null ? opts.envInterval : 2.0;
    this._envNightDelta = opts.envNightDelta != null ? opts.envNightDelta : 0.02;
    this._envScene = new THREE.Scene();
    // The PMREM bake gets its own compile of the same shader (ENV_PASS) so the
    // art-directed IBL grade never touches the visible dome. Same uniforms
    // object: nothing to keep in sync but the quality defines.
    this._envMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      transparent: false,
      toneMapped: false,
      defines: Object.assign({ ENV_PASS: 1 }, this._definesFor(this._quality)),
    });
    this._envMesh = new THREE.Mesh(this._geo, this._envMaterial);
    this._envMesh.frustumCulled = false;
    this._envMesh.scale.setScalar(6);
    this._envScene.add(this._envMesh);

    this._pmrem = null;
    this._cubeRT = null;
    this._cubeCam = null;
    this._envRT = null;
    this._envTexture = null;
    this._envDirty = true;
    this._envTimer = 1e9;          // force an immediate first bake
    this._envLastNight = -99;
    this._envLastOvercast = -99;
    this._envBuilds = 0;
    this.onEnvironmentUpdate = typeof opts.onEnvironmentUpdate === 'function'
      ? opts.onEnvironmentUpdate : null;

    // Prime derived state so the first frame is already correct.
    this._computeSun(0);
    this._computeLighting();
    this._pushUniforms();
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  _definesFor(q) {
    return {
      QSLICES: q >= 2 ? 3 : (q >= 1 ? 2 : 1),
      HIGHLAYER: q >= 1 ? 1 : 0,
    };
  }

  _mieForTurbidity(T) {
    // Preetham: aerosol density scales with turbidity.
    const v = 0.434 * (0.2 * T * 1e-17) * MIE_CONST * this._mieCoef;
    return [v, v, v];
  }

  _rayleighVec() {
    const k = this._rayleigh;
    return [TOTAL_RAYLEIGH[0] * k, TOTAL_RAYLEIGH[1] * k, TOTAL_RAYLEIGH[2] * k];
  }

  setQuality(level) {
    const q = clamp(level | 0, 0, 2);
    if (q === this._quality) return;
    this._quality = q;
    const d = this._definesFor(q);
    // Recompiles once; happens on a quality switch only, never per-frame.
    this.material.defines.QSLICES = d.QSLICES;
    this.material.defines.HIGHLAYER = d.HIGHLAYER;
    this.material.needsUpdate = true;
    if (this._envMaterial) {
      this._envMaterial.defines.QSLICES = d.QSLICES;
      this._envMaterial.defines.HIGHLAYER = d.HIGHLAYER;
      this._envMaterial.needsUpdate = true;
    }
    this._envSize = q >= 2 ? 128 : 64;
    this._disposeEnvTargets();   // rebuilt lazily at the next bake
    this._envDirty = true;
  }

  setSize(/* w, h, pixelRatio */) { /* screen-independent: nothing to do */ }

  setParams(p) {
    if (!p) return;
    const u = this.uniforms;
    if (p.turbidity != null || p.mieCoefficient != null) {
      if (p.turbidity != null) this._turbidity = p.turbidity;
      if (p.mieCoefficient != null) this._mieCoef = p.mieCoefficient;
      const m = this._mieForTurbidity(this._turbidity);
      u.uBetaM.value.set(m[0], m[1], m[2]);
    }
    if (p.rayleigh != null) {
      this._rayleigh = p.rayleigh;
      const r = this._rayleighVec();
      u.uBetaR.value.set(r[0], r[1], r[2]);
    }
    if (p.exposure != null) u.uExposure.value = p.exposure;
    if (p.saturation != null) u.uSaturation.value = p.saturation;
    if (p.mieG != null) u.uMieG.value = p.mieG;
    if (p.cloudCoverage != null) u.uCloudCoverage.value = p.cloudCoverage;
    if (p.cloudScale != null) u.uCloudScale.value = p.cloudScale;
    if (p.cloudSharp != null) u.uCloudSharp.value = p.cloudSharp;
    if (p.cloudRadius != null) u.uCloudR.value = Math.max(1.5, p.cloudRadius);
    if (p.highCloud != null) u.uHighCloud.value = p.highCloud;
    if (p.mieGlow != null) u.uMieGlow.value = p.mieGlow;
    // Horizon seam / warm rotation (see the constructor for what these couple to)
    if (p.horizonLift != null) this._horizonLift = Math.max(0.1, p.horizonLift);
    if (p.hazeExponent != null) u.uHazeK.value = Math.max(1.0, p.hazeExponent);
    if (p.groundExponent != null) u.uGroundK.value = Math.max(1.0, p.groundExponent);
    if (p.mieExponent != null) u.uMieK.value = Math.max(1.0, p.mieExponent);
    if (p.cityExponent != null) u.uCityK.value = Math.max(1.0, p.cityExponent);
    if (p.cityBelowExponent != null) u.uCityBelowK.value = Math.max(1.0, p.cityBelowExponent);
    if (p.dither != null) u.uDither.value = clamp(p.dither, 0, 0.2);
    if (p.skylightWarmth != null) this._warmMaster = clamp(p.skylightWarmth, 0, 1);
    if (p.fogWarmth != null) this._fogWarm = clamp(p.fogWarmth, 0, 1);
    if (p.domeWarmth != null) this._domeWarm = clamp(p.domeWarmth, 0, 1);
    if (p.warmElevationHi != null) this._warmHi = p.warmElevationHi;
    if (p.warmElevationLo != null) this._warmLo = p.warmElevationLo;
    if (p.warmHorizonHex != null) this._warmHue.setHex(p.warmHorizonHex, THREE.SRGBColorSpace);
    if (p.warmCloudHex != null) this._warmCloudHue.setHex(p.warmCloudHex, THREE.SRGBColorSpace);
    if (p.moonElevation != null) { this._moonElev = p.moonElevation; this._computeSun(this._nightT); }
    if (p.sunDiscSize != null) u.uSunDiscSize.value = p.sunDiscSize;
    if (p.sunDiscPower != null) u.uSunDiscPower.value = p.sunDiscPower;
    if (p.windSpeed != null) u.uWind.value.set(1, 0.36).multiplyScalar(p.windSpeed);
    if (p.art) {
      const a = p.art, ar = this._art;
      const setHex = (c, h) => { if (h != null) c.setHex(h, THREE.SRGBColorSpace); };
      if (a.amount != null) ar.amount = a.amount;
      if (a.elevLo != null) ar.elevLo = a.elevLo;
      if (a.elevHi != null) ar.elevHi = a.elevHi;
      if (a.duskHi != null) ar.duskHi = a.duskHi;
      if (a.duskLo != null) ar.duskLo = a.duskLo;
      setHex(ar.duskKey, a.duskKeyHex); setHex(ar.duskSky, a.duskSkyHex); setHex(ar.duskGnd, a.duskGroundHex);
      if (a.duskKeyScale != null) ar.duskKeyScale = a.duskKeyScale;
      if (a.duskFillScale != null) ar.duskFillScale = a.duskFillScale;
      setHex(ar.key, a.keyHex); setHex(ar.sky, a.skyHex); setHex(ar.gnd, a.groundHex);
      setHex(ar.amb, a.ambientHex); setHex(ar.envUp, a.envUpHex);
      setHex(ar.envHor, a.envHorizonHex); setHex(ar.envGnd, a.envGroundHex);
      if (a.keyIntensity != null) ar.keyI = a.keyIntensity;
      if (a.hemiIntensity != null) ar.hemiI = a.hemiIntensity;
      if (a.ambientIntensity != null) ar.ambI = a.ambientIntensity;
      if (a.envLevel != null) ar.envLevel = a.envLevel;
      if (a.envSun != null) ar.envSun = a.envSun;
      if (a.envUpPow != null) ar.envUpPow = a.envUpPow;
    }
    if (p.azimuth != null) this._azimuth = p.azimuth;
    if (p.maxElevation != null) this._maxElev = p.maxElevation;
    this._envDirty = true;
  }

  /**
   * City sky glow — an additive warm dome tint hugging the horizon, biased
   * toward the city centroid, that only appears at night. engine.js calls this
   * when the lit-window/lamp population changes; it is cheap enough to call
   * every frame but does not need to be.
   *
   * @param {{x?:number, z?:number, amount?:number, color?:THREE.Color|number|number[]}} g
   *   x, z    world position of the lit-city centroid (world units, 0..640)
   *   amount  0 = dark town, 1 = a metropolis. Roughly
   *           `clamp(litWindowCount / 900, 0, 1)` reads well.
   *   color   optional glow tint (sRGB hex, THREE.Color, or [r,g,b] linear)
   *   Pass null / {amount:0} to switch it off.
   */
  setCityGlow(g) {
    if (!g) { this._cityAmt = 0; return; }
    if (Number.isFinite(g.x)) this._cityX = g.x;
    if (Number.isFinite(g.z)) this._cityZ = g.z;
    if (Number.isFinite(g.amount)) this._cityAmt = clamp(g.amount, 0, 1);
    if (g.color != null) {
      const c = this.uniforms.uCityGlowColor.value;
      if (typeof g.color === 'number') {
        const t = this._tmpColorRGB(0, 0, 0).setHex(g.color, THREE.SRGBColorSpace);
        c.set(t.r, t.g, t.b);
      } else if (Array.isArray(g.color)) {
        c.set(g.color[0], g.color[1], g.color[2]);
      } else if (g.color.isColor) {
        c.set(g.color.r, g.color.g, g.color.b);
      }
    }
  }

  // rain/snow/overcast ∈ 0..1. Overcast defaults to a function of rain.
  setWeather(w) {
    w = w || {};
    this._rain = clamp(w.rain != null ? w.rain : this._rain, 0, 1);
    this._snow = clamp(w.snow != null ? w.snow : this._snow, 0, 1);
    const auto = clamp(this._rain * 0.92 + this._snow * 0.7, 0, 1);
    this._overcastTarget = w.overcast != null ? clamp(w.overcast, 0, 1) : auto;
  }

  // -------------------------------------------------------------------------
  // Sun / moon geometry
  // -------------------------------------------------------------------------

  // nightT: 0 = noon, 0.5 = the sun on the horizon, 1 = midnight.
  _computeSun(nightT) {
    const t = clamp(nightT, 0, 1);
    const elev = Math.sin(this._maxElev) * Math.cos(t * Math.PI);
    const el = Math.asin(clamp(elev, -1, 1));
    const az = this._azimuth + t * this._azSweep;
    const ce = Math.cos(el);
    this._sunDir.set(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az));
    this._sunDir.normalize();

    // The moon rides the opposite azimuth, offset so it is lit gibbous. Its
    // ELEVATION is authored, not mirrored: it climbs out of the ground at dusk
    // and then hangs low (default ~4.3°) for the whole night, which is the only
    // band of sky this game's camera ever frames. Below -0.30 it is safely out
    // of sight during the day.
    const maz = az + Math.PI + 0.55;
    const rise = smoothstep01((t - 0.36) / 0.20);
    const mel = lerp(-0.30, this._moonElev, rise);
    const cm = Math.cos(mel);
    this._moonDir.set(cm * Math.sin(maz), Math.sin(mel), cm * Math.cos(maz)).normalize();

    // The key light the scene should actually be lit by.
    if (this._sunDir.y > 0.0) {
      // Light wave-2 r1: the KEY's elevation is softly floored (0..40 deg ->
      // 20..40 deg; above 40 unchanged). At a true 7 deg sun every wall in a
      // dense iso city sat in a neighbour's shadow, so golden hour rendered
      // as a flat, fill-only frame. The warm colour and the dimming (see the
      // dusk palette in _computeLighting) carry the time of day; the key
      // keeps lighting faces and throws long-but-bounded shadows. The dome
      // still draws the true sun (sunDir is untouched).
      const kel = el >= 0.6981 ? el : 0.3491 + el * 0.5;
      const ck = Math.cos(kel);
      this._keyDir.set(ck * Math.sin(az), Math.sin(kel), ck * Math.cos(az)).normalize();
    } else if (this._moonDir.y > 0.02) this._keyDir.copy(this._moonDir);
    else this._keyDir.copy(this._sunDir).negate();
    this._out.isMoon = this._sunDir.y <= 0.0;

    // Orthonormal basis across the moon disc (for craters + sphere shading).
    this._moonU.crossVectors(this._up, this._moonDir);
    if (this._moonU.lengthSq() < 1e-6) this._moonU.set(1, 0, 0);
    this._moonU.normalize();
    this._moonV.crossVectors(this._moonDir, this._moonU).normalize();
  }

  // -------------------------------------------------------------------------
  // JS mirror of the GLSL scattering — used for the lighting suggestion so the
  // fog / hemisphere colours always match what the dome actually draws.
  // -------------------------------------------------------------------------

  _sunIntensity(zenithCos) {
    return SUN_EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(clamp(zenithCos, -1, 1))) / STEEPNESS)));
  }

  // Full mirror of the fragment shader's main() colour path for one direction,
  // MINUS the clouds, the sun disc, the Mie glow, the city glow and the
  // below-horizon band (all of which are additive/local and must not colour the
  // fog). Everything else — Preetham, the twilight hue ramp, the warm blaze,
  // the luminance shoulder, the horizon tint, the night blend, overcast and the
  // final saturation grade — is reproduced exactly, because the value this
  // returns for dir.y ≈ 0 is what engine.js puts in scene.fog.color AND what
  // the shader is pinned to via uHorizonRef.
  _evalDome(dx, dy, dz, out) {
    const u = this.uniforms;
    const bR = u.uBetaR.value, bM = u.uBetaM.value;
    const g = u.uMieG.value;
    const sd = this._sunDir;
    const sunUpFade = u.uSunUpFade.value;
    const horizFade = u.uHorizFade.value;

    const cosZ = Math.max(dy, 0);
    const deg = Math.acos(clamp(cosZ, -1, 1)) * 180 / Math.PI;
    const m = 1 / (cosZ + 0.15 * Math.pow(Math.max(0.001, 93.885 - deg), -1.253));
    const sR = RAYLEIGH_ZENITH * m, sM = MIE_ZENITH * m;

    const cosTheta = dx * sd.x + dy * sd.y + dz * sd.z;
    const x = cosTheta * 0.5 + 0.5;
    const rp = (3 / (16 * Math.PI)) * (1 + x * x);
    const g2 = g * g;
    const den = Math.max(1e-4, 1 + g2 - 2 * g * cosTheta);
    const mp = (1 / (4 * Math.PI)) * ((1 - g2) / (den * Math.sqrt(den)));

    const bRv = [bR.x, bR.y, bR.z], bMv = [bM.x, bM.y, bM.z];
    const E = u.uSunE.value;
    const expo = u.uExposure.value * lerp(8.0, 1.0, smoothstep01(sd.y / 0.60));
    const gam = 1 / (1.2 + 1.2 * sunUpFade);
    const addG = [0, 0.00035, 0.0009];

    for (let i = 0; i < 3; i++) {
      const Fex = Math.exp(-(bRv[i] * sR + bMv[i] * sM));
      const ratio = (bRv[i] * rp + bMv[i] * mp) / (bRv[i] + bMv[i]);
      let Lin = Math.pow(Math.max(0, E * ratio * (1 - Fex)), 1.5);
      const mixTo = Math.pow(Math.max(0, E * ratio * Fex), 0.5);
      Lin *= (1 - horizFade) + horizFade * mixTo;
      out[i] = Math.pow(Math.max(0, Lin * 0.04 * expo + addG[i]), gam);
    }

    // --- twilight hue ramp (shader's `lowSun` block) ---
    const lowSun = smoothstep01((0.20 - sd.y) / 0.22) * smoothstep01((sd.y + 0.30) / 0.20);
    if (lowSun > 0.001) {
      const hl = Math.hypot(dx, dz) || 1e-5;
      const sl = Math.hypot(sd.x, sd.z) || 1e-5;
      const az = (dx / hl) * (sd.x / sl) + (dz / hl) * (sd.z / sl);
      const w = smoothstep01((az + 0.45) / 1.35);
      const tw = [lerp(0.55, 1.00, w), lerp(0.31, 0.52, w), lerp(0.64, 0.17, w)];
      const wy = smoothstep01((dy - 0.06) / 0.52);
      tw[0] = lerp(tw[0], 0.26, wy); tw[1] = lerp(tw[1], 0.33, wy); tw[2] = lerp(tw[2], 0.80, wy);
      const band = smoothstep01((1.05 - dy) / 1.11);
      const Lt = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
      const Lw = Math.max(0.2126 * tw[0] + 0.7152 * tw[1] + 0.0722 * tw[2], 1e-4);
      const kk = lowSun * band * 0.94;
      for (let i = 0; i < 3; i++) out[i] = lerp(out[i], tw[i] * (Lt / Lw), kk);
    }
    // --- warm blaze at the sun ---
    const wb = smoothstep01((0.22 - Math.abs(dy)) / 0.24)
             * Math.pow(Math.max(cosTheta, 0), 3) * lowSun * 0.75;
    out[0] += 0.55 * wb; out[1] += 0.24 * wb; out[2] += 0.05 * wb;

    // --- luminance shoulder + cool horizon tint, then back to linear ---
    const Ld = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    const k = (Ld / (1 + Math.max(0, Ld - 0.66) * 1.55)) / Math.max(Ld, 1e-4);
    const hz = smoothstep01((0.34 - dy) / 0.40)
             * (1 - this._nightAmt * 0.75) * (1 - lowSun * 0.85);
    const TINT = [0.70, 0.86, 1.05];
    for (let i = 0; i < 3; i++) {
      out[i] = Math.pow(Math.max(0, out[i] * k * (1 + (TINT[i] - 1) * hz)), 2.2);
    }

    // --- night blend (nebula / stars / moon are deliberately not mirrored) ---
    const n = this._nightAmt;
    if (n > 0.0005) {
      const upT = smoothstep01((dy + 0.12) / 0.74);
      const nz = this.uniforms.uNightZenith.value;
      const nh = this.uniforms.uNightHorizon.value;
      out[0] = lerp(out[0], lerp(nh.x, nz.x, upT), n);
      out[1] = lerp(out[1], lerp(nh.y, nz.y, upT), n);
      out[2] = lerp(out[2], lerp(nh.z, nz.z, upT), n);
    }

    // --- overcast grey ---
    const oc = this._overcast;
    if (oc > 0.0005) {
      const L = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
      const gt = [lerp(0.95, 1.04, this._snow), lerp(0.98, 1.03, this._snow), lerp(1.04, 1.00, this._snow)];
      for (let i = 0; i < 3; i++) out[i] = lerp(out[i], L * gt[i], oc * 0.72);
    }

    // --- kid-friendly saturation grade ---
    const sat = lerp(this.uniforms.uSaturation.value, 1.12, lowSun * 0.75);
    const L2 = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    for (let i = 0; i < 3; i++) out[i] = Math.max(0, lerp(L2, out[i], sat));

    return out;
  }

  // Attenuation of direct sunlight along the sun ray → naturally reddens at
  // low elevation. Returns a normalized colour plus a 0..1 brightness.
  _sunTransmittance(out) {
    const bR = this.uniforms.uBetaR.value, bM = this.uniforms.uBetaM.value;
    const sd = this._sunDir;
    const cosZ = Math.max(sd.y, 0.0);
    const deg = Math.acos(clamp(cosZ, -1, 1)) * 180 / Math.PI;
    const m = 1 / (cosZ + 0.15 * Math.pow(Math.max(0.001, 93.885 - deg), -1.253));
    const bRv = [bR.x, bR.y, bR.z], bMv = [bM.x, bM.y, bM.z];
    let mx = 0;
    for (let i = 0; i < 3; i++) {
      out[i] = Math.exp(-(bRv[i] * RAYLEIGH_ZENITH * m + bMv[i] * MIE_ZENITH * m));
      if (out[i] > mx) mx = out[i];
    }
    if (mx > 1e-5) { out[0] /= mx; out[1] /= mx; out[2] /= mx; }
    return mx;
  }

  _computeLighting() {
    const sd = this._sunDir;
    const elev = sd.y;

    // The two Preetham fades. uSunUpFade drives the display gamma (bright
    // while the sun is up), uHorizFade the grazing-light term.
    this.uniforms.uSunUpFade.value = smoothstep01((elev + 0.16) / 0.26);
    this.uniforms.uHorizFade.value = clamp(Math.pow(1 - Math.max(elev, 0), 5), 0, 1);

    // --- night amount (matches the shader's uNight) ---
    // Twilight spans elevation 0° → -11.5°, so nightT=0.5 is still a sunset.
    const night = 1 - clamp((elev + 0.20) / 0.22, 0, 1);
    this._nightAmt = clamp(night, 0, 1);

    // --- sun / moon colour + intensity ---
    const rgb = this._rgb;
    this._sunTransmittance(rgb);
    // Push the sunset red a little further than physics for the kid palette.
    const low = clamp(1 - elev / 0.30, 0, 1);
    rgb[1] = lerp(rgb[1], rgb[1] * 0.92, low * 0.5);
    rgb[2] = lerp(rgb[2], rgb[2] * 0.78, low * 0.6);
    // Warm white at high sun rather than the pure 1,1,1 the model gives.
    const warm = 1 - clamp(elev / 0.8, 0, 1);
    rgb[1] = Math.min(1, rgb[1] * (1 - 0.010 * (1 - warm)));
    rgb[2] = Math.min(1, rgb[2] * (1 - 0.045 * (1 - warm)));

    // A sun sitting on the horizon still lights the city warmly, so the key
    // light must not reach zero until it is properly below.
    const dayI = Math.pow(clamp((elev + 0.075) / 0.30, 0, 1), 0.70);
    const moonI = 0.135 * this._nightAmt;   // night r1: 0.16 -> 0.135 (lit panes and lamp pools pop; masses still read)
    const oc = this._overcast;
    const intensity = (1.25 * dayI * (1 - oc * 0.72)) + moonI * (1 - oc * 0.5);

    if (this._nightAmt > 0.001 && dayI < 0.5) {
      // Blend toward cool moonlight as the sun sets.
      const k = this._nightAmt;
      this._sunColor.setRGB(
        // night r1: lavender moon (0.62/0.72/1.00 was ice blue)
        lerp(rgb[0], 0.70, k), lerp(rgb[1], 0.70, k), lerp(rgb[2], 1.00, k)
      );
    } else {
      this._sunColor.setRGB(rgb[0], rgb[1], rgb[2]);
    }
    // Overcast neutralises the key light.
    if (oc > 0.001) {
      const l = 0.2126 * this._sunColor.r + 0.7152 * this._sunColor.g + 0.0722 * this._sunColor.b;
      this._sunColor.lerp(this._tmpColorGrey(l), oc * 0.85);
    }

    // --- sky / fog / ground from the same model the dome draws ---
    // _evalDome() now mirrors the WHOLE shader colour path (twilight ramp,
    // night blend, overcast, grade), so no post-hoc palette fudging is needed
    // here — and, critically, fogColor is a value the dome genuinely draws.
    const n = this._nightAmt;
    // _evalDome() mirrors the Mie glow, which is tinted by uSunTint — refresh it
    // here rather than in _pushUniforms(), or fogColor lags the dome by a frame.
    this._sunTransmittance(this._rgb);
    this.uniforms.uSunTint.value.set(
      Math.max(Math.pow(this._rgb[0], 0.35), 0.02),
      Math.max(Math.pow(this._rgb[1], 0.35), 0.02),
      Math.max(Math.pow(this._rgb[2], 0.35), 0.02)
    );
    const z = this._evalDome(0, 1, 0, this._rgb);
    this._skyColor.setRGB(z[0], z[1], z[2]);

    // Horizon: average of toward-sun and away-from-sun, at y ≈ 0 (that is where
    // terrain.js's ground skirt runs out and hands over to this dome).
    const hx = sd.x, hz = sd.z;
    const hl = Math.hypot(hx, hz) || 1;
    const a = this._evalDome(hx / hl, 0.004, hz / hl, this._rgb);
    const ar = a[0], ag = a[1], ab = a[2];
    const b = this._evalDome(-hx / hl, 0.004, -hz / hl, this._rgb2);
    this._fogColor.setRGB((ar + b[0]) * 0.5, (ag + b[1]) * 0.5, (ab + b[2]) * 0.5);

    // --- warm rotation (CONTRACTS-RENDER §0.5 + agreement with lighting.js) --
    // Below ~34 deg of sun elevation the sky STOPS being a blue zenith and
    // becomes a warm horizon band, and a horizontal surface integrates far more
    // of that band than of the zenith. lighting.js already rotates the
    // hemisphere/ambient/IBL fill on this curve; the fog and the dome were left
    // behind, so a golden-hour frame was warm ground bolted to an ice-blue sky
    // (fog linear R/B 0.376 under a 2.83:1 key). Rotate at constant luminance —
    // fog is ~17 % of a lit terrain pixel and 100 % of the far field, so this
    // must not double as a brightness change.
    const elevDeg = Math.asin(clamp(elev, -1, 1)) * 180 / Math.PI;
    this._skyWarm = clamp(
      (1 - smoothstep01((elevDeg - this._warmLo) / (this._warmHi - this._warmLo)))
      * (1 - n) * this._warmMaster, 0, 1);
    if (this._skyWarm > 0.0005) {
      this._rotateToward(this._fogColor, this._warmHue,
        this._skyWarm * this._fogWarm, this._fogColor);
    }
    // NOTE: `_skyColor` (the ZENITH) is deliberately NOT rotated here.
    // engine.js copies it into `hemi.color`, whose setter lighting.js has
    // replaced with an accessor that applies its own rotation on read
    // (measured: sky.js 0.064/0.449/1.042 in -> hemi 0.617/0.344/0.452 out,
    // R/B 1.365, and materials.js's uSkyFillColor/uRimColor are fed from that
    // same accessor). Pre-warming here would rotate twice and print orange.

    // Cheerful bounce light: sunlit turf by day, deep blue at night.
    const bounceDay = 1 - n;
    this._groundColor.setRGB(
      lerp(0.066, 0.30, bounceDay) * (1 - oc * 0.25) + 0.02,   // night r1: 0.055 -> 0.066 (violet bounce)
      lerp(0.060, 0.36, bounceDay) * (1 - oc * 0.20) + 0.03,   // night r1: 0.070 -> 0.060
      lerp(0.150, 0.20, bounceDay) * (1 - oc * 0.10) + 0.03
    );

    this._ambientColor.setRGB(
      lerp(this._skyColor.r, 0.06, 0.35),
      lerp(this._skyColor.g, 0.08, 0.35),
      lerp(this._skyColor.b, 0.16, 0.35)
    );

    const o = this._out;
    o.intensity = intensity;
    o.hemiIntensity = lerp(0.62, 0.25, n) * lerp(1, 1.25, oc);   // night r1: 0.30 -> 0.25
    o.ambientIntensity = lerp(0.16, 0.185, n);   // night r1: 0.22 -> 0.185
    o.envIntensity = lerp(1.0, 0.45, n) * lerp(1, 0.85, oc);
    o.nightAmount = n;
    o.sunHeight = elev;
    o.sunElevation = Math.asin(clamp(elev, -1, 1));
    o.overcast = oc;
    // Published so engine.js can cross-check against lighting.js's own
    // `skylightWarmth` (they are computed from the same 34->18 deg curve).
    o.skylightWarmth = this._skyWarm;

    // --- authored daytime key/fill (DAYTIME ART DIRECTION) -----------------
    const art = this._art;
    const artAmt = clamp(art.amount, 0, 1)
      * smoothstep01((elevDeg - art.elevLo) / Math.max(1e-3, art.elevHi - art.elevLo))
      * (1 - n) * (1 - oc * 0.85);
    this._artAmt = artAmt;
    o.artAmount = artAmt;
    // Dusk palette (light wave-2 r1). Warm light ONLY on the key; the fill
    // swings cool and dims, so a white tower at golden hour reads golden on
    // its lit side, cool lavender on its shade side and is still white —
    // instead of one salmon wash. Luminance of the key/fill hues is
    // normalised so the swing is chroma; the level change is duskKey/FillScale.
    const dusk = 1 - smoothstep01((elevDeg - art.duskLo) / Math.max(1e-3, art.duskHi - art.duskLo));
    this._duskAmt = dusk;
    o.duskAmount = dusk;
    this._lerpHue(art.key, art.duskKey, dusk, this._keyColor);
    // Overcast still flattens the authored key toward grey, like the physical one.
    // Below duskLo the golden key fades out by the time the sun touches the
    // horizon, where the physical/moon solution takes over (artAmount).
    const setK = smoothstep01(elevDeg / Math.max(1e-3, art.duskLo));
    o.keyIntensity = art.keyI * (1 - oc * 0.72) * (1 + (art.duskKeyScale - 1) * dusk) * setK;
    this._lerpHue(art.sky, art.duskSky, dusk, this._fillSky);
    this._lerpHue(art.gnd, art.duskGnd, dusk, this._fillGround);
    this._fillAmbient.copy(art.amb);
    const fillK = (1 + (art.duskFillScale - 1) * dusk) * (0.7 + 0.3 * setK);
    this._duskFillK = fillK;
    o.fillHemiIntensity = art.hemiI * fillK;
    o.fillAmbientIntensity = art.ambI * fillK;
    return o;
  }

  /**
   * Place the key for the frame. `azimuth` is the noon azimuth (radians, same
   * convention as the constructor option: dir = (sin az, ., cos az)) and
   * `maxElevation` the noon elevation (radians). engine.js calls this every
   * frame to keep the key at a fixed angle to the ISO VIEW (upper-left), so it
   * is cheap when nothing changed and never re-bakes the PMREM by itself.
   */
  setSunFrame(azimuth, maxElevation) {
    let moved = false;
    if (Number.isFinite(azimuth) && Math.abs(azimuth - this._azimuth) > 1e-5) {
      this._azimuth = azimuth; moved = true;
    }
    if (Number.isFinite(maxElevation) && Math.abs(maxElevation - this._maxElev) > 1e-5) {
      this._maxElev = maxElevation; moved = true;
    }
    if (moved) {
      this._computeSun(this._nightT);
      // The env's key-side lobe follows the key; a whole 90-degree camera
      // snap is worth a re-bake, a sub-degree ease step is not.
      const d = Math.abs(Math.atan2(Math.sin(azimuth - (this._envLastAz || 0)),
        Math.cos(azimuth - (this._envLastAz || 0))));
      if (d > 0.08) { this._envDirty = true; this._envLastAz = azimuth; }
    }
    return moved;
  }

  /**
   * Rotate `src` toward `dst`'s HUE at `src`'s own luminance, by `w`.
   * Byte-for-byte the same operation as lighting.js's `_rotateToward()`, so the
   * fog and the skylight fill move along the same locus.
   */
  _rotateToward(src, dst, w, out) {
    const ls = 0.2126 * src.r + 0.7152 * src.g + 0.0722 * src.b;
    const ld = 0.2126 * dst.r + 0.7152 * dst.g + 0.0722 * dst.b;
    const k = ls / Math.max(ld, 1e-5);
    out.setRGB(
      src.r + (dst.r * k - src.r) * w,
      src.g + (dst.g * k - src.g) * w,
      src.b + (dst.b * k - src.b) * w
    );
    return out;
  }

  /**
   * Lerp `a` toward `b`'s HUE at `a`'s luminance, by `w` (linear colours).
   * Used by the dusk palette so the swing is chroma only; levels are set by
   * the separate dusk scales.
   */
  _lerpHue(a, b, w, out) {
    if (!(w > 0)) return out.copy(a);
    const la = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b;
    const lb = 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b;
    const k = la / Math.max(lb, 1e-5);
    return out.setRGB(a.r + (b.r * k - a.r) * w, a.g + (b.g * k - a.g) * w, a.b + (b.b * k - a.b) * w);
  }

  _tmpColorGrey(v) {
    if (!this._scratchColor) this._scratchColor = new THREE.Color();
    this._scratchColor.setRGB(v, v, v);
    return this._scratchColor;
  }

  _tmpColorRGB(r, g, b) {
    if (!this._scratchColor) this._scratchColor = new THREE.Color();
    this._scratchColor.setRGB(r, g, b);
    return this._scratchColor;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  _pushUniforms() {
    const u = this.uniforms;
    u.uTime.value = this._time;
    u.uNight.value = this._nightAmt;
    u.uOvercast.value = this._overcast;
    u.uSnowy.value = this._snow;
    u.uStars.value = clamp((this._nightAmt - 0.10) / 0.55, 0, 1) * (1 - this._overcast * 0.95);
    // Disc + cloud key light keep their own transmittance tint. Raised to a
    // fractional power so a high sun reads warm-WHITE (the eye white-balances)
    // while a setting sun still goes deep orange.
    this._sunTransmittance(this._rgb);
    u.uSunTint.value.set(
      Math.max(Math.pow(this._rgb[0], 0.35), 0.02),
      Math.max(Math.pow(this._rgb[1], 0.35), 0.02),
      Math.max(Math.pow(this._rgb[2], 0.35), 0.02)
    );
    // The dome is PINNED to the fog colour at dir.y == 0, so terrain fading to
    // scene.fog.color and the sky behind it are the same pixel value.
    const f = this._fogColor;
    u.uHorizonRef.value.set(f.r, f.g, f.b);
    // Warm rotation, shared with the fog above. uWarmHue is pre-normalised to
    // luminance 1 so warmRot() in the shader is a pure chroma swing.
    const wh = this._warmCloudHue;
    const whL = Math.max(1e-5, 0.2126 * wh.r + 0.7152 * wh.g + 0.0722 * wh.b);
    u.uWarmHue.value.set(wh.r / whL, wh.g / whL, wh.b / whL);
    u.uWarm.value = this._skyWarm * this._domeWarm;
    u.uHorizonLift.value = this._horizonLift;
    // Straight down: the far end of the below-horizon aerial-perspective ramp.
    // Darker and slightly greener than the horizon (ground bounce, not sky), so
    // the band reads as land receding rather than as a fill colour.
    const gc = this._groundColor;
    const dk = lerp(0.52, 0.30, this._nightAmt);
    u.uGroundDeep.value.set(
      f.r * dk + gc.r * 0.16,
      f.g * dk + gc.g * 0.18,
      f.b * dk + gc.b * 0.14
    );
    // Art-directed IBL (ENV_PASS). Levels ride the authored fill, not the
    // physical dome, so the studio sky is the same brightness at any hour it
    // is active; `uEnvArt` fades it out toward dusk/night.
    {
      const ar = this._art, dk = this._duskAmt || 0;
      // Dusk: the studio env dims and cools with the fill; its key-side lobe
      // takes the golden key (light wave-2 r1).
      const L = ar.envLevel * (this._duskFillK != null ? this._duskFillK : 1);
      const up = this._lerpHue(ar.envUp, ar.duskSky, dk, this._envUpTmp || (this._envUpTmp = new THREE.Color()));
      u.uEnvArt.value = this._artAmt;
      u.uEnvUpPow.value = ar.envUpPow;
      u.uEnvUp.value.set(up.r * L, up.g * L, up.b * L);
      u.uEnvHor.value.set(ar.envHor.r * L, ar.envHor.g * L, ar.envHor.b * L);
      u.uEnvGnd.value.set(ar.envGnd.r * L, ar.envGnd.g * L, ar.envGnd.b * L);
      const ks = ar.envSun * ar.envLevel * (this._out.keyIntensity != null ? this._out.keyIntensity / Math.max(1e-3, ar.keyI) : 1);
      const kc = this._keyColor;
      u.uEnvSun.value.set(kc.r * ks, kc.g * ks, kc.b * ks);
    }
    // City sky glow: warm sodium by default, cooled a touch by overcast.
    u.uCityGlow.value.set(this._cityDir.x, this._cityDir.y,
      this._cityAmt * lerp(1.0, 1.35, this._overcast), 3.0);
  }

  /**
   * @param {number} dt seconds
   * @param {object} ctx see CONTRACTS-RENDER.md §2
   * @returns {{sunDir:THREE.Vector3, sunColor:THREE.Color, skyColor:THREE.Color,
   *            groundColor:THREE.Color, intensity:number, ...}}
   */
  update(dt, ctx) {
    if (this._disposed) return this._out;
    ctx = ctx || {};
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0.016;
    this._time += d;

    if (ctx.quality != null && (ctx.quality | 0) !== this._quality) this.setQuality(ctx.quality);

    const nt = clamp(ctx.nightEff != null ? ctx.nightEff
                   : (ctx.nightT != null ? ctx.nightT : this._nightT), 0, 1);

    // Weather may arrive on ctx instead of setWeather().
    if (ctx.weather) {
      const r = clamp(ctx.weather.rain || 0, 0, 1);
      const s = clamp(ctx.weather.snow || 0, 0, 1);
      if (r !== this._rain || s !== this._snow) this.setWeather({ rain: r, snow: s });
    }
    // Ease overcast so weather changes don't pop.
    const oSpeed = 0.55;
    if (this._overcast !== this._overcastTarget) {
      const step = oSpeed * d;
      const diff = this._overcastTarget - this._overcast;
      this._overcast += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
    }

    const sunMoved = nt !== this._nightT;
    this._nightT = nt;
    if (sunMoved) this._computeSun(nt);
    this._computeLighting();
    this._pushUniforms();

    // Keep the dome centred on the camera and sized to its frustum.
    const cam = ctx.camera;
    if (cam) {
      // The dome is camera-centred, so the city's glow has to be re-aimed every
      // frame: it is a horizontal direction FROM the camera TOWARD the city.
      if (this._cityAmt > 0.0005) {
        const dxc = this._cityX - cam.position.x, dzc = this._cityZ - cam.position.z;
        const dl = Math.hypot(dxc, dzc);
        // Inside the city itself there is no meaningful direction — keep the
        // last one so the glow does not spin when the player orbits downtown.
        if (dl > 1e-3) this._cityDir.set(dxc / dl, dzc / dl);
      }
      this.mesh.position.copy(cam.position);
      const far = Number.isFinite(cam.far) ? cam.far : 2000;
      const near = Number.isFinite(cam.near) ? cam.near : 1;
      this.mesh.scale.setScalar(clamp(far * this._radiusFactor, near * 8, 8000));
    }

    // PMREM cadence.
    this._envTimer += d;
    if (this._envTimer >= this._envInterval ||
        Math.abs(this._nightT - this._envLastNight) >= this._envNightDelta ||
        Math.abs(this._overcast - this._envLastOvercast) >= 0.05) {
      this._envDirty = true;
    }
    const r = this._renderer || (ctx.renderer || null);
    if (r && this._envDirty) this._bakeEnvironment(r);

    return this._out;
  }

  // -------------------------------------------------------------------------
  // Environment / IBL
  // -------------------------------------------------------------------------

  _ensureEnvTargets(renderer) {
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
    if (!this._cubeRT) {
      const type = this._pickEnvType(renderer);
      this._cubeRT = new THREE.WebGLCubeRenderTarget(this._envSize, {
        type,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this._cubeCam = new THREE.CubeCamera(0.5, 40, this._cubeRT);
    }
  }

  _pickEnvType(renderer) {
    try {
      const ext = renderer.extensions;
      if (renderer.capabilities && renderer.capabilities.isWebGL2) return THREE.HalfFloatType;
      if (ext && ext.has && ext.has('OES_texture_half_float')) return THREE.HalfFloatType;
    } catch (e) { /* fall through */ }
    return THREE.UnsignedByteType;   // graceful degrade, never throw
  }

  _bakeEnvironment(renderer) {
    if (!renderer || this._disposed) return this._envTexture;
    try {
      this._ensureEnvTargets(renderer);
      this._cubeCam.update(renderer, this._envScene);
      // fromCubemap() writes into the SAME target every time, so the texture
      // identity is stable and materials never need re-binding.
      this._envRT = this._pmrem.fromCubemap(this._cubeRT.texture, this._envRT);
      const tex = this._envRT.texture;
      const changed = tex !== this._envTexture;
      this._envTexture = tex;
      this._envDirty = false;
      this._envTimer = 0;
      this._envLastNight = this._nightT;
      this._envLastOvercast = this._overcast;
      this._envBuilds++;
      if (this._applyEnv) this.scene.environment = tex;
      if (changed && this.onEnvironmentUpdate) this.onEnvironmentUpdate(tex);
    } catch (e) {
      // Never render black / never throw: just keep whatever we had.
      this._envDirty = false;
      this._envTimer = 0;
      if (typeof console !== 'undefined') console.warn('[sky] env bake failed:', e);
    }
    return this._envTexture;
  }

  /** THREE.Texture (PMREM cube-uv) for scene.environment / IBL. */
  getEnvironment(renderer) {
    const r = renderer || this._renderer;
    if (r && !this._renderer) this._renderer = r;
    if (r && (this._envDirty || !this._envTexture)) this._bakeEnvironment(r);
    return this._envTexture;
  }

  /** Force the next update()/getEnvironment() to re-bake. */
  invalidateEnvironment() { this._envDirty = true; }

  _disposeEnvTargets() {
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this._cubeRT) { this._cubeRT.dispose(); this._cubeRT = null; }
    this._cubeCam = null;
    this._envTexture = null;
  }

  // -------------------------------------------------------------------------

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this._envMesh.parent) this._envMesh.parent.remove(this._envMesh);
    this._disposeEnvTargets();
    if (this._pmrem) { this._pmrem.dispose(); this._pmrem = null; }
    this._geo.dispose();
    this.material.dispose();
    if (this._envMaterial) this._envMaterial.dispose();
    this._noise.dispose();
    if (this._applyEnv && this.scene.environment === this._envTexture) this.scene.environment = null;
    if (this.scene.background === null) this.scene.background = this._prevBackground || null;
  }
}

// ---------------------------------------------------------------------------
// §4 self test
// ---------------------------------------------------------------------------

export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL ' + m); };
  const ok = (m) => notes.push('ok   ' + m);

  const finiteColor = (c) => Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);

  let sky = null;
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x123456);
    sky = new Sky(scene, { quality: 2 });

    // --- structure ---
    if (!sky.mesh || !scene.children.includes(sky.mesh)) fail('dome not added to scene');
    else ok('dome added to scene');
    if (scene.background !== null) fail('scene.background not cleared'); else ok('scene.background replaced');
    if (sky.material.fog !== false) fail('sky material is fogged'); else ok('sky dome is fog-exempt');
    if (sky.material.depthWrite !== false) fail('sky writes depth (would break SSAO/DOF)');
    else ok('sky does not write depth');
    if (sky.mesh.renderOrder >= 0) fail('sky renderOrder must be negative'); else ok('renderOrder ' + sky.mesh.renderOrder);

    // --- noise atlas ---
    const img = sky.uniforms.uNoise.value.image;
    if (!img || img.width !== 256 || img.height !== 256) fail('noise atlas is not 256x256');
    else {
      let mn = 255, mx = 0, sum = 0;
      for (let i = 0; i < img.data.length; i += 4) { const v = img.data[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
      if (mx - mn < 60) fail('noise atlas has no dynamic range');
      else ok('noise atlas range ' + mn + '..' + mx + ' mean ' + (sum / (img.data.length / 4)).toFixed(1));
    }

    // --- lighting sweep, no NaNs, plausible ranges ---
    const ctx = { camera: new THREE.PerspectiveCamera(40, 1, 1, 2000), quality: 2 };
    let maxI = 0, minI = 1e9, prevElev = null, monotonicDown = true;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      ctx.nightT = t; ctx.nightEff = t;
      const o = sky.update(0.016, ctx);
      if (!Number.isFinite(o.intensity)) { fail('NaN intensity at nightT=' + t); break; }
      if (!finiteColor(o.sunColor) || !finiteColor(o.skyColor) ||
          !finiteColor(o.groundColor) || !finiteColor(o.fogColor)) { fail('NaN colour at nightT=' + t); break; }
      if (!Number.isFinite(o.sunDir.x + o.sunDir.y + o.sunDir.z)) { fail('NaN sunDir at nightT=' + t); break; }
      const len = o.sunDir.length();
      if (Math.abs(len - 1) > 1e-4) { fail('sunDir not normalized at nightT=' + t); break; }
      if (o.skyColor.r < 0 || o.skyColor.g < 0 || o.skyColor.b < 0) { fail('negative skyColor'); break; }
      maxI = Math.max(maxI, o.intensity); minI = Math.min(minI, o.intensity);
      if (prevElev !== null && o.sunElevation > prevElev + 1e-6) monotonicDown = false;
      prevElev = o.sunElevation;
    }
    if (pass) ok('40-step nightT sweep clean; intensity ' + minI.toFixed(3) + '..' + maxI.toFixed(3));
    if (!monotonicDown) fail('sun elevation is not monotonically decreasing over nightT');
    else ok('sun descends monotonically 0→1');
    if (maxI < 0.8) fail('noon key light too dim (' + maxI.toFixed(2) + ')');
    if (minI > 0.4) fail('midnight key light too bright (' + minI.toFixed(2) + ')');

    // --- day vs night look ---
    ctx.nightT = ctx.nightEff = 0; sky.update(0.016, ctx);
    const dayLum = 0.2126 * sky._skyColor.r + 0.7152 * sky._skyColor.g + 0.0722 * sky._skyColor.b;
    const dayBlue = sky._skyColor.b > sky._skyColor.r * 1.25;
    if (!dayBlue) fail('noon zenith is not blue');
    else ok('noon zenith blue (r' + sky._skyColor.r.toFixed(3) + ' b' + sky._skyColor.b.toFixed(3) + ')');
    ctx.nightT = ctx.nightEff = 1; sky.update(0.016, ctx);
    const nightLum = 0.2126 * sky._skyColor.r + 0.7152 * sky._skyColor.g + 0.0722 * sky._skyColor.b;
    if (!(nightLum < dayLum * 0.35)) fail('night is not darker than day');
    else ok('night zenith ' + nightLum.toFixed(4) + ' < day ' + dayLum.toFixed(4));
    if (!(nightLum > 0.0015)) fail('night sky is black, not deep blue');
    else ok('night sky retains luminance ' + nightLum.toFixed(4));
    if (sky.uniforms.uStars.value < 0.9) fail('stars not fully on at midnight');
    else ok('stars on at midnight');

    // --- night celestial rig: the moon must be UP, and low enough to frame ---
    ctx.nightT = ctx.nightEff = 0.92; const nOut = sky.update(0.016, ctx);
    const mEl = Math.asin(clamp(nOut.moonDir.y, -1, 1)) * 180 / Math.PI;
    if (!(mEl > 0.5)) fail('moon is below the horizon at night (' + mEl.toFixed(1) + ' deg)');
    else if (mEl > 20) fail('moon too high to ever be in frame (' + mEl.toFixed(1) + ' deg); the game camera tops out ~4 deg above the horizon');
    else ok('moon up and low at night (' + mEl.toFixed(1) + ' deg)');
    if (!nOut.isMoon) fail('isMoon false at nightT 0.92');
    if (!(nOut.keyDir.y > 0)) fail('keyDir points below the horizon at night — lighting.js would key off nothing');
    else ok('keyDir above horizon at night (' + (Math.asin(nOut.keyDir.y) * 180 / Math.PI).toFixed(1) + ' deg)');
    ctx.nightT = ctx.nightEff = 0; const dOut = sky.update(0.016, ctx);
    if (dOut.keyDir.distanceTo(dOut.sunDir) > 1e-6) fail('keyDir is not the sun by day');
    else ok('keyDir tracks the sun by day');

    // --- fogColor must be the colour the dome is PINNED to at the horizon ---
    let refOk = true;
    for (const t of [0, 0.42, 0.55, 0.95]) {
      ctx.nightT = ctx.nightEff = t;
      const o = sky.update(0.016, ctx);
      const h = sky.uniforms.uHorizonRef.value;
      const d = Math.abs(h.x - o.fogColor.r) + Math.abs(h.y - o.fogColor.g) + Math.abs(h.z - o.fogColor.b);
      if (d > 1e-6) { fail('uHorizonRef != fogColor at nightT ' + t); refOk = false; break; }
    }
    if (refOk) ok('uHorizonRef == returned fogColor at every time of day');

    // --- city glow setter ---
    sky.setCityGlow({ x: 320, z: 320, amount: 0.7 });
    if (!(sky._cityAmt > 0.69)) fail('setCityGlow did not take');
    sky.setCityGlow(null);
    if (sky._cityAmt !== 0) fail('setCityGlow(null) did not switch the glow off');
    else ok('setCityGlow set/clear');

    // --- sunset warmth ---
    ctx.nightT = ctx.nightEff = 0.5; sky.update(0.016, ctx);
    if (!(sky._sunColor.r > sky._sunColor.b * 1.4)) fail('sunset key light is not warm');
    else ok('sunset key light warm (r' + sky._sunColor.r.toFixed(2) + ' b' + sky._sunColor.b.toFixed(2) + ')');

    // --- skylight warm rotation agrees with lighting.js's 34 -> 18 deg ramp --
    // Find the nightT that puts the sun near 20 deg and near 45 deg.
    const atElev = (targetDeg) => {
      let best = 0, bd = 1e9;
      for (let i = 0; i <= 200; i++) {
        const t = i / 200;
        ctx.nightT = ctx.nightEff = t;
        const o = sky.update(0.016, ctx);
        const d = Math.abs(o.sunElevation * 180 / Math.PI - targetDeg);
        if (d < bd) { bd = d; best = t; }
      }
      ctx.nightT = ctx.nightEff = best;
      return sky.update(0.016, ctx);
    };
    const hi = atElev(45);
    if (!(hi.skylightWarmth < 0.02)) fail('sky warmed at a 45 deg sun (' + hi.skylightWarmth.toFixed(3) + ')');
    else ok('no warm rotation above 34 deg');
    if (Math.abs(hi.fogColor.r / Math.max(hi.fogColor.b, 1e-6)) > 0.75)
      fail('high-sun fog is not cool (R/B ' + (hi.fogColor.r / hi.fogColor.b).toFixed(3) + ')');
    else ok('high-sun fog stays cool (R/B ' + (hi.fogColor.r / hi.fogColor.b).toFixed(3) + ')');

    const lo = atElev(20);
    if (!(lo.skylightWarmth > 0.85)) fail('warm rotation not engaged at a 20 deg sun (' + lo.skylightWarmth.toFixed(3) + ')');
    else ok('warm rotation ' + lo.skylightWarmth.toFixed(3) + ' at a 20 deg sun');
    const rb = lo.fogColor.r / Math.max(lo.fogColor.b, 1e-6);
    const gb = lo.fogColor.g / Math.max(lo.fogColor.b, 1e-6);
    if (!(rb > 1.05 && rb < 1.40)) fail('golden-hour fog R/B out of the 1.1..1.3 band (' + rb.toFixed(3) + ')');
    else ok('golden-hour fog R/B ' + rb.toFixed(3));
    // R > G > B, or the rotation has gone through mauve instead of through gold.
    if (!(gb > 1.0 && gb < rb)) fail('golden-hour fog is not R>G>B (G/B ' + gb.toFixed(3) + ', R/B ' + rb.toFixed(3) + ')');
    else ok('golden-hour fog reads warm, not mauve (G/B ' + gb.toFixed(3) + ')');
    if (!finiteColor(lo.fogColor) || lo.fogColor.r < 0 || lo.fogColor.g < 0 || lo.fogColor.b < 0)
      fail('warm rotation produced a bad fogColor');

    // --- horizon bands must not be mathematically flat ----------------------
    // pow(1-y, k) has derivative -k at y == 0; the exp(-(y/s)^p>1) forms it
    // replaced had derivative 0 there, which is what quantised into the
    // frame-wide plates the reviewer measured. Assert the shape, cheaply.
    const bandK = [sky.uniforms.uHazeK.value, sky.uniforms.uMieK.value,
                   sky.uniforms.uCityK.value, sky.uniforms.uGroundK.value];
    let shapeOk = true;
    for (const kk of bandK) {
      if (!(kk >= 1.0)) { fail('band exponent ' + kk + ' < 1 (flat at the horizon)'); shapeOk = false; break; }
      // over 0..35 deg the profile must fall monotonically and reach near zero
      let prev = 1.0001;
      for (let i = 0; i <= 70; i++) {
        const y = Math.sin((i * 0.5) * Math.PI / 180);
        const v = Math.pow(1 - y, kk);
        if (!(v < prev)) { fail('band exponent ' + kk + ' is not monotone'); shapeOk = false; break; }
        prev = v;
      }
      if (!shapeOk) break;
      if (Math.pow(1 - Math.sin(35 * Math.PI / 180), kk) > 0.02) {
        fail('band exponent ' + kk + ' has not decayed by 35 deg'); shapeOk = false; break;
      }
    }
    if (shapeOk) ok('horizon bands monotone, non-flat at y=0, decayed by 35 deg');
    if (!(sky.uniforms.uDither.value > 0.001)) fail('low-bit dither is off');
    else ok('dither ' + sky.uniforms.uDither.value);
    if (!(sky.uniforms.uHorizonLift.value > 1.0))
      notes.push('warn horizonLift is ' + sky.uniforms.uHorizonLift.value +
                 ' — must equal terrain.js uHorizonLift or the skyline steps');
    else ok('horizonLift ' + sky.uniforms.uHorizonLift.value + ' (must match terrain.js)');

    // --- weather ---
    sky.setWeather({ rain: 1 });
    ctx.nightT = ctx.nightEff = 0;
    for (let i = 0; i < 200; i++) sky.update(0.033, ctx);
    if (!(sky._overcast > 0.85)) fail('overcast did not ramp under rain');
    else ok('overcast ramped to ' + sky._overcast.toFixed(2));
    const oSat = Math.abs(sky._skyColor.r - sky._skyColor.b);
    sky.setWeather({ rain: 0 });
    for (let i = 0; i < 200; i++) sky.update(0.033, ctx);
    const cSat = Math.abs(sky._skyColor.r - sky._skyColor.b);
    if (!(oSat < cSat)) fail('overcast sky is not less saturated than clear sky');
    else ok('overcast desaturates sky (' + oSat.toFixed(3) + ' < ' + cSat.toFixed(3) + ')');

    // --- quality switching does not reallocate the world ---
    const geoId = sky._geo.uuid, meshId = sky.mesh.uuid;
    for (let i = 0; i < 12; i++) sky.setQuality(i % 3);
    if (sky._geo.uuid !== geoId || sky.mesh.uuid !== meshId) fail('quality switch rebuilt the dome');
    else ok('quality switches reuse the dome');
    sky.setQuality(2);

    // --- 100 resize cycles must not allocate ---
    for (let i = 0; i < 100; i++) sky.setSize(640 + i, 360 + i, 1 + (i % 2));
    ok('100 setSize cycles clean');

    // --- GPU: shader compiles, PMREM bakes, no target leak ---
    let r = renderer || null, ownRenderer = false;
    if (!r && typeof document !== 'undefined') {
      try {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        r = new THREE.WebGLRenderer({ canvas: cv, antialias: false });
        ownRenderer = true;
      } catch (e) { r = null; }
    }
    if (!r) {
      notes.push('skip  GPU checks (no WebGL context available)');
    } else {
      const cam = new THREE.PerspectiveCamera(40, 1, 1, 2000);
      cam.position.set(0, 10, 0);
      r.compile(scene, cam);
      const prog = r.info.programs || [];
      const bad = prog.filter(p => p.diagnostics && !p.diagnostics.runnable);
      if (bad.length) fail('sky shader failed to compile');
      else ok('sky shader compiles');

      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const env = sky.getEnvironment(r);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (!env || !env.isTexture) fail('getEnvironment returned no texture');
      else ok('PMREM env baked in ' + (t1 - t0).toFixed(1) + ' ms');

      // Repeat bakes must reuse the same target (stable identity, no leak).
      const firstTex = sky._envTexture, firstRT = sky._envRT;
      for (let i = 0; i < 30; i++) { sky.invalidateEnvironment(); sky.getEnvironment(r); }
      if (sky._envTexture !== firstTex || sky._envRT !== firstRT)
        fail('PMREM re-bake allocated a new render target (leak)');
      else ok('30 re-bakes reuse one render target');

      // Cadence: with no state change, update() must not bake every frame.
      const before = sky._envBuilds;
      const c2 = { camera: cam, nightT: 0, nightEff: 0, quality: 2 };
      for (let i = 0; i < 30; i++) sky.update(0.016, c2);   // ~0.5 s
      if (sky._envBuilds - before > 1) fail('PMREM baked ' + (sky._envBuilds - before) + 'x in 0.5 s');
      else ok('PMREM cadence respected (' + (sky._envBuilds - before) + ' bake in 0.5 s)');

      if (ownRenderer) { sky.dispose(); sky = null; r.dispose(); }
    }
  } catch (e) {
    pass = false;
    notes.push('FAIL exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    try { if (sky) sky.dispose(); } catch (e) { /* ignore */ }
  }

  return { pass, notes };
}

export default Sky;
