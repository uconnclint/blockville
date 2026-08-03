// tools/rendertest/postmeasure.js — raw-framebuffer measurements for src/render/post.js.
//
// Dev-only. Never imported by src/. Load with:
//   (0,eval)(await (await fetch('/tools/rendertest/postmeasure.js',{cache:'no-store'})).text());
//
// Provides window.PM:
//   PM.grab()                     -> {w,h,px}  raw default-framebuffer readback
//   PM.scanline(y, x0, x1)        -> per-pixel RGB along a device scanline
//   PM.ditherEnergy(rects)        -> checkerboard/high-frequency energy metric
//   PM.contact(opts)              -> contact-AO falloff binned by world distance
//   PM.perf(n)                    -> ms/frame for post.render over n frames
//
// All of these force a synchronous engine.render() first, then readPixels on the
// default framebuffer before the compositor clears it.

(function () {
  const PM = {};
  const E = () => window.BV.engine;

  // ---------------------------------------------------------------- readback
  //
  // When the browser tab is backgrounded the compositor stops presenting the
  // canvas and readPixels on the DEFAULT framebuffer returns all zeros — every
  // measurement silently becomes 0. Detect that and re-run post.js's final
  // output pass into a scratch render target instead, which reproduces the
  // canvas byte-for-byte (same material, same uniforms, same source texture).
  let _mirror = null;
  PM.mirrorReady = (async () => {
    PM._THREE = await import('/vendor/three.module.js');
    return true;
  })();
  PM.grabMirror = function grabMirror(dt) {
    const e = E();
    const p = e._post, r = e.renderer;
    const THREE = PM._THREE;
    if (!THREE) throw new Error('PM.grabMirror: await PM.mirrorReady first');
    e.render(dt === undefined ? 0.016 : dt);
    const w = r.domElement.width, h = r.domElement.height;
    if (!_mirror || _mirror.width !== w || _mirror.height !== h) {
      if (_mirror) _mirror.dispose();
      _mirror = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
    }
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    p._blit(p.mOutput, _mirror);          // uniforms are exactly as render() left them
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(_mirror, 0, 0, w, h, px);
    return { w, h, px, mirrored: true };
  };

  PM.grab = function grab(dt) {
    const e = E();
    e.render(dt === undefined ? 0.016 : dt);
    const gl = e.renderer.getContext();
    const c = e.renderer.domElement;
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    // A genuinely all-black frame is impossible for this game; treat it as a
    // backgrounded tab and fall back to the offscreen mirror.
    let any = 0;
    for (let i = 0; i < px.length; i += 4004) { any |= px[i]; if (any) break; }
    if (!any) return PM.grabMirror(dt);
    return { w, h, px };
  };

  // y is measured from the TOP of the device framebuffer (screenshot convention).
  PM.at = function at(g, x, y) {
    const gy = g.h - 1 - y;
    const i = (gy * g.w + x) * 4;
    return [g.px[i], g.px[i + 1], g.px[i + 2]];
  };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  PM.scanline = function scanline(y, x0, x1, g) {
    g = g || PM.grab();
    const out = [];
    for (let x = x0; x <= x1; x++) out.push(PM.at(g, x, y));
    return out;
  };

  // Mean |c[i] - (c[i-1]+c[i+1])/2| over a scanline: the amplitude of a
  // 1-pixel-period (checkerboard) component. A clean gradient scores ~0.
  PM.scanlineDither = function scanlineDither(y, x0, x1, g) {
    const s = PM.scanline(y, x0 - 1, x1 + 1, g);
    const per = [0, 0, 0];
    let n = 0;
    for (let i = 1; i < s.length - 1; i++) {
      for (let k = 0; k < 3; k++) per[k] += Math.abs(s[i][k] - (s[i - 1][k] + s[i + 1][k]) / 2);
      n++;
    }
    return { y, x0, x1, n, r: per[0] / n, g: per[1] / n, b: per[2] / n,
             mean: (per[0] + per[1] + per[2]) / (3 * n) };
  };

  // High-frequency (nearest-neighbour) energy over rectangles of the frame.
  // Separates the true checkerboard (diagonal +-, period 1) from real detail by
  // also reporting the 2-px-period energy for reference.
  PM.ditherEnergy = function ditherEnergy(rects, g) {
    g = g || PM.grab();
    const res = [];
    for (const rc of rects) {
      let e1 = 0, e2 = 0, n = 0, mean = 0;
      for (let y = rc.y; y < rc.y + rc.h; y++) {
        for (let x = rc.x; x < rc.x + rc.w; x++) {
          const c = PM.at(g, x, y);
          const cl = PM.at(g, x - 1, y), cr = PM.at(g, x + 1, y);
          const cu = PM.at(g, x, y - 1), cd = PM.at(g, x, y + 1);
          const l = lum(c);
          e1 += Math.abs(l - (lum(cl) + lum(cr)) / 2) + Math.abs(l - (lum(cu) + lum(cd)) / 2);
          const c2l = PM.at(g, x - 2, y), c2r = PM.at(g, x + 2, y);
          e2 += Math.abs(l - (lum(c2l) + lum(c2r)) / 2);
          mean += l; n++;
        }
      }
      res.push({ name: rc.name || '', mean: +(mean / n).toFixed(2),
                 hf1: +(e1 / (2 * n)).toFixed(3), hf2: +(e2 / n).toFixed(3) });
    }
    return res;
  };

  // ------------------------------------------------------------- contact AO
  // Walks outward from every camera-facing building wall base along the ground
  // plane and bins final-image luma by world distance from the wall.
  //
  // Reports two things:
  //   lumaN[]  mean luma normalised by the 6..8 m far-field value (albedo-biased)
  //   aoRatio[] mean luma(AO on) / luma(AO off) at the same pixels — albedo-free,
  //             this is the actual occlusion the AO pass contributes.
  PM.contact = function contact(opts) {
    opts = opts || {};
    const e = E();
    const THREE = e.THREE || window.THREE || (e.camera.constructor && null);
    const cam = e.camera;
    const bins = opts.bins || [0.15, 0.35, 0.6, 0.9, 1.2, 1.6, 2.2, 3.0, 4.0, 5.0];

    // World AABBs of every building, for both sampling and occlusion.
    const boxes = [];
    e._buildings.forEach((m) => {
      if (!m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      // Buildings are axis-aligned boxes rotated by multiples of 90 deg.
      const p = m.position, ry = Math.abs(Math.round(m.rotation.y / (Math.PI / 2))) % 2;
      const ex = ry ? (bb.max.z - bb.min.z) / 2 : (bb.max.x - bb.min.x) / 2;
      const ez = ry ? (bb.max.x - bb.min.x) / 2 : (bb.max.z - bb.min.z) / 2;
      boxes.push({ minX: p.x - ex, maxX: p.x + ex, minZ: p.z - ez, maxZ: p.z + ez,
                   minY: p.y, maxY: p.y + (bb.max.y - bb.min.y) });
    });

    const rayBox = (ox, oy, oz, dx, dy, dz, tmax, b) => {
      let t0 = 0.001, t1 = tmax;
      const slab = (o, d, mn, mx) => {
        if (Math.abs(d) < 1e-8) return o >= mn && o <= mx;
        let a = (mn - o) / d, bb2 = (mx - o) / d;
        if (a > bb2) { const t = a; a = bb2; bb2 = t; }
        if (a > t0) t0 = a;
        if (bb2 < t1) t1 = bb2;
        return t1 >= t0;
      };
      if (!slab(ox, dx, b.minX, b.maxX)) return false;
      if (!slab(oy, dy, b.minY, b.maxY)) return false;
      if (!slab(oz, dz, b.minZ, b.maxZ)) return false;
      return true;
    };

    // Collect (worldPoint, bin) samples from camera-facing wall bases.
    const V = cam.position;
    const samples = [];
    const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      if (b.maxY - b.minY < 2) continue;                  // need a real wall
      for (const [nx, nz] of faces) {
        const cx = nx > 0 ? b.maxX : (nx < 0 ? b.minX : (b.minX + b.maxX) / 2);
        const cz = nz > 0 ? b.maxZ : (nz < 0 ? b.minZ : (b.minZ + b.maxZ) / 2);
        const toCam = [V.x - cx, V.z - cz];
        const len = Math.hypot(toCam[0], toCam[1]);
        if ((toCam[0] * nx + toCam[1] * nz) / len < 0.45) continue;  // not facing us
        const span = nx ? (b.maxZ - b.minZ) : (b.maxX - b.minX);
        const tang = nx ? [0, 1] : [1, 0];
        for (let s = -0.32; s <= 0.33; s += 0.16) {
          const ox = cx + tang[0] * span * s, oz = cz + tang[1] * span * s;
          const row = [];
          for (let k = 0; k < bins.length; k++) {
            const d = bins[k];
            const wx = ox + nx * d, wz = oz + nz * d, wy = 0.02;
            // inside another building?
            let bad = false;
            for (let j = 0; j < boxes.length; j++) {
              const o = boxes[j];
              if (wx > o.minX - 0.05 && wx < o.maxX + 0.05 && wz > o.minZ - 0.05 && wz < o.maxZ + 0.05) { bad = true; break; }
            }
            if (bad) break;
            // project
            const p = new cam.position.constructor(wx, wy, wz);
            p.project(cam);
            if (p.x < -0.92 || p.x > 0.92 || p.y < -0.92 || p.y > 0.92) break;
            // occluded?
            const dx = wx - V.x, dy = wy - V.y, dz = wz - V.z;
            const dist = Math.hypot(dx, dy, dz);
            let occ = false;
            for (let j = 0; j < boxes.length; j++) {
              if (rayBox(V.x, V.y, V.z, dx / dist, dy / dist, dz / dist, dist - 0.25, boxes[j])) { occ = true; break; }
            }
            if (occ) break;
            row.push([Math.round((p.x * 0.5 + 0.5) * (e.renderer.domElement.width - 1)),
                      Math.round((1 - (p.y * 0.5 + 0.5)) * (e.renderer.domElement.height - 1))]);
          }
          if (row.length >= 4) samples.push(row);
        }
      }
    }

    const read = (g) => {
      const acc = bins.map(() => 0), cnt = bins.map(() => 0);
      const per = [];
      for (const row of samples) {
        const vals = row.map(([x, y]) => lum(PM.at(g, x, y)));
        per.push(vals);
        for (let k = 0; k < vals.length; k++) { acc[k] += vals[k]; cnt[k]++; }
      }
      return { mean: acc.map((v, k) => v / Math.max(1, cnt[k])), per };
    };

    const post = e._post;
    const wasEnabled = post.params.ssao.enabled;
    post.setParams({ ssao: { enabled: true } });
    const gOn = PM.grab();
    const on = read(gOn);
    post.setParams({ ssao: { enabled: false } });
    const gOff = PM.grab();
    const off = read(gOff);
    post.setParams({ ssao: { enabled: wasEnabled } });
    PM.grab();

    // albedo-free AO contribution
    const ratio = bins.map(() => 0), rc = bins.map(() => 0);
    for (let i = 0; i < on.per.length; i++) {
      for (let k = 0; k < on.per[i].length; k++) {
        const o = off.per[i][k];
        if (o > 6) { ratio[k] += on.per[i][k] / o; rc[k]++; }
      }
    }
    const aoRatio = ratio.map((v, k) => v / Math.max(1, rc[k]));

    // normalise the raw profile by the far field (last two bins)
    const far = (on.mean[bins.length - 1] + on.mean[bins.length - 2]) / 2;
    const lumaN = on.mean.map((v) => v / far);
    const farR = (aoRatio[bins.length - 1] + aoRatio[bins.length - 2]) / 2;

    const totalDrop = farR - aoRatio[0];

    // --- firstMetreShare -----------------------------------------------
    //
    // BROKEN AS SHIPPED. The original loop was:
    //
    //     for (k...) if (bins[k] <= 1.0) firstMetre = farR - aoRatio[k];
    //     firstMetreShare = 100 * firstMetre / totalDrop;
    //
    // `firstMetre` is overwritten every iteration, so it ends up holding the
    // occlusion REMAINING at the last sub-1 m bin (0.9 m), and the ratio is
    // occ(0.9 m) / occ(0.15 m). That is a TAIL measure: it goes DOWN as the
    // contact term gets tighter and UP as it gets wider — the opposite of what
    // the name and the docstring claim. A perfect 2 px contact seam scores near
    // 0%. Any conclusion drawn from the old number, in either direction, is
    // unreliable; it is kept only so old logs can be re-interpreted.
    let legacy = 0;
    for (let k = 0; k < bins.length; k++) if (bins[k] <= 1.0) legacy = farR - aoRatio[k];

    // Corrected: the share of the total occlusion AREA that lies inside the
    // first metre. occ(d) = farR - aoRatio(d), trapezoid-integrated over d,
    // with the [0, bins[0]] stub held at occ(bins[0]).
    const occ = aoRatio.map((v) => Math.max(0, farR - v));
    let areaAll = occ[0] * bins[0], areaFirst = occ[0] * bins[0];
    for (let k = 1; k < bins.length; k++) {
      const dw = bins[k] - bins[k - 1];
      const a = (occ[k] + occ[k - 1]) * 0.5 * dw;
      areaAll += a;
      if (bins[k] <= 1.0) areaFirst += a;
      else if (bins[k - 1] < 1.0) areaFirst += a * (1.0 - bins[k - 1]) / dw;
    }

    // Distance at which the occlusion has fallen to half its contact peak.
    let half = null;
    for (let k = 1; k < bins.length; k++) {
      if (occ[k] <= occ[0] * 0.5) {
        const t = (occ[k - 1] - occ[0] * 0.5) / Math.max(1e-6, occ[k - 1] - occ[k]);
        half = +(bins[k - 1] + t * (bins[k] - bins[k - 1])).toFixed(3);
        break;
      }
    }

    return {
      n: samples.length, bins, perBin: rc,
      lumaN: lumaN.map((v) => +v.toFixed(4)),
      aoRatio: aoRatio.map((v) => +v.toFixed(4)),
      dipAt: bins.map((b, k) => +(100 * (1 - aoRatio[k] / farR)).toFixed(2)),
      totalDropPct: +(100 * totalDrop / farR).toFixed(2),
      halfDecayMetres: half,
      firstMetreShare: +(100 * (areaAll > 1e-6 ? areaFirst / areaAll : 0)).toFixed(1),
      legacyFirstMetreShare_BROKEN:
        +(100 * (totalDrop > 1e-4 ? legacy / totalDrop : 0)).toFixed(1),
    };
  };

  // AO on a vertical wall as a function of height above the ground. This is the
  // "broad fake vignette up tall walls" test: a good contact term dies out by
  // ~1.5 m, a too-wide radius keeps darkening at 4-6 m.
  PM.wall = function wall() {
    const e = E();
    const cam = e.camera;
    const heights = [0.15, 0.4, 0.8, 1.3, 2.0, 3.0, 4.5, 6.0, 8.0, 10.0];
    const boxes = [];
    e._buildings.forEach((m) => {
      if (!m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      const p = m.position, ry = Math.abs(Math.round(m.rotation.y / (Math.PI / 2))) % 2;
      const ex = ry ? (bb.max.z - bb.min.z) / 2 : (bb.max.x - bb.min.x) / 2;
      const ez = ry ? (bb.max.x - bb.min.x) / 2 : (bb.max.z - bb.min.z) / 2;
      boxes.push({ minX: p.x - ex, maxX: p.x + ex, minZ: p.z - ez, maxZ: p.z + ez,
                   h: bb.max.y - bb.min.y });
    });
    const V = cam.position;
    const samples = [];
    const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const b of boxes) {
      if (b.h < 12) continue;                       // tall wall only
      for (const [nx, nz] of faces) {
        const cx = nx > 0 ? b.maxX : (nx < 0 ? b.minX : (b.minX + b.maxX) / 2);
        const cz = nz > 0 ? b.maxZ : (nz < 0 ? b.minZ : (b.minZ + b.maxZ) / 2);
        const t = [V.x - cx, V.z - cz], len = Math.hypot(t[0], t[1]);
        if ((t[0] * nx + t[1] * nz) / len < 0.6) continue;
        const row = [];
        for (const hy of heights) {
          const p = new cam.position.constructor(cx + nx * 0.06, hy, cz + nz * 0.06);
          p.project(cam);
          if (p.x < -0.92 || p.x > 0.92 || p.y < -0.92 || p.y > 0.92) break;
          row.push([Math.round((p.x * 0.5 + 0.5) * (e.renderer.domElement.width - 1)),
                    Math.round((1 - (p.y * 0.5 + 0.5)) * (e.renderer.domElement.height - 1))]);
        }
        if (row.length === heights.length) samples.push(row);
      }
    }
    const post = e._post, was = post.params.ssao.enabled;
    post.setParams({ ssao: { enabled: true } });  const gOn = PM.grab();
    post.setParams({ ssao: { enabled: false } }); const gOff = PM.grab();
    post.setParams({ ssao: { enabled: was } });   PM.grab();
    const acc = heights.map(() => 0), cnt = heights.map(() => 0);
    for (const row of samples) {
      for (let k = 0; k < row.length; k++) {
        const o = lum(PM.at(gOff, row[k][0], row[k][1]));
        if (o > 6) { acc[k] += lum(PM.at(gOn, row[k][0], row[k][1])) / o; cnt[k]++; }
      }
    }
    const r = acc.map((v, k) => v / Math.max(1, cnt[k]));
    return { n: samples.length, heights,
             aoRatio: r.map((v) => +v.toFixed(4)),
             dipPct: r.map((v) => +(100 * (1 - v / r[r.length - 1])).toFixed(2)) };
  };

  // ------------------------------------------------------------------- perf
  PM.perf = function perf(n) {
    n = n || 120;
    const e = E();
    for (let i = 0; i < 20; i++) e.render(0.016);
    const gl = e.renderer.getContext();
    gl.finish && gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) e.render(0.016);
    gl.finish && gl.finish();
    return +((performance.now() - t0) / n).toFixed(3);
  };

  // Post-only cost: total frame minus a scene-only render.
  PM.perfSplit = function perfSplit(n) {
    n = n || 120;
    const e = E();
    const gl = e.renderer.getContext();
    const full = PM.perf(n);
    for (let i = 0; i < 20; i++) { e.renderer.setRenderTarget(null); e.renderer.render(e.scene, e.camera); }
    gl.finish && gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { e.renderer.setRenderTarget(null); e.renderer.render(e.scene, e.camera); }
    gl.finish && gl.finish();
    const scene = (performance.now() - t0) / n;
    return { frameMs: full, sceneMs: +scene.toFixed(3), postMs: +(full - scene).toFixed(3) };
  };

  // --------------------------------------------------------- AO-buffer probe
  // Reads the SSAO buffer itself, before and after the denoise, and reports the
  // amplitude of the 1-texel-period (checkerboard) component introduced by the
  // kernel rotation. Also re-runs the denoise at a 2-texel stride -- the old
  // behaviour -- so the two are directly comparable inside ONE frame, with no
  // other module's concurrent edits in the way.
  //
  //   PM.aoDither()  -> { raw, blur1, blur2, size }
  //     raw    hf1 of the un-denoised AO
  //     blur1  hf1 after the shipped [1,2,2,2,1]/8 kernel at stride 1
  //     blur2  hf1 after the same kernel at stride 2 (never mixes parities)
  PM.aoDither = function aoDither() {
    const e = E();
    const p = e._post;
    const r = e.renderer;
    e.render(0.016);                       // populates uniforms + rtScene depth
    const W = p._aoW, H = p._aoH;

    const readAO = (rt) => {
      const px = new Uint8Array(W * H * 4);
      r.readRenderTargetPixels(rt, 0, 0, W, H, px);
      return px;
    };
    // hf1 over the interior, on the AO channel (r), skipping sky (g==0 => z 0).
    const hf = (px) => {
      let e1 = 0, n = 0, mean = 0, mx = 0;
      const at = (x, y) => px[((y * W) + x) * 4];
      const z = (x, y) => px[((y * W) + x) * 4 + 1];
      for (let y = 2; y < H - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
          if (z(x, y) === 0) continue;     // sky
          const c = at(x, y);
          const d = Math.abs(c - (at(x - 1, y) + at(x + 1, y)) / 2) +
                    Math.abs(c - (at(x, y - 1) + at(x, y + 1)) / 2);
          e1 += d / 2; if (d / 2 > mx) mx = d / 2;
          mean += c; n++;
        }
      }
      return { hf1: +(e1 / Math.max(1, n)).toFixed(3), max: mx,
               mean: +(mean / Math.max(1, n)).toFixed(2), n };
    };

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    // 1. raw SSAO (uniforms are still whatever the last render() set)
    p._blit(p.mSSAO, p.rtAO1);
    const raw = hf(readAO(p.rtAO1));

    const runBlur = (stride) => {
      const b = p.mAOBlur.uniforms;
      p._blit(p.mSSAO, p.rtAO1);
      b.tAO.value = p.rtAO1.texture;
      b.uDir.value.set(stride / W, 0);
      p._blit(p.mAOBlur, p.rtAO0);
      b.tAO.value = p.rtAO0.texture;
      b.uDir.value.set(0, stride / H);
      p._blit(p.mAOBlur, p.rtAO1);
      return hf(readAO(p.rtAO1));
    };
    const blur1 = runBlur(1);
    const blur2 = runBlur(2);

    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    e.render(0.016);                       // leave the buffers consistent
    return { size: [W, H], raw, blur1, blur2 };
  };

  window.PM = PM;
  return 'PM ready';
})();
