// Blockville multiplayer client — talks to the blockville-mp Worker/Durable Object.
// Pure networking; no DOM, no sim. main.js wires the callbacks to apply ops.

const MP_URL = 'wss://blockville-mp.csmcleod.workers.dev';

// Kid-friendly, easy-to-say room codes: ADJECTIVE-ANIMAL (e.g. "SUNNY-TIGER").
const ADJ = [
  'HAPPY', 'SUNNY', 'JOLLY', 'FUZZY', 'SILLY', 'BOUNCY', 'SPEEDY', 'SPARKLY',
  'MIGHTY', 'BRAVE', 'CLEVER', 'GIGGLY', 'COZY', 'ZIPPY', 'WOBBLY', 'CHEERY',
  'FLUFFY', 'LUCKY', 'SUPER', 'MEGA', 'TINY', 'JUMBO', 'SHINY', 'SNAPPY',
  'PLUCKY', 'DANDY', 'MERRY', 'NIFTY', 'PERKY', 'SUNNY',
];
const ANIMAL = [
  'TIGER', 'PANDA', 'FOX', 'BUNNY', 'KOALA', 'OTTER', 'PUPPY', 'KITTEN',
  'DRAGON', 'ROBOT', 'ROCKET', 'COMET', 'MONKEY', 'PENGUIN', 'DOLPHIN', 'TURTLE',
  'HEDGEHOG', 'NARWHAL', 'LLAMA', 'DINO', 'WHALE', 'BEAR', 'MOOSE', 'PARROT',
  'GECKO', 'WALRUS', 'BADGER', 'FALCON', 'BISON', 'YAK',
];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
export function makeCode() { return pick(ADJ) + '-' + pick(ANIMAL); }
export function normalizeCode(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}

function call(fn) { if (typeof fn === 'function') { try { return fn.apply(null, [].slice.call(arguments, 1)); } catch (_) {} } }

export class Net {
  constructor(handlers) {
    this.h = handlers || {};
    this.ws = null;
    this.code = null;
    this.you = null;
    this.primary = false;
    this.lastSeq = 0;
    this._closed = false;
    this._retry = 0;
  }

  connect(code) {
    this.code = normalizeCode(code);
    if (!this.code) return false;
    this._closed = false;
    this.lastSeq = 0;
    this._open();
    return true;
  }

  _open() {
    let ws;
    try { ws = new WebSocket(MP_URL + '/room/' + encodeURIComponent(this.code)); }
    catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => { this._retry = 0; call(this.h.onStatus, 'connected'); };
    ws.onmessage = (e) => this._onMsg(e.data);
    ws.onclose = () => {
      if (this._closed) return;
      call(this.h.onStatus, 'reconnecting');
      this._scheduleRetry();
    };
    ws.onerror = () => { /* onclose will follow */ };
  }

  _scheduleRetry() {
    if (this._closed) return;
    this._retry = Math.min(this._retry + 1, 6);
    setTimeout(() => { if (!this._closed) this._open(); }, 400 * this._retry);
  }

  _onMsg(raw) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.t === 'init') {
      this.you = m.you; this.primary = !!m.primary; this.lastSeq = m.snapSeq || 0;
      call(this.h.onInit, m);
      const ops = m.ops || [];
      for (const o of ops) { this.lastSeq = o.seq; call(this.h.onOp, o.op, o.seq); }
      call(this.h.onPeers, m.peers);
    } else if (m.t === 'op') {
      this.lastSeq = m.seq;
      call(this.h.onOp, m.op, m.seq);
    } else if (m.t === 'peers') {
      call(this.h.onPeers, m.n);
    } else if (m.t === 'primary') {
      this.primary = !!m.on;
    } else if (m.t === 'snapPlease') {
      call(this.h.onSnapRequest);
    }
  }

  sendOp(op) { this._send({ t: 'op', op }); }
  sendSnap(save) { this._send({ t: 'snap', save, uptoSeq: this.lastSeq }); }

  _send(o) {
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); } catch (_) {}
  }

  isOnline() { return !!this.ws && !this._closed; }
  isPrimary() { return !!this.primary; }

  leave() {
    this._closed = true;
    try { if (this.ws) this.ws.close(); } catch (_) {}
    this.ws = null; this.code = null; this.you = null; this.primary = false;
  }
}
