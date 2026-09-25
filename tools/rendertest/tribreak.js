// Dev-only: scene triangles / draw calls by category for the current camera,
// frustum-tested the way three does it. Never imported by src/.
//   await BVTRIS()  -> { buildings: [tris, draws], props: [...], ... }
window.BVTRIS = async function BVTRIS() {
  const THREE = await import('/vendor/three.module.js');
  const e = BV.engine, cam = e.camera;
  cam.updateMatrixWorld();
  const fr = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const cat = new Map();
  for (const m of e._buildings.values()) m.traverse((o) => cat.set(o, 'buildings'));
  for (const m of e._props.values()) cat.set(m, 'props');
  const tag = (obj, name) => obj && obj.traverse && obj.traverse((o) => { if (!cat.has(o)) cat.set(o, name); });
  tag(e._terrain && e._terrain.group, 'terrain');
  tag(e._roads && e._roads.group, 'roads');
  tag(e._water && e._water.group, 'water');
  tag(e._propFX && e._propFX.group, 'streetProps');
  const out = {};
  const sph = new THREE.Sphere();
  e.scene.updateMatrixWorld();
  e.scene.traverseVisible((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    const g = o.geometry; if (!g) return;
    if (o.frustumCulled) {
      if (o.isInstancedMesh) { if (!o.boundingSphere) o.computeBoundingSphere(); sph.copy(o.boundingSphere); }
      else { if (!g.boundingSphere) g.computeBoundingSphere(); sph.copy(g.boundingSphere); }
      sph.applyMatrix4(o.matrixWorld);
      if (!fr.intersectsSphere(sph)) return;
    }
    let n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    if (g.drawRange && g.drawRange.count !== Infinity) n = Math.min(n, g.drawRange.count);
    let t = n / 3;
    if (o.isInstancedMesh) t *= o.count;
    else if (g.isInstancedBufferGeometry) t *= (g.instanceCount === Infinity ? 1 : g.instanceCount);
    let c = cat.get(o);
    if (!c) c = (o.material === e._voxMat) ? 'dynamics' : (o.name || o.material && o.material.type || 'other');
    if (o.isInstancedMesh) c += '[inst]';
    const r = out[c] || (out[c] = [0, 0]);
    r[0] += Math.round(t); r[1]++;
  });
  return out;
};
