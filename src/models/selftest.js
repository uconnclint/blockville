// Blockville models — _selfTest: iterate every generator, verify bounds,
// palette validity, catalog fields/caps, anim parts.

import { C, PALETTE } from './core.js';
import { treeModel } from './vegetation.js';
import { serviceModel } from './civic.js';
import { bridgeModel, constructionModel, roadModel } from './infra.js';
import { balloonModel, birdModel, boatModel, carModel, cloudModel, dogModel, personModel, smokePuffModel, sparkModel } from './vehicles.js';
import { _ENTRY_BY_ID, buildingModel, CATALOG, catalogAnim, catalogModel } from './catalog.js';

// ---------------------------------------------------------------------------
// _selfTest — iterate every generator, verify bounds + palette validity.
// ---------------------------------------------------------------------------
export function _selfTest() {
  const errors = [];
  const validColor = c => typeof PALETTE[c] === 'number';
  const check = (name, m) => {
    if (!m || typeof m !== 'object') { errors.push(name + ': not an object'); return; }
    const { sx, sy, sz, blocks } = m;
    if (!(Number.isInteger(sx) && sx > 0)) errors.push(name + ': bad sx=' + sx);
    if (!(Number.isInteger(sy) && sy > 0)) errors.push(name + ': bad sy=' + sy);
    if (!(Number.isInteger(sz) && sz > 0)) errors.push(name + ': bad sz=' + sz);
    if (m.res != null && !(Number.isInteger(m.res) && m.res >= 2 && m.res <= 20)) errors.push(name + ': bad res=' + m.res);
    if (!Array.isArray(blocks)) { errors.push(name + ': blocks not array'); return; }
    if (blocks.length === 0) errors.push(name + ': empty (no blocks)');
    for (const b of blocks) {
      if (!Array.isArray(b) || b.length !== 4) { errors.push(name + ': bad block ' + JSON.stringify(b)); continue; }
      const [x, y, z, c] = b;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z))
        errors.push(name + ': non-int coord ' + JSON.stringify(b));
      else if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz)
        errors.push(name + ': OOB ' + JSON.stringify(b) + ' size ' + sx + 'x' + sy + 'x' + sz);
      if (!validColor(c)) errors.push(name + ': bad color index ' + c);
    }
  };

  const wrap = (name, fn) => { try { check(name, fn()); } catch (e) { errors.push(name + ': threw ' + e); } };

  // buildings — every zone/level and several variants + hostile inputs
  for (const z of ['R', 'C', 'I', 'r', 'x', null, undefined]) {
    for (const l of [1, 2, 3, 0, 4, -1, 2.7, NaN]) {
      for (const v of [0, 1, 2, 3, 4, 5, 7, 255, -1, 999]) {
        wrap('building(' + z + ',' + l + ',' + v + ')', () => buildingModel(z, l, v));
      }
    }
  }
  // services
  for (const k of ['park', 'school', 'fire', 'fountain', 'stadium', 'power', 'zzz', null]) {
    for (const v of [0, 1, 2, 3, -1, 99]) wrap('service(' + k + ',' + v + ')', () => serviceModel(k, v));
  }
  // trees
  for (let v = -2; v <= 10; v++) wrap('tree(' + v + ')', () => treeModel(v));
  // roads — all 16 masks (+ out-of-range)
  for (let mask = 0; mask <= 16; mask++) wrap('road(' + mask + ')', () => roadModel(mask));
  // cars
  for (let v = -2; v <= 12; v++) wrap('car(' + v + ')', () => carModel(v));
  // people
  for (let v = 0; v <= 16; v++) wrap('person(' + v + ')', () => personModel(v));
  // birds / clouds / smoke / construction
  wrap('bird', () => birdModel());
  for (let v = -1; v <= 6; v++) wrap('cloud(' + v + ')', () => cloudModel(v));
  wrap('smoke', () => smokePuffModel());
  wrap('construction', () => constructionModel());

  // catalog — every entry × every variant, validate entry fields + footprint
  const seenIds = new Set();
  for (const cat of ['homes', 'shops', 'factories', 'fun', 'deco', 'downtown']) {
    const list = CATALOG[cat];
    if (!Array.isArray(list)) { errors.push('catalog: missing category ' + cat); continue; }
    for (const e of list) {
      if (!e || typeof e.id !== 'string' || !e.id) { errors.push('catalog(' + cat + '): bad id'); continue; }
      if (seenIds.has(e.id)) errors.push('catalog: duplicate id ' + e.id);
      seenIds.add(e.id);
      if (typeof e.name !== 'string' || !e.name) errors.push(e.id + ': bad name');
      if (typeof e.emoji !== 'string' || !e.emoji) errors.push(e.id + ': bad emoji');
      if (![1, 2, 3, 4].includes(e.tw) || ![1, 2, 3, 4].includes(e.td)) errors.push(e.id + ': bad tw/td');
      const capLo = cat === 'homes' ? 2 : cat === 'deco' ? 0 : 1;
      const capHi = cat === 'homes' ? 30 : cat === 'deco' ? 0 : 10;
      if (!(Number.isInteger(e.cap) && e.cap >= capLo && e.cap <= capHi)) errors.push(e.id + ': bad cap ' + e.cap);
      const minVar = (e.tw > 1 || e.td > 1) ? 2 : 3;
      if (!(Number.isInteger(e.variants) && e.variants >= minVar)) errors.push(e.id + ': bad variants ' + e.variants);
      // v3.1: height cap keyed by the larger footprint dimension.
      const HCAP = { 1: 48, 2: 64, 3: 56, 4: 64 };  // v3.2: raised so downtown towers can be dramatic
      for (let v = 0; v < (e.variants | 0); v++) {
        wrap('catalog(' + e.id + ',' + v + ')', () => {
          const m = catalogModel(e.id, v);
          if (!m) throw 'null model';
          // res (voxels per world unit) scales every cap: canvas ≤ tw*8*res - 1.
          const r = m.res || 1;
          const maxX = e.tw * 8 * r - 1, maxZ = e.td * 8 * r - 1, maxH = HCAP[Math.max(e.tw, e.td)] * r;
          if (m.tw !== e.tw || m.td !== e.td) throw 'tw/td mismatch (' + m.tw + ',' + m.td + ')';
          if (m.sx > maxX) throw 'sx ' + m.sx + ' > ' + maxX;
          if (m.sz > maxZ) throw 'sz ' + m.sz + ' > ' + maxZ;
          if (m.sy > maxH) throw 'height ' + m.sy + ' > ' + maxH;
          return m;
        });
      }
    }
  }
  if (catalogModel('does-not-exist', 0) !== null) errors.push('catalogModel: unknown id must return null');
  if (catalogModel(null, 0) !== null) errors.push('catalogModel: null id must return null');

  // ---- v2.1 category counts -------------------------------------------------
  const need = { homes: 12, shops: 18, factories: 14, fun: 14, deco: 10, downtown: 16 };
  for (const cat in need) {
    const n = (CATALOG[cat] || []).length;
    if (n < need[cat]) errors.push('count ' + cat + '=' + n + ' < ' + need[cat]);
  }

  // ---- v2.1 front-face heuristic --------------------------------------------
  // Facing convention: the front (door / storefront / windows) lands on the +Z
  // face. For homes + glass-fronted shops, verify the +Z half of the model is
  // glazed — it holds ≥1 glowing window/neon voxel. (A uniform window grid can be
  // a hair denser at the back from even-spacing rounding, so we require the front
  // be lit rather than a strict front>back count; "front is glazed at all" is the
  // load-bearing signal that the flip put the entrance on +Z.) Stalls skipped.
  const glow = new Set([200, 201, 203]);
  const openAir = new Set(['market-stall', 'fruit-stand']);
  for (const cat of ['homes', 'shops']) {
    for (const e of CATALOG[cat]) {
      if (openAir.has(e.id)) continue;
      for (let v = 0; v < (e.variants | 0); v++) {
        const m = catalogModel(e.id, v);
        if (!m) continue;
        let lit = false;
        // (midline row counts: the mall's entrance glazing sits at z = sz/2 - 0.5;
        // its lot cars' glass used to carry this test, they are a res-8 part now)
        for (const b of m.blocks) if (glow.has(b[3]) && b[2] * 2 >= m.sz - 1) { lit = true; break; }
        if (!lit) errors.push('front-face ' + e.id + '#' + v + ': +Z face not glazed');
      }
    }
  }

  // ---- v2.2 new generators --------------------------------------------------
  // (deco entries validated by the catalog loop above under cat 'deco'.)
  // bridges — all 16 masks: deck present, 8×?×8 footprint, y >= 0.
  for (let mask = 0; mask <= 15; mask++) {
    wrap('bridge(' + mask + ')', () => {
      const m = bridgeModel(mask);
      const r = m.res || 1; if (m.sx / r !== 8 || m.sz / r !== 8) throw 'bridge not one tile (' + m.sx + 'x' + m.sz + ' @res ' + r + ')';
      return m;
    });
  }
  // boats / dogs / balloons / sparks (hostile inputs included)
  for (let v = -2; v <= 6; v++) wrap('boat(' + v + ')', () => boatModel(v));
  for (let v = -2; v <= 8; v++) wrap('dog(' + v + ')', () => {
    const m = dogModel(v), r = m.res || 1; if (m.sx / r > 3 || m.sy / r > 3 || m.sz / r > 4) throw 'dog too big'; return m;
  });
  for (let v = -2; v <= 10; v++) wrap('balloon(' + v + ')', () => {
    const m = balloonModel(v), r = m.res || 1; if (m.sx / r > 3 || m.sy / r > 6 || m.sz / r > 3) throw 'balloon too big'; return m;
  });
  for (let v = -2; v <= 12; v++) wrap('spark(' + v + ')', () => {
    const m = sparkModel(v); if (m.sx > 2 || m.sy > 2 || m.sz > 2) throw 'spark not 2x2x2'; return m;
  });

  // catalogAnim — parts are valid models with finite offsets/axis; base+part
  // each non-empty; and the base no longer contains the part's silhouette.
  const animIds = ['ferris-wheel', 'carousel', 'wind-power', 'fountain', 'barber'];
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  for (const id of animIds) {
    const a = catalogAnim(id);
    if (!a) { errors.push('anim ' + id + ': returned null'); continue; }
    if (!finite(a.ox) || !finite(a.oy) || !finite(a.oz)) errors.push('anim ' + id + ': non-finite offset');
    if (!finite(a.ax) || !finite(a.ay) || !finite(a.az)) errors.push('anim ' + id + ': non-finite axis');
    if ((a.ax * a.ax + a.ay * a.ay + a.az * a.az) < 0.5) errors.push('anim ' + id + ': zero-length axis');
    if (!finite(a.speed) || a.speed <= 0) errors.push('anim ' + id + ': bad speed ' + a.speed);
    // v3.1: offsets must sit within the resized footprint's world extent + height cap.
    const ae = _ENTRY_BY_ID[id];
    if (ae) {
      const span = Math.max(ae.tw, ae.td) * 8, hcap = ({ 1: 48, 2: 64, 3: 56, 4: 64 })[Math.max(ae.tw, ae.td)];
      if (Math.abs(a.ox) > span || Math.abs(a.oz) > span) errors.push('anim ' + id + ': lateral offset out of footprint');
      if (a.oy < 0 || a.oy > hcap + 12) errors.push('anim ' + id + ': oy ' + a.oy + ' out of range');
    }
    check('anim-part ' + id, a.part);
    const base = catalogModel(id, 0);
    if (!base) { errors.push('anim ' + id + ': base model null'); continue; }
    if (!(base.blocks && base.blocks.length >= 1)) errors.push('anim ' + id + ': empty base');
    if (!(a.part && a.part.blocks && a.part.blocks.length >= 1)) errors.push('anim ' + id + ': empty part');
    // map part voxels into the base-local frame and count coincidences
    const baseSet = new Set(base.blocks.map(b => b[0] + ',' + b[1] + ',' + b[2]));
    // (part voxel - part centre) / partRes + offset = world; × baseRes = base voxel
    const pcx = (a.part.sx - 1) / 2, pcy = (a.part.sy - 1) / 2, pcz = (a.part.sz - 1) / 2;
    const bcx = (base.sx - 1) / 2, bcz = (base.sz - 1) / 2;
    const pr = a.part.res || 1, br = base.res || 1;
    let overlap = 0;
    for (const b of a.part.blocks) {
      const bx = Math.round(((b[0] - pcx) / pr + a.ox) * br + bcx);
      const by = Math.round(((b[1] - pcy) / pr + a.oy) * br);
      const bz = Math.round(((b[2] - pcz) / pr + a.oz) * br + bcz);
      if (baseSet.has(bx + ',' + by + ',' + bz)) overlap++;
    }
    if (overlap * 2 >= a.part.blocks.length)
      errors.push('anim ' + id + ': base still contains part (' + overlap + '/' + a.part.blocks.length + ')');
  }
  // non-animated ids return null
  for (const id of ['small-house', 'bakery', 'park', 'bench', 'stadium', 'does-not-exist'])
    if (catalogAnim(id) !== null) errors.push('catalogAnim(' + id + ') should be null');

  return { ok: errors.length === 0, errors };
}
