// Blockville models — DOWNTOWN: catalog 'downtown' offices + skyscrapers.
//
// Re-authored at res 4 (32 voxels / tile) to the "Isometric City Voxel" look
// (tools/rendertest/ART-DIRECTION.md). Every tower:
//   * sits on its own lot plinth (lotPlinth) dressed with paving, planters,
//     hedges, trees, lamps, benches, parking bays with little cars;
//   * has a distinct BASE (lobby / podium / colonnade + grand entrance), SHAFT
//     (articulated facade: piers, spandrels, framed windows, curtain wall with
//     mullions, balconies, setbacks) and CROWN (cornice, penthouse, water tank,
//     helipad, mast, sign, dome);
//   * keeps big faces flat and single-coloured so the greedy mesher merges them
//     — detail is spent on edges and silhouettes, not noise.
// Round 2: facades have real DEPTH — windows sit in bays between pilasters /
// fins standing 1-2 voxels proud (bayWall), or in recessed ribbons (ribbons);
// string courses + stepped cornices (course / cornice) split base, shaft and
// top. Recesses are never deeper than 1 (a 2-deep slot costs ~2.7x: wide AO).
// finish() seals every hidden interior cell so no inner faces are meshed.
// Glass: panes are painted glass (dtGlass*) shading from deep at the foot to
// sky-bright at the crown (skyGlass), with a glowing strip (201/200) at the
// head of each pane — a sky reflection by day, lit windows at night.
// Fronts are authored toward min-Z (flipZ puts them on +Z).

import { stampLotCar, stampPerson } from './vehicles.js';
import {
  C, grid, pk, facade, door, signPanel, pixelText, wallLamp,
  acBox, solarPanel, ventPipe, planter, bench, lotPlinth,
} from './core.js';

const R = 4;            // voxels per world unit
const FL = 12;          // storey height in voxels (3 world units)

// ---------------------------------------------------------------------------
// Geometry toolkit (fine-voxel coords)
// ---------------------------------------------------------------------------
const box = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 });
const ins = (B, d) => box(B.x0 + d, B.z0 + d, B.x1 - d, B.z1 - d);

function sides(g, B, which = 'fblr') {
  const out = [];
  if (which.includes('f')) out.push({ f: facade(g, 'front', B.z0), u0: B.x0, u1: B.x1, s: 'f' });
  if (which.includes('b')) out.push({ f: facade(g, 'back', B.z1), u0: B.x0, u1: B.x1, s: 'b' });
  if (which.includes('l')) out.push({ f: facade(g, 'left', B.x0), u0: B.z0, u1: B.z1, s: 'l' });
  if (which.includes('r')) out.push({ f: facade(g, 'right', B.x1), u0: B.z0, u1: B.z1, s: 'r' });
  return out;
}
// n windows of width w at `pitch`, centred between the margins
function bays(u0, u1, margin, pitch, w) {
  const a = u0 + margin, b = u1 - margin, avail = b - a + 1;
  if (avail < w) return [];
  const n = Math.floor((avail - w) / pitch) + 1;
  const s = a + ((avail - ((n - 1) * pitch + w)) >> 1);
  const r = []; for (let i = 0; i < n; i++) r.push(s + i * pitch);
  return r;
}
function rows(y0, y1, step, h) { const r = []; for (let y = y0; y + h - 1 <= y1; y += step) r.push(y); return r; }

// hollow walls y0..y1 + a roof deck at y1 inside the wall ring
// Walls are 3 voxels thick: recessed bays / lobbies cut into the outer two
// rings, and the solid ring behind them hides their back faces (a 1-thick
// shell exposes every recessed pane's back to the hollow core: ~3x the tris).
function shell(g, B, y0, y1, wall, roof, t = 1) {
  for (let k = 0; k < t; k++) g.walls(B.x0 + k, y0, B.z0 + k, B.x1 - k, y1, B.z1 - k, wall);
  g.box(B.x0 + 1, y1, B.z0 + 1, B.x1 - 1, y1, B.z1 - 1, roof != null ? roof : wall);
  return y1 + 1;
}
// ring course `out` voxels proud (only the outer ring), h tall
function ring(g, B, y, c, out = 1, h = 1) { g.walls(B.x0 - out, y, B.z0 - out, B.x1 + out, y + h - 1, B.z1 + out, c); }
// solid ledge / balcony slab: every ring from 1..out proud
function ledge(g, B, y, c, out = 2, h = 1) { for (let o = 1; o <= out; o++) ring(g, B, y, c, o, h); }
function parapetOn(g, B, y, h, c, cope) {
  g.walls(B.x0, y, B.z0, B.x1, y + h - 1, B.z1, c);
  if (cope != null) g.walls(B.x0, y + h, B.z0, B.x1, y + h, B.z1, cope);
  return y + h + (cope != null ? 1 : 0);
}

// A framed, recessed window with a glowing head strip ("sky" by day, lit at
// night). o: glass, hi (glow colour), hiRows, frame (ring in the wall plane),
// sill / lintel (proud, colour), mull ('v' | 'h' | 'cross')
function win(f, u0, y0, w, h, o) {
  const u1 = u0 + w - 1, y1 = y0 + h - 1;
  if (o.frame != null) f.box(u0 - 1, y0 - 1, 0, u1 + 1, y1 + 1, 0, o.frame);
  // Glass sits FLUSH by default: a 1-voxel recess makes the mesher's wide AO
  // vary in both directions over every pane (≈ +70 tris / window). Depth comes
  // from continuous piers / sill bands instead. o.recess = true to recess.
  const d = o.recess ? -1 : 0;
  if (d) f.clear(u0, y0, 0, u1, y1, 0);
  f.box(u0, y0, d, u1, y1, d, o.glass);
  const hr = o.hiRows != null ? o.hiRows : 2;
  if (hr > 0) f.box(u0, y1 - hr + 1, d, u1, y1, d, o.hi != null ? o.hi : C.winCool);
  const mc = o.mullC != null ? o.mullC : (o.frame != null ? o.frame : C.dtFrame);
  if (o.mull === 'v' || o.mull === 'cross') f.box(u0 + (w >> 1), y0, d, u0 + (w >> 1), y1, d, mc);
  if (o.mull === 'h' || o.mull === 'cross') f.box(u0, y0 + (h >> 1), d, u1, y0 + (h >> 1), d, mc);
  if (o.sill != null) f.box(u0 - 1, y0 - 1, 1, u1 + 1, y0 - 1, 1, o.sill);
  if (o.lintel != null) f.box(u0 - 1, y1 + 1, 1, u1 + 1, y1 + 1, 1, o.lintel);
}
// windows at explicit u starts on every chosen side (us(S) -> array)
function winAll(g, B, which, ys, w, h, o, us) {
  for (const S of sides(g, B, which)) {
    const U = us ? us(S) : bays(S.u0, S.u1, o.margin != null ? o.margin : 3, o.pitch, w);
    for (const y of ys) for (const u of U) win(S.f, u, y, w, h, o);
  }
}
// centred pixel text on a facade
function textC(f, uc, y, s, c, out = 2) {
  const W = s.length * 4 - 1;
  pixelText(f, f.rd > 0 ? uc - (W >> 1) : uc + (W >> 1), y, s, c, out);
}
// round clock face on a facade: gold rim, white dial, dark hands
function clockFace(f, uc, yc, r) {
  for (let du = -r; du <= r; du++) for (let dy = -r; dy <= r; dy++) {
    const d = du * du + dy * dy;
    if (d <= r * r + 1) f.set(uc + du, yc + dy, 0, d > (r - 1) * (r - 1) ? C.gold : C.signWhite);
  }
  for (let k = 0; k < r - 1; k++) f.set(uc, yc + k, 1, C.darkGray);
  for (let k = 0; k < r - 2; k++) f.set(uc + k, yc, 1, C.darkGray);
  f.set(uc, yc, 1, C.gold);
}

