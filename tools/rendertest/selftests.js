// Dev-only: run every module selfTest in the live page. BVSELF() ->
// { module: { pass, notes(first failing) } }. Never imported by src/.
window.BVSELF = async function BVSELF() {
  const out = {};
  const r = BV.engine.renderer;
  const run = async (name, path, fn = 'selfTest', args = []) => {
    try {
      const m = await import(path);
      const f = m[fn];
      if (typeof f !== 'function') { out[name] = 'no ' + fn; return; }
      const res = await f(...args);
      const pass = res === true || (res && res.pass === true) || (res && res.ok === true);
      const notes = res && (res.notes || res.errors || res.fail || res.failures);
      out[name] = { pass, notes: pass ? undefined : (Array.isArray(notes) ? notes.filter((n) => /fail|FAIL|✗|false/i.test(String(n))).slice(0, 5).concat(notes.slice(0, 3)) : notes || res) };
    } catch (e) { out[name] = { pass: false, error: String(e && e.message || e) }; }
  };
  await run('sim', '/src/sim.js', '_selfTest');
  await run('life', '/src/life.js', '_selfTest');
  await run('challenges', '/src/challenges.js', '_selfTest');
  await run('models', '/src/models.js', '_selfTest');
  await run('voxel', '/src/render/voxel.js');
  await run('materials', '/src/render/materials.js', 'selfTest', [r]);
  await run('lighting', '/src/render/lighting.js', 'selfTest', [r, BV.engine._lighting]);
  await run('post', '/src/render/post.js', 'selfTest', [r]);
  await run('sky', '/src/render/sky.js', 'selfTest', [r]);
  await run('terrain', '/src/render/terrain.js', 'selfTest', [r]);
  await run('roads', '/src/render/roads.js', 'selfTest', [r]);
  await run('water', '/src/render/water.js', 'selfTest', [{ renderer: r }]);
  await run('props', '/src/render/props.js', 'selfTest', [r]);
  return out;
};
