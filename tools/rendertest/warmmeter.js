// tools/rendertest/warmmeter.js — colour-temperature measurements for the
// lit surfaces of src/render/lighting.js. Dev-only; never imported by src/.
//
// Load AFTER postmeasure.js + shadowmeter.js:
//   (0,eval)(await (await fetch('/tools/rendertest/postmeasure.js',{cache:'no-store'})).text());
//   (0,eval)(await (await fetch('/tools/rendertest/shadowmeter.js',{cache:'no-store'})).text());
//   (0,eval)(await (await fetch('/tools/rendertest/warmmeter.js',{cache:'no-store'})).text());
//   await SM.ready; WM.shot('golden')
//
// Provides window.WM:
//   WM.report({shot})  -> per class (road/terrain/building):
//                         lit mean RGB + R/B, shadow mean RGB + R/B, and the
//                         DIRECT term (lit - shadow) + its R/B. Classification
//                         is SM's: shadows-off A/B, lit = <2 % change,
//                         shadowed = >25 % drop. Plus the light-budget probe.
//   WM.shot(name)      -> pose + settle + report
//   WM.all([names])    -> every shot
//   WM.budget()        -> lit RGB with (a) everything, (b) hemi+ambient muted,
//                         (c) sky IBL muted, (d) key muted. Shows where the
//                         blue actually comes from.
//   WM.lights()        -> what the lights ACTUALLY are at draw time (i.e. after
//                         engine._applySkyLighting has overwritten the rig).
//
// Muting is done with Object.defineProperty overrides, NOT by assignment:
// engine._applySkyLighting() rewrites sun/hemi/ambient colour+intensity from
// sky.js every single frame, so any A/B that assigns and then renders measures
// nothing at all.

