// Blockville — iconmesh.js: CPU half of the menu-icon factory.
// Pure (no DOM, no renderer): turns an icon JOB into plain typed-array meshes
// that icons.js lights and renders into a small transparent PNG. Runs inside
// the icon Web Worker (src/iconworker.js) so the heavy model builders + voxel
// mesher (up to ~600 ms for a res-10 tower) never touch the main thread; the
// main-thread fallback in icons.js imports it lazily when workers are missing.
//
// Job kinds (all produce the SAME output shape):
//   { key, kind:'cat',    id, v }          a catalog building (+ parts + moving anim part)
//   { key, kind:'models', list:[{fn, args, ox, oz, oy, ry}] }
//                                          any models.js generator(s), e.g. two people
//   { key, kind:'mini',   name }           a small hand-authored voxel model (MINI below)
// Output: { key, parts:[{pos,nrm,col,ao,rough,idx}], box:[x0,y0,z0,x1,y1,z1],
//           foot:[w,d], az, glassy } — positions in world units, y up, x/z centred.
//
// Everything here is authored for Blockville (our own models + our own voxel
// doodles); no traced or third-party art.

import * as models from './models.js';
import { buildVoxelGeometry, modelRes, lodModel } from './render/voxel.js';

// ---------------------------------------------------------------------------
// Hand-authored mini voxel models (menu glyphs with no building to show).
// Own palette (hex, sRGB) passed to the mesher via opts.palette; indices stay
// < 200 so nothing is treated as a night window.
// ---------------------------------------------------------------------------
const MP = [
  0x000000,
  0xFFD23F, // 1 sunny yellow
  0xFB8500, // 2 orange
  0xFF5D5D, // 3 alert red
  0xFFFFFF, // 4 white
  0x2B6A99, // 5 deep blue
  0x8ECAE6, // 6 sky blue
  0x2FBF71, // 7 green
  0x86D94F, // 8 grass
  0x6B4A2E, // 9 wood dark
  0xE9B872, // 10 wood light
  0x3A3F47, // 11 graphite
  0xC9D1DA, // 12 silver
  0xFF9EC4, // 13 pink eraser
  0x9AA7B5, // 14 bin grey
  0x6F7C8A, // 15 bin dark
  0x3FA9F0, // 16 water
  0xE6D59A, // 17 sand
  0xFFE680, // 18 flame yellow
  0xE0A21F, // 19 gold dark
  0x74C73F, // 20 grass dark
  0xC73E3E, // 21 deep red
];

// sprite(rows, map, depth): extrude ASCII art (top row = top) into the X-Y
// plane, `depth` voxels deep along Z (front face = +Z, like building fronts).
function sprite(g, rows, map, depth, x0 = 0, y0 = 0, z0 = 0) {
  const H = rows.length;
  for (let r = 0; r < H; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ci = map[row[c]];
      if (!ci) continue;
      for (let d = 0; d < depth; d++) g.push([x0 + c, y0 + (H - 1 - r), z0 + d, ci]);
    }
  }
}
function fin(blocks, res = 1) {
  let sx = 1, sy = 1, sz = 1;
  for (const b of blocks) { sx = Math.max(sx, b[0] + 1); sy = Math.max(sy, b[1] + 1); sz = Math.max(sz, b[2] + 1); }
  return { sx, sy, sz, blocks, res };
}

