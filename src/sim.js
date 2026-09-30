// sim.js — Blockville SANDBOX simulation core.
// Pure logic: no three.js, no DOM. Only imports ./constants.js.
// Owns `state` (read-only to everyone else). All public methods are defensive:
// bad args never throw, they return a safe value.
//
// Plain sandbox: nothing to manage. No money, no residents or jobs, no happiness or
// air, no goals. Kids pick a specific building (a CATALOG ENTRY) and place it
// instantly; buildings may cover a tw×td footprint. The sim only knows the map,
// what was built, and the day/night clock (life.js sizes traffic from the buildings).

import { T, N, DAY_LENGTH, idx, inBounds } from './constants.js';

// ---- small helpers -------------------------------------------------------

// Seeded PRNG so a saved seed reproduces the same terrain on load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Category → the zone type recorded in state.zoneOf for a building's tiles.
// life.js keys smoke off zoneOf === ZONE_I, so factories MUST map to ZONE_I.
function catZone(cat) {
  if (cat === 'homes') return T.ZONE_R;
  if (cat === 'factories') return T.ZONE_I;
  return T.ZONE_C; // shops + fun
}

// =========================================================================

export class Sim {
  constructor(seed, catalog) {
    const s = (seed >>> 0) || ((Math.random() * 0xffffffff) >>> 0) || 1;
    this._rand = mulberry32(s);

    // Catalog lookup (id -> {cat, tw, td, variants}). Injected via setCatalog too.
    this._byId = new Map();
    if (catalog) this.setCatalog(catalog);

    this.state = {
      map: new Uint8Array(N * N),        // tile type T.* (index = z*N + x)
      zoneOf: new Uint8Array(N * N),     // for BLDG tiles: ZONE_R/C/I; else 0
      level: new Uint8Array(N * N),      // 1 on placed-building tiles; else 0
      variant: new Uint8Array(N * N),    // visual variant on a building's anchor tile
      occ: new Int32Array(N * N),        // building bid occupying tile (0 = free)
      bridge: new Uint8Array(N * N),     // 1 on a ROAD tile that sits over water
      buildings: [],                     // [{bid,type,cat,x,z,tw,td,variant}]
      nextBid: 1,
      day: 1, clock: 0.3, speed: 1,
      seed: s,
    };

    this._events = [];
    this._generateBaseTerrain();
  }

