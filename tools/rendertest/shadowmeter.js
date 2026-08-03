// tools/rendertest/shadowmeter.js — framebuffer measurements for src/render/lighting.js.
//
// Dev-only. Never imported by src/. Load AFTER postmeasure.js:
//   (0,eval)(await (await fetch('/tools/rendertest/postmeasure.js',{cache:'no-store'})).text());
//   (0,eval)(await (await fetch('/tools/rendertest/shadowmeter.js',{cache:'no-store'})).text());
//   await SM.ready; SM.report()
//
// Provides window.SM:
//   SM.masks()      -> per-pixel class masks (road / terrain / building), rendered
//                      as an ID pass through the SAME camera, then eroded so DOF
//                      and AA edge pixels cannot leak between classes.
//   SM.pair()       -> two full frames: shadows ON and shadows OFF
//                      (rig.setParams({shadowStrength:0})), same dt, same time.
//   SM.report()     -> lit vs shadowed sRGB luma medians + ratio per class,
//                      the sub-luma-4 crush fraction, and the penumbra hf1
//                      (1-pixel-period energy) on building pixels, ON vs OFF.
//
// Classification is measured, not guessed: a pixel is SHADOWED if turning the
// cast shadow off brightens it by >25 %, LIT if that changes it by <2 %, and
// PENUMBRA in between. That is exactly the "caused purely by the shadow term"
// isolation the art director's numbers were built on.

