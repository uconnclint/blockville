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
  voxLat: 'voxLat',           // vec4  — OPTIONAL (res > 1 models only): (res, lattice origin xyz)
  aoQuad: 'aoQuad',           // vec4  — OPTIONAL: all four corner AO factors of this quad (unorm8)
  aoUV: 'aoUV',               // vec2  — OPTIONAL: this vertex's corner (0/1, 0/1) in the quad
  paneUV: 'paneUV',           // vec2  — OPTIONAL (unorm8, 1+254*t; 0 = none): position inside the
                              //         whole glass pane, (across, up) — surface r7
  aoAtlas: 'aoAtlas',         // vec2  — OPTIONAL (perf): UV into the shared AO atlas (AoAtlas);
                              //         0 = none. Replaces aoQuad/aoUV on atlas geometry.
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
  aoQuad: [0.0, 0.0, 0.0, 0.0],  // all-zero = "no quad data": shader falls back to aoT
  aoUV: [0.0, 0.0],
  paneUV: [0.0, 0.0],         // no pane data
  aoAtlas: [0.0, 0.0],        // no atlas AO
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
varying float vVoxRes;       // voxels per world unit (1 = legacy res-1 model)
varying vec4  vVoxAOQ;      // the quad's four corner AO factors (constant over the quad)
varying vec4  vVoxAOUV;     // xy: position inside the quad, 0..1 (bilinear weights)
                            // zw: paneUV (raw unorm; 0 = none) — packed into one row
varying vec2  vVoxAtlas;    // AO atlas UV (0 = none; see AoAtlas)
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
attribute vec4  ${ATTR.voxLat};
attribute vec4  ${ATTR.aoQuad};
attribute vec2  ${ATTR.aoUV};
attribute vec2  ${ATTR.paneUV};
attribute vec2  ${ATTR.aoAtlas};
${COMMON_PARS}
${GLSL_DECODE}
${GLSL_INST_SEED}
`;

const VERT_BODY = /* glsl */`
vVoxAO      = voxDecodeAO(${ATTR.aoT});
vVoxAOQ     = ${ATTR.aoQuad};
vVoxAOUV    = vec4(${ATTR.aoUV}, ${ATTR.paneUV});
vVoxAtlas   = ${ATTR.aoAtlas};
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
  // Finer-resolution models (voxel.js res > 1) are emitted in world units and
  // carry their lattice explicitly: cells stay 1 world unit (res x res fine
  // voxels) anchored at the model's min corner. Absent attribute reads as
  // (0,0,0,1) (or a stale <= 1 default), so res-1 geometry takes the line above.
  if (${ATTR.voxLat}.x > 1.5) vVoxGrid = transformed - ${ATTR.voxLat}.yzw;
  vVoxRes = max(${ATTR.voxLat}.x, 1.0);

  vec3 voxOrigin = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
  vVoxSeed = vec2(voxInstSeed(voxOrigin, 0.0), voxInstSeed(voxOrigin, 11.7));
}
`;

const FRAG_PARS = /* glsl */`
uniform sampler2D uAoAtlas;   // shared R8 voxel-AO atlas (AoAtlas)
uniform float uNight;
uniform vec3  uSeason;
uniform float uSeasonStrength;
uniform float uSnowCover;
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
uniform float uWinOffVary;    // per-building spread of uWinOff (night r1)
uniform vec3  uWinShop;       // night w4r3: ground-floor panes (unlit-share scale, below height [u], level scale)
uniform vec4  uWinFloor;      // night w4r5: whole floors (dark share, busy share, busy unlit scale, floor band height u)
uniform float uWinBimodal;    // night w4r5: 0..1 push each building's occupancy toward sleepy / busy
uniform vec4  uGlassLobby;    // night w4r5: street-level office glass lobby (from u, to u, unlit share, level)
uniform vec3  uWinWarm;       // (building warm skew pow, per-window jitter, cool-pane pull)
uniform vec3  uWinCoolTo;     // linear colour cool panes are pulled toward at night
uniform vec4  uGlassNight;    // (amount, extra unlit share, level, min height) night r1 plain glass
uniform vec3  uNightGlassCol[6]; // linear palette colours treated as office glass at night
uniform vec2  uGlassStrip;    // night w4: lit band of each floor on plain office glass (from, to) in cell height
uniform vec4  uNightSign;     // night w4 lit sign letters: (amount, unlit share of buildings, saturation, warm-white pull)
uniform vec3  uSignBoost;     // night w4: HDR level of a lit sign (dim building, bright building, neon share)
uniform vec2  uSignNeon;      // night w4: pale letters on a hot sign turn neon (amount, pink vs cyan share)
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
uniform vec3  uGlassTint;     // day albedo glass is pulled toward (linear)
uniform float uGlassTintAmt;  // how far (emissive panes; plain glass gets 60%)
uniform float uGlassSheen;    // diagonal reflection stripe strength
uniform vec3  uGlassHi;       // wave-4 r1: pane head highlight colour (linear)
uniform vec4  uGlassHiP;      // (amount, band lo, band hi, thin-stripe weight)
uniform vec3  uPaneGrade;     // (head, sill, jamb) albedo factors across a glass pane (r7)
uniform vec3  uWinFrame;      // legacy res-1 window frame colour (linear)
uniform float uMetalMax;      // metalness ceiling for the conductor class
uniform float uSsaoKeep;      // how much of post.js's screen-space AO voxel pixels keep (scene alpha)
uniform float uDebugAO;       // 1 = output the voxel AO factor only (harness)
uniform float uDarkFloor;     // albedo floor (linear) so near-black paint keeps a face tone
uniform float uSkyFillDown;   // share of the sky fill kept by down-facing faces
uniform float uWorldAOKeep;   // share of lighting.js's world AO kept (see params)
uniform vec4  uShadowCrisp;   // x amount, y lo, z hi: penumbra re-shaping on voxel faces
uniform vec4  uBounce;        // x strength, y hue carry, zw unused: sun bounce into shaded faces
uniform vec3  uBounceTint;    // colour of that bounce (linear)
uniform vec4  uNightShade;    // night w4r2: rgb = linear tint of the shade-side fill at night, w = its strength scale
uniform vec4  uNightFloor;    // night w4r2: (low-level light scale, ramp from, ramp to [u above model base], amount)
uniform vec3  uNightTop;      // night w4r3: up faces' floor ramp (from, to [u above model base]) + moonlit-top key boost
uniform vec2  uNightTopLift;  // night w4r6: moonlit-top albedo lift (exponent < 1, amount)
uniform vec2  uNightFace;     // night w4r6: vertical faces' key scale, shade-side fill scale
uniform vec4  uShadeSide;     // x depth, y hue carry, z away ramp: key-away faces' fill (params.shadeSide)
uniform vec2  uGlassDiffuse;
uniform float uGlassReflTint; // how much the glass body hue colours its sky/env reflection (surface w2 r1)  // (direct, indirect) diffuse scale on glass by day (surface w2 r1)
uniform float uWallKey;        // direct-diffuse scale on vertical faces by day (params.wallKey)
uniform vec2  uAOWallCap;      // (max darkness, knee) on vertical voxel faces (wave-4 r1)
uniform vec4  uAOHue;          // x hue carry into AO darkening, y extra depth (params.aoHue)
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
float voxAOv = 1.0;                // bilinear voxel AO factor (see FRAG_COLOR)
float voxSheenV = 0.0;             // glass reflection-streak mask (FRAG_COLOR -> FRAG_AO)
float voxPaneUp = 0.5;             // height inside the glass pane, 0 sill .. 1 head (r7)
vec3  voxPaneCell = vec3(0.0);     // night w4: hash cell of the whole res>1 pane (see FRAG_COLOR)
float voxPaneY = 0.0;              // night w4r5: height of the pane's CENTRE in vVoxGrid units (whole-floor switching)

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