// ---------------------------------------------------------------------------
// Facade grammar (round 2): BASE / SHAFT / TOP, with real depth.
// Windows sit in RECESSED BAYS — continuous vertical slots cut `d` voxels
// into the wall between piers — so every facade reads as piers + reveals, not
// a flat grid. Continuous slots mesh as long strips (a punched recess per
// window costs ~3x more). String courses fill the slots and project, every
// few storeys; cornices step out 3 with a dark frieze under them.
// ---------------------------------------------------------------------------
// n bays of width bw between piers pw, corner piers >= cw, centred on [u0,u1]
function bayStarts(u0, u1, bw, pw, cw) {
  const span = u1 - u0 + 1;
  const n = Math.max(1, Math.floor((span - 2 * cw + pw) / (bw + pw)));
  const used = n * bw + (n - 1) * pw;
  const s = u0 + ((span - used) >> 1);
  const r = []; for (let i = 0; i < n; i++) r.push(s + i * (bw + pw));
  return r;
}
// Glass with a sky-reflection gradient: darker low on the tower, lighter high,
// plus a diagonal sheen streak (ref: tinted panels catch the sky).
// (r7) Critic r6: "tower shafts look soft and low in contrast … under a light
// haze". The old ramp lightened the glass toward the crown, so every tall
// shaft faded to pale blue at the top. Now the glass stays the DEEP base tone
// (tones[0]) from foot to crown, and only diagonal reflection streaks pick up
// the brighter tones (streak pane = brightest, its neighbour = mid): dark
// glass against light piers, like ref05's bank and hotel.
function skyGlass(tones, rowsTotal, streak = 7) {
  void rowsTotal;
  const n = tones.length, P = streak || 7;
  return (col, row) => {
    const d = (((col * 2 - row) % P) + P) % P;
    if (d === 0) return tones[n - 1];
    if (d === 1 && n > 2) return tones[1];
    return tones[0];
  };
}
// Recessed window bays on the chosen sides of B.
// o: { bw, pw=2, cw=2, d=1, y0, y1, floor=FL, sill=3, wh=7, glass | glassFn(col,row,S),
//      hi=winCool, hiRows=1, spandrel, mull:'v'|'h'|'cross'|'v2', mullC, us(S) }
function bayWall(g, B, which, o) {
  const d = o.d != null ? o.d : 1, F = o.floor || FL, sill = o.sill != null ? o.sill : 3, wh = o.wh || 7;
  const hr = o.hiRows != null ? o.hiRows : 1;
  for (const S of sides(g, B, which)) {
    const us = o.us ? o.us(S) : bayStarts(S.u0, S.u1, o.bw, o.pw != null ? o.pw : 2, o.cw != null ? o.cw : 2);
    // proud piers: the pier strips between (and outside) the bays stand `proud`
    // voxels out, so the reveal reads d + proud deep. o.pierC recolours them.
    if (o.proud) {
      const edges = [S.u0 - 1].concat(...us.map((u) => [u, u + o.bw - 1]), [S.u1 + 1]);
      for (let k = 0; k < edges.length; k += 2) {
        const a = edges[k] + 1, b = edges[k + 1] - 1;
        const a2 = k === 0 ? a - o.proud : a, b2 = k === edges.length - 2 ? b + o.proud : b;   // wrap the corners
        if (b >= a) S.f.box(a2, o.py0 != null ? o.py0 : o.y0, 1, b2, o.py1 != null ? o.py1 : o.y1, o.proud, o.pierC);
      }
    }
    for (let i = 0; i < us.length; i++) {
      const u = us[i], u1 = u + o.bw - 1;
      for (let k = 0; k < d; k++) S.f.clear(u, o.y0, -k, u1, o.y1, -k);
      S.f.box(u, o.y0, -d, u1, o.y1, -d, o.spandrel);
      for (let yb = o.y0, row = 0; yb + sill + wh - 1 <= o.y1; yb += F, row++) {
        const y = yb + sill, yt = y + wh - 1;
        const gc = o.glassFn ? o.glassFn(i, row, S) : o.glass;
        S.f.box(u, y, -d, u1, yt, -d, gc);
        if (hr > 0) S.f.box(u, yt - hr + 1, -d, u1, yt, -d, o.hi != null ? o.hi : C.winCool);
        const mc = o.mullC != null ? o.mullC : o.spandrel;
        if (o.mull === 'v' || o.mull === 'cross') S.f.box(u + (o.bw >> 1), y, -d, u + (o.bw >> 1), yt, -d, mc);
        if (o.mull === 'v2') { const a = u + Math.round(o.bw / 3), b = u + Math.round(2 * o.bw / 3) - 1; S.f.box(a, y, -d, a, yt, -d, mc); if (b > a + 1) S.f.box(b, y, -d, b, yt, -d, mc); }
        if (o.mull === 'h' || o.mull === 'cross') S.f.box(u, y + (wh >> 1) - 1, -d, u1, y + (wh >> 1) - 1, -d, mc);
      }
    }
  }
}
// Ribbon windows: one continuous glass band per storey, set `d` back, with
// thin mullions every `pitch`; solid corners `cw` wide. Long horizontal
// recesses merge well, so this is the cheap "modern office" facade.
// o: { y0, y1, floor=FL, sill=3, wh=7, d=1, cw=3, pitch=4, glass | glassFn(col,row,S),
//      hi=winCool, hiRows=1, mullC }
function ribbons(g, B, which, o) {
  const d = o.d != null ? o.d : 1, F = o.floor || FL, sill = o.sill != null ? o.sill : 3, wh = o.wh || 7;
  const cw = o.cw != null ? o.cw : 3, P = o.pitch || 4, hr = o.hiRows != null ? o.hiRows : 1;
  for (const S of sides(g, B, which)) {
    const a = S.u0 + cw, b = S.u1 - cw, c = (a + b) >> 1;
    if (o.spandrel != null) S.f.box(a, o.y0, 0, b, o.y1, 0, o.spandrel);
    for (let yb = o.y0, row = 0; yb + sill + wh - 1 <= o.y1; yb += F, row++) {
      const y = yb + sill, yt = y + wh - 1;
      for (let k = 0; k < d; k++) S.f.clear(a, y, -k, b, yt, -k);
      let col = 0, start = a;
      for (let u = a; u <= b + 1; u++) {
        const m = u > b || ((u - c) % P + P) % P === 0;
        if (!m) continue;
        if (u - 1 >= start) S.f.box(start, y, -d, u - 1, yt, -d, o.glassFn ? o.glassFn(col, row, S) : o.glass);
        if (u <= b) S.f.box(u, y, -d, u, yt, -d, o.mullC != null ? o.mullC : C.dtFrame);
        col++; start = u + 1;
      }
      if (hr > 0) for (let u = a; u <= b; u++) if (((u - c) % P + P) % P !== 0) S.f.box(u, yt - hr + 1, -d, u, yt, -d, o.hi != null ? o.hi : C.winCool);
    }
  }
}
// String course: an h-tall band projecting `out`, filling slots `d` deep.
function course(g, B, y, c, out = 1, h = 1, d = 1) {
  for (let k = -d; k <= out; k++) g.walls(B.x0 - k, y, B.z0 - k, B.x1 + k, y + h - 1, B.z1 + k, c);
}
// Cornice: dark frieze, then stepped mouldings out to `out`. Returns next y.
function cornice(g, B, y, main, frieze, out = 3, d = 1) {
  course(g, B, y, frieze, 0, 2, d);
  for (let k = 1; k <= out; k++) course(g, B, y + 1 + k, main, k, k === out ? 2 : 1, d);
  return y + out + 3;
}
// Cornice that also decks the roof over at its top, so rooftop kit placed at
// the returned y sits ON a roof instead of floating over a sunken deck.
function roofCornice(g, B, y, main, frieze, out = 3, d = 1) {
  const r = cornice(g, B, y, main, frieze, out, d);
  deck(g, ins(B, -out), r - 1);
  return r;
}
// Rusticated base: horizontal channels every `step` rows (1 voxel recessed).
function rustic(g, B, y0, y1, c, groove, step = 4) {
  g.walls(B.x0, y0, B.z0, B.x1, y1, B.z1, c);
  for (let y = y0 + step - 1; y <= y1; y += step) g.walls(B.x0, y, B.z0, B.x1, y, B.z1, groove);
}
// Big recessed shop / lobby glazing on one side between u0..u1, frame posts.
function lobbyGlass(S, u0, u1, y0, h, glass, frame, pitch = 5, d = 1) {
  for (let k = 0; k < d; k++) S.f.clear(u0, y0, -k, u1, y0 + h - 1, -k);
  S.f.box(u0, y0, -d, u1, y0 + h - 1, -d, glass);
  S.f.box(u0, y0 + h - 2, -d, u1, y0 + h - 1, -d, C.winCool);
  for (let u = u0; u <= u1; u += pitch) S.f.box(u, y0, -d, u, y0 + h - 1, -d, frame);
  S.f.box(u1, y0, -d, u1, y0 + h - 1, -d, frame);
}
// Rooftop clutter: condensers, vents, a hatch — ref roofs are never bare.
function roofKit(g, x0, z0, x1, z1, y, rng, n = 3) {
  const spots = [];
  for (let i = 0; i < n * 6 && spots.length < n; i++) {
    const w = 5 + ((rng() * 3) | 0), dd = 4 + ((rng() * 2) | 0);
    const x = x0 + ((rng() * Math.max(1, x1 - x0 - w)) | 0), z = z0 + ((rng() * Math.max(1, z1 - z0 - dd)) | 0);
    if (spots.some((s) => x < s[2] + 2 && x + w > s[0] - 2 && z < s[3] + 2 && z + dd > s[1] - 2)) continue;
    spots.push([x, z, x + w, z + dd]);
    acBox(g, x, y, z, { w, d: dd, h: 3 + ((rng() * 2) | 0) });
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Round 3 grammar. Critic r2: "flat extruded boxes repeating the same window
// stripe top to bottom; faces have almost no depth, so AO and shadow have
// nothing to catch". Depth now comes from MASSING — projecting bays, balcony
// notches, podiums, setbacks, heavy cornices — and from PUNCHED windows:
// glass 1 back in the wall with a proud sill whose bright top face draws a
// line under every window, plus floor ledges every few storeys.
// Measured on a 23-wide 8-storey shaft (ray AO): punched windows ≈ 5 tris
// each, + sill ≈ 8; a balcony notch ≈ 1.4k; a projecting bay ≈ 0.2k.
// Continuous proud piers are the costly thing (+8k per 1×1 tower): they are
// kept for the giant orders (bank, deco) and corner quoins.
// ---------------------------------------------------------------------------
// Punched windows, one row per storey, on the chosen sides of B.
// o: { y0, y1, floor=FL, sill=3, wh=7, w=3, pitch, margin=3, us(S) -> [u],
//      glass | glassFn(col,row,S), hi=winCool, hiRows=1, sillC, frameC,
//      slotC (fills the reveal between stacked windows -> a vertical slot),
//      mull 'v'|'h'|'cross', mullC, skip(S,u,row,col), sillIn (sill flush in the slot) }
function punch(g, B, which, o) {
  const F = o.floor || FL, sill = o.sill != null ? o.sill : 3, wh = o.wh || 7, w = o.w || 3;
  const hr = o.hiRows != null ? o.hiRows : 1;
  for (const S of sides(g, B, which)) {
    const U = o.us ? o.us(S) : bays(S.u0, S.u1, o.margin != null ? o.margin : 3, o.pitch, w);
    for (let yb = o.y0, row = 0; yb + sill + wh - 1 <= o.y1; yb += F, row++) {
      const y = yb + sill, yt = y + wh - 1;
      U.forEach((u, col) => {
        if (o.skip && o.skip(S, u, row, col)) return;
        const u1 = u + w - 1;
        if (o.frameC != null) S.f.box(u - 1, y - 1, 0, u1 + 1, yt + 1, 0, o.frameC);
        if (o.slotC != null) {
          const ys = Math.min(o.y1, yt + F - wh);
          if (ys > yt) { S.f.clear(u, yt + 1, 0, u1, ys, 0); S.f.box(u, yt + 1, -1, u1, ys, -1, o.slotC); }
        }
        S.f.clear(u, y, 0, u1, yt, 0);
        S.f.box(u, y, -1, u1, yt, -1, o.glassFn ? o.glassFn(col, row, S) : o.glass);
        if (hr > 0) S.f.box(u, yt - hr + 1, -1, u1, yt, -1, o.hi != null ? o.hi : C.winCool);
        const mc = o.mullC != null ? o.mullC : C.dtFrame;
        if (o.mull === 'v' || o.mull === 'cross') S.f.box(u + (w >> 1), y, -1, u + (w >> 1), yt, -1, mc);
        if (o.mull === 'h' || o.mull === 'cross') S.f.box(u, y + (wh >> 1), -1, u1, y + (wh >> 1), -1, mc);
        if (o.sillC != null) {
          if (o.sillIn) S.f.box(u, y - 1, 0, u1, y - 1, 0, o.sillC);            // flush slab across the slot
          else S.f.box(u - 1, y - 1, 1, u1 + 1, y - 1, 1, o.sillC);
        }
      });
    }
  }
}
// Balcony notch: cut box N out of body B for y0..y1 (a vertical void on a
// corner or mid-face), wall its inner faces in dark glass with door
// mullions, and hang a slab + rail every storey. The void is the single
// strongest depth cue a tower can have (ref05 apartment tower): a dark
// shadowed slot crossed by bright slab edges.
function notch(g, B, N, y0, y1, o = {}) {
  const F = o.floor || FL;
  const back = o.back != null ? o.back : C.dtGlassDark, slab = o.slab != null ? o.slab : C.dtFrame;
  const rail = o.rail !== undefined ? o.rail : C.dtGlassHi, mull = o.mull != null ? o.mull : slab;
  for (let y = y0; y <= y1; y++) for (let x = N.x0; x <= N.x1; x++) for (let z = N.z0; z <= N.z1; z++) g.del(x, y, z);
  const zA = Math.max(B.z0, N.z0 - 1), zB = Math.min(B.z1, N.z1 + 1), xA = Math.max(B.x0, N.x0 - 1), xB = Math.min(B.x1, N.x1 + 1);
  const wallX = (x) => { g.box(x, y0, zA, x, y1, zB, back); for (let z = N.z0 + 2; z < N.z1; z += 4) g.box(x, y0, z, x, y1, z, mull); };
  const wallZ = (z) => { g.box(xA, y0, z, xB, y1, z, back); for (let x = N.x0 + 2; x < N.x1; x += 4) g.box(x, y0, z, x, y1, z, mull); };
  if (N.x0 > B.x0) wallX(N.x0 - 1);
  if (N.x1 < B.x1) wallX(N.x1 + 1);
  if (N.z0 > B.z0) wallZ(N.z0 - 1);
  if (N.z1 < B.z1) wallZ(N.z1 + 1);
  // lid: the shell is hollow, so an open ceiling would unseal the interior
  // (finish() could no longer fill it: ~+10k tris of inner faces)
  for (let x = N.x0; x <= N.x1; x++) for (let z = N.z0; z <= N.z1; z++) if (!g.map.has(x + ',' + (y1 + 1) + ',' + z)) g.set(x, y1 + 1, z, slab);
  for (let y = y0, i = 0; y <= y1; y += F, i++) {
    g.box(N.x0, y, N.z0, N.x1, y, N.z1, slab);
    if (y === y0 && o.noFirst) continue;
    if (rail != null) {
      if (N.z0 <= B.z0) g.box(N.x0, y + 1, N.z0, N.x1, y + 2, N.z0, rail);
      if (N.z1 >= B.z1) g.box(N.x0, y + 1, N.z1, N.x1, y + 2, N.z1, rail);
      if (N.x0 <= B.x0) g.box(N.x0, y + 1, N.z0, N.x0, y + 2, N.z1, rail);
      if (N.x1 >= B.x1) g.box(N.x1, y + 1, N.z0, N.x1, y + 2, N.z1, rail);
    }
    if (o.plants && i % 2 === 1) g.box(N.x0 + 1, y + 1, N.z0 + 1, N.x0 + 2, y + 2, N.z0 + 2, C.bush);
  }
}
// Pixel text at k× scale (default 2: 6×10-voxel glyphs) — the r2 critic
// could not read BANK / TECH at 3×5.
function textBig(f, uc, y, s, c, out = 1, k = 2) {
  const W = (s.length * 4 - 1) * k;
  const u0 = f.rd > 0 ? uc - (W >> 1) : uc + (W >> 1);
  const v = { rd: f.rd, set(u, yy, o, col) {
    const du = (u - u0) * k, dy = (yy - y) * k;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) f.set(u0 + du + f.rd * a, y + dy + b, o, col);
  } };
  pixelText(v, u0, y, s, c, out);
}
// Dentil course: little blocks every 2 just under a cornice.
function dentils(g, B, y, c) {
  for (const S of sides(g, B)) for (let u = S.u0 - 1; u <= S.u1 + 1; u += 2) S.f.set(u, y, 1, c);
}
// Rooftop crowd (ref05 roofs are never bare): condensers, a water tank or a
// stair/lift house, vents, a hatch — scattered by rng inside the rectangle.
function roofCrowd(g, x0, z0, x1, z1, y, rng, o = {}) {
  const spots = roofKit(g, x0, z0, x1, z1, y, rng, o.ac != null ? o.ac : 3);
  const free = (x, z, r) => !spots.some((s) => x + r >= s[0] - 1 && x - r <= s[2] + 1 && z + r >= s[1] - 1 && z - r <= s[3] + 1);
  for (let i = 0, n = o.vents != null ? o.vents : 2; i < 12 && n > 0; i++) {
    const x = x0 + 1 + ((rng() * Math.max(1, x1 - x0 - 2)) | 0), z = z0 + 1 + ((rng() * Math.max(1, z1 - z0 - 2)) | 0);
    if (!free(x, z, 1)) continue;
    ventPipe(g, x, z, y, y + 2 + ((rng() * 3) | 0)); spots.push([x - 1, z - 1, x + 1, z + 1]); n--;
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Round 4 grammar. Critic r3: "tower facades are flat, repeated window grids
// on flat wall planes; ref05's bank / hotel / hospital have deep relief at
// several levels: pilasters, recessed window bays, balconies, cornice bands
// every few floors, a lobby that differs from the floors above, and roofs
// crowded with AC units, tanks and railings."
// pierBays is the ref05 hospital / hotel facade: the wall is carved into
// continuous vertical SLOTS (spandrel panels + glass rows 1 back) between
// PIERS standing `pd` proud, CORNER PIERS wider and prouder, and horizontal
// BANDS every few storeys flush with the pier faces, so every bay is a
// recessed frame 2-3 voxels deep. Measured (ray AO, 1x1, 8 storeys): slots +
// piers 2 + corner piers ≈ 1.8k; + a band every 2 storeys ≈ 3.9k. Per-window
// punched recesses cost ~2x a slot, horizontal ribbon recesses + bands ~5x.
// ---------------------------------------------------------------------------
// o: { y0, y1, bw, pw=2, cw=3, pd=1, cpd=pd+1, pierC, cornerC=pierC, spand,
//      floor=FL, sill=3, wh=7, glass | glassFn(col,row,S), hi, hiRows=1,
//      mull (pane pitch in the bay, 0 = none), mullC, bandEvery (storeys),
//      bandC=pierC, bandH=1, bandOut=pd, bandFrom (first band storey), us(S),
//      balc (fn(S,i,row) -> true: hang a 1-deep balcony slab + rail in the bay) }
function pierBays(g, B, which, o) {
  const F = o.floor || FL, sill = o.sill != null ? o.sill : 3, wh = o.wh || 7, hr = o.hiRows != null ? o.hiRows : 1;
  const pw = o.pw != null ? o.pw : 2, cw = o.cw != null ? o.cw : 3, pd = o.pd != null ? o.pd : 1;
  const cpd = o.cpd != null ? o.cpd : pd + 1, pierC = o.pierC, cornerC = o.cornerC != null ? o.cornerC : pierC;
  for (const S of sides(g, B, which)) {
    const us = o.us ? o.us(S) : bayStarts(S.u0, S.u1, o.bw, pw, cw);
    if (!us.length) continue;
    const first = us[0], last = us[us.length - 1] + o.bw - 1;
    us.forEach((u, i) => {
      const u1 = u + o.bw - 1;
      S.f.clear(u, o.y0, 0, u1, o.y1, 0);
      S.f.box(u, o.y0, -1, u1, o.y1, -1, o.spand);
      for (let yb = o.y0, row = 0; yb + sill + wh - 1 <= o.y1; yb += F, row++) {
        const y = yb + sill, yt = y + wh - 1;
        S.f.box(u, y, -1, u1, yt, -1, o.glassFn ? o.glassFn(i, row, S) : o.glass);
        if (hr > 0) S.f.box(u, yt - hr + 1, -1, u1, yt, -1, o.hi != null ? o.hi : C.winCool);
        if (o.mull) for (let m = u + o.mull; m < u1; m += o.mull + 1) S.f.box(m, y, -1, m, yt, -1, o.mullC != null ? o.mullC : o.spand);
        if (o.balc && o.balc(S, i, row)) {
          S.f.box(u - 1, yb, 0, u1 + 1, yb, Math.max(1, pd), o.balcC != null ? o.balcC : pierC);
          S.f.box(u, yb + 1, Math.max(1, pd), u1, yb + 2, Math.max(1, pd), o.railC != null ? o.railC : C.dtGlassHi);
        }
      }
      if (pd > 0 && i < us.length - 1) S.f.box(u1 + 1, o.y0, 1, us[i + 1] - 1, o.y1, pd, pierC);
    });
    if (cpd > 0) {
      S.f.box(S.u0 - cpd, o.y0, 1, first - 1, o.y1, cpd, cornerC);
      S.f.box(last + 1, o.y0, 1, S.u1 + cpd, o.y1, cpd, cornerC);
    }
    if (o.bandEvery) {
      const bh = o.bandH || 1, bo = o.bandOut != null ? o.bandOut : pd;
      for (let k = o.bandFrom || o.bandEvery; o.y0 + k * F - 1 < o.y1 - 2; k += o.bandEvery) {
        const y = o.y0 + k * F - bh;
        S.f.box(first, y, -1, last, y + bh - 1, 0, o.bandC != null ? o.bandC : pierC);
        if (bo > 0) S.f.box(first, y, 1, last, y + bh - 1, bo, o.bandC != null ? o.bandC : pierC);
      }
    }
  }
}
// ---------------------------------------------------------------------------
// Round 5 grammar. Critic r4: "the tower shafts are long runs of the same
// recessed dark-blue window strips on flat cream faces … ref05's bank, hotel
// and hospital fill every facade with framed windows and mullions, balconies
// and ledges on every floor". pierBays' continuous slots of dark glass over
// dark spandrels merged into one dark stripe per bay at gallery scale.
// framedBays keeps the pier / slot massing but breaks every slot into one
// DISCRETE window per storey: a light spandrel panel, a sill ledge filling the
// slot flush with the pier faces (a lit line + shadow on every floor), a white
// frame ring round bright sky-blue glass with a centre mullion, a pale sheen
// on the upper panes and a glowing head strip; optional balconies, hanging AC
// units and flower boxes per bay/storey vary it up the height.
// ---------------------------------------------------------------------------
// o: pierBays' keys (y0, y1, bw, pw, cw, pd, cpd, pierC, cornerC, spand, floor,
//    sill, wh, glass | glassFn, hi, hiRows, bandEvery, bandC, bandH, bandOut,
//    bandFrom, us) plus
//    frameC (window frame, default white), sillC (ledge in the slot; null = none),
//    sillOut (0 = flush ledge across the slot, 1 = proud sill under the window),
//    inset (glass inset from the slot sides, default 1 when bw >= 5),
//    mullC (centre mullion colour; null = frameC), noMull, sheen (upper-pane
//    colour), balc(S,i,row) -> balcony slab + rail, balcC, railC, balcD,
//    ac(S,i,row) -> AC unit under the window, box(S,i,row) -> flower box,
//    skipWin(S,i,row) -> blank spandrel instead of a window.
const DEEP = true;
function framedBays(g, B, which, o) {
  const F = o.floor || FL, sill = o.sill != null ? o.sill : 3, wh = o.wh || 7, hr = o.hiRows != null ? o.hiRows : 1;
  const pw = o.pw != null ? o.pw : 2, cw = o.cw != null ? o.cw : 3, pd = o.pd != null ? o.pd : 1;
  const cpd = o.cpd != null ? o.cpd : pd + 1, pierC = o.pierC, cornerC = o.cornerC != null ? o.cornerC : pierC;
  const frameC = o.frameC != null ? o.frameC : C.dtFrame;
  const sillC = o.sillC === undefined ? pierC : o.sillC, sillOut = o.sillOut || 0;
  const mullC = o.mullC != null ? o.mullC : frameC;
  const deep = o.deep != null ? o.deep : DEEP;
  for (const S of sides(g, B, which)) {
    const us = o.us ? o.us(S) : bayStarts(S.u0, S.u1, o.bw, pw, cw);
    if (!us.length) continue;
    const first = us[0], last = us[us.length - 1] + o.bw - 1;
    const inset = o.inset != null ? o.inset : (o.bw >= 5 ? 1 : 0);
    us.forEach((u, i) => {
      const u1 = u + o.bw - 1, a = u + inset, b = u1 - inset;
      S.f.clear(u, o.y0, 0, u1, o.y1, 0);
      S.f.box(u, o.y0, -1, u1, o.y1, -1, o.spand);
      for (let yb = o.y0, row = 0; yb + sill + wh - 1 <= o.y1; yb += F, row++) {
        const y = yb + sill, yt = y + wh - 1;
        if (o.skipWin && o.skipWin(S, i, row)) continue;
        // frame ring (or just a white head + jambs when the glass fills the slot)
        if (inset > 0 && o.jambs !== false) S.f.box(a - 1, y - 1, -1, b + 1, yt + 1, -1, frameC);
        else { S.f.box(a, yt + 1, -1, b, yt + 1, -1, frameC); if (inset > 0) S.f.box(a, y - 1, -1, b, y - 1, -1, frameC); }
        const gc = o.glassFn ? o.glassFn(i, row, S) : o.glass;
        // (r7) deep: the pane sits 2 back, one behind its frame ring, so every
        // window gets a real reveal whose AO draws a crisp dark line along its
        // head and jambs (critic r6: "cut deeper window recesses").
        const gd = deep ? -2 : -1;
        if (deep) S.f.clear(a, y, -1, b, yt, -1);
        S.f.box(a, y, gd, b, yt, gd, gc);
        // sheen: a reflection in the upper-LEFT pane only (it used to cover the
        // whole upper half of every window and washed the shaft out)
        const mid = (a + b) >> 1;
        if (o.sheen != null && wh >= 5 && gc !== o.sheen) S.f.box(a, y + (wh >> 1), gd, Math.max(a, mid - 1), yt, gd, o.sheen);
        if (hr > 0) S.f.box(a, yt - hr + 1, gd, b, yt, gd, o.hi != null ? o.hi : C.winCool);
        if (!o.noMull && b - a + 1 >= 4) S.f.box(mid, y, gd, mid, yt, gd, mullC);
        if (sillC != null) {
          if (sillOut > 0) S.f.box(a - 1, y - 1, 0, b + 1, y - 1, sillOut, sillC);
          else if (sillOut < 0) S.f.box(u, y - 1, -1, u1, y - 1, -1, sillC);    // painted sill (cheap)
          else S.f.box(u, y - 1, 0, u1, y - 1, 0, sillC);
        }
        if (o.balc && o.balc(S, i, row)) {
          const bd = o.balcD || Math.max(2, pd + 1);
          S.f.box(u - 1, yb, 0, u1 + 1, yb, bd, o.balcC != null ? o.balcC : pierC);
          S.f.box(u - 1, yb + 1, bd, u1 + 1, yb + 2, bd, o.railC != null ? o.railC : C.dtGlassHi);
          S.f.box(u - 1, yb + 3, bd, u1 + 1, yb + 3, bd, o.balcC != null ? o.balcC : pierC);
        } else if (o.ac && o.ac(S, i, row)) {
          S.f.box(b - 2, y - 4, 0, b, y - 2, 1, C.offwhite);
          S.f.box(b - 1, y - 3, 1, b - 1, y - 3, 1, C.metalDark);
        } else if (o.box && o.box(S, i, row)) {
          S.f.box(a, y - 2, 1, b, y - 1, 1, C.woodDark);
          for (let k = a; k <= b; k++) S.f.set(k, y, 1, (k + row) % 3 ? C.bush : pk(() => ((k * 7 + row * 3) % 10) / 10, [C.pink, C.red, C.yellow]));
        }
      }
      if (pd > 0 && i < us.length - 1) S.f.box(u1 + 1, o.y0, 1, us[i + 1] - 1, o.y1, pd, pierC);
    });
    if (cpd > 0) {
      S.f.box(S.u0 - cpd, o.y0, 1, first - 1, o.y1, cpd, cornerC);
      S.f.box(last + 1, o.y0, 1, S.u1 + cpd, o.y1, cpd, cornerC);
    }
    if (o.bandEvery) {
      const bh = o.bandH || 1, bo = o.bandOut != null ? o.bandOut : pd;
      for (let k = o.bandFrom || o.bandEvery; o.y0 + k * F - 1 < o.y1 - 2; k += o.bandEvery) {
        const y = o.y0 + k * F - bh;
        S.f.box(first, y, -1, last, y + bh - 1, 0, o.bandC != null ? o.bandC : pierC);
        if (bo > 0) S.f.box(S.u0 - cpd, y, 1, S.u1 + cpd, y + bh - 1, Math.max(bo, cpd), o.bandC != null ? o.bandC : pierC);
      }
    }
    // (r8) a continuous SILL LEDGE on every floor (critic r7: "each bay is one
    // repeated window strip and nothing marks the floors: no cornice, sill,
    // pilaster or balcony"). It runs the full face under every window row,
    // fills the slots and stands `ledgeOut` proud, so each storey gets a lit
    // top line + a shadow line, crossing the pilasters. Skipped on band rows.
    if (o.ledgeC != null) {
      const lo = o.ledgeOut != null ? o.ledgeOut : Math.max(1, pd + 1), bf = o.bandFrom || o.bandEvery;
      for (let yb = o.y0, row = 0; yb + sill + wh - 1 <= o.y1; yb += F, row++) {
        if (o.bandEvery && row >= bf && (row - bf) % o.bandEvery === 0) continue;
        if (row === 0 && o.ledgeFirst === false) continue;
        const y = yb + sill - 1;
        S.f.box(first, y, -1, last, y, 0, o.ledgeC);
        S.f.box(S.u0 - cpd, y, 1, S.u1 + cpd, y, lo, o.ledgeC);
      }
    }
  }
}
// Sky-blue window glass by row (the ref's glass is bright: mid blue low down,
// cyan-pale near the crown), never the old navy.
const SKY = [C.dtGlassDeep, C.dtGlass, C.dtGlassHi];

// Grand entrance on the min-Z face `zf` (ref05 hotel / hospital): a stepped
// stone terrace, a glass canopy on slim posts with a fascia carrying the name,
// a tall glass lobby recess with mullions and a lit transom, double doors,
// planters with shrubs either side, lamps and bollards.
// o: { xc, w (opening, odd), Y, h (lobby height), depth (canopy), frame,
//      fascia, text, textC, stone, planterC, glass, steps (default 2) }
function grandEntry(g, zf, o) {
  const Y = o.Y, w = o.w || 11, h = o.h || 14, x0 = o.xc - (w >> 1), x1 = x0 + w - 1;
  const frame = o.frame != null ? o.frame : C.dtFrame, stone = o.stone != null ? o.stone : C.dtStone;
  const fascia = o.fascia != null ? o.fascia : C.dtNavyPanel, dep = o.depth || 6, ns = o.steps != null ? o.steps : 2;
  const F = facade(g, 'front', zf);
  F.clear(x0 - 1, Y, 1, x1 + 1, Y + h, 3);                 // piers / plinth in front of the opening
  // lobby: glass 2 back with mullions + lit transom, cheeks keep the shell sealed
  alcove(F, x0, x1, Y, Y + h - 1, 2, o.glass != null ? o.glass : C.dtGlass, frame);
  F.box(x0, Y + h - 4, -2, x1, Y + h - 1, -2, C.winCool);
  F.box(x0, Y + h - 5, -2, x1, Y + h - 5, -2, frame);
  for (let x = x0 + 3; x < x1 - 1; x += 4) F.box(x, Y, -2, x, Y + h - 1, -2, frame);
  const dc = o.xc;
  F.box(dc - 3, Y + ns, -2, dc + 3, Y + ns + 9, -2, C.dtGlassDark);
  F.box(dc - 2, Y + ns + 1, -2, dc - 1, Y + ns + 8, -2, C.winCool); F.box(dc + 1, Y + ns + 1, -2, dc + 2, Y + ns + 8, -2, C.winCool);
  F.box(dc, Y + ns, -2, dc, Y + ns + 9, -2, frame);
  // stepped terrace + steps down to the lot
  for (let j = 0; j < ns; j++) g.box(x0 - 2 - (ns - 1 - j), Y + j, zf - 3 - 2 * (ns - 1 - j), x1 + 2 + (ns - 1 - j), Y + j, zf - 1, stone);
  g.box(x0, Y, zf, x1, Y + ns - 1, zf + 1, stone);
  // glass canopy: frame slab, glass top, fascia with the name, 2 posts
  const cy = Y + h + 1, cz0 = zf - dep;
  g.box(x0 - 3, cy, cz0, x1 + 3, cy, zf - 1, frame);
  g.box(x0 - 2, cy + 1, cz0 + 1, x1 + 2, cy + 1, zf - 1, C.dtGlassHi);
  g.box(x0 - 3, cy + 1, cz0, x1 + 3, cy + 3, cz0, fascia);
  g.walls(x0 - 3, cy + 1, cz0, x1 + 3, cy + 1, zf - 1, frame);
  for (const x of [x0 - 2, x1 + 2]) g.box(x, Y, cz0 + 1, x, cy - 1, cz0 + 1, C.metal);
  if (o.text) {
    // (r6) the name sits ON a dark sign board standing on the canopy, in a
    // contrasting colour (critic r5: "blue letters on blue and cream
    // backgrounds lack contrast"); the board is as wide as the name needs.
    const TW = o.text.length * 6 - 1, hw = Math.max((x1 - x0 + 6) >> 1, (TW + 5) >> 1);
    const bx0 = o.xc - hw, bx1 = o.xc + hw;
    g.box(bx0, cy + 1, cz0, bx1, cy + 11, cz0 + 1, fascia);
    g.box(bx0, cy + 11, cz0, bx1, cy + 11, cz0 + 1, frame);
    text5(facade(g, 'front', cz0), o.xc, cy + 3, o.text, o.textC != null ? o.textC : C.signWhite, 1, 1);
  }
  // planters + lamps flanking
  const pc = o.planterC != null ? o.planterC : C.stoneDark;
  for (const [a, b] of [[x0 - 9, x0 - 5], [x1 + 5, x1 + 9]]) {
    planter(g, a, zf - 7, b, zf - 3, Y, { box: pc, flowers: [C.pink, C.yellow, C.signWhite] });
    g.box(a + 1, Y + 3, zf - 6, b - 1, Y + 4, zf - 4, C.bush);
  }
  if (o.lamps !== false) for (const x of [x0 - 11, x1 + 11]) lamp(g, x, Y, zf - 4, 10);
}
// Dress a lot strip beside a building (critic r4: "a fully dressed ground
// floor on each one … planters and parked cars on the lot"). The strip's
// long axis decides the layout: >= 10 across -> nose-in stalls with white
// lines; >= 5 -> a parallel-parking lane with white ticks; narrower -> a
// hedge with shrubs. Trees cap the ends when there is room.
function stripLot(g, x0, z0, x1, z1, rng, o = {}) {
  const alongZ = (z1 - z0) >= (x1 - x0), W = alongZ ? x1 - x0 + 1 : z1 - z0 + 1, Y = 2;
  const p = o.p != null ? o.p : 0.75;
  if (W >= 10) {
    if (alongZ) { const xs = x0 + ((W - 10) >> 1); g.box(xs, 1, z0, xs + 9, 1, z1, C.lotAsphalt); parkCol(g, z0 + 1, z1 - 1, xs, 10, rng, p); }
    else { const zs = z0 + ((W - 10) >> 1); g.box(x0, 1, zs, x1, 1, zs + 9, C.lotAsphalt); parkRow(g, x0 + 1, x1 - 1, zs, 10, rng, p); }
  } else if (W >= 5) {
    const s = (alongZ ? x0 : z0) + ((W - 5) >> 1);
    if (alongZ) {
      g.box(s, 1, z0, s + 4, 1, z1, C.lotAsphalt);
      for (let z = z0 + 1; z + 10 <= z1; z += 11) { g.box(s, 1, z, s + 4, 1, z, C.lotLine); if (rng() < p) car(g, s - 1, Y, z + 1, false, pk(rng, CAR_COLS)); }
    } else {
      g.box(x0, 1, s, x1, 1, s + 4, C.lotAsphalt);
      for (let x = x0 + 1; x + 10 <= x1; x += 11) { g.box(x, 1, s, x, 1, s + 4, C.lotLine); if (rng() < p) car(g, x + 1, Y, s - 1, true, pk(rng, CAR_COLS)); }
    }
  } else if (W >= 2) {
    if (alongZ) hedge(g, x0, Y, z0 + 2, x1, z1 - 2, 3); else hedge(g, x0 + 2, Y, z0, x1 - 2, z1, 3);
  }
}
// (r6) Kerbside lay-by along the lot's front edge: asphalt, white ticks and
// parallel-parked cars / taxis right up to the kerb (critic r5: "the
// reference lots are packed with parking … and vehicles right up to the kerb").
function kerbCars(g, x0, x1, rng, z0 = 1, p = 0.85) {
  g.box(x0, 1, z0, x1, 1, z0 + 4, C.lotAsphalt);
  for (let x = x0 + 1; x + 10 <= x1; x += 11) {
    g.box(x, 1, z0, x, 1, z0 + 4, C.lotLine);
    if (rng() < p) car(g, x + 1, 2, z0 - 1, true, rng() < 0.35 ? C.taxiYellow : pk(rng, CAR_COLS));
  }
  g.box(x1, 1, z0, x1, 1, z0 + 4, C.lotLine);
}
// Service corner: dumpsters, a bike rack, crates (backs get dressed too).
function service(g, x, z, rng) {
  g.box(x, 2, z, x + 4, 4, z + 2, C.roofGreen); g.box(x, 5, z, x + 4, 5, z + 2, C.darkGray);
  g.box(x + 6, 2, z, x + 8, 3, z + 2, C.wood); g.set(x + 7, 4, z + 1, C.woodDark);
  void rng;
}
// Parking bay on the lot: asphalt, white stall lines, kerb, cars.
// Stalls run along x (cars nose-in, pointing in z) between x0..x1, z0..z0+9.
function parkingX(g, x0, x1, z0, rng, p = 0.7, disabled = false) {
  g.box(x0, 1, z0, x1, 1, z0 + 9, C.lotAsphalt);
  parkRow(g, x0, x1, z0, 10, rng, p);
  if (disabled) { const x = x0 + 3; g.box(x, 1, z0 + 3, x + 2, 1, z0 + 5, C.blue); g.set(x + 1, 1, z0 + 4, C.signWhite); }
}
// Stalls stacked along z at x0..x0+9 (cars point along x).
function parkingZ(g, z0, z1, x0, rng, p = 0.7) {
  g.box(x0, 1, z0, x0 + 9, 1, z1, C.lotAsphalt);
  parkCol(g, z0, z1, x0, 10, rng, p);
}

// A recess `d` deep (d >= 2) that keeps the hollow shell sealed: opening
// u0..u1 × y0..y1, glass/back at -d, cheeks + lintel at -1..-(d-1).
function alcove(f, u0, u1, y0, y1, d, back, cheek) {
  f.clear(u0, y0, 0, u1, y1, 1 - d);
  f.box(u0, y0, -d, u1, y1, -d, back);
  if (d > 1) {
    f.box(u0 - 1, y0, -1, u0 - 1, y1 + 1, 1 - d, cheek); f.box(u1 + 1, y0, -1, u1 + 1, y1 + 1, 1 - d, cheek);
    f.box(u0, y1 + 1, -1, u1, y1 + 1, 1 - d, cheek);
  }
}
// roof deck inside B's wall ring at y
function deck(g, B, y, c = C.roofGray) { g.box(B.x0 + 1, y, B.z0 + 1, B.x1 - 1, y, B.z1 - 1, c); }
// Lobby storey that differs from the shaft (ref05 hotel / hospital / bank):
// a granite plinth course, corner piers + intermediate piers continuing the
// shaft's rhythm down as square columns standing `pd` proud, and deep lobby
// glass 2 back between them (dark glass, lit transom), a cornice band on top.
// o: { y0, h, bw, pw=2, cw=3, pd=1, cpd, pierC, plinthC, glass, transom, bandC, us(S), skip(S,i) }
function lobbyBays(g, B, which, o) {
  const pw = o.pw != null ? o.pw : 2, cw = o.cw != null ? o.cw : 3, pd = o.pd != null ? o.pd : 1;
  const cpd = o.cpd != null ? o.cpd : pd + 1, y1 = o.y0 + o.h - 1;
  for (const S of sides(g, B, which)) {
    const us = o.us ? o.us(S) : bayStarts(S.u0, S.u1, o.bw, pw, cw);
    if (!us.length) continue;
    const first = us[0], last = us[us.length - 1] + o.bw - 1;
    us.forEach((u, i) => {
      const u1 = u + o.bw - 1;
      if (!(o.skip && o.skip(S, i))) {
        alcove(S.f, u, u1, o.y0, y1 - 2, 2, o.glass != null ? o.glass : C.dtGlassDark, o.pierC);
        S.f.box(u, y1 - 5, -2, u1, y1 - 3, -2, o.transom != null ? o.transom : C.winCool);
        S.f.box(u, y1 - 6, -2, u1, y1 - 6, -2, o.mullC != null ? o.mullC : C.dtFrame);
        for (let m = u + 3; m < u1 - 1; m += 4) S.f.box(m, o.y0, -2, m, y1 - 7, -2, o.mullC != null ? o.mullC : C.dtFrame);
        if (o.sheen !== false) S.f.box(u, y1 - 11, -2, u1, y1 - 7, -2, C.dtGlassHi);
      }
      if (pd > 0 && i < us.length - 1) S.f.box(u1 + 1, o.y0, 1, us[i + 1] - 1, y1, pd, o.pierC);
    });
    if (cpd > 0) {
      S.f.box(S.u0 - cpd, o.y0, 1, first - 1, y1, cpd, o.pierC);
      S.f.box(last + 1, o.y0, 1, S.u1 + cpd, y1, cpd, o.pierC);
    }
    if (o.plinthC != null) S.f.box(S.u0 - cpd, o.y0, 0, S.u1 + cpd, o.y0 + 1, cpd + 1, o.plinthC);
    if (o.bandC != null) S.f.box(S.u0 - cpd - 1, y1 + 1, 0, S.u1 + cpd + 1, y1 + 2, cpd + 1, o.bandC);
  }
}
// (r8) Striped shop awnings over lobbyBays openings (critic r7: "ref05's bank
// and hotel sit on a bright, busy ground-floor podium with steps, a canopy and
// signage"). Same bay maths as lobbyBays; y = awning top row; each awning
// steps out 3 in alternating colour / white, with a little sign board above.
// o: bw, pw, cw, us(S), skip(S,i), cols[], sign (board colour, null = none)
const AWN = () => [C.red, C.teal, C.yellow, C.orange, C.blue, C.pink];
function awnings(g, B, which, y, o) {
  const pw = o.pw != null ? o.pw : 2, cw = o.cw != null ? o.cw : 3, cols = o.cols || AWN();
  let n = o.seed || 0;
  for (const S of sides(g, B, which)) {
    const us = o.us ? o.us(S) : bayStarts(S.u0, S.u1, o.bw, pw, cw);
    us.forEach((u, i) => {
      if (o.skip && o.skip(S, i)) return;
      const u1 = u + o.bw - 1, col = cols[n++ % cols.length];
      for (let k = 0; k < 3; k++) S.f.box(u, y - k, k + 1, u1, y - k, k + 1, (k & 1) ? C.signWhite : col);
      S.f.box(u, y - 3, 3, u, y - 3, 3, col); S.f.box(u1, y - 3, 3, u1, y - 3, 3, col);   // valance tails
      if (o.sign != null) { S.f.box(u + 1, y + 1, 1, u1 - 1, y + 3, 1, o.sign); S.f.box(u + 2, y + 2, 1, u1 - 2, y + 2, 1, col); }
    });
  }
}

// Crisp 5×7 sign font (critic r3: "BANK lettering is blobby, BLCK / TECH hard
// to read"): 1-voxel strokes read cleaner than the 3×5 font at 2x.
const F57 = {};
for (const [ch, rows] of Object.entries({
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.####|#....|#....|#....|#....|#....|.####', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#.###|#...#|#...#|.###.', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####', M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|##..#|#.#.#|#.#.#|#..##|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#', Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####', ' ': '.....|.....|.....|.....|.....|.....|.....',
})) F57[ch] = rows.split('|').join('');
// text5 on a facade, centred on uc, bottom at y; k = voxel size (1 or 2)
function text5(f, uc, y, s, c, out = 1, k = 1) {
  const W = (s.length * 6 - 1) * k, u0 = f.rd > 0 ? uc - (W >> 1) : uc + (W >> 1);
  let col = 0;
  for (const ch of s) {
    const gl = F57[ch] || F57[' '];
    for (let r = 0; r < 7; r++) for (let i = 0; i < 5; i++) if (gl[r * 5 + i] === '#')
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) f.set(u0 + f.rd * ((col + i) * k + a), y + (6 - r) * k + b, out, c);
    col += 6;
  }
}
// Rooftop sign box on stilts facing front (min-Z), crisp 5×7 letters, lit rim.
function signBox(g, xc, y, z, text, bg, fg, rim = C.gold) {
  const W = text.length * 6 - 1 + 6, H = 11, x0 = xc - (W >> 1), x1 = x0 + W - 1;
  for (const x of [x0 + 3, x1 - 3]) g.box(x, y, z + 1, x, y + 2, z + 2, C.darkGray);
  g.box(x0, y + 3, z, x1, y + 2 + H, z + 1, bg);
  g.box(x0, y + 3, z, x1, y + 3, z, rim); g.box(x0, y + 2 + H, z, x1, y + 2 + H, z, rim);
  g.box(x0, y + 3, z, x0, y + 2 + H, z, rim); g.box(x1, y + 3, z, x1, y + 2 + H, z, rim);
  text5(facade(g, 'front', z), xc, y + 5, text, fg, 1, 1);
  text5(facade(g, 'back', z + 1), xc, y + 5, text, fg, 1, 1);     // readable from behind too
}

// ---- round 4 rooftop kit: ref05 roofs are crowded ---------------------------
// thin railing on posts around a roof rectangle (1 voxel, glass or metal)
function railing(g, x0, z0, x1, z1, y, c = C.metal) {
  // continuous top rail + sparse posts (posts every 4 cost ~0.6k per roof)
  g.walls(x0, y + 1, z0, x1, y + 1, z1, c);
  for (let x = x0; x <= x1; x += 8) { g.set(x, y, z0, c); g.set(x, y, z1, c); }
  for (let z = z0; z <= z1; z += 8) { g.set(x0, y, z, c); g.set(x1, y, z, c); }
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.set(x, y, z, c);
}
// cooling tower: a louvred box with a dark fan well and a steel rim
function coolTower(g, x0, y, z0, w = 7, h = 6) {
  g.box(x0, y, z0, x0 + w - 1, y + h - 1, z0 + w - 1, C.metal);
  for (let yy = y + 1; yy < y + h - 1; yy += 2) g.walls(x0, yy, z0, x0 + w - 1, yy, z0 + w - 1, C.metalDark);
  g.box(x0 + 1, y + h - 1, z0 + 1, x0 + w - 2, y + h - 1, z0 + w - 2, C.darkGray);
  g.set(x0 + (w >> 1), y + h - 1, z0 + (w >> 1), C.metal);
}
// satellite dish on a stub, facing front-left
function dish(g, x, y, z) {
  g.box(x, y, z, x, y + 2, z, C.metalDark);
  g.box(x - 1, y + 3, z - 2, x + 1, y + 5, z - 2, C.signWhite);
  g.set(x, y + 4, z - 1, C.metalDark);
}
// Mechanical crown for a flat roof rect (x0..x1, z0..z1 at y): parapet rail,
// a louvred plant room, cooling towers, a water tank, condensers, vents,
// masts + dish. o: { rail, wall, trim, tank, cool, masts, ac, vents, plant: [x0,z0,x1,z1,h] }
function mechCrown(g, x0, z0, x1, z1, y, rng, o = {}) {
  if (o.rail !== false) railing(g, x0, z0, x1, z1, y, o.rail != null ? o.rail : C.metal);
  const W = x1 - x0, D = z1 - z0, used = [];
  const take = (a, b, c, d) => used.push([a, b, c, d]);
  if (o.plant !== false) {
    const p = o.plant || [x0 + 3, z1 - 3 - Math.max(6, (D * 0.45) | 0), x0 + 3 + Math.max(7, (W * 0.45) | 0), z1 - 3, 8];
    penthouse(g, p[0], y, p[1], p[2], p[3], p[4], o.wall != null ? o.wall : C.stone, C.roofGray, o.trim != null ? o.trim : C.metalDark);
    take(p[0], p[1], p[2], p[3]);
    if (o.door !== false) { const F = facade(g, 'front', p[1]); F.box(p[0] + 2, y, 0, p[0] + 4, y + 5, 0, C.dtNavyPanel); }
  }
  const free = (a, b, c, d) => !used.some((s) => a <= s[2] + 1 && c >= s[0] - 1 && b <= s[3] + 1 && d >= s[1] - 1);
  const place = (w, d, fn, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const x = x0 + 2 + ((rng() * Math.max(1, W - w - 3)) | 0), z = z0 + 2 + ((rng() * Math.max(1, D - d - 3)) | 0);
      if (!free(x, z, x + w - 1, z + d - 1)) continue;
      take(x, z, x + w - 1, z + d - 1); fn(x, z); return true;
    }
    return false;
  };
  for (let i = 0; i < (o.cool || 0); i++) place(7, 7, (x, z) => coolTower(g, x, y, z, 7, 6));
  if (o.tank) place(9, 9, (x, z) => waterTank(g, x + 4, y, z + 4, 4, 7, o.tank, C.darkGray));
  for (let i = 0; i < (o.ac != null ? o.ac : 3); i++) place(6, 5, (x, z) => acBox(g, x, y, z, { w: 5 + ((rng() * 2) | 0), d: 4, h: 3 + ((rng() * 2) | 0) }));
  for (let i = 0; i < (o.vents != null ? o.vents : 2); i++) place(2, 2, (x, z) => ventPipe(g, x, z, y, y + 3 + ((rng() * 3) | 0)));
  for (let i = 0; i < (o.masts || 0); i++) place(3, 3, (x, z) => { mast(g, x + 1, z + 1, y, 10 + ((rng() * 8) | 0), C.red); dish(g, x + 1, y + 4, z); });
  if (o.dishes) for (let i = 0; i < o.dishes; i++) place(3, 3, (x, z) => dish(g, x + 1, y, z + 2));
}

// ---- round 4 lot kit: "lots are too empty — fill them edge to edge" ---------
const SHIRT = () => [C.red, C.yellow, C.signWhite, C.teal, C.orange, C.pink, C.blue, C.roofGreen];
// (life r8) the shared life.js figure (vehicles.js stampPerson) in the lot
// part instead of a 1-voxel peg; false when too close to another visitor.
function person(g, x, y, z, i) {
  return stampPerson(g, x + 0.5, y, z + 0.5, (i * 2654435761) >>> 0, i & 3);
}
// scatter n people over rect (only on clear ground, 1 apart)
function people(g, x0, z0, x1, z1, y, n, rng) {
  const has = (x, yy, z) => g.map.has(x + ',' + yy + ',' + z);
  for (let t = 0, k = 0; t < n * 20 && k < n; t++) {
    const x = x0 + ((rng() * (x1 - x0 + 1)) | 0), z = z0 + ((rng() * (z1 - z0 + 1)) | 0);
    let bad = !has(x, y - 1, z);
    for (let dx = -1; dx <= 1 && !bad; dx++) for (let dz = -1; dz <= 1 && !bad; dz++) for (let yy = y; yy <= y + 4; yy++) if (has(x + dx, yy, z + dz)) { bad = true; break; }
    if (bad) continue;
    if (person(g, x, y, z, k + ((x * 7 + z) | 0)) === false) continue;
    k++;
  }
}
// square paving tiles in a darker tone every `s` (flat, cheap)
function tiles(g, x0, z0, x1, z1, y, c, s = 4) {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (((x - x0) % s === 0) || ((z - z0) % s === 0)) g.set(x, y, z, c);
}
function bollards(g, x0, x1, z, y, step = 4) { for (let x = x0; x <= x1; x += step) { g.box(x, y, z, x, y + 1, z, C.stoneDark); g.set(x, y + 2, z, C.yellow); } }
function bikeRack(g, x0, y, z, n = 3) { for (let i = 0; i < n; i++) { const x = x0 + i * 2; g.box(x, y, z, x, y + 1, z + 2, C.metal); g.set(x, y + 1, z + 1, i & 1 ? C.red : C.blue); } }

// (r7) Sky garden: one storey of a tall shaft carved back `d` voxels all
// round into a shadowed loggia — dark glass wall inside, square columns at
// the corners and every ~10 along the edge, a hedge-topped planter ring at
// the lip, a slab above and below. It splits a long shaft into a lower and an
// upper part (critic r6: "each face is the same window bay repeated from
// base to crown … give each tower a distinct base, middle and top").
// Call BEFORE anything that should run through it (spines, lift cores).
function skyGarden(g, B, ys, ye, o = {}) {
  const d = o.d || 3, col = o.col != null ? o.col : C.dtFrame, slab = o.slab != null ? o.slab : col;
  const glass = o.glass != null ? o.glass : C.dtGlassDark, I = ins(B, d), out = o.out || 4;
  for (let y = ys; y <= ye; y++) for (let x = B.x0 - out; x <= B.x1 + out; x++) for (let z = B.z0 - out; z <= B.z1 + out; z++)
    if (!(x >= I.x0 && x <= I.x1 && z >= I.z0 && z <= I.z1)) g.del(x, y, z);
  // slabs: the floor ledge and the soffit fill the ring out to 1 proud
  for (const y of [ys - 1, ye + 1]) for (let k = -1; k < d; k++) g.walls(B.x0 + k, y, B.z0 + k, B.x1 - k, y, B.z1 - k, slab);
  g.walls(B.x0 - 1, ye + 2, B.z0 - 1, B.x1 + 1, ye + 2, B.z1 + 1, o.trim != null ? o.trim : slab);
  // inner glass wall with mullions + a lit head strip
  g.walls(I.x0, ys, I.z0, I.x1, ye, I.z1, glass);
  g.walls(I.x0, ye - 1, I.z0, I.x1, ye, I.z1, C.win);
  for (const S of sides(g, I)) for (let u = S.u0 + 3; u < S.u1 - 1; u += 4) S.f.box(u, ys, 0, u, ye, 0, col);
  // columns: corners + every ~10 along each edge
  const colAt = (x, z) => g.box(x, ys, z, x + 1, ye, z + 1, col);
  for (const [x, z] of [[B.x0, B.z0], [B.x1 - 1, B.z0], [B.x0, B.z1 - 1], [B.x1 - 1, B.z1 - 1]]) colAt(x, z);
  const span = (a, b) => { const n = Math.max(1, Math.round((b - a) / 10)), r = []; for (let i = 1; i < n; i++) r.push(Math.round(a + i * (b - a) / n)); return r; };
  for (const x of span(B.x0, B.x1 - 1)) { colAt(x, B.z0); colAt(x, B.z1 - 1); }
  for (const z of span(B.z0, B.z1 - 1)) { colAt(B.x0, z); colAt(B.x1 - 1, z); }
  // planter ring at the lip: box + hedge, flowers here and there
  for (const S of sides(g, B)) {
    S.f.box(S.u0 + 2, ys, 0, S.u1 - 2, ys + 1, 0, o.planter != null ? o.planter : col);
    S.f.box(S.u0 + 2, ys + 2, 0, S.u1 - 2, ys + 2, 0, C.bush);
    for (let u = S.u0 + 4; u < S.u1 - 2; u += 5) S.f.set(u, ys + 3, 0, (u >> 2) & 1 ? C.pink : C.yellow);
  }
  if (o.trees !== false) for (const [x, z] of [[I.x0 - 2, I.z0 - 2], [I.x1 + 1, I.z1 + 1]]) g.box(x, ys, z, x + 1, ys + 5, z + 1, C.lime);
}

// (r7) Critic r6: "their lots are thin rims of mostly empty paving … the
// ref05 lots are filled edge to edge with planters, parking and small props".
// fillLot scans the finished lot for FREE PAVED ground (plaza paving, not
// parking asphalt / stall lines / the rim) and drops street furniture into
// every gap it finds: planter boxes with shrubs, little trees, benches, bins,
// flower tubs, a kiosk, a café umbrella, bollards, lamps. keep = rects that
// must stay clear (the walk to the front door).
const PAVED = new Set([C.lotPave, C.lotPaveDark, C.lotGrass]);
// the walk from the kerb to a centred front door stays clear
function frontWalk(g, xc = g.sx >> 1) { const hw = g.sx > 40 ? 8 : 5; return [xc - hw, 0, xc + hw, g.sz > 40 ? 15 : 10]; }
function fillLot(g, W, D, rng, o = {}) {
  const Y = 2, keep = o.keep || [], H = o.h || 10;
  const at = (x, y, z) => g.map.get(x + ',' + y + ',' + z);
  const free = (x0, z0, x1, z1, h) => {
    if (x0 < 1 || z0 < 1 || x1 > W - 2 || z1 > D - 2) return false;
    for (const k of keep) if (x0 <= k[2] && x1 >= k[0] && z0 <= k[3] && z1 >= k[1]) return false;
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1;
      if (inside && !PAVED.has(at(x, 1, z))) return false;
      for (let y = Y; y <= Y + h; y++) if (at(x, y, z) != null) return false;
    }
    return true;
  };
  const props = [
    // [w, d, h, weight, fn(x, z)]
    [5, 3, 4, 5, (x, z) => { planter(g, x, z, x + 4, z + 2, Y, { box: o.box != null ? o.box : C.stoneDark, flowers: [C.pink, C.yellow, C.signWhite, C.red] }); g.box(x + 1, Y + 3, z + 1, x + 3, Y + 3, z + 1, C.bush); }],
    [3, 5, 4, 3, (x, z) => { planter(g, x, z, x + 2, z + 4, Y, { box: o.box != null ? o.box : C.stoneDark, flowers: [C.pink, C.yellow] }); g.box(x + 1, Y + 3, z + 1, x + 1, Y + 3, z + 3, C.bush); }],
    [5, 5, H, 4, (x, z) => { g.box(x, Y, z, x + 4, Y, z + 4, C.stoneDark); g.box(x + 1, Y, z + 1, x + 3, Y, z + 3, C.dirtDark); tree(g, x + 2, Y + 1, z + 2, 5); }],
    [5, 2, 5, 2, (x, z) => bench(g, x, Y, z, 'x', 5)],
    [2, 5, 5, 2, (x, z) => bench(g, x, Y, z, 'z', 5)],
    [2, 2, 4, 3, (x, z) => { g.box(x, Y, z, x + 1, Y + 1, z + 1, C.resTerraTrim); g.box(x, Y + 2, z, x + 1, Y + 2, z + 1, C.bush); g.set(x, Y + 3, z, pk(rng, [C.pink, C.red, C.yellow])); }],
    [1, 1, 3, 2, (x, z) => { g.box(x, Y, z, x, Y + 1, z, C.roofGreen); g.set(x, Y + 2, z, C.darkGray); }],
    [4, 4, 8, 1, (x, z) => { g.box(x, Y, z, x + 3, Y + 4, z + 3, pk(rng, [C.teal, C.red, C.dtNavyPanel])); g.box(x, Y + 5, z, x + 3, Y + 5, z + 3, C.dtFrame); g.box(x, Y + 2, z, x + 3, Y + 3, z, C.winCool); }],
    [7, 7, 9, 1, (x, z) => { umbrella(g, x + 3, Y, z + 3, pk(rng, [C.red, C.teal, C.orange, C.blue]), C.signWhite); g.box(x + 2, Y, z + 1, x + 4, Y + 2, z + 1, C.wood); }],
    [1, 1, 13, 1, (x, z) => lamp(g, x, Y, z, 11)],
  ];
  const tot = props.reduce((s, p) => s + p[3], 0);
  const n = o.n != null ? o.n : (W > 40 ? 30 : 14);
  let placed = 0;
  for (let t = 0; t < n * 12 && placed < n; t++) {
    let r = rng() * tot, P = props[0];
    for (const p of props) { r -= p[3]; if (r <= 0) { P = p; break; } }
    const x = 1 + ((rng() * (W - 2 - P[0])) | 0), z = 1 + ((rng() * (D - 2 - P[1])) | 0);
    if (!free(x, z, x + P[0] - 1, z + P[1] - 1, P[2])) continue;
    P[4](x, z); placed++;
  }
  return placed;
}

