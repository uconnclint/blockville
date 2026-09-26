// Blockville — icons.js: menu-icon factory (main-thread side).
//
// Every building card, sticker, favourite and a handful of menu glyphs get an
// ORIGINAL icon rendered from the game's own voxel models, so the pictures stay
// in sync with the art as the model builders change. Flow:
//
//   main.js  startIcons({ catalog, onIcon })     after boot
//     └─ Web Worker (iconworker.js): builds + meshes each model (iconmesh.js;
//        the builders cost up to ~600 ms per tower) and draws it on an
//        OffscreenCanvas (iconrender.js) → PNG data URL → back here
//     └─ onIcon(key, url) → ui.setArt(key, url) upgrades the emoji in place
//
// Nothing heavy runs on the main thread in the normal path. Fallbacks, each one
// job per idle callback, wanted keys first:
//   * worker can mesh but has no WebGL OffscreenCanvas → it posts the mesh and
//     iconrender.js draws it here on a private canvas;
//   * no module workers (e.g. a bundled single-file build without
//     globalThis.BV_ICON_WORKER_SRC) → mesh + draw here.
// No WebGL at all → nothing happens; the UI keeps its emoji fallbacks.
//
// Icon keys: 'cat-<catalog id>' for buildings, plus the MENU_JOBS keys below.

const ISO_AZ = Math.PI * 0.25;          // 45 deg diagonal (matches iconrender.js)

// Menu glyphs that have no PNG art yet (keys are what ui.js asks for).
export const MENU_JOBS = [
  { key: 'icon-move', kind: 'mini', name: 'hand' },
  { key: 'icon-target', kind: 'mini', name: 'target' },
  { key: 'icon-star', kind: 'mini', name: 'star' },
  { key: 'icon-map', kind: 'mini', name: 'map', az: ISO_AZ },
  { key: 'icon-rocket', kind: 'mini', name: 'rocket', az: ISO_AZ },
  { key: 'icon-key', kind: 'mini', name: 'key' },
  { key: 'icon-pencil', kind: 'mini', name: 'pencil' },
  { key: 'icon-trash', kind: 'mini', name: 'trash', az: ISO_AZ },
  { key: 'btn-multiplayer', kind: 'models', az: 0.3, list: [
    { fn: 'personModel', args: [3, 0], ox: -0.34 },
    { fn: 'personModel', args: [6, 0], ox: 0.34 },
  ] },
  { key: 'icon-balloon', kind: 'models', list: [{ fn: 'balloonModel', args: [0] }] },
  { key: 'icon-bridge', kind: 'models', list: [{ fn: 'bridgeModel', args: [5] }] },
];

