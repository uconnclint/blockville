// Dev-only measurement harness for the terrain grass review.
// Paste/eval into the game page after BVBOOT(). Never imported by src/.
//
//   BVGRASS.pose('hero')        -> pose the camera over open meadow
//   BVGRASS.measure()           -> {mean, sigma, sigmaPct, sat, hue, bg}
//   BVGRASS.report()            -> measures every standard pose
//
// Sampling: reads the composited canvas backing pixels (post-process included),
// which is exactly what the art director measured.
//
// REPRODUCIBILITY — read this before quoting a number.
// Measure from a FRESH page load booted with BVBOOT('hero'). The sky's PMREM
// environment (and therefore the whole indirect term on the ground) carries
// state across shots and pose() cannot reset it: booting with
// BVBOOT('waterfront') and then posing 'hero' measured sat 0.44 / hue 105 on
// the same terrain build that measures sat 0.53 / hue 96 from a hero boot.
// Within one page load the numbers are bit-stable (verified: 3 consecutive
// reports identical, and identical again after 240 extra settle frames), so
// the drift is boot-path hysteresis, not noise. Always A/B from the same boot.
(function () {
  const N = 80, TILE = 8;

  function px(rect) {
    const e = BV.engine;
    const cv = e.renderer.domElement;
    // Render immediately before the read: the context has no preserveDrawingBuffer.
    e.render(0.016);
    const w = cv.width, h = cv.height;
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g = c2.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0);
    const r = rect || { x: (w >> 1) - 48, y: (h >> 1) - 48, w: 96, h: 96 };
    return g.getImageData(r.x, r.y, r.w, r.h);
  }

  function stats(img) {
    const d = img.data, n = d.length / 4;
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < n; i++) { sr += d[i * 4]; sg += d[i * 4 + 1]; sb += d[i * 4 + 2]; }
    const mr = sr / n, mg = sg / n, mb = sb / n;
    let vr = 0, vg = 0, vb = 0, vl = 0;
    const lm = 0.299 * mr + 0.587 * mg + 0.114 * mb;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      vr += (r - mr) ** 2; vg += (g - mg) ** 2; vb += (b - mb) ** 2;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      vl += (l - lm) ** 2;
    }
    const sd = (v) => Math.sqrt(v / n);
    // HSV of the mean
    const mx = Math.max(mr, mg, mb), mn = Math.min(mr, mg, mb), df = mx - mn;
    let hue = 0;
    if (df > 0) {
      if (mx === mr) hue = 60 * (((mg - mb) / df) % 6);
      else if (mx === mg) hue = 60 * ((mb - mr) / df + 2);
      else hue = 60 * ((mr - mg) / df + 4);
      if (hue < 0) hue += 360;
    }
    const sat = mx > 0 ? df / mx : 0;
    const sl = sd(vl);
    return {
      mean: [+mr.toFixed(1), +mg.toFixed(1), +mb.toFixed(1)],
      sigma: [+sd(vr).toFixed(2), +sd(vg).toFixed(2), +sd(vb).toFixed(2)],
      lumaSigma: +sl.toFixed(2),
      lumaMean: +lm.toFixed(1),
      sigmaPct: +(100 * sl / Math.max(1e-3, lm)).toFixed(2),
      sat: +sat.toFixed(3),
      hue: +hue.toFixed(1),
      bg: +(mb / Math.max(1e-3, mg)).toFixed(3),
    };
  }

  // Find a large open grass area (no buildings/roads/water within `pad` tiles).
  function meadow(pad) {
    pad = pad || 4;
    const s = BV.sim.state;
    let best = null, bd = -1;
    for (let z = pad + 1; z < N - pad - 1; z++) {
      for (let x = pad + 1; x < N - pad - 1; x++) {
        if (s.map[z * N + x] !== 0) continue;
        let ok = true;
        for (let dz = -pad; dz <= pad && ok; dz++) {
          for (let dx = -pad; dx <= pad; dx++) {
            const m = s.map[(z + dz) * N + (x + dx)];
            if (m !== 0) { ok = false; break; }
            if (s.occ && s.occ[(z + dz) * N + (x + dx)]) { ok = false; break; }
          }
        }
        if (!ok) continue;
        // prefer near the middle of the map so the camera has room
        const d = 400 - Math.hypot(x - 40, z - 40);
        if (d > bd) { bd = d; best = { x, z }; }
      }
    }
    return best || { x: 8, z: 8 };
  }

  // Poses that put ONLY grass in the centre 96x96 of the frame.
  const POSES = {
    // hero-distance turf (dist 150 like the hero shot)
    hero: { dist: 150, polar: 0.85, night: 0 },
    // street-level turf
    street: { dist: 55, polar: 1.05, night: 0 },
    // region zoom — the aliasing/shimmer case
    region: { dist: 340, polar: 0.72, night: 0 },
    // night grade
    night: { dist: 150, polar: 0.85, night: 0.92 },
  };

  // DOF must be PINNED, exactly the way BVDEMO.shot() pins it, or the numbers
  // are not comparable run to run: dof.autoFocus resolves from whatever the
  // depth buffer held on the settling frames, and tilt-shift blur is a direct
  // multiplier on measured sigma. Without this the same street pose measured
  // sigma/mean 5.9% on one page load and 2.0% on the next — a 3x swing that has
  // nothing to do with the terrain shader.
  //   pose('street')            -> pinned DOF, i.e. what the player sees
  //   pose('street', true)      -> DOF off, i.e. what the terrain shader emits
  function setDof(dist, off) {
    if (!BV.engine._post) return;
    // setParams is a partial MERGE, so the "off" branch has to be undone
    // explicitly — otherwise the first DOF-off pose silently disables
    // tilt-shift for every measurement that follows it.
    BV.engine._post.setParams({
      dof: off
        ? { autoFocus: false, focus: dist * 0.95, range: dist * 1.2, strength: 0, maxBlur: 0 }
        : { autoFocus: false, focus: dist * 0.95, range: dist * 1.2, strength: 1.0, maxBlur: 0.85 },
    });
  }

  function pose(name, noDof) {
    const p = POSES[name] || POSES.hero;
    const m = meadow(name === 'region' ? 3 : 4);
    BVDEMO.hideUI(true);
    if (BV.sim && BV.sim.state) { BV.sim.state.speed = 0; BV.sim.state.clock = 0.5; }
    BV.engine.setWeather({ rain: 0, snow: 0, tint: [1, 1, 1] });
    setDof(p.dist, noDof);
    BVDEMO.night(p.night);
    BVDEMO.cam({
      x: (m.x + 0.5) * TILE, z: (m.z + 0.5) * TILE,
      dist: p.dist, polar: p.polar, az: Math.PI * 0.25,
    });
    for (let i = 0; i < 14; i++) BV.engine.render(0.016);
    return { pose: name, meadow: m, dof: noDof ? 'off' : 'pinned' };
  }

  function measure(rect) { return stats(px(rect)); }

  // computer{action:"zoom"} silently returns the whole screenshot in this
  // browser pane, so magnification has to happen IN the page: blit a 1:1
  // backing-pixel crop into a fixed overlay, nearest-neighbour upscaled, and
  // screenshot that. This is the only way to see whether a kerb edge is a
  // 2-pixel ramp or a 1-pixel sawtooth.
  //   BVGRASS.crop()                  -> centre 220x160 at 4x
  //   BVGRASS.crop({x,y,w,h}, 6)      -> explicit
  //   BVGRASS.crop(null, 0)           -> remove the overlay
  function crop(rect, scale) {
    let ov = document.getElementById('bvgrass-crop');
    if (scale === 0) { if (ov) ov.remove(); return 'cleared'; }
    scale = scale || 4;
    const cv = BV.engine.renderer.domElement;
    BV.engine.render(0.016);
    const w = cv.width, h = cv.height;
    const r = rect || { x: (w >> 1) - 110, y: (h >> 1) - 80, w: 220, h: 160 };
    if (!ov) {
      ov = document.createElement('canvas');
      ov.id = 'bvgrass-crop';
      ov.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;' +
        'image-rendering:pixelated;border:2px solid #f0f;pointer-events:none';
      document.body.appendChild(ov);
    }
    ov.width = r.w * scale; ov.height = r.h * scale;
    ov.style.width = (r.w * scale) + 'px';
    ov.style.height = (r.h * scale) + 'px';
    const g = ov.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(cv, r.x, r.y, r.w, r.h, 0, 0, r.w * scale, r.h * scale);
    return { rect: r, scale, canvas: [w, h] };
  }

  // Per-pixel run-length probe across a horizontal scanline: how many pixels
  // does the widest luminance transition take? A shader-space material border
  // that has collapsed to a 1-pixel step is exactly what crawls at region zoom.
  // Returns the transition widths of the N strongest edges on the line.
  function edgeWidths(y, x0, x1, top) {
    const cv = BV.engine.renderer.domElement;
    BV.engine.render(0.016);
    x0 = x0 || 0; x1 = x1 || cv.width;
    const img = px({ x: x0, y: y, w: x1 - x0, h: 1 });
    const d = img.data, n = img.width;
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    // Find local extrema pairs and measure the 10-90% rise distance.
    const out = [];
    for (let i = 2; i < n - 2; i++) {
      const g = Math.abs(L[i + 1] - L[i - 1]) * 0.5;
      if (g < 6) continue;
      let a = i, b = i;
      while (a > 1 && Math.abs(L[a - 1] - L[a]) > 1.5) a--;
      while (b < n - 2 && Math.abs(L[b + 1] - L[b]) > 1.5) b++;
      const amp = Math.abs(L[b] - L[a]);
      if (amp < 12) continue;
      out.push({ x: x0 + i, width: b - a, amp: +amp.toFixed(1) });
      i = b;
    }
    out.sort((p, q) => q.amp - p.amp);
    return out.slice(0, top || 8);
  }

  // One 96x96 patch can land entirely on a wear patch or a highlight patch and
  // libel the whole map. Sample five spread across the frame and average.
  function measure5() {
    const cv = BV.engine.renderer.domElement;
    const w = cv.width, h = cv.height, S = 96;
    const cx = (w >> 1) - S / 2, cy = (h >> 1) - S / 2;
    const rects = [
      { x: cx, y: cy, w: S, h: S },
      { x: cx - 150, y: cy - 110, w: S, h: S },
      { x: cx + 150, y: cy - 110, w: S, h: S },
      { x: cx - 150, y: cy + 110, w: S, h: S },
      { x: cx + 150, y: cy + 110, w: S, h: S },
    ].filter((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h);
    const all = rects.map((r) => stats(px(r)));
    const avg = (f) => +(all.reduce((a, s) => a + f(s), 0) / all.length).toFixed(3);
    return {
      n: all.length,
      mean: [0, 1, 2].map((i) => avg((s) => s.mean[i])),
      sigmaPct: avg((s) => s.sigmaPct),
      sat: avg((s) => s.sat),
      hue: avg((s) => s.hue),
      bg: avg((s) => s.bg),
      lumaMean: avg((s) => s.lumaMean),
      spread: { hue: [Math.min(...all.map(s=>s.hue)), Math.max(...all.map(s=>s.hue))],
                sat: [Math.min(...all.map(s=>s.sat)), Math.max(...all.map(s=>s.sat))] },
    };
  }

  // Temporal shimmer probe: nudge the camera azimuth by a sub-degree amount and
  // measure how much the sampled patch changes. High delta at region zoom == aliasing.
  function shimmer(name) {
    pose(name);
    const a = px();
    const e = BV.engine;
    e._camAz += 0.004; e._sAz = e._camAz; e._applyCamera();
    for (let i = 0; i < 3; i++) e.render(0.016);
    const b = px();
    let acc = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      acc += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) +
             Math.abs(a.data[i + 2] - b.data[i + 2]);
    }
    return +(acc / (a.data.length / 4) / 3).toFixed(3);
  }

  // Every pose is reported twice: `<name>` as the player sees it (tilt-shift
  // pinned) and `<name>Raw` with DOF off. Only the Raw numbers grade the
  // terrain shader; the pinned ones grade the frame.
  function report() {
    const out = {};
    for (const k of Object.keys(POSES)) {
      pose(k); out[k] = measure5();
      pose(k, true); out[k + 'Raw'] = measure5();
    }
    out.shimmerRegion = shimmer('region');
    out.shimmerHero = shimmer('hero');
    return out;
  }

  window.BVGRASS = { pose, measure, measure5, report, stats, px, meadow, shimmer,
                     crop, edgeWidths, POSES };
  return 'BVGRASS ready';
})();
