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
import { vegModel, vegFarBoxes } from '../models/vegetation.js';
import { cityBlockMask, parcelPlan, skirtLandY, lawnMask, lawnPark, LZ_GROVE, LZ_CLEAR, LZ_PICNIC, LOT_TOP } from './terrain.js';

// ---------------------------------------------------------------------------
// World facts
// ---------------------------------------------------------------------------

const TILE = 8;
const N = 80;
const MAP_W = N * TILE;               // 640

const T_GRASS = 0, T_WATER = 1, T_SAND = 2, T_ROAD = 3, T_TREE = 8, T_MOUNTAIN = 15;

// Top of the kerb — roads.js yOffset (0.02) + CURB_H (0.30, roads r13).
const PROP_Y = 0.32;

// lighting.js parks the lamp's glow billboard at bulbY, default anchor.y + 4.2.
// FURN_SCALE is chosen so the bulb VOXEL centre lands there:
//   PROP_Y + (8 + 0.5) * 0.48 = 0.17 + 4.08 = 4.25.  Within a sixth of the
// billboard's radius, i.e. the post and the pool are the same light source.
const FURN_SCALE = 0.48;
// Round 9 (roads r8 critic: lamps were "grey slab pillars as tall as a
// two-storey house on a black cube base"): the street lamp is now a slim
// world-unit box model (lampBoxes below), ~2.3 tall. Its warm head sits at
// LAMP_HEAD_Y above the kerb top; roads.js puts the matching `bulbY` on every
// lamp anchor, so lighting.js's glow lands on the head.
const LAMP_HEAD_Y = 2.12;
const LAMP_BULB_Y = PROP_Y + LAMP_HEAD_Y;

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
// KERB row (ground r3): the planted row along every open-country kerb, ref05's
// bottom edge. Near-uniform mature stock — a row of mixed saplings reads as
// scatter again.
const KERB_SIZES = [0.52, 0.58, 0.64];
const KERB_CDF = [0.30, 0.75, 1.00];
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
const OFF_BAND = 22;                  // ground r8: tiles of off-map countryside scattered round the map

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

// Street lamp, in WORLD units (not voxels): a voxel is 0.48 at FURN_SCALE, so a
// one-voxel mast was already a fat 0.48 slab. ref05's street furniture is slim:
// a thin light-grey pole (0.16), a thinner light arm reaching over the kerb
// (+Z), and a warm lamp head (palette 202, emissive at night) under a light cap.
// No foot block at all (the old dark foot read as "a black cube base").
function lampBoxes() {
  const P = PI.concrete, A = PI.concrete, H = LAMP_HEAD_Y;
  return [
    box(-0.08, 0.00, -0.08, 0.08, H + 0.16, 0.08, P),      // pole
    box(-0.05, H + 0.07, 0.00, 0.05, H + 0.16, 0.56, A),   // arm
    box(-0.13, H - 0.06, 0.40, 0.13, H + 0.08, 0.80, 202), // warm head
    box(-0.14, H + 0.08, 0.38, 0.14, H + 0.14, 0.82, A),   // cap
  ];
}

// Round 14 (roads piece): traffic signal in WORLD units, like the lamp. The
// voxel signal (0.48 posts, 4.6 tall) read as "big black hooks" at iso zoom,
// so roads.js placed none; this one is slim: a 0.14 dark pole on a corner
// island, a thin mast arm reaching ARM_L over the approach lane along local
// +Z, and a black head with a yellow backboard whose red / amber / green
// lenses face local -X (roads.js yaws it so they face that arm's traffic).
function trafficBoxes() {
  const D = PI.darkGray, K = PI.black, L = 1.9;
  return [
    box(-0.07, 0.00, -0.07, 0.07, 2.76, 0.07, D),              // pole
    box(-0.045, 2.62, 0.00, 0.045, 2.71, L, D),                // mast arm
    box(-0.09, 1.98, L - 0.26, 0.10, 2.62, L - 0.02, K),       // head
    box(0.10, 1.94, L - 0.31, 0.13, 2.66, L + 0.03, PI.yellow), // backboard
    box(-0.13, 2.41, L - 0.20, -0.09, 2.55, L - 0.08, PI.fireRed),
    box(-0.13, 2.23, L - 0.20, -0.09, 2.37, L - 0.08, PI.amber),
    box(-0.13, 2.05, L - 0.20, -0.09, 2.19, L - 0.08, PI.lime),
    box(-0.10, 0.95, 0.07, 0.10, 1.20, 0.13, PI.yellow),       // push-button box
  ];
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

// Round 10 (roads piece): hydrant / bin / bench in WORLD units like the lamp.
// At FURN_SCALE a voxel is 0.48, so the voxel hydrant was a 1.4-wide, 2.9-tall
// red totem and the bench 2.9 x 2.4 -- both overhung the sidewalk onto the
// road (r9 roads critic: "only lamps; there are no benches, bins or signs").
// These are knee-high and sidewalk-sized; local +Z faces the carriageway.
function hydrantBoxes() {
  const R = PI.fireRed, K = PI.crimson, Y = PI.yellow;
  return [
    box(-0.15, 0.00, -0.15, 0.15, 0.06, 0.15, K),   // base flange
    box(-0.10, 0.06, -0.10, 0.10, 0.46, 0.10, R),   // barrel
    box(-0.17, 0.26, -0.05, 0.17, 0.36, 0.05, Y),   // side nozzles
    box(-0.12, 0.46, -0.12, 0.12, 0.52, 0.12, K),   // bonnet
    box(-0.05, 0.52, -0.05, 0.05, 0.58, 0.05, Y),   // cap
  ];
}
function binBoxes() {
  return [
    box(-0.16, 0.00, -0.16, 0.16, 0.50, 0.16, PI.roofGreen),  // body
    box(-0.18, 0.50, -0.18, 0.18, 0.56, 0.18, PI.darkGray),   // lid
  ];
}
function benchBoxes() {
  const M = PI.darkGray, S = PI.plank, W = PI.wood;
  return [
    box(-0.55, 0.00, -0.18, -0.47, 0.30, 0.16, M),   // end frames
    box(0.47, 0.00, -0.18, 0.55, 0.30, 0.16, M),
    box(-0.60, 0.26, -0.16, 0.60, 0.32, 0.18, S),    // seat, open to +Z (street)
    box(-0.60, 0.32, -0.20, 0.60, 0.60, -0.14, W),   // back, on the away side
  ];
}

// ---------------------------------------------------------------------------
// Models — vegetation
// ---------------------------------------------------------------------------
// Authored in src/models/vegetation.js (res 4, ref06 "Isometric City Voxel"
// look): cuboid lime canopies with a darker band + pixel dots, square trunks
// with a branch fork, cube bushes, stepped grey rocks, plus-shaped flowers.
// World sizes match the legacy 5 x 9 x 5 oak, so an instance `scale` of 1.0
// still means a 5-unit tree and the size ladders above are unchanged.
//
// Far impostors are the SAME boxes (vegFarBoxes) minus the pixel dots, so the
// two LODs share one silhouette and one set of colours; the handover is only
// visible as the dots fading out, which at that distance are sub-pixel.
function vegFar(kind) {
  return vegFarBoxes(kind).map((b) => box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, b.ci));
}

