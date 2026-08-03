// tools/rendertest/matmeter.js — measurements for src/render/materials.js.
//
// Dev-only. Never imported by src/. Load with:
//   (0,eval)(await (await fetch('/tools/rendertest/matmeter.js',{cache:'no-store'})).text());
//
// window.MM:
//   await MM.ready
//   await MM.settle(frames, ms) -> render frames, then wait (vegetation rescatter)
//   MM.frame()                  -> {w,h,lum,code,glass,wy,depth}  top-down buffers.
//                                  Grabs the beauty frame FIRST, then renders the
//                                  voxelPBR-only mask into a private target.
//   MM.wallHF(f)                -> hf1/hf2/lag-1 autocorr/checkerboard fraction on
//                                  flat NON-window wall pixels
//   MM.facadeSigma(f, opts)     -> sd/mean of luma over NxN blocks lying wholly on
//                                  one vertical facade at one depth
//   MM.glassGrad(f, opts)       -> luma binned by world Y within one same-facing
//                                  glass facade
//   MM.spectrum(f)              -> radial power of the wall signal, per period band
//   MM.report(tag)              -> all of the above
//
// Face-direction codes in `code`: 0 = not a building,
//   +X 40, -X 80, +Y 120, -Y 160, +Z 200, -Z 240.  Vertical = {40,80,200,240}.

