// life.js — the "living city" layer for Blockville.
// Cars, pedestrians, birds, clouds and factory smoke. Pure sim over dynamic
// handles supplied by the engine; all voxel art comes from the models module.
// Imports ONLY constants — engine + models are injected via the constructor so
// this file stays decoupled and testable.
//
// Cosmetic only: nothing here writes sim state, so Math.random is fine and
// multiplayer peers never need to agree on where a car is.
//
// Road agents (cars, sidewalk pedestrians) and boats move on an in-tile PATH:
// each tile is entered through the middle of one edge (heading `din`) and left
// through another (`dout`), offset `lane` units to the right of travel.
//   straight  a line across the tile
//   turn      a quarter circle about the bend's inner corner: radius
//             4 - lane (right turn) or 4 + lane (left turn) — the same arcs the
//             road markings draw (roads.js: 4-unit quarter-circle centreline)
//   U-turn    in to the centre, a half circle of radius `lane`, back out
// Position and heading are exact functions of the distance travelled, so
// vehicles hug their lane through every bend with no pops or yaw lag.
// Road geometry (render/roads.js): 7.3-unit carriageway between 0.35 kerb rims
// (0.8 sidewalks beside open ground) raised 0.35; two 3.65-unit lanes, so the
// lane centre is ~1.8 off the centre line; kerbside bays 8/3 long, 1.15 deep.
// Round 3 scale: cars are ~1 × 2.25 units, buses/trucks ~1.1 × 3.75, people
// 1.0 tall (round 4; models/vehicles.js), so every gap and speed here is sized to them.

import { TILE, N, T, idx, inBounds } from './constants.js';

// ---- tuning knobs -------------------------------------------------------
const CAR_CAP = 300;    // pool size; the live count follows the view (below) (r11: 190 -> 300: iso-mid frames ~80 road tiles)
const PED_CAP = 150;
const PUFF_CAP = 40;
const BIRD_COUNT = 4;
const CLOUD_COUNT = 8;

const BOAT_CAP = 8;     // at most 8 boats when the map has enough water
const BALLOON_CAP = 12; // global balloon pool cap
const SPARK_CAP = 60;   // global firework spark pool cap (rockets + particles)
const WATER_MIN = 25;   // need this many water tiles before boats appear
const TRAIL_LEN = 20;   // pedestrian position history samples (for trailing dogs)
const DOG_GAP = 0.55;   // dog trails its owner by this much path length

const CAR_LANE = 1.25;  // right-hand lane centre (roads.js r14: 6.6-unit carriageway,
                        // 3.3-wide lanes). r12: the middle of the DRIVING strip, i.e.
                        // between the centre dashes (0) and the kerbside bays' lane
                        // line (KERB - 0.93 = 2.37): the r11 critic saw cars "straddle
                        // lane dashes and parking-bay lines". See also LEAN below.
// r12 iso lean: in the orthographic iso view a vehicle's body leans AWAY from
// the camera on screen (a roof h up projects onto ground h·cot(elev) further
// back), so a car whose FOOTPRINT is centred in its lane shows its body
// half over the far line: the far lane's cars sat on the bay lines and the
// near lane's on the centre dashes. _placeCar shifts each drawn car across
// its lane (never along it, so queues keep their gaps) by the lean of half
// its height, which centres the silhouette between the lines. Cosmetic and
// camera-driven (the eased azimuth), so rotating the view stays smooth.
const LEAN = 0.5;       // share of the vehicle height compensated (0.5 = silhouette centre)
const KERB = 3.3;       // kerb face from the tile centre (HALF - roads.js SW 0.7, r14)
const PED_LANE = 3.58;  // on the 0.7 sidewalk, in front of the benches (roads.js SW/SW_G, r14)
const PED_LANE_BRIDGE = 2.9; // inside the bridge railings
const BOAT_LANE = 1.0;  // boats keep right too (gives U-turns a radius)
const ROAD_Y = 0.02;    // asphalt top (roads.js yOffset)
const WALK_Y = 0.32;    // sidewalk top (yOffset + CURB_H = 0.02 + 0.30, roads r13)
const BRIDGE_Y = 1.0;   // bridge deck top (infra.js bridgeModel)
const PARK_BASE = 0.42; // LOT_Y (render/terrain.js): where lot models stand
const WATER_Y = -2.6;   // water plane (render/water.js WATER_Y: recessed basin)
// boat models: row 0 = draft, row 1 (waterline + foam) tops out 0.1 above the
// water, i.e. the model base sits 2/res - 0.1 below it (res 6: 0.23)
const TURN_TIME = 0.25; // seconds to swing to a new heading (park wanderers)
const HALF = TILE * 0.5;

// Car traffic mix over carModel kinds (models/vehicles.js, 14 kinds):
// 0 sedan 1 taxi 2 bus 3 ice-cream 4 fire truck 5 hatchback 6 police
// 7 ambulance 8 box truck 9 pickup 10 SUV 11 panel van 12 school bus 13 city car
const CAR_KINDS = 14;
const CAR_COLOURS = 10; // colour seeds per kind (variant = kind + 14 * seed; vans / box trucks: livery = seed % 6)
// r11 (the r10 critic: "sparse and generic ... add more car types and colours"):
// more trade vans + delivery trucks in the mix, every livery in play
// r13 (the r12 critic: "oversized pink vans dominate the street ... looks like a
// toy set rather than city traffic"): mostly private cars, fewer vans / taxis
const CAR_MIX = [0.245, 0.05, 0.045, 0.01, 0.02, 0.11, 0.05, 0.03, 0.07, 0.05, 0.10, 0.06, 0.02, 0.14];
//                  sedan taxi  bus  ice  fire hatch pol  amb  box  pick suv  van  schl city
const CAR_SPEED = [5.6, 5.6, 4, 3.6, 6, 5.6, 6.4, 6.4, 4.4, 5.2, 5.2, 4.8, 4, 5.6];
// Service vehicles hang around their home buildings (spawn on nearby roads):
// ref05 parks fire engines at the fire station, ambulances at the hospital.
const SITE_KINDS = {
  'fire-station': [4, 4, 7, 6], 'school': [12, 2, 13], 'park': [3], 'playground': [3],
  'zoo': [3, 2], 'stadium': [2, 6, 1], 'ferris-wheel': [3], 'carousel': [3], 'water-slide': [3],
  'city-bank': [6, 1], 'hotel': [1, 13], 'corporate-hq': [1, 0], 'glass-skyscraper': [1, 10],
  'mall': [11, 8, 1], 'grocery': [8, 11], 'warehouse': [8, 8, 11], 'workshop': [9, 11],
  'car-factory': [8, 9], 'toy-factory': [8, 11], 'mega-factory': [8, 8], 'sawmill': [9, 8],
  'recycling-center': [8, 9], 'museum': [2, 1],
};
const SITE_P = 0.35;    // share of spawns that go to a service site in view
// Kerbside parking (round 3): service fleets stand in painted bays along the
// kerb in front of their building (ref05: ambulances in the hospital's bays,
// fire engines on the station apron, box trucks in the depot yard), shoppers'
// cars in front of shops and offices. carModel(v, true) bakes the bay ticks.
// Entries < CAR_KINDS are kinds (colour slot from the tile hash); larger
// entries are exact variants — V(kind, livery) pins a van / truck livery
// (models/vehicles.js VAN_LIV / BOX_LIV), so a depot lines up ONE fleet.
const V = (k, liv) => k + CAR_KINDS * liv;
const FLEET = {
  'fire-station': [4, 4, 7, 6, 4, 7], 'school': [12, 12, 13], 'city-bank': [6, 6, 0, 13], 'hotel': [1, 1, 13],
  'corporate-hq': [1, 0, 10], 'glass-skyscraper': [1, 13], 'museum': [2, 13, 0], 'stadium': [7, 6, 2, 1, 13, 0],
  'zoo': [2, 13], 'park': [3, 13], 'playground': [3, 13],
  // r13 (the r12 critic: ref05's ambulances / police "parked with purpose"):
  // no hospital in the catalog, so the first-aid posts are the big venues
  'swimming-pool': [7, 13, 0], 'mini-golf': [13, 0],
  // depots (r11: ref05's logistics yard = rows of orange delivery trucks)
  'warehouse': [V(8, 0), V(8, 0), V(8, 4), V(11, 0)], 'mega-factory': [V(8, 0), V(8, 0), V(8, 5), V(11, 0)],
  'car-factory': [V(8, 1), 9, 10], 'toy-factory': [V(8, 3), V(8, 3), V(11, 0)], 'sawmill': [9, V(8, 1)],
  'recycling-center': [V(8, 2), 9], 'workshop': [9, V(11, 5), 13],
};
// r11: a shop's own van / truck in the first bay (bakery van at the bakery,
// pizza van at the pizzeria ...), its customers' cars in the rest
const LEAD = {
  // r14 (the r13 critic: "the same van repeats 5 or 6 times"): the cafe and
  // music store no longer lead with a van (the bakery's white van stood at
  // three kerbs of one block); the diner's is the red food van
  'bakery': V(11, 1), 'pizza': V(11, 2), 'burger': V(11, 2), 'diner': V(11, 2),
  'flower-shop': V(11, 4), 'pet-shop': V(11, 5), 'book-shop': V(11, 3),
  'sports-shop': V(11, 5), 'toy-store': V(8, 3), 'grocery': V(8, 2), 'mall': V(8, 0),
  'market-stall': V(8, 2), 'fruit-stand': V(8, 2), 'ice-cream': 3, 'candy-shop': 3,
  'cinema': 1, 'arcade': 1, 'shopping-office': V(8, 0),
};
const DEPOT = [V(8, 0), V(11, 0), 9, V(8, 5)];   // any other factory's yard
const SHOPPER = [13, 0, 5, 10, 13, 9, 1];   // everyone else's customers
const RESIDENT = [0, 5, 13, 10, 0, 9, 13, 5]; // the family car outside a home
const LONG_KIND = [0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0]; // needs two bays
const PARKED_CAP = 900; // parked cars (static, merged per road tile: parkedRowModel)
const PARKED_TILES = 300; // merged tile meshes; off-screen ones are frustum-culled
const BAY = 2.4;        // kerbside bay length (vehicles.js BAY_HALF1 = 1.2 units)
const PARK_SINK = 0.045; // parked model sinks so its baked bay paint (one res-17 voxel, 0.059) is ~0.014 proud
// View focus (cosmetic LOD): the crowd lives where the player is looking.
const VIEW_IN = 1.02;   // NDC half-extent that counts as "on screen"
const VIEW_RING = 1.45; // spawn ring just off screen: traffic drives in
const VIEW_DROP = 1.7;  // agents further out than this are recycled
const CARS_PER_TILE = 3.2;  // on-screen road tile -> live cars (r3, r6, r10 critics: "sparse"; r10 2.6 -> 2.3; r11 -> 3.2, r10: "more traffic on the arterials")
const PEDS_PER_TILE = 2.1;  // on-screen road tile -> live sidewalk people
const SPAWN_PER_FRAME = 6;  // pop-ins per update (smooth fill after a pan)
const PERSON_VARIANTS = 24;
const DOG_VARIANTS = 7;
const BOAT_KINDS = 4;

