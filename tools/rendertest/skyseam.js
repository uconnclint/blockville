// Dev-only measurement harness for the sky horizon seam + sky/fog warmth.
// Paste/eval into the game page after BVBOOT(). Never imported by src/.
//
//   await BVSEAM.curve({az:'sun'|'anti'|deg})
//        -> elevation-vs-radiance curve straight out of the DOME SHADER
//           (own render target, no post, linear half-float). Reports the
//           longest run of rows whose value does not change, and the biggest
//           single-row step.
//   await BVSEAM.column(xCss)
//        -> composited canvas column (post included) with the elevation of
//           every device row, matching how a reviewer measures.
//   await BVSEAM.rb()
//        -> whole-sky mean R/B (composited) + fog / sky colour R/B (linear).
//
// Measure BEFORE loading shadowmeter.js: SM.masks()/SM.pair() contaminate the
// scene.
(function () {
  let TH = null;
  const T = async () => (TH || (TH = await import('/vendor/three.module.js')));
  const E = () => window.BV.engine;

  function h2f(h) {
    const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  const lin2srgb = (v) => {
    v = Math.max(0, Math.min(1, v));
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  const srgb2lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

  // ---------------------------------------------------------------------------
  // (1) Raw dome shader curve — no post, no tonemap, linear.
  // ---------------------------------------------------------------------------
  async function curve(opts) {
    opts = opts || {};
    const th = await T();
    const e = E();
    const sky = e._sky;
    const N = opts.n || 1200;
    const fov = opts.fov != null ? opts.fov : 46;
    const pitch = (opts.pitch != null ? opts.pitch : 17) * Math.PI / 180;

    const sd = sky._sunDir;
    let az;
    if (opts.az === 'anti') az = Math.atan2(-sd.x, -sd.z);
    else if (typeof opts.az === 'number') az = opts.az * Math.PI / 180;
    else az = Math.atan2(sd.x, sd.z);

    const rt = new th.WebGLRenderTarget(4, N, {
      type: th.HalfFloatType, format: th.RGBAFormat,
      colorSpace: th.LinearSRGBColorSpace,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: th.NearestFilter, magFilter: th.NearestFilter,
    });
    const scn = new th.Scene();
    const mesh = new th.Mesh(sky._geo, sky.material);
    mesh.frustumCulled = false;
    mesh.scale.setScalar(10);
    scn.add(mesh);
    const cam = new th.PerspectiveCamera(fov, 4 / N, 0.1, 100);
    cam.position.set(0, 0, 0);
    cam.up.set(0, 1, 0);
    cam.lookAt(Math.cos(pitch) * Math.sin(az), Math.sin(pitch), Math.cos(pitch) * Math.cos(az));
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const r = e.renderer;
    const prevRT = r.getRenderTarget();
    const prevTone = r.toneMapping;
    const prevOut = r.outputColorSpace;
    r.toneMapping = th.NoToneMapping;
    r.setRenderTarget(rt);
    r.clear(true, true, true);
    r.render(scn, cam);
    const buf = new Uint16Array(4 * N * 4);
    r.readRenderTargetPixels(rt, 0, 0, 4, N, buf);
    r.setRenderTarget(prevRT);
    r.toneMapping = prevTone;
    r.outputColorSpace = prevOut;
    rt.dispose();
    scn.remove(mesh);

    // rows come back bottom-up
    const half = Math.tan(fov * Math.PI / 360);
    const rows = [];
    for (let j = 0; j < N; j++) {
      const ny = ((j + 0.5) / N) * 2 - 1;           // -1 bottom .. +1 top
      // direction in camera space, then rotate by pitch about the horizontal axis
      const dyC = half * ny, dzC = -1;
      const len = Math.hypot(dyC, dzC);
      const cy = dyC / len, cz = -dzC / len;        // cz = forward component
      const elev = Math.asin(cy * Math.cos(pitch) + cz * Math.sin(pitch));
      const i = (j * 4 + 1) * 4;                    // sample x=1 of 4
      rows.push({
        elev: elev * 180 / Math.PI,
        r: h2f(buf[i]), g: h2f(buf[i + 1]), b: h2f(buf[i + 2]),
      });
    }
    return analyse(rows, opts);
  }

  // Longest constant run + biggest step, measured on the 8-bit sRGB encoding of
  // the linear value (that is what a reviewer's screenshot sees).
  function analyse(rows, opts) {
    const enc = rows.map((p) => ({
      elev: p.elev,
      R: Math.round(lin2srgb(p.r) * 255),
      G: Math.round(lin2srgb(p.g) * 255),
      B: Math.round(lin2srgb(p.b) * 255),
      lin: p,
    }));
    // Longest run of identical G (the reviewer's channel of choice)
    let bestRun = 0, bestAt = 0, run = 1, runAt = 0;
    let maxStep = 0, stepAt = 0;
    for (let i = 1; i < enc.length; i++) {
      if (enc[i].G === enc[i - 1].G) { run++; } else {
        if (run > bestRun) { bestRun = run; bestAt = runAt; }
        run = 1; runAt = i;
      }
      const d = Math.abs(enc[i].G - enc[i - 1].G);
      if (d > maxStep) { maxStep = d; stepAt = i; }
    }
    if (run > bestRun) { bestRun = run; bestAt = runAt; }
    // Sparse dump, every k-th row
    const k = opts && opts.every ? opts.every : Math.max(1, Math.round(enc.length / 60));
    const dump = [];
    for (let i = 0; i < enc.length; i += k) {
      const p = enc[i];
      dump.push(p.elev.toFixed(2) + ':' + p.R + ',' + p.G + ',' + p.B);
    }
    return {
      n: enc.length,
      degPerRow: +(Math.abs(enc[1].elev - enc[0].elev).toFixed(4)),
      longestFlatRun: bestRun,
      flatRunAtElev: +enc[bestAt].elev.toFixed(2),
      flatRunValue: enc[bestAt].G,
      maxStepG: maxStep,
      maxStepAtElev: +enc[stepAt].elev.toFixed(2),
      dump,
      _enc: enc,
    };
  }

  // Window report: the biggest change over any 5-row window, and the run
  // structure inside an elevation window.
  function window5(res, lo, hi) {
    const e = res._enc.filter((p) => p.elev >= lo && p.elev <= hi);
    const out = [];
    for (const p of e) out.push(p.elev.toFixed(2) + ':' + p.G);
    return out;
  }

  // ---------------------------------------------------------------------------
  // (2) Composited canvas column with per-row elevation.
  // ---------------------------------------------------------------------------
  function grab() {
    const e = E();
    const cv = e.renderer.domElement;
    e.render(0.016);
    const c2 = document.createElement('canvas');
    c2.width = cv.width; c2.height = cv.height;
    const g = c2.getContext('2d', { willReadFrequently: true });
    g.drawImage(cv, 0, 0);
    return { d: g.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
  }

  async function column(xCss, opts) {
    opts = opts || {};
    const th = await T();
    const e = E();
    const cv = e.renderer.domElement;
    const dpr = cv.width / cv.clientWidth;
    const A = grab();
    const x = Math.round((xCss != null ? xCss : cv.clientWidth / 2) * dpr);
    const cam = e.camera;
    const v = new th.Vector3();
    const rows = [];
    for (let y = 0; y < A.h; y++) {
      const ndcx = (x + 0.5) / A.w * 2 - 1;
      const ndcy = 1 - (y + 0.5) / A.h * 2;
      v.set(ndcx, ndcy, 0.5).unproject(cam).sub(cam.position).normalize();
      const i = (y * A.w + x) * 4;
      rows.push({
        yCss: +(y / dpr).toFixed(1), yDev: y,
        elev: +(Math.asin(v.y) * 180 / Math.PI).toFixed(3),
        R: A.d[i], G: A.d[i + 1], B: A.d[i + 2],
      });
    }
    // horizon row = elevation crosses 0
    let hz = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].elev > 0 && rows[i].elev <= 0) { hz = i; break; }
    // longest flat G run above the horizon
    let bestRun = 0, bestAt = 0, run = 1, runAt = 0, maxStep = 0, stepAt = 0;
    for (let i = 1; i < hz; i++) {
      if (rows[i].G === rows[i - 1].G) run++; else { if (run > bestRun) { bestRun = run; bestAt = runAt; } run = 1; runAt = i; }
      const d = Math.abs(rows[i].G - rows[i - 1].G);
      if (d > maxStep) { maxStep = d; stepAt = i; }
    }
    if (run > bestRun) { bestRun = run; bestAt = runAt; }
    const lo = opts.from != null ? opts.from : 0;
    const hiR = opts.to != null ? opts.to : hz;
    const dump = [];
    for (let i = lo; i < Math.min(hiR, rows.length); i++) {
      const p = rows[i];
      dump.push(p.yDev + '|' + p.elev + ':' + p.R + ',' + p.G + ',' + p.B);
    }
    return {
      dpr, w: A.w, h: A.h, horizonRowDev: hz,
      horizonRowCss: +(hz / dpr).toFixed(1),
      longestFlatRunDev: bestRun, flatRunAtDev: bestAt, flatRunAtElev: rows[bestAt] && rows[bestAt].elev,
      flatValue: rows[bestAt] && rows[bestAt].G,
      maxStepG: maxStep, maxStepAtDev: stepAt, maxStepAtElev: rows[stepAt] && rows[stepAt].elev,
      rows, dump,
    };
  }

  // ---------------------------------------------------------------------------
  // (3) Sky / fog R/B
  // ---------------------------------------------------------------------------
  function withHidden(objs, fn) {
    const saved = [];
    for (const o of objs) if (o) { saved.push([o, o.visible]); o.visible = false; }
    try { return fn(); } finally { for (const [o, v] of saved) o.visible = v; }
  }

  function rb(opts) {
    opts = opts || {};
    const e = E();
    const sky = e._sky;
    const A = grab();
    // Sky mask: pixels unchanged when EVERY non-sky root is hidden.
    const roots = [];
    e.scene.traverse((o) => { if (o.parent === e.scene && o !== sky.mesh) roots.push(o); });
    const B = withHidden(roots, grab);
    const thr = opts.thresh != null ? opts.thresh : 4;
    let n = 0, sr = 0, sg = 0, sb = 0, lr = 0, lg = 0, lb = 0, hiG = 0, tot = 0;
    for (let p = 0; p < A.w * A.h; p++) {
      const i = p * 4;
      tot++;
      const d = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]);
      if (d > thr) continue;
      n++;
      sr += A.d[i]; sg += A.d[i + 1]; sb += A.d[i + 2];
      lr += srgb2lin(A.d[i] / 255); lg += srgb2lin(A.d[i + 1] / 255); lb += srgb2lin(A.d[i + 2] / 255);
      if (A.d[i + 1] >= 250) hiG++;
    }
    const f = e.fog.color, s = sky._skyColor, sf = sky._fogColor;
    return {
      skyPixels: n, framePixels: tot,
      skyMeanSRGB: [+(sr / n).toFixed(1), +(sg / n).toFixed(1), +(sb / n).toFixed(1)],
      skyMeanRB_srgb: +((sr / n) / (sb / n)).toFixed(3),
      skyMeanRB_linear: +((lr / n) / (lb / n)).toFixed(3),
      pctSkyG250: +(100 * hiG / n).toFixed(2),
      pctFrameG250: +(100 * hiG / tot).toFixed(2),
      fogHex: '#' + f.getHexString(),
      fogLinearRB: +(sf.r / sf.b).toFixed(3),
      skyColorLinearRB: +(s.r / s.b).toFixed(3),
      skyColorHex: '#' + s.getHexString(),
      sunElevDeg: +(sky._out.sunElevation * 180 / Math.PI).toFixed(2),
      skylightWarmth: sky._out.skylightWarmth,
      nightAmt: +sky._nightAmt.toFixed(3),
    };
  }

  window.BVSEAM = { curve, column, rb, window5, analyse };
})();