// Fill every air cell sealed off from the outside (6-connected flood from the
// canvas border; the ground below y=0 counts as solid). Hollow shells and
// setback stages otherwise emit all their INNER faces, and the wide-reach AO
// keeps those from merging: ~1.1k tris per sealed volume, ~2.5x on recessed
// facades. Sealed cells are never visible, so filling them is free to look at
// and makes the mesher cull every hidden face. Blocks are pushed straight
// onto the model (no Map), ~20 ms for a full 2x2 tower.
function fillSealed(m, c) {
  const { sx, sy, sz } = m, W = sx + 2, H = sy + 2, D = sz + 2, WD = W * D;
  const occ = new Uint8Array(W * H * D);
  const id = (x, y, z) => (y + 1) * WD + (z + 1) * W + (x + 1);
  for (const b of m.blocks) occ[id(b[0], b[1], b[2])] = 1;
  occ.fill(1, 0, WD);
  const st = new Int32Array(W * H * D); let n = 0;
  const push = (i) => { if (!occ[i]) { occ[i] = 2; st[n++] = i; } };
  for (let y = 1; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++)
    if (x === 0 || z === 0 || x === W - 1 || z === D - 1 || y === H - 1) push(y * WD + z * W + x);
  while (n) {
    const i = st[--n], x = i % W, z = ((i / W) | 0) % D, y = (i / WD) | 0;
    if (x > 0) push(i - 1); if (x < W - 1) push(i + 1);
    if (z > 0) push(i - W); if (z < D - 1) push(i + W);
    if (y > 1) push(i - WD); if (y < H - 1) push(i + WD);
  }
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++)
    if (occ[id(x, y, z)] === 0) m.blocks.push([x, y, z, c]);
}
// finish: shrink the declared height to the tallest voxel (towers are authored
// on a cap-height canvas) so pop-up / ghost / bounds use the real height, then
// seal the interior.
function finish(g) {
  let top = 0;
  for (const k of g.map.keys()) { const y = +k.split(',')[1]; if (y > top) top = y; }
  g.sy = Math.min(g.sy, top + 1);
  const m = g.done();
  fillSealed(m, C.roofGray);
  return m;
}

// ---- rooftop kit ----------------------------------------------------------
function penthouse(g, x0, y, z0, x1, z1, h, wall, roof, trim) {
  g.walls(x0, y, z0, x1, y + h - 1, z1, wall);
  g.box(x0 + 1, y + h - 1, z0 + 1, x1 - 1, y + h - 1, z1 - 1, roof);
  for (let yy = y + 1; yy < y + h - 2; yy += 2) {           // louvre bands
    for (let x = x0 + 1; x < x1; x++) { g.set(x, yy, z0, trim); g.set(x, yy, z1, trim); }
  }
  g.walls(x0, y + h, z0, x1, y + h, z1, trim);              // coping
  return y + h + 1;
}
function waterTank(g, cx, y, cz, r, h, wood, band) {
  for (const [dx, dz] of [[-r + 1, -r + 1], [r - 1, -r + 1], [-r + 1, r - 1], [r - 1, r - 1]]) g.box(cx + dx, y, cz + dz, cx + dx, y + 3, cz + dz, C.darkGray);
  const yb = y + 4;
  for (let yy = yb; yy < yb + h; yy++) for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
    const d = x * x + z * z;
    if (d <= r * r + 1 && d > (r - 1) * (r - 1) - 1) g.set(cx + x, yy, cz + z, (yy - yb) % 4 === 1 ? band : wood);
  }
  g.box(cx - r + 1, yb, cz - r + 1, cx + r - 1, yb, cz + r - 1, wood);
  for (let k = 0; k <= r; k++) for (let x = -r + k; x <= r - k; x++) for (let z = -r + k; z <= r - k; z++)
    if (x * x + z * z <= (r - k) * (r - k) + 1) g.set(cx + x, yb + h + k, cz + z, C.roofGray);
}
function helipad(g, x0, z0, x1, z1, y) {
  g.box(x0, y, z0, x1, y, z1, C.stoneDark);   // r8: dtPad is now the slate-blue ONYX cladding
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.min(x1 - x0, z1 - z0) / 2 - 1.5;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d <= r && d > r - 1.5) g.set(x, y, z, C.yellow);
  }
  const hx = Math.round(cx), hz = Math.round(cz), s = Math.max(2, Math.round(r * 0.45));
  for (let z = hz - s; z <= hz + s; z++) { g.set(hx - s + 1, y, z, C.signWhite); g.set(hx + s - 1, y, z, C.signWhite); }
  for (let x = hx - s + 1; x <= hx + s - 1; x++) g.set(x, y, hz, C.signWhite);
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.set(x, y + 1, z, C.lamp);
}
function mast(g, x, z, y0, h, beacon = C.red) {
  for (let y = y0; y < y0 + h; y++) g.set(x, y, z, C.steel);
  for (let y = y0 + 3; y < y0 + h - 2; y += 6) { g.set(x - 1, y, z, C.metal); g.set(x + 1, y, z, C.metal); g.set(x, y, z - 1, C.metal); g.set(x, y, z + 1, C.metal); }
  g.set(x, y0 + h, z, beacon);
  return y0 + h + 1;
}
// rooftop sign on two stilts, facing front (min-Z); letters glow at night
function roofSign(g, xc, y, z, text, bg, fg, k = 1) {
  const W = (text.length * 4 - 1) * k + 4, H = 5 * k + 4, x0 = xc - (W >> 1), x1 = x0 + W - 1;
  for (const x of [x0 + 2, x1 - 2]) g.box(x, y, z + 1, x, y + 2, z + 1, C.darkGray);
  g.box(x0, y + 3, z, x1, y + 2 + H, z + 1, bg);
  g.box(x0, y + 3, z, x1, y + 3, z, fg); g.box(x0, y + 2 + H, z, x1, y + 2 + H, z, fg);
  textBig(facade(g, 'front', z), xc, y + 5, text, fg, 1, k);
}

// ---- lot kit ---------------------------------------------------------------
function tree(g, x, y, z, s = 6) {
  g.box(x, y, z, x + 1, y + 3, z + 1, C.trunk);
  const c0 = x - ((s - 2) >> 1), z0 = z - ((s - 2) >> 1);
  g.box(c0, y + 4, z0, c0 + s - 1, y + 3 + s, z0 + s - 1, C.lime);
  g.box(c0, y + 4, z0, c0 + s - 1, y + 4, z0 + s - 1, C.leafMid);
  g.set(c0 + 1, y + 6, z0, C.leafMid); g.set(c0 + s - 1, y + 7, z0 + 2, C.leafMid);
}
function hedge(g, x0, y, z0, x1, z1, h = 3) {
  g.box(x0, y, z0, x1, y + h - 1, z1, C.bush);
  g.box(x0, y, z0, x1, y, z1, C.leafMid);
}
function lamp(g, x, y, z, h = 12) {
  g.box(x, y, z, x, y + h, z, C.darkGray);
  g.set(x, y + h + 1, z, C.lamp);
}
// (life r5) lot cars are the shared res-8 vehicles (vehicles.js stampLotCar:
// glazed cabin, wheels, lights, liveries), 4 × 9 centred in the old 5 × 9 spot.
function car(g, x0, y, z0, alongX, body) {
  const seed = x0 * 73 + z0 * 151 + (body | 0);
  if (alongX) stampLotCar(g, x0, y, z0 + 1, 3, body, seed);
  else stampLotCar(g, x0 + 1, y, z0, 0, body, seed);
}
const CAR_COLS = [C.red, C.dtFrame, C.taxiYellow, C.blue, C.teal, C.darkGray, C.orange];
// parking stalls: stripes every 7 along x from x0..x1, stall depth len at z0
function parkRow(g, x0, x1, z0, len, rng, p = 0.6) {
  for (let x = x0; x <= x1; x += 7) g.box(x, 1, z0, x, 1, z0 + len - 1, C.lotLine);
  for (let x = x0 + 1; x + 5 <= x1; x += 7) if (rng() < p) car(g, x, 2, z0 + ((len - 9) >> 1), false, pk(rng, CAR_COLS));
}
// same, stalls stacked along z (stripes every 7 in z), cars along x
function parkCol(g, z0, z1, x0, len, rng, p = 0.6) {
  for (let z = z0; z <= z1; z += 7) g.box(x0, 1, z, x0 + len - 1, 1, z, C.lotLine);
  for (let z = z0 + 1; z + 5 <= z1; z += 7) if (rng() < p) car(g, x0 + ((len - 9) >> 1), 2, z, true, pk(rng, CAR_COLS));
}
function umbrella(g, x, y, z, a, b) {
  g.box(x, y, z, x, y + 6, z, C.offwhite);
  g.box(x - 2, y + 2, z - 2, x + 2, y + 2, z + 2, C.wood);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const e = Math.max(Math.abs(dx), Math.abs(dz));
    g.set(x + dx, y + 7 - (e === 3 ? 1 : 0), z + dz, (dx + dz) & 1 ? a : b);
  }
}
function flag(g, x, y, z, h, c) {
  g.box(x, y, z, x, y + h, z, C.metal);
  g.box(x + 1, y + h - 4, z, x + 5, y + h - 1, z, c);
}
// entrance canopy on the min-Z face at zFace: slab + fascia (+ posts)
function canopy(g, x0, x1, y, zFace, depth, c, post, Y = 2) {
  g.box(x0, y, zFace - depth, x1, y + 1, zFace - 1, c);
  g.box(x0, y + 2, zFace - depth, x1, y + 2, zFace - depth, c);
  if (post != null) for (const x of [x0, x1]) g.box(x, Y, zFace - depth, x, y - 1, zFace - depth, post);
}
// the grand entrance: recessed double glass doors with a surround
function entrance(g, B, uc, Y, w, h, frame, canopyC, depth = 4, posts = null) {
  const F = facade(g, 'front', B.z0);
  door(F, uc - (w >> 1), Y, w, h, { color: C.dtGlassDark, glass: C.winCool, frame, double: true, step: null });
  if (canopyC != null) canopy(g, uc - (w >> 1) - 3, uc - (w >> 1) + w + 2, Y + h + 1, B.z0, depth, canopyC, posts, Y);
  return F;
}