const MINI = {
  // ✋ Move — a chunky open cartoon glove (pan the map)
  hand() {
    const g = [];
    sprite(g, [
      '......YY.....',
      '...YY.YY.....',
      '...YY.YY.YY..',
      '...YY.YY.YY..',
      '...YY.YY.YY.YY',
      '...YY.YY.YY.YY',
      '...YYYYYYYYYYY',
      'YY.YYYYYYYYYYY',
      '.YYYYYYYYYYYYY',
      '..YYYYYYYYYYYY',
      '...YYYYYYYYYY.',
      '....YYYYYYYY..',
      '....OOOOOOOO..',
      '....OOOOOOOO..',
    ], { Y: 1, O: 2 }, 3);
    return fin(g);
  },
  // 🎯 target — a bullseye board on a little easel with a dart in the middle
  target() {
    const g = [];
    const R = 6.4, cx = 6, cy = 8;
    for (let y = 0; y <= 15; y++) for (let x = 0; x <= 12; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > R) continue;
      const ring = Math.floor(d / 1.62);
      const ci = ring === 0 ? 3 : ring === 1 ? 4 : ring === 2 ? 3 : 4;
      const edge = d > R - 1.0;
      g.push([x, y, 2, edge ? 21 : ci]); g.push([x, y, 3, edge ? 21 : ci]);
    }
    // easel legs
    for (let y = 0; y < 4; y++) { g.push([3, y, 4, 9]); g.push([9, y, 4, 9]); g.push([6, y, 1, 9]); }
    // dart: shaft toward the viewer, yellow flights
    for (let z = 4; z <= 8; z++) g.push([6, 8, z, z < 6 ? 12 : 5]);
    g.push([6, 9, 8, 1]); g.push([6, 7, 8, 1]); g.push([5, 8, 8, 1]); g.push([7, 8, 8, 1]);
    return fin(g);
  },
  // ✏️ rename — a fat yellow pencil on the diagonal
  pencil() {
    const g = [];
    const L = 15, seen = new Set();
    for (let t = 0; t <= L; t += 0.25) {
      const px = 1.5 + t * 0.78, py = 1.5 + t * 0.78;
      const col = t < 1.6 ? 11 : t < 4 ? 10 : t < 11.5 ? 1 : t < 13 ? 12 : 13;
      const r = t < 1.6 ? 0.6 : t < 4 ? 0.6 + (t - 1.6) * 0.45 : 1.7;
      for (let x = Math.floor(px - r); x <= Math.ceil(px + r); x++) for (let y = Math.floor(py - r); y <= Math.ceil(py + r); y++) {
        // distance to the pencil axis (the x=y diagonal through px,py)
        const d = Math.abs((x - px) - (y - py)) / Math.SQRT2;
        const along = ((x - px) + (y - py)) / Math.SQRT2;
        if (d > r || Math.abs(along) > 0.4) continue;
        const k = x + ',' + y;
        if (seen.has(k) || x < 0 || y < 0) continue;
        seen.add(k);
        const stripe = col === 1 && d > 1.0 ? 2 : col;   // orange edge stripes on the body
        for (let z = 0; z < 3; z++) g.push([x, y, z, stripe]);
      }
    }
    return fin(g);
  },
  // 🗑️ delete — a friendly ribbed bin with a lid and handle
  trash() {
    const g = [];
    for (let y = 0; y < 9; y++) for (let x = 1; x < 10; x++) for (let z = 1; z < 10; z++) {
      const edge = x === 1 || x === 9 || z === 1 || z === 9;
      if (!edge && y > 0) continue;
      const rib = ((x === 1 || x === 9) && z % 2 === 0) || ((z === 1 || z === 9) && x % 2 === 0);
      g.push([x, y, z, rib && y > 0 && y < 8 ? 15 : 14]);
    }
    for (let x = 0; x < 11; x++) for (let z = 0; z < 11; z++) g.push([x, 9, z, 3]);
    for (let x = 3; x < 8; x++) for (let z = 4; z < 7; z++) if (x === 3 || x === 7 || z === 4) g.push([x, 10, 5, 21]);
    for (let x = 3; x < 8; x++) g.push([x, 11, 5, 21]);
    return fin(g);
  },
  // 🔑 join — a golden key
  key() {
    const g = [];
    sprite(g, [
      '.GGGG..........',
      'GGDDGG.........',
      'GD..DGGGGGGGGGG',
      'GD..DGGGGGGGGGG',
      'GGDDGG.....D.DD',
      '.GGGG......D.DD',
    ], { G: 1, D: 19 }, 2);
    return fin(g);
  },
  // 🚀 start — a stubby toy rocket on its fins
  rocket() {
    const g = [];
    const cx = 5, cz = 5;
    const rAt = (y) => (y < 2 ? 0 : y < 11 ? 3.1 : y < 13 ? 2.4 : y < 15 ? 1.6 : y < 16 ? 0.8 : -1);
    for (let y = 0; y < 17; y++) {
      const r = rAt(y);
      if (r < 0) continue;
      for (let x = 0; x < 11; x++) for (let z = 0; z < 11; z++) {
        const d = Math.hypot(x - cx, z - cz);
        if (y < 2) {                               // flame
          if (d <= 1.5) g.push([x, y, z, y === 0 ? 2 : 18]);
          continue;
        }
        if (d > r) continue;
        let ci = y >= 11 ? 3 : 4;                  // red nose, white body
        if (y === 7 || y === 8) { if (z > cz + 1.5 && Math.abs(x - cx) <= 1) ci = 6; } // porthole
        if (y === 6 || y === 9) { if (z > cz + 1.5 && Math.abs(x - cx) <= 1) ci = 5; }
        if (y === 2) ci = 12;
        g.push([x, y, z, ci]);
      }
    }
    // four fins
    for (let y = 2; y < 6; y++) {
      const reach = 5 - (y - 2) * 0.8;
      for (let k = 3; k <= reach + 2; k++) {
        g.push([cx + k, y, cz, 3]); g.push([cx - k, y, cz, 3]);
        g.push([cx, y, cz + k, 3]); g.push([cx, y, cz - k, 3]);
      }
    }
    const shifted = g.map((b) => [b[0] + 2, b[1], b[2] + 2, b[3]]);
    return fin(shifted);
  },
  // ⭐ recent — a plump star
  star() {
    const g = [];
    sprite(g, [
      '......Y......',
      '.....YYY.....',
      '.....YYY.....',
      '....YYYYY....',
      'YYYYYYYYYYYYY',
      '.YYYYYYYYYYY.',
      '..YYYYYYYYY..',
      '...YYYYYYY...',
      '...YYYYYYY...',
      '..YYYY.YYYY..',
      '..YYY...YYY..',
      '.YY.......YY.',
    ], { Y: 1 }, 3);
    return fin(g);
  },
  // 🗺️ projects — a little island with a flag planted on it
  map() {
    const g = [];
    const S = 12;
    for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) {
      g.push([x, 0, z, 16]);
      const d = Math.hypot((x - 5.5) * 1.0, (z - 5.5) * 1.25);
      if (d < 5.2) { g.push([x, 1, z, d > 4.2 ? 17 : 8]); if (d < 3.6) g.push([x, 2, z, (x + z) % 5 === 0 ? 20 : 8]); }
    }
    for (let y = 3; y < 11; y++) g.push([6, y, 6, 9]);
    // pennant: widest in the middle rows, tapering to a point
    const flagW = { 7: 2, 8: 4, 9: 4, 10: 2 };
    for (let y = 7; y < 11; y++) for (let x = 7; x < 7 + flagW[y]; x++) { g.push([x, y, 6, 3]); g.push([x, y, 5, 3]); }
    // a tiny tree
    for (let y = 3; y < 5; y++) g.push([3, y, 7, 9]);
    for (let x = 2; x < 5; x++) for (let z = 6; z < 9; z++) for (let y = 5; y < 7; y++) g.push([x, y, z, 7]);
    return fin(g);
  },
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const _lin = new Map();
function srgbToLin(hex) {
  let v = _lin.get(hex);
  if (v) return v;
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  v = [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
  _lin.set(hex, v);
  return v;
}

// A THREE.BufferGeometry from voxel.js -> transferable plain arrays, shifted
// by (ox,oy,oz) and optionally yawed by ry (radians, around Y).
function fromGeometry(geo, ox, oy, oz, ry) {
  const P = geo.getAttribute('position'), Nn = geo.getAttribute('normal');
  const C = geo.getAttribute('color'), A = geo.getAttribute('aoT'), M = geo.getAttribute('matParams');
  if (!P || !P.count) return null;
  const n = P.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const ao = new Float32Array(n), rough = new Float32Array(n);
  const c = Math.cos(ry || 0), s = Math.sin(ry || 0);
  for (let i = 0; i < n; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    pos[i * 3] = x * c + z * s + ox; pos[i * 3 + 1] = y + oy; pos[i * 3 + 2] = -x * s + z * c + oz;
    if (Nn) { const nx = Nn.getX(i), nz = Nn.getZ(i); nrm[i * 3] = nx * c + nz * s; nrm[i * 3 + 1] = Nn.getY(i); nrm[i * 3 + 2] = -nx * s + nz * c; }
    if (C) { col[i * 3] = C.getX(i); col[i * 3 + 1] = C.getY(i); col[i * 3 + 2] = C.getZ(i); }
    else { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.6; }
    ao[i] = A ? A.getX(i) : 1;
    rough[i] = M ? M.getX(i) : 0.6;
  }
  let idx = null;
  if (geo.index) { idx = new Uint32Array(geo.index.count); for (let i = 0; i < idx.length; i++) idx[i] = geo.index.getX(i); }
  try { geo.dispose(); } catch (_) { /* ignore */ }
  return { pos, nrm, col, ao, rough, idx };
}

// A smooth SURFACE part ({surf:{pos,nrm,ci,ao?,idx}}, CONTRACTS.md) -> arrays.
function fromSurf(surf, ox, oy, oz) {
  const n = (surf.pos.length / 3) | 0;
  if (!n) return null;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const ao = new Float32Array(n), rough = new Float32Array(n).fill(0.6);
  const pal = models.PALETTE || [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = surf.pos[i * 3] + ox; pos[i * 3 + 1] = surf.pos[i * 3 + 1] + oy; pos[i * 3 + 2] = surf.pos[i * 3 + 2] + oz;
    if (surf.nrm) { nrm[i * 3] = surf.nrm[i * 3]; nrm[i * 3 + 1] = surf.nrm[i * 3 + 1]; nrm[i * 3 + 2] = surf.nrm[i * 3 + 2]; }
    const hex = pal[surf.ci ? surf.ci[i] : 0];
    const l = srgbToLin(typeof hex === 'number' ? hex : 0x999999);
    col[i * 3] = l[0]; col[i * 3 + 1] = l[1]; col[i * 3 + 2] = l[2];
    ao[i] = surf.ao ? surf.ao[i] : 1;
  }
  const idx = surf.idx ? Uint32Array.from(surf.idx) : null;
  return { pos, nrm, col, ao, rough, idx };
}

function meshModel(model, opts, ox, oy, oz, ry) {
  if (!model) return null;
  if (model.surf) return fromSurf(model.surf, ox, oy, oz);
  if (!Array.isArray(model.blocks) || !model.blocks.length) return null;
  const o = Object.assign({ ao: true, aoAtlas: false, palette: models.PALETTE }, model.voxOpts || null, opts || null);
  // Icons are ~100 px: resample very fine models (res 8-12 homes/shops mesh in
  // 1-3 s at full res) to the largest divisor <= 6 — still ~2 px per voxel.
  const res = modelRes(model);
  // (small props — people, balloons — keep full res: their detail IS the icon)
  if (res > 6 && Math.max(model.sx, model.sy, model.sz) / res > 3) {
    let t = 4;
    for (let k = 6; k >= 2; k--) if (res % k === 0) { t = k; break; }
    try { const l = lodModel(model, t); if (l && l.blocks && l.blocks.length) model = l; } catch (_) { /* keep full res */ }
  }
  return fromGeometry(buildVoxelGeometry(model, o), ox, oy, oz, ry);
}

function boxOf(parts) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.pos;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] < b[0]) b[0] = a[i]; if (a[i + 1] < b[1]) b[1] = a[i + 1]; if (a[i + 2] < b[2]) b[2] = a[i + 2];
      if (a[i] > b[3]) b[3] = a[i]; if (a[i + 1] > b[4]) b[4] = a[i + 1]; if (a[i + 2] > b[5]) b[5] = a[i + 2];
    }
  }
  return b;
}