// Per-BUILDING uniform random (night r1). Same trick as voxCellRand: a sine of
// the (continuous) instance seeds, so a moving object fades rather than
// strobes; many cycles across the seed range so neighbours decorrelate.
float voxBldRand(vec2 seed, float salt) {
  float v = sin((seed.x * 13.7 + seed.y * 7.3 + salt) * 6.2831853);
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
  // Toy metal: a light-grey AC unit must still READ light grey under a flat
  // iso key, so conductors keep most of their diffuse (uMetalMax).
  m = mix(m, uMetalMax, metal);
  return vec2(clamp(r, 0.035, 1.0), clamp(m, 0.0, 1.0));
}
`;

// Injected right after <color_fragment>: albedo grade.
//
// SURFACE ROUND 1 (target: Pablo Gamedev "Isometric City Voxel", ref04). The
// reference's faces are CLEAN: one confident colour per face, detail only from
// geometry and light. Every procedural layer that used to live here — per-voxel
// seam/panel grooves, slab lips, band-limited tonal mottling, the sub-tile
// "tooth" + joint grid + bump, per-floor banding, weathering run-off and
// contact grime — was texture, and texture is exactly what the reference does
// not have. They are gone, not turned down. What is left:
//   * a whisper of per-INSTANCE tint (a row of identical towers still differs),
//   * glass that reads as glass (blue, with a soft diagonal sheen),
//   * a clean framed pane for LEGACY res-1 windows only (res > 1 models author
//     their frames as real geometry, so the shader adds nothing there),
//   * the saturation lift that keeps the palette bright through ACES.
// Contact darkening now comes from voxel.js's ground-plane AO, per vertex.
const FRAG_COLOR = /* glsl */`
{
  // --- BILINEAR VOXEL AO (surface r2) -----------------------------------------
  // voxel.js hands every quad its four corner factors; blend them bilinearly
  // instead of trusting the triangle interpolation of aoT (which creases along
  // the diagonal whenever the four corners are not coplanar). Geometry without
  // the attribute reads all-zero and falls back to the per-vertex value.
  {
    float qs = vVoxAOQ.x + vVoxAOQ.y + vVoxAOQ.z + vVoxAOQ.w;
    vec2 w = clamp(vVoxAOUV.xy, 0.0, 1.0);
    float bl = mix(mix(vVoxAOQ.x, vVoxAOQ.w, w.x), mix(vVoxAOQ.y, vVoxAOQ.z, w.x), w.y);
    voxAOv = qs > 0.004 ? bl : vVoxAO;
    // PERF (AO atlas): the same bilinear corner blend, read from the shared
    // atlas with hardware filtering — lets voxel.js merge faces by colour
    // alone. Fetched outside any branch.
    float atl = texture2D(uAoAtlas, vVoxAtlas).r;
    if (vVoxAtlas.x > 0.0) voxAOv = atl;
    // wave-4 r1 (coordinator: AO midpoint, cap the combined AO at ~0.65 of
    // lit on vertical faces, keep the wide soft pooling). A soft knee on the
    // baked DARKNESS of wall faces: shallow pooling (d < cap - knee) passes
    // untouched, deeper creases roll off exponentially toward cap, so the
    // pooled gradient keeps its full width and only the crease bottom lifts.
    if (uAOWallCap.x > 0.0) {
      float dk = 1.0 - voxAOv;
      float k0 = uAOWallCap.x - uAOWallCap.y;
      float dc = dk > k0 ? k0 + uAOWallCap.y * (1.0 - exp(-(dk - k0) / max(uAOWallCap.y, 1e-3))) : dk;
      voxAOv = 1.0 - mix(dc, dk, step(0.5, abs(vVoxNormalO.y)));
    }
  }
  voxMatR = voxRemapMat(vVoxMat);
  // Glass class comes from the RAW attribute (see voxRemapMat).
  voxGlass = smoothstep(0.22, 0.06, vVoxMat.x) * (1.0 - smoothstep(0.30, 0.50, vVoxMat.y));
  float voxNeon = voxNeonness(vVoxGlow);
  voxWin = step(0.5, vVoxEmi) * voxGlass * (1.0 - voxNeon);
  // 1 on legacy res-1 geometry, 0 on authored res > 1 models. Frames only go
  // on WALL panes: a framed roof/windscreen cell reads as bathroom tile.
  float voxLegacy = (1.0 - step(1.5, vVoxRes)) * (1.0 - step(0.5, abs(vVoxNormalO.y)));

  voxUV = voxFaceUV(voxCell, voxPlane, voxFaceSalt);
  vec3 voxDG = fwidth(vVoxGrid);
  voxTilePx = clamp(1.0 / max(max(voxDG.x, max(voxDG.y, voxDG.z)), 1e-6), 1.0, 4096.0);

  // --- per-INSTANCE tint (smooth in world position, never strobes) --------
  diffuseColor.rgb *= 1.0 + (vVoxSeed.x - 0.5) * 2.0 * uInstVary;

  // --- GLASS ----------------------------------------------------------------
  // The palette's window colours are the NIGHT story (200 warm, 201 cool);
  // by day a pane is glass: a clear mid blue carrying a little of the
  // palette hue. Emissive panes take the full tint, plain 'glass' palette
  // entries (skyBlue on cars, kiosks) a lighter one.
  {
    float gAmt = voxGlass * mix(uGlassTintAmt * 0.6, uGlassTintAmt, voxWin);
    diffuseColor.rgb = mix(diffuseColor.rgb, uGlassTint * mix(vec3(1.0), diffuseColor.rgb, 0.18) * 1.1, gAmt);
  }

  // --- LEGACY res-1 WINDOWS: a clean painted frame + sill -------------------
  // A res-1 window is a single glass voxel flush with the wall. A thin light
  // frame and sill turn it into a window; nothing is randomised, so every
  // pane on a facade is the same size, like the reference.
  // Derivatives OUTSIDE any branch (window and wall voxels are adjacent).
  float fw = fwidth(voxUV.x + voxUV.y) * 1.2;
  {
    float px = min(voxUV.x, 1.0 - voxUV.x);
    float rw = max(fw, uWinRevealW);
    float frame = 1.0 - smoothstep(rw * 0.75, rw, min(px, 1.0 - voxUV.y));
    float sill = 1.0 - smoothstep(rw * 1.05, rw * 1.3, voxUV.y);
    float mx = abs(voxUV.x - 0.5);
    float mull = (1.0 - smoothstep(max(fw, 0.022) * 0.7, max(fw, 0.022), mx)) * uWinMullion;
    voxFrame = clamp(frame + mull, 0.0, 1.0) * voxWin * voxLegacy;
    voxSill = sill * voxWin * voxLegacy;
    // Soft shadow the frame head throws on the pane.
    float head = (1.0 - smoothstep(rw, rw * 2.6, 1.0 - voxUV.y)) * (1.0 - voxFrame) * voxWin * voxLegacy;
    diffuseColor.rgb *= 1.0 - 0.22 * head;
    vec3 frameC = uWinFrame;
    diffuseColor.rgb = mix(diffuseColor.rgb, frameC, max(voxFrame, voxSill) * uWinReveal);
  }

  // --- glass sheen: the "light reflection" stripe ---------------------------
  // Two soft diagonal bands across the pane in face space (a wide one and a
  // thin one), the classic toy-glass read. Band-limited by fwidth, so it
  // fades instead of shimmering at city zoom.
  {
    // r8 (critic r7: "flat saturated blue, no reflection highlight"; r5/r6:
    // "hard painted diagonal stripes"). The reflection is now PANE-LOCAL: every
    // window carries the same soft "/" glint (one broad band plus a faint thin
    // one), placed in the pane's own metric frame, so each pane reads as a
    // sheet of glass catching the sky — no world-space band that lands on some
    // windows and misses others. Soft-shouldered (no edge inside a pane), light
    // sky-blue rather than white, and faded out when a pane is under ~8 px so
    // it never shimmers at city zoom. Large curtain-wall panes repeat the glint
    // every ~1.6 world units instead of stretching one band across the wall.
    // Derivatives are taken here, outside any branch.
    float hasP = step(0.5 / 255.0, min(vVoxAOUV.z, vVoxAOUV.w)) * (1.0 - voxLegacy);
    vec2 pnS = mix(voxUV, clamp((vVoxAOUV.zw * 255.0 - 1.0) / 254.0, 0.0, 1.0), hasP);
    vec2 gPx = vec2(dFdx(pnS.x), dFdy(pnS.x)), gPy = vec2(dFdx(pnS.y), dFdy(pnS.y));
    vec2 gWx = vec2(dFdx(voxPlane.x), dFdy(voxPlane.x)), gWy = vec2(dFdx(voxPlane.y), dFdy(voxPlane.y));
    float szA = mix(1.0, clamp(length(gWx) / max(length(gPx), 1e-6), 0.05, 64.0), hasP);
    float szU = mix(1.0, clamp(length(gWy) / max(length(gPy), 1e-6), 0.05, 64.0), hasP);
    // NIGHT w4: one hash cell per res>1 PANE, not per world-unit cell. A pane
    // that straddled a unit boundary lit half-and-half, and on the curtain-wall
    // towers those halves stair-stepped into jagged gold chevrons under bloom.
    // The pane's centre on the face plane = here - (paneUV - 0.5) * paneSize
    // (sign from the derivatives, exact within one primitive), snapped to an
    // eighth of a unit so every fragment of the pane lands on the same id.
    {
      float sgx = dot(gPx, gWx) >= 0.0 ? 1.0 : -1.0;
      float sgy = dot(gPy, gWy) >= 0.0 ? 1.0 : -1.0;
      vec2 pc = voxPlane - vec2(sgx * (pnS.x - 0.5) * szA, sgy * (pnS.y - 0.5) * szU);
      vec3 axN = step(0.5, abs(vVoxNormalO));
      vec3 pcell = vec3(floor(pc * 8.0 + 0.5), dot(voxCell, axN) * 3.0 + voxFaceSalt);
      voxPaneCell = mix(voxCell, pcell, hasP);
      // NIGHT w4r5: the pane centre's height (same derivative trick on the
      // lattice height), so every pane in one row shares one floor id and a
      // pane never splits across a floor band.
      vec2 gGy = vec2(dFdx(vVoxGrid.y), dFdy(vVoxGrid.y));
      float szG = clamp(length(gGy) / max(length(gPy), 1e-6), 0.0, 64.0);
      float sgG = dot(gPy, gGy) >= 0.0 ? 1.0 : -1.0;
      voxPaneY = mix(floor(vVoxGrid.y) + 0.5, vVoxGrid.y - sgG * (pnS.y - 0.5) * szG, hasP);
    }
    // across coordinate increasing to SCREEN RIGHT, so glints are parallel on
    // both wall orientations
    float ar = dFdx(pnS.x) >= 0.0 ? pnS.x : 1.0 - pnS.x;
    float qa = ar * szA, qu = pnS.y * szU;
    float qRange = szA + 0.6 * szU;
    float q = (qa - 0.6 * qu + 0.6 * szU) / max(qRange, 1e-3);
    float nG = max(1.0, floor(qRange / 1.6 + 0.5));
    float ph = fract(q * nG);
    float pw = fwidth(q * nG);
    // wave-2 r1: the broad band was 0.15 half-width, which on the narrow
    // (2-4 voxel) res-4 panes covered half the window and read as a white
    // slash over a pale pane. Narrower main band, fainter thin one.
    float b1 = 1.0 - smoothstep(0.0, 0.095 + pw, abs(ph - 0.30));
    float b2 = 1.0 - smoothstep(0.0, 0.035 + pw, abs(ph - 0.52));
    // wave-4 r1: the thin second stripe is what read as 'white slashes'
    // (two parallel lines per narrow pane); its weight is now uGlassHiP.w.
    float glint = b1 * b1 * (3.0 - 2.0 * b1) + uGlassHiP.w * b2;
    float panePx = 1.0 / max(length(gPy), 1e-6);
    float sheen = glint * smoothstep(6.0, 16.0, panePx) * (1.0 - smoothstep(0.35, 0.8, pw));
    float onPane = voxGlass * (1.0 - voxFrame) * (1.0 - voxSill);
    // A reflection is view-dependent LIGHT, not paint: most of the streak is
    // added as indirect specular in FRAG_AO (so it survives on the shaded
    // side, where a pane reflects the bright sky just as much); a little
    // stays in the albedo so it also reads under the key.
    voxSheenV = sheen * onPane;
    diffuseColor.rgb += 0.35 * uGlassSheen * voxSheenV * vec3(0.55, 0.75, 1.0);
    // Head of the pane a touch lighter: sky above, room below.
    diffuseColor.rgb *= 1.0 + 0.12 * (voxUV.y - 0.5) * onPane * voxLegacy;
    // PANE GRADE (surface r7, res > 1 glass with mesher paneUV). ref04's
    // panes are one clear blue that deepens toward the head (the reveal and
    // lintel shade it) and clears toward the sill, with a faint darkening at
    // the jambs: the read of a recessed sheet of glass rather than blue paint.
    // Smooth over the WHOLE pane, so it never forms a line inside a window.
    {
      float has = step(0.5 / 255.0, min(vVoxAOUV.z, vVoxAOUV.w)) * onPane * (1.0 - voxLegacy);
      vec2 pn = clamp((vVoxAOUV.zw * 255.0 - 1.0) / 254.0, 0.0, 1.0);
      float up = smoothstep(0.0, 1.0, pn.y);
      float jamb = pow(abs(pn.x - 0.5) * 2.0, 3.0);
      // wave-4 r1 (coordinator: glass pale everywhere; ref05 panes are a
      // dark saturated azure that clears to a light cyan band at the head).
      // Tall curtain-wall panes (one merged pane per wall) take the grade and
      // band per ~1.25-unit ROW, so a tower reads as stacked sheets of glass,
      // not one gradient from the ground to the roof.
      float nRow = max(1.0, floor(szU / 1.25 + 0.5));
      float rY = pn.y * nRow;
      float upR = rY - min(floor(rY), nRow - 1.0);
      up = smoothstep(0.0, 1.0, upR);
      float grade = mix(uPaneGrade.y, uPaneGrade.x, up) * (1.0 - uPaneGrade.z * jamb);
      diffuseColor.rgb *= mix(1.0, grade, has);
      // Head highlight: the sky caught in the top of the pane. Half is paint
      // (so it follows the face tone), half rides the sky-coloured specular
      // streak (voxSheenV) so it also reads on the shaded wall.
      float hb = smoothstep(uGlassHiP.y, uGlassHiP.z, upR) * uGlassHiP.x * has;
      diffuseColor.rgb = mix(diffuseColor.rgb, uGlassHi, hb);
      voxSheenV = max(voxSheenV, 0.6 * hb);
      voxPaneUp = mix(0.5, up, has);
    }
  }

  // Near-black paint (black/darkGray trim, signs) keeps a readable face tone
  // under the iso key instead of collapsing into a lump: lift it toward a cool
  // charcoal floor. No-op on anything brighter than the floor.
  diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.92, 0.96, 1.06) * uDarkFloor);

  // Weather tint (engine-owned uSeason). Off by default: strength 0.
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uSeason, uSeasonStrength);

  // coherence 09-25: snow settles on up-facing faces (roofs, lot paving,
  // lawns), matching terrain.js / roads.js, which were the only pieces that
  // whitened — a white ground under summer-green roofs and lots read as two
  // different games. Albedo ~= terrain PAL.snow (0xeef3f8) in linear.
  if (uSnowCover > 0.001) {
    vec3 bvUpV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float bvTop = smoothstep(0.55, 0.85, dot(normalize(vNormal), bvUpV));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.855, 0.90, 0.94), uSnowCover * bvTop);
  }

  // Keep the palette bright + saturated through the PBR + ACES pipeline.
  diffuseColor.rgb = voxSaturate(diffuseColor.rgb, uSat);
}
`;

// Replaces <roughnessmap_fragment>: roughness comes from the vertex attribute.
const FRAG_ROUGHNESS = /* glsl */`
float roughnessFactor = voxMatR.x;
{
  // No roughness noise: the reference's faces are uniform, so is the sheen.
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
if (uToothBump > 0.0 && voxToothH != 0.0) {
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
#ifdef VOX_CSM
// World AO (lighting.js) caches its per-fragment visibility in csmAoVis and
// returns the cache when it is >= 0. Pre-seeding it here, before the lighting
// loop, is how a voxel face opts out: its AO is baked per vertex (voxel.js) and
// the height-volume estimate only added streaks on flat faces (surface r4).
if (uWorldAOKeep <= 0.0) csmAoVis = 1.0;
else if (uWorldAOKeep < 1.0) csmAoVis = mix(1.0, csmWorldAO(normal), uWorldAOKeep);
#endif
`;

// Replaces <aomap_fragment>: voxel AO from the attribute.
const FRAG_AO = /* glsl */`
{
  // --- clean cast-shadow edges on voxel faces (see params.shadowCrisp) ------
  // csmLastShadow is the (strength/fade-applied) sun visibility csmApply just
  // multiplied into the key. Re-shape it: direct *= g(s) / s. g <= s * 1.25
  // everywhere, and g(0) = 0, so the ratio is bounded and umbrae are untouched.
  #if NUM_DIR_LIGHTS > 0
  if (uShadowCrisp.x > 0.0 && csmLastShadow < 0.999) {
    float s0 = csmLastShadow;
    float g = smoothstep(uShadowCrisp.y, uShadowCrisp.z, s0);
    float k = mix(1.0, g / max(s0, 1e-3), uShadowCrisp.x * (1.0 - uNight));
    reflectedLight.directDiffuse  *= k;
    reflectedLight.directSpecular *= k;
    csmLastShadow = mix(s0, g, uShadowCrisp.x * (1.0 - uNight));
  }
  #endif
  // r11 (critic r10: "the glass has highlight streaks but does not look
  // glossy"): a pane is a mirror, and its reflection is not shadowed by the
  // wall's baked AO the way a painted wall is. The frame head's AO band was
  // greying the top third of every window into a matte blue. Glass keeps
  // half of it, so the reveal still reads, and the reflection stays clear.
  float voxAO = mix(voxAOv, 1.0, 0.5 * voxGlass);
  float aoIndirect = mix(1.0, voxAO, uAOStrength);
  // r12: aoDirect > 1 is an EXPONENT on sunlit faces (pow(ao, aoDirect)):
  // a lit wall sits on the display shoulder (PBR Neutral + knee), where a
  // linear 0.8 AO dip came out as a few percent on screen, so the corner and
  // ledge gradients vanished on exactly the faces the critic looks at.
  float aoDirect   = uAODirect > 1.0 ? pow(voxAO, uAODirect) : mix(1.0, voxAO, uAODirect);
  reflectedLight.indirectDiffuse  *= aoIndirect;
  reflectedLight.directDiffuse    *= aoDirect;
  reflectedLight.directSpecular   *= mix(1.0, voxAO, min(uAODirect, 1.0) * 0.6);
  // --- AO COLOUR BLEED (params.aoHue, surface r12) ------------------------
  // Critic r11: "ref04 puts a wide, smooth shadow gradient under every ledge
  // ... and its darker right side is still a rich, warm orange. Ours needs
  // ... more saturated, warmer colour and less grey." In a path-traced voxel
  // render the light that does reach an inside corner has bounced off the
  // same coloured wall a few times, so occluded pixels are not just darker,
  // they are MORE saturated in the wall's own hue (ref04: the orange goes
  // deeper and redder into every crease, never grey). Carry the albedo hue
  // (albedo / luma: luma-neutral) in proportion to the AO darkening, and
  // deepen it by y. Whites and greys have hue ~1, so they are untouched and
  // stay clean. Glass keeps its own look. Off at night (lamp pools).
  if (uAOHue.x > 0.0) {
    float aoDk = (1.0 - voxAO) * (1.0 - voxGlass) * (1.0 - 0.6 * uNight);
    // Hue normalised by its PEAK channel (<= 1 everywhere): the bleed only
    // ever pulls the weaker channels down, never pushes the dominant one up.
    // (A luma-normalised hue raised a lit pink's R past the display clip, so
    // the AO turned into a hue shift with no darkening at all: r12-c.)
    float pkH = max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 0.02));
    vec3 hueH = clamp(diffuseColor.rgb / pkH, vec3(0.0), vec3(1.0));
    vec3 bleed = mix(vec3(1.0), hueH, clamp(uAOHue.x * aoDk, 0.0, 1.0)) * (1.0 - uAOHue.y * aoDk);
    reflectedLight.indirectDiffuse *= bleed;
    reflectedLight.directDiffuse   *= bleed;
  }
  float dotNV = saturate(dot(geometryNormal, geometryViewDir));
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(dotNV, aoIndirect, material.roughness);

  // Glass reflects more of the sky than a flat dielectric lobe implies. This is
  // what makes a window read as a pane instead of pale paint. Keyed off the RAW
  // attribute class (voxGlass), since a remapped pane is metallic now.
  reflectedLight.indirectSpecular *= mix(1.0, uGlassEnv, voxGlass);
  // wave-2 r1: coated/tinted glass colours what it reflects. The grey-white
  // sky/env reflection was what lifted every pane's R channel into a pale
  // blue-grey (measured R 70-130 vs the reference's 15-60). Tint the env and
  // the analytic mirror below by the pane's own hue (peak-normalised, so it
  // only removes the weak channels); the cyan sheen band is added untinted.
  vec3 glassReflHue = vec3(1.0);
  if (voxGlass > 0.0) {
    float pkG = max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 0.02));
    glassReflHue = mix(vec3(1.0), clamp(diffuseColor.rgb / pkG, 0.0, 1.0), uGlassReflTint * voxGlass * (1.0 - uNight));
    reflectedLight.indirectSpecular *= glassReflHue;
  }
  // Glass streak (see FRAG_COLOR): sky-coloured reflected light.
  // wave-2 r1: tinted toward the reference's light cyan highlight (~#8fd0f0)
  // rather than the plain sky colour, which read as a white slash.
  reflectedLight.indirectSpecular += uSkyFillColor * vec3(0.62, 0.90, 1.0) * (uGlassSheen * 1.1 * voxSheenV);
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
  // PERF: everything in this block is scaled by voxGlass (the mirror term) or
  // only read through mix(..., voxGlass) (voxGlassN, in the glint below), so
  // non-glass fragments skip it with bit-identical output. No derivatives
  // inside. (Was ~30% of the whole frame at iso-mid: two fbm3 + two cell
  // hashes per fragment on every wall in the city.)
  if (voxGlass > 0.0) {
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
    // r7: the reflection clears toward the sill with the pane grade (the head
    // sits in the reveal's shade and sees less sky); 0.5 = no pane data.
    fr *= 1.25 - 0.5 * voxPaneUp;
    reflectedLight.indirectSpecular +=
      envC * glassReflHue * mix(vec3(1.0), material.specularColor * 1.7, 0.65) *
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
  // PERF: the lobe is multiplied by 'mask', so a fragment that is neither
  // glass nor a conductor adds exactly 0 — skip it.
  if (max(voxGlass, smoothstep(0.55, 0.92, metalnessFactor)) > 0.0) {
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
      (lobe * uGlint * mask * csmLastShadow * mix(1.0, voxAO, min(uAODirect, 1.0) * 0.6));
  }
  #endif

  // --- SHADE SIDE (params.shadeSide, surface r9) --------------------------
  // Critic r8: "the left and right wall faces come out almost the same flat
  // pink ... in ref04 the right face is clearly darker". The key already leaves
  // the right wall (fill only), but the fill (hemi + sky IBL) is omnidirectional
  // around the horizon, so a wall facing away from the sun got ~the same
  // indirect light as the lit one and the pair measured luma 0.85 (ref04 0.73).
  // Physically the half of the sky around the sun is the bright half; a face
  // turned away sees the dim half. So: scale the indirect diffuse of faces
  // turned AWAY from the key down by x, and carry the albedo's hue by y so the
  // dark side gets deeper AND richer (ref04's shaded orange is more saturated
  // than its lit one), never grey. Tops, lit walls and glass are untouched;
  // off at night (the moon key is not the daylight sky).
  #if NUM_DIR_LIGHTS > 0
  if (uShadeSide.x > 0.0) {
    float nlS = dot(geometryNormal, directionalLights[0].direction);
    float awayS = smoothstep(0.0, uShadeSide.z, -nlS) * (1.0 - uNight) * (1.0 - voxGlass);
    float lumS = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.02);
    vec3 hueS = clamp(diffuseColor.rgb / lumS, vec3(0.45), vec3(2.2));
    // wave-4 r2 (critic w4r1: "the right-hand shadow face is almost as bright
    // as the lit left face"): a LUMA-normalised hue boosts a saturated
    // colour's dominant channel (red: R x2.2), so the red/pink shade side came
    // out 0.82 of lit while white sat at 0.71. ref04's shade side keeps the
    // dominant channel and drops the weak ones (orange: R 0.8, G 0.55, B 0.35
    // of lit). w blends to a PEAK-normalised hue (<= 1): deeper and richer.
    float pkS = max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 0.02));
    hueS = mix(hueS, clamp(diffuseColor.rgb / pkS, vec3(0.0), vec3(1.0)), uShadeSide.w);
    reflectedLight.indirectDiffuse *= (1.0 - uShadeSide.x * awayS) *
                                      mix(vec3(1.0), hueS, uShadeSide.y * awayS);
  }
  #endif

  // --- WALL KEY (params.wallKey, surface r10) -----------------------------
  // Critic r9: "the left (pink) face is nearly as bright as the roof and
  // cornice tops ... drop the left-face value about 10-15% so top, left and
  // right read as three distinct tones". The engine keys walls at ~the same
  // N.L as roofs (-75 az / 40 el: left wall 0.66, roof 0.64) for the shadow
  // direction's sake, and the lit pink/cream sits on the tonemap shoulder, so
  // top and lit wall came out 1 : 0.95 (ref04 1 : 0.89 : 0.63). Scaling the
  // key's DIRECT diffuse on vertical faces keeps the shadow direction, the
  // tops and the fill (hue) untouched and moves only the lit wall's value.
  // Off at night (the moon key is already dim and flat).
  reflectedLight.directDiffuse *= mix(1.0, uWallKey, (1.0 - abs(vVoxNormalW.y)) * (1.0 - uNight));

  // Sky fill: a tiny hemispheric bounce so the shadow side never goes flat
  // black and the silhouette keeps some colour. Occluded by voxel AO.
  // uSkyFillDown keeps some of it on down-facing faces (awning / balcony
  // undersides): bounce off the bright ground, so they stay coloured instead
  // of dropping to near-black.
  float up = mix(uSkyFillDown, 1.0, vVoxNormalW.y * 0.5 + 0.5);
  reflectedLight.indirectDiffuse +=
    diffuseColor.rgb * uSkyFillColor * (uSkyFill * up * aoIndirect * (1.0 - metalnessFactor));

  // Sun bounce into the faces that turn away from the key (params.bounce).
  // Hue carry: bounce that has hit the same wall colour a few times comes back
  // more saturated, which is what keeps ref04's shaded side rich instead of
  // grey. Glass keeps its own look (the mirror above), so it takes half.
  #if NUM_DIR_LIGHTS > 0
  if (uBounce.x > 0.0) {
    float nl0 = dot(geometryNormal, directionalLights[0].direction);
    float away = clamp(0.30 - nl0, 0.0, 1.0);
    float lum = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.02);
    vec3 hue = clamp(diffuseColor.rgb / lum, vec3(0.45), vec3(2.2));
    // wave-4 r2: z blends to a peak-normalised hue (see SHADE SIDE).
    float pkB = max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 0.02));
    hue = mix(hue, clamp(diffuseColor.rgb / pkB, vec3(0.0), vec3(1.0)), uBounce.z);
    vec3 tint = uBounceTint * mix(vec3(1.0), hue, uBounce.y);
    // NIGHT w4r2: there is no sunlit city to bounce warm light off at night.
    // engine.js hands this the full (un-art-scaled) 0.22, 10x the day's, with
    // a warm tint: the moon-shaded walls came out tan/lavender and as bright
    // as the lit ones. At night the shade side takes a NAVY sky fill instead,
    // so the right wall reads deep blue and never black.
    tint = mix(tint, uNightShade.rgb, uNight);
    // w4r4: the strength (2.8) only ramps in at full night, so dusk's right
    // faces don't flash pale lavender while the tint crosses over.
    float bK = mix(1.0, uNightShade.w, smoothstep(0.45, 0.85, uNight));
    reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color * tint *
      (uBounce.x * bK * away * aoIndirect * (1.0 - metalnessFactor) * (1.0 - 0.5 * voxGlass));
  }
  #endif

  // --- NIGHT w4r2: moonlight catches the tops ------------------------------
  // Critic w4r1: lots, road edges, walls and roofs all sat in one mid-violet
  // band. At night the lower part of every model (its lot plinth, paving,
  // ground floor) takes less of the moon + sky than its upper storeys and
  // roof, so lots read clearly darker than roofs and each mass separates from
  // the ground. Emissive windows, signs and lamp pools are untouched.
  {
    float flK = uNightFloor.w * smoothstep(0.45, 0.8, uNight);
    if (flK > 0.0) {
      float hK = mix(uNightFloor.x, 1.0, smoothstep(uNightFloor.y, uNightFloor.z, vVoxGrid.y));
      // NIGHT w4r3 (critic w4r2: "roofs, walls and lot rims at the same value"):
      // an UP face that is clearly above the lot (a roof, a ledge, a stepped
      // gable) takes the full moon on a short ramp, plus a key boost, so roofs
      // read a clear step lighter than walls; lot paving stays on the dim floor.
      float upT = smoothstep(0.55, 0.9, vVoxNormalW.y);
      hK = mix(hK, mix(uNightFloor.x, 1.0, smoothstep(uNightTop.x, uNightTop.y, vVoxGrid.y)), upT);
      float f = mix(1.0, hK, flK);
      // NIGHT w4r6 (critics w4r3..r5 all: "downtown towers merge; top, left and
      // right faces the same value"). Measured on the SKY tower: roof 85, lit
      // wall 116, right wall 93 — the roof was DARKER than its wall because
      // tower roofs are dark slate albedo and a key boost only scales a dark
      // colour. Moonlit tops (clear of the lot) get an albedo LIFT instead:
      // colour^e keeps the hue and raises dark roofs most, like a cool sheen
      // of moonlight on flat tar. Vertical faces take uNightFace.x of the key
      // (lit wall a step under the top) and the shade side's fill scales by
      // uNightFace.y (right face the dark third tone, still coloured).
      float topK = upT * flK * smoothstep(uNightTop.x, uNightTop.y, vVoxGrid.y) * (1.0 - voxGlass);
      vec3 dC = max(diffuseColor.rgb, vec3(0.004));
      vec3 liftC = mix(vec3(1.0), pow(dC, vec3(uNightTopLift.x)) / dC, uNightTopLift.y * topK);
      float vertK = (1.0 - abs(vVoxNormalW.y)) * flK;
      float awayF = 0.0;
      #if NUM_DIR_LIGHTS > 0
      awayF = smoothstep(-0.05, 0.25, -dot(geometryNormal, directionalLights[0].direction));
      #endif
      reflectedLight.directDiffuse *= f * (1.0 + uNightTop.z * upT * flK) * liftC * mix(1.0, uNightFace.x, vertK);
      reflectedLight.indirectDiffuse *= liftC * mix(1.0, uNightFace.y, vertK * awayF);
      reflectedLight.indirectDiffuse *= f;
      reflectedLight.directSpecular *= f;
      reflectedLight.indirectSpecular *= f;
    }
  }

  // --- GLASS BODY (params.glassDiffuse, surface wave-2 r1) ------------------
  // Coordinator / civic, downtown, shops critics: "windows are low-contrast
  // blue-grey slits with no dark glass". A pane is transparent: its 'albedo'
  // is the dim room behind it, so it should not take the full sun + sky fill
  // a painted wall does (measured: the sunlit side's panes rendered
  // (133,175,244), near-white; ref04/ref05 panes sit at ~(45,95,150)). Scale the
  // diffuse on glass so the pane body is a deep saturated blue on BOTH wall
  // directions, and let the reflection (mirror + sheen band) carry the light.
  // Day only: the night window glow is emissive and untouched.
  {
    float gdK = voxGlass * (1.0 - uNight);
    reflectedLight.directDiffuse   *= mix(1.0, uGlassDiffuse.x, gdK);
    reflectedLight.indirectDiffuse *= mix(1.0, uGlassDiffuse.y, gdK);
  }
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
  // PERF: every result below enters through mix(..., voxWin), so non-window
  // fragments (voxWin == 0) skip the four cell hashes with identical output.
  if (voxWin > 0.0) {
    float onR = voxCellRand(voxPaneCell, vVoxSeed.y, 1.73);
    // NIGHT r1: every building has its own night PERSONALITY — how busy it is
    // (share of rooms lit) and what bulbs it burns (amber flats, warm-white
    // shops, the odd cool office). One city-wide uWinOff made every block the
    // same speckle. voxBldRand is smooth in the instance seed (see its note),
    // mirrored on the CPU by _bldRand().
    float bOcc  = voxBldRand(vVoxSeed, 3.7);
    float bTemp = voxBldRand(vVoxSeed, 8.9);
    // NIGHT w4r5 (critic w4r4: "every facade has the same evenly scattered
    // grid"): building occupancy is pushed toward the ends (a sleepy block
    // next to a tower that is mostly lit), and whole FLOORS switch together:
    // a share of floors is dark, a share is busy (most rooms on).
    bOcc = mix(bOcc, bOcc * bOcc * (3.0 - 2.0 * bOcc), uWinBimodal);
    bOcc = mix(bOcc, bOcc * bOcc * (3.0 - 2.0 * bOcc), uWinBimodal);
    float offB  = clamp(uWinOff + (bOcc - 0.5) * uWinOffVary, 0.03, 0.92);
    float flR   = voxCellRand(vec3(floor(voxPaneY / uWinFloor.w), 17.0, 3.0), vVoxSeed.y, 6.73);
    offB = flR < uWinFloor.x ? 1.01 : (flR > 1.0 - uWinFloor.y ? offB * uWinFloor.z : offB);
    // NIGHT w4r3 (critic w4r2: "more lit ground-floor shopfronts"): panes on
    // the ground storey (below uWinShop.y above the model base) are open late:
    // their unlit share is scaled by uWinShop.x and their level by uWinShop.z.
    // Mirrored in computeWindowGlows() on the owning cell's height.
    float shopF = 1.0 - step(uWinShop.y, vVoxGrid.y);
    offB = mix(offB, min(offB, 0.92) * uWinShop.x, shopF);
    // Hard step, exactly like the CPU mirror in computeWindowGlows(): a half-lit
    // window is not a thing, and the soft version disagreed with the lights.
    float on  = step(offB, onR);

    // --- DUSK GATE ---------------------------------------------------------
    // uNight is a linear 0..1 clock, so multiplying emissive by it lit every
    // office in the city at nightT 0.375 — a 20-degree LATE AFTERNOON sun. Nobody
    // turns the lights on at 4pm. Each window instead has its own switch-on
    // time in [uWinDusk.x, uWinDusk.x + uWinDusk.y], skewed LATE (sqrt), so a
    // handful of early risers appear first and the city fills in over dusk.
    // The window is dark below uWinDusk.x by construction, and that floor is
    // deliberately lighting.js's own pool fade-in (smoothstep 0.42 -> 0.68), so
    // the emissive pixels and the light they spill switch on together.
    float dr   = voxCellRand(voxPaneCell, vVoxSeed.y, 2.91);
    float t0   = uWinDusk.x + uWinDusk.y * sqrt(dr);
    float dusk = smoothstep(t0, t0 + uWinDusk.z, uNight);

    // Brightness: a skewed spread, not a symmetric jitter — most rooms are a
    // single lamp and a few are a lit ceiling, which is what makes a real tower
    // look occupied rather than switched on at the mains.
    float ir = voxCellRand(voxPaneCell, vVoxSeed.y, 5.11);
    float inten = mix(uWinLevel.x, uWinLevel.y, pow(ir, uWinLevel.z)) * mix(1.0, uWinShop.z, shopF);

    // Bulb colour: roughly 2400K (tungsten) -> 4200K (cheap LED). Wide enough
    // to read as different apartments at 1:1.
    float tr = voxCellRand(voxPaneCell, vVoxSeed.y, 9.43);
    vec3 warm = vec3(1.0 + 0.20 * uWinTemp, 1.0 - 0.02 * uWinTemp, 1.0 - 0.34 * uWinTemp);
    vec3 cool = vec3(1.0 - 0.18 * uWinTemp, 1.0 + 0.02 * uWinTemp, 1.0 + 0.30 * uWinTemp);
    // Building temperature skewed WARM (pow), each window jittered around it.
    float trB = clamp(pow(bTemp, uWinWarm.x) + (tr - 0.5) * uWinWarm.y, 0.0, 1.0);
    vec3 tint = mix(warm, cool, trB);

    // The reveal and the sill are masonry: they stay dark even when the room
    // behind the glass is lit. That border is the only thing that keeps one
    // window from merging into the next once bloom gets hold of the frame.
    // The legacy frame/sill is painted trim: it never glows, it stays lit
    // as an ordinary surface next to the bright pane.
    float trim = max(voxFrame, voxSill);
    // Cool-glass panes (palette 201, a pale blue) read as a cold blue city at
    // night; pull them most of the way to a warm white so the glass towers
    // join the cheerful amber town, keeping only a hint of office cool.
    float coolPane = smoothstep(0.05, 0.30, vVoxGlow.b - vVoxGlow.r);
    vec3 paneCol = mix(vVoxGlow, uWinCoolTo, coolPane * uWinWarm.z);
    vec3 winGlow = paneCol * tint * inten;
    glow   = mix(glow, winGlow, voxWin);
    emiAmt = mix(emiAmt, on * dusk * (1.0 - trim), voxWin);
  }

  // --- NIGHT r1: plain building glass lights up too ------------------------
  // The downtown curtain-wall towers are authored in plain 'glass' (not the
  // 200/201 window indices), so at night they were the darkest things in the
  // city: dark blue slabs with a few specks. Treat their wall glass as
  // offices: 2-unit-wide rooms per floor, a sparser share lit than homes,
  // dimmer and whiter, same dusk gate, same per-building personality. Only
  // res > 1 WALL glass above uGlassNight.w (world units above the model's
  // base) — skips car windscreens, roofs, skylights and street-level glass.
  // Downtown/civic curtain walls are authored in PAINTED glass colours
  // (dtGlass*, civGlass: voxel.js classes them as paint, so voxGlass misses
  // them). vVoxGlow carries the exact linear palette colour of a
  // non-emissive voxel, so match it against that short list (night only).
  float glassLike = voxGlass;
  if (uNight * uGlassNight.x > 0.0) {
    for (int gi = 0; gi < 6; gi++) {
      glassLike = max(glassLike, 1.0 - step(0.012, distance(vVoxGlow, uNightGlassCol[gi])));
    }
  }
  // NIGHT w4r5: plus a street-level LOBBY band (uGlassLobby.x..y above the
  // model base): mostly lit, brighter, full height (critic w4r4: "glowing
  // lobbies and shopfronts at street level" — the core's street was black).
  float lobbyK = step(uGlassLobby.x, vVoxGrid.y) * (1.0 - step(uGlassLobby.y, vVoxGrid.y)) * step(1e-3, uGlassLobby.w);
  float plainG = glassLike * (1.0 - step(0.5, vVoxEmi)) * step(1.5, vVoxRes)
               * (1.0 - step(0.5, abs(vVoxNormalO.y))) * max(step(uGlassNight.w, vVoxGrid.y), lobbyK);
  if (plainG * uGlassNight.x * uNight > 0.0) {
    // NIGHT w4: rooms 3 units wide x 1 floor, and only a STRIP of each floor
    // glows (a dark spandrel line between floors). The 2-unit rooms lit the
    // full cell height, and where a curtain wall steps (fins, set-backs) the
    // lit cells stair-stepped into jagged gold chevrons under bloom; floor
    // strips give the towers the crisp horizontal office rhythm instead.
    vec3 room = vec3(floor(voxCell.x / 3.0), voxCell.y, floor(voxCell.z / 3.0));
    float fy = fract(vVoxGrid.y);
    float fwy = max(fwidth(vVoxGrid.y), 1e-4);
    float strip = smoothstep(uGlassStrip.x - fwy, uGlassStrip.x + fwy, fy)
                * (1.0 - smoothstep(uGlassStrip.y - fwy, uGlassStrip.y + fwy, fy));
    strip = mix(strip, 1.0, lobbyK);
    float gOcc = voxBldRand(vVoxSeed, 3.7);
    gOcc = mix(gOcc, gOcc * gOcc * (3.0 - 2.0 * gOcc), uWinBimodal);
    gOcc = mix(gOcc, gOcc * gOcc * (3.0 - 2.0 * gOcc), uWinBimodal);
    float offG = clamp(uWinOff + uGlassNight.y + (gOcc - 0.5) * uWinOffVary, 0.05, 0.97);
    // NIGHT w4r5: whole office floors dark / busy, as for windows
    float flG = voxCellRand(vec3(floor(vVoxGrid.y), 23.0, 5.0), vVoxSeed.y, 6.73);
    offG = flG < uWinFloor.x ? 1.01 : (flG > 1.0 - uWinFloor.y ? offG * uWinFloor.z : offG);
    offG = mix(offG, uGlassLobby.z, lobbyK);
    float onG  = step(offG, voxCellRand(room, vVoxSeed.y, 4.41));
    float t0G  = uWinDusk.x + uWinDusk.y * sqrt(voxCellRand(room, vVoxSeed.y, 2.91));
    float dkG  = smoothstep(t0G, t0G + uWinDusk.z, uNight);
    float irG  = voxCellRand(room, vVoxSeed.y, 5.11);
    float trG  = clamp(pow(voxBldRand(vVoxSeed, 8.9), uWinWarm.x)
               + (voxCellRand(room, vVoxSeed.y, 9.43) - 0.5) * uWinWarm.y, 0.0, 1.0);
    vec3 wmG = vec3(1.0 + 0.20 * uWinTemp, 1.0 - 0.02 * uWinTemp, 1.0 - 0.34 * uWinTemp);
    vec3 clG = vec3(1.0 - 0.18 * uWinTemp, 1.0 + 0.02 * uWinTemp, 1.0 + 0.30 * uWinTemp);
    vec3 gG  = uWinCoolTo * mix(wmG, clG, trG)
             * mix(uWinLevel.x, uWinLevel.y, pow(irG, uWinLevel.z)) * mix(uGlassNight.z, uGlassLobby.w, lobbyK);
    float aG = onG * dkG * plainG * uGlassNight.x * strip;
    glow   = mix(glow, gG, aG);
    emiAmt = max(emiAmt, aG);
  }

  // --- NIGHT w4: LIT SIGN LETTERS -----------------------------------------
  // models/core.js SIGN_LIT twins (palette 204+): the sign-letter colours
  // re-issued as emissive indices with the SAME day colour. They are the only
  // emissive voxels with a rough (non-glass, non-lamp, non-neon) material —
  // voxel.js gives indices it has no spec for DEFAULT_MAT (0.75) — so that is
  // the test. Every building gets its own sign personality: dark (a shop shut
  // for the night), a warm lit board, or a punchy neon one; letters glow in
  // their own colour (white letters as warm-white bulbs), switched on early in
  // the dusk ramp (shops light before the flats), and bloom does the halo.
  float signK = vVoxEmi * step(0.5, vVoxMat.x) * (1.0 - voxGlass);
  if (signK > 0.0) {
    float sB  = voxBldRand(vVoxSeed, 6.31);
    float sOn = step(uNightSign.y, sB);
    float sT0 = uWinDusk.x + uWinDusk.y * 0.3 * voxBldRand(vVoxSeed, 7.77);
    float sDk = smoothstep(sT0, sT0 + uWinDusk.z, uNight);
    vec3  sc  = voxSaturate(vVoxGlow, uNightSign.z);
    float sMx = max(sc.r, max(sc.g, sc.b));
    float sCh = sMx > 1e-4 ? (sMx - min(sc.r, min(sc.g, sc.b))) / sMx : 0.0;
    float sPale = 1.0 - smoothstep(0.10, 0.35, sCh);
    // neon share: the busiest signs burn hot, the rest a soft lit board
    float sHot = step(1.0 - uSignBoost.z, fract(sB * 7.13));
    // a hot sign with pale (white) letters becomes a pink or cyan neon tube;
    // the rest of the pale letters are warm-white bulbs
    vec3  sNeo = fract(sB * 3.71) < uSignNeon.y ? vec3(1.0, 0.30, 0.72) : vec3(0.30, 0.86, 1.0);
    float sNeoK = sPale * sHot * uSignNeon.x;
    sc = mix(sc, sMx * vec3(1.0, 0.80, 0.52), sPale * uNightSign.w * (1.0 - sNeoK));
    sc = mix(sc, sMx * sNeo, sNeoK);
    sc /= max(max(sc.r, max(sc.g, sc.b)), 1e-3);
    float sLvl = mix(uSignBoost.x, uSignBoost.y, sHot);
    float aS = sOn * sDk * uNightSign.x;
    // a whiter hot core (tube / bulb) inside the coloured bloom halo
    glow   = mix(glow, mix(sc, vec3(1.0, 0.96, 0.86), 0.28 * (1.0 - 0.6 * sNeoK)) * sLvl, signK);
    emiAmt = mix(emiAmt, clamp(aS, 0.0, 1.0), signK);
  }

  // --- Rim / silhouette separation ---------------------------------------
  // Exponent kept low (2.2): on flat voxel faces a tight fresnel only lights a
  // 1px silhouette sliver, which does nothing for separation against the sky.
  float fres = pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 2.2);
  float rimUp = 0.55 + 0.45 * clamp(vVoxNormalW.y * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor.rgb += uRimColor * (fres * uRimStrength * rimUp * mix(1.0, voxAOv, 0.6) * (1.0 - emiAmt));

  // --- Night glow: the legacy lerp, with the per-window glow substituted --
  gl_FragColor.rgb = mix(gl_FragColor.rgb, glow, emiAmt);

  // --- HDR overdrive so bloom has real energy to work with ---------------
  // post.js owns the bloom curve; this owns how far above 1.0 the source goes.
  // Neon is SATURATED before it is pushed, so the bloom core keeps its hue
  // instead of every channel clipping to the same flat white.
  float neon = voxNeonness(vVoxGlow) * (1.0 - signK);
  vec3  hdr  = mix(glow, voxSaturate(glow, uNeonSat), neon);
  float dayNeon = vVoxEmi * neon * uNeonDay * (1.0 - uNight);
  float boost = emiAmt * mix(uWindowBoost, uNeonBoost, neon) * (1.0 - signK) + dayNeon * uNeonBoost;
  gl_FragColor.rgb += hdr * boost;

  // --- SSAO hand-off (surface r2) ------------------------------------------
  // Voxel geometry carries EXACT per-vertex AO (voxel.js), so post.js's
  // depth-only SSAO is redundant on it — and at close zoom it was the source
  // of the blotchy grey smudges on open faces and the halos along convex trim.
  // The scene target's alpha is otherwise unused (every opaque pass writes
  // 1.0); voxel pixels write uSsaoKeep there and post.js's lit pass scales its
  // AO by it. Terrain, roads and props keep full SSAO for cross-mesh contact.
  gl_FragColor.a = uSsaoKeep;
  if (uDebugAO > 0.5) gl_FragColor = vec4(vec3(voxAOv * 0.6), uSsaoKeep);
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
  gl_FragColor.rgb += diffuse * (fres * 1.0 + band * 0.08) * uGhostPulse;   // w4: band 0.16 -> 0.08 (scan stripes added to the busy look)
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

/** 6 linear Vector3s for uNightGlassCol (night r1); -1 / missing -> never matches. */
function _nightGlassCols(list) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const h = Array.isArray(list) ? list[i] : undefined;
    if (typeof h === 'number' && h >= 0) {
      const c = new THREE.Color().setHex(h, THREE.SRGBColorSpace);
      out.push(new THREE.Vector3(c.r, c.g, c.b));
    } else out.push(new THREE.Vector3(-9, -9, -9));
  }
  return out;
}

