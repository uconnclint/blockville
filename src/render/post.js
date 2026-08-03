// src/render/post.js — the hand-rolled post-processing stack (CONTRACTS-RENDER.md §3.1).
//
// No EffectComposer, no three/addons: every pass below is written here against the
// vendored three.js r160 core. Pipeline, in order:
//
//   1. scene   -> HDR (half-float) target, MSAA-resolved, with a depth texture
//   2. SSAO    -> depth-derived normals, TWO hemisphere terms (tight contact x
//                 wide cavity), tangent-plane occluder gate (kills the
//                 grazing-angle false positive on flat ground), 4x4 ordered
//                 rotation, plane-predicting depth+normal bilateral denoise
//   3. lit     -> HDR * AO (one full-res multiply; also the AO debug tap)
//   4. bloom   -> soft-knee threshold + hue-preserving highlight clamp, 6-mip
//                 Karis downsample / tent upsample
//   5. DOF     -> tilt-shift CoC from depth (sky excluded), asymmetric near/far
//                 ramp, golden-angle bokeh gathered in PIXEL units + fill
//   6. grade   -> ACES (hue-preserving blend) + lift/gamma/gain, then a
//                 CHANNEL-SAFE contrast/saturation (see the grade block: no op
//                 may drive one channel to zero while its siblings survive),
//                 split-tone, depth desaturation (aerial perspective), vignette
//   7. sharpen -> AMD FidelityFX CAS  (BEFORE the AA resolve, see §"ordering")
//   8. AA      -> FXAA 3.11 quality preset 39 (on top of hardware MSAA)
//
// ordering: CAS runs *before* FXAA. Running it after re-hardens exactly the
// edges FXAA just resolved, which shows up as re-stepped silhouettes on
// high-contrast vertical tower edges. `sharpen.beforeAA = false` restores the
// old order for A/B.
//
// dither: the AO kernel rotation is a 4x4 ordered (Bayer) tile, and the AO
// denoise is a separable [1,2,2,2,1]/8 kernel — the mean of the two 4-wide
// boxes that straddle the centre texel, at a stride of exactly ONE texel.
// Four consecutive texels contain each of the four column phases of that row
// exactly once, so the horizontal pass leaves a value that depends only on the
// row phase; the vertical pass then averages the four row phases. The result is
// independent of both, i.e. the rotation cancels rather than being attenuated
// at some other frequency and then re-amplified by CAS.
//
// Measured on the reference city (hero shot, 2560x1440, quality 2), amplitude
// of the 1-texel-period component in the AO buffer (PM.aoDither):
//     raw (no denoise)                              7.80
//     stride 2 (parities never mix)                 5.59   (-28%)
//     stride 1, weights only (a plain Gaussian)     3.37   (-57%)
//     stride 1 + depth/normal bilateral (shipped)   2.19   (-72%)
// The bilateral is BETTER at cancelling the rotation than the Gaussian was, not
// worse: the taps it rejects are the cross-edge ones, where the raw AO differs
// most and the average was therefore least representative.
//
// Everything is procedural; no assets, no network. Works with the existing
// onBeforeCompile injections on the scene materials (we never touch materials).

import * as THREE from '../../vendor/three.module.js';

const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultParams() {
  return {
    ssao: {
      enabled: true,
      // Two multiplied terms. The wide one is the cavity/skylight term (street
      // canyons, courtyards); the tight one is CONTACT occlusion — the dark
      // seam where anything meets the ground. One radius cannot do both: at
      // 5.5 units the kernel steps straight over a 1-unit kerb and paints a
      // broad fake vignette up tall walls instead.
      intensity: 0.5,         // wide cavity term  (0..2)
      radius: 4.5,            // world units (tile = 8, voxel = 1)
      contactIntensity: 2.8,  // tight contact term
      contactRadius: 0.7,     // world units — a kerb step is 1
      bias: 0.025,            // view-space depth bias, kills self-occlusion acne
      // Tangent-plane gate (see occlude()). An occluder must rise this fraction
      // of the SAMPLE RADIUS above the centre fragment's own tangent plane
      // before it counts in full. This is what a depth bias cannot do: it is the
      // only test that can tell "a wall at my feet" from "the same flat ground I
      // am standing on, sampled along the view ray at a grazing angle". Set it
      // negative to disable the gate and reproduce the old grazing-angle false
      // positive for an A/B.
      //
      // The far-field fix is INSENSITIVE to this value (identical grass profile
      // at region for every planeBias in 0..0.4) because the uv snap makes the
      // coplanar rise exactly zero rather than merely small — this knob only
      // sets how softly the gate opens. It is therefore tuned down to where the
      // near-field contact peak is untouched: measured contact dip at hero,
      // gate off / 0.0 / 0.05 / 0.10 / 0.15 / 0.25 = 32.38 / 32.37 / 32.25 /
      // 31.94 / 31.32 / 28.94 %.
      planeBias: 0.05,
      power: 1.3,             // contrast of the cavity curve
      contactPower: 1.15,     // contrast of the contact curve
      minPixels: 2.5,         // screen-space floor: contact stays resolvable far away
      maxPixels: 72,          // screen-space ceiling: no cache thrash up close
      tint: [0.86, 0.90, 1.0], // cool shadow tint at full occlusion
      denoiseStride: 1,       // AO texels per denoise tap. MUST be 1 for the
                              // rotation to cancel; exposed only so the harness
                              // can reproduce the old checkerboard on demand.
      // Bilateral denoise guides. The filter reads the REAL depth texture (the
      // AO buffer is 8-bit and cannot carry a 0..far view distance — storing it
      // there clamped every non-sky texel to 1.0 and silently turned the
      // "bilateral" into a plain Gaussian that averaged unoccluded background
      // straight into the contact pixel).
      denoiseDepthSigma: 0.0045,  // tolerance as a FRACTION of view depth
      denoiseNormalPower: 6.0,    // silhouette/crease rejection sharpness
    },
    bloom: {
      enabled: true,
      // Wide + weak beats narrow + strong: a low threshold over many mips lets
      // a neon core bloom OUTWARD instead of clipping to flat white with a 5 px
      // halo. `clamp` limits the pre-blur highlight by a pure scale, which
      // preserves hue — emissives keep their colour at the core.
      threshold: 0.72,
      softness: 0.7,      // soft-knee width as a fraction of threshold
      strength: 0.30,
      radius: 0.9,        // upsample tent spread
      clamp: 2.4,         // max pre-blur highlight magnitude (hue-preserving)
    },
    dof: {
      enabled: true,
      autoFocus: true,
      focus: 0,           // view-space distance to the focal plane (auto when 0)
      range: 0,           // depth over which CoC ramps to 1 (auto when 0)
      rangeScale: 1.15,   // auto range = camDist * rangeScale
      nearRatio: 0.5,     // near range = range * this. <1 == the NEAR field
                          // defocuses faster than the far field, which is what
                          // sells the miniature read.
      strength: 1.0,
      // CoC 1.0 == this fraction of the HALF-RES buffer height as a bokeh
      // radius (see _dofRadiusPx). Resolution-independent by construction.
      maxBlur: 0.95,
      tilt: 0.62,         // PEAK CoC the tilt-shift band reaches on its own
      tiltStart: 0.24,    // |uv.y - centre| / halfBand where the band starts
      tiltEnd: 0.86,      // ...and where it SATURATES. Must be < 1: ramping all
                          // the way to the frame edge leaves the ramp at ~0.1
                          // over the middle 60% of the picture, which is what
                          // made the blur measure as "does nothing" over 83% of
                          // the frame even though the gather was running.
      tiltCenter: 0.5,    // uv.y of the focal LINE; the band is symmetric about it
      skyGuard: true,     // exclude depth == far plane from the CoC. Only turn
                          // this off to A/B the "blurred sky" regression.
    },
    // Aerial perspective. Deliberately colour-free: engine.js drives
    // scene.fog.near/far/color from the camera and the sky's horizon sample, so
    // adding colour here would double up. Distance desaturation is the part
    // analytic fog does NOT do, so the two compose instead of fighting.
    atmo: { strength: 0.10, start: 0.35, rangeScale: 3.5 },
    grade: {
      exposure: 1.65,     // ACES eats ~0.7 stop; this lands mid-grey back at ~0.5
      saturation: 1.24,
      contrast: 1.05,
      lift: 0.035,        // keep shadows readable — this is a kid's game, not noir
      gamma: 1.0,
      gain: 1.0,
      vignette: 0.28,
      punch: 0.5,         // 0 = plain ACES, 1 = fully hue/chroma preserving
      warm: 0.08,         // warm highlights / cool shadows split-tone amount
    },
    aa: { enabled: true, subpix: 0.75, edgeThreshold: 0.166, edgeThresholdMin: 0.0833 },
    sharpen: { enabled: true, amount: 0.3, beforeAA: true },
    // Debug / harness
    split: 0.0,           // 0 = full post, >0 = raw scene left of this uv.x
    debug: 'none',        // none | ao | bloom | coc | depth | normals | raw
  };
}

// Per-quality derived knobs. `aoSamples` now costs TWO depth taps each (contact
// + cavity), so the counts are lower than the single-radius version for the same
// bandwidth.
const QUALITY_TABLE = [
  // 0: low — no SSAO, no DOF, FXAA only, half-res bloom, no MSAA
  { msaa: 0, ao: false, aoScale: 0.5, aoSamples: 8,  dof: false, dofScale: 0.5, dofTaps: 12, bloomMips: 4, bloomScale: 0.5, aa: true, sharpen: false },
  // 1: medium — half-res SSAO, half-res DOF, 2x MSAA + FXAA
  { msaa: 2, ao: true,  aoScale: 0.5, aoSamples: 10, dof: true,  dofScale: 0.5, dofTaps: 24, bloomMips: 5, bloomScale: 0.5,  aa: true, sharpen: true },
  // 2: high — full-res SSAO, half-res DOF w/ 40 taps, 4x MSAA + CAS + FXAA
  { msaa: 4, ao: true,  aoScale: 1.0, aoSamples: 12, dof: true,  dofScale: 0.5, dofTaps: 40, bloomMips: 6, bloomScale: 0.5,  aa: true, sharpen: true },
];

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMMON = /* glsl */`
#define TAU 6.28318530718

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Non-linear depth -> positive view-space distance (perspective).
float linearDepth(float d, float n, float f) {
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}

vec3 srgbEncode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

const VIEWPOS = /* glsl */`
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uNear;
uniform float uFar;

