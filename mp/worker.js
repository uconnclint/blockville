// Blockville multiplayer — Cloudflare Worker + Durable Object.
// One Durable Object instance per room CODE (via getByName). Kids share a code;
// everyone who joins that code lands in the SAME shared city.
//
// Protocol (JSON messages over one WebSocket per player):
//   server → client:
//     {t:'init', you, primary, snapshot, snapSeq, ops:[{seq,op}], peers}  (on join)
//     {t:'op', seq, op}          a build/erase action, in server order
//     {t:'peers', n}             connected-player count changed
//     {t:'primary', on:true}     you are now responsible for snapshots
//     {t:'snapPlease'}           please send a fresh snapshot
//   client → server:
//     {t:'op', op}               do this action (server assigns seq, echoes to all)
//     {t:'snap', save, uptoSeq}  a full sim snapshot reflecting seq=uptoSeq
//
// Convergence: all clients start from the same snapshot and apply the SAME
// server-ordered op stream to the (deterministic) sim, so every city matches.

import { DurableObject } from 'cloudflare:workers';

const MAX_OPS = 400;                 // force a fresh snapshot past this many buffered ops
const EMPTY_TTL_MS = 2 * 60 * 60_000; // purge an empty room after 2 hours

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)');
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ops(seq INTEGER PRIMARY KEY, op TEXT)');
    });
  }

  _get(k, d) {
    const r = this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray();
    return r.length ? r[0].v : d;
  }
  _set(k, v) {
    this.ctx.storage.sql.exec(
      'INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);

    const socks = this.ctx.getWebSockets();
    const primary = socks.length === 1;                 // first player runs snapshots
    const id = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || String(Date.now());
    server.serializeAttachment({ id, primary });

    const snapshot = this._get('snapshot', '') || null;
    const snapSeq = parseInt(this._get('snapSeq', '0'), 10) || 0;
    const ops = this.ctx.storage.sql
      .exec('SELECT seq, op FROM ops WHERE seq>? ORDER BY seq', snapSeq).toArray()
      .map((r) => ({ seq: r.seq, op: safeParse(r.op) }))
      .filter((o) => o.op != null);

    try {
      server.send(JSON.stringify({ t: 'init', you: id, primary, snapshot, snapSeq, ops, peers: socks.length }));
    } catch (_) {}
    this._broadcastPeers();
    this.ctx.storage.deleteAlarm();   // room active again — cancel any purge

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const m = safeParse(raw);
    if (!m) return;

    if (m.t === 'op' && m.op) {
      const seq = (parseInt(this._get('seq', '0'), 10) || 0) + 1;
      this._set('seq', seq);
      this.ctx.storage.sql.exec('INSERT INTO ops(seq,op) VALUES(?,?)', seq, JSON.stringify(m.op));
      const out = JSON.stringify({ t: 'op', seq, op: m.op });
      for (const s of this.ctx.getWebSockets()) { try { s.send(out); } catch (_) {} }
      const cnt = this.ctx.storage.sql.exec('SELECT COUNT(*) AS c FROM ops').one().c;
      if (cnt > MAX_OPS) this._askSnapshot();
    } else if (m.t === 'snap') {
      const uptoSeq = parseInt(m.uptoSeq, 10) || 0;
      this._set('snapshot', typeof m.save === 'string' ? m.save : '');
      this._set('snapSeq', uptoSeq);
      this.ctx.storage.sql.exec('DELETE FROM ops WHERE seq<=?', uptoSeq);
    }
  }

  async webSocketClose(ws) {
    const att = safeAttach(ws);
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (att.primary && remaining.length) {
      const np = remaining[0];
      const a = safeAttach(np); a.primary = true;
      try { np.serializeAttachment(a); } catch (_) {}
      try { np.send(JSON.stringify({ t: 'primary', on: true })); } catch (_) {}
    }
    this._broadcastPeers(ws);
    if (remaining.length === 0) this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
  }

  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (_) {} }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      this.ctx.storage.sql.exec('DELETE FROM ops');
      this.ctx.storage.sql.exec('DELETE FROM meta');
    }
  }

  _broadcastPeers(exclude) {
    const socks = this.ctx.getWebSockets();
    const n = socks.filter((s) => s !== exclude).length;
    const out = JSON.stringify({ t: 'peers', n });
    for (const s of socks) { if (s === exclude) continue; try { s.send(out); } catch (_) {} }
  }
  _askSnapshot() {
    const socks = this.ctx.getWebSockets();
    const prim = socks.find((s) => safeAttach(s).primary) || socks[0];
    if (prim) try { prim.send(JSON.stringify({ t: 'snapPlease' })); } catch (_) {}
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function safeAttach(ws) { try { return ws.deserializeAttachment() || {}; } catch (_) { return {}; } }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/health') return new Response('ok', { headers: CORS });

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,40})$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('use a websocket', { status: 426, headers: CORS });
      }
      const code = m[1].toUpperCase();
      const stub = env.ROOM.getByName(code);
      return stub.fetch(request);
    }
    return new Response('Blockville multiplayer 🏗️', { headers: CORS });
  },
};