// The broadleaf family a scattered 'oak' is dealt into (ref06's four shapes).
// Picked per instance from its own hash in scatter(); weights are a CDF.
// (ref06's sapling is the column tree at an understorey size — a separate
// type would cost two more draw calls for the same silhouette.)
const OAK_FAMILY = ['oak', 'column', 'cluster'];
// r8 (critic: "at city zoom the trees are all the same small lollipop, no
// tall columnar types"): more columns, and each shape gets its own size
// class multiplier so a street / grove mixes tall columns, full round trees
// and lower wide clusters instead of one repeated silhouette.
// r12 (critic: "the small twin-cube tree is copied too often in a tight
// grid, so the park looks cloned; ref06 mixes tall single blocks, 3-cube
// crowns and small ones more evenly"): fewer twin-cube 'oak' (round) trees,
// and a smaller share of instances takes its shape from the patch hash, so
// neighbours in a meadow differ.
const OAK_FAMILY_CDF = [0.28, 0.64, 1.0];
const OAK_PATCH_SHARE = 90;   // of 256 (was 179)
const ROCK_SCALE = 0.66, ROCK_SCALE_ADD = 0.27;   // r13: the rock grid grew 20 -> 22 voxels, so x0.9 keeps the r12 size (r12: 0.72 / 0.30)
const FLOWER_SCALE = 0.84;    // r14: res-4 patch, a flower ~0.5 units (r12-13: res 2 x1.3 = 2 units, "as big as a tree canopy")
const OAK_FAMILY_SCALE = [1.0, 1.16, 0.94];
// Share of the scattered shrubs that are a little flower patch instead.
const FLOWER_SHARE = 0.40;   // r12: was 0.34 (critic: flowers "too few to read")
// Woodland understorey below this instance scale (the two smallest UNDER
// buckets) is, UNDER_SWAP_SHARE of the time, dealt into a cube bush or (a
// UNDER_ROCK_SHARE of those) a grey rock cluster instead of a tiny tree.
const UNDER_SWAP_BELOW = 0.39;
const UNDER_SWAP_SHARE = 0.75;
// r5 critic: "rock clusters are rare and small compared with ref06's larger
// grey stepped clusters" -> a bigger share, and rocks sized up to ~1.7x.
const UNDER_ROCK_SHARE = 0.42;

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
  // Trees hand over to the box impostor built from the SAME boxes (vegFar), so
  // the only thing lost at the handover is the sub-pixel canopy dots. The near
  // models are greedy-meshed res-4 cuboids (~100-250 triangles), cheaper than
  // the old speckled 270-triangle oak, so the near LOD reaches further out:
  // the iso camera sits ~camDist (85-190) from its target.
  { key: 'oak', group: 'veg', lod1: 140, cull: 1200, fade: 0, sway: 0.0 },
  { key: 'column', group: 'veg', lod1: 140, cull: 1200, fade: 0, sway: 0.0 },
  { key: 'cluster', group: 'veg', lod1: 140, cull: 1200, fade: 0, sway: 0.0 },
  { key: 'pine', group: 'veg', lod1: 140, cull: 1200, fade: 0, sway: 0.0 },
  { key: 'blossom', group: 'veg', lod1: 140, cull: 1200, fade: 0, sway: 0.0 },
  { key: 'shrub', group: 'veg', lod1: 300, cull: 520, fade: 90, sway: 0.0 },
  { key: 'bushTall', group: 'veg', lod1: 300, cull: 520, fade: 90, sway: 0.0 },   // r13: 2nd bush shape
  { key: 'flowers', group: 'veg', lod1: 900, cull: 380, fade: 90, sway: 0.020 },
  { key: 'hedge', group: 'veg', lod1: 300, cull: 520, fade: 90, sway: 0.020 },
  { key: 'rock', group: 'veg', lod1: 300, cull: 900, fade: 0, sway: 0.0 },
  { key: 'path', group: 'veg', lod1: 900, cull: 420, fade: 110, sway: 0.0 },
];
// Types that never cast into the shadow map. Rocks (r8): a knee-high caster
// sits inside the CSM's normal-offset / bias band, so only its tallest block's
// shadow survived, as a pale detached diamond a unit off to the side, and the
// rest became a near-black skirt at the base (critic: "ghost shadow quads").
// ref05's field rocks show no cast shadow at all; the model's own AO grounds it.
const NO_SHADOW = new Set(['path', 'flowers', 'rock']);
const TYPE_INDEX = Object.create(null);
for (let i = 0; i < TYPES.length; i++) TYPE_INDEX[TYPES[i].key] = i;
const NT = TYPES.length;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const PARS_COMMON = /* glsl */`
varying float vPropAO;
varying vec3  vPropTone;
varying vec2  vPropMat;
varying vec3  vPropGlow;
varying float vPropEmi;
varying float vPropVeg;
`;

const VERT_PARS = /* glsl */`
attribute float aoT;
attribute vec2  matParams;
attribute vec3  glowColor;
attribute float emissiveT;
attribute vec4  aPropParam;   // x sway, y phase, z fadeStart, w fadeEnd
attribute float aVegTone;     // 1 on vegetation geometry, 0 (default) elsewhere
uniform float uPropToneSide;  // +1 sun from the camera's left, -1 from its right
uniform float uPropTime;
uniform float uPropWind;
uniform vec3  uPropCam;
${PARS_COMMON}
`;

// Runs immediately after <begin_vertex>, i.e. before <project_vertex> applies
// instanceMatrix — `transformed` is still in model space, bottom-anchored at 0.
const VERT_BODY = /* glsl */`
vPropAO   = aoT;
vPropVeg  = aVegTone;
// r9 vegetation contact shading (critic: "darker contact shading where the
// lobes meet and under the canopy onto the trunk"; rocks: "sharp dark
// crevices"): ref06's Blender AO bites harder into inside corners than the
// kid-friendly building curve, so vegetation takes the ray AO to a steeper
// power — open faces (aoT = 1) are untouched, a lobe junction ~0.5 -> ~0.3.
vPropAO   = mix(aoT, pow(max(aoT, 0.0), 1.7), aVegTone);
vPropMat  = matParams;
// Vegetation face tones (ref06): every canopy / rock / bush shows three clearly
// separate tones — a bright chartreuse top, a mid lit side and a darker olive
// shade side. The rig's fill is ~90% of a pixel's light, so on its own it only
// separates the two side faces by ~0.8x and the top barely at all; lime
// canopies on lime grass then read as flat blobs. This is a stylised albedo
// term in VIEW space (transformedNormal, from <defaultnormal_vertex>), so it
// follows the 90-degree camera snaps; uPropToneSide picks which side face is
// the shade side from the key light. Furniture has aVegTone = 0 -> no-op.
{
  vec3 tn = normalize(transformedNormal);
  float tTop  = smoothstep(0.30, 0.72, tn.y);
  float tSide = tn.x * uPropToneSide;
  float tDark = smoothstep(0.20, 0.55, tSide);
  float tLit  = smoothstep(0.20, 0.55, -tSide);
  float tUnder = smoothstep(0.30, 0.72, -tn.y);
  // Leaf greens (g > r, g > b) also shift HUE like ref06: a yellower
  // chartreuse top, a greener shade side. Greys, browns, pinks: value only.
  float leafy = 0.0;
  float barky = 0.0;
  #ifdef USE_COLOR
    leafy = clamp((vColor.g - max(vColor.r, vColor.b)) * 6.0, 0.0, 1.0);
    barky = clamp((vColor.r - vColor.g) * 7.0, 0.0, 1.0) * clamp((vColor.g - vColor.b) * 7.0, 0.0, 1.0);
  #endif
  vec3 topT  = 1.12 * mix(vec3(1.0), vec3(1.02, 0.99, 0.55), leafy);
  vec3 darkT = 0.70 * mix(vec3(1.0), vec3(0.94, 1.03, 0.70), leafy);
  vec3 litT  = vec3(0.97);
  // r7 LIME CANOPIES (critic: "left and right faces almost the same mid-green,
  // top a flat lime"): ref06's canopy reads as three distinct tones because
  // the TOP and the LIT side are both yellow-lime (#c4dd00 / #b0cf00, only
  // ~1.07x apart) and the shade side is a clearly separate olive (#85ab00);
  // bands ~0.8x of their face. Our rig instead made the top a neon
  // #c7f101 and both sides darker greens (#96b800 / #587900), so the sides
  // read as one "mid-green" under a glaring top. These per-channel factors
  // were solved against the rendered pixels (rig light: top ~1.3x, lit ~0.8x,
  // shade ~0.4x of albedo in linear) so the rendered canopy lands on ref06's
  // three values. Only yellow-limes (r/g > ~0.45 in linear: leaf, pine,
  // band, dots) — the saturated bush greens (r/g ~0.2) keep the old tones,
  // which already match ref06's bushes.
  float lime = 0.0;
  #ifdef USE_COLOR
    lime = clamp((vColor.g - max(vColor.r, vColor.b)) * 14.0, 0.0, 1.0)
         * smoothstep(0.36, 0.50, vColor.r / max(vColor.g, 1e-3));
  #endif
  // r10: re-solved against the current rig (its fill got darker: shade
  // faces rendered #759500 / bands #4c6b00 / trunks #6c3a0c) -> ref06 values.
  // r13: top 1.03/0.87 -> 0.93/0.81 — it rendered a neon #daf00e in
  // gal-deco-1 (ref06 #c4dd00); still the brightest face over the #badf03 lit side.
  topT  = mix(topT,  vec3(0.93, 0.81, 0.60), lime);
  litT  = mix(litT,  vec3(1.26, 1.27, 1.00), lime);
  // r13 (critic r12: "left and right canopy faces almost the same tone; in
  // ref06 the shade face is clearly darker olive"): shade side down from
  // #84af00 to ~#78a200, a clear olive step under the #abce02 lit side.
  darkT = mix(darkT, vec3(1.22, 1.38, 1.00), lime);
  // r8 bush greens (saturated, not lime): ref06 bush #62c700 top / #4db400
  // lit / #358e00 shade. The leafy tones above rendered a neon #74f103 top
  // and a dark #2f7200 shade side; solved from those pixels in linear.
  float bushy = leafy * (1.0 - lime);
  topT  = mix(topT,  vec3(0.80, 0.74, 0.60), bushy);
  darkT = mix(darkT, vec3(0.84, 1.15, 0.49), bushy);
  // Greys (rocks): ref06 #8d8d8d top / #737373 lit / #4d4d4d shade. The rig
  // plus the rock's own AO and self-shadow rendered the shade side #363a39
  // and the low shelves near-black (#131516), so a rock read as a dark
  // muddle; the shade step is lifted to ref06's ~0.67x (sRGB) of the lit side
  // (0.70 -> 0.98; measured 1.60 overshot to 0.9x).
  float greyish = 0.0;
  #ifdef USE_COLOR
  {
    float cMax = max(vColor.r, max(vColor.g, vColor.b));
    float cMin = min(vColor.r, min(vColor.g, vColor.b));
    greyish = 1.0 - smoothstep(0.15, 0.30, (cMax - cMin) / max(cMax, 1e-3));
    greyish *= 1.0 - smoothstep(0.55, 0.75, cMax);   // not the white petals
  }
  #endif
  // r10 (critic: "rock tops almost the same mid grey as the sides, rocks
  // read as dark lumps"): tops clearly the lightest face (#a4 > ref06 #8d, so
  // they pop off the lawn), lit side ~#76, shade side ~#4e (was #35-#3e).
  // r11: rocks no longer take post SSAO (see FRAG_SSAO_KEEP), which had been
  // darkening every face ~0.6x; re-solved from the SSAO-free render (top
  // #c3 / lit #82 / shade #66 at the r10 factors) to ref06's #8d/#72/#4d,
  // with the top kept a step lighter (~#9a) so it still pops off the lawn.
  // r13: top 0.80 -> 0.88 so it separates clearly from the lit side
  // (critic r12 wanted three distinct rock tones; they measured ~143/112/69).
  topT  = mix(topT,  vec3(0.88), greyish);
  litT  = mix(litT,  vec3(0.90), greyish);
  darkT = mix(darkT, vec3(1.05), greyish);
  // Bark (r > g > b): ref06 trunks keep a warm shade side (#9b502b against
  // #c27642 lit, ~0.8x); the canopy's own shadow already darkens them, so
  // the stylised shade step is milder than the leaves' (r5 read maroon).
  darkT = mix(darkT, vec3(1.50, 1.40, 1.35), barky);   // r10: shade side rendered #6c3a0c
  vec3 tone = vec3(1.0);
  tone *= mix(vec3(1.0), topT, tTop);
  tone *= mix(vec3(1.0), litT, tLit);
  tone *= mix(vec3(1.0), darkT, tDark);
  tone *= mix(vec3(1.0), vec3(0.70), tUnder);
  vPropTone = mix(vec3(1.0), tone, aVegTone);
}
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
uniform float uPropVegSsao;
uniform float uPropRockSsao;
${PARS_COMMON}
`;