// uv in 0..1, dist a positive view distance -> view-space position (z negative).
vec3 viewPosFromUv(vec2 uv, float dist) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0) * dist;
}
vec2 uvFromViewPos(vec3 p) {
  vec2 ndc = vec2(p.x / (uTanHalfFov * uAspect), p.y / uTanHalfFov) / max(1e-5, -p.z);
  return ndc * 0.5 + 0.5;
}
`;

// ---------------------------------------------------------------------------
// Pass shaders
// ---------------------------------------------------------------------------

const SSAO_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2  uTexel;        // 1 / full-res size (depth texture texel)
uniform vec2  uAOSize;       // AO buffer size, pixels (gl_FragCoord space)
uniform vec3  uKernel[16];
uniform int   uSamples;
uniform float uRadius;            // wide cavity radius, world units
uniform float uContactRadius;     // tight contact radius, world units
uniform float uBias;
uniform float uIntensity;
uniform float uContactIntensity;
uniform float uPower;
uniform float uContactPower;
uniform float uMinPixels;
uniform float uMaxPixels;
uniform float uPlaneBias;    // tangent-plane gate width, as a fraction of the radius
${COMMON}
${VIEWPOS}

float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

vec3 posAt(vec2 uv) {
  float d = rawDepth(uv);
  return viewPosFromUv(uv, linearDepth(d, uNear, uFar));
}

// One hemisphere sample -> range-checked occlusion in 0..1.
//
// TWO gates, and the second one is the whole reason distant ground stopped
// going black:
//
//  (a) the surface at the sample's screen position must be in FRONT of the
//      sample point (the classic hemisphere test), and
//  (b) that surface must RISE above the centre fragment's own tangent plane.
//
// (b) is not something a depth bias can express. When the ground is seen at a
// grazing angle, a tangential hemisphere sample travels almost straight down
// the view ray: it moves several world units DEEPER while moving a fraction of
// a pixel across the screen. Gate (a) then compares that sample against the
// depth of the SAME piece of ground it came from, finds it "behind" by several
// units, and reports occlusion — with the range check wide open, because the
// two depths it compares (z0 and the sampled surface) are the same number.
// Measured at the region shot: the contact term alone drove distant grass to 0.38
// (62% occluded) with nothing within eight tiles of it, while the wide cavity
// term — whose samples do project several pixels away — stayed flat at 0.90.
//
// Gate (b) is exact for a plane rather than merely tolerant of one: the sample
// uv is SNAPPED to the centre of the depth texel that is about to be read, so
// the tangent-plane depth is evaluated at precisely the point the sampled depth
// belongs to. For coplanar ground 'rise' is then zero by construction — no
// tolerance has to absorb the depth gradient, which at a grazing angle is
// ~2 world units per pixel and would swamp any fixed bias.
//
// 'tol' is the residual budget (depth quantisation + normal-reconstruction
// error), 'soft' the ramp width, both computed once per fragment in main().
float occlude(vec3 sp, vec3 P, vec3 N, float z0, float rad, float tol, float soft) {
  if (sp.z > -uNear) return 0.0;
  vec2 suv = uvFromViewPos(sp);
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return 0.0;
  suv = (floor(suv / uTexel) + 0.5) * uTexel;     // snap to the depth texel centre
  float sd = rawDepth(suv);
  if (sd >= 0.999995) return 0.0;                 // sky occludes nothing
  float sz = linearDepth(sd, uNear, uFar);
  if (sz >= -sp.z - uBias) return 0.0;

  float w = 1.0;
  if (uPlaneBias >= 0.0) {
    // Height of the occluder above the tangent plane at P, in world units.
    // Positive == a real ledge/wall/kerb; ~0 == the same surface, sampled
    // edge-on; negative == below the horizon, which occludes nothing.
    float rise = dot(viewPosFromUv(suv, sz) - P, N);
    if (rise <= tol) return 0.0;
    w = smoothstep(tol, tol + soft, rise);
  }

  // Range check: geometry far in FRONT of this sample must not cast occlusion
  // onto it, or every silhouette grows a halo.
  return w * smoothstep(0.0, 1.0, rad / max(1e-4, abs(z0 - sz)));
}

// 4x4 ordered (Bayer) tile: 16 distinct values, each appearing exactly once per
// tile. Used as the kernel rotation phase. The AO denoise below averages
// exactly one full tile period in each axis, so the phase term cancels
// identically instead of merely being attenuated -- which is what turns a
// 1-pixel rotation into a permanent checkerboard once CAS amplifies it.
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(a * 0.5) * 0.25 + bayer2(a); }

void main() {
  float d0 = rawDepth(vUv);
  // Sky: never occlude. g == 0 is also the sky marker for the harness.
  if (d0 >= 0.999995) { gl_FragColor = vec4(1.0, 0.0, 0.5, 0.5); return; }

  float z0 = linearDepth(d0, uNear, uFar);
  vec3 P = viewPosFromUv(vUv, z0);

  // Edge-aware normal reconstruction (pick the closer of the two neighbours per axis).
  vec3 pR = posAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pL = posAt(vUv - vec2(uTexel.x, 0.0));
  vec3 pU = posAt(vUv + vec2(0.0, uTexel.y));
  vec3 pD = posAt(vUv - vec2(0.0, uTexel.y));
  vec3 dx = (abs(pR.z - P.z) < abs(P.z - pL.z)) ? (pR - P) : (P - pL);
  vec3 dy = (abs(pU.z - P.z) < abs(P.z - pD.z)) ? (pU - P) : (P - pD);
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;                 // face the camera

  float a = bayer4(gl_FragCoord.xy) * TAU;
  vec3 rv = vec3(cos(a), sin(a), 0.0);
  vec3 T = normalize(rv - N * dot(rv, N));
  vec3 B = cross(N, T);
  mat3 TBN = mat3(T, B, N);

  // Screen-space clamp on both radii. The floor keeps the contact term at least
  // a couple of pixels wide at distance (otherwise every sample lands in the
  // centre texel and contact vanishes at the far end of the street); the
  // ceiling stops the cavity term from turning into a full-screen gather when
  // the camera is right down at the kerb.
  float pxPerWorld = (0.5 * uAOSize.y) / max(1e-4, uTanHalfFov * z0);
  float rWide    = clamp(uRadius        * pxPerWorld, uMinPixels, uMaxPixels)        / pxPerWorld;
  float rTight   = clamp(uContactRadius * pxPerWorld, uMinPixels, uMaxPixels * 0.35) / pxPerWorld;

  // Residual budget for the tangent-plane gate: 24-bit depth quantisation
  // (which grows as z^2) plus the ~2 deg error in the reconstructed normal,
  // whose contribution over a tangential step of 'rad' is ~0.035 * rad. Both
  // are tiny next to the grazing depth gradient the snap already removed.
  float quant = z0 * z0 * (uFar - uNear) / max(1e-4, uNear * uFar) * 1.2e-7;
  float tolW = uBias + quant + 0.035 * rWide;
  float tolT = uBias + quant + 0.035 * rTight;
  float softW = max(1e-4, uPlaneBias * rWide);
  float softT = max(1e-4, uPlaneBias * rTight);

  float occW = 0.0;
  float occT = 0.0;
  float total = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uSamples) break;
    vec3 k = TBN * uKernel[i];
    occW += occlude(P + k * rWide,  P, N, z0, rWide,  tolW, softW);
    occT += occlude(P + k * rTight, P, N, z0, rTight, tolT, softT);
    total += 1.0;
  }
  float inv = 1.0 / max(1.0, total);

  // Two terms, MULTIPLIED. The wide one is the cavity/skylight term (street
  // canyons, courtyards, the underside of an arch). The tight one is contact
  // occlusion -- the dark seam at a kerb step, a wheel on asphalt, a wall
  // meeting the pavement. A single radius cannot be both: at 5 world units the
  // kernel steps straight over a 1-unit kerb and paints a broad fake vignette
  // up tall walls instead.
  float aoW = pow(clamp(1.0 - occW * inv * uIntensity,        0.0, 1.0), uPower);
  float aoT = pow(clamp(1.0 - occT * inv * uContactIntensity, 0.0, 1.0), uContactPower);

  // Channel layout: r = AO, g = view depth NORMALISED by far (a >0 sky marker
  // only — the denoise reads the real depth texture, because 8 bits over
  // 0..2000 world units cannot resolve a 1-unit kerb), ba = view normal xy.
  // The normal is what lets the bilateral reject a wall texel that sits at the
  // SAME depth as the ground texel it meets, which is exactly the contact seam
  // the filter was smearing away.
  gl_FragColor = vec4(aoW * aoT, z0 / uFar, N.x * 0.5 + 0.5, N.y * 0.5 + 0.5);
}`;

// Separable bilateral (depth + normal aware) AO denoise.
//
// Weights [1,2,2,2,1]/8 over offsets -2..+2 == the mean of the two 4-wide boxes
// that straddle the centre texel. Four CONSECUTIVE texels contain each of the
// four column phases of the 4x4 rotation tile exactly once, so the horizontal
// pass produces a value that depends only on the row phase; the vertical pass
// then averages the four row phases and the result is independent of both.
// The rotation therefore cancels exactly rather than being attenuated at a
// different frequency than it was introduced (the old kernel sampled at a
// stride of 2 at full res, so odd and even columns never mixed at all and the
// per-pixel checkerboard survived untouched into CAS).
//
// Two things make it an actual BILATERAL and not a Gaussian wearing the name:
//
//  1. It reads the real depth texture. The previous version compared the AO
//     buffer's own .g channel, which held a raw 0..far view distance written to
//     an 8-bit RGBA target: every non-sky texel quantised to 1.0, every weight
//     collapsed to exp(0) == 1, and the filter averaged the unoccluded ground
//     BEYOND a wall straight into the contact texel at its base. That is why
//     the profile could come out non-monotonic — lighter at 1 px from the wall
//     than at 2 px, i.e. exactly backwards.
//
//  2. It predicts each tap's depth from the local PLANE (an edge-aware
//     one-sided slope along the blur axis) instead of comparing raw depths.
//     A ground plane running away from a low camera changes depth by several
//     units across five texels; a flat depth tolerance either rejects the whole
//     ground (leaving the kernel rotation uncancelled) or is so loose it also
//     accepts the silhouette. Predicting removes the slope and leaves only the
//     discontinuity, so the tolerance can be tight.
//
// The normal term handles the case depth cannot: a wall meeting the pavement is
// CONTINUOUS in depth but flips 90 degrees in normal.
//
// uDir must be exactly ONE AO texel along the blur axis.
const AO_BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 uDir;
uniform float uNear;
uniform float uFar;
uniform float uDepthSigma;     // tolerance as a fraction of view depth
uniform float uNormalPower;
${COMMON}

