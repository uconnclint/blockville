// src/render/props.js — street furniture + natural scatter (CONTRACTS-RENDER.md)
//
// The two loudest "this is not a real city" tells at the game's camera were
//   (a) roads.build() emitting ~428 street-furniture anchors that nothing
//       consumed, so street level was bare asphalt, and
//   (b) ~70% of the frame being empty flat green: no tree, hedge, rock or path
//       anywhere outside the city footprint.
// This module fixes both, and adds the lamp POST under the warm ground pools
// lighting.js already draws (light was appearing from nowhere).
//
// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------
// * ONE InstancedMesh per (prop type, LOD). 16 meshes total; typically 8-13 of
//   them have a non-zero count in any given frame (three skips instanceCount 0
//   without issuing a draw). Hundreds-to-thousands of props, ~a dozen calls.
//
// * Frustum culling is real, at CHUNK granularity. A single map-wide
//   InstancedMesh is all-or-nothing to three's culler, which is useless here, so
//   instances are baked per 80x80-unit chunk (8x8 = 64 chunks) and the visible
//   chunks are memcpy-compacted into the instance buffers each time the camera
//   moves. 64 Box3 tests + a handful of TypedArray.set calls.
//
// * Density scales with distance and quality FOR FREE: every chunk's instance
//   run is sorted by a per-instance random rank, so "use 60% of them" is
//   `count = ceil(n * 0.6)` — a truncation, not a re-bake, and the retained
//   subset is stable (only the tail appears/disappears, never a reshuffle).
//
// * Wind sway and the far-distance shrink-out are vertex-shader side, driven by
//   a per-instance vec4 and the camera position uniform. Zero per-frame CPU.
//
// * Art is voxel, built procedurally in the same idiom as everything else:
//   buildVoxelGeometry() from voxel.js for the near LOD (real per-vertex AO,
//   real palette colours, real matParams), and a hand-rolled box mesher for the
//   far impostors, which need a silhouette and ~24 triangles, not 210.
//
// ---------------------------------------------------------------------------
// Integration (engine.js owns all of these calls)
// ---------------------------------------------------------------------------
//   const props = new Props(scene, { quality });
//   for (const m of props.materials) lighting.patchMaterial(m);   // CSM receipt
//   props.setAnchors(roads.build(state));    // after every roads build/refresh
//   props.scatter(state);                    // after buildGround / reseed
//   props.update(dt, ctx);                   // per frame, before post.render()
//
// Shader-injection rule (see terrain.js / STATUS.md bug 2): every replace()
// re-emits the #include it matched. lighting.js's patchMaterial() chains on top
// of ours and replaces <lights_fragment_begin>, which we never touch.

import * as THREE from '../../vendor/three.module.js';
import { buildVoxelGeometry, materialFor, PALETTE_INDEX as PI } from './voxel.js';
import { PALETTE } from '../models.js';

// ---------------------------------------------------------------------------
// World facts
// ---------------------------------------------------------------------------

const TILE = 8;
const N = 80;
const MAP_W = N * TILE;               // 640

const T_GRASS = 0, T_WATER = 1, T_SAND = 2, T_ROAD = 3, T_TREE = 8, T_MOUNTAIN = 15;

// Top of the kerb — roads.js's yOffset (0.02) + curbHeight (0.15).
const PROP_Y = 0.17;

// lighting.js parks the lamp's glow billboard at bulbY, default anchor.y + 4.2.
// FURN_SCALE is chosen so the bulb VOXEL centre lands there:
//   PROP_Y + (8 + 0.5) * 0.48 = 0.17 + 4.08 = 4.25.  Within a sixth of the
// billboard's radius, i.e. the post and the pool are the same light source.
const FURN_SCALE = 0.48;
const LAMP_BULB_VY = 8;
const LAMP_BULB_Y = PROP_Y + (LAMP_BULB_VY + 0.5) * FURN_SCALE;

// ---------------------------------------------------------------------------
// Vegetation scale
// ---------------------------------------------------------------------------
// Vegetation is authored in VOXEL units, the same idiom as models.js's own
// trees, so an instance `scale` of 1.0 means a 5-unit-wide canopy on a 9-unit
// oak — WIDER and TALLER than a one-storey house (7 x 5 x 7). The first pass
// instanced everything at a flat 0.72..1.34, so the median scattered canopy was
// ~5 world units across and one canopy occluded several floors of a tower.
//
// There is no single right size, because there are two populations doing two
// different jobs, and collapsing them into one uniform jitter is what produced
// "broccoli poured over downtown":
//
//   STREET  planted nursery stock in a city verge. 1.5 .. 2.9 units of canopy,
//           2.7 .. 5.2 tall — clearly smaller than the house beside it.
//   WOOD    forest trees out in open country, where canopy MASS is the whole
//           point and there is no architecture to bury. 2.1 .. 4.5 canopy,
//           still well under the first pass's 3.6 .. 6.7.
//   UNDER   understorey and saplings: the 2nd and 3rd stem in a copse tile, so
//           a copse reads as layered rather than as a hedge of lollipops.
const STREET_SIZES = [0.30, 0.36, 0.42, 0.49, 0.58];
const STREET_CDF = [0.14, 0.40, 0.70, 0.90, 1.00];
const WOOD_SIZES = [0.42, 0.54, 0.65, 0.76, 0.84, 0.90];
const WOOD_CDF = [0.16, 0.38, 0.62, 0.82, 0.94, 1.00];
const UNDER_SIZES = [0.26, 0.33, 0.40, 0.48];
const UNDER_CDF = [0.30, 0.62, 0.86, 1.00];

/** Weighted pick from a size ladder. `u` is a deterministic 0..1. */
function pickSize(u, sizes, cdf) {
  let i = 0;
  while (i < cdf.length - 1 && u >= cdf[i]) i++;
  return sizes[i];
}

// Built-up field thresholds: fraction of tiles inside URBAN_R that carry a
// building footprint, mapped through smooth01 to "urbanness" 0..1.
const URBAN_R = 4;                    // tiles (a 9x9 / 72-world-unit window)
const URBAN_LO = 0.045, URBAN_HI = 0.30;

const CHUNKS = 8;                     // 8x8 chunks of 10 tiles / 80 world units
const CHUNK_W = MAP_W / CHUNKS;
const NCHUNK = CHUNKS * CHUNKS;

// Chunk boxes are inflated before the frustum test so props just off the edge
// of the screen still make it into the shadow cascades.
const CULL_PAD = 24;

// ---------------------------------------------------------------------------
// Deterministic hashing / noise  (no Math.random anywhere in this file)
// ---------------------------------------------------------------------------

function hash3(a, b, c) {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x = (x ^ Math.imul((b | 0) + 0x165667b1, 0xc2b2ae35)) >>> 0;
  x = (x ^ Math.imul((c | 0) + 0x27d4eb2f, 0x9e3779b1)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2545f491); x ^= x >>> 13;
  return x >>> 0;
}
/** Deterministic [0,1). */
function rnd(a, b, c) { return hash3(a, b, c) / 4294967296; }

function vnoise(x, z, salt) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = rnd(ix, iz, salt), b = rnd(ix + 1, iz, salt);
  const c = rnd(ix, iz + 1, salt), d = rnd(ix + 1, iz + 1, salt);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** 3-octave value fbm in 0..1. */