const MAP_W = N * TILE;         // world span of the map (0..MAP_W)
const MAP_MID = MAP_W * 0.5;    // map centre in world units

// compass directions: 0 N(-Z) 1 E(+X) 2 S(+Z) 3 W(-X); right of d is (d+1)&3
const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const dirOf = (dx, dz) => (dz < 0 ? 0 : dx > 0 ? 1 : dz > 0 ? 2 : 3);

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

// Length of the in-tile path from heading din to heading dout at lane offset r.
// sq (pedestrians): the outside of a bend / a dead end is walked SQUARE, along
// the sidewalk (straight to the corner, turn, straight on) instead of on an
// arc — a wide arc cut across the asphalt, so people stood in the junction.
function pathLen(din, dout, r, sq) {
  if (din === dout) return TILE;
  if (((din + 2) & 3) === dout) return sq ? TILE + 4 * r : TILE + Math.PI * r;
  const right = ((din + 1) & 3) === dout;
  if (sq && !right) return 2 * (HALF + r);
  return (right ? HALF - r : HALF + r) * Math.PI * 0.5;
}

// Evaluate agent `a` (tx,tz,din,dout,s,lane) -> a.px, a.pz, heading a.hx, a.hz.
function evalPath(a) {
  const cx = tc(a.tx), cz = tc(a.tz), r = a.lane, s = a.s;
  const ix = DIRS4[a.din][0], iz = DIRS4[a.din][1];
  const rx = -iz, rz = ix;                         // right of travel
  if (a.din === a.dout) {
    a.px = cx - ix * HALF + rx * r + ix * s;
    a.pz = cz - iz * HALF + rz * r + iz * s;
    a.hx = ix; a.hz = iz;
    return;
  }
  if (a.sq && a.din !== a.dout && ((a.din + 1) & 3) !== a.dout) {
    // square walk: legs of length HALF + r (left turn: 2 legs; U-turn: out,
    // across 2r, back). Corner points sit on the sidewalk centre line.
    const leg = HALF + r;
    const lx = -rx, lz = -rz;                      // left of travel
    if (((a.din + 2) & 3) === a.dout) {
      if (s < leg) { a.px = cx - ix * HALF + rx * r + ix * s; a.pz = cz - iz * HALF + rz * r + iz * s; a.hx = ix; a.hz = iz; }
      else if (s < leg + 2 * r) {
        const t = s - leg;
        a.px = cx + ix * r + rx * (r - t); a.pz = cz + iz * r + rz * (r - t); a.hx = lx; a.hz = lz;
      } else {
        const t = s - leg - 2 * r;
        a.px = cx + ix * (r - t) - rx * r; a.pz = cz + iz * (r - t) - rz * r; a.hx = -ix; a.hz = -iz;
      }
    } else if (s < leg) {
      a.px = cx - ix * HALF + rx * r + ix * s; a.pz = cz - iz * HALF + rz * r + iz * s; a.hx = ix; a.hz = iz;
    } else {
      const t = s - leg;                            // along the exit heading (= left)
      a.px = cx + ix * r + rx * r + lx * t; a.pz = cz + iz * r + rz * r + lz * t; a.hx = lx; a.hz = lz;
    }
    return;
  }
  if (((a.din + 2) & 3) === a.dout) {              // U-turn
    const arc = Math.PI * r;
    if (s < HALF) {
      a.px = cx - ix * (HALF - s) + rx * r; a.pz = cz - iz * (HALF - s) + rz * r;
      a.hx = ix; a.hz = iz;
    } else if (s < HALF + arc) {
      const th = (s - HALF) / r, c = Math.cos(th), sn = Math.sin(th);
      a.px = cx + rx * r * c + ix * r * sn; a.pz = cz + rz * r * c + iz * r * sn;
      a.hx = -rx * sn + ix * c; a.hz = -rz * sn + iz * c;
    } else {
      const s2 = s - HALF - arc;
      a.px = cx - rx * r - ix * s2; a.pz = cz - rz * r - iz * s2;
      a.hx = -ix; a.hz = -iz;
    }
    return;
  }
  // quarter turn about the inner corner K (between the entry edge and exit side)
  const ox = DIRS4[a.dout][0], oz = DIRS4[a.dout][1];
  const kx = cx - ix * HALF + ox * HALF, kz = cz - iz * HALF + oz * HALF;
  const rho = (((a.din + 1) & 3) === a.dout) ? HALF - r : HALF + r;
  const ph = s / rho, c = Math.cos(ph), sn = Math.sin(ph);
  a.px = kx + rho * (-ox * c + ix * sn);
  a.pz = kz + rho * (-oz * c + iz * sn);
  a.hx = ox * sn + ix * c; a.hz = oz * sn + iz * c;
}

export class Life {
  constructor(engine, modelsRef) {
    this.engine = engine || null;
    this.models = modelsRef || null;

    this.density = 1;
    this._leanX = 0; this._leanZ = 0;   // r12 iso-lean (see _leanRefresh)

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
    this.waterCount = 0;   // all water tiles (boats need WATER_MIN of them)
    this._open = new Uint8Array(N * N); // 1 = open water (all 8 neighbours water)
    this._junc = new Uint8Array(N * N); // 1 = road junction (degree >= 3)
    this._claims = new Map();           // junction idx -> bitmask of the headings crossing it
    this.factories = [];   // [{x,z,timer}] factory chimneys emitting smoke
    this.ventSites = [];   // [{bid,i,x,y,z,timer}] catalog chimney mouths (models.catalogVents)
    this._ventBids = new Set(); // buildings smoking from ventSites (skip their per-tile smoke)
    this.balloonSites = [];  // [{bid,cx,cz,timer}] balloon-factory roofs
    this.fireworkSites = []; // [{bid,cx,cz,timer}] stadium/ferris/carnival sites
    this.graph = null;     // last roadGraph seen
    this._scanned = false; // have we scanned the map at least once?
    this._models = new Map(); // variant key -> model (shared geometry per variant)
    this._parkY = null;    // standing height inside a park lot (lazy)

    this._rocketsAirborne = 0; // firework rockets currently rising (cap 2)
    this._fireworkBursts = 0;  // diagnostic: total bursts fired
    this._balloonSpawns = 0;   // diagnostic: total balloons released
    this._dogSpawns = 0;       // diagnostic: total dogs attached to peds

    // view focus: road tiles on screen / in the spawn ring (null = no camera)
    this._view = null;
    this._vm = new Float64Array(16);     // proj * view, column-major
    this._vmSig = NaN;                   // cheap signature of the last matrix
    this._vRoad = []; this._vRing = [];
    this._vTimer = 0;
    this._siteRoads = [];                // [{x,z,kinds}] roads beside service sites
    this.parked = [];                    // [{handle,key,active,...}] kerbside bays
    // Car-park lots (terrain.js vacant-lot parking): terrain records the bays'
    // cars instead of drawing its box cars, and life draws them as the same
    // crisp vehicles as the traffic, one merged mesh per lot (r4 critic: the
    // lot cars were "rounded two-tone lumps — no windscreen, wheels or lights").
    this.lotParks = new Map();           // rect origin tile -> {handle, key}
    this._lotVer = -1;
    const terr = engine && engine._terrain;
    if (terr && terr.lotCars instanceof Map && modelsRef && typeof modelsRef.lotCarsModel === 'function' &&
        typeof engine.makeDynamic === 'function') terr.lotCarsExternal = true;
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
    this._vTimer = 0;                    // reclassify on-screen roads next update

    // revalidate cars & road-pedestrians against the (possibly changed) map
    for (const c of this.cars) {
      if (c.active && !this._pathOk(state, c, (x, z) => this._isRoad(state, x, z))) this._retire(c);
    }
    for (const p of this.peds) {
      if (!p.active) continue;
      const ok = p.mode === 'park'
        ? this._isTile(state, p.cur.x, p.cur.z, T.PARK)
        : this._pathOk(state, p, (x, z) => this._isRoad(state, x, z));
      if (!ok) this._retire(p);
    }
    // boats: drop any whose water stopped being open (e.g. a bridge/fill)
    for (const b of this.boats) {
      if (b.active && !this._pathOk(state, b, (x, z) => this._isOpen(x, z))) this._retire(b);
    }
  }