// ===========================================================================
// (r9) STREET PODIUM + PORTICO — critic r8: "the tower bases are thin and
// look anonymous … the same window grid right down to a tiny plinth. There
// is no real podium or entrance at street level. The ref05 bank, hotel and
// hospital each have a grand ground-floor entrance: columned porticos, wide
// stairs, canopies and big signs." Every tower now stands on a two-storey
// podium in its OWN material (brick / terracotta / cream / sandstone / teal
// against the shaft), one or two voxels wider than the shaft so the tower
// visibly rises out of it, with a portico on the front.
// ===========================================================================
// podium materials: [wall, pier/cornice, fascia] — warm against the shafts
// (critic r8: "our palette is dominated by blue glass; the reference mixes
// cream, stone, brick red and teal")
const POD = {
  // (the renderer lifts lit reds ~1.3x: C.brick read coral, so the podium
  // reds are the darker bricks — ref05's hotel podium is a deep brick red)
  // fascias are near-black / deep green: navy panels rendered periwinkle and
  // merged with the glass into one blue band
  brick: () => [C.brickDark, C.cream, C.darkGray], deepBrick: () => [C.resTileDk, C.cream, C.black],
  lime: () => [C.dtLime, C.dtLimeShade, C.roofGreen], terra: () => [C.dtTerra, C.cream, C.black],
  sand: () => [C.sand, C.dtFrame, C.darkGray], teal: () => [C.dtCopper, C.dtFrame, C.black],
  slate: () => [C.resSlate, C.dtFrame, C.black], cream: () => [C.cream, C.brickDark, C.darkGray],
};
const SIGN_COLS = () => [C.red, C.teal, C.yellow, C.orange, C.blue, C.roofGreen, C.pink];
// Podium on box P from Y. Composition (y from Y):
//   0-1  dark granite plinth course, 1 proud
//   2-13 shopfront storey: tall glass 2 back between proud piers, lit transom
//   14-16 a continuous SIGN FASCIA with coloured shop boards / striped awnings
//   17…  an upper storey of ARCHED windows (keystone, proud sill) — or, with
//        style 'modern', a glass ribbon between the piers
//   then a two-step cornice and a parapet. Returns the y the shaft starts on.
// o: { h=32, wall, pier, plinth, fascia, glass, upperGlass, bw=7, pw=2, cw=3,
//      which='fblr', skipF:[u0,u1] (front span kept for the portico),
//      style 'arch'|'modern', seed, signCols, awn (default true), roof }
function streetPodium(g, P, Y, o) {
  const H = o.h || 32, wall = o.wall, pier = o.pier != null ? o.pier : C.dtFrame;
  const plinth = o.plinth != null ? o.plinth : C.stoneDark, fascia = o.fascia != null ? o.fascia : C.darkGray;
  const glass = o.glass != null ? o.glass : C.dtGlass, upG = o.upperGlass != null ? o.upperGlass : C.dtGlassDeep;
  const gl = o.ground === 'glass', bw = o.bw || (gl ? 5 : 7), pw = o.pw != null ? o.pw : (gl ? 1 : 2), cw = o.cw != null ? o.cw : (gl ? 1 : 3);
  const gy0 = Y + 2, gt = Y + 13, fa = gt + 1, fb = gt + 3, ut = Y + H - 5, top = ut + 3;
  const modern = o.style === 'modern', cols = o.signCols || SIGN_COLS();
  // (w10) the ground storey comes in four kinds so no two towers share a base
  // (coordinator: "every tower needs a DISTINCT 1-2 storey podium"):
  //   'shop'      shopfronts under a sign fascia with boards + awnings (default)
  //   'arcade'    round-arched openings, deep dark glass, keystones, lanterns
  //   'colonnade' a two-storey giant order: square columns with bases +
  //               capitals in front of a 2-deep dark glass hall (no fascia)
  //   'glass'     a two-storey glass lobby wall behind slim fins, with a
  //               cantilevered canopy band across every face
  const ground = o.ground || 'shop', tall = ground === 'colonnade' || ground === 'glass';
  const colC = o.colC != null ? o.colC : (ground === 'glass' ? C.dtFrame : pier);
  shell(g, P, Y, ut + 2, wall, o.roof != null ? o.roof : C.roofGray);
  // a floor slab inside: a recess opened in the 1-thick shell (the portico's
  // 2-deep lobby) would otherwise leak the hollow through its floor and the
  // mesher would emit every inner face (~3k tris)
  g.box(P.x0 + 1, Y, P.z0 + 1, P.x1 - 1, Y + 1, P.z1 - 1, wall);
  course(g, P, Y, plinth, 1, 2, 0);
  let n = o.seed || 0;
  for (const S of sides(g, P, o.which || 'fblr')) {
    const us = bayStarts(S.u0, S.u1, bw, pw, cw);
    if (!us.length) continue;
    const first = us[0], last = us[us.length - 1] + bw - 1;
    // corner piers in the podium material (the diagonal voxel too, so the
    // corners stay square) with trim-coloured quoins every 4 rows
    S.f.box(S.u0 - 1, gy0, 1, first - 1, ut, 1, ground === 'colonnade' ? colC : wall);
    S.f.box(last + 1, gy0, 1, S.u1 + 1, ut, 1, ground === 'colonnade' ? colC : wall);
    if (!tall) for (let y = gy0 + 1; y < ut - 1; y += 4) { S.f.box(S.u0 - 1, y, 1, S.u0 + 1, y + 1, 1, pier); S.f.box(S.u1 - 1, y, 1, S.u1 + 1, y + 1, 1, pier); }
    // continuous sign fascia across the bays (shops), an impost band (arcade)
    if (ground === 'shop') {
      S.f.box(first, fa, 0, last, fb, 1, fascia);
      S.f.box(first, fb + 1, 1, last, fb + 1, 1, pier);
    } else if (ground === 'arcade') S.f.box(S.u0 - 1, fb + 1, 1, S.u1 + 1, fb + 1, 1, pier);
    us.forEach((u, i) => {
      const u1 = u + bw - 1, mid = (u + u1) >> 1;
      const kept = S.s === 'f' && o.skipF && u1 >= o.skipF[0] - 1 && u <= o.skipF[1] + 1;
      if (ground !== 'shop') {
        const col = cols[n++ % cols.length];
        if (ground === 'arcade' && !kept) {
          // round-arched opening, dark glass 2 back behind cheeks, a lit
          // fanlight, a keystone; alternate bays get a lantern on the pier
          alcove(S.f, u, u1, gy0, fb - 1, 2, o.glass != null ? o.glass : C.dtGlassDark, wall);
          S.f.box(u, fb - 4, -2, u1, fb - 1, -2, C.winCool);
          S.f.box(u, fb - 5, -2, u1, fb - 5, -2, C.dtFrame);
          S.f.box(mid, gy0, -2, mid, fb - 5, -2, C.dtFrame);
          S.f.box(u, fb - 1, 0, u + 1, fb - 1, 0, wall); S.f.box(u1 - 1, fb - 1, 0, u1, fb - 1, 0, wall);
          S.f.box(u, fb - 2, 0, u, fb - 2, 0, wall); S.f.box(u1, fb - 2, 0, u1, fb - 2, 0, wall);
          S.f.box(mid - 1, fb, 1, mid + 1, fb + 1, 1, pier);
          S.f.box(u, gy0, 1, u1, gy0, 1, C.stoneDark);                         // threshold
          if (i % 2 === 0 && bw >= 7) S.f.box(mid, gy0 + 1, -1, mid, gy0 + 1, -1, col);   // shop display
        } else if (tall) {
          // two-storey recess: dark glass hall (colonnade) or a light curtain
          // wall (glass); a mezzanine slab line at the fascia level
          const ya = kept ? fb + 2 : gy0;
          const back = ground === 'glass' ? (o.glass != null ? o.glass : C.dtGlass) : (o.glass != null ? o.glass : C.dtGlassDark);
          if (ground === 'colonnade') alcove(S.f, u, u1, ya, ut - 3, 2, back, wall);
          else { S.f.clear(u, ya, 0, u1, ut - 1, 0); S.f.box(u, ya, -1, u1, ut - 1, -1, back); }
          const d = ground === 'colonnade' ? -2 : -1;
          if (!kept) S.f.box(u, fa, d, u1, fa, d, ground === 'glass' ? C.dtFrame : C.dtNavyPanel);
          for (let m = u + 2; m < u1 - 1; m += 3) S.f.box(m, ya, d, m, ground === 'colonnade' ? ut - 3 : ut - 1, d, ground === 'glass' ? C.metal : C.dtFrame);
          S.f.box(u, (ground === 'colonnade' ? ut - 3 : ut - 1) - 2, d, u1, ground === 'colonnade' ? ut - 3 : ut - 1, d, C.winCool);
          if (!kept) {
            S.f.box(u, gy0, d, u1, gy0, d, C.darkGray);
            S.f.box(u, gt - 3, d, u1, gt - 2, d, C.winCool);
            // ground-floor doors every other bay (a shop / lobby entrance)
            if (i % 2 === 1) { S.f.box(mid - 1, gy0 + 1, d, mid + 1, gy0 + 8, d, C.dtGlassDark); S.f.box(mid, gy0 + 1, d, mid, gy0 + 8, d, C.dtFrame); }
          }
        }
        if (ground === 'glass' && !kept) {
          // cantilevered canopy over the ground storey + a slim sign board
          S.f.box(u - 1, fa, 1, u1 + 1, fa, 3, C.dtFrame);
          S.f.box(u - 1, fa + 1, 3, u1 + 1, fa + 1, 3, o.canopyC != null ? o.canopyC : C.dtGlassHi);
          if (i % 2 === 0) { S.f.box(u + 1, fa + 2, 1, u1 - 1, fa + 4, 1, col); S.f.box(u + 2, fa + 3, 1, u1 - 2, fa + 3, 1, C.signWhite); }
        }
        // piers: full height (arcade), columns with base + capital
        // (colonnade) or slim proud fins (glass)
        if (i < us.length - 1) {
          const pa = u1 + 1, pb = us[i + 1] - 1;
          if (ground === 'colonnade') {
            S.f.box(pa, gy0, 1, pb, ut - 2, 1, colC);
            S.f.box(pa - 1, gy0, 1, pb + 1, gy0 + 1, 2, C.stoneDark);
            S.f.box(pa - 1, ut - 3, 1, pb + 1, ut - 2, 2, colC);
          } else if (ground === 'glass') S.f.box(pa, gy0, 1, pb, ut - 1, 2, colC);
          else S.f.box(pa, gy0, 1, pb, ut, 1, wall);
        }
        if (ground === 'arcade' && !(kept && o.skipUpper)) {
          const a = u + 1, b = u1 - 1, y0 = fb + 3, y1 = ut - 1;
          S.f.clear(a, y0, 0, b, y1, 0);
          S.f.box(a, y0, -1, b, y1, -1, upG);
          S.f.box(a, y1 - 2, -1, b, y1, -1, C.winCool);
          S.f.box((a + b) >> 1, y0, -1, (a + b) >> 1, y1, -1, C.dtFrame);
          S.f.box(a - 1, y1 + 1, 0, b + 1, y1 + 1, 1, pier);
          S.f.box(a - 1, y0 - 1, 0, b + 1, y0 - 1, 1, pier);
        }
        return;
      }
      if (!kept) {
        // (1 deep: a 2-deep alcove with cheeks cost ~2x; the fascia and
        // awning above already cast the shadow line)
        S.f.clear(u, gy0, 0, u1, gt - 1, 0);
        S.f.box(u, gy0 + 1, -1, u1, gt - 4, -1, glass);
        S.f.box(u, gt - 3, -1, u1, gt - 1, -1, C.winCool);
        S.f.box(mid, gy0 + 1, -1, mid, gt - 4, -1, C.dtFrame);
        S.f.box(u, gy0, -1, u1, gy0, -1, C.darkGray);                  // stall riser
        const col = cols[n++ % cols.length];
        if (o.awn !== false && (i + (S.s === 'f' || S.s === 'b' ? 0 : 1)) % 2 === 1) {
          // striped awning hung from the fascia over the shop glass
          for (let k = 0; k < 3; k++) S.f.box(u, gt - k, k + 1, u1, gt - k, k + 1, (k & 1) ? C.signWhite : col);
        } else {
          // shop sign board standing proud of the fascia, a white "name" bar
          S.f.box(u, fa, 2, u1, fb, 2, col);
          S.f.box(u + 1, fa + 1, 2, u1 - 1, fa + 1, 2, C.signWhite);
          if (bw >= 7) S.f.set(u + 2, fa + 1, 2, col);
        }
      }
      // pilaster between bays: ground storey + upper storey (the fascia crosses it)
      if (i < us.length - 1) { S.f.box(u1 + 1, gy0, 1, us[i + 1] - 1, gt, 1, wall); S.f.box(u1 + 1, fb + 2, 1, us[i + 1] - 1, ut, 1, wall); }
      if (!(kept && o.skipUpper)) {
        // arched window (glass 1 back, the top row's corners filled back in,
        // keystone) — or, 'modern', a square window under a proud lintel —
        // with a proud sill, a transom + mullion and a lit head
        const a = u + 1, b = u1 - 1, y0 = fb + 3, y1 = ut - 1;
        S.f.clear(a, y0, 0, b, y1, 0);
        S.f.box(a, y0, -1, b, y1, -1, upG);
        S.f.box(a, y1 - 2, -1, b, y1, -1, C.winCool);
        if (modern) S.f.box(a - 1, y1 + 1, 0, b + 1, y1 + 1, 1, pier);
        else {
          S.f.box(a, y1, 0, a, y1, 0, wall); S.f.box(b, y1, 0, b, y1, 0, wall);
          S.f.box((a + b) >> 1, y1 + 1, 0, (a + b) >> 1, y1 + 1, 1, pier);
        }
        S.f.box(a - 1, y0 - 1, 0, b + 1, y0 - 1, 1, pier);
      }
    });
  }
  // two-step cornice + parapet with a coping
  course(g, P, ut + 1, pier, 1, 1, 0);
  course(g, P, ut + 2, o.cornC != null ? o.cornC : pier, 2, 1, 0);
  g.walls(P.x0, top, P.z0, P.x1, top, P.z1, wall);
  g.walls(P.x0, top + 1, P.z0, P.x1, top + 1, P.z1, pier);
  return top;
}
// Portico on the min-Z face zf, centred on xc: a raised landing + a wide
// step, double doors in a tall glass lobby, columns with bases + capitals,
// and a roof of the chosen kind:
//   'glass'  — a teal glass canopy in a white frame (the ref05 hotel)
//   'temple' — an entablature carrying the name + a 45° pediment (ref05 bank)
//   'slab'   — a deep flat canopy with the name on its fascia (ref05 hospital)
// o: { xc, w (odd), Y, depth=6, kind, colC, stone, frame, roofC, glassTop,
//      fascia, text, textC, cols (2|4), lamps (true), planters (true), podH }
function portico(g, zf, o) {
  const Y = o.Y, w = o.w || 9, x0 = o.xc - (w >> 1), x1 = x0 + w - 1, D = o.depth || 6;
  const gt = Y + 13, kind = o.kind || 'glass';
  const colC = o.colC != null ? o.colC : C.dtFrame, stone = o.stone != null ? o.stone : C.dtLimeShade;
  const frame = o.frame != null ? o.frame : C.dtFrame, fascia = o.fascia != null ? o.fascia : C.darkGray;
  const F = facade(g, 'front', zf);
  // lobby: glass 2 back, lit transom, double doors
  F.clear(x0 - 1, Y + 2, 1, x1 + 1, gt, 3);
  alcove(F, x0, x1, Y + 2, gt - 1, 2, o.glass != null ? o.glass : C.dtGlass, colC);
  F.box(x0, gt - 3, -2, x1, gt - 1, -2, C.winCool);
  F.box(x0, gt - 4, -2, x1, gt - 4, -2, frame);
  const dc = o.xc;
  F.box(dc - 3, Y + 2, -2, dc + 3, gt - 5, -2, C.dtGlassDark);
  F.box(dc - 2, Y + 3, -2, dc - 1, gt - 6, -2, C.winCool); F.box(dc + 1, Y + 3, -2, dc + 2, gt - 6, -2, C.winCool);
  F.box(dc, Y + 2, -2, dc, gt - 5, -2, frame);
  // landing (2 up) + a wide first step + a mat
  const lx0 = x0 - 5, lx1 = x1 + 5, lz0 = zf - D;
  g.box(lx0, Y, lz0, lx1, Y + 1, zf - 1, stone);
  g.box(x0 - 2, Y, lz0 - 2, x1 + 2, Y, lz0 - 1, stone);
  g.box(x0 + 1, Y + 1, lz0 + 1, x1 - 1, Y + 1, zf - 1, o.mat != null ? o.mat : C.red);
  // columns
  const cz = lz0 + 1, xs = [lx0 + 1, lx1 - 2];
  if (o.cols === 4) xs.push(x0 + 1, x1 - 2);
  for (const x of xs) {
    g.box(x - 1, Y + 2, cz - 1, x + 2, Y + 2, cz + 2, C.stoneDark);
    g.box(x, Y + 3, cz, x + 1, gt - 1, cz + 1, colC);
    g.box(x - 1, gt, cz - 1, x + 2, gt, cz + 2, colC);
  }
  // roof
  const ry = gt + 1;
  if (kind === 'temple') {
    const eh = o.text ? 9 : 3;
    g.box(lx0, ry, lz0, lx1, ry + eh - 1, zf - 1, colC);
    g.box(lx0 - 1, ry, lz0 - 1, lx1 + 1, ry, zf - 1, stone);
    g.box(lx0 - 1, ry + eh, lz0 - 1, lx1 + 1, ry + eh, zf - 1, stone);
    if (o.text) text5(facade(g, 'front', lz0), o.xc, ry + 1, o.text, o.textC != null ? o.textC : C.dtNavyPanel, 0, 1);
    const roofC = o.roofC != null ? o.roofC : C.dtCopper;
    for (let k = 0; ; k++) {
      const xa = lx0 + k, xb = lx1 - k, y = ry + eh + 1 + k;
      if (xb - xa < 1) break;
      g.box(xa, y, lz0, xb, y, zf - 1, colC);
      g.box(xa, y, lz0, xa, y, zf - 1, roofC); g.box(xb, y, lz0, xb, y, zf - 1, roofC);
      g.set(xa, y, lz0 - 1, stone); g.set(xb, y, lz0 - 1, stone);
    }
  } else if (kind === 'marquee') {
    // (w10) theatre marquee (deco / ONYX): a deep canopy whose fascia wraps
    // three sides, a row of bulbs top + bottom, the name in lit letters
    const fc = fascia, bulb = o.bulb != null ? o.bulb : C.lamp;
    g.box(lx0, ry, lz0, lx1, ry, zf - 1, frame);
    g.walls(lx0 - 1, ry + 1, lz0 - 1, lx1 + 1, ry + 9, zf - 1, fc);
    g.box(lx0, ry + 9, lz0, lx1, ry + 9, zf - 1, frame);
    for (let x = lx0 - 1; x <= lx1 + 1; x += 2) for (const y of [ry + 1, ry + 9]) g.set(x, y, lz0 - 2, bulb);
    for (let z = lz0 + 1; z < zf - 1; z += 2) for (const x of [lx0 - 2, lx1 + 2]) { g.set(x, ry + 1, z, bulb); g.set(x, ry + 9, z, bulb); }
    if (o.text) text5(facade(g, 'front', lz0 - 1), o.xc, ry + 2, o.text, o.textC != null ? o.textC : C.gold, 1, 1);
    // a vertical blade sign over the marquee
    const bx = lx1 - 1;
    g.box(bx, ry + 10, lz0 + 1, bx + 1, ry + 34, lz0 + 5, fc);
    for (let y = ry + 12; y < ry + 33; y += 4) { g.set(bx - 1, y, lz0 + 3, bulb); g.set(bx + 2, y, lz0 + 3, bulb); }
    g.box(bx, ry + 35, lz0 + 1, bx + 1, ry + 35, lz0 + 5, frame);
  } else if (kind === 'pergola') {
    // (w10) timber pergola with climbing plants (eco tower): slatted beams,
    // hedges hung along the top, the name in green letters standing on it
    g.box(lx0, ry, lz0, lx1, ry, lz0, C.woodDark); g.box(lx0, ry, zf - 1, lx1, ry, zf - 1, C.woodDark);
    for (let x = lx0; x <= lx1; x += 2) g.box(x, ry + 1, lz0 - 1, x, ry + 1, zf - 1, C.wood);
    for (let x = lx0 + 1; x <= lx1; x += 4) g.box(x, ry + 2, lz0, x + 1, ry + 2, zf - 2, C.bush);
    g.box(lx0, ry + 1, lz0 - 1, lx0, ry + 3, lz0 + 1, C.leafMid); g.box(lx1, ry + 1, lz0 - 1, lx1, ry + 3, lz0 + 1, C.leafMid);
    if (o.text) { text5(facade(g, 'front', lz0 + 1), o.xc, ry + 3, o.text, o.textC != null ? o.textC : C.roofGreen, 0, 1); text5(facade(g, 'front', lz0 + 2), o.xc, ry + 3, o.text, o.textC != null ? o.textC : C.roofGreen, 0, 1); }
  } else {
    g.box(lx0, ry, lz0, lx1, ry + 1, zf - 1, frame);
    if (kind === 'glass') {
      g.box(lx0 + 1, ry + 2, lz0 + 1, lx1 - 1, ry + 2, zf - 1, o.glassTop != null ? o.glassTop : C.dtCopper);
      g.walls(lx0, ry + 2, lz0, lx1, ry + 2, zf - 1, frame);
    }
    g.box(lx0, ry, lz0 - 1, lx1, ry + 2, lz0 - 1, fascia);            // fascia front edge
    if (o.text && o.sign === 'letters') {
      // (w10) free-standing letters on the canopy (ref05 HOTEL / POLICE
      // STATION): 2 deep, lit colour, a thin dark rail under them — the
      // black sign box repeated on every tower read as one template
      const tc = o.textC != null ? o.textC : C.signWhite;
      text5(facade(g, 'front', lz0 + 1), o.xc, ry + 3, o.text, tc, 0, 1);
      text5(facade(g, 'front', lz0 + 2), o.xc, ry + 3, o.text, tc, 0, 1);
      const TW = o.text.length * 6 - 1;
      g.box(o.xc - (TW >> 1) - 1, ry + 2, lz0 + 1, o.xc + (TW >> 1) + 1, ry + 2, lz0 + 2, C.darkGray);
    } else if (o.text) {
      const TW = o.text.length * 6 - 1, hw = Math.max(5, (TW + 5) >> 1);
      g.box(o.xc - hw, ry + 3, lz0 - 1, o.xc + hw, ry + 11, lz0, fascia);
      g.box(o.xc - hw, ry + 11, lz0 - 1, o.xc + hw, ry + 11, lz0, frame);
      text5(facade(g, 'front', lz0 - 1), o.xc, ry + 4, o.text, o.textC != null ? o.textC : C.signWhite, 1, 1);
    }
  }
  // planters with shrubs + lamps on the landing wings
  if (o.planters !== false && lz0 - 6 >= 1) for (const [a, b] of [[lx0, lx0 + 3], [lx1 - 3, lx1]]) {
    g.box(a, Y + 2, lz0 - 3 - 3, b, Y + 3, lz0 - 3, o.planterC != null ? o.planterC : C.stoneDark);
    g.box(a + 1, Y + 4, lz0 - 5, b - 1, Y + 5, lz0 - 4, C.bush);
    g.set(a + 1, Y + 6, lz0 - 5, C.pink); g.set(b - 1, Y + 6, lz0 - 4, C.yellow);
  }
  if (o.lamps !== false) for (const x of [lx0 - 2, lx1 + 2]) lamp(g, x, Y, lz0, 10);
  return lz0 - 2;
}

// ===========================================================================
// 1×1 TOWERS (canvas 31 × ≤192 × 31)
// ===========================================================================
const GLASS = [C.dtGlass, C.dtGlassDeep, C.dtGlassTeal];