  // Register the building catalog so load() can reconstruct footprints.
  // CATALOG = { homes:[ENTRY..], shops:[..], factories:[..], fun:[..] }.
  setCatalog(catalog) {
    this._byId = new Map();
    if (!catalog || typeof catalog !== 'object') return;
    for (const cat of Object.keys(catalog)) {
      const list = catalog[cat];
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!e || !e.id) continue;
        this._byId.set(e.id, {
          cat,
          tw: (e.tw | 0) || 1,
          td: (e.td | 0) || 1,
          variants: (e.variants | 0) || 1,
        });
      }
    }
  }

  // ---- terrain -----------------------------------------------------------

  // Reset the world to open grass. (Before v3.8 this grew a seeded ocean,
  // lakes, rivers, mountains and forest; the map is now small enough that every
  // tile should be buildable.)
  _generateBaseTerrain() {
    const st = this.state;
    const { map, variant } = st;
    map.fill(T.GRASS);
    st.zoneOf.fill(0);
    st.level.fill(0);
    variant.fill(0);
    st.occ.fill(0);
    st.bridge.fill(0);

    // v3.8: the whole (smaller, 40x40) map is open buildable grass — no
    // ocean, lakes, rivers or mountains taking up room kids could build on.
    // Water still appears under saved bridges (load forces it back).
  }

  _randByte() { return Math.floor(this._rand() * 256) & 255; }

  // ---- placement ---------------------------------------------------------

  // Validate an effective footprint (etw×etd) anchored NW at (x,z).
  // Returns null when it fits, else the failure reason
  // ('bounds' | 'terrain' | 'occupied').
  _footprintReason(x, z, etw, etd) {
    const st = this.state;
    for (let dz = 0; dz < etd; dz++) {
      for (let dx = 0; dx < etw; dx++) {
        const tx = x + dx, tz = z + dz;
        if (!inBounds(tx, tz)) return 'bounds';
        const i = idx(tx, tz);
        const m = st.map[i];
        if (m === T.WATER || m === T.SAND || m === T.MOUNTAIN) return 'terrain';
        if (m !== T.GRASS || st.occ[i] !== 0) return 'occupied';
      }
    }
    return null;
  }

  // Count ROAD tiles along the FRONT edge of an effective footprint for rot k.
  // Front faces: 0→S(+Z), 1→E(+X), 2→N(−Z), 3→W(−X). Out-of-bounds tiles count 0.
  _frontRoadCount(x, z, etw, etd, k) {
    const st = this.state;
    const isRoad = (tx, tz) => inBounds(tx, tz) && st.map[idx(tx, tz)] === T.ROAD;
    let n = 0;
    if (k === 0) {          // row below: z+etd, x..x+etw-1
      const tz = z + etd;
      for (let tx = x; tx < x + etw; tx++) if (isRoad(tx, tz)) n++;
    } else if (k === 1) {   // column right: x+etw, z..z+etd-1
      const tx = x + etw;
      for (let tz = z; tz < z + etd; tz++) if (isRoad(tx, tz)) n++;
    } else if (k === 2) {   // row above: z-1, x..x+etw-1
      const tz = z - 1;
      for (let tx = x; tx < x + etw; tx++) if (isRoad(tx, tz)) n++;
    } else {                // column left: x-1, z..z+etd-1
      const tx = x - 1;
      for (let tz = z; tz < z + etd; tz++) if (isRoad(tx, tz)) n++;
    }
    return n;
  }

  // Decide the best rotation for placing `entry` anchored NW at (x,z).
  // For each rot k in 0..3, k odd swaps tw/td for the effective dims. Among the
  // rotations whose effective footprint fits, pick the one whose FRONT edge is
  // adjacent to the most ROAD tiles; ties / no road → first valid k (0,1,2,3).
  // Returns { ok:true, rot, etw, etd } or { ok:false, reason } (prefers the k=0
  // failure reason as the most informative).
  plan(entry, x, z) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'terrain' };
    x |= 0; z |= 0;
    const tw = (entry.tw | 0) || 1;
    const td = (entry.td | 0) || 1;

    let best = null;            // { rot, etw, etd, count }
    let firstReason = null;     // failure reason for the earliest k (prefer k=0)
    for (let k = 0; k < 4; k++) {
      const etw = (k & 1) ? td : tw;
      const etd = (k & 1) ? tw : td;
      const reason = this._footprintReason(x, z, etw, etd);
      if (reason) {
        if (firstReason === null) firstReason = reason;
        continue;
      }
      const count = this._frontRoadCount(x, z, etw, etd, k);
      if (!best || count > best.count) best = { rot: k, etw, etd, count };
    }

    if (best) return { ok: true, rot: best.rot, etw: best.etw, etd: best.etd };
    return { ok: false, reason: firstReason || 'terrain' };
  }

  // Place a catalog building. `entry` = { id, cat, tw, td, variants }.
  // Uses plan() to auto-rotate the building so its front faces an adjacent road.
  // Returns { ok, reason?, bid }. reason ∈ 'bounds' | 'terrain' | 'occupied'.
  place(entry, x, z, variant) {
    const st = this.state;
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'terrain' };
    x |= 0; z |= 0;

    const cat = entry.cat || (this._byId.get(entry.id) && this._byId.get(entry.id).cat) || 'homes';

    // Choose the rotation + effective footprint.
    const pl = this.plan(entry, x, z);
    if (!pl.ok) return { ok: false, reason: pl.reason };
    const { rot, etw, etd } = pl;

    // Pick a visual variant.
    const nvar = (entry.variants | 0) || 1;
    let v;
    if (Number.isFinite(variant)) v = clamp(variant | 0, 0, Math.max(0, nvar - 1));
    else v = Math.floor(this._rand() * nvar);

    const bid = st.nextBid++;
    const zone = catZone(cat);
    for (let dz = 0; dz < etd; dz++) {
      for (let dx = 0; dx < etw; dx++) {
        const i = idx(x + dx, z + dz);
        st.occ[i] = bid;
        st.map[i] = T.BLDG;
        st.zoneOf[i] = zone;
        st.level[i] = 1;
        st.variant[i] = 0;
      }
    }
    st.variant[idx(x, z)] = v & 255; // variant lives on the anchor tile

    // tw/td stored as the EFFECTIVE dims so bulldoze/refresh logic is unchanged.
    st.buildings.push({ bid, type: entry.id, cat, x, z, tw: etw, td: etd, rot, variant: v });
    this._events.push({ type: 'placed', bid, entry, x, z, variant: v, rot, etw, etd });
    return { ok: true, bid };
  }

  // Road paints on grass or sand. Returns { ok, reason? }.
  placeRoad(x, z) {
    const st = this.state;
    x |= 0; z |= 0;
    if (!inBounds(x, z)) return { ok: false, reason: 'bounds' };
    const i = idx(x, z);
    if (st.occ[i] !== 0) return { ok: false, reason: 'occupied' };
    const m = st.map[i];
    if (m === T.ROAD) return { ok: false, reason: 'occupied' };
    if (m === T.MOUNTAIN) return { ok: false, reason: 'terrain' }; // scenery, not buildable
    if (m === T.GRASS || m === T.SAND) {
      st.map[i] = T.ROAD;
      st.variant[i] = 0;
      st.bridge[i] = 0;
      return { ok: true };
    }
    if (m === T.WATER) { // bridge: road spans the water
      st.map[i] = T.ROAD;
      st.variant[i] = 0;
      st.bridge[i] = 1;
      return { ok: true };
    }
    return { ok: false, reason: 'occupied' };
  }

  // Tree paints on grass only. Returns { ok, reason? }.
  placeTree(x, z) {
    const st = this.state;
    x |= 0; z |= 0;
    if (!inBounds(x, z)) return { ok: false, reason: 'bounds' };
    const i = idx(x, z);
    if (st.occ[i] !== 0) return { ok: false, reason: 'occupied' };
    const m = st.map[i];
    if (m === T.GRASS) {
      st.map[i] = T.TREE;
      st.variant[i] = this._randByte();
      return { ok: true };
    }
    return { ok: false, reason: m === T.WATER || m === T.SAND || m === T.MOUNTAIN ? 'terrain' : 'occupied' };
  }

  // Remove whatever is on (x,z): a building (whole footprint), a road, or a tree.
  // Natural terrain (water/sand/grass) is not bulldozable. Returns { ok, removed? }.
  bulldoze(x, z) {
    const st = this.state;
    x |= 0; z |= 0;
    if (!inBounds(x, z)) return { ok: false, reason: 'bounds' };
    const i = idx(x, z);

    const bid = st.occ[i];
    if (bid !== 0) {
      const bi = st.buildings.findIndex((b) => b.bid === bid);
      const b = bi >= 0 ? st.buildings[bi] : null;
      if (!b) { // orphan occ — clear just this tile defensively
        this._clearTile(i);
        return { ok: true };
      }
      for (let dz = 0; dz < b.td; dz++) {
        for (let dx = 0; dx < b.tw; dx++) {
          if (inBounds(b.x + dx, b.z + dz)) this._clearTile(idx(b.x + dx, b.z + dz));
        }
      }
      st.buildings.splice(bi, 1);
      this._events.push({ type: 'removed', bid, x: b.x, z: b.z, tw: b.tw, td: b.td });
      return { ok: true, removed: bid };
    }

    const m = st.map[i];
    if (m === T.ROAD && st.bridge[i] === 1) { // bridge road → restore water
      this._clearTile(i);
      st.map[i] = T.WATER;
      st.bridge[i] = 0;
      return { ok: true };
    }
    if (m === T.ROAD) {
      this._clearTile(i);
      return { ok: true };
    }
    if (m === T.TREE) {
      this._clearTile(i);
      return { ok: true };
    }
    return { ok: false, reason: 'terrain' }; // grass/water/sand
  }

  _clearTile(i) {
    const st = this.state;
    st.map[i] = T.GRASS;
    st.zoneOf[i] = 0;
    st.level[i] = 0;
    st.variant[i] = 0;
    st.occ[i] = 0;
    st.bridge[i] = 0;
  }

  // ---- tick --------------------------------------------------------------

  // Advances clock/day only, then RETURNS the drained events. Callers must
  // never see the same event twice.
  tick(dt) {
    const st = this.state;
    if (Number.isFinite(dt) && dt > 0) {
      st.clock += dt / DAY_LENGTH;
      while (st.clock >= 1) { st.clock -= 1; st.day++; }
    }
    const out = this._events;
    this._events = [];
    return out;
  }

  // ---- queries -----------------------------------------------------------

  // Explicit drain (tick already drains; kept for symmetry).
  events() {
    const out = this._events;
    this._events = [];
    return out;
  }

  roadGraph() {
    const { map } = this.state;
    const isRoad = (x, z) => inBounds(x, z) && map[idx(x, z)] === T.ROAD;
    return {
      isRoad,
      neighbors: (x, z) => {
        const out = [];
        if (isRoad(x + 1, z)) out.push({ x: x + 1, z });
        if (isRoad(x - 1, z)) out.push({ x: x - 1, z });
        if (isRoad(x, z + 1)) out.push({ x, z: z + 1 });
        if (isRoad(x, z - 1)) out.push({ x, z: z - 1 });
        return out;
      },
    };
  }

  // ---- save / load -------------------------------------------------------

  // Compact format: base terrain is rebuilt from the seed; only the player's
  // roads, trees and buildings are stored.
  save() {
    const st = this.state;
    const roads = [];
    const trees = [];
    const bridges = [];
    for (let i = 0; i < st.map.length; i++) {
      if (st.map[i] === T.ROAD) { roads.push(i); if (st.bridge[i] === 1) bridges.push(i); }
      else if (st.map[i] === T.TREE) trees.push(i);
    }
    const obj = {
      v: 2,
      n: N,               // map side at save time; load() remaps flat indices if it differs
      seed: st.seed,
      day: st.day,
      clock: st.clock,
      roads,
      trees,
      buildings: st.buildings.map((b) => {
        const rec = { t: b.type, x: b.x, z: b.z, v: b.variant };
        if ((b.rot | 0) !== 0) rec.r = b.rot | 0; // omit r when rot === 0 (compact)
        return rec;
      }),
    };
    if (bridges.length) obj.bridges = bridges; // omit the key when no bridges
    return JSON.stringify(obj);
  }

  // Reconstruct occ/map/zoneOf from the buildings list. Needs a catalog
  // (call setCatalog first). Returns false on anything malformed or v !== 2.
  load(str) {
    try {
      const d = JSON.parse(str);
      if (!d || typeof d !== 'object' || d.v !== 2) return false;
      const seed = (d.seed >>> 0) || this.state.seed || 1;
      if (!Array.isArray(d.buildings) || !Array.isArray(d.roads) || !Array.isArray(d.trees)) {
        return false;
      }

      const st = this.state;
      st.seed = seed;

      // MIGRATION: flat indices i=z*savedN+x break when N changed. A missing
      // `n` means a pre-v3.1 save (N was 48). Remap every flat index into the
      // current grid; drop any tile that falls outside the (possibly smaller) map.
      const savedN = (d.n | 0) || 48;
      // Shrinking (v3.8: 80 -> 40) keeps the MIDDLE of the old map, where the
      // old central build box was; growing keeps the old NW-anchored layout.
      const off = savedN > N ? Math.floor((savedN - N) / 2) : 0;
      const remap = (i) => {
        if (!Number.isInteger(i) || i < 0) return -1;
        if (savedN === N) return i < st.map.length ? i : -1;
        const ox = i % savedN - off, oz = Math.floor(i / savedN) - off;
        if (ox < 0 || oz < 0 || ox >= N || oz >= N) return -1; // out of the new bounds → drop
        return oz * N + ox;
      };

      // Reset to open grass. v3.8 has no generated water, so a saved bridge
      // (road over water) comes back as ordinary road.
      this._rand = mulberry32(seed);
      this._generateBaseTerrain();
      // Player-placed roads (bridge tiles are ROAD in map, listed here too).
      for (const raw of d.roads) {
        const i = remap(raw);
        if (i < 0) continue;
        if (st.map[i] === T.GRASS || st.map[i] === T.SAND) {
          st.map[i] = T.ROAD;
        }
      }
      // Player-placed trees.
      for (const raw of d.trees) {
        const i = remap(raw);
        if (i >= 0 && st.map[i] === T.GRASS) {
          st.map[i] = T.TREE;
          st.variant[i] = this._randByte();
        }
      }

      // Buildings — reconstruct footprints from the catalog.
      st.buildings = [];
      st.nextBid = 1;
      for (const rec of d.buildings) {
        if (!rec || typeof rec.t !== 'string') continue;
        const info = this._byId.get(rec.t);
        if (!info) continue; // unknown type without catalog — skip safely
        let x = (rec.x | 0) - off, z = (rec.z | 0) - off;
        const { cat } = info;
        // Effective dims: catalog dims, swapped when rot is odd. Missing r → 0.
        const rot = (rec.r | 0) & 3;
        const etw = (rot & 1) ? info.td : info.tw;
        const etd = (rot & 1) ? info.tw : info.td;
        // Skip if effective footprint doesn't fit on clear grass.
        const fitsAt = (ax, az) => {
          for (let dz = 0; dz < etd; dz++) for (let dx = 0; dx < etw; dx++) {
            const tx = ax + dx, tz = az + dz;
            if (!inBounds(tx, tz) || st.map[idx(tx, tz)] !== T.GRASS || st.occ[idx(tx, tz)] !== 0) return false;
          }
          return true;
        };
        // (civic r8) A catalog footprint can grow between versions (school,
        // fire station, fountain and pool went 1×1 → 2×2). Keep an old save's
        // building by trying the other anchors whose footprint still covers
        // the saved tile before giving up on it.
        let fits = fitsAt(x, z);
        for (let oz = 0; oz < etd && !fits; oz++) for (let ox = 0; ox < etw && !fits; ox++) {
          if ((ox || oz) && fitsAt(x - ox, z - oz)) { x -= ox; z -= oz; fits = true; }
        }
        if (!fits) continue;
        const bid = st.nextBid++;
        const zone = catZone(cat);
        const v = (rec.v | 0);
        for (let dz = 0; dz < etd; dz++) {
          for (let dx = 0; dx < etw; dx++) {
            const i = idx(x + dx, z + dz);
            st.occ[i] = bid;
            st.map[i] = T.BLDG;
            st.zoneOf[i] = zone;
            st.level[i] = 1;
            st.variant[i] = 0;
          }
        }
        st.variant[idx(x, z)] = v & 255;
        st.buildings.push({ bid, type: rec.t, cat, x, z, tw: etw, td: etd, rot, variant: v });
      }

      st.day = Number.isFinite(d.day) ? (d.day | 0) || 1 : 1;
      st.clock = Number.isFinite(d.clock) ? clamp(d.clock, 0, 1) : 0.3;
      this._events = [];
      return true;
    } catch (e) {
      return false;
    }
  }
}