  // Per-frame update. dt is already speed-scaled by the caller (may be 0).
  update(dt, state, roadGraph) {
    if (!state) return;
    if (roadGraph) this.graph = roadGraph;
    if (!this._scanned) { this._scanMap(state); this._scanBuildings(state); }
    this._syncLotCars();
    dt = (typeof dt === 'number' && dt > 0) ? dt : 0;
    const step = Math.min(dt, 0.25);   // big catch-up steps still move smoothly

    const night = state.clock < 0.25 || state.clock > 0.75;
    const pop = state.pop || 0;

    // ---- target counts ------------------------------------------------
    // Population sets how busy the town can be; the view decides how many of
    // those are alive right now (the crowd follows the camera, so every street
    // the player looks at is busy without paying for the whole map).
    this._viewRefresh(dt);
    this._leanRefresh();
    const v = this._view;
    // r11: pop-in / recycle budgets follow WALL time, not frames. At 60 fps
    // that is the old 6 per frame; on a slow or busy machine (or right after
    // the camera jumps) a frame may cover 0.25 s, and a fixed 6 spawns / 3
    // recycles per frame left most of the crowd stranded off screen for
    // seconds — the review shots caught 4-35 cars in view of 50-120 alive.
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const wall = this._lastWall != null ? Math.max(0, Math.min(1, (now - this._lastWall) / 1000)) : 0;
    this._lastWall = now;
    const budget = Math.max(SPAWN_PER_FRAME, Math.min(90, Math.round(wall * SPAWN_PER_FRAME * 60)));
    // population sets how busy the town can be (r11: pop/8 -> pop/3 — a
    // ~1000-person town capped the streets at ~120 cars, well under the view)
    let carTarget = Math.min(4 + Math.floor(pop / 3), CAR_CAP);
    if (v) carTarget = Math.min(carTarget, Math.max(4, Math.round(v.road * CARS_PER_TILE + v.ring * 0.3)));
    if (night) carTarget = Math.floor(carTarget / 2);
    carTarget = Math.min(CAR_CAP, Math.floor(carTarget * this.density));
    if (this.roadTiles.length === 0) carTarget = 0;

    let pedTarget = Math.min(Math.floor(pop / 5), PED_CAP);
    if (v) pedTarget = Math.min(pedTarget, Math.max(6, Math.round(v.road * PEDS_PER_TILE + v.ring * 0.3)));
    if (night) pedTarget = Math.floor(pedTarget * 0.2);
    pedTarget = Math.min(PED_CAP, Math.floor(pedTarget * this.density));
    if (this.roadTiles.length === 0 && this.parkTiles.length === 0) pedTarget = 0;

    // recycle agents that wandered far off screen (they respawn near the view)
    if (v && v.partial) {
      this._carsInView = this._recycle(this.cars, budget);
      this._pedsInView = this._recycle(this.peds, budget);
    }
    // boats sail where the player can see them (when any open water is on screen)
    if (v && v.water >= 4) this._recycle(this.boats);
    this._carTarget = carTarget; this._pedTarget = pedTarget;

    // boats scale with density; nothing to do without enough open water
    let boatTarget = 0;
    if (this.waterCount >= WATER_MIN && this.waterTiles.length > 0 && this.models &&
        typeof this.models.boatModel === 'function') {
      boatTarget = Math.min(BOAT_CAP, Math.max(0, Math.round(BOAT_CAP * this.density)));
    }

    this._maintain(this.cars, carTarget, CAR_CAP, () => this._spawnCar(state), budget);
    this._maintain(this.peds, pedTarget, PED_CAP, () => this._spawnPed(state), budget);
    this._maintain(this.boats, boatTarget, BOAT_CAP, () => this._spawnBoat(state));

    // ---- move everything ---------------------------------------------
    this._traffic(step, state);
    for (const p of this.peds) if (p.active) this._movePed(p, step, state);
    for (const b of this.boats) if (b.active) this._driveBoat(b, step, state);

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
    this.waterCount = 0;
    this._open.fill(0);
    const oldFac = this.factories;
    this.factories = [];
    this._scanned = true;
    if (!state || !state.map) return;
    const map = state.map;
    const zoneOf = state.zoneOf;
    const water = (x, z) => inBounds(x, z) && map[idx(x, z)] === T.WATER;
    let rsx = 0, rsz = 0, rn = 0;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const t = map[idx(x, z)];
        if (t === T.ROAD) { this.roadTiles.push({ x, z }); rsx += x; rsz += z; rn++; }
        else if (t === T.WATER) {
          this.waterCount++;
          // open water only: boats keep clear of the beach and the banks
          let open = true;
          for (let dz = -1; dz <= 1 && open; dz++) for (let dx = -1; dx <= 1; dx++) {
            if (!water(x + dx, z + dz)) { open = false; break; }
          }
          if (open) { this._open[idx(x, z)] = 1; this.waterTiles.push({ x, z }); }
        }
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
    // junction tiles (3+ road neighbours): cars take turns crossing them
    this._junc.fill(0);
    for (const t of this.roadTiles) {
      let d = 0;
      for (const [dx, dz] of DIRS4) if (inBounds(t.x + dx, t.z + dz) && map[idx(t.x + dx, t.z + dz)] === T.ROAD) d++;
      if (d >= 3) this._junc[idx(t.x, t.z)] = 1;
    }
    // where the town is: boats prefer the water people can see from it
    this._town = rn ? { x: rsx / rn, z: rsz / rn } : { x: N / 2, z: N / 2 };
  }

