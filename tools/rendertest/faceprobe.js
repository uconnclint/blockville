// Dev-only: measure the key/fill balance on a plain WHITE voxel cube.
// Finds an open grass field (no buildings/trees/water within 3 tiles), stands
// the cube there, re-centres the camera on it (keeping the current zoom and
// rotation), and returns the CSS-px centres of its top / left / right faces so
// a PIL script can sample them. Lighting is global, so the location doesn't
// matter — only that nothing shadows the cube. Used for pieces/light.md.
// Never imported by src/.
//
//   BVFACEPROBE(6) -> { tile, faces: {top:[x,y], left:[x,y], right:[x,y]}, dpr }
window.BVFACEPROBE = function (sizeVox = 6) {
  const e = BV.engine, s = BV.sim.state, N = 80, T = 8;
  const WHITE = 31; // C.white palette index
  const blocks = [];
  for (let x = 0; x < sizeVox; x++) for (let y = 0; y < sizeVox; y++) for (let z = 0; z < sizeVox; z++) blocks.push([x, y, z, WHITE]);
  const model = { sx: sizeVox, sy: sizeVox, sz: sizeVox, blocks, tw: 1, td: 1 };

  const occupied = new Set();
  for (const b of s.buildings) for (let dz = 0; dz < (b.td || 2); dz++) for (let dx = 0; dx < (b.tw || 2); dx++) occupied.add((b.z + dz) * N + b.x + dx);
  const clear = (x, z) => {
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const X = x + dx, Z = z + dz;
      if (X < 0 || Z < 0 || X >= N || Z >= N) return false;
      const i = Z * N + X;
      if (s.map[i] !== 0 || occupied.has(i)) return false;
    }
    return true;
  };
  let best = null;
  for (let z = 4; z < N - 4 && !best; z++) for (let x = 4; x < N - 4; x++) if (clear(x, z)) { best = { x, z }; break; }
  if (!best) return { error: 'no clear 7x7 grass field on this map' };

  e.addBuilding('__probe', model, best.x, best.z);
  const mesh = e._buildings.get('__probe');
  mesh.updateMatrixWorld(true);
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  const V = b.min.constructor;
  const c = b.getCenter(new V());

  // Re-centre the camera on the cube (same zoom / azimuth / tilt).
  if (window.BVDEMO && BVDEMO.cam) BVDEMO.cam({ x: c.x, y: c.y, z: c.z });
  for (let i = 0; i < 6; i++) e.render(0.016);

  const cam = e.camera, dom = e.renderer.domElement.getBoundingClientRect();
  cam.updateMatrixWorld(true);
  const proj = (x, y, z) => { const v = new V(x, y, z).project(cam); return [(v.x + 1) / 2 * dom.width, (1 - v.y) / 2 * dom.height]; };
  const view = new V(); cam.getWorldDirection(view);
  const faces = { top: proj(c.x, b.max.y, c.z) };
  const sides = [['+x', [b.max.x, c.y, c.z], [1, 0, 0]], ['-x', [b.min.x, c.y, c.z], [-1, 0, 0]],
    ['+z', [c.x, c.y, b.max.z], [0, 0, 1]], ['-z', [c.x, c.y, b.min.z], [0, 0, -1]]]
    .filter(([, , n]) => n[0] * view.x + n[2] * view.z < 0)
    .map(([k, p]) => ({ k, s: proj(...p) })).sort((a, b2) => a.s[0] - b2.s[0]);
  faces.left = sides[0].s; faces.right = sides[1].s;
  return { tile: best, faces, dpr: window.devicePixelRatio };
};
