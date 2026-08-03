// src/render/voxel.js — CONTRACTS-RENDER.md §3.6
//
// Voxel meshing for buildings / props / dynamics. Pure: takes a model
// ({sx,sy,sz,blocks:[[x,y,z,colorIndex],...]}) and returns a THREE.BufferGeometry.
// No scene, no renderer, no globals, no allocation beyond the geometry itself.
//
// Upgrades over engine._buildVoxelGeometry:
//   * typed-array occupancy grid (was a string-keyed Set)
//   * per-vertex ambient occlusion (classic 4-neighbour corner term) in `aoT`,
//     with the anisotropy fix (quad triangulation flips along the dark diagonal)
//   * micro-bevel: each face is emitted as an inset centre quad + a darker,
//     normal-tilted rim ring, so adjacent same-colour voxels still read apart
//   * per-palette-index roughness/metalness in `matParams` (vec2)
//   * indexed geometry + exact preallocation (no JS array push churn)
//
// Emitted attributes (a consuming material MUST match these names/sizes):
//   position   vec3   local space, X/Z centred on the model, Y bottom-anchored at 0
//   normal     vec3   face normal; bevel rim vertices are tilted outward
//   color      vec3   LINEAR base colour from the palette
//   glowColor  vec3   LINEAR night-emissive colour (== color for non-glow voxels)
//   emissiveT  float  1 for palette indices >= 200, else 0
//   aoT        float  READY-TO-MULTIPLY light factor. 1 = fully open,
//                     (1 - aoStrength) = fully occluded corner. Includes the
//                     bevel rim darkening. Material does: diffuse.rgb *= aoT.
//   matParams  vec2   (roughness, metalness)
//
// Cost note: the micro-bevel emits a face as 8 vertices / 10 triangles instead
// of 4 / 2 (an inset centre quad plus a 4-quad rim ring). That is 2x vertices
// and 5x triangles. It is worth it up close and pointless at distance — pass
// `bevel:false` at low quality / far LOD (see VOXEL_DEFAULTS).

import * as THREE from '../../vendor/three.module.js';
import { PALETTE as MODEL_PALETTE } from '../models.js';

// ---------------------------------------------------------------------------
// Material response table
// ---------------------------------------------------------------------------
// [roughness, metalness]
const M = {
  metal:    [0.30, 0.95],
  metalDim: [0.46, 0.90],
  steel:    [0.36, 0.92],
  gold:     [0.26, 1.00],
  glass:    [0.07, 0.16],
  water:    [0.10, 0.20],
  paint:    [0.55, 0.04],   // painted plaster / render walls
  plastic:  [0.42, 0.02],
  ceramic:  [0.34, 0.03],   // glazed roof tiles, signage
  stone:    [0.80, 0.02],
  concrete: [0.78, 0.01],
  asphalt:  [0.93, 0.02],
  brick:    [0.90, 0.00],
  wood:     [0.82, 0.00],
  dirt:     [0.96, 0.00],
  sand:     [0.92, 0.00],
  foliage:  [0.86, 0.00],
  fabric:   [0.90, 0.00],
  skin:     [0.72, 0.00],
  hair:     [0.78, 0.02],
  lamp:     [0.45, 0.00],
  neon:     [0.28, 0.00],
};