  // collect the special buildings we animate (balloon factories + firework
  // sites) from state.buildings, keeping any running timers across rescans.
  _scanBuildings(state) {
    const oldB = this.balloonSites;
    const oldF = this.fireworkSites;
    this.balloonSites = [];
    this.fireworkSites = [];
    const list = state && state.buildings;
    const oldV = this.ventSites;
    this.ventSites = [];
    this._ventBids = new Set();
    if (!Array.isArray(list)) return;
    const vents = this.models && typeof this.models.catalogVents === 'function' ? this.models.catalogVents : null;
    for (const b of list) {
      if (!b || typeof b.x !== 'number' || typeof b.z !== 'number') continue;
      // factories with known chimney mouths smoke from those (model-local
      // offsets turned by the building's rot, like engine.addBuilding)
      const vs = vents ? vents(b.type, b.variant | 0) : null;
      if (Array.isArray(vs)) {
        this._ventBids.add(b.bid);
        const c = this._bcenter(b), th = (b.rot | 0) * Math.PI / 2, cs = Math.cos(th), sn = Math.sin(th);
        vs.forEach(([ox, oy, oz], i) => {
          let timer = 0.3 + Math.random() * 1.5;
          for (const o of oldV) if (o.bid === b.bid && o.i === i) { timer = o.timer; break; }
          this.ventSites.push({ bid: b.bid, i, x: c.cx + ox * cs + oz * sn, y: PARK_BASE + oy, z: c.cz - ox * sn + oz * cs, timer });
        });
      }
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
    // roads touching a service site's footprint (its "home" streets)
    this._siteRoads = [];
    const seen = new Set();
    for (const b of list) {
      const kinds = b && SITE_KINDS[b.type];
      if (!kinds || typeof b.x !== 'number' || typeof b.z !== 'number') continue;
      const rot = b.rot | 0, tw = b.tw > 0 ? b.tw : 1, td = b.td > 0 ? b.td : 1;
      const w = (rot & 1) ? td : tw, d = (rot & 1) ? tw : td;
      for (let z = b.z - 1; z <= b.z + d; z++) {
        for (let x = b.x - 1; x <= b.x + w; x++) {
          const edge = x === b.x - 1 || x === b.x + w || z === b.z - 1 || z === b.z + d;
          const corner = (x === b.x - 1 || x === b.x + w) && (z === b.z - 1 || z === b.z + d);
          if (!edge || corner || !this._isTile(state, x, z, T.ROAD)) continue;
          const key = x + ',' + z;
          if (seen.has(key)) continue;
          seen.add(key);
          this._siteRoads.push({ x, z, kinds });
        }
      }
    }
    this._planParking(state);
  }

  // Kerbside bays beside buildings (and on quiet mid-block straights): a bay
  // pair per straight road tile side; the half next to a junction is left
  // clear (that is where roads.js paints the zebra + stop bar). Deterministic
  // per tile, so a rescan never reshuffles the parked cars.
  _planParking(state) {
    const list = state && Array.isArray(state.buildings) ? state.buildings : [];
    const map = state && state.map;
    const slots = [];
    const taken = new Set();
    const road = (x, z) => this._isTile(state, x, z, T.ROAD);
    const deg = (x, z) => { let d = 0; for (const [dx, dz] of DIRS4) if (road(x + dx, z + dz)) d++; return d; };
    const hash = (a, b, c) => { let h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); return ((h ^ (h >>> 15)) >>> 0) / 4294967296; };
    // one kerb of road tile (x,z) on side s (the building / ground side).
    // kinds: kinds / exact variants (FLEET, V()); lead: the first bay's
    // vehicle (a shop's own van) or null; p: chance the kerb is used at all;
    // fill: chance each further bay holds a car.
    const kindOf = (v) => ((v % CAR_KINDS) + CAR_KINDS) % CAR_KINDS;
    const addSide = (x, z, s, kinds, p, fleet, lead, fill) => {
      const key = x + ',' + z + ',' + s;
      if (taken.has(key) || !road(x, z) || this._isBridge(state, x, z)) return;
      const a1 = (s + 1) & 3, a2 = (s + 3) & 3;
      const [ax, az] = DIRS4[a1], [bx, bz] = DIRS4[a2], [sx, sz] = DIRS4[s];
      if (!road(x + ax, z + az) || !road(x + bx, z + bz) || road(x + sx, z + sz) || road(x - sx, z - sz)) return;
      taken.add(key);
      const h = a2;                         // traffic on side s heads h (s is its right)
      const [hx, hz] = DIRS4[h];
      const backJ = deg(x - hx, z - hz) >= 3, aheadJ = deg(x + hx, z + hz) >= 3;
      const kerb = KERB;                    // roads.js SW = SW_G = 0.7 (round 14)
      const r0 = hash(x, z, s);
      if (r0 > p) return;
      const seed = (hash(s, z, x) * CAR_COLOURS) | 0;
      const variantOf = (kk, sd) => kk >= CAR_KINDS ? kk : kk + CAR_KINDS * sd;
      const isLong = (kk) => LONG_KIND[kindOf(kk)] === 1;
      let k = lead != null && hash(z, s, x + 11) < 0.7 ? lead : kinds[(hash(z, x, s + 7) * kinds.length) | 0];
      const both = !backJ && !aheadJ;
      if (isLong(k) && backJ && aheadJ) {
        k = -1;
        for (const q of kinds) if (!isLong(q)) { k = q; break; }
        if (k < 0) k = SHOPPER[(hash(x, s, z) * SHOPPER.length) | 0];
      }
      const push = (kk, along, sd) => slots.push({
        variant: variantOf(kk, sd), fleet, tx: x, tz: z, h, s, bays: isLong(kk) ? 2 : 1,
        kx: sx * kerb + hx * along, kz: sz * kerb + hz * along,
        x: tc(x) + sx * kerb + hx * along, z: tc(z) + sz * kerb + hz * along,
      });
      // Round 7 (vehicles x0.8): bays are BAY (2.4) long, three to a clear
      // kerb, two when one end of the tile meets a junction (its zebra + stop
      // bar take the first ~1.9 units), one when both do. Long kinds take two
      // bays. The first bay is always filled, the rest most of the time.
      const pos = both ? [-BAY, 0, BAY] : backJ && aheadJ ? [0] : backJ ? [0.1, 0.1 + BAY] : [-0.1 - BAY, -0.1];
      let i0 = 0;
      if (isLong(k) && pos.length >= 2) {
        push(k, (pos[0] + pos[1]) / 2, seed);
        i0 = 2;
      } else { push(k, pos[0], seed); i0 = 1; }
      for (let i = i0; i < pos.length; i++) {
        if (hash(x + 3 * i, z, s) >= fill) continue;
        const sd = (hash(z + 7 * i, x, s) * CAR_COLOURS) | 0;   // r11: every car its own colour
        // a fleet's second long vehicle lines up behind the first when it fits
        if (fleet && i === 1 && i0 === 1 && pos.length === 3) {
          const k2 = kinds[(hash(x, z + 5 * i, s) * kinds.length) | 0];
          if (isLong(k2)) { push(k2, (pos[1] + pos[2]) / 2, sd); break; }
        }
        let k2 = kinds[(hash(x, z + 5 * i, s) * kinds.length) | 0];
        if (isLong(k2)) {                   // one bay left: the fleet's own short vehicle, else a shopper
          const short = kinds.filter((q) => !isLong(q));
          k2 = fleet && short.length ? short[(hash(z, i, x) * short.length) | 0] : SHOPPER[(hash(z, i, x) * SHOPPER.length) | 0];
        }
        push(k2, pos[i], sd);
      }
    };
    // 1) fleets + shoppers in front of their buildings. r11 (the r10 critic:
    // "the parking bays hold almost no cars ... fill lot bays with parked
    // fleets that match the building"): fuller kerbs, every category parks.
    for (const b of list) {
      if (!b || typeof b.x !== 'number' || typeof b.z !== 'number') continue;
      const shop = b.cat === 'shops' || b.cat === 'downtown';
      const depot = !FLEET[b.type] && (b.cat === 'factories');
      const kinds = FLEET[b.type] || (depot ? DEPOT : shop ? SHOPPER : b.cat === 'homes' ? RESIDENT
        : b.cat === 'fun' ? SHOPPER : null);
      if (!kinds) continue;
      const fleet = !!FLEET[b.type] || depot;
      const lead = LEAD[b.type] != null ? LEAD[b.type] : null;
      const p = fleet ? 1 : shop ? 0.9 : b.cat === 'homes' ? 0.6 : 0.8;   // r10: 0.95 / 0.65 / 0.45
      const fill = fleet ? 0.95 : shop ? 0.8 : b.cat === 'homes' ? 0.55 : 0.7; // r10: 0.75 / 0.5
      const rot = b.rot | 0, tw = b.tw > 0 ? b.tw : 1, td = b.td > 0 ? b.td : 1;
      const w = (rot & 1) ? td : tw, d = (rot & 1) ? tw : td;
      for (let i = 0; i < w; i++) { addSide(b.x + i, b.z - 1, 2, kinds, p, fleet, lead, fill); addSide(b.x + i, b.z + d, 0, kinds, p, fleet, lead, fill); }
      for (let j = 0; j < d; j++) { addSide(b.x - 1, b.z + j, 1, kinds, p, fleet, lead, fill); addSide(b.x + w, b.z + j, 3, kinds, p, fleet, lead, fill); }
    }
    slots.sort((a, b) => (b.fleet - a.fleet));
    if (slots.length > PARKED_CAP) slots.length = PARKED_CAP;
    this._parkSlots = slots;
    // One merged model per road tile (all its bays, both kerbs): a street of
    // parked cars is one draw call per tile. Models are cached by content, so
    // a rescan that leaves a tile's bays alone reuses its geometry.
    for (const e of this.parked) e.active = false;
    if (!this.engine || typeof this.engine.makeDynamic !== 'function' || !this.models ||
        typeof this.models.parkedRowModel !== 'function') return;
    const tiles = new Map();
    for (const sl of slots) {
      const tk = sl.tx + ',' + sl.tz;
      let t = tiles.get(tk);
      if (!t) tiles.set(tk, t = { x: sl.tx, z: sl.tz, items: [] });
      t.items.push({ variant: sl.variant, kx: sl.kx, kz: sl.kz, h: sl.h, s: sl.s, bays: sl.bays });
    }
    for (const t of tiles.values()) {
      const key = t.items.map((q) => [q.variant, q.kx.toFixed(3), q.kz.toFixed(3), q.h, q.s, q.bays].join(':')).join('|');
      let e = null;
      for (const q of this.parked) if (!q.active && q.key === key) { e = q; break; }
      if (!e) {
        if (this.parked.length >= PARKED_TILES * 2) {
          const i = this.parked.findIndex((q) => !q.active);
          if (i < 0) continue;
          try { this.parked[i].handle.dispose(); } catch (_) {}
          this._models.delete('prow:' + this.parked[i].key);
          this.parked.splice(i, 1);
        }
        let hnd = null;
        try { hnd = this.engine.makeDynamic(this._model('prow', key, () => this.models.parkedRowModel(t.items))); } catch (_) { hnd = null; }
        if (!hnd) continue;
        e = { handle: hnd, key, active: false };
        this.parked.push(e);
      }
      e.active = true; e.tx = t.x; e.tz = t.z; e.cars = t.items.length;
      try { e.handle.setPos(tc(t.x), ROAD_Y - PARK_SINK, tc(t.z)); e.handle.setRot(0); e.handle.setVisible(true); } catch (_) {}
    }
    // Tiles whose bays changed leave a stale mesh behind: keep a few spares
    // (an undo brings them straight back), drop the rest with their models so
    // a long session of road edits never runs the pool dry or piles up geometry.
    let spare = 0;
    this.parked = this.parked.filter((e) => {
      if (e.active) return true;
      try { e.handle.setVisible(false); } catch (_) {}
      if (++spare <= 16) return true;
      try { e.handle.dispose(); } catch (_) {}
      this._models.delete('prow:' + e.key);
      return false;
    });
  }