float rawD(vec2 uv) { return texture2D(tDepth, uv).x; }
float linZ(vec2 uv) { return linearDepth(rawD(uv), uNear, uFar); }
vec3 unpackN(vec4 s) {
  vec2 xy = s.zw * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

void main() {
  vec4 c = texture2D(tAO, vUv);
  if (rawD(vUv) >= 0.999995) { gl_FragColor = c; return; }   // sky: pass through

  float zc = linZ(vUv);
  vec3  n0 = unpackN(c);
  float tol = max(1e-4, uDepthSigma * zc);

  // Edge-aware one-sided slope, per texel, along the blur axis: take the
  // SMALLER of the two neighbour differences so a silhouette on one side does
  // not corrupt the plane prediction used on the other.
  float sp = linZ(vUv + uDir) - zc;
  float sm = zc - linZ(vUv - uDir);
  float slope = (abs(sp) < abs(sm)) ? sp : sm;

  float sum = c.r * 2.0;
  float wsum = 2.0;
  for (int i = 0; i < 4; i++) {
    float k = (i == 0) ? -2.0 : ((i == 1) ? -1.0 : ((i == 2) ? 1.0 : 2.0));
    float w = (abs(k) > 1.5) ? 1.0 : 2.0;
    vec2 uv = vUv + uDir * k;
    vec4 s = texture2D(tAO, uv);
    float sky = step(0.999995, rawD(uv));
    float wz = exp(-abs(linZ(uv) - (zc + slope * k)) / tol);
    float wn = pow(max(0.0, dot(unpackN(s), n0)), uNormalPower);
    float ww = w * wz * wn * (1.0 - sky);
    sum += s.r * ww;
    wsum += ww;
  }
  gl_FragColor = vec4(sum / max(1e-4, wsum), c.g, c.b, c.a);
}`;

const LIT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform float uAO;        // 0 = off
uniform vec3  uAOTint;
void main() {
  vec4 c = texture2D(tScene, vUv);
  if (uAO > 0.0) {
    float ao = texture2D(tAO, vUv).r;
    ao = mix(1.0, ao, uAO);
    // Occlusion darkens AND cools very slightly — reads as bounced skylight.
    c.rgb *= ao * mix(uAOTint, vec3(1.0), ao);
  }
  gl_FragColor = c;
}`;

const BLOOM_THRESH_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftness;
uniform float uClamp;
${COMMON}
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  // 4-tap box prefilter with Karis average -> kills single-pixel fireflies.
  vec3 s0 = tap(vec2(-1.0, -1.0));
  vec3 s1 = tap(vec2( 1.0, -1.0));
  vec3 s2 = tap(vec2(-1.0,  1.0));
  vec3 s3 = tap(vec2( 1.0,  1.0));
  float w0 = 1.0 / (1.0 + luma(s0));
  float w1 = 1.0 / (1.0 + luma(s1));
  float w2 = 1.0 / (1.0 + luma(s2));
  float w3 = 1.0 / (1.0 + luma(s3));
  vec3 c = (s0 * w0 + s1 * w1 + s2 * w2 + s3 * w3) / max(1e-4, w0 + w1 + w2 + w3);

  // Highlight roll-off. Limiting the magnitude by a PURE SCALE (not a per-
  // channel clamp) keeps the ratio between channels, so a saturated neon core
  // still blooms in its own hue instead of driving whichever channel is
  // largest into the ceiling and turning the core flat white. Without this a
  // far tower cluster stacks enough energy to smear yellow across a whole
  // block; with it the cluster spreads instead of piling up.
  float mag = max(max(c.r, c.g), c.b);
  c *= min(1.0, uClamp / max(1e-4, mag));

  float l = luma(c);
  float knee = max(1e-4, uThreshold * uSoftness);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, l - uThreshold) / max(1e-4, l);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

// Call-of-Duty style 13-tap downsample: stable, no pulsing under motion.
const BLOOM_DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // texel size of the SOURCE mip
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0,  2.0)); vec3 b = tap(vec2( 0.0,  2.0)); vec3 c = tap(vec2( 2.0,  2.0));
  vec3 d = tap(vec2(-2.0,  0.0)); vec3 e = tap(vec2( 0.0,  0.0)); vec3 f = tap(vec2( 2.0,  0.0));
  vec3 g = tap(vec2(-2.0, -2.0)); vec3 h = tap(vec2( 0.0, -2.0)); vec3 i = tap(vec2( 2.0, -2.0));
  vec3 j = tap(vec2(-1.0,  1.0)); vec3 k = tap(vec2( 1.0,  1.0));
  vec3 l = tap(vec2(-1.0, -1.0)); vec3 m = tap(vec2( 1.0, -1.0));
  vec3 o = e * 0.125;
  o += (a + c + g + i) * 0.03125;
  o += (b + d + f + h) * 0.0625;
  o += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}`;

// 9-tap tent upsample, drawn with additive blending into the finer mip.
const BLOOM_UP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // texel size of the SOURCE (coarser) mip
uniform float uRadius;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
void main() {
  vec3 o = tap(vec2(0.0, 0.0)) * 4.0;
  o += (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 2.0;
  o += tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(o / 16.0, 1.0);
}`;

// Half-res colour + circle-of-confusion prepass for the bokeh gather.
const DOF_DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uTexel;        // full-res texel
uniform float uFocus;
uniform float uRange;
uniform float uNearRange;
uniform float uStrength;
uniform float uTilt;
uniform float uTiltStart;
uniform float uTiltEnd;
uniform float uTiltCenter;
uniform float uSkyGuard;   // 1 = exclude the far plane from the CoC (see below)
${COMMON}
uniform float uNear;
uniform float uFar;

float cocAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  // The sky is at infinity and the depth buffer still holds the clear value
  // there (the sky dome writes no depth). Blurring it is the single most
  // obviously-wrong thing a tilt-shift can do: real miniature photography has a
  // pin-sharp backdrop because there is nothing at a finite distance to defocus.
  if (d >= 0.999995 && uSkyGuard > 0.5) return 0.0;

  float z = linearDepth(d, uNear, uFar);
  float dz = z - uFocus;
  // Asymmetric: the NEAR field defocuses over a shorter depth range than the
  // far field. That asymmetry is what reads as "macro lens on a model" rather
  // than "distant haze".
  float rng = (dz < 0.0) ? max(1e-3, uNearRange) : max(1e-3, uRange);
  float c = pow(clamp(abs(dz) / rng, 0.0, 1.0), 1.9) * uStrength;

  // Tilt-shift band, SYMMETRIC about the focal line at uTiltCenter. A one-sided
  // band (only above the line) leaves the near foreground sharp, and the near
  // blur is most of what sells the miniature look.
  //
  // The ramp SATURATES at uTiltEnd rather than at the frame edge. Ramping to
  // 1.0 puts smoothstep at ~0.11 halfway out, so the CoC over the middle 60% of
  // the picture was 0.01-0.03 — under the composite's own mix threshold, i.e.
  // the gather ran and its result was then multiplied by zero.
  float halfBand = (uv.y < uTiltCenter) ? uTiltCenter : (1.0 - uTiltCenter);
  float t = clamp(abs(uv.y - uTiltCenter) / max(0.05, halfBand), 0.0, 1.0);
  float tiltC = smoothstep(uTiltStart, max(uTiltStart + 0.05, uTiltEnd), t) * uTilt;
  return clamp(max(c, tiltC), 0.0, 1.0);
}

void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb;
  c *= 0.25;
  float coc = max(max(cocAt(vUv + vec2(-o.x, -o.y)), cocAt(vUv + vec2(o.x, -o.y))),
                  max(cocAt(vUv + vec2(-o.x,  o.y)), cocAt(vUv + vec2(o.x,  o.y))));
  // The max() above dilates CoC by one texel so a blurred silhouette does not
  // get a hard sharp seam -- but it must never leak onto the sky, so veto on
  // the centre sample's own depth.
  coc *= 1.0 - uSkyGuard * step(0.999995, texture2D(tDepth, vUv).x);
  gl_FragColor = vec4(c, coc);
}`;

// Golden-angle spiral bokeh gather. A tap only contributes if its own CoC is at
// least as large as its distance from the centre — that's what stops sharp
// foreground from bleeding into blurred background (and vice versa).
//
// That test has to be done in PIXELS. The old form compared the tap's CoC
// against the NORMALISED spiral radius r (0..1), but r is normalised to the
// centre pixel's own disc, whose physical size is uRadiusPx * centreCoC. At a
// CoC of 0.3 the outermost tap sits 0.3 * uRadiusPx from the centre while the
// test still demanded a CoC of ~0.7 to accept it, so most of the disc was
// discarded and the effective radius collapsed to a fraction of the nominal
// one. Comparing tap-CoC-in-pixels against tap-distance-in-pixels is both the
// correct scatter-as-gather criterion and scale invariant.
const DOF_BOKEH_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDof;
uniform vec2 uTexel;       // half-res texel
uniform float uRadiusPx;
uniform int uTaps;
${COMMON}
void main() {
  vec4 c0 = texture2D(tDof, vUv);
  // Jitter only within one spiral sector: enough to break up banding, not
  // enough to turn the far field into sparkle noise.
  float jitter = hash12(gl_FragCoord.xy) * (TAU / float(uTaps));
  vec3 sum = c0.rgb;
  float wsum = 1.0;
  float maxCoc = c0.a;
  // Small CoC -> tight gather (cheap + crisp). The floor is only there so a
  // sharp pixel adjacent to a blurred one can still see it and not leave a
  // hard seam; it must stay small or the focal band picks up neighbours.
  float rad = uRadiusPx * max(c0.a, 0.12);
  // NOTE the bound is 48, not 32: with a hard cap of 32 the loop stopped at tap
  // 31 while t was still normalised by uTaps-1 == 39, so the outer 20% of the
  // disc was never sampled at all. That missing rim is exactly what read as
  // blocky structure in the far bokeh.
  for (int i = 1; i < 48; i++) {
    if (i >= uTaps) break;
    float t = float(i) / float(uTaps - 1);
    float r = sqrt(t);
    float ang = float(i) * 2.39996323 + jitter;
    float distPx = r * rad;
    vec2 off = vec2(cos(ang), sin(ang)) * distPx;
    vec4 s = texture2D(tDof, vUv + off * uTexel);
    // Does this tap's own blur circle, in PIXELS, reach this far? One pixel of
    // soft transition so the disc rim does not alias.
    float w = clamp(s.a * uRadiusPx - distPx + 1.0, 0.0, 1.0);
    sum += s.rgb * w;
    wsum += w;
    maxCoc = max(maxCoc, s.a * w);
  }
  gl_FragColor = vec4(sum / max(1e-4, wsum), max(c0.a, maxCoc));
}`;