/** night w4r2: [sRGB hex, strength] -> linear (r, g, b, strength) in `out`. */
const _nsTmp = new THREE.Color();
function _nightShadeVec(v, out) {
  const a = Array.isArray(v) ? v : [0xfff1e0, 1];
  _nsTmp.setHex(a[0], THREE.SRGBColorSpace);
  return out.set(_nsTmp.r, _nsTmp.g, _nsTmp.b, a[1] != null ? a[1] : 1);
}

/** Mirror of voxBldRand() (night r1). */
function _bldRand(sx, sy, salt) {
  const v = Math.sin((sx * 13.7 + sy * 7.3 + salt) * 6.2831853);
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
  winOffVary: 0.90,   // must match params.winOffVary (night r1; w4r5 0.5 -> 0.9)
  winWarm: [2.2, 0.35, 0.75],   // must match params.winWarm
  winShop: [0.4, 5.0, 1.2],   // must match params.winShop (night w4r3)
  winFloor: [0.28, 0.22, 0.20, 2.0],   // must match params.winFloor (night w4r5)
  winBimodal: 1.0,    // must match params.winBimodal (night w4r5)
  minCells: 2,        // ignore a band with fewer lit panes than this
  // MEASURED: these billboards were responsible for 30.5% of night building
  // pixels moving by >4 luma — a warm additive wash that filled in the wall
  // BETWEEN the windows and erased the grid. They are still what makes a lit
  // tower light its own facade (that read is worth keeping), so the spill is
  // tightened rather than removed: about half the energy over about two thirds
  // of the footprint.
  // coherence 09-25: 0.030 / maxRadius 18 drew each tower band as an up-to-
  // 18-unit camera-facing disc; under the iso camera those read as pale blue
  // "mist" sheets hanging over whole blocks at night. Kept as a faint spill.
  intensity: 0.006,   // emitted intensity per lit pane in a band
  maxIntensity: 1.05,
  radiusScale: 1.05,  // radius = band extent * this, so spill reaches the street
  minRadius: 4,
  maxRadius: 6,
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
    // engine.js LOD: light positions always come from the full-detail model.
    const geo = (mesh.userData && mesh.userData.glowGeometry) || mesh.geometry;
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
    // night r1: the building's own occupancy + bulb temperature (FRAG_OUT).
    const seedX = instanceSeed(m.elements[12], m.elements[13], m.elements[14], 0.0);
    let bOcc = _bldRand(seedX, seed, 3.7);
    for (let k = 0; k < 2; k++) bOcc += (bOcc * bOcc * (3 - 2 * bOcc) - bOcc) * (o.winBimodal || 0);
    const offB = o.winOff < 0 ? o.winOff
      : Math.max(0.03, Math.min(0.92, o.winOff + (bOcc - 0.5) * (o.winOffVary || 0)));
    const bTempW = Math.pow(_bldRand(seedX, seed, 8.9), (o.winWarm || [1])[0]);

    // Lattice offset: constant across the geometry, recovered exactly as the
    // vertex shader does.
    const lat = geo.attributes[ATTR.voxLat];
    const fine = !!lat && lat.getX(0) > 1.5;     // res > 1: explicit lattice origin
    const ox = fine ? lat.getY(0) : _gridOffset(pos.getX(0));
    const oy = fine ? lat.getZ(0) : _gridOffset(pos.getY(0));
    const oz = fine ? lat.getW(0) : _gridOffset(pos.getZ(0));

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
      const shopW = o.winShop && cy < o.winShop[1];
      // night w4r5: whole floors (approximated on the face centre's height)
      let offF = offB;
      if (o.winFloor && o.winOff >= 0) {
        const fr = _cellRand(Math.floor(cy / o.winFloor[3]), 17, 3, seed, 6.73);
        offF = fr < o.winFloor[0] ? 1.01 : (fr > 1 - o.winFloor[1] ? offB * o.winFloor[2] : offB);
      }
      if (_cellRand(ix, iy, iz, seed, 1.73) < (shopW ? Math.min(offF, 0.92) * o.winShop[0] : offF)) continue;
      // Same colour temperature and same brightness distribution the shader
      // uses, so the light a tower casts matches the panes you can see.
      const tr = Math.max(0, Math.min(1, bTempW + (_cellRand(ix, iy, iz, seed, 9.43) - 0.5) * ((o.winWarm || [1, 1])[1])));
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
  ao: 1.0,             // indirect AO strength
  // r12: 1.0 -> 1.5. Values > 1 are an EXPONENT, pow(ao, aoDirect), on the
  // key's direct light (see FRAG_AO): sunlit faces sit on the display
  // shoulder and a linear AO dip barely showed there (critic r11: "almost no
  // soft shading in the corners, under the window frames, sills, cornice").
  // wave-4 r1: soft cap on wall AO darkness [max darkness, knee] (0 = off).
  // 0.34 / 0.12 -> a crease that baked to 0.55 renders ~0.68 (x aoDirect
  // 1.25 on the direct term ~0.62): the coordinator's ~0.65 midpoint.
  aoWallCap: [0.50, 0.14],   // wave-4 r2: [0.34,0.12] -> [0.50,0.14] (critic w4r1: no soft AO under cornice/sills; the 0.66 cap rendered the crease at only 0.82 of no-AO in sRGB, the post floor lifts it further)
  aoDirect: 1.4,       // wave-4 r3: 1.25 -> 1.4 (the ledge pools survive the lit face's display shoulder; walls keep the 0.48 baked floor, so no crush). r13: 1.5 -> 1.25 (critic r12: shopfront AO near-black; the voxel AO itself is gentler and floored now).
                       // how much AO also bites direct light (r8 0.8 -> 1.0: critic r7 'AO reads flat'). Raised from 0.38
                       // in surface r2 when the voxel AO became the ONLY AO on
                       // voxel pixels (ssaoKeep 0): ref04's soft corner bands
                       // show on sunlit faces too.
  saturation: 1.16,    // palette saturation lift (fights PBR/IBL wash-out)
  rim: 0.16,           // rim/silhouette strength (day)
  rimNight: 0.07,      // rim strength at full night. night w4r2: 0.26 -> 0.07 — the rim is ADDITIVE
                       // lavender (not x albedo) on every face in iso, and lifted the whole night
                       // city ~6/255 into one mid-violet band (measured).
  skyFill: 0.28,       // hemispheric sky bounce into indirect diffuse (0.16 before
                       // surface r2: shaded faces went muddy/near-black)
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
  grain: 0.0,          // RETIRED (surface r1): no procedural texture on voxel faces
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
  tooth: [0.0, 40.0, 110.0, 8.0],   // RETIRED (surface r1) — amplitude 0
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
  tooth2: [0.0, 0.0, 2.2],          // RETIRED (surface r1)
                       // sub-tile joint grid: (joint depth, lip highlight above
                       // the horizontal joint, joint width in device px)
  toothBump: 0.0,      // RETIRED (surface r1)
  toothQ1: 0.55,       // its amplitude multiplier at quality 1 (0 at quality 0)
  glassSpec: 1.0,      // glass F0 lift on the dielectric remainder
  glassDarken: 1.0,    // (unused since surface r1 — glass takes uGlassTint)
  glassEnv: 1.1,       // glass indirect-specular (sky reflection) multiplier.
                       // 3.2 washed every pane to lavender; the reference's glass
                       // is a clear saturated blue with a light streak (surface r1)
  glassFresnel: 0.85,  // how much of the analytic mirror is fresnel-weighted
  glassSky: 0.55,      // wave-2 r1: 0.90 -> 0.55 (+ glassReflTint): the grey sky mirror washed panes pale. strength of the analytic sky/horizon/ground mirror
                       // (2.70 before surface r1 — see glassEnv).
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
  glassTilt: 0.0,      // per-pane mirror-normal tilt. 0: the reference's glass is
                       // uniform; per-pane scatter read as a chequer of hot panes
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
  glassMetal: 0.12,    // low (surface r1): the pane's clear BLUE is diffuse, the
                       // mirror rides on top of it
  metalRough: 0.35,    // conductor roughness ceiling (metal roofs -> 0.35/1.0)
  spread: 1.22,        // dielectric roughness contrast about 0.5
  // RETIRED in surface r1 (texture the reference does not have; kept as keys
  // so setParams callers do not break): grime, panel, panelH, ledge,
  // floorVary, weather. Contact darkening is voxel.js ground AO now.
  grime: 0.0,
  panel: 0.0,
  panelH: 0.0,
  ledge: 0.0,
  instVary: 0.03,      // per-building albedo tint (+/-): barely there, never a stain
  floorVary: 0.0,
  weather: 0.0,
  weatherFall: 0.085,  // 1/e height of that gradient, in voxels
  winVary: 0.0,        // (unused since surface r1)
  winReveal: 1.0,      // legacy res-1 window frame opacity (colour = winFrame)
  winRevealW: 0.085,   // legacy frame width, fraction of the pane
  winSizeVary: 0.0,    // (unused since surface r1: every pane the same size)
  winSill: 1.00,
  winMullion: 0.0,     // legacy centre mullion strength
  winFrame: 0xf2efe6,  // legacy frame/sill colour (sRGB) — painted white trim
  glassTint: 0x1872b0, // wave-4 r1: 0x2272c8 -> slightly deeper, greener azure (lit panes measured (82,126,220) = pale electric blue; ref05 panes (28-42,84-104,104-132)). wave-2 r1: 0x4f8fe0 -> deeper azure (coordinator: panes ~#2a5aa8-#3a78c8; ref05 hospital/mall glass is a saturated azure with low R). // r8 0x3d74d0 -> lighter (panes measured navy 18,60,120). day glass albedo (sRGB): clear mid blue, ref04/ref05
  glassTintAmt: 0.95,  // wave-2 r1: 0.88 -> 0.95
  glassSheen: 0.30,    // wave-4 r2: 0.42 -> 0.30 + no thin second stripe + a soft head highlight (glassHiP) (critic w4r1: 'flat blue with drawn-on white streaks; the reference glass is a clean, slightly glossy blue'). wave-2 r1: 0.45 -> 0.42, band narrowed + cyan-tinted in the shader. r13: 0.60 -> 0.45 (critic r12: "streaky diagonal white slashes ... ref04 uses flat, calm blue panes"). r8: 0.40 -> 0.60 with the PANE-LOCAL soft glint (critic r7: 'no reflection highlight'). diagonal reflection stripe on glass (mostly specular since r2; 0.40 -> 0.55 r3: critic "flat blue, little reflection"; 0.55 -> 0.40 r6: critic "white diagonal stripes read as a cartoon hack")
  // r7: per-pane glass grade (head, sill, jamb) — needs voxel.js paneUV
  // (res > 1 walls). Replaces the painted streaks as the "this is glass" cue.
  // wave-4 r1: pane head highlight (see FRAG_COLOR pane grade). glassHi is
  // the light cyan ref05 panes clear to at the head; glassHiP = [amount,
  // band start, band end (fraction of pane/row height), weight of the thin
  // second glint stripe (was a fixed 0.40: the 'white slashes')].
  glassHi: 0x8fd0f0,
  glassHiP: [0.20, 0.55, 1.0, 0.0],   // wave-4 r2: [0,.55,1,.40] -> a gentle head gloss (0.2; w4r1's 0.3-0.45 paled the panes) and no thin stripe (the 'drawn-on white streaks'). one-bakery glass p50 (49,96,146) -> (47,90,140), p97 (157,187,251) -> (150,181,251)
  paneGrade: [1.16, 0.86, 0.10],   // r10 (critic r9: 'one flat mid-blue, no sky gradient'): stronger head-light/sill-deep grade.   // r8: head a touch LIGHTER (sky) — the baked AO now shades the reveal head (r7 [0.74, 1.12, 0.14])
  metalMax: 0.35,      // conductor metalness ceiling (toy metal keeps its grey)
  ssaoKeep: 0.0,       // fraction of post.js SSAO voxel pixels keep (written to
                       // scene alpha; see FRAG_OUT). 0: voxel AO is exact, SSAO
                       // on voxel faces only added blotches + convex-edge halos.
  debugAO: false,      // harness: render the voxel AO factor only
  darkFloor: 0.03,     // linear albedo floor for near-black paint (0 = off):
                       // #1c1e22 black trim read as a lump with no face tones
  skyFillDown: 0.5,    // sky fill kept on down-facing faces (0 = pre-r2)
  // --- surface r6: clean, confident face tones -----------------------------
  // shadowCrisp: re-shape the cast-shadow term ON VOXEL FACES ONLY with a
  // smoothstep(lo, hi). The critic's "blotchy grey smears / streaks" on white
  // cornices, parapet caps and roof decks are the low-contrast tails of the
  // PCSS filter (s ~ 0.6-0.95: shadow-map texel staircase blurred by the 0.3
  // world-unit penumbra floor, plus filter leak around small rooftop props).
  // A smoothstep keeps every real umbra and the shape of every shadow, but
  // pushes those tails back to fully lit and turns the blur into a soft,
  // clean edge, i.e. a blurred-then-thresholded contour, not a smear.
  // [amount, lo, hi]. Off at night (lamp light is not the CSM key).
  shadowCrisp: [1.0, 0.22, 0.80],
  // bounce: sunlight bounced off the lit ground/city into faces that turn
  // AWAY from the key, scaled by the key's own colour (so it fades at dusk and
  // is ~0 under the moon). ref04/ref05: the dark side of a white wall is a
  // light, clean grey (~0.8 of the lit face), the dark side of a coloured wall
  // is a darker, MORE saturated version of it, never a muddy blue-grey.
  // [strength, hue carry (0 = neutral, 1 = albedo hue squared)].
  // r12 (critic r11: "the darker faces need more saturated, warmer colour and
  // less grey"): hue carry 0.55 -> 0.85.
  bounce: [0.22, 0.85, 1.0],   // wave-4 r2: [2] = peak-normalised hue carry (see SHADE SIDE). r8 0.30 -> 0.22: critic r7 'left/right faces too close in value' (right/left luma 0.79 -> ~0.77; ref04 0.76)
  bounceTint: 0xfff1e0,  // warm-white: bounce off sunlit paving / grass / brick
  // night w4r2: shade-side fill at night (sRGB hex, strength scale on bounce) — see FRAG
  nightShade: [0x4a8cff, 1.3],    // w4r5: 2.8 -> 1.3 (right faces a clear dark third tone; the stronger moon key carries the lift). w4r4: 1.25 -> 2.8 (right faces coloured deep blue, not near-black). w4r3: 0x5a78ff (violet-blue) -> blue-teal
  // night w4r2: lower storeys / lots take less moon than roofs
  // (light scale at the base, ramp from, ramp to [u above model base], amount)
  nightFloor: [0.7, 0.4, 4.5, 1.0],   // w4r4: 0.62 -> 0.7 (low-rise / lots were flat and dim)
  // night w4r3: up faces ramp to full moon over (from, to) u above the model
  // base instead of nightFloor's, and take x(1+boost) key (roofs > walls > lots)
  // night w4r6: moonlit tops (above nightTop's ramp) take albedo^x mixed by y — dark slate
  // tower roofs lift to a light moonlit slate, hue kept (see the shader note).
  nightTopLift: [1.0, 0.0],
  // night w4r6: [vertical-face key scale, shade-side (away) fill scale] at full night.
  nightFace: [1.0, 1.0],
  nightTop: [0.6, 1.6, 2.2],   // w4r5: 0.7 -> 2.2 (critic w4r4: moonlit tops must be clearly the brightest). w4r4: key boost 0.35 -> 0.7 (moonlit roofs a clear step above walls)
  // night w4r2: sky env at full night = base * envNight (was base * 1.22: the
  // violet IBL lifted every face ~8/255 and flattened the masses)
  envNight: 0.5,
  // shadeSide (surface r9): faces turned away from the key take less of the
  // (horizon-uniform) hemi + IBL fill, with the albedo hue carried so the dark
  // side is a deeper, richer version of the lit colour. [depth, hue carry,
  // -N.L at which it is fully on]. See the FRAG_AO note.
  // r12: hue carry 0.30 -> 0.60 (same critic note; ref04's shaded orange is
  // (165,90,46), deeper AND more saturated than its lit (200,125,69)).
  shadeSide: [0.34, 0.60, 0.45, 1.0],   // wave-4 r2: [3] = 1, PEAK-normalised hue carry (critic w4r1: 'the right-hand shadow face is almost as bright as the lit left face'; probe tower right face R: red 237 -> 189, pink 246 -> 206, dough 210 -> 184, brick 204 -> 163, cream/white unchanged). r13: depth 0.40 -> 0.34 (critic r12: 'lift the floor of the shadowed-face colour')
                                   //   // r9 one-bakery pink right/left luma 0.85 -> ~0.73 (ref04 0.73)
  // wallKey (surface r10): direct-diffuse scale on vertical faces by day, so a
  // lit wall sits a clear step below the tops. See the FRAG_AO note.
  // r10-f: 0.80 moved the lit pink only 3% (fill + tonemap shoulder); 0.70
  // with the r10 AO puts the lit wall ~12-15% under r9 (ref04 lit/top 0.89).
  // r12: 0.70 -> 0.60 (critic r11: walls "flat and a little washed out"; the
  // lit pink sat at R 249, on the display clip, where no AO can read. ref04's
  // lit wall peaks at R 200.)
  wallKey: 0.60,
  // glassDiffuse (surface wave-2 r1): [direct, indirect] diffuse kept on glass
  // by day. See the GLASS BODY note in FRAG_AO. 1,1 = pre-wave-2.
  glassDiffuse: [0.45, 0.5],   // wave-4 r1: [0.7,0.7] -> darker pane body (coordinator: glass pale everywhere). one-bakery lit pane median (82,126,220) -> (73,116,177), shaded (51,83,148) -> (45,76,114); ref05 shaded (37,84,114).
  glassReflTint: 1.0,   // wave-4 r1: 0.85 -> 1.0 (a grey sky mirror is what lifted R and paled the panes). // pane hue carried into its env/mirror reflection (0 = grey mirror)
  // aoHue (surface r12): colour bleed into the baked AO. [hue carry per unit
  // of AO darkening (clamped to 1), extra neutral depth per unit of
  // darkening]. A 0.6 crease on a pink wall goes a deeper, redder pink
  // instead of a greyer one; whites and greys are untouched. See FRAG_AO.
  aoHue: [0.6, 0.0],   // r13: 1.0 -> 0.6 (critic r12: 'muddy dark-red' creases)
  worldAOKeep: 0.0,    // share of lighting.js's height-volume world AO voxel
                       // faces keep (surface r4). Its 8-direction x 2-tap
                       // kernel against a 2048^2 height map is not smooth on a
                       // flat face: it painted the streaky grey smears the r3
                       // critic saw on white cornices, parapet caps and lot
                       // paving. Voxel faces carry their own ray-cast AO
                       // (voxel.js), so 0 = they skip it (and its 16 taps).
                       // Terrain/roads/water still take it at full strength.
  winOff: 0.34,        // fraction of windows unlit at night
  // Per-window night brightness: mix(lo, hi, pow(rand, gamma)). Skewed so most
  // rooms are dim and a few are bright, which is what an occupied tower looks
  // like. sd/mean of this distribution is ~29% IN HDR — the previous +/-25%
  // symmetric jitter was applied on top of a value that was already clipping.
  winLevel: [0.34, 1.30, 0.85],
  winDusk: [0.44, 0.26, 0.10],  // (first switch-on nightT, spread, ramp width)
  winTemp: 1.0,        // per-window colour temperature spread (1 = ~2400-4200K)
  // night r1: per-building night personality (see FRAG_OUT). winOffVary is
  // the spread of each building's unlit share around winOff (0.34 +/- 0.25:
  // a sleepy block next to a busy one). winWarm = (building temperature skew,
  // per-window jitter around it, how far cool 201 panes are pulled to
  // winCoolTo). pow 2.2 puts ~2/3 of buildings on the amber side.
  winOffVary: 0.90,   // w4r5 0.50 -> 0.90 (with winBimodal: some towers nearly dark, some mostly lit)
  winWarm: [2.2, 0.35, 0.75],
  winCoolTo: 0xffe4b8,
  // night w4r3: ground-floor panes (below [1] u above the model's lattice min
  // corner, which sits under the lot plinth: 5.0 measured = the commercial
  // shopfront storey + a house's lower floor) keep shop hours: unlit share
  // x[0], level x[2]. [1, 0, 1] = off.
  winShop: [0.4, 5.0, 1.2],
  // night w4r5 (critic w4r4: "every facade the same evenly scattered grid"):
  // whole floors switch together — [share of floors dark, share of floors
  // busy, busy floors' unlit-share scale, floor band height in u] — and
  // winBimodal (0..1) pushes each building's occupancy toward sleepy / busy.
  winFloor: [0.28, 0.22, 0.20, 2.0],
  winBimodal: 1.0,
  // night w4r5: street-level office-glass lobby [from u, to u, unlit share,
  // level] above the model's lattice base (lit, warm, full height).
  glassLobby: [0.0, 2.4, 0.12, 1.1],
  nightSat: 0.60,      // w4r5 0.35 -> 0.6 (critic w4r4: brown/maroon towers muddy; each tower keeps its own colour). w4r3 0.22 -> 0.35 (brick stays red under the blue-teal key). night r1: extra palette saturation at full night (see update())
  // night r1: plain res>1 wall glass lit as offices at night (FRAG_OUT):
  // [amount, extra unlit share over winOff, brightness scale, min height above
  // the model base in world units].
  // MEASURED (t7/t8): 0.16/0.75 flooded downtown in gold and bloom; 0.48/0.30
  // leaves ~1 room in 5 lit, dim enough to stay under the bloom threshold.
  glassNight: [1.0, 0.48, 0.30, 1.4],
  // night w4: lit sign letters (models/core.js SIGN_LIT twins, see FRAG_OUT):
  // [amount, share of buildings whose signs stay dark, saturation of the
  // letter colour, how far white letters are pulled to a warm-white bulb].
  nightSign: [1.0, 0.22, 1.35, 0.55],
  glassStrip: [0.16, 0.80],
  // [HDR level of an ordinary lit sign, of a hot neon one, share of lit
  // buildings that get the hot one]. 0.8 threshold bloom: the ordinary level
  // sits just over it (soft halo), neon clearly past it.
  signBoost: [1.7, 3.0, 0.35],
  // [share of hot pale-letter signs that turn pink/cyan neon, pink share]
  signNeon: [1.0, 0.5],
  // sRGB palette colours that are glass in the models but painted as far as
  // voxel.js's material classes go (models/core.js dtGlass, dtGlassHi,
  // dtGlassDeep, dtGlassTeal, dtGlassDark, civGlass). Exactly 6 (uniform
  // array size); pad with -1 for unused slots.
  nightGlassColors: [0x4f86bd, 0x9ad2f2, 0x2c5a78, 0x35a0b0, 0x2a4a66, 0x5cb3ea],
  neonSat: 1.65,       // saturation applied to neon before the HDR push
  envIntensity: 1.0,
  seasonStrength: 0.0, // buildings are untinted today; engine may raise it
  ghostPulse: 1.0,
};

