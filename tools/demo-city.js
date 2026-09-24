// Dev-only helper: builds a deterministic demo city so screenshots are comparable
// across renderer iterations. Paste into the page console (or run via
// javascript_tool) AFTER the game has booted (window.BV exists).
//
//   BVDEMO.build()          -> lay out the reference city
//   BVDEMO.shot('day')      -> pose the camera for the standard hero shot
//   BVDEMO.hideUI()         -> hide the HUD so only the 3D render is visible
//   BVDEMO.night(t)         -> force day/night 0..1
//
// Nothing here is shipped: this file is never imported by src/.

(function () {
  const BV = window.BV;
  if (!BV) throw new Error('BV not ready');
  const N = 80, T = { GRASS: 0, WATER: 1, SAND: 2, ROAD: 3, MOUNTAIN: 15 };

  const st = () => BV.sim.state;
  const at = (x, z) => st().map[z * N + x];
  const flat = (x, z) => at(x, z) === T.GRASS;

  // Deterministic PRNG so every run lays out the same city.
  let seed = 1337;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  // Freeze the weather dry. main.js exposes BV.weather as its live weather
  // STATE object (not a function) and re-rolls a 25% rain chance per sim day,
  // then pushes it to engine.setWeather every frame — so a plain
  // engine.setWeather({rain:0}) is overwritten a frame later and shots came
  // out randomly rainy (streaks + ripple rings on the water).
  function clearWeather() {
    const w = BV.weather;
    if (typeof w === 'function') { try { w('clear'); } catch (e) {} }
    else if (w && typeof w === 'object') {
      w.rain = w.snow = w.targetRain = w.targetSnow = 0;
      if (BV.sim && BV.sim.state) w.rolledDay = BV.sim.state.day;
    }
  }

  // --- find the largest flat grass region's centre -------------------------
  // Largest flat grass region, tie-broken TOWARD MAP CENTRE. Without the
  // centre bias, ties (many fully-flat 11x11 windows) all resolve to the first
  // scanned cell and the reference city lands in a corner.
  function findPlaza() {
    const mid = N / 2;
    let best = null;
    for (let z = 14; z < N - 14; z += 2) {
      for (let x = 14; x < N - 14; x += 2) {
        let ok = 0;
        for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) if (flat(x + dx, z + dz)) ok++;
        // Penalise distance from centre so the winner is central AND flat.
        const score = ok - Math.hypot(x - mid, z - mid) * 0.35;
        if (!best || score > best.score) best = { x, z, ok, score };
      }
    }
    return best;
  }

  const HOMES = ['small-house', 'cottage', 'big-house', 'townhouse', 'duplex', 'farmhouse', 'apartment', 'tall-apartment'];
  const SHOPS = ['bakery', 'ice-cream', 'pizza', 'cafe', 'toy-store', 'book-shop', 'grocery', 'diner', 'barber', 'flower-shop'];
  const DOWN = ['small-office', 'glass-office', 'brick-highrise', 'deco-tower', 'green-glass-tower', 'clock-tower', 'round-tower', 'hotel', 'office-block', 'shopping-office', 'glass-skyscraper', 'corporate-hq', 'city-bank', 'twin-setback'];
  const FUN = ['park', 'school', 'fire-station', 'fountain', 'playground'];

  // Force a FIXED world seed. Without this every reload generates a different
  // coastline/mountain layout, and before/after screenshots aren't comparable.
  const REF_SEED = 20240601;
  function reseed(seedVal) {
    const blob = JSON.stringify({
      v: 2, n: N, seed: (seedVal || REF_SEED) >>> 0, day: 1, clock: 0.3,
      roads: [], trees: [], buildings: [],
    });
    if (!BV.sim.load(blob)) throw new Error('reseed failed');
    if (BV.engine.clearWorld) BV.engine.clearWorld();
    BV.engine.buildGround(BV.sim.state);
    // Re-place the ambient trees the generator wrote into the map.
    const s = st();
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (s.map[z * N + x] === 8 /* TREE */) {
          BV.engine.addProp('tree', BV.models.treeModel((x * 7 + z * 13) % 4), x, z);
        }
      }
    }
    seed = 1337;   // reset the layout PRNG too
    return s.seed;
  }

  function build() {
    // life.js seeds cars/pedestrians/props from Math.random, so two loads of
    // the "same" reference city differed by ~25 draw calls and ~5k triangles —
    // which silently distorted every A/B measurement taken across page loads.
    // Pin Math.random for the whole construction, then restore it.
    const realRandom = Math.random;
    let rs = 0x9e3779b9;
    Math.random = () => {
      rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
      return rs / 4294967296;
    };
    try {
      return buildInner();
    } finally {
      Math.random = realRandom;
    }
  }

  function buildInner() {
    reseed(REF_SEED);
    const p = findPlaza();
    const cx = p.x, cz = p.z;
    const road = (x, z) => { try { BV.paint('road', x, z); } catch (e) {} };
    const put = (id, x, z) => { try { BV.paint(id, x, z); } catch (e) {} };

    // Road grid: avenues every 4 tiles over a 25x25 block.
    const R = 12;
    for (let o = -R; o <= R; o++) {
      for (let k = -R; k <= R; k += 4) {
        road(cx + o, cz + k);
        road(cx + k, cz + o);
      }
    }

    // Fill the blocks between roads. Downtown near the centre, homes further out.
    for (let bz = -R; bz < R; bz += 4) {
      for (let bx = -R; bx < R; bx += 4) {
        for (let dz = 1; dz < 4; dz++) {
          for (let dx = 1; dx < 4; dx++) {
            const x = cx + bx + dx, z = cz + bz + dz;
            if (!flat(x, z)) continue;
            const d = Math.max(Math.abs(bx), Math.abs(bz));
            let id;
            if (d <= 4) id = pick(DOWN);
            else if (d <= 8) id = rnd() < 0.6 ? pick(SHOPS) : pick(HOMES);
            else id = rnd() < 0.85 ? pick(HOMES) : pick(FUN);
            put(id, x, z);
          }
        }
      }
    }
    outerRing(cx, cz, R, road, put);
    BV.ff(40);
    window.__bvPlaza = { cx, cz };
    return { cx, cz };
  }

  // Outer ring (ground r6). The blind critic: "the top 40% of the frame outside
  // downtown is a large, flat, empty grass field … in ref05 the ground is tiled
  // edge to edge with separate plinths, one per block … black asphalt runs
  // between them". So the avenue grid carries on RO tiles out, and the new
  // blocks are mostly LEFT EMPTY on purpose: terrain.js dresses every empty
  // road-enclosed block as one raised lot (car park, market, town park,
  // sports, allotments …), which is cheap geometry, and a few blocks get a
  // house / farm / park so it still reads as a lived-in suburb. Runs AFTER the
  // inner city with its own PRNG, so the inner layout is byte-for-byte the same.
  //
  // Ground r12. The r11 critic: "the ground is almost all road grid and rimmed
  // lots, with no open terrain … every block is the same diamond size … leave
  // some unbuilt grass tiles (no plinths) between districts … vary lot and
  // block sizes". So the outer ring is no longer a full grid:
  //   * each outer block gets a fate first. The inner ring of blocks (next to
  //     downtown) is mostly built; the outermost ring is mostly FIELD, with a
  //     few built blocks standing in the grass like islands (ref05's edges);
  //   * an avenue SEGMENT is laid only where it borders a built block, so
  //     field blocks carry no road at all and run together (and out into the
  //     countryside) as wide open grass — every laid segment still closes a
  //     loop, so there are no dead-end stubs;
  //   * about half of neighbouring built pairs drop the segment between
  //     them and become one 7x3 block, so blocks and lots vary in size.
  function outerRing(cx, cz, R, road, put) {
    const RO = 24;   // r14: one more ring (was 20) so the town edge frames lots, not open lawn
    let s2 = 4242;
    const r2 = () => (s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296;
    const okRoad = (x, z) => x > 1 && z > 1 && x < N - 2 && z < N - 2 &&
      (at(x, z) === T.GRASS || at(x, z) === T.ROAD);
    const isInner = (bx, bz) => bx >= -R && bx < R && bz >= -R && bz < R;
    const key = (bx, bz) => bx + ',' + bz;
    const fate = new Map();
    for (let bz = -RO; bz < RO; bz += 4) {
      for (let bx = -RO; bx < RO; bx += 4) {
        if (isInner(bx, bz)) { fate.set(key(bx, bz), 'city'); continue; }
        const ring = Math.max(Math.abs(bx + 2), Math.abs(bz + 2));   // 14 / 18 / 22
        const outer = ring > R + 2;
        const f = r2();
        let v;
        // r14 (critic r13: "the whole upper-left half of iso-park is one huge,
        // flat, empty lawn … in ref05 grass only shows as narrow margins
        // between tightly packed plinth lots"): one more ring of blocks; the
        // ring next to downtown is fully built, the next 18% field and the
        // outermost 50% (was 16% / 72% over two rings), so fields only open
        // up at the town's edge, as in ref05's corners.
        if (f < (ring > R + 6 ? 0.50 : outer ? 0.18 : 0.0)) v = 'field';
        else {
          const g = r2();
          v = g < 0.42 ? 'lot' : g < 0.74 ? 'homes' : g < 0.88 ? 'civic' : 'farm';
        }
        fate.set(key(bx, bz), v);
      }
    }
    const built = (bx, bz) => { const v = fate.get(key(bx, bz)); return !!v && v !== 'field'; };
    // Merge some neighbouring outer built blocks (never two merges on one block).
    const merged = new Set(), skip = new Set();
    for (let bz = -RO; bz < RO; bz += 4) {
      for (let bx = -RO; bx < RO; bx += 4) {
        const v = fate.get(key(bx, bz));
        if (!built(bx, bz) || v === 'city' || merged.has(key(bx, bz))) continue;
        const h = r2();
        if (h > 0.55) continue;
        const opts = [[bx + 4, bz, 'v' + (bx + 4) + ',' + bz], [bx, bz + 4, 'h' + (bz + 4) + ',' + bx]];
        if (h < 0.27) opts.reverse();
        for (const [nx, nz, seg] of opts) {
          const nv = fate.get(key(nx, nz));
          if (!nv || nv === 'city' || nv === 'field' || merged.has(key(nx, nz))) continue;
          merged.add(key(bx, bz)); merged.add(key(nx, nz)); skip.add(seg);
          break;
        }
      }
    }
    // Segments: 'v<k>,<z0>' runs along x = k from z0 to z0+4 (blocks k-4 | k);
    // 'h<k>,<x0>' runs along z = k from x0 to x0+4 (blocks above | below).
    for (let k = -RO; k <= RO; k += 4) {
      for (let o0 = -RO; o0 < RO; o0 += 4) {
        const innerSeg = Math.abs(k) <= R && o0 >= -R && o0 + 4 <= R;   // inner grid: already laid
        if (innerSeg) continue;
        if (!skip.has('v' + k + ',' + o0) && (built(k - 4, o0) || built(k, o0))) {
          for (let o = o0; o <= o0 + 4; o++) if (okRoad(cx + k, cz + o)) road(cx + k, cz + o);
        }
        if (!skip.has('h' + k + ',' + o0) && (built(o0, k - 4) || built(o0, k))) {
          for (let o = o0; o <= o0 + 4; o++) if (okRoad(cx + o, cz + k)) road(cx + o, cz + k);
        }
      }
    }
    const HOMES_OUT = ['small-house', 'cottage', 'big-house', 'townhouse', 'duplex'];
    const CORNERS = [[1, 1], [3, 1], [1, 3], [3, 3]];
    for (let bz = -RO; bz < RO; bz += 4) {
      for (let bx = -RO; bx < RO; bx += 4) {
        const v = fate.get(key(bx, bz));
        const c = CORNERS[Math.floor(r2() * 4)];
        const at1 = (dx, dz, id) => { const x = cx + bx + dx, z = cz + bz + dz; if (flat(x, z)) put(id, x, z); };
        if (v === 'homes') {                                      // a couple of houses on one corner
          at1(c[0], c[1], pick2(HOMES_OUT));
          at1(2, c[1], pick2(HOMES_OUT));
        } else if (v === 'civic') {
          at1(2, 2, pick2(['park', 'playground', 'school']));
        } else if (v === 'farm') {
          at1(c[0], c[1], 'farmhouse');
        }
        // 'lot': left empty, terrain dresses it; 'field': open grass.
      }
    }
    function pick2(arr) { return arr[Math.floor(r2() * arr.length)]; }
  }

  function hideUI(on = true) {
    const el = document.getElementById('bv-ui');
    if (el) el.style.display = on ? 'none' : '';
    document.querySelectorAll('.bv-overlay').forEach((o) => { o.style.display = on ? 'none' : ''; });
  }

  function cam(opts) {
    const e = BV.engine;
    if (opts.dist != null) { e._camDist = opts.dist; e._sDist = opts.dist; }
    if (opts.az != null) { e._camAz = opts.az; e._sAz = opts.az; }
    if (opts.polar != null) { e._camPolar = opts.polar; e._sPolar = opts.polar; }
    if (opts.x != null) {
      const y = opts.y || 0;
      e._camTarget.set(opts.x, y, opts.z); e._sTarget.set(opts.x, y, opts.z);
    }
    e._applyCamera();
    e.render(0.016);
  }

  // main.js recomputes engine.setNight(nightFactor(sim.state.clock)) EVERY
  // frame, so calling engine.setNight() directly is clobbered within one frame
  // — a 'night' shot screenshotted 200ms later came back fully daylit. Drive
  // the sim clock instead, which is the actual source of truth.
  //   nightFactor(clock) = smoothstep01((cos(clock*2pi)*0.5+0.5 - 0.35)/0.4)
  function clockForNight(target) {
    // Invert the smoothstep numerically (monotonic on [0,1]), then the cosine.
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const t = (lo + hi) / 2;
      (t * t * (3 - 2 * t) < target) ? (lo = t) : (hi = t);
    }
    const c = 0.35 + 0.4 * ((lo + hi) / 2);
    // Take the descending branch (afternoon -> night) so shots read naturally.
    return Math.acos(Math.max(-1, Math.min(1, 2 * c - 1))) / (Math.PI * 2);
  }

  function night(t) {
    if (BV.sim && BV.sim.state) BV.sim.state.clock = clockForNight(t);
    BV.engine.setNight(t);
    BV.engine.render(0.016);
  }

  // The stretch of shore CLOSEST to the city, so the waterfront shot has both
  // water AND skyline in it. Targeting the raw water centroid put the camera in
  // open sea: measured 0.077% of that frame contained anything man-made.
  // Centroid of the largest water body, for framing the waterfront shot.
  function waterCentroid() {
    const s = st();
    let sx = 0, sz = 0, n = 0;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) if (s.map[z * N + x] === 1 /* WATER */) { sx += x; sz += z; n++; }
    }
    return n ? { cx: Math.round(sx / n), cz: Math.round(sz / n), n } : null;
  }

  function shoreNearCity(plaza) {
    const p = plaza || window.__bvPlaza || findPlaza();
    const w = waterCentroid();
    if (!w) return null;
    // Stand BEYOND the water looking back across it at downtown, so the frame
    // reads water-foreground / city-background. Aiming at the nearest shore
    // tile instead put the camera over open grass on a narrow lake.
    return { cx: w.cx, cz: w.cz, az: Math.atan2(w.cx - p.cx, w.cz - p.cz) };
  }

  // --- isometric framing helpers --------------------------------------------
  // The game camera is a true-isometric OrthographicCamera (engine.js ISO_*):
  // polar acos(1/sqrt3), azimuth pi/4 + k*pi/2. `dist` is the camDist-equivalent
  // zoom: ortho half-height = dist * tan(20 deg).
  const ISO_POLAR = Math.acos(1 / Math.sqrt(3));
  const ISO_TAN_HALF = Math.tan(20 * Math.PI / 180);
  const isoAz = (k) => Math.PI * 0.25 + k * Math.PI * 0.5;
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // The 90-degree snap that puts the sun `pref` radians round from the camera
  // (0 = sun directly behind the lens = flat frontal light). Deterministic:
  // shots pin the clock first, so sunDir is fixed.
  function isoSnapForSun(pref) {
    const sd = BV.engine._ctx.sunDir;
    const sunAz = Math.atan2(sd.x, sd.z);
    let best = 0, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(wrapPi(isoAz(k) - (sunAz + pref)));
      if (d < bd) { bd = d; best = k; }
    }
    return isoAz(best);
  }

  // Nearest WATER tile to the plaza (the shore closest to downtown).
  function nearestWater(p) {
    const s = st();
    let best = null;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (s.map[z * N + x] !== 1) continue;
        const d = Math.hypot(x - p.cx, z - p.cz);
        if (!best || d < best.d) best = { cx: x, cz: z, d };
      }
    }
    return best;
  }

  // Greenest neighbourhood: trees + parks/playgrounds/fountains, preferring
  // spots that still have a little town in view. Deterministic scan.
  function greenSpot(p) {
    const s = st();
    const GREEN = { park: 6, playground: 4, fountain: 4 };
    const parkAt = new Map();
    for (const b of s.buildings) {
      const w = GREEN[b.type];
      if (w) parkAt.set(b.z * N + b.x, w);
    }
    let best = null;
    for (let z = 8; z < N - 8; z += 2) {
      for (let x = 8; x < N - 8; x += 2) {
        let score = 0, town = 0;
        for (let dz = -6; dz <= 6; dz++) {
          for (let dx = -6; dx <= 6; dx++) {
            const i = (z + dz) * N + (x + dx);
            const t = s.map[i];
            if (t === 8) score += 1;
            else if (t === 3) town++;
            score += parkAt.get(i) || 0;
          }
        }
        if (town < 6) continue;                          // keep some town in frame
        score -= Math.hypot(x - p.cx, z - p.cz) * 0.4;   // and near the city
        if (!best || score > best.score) best = { cx: x, cz: z, score };
      }
    }
    return best || { cx: p.cx, cz: p.cz };
  }

  // One attractive building for the close-up, like ref04: a shop or house in
  // the low-rise ring, seen from the snap that shows its FRONT with nothing
  // tall between it and the lens. Deterministic (fixed scan order + ties).
  function heroBuilding(p) {
    const s = st();
    const E = BV.engine;
    const PREF = ['bakery', 'cafe', 'ice-cream', 'toy-store', 'book-shop', 'pizza', 'flower-shop',
      'diner', 'grocery', 'townhouse', 'big-house', 'cottage', 'small-house', 'duplex'];
    const hOf = (b) => {
      const m = E._buildings && E._buildings.get(b.bid);
      if (!m || !m.geometry) return 12;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      return m.geometry.boundingBox.max.y - Math.min(0, m.geometry.boundingBox.min.y);
    };
    const hAt = new Map();
    for (const b of s.buildings) {
      const h = hOf(b);
      for (let dz = 0; dz < b.td; dz++) for (let dx = 0; dx < b.tw; dx++) hAt.set((b.z + dz) * N + b.x + dx, h);
    }
    let best = null;
    for (const b of s.buildings) {
      const pr = PREF.indexOf(b.type);
      if (pr < 0) continue;
      const h = hOf(b);
      const front = (b.rot || 0) * Math.PI * 0.5;
      for (const az of [front + Math.PI * 0.25, front - Math.PI * 0.25]) {
        // Tiles on the camera side (within 3 tiles): anything taller than the
        // hero there hides it.
        const cx = Math.sin(az), cz = Math.cos(az);
        let occ = 0;
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (dx * cx + dz * cz <= 0.5) continue;
            const hh = hAt.get((b.z + dz) * N + b.x + dx) || 0;
            occ = Math.max(occ, hh - h * 0.6);
          }
        }
        const score = occ * 4 + pr * 1.5 + Math.hypot(b.x - p.cx, b.z - p.cz) * 0.15;
        if (!best || score < best.score) best = { b, h, az, score };
      }
    }
    if (!best) return null;
    const b = best.b;
    return { cx: b.x + (b.tw - 1) / 2, cz: b.z + (b.td - 1) / 2, tw: b.tw, td: b.td, h: best.h,
      type: b.type, rot: b.rot || 0, az: best.az };
  }

  // --- standard shots ------------------------------------------------------
  // Every visual review uses these exact framings so before/after and
  // side-by-side comparisons are honest. `plaza` is the {cx,cz} from build().
  const SHOTS = {
    // Signature Cities:Skylines hero: mid-orbit, low-ish sun, downtown filling frame.
    hero:      { dist: 150, polar: 1.17, az: Math.PI * 0.25, night: 0.0, sunOffset: 2.0 },
    // Street level — where materials, road markings and AO have nowhere to hide.
    // (offset off the plaza so we look DOWN a street, not into a tower wall)
    street:    { dist: 52,  polar: 1.30, az: Math.PI * 0.62, night: 0.33, ox: 8, oz: 8, sunOffset: 2.1, focusK: 0.80 },
    // Full-region: terrain, water, atmosphere, aliasing at distance.
    region:    { dist: 340, polar: 1.16, az: Math.PI * 0.25, night: 0.0, sunOffset: 2.2, rangeK: 0.42 },
    // Golden hour — the shot that sells atmosphere. night 0.45 puts the sun at
    // only ~8 degrees, which drops the whole ground plane into shadow and reads
    // as dusk; ~0.38 gives a ~20 degree sun, where the long raking shadows are.
    golden:    { dist: 170, polar: 1.30, az: Math.PI * 0.95, night: 0.375, sunOffset: 1.85 },
    // Night — emissive windows, neon, bloom, street lighting.
    night:     { dist: 150, polar: 1.24, az: Math.PI * 0.25, night: 0.92 },
    // Waterfront — water shader, shoreline foam, reflections. Targets the
    // WATER CENTROID, not the plaza: the old preset framed only downtown and
    // grass, so nobody following the protocol ever reviewed the water at all.
    // polar 1.28 also brings the horizon and sky into frame.
    waterfront:{ dist: 105, polar: 1.24, az: 0, night: 0.0, onShore: true },

    // ---- True-isometric review shots (the game's real camera) --------------
    // Target look: Pablo Gamedev "Isometric City Voxel". `dist` is the
    // camDist-equivalent ortho zoom; az is always one of the four iso snaps,
    // chosen so the sun sits `sunPref` rad round from the lens.
    // Overview like ref05: ~5-7 blocks across, downtown + houses + a park.
    iso:        { iso: 'plaza', dist: 190, towardPark: 0.4, night: 0.0, sunPref: 0.8 },
    // Same view at ref05's scale (~120 px per tile at 1600x900): the main A/B shot.
    'iso-mid':  { iso: 'plaza', dist: 85, towardPark: 0.4, night: 0.0, sunPref: 0.8 },
    // One building + its lot filling ~60% of the frame, like ref04.
    'iso-close':{ iso: 'building', fill: 0.68, night: 0.0, sunPref: 0.8 },
    // Whole map + countryside/water at the widest zoom the game allows.
    'iso-wide': { iso: 'map', night: 0.0, sunPref: 0.8 },
    // Same framing as `iso`, at night.
    'iso-night':{ iso: 'plaza', dist: 190, towardPark: 0.4, night: 0.92, sunPref: 0.8 },
    // Shore nearest downtown: water, shoreline, and the edge of town.
    'iso-water':{ iso: 'water', dist: 190, night: 0.0, sunPref: 0.8 },
    // Greenest neighbourhood: trees, parks, grass, rocks.
    'iso-park': { iso: 'green', dist: 165, night: 0.0, sunPref: 0.8 },
  };

  // Resolve an iso shot's target (world), zoom and azimuth. Deterministic.
  function isoFrame(s, p) {
    const T = 8;
    let x = (p.cx + 0.5) * T, z = (p.cz + 0.5) * T, y = 0;
    let dist = s.dist || 215;
    let az = isoSnapForSun(s.sunPref || 0);
    if (s.iso === 'plaza' && s.towardPark) {
      // Nudge the overview toward the nearest park so ref05's mix of
      // downtown + houses + greenery all share the frame.
      let best = null;
      for (const b of st().buildings) {
        if (b.type !== 'park' && b.type !== 'playground') continue;
        const d = Math.hypot(b.x - p.cx, b.z - p.cz);
        if (!best || d < best.d) best = { b, d };
      }
      if (best) {
        x += (best.b.x - p.cx) * T * s.towardPark;
        z += (best.b.z - p.cz) * T * s.towardPark;
      }
    }
    if (s.iso === 'building') {
      const hb = heroBuilding(p);
      if (hb) {
        x = (hb.cx + 0.5) * T; z = (hb.cz + 0.5) * T;
        // Iso screen height of a w x d x h box: (w+d)*sin(35.26)/sqrt2 + h*cos(35.26).
        const scrH = (hb.tw + hb.td) * T * 0.408 + hb.h * 0.816;
        y = hb.h * 0.42;                     // centre the building, not its footprint
        dist = Math.max(36, (scrH / (2 * (s.fill || 0.6))) / ISO_TAN_HALF);
        az = hb.az;                          // the snap that sees its front, unobstructed
      }
    } else if (s.iso === 'map') {
      x = 320; z = 320;
      dist = BV.engine.getView ? BV.engine.getView().zoomMax : 900;
    } else if (s.iso === 'water') {
      const w = nearestWater(p);
      if (w) {
        // Aim a little inland of the nearest shore so water AND town share the frame.
        x = (w.cx + (p.cx - w.cx) * 0.3 + 0.5) * T;
        z = (w.cz + (p.cz - w.cz) * 0.3 + 0.5) * T;
      }
    } else if (s.iso === 'green') {
      const g = greenSpot(p);
      x = (g.cx + 0.5) * T; z = (g.cz + 0.5) * T;
    }
    return { x, y, z, dist, az, polar: ISO_POLAR };
  }

  // ---- Category galleries for building artists/critics -----------------
  // Shot names 'gal-<cat>-<page>' (cat = CATALOG key: homes, shops, factories,
  // fun, deco, downtown; page from 1). Rebuilds the world as a clean showroom:
  // up to 6 buildings per page in 2 rows of 3, each facing a road, on flat
  // grass, daytime, framed iso. Clears __bvPlaza so a later BVBOOT rebuilds
  // the normal demo city.
  const GAL_PER_PAGE = 6;
  function galleryIds(cat, page) {
    const list = (BV.models.CATALOG[cat] || []);
    if (!list.length) throw new Error('unknown gallery category: ' + cat + ' (have: ' + Object.keys(BV.models.CATALOG).join(', ') + ')');
    return list.slice((page - 1) * GAL_PER_PAGE, page * GAL_PER_PAGE);
  }
  function gallery(name) {
    let entries;
    const one = /^one-([a-z0-9-]+)$/.exec(name);
    if (one) {
      for (const k in BV.models.CATALOG) for (const e of BV.models.CATALOG[k]) if (e.id === one[1]) entries = [e];
      if (!entries) throw new Error('unknown catalog id: ' + one[1]);
    } else {
      const m = /^gal-([a-z]+)-(\d+)$/.exec(name);
      if (!m) throw new Error('gallery shot names look like gal-homes-1 or one-bakery');
      entries = galleryIds(m[1], +m[2]);
    }
    if (!entries.length) throw new Error('gallery page empty: ' + name);
    reseed(REF_SEED);
    const p = findPlaza();
    const s = st();
    // Layout: 2 rows of 3; row r has a road along its front (lower z). Each
    // row is packed by the entries' real footprints (a city block, like the
    // reference) instead of max-size cells, which left small attractions as
    // islands in wide empty grass (civic critic r4). Uniform pages (all 1×1)
    // lay out exactly as before.
    const rows = [entries.slice(0, 3), entries.slice(3, 6)];
    const rowDs = rows.map((r) => (r.length ? Math.max(...r.map((e) => e.td)) + 1 : 0));
    if (!rowDs[1]) rowDs[1] = rowDs[0];
    // Each building gets its own road-framed block, like every landmark in ref05
    // (coordinator 16:30: packed rows read as a 'jumbled pile' to civic r5).
    // Landmark categories get a road-framed block each (ref05's civic/industry);
    // homes/shops/deco pack shoulder to shoulder along the street like ref05's
    // residential and retail rows (coordinator 17:50, res r5 vs civic r5).
    const catM = /^gal-([a-z]+)-/.exec(name);
    // (industry r7) factories pack shoulder to shoulder too: ref05's industrial
    // district is one continuous run of plant lots; one road-framed island per
    // 1×1 works read as 'white toy boxes spaced far apart' (industry critic r6).
    const framed = !one && !(catM && ['homes', 'shops', 'deco', 'factories'].includes(catM[1]));
    // (res r6) Homes build ONE residential block: the two rows stand back to
    // back (row 0 fronts the top street, row 1 the bottom one) with shared back
    // gardens and no street between them, framed tightly by roads, like ref05's
    // packed blocks. The old layout gave each row its own street on both sides,
    // so ~60% of the frame was asphalt (res critic r5: 'sparse, toy-like').
    const block = !one && !!catM && catM[1] === 'homes';
    const rowW = rows.map((r) => r.reduce((s, e) => s + e.tw + (framed ? 1 : 0), 0));
    const W = Math.max(...rowW) + (block ? 0 : 1);
    const rowZ = block ? [0, rowDs[0] - 1, rowDs[0] + rowDs[1] - 1] : [0, rowDs[0], rowDs[0] + rowDs[1]];
    const D = rowZ[2] + 1;
    const x0 = p.x - Math.floor(W / 2), z0 = p.z - Math.floor(D / 2);
    // Flatten a margin around the showroom to plain grass (no trees/water).
    for (let z = z0 - 3; z < z0 + D + 3; z++) for (let x = x0 - 3; x < x0 + W + 3; x++) {
      if (x < 0 || z < 0 || x >= N || z >= N) continue;
      const i = z * N + x;
      if (s.map[i] === 8) BV.engine.removeProp && BV.engine.removeProp('tree', x, z);
      s.map[i] = T.GRASS; if (s.variant) s.variant[i] = 0; if (s.bridge) s.bridge[i] = 0;
    }
    BV.engine.buildGround(s);
    const road = (x, z) => { try { BV.paint('road', x, z); } catch (e) {} };
    // A one-<id> shot gets just its front street: the closed showroom grid
    // made road-enclosed empty blocks, which terrain dresses as car parks /
    // farm plots, and critics read those as part of the building's own lot.
    for (let r = one ? 1 : 0; r < 2; r++) {        // (buildings front +Z: row 0 faces the r = 1 street)
      if (block && r === 1) continue;              // back-to-back rows: no middle street
      const rz = z0 + rowZ[r];
      for (let x = x0 - 2; x < x0 + W + 2; x++) road(x, rz);
    }
    if (!one) {
      for (let x = x0 - 2; x < x0 + W + 2; x++) road(x, z0 + rowZ[2]);
      for (let z = z0; z <= z0 + rowZ[2]; z++) { road(block ? x0 : x0 - 2, z); road(x0 + W + 1, z); }
    }
    // (civic r6) In a mixed row, the small lots go at the end of the row AWAY
    // from the lens: a 1×1 wind turbine painted in front of the 4×4 stadium
    // cut its pole straight through the stadium's facade (civic critic r5).
    // The gallery snap follows the sun, which follows the current camera, so
    // the lens side is already known here: camera = target + (sin az, cos az).
    const sdL = BV.engine._ctx.sunDir;
    const snapL = Math.PI / 4 + Math.round((Math.atan2(sdL.x, sdL.z) + 0.8 - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2);
    const lensX = Math.sin(snapL);
    rows.forEach((row0, r) => {
      const mixed = row0.some((e) => e.tw * e.td !== row0[0].tw * row0[0].td);
      const row = mixed ? row0.slice().sort((a, b) => (a.tw * a.td - b.tw * b.td) * (lensX > 0 ? 1 : -1)) : row0;
      let x = x0 + 1;
      for (const e of row) {
        const pz = block && r === 1 ? z0 + rowZ[2] - e.td : z0 + rowZ[r] + 1;
        try { BV.paint(e.id, x, pz); } catch (err) {}
        x += e.tw;
        if (framed) { for (let z = z0 + rowZ[r]; z <= z0 + rowZ[r + 1]; z++) road(x, z); x += 1; }
      }
    });
    // (industry r11) A factories page is ONE industrial district: the tiles its
    // mixed footprints leave empty (behind the 1×1 works in a 3-deep mega row,
    // the row ends) used to become terrain truck-depot / car-park infill, which
    // critics r9-r10 read as the factories' own "big empty pale aprons". Fill
    // them with more of the category's 1×1 works (the ones not on this page
    // first), edge to edge like ref05's factory district.
    if (!one && catM && catM[1] === 'factories') {
      const pool = (BV.models.CATALOG.factories || []).filter((e) => e.tw === 1 && e.td === 1);
      const onPage = new Set(entries.map((e) => e.id));
      const order = pool.filter((e) => !onPage.has(e.id)).concat(pool.filter((e) => onPage.has(e.id)));
      let k = 0;
      for (let z = z0 + 1; z < z0 + rowZ[2]; z++) for (let x = x0 - 1; x <= x0 + W; x++) {
        const i = z * N + x;
        if (!order.length || s.map[i] !== T.GRASS || (s.occ && s.occ[i])) continue;
        try { BV.paint(order[k % order.length].id, x, z); } catch (err) {}
        k++;
      }
    }
    BV.ff(40);
    if (BV.sim && BV.sim.state) { BV.sim.state.speed = 0; BV.sim.state.clock = 0.5; }
    clearWeather();
    BV.engine.setWeather({ rain: 0, snow: 0, tint: [1, 1, 1] });
    night(0);
    const sd = BV.engine._ctx.sunDir;
    // Iso snap that puts the sun ~0.8 rad round from the lens, like the iso shots.
    const want = Math.atan2(sd.x, sd.z) + 0.8;
    const snap = Math.PI / 4 + Math.round((want - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2);
    let cx = (x0 + (block ? 1 : 0) + W / 2) * 8, cz = (z0 + D / 2) * 8;
    if (one) { cx = (x0 + 1 + entries[0].tw / 2) * 8; cz = (z0 + 1 + entries[0].td / 2) * 8; }
    const tall = Math.max(...entries.map((e) => (e.cap || 6))) ;
    let dist = Math.max(W, D) * 8 * 0.95 + Math.min(tall, 40) * 0.8;
    if (one) {
      // Frame the single building like ref04: model box fills ~65% of height.
      const e = entries[0];
      const b = st().buildings.find((q) => q.type === e.id);
      const h = b && BV.engine._buildings && BV.engine._buildings.get ? 0 : 0;
      const scrH = (e.tw + e.td) * 8 * 0.408 + Math.min(e.cap || 6, 48) * 0.816 * 0.8;
      dist = Math.max(22, scrH / 0.65 / 2 / Math.tan(20 * Math.PI / 180));
    }
    // Downtown towers are far taller than their `cap` (storeys), so frame the
    // REAL model height there, or every crown is cropped off (critic note).
    let camY = 4;
    if (entries.every((e) => (BV.models.CATALOG.downtown || []).includes(e))) {
      let realH = 0;
      for (const e of entries) { try { const m = BV.models.catalogModel(e.id, 0); realH = Math.max(realH, m.sy / (m.res || 1)); } catch (err) {} }
      const foot = one ? (entries[0].tw + entries[0].td) * 8 * 0.408 : (W + D) * 8 * 0.408;
      const need = (foot + realH * 0.816) / (one ? 0.85 : 1.35) / 2 / Math.tan(20 * Math.PI / 180);
      dist = Math.max(dist, need);
      camY = realH * (one ? 0.5 : 0.34);
    }
    if (BV.engine._post) BV.engine._post.setParams({ dof: { autoFocus: false, focus: dist, range: dist * 2 } });
    cam({ x: cx, y: camY, z: cz, dist, az: snap, polar: ISO_POLAR });
    for (let i = 0; i < 12; i++) BV.engine.render(0.016);
    hideUI(true);
    window.__bvPlaza = null;
    window.__bvGallery = { name, ids: entries.map((e) => e.id) };
    return name;
  }

  function shot(name, plaza) {
    const s = SHOTS[name];
    if (/^(gal|one)-/.test(name)) return gallery(name);
    if (!s) throw new Error('unknown shot: ' + name + ' (have: ' + Object.keys(SHOTS).join(', ') + ')');
    let p = plaza || window.__bvPlaza || findPlaza();
    let azOverride = null;
    if (s.onShore) { const w = shoreNearCity(p); if (w) { p = w; azOverride = w.az; } }
    hideUI(true);
    if (s.iso) return isoShot(name, s, p);
    // Depth of field defaults to autoFocus, which resolves from whatever the
    // depth buffer happened to hold on the settling frames — three consecutive
    // calls to the same shot produced three different DOF states. Pin it.
    if (BV.engine._post) {
      BV.engine._post.setParams({
        dof: { autoFocus: false, focus: s.dist * (s.focusK || 0.95), range: s.dist * (s.rangeK || 2.0) },
      });
    }
    // Freeze the world clock and the weather. Without this the sim keeps
    // advancing between captures, so two shots of the "same" framing differ in
    // time of day and rain — which makes before/after comparison worthless.
    if (BV.sim && BV.sim.state) { BV.sim.state.speed = 0; BV.sim.state.clock = 0.5; }
    clearWeather();
    BV.engine.setWeather({ rain: 0, snow: 0, tint: [1, 1, 1] });
    // Set the time of day FIRST so the sun direction is settled, then derive
    // the camera azimuth from it.
    night(s.night);
    let az = azOverride != null ? azOverride : s.az;
    if (azOverride == null && s.sunOffset != null) {
      // Absolute azimuths put the camera on the SAME side as the sun in the
      // street and golden shots — pure frontal light, so every cast shadow hid
      // behind its own caster (measured: only 3.9% of pixels shadow-affected).
      // Place the camera at an angle to the sun instead, so it rakes the lens.
      const sd = BV.engine._ctx.sunDir;
      az = Math.atan2(sd.x, sd.z) + s.sunOffset;
    }
    cam({
      x: (p.cx + 0.5 + (s.ox || 0)) * 8,
      z: (p.cz + 0.5 + (s.oz || 0)) * 8,
      dist: s.dist, polar: s.polar, az,
    });
    // Settle the damped camera + any shader time so the frame is stable.
    for (let i = 0; i < 12; i++) BV.engine.render(0.016);
    return name;
  }

  function isoShot(name, s, p) {
    if (BV.sim && BV.sim.state) { BV.sim.state.speed = 0; BV.sim.state.clock = 0.5; }
    clearWeather();
    BV.engine.setWeather({ rain: 0, snow: 0, tint: [1, 1, 1] });
    night(s.night);
    const f = isoFrame(s, p);
    // Pin DOF to the target's view depth (the ortho camera sits exactly `dist`
    // from the target along the view axis).
    if (BV.engine._post) {
      BV.engine._post.setParams({
        dof: { autoFocus: false, focus: f.dist * (s.focusK || 1.0), range: f.dist * (s.rangeK || 2.0) },
      });
    }
    cam(f);
    for (let i = 0; i < 12; i++) BV.engine.render(0.016);
    window.__bvLastIso = f;
    return name;
  }

  window.BVDEMO = { build, hideUI, cam, night, findPlaza, shot, SHOTS, isoFrame, heroBuilding, greenSpot, nearestWater, reseed, REF_SEED, waterCentroid, shoreNearCity, clockForNight };
  return 'BVDEMO ready';
})();
