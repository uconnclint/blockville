// life.js — the "living city" layer for Blockville.
// Cars, pedestrians, birds, clouds and factory smoke. Pure sim over dynamic
// handles supplied by the engine; all voxel art comes from the models module.
// Imports ONLY constants — engine + models are injected via the constructor so
// this file stays decoupled and testable.

import { TILE, N, T, idx, inBounds } from './constants.js';

// ---- tuning knobs -------------------------------------------------------
const CAR_CAP = 40;
const PED_CAP = 60;
const PUFF_CAP = 40;
const BIRD_COUNT = 4;
const CLOUD_COUNT = 8;

const BOAT_CAP = 3;     // at most 3 boats when the map has enough water
const BALLOON_CAP = 12; // global balloon pool cap
const SPARK_CAP = 60;   // global firework spark pool cap (rockets + particles)
const WATER_MIN = 25;   // need this many water tiles before boats appear
const TRAIL_LEN = 20;   // pedestrian position history samples (for trailing dogs)

const CAR_LANE = 1.6;   // right-hand lane offset (world units)
const PED_LANE = 3.2;   // sidewalk offset
const CAR_Y = 0.5;      // cars sit on the road
const BOAT_Y = -0.2;    // hull rests just below the water surface
const SEG = TILE;       // tile-center to tile-center distance (orthogonal)
const TURN_TIME = 0.25; // seconds to swing to a new heading

const MAP_W = N * TILE;         // world span of the map (0..MAP_W)
const MAP_MID = MAP_W * 0.5;    // map centre in world units

// centre of a tile in world units
const tc = (t) => t * TILE + TILE * 0.5;

// shortest signed angular delta from a -> b, in (-PI, PI]
function angDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// yaw that makes a -Z-forward model face travel direction (dx,dz)
const facing = (dx, dz) => Math.atan2(-dx, -dz);