// ===========================================================================
// PERF: shared voxel-AO atlas
// ===========================================================================
// voxel.js (opts.aoAtlas) emits each quad's AO as a small R8 REGION of lattice
// texels (2x2 when the AO over the quad is a plain bilinear blend) plus
// region-local UVs. place(geo) shelf-packs a geometry's regions into one
// square power-of-two BLOCK, takes that block from a buddy allocator over a
// single size x size R8 texture (texStorage2D once, texSubImage2D per block —
// nothing is ever re-uploaded), rewrites the UVs in place, and returns the
// block when the geometry is garbage collected. One texture for every mesh =
// no per-object uniform, so the voxel material stays a single program.
// place() returns false (the caller falls back to per-vertex AO) on WebGL1 or
// when the atlas has no room.
export class AoAtlas {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    const gl = renderer && renderer.getContext ? renderer.getContext() : null;
    this._gl = gl;
    const maxT = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0;
    let size = 1;
    while (size * 2 <= Math.min(opts.size || 4096, maxT || 0)) size *= 2;
    this.size = size;
    this.used = 0;                    // texels handed out
    this.ok = !!(gl && renderer.capabilities && renderer.capabilities.isWebGL2 && size >= 1024);
    this.texture = new THREE.Texture();
    this.texture.name = 'voxAoAtlas';
    if (!this.ok) return;
    // k-d buddy allocator: level l blocks are (size >> (l >> 1)) wide and
    // (size >> ((l + 1) >> 1)) tall — squares and 2:1 rectangles, so a
    // block wastes at most half its area (a square-only buddy wasted up to 3/4
    // and filled the atlas at ~120 of the demo city's ~270 building meshes).
    this._levels = 0;
    while ((size >> ((this._levels + 1) >> 1)) > 16) this._levels++;
    this._free = [];
    for (let l = 0; l <= this._levels; l++) this._free.push(new Set());
    this._free[0].add('0,0');
    const tex = gl.createTexture();
    renderer.state.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._tex = tex;
    // three binds a version-0 texture's __webglTexture as is (setTexture2D).
    const tp = renderer.properties.get(this.texture);
    tp.__webglTexture = tex;
    tp.__webglInit = true;
    this._reg = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry((blocks) => { for (const b of blocks) this._release(b[0], b[1], b[2]); }) : null;
  }

  _dims(l) { return [this.size >> (l >> 1), this.size >> ((l + 1) >> 1)]; }

  _alloc(l) {
    const set = this._free[l];
    for (const k of set) { set.delete(k); const i = k.indexOf(','); return [+k.slice(0, i), +k.slice(i + 1)]; }
    if (l === 0) return null;
    const p = this._alloc(l - 1);
    if (!p) return null;
    const [w, h] = this._dims(l);
    // the parent at l-1 splits across its long side: square -> two (w, h)
    // stacked in y; 2:1 -> two squares side by side in x
    if ((l - 1) % 2 === 0) set.add(p[0] + ',' + (p[1] + h)); else set.add((p[0] + w) + ',' + p[1]);
    return p;
  }

  _release(x, y, l) {
    const [bw, bh] = this._dims(l);
    this.used -= bw * bh;
    while (l > 0) {
      const [w, h] = this._dims(l);
      const [pw, ph] = this._dims(l - 1);
      const px = x - (x % pw), py = y - (y % ph);
      const sx = (l - 1) % 2 === 0 ? px : (x === px ? px + w : px);
      const sy = (l - 1) % 2 === 0 ? (y === py ? py + h : py) : py;
      const key = sx + ',' + sy;
      if (!this._free[l].has(key)) break;
      this._free[l].delete(key);
      x = px; y = py; l--;
    }
    this._free[l].add(x + ',' + y);
  }

  place(geo) {
    const R = geo && geo.userData && geo.userData.aoRegions;
    if (!R) return true;
    if (!this.ok) return false;
    const n = R.size.length / 2;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => (R.size[b * 2 + 1] - R.size[a * 2 + 1]) || (R.size[b * 2] - R.size[a * 2]));
    // Regions go into one or more blocks: each block is the biggest level that
    // the remaining area (x1.15) still fills, shelf-packed greedily, so a
    // model wastes ~10% instead of up to half a power-of-two block.
    const px = new Int32Array(n), py = new Int32Array(n);
    const blocks = [];
    let rest = order;
    const fail = () => { for (const b of blocks) this._release(b[0], b[1], b[2]); return false; };
    while (rest.length) {
      let area = 0, mw = 1, mh = 1;
      for (const r of rest) {
        area += R.size[r * 2] * R.size[r * 2 + 1];
        if (R.size[r * 2] > mw) mw = R.size[r * 2];
        if (R.size[r * 2 + 1] > mh) mh = R.size[r * 2 + 1];
      }
      let lvl = -1;
      for (let l = this._levels; l >= 0; l--) {
        const [w, h] = this._dims(l);
        if (w < mw || h < mh) continue;
        lvl = l;
        if (w * h >= area * 1.15 || l === 0) break;
        const [pw, ph] = this._dims(l - 1);
        if (pw * ph > area * 1.15) break;     // the next size up would be mostly empty
      }
      if (lvl < 0) return fail();
      const [W, H] = this._dims(lvl);
      const at = this._alloc(lvl);
      if (!at) return fail();
      blocks.push([at[0], at[1], lvl]);
      this.used += W * H;
      const buf = new Uint8Array(W * H);
      const left = [];
      let x = 0, y = 0, sh = 0, full = false;
      for (const r of rest) {
        const rw = R.size[r * 2], rh = R.size[r * 2 + 1];
        if (full) { left.push(r); continue; }
        if (x + rw > W) { y += sh; x = 0; sh = 0; }
        if (y + rh > H) { full = true; left.push(r); continue; }
        px[r] = at[0] + x; py[r] = at[1] + y;
        const d = R.data[r];
        for (let j = 0; j < rh; j++) buf.set(d.subarray(j * rw, (j + 1) * rw), (y + j) * W + x);
        x += rw; if (rh > sh) sh = rh;
      }
      const gl = this._gl;
      this.renderer.state.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, at[0], at[1], W, H, gl.RED, gl.UNSIGNED_BYTE, buf);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      rest = left;
    }
    // region-local texel centres -> atlas UV
    const S = this.size, a = geo.attributes[ATTR.aoAtlas], uv = a.array, q2r = R.quad;
    for (let q = 0; q < q2r.length; q++) {
      const r = q2r[q];
      for (let k = 0; k < 4; k++) {
        const v = (q * 4 + k) * 2;
        uv[v] = (px[r] + uv[v]) / S;
        uv[v + 1] = (py[r] + uv[v + 1]) / S;
      }
    }
    a.needsUpdate = true;
    geo.userData.aoRegions = null;
    geo.userData.aoTexels = blocks.reduce((t, b) => { const d = this._dims(b[2]); return t + d[0] * d[1]; }, 0);
    if (this._reg) this._reg.register(geo, blocks);
    return true;
  }

  dispose() {
    if (this._tex && this._gl) this._gl.deleteTexture(this._tex);
    this._tex = null;
    this.ok = false;
  }
}

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
    // PERF: shared voxel-AO atlas (see AoAtlas); engine places geometry.
    this.aoAtlas = renderer ? new AoAtlas(renderer) : null;
    this.uniforms = {
      uAoAtlas: { value: this.aoAtlas ? this.aoAtlas.texture : null },
      // SHARED — identity preserved, never cloned.
      uNight: u.uNight || { value: 0 },
      uSeason: u.uSeason || { value: new THREE.Vector3(1, 1, 1) },
      // Owned by this module.
      uTime: { value: 0 },
      uSeasonStrength: { value: p.seasonStrength },
      uSnowCover: { value: 0 },   // coherence 09-25: setSnow()
      uRimColor: { value: new THREE.Color(0.72, 0.85, 1.0) },
      uRimStrength: { value: p.rim },
      uSkyFillColor: { value: new THREE.Color(0.55, 0.72, 1.0) },
      uSkyFill: { value: p.skyFill },
      uAOStrength: { value: p.ao },
      uAODirect: { value: p.aoDirect },
      uAOWallCap: { value: new THREE.Vector2(p.aoWallCap[0], p.aoWallCap[1]) },
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
      uWinOffVary: { value: p.winOffVary },
      uWinShop: { value: new THREE.Vector3().fromArray(p.winShop || [1, 0, 1]) },
      uWinFloor: { value: new THREE.Vector4().fromArray(p.winFloor || [0, 0, 1, 2]) },
      uWinBimodal: { value: p.winBimodal || 0 },
      uGlassLobby: { value: new THREE.Vector4().fromArray(p.glassLobby || [0, 0, 1, 0]) },
      uWinWarm: { value: new THREE.Vector3().fromArray(p.winWarm) },
      uWinCoolTo: { value: new THREE.Color().setHex(p.winCoolTo, THREE.SRGBColorSpace) },
      uGlassNight: { value: new THREE.Vector4().fromArray(p.glassNight) },
      uNightSign: { value: new THREE.Vector4().fromArray(p.nightSign) },
      uGlassStrip: { value: new THREE.Vector2().fromArray(p.glassStrip) },
      uSignBoost: { value: new THREE.Vector3().fromArray(p.signBoost) },
      uSignNeon: { value: new THREE.Vector2().fromArray(p.signNeon) },
      uNightGlassCol: { value: _nightGlassCols(p.nightGlassColors) },
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
      uGlassTint: { value: new THREE.Color().setHex(p.glassTint, THREE.SRGBColorSpace) },
      uGlassTintAmt: { value: p.glassTintAmt },
      uGlassSheen: { value: p.glassSheen },
      uPaneGrade: { value: new THREE.Vector3(p.paneGrade[0], p.paneGrade[1], p.paneGrade[2]) },
      uGlassHi: { value: new THREE.Color().setHex(p.glassHi, THREE.SRGBColorSpace) },
      uGlassHiP: { value: new THREE.Vector4(p.glassHiP[0], p.glassHiP[1], p.glassHiP[2], p.glassHiP[3]) },
      uWinFrame: { value: new THREE.Color().setHex(p.winFrame, THREE.SRGBColorSpace) },
      uMetalMax: { value: p.metalMax },
      uSsaoKeep: { value: p.ssaoKeep },
      uDebugAO: { value: 0 },
      uDarkFloor: { value: p.darkFloor },
      uSkyFillDown: { value: p.skyFillDown },
      uWorldAOKeep: { value: p.worldAOKeep },
      uShadowCrisp: { value: new THREE.Vector4(p.shadowCrisp[0], p.shadowCrisp[1], p.shadowCrisp[2], 0) },
      uBounce: { value: new THREE.Vector4(p.bounce[0], p.bounce[1], p.bounce[2] || 0, 0) },
      uBounceTint: { value: new THREE.Color().setHex(p.bounceTint, THREE.SRGBColorSpace) },
      uNightShade: { value: _nightShadeVec(p.nightShade, new THREE.Vector4()) },
      uNightFloor: { value: new THREE.Vector4().fromArray(p.nightFloor || [1, 0, 1, 0]) },
      uNightTop: { value: new THREE.Vector3().fromArray(p.nightTop || [0.4, 4.5, 0]) },
      uNightTopLift: { value: new THREE.Vector2().fromArray(p.nightTopLift || [1, 0]) },
      uNightFace: { value: new THREE.Vector2().fromArray(p.nightFace || [1, 1]) },
      uShadeSide: { value: new THREE.Vector4(p.shadeSide[0], p.shadeSide[1], p.shadeSide[2], p.shadeSide[3] || 0) },
      uWallKey: { value: p.wallKey },
      uGlassDiffuse: { value: new THREE.Vector2(p.glassDiffuse[0], p.glassDiffuse[1]) },
      uGlassReflTint: { value: p.glassReflTint },
      uAOHue: { value: new THREE.Vector4(p.aoHue[0], p.aoHue[1], 0, 0) },
    };

    this.voxel = this._makeVoxelMaterial();
    this.ghost = this._makeGhostMaterial();
    // coherence #8 (surface wave-2 r1): depth-only pre-pass for the ghost, so
    // only the FRONT-MOST surface of the model is tinted (see prepGhost).
    this.ghostDepth = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: true, transparent: true,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.ghostDepth.name = 'voxelGhostDepth';
    this._mats = [this.voxel, this.ghost, this.ghostDepth];

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
      // r11: OFF. The scene renders into a half-float target (post.js), so
      // there is no 8-bit banding to hide here; three's +/-0.5/255 LINEAR
      // dither was expanded by the sRGB curve and post's grade in dark
      // tones into visible speckle on every shaded wall foot and plinth side
      // (measured: r11-d nodither vs cur, one-bakery).
      dithering: false,
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

      let f = (csm ? '#define VOX_CSM\n' : 'float csmLastShadow = 1.0;\n') + FRAG_PARS + shader.fragmentShader;
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

  /**
   * Placement ghost: draw each ghost mesh twice, a depth-only pass then the
   * translucent tint, so the tint lands on the front-most surface only.
   * Coherence #8: with depthWrite off, every stand, seat row and inner wall
   * of a dense res-4 model (stadium, mall) blended through the front faces
   * into a busy see-through wireframe blob. Now the ghost reads as one clean
   * translucent solid with its silhouette and fresnel rim. Uses geometry
   * groups (two groups over the whole index) + a [depth, ghost] material
   * array; single-material meshes ignore groups, so the shared cached
   * geometry is unaffected elsewhere (scene, shadow and glow passes).
   * Call after every setGhost (idempotent).
   */
  prepGhost(root) {
    if (!root) return;
    const mats = this._ghostPair || (this._ghostPair = [this.ghostDepth, this.ghost]);
    const fix = (m) => {
      if (!m || !m.isMesh) return;
      if (m.material !== this.ghost && m.material !== mats) return;
      const g = m.geometry;
      if (!g) return;
      const n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
      const gr = g.groups;
      const ok = gr.length === 2 && gr[0].start === 0 && gr[0].count === n && gr[0].materialIndex === 0 &&
                 gr[1].start === 0 && gr[1].count === n && gr[1].materialIndex === 1;
      if (!ok) {
        if (gr.length) return;              // someone else's groups: leave the mesh alone
        g.addGroup(0, n, 0);
        g.addGroup(0, n, 1);
      }
      m.material = mats;
    };
    fix(root);
    for (let i = 0; i < root.children.length; i++) fix(root.children[i]);
  }

  _makeGhostMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0x66ff88,      // engine.js setGhost() overwrites this per frame
      roughness: 0.35,
      metalness: 0.0,
      transparent: true,
      // wave-4 r1 (coherence #8): 0.55 -> 0.72. With the depth pre-pass the
      // ghost is one front surface; at 0.55 the busy city behind it (signs,
      // cars, road lines) still printed through and the preview read as a
      // noisy tinted smear on dense blocks. 0.72 reads as a clean solid.
      opacity: 0.72,
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
      winOffVary: p.winOffVary,
      winWarm: p.winWarm,
      winShop: p.winShop,
      winFloor: p.winFloor,
      winBimodal: p.winBimodal,
    }, opts || {}));
  }

  /** Weather snow cover 0..1 on up-facing faces (engine.setWeather). */
  setSnow(v) { this.uniforms.uSnowCover.value = Math.max(0, Math.min(1, +v || 0)); }

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
      if (m === this.ghostDepth) continue;   // depth-only: no env
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
    if (U.uAOWallCap) U.uAOWallCap.value.set(p.aoWallCap[0], p.aoWallCap[1]);
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
    U.uWinOffVary.value = p.winOffVary;
    if (p.winShop) U.uWinShop.value.fromArray(p.winShop);
    if (p.winFloor) U.uWinFloor.value.fromArray(p.winFloor);
    if (p.winBimodal !== undefined) U.uWinBimodal.value = p.winBimodal;
    if (p.glassLobby) U.uGlassLobby.value.fromArray(p.glassLobby);
    U.uWinWarm.value.fromArray(p.winWarm);
    U.uWinCoolTo.value.setHex(p.winCoolTo, THREE.SRGBColorSpace);
    U.uGlassNight.value.fromArray(p.glassNight);
    if (p.nightSign) U.uNightSign.value.fromArray(p.nightSign);
    if (p.glassStrip) U.uGlassStrip.value.fromArray(p.glassStrip);
    if (p.signBoost) U.uSignBoost.value.fromArray(p.signBoost);
    if (p.signNeon) U.uSignNeon.value.fromArray(p.signNeon);
    U.uNightGlassCol.value = _nightGlassCols(p.nightGlassColors);
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
    U.uGlassTint.value.setHex(p.glassTint, THREE.SRGBColorSpace);
    U.uGlassTintAmt.value = p.glassTintAmt;
    U.uGlassSheen.value = p.glassSheen;
    U.uPaneGrade.value.set(p.paneGrade[0], p.paneGrade[1], p.paneGrade[2]);
    U.uGlassHi.value.setHex(p.glassHi, THREE.SRGBColorSpace);
    U.uGlassHiP.value.set(p.glassHiP[0], p.glassHiP[1], p.glassHiP[2], p.glassHiP[3]);
    U.uWinFrame.value.setHex(p.winFrame, THREE.SRGBColorSpace);
    U.uMetalMax.value = p.metalMax;
    U.uSsaoKeep.value = p.ssaoKeep;
    U.uDebugAO.value = p.debugAO ? 1 : 0;
    U.uDarkFloor.value = p.darkFloor;
    U.uSkyFillDown.value = p.skyFillDown;
    U.uWorldAOKeep.value = p.worldAOKeep;
    U.uShadowCrisp.value.set(p.shadowCrisp[0], p.shadowCrisp[1], p.shadowCrisp[2], 0);
    U.uBounce.value.set(p.bounce[0], p.bounce[1], p.bounce[2] || 0, 0);
    U.uBounceTint.value.setHex(p.bounceTint, THREE.SRGBColorSpace);
    if (p.nightShade) _nightShadeVec(p.nightShade, U.uNightShade.value);
    if (p.nightFloor) U.uNightFloor.value.fromArray(p.nightFloor);
    if (p.nightTop) U.uNightTop.value.fromArray(p.nightTop);
    if (p.nightTopLift) U.uNightTopLift.value.fromArray(p.nightTopLift);
    if (p.nightFace) U.uNightFace.value.fromArray(p.nightFace);
    U.uShadeSide.value.set(p.shadeSide[0], p.shadeSide[1], p.shadeSide[2], p.shadeSide[3] || 0);
    U.uWallKey.value = p.wallKey;
    U.uGlassDiffuse.value.set(p.glassDiffuse[0], p.glassDiffuse[1]);
    U.uGlassReflTint.value = p.glassReflTint;
    U.uAOHue.value.set(p.aoHue[0], p.aoHue[1], 0, 0);
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
    const en = this._params.envNight != null ? this._params.envNight : 1.22;
    this.voxel.envMapIntensity = base * (1.0 + (en - 1.0) * night);
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
      // night r1: moonlight is one cool hue over everything, so building
      // colours converged on lavender-grey. A palette saturation lift that
      // rides in with the night keeps a red tower red and a green roof green.
      const nk = Math.min(1, Math.max(0, (night - 0.45) / 0.35));
      this.uniforms.uSat.value = p.saturation * (1 + (p.nightSat || 0) * nk * nk * (3 - 2 * nk));
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
    if (this.aoAtlas) { this.aoAtlas.dispose(); this.aoAtlas = null; }
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