// =========================================================================
// Quick self-check (run under node --input-type=module). Returns {ok:true,...}.

export function _selfTest() {
  const out = { ok: false, steps: {} };
  try {
    // Fake mini-catalog (don't import models.js).
    const catalog = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: '\u{1F3E0}', tw: 1, td: 1, variants: 3 }],
      factories: [{ id: 'plant', cat: 'factories', name: 'Plant', emoji: '\u{1F3ED}', tw: 2, td: 2, variants: 2 }],
    };
    const hut = catalog.homes[0];
    const plant = catalog.factories[0];

    // Terrain is now procedural, so a fixed test coord could land on water/mountain.
    // flatten() forces a box to clean GRASS so placement tests are deterministic.
    // (Save/load tests below check roundtrip-equality, not full-map match, so this
    // flattening of empty tiles doesn't affect them.)
    const flatten = (s, x0, z0, x1, z1) => {
      const M = s.state;
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const i = z * N + x;
        M.map[i] = T.GRASS; M.variant[i] = 0; M.occ[i] = 0; M.bridge[i] = 0;
      }
      return s;
    };

    const sim = flatten(new Sim(12345, catalog), 8, 8, 44, 44);
    const S = sim.state;

    // place 1×1
    const p1 = sim.place(hut, 16, 16);
    const c = {};
    c.place1x1 = p1.ok && S.map[idx(16, 16)] === T.BLDG &&
      S.zoneOf[idx(16, 16)] === T.ZONE_R && S.occ[idx(16, 16)] === p1.bid;

    // place 2×2 (factory → ZONE_I on every tile so smoke works).
    const p2 = sim.place(plant, 18, 18);
    const zi = S.zoneOf[idx(18, 18)] === T.ZONE_I && S.zoneOf[idx(19, 19)] === T.ZONE_I;
    c.place2x2 = p2.ok && S.occ[idx(19, 19)] === p2.bid && zi;

    // overlap rejected (anchored so it hits the plant)
    const pOverlap = sim.place(hut, 19, 19);
    c.overlapRejected = !pOverlap.ok && pOverlap.reason === 'occupied';

    // terrain rejected on water (v3.8 maps have none, so make a tile)
    const wx = 2, wz = 2;
    S.map[idx(wx, wz)] = T.WATER;
    const pWater = sim.place(hut, wx, wz);
    c.terrainRejected = !pWater.ok && pWater.reason === 'terrain';

    // bulldoze middle-of-footprint removes the whole 2×2.
    const bd = sim.bulldoze(19, 19); // inside plant (18..19, 18..19)
    c.bulldozeFootprint = bd.ok && bd.removed === p2.bid &&
      S.occ[idx(18, 18)] === 0 && S.occ[idx(19, 19)] === 0 &&
      S.map[idx(18, 18)] === T.GRASS && S.map[idx(19, 18)] === T.GRASS;

    // road place + remove
    const r1 = sim.placeRoad(16, 20);
    const r2 = sim.bulldoze(16, 20);
    c.road = r1.ok && S.map[idx(16, 20)] === T.GRASS && r2.ok;

    // tree place + remove
    const t1 = sim.placeTree(17, 20);
    const t2 = sim.bulldoze(17, 20);
    c.tree = t1.ok && S.map[idx(17, 20)] === T.GRASS && t2.ok;

    // tick drains: first tick returns the accumulated events, second returns []
    const e1 = sim.tick(1);
    const e2 = sim.tick(1);
    c.tickDrains = Array.isArray(e1) && e1.length > 0 && Array.isArray(e2) && e2.length === 0;

    // clock wraps to day 2 after DAY_LENGTH
    const sim3 = new Sim(777, catalog);
    for (let s = 0; s < DAY_LENGTH; s++) sim3.tick(1);
    c.dayWraps = sim3.state.day === 2;

    // save / load roundtrip reproduces the map
    const sim4 = flatten(new Sim(2024, catalog), 8, 8, 44, 44);
    sim4.place(hut, 16, 16);
    sim4.place(plant, 20, 20);
    sim4.placeRoad(16, 17);
    sim4.placeTree(18, 16);
    const blob = sim4.save();
    const sim5 = new Sim(999);
    sim5.setCatalog(catalog);
    const loaded = sim5.load(blob);
    // Roundtrip fidelity: re-saving the loaded sim reproduces the exact blob, and
    // the placed things landed. (Full-map compare is unreliable now that terrain is
    // procedurally regenerated; the save carries only player edits + seed.)
    c.saveLoad = loaded && sim5.save() === blob &&
      sim5.state.map[idx(16, 16)] === T.BLDG && sim5.state.map[idx(16, 17)] === T.ROAD &&
      sim5.state.map[idx(18, 16)] === T.TREE;

    // old v1 saves (and garbage) must return false, not throw
    const v1blob = JSON.stringify({ seed: 1, money: 1500, map: [], pop: 0 });
    c.rejectsV1 = sim5.load(v1blob) === false && sim5.load('not json') === false &&
      sim5.load('{}') === false;

    // ---- rotation checks -------------------------------------------------
    const catalog2 = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: 'h', tw: 1, td: 1, variants: 3 }],
      shops: [{ id: 'shop21', cat: 'shops', name: 'Shop', emoji: 's', tw: 2, td: 1, variants: 2 }],
    };
    const hut2 = catalog2.homes[0];
    const shop21 = catalog2.shops[0];
    const bldgOf = (sim, bid) => sim.state.buildings.find((b) => b.bid === bid);

    // 1×1 with a road on its E side → front faces E → rot 1
    const simE = flatten(new Sim(101, catalog2), 14, 14, 44, 44);
    simE.placeRoad(21, 20);
    const rE = simE.place(hut2, 20, 20);
    c.rotEast = rE.ok && bldgOf(simE, rE.bid).rot === 1;

    // 1×1 with a road to the N → front faces N → rot 2
    const simN = flatten(new Sim(102, catalog2), 14, 14, 44, 44);
    simN.placeRoad(25, 24);
    const rN = simN.place(hut2, 25, 25);
    c.rotNorth = rN.ok && bldgOf(simN, rN.bid).rot === 2;

    // 2×1 beside a horizontal road on its N edge → rotates so front faces road (rot 2)
    const simH = flatten(new Sim(103, catalog2), 14, 14, 44, 44);
    simH.placeRoad(20, 19);
    simH.placeRoad(21, 19);
    const rH = simH.place(shop21, 20, 20);
    const bH = rH.ok && bldgOf(simH, rH.bid);
    c.rot2x1 = !!bH && bH.rot === 2 && bH.tw === 2 && bH.td === 1;

    // no adjacent road → rot 0
    const simZ = flatten(new Sim(104, catalog2), 14, 14, 44, 44);
    const rZ = simZ.place(hut2, 20, 20);
    c.rotNone = rZ.ok && bldgOf(simZ, rZ.bid).rot === 0;

    // 2×1 that only fits rotated (horizontal orientation blocked) still places → rot 1
    const simO = flatten(new Sim(105, catalog2), 14, 14, 44, 44);
    simO.place(hut2, 21, 20);            // blocker: horizontal (2×1) can't fit at (20,20)
    const rO = simO.place(shop21, 20, 20);
    const bO = rO.ok && bldgOf(simO, rO.bid);
    c.rotOnlyFit = !!bO && bO.rot === 1 && bO.tw === 1 && bO.td === 2 &&
      simO.state.occ[idx(20, 21)] === rO.bid;

    // save/load preserves rot and reconstructs identical occ/map
    const simRA = flatten(new Sim(106, catalog2), 14, 14, 44, 44);
    simRA.placeRoad(21, 20);
    const raHut = simRA.place(hut2, 20, 20);       // rot 1
    simRA.placeRoad(30, 19);
    simRA.placeRoad(31, 19);
    const raShop = simRA.place(shop21, 30, 20);    // rot 2
    const rotBlob = simRA.save();
    const simRB = new Sim(999);
    simRB.setCatalog(catalog2);
    const rotLoaded = simRB.load(rotBlob);
    const bHutB = bldgOf(simRB, raHut.bid);
    const bShopB = bldgOf(simRB, raShop.bid);
    c.saveLoadRot = rotLoaded && simRB.save() === rotBlob &&
      !!bHutB && bHutB.rot === 1 && !!bShopB && bShopB.rot === 2 && bShopB.tw === 2 && bShopB.td === 1;

    // ---- bridge checks ---------------------------------------------------
    const simBr = flatten(new Sim(555, catalog), 10, 10, 24, 24);
    const SB = simBr.state;
    // a water tile (v3.8 maps have none of their own)
    const bx = 5, bz = 5;
    const bi = idx(bx, bz);
    SB.map[bi] = T.WATER;
    // building on plain water still fails 'terrain' (checked before any bridge)
    const pOnWater = simBr.place(hut, bx, bz);
    c.bridgeBuildingBlocked = !pOnWater.ok && pOnWater.reason === 'terrain';
    // road over water succeeds and marks bridge
    const rBr = simBr.placeRoad(bx, bz);
    c.bridgePlace = rBr.ok && SB.map[bi] === T.ROAD && SB.bridge[bi] === 1;
    const simCross = flatten(new Sim(556, catalog), 14, 14, 30, 30);
    simCross.state.map[idx(20, 20)] = T.WATER;
    simCross.state.map[idx(21, 20)] = T.WATER;
    simCross.placeRoad(19, 20); simCross.placeRoad(20, 20);
    simCross.placeRoad(21, 20); simCross.placeRoad(22, 20);
    // bulldozing the bridge restores WATER and clears the flag
    const bdBr = simBr.bulldoze(bx, bz);
    c.bridgeBulldozeRestoresWater = bdBr.ok && SB.map[bi] === T.WATER && SB.bridge[bi] === 0;
    // non-bridge road bulldoze unchanged (grass → grass, no bridge flag)
    simBr.placeRoad(16, 16);
    const bdGrass = simBr.bulldoze(16, 16);
    c.nonBridgeRoadUnchanged = bdGrass.ok && SB.map[idx(16, 16)] === T.GRASS &&
      SB.bridge[idx(16, 16)] === 0;
    // save/load roundtrip preserves bridge flags + map
    simBr.placeRoad(bx, bz); // re-place the bridge for the roundtrip
    const brBlob = simBr.save();
    c.bridgeSaved = JSON.parse(brBlob).bridges &&
      JSON.parse(brBlob).bridges.indexOf(bi) >= 0;
    const simBr2 = new Sim(999);
    simBr2.setCatalog(catalog);
    const brLoaded = simBr2.load(brBlob);
    // v3.8: no generated water to span, so a saved bridge comes back as plain road
    c.bridgeSaveLoad = brLoaded &&
      simBr2.state.bridge[bi] === 0 && simBr2.state.map[bi] === T.ROAD;
    // a save with no bridges omits the key and loads clean
    const simNoBr = flatten(new Sim(2024, catalog), 10, 10, 30, 30);
    simNoBr.placeRoad(16, 20);
    const noBrBlob = simNoBr.save();
    c.bridgeKeyOmitted = !('bridges' in JSON.parse(noBrBlob));

    // ---- big footprints (v3.1: up to 4×4) --------------------------------
    const catalogBig = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: 'h', tw: 1, td: 1, variants: 3 }],
      fun: [{ id: 'arena', cat: 'fun', name: 'Arena', emoji: 'a', tw: 4, td: 4, variants: 2 }],
      shops: [{ id: 'shop32', cat: 'shops', name: 'Mall', emoji: 'm', tw: 3, td: 2, variants: 2 }],
    };
    const hutB = catalogBig.homes[0];
    const arena = catalogBig.fun[0];
    const shop32 = catalogBig.shops[0];
    const bldgOfB = (sim, bid) => sim.state.buildings.find((b) => b.bid === bid);

    // 4×4 occupies all 16 tiles, all owned by the same bid.
    const sim44 = flatten(new Sim(4444, catalogBig), 6, 6, 24, 24);
    const p44 = sim44.place(arena, 10, 10);
    let all16 = p44.ok;
    for (let dz = 0; dz < 4 && all16; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        const i = idx(10 + dx, 10 + dz);
        if (sim44.state.occ[i] !== p44.bid || sim44.state.map[i] !== T.BLDG) { all16 = false; break; }
      }
    }
    const b44 = bldgOfB(sim44, p44.bid);
    c.place4x4 = all16 && !!b44 && b44.tw === 4 && b44.td === 4;

    // Overlap onto the 4×4 is rejected.
    const p44over = sim44.place(hutB, 12, 12);
    c.big4x4OverlapRejected = !p44over.ok && p44over.reason === 'occupied';

    // 3×2 beside a horizontal road on its N edge → front faces N → rot 2, dims kept.
    const sim32 = flatten(new Sim(3232, catalogBig), 14, 14, 30, 30);
    sim32.placeRoad(20, 19);
    sim32.placeRoad(21, 19);
    sim32.placeRoad(22, 19);
    const p32 = sim32.place(shop32, 20, 20);
    const b32 = p32.ok && bldgOfB(sim32, p32.bid);
    let full32 = !!b32;
    if (b32) {
      for (let dz = 0; dz < 2 && full32; dz++) {
        for (let dx = 0; dx < 3; dx++) {
          if (sim32.state.occ[idx(20 + dx, 20 + dz)] !== p32.bid) { full32 = false; break; }
        }
      }
    }
    c.place3x2Rot = full32 && b32.rot === 2 && b32.tw === 3 && b32.td === 2;

    // ---- save migration across a map resize (old n=48 → current N) --------
    // Hand-built save: n:48 flat indices for a road and a tree, plus a building.
    const oldN = 48;
    const roadOld = 28 * oldN + 28;  // (x=28,z=28) in a 48-grid
    const treeOld = 26 * oldN + 26;  // (x=26,z=26)
    const migBlob = JSON.stringify({
      v: 2, n: oldN, seed: 2024, day: 5, clock: 0.4,
      roads: [roadOld], trees: [treeOld],
      buildings: [{ t: 'hut', x: 30, z: 30, v: 0 }],
    });
    const simMig = new Sim(1);
    simMig.setCatalog(catalogBig);
    const migLoaded = simMig.load(migBlob);
    const SM = simMig.state;
    // The same (x,z) map to new flat indices (shifted to keep the middle when
    // the map shrank); assert they landed there.
    const mo = oldN > N ? (oldN - N) >> 1 : 0;
    const roadOK = SM.map[idx(28 - mo, 28 - mo)] === T.ROAD;
    const treeOK = SM.map[idx(26 - mo, 26 - mo)] === T.TREE;
    const bldgOK = SM.buildings.length === 1 && SM.buildings[0].x === 30 - mo &&
      SM.buildings[0].z === 30 - mo && SM.occ[idx(30 - mo, 30 - mo)] === SM.buildings[0].bid &&
      SM.map[idx(30 - mo, 30 - mo)] === T.BLDG;
    // The old flat index, read raw in the new grid, would be the WRONG tile —
    // confirm the remap actually moved it (roadOld != idx(28,28) since N changed).
    const remapped = roadOld !== idx(28 - mo, 28 - mo);
    c.migrateResize = migLoaded && roadOK && treeOK && bldgOK && remapped;

    // ---- plain sandbox: no residents, jobs, happiness or air --------------------
    const catalog3 = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: 'h', tw: 1, td: 1, variants: 3 }],
      shops: [{ id: 'bakery', cat: 'shops', name: 'Bakery', emoji: 'b', tw: 1, td: 1, variants: 3 }],
      factories: [{ id: 'plant', cat: 'factories', name: 'Plant', emoji: 'p', tw: 1, td: 1, variants: 3 }],
    };
    const simM = flatten(new Sim(31337, catalog3), 6, 6, 22, 22);
    const SMx = simM.state;
    simM.place(catalog3.homes[0], 10, 10);
    simM.place(catalog3.shops[0], 14, 10);
    simM.place(catalog3.factories[0], 16, 10);
    // Nothing to manage: the sim tracks no people, jobs, mood or air, and keeps no counters.
    c.noStats = !('pop' in SMx) && !('jobs' in SMx) && !('happiness' in SMx) && !('air' in SMx) &&
      typeof simM.metrics === 'undefined' && SMx.buildings.length === 3;
    // A shop with no home anywhere, and a home with no shop or road, place exactly like any other building.
    const simAlone = flatten(new Sim(2, catalog3), 6, 6, 22, 22);
    c.anyBuildingAlone = simAlone.place(catalog3.shops[0], 8, 8).ok && simAlone.place(catalog3.factories[0], 12, 8).ok &&
      simAlone.state.buildings.length === 2;
    // A save written by the game with stats (extra pop/jobs keys) still loads, and the extras are ignored.
    const oldBlob = JSON.parse(simM.save());
    oldBlob.pop = 99; oldBlob.jobs = 7; oldBlob.happiness = 0.5; oldBlob.money = 1500;
    const simOld = new Sim(999); simOld.setCatalog(catalog3);
    c.loadsOldSave = simOld.load(JSON.stringify(oldBlob)) && simOld.state.buildings.length === 3 &&
      simOld.save() === simM.save();

    // ---- v3.8: the whole map is open, buildable grass --------------------
    const simTer = new Sim(24680, catalog);
    c.terrainAllGrass = simTer.state.map.every((t) => t === T.GRASS);
    // An old 80-wide save keeps its middle: a road at (40,40) lands at the centre.
    const oldBig = JSON.parse(simTer.save());
    oldBig.n = 80; oldBig.roads = [40 * 80 + 40, 0]; oldBig.trees = []; oldBig.buildings = [];
    const simBig = new Sim(1); simBig.setCatalog(catalog);
    const off = (80 - N) >> 1;
    c.shrinkKeepsMiddle = simBig.load(JSON.stringify(oldBig)) &&
      simBig.state.map[idx(40 - off, 40 - off)] === T.ROAD &&
      simBig.state.map.filter((t) => t === T.ROAD).length === 1;

    out.steps = c;
    out.ok = Object.values(c).every(Boolean);
    return out;
  } catch (e) {
    out.error = String((e && e.stack) || e);
    return out;
  }
}
