#!/usr/bin/env node
// Interaction check for the true-isometric ortho camera. Boots the game in
// headless Chrome (same way as shoot.mjs), lays out the demo city, then asserts:
//   - camera is Orthographic at the iso elevation (35.264 deg) on a 45-deg diagonal
//   - screenToTile(project(tile centre)) === tile, for many tiles, at all 4 rotations
//     and at min / mid / max zoom
//   - rotateStep snaps to 90-degree steps; zoom clamps to [min, max]
//   - panScreen keeps the grabbed ground point under the pointer
//   - focusAt(x,z) centres that tile
//   - the ghost preview sits on the tile the pointer picks
//   - BV.paint at a tile picked from the screen places a building there
//   - near/far enclose the whole scene (tallest tower never clipped)
//
//   node tools/rendertest/isocheck.mjs [--port 8351] [--w 1600 --h 900]
// Prints one JSON object; exit code 1 on any failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const W = +(args.w || 1600), H = +(args.h || 900);
const PORT = +(args.port || 8351);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'bviso-'));
const dbgPort = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run',
  '--mute-audio', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.error('chrome did not start'); process.exit(2); }
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
for (let i = 0; i < 120; i++) { await sleep(250); if (await evalJs('!!(window.BV && window.BV.engine)').catch(() => false)) break; }
await evalJs(`(async()=>{ (0,eval)(await (await fetch('/tools/rendertest/bootstrap.js',{cache:'no-store'})).text()); return 1; })()`);
try { await evalJs(`BVBOOT('iso').then(()=>1)`); } catch (err) {
  console.log(JSON.stringify({ pass: false, fails: ['boot: ' + (err.message || err)], errors: logs }, null, 1));
  cleanup(); process.exit(1);
}