export function iconJobs(catalog) {
  const jobs = MENU_JOBS.slice();
  const cats = catalog && typeof catalog === 'object' ? Object.keys(catalog) : [];
  for (const c of cats) {
    for (const e of (catalog[c] || [])) {
      if (e && e.id != null) jobs.push({ key: 'cat-' + e.id, kind: 'cat', id: String(e.id), v: 0 });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// startIcons({ catalog, onIcon(key, url), jobs? }) -> { want(keys), done(key) }
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// startIcons({ catalog, onIcon(key, url), jobs? }) -> { want(keys), done(key), stats }
// ---------------------------------------------------------------------------
export function startIcons(opts) {
  const o = opts || {};
  const onIcon = typeof o.onIcon === 'function' ? o.onIcon : () => {};
  const jobs = Array.isArray(o.jobs) ? o.jobs : iconJobs(o.catalog);
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const doneKeys = new Set();
  const stats = { worker: 0, mainRenders: 0, mainMs: 0, maxMs: 0 };
  const meshes = [];                 // worker meshes waiting for a main-thread draw
  const wanted = [];                 // fallback path: keys asked for first
  let ren = null, noGL = false, worker = null, mesher = null, rendMod = null, slot = 0;

  const idle = (fn) => (typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 60));

  function deliver(key, url) {
    doneKeys.add(key);
    if (url) { try { onIcon(key, url); } catch (e) { console.warn('[icons] onIcon failed', e); } }
  }

  async function renderer() {
    if (ren || noGL) return ren;
    try {
      rendMod = rendMod || await import('./iconrender.js');
      ren = new rendMod.IconRenderer();
    } catch (e) { noGL = true; ren = null; console.warn('[icons] no WebGL for icons', e); }
    return ren;
  }

  async function drawHere(out) {
    const r = await renderer();
    if (!r || !out) { if (out) doneKeys.add(out.key); return; }
    const t0 = performance.now();
    let url = null;
    try { url = await r.render(out); } catch (e) { console.warn('[icons] render failed', out.key, e); }
    const dt = performance.now() - t0;
    stats.mainRenders++; stats.mainMs += dt; stats.maxMs = Math.max(stats.maxMs, dt);
    deliver(out.key, url);
  }

  function nextLocalJob() {
    while (wanted.length) {
      const k = wanted.shift();
      if (!doneKeys.has(k) && byKey.has(k)) { doneKeys.add(k); return byKey.get(k); }
    }
    for (const j of byKey.values()) if (!doneKeys.has(j.key)) { doneKeys.add(j.key); return j; }
    return null;
  }
  const localLeft = () => { for (const k of byKey.keys()) if (!doneKeys.has(k)) return true; return false; };

  // one draw (or, without a worker, one mesh + draw) per idle slot
  function schedule() {
    if (slot || noGL) return;
    slot = idle(async () => {
      try {
        if (meshes.length) await drawHere(meshes.shift());
        else if (mesher) {
          const job = nextLocalJob();
          if (job) {
            let out = null;
            try { out = mesher.meshJob(job); } catch (e) { console.warn('[icons] mesh failed', job.key, e); }
            if (out) await drawHere(out);
          }
        }
      } finally {
        slot = 0;
        if (meshes.length || (mesher && localLeft())) schedule();
        else if (ren && !localLeft()) { ren.dispose(); ren = null; }   // free the GL context
      }
    });
  }

  function startLocal() {
    if (mesher) return;
    worker = null;
    import('./iconmesh.js').then((m) => { mesher = m; schedule(); })
      .catch((e) => { console.warn('[icons] mesher unavailable', e); });
  }

  function makeWorker() {
    const src = (typeof globalThis !== 'undefined') ? globalThis.BV_ICON_WORKER_SRC : null;
    if (typeof src === 'string' && src) {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      return new Worker(url);
    }
    return new Worker(new URL('./iconworker.js', import.meta.url), { type: 'module' });
  }

  try {
    if (typeof Worker !== 'function') throw new Error('no Worker');
    worker = makeWorker();
    worker.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'icon') { stats.worker++; deliver(d.key, d.url); }
      else if (d.type === 'mesh' && d.out) { meshes.push(d.out); schedule(); }
      else if (d.type === 'fail') { doneKeys.add(d.key); console.warn('[icons] no icon for', d.key, d.err); }
    };
    worker.onerror = (e) => {
      // module workers unsupported / failed to load → mesh on the main thread
      try { e.preventDefault(); } catch (_) { /* ignore */ }
      try { worker.terminate(); } catch (_) { /* ignore */ }
      startLocal();
    };
    worker.postMessage({ type: 'jobs', jobs });
  } catch (e) {
    startLocal();
  }

  return {
    // Move these icon keys to the front of the queue (e.g. an opened drawer).
    want(keys) {
      const ks = (Array.isArray(keys) ? keys : [keys]).filter((k) => byKey.has(k) && !doneKeys.has(k));
      if (!ks.length) return;
      if (worker) { try { worker.postMessage({ type: 'bump', keys: ks }); } catch (_) { /* ignore */ } }
      wanted.unshift(...ks);
    },
    done(key) { return doneKeys.has(key); },
    stats,
  };
}
