// tools/rendertest/mesher.js — LOCAL harness-only voxel mesher.
//
// This is a throwaway stand-in for src/render/voxel.js (owned by another
// agent). It produces the exact attribute set materials.js consumes so the
// shader path is fully exercised:
//   position, normal, color, glowColor, emissiveT, aoT, matParams
// Do not use this in the game.

import * as THREE from '../../vendor/three.module.js';
import { materialParamsFor } from '../../src/render/materials.js';

const GLOW_WARM = 0xffd98a, GLOW_COOL = 0xbfeaff, GLOW_LAMP = 0xffe9a8;

const _c = new THREE.Color();
function lin(hex) { _c.setHex(hex, THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; }

export function makePaletteTables(PALETTE) {
  const pal = [], glow = [], mat = [];
  for (let i = 0; i < PALETTE.length; i++) {
    const hex = PALETTE[i];
    if (hex === undefined || hex === null) continue;
    pal[i] = lin(hex);
    const p = materialParamsFor(i, hex);
    mat[i] = [p.roughness, p.metalness];
  }
  glow[200] = lin(GLOW_WARM);
  glow[201] = lin(GLOW_COOL);
  glow[202] = lin(GLOW_LAMP);
  const base = pal[203] || lin(0xff36c0);
  glow[203] = [
    Math.min(1, base[0] * 1.7 + 0.1),
    Math.min(1, base[1] * 1.7 + 0.1),
    Math.min(1, base[2] * 1.7 + 0.1),
  ];
  return { pal, glow, mat };
}

// Classic voxel corner AO: 0..3 occluders -> 1.0 .. 0.35
const AO_LUT = [1.0, 0.78, 0.58, 0.38];
function aoLevel(side1, side2, corner) {
  if (side1 && side2) return 3;
  return (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0);
}

export function buildVoxelGeometry(model, tables, opts = {}) {
  // NOTE: a real micro-bevel needs rim geometry (voxel.js's job). Insetting
  // faces without rims just opens see-through gaps, so the harness meshes flush
  // and lets the per-vertex AO do the block separation.
  const bevel = opts.bevel === undefined ? 0 : opts.bevel;
  const useAO = opts.ao !== false;
  const sx = model.sx || 1, sy = model.sy || 1, sz = model.sz || 1;
  const blocks = model.blocks;
  const hx = sx / 2, hz = sz / 2;

  const occ = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    occ.add(b[0] + ',' + b[1] + ',' + b[2]);
  }
  const at = (x, y, z) => occ.has(x + ',' + y + ',' + z);

  const pos = [], nor = [], col = [], glo = [], emi = [], aoA = [], mpA = [];

  // Push a quad given 4 corners (a,b,c,d in CCW around the normal) and their
  // AO values. Flip the triangulation when needed to avoid the classic
  // voxel-AO diagonal seam.
  function pushQuad(P, n, c, g, e, mp, ao) {
    const flip = (ao[0] + ao[2]) < (ao[1] + ao[3]);
    const order = flip ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 6; k++) {
      const i = order[k];
      pos.push(P[i][0], P[i][1], P[i][2]);
      nor.push(n[0], n[1], n[2]);
      col.push(c[0], c[1], c[2]);
      glo.push(g[0], g[1], g[2]);
      emi.push(e);
      aoA.push(useAO ? ao[i] : 1);
      mpA.push(mp[0], mp[1]);
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const vx = b[0], vy = b[1], vz = b[2], ci = b[3];
    const c = tables.pal[ci] || [0.6, 0.6, 0.62];
    const isWin = ci >= 200;
    const e = isWin ? 1 : 0;
    const g = isWin ? (tables.glow[ci] || tables.glow[200]) : c;
    const mp = tables.mat[ci] || [0.72, 0.0];

    const bv = bevel;
    const x0 = vx - hx + bv, x1 = vx - hx + 1 - bv;
    const y0 = vy + bv, y1 = vy + 1 - bv;
    const z0 = vz - hz + bv, z1 = vz - hz + 1 - bv;

    // +Y
    if (!at(vx, vy + 1, vz)) {
      const y = vy + 1;
      const ao = [
        AO_LUT[aoLevel(at(vx - 1, y, vz), at(vx, y, vz - 1), at(vx - 1, y, vz - 1))],
        AO_LUT[aoLevel(at(vx - 1, y, vz), at(vx, y, vz + 1), at(vx - 1, y, vz + 1))],
        AO_LUT[aoLevel(at(vx + 1, y, vz), at(vx, y, vz + 1), at(vx + 1, y, vz + 1))],
        AO_LUT[aoLevel(at(vx + 1, y, vz), at(vx, y, vz - 1), at(vx + 1, y, vz - 1))],
      ];
      pushQuad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], c, g, e, mp, ao);
    }
    // -Y
    if (vy > 0 && !at(vx, vy - 1, vz)) {
      const y = vy - 1;
      const ao = [
        AO_LUT[aoLevel(at(vx - 1, y, vz), at(vx, y, vz + 1), at(vx - 1, y, vz + 1))],
        AO_LUT[aoLevel(at(vx - 1, y, vz), at(vx, y, vz - 1), at(vx - 1, y, vz - 1))],
        AO_LUT[aoLevel(at(vx + 1, y, vz), at(vx, y, vz - 1), at(vx + 1, y, vz - 1))],
        AO_LUT[aoLevel(at(vx + 1, y, vz), at(vx, y, vz + 1), at(vx + 1, y, vz + 1))],
      ];
      pushQuad([[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], [0, -1, 0], c, g, e, mp, ao);
    }
    // -Z
    if (!at(vx, vy, vz - 1)) {
      const z = vz - 1;
      const ao = [
        AO_LUT[aoLevel(at(vx + 1, vy, z), at(vx, vy - 1, z), at(vx + 1, vy - 1, z))],
        AO_LUT[aoLevel(at(vx - 1, vy, z), at(vx, vy - 1, z), at(vx - 1, vy - 1, z))],
        AO_LUT[aoLevel(at(vx - 1, vy, z), at(vx, vy + 1, z), at(vx - 1, vy + 1, z))],
        AO_LUT[aoLevel(at(vx + 1, vy, z), at(vx, vy + 1, z), at(vx + 1, vy + 1, z))],
      ];
      pushQuad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], c, g, e, mp, ao);
    }
    // +Z
    if (!at(vx, vy, vz + 1)) {
      const z = vz + 1;
      const ao = [
        AO_LUT[aoLevel(at(vx - 1, vy, z), at(vx, vy - 1, z), at(vx - 1, vy - 1, z))],
        AO_LUT[aoLevel(at(vx + 1, vy, z), at(vx, vy - 1, z), at(vx + 1, vy - 1, z))],
        AO_LUT[aoLevel(at(vx + 1, vy, z), at(vx, vy + 1, z), at(vx + 1, vy + 1, z))],
        AO_LUT[aoLevel(at(vx - 1, vy, z), at(vx, vy + 1, z), at(vx - 1, vy + 1, z))],
      ];
      pushQuad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], c, g, e, mp, ao);
    }
    // -X
    if (!at(vx - 1, vy, vz)) {
      const x = vx - 1;
      const ao = [
        AO_LUT[aoLevel(at(x, vy, vz - 1), at(x, vy - 1, vz), at(x, vy - 1, vz - 1))],
        AO_LUT[aoLevel(at(x, vy, vz + 1), at(x, vy - 1, vz), at(x, vy - 1, vz + 1))],
        AO_LUT[aoLevel(at(x, vy, vz + 1), at(x, vy + 1, vz), at(x, vy + 1, vz + 1))],
        AO_LUT[aoLevel(at(x, vy, vz - 1), at(x, vy + 1, vz), at(x, vy + 1, vz - 1))],
      ];
      pushQuad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], c, g, e, mp, ao);
    }
    // +X
    if (!at(vx + 1, vy, vz)) {
      const x = vx + 1;
      const ao = [
        AO_LUT[aoLevel(at(x, vy, vz + 1), at(x, vy - 1, vz), at(x, vy - 1, vz + 1))],
        AO_LUT[aoLevel(at(x, vy, vz - 1), at(x, vy - 1, vz), at(x, vy - 1, vz - 1))],
        AO_LUT[aoLevel(at(x, vy, vz - 1), at(x, vy + 1, vz), at(x, vy + 1, vz - 1))],
        AO_LUT[aoLevel(at(x, vy, vz + 1), at(x, vy + 1, vz), at(x, vy + 1, vz + 1))],
      ];
      pushQuad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], c, g, e, mp, ao);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('glowColor', new THREE.Float32BufferAttribute(glo, 3));
  geo.setAttribute('emissiveT', new THREE.Float32BufferAttribute(emi, 1));
  geo.setAttribute('aoT', new THREE.Float32BufferAttribute(aoA, 1));
  geo.setAttribute('matParams', new THREE.Float32BufferAttribute(mpA, 2));
  geo.computeBoundingSphere();
  return geo;
}

// A flat slab of one palette index — used by the material inspector row.
export function slabModel(ci, w = 6, h = 6, d = 2) {
  const blocks = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) blocks.push([x, y, z, ci]);
  return { sx: w, sy: h, sz: d, blocks };
}
