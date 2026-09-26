// Blockville — iconworker.js: Web Worker entry for the menu-icon factory.
// Receives icon jobs from icons.js, builds + meshes each model (iconmesh.js)
// and — where the browser supports a WebGL OffscreenCanvas — draws it here too
// (iconrender.js) and posts the finished PNG data URL. Otherwise it posts the
// mesh arrays for icons.js to draw on the main thread. One job at a time with
// a short pause between, so a second core isn't pinned on weak devices.
//
// Messages in:  {type:'jobs', jobs:[job…]}  append (duplicates ignored)
//               {type:'bump', keys:[…]}     move these keys to the front
// Messages out: {type:'icon', key, url}     finished PNG (data URL)
//               {type:'mesh', out}          see iconmesh.js (no OffscreenCanvas GL)
//               {type:'fail', key, err}

import { meshJob, transferables } from './iconmesh.js';
import { IconRenderer, canRenderOffscreen } from './iconrender.js';

const queue = [];
const seen = new Set();
let running = false;
let ren = null;
let canDraw = canRenderOffscreen();

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    // all done: release the GL context
    if (ren) { try { ren.dispose(); } catch (_) { /* ignore */ } ren = null; }
    return;
  }
  running = true;
  try {
    let out = null, err = null;
    try { out = meshJob(job); } catch (e) { err = String(e && e.message || e); }
    if (!out) { self.postMessage({ type: 'fail', key: job.key, err: err || 'no model' }); return; }
    let url = null;
    if (canDraw) {
      try { if (!ren) ren = new IconRenderer(); url = await ren.render(out); }
      catch (e) { canDraw = false; url = null; }
    }
    if (url) self.postMessage({ type: 'icon', key: out.key, url });
    else self.postMessage({ type: 'mesh', out }, transferables(out));
  } finally {
    running = false;
    setTimeout(pump, 8);
  }
}

self.onmessage = (ev) => {
  const d = ev.data || {};
  if (d.type === 'jobs') {
    for (const j of (d.jobs || [])) { if (j && j.key && !seen.has(j.key)) { seen.add(j.key); queue.push(j); } }
  } else if (d.type === 'bump') {
    const keys = d.keys || [];
    const want = new Set(keys);
    const front = [], rest = [];
    for (const j of queue) (want.has(j.key) ? front : rest).push(j);
    front.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    queue.length = 0; queue.push(...front, ...rest);
  }
  pump();
};
