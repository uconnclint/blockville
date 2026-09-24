// Dev-only: drop a plain white voxel cube next to the current shot target and
// report the screen-space (CSS px) centres of its three visible faces, so a
// PIL script can sample top / left / right face values. Used to tune the key
// light (see pieces/light.md). Never imported by src/.
window.BVFACEPROBE = function (sizeVox = 6) {
  const e = BV.engine, s = BV.sim.state, N = 80, T = 8;
  const W = 31; // C.white palette index
  const blocks = [];
  for (let x = 0; x < sizeVox; x++) for (let y = 0; y < sizeVox; y++) for (let z = 0; z < sizeVox; z++) blocks.push([x, y, z, W]);
  const model = { sx: sizeVox, sy: sizeVox, sz: sizeVox, blocks, tw: 1, td: 1 };
  // nearest grass tile to the camera target with no building
  // Aim at the tile under the SCREEN CENTRE (the camera target can sit off-centre).
  let tgt = e._camTarget || { x: 320, z: 320 };
  try { const r = e.renderer.domElement.getBoundingClientRect(); const t = e.screenToTile(r.left + r.width / 2, r.top + r.height / 2); if (t) tgt = { x: (t.x + 0.5) * T, z: (t.z + 0.5) * T }; } catch (err) {}
  const cx0 = Math.floor(tgt.x / T), cz0 = Math.floor(tgt.z / T);
  let best = null;
  for (let r = 0; r < 12 && !best; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const x = cx0 + dx, z = cz0 + dz; if (x < 0 || z < 0 || x >= N || z >= N) continue;
    if (s.map[z * N + x] === 0 && !s.buildings.some((b) => x >= b.x && x < b.x + (b.tw || 1) && z >= b.z && z < b.z + (b.td || 1))) { best = { x, z }; break; }
  }
  // Always use the screen-centre tile and float the cube above the rooftops
  // (lift units), so it's on-screen and nothing shadows it: it measures the
  // light itself, not the neighbourhood.
  best = { x: cx0, z: cz0 };
  e.addBuilding('__probe', model, best.x, best.z);
  const mesh = e._buildings.get('__probe');
  mesh.position.y += (window.BVFACEPROBE_LIFT != null ? window.BVFACEPROBE_LIFT : 10);
  mesh.updateMatrixWorld(true);
  const bb = new mesh.geometry.constructor().copy ? null : null;
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  const c = b.getCenter(new b.min.constructor()), sz = b.getSize(new b.min.constructor());
  const cam = e.camera, dom = e.renderer.domElement.getBoundingClientRect();
  const proj = (x, y, z) => { const v = new b.min.constructor(x, y, z).project(cam); return [ (v.x + 1) / 2 * dom.width, (1 - v.y) / 2 * dom.height ]; };
  const view = new b.min.constructor(); cam.getWorldDirection(view);
  const faces = { top: proj(c.x, b.max.y, c.z) };
  const sides = [['+x', [b.max.x, c.y, c.z], [1, 0, 0]], ['-x', [b.min.x, c.y, c.z], [-1, 0, 0]], ['+z', [c.x, c.y, b.max.z], [0, 0, 1]], ['-z', [c.x, c.y, b.min.z], [0, 0, -1]]]
    .filter(([, , n]) => n[0] * view.x + n[2] * view.z < 0)
    .map(([k, p]) => ({ k, s: proj(...p) })).sort((a, b2) => a.s[0] - b2.s[0]);
  faces.left = sides[0].s; faces.right = sides[1].s;
  return { tile: best, faces, dpr: window.devicePixelRatio };
};