const FRAG_COLOR = /* glsl */`
diffuseColor.rgb *= vPropAO * vPropTone;
`;

// roughnessmap_fragment / metalnessmap_fragment declare the factor; we override
// it AFTER the include so the declaration (and any map) still exists.
const FRAG_ROUGH = /* glsl */`
roughnessFactor = clamp(vPropMat.x, 0.03, 1.0);
`;
const FRAG_METAL = /* glsl */`
metalnessFactor = clamp(vPropMat.y, 0.0, 1.0);
`;

// r10 (critic: "canopy and rock outlines soft and smeared"): vegetation
// carries its own crisp baked ray AO, exactly like the voxel buildings, so it
// opts out of post.js's wide screen-space AO the same way they do — scene
// alpha is the SSAO gate (post LIT_FRAG keep; castGate also stops it casting
// the soft grey skirt onto the grass). Double AO (baked + a 1.6-unit SSAO
// kernel on a 2-4 unit rock) was what smeared soft vertical gradients down
// every rock and canopy face.
// r11 (critic r10: rocks "soft, bevelled blocks with even grey faces"):
// post.js now floors every pixel's keep at ssao.voxelKeep = 1, so the 0.2
// above no longer reached it and the full 0.5-unit contact term smeared a
// soft dark gradient into every step of a rock. Grey vegetation (the rocks —
// the white petals are excluded by value) writes the explicit opt-out marker
// alpha = -1 - keep (post.js composite), and carries its pocket AO baked.
const FRAG_SSAO_KEEP = /* glsl */`
gl_FragColor.a = mix(gl_FragColor.a, uPropVegSsao, vPropVeg);
#ifdef USE_COLOR
{
  float cMax = max(vColor.r, max(vColor.g, vColor.b));
  float cMin = min(vColor.r, min(vColor.g, vColor.b));
  float rockK = step(0.5, vPropVeg) * step((cMax - cMin) / max(cMax, 1e-3), 0.2) * step(cMax, 0.65);
  if (rockK > 0.5) gl_FragColor.a = -1.0 - uPropRockSsao;
}
#endif
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
      uPropToneSide: { value: 1 },
      // r10: how much of post.js's screen-space AO vegetation keeps (scene
      // alpha, the same gate voxel buildings use via materials.ssaoKeep).
      uPropVegSsao: { value: 0.2 },   // 0 = none (floats), 1 = full soft SSAO (smeared faces)
      uPropRockSsao: { value: 0.0 },  // r11: rocks' own SSAO keep (bypasses post voxelKeep)
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
        // Edge chunks also hold the off-map band (pass 4), so their boxes
        // reach out over it (and down to the skirt's lowered edge).
        const ob = OFF_BAND * TILE;
        this._chunkBox.push(new THREE.Box3(
          new THREE.Vector3(x0 - CULL_PAD - (cx === 0 ? ob : 0), -6, z0 - CULL_PAD - (cz === 0 ? ob : 0)),
          new THREE.Vector3(x0 + CHUNK_W + CULL_PAD + (cx === CHUNKS - 1 ? ob : 0), 14,
            z0 + CHUNK_W + CULL_PAD + (cz === CHUNKS - 1 ? ob : 0))));
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
      aPropParam: [0, 0, 1e9, 1e9], aVegTone: [0.0],
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
      f = f.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n' + FRAG_SSAO_KEEP);
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
    // Lamp: the slim world-unit box model is only 5 boxes (60 tris), so both
    // LODs share it (the far LOD must keep the same slim silhouette).
    G.lamp0 = paintMetal(buildBoxGeometry(lampBoxes()), 0.20, 0.42);
    G.lamp1 = G.lamp0;
    // Round 14: slim world-unit signal for both LODs (roads.js now places
    // them at junctions; the old voxel trafficLightModel is gone).
    G.trafficlight0 = paintMetal(buildBoxGeometry(trafficBoxes()), 0.20, 0.42);
    G.trafficlight1 = G.trafficlight0;
    G.sign_stop0 = vox(stopSignModel(), FURN_SCALE);
    // Round 10: slim world-unit hydrant / bin / bench (see hydrantBoxes).
    G.hydrant0 = paintMetal(buildBoxGeometry(hydrantBoxes()), 0.20, 0.42);
    G.bin0 = paintMetal(buildBoxGeometry(binBoxes()), 0.20, 0.42);
    G.bench0 = paintMetal(buildBoxGeometry(benchBoxes()), 0.20, 0.42);

    // vegetation — authored in voxel units; the instance `scale` field is a
    // pure size class from STREET_SIZES / WOOD_SIZES / UNDER_SIZES.
    // aVegTone = 1 turns on the stylised ref06 face tones (see VERT_BODY).
    const veg = (geo) => {
      const n = geo.attributes.position.count;
      geo.setAttribute('aVegTone', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
      geo.computeBoundingSphere();
      return geo;
    };
    // Near LOD: res-4 voxel models (real AO, pixel dots); far LOD: same boxes.
    // aoReach 1: a crisp one-voxel contact ramp. The default (= res, 4 voxels)
    // splits every face that touches another block into AO slivers and cost
    // 2-3x the triangles for a ramp the iso camera barely resolves.
    // r9 (critic: "canopies need darker contact shading where the lobes meet
    // and under the canopy onto the trunk"): short Blender-style ray AO
    // (0.5 world units) instead of the one-voxel box ramp, so a lobe pressed
    // against another, the band's underside over the trunk and the fork
    // arms go properly dark while open faces stay flat. aoMergeTol 1.5 keeps it at the box-ramp triangle count (selfTest library cap 4000).
    // r14 (critic r13: "a smudgy dark AO blotch where the canopy cubes
    // overlap; ref06 edges are clean"): 0.5 -> 0.3-unit rays and a linear
    // curve (0.55 spread the dark far up the face): a tight contact crease.
    // aoSpread 0: voxel.js's new default (1.0 world unit, for building
    // cornices) dilated every lobe contact into a ~4-voxel radial starburst —
    // THE blotch. Veg near models ~1870 tris.
    const VEG_AO = { ao: true, bevel: false, skipBottom: false, aoReach: 4, aoDist: 0.3, aoRayStrength: 0.85, aoRayCurve: 1.0, aoRayToe: 0.10, aoSpread: 0, aoMergeTol: 1.0 };
    const near = (m) => veg(buildVoxelGeometry(m, VEG_AO));
    const pair = (key, kind, seed) => {
      G[key + '0'] = near(vegModel(kind, seed));
      G[key + '1'] = veg(buildBoxGeometry(vegFar(kind)));
    };
    // Draw-call budget (selfTest: <= 20 at street and region): only the three
    // commonest / heaviest trees get a far impostor. Column (~170 tris),
    // blossom and the knee-high props stay on their near model at any range.
    pair('oak', 'round', 0);
    pair('cluster', 'cluster', 2);
    pair('pine', 'pine', 4);
    G.column0 = near(vegModel('column', 1));
    G.blossom0 = near(vegModel('blossom', 5));
    G.shrub0 = near(vegModel('shrub', 0));
    G.bushTall0 = near(vegModel('bushTall', 0));
    G.hedge0 = near(vegModel('hedge', 0));
    // r11 (critic r10: "soft, bevelled blocks with even grey faces; ref06
    // has deep dark AO pockets and crevices"): the soft smear was post.js's
    // screen-space contact AO (ssao.voxelKeep 1 overrode the veg alpha gate),
    // not this bake — rocks now opt out of it (FRAG_SSAO_KEEP) and carry the
    // occlusion themselves: 3.2-voxel rays, curve 0.8, so creases get a crisp
    // one-voxel dark band on the concave side only (convex edges stay clean)
    // and the enclosed spots the r11 rock is built with — the undercut, the
    // slot under the overhanging slab, notches, the slits round the chip-cubes
    // — fill with real shade. mergeTol 0.6 keeps it at ~870 tris (library cap).
    // r13 (critic r12: rock edges "soft, bevelled and smeared"): the 0.8-unit
    // rays (x the 1-1.5 rock scale) laid a soft vertical gradient down every
    // face and the merged ramps drew diagonal smears. Now 0.3 units (~1 voxel):
    // a crisp one-voxel line in each inside crease, flat faces everywhere
    // else, sharp convex edges. No ground term (the lawn's own SSAO grounds
    // it) — that also keeps the library under the 4000-tri cap (rock ~656).
    const ROCK_AO = { ao: true, bevel: false, skipBottom: true, groundAO: false, aoReach: 4, aoDist: 0.3, aoRayStrength: 0.85, aoRayCurve: 1.0, aoRayToe: 0.0, aoSpread: 0, aoMergeTol: 0.3 };   // r14: aoSpread 0 — voxel.js's new 1-unit AO spread re-softened every step (and 656 -> 1062 tris)
    // Rocks (r9, critic: "soft grey cubes, faint smudged ledges, no crevices"):
    // Blender-style ray-cast AO over ~0.8 world units, so every inside corner,
    // every step and the 1-voxel slits between loose cubes go dark the way
    // ref06's do. Rocks are few and knee-high, so the finer ramp is cheap.
    G.rock0 = veg(buildVoxelGeometry(vegModel('rock', 0), ROCK_AO));
    // Flowers never show their underside and are too small to matter as
    // shadow casters, so they drop the bottom faces (~20% of their triangles).
    G.flowers0 = veg(buildVoxelGeometry(vegModel('flowers', 0), { ao: false, bevel: false, skipBottom: true }));   // r14: ~0.5-unit flowers, AO invisible (290 tris)
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
    // Empty tiles inside a city block are VACANT LOTS that terrain.js raises
    // and dresses itself (park / plaza / parking …). Nothing natural grows
    // through them.
    const block = cityBlockMask(state);
    // Outskirts parcels (terrain.js parcelPlan, ground r4/r5): raised lots (mask
    // 1) and green flush lots (mask 3) grow nothing natural — terrain dresses
    // them; the lattice line beside a raised lot (mask 2) is a tree row; open
    // field in the belt (mask 4) gets a sparse even sprinkle.
    const parcel = parcelPlan(state, block);
    const pmask = parcel.mask;
    const lawn = lawnMask(state, block, pmask);
    const lpark = lawnPark(state, lawn);   // r11: paths / hub / zones on the lawn parks (terrain draws them)
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
        if (block[i]) continue;
        if (pmask[i] === 1 || pmask[i] === 3) continue;   // raised / green parcel lots
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
    let lastRock = null;   // r9: see the iRock fold in push()
    const push = (t, x, z, y, yaw, scale, tint, rank, pop) => {
      // Vegetation model dispatch (not placement): deal a broadleaf into one of
      // ref06's four tree shapes and some shrubs into flower patches, from a
      // hash of the spot, and square every voxel prop to the grid — a cuboid
      // tree at 37 degrees reads as a smear in the isometric view.
      const hv = hash3(Math.round(x * 16), Math.round(z * 16), 5557);
      // Most of the smallest woodland understorey becomes ref05's ground layer
      // instead — cube bushes and grey stepped rocks between the trees — so
      // every tree stands on its own as a clear lollipop silhouette.
      if (pop === 'w' && scale < UNDER_SWAP_BELOW && (t === iOak || t === iPine || t === iBlossom)) {
        const us = hash3(hv, 17, 9091);
        const uu = (us & 0xffff) / 65536;
        if (uu < UNDER_SWAP_SHARE) {
          const sz = ((us >>> 16) & 255) / 255;
          if (uu < UNDER_SWAP_SHARE * UNDER_ROCK_SHARE) {
            const g = 0.90 + sz * 0.18;
            t = iRock; scale = 1.00 + sz * 0.70; tint = [g, g * 0.99, g * 0.97];
          } else {
            t = iShrub; scale = 0.70 + sz * 0.45;
          }
        }
      }
      if (t === iOak) {
        // Groves of one shape (r5 critic: "a busy speckle of same-sized cubes
        // with little value structure"): 70% of the time the shape comes from
        // a ~14-unit patch hash, so a copse reads as round trees next to a
        // stand of columns, as in ref05, instead of per-tree confetti.
        const hp = hash3(Math.floor(x / 14), Math.floor(z / 14), 7717);
        const u = ((hv >>> 8) & 0xff) < OAK_PATCH_SHARE ? (hp & 0xffff) / 65536 : (hv & 0xffff) / 65536;
        let f = 0;
        while (f < OAK_FAMILY_CDF.length - 1 && u >= OAK_FAMILY_CDF[f]) f++;
        t = TYPE_INDEX[OAK_FAMILY[f]];
        scale *= OAK_FAMILY_SCALE[f];
      } else if (t === iShrub && ((hv >>> 16) & 0xffff) / 65536 < FLOWER_SHARE) {
        t = TYPE_INDEX.flowers;
      } else if (t === iShrub && ((hv >>> 5) & 1)) {
        // r13 (critic r12: "bushes vary little"): half the cube bushes take
        // ref06's tall-block-plus-foot-cube shape instead (same placement).
        t = TYPE_INDEX.bushTall;
      }
      if (t === iRock) {
        // r9: the rock MODEL is now a whole ref06 cluster (a dominant block
        // with 8 stepped sub-blocks and dark slits round it). The scatter's
        // 2-3-rock groups (1.25 / 0.8 / 0.5 overlapping copies) turned that
        // into a ~25-facet heap with three voxel grains, so a group's
        // follow-on rocks (within 2.2 units of the rock just pushed) fold
        // into its first one: same number of rock clusters per tile, each one
        // a single crisp cluster. Each cluster gets its own 90-degree turn
        // (the scatter passes yaw 0, so every rock was the same silhouette).
        if (lastRock && Math.abs(lastRock.x - x) < 2.8 && Math.abs(lastRock.z - z) < 2.8) return;   // r12: 2.2 -> 2.8 (bigger rocks)
        yaw = ((hv >>> 12) & 3) * (Math.PI / 2);
        // r12 (critic: rocks "tiny" next to ref06's bush-sized clusters): the
        // r12 model is a compact 4-block stack, drawn a size up.
        // Small meadow rocks grow most (0.48 -> 0.65); the big scree / sand
        // rocks (1.2-1.7) stay about where they were.
        scale = scale * ROCK_SCALE + ROCK_SCALE_ADD;
      } else if (t === TYPE_INDEX.flowers) {
        scale *= FLOWER_SCALE;   // r14: tiny ankle-height accents (ref06: ~1/4 of a bush)
      }
      if (t !== iHedge) yaw = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
      if (t === iRock) lastRock = { x, z };
      this._raw[t].push({
        x, z, y, yaw, scale,
        r: tint[0], g: tint[1], b: tint[2], rank, pop: pop || 'o',
      });
      count++;
    };

    // ground r9 — MEADOW SPRINKLE. Critic r8: "the open grass … is laid out as
    // large empty wedges with only 3-4 sparse trees in each … in ref05 the
    // open ground is packed with small cuboid trees and grey rock clusters".
    // Measured on ref05's fields against iso-park (both ~116-120 px/tile):
    // ref05 carries ~2 small trees (canopy ~25 px, i.e. ~1.7 units) and ~0.4
    // rock clusters per tile, spread evenly (blue-noise, not rows, not
    // groves); r8 had 0.5 trees of ~3 units. So a tile is split into 2x2
    // cells, ~70% filled (a sparse 3x3 read clumpy); each cell holds at most ONE item (so nothing overlaps) at a
    // small jitter, with the item dealt by the cell hash. `f` scales the
    // whole population (1 = full meadow). Returns the number of trees.
    // r12 (critic r11: open grass "scattered with lollipop trees and grey rock
    // cubes"): side by side with ref05's top-left field at matched scale the
    // r9 sprinkle carried ~2x ref05's trees and read as an orchard; about 1.3
    // trees per tile now, a few more rocks and cube bushes, no blossom.
    // r13 FIELD GRID (critic r12: "our open grass is covered with hundreds of
    // randomly scattered trees, grey rocks and flower speckles … the reference
    // field is clean lime grass with a few evenly spaced trees and only the
    // odd rock"; coordinator: ~1 tree per 2-2.5 tiles on a regular jittered
    // grid, jitter <= 25% of the spacing, rocks ~1 per 6 tiles, no speckle).
    // Measured on ref05's top-left field: ~0.5 trees and ~0.16 rock clusters
    // per tile. One WORLD-space staggered (hex) lattice, so the spacing stays
    // even across tile, mask and parcel boundaries: TREE slots on the lattice
    // points, and the MID slots half-way along each row carry the odd rock or
    // cube bush. `f` scales occupancy (1 = full field). Returns tree count.
    // r14 FIELD ROWS (critic r13: "trees and grey rock clusters dropped at
    // random … in ref05 cube trees stand in neat, regular rows; cut down the
    // random grey rocks"; r12 had called ~1.3 random trees/tile cluttered and
    // r13's ~0.46 on a jittered hex read empty — aim between, and ORDERED).
    // Every tree now stands on the same 4-unit world lattice the kerb row
    // uses (tile centre +-2), one slot per tile — the (-2,-2) corner — so
    // field trees line up with each other AND with the kerb rows into straight
    // rows parallel to the streets (screen diagonals). ~0.8 trees per tile,
    // jitter <= 0.35 units. The opposite (+2,+2) slot carries the odd cube
    // bush (6%) or small rock (7%, about 1 per 14 tiles).
    const FIELD_TREE = 0.80, FIELD_ROCK = 0.07, FIELD_BUSH = 0.06;
    const FIELD_SIZES = [0.38, 0.41, 0.44];
    const FIELD_CDF = [0.35, 0.75, 1.00];
    const iFieldBush = TYPE_INDEX.bushTall != null ? TYPE_INDEX.bushTall : iShrub;   // never dealt into a flower speckle
    const meadow = (x, z, f, salt, yBase, skip) => {
      let nT = 0;
      const y0 = yBase || 0;
      const cx = (x + 0.5) * TILE, cz = (z + 0.5) * TILE;
      const h = hash3(x * 7919 + S, z * 104729 + 17, 7193);
      const h2 = hash3(h, 13, 331);
      const u = (h & 0xffff) / 65536;
      // tree slot: quadrant 0 (-2,-2); item slot: quadrant 3 (+2,+2)
      if (!(skip & 1) && u < f * FIELD_TREE) {
        const px = cx - 2 + (((h2 >>> 16) & 255) / 255 - 0.5) * 0.7;
        const pz = cz - 2 + (((h2 >>> 24) & 255) / 255 - 0.5) * 0.7;
        const sc = pickSize(((h2 >>> 4) & 0xffff) / 65536, FIELD_SIZES, FIELD_CDF);
        push(iOak, px, pz, y0, 0, sc, this._foliageTint(h2, false), ((h >>> 3) & 0xffff) / 65536, salt === 101 ? 'w' : 's');
        if (salt === 101) nWood++; else nStreet++;
        nT++;
      }
      if (!(skip & 8)) {
        const v = ((h >>> 16) & 0xffff) / 65536;
        const rk = ((h >>> 9) & 0xffff) / 65536;
        if (v < f * FIELD_ROCK) {
          lastRock = null;   // a field rock is its own cluster, never folded into a neighbour's
          const g = 0.9 + ((h2 >>> 8) & 255) / 255 * 0.14;
          push(iRock, cx + 2, cz + 2, y0, 0, 0.36 + ((h2 >>> 4) & 15) / 110, [g, g * 0.99, g * 0.96], rk);   // ref05 field rocks are small
        } else if (v < f * (FIELD_ROCK + FIELD_BUSH)) {
          push(iFieldBush, cx + 2, cz + 2, y0, 0, 0.6 + ((h2 >>> 8) & 255) / 255 * 0.2, this._foliageTint(h2, false), rk);
        }
      }
      return nT;
    };

    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const p = plant[i];
        if (!p) continue;

        const cx = (x + 0.5) * TILE, cz = (z + 0.5) * TILE;
        // r10: open lawn the town has closed in on stands on a raised plinth
        // (terrain.js lawnMask); everything planted on it stands on its top.
        const gy = lawn[i] ? LOT_TOP : 0;
        if (lawn[i]) {
          // r11 LAWN PARK (critic r10: "trees and rocks spaced evenly, like a
          // grid"): planting follows terrain.lawnPark's zones. GROVE tiles
          // carry a tight clump of 4-6 trees (quadrant-placed on a path tile
          // so the tread stays clear), CLEARING tiles open lawn with one rock
          // group or bush pair, PICNIC tiles a shade tree; flower / hub tiles
          // are terrain's beds and plaza.
          const zn = lpark.zone[i], pb = lpark.path[i];
          const h = hash3(x * 2654435761 + S, z * 40503, 877);
          const hf = (k) => (hash3(h, k, 1291) & 0xffff) / 65536;
          const tint = (k) => this._foliageTint(hash3(h, k, 71), false);
          const treeAt = (px, pz, k, big) => {
            const t = hf(k * 3 + 1) > 0.97 ? iBlossom : iOak;
            const sc = pickSize(hf(k * 3 + 2), big ? KERB_SIZES : STREET_SIZES, big ? KERB_CDF : STREET_CDF);
            push(t, px, pz, gy, 0, sc, tint(k), hf(k * 3 + 3), 's');
            nStreet++;
          };
          if (zn === LZ_GROVE) {
            if (pb) {
              let k = 0;
              for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                if (hf(40 + k) < 0.8) treeAt(cx + sx * 2.5, cz + sz * 2.5, k, hf(50 + k) < 0.5);
                k++;
              }
            } else {
              const n = 4 + ((hf(60) * 3) | 0);
              const ox = (hf(61) - 0.5) * 1.4, oz = (hf(62) - 0.5) * 1.4, a0 = hf(63) * 6.28;
              for (let k = 0; k < n; k++) {
                const rr = k === 0 ? 0 : 1.7 + (k & 1) * 0.8, ang = a0 + k * 2.39996;
                const px = Math.max(-2.7, Math.min(2.7, ox + Math.cos(ang) * rr));
                const pz = Math.max(-2.7, Math.min(2.7, oz + Math.sin(ang) * rr));
                treeAt(cx + px, cz + pz, k, k === 0 || hf(70 + k) < 0.4);
              }
              if (hf(80) < 0.7) push(iShrub, cx - ox * 1.6 + 1.2, cz - oz * 1.6 - 1.2, gy, 0, 0.7 + hf(81) * 0.4, tint(9), hf(82));
            }
          } else if (zn === LZ_CLEAR) {
            const u = hf(90);
            const px = cx + (hf(91) - 0.5) * 3, pz = cz + (hf(92) - 0.5) * 3;
            if (u < 0.55) {
              lastRock = null;
              const g = 0.9 + hf(93) * 0.14;
              push(iRock, px, pz, gy, 0, 0.7 + hf(94) * 0.3, [g, g * 0.99, g * 0.96], hf(95));
              push(iShrub, px + 1.6, pz + 0.6, gy, 0, 0.7 + hf(96) * 0.3, tint(3), hf(97));
            } else if (u < 0.85) {
              push(iShrub, px, pz, gy, 0, 0.8, tint(4), hf(98));
              push(TYPE_INDEX.flowers != null ? TYPE_INDEX.flowers : iShrub, px + 1.4, pz - 0.8, gy, 0, 0.8, tint(5), hf(99));
            }
          } else if (zn === LZ_PICNIC) {
            if (hf(100) < 0.7) treeAt(cx + (hf(101) < 0.5 ? -2.6 : 2.6), cz + (hf(102) < 0.5 ? -2.6 : 2.6), 7, true);
          }
          continue;
        }
        if (pmask[i] === 4) {
          // OPEN FIELD in the town belt: ref05's evenly sprinkled meadow
          // (ground r9: ~2 small trees + 0.45 rock clusters per tile, was
          // 0.52 + 0.15 — the r8 critic's "large empty wedges").
          meadow(x, z, 1, 0, gy);
          continue;
        }
        if (pmask[i] === 2) {
          // ORDERED PLANTING. A strip carries one tree per tile down its
          // centre line (a row along the lot edges, ref05's bottom edge); a
          // lattice crossing gets a cube bush or a small rock pair; an orchard
          // meadow carries one tree per tile on the grid.
          const h = hash3(x * 83492791 + S, z * 2971215073, 613);
          const h2 = hash3(h, 11, 97);
          const cross = pmask[i] === 2 && (x & 3) === parcel.px && (z & 3) === parcel.pz;
          if (cross) {
            if ((h & 7) < 5) {
              push(iShrub, cx, cz, gy, 0, 0.8 + ((h2 >>> 8) & 255) / 255 * 0.4, this._foliageTint(h2, false),
                ((h >>> 7) & 0xffff) / 65536);
            } else {
              const g = 0.9 + ((h2 >>> 8) & 255) / 255 * 0.16;
              push(iRock, cx - 0.4, cz - 0.4, gy, 0, 0.9, [g, g * 0.99, g * 0.96], ((h >>> 9) & 0xffff) / 65536);
              push(iRock, cx + 0.7, cz + 0.1, gy, 0, 0.6, [g, g * 0.99, g * 0.96], ((h >>> 9) & 0xffff) / 65536);
            }
          } else if ((h & 0xffff) / 65536 < 0.85) {
            const t = ((h2 & 0xffff) / 65536) > 0.985 ? iBlossom : iOak;
            const sc = pickSize(((h2 >>> 16) & 0xffff) / 65536, KERB_SIZES, KERB_CDF);
            push(t, cx, cz, gy, 0, sc, this._foliageTint(h2, false), ((h >>> 3) & 0xffff) / 65536, 's');
            nStreet++;
          }
          continue;
        }
        const urb = urban[i];
        const wild = 1 - urb;
        // Copses and clearings: a low-frequency forest field, biased away from
        // the road network so streets stay legible.
        const dens = densF[i];
        const conifer = coniF[i];

        // --- LATTICE (ground r3) ----------------------------------------------
        // The r2 critic: "tiny trees sprinkled evenly … cluster the trees and
        // rocks in rows or groups like the ref05 bottom edge". ref05 plants its
        // meadow: every tree stands on a loose 4-unit grid, a row runs along
        // each kerb, and bushes / grey rocks sit in the gaps. So every natural
        // stem below lands on one of four lattice slots per tile — (±2, ±2)
        // from the tile centre, jittered only ±0.3 — which lines copses up into
        // rows (diagonals on screen, parallel to the streets) instead of
        // confetti. Which slots are filled is decided by the grove field.
        //
        // Road side of this tile (4-neighbour only): -1 / +1 on x or z, 0 none.
        const rN = z > 0 && map[i - N] === T_ROAD, rS = z < N - 1 && map[i + N] === T_ROAD;
        const rW = x > 0 && map[i - 1] === T_ROAD, rE = x < N - 1 && map[i + 1] === T_ROAD;
        const verge = rN || rS || rW || rE;

        // --- population A: GROVES, outside the built-up area ----------------
        // A steep threshold on the low-frequency field and NO floor: real
        // clearings of open lawn between tight planted groves (the old 0.05
        // floor is what sprinkled a lone tree on every other tile). Multiplied
        // by (1 - urban)^2.5, which takes it to zero between the towers.
        let pTree = smooth01(0.44, 0.64, dens);
        pTree *= wild * wild * Math.sqrt(wild);
        if (onPath[i]) pTree *= 0.10;
        if (p === 2) pTree *= 0.06;                 // sand: driftwood scrub only

        let groveHit = 0;
        for (let k = 0; k < 4; k++) {
          const sx = (k & 1) ? 2 : -2, sz = (k & 2) ? 2 : -2;
          const h = hash3(x * 73856093 + S, z * 19349663 + k * 83492791, 11);
          const u = (h & 0xffff) / 65536;
          const jx = (((h >>> 16) & 255) / 255 - 0.5) * 0.6;
          const jz = (((h >>> 24) & 255) / 255 - 0.5) * 0.6;
          const h2 = hash3(h, k, 29);
          // KERB ROW: the slot nearest a road on a verge tile always carries
          // a tree (ref05's bottom edge), with the odd gap for a cube bush.
          // Rows run on BOTH sides of the city's streets, so they are street
          // planting ('s'), sized like the lattice's mature stock.
          const kerb = p === 1 && !onPath[i] &&
            ((rN && sz < 0) || (rS && sz > 0) || (rW && sx < 0) || (rE && sx > 0));
          if (kerb) {
            if (u < 0.86) {
              const kindR = (h2 & 0xffff) / 65536;
              const t = kindR > 0.985 ? iBlossom : iOak;
              const sc = pickSize(((h2 >>> 16) & 0xffff) / 65536, KERB_SIZES, KERB_CDF);
              push(t, cx + sx + jx * 0.5, cz + sz + jz * 0.5, gy, ((h2 >>> 24) & 3) * Math.PI / 2, sc,
                this._foliageTint(h2, false), ((h >>> 3) & 0xffff) / 65536, 's');
              nStreet++;
            } else {
              push(iShrub, cx + sx, cz + sz, gy, 0, 0.8 + ((h2 >>> 8) & 255) / 255 * 0.4,
                this._foliageTint(h2, false), ((h >>> 7) & 0xffff) / 65536);
            }
            continue;
          }
          // r13: no woodland stems off the kerb row any more -- the open
          // ground is the even FIELD GRID below (critic r12: "hundreds of
          // randomly scattered trees … the reference field is clean lime grass
          // with a few evenly spaced trees").
          void pTree; void conifer;
        }

        // ground r9: the CLEARINGS between groves were bare lawn (the grove
        // field has no floor), which read as "blank placeholder terrain"
        // next to ref05's evenly sprinkled fields. Give every open tile that
        // did not get a grove stem the meadow sprinkle, scaled down inside
        // the groves' own area and a little near the city (open lawn by the
        // pond / coast inside town is not a yard between towers). Verge
        // tiles keep their road-side cells for the kerb row.
        if (!groveHit && p === 1 && !onPath[i]) {
          const fc = 0.95 * wild * wild;
          // On a verge tile the cells on the road side hold the kerb row.
          let skip = 0;
          if (rN) skip |= 0b0011;
          if (rS) skip |= 0b1100;
          if (rW) skip |= 0b0101;
          if (rE) skip |= 0b1010;
          if (fc > 0.02 && skip !== 0b1111) meadow(x, z, fc, 101, gy, skip);
        }

        // --- population B: STREET / YARD TREES, inside the built-up area ----
        // One planted specimen every few open lots that are NOT on a kerb
        // (verges already carry the kerb row above). Lattice-aligned too.
        if (urb > 0.06 && p === 1 && !onPath[i] && !verge) {
          const h = hash3(x * 374761393 + S, z * 668265263, 449);
          const pSt = (nearRoad[i] ? 0.55 : 0.20) * urb;
          if ((h & 0xffff) / 65536 < pSt) {
            const h2 = hash3(h, 3, 811);
            const k = (h2 >>> 28) & 3;
            const kindR = (h2 & 0xffff) / 65536;
            const t = kindR > 0.85 ? iBlossom : iOak;
            const sc = pickSize(((h2 >>> 8) & 0xffff) / 65536, STREET_SIZES, STREET_CDF) *
              (0.95 + ((h2 >>> 4) & 15) / 150);
            push(t, cx + ((k & 1) ? 2 : -2), cz + ((k & 2) ? 2 : -2), gy, 0,
              sc, this._foliageTint(h2, false), ((h >>> 3) & 0xffff) / 65536, 's');
            nStreet++;
          }
        }

        // Cube bushes in the open lawn — sparse, and on the lattice's
        // half-points (the tile centre) so even the singles line up.
        {
          const h = hash3(x * 40503 + S, z * 51787, 137);
          const u = (h & 0xffff) / 65536;
          const pSh = (p === 2 ? 0.07 * 0.35 : 0) * (0.3 + smooth01(0.30, 0.50, dens)) *   // r13: open grass gets its bushes from the field grid
            (onPath[i] ? 0.15 : 1) * (1 - 0.66 * urb);
          if (u < pSh) {
            const h2 = hash3(h, 5, 71);
            push(iShrub, cx + 2, cz - 2, gy, 0, 0.65 + ((h2 >>> 8) & 255) / 255 * 0.60,
              this._foliageTint(h2, false), ((h >>> 7) & 0xffff) / 65536);
          }
        }

        // Hedges — a tidy planted line where a garden meets a neighbouring
        // building plot. (Not along roads any more: the kerb row owns those.)
        if (p === 1 && !verge) {
          const h = hash3(x * 92837111 + S, z * 689287499, 211);
          const bound = (j) => j >= 0 && j < N * N && occ && occ[j] !== 0;
          // The hedge geometry is long in LOCAL X. A boundary to the EAST/WEST
          // means the shared edge runs along Z, so the hedge must be turned 90
          // degrees to lie ALONG it.
          let yaw = null, ox = 0, oz = 0;
          if (x > 0 && bound(i - 1)) { yaw = Math.PI / 2; ox = -2.2; }
          else if (x < N - 1 && bound(i + 1)) { yaw = Math.PI / 2; ox = 2.2; }
          else if (z > 0 && bound(i - N)) { yaw = 0; oz = -2.2; }
          else if (z < N - 1 && bound(i + N)) { yaw = 0; oz = 2.2; }
          if (yaw !== null && (h & 0xffff) / 65536 < 0.22 && !onPath[i]) {
            push(iHedge, cx + ox, cz + oz, gy, yaw,
              0.86 + ((h >>> 16) & 255) / 255 * 0.34,
              this._foliageTint(h, false), ((h >>> 11) & 0xffff) / 65536);
          }
        }

        // r11 DUNE TUFTS (critic r10: "the beach strip … is a single flat tone
        // with no transition detail such as wet sand or dune tufts"): sand
        // tiles on the landward side carry a few small lime tufts along the
        // grass edge, thinning toward the water.
        if (p === 2) {
          const gN = z > 0 && map[i - N] === T_GRASS, gS = z < N - 1 && map[i + N] === T_GRASS;
          const gW = x > 0 && map[i - 1] === T_GRASS, gE = x < N - 1 && map[i + 1] === T_GRASS;
          if (gN || gS || gW || gE) {
            const h = hash3(x * 97531 + S, z * 86413, 613);
            const ex = gW ? -1 : gE ? 1 : 0, ez = gN ? -1 : gS ? 1 : 0;
            const n = 2 + (h & 3);
            for (let k = 0; k < n; k++) {
              const hk = hash3(h, k, 29);
              const t = (((hk >>> 4) & 255) / 255 - 0.5) * 6.4;       // along the edge
              const d = 2.6 - ((hk >>> 12) & 255) / 255 * 2.2;         // in from the grass
              const px = cx + (ex ? ex * d : t), pz = cz + (ez ? ez * d : t);
              push(iShrub, px, pz, gy, 0, 0.42 + ((hk >>> 20) & 255) / 255 * 0.22, this._foliageTint(hk, false), ((hk >>> 8) & 0xffff) / 65536);
            }
          }
        }

        // Rocks — scree clusters near the mountains (in groups of 2-3), and
        // on sand; the meadow's own rocks come from the grove fringe above.
        {
          const h = hash3(x * 2654435761 + S, z * 40503, 307);
          const u = (h & 0xffff) / 65536;
          // r11: fewer, smaller rocks on the beach (the big grey boulders read
          // heavy beside the lakeside park); the beach gets dune tufts instead.
          const pR = (nearRock[i] ? 0.34 : p === 2 ? 0.025 : 0.0) * (1 - 0.92 * urb);
          const sandK = p === 2 && !nearRock[i] ? 0.55 : 1;
          if (u < pR) {
            const h2 = hash3(h, 9, 401);
            const g = 0.86 + ((h2 >>> 8) & 255) / 255 * 0.26;
            const k = (h2 >>> 28) & 3;
            const bx = cx + ((k & 1) ? 2 : -2), bz = cz + ((k & 2) ? 2 : -2);
            const nR = 1 + ((h2 >>> 24) & 1) + ((h2 >>> 25) & 1);
            for (let r = 0; r < nR; r++) {
              const ox = r === 0 ? 0 : r === 1 ? 1.2 : -0.2, oz = r === 0 ? 0 : r === 1 ? 0.3 : 1.2;
              push(iRock, bx + ox - 0.4, bz + oz - 0.4, gy, 0,
                (r === 0 ? 0.75 + ((h2 >>> 16) & 255) / 255 * 0.8 : 0.55 + ((h2 >>> (10 + r)) & 7) / 20) * sandK,
                [g, g * 0.99, g * 0.96], ((h >>> 9) & 0xffff) / 65536);
            }
          }
        }
      }
    }

    // --- pass 4: OFF-MAP countryside (ground r8) ---------------------------
    // Critic r7 on iso-wide: "the flat, untextured green plane runs to the
    // frame edges". terrain.js now keeps the skirt level with the lawn beside
    // a land border (skirtLandY), so the field can carry on: a band of
    // OFF_BAND tiles round the map gets copses, single trees and grey rock
    // clusters like ref05's outer fields, thinning out with distance.
    // Continues whatever the nearest border tile is: water / sand / road
    // borders get nothing, rock borders only rocks.
    {
      const B = OFF_BAND;
      for (let tz = -B; tz < N + B; tz++) {
        for (let tx = -B; tx < N + B; tx++) {
          if (tx >= 0 && tz >= 0 && tx < N && tz < N) continue;
          const bx = tx < 0 ? 0 : tx >= N ? N - 1 : tx, bz = tz < 0 ? 0 : tz >= N ? N - 1 : tz;
          const m = map[bz * N + bx];
          if (m !== T_GRASS && m !== T_TREE && m !== T_MOUNTAIN) continue;
          const dT = Math.max(tx < 0 ? -tx : tx >= N ? tx - N + 1 : 0, tz < 0 ? -tz : tz >= N ? tz - N + 1 : 0);
          const fade = 1 - smooth01(B * 0.45, B, dT);
          const h = hash3(tx * 2246822519 + S + 77, tz * 3266489917 + 5, 881);
          const h2 = hash3(h, 23, 557);
          const u = (h & 0xffff) / 65536;
          const jx = (((h2 >>> 16) & 255) / 255 - 0.5) * 3.6, jz = (((h2 >>> 24) & 255) / 255 - 0.5) * 3.6;
          const px = (tx + 0.5) * TILE + jx, pz = (tz + 0.5) * TILE + jz;
          const py = skirtLandY(px, pz);
          const cop = smooth01(0.42, 0.62, vnoise(tx * 0.16 + 31.7, tz * 0.16 - 12.3, 4127));
          // r13: an even field like the map's own (no copses): ~1 tree per 2.2 tiles
          void cop;
          const pT = m === T_MOUNTAIN ? 0 : 0.45 * fade;
          const pRk = (m === T_MOUNTAIN ? 0.30 : 0.10) * fade;
          if (u < pT) {
            const t = ((h2 & 0xffff) / 65536) > 0.985 ? iBlossom : iOak;
            const sc = pickSize(((h2 >>> 4) & 0xffff) / 65536, FIELD_SIZES, FIELD_CDF);
            push(t, px, pz, py, 0, sc, this._foliageTint(h2, false), ((h >>> 3) & 0xffff) / 65536, 'o');
          } else if (u < pT + pRk) {
            const g = 0.9 + ((h2 >>> 8) & 255) / 255 * 0.16, tn = [g, g * 0.99, g * 0.96];
            const f = (h2 & 1) ? 1 : -1, rk = ((h >>> 9) & 0xffff) / 65536;
            push(iRock, px, pz, py, 0, 1.2, tn, rk);
            push(iRock, px + f * 1.1, pz + 0.6, py, 0, 0.75, tn, rk);
          } else if (u < pT + pRk + 0.04 * fade) {
            push(iFieldBush, px, pz, py, 0, 0.8, this._foliageTint(h2, false), ((h >>> 7) & 0xffff) / 65536);
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
    const map = state.map;
    for (let i = 0; i < N * N; i++) {
      if (occ[i] !== 0) { n++; h = (Math.imul(h ^ i, 0x01000193)) >>> 0; }
      // Roads too: closing a block turns its empty tiles into lots (terrain.js
      // cityBlockMask), and the scatter has to clear off them.
      else if (map && map[i] === T_ROAD) h = (Math.imul(h ^ (i + 0x10000), 0x01000193)) >>> 0;
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
    // Mostly VALUE variation (0.90-1.06) with a small hue drift. The old
    // independent R 0.86-1.12 / G 0.90-1.12 spread turned a share of the
    // canopies lemon-yellow and others grey-green; ref06 / ref05 foliage is
    // one chartreuse family whose face tones do the work.
    const v = 0.90 + a * 0.16;
    const warm = conifer ? 0.94 : 1.0;
    return [
      v * (0.96 + b * 0.08) * warm,
      v * (0.99 + (1 - b) * 0.03),
      v * (0.94 + a * 0.08),
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
        // The walk still opens its clearing (fewer trees along it), but the
        // brown dirt tread is not laid by default: the stylised reference
        // ground is clean lawn with no desire lines. opts.footpaths re-enables.
        if (!(this.opts && this.opts.footpaths)) continue;
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
      mesh.castShadow = !NO_SHADOW.has(def.key);
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
      // Which side face is the shade side: the key light's component along the
      // camera's screen-right axis (sun from the left -> right face is dark).
      if (ctx.sunDir) {
        const e = camera.matrixWorld.elements;   // column 0 = camera right in world
        const d = ctx.sunDir.x * e[0] + ctx.sunDir.y * e[1] + ctx.sunDir.z * e[2];
        this.uniforms.uPropToneSide.value = clamp(-d * 6, -1, 1);
      }
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
        m.castShadow = !NO_SHADOW.has(def.key) && !(q === 0 && def.group === 'veg');
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
    // (Round 9: roads.js sets bulbY = kerb top + 2.12 on every lamp anchor, so
    // the glow follows the slim lamp's head, not lighting.js's 4.2 default.)
    const head = lampBoxes().find((b) => b.ci === 202);
    const hy = LAMP_BULB_Y - PROP_Y;
    if (head && hy >= head.y0 && hy <= head.y1) ok('lamp head at y=' + LAMP_BULB_Y.toFixed(2) + ' (anchor bulbY from roads.js)');
    else fail('lamp bulb y=' + LAMP_BULB_Y.toFixed(2) + ' is not inside the lamp head box');

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
        if (p.x < 0 || p.z < 0 || p.x > MAP_W || p.z > MAP_W) {
          // ground r8: the off-map countryside band (pass 4) is intended
          const ob = OFF_BAND * TILE + 4;
          if (p.x < -ob || p.z < -ob || p.x > MAP_W + ob || p.z > MAP_W + ob) outOfBounds++;
          continue;
        }
        const tx = clamp(Math.floor(p.x / TILE), 0, N - 1);
        const tz = clamp(Math.floor(p.z / TILE), 0, N - 1);
        const m = state.map[tz * N + tx];
        if (m === T_WATER || m === T_ROAD || m === T_MOUNTAIN || m === T_TREE) offLimits++;
        if (state.occ[tz * N + tx] !== 0) offLimits++;
      }
    }
    if (outOfBounds) fail(outOfBounds + ' scattered props outside the map + off-map band');
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
      for (const key of OAK_FAMILY) for (const p of props._raw[TYPE_INDEX[key]]) sizes.add(Math.round(p.scale * 25));
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

      // Empty tiles inside a road-enclosed block are terrain.js vacant lots
      // (their own dressing, no scatter) — measured separately below.
      const blockM = cityBlockMask(state);
      const roi = new Uint8Array(N * N);
      let roiTiles = 0;
      for (let i = 0; i < N * N; i++) {
        const m = state.map[i];
        if (blockM[i]) continue;
        if ((m === T_GRASS || m === T_SAND) && state.occ[i] === 0 && uf[i] > 0.6) {
          roi[i] = 1; roiTiles++;
        }
      }
      const countIn = (P, pop) => {
        let n = 0;
        for (const key of ['oak', 'column', 'cluster', 'pine', 'blossom']) {
          for (const p of P._raw[TYPE_INDEX[key]]) {
            if (pop && p.pop !== pop) continue;
            const tx = clamp(Math.floor(p.x / TILE), 0, N - 1);
            const tz = clamp(Math.floor(p.z / TILE), 0, N - 1);
            if (roi[tz * N + tx]) n++;
          }
        }
        return n;
      };
      let onLots = 0, lotTiles = 0;
      for (let i = 0; i < N * N; i++) lotTiles += blockM[i];
      for (let t = 0; t < NT; t++) {
        if (TYPES[t].group !== 'veg') continue;
        for (const p of props._raw[t]) {
          const tx = clamp(Math.floor(p.x / TILE), 0, N - 1), tz = clamp(Math.floor(p.z / TILE), 0, N - 1);
          if (blockM[tz * N + tx]) onLots++;
        }
      }
      if (onLots === 0) ok('nothing natural grows through the ' + lotTiles + ' vacant city-block lots');
      else fail(onLots + ' scattered props stand on vacant city-block lots');
      if (roiTiles < 10) {
        ok('built-up density test skipped: only ' + roiTiles + ' open built-up tiles outside city blocks');
      } else {
      const withCity = countIn(props), noCity = countIn(p3);
      const cityWood = countIn(props, 'w'), cityStreet = countIn(props, 's');
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
      p3.dispose();
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
