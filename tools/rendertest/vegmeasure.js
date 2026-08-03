// Dev-only measurement harness for src/render/props.js (vegetation scatter).
//
//   (0,eval)(await (await fetch('/tools/rendertest/vegmeasure.js')).text());
//   await BVVEG()                    // reload props.js with its OWN defaults
//   await BVVEG({ density: 0.5 })    // ...or with an explicit density
//
// Rebuilds engine.js's Props with no `density` option, i.e. with whatever the
// module itself considers correct, then reports per-shot triangle / draw-call
// cost attributable to props (rendered with them, minus rendered without).
// Never imported by src/.
window.BVVEG = async function BVVEG(opts) {
  const e = window.BV.engine;
  const mod = await import('/src/render/props.js?bust=' + Date.now());

  if (e._propFX) e._propFX.dispose();
  const p = new mod.Props(e.scene, Object.assign({
    quality: e._quality,
    uniforms: { uNight: e._nightUniform },
  }, opts || {}));
  e._lighting.patchMaterial(p.material);
  p.material.envMapIntensity = 0.38;
  e._propFX = p;

  const state = window.BV.sim.state || window.BV.sim;
  p.setAnchors(e._roadAnchors || []);
  p.scatter(state);
  // Settle the built-up-field re-scatter now rather than over ~0.45 s of frames
  // (this pane throttles rAF while the document is hidden).
  if (p._autoRescatter) { p._occSettle = 0.001; p._autoRescatter(0.002); }
  p._bakeDirty();

  const out = {
    scatter: p.stats.scatter, woodTrees: p.stats.woodTrees | 0,
    streetTrees: p.stats.streetTrees | 0,
    scatterMs: +p.stats.scatterMs.toFixed(1), bakeMs: +p.stats.bakeMs.toFixed(1),
    shots: {},
  };

  for (const s of ['street', 'hero', 'region']) {
    window.BVDEMO.shot(s);
    p.update(0.016, { camera: e.camera });
    e.renderer.info.reset();
    e.renderer.setRenderTarget(null);
    e.renderer.render(e.scene, e.camera);
    const withP = { t: e.renderer.info.render.triangles, c: e.renderer.info.render.calls };
    const hidden = [];
    e.scene.traverse((o) => {
      if (o.isInstancedMesh && /^props:/.test(o.name) && o.visible) { o.visible = false; hidden.push(o); }
    });
    e.renderer.info.reset();
    e.renderer.render(e.scene, e.camera);
    const woP = { t: e.renderer.info.render.triangles, c: e.renderer.info.render.calls };
    for (const o of hidden) o.visible = true;

    const ms = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      e.renderer.render(e.scene, e.camera);
      e.renderer.getContext().finish();
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);

    out.shots[s] = {
      sceneTris: withP.t, sceneCalls: withP.c,
      propTris: withP.t - woP.t, propCalls: withP.c - woP.c,
      propInstances: p.stats.drawn, ms: +ms[6].toFixed(2),
    };
  }
  window.BVDEMO.shot('street');
  return out;
};

/** Per-mesh triangle breakdown for the currently posed shot. */
window.BVVEGDUMP = function BVVEGDUMP() {
  const p = window.BV.engine._propFX;
  const rows = [];
  for (let s = 0; s < p._meshes.length; s++) {
    const m = p._meshes[s];
    if (!m || !m.count) continue;
    const idx = m.geometry.getIndex();
    const per = idx ? idx.count / 3 : 0;
    rows.push({ mesh: m.name, n: m.count, triEach: per, tris: Math.round(per * m.count) });
  }
  rows.sort((a, b) => b.tris - a.tris);
  return rows;
};