export class Life {
  constructor(engine, modelsRef) {
    this.engine = engine || null;
    this.models = modelsRef || null;

    this.density = 1;

    // pooled agents (each entry keeps its baked handle + variant so we never
    // create/dispose per frame — inactive entries are just hidden and reused)
    this.cars = [];
    this.peds = [];
    this.puffs = [];
    this.birds = [];
    this.clouds = [];
    this.boats = [];       // water traffic
    this.balloons = [];    // factory balloons rising to the sky
    this.sparks = [];       // firework rockets + burst particles (shared pool)

    // world snapshot rebuilt on sync()
    this.roadTiles = [];   // [{x,z}] road tiles that can host an agent
    this.parkTiles = [];   // [{x,z}] park tiles for wandering pedestrians
    this.waterTiles = [];  // [{x,z}] open water tiles boats can drift across
    this.factories = [];   // [{x,z,timer}] factory chimneys emitting smoke
    this.balloonSites = [];  // [{bid,cx,cz,timer}] balloon-factory roofs
    this.fireworkSites = []; // [{bid,cx,cz,timer}] stadium/ferris/carnival sites
    this.graph = null;     // last roadGraph seen
    this._scanned = false; // have we scanned the map at least once?

    this._rocketsAirborne = 0; // firework rockets currently rising (cap 2)
    this._fireworkBursts = 0;  // diagnostic: total bursts fired
    this._balloonSpawns = 0;   // diagnostic: total balloons released
    this._dogSpawns = 0;       // diagnostic: total dogs attached to peds
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  setDensityScale(f) {
    this.density = (typeof f === 'number' && f >= 0) ? f : 1;
  }

  // Called after the map changes: refresh cached tile lists, drop agents whose
  // tiles are no longer road, and rebuild the factory list.
  sync(state, roadGraph) {
    this.graph = roadGraph || this.graph;
    this._scanMap(state);
    this._scanBuildings(state);

    // revalidate cars & road-pedestrians against the (possibly changed) map
    for (const c of this.cars) {
      if (c.active && !this._isRoad(state, c.cur.x, c.cur.z)) this._retire(c);
    }
    for (const p of this.peds) {
      if (!p.active) continue;
      const ok = p.mode === 'park'
        ? this._isTile(state, p.cur.x, p.cur.z, T.PARK)
        : this._isRoad(state, p.cur.x, p.cur.z);
      if (!ok) this._retire(p);
    }
    // boats: drop any whose tile stopped being water (e.g. a bridge/fill)
    for (const b of this.boats) {
      if (b.active && !this._isWater(state, b.cur.x, b.cur.z)) this._retire(b);
    }
  }

  // Per-frame update. dt is already speed-scaled by the caller (may be 0).
  update(dt, state, roadGraph) {
    if (!state) return;
    if (roadGraph) this.graph = roadGraph;
    if (!this._scanned) { this._scanMap(state); this._scanBuildings(state); }
    dt = (typeof dt === 'number' && dt > 0) ? dt : 0;

    const night = state.clock < 0.25 || state.clock > 0.75;
    const pop = state.pop || 0;

    // ---- target counts ------------------------------------------------
    let carTarget = Math.min(2 + Math.floor(pop / 10), CAR_CAP);
    if (night) carTarget = Math.floor(carTarget / 2);
    carTarget = Math.min(CAR_CAP, Math.floor(carTarget * this.density));
    if (this.roadTiles.length === 0) carTarget = 0;

    let pedTarget = Math.min(Math.floor(pop / 6), 42, PED_CAP);
    if (night) pedTarget = Math.floor(pedTarget * 0.2);
    pedTarget = Math.min(PED_CAP, Math.floor(pedTarget * this.density));
    if (this.roadTiles.length === 0 && this.parkTiles.length === 0) pedTarget = 0;

    // boats scale with density; nothing to do without enough open water
    let boatTarget = 0;
    if (this.waterTiles.length >= WATER_MIN && this.models &&
        typeof this.models.boatModel === 'function') {
      boatTarget = Math.min(BOAT_CAP, Math.max(0, Math.round(BOAT_CAP * this.density)));
    }

    this._maintain(this.cars, carTarget, CAR_CAP, () => this._spawnCar(state));
    this._maintain(this.peds, pedTarget, PED_CAP, () => this._spawnPed(state));
    this._maintain(this.boats, boatTarget, BOAT_CAP, () => this._spawnBoat(state));

    // ---- move everything ---------------------------------------------
    for (const c of this.cars) if (c.active) this._driveCar(c, dt, state);
    for (const p of this.peds) if (p.active) this._movePed(p, dt, state);
    for (const b of this.boats) if (b.active) this._driveBoat(b, dt, state);

    this._ambient(dt);          // birds + clouds always present
    this._smoke(dt, state);     // factory chimney puffs
    this._balloons(dt, state);  // balloon-factory releases
    this._fireworks(dt, state); // nighttime firework shows
  }

  // -------------------------------------------------------------------
  // Map scanning
  // -------------------------------------------------------------------

  _scanMap(state) {
    this.roadTiles.length = 0;
    this.parkTiles.length = 0;
    this.waterTiles.length = 0;
    const oldFac = this.factories;
    this.factories = [];
    this._scanned = true;
    if (!state || !state.map) return;
    const map = state.map;
    const zoneOf = state.zoneOf;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const t = map[idx(x, z)];
        if (t === T.ROAD) this.roadTiles.push({ x, z });
        else if (t === T.WATER) this.waterTiles.push({ x, z });
        else if (t === T.PARK) this.parkTiles.push({ x, z });
        else if (t === T.BLDG && zoneOf && zoneOf[idx(x, z)] === T.ZONE_I) {
          // keep any existing timer so smoke doesn't all fire at once
          let timer = 0.4 + Math.random() * 1.6;
          for (const f of oldFac) {
            if (f.x === x && f.z === z) { timer = f.timer; break; }
          }
          this.factories.push({ x, z, timer });
        }
      }
    }
  }

  // collect the special buildings we animate (balloon factories + firework
  // sites) from state.buildings, keeping any running timers across rescans.
  _scanBuildings(state) {
    const oldB = this.balloonSites;
    const oldF = this.fireworkSites;
    this.balloonSites = [];
    this.fireworkSites = [];
    const list = state && state.buildings;
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b.x !== 'number' || typeof b.z !== 'number') continue;
      if (b.type === 'balloon-factory') {
        const c = this._bcenter(b);
        let timer = 2 + Math.random();
        for (const o of oldB) if (o.bid === b.bid) { timer = o.timer; break; }
        this.balloonSites.push({ bid: b.bid, cx: c.cx, cz: c.cz, timer });
      } else if (b.type === 'stadium' || b.type === 'ferris-wheel' || b.type === 'carnival-games') {
        const c = this._bcenter(b);
        let timer = 4 + Math.random() * 4;
        for (const o of oldF) if (o.bid === b.bid) { timer = o.timer; break; }
        this.fireworkSites.push({ bid: b.bid, cx: c.cx, cz: c.cz, timer });
      }
    }
  }

  // world-space centre of a building's effective footprint (rot swaps tw/td).
  _bcenter(b) {
    const tw = b.tw > 0 ? b.tw : 1;
    const td = b.td > 0 ? b.td : 1;
    const rot = b.rot | 0;
    const etw = (rot & 1) ? td : tw;
    const etd = (rot & 1) ? tw : td;
    return { cx: b.x * TILE + etw * TILE * 0.5, cz: b.z * TILE + etd * TILE * 0.5 };
  }

  _isRoad(state, x, z) {
    if (this.graph && typeof this.graph.isRoad === 'function') {
      try { return !!this.graph.isRoad(x, z); } catch (_) { /* fall through */ }
    }
    return this._isTile(state, x, z, T.ROAD);
  }

  _isWater(state, x, z) {
    return this._isTile(state, x, z, T.WATER);
  }

  // 4-adjacent water neighbours of a tile as [{x,z}]
  _waterNeighbors(state, x, z) {
    const out = [];
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const [dx, dz] of dirs) {
      if (this._isWater(state, x + dx, z + dz)) out.push({ x: x + dx, z: z + dz });
    }
    return out;
  }

  _isTile(state, x, z, type) {
    if (!inBounds(x, z) || !state || !state.map) return false;
    return state.map[idx(x, z)] === type;
  }

  // road neighbours of a tile as [{x,z}]
  _neighbors(state, x, z) {
    if (this.graph && typeof this.graph.neighbors === 'function') {
      try {
        const arr = this.graph.neighbors(x, z);
        if (Array.isArray(arr)) return arr;
      } catch (_) { /* fall through */ }
    }
    const out = [];
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const [dx, dz] of dirs) {
      if (this._isRoad(state, x + dx, z + dz)) out.push({ x: x + dx, z: z + dz });
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Pool maintenance (grow toward target, hide the surplus)
  // -------------------------------------------------------------------

  _maintain(pool, target, cap, spawnFn) {
    let active = 0;
    for (const a of pool) if (a.active) active++;
    // grow
    let guard = cap + 2;
    while (active < target && guard-- > 0) {
      const a = spawnFn();
      if (!a) break;           // nowhere valid to place one
      active++;
    }
    // shrink (hide, don't dispose — avoids per-frame churn)
    for (let i = pool.length - 1; i >= 0 && active > target; i--) {
      if (pool[i].active) { this._retire(pool[i]); active--; }
    }
  }

  _retire(a) {
    a.active = false;
    if (a.handle) { try { a.handle.setVisible(false); } catch (_) {} }
    // a pedestrian's trailing dog hides with its owner
    if (a.dogHandle) { try { a.dogHandle.setVisible(false); } catch (_) {} a.hasDog = false; }
  }

  // find a hidden pooled slot, or make a fresh one if under cap
  _slot(pool, cap, makeModel) {
    for (const a of pool) if (!a.active) return a;
    if (pool.length >= cap) return null;
    if (!this.engine || typeof this.engine.makeDynamic !== 'function') return null;
    let handle = null;
    try { handle = this.engine.makeDynamic(makeModel()); } catch (_) { return null; }
    if (!handle) return null;
    const a = { handle, active: false };
    pool.push(a);
    return a;
  }

  _randRoad() {
    const list = this.roadTiles;
    if (list.length === 0) return null;
    return list[(Math.random() * list.length) | 0];
  }

  // -------------------------------------------------------------------
  // Cars
  // -------------------------------------------------------------------

  _spawnCar(state) {
    // find a road tile that actually has somewhere to drive
    let cur = null, nb = null;
    for (let tries = 0; tries < 8; tries++) {
      const t = this._randRoad();
      if (!t) return null;
      const n = this._neighbors(state, t.x, t.z);
      if (n.length) { cur = t; nb = n; break; }
    }
    if (!cur) return null;

    const variant = (Math.random() * 6) | 0;
    const car = this._slot(this.cars, CAR_CAP, () => this.models.carModel(variant));
    if (!car) return null;
    car.variant = variant;
    car.active = true;
    car.speed = 6 + Math.random() * 4;          // 6..10 u/s
    car.cur = { x: cur.x, z: cur.z };
    car.prev = { x: cur.x, z: cur.z };
    const nxt = nb[(Math.random() * nb.length) | 0];
    car.next = { x: nxt.x, z: nxt.z };
    car.t = 0;
    car.yaw = facing(nxt.x - cur.x, nxt.z - cur.z);
    try { car.handle.setVisible(true); } catch (_) {}
    this._placeLane(car, CAR_LANE, CAR_Y);
    return car;
  }

  _driveCar(car, dt, state) {
    car.t += (car.speed * dt) / SEG;
    while (car.t >= 1) {
      // arrived at next tile — advance and choose a new heading
      car.t -= 1;
      car.prev = car.cur;
      car.cur = car.next;
      const nxt = this._pickNext(state, car.cur, car.prev);
      if (!nxt || !this._isRoad(state, car.cur.x, car.cur.z)) {
        this._retire(car);
        return;
      }
      car.next = nxt;
    }
    this._placeLane(car, CAR_LANE, CAR_Y);
    this._turn(car, dt);
  }

  // pick the next tile: prefer going straight, avoid immediate U-turns
  _pickNext(state, cur, prev) {
    const nb = this._neighbors(state, cur.x, cur.z);
    if (nb.length === 0) return null;
    // candidates excluding the tile we just came from
    const cand = nb.filter((n) => !(n.x === prev.x && n.z === prev.z));
    const pool = cand.length ? cand : nb;   // dead end -> allow U-turn
    // straight = same delta as (cur - prev)
    const ddx = cur.x - prev.x, ddz = cur.z - prev.z;
    const straight = pool.find((n) => (n.x - cur.x) === ddx && (n.z - cur.z) === ddz);
    if (straight && Math.random() < 0.7) return { x: straight.x, z: straight.z };
    const pick = pool[(Math.random() * pool.length) | 0];
    return { x: pick.x, z: pick.z };
  }

  // position an agent along its current segment with a right-hand lane offset
  _placeLane(a, lane, y) {
    const fx = tc(a.cur.x), fz = tc(a.cur.z);
    const tx = tc(a.next.x), tz = tc(a.next.z);
    let dx = tx - fx, dz = tz - fz;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    // right-hand perpendicular (dir rotated -90deg about Y)
    const ox = -dz * lane, oz = dx * lane;
    const px = fx + (tx - fx) * a.t + ox;
    const pz = fz + (tz - fz) * a.t + oz;
    a.px = px; a.pz = pz;
    a.targetYaw = facing(dx, dz);
    if (a.handle) { try { a.handle.setPos(px, y, pz); } catch (_) {} }
  }

  // smoothly swing yaw toward the segment heading over ~TURN_TIME seconds
  _turn(a, dt) {
    const k = dt <= 0 ? 1 : Math.min(1, dt / TURN_TIME);
    a.yaw += angDelta(a.yaw, a.targetYaw) * k;
    if (a.handle) { try { a.handle.setRot(a.yaw); } catch (_) {} }
  }

  // -------------------------------------------------------------------
  // Boats (drift tile-to-tile across open water)
  // -------------------------------------------------------------------

  _randWater() {
    const list = this.waterTiles;
    if (list.length === 0) return null;
    return list[(Math.random() * list.length) | 0];
  }

  _spawnBoat(state) {
    // find a water tile with somewhere to drift
    let cur = null, nb = null;
    for (let tries = 0; tries < 8; tries++) {
      const t = this._randWater();
      if (!t) return null;
      const n = this._waterNeighbors(state, t.x, t.z);
      if (n.length) { cur = t; nb = n; break; }
    }
    if (!cur) return null;

    const variant = (Math.random() * 3) | 0;
    const boat = this._slot(this.boats, BOAT_CAP, () => this.models.boatModel(variant));
    if (!boat) return null;
    boat.variant = variant;
    boat.active = true;
    boat.speed = 1.5 + Math.random() * 1.0;     // 1.5..2.5 u/s
    boat.cur = { x: cur.x, z: cur.z };
    boat.prev = { x: cur.x, z: cur.z };
    const nxt = nb[(Math.random() * nb.length) | 0];
    boat.next = { x: nxt.x, z: nxt.z };
    boat.t = 0;
    boat.bob = Math.random() * Math.PI * 2;
    boat.yaw = facing(nxt.x - cur.x, nxt.z - cur.z);
    boat.targetYaw = boat.yaw;
    try { boat.handle.setVisible(true); } catch (_) {}
    this._placeBoat(boat, 0);
    return boat;
  }

  _driveBoat(boat, dt, state) {
    boat.t += (boat.speed * dt) / SEG;
    while (boat.t >= 1) {
      boat.t -= 1;
      boat.prev = boat.cur;
      boat.cur = boat.next;
      const nxt = this._pickNextWater(state, boat.cur, boat.prev);
      if (!nxt || !this._isWater(state, boat.cur.x, boat.cur.z)) {
        this._retire(boat);
        return;
      }
      boat.next = nxt;
    }
    boat.bob += dt * 1.6;
    this._placeBoat(boat, dt);
    this._turn(boat, dt);
  }

  // pick the next water tile: prefer straight, avoid immediate reversals
  _pickNextWater(state, cur, prev) {
    const nb = this._waterNeighbors(state, cur.x, cur.z);
    if (nb.length === 0) return null;
    const cand = nb.filter((n) => !(n.x === prev.x && n.z === prev.z));
    const pool = cand.length ? cand : nb;
    const ddx = cur.x - prev.x, ddz = cur.z - prev.z;
    const straight = pool.find((n) => (n.x - cur.x) === ddx && (n.z - cur.z) === ddz);
    if (straight && Math.random() < 0.7) return { x: straight.x, z: straight.z };
    const pick = pool[(Math.random() * pool.length) | 0];
    return { x: pick.x, z: pick.z };
  }

  // centre-to-centre placement with a gentle vertical bob (no lane offset)
  _placeBoat(boat, dt) {
    const fx = tc(boat.cur.x), fz = tc(boat.cur.z);
    const tx = tc(boat.next.x), tz = tc(boat.next.z);
    const dx = tx - fx, dz = tz - fz;
    const px = fx + dx * boat.t;
    const pz = fz + dz * boat.t;
    const y = BOAT_Y + Math.sin(boat.bob) * 0.06;
    boat.targetYaw = facing(dx, dz);
    if (boat.handle) { try { boat.handle.setPos(px, y, pz); } catch (_) {} }
  }

  // -------------------------------------------------------------------
  // Pedestrians (road sidewalks + park wandering)
  // -------------------------------------------------------------------

  _spawnPed(state) {
    // Keep parks pleasant, not mobbed: at most ~4 visitors per park tile.
    let parkPeds = 0;
    for (const p of this.peds) if (p.active && p.mode === 'park') parkPeds++;
    const parkRoom = this.parkTiles.length * 4 - parkPeds;
    const wantPark = this.parkTiles.length > 0 && parkRoom > 0 &&
      (this.roadTiles.length === 0 || Math.random() < Math.min(0.25, 0.08 * this.parkTiles.length));
    return wantPark ? this._spawnParkPed(state) : this._spawnRoadPed(state);
  }

  _spawnRoadPed(state) {
    let cur = null, nb = null;
    for (let tries = 0; tries < 8; tries++) {
      const t = this._randRoad();
      if (!t) return this._spawnParkPed(state);
      const n = this._neighbors(state, t.x, t.z);
      if (n.length) { cur = t; nb = n; break; }
    }
    if (!cur) return this._spawnParkPed(state);

    const variant = (Math.random() * 8) | 0;
    const p = this._slot(this.peds, PED_CAP, () => this.models.personModel(variant));
    if (!p) return null;
    p.variant = variant;
    p.active = true;
    p.mode = 'road';
    p.speed = 1.2 + Math.random() * 1.0;   // 1.2..2.2 u/s
    p.cur = { x: cur.x, z: cur.z };
    p.prev = { x: cur.x, z: cur.z };
    const nxt = nb[(Math.random() * nb.length) | 0];
    p.next = { x: nxt.x, z: nxt.z };
    p.t = 0;
    p.yaw = facing(nxt.x - cur.x, nxt.z - cur.z);
    p.bob = Math.random() * Math.PI * 2;
    try { p.handle.setVisible(true); } catch (_) {}
    this._placeLane(p, PED_LANE, 0.1);
    this._attachDog(p);
    return p;
  }

  // 25% of road pedestrians get a little dog trailing ~1.5 units behind.
  _attachDog(p) {
    const canDog = this.models && typeof this.models.dogModel === 'function' &&
      this.engine && typeof this.engine.makeDynamic === 'function';
    if (canDog && Math.random() < 0.25) {
      if (!p.dogHandle) {
        const dv = (Math.random() * 3) | 0;
        try { p.dogHandle = this.engine.makeDynamic(this.models.dogModel(dv)); } catch (_) { p.dogHandle = null; }
      }
      if (p.dogHandle) {
        p.hasDog = true;
        p.dogBob = Math.random() * Math.PI * 2;
        this._dogSpawns++;
        this._trailReset(p);
        try { p.dogHandle.setVisible(true); } catch (_) {}
        return;
      }
    }
    p.hasDog = false;
    if (p.dogHandle) { try { p.dogHandle.setVisible(false); } catch (_) {} }
  }

  _trailReset(p) {
    if (!p.trailX) { p.trailX = new Float32Array(TRAIL_LEN); p.trailZ = new Float32Array(TRAIL_LEN); }
    const px = p.px || 0, pz = p.pz || 0;
    p.trailX.fill(px); p.trailZ.fill(pz);
    p.trailHead = 0;
  }

  // record the owner's position and place the dog ~1.5 units back along the
  // recent path (no per-frame allocation — writes straight into the handle).
  _updateDog(p, dt) {
    if (!p.trailX) this._trailReset(p);
    p.trailHead = (p.trailHead + 1) % TRAIL_LEN;
    p.trailX[p.trailHead] = p.px;
    p.trailZ[p.trailHead] = p.pz;

    let i = p.trailHead;
    let bx = p.trailX[i], bz = p.trailZ[i];
    let acc = 0;
    for (let k = 0; k < TRAIL_LEN - 1; k++) {
      const j = (i - 1 + TRAIL_LEN) % TRAIL_LEN;
      const nx = p.trailX[j], nz = p.trailZ[j];
      const seg = Math.hypot(nx - bx, nz - bz);
      if (acc + seg >= 1.5) {
        const f = (1.5 - acc) / (seg || 1);
        bx += (nx - bx) * f; bz += (nz - bz) * f;
        acc = 1.5; break;
      }
      acc += seg; bx = nx; bz = nz; i = j;
    }

    p.dogBob += dt * 14;                     // fast little bob
    const y = 0.1 + Math.abs(Math.sin(p.dogBob)) * 0.12;
    const ddx = p.px - bx, ddz = p.pz - bz;
    if (p.dogHandle) {
      try {
        p.dogHandle.setPos(bx, y, bz);
        if (ddx || ddz) p.dogHandle.setRot(facing(ddx, ddz));
      } catch (_) {}
    }
  }

  _spawnParkPed(state) {
    if (this.parkTiles.length === 0) return null;
    const tile = this.parkTiles[(Math.random() * this.parkTiles.length) | 0];
    const variant = (Math.random() * 8) | 0;
    const p = this._slot(this.peds, PED_CAP, () => this.models.personModel(variant));
    if (!p) return null;
    p.variant = variant;
    p.active = true;
    p.mode = 'park';
    p.speed = 1.2 + Math.random() * 1.0;
    p.cur = { x: tile.x, z: tile.z };
    p.px = tc(tile.x) + (Math.random() - 0.5) * (TILE - 2);
    p.pz = tc(tile.z) + (Math.random() - 0.5) * (TILE - 2);
    p.yaw = Math.random() * Math.PI * 2;
    p.bob = Math.random() * Math.PI * 2;
    p.hasDog = false;                          // park visitors come without dogs
    if (p.dogHandle) { try { p.dogHandle.setVisible(false); } catch (_) {} }
    this._parkTarget(p);
    try { p.handle.setVisible(true); } catch (_) {}
    return p;
  }

  _parkTarget(p) {
    p.tx = tc(p.cur.x) + (Math.random() - 0.5) * (TILE - 2);
    p.tz = tc(p.cur.z) + (Math.random() - 0.5) * (TILE - 2);
  }

  _movePed(p, dt, state) {
    if (p.mode === 'park') {
      if (!this._isTile(state, p.cur.x, p.cur.z, T.PARK)) { this._retire(p); return; }
      let dx = p.tx - p.px, dz = p.tz - p.pz;
      const d = Math.hypot(dx, dz);
      if (d < 0.2) { this._parkTarget(p); }
      else {
        const step = Math.min(d, p.speed * dt);
        p.px += (dx / d) * step;
        p.pz += (dz / d) * step;
        p.targetYaw = facing(dx / d, dz / d);
        this._turn(p, dt);
      }
    } else {
      p.t += (p.speed * dt) / SEG;
      while (p.t >= 1) {
        p.t -= 1;
        p.prev = p.cur;
        p.cur = p.next;
        const nxt = this._pickNext(state, p.cur, p.prev);
        if (!nxt || !this._isRoad(state, p.cur.x, p.cur.z)) { this._retire(p); return; }
        p.next = nxt;
      }
      this._placeLane(p, PED_LANE, 0.1);
      this._turn(p, dt);
    }
    // tiny walking bob
    p.bob += dt * 8;
    const y = 0.1 + Math.abs(Math.sin(p.bob)) * 0.1;
    if (p.handle) { try { p.handle.setPos(p.px, y, p.pz); } catch (_) {} }
    // a trailing dog follows road pedestrians only
    if (p.mode === 'road' && p.hasDog && p.dogHandle) this._updateDog(p, dt);
  }

  // -------------------------------------------------------------------
  // Birds + clouds (ambient, always present)
  // -------------------------------------------------------------------

  _ambient(dt) {
    if (!this.engine || typeof this.engine.makeDynamic !== 'function' || !this.models) return;

    // lazily create birds
    while (this.birds.length < BIRD_COUNT) {
      let h = null;
      try { h = this.engine.makeDynamic(this.models.birdModel()); } catch (_) { break; }
      if (!h) break;
      const b = {
        handle: h,
        cx: MAP_MID + (Math.random() - 0.5) * 60,
        cz: MAP_MID + (Math.random() - 0.5) * 60,
        a: 70 + Math.random() * 60,          // loop radius
        y: 25 + Math.random() * 15,          // 25..40
        w: 0.12 + Math.random() * 0.13,      // angular speed
        t: Math.random() * Math.PI * 2,
      };
      try { h.setVisible(true); } catch (_) {}
      this.birds.push(b);
    }
    for (const b of this.birds) {
      b.t += b.w * dt;
      const p0 = this._birdPos(b, b.t);
      const p1 = this._birdPos(b, b.t + 0.05);
      try {
        b.handle.setPos(p0.x, p0.y, p0.z);
        b.handle.setRot(facing(p1.x - p0.x, p1.z - p0.z));
      } catch (_) {}
    }

    // lazily create clouds
    while (this.clouds.length < CLOUD_COUNT) {
      const variant = (Math.random() * 4) | 0;
      let h = null;
      try { h = this.engine.makeDynamic(this.models.cloudModel(variant)); } catch (_) { break; }
      if (!h) break;
      const c = {
        handle: h,
        x: -60 + Math.random() * (MAP_W + 120),
        y: 45 + Math.random() * 15,          // 45..60
        z: Math.random() * MAP_W,
        vx: 1.5 + Math.random() * 2.5,       // slow +X drift
      };
      try { h.setVisible(true); } catch (_) {}
      this.clouds.push(c);
    }
    for (const c of this.clouds) {
      c.x += c.vx * dt;
      if (c.x > MAP_W + 60) { c.x = -60; c.z = Math.random() * MAP_W; }
      try { c.handle.setPos(c.x, c.y, c.z); } catch (_) {}
    }
  }

  // lemniscate-ish loop so birds trace lazy figure-eights
  _birdPos(b, t) {
    return {
      x: b.cx + b.a * Math.cos(t),
      z: b.cz + b.a * Math.sin(t) * Math.cos(t),
      y: b.y + Math.sin(t * 6) * 0.6,   // wing-flap bob
    };
  }

  // -------------------------------------------------------------------
  // Factory smoke
  // -------------------------------------------------------------------

  _smoke(dt, state) {
    if (!this.engine || typeof this.engine.makeDynamic !== 'function' || !this.models) return;

    // advance existing puffs
    for (const puff of this.puffs) {
      if (!puff.active) continue;
      puff.age += dt;
      if (puff.age >= puff.life) { this._retire(puff); continue; }
      const rise = 8 / puff.life;             // rise ~8 units over its life
      puff.y += rise * dt;
      puff.x += puff.vx * dt;
      if (puff.handle) { try { puff.handle.setPos(puff.x, puff.y, puff.z); } catch (_) {} }
    }

    // fire new puffs from each chimney
    for (const f of this.factories) {
      f.timer -= dt;
      if (f.timer > 0) continue;
      f.timer = 1.2 + Math.random() * 0.8;    // next puff in 1.2..2s
      const puff = this._slot(this.puffs, PUFF_CAP, () => this.models.smokePuffModel());
      if (!puff) continue;
      puff.active = true;
      puff.x = tc(f.x) + (Math.random() - 0.5) * 1.5;
      puff.y = 9;                              // near the building top
      puff.z = tc(f.z) + (Math.random() - 0.5) * 1.5;
      puff.vx = 0.6 + Math.random() * 0.9;     // gentle drift
      puff.age = 0;
      puff.life = 2.2 + Math.random() * 0.8;
      try {
        puff.handle.setVisible(true);
        puff.handle.setPos(puff.x, puff.y, puff.z);
      } catch (_) {}
    }
  }

  // -------------------------------------------------------------------
  // Factory balloons (rise from balloon-factory roofs and drift away)
  // -------------------------------------------------------------------

  _balloons(dt, state) {
    if (!this.engine || typeof this.engine.makeDynamic !== 'function' || !this.models) return;
    if (typeof this.models.balloonModel !== 'function') return;

    // advance existing balloons
    for (const b of this.balloons) {
      if (!b.active) continue;
      b.y += 3 * dt;                          // rise ~3 u/s
      b.phase += dt;
      b.x = b.baseX + Math.sin(b.phase * b.dw) * b.amp;          // sideways drift
      b.z = b.baseZ + Math.cos(b.phase * b.dw * 0.8) * b.amp * 0.6;
      if (b.y >= 35) { this._retire(b); continue; }
      if (b.handle) { try { b.handle.setPos(b.x, b.y, b.z); } catch (_) {} }
    }

    // release new balloons from each factory roof
    for (const s of this.balloonSites) {
      s.timer -= dt;
      if (s.timer > 0) continue;
      s.timer = 2 + Math.random();            // next in 2..3s
      const variant = (Math.random() * 5) | 0;
      const b = this._slot(this.balloons, BALLOON_CAP, () => this.models.balloonModel(variant));
      if (!b) continue;
      b.active = true;
      b.baseX = s.cx + (Math.random() - 0.5) * (TILE - 2);
      b.baseZ = s.cz + (Math.random() - 0.5) * (TILE - 2);
      b.x = b.baseX; b.z = b.baseZ;
      b.y = 10;                               // start near the roof
      b.phase = Math.random() * Math.PI * 2;
      b.dw = 1 + Math.random();
      b.amp = 0.6 + Math.random() * 0.8;
      this._balloonSpawns++;
      try {
        b.handle.setVisible(true);
        b.handle.setPos(b.x, b.y, b.z);
      } catch (_) {}
    }
  }

  // -------------------------------------------------------------------
  // Fireworks (night only; rockets rise from a site then burst outward)
  // -------------------------------------------------------------------

  _fireworks(dt, state) {
    if (!this.engine || typeof this.engine.makeDynamic !== 'function' || !this.models) return;
    if (typeof this.models.sparkModel !== 'function') return;

    // advance rockets + burst particles that are already airborne
    for (const s of this.sparks) {
      if (!s.active) continue;
      s.age += dt;
      if (s.kind === 'rocket') {
        s.y += s.vy * dt;
        if (s.y >= s.targetY) {
          this._retire(s);
          if (this._rocketsAirborne > 0) this._rocketsAirborne--;
          this._burst(s.x, s.targetY, s.z);
        } else if (s.handle) {
          try { s.handle.setPos(s.x, s.y, s.z); } catch (_) {}
        }
      } else {
        s.vy -= 12 * dt;                      // gravity
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        if (s.age >= s.life) { this._retire(s); continue; }
        if (s.handle) { try { s.handle.setPos(s.x, s.y, s.z); } catch (_) {} }
      }
    }

    // launches only happen at night (day → system idle)
    const night = state.clock < 0.25 || state.clock > 0.78;
    if (!night || this.density <= 0) return;

    for (const site of this.fireworkSites) {
      site.timer -= dt;
      if (site.timer > 0) continue;
      site.timer = 4 + Math.random() * 4;     // 4..8s between shows
      if (this._rocketsAirborne >= 2) continue; // at most 2 bursts airborne
      this._launchRocket(site);
    }
  }

  _launchRocket(site) {
    const variant = (Math.random() * 6) | 0;
    const s = this._slot(this.sparks, SPARK_CAP, () => this.models.sparkModel(variant));
    if (!s) return;
    s.active = true;
    s.kind = 'rocket';
    s.x = site.cx; s.z = site.cz; s.y = 8;
    s.targetY = 30 + Math.random() * 10;      // apex 30..40
    s.vy = (s.targetY - s.y) / 1.0;           // reach apex in ~1s
    s.age = 0; s.life = 2;
    this._rocketsAirborne++;
    try {
      s.handle.setVisible(true);
      s.handle.setPos(s.x, s.y, s.z);
    } catch (_) {}
  }

  _burst(x, y, z) {
    const count = 8 + ((Math.random() * 5) | 0);  // 8..12 sparks
    this._fireworkBursts++;
    for (let i = 0; i < count; i++) {
      const variant = (Math.random() * 6) | 0;
      const s = this._slot(this.sparks, SPARK_CAP, () => this.models.sparkModel(variant));
      if (!s) break;
      s.active = true;
      s.kind = 'particle';
      s.x = x; s.y = y; s.z = z;
      // random outward direction on the unit sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const spd = 8 + Math.random() * 6;      // 8..14 u/s
      const sp = Math.sin(phi);
      s.vx = sp * Math.cos(theta) * spd;
      s.vz = sp * Math.sin(theta) * spd;
      s.vy = Math.cos(phi) * spd;
      s.age = 0; s.life = 0.9;
      try {
        s.handle.setVisible(true);
        s.handle.setPos(s.x, s.y, s.z);
      } catch (_) {}
    }
  }
}