// ---------------------------------------------------------------------------
// meshJob(job) -> output (see header) | null
// ---------------------------------------------------------------------------
export function meshJob(job) {
  if (!job || !job.key) return null;
  const parts = [];
  let az = null, glassy = true;
  if (job.kind === 'cat') {
    const m = models.catalogModel(job.id, job.v | 0);
    if (!m) return null;
    parts.push(meshModel(m, null, 0, 0, 0, 0));
    for (const p of (m.parts || [])) parts.push(meshModel(p, null, 0, 0, 0, 0));
    // the moving piece (ferris wheel, carousel, rotor…) lives outside the base
    try {
      const an = models.catalogAnim && models.catalogAnim(job.id);
      if (an && an.part) {
        const h = (an.part.sy || 1) / modelRes(an.part);
        parts.push(meshModel(an.part, null, an.ox || 0, (an.oy || 0) - h / 2, an.oz || 0, 0));
      }
    } catch (_) { /* no anim */ }
  } else if (job.kind === 'models') {
    for (const it of (job.list || [])) {
      const f = models[it.fn];
      if (typeof f !== 'function') continue;
      const m = f.apply(null, it.args || []);
      parts.push(meshModel(m, null, it.ox || 0, it.oy || 0, it.oz || 0, it.ry || 0));
    }
  } else if (job.kind === 'mini') {
    const make = MINI[job.name];
    if (!make) return null;
    parts.push(meshModel(make(), { palette: MP }, 0, 0, 0, 0));
    az = job.az == null ? 0.42 : job.az;   // sprites turn more toward the viewer
    glassy = false;
  } else return null;
  const good = parts.filter(Boolean);
  if (!good.length) return null;
  const box = boxOf(good);
  return { key: job.key, parts: good, box, az: job.az != null ? job.az : az, glassy };
}

// Transfer list for postMessage (all the typed-array buffers).
export function transferables(out) {
  const t = [];
  for (const p of out.parts) for (const k of ['pos', 'nrm', 'col', 'ao', 'rough', 'idx']) if (p[k]) t.push(p[k].buffer);
  return t;
}

export const MINI_NAMES = Object.keys(MINI);
