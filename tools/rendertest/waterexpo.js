// Dev-only water EXPOSURE measurement harness (see CONTRACTS-RENDER.md §3.3).
// Paste/eval into the page after BVBOOT(). Never imported by src/.
//
//   BVWX.expo('region')  -> { lake, grass, city, ramp, speckle, foamByBand }
//   BVWX.graze('waterfront') -> { farWater, sky }
//
// Everything is measured on the DEVICE FRAMEBUFFER with gl.readPixels, and
// luminance is LINEAR (sRGB EOTF applied first), which is the space the art
// director's numbers are quoted in (grass 0.164, city 0.103).
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
  const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lumLin = (c) => (c ? 0.2126 * s2l(c[0]) + 0.7152 * s2l(c[1]) + 0.0722 * s2l(c[2]) : 0);
  const lum255 = (c) => (c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : 0);
  const sat = (c) => { const M = Math.max(c[0], c[1], c[2]), m = Math.min(c[0], c[1], c[2]); return M < 1 ? 0 : (M - m) / M; };
  const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const sd = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) * (v - m)))); };
  const r3 = (v) => +v.toFixed(3);

  function proj(x, y, z) {
    const v = new (e.camera.position.constructor)(x, y, z);
    v.project(e.camera);
    const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
    return { x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h, z: v.z };
  }
  function onScreen(p, pad) {
    pad = pad || 6;
    const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
    return p.z <= 1 && p.x > pad && p.y > pad && p.x < w - pad && p.y < h - pad;
  }

  // --- CPU shore-distance field, in TILES, over the tile grid ---------------
  let _dist = null;
  function shoreDist() {
    if (_dist) return _dist;
    const s = BV.sim.state, INF = 1e9;
    const d = new Float32Array(N * N).fill(INF);
    const isW = (x, z) => {
      if (x < 0 || z < 0 || x >= N || z >= N) return false;
      const i = z * N + x;
      return s.map[i] === 1 || (s.bridge && s.bridge[i] === 1);
    };
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (!isW(x, z)) d[z * N + x] = 0;
    const S = Math.SQRT2;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const i = z * N + x; let v = d[i]; if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (z > 0) { v = Math.min(v, d[i - N] + 1);
        if (x > 0) v = Math.min(v, d[i - N - 1] + S);
        if (x < N - 1) v = Math.min(v, d[i - N + 1] + S); }
      d[i] = v;
    }
    for (let z = N - 1; z >= 0; z--) for (let x = N - 1; x >= 0; x--) {
      const i = z * N + x; let v = d[i]; if (v === 0) continue;
      if (x < N - 1) v = Math.min(v, d[i + 1] + 1);
      if (z < N - 1) { v = Math.min(v, d[i + N] + 1);
        if (x < N - 1) v = Math.min(v, d[i + N + 1] + S);
        if (x > 0) v = Math.min(v, d[i + N - 1] + S); }
      d[i] = v;
    }
    // distance from the SHORELINE, not from the land cell centre
    for (let i = 0; i < d.length; i++) d[i] = d[i] > 0.5 ? d[i] - 0.5 : 0;
    _dist = d;
    return d;
  }

  function waterPts() {
    const s = BV.sim.state, d = shoreDist(), out = [];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const i = z * N + x;
      if (!(s.map[i] === 1 || (s.bridge && s.bridge[i] === 1))) continue;
      const p = proj((x + 0.5) * 8, -0.35, (z + 0.5) * 8);
      if (!onScreen(p, 10)) continue;
      p.sd = d[i];
      out.push(p);
    }
    return out;
  }
  function typePts(type, y) {
    const s = BV.sim.state, out = [];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (s.map[z * N + x] !== type) continue;
      const p = proj((x + 0.5) * 8, y, (z + 0.5) * 8);
      if (onScreen(p, 6)) out.push(p);
    }
    return out;
  }
  function cityPts() {
    const s = BV.sim.state, out = [];
    const list = s.buildings || [];
    for (const b of list) {
      const wx = ((b.x || 0) + ((b.tw || 1)) * 0.5) * 8;
      const wz = ((b.z || 0) + ((b.td || 1)) * 0.5) * 8;
      const p = proj(wx, 3.0, wz);
      if (onScreen(p, 6)) out.push(p);
    }
    return out;
  }

  // High-pass residual sigma inside a KxK patch (K odd), luminance 0..255.
  function hpSigma(f, cx, cy, K) {
    K = K || 11;
    const half = (K - 1) / 2, L = [];
    for (let j = -half; j <= half; j++) {
      const row = [];
      for (let i = -half; i <= half; i++) {
        const c = px(f, cx + i, cy + j);
        if (!c) return null;
        row.push(lum255(c));
      }
      L.push(row);
    }
    // residual = pixel - 5x5 box mean (clamped), computed on the interior only
    const res = [];
    for (let j = 2; j < K - 2; j++) for (let i = 2; i < K - 2; i++) {
      let s = 0;
      for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) s += L[j + b][i + a];
      res.push(L[j][i] - s / 25);
    }
    return res;
  }

  function expo(shot) {
    BVDEMO.shot(shot || 'region');
    for (let i = 0; i < 4; i++) e.render(0.016);
    const f = grab();
    const wp = waterPts();
    const gp = typePts(0, 0);
    const cp = cityPts();

    const sample = (pts) => pts.map((p) => px(f, p.x, p.y)).filter(Boolean);
    const gC = sample(gp), cC = sample(cp);

    // --- water bands by shore distance (tiles) -----------------------------
    const bands = [[0, 0.6], [0.6, 1.5], [1.5, 3], [3, 5], [5, 99]];
    const bandOut = [];
    for (const [a, b] of bands) {
      const pts = wp.filter((p) => p.sd >= a && p.sd < b);
      const C = sample(pts);
      if (!C.length) { bandOut.push({ band: `${a}-${b}`, n: 0 }); continue; }
      bandOut.push({
        band: `${a}-${b}t`, n: C.length,
        lum: r3(avg(C.map(lumLin))),
        rgb: [Math.round(avg(C.map((c) => c[0]))), Math.round(avg(C.map((c) => c[1]))), Math.round(avg(C.map((c) => c[2])))],
        sat: r3(avg(C.map(sat))),
        // "foamy": bright AND desaturated
        foamPct: +(100 * C.filter((c) => sat(c) < 0.18 && lum255(c) > 140).length / C.length).toFixed(1),
      });
    }

    // open water = >= 2 tiles offshore
    const openPts = wp.filter((p) => p.sd >= 2);
    const openC = sample(openPts);
    const shoreC = sample(wp.filter((p) => p.sd < 0.6));
    const deepC = sample(wp.filter((p) => p.sd >= 4));

    // --- high-pass speckle over open water ---------------------------------
    let res = [];
    for (const p of openPts.slice(0, 260)) {
      const r = hpSigma(f, p.x, p.y, 11);
      if (r) res = res.concat(r);
    }

    const allC = sample(wp);
    return {
      shot: shot || 'region',
      lakeAll: { n: allC.length, lum: r3(avg(allC.map(lumLin))), sat: r3(avg(allC.map(sat))),
                 rgb: [Math.round(avg(allC.map((c) => c[0]))), Math.round(avg(allC.map((c) => c[1]))), Math.round(avg(allC.map((c) => c[2])))] },
      openWater: { n: openC.length, lum: r3(avg(openC.map(lumLin))), sat: r3(avg(openC.map(sat))),
                   rgb: [Math.round(avg(openC.map((c) => c[0]))), Math.round(avg(openC.map((c) => c[1]))), Math.round(avg(openC.map((c) => c[2])))] },
      grass: { n: gC.length, lum: r3(avg(gC.map(lumLin))) },
      city: { n: cC.length, lum: r3(avg(cC.map(lumLin))) },
      ratios: { lakeOverGrass: r3(avg(openC.map(lumLin)) / Math.max(1e-6, avg(gC.map(lumLin)))),
                lakeOverCity: r3(avg(openC.map(lumLin)) / Math.max(1e-6, avg(cC.map(lumLin)))) },
      ramp: { shoreLum: r3(avg(shoreC.map(lumLin))), deepLum: r3(avg(deepC.map(lumLin))),
              spanRatio: r3(avg(shoreC.map(lumLin)) / Math.max(1e-6, avg(deepC.map(lumLin)))) },
      bands: bandOut,
      speckle: { n: res.length, sigma255: +sd(res).toFixed(2), maxAbs: +Math.max.apply(null, res.map(Math.abs)).toFixed(1) },
    };
  }

  // Requirement: at grazing angles the far water must stay BRIGHTER than the
  // sky directly above the horizon (the fog-overwrite fix).
  function graze(shot) {
    BVDEMO.shot(shot || 'region');
    for (let i = 0; i < 4; i++) e.render(0.016);
    const f = grab();
    const wp = waterPts().sort((a, b) => a.y - b.y);
    if (!wp.length) return { err: 'no water on screen' };
    const top = wp.slice(0, Math.max(6, Math.floor(wp.length * 0.08)));
    const wl = top.map((p) => lum255(px(f, p.x, p.y))).filter((v) => v);
    const yTop = Math.min.apply(null, top.map((p) => p.y));
    const sky = [];
    for (let dx = -60; dx <= 60; dx += 10) {
      for (let dy = 12; dy <= 28; dy += 4) {
        const c = px(f, top[0].x + dx, yTop - dy);
        if (c) sky.push(lum255(c));
      }
    }
    return { farWaterLum255: +avg(wl).toFixed(1), skyLum255: +avg(sky).toFixed(1),
             waterOverSky: +(avg(wl) / Math.max(1e-6, avg(sky))).toFixed(3) };
  }

  // Foam band profile. Tile CENTRES are 4 world units from the shoreline, so a
  // 2 m foam band is invisible to expo()'s tile-centre sampling; this walks a
  // ray from each land-adjacent water tile's shared edge out into the lake and
  // reports brightness + desaturation at a series of world-unit offsets.
  function foamProfile(shot, offsets) {
    BVDEMO.shot(shot || 'region');
    for (let i = 0; i < 4; i++) e.render(0.016);
    const f = grab();
    const s = BV.sim.state;
    const isW = (x, z) => {
      if (x < 0 || z < 0 || x >= N || z >= N) return false;
      const i = z * N + x;
      return s.map[i] === 1 || (s.bridge && s.bridge[i] === 1);
    };
    offsets = offsets || [0.6, 1.5, 2.5, 4, 6, 9, 14, 20, 30];
    const acc = offsets.map(() => []);
    for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
      if (!isW(x, z)) continue;
      // inward normal = direction from the land neighbour into the water
      let nx = 0, nz = 0, hits = 0;
      if (!isW(x - 1, z)) { nx += 1; hits++; }
      if (!isW(x + 1, z)) { nx -= 1; hits++; }
      if (!isW(x, z - 1)) { nz += 1; hits++; }
      if (!isW(x, z + 1)) { nz -= 1; hits++; }
      if (hits !== 1) continue;                 // straight edges only
      // world point ON the shoreline (the shared tile edge), then step inward
      const wx = (x + 0.5) * 8 - nx * 4, wz = (z + 0.5) * 8 - nz * 4;
      for (let k = 0; k < offsets.length; k++) {
        const p = proj(wx + nx * offsets[k], -0.35, wz + nz * offsets[k]);
        if (!onScreen(p, 8)) continue;
        const c = px(f, p.x, p.y);
        if (c) acc[k].push(c);
      }
    }
    return offsets.map((o, k) => {
      const C = acc[k];
      if (!C.length) return { off: o, n: 0 };
      return { off: o, n: C.length, lum: r3(avg(C.map(lumLin))), sat: r3(avg(C.map(sat))),
               rgb: [Math.round(avg(C.map((c) => c[0]))), Math.round(avg(C.map((c) => c[1]))), Math.round(avg(C.map((c) => c[2])))],
               foamPct: +(100 * C.filter((c) => sat(c) < 0.18 && lum255(c) > 140).length / C.length).toFixed(1) };
    });
  }

  // Specular glint census. Dense scan of a +/-3 px neighbourhood around every
  // on-screen water tile centre. Does NOT touch setNight(), so it is safe to
  // run in a parameter sweep (BVWM.report() leaves the sky PMREM at night).
  function glint(shot) {
    BVDEMO.shot(shot || 'waterfront');
    for (let i = 0; i < 4; i++) e.render(0.016);
    const f = grab();
    const wp = waterPts();
    let hot = 0, hot245 = 0, maxL = 0, maxRGB = null, n = 0;
    for (const p of wp) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      const c = px(f, p.x + dx * 2, p.y + dy * 2); if (!c) continue;
      const L = lum255(c); n++;
      if (L > maxL) { maxL = L; maxRGB = c; }
      if (L > 200) hot++;
      if (L > 245) hot245++;
    }
    return { shot: shot || 'waterfront', maxLum: +maxL.toFixed(1), maxRGB, scanned: n,
             hotPct: +(100 * hot / Math.max(1, n)).toFixed(2),
             whitePct: +(100 * hot245 / Math.max(1, n)).toFixed(2) };
  }

  window.BVWX = { expo, graze, foamProfile, glint, grab, px, lumLin, lum255, waterPts, shoreDist,
                  reset: () => { _dist = null; } };
})();