// Small Office — red-brick (or grey-stone, or dark-brick) mid-rise. BASE:
// a granite ground storey with recessed lobby glass all round and a stone
// porch. SHAFT: stone-framed windows punched into the wall with proud sills,
// a projecting oriel bay up the front, stone quoins. TOP: dentils + a
// cornice, parapet, a rooftop billboard, lift house, condensers, water tank.
function bSmallOffice(rng, v) {
  const sk = (v + ((rng() * 3) | 0)) % 3;
  const [wall, stone, trim] = [[C.resTerracotta, C.cream, C.brickDark], [C.dtStone, C.dtFrame, C.dtNavyPanel],
    [C.brickDark, C.dtLimeShade, C.darkGray]][sk];
  const nf = 3 + v;
  const g = grid(31, 160, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  const B = box(4, 10, 26, 28), O = ins(B, -1), P = box(2, 8, 28, 29);
  // (r9) a two-storey street podium in a contrasting material + a portico
  const [pw0, pp0, pf0] = [POD.lime, POD.brick, POD.sand][sk]();
  const gt = streetPodium(g, P, Y, { ground: 'colonnade', colC: [C.dtLime, C.cream, C.dtFrame][sk], wall: pw0, pier: pp0, fascia: pf0, skipF: [8, 22], seed: v }) - 2, st = gt + 2 + FL * nf;
  shell(g, B, gt + 2, st, wall, C.roofGray);
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'temple', colC: pp0, stone: C.dtLimeShade, roofC: trim, text: pk(rng, ['LAW', 'CITY', 'POST']), textC: C.dtNavyPanel });
  // shaft: oriel bay on the front, framed punched windows, quoins
  g.box(11, gt + 2, B.z0 - 3, 19, st - 3, B.z0, wall);
  const Bo = box(11, B.z0 - 3, 19, B.z1);
  punch(g, Bo, 'f', { y0: gt + 2, y1: st - 3, floor: FL, sill: 3, wh: 7, w: 5, us: () => [13], glassFn: skyGlass([C.dtGlassDeep, C.dtGlass], nf), hi: C.winCool, frameC: stone, sillC: stone, mull: 'v', mullC: stone });
  for (let y = gt + 2 + FL - 1; y < st - 3; y += FL) g.box(10, y, B.z0 - 4, 20, y, B.z0 - 1, stone);
  g.box(10, st - 3, B.z0 - 4, 20, st - 2, B.z0 - 1, stone);
  punch(g, B, 'fblr', { y0: gt + 2, y1: st - 1, floor: FL, sill: 3, wh: 7, w: 4, pitch: 6, margin: 3,
    glassFn: skyGlass([C.dtGlassDeep, C.dtGlass], nf), hi: C.winCool, frameC: stone, sillC: stone,
    skip: (S, u) => S.s === 'f' && u + 3 >= 10 && u <= 20 });
  for (const S of sides(g, B)) for (let y = gt + 2; y < st - 1; y += 4) {
    const w = 2 + ((y >> 2) & 1);
    S.f.box(S.u0 - 1, y, 0, S.u0 + w - 1, y + 2, 1, stone); S.f.box(S.u1 - w + 1, y, 0, S.u1 + 1, y + 2, 1, stone);
  }
  // top: dentils, cornice, parapet, billboard, roof crowd
  dentils(g, B, st, stone);
  const ct = roofCornice(g, B, st + 1, stone, trim, 2, 0);
  parapetOn(g, B, ct, 2, wall, stone);
  penthouse(g, 6, ct, 20, 12, 26, 8, stone, C.roofGray, trim);
  waterTank(g, 21, ct, 23, 3, 6, C.wood, C.darkGray);
  const bc = pk(rng, [C.orange, C.teal, C.yellow]);
  for (const x of [9, 21]) g.box(x, ct, 13, x, ct + 5, 13, C.darkGray);
  g.box(6, ct + 6, 12, 24, ct + 14, 12, C.dtFrame); g.box(7, ct + 7, 11, 23, ct + 13, 11, bc);
  textC(facade(g, 'front', 11), 15, ct + 8, pk(rng, ['CITY', 'LOANS', 'NEWS']), C.signWhite, 1);
  roofKit(g, 6, 14, 24, 18, ct, rng, 2);
  // lot
  tiles(g, 1, 1, 29, 7, Y - 1, C.lotPaveDark, 4); people(g, 1, 1, 29, 2, Y, 4, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Glass Office — modern 1×1 tower. BASE: grey-stone double-height lobby,
// entrance canopy. SHAFT: glass ribbons set back behind white floor slabs
// (a bright ledge every storey), the front-right corner notched into a stack
// of balconies, a glass stair tower standing proud of the left face. CROWN:
// a cornice, a set-back glass lantern with a second cornice, plant room,
// condensers, a mast.
function bGlassOffice(rng, v) {
  const glass = pk(rng, [[C.dtGlassDeep, C.dtGlass, C.dtGlassHi], [C.dtGlassDark, C.dtGlassTeal, C.dtGlassHi], [C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi]]);
  const wall = [C.dtLimeShade, C.dtGlassDeep, C.dtGlassTeal][v % 3];   // w10: a teal-clad tower (brief: brick / terracotta / teal / dark glass)   // r9: warmer shafts (critic r8: monochrome blue/grey)
  const nf = 5 + v;
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  const B = box(6, 10, 25, 28), P = box(2, 8, 28, 29);
  // (r9) modern street podium (glass ribbon upper storey) + glass portico
  const [pw0, pp0, pf0] = [POD.terra, POD.teal, POD.slate][v % 3]();
  const bt = streetPodium(g, P, Y, { ground: 'glass', wall: pw0, pier: pp0, fascia: pf0, style: 'modern', glass: glass[1], skipF: [8, 22], seed: 3 + v }) - 1, top = bt + 1 + FL * nf;
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'glass', colC: C.dtFrame, glassTop: C.dtGlassTeal, fascia: pf0, sign: 'letters', textC: C.yellow, text: pk(rng, ['CORP', 'MEDIA', 'CITY']) });
  // shaft
  shell(g, B, bt + 1, top, wall, C.roofGray);
  framedBays(g, B, 'fblr', { y0: bt + 1, y1: top - 1, bw: 5, pw: 1, cw: 1, pd: 1, cpd: 2, pierC: wall, spand: C.dtGlassDeep, inset: 0, sillC: null, deep: false, ledgeC: C.dtFrame, ledgeOut: 1,
    sill: 2, wh: 9, glassFn: skyGlass(SKY, nf, 6), sheen: C.dtGlassHi, hi: C.winCool, bandEvery: 3, bandOut: 2, bandH: 2, bandC: wall,
    ac: (S, k, r) => S.s !== 'f' && ((k * 3 + r * 5) % 7) === 2 });
  notch(g, B, box(B.x1 - 5, B.z0, B.x1, B.z0 + 5), bt + 1, top - 1, { floor: FL, back: C.dtGlassDeep, slab: wall, plants: true });
  // glass stair tower on the left face
  const Ts = box(2, 15, 5, 23);
  shell(g, Ts, bt + 1, top + 4, wall, C.roofGray);
  ribbons(g, Ts, 'flb', { y0: bt + 2, y1: top + 2, floor: FL, sill: 1, wh: 10, d: 1, cw: 1, pitch: 3, glass: glass[1], hiRows: 1, mullC: wall });
  // crown
  const ct = roofCornice(g, B, top, wall, C.dtNavyPanel, 2, 0);
  const K = box(B.x0 + 3, B.z0 + 4, B.x1 - 4, B.z1 - 3), kt = ct + 10;
  shell(g, K, ct, kt, wall, C.roofGray);
  ribbons(g, K, 'fblr', { y0: ct, y1: kt - 1, floor: 10, sill: 1, wh: 8, d: 1, cw: 1, pitch: 3, glass: glass[2], hiRows: 0, mullC: wall });
  const kc = roofCornice(g, K, kt, wall, C.dtNavyPanel, 1, 0);
  penthouse(g, K.x0 + 1, kc, K.z0 + 3, K.x1 - 5, K.z1 - 1, 5, C.metal, C.roofGray, C.metalDark);
  mast(g, K.x1 - 2, K.z1 - 2, kc, 16);
  acBox(g, B.x0 + 1, ct, B.z1 - 3, { w: 5, d: 3, h: 3 });
  acBox(g, B.x1 - 6, ct, B.z1 - 3, { w: 5, d: 3, h: 3 });
  // lot
  tiles(g, 1, 1, 29, 7, Y - 1, C.lotPaveDark, 4); people(g, 1, 1, 29, 2, Y, 4, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Brick Highrise — pre-war apartment-hotel. BASE: two rusticated limestone
// storeys, tall framed windows, a bronze entrance hood. SHAFT: brick with
// windows punched in pairs under stone lintels, proud stone sills, a
// projecting bay-window stack up the front, stone quoins, a stone belt every
// three storeys. TOP: attic storey, dentils + deep cornice, wooden water tank
// on steel legs, lift house, fire escape down the right side.
function bBrickHighrise(rng, v) {
  const brick = [C.brick, C.dtTerra, C.brickDark][v % 3];
  const stone = pk(rng, [C.dtLime, C.cream, C.dtStone]);
  const nf = 5 + v;
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  const B = box(5, 10, 25, 27), O = ins(B, -1), P = box(3, 8, 27, 29);
  // (r9) limestone street podium (arched upper storey, shop fascia) + a
  // copper-roofed temple portico, instead of the flat rusticated base
  const [pw0, pp0, pf0] = [POD.lime, POD.sand, POD.teal][v % 3]();
  const bt = streetPodium(g, P, Y, { wall: pw0, pier: pp0 === C.dtFrame ? C.dtLimeShade : pp0, fascia: pf0, skipF: [8, 22], seed: 5 + v, cornC: stone }) - 2, top = bt + 2 + FL * nf;
  shell(g, B, bt, top, brick, C.roofGray);
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'glass', colC: C.dtFrame, frame: C.gold, glassTop: C.dtCopper, fascia: C.darkGray, sign: 'letters', text: 'APTS', textC: C.gold });
  // shaft: bay-window stack on the front, paired punched windows
  const Bw = box(11, B.z0 - 3, 19, B.z1);
  g.box(11, bt + 2, B.z0 - 3, 19, top - 1, B.z0, brick);
  punch(g, Bw, 'f', { y0: bt + 2, y1: top - 1, floor: FL, sill: 2, wh: 8, w: 5, us: () => [13], glassFn: skyGlass([C.dtGlassDeep, C.dtGlass], nf), hi: C.win, frameC: stone, sillC: stone, mull: 'v', mullC: C.dtFrame });
  for (const x of [11, 19]) g.box(x, bt + 2, B.z0 - 3, x, top - 1, B.z0 - 3, stone);     // stone arrises on the bay
  punch(g, B, 'fblr', { y0: bt + 2, y1: top - 1, floor: FL, sill: 3, wh: 7, w: 3, pitch: 5, margin: 2,
    glassFn: skyGlass([C.dtGlassDeep, C.dtGlass], nf), hi: C.win, sillC: stone, mull: 'h', mullC: C.dtFrame,
    skip: (S, u) => S.s === 'f' && u + 2 >= 10 && u <= 20 });   // r6: no stone frame ring (it hid the brick: the tower read cream)
  for (let i = 3; i < nf; i += 3) course(g, B, bt + 2 + i * FL - 1, stone, 1, 1, 0);
  for (const S of sides(g, B)) for (let y = bt + 2; y < top; y += 4) {
    const w = 1 + ((y >> 2) & 1);                                        // r6: slimmer quoins, more brick
    S.f.box(S.u0 - 1, y, 0, S.u0 + w - 1, y + 2, 1, stone); S.f.box(S.u1 - w + 1, y, 0, S.u1 + 1, y + 2, 1, stone);
  }
  // fire escape on the right side
  const Rt = facade(g, 'right', B.x1);
  for (const y of rows(bt + 5, top - 8, FL, 7)) {
    Rt.box(13, y - 2, 1, 23, y - 2, 3, C.darkGray);
    Rt.box(13, y - 1, 3, 23, y + 1, 3, C.darkGray); Rt.clear(14, y, 3, 22, y, 3);
    const lx = 19 - ((y / FL) & 1) * 4; Rt.box(lx, y - 1, 2, lx, y + 9, 2, C.steel);
  }
  // top: dentils, deep cornice, parapet, water tank, lift house
  dentils(g, B, top + 1, stone);
  const ct = roofCornice(g, O, top + 2, stone, brick, 3, 0);
  parapetOn(g, O, ct, 2, brick, stone);
  waterTank(g, 11, ct, 21, 4, 9, C.wood, C.darkGray);
  penthouse(g, 17, ct, 12, 24, 19, 7, brick, C.roofGray, stone);
  roofKit(g, 6, 11, 15, 15, ct, rng, 1);
  ventPipe(g, 22, 24, ct, ct + 3);
  // lot
  tiles(g, 1, 1, 29, 7, Y - 1, C.lotPaveDark, 4); people(g, 1, 1, 29, 2, Y, 4, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Deco Tower — stepped setbacks. Windows sit in recessed vertical slots over
// dark spandrel panels with proud stone sills; stage one has its corners
// notched back into dark recesses; every setback carries a heavy stone
// cornice over a gold band and a terrace with urns. Base: a gold-framed
// grand entrance with lobby glass. Crown: stepped gold/stone fins + spire.
function bDecoTower(rng, v) {
  // r6: a distinct cladding per variant (critic r5: cream everywhere) —
  // dusty terracotta with navy spandrels, blue-grey stone with green, butter
  // faience with brown; gold trim throughout.
  const [stone, panel] = [[C.resTerracotta, C.dtNavyPanel], [C.dtStone, C.roofGreen], [C.resButter, C.roofBrown]][v % 3];
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  g.box(12, 1, 1, 18, 1, 6, C.lotPaveDark);
  const stages = [[box(5, 10, 25, 28), Y + 72 + v * 4], [box(8, 13, 22, 25), Y + 98 + v * 4], [box(10, 15, 20, 23), Y + 114 + v * 4]];
  // (r9) street podium in a contrasting material under stage one
  const [pw0, pp0, pf0] = [POD.teal, POD.brick, POD.deepBrick][v % 3]();
  const P = box(3, 8, 27, 29);
  let y0 = streetPodium(g, P, Y, { ground: 'arcade', wall: pw0, pier: C.gold === pp0 ? C.cream : pp0, fascia: pf0, skipF: [8, 22], seed: 1 + v, cornC: C.gold });
  for (let i = 0; i < stages.length; i++) {
    const [B, yt] = stages[i];
    shell(g, B, y0, yt, stone, stone);
    const start = y0 + 2;
    framedBays(g, B, 'fblr', { y0: start, y1: yt - 5, floor: 10, sill: 2, wh: 6, bw: 5, pw: 2, cw: i === 0 ? 3 : 2, pd: 1, cpd: 2, sillOut: 1, pierC: stone, spand: panel, deep: false, ledgeC: stone, ledgeOut: 1,
      inset: 1, jambs: false, frameC: C.gold, sillC: stone, glassFn: skyGlass(SKY, 10), sheen: C.dtGlassHi, hi: C.win, bandEvery: i === 0 ? 3 : 0, bandC: stone,
      balc: i === 1 ? (S, k) => k % 2 === 1 : null, balcC: stone, railC: C.gold });
    if (i === 0) for (const [x0, z0] of [[B.x0, B.z0], [B.x1 - 2, B.z0], [B.x0, B.z1 - 2], [B.x1 - 2, B.z1 - 2]])
      notch(g, B, box(x0, z0, x0 + 2, z0 + 2), y0 + 1, yt - 5, { floor: 20, back: panel, slab: stone, rail: null });
    const O = ins(B, -1);
    course(g, B, yt - 4, C.gold, 1, 1, 0);
    cornice(g, B, yt - 3, stone, panel, 2, 0);
    if (i < 2) for (const [x, z] of [[B.x0 + 1, B.z0 + 1], [B.x1 - 1, B.z0 + 1]]) { g.box(x, yt + 1, z, x, yt + 2, z, stone); g.set(x, yt + 3, z, C.bush); }
    y0 = yt + 1;
    void O;
  }
  // base: gold-framed glass portico on the podium
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'marquee', colC: C.gold, frame: C.gold, fascia: C.dtNavyPanel, text: 'DECO', textC: C.gold, mat: C.navy });
  // crown: stepped gold/stone fins + spire
  const top = y0, Bt = stages[2][0];
  for (let k = 0; k < 4; k++) g.walls(Bt.x0 + 1 + k, top + k * 3, Bt.z0 + 1 + k, Bt.x1 - 1 - k, top + k * 3 + 2, Bt.z1 - 1 - k, k % 2 ? stone : C.gold);
  for (let y = top + 12; y < top + 28; y++) g.set(15, y, 19, C.gold);
  g.set(15, top + 28, 19, C.red);
  // lot
  flag(g, 2, Y, 2, 18, C.red); flag(g, 28, Y, 5, 18, C.blue);
  tiles(g, 1, 1, 29, 7, Y - 1, C.lotPaveDark, 4); people(g, 3, 1, 27, 2, Y, 4, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Green Tower — eco balcony tower. A grey-stone lobby storey; above it the
// glass is set back in ribbons and deep white balcony slabs with glass rails
// wrap the front and right faces, planters and little trees on alternating
// floors; the quiet faces get thin sunshades. Crown: roof garden + pergola.
function bGreenGlassTower(rng, v) {
  const glass = pk(rng, [[C.dtGlassGreen, C.dtGlassTeal, C.dtGlassHi], [C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi], [C.dtGlassDeep, C.dtGlass, C.dtGlassHi]]);
  const nf = 5 + v;
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30, { fill: 'grass' });
  g.box(4, 1, 1, 26, 1, 7, C.lotPave);
  const B = box(6, 11, 24, 27), P = box(2, 8, 28, 29);
  // (r9) a warm street podium (brick / sandstone / terracotta, arched upper
  // storey) + a glass portico; the balcony tower rises from its roof
  const [pw0, pp0, pf0] = [POD.brick, POD.sand, POD.terra][v % 3]();
  const bt = streetPodium(g, P, Y, { ground: 'glass', canopyC: C.bush, glass: C.dtGlassGreen, wall: pw0, pier: pp0, fascia: pf0, skipF: [8, 22], seed: 2 + v }) - 1, top = bt + FL * nf;
  shell(g, B, bt, top, C.dtFrame, C.lotGrass);
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'pergola', colC: C.wood, fascia: C.roofGreen, text: 'ECO', textC: C.signWhite, mat: C.roofGreen });
  // shaft: glass ribbons, balconies on front + right, sunshades behind
  ribbons(g, B, 'fblr', { y0: bt + 1, y1: top - 1, floor: FL, sill: 1, wh: 10, d: 1, cw: 1, pitch: 4, glassFn: skyGlass(glass, nf, 7), hiRows: 1 });
  for (let i = 0, y = bt; y < top; y += FL, i++) {
    g.box(B.x0 - 3, y, B.z0 - 3, B.x1 + 3, y, B.z0 - 1, C.dtFrame);             // front slab
    g.box(B.x1 + 1, y, B.z0 - 3, B.x1 + 3, y, B.z1, C.dtFrame);                 // right slab
    if (i > 0) {
      g.box(B.x0 - 3, y + 1, B.z0 - 3, B.x1 + 3, y + 2, B.z0 - 3, C.dtGlassHi);  // rails
      g.box(B.x1 + 3, y + 1, B.z0 - 3, B.x1 + 3, y + 2, B.z1, C.dtGlassHi);
      g.box(B.x0 - 3, y + 1, B.z0 - 3, B.x0 - 3, y + 2, B.z0 - 1, C.dtGlassHi);
      const px = i % 2 ? B.x0 - 2 : B.x1 - 3;
      g.box(px, y + 1, B.z0 - 2, px + 3, y + 2, B.z0 - 1, C.bush);             // planter hedge
      if (i % 3 === 1) { g.box(B.x1 + 1, y + 1, B.z1 - 4, B.x1 + 2, y + 3, B.z1 - 3, C.leafMid); g.box(B.x1 + 1, y + 4, B.z1 - 4, B.x1 + 2, y + 4, B.z1 - 3, C.lime); }
    }
    g.walls(B.x0 - 1, y, B.z0, B.x0 - 1, y, B.z1 + 1, C.dtFrame);             // sunshades
    g.box(B.x0, y, B.z1 + 1, B.x1, y, B.z1 + 1, C.dtFrame);
  }
  // roof garden + pergola
  parapetOn(g, B, top + 1, 2, C.dtFrame, C.dtGlassHi);
  tree(g, 9, top + 1, 13, 6); tree(g, 19, top + 1, 21, 6);
  planter(g, 8, 20, 13, 24, top + 1, { box: C.dtFrame, flowers: [C.pink, C.yellow, C.signWhite] });
  for (const [x, z] of [[15, 12], [21, 12], [15, 17], [21, 17]]) g.box(x, top + 1, z, x, top + 7, z, C.wood);
  for (let x = 15; x <= 21; x += 2) g.box(x, top + 8, 12, x, top + 8, 17, C.wood);
  g.box(15, top + 9, 12, 21, top + 9, 12, C.wood); g.box(15, top + 9, 17, 21, top + 9, 17, C.wood);
  // lot: paved forecourt
  people(g, 3, 1, 27, 2, Y, 4, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Clock Tower — civic stone tower in ONE stone and ONE accent (critic r2:
// "the clock tower's colour blocks are noisy"). BASE: freestanding columns
// two voxels clear of deep lobby glass, a broad stair. SHAFT: windows punched
// with proud sills and lintels, corner quoins, a belt every three storeys.
// TOP: a clock stage with a clock on every face, dentils + cornice, corner
// pinnacles, an arcaded lantern and a roof in the accent colour + finial.
function bClockTower(rng, v) {
  const k0 = (v + ((rng() * 3) | 0)) % 3;
  const [stone, shade, roofC] = [[C.dtStone, C.stone, C.dtCopper], [C.dtLime, C.dtLimeShade, C.roofGreen],
    [C.cream, C.sandDark, C.roofRed]][k0];
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  g.box(10, 1, 1, 20, 1, 5, C.lotPaveDark);
  const B = box(7, 12, 23, 28), O = ins(B, -2);
  // (w10) base: a two-storey colonnade podium (giant order in front of a dark
  // glass hall) + a temple portico over a broad stair — the old red column
  // cage read as "pipes on a thin plinth", not a civic base
  const k = k0, P = box(3, 9, 27, 29);
  const bt = streetPodium(g, P, Y, { ground: 'colonnade', colC: [C.dtFrame, C.cream, C.dtLime][k], wall: shade, pier: stone, skipF: [8, 22], seed: 5 + v, cornC: stone }) - 1;
  const nf = 3 + v, st = bt + 2 + FL * nf, ct = st + 22;
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'temple', colC: [C.dtFrame, C.cream, C.dtLime][k], stone: C.dtLimeShade, roofC, text: 'TOWN', textC: C.dtNavyPanel });
  // shaft
  shell(g, B, bt + 1, ct, stone, C.roofGray);
  punch(g, B, 'fblr', { y0: bt + 2, y1: st - 1, floor: FL, sill: 3, wh: 7, w: 3, pitch: 5, margin: 3,
    glassFn: skyGlass([C.dtGlassDeep, C.dtGlass], nf), hi: C.win, hiRows: 1, frameC: shade, sillC: shade });
  for (let y = bt + 2 + 3 * FL - 1; y < st - 4; y += 3 * FL) course(g, B, y, shade, 1, 1, 0);
  for (const S of sides(g, B)) for (let y = bt + 2; y < st; y += 4) {
    const w = 2 + ((y >> 2) & 1);
    S.f.box(S.u0 - 1, y, 0, S.u0 + w - 1, y + 2, 1, stone); S.f.box(S.u1 - w + 1, y, 0, S.u1 + 1, y + 2, 1, stone);
  }
  // clock stage
  course(g, O, st, shade, 0, 2, 0);
  shell(g, O, st + 2, ct, stone, C.roofGray);
  for (const S of sides(g, O)) { S.f.box(S.u0, st + 2, 1, S.u0 + 1, ct, 1, shade); S.f.box(S.u1 - 1, st + 2, 1, S.u1, ct, 1, shade); clockFace(S.f, (S.u0 + S.u1) >> 1, st + 12, 7); }
  dentils(g, O, ct, shade);
  const cy = roofCornice(g, O, ct + 1, stone, shade, 2, 0);
  for (const [x, z] of [[O.x0, O.z0], [O.x1 - 1, O.z0], [O.x0, O.z1 - 1], [O.x1 - 1, O.z1 - 1]]) { g.box(x, cy, z, x + 1, cy + 4, z + 1, stone); g.box(x, cy + 5, z, x + 1, cy + 6, z + 1, roofC); }
  parapetOn(g, O, cy, 1, stone, null);
  // lantern: arcade + roof + finial
  const K = ins(B, 3);
  shell(g, K, cy, cy + 11, stone, stone);
  for (const S of sides(g, K)) { S.f.clear(S.u0 + 2, cy + 2, 0, S.u1 - 2, cy + 8, 0); S.f.box(S.u0 + 2, cy + 2, -1, S.u1 - 2, cy + 8, -1, C.win); for (const u of bays(S.u0, S.u1, 2, 3, 1)) S.f.box(u, cy + 2, 0, u, cy + 8, 0, stone); }
  let y = cy + 12;
  for (let k = -1; k <= 5; k++, y++) g.box(K.x0 + k, y, K.z0 + k, K.x1 - k, y, K.z1 - k, roofC);
  for (let yy = y; yy < y + 6; yy++) g.set(15, yy, 20, C.gold);
  g.box(14, y + 6, 19, 16, y + 6, 21, C.gold);
  g.set(15, y + 7, 20, C.gold);
  // lot
  planter(g, 1, 2, 5, 6, Y, { box: shade }); planter(g, 25, 2, 29, 6, Y, { box: shade });
  lamp(g, 7, Y, 1); lamp(g, 23, Y, 1);
  hedge(g, 1, Y, 10, 2, 29); hedge(g, 28, Y, 10, 29, 29);
  tiles(g, 1, 1, 29, 8, Y - 1, C.lotPaveDark, 4); people(g, 1, 1, 29, 7, Y, 6, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Round Tower — glass drum with white floor ribbons on a round podium,
// crown ring, drum + dome + beacon mast.
function bRoundTower(rng, v) {
  const glass = [C.dtGlass, C.dtGlassTeal, C.dtGlassDeep][v % 3]; void pk(rng, GLASS);
  // (w10) per-variant slab colour: white / terracotta / cream (the drum was
  // one blue-and-white stripe in every variant, repeated 4x in iso-mid)
  const slabC = [C.dtFrame, C.resTerracotta, C.cream][v % 3];
  const nf = 6 + v;
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  const cx = 15, cz = 17;
  const disc = (r, y0, y1, fn) => {
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
      const d = x * x + z * z;
      if (d > r * r + r) continue;
      const edge = (x + 1) * (x + 1) + z * z > r * r + r || (x - 1) * (x - 1) + z * z > r * r + r || x * x + (z + 1) * (z + 1) > r * r + r || x * x + (z - 1) * (z - 1) > r * r + r;
      for (let y = y0; y <= y1; y++) { const c = fn(edge, y, x, z); if (c != null) g.set(cx + x, y, cz + z, c); }
    }
  };
  // (r9) square street podium (critic r8: the drum carried its grid down to
  // a tiny plinth) — terracotta / cream / teal, arched upper storey, portico
  const P = box(3, 7, 27, 29);
  const [pw0, pp0, pf0] = [POD.terra, POD.cream, POD.teal][v % 3]();
  const y0 = streetPodium(g, P, Y, { ground: 'arcade', wall: pw0, pier: pp0, fascia: pf0, skipF: [8, 22], seed: 4 + v });
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'slab', colC: C.dtFrame, fascia: pf0, sign: 'letters', textC: C.yellow, text: ['ORBIT', 'HALO', 'ROUND'][v % 3], planters: false });
  const top = y0 + FL * nf;
  disc(10, y0, top, (e, y) => {
    if (!e) return y === top ? C.roofGray : null;
    const k = (y - y0) % FL;
    return k < 3 ? slabC : (k >= FL - 2 ? C.winCool : glass);
  });
  // mullions: eight vertical white lines
  for (let y = y0; y < top; y++) for (const [x, z] of [[0, -10], [0, 10], [-10, 0], [10, 0], [-7, -7], [7, -7], [-7, 7], [7, 7]]) g.set(cx + x, y, cz + z, slabC);
  // proud floor slabs; every third one a balcony ring with a glass rail, and
  // a vertical glass fin up the front (critic: "a uniform striped drum")
  for (let y = y0 + FL, i = 1; y < top - 2; y += FL, i++) {
    if (i % 3 === 0) { disc(12, y, y, (e) => (e ? slabC : null)); disc(12, y + 1, y + 2, (e) => (e ? C.dtGlassHi : null)); disc(12, y + 3, y + 3, (e) => (e ? slabC : null)); }
    else disc(11, y, y, (e) => (e ? slabC : null));
  }
  for (let y = y0; y < top + 6; y++) { g.box(cx - 1, y, cz - 12, cx + 1, y, cz - 11, y % 6 < 1 ? slabC : C.dtGlassTeal); }
  disc(11, top - 1, top, (e) => (e ? slabC : null));
  disc(11, top + 1, top + 2, (e) => (e ? C.dtGlassHi : null));
  disc(7, top + 1, top + 8, (e, y) => (e ? (y > top + 3 ? glass : slabC) : (y === top + 8 ? slabC : null)));
  for (let k = 0; k < 5; k++) disc(6 - k, top + 9 + k, top + 9 + k, () => C.metal);
  mast(g, cx, cz, top + 14, 12);
  // lot
  people(g, 1, 1, 29, 1, Y, 3, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Grand Hotel — the ref05 hotel. BASE: a two-storey rosy-brick podium one
// voxel proud of the shaft on a granite plinth: tall white-framed windows
// with sills, cream quoins, a cream cornice; teal-glass porte-cochère on
// columns, steps, shrubs. SHAFT: cream walls, windows punched into red
// spandrel slots with proud sills, a projecting centre bay (front + back)
// and a cream band every two storeys. TOP: teal glass band storey, a heavy
// navy cornice with dentils, the HOTEL sign on stilts, a crowded roof with
// condensers, a water tank and the lift house.
function bHotel(rng, v) {
  const body = pk(rng, [C.dtLime, C.cream, C.resQuoin]);
  const red = pk(rng, [C.dtTerra, C.brick, C.dtTerra]);
  const nf = 3 + v, HF = 10;                        // hotel storeys are 2.5 units
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30, { fill: C.sand });
  const B = box(4, 12, 26, 28), O = ins(B, -1);     // B = shaft wall, O = podium face
  const bt = Y + 22, s0 = bt + 2, st = s0 + HF * nf, top = st + 11;
  shell(g, B, Y, top, body, C.roofGray);
  // ---- podium
  shell(g, O, Y, bt, red, C.roofGray);
  course(g, O, Y, C.stoneDark, 0, 2, 0);
  punch(g, O, 'blr', { y0: Y + 2, y1: bt - 2, floor: 24, sill: 1, wh: 15, w: 3, pitch: 5, margin: 4, glass: C.dtGlassDeep, hi: C.winCool, hiRows: 2, frameC: C.dtFrame, sillC: body, mull: 'h' });
  punch(g, O, 'f', { y0: Y + 2, y1: bt - 2, floor: 24, sill: 1, wh: 15, w: 3, us: () => [7, 21], glass: C.dtGlassDeep, hi: C.winCool, hiRows: 2, frameC: C.dtFrame, sillC: body, mull: 'h' });
  for (const S of sides(g, O)) for (let y = Y + 2; y < bt - 1; y += 4) { const w = 2 + ((y >> 2) & 1); S.f.box(S.u0 - 1, y, 0, S.u0 + w - 1, y + 1, 1, body); S.f.box(S.u1 - w + 1, y, 0, S.u1 + 1, y + 1, 1, body); }
  course(g, O, bt - 1, body, 1, 2, 0);
  course(g, O, bt + 1, body, 0, 1, 0);
  // ---- shaft: projecting centre bays (front + back) then punched windows
  for (const [z0, z1] of [[B.z0 - 2, B.z0], [B.z1, B.z1 + 2]]) g.box(11, s0, z0, 19, st, z1, body);
  const Bf = box(11, B.z0 - 2, 19, B.z1 + 2);
  const tones = [C.dtGlass, C.dtGlass, C.dtGlassHi];
  // cream pilasters standing proud of red spandrel slots (the ref05 hotel)
  // red-brick bays between cream pilasters, white-headed windows with cream
  // sills and AC units (the ref05 hotel): the red shows beside every window
  const hb = { y0: s0, y1: st - 1, floor: HF, sill: 2, wh: 6, pd: 1, cpd: 2, sillOut: 1, pierC: body, spand: red,
    frameC: C.dtFrame, sillC: body, jambs: false, glassFn: skyGlass(tones, nf), sheen: C.dtGlassHi, hi: C.winCool,
    ac: (S, k, r) => ((k * 5 + r * 3 + S.u0) % 6) === 1 };
  framedBays(g, B, 'fb', { ...hb, bw: 6, inset: 1, us: () => [5, 20] });
  framedBays(g, B, 'lr', { ...hb, bw: 6, pw: 1, cw: 2, inset: 1 });
  punch(g, Bf, 'fb', { y0: s0, y1: st - 1, floor: HF, sill: 2, wh: 6, w: 5, us: () => [13],
    glassFn: skyGlass([C.dtGlassTeal, C.dtGlass, C.dtGlassHi], nf), hi: C.winCool, hiRows: 1, frameC: C.dtFrame, sillC: C.dtFrame, mull: 'v' });
  for (let i = 2; i < nf; i += 2) { course(g, B, s0 + i * HF - 1, body, 1, 1, 0); g.box(10, s0 + i * HF - 1, B.z0 - 3, 20, s0 + i * HF - 1, B.z1 + 3, body); }
  // ---- top: glass band storey, heavy cornice, parapet
  course(g, O, st, body, 1, 1, 0);
  shell(g, O, st + 1, top - 1, body, C.roofGray);
  bayWall(g, O, 'fblr', { bw: 19, cw: 3, d: 1, y0: st + 2, y1: top - 2, floor: 12, sill: 0, wh: 8, glass: C.dtGlassTeal, hi: C.winCool, hiRows: 2, spandrel: C.dtFrame });
  for (const S of sides(g, O)) for (let u = S.u0 + 5; u < S.u1 - 3; u += 3) S.f.box(u, st + 2, -1, u, top - 2, -1, C.dtFrame);
  dentils(g, O, top, C.dtFrame);
  const ct = roofCornice(g, O, top + 1, C.dtNavyPanel, C.dtFrame, 3, 0);
  parapetOn(g, O, ct, 2, C.dtNavyPanel, C.dtFrame);
  // HOTEL sign standing on the front edge: black box, gold rim, yellow letters
  const sy = ct + 1, sz = O.z0 - 1;
  for (const x of [O.x0 + 5, O.x1 - 5]) g.box(x, ct, sz + 2, x, sy + 2, sz + 3, C.darkGray);
  const sx0 = O.x0 - 3, sx1 = O.x1 + 3;                // 31 wide: crisp 5x7 HOTEL needs 29
  g.box(sx0, sy + 2, sz, sx1, sy + 12, sz + 1, C.black);
  for (const zz of [sz, sz + 1]) {
    g.box(sx0, sy + 12, zz, sx1, sy + 12, zz, C.gold); g.box(sx0, sy + 2, zz, sx1, sy + 2, zz, C.gold);
    g.box(sx0, sy + 2, zz, sx0, sy + 12, zz, C.gold); g.box(sx1, sy + 2, zz, sx1, sy + 12, zz, C.gold);
  }
  text5(facade(g, 'front', sz), 15, sy + 4, 'HOTEL', C.yellow, 0, 1);
  text5(facade(g, 'back', sz + 1), 15, sy + 4, 'HOTEL', C.yellow, 0, 1);
  // roof crowd: lift house, water tank, condensers, vents
  penthouse(g, 7, ct, 20, 13, 26, 7, body, C.roofGray, C.dtNavyPanel);
  waterTank(g, 21, ct, 23, 3, 6, C.wood, C.darkGray);
  roofCrowd(g, O.x0 + 2, O.z0 + 5, O.x1 - 2, 19, ct, rng, { ac: 3, vents: 2 });
  // ---- porte-cochere: teal glass roof on stone columns, steps, doors
  const F = facade(g, 'front', O.z0);
  F.clear(11, Y, 0, 19, Y + 14, 0); F.box(11, Y, -1, 19, Y + 14, -1, C.dtGlassDark);
  door(F, 12, Y, 7, 11, { color: C.dtGlassDark, glass: C.winCool, frame: C.gold, double: true, step: null });
  g.box(9, Y + 15, 3, 21, Y + 16, O.z0 - 1, body);
  g.box(10, Y + 17, 4, 20, Y + 18, O.z0 - 2, C.dtGlassTeal);
  g.walls(9, Y + 17, 3, 21, Y + 17, O.z0 - 1, C.dtFrame);
  for (const x of [9, 20]) for (const z of [3, O.z0 - 3]) { g.box(x, Y, z, x + 1, Y + 14, z + 1, C.dtFrame); g.box(x, Y, z, x + 1, Y, z + 1, C.stoneDark); }
  g.box(11, Y, 5, 19, Y, O.z0 - 1, C.dtLimeShade); g.box(12, Y + 1, 7, 18, Y + 1, O.z0 - 1, C.dtLimeShade);
  g.box(10, 1, 1, 20, 1, 2, C.red);                                      // red carpet kerb
  // ---- lot: hedges, shrub planters, lamps, luggage cart
  hedge(g, 1, Y, 1, 6, 3); hedge(g, 24, Y, 1, 29, 3);
  hedge(g, 1, Y, 11, 2, 29); hedge(g, 28, Y, 11, 29, 29);
  planter(g, 2, 5, 6, 8, Y, { box: C.dtFrame }); planter(g, 24, 5, 28, 8, Y, { box: C.dtFrame });
  lamp(g, 7, Y, 2); lamp(g, 23, Y, 2);
  people(g, 1, 1, 29, 10, Y, 6, rng);
  for (const [x, z] of [[2, 9], [26, 9]]) { g.box(x, Y, z, x + 2, Y + 1, z + 1, C.dtCopper); g.box(x, Y + 2, z, x + 2, Y + 2, z + 1, C.gold); }
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// ===========================================================================
// 2×1 OFFICE BLOCKS (canvas 63 × ≤256 × 31)
// ===========================================================================

// Office Block — modern white mid-rise. Ribbon windows set back in each
// storey over dark spandrel bands, sunshade fins over the front ribbons, a
// granite lobby storey, a projecting glass stair tower with the CITY sign,
// a lower wing with a roof terrace, penthouse + solar; side car park.
function bOfficeBlock(rng, v) {
  const [wall, band] = [[C.dtFrame, C.dtTerra], [C.cream, C.dtGlassTeal]][v % 2];   // w10: cream + teal (v1 was a grey slab)   // r8: no navy spandrels   // r6: per-variant material
  const glass = pk(rng, [[C.dtGlassDeep, C.dtGlass, C.dtGlassHi], [C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi]]);
  const g = grid(63, 256, 31, R);
  const Y = lotPlinth(g, 0, 0, 62, 30);
  g.box(2, 1, 2, 17, 1, 28, C.lotAsphalt);
  parkCol(g, 4, 28, 3, 13, rng, 0.7);
  const nf = 4 + v;
  // (r9) a two-storey street podium under both volumes (brick with arched
  // windows / teal with a glass ribbon) + a columned portico under the stair bay
  const Pd = box(20, 9, 61, 29);
  const [pw0, pp0, pf0] = [POD.brick, POD.teal][v % 2]();
  const gt = streetPodium(g, Pd, Y, { ground: v % 2 ? 'glass' : 'arcade', wall: pw0, pier: pp0, fascia: pf0, style: v % 2 ? 'modern' : 'arch', skipF: [38, 54], seed: 6 + v }) - 1, top = gt + FL * nf, wt = top - FL * 2;
  const M = box(34, 11, 59, 27), W = box(21, 12, 34, 27);
  shell(g, M, gt, top, wall, C.roofGray);
  shell(g, W, gt, wt, wall, C.lotGrass);
  // offices: piers standing proud of recessed bays over dark spandrels, a band every 2 storeys
  const bay = { bw: 5, pw: 2, cw: 2, pd: 1, cpd: 2, pierC: wall, spand: band, frameC: C.dtFrame, sillC: null, deep: false, ledgeC: wall, ledgeOut: 1, sill: 2, wh: 8, glassFn: skyGlass(SKY, nf, 6), sheen: C.dtGlassHi, hi: C.winCool, bandEvery: 3, bandC: wall,
    ac: (S, k, r) => ((k * 3 + r * 7) % 5) === 1 };
  framedBays(g, M, 'fblr', { ...bay, y0: gt + 1, y1: top - 1 });
  framedBays(g, W, 'fbl', { ...bay, y0: gt + 1, y1: wt - 1 });
  // balcony notches down the two right-hand corners, a service core on the back
  for (const z0 of [M.z0, M.z1 - 5]) notch(g, M, box(M.x1 - 6, z0, M.x1, z0 + 5), gt + 1, top - 1, { floor: FL, back: C.dtGlassDeep, slab: wall, plants: true });
  g.box(42, gt + 1, M.z1, 50, top + 4, M.z1 + 2, band);
  // r8: stair windows up the core + a ledge per floor (the back was a blank slab)
  punch(g, box(42, M.z1, 50, M.z1 + 2), 'b', { y0: gt + 1, y1: top - 1, floor: FL, sill: 3, wh: 7, w: 3, us: () => [45], glass: C.dtGlass, hi: C.winCool, frameC: C.dtFrame, sillC: C.dtFrame, mull: 'h' });
  g.box(41, top + 5, M.z1 - 1, 51, top + 6, M.z1 + 2, wall);
  for (let y = gt + 1 + 2 * FL; y < top - 2; y += 2 * FL) g.box(41, y, M.z1 + 1, 51, y, M.z1 + 3, wall);
  // projecting glass stair / atrium bay on the front
  const Fb = box(41, 5, 51, 11);
  shell(g, Fb, gt, top + 6, wall, C.roofGray);
  ribbons(g, Fb, 'flr', { y0: gt + 1, y1: top + 3, floor: FL, sill: 1, wh: 10, d: 1, cw: 1, pitch: 3, glassFn: skyGlass([C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi], nf + 1), hiRows: 1, mullC: wall });
  g.box(Fb.x0, gt - 1, Fb.z0, Fb.x1, gt - 1, Pd.z0 - 1, wall);
  portico(g, Pd.z0, { Y, xc: 46, w: 9, depth: 6, kind: 'slab', cols: 4, fascia: band, colC: pp0 === C.dtFrame ? C.dtFrame : C.cream, stone: C.dtLimeShade, roofC: band, sign: 'letters', text: 'CITY', textC: C.yellow });
  // wing roof terrace
  parapetOn(g, W, wt + 1, 1, C.dtGlassHi, null);
  umbrella(g, 26, wt + 1, 13, C.red, C.signWhite); umbrella(g, 27, wt + 1, 22, C.teal, C.signWhite);
  planter(g, 30, 11, 33, 25, wt + 1, { box: wall });
  // main roof
  const ct = roofCornice(g, M, top, wall, band, 2, 0);
  parapetOn(g, M, ct, 1, wall, null);
  solarPanel(g, 37, 18, 56, 25, ct);
  roofKit(g, 44, 9, 57, 16, ct, rng, 2);
  penthouse(g, 36, ct, 9, 42, 15, 7, wall, C.roofGray, band);
  // lot
  hedge(g, 21, Y, 2, 31, 3); hedge(g, 60, Y, 4, 61, 8);
  people(g, 20, 1, 61, 2, Y, 6, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Shops & Offices — two-storey retail podium (awnings, signs, shop windows)
// with a set-back office slab above and a podium roof terrace.
function bShoppingOffice(rng, v) {
  const slabC = pk(rng, [C.resSage, C.dtStone, C.resButter]);     // r6: not cream again
  // r8: light, coloured spandrels (critic r7: the dark navy spandrel stripes
  // read as flat colour slabs; ref05's hotel shows warm panels between floors)
  const spand = pk(rng, [C.dtTerra, C.dtGlassDeep, C.dtCopper]);
  const podC = pk(rng, [C.dtTerra, C.teal, C.dtStone]);
  const glass = pk(rng, GLASS);
  const g = grid(63, 256, 31, R);
  const Y = lotPlinth(g, 0, 0, 62, 30);
  const P = box(3, 6, 59, 28);
  const pt = Y + 2 * FL + 2;
  // (r9) the sides + back get the shared street-podium dress (shop glass,
  // fascia with boards + awnings, an arcade, cornice); the front keeps its
  // four signed shops (the camera sees the backs half the time)
  streetPodium(g, P, Y, { h: pt - Y + 3, which: 'lrb', wall: podC, pier: podC === C.dtStone ? C.dtFrame : C.cream, fascia: C.darkGray, seed: 2 + v, roof: C.lotPaveDark });
  // shopfronts on the front: 4 shops with coloured awnings + signs
  const F = facade(g, 'front', P.z0);
  const shops = [['CAFE', C.red], ['TOYS', C.yellow], ['BOOKS', C.teal], ['SHOES', C.pink]];
  for (let i = 0; i < 4; i++) {
    const u0 = 5 + i * 14, u1 = u0 + 11;
    F.clear(u0, Y, 0, u1, Y + 11, 0);
    F.box(u0, Y, -1, u1, Y + 11, -1, C.dtGlass);
    F.box(u0, Y + 9, -1, u1, Y + 11, -1, C.winCool);
    F.box(u0 + 4, Y, -1, u0 + 7, Y + 8, -1, C.dtGlassDark);
    F.box(u0 - 1, Y + 12, 0, u1 + 1, Y + 12, 0, C.dtFrame);
    const [name, col] = shops[(i + v) % 4];
    for (let k = 0; k < 3; k++) F.box(u0, Y + 15 - k, k + 1, u1, Y + 15 - k, k + 1, (k & 1) ? C.signWhite : col);
    signPanel(F, u0, u1, Y + 17, Y + 23, C.dtFrame, { out: 1 });
    textC(F, (u0 + u1) >> 1, Y + 18, name, col, 2);
  }
  // office slab, set back: framed punched windows with sills, balcony
  // notches at both front corners, a glass stair tower on the front, a band
  // every two storeys, heavy cornice
  const O = box(8, 13, 54, 26);
  const nf = 5 + v;
  const top = pt + 2 + FL * nf;
  shell(g, O, pt + 1, top, slabC, C.roofGray);
  framedBays(g, O, 'fblr', { y0: pt + 1, y1: top - 1, bw: 7, pw: 2, cw: 3, pd: 1, cpd: 2, pierC: slabC, spand: spand, frameC: C.dtFrame, sillC: null, sill: 2, wh: 8, deep: false,
    ledgeC: C.dtFrame, ledgeOut: 1,
    glassFn: skyGlass([C.dtGlass, glass, C.dtGlassHi], nf, 6), sheen: C.dtGlassHi, hi: C.winCool, bandEvery: 3, bandC: slabC, bandOut: 2,
    balc: (S, k, r) => S.s === 'f' && r % 2 === 1 && k % 2 === 0, balcC: C.dtFrame, ac: (S, k, r) => S.s !== 'f' && ((k * 3 + r * 5) % 6) === 2 });
  for (const x0 of [O.x0, O.x1 - 6]) notch(g, O, box(x0, O.z0, x0 + 6, O.z0 + 4), pt + 1, top - 1, { floor: FL, back: C.dtGlass, slab: C.dtFrame, plants: true });
  // service core standing proud of the back
  // (r9) in the podium colour with a stair-window column + a ledge every two
  // storeys (it was a flat spandrel-coloured slab: a big blue stripe up the back)
  g.box(26, pt + 1, O.z1, 36, top + 3, O.z1 + 2, podC);
  punch(g, box(26, O.z1, 36, O.z1 + 2), 'b', { y0: pt + 2, y1: top - 1, floor: FL, sill: 3, wh: 7, w: 3, us: () => [30], glass: C.dtGlass, hi: C.winCool, frameC: C.dtFrame, sillC: C.dtFrame, mull: 'h' });
  for (let y = pt + 1 + 2 * FL; y < top - 2; y += 2 * FL) g.box(25, y, O.z1 + 1, 37, y, O.z1 + 3, C.dtFrame);
  g.box(25, top + 4, O.z1 - 1, 37, top + 5, O.z1 + 3, slabC);
  const Ts = box(27, 9, 35, 13);
  shell(g, Ts, pt + 1, top + 6, slabC, C.roofGray);
  ribbons(g, Ts, 'flr', { y0: pt + 2, y1: top + 4, floor: FL, sill: 1, wh: 10, d: 1, cw: 1, pitch: 3, glass: C.dtGlassTeal, hiRows: 1, mullC: slabC });
  cornice(g, Ts, top + 6, slabC, spand, 1, 0);
  dentils(g, O, top, C.dtFrame);
  const ct = roofCornice(g, O, top + 1, slabC, spand, 2, 0);
  parapetOn(g, O, ct, 1, slabC, null);
  roofCrowd(g, 12, 16, 36, 24, ct, rng, { ac: 3, vents: 2 });
  penthouse(g, 40, ct, 16, 50, 23, 8, C.dtFrame, C.roofGray, C.metalDark);
  // podium roof terrace (front strip)
  for (const x of [13, 22, 41, 50]) umbrella(g, x, pt + 1, 8, C.red, C.signWhite);
  planter(g, 4, 7, 7, 27, pt + 1, { box: C.dtFrame });
  planter(g, 55, 7, 58, 27, pt + 1, { box: C.dtFrame });
  // lot: sidewalk café tables + lamps
  for (const x of [8, 22]) umbrella(g, x, Y, 2, C.red, C.signWhite);
  bench(g, 38, Y, 1, 'x', 6);
  lamp(g, 33, Y, 2); lamp(g, 60, Y, 2); lamp(g, 1, Y, 2);
  people(g, 1, 1, 61, 4, Y, 10, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// ===========================================================================
// 2×2 SKYSCRAPERS (canvas 63 × ≤256 × 63)
// ===========================================================================

// shared: a two-storey stone podium, recessed glass colonnade on every side
function podium(g, P, Y, h, wall, glass, frame = C.dtFrame) {
  shell(g, P, Y, Y + h, wall, C.lotPaveDark);
  for (const S of sides(g, P)) lobbyGlass(S, S.u0 + 3, S.u1 - 3, Y + 1, h - 4, glass, frame, 6, 1);
  course(g, P, Y + h - 2, wall, 1, 2, 0);
}

// Glass Skyscraper — round 4: a curtain wall of white fins standing proud of
// continuous glass slots (sky-gradient glass, 2 panes per bay), wide white
// sky-lobby bands 3 out every four storeys. BASE: a granite-plinth lobby of
// square piers over deep dark glass, a cantilevered canopy with SKY letters,
// a SKY sign box on the podium roof. CROWN: cornice + railing, cooling
// towers, condensers, a set-back lantern, helipad, mast and dish. Lot: paved
// plaza with planters, trees, benches and people; parking down both sides.
function bGlassSkyscraper(rng, v) {
  // r6: a GLASS PRISM (critic r5: towers were cream/white shafts with a small
  // window grid; "dark curtain-wall glass" was one of the materials asked
  // for). The fins between the slots are blue glass (v1: teal), so the shaft
  // reads as one tinted curtain wall; white only on the corner piers, the
  // sky-lobby bands and the cornices. The glass lightens up the height.
  // (w10) a DARK-GLASS tower: glass-coloured pilasters + spandrels, so the
  // shaft reads as one deep-blue (v1 teal) curtain wall ruled by white frames
  // and a white ledge on every floor (SKY, SPIRE and BLOX were three pale
  // grey-white shafts side by side)
  const [fin, spandG, tones, pierS] = [[C.dtGlassDeep, C.dtGlassDark, [C.dtGlass, C.dtGlass, C.dtGlassHi, C.dtGlassHi], C.dtGlassDeep],
    [C.dtGlassTeal, C.dtGlassTeal, [C.dtGlass, C.dtGlass, C.dtGlassHi, C.dtGlassHi], C.dtGlassTeal]][v % 2];
  const wall = C.dtFrame;
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62);
  // podium (r5: stepped in from the lot edge so every side can be dressed)
  const P = box(11, 16, 51, 53);     // r7: 10-wide car parks each side
  // (r9) a warm two-storey street podium (terracotta glass-ribbon / brick
  // arcade) with shop signs + awnings, and a teal-glass portico on columns
  const [pw0, pp0, pf0] = [POD.terra, POD.brick][v % 2]();
  const pt = streetPodium(g, P, Y, { ground: 'colonnade', wall: v % 2 ? C.dtLimeShade : C.cream, colC: C.dtFrame, pier: C.dtFrame, fascia: pf0, skipF: [22, 40], seed: v }) - 1;
  tiles(g, 1, 1, 61, 15, Y - 1, C.lotPaveDark, 5);
  portico(g, P.z0, { Y, xc: 31, w: 15, depth: 7, kind: 'glass', cols: 4, colC: C.dtFrame, glassTop: C.dtGlassTeal, fascia: C.dtNavyPanel, sign: 'letters', text: 'SKY', textC: C.yellow, planters: false });
  // shaft
  const T = box(13, 19, 49, 50), nf = 8 + v;
  const y0 = pt + 1, top = y0 + FL * nf;
  shell(g, T, y0, top, pierS, C.roofGray);
  // glass fins between continuous glass slots (curtain wall), dark-glass
  // corner piers standing 2 proud, a white sky-lobby band every four storeys
  // (r8) critic r7: "tall slabs of flat colour … each bay one repeated window
  // strip, nothing marks the floors". Now: silver-stone pilasters standing 1
  // proud between white-framed windows, a white ledge on EVERY floor (lit top
  // + shadow line), light corner piers (no navy mass), bright glass.
  { const skyB = { y0, y1: top - 1, pw: 1, cw: 1, pd: 1, cpd: 2, pierC: pierS, cornerC: fin, spand: spandG, inset: 0, sillC: null, frameC: C.dtGlassHi, mullC: pierS,
    sill: 2, wh: 8, glassFn: skyGlass(tones, nf, 9), sheen: C.dtGlassHi, hi: C.winCool, bandEvery: 4, bandH: 2, bandOut: 3, bandC: wall, deep: false,
    ledgeC: wall, ledgeOut: 1,
    balc: (S, k, r) => r % 4 !== 3 && (k === 0 || k === 3) && r % 2 === 0, balcC: wall, railC: C.dtGlassHi,
    ac: (S, k, r) => k > 0 && k < 3 && ((k * 3 + r * 5 + S.u0) % 9) === 0 };
  framedBays(g, T, 'fb', { ...skyB, bw: 8 }); framedBays(g, T, 'lr', { ...skyB, bw: 9 }); }
  // r7: a sky garden splits the shaft (lower 4 storeys / upper storeys)
  skyGarden(g, T, y0 + 4 * FL, y0 + 5 * FL - 4, { col: wall, glass: C.dtGlassDark, trim: C.dtNavyPanel });
  // r5: a teal glass spine stands 3 proud up the middle of the front and back
  // and rises past the roof (the ref05 hospital's glass stair core), so the
  // curtain wall is not one uniform grid
  for (const [za, zb] of [[T.z0 - 3, T.z0], [T.z1, T.z1 + 3]]) {
    const Sp = box(27, za, 35, zb);
    shell(g, Sp, y0 - 2, top + 5, wall, C.roofGray);
    ribbons(g, Sp, za < T.z0 ? 'flr' : 'blr', { y0, y1: top + 3, floor: FL, sill: 1, wh: 10, d: 1, cw: 1, pitch: 3,
      glassFn: skyGlass(v % 2 ? [C.dtGlass, C.dtGlass, C.dtGlassHi] : [C.dtGlassTeal, C.dtGlassTeal, C.dtGlassHi], nf + 1), hiRows: 1, mullC: wall });
    course(g, Sp, top + 5, C.dtNavyPanel, 1, 1, 0);
  }
  // crown: heavy cornice, set-back lantern + second cornice, helipad, mast
  const ct = cornice(g, T, top, wall, C.dtNavyPanel, 2, 0);
  deck(g, ins(T, -2), ct - 1);
  railing(g, T.x0 - 1, T.z0 - 1, T.x1 + 1, T.z1 + 1, ct, C.metal);
  const K = ins(T, 5), kt = ct + 13;
  shell(g, K, ct, kt, wall, C.roofGray);
  ribbons(g, K, 'fblr', { y0: ct, y1: kt - 1, floor: 13, sill: 1, wh: 10, d: 1, cw: 2, pitch: 3, glass: tones[3], hiRows: 0, mullC: wall });
  const kc = cornice(g, K, kt, wall, C.dtNavyPanel, 2, 0);
  roofCrowd(g, T.x0 + 1, T.z0 + 1, T.x1 - 1, K.z0 - 2, ct, rng, { ac: 3, vents: 1 });
  roofCrowd(g, T.x0 + 1, K.z1 + 2, T.x1 - 1, T.z1 - 1, ct, rng, { ac: 2, vents: 1 });
  coolTower(g, T.x0 + 1, ct, K.z0 + 2, 4, 5); coolTower(g, K.x1 + 1, ct, K.z0 + 8, 4, 5);
  deck(g, ins(K, -2), kc - 1);
  helipad(g, K.x0 + 1, K.z0 + 1, K.x1 - 1, K.z1 - 1, kc - 1);
  mast(g, K.x1, K.z1, kc, 16, C.red); dish(g, K.x0, kc, K.z1);
  // podium roof terrace
  // (r7: the podium now hugs the tower, so its roof strip is too thin for hedges)
  for (const x of [P.x0 + 1, P.x1 - 3]) acBox(g, x, pt + 1, P.z0 + 1, { w: 3, d: 2, h: 2 });
  // lot: plaza trees + benches, taxis at the kerb, parking lanes on 3 sides
  tree(g, 3, Y, 3, 7); tree(g, 57, Y, 3, 7);
  bench(g, 8, Y, 12, 'x', 5); bench(g, 50, Y, 12, 'x', 5);
  kerbCars(g, 10, 52, rng);                                              // r6: taxis + cars in a kerbside lay-by
  people(g, 2, 6, 60, 14, Y, 12, rng);
  stripLot(g, 1, 17, 10, 61, rng, { p: 0.9 }); stripLot(g, 52, 17, 61, 61, rng, { p: 0.9 }); stripLot(g, 12, 54, 50, 61, rng, { p: 0.95 });
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Black Tower — three tapering stages of dark glass ribbons set back behind
// dark floor slabs, with a champagne/gold ledge every three storeys; stage
// one's corners are notched into balcony slots with gold slabs; every setback
// carries a heavy cornice over a glowing ring. A tall glass lobby with a
// gold canopy, a neon lantern crown and spire; a dark granite plaza + pool.
function bDarkSkyscraper(rng, v) {
  const fin = pk(rng, [C.gold, C.dtFrame, C.gold]);   // r8: bright trim so every floor ledge reads
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62, { fill: C.lotPaveDark });
  const stages = [[box(11, 14, 51, 53), Y + 92], [box(16, 19, 46, 48), Y + 124 + v * 6], [box(21, 24, 41, 43), Y + 146 + v * 6]];
  // (r9) an art-deco street podium: cream (v1 limestone) with gold trim,
  // arched windows, black fascia with shop boards, a gold-framed portico
  const P = box(9, 12, 53, 55);
  let y0 = streetPodium(g, P, Y, { ground: 'arcade', wall: v % 2 ? C.dtLime : C.cream, pier: C.gold, fascia: C.black, skipF: [22, 40], seed: 2 + v, cornC: C.dtPad });
  for (let i = 0; i < stages.length; i++) {
    const [B, yt] = stages[i];
    shell(g, B, y0, yt, C.dtPad, C.roofGray);
    const ya = y0 + 2, n = Math.max(1, Math.floor((yt - 6 - ya) / FL));
    // dark piers standing proud of recessed glass bays, a champagne band every 3 storeys
    // (r8) critic r7: "the charcoal ONYX tower reads as a nearly black mass
    // … the dark side has no colour". Slate-blue piers (dtPad lightened) 1
    // proud, champagne ledge on every floor, bright glass framed in champagne.
    framedBays(g, B, 'fblr', { y0: ya, y1: yt - 6, bw: [7, 6, 5][i], pw: 2, cw: 3, pd: 1, cpd: 2, pierC: C.dtPad, spand: C.dtGlassDeep, frameC: fin, sillC: null, deep: false, inset: 0, jambs: false,
      sill: 2, wh: 8, glassFn: skyGlass([C.dtGlass, C.dtGlass, C.dtGlassHi], n, 11), sheen: C.dtGlassTeal, hi: C.winCool, bandEvery: 3, bandC: fin, bandOut: 2,
      ledgeC: fin, ledgeOut: 1,
      balc: i === 1 ? (S, k, r) => r % 2 === 0 : null, balcC: fin, railC: C.dtGlassHi });
    if (i === 0) for (const [x0, z0] of [[B.x0, B.z0], [B.x1 - 4, B.z0], [B.x0, B.z1 - 4], [B.x1 - 4, B.z1 - 4]])
      notch(g, B, box(x0, z0, x0 + 4, z0 + 4), ya - 1, yt - 6, { floor: FL, back: C.dtGlassDeep, slab: fin, rail: C.dtGlassHi });
    course(g, B, yt - 5, C.winCool, 0, 1, 0);
    cornice(g, B, yt - 4, fin, C.dtPad, 2, 0);
    // r8: railed setback terraces with plant (critic r7: "rooftops are sparse")
    if (i < 2) {
      railing(g, B.x0 - 1, B.z0 - 1, B.x1 + 1, B.z1 + 1, yt + 1, C.metal);
      if (i === 1) { const Bn = stages[2][0]; roofCrowd(g, B.x0 + 1, B.z0 + 1, B.x1 - 1, Bn.z0 - 2, yt + 1, rng, { ac: 2, vents: 1 }); roofCrowd(g, B.x0 + 1, Bn.z1 + 2, B.x1 - 1, B.z1 - 1, yt + 1, rng, { ac: 2, vents: 1 }); }
    }
    y0 = yt + 1;
  }
  // gold-framed portico on the podium
  const B0 = stages[0][0];
  portico(g, P.z0, { Y, xc: 31, w: 11, depth: 6, kind: 'marquee', cols: 4, colC: C.gold, frame: C.gold, fascia: C.dtPad, text: 'ONYX', textC: C.gold, mat: C.navy, planters: false });
  // crown: roof kit on the last setback, neon lantern + spire
  const top = y0, Bt = stages[2][0];
  const L = ins(Bt, 5);
  shell(g, L, top, top + 12, C.dtPad, C.roofGray);
  // r6: a gold-framed lantern of warm lit glass (critic r5: the magenta cube
  // "looks like a placeholder"): gold mullions every 2, a gold sill band
  for (const S of sides(g, L)) {
    S.f.clear(S.u0 + 1, top + 2, 0, S.u1 - 1, top + 10, 0); S.f.box(S.u0 + 1, top + 2, -1, S.u1 - 1, top + 10, -1, C.win);
    S.f.box(S.u0 + 1, top + 2, -1, S.u1 - 1, top + 5, -1, C.dtGlassDeep);
    for (let u = S.u0 + 2; u < S.u1 - 1; u += 2) S.f.box(u, top + 2, -1, u, top + 10, -1, fin);
    S.f.box(S.u0, top + 1, 1, S.u1, top + 1, 1, fin);
  }
  cornice(g, L, top + 12, fin, C.dtPad, 1, 0);
  roofCrowd(g, Bt.x0 + 1, Bt.z0 + 1, L.x0 - 2, Bt.z1 - 1, top, rng, { ac: 2, vents: 1 });
  roofCrowd(g, L.x1 + 2, Bt.z0 + 1, Bt.x1 - 1, Bt.z1 - 1, top, rng, { ac: 2, vents: 1 });
  for (let y = top + 16; y < top + 40; y++) g.set(31, y, 33, y > top + 32 ? C.metal : fin);
  g.set(31, top + 40, 33, C.red);
  const Bm = stages[1][0];
  roofCrowd(g, B0.x0 + 1, B0.z0 + 1, B0.x1 - 1, Bm.z0 - 2, stages[0][1] + 1, rng, { ac: 3, vents: 1 });
  roofCrowd(g, B0.x0 + 1, Bm.z1 + 2, B0.x1 - 1, B0.z1 - 1, stages[0][1] + 1, rng, { ac: 3, vents: 1 });
  // lot: dark granite plaza, two reflecting pools flanking the steps, flags
  for (const [a, b] of [[4, 18], [44, 58]]) { g.box(a + 1, 1, 3, b - 1, 1, 7, C.civPool); g.walls(a, 1, 2, b, 1, 8, C.darkGray); g.box(a + 3, 1, 5, a + 3, 3, 5, C.dtFrame); g.set(a + 3, 4, 5, C.civPoolLt); }
  flag(g, 2, Y, 10, 20, C.red); flag(g, 60, Y, 10, 20, C.blue);
  people(g, 2, 1, 60, 2, Y, 8, rng);
  stripLot(g, 1, 15, 7, 61, rng); stripLot(g, 55, 15, 61, 61, rng); stripLot(g, 12, 57, 50, 61, rng);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Corporate HQ — round 4, after the ref05 hospital: several interlocking
// volumes of different heights instead of one slab. A full-width granite
// LOBBY storey (square piers standing proud, deep dark glass between them,
// a white band over it); a low front wing whose roof is a garden terrace; a
// left wing four storeys high with cooling towers; the main tower behind
// with white piers standing proud of recessed blue-glass bays over navy
// spandrels, a white band every two storeys and wide corner piers; a glass
// stair/lift core standing out of the tower's front and rising past the
// roof. Crown: cornice, railing, plant room, cooling towers, water tank,
// masts + dishes, the BLOX sign in crisp 5x7 letters. Lot: a paved plaza
// with planters, trees, flags, bikes and people; a car park down the right.
function bCorporateHQ(rng, v) {
  // r6: WHITE + TEAL GLASS BANDS, after the ref05 hospital (critic r5: every
  // tower was a cream shaft with the same small window grid). The main tower
  // is banded: a continuous teal (v1: blue) glass ribbon every storey, set
  // back behind a white floor slab that stands proud, between deep white
  // corner piers — horizontal rhythm, not a grid. The wings keep punched
  // windows (white piers over teal-framed glass); a deep-blue glass lift core
  // runs up the tower front past the roof. Crown: an all-glass top storey,
  // cornice, rail, plant room, cooling towers, tank, masts, the BLOX sign.
  const pier = C.dtFrame, slab = C.dtFrame, spand = C.dtStone;
  const band = [[C.dtGlassTeal, C.dtGlassTeal, C.dtGlassHi], [C.dtGlass, C.dtGlass, C.dtGlassHi]][v % 2];
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62);
  const nf = 8 + v;
  const L = box(6, 14, 47, 57), Wf = box(6, 14, 47, 28), Wl = box(6, 28, 19, 57), T = box(19, 28, 47, 57);
  // (r9) the front wing IS the street podium now: terracotta with a glass
  // ribbon (v1: sandstone arcade), shop signs + awnings, a columned portico
  const [pw0, pp0, pf0] = [POD.terra, POD.sand][v % 2]();
  const eb = bayStarts(L.x0, L.x1, 9, 2, 3)[1];
  const fTop = streetPodium(g, L, Y, { ground: 'glass', wall: pw0, pier: pp0, fascia: pf0, glass: band[0], skipF: [eb - 6, eb + 14], seed: 3 + v }) - 1;
  const s0 = fTop - FL, wTop = s0 + FL * 4, tTop = s0 + FL * nf;
  g.box(Wf.x0 + 1, fTop, Wf.z0 + 1, Wf.x1 - 1, fTop, Wf.z1 - 1, C.lotGrass);
  shell(g, Wl, fTop, wTop, slab, C.roofGray);
  shell(g, T, fTop, tTop, slab, C.roofGray);
  // wings: punched windows between white piers, teal glass
  const wing = { bw: 7, pw: 2, cw: 3, pd: 1, sillOut: 1, cpd: 2, pierC: pier, spand, frameC: C.dtFrame, sillC: pier, sill: 2, wh: 8,
    glassFn: skyGlass(band, 4, 7), sheen: band[2], hi: C.winCool, ac: (S, k, r) => ((k * 5 + r * 3) % 7) === 3 };
  framedBays(g, Wl, 'lbf', { ...wing, y0: fTop + 2, y1: wTop - 1, bandEvery: 3 });
  // main tower: banded glass ribbons behind proud white floor slabs, deep
  // white corner piers; the top storey is all glass (the crown tier)
  const gl = skyGlass(band, nf, 8);
  ribbons(g, T, 'fblr', { y0: fTop + 2, y1: tTop - FL, floor: FL, sill: 3, wh: 8, d: 1, cw: 3, pitch: 5, glassFn: gl, hi: C.winCool, hiRows: 1, mullC: slab });
  // (r7) slabs stand 2 proud: each casts a real shadow line over the ribbon below
  for (let y = fTop + 2 + FL; y < tTop - FL; y += FL) course(g, T, y, slab, 2, 1, 0);
  for (const S of sides(g, T)) {
    S.f.box(S.u0 - 2, fTop + 2, 1, S.u0 + 2, tTop, 2, pier);
    S.f.box(S.u1 - 2, fTop + 2, 1, S.u1 + 2, tTop, 2, pier);
  }
  ribbons(g, T, 'fblr', { y0: tTop - FL, y1: tTop - 1, floor: FL, sill: 1, wh: 10, d: 1, cw: 3, pitch: 3, glass: C.dtGlassHi, hiRows: 0, mullC: slab });
  // wing top: cornice + crowded roof with cooling towers
  course(g, Wl, wTop, pier, 1, 2, 0);
  parapetOn(g, Wl, wTop + 2, 1, slab, null);
  mechCrown(g, Wl.x0 + 1, Wl.z0 + 1, Wl.x1 - 1, Wl.z1 - 1, wTop + 1, rng, { rail: false, plant: false, cool: 2, ac: 2, vents: 2 });
  // r7: a sky garden five storeys up splits the banded shaft
  { const ys = fTop + 3 + 5 * FL; skyGarden(g, T, ys, ys + FL - 4, { col: pier, glass: C.dtGlassDark, trim: C.dtNavyPanel }); }
  // deep-blue glass lift core on the tower front, rising past the roof
  const G = box(22, 24, 30, 28), gt = tTop + 6;      // r6: ends under the BLOX sign (it hid the L)
  shell(g, G, fTop + 1, gt, pier, C.roofGray);
  for (const S of sides(g, G, 'flr')) {
    S.f.box(S.u0 + 1, fTop + 3, 0, S.u1 - 1, gt - 3, 0, C.dtGlassDeep);
    for (let y = fTop + 3; y < gt - 3; y += 6) S.f.box(S.u0 + 1, y, 0, S.u1 - 1, y, 0, C.dtGlassHi);
    S.f.box(S.u0 + 1, gt - 5, 0, S.u1 - 1, gt - 4, 0, C.winCool);
  }
  course(g, G, gt, pier, 1, 1, 0);
  // tower crown: cornice, parapet, plant, cooling towers, tank, masts
  const ct = roofCornice(g, T, tTop + 1, pier, C.dtNavyPanel, 2, 0);
  parapetOn(g, T, ct, 1, slab, null); deck(g, T, ct);
  railing(g, T.x0 + 1, T.z0 + 1, T.x1 - 1, T.z1 - 1, ct + 1, C.metal);
  mechCrown(g, T.x0 + 1, T.z0 + 8, T.x1 - 1, T.z1 - 1, ct + 1, rng, { rail: false, wall: C.dtStone, trim: C.dtNavyPanel, plant: [T.x0 + 3, T.z1 - 13, T.x0 + 14, T.z1 - 3, 9], cool: 2, tank: C.wood, ac: 3, vents: 2, masts: 1, dishes: 1 });
  signBox(g, 33, ct + 1, T.z0 + 2, 'BLOX', C.navy, C.signWhite, C.dtGlassHi);
  // front wing terrace: garden
  tree(g, 9, fTop + 1, 17, 6); tree(g, 42, fTop + 1, 17, 6);
  planter(g, 14, 17, 26, 20, fTop + 1, { box: pier, flowers: [C.pink, C.yellow, C.signWhite] });
  planter(g, 40, 22, 45, 26, fTop + 1, { box: pier });
  bench(g, 14, fTop + 1, 23, 'x', 6); bench(g, 29, fTop + 1, 18, 'x', 6);
  umbrella(g, 36, fTop + 1, 21, C.teal, C.signWhite);
  people(g, 8, 16, 45, 26, fTop + 1, 5, rng);
  // entrance: glass lobby, stepped terrace, glass canopy with BLOX, planters
  tiles(g, 1, 1, 47, 13, Y - 1, C.lotPaveDark, 5);
  portico(g, L.z0, { Y, xc: eb + 4, w: 9, depth: 7, kind: 'slab', cols: 4, colC: C.dtFrame, fascia: C.dtNavyPanel, sign: 'letters', text: 'BLOX', textC: C.signWhite, planters: false, lamps: false });
  // lot: flags, bike rack, taxi lay-by; car park down the right, lane on the left
  flag(g, 41, Y, 3, 22, C.blue); flag(g, 44, Y, 3, 22, C.teal); flag(g, 38, Y, 3, 22, C.red);
  bikeRack(g, 6, Y, 10, 3);
  lamp(g, 11, Y, 11); lamp(g, 43, Y, 11);
  kerbCars(g, 1, 35, rng);
  people(g, 2, 6, 46, 12, Y, 10, rng);
  g.box(49, 1, 2, 61, 1, 61, C.lotAsphalt);
  parkCol(g, 4, 60, 50, 11, rng, 0.9);
  stripLot(g, 1, 15, 5, 61, rng, { p: 0.95 }); hedge(g, 7, Y, 59, 46, 60, 3);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Twin Towers — round 4: art-deco twins on a shared podium. Each tower is
// carved into cream piers standing proud of recessed navy-and-glass bays,
// with wide corner piers and a band every three storeys; each setback is a
// terrace with a railing and condensers under a heavy cornice over a gold
// band; the top stage carries a plant room, a water tank and a gold spire.
// The podium is a colonnade (proud stone piers over deep lobby glass, a
// gold-framed portal) with a roof garden; a glass skybridge links the twins.
function bTwinSetback(rng, v) {
  // r6: a BRICK pair (critic r5: "TECH, BLOX, TWINS and SPIRE are all cream
  // shafts with the same small blue window grid"). Red-brown brick shafts
  // with cream quoin piers, a cream-stone podium, a cream upper tier with
  // balconies, and a gold-trimmed crown with tall windows — three tiers with
  // three rhythms, like ref05's brick hotel.
  const brick = [C.brickDark, C.dtTerra][v % 2];
  const stone = pk(rng, [C.cream, C.dtLime]);
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62);
  // (r9) a cream-stone street podium with an arcade of arched windows, a
  // black shop fascia, and a temple portico (4 columns, TWINS on the
  // entablature, a copper pediment) — the ref05 bank's front
  const P = box(7, 14, 55, 53);
  const pt = streetPodium(g, P, Y, { h: 34, ground: 'arcade', wall: stone, pier: C.gold, fascia: C.black, skipF: [18, 44], seed: 1 + v, cornC: stone }) - 1;
  tiles(g, 1, 1, 61, 13, Y - 1, C.lotPaveDark, 5);
  portico(g, P.z0, { Y, xc: 31, w: 19, depth: 7, kind: 'temple', cols: 4, colC: stone, stone: C.dtLimeShade, roofC: C.dtCopper, text: 'TWINS', textC: C.brickDark, planters: false });
  const top = pt + 96 + v * 8;
  for (const [x0, x1] of [[7, 28], [34, 55]]) {
    const T1 = box(x0, 16, x1, 50), T2 = ins(T1, 3), T3 = ins(T2, 3);
    const y1 = top - 40, y2 = top - 16;
    // tier 1: brick, cream quoin piers, brick pilasters 1 proud of brick bays
    // (2-deep reveals), cream band every 3 storeys, a deep loggia stack down
    // the middle of each long side (shadowed balcony void)
    shell(g, T1, pt + 1, y1, brick, C.roofGray);
    // (r7) the windows fill the bay (5 wide × 7 tall, 2 back behind a white
    // head): the r6 shaft read as flat red pilasters with thin dark slits
    framedBays(g, T1, 'fblr', { y0: pt + 2, y1: y1 - 5, bw: 5, pw: 1, cw: 2, pd: 1, cpd: 2, pierC: brick, cornerC: brick, spand: brick, inset: 0, jambs: false, deep: false,
      frameC: C.dtFrame, sillC: stone, sillOut: -1, glassFn: skyGlass(SKY, 10, 6), sheen: C.dtGlassHi, hi: C.win, floor: 10, sill: 1, wh: 7,
      bandEvery: 3, bandC: stone, bandOut: 2, ledgeC: stone, ledgeOut: 1, ac: (S, k, r) => ((k * 3 + r * 5) % 7) === 1 });
    for (const xa of [T1.x0, T1.x1 - 3]) notch(g, T1, box(xa, 30, xa + 3, 36), pt + 2, y1 - 5, { floor: 10, back: C.dtGlassDeep, slab: stone, rail: C.dtGlassHi, mull: stone });
    course(g, T1, y1 - 4, C.gold, 1, 1, 0);
    cornice(g, T1, y1 - 3, stone, brick, 2, 0);
    // tier 2: cream stone, brick spandrels, a checker of gold-railed balconies
    shell(g, T2, y1 + 1, y2, stone, C.roofGray);
    framedBays(g, T2, 'fblr', { y0: y1 + 2, y1: y2 - 5, bw: 5, pw: 2, cw: 2, pd: 0, cpd: 2, pierC: stone, spand: brick, inset: 0, deep: false, frameC: C.dtFrame, sillC: stone, sillOut: -1,
      glassFn: skyGlass(SKY, 10), sheen: C.dtGlassHi, hi: C.win, floor: 10, sill: 2, wh: 6,
      balc: (S, k, r) => (k + r) % 2 === 0, balcC: stone, railC: C.gold });
    course(g, T2, y2 - 4, C.gold, 1, 1, 0);
    cornice(g, T2, y2 - 3, stone, brick, 2, 0);
    // tier 3 (crown): cream with tall gold-framed windows, two storeys high
    shell(g, T3, y2 + 1, top, stone, C.roofGray);
    framedBays(g, T3, 'fblr', { y0: y2 + 2, y1: top - 3, bw: 3, pw: 2, cw: 2, pd: 0, cpd: 1, pierC: stone, spand: C.gold, inset: 0, frameC: C.gold, sillC: C.gold, sillOut: -1,
      glass: C.dtGlassHi, hi: C.win, hiRows: 2, floor: 14, sill: 1, wh: 11, noMull: true });
    for (const [B, yb, Bn] of [[T1, y1, T2], [T2, y2, T3]]) {
      railing(g, B.x0 - 1, B.z0 - 1, B.x1 + 1, B.z1 + 1, yb + 1, C.metal);
      for (const [ax, az] of [[B.x0 + 1, B.z0 + 1], [B.x1 - 5, B.z1 - 4], [B.x0 + 1, B.z1 - 4]]) acBox(g, ax, yb + 1, az, { w: 4, d: 3, h: 3 });
      ventPipe(g, B.x1 - 1, B.z0 + 1, yb + 1, yb + 4);
      void Bn;
    }
    // top: gold cornice, parapet rail, plant room, water tank, gold spire
    const tc = roofCornice(g, T3, top - 2, C.gold, stone, 1, 0);
    railing(g, T3.x0, T3.z0, T3.x1, T3.z1, tc, C.gold);
    const cx = (x0 + x1) >> 1;
    penthouse(g, T3.x0 + 2, tc, T3.z0 + 3, T3.x1 - 2, T3.z0 + 10, 8, stone, C.roofGray, C.gold);
    for (let k = 0; k < 3; k++) g.walls(T3.x0 + 3 + k, tc + 9 + k * 2, T3.z0 + 4 + k, T3.x1 - 3 - k, tc + 10 + k * 2, T3.z0 + 9 - k, k % 2 ? stone : C.gold);
    for (let y = tc + 15; y < tc + 31; y++) g.set(cx, y, T3.z0 + 6, y > tc + 26 ? C.metal : C.gold);
    g.set(cx, tc + 31, T3.z0 + 6, C.lamp);
    waterTank(g, cx, tc, T3.z1 - 5, 3, 6, C.wood, C.darkGray);
    acBox(g, T3.x0 + 1, tc, T3.z0 + 12, { w: 4, d: 3, h: 3 });
  }
  // skybridge
  const sy = pt + 44;
  g.box(28, sy, 29, 34, sy + 9, 37, C.dtGlass);
  g.box(27, sy, 28, 35, sy, 38, stone); g.box(27, sy + 9, 28, 35, sy + 9, 38, stone);
  g.box(28, sy + 7, 29, 34, sy + 8, 37, C.win);
  // podium roof garden
  tree(g, 30, pt + 1, 17, 5); tree(g, 30, pt + 1, 49, 5);
  hedge(g, 29, pt + 1, 22, 33, 28, 2); hedge(g, 29, pt + 1, 40, 33, 45, 2);
  people(g, 29, pt + 1, 15, 34, 52, 3, rng);
  // lot: corner planters with trees, taxis at the kerb, parking lanes all round
  for (const x of [2, 51]) { planter(g, x, 2, x + 8, 5, Y, { box: C.stoneDark, flowers: [C.red, C.yellow] }); tree(g, x + 3, Y + 2, 3, 5); }
  kerbCars(g, 12, 50, rng);
  people(g, 1, 1, 61, 13, Y, 10, rng);
  stripLot(g, 1, 15, 6, 61, rng, { p: 0.95 }); stripLot(g, 56, 15, 61, 61, rng, { p: 0.95 }); stripLot(g, 8, 54, 54, 61, rng, { p: 0.95 });
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Spire Tower — round 4: three tapering stages carved into white piers
// standing proud of recessed blue-glass bays (navy spandrels, 3 panes per
// bay), a band every three storeys, wide corner piers; stage one's corners
// notched into balcony stacks; each setback a sky-lobby of pale glass under
// a heavy cornice and a railed terrace of condensers; a granite lobby with
// columns and a canopy; a glass lantern crown and a striped antenna.
function bSpireTower(rng, v) {
  // r6: SILVER STONE + DARK-BLUE GLASS (critic r5: every tower was a cream
  // shaft; ref05's bank is "pale stone with dark-blue glass between deep
  // columns"). Tier 1: deep stone columns standing 2 proud of dark-blue glass
  // bays with navy spandrels (a 3-deep shadowed reveal on every face). Tier 2:
  // banded floors — stone spandrel bands, lighter glass, balcony stacks.
  // Tier 3: a pale glass cage. Sky-lobby glass band + heavy cornice at each
  // setback, a lantern and a striped antenna.
  const glassT = [[C.dtGlassDark, C.dtGlassDeep, C.dtGlassDeep, C.dtGlass], [C.dtGlassDark, C.dtGlassTeal, C.dtGlassTeal, C.dtGlassHi]][v % 2];
  const stone = [C.dtLimeShade, C.resTerracotta][v % 2], spandC = C.dtGlassDeep;   // w10: warm beige stone (v1 terracotta; was silver: a third pale shaft)   // r8: was navy (critic r7: dark masses)
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62);
  // the podium steps in from the lot edge so the ground floor can be dressed
  // all round (entrance plaza in front, parking lanes on 3 sides)
  const P = box(11, 14, 51, 53);          // r7: 10-wide car parks each side
  // (r9) brick (v1 sandstone) street podium with an arcade + shop fascia and
  // a temple portico carrying SPIRE (critic r8: no real podium or entrance)
  const [pw0, pp0, pf0] = [POD.brick, POD.sand][v % 2]();
  const st = [[box(12, 16, 50, 50), Y + 100], [box(17, 21, 45, 45), Y + 138 + v * 4], [box(21, 25, 41, 41), Y + 166 + v * 4]];
  let y0 = streetPodium(g, P, Y, { ground: 'colonnade', wall: pw0, colC: v % 2 ? C.dtFrame : C.cream, pier: pp0, fascia: pf0, skipF: [16, 46], seed: 2 + v }) + 1, row0 = 0;
  const nAll = Math.floor((Y + 166 - y0) / FL);
  for (let i = 0; i < st.length; i++) {
    const [B, yt] = st[i];
    shell(g, B, y0, yt, stone, C.roofGray);
    const n = Math.floor((yt - 8 - y0) / FL), r0 = row0;
    const common = { y0, y1: yt - 9, sillOut: -1, pierC: stone, hi: C.winCool, bandC: stone };
    if (i === 0) framedBays(g, B, 'fblr', { ...common, bw: 8, pw: 1, cw: 2, pd: 2, cpd: 2, sill: 2, wh: 9, spand: spandC, inset: 0, frameC: C.dtGlassDark, mullC: stone, sillC: spandC,
      glassFn: (c, r) => skyGlass(glassT, nAll, 7)(c, r + r0), sheen: glassT[3], bandEvery: 4, bandOut: 3, bandH: 2, ledgeC: C.dtFrame, ledgeOut: 2 });
    else if (i === 1) framedBays(g, B, 'fblr', { ...common, bw: 6, pw: 1, cw: 2, pd: 1, cpd: 2, sill: 2, wh: 8, spand: stone, inset: 0, frameC: C.dtFrame, sillC: null, deep: false, ledgeC: C.dtFrame, ledgeOut: 1,
      glassFn: (c, r) => skyGlass([C.dtGlass, C.dtGlass, C.dtGlassHi], nAll, 9)(c, r + r0), sheen: C.dtGlassHi,
      balc: (S, k) => k > 0 && k < 3, balcC: C.dtFrame, railC: C.dtGlassHi, balcD: 3 });
    else framedBays(g, B, 'fblr', { ...common, bw: 4, pw: 1, cw: 2, pd: 0, cpd: 2, inset: 0, spand: C.dtGlassDeep, frameC: C.dtFrame, sillC: C.dtFrame, glass: C.dtGlassHi, sheen: C.skyBlue, bandEvery: 2, bandOut: 1 });
    // sky-lobby glass band under each setback's cornice
    for (const S of sides(g, B)) { S.f.clear(S.u0 + 3, yt - 7, 0, S.u1 - 3, yt - 3, 0); S.f.box(S.u0 + 3, yt - 7, -1, S.u1 - 3, yt - 3, -1, C.dtGlassHi); for (let u = S.u0 + 5; u < S.u1 - 3; u += 4) S.f.box(u, yt - 7, -1, u, yt - 3, -1, C.dtFrame); }
    cornice(g, B, yt - 2, C.dtFrame, spandC, 2, 0);
    if (i < 2) {
      const Bn = st[i + 1][0];
      railing(g, B.x0 - 1, B.z0 - 1, B.x1 + 1, B.z1 + 1, yt + 1, C.metal);
      roofCrowd(g, B.x0 + 1, B.z0 + 1, B.x1 - 1, Bn.z0 - 2, yt + 1, rng, { ac: 2, vents: 1 });
      roofCrowd(g, B.x0 + 1, Bn.z1 + 2, B.x1 - 1, B.z1 - 1, yt + 1, rng, { ac: 2, vents: 1 });
    }
    row0 += n; y0 = yt + 1;
  }
  const top = y0, Bt = st[2][0];
  railing(g, Bt.x0 - 1, Bt.z0 - 1, Bt.x1 + 1, Bt.z1 + 1, top, C.metal);
  const L = ins(Bt, 3);
  shell(g, L, top, top + 12, C.dtFrame, C.roofGray);
  ribbons(g, L, 'fblr', { y0: top + 1, y1: top + 10, floor: 10, sill: 0, wh: 10, d: 1, cw: 1, pitch: 3, glass: C.winCool, hiRows: 0 });
  const L2 = ins(L, 3);
  for (let k = 0; k < 5; k++) g.box(L2.x0 + k, top + 13 + k, L2.z0 + k, L2.x1 - k, top + 13 + k, L2.z1 - k, C.dtFrame);
  for (let y = top + 18; y < 255; y++) g.set(31, y, 33, y % 8 < 4 ? C.red : C.dtFrame);
  g.set(31, 255, 33, C.neon);
  acBox(g, Bt.x0 + 1, top, Bt.z0 + 1, { w: 4, d: 2, h: 3 }); acBox(g, Bt.x1 - 4, top, Bt.z1 - 2, { w: 4, d: 2, h: 3 });
  // entrance: glass lobby, stepped terrace, glass canopy with SPIRE, planters
  tiles(g, 1, 1, 61, 13, Y - 1, C.lotPaveDark, 5);
  portico(g, P.z0, { Y, xc: 31, w: 19, depth: 7, kind: 'temple', cols: 4, colC: C.dtFrame, stone: C.dtLimeShade, roofC: C.dtGlassDeep, text: 'SPIRE', textC: C.dtNavyPanel, planters: false });
  // lot: plaza trees + benches, taxis in a kerbside lay-by, parking on 3 sides
  for (const [x, z] of [[3, 3], [58, 3]]) tree(g, x, Y, z, 6);
  bench(g, 7, Y, 10, 'x', 5); bench(g, 51, Y, 10, 'x', 5);
  kerbCars(g, 10, 52, rng);
  people(g, 2, 1, 60, 12, Y, 10, rng);
  stripLot(g, 1, 15, 10, 61, rng, { p: 0.9 }); stripLot(g, 52, 15, 61, 61, rng, { p: 0.9 }); stripLot(g, 12, 54, 50, 61, rng, { p: 0.95 });
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// Tech Campus — round 4: two interlocking volumes. A two-storey lower block
// (lobby of deep glass between square piers, then recessed teal-glass bays
// between white piers) and a three-storey upper block shifted forward that
// CANTILEVERS over the entrance plaza on two columns, its bays over orange
// spandrels. Roofs: a green terrace with trees and benches on the lower
// block; solar arrays, a plant room, condensers, a dish and the TECH sign
// (crisp 5x7 letters) on the upper one. Car park along the front.
function bTechCampus(rng, v) {
  // r6: TERRACOTTA + DARK GLASS (critic r5: TECH was one more cream shaft). The
  // lower block is terracotta-clad (terracotta pilasters 1 proud of terracotta
  // bays, white-framed windows); the cantilevered upper block is a dark-glass
  // box banded by white sunshade fins on every storey; the name is lit in the
  // accent colour on a black sign.
  const terra = [C.dtTerra, C.comTerra][v % 2];
  const tones = pk(rng, [[C.dtGlassTeal, C.dtGlass, C.dtGlassHi], [C.dtGlass, C.dtGlass, C.dtGlassHi], [C.dtGlassGreen, C.dtGlassTeal, C.dtGlassHi]]);
  const logo = pk(rng, [C.orange, C.teal, C.yellow]);
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62, { fill: 'grass' });
  g.box(2, 1, 2, 60, 1, 12, C.lotAsphalt);
  parkRow(g, 3, 59, 3, 10, rng, 0.75);
  // (r9) the lower block is a terracotta street podium: shopfronts under a
  // black fascia with signs + awnings, a glass ribbon (v1: arcade) above
  const Lb = box(5, 22, 57, 58), Ub = box(12, 14, 50, 50);
  const lt = streetPodium(g, Lb, Y, { ground: 'glass', wall: terra, pier: C.dtFrame, fascia: C.black, glass: tones[0], skipF: [22, 40], seed: 4 + v, roof: C.lotGrass }) - 1;
  const ut = lt + 2 + FL * (3 + v);
  // upper block, cantilevered forward over the plaza
  shell(g, Ub, lt + 1, ut, C.dtGlassDark, C.roofGray);
  g.box(Ub.x0, lt + 1, Ub.z0, Ub.x1, lt + 1, Lb.z0, C.dtFrame);
  ribbons(g, Ub, 'fblr', { y0: lt + 2, y1: ut - 1, floor: FL, sill: 2, wh: 9, d: 1, cw: 2, pitch: 5, spandrel: C.dtGlassDark,
    glassFn: skyGlass([C.dtGlassDeep, C.dtGlass, C.dtGlass, C.dtGlassHi], 3, 5), hi: C.winCool, hiRows: 1, mullC: C.metal });
  for (let y = lt + 2 + FL; y < ut - 2; y += FL) ledge(g, Ub, y, C.dtFrame, 2, 1);
  for (const S of sides(g, Ub)) { S.f.box(S.u0 - 1, lt + 2, 1, S.u0 + 1, ut, 1, C.metal); S.f.box(S.u1 - 1, lt + 2, 1, S.u1 + 1, ut, 1, C.metal); }
  course(g, Ub, lt + 1, C.dtNavyPanel, 1, 1, 0);
  for (const x of [Ub.x0 + 2, Ub.x1 - 3]) { g.box(x, Y, Ub.z0 + 2, x + 1, lt, Ub.z0 + 3, C.dtFrame); g.box(x - 1, Y, Ub.z0 + 1, x + 2, Y, Ub.z0 + 4, C.stoneDark); }
  dentils(g, Ub, ut, C.dtFrame);
  const ct = cornice(g, Ub, ut + 1, C.dtFrame, C.dtNavyPanel, 1, 0) - 1;
  deck(g, Ub, ct - 1);
  for (let x = Ub.x0 + 3; x + 5 <= Ub.x0 + 22; x += 7) solarPanel(g, x, Ub.z0 + 16, x + 5, Ub.z1 - 3, ct);
  mechCrown(g, Ub.x0, Ub.z0, Ub.x1, Ub.z1, ct, rng, { rail: C.metal, wall: C.dtStone, trim: C.dtNavyPanel, plant: [Ub.x1 - 12, Ub.z1 - 12, Ub.x1 - 3, Ub.z1 - 3, 7], ac: 3, vents: 2, dishes: 1 });
  signBox(g, 31, ct, Ub.z0 + 2, 'TECH', C.black, logo, logo);
  // lower-roof garden around the upper block
  tree(g, 8, lt + 1, 53, 6); tree(g, 52, lt + 1, 54, 6); tree(g, 53, lt + 1, 30, 6);
  bench(g, 7, lt + 1, 40, 'z', 6); bench(g, 54, lt + 1, 42, 'z', 6);
  people(g, 6, 51, 56, 57, lt + 1, 4, rng);
  // entrance under the cantilever
  tiles(g, 5, 13, 57, 21, Y - 1, C.lotPaveDark, 4);
  portico(g, Lb.z0, { Y, xc: 31, w: 9, depth: 5, kind: 'glass', colC: C.dtFrame, glassTop: C.dtGlassTeal, fascia: logo, sign: 'letters', text: 'TECH', textC: logo, planters: false, lamps: false, mat: logo });
  for (const x of [6, 50]) planter(g, x, 15, x + 6, 19, Y, { box: C.dtStone, flowers: [logo, C.signWhite] });
  people(g, 5, 13, 57, 21, Y, 8, rng);
  for (const z of [26, 38, 50]) { tree(g, 0, Y, z - 2, 4); tree(g, 58, Y, z - 2, 4); }
  lamp(g, 4, Y, 13); lamp(g, 58, Y, 13);
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// City Bank — the ref05 bank, rebuilt for round 3 (critic r2: "a cream box
// with painted fluting; needs freestanding columns set in front of a
// recessed dark-glass wall"). A rusticated plinth with small basement
// windows; a peristyle of FREESTANDING octagonal columns (base + capital)
// two voxels clear of a recessed hall of tall dark-glass windows, square
// antae at the corners; a heavy entablature (architrave, frieze with BANK in
// 2x letters on the front, dentils, a cornice 3 out); an attic storey with
// square windows; a pediment with a gold clock over the entrance; a teal roof
// crowded with condensers and a skylight; a full-width stair with cheek
// walls; a plaza with planters, lamps and flags.
function bCityBank(rng, v) {
  const [stone, shade, roofC] = [[C.dtStone, C.stone, C.dtCopper], [C.dtLime, C.dtLimeShade, C.dtCopper]][v % 2];
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62);
  // plinth: rusticated, basement windows on the sides + back
  const P = box(5, 13, 57, 59);
  const y0 = Y + 9;
  shell(g, P, Y, y0 - 1, stone, stone);
  for (let y = Y + 2; y < y0 - 1; y += 3) g.walls(P.x0, y, P.z0, P.x1, y, P.z1, shade);
  punch(g, P, 'blr', { y0: Y + 1, y1: y0 - 2, floor: 20, sill: 1, wh: 4, w: 3, pitch: 7, margin: 5, glass: C.dtGlassDark, hiRows: 1, frameC: shade });
  g.walls(P.x0, y0 - 1, P.z0, P.x1, y0 - 1, P.z1, shade);
  // hall: recessed wall of tall dark-glass windows
  const Cl = box(10, 18, 52, 54), H = ins(Cl, 5);
  const ec = y0 + 29;                                    // column tops
  shell(g, H, y0, ec + 2, C.dtNavyPanel, C.roofGray);
  const cols = (a, b) => { const n = Math.max(2, Math.round((b - a) / 11) + 1), r = []; for (let i = 0; i < n; i++) r.push(Math.round(a + i * (b - a) / (n - 1))); return r; };
  const cx = cols(Cl.x0, Cl.x1), cz = cols(Cl.z0, Cl.z1);
  punch(g, H, 'fblr', { y0, y1: ec, floor: 60, sill: 3, wh: 24, w: 5, glassFn: () => C.dtGlassDark,
    us: (S) => { const c = (S.s === 'f' || S.s === 'b') ? cx : cz; const r = []; for (let i = 0; i + 1 < c.length; i++) r.push(((c[i] + c[i + 1]) >> 1) - 2); return r; },
    hi: C.dtGlassTeal, hiRows: 9, mull: 'cross', mullC: C.dtNavyPanel, frameC: C.dtNavyPanel,
    skip: (S, u) => S.s === 'f' && Math.abs(u + 2 - 31) < 4 });
  // columns: octagonal shafts 5 across on a base, capital 7 across
  const column = (x, z, corner) => {
    g.box(x - 3, y0, z - 3, x + 3, y0 + 1, z + 3, shade);                       // base
    if (corner) g.box(x - 2, y0 + 2, z - 2, x + 2, ec - 3, z + 2, stone);
    else { g.box(x - 2, y0 + 2, z - 1, x + 2, ec - 3, z + 1, stone); g.box(x - 1, y0 + 2, z - 2, x + 1, ec - 3, z + 2, stone); }
    g.box(x - 2, ec - 2, z - 2, x + 2, ec - 2, z + 2, shade);                   // echinus
    g.box(x - 3, ec - 1, z - 3, x + 3, ec, z + 3, stone);                       // abacus
  };
  for (const x of cx) for (const z of [Cl.z0, Cl.z1]) column(x, z, x === Cl.x0 || x === Cl.x1);
  for (const z of cz.slice(1, -1)) for (const x of [Cl.x0, Cl.x1]) column(x, z, false);
  // entablature: architrave, frieze (BANK), dentils, cornice
  const E = ins(Cl, -3);
  g.box(E.x0, ec + 1, E.z0, E.x1, ec + 3, E.z1, stone);
  g.walls(E.x0, ec + 3, E.z0, E.x1, ec + 3, E.z1, shade);
  const fr = ec + 4;
  shell(g, E, fr, fr + 11, stone, C.roofGray);
  course(g, E, fr, shade, 0, 1, 0);
  dentils(g, E, fr + 11, shade);
  const ct = roofCornice(g, E, fr + 12, stone, shade, 3, 0);
  const Ff = facade(g, 'front', E.z0);
  text5(Ff, 31, fr + 2, 'BANK', C.dtNavyPanel, 1, 1);
  text5(facade(g, 'back', E.z1), 31, fr + 2, 'BANK', C.dtNavyPanel, 1, 1);
  for (const u of [E.x0 + 5, E.x1 - 5]) { Ff.box(u - 2, fr + 3, 1, u + 2, fr + 9, 1, C.gold); Ff.box(u - 1, fr + 4, 1, u + 1, fr + 8, 2, shade); }
  // attic storey with square windows + parapet, teal roof
  const A = ins(E, 4), at = ct + 8;
  shell(g, A, ct, at, stone, roofC);
  punch(g, A, 'fblr', { y0: ct + 1, y1: at - 1, floor: 20, sill: 1, wh: 4, w: 3, pitch: 7, margin: 4, glass: C.dtGlassDeep, hiRows: 1, frameC: shade, sillC: shade });
  course(g, A, at, shade, 1, 1, 0);
  parapetOn(g, A, at + 1, 2, stone, shade);
  g.box(A.x0 + 1, at, A.z0 + 1, A.x1 - 1, at, A.z1 - 1, roofC);
  // pediment (45°, 5 deep) over the middle of the front, gold clock
  const gy = ct, qx0 = 12, qx1 = 50, pz = E.z0 - 3;
  for (let k = 0; ; k++) {
    const xa = qx0 + k, xb = qx1 - k;
    if (xb - xa < 1) break;
    g.box(xa, gy + k, pz + 1, xb, gy + k, pz + 16, stone);                 // gable roof runs back
    g.box(xa, gy + k, pz + 1, xa + 1, gy + k, pz + 16, roofC); g.box(xb - 1, gy + k, pz + 1, xb, gy + k, pz + 16, roofC);
    g.set(xa, gy + k, pz, shade); g.set(xb, gy + k, pz, shade);
  }
  g.box(qx0 - 1, gy - 1, pz - 1, qx1 + 1, gy - 1, pz + 6, shade);
  clockFace(facade(g, 'front', pz + 1), 31, gy + 8, 5);
  // the doors between the middle columns
  const Fh = facade(g, 'front', H.z0);
  door(Fh, 27, y0, 9, 20, { color: C.dtGlassDark, glass: C.winCool, frame: C.gold, double: true, step: null });
  Fh.box(26, y0 + 21, 1, 36, y0 + 22, 2, C.gold);
  // stair: full width, lot -> plinth top, cheek walls with lamps
  for (let k = 0; k < y0 - Y; k++) g.box(18, Y + k, 2 + k, 44, Y + k, P.z0 + 1, shade);
  for (const x of [16, 17, 45, 46]) g.box(x, Y, 2, x, y0, P.z0, stone);
  for (const x of [16, 46]) { g.box(x, y0 + 1, 3, x, y0 + 3, 3, C.darkGray); g.set(x, y0 + 4, 3, C.lamp); }
  // roof: condensers + skylight
  g.box(24, at + 1, A.z0 + 6, 38, at + 2, A.z0 + 14, C.dtFrame); g.box(25, at + 3, A.z0 + 7, 37, at + 3, A.z0 + 13, C.dtGlassHi);
  roofCrowd(g, A.x0 + 3, A.z0 + 17, A.x1 - 3, A.z1 - 3, at + 1, rng, { ac: 5, vents: 3 });
  // lot: plaza planters, trees, lamps, flags
  for (const x of [5, 57]) tree(g, x - 1, Y, 4, 6);
  planter(g, 3, 9, 13, 11, Y, { box: shade }); planter(g, 49, 9, 59, 11, Y, { box: shade });
  flag(g, 10, Y, 3, 22, C.blue); flag(g, 50, Y, 3, 22, C.red);
  hedge(g, 1, Y, 14, 3, 60); hedge(g, 59, Y, 14, 61, 60);
  planter(g, 6, 60, 20, 61, Y, { box: shade }); planter(g, 42, 60, 56, 61, Y, { box: shade });
  fillLot(g, g.sx, g.sz, rng, { keep: [frontWalk(g)] });
  return finish(g);
}

// ---------------------------------------------------------------------------
// Registry: catalog id -> builder (rng, variant, entry) => model. Merged by
// catalog.js; CATALOG metadata (name/emoji/footprint/cap) stays in catalog.js.
// ---------------------------------------------------------------------------
export const BUILDERS = {
  'small-office': bSmallOffice, 'glass-office': bGlassOffice, 'brick-highrise': bBrickHighrise,
  'deco-tower': bDecoTower, 'green-glass-tower': bGreenGlassTower, 'clock-tower': bClockTower,
  'round-tower': bRoundTower, 'hotel': bHotel, 'office-block': bOfficeBlock,
  'shopping-office': bShoppingOffice, 'glass-skyscraper': bGlassSkyscraper,
  'dark-skyscraper': bDarkSkyscraper, 'corporate-hq': bCorporateHQ, 'twin-setback': bTwinSetback,
  'spire-tower': bSpireTower, 'tech-campus': bTechCampus, 'city-bank': bCityBank,
};