// Post-gather smoothing. A 32-tap spiral over a 16 px radius is undersampled at
// the rim, which shows up as mottling in the far field; a CoC-weighted 3x3 tent
// cleans it for ~0.02 ms and leaves sharp regions untouched.
const DOF_FILL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDof;
uniform vec2 uTexel;
void main() {
  vec4 c = texture2D(tDof, vUv);
  float k = smoothstep(0.06, 0.34, c.a);
  if (k <= 0.001) { gl_FragColor = c; return; }
  vec2 t = uTexel;
  vec4 s = c * 4.0;
  s += (texture2D(tDof, vUv + vec2( t.x, 0.0)) + texture2D(tDof, vUv + vec2(-t.x, 0.0)) +
        texture2D(tDof, vUv + vec2( 0.0, t.y)) + texture2D(tDof, vUv + vec2( 0.0, -t.y))) * 2.0;
  s +=  texture2D(tDof, vUv + vec2( t.x,  t.y)) + texture2D(tDof, vUv + vec2(-t.x,  t.y)) +
        texture2D(tDof, vUv + vec2( t.x, -t.y)) + texture2D(tDof, vUv + vec2(-t.x, -t.y));
  gl_FragColor = mix(c, s / 16.0, k);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tLit;
uniform sampler2D tBloom;
uniform sampler2D tDof;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform float uBloom;
uniform float uDof;
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform float uGamma;
uniform float uGain;
uniform float uVignette;
uniform float uPunch;
uniform float uWarm;
uniform vec3  uAtmo;      // (strength, startDist, endDist) — aerial perspective
uniform float uAspect2;
uniform int   uDebug;     // 0 none, 1 ao, 2 bloom, 3 coc, 4 depth, 5 normals
uniform float uNear;
uniform float uFar;
${COMMON}

const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c) {
  c = ACES_IN * c;
  c = rrtOdtFit(c);
  c = ACES_OUT * c;
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 c = texture2D(tLit, vUv).rgb;

  if (uDof > 0.0) {
    vec4 b = texture2D(tDof, vUv);
    // Ramp to a FULL mix by the time the CoC is worth ~3 half-res pixels of
    // bokeh. The old 0.04..0.42 window meant a CoC of 0.3 — the most the tilt
    // band ever produced — was mixed in at 40%, on top of a gather that had
    // already thrown away most of its disc. Two independent attenuations of a
    // blur that then measured as "no change".
    float m = smoothstep(0.02, 0.16, b.a) * uDof;
    c = mix(c, b.rgb, m);
  }
  if (uBloom > 0.0) {
    c += texture2D(tBloom, vUv).rgb * uBloom;
  }

  // ---- debug taps -------------------------------------------------------
  if (uDebug == 1) { float ao = texture2D(tAO, vUv).r; gl_FragColor = vec4(srgbEncode(vec3(ao)), 1.0); return; }
  if (uDebug == 2) { gl_FragColor = vec4(srgbEncode(texture2D(tBloom, vUv).rgb * uBloom), 1.0); return; }
  if (uDebug == 3) { gl_FragColor = vec4(srgbEncode(vec3(texture2D(tDof, vUv).a)), 1.0); return; }
  if (uDebug == 4) {
    float z = linearDepth(texture2D(tDepth, vUv).x, uNear, uFar);
    gl_FragColor = vec4(srgbEncode(vec3(1.0 - exp(-z * 0.004))), 1.0); return;
  }

  // ---- tonemap (scene-linear -> display-linear) -------------------------
  c *= uExposure;
  vec3 tm = acesFitted(c);
  float l = max(1e-4, luma(c));
  vec3 lumTM = acesFitted(vec3(l));
  vec3 hueP = clamp(c / l * lumTM.x, 0.0, 1.0);   // chroma-preserving variant
  c = mix(tm, hueP, uPunch);

  // ---- grade (display space — a pivot of 0.5 only makes sense here) ------
  //
  // CHANNEL-SAFETY INVARIANT: no operation below may drive one channel to zero
  // while its siblings survive. The previous grade broke that twice.
  //
  //   contrast:   (d - 0.5) * k + 0.5 with a hard clamp sends every channel
  //               under 0.5 - 0.5/k to exactly 0. At k = 1.2 that is everything
  //               below 0.083 in DISPLAY sRGB. In a shadowed green pixel R is
  //               the smallest channel, so R alone hit the floor and the pixel
  //               came out as pure toxic green — measured at 5.8% of the whole
  //               frame with R == 0 while G and B survived.
  //   saturation: mix(luma, d, s) is a linear extrapolation away from grey; it
  //               goes negative for any channel with d < g * (1 - 1/s).
  //
  // Both are now ratio-safe. Contrast acts on LUMINANCE and rescales the whole
  // triple, which cannot change the sign of anything. Saturation is limited,
  // per pixel, to the largest factor that leaves the darkest channel at least
  // a quarter of its input value — a limit that is provably never below 1.0,
  // so a requested saturation of 1.0 always applies in full and the guard only
  // engages on pixels that would otherwise have clipped.
  vec3 d = srgbEncode(c);

  d = clamp(d * uGain + uLift * (1.0 - d), 0.0, 1.0);
  d = pow(max(d, 0.0), vec3(1.0 / max(0.05, uGamma)));

  // contrast — luminance driven, ratio preserving
  {
    float y  = luma(d);
    float y2 = clamp((y - 0.5) * uContrast + 0.5, 0.0, 1.0);
    d *= y2 / max(y, 1e-4);
  }

  // saturation — luminance preserving, clip limited
  {
    float y = luma(d);
    vec3 dev = d - vec3(y);
    float minDev = min(min(dev.r, dev.g), dev.b);
    float s = uSaturation;
    // want: y + s*minDev >= K * (y + minDev), i.e. keep K of the darkest
    // channel. With K = 0.25 the bound simplifies to the expression below and
    // is >= 1 for every physically possible (y, minDev).
    if (minDev < -1e-6) s = min(s, (0.75 * y - 0.25 * minDev) / (-minDev));
    d = max(vec3(0.0), vec3(y) + dev * s);
  }

  float g = luma(d);

  // Split tone: cool shadows, warm highlights. Purely multiplicative, so it is
  // already channel safe — but do NOT clamp here; the hue-preserving ceiling
  // at the end of the grade handles anything over 1.
  vec3 shadowT = vec3(1.0 - uWarm * 0.7, 1.0 - uWarm * 0.25, 1.0 + uWarm);
  vec3 highT   = vec3(1.0 + uWarm, 1.0 + uWarm * 0.35, 1.0 - uWarm * 0.6);
  d = max(vec3(0.0), d * mix(shadowT, highT, smoothstep(0.15, 0.85, g)));

  // Hue-preserving ceiling: scale the triple down instead of clipping the
  // brightest channel, which would shift hue at the top exactly the way the
  // old floor shifted it at the bottom.
  {
    float mx = max(max(d.r, d.g), d.b);
    d *= 1.0 / max(1.0, mx);
  }

  // ---- aerial perspective (distance desaturation only) -------------------
  // engine.js already drives scene.fog for the colour half of aerial
  // perspective; adding colour here would double up. Losing CHROMA with
  // distance is the part analytic fog does not do, so the two compose.
  // The sky is excluded — it is the reference, not a subject.
  if (uAtmo.x > 0.0) {
    float dz = texture2D(tDepth, vUv).x;
    if (dz < 0.999995) {
      float zc = linearDepth(dz, uNear, uFar);
      float f = smoothstep(uAtmo.y, uAtmo.z, zc) * uAtmo.x;
      d = mix(d, vec3(luma(d)), f);
    }
  }

  // ---- vignette ---------------------------------------------------------
  vec2 vd = (vUv - 0.5) * vec2(uAspect2, 1.0);
  float vig = 1.0 - uVignette * smoothstep(0.28, 0.82, dot(vd, vd) * 1.55);
  d *= vig;

  gl_FragColor = vec4(clamp(d, 0.0, 1.0), 1.0);
}`;

// FXAA 3.11, quality preset 39 (12 search steps). Operates on sRGB-encoded LDR.
const FXAA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uRcp;               // 1 / resolution
uniform float uSubpix;
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;

float fl(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float fq(int i) {
  if (i < 5) return 1.0;
  if (i == 5) return 1.5;
  if (i < 10) return 2.0;
  if (i == 10) return 4.0;
  return 8.0;
}

void main() {
  vec2 posM = vUv;
  vec4 rgbyM = texture2D(tSrc, posM);
  float lumaM = fl(rgbyM.rgb);
  float lumaS = fl(texture2D(tSrc, posM + vec2( 0.0,  uRcp.y)).rgb);
  float lumaE = fl(texture2D(tSrc, posM + vec2( uRcp.x, 0.0)).rgb);
  float lumaN = fl(texture2D(tSrc, posM + vec2( 0.0, -uRcp.y)).rgb);
  float lumaW = fl(texture2D(tSrc, posM + vec2(-uRcp.x, 0.0)).rgb);

  float maxSM = max(lumaS, lumaM);
  float minSM = min(lumaS, lumaM);
  float maxESM = max(lumaE, maxSM);
  float minESM = min(lumaE, minSM);
  float maxWN = max(lumaN, lumaW);
  float minWN = min(lumaN, lumaW);
  float rangeMax = max(maxWN, maxESM);
  float rangeMin = min(minWN, minESM);
  float range = rangeMax - rangeMin;
  float rangeMaxClamped = max(uEdgeThresholdMin, rangeMax * uEdgeThreshold);
  if (range < rangeMaxClamped) { gl_FragColor = rgbyM; return; }

  float lumaNW = fl(texture2D(tSrc, posM + vec2(-uRcp.x, -uRcp.y)).rgb);
  float lumaSE = fl(texture2D(tSrc, posM + vec2( uRcp.x,  uRcp.y)).rgb);
  float lumaNE = fl(texture2D(tSrc, posM + vec2( uRcp.x, -uRcp.y)).rgb);
  float lumaSW = fl(texture2D(tSrc, posM + vec2(-uRcp.x,  uRcp.y)).rgb);

  float lumaNS = lumaN + lumaS;
  float lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = (-2.0 * lumaM) + lumaNS;
  float edgeVert1 = (-2.0 * lumaM) + lumaWE;

  float lumaNESE = lumaNE + lumaSE;
  float lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = (-2.0 * lumaE) + lumaNESE;
  float edgeVert2 = (-2.0 * lumaN) + lumaNWNE;

  float lumaNWSW = lumaNW + lumaSW;
  float lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);
  float edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);
  float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;
  float edgeVert3 = (-2.0 * lumaS) + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4;
  float edgeVert = abs(edgeVert3) + edgeVert4;

  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = uRcp.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;

  if (!horzSpan) lumaN = lumaW;
  if (!horzSpan) lumaS = lumaE;
  if (horzSpan) lengthSign = uRcp.y;
  float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;

  float gradientN = lumaN - lumaM;
  float gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM;
  float lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);

  vec2 posB = posM;
  vec2 offNP;
  offNP.x = (!horzSpan) ? 0.0 : uRcp.x;
  offNP.y = ( horzSpan) ? 0.0 : uRcp.y;
  if (!horzSpan) posB.x += lengthSign * 0.5;
  if ( horzSpan) posB.y += lengthSign * 0.5;

  vec2 posN = posB - offNP * fq(0);
  vec2 posP = posB + offNP * fq(0);
  float subpixD = ((-2.0) * subpixC) + 3.0;
  float lumaEndN = fl(texture2D(tSrc, posN).rgb);
  float subpixE = subpixC * subpixC;
  float lumaEndP = fl(texture2D(tSrc, posP).rgb);

  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;

  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled;
  bool doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) posN -= offNP * fq(1);
  if (!doneP) posP += offNP * fq(1);
  bool doneNP = (!doneN) || (!doneP);

  for (int i = 2; i < 12; i++) {
    if (!doneNP) break;
    if (!doneN) lumaEndN = fl(texture2D(tSrc, posN).rgb) - lumaNN * 0.5;
    if (!doneP) lumaEndP = fl(texture2D(tSrc, posP).rgb) - lumaNN * 0.5;
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP * fq(i);
    if (!doneP) posP += offNP * fq(i);
    doneNP = (!doneN) || (!doneP);
  }

  float dstN = horzSpan ? (posM.x - posN.x) : (posM.y - posN.y);
  float dstP = horzSpan ? (posP.x - posM.x) : (posP.y - posM.y);
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  float spanLength = dstP + dstN;
  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLengthRcp = 1.0 / max(1e-6, spanLength);
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = (dst * (-spanLengthRcp)) + 0.5;
  float subpixH = subpixG * uSubpix;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign;
  if ( horzSpan) posM.y += pixelOffsetSubpix * lengthSign;

  gl_FragColor = vec4(texture2D(tSrc, posM).rgb, rgbyM.a);
}`;