// Canonical palette layout — mirrors the `_colors` object literal at the top of
// src/models.js, IN KEY ORDER (that order defines the numeric indices). Kept as
// [name, sRGB hex, material key] so we can (a) resolve materials by index with
// zero lookups and (b) detect drift against the real PALETTE at load time.
const PALETTE_SPEC = [
  ['grassLight', 0x7ec850, 'foliage'], ['grassMid', 0x5fae3a, 'foliage'], ['grassDark', 0x4a8f2c, 'foliage'],
  ['leafLight', 0x8fd84a, 'foliage'], ['leafMid', 0x5cb02f, 'foliage'], ['leafDark', 0x3f8a24, 'foliage'],
  ['pine', 0x2f7d3a, 'foliage'], ['pineDark', 0x24632d, 'foliage'],
  ['blossom', 0xff9ec4, 'foliage'], ['blossomDark', 0xf56fa6, 'foliage'],
  ['bush', 0x6fc23c, 'foliage'], ['lime', 0xa6e04f, 'foliage'],
  ['trunk', 0x8a5a2b, 'wood'], ['trunkDark', 0x6b431f, 'wood'],
  ['wood', 0xc08a4a, 'wood'], ['woodDark', 0x8a5f2f, 'wood'], ['plank', 0xd8a45c, 'wood'],
  ['dirt', 0x9b6b3f, 'dirt'], ['dirtDark', 0x7a5230, 'dirt'],
  ['brick', 0xc0533f, 'brick'], ['brickDark', 0x9a3f30, 'brick'],
  ['roofRed', 0xc23b2e, 'ceramic'], ['red', 0xe23b2e, 'paint'], ['fireRed', 0xd8231b, 'paint'], ['crimson', 0xa8221a, 'paint'],
  ['pBlue', 0xa9d6e5, 'paint'], ['pYellow', 0xf7e08a, 'paint'], ['pPink', 0xf6b5c8, 'paint'], ['pGreen', 0xb7e0a0, 'paint'],
  ['pPurple', 0xcbb6e6, 'paint'], ['cream', 0xf3e6c4, 'paint'], ['white', 0xf5f5f0, 'paint'], ['offwhite', 0xe4e4dc, 'paint'],
  ['peach', 0xf6c9a0, 'paint'], ['mint', 0xa8e6cf, 'paint'],
  ['roofBlue', 0x3f6fb0, 'ceramic'], ['roofBrown', 0x7c4a2a, 'ceramic'], ['roofGray', 0x6b6f76, 'ceramic'],
  ['roofGreen', 0x3f8a5a, 'ceramic'], ['roofOrange', 0xe08a3c, 'ceramic'], ['roofPurple', 0x6a4f9a, 'ceramic'],
  ['shingle', 0x944b3a, 'brick'],
  ['asphalt', 0x3a3d42, 'asphalt'], ['asphaltDark', 0x2b2e33, 'asphalt'], ['sidewalk', 0xb9bcc0, 'concrete'],
  ['concrete', 0xcfd2d6, 'concrete'], ['stone', 0x9aa0a6, 'stone'], ['stoneDark', 0x6e747a, 'stone'],
  ['metal', 0xaab0b6, 'metal'], ['metalDark', 0x7a8087, 'metalDim'], ['steel', 0x8b9096, 'steel'], ['darkGray', 0x33363b, 'metalDim'],
  ['yellow', 0xf5c518, 'plastic'], ['roadLine', 0xf2c94c, 'paint'], ['orange', 0xf28c28, 'plastic'],
  ['taxiYellow', 0xf7c948, 'plastic'], ['gold', 0xe8b83a, 'gold'], ['amber', 0xf0a830, 'plastic'],
  ['waterLight', 0x5fc7e8, 'water'], ['waterMid', 0x3aa6d8, 'water'], ['waterDark', 0x2b7fb8, 'water'],
  ['blue', 0x3f7fd8, 'paint'], ['skyBlue', 0x8fd0f0, 'glass'], ['navy', 0x2a4a8a, 'paint'], ['teal', 0x2fbfa8, 'paint'],
  ['skin1', 0xf6c9a8, 'skin'], ['skin2', 0xe8b088, 'skin'], ['skin3', 0xc98a5e, 'skin'], ['skin4', 0x9c6238, 'skin'], ['skin5', 0x6e4326, 'skin'],
  ['hairBlack', 0x2a2320, 'hair'], ['hairBrown', 0x5a3a22, 'hair'], ['hairBlonde', 0xe0b860, 'hair'],
  ['hairAuburn', 0x8a3f2a, 'hair'], ['hairGray', 0xbfc2c6, 'hair'],
  ['black', 0x1c1e22, 'plastic'], ['pink', 0xf27fb0, 'plastic'], ['purple', 0x8a5fc8, 'plastic'],
  ['sand', 0xe6d3a3, 'sand'], ['sandDark', 0xcbb57e, 'sand'], ['signWhite', 0xfbfbf6, 'ceramic'],
];

// Emissive indices (fixed by contract).
const GLOW_SPEC = {
  200: { hex: 0xffd98a, mat: 'glass' },   // warm window
  201: { hex: 0xbde3ff, mat: 'glass' },   // cool window
  202: { hex: 0xffe7a8, mat: 'lamp' },    // streetlight
  203: { hex: null, mat: 'neon' },        // neon — boosted from its own colour
};

const DEFAULT_MAT = [0.75, 0.0];

