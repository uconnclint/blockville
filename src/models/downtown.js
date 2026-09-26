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
  acBox, solarPanel, ventPipe, planter, bench, lotPlinth, signLit,
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
// (w4r3) PER-PANE GLASS GRADIENT. Critic w4r2: "the tower glass is a flat,
// dark-navy grid of recessed slots … ref05's bank and hotel use bright
// sky-blue reflective panes with diagonal light streaks". Measured on ref05's
// bank: each pane runs dark petrol at the foot (16-48, 48-80, 64-96) to a lit
// cyan body (80-112, 128-160, 150-180) with a pale diagonal streak. Every
// dark/blue pane is now painted foot / body / upper bands + a short rising
// streak (offset per pane so the streaks don't line up into stripes).
// base -> [foot, body, upper, streak]; unlisted colours stay flat.
const PANE_RAMP = new Map([
  [C.dtGlassDeep, [C.dtGlassDark, C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi]],
  [C.dtGlassDark, [C.dtGlassDark, C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi]],
  [C.dtGlass, [C.dtGlassDark, C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi]],
  [C.dtGlassTeal, [C.dtGlassDark, C.dtGlassTeal, C.dtGlassTeal, C.dtGlassHi]],
]);
function paintPane(f, a, y, b, yt, d, gc, seed = 0) {
  const R4 = PANE_RAMP.get(gc), h = yt - y + 1, w = b - a + 1;
  if (!R4 || h < 4) { f.box(a, y, d, b, yt, d, gc); return false; }
  const [foot, body, up, st] = R4;
  const ym = y + Math.max(1, Math.round(h * 0.25));   // (w4r9) 0.4 -> 0.25: critic w4r8 'pale, low-contrast glass' — more of each pane is the lit teal
  f.box(a, y, d, b, y, d, foot);
  if (ym - 1 >= y + 1) f.box(a, y + 1, d, b, ym - 1, d, body);
  f.box(a, ym, d, b, yt, d, up);
  if (w >= 2) {
    const n = Math.min(w, 3), s0 = ((seed * 5) % Math.max(1, w - n + 1) + Math.max(1, w - n + 1)) % Math.max(1, w - n + 1);
    const yb = y + 1 + ((seed * 3) & 1);
    for (let k = 0; k < n; k++) {
      const yy = yb + k * 2;
      if (yy + 1 > yt) break;
      f.box(a + s0 + k, yy, d, a + s0 + k, Math.min(yt, yy + 2), d, st);
    }
  }
  return true;
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
        paintPane(S.f, u, y, u1, yt, -d, gc, i * 7 + row * 3);
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
        if (u - 1 >= start) paintPane(S.f, start, y, u - 1, yt, -d, o.glassFn ? o.glassFn(col, row, S) : o.glass, col * 7 + row * 3);
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
        paintPane(S.f, u, y, u1, yt, -1, o.glassFn ? o.glassFn(i, row, S) : o.glass, i * 7 + row * 3);
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
        const ramped = paintPane(S.f, a, y, b, yt, gd, gc, i * 7 + row * 3 + (S.u0 & 3));
        // sheen: a reflection in the upper-LEFT pane only (it used to cover the
        // whole upper half of every window and washed the shaft out)
        const mid = (a + b) >> 1;
        if (!ramped && o.sheen != null && wh >= 5 && gc !== o.sheen) S.f.box(a, y + (wh >> 1), gd, Math.max(a, mid - 1), yt, gd, o.sheen);
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
// ---------------------------------------------------------------------------
// Wave 4 round 4 grammar: GIANT BAYS. Three critics in a row (w4r1-r3): "the
// shafts are uniform grids of small, dark, recessed windows … ref05's bank
// and hotel have TALL glass bays set between pilasters that catch bright
// cyan and white highlights; group the windows into 2-3 storey bays framed
// by the pilasters". Measured on ref05's bank glass (quartiles, dark->bright):
// (15,52,70) (29,130,158) (94,161,169) (112,187,193) + white streaks.
// giantBays carves each face into bays between PILASTERS standing `pd`
// proud; every `span` storeys a stone BAND (bandH tall, flush with the
// pilaster faces, a 1-out cap) ties them, so each bay is one tall glass
// opening 2-3 storeys high. Inside, the glass is one continuous sheet with
// thin transoms at the floor lines and a centre mullion, painted as a whole:
// a dark foot row, a deep lower third, a lit cyan body and two DIAGONAL
// light streaks across the whole bay (a big reflection, not per-pane
// speckle). Floors read through the transoms; the rhythm reads as bays.
// ---------------------------------------------------------------------------
// o: { y0, y1, bw, pw=2, cw=3, pd=2, cpd=pd+1, pierC, cornerC=pierC, span=3,
//      floor=FL, bandC=pierC, bandH=2, bandOut=pd, capC=bandC, transC, mullC,
//      mull (true: centre mullion when bw>=6), tones [foot, body, lit, hi],
//      streak (true), us(S), capitals (true: a 1-out block atop each pilaster) }
const GTONES = [C.dtGlassDark, C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi];
// (w4r6) a facade-wide REFLECTION: critics w4r3 + w4r5: "the glass is dull
// blue-grey and reflects nothing; ref05's glass shows bright sky-blue
// reflection streaks". Panes on a rising diagonal band across the whole face
// take the lit ramp (and the band's leading edge the palest glass), so a
// light streak runs across several windows, not one per pane.
function glint(base, lit, P = 7, seed = 0) {
  return (i, row, S) => {
    const d = (((i - row + seed + (S ? S.u0 : 0)) % P) + P) % P;
    return d === 0 ? lit : d === 1 ? C.dtGlassTeal : base;
  };
}
function giantBays(g, B, which, o) {
  const F = o.floor || FL, span = o.span || 3, pw = o.pw != null ? o.pw : 2, cw = o.cw != null ? o.cw : 3;
  const pd = o.pd != null ? o.pd : 2, cpd = o.cpd != null ? o.cpd : pd + 1, pierC = o.pierC, cornerC = o.cornerC != null ? o.cornerC : pierC;
  const bandC = o.bandC != null ? o.bandC : pierC, bh = o.bandH || 2, bo = o.bandOut != null ? o.bandOut : pd, capC = o.capC != null ? o.capC : bandC;
  const transC = o.transC != null ? o.transC : C.dtNavyPanel, mullC = o.mullC != null ? o.mullC : transC;
  const [foot, body, lit, hi] = o.tones || GTONES;
  for (const S of sides(g, B, which)) {
    const us = o.us ? o.us(S) : bayStarts(S.u0, S.u1, o.bw, pw, cw);
    if (!us.length) continue;
    const first = us[0], last = us[us.length - 1] + o.bw - 1;
    // groups: [band bottom, glass top]
    const groups = [];
    for (let gy = o.y0; gy + bh + 3 <= o.y1; gy += span * F) groups.push([gy, Math.min(o.y1, gy + span * F - 1)]);
    us.forEach((u, i) => {
      const u1 = u + o.bw - 1, mid = (u + u1) >> 1;
      S.f.clear(u, o.y0, 0, u1, o.y1, 0);
      groups.forEach(([gy, gt], gi) => {
        const ga = gy + bh, h = gt - ga + 1;
        // glass sheet, painted as one reflection
        const seed = (i * 5 + gi * 3 + (S.u0 & 7)) % 7;
        for (let y = ga; y <= gt; y++) {
          const t = (y - ga) / Math.max(1, h - 1);
          const base = y === ga ? foot : t < 0.3 ? body : lit;
          S.f.box(u, y, -1, u1, y, -1, base);
        }
        if (o.streak !== false && h >= 8) {
          // two parallel rising streaks (2 wide + 1 wide), offset per bay
          for (let k = 0; k < o.bw; k++) {
            const col = S.f.rd > 0 ? k : o.bw - 1 - k;     // rise toward the viewer's right on every face
            const ya = ga + 2 + ((seed + col) % Math.max(1, h - 4));
            for (const [dy, w] of [[0, 4], [7, 2]]) {
              for (let q = 0; q < w; q++) { const yy = ya + dy + q; if (yy > ga + 1 && yy < gt) S.f.set(u + k, yy, -1, hi); }
            }
          }
        }
        // transoms at each floor line inside the group, a centre mullion
        for (let k = 1; k < span; k++) { const yt = gy + k * F; if (yt > ga && yt < gt) S.f.box(u, yt, -1, u1, yt, -1, transC); }
        if (o.mull !== false && o.bw >= 6) S.f.box(mid, ga, -1, mid, gt, -1, mullC);
        // band across the slot (flush with the wall) at the group foot
        S.f.box(u, gy, -1, u1, ga - 1, 0, bandC);
      });
      if (pd > 0 && i < us.length - 1) S.f.box(u1 + 1, o.y0, 1, us[i + 1] - 1, o.y1, pd, pierC);
    });
    if (cpd > 0) {
      S.f.box(S.u0 - cpd, o.y0, 1, first - 1, o.y1, cpd, cornerC);
      S.f.box(last + 1, o.y0, 1, S.u1 + cpd, o.y1, cpd, cornerC);
    }
    // bands: flush with the pilaster faces across the whole face, a cap 1 out
    groups.forEach(([gy]) => {
      S.f.box(S.u0 - cpd, gy, 1, S.u1 + cpd, gy + bh - 1, Math.max(bo, cpd), bandC);
      S.f.box(S.u0 - cpd, gy + bh - 1, Math.max(bo, cpd) + 1, S.u1 + cpd, gy + bh - 1, Math.max(bo, cpd) + 1, capC);
    });
    // pilaster capitals under each band (a small block 1 out)
    if (o.capitals !== false && pd > 0) {
      groups.slice(1).forEach(([gy]) => {
        us.forEach((u, i) => { if (i < us.length - 1) S.f.box(u + o.bw, gy - 1, pd + 1, us[i + 1] - 1, gy - 1, pd + 1, capC); });
      });
    }
  }
}
// ---------------------------------------------------------------------------
// Wave 4 round 5 grammar: GRID BAYS (the ref05 hotel / bank shaft). Critic
// w4r4: "the mid-shafts read as big flat slabs of colour with a few chunky
// dark window blocks … ref05 has a dense grid of small FRAMED windows with
// sills, pilasters and cornices on every floor". Coordinator: the midpoint
// between w4r2 (tall glass bays) and w4r4 (fine grid): a FINE grid of
// discrete windows, each in a pale frame that catches the light, grouped in
// pairs (or threes) between pilasters, a sill ledge on every floor and a
// bolder band every few floors.
// Layout per face: n window cells (frame + ww glass + frame) laid out from
// the centre; inside a group `gap` wall voxels separate the frames (-1 =
// shared mullion frame), between groups a pilaster `pw` wide stands `pd`
// proud; the leftover at each end is a corner pier `cpd` proud.
// o: { y0, y1, floor=FL, ww=2, wh=7, sill=3, per=2, gap=1, pw=2, pd=1, cw=2,
//      cpd=pd+1, wallC (repaint the face; null = keep the shell), pierC,
//      cornerC, frameC, glass | glassFn(col,row,S), hi=winCool, transom,
//      ledgeC (sill ledge each floor), ledgeOut=1, bandEvery, bandC, bandH=2,
//      bandOut, capC, sillC (per-window proud sill), spandC (panel under each
//      window inside the frame column), acEvery }
function gridLayout(span, o) {
  const cell = o.ww + 2, per = o.per || 2, gap = o.gap != null ? o.gap : 1, pw = o.pw != null ? o.pw : 2;
  const cw = o.cw != null ? o.cw : 2;
  const widthOf = (n) => { let w = n * cell; for (let k = 0; k < n - 1; k++) w += (k + 1) % per === 0 ? pw : gap; return w; };
  let best = 1;
  for (let n = 1; widthOf(n) <= span - 2 * cw; n++) if (n % per === 0 || best % per !== 0 || n < per) best = n;
  const xs = [], pil = [];
  let u = ((span - widthOf(best)) >> 1);
  for (let k = 0; k < best; k++) {
    xs.push(u); u += cell;
    if (k < best - 1) { if ((k + 1) % per === 0) { pil.push([u, u + pw - 1]); u += pw; } else u += gap; }
  }
  return { xs, pil, first: xs[0], last: xs[best - 1] + cell - 1 };
}
function gridBays(g, B, which, o) {
  const F = o.floor || FL, ww = o.ww || 2, wh = o.wh || 7, sill = o.sill != null ? o.sill : 3;
  const pd = o.pd != null ? o.pd : 1, cpd = o.cpd != null ? o.cpd : pd + 1;
  const pierC = o.pierC, cornerC = o.cornerC != null ? o.cornerC : pierC, frameC = o.frameC != null ? o.frameC : C.dtFrame;
  const hr = o.hiRows != null ? o.hiRows : 1, gd = -(o.recess != null ? o.recess : 1), fo = o.frameOut || 0;
  for (const S of sides(g, B, which)) {
    const L = gridLayout(S.u1 - S.u0 + 1, o);
    const U = (u) => S.u0 + u;
    const first = U(L.first), last = U(L.last);
    if (o.wallC != null) S.f.box(S.u0, o.y0, 0, S.u1, o.y1, 0, o.wallC);
    for (let yb = o.y0, row = 0; yb + sill + wh <= o.y1; yb += F, row++) {
      const y = yb + sill, yt = y + wh - 1;
      if (o.skipRow && o.skipRow(row)) continue;
      L.xs.forEach((x0, i) => {
        const a = U(x0) + 1, b = a + ww - 1;
        if (o.spandC != null) S.f.box(a - 1, yb + 1, 0, b + 1, y - 2, 0, o.spandC);
        // frame ring on the face (fo = 1: standing 1 proud, so its head and
        // sill catch the light like the ref05 hotel's window surrounds)
        if (o.jambs === false) { S.f.box(a - 1, y - 1, fo, b + 1, y - 1, fo, frameC); S.f.box(a - 1, yt + 1, fo, b + 1, yt + 1, fo, frameC); }   // head + sill only
        else if (fo > 0) { S.f.box(a - 1, y - 1, fo, b + 1, y - 1, fo, frameC); S.f.box(a - 1, yt + 1, fo, b + 1, yt + 1, fo, frameC); S.f.box(a - 1, y, fo, a - 1, yt, fo, frameC); S.f.box(b + 1, y, fo, b + 1, yt, fo, frameC); }
        else S.f.box(a - 1, y - 1, 0, b + 1, yt + 1, 0, frameC);
        if (gd < 0) S.f.clear(a, y, 0, b, yt, 0);
        const gc = o.glassFn ? o.glassFn(i, row, S) : o.glass;
        paintPane(S.f, a, y, b, yt, gd, gc, i * 5 + row * 3 + (S.u0 & 3));    // glass gd back (1 = an AO reveal; 0 = flush and bright)
        if (hr > 0) S.f.box(a, yt - hr + 1, gd, b, yt, gd, o.hi != null ? o.hi : C.winCool);
        if (o.transom) S.f.box(a, yt - 2 - hr, gd, b, yt - 2 - hr, gd, frameC);
        if (ww >= 4 && o.mull !== false) S.f.box((a + b) >> 1, y, gd, (a + b) >> 1, yt, gd, frameC);
        if (o.sillC != null) S.f.box(a - 1, y - 2, 1, b + 1, y - 2, 1, o.sillC);
        // (w4r9) critic w4r8: "carve ... protruding sills and cornices": a
        // hood moulding over every window (hoodOut proud, 1 wider each side)
        // and a lug sill under it, so each FLOOR throws its own shadow line
        if (o.hoodC != null) S.f.box(a - 2, yt + 1, 1, b + 2, yt + 1, o.hoodOut || 2, o.hoodC);
        if (o.lugC != null) S.f.box(a - 1, y - 1, 1, b + 1, y - 1, o.lugOut || 1, o.lugC);
        if (o.acEvery && ((i * 3 + row * 5 + S.u0) % o.acEvery) === 0) { S.f.box(a, y - 4, 1, b, y - 2, 1, C.offwhite); S.f.set(a, y - 3, 1, C.metalDark); }
      });
    }
    // pilasters between the groups, corner piers at the ends
    if (pd > 0) for (const [p0, p1] of L.pil) S.f.box(U(p0), o.y0, 1, U(p1), o.y1, pd, pierC);
    if (cpd > 0) { S.f.box(S.u0 - cpd, o.y0, 1, first - 1, o.y1, cpd, cornerC); S.f.box(last + 1, o.y0, 1, S.u1 + cpd, o.y1, cpd, cornerC); }
    const bf = o.bandFrom || o.bandEvery, bo = Math.max(o.bandOut != null ? o.bandOut : pd + 1, cpd);
    const isBand = (row) => o.bandEvery && row >= bf && (row - bf) % o.bandEvery === 0;
    // a sill ledge on every floor: crosses the pilasters 1 proud of them
    if (o.ledgeC != null) {
      const lo = o.ledgeOut != null ? o.ledgeOut : Math.max(1, pd + 1);
      for (let yb = o.y0, row = 0; yb + sill + wh <= o.y1; yb += F, row++) {
        if (isBand(row) || (row === 0 && o.ledgeFirst === false)) continue;
        const y = yb + sill - 2;
        // (w4r8) ledgeIn: the ledge stays BEHIND the pilaster faces (only the
        // bays get it), so the pilasters run unbroken and the bays read as
        // recessed vertical strips instead of a uniform floor-by-floor grid
        if (o.ledgeIn) S.f.box(first, y, 1, last, y, lo, o.ledgeC);
        else S.f.box(S.u0 - cpd, y, 1, S.u1 + cpd, y, Math.max(lo, cpd), o.ledgeC);
      }
    }
    // a bold band every few floors (bandH tall, a 1-out cap on top)
    if (o.bandEvery) {
      const bh = o.bandH || 2, bc = o.bandC != null ? o.bandC : pierC, cc = o.capC != null ? o.capC : bc;
      for (let k = bf; o.y0 + k * F + sill < o.y1 - 2; k += o.bandEvery) {
        const y = o.y0 + k * F + sill - 1 - bh;
        S.f.box(S.u0 - bo, y, 1, S.u1 + bo, y + bh - 1, bo, bc);
        S.f.box(S.u0 - bo - 1, y + bh - 1, bo + 1, S.u1 + bo + 1, y + bh - 1, bo + 1, cc);
      }
    }
  }
}
// (w4r11) CURTAIN-WALL ZONE. Critics w4r8 + w4r10: "tower glass is flat
// dark-blue slots stamped as one window grid on every floor, no reflections;
// ref05 mixes curtain-wall bands with framed punched windows — break each
// tower into a glazed base, a shaft and a crown band, with light-cyan glass
// and white diagonal glints". A curtain zone is ONE continuous sheet of
// bright cyan glass (flush, never recessed: small reveals go dark in AO)
// between solid corner piers `cw` wide, crossed by thin proud mullions every
// `pitch` and a proud transom at every floor line, with FACADE-WIDE diagonal
// glints (a 3-wide band + a 1-wide companion) running across the mullions
// like the sky reflection on the ref05 logistics block and bank. Optional
// `spandC` paints the first `spandH` rows of every floor as an opaque band
// (ribbon windows). Measured target (PIL, ref05 bank + logistics glass):
// q50 ~#44677d, q90 ~#6dccf8, q98 ~#cde3f1 — a lit cyan body, pale glints.
// o: { y0, y1, cw=2, cornerC, cornerOut=1, pitch=6, floor=FL, mullC=dtFrame,
//      transC=mullC, mullOut=0, transOut=1, tones [foot, body, head, glint], streak,
//      spandC, spandH=3, seed }
function curtain(g, B, which, o) {
  const F = o.floor || FL, cw = o.cw != null ? o.cw : 2, P = o.pitch || 7;
  const mo = o.mullOut != null ? o.mullOut : 0, to = o.transOut != null ? o.transOut : 1;
  const mullC = o.mullC != null ? o.mullC : C.dtFrame, transC = o.transC != null ? o.transC : mullC;
  // per floor: a deep foot, a lit cyan middle, a pale sky-blue head (each
  // floor reads dark -> light like the ref05 bank panes), + near-white glints
  const [foot, body, head, hi] = o.tones || [C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi, C.dtFrame];   // glint = near-white (the palette is full at 200: no new key)
  const SP = o.streak || 23, sh = o.spandH != null ? o.spandH : 3;
  for (const S of sides(g, B, which)) {
    const a = S.u0 + cw, b = S.u1 - cw, c = (a + b) >> 1;
    const sd = (o.seed || 0) + (S.s === 'l' || S.s === 'r' ? 9 : 0);
    for (let y = o.y0; y <= o.y1; y++) {
      const fy = (y - o.y0) % F;
      for (let u = a; u <= b; u++) {
        let col;
        if (o.spandC != null && fy >= 1 && fy <= sh) col = o.spandC;
        else {
          const dd = (((u - y + sd) % SP) + SP) % SP;
          col = dd === 1 || dd === 2 ? hi : dd === 0 || dd === 3 || dd === 5 ? head : fy <= 2 ? foot : fy <= 6 ? body : head;
        }
        S.f.set(u, y, 0, col);
      }
    }
    // mullions + transoms stand proud of the sheet (their shadow = relief)
    // (vertical mullions FLUSH by default: proud ones buried the narrow
    // strips between them in AO; the proud transom gives each floor a line)
    for (let u = c; u <= b - 1; u += P) if (u > a) S.f.box(u, o.y0, Math.min(1, mo), u, o.y1, mo, mullC);
    for (let u = c - P; u >= a + 1; u -= P) S.f.box(u, o.y0, Math.min(1, mo), u, o.y1, mo, mullC);
    for (let y = o.y0; y <= o.y1; y += F) S.f.box(a, y, Math.min(1, to), b, y, to, transC);
    if (cw > 0 && o.cornerC != null) {
      const co = o.cornerOut != null ? o.cornerOut : 1;
      S.f.box(S.u0 - co, o.y0, 0, a - 1, o.y1, co, o.cornerC);
      S.f.box(b + 1, o.y0, 0, S.u1 + co, o.y1, co, o.cornerC);
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
// (w4r2) A designed plaza strip instead of parking (critic w4r1: "the ground
// lot is packed with parked cars instead of a designed plaza … swap the lot's
// cars for a paved, planted entry plaza"). Light paving on a darker 5-grid,
// then a row of raised planted beds along the strip's long axis — stone rim,
// grass, a chunky tree and flowers — with paved gaps for fillLot's benches.
function plazaStrip(g, x0, z0, x1, z1, rng, o = {}) {
  const Y = 2, alongZ = (z1 - z0) >= (x1 - x0), W = alongZ ? x1 - x0 + 1 : z1 - z0 + 1;
  const [pv, pl] = g.pave || [C.lotPave, C.lotPaveDark];
  g.box(x0, 1, z0, x1, 1, z1, pv);
  tiles(g, x0, z0, x1, z1, 1, pl, 5);
  if (W < 5) return;
  const bw = Math.min(W - 2, 7), bl = o.bed || 9, gap = o.gap || 5;
  const a0 = alongZ ? z0 + 1 : x0 + 1, a1 = alongZ ? z1 - 1 : x1 - 1, s = (alongZ ? x0 : z0) + ((W - bw) >> 1);
  const n = Math.max(1, Math.floor((a1 - a0 + 1 + gap) / (bl + gap)));
  let a = a0 + (((a1 - a0 + 1) - (n * bl + (n - 1) * gap)) >> 1);
  for (let i = 0; i < n; i++, a += bl + gap) {
    const [bx0, bz0, bx1, bz1] = alongZ ? [s, a, s + bw - 1, a + bl - 1] : [a, s, a + bl - 1, s + bw - 1];
    g.walls(bx0, Y, bz0, bx1, Y, bz1, o.rim != null ? o.rim : C.dtStone);
    g.box(bx0 + 1, Y, bz0 + 1, bx1 - 1, Y, bz1 - 1, C.lotGrass);
    const cx = (bx0 + bx1) >> 1, cz = (bz0 + bz1) >> 1;
    // (w4r5) critic w4r4: "the towers are packed tightly with little lot space
    // … the ref buildings sit on generous plinths". Big trees in every bed hid
    // the lot; now every other bed is a LOW clipped hedge (the ref05 hotel's
    // planters), so the paving reads as an open plaza.
    if (i % 2 === 0) tree(g, cx, Y + 1, cz, 5);
    else g.box(bx0 + 1, Y + 1, bz0 + 1, bx1 - 1, Y + 2, bz1 - 1, C.bush);
    for (const [fx, fz] of [[bx0 + 1, bz0 + 1], [bx1 - 1, bz1 - 1], [bx0 + 1, bz1 - 1], [bx1 - 1, bz0 + 1]]) {
      g.set(fx, Y + 1, fz, C.bush); if (rng() < 0.7) g.set(fx, Y + 2, fz, pk(rng, [C.pink, C.yellow, C.signWhite, C.red]));
    }
  }
}
// (w4r2) Designed entry forecourt across the front strip z0..z1 (replaces the
// kerbside lay-by of cars): a fountain basin either side of the front walk,
// planted beds with trees toward the corners, the walk itself in dark paving.
function forecourt(g, x0, x1, z0, z1, rng, o = {}) {
  const Y = 2, xc = o.xc != null ? o.xc : (x0 + x1) >> 1, hw = o.hw || 8;
  const [pv, pl] = g.pave || [C.lotPave, C.lotPaveDark];
  g.box(x0, 1, z0, x1, 1, z1, pv);
  tiles(g, x0, z0, x1, z1, 1, pl, 5);
  g.box(xc - hw + 2, 1, z0, xc + hw - 2, 1, z1, pl);
  const D = z1 - z0 + 1;
  for (const [a, b, outerLeft] of [[x0 + 1, xc - hw - 2, true], [xc + hw + 2, x1 - 1, false]]) {
    if (b - a < 7) continue;
    // planted bed with a tree at the outer end of the wing
    const bx = outerLeft ? a : b - 5;
    g.walls(bx, Y, z0 + 1, bx + 5, Y, z1 - 1, C.dtStone);
    g.box(bx + 1, Y, z0 + 2, bx + 4, Y, z1 - 2, C.lotGrass);
    tree(g, bx + 2, Y + 1, ((z0 + z1) >> 1) - 1, 6);
    // fountain in the rest: stone rim, pool water, a tiered centre + spout
    const fa = outerLeft ? bx + 7 : a, fb = outerLeft ? b : bx - 2;
    if (o.fountains === false || fb - fa < 6 || D < 5) continue;
    const fw = Math.min(11, fb - fa + 1), f0 = ((fa + fb) >> 1) - (fw >> 1), fz0 = z0, fz1 = z1;
    g.walls(f0, Y, fz0, f0 + fw - 1, Y + 1, fz1, C.dtStone);
    g.box(f0 + 1, Y, fz0 + 1, f0 + fw - 2, Y, fz1 - 1, C.civPool);
    const cx = f0 + (fw >> 1), cz = (fz0 + fz1) >> 1;
    g.box(cx - 1, Y, cz - 1, cx + 1, Y + 2, cz, C.dtStone);
    g.box(cx, Y + 3, cz, cx, Y + 4, cz, C.civPoolLt);
  }
  void rng;
}
// (w4r6) THE REF05 HOTEL LOT. Three critics running (w4r3-r5): "the towers
// fill their lots to the kerb … the ref gives each tower a generous paved
// forecourt with entrance steps, hedges, lawn and a porch". The 2x2 towers
// now stand on a ~1-tile footprint set back on the lot (as ref05's hotel and
// bank do) and this dresses the open ground around P, the podium box:
//   front  (z < fz): two lawn panels in clipped-hedge rims either side of a
//          dark-paved walk, a tree at each panel's outer corner, flowers,
//          lamp pairs along the walk, benches facing it, L-shaped corner hedges
//   sides  : a lawn strip with a hedge rim + spaced trees (or a hedge)
//   back   : a clipped hedge line and a service corner
// Everything else stays OPEN paving (the ref lots are clean, not cluttered).
// o: { xc, hw (half walk), fz (last free z in front: the steps start after),
//      trees (default true), flags:[c,c] }
function hotelLot(g, P, rng, o = {}) {
  const Y = 2, W = g.sx, D = g.sz, xc = o.xc != null ? o.xc : W >> 1, hw = o.hw || 6;
  const [pv, pl] = g.pave || [C.lotPave, C.lotPaveDark];
  const fz = o.fz != null ? o.fz : P.z0 - 8;
  // (w4r13) critics w4r10-w4r12: "tower lots are thin rims with green cube
  // bushes … the reference uses PAVED forecourts with planters, benches and
  // steps on a clearly bounded lot". The lawn panels in hedge rims are now
  // stone-kerbed PAVED courts in the lot's own paving, each with a tree in a
  // stone pit, a long flower planter and a bench — the lot reads as one light
  // plinth against the black roads instead of green blobs on green grass.
  const court = (x0, z0, x1, z1, tr) => {
    if (x1 - x0 < 3 || z1 - z0 < 3) return;
    g.box(x0, 1, z0, x1, 1, z1, pv);
    tiles(g, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 1, pl, 5);
    g.walls(x0, 1, z0, x1, 1, z1, C.dtStone);
    for (const [tx, tz] of tr || []) {
      g.box(tx - 2, Y, tz - 2, tx + 3, Y, tz + 3, C.stoneDark); g.box(tx - 1, Y, tz - 1, tx + 2, Y, tz + 2, C.dirtDark);
      tree(g, tx, Y + 1, tz, 6);
    }
    const w = x1 - x0, d = z1 - z0;
    if (w >= 12 && d >= 6) {
      const px0 = tr && tr.length && tr[0][0] < ((x0 + x1) >> 1) ? x1 - 9 : x0 + 3;
      planter(g, px0, z1 - 4, px0 + 6, z1 - 2, Y, { box: C.dtStone, flowers: [C.pink, C.yellow, C.signWhite, C.red], rng });
      bench(g, px0, Y, z0 + 3, 'x', 5);
    }
  };
  // the walk: darker paving from the kerb to the steps, kerb-edged
  g.box(xc - hw, 1, 1, xc + hw, 1, fz, pl);
  g.box(xc - hw - 1, 1, 1, xc - hw - 1, 1, fz, C.dtStone); g.box(xc + hw + 1, 1, 1, xc + hw + 1, 1, fz, C.dtStone);
  // front courts either side of the walk (a paved margin to the walk + kerb)
  const la = xc - hw - 4, lb = xc + hw + 4, lz0 = 4, lz1 = fz - 2;
  if (lz1 - lz0 >= 4) {
    court(4, lz0, la, lz1, o.trees === false ? [] : [[7, lz0 + 3]]);
    court(lb, lz0, W - 5, lz1, o.trees === false ? [] : [[W - 9, lz0 + 3]]);
  }
  // bollards (not hedge blobs) along the front kerb corners
  bollards(g, 2, 12, 1, Y, 3); bollards(g, W - 13, W - 3, 1, Y, 3);
  // side strips: paving with trees in stone pits where there is room
  for (const [x0, x1] of [[1, P.x0 - 2], [P.x1 + 2, W - 2]]) {
    const w = x1 - x0 + 1;
    if (w >= 7) {
      const z0 = Math.max(fz + 1, P.z0 - 2), z1 = D - 4, tx = ((x0 + x1) >> 1) - 1;
      for (let z = z0 + 3; z + 4 <= z1; z += 12) {
        g.box(tx - 2, Y, z - 2, tx + 3, Y, z + 3, C.stoneDark); g.box(tx - 1, Y, z - 1, tx + 2, Y, z + 2, C.dirtDark);
        tree(g, tx, Y + 1, z, 5);
      }
    } else if (w >= 3) {
      // (w4r13) narrow strip: stone flower boxes on paving, not a hedge wall
      for (let z = P.z0; z + 5 <= D - 3; z += 9) planter(g, x0, z, x1, z + 5, Y, { box: C.dtStone, flowers: [C.pink, C.yellow, C.signWhite], rng });
    }
  }
  // back: a clipped hedge line along the rear edge + a service corner
  hedge(g, 2, Y, D - 2, W - 3, D - 2, 2);
  if (P.z1 < D - 7) service(g, P.x1 - 9, P.z1 + 2, rng);
  if (o.flags) { flag(g, xc - hw - 5, Y, fz, 22, o.flags[0]); flag(g, xc + hw + 5, Y, fz, 22, o.flags[1]); }
  // (w4r9) critics w4r7 + w4r8: "lots sparse: thin green strips and a few
  // cars vs the ref's full plazas with seating, fountains and props". The
  // open paving left round the lawns gets a moderate scatter of planters,
  // benches, café umbrellas, bins and lamps (walk kept clear)
  if (o.props !== 0) fillLot(g, W, D, rng, { n: o.props || (W > 40 ? 14 : 6), keep: [[xc - hw - 1, 0, xc + hw + 1, fz + 1]] });
  void pv;
}
// (w4r7) critic w4r6: "each tower needs a separate, heavily detailed base one
// or two storeys tall … a setback base … deep cornices". The 2x2 towers now
// stand on a podium 5-6 voxels WIDER than the shaft on every side, and this
// dresses its top as the ref05 hotel/bank podium roof: a stepped cornice
// (dentils, then 2 and 3 out), pale paving, a glass-railed parapet, a clipped
// hedge ring inside the parapet with flowers, trees on the front corners and
// down the sides, AC units on the back strip.
// top = streetPodium's return (the terrace walking level); T = the shaft box.
function podiumTerrace(g, P, T, top, rng, o = {}) {
  const ut = top - 3, trim = o.trim != null ? o.trim : C.dtFrame, pave = o.pave != null ? o.pave : C.lotPave;
  dentils(g, P, ut, trim);
  course(g, P, ut + 1, trim, 2, 1, 0);
  course(g, P, ut + 2, o.cornC != null ? o.cornC : trim, 3, 1, 0);
  g.box(P.x0 + 1, ut + 2, P.z0 + 1, P.x1 - 1, ut + 2, P.z1 - 1, pave);
  railing(g, P.x0, P.z0, P.x1, P.z1, top + 2, o.railC != null ? o.railC : C.metal);
  // hedge ring in stone boxes just inside the parapet (gaps at the corners)
  const box0 = o.box != null ? o.box : C.stoneDark;
  const hedgeRun = (x0, z0, x1, z1) => {
    g.box(x0, top, z0, x1, top, z1, box0);
    g.box(x0, top + 1, z0, x1, top + 2, z1, C.bush);
    g.box(x0, top + 1, z0, x1, top + 1, z1, C.leafMid);
    for (let x = x0 + 1; x < x1; x += 4) for (let z = z0; z <= z1; z += 4) g.set(x, top + 3, z, (x + z) & 4 ? C.pink : C.yellow);
    if (x1 === x0) for (let z = z0 + 1; z < z1; z += 4) g.set(x0, top + 3, z, z & 4 ? C.pink : C.signWhite);
  };
  const fs = T.z0 - P.z0 - 1, ls = T.x0 - P.x0 - 1, rs = P.x1 - T.x1 - 1;
  if (fs >= 3) hedgeRun(P.x0 + 5, P.z0 + 1, P.x1 - 5, P.z0 + 2);
  if (ls >= 3) hedgeRun(P.x0 + 1, P.z0 + 6, P.x0 + 1, P.z1 - 6);
  if (rs >= 3) hedgeRun(P.x1 - 1, P.z0 + 6, P.x1 - 1, P.z1 - 6);
  // clipped trees: the two front corners, then down each side strip
  if (fs >= 3 && ls >= 3) tree(g, P.x0 + 2, top, P.z0 + 2, 4);
  if (fs >= 3 && rs >= 3) tree(g, P.x1 - 3, top, P.z0 + 2, 4);
  for (const [x, w] of [[P.x0 + 2 + ((ls - 4) >> 1), ls], [P.x1 - 3 - ((rs - 4) >> 1), rs]]) {
    if (w < 5) continue;
    for (let z = P.z0 + 12; z + 4 < P.z1 - 4; z += 12) tree(g, x, top, z, 4);
  }
  // benches facing out on the front strip
  if (fs >= 4) for (const x of [P.x0 + 9, P.x1 - 14]) g.box(x, top, P.z0 + 4, x + 5, top, P.z0 + 4, C.wood);
  // back strip: condensers
  if (P.z1 - T.z1 - 1 >= 3) for (let x = P.x0 + 3; x + 4 < P.x1 - 2; x += 9) acBox(g, x, top, T.z1 + 1, { w: 4, d: 2, h: 2 });
  void rng;
}
// A balcony floor across every face of box B at y (the floor line): a slab
// `out` proud, a glass balustrade 2 tall, a steel top rail (critic w4r6:
// "more variation from floor to floor, such as a few balcony or ledge floors").
function balconyFloor(g, B, y, slabC, o = {}) {
  const out = o.out || 3;
  ledge(g, B, y, slabC, out, 1);
  ring(g, B, y + 1, o.glass != null ? o.glass : C.dtGlassHi, out, 2);
  ring(g, B, y + 3, o.rail != null ? o.rail : C.metal, out, 1);
}
// (w4r2) The ref05 HOTEL sign at double scale: 2x 5x7 letters (legible at
// game zoom) in a lit colour on a black board with a thick lit rim, standing
// on two steel legs at a roof's front edge, lettered both sides.
function bigSign(g, xc, y, z, text, o = {}) {
  const k = o.k || 2, fg = o.fg != null ? o.fg : C.yellow, bg = o.bg != null ? o.bg : C.black, rim = o.rim != null ? o.rim : fg;
  const W = (text.length * 6 - 1) * k + 8, H = 7 * k + 7, x0 = xc - (W >> 1), x1 = x0 + W - 1, yb = y + 3;
  for (const x of [x0 + 4, x1 - 4]) g.box(x, y, z + 1, x + 1, yb - 1, z + 2, C.metalDark);
  g.box(x0, yb, z, x1, yb + H - 1, z + 2, bg);
  for (const [a, b] of [[yb, yb], [yb + H - 1, yb + H - 1]]) { g.box(x0, a, z - 1, x1, b, z - 1, rim); g.box(x0, a, z + 3, x1, b, z + 3, rim); }
  for (const x of [x0, x1]) { g.box(x, yb, z - 1, x, yb + H - 1, z - 1, rim); g.box(x, yb, z + 3, x, yb + H - 1, z + 3, rim); }
  text5(facade(g, 'front', z), xc, yb + 3, text, fg, 1, k);
  text5(facade(g, 'back', z + 2), xc, yb + 3, text, fg, 1, k);
  return yb + H;
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
  c = signLit(c);   // [night] lit sign letters after dusk (same colour by day)
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
// (w4r4) Warm plaza lot: ref05's bank and hotel stand on wide BEIGE paved
// forecourts (critics w4r1-r3: "thin grey rims … the ref gives each tower a
// generous paved forecourt"). Sets the lot fill + g.pave for plazaStrip /
// forecourt, and returns Y.
function plazaLot(g, fill = C.sand, line = C.sandDark) {
  g.pave = [fill, line];
  const Y = lotPlinth(g, 0, 0, g.sx - 1, g.sz - 1, { fill });
  tiles(g, 1, 1, g.sx - 2, g.sz - 2, Y - 1, line, 6);
  return Y;
}
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
  const glass = o.glass != null ? o.glass : C.dtGlassDark, I = ins(B, d), out = o.out != null ? o.out : 4;
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
const PAVED = new Set([C.lotPave, C.lotPaveDark, C.lotGrass, C.sand, C.sandDark]);
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
    const cornC = o.cornerC != null ? o.cornerC : (ground === 'colonnade' ? colC : wall);
    S.f.box(S.u0 - 1, gy0, 1, first - 1, ut, 1, cornC);
    S.f.box(last + 1, gy0, 1, S.u1 + 1, ut, 1, cornC);
    if (!tall || o.cornerC != null) for (let y = gy0 + 1; y < ut - 1; y += 4) { S.f.box(S.u0 - 1, y, 1, S.u0 + 1, y + 1, 1, pier); S.f.box(S.u1 - 1, y, 1, S.u1 + 1, y + 1, 1, pier); }
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
  // (w4) a temple's name must fit its entablature (TOWN / CITY overflowed the
  // 1x1 temples: the first letter floated off the end and read "OWN")
  let w = o.w || 9;
  if (o.kind === 'temple' && o.text) w = Math.max(w, ((o.text.length * 6 - 1 - 8) | 1));
  const Y = o.Y, x0 = o.xc - (w >> 1), x1 = x0 + w - 1, D = o.depth || 6;
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
  const pyl = kind === 'arch' ? 7 : 5, lx0 = x0 - pyl, lx1 = x1 + pyl, lz0 = zf - D;
  if (kind === 'cochere') {
    // (w4) porte-cochère: only a 4-deep stepped landing at the doors; the
    // rest of the depth is a drive-through lane of asphalt under the roof
    g.box(lx0, Y, zf - 5, lx1, Y, zf - 1, stone);
    g.box(lx0 + 2, Y + 1, zf - 3, lx1 - 2, Y + 1, zf - 1, stone);
    g.box(x0 + 1, Y + 1, zf - 3, x1 - 1, Y + 1, zf - 1, o.mat != null ? o.mat : C.red);
    g.box(lx0 - 2, Y - 1, lz0 - 1, lx1 + 2, Y - 1, zf - 6, C.lotAsphalt);
    for (let x = lx0; x <= lx1; x += 4) g.box(x, Y - 1, zf - 6, x + 1, Y - 1, zf - 6, C.lotLine);
  } else {
    g.box(lx0, Y, lz0, lx1, Y + 1, zf - 1, stone);
    // (w4r5) critic w4r4: "wide, clearly readable entrances (bank steps)":
    // a broad flight — the first tread runs the landing's full width + 2 and
    // 3 deep, with clipped shrub boxes at both ends of the landing
    g.box(lx0 - 2, Y, lz0 - 3, lx1 + 2, Y, lz0 - 1, stone);
    g.box(lx0 - 2, Y - 1, lz0 - 4, lx1 + 2, Y - 1, lz0 - 4, C.stoneDark);
    for (const x of [lx0 - 2, lx1]) { g.box(x, Y + 2, lz0, x + 2, Y + 3, lz0 + 2, C.bush); g.set(x + 1, Y + 4, lz0 + 1, C.pink); }
    g.box(x0 + 1, Y + 1, lz0 + 1, x1 - 1, Y + 1, zf - 1, o.mat != null ? o.mat : C.red);
  }
  // columns
  const cz = lz0 + 1, xs = kind === 'arch' ? [] : [lx0 + 1, lx1 - 2];
  if (o.cols === 4 && kind !== 'arch') xs.push(x0 + 1, x1 - 2);
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
    // (w4r2) the blade carries the name in stacked 5x7 letters on both
    // faces, lit, with a bulb border (critic w4r1: "entrance signs are small,
    // low-contrast voxel mush you cannot read at this zoom")
    const bx = lx1 - 1, bt = o.text ? ry + 12 + o.text.length * 8 : ry + 34;
    g.box(bx, ry + 10, lz0, bx + 1, bt, lz0 + 6, fc);
    for (let y = ry + 11; y < bt; y += 3) for (const x of [bx - 1, bx + 2]) { g.set(x, y, lz0, bulb); g.set(x, y, lz0 + 6, bulb); }
    g.box(bx, bt + 1, lz0, bx + 1, bt + 1, lz0 + 6, frame);
    if (o.text) {
      const lc = signLit(o.bladeC != null ? o.bladeC : (o.textC != null ? o.textC : C.gold));
      [...o.text].forEach((ch, i) => {
        const gl = F57[ch] || F57[' '], yb = bt - 8 * (i + 1) + 1;
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (gl[r * 5 + c] === '#') {
          g.set(bx - 1, yb + 6 - r, lz0 + 1 + c, lc); g.set(bx + 2, yb + 6 - r, lz0 + 5 - c, lc);
        }
      });
    }
  } else if (kind === 'arch') {
    // (w4) a monumental stone ARCHWAY (twins): two pylons and a deep lintel
    // frame a tall round-headed tunnel onto the doors; a gold archivolt and
    // keystone, a sunburst fanlight, the name in gold on a black band, a
    // stepped cornice with gold finials, lanterns on the pylon faces
    const trim = frame, gt = o.Y + 17, top = gt + 14, ax0 = x0 - 1, ax1 = x1 + 1;
    g.box(lx0, Y + 2, lz0, ax0 - 1, top, zf - 1, colC);
    g.box(ax1 + 1, Y + 2, lz0, lx1, top, zf - 1, colC);
    g.box(ax0, gt - 2, lz0, ax1, top, zf - 1, colC);
    // round the head of the opening (stepped quarter circles)
    for (const [k, n] of [[0, 4], [1, 2], [2, 1], [3, 1]]) {
      const y = gt - 2 - k - 1;
      g.box(ax0, y, lz0, ax0 + n - 1, y, zf - 1, colC); g.box(ax1 - n + 1, y, lz0, ax1, y, zf - 1, colC);
    }
    // archivolt: a trim ring 1 proud round the opening + keystone
    const FA = facade(g, 'front', lz0);
    FA.box(ax0 - 1, Y + 2, 1, ax0 - 1, gt - 7, 1, trim); FA.box(ax1 + 1, Y + 2, 1, ax1 + 1, gt - 7, 1, trim);
    for (const [k, n] of [[0, 4], [1, 2], [2, 1], [3, 1]]) {
      const y = gt - 3 - k, ua = ax0 + n - 1, ub = ax1 - n + 1;
      FA.box(ax0 - 1 + (k === 3 ? 0 : 0), y, 1, ua, y, 1, trim); FA.box(ub, y, 1, ax1 + 1, y, 1, trim);
    }
    FA.box(ax0 + 3, gt - 2, 1, ax1 - 3, gt - 2, 1, trim);
    FA.box(o.xc - 1, gt - 2, 1, o.xc + 1, gt + 1, 2, trim);
    // sunburst fanlight on the lobby glass inside the arch head
    const FL0 = facade(g, 'front', zf);
    for (let r = 0; r < 3; r++) FL0.box(o.xc - 1 - r * 3, gt - 6 + r, -2, o.xc + 1 + r * 3, gt - 6 + r, -2, r === 0 ? C.gold : C.winCool);
    for (const dx of [-6, -3, 0, 3, 6]) FL0.box(o.xc + dx, gt - 5, -2, o.xc + dx, gt - 3, -2, C.gold);
    // name band + cornice + finials
    if (o.text) {
      const TW = o.text.length * 6 - 1, bx0 = o.xc - (TW >> 1) - 2, bx1 = o.xc + (TW >> 1) + 2;
      FA.box(bx0, gt + 3, 1, bx1, gt + 11, 1, o.boardC != null ? o.boardC : C.black);
      FA.box(bx0, gt + 3, 1, bx1, gt + 3, 1, trim); FA.box(bx0, gt + 11, 1, bx1, gt + 11, 1, trim);
      text5(facade(g, 'front', lz0 - 1), o.xc, gt + 4, o.text, o.textC != null ? o.textC : C.gold, 1, 1);
    }
    g.box(lx0 - 1, top + 1, lz0 - 1, lx1 + 1, top + 1, zf - 1, stone);
    g.box(lx0, top + 2, lz0, lx1, top + 2, zf - 1, trim);
    g.box(lx0 + 2, top + 3, lz0 + 1, lx1 - 2, top + 3, zf - 1, stone);
    for (const x of [lx0 + 2, lx1 - 2]) { g.box(x - 1, top + 3, lz0 + 2, x + 1, top + 4, lz0 + 4, trim); g.box(x, top + 5, lz0 + 3, x, top + 7, lz0 + 3, trim); }
    // pylon faces: a sunk panel + a bronze lantern each
    for (const [a, b] of [[lx0 + 1, ax0 - 2], [ax1 + 2, lx1 - 1]]) {
      FA.box(a, Y + 5, 0, b, gt - 1, 0, stone);
      const m = (a + b) >> 1;
      FA.box(m, gt - 9, 1, m, gt - 8, 1, C.metalDark); FA.box(m, gt - 7, 1, m, gt - 5, 1, C.lamp); FA.set(m, gt - 4, 1, C.metalDark);
    }
  } else if (kind === 'cochere') {
    // (w4) porte-cochère (the ref05 hotel's drop-off, scaled up): a deep flat
    // roof on four slim columns reaching out over a drive lane, a teal glass
    // skylight in a white frame, a lit soffit strip, the name on a board on top
    const L0 = lx0 - 2, L1 = lx1 + 2;
    g.box(L0, ry, lz0 - 1, L1, ry + 2, zf - 1, frame);
    g.box(L0 + 2, ry + 3, lz0 + 1, L1 - 2, ry + 3, zf - 3, o.glassTop != null ? o.glassTop : C.dtGlassTeal);
    g.walls(L0 + 1, ry + 3, lz0, L1 - 1, ry + 3, zf - 2, frame);
    for (let x = L0 + 6; x < L1 - 2; x += 6) g.box(x, ry + 3, lz0 + 1, x, ry + 3, zf - 3, frame);
    g.box(L0, ry, lz0 - 2, L1, ry + 2, lz0 - 2, fascia);
    g.box(L0 + 1, ry - 1, lz0 + 1, L1 - 1, ry - 1, lz0 + 1, C.lamp);           // soffit light
    if (o.text) {
      const tc = o.textC != null ? o.textC : C.signWhite, TW = o.text.length * 6 - 1;
      const bx0 = o.xc - (TW >> 1) - 2, bx1 = o.xc + (TW >> 1) + 2, bz = lz0, by0 = ry + 4, by1 = ry + 12;
      g.box(bx0, by0, bz, bx1, by1, bz + 1, o.boardC != null ? o.boardC : C.black);
      g.box(bx0, by1, bz, bx1, by1, bz + 1, tc);
      text5(facade(g, 'front', bz), o.xc, by0 + 1, o.text, tc, 1, 1);
      text5(facade(g, 'back', bz + 1), o.xc, by0 + 1, o.text, tc, 1, 1);
    }
    // bollards along the landing edge + a taxi dropping off under the roof
    for (const x of [lx0 - 2, lx1 + 2]) { g.box(x, Y, zf - 5, x, Y + 1, zf - 5, C.stoneDark); g.set(x, Y + 2, zf - 5, C.yellow); }
    car(g, o.xc - 4, Y, lz0 + 2, true, C.taxiYellow);
  } else if (kind === 'pergola') {
    // (w10) timber pergola with climbing plants (eco tower): slatted beams,
    // hedges hung along the top, the name in green letters standing on it
    g.box(lx0, ry, lz0, lx1, ry, lz0, C.woodDark); g.box(lx0, ry, zf - 1, lx1, ry, zf - 1, C.woodDark);
    for (let x = lx0; x <= lx1; x += 2) g.box(x, ry + 1, lz0 - 1, x, ry + 1, zf - 1, C.wood);
    for (let x = lx0 + 1; x <= lx1; x += 4) g.box(x, ry + 2, lz0, x + 1, ry + 2, zf - 2, C.bush);
    g.box(lx0, ry + 1, lz0 - 1, lx0, ry + 3, lz0 + 1, C.leafMid); g.box(lx1, ry + 1, lz0 - 1, lx1, ry + 3, lz0 + 1, C.leafMid);
    if (o.text) {
      // (w4) a leafy-green board on the pergola beams, white letters 1 proud
      const TW = o.text.length * 6 - 1, bx0 = o.xc - (TW >> 1) - 2, bx1 = o.xc + (TW >> 1) + 2, bz = lz0 + 1;
      g.box(bx0, ry + 3, bz, bx1, ry + 11, bz + 1, o.fascia != null ? o.fascia : C.roofGreen);
      g.box(bx0, ry + 11, bz, bx1, ry + 11, bz + 1, C.woodDark);
      text5(facade(g, 'front', bz), o.xc, ry + 4, o.text, o.textC != null ? o.textC : C.signWhite, 1, 1);
    }
  } else {
    g.box(lx0, ry, lz0, lx1, ry + 1, zf - 1, frame);
    if (kind === 'glass') {
      g.box(lx0 + 1, ry + 2, lz0 + 1, lx1 - 1, ry + 2, zf - 1, o.glassTop != null ? o.glassTop : C.dtCopper);
      g.walls(lx0, ry + 2, lz0, lx1, ry + 2, zf - 1, frame);
    }
    g.box(lx0, ry, lz0 - 1, lx1, ry + 2, lz0 - 1, fascia);            // fascia front edge
    if (o.text && o.sign === 'letters') {
      // (w4) the ref05 HOTEL sign: a framed board standing on the canopy,
      // letters 1 proud in a lit colour. Free-standing 2-deep letters read as
      // a jumble of yellow blocks at game zoom (MEDIA / ARTS / ORBIT).
      const tc = o.textC != null ? o.textC : C.signWhite, bg = o.boardC != null ? o.boardC : C.black;
      const rim = o.rimC != null ? o.rimC : tc;
      const TW = o.text.length * 6 - 1, bx0 = o.xc - (TW >> 1) - 2, bx1 = o.xc + (TW >> 1) + 2;
      const bz = lz0 + 1, by0 = ry + 2, by1 = ry + 10;
      g.box(bx0, by0, bz, bx1, by1, bz + 1, bg);
      g.box(bx0, by0, bz, bx1, by0, bz, rim); g.box(bx0, by1, bz, bx1, by1, bz, rim);
      g.box(bx0, by0, bz, bx0, by1, bz, rim); g.box(bx1, by0, bz, bx1, by1, bz, rim);
      text5(facade(g, 'front', bz), o.xc, by0 + 1, o.text, tc, 1, 1);
      for (const x of [bx0 + 2, bx1 - 2]) g.box(x, ry + 2, bz + 2, x, by0 + 3, bz + 2, C.metalDark);
      void by1;
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
  const gt = streetPodium(g, P, Y, { ground: 'arcade', colC: [C.dtLime, C.cream, C.dtFrame][sk], wall: pw0, pier: pp0, fascia: pf0, skipF: [8, 22], seed: v }) - 2, st = gt + 2 + FL * nf;
  shell(g, B, gt + 2, st, wall, C.roofGray);
  const tName = pk(rng, ['LAW', 'CITY', 'POST']);
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'temple', colC: pp0, stone: C.dtLimeShade, roofC: trim, text: tName, textC: C.dtNavyPanel });
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
  // (w4r10) the roof billboard is gone (critic w4r9: billboards on every roof;
  // HOTEL is the one tower that keeps a roof sign). The water tank is this
  // id's own rooftop mark (the old walk-up office), with the brick highrise.
  pk(rng, [0, 1, 2]); pk(rng, [0, 1, 2]);   // keep the rng stream (lot props) as before
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
  const wall = [C.dtLimeShade, C.dtTerra, C.dtGlassTeal][v % 3];   // (w4r10) v1 terracotta piers, not blue-on-blue (w4r9: every tower the same blue glass)   // w10: a teal-clad tower (brief: brick / terracotta / teal / dark glass)   // r9: warmer shafts (critic r8: monochrome blue/grey)
  const nf = 4 + v;   // (w4r12) one storey off the repeated middle (critic w4r11)
  const g = grid(31, 192, 31, R);
  const Y = lotPlinth(g, 0, 0, 30, 30);
  const B = box(6, 10, 25, 28), P = box(2, 8, 28, 29);
  // (r9) modern street podium (glass ribbon upper storey) + glass portico
  const [pw0, pp0, pf0] = [POD.terra, POD.teal, POD.slate][v % 3]();
  const bt = streetPodium(g, P, Y, { ground: 'glass', wall: pw0, pier: pp0, fascia: pf0, style: 'modern', glass: glass[1], skipF: [8, 22], seed: 3 + v }) - 1, top = bt + 1 + FL * nf;
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'glass', colC: C.dtFrame, glassTop: C.dtGlassTeal, fascia: pf0, sign: 'letters', textC: C.yellow, text: ['MEDIA', 'CORP', 'INFO'][v % 3] });
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
  const nf = 4 + v;   // (w4r12) one storey off the repeated middle (critic w4r11)
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
  const stages = [[box(5, 10, 25, 28), Y + 62 + v * 4], [box(8, 13, 22, 25), Y + 86 + v * 4], [box(10, 15, 20, 23), Y + 102 + v * 4]];
  // (r9) street podium in a contrasting material under stage one
  const [pw0, pp0, pf0] = [POD.teal, POD.brick, POD.deepBrick][v % 3]();
  const P = box(3, 8, 27, 29);
  let y0 = streetPodium(g, P, Y, { ground: 'arcade', wall: pw0, pier: C.gold === pp0 ? C.cream : pp0, fascia: pf0, skipF: [8, 22], seed: 1 + v, cornC: C.gold });
  for (let i = 0; i < stages.length; i++) {
    const [B, yt] = stages[i];
    shell(g, B, y0, yt, stone, stone);
    const start = y0 + 2;
    // (w4) glass fills the bay under a gold head (inset 1 left 3-wide slits
    // that read as blank dark slots in game)
    // (w4r5) stage 1: a fine grid of cream-framed paired windows (critic w4r4:
    // "double the window density, frame each window"); the upper stages keep
    // the wide gold-headed bays so the rhythm changes up the tower
    if (i === 0) gridBays(g, B, 'fblr', { y0: start, y1: yt - 5, floor: 10, ww: 2, wh: 6, sill: 2, gap: -1, per: 2, pw: 1, cw: 3, pd: 1, cpd: 2, recess: 0,
      pierC: stone, frameC: C.cream, glassFn: () => C.dtGlassDeep, sillC: stone, bandEvery: 3, bandC: stone, capC: C.gold, bandH: 1 });
    else framedBays(g, B, 'fblr', { y0: start, y1: yt - 5, floor: 10, sill: 2, wh: 7, bw: 5, pw: 1, cw: 2, pd: 1, cpd: 2, sillOut: 1, pierC: stone, spand: panel, deep: false, ledgeC: stone, ledgeOut: 1,
      inset: 0, jambs: false, frameC: C.gold, sillC: stone, glassFn: skyGlass(SKY, 10), sheen: C.dtGlassHi, hi: C.win, bandEvery: i === 0 ? 3 : 0, bandC: stone,
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
  portico(g, P.z0, { Y, xc: 15, w: 9, depth: 5, kind: 'marquee', colC: C.gold, frame: C.gold, fascia: C.black, text: 'DECO', textC: C.yellow, mat: C.navy });
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
  // (w4r10) critic w4r9: every tower was the same blue glass. The Green Tower
  // is GREEN glass in every variant (its own material family downtown)
  const glass = pk(rng, [[C.dtGlassGreen, C.dtGlassGreen, C.dtGlassHi], [C.dtGlassGreen, C.dtGlassTeal, C.dtGlassHi], [C.dtPad, C.dtGlassGreen, C.dtGlassHi]]);
  const nf = 4 + v;   // (w4r12) one storey off the repeated middle (critic w4r11)
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
  // (w4r10) critic w4r9: "the same lime cube planters + pergola on every
  // roof" (this id repeats in the dense demo downtown). One roof per variant:
  // v0 trees + pergola, v1 a solar array + a little wind turbine, v2 a glass
  // greenhouse with planting inside.
  if (v % 3 === 0) {
    tree(g, 9, top + 1, 13, 6); tree(g, 19, top + 1, 21, 6);
    planter(g, 8, 20, 13, 24, top + 1, { box: C.dtFrame, flowers: [C.pink, C.yellow, C.signWhite] });
    for (const [x, z] of [[15, 12], [21, 12], [15, 17], [21, 17]]) g.box(x, top + 1, z, x, top + 7, z, C.wood);
    for (let x = 15; x <= 21; x += 2) g.box(x, top + 8, 12, x, top + 8, 17, C.wood);
    g.box(15, top + 9, 12, 21, top + 9, 12, C.wood); g.box(15, top + 9, 17, 21, top + 9, 17, C.wood);
  } else if (v % 3 === 1) {
    for (const z0 of [12, 17, 22]) { g.box(8, top + 1, z0, 20, top + 1, z0 + 3, C.metalDark); solarPanel(g, 8, z0, 20, z0 + 3, top + 2); }
    const tx = 22, tz = 24;
    for (let y = top + 1; y < top + 16; y++) g.set(tx, y, tz, C.dtFrame);
    g.box(tx - 1, top + 15, tz - 1, tx + 1, top + 16, tz, C.dtFrame);
    for (let k = 1; k <= 5; k++) { g.set(tx, top + 16 + k, tz - 1, C.signWhite); g.set(tx - k, top + 16 - (k >> 1), tz - 1, C.signWhite); g.set(tx + k, top + 16 - (k >> 1), tz - 1, C.signWhite); }
  } else {
    const Gh = box(9, 13, 21, 24);
    g.box(Gh.x0, top + 1, Gh.z0, Gh.x1, top + 1, Gh.z1, C.dtFrame);
    g.walls(Gh.x0, top + 2, Gh.z0, Gh.x1, top + 6, Gh.z1, C.dtGlassHi);
    for (let x = Gh.x0; x <= Gh.x1; x += 3) { g.box(x, top + 2, Gh.z0, x, top + 6, Gh.z0, C.dtFrame); g.box(x, top + 2, Gh.z1, x, top + 6, Gh.z1, C.dtFrame); }
    for (let k = 0; k < 3; k++) g.box(Gh.x0 + k, top + 7 + k, Gh.z0 + k, Gh.x1 - k, top + 7 + k, Gh.z1 - k, k === 2 ? C.dtFrame : C.dtGlassHi);
    g.box(Gh.x0 + 1, top + 2, Gh.z0 + 1, Gh.x1 - 1, top + 3, Gh.z1 - 1, C.leafMid);
    planter(g, 7, 25, 12, 27, top + 1, { box: C.dtFrame, flowers: [C.pink, C.yellow, C.signWhite] });
  }
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
  const nf = 5 + v;   // (w4r12) one storey off the repeated middle (critic w4r11)
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
  // (w4) discrete windows: a mullion every ~4 voxels of arc and a white head
  // frame, so the drum reads as framed windows per floor, not glass stripes
  disc(10, y0, top, (e, y, x, z) => {
    if (!e) return y === top ? C.roofGray : null;
    const k = (y - y0) % FL, s = (Math.atan2(z, x) + Math.PI) * 10.5;
    if (k < 3) return slabC;
    if (s % 4.1 < 1.05) return slabC;
    if (k === FL - 1) return C.dtFrame === slabC ? C.dtNavyPanel : C.dtFrame;
    return k >= FL - 3 ? C.winCool : glass;
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
  // (w4r10) no water tank (w4r9: the same tank on every roof) - condensers
  acBox(g, 17, ct, 21, { w: 5, d: 4, h: 3 }); acBox(g, 17, ct, 26, { w: 5, d: 3, h: 4 });
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
  const gt = streetPodium(g, Pd, Y, { ground: v % 2 ? 'glass' : 'colonnade', wall: pw0, pier: pp0, fascia: pf0, style: v % 2 ? 'modern' : 'arch', skipF: [38, 54], seed: 6 + v }) - 1, top = gt + FL * nf, wt = top - FL * 2;
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
  portico(g, Pd.z0, { Y, xc: 46, w: 9, depth: 6, kind: 'slab', cols: 4, fascia: band, colC: pp0 === C.dtFrame ? C.dtFrame : C.cream, stone: C.dtLimeShade, roofC: band, sign: 'letters', text: 'PLAZA', textC: C.yellow });
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
  // (w4r12) critic w4r11: "tall stacks of identical window-band floors, the
  // shaft nearly all of the height". The slab is 3-4 framed storeys under a
  // main cornice, then a glass ATTIC storey set back 3 behind a railed
  // terrace (a change of material at the top), then the roof kit.
  const nf = 3 + v, yF = pt + 2 + FL * nf;
  shell(g, O, pt + 1, yF, slabC, C.roofGray);
  framedBays(g, O, 'fblr', { y0: pt + 1, y1: yF - 1, bw: 7, pw: 2, cw: 3, pd: 1, cpd: 2, pierC: slabC, spand: spand, frameC: C.dtFrame, sillC: null, sill: 2, wh: 8, deep: false,
    ledgeC: C.dtFrame, ledgeOut: 1,
    glassFn: skyGlass([C.dtGlass, glass, C.dtGlassHi], nf, 6), sheen: C.dtGlassHi, hi: C.winCool, bandEvery: 3, bandC: slabC, bandOut: 2,
    balc: (S, k, r) => S.s === 'f' && r % 2 === 1 && k % 2 === 0, balcC: C.dtFrame, ac: (S, k, r) => S.s !== 'f' && ((k * 3 + r * 5) % 6) === 2 });
  for (const x0 of [O.x0, O.x1 - 6]) notch(g, O, box(x0, O.z0, x0 + 6, O.z0 + 4), pt + 1, yF - 1, { floor: FL, back: C.dtGlass, slab: C.dtFrame, plants: true });
  dentils(g, O, yF, C.dtFrame);
  const cy = roofCornice(g, O, yF + 1, slabC, spand, 2, 0);
  railing(g, O.x0 - 2, O.z0 - 2, O.x1 + 2, O.z1 + 2, cy, C.metal);
  const Oc = box(O.x0 + 3, O.z0 + 3, O.x1 - 3, O.z1 - 3), top = cy + FL;
  shell(g, Oc, cy - 1, top, C.dtFrame, C.roofGray);
  curtain(g, Oc, 'fblr', { y0: cy, y1: top - 1, cw: 2, cornerC: slabC, cornerOut: 1, pitch: 5, mullC: C.dtFrame, transC: C.dtFrame, seed: 2 + v });
  for (const [x0, x1] of [[O.x0, Oc.x0 - 2], [Oc.x1 + 2, O.x1]]) planter(g, x0, O.z0, x1, O.z0 + 1, cy, { box: C.dtFrame });
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
  const ct = roofCornice(g, Oc, top + 1, slabC, spand, 2, 0);
  parapetOn(g, Oc, ct, 1, slabC, null);
  roofCrowd(g, Oc.x0 + 1, Oc.z0 + 1, 36, Oc.z1 - 1, ct, rng, { ac: 3, vents: 2 });
  penthouse(g, 40, ct, Oc.z0 + 1, 48, Oc.z1 - 1, 7, C.dtFrame, C.roofGray, C.metalDark);
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
const SKYWALL = [C.dtGlassDark, C.dtGlassDark];
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
  // (w4) ref05's glass is a dark petrol blue with pale reflections, not the
  // royal blue the old dtGlass panes rendered (measured ref ~(48,80,96) vs
  // ours (64,128,240)): deep panes, bright streaks, silver mullion pilasters
  const [fin, spandG, tones, pierS] = [[C.dtGlassDeep, C.dtGlassDark, [C.dtGlassDeep, C.dtGlass, C.dtGlassHi], C.dtStone],
    [C.dtGlassTeal, C.dtGlassTeal, [C.dtGlassDeep, C.dtGlassTeal, C.dtGlassHi], C.dtGlassTeal]][v % 2];
  const wall = C.dtFrame;
  const g = grid(63, 256, 63, R);
  // (w4r6) the ref05 HOTEL lot: warm sand paving, the tower on a ~1-tile
  // footprint set back so a deep forecourt with lawns, hedges and the
  // canopied entry opens in front (critics w4r3-r5: "fills its lot to the kerb")
  const Y = plazaLot(g);
  // (w4r7) critic w4r6: "a separate, heavily detailed base … a brick podium,
  // a setback base, deep cornices". The podium is 5-6 voxels wider than the
  // shaft on every side, in deep BRICK (v1 terracotta) with a giant order of
  // cream columns before dark glass, a stepped cornice and a planted roof
  // terrace — no longer the same cream/white as the shaft's frames.
  const P = box(9, 22, 53, 60);
  const [pw0, pp0, pf0] = [POD.brick, POD.terra][v % 2]();
  const pt = streetPodium(g, P, Y, { ground: 'colonnade', wall: pw0, colC: pp0, cornerC: pw0, pier: pp0, fascia: pf0, skipF: [22, 40], seed: v, h: 40 }) - 1;
  portico(g, P.z0, { Y, xc: 31, w: 15, depth: 7, kind: 'glass', cols: 4, colC: C.dtFrame, glassTop: C.dtGlassTeal, fascia: C.dtNavyPanel, sign: 'letters', text: 'SKY', textC: C.yellow, planters: false });
  // shaft
  // (w4r12) critic w4r11: "the shaft is nearly all of each building's
  // height … shorten the repeated middle, a bolder base, a clear crown, a
  // change of material part-way up". SKY is now THREE parts, like the ref05
  // hotel: the tall brick base (above), a SHORT stone-and-glass shaft of
  // three framed storeys under a cornice, then a SETBACK TERRACE (hedges,
  // trees, railing) and a 2-3 storey all-glass CROWN set back 4 on every
  // side, capped by its own cornice and the helipad. The teal glass spine
  // runs through the setback and ties base to crown.
  const T = box(15, 27, 47, 57), nS = 3, nC = 2 + v;
  const y0 = pt + 1, yS = y0 + FL * nS, tt = yS + 4;
  shell(g, T, y0, tt - 1, pierS, C.roofGray);
  const gg = { y0, y1: yS - 1, ww: 3, wh: 8, sill: 2, gap: -1, recess: 1, frameOut: 0, pw: 1, pd: 2, cpd: 2, wallC: SKYWALL[v % 2], pierC: pierS, cornerC: fin, frameC: C.dtStone,
    hoodC: wall, hoodOut: 2, lugC: pierS, lugOut: 1,
    // (w4r8) critics w4r5-r7 all: "flat grids, no depth". Pilasters 2 proud and
    // the per-floor ledge kept inside the bays (ledgeIn): unbroken vertical
    // ribs over recessed window strips, like the ref05 bank's order
    glassFn: glint(v % 2 ? C.dtGlassTeal : C.dtGlass, C.dtGlassHi, 7, v), bandEvery: 4, bandC: wall, capC: wall, bandH: 2 };
  gridBays(g, T, 'fb', { ...gg, y1: yS - 1, per: 2, cw: 2 }); gridBays(g, T, 'lr', { ...gg, y1: yS - 1, per: 2, cw: 1 });
  // shaft top: a frieze row, dentils, a 3-out stepped cornice, then a parapet
  // + planted terrace round the crown (the podium terrace kit, one size up)
  const Tc = ins(T, 4), top = tt + FL * nC;
  g.walls(T.x0, tt, T.z0, T.x1, tt, T.z1, pierS);
  g.walls(T.x0, tt + 1, T.z0, T.x1, tt + 1, T.z1, wall);
  podiumTerrace(g, T, Tc, tt, rng, { trim: wall, cornC: C.dtNavyPanel });
  // the CROWN: a different material - one bright cyan curtain wall (white
  // mullions, near-white glints) between slim corner piers in the fin colour
  shell(g, Tc, tt - 1, top, wall, C.roofGray);
  curtain(g, Tc, 'fblr', { y0: tt, y1: top - 1, cw: 2, cornerC: fin, cornerOut: 1, pitch: 6, mullC: wall, transC: wall, seed: 3 + v });
  // the teal glass spine: 3 proud of the shaft, 7 proud of the crown, rising
  // past the roof (the ref05 hospital's glass stair core)
  for (const [za, zb, w] of [[T.z0 - 3, Tc.z0, 'flr'], [Tc.z1, T.z1 + 3, 'blr']]) {
    const Sp = box(27, za, 35, zb);
    shell(g, Sp, y0 - 2, top + 5, wall, C.roofGray);
    ribbons(g, Sp, w, { y0, y1: top + 3, floor: FL, sill: 1, wh: 10, d: 1, cw: 1, pitch: 3,
      glassFn: skyGlass(v % 2 ? [C.dtGlass, C.dtGlass, C.dtGlassHi] : [C.dtGlassTeal, C.dtGlassTeal, C.dtGlassHi], nS + nC + 1), hiRows: 1, mullC: wall });
    course(g, Sp, top + 5, C.dtNavyPanel, 1, 1, 0);
  }
  // crown cap: a navy frieze + a deep 4-out white cornice, a railed deck,
  // then SKY's own landmark: a glass drum carrying an overhanging HELIPAD
  // (dark deck, yellow ring, white H, lamps) and a mast + beacon
  course(g, Tc, top, C.dtNavyPanel, 1, 2, 0);
  const ct = cornice(g, Tc, top + 2, wall, C.dtNavyPanel, 4, 0);
  deck(g, ins(Tc, -4), ct - 1);
  railing(g, Tc.x0 - 3, Tc.z0 - 3, Tc.x1 + 3, Tc.z1 + 3, ct, C.metal);
  const K = ins(Tc, 5), kt = ct + 9;
  shell(g, K, ct, kt, wall, C.roofGray);
  ribbons(g, K, 'fblr', { y0: ct, y1: kt - 1, floor: 9, sill: 1, wh: 7, d: 1, cw: 1, pitch: 3, glass: v % 2 ? C.dtGlassTeal : C.dtGlass, hiRows: 1, mullC: wall });
  const Hp = ins(K, -3);
  g.box(Hp.x0, kt, Hp.z0, Hp.x1, kt, Hp.z1, wall);
  ring(g, Hp, kt, C.dtNavyPanel, 1, 1);
  helipad(g, Hp.x0, Hp.z0, Hp.x1, Hp.z1, kt + 1);
  for (let z = Hp.z0 + 2; z <= Hp.z1 - 2; z += 4) { g.set(Hp.x0 - 1, kt - 1, z, C.lamp); g.set(Hp.x1 + 1, kt - 1, z, C.lamp); }
  mast(g, Tc.x1 - 1, Tc.z1 - 1, ct, 22, C.red);
  for (const [x, z] of [[Tc.x0 + 1, Tc.z0 + 1], [Tc.x1 - 4, Tc.z0 + 1]]) acBox(g, x, ct, z, { w: 3, d: 3, h: 3 });
  // podium roof terrace (w4r7: the podium is a setback base again)
  podiumTerrace(g, P, T, pt + 1, rng, { trim: pp0 });
  // lot: plaza trees + benches, taxis at the kerb, parking lanes on 3 sides
  // (w4r2) a designed forecourt + planted plaza strips (no car lay-by)
  hotelLot(g, P, rng, { xc: 31, hw: 5, fz: P.z0 - 7 - 5 });
  people(g, 24, 2, 38, P.z0 - 12, Y, 6, rng);
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
  // (w4r6) a ~1-tile tower set back on a light stone plaza (the ref05 bank
  // lot): lawns, hedges and the marquee entry in front, not a kerb-to-kerb mass
  const Y = plazaLot(g, C.lotPave, C.lotPaveDark);
  // (w4r12) critic w4r11: "the shaft is nearly all of each building's
  // height". Stages cut from 5.5 / 2.7 / 2.7 storeys to 4 / 2 / 2 (and the
  // crown gets its own material: see the stage loop)
  // (w4r14) critics w4r11 + w4r13 (towers fill the frame, lots don't read;
  // ref05 hotel ~115 voxels): stages 3 / 2 / 2 storeys -> 2 / 2 / 2 storeys,
  // body 154 -> ~133
  const stages = [[box(15, 27, 47, 57), Y + 74], [box(19, 31, 43, 53), Y + 98 + v * 6], [box(23, 35, 39, 49), Y + 122 + v * 6]];
  // (r9) an art-deco street podium: cream (v1 limestone) with gold trim,
  // arched windows, black fascia with shop boards, a gold-framed portico
  // (w4r7) critic w4r6: "a separate, heavily detailed base … a setback base".
  // The podium stands 5-6 wider than stage 1 all round, in TERRACOTTA (v1
  // brick) with cream quoins and trim, a shop storey under a black fascia,
  // arched windows above, a stepped cornice and a planted roof terrace.
  const P = box(9, 22, 53, 60);
  // (SKY beside it is brick: ONYX v0 is warm SANDSTONE with white trim and a
  // gold cornice lip, v1 terracotta)
  const [ow, ot] = v % 2 ? [C.dtTerra, C.cream] : [C.dtLimeShade, C.dtFrame];
  let y0 = streetPodium(g, P, Y, { ground: 'shop', wall: ow, pier: ot, fascia: C.black, skipF: [22, 40], seed: 2 + v, cornC: C.gold, h: 40 });
  podiumTerrace(g, P, stages[0][0], y0, rng, { trim: ot, cornC: C.gold });
  for (let i = 0; i < stages.length; i++) {
    const [B, yt] = stages[i];
    shell(g, B, y0, yt, C.dtPad, C.roofGray);
    const ya = y0 + 2, n = Math.max(1, Math.floor((yt - 6 - ya) / FL));
    // dark piers standing proud of recessed glass bays, a champagne band every 3 storeys
    // (r8) critic r7: "the charcoal ONYX tower reads as a nearly black mass
    // … the dark side has no colour". Slate-blue piers (dtPad lightened) 1
    // proud, champagne ledge on every floor, bright glass framed in champagne.
    // (w4r4) stage 1: tall 3-storey glass bays between jade pilasters, a gold
    // band every 3 storeys (critic w4r1: "ONYX repeats one fin-and-window
    // module floor after floor"); the upper stages keep framed windows
    // (w4r5) critic w4r4: "the green deco tower's mid-shaft reads as big flat
    // slabs of colour with a few chunky dark windows". Every stage is now a
    // fine grid of cream-framed windows in pairs between jade pilasters, a
    // jade sill ledge on every floor, a gold-capped band every 3 storeys.
    // (w4r9) jade surrounds (1 proud) with a cream hood 2 proud + lug sill per
    // window instead of a cream frame ring + ledge (critic w4r8: pale grid)
    // (w4r11) the top stage is a CROWN BAND of curtain glass on gold
    // mullions (critic w4r10: zone the grid into base / shaft / crown)
    if (i === 2) curtain(g, B, 'fblr', { y0: ya, y1: yt - 6, cw: 2, cornerC: C.dtPad, cornerOut: 2, pitch: 5, mullC: fin, transC: fin, seed: 1 + v });
    // (w4r12) a CHANGE OF MATERIAL part-way up (critic w4r11): stage 2 is
    // warm cream ribbon glazing (cream spandrels, gold mullions) between jade
    // corner piers - the jade framed grid below, the glass crown above
    else if (i === 1) curtain(g, B, 'fblr', { y0: ya, y1: yt - 6, cw: 3, cornerC: C.dtPad, cornerOut: 2, pitch: 4, mullC: fin, transC: C.cream, spandC: C.cream, spandH: 4, seed: 5 + v });
    else if (i < 3) gridBays(g, B, 'fblr', { y0: ya, y1: yt - 6, ww: i === 0 ? 3 : 2, wh: 8, sill: 2, gap: -1, recess: 1, frameOut: 0, per: 2, pw: 1, cw: 1, pd: 2, cpd: 3, pierC: C.dtPad, frameC: C.dtPad,
      hoodC: C.cream, hoodOut: 2, lugC: C.cream, lugOut: 1,
      glassFn: glint(C.dtGlass, C.dtGlassHi, 6, i), bandEvery: 3, bandC: C.dtPad, capC: fin, bandH: 2 });
    else framedBays(g, B, 'fblr', { y0: ya, y1: yt - 6, bw: [7, 6, 5][i], pw: 2, cw: 3, pd: 1, cpd: 2, pierC: C.dtPad, spand: C.dtGlassDeep, frameC: fin, sillC: null, deep: false, inset: 0, jambs: false,
      sill: 2, wh: 8, glassFn: skyGlass([C.dtGlassDeep, C.dtGlass, C.dtGlassHi], n, 7), sheen: C.dtGlassHi, hi: C.winCool, bandEvery: 3, bandC: fin, bandOut: 2,
      // (w4r2) critic w4r1: "the gold trim on the green tower reads as noisy
      // stripes". The per-floor ledge is jade (a shadow line, not a stripe);
      // gold stays on the window heads and the bold band every 3 storeys.
      ledgeC: C.dtPad, ledgeOut: 1,
      balc: i === 1 ? (S, k, r) => r % 2 === 0 : null, balcC: fin, railC: C.dtGlassHi });
    // (w4r7) a balcony floor half way up stage 1 (jade slab, glass rail)
    if (i === 0 && n >= 4) balconyFloor(g, B, ya + 2 * FL + 1, C.dtPad, { rail: fin });
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
  portico(g, P.z0, { Y, xc: 31, w: 11, depth: 6, kind: 'marquee', cols: 4, colC: C.gold, frame: C.gold, fascia: C.black, text: 'ONYX', textC: C.yellow, mat: C.navy, planters: false });
  // crown: roof kit on the last setback, neon lantern + spire
  const top = y0, Bt = stages[2][0];
  const L = ins(Bt, 3);
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
  for (let y = top + 16; y < top + 40; y++) g.set(31, y, 42, y > top + 32 ? C.metal : fin);
  g.set(31, top + 40, 42, C.red);
  const Bm = stages[1][0];
  roofCrowd(g, B0.x0 + 1, B0.z0 + 1, B0.x1 - 1, Bm.z0 - 2, stages[0][1] + 1, rng, { ac: 3, vents: 1 });
  roofCrowd(g, B0.x0 + 1, Bm.z1 + 2, B0.x1 - 1, B0.z1 - 1, stages[0][1] + 1, rng, { ac: 3, vents: 1 });
  // lot: dark granite plaza, two reflecting pools flanking the steps, flags
  hotelLot(g, P, rng, { xc: 31, hw: 4, fz: P.z0 - 6 - 5, flags: [C.red, C.blue] });
  people(g, 24, 2, 38, P.z0 - 11, Y, 6, rng);
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
  // (w4r9) critics w4r7 + w4r8: BLOX "flat ... pale, low-contrast glass". The
  // ref05 hospital is WHITE with SATURATED blue glass bands: the ribbons are
  // now deep glass painted with the pane ramp (dark foot, lit teal, streak)
  // (w4r14) v0 glass was dtGlassDeep throughout: the "blue-grey slab behind
  // BANK" (w4r12). Pane bodies are now teal/blue (coordinator 02:50)
  const band = [[C.dtGlassTeal, C.dtGlass, C.dtGlassHi], [C.dtGlass, C.dtGlass, C.dtGlassHi]][v % 2];
  const g = grid(63, 256, 63, R);
  const Y = lotPlinth(g, 0, 0, 62, 62);
  const nf = 7 + v;   // (w4r14) one storey off (w4r13: towers fill the frame)
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
  // (w4r13) critics w4r10-w4r12: "the blue-grey slab behind BANK repeats one
  // identical window grid for 10+ floors … split each shaft into base,
  // middle and crown, change the bay rhythm, add recessed glass bands". BLOX
  // is now: glass podium / THREE banded storeys (glass ribbons behind proud
  // white slabs, teal-faced fins) / a recessed sky-garden LOGGIA storey / a
  // PUNCHED upper shaft (paired framed windows under white hoods between
  // pilasters — the ref05 hospital) / the all-glass crown storey.
  const gl = skyGlass(band, nf, 8), yA = fTop + 2 + 2 * FL, yU = fTop + 2 + 3 * FL;   // (w4r14) two banded storeys
  ribbons(g, T, 'fblr', { y0: fTop + 2, y1: yA - 1, floor: FL, sill: 3, wh: 8, d: 1, cw: 3, pitch: 5, glassFn: gl, hi: C.winCool, hiRows: 1, mullC: slab });
  // (r7) slabs stand 2 proud: each casts a real shadow line over the ribbon below
  for (let y = fTop + 2 + FL; y < yA; y += FL) course(g, T, y, slab, 2, 1, 0);
  // (w4r8) two white fins per face stand 3 proud through the slabs (egg-crate)
  for (const S of sides(g, T)) {
    const span = S.u1 - S.u0;
    for (const t of [1 / 3, 2 / 3]) { const u = S.u0 + Math.round(span * t); S.f.box(u - 1, fTop + 2, 1, u, yA - 1, 3, pier); S.f.box(u - 1, fTop + 2, 3, u, yA - 1, 3, C.dtGlassTeal); }   // (w4r9) teal-glass fin faces
  }
  if (tTop - FL - 1 > yU + 10) gridBays(g, T, 'fblr', { y0: yU, y1: tTop - FL - 1, ww: 2, wh: 9, sill: 2, gap: -1, recess: 0, frameOut: 0, per: 3, pw: 1, cw: 3, pd: 1, cpd: 0,
    wallC: slab, pierC: pier, frameC: C.dtStone, hoodC: slab, hoodOut: 2, lugC: C.dtStone, lugOut: 1, glassFn: glint(band[0], C.dtGlassHi, 7, v) });
  for (const S of sides(g, T)) {
    S.f.box(S.u0 - 2, fTop + 2, 1, S.u0 + 2, tTop, 2, pier);
    S.f.box(S.u1 - 2, fTop + 2, 1, S.u1 + 2, tTop, 2, pier);
  }
  // (w4r11) the crown storey is a curtain band (bright cyan + glints, critic w4r10)
  curtain(g, T, 'fblr', { y0: tTop - FL, y1: tTop - 1, cw: 3, pitch: 5, mullC: slab, transC: slab, transOut: 0, seed: 4 + v });
  // wing top: cornice + crowded roof with cooling towers
  course(g, Wl, wTop, pier, 1, 2, 0);
  parapetOn(g, Wl, wTop + 2, 1, slab, null);
  mechCrown(g, Wl.x0 + 1, Wl.z0 + 1, Wl.x1 - 1, Wl.z1 - 1, wTop + 1, rng, { rail: false, plant: false, cool: 2, ac: 2, vents: 2 });
  // r7: a sky garden five storeys up splits the banded shaft
  { const ys = yA + 1; skyGarden(g, T, ys, ys + FL - 4, { col: pier, glass: C.dtGlassDeep, trim: C.dtNavyPanel }); }   // (w4r13) storey 4: the break between the banded and punched zones
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
  // (w4r10) no roof sign box (w4r8: "crude blocky banners"); BLOX is on the canopy
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
  plazaStrip(g, 1, 1, 35, 5, rng, { bed: 7, gap: 6 });                  // w4r2: planted strip, not a lay-by
  people(g, 2, 6, 46, 12, Y, 10, rng);
  g.box(49, 1, 2, 61, 1, 61, C.lotAsphalt);
  parkCol(g, 4, 60, 50, 11, rng, 0.7);
  plazaStrip(g, 1, 15, 5, 61, rng); hedge(g, 7, Y, 59, 46, 60, 3);
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
  const Y = plazaLot(g);                 // (w4r4) beige plaza lot
  // (r9) a cream-stone street podium with an arcade of arched windows, a
  // black shop fascia, and a temple portico (4 columns, TWINS on the
  // entablature, a copper pediment) — the ref05 bank's front
  // (w4r6) set back 7: a lawned forecourt in front of the arch (critics
  // w4r3-r5: the towers filled their lots to the kerb)
  const P = box(7, 21, 55, 60);
  const pt = streetPodium(g, P, Y, { h: 34, ground: 'arcade', wall: stone, pier: C.gold, fascia: C.black, skipF: [18, 44], seed: 1 + v, cornC: stone }) - 1;
  portico(g, P.z0, { Y, xc: 31, w: 13, depth: 5, kind: 'arch', w: 15, colC: stone, frame: C.gold, stone: C.dtLimeShade, text: 'TWINS', textC: C.gold, mat: C.brickDark, planters: false });
  const top = pt + 76 + v * 8;   // (w4r12) one storey off tier 1 (critic w4r11: shorten the repeated middle); (w4r14) one more (w4r13: towers fill the frame)
  for (const [x0, x1] of [[7, 28], [34, 55]]) {
    const T1 = box(x0, 23, x1, 57), T2 = ins(T1, 3), T3 = ins(T2, 3);
    const y1 = top - 40, y2 = top - 16;
    // tier 1: brick, cream quoin piers, brick pilasters 1 proud of brick bays
    // (2-deep reveals), cream band every 3 storeys, a deep loggia stack down
    // the middle of each long side (shadowed balcony void)
    shell(g, T1, pt + 1, y1, brick, C.roofGray);
    // (r7) the windows fill the bay (5 wide × 7 tall, 2 back behind a white
    // head): the r6 shaft read as flat red pilasters with thin dark slits
    // (w4r4) critic w4r3: "TWINS … uniform grids of small dark recessed
    // windows; group them into 2-3 storey bays framed by pilasters". Brick
    // pilasters 2 proud frame tall 3-storey glass bays; a cream band + cap
    // ties them every 3 storeys (Chicago-school brick + glass)
    // (w4r5) critic w4r4: "double the window density, frame each window, add
    // pilasters or banding". The ref05 hotel shaft: brick walls, cream
    // pilasters between PAIRS of white-framed windows, a stone sill under every
    // window, a stone band every 3 storeys.
    // (w4r8) critics w4r5-r7: "flat, evenly repeating window grids with almost
    // no depth … push the bays in behind thicker pilasters". The ref05 hotel:
    // CREAM pilasters standing 2 proud of RED brick bays (the shadow band on
    // the dark face is the depth cue), windows with a reflection glint.
    gridBays(g, T1, 'fblr', { y0: pt + 2, y1: y1 - 5, floor: 10, ww: 3, wh: 6, sill: 2, gap: -1, per: 2, pw: 2, cw: 1, pd: 2, cpd: 2, pierC: stone, cornerC: stone, frameC: C.dtFrame, jambs: false, recess: 1,
      glassFn: glint(C.dtGlass, C.dtGlassHi, 5, 1 + v), bandEvery: 3, bandC: stone, capC: C.gold, bandH: 2 });
    for (const xa of [T1.x0, T1.x1 - 3]) notch(g, T1, box(xa, 37, xa + 3, 43), pt + 2, y1 - 5, { floor: 10, back: C.dtGlassDeep, slab: stone, rail: C.dtGlassHi, mull: stone });
    course(g, T1, y1 - 4, C.gold, 1, 1, 0);
    cornice(g, T1, y1 - 3, stone, brick, 2, 0);
    // tier 2: cream stone, brick spandrels, a checker of gold-railed balconies
    shell(g, T2, y1 + 1, y2, stone, C.roofGray);
    // (w4r13) critics w4r11 + w4r12: "TWINS repeat one window-and-pier grid
    // for 10+ floors" — the cream-over-brick balcony tier read as more of the
    // same shaft. Tier 2 is now a double-height recessed LOGGIA: cream columns
    // standing before shadowed glass, gold soffit, a planted lip — a clear
    // break between the brick shaft and the gold glass crown.
    skyGarden(g, T2, y1 + 2, y2 - 6, { col: stone, slab: stone, trim: C.gold, glass: C.dtGlassDeep, planter: stone, out: 0, d: 3 });
    course(g, T2, y2 - 4, C.gold, 1, 1, 0);
    cornice(g, T2, y2 - 3, stone, brick, 2, 0);
    // tier 3 (crown): cream with tall gold-framed windows, two storeys high
    shell(g, T3, y2 + 1, top, stone, C.roofGray);
    // (w4r11) critic w4r10: "TWINS glass = dark slots stamped on every floor;
    // zone it: base, shaft, crown band". The crown is now an all-glass
    // curtain cage (bright cyan, white glints) on gold mullions + transoms
    // between stone corner piers, over the brick shaft and the stone tier.
    curtain(g, T3, 'fblr', { y0: y2 + 2, y1: top - 3, cw: 2, cornerC: stone, cornerOut: 1, pitch: 5, mullC: C.gold, transC: C.gold, seed: x0 + v });
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
    // (w4r10) no water tank on the twins (w4r9: one tank on every roof)
    acBox(g, T3.x0 + 1, tc, T3.z0 + 12, { w: 4, d: 3, h: 3 }); acBox(g, T3.x1 - 4, tc, T3.z1 - 4, { w: 4, d: 3, h: 3 });
  }
  // skybridge
  const sy = pt + 20;   // (w4r14) inside tier 1 now that the shaft is shorter
  g.box(28, sy, 36, 34, sy + 9, 44, C.dtGlass);
  g.box(27, sy, 35, 35, sy, 45, stone); g.box(27, sy + 9, 35, 35, sy + 9, 45, stone);
  g.box(28, sy + 7, 36, 34, sy + 8, 44, C.win);
  // podium roof garden
  tree(g, 30, pt + 1, 24, 5); tree(g, 30, pt + 1, 56, 5);
  hedge(g, 29, pt + 1, 29, 33, 35, 2); hedge(g, 29, pt + 1, 47, 33, 52, 2);
  people(g, 29, pt + 1, 22, 34, 59, 3, rng);
  // lot: corner planters with trees, taxis at the kerb, parking lanes all round
  // (w4r2) a designed forecourt (fountains + planted beds) and planted plaza
  // sides instead of a car lay-by and parking lanes; parking only at the back
  // (w4r6) the ref05 hotel lot: lawns in hedge rims either side of the walk
  hotelLot(g, P, rng, { xc: 31, hw: 5, fz: P.z0 - 10 });
  people(g, 24, 2, 38, P.z0 - 10, Y, 6, rng);
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
  const Y = plazaLot(g);                 // (w4r4) beige plaza lot
  // the podium steps in from the lot edge so the ground floor can be dressed
  // all round (entrance plaza in front, parking lanes on 3 sides)
  // (w4r6) a ~1-tile tower set back on its lot, the porte-cochere drive and
  // lawns in front (critics w4r3-r5: towers filled their lots to the kerb)
  // (w4r7) critic w4r6: "a setback base": the podium is 6 wider than tier 1
  // on both sides (the cochère keeps the front), with a planted terrace
  const P = box(9, 24, 53, 60);
  // (r9) brick (v1 sandstone) street podium with an arcade + shop fascia and
  // a temple portico carrying SPIRE (critic r8: no real podium or entrance)
  const [pw0, pp0, pf0] = [POD.brick, POD.sand][v % 2]();
  // (w4r13) critics w4r10-w4r12: "SPIRE repeats one identical window-and-pier
  // grid for 10+ floors … split the shaft into base, middle and crown, change
  // the bay rhythm, add recessed glass bands and setback terraces". Tier 1 is
  // now THREE framed storeys topped by a double-height recessed LOGGIA (stone
  // columns before shadowed glass, a planted lip) under its cornice; tier 2 is
  // two storeys of ribbon glazing; tier 3 the glass crown cage. 18 voxels lower.
  // (w4r14) critics w4r11 + w4r13: "at ref05 scale the towers fill the whole
  // frame … the lots barely read". Measured, the ref05 hotel is ~115 fine
  // voxels tall on a 2x2 lot; SPIRE's body stood at 162. Tier 1 is now two
  // framed storeys + the loggia, tiers 2/3 a little shorter: body ~144 (it
  // stays the tallest landmark; the mast keeps its length).
  const st = [[box(15, 26, 47, 58), Y + 74], [box(19, 30, 43, 54), Y + 97 + v * 4], [box(22, 33, 40, 51), Y + 118 + v * 4]];
  const ptop = streetPodium(g, P, Y, { ground: 'colonnade', wall: pw0, colC: v % 2 ? C.dtFrame : C.cream, cornerC: pw0, pier: pp0, fascia: pf0, skipF: [17, 45], seed: 2 + v });
  podiumTerrace(g, P, st[0][0], ptop, rng, { trim: pp0 });
  let y0 = ptop + 1, row0 = 0;
  const nAll = Math.floor((Y + 118 - y0) / FL);
  for (let i = 0; i < st.length; i++) {
    const [B, yt] = st[i];
    shell(g, B, y0, yt, stone, C.roofGray);
    const n = Math.floor((yt - 8 - y0) / FL), r0 = row0;
    const common = { y0, y1: yt - 9, sillOut: -1, pierC: stone, hi: C.winCool, bandC: stone };
    // (w4r4) tier 1 = the ref05 bank's order: tall 3-storey glass bays between
    // stone pilasters 2 proud, a stone band + white cap every 3 storeys
    // (w4r5) tier 1: a fine grid of white-framed paired windows between stone
    // pilasters, a stone sill ledge every floor, a white-capped band every 3
    // (w4r9) critic w4r8: "pale, low-contrast glass ... flat printed grid":
    // (frames FLUSH: jambs 1 proud hid a third of each 3-wide pane at iso;
    // the relief is the hood + lug sill + pilasters)
    // the white frame ring round every 3-wide pane made the grid read as grey
    // lattice (frames + stone were ~80% of the face, glass 11%; ref05 hotel
    // 19%). Frames are now the STONE itself (a proud surround), each window
    // gets a hood moulding 2 proud and a lug sill 1 proud, panes are 8 tall.
    if (i === 0) gridBays(g, B, 'fblr', { y0, y1: yt - 9, ww: 3, wh: 8, sill: 2, gap: -1, recess: 1, frameOut: 0, per: 2, pw: 2, cw: 1, pd: 2, cpd: 3, pierC: stone, frameC: stone,
      spandC: C.dtGlassDeep,   // (w4r8) glass + petrol spandrel strips recessed 2 behind the stone pilasters (critics w4r5-r7: "no depth")
      hoodC: C.dtFrame, hoodOut: 1, lugC: stone, lugOut: 1,   // (w4r14) hood 1 proud: at 2 it shaded the now-recessed panes to navy slots
      glassFn: glint(C.dtGlassTeal, C.dtGlassHi, 5, 3), bandEvery: 3, bandC: stone, capC: C.dtFrame, bandH: 2 });
    // (w4r11) critic w4r10: "SPIRE glass = flat dark-blue slots stamped on
    // every floor; break the grid into zones". Tier 1 keeps the fine framed
    // grid (the shaft); tier 2 is RIBBON glazing (bright cyan bands between
    // stone spandrels, glints across them); tier 3 is an all-glass CROWN cage.
    else if (i === 1) curtain(g, B, 'fblr', { y0, y1: yt - 9, cw: 3, cornerC: stone, cornerOut: 2, pitch: 7, mullC: C.dtFrame, transC: C.dtFrame, spandC: stone, spandH: 3, seed: 5 + v });
    else curtain(g, B, 'fblr', { y0, y1: yt - 9, cw: 2, cornerC: stone, cornerOut: 1, pitch: 6, mullC: C.dtFrame, seed: 2 + v });
    // (w4r13) tier 1's top storey: a recessed double-height loggia
    if (i === 0) skyGarden(g, B, y0 + 2 * FL + 1, yt - 5, { col: stone, slab: C.dtFrame, trim: C.dtFrame, glass: C.dtGlassDeep, planter: stone, out: 4 });
    // sky-lobby glass band under each upper setback's cornice
    else for (const S of sides(g, B)) { S.f.clear(S.u0 + 3, yt - 7, 0, S.u1 - 3, yt - 3, 0); S.f.box(S.u0 + 3, yt - 7, -1, S.u1 - 3, yt - 3, -1, C.dtGlassHi); for (let u = S.u0 + 5; u < S.u1 - 3; u += 4) S.f.box(u, yt - 7, -1, u, yt - 3, -1, C.dtFrame); }
    cornice(g, B, yt - 2, C.dtFrame, spandC, 2, 0);
    if (i < 2) {
      const Bn = st[i + 1][0];
      railing(g, B.x0 - 1, B.z0 - 1, B.x1 + 1, B.z1 + 1, yt + 1, C.metal);
      roofCrowd(g, B.x0 + 1, B.z0 + 1, B.x1 - 1, Bn.z0 - 2, yt + 1, rng, { ac: 4, vents: 2 });   // w4r4: crowded terraces
      roofCrowd(g, B.x0 + 1, Bn.z1 + 2, B.x1 - 1, B.z1 - 1, yt + 1, rng, { ac: 4, vents: 2 });
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
  const mt = Math.min(255, top + 84);   // (w4r13) same mast length as before the tiers came down
  for (let y = top + 18; y < mt; y++) g.set(31, y, 42, y % 8 < 4 ? C.red : C.dtFrame);
  g.set(31, mt, 42, C.neon);
  acBox(g, Bt.x0 + 1, top, Bt.z0 + 1, { w: 4, d: 2, h: 3 }); acBox(g, Bt.x1 - 4, top, Bt.z1 - 2, { w: 4, d: 2, h: 3 });
  // entrance: glass lobby, stepped terrace, glass canopy with SPIRE, planters
  portico(g, P.z0, { Y, xc: 31, w: 19, depth: 12, kind: 'cochere', cols: 4, colC: C.dtFrame, stone: C.dtLimeShade, glassTop: C.dtGlassTeal, fascia: v % 2 ? C.dtNavyPanel : C.brickDark, text: 'SPIRE', textC: C.signWhite, planters: false });
  // lot: plaza trees + benches, taxis in a kerbside lay-by, parking on 3 sides
  // (w4) the porte-cochère drive replaces the kerbside lay-by
  // (w4r6) the ref05 hotel lot round it: lawns, hedges, open paving
  hotelLot(g, P, rng, { xc: 31, hw: 4, fz: P.z0 - 14 });
  people(g, 24, 2, 38, P.z0 - 15, Y, 5, rng);
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
  // (w4r3) a fountain forecourt instead of the front car park (critic w4r2:
  // "thin lot strips crowded with cars"; ref05 gives landmarks a paved plaza)
  forecourt(g, 1, 61, 1, 12, rng, { xc: 31, hw: 8 });
  // (r9) the lower block is a terracotta street podium: shopfronts under a
  // black fascia with signs + awnings, a glass ribbon (v1: arcade) above
  const Lb = box(5, 22, 57, 58), Ub = box(12, 14, 50, 50);
  const lt = streetPodium(g, Lb, Y, { ground: 'glass', wall: terra, pier: C.dtFrame, fascia: C.black, glass: tones[0], skipF: [22, 40], seed: 4 + v, roof: C.lotGrass }) - 1;
  const ut = lt + 2 + FL * (3 + v);
  // upper block, cantilevered forward over the plaza
  shell(g, Ub, lt + 1, ut, C.dtGlassDark, C.roofGray);
  g.box(Ub.x0, lt + 1, Ub.z0, Ub.x1, lt + 1, Lb.z0, C.dtFrame);
  // (w4r11) critic w4r10: TECH's glass read as dark slots. The upper block
  // is a bright curtain wall (cyan, glints) behind its fins + sunshades
  curtain(g, Ub, 'fblr', { y0: lt + 2, y1: ut - 1, cw: 2, pitch: 5, mullC: C.metal, transC: C.metal, transOut: 0, seed: 6 + v });
  for (let y = lt + 2 + FL; y < ut - 2; y += FL) ledge(g, Ub, y, C.dtFrame, 2, 1);
  // (w4r8) critic w4r7: TECH read as a flat window grid. Vertical terracotta
  // sun fins 3 proud every ~9 voxels cross the white sunshades: a deep
  // brise-soleil egg-crate over the dark glass, in the podium's colour.
  for (const S of sides(g, Ub)) {
    const n = Math.max(2, Math.round((S.u1 - S.u0) / 9));
    for (let k = 1; k < n; k++) { const u = S.u0 + Math.round((S.u1 - S.u0) * k / n); S.f.box(u, lt + 2, 1, u, ut - 1, 3, terra); }
  }
  for (const S of sides(g, Ub)) { S.f.box(S.u0 - 1, lt + 2, 1, S.u0 + 1, ut, 1, C.metal); S.f.box(S.u1 - 1, lt + 2, 1, S.u1 + 1, ut, 1, C.metal); }
  course(g, Ub, lt + 1, C.dtNavyPanel, 1, 1, 0);
  for (const x of [Ub.x0 + 2, Ub.x1 - 3]) { g.box(x, Y, Ub.z0 + 2, x + 1, lt, Ub.z0 + 3, C.dtFrame); g.box(x - 1, Y, Ub.z0 + 1, x + 2, Y, Ub.z0 + 4, C.stoneDark); }
  dentils(g, Ub, ut, C.dtFrame);
  const ct = cornice(g, Ub, ut + 1, C.dtFrame, C.dtNavyPanel, 1, 0) - 1;
  deck(g, Ub, ct - 1);
  for (let x = Ub.x0 + 3; x + 5 <= Ub.x0 + 22; x += 7) solarPanel(g, x, Ub.z0 + 16, x + 5, Ub.z1 - 3, ct);
  mechCrown(g, Ub.x0, Ub.z0, Ub.x1, Ub.z1, ct, rng, { rail: C.metal, wall: C.dtStone, trim: C.dtNavyPanel, plant: [Ub.x1 - 12, Ub.z1 - 12, Ub.x1 - 3, Ub.z1 - 3, 7], ac: 3, vents: 2, dishes: 1 });
  // (w4r10) no roof sign box (w4r8: "crude blocky banners"); TECH is on the canopy
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
  // (w4r8) critic w4r7: "our BANK is a small grey box squeezed under the
  // towers, with soft columns and a faint label; the reference bank is a
  // grand landmark with a pediment and wide stairs". Rebuilt bigger and
  // brighter: near-white stone (v1 warm limestone), a giant order of four
  // CHUNKY columns per face (7 across) standing clear of tall bright glass
  // bays (petrol foot -> lit teal body + two rising reflection streaks), a
  // taller plinth, a wider stair, BANK in 2x navy letters on a deep frieze,
  // a bigger pediment + clock. ~25% taller than before.
  const [stone, shade, roofC] = [[C.offwhite, C.dtStone, C.dtCopper], [C.dtLime, C.dtLimeShade, C.dtCopper]][v % 2];
  const g = grid(63, 256, 63, R);
  const Y = plazaLot(g);                 // (w4r4) the ref05 bank's beige forecourt
  // plinth: rusticated, basement windows on the sides + back
  const P = box(3, 13, 59, 59);
  const y0 = Y + 11;
  shell(g, P, Y, y0 - 1, stone, stone);
  for (let y = Y + 2; y < y0 - 1; y += 3) g.walls(P.x0, y, P.z0, P.x1, y, P.z1, shade);
  punch(g, P, 'blr', { y0: Y + 2, y1: y0 - 2, floor: 20, sill: 1, wh: 5, w: 3, pitch: 7, margin: 5, glass: C.dtGlassDark, hiRows: 1, frameC: shade });
  g.walls(P.x0, y0 - 1, P.z0, P.x1, y0 - 1, P.z1, shade);
  // hall: a navy-panelled wall of tall glass bays, recessed behind the order
  const Cl = box(8, 17, 54, 54), H = ins(Cl, 1);         // engaged: the columns touch the glass wall, so the bays show
  const ec = y0 + 38;                                    // column tops
  shell(g, H, y0, ec + 2, C.dtNavyPanel, C.roofGray);
  const cx = [8, 23, 39, 54], cz = [17, 29, 42, 54];
  // glass bays: one tall sheet per bay, painted as one reflection
  // glass flush with the hall face (a 1-deep reveal behind the columns went dark in AO)
  const sheet = (f, a, b, ya, yt, seed) => {
    const h = yt - ya + 1;
    for (let y = ya; y <= yt; y++) { const t = (y - ya) / (h - 1); f.box(a, y, 0, b, y, 0, y === ya ? C.dtGlassDark : t < 0.18 ? C.dtGlassDeep : C.dtGlassTeal); }
    for (let k = 0; k <= b - a; k++) {
      const col = f.rd > 0 ? k : b - a - k, yb = ya + 3 + ((seed * 7 + col * 2) % Math.max(1, h - 10));
      for (const [dy, w] of [[0, 4], [8, 2]]) for (let q = 0; q < w; q++) { const yy = yb + dy + q + col; if (yy > ya + 1 && yy < yt) f.set(a + k, yy, 0, C.dtGlassHi); }
    }
    for (const yy of [ya + 12, ya + 24]) if (yy < yt) f.box(a, yy, 0, b, yy, 0, shade);         // transoms at the floor lines
    if (b - a >= 5) f.box((a + b) >> 1, ya, 0, (a + b) >> 1, yt, 0, shade);                       // centre mullion
    f.box(a - 1, yt + 1, 0, b + 1, yt + 1, 0, shade); f.box(a - 1, ya - 1, 0, b + 1, ya - 1, 0, shade);   // head + sill
  };
  for (const S of sides(g, H)) {
    const cs = S.s === 'f' || S.s === 'b' ? cx : cz;
    const spans = [];
    for (let i = 0; i + 1 < cs.length; i++) spans.push([Math.max(S.u0 + 2, cs[i] + 4), Math.min(S.u1 - 2, cs[i + 1] - 4)]);
    spans.forEach(([a, b], i) => { if (b - a >= 2) sheet(S.f, a, b, y0 + 2, ec - 3, i + (S.u0 & 3)); });
  }
  // columns: octagonal shafts 7 across on a base 9 across, capital 9 across
  // (w4r8) shafts are 7 wide along the face but only 5 deep, so the glass
  // bays between them stay visible at the iso angle (7x7 hid them)
  const column = (x, z, corner, side) => {
    const [rx, rz] = corner ? [3, 3] : side ? [2, 3] : [3, 2];
    g.box(x - 4, y0, z - 4, x + 4, y0 + 1, z + 4, shade);                       // base
    g.box(x - rx, y0 + 2, z - rz, x + rx, y0 + 2, z + rz, stone);               // torus
    if (corner) g.box(x - 3, y0 + 3, z - 3, x + 3, ec - 4, z + 3, stone);
    else { g.box(x - rx, y0 + 3, z - rz + 1, x + rx, ec - 4, z + rz - 1, stone); g.box(x - rx + 1, y0 + 3, z - rz, x + rx - 1, ec - 4, z + rz, stone); }
    g.box(x - 3, ec - 3, z - 3, x + 3, ec - 2, z + 3, shade);                   // echinus
    g.box(x - 4, ec - 1, z - 4, x + 4, ec, z + 4, stone);                       // abacus
  };
  for (const x of cx) for (const z of [Cl.z0, Cl.z1]) column(x, z, x === Cl.x0 || x === Cl.x1);
  for (const z of cz.slice(1, -1)) for (const x of [Cl.x0, Cl.x1]) column(x, z, false, true);
  // entablature: architrave, a deep frieze with BANK in 2x letters, dentils, cornice
  const E = ins(Cl, -4);
  g.box(E.x0, ec + 1, E.z0, E.x1, ec + 3, E.z1, stone);
  g.walls(E.x0, ec + 3, E.z0, E.x1, ec + 3, E.z1, shade);
  const fr = ec + 4;
  shell(g, E, fr, fr + 16, stone, C.roofGray);
  course(g, E, fr, shade, 0, 1, 0);
  dentils(g, E, fr + 16, shade);
  const ct = roofCornice(g, E, fr + 17, stone, shade, 3, 0);
  // (w4r11) critics w4r8 + w4r10: "large, fuzzy block-letter signs; the ref
  // uses a crisp small plaque". BANK is now 1x gold letters on a navy plaque
  // with a gold rim, centred in the frieze (was 2x navy letters on stone)
  for (const [side, z] of [['front', E.z0], ['back', E.z1]]) {
    const FB = facade(g, side, z);
    FB.box(31 - 14, fr + 3, 1, 31 + 14, fr + 13, 1, C.gold);
    FB.box(31 - 13, fr + 4, 1, 31 + 13, fr + 12, 1, C.dtNavyPanel);
    text5(FB, 31, fr + 5, 'BANK', C.gold, 2, 1);
  }
  // attic storey with square windows + parapet, teal roof
  const A = ins(E, 4), at = ct + 9;
  shell(g, A, ct, at, stone, roofC);
  punch(g, A, 'fblr', { y0: ct + 1, y1: at - 1, floor: 20, sill: 2, wh: 4, w: 3, pitch: 7, margin: 4, glass: C.dtGlassDeep, hiRows: 1, frameC: shade, sillC: shade });
  course(g, A, at, shade, 1, 1, 0);
  parapetOn(g, A, at + 1, 2, stone, shade);
  g.box(A.x0 + 1, at, A.z0 + 1, A.x1 - 1, at, A.z1 - 1, roofC);
  // pediment (45°, full width of the order) over the front, gold clock
  const gy = ct, qx0 = E.x0 + 2, qx1 = E.x1 - 2, pz = E.z0 - 3;
  for (let k = 0; ; k++) {
    const xa = qx0 + k, xb = qx1 - k;
    if (xb - xa < 1) break;
    g.box(xa, gy + k, pz + 1, xb, gy + k, pz + 18, stone);                 // gable roof runs back
    g.box(xa, gy + k, pz + 1, xa + 1, gy + k, pz + 18, roofC); g.box(xb - 1, gy + k, pz + 1, xb, gy + k, pz + 18, roofC);
    g.set(xa, gy + k, pz, shade); g.set(xb, gy + k, pz, shade);
  }
  g.box(qx0 - 1, gy - 1, pz - 1, qx1 + 1, gy - 1, pz + 6, shade);
  clockFace(facade(g, 'front', pz + 1), 31, gy + 9, 6);
  // the doors in the middle bay
  const Fh = facade(g, 'front', H.z0);
  door(Fh, 27, y0, 9, 20, { color: C.dtGlassDark, glass: C.winCool, frame: C.gold, double: true, step: null });
  Fh.box(26, y0 + 21, 1, 36, y0 + 22, 2, C.gold);
  // stair: wide, lot -> plinth top, cheek walls with lamps
  for (let k = 0; k < y0 - Y; k++) g.box(14, Y + k, 1 + k, 48, Y + k, P.z0 + 1, shade);
  for (const x of [12, 13, 49, 50]) g.box(x, Y, 1, x, y0, P.z0, stone);
  for (const x of [12, 50]) { g.box(x, y0 + 1, 2, x, y0 + 3, 2, C.darkGray); g.set(x, y0 + 4, 2, C.lamp); }
  // roof: skylight + condensers
  g.box(24, at + 1, A.z0 + 8, 38, at + 2, A.z0 + 16, C.dtFrame); g.box(25, at + 3, A.z0 + 9, 37, at + 3, A.z0 + 15, C.dtGlassHi);
  roofCrowd(g, A.x0 + 3, A.z0 + 19, A.x1 - 3, A.z1 - 3, at + 1, rng, { ac: 6, vents: 3 });
  // lot: planters, trees, flags, hedges
  for (const x of [4, 58]) tree(g, x - 1, Y, 3, 6);
  planter(g, 1, 8, 10, 10, Y, { box: shade }); planter(g, 52, 8, 61, 10, Y, { box: shade });
  flag(g, 8, Y, 2, 24, C.blue); flag(g, 54, Y, 2, 24, C.red);
  hedge(g, 1, Y, 14, 1, 60); hedge(g, 61, Y, 14, 61, 60);
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