(function () {
  const WM = {};
  const E = () => window.BV.engine;
  const R3 = (v) => Math.round(v * 1000) / 1000;
  const R1 = (v) => Math.round(v * 10) / 10;

  function grab(dt) { return window.PM.grab(dt === undefined ? 0 : dt); }

  // ---------------------------------------------------------------- override
  // Force a numeric property to a value through an accessor, so writes from
  // elsewhere in the frame are swallowed. Returns a restore fn.
  function pin(obj, key, value) {
    const own = Object.getOwnPropertyDescriptor(obj, key);
    let shadowVal = obj[key];
    Object.defineProperty(obj, key, {
      configurable: true,
      get() { return value; },
      set(v) { shadowVal = v; },
    });
    return function restore() {
      delete obj[key];
      if (own) Object.defineProperty(obj, key, own);
      else obj[key] = shadowVal;
    };
  }

  WM.pin = pin;

  // Materials that carry the sky PMREM.
  function iblMaterials() {
    const e = E();
    const out = [];
    if (e._matLib && e._matLib.voxel) out.push(e._matLib.voxel);
    if (e._terrain && e._terrain.material) out.push(e._terrain.material);
    if (e._roads && e._roads.material) out.push(e._roads.material);
    return out;
  }

  // ------------------------------------------------------------------ report
  // Mean RGB over the lit / shadowed pixel sets of each class.
  WM.measure = function measure(masks) {
    const e = E();
    const rig = e._lighting;
    const prev = rig.opts.shadowStrength;
    const on = grab(0);
    rig.setParams({ shadowStrength: 0 });
    const off = grab(0);
    rig.setParams({ shadowStrength: prev });
    grab(0);

    const w = on.w, h = on.h, n = w * h;
    const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const out = {};
    for (const key of ['road', 'terrain', 'building']) {
      const mask = masks[key].mask;
      let lr = 0, lg = 0, lb = 0, lc = 0;
      let sr = 0, sg = 0, sb = 0, sc = 0;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const p = i * 4;
        const lOn = lum(on.px[p], on.px[p + 1], on.px[p + 2]);
        const lOff = lum(off.px[p], off.px[p + 1], off.px[p + 2]);
        if (lOff < 3) continue;
        const drop = 1 - lOn / lOff;
        if (drop > 0.25) { sr += on.px[p]; sg += on.px[p + 1]; sb += on.px[p + 2]; sc++; }
        else if (drop < 0.02) { lr += on.px[p]; lg += on.px[p + 1]; lb += on.px[p + 2]; lc++; }
      }
      const L = [lr / lc, lg / lc, lb / lc];
      const S = [sr / sc, sg / sc, sb / sc];
      const D = [L[0] - S[0], L[1] - S[1], L[2] - S[2]];
      out[key] = {
        litPx: lc, shadowPx: sc,
        lit: L.map(R1), litRB: R3(L[0] / Math.max(L[2], 1e-3)),
        shadow: S.map(R1), shadowRB: R3(S[0] / Math.max(S[2], 1e-3)),
        direct: D.map(R1), directRB: R3(D[0] / Math.max(D[2], 1e-3)),
        litLuma: R1(lum(L[0], L[1], L[2])),
        shadowLuma: R1(lum(S[0], S[1], S[2])),
        ratio: R3(lum(L[0], L[1], L[2]) / Math.max(lum(S[0], S[1], S[2]), 1e-3)),
      };
    }
    // frame crush, so the "do not regress" number travels with every reading
    let below4 = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (lum(on.px[p], on.px[p + 1], on.px[p + 2]) < 4) below4++;
    }
    out.frameBelowLuma4Pct = R3(100 * below4 / n);
    return out;
  };

  WM.lights = function lights() {
    const e = E();
    const rig = e._lighting;
    const hex = (c) => '#' + c.getHexString(window.__THREE_SRGB || undefined);
    const g = { };
    g.sun = { color: '#' + e.sun.color.getHexString(), intensity: R3(e.sun.intensity) };
    g.hemi = {
      sky: '#' + e.hemi.color.getHexString(),
      ground: '#' + e.hemi.groundColor.getHexString(),
      intensity: R3(e.hemi.intensity),
    };
    g.ambient = { color: '#' + e.ambient.color.getHexString(), intensity: R3(e.ambient.intensity) };
    const lin = (c) => [R3(c.r), R3(c.g), R3(c.b)];
    g.linear = { sun: lin(e.sun.color), hemiSky: lin(e.hemi.color), ambient: lin(e.ambient.color) };
    g.sunRB_srgb = R3(parseInt(g.sun.color.slice(1, 3), 16) / Math.max(parseInt(g.sun.color.slice(5, 7), 16), 1));
    g.hemiRB_srgb = R3(parseInt(g.hemi.sky.slice(1, 3), 16) / Math.max(parseInt(g.hemi.sky.slice(5, 7), 16), 1));
    const k = e.sun.position.clone().sub(e._sunTarget.position).normalize();
    g.keyElevationDeg = R1(Math.asin(Math.max(-1, Math.min(1, k.y))) * 180 / Math.PI);
    g.keyDir = [R3(k.x), R3(k.y), R3(k.z)];
    g.rigElevationDeg = R1(rig.elevation * 180 / Math.PI);
    g.rigIsMoon = rig.isMoon;
    g.csmStrength = R3(rig.uniforms.uCsmMisc.value.x);
    g.envMapIntensity = iblMaterials().map((m) => R3(m.envMapIntensity));
    // sky.js's own view
    const s = e._sky && e._sky._out;
    if (s) {
      g.sky = {
        isMoon: s.isMoon,
        moonElevDeg: R1(Math.asin(Math.max(-1, Math.min(1, s.moonDir.y))) * 180 / Math.PI),
        sunElevDeg: R1(Math.asin(Math.max(-1, Math.min(1, s.sunDir.y))) * 180 / Math.PI),
        keyElevDeg: R1(Math.asin(Math.max(-1, Math.min(1, s.keyDir.y))) * 180 / Math.PI),
        intensity: R3(s.intensity),
        hemiIntensity: R3(s.hemiIntensity),
        ambientIntensity: R3(s.ambientIntensity),
      };
    }
    // horizontal-surface directional receipt: N.L for a flat roof/road
    g.horizontalNdotL = R3(Math.max(0, k.y));
    g.horizontalDirect = R3(Math.max(0, k.y) * e.sun.intensity);
    return g;
  };

  // Where does the light on a lit pixel come from? Four renders.
  WM.budget = function budget(masks) {
    const e = E();
    masks = masks || WM._masks || (WM._masks = window.SM.masks());
    const mats = iblMaterials();
    const res = {};
    res.all = WM.measure(masks);
    let un = [pin(e.hemi, 'intensity', 0), pin(e.ambient, 'intensity', 0)];
    res.noFill = WM.measure(masks);
    un.forEach((f) => f());
    const saved = mats.map((m) => m.envMapIntensity);
    mats.forEach((m) => { m.envMapIntensity = 0; });
    res.noIbl = WM.measure(masks);
    mats.forEach((m, i) => { m.envMapIntensity = saved[i]; });
    un = [pin(e.sun, 'intensity', 0)];
    res.noKey = WM.measure(masks);
    un.forEach((f) => f());
    const brief = {};
    for (const k of ['all', 'noFill', 'noIbl', 'noKey']) {
      brief[k] = {};
      for (const c of ['road', 'terrain', 'building']) {
        brief[k][c] = { lit: res[k][c].lit, rb: res[k][c].litRB };
      }
    }
    return brief;
  };

  WM.report = function report(opts) {
    opts = opts || {};
    const masks = window.SM.masks();
    WM._masks = masks;
    const r = WM.measure(masks);
    r.shot = opts.shot || '';
    r.lights = WM.lights();
    return r;
  };

  WM.shot = function shot(name) {
    window.BVDEMO.shot(name, window.__bvPlaza);
    for (let i = 0; i < 30; i++) E().render(0.016);
    return WM.report({ shot: name });
  };

  WM.all = function all(names) {
    names = names || ['golden', 'hero', 'street', 'night'];
    const out = {};
    for (const nm of names) out[nm] = WM.shot(nm);
    return out;
  };

  window.WM = WM;
})();