(function () {
  const SM = {};
  const E = () => window.BV.engine;
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  SM.ready = (async () => { SM._THREE = await import('/vendor/three.module.js'); return true; })();

  function grab(dt) {
    if (!window.PM) throw new Error('SM needs postmeasure.js loaded first');
    return window.PM.grab(dt === undefined ? 0 : dt);
  }

  // ---------------------------------------------------------------- ID pass
  // One render per class with everything else hidden and a flat override
  // material. No post, no fog: this is a geometric coverage mask only.
  SM._rt = null;
  function classMask(pick) {
    const e = E();
    const THREE = SM._THREE;
    const r = e.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!SM._rt || SM._rt.width !== w || SM._rt.height !== h) {
      if (SM._rt) SM._rt.dispose();
      SM._rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        type: THREE.UnsignedByteType, depthBuffer: true,
      });
    }
    const rt = SM._rt;
    const hidden = [];
    e.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
        if (!pick(o)) { o.visible = false; hidden.push(o); }
      }
    });
    const prevTarget = r.getRenderTarget();
    const prevOverride = e.scene.overrideMaterial;
    const prevBg = e.scene.background;
    const prevAuto = r.autoClear;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const px = new Uint8Array(w * h * 4);
    try {
      e.scene.overrideMaterial = mat;
      e.scene.background = null;
      r.autoClear = false;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, true);
      r.render(e.scene, e.camera);
      r.readRenderTargetPixels(rt, 0, 0, w, h, px);
    } finally {
      for (const o of hidden) o.visible = true;
      e.scene.overrideMaterial = prevOverride;
      e.scene.background = prevBg;
      r.autoClear = prevAuto;
      r.setRenderTarget(prevTarget);
      mat.dispose();
    }
    // binary + SEPARABLE erode by `rad` (H pass then V pass) so AA/DOF edge
    // pixels are never classified. Separable because a 7x7 window over 3.7 M
    // device pixels x3 classes x4 shots is minutes of JS otherwise.
    const n = w * h;
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = px[i * 4] > 128 ? 1 : 0;
    const rad = 3;
    const tmp = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = rad; x < w - rad; x++) {
        let a = 1;
        for (let d = -rad; d <= rad; d++) { if (!raw[row + x + d]) { a = 0; break; } }
        tmp[row + x] = a;
      }
    }
    const out = new Uint8Array(n);
    for (let y = rad; y < h - rad; y++) {
      for (let x = 0; x < w; x++) {
        let a = 1;
        for (let d = -rad; d <= rad; d++) { if (!tmp[(y + d) * w + x]) { a = 0; break; } }
        out[y * w + x] = a;
      }
    }
    return { w, h, mask: out };
  }

  SM.masks = function masks() {
    const e = E();
    const roadMat = e._roads && e._roads.material;
    const terrGroup = e._terrain && e._terrain.group;
    const voxMat = e._matLib && e._matLib.voxel;
    const inTerrain = (o) => { let p = o; while (p) { if (p === terrGroup) return true; p = p.parent; } return false; };
    return {
      road: classMask((o) => o.material === roadMat),
      terrain: classMask((o) => inTerrain(o)),
      building: classMask((o) => o.material === voxMat),
    };
  };

  // ------------------------------------------------------------ normal pass
  // World-space normals through the same camera, so "rooftop" (n.y ~ 1) can be
  // separated from "facade". The art director's stipple probe was specifically
  // a sunlit ROOFTOP penumbra; a facade carries real self-shadow detail that
  // would otherwise be scored as shadow noise.
  const NRM_VERT = `
  varying vec3 vWN;
  void main() {
    vWN = normalize( mat3( modelMatrix ) * normal );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
  const NRM_FRAG = `
  varying vec3 vWN;
  void main() { gl_FragColor = vec4( normalize( vWN ) * 0.5 + 0.5, 1.0 ); }`;

  SM.normalPass = function normalPass() {
    const e = E();
    const THREE = SM._THREE;
    const r = e.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!SM._rt || SM._rt.width !== w || SM._rt.height !== h) {
      if (SM._rt) SM._rt.dispose();
      SM._rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        type: THREE.UnsignedByteType, depthBuffer: true,
      });
    }
    const mat = new THREE.ShaderMaterial({ vertexShader: NRM_VERT, fragmentShader: NRM_FRAG, fog: false });
    const prevTarget = r.getRenderTarget();
    const prevOverride = e.scene.overrideMaterial;
    const prevBg = e.scene.background;
    const px = new Uint8Array(w * h * 4);
    try {
      e.scene.overrideMaterial = mat;
      e.scene.background = null;
      r.setRenderTarget(SM._rt);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, true);
      r.render(e.scene, e.camera);
      r.readRenderTargetPixels(SM._rt, 0, 0, w, h, px);
    } finally {
      e.scene.overrideMaterial = prevOverride;
      e.scene.background = prevBg;
      r.setRenderTarget(prevTarget);
      mat.dispose();
    }
    return { w, h, px };
  };

  // --------------------------------------------------------------- ON / OFF
  SM.pair = function pair() {
    const rig = E()._lighting;
    const prev = rig.opts.shadowStrength;
    const on = grab(0);
    rig.setParams({ shadowStrength: 0 });
    const off = grab(0);
    rig.setParams({ shadowStrength: prev });
    grab(0);                                   // leave the canvas in the ON state
    return { on, off };
  };

  function median(arr) {
    if (!arr.length) return NaN;
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  }

  // hf1: mean |l - (lLeft+lRight)/2| + |l - (lUp+lDown)/2|, halved. Identical to
  // PM.ditherEnergy's hf1, but over an arbitrary pixel set.
  function hf1At(g, i) {
    const w = g.w, px = g.px;
    const p = i * 4;
    const l = lum(px[p], px[p + 1], px[p + 2]);
    const pl = (i - 1) * 4, pr = (i + 1) * 4, pu = (i - w) * 4, pd = (i + w) * 4;
    return 0.5 * (
      Math.abs(l - (lum(px[pl], px[pl + 1], px[pl + 2]) + lum(px[pr], px[pr + 1], px[pr + 2])) / 2) +
      Math.abs(l - (lum(px[pu], px[pu + 1], px[pu + 2]) + lum(px[pd], px[pd + 1], px[pd + 2])) / 2));
  }

  function hf1(g, idxs) {
    const w = g.w, px = g.px;
    let e1 = 0, n = 0;
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const p = i * 4;
      const l = lum(px[p], px[p + 1], px[p + 2]);
      const pl = (i - 1) * 4, pr = (i + 1) * 4, pu = (i - w) * 4, pd = (i + w) * 4;
      e1 += Math.abs(l - (lum(px[pl], px[pl + 1], px[pl + 2]) + lum(px[pr], px[pr + 1], px[pr + 2])) / 2);
      e1 += Math.abs(l - (lum(px[pu], px[pu + 1], px[pu + 2]) + lum(px[pd], px[pd + 1], px[pd + 2])) / 2);
      n++;
    }
    return n ? e1 / (2 * n) : NaN;
  }

  SM.report = function report(opts) {
    opts = opts || {};
    const m = SM.masks();
    const nrm = SM.normalPass();
    const { on, off } = SM.pair();
    const w = on.w, h = on.h, n = w * h;
    const res = { shot: opts.shot || '', w, h, classes: {} };

    const penumbraIdx = { building: [], road: [], terrain: [] };
    for (const key of ['road', 'terrain', 'building']) {
      const mask = m[key].mask;
      const litL = [], shL = [], umbraL = [];
      let nPen = 0;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const p = i * 4;
        const lOn = lum(on.px[p], on.px[p + 1], on.px[p + 2]);
        const lOff = lum(off.px[p], off.px[p + 1], off.px[p + 2]);
        if (lOff < 3) continue;                       // nothing to be shadowed
        const drop = 1 - lOn / lOff;
        if (drop > 0.25) shL.push(lOn);
        if (drop > 0.55) umbraL.push(lOn);            // core umbra only
        else if (drop < 0.02) litL.push(lOn);
        if (drop > 0.10 && drop < 0.85) { penumbraIdx[key].push(i); nPen++; }
      }
      const litM = median(litL), shM = median(shL), umM = median(umbraL);
      // Spread of the shadowed set. This is how you tell a sky-visibility model
      // from a flat cast-shadow multiplier: the former makes canyon pixels much
      // darker than open shadowed ground, so p90/p10 widens.
      const p = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN);
      const sh10 = p(shL, 0.10), sh90 = p(shL, 0.90);
      res.classes[key] = {
        shadowP10: +sh10.toFixed(1), shadowP90: +sh90.toFixed(1),
        shadowSpread: +(sh90 / Math.max(sh10, 1e-3)).toFixed(2),
        litPx: litL.length, shadowPx: shL.length, umbraPx: umbraL.length, penumbraPx: nPen,
        litMedian: +litM.toFixed(1), shadowMedian: +shM.toFixed(1),
        umbraMedian: +umM.toFixed(1),
        ratio: +(litM / Math.max(shM, 1e-3)).toFixed(2),
        umbraRatio: +(litM / Math.max(umM, 1e-3)).toFixed(2),
      };
    }

    // frame crush
    let below4 = 0, tot = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const l = lum(on.px[p], on.px[p + 1], on.px[p + 2]);
      if (l < 4) below4++;
      tot++;
    }
    res.frameBelowLuma4Pct = +(100 * below4 / tot).toFixed(2);

    // penumbra stipple, ON vs OFF, same pixels
    res.penumbraHf1 = {};
    for (const key of ['building', 'road', 'terrain']) {
      const idx = penumbraIdx[key];
      res.penumbraHf1[key] = {
        px: idx.length,
        on: +hf1(on, idx).toFixed(3),
        off: +hf1(off, idx).toFixed(3),
      };
    }

    // The art director's actual probe: a SMOOTH sunlit surface in penumbra —
    // i.e. rooftop, not a textured facade or a silhouette edge. Isolated by
    // keeping only penumbra pixels whose OFF-frame neighbourhood is already
    // quiet (per-pixel hf1 < 0.9), so whatever noise remains is the shadow's.
    res.smoothPenumbraHf1 = {};
    for (const key of ['building', 'road', 'terrain']) {
      const sel = [];
      const idx = penumbraIdx[key];
      for (let k = 0; k < idx.length; k++) if (hf1At(off, idx[k]) < 0.9) sel.push(idx[k]);
      const a = hf1(on, sel), b = hf1(off, sel);
      res.smoothPenumbraHf1[key] = {
        px: sel.length, on: +a.toFixed(3), off: +b.toFixed(3), excess: +(a - b).toFixed(3),
      };
    }

    // THE headline stipple number: sunlit ROOFTOP penumbra. Building pixels
    // whose world normal points up (n.y > 0.85 over a 3x3 neighbourhood, so a
    // roof edge cannot sneak in) and whose OFF-frame neighbourhood is quiet.
    {
      const bm = m.building.mask, sel = [];
      const upAt = (i) => (nrm.px[i * 4 + 1] - 128) / 127 > 0.85;
      for (let k = 0; k < penumbraIdx.building.length; k++) {
        const i = penumbraIdx.building[k];
        if (!bm[i]) continue;
        if (!(upAt(i) && upAt(i - 1) && upAt(i + 1) && upAt(i - w) && upAt(i + w))) continue;
        if (hf1At(off, i) > 0.9) continue;
        sel.push(i);
      }
      const a = hf1(on, sel), b = hf1(off, sel);
      res.rooftopPenumbraHf1 = {
        px: sel.length, on: +a.toFixed(3), off: +b.toFixed(3), excess: +(a - b).toFixed(3),
      };
    }
    return res;
  };

  // Convenience: boot a shot, settle, measure.
  // NOTE: no setTimeout anywhere in here. A backgrounded tab throttles chained
  // timers to ~1/minute, which turned a 3 s measurement into a 5-minute hang.
  // Settling is done by driving engine.render() directly instead.
  SM.shotReport = function shotReport(name) {
    window.BVDEMO.shot(name, window.__bvPlaza);
    for (let i = 0; i < 30; i++) E().render(0.016);   // settle PMREM / temporal state
    return SM.report({ shot: name });
  };

  SM.all = function all(names) {
    names = names || ['street', 'golden', 'hero', 'night'];
    const out = {};
    for (const nm of names) out[nm] = SM.shotReport(nm);
    return out;
  };

  // ---------------------------------------------------------------- A/B mode
  // Reconfigures the LIVE rig back to the pre-fix behaviour so before/after can
  // be measured in ONE session. Other agents are editing post.js / terrain.js /
  // water.js continuously, so a baseline captured half an hour ago is against a
  // different frame and is not a fair comparison.
  //
  //   legacy: indirect occlusion driven straight off the cast shadow
  //           (skyOpenFloor 1 disables the proximity gate), 16 nearest taps
  //           with a per-pixel kernel rotation, and the old low-sun fade.
  SM.legacy = function legacy(on) {
    const rig = E()._lighting;
    if (on) {
      rig.setParams({
        shadowIbl: 0.72, shadowAmbient: 0.55, shadowSpecular: 0.40,
        skyOpenFloor: 1.0, rotateBlock: 1, bilinearTaps: false,
        shadowFadeLo: 1.0, shadowFadeHi: 9.0, minShadowElevation: 4.5,
      });
      rig.uniforms.uCsmTaps.value.x = 16;
      rig.uniforms.uCsmTaps.value.y = 8;
    } else {
      rig.setParams({
        shadowIbl: 0.88, shadowAmbient: 0.64, shadowSpecular: 0.46,
        skyOpenFloor: 0.30, rotateBlock: 0, bilinearTaps: true,
        shadowFadeLo: 0.4, shadowFadeHi: 3.0, minShadowElevation: 2.0,
      });
      rig.uniforms.uCsmTaps.value.x = 8;
      rig.uniforms.uCsmTaps.value.y = 8;
    }
    return rig.uniforms.uCsmTaps.value.toArray().concat(rig.uniforms.uCsmSky.value.toArray());
  };

  SM.ab = function ab(shots) {
    shots = shots || ['street', 'golden', 'hero'];
    const out = { before: {}, after: {} };
    const pick = (r) => ({
      road: [r.classes.road.litMedian, r.classes.road.shadowMedian, r.classes.road.ratio],
      terrain: [r.classes.terrain.litMedian, r.classes.terrain.shadowMedian, r.classes.terrain.ratio],
      roofHf1: [r.rooftopPenumbraHf1.on, r.rooftopPenumbraHf1.off],
      darkPct: r.frameBelowLuma4Pct,
    });
    SM.legacy(true);
    for (const s of shots) out.before[s] = pick(SM.shotReport(s));
    SM.legacy(false);
    for (const s of shots) out.after[s] = pick(SM.shotReport(s));
    return out;
  };

  // Fire-and-forget: the full 4-shot sweep takes longer than a console eval
  // round-trip, so kick it off and poll `window.__SMRESULT`.
  SM.run = function run(names, tag) {
    window.__SMRESULT = null;
    window.__SMERR = null;
    Promise.resolve().then(() => SM.all(names))
      .then((r) => { window.__SMRESULT = { tag: tag || '', data: r }; },
        (e) => { window.__SMERR = String((e && e.stack) || e); });
    return 'running';
  };

  window.SM = SM;
})();
