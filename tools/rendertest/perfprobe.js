// Dev-only frame profiler. Load after BVBOOT (shoot.mjs --eval), then:
//
//   await BVPERF({ frames: 40 })
//     -> { ms, cpuMs, gpu: {label: ms}, tris, calls, sceneTris, ... }
//
// `ms`    wall time per engine.render() with a GPU sync after each frame
//         (1-px readPixels), i.e. true CPU+GPU frame cost, NOT vsync-capped.
// `cpuMs` JS time inside engine.render() (submission only, GPU pipelined).
// `gpu`   per-pass GPU time from EXT_disjoint_timer_query_webgl2 (one query
//         per renderer.render() call, labelled by what it draws). Falls back to
//         sync-bracketed wall time per pass when the extension is missing.
// `life`  CPU ms per life.update() (cars/people) at the current camera.
//
// Never imported by src/.
window.BVPERF = async function BVPERF(opts = {}) {
  const e = BV.engine, r = e.renderer, gl = r.getContext();
  const N = opts.frames || 40;
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
  const post = e._post, L = e._lighting;

  // Label a renderer.render(scene, camera) call.
  const matName = (m) => {
    for (const k in post) if (post[k] === m && k[0] === 'm') return k.slice(1);
    return m && (m.name || m.type) || '?';
  };
  const label = (scene, cam) => {
    if (scene === e.scene) {
      const ov = scene.overrideMaterial;
      if (!ov) return 'scene';
      if (ov === L._depthMat) return 'shadow';
      return 'worldAO';
    }
    if (post && scene === post._fsScene) return 'post:' + matName(post._fsMesh.material);
    if (L && scene === L._aoQuadScene) return 'worldAO';
    return 'other';
  };

  // Warm up (shader compiles, target allocs).
  for (let i = 0; i < 6; i++) e.render(1 / 60);
  sync();

  // 1. Whole-frame wall time, synced.
  let t0 = performance.now();
  for (let i = 0; i < N; i++) { e.render(1 / 60); sync(); }
  const ms = (performance.now() - t0) / N;

  // 2. CPU submission time (no sync inside the loop), and PIPELINED frame
  // time: N frames back to back with one sync at the end, i.e. CPU and GPU
  // overlapping as they do under rAF (the synced `ms` above serialises them).
  let cpu = 0;
  t0 = performance.now();
  for (let i = 0; i < N; i++) { const a = performance.now(); e.render(1 / 60); cpu += performance.now() - a; }
  sync();
  const pipeMs = (performance.now() - t0) / N;
  const cpuMs = cpu / N;

  // 3. Per-pass GPU time.
  // ANGLE-on-Metal timer queries measured nonsense (sum of passes 4x the
  // synced wall time), so sync-bracketing is the default; opts.timer opts in.
  const ext = opts.timer ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const orig = r.render.bind(r);
  const acc = {}, cnt = {};
  const pending = [];
  const M = Math.min(N, 20);
  if (ext) {
    r.render = (scene, cam) => {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      orig(scene, cam);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push([label(scene, cam), q]);
    };
    try { for (let i = 0; i < M; i++) e.render(1 / 60); } finally { r.render = orig; }
    sync();
    for (let tries = 0; tries < 60 && pending.length; tries++) {
      await raf();
      while (pending.length) {
        const [lab, q] = pending[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          acc[lab] = (acc[lab] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          cnt[lab] = (cnt[lab] || 0) + 1;
        }
        gl.deleteQuery(q); pending.shift();
      }
    }
  } else {
    // gl.finish() + a readback: a readback alone let ANGLE/Metal defer the
    // scene pass into whichever pass first sampled its target.
    const fin = () => { gl.finish(); sync(); };
    r.render = (scene, cam) => {
      fin(); const a = performance.now();
      orig(scene, cam); fin();
      const lab = label(scene, cam);
      acc[lab] = (acc[lab] || 0) + performance.now() - a;
      cnt[lab] = (cnt[lab] || 0) + 1;
    };
    try { for (let i = 0; i < M; i++) e.render(1 / 60); } finally { r.render = orig; }
  }
  const gpu = {}; let gpuSum = 0;
  for (const k of Object.keys(acc).sort((a, b) => acc[b] - acc[a])) {
    gpu[k] = +(acc[k] / M).toFixed(3); gpuSum += acc[k] / M;
    if (cnt[k] / M > 1.01) gpu[k + ' (n/frame)'] = +(cnt[k] / M).toFixed(1);
  }

  // 4. Triangles / calls for one whole frame, and for the scene pass alone.
  r.info.autoReset = false; r.info.reset();
  e.render(1 / 60);
  const tris = r.info.render.triangles, calls = r.info.render.calls;
  r.info.reset();
  r.setRenderTarget(post.rtScene); orig(e.scene, e.camera); r.setRenderTarget(null);
  const sceneTris = r.info.render.triangles, sceneCalls = r.info.render.calls;
  r.info.reset(); r.info.autoReset = true;

  // 5. life.js CPU cost.
  let lifeMs = null;
  try {
    const life = BV.life, sim = BV.sim;
    const g = sim.roadGraph();
    const a = performance.now();
    for (let i = 0; i < 30; i++) life.update(1 / 60, sim.state, g);
    lifeMs = +((performance.now() - a) / 30).toFixed(3);
  } catch (err) { lifeMs = 'ERR ' + err.message; }

  return {
    ms: +ms.toFixed(2), pipeMs: +pipeMs.toFixed(2), cpuMs: +cpuMs.toFixed(2), gpuSum: +gpuSum.toFixed(2), timer: !!ext,
    gpu, tris, calls, sceneTris, sceneCalls, lifeMs,
    buf: [gl.drawingBufferWidth, gl.drawingBufferHeight], ss: post._ss, internal: [post._iw, post._ih],
    quality: e._quality, camDist: +e._sDist.toFixed(1),
  };
};

// Synced ms per frame only (cheap; for A/B toggles):
//   await BVMS(30)
window.BVMS = function BVMS(n = 30) {
  const e = BV.engine, gl = e.renderer.getContext(), px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (let i = 0; i < 4; i++) e.render(1 / 60);
  sync();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { e.render(1 / 60); sync(); }
  return +((performance.now() - t0) / n).toFixed(2);
};

// Pipelined ms per frame (one sync at the end; see BVPERF pipeMs).
window.BVPIPE = function BVPIPE(n = 60) {
  const e = BV.engine, gl = e.renderer.getContext(), px = new Uint8Array(4);
  for (let i = 0; i < 4; i++) e.render(1 / 60);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) e.render(1 / 60);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return +((performance.now() - t0) / n).toFixed(2);
};