function fbm(x, z, salt) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < 3; o++) {
    s += vnoise(x * f, z * f, salt + o * 977) * amp;
    norm += amp; amp *= 0.5; f *= 2.07;
  }
  return s / norm;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Voxel model authoring (same shape as models.js's internal grid())
// ---------------------------------------------------------------------------

function mdl(sx, sy, sz) {
  const map = new Map();
  return {
    sx, sy, sz,
    set(x, y, z, c) {
      x |= 0; y |= 0; z |= 0;
      if (c == null || x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return this;
      map.set(x + ',' + y + ',' + z, c);
      return this;
    },
    box(x0, y0, z0, x1, y1, z1, c) {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          for (let z = z0; z <= z1; z++) this.set(x, y, z, c);
      return this;
    },
    /** Solid horizontal disc of radius r about (cx,cz) at height y. */
    disc(cx, cz, y, r, c) {
      const rr = (r + 0.35) * (r + 0.35);
      const ri = Math.ceil(r);
      for (let dx = -ri; dx <= ri; dx++)
        for (let dz = -ri; dz <= ri; dz++)
          if (dx * dx + dz * dz <= rr) this.set(cx + dx, y, cz + dz, c);
      return this;
    },
    /** Recolour existing cells with a hashed pick from `cols`. */
    speckle(cols, salt) {
      for (const k of Array.from(map.keys())) {
        const p = k.split(',');
        const h = hash3(+p[0] * 31 + salt, +p[1] * 17, +p[2] * 13 + salt);
        map.set(k, cols[h % cols.length]);
      }
      return this;
    },
    done() {
      const blocks = [];
      for (const [k, c] of map) {
        const p = k.split(',');
        blocks.push([+p[0], +p[1], +p[2], c]);
      }
      return { sx, sy, sz, blocks };
    },
  };
}

// ---------------------------------------------------------------------------
// Box mesher — the far-LOD / simple-shape path
// ---------------------------------------------------------------------------
// Emits exactly the attribute set voxel.js does, so one material covers both.
// Boxes are in WORLD units (bottom-anchored at y=0, centred on X/Z) and closed
// (all six faces), because lighting.js casts BACK faces: an open shell leaks.

const BOX_FACES = [
  // n, O(from box min/max flags), U, V — quad = O, O+U, O+U+V, O+V (CCW outside)
  { n: [1, 0, 0], o: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },   // +X
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -X
  { n: [0, 1, 0], o: [0, 1, 1], u: [1, 0, 0], v: [0, 0, -1] },  // +Y
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -Y
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },   // +Z
  { n: [0, 0, -1], o: [0, 0, 0], u: [0, 1, 0], v: [1, 0, 0] },  // -Z
];

const _col = new THREE.Color();
const _linCache = new Map();
function paletteLinear(ci) {
  let v = _linCache.get(ci);
  if (v) return v;
  const hex = PALETTE[ci];
  _col.setHex(hex == null ? 0x999999 : hex, THREE.SRGBColorSpace);
  v = [_col.r, _col.g, _col.b];
  _linCache.set(ci, v);
  return v;
}

/**
 * @param {Array<{x0,y0,z0,x1,y1,z1,ci,top?}>} boxes  world units
 * @param {{topOnly?:boolean}} [opts] topOnly emits only the +Y quad (ground decals)
 */
function buildBoxGeometry(boxes, opts) {
  const topOnly = !!(opts && opts.topOnly);
  const faces = topOnly ? 1 : 6;
  const nf = boxes.length * faces;
  const vc = nf * 4;

  const position = new Float32Array(vc * 3);
  const normal = new Float32Array(vc * 3);
  const color = new Float32Array(vc * 3);
  const glowColor = new Float32Array(vc * 3);
  const emissiveT = new Float32Array(vc);
  const aoT = new Float32Array(vc);
  const matParams = new Float32Array(vc * 2);
  const index = vc > 65535 ? new Uint32Array(nf * 6) : new Uint16Array(nf * 6);

  let maxY = 0.001;
  for (const b of boxes) maxY = Math.max(maxY, b.y1);

  let v = 0, ii = 0;
  for (const b of boxes) {
    const lin = paletteLinear(b.ci);
    const mm = materialFor(b.ci);
    const emi = b.ci >= 200 ? 1 : 0;
    const glow = emi ? paletteLinear(b.ci) : [0, 0, 0];
    const ext = [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0];

    for (let f = topOnly ? 2 : 0; f < (topOnly ? 3 : 6); f++) {
      const F = BOX_FACES[f];
      const ox = F.o[0] ? b.x1 : b.x0;
      const oy = F.o[1] ? b.y1 : b.y0;
      const oz = F.o[2] ? b.z1 : b.z0;
      const ux = F.u[0] * ext[0], uy = F.u[1] * ext[1], uz = F.u[2] * ext[2];
      const vx = F.v[0] * ext[0], vy = F.v[1] * ext[1], vz = F.v[2] * ext[2];
      const v0 = v;
      for (let k = 0; k < 4; k++) {
        const cu = (k === 1 || k === 2) ? 1 : 0;
        const cv = (k === 2 || k === 3) ? 1 : 0;
        const px = ox + ux * cu + vx * cv;
        const py = oy + uy * cu + vy * cv;
        const pz = oz + uz * cu + vz * cv;
        const p3 = v * 3;
        position[p3] = px; position[p3 + 1] = py; position[p3 + 2] = pz;
        normal[p3] = F.n[0]; normal[p3 + 1] = F.n[1]; normal[p3 + 2] = F.n[2];
        color[p3] = lin[0]; color[p3 + 1] = lin[1]; color[p3 + 2] = lin[2];
        glowColor[p3] = glow[0]; glowColor[p3 + 1] = glow[1]; glowColor[p3 + 2] = glow[2];
        emissiveT[v] = emi;
        // Fake the voxel AO term: sky-facing is open, the underside is buried,
        // sides ramp out of the ground. This is what makes the far impostors
        // sit ON the terrain instead of floating over it.
        const up = F.n[1];
        const hT = clamp(py / maxY, 0, 1);
        aoT[v] = up > 0.5 ? 1.0
          : up < -0.5 ? 0.46
            : 0.60 + 0.40 * Math.pow(hT, 0.75);
        matParams[v * 2] = mm.roughness; matParams[v * 2 + 1] = mm.metalness;
        v++;
      }
      index[ii++] = v0; index[ii++] = v0 + 1; index[ii++] = v0 + 2;
      index[ii++] = v0; index[ii++] = v0 + 2; index[ii++] = v0 + 3;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('glowColor', new THREE.BufferAttribute(glowColor, 3));
  g.setAttribute('emissiveT', new THREE.BufferAttribute(emissiveT, 1));
  g.setAttribute('aoT', new THREE.BufferAttribute(aoT, 1));
  g.setAttribute('matParams', new THREE.BufferAttribute(matParams, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

const box = (x0, y0, z0, x1, y1, z1, ci) => ({ x0, y0, z0, x1, y1, z1, ci });

/**
 * Street furniture is PAINTED metal, not polished metal. voxel.js's table gives
 * `metal` 0.95 metalness / 0.30 roughness, which is correct for a chrome trim
 * strip and completely wrong for a lamp post: a 95%-metallic surface has almost
 * no diffuse term, so every post mirrors whatever the IBL happens to be and
 * turns green over grass. Clamp the metalness and floor the roughness in place.
 */
function paintMetal(geo, maxMetal, minRough) {
  const a = geo.getAttribute('matParams');
  if (!a) return geo;
  const arr = a.array;
  for (let i = 0; i < arr.length; i += 2) {
    if (arr[i + 1] > maxMetal) {
      arr[i] = Math.max(arr[i], minRough);
      arr[i + 1] = maxMetal;
    }
  }
  a.needsUpdate = true;
  return geo;
}

// ---------------------------------------------------------------------------
// Models — street furniture
// ---------------------------------------------------------------------------
// Anchor convention (roads.js): local +Z is the facing direction, and it always
// points at the carriageway (or at oncoming traffic for signals and signs).
// Every model declares `pivot` in voxel coords; the geometry is translated so
// that point lands exactly on the anchor.

function lampModel() {
  const g = mdl(5, 11, 5);
  // Light grey mast, dark foot: a dark post reads as a black smear against
  // shadowed asphalt, which is exactly where most lamps stand.
  const M = PI.metal, D = PI.darkGray;
  // splayed foot, so it reads as bolted down rather than stuck in
  g.set(2, 0, 2, D).set(1, 0, 2, D).set(3, 0, 2, D).set(2, 0, 1, D).set(2, 0, 3, D);
  g.box(2, 1, 2, 2, 9, 2, M);              // mast
  g.set(2, 9, 3, M);                       // arm reaching over the kerb (+Z)
  g.set(2, LAMP_BULB_VY, 3, 202);          // bulb — palette 202, emissive at night
  return { model: g.done(), pivot: [2.5, 2.5] };
}

function trafficLightModel() {
  const g = mdl(5, 11, 5);
  const D = PI.darkGray, M = PI.metalDark;
  g.set(2, 0, 1, M).set(1, 0, 1, M).set(3, 0, 1, M);
  g.box(2, 1, 1, 2, 9, 1, D);              // pole
  g.box(2, 9, 1, 2, 9, 3, D);              // gantry arm out over the stop line
  g.box(2, 6, 3, 2, 8, 3, D);              // signal body
  // Lenses face +Z = the oncoming traffic on this approach. Index 203 is the
  // "neon" glow slot; the palette override below recolours it per geometry so
  // the red aspect actually glows red at night instead of neon pink.
  g.set(2, 8, 4, 203);                     // red
  g.set(2, 7, 4, PI.amber);
  g.set(2, 6, 4, PI.roofGreen);
  return { model: g.done(), pivot: [2.5, 1.5], palette: { 203: 0xff4436 } };
}

function stopSignModel() {
  const g = mdl(5, 9, 3);
  const M = PI.metalDark;
  g.set(2, 0, 1, M).set(1, 0, 1, M).set(3, 0, 1, M);
  g.box(2, 1, 1, 2, 4, 1, M);              // post
  g.box(1, 5, 1, 3, 7, 1, PI.red);         // plate (faces +-Z)
  g.set(1, 5, 1, PI.crimson).set(3, 5, 1, PI.crimson);
  g.set(1, 7, 1, PI.crimson).set(3, 7, 1, PI.crimson);
  g.set(2, 6, 1, PI.signWhite);            // the legend, at this scale
  return { model: g.done(), pivot: [2.5, 1.5] };
}

function hydrantModel() {
  const g = mdl(3, 6, 3);
  g.box(1, 0, 1, 1, 3, 1, PI.fireRed);
  g.set(1, 4, 1, PI.crimson);
  g.set(1, 5, 1, PI.yellow);
  g.set(0, 2, 1, PI.yellow).set(2, 2, 1, PI.yellow);   // side nozzles
  g.set(0, 0, 1, PI.crimson).set(2, 0, 1, PI.crimson); // base flare
  g.set(1, 0, 0, PI.crimson).set(1, 0, 2, PI.crimson);
  return { model: g.done(), pivot: [1.5, 1.5] };
}

function binModel() {
  const g = mdl(3, 5, 3);
  g.box(0, 0, 0, 1, 2, 1, PI.roofGreen);
  g.box(0, 3, 0, 1, 3, 1, PI.darkGray);    // lid
  return { model: g.done(), pivot: [1.0, 1.0] };
}

function benchModel() {
  const g = mdl(6, 5, 3);
  const M = PI.metalDark;
  // Two solid end frames rather than four separate legs: same read, far fewer
  // exposed faces (a 4-leg bench meshed at 228 triangles, which is absurd).
  g.box(0, 0, 0, 0, 1, 1, M);
  g.box(5, 0, 0, 5, 1, 1, M);
  g.box(0, 2, 0, 5, 2, 1, PI.plank);       // seat, open toward +Z (the street)
  g.box(0, 3, 0, 5, 4, 0, PI.wood);        // back, on the away side
  return { model: g.done(), pivot: [3.0, 1.0] };
}

// ---------------------------------------------------------------------------
// Models — vegetation (1 world unit per voxel, matching models.js's trees)
// ---------------------------------------------------------------------------

function oakModel(v) {
  const g = mdl(5, 9, 5);
  g.box(2, 0, 2, 2, 3, 2, v ? PI.trunkDark : PI.trunk);
  // SOLID canopy: a hollow leaf-ring shell (models.js's idiom) exposes its
  // inner faces too and costs ~2x the triangles for no visible gain at 8 units.
  g.disc(2, 2, 4, 2, PI.leafMid);
  g.disc(2, 2, 5, 2, PI.leafMid);
  g.disc(2, 2, 6, 2, PI.leafMid);
  g.disc(2, 2, 7, 1, PI.leafLight);
  g.set(2, 8, 2, PI.leafLight);
  g.speckle(v ? [PI.leafMid, PI.leafLight, PI.leafDark, PI.lime]
    : [PI.leafMid, PI.leafDark, PI.leafLight], 7 + v);
  // repaint the trunk after the speckle pass
  g.box(2, 0, 2, 2, 3, 2, v ? PI.trunkDark : PI.trunk);
  return g.done();
}

function pineModel() {
  const g = mdl(5, 12, 5);
  g.box(2, 0, 2, 2, 2, 2, PI.trunkDark);
  g.disc(2, 2, 3, 2, PI.pine);
  g.disc(2, 2, 4, 2, PI.pineDark);
  g.disc(2, 2, 5, 1.4, PI.pine);
  g.disc(2, 2, 6, 1.4, PI.pineDark);
  g.disc(2, 2, 7, 1, PI.pine);
  g.disc(2, 2, 8, 1, PI.pineDark);
  g.set(2, 9, 2, PI.pine); g.set(2, 10, 2, PI.pineDark);
  return g.done();
}

function blossomModel() {
  const g = mdl(5, 8, 5);
  g.box(2, 0, 2, 2, 2, 2, PI.trunk);
  g.disc(2, 2, 3, 2, PI.blossom);
  g.disc(2, 2, 4, 2, PI.blossom);
  g.disc(2, 2, 5, 1.4, PI.blossom);
  g.set(2, 6, 2, PI.blossom);
  g.speckle([PI.blossom, PI.blossom, PI.blossomDark, PI.leafLight], 23);
  g.box(2, 0, 2, 2, 2, 2, PI.trunk);
  return g.done();
}

// Far impostors: silhouette only, 4 boxes = 48 triangles instead of ~270.
// A single canopy cube reads as a CUBE at anything under ~250 units, which was
// the first thing that looked wrong in the hero shot. A stepped, tapered stack
// costs 24 more triangles and reads as a voxel tree all the way in.
//
// These are authored in the SAME voxel space as the near models above (bottom
// at 0, X/Z centred, 1 unit per voxel), so the two LODs share one silhouette
// and one instance scale. The first pass authored them in world units at a
// different aspect, so a tree visibly changed shape as well as detail when it
// crossed the handover.
function farBroadBoxes() {          // matches oakModel(): 5 x 9 x 5
  return [
    box(-0.50, 0, -0.50, 0.50, 4.20, 0.50, PI.trunk),
    box(-2.50, 3.90, -2.50, 2.50, 6.40, 2.50, PI.leafDark),
    box(-1.90, 6.20, -1.90, 1.90, 8.00, 1.90, PI.leafMid),
    box(-0.80, 7.80, -0.80, 0.80, 9.00, 0.80, PI.leafLight),
  ];
}
function farConifBoxes() {          // matches pineModel(): 5 x 11 x 5
  return [
    box(-0.50, 0, -0.50, 0.50, 3.20, 0.50, PI.trunkDark),
    box(-2.50, 2.90, -2.50, 2.50, 5.20, 2.50, PI.pineDark),
    box(-1.50, 5.00, -1.50, 1.50, 8.20, 1.50, PI.pine),
    box(-0.60, 8.00, -0.60, 0.60, 11.00, 0.60, PI.pineDark),
  ];
}
function farBlossomBoxes() {        // matches blossomModel(): 5 x 8 x 5
  return [
    box(-0.50, 0, -0.50, 0.50, 3.20, 0.50, PI.trunk),
    box(-2.50, 2.90, -2.50, 2.50, 5.20, 2.50, PI.blossomDark),
    box(-1.60, 5.00, -1.60, 1.60, 6.80, 1.60, PI.blossom),
    box(-0.70, 6.60, -0.70, 0.70, 7.80, 0.70, PI.blossom),
  ];
}

// ---------------------------------------------------------------------------
// Prop type table
// ---------------------------------------------------------------------------
// lod1: distance (world units) at which LOD0 hands over to LOD1 (or, if there
//       is no LOD1 geometry, the distance beyond which the type is dropped).
// cull: distance beyond which the type is not submitted at all. The vertex
//       shader shrinks each instance to nothing over the last `fadeBand` units
//       so the chunk-granular cut never pops.

const TYPES = [
  { key: 'lamp', group: 'furn', lod1: 130, cull: 300, fade: 70, sway: 0.0 },
  { key: 'trafficlight', group: 'furn', lod1: 130, cull: 280, fade: 70, sway: 0.0 },
  { key: 'sign_stop', group: 'furn', lod1: 110, cull: 180, fade: 55, sway: 0.0 },
  { key: 'hydrant', group: 'furn', lod1: 100, cull: 130, fade: 45, sway: 0.0 },
  { key: 'bin', group: 'furn', lod1: 100, cull: 130, fade: 45, sway: 0.0 },
  { key: 'bench', group: 'furn', lod1: 110, cull: 150, fade: 50, sway: 0.0 },
  // Trees hand over to the 60-triangle impostor. Canopies are ~60% of their
  // former linear size, so the handover moved in from 115 to 95 units: the near
  // LOD was the whole of the +115k-triangle bill at the street shot and most of
  // it was behind a building. The two LODs now share a silhouette (see
  // farBroadBoxes), so the step is not visible.
  { key: 'oak', group: 'veg', lod1: 95, cull: 1200, fade: 0, sway: 0.055 },
  { key: 'pine', group: 'veg', lod1: 95, cull: 1200, fade: 0, sway: 0.030 },
  { key: 'blossom', group: 'veg', lod1: 95, cull: 1200, fade: 0, sway: 0.060 },
  { key: 'shrub', group: 'veg', lod1: 300, cull: 520, fade: 90, sway: 0.075 },
  { key: 'hedge', group: 'veg', lod1: 300, cull: 520, fade: 90, sway: 0.030 },
  { key: 'rock', group: 'veg', lod1: 900, cull: 900, fade: 0, sway: 0.0 },
  { key: 'path', group: 'veg', lod1: 900, cull: 420, fade: 110, sway: 0.0 },
];
const TYPE_INDEX = Object.create(null);
for (let i = 0; i < TYPES.length; i++) TYPE_INDEX[TYPES[i].key] = i;
const NT = TYPES.length;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const PARS_COMMON = /* glsl */`
varying float vPropAO;
varying vec2  vPropMat;
varying vec3  vPropGlow;
varying float vPropEmi;
`;

const VERT_PARS = /* glsl */`
attribute float aoT;
attribute vec2  matParams;
attribute vec3  glowColor;
attribute float emissiveT;
attribute vec4  aPropParam;   // x sway, y phase, z fadeStart, w fadeEnd
uniform float uPropTime;
uniform float uPropWind;
uniform vec3  uPropCam;
${PARS_COMMON}
`;

// Runs immediately after <begin_vertex>, i.e. before <project_vertex> applies
// instanceMatrix — `transformed` is still in model space, bottom-anchored at 0.
const VERT_BODY = /* glsl */`
vPropAO   = aoT;
vPropMat  = matParams;
vPropGlow = glowColor;
vPropEmi  = emissiveT;
{
  #ifdef USE_INSTANCING
    vec3 propOrigin = instanceMatrix[3].xyz;
  #else
    vec3 propOrigin = vec3(0.0);
  #endif
  propOrigin += (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Distance shrink-out. Scaling about the model origin (which is the ground
  // contact point) sinks the prop into the terrain rather than fading it, so it
  // never leaves a half-transparent ghost for the AO/DOF passes to chew on.
  float propD = distance(uPropCam, propOrigin + vec3(0.0, 1.5, 0.0));
  float propKeep = 1.0 - smoothstep(aPropParam.z, aPropParam.w, propD);
  transformed *= propKeep;

  // Wind. Amplitude grows with height above the instance base, so trunks stay
  // planted and canopies move. Two incommensurate frequencies + a spatial phase
  // ramp make a field of trees look like weather instead of a metronome.
  float propH = max(transformed.y, 0.0);
  float propA = aPropParam.x * propH * uPropWind;
  if (propA > 0.0) {
    float ph = uPropTime + aPropParam.y + propOrigin.x * 0.052 + propOrigin.z * 0.037;
    transformed.x += propA * (sin(ph) * 0.72 + sin(ph * 2.31 + 1.7) * 0.28);
    transformed.z += propA * (sin(ph * 0.79 + 2.4) * 0.62 + sin(ph * 1.93) * 0.20);
  }
}
`;

const FRAG_PARS = /* glsl */`
uniform float uPropNight;
uniform float uPropGlowGain;
${PARS_COMMON}
`;

const FRAG_COLOR = /* glsl */`
diffuseColor.rgb *= vPropAO;
`;

// roughnessmap_fragment / metalnessmap_fragment declare the factor; we override
// it AFTER the include so the declaration (and any map) still exists.
const FRAG_ROUGH = /* glsl */`
roughnessFactor = clamp(vPropMat.x, 0.03, 1.0);
`;
const FRAG_METAL = /* glsl */`
metalnessFactor = clamp(vPropMat.y, 0.0, 1.0);
`;

const FRAG_EMISSIVE = /* glsl */`
totalEmissiveRadiance += vPropGlow * vPropEmi * uPropNight * uPropGlowGain;
`;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export class Props {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   *   quality       0|1|2
   *   uniforms      { uNight } — shared with engine.js if you want to drive the
   *                 night glow from there instead of from ctx.nightEff
   *   envIntensity  material envMapIntensity (default 0.42)
   *   wind          base wind strength multiplier (default 1)
   *   density       extra global density multiplier on the natural scatter
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts = opts || {};
    this._quality = opts.quality != null ? (opts.quality | 0) : 2;

    this._time = 0;
    this._wind = opts.wind != null ? opts.wind : 1;
    this._userDensity = opts.density != null ? opts.density : 1;

    this._state = null;         // retained for _autoRescatter
    this._occSig = 0;
    this._occSettle = 0;
    this._occPoll = 0;
    this._nf = null;            // cached fbm fields, keyed by seed

    this.uniforms = {
      uPropTime: { value: 0 },
      uPropWind: { value: 1 },
      uPropCam: { value: new THREE.Vector3() },
      uPropNight: (opts.uniforms && opts.uniforms.uNight) || { value: 0 },
      uPropGlowGain: { value: 2.6 },
    };

    this.material = this._makeMaterial();
    this.materials = [this.material];

    this._geoms = this._buildGeometries();
    this._meshes = [];   // [typeIndex*2 + lod] -> InstancedMesh | null
    this._caps = new Int32Array(NT * 2);
    for (let t = 0; t < NT * 2; t++) this._meshes[t] = null;

    // raw instances, per type, before baking
    this._raw = [];
    for (let t = 0; t < NT; t++) this._raw[t] = [];

    // baked runs: [chunk * NT + type] -> {mat, par, col, n} | null
    this._runs = new Array(NCHUNK * NT).fill(null);
    this._chunkBox = [];
    this._chunkCentre = [];
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const x0 = cx * CHUNK_W, z0 = cz * CHUNK_W;
        this._chunkBox.push(new THREE.Box3(
          new THREE.Vector3(x0 - CULL_PAD, -2, z0 - CULL_PAD),
          new THREE.Vector3(x0 + CHUNK_W + CULL_PAD, 14, z0 + CHUNK_W + CULL_PAD)));
        this._chunkCentre.push(new THREE.Vector3(x0 + CHUNK_W / 2, 2, z0 + CHUNK_W / 2));
      }
    }
    this._chunkUsed = new Uint8Array(NCHUNK);

    this._dirty = new Uint8Array(NT);       // needs re-bake
    this._visDirty = true;
    this._lastCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastCamQ = new THREE.Quaternion();
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._camInv = new THREE.Matrix4();
    this._frameSinceRefresh = 0;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();

    this.stats = {
      anchors: 0, scatter: 0, woodTrees: 0, streetTrees: 0,
      instances: 0, drawn: 0, meshes: 0,
      bakeMs: 0, scatterMs: 0, refreshMs: 0, tris: 0,
    };

    this.setQuality(this._quality);
  }

  // -- materials ------------------------------------------------------------

  _makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.0,
      envMapIntensity: this.opts.envIntensity != null ? this.opts.envIntensity : 0.42,
      dithering: true,
    });
    mat.name = 'bvProps';
    mat.defaultAttributeValues = {
      aoT: [1.0], matParams: [0.8, 0.0], glowColor: [0, 0, 0], emissiveT: [0.0],
      aPropParam: [0, 0, 1e9, 1e9],
    };

    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      for (const k in U) shader.uniforms[k] = U[k];

      shader.vertexShader = VERT_PARS + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + VERT_BODY);

      let f = FRAG_PARS + shader.fragmentShader;
      // Every replace re-emits the chunk it matched (STATUS.md bug 2).
      f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR);
      f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FRAG_ROUGH);
      f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + FRAG_METAL);
      f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_EMISSIVE);
      shader.fragmentShader = f;

      mat.userData.shader = shader;
    };
    // Must stay stable under lighting.js's patchMaterial(), which appends '|csm'.
    mat.customProgramCacheKey = () => 'bvProps-v1';
    return mat;
  }

  // -- geometry -------------------------------------------------------------

  _buildGeometries() {
    const G = {};
    const vox = (spec, scale) => {
      const geo = buildVoxelGeometry(spec.model, {
        ao: true, bevel: false, skipBottom: false, palette: spec.palette || null,
      });
      const dx = (spec.pivot[0] - spec.model.sx / 2);
      const dz = (spec.pivot[1] - spec.model.sz / 2);
      geo.translate(-dx, 0, -dz);
      if (scale && scale !== 1) geo.scale(scale, scale, scale);
      paintMetal(geo, 0.20, 0.42);
      geo.computeBoundingSphere();
      return geo;
    };
    const plain = (model) => {
      const geo = buildVoxelGeometry(model, { ao: true, bevel: false, skipBottom: false });
      geo.computeBoundingSphere();
      return geo;
    };

    // furniture — near LOD (voxel) + a 2-3 box mid LOD for the tall items
    G.lamp0 = vox(lampModel(), FURN_SCALE);
    G.lamp1 = paintMetal(buildBoxGeometry([
      box(-0.26, 0, -0.26, 0.26, 4.5, 0.26, PI.metal),
      box(-0.26, 4.3, -0.26, 0.26, 4.55, 0.75, PI.metal),
      box(-0.28, 3.85, 0.28, 0.28, 4.35, 0.78, 202),
    ]), 0.20, 0.42);
    G.trafficlight0 = vox(trafficLightModel(), FURN_SCALE);
    G.trafficlight1 = buildBoxGeometry([
      box(-0.24, 0, -0.24, 0.24, 4.6, 0.24, PI.darkGray),
      box(-0.24, 4.35, -0.24, 0.24, 4.6, 1.2, PI.darkGray),
      box(-0.34, 2.7, 1.0, 0.34, 4.4, 1.5, PI.darkGray),
      box(-0.26, 3.75, 1.48, 0.26, 4.3, 1.62, 203),
    ]);
    G.sign_stop0 = vox(stopSignModel(), FURN_SCALE);
    G.hydrant0 = vox(hydrantModel(), FURN_SCALE);
    G.bin0 = vox(binModel(), FURN_SCALE);
    G.bench0 = vox(benchModel(), FURN_SCALE);

    // vegetation — authored in voxel units; the instance `scale` field is a
    // pure size class from STREET_SIZES / WOOD_SIZES / UNDER_SIZES.
    const veg = (geo) => { geo.computeBoundingSphere(); return geo; };
    G.oak0 = veg(plain(oakModel(0)));
    G.pine0 = veg(plain(pineModel()));
    G.blossom0 = veg(plain(blossomModel()));
    G.oak1 = veg(buildBoxGeometry(farBroadBoxes()));
    G.pine1 = veg(buildBoxGeometry(farConifBoxes()));
    G.blossom1 = veg(buildBoxGeometry(farBlossomBoxes()));

    G.shrub0 = buildBoxGeometry([
      box(-0.78, 0, -0.78, 0.78, 0.62, 0.78, PI.leafDark),
      box(-0.64, 0.55, -0.64, 0.64, 1.08, 0.64, PI.bush),
      box(-0.36, 1.02, -0.36, 0.36, 1.34, 0.36, PI.leafLight),
    ]);
    // Taller and narrower than the first pass, which laid flat green bars on
    // the verge that read as painted stripes rather than planting. Half-length
    // 2.6 + a 2.2 offset keeps it inside the 8-unit tile, clear of the kerb.
    G.hedge0 = buildBoxGeometry([
      box(-2.6, 0, -0.52, 2.6, 1.35, 0.52, PI.leafDark),
      box(-2.6, 1.26, -0.42, 2.6, 1.75, 0.42, PI.bush),
    ]);
    G.rock0 = buildBoxGeometry([
      box(-1.15, 0, -0.95, 1.15, 0.78, 0.95, PI.stone),
      box(-0.62, 0.7, -0.5, 0.72, 1.22, 0.55, PI.stoneDark),
    ]);
    // Ground decal: top face only. Never a shadow caster, so an open quad is fine.
    G.path0 = buildBoxGeometry([box(-2.3, 0.055, -2.3, 2.3, 0.055, 2.3, PI.dirt)], { topOnly: true });

    return G;
  }

  _geomFor(typeIndex, lod) {
    const key = TYPES[typeIndex].key + lod;
    return this._geoms[key] || null;
  }

  // -- public: street furniture ---------------------------------------------

  /**
   * Consume roads.build() / roads.refreshTile()'s anchor list.
   * `[{x, z, yaw, kind}]` in WORLD units; kind is one of
   * lamp | trafficlight | sign_stop | hydrant | bin | bench.
   * Cheap to call repeatedly — the actual bake is coalesced into update().
   */
  setAnchors(anchors) {
    for (let t = 0; t < NT; t++) if (TYPES[t].group === 'furn') { this._raw[t].length = 0; this._dirty[t] = 1; }
    const list = Array.isArray(anchors) ? anchors : [];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a) continue;
      const t = TYPE_INDEX[a.kind];
      if (t === undefined || TYPES[t].group !== 'furn') continue;
      const x = +a.x, z = +a.z;
      if (!isFinite(x) || !isFinite(z)) continue;
      const yaw = isFinite(+a.yaw) ? +a.yaw : 0;
      const h = hash3(Math.round(x * 4), Math.round(z * 4), 91);
      // Small per-instance variety so 150 lamps do not read as 150 clones.
      const jScale = 0.94 + ((h & 255) / 255) * 0.13;
      const jYaw = yaw + (((h >>> 8) & 255) / 255 - 0.5) * 0.10;
      const tint = 0.92 + (((h >>> 16) & 255) / 255) * 0.16;
      this._raw[t].push({
        x, z, y: PROP_Y, yaw: jYaw, scale: jScale,
        r: tint, g: tint * (0.985 + ((h >>> 24) & 15) / 500), b: tint * 0.99,
        rank: ((h >>> 5) & 0xffff) / 65536,
      });
      n++;
    }
    this.stats.anchors = n;
    this._visDirty = true;
    return this;
  }

  // -- public: natural scatter ----------------------------------------------

  /**
   * Deterministic vegetation / rock / path scatter from the tile map.
   * Reads state.map, state.occ, state.bridge, state.level, state.seed. Avoids
   * water, road, mountain, building footprints and the map's own TREE tiles
   * (main.js already draws a prop on those).
   */
  scatter(state) {
    const t0 = now();
    for (let t = 0; t < NT; t++) if (TYPES[t].group === 'veg') { this._raw[t].length = 0; this._dirty[t] = 1; }

    const map = state && state.map;
    if (!map || map.length < N * N) { this.stats.scatter = 0; return this; }
    // Retained so the scatter can follow the city as it is built — engine.js
    // calls scatter() from buildGround/reseed, which happens BEFORE any
    // building exists, so a one-shot scatter would compute an all-zero
    // built-up field and carpet the future downtown with woodland. This is
    // exactly the failure that was shipped. See _autoRescatter().
    this._state = state;
    this._occSettle = 0;
    const occ = state.occ, bridge = state.bridge, level = state.level;
    const seed = (state.seed >>> 0) || 1;
    const S = seed & 0xffff;

    // --- pass 0: the built-up field ---------------------------------------
    // THE key signal. The gaps between downtown towers are yards and setbacks,
    // not woodland — filling them at forest density put the densest vegetation
    // in the frame exactly where the city is. `urban` is 0 in open country and
    // 1 inside a built-up neighbourhood, and every natural population below
    // scales INVERSELY with it. The city gets a separate, deliberate street-
    // tree pass instead.
    const urban = this._urbanField(state);

    // --- pass 1: plantability + terrain context ----------------------------
    // 0 = no, 1 = grass (everything), 2 = sand (rocks + sparse scrub only)
    const plant = new Uint8Array(N * N);
    const nearRoad = new Uint8Array(N * N);
    const nearRock = new Uint8Array(N * N);
    // Direction from a verge tile toward its road, so urban street trees stand
    // in the verge facing the carriageway rather than mid-lawn.
    const roadDX = new Int8Array(N * N);
    const roadDZ = new Int8Array(N * N);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const t = map[i];
        if (t !== T_GRASS && t !== T_SAND) continue;
        if (occ && occ[i] !== 0) continue;
        if (level && level[i] !== 0) continue;
        if (bridge && bridge[i]) continue;
        plant[i] = t === T_SAND ? 2 : 1;
      }
    }
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        if (!plant[i]) continue;
        let road = 0, rock = 0, rdx = 0, rdz = 0;
        for (let dz = -2; dz <= 2; dz++) {
          const zz = z + dz; if (zz < 0 || zz >= N) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= N) continue;
            const m = map[zz * N + xx];
            if (m === T_MOUNTAIN) rock = 1;
            if (m === T_ROAD && Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
              road = 1;
              // prefer a 4-neighbour over a diagonal
              if (!rdx && !rdz) { rdx = dx; rdz = dz; }
              else if ((dx === 0) !== (dz === 0)) { rdx = dx; rdz = dz; }
            }
          }
        }
        nearRoad[i] = road; nearRock[i] = rock;
        roadDX[i] = rdx; roadDZ[i] = rdz;
      }
    }

    // --- pass 2: dirt paths ------------------------------------------------
    // Walked first so the scatter can keep trunks off the tread.
    const onPath = new Uint8Array(N * N);
    this._walkPaths(plant, onPath, S, urban);

    // --- pass 3: the scatter ----------------------------------------------
    const iOak = TYPE_INDEX.oak, iPine = TYPE_INDEX.pine, iBlossom = TYPE_INDEX.blossom;
    const iShrub = TYPE_INDEX.shrub, iHedge = TYPE_INDEX.hedge, iRock = TYPE_INDEX.rock;
    // The two fbm fields depend only on the seed, and they are ~85% of scatter's
    // cost. Cache them: scatter() is no longer a once-per-reseed call (see
    // _autoRescatter), so it has to be cheap enough to re-run when the player
    // drops a building.
    const nf = this._noiseFields(S);
    const densF = nf.dens, coniF = nf.conifer;

    let count = 0, nWood = 0, nStreet = 0;
    // `pop` labels the population that produced the instance ('w' woodland,
    // 's' street/yard, 'o' other). The bake ignores it; selfTest asserts on it.
    const push = (t, x, z, y, yaw, scale, tint, rank, pop) => {
      this._raw[t].push({
        x, z, y, yaw, scale,
        r: tint[0], g: tint[1], b: tint[2], rank, pop: pop || 'o',
      });
      count++;
    };

    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const p = plant[i];
        if (!p) continue;

        const cx = (x + 0.5) * TILE, cz = (z + 0.5) * TILE;
        const urb = urban[i];
        const wild = 1 - urb;
        // Copses and clearings: a low-frequency forest field, biased away from
        // the road network so streets stay legible.
        const dens = densF[i];
        const conifer = coniF[i];

        // --- population A: WOODLAND, outside the built-up area --------------
        // Two critics measured ~70% of the region frame as bare untextured
        // green, so a copse is now denser (up to 1.82 stems per tile, from 1.63)
        // and the field that selects them is wider — but the floor between
        // copses stays low, so there are real clearings instead of the even
        // confetti a high floor produces. Then it is multiplied by
        // (1 - urban)^2.5, which takes it to zero between the towers.
        let pTree = Math.max(smooth01(0.36, 0.74, dens), 0.05);
        pTree *= wild * wild * Math.sqrt(wild);
        if (nearRoad[i]) pTree *= 0.55;
        if (onPath[i]) pTree *= 0.10;
        if (p === 2) pTree *= 0.06;                 // sand: driftwood scrub only

        // up to 3 trees per tile inside a copse
        for (let k = 0; k < 3; k++) {
          const h = hash3(x * 73856093 + S, z * 19349663 + k * 83492791, 11);
          const u = (h & 0xffff) / 65536;
          if (u > pTree * (k === 0 ? 0.92 : k === 1 ? 0.58 : 0.32)) continue;
          const jx = (((h >>> 16) & 255) / 255 - 0.5) * 5.4;
          const jz = (((h >>> 24) & 255) / 255 - 0.5) * 5.4;
          const h2 = hash3(h, k, 29);
          const kindR = (h2 & 0xffff) / 65536;
          let t = iOak;
          if (kindR < conifer * 0.80) t = iPine;
          else if (kindR > 0.93) t = iBlossom;
          // Size class, plus a small continuous wobble so no two are clones.
          // The canopy leans large (forest trees); k>0 is understorey and stays
          // small, which is what makes a copse read as layered rather than as a
          // hedge of identical lollipops.
          const su = ((h2 >>> 16) & 0xffff) / 65536;
          const sc = (k === 0 ? pickSize(su, WOOD_SIZES, WOOD_CDF)
            : pickSize(su, UNDER_SIZES, UNDER_CDF)) * (0.94 + ((h2 >>> 8) & 15) / 125);
          const tint = this._foliageTint(h2, t === iPine);
          push(t, cx + jx, cz + jz, 0, ((h2 >>> 24) & 255) / 255 * Math.PI * 2,
            sc, tint, ((h >>> 3) & 0xffff) / 65536, 'w');
          nWood++;
        }

        // --- population B: STREET / YARD TREES, inside the built-up area ----
        // One planted specimen every few lots, in the verge next to the road —
        // deliberate, not woodland. This is the ONLY tree population the city
        // core gets, and it draws from the small STREET_SIZES ladder.
        if (urb > 0.06 && p === 1 && !onPath[i]) {
          const h = hash3(x * 374761393 + S, z * 668265263, 449);
          const pSt = (nearRoad[i] ? 0.55 : 0.20) * urb;
          if ((h & 0xffff) / 65536 < pSt) {
            const h2 = hash3(h, 3, 811);
            const rdx = roadDX[i], rdz = roadDZ[i];
            // 2.6 units toward the kerb, jittered ALONG the street edge, so a
            // row of them reads as a planted avenue rather than as scatter.
            const a = (((h2 >>> 16) & 255) / 255 - 0.5) * 4.4;
            const b = (((h2 >>> 24) & 255) / 255 - 0.5) * 4.4;
            let jx, jz;
            if (rdx || rdz) { jx = rdx ? rdx * 2.6 : a; jz = rdz ? rdz * 2.6 : a; }
            else { jx = a; jz = b; }                    // mid-yard specimen
            const kindR = (h2 & 0xffff) / 65536;
            const t = kindR > 0.76 ? iBlossom : iOak;
            const sc = pickSize(((h2 >>> 8) & 0xffff) / 65536, STREET_SIZES, STREET_CDF) *
              (0.95 + ((h2 >>> 4) & 15) / 150);
            push(t, cx + jx, cz + jz, 0, ((h2 >>> 24) & 255) / 255 * Math.PI * 2,
              sc, this._foliageTint(h2, false), ((h >>> 3) & 0xffff) / 65536, 's');
            nStreet++;
          }
        }

        // shrubs — fill the clearings the trees left, plus verges
        {
          const h = hash3(x * 40503 + S, z * 51787, 137);
          const u = (h & 0xffff) / 65536;
          // Yard shrubs survive downtown (they are knee-high, they read as
          // planting rather than forest) but at a third of the country rate.
          const pSh = (0.10 + 0.34 * (1 - Math.abs(dens - 0.42) * 2)) * (p === 2 ? 0.35 : 1) *
            (onPath[i] ? 0.15 : 1) * (1 - 0.66 * urb);
          if (u < clamp(pSh, 0, 0.55)) {
            const jx = (((h >>> 16) & 255) / 255 - 0.5) * 5.6;
            const jz = (((h >>> 24) & 255) / 255 - 0.5) * 5.6;
            const h2 = hash3(h, 5, 71);
            push(iShrub, cx + jx, cz + jz, 0, (h2 & 255) / 255 * Math.PI * 2,
              0.65 + ((h2 >>> 8) & 255) / 255 * 0.70,
              this._foliageTint(h2, false), ((h >>> 7) & 0xffff) / 65536);
          }
        }

        // Hedges — a tidy planted line where a garden meets the street or the
        // neighbouring plot. Laid ALONG the shared edge, ~1.4 units in.
        if (p === 1) {
          const h = hash3(x * 92837111 + S, z * 689287499, 211);
          // "boundary" = the street, or a neighbouring building's plot
          const bound = (j) => j >= 0 && j < N * N && (map[j] === T_ROAD || (occ && occ[j] !== 0));
          // The hedge geometry is long in LOCAL X. A boundary to the EAST/WEST
          // means the shared edge runs along Z, so the hedge must be turned 90
          // degrees to lie ALONG it — getting this backwards laid every hedge
          // across the pavement and out into the carriageway.
          let yaw = null, ox = 0, oz = 0;
          if (x > 0 && bound(i - 1)) { yaw = Math.PI / 2; ox = -2.2; }
          else if (x < N - 1 && bound(i + 1)) { yaw = Math.PI / 2; ox = 2.2; }
          else if (z > 0 && bound(i - N)) { yaw = 0; oz = -2.2; }
          else if (z < N - 1 && bound(i + N)) { yaw = 0; oz = 2.2; }
          if (yaw !== null && (h & 0xffff) / 65536 < 0.22 && !onPath[i]) {
            push(iHedge, cx + ox, cz + oz, 0, yaw,
              0.86 + ((h >>> 16) & 255) / 255 * 0.34,
              this._foliageTint(h, false), ((h >>> 11) & 0xffff) / 65536);
          }
        }

        // rocks — scree near the mountains, glacial erratics elsewhere
        {
          const h = hash3(x * 2654435761 + S, z * 40503, 307);
          const u = (h & 0xffff) / 65536;
          const pR = (nearRock[i] ? 0.34 : 0.030) * (p === 2 ? 1.7 : 1) * (1 - 0.92 * urb);
          if (u < pR) {
            const jx = (((h >>> 16) & 255) / 255 - 0.5) * 6.0;
            const jz = (((h >>> 24) & 255) / 255 - 0.5) * 6.0;
            const h2 = hash3(h, 9, 401);
            const g = 0.86 + ((h2 >>> 8) & 255) / 255 * 0.26;
            push(iRock, cx + jx, cz + jz, 0, (h2 & 255) / 255 * Math.PI * 2,
              0.55 + ((h2 >>> 16) & 255) / 255 * 1.05,
              [g, g * 0.99, g * 0.96], ((h >>> 9) & 0xffff) / 65536);
          }
        }
      }
    }

    this.stats.scatter = count;
    this.stats.woodTrees = nWood;
    this.stats.streetTrees = nStreet;
    this.stats.scatterMs = now() - t0;
    this._occSig = this._occSignature(state);
    this._visDirty = true;
    return this;
  }

  /** Cheap change detector over the building footprint grid. */
  _occSignature(state) {
    const occ = state && state.occ;
    if (!occ) return 0;
    let h = 0x811c9dc5, n = 0;
    for (let i = 0; i < N * N; i++) {
      if (occ[i] !== 0) { n++; h = (Math.imul(h ^ i, 0x01000193)) >>> 0; }
    }
    return (h ^ Math.imul(n, 0x9e3779b1)) >>> 0;
  }

  /**
   * Follow the city. engine.js only calls scatter() on a ground rebuild, so
   * without this the built-up field is whatever it was at world-gen (empty),
   * and every building the player places lands in a forest that never clears.
   * Polled, debounced, and cheap enough that a placement burst costs one
   * re-scatter, not one per building. `opts.autoRescatter: false` opts out.
   */
  _autoRescatter(dt) {
    if (!this._state || this.opts.autoRescatter === false) return;
    if (this._occSettle > 0) {
      this._occSettle -= dt;
      if (this._occSettle <= 0) this.scatter(this._state);
      return;
    }
    if ((++this._occPoll % 12) !== 0) return;
    if (this._occSignature(this._state) !== this._occSig) this._occSettle = 0.45;
  }

  /** Per-tile copse-density and conifer-mix fbm, cached by seed. */
  _noiseFields(S) {
    if (this._nf && this._nf.S === S) return this._nf;
    const dens = new Float32Array(N * N);
    const conifer = new Float32Array(N * N);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        dens[i] = fbm((x + S * 0.37) / 9.5, (z + S * 0.29) / 9.5, 5) * 1.12;
        conifer[i] = fbm((x + S * 0.11) / 15, (z + S * 0.53) / 15, 61);
      }
    }
    this._nf = { S, dens, conifer };
    return this._nf;
  }

  /**
   * "How built-up is this neighbourhood?" — 0 open country .. 1 city core, one
   * value per tile, from the fraction of tiles carrying a building footprint
   * inside a URBAN_R window. Summed-area table, so it is O(N^2) regardless of
   * the radius (a naive 9x9 box scan is 6400 * 81 = 518k samples per rebuild,
   * and scatter() runs on every reseed).
   */
  _urbanField(state) {
    const occ = state && state.occ;
    const f = new Float32Array(N * N);
    if (!occ) return f;
    const n1 = N + 1;
    const sat = new Int32Array(n1 * n1);
    for (let z = 0; z < N; z++) {
      let row = 0;
      for (let x = 0; x < N; x++) {
        if (occ[z * N + x] !== 0) row++;
        sat[(z + 1) * n1 + (x + 1)] = sat[z * n1 + (x + 1)] + row;
      }
    }
    for (let z = 0; z < N; z++) {
      const z0 = Math.max(0, z - URBAN_R), z1 = Math.min(N - 1, z + URBAN_R);
      for (let x = 0; x < N; x++) {
        const x0 = Math.max(0, x - URBAN_R), x1 = Math.min(N - 1, x + URBAN_R);
        const s = sat[(z1 + 1) * n1 + (x1 + 1)] - sat[z0 * n1 + (x1 + 1)]
          - sat[(z1 + 1) * n1 + x0] + sat[z0 * n1 + x0];
        f[z * N + x] = smooth01(URBAN_LO, URBAN_HI, s / ((z1 - z0 + 1) * (x1 - x0 + 1)));
      }
    }
    return f;
  }

  _foliageTint(h, conifer) {
    const a = ((h >>> 4) & 255) / 255, b = ((h >>> 12) & 255) / 255;
    const warm = conifer ? 0.90 : 1.0;
    return [
      (0.86 + a * 0.26) * warm,
      0.90 + b * 0.22,
      (0.84 + a * 0.20) * (conifer ? 0.98 : 1.0),
    ];
  }

  /** Random-walk a few footpaths through the deepest scatter and lay patches. */
  _walkPaths(plant, onPath, S, urban) {
    const t = TYPE_INDEX.path;
    const walks = 4 + (S % 4);
    // A worn dirt desire-line through a downtown block is nonsense; paths are a
    // countryside/park feature, so both the seed and the walk stay out of town.
    const open = (j) => plant[j] && (!urban || urban[j] < 0.35);
    for (let w = 0; w < walks; w++) {
      // deterministic start: first plantable tile at/after a hashed index
      let idx = hash3(S, w, 613) % (N * N);
      let tries = 0;
      while (!open(idx) && tries++ < N * N) idx = (idx + 7919) % (N * N);
      if (!open(idx)) continue;

      let tx = idx % N, tz = (idx / N) | 0;
      let ang = rnd(S, w, 17) * Math.PI * 2;
      const steps = 26 + (hash3(S, w, 23) % 42);
      let px = (tx + 0.5) * TILE, pz = (tz + 0.5) * TILE;

      for (let s = 0; s < steps; s++) {
        ang += (vnoise(s * 0.35, w * 5.5 + S * 0.01, 331) - 0.5) * 1.15;
        const nx = px + Math.sin(ang) * 3.1;
        const nz = pz + Math.cos(ang) * 3.1;
        const ntx = Math.floor(nx / TILE), ntz = Math.floor(nz / TILE);
        if (ntx < 0 || ntz < 0 || ntx >= N || ntz >= N || !open(ntz * N + ntx)) {
          ang += 2.1;                       // bounce off water / road / buildings
          continue;
        }
        px = nx; pz = nz; tx = ntx; tz = ntz;
        onPath[tz * N + tx] = 1;
        const h = hash3(Math.round(px), Math.round(pz), 977 + w);
        // Patches overlap heavily so they read as one tread, not confetti.
        const ci = (h & 3) === 0 ? 0.88 : (h & 3) === 1 ? 1.0 : 0.94;
        this._raw[t].push({
          x: px + (((h >>> 8) & 255) / 255 - 0.5) * 1.6,
          z: pz + (((h >>> 16) & 255) / 255 - 0.5) * 1.6,
          y: 0, yaw: ((h >>> 24) & 255) / 255 * Math.PI * 2,
          scale: 0.75 + ((h >>> 5) & 127) / 127 * 0.55,
          r: ci, g: ci * 0.97, b: ci * 0.9,
          rank: ((h >>> 2) & 0xffff) / 65536,
        });
      }
    }
    this._dirty[t] = 1;
  }

  // -- baking ---------------------------------------------------------------

  _bakeDirty() {
    let any = false;
    for (let t = 0; t < NT; t++) if (this._dirty[t]) { any = true; break; }
    if (!any) return;
    const t0 = now();

    for (let t = 0; t < NT; t++) {
      if (!this._dirty[t]) continue;
      this._dirty[t] = 0;
      for (let c = 0; c < NCHUNK; c++) this._runs[c * NT + t] = null;

      const raw = this._raw[t];
      if (raw.length === 0) { this._ensureMeshes(t, 0); continue; }

      // bucket by chunk
      const buckets = new Map();
      for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        const cx = clamp(Math.floor(p.x / CHUNK_W), 0, CHUNKS - 1);
        const cz = clamp(Math.floor(p.z / CHUNK_W), 0, CHUNKS - 1);
        const c = cz * CHUNKS + cx;
        let arr = buckets.get(c);
        if (!arr) { arr = []; buckets.set(c, arr); }
        arr.push(p);
      }

      const def = TYPES[t];
      const fadeEnd = def.cull;
      const fadeStart = def.fade > 0 ? def.cull - def.fade : def.cull;

      for (const [c, arr] of buckets) {
        // Rank-sort so a density cut is a truncation, not a reshuffle.
        arr.sort((a, b) => a.rank - b.rank);
        const n = arr.length;
        const mat = new Float32Array(n * 16);
        const par = new Float32Array(n * 4);
        const col = new Float32Array(n * 3);
        const m = this._m, q = this._q, v = this._v, s = this._s;
        for (let i = 0; i < n; i++) {
          const p = arr[i];
          q.set(0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2));
          v.set(p.x, p.y || 0, p.z);
          s.set(p.scale, p.scale, p.scale);
          m.compose(v, q, s);
          m.toArray(mat, i * 16);
          par[i * 4] = def.sway;
          par[i * 4 + 1] = p.rank * 62.8;
          par[i * 4 + 2] = fadeStart;
          par[i * 4 + 3] = fadeEnd;
          col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
        }
        this._runs[c * NT + t] = { mat, par, col, n };
      }
      this._ensureMeshes(t, raw.length);
    }

    let total = 0;
    for (let t = 0; t < NT; t++) total += this._raw[t].length;
    this.stats.instances = total;
    this.stats.bakeMs = now() - t0;
    this._visDirty = true;
  }

  /** Allocate (or grow) the two LOD meshes for a type to hold `cap` instances. */
  _ensureMeshes(t, cap) {
    const def = TYPES[t];
    for (let lod = 0; lod < 2; lod++) {
      const geo = this._geomFor(t, lod);
      const slot = t * 2 + lod;
      if (!geo || cap === 0) {
        if (this._meshes[slot]) this._meshes[slot].count = 0;
        continue;
      }
      const have = this._meshes[slot];
      if (have && this._caps[slot] >= cap) continue;
      if (have) { this.scene.remove(have); this._disposeInstanceAttrs(have); }
      const c = Math.max(32, 1 << Math.ceil(Math.log2(cap)));
      const mesh = new THREE.InstancedMesh(geo, this.material, c);
      mesh.name = 'props:' + def.key + ':L' + lod;
      mesh.frustumCulled = false;         // we cull per chunk ourselves
      mesh.castShadow = def.key !== 'path';
      mesh.receiveShadow = true;          // irrelevant to CSM, harmless
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(c * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const par = new THREE.InstancedBufferAttribute(new Float32Array(c * 4), 4);
      par.setUsage(THREE.DynamicDrawUsage);
      // Per-geometry attribute; the geometry is shared between the two LOD
      // meshes of DIFFERENT types only by key, so this is safe — but a geometry
      // is never shared across meshes here, by construction.
      mesh.geometry.setAttribute('aPropParam', par);
      mesh.count = 0;
      mesh.userData.par = par;
      this._meshes[slot] = mesh;
      this._caps[slot] = c;
      this.scene.add(mesh);
    }
  }

  _disposeInstanceAttrs(mesh) {
    if (mesh.instanceColor) mesh.instanceColor = null;
    if (mesh.dispose) mesh.dispose();
  }

  // -- per-frame visibility -------------------------------------------------

  _densityFor(def, d) {
    let base = this._density;
    if (def.group === 'furn') return base;
    // Thin the canopy with distance. Gentler than the first pass (0.45 from
    // 150 units) because the far LOD is 60 triangles and the `region` shot is
    // exactly where woodland must still read as woodland — the countryside is
    // not what was over-planted.
    return base * (1 - 0.32 * smooth01(210, 500, d));
  }

  _refreshVisible(camera) {
    const t0 = now();
    // Do NOT trust camera.matrixWorldInverse: engine.js positions the camera and
    // then calls us BEFORE the first renderer.render() of the frame, so on the
    // frame a shot is posed the inverse is still one frame old — which culls the
    // wrong chunks for exactly the frame a screenshot is taken on.
    camera.updateMatrixWorld();
    this._camInv.copy(camera.matrixWorld).invert();
    this._projScreen.multiplyMatrices(camera.projectionMatrix, this._camInv);
    this._frustum.setFromProjectionMatrix(this._projScreen);
    const cam = camera.position;

    const w = new Int32Array(NT * 2);
    for (let c = 0; c < NCHUNK; c++) {
      if (!this._frustum.intersectsBox(this._chunkBox[c])) continue;
      const d = cam.distanceTo(this._chunkCentre[c]);
      const base = c * NT;
      for (let t = 0; t < NT; t++) {
        const run = this._runs[base + t];
        if (!run) continue;
        const def = TYPES[t];
        if (d > def.cull) continue;
        let lod = d > def.lod1 ? 1 : 0;
        if (lod === 1 && !this._geomFor(t, 1)) lod = 0;
        const slot = t * 2 + lod;
        const mesh = this._meshes[slot];
        if (!mesh) continue;
        const dens = this._densityFor(def, d);
        let n = dens >= 1 ? run.n : Math.ceil(run.n * dens);
        if (n <= 0) continue;
        const cap = this._caps[slot];
        const off = w[slot];
        if (off + n > cap) n = cap - off;
        if (n <= 0) continue;
        mesh.instanceMatrix.array.set(run.mat.subarray(0, n * 16), off * 16);
        mesh.instanceColor.array.set(run.col.subarray(0, n * 3), off * 3);
        mesh.userData.par.array.set(run.par.subarray(0, n * 4), off * 4);
        w[slot] = off + n;
      }
    }

    let drawn = 0, meshes = 0, tris = 0;
    for (let slot = 0; slot < NT * 2; slot++) {
      const mesh = this._meshes[slot];
      if (!mesh) continue;
      const n = w[slot];
      if (n === 0 && mesh.count === 0) continue;
      mesh.count = n;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        mesh.userData.par.needsUpdate = true;
        drawn += n; meshes++;
        const idx = mesh.geometry.getIndex();
        tris += (idx ? idx.count / 3 : 0) * n;
      }
    }
    this.stats.drawn = drawn;
    this.stats.meshes = meshes;
    this.stats.tris = tris | 0;
    this.stats.refreshMs = now() - t0;
    this._visDirty = false;
    this._frameSinceRefresh = 0;
    this._lastCamPos.copy(cam);
    this._lastCamQ.copy(camera.quaternion);
  }

  // -- public: frame --------------------------------------------------------

  update(dt, ctx) {
    dt = dt || 0;
    ctx = ctx || {};
    if (ctx.quality != null && (ctx.quality | 0) !== this._quality) this.setQuality(ctx.quality | 0);

    this._autoRescatter(dt);
    this._bakeDirty();

    // Wind: a slow gust envelope, stiffer in rain (wet foliage) and stilled in snow.
    const rain = (ctx.weather && ctx.weather.rain) || 0;
    const snow = (ctx.weather && ctx.weather.snow) || 0;
    this._time += dt * (1.15 + rain * 0.9);
    const gust = 0.72 + 0.34 * Math.sin(this._time * 0.19) + 0.16 * Math.sin(this._time * 0.51 + 1.9);
    this.uniforms.uPropTime.value = this._time;
    this.uniforms.uPropWind.value = this._wind * gust * (1 + rain * 0.55) * (1 - snow * 0.35);

    if (!this.opts.uniforms || !this.opts.uniforms.uNight) {
      const nightT = ctx.nightEff != null ? ctx.nightEff : (ctx.nightT != null ? ctx.nightT : 0);
      this.uniforms.uPropNight.value = nightT;
    }

    const camera = ctx.camera;
    if (camera) {
      this.uniforms.uPropCam.value.copy(camera.position);
      this._frameSinceRefresh++;
      const moved = this._lastCamPos.distanceToSquared(camera.position) > 2.25;
      const turned = Math.abs(this._lastCamQ.dot(camera.quaternion)) < 0.99995;
      if (this._visDirty || moved || turned || this._frameSinceRefresh > 30) {
        this._refreshVisible(camera);
      }
    }
  }

  setQuality(level) {
    const q = clamp(level | 0, 0, 2);
    this._quality = q;
    this._density = (q === 0 ? 0.40 : q === 1 ? 0.72 : 1.0) * this._userDensity;
    // At low quality vegetation stays out of the cascade passes entirely; the
    // street furniture is small enough that its casters are close to free.
    for (let t = 0; t < NT; t++) {
      const def = TYPES[t];
      for (let lod = 0; lod < 2; lod++) {
        const m = this._meshes[t * 2 + lod];
        if (!m) continue;
        m.castShadow = def.key !== 'path' && !(q === 0 && def.group === 'veg');
      }
    }
    this._visDirty = true;
    return this;
  }

  getQuality() { return this._quality; }
  getStats() { return this.stats; }

  /** World Y of the lamp bulb voxel — hand this to lighting as `bulbY`. */
  get lampBulbY() { return LAMP_BULB_Y; }

  dispose() {
    for (let slot = 0; slot < NT * 2; slot++) {
      const m = this._meshes[slot];
      if (!m) continue;
      this.scene.remove(m);
      if (m.dispose) m.dispose();
      this._meshes[slot] = null;
    }
    for (const k in this._geoms) if (this._geoms[k]) this._geoms[k].dispose();
    this._geoms = {};
    if (this.material) this.material.dispose();
    this._runs.length = 0;
    for (let t = 0; t < NT; t++) this._raw[t] = [];
  }
}