// AMD FidelityFX CAS. Runs BEFORE the AA resolve by default (see the ordering
// note at the top of the file): CAS after FXAA re-hardens exactly the steps
// FXAA has just resolved, and it amplifies whatever 1-pixel-period content is
// in the frame — measured here at roughly +85% high-frequency energy when it
// runs last.
const CAS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;     // sRGB-encoded LDR
uniform vec2 uRcp;
uniform float uSharpen;

void main() {
  vec3 e = texture2D(tSrc, vUv).rgb;
  if (uSharpen <= 0.0) { gl_FragColor = vec4(e, 1.0); return; }

  vec3 a = texture2D(tSrc, vUv + vec2(-uRcp.x, -uRcp.y)).rgb;
  vec3 b = texture2D(tSrc, vUv + vec2( 0.0,   -uRcp.y)).rgb;
  vec3 c = texture2D(tSrc, vUv + vec2( uRcp.x, -uRcp.y)).rgb;
  vec3 d = texture2D(tSrc, vUv + vec2(-uRcp.x,  0.0)).rgb;
  vec3 f = texture2D(tSrc, vUv + vec2( uRcp.x,  0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + vec2(-uRcp.x,  uRcp.y)).rgb;
  vec3 h = texture2D(tSrc, vUv + vec2( 0.0,     uRcp.y)).rgb;
  vec3 i = texture2D(tSrc, vUv + vec2( uRcp.x,  uRcp.y)).rgb;

  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mn2 = min(min(min(a, c), min(g, i)), mn);
  mn += mn2;
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 mx2 = max(max(max(a, c), max(g, i)), mx);
  mx += mx2;

  vec3 rcpMx = 1.0 / max(mx, vec3(1e-4));
  vec3 amp = clamp(min(mn, 2.0 - mx) * rcpMx, 0.0, 1.0);
  amp = sqrt(amp);
  float peak = -1.0 / mix(8.0, 5.0, clamp(uSharpen, 0.0, 1.0));
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
  gl_FragColor = vec4(clamp((b * w + d * w + f * w + h * w + e) * rcpW, 0.0, 1.0), 1.0);
}`;

// Final output: optional trailing CAS (only when sharpen.beforeAA === false)
// plus the raw/post A-B split wipe.
const OUTPUT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;     // sRGB-encoded LDR
uniform sampler2D tRaw;     // linear HDR scene, for the A/B split
uniform vec2 uRcp;
uniform float uSharpen;
uniform float uSplit;
${COMMON}

void main() {
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 outc = e;

  if (uSharpen > 0.0) {
    vec3 a = texture2D(tSrc, vUv + vec2(-uRcp.x, -uRcp.y)).rgb;
    vec3 b = texture2D(tSrc, vUv + vec2( 0.0,   -uRcp.y)).rgb;
    vec3 c = texture2D(tSrc, vUv + vec2( uRcp.x, -uRcp.y)).rgb;
    vec3 d = texture2D(tSrc, vUv + vec2(-uRcp.x,  0.0)).rgb;
    vec3 f = texture2D(tSrc, vUv + vec2( uRcp.x,  0.0)).rgb;
    vec3 g = texture2D(tSrc, vUv + vec2(-uRcp.x,  uRcp.y)).rgb;
    vec3 h = texture2D(tSrc, vUv + vec2( 0.0,     uRcp.y)).rgb;
    vec3 i = texture2D(tSrc, vUv + vec2( uRcp.x,  uRcp.y)).rgb;

    vec3 mn = min(min(min(d, e), min(f, b)), h);
    vec3 mn2 = min(min(min(a, c), min(g, i)), mn);
    mn += mn2;
    vec3 mx = max(max(max(d, e), max(f, b)), h);
    vec3 mx2 = max(max(max(a, c), max(g, i)), mx);
    mx += mx2;

    vec3 rcpMx = 1.0 / max(mx, vec3(1e-4));
    vec3 amp = clamp(min(mn, 2.0 - mx) * rcpMx, 0.0, 1.0);
    amp = sqrt(amp);
    float peak = -1.0 / mix(8.0, 5.0, clamp(uSharpen, 0.0, 1.0));
    vec3 w = amp * peak;
    vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
    outc = clamp((b * w + d * w + f * w + h * w + e) * rcpW, 0.0, 1.0);
  }

  if (uSplit > 0.0) {
    if (vUv.x < uSplit) {
      outc = srgbEncode(texture2D(tRaw, vUv).rgb);
    } else if (vUv.x < uSplit + uRcp.x * 1.5) {
      outc = vec3(1.0, 0.85, 0.2);
    }
  }

  gl_FragColor = vec4(outc, 1.0);
}`;

// ---------------------------------------------------------------------------
// PostFX
// ---------------------------------------------------------------------------

export class PostFX {
  constructor(renderer, scene, camera, opts = {}) {
    if (!renderer) throw new Error('PostFX: renderer is required');
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.params = defaultParams();
    if (opts.params) this.setParams(opts.params);

    this._quality = clamp(opts.quality === undefined ? 2 : opts.quality | 0, 0, 2);
    this._q = QUALITY_TABLE[this._quality];

    const caps = renderer.capabilities;
    this._webgl2 = !!caps.isWebGL2;
    const ext = renderer.extensions;
    this._hdrOK = this._webgl2 &&
      (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
    this._hdrType = this._hdrOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._maxSamples = this._webgl2 ? (caps.maxSamples || 0) : 0;

    this._w = 1; this._h = 1; this._pr = 1;

    // Fullscreen triangle.
    this._fsGeo = new THREE.BufferGeometry();
    this._fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsMesh = new THREE.Mesh(this._fsGeo, null);
    this._fsMesh.frustumCulled = false;
    this._fsScene = new THREE.Scene();
    this._fsScene.add(this._fsMesh);

    this._targets = [];       // every RT we own, for leak accounting
    this._materials = [];

    this._buildKernel();
    this._buildMaterials();

    const w = opts.width || 1, h = opts.height || 1;
    this.setSize(w, h, opts.pixelRatio || 1);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  _buildKernel() {
    // Deterministic cosine-ish hemisphere kernel, clustered near the origin.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0;
      return ((seed >>> 0) / 4294967296);
    };
    this._kernel = [];
    for (let i = 0; i < 16; i++) {
      const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 0.9 + 0.1);
      v.normalize();
      let s = i / 16;
      s = 0.25 + 0.75 * s * s;
      v.multiplyScalar(s);
      this._kernel.push(v);
    }
  }

  _mat(frag, uniforms, extra) {
    const m = new THREE.ShaderMaterial(Object.assign({
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    }, extra || {}));
    this._materials.push(m);
    return m;
  }

  _buildMaterials() {
    const U = (v) => ({ value: v });

    this.mSSAO = this._mat(SSAO_FRAG, {
      tDepth: U(null), uTexel: U(new THREE.Vector2()), uAOSize: U(new THREE.Vector2(1, 1)),
      uKernel: U(this._kernel), uSamples: U(12),
      uRadius: U(4.5), uContactRadius: U(0.95), uBias: U(0.025),
      uIntensity: U(0.5), uContactIntensity: U(1.6),
      uPower: U(1.3), uContactPower: U(1.15),
      uMinPixels: U(2.5), uMaxPixels: U(72.0), uPlaneBias: U(0.05),
      uTanHalfFov: U(0.36), uAspect: U(1.6), uNear: U(1), uFar: U(2000),
    });

    this.mAOBlur = this._mat(AO_BLUR_FRAG, {
      tAO: U(null), tDepth: U(null), uDir: U(new THREE.Vector2()),
      uNear: U(1), uFar: U(2000),
      uDepthSigma: U(0.0045), uNormalPower: U(6.0),
    });

    this.mLit = this._mat(LIT_FRAG, {
      tScene: U(null), tAO: U(null), uAO: U(1.0), uAOTint: U(new THREE.Vector3(0.86, 0.90, 1.0)),
    });

    this.mBloomThresh = this._mat(BLOOM_THRESH_FRAG, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()), uThreshold: U(0.85), uSoftness: U(0.6),
      uClamp: U(2.4),
    });
    this.mBloomDown = this._mat(BLOOM_DOWN_FRAG, { tSrc: U(null), uTexel: U(new THREE.Vector2()) });
    this.mBloomUp = this._mat(BLOOM_UP_FRAG,
      { tSrc: U(null), uTexel: U(new THREE.Vector2()), uRadius: U(0.85) },
      { blending: THREE.AdditiveBlending, transparent: true });

    this.mDofDown = this._mat(DOF_DOWN_FRAG, {
      tSrc: U(null), tDepth: U(null), uTexel: U(new THREE.Vector2()),
      uFocus: U(120), uRange: U(80), uNearRange: U(40), uStrength: U(1),
      uTilt: U(0.62), uTiltStart: U(0.24), uTiltEnd: U(0.88),
      uTiltCenter: U(0.5), uSkyGuard: U(1),
      uNear: U(1), uFar: U(2000),
    });
    this.mDofBokeh = this._mat(DOF_BOKEH_FRAG, {
      tDof: U(null), uTexel: U(new THREE.Vector2()), uRadiusPx: U(14), uTaps: U(32),
    });
    this.mDofFill = this._mat(DOF_FILL_FRAG, {
      tDof: U(null), uTexel: U(new THREE.Vector2()),
    });

    this.mComposite = this._mat(COMPOSITE_FRAG, {
      tLit: U(null), tBloom: U(null), tDof: U(null), tAO: U(null), tDepth: U(null),
      uBloom: U(0.55), uDof: U(1.0), uExposure: U(1.15), uSaturation: U(1.2),
      uContrast: U(1.1), uLift: U(0), uGamma: U(1), uGain: U(1), uVignette: U(0.34),
      uPunch: U(0.45), uWarm: U(0.075), uAtmo: U(new THREE.Vector3(0.1, 200, 900)),
      uAspect2: U(1.6), uDebug: U(0),
      uNear: U(1), uFar: U(2000),
    });

    this.mFXAA = this._mat(FXAA_FRAG, {
      tSrc: U(null), uRcp: U(new THREE.Vector2()), uSubpix: U(0.75),
      uEdgeThreshold: U(0.166), uEdgeThresholdMin: U(0.0833),
    });

    this.mCAS = this._mat(CAS_FRAG, {
      tSrc: U(null), uRcp: U(new THREE.Vector2()), uSharpen: U(0.3),
    });

    this.mOutput = this._mat(OUTPUT_FRAG, {
      tSrc: U(null), tRaw: U(null), uRcp: U(new THREE.Vector2()),
      uSharpen: U(0.4), uSplit: U(0.0),
    });
  }

  // -------------------------------------------------------------------------
  // Render targets
  // -------------------------------------------------------------------------

  _rt(w, h, o = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: o.filter || THREE.LinearFilter,
      magFilter: o.filter || THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: o.type || THREE.UnsignedByteType,
      depthBuffer: !!o.depth,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: o.samples || 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this._targets.push(rt);
    return rt;
  }

  _freeTargets() {
    for (let i = 0; i < this._targets.length; i++) {
      const rt = this._targets[i];
      if (rt.depthTexture) { rt.depthTexture.dispose(); rt.depthTexture = null; }
      rt.dispose();
    }
    this._targets.length = 0;
    this.rtScene = this.rtLit = this.rtAO0 = this.rtAO1 = null;
    this.rtDofA = this.rtDofB = this.rtLDR = this.rtAA = null;
    this.rtBloom = null;
  }

  _allocTargets() {
    const w = this._w, h = this._h, q = this._q;

    let samples = Math.min(q.msaa, this._maxSamples);
    if (!this._hdrOK) samples = Math.min(samples, 0);
    this._samples = samples;

    // 1. HDR scene target + depth texture.
    this.rtScene = this._rt(w, h, { type: this._hdrType, depth: true, samples });
    const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    dt.format = THREE.DepthFormat;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    this.rtScene.depthTexture = dt;

    // 2. AO ping-pong.
    const aw = Math.max(1, Math.round(w * q.aoScale));
    const ah = Math.max(1, Math.round(h * q.aoScale));
    this.rtAO0 = this._rt(aw, ah);
    this.rtAO1 = this._rt(aw, ah);
    this._aoW = aw; this._aoH = ah;

    // 3. AO-multiplied HDR.
    this.rtLit = this._rt(w, h, { type: this._hdrType });

    // 4. Bloom mip chain.
    this.rtBloom = [];
    let bw = Math.max(1, Math.round(w * q.bloomScale));
    let bh = Math.max(1, Math.round(h * q.bloomScale));
    for (let i = 0; i < q.bloomMips; i++) {
      this.rtBloom.push(this._rt(bw, bh, { type: this._hdrType }));
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }

    // 5. DOF (colour + CoC in alpha).
    const dw = Math.max(1, Math.round(w * q.dofScale));
    const dh = Math.max(1, Math.round(h * q.dofScale));
    this.rtDofA = this._rt(dw, dh, { type: this._hdrType });
    this.rtDofB = this._rt(dw, dh, { type: this._hdrType });
    this._dofW = dw; this._dofH = dh;

    // 6/7. LDR + AA.
    this.rtLDR = this._rt(w, h);
    this.rtAA = this._rt(w, h);

    this._allocCount = this._targets.length;
  }

  setSize(w, h, pixelRatio) {
    const pr = pixelRatio || this._pr || 1;
    const nw = Math.max(1, Math.round(w * pr));
    const nh = Math.max(1, Math.round(h * pr));
    if (nw === this._w && nh === this._h && this._targets.length) return;
    this._w = nw; this._h = nh; this._pr = pr;
    this._freeTargets();
    this._allocTargets();
  }

  setQuality(level) {
    const l = clamp(level | 0, 0, 2);
    if (l === this._quality && this._targets.length) return;
    const prevMsaa = this._q ? this._q.msaa : -1;
    const prevAoScale = this._q ? this._q.aoScale : -1;
    const prevMips = this._q ? this._q.bloomMips : -1;
    this._quality = l;
    this._q = QUALITY_TABLE[l];
    // Only reallocate when the target shapes actually change.
    if (this._q.msaa !== prevMsaa || this._q.aoScale !== prevAoScale || this._q.bloomMips !== prevMips) {
      this._freeTargets();
      this._allocTargets();
    }
  }

  getQuality() { return this._quality; }

  setParams(p) {
    if (!p) return;
    const dst = this.params;
    for (const k in p) {
      const v = p[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') {
        for (const k2 in v) {
          if (v[k2] !== undefined) dst[k][k2] = v[k2];
        }
      } else if (v !== undefined) {
        dst[k] = v;
      }
    }
    // Explicit focus/range disable the auto-derived values.
    if (p.dof && p.dof.focus !== undefined && p.dof.autoFocus === undefined) {
      dst.dof.autoFocus = !(p.dof.focus > 0);
    }
  }

  getParams() { return this.params; }

  /**
   * Bokeh radius, in HALF-RES pixels, for a circle of confusion of 1.0.
   * Exposed so the harness can assert the mapping instead of guessing at it.
   */
  _dofRadiusPx() {
    return Math.max(1.5, (this.params.dof.maxBlur || 0) * this._dofH * 0.025);
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  _blit(material, target, clear) {
    this._fsMesh.material = material;
    this.renderer.setRenderTarget(target || null);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this._fsScene, this._fsCam);
  }

  render(dt, ctx) {
    const r = this.renderer;
    if (!this.rtScene) this.setSize(this._w, this._h, this._pr);

    const camera = (ctx && ctx.camera) || this.camera;
    if (ctx && typeof ctx.quality === 'number' && ctx.quality !== this._quality) {
      this.setQuality(ctx.quality);
    }
    const q = this._q;
    const P = this.params;

    const near = camera.near, far = camera.far;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov || 40) * 0.5);
    const aspect = camera.aspect || (this._w / this._h);

    // ---- Save renderer state -------------------------------------------
    const oldTarget = r.getRenderTarget();
    const oldAutoClear = r.autoClear;
    const oldTone = r.toneMapping;
    const oldExposure = r.toneMappingExposure;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;

    // ---- 1. scene -> HDR ------------------------------------------------
    r.autoClear = true;
    r.setRenderTarget(this.rtScene);
    r.clear(true, true, true);
    if (this.scene) r.render(this.scene, camera);
    r.autoClear = false;

    const depthTex = this.rtScene.depthTexture;

    // ---- 2. SSAO ---------------------------------------------------------
    const S = P.ssao;
    const aoOn = q.ao && S.enabled !== false && (S.intensity > 0 || S.contactIntensity > 0);
    if (aoOn) {
      const u = this.mSSAO.uniforms;
      u.tDepth.value = depthTex;
      u.uTexel.value.set(1 / this._w, 1 / this._h);
      u.uAOSize.value.set(this._aoW, this._aoH);
      u.uSamples.value = q.aoSamples;
      u.uRadius.value = S.radius;
      u.uContactRadius.value = S.contactRadius;
      u.uBias.value = S.bias;
      u.uIntensity.value = S.intensity;
      u.uContactIntensity.value = S.contactIntensity;
      u.uPower.value = S.power;
      u.uContactPower.value = S.contactPower;
      u.uMinPixels.value = S.minPixels;
      u.uMaxPixels.value = S.maxPixels;
      u.uPlaneBias.value = S.planeBias === undefined ? 0.05 : S.planeBias;
      u.uTanHalfFov.value = tanHalf;
      u.uAspect.value = aspect;
      u.uNear.value = near;
      u.uFar.value = far;
      this._blit(this.mSSAO, this.rtAO0);

      // Stride is ALWAYS one AO texel: the [1,2,2,2,1]/8 kernel spans exactly
      // one period of the 4x4 rotation tile only at stride 1. Anything coarser
      // (the old code used 2 at full res) leaves the two column parities
      // completely unmixed, i.e. a per-pixel checkerboard.
      const stride = S.denoiseStride > 0 ? S.denoiseStride : 1;
      const b = this.mAOBlur.uniforms;
      b.tDepth.value = depthTex;
      b.uNear.value = near;
      b.uFar.value = far;
      b.uDepthSigma.value = S.denoiseDepthSigma > 0 ? S.denoiseDepthSigma : 0.0045;
      b.uNormalPower.value = S.denoiseNormalPower >= 0 ? S.denoiseNormalPower : 6.0;
      b.tAO.value = this.rtAO0.texture;
      b.uDir.value.set(stride / this._aoW, 0);
      this._blit(this.mAOBlur, this.rtAO1);
      b.tAO.value = this.rtAO1.texture;
      b.uDir.value.set(0, stride / this._aoH);
      this._blit(this.mAOBlur, this.rtAO0);
    }

    // ---- 3. lit = scene * AO --------------------------------------------
    {
      const u = this.mLit.uniforms;
      u.tScene.value = this.rtScene.texture;
      u.tAO.value = aoOn ? this.rtAO0.texture : null;
      u.uAO.value = aoOn ? 1.0 : 0.0;
      const t = P.ssao.tint;
      u.uAOTint.value.set(t[0], t[1], t[2]);
      this._blit(this.mLit, this.rtLit);
    }

    // ---- 4. bloom --------------------------------------------------------
    const bloomOn = P.bloom.enabled !== false && P.bloom.strength > 0;
    if (bloomOn) {
      const t = this.mBloomThresh.uniforms;
      t.tSrc.value = this.rtLit.texture;
      t.uTexel.value.set(1 / this._w, 1 / this._h);
      t.uThreshold.value = P.bloom.threshold;
      t.uSoftness.value = P.bloom.softness;
      t.uClamp.value = P.bloom.clamp > 0 ? P.bloom.clamp : 1e6;
      this._blit(this.mBloomThresh, this.rtBloom[0]);

      const d = this.mBloomDown.uniforms;
      for (let i = 1; i < this.rtBloom.length; i++) {
        const src = this.rtBloom[i - 1];
        d.tSrc.value = src.texture;
        d.uTexel.value.set(1 / src.width, 1 / src.height);
        this._blit(this.mBloomDown, this.rtBloom[i]);
      }
      const up = this.mBloomUp.uniforms;
      up.uRadius.value = P.bloom.radius;
      for (let i = this.rtBloom.length - 1; i > 0; i--) {
        const src = this.rtBloom[i];
        up.tSrc.value = src.texture;
        up.uTexel.value.set(1 / src.width, 1 / src.height);
        this._blit(this.mBloomUp, this.rtBloom[i - 1]);   // additive, no clear
      }
    }

    // ---- 5. tilt-shift DOF ----------------------------------------------
    const dofOn = q.dof && P.dof.enabled !== false && P.dof.strength > 0;
    let focus = 0;
    if (dofOn) {
      const camDist = (ctx && ctx.camDist) || 205;
      focus = P.dof.autoFocus ? camDist : (P.dof.focus > 0 ? P.dof.focus : camDist);
      const range = P.dof.range > 0 ? P.dof.range : Math.max(10, camDist * P.dof.rangeScale);
      // Miniature read: strongest at close orbit, subtle when zoomed way out.
      const mini = THREE.MathUtils.lerp(1.0, 0.45, THREE.MathUtils.smoothstep(camDist, 60, 320));

      const u = this.mDofDown.uniforms;
      u.tSrc.value = this.rtLit.texture;
      u.tDepth.value = depthTex;
      u.uTexel.value.set(1 / this._w, 1 / this._h);
      u.uFocus.value = focus;
      u.uRange.value = range;
      u.uNearRange.value = Math.max(4, range * (P.dof.nearRatio > 0 ? P.dof.nearRatio : 1));
      u.uStrength.value = P.dof.strength * mini;
      u.uTilt.value = P.dof.tilt * mini;
      u.uTiltStart.value = P.dof.tiltStart;
      u.uTiltEnd.value = P.dof.tiltEnd === undefined ? 0.86 : P.dof.tiltEnd;
      u.uTiltCenter.value = clamp(P.dof.tiltCenter === undefined ? 0.5 : P.dof.tiltCenter, 0.05, 0.95);
      // Kept as a knob purely so the sky-blur regression can be A/B'd from the
      // harness. Ship it at 1; there is no art-direction reason to blur infinity.
      u.uSkyGuard.value = P.dof.skyGuard === false ? 0 : 1;
      u.uNear.value = near;
      u.uFar.value = far;
      this._blit(this.mDofDown, this.rtDofA);

      const b = this.mDofBokeh.uniforms;
      b.tDof.value = this.rtDofA.texture;
      b.uTexel.value.set(1 / this._dofW, 1 / this._dofH);
      // CoC 1.0 maps to maxBlur * 2.5% of the half-res buffer height. Anchoring
      // to the buffer instead of a fixed 16 px at some assumed resolution keeps
      // the miniature read identical from 720p to 1440p, and makes the number
      // checkable: at maxBlur 0.95 and a 720-row half-res buffer this is 17.1
      // half-res px at CoC 1, i.e. 8.6 at CoC 0.5 — a real, countable bokeh
      // circle rather than a sub-texel one.
      b.uRadiusPx.value = this._dofRadiusPx();
      b.uTaps.value = q.dofTaps;
      this._blit(this.mDofBokeh, this.rtDofB);

      const f = this.mDofFill.uniforms;
      f.tDof.value = this.rtDofB.texture;
      f.uTexel.value.set(1 / this._dofW, 1 / this._dofH);
      this._blit(this.mDofFill, this.rtDofA);   // ping-pong: A is free again here
    }

    // ---- 6. composite (tonemap + grade + vignette) ----------------------
    {
      const u = this.mComposite.uniforms;
      const G = P.grade;
      u.tLit.value = this.rtLit.texture;
      u.tBloom.value = bloomOn ? this.rtBloom[0].texture : null;
      u.tDof.value = dofOn ? this.rtDofA.texture : null;   // after the fill pass
      u.tAO.value = aoOn ? this.rtAO0.texture : null;
      u.tDepth.value = depthTex;
      u.uBloom.value = bloomOn ? P.bloom.strength : 0;
      u.uDof.value = dofOn ? 1.0 : 0.0;
      u.uExposure.value = G.exposure;
      u.uSaturation.value = G.saturation;
      u.uContrast.value = G.contrast;
      u.uLift.value = G.lift;
      u.uGamma.value = G.gamma;
      u.uGain.value = G.gain;
      u.uVignette.value = G.vignette;
      u.uPunch.value = G.punch;
      u.uWarm.value = G.warm;
      const A = P.atmo || { strength: 0, start: 0.35, rangeScale: 3.5 };
      const camD = (ctx && ctx.camDist) || 205;
      u.uAtmo.value.set(A.strength, camD * A.start, camD * A.rangeScale);
      u.uAspect2.value = aspect;
      u.uNear.value = near;
      u.uFar.value = far;
      u.uDebug.value = DEBUG_ID[P.debug] || 0;
      this._blit(this.mComposite, this.rtLDR);
    }

    // ---- 7. sharpen + AA -------------------------------------------------
    // CAS runs BEFORE the AA resolve. Sharpening after FXAA re-hardens the very
    // steps FXAA just resolved and doubles the frame's 1-pixel-period energy;
    // sharpening first lets FXAA arbitrate the result. `sharpen.beforeAA=false`
    // puts CAS back in the final pass for A/B.
    const aaOn = q.aa && P.aa.enabled !== false && P.debug === 'none';
    const sharpenOn = q.sharpen && P.sharpen.enabled !== false && P.debug === 'none'
      && P.sharpen.amount > 0;
    const casFirst = sharpenOn && P.sharpen.beforeAA !== false && aaOn;

    let final = this.rtLDR;
    if (casFirst) {
      const u = this.mCAS.uniforms;
      u.tSrc.value = final.texture;
      u.uRcp.value.set(1 / this._w, 1 / this._h);
      u.uSharpen.value = P.sharpen.amount;
      this._blit(this.mCAS, this.rtAA);
      final = this.rtAA;
    }
    if (aaOn) {
      // Ping-pong between the two LDR targets so no third full-res target is
      // needed when CAS runs first.
      const dst = (final === this.rtAA) ? this.rtLDR : this.rtAA;
      const u = this.mFXAA.uniforms;
      u.tSrc.value = final.texture;
      u.uRcp.value.set(1 / this._w, 1 / this._h);
      u.uSubpix.value = P.aa.subpix;
      u.uEdgeThreshold.value = P.aa.edgeThreshold;
      u.uEdgeThresholdMin.value = P.aa.edgeThresholdMin;
      this._blit(this.mFXAA, dst);
      final = dst;
    }

    // ---- 8. output: trailing CAS (only if not already applied) + A/B split
    {
      const u = this.mOutput.uniforms;
      u.tSrc.value = final.texture;
      u.tRaw.value = this.rtScene.texture;
      u.uRcp.value.set(1 / this._w, 1 / this._h);
      u.uSharpen.value = (sharpenOn && !casFirst) ? P.sharpen.amount : 0;
      u.uSplit.value = P.split;
      this._blit(this.mOutput, null);
    }

    // ---- restore ---------------------------------------------------------
    r.setRenderTarget(oldTarget);
    r.autoClear = oldAutoClear;
    r.toneMapping = oldTone;
    r.toneMappingExposure = oldExposure;
  }

  dispose() {
    this._freeTargets();
    for (let i = 0; i < this._materials.length; i++) this._materials[i].dispose();
    this._materials.length = 0;
    this._fsGeo.dispose();
    this._fsScene.remove(this._fsMesh);
  }
}