// index -> [roughness, metalness]; built once, plus a hex fallback map so a
// palette reorder in models.js degrades to "still correct" rather than "wrong".
const MAT_BY_INDEX = new Array(256);
const MAT_BY_HEX = new Map();
const NAME_TO_INDEX = Object.create(null);
{
  for (let i = 0; i < PALETTE_SPEC.length; i++) {
    const [name, hex, key] = PALETTE_SPEC[i];
    NAME_TO_INDEX[name] = i;
    MAT_BY_INDEX[i] = M[key] || DEFAULT_MAT;
    if (!MAT_BY_HEX.has(hex)) MAT_BY_HEX.set(hex, M[key] || DEFAULT_MAT);
  }
  for (const k in GLOW_SPEC) MAT_BY_INDEX[k | 0] = M[GLOW_SPEC[k].mat] || DEFAULT_MAT;

  // Drift guard: if models.js reordered/renamed anything, re-key by hex value.
  if (Array.isArray(MODEL_PALETTE)) {
    let drift = false;
    for (let i = 0; i < PALETTE_SPEC.length; i++) {
      if (MODEL_PALETTE[i] !== PALETTE_SPEC[i][1]) { drift = true; break; }
    }
    if (drift) {
      for (let i = 0; i < 200; i++) {
        const hex = MODEL_PALETTE[i];
        if (hex == null) continue;
        MAT_BY_INDEX[i] = MAT_BY_HEX.get(hex) || DEFAULT_MAT;
      }
    }
  }
}

/**
 * Surface response for a palette index.
 * @param {number} colorIndex
 * @returns {{roughness:number, metalness:number}} fresh object, safe to mutate
 */
export function materialFor(colorIndex) {
  const m = MAT_BY_INDEX[colorIndex | 0] || DEFAULT_MAT;
  return { roughness: m[0], metalness: m[1] };
}

/** Exposed for tooling/debug: 'metal' -> palette index. */
export const PALETTE_INDEX = NAME_TO_INDEX;