const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now() : () => Date.now();

// ---------------------------------------------------------------------------
// Self-test (CONTRACTS-RENDER.md §4)
// ---------------------------------------------------------------------------

export function selfTest(renderer) {
  const notes = [];
  let pass = true;
  const ok = (m) => notes.push('ok: ' + m);
  const fail = (m) => { pass = false; notes.push('FAIL: ' + m); };

  let scene = null, props = null;
  try {
    scene = new THREE.Scene();
    props = new Props(scene, { quality: 2 });

    // --- 1. geometry contract ---------------------------------------------
    const REQ = ['position', 'normal', 'color', 'glowColor', 'emissiveT', 'aoT', 'matParams'];
    let geoms = 0, tris = 0, bad = 0, nan = 0;
    for (const k in props._geoms) {
      const g = props._geoms[k];
      if (!g) continue;
      geoms++;
      for (const a of REQ) if (!g.attributes[a]) { bad++; fail(k + ' missing attribute ' + a); }
      const p = g.attributes.position;
      if (p) for (let i = 0; i < p.array.length; i++) if (!isFinite(p.array[i])) { nan++; break; }
      const idx = g.getIndex();
      tris += idx ? idx.count / 3 : 0;
    }
    if (!bad) ok(geoms + ' prop geometries, all with the voxel.js attribute set');
    if (nan) fail(nan + ' geometries contain non-finite positions');
    else ok('no NaN/Inf in any prop position buffer');
    ok('total unique prop triangles (all LODs, one copy each): ' + tris);
    if (tris > 4000) fail('prop geometry library is too heavy: ' + tris + ' tris');

    // --- 2. lamp lines up with lighting.js's pool -------------------------
    const dy = Math.abs(LAMP_BULB_Y - 4.2);
    if (dy < 0.35) ok('lamp bulb at y=' + LAMP_BULB_Y.toFixed(2) + ', lighting.js pool at 4.20 (dy ' + dy.toFixed(2) + ')');
    else fail('lamp bulb y=' + LAMP_BULB_Y.toFixed(2) + ' does not line up with the light pool at 4.20');

    // --- 3. anchors -------------------------------------------------------
    const kinds = ['lamp', 'trafficlight', 'sign_stop', 'hydrant', 'bin', 'bench'];
    const anchors = [];
    for (let i = 0; i < 600; i++) {
      anchors.push({
        x: (i * 37) % MAP_W, z: (i * 53) % MAP_W,
        yaw: (i % 8) * Math.PI / 4, kind: kinds[i % kinds.length],
      });
    }
    anchors.push({ x: 10, z: 10, yaw: 0, kind: 'not_a_prop' });   // must be ignored
    props.setAnchors(anchors);
    props._bakeDirty();
    if (props.stats.anchors === 600) ok('600 anchors consumed, unknown kinds ignored');
    else fail('anchor intake wrong: ' + props.stats.anchors);

    // --- 4. scatter respects the map --------------------------------------
    const state = fakeState(20240601);
    props.scatter(state);
    props._bakeDirty();
    if (props.stats.scatter > 400) ok(props.stats.scatter + ' natural props scattered');
    else fail('scatter produced only ' + props.stats.scatter + ' props');

    let offLimits = 0, outOfBounds = 0;
    for (let t = 0; t < NT; t++) {
      if (TYPES[t].group !== 'veg') continue;
      for (const p of props._raw[t]) {
        if (p.x < 0 || p.z < 0 || p.x > MAP_W || p.z > MAP_W) { outOfBounds++; continue; }
        const tx = clamp(Math.floor(p.x / TILE), 0, N - 1);
        const tz = clamp(Math.floor(p.z / TILE), 0, N - 1);
        const m = state.map[tz * N + tx];
        if (m === T_WATER || m === T_ROAD || m === T_MOUNTAIN || m === T_TREE) offLimits++;
        if (state.occ[tz * N + tx] !== 0) offLimits++;
      }
    }
    if (outOfBounds) fail(outOfBounds + ' scattered props outside the 640x640 map');
    else ok('every scattered prop is inside the map');
    // A prop's canopy may lean over a neighbouring tile; the anchor may not.
    // Tolerance covers only the jitter that lands a stem on a boundary tile.
    const frac = offLimits / Math.max(1, props.stats.scatter);
    if (frac < 0.02) ok('scatter avoids water/road/mountain/TREE/buildings (' + offLimits + ' strays, ' + (frac * 100).toFixed(2) + '%)');
    else fail((frac * 100).toFixed(1) + '% of scattered props landed on water/road/mountain/building tiles');

    // --- 4a. canopy SIZE ---------------------------------------------------
    // A street tree must read as clearly smaller than a one-storey house
    // (models.js's smallest is 7 x 5 x 7 world units).
    {
      const g = props._geoms.oak0;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const mw = bb.max.x - bb.min.x, mh = bb.max.y - bb.min.y;
      const say = (n, s) => n + ' ' + (mw * s).toFixed(2) + ' x ' + (mh * s).toFixed(2);
      ok('oak canopy w x h — ' + say('street median', STREET_SIZES[2]) + ', ' +
        say('street max', STREET_SIZES[STREET_SIZES.length - 1]) + ', ' +
        say('wood median', WOOD_SIZES[2]) + ', ' +
        say('wood max', WOOD_SIZES[WOOD_SIZES.length - 1]) + ' (a house is 7 x 5)');
      const sw = mw * STREET_SIZES[STREET_SIZES.length - 1];
      const sh = mh * STREET_SIZES[STREET_SIZES.length - 1];
      if (sw < 3.2 && sh < 5.4) ok('the largest STREET tree is smaller than a one-storey house');
      else fail('street trees are still building-sized: ' + sw.toFixed(2) + ' x ' + sh.toFixed(2));
      const ww = mw * WOOD_SIZES[WOOD_SIZES.length - 1];
      if (ww < 4.8) ok('the largest WOODLAND canopy is ' + ww.toFixed(2) + ' units (was 6.7)');
      else fail('woodland canopy still ' + ww.toFixed(2) + ' units across');
      const sizes = new Set();
      for (const p of props._raw[TYPE_INDEX.oak]) sizes.add(Math.round(p.scale * 25));
      if (sizes.size >= 6) ok('scattered oaks span ' + sizes.size + ' distinct size buckets (saplings..mature)');
      else fail('only ' + sizes.size + ' oak size buckets — no real size variation');
    }

    // --- 4b. density is INVERSE to how built-up the neighbourhood is -------
    // The honest test is a counterfactual: take the SAME tiles and scatter them
    // once with the city standing and once with the buildings deleted. If the
    // built-up field is doing its job the first is a small fraction of the
    // second — the tiles are yards and setbacks, not woodland.
    {
      const uf = props._urbanField(state);
      const bare = fakeState(20240601);
      bare.occ = new Int32Array(N * N);
      bare.level = new Uint8Array(N * N);
      const p3 = new Props(new THREE.Scene(), { quality: 2 });
      p3.scatter(bare);

      const roi = new Uint8Array(N * N);
      let roiTiles = 0;
      for (let i = 0; i < N * N; i++) {
        const m = state.map[i];
        if ((m === T_GRASS || m === T_SAND) && state.occ[i] === 0 && uf[i] > 0.6) {
          roi[i] = 1; roiTiles++;
        }
      }
      const countIn = (P, pop) => {
        let n = 0;
        for (const key of ['oak', 'pine', 'blossom']) {
          for (const p of P._raw[TYPE_INDEX[key]]) {
            if (pop && p.pop !== pop) continue;
            const tx = clamp(Math.floor(p.x / TILE), 0, N - 1);
            const tz = clamp(Math.floor(p.z / TILE), 0, N - 1);
            if (roi[tz * N + tx]) n++;
          }
        }
        return n;
      };
      const withCity = countIn(props), noCity = countIn(p3);
      const cityWood = countIn(props, 'w'), cityStreet = countIn(props, 's');
      p3.dispose();
      ok('same ' + roiTiles + ' built-up tiles: ' + withCity + ' trees with the city standing (' +
        (withCity / roiTiles).toFixed(2) + '/tile) vs ' + noCity + ' with the buildings deleted (' +
        (noCity / roiTiles).toFixed(2) + '/tile)');
      ok('of those ' + withCity + ': ' + cityStreet + ' deliberate street/yard trees, ' + cityWood + ' woodland');
      if (noCity > withCity * 1.7) ok('vegetation density scales inversely with the built-up field');
      else fail('the built-up area is still planted like open country (' + withCity + ' vs ' + noCity + ')');
      if (cityWood <= Math.max(2, withCity * 0.06)) ok('woodland scatter is suppressed to ~zero inside the city');
      else fail(cityWood + ' woodland trees still growing between the buildings');
      if (cityStreet > roiTiles * 0.05) ok('the built-up area still gets deliberate street trees');
      else fail('the built-up area has no street trees at all (' + cityStreet + ')');
    }

    // --- 5. determinism ---------------------------------------------------
    const p2 = new Props(new THREE.Scene(), { quality: 2 });
    p2.scatter(fakeState(20240601));
    let same = p2.stats.scatter === props.stats.scatter;
    if (same) {
      outer: for (let t = 0; t < NT; t++) {
        if (TYPES[t].group !== 'veg') continue;   // p2 was never given anchors
        const a = props._raw[t], b = p2._raw[t];
        if (a.length !== b.length) { same = false; break; }
        for (let i = 0; i < a.length; i++) {
          if (Math.abs(a[i].x - b[i].x) > 1e-6 || Math.abs(a[i].z - b[i].z) > 1e-6) { same = false; break outer; }
        }
      }
    }
    if (same) ok('scatter is byte-stable for a given seed');
    else fail('scatter is not deterministic for a fixed seed');
    p2.dispose();

    // --- 6. draw-call budget + culling ------------------------------------
    const cam = new THREE.PerspectiveCamera(40, 16 / 9, 1, 2000);
    const probe = (dist, polar) => {
      cam.position.set(320 + Math.sin(0.8) * dist * Math.sin(polar), dist * Math.cos(polar),
        320 + Math.cos(0.8) * dist * Math.sin(polar));
      cam.lookAt(320, 0, 320);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      props._refreshVisible(cam);
      return { meshes: props.stats.meshes, drawn: props.stats.drawn, tris: props.stats.tris };
    };
    const region = probe(340, 0.72);
    const street = probe(62, 1.12);
    ok('region (dist 340): ' + region.meshes + ' draws, ' + region.drawn + ' instances, ' + region.tris + ' tris');
    ok('street (dist 62): ' + street.meshes + ' draws, ' + street.drawn + ' instances, ' + street.tris + ' tris');
    if (region.meshes <= 20 && street.meshes <= 20) ok('draw calls stay under 20 at both extremes');
    else fail('draw call budget blown: region ' + region.meshes + ', street ' + street.meshes);
    if (street.drawn < region.drawn) ok('frustum culling is doing work (street draws fewer instances than region)');
    else fail('frustum culling appears inert: street ' + street.drawn + ' vs region ' + region.drawn);

    // --- 7. quality cycling does not leak ---------------------------------
    const before = countMeshes(scene);
    for (let i = 0; i < 100; i++) props.setQuality(i % 3);
    props.setQuality(2);
    props._refreshVisible(cam);
    const after = countMeshes(scene);
    if (after === before) ok('100 quality cycles leak no meshes (' + after + ' in scene)');
    else fail('quality cycling leaked meshes: ' + before + ' -> ' + after);

    // --- 8. shader compiles -----------------------------------------------
    if (renderer) {
      try {
        const s2 = new THREE.Scene();
        s2.add(new THREE.AmbientLight(0xffffff, 1));
        const dl = new THREE.DirectionalLight(0xffffff, 1); dl.position.set(1, 2, 1); s2.add(dl);
        const m = props._meshes[TYPE_INDEX.oak * 2];
        if (m) {
          const clone = new THREE.InstancedMesh(m.geometry, props.material, 1);
          clone.setMatrixAt(0, new THREE.Matrix4());
          clone.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
          s2.add(clone);
        }
        renderer.compile(s2, cam);
        const src = props.material.userData.shader;
        if (!src) fail('material never compiled (no userData.shader)');
        else {
          const v = src.vertexShader, f = src.fragmentShader;
          if (/aPropParam/.test(v) && /uPropWind/.test(v)) ok('vertex shader carries the sway/LOD injection');
          else fail('vertex injection missing from the compiled shader');
          if (/#include <lights_fragment_begin>/.test(f) || /csm/.test(f)) ok('lights_fragment_begin survives our injection (patchMaterial can compose)');
          else fail('lights_fragment_begin was destroyed — shadows would silently vanish');
          if (/vPropGlow/.test(f)) ok('fragment shader carries the night-glow injection');
          else fail('fragment injection missing');
        }
      } catch (e) {
        fail('shader compile threw: ' + (e && e.message ? e.message : e));
      }
    } else {
      notes.push('note: no renderer supplied — shader compile assertions skipped');
    }
  } catch (e) {
    fail('threw: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    try { if (props) props.dispose(); } catch (e) { /* ignore */ }
  }

  return { pass, notes };
}

function countMeshes(scene) {
  let n = 0;
  scene.traverse((o) => { if (o.isInstancedMesh) n++; });
  return n;
}

/** A plausible map for the self-test: ocean, a road grid, mountains, buildings. */
function fakeState(seed) {
  const map = new Uint8Array(N * N);
  const occ = new Int32Array(N * N);
  const bridge = new Uint8Array(N * N);
  const level = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      let t = T_GRASS;
      if (x < 7 + Math.round(Math.sin(z * 0.3) * 2)) t = T_WATER;
      else if (x < 10 + Math.round(Math.sin(z * 0.3) * 2)) t = T_SAND;
      else if (x > 66 && z > 60) t = T_MOUNTAIN;
      else if ((x % 6 === 0 || z % 7 === 0) && x > 14 && x < 62 && z > 8 && z < 62) t = T_ROAD;
      else if (rnd(x, z, seed) < 0.05) t = T_TREE;
      map[i] = t;
      if (t === T_GRASS && x > 20 && x < 44 && z > 20 && z < 44 && rnd(x, z, seed + 3) < 0.35) {
        occ[i] = 1; level[i] = 1;
      }
    }
  }
  return { map, occ, bridge, level, seed };
}

export default Props;