const DEBUG_ID = { none: 0, ao: 1, bloom: 2, coc: 3, depth: 4, normals: 5, raw: 0 };

// ---------------------------------------------------------------------------
// selfTest — CONTRACTS-RENDER.md §4
// ---------------------------------------------------------------------------

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : ((s ? -1 : 1) * Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Headless-ish assertions. Pass a renderer to reuse the game's context;
 * otherwise a throwaway 64x64 context is created.
 * @returns {{pass:boolean, notes:string[]}}
 */
export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  let ownRenderer = false;
  let r = renderer;
  try {
    if (!r) {
      if (typeof document === 'undefined') {
        return { pass: false, notes: ['FAIL: no document and no renderer supplied'] };
      }
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      r = new THREE.WebGLRenderer({ canvas: c, antialias: false });
      ownRenderer = true;
    }
  } catch (e) {
    return { pass: false, notes: ['FAIL: could not create a WebGLRenderer: ' + e.message] };
  }

  // A tiny stand-in scene with the shapes the AO/DOF passes care about.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87d4f5);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 1, 2000);
  cam.position.set(28, 22, 28);
  cam.lookAt(0, 3, 0);
  const geo = new THREE.BoxGeometry(4, 8, 4);
  const mat = new THREE.MeshLambertMaterial({ color: 0xff8844 });
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set((i % 3) * 8 - 8, 4 + (i % 2) * 3, Math.floor(i / 3) * 8 - 4);
    scene.add(m);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
    new THREE.MeshLambertMaterial({ color: 0x86d94f }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b8f4e, 0.8));
  const dl = new THREE.DirectionalLight(0xfff4e0, 1.2);
  dl.position.set(40, 60, 20);
  scene.add(dl);

  let fx = null;
  const errors = [];
  const realError = console.error;
  const realWarn = console.warn;
  try {
    fx = new PostFX(r, scene, cam, { width: 256, height: 144, pixelRatio: 1, quality: 2 });
    ok('constructed (hdr=' + (fx._hdrOK ? 'half-float' : 'byte') + ', msaa=' + fx._samples + 'x)');

    // --- shaders compile ----------------------------------------------
    console.error = (...a) => { errors.push(a.join(' ')); };
    console.warn = (...a) => { const s = a.join(' '); if (/shader|program|glsl/i.test(s)) errors.push(s); };
    r.debug.checkShaderErrors = true;
    for (let q = 0; q <= 2; q++) {
      fx.setQuality(q);
      fx.render(0.016, { camera: cam, camDist: 120, quality: q });
    }
    console.error = realError;
    console.warn = realWarn;
    if (errors.length) fail('shader compile/link errors: ' + errors.slice(0, 3).join(' | '));
    else ok('all pass shaders compiled and linked at quality 0/1/2');

    fx.setQuality(2);
    fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });

    // --- no NaN/Inf in the HDR chain ----------------------------------
    if (fx._hdrType === THREE.HalfFloatType) {
      const buf = new Uint16Array(fx.rtLit.width * fx.rtLit.height * 4);
      try {
        r.readRenderTargetPixels(fx.rtLit, 0, 0, fx.rtLit.width, fx.rtLit.height, buf);
        let bad = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = halfToFloat(buf[i]);
          if (!Number.isFinite(v)) bad++;
        }
        if (bad) fail(bad + ' non-finite half-float texels in the lit HDR target');
        else ok('HDR lit target: ' + (buf.length / 4) + ' texels, all finite');
      } catch (e) {
        notes.push('skip: half-float readback unsupported (' + e.message + ')');
      }
    }

    // --- LDR output is sane -------------------------------------------
    {
      const w = fx.rtLDR.width, h = fx.rtLDR.height;
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, px);
      let sum = 0, mn = 255, mx = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += l; if (l < mn) mn = l; if (l > mx) mx = l;
      }
      const avg = sum / (px.length / 4);
      if (!Number.isFinite(avg)) fail('LDR readback produced NaN');
      else if (mx - mn < 4) fail('LDR output is flat (min ' + mn + ', max ' + mx + ') — pipeline likely broken');
      else if (avg < 12) fail('LDR output is nearly black (avg ' + avg.toFixed(1) + ')');
      else ok('LDR output avg ' + avg.toFixed(1) + ', range ' + mn + '..' + mx);
    }

    // --- AO actually darkens something --------------------------------
    {
      const w = fx.rtAO0.width, h = fx.rtAO0.height;
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtAO0, 0, 0, w, h, px);
      let mn = 255, occluded = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < mn) mn = px[i];
        if (px[i] < 230) occluded++;
      }
      const frac = occluded / (px.length / 4);
      if (mn > 250) fail('SSAO produced no occlusion anywhere (min ' + mn + ')');
      else ok('SSAO min ' + mn + ', ' + (frac * 100).toFixed(1) + '% of pixels occluded');
    }

    // --- the grade may never clip one channel while its siblings live --
    // Run the most hostile grade the art direction could ask for. A pixel with
    // exactly one channel at 0 and another above 8/255 is a hue clip, not a
    // black pixel, and is the "toxic green shadow" failure.
    {
      const keep = JSON.parse(JSON.stringify(fx.getParams().grade));
      fx.setParams({ grade: { punch: 1.0, saturation: 1.6, contrast: 1.5, lift: 0, exposure: 1.65 } });
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const w = fx.rtLDR.width, h = fx.rtLDR.height;
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, px);
      let hue = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        n++;
        const mx = Math.max(px[i], px[i + 1], px[i + 2]);
        const mn = Math.min(px[i], px[i + 1], px[i + 2]);
        if (mn === 0 && mx >= 8) hue++;
      }
      fx.setParams({ grade: keep });
      const pct = 100 * hue / n;
      if (pct > 1.0) fail('grade clips a single channel to 0 on ' + pct.toFixed(2) + '% of the frame');
      else ok('grade is channel-safe under punch 1.0 / sat 1.6 / contrast 1.5 (' + pct.toFixed(3) + '% hue clip)');
    }

    // --- the DOF gather must actually move pixels ----------------------
    // "The blur runs and nothing changes" is the failure this guards: a CoC to
    // pixel-radius mapping that resolves sub-pixel, or a tap weight that
    // discards the disc, both leave a zero A/B delta with the pass enabled.
    {
      // At a realistic output size: the radius is a fraction of the buffer, so
      // a 256x144 probe would legitimately resolve sub-pixel and prove nothing.
      fx.setSize(1280, 720, 1);
      fx.setParams({ dof: { enabled: true } });
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const w = fx.rtLDR.width, h = fx.rtLDR.height;
      const a = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, a);
      fx.setParams({ dof: { enabled: false } });
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const b = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(fx.rtLDR, 0, 0, w, h, b);
      fx.setParams({ dof: { enabled: true } });
      // Outer sixth of the frame top and bottom: outside any sane focal band.
      let sum = 0, n = 0;
      const band = Math.max(1, Math.floor(h / 6));
      for (let y = 0; y < h; y++) {
        if (y >= band && y < h - band) continue;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
          n++;
        }
      }
      const mean = sum / Math.max(1, n);
      const radPx = fx._dofRadiusPx();
      if (radPx * 0.5 < 3) fail('DOF radius at CoC 0.5 is ' + (radPx * 0.5).toFixed(2) + ' half-res px at 720p — too small to move a pixel');
      else if (mean < 0.5) fail('DOF changes nothing outside the focal band (mean delta ' + mean.toFixed(3) + '/255)');
      else ok('DOF: ' + radPx.toFixed(1) + ' half-res px at CoC 1, outer-band delta ' + mean.toFixed(2) + '/255');
    }

    // --- 100 resize cycles, no target leak ----------------------------
    {
      const texBefore = r.info.memory.textures;
      const countBefore = fx._targets.length;
      for (let i = 0; i < 100; i++) {
        const w = 160 + ((i * 37) % 480);
        const h = 90 + ((i * 53) % 270);
        fx.setSize(w, h, 1);
      }
      fx.render(0.016, { camera: cam, camDist: 120, quality: 2 });
      const texAfter = r.info.memory.textures;
      const countAfter = fx._targets.length;
      if (countAfter !== countBefore) {
        fail('render-target count drifted over 100 resizes: ' + countBefore + ' -> ' + countAfter);
      } else if (texAfter - texBefore > 2) {
        fail('GPU texture count grew by ' + (texAfter - texBefore) + ' over 100 resizes (leak)');
      } else {
        ok('100 resize cycles: ' + countAfter + ' targets, texture delta ' + (texAfter - texBefore));
      }
    }

    // --- params round-trip --------------------------------------------
    {
      const radiusBefore = fx.getParams().ssao.radius;
      fx.setParams({ ssao: { intensity: 0.5 }, grade: { exposure: 1.4 }, aa: { enabled: false } });
      const p = fx.getParams();
      if (p.ssao.intensity !== 0.5 || p.grade.exposure !== 1.4 ||
          p.ssao.radius !== radiusBefore || p.aa.enabled !== false) {
        fail('setParams partial merge is wrong');
      } else ok('setParams merges partially without clobbering siblings');
    }

    // --- dispose is clean ---------------------------------------------
    {
      const before = r.info.memory.textures;
      fx.dispose();
      fx = null;
      const after = r.info.memory.textures;
      if (after > before) fail('dispose() increased texture count');
      else ok('dispose() released ' + (before - after) + ' textures');
    }
  } catch (e) {
    console.error = realError;
    console.warn = realWarn;
    fail('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e));
  } finally {
    console.error = realError;
    console.warn = realWarn;
    try { if (fx) fx.dispose(); } catch (e) { /* ignore */ }
    geo.dispose(); mat.dispose();
    ground.geometry.dispose(); ground.material.dispose();
    if (ownRenderer) { try { r.dispose(); r.forceContextLoss(); } catch (e) { /* ignore */ } }
  }

  return { pass, notes };
}
