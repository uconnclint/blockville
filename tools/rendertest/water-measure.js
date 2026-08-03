// Dev-only water measurement harness (see CONTRACTS-RENDER.md §3.3).
// Paste/eval into the page after BVBOOT(). Never imported by src/.
//
//   BVWM.report()   -> the four reviewer measurements, as numbers
//
// Measurements
//   anim    : 64-px strip across the near lake, sampled 1.5 s apart. A surface
//             that "breathes as one unit" has sdDeltaG ~= 0; a travelling wave
//             has sdDeltaG >> |meanDeltaG|.
//   fresnel : mean luminance of the nearest vs the farthest water samples.
//             farOverNear must be > 1 (grazing angles go sky-bright).
//   glint   : brightest water pixel + count above 200/255.
//   night   : water and land luminance at nightEff 0 and 1, as keep-ratios.
//             `ratio` is waterKeep / landKeep; 1.0 means the lake dims exactly
//             as fast as the ground it sits in.
(function () {
  const e = BV.engine, gl = e.renderer.getContext();
  const N = 80;

  function grab() {
    e.render(0.016);
    const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { w, h, buf };
  }
  function px(f, x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return null;
    const i = ((f.h - 1 - y) * f.w + x) * 4;
    return [f.buf[i], f.buf[i + 1], f.buf[i + 2]];
  }
  const lum = (c) => (c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : 0);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

  function proj(x, y, z) {
    const v = new (e.camera.position.constructor)(x, y, z);
    v.project(e.camera);
    const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
    return { x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h, z: v.z };
  }
  function onScreen(p) {
    const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
    return p.z <= 1 && p.x > 4 && p.y > 4 && p.x < w - 4 && p.y < h - 4;
  }
  function tilePts(type, y) {
    const s = BV.sim.state, cam = e.camera, out = [];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (s.map[z * N + x] !== type) continue;
      const wx = (x + 0.5) * 8, wz = (z + 0.5) * 8;
      const p = proj(wx, y, wz);
      if (!onScreen(p)) continue;
      p.d = Math.hypot(cam.position.x - wx, cam.position.z - wz);
      out.push(p);
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  function report() {
    const out = {};
    // ---- animation ------------------------------------------------------
    BVDEMO.shot('waterfront');
    let f = grab();
    const wp = tilePts(1, -0.35);
    const p0 = wp[Math.floor(wp.length * 0.12)];
    const strip = [];
    for (let i = 0; i < 64; i++) strip.push({ x: p0.x - 32 + i, y: p0.y });
    const a = strip.map((p) => px(f, p.x, p.y));
    for (let i = 0; i < 30; i++) e.render(0.05);          // +1.5 s
    f = grab();
    const b = strip.map((p) => px(f, p.x, p.y));
    const dg = a.map((c, i) => b[i][1] - c[1]);
    const m = avg(dg);
    const sd = Math.sqrt(avg(dg.map((v) => (v - m) * (v - m))));
    out.anim = {
      meanDeltaG: +m.toFixed(2), sdDeltaG: +sd.toFixed(2),
      maxAbsDeltaG: Math.max.apply(null, dg.map(Math.abs)),
      travellingScore: +(sd / Math.max(0.25, Math.abs(m))).toFixed(2),
      spatialSD_lum: +Math.sqrt(avg(a.map(lum).map((v) => (v - avg(a.map(lum))) ** 2))).toFixed(2),
    };
    // ---- fresnel + glint ------------------------------------------------
    f = grab();
    const near = wp.slice(0, 40).map((p) => lum(px(f, p.x, p.y)));
    const far = wp.slice(-40).map((p) => lum(px(f, p.x, p.y)));
    out.fresnel = {
      nearLum: +avg(near).toFixed(1), farLum: +avg(far).toFixed(1),
      farOverNear: +(avg(far) / avg(near)).toFixed(2),
      nearRGB: px(f, wp[0].x, wp[0].y),
      farRGB: px(f, wp[wp.length - 1].x, wp[wp.length - 1].y),
    };
    let hot = 0, maxL = 0, maxRGB = null;
    // dense scan of the water region, not just tile centres
    const seen = [];
    for (const p of wp) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      const c = px(f, p.x + dx * 2, p.y + dy * 2); if (!c) continue;
      const L = lum(c); seen.push(L);
      if (L > maxL) { maxL = L; maxRGB = c; }
      if (L > 200) hot++;
    }
    out.glint = { maxLum: +maxL.toFixed(1), maxRGB, hotPixels: hot, scanned: seen.length,
                  hotPct: +(100 * hot / Math.max(1, seen.length)).toFixed(2) };
    // ---- day / night -----------------------------------------------------
    BVDEMO.shot('region');
    const rw = tilePts(1, -0.35), rl = tilePts(0, 0);
    const set = (pts) => { const g = grab(); return avg(pts.slice(0, 400).map((p) => lum(px(g, p.x, p.y)))); };
    e.setNight(0); for (let i = 0; i < 3; i++) e.render(0.016);
    const wDay = set(rw), lDay = set(rl);
    let g2 = grab();
    const wDayRGB = px(g2, rw[(rw.length / 2) | 0].x, rw[(rw.length / 2) | 0].y);
    e.setNight(1); for (let i = 0; i < 3; i++) e.render(0.016);
    const wNight = set(rw), lNight = set(rl);
    g2 = grab();
    const wNightRGB = px(g2, rw[(rw.length / 2) | 0].x, rw[(rw.length / 2) | 0].y);
    e.setNight(0);
    out.night = {
      waterDay: +wDay.toFixed(1), waterNight: +wNight.toFixed(1), waterKeep: +(wNight / wDay).toFixed(3),
      landDay: +lDay.toFixed(1), landNight: +lNight.toFixed(1), landKeep: +(lNight / lDay).toFixed(3),
      ratio: +((wNight / wDay) / (lNight / lDay)).toFixed(2),
      waterDayRGB: wDayRGB, waterNightRGB: wNightRGB,
    };
    return out;
  }

  // -------------------------------------------------------------------------
  // diag(): the controls `report()` lacks.
  //
  //  * water vs LAND temporal delta over the same interval. If land moves too,
  //    the water's mean delta is the global clock/lighting drifting, not the
  //    surface breathing — only the *spread* (sd) is really the surface.
  //  * spatial SD of water luminance over a few hundred scattered water pixels
  //    (a travelling, per-pixel surface has a big one; an airbrushed gradient
  //    has ~1).
  //  * fresnel measured against SCREEN HEIGHT rather than tile distance, in
  //    quintiles, so a monotone near->far ramp is visible.
  // -------------------------------------------------------------------------
  function diag(shot) {
    BVDEMO.shot(shot || 'waterfront');
    const e2 = BV.engine;
    for (let i = 0; i < 3; i++) e2.render(0.016);
    const f1 = grab();
    const wp = tilePts(1, -0.35), lp = tilePts(0, 0);
    const sw = wp.slice(0, 300), sl = lp.slice(0, 300);
    const gw1 = sw.map((p) => px(f1, p.x, p.y)), gl1 = sl.map((p) => px(f1, p.x, p.y));
    for (let i = 0; i < 30; i++) e2.render(0.05);          // +1.5 s
    const f2 = grab();
    const gw2 = sw.map((p) => px(f2, p.x, p.y)), gl2 = sl.map((p) => px(f2, p.x, p.y));
    const stat = (A, B) => {
      const d = [];
      for (let i = 0; i < A.length; i++) if (A[i] && B[i]) d.push(B[i][1] - A[i][1]);
      const m = avg(d), sd = Math.sqrt(avg(d.map((v) => (v - m) * (v - m))));
      return { mean: +m.toFixed(2), sd: +sd.toFixed(2), n: d.length };
    };
    const spatial = (G) => {
      const v = G.filter(Boolean).map(lum), m = avg(v);
      return { mean: +m.toFixed(1), sd: +Math.sqrt(avg(v.map((q) => (q - m) * (q - m)))).toFixed(2) };
    };
    // fresnel by screen row quintile (higher on screen == more grazing)
    const rows = wp.filter((p) => px(f1, p.x, p.y)).sort((a, b) => a.y - b.y);
    const q = [];
    for (let k = 0; k < 5; k++) {
      const s = rows.slice(Math.floor(rows.length * k / 5), Math.floor(rows.length * (k + 1) / 5));
      q.push(+avg(s.map((p) => lum(px(f1, p.x, p.y)))).toFixed(1));
    }
    return {
      waterDelta: stat(gw1, gw2), landDelta: stat(gl1, gl2),
      waterSpatial: spatial(gw1), landSpatial: spatial(gl1),
      // quintile 0 = topmost rows on screen = farthest / most grazing
      fresnelByRow: q, rowFarOverNear: +(q[0] / q[4]).toFixed(2),
      sunY: +e2._water.uniforms.uSunDir.value.y.toFixed(3),
      detail: e2._water.uniforms.uDetail.value,
      quality: e2._water._quality,
      canvas: [e2.renderer.domElement.width, e2.renderer.domElement.height],
    };
  }

  window.BVWM = { report, diag, grab, px, lum, proj, tilePts };
})();