// -------------------------------------------------------------------
// Self-test: run Life against stub engine/models + a fake road-loop map.
// -------------------------------------------------------------------
export function _selfTest() {
  let made = 0;
  const engine = {
    makeDynamic() {
      made++;
      return {
        _v: true,
        setPos() {},
        setRot() {},
        setVisible(b) { this._v = b; },
        dispose() {},
      };
    },
  };
  const tiny = () => ({ sx: 1, sy: 1, sz: 1, blocks: [] });
  const models = {
    carModel: tiny, personModel: tiny, birdModel: tiny,
    cloudModel: tiny, smokePuffModel: tiny,
    // v2.2 pack: boats, dogs, balloons, fireworks
    boatModel: tiny, dogModel: tiny, balloonModel: tiny, sparkModel: tiny,
  };

  // fake state: a rectangular ring of road tiles + a couple of park tiles
  const map = new Uint8Array(N * N);
  const zoneOf = new Uint8Array(N * N);
  const lo = 5, hi = 15;
  for (let i = lo; i <= hi; i++) {
    map[idx(i, lo)] = T.ROAD;
    map[idx(i, hi)] = T.ROAD;
    map[idx(lo, i)] = T.ROAD;
    map[idx(hi, i)] = T.ROAD;
  }
  map[idx(20, 20)] = T.PARK;
  map[idx(21, 20)] = T.PARK;
  // a factory building so smoke has somewhere to come from
  map[idx(25, 25)] = T.BLDG; zoneOf[idx(25, 25)] = T.ZONE_I;
  // a 6×6 lake (36 tiles ≥ 25) so boats have room to drift
  for (let z = 30; z <= 35; z++) {
    for (let x = 30; x <= 35; x++) map[idx(x, z)] = T.WATER;
  }

  // special buildings for balloons + fireworks
  const buildings = [
    { bid: 1, type: 'balloon-factory', cat: 'factories', x: 8, z: 8, tw: 1, td: 1, rot: 0 },
    { bid: 2, type: 'stadium', cat: 'fun', x: 40, z: 8, tw: 2, td: 2, rot: 0 },
  ];

  const state = { map, zoneOf, buildings, pop: 300, clock: 0.3, speed: 1 };

  const isRoad = (x, z) => inBounds(x, z) && map[idx(x, z)] === T.ROAD;
  const roadGraph = {
    isRoad,
    neighbors(x, z) {
      const out = [];
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (const [dx, dz] of dirs) if (isRoad(x + dx, z + dz)) out.push({ x: x + dx, z: z + dz });
      return out;
    },
  };

  try {
    const life = new Life(engine, models);
    life.sync(state, roadGraph);
    // Phase 1 (day): populate a healthy crowd so trailing dogs appear. Boats,
    // balloons and dogs all run by day; fireworks stay idle.
    state.clock = 0.3;
    for (let i = 0; i < 60; i++) life.update(0.1, state, roadGraph);
    // Phase 2 (night): fireworks fire; boats/balloons keep going; the dogs
    // attached to long-lived road peds persist.
    state.clock = 0.9;
    for (let i = 0; i < 200; i++) life.update(0.1, state, roadGraph);

    let cars = 0, peds = 0, puffs = 0, boats = 0, dogs = 0, balloons = 0, sparks = 0;
    for (const c of life.cars) if (c.active) cars++;
    for (const p of life.peds) if (p.active) { peds++; if (p.hasDog) dogs++; }
    for (const p of life.puffs) if (p.active) puffs++;
    for (const b of life.boats) if (b.active) boats++;
    for (const b of life.balloons) if (b.active) balloons++;
    for (const s of life.sparks) if (s.active) sparks++;

    if (cars <= 0) throw new Error('no cars spawned');
    if (peds <= 0) throw new Error('no pedestrians spawned');
    if (life.birds.length !== BIRD_COUNT) throw new Error('birds missing');
    if (life.clouds.length !== CLOUD_COUNT) throw new Error('clouds missing');
    if (boats <= 0) throw new Error('no boats on the water');
    if (life._dogSpawns <= 0) throw new Error('no dogs attached to pedestrians');
    if (life._balloonSpawns <= 0) throw new Error('no balloons released');
    if (life._fireworkBursts <= 0) throw new Error('no fireworks burst');

    return {
      ok: true, cars, peds, puffs, boats,
      dogsActive: dogs, dogSpawns: life._dogSpawns,
      balloonsActive: balloons, balloonSpawns: life._balloonSpawns,
      sparksActive: sparks, bursts: life._fireworkBursts,
      birds: life.birds.length, clouds: life.clouds.length, made,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
