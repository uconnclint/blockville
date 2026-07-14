// sim.js — Blockville SANDBOX simulation core.
// Pure logic: no three.js, no DOM. Only imports ./constants.js.
// Owns `state` (read-only to everyone else). All public methods are defensive:
// bad args never throw, they return a safe value.
//
// Sandbox model: no economy, no zones-that-grow, no milestones. Kids pick a
// specific building (a CATALOG ENTRY) and place it instantly. Buildings may
// cover a tw×td footprint. Population is a cosmetic stat (drives car/ped density).

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

    // Catalog lookup (id -> {cat, tw, td, cap}). Injected via setCatalog too.
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
      pop: 0,                            // RESIDENTS only (sum of caps of 'homes')
      jobs: 0,                           // sum of caps of all non-home categories
      happiness: 1,                      // 0..1 cosmetic, recomputed cheaply
      air: 1,                            // 0..1 cosmetic, recomputed cheaply
      day: 1, clock: 0.3, speed: 1,
      seed: s,
    };

    // Cached tile counts, maintained incrementally on placeRoad/placeTree/bulldoze
    // so metrics() never has to rescan the whole map.
    this._roadCount = 0;
    this._treeCount = 0;
    this._bridgeCount = 0;
    this._statTimer = 0;   // seconds accumulated toward the next stat recompute

    this._events = [];
    this._generateBaseTerrain();
    this._scatterTrees();
    this._recountTiles();
    this._recompute();
  }

  // Register the building catalog so load() can reconstruct footprints/caps.
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
          cap: Number.isFinite(e.cap) ? e.cap : 0,
          variants: (e.variants | 0) || 1,
        });
      }
    }
  }

  // ---- terrain -----------------------------------------------------------

  // Value-noise helpers — fully deterministic from state.seed (no Math.random).
  // Lattice points are hashed from (ix,iz,salt,seed); a value at any (x,z) is the
  // smooth (smoothstep) bilinear blend of its four surrounding lattice hashes.
  // Summing several octaves (each double the frequency, half the amplitude) gives
  // natural-looking fractal fields (fbm) in [0,1].
  _hash01(ix, iz, salt) {
    let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^
             Math.imul((salt | 0) + (this.state.seed | 0), 0x9e3779b1)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  _vnoise(x, z, freq, salt) {
    const gx = x * freq, gz = z * freq;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const fx = gx - x0, fz = gz - z0;
    const sx = fx * fx * (3 - 2 * fx);   // smoothstep
    const sz = fz * fz * (3 - 2 * fz);
    const c00 = this._hash01(x0, z0, salt),     c10 = this._hash01(x0 + 1, z0, salt);
    const c01 = this._hash01(x0, z0 + 1, salt), c11 = this._hash01(x0 + 1, z0 + 1, salt);
    const a = c00 + (c10 - c00) * sx;
    const b = c01 + (c11 - c01) * sx;
    return a + (b - a) * sz;             // [0,1]
  }

  _fbm(x, z, freq, oct, salt) {
    let amp = 1, f = freq, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * this._vnoise(x, z, f, salt + o * 131);
      norm += amp; amp *= 0.5; f *= 2;
    }
    return norm > 0 ? sum / norm : 0;
  }

  // Procedural world, deterministic from the seed: ocean + coastline, lakes,
  // mountain ranges (with per-tile peak heights in variant), rivers, and beaches.
  // No trees here (forests are a separate layer applied at CONSTRUCT via
  // _scatterTrees, or from the saved tree list on load). `protect` (optional) is a
  // Set of flat indices that must stay GRASS — used on load so regenerated water/
  // mountains never clobber a tile a saved road/tree/building will occupy.
  _generateBaseTerrain(protect) {
    const st = this.state;
    const { map, variant } = st;
    const r = this._rand;
    map.fill(T.GRASS);
    st.zoneOf.fill(0);
    st.level.fill(0);
    variant.fill(0);
    st.occ.fill(0);
    st.bridge.fill(0);

    const prot = (i) => (protect ? protect.has(i) : false);
    // Central build box kept clear of mountains/lakes/forests so kids always have
    // open room in the middle; ocean sits on an edge, mountains hug the corners.
    const clrLo = Math.floor(N * 0.30), clrHi = Math.floor(N * 0.70);
    const inCentral = (x, z) => x >= clrLo && x < clrHi && z >= clrLo && z < clrHi;
    // Water never overwrites a mountain or a protected tile.
    const setWater = (x, z) => {
      if (!inBounds(x, z)) return;
      const i = idx(x, z);
      if (prot(i) || map[i] === T.MOUNTAIN) return;
      map[i] = T.WATER;
    };

    // Elevation + moisture fields (multi-octave value noise). Elevation shapes the
    // coast/rivers/mountains; moisture drives where forests want to grow.
    const elev = new Float32Array(N * N);
    const moist = new Float32Array(N * N);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, z);
        elev[i] = this._fbm(x, z, 3 / N, 4, 1000);
        moist[i] = this._fbm(x, z, 2.5 / N, 4, 5000);
      }
    }
    this._moist = moist; // reused by _scatterTrees at construct

    // ---- OCEAN along one seed-chosen edge, with a wavy coastline ----
    const edge = Math.floor(r() * 4);        // 0:−z, 1:+x, 2:+z, 3:−x
    const coastBase = 5 + Math.floor(r() * 3); // depth 5..7 tiles inland
    const coastAmp = 2 + Math.floor(r() * 3);  // wobble ±2..4 tiles
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let inland, along;
        if (edge === 0) { inland = z; along = x; }
        else if (edge === 2) { inland = N - 1 - z; along = x; }
        else if (edge === 3) { inland = x; along = z; }
        else { inland = N - 1 - x; along = z; }
        const wave = coastAmp * (this._vnoise(along, edge * 53 + 11, 0.13, 2222) * 2 - 1);
        if (inland < coastBase + wave) setWater(x, z);
      }
    }

    // ---- LAKES: 1..2 noisy inland blobs (outside the central box) ----
    const lakeCount = 1 + Math.floor(r() * 2);
    for (let l = 0; l < lakeCount; l++) {
      let cx = 0, cz = 0, tries = 0;
      do { cx = Math.floor(r() * N); cz = Math.floor(r() * N); tries++; }
      while (inCentral(cx, cz) && tries < 40);
      const rad = 3 + Math.floor(r() * 3);   // 3..5
      const lsalt = 3300 + l * 17;
      const x0 = Math.max(0, cx - rad - 2), x1 = Math.min(N - 1, cx + rad + 2);
      const z0 = Math.max(0, cz - rad - 2), z1 = Math.min(N - 1, cz + rad + 2);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (inCentral(x, z)) continue;
          const dx = x - cx, dz = z - cz;
          const d = Math.sqrt(dx * dx + dz * dz);
          const wob = rad * 0.45 * (this._vnoise(x, z, 0.3, lsalt) * 2 - 1);
          if (d < rad + wob) setWater(x, z);
        }
      }
    }

    // ---- MOUNTAINS: 1..2 corner-biased ranges; smooth radial peak heights ----
    // Distinct corners per range so ranges never overlap (keeps slopes smooth).
    const rangeCount = 1 + Math.floor(r() * 2);
    const c0 = Math.floor(r() * 4);
    const peaks = [];
    for (let m = 0; m < rangeCount; m++) {
      const corner = (c0 + m) % 4;           // 0:NW 1:NE 2:SE 3:SW
      const near = 0.18;                     // centre within ~18% of that corner
      const cx = (corner === 1 || corner === 2) ? (N - 1 - Math.floor(r() * (N * near)))
                                               : Math.floor(r() * (N * near));
      const cz = (corner === 2 || corner === 3) ? (N - 1 - Math.floor(r() * (N * near)))
                                               : Math.floor(r() * (N * near));
      const R = 9 + Math.floor(r() * 4);     // radius 9..12
      const peak = 10 + Math.floor(r() * 5); // peak height 10..14 (≤16)
      const ang = r() * Math.PI;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const stretch = 1.4 + r() * 0.6;       // elongate into a ridge
      const jsalt = 4400 + m * 23;
      const x0 = Math.max(0, cx - R * 2), x1 = Math.min(N - 1, cx + R * 2);
      const z0 = Math.max(0, cz - R * 2), z1 = Math.min(N - 1, cz + R * 2);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (inCentral(x, z)) continue;
          const i = idx(x, z);
          if (prot(i) || map[i] !== T.GRASS) continue; // never over water/sand/protected
          const rx = (x - cx) * ca + (z - cz) * sa;
          const rz = -(x - cx) * sa + (z - cz) * ca;
          const dd = Math.sqrt((rx / stretch) * (rx / stretch) + rz * rz);
          if (dd >= R) continue;
          const shape = 1 - dd / R;          // 1 at centre → 0 at the rim
          const jit = Math.round((this._vnoise(x, z, 0.16, jsalt) - 0.5) * 2); // −1..1
          let h = Math.round(peak * shape) + jit;
          if (h < 2) continue;
          if (h > 16) h = 16;
          map[i] = T.MOUNTAIN;
          variant[i] = h;
        }
      }
      peaks.push({ x: cx, z: cz });
    }

    // ---- RIVERS: 1..2 flowing downhill from a mountain to a water body ----
    // "Potential" = elevation blended with distance-from-ocean, so steepest
    // descent trends toward the sea and reliably reaches a water body.
    const oceanInland = (x, z) => {
      if (edge === 0) return z;
      if (edge === 2) return N - 1 - z;
      if (edge === 3) return x;
      return N - 1 - x;
    };
    const potential = (x, z) => elev[idx(x, z)] * 0.55 + (oceanInland(x, z) / N) * 0.45;
    const isWater = (x, z) => inBounds(x, z) && map[idx(x, z)] === T.WATER;
    const carve = (x, z) => {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(dx) + Math.abs(dz) <= 1) setWater(x + dx, z + dz);
        }
      }
    };
    const riverCount = 1 + Math.floor(r() * 2);
    for (let rv = 0; rv < riverCount; rv++) {
      let x, z;
      if (peaks.length) {
        const p = peaks[rv % peaks.length];
        x = clamp(p.x + Math.floor((r() - 0.5) * 6), 1, N - 2);
        z = clamp(p.z + Math.floor((r() - 0.5) * 6), 1, N - 2);
      } else { x = Math.floor(r() * N); z = Math.floor(r() * N); }
      const visited = new Set();
      let steps = 0; const maxSteps = N * 3;
      while (steps < maxSteps) {
        steps++;
        const key = z * N + x;
        if (visited.has(key)) break;
        visited.add(key);
        carve(x, z);
        let best = null, bestP = Infinity;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dz] of nb) {
          const nx = x + dx, nz = z + dz;
          if (!inBounds(nx, nz) || visited.has(nz * N + nx)) continue;
          const p = potential(nx, nz);
          if (p < bestP) { bestP = p; best = [nx, nz]; }
        }
        if (!best) break;
        if (isWater(best[0], best[1])) { carve(best[0], best[1]); break; } // reached the sea/a lake
        x = best[0]; z = best[1];
      }
    }

    // ---- BEACHES: sand on grass adjacent to water (8-neighbourhood) ----
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, z);
        if (map[i] !== T.GRASS || prot(i)) continue;
        let near = false;
        for (let dz = -1; dz <= 1 && !near; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, nz = z + dz;
            if (inBounds(nx, nz) && map[idx(nx, nz)] === T.WATER) { near = true; break; }
          }
        }
        if (near) map[i] = T.SAND;
      }
    }
  }

  // Forest layer (runs at CONSTRUCT only; load applies the saved tree list). Dense
  // clusters where MOISTURE + a clump-noise both read high, plus light random
  // scatter. Deterministic, only on GRASS, never on water/sand/mountain, and kept
  // out of the central build box. Aims ~300–390 trees at N=80.
  _scatterTrees() {
    const { map, variant } = this.state;
    const r = this._rand;
    const moist = this._moist;
    const clrLo = Math.floor(N * 0.30), clrHi = Math.floor(N * 0.70);
    const inCentral = (x, z) => x >= clrLo && x < clrHi && z >= clrLo && z < clrHi;

    const target = 300 + Math.floor(r() * 90); // 300..389

    // Candidate grass tiles scored by moisture + clumping noise → dense forests.
    const cand = [];
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (inCentral(x, z)) continue;
        const i = idx(x, z);
        if (map[i] !== T.GRASS) continue;
        const clump = this._vnoise(x, z, 0.14, 7777);
        const score = (moist ? moist[i] : 0.5) * 0.6 + clump * 0.4;
        cand.push({ i, score });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const dense = Math.min(cand.length, Math.round(target * 0.82));
    for (let k = 0; k < dense; k++) {
      const i = cand[k].i;
      map[i] = T.TREE;
      variant[i] = this._randByte();
    }

    // Light scatter for the remainder anywhere on grass (outside the central box).
    let scatter = target - dense, guard = 0;
    const guardMax = (scatter + 1) * 200;
    while (scatter > 0 && guard < guardMax) {
      guard++;
      const x = Math.floor(r() * N), z = Math.floor(r() * N);
      if (inCentral(x, z)) continue;
      const i = idx(x, z);
      if (map[i] === T.GRASS) { map[i] = T.TREE; variant[i] = this._randByte(); scatter--; }
    }
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

  // Place a catalog building. `entry` = { id, cat, tw, td, cap, variants }.
  // Uses plan() to auto-rotate the building so its front faces an adjacent road.
  // Returns { ok, reason?, bid }. reason ∈ 'bounds' | 'terrain' | 'occupied'.
  place(entry, x, z, variant) {
    const st = this.state;
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'terrain' };
    x |= 0; z |= 0;

    const cap = Number.isFinite(entry.cap) ? entry.cap : 0;
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
    // pop counts RESIDENTS (homes) only; every other category adds jobs.
    if (cat === 'homes') st.pop += cap; else st.jobs += cap;
    this._events.push({ type: 'placed', bid, entry, x, z, variant: v, rot, etw, etd });
    this._recompute();
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
      this._roadCount++;
      return { ok: true };
    }
    if (m === T.WATER) { // bridge: road spans the water
      st.map[i] = T.ROAD;
      st.variant[i] = 0;
      st.bridge[i] = 1;
      this._roadCount++;
      this._bridgeCount++;
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
      this._treeCount++;
      this._recompute(); // trees noticeably raise happiness / air
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
      const cap = this._capOf(b);
      // Reverse whichever tally this building fed (homes → pop, else → jobs).
      if (b.cat === 'homes') st.pop = Math.max(0, st.pop - cap);
      else st.jobs = Math.max(0, st.jobs - cap);
      this._events.push({ type: 'removed', bid, x: b.x, z: b.z, tw: b.tw, td: b.td });
      this._recompute();
      return { ok: true, removed: bid };
    }

    const m = st.map[i];
    if (m === T.ROAD && st.bridge[i] === 1) { // bridge road → restore water
      this._clearTile(i);
      st.map[i] = T.WATER;
      st.bridge[i] = 0;
      this._roadCount = Math.max(0, this._roadCount - 1);
      this._bridgeCount = Math.max(0, this._bridgeCount - 1);
      return { ok: true };
    }
    if (m === T.ROAD) {
      this._clearTile(i);
      this._roadCount = Math.max(0, this._roadCount - 1);
      return { ok: true };
    }
    if (m === T.TREE) {
      this._clearTile(i);
      this._treeCount = Math.max(0, this._treeCount - 1);
      this._recompute(); // fewer trees → recompute happiness / air
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

  // Capacity a building contributes to pop (from entry cap via catalog lookup).
  _capOf(b) {
    const rec = this._byId.get(b.type);
    if (rec && Number.isFinite(rec.cap)) return rec.cap;
    return Number.isFinite(b.cap) ? b.cap : 0;
  }

  // ---- cosmetic stats (happiness / air) + metrics -----------------------

  // Rescan the map once to (re)seed the cached road/tree/bridge counters.
  // Called at construction and after load(); edits maintain them incrementally.
  _recountTiles() {
    const { map, bridge } = this.state;
    let road = 0, tree = 0, br = 0;
    for (let i = 0; i < map.length; i++) {
      const m = map[i];
      if (m === T.ROAD) { road++; if (bridge[i] === 1) br++; }
      else if (m === T.TREE) tree++;
    }
    this._roadCount = road;
    this._treeCount = tree;
    this._bridgeCount = br;
  }

  // True if any TREE tile sits within Chebyshev `radius` of the footprint at
  // (x,z) sized tw×td. Cheap window scan (only used for the few factories).
  _treeNearFootprint(x, z, tw, td, radius) {
    const { map } = this.state;
    const x0 = x - radius, x1 = x + tw - 1 + radius;
    const z0 = z - radius, z1 = z + td - 1 + radius;
    for (let tz = z0; tz <= z1; tz++) {
      if (tz < 0 || tz >= N) continue;
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || tx >= N) continue;
        if (map[idx(tx, tz)] === T.TREE) return true;
      }
    }
    return false;
  }

  _roadNearFootprint(x, z, tw, td) {
    const { map } = this.state;
    for (let tz = z - 1; tz <= z + td; tz++) for (let tx = x - 1; tx <= x + tw; tx++) {
      if (!inBounds(tx, tz)) continue;
      if (tx >= x && tx < x + tw && tz >= z && tz < z + td) continue;
      if (map[idx(tx, tz)] === T.ROAD) return true;
    }
    return false;
  }

  // A real crossing is a continuous run of bridge tiles with ordinary road on
  // both banks. A single road tile dropped into water is still a bridge piece,
  // but it does not count as crossing the river for the City Helper.
  _bridgeCrossings() {
    const st = this.state;
    const isBridge = (x, z) => inBounds(x, z) && st.bridge[idx(x, z)] === 1;
    const isLandRoad = (x, z) => inBounds(x, z) && st.map[idx(x, z)] === T.ROAD && !isBridge(x, z);
    let crossings = 0;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (!isBridge(x, z)) continue;
      if ((x === 0 || !isBridge(x - 1, z)) && isLandRoad(x - 1, z)) {
        let ex = x; while (ex + 1 < N && isBridge(ex + 1, z)) ex++;
        if (isLandRoad(ex + 1, z)) crossings++;
      }
      if ((z === 0 || !isBridge(x, z - 1)) && isLandRoad(x, z - 1)) {
        let ez = z; while (ez + 1 < N && isBridge(x, ez + 1)) ez++;
        if (isLandRoad(x, ez + 1)) crossings++;
      }
    }
    return crossings;
  }

  // Iterate buildings once, fold in cached tile counts, and produce the full
  // metrics object. Also stores the derived happiness/air back onto state.
  // Defensive: any failure falls back to safe values.
  _recompute() {
    const st = this.state;
    try {
      const trees = this._treeCount | 0;
      let homes = 0, shops = 0, factories = 0, funCount = 0, downtown = 0;
      let parks = 0, schools = 0, firestations = 0, windPowers = 0;
      let roadConnectedBuildings = 0, roadConnectedHomes = 0, roadConnectedJobs = 0;
      const types = Object.create(null);
      let factoriesFarFromTrees = 0;
      const shopTypes = new Set();
      const homePts = [];
      const shopPts = [];
      const factoryPts = [];

      for (const b of st.buildings) {
        if (!b) continue;
        const cat = b.cat;
        const type = b.type;
        if (type) types[type] = (types[type] || 0) + 1;
        if (this._roadNearFootprint(b.x, b.z, b.tw | 0 || 1, b.td | 0 || 1)) {
          roadConnectedBuildings++;
          if (cat === 'homes') roadConnectedHomes++;
          else if (cat !== 'deco') roadConnectedJobs++;
        }
        if (cat === 'homes') { homes++; homePts.push(b); }
        else if (cat === 'shops') { shops++; shopPts.push(b); if (type) shopTypes.add(type); }
        else if (cat === 'factories') {
          factories++;
          factoryPts.push(b);
          if (!this._treeNearFootprint(b.x, b.z, b.tw | 0 || 1, b.td | 0 || 1, 6)) factoriesFarFromTrees++;
        }
        else if (cat === 'fun') funCount++;
        else if (cat === 'downtown') downtown++;
        if (type === 'park') parks++;
        else if (type === 'school') schools++;
        else if (type === 'fire-station') firestations++;
        else if (type === 'wind-power') windPowers++;
      }

      // Shops within Chebyshev 6 of any home (anchor-to-anchor).
      let shopNearHome = 0;
      for (const s of shopPts) {
        for (const h of homePts) {
          if (Math.max(Math.abs(s.x - h.x), Math.abs(s.z - h.z)) <= 6) { shopNearHome++; break; }
        }
      }

      const shopVariety = shopTypes.size;
      // Count unique trees close to at least one factory. This powers the guided
      // clean-air mission, so trees planted on the other side of town do not count.
      const nearFactoryTreeTiles = new Set();
      for (const f of factoryPts) {
        const tw = f.tw | 0 || 1, td = f.td | 0 || 1;
        for (let z = Math.max(0, f.z - 6); z <= Math.min(N - 1, f.z + td - 1 + 6); z++) {
          for (let x = Math.max(0, f.x - 6); x <= Math.min(N - 1, f.x + tw - 1 + 6); x++) {
            if (st.map[idx(x, z)] === T.TREE) nearFactoryTreeTiles.add(idx(x, z));
          }
        }
      }
      const treesNearFactories = nearFactoryTreeTiles.size;
      // Happiness responds mostly to amenities the PLAYER adds (parks, schools,
      // shops, fun) and dips when factories sit away from greenery, so the HUD
      // face visibly reacts. Greenery is measured LOCALLY (factoriesFarFromTrees)
      // rather than by a global tree count — the big procedural forest would
      // otherwise pin these at the ceiling and they'd never move.
      const happiness = clamp(
        0.6 + 0.04 * parks + 0.03 * (schools > 0 ? 1 : 0) + 0.02 * shopVariety +
        0.015 * funCount - 0.05 * factoriesFarFromTrees,
        0.15, 1,
      );
      // Air: only factories WITHOUT nearby trees pollute — so planting trees next
      // to a factory (moving it from "far" to "near") visibly cleans the air, and
      // wind power helps too. No global tree term, so the forest can't mask it.
      const air = clamp(
        1 - 0.10 * factoriesFarFromTrees + 0.05 * windPowers,
        0.1, 1,
      );

      st.happiness = happiness;
      st.air = air;

      return {
        residents: st.pop | 0,
        jobs: st.jobs | 0,
        roadTiles: this._roadCount | 0,
        bridges: this._bridgeCount | 0,
        bridgeCrossings: this._bridgeCrossings(),
        homes, shops, factories, funCount, downtown,
        trees, treesNearFactories, parks, schools, firestations,
        shopNearHome, roadConnectedBuildings, roadConnectedHomes, roadConnectedJobs,
        happiness, air, types,
      };
    } catch (e) {
      // Never throw from a cosmetic recompute; keep whatever state we had.
      return {
        residents: st.pop | 0, jobs: st.jobs | 0,
        roadTiles: this._roadCount | 0, bridges: this._bridgeCount | 0, bridgeCrossings: 0,
        homes: 0, shops: 0, factories: 0, funCount: 0, downtown: 0,
        trees: this._treeCount | 0, treesNearFactories: 0, parks: 0, schools: 0, firestations: 0,
        shopNearHome: 0, roadConnectedBuildings: 0, roadConnectedHomes: 0, roadConnectedJobs: 0, types: {},
        happiness: Number.isFinite(st.happiness) ? st.happiness : 1,
        air: Number.isFinite(st.air) ? st.air : 1,
      };
    }
  }

  // Public cheap snapshot of city stats (used by missions + suggestions).
  metrics() {
    return this._recompute();
  }

  // ---- tick --------------------------------------------------------------

  // Advances clock/day only, then RETURNS the drained events. Callers must
  // never see the same event twice.
  tick(dt) {
    const st = this.state;
    if (Number.isFinite(dt) && dt > 0) {
      st.clock += dt / DAY_LENGTH;
      while (st.clock >= 1) { st.clock -= 1; st.day++; }
      // Cheap cosmetic stat refresh roughly every 2 sim-seconds.
      this._statTimer += dt;
      if (this._statTimer >= 2) { this._statTimer = 0; this._recompute(); }
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

  // Reconstruct occ/map/zoneOf/pop from the buildings list. Needs a catalog
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
      const remap = (i) => {
        if (!Number.isInteger(i) || i < 0) return -1;
        if (savedN === N) return i < st.map.length ? i : -1;
        const ox = i % savedN, oz = Math.floor(i / savedN);
        if (ox >= N || oz >= N) return -1; // out of the new bounds → drop
        return oz * N + ox;
      };

      // Bridge tiles (road over water). Missing key → no bridges.
      const bridgeSet = new Set();
      if (Array.isArray(d.bridges)) {
        for (const i of d.bridges) { const ni = remap(i); if (ni >= 0) bridgeSet.add(ni); }
      }

      // PROTECT set: every tile a saved road / tree / building footprint occupies
      // must stay GRASS through terrain regeneration, so procedural water/mountains
      // never clobber a tile the player already built on.
      const protect = new Set();
      for (const raw of d.roads) { const ni = remap(raw); if (ni >= 0) protect.add(ni); }
      for (const raw of d.trees) { const ni = remap(raw); if (ni >= 0) protect.add(ni); }
      for (const rec of d.buildings) {
        if (!rec || typeof rec.t !== 'string') continue;
        const info = this._byId.get(rec.t); if (!info) continue;
        const rot = (rec.r | 0) & 3;
        const etw = (rot & 1) ? info.td : info.tw, etd = (rot & 1) ? info.tw : info.td;
        const x = rec.x | 0, z = rec.z | 0;
        for (let dz = 0; dz < etd; dz++) for (let dx = 0; dx < etw; dx++) {
          if (inBounds(x + dx, z + dz)) protect.add(idx(x + dx, z + dz));
        }
      }

      // Rebuild deterministic procedural terrain from the seed, keeping protected
      // tiles GRASS, then force WATER back under any saved bridges so they read as
      // road-over-water again.
      this._rand = mulberry32(seed);
      this._generateBaseTerrain(protect);
      for (const i of bridgeSet) { if (i >= 0 && i < st.map.length) { st.map[i] = T.WATER; st.variant[i] = 0; } }
      // Player-placed roads (bridge tiles are ROAD in map, listed here too).
      for (const raw of d.roads) {
        const i = remap(raw);
        if (i < 0) continue;
        if (st.map[i] === T.GRASS || st.map[i] === T.SAND) {
          st.map[i] = T.ROAD;
        } else if (st.map[i] === T.WATER && bridgeSet.has(i)) {
          st.map[i] = T.ROAD;
          st.bridge[i] = 1;
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
      st.pop = 0;
      st.jobs = 0;
      for (const rec of d.buildings) {
        if (!rec || typeof rec.t !== 'string') continue;
        const info = this._byId.get(rec.t);
        if (!info) continue; // unknown type without catalog — skip safely
        const x = rec.x | 0, z = rec.z | 0;
        const { cap, cat } = info;
        // Effective dims: catalog dims, swapped when rot is odd. Missing r → 0.
        const rot = (rec.r | 0) & 3;
        const etw = (rot & 1) ? info.td : info.tw;
        const etd = (rot & 1) ? info.tw : info.td;
        // Skip if effective footprint doesn't fit on clear grass.
        let fits = true;
        for (let dz = 0; dz < etd && fits; dz++) {
          for (let dx = 0; dx < etw; dx++) {
            const tx = x + dx, tz = z + dz;
            if (!inBounds(tx, tz) || st.map[idx(tx, tz)] !== T.GRASS || st.occ[idx(tx, tz)] !== 0) {
              fits = false; break;
            }
          }
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
        // Recompute pop (residents) vs jobs from the rebuilt buildings.
        if (cat === 'homes') st.pop += cap; else st.jobs += cap;
      }

      st.day = Number.isFinite(d.day) ? (d.day | 0) || 1 : 1;
      st.clock = Number.isFinite(d.clock) ? clamp(d.clock, 0, 1) : 0.3;
      this._events = [];
      // jobs/happiness/air are derived — rebuild caches + cosmetic stats.
      this._statTimer = 0;
      this._recountTiles();
      this._recompute();
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
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: '\u{1F3E0}', tw: 1, td: 1, cap: 2, variants: 3 }],
      factories: [{ id: 'plant', cat: 'factories', name: 'Plant', emoji: '\u{1F3ED}', tw: 2, td: 2, cap: 6, variants: 2 }],
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
      if (s._recountTiles) s._recountTiles();
      return s;
    };

    const sim = flatten(new Sim(12345, catalog), 8, 8, 44, 44);
    const S = sim.state;

    // place 1×1
    const p1 = sim.place(hut, 16, 16);
    const c = {};
    c.place1x1 = p1.ok && S.pop === 2 && S.map[idx(16, 16)] === T.BLDG &&
      S.zoneOf[idx(16, 16)] === T.ZONE_R && S.occ[idx(16, 16)] === p1.bid;

    // place 2×2 (factory → ZONE_I on every tile so smoke works). Factory cap
    // feeds JOBS, not residents: pop stays 2, jobs becomes 6.
    const p2 = sim.place(plant, 18, 18);
    const zi = S.zoneOf[idx(18, 18)] === T.ZONE_I && S.zoneOf[idx(19, 19)] === T.ZONE_I;
    c.place2x2 = p2.ok && S.pop === 2 && S.jobs === 6 && S.occ[idx(19, 19)] === p2.bid && zi;

    // overlap rejected (anchored so it hits the plant)
    const pOverlap = sim.place(hut, 19, 19);
    c.overlapRejected = !pOverlap.ok && pOverlap.reason === 'occupied';

    // terrain rejected on water
    let wx = -1, wz = -1;
    for (let i = 0; i < S.map.length && wx < 0; i++) {
      if (S.map[i] === T.WATER) { wx = i % N; wz = (i / N) | 0; }
    }
    const pWater = sim.place(hut, wx, wz);
    c.terrainRejected = !pWater.ok && pWater.reason === 'terrain';

    // bulldoze middle-of-footprint removes whole 2×2; the factory's JOBS drop
    // back to 0 while residents (pop) are untouched.
    const bd = sim.bulldoze(19, 19); // inside plant (18..19, 18..19)
    c.bulldozeFootprint = bd.ok && bd.removed === p2.bid &&
      S.pop === 2 && S.jobs === 0 &&
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

    // save / load roundtrip reproduces map + pop
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
    c.saveLoad = loaded && sim5.state.pop === sim4.state.pop &&
      sim5.state.jobs === sim4.state.jobs && sim5.save() === blob &&
      sim5.state.map[idx(16, 16)] === T.BLDG && sim5.state.map[idx(16, 17)] === T.ROAD &&
      sim5.state.map[idx(18, 16)] === T.TREE;

    // old v1 saves (and garbage) must return false, not throw
    const v1blob = JSON.stringify({ seed: 1, money: 1500, map: [], pop: 0 });
    c.rejectsV1 = sim5.load(v1blob) === false && sim5.load('not json') === false &&
      sim5.load('{}') === false;

    // ---- rotation checks -------------------------------------------------
    const catalog2 = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: 'h', tw: 1, td: 1, cap: 2, variants: 3 }],
      shops: [{ id: 'shop21', cat: 'shops', name: 'Shop', emoji: 's', tw: 2, td: 1, cap: 3, variants: 2 }],
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
    // find a water tile
    let bx = -1, bz = -1;
    for (let i = 0; i < SB.map.length && bx < 0; i++) {
      if (SB.map[i] === T.WATER) { bx = i % N; bz = (i / N) | 0; }
    }
    const bi = idx(bx, bz);
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
    c.bridgeCrossing = simCross.metrics().bridgeCrossings === 1;
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
    c.bridgeSaveLoad = brLoaded && simBr2.save() === brBlob &&
      simBr2.state.bridge[bi] === 1 && simBr2.state.map[bi] === T.ROAD;
    // a save with no bridges omits the key and loads clean
    const simNoBr = flatten(new Sim(2024, catalog), 10, 10, 30, 30);
    simNoBr.placeRoad(16, 20);
    const noBrBlob = simNoBr.save();
    c.bridgeKeyOmitted = !('bridges' in JSON.parse(noBrBlob));

    // ---- big footprints (v3.1: up to 4×4) --------------------------------
    const catalogBig = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: 'h', tw: 1, td: 1, cap: 2, variants: 3 }],
      fun: [{ id: 'arena', cat: 'fun', name: 'Arena', emoji: 'a', tw: 4, td: 4, cap: 8, variants: 2 }],
      shops: [{ id: 'shop32', cat: 'shops', name: 'Mall', emoji: 'm', tw: 3, td: 2, cap: 5, variants: 2 }],
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
    // arena is category 'fun' → its cap feeds JOBS, residents stay 0.
    c.place4x4 = all16 && !!b44 && b44.tw === 4 && b44.td === 4 &&
      sim44.state.pop === 0 && sim44.state.jobs === 8;

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
    // With N=64 the same (x,z) map to new flat indices; assert they landed there.
    const roadOK = SM.map[idx(28, 28)] === T.ROAD;
    const treeOK = SM.map[idx(26, 26)] === T.TREE;
    const bldgOK = SM.buildings.length === 1 && SM.buildings[0].x === 30 &&
      SM.buildings[0].z === 30 && SM.occ[idx(30, 30)] === SM.buildings[0].bid &&
      SM.map[idx(30, 30)] === T.BLDG && SM.pop === 2;
    // The old flat index, read raw in the new grid, would be the WRONG tile —
    // confirm the remap actually moved it (roadOld != idx(28,28) since N changed).
    const remapped = roadOld !== idx(28, 28);
    c.migrateResize = migLoaded && roadOK && treeOK && bldgOK && remapped;

    // ---- v3.3: pop/jobs split, metrics, happiness, shopNearHome ----------
    const catalog3 = {
      homes: [{ id: 'hut', cat: 'homes', name: 'Hut', emoji: 'h', tw: 1, td: 1, cap: 2, variants: 3 }],
      shops: [{ id: 'bakery', cat: 'shops', name: 'Bakery', emoji: 'b', tw: 1, td: 1, cap: 3, variants: 3 }],
      factories: [{ id: 'plant', cat: 'factories', name: 'Plant', emoji: 'p', tw: 1, td: 1, cap: 5, variants: 3 }],
      fun: [{ id: 'park', cat: 'fun', name: 'Park', emoji: 'k', tw: 1, td: 1, cap: 1, variants: 3 }],
    };
    const hut3 = catalog3.homes[0];
    const bakery3 = catalog3.shops[0];
    const plant3 = catalog3.factories[0];
    const park3 = catalog3.fun[0];

    // pop counts homes only; jobs counts everything else.
    const simM = flatten(new Sim(31337, catalog3), 6, 6, 22, 22);
    const SMx = simM.state;
    simM.place(hut3, 10, 10);   // pop +2
    simM.place(hut3, 12, 10);   // pop +2
    simM.place(bakery3, 14, 10); // jobs +3
    simM.place(plant3, 16, 10); // jobs +5
    c.popHomesOnly = SMx.pop === 4 && SMx.jobs === 8;

    // metrics() returns finite, sane numbers with the required fields.
    const mm = simM.metrics();
    const need = ['residents', 'jobs', 'roadTiles', 'bridges', 'homes', 'shops',
      'factories', 'funCount', 'downtown', 'trees', 'parks', 'schools',
      'firestations', 'shopNearHome', 'happiness', 'air'];
    let metricsSane = need.every((k) => k in mm && Number.isFinite(mm[k]));
    c.metricsSane = metricsSane && mm.residents === 4 && mm.jobs === 8 &&
      mm.homes === 2 && mm.shops === 1 && mm.factories === 1 &&
      mm.happiness >= 0.15 && mm.happiness <= 1 && mm.air >= 0.1 && mm.air <= 1;

    // happiness increases after adding parks + trees. The base map already has
    // ~70 terrain trees, which alone saturate happiness at the clamp ceiling, so
    // first depress it below 1 with factories in the central tree-free zone
    // (each counts as "far from trees" → applies the penalty), then add parks.
    const simHap = flatten(new Sim(4242, catalog3), 20, 20, 40, 40);
    // A few factories in the central tree-free zone depress happiness below the
    // ceiling (each is "far from trees" → penalty) without flooring it, so adding
    // parks can measurably raise it back.
    simHap.place(plant3, 26, 26);
    simHap.place(plant3, 30, 26);
    simHap.place(plant3, 34, 26);
    const h0 = simHap.state.happiness;   // below 1 (a few factories, no nearby trees)
    simHap.place(park3, 26, 32);
    simHap.place(park3, 28, 32);
    simHap.place(park3, 30, 32);
    const h1 = simHap.state.happiness;
    c.happinessRises = h0 < 1 && h1 > h0;

    // shopNearHome detects a shop placed next to a home.
    const simS = flatten(new Sim(5150, catalog3), 14, 14, 44, 44);
    simS.place(hut3, 20, 20);
    simS.place(bakery3, 21, 20);         // adjacent → within Chebyshev 6
    const near = simS.metrics().shopNearHome;
    simS.place(bakery3, 40, 40);         // far away → not counted
    const nearAfterFar = simS.metrics().shopNearHome;
    c.shopNearHome = near === 1 && nearAfterFar === 1;

    // load() recomputes jobs (derived, not stored) from rebuilt buildings.
    const jobsBlob = simM.save();
    const simJ = new Sim(999);
    simJ.setCatalog(catalog3);
    const jLoaded = simJ.load(jobsBlob);
    c.loadRecomputesJobs = jLoaded && simJ.state.pop === 4 && simJ.state.jobs === 8 &&
      Number.isFinite(simJ.state.happiness) && Number.isFinite(simJ.state.air);

    // ---- v3.6: generative terrain (oceans/lakes/rivers/mountains/forests) --
    const simTer = new Sim(24680, catalog);
    const MT = simTer.state.map, VT = simTer.state.variant;
    let nWater = 0, nMtn = 0, nGrass = 0, mtnHOK = true, mtnI = -1;
    for (let i = 0; i < MT.length; i++) {
      const t = MT[i];
      if (t === T.WATER) nWater++;
      else if (t === T.MOUNTAIN) { nMtn++; if (mtnI < 0) mtnI = i; if (VT[i] < 2 || VT[i] > 16) mtnHOK = false; }
      else if (t === T.GRASS) nGrass++;
    }
    c.terrainHasWater = nWater > 20;
    c.terrainHasMountains = nMtn > 8;
    c.terrainMostlyGrass = nGrass > MT.length * 0.4;
    c.mountainHeights = nMtn > 0 && mtnHOK;
    // a mountain tile blocks buildings, roads and trees, and stays a mountain.
    if (mtnI >= 0) {
      const mx = mtnI % N, mz = (mtnI / N) | 0;
      c.mountainBlocks = !simTer.place(hut, mx, mz).ok &&
        !simTer.placeRoad(mx, mz).ok && !simTer.placeTree(mx, mz).ok &&
        simTer.state.map[mtnI] === T.MOUNTAIN;
    } else c.mountainBlocks = false;
    // save→load regenerates the SAME mountains/water from the seed.
    const terBlob = simTer.save();
    const simTer2 = new Sim(1); simTer2.setCatalog(catalog);
    simTer2.load(terBlob);
    let terMatch = true;
    for (let i = 0; i < MT.length; i++) {
      if (MT[i] === T.MOUNTAIN || MT[i] === T.WATER) {
        if (simTer2.state.map[i] !== MT[i]) { terMatch = false; break; }
      }
    }
    c.terrainReload = terMatch;

    out.steps = c;
    out.ok = Object.values(c).every(Boolean);
    return out;
  } catch (e) {
    out.error = String((e && e.stack) || e);
    return out;
  }
}
