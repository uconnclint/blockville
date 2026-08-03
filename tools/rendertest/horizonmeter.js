// Dev-only measurement harness for (a) the horizon aerial-perspective seam and
// (b) the land/water shoreline silhouette. Paste/eval into the game page after
// BVBOOT(). Never imported by src/.
//
//   BVHZ.profile()      -> horizon luminance profile: sky vs land across the
//                          skyline, from the COMPOSITED canvas (post included)
//   BVHZ.column(x)      -> raw per-row luminance dump for one screen column
//   BVHZ.shore()        -> world-space shoreline silhouette metrics
//
// The horizon row is found by differencing two renders (terrain visible /
// terrain hidden) so "land" and "sky" are identified by geometry, not by
// guessing a threshold on colour.
(function () {
  const E = () => window.BV.engine;

  // Composited backing pixels of a rect (post included), as ImageData.
  function px(rect) {
    const e = E();
    const cv = e.renderer.domElement;
    e.render(0.016);
    const w = cv.width, h = cv.height;
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g = c2.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0);
    const r = rect || { x: (w >> 1) - 96, y: (h >> 1) - 96, w: 192, h: 192 };
    return g.getImageData(r.x, r.y, r.w, r.h);
  }

  function grab() {
    const e = E();
    const cv = e.renderer.domElement;
    e.render(0.016);                       // no preserveDrawingBuffer
    const w = cv.width, h = cv.height;
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g = c2.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0);
    return { d: g.getImageData(0, 0, w, h).data, w, h };
  }

  function withHidden(groups, fn) {
    const saved = [];
    for (const g of groups) if (g) { saved.push([g, g.visible]); g.visible = false; }
    try { return fn(); } finally { for (const [g, v] of saved) g.visible = v; }
  }

  const L = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  function capture() {
    const e = E();
    const terr = e._terrain && e._terrain.group;
    const wat = e._water && e._water.group;
    const A = grab();
    const T = withHidden([terr], grab);
    const W = withHidden([wat], grab);
    return { A, T, W };
  }

  // Per-pixel "is terrain" / "is water" masks from the render diffs.
  function masks(cap, thresh) {
    thresh = thresh || 6;
    const { A, T, W } = cap;
    const n = A.w * A.h;
    const isT = new Uint8Array(n), isW = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      let dt = Math.abs(A.d[i] - T.d[i]) + Math.abs(A.d[i + 1] - T.d[i + 1]) + Math.abs(A.d[i + 2] - T.d[i + 2]);
      let dw = Math.abs(A.d[i] - W.d[i]) + Math.abs(A.d[i + 1] - W.d[i + 1]) + Math.abs(A.d[i + 2] - W.d[i + 2]);
      if (dt > thresh) isT[p] = 1;
      if (dw > thresh) isW[p] = 1;
    }
    return { isT, isW };
  }

  // Luminance immediately above (sky) and below (land) the skyline, per column.
  function profile(opts) {
    opts = opts || {};
    const gap = opts.gap || 2;        // rows skipped either side of the edge (AA)
    const span = opts.span || 10;     // rows averaged on each side
    const cap = capture();
    const { A } = cap;
    const { isT, isW } = masks(cap, opts.thresh);
    const cols = [];
    const step = Math.max(1, Math.round(A.w / (opts.columns || 24)));
    for (let x = step >> 1; x < A.w; x += step) {
      // topmost terrain pixel with a clear run of sky above it
      let hr = -1;
      for (let y = 1; y < A.h - span - gap; y++) {
        if (!isT[y * A.w + x]) continue;
        let solid = true;
        for (let k = 1; k <= 4; k++) if (!isT[(y + k) * A.w + x]) { solid = false; break; }
        if (!solid) continue;
        let clear = true;
        for (let k = 1; k <= gap + span; k++) {
          const yy = y - k;
          if (yy < 0) { clear = false; break; }
          if (isT[yy * A.w + x] || isW[yy * A.w + x]) { clear = false; break; }
        }
        if (!clear) continue;
        hr = y; break;
      }
      if (hr < 0 || hr + gap + span >= A.h) continue;
      let sky = 0, land = 0, wet = 0;
      for (let k = gap; k < gap + span; k++) {
        sky += L(A.d, ((hr - k) * A.w + x) * 4);
        land += L(A.d, ((hr + k) * A.w + x) * 4);
        if (isW[(hr + k) * A.w + x]) wet++;
      }
      cols.push({
        x, row: hr,
        sky: +(sky / span).toFixed(1),
        land: +(land / span).toFixed(1),
        drop: +((land - sky) / span * 0 + (land / span) - (sky / span)).toFixed(1),
        water: wet,
      });
    }
    const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
    const dry = cols.filter((c) => c.water === 0);
    const use = dry.length >= 4 ? dry : cols;
    const agg = (list) => ({
      n: list.length,
      skyMedian: +med(list.map((c) => c.sky)).toFixed(1),
      landMedian: +med(list.map((c) => c.land)).toFixed(1),
      dropMedian: +med(list.map((c) => c.land - c.sky)).toFixed(1),
      ratioMedian: +(med(list.map((c) => c.land / Math.max(1, c.sky)))).toFixed(3),
    });
    // The TRUE horizon is the highest skyline in the frame; nearer hills,
    // mountains and rooftops also produce a top-of-terrain row and would
    // otherwise dilute the measurement with mid-distance land.
    const band = opts.band || 45;
    const minRow = use.reduce((m, c) => Math.min(m, c.row), 1e9);
    const far = use.filter((c) => c.row <= minRow + band);
    return Object.assign({ canvas: [A.w, A.h], columns: cols, landOnly: dry.length },
      agg(use), { far: agg(far), farRowBand: [minRow, minRow + band] });
  }

  // Raw luminance dump across the skyline for one column.
  function column(x, radius) {
    radius = radius || 18;
    const cap = capture();
    const { A } = cap;
    const { isT, isW } = masks(cap);
    if (x == null) x = A.w >> 1;
    let hr = -1;
    for (let y = 1; y < A.h - 8; y++) {
      if (isT[y * A.w + x] && isT[(y + 3) * A.w + x]) { hr = y; break; }
    }
    const rows = [];
    for (let k = -radius; k <= radius; k++) {
      const y = hr + k;
      if (y < 0 || y >= A.h) continue;
      const p = y * A.w + x;
      rows.push({ dy: k, lum: +L(A.d, p * 4).toFixed(1), t: isT[p], w: isW[p] });
    }
    return { x, horizonRow: hr, rows };
  }

  // How dark the vertical shore BANK renders. Scans down each column to the
  // first water pixel; the terrain pixels immediately above it are the bank
  // face, and the terrain 10-20 rows above that is the dry beach it should be
  // reading as a shaded part of, not as a black outline.
  function bank(opts) {
    opts = opts || {};
    const rim = opts.rim || 6, off = opts.off || 12, span = opts.span || 10;
    const cap = capture();
    const { A } = cap;
    const { isT, isW } = masks(cap, opts.thresh);
    const mins = [], sands = [];
    const step = Math.max(1, Math.round(A.w / (opts.columns || 60)));
    for (let x = step >> 1; x < A.w; x += step) {
      let wr = -1;
      for (let y = off + span + 2; y < A.h - 2; y++) {
        if (isW[y * A.w + x] && isW[(y + 2) * A.w + x]) { wr = y; break; }
      }
      if (wr < 0) continue;
      let ok = true, mn = 1e9;
      for (let k = 1; k <= rim; k++) {
        const p = (wr - k) * A.w + x;
        if (!isT[p]) { ok = false; break; }
        mn = Math.min(mn, L(A.d, p * 4));
      }
      if (!ok) continue;
      let s = 0, n = 0;
      for (let k = off; k < off + span; k++) {
        const p = (wr - k) * A.w + x;
        if (!isT[p]) { n = 0; break; }
        s += L(A.d, p * 4); n++;
      }
      if (!n) continue;
      mins.push(mn); sands.push(s / n);
    }
    const med = (a) => { const q = a.slice().sort((p, r) => p - r); return q.length ? q[q.length >> 1] : 0; };
    const pct = (a, f) => { const q = a.slice().sort((p, r) => p - r); return q.length ? q[Math.min(q.length - 1, Math.floor(q.length * f))] : 0; };
    // The rim is only visible on the shores that FACE the camera, so the
    // interesting statistic is the dark tail, not the median.
    return {
      samples: mins.length,
      bankP10: +pct(mins, 0.10).toFixed(1),
      bankP25: +pct(mins, 0.25).toFixed(1),
      bankMinMedian: +med(mins).toFixed(1),
      bankDarkest: +Math.min.apply(null, mins.length ? mins : [0]).toFixed(1),
      beachMedian: +med(sands).toFixed(1),
      ratioP10: +(pct(mins, 0.10) / Math.max(1, med(sands))).toFixed(3),
    };
  }

  // High-frequency detail probe. Takes a device-pixel rect, high-passes it
  // (luma minus a box blur) and reports the residual sigma plus the normalised
  // autocorrelation at lags 1..3 along screen x and y. Isotropic turf should
  // give similar x and y curves; a horizontally smeared one gives high x and
  // ~0 y, which is the signature the reviewer measured.
  function acf(rect, blur) {
    blur = blur || 9;
    const img = px(rect);
    const w = img.width, h = img.height, d = img.data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    // separable box blur
    const r = blur >> 1;
    const tmp = new Float32Array(w * h), lo = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; s += lum[y * w + xx]; n++; }
        tmp[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; s += tmp[yy * w + x]; n++; }
        lo[y * w + x] = s / n;
      }
    }
    const e = new Float32Array(w * h);
    let mean = 0;
    for (let i = 0; i < w * h; i++) { e[i] = lum[i] - lo[i]; mean += e[i]; }
    mean /= w * h;
    let v = 0;
    for (let i = 0; i < w * h; i++) { e[i] -= mean; v += e[i] * e[i]; }
    v /= w * h;
    const lag = (dx, dy) => {
      let s = 0, n = 0;
      for (let y = 0; y < h - dy; y++) {
        for (let x = 0; x < w - dx; x++) { s += e[y * w + x] * e[(y + dy) * w + (x + dx)]; n++; }
      }
      return v > 1e-9 ? +(s / n / v).toFixed(3) : 0;
    };
    let lm = 0;
    for (let i = 0; i < w * h; i++) lm += lum[i];
    lm /= w * h;
    return {
      rect: [w, h],
      lumaMean: +lm.toFixed(1),
      residualSigma: +Math.sqrt(v).toFixed(2),
      residualPct: +(100 * Math.sqrt(v) / Math.max(1e-3, lm)).toFixed(2),
      x: [lag(1, 0), lag(2, 0), lag(3, 0)],
      y: [lag(0, 1), lag(0, 2), lag(0, 3)],
    };
  }

  // ---- shoreline silhouette (world space, from the terrain module) ---------
  // Walks every land tile edge that faces water and emits the bank's top edge
  // as it is actually built (i.e. through terrain._warp). Reports how much of
  // that silhouette is still locked to the axis-aligned tile grid.
  function shore() {
    const e = E();
    const t = e._terrain;
    const st = window.BV.sim.state;
    const N = 80, TILE = 8;
    const cls = t._cls;
    const isW = (x, z) => (x < 0 || z < 0 || x >= N || z >= N) ? false : cls[z * N + x] === 4;
    const segs = [];
    const p = [0, 0], q = [0, 0];
    const S = t.sub;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (cls[z * N + x] === 4) continue;
        const wx0 = x * TILE, wx1 = wx0 + TILE, wz0 = z * TILE, wz1 = wz0 + TILE;
        const sides = [];
        if (isW(x + 1, z)) sides.push([wx1, wz1, wx1, wz0]);
        if (isW(x - 1, z)) sides.push([wx0, wz0, wx0, wz1]);
        if (isW(x, z - 1)) sides.push([wx1, wz0, wx0, wz0]);
        if (isW(x, z + 1)) sides.push([wx0, wz1, wx1, wz1]);
        for (const [ax, az, bx, bz] of sides) {
          for (let k = 0; k < S; k++) {
            const f0 = k / S, f1 = (k + 1) / S;
            t._warp ? t._warp(ax + (bx - ax) * f0, az + (bz - az) * f0, p)
                    : (p[0] = ax + (bx - ax) * f0, p[1] = az + (bz - az) * f0);
            t._warp ? t._warp(ax + (bx - ax) * f1, az + (bz - az) * f1, q)
                    : (q[0] = ax + (bx - ax) * f1, q[1] = az + (bz - az) * f1);
            segs.push([p[0], p[1], q[0], q[1]]);
          }
        }
      }
    }
    let axis = 0, len = 0, offGrid = 0, maxOff = 0;
    for (const [ax, az, bx, bz] of segs) {
      const dx = bx - ax, dz = bz - az;
      const l = Math.hypot(dx, dz);
      len += l;
      const ang = Math.abs(Math.atan2(dz, dx) * 180 / Math.PI) % 90;
      const off = Math.min(ang, 90 - ang);
      if (off < 1.0) axis++;
      // distance of the midpoint from the nearest tile-grid line
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      const gx = Math.abs(mx / TILE - Math.round(mx / TILE)) * TILE;
      const gz = Math.abs(mz / TILE - Math.round(mz / TILE)) * TILE;
      const d = Math.min(gx, gz);
      offGrid += d; maxOff = Math.max(maxOff, d);
    }
    return {
      segments: segs.length,
      perimeter: +len.toFixed(1),
      axisAlignedPct: +(100 * axis / Math.max(1, segs.length)).toFixed(1),
      meanOffGrid: +(offGrid / Math.max(1, segs.length)).toFixed(2),
      maxOffGrid: +maxOff.toFixed(2),
    };
  }

  window.BVHZ = { profile, column, shore, bank, acf, px, capture, masks };
})();