(function () {
  const MM = {};
  const E = () => window.BV.engine;

  // rAF never fires while the Browser pane is hidden, so this drives frames off
  // setTimeout instead — the engine renders on demand either way.
  MM.settle = async function settle(frames, ms) {
    const e = E();
    for (let i = 0; i < (frames || 40); i++) {
      e.render(1 / 60);
      await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, ms === undefined ? 700 : ms));
    return true;
  };

  let _rt = null, _maskMat = null, _THREE = null;
  MM.ready = (async () => { _THREE = await import('/vendor/three.module.js'); return true; })();

  const MASK_VERT = `
    attribute vec2 matParams;
    varying vec2 vMP; varying vec3 vNW; varying float vY; varying float vD;
    void main() {
      vMP = matParams;
      vNW = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vY = wp.y;
      vec4 mv = viewMatrix * wp;
      vD = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`;
  const MASK_FRAG = `
    varying vec2 vMP; varying vec3 vNW; varying float vY; varying float vD;
    void main() {
      vec3 an = abs(vNW);
      float code;
      if (an.x > an.y && an.x > an.z)      code = vNW.x > 0.0 ? 40.0  : 80.0;
      else if (an.y > an.z)                code = vNW.y > 0.0 ? 120.0 : 160.0;
      else                                 code = vNW.z > 0.0 ? 200.0 : 240.0;
      float glass = (vMP.x < 0.22 && vMP.y < 0.50) ? 1.0 : 0.0;
      gl_FragColor = vec4(code / 255.0, glass, clamp(vY / 64.0, 0.0, 1.0), clamp(vD / 256.0, 0.0, 1.0));
    }`;

  // When the pane is hidden the compositor stops presenting and readPixels on
  // the DEFAULT framebuffer returns zeros. Fall back to re-running post.js's
  // final output pass into a scratch target — same material, same uniforms, so
  // it reproduces the canvas byte for byte (postmeasure.js does the same).
  let _mirror = null;
  function grabBeauty(dt) {
    const e = E();
    e.render(dt === undefined ? 0.016 : dt);
    const gl = e.renderer.getContext();
    const r = e.renderer;
    const c = r.domElement;
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    let any = 0;
    for (let i = 0; i < px.length; i += 4004) { any |= px[i]; if (any) break; }
    if (any) return { w, h, px };

    const THREE = _THREE;
    if (!THREE) throw new Error('MM: black frame and no THREE for the mirror');
    const p = e._post;
    if (!_mirror || _mirror.width !== w || _mirror.height !== h) {
      if (_mirror) _mirror.dispose();
      _mirror = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
    }
    const prevT = r.getRenderTarget(), prevAC = r.autoClear;
    r.autoClear = false;
    p._blit(p.mOutput, _mirror);
    r.autoClear = prevAC;
    r.setRenderTarget(prevT);
    r.readRenderTargetPixels(_mirror, 0, 0, w, h, px);
    return { w, h, px, mirrored: true };
  }

  function grabMask() {
    const THREE = _THREE;
    if (!THREE) throw new Error('MM: await MM.ready first');
    const e = E(), r = e.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!_maskMat) {
      _maskMat = new THREE.ShaderMaterial({ vertexShader: MASK_VERT, fragmentShader: MASK_FRAG });
      _maskMat.defaultAttributeValues = { matParams: [0.72, 0.0] };
    }
    if (!_rt || _rt.width !== w || _rt.height !== h) {
      if (_rt) _rt.dispose();
      _rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      });
    }
    const touched = [];
    e.scene.traverse((o) => {
      if (!o.isMesh) return;
      touched.push([o, o.visible, o.material]);
      if (o.material && o.material.name === 'voxelPBR') o.material = _maskMat;
      else o.visible = false;
    });
    const prevT = r.getRenderTarget();
    const prevBg = e.scene.background, prevFog = e.scene.fog;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const prevShadow = r.shadowMap.enabled;
    e.scene.background = null; e.scene.fog = null; r.shadowMap.enabled = false;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(_rt);
    r.clear(true, true, false);
    r.render(e.scene, e.camera);
    r.setRenderTarget(prevT);
    r.setClearColor(prevClear, prevAlpha);
    e.scene.background = prevBg; e.scene.fog = prevFog; r.shadowMap.enabled = prevShadow;
    for (const t of touched) { t[0].visible = t[1]; t[0].material = t[2]; }
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(_rt, 0, 0, w, h, px);
    return { w, h, px };
  }

  // Beauty first, mask second. Both flipped to top-down and unpacked to flat
  // typed arrays so every metric below is plain index arithmetic.
  MM.frame = function frame(dt) {
    const b = grabBeauty(dt);
    const m = grabMask();
    const w = b.w, h = b.h, n = w * h;
    const lum = new Float32Array(n);
    const code = new Uint8Array(n);
    const glass = new Uint8Array(n);
    const wy = new Float32Array(n);
    const depth = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4, dst = y * w;
      for (let x = 0; x < w; x++) {
        const i = src + x * 4, o = dst + x;
        lum[o] = 0.2126 * b.px[i] + 0.7152 * b.px[i + 1] + 0.0722 * b.px[i + 2];
        code[o] = m.px[i];
        glass[o] = m.px[i + 1] > 128 ? 1 : 0;
        wy[o] = m.px[i + 2] * 64 / 255;
        depth[o] = m.px[i + 3] * 256 / 255;
      }
    }
    return { w, h, lum, code, glass, wy, depth };
  };

  const isVert = (c) => c === 40 || c === 80 || c === 200 || c === 240;

  function quant(a, q) {
    if (!a.length) return NaN;
    const s = Float64Array.from(a).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  }

  // ---------------------------------------------------- flat-wall statistics
  // Pixels whose whole 5x5 neighbourhood is the same non-glass vertical facade
  // at the same depth: no silhouette, no window, no roofline.
  function wallPixels(f, wantGlass) {
    const { w, h, code, glass, depth } = f;
    const out = [];
    for (let y = 3; y < h - 3; y++) {
      const row = y * w;
      for (let x = 3; x < w - 3; x++) {
        const o = row + x;
        const c = code[o];
        if (!isVert(c)) continue;
        if (wantGlass !== undefined && glass[o] !== (wantGlass ? 1 : 0)) continue;
        const d = depth[o];
        let same = true;
        for (let dy = -2; dy <= 2 && same; dy++) {
          const r2 = o + dy * w;
          for (let dx = -2; dx <= 2; dx++) {
            const q = r2 + dx;
            if (code[q] !== c || Math.abs(depth[q] - d) > 2.0 ||
                (wantGlass !== undefined && glass[q] !== glass[o])) { same = false; break; }
          }
        }
        if (same) out.push(o);
      }
    }
    return out;
  }

  MM.wallHF = function wallHF(f, wantGlass) {
    const { w, lum } = f;
    const px = wallPixels(f, wantGlass === undefined ? false : wantGlass);
    const n = px.length;
    if (!n) return { n: 0 };
    let e1 = 0, e2 = 0, s = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const o = px[i], l = lum[o];
      e1 += Math.abs(l - (lum[o - 1] + lum[o + 1]) / 2)
          + Math.abs(l - (lum[o - w] + lum[o + w]) / 2);
      e2 += Math.abs(l - (lum[o - 2] + lum[o + 2]) / 2);
      s += l; s2 += l * l;
    }
    const mean = s / n, varr = Math.max(1e-9, s2 / n - mean * mean);
    let c1x = 0, c1y = 0, c2x = 0, c4x = 0, chk = 0;
    for (let i = 0; i < n; i++) {
      const o = px[i], d = lum[o] - mean;
      c1x += d * (lum[o + 1] - mean);
      c1y += d * (lum[o + w] - mean);
      c2x += d * (lum[o + 2] - mean);
      c4x += d * (lum[o + 4] - mean);
      const y = (o / w) | 0, x = o - y * w;
      chk += d * (((x + y) & 1) ? -1 : 1);
    }
    return { n, mean: +mean.toFixed(2), sd: +Math.sqrt(varr).toFixed(3),
             sdOverMean: +(Math.sqrt(varr) / mean).toFixed(4),
             hf1: +(e1 / (2 * n)).toFixed(3), hf2: +(e2 / n).toFixed(3),
             r1x: +(c1x / n / varr).toFixed(3), r1y: +(c1y / n / varr).toFixed(3),
             r2x: +(c2x / n / varr).toFixed(3), r4x: +(c4x / n / varr).toFixed(3),
             chkFrac: +(Math.abs(chk / n) / Math.sqrt(varr)).toFixed(4) };
  };

  // 1-D power spectrum of horizontal runs of flat wall, reported as the share of
  // variance in period bands. `p2` is the 2-device-pixel (Nyquist) band.
  MM.spectrum = function spectrum(f, opts) {
    const o = Object.assign({ len: 32, maxRuns: 4000 }, opts || {});
    const { w, h, code, glass, depth } = f;
    const lum = (opts && opts.signal) || f.lum;
    const K = o.len;
    const acc = new Float64Array(K / 2 + 1);
    let runs = 0;
    for (let y = 4; y < h - 4 && runs < o.maxRuns; y += 3) {
      const row = y * w;
      let x = 4;
      while (x < w - K - 4 && runs < o.maxRuns) {
        const c = code[row + x], d = depth[row + x];
        if (!isVert(c) || glass[row + x]) { x++; continue; }
        let ok = true;
        for (let k = 0; k < K; k++) {
          const q = row + x + k;
          if (code[q] !== c || glass[q] || Math.abs(depth[q] - d) > 2.5) { ok = false; break; }
        }
        if (!ok) { x++; continue; }
        let m = 0;
        for (let k = 0; k < K; k++) m += lum[row + x + k];
        m /= K;
        for (let bin = 1; bin <= K / 2; bin++) {
          let re = 0, im = 0;
          for (let k = 0; k < K; k++) {
            const a = -2 * Math.PI * bin * k / K;
            const v = lum[row + x + k] - m;
            re += v * Math.cos(a); im += v * Math.sin(a);
          }
          acc[bin] += (re * re + im * im) / (K * K);
        }
        runs++; x += K;
      }
    }
    if (!runs) return { runs: 0 };
    const tot = acc.reduce((a, b) => a + b, 0) || 1;
    // acc is summed over runs; per-run mean power == variance inside the window.
    const varAbs = tot / runs;
    const band = (lo, hi, abs) => {
      let s = 0;
      for (let bin = 1; bin <= K / 2; bin++) { const per = K / bin; if (per >= lo && per < hi) s += acc[bin]; }
      return abs ? +(s / runs).toFixed(4) : +(s / tot).toFixed(4);
    };
    const A = !!(opts && opts.abs);
    const r = { runs, len: K, varAbs: +varAbs.toFixed(4),
                p2: band(0, 2.5, A), p2_4: band(2.5, 4.5, A), p4_8: band(4.5, 9, A),
                p8_16: band(9, 17, A), p16up: band(17, 1e9, A) };
    if (K >= 64) {
      r.p16_32 = band(17, 33, A); r.p32_64 = band(33, 65, A); r.p64up = band(65, 1e9, A);
      delete r.p16up;
    }
    return r;
  };

  // --------------------------------------------------- per-TILE correlation
  // The checkerboard test. On flat non-glass wall, take the residual after
  // subtracting a 5-tile running mean (that removes the lighting gradient and
  // the albedo, leaving the jitter), and correlate it against itself at a lag of
  // 1, 2 and 4 VOXEL TILES — the tile size in device pixels is derived per pixel
  // from the depth channel.
  //   white noise per tile     -> r1 ~ 0
  //   4-8 tile value noise     -> r1 ~ 0.7-0.9, r4 still > 0
  //   1-tile alternation       -> r1 < 0
  // Re-grab only the beauty frame (no mask re-render) and return its luma, so a
  // parameter can be toggled and the DIFFERENCE of two frames isolates exactly
  // what that parameter contributes to the final image, through post, AA and DOF.
  MM.lumOnly = function lumOnly(f, dt) {
    const b = grabBeauty(dt);
    const out = new Float32Array(f.w * f.h);
    for (let y = 0; y < f.h; y++) {
      const src = (f.h - 1 - y) * f.w * 4, dst = y * f.w;
      for (let x = 0; x < f.w; x++) {
        const i = src + x * 4;
        out[dst + x] = 0.2126 * b.px[i] + 0.7152 * b.px[i + 1] + 0.0722 * b.px[i + 2];
      }
    }
    return out;
  };
  MM.sub = function sub(a, b) {
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i];
    return o;
  };

  MM.tileACF = function tileACF(f, opts) {
    const o = Object.assign({ span: 5, stride: 2, maxRuns: 60000 }, opts || {});
    const { w, h, code, glass, depth } = f;
    const lum = (opts && opts.signal) || f.lum;
    const e = E();
    const k = (f.h / 2) / Math.tan(e.camera.fov * Math.PI / 360);
    let n = 0, s = 0, s2 = 0, c1 = 0, c2 = 0, c4 = 0, n1 = 0, n2 = 0, n4 = 0, runs = 0;
    const vals = [];
    for (let y = 4; y < h - 4 && runs < o.maxRuns; y += o.stride) {
      const row = y * w;
      for (let x = 4; x < w - 4 && runs < o.maxRuns; x++) {
        const q = row + x;
        if (!isVert(code[q]) || glass[q] || depth[q] < 1) continue;
        const t = Math.round(k / depth[q]);              // device px per tile
        if (t < 3 || t > 200) continue;
        const len = o.span * t;
        if (x + len >= w - 4) continue;
        const c0 = code[q], d0 = depth[q];
        let ok = true;
        for (let i = 0; i <= len; i++) {
          const p = row + x + i;
          if (code[p] !== c0 || glass[p] || Math.abs(depth[p] - d0) > 3.0) { ok = false; break; }
        }
        if (!ok) { x += 1; continue; }
        // detrend with the run's own mean
        let m = 0;
        for (let i = 0; i <= len; i++) m += lum[row + x + i];
        m /= (len + 1);
        vals.length = 0;
        for (let i = 0; i <= len; i++) vals.push(lum[row + x + i] - m);
        for (let i = 0; i <= len; i++) { const v = vals[i]; s += v; s2 += v * v; n++; }
        for (let i = 0; i + t <= len; i++) { c1 += vals[i] * vals[i + t]; n1++; }
        for (let i = 0; i + 2 * t <= len; i++) { c2 += vals[i] * vals[i + 2 * t]; n2++; }
        for (let i = 0; i + 4 * t <= len; i++) { c4 += vals[i] * vals[i + 4 * t]; n4++; }
        runs++;
        x += len;
      }
    }
    if (!n) return { runs: 0 };
    const varr = Math.max(1e-9, s2 / n - (s / n) * (s / n));
    return { runs, px: n, sd: +Math.sqrt(varr).toFixed(3),
             r1tile: +(c1 / Math.max(1, n1) / varr).toFixed(3),
             r2tile: +(c2 / Math.max(1, n2) / varr).toFixed(3),
             r4tile: n4 ? +(c4 / n4 / varr).toFixed(3) : null };
  };

  // ------------------------------------------------------- facade sigma/mean
  MM.facadeSigma = function facadeSigma(f, opts) {
    const o = Object.assign({ n: 12, depthTol: 3.0, minMean: 8, glass: null }, opts || {});
    const { w, h, lum, code, glass, depth } = f;
    const N = o.n;
    const vals = [];
    for (let by = 0; by + N <= h; by += N) {
      for (let bx = 0; bx + N <= w; bx += N) {
        let ok = true, c0 = -1, dmin = 1e9, dmax = -1e9, gn = 0, s = 0, s2 = 0;
        for (let y = by; y < by + N && ok; y++) {
          const row = y * w;
          for (let x = bx; x < bx + N; x++) {
            const q = row + x, c = code[q];
            if (!isVert(c)) { ok = false; break; }
            if (c0 < 0) c0 = c; else if (c !== c0) { ok = false; break; }
            const d = depth[q];
            if (d < dmin) dmin = d;
            if (d > dmax) dmax = d;
            gn += glass[q];
            const l = lum[q];
            s += l; s2 += l * l;
          }
        }
        if (!ok || dmax - dmin > o.depthTol) continue;
        const nn = N * N, mean = s / nn;
        if (mean < o.minMean) continue;
        const isGlass = gn > nn * 0.5;
        if (o.glass === true && !isGlass) continue;
        if (o.glass === false && isGlass) continue;
        vals.push(Math.sqrt(Math.max(0, s2 / nn - mean * mean)) / mean);
      }
    }
    return { n: vals.length,
             median: +quant(vals, 0.5).toFixed(4),
             p25: +quant(vals, 0.25).toFixed(4),
             p75: +quant(vals, 0.75).toFixed(4) };
  };

  // ------------------------------------------------------- glass Y gradient
  MM.glassGrad = function glassGrad(f, opts) {
    const o = Object.assign({ bins: 8, minPix: 800, bandW: 96, want: 1 }, opts || {});
    const { w, h, lum, code, glass, wy } = f;
    const groups = new Map();
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const q = row + x;
        if (glass[q] !== o.want || !isVert(code[q])) continue;
        const key = code[q] + ':' + ((x / o.bandW) | 0);
        let a = groups.get(key);
        if (!a) { a = []; groups.set(key, a); }
        a.push(q);
      }
    }
    const out = [];
    for (const [key, a] of groups) {
      if (a.length < o.minPix) continue;
      let ymin = 1e9, ymax = -1e9;
      for (let i = 0; i < a.length; i++) { const v = wy[a[i]]; if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
      if (ymax - ymin < 5) continue;
      const bs = new Float64Array(o.bins), bn = new Float64Array(o.bins);
      for (let i = 0; i < a.length; i++) {
        const t = (wy[a[i]] - ymin) / (ymax - ymin);
        const b = Math.min(o.bins - 1, (t * o.bins) | 0);
        bs[b] += lum[a[i]]; bn[b]++;
      }
      const prof = [];
      for (let i = 0; i < o.bins; i++) prof.push(bn[i] > 20 ? +(bs[i] / bn[i]).toFixed(2) : null);
      const valid = prof.filter((v) => v !== null);
      if (valid.length < o.bins - 1) continue;
      const mean = valid.reduce((x, y2) => x + y2, 0) / valid.length;
      const top = prof[o.bins - 1], bot = prof[0];
      out.push({ key, px: a.length, worldY: [+ymin.toFixed(1), +ymax.toFixed(1)], prof,
                 grad: (top != null && bot != null) ? +((top - bot) / mean).toFixed(4) : null,
                 range: +((Math.max.apply(null, valid) - Math.min.apply(null, valid)) / mean).toFixed(4) });
    }
    out.sort((a, b) => b.px - a.px);
    return out.slice(0, 5);
  };

  // Device pixels per world unit (== per voxel) at a given view depth.
  MM.voxPx = function voxPx(f) {
    const e = E();
    const fov = e.camera.fov * Math.PI / 180;
    const k = (f.h / 2) / Math.tan(fov / 2);
    const ds = [];
    for (let i = 0; i < f.depth.length; i += 13) if (f.code[i]) ds.push(f.depth[i]);
    if (!ds.length) return null;
    const med = quant(ds, 0.5), p10 = quant(ds, 0.1), p90 = quant(ds, 0.9);
    return { depthMedian: +med.toFixed(1), pxPerVoxelMedian: +(k / med).toFixed(1),
             pxPerVoxelNear: +(k / p10).toFixed(1), pxPerVoxelFar: +(k / p90).toFixed(1) };
  };

  // Share of BUILDING pixels above a luma threshold (night non-regression).
  MM.bright = function bright(f, thr) {
    const t = thr === undefined ? 200 : thr;
    let n = 0, hot = 0;
    for (let i = 0; i < f.lum.length; i++) if (f.code[i]) { n++; if (f.lum[i] > t) hot++; }
    return { buildingPx: n, aboveFrac: +(hot / Math.max(1, n)).toFixed(4) };
  };

  MM.report = function report(tag, f) {
    f = f || MM.frame();
    const gg = MM.glassGrad(f);
    const grads = gg.map((x) => x.grad).filter((v) => v != null);
    return {
      tag: tag || '',
      scale: MM.voxPx(f),
      bright200: MM.bright(f, 200),
      wall: MM.wallHF(f, false),
      tile: MM.tileACF(f),
      spec: MM.spectrum(f),
      facade12: MM.facadeSigma(f, { n: 12 }),
      facade12_opaque: MM.facadeSigma(f, { n: 12, glass: false }),
      facade12_glass: MM.facadeSigma(f, { n: 12, glass: true }),
      glassGradMedian: grads.length ? +quant(grads, 0.5).toFixed(4) : null,
      glassRangeMedian: gg.length ? +quant(gg.map((x) => x.range), 0.5).toFixed(4) : null,
      // The discriminator the brief asks for: if the vertical gradient on a
      // glass facade is the same as on a painted one, it is AO and grime, not a
      // sky reflection — "blue paint", exactly as reported.
      wallGradMedian: (() => {
        const wgs = MM.glassGrad(f, { want: 0 }).map((x) => x.grad).filter((v) => v != null);
        return wgs.length ? +quant(wgs, 0.5).toFixed(4) : null;
      })(),
      glass: gg,
    };
  };

  window.MM = MM;
  return 'MM ready';
})();