  // Mirror terrain.lotCars (rect origin -> parked cars) into merged lot meshes.
  // Cheap when nothing changed (one version compare per frame); a lot whose
  // cars changed is re-meshed, lots that vanished are disposed.
  _syncLotCars() {
    const terr = this.engine && this.engine._terrain;
    if (!terr || !terr.lotCarsExternal || !(terr.lotCars instanceof Map)) return;
    if (terr.lotCarsVersion === this._lotVer) return;
    this._lotVer = terr.lotCarsVersion;
    const seen = new Set();
    for (const [o, list] of terr.lotCars) {
      if (!list || !list.length) continue;
      let cx = 0, cz = 0;
      for (const c of list) { cx += c.x; cz += c.z; }
      cx = Math.round(cx / list.length * 4) / 4; cz = Math.round(cz / list.length * 4) / 4;
      const items = list.map((c) => ({ x: c.x - cx, z: c.z - cz, h: c.h | 0, k: c.k | 0 }));
      const key = items.map((q) => q.x.toFixed(2) + ':' + q.z.toFixed(2) + ':' + q.h + ':' + q.k).join('|');
      let e = this.lotParks.get(o);
      if (e && (e.key !== key || e.x !== cx || e.z !== cz)) {
        try { e.handle.dispose(); } catch (_) {}
        this.lotParks.delete(o); e = null;
      }
      if (!e) {
        let hnd = null;
        try { hnd = this.engine.makeDynamic(this._model('lot', key, () => this.models.lotCarsModel(items))); } catch (_) { hnd = null; }
        if (!hnd) continue;
        e = { handle: hnd, key, x: cx, z: cz };
        try { hnd.setPos(cx, list[0].y || 0, cz); hnd.setRot(0); hnd.setVisible(true); } catch (_) {}
        this.lotParks.set(o, e);
      }
      seen.add(o);
    }
    for (const [o, e] of this.lotParks) {
      if (seen.has(o)) continue;
      try { e.handle.dispose(); } catch (_) {}
      this.lotParks.delete(o);
    }
    // keep the model cache from growing without bound across many edits
    if (this._models.size > 900) for (const k of [...this._models.keys()]) if (k.startsWith('lot:')) this._models.delete(k);
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

  _isOpen(x, z) { return inBounds(x, z) && this._open[idx(x, z)] === 1; }

  _isBridge(state, x, z) {
    return !!(state && state.bridge && inBounds(x, z) && state.bridge[idx(x, z)] === 1);
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
    for (const [dx, dz] of DIRS4) {
      if (this._isRoad(state, x + dx, z + dz)) out.push({ x: x + dx, z: z + dz });
    }
    return out;
  }

  // open-water neighbours of a tile as [{x,z}]
  _waterNeighbors(state, x, z) {
    const out = [];
    for (const [dx, dz] of DIRS4) if (this._isOpen(x + dx, z + dz)) out.push({ x: x + dx, z: z + dz });
    return out;
  }

  // -------------------------------------------------------------------
  // Path agents (shared by cars, sidewalk pedestrians and boats)
  // -------------------------------------------------------------------

  // Direction to leave tile (x,z) having entered heading `din`: never straight
  // back unless it's a dead end; mostly straight on (pStraight).
  _chooseDir(nbs, x, z, din, pStraight) {
    if (!nbs || nbs.length === 0) return -1;
    const back = (din + 2) & 3;
    let straight = -1, n = 0;
    const cand = this._cand || (this._cand = [0, 0, 0, 0]);
    for (const nb of nbs) {
      const dx = nb.x - x, dz = nb.z - z;
      if (Math.abs(dx) + Math.abs(dz) !== 1) continue;
      const d = dirOf(dx, dz);
      if (d === back) continue;
      if (d === din) straight = d;
      cand[n++] = d;
    }
    if (n === 0) return back;                      // dead end -> U-turn
    if (straight >= 0 && Math.random() < pStraight) return straight;
    return cand[(Math.random() * n) | 0];
  }

  // Start agent `a` in the middle of tile t, heading toward one of `nbs`.
  _startPath(a, t, nbs, lane) {
    const nb = nbs[(Math.random() * nbs.length) | 0];
    const d = dirOf(nb.x - t.x, nb.z - t.z);
    a.tx = t.x; a.tz = t.z; a.din = d; a.dout = d;
    a.lane = lane; a.s = HALF; a.len = pathLen(d, d, lane, a.sq);
    a.cur = { x: t.x, z: t.z };
    evalPath(a);
  }

  // Move `dist` along the path; false if the agent ran off valid tiles.
  _advance(a, dist, ok, nbsOf, pStraight, laneOf) {
    a.s += dist;
    let guard = 6;
    while (a.s >= a.len && guard-- > 0) {
      a.s -= a.len;
      a.tx += DIRS4[a.dout][0]; a.tz += DIRS4[a.dout][1];
      a.din = a.dout;
      a.cur.x = a.tx; a.cur.z = a.tz;
      if (!ok(a.tx, a.tz)) return false;
      const nbsHere = nbsOf(a.tx, a.tz);
      let d = -1;
      // a car that looked ahead at this junction (room on its exit) keeps that exit
      if (a.pre != null && a.preAt === a.tx * 4096 + a.tz) {
        for (const nb of nbsHere) if (dirOf(nb.x - a.tx, nb.z - a.tz) === a.pre) { d = a.pre; break; }
      }
      a.pre = null; a.preAt = -1;
      if (d < 0) d = this._chooseDir(nbsHere, a.tx, a.tz, a.din, pStraight);
      if (d < 0) return false;
      a.dout = d;
      if (laneOf) a.lane = laneOf(a.tx, a.tz);
      a.len = pathLen(a.din, a.dout, a.lane, a.sq);
    }
    if (a.s >= a.len) a.s = a.len - 1e-3;
    evalPath(a);
    return true;
  }

  // Is the agent's current tile (and the one it is heading into) still valid?
  _pathOk(state, a, ok) {
    if (a.tx == null) return false;
    return ok(a.tx, a.tz) && ok(a.tx + DIRS4[a.dout][0], a.tz + DIRS4[a.dout][1]);
  }

  // Ground height at a point on road tile (tx,tz): the 8×8 cell rule of
  // roads.js (corners + edge bands facing non-road = sidewalk, else asphalt).
  _groundY(state, tx, tz, px, pz) {
    if (this._isBridge(state, tx, tz)) return BRIDGE_Y;
    const cx = Math.min(7, Math.max(0, Math.floor(px - tx * TILE)));
    const cz = Math.min(7, Math.max(0, Math.floor(pz - tz * TILE)));
    const ex = cx === 0 ? 3 : cx === 7 ? 1 : -1;
    const ez = cz === 0 ? 0 : cz === 7 ? 2 : -1;
    if (ex >= 0 && ez >= 0) return WALK_Y;
    const d = ex >= 0 ? ex : ez;
    if (d < 0) return ROAD_Y;
    return this._isRoad(state, tx + DIRS4[d][0], tz + DIRS4[d][1]) ? ROAD_Y : WALK_Y;
  }

  // -------------------------------------------------------------------
  // View focus (cosmetic LOD)
  // -------------------------------------------------------------------

  // Rebuild proj*view from the engine camera; reclassify road tiles into
  // on-screen / spawn-ring lists when the view moved (or every 0.5 s).
  // No camera (self-test, headless) -> this._view = null: uniform spawning.
  _viewRefresh(dt) {
    const cam = this.engine && this.engine.camera;
    const P = cam && cam.projectionMatrix && cam.projectionMatrix.elements;
    const V = cam && cam.matrixWorldInverse && cam.matrixWorldInverse.elements;
    if (!P || !V || P.length !== 16 || V.length !== 16) { this._view = null; return; }
    const M = this._vm;
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        M[c * 4 + r] = P[r] * V[c * 4] + P[4 + r] * V[c * 4 + 1] + P[8 + r] * V[c * 4 + 2] + P[12 + r] * V[c * 4 + 3];
      }
    }
    let sig = 0;
    for (let i = 0; i < 16; i++) sig += M[i] * (i + 1.37);
    this._vTimer -= dt;
    if (!Number.isFinite(sig)) { this._view = null; return; }
    if (this._view && sig === this._vmSig && this._vTimer > 0) return;
    this._vmSig = sig; this._vTimer = 0.5;
    const vr = this._vRoad, rg = this._vRing, vw = this._vWater || (this._vWater = []);
    vr.length = 0; rg.length = 0; vw.length = 0;
    for (const t of this.roadTiles) {
      const e = this._ndcExtent(tc(t.x), 0, tc(t.z));
      if (e <= VIEW_IN) vr.push(t); else if (e <= VIEW_RING) rg.push(t);
    }
    for (const t of this.waterTiles) if (this._ndcExtent(tc(t.x), WATER_Y, tc(t.z)) <= 0.9) vw.push(t);
    this._view = { road: vr.length, ring: rg.length, water: vw.length, partial: vr.length < this.roadTiles.length };
  }

  // max(|ndc x|, |ndc y|) of a world point (Infinity behind a perspective eye)
  _ndcExtent(x, y, z) {
    const M = this._vm;
    const w = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (!(w > 1e-6)) return Infinity;
    const nx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / w;
    const ny = (M[1] * x + M[5] * y + M[9] * z + M[13]) / w;
    return Math.max(Math.abs(nx), Math.abs(ny));
  }

  // Retire (at most `budget`, min 3, per frame) agents far off screen; returns how many of
  // the pool are on screen now.
  _recycle(pool, budget) {
    const cap = Math.max(3, budget | 0);
    let dropped = 0, seen = 0;
    for (const a of pool) {
      if (!a.active) continue;
      const e = this._ndcExtent(a.px, a.y || 0, a.pz);
      if (e <= VIEW_IN) seen++;
      else if (e > VIEW_DROP && dropped < cap) { this._retire(a); dropped++; }
    }
    return seen;
  }

  // A road tile to spawn on: straight onto the screen while it is still
  // filling up, otherwise just off screen so traffic drives into view.
  _viewRoad(inView, target) {
    const v = this._view;
    if (!v || !v.partial) return this._randRoad();
    const fill = inView < target * 0.7;
    const a = fill ? this._vRoad : this._vRing, b = fill ? this._vRing : this._vRoad;
    if (a.length) return a[(Math.random() * a.length) | 0];
    if (b.length) return b[(Math.random() * b.length) | 0];
    return this._randRoad();
  }

  // -------------------------------------------------------------------
  // Pool maintenance (grow toward target, hide the surplus)
  // -------------------------------------------------------------------

  _maintain(pool, target, cap, spawnFn, maxSpawn) {
    let active = 0;
    for (const a of pool) if (a.active) active++;
    // grow
    let guard = Math.min(cap + 2, maxSpawn > 0 ? maxSpawn : cap + 2);
    let fails = 0;
    const maxFails = Math.max(4, guard >> 1);
    while (active < target && guard-- > 0) {
      const a = spawnFn();
      // a spot can be refused (junction mouth, another car there): try a few
      // more before giving up for this frame (r11: one refusal used to end it)
      if (!a) { if (++fails > maxFails) break; continue; }
      active++;
    }
    // shrink (hide, don't dispose — avoids per-frame churn); off-screen first
    if (active > target && this._view) {
      for (let i = pool.length - 1; i >= 0 && active > target; i--) {
        const a = pool[i];
        if (a.active && a.px != null && this._ndcExtent(a.px, a.y || 0, a.pz) > VIEW_IN) { this._retire(a); active--; }
      }
    }
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

  // one model object per (kind, variant) so every pooled copy shares geometry
  _model(kind, variant, make) {
    const key = kind + ':' + variant;
    let m = this._models.get(key);
    if (!m) { m = make(); this._models.set(key, m); }
    return m;
  }

  // find a hidden pooled slot, or make a fresh one if under cap. A reused slot
  // keeps the model (and variant) it was built with.
  _slot(pool, cap, makeModel, variant) {
    for (const a of pool) if (!a.active) return a;
    if (pool.length >= cap) return null;
    if (!this.engine || typeof this.engine.makeDynamic !== 'function') return null;
    let handle = null, model = null;
    try { model = makeModel(); handle = this.engine.makeDynamic(model); } catch (_) { return null; }
    if (!handle) return null;
    const res = (model && model.res) || 1;
    const a = {
      handle, active: false, variant: variant | 0,
      blen: model && model.sz ? model.sz / res : 3, // body length in world units
      bh: model && model.sy ? model.sy / res : 0,   // height (r12: iso-lean compensation)
      res,
    };
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

  _pickCarVariant(kind) {
    let k = kind;
    if (k == null) {
      let r = Math.random(); k = 0;
      for (; k < CAR_KINDS - 1; k++) { r -= CAR_MIX[k]; if (r < 0) break; }
    }
    return k + CAR_KINDS * ((Math.random() * CAR_COLOURS) | 0);
  }

  // A road beside a service site that is on (or just off) screen, or null.
  _siteSpawn() {
    const list = this._siteRoads;
    if (!list.length) return null;
    for (let tries = 0; tries < 6; tries++) {
      const s = list[(Math.random() * list.length) | 0];
      if (!this._view || this._ndcExtent(tc(s.x), 0, tc(s.z)) <= VIEW_RING) return s;
    }
    return null;
  }

  _spawnCar(state) {
    // find a road tile that actually has somewhere to drive: sometimes beside
    // a service site (fire engines at the fire station ...), else near the view
    let cur = null, nb = null, kind = null;
    if (Math.random() < SITE_P) {
      const s = this._siteSpawn();
      if (s) {
        const n = this._neighbors(state, s.x, s.z);
        if (n.length && !this._junc[idx(s.x, s.z)]) { cur = s; nb = n; kind = s.kinds[(Math.random() * s.kinds.length) | 0]; }
      }
    }
    for (let tries = 0; tries < 8 && !cur; tries++) {
      const t = this._viewRoad(this._carsInView || 0, this._carTarget || 0);
      if (!t) return null;
      if (this._junc[idx(t.x, t.z)]) continue;     // r11: pick another tile, don't give up
      const n = this._neighbors(state, t.x, t.z);
      if (n.length) { cur = t; nb = n; break; }
    }
    if (!cur) return null;
    // never pop into existence inside a junction: crossing flows there are
    // only kept apart by the claim logic, which a fresh car would bypass
    if (this._junc[idx(cur.x, cur.z)]) return null;

    const variant = this._pickCarVariant(kind);
    const car = this._slot(this.cars, CAR_CAP,
      () => this._model('car', variant, () => this.models.carModel(variant)), variant);
    if (!car) return null;
    this._startPath(car, cur, nb, CAR_LANE);
    // r11: anywhere along the straight, not only mid-tile (two spawn spots a
    // tile capped a freshly framed street at ~2 cars per tile)
    // Keep clear of junctions at either end (a car spawned in the stop-bar
    // zone would bypass the junction claims).
    {
      const [dx, dz] = DIRS4[car.dout];
      const jA = inBounds(cur.x + dx, cur.z + dz) && this._junc[idx(cur.x + dx, cur.z + dz)];
      const jB = inBounds(cur.x - dx, cur.z - dz) && this._junc[idx(cur.x - dx, cur.z - dz)];
      const lo = jB ? 2.5 : 1, hi = car.len - (jA ? 4.8 : 1);
      car.s = hi > lo ? lo + Math.random() * (hi - lo) : HALF; evalPath(car);
    }
    // don't pop into existence on top of another car
    for (const o of this.cars) {
      if (o === car || !o.active) continue;
      if (Math.abs(o.px - car.px) + Math.abs(o.pz - car.pz) < (o.blen + car.blen) * 0.6 ||
          Math.hypot(o.px - car.px, o.pz - car.pz) < (o.blen + car.blen) * 0.5 + 0.4) { car.active = false; return null; }
    }
    const ck = ((car.variant % CAR_KINDS) + CAR_KINDS) % CAR_KINDS;
    car.active = true;
    car.vmax = CAR_SPEED[ck] * (0.85 + Math.random() * 0.3);
    car.v = car.vmax * 0.5;
    car.stuck = 0; car.held = 0; car.ghost = 0; car.pre = null; car.preAt = -1;
    car.y = this._isBridge(state, cur.x, cur.z) ? BRIDGE_Y : ROAD_Y;
    try { car.handle.setVisible(true); } catch (_) {}
    this._placeCar(car);
    if (this._view && this._ndcExtent(car.px, car.y, car.pz) <= VIEW_IN) this._carsInView = (this._carsInView || 0) + 1;
    return car;
  }

  // All cars: car-following (keep a gap to whoever is ahead in the same lane),
  // gentle braking into bends, smooth acceleration, then move along the path.
  _traffic(dt, state) {
    const cars = this.cars;
    if (dt <= 0) { for (const c of cars) if (c.active) this._placeCar(c); return; }
    // Junctions are crossed by one AXIS at a time: cars already inside hold
    // the junction, approaching cars claim it first-come. r11 (denser
    // traffic): the opposite flow shares the claim when nobody is turning
    // left across it (one flow at a time kept 4-way queues waiting >3 s, and
    // the anti-gridlock ghosting then pushed cars through each other).
    const claims = this._claims;
    claims.clear();
    const lefts = this._lefts || (this._lefts = new Set());
    lefts.clear();
    for (const a of cars) {
      if (!a.active || !inBounds(a.tx, a.tz)) continue;
      const i = idx(a.tx, a.tz);
      if (!this._junc[i]) continue;
      claims.set(i, (claims.get(i) | 0) | (1 << a.din));
      if (a.dout === ((a.din + 3) & 3)) lefts.add(i);
    }
    // can a car heading d (turning left?) go in beside the headings in mask m?
    const fits = (i, m, d, left) => {
      m = m | 0;
      if ((m & ~(1 << d)) === 0) return true;                 // empty, or my own flow
      if ((m & ~((1 << d) | (1 << ((d + 2) & 3)))) !== 0) return false; // cross traffic inside
      return !left && !lefts.has(i);                           // oncoming only: no left turns
    };
    // Fairness: a flow that has waited ~1 s goes next — the wait holds until
    // a car of that flow is inside; meanwhile other flows' uncommitted cars
    // stop at their bars.
    const waits = this._waits || (this._waits = new Map());
    for (const [i, d] of waits) {
      const c = claims.get(i) | 0;
      if ((c & (1 << d)) || !this._junc[i]) waits.delete(i);
      else if (c === 0) claims.set(i, 1 << d);
    }
    for (const a of cars) {
      if (!a.active) continue;
      let gap = Infinity;
      const nx = a.tx + DIRS4[a.dout][0], nz = a.tz + DIRS4[a.dout][1];
      const rem = a.len - a.s;                     // path left in this tile
      if (a.ghost <= 0 && rem < 8 && inBounds(nx, nz) && this._junc[idx(nx, nz)]) {
        const ni = idx(nx, nz), c = claims.get(ni), w = waits.get(ni);
        const free = rem - a.blen * 0.5 > 2.3;       // nose still behind the stop bar
        // r11 don't-block-the-box: pick the exit now and only go in when the
        // exit tile has room for the whole car (a car stuck INSIDE a junction
        // held its claim and locked the grid until the ghosting kicked in)
        if (a.preAt !== nx * 4096 + nz) {
          a.preAt = nx * 4096 + nz;
          a.pre = this._chooseDir(this._neighbors(state, nx, nz), nx, nz, a.dout, 0.7);
        }
        const left = a.pre === ((a.dout + 3) & 3);
        let full = false;
        if (free && a.pre != null && a.pre >= 0) {
          const ex = nx + DIRS4[a.pre][0], ez = nz + DIRS4[a.pre][1];
          for (const b of cars) {
            if (b === a || !b.active || b.tx !== ex || b.tz !== ez || b.din !== a.pre) continue;
            if (b.s - b.blen * 0.5 < a.blen + 0.7) { full = true; break; }
          }
        }
        const held = free && ((w !== undefined && !fits(ni, 1 << w, a.dout, left)) || full);
        const ok = fits(ni, c, a.dout, left);
        if (ok && !held) {
          claims.set(ni, (c | 0) | (1 << a.dout));
          if (left) lefts.add(ni);
        } else {
          if (a.stuck > 1 && w === undefined) waits.set(ni, a.dout);
          // wait behind the stop bar (roads.js: 2.42..2.74 back from the mouth),
          // or at the mouth if the nose is already past it
          const nose = rem - a.blen * 0.5;
          gap = nose - (nose > 2.3 ? 2.35 : -0.25);
        }
      }
      let queued = false;                           // behind a stopped car (a queue)
      if (a.ghost <= 0) {
        for (const b of cars) {
          if (b === a || !b.active) continue;
          const dx = b.px - a.px, dz = b.pz - a.pz;
          const along = dx * a.hx + dz * a.hz;
          if (along <= 0 || along > 10) continue;
          if (Math.abs(dx * a.hz - dz * a.hx) > 1.0) continue;       // not in my lane
          if (a.hx * b.hx + a.hz * b.hz < 0.2) continue;               // crossing / oncoming
          const g = along - (a.blen + b.blen) * 0.5;
          if (g < gap) { gap = g; queued = b.v < 0.2; }
        }
      }
      let target = a.vmax;
      if (a.din !== a.dout) target *= ((a.din + 1) & 3) === a.dout ? 0.55 : 0.7; // corner speed
      if (gap < 3.4) target = Math.min(target, Math.max(0, (gap - 0.45) * a.vmax / 2.6));
      const dv = target - a.v;
      a.v += Math.max(-18 * dt, Math.min(7 * dt, dv));
      if (a.v < 0) a.v = 0;
      // anti-gridlock: a car held up for a while squeezes through. r11: not a
      // car simply queueing behind a stopped car (queues are now longer and
      // resolve at the front; ghosting them drove cars through each other),
      // and only after 8 s at a junction (the claims are fair now).
      // (a queue that never moves for 20 s is a loop: ghost out of it too)
      if (a.v < 0.2) {
        a.stuck = queued ? Math.min(a.stuck + dt, 0.9) : a.stuck + dt;
        a.held = (a.held || 0) + dt;
        if (a.stuck > 8 || a.held > 20) { a.ghost = 1.5; a.stuck = 0; a.held = 0; }
      } else { a.stuck = 0; a.held = 0; }
      if (a.ghost > 0) a.ghost -= dt;
    }
    for (const a of cars) {
      if (!a.active) continue;
      const ok = this._advance(a, a.v * dt, (x, z) => this._isRoad(state, x, z),
        (x, z) => this._neighbors(state, x, z), 0.7);
      if (!ok) { this._retire(a); continue; }
      const ty = this._isBridge(state, a.tx, a.tz) ? BRIDGE_Y : ROAD_Y;
      a.y += (ty - a.y) * Math.min(1, dt * 8);
      this._placeCar(a);
    }
  }

  _placeCar(a) {
    if (!a.handle) return;
    // r12: cross-lane iso-lean compensation (see LEAN)
    const rx = -a.hz, rz = a.hx;
    const d = LEAN * (a.bh || 0) * (this._leanX * rx + this._leanZ * rz);
    try { a.handle.setPos(a.px + rx * d, a.y, a.pz + rz * d); a.handle.setRot(facing(a.hx, a.hz)); } catch (_) {}
  }

  // r12: ground offset per unit height of the orthographic view's lean: a
  // point h up draws over the ground point h·(leanX, leanZ) BEHIND it.
  _leanRefresh() {
    this._leanX = 0; this._leanZ = 0;
    const cam = this.engine && this.engine.camera;
    const e = cam && cam.matrixWorld && cam.matrixWorld.elements;
    if (!e || e.length !== 16) return;
    const up = e[9];                         // camera +Z (toward the eye) . world up
    if (!(up > 0.2)) return;                 // near-horizontal views: no compensation
    const lx = e[8] / up, lz = e[10] / up;
    if (Number.isFinite(lx) && Number.isFinite(lz)) { this._leanX = lx; this._leanZ = lz; }
  }

  // -------------------------------------------------------------------
  // Boats (cruise tile-to-tile across open water, arcs through the bends)
  // -------------------------------------------------------------------

  _randWater() {
    const list = this.waterTiles;
    if (list.length === 0) return null;
    return list[(Math.random() * list.length) | 0];
  }

  _spawnBoat(state) {
    // find an open-water tile with somewhere to go
    let cur = null, nb = null;
    const town = this._town || { x: N / 2, z: N / 2 };
    let bestD = Infinity;
    const vw = this._view && this._view.water >= 4 ? this._vWater : null;
    for (let tries = 0; tries < 10; tries++) {      // best of a few: on screen / near town
      const t = vw ? vw[(Math.random() * vw.length) | 0] : this._randWater();
      if (!t) return null;
      const n = this._waterNeighbors(state, t.x, t.z);
      if (!n.length) continue;
      let d = Math.hypot(t.x - town.x, t.z - town.z);
      for (const o of this.boats) if (o.active && Math.abs(o.tx - t.x) + Math.abs(o.tz - t.z) < 3) d += 40;
      if (d < bestD) { bestD = d; cur = t; nb = n; }
    }
    if (!cur) return null;

    const variant = (Math.random() * BOAT_KINDS * 3) | 0;
    const boat = this._slot(this.boats, BOAT_CAP,
      () => this._model('boat', variant, () => this.models.boatModel(variant)), variant);
    if (!boat) return null;
    this._startPath(boat, cur, nb, BOAT_LANE);
    boat.active = true;
    const kind = ((boat.variant % BOAT_KINDS) + BOAT_KINDS) % BOAT_KINDS;
    boat.speed = [1.8, 1.1, 1.6, 3.2][kind] * (0.85 + Math.random() * 0.3);
    boat.bob = Math.random() * Math.PI * 2;
    try { boat.handle.setVisible(true); } catch (_) {}
    this._placeBoat(boat);
    return boat;
  }

  _driveBoat(boat, dt, state) {
    const ok = this._advance(boat, boat.speed * dt, (x, z) => this._isOpen(x, z),
      (x, z) => this._waterNeighbors(state, x, z), 0.6);
    if (!ok) { this._retire(boat); return; }
    boat.bob += dt * 1.6;
    this._placeBoat(boat);
  }

  _placeBoat(boat) {
    const y = WATER_Y + 0.1 - 2 / (boat.res || 4) + Math.sin(boat.bob) * 0.04;
    if (boat.handle) {
      try { boat.handle.setPos(boat.px, y, boat.pz); boat.handle.setRot(facing(boat.hx, boat.hz)); } catch (_) {}
    }
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

  _pedModel(variant) {
    return () => this._model('person', variant, () => this.models.personModel(variant));
  }

  _spawnRoadPed(state) {
    let cur = null, nb = null;
    for (let tries = 0; tries < 8; tries++) {
      const t = this._viewRoad(this._pedsInView || 0, this._pedTarget || 0);
      if (!t) return this._spawnParkPed(state);
      // start on a real sidewalk: heading d puts the walker on its right-hand
      // side, which must face a lot / grass (not a road mouth), so a paused
      // frame never shows someone standing on the asphalt of a junction or bend
      const n = this._neighbors(state, t.x, t.z).filter((q) => {
        const d = dirOf(q.x - t.x, q.z - t.z), rs = DIRS4[(d + 1) & 3];
        return !this._isRoad(state, t.x + rs[0], t.z + rs[1]);
      });
      if (n.length) { cur = t; nb = n; break; }
    }
    if (!cur) return this._spawnParkPed(state);

    const variant = (Math.random() * PERSON_VARIANTS) | 0;
    const p = this._slot(this.peds, PED_CAP, this._pedModel(variant), variant);
    if (!p) return null;
    p.active = true;
    p.mode = 'road';
    p.sq = true;                          // walk bends / dead ends square, on the sidewalk
    p.speed = 0.6 + Math.random() * 0.4; // 0.6..1.0 u/s (people are 1.0 tall)
    this._startPath(p, cur, nb, this._isBridge(state, cur.x, cur.z) ? PED_LANE_BRIDGE : PED_LANE);
    p.bob = Math.random() * Math.PI * 2;
    p.y = this._groundY(state, p.tx, p.tz, p.px, p.pz);
    try { p.handle.setVisible(true); } catch (_) {}
    this._attachDog(p);
    if (this._view && this._ndcExtent(p.px, p.y, p.pz) <= VIEW_IN) this._pedsInView = (this._pedsInView || 0) + 1;
    return p;
  }

  // 25% of road pedestrians get a little dog trailing just behind.
  _attachDog(p) {
    const canDog = this.models && typeof this.models.dogModel === 'function' &&
      this.engine && typeof this.engine.makeDynamic === 'function';
    if (canDog && Math.random() < 0.25) {
      if (!p.dogHandle) {
        const dv = (Math.random() * DOG_VARIANTS) | 0;
        try {
          p.dogHandle = this.engine.makeDynamic(this._model('dog', dv, () => this.models.dogModel(dv)));
        } catch (_) { p.dogHandle = null; }
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
    if (!p.trailX) {
      p.trailX = new Float32Array(TRAIL_LEN); p.trailZ = new Float32Array(TRAIL_LEN);
      p.trailY = new Float32Array(TRAIL_LEN);
    }
    const px = p.px || 0, pz = p.pz || 0;
    p.trailX.fill(px); p.trailZ.fill(pz); p.trailY.fill(p.y || 0);
    p.trailHead = 0;
  }

  // record the owner's position and place the dog DOG_GAP units back along the
  // recent path (no per-frame allocation — writes straight into the handle).
  _updateDog(p, dt) {
    if (!p.trailX) this._trailReset(p);
    // sample only after the owner moved a little, so the trail spans a real
    // distance even at low frame times
    const hx = p.trailX[p.trailHead], hz = p.trailZ[p.trailHead];
    if (Math.abs(p.px - hx) + Math.abs(p.pz - hz) > 0.07) {
      p.trailHead = (p.trailHead + 1) % TRAIL_LEN;
    }
    p.trailX[p.trailHead] = p.px;
    p.trailZ[p.trailHead] = p.pz;
    p.trailY[p.trailHead] = p.y;

    let i = p.trailHead;
    let bx = p.trailX[i], bz = p.trailZ[i], by = p.trailY[i];
    let acc = 0;
    for (let k = 0; k < TRAIL_LEN - 1; k++) {
      const j = (i - 1 + TRAIL_LEN) % TRAIL_LEN;
      const nx = p.trailX[j], nz = p.trailZ[j];
      const seg = Math.hypot(nx - bx, nz - bz);
      if (acc + seg >= DOG_GAP) {
        const f = (DOG_GAP - acc) / (seg || 1);
        bx += (nx - bx) * f; bz += (nz - bz) * f; by = p.trailY[j];
        acc = DOG_GAP; break;
      }
      acc += seg; bx = nx; bz = nz; by = p.trailY[j]; i = j;
    }

    p.dogBob += dt * 14;                     // fast little trot
    const y = by + Math.abs(Math.sin(p.dogBob)) * 0.03;
    const ddx = p.px - bx, ddz = p.pz - bz;
    if (p.dogHandle) {
      try {
        p.dogHandle.setPos(bx, y, bz);
        if (Math.abs(ddx) + Math.abs(ddz) > 0.05) p.dogHandle.setRot(facing(ddx, ddz));
      } catch (_) {}
    }
  }

  // Standing height inside a park lot: LOT_Y plus the park model's own plinth
  // (read off the model's edge column, so it tracks the art automatically).
  _parkStandY() {
    if (this._parkY != null) return this._parkY;
    let top = 0;
    try {
      const m = this.models && typeof this.models.serviceModel === 'function'
        ? this.models.serviceModel('park', 0) : null;
      if (m && Array.isArray(m.blocks)) {
        const res = m.res || 1, mz = (m.sz >> 1);
        for (const b of m.blocks) if (b[0] === 0 && b[2] === mz && b[1] + 1 > top) top = b[1] + 1;
        top = Math.min(top / res, 1);
      }
    } catch (_) { top = 0; }
    this._parkY = PARK_BASE + top;
    return this._parkY;
  }

  _spawnParkPed(state) {
    if (this.parkTiles.length === 0) return null;
    const tile = this.parkTiles[(Math.random() * this.parkTiles.length) | 0];
    const variant = (Math.random() * PERSON_VARIANTS) | 0;
    const p = this._slot(this.peds, PED_CAP, this._pedModel(variant), variant);
    if (!p) return null;
    p.active = true;
    p.mode = 'park';
    p.speed = 0.45 + Math.random() * 0.35;
    p.cur = { x: tile.x, z: tile.z };
    p.tx = null;
    p.px = tc(tile.x) + (Math.random() - 0.5) * (TILE - 2);
    p.pz = tc(tile.z) + (Math.random() - 0.5) * (TILE - 2);
    p.yaw = Math.random() * Math.PI * 2;
    p.bob = Math.random() * Math.PI * 2;
    p.y = this._parkStandY();
    p.hasDog = false;                          // park visitors come without dogs
    if (p.dogHandle) { try { p.dogHandle.setVisible(false); } catch (_) {} }
    this._parkTarget(p);
    try { p.handle.setVisible(true); } catch (_) {}
    return p;
  }

  _parkTarget(p) {
    p.tx2 = tc(p.cur.x) + (Math.random() - 0.5) * (TILE - 2);
    p.tz2 = tc(p.cur.z) + (Math.random() - 0.5) * (TILE - 2);
  }

  // smoothly swing yaw toward targetYaw over ~TURN_TIME seconds
  _turn(a, dt) {
    const k = dt <= 0 ? 1 : Math.min(1, dt / TURN_TIME);
    a.yaw += angDelta(a.yaw, a.targetYaw) * k;
    if (a.handle) { try { a.handle.setRot(a.yaw); } catch (_) {} }
  }

  _movePed(p, dt, state) {
    if (p.mode === 'park') {
      if (!this._isTile(state, p.cur.x, p.cur.z, T.PARK)) { this._retire(p); return; }
      const dx = p.tx2 - p.px, dz = p.tz2 - p.pz;
      const d = Math.hypot(dx, dz);
      if (d < 0.2) { this._parkTarget(p); }
      else {
        const step = Math.min(d, p.speed * dt);
        p.px += (dx / d) * step;
        p.pz += (dz / d) * step;
        p.targetYaw = facing(dx / d, dz / d);
        this._turn(p, dt);
      }
      p.y = this._parkStandY();
    } else {
      const ok = this._advance(p, p.speed * dt, (x, z) => this._isRoad(state, x, z),
        (x, z) => this._neighbors(state, x, z), 0.6,
        (x, z) => (this._isBridge(state, x, z) ? PED_LANE_BRIDGE : PED_LANE)); // inside bridge rails
      if (!ok) { this._retire(p); return; }
      const ty = this._groundY(state, p.tx, p.tz, p.px, p.pz);
      p.y += (ty - p.y) * Math.min(1, dt * 12);   // step up / down the kerb
      if (p.handle) { try { p.handle.setRot(facing(p.hx, p.hz)); } catch (_) {} }
    }
    // tiny walking bob
    if (dt > 0) p.bob += dt * 11;
    const y = p.y + Math.abs(Math.sin(p.bob)) * 0.03;
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

    // fire new puffs from each catalog chimney mouth
    for (const v of this.ventSites) {
      v.timer -= dt;
      if (v.timer > 0) continue;
      v.timer = 1.4 + Math.random() * 1.0;
      const puff = this._slot(this.puffs, PUFF_CAP, () => this.models.smokePuffModel());
      if (!puff) continue;
      puff.active = true;
      puff.x = v.x + (Math.random() - 0.5) * 0.3;
      puff.y = v.y;
      puff.z = v.z + (Math.random() - 0.5) * 0.3;
      puff.vx = 0.4 + Math.random() * 0.6;
      puff.age = 0;
      puff.life = 2.2 + Math.random() * 0.8;
      try { puff.handle.setVisible(true); puff.handle.setPos(puff.x, puff.y, puff.z); } catch (_) {}
    }
    // …and a per-tile fallback for zoned factories (no vent data)
    const occ = state && state.occ;
    for (const f of this.factories) {
      if (occ && this._ventBids.size && this._ventBids.has(occ[idx(f.x, f.z)])) continue;
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
        _v: true, x: 0, z: 0,
        setPos(x, y, z) { this.x = x; this.z = z; },
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
    parkedRowModel: tiny,
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
  for (let i = lo; i <= hi; i++) map[idx(i, 10)] = T.ROAD;   // cross street: 2 junctions
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
    // a fire station on the cross street: its engines park in the kerbside bays
    { bid: 3, type: 'fire-station', cat: 'fun', x: 8, z: 11, tw: 1, td: 1, rot: 0 },
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

    // Phase 3: smooth motion — no car may jump further in one 50 ms step than
    // its top speed allows (corners, lane changes and junctions included), and
    // every car must stay within its lane band of a road tile.
    state.clock = 0.3;
    let maxJump = 0, offRoad = 0, overlaps = 0, samples = 0, pedSamples = 0, pedOff = 0;
    const last = new Map();
    for (let i = 0; i < 200; i++) {
      life.update(0.05, state, roadGraph);
      for (const c of life.cars) {
        if (!c.active) { last.delete(c); continue; }
        const h = c.handle, prev = last.get(c);
        if (prev) maxJump = Math.max(maxJump, Math.hypot(h.x - prev[0], h.z - prev[1]) / (c.vmax * 0.05));
        last.set(c, [h.x, h.z]);
        if (!isRoad(Math.floor(h.x / TILE), Math.floor(h.z / TILE))) offRoad++;
      }
      const act = life.cars.filter((c) => c.active);
      for (let m = 0; m < act.length; m++) for (let n = m + 1; n < act.length; n++) {
        samples++;
        if (Math.hypot(act[m].handle.x - act[n].handle.x, act[m].handle.z - act[n].handle.z) < 1.0) overlaps++;
      }
      // road walkers stay on the sidewalk ring of their tile (0.8 band inside
      // the tile edge) — crossing a road mouth runs along that ring too; no
      // wide arc across the middle of a junction or bend
      for (const p of life.peds) {
        if (!p.active || p.mode !== 'road') continue;
        const u = Math.abs(p.handle.x - tc(p.tx)), v = Math.abs(p.handle.z - tc(p.tz));
        pedSamples++;
        if (Math.max(u, v) < PED_LANE - 0.05) pedOff++;
      }
    }
    if (pedSamples === 0) throw new Error('no road pedestrians sampled');
    if (pedOff > 0) throw new Error(pedOff + ' pedestrian samples off the sidewalk ring');
    if (maxJump > 1.05) throw new Error('car motion not smooth (jump ' + maxJump.toFixed(2) + 'x top speed)');
    if (offRoad > 0) throw new Error(offRoad + ' car samples off the road');

    if (cars <= 0) throw new Error('no cars spawned');
    if (peds <= 0) throw new Error('no pedestrians spawned');
    if (life.birds.length !== BIRD_COUNT) throw new Error('birds missing');
    if (life.clouds.length !== CLOUD_COUNT) throw new Error('clouds missing');
    if (boats <= 0) throw new Error('no boats on the water');
    if (life._dogSpawns <= 0) throw new Error('no dogs attached to pedestrians');
    if (life._balloonSpawns <= 0) throw new Error('no balloons released');
    if (life._fireworkBursts <= 0) throw new Error('no fireworks burst');
    const parked = life.parked.filter((e) => e.active);
    if (parked.length !== 1 || parked[0].tx !== 8 || parked[0].tz !== 10) throw new Error('no fleet parked at the fire station');
    const h0 = parked[0].handle;
    if (Math.abs(h0.x - tc(8)) > 1e-6 || Math.abs(h0.z - tc(10)) > 1e-6) throw new Error('parked tile mesh not on its tile');
    for (const sl of life._parkSlots) {
      // in the bay band on the station side of road tile (8,10): kerb face at z 87.2
      if (Math.floor(sl.x / TILE) !== 8 || !(sl.z > 86.5 && sl.z < 87.66) || sl.s !== 2) throw new Error('parked car outside its bay');
    }
    // r11: fuller kerbs — no two bays on one kerb may overlap (one car per bay)
    const sl = life._parkSlots;
    for (let m = 0; m < sl.length; m++) for (let n = m + 1; n < sl.length; n++) {
      const p = sl[m], q = sl[n];
      if (p.tx !== q.tx || p.tz !== q.tz || p.s !== q.s) continue;
      const d = Math.hypot(p.x - q.x, p.z - q.z), need = (p.bays + q.bays) * BAY * 0.5 - 1e-6;
      if (d < need) throw new Error('parked bays overlap');
    }
    if (sl.length < 2) throw new Error('fire station kerb not filled');

    return {
      ok: true, cars, peds, puffs, boats,
      dogsActive: dogs, dogSpawns: life._dogSpawns,
      balloonsActive: balloons, balloonSpawns: life._balloonSpawns,
      sparksActive: sparks, bursts: life._fireworkBursts,
      parked: parked.length, birds: life.birds.length, clouds: life.clouds.length, made, maxJump: +maxJump.toFixed(3), overlaps, samples, pedSamples,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
