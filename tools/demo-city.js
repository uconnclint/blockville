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
  const DOWN = ['office-block', 'skyscraper', 'glass-tower', 'clock-tower'];
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
    BV.ff(40);
    window.__bvPlaza = { cx, cz };
    return { cx, cz };
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
    if (opts.x != null) { e._camTarget.set(opts.x, 0, opts.z); e._sTarget.set(opts.x, 0, opts.z); }
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
  };

  function shot(name, plaza) {
    const s = SHOTS[name];
    if (!s) throw new Error('unknown shot: ' + name + ' (have: ' + Object.keys(SHOTS).join(', ') + ')');
    let p = plaza || window.__bvPlaza || findPlaza();
    let azOverride = null;
    if (s.onShore) { const w = shoreNearCity(p); if (w) { p = w; azOverride = w.az; } }
    hideUI(true);
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
    if (BV.weather) { try { BV.weather('clear'); } catch (e) {} }
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

  window.BVDEMO = { build, hideUI, cam, night, findPlaza, shot, SHOTS, reseed, REF_SEED, waterCentroid, shoreNearCity, clockForNight };
  return 'BVDEMO ready';
})();