// ---------------------------------------------------------------------------
// Face table
// ---------------------------------------------------------------------------
// Per face: normal N, the face-plane origin O (a corner of the unit cube), and
// two in-plane unit axes U,V such that the four quad corners, in the ORIGINAL
// (front-facing, CCW) winding order, are:
//     O, O+V, O+U+V, O+U      i.e. (u,v) = (0,0) (0,1) (1,1) (1,0)
// AO for corner (u,v) samples, in the empty cell in front of the face:
//     side1 = (u ? +U : -U), side2 = (v ? +V : -V), corner = side1+side2
const FACES = [
  // +Y top
  { n: [0, 1, 0], o: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  // -Y bottom
  { n: [0, -1, 0], o: [0, 0, 1], u: [1, 0, 0], v: [0, 0, -1] },
  // -Z north
  { n: [0, 0, -1], o: [1, 0, 0], u: [0, 1, 0], v: [-1, 0, 0] },
  // +Z south
  { n: [0, 0, 1], o: [0, 0, 1], u: [0, 1, 0], v: [1, 0, 0] },
  // -X west
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  // +X east
  { n: [1, 0, 0], o: [1, 0, 1], u: [0, 1, 0], v: [0, 0, -1] },
];
const CORNERS = [[0, 0], [0, 1], [1, 1], [1, 0]];

// ---------------------------------------------------------------------------
// Palette resolution
// ---------------------------------------------------------------------------
const _c = new THREE.Color();

function toLinear(entry, out) {
  if (entry == null) return false;
  if (typeof entry === 'number') {
    _c.setHex(entry, THREE.SRGBColorSpace);
    out[0] = _c.r; out[1] = _c.g; out[2] = _c.b;
    return true;
  }
  if (Array.isArray(entry) || (entry.length === 3 && typeof entry[0] === 'number')) {
    out[0] = +entry[0] || 0; out[1] = +entry[1] || 0; out[2] = +entry[2] || 0;
    return true;
  }
  if (typeof entry.r === 'number') {           // THREE.Color or {r,g,b}
    out[0] = entry.r; out[1] = entry.g; out[2] = entry.b;
    return true;
  }
  return false;
}

const FALLBACK_COL = [0.6, 0.6, 0.62];

function resolveColor(palette, ci, out) {
  if (palette && toLinear(palette[ci], out)) return;
  const spec = PALETTE_SPEC[ci];
  if (spec) { toLinear(spec[1], out); return; }
  const g = GLOW_SPEC[ci];
  if (g && g.hex != null) { toLinear(g.hex, out); return; }
  const hex = Array.isArray(MODEL_PALETTE) ? MODEL_PALETTE[ci] : null;
  if (hex != null) { toLinear(hex, out); return; }
  out[0] = FALLBACK_COL[0]; out[1] = FALLBACK_COL[1]; out[2] = FALLBACK_COL[2];
}

function resolveGlow(glowPalette, ci, base, out) {
  if (glowPalette && toLinear(glowPalette[ci], out)) return;
  const g = GLOW_SPEC[ci];
  if (g) {
    if (g.hex != null) { toLinear(g.hex, out); return; }
    // 203 neon: boost the block's own day colour (matches engine.js).
    out[0] = Math.min(1, base[0] * 1.7 + 0.1);
    out[1] = Math.min(1, base[1] * 1.7 + 0.1);
    out[2] = Math.min(1, base[2] * 1.7 + 0.1);
    return;
  }
  if (ci >= 200) { toLinear(GLOW_SPEC[200].hex, out); return; }
  out[0] = base[0]; out[1] = base[1]; out[2] = base[2];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULTS = {
  ao: true,
  bevel: true,
  aoStrength: 0.62,   // 1 - aoStrength is the darkest AO factor emitted
  aoCurve: 1.15,      // >1 keeps mid corners bright (kid-friendly, not muddy)
  bevelWidth: 0.045,  // in-plane inset of the face centre quad, world units
  rimShade: 0.74,     // aoT multiplier at the outer rim ring
  rimTilt: 0.42,      // how far the rim normal leans outward (0 = flat)
  skipBottom: true,   // drop the -Y face of ground-level voxels
  palette: null,
  glowPalette: null,
};

/** Read-only view of the default options (the material lib may want aoStrength). */
export const VOXEL_DEFAULTS = Object.freeze(Object.assign({}, DEFAULTS));

/**
 * @param {{sx:number,sy:number,sz:number,blocks:Array}} model
 * @param {object} [opts] see DEFAULTS
 * @returns {THREE.BufferGeometry}
 */
export function buildVoxelGeometry(model, opts) {
  const t0 = _now();
  const o = opts ? Object.assign({}, DEFAULTS, opts) : DEFAULTS;

  const blocks = (model && Array.isArray(model.blocks)) ? model.blocks : null;
  if (!blocks || blocks.length === 0) return _emptyGeometry(t0);

  const sx = Math.max(1, model.sx | 0 || 1);
  const sy = Math.max(1, model.sy | 0 || 1);
  const sz = Math.max(1, model.sz | 0 || 1);
  const hx = sx / 2, hz = sz / 2;

  // --- occupancy: padded typed grid, one byte per cell ------------------------
  const PW = sx + 2, PH = sy + 2, PD = sz + 2;
  const occ = new Uint8Array(PW * PH * PD);
  const rowY = PW * PD;
  // padded index of voxel (x,y,z)
  const oi = (x, y, z) => (y + 1) * rowY + (z + 1) * PW + (x + 1);

  const nb = blocks.length;
  // Which blocks are in-range (out-of-range ones are skipped entirely so the
  // counting pass and the emit pass agree).
  const live = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) {
    const b = blocks[i];
    if (!b) continue;
    const x = b[0] | 0, y = b[1] | 0, z = b[2] | 0;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
    live[i] = 1;
    occ[oi(x, y, z)] = 1;
  }

  // --- pass 1: count visible faces -------------------------------------------
  const skipBottom = o.skipBottom !== false;
  let faceCount = 0;
  for (let i = 0; i < nb; i++) {
    if (!live[i]) continue;
    const b = blocks[i];
    const x = b[0] | 0, y = b[1] | 0, z = b[2] | 0;
    const base = oi(x, y, z);
    if (!occ[base + rowY]) faceCount++;                       // +Y
    if (!(skipBottom && y === 0) && !occ[base - rowY]) faceCount++; // -Y
    if (!occ[base - PW]) faceCount++;                          // -Z
    if (!occ[base + PW]) faceCount++;                          // +Z
    if (!occ[base - 1]) faceCount++;                           // -X
    if (!occ[base + 1]) faceCount++;                           // +X
  }
  if (faceCount === 0) return _emptyGeometry(t0);

  const bevel = o.bevel !== false && o.bevelWidth > 0;
  const vpf = bevel ? 8 : 4;      // vertices per face
  const ipf = bevel ? 30 : 6;     // indices per face
  const vCount = faceCount * vpf;

  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const color = new Float32Array(vCount * 3);
  const glowColor = new Float32Array(vCount * 3);
  const emissiveT = new Float32Array(vCount);
  const aoT = new Float32Array(vCount);
  const matParams = new Float32Array(vCount * 2);
  const index = vCount > 65535 ? new Uint32Array(faceCount * ipf)
    : new Uint16Array(faceCount * ipf);

  // --- AO ramp ---------------------------------------------------------------
  const aoOn = o.ao !== false;
  const strength = Math.max(0, Math.min(1, o.aoStrength));
  const curve = o.aoCurve > 0 ? o.aoCurve : 1;
  // aoLUT[k] for k = 0..3 (3 = fully open)
  const aoLUT = new Float32Array(4);
  for (let k = 0; k < 4; k++) {
    aoLUT[k] = aoOn ? 1 - strength * Math.pow(1 - k / 3, curve) : 1;
  }
  const rimShade = bevel ? Math.max(0, Math.min(1, o.rimShade)) : 1;
  const bw = bevel ? o.bevelWidth : 0;
  const tilt = bevel ? o.rimTilt : 0;

  // --- palette caches (per call, tiny) ---------------------------------------
  const palette = o.palette, glowPalette = o.glowPalette;
  const colCache = new Float32Array(256 * 3);
  const gloCache = new Float32Array(256 * 3);
  const seen = new Uint8Array(256);
  const tmpC = [0, 0, 0], tmpG = [0, 0, 0];

  // --- pass 2: emit ----------------------------------------------------------
  let v = 0;   // vertex cursor
  let ii = 0;  // index cursor
  const ao4 = new Int32Array(4);

  for (let i = 0; i < nb; i++) {
    if (!live[i]) continue;
    const b = blocks[i];
    const vx = b[0] | 0, vy = b[1] | 0, vz = b[2] | 0;
    let ci = b[3] | 0;
    if (ci < 0 || ci > 255) ci = 0;

    if (!seen[ci]) {
      seen[ci] = 1;
      resolveColor(palette, ci, tmpC);
      colCache[ci * 3] = tmpC[0]; colCache[ci * 3 + 1] = tmpC[1]; colCache[ci * 3 + 2] = tmpC[2];
      resolveGlow(glowPalette, ci, tmpC, tmpG);
      gloCache[ci * 3] = tmpG[0]; gloCache[ci * 3 + 1] = tmpG[1]; gloCache[ci * 3 + 2] = tmpG[2];
    }
    const cr = colCache[ci * 3], cg = colCache[ci * 3 + 1], cb = colCache[ci * 3 + 2];
    const gr = gloCache[ci * 3], gg = gloCache[ci * 3 + 1], gb = gloCache[ci * 3 + 2];
    const emi = ci >= 200 ? 1 : 0;
    const mm = MAT_BY_INDEX[ci] || DEFAULT_MAT;
    const rough = mm[0], metal = mm[1];

    const ox = vx - hx, oy = vy, oz = vz - hz;
    const base = oi(vx, vy, vz);

    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const nx = F.n[0], ny = F.n[1], nz = F.n[2];
      // occlusion test
      const nOff = ny * rowY + nz * PW + nx;
      if (occ[base + nOff]) continue;
      if (f === 1 && skipBottom && vy === 0) continue;

      const ux = F.u[0], uy = F.u[1], uz = F.u[2];
      const vxa = F.v[0], vya = F.v[1], vza = F.v[2];
      // padded index of the empty cell in front of this face
      const air = base + nOff;
      const uOff = uy * rowY + uz * PW + ux;
      const vOff = vya * rowY + vza * PW + vxa;

      // --- per-corner AO ---
      if (aoOn) {
        for (let k = 0; k < 4; k++) {
          const cu = CORNERS[k][0], cv = CORNERS[k][1];
          const du = cu ? uOff : -uOff;
          const dv = cv ? vOff : -vOff;
          const s1 = occ[air + du];
          const s2 = occ[air + dv];
          ao4[k] = (s1 && s2) ? 0 : 3 - (s1 + s2 + occ[air + du + dv]);
        }
      } else {
        ao4[0] = ao4[1] = ao4[2] = ao4[3] = 3;
      }

      const px = ox + F.o[0], py = oy + F.o[1], pz = oz + F.o[2];
      const v0 = v;

      if (!bevel) {
        for (let k = 0; k < 4; k++) {
          const cu = CORNERS[k][0], cv = CORNERS[k][1];
          const p3 = v * 3;
          position[p3] = px + ux * cu + vxa * cv;
          position[p3 + 1] = py + uy * cu + vya * cv;
          position[p3 + 2] = pz + uz * cu + vza * cv;
          normal[p3] = nx; normal[p3 + 1] = ny; normal[p3 + 2] = nz;
          color[p3] = cr; color[p3 + 1] = cg; color[p3 + 2] = cb;
          glowColor[p3] = gr; glowColor[p3 + 1] = gg; glowColor[p3 + 2] = gb;
          emissiveT[v] = emi;
          aoT[v] = aoLUT[ao4[k]];
          matParams[v * 2] = rough; matParams[v * 2 + 1] = metal;
          v++;
        }
      } else {
        // 4 outer (full extent, darkened, normal tilted outward) …
        for (let k = 0; k < 4; k++) {
          const cu = CORNERS[k][0], cv = CORNERS[k][1];
          const su = cu ? 1 : -1, sv = cv ? 1 : -1;
          const p3 = v * 3;
          position[p3] = px + ux * cu + vxa * cv;
          position[p3 + 1] = py + uy * cu + vya * cv;
          position[p3 + 2] = pz + uz * cu + vza * cv;
          let tnx = nx + tilt * (ux * su + vxa * sv);
          let tny = ny + tilt * (uy * su + vya * sv);
          let tnz = nz + tilt * (uz * su + vza * sv);
          const il = 1 / Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
          normal[p3] = tnx * il; normal[p3 + 1] = tny * il; normal[p3 + 2] = tnz * il;
          color[p3] = cr; color[p3 + 1] = cg; color[p3 + 2] = cb;
          glowColor[p3] = gr; glowColor[p3 + 1] = gg; glowColor[p3 + 2] = gb;
          emissiveT[v] = emi;
          aoT[v] = aoLUT[ao4[k]] * rimShade;
          matParams[v * 2] = rough; matParams[v * 2 + 1] = metal;
          v++;
        }
        // … 4 inner (inset by bevelWidth, flat normal, full AO)
        for (let k = 0; k < 4; k++) {
          const cu = CORNERS[k][0] ? 1 - bw : bw;
          const cv = CORNERS[k][1] ? 1 - bw : bw;
          const p3 = v * 3;
          position[p3] = px + ux * cu + vxa * cv;
          position[p3 + 1] = py + uy * cu + vya * cv;
          position[p3 + 2] = pz + uz * cu + vza * cv;
          normal[p3] = nx; normal[p3 + 1] = ny; normal[p3 + 2] = nz;
          color[p3] = cr; color[p3 + 1] = cg; color[p3 + 2] = cb;
          glowColor[p3] = gr; glowColor[p3 + 1] = gg; glowColor[p3 + 2] = gb;
          emissiveT[v] = emi;
          aoT[v] = aoLUT[ao4[k]];
          matParams[v * 2] = rough; matParams[v * 2 + 1] = metal;
          v++;
        }
      }

      // --- triangulation ---
      // Anisotropy fix: split along the DARKER diagonal, otherwise an L-shaped
      // corner shadow bends the wrong way across the quad.
      const inner = bevel ? v0 + 4 : v0;
      const flip = ao4[0] + ao4[2] > ao4[1] + ao4[3];
      if (!flip) {
        index[ii++] = inner; index[ii++] = inner + 1; index[ii++] = inner + 2;
        index[ii++] = inner; index[ii++] = inner + 2; index[ii++] = inner + 3;
      } else {
        index[ii++] = inner; index[ii++] = inner + 1; index[ii++] = inner + 3;
        index[ii++] = inner + 1; index[ii++] = inner + 2; index[ii++] = inner + 3;
      }
      if (bevel) {
        for (let e = 0; e < 4; e++) {
          const a = v0 + e, bb = v0 + ((e + 1) & 3);        // outer ring
          const c = inner + ((e + 1) & 3), d = inner + e;   // inner ring
          index[ii++] = a; index[ii++] = bb; index[ii++] = c;
          index[ii++] = a; index[ii++] = c; index[ii++] = d;
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('glowColor', new THREE.BufferAttribute(glowColor, 3));
  geo.setAttribute('emissiveT', new THREE.BufferAttribute(emissiveT, 1));
  geo.setAttribute('aoT', new THREE.BufferAttribute(aoT, 1));
  geo.setAttribute('matParams', new THREE.BufferAttribute(matParams, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.userData.voxel = {
    voxels: nb,
    faces: faceCount,
    vertices: vCount,
    triangles: index.length / 3,
    ao: aoOn,
    bevel,
    ms: _now() - t0,
  };
  return geo;
}

function _emptyGeometry(t0) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
  geo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array(0), 3));
  geo.setAttribute('emissiveT', new THREE.BufferAttribute(new Float32Array(0), 1));
  geo.setAttribute('aoT', new THREE.BufferAttribute(new Float32Array(0), 1));
  geo.setAttribute('matParams', new THREE.BufferAttribute(new Float32Array(0), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(0), 1));
  geo.boundingSphere = new THREE.Sphere();
  geo.userData.voxel = { voxels: 0, faces: 0, vertices: 0, triangles: 0, ms: _now() - t0 };
  return geo;
}

function _now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// selfTest — CONTRACTS-RENDER.md §4
// ---------------------------------------------------------------------------

const ATTRS = [
  ['position', 3], ['normal', 3], ['color', 3], ['glowColor', 3],
  ['emissiveT', 1], ['aoT', 1], ['matParams', 2],
];

function _cube(n, filled) {
  const blocks = [];
  for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    if (filled || x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1) {
      blocks.push([x, y, z, (x + y + z) % 40]);
    }
  }
  return { sx: n, sy: n, sz: n, blocks };
}

export function selfTest() {
  const notes = [];
  let pass = true;
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };
  const ok = (m) => notes.push('ok: ' + m);

  // 1 — attribute presence + count consistency, no NaN, aoT range
  const models = [
    { sx: 1, sy: 1, sz: 1, blocks: [[0, 0, 0, 20]] },
    { sx: 2, sy: 2, sz: 2, blocks: _cube(2, true).blocks },
    { sx: 3, sy: 3, sz: 3, blocks: [[0, 0, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1], [2, 2, 2, 200]] },
    _cube(8, false),
  ];
  for (const optSet of [{}, { ao: false }, { bevel: false }, { ao: false, bevel: false }]) {
    for (const m of models) {
      const g = buildVoxelGeometry(m, optSet);
      let n = -1;
      for (const [name, size] of ATTRS) {
        const a = g.getAttribute(name);
        if (!a) { fail('missing attribute ' + name); continue; }
        if (a.itemSize !== size) fail(name + ' itemSize ' + a.itemSize + ' != ' + size);
        if (n < 0) n = a.count; else if (a.count !== n) fail('attribute count mismatch on ' + name);
        for (let i = 0; i < a.array.length; i++) {
          if (!Number.isFinite(a.array[i])) { fail('non-finite value in ' + name); break; }
        }
      }
      const ao = g.getAttribute('aoT');
      for (let i = 0; i < ao.array.length; i++) {
        if (ao.array[i] < 0 || ao.array[i] > 1) { fail('aoT out of [0,1]: ' + ao.array[i]); break; }
      }
      const idx = g.getIndex();
      if (!idx) fail('missing index');
      else for (let i = 0; i < idx.array.length; i++) {
        if (idx.array[i] >= n) { fail('index out of range'); break; }
      }
      if (!g.boundingSphere || !Number.isFinite(g.boundingSphere.radius)) fail('bad boundingSphere');
      g.dispose();
    }
  }
  ok('attributes consistent, finite, aoT in [0,1], indices in range');

  // 2 — face culling: solid 2×2×2 => 6 sides × 4 faces − 4 skipped bottoms = 20
  {
    const g = buildVoxelGeometry(_cube(2, true), { bevel: false });
    const f = g.userData.voxel.faces;
    if (f !== 20) fail('2×2×2 face count ' + f + ' != 20'); else ok('face culling correct (20 faces)');
    g.dispose();
  }

  // 3 — AO: the corner where two neighbours meet must be fully occluded
  {
    // Floor slab + two blocks standing on it that share a corner over voxel
    // (1,0,1): that voxel's +Y face has one corner with BOTH sides occupied.
    const blocks = [];
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) blocks.push([x, 0, z, 1]);
    blocks.push([0, 1, 1, 1], [1, 1, 0, 1]);
    const g = buildVoxelGeometry({ sx: 3, sy: 2, sz: 3, blocks }, { bevel: false });
    const ao = g.getAttribute('aoT').array;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < ao.length; i++) { if (ao[i] < min) min = ao[i]; if (ao[i] > max) max = ao[i]; }
    const darkest = 1 - DEFAULTS.aoStrength;
    if (Math.abs(min - darkest) > 1e-5) fail('two-sided corner not fully dark (min aoT ' + min + ')');
    else ok('two-neighbour corner fully occluded (aoT ' + min.toFixed(3) + ')');
    if (Math.abs(max - 1) > 1e-5) fail('open corner not fully lit (max aoT ' + max + ')');
    g.dispose();
  }

  // 4 — ao:false must emit aoT === 1 everywhere (bevel off)
  {
    const g = buildVoxelGeometry(_cube(4, false), { ao: false, bevel: false });
    const ao = g.getAttribute('aoT').array;
    let bad = 0;
    for (let i = 0; i < ao.length; i++) if (ao[i] !== 1) bad++;
    if (bad) fail('ao:false left ' + bad + ' shaded vertices'); else ok('ao:false is a clean 1.0');
    g.dispose();
  }

  // 5 — determinism: same model twice => byte-identical buffers
  {
    const m = _cube(10, false);
    const a = buildVoxelGeometry(m);
    const b = buildVoxelGeometry(m);
    let same = true;
    for (const [name] of ATTRS) {
      const x = a.getAttribute(name).array, y = b.getAttribute(name).array;
      if (x.length !== y.length) { same = false; break; }
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { same = false; break; }
      if (!same) break;
    }
    const ia = a.getIndex().array, ib = b.getIndex().array;
    if (ia.length !== ib.length) same = false;
    else for (let i = 0; i < ia.length; i++) if (ia[i] !== ib[i]) { same = false; break; }
    if (!same) fail('non-deterministic output'); else ok('deterministic (byte-identical rebuild)');
    a.dispose(); b.dispose();
  }

  // 6 — materialFor sanity
  {
    const metalIdx = NAME_TO_INDEX.metal, goldIdx = NAME_TO_INDEX.gold;
    const brickIdx = NAME_TO_INDEX.brick, woodIdx = NAME_TO_INDEX.wood;
    if (!(materialFor(metalIdx).metalness > 0.8)) fail('metal is not metallic');
    if (!(materialFor(goldIdx).metalness > 0.8)) fail('gold is not metallic');
    if (!(materialFor(200).roughness < 0.2)) fail('window glass is not glossy');
    if (!(materialFor(brickIdx).roughness > 0.8)) fail('brick is not rough');
    if (!(materialFor(woodIdx).roughness > 0.7)) fail('wood is not rough');
    if (materialFor(9999).roughness !== DEFAULT_MAT[0]) fail('unknown index has no fallback');
    ok('materialFor: metal/gold metallic, glass glossy, brick/wood rough');
  }

  // 7 — palette sync with models.js
  {
    let drift = 0;
    if (Array.isArray(MODEL_PALETTE)) {
      for (let i = 0; i < PALETTE_SPEC.length; i++) {
        if (MODEL_PALETTE[i] !== PALETTE_SPEC[i][1]) drift++;
      }
      if (MODEL_PALETTE.length < PALETTE_SPEC.length) drift++;
    }
    if (drift) notes.push('warn: palette drift vs models.js (' + drift + ' entries) — using hex fallback');
    else ok('palette table in sync with models.js (' + PALETTE_SPEC.length + ' named colours)');
  }

  // 8 — degenerate inputs must not throw
  {
    for (const m of [null, undefined, {}, { blocks: [] }, { sx: 2, sy: 2, sz: 2, blocks: [[9, 9, 9, 3]] }]) {
      try {
        const g = buildVoxelGeometry(m);
        if (!g.getAttribute('position')) fail('degenerate input produced no position attribute');
        g.dispose();
      } catch (e) { fail('threw on degenerate input: ' + e.message); }
    }
    ok('degenerate inputs handled');
  }

  // 9 — timing on a big model
  {
    const big = _cube(32, false);   // 32³ hollow shell ≈ 5768 voxels
    buildVoxelGeometry(big);        // warm
    const t = _now();
    const runs = 5;
    let tris = 0;
    for (let i = 0; i < runs; i++) {
      const g = buildVoxelGeometry(big);
      tris = g.userData.voxel.triangles;
      g.dispose();
    }
    const ms = (_now() - t) / runs;
    notes.push('timing: 32³ shell (' + big.blocks.length + ' voxels, ' + tris + ' tris) = ' + ms.toFixed(2) + ' ms/build');
    if (ms > 40) fail('32³ shell meshing too slow (' + ms.toFixed(1) + ' ms)');
  }

  return { pass, notes };
}
