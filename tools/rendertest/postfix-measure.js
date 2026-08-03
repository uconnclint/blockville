// tools/rendertest/postfix-measure.js — targeted measurements for the three
// post.js defects (DOF sub-pixel blur, AO bilateral bleed, red-channel clip).
//
// Dev-only. Never imported by src/. Load AFTER postmeasure.js:
//   (0,eval)(await (await fetch('/tools/rendertest/postfix-measure.js',{cache:'no-store'})).text());
//
// window.PX:
//   PX.dofAB(nBands)      -> per-screen-band mean |delta| of toggling dof.enabled
//   PX.coc(nBands)        -> CoC read straight out of rtDofA.a (half-float)
//   PX.dofRadius()        -> what the CoC->pixel mapping actually resolves to
//   PX.aoByPixel(maxPx)   -> AO ratio vs PIXEL distance out from a building base
//   PX.clip()             -> fraction of frame with a single channel clipped to 0
//   PX.acf(rect)          -> anisotropy of the fine residual (x vs y lags)
//   PX.aoDepthChannel()   -> is the bilateral's depth channel actually usable?

(function () {
  const PX = {};
  const E = () => window.BV.engine;
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  function halfToFloat(h) {
    const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  // ------------------------------------------------------------------ DOF A/B
  PX.dofAB = function dofAB(nBands) {
    nBands = nBands || 12;
    const p = E()._post;
    const was = p.params.dof.enabled;
    p.setParams({ dof: { enabled: true } });
    const on = PM.grab();
    p.setParams({ dof: { enabled: false } });
    const off = PM.grab();
    p.setParams({ dof: { enabled: was } });
    PM.grab();

    const W = on.w, H = on.h;
    const bands = [];
    for (let b = 0; b < nBands; b++) {
      const y0 = Math.floor(H * b / nBands), y1 = Math.floor(H * (b + 1) / nBands);
      let sum = 0, mx = 0, n = 0;
      for (let y = y0; y < y1; y += 2) {
        const row = y * W * 4;
        for (let x = 0; x < W; x += 2) {
          const i = row + x * 4;
          const d = (Math.abs(on.px[i] - off.px[i]) + Math.abs(on.px[i + 1] - off.px[i + 1]) +
                     Math.abs(on.px[i + 2] - off.px[i + 2])) / 3;
          sum += d; if (d > mx) mx = d; n++;
        }
      }
      // band 0 in this loop is the BOTTOM of the framebuffer; report top-down.
      bands.push({ mean: +(sum / n).toFixed(3), max: +mx.toFixed(1) });
    }
    bands.reverse();
    const rowsPerBand = Math.round(H / nBands);
    return { H, rowsPerBand, topDown: bands };
  };

  // --------------------------------------------------------------- CoC buffer
  PX.coc = function coc(nBands) {
    nBands = nBands || 12;
    const e = E(), p = e._post, r = e.renderer;
    e.render(0.016);
    const W = p._dofW, H = p._dofH;
    const buf = new Uint16Array(W * H * 4);
    r.readRenderTargetPixels(p.rtDofA, 0, 0, W, H, buf);
    const bands = [];
    for (let b = 0; b < nBands; b++) {
      const y0 = Math.floor(H * b / nBands), y1 = Math.floor(H * (b + 1) / nBands);
      let s = 0, n = 0, mx = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x += 2) {
          const a = halfToFloat(buf[(y * W + x) * 4 + 3]);
          s += a; if (a > mx) mx = a; n++;
        }
      }
      bands.push({ mean: +(s / n).toFixed(3), max: +mx.toFixed(3) });
    }
    bands.reverse();
    return { size: [W, H], topDown: bands };
  };

  PX.dofRadius = function dofRadius() {
    const p = E()._post;
    const px = p.mDofBokeh.uniforms.uRadiusPx.value;
    return {
      uRadiusPx: +px.toFixed(2),
      halfResPxAtCoC: { '0.25': +(px * 0.25).toFixed(2), '0.5': +(px * 0.5).toFixed(2), '1.0': +px.toFixed(2) },
      fullResPxAtCoC05: +(px * 0.5 * 2).toFixed(2),
      dofBuf: [p._dofW, p._dofH],
      taps: p.mDofBokeh.uniforms.uTaps.value,
    };
  };

  // --------------------------------------------- AO by SCREEN-PIXEL distance
  // Walks outward from camera-facing building wall bases along the ground, in
  // device pixels, and reports luma(AO on)/luma(AO off) per pixel distance.
  PX.aoByPixel = function aoByPixel(maxPx) {
    maxPx = maxPx || 16;
    const e = E(), cam = e.camera, p = e._post;
    const cw = e.renderer.domElement.width, ch = e.renderer.domElement.height;
    const V = cam.position;
    const boxes = [];
    e._buildings.forEach((m) => {
      if (!m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      const pos = m.position, ry = Math.abs(Math.round(m.rotation.y / (Math.PI / 2))) % 2;
      const ex = ry ? (bb.max.z - bb.min.z) / 2 : (bb.max.x - bb.min.x) / 2;
      const ez = ry ? (bb.max.x - bb.min.x) / 2 : (bb.max.z - bb.min.z) / 2;
      boxes.push({ minX: pos.x - ex, maxX: pos.x + ex, minZ: pos.z - ez, maxZ: pos.z + ez,
                   minY: pos.y, maxY: pos.y + (bb.max.y - bb.min.y) });
    });
    const rayBox = (ox, oy, oz, dx, dy, dz, tmax, b) => {
      let t0 = 0.001, t1 = tmax;
      const slab = (o, d, mn, mx) => {
        if (Math.abs(d) < 1e-8) return o >= mn && o <= mx;
        let a = (mn - o) / d, c = (mx - o) / d;
        if (a > c) { const t = a; a = c; c = t; }
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
        return t1 >= t0;
      };
      if (!slab(ox, dx, b.minX, b.maxX)) return false;
      if (!slab(oy, dy, b.minY, b.maxY)) return false;
      if (!slab(oz, dz, b.minZ, b.maxZ)) return false;
      return true;
    };
    const Vec = cam.position.constructor;
    const proj = (wx, wy, wz) => {
      const v = new Vec(wx, wy, wz); v.project(cam);
      return [(v.x * 0.5 + 0.5) * (cw - 1), (1 - (v.y * 0.5 + 0.5)) * (ch - 1)];
    };

    // For each camera-facing wall base, the screen-space outward direction.
    const rays = [];
    const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const b of boxes) {
      if (b.maxY - b.minY < 3) continue;
      for (const [nx, nz] of faces) {
        const bx = nx > 0 ? b.maxX : (nx < 0 ? b.minX : (b.minX + b.maxX) / 2);
        const bz = nz > 0 ? b.maxZ : (nz < 0 ? b.minZ : (b.minZ + b.maxZ) / 2);
        const t = [V.x - bx, V.z - bz], len = Math.hypot(t[0], t[1]);
        if ((t[0] * nx + t[1] * nz) / len < 0.55) continue;
        const span = nx ? (b.maxZ - b.minZ) : (b.maxX - b.minX);
        const tang = nx ? [0, 1] : [1, 0];
        for (let s = -0.3; s <= 0.31; s += 0.15) {
          const ox = bx + tang[0] * span * s, oz = bz + tang[1] * span * s;
          const a = proj(ox, 0.02, oz);
          const c = proj(ox + nx * 2.0, 0.02, oz + nz * 2.0);
          const dx = c[0] - a[0], dy = c[1] - a[1];
          const dl = Math.hypot(dx, dy);
          if (dl < maxPx * 0.55) continue;          // too foreshortened to resolve
          if (a[0] < 8 || a[0] > cw - 9 || a[1] < 8 || a[1] > ch - 9) continue;
          // is the base point visible?
          const rx = ox - V.x, ry2 = 0.02 - V.y, rz = oz - V.z;
          const dist = Math.hypot(rx, ry2, rz);
          let occ = false;
          for (const o of boxes) {
            if (rayBox(V.x, V.y, V.z, rx / dist, ry2 / dist, rz / dist, dist - 0.3, o)) { occ = true; break; }
          }
          if (occ) continue;
          // stay off other buildings for the whole walk
          rays.push({ x: a[0], y: a[1], dx: dx / dl, dy: dy / dl, wpu: dl / 2.0 });
        }
      }
    }

    const was = p.params.ssao.enabled;
    p.setParams({ ssao: { enabled: true } });  const gOn = PM.grab();
    p.setParams({ ssao: { enabled: false } }); const gOff = PM.grab();
    p.setParams({ ssao: { enabled: was } });   PM.grab();

    const acc = [], cnt = [];
    for (let d = 0; d <= maxPx; d++) { acc.push(0); cnt.push(0); }
    let wpuSum = 0;
    for (const r of rays) {
      wpuSum += r.wpu;
      for (let d = 0; d <= maxPx; d++) {
        const x = Math.round(r.x + r.dx * d), y = Math.round(r.y + r.dy * d);
        if (x < 0 || y < 0 || x >= cw || y >= ch) break;
        const o = lum(PM.at(gOff, x, y));
        if (o > 6) { acc[d] += lum(PM.at(gOn, x, y)) / o; cnt[d]++; }
      }
    }
    const ratio = acc.map((v, k) => +(v / Math.max(1, cnt[k])).toFixed(4));
    const far = ratio[maxPx];
    return {
      rays: rays.length, pxPerWorldUnit: +(wpuSum / Math.max(1, rays.length)).toFixed(2),
      aoRatio: ratio,
      occPct: ratio.map((v) => +(100 * (1 - v)).toFixed(2)),
      dipVsFarPct: ratio.map((v) => +(100 * (1 - v / far)).toFixed(2)),
      argMin: ratio.indexOf(Math.min(...ratio)),
    };
  };

  // ------------------------------------------------------------ channel clip
  PX.clip = function clip(g) {
    g = g || PM.grab();
    const px = g.px;
    let n = 0, rOnly = 0, gOnly = 0, bOnly = 0, anyOne = 0, allZero = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      n++;
      const z = (r === 0) + (gg === 0) + (b === 0);
      if (z === 3) { allZero++; continue; }
      if (z === 0) continue;
      const mx = Math.max(r, gg, b);
      if (mx < 8) continue;                  // genuinely black, not a hue clip
      anyOne++;
      if (r === 0) rOnly++;
      if (gg === 0) gOnly++;
      if (b === 0) bOnly++;
    }
    const pct = (v) => +(100 * v / n).toFixed(3);
    return { n, anyChannelClippedPct: pct(anyOne), rClippedPct: pct(rOnly),
             gClippedPct: pct(gOnly), bClippedPct: pct(bOnly), allZeroPct: pct(allZero) };
  };

  // Darkest / most-saturated shadow pixels, for the "toxic green" check.
  PX.shadowSample = function shadowSample(k, g) {
    k = k || 8;
    g = g || PM.grab();
    const out = [];
    const px = g.px;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx < 10 || mx > 90) continue;
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      out.push({ sat: +sat.toFixed(3), rgb: [r, gg, b] });
    }
    out.sort((a, b2) => b2.sat - a.sat);
    const meanSat = out.reduce((s, o) => s + o.sat, 0) / Math.max(1, out.length);
    return { nShadowPx: out.length, meanSat: +meanSat.toFixed(3), worst: out.slice(0, k) };
  };

  // ------------------------------------------------------------- anisotropy
  // Normalised autocorrelation of the high-pass residual, x lags vs y lags.
  PX.acf = function acf(rect, g) {
    g = g || PM.grab();
    const { x, y, w, h } = rect;
    const val = (xx, yy) => lum(PM.at(g, xx, yy));
    // residual = pixel - 5x5 box mean (removes lighting/albedo gradients)
    const res = new Float64Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let s = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { s += val(x + i + dx, y + j + dy); n++; }
        res[j * w + i] = val(x + i, y + j) - s / n;
      }
    }
    let mean = 0; for (let i = 0; i < res.length; i++) mean += res[i];
    mean /= res.length;
    let v0 = 0; for (let i = 0; i < res.length; i++) v0 += (res[i] - mean) ** 2;
    v0 /= res.length;
    const lag = (lx, ly) => {
      let s = 0, n = 0;
      for (let j = 0; j < h - ly; j++) for (let i = 0; i < w - lx; i++) {
        s += (res[j * w + i] - mean) * (res[(j + ly) * w + i + lx] - mean); n++;
      }
      return +((s / n) / v0).toFixed(3);
    };
    return { rect, rms: +Math.sqrt(v0).toFixed(3),
             x: [lag(1, 0), lag(2, 0), lag(3, 0)],
             y: [lag(0, 1), lag(0, 2), lag(0, 3)] };
  };

  // --------------------------------------------- AO bilateral depth channel
  // Reads rtAO0 (pre-denoise) and reports the distribution of the .g channel,
  // which the bilateral uses as its depth guide.
  PX.aoDepthChannel = function aoDepthChannel() {
    const e = E(), p = e._post, r = e.renderer;
    e.render(0.016);
    const W = p._aoW, H = p._aoH;
    const px = new Uint8Array(W * H * 4);
    const prevT = r.getRenderTarget(), prevAC = r.autoClear;
    r.autoClear = false;
    p._blit(p.mSSAO, p.rtAO1);              // raw SSAO, no denoise
    r.autoClear = prevAC; r.setRenderTarget(prevT);
    r.readRenderTargetPixels(p.rtAO1, 0, 0, W, H, px);
    const hist = new Array(9).fill(0);
    let n = 0, distinct = new Set();
    for (let i = 0; i < px.length; i += 4 * 7) {
      const gch = px[i + 1];
      hist[Math.min(8, gch >> 5)]++; n++;
      if (distinct.size < 40) distinct.add(gch);
    }
    e.render(0.016);
    return { size: [W, H], sampled: n, gHistogram32: hist,
             distinctGValues: [...distinct].sort((a, b) => a - b).slice(0, 40),
             rtType: p.rtAO0.texture.type };
  };

  window.PX = PX;
  return 'PX ready';
})();
