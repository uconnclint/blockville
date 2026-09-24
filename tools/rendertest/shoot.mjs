#!/usr/bin/env node
// Headless screenshot harness for visual review. Launches its own Chrome with a
// real GPU (ANGLE/Metal), boots the game, lays out the seeded demo city via
// BVBOOT, poses each requested shot, and writes PNGs. No npm deps — raw CDP.
//
//   node tools/rendertest/shoot.mjs --out DIR [--shots hero,street,...]
//        [--w 1600 --h 900] [--eval "js run after boot, before shots"]
//        [--port 8351] [--settle 1500] [--dpr 2]  (PNG is W*dpr x H*dpr)
//        [--post "js run right before capture; its value is printed as postResult"]
//        [--pre "js run after boot, BEFORE the demo city is built" — e.g.
//         "import('/src/render/voxel.js').then(m=>m.setVoxelDefaults({greedy:true}))"]
//
// Requires the dev server (tools/dev-server.py) on --port. Prints one JSON line
// per shot. Safe to run several at once (each gets its own Chrome + profile).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const OUT = args.out || 'shots';
const SHOTS = String(args.shots || 'hero').split(',');
const W = +(args.w || 1600), H = +(args.h || 900);
const PORT = +(args.port || 8351);
const SETTLE = +(args.settle || 1500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'bvshoot-'));
const dbgPort = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
// Never leave an orphaned GPU Chrome behind: clean up on any kill signal, and
// hard-stop the whole run after --timeout seconds (default 480).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
setTimeout(() => { console.log(JSON.stringify({ error: 'shoot.mjs watchdog timeout' })); cleanup(); process.exit(3); },
  1000 * +(args.timeout || 480)).unref();
// If our parent dies (e.g. the calling shell was killed), stop too.
const parentPid = process.ppid;
setInterval(() => { try { process.kill(parentPid, 0); } catch { cleanup(); process.exit(4); } }, 5000).unref();

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
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('ERR ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  // Module-graph failures (a 404'd or half-written import) never reach
  // Runtime.* — they arrive only as Log entries / failed requests, so without
  // these a broken import looked like "BV never booted" with errors: [].
  else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') logs.push('LOG ' + d.params.entry.text + (d.params.entry.url ? ' @ ' + d.params.entry.url : ''));
  else if (d.method === 'Network.loadingFailed' && !d.params.canceled) logs.push('NET ' + d.params.errorText + ' ' + (d.params.type || ''));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
// Default 2x (retina): crops then DOWNscale into blind pairs instead of being
// upscaled (upscaling our crops made every critic call our image 'soft').
const DPR = +(args.dpr || 2);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
let booted = false;
for (let i = 0; i < 480 && !booted; i++) { await sleep(250); booted = await evalJs('!!(window.BV && window.BV.engine)').catch(() => false); }
if (!booted) {
  // Fail loudly with whatever the page said, instead of letting every shot
  // report 'BV never booted' with an empty error list.
  for (const shot of SHOTS) console.log(JSON.stringify({ shot, error: 'BV never booted (window.BV missing after 120 s)', errors: logs.slice(0) }));
  ws.close(); cleanup(); process.exit(3);
}
await evalJs(`(async()=>{ (0,eval)(await (await fetch('/tools/rendertest/bootstrap.js',{cache:'no-store'})).text()); return 1; })()`);
if (args.pre) await evalJs(String(args.pre));
const gpu = await evalJs(`(()=>{const gl=BV.engine.renderer.getContext();const e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'?';})()`).catch(() => '?');

for (const shot of SHOTS) {
  const t0 = Date.now();
  let info;
  try {
    info = await evalJs(`BVBOOT(${JSON.stringify(shot)}).then(r=>{ try{ BVDEMO.hideUI(true);}catch(e){} return r; })`);
    if (args.eval) info.evalResult = await evalJs(String(args.eval));
    await sleep(SETTLE);
    info.fps = await evalJs(`new Promise(r=>{let n=0;const t=performance.now();const f=()=>{n++; if(performance.now()-t<1000) requestAnimationFrame(f); else r(n);};requestAnimationFrame(f);})`);
    const shotAgain = await evalJs(`(BVDEMO.shot(${JSON.stringify(shot)}, window.__bvPlaza), 1)`).catch(() => 0);
    if (args.post) info.postResult = await evalJs(String(args.post)).catch((e) => 'ERR ' + e.message);
    await sleep(400);
    const png = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${shot}.png`);
    writeFileSync(file, Buffer.from(png.result.data, 'base64'));
    console.log(JSON.stringify({ shot, file, ms: Date.now() - t0, gpu, ...info, errors: logs.splice(0) }));
  } catch (e) {
    console.log(JSON.stringify({ shot, error: String(e.message || e), errors: logs.splice(0) }));
  }
}
ws.close(); cleanup(); process.exit(0);
