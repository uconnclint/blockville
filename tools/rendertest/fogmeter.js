// Dev-only aerial-perspective / fog A/B harness. Paste/eval into the game page
// after BVBOOT(). Never imported by src/.
//
//   BVFOG.dbgDepth(mode)   -> per-fragment distance visualisation, read back
//                             from the TERRAIN SHADER ITSELF (not predicted):
//                             1 = vFogDepth, 2 = |vWPos-uCamPos|, 3 = fogFactor,
//                             4 = the horizon ramp. Returns a per-pixel field.
//   BVFOG.ab()             -> grass-only fog A/B: mean RGB delta (fog ON minus
//                             fog OFF) bucketed by the shader's own depth.
//                             MUST be monotone increasing with depth.
//
// Why an A/B and not "look at the picture": the haze contribution is the only
// thing that isolates the aerial-perspective term from albedo, lighting and the
// post grade. Fog is switched off by pushing near/far past the far plane rather
// than by nulling scene.fog, so no shader recompiles and the two frames differ
// in exactly one uniform pair.
(function () {
  const E = () => window.BV.engine;
  const TILE = 8, N = 80;

  // ---- frame capture --------------------------------------------------------
  // engine.render() re-derives fog.near/far from camDist every frame, so an A/B
  // has to composite WITHOUT it. post.render() is the exact same scene pass.
  function compose() {
    const e = E();
    e._post.render(0.016, e._ctx);
  }
  function snap(renderFn) {
    const e = E();
    const cv = e.renderer.domElement;
    (renderFn || compose)();
    const w = cv.width, h = cv.height;
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g = c2.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0);
    return { d: g.getImageData(0, 0, w, h).data, w, h };
  }

  // ---- per-fragment distance, straight out of the terrain shader ------------
  // Renders the scene WITHOUT post (post would tonemap/blur the payload) with
  // the terrain material writing a 16-bit value after <dithering_fragment>.
  function dbgDepth(mode, scale) {
    const e = E();
    const t = e._terrain;
    const u = t.uniforms.uDbg.value;
    const old = u.clone();
    u.set(mode == null ? 1 : mode, scale || 2048, 0, 0);
    const s = snap(() => {
      e.renderer.setRenderTarget(null);
      e.renderer.render(e.scene, e.camera);
    });
    u.copy(old);
    const n = s.w * s.h;
    const val = new Float32Array(n);
    const has = new Uint8Array(n);
    const sc = scale || 2048;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      // blue == 0 and alpha == 255 is the debug payload signature; anything the
      // terrain did not draw (sky, buildings, water) has blue > 0 in practice,
      // so cross-check against the geometric terrain mask below instead.
      val[p] = (s.d[i] + s.d[i + 1] / 255) / 255 * (mode >= 3 ? 1 : sc);
      has[p] = s.d[i + 2] === 0 ? 1 : 0;
    }
    return { val, has, w: s.w, h: s.h, raw: s };
  }

  // ---- masks ---------------------------------------------------------------
  function withHidden(objs, fn) {
    const saved = [];
    for (const o of objs) if (o) { saved.push([o, o.visible]); o.visible = false; }
    try { return fn(); } finally { for (const [o, v] of saved) o.visible = v; }
  }

  // "This pixel is terrain ground" — differencing renders identifies it by
  // geometry rather than by guessing a colour threshold.
  function terrainMask(thresh) {
    const e = E();
    thresh = thresh || 6;
    const A = snap();
    const T = withHidden([e._terrain.group], () => snap());
    const W = withHidden([e._water.group], () => snap());
    const n = A.w * A.h;
    const m = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const dt = Math.abs(A.d[i] - T.d[i]) + Math.abs(A.d[i + 1] - T.d[i + 1]) +
                 Math.abs(A.d[i + 2] - T.d[i + 2]);
      const dw = Math.abs(A.d[i] - W.d[i]) + Math.abs(A.d[i + 1] - W.d[i + 1]) +
                 Math.abs(A.d[i + 2] - W.d[i + 2]);
      m[p] = (dt > thresh && dw <= thresh) ? 1 : 0;
    }
    return { m, w: A.w, h: A.h };
  }

  // Grass = terrain pixel whose ground-plane hit lands on a GRASS tile with no
  // occupant and no road/sand/water within 1 tile.
  function grassMask(thresh) {
    const e = E(), cam = e.camera, st = window.BV.sim.state;
    const tm = terrainMask(thresh);
    const w = tm.w, h = tm.h, m = tm.m;
    const out = new Uint8Array(w * h);
    const o = cam.position;
    const inv = cam.matrixWorldInverse;
    const dir = new (window.THREE_V3 || Object)();
    const V3 = e.camera.position.constructor;
    const v = new V3();
    const depth = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!m[p]) continue;
        v.set((x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h * 2, 0.5).unproject(cam);
        v.sub(o).normalize();
        if (v.y >= -1e-6) continue;
        const t = -o.y / v.y;
        const wx = o.x + v.x * t, wz = o.z + v.z * t;
        const tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
        if (tx < 1 || tz < 1 || tx >= N - 1 || tz >= N - 1) continue;
        let ok = true;
        for (let dz = -1; dz <= 1 && ok; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i2 = (tz + dz) * N + (tx + dx);
            if (st.map[i2] !== 0 || (st.occ && st.occ[i2])) { ok = false; break; }
          }
        }
        if (!ok) continue;
        out[p] = 1;
        depth[p] = -(inv.elements[2] * wx + inv.elements[6] * 0 +
                     inv.elements[10] * wz + inv.elements[14]);
      }
    }
    return { m: out, depth, w, h };
  }

  // ---- the A/B -------------------------------------------------------------
  function setDof(off) {
    const e = E();
    if (!e._post) return;
    const d = e._sDist;
    e._post.setParams({
      dof: off
        ? { autoFocus: false, focus: d * 0.95, range: d * 1.2, strength: 0, maxBlur: 0 }
        : { autoFocus: false, focus: d * 0.95, range: d * 1.2, strength: 1.0, maxBlur: 0.85 },
    });
  }

  // Buckets default to the depths the reviewer quoted plus a spread either side.
  function ab(opts) {
    opts = opts || {};
    const e = E();
    const edges = opts.edges || [180, 250, 320, 400, 480, 570, 680, 820, 1000];
    setDof(opts.dof === true ? false : true);
    e.render(0.016);                       // settle: this also re-derives the fog
    // Optional override so an old engine.js fog range can be reproduced.
    if (opts.near != null) e.scene.fog.near = opts.near;
    if (opts.far != null) e.scene.fog.far = opts.far;
    const nearF = e.scene.fog.near, farF = e.scene.fog.far;

    // Shader-truth depth per pixel (mode 1 = vFogDepth).
    const dz = dbgDepth(1, 2048);
    const gm = grassMask(opts.thresh);

    // A: fog as configured. B: fog pushed past the far plane -> factor == 0
    // everywhere, which also zeroes the horizon lift (it is ramped on fogT).
    const A = snap();
    e.scene.fog.near = 1e7; e.scene.fog.far = 1e7 + 1;
    const B = snap();
    e.scene.fog.near = nearF; e.scene.fog.far = farF;

    const nb = edges.length - 1;
    const acc = [];
    for (let k = 0; k < nb; k++) acc.push({ n: 0, dr: 0, dg: 0, db: 0, dl: 0, a: 0, b: 0, dsum: 0 });
    let used = 0, mism = 0;
    for (let p = 0; p < gm.w * gm.h; p++) {
      if (!gm.m[p]) continue;
      const d = dz.val[p];
      if (!(d > 0)) continue;
      // Reject pixels where the shader's own depth disagrees with the
      // ground-plane prediction: those are banks, props or AA-blended edges.
      if (Math.abs(d - gm.depth[p]) > 12) { mism++; continue; }
      let k = -1;
      for (let j = 0; j < nb; j++) if (d >= edges[j] && d < edges[j + 1]) { k = j; break; }
      if (k < 0) continue;
      const i = p * 4;
      const ar = A.d[i], ag = A.d[i + 1], ab2 = A.d[i + 2];
      const br = B.d[i], bg = B.d[i + 1], bb = B.d[i + 2];
      const q = acc[k];
      q.n++; q.dsum += d;
      q.dr += ar - br; q.dg += ag - bg; q.db += ab2 - bb;
      q.dl += (0.299 * ar + 0.587 * ag + 0.114 * ab2) -
              (0.299 * br + 0.587 * bg + 0.114 * bb);
      q.a += 0.299 * ar + 0.587 * ag + 0.114 * ab2;
      q.b += 0.299 * br + 0.587 * bg + 0.114 * bb;
      used++;
    }
    const rows = [];
    for (let k = 0; k < nb; k++) {
      const q = acc[k];
      if (q.n < 60) continue;
      rows.push({
        band: edges[k] + '-' + edges[k + 1],
        depth: +(q.dsum / q.n).toFixed(0),
        px: q.n,
        haze: +(q.dl / q.n).toFixed(2),
        dRGB: [+(q.dr / q.n).toFixed(2), +(q.dg / q.n).toFixed(2), +(q.db / q.n).toFixed(2)],
        fogOff: +(q.b / q.n).toFixed(1),
        fogOn: +(q.a / q.n).toFixed(1),
      });
    }
    let mono = true;
    for (let k = 1; k < rows.length; k++) if (rows[k].haze < rows[k - 1].haze - 0.02) mono = false;
    return {
      fog: { near: +nearF.toFixed(0), far: +farF.toFixed(0), color: e.scene.fog.color.getHexString() },
      dof: opts.dof === true ? 'pinned' : 'off',
      grassPx: used, rejectedDepthMismatch: mism,
      monotoneIncreasing: mono,
      bands: rows,
    };
  }

  // Saturation of the grass by depth band, from the composited frame.
  function satByDepth(opts) {
    opts = opts || {};
    const e = E();
    const edges = opts.edges || [180, 250, 320, 400, 480, 570, 680, 820, 1000];
    setDof(opts.dof === true ? false : true);
    e.render(0.016);
    const dz = dbgDepth(1, 2048);
    const gm = grassMask(opts.thresh);
    const A = snap();
    const nb = edges.length - 1;
    const acc = [];
    for (let k = 0; k < nb; k++) acc.push({ n: 0, r: 0, g: 0, b: 0, d: 0 });
    for (let p = 0; p < gm.w * gm.h; p++) {
      if (!gm.m[p] || !(dz.val[p] > 0)) continue;
      if (Math.abs(dz.val[p] - gm.depth[p]) > 12) continue;
      let k = -1;
      for (let j = 0; j < nb; j++) if (dz.val[p] >= edges[j] && dz.val[p] < edges[j + 1]) { k = j; break; }
      if (k < 0) continue;
      const i = p * 4, q = acc[k];
      q.n++; q.r += A.d[i]; q.g += A.d[i + 1]; q.b += A.d[i + 2]; q.d += dz.val[p];
    }
    return acc.map((q, k) => {
      if (q.n < 60) return null;
      const r = q.r / q.n, g = q.g / q.n, b = q.b / q.n;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let hue = 0; const df = mx - mn;
      if (df > 0) {
        if (mx === r) hue = 60 * (((g - b) / df) % 6);
        else if (mx === g) hue = 60 * ((b - r) / df + 2);
        else hue = 60 * ((r - g) / df + 4);
        if (hue < 0) hue += 360;
      }
      return {
        band: edges[k] + '-' + edges[k + 1], depth: +(q.d / q.n).toFixed(0), px: q.n,
        mean: [+r.toFixed(1), +g.toFixed(1), +b.toFixed(1)],
        sat: +(mx > 0 ? df / mx : 0).toFixed(3), hue: +hue.toFixed(1),
      };
    }).filter(Boolean);
  }

  // Paint the shader's own depth as a visible ramp on screen (dev eyeball).
  function show(mode, scale) {
    const e = E();
    const u = e._terrain.uniforms.uDbg.value;
    if (mode === 0) { u.set(0, 2048, 0, 0); e.render(0.016); return 'off'; }
    u.set(mode || 1, scale || 1200, 0, 0);
    e.renderer.setRenderTarget(null);
    e.renderer.render(e.scene, e.camera);
    return { mode: mode || 1, scale: scale || 1200, note: 'R = high byte of value/scale' };
  }

  // ---- distant-skirt detail probe ------------------------------------------
  // Picks N patches that are certainly ON the far skirt (terrain whose own
  // shader-reported depth is inside `band`), then runs BVHZ.acf on each. Rects
  // are derived from the live canvas so the numbers do not silently become
  // "measured the black outside the canvas" when the pane is resized.
  function skirtPatches(opts) {
    opts = opts || {};
    const e = E();
    const band = opts.band || [850, 1800];
    const S = opts.size || 96;
    const dz = dbgDepth(1, 4096);
    const tm = terrainMask();
    const W = tm.w, H = tm.h;
    const rows = [];
    for (let y = 0; y < H - S; y += 8) {
      let n = 0, s = 0;
      for (let x = 0; x < W; x += 4) {
        const p = y * W + x;
        if (tm.m[p] && dz.val[p] > 0) { n++; s += dz.val[p]; }
      }
      if (n > W / 16) {
        const d = s / n;
        if (d >= band[0] && d <= band[1]) rows.push(y);
      }
    }
    if (!rows.length) return { error: 'no skirt rows found in band ' + band };
    const ys = [rows[Math.floor(rows.length * 0.25)], rows[Math.floor(rows.length * 0.6)]];
    const xs = [Math.round(W * 0.18), Math.round(W * 0.5) - S / 2, Math.round(W * 0.82) - S];
    const rects = [];
    for (const y of ys) for (const x of xs) {
      if (x >= 0 && y >= 0 && x + S <= W && y + S <= H) rects.push({ x, y, w: S, h: S });
    }
    return { rects, rowsFound: rows.length, depthBand: band, canvas: [W, H] };
  }

  // Full before/after on the same frame. uDbg.z flips the screen-locked layer
  // back to its previous world-isotropic, un-haze-compensated form.
  function skirtDetail(opts) {
    const e = E();
    const sp = skirtPatches(opts);
    if (sp.error) return sp;
    const u = e._terrain.uniforms.uDbg.value;
    const run = (legacy) => {
      u.set(0, 2048, legacy ? 1 : 0, 0);
      e.render(0.016);
      const a = sp.rects.map((r) => window.BVHZ.acf(r));
      const mean = (f) => +(a.reduce((s, v) => s + f(v), 0) / a.length).toFixed(3);
      return {
        residualPct: mean((v) => v.residualPct),
        lumaMean: mean((v) => v.lumaMean),
        acfX: mean((v) => v.x[0]), acfY: mean((v) => v.y[0]),
        yOverX: mean((v) => v.y[0] / Math.max(1e-3, v.x[0])),
        per: a.map((v) => [v.residualPct, +(v.y[0] / Math.max(1e-3, v.x[0])).toFixed(2)]),
      };
    };
    const before = run(true), after = run(false);
    u.set(0, 2048, 0, 0);
    e.render(0.016);
    return { patches: sp.rects.length, canvas: sp.canvas, depthBand: sp.depthBand, before, after };
  }

  window.BVFOG = { ab, satByDepth, dbgDepth, grassMask, terrainMask, show, snap, setDof,
                   skirtPatches, skirtDetail };
  return 'BVFOG ready';
})();
