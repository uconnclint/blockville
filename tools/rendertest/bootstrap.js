// Dev-only: one-call setup for visual review. Paste into the page console on a
// fresh load of index.html. Clicks through the splash, lays out the seeded
// reference city, hides the HUD, and poses a shot.
//
//   await BVBOOT('hero')     -> returns {plaza, shot, tris, calls, ms}
//
// Never imported by src/.
window.BVBOOT = async function BVBOOT(shotName = 'hero') {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (needle) => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      (x.getAttribute('aria-label') || '').includes(needle) || x.textContent.includes(needle));
    if (b) { b.click(); return true; }
    return false;
  };

  // Splash -> mode picker -> welcome. Each may already be dismissed.
  for (const step of ['Start Building', 'Everything', "Let's build"]) {
    if (click(step)) await sleep(250);
  }
  if (!window.BV) throw new Error('BV never booted');
  // Reference shots are taken at quality 2 with the frame-time governor off
  // (headless frames are slow; it must not change the look mid-run).
  if (BV.engine.setAutoQuality) BV.engine.setAutoQuality(false);
  if (BV.engine._quality !== 2) BV.engine.setQuality(2);
  if (BV.engine._post && BV.engine._post.params.aa.ssaa !== 1.75) BV.engine._post.setParams({ aa: { ssaa: 1.75 } });

  const src = await (await fetch('/tools/demo-city.js', { cache: 'no-store' })).text();
  (0, eval)(src);

  const t0 = performance.now();
  const plaza = window.__bvPlaza || BVDEMO.build();
  const ms = performance.now() - t0;

  // Pose FIRST — counting before the camera moves measures an empty frustum.
  BVDEMO.shot(shotName, plaza);

  // Count the SCENE pass, not the last fullscreen quad: reset the counter, then
  // render the scene once directly so info.render reflects real world geometry.
  const e = BV.engine;
  e.renderer.info.reset();
  e.renderer.setRenderTarget(null);
  e.renderer.render(e.scene, e.camera);
  const tris = e.renderer.info.render.triangles;
  const calls = e.renderer.info.render.calls;
  BVDEMO.shot(shotName, plaza);   // restore the framed view after the probe

  return { plaza, shot: shotName, tris, calls, buildMs: Math.round(ms) };
};
