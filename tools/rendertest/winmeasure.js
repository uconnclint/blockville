// tools/rendertest/winmeasure.js — window / facade measurements for
// src/render/materials.js. Dev-only; never imported by src/.
//
// Load with:
//   (0,eval)(await (await fetch('/tools/rendertest/winmeasure.js',{cache:'no-store'})).text());
//   await WM.ready;
//
// Provides window.WM:
//   WM.mask()                 -> {w,h,m:Uint8Array}  building-only silhouette
//   WM.report(shot)           -> the full defect-1/2/3 metric set for one shot
//   WM.emissiveAttribution()  -> how many building pixels the night-emissive
//                                term is responsible for at the current time
//   WM.crop(x,y,w,h)          -> 1:1 device-pixel PNG data URL (chunked getter)
//
// Everything renders synchronously through engine.render(), then reads the
// default framebuffer (falling back to post.js's output mirror when the tab is
// backgrounded — same trick as postmeasure.js).

(function () {
  const WM = {};
  const E = () => window.BV.engine;
  let THREE = null;
  let maskRT = null, mirror = null;

  WM.ready = (async () => { THREE = await import('/vendor/three.module.js'); return true; })();

  // ------------------------------------------------------------------ grab
  function grabMirror(dt) {
    const e = E(), r = e.renderer, p = e._post;
    e.render(dt === undefined ? 0.016 : dt);
    const w = r.domElement.width, h = r.domElement.height;
    if (!mirror || mirror.width !== w || mirror.height !== h) {
      if (mirror) mirror.dispose();
      mirror = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
    }
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    p._blit(p.mOutput, mirror);
    r.autoClear = prevAuto;
    r.setRenderTarget(prevTarget);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(mirror, 0, 0, w, h, px);
    return { w, h, px, mirrored: true };
  }

  WM.grab = function grab(dt) {
    const e = E();
    e.render(dt === undefined ? 0.016 : dt);
    const gl = e.renderer.getContext(), c = e.renderer.domElement;
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    let any = 0;
    for (let i = 0; i < px.length; i += 4004) { any |= px[i]; if (any) break; }
    if (!any) return grabMirror(dt);
    return { w, h, px };
  };

  // ------------------------------------------------------------------ mask
  // Buildings-only silhouette, rendered with a flat white basic material on
  // camera layer 31 so nothing else in the scene can contribute.
  const MASK_LAYER = 31;
  WM.mask = function mask() {
    const e = E(), r = e.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!maskRT || maskRT.width !== w || maskRT.height !== h) {
      if (maskRT) maskRT.dispose();
      maskRT = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      });
    }
    const list = [];
    const src = e._buildings;
    if (src && typeof src.forEach === 'function') src.forEach((m) => { if (m && m.isObject3D) list.push(m); });
    list.forEach((m) => m.traverse((n) => { if (n.isMesh) n.layers.enable(MASK_LAYER); }));

    const cam = e.camera;
    const prevMaskLayer = cam.layers.mask;
    cam.layers.set(MASK_LAYER);
    const prevOverride = e.scene.overrideMaterial;
    const prevBg = e.scene.background, prevFog = e.scene.fog;
    const prevClear = new THREE.Color(); r.getClearColor(prevClear);
    const prevAlpha = r.getClearAlpha();
    e.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    e.scene.background = null; e.scene.fog = null;
    r.setClearColor(0x000000, 1);
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(maskRT);
    r.clear(true, true, false);
    r.render(e.scene, cam);
    r.setRenderTarget(prevTarget);

    e.scene.overrideMaterial.dispose();
    e.scene.overrideMaterial = prevOverride;
    e.scene.background = prevBg; e.scene.fog = prevFog;
    r.setClearColor(prevClear, prevAlpha);
    cam.layers.mask = prevMaskLayer;
    list.forEach((m) => m.traverse((n) => { if (n.isMesh) n.layers.disable(MASK_LAYER); }));

    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(maskRT, 0, 0, w, h, px);
    const m = new Uint8Array(w * h);
    let n = 0;
    for (let i = 0; i < w * h; i++) { const v = px[i * 4] > 127 ? 1 : 0; m[i] = v; n += v; }
    return { w, h, m, n };
  };

  // ------------------------------------------------------------- statistics
  function luma(px, i) {
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  }

  // Local sigma/mean over BLOCK-sized tiles that are (almost) entirely inside
  // the building mask. Returns the distribution over tiles — this is the
  // "within-facade" texture metric.
  function blockStats(g, mk, BLOCK, cover) {
    const out = [];
    for (let by = 0; by + BLOCK <= g.h; by += BLOCK) {
      for (let bx = 0; bx + BLOCK <= g.w; bx += BLOCK) {
        let cnt = 0, s = 0, s2 = 0;
        for (let y = by; y < by + BLOCK; y++) {
          for (let x = bx; x < bx + BLOCK; x++) {
            const idx = y * g.w + x;
            if (!mk.m[idx]) continue;
            const L = luma(g.px, idx * 4);
            cnt++; s += L; s2 += L * L;
          }
        }
        if (cnt < BLOCK * BLOCK * cover) continue;
        const mean = s / cnt;
        const varr = Math.max(0, s2 / cnt - mean * mean);
        if (mean < 4) continue;
        out.push({ bx, by, mean, sd: Math.sqrt(varr), r: Math.sqrt(varr) / mean });
      }
    }
    out.sort((a, b) => a.r - b.r);
    const q = (p) => out.length ? out[Math.min(out.length - 1, Math.floor(p * out.length))].r : 0;
    return {
      tiles: out.length,
      p10: +q(0.10).toFixed(4), median: +q(0.50).toFixed(4), p90: +q(0.90).toFixed(4),
      mean: +(out.reduce((a, b) => a + b.r, 0) / Math.max(1, out.length)).toFixed(4),
      raw: out,
    };
  }

  WM.stats = function stats() {
    const g = WM.grab();
    const mk = WM.mask();
    let hot = 0, s = 0, n = 0, hot230 = 0;
    const hist = new Uint32Array(26);
    for (let i = 0; i < mk.w * mk.h; i++) {
      if (!mk.m[i]) continue;
      const L = luma(g.px, i * 4);
      n++; s += L;
      if (L > 200) hot++;
      if (L > 230) hot230++;
      hist[Math.min(25, L / 10 | 0)]++;
    }
    return {
      buildingPx: n,
      pctBuilding: +(100 * n / (mk.w * mk.h)).toFixed(2),
      meanLuma: +(s / Math.max(1, n)).toFixed(2),
      pctAbove200: +(100 * hot / Math.max(1, n)).toFixed(3),
      pctAbove230: +(100 * hot230 / Math.max(1, n)).toFixed(3),
      block16: blockStats(g, mk, 16, 0.98),
      block32: blockStats(g, mk, 32, 0.98),
      _g: g, _mk: mk,
    };
  };

  // How much of the frame is the night-emissive term responsible for RIGHT NOW?
  // A/B: current uNight vs uNight = 0, same everything else.
  WM.emissiveAttribution = function emissiveAttribution() {
    const e = E();
    const u = e._nightUniform;
    const keep = u.value;
    const a = WM.grab();
    u.value = 0;
    const b = WM.grab();
    u.value = keep;
    const mk = WM.mask();
    let n = 0, changed = 0, big = 0, sum = 0;
    for (let i = 0; i < mk.w * mk.h; i++) {
      if (!mk.m[i]) continue;
      const d = Math.abs(luma(a.px, i * 4) - luma(b.px, i * 4));
      n++; sum += d;
      if (d > 4) changed++;
      if (d > 24) big++;
    }
    return {
      uNight: keep,
      buildingPx: n,
      pctChanged4: +(100 * changed / Math.max(1, n)).toFixed(3),
      pctChanged24: +(100 * big / Math.max(1, n)).toFixed(3),
      meanDelta: +(sum / Math.max(1, n)).toFixed(3),
    };
  };

  // 1:1 device-pixel crop drawn as a pinned overlay (computer{action:"zoom"}
  // is not available in this pane, and a scaled screenshot of the canvas is
  // useless for judging a 5-px window). `scale` is CSS upscale with
  // image-rendering:pixelated, so device pixels stay square and countable.
  WM.overlay = function overlay(x, y, w, h, scale) {
    const g = WM.grab();
    let el = document.getElementById('__wmov');
    if (!el) {
      el = document.createElement('canvas');
      el.id = '__wmov';
      el.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;image-rendering:pixelated;border:2px solid #f0f;background:#000';
      document.body.appendChild(el);
    }
    el.width = w; el.height = h;
    el.style.width = (w * (scale || 1)) + 'px';
    el.style.height = (h * (scale || 1)) + 'px';
    const c = el.getContext('2d');
    const img = c.createImageData(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const sx = x + i, sy = g.h - 1 - (y + j);
      const si = (sy * g.w + sx) * 4, di = (j * w + i) * 4;
      img.data[di] = g.px[si]; img.data[di + 1] = g.px[si + 1];
      img.data[di + 2] = g.px[si + 2]; img.data[di + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    return 'ok';
  };
  WM.overlayOff = function overlayOff() {
    const el = document.getElementById('__wmov');
    if (el) el.remove();
    return 'off';
  };

  // --------------------------------------------------------------- 1:1 crop
  let _cropData = '';
  WM.crop = function crop(x, y, w, h) {
    const g = WM.grab();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const sx = x + i, sy = g.h - 1 - (y + j);      // flip: readPixels is bottom-up
        const si = (sy * g.w + sx) * 4, di = (j * w + i) * 4;
        img.data[di] = g.px[si]; img.data[di + 1] = g.px[si + 1];
        img.data[di + 2] = g.px[si + 2]; img.data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    _cropData = c.toDataURL('image/png').split(',')[1];
    return { bytes: _cropData.length, chunks: Math.ceil(_cropData.length / 60000) };
  };
  WM.cropChunk = function cropChunk(i) { return _cropData.slice(i * 60000, (i + 1) * 60000); };

  // Brightest building region — a good place to aim a crop.
  WM.hotspot = function hotspot(size) {
    const g = WM.grab(), mk = WM.mask();
    const S = size || 192, step = 24;
    let best = null;
    for (let y = 0; y + S <= g.h; y += step) {
      for (let x = 0; x + S <= g.w; x += step) {
        let cnt = 0, s = 0;
        for (let j = 0; j < S; j += 3) for (let i = 0; i < S; i += 3) {
          const idx = (y + j) * g.w + (x + i);
          if (!mk.m[idx]) continue;
          cnt++; s += luma(g.px, idx * 4);
        }
        if (cnt < (S / 3) * (S / 3) * 0.75) continue;
        const sc = s / cnt;
        if (!best || sc > best.score) best = { x, y: g.h - S - y, score: sc, cov: cnt };
      }
    }
    return best;
  };

  // ------------------------------------------------- flat-panel isolation
  // A "facade panel" is a run of pixels that belong to buildings AND share one
  // surface normal — i.e. one flat wall, windows included. Rendering the
  // buildings with MeshNormalMaterial on the mask layer gives that per pixel.
  let normRT = null;
  WM.normals = function normals() {
    const e = E(), r = e.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!normRT || normRT.width !== w || normRT.height !== h) {
      if (normRT) normRT.dispose();
      normRT = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      });
    }
    const list = [];
    const src = e._buildings;
    if (src && typeof src.forEach === 'function') src.forEach((m) => { if (m && m.isObject3D) list.push(m); });
    list.forEach((m) => m.traverse((n) => { if (n.isMesh) n.layers.enable(MASK_LAYER); }));
    const cam = e.camera, prevMaskLayer = cam.layers.mask;
    cam.layers.set(MASK_LAYER);
    const prevOverride = e.scene.overrideMaterial, prevBg = e.scene.background, prevFog = e.scene.fog;
    const prevClear = new THREE.Color(); r.getClearColor(prevClear);
    const prevAlpha = r.getClearAlpha();
    e.scene.overrideMaterial = new THREE.MeshNormalMaterial({ fog: false, flatShading: true });
    e.scene.background = null; e.scene.fog = null;
    r.setClearColor(0x000000, 1);
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(normRT);
    r.clear(true, true, false);
    r.render(e.scene, cam);
    r.setRenderTarget(prevTarget);
    e.scene.overrideMaterial.dispose();
    e.scene.overrideMaterial = prevOverride;
    e.scene.background = prevBg; e.scene.fog = prevFog;
    r.setClearColor(prevClear, prevAlpha);
    cam.layers.mask = prevMaskLayer;
    list.forEach((m) => m.traverse((n) => { if (n.isMesh) n.layers.disable(MASK_LAYER); }));
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(normRT, 0, 0, w, h, px);
    return { w, h, px };
  };

  // Per-tile statistics restricted to tiles that are one flat facade panel.
  // BLOCK device px, every pixel inside the building mask, every pixel sharing
  // the same face normal (within tol). This is the "flat panel" the art
  // director measures sigma/mean on.
  WM.panels = function panels(BLOCK, opts) {
    const o = opts || {};
    const g = o.g || WM.grab();
    const mk = o.mk || WM.mask();
    const nm = o.nm || WM.normals();
    const B = BLOCK || 16;
    const tiles = [];
    for (let by = 0; by + B <= g.h; by += B) {
      for (let bx = 0; bx + B <= g.w; bx += B) {
        let ok = true;
        const n0 = ((by + (B >> 1)) * g.w + bx + (B >> 1)) * 4;
        const r0 = nm.px[n0], g0 = nm.px[n0 + 1], b0 = nm.px[n0 + 2];
        let cnt = 0, s = 0, s2 = 0, mn = 1e9, mx = -1e9;
        const vals = [];
        for (let y = by; y < by + B && ok; y++) {
          for (let x = bx; x < bx + B; x++) {
            const idx = y * g.w + x, ni = idx * 4;
            if (!mk.m[idx]) { ok = false; break; }
            if (Math.abs(nm.px[ni] - r0) > 3 || Math.abs(nm.px[ni + 1] - g0) > 3 ||
                Math.abs(nm.px[ni + 2] - b0) > 3) { ok = false; break; }
            const L = luma(g.px, ni);
            vals.push(L);
            cnt++; s += L; s2 += L * L;
            if (L < mn) mn = L; if (L > mx) mx = L;
          }
        }
        if (!ok || cnt < B * B) continue;
        const mean = s / cnt;
        if (mean < 6) continue;
        vals.sort((a, b) => a - b);
        const p = (q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
        const sd = Math.sqrt(Math.max(0, s2 / cnt - mean * mean));
        tiles.push({ bx, by, mean, sd, r: sd / mean, spread: (p(0.95) - p(0.05)) / mean, p05: p(0.05), p95: p(0.95) });
      }
    }
    const by_ = (k) => tiles.map((t) => t[k]).sort((a, b) => a - b);
    const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0;
    const R = by_('r'), S = by_('spread');
    return {
      tiles: tiles.length,
      sigmaOverMean: { p25: +q(R, 0.25).toFixed(4), median: +q(R, 0.5).toFixed(4), p75: +q(R, 0.75).toFixed(4), p90: +q(R, 0.9).toFixed(4) },
      spread95_05: { median: +q(S, 0.5).toFixed(4), p90: +q(S, 0.9).toFixed(4) },
      raw: tiles,
    };
  };

  // --------------------------------------------- per-window peak statistics
  // "Within-facade window luminance sd/mean": find each lit pane as a local
  // maximum of the luma image inside the building mask, bucket the peaks by
  // screen neighbourhood AND shared face normal (= same facade), then measure
  // how much the panes of ONE facade differ from each other.
  //
  // The peak count is itself the "is there a window grid at 1:1" metric: a
  // facade that has blown out into a continuous cream field has almost no
  // distinct local maxima.
  WM.windowPeaks = function windowPeaks(opts) {
    const o = opts || {};
    const g = o.g || WM.grab();
    const mk = o.mk || WM.mask();
    const nm = o.nm || WM.normals();
    const RAD = o.rad || 3;            // local-max radius in device px
    const BUCKET = o.bucket || 64;     // facade neighbourhood in device px
    const L = new Float32Array(g.w * g.h);
    for (let i = 0; i < g.w * g.h; i++) L[i] = mk.m[i] ? luma(g.px, i * 4) : -1;
    // Adaptive threshold: the 70th percentile of lit building pixels.
    const samp = [];
    for (let i = 0; i < g.w * g.h; i += 7) if (L[i] > 0) samp.push(L[i]);
    samp.sort((a, b) => a - b);
    const T = o.thresh !== undefined ? o.thresh : samp[Math.floor(samp.length * 0.80)] || 60;
    const peaks = [];
    for (let y = RAD; y < g.h - RAD; y++) {
      for (let x = RAD; x < g.w - RAD; x++) {
        const i = y * g.w + x, v = L[i];
        if (v < T) continue;
        let isMax = true;
        for (let dy = -RAD; dy <= RAD && isMax; dy++) {
          for (let dx = -RAD; dx <= RAD; dx++) {
            if (!dx && !dy) continue;
            const w = L[(y + dy) * g.w + (x + dx)];
            if (w > v || (w === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        const ni = i * 4;
        peaks.push({ x, y, v, n: (nm.px[ni] >> 3) * 65536 + (nm.px[ni + 1] >> 3) * 256 + (nm.px[ni + 2] >> 3) });
      }
    }
    // Bucket by (facade normal, screen neighbourhood).
    const buckets = new Map();
    for (const p of peaks) {
      const k = p.n + ':' + ((p.x / BUCKET) | 0) + ':' + ((p.y / BUCKET) | 0);
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(p.v);
    }
    const ratios = [];
    let grouped = 0;
    for (const b of buckets.values()) {
      if (b.length < (o.minPeaks || 5)) continue;
      grouped += b.length;
      const mean = b.reduce((a, c) => a + c, 0) / b.length;
      const varr = b.reduce((a, c) => a + (c - mean) * (c - mean), 0) / b.length;
      if (mean < 8) continue;
      ratios.push(Math.sqrt(varr) / mean);
    }
    ratios.sort((a, b) => a - b);
    const q = (p) => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] : 0;
    return {
      threshold: +T.toFixed(1),
      peaks: peaks.length,
      facades: ratios.length,
      peaksGrouped: grouped,
      sdOverMean: { p25: +q(0.25).toFixed(4), median: +q(0.5).toFixed(4), p75: +q(0.75).toFixed(4) },
      meanSdOverMean: +(ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length)).toFixed(4),
    };
  };

  // Ablation: set uniforms, re-render, report how much of the building area
  // actually changed. Answers "is this term reaching the frame at all?".
  WM.ablate = function ablate(map, opts) {
    const e = E(), U = e._matLib.uniforms;
    const mk = WM.mask();
    const base = WM.grab();
    const keep = {};
    for (const k in map) {
      keep[k] = U[k].value && U[k].value.isVector2 ? U[k].value.clone() : U[k].value;
      if (U[k].value && U[k].value.isVector2) U[k].value.set(map[k][0], map[k][1]);
      else U[k].value = map[k];
    }
    const alt = WM.grab();
    for (const k in map) {
      if (U[k].value && U[k].value.isVector2) U[k].value.copy(keep[k]);
      else U[k].value = keep[k];
    }
    let n = 0, c1 = 0, c4 = 0, c16 = 0, sum = 0, mxd = 0;
    for (let i = 0; i < mk.w * mk.h; i++) {
      if (!mk.m[i]) continue;
      const d = Math.abs(luma(base.px, i * 4) - luma(alt.px, i * 4));
      n++; sum += d;
      if (d > 1) c1++;
      if (d > 4) c4++;
      if (d > 16) c16++;
      if (d > mxd) mxd = d;
    }
    return {
      what: (opts && opts.label) || Object.keys(map).join('+'),
      pctChanged1: +(100 * c1 / Math.max(1, n)).toFixed(2),
      pctChanged4: +(100 * c4 / Math.max(1, n)).toFixed(2),
      pctChanged16: +(100 * c16 / Math.max(1, n)).toFixed(2),
      meanDelta: +(sum / Math.max(1, n)).toFixed(3),
      maxDelta: +mxd.toFixed(1),
    };
  };

  // ------------------------------------------------------ legacy emulation
  // Reproduces the PREVIOUS window/emissive tuning through the current build's
  // uniforms, so before/after can be measured against the SAME lighting.js
  // (which another agent is editing concurrently — comparing two different
  // lighting builds would attribute their change to this one).
  //
  // Exact for every window term: winLevel [0.75,1.25,1.0] is algebraically the
  // old symmetric +/-25% jitter, winTemp 0.275 reproduces the old +/-200K
  // coefficients, winDusk [0,0,1] makes the dusk gate smoothstep(0,1,uNight),
  // which tracks the old linear uNight to within 0.06 over the whole range.
  // NOT emulated (structural, not uniform-driven): the long structural
  // distance fade and the weathering pivot. Both are texture terms; neither
  // touches the emissive.
  const LEGACY = {
    windowBoost: 0.9, winOff: 0.30, winLevel: [0.75, 1.25, 1.0], winTemp: 0.275,
    winDusk: [0.0, 0.0, 1.0], winSizeVary: 0.0, winSill: 0.0, ledge: 0.0,
    panelH: 0.0, glassTilt: 0.0, glassBow: 0.0, panel: 0.13, grime: 0.15,
    weather: 0.16, instVary: 0.065, floorVary: 0.030, winVary: 0.08,
    glassSky: 1.10, sunHalo: 0.55, glint: 1.0, glintPower: 18, grain: 0.37,
  };
  const LEGACY_GLOW = {
    intensity: 0.045, maxIntensity: 1.6, radiusScale: 1.35, minRadius: 5, maxRadius: 26,
    winOff: 0.30, winLevel: [0.75, 1.25, 1.0], winTemp: 0.275,
  };
  let _saved = null, _savedFn = null;
  WM.legacy = function legacy(on) {
    const e = E(), lib = e._matLib;
    if (on && !_saved) {
      _saved = {};
      for (const k in LEGACY) _saved[k] = Array.isArray(lib._params[k]) ? lib._params[k].slice() : lib._params[k];
      lib.setParams(LEGACY);
      _savedFn = lib.windowGlowsFor.bind(lib);
      lib.windowGlowsFor = (o, opts) => _savedFn(o, Object.assign({}, LEGACY_GLOW, opts || {}));
    } else if (!on && _saved) {
      lib.setParams(_saved);
      lib.windowGlowsFor = _savedFn;
      _saved = null; _savedFn = null;
    }
    e._glowsDirty = true;                  // force the CPU mirror to recompute
    e.render(0.016);
    return on ? 'legacy' : 'current';
  };

  WM.report = function report(shot) {
    if (shot) window.BVDEMO.shot(shot);
    const st = WM.stats();
    const at = WM.emissiveAttribution();
    return {
      shot: shot || '(current)',
      nightT: E()._nightT,
      uNight: E()._nightUniform.value,
      buildingPx: st.buildingPx,
      meanLuma: st.meanLuma,
      pctAbove200: st.pctAbove200,
      pctAbove230: st.pctAbove230,
      sdOverMean16: { median: st.block16.median, p90: st.block16.p90, tiles: st.block16.tiles },
      panel12: (() => { const p = WM.panels(12, { g: st._g, mk: st._mk }); return { tiles: p.tiles, sigmaOverMean: p.sigmaOverMean, spread: p.spread95_05 }; })(),
      panel20: (() => { const p = WM.panels(20, { g: st._g, mk: st._mk }); return { tiles: p.tiles, sigmaOverMean: p.sigmaOverMean, spread: p.spread95_05 }; })(),
      emissive: at,
    };
  };

  window.WM = WM;
})();