// A/B a list of [name, applyFn, revertFn] toggles against the current state:
//   BVAB([['noSSAO', () => P.setParams({ssao:{enabled:false}}), () => ...]])
window.BVAB = function BVAB(list, n = 30) {
  const out = { base: BVMS(n) };
  for (const [name, on, off] of list) {
    on(); out[name] = BVMS(n); off();
  }
  out.base2 = BVMS(n);
  return out;
};

// CPU ms per engine.render() sub-step (no GPU sync; GPU work is pipelined).
//   BVCPU(60) -> { 'lighting.update': ms, 'post.render': ms, ... }
window.BVCPU = function BVCPU(n = 60) {
  const e = BV.engine, gl = e.renderer.getContext(), px = new Uint8Array(4);
  const acc = {};
  const wraps = [];
  const wrap = (obj, key, label) => {
    if (!obj || typeof obj[key] !== 'function') return;
    const f = obj[key];
    wraps.push([obj, key, f]);
    obj[key] = function (...a) {
      const t = performance.now();
      try { return f.apply(this, a); } finally { acc[label] = (acc[label] || 0) + performance.now() - t; }
    };
  };
  wrap(e._sky, 'update', 'sky.update');
  wrap(e._lighting, '_renderCascades', 'lighting.cascades');
  wrap(e._lighting, '_aoUpdate', 'lighting.worldAO');
  wrap(e._lighting, 'update', 'lighting.update(total)');
  wrap(e._propFX, 'update', 'props.update');
  wrap(e._terrain, 'update', 'terrain.update');
  wrap(e._roads, 'update', 'roads.update');
  wrap(e._water, 'update', 'water.update');
  wrap(e._matLib, 'update', 'materials.update');
  wrap(e, '_syncWindowGlows', 'windowGlows');
  wrap(e, '_applySkyLighting', 'applySky');
  wrap(e._post, 'render', 'post.render');
  wrap(e, 'render', 'engine.render(total)');
  let life = 0, sim = 0;
  try {
    for (let i = 0; i < n; i++) {
      let t = performance.now();
      BV.life.update(1 / 60, BV.sim.state, BV.sim.roadGraph());
      life += performance.now() - t;
      e.render(1 / 60);
      // Drain the GPU between frames so no sub-step is billed for a stall on
      // the previous frame's work (pure CPU cost).
      gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
  } finally { for (const [o, k, f] of wraps) o[k] = f; }
  const out = { 'life.update': +(life / n).toFixed(3) };
  for (const k in acc) out[k] = +(acc[k] / n).toFixed(3);
  return out;
};

// Shader bisection: patch the voxel material's final fragment source with
// fn(src) (e.g. early-out a block) and recompile; BVUNPATCHV() restores.
window.BVPATCHV = (tag, fn) => {
  const E = BV.engine, m = E._voxMat;
  if (!E.__ob) { E.__ob = m.onBeforeCompile; E.__ck = m.customProgramCacheKey; }
  m.onBeforeCompile = (sh, r) => { E.__ob(sh, r); sh.fragmentShader = fn(sh.fragmentShader); };
  m.customProgramCacheKey = () => E.__ck() + tag;
  m.needsUpdate = true;
};
window.BVUNPATCHV = () => {
  const E = BV.engine, m = E._voxMat;
  m.onBeforeCompile = E.__ob; m.customProgramCacheKey = E.__ck; m.needsUpdate = true;
};
