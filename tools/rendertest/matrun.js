// tools/rendertest/matrun.js — one-shot driver for matmeter.js.
// Dev-only. Set window.__SHOT first, then:
//   (0,eval)(await (await fetch('/tools/rendertest/matrun.js',{cache:'no-store'})).text());
// Poll window.__R (result) / window.__ERR. Deliberately does NOT await, because
// a full boot + 40-frame settle + readback runs past the console's 30s budget.
window.__agentOwner = 'materials-checkerboard-glass';
window.__R = null; window.__ERR = null; window.__STAGE = 'start';
(async () => {
  try {
    (0, eval)(await (await fetch('/tools/rendertest/bootstrap.js', { cache: 'no-store' })).text());
    window.__STAGE = 'boot';
    // The splash is served by a module script; on a cold navigate it can be a
    // couple of seconds behind us. Retry until the engine exists.
    for (let i = 0; i < 40 && !window.BV; i++) {
      try { await BVBOOT(window.__SHOT); } catch (e) { /* not up yet */ }
      if (!window.BV) await new Promise((r) => setTimeout(r, 500));
    }
    await BVBOOT(window.__SHOT);
    window.__STAGE = 'meter';
    (0, eval)(await (await fetch('/tools/rendertest/matmeter.js', { cache: 'no-store' })).text());
    await MM.ready;
    window.__STAGE = 'settle';
    await MM.settle(40, 700);
    window.__STAGE = 'frame';
    const f = MM.frame();
    window.__f = f;
    window.__STAGE = 'report';
    window.__R = MM.report(window.__SHOT, f);
    window.__STAGE = 'done';
  } catch (err) { window.__ERR = String((err && err.stack) || err); window.__STAGE = 'error'; }
})();
'started ' + window.__SHOT;