const CHECK = `(() => {
  const e = BV.engine, cam = e.camera, T = 8, N = 80;
  const fails = [], notes = {};
  const V = cam.position.constructor;
  const settle = (n = 90) => { for (let i = 0; i < n; i++) e.render(0.016); };
  const rect = e.renderer.domElement.getBoundingClientRect();
  const toClient = (wx, wy, wz) => {
    const v = new V(wx, wy, wz).project(cam);
    return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height, v };
  };
  const pickSweep = (label) => {
    let ok = 0, bad = 0, tried = 0; const eg = [];
    for (let z = 0; z < N; z += 3) for (let x = 0; x < N; x += 3) {
      // tile centre AND a point near a tile corner (sub-tile exactness)
      for (const [fx, fz] of [[0.5, 0.5], [0.07, 0.93], [0.93, 0.07]]) {
        const c = toClient((x + fx) * T, 0, (z + fz) * T);
        if (Math.abs(c.v.x) > 1 || Math.abs(c.v.y) > 1) continue;   // off screen
        tried++;
        const t = e.screenToTile(c.x, c.y);
        if (t && t.x === x && t.z === z) ok++; else { bad++; if (eg.length < 4) eg.push({ x, z, fx, fz, got: t }); }
      }
    }
    notes['pick_' + label] = { tried, ok, bad };
    if (!tried) fails.push(label + ': nothing on screen');
    if (bad) fails.push(label + ': ' + bad + ' mispicks ' + JSON.stringify(eg));
  };
  const viewAngles = () => {
    const d = new V(0, 0, -1).applyQuaternion(cam.quaternion);
    return { elev: -Math.asin(d.y) * 180 / Math.PI, az: Math.atan2(-d.x, -d.z) * 180 / Math.PI };
  };

  // 1. camera type + iso angles
  if (!cam.isOrthographicCamera) fails.push('camera is not Orthographic');
  const a0 = viewAngles();
  notes.angles = a0;
  if (Math.abs(a0.elev - 35.2644) > 0.05) fails.push('elevation ' + a0.elev);
  if (Math.abs(((a0.az % 90) + 90) % 90 - 45) > 0.05) fails.push('azimuth not on a diagonal ' + a0.az);

  // 2. picking at the iso shot framing, then all 4 rotations
  pickSweep('iso');
  const azs = [];
  for (let r = 0; r < 4; r++) {
    e.rotateStep(1); settle();
    const a = viewAngles(); azs.push(Math.round(a.az * 100) / 100);
    if (Math.abs(((a.az % 90) + 90) % 90 - 45) > 0.05) fails.push('rot ' + r + ' az ' + a.az);
    pickSweep('rot' + (r + 1));
  }
  notes.rotAz = azs;
  e.rotateStep(-1); settle(); notes.rotBack = viewAngles().az;

  // 3. zoom clamps + picking at each extreme
  const v0 = e.getView();
  e.zoomBy(1e-4); settle(); notes.zoomMin = e._sDist;
  if (Math.abs(e._camDist - v0.zoomMin) > 1e-6) fails.push('zoom min clamp');
  pickSweep('zoomMin');
  e.zoomBy(1e4); settle(200); notes.zoomMax = e._sDist;
  if (Math.abs(e._camDist - v0.zoomMax) > 1e-6) fails.push('zoom max clamp');
  pickSweep('zoomMax');
  // whole map visible at max zoom
  let corners = 0;
  for (const [x, z] of [[0, 0], [640, 0], [0, 640], [640, 640]]) {
    const c = toClient(x, 0, z); if (Math.abs(c.v.x) <= 1 && Math.abs(c.v.y) <= 1) corners++;
  }
  notes.mapCornersVisibleAtMax = corners;
  if (corners !== 4) fails.push('whole map not visible at max zoom');

  // 4. focusAt centres the tile
  e.focusAt(20, 55, 115); settle(200);
  const cc = e.screenToTile(rect.left + rect.width / 2, rect.top + rect.height / 2);
  notes.focusCentre = cc;
  if (!cc || cc.x !== 20 || cc.z !== 55) fails.push('focusAt centre ' + JSON.stringify(cc));
  pickSweep('focus');

  // 5. panScreen anchors the grabbed ground point
  const p0 = { x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.6 };
  const hitA = new V(); e._rayToGround(p0.x, p0.y, hitA);
  e.panScreen(p0.x, p0.y, p0.x + 137, p0.y - 61);
  e._sTarget.copy(e._camTarget); e._applyCamera();
  const hitB = new V(); e._rayToGround(p0.x + 137, p0.y - 61, hitB);
  notes.panErr = hitA.distanceTo(hitB);
  if (notes.panErr > 1e-3) fails.push('pan drift ' + notes.panErr);

  // 6. ghost lines up with the picked tile
  const gc = { x: rect.left + rect.width * 0.55, y: rect.top + rect.height * 0.45 };
  const gt = e.screenToTile(gc.x, gc.y);
  e.setGhost(BV.models.treeModel ? BV.models.treeModel(0) : null, gt.x, gt.z, true);
  if (e._ghostMesh) {
    const g = e._ghostMesh.position;
    const back = toClient(g.x, 0, g.z); const bt = e.screenToTile(back.x, back.y);
    notes.ghost = { tile: gt, ghostTile: bt };
    if (!bt || bt.x !== gt.x || bt.z !== gt.z) fails.push('ghost misaligned');
  }
  e.setGhost(null);

  // 7. BV.paint on a grass tile picked from the screen
  const s = BV.sim.state;
  let target = null;
  for (let dy = -200; dy <= 200 && !target; dy += 16) for (let dx = -300; dx <= 300 && !target; dx += 16) {
    const t = e.screenToTile(rect.left + rect.width / 2 + dx, rect.top + rect.height / 2 + dy);
    if (t && s.map[t.z * N + t.x] === 0 && !s.occ?.[t.z * N + t.x]) target = t;
  }
  if (target) {
    const before = s.buildings.length;
    const r = BV.paint('small-house', target.x, target.z);
    const placed = s.buildings.slice(before).find((b) => b.x === target.x && b.z === target.z);
    notes.paint = { target, ok: r && r.ok, placed: !!placed };
    if (r && r.ok && !placed) fails.push('paint landed elsewhere');
  } else notes.paint = 'no free grass tile on screen';

  // 8. near/far never clip a building that is on screen. Worst case: min zoom,
  // the TALLEST building slid down until it leaves the bottom of the frame
  // (that is where geometry comes closest to the ortho camera plane).
  e.zoomBy(1e-4); settle();
  let tall = null, tallH = -1;
  for (const m of e._buildings.values()) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const h = m.geometry.boundingBox.max.y * m.scale.y;
    if (h > tallH) { tallH = h; tall = m; }
  }
  const worst = { tallest: tallH, minDepth: Infinity, maxDepth: -Infinity };
  if (tall) {
    const b = tall.geometry.boundingBox.clone().applyMatrix4(tall.matrixWorld);
    const fwd = new V(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0; fwd.normalize();
    for (let k = 0; k <= 400; k += 4) {
      // move the target AWAY from the camera (building slides down the screen)
      e._camTarget.set(tall.position.x + fwd.x * k, 0, tall.position.z + fwd.z * k);
      e._sTarget.copy(e._camTarget); e._applyCamera();
      let anyOn = false;
      const inv = cam.matrixWorldInverse;
      for (let i = 0; i < 8; i++) {
        const w = new V(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        const c = w.clone().project(cam);
        if (Math.abs(c.x) <= 1 && Math.abs(c.y) <= 1) anyOn = true;
        const d = -w.applyMatrix4(inv).z;
        worst.minDepth = Math.min(worst.minDepth, d); worst.maxDepth = Math.max(worst.maxDepth, d);
      }
      if (!anyOn && k > 0) break;
    }
  }
  // The far map corner at max zoom must be inside far.
  e.zoomBy(1e4); e._camTarget.set(320, 0, 320); e._sTarget.copy(e._camTarget); settle(200);
  let farMax = -Infinity;
  for (const [x, z] of [[0, 0], [640, 0], [0, 640], [640, 640]]) {
    farMax = Math.max(farMax, -new V(x, 0, z).applyMatrix4(cam.matrixWorldInverse).z);
  }
  worst.mapFarDepthAtMax = farMax;
  notes.depth = { ...worst, near: cam.near, far: cam.far };
  if (worst.minDepth < cam.near) fails.push('tower clipped by near ' + worst.minDepth);
  if (farMax > cam.far) fails.push('map beyond far ' + farMax);
  notes.ctxCamDist = e._ctx.camDist;
  return { pass: fails.length === 0, fails, notes };
})()`;
let res;
try { res = await evalJs(CHECK); } catch (err) { res = { pass: false, fails: [String(err.message || err)] }; }
res.errors = logs;
console.log(JSON.stringify(res, null, 1));
ws.close(); cleanup(); process.exit(res.pass ? 0 : 1);
