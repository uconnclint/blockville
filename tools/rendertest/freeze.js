// Dev-only: make a frame deterministic for pixel A/B (perf work). Hides the
// moving agents (cars, people, birds: voxel meshes that cast no shadow, and
// their contact-shadow blobs), pins every clock the renderer reads, renders a
// few settle frames and then freezes engine.render so the rAF loop cannot
// overwrite the canvas before capture. BVFREEZE() -> 1. Never imported by src/.
window.BVFREEZE = function BVFREEZE() {
  const E = BV.engine;
  E.scene.traverse((o) => {
    if (o.isMesh && o.material === E._voxMat && !o.castShadow && !o.parent.isGroup) o.visible = false;
  });
  if (E._blobPools) for (const P of E._blobPools.values()) P.im.visible = false;
  const real = E.__realRender || (E.__realRender = E.render.bind(E));
  E.render = () => {};
  for (let i = 0; i < 3; i++) {
    E._elapsed = 1000; E._waterUniform.value = 1000;
    real(0);
  }
  return 1;
};
