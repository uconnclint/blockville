// Blockville models — VEHICLES, PEOPLE + LIFE: cars, boats, people, dogs,
// birds, clouds, smoke puffs, balloons, sparks (everything life.js animates).
//
// Round 6 (the r5 critic: "squat, generic blob-boxes with muddy blue window
// smears, no livery, all alike; ref05's vehicles are crisp types you can name
// at a glance"). Road vehicles are re-authored at res 12 (was 8) at about the
// same world size, which buys the detail a type needs:
//   * a real three-box / two-box / van / truck silhouette per type: hood,
//     raked windscreen, glasshouse set in from the shoulders, roof, trunk;
//   * round 4-5 voxel tyres with silver hubs in dark WHEEL ARCHES;
//   * framed glass: pillars in body colour, a bright pane with a darker top
//     row and a white diagonal highlight on every pane;
//   * lights: 2×2 headlamps (glow at night), orange indicators, red tails,
//     chrome bumpers / grilles on the trucks;
//   * liveries: ambulance red + orange stripe, chevron rear, red crosses and
//     light bars; fire engine white band, chrome lockers, roof ladder and
//     light bar; taxi checker band + roof sign; police two-tone doors + bar;
//     bus window band + white roof + destination sign; box-truck logo panel.
// Scale — round 7 renders the same voxel art at res 15 (was 12), i.e. every
// vehicle x0.8 (r2, r4, r6 critics: "oversized toys" next to ref05's little
// cars; roads.js r14: 6.6-unit carriageway, two 3.3-unit lanes):
//   car      12 × 11..14 × 21..27 voxels = 0.8 wide, ~0.8 tall, 1.4..1.8 long
//   van      12 × 15 × 30                = 0.8 × 1.0 × 2.0
//   ambulance / trucks / bus 13 wide     = 0.87 wide, 2.3 .. 3.1 long
//   compact (lot-stall) service cousins ≤ 33 long = 2.2 (the fire engine keeps
//   its ladder, turntable and light bar)
//   person   5 × 11 × 3 @ res 11         = 1.0 tall (kids 0.64)
// Round 9 renders the same art at res 17 (x0.88: car 0.71 wide, 1.24..1.59
// long; vans 1.76; buses / fire engine ~2.7) — the r2/r4/r6/r8 critics all
// read our vehicles as too big next to the buildings. Bays stay in world units.
// Every vehicle faces -Z (front at z = 0); the right-hand (kerb) side is +X.
// Bottom-centre anchored by the mesher, so the tyres touch y = 0.
//
// Palette: the shared palette is capped at 200 regular colours and the
// [vehicles] block sits last, so it only holds what the base palette lacks
// (glass x3, three paints, silver); everything else reuses base colours.
// Never paint a body C.skyBlue: voxel.js classes it as GLASS (sheen streaks).

import { C, grid, mulberry32 } from './core.js';

const R = 4;                       // birds, smoke
const RB = 5;                      // boats (r8: x1.2 — a sailboat is ~6.4 units long, a ferry ~7.6)
const RV = 18;                     // road vehicles (r7: 12 -> 15, x0.8; r9: 15 -> 17, x0.88; r10: 17 -> 18 + narrower, lower bodies — see Cars)
const RP = 16;                     // people — r13: 16 (0.81 tall; the r12 critic: "1 to 2 px specks" at iso-close).
                                   // was (r11: res 18 = the lot figures' res, 13 tall = 0.72: the r10 critic read 0.875 as "tall sticks, as tall as a car is long")
const RD = 12;                     // dogs

// shared vehicle colours (base palette reuse; see the note above)
const TYRE = C.black, HUB = C.stone, RIM = C.stoneDark, DARK = C.darkGray, ARCH = C.darkGray, CHROME = C.vehSilver;
const TAIL = C.red, BEACON_B = C.blue, IND = C.orange, WHITE = C.white;
// r12 (the r11 critic: "at normal zoom the wheel and window detail breaks up
// into dark speckled crosses ... one dark wheel block per corner and one flat
// glass colour per window"): every pane is ONE flat glass colour — the darker
// top row and the white diagonal streaks alias to it, so no speckle survives.
const GLASS = C.vehGlass, GLASS_DK = GLASS, GLASS_HI = GLASS;

const has = (g, x, y, z) => g.map.has(x + ',' + y + ',' + z);
// paint a highlight only where there is glass (never on a pillar or panel)
function hi(g, x, y, z) {
  const c = g.map.get(x + ',' + y + ',' + z);
  if (c === GLASS || c === GLASS_DK) g.set(x, y, z, GLASS_HI);
}

// ---------------------------------------------------------------------------
// vehicle building blocks (res-12 voxel coordinates)
// ---------------------------------------------------------------------------

// Tyre disc of diameter d (4 = cars, 5 = SUVs / vans / trucks / buses) on
// side column x, centred on zc, with rounded corners. r10: the tyre is BLACK
// with only a small dark-grey hub (the r9 critic: "no readable dark wheels" —
// the old 2×2 / 3×3 silver hubs made every wheel a light blob at iso zoom).
// r12: ONE clean black block per wheel (the r11 critic read the grey rim /
// hub pixels + cut corners as "dark speckled crosses" at normal zoom). Only
// the big d >= 5 wheels lose their two TOP corners (a rounded shoulder under
// the arch); the ground corners stay so the tyre sits flat on its shadow.
function tyre(g, x, zc, d) {
  const z0 = zc - (d >> 1), z1 = z0 + d - 1;
  g.box(x, 0, z0, x, d - 1, z1, TYRE);
  if (d >= 5) { g.del(x, d - 1, z0); g.del(x, d - 1, z1); }
  // r14: a 2×2 grey hub. flare() copies only TYRE voxels to the proud outer
  // column, so the hub sits one voxel DEEP inside the tyre ring — a recessed
  // rim that reads as "wheel" (ref05's engines / lot cars) rather than a
  // black block, without the old speckle of a flush grey cross.
  const hy = d >= 5 ? 2 : 1, hz = z0 + ((d - 2) >> 1);
  g.box(x, hy, hz, x, hy + 1, hz + 1, HUB);
}

// Wheels + arches. Call AFTER the body: the body voxels in a ring one voxel
// round each tyre turn black (the arch), then the tyre goes in.
function wheels(g, W, zs, d = 4) {
  for (const zc of zs) {
    const t0 = zc - (d >> 1), t1 = t0 + d - 1;
    for (const x of [0, W - 1]) {
      // r10: only the arch LID (row d over the tyre, row d-1 at its ends) goes
      // dark — a full dark ring on the 4-row car body blacked out the flank
      // r12: no separate grey arch lid (a second dark tone round the tyre was
      // half the speckle); the tyre block itself is the wheel + arch shadow.
      tyre(g, x, zc, d);
    }
  }
}

// Under-tray one voxel in from the sides: the dark gap under the sills that
// grounds the car (dynamics cast no shadows).
function tray(g, W, z0, z1) { g.box(1, 0, z0, W - 2, 0, z1, DARK); }

// Front: 2×2 headlamps (lamp 202 glows at night) at the corners with an
// orange indicator under each, a dark grille between, chrome bumper row.
function nose(g, W, yl, z, o = {}) {
  const xr = W - 1, lw = o.lw || 2;
  g.box(1, yl, z, lw, yl + 1, z, C.lamp); g.box(xr - lw, yl, z, xr - 1, yl + 1, z, C.lamp);
  if (o.grille !== false) g.box(lw + 1, yl, z, xr - lw - 1, yl + 1, z, o.grille || DARK);
  const by = o.by || 1;
  if (o.bumper !== false) g.box(2, by, z, xr - 2, by, z, o.bumper || CHROME);
  g.set(1, yl - 1, z, IND); g.set(xr - 1, yl - 1, z, IND);
}

// Rear: red tail lamps (2 wide × h tall) at the corners, bumper row.
function tail(g, W, yl, z, h = 2, bumper = CHROME) {
  const xr = W - 1;
  g.box(1, yl, z, 2, yl + h - 1, z, TAIL); g.box(xr - 2, yl, z, xr - 1, yl + h - 1, z, TAIL);
  if (bumper != null) g.box(1, 1, z, xr - 1, 1, z, bumper);
}

// Round off the four vertical plan corners of a box (x 0 / W-1, z z0 / z1)
// between y0 and y1.
function roundCorners(g, W, z0, z1, y0, y1) {
  for (let y = y0; y <= y1; y++) for (const x of [0, W - 1]) { g.del(x, y, z0); g.del(x, y, z1); }
}

// Glasshouse: `rows` rows of glass from y0 over x0..x1. The front edge rakes
// back rakeF voxels per row from zF, the rear edge forward rakeB per row from
// zB. Pillars (body colour) at the corners and at every z in `pillars`; the
// top row is the darker glass (reads as reflection depth), and every pane gets
// a white diagonal highlight. A roof slab (chamfered corners) caps it.
function cabin(g, o) {
  const { x0, x1, zF, zB, y0, rows, body } = o;
  const rF = o.rakeF == null ? 1 : o.rakeF, rB = o.rakeB == null ? 1 : o.rakeB;
  const roof = o.roof == null ? body : o.roof;
  const pil = o.pillars || [];
  // r8: rake in 2-row steps (0,0,2,2) — four 1-voxel steps read as venetian
  // blinds at iso-close (every step top catches the key light).
  const fk = k => (o.pair === false ? k : k & ~1);
  for (let k = 0; k < rows; k++) {
    const y = y0 + k, zf = zF + rF * fk(k), zb = zB - rB * fk(k);
    g.box(x0, y, zf, x1, y, zb, k === rows - 1 ? GLASS_DK : GLASS);
    for (const x of [x0, x1]) {
      g.set(x, y, zf, body); g.set(x, y, zb, body);
      for (const pz of pil) if (pz > zf && pz < zb) g.set(x, y, pz, body);
    }
  }
  const yr = y0 + rows, rzf = zF + rF * fk(rows), rzb = zB - rB * fk(rows);
  g.box(x0, yr, Math.min(rzf, rzb), x1, yr, Math.max(rzf, rzb), roof);
  if (o.chamfer !== false) for (const x of [x0, x1]) { g.del(x, yr, rzf); g.del(x, yr, rzb); }
  // r13 (the r12 critic: "no dark windshield ... they read as coloured
  // pills"): the iso camera sees a car mostly from ABOVE, so the windscreen
  // and rear window continue onto the roof — the first topF / last topB roof
  // rows are glass inside a one-voxel body frame (the A / C pillar tops). A
  // sloped screen seen from above, as ref05's lot cars show it.
  const topF = o.topF == null ? 2 : o.topF, topB = o.topB == null ? 1 : o.topB;
  if (Math.abs(rzb - rzf) + 1 > topF + topB + 2) {
    for (let x = x0 + 1; x < x1; x++) {
      for (let k = 0; k < topF; k++) g.set(x, yr, rzf + k, GLASS);
      for (let k = 0; k < topB; k++) g.set(x, yr, rzb - k, GLASS);
    }
  }
  // windscreen streak: two voxels wide, climbing to the right
  for (let k = 0; k < rows - 1; k++) {
    const x = x0 + 2 + k;
    if (x + 1 < x1) { hi(g, x, y0 + k, zF + rF * fk(k)); hi(g, x + 1, y0 + k, zF + rF * fk(k)); }
  }
  // side panes: a short diagonal streak just behind each pane's front edge
  const starts = [zF + rF * fk(rows - 1)].concat(pil);
  for (const x of [x0, x1]) for (const s of starts) {
    if (rows >= 3) { hi(g, x, y0 + rows - 2, s + 2); hi(g, x, y0 + rows - 3, s + 3); }
    else hi(g, x, y0, s + 2);
  }
  // rear pane
  const kb = Math.max(0, rows - 2);
  hi(g, x1 - 2, y0 + kb, zB - rB * fk(kb));
  return { yr, zf: rzf, zb: rzb };
}

// Door shut-lines: a dark vertical seam on both flanks at each z in `zs`
// (rows y0..y1), painted only over body colour — never over glass, lamps,
// arches or trim. At iso-close a flank without them reads as a flat slab.
function seams(g, W, zs, y0, y1, body) {
  return;   // r12: off — thin dark seams added to the flank speckle at iso-mid
  for (const x of [0, W - 1]) for (const z of zs) for (let y = y0; y <= y1; y++) {
    if (g.map.get(x + ',' + y + ',' + z) === body) g.set(x, y, z, DARK);
  }
}

// Wrap the corner kit round onto the flanks (r8: the iso camera sees a
// vehicle's top and two SIDES far more than its nose or tail, so lamps that
// only sat on the end faces never showed — the r7 critic saw "no lights").
// Headlamps / indicators / chrome bumper rows on the front face at x 1 and
// W-2 are copied to the flank voxel at z 1; tails + rear bumper at z L-2.
const WRAP_F = new Set(), WRAP_B = new Set();
function wrapCorners(g) {
  if (!WRAP_F.size) { WRAP_F.add(C.lamp); WRAP_F.add(IND); WRAP_B.add(TAIL); }
  const W = g.sx, L = g.sz, xr = W - 1;
  const at = (x, y, z) => g.map.get(x + ',' + y + ',' + z);
  const skin = c => c != null && c !== GLASS && c !== GLASS_DK && c !== GLASS_HI && c !== TYRE && c !== HUB && c !== DARK;
  for (let y = 1; y < Math.min(g.sy, 9); y++) {
    for (const [xs, xi] of [[0, 1], [xr, xr - 1]]) {
      const f = at(xi, y, 0), b = at(xi, y, L - 1);
      if ((WRAP_F.has(f) || (f === CHROME && y <= 2)) && skin(at(xs, y, 1))) g.set(xs, y, 1, f);
      if ((WRAP_B.has(b) || (b === CHROME && y <= 2)) && skin(at(xs, y, L - 2))) g.set(xs, y, L - 2, b);
    }
  }
  return g;
}

// Mirrors: a body-colour nub each side just behind the windscreen base.
function mirrors(g, W, y, z, body) { g.set(0, y, z, body); g.set(W - 1, y, z, body); }

// r13 (the r12 critic: "a candy palette of pink vans, lime and teal
// hatchbacks ... bring the saturation down towards real car paints (white,
// silver, red, blue, black) so a few accent colours stand out"): weighted
// like a real car park — white / silver / charcoal / grey most, then red and
// blue, and ONE slot each of the accents. (No vehSilver bodies: chrome trim.)
// (Only ONE charcoal slot: on ref05's near-black asphalt a dark car is a hole.)
// r14: with the shade-side flanks lit (see VOX_SMALL) the white majority read
// as a street of white boxes; ref05's lots mix red / blue / white / yellow /
// teal — one white slot fewer, one teal more.
const CAR_COLS = () => [WHITE, WHITE, C.vehPearl, C.vehPearl, C.stone, C.vehCharcoal,
  C.vehRed, C.vehRed, C.blue, C.blue, C.vehGreen, C.taxiYellow, C.orange, C.teal];

// ---------------------------------------------------------------------------
// carModel(variant, parked) — 14 kinds (kind = variant mod 14), colours from
// the rest of the variant. Life spawns them with its own traffic mix.
//   0 sedan  1 taxi  2 bus  3 ice-cream truck  4 fire engine  5 hatchback
//   6 police car  7 ambulance  8 box truck  9 pickup  10 SUV  11 panel van
//   12 school bus  13 city car (short, bubbly, two-tone)
// parked = true returns the same vehicle standing in a painted kerbside bay
// (the bay outline baked one voxel tall on the vehicle's +X side; life.js
// sinks the model so only a paint-thin top shows). Cars take one bay, the
// long vehicles (bus, trucks, ambulance, fire engine, ice-cream van) two.
// ---------------------------------------------------------------------------
export const CAR_KINDS = 14;
const LONG_KINDS = [2, 3, 4, 7, 8, 12];

export function carModel(variant, parked) {
  const vi = variant | 0;
  const k = ((vi % CAR_KINDS) + CAR_KINDS) % CAR_KINDS;
  const g = vehicleGrid(vi);
  return parked ? inBay(g, LONG_KINDS.includes(k) ? 2 : 1) : withBlob(g.done());
}

// r12 contact shadow (engine.js makeDynamic draws model.blobs): the r11
// critic: "their contact shadows are weak ... add a darker soft shadow under
// each vehicle". Dynamics cast no sun shadow and get no AO, so every vehicle
// and person carries a soft dark footprint blob: [x, z, w, l, y, opacity],
// model-local world units, the footprint itself at full opacity.
const BLOB_A = 0.88, BLOB_PED = 0.6;
// parked / lot cars: a hair lighter, so they fill their own (static) instance
// pool in engine.js (pools are keyed by opacity) and the moving cars' pool
// stays small — only it re-uploads every frame
const BLOB_PARK = 0.86;
function withBlob(m, a = BLOB_A) {
  m.blobs = [[0, 0, m.sx / (m.res || 1), m.sz / (m.res || 1), 0, a]];
  return small(m);
}

// r14 (the r13 critic: "smooth, rounded white boxes ... no visible wheels,
// glass, headlights, bumpers"). MEASURED: the mesher's building-scale AO (2-unit
// rays, ground plane solid, broad / sky terms out to 3.5 units) put EVERY
// vertical face of a 0.5-unit car at AO 0.24-0.43, so the shade-side flank of
// a white van rendered (25,26,26) — the colour of the asphalt — and the wheels,
// glass, lamps and livery on it vanished. Small movers mesh with prop-scale AO
// (engine.js _getGeometry merges model.voxOpts): 0.25-unit rays keep the
// inside-corner shading (cabin / roof creases, wheel wells, a thin ground
// contact) and drop the building-scale terms (voxel.js: aoDist < 1).
const VOX_SMALL = Object.freeze({ aoDist: 0.25, aoSpread: 0 });
function small(m) { m.voxOpts = VOX_SMALL; return m; }

// carModelAt(variant, res) — the same vehicle resampled (nearest voxel
// centre) to a coarser grid resolution, for building grids that copy car
// blocks straight into their own voxels (residential driveways, res 8): same
// world size as the traffic, lights off.
export function carModelAt(variant, res) {
  const m = carModel(variant);
  const r = res > 0 ? res : RV, k = RV / r;
  if (Math.abs(k - 1) < 1e-6) return m;
  const src = new Map();
  for (const [x, y, z, c] of m.blocks) src.set(x + ',' + y + ',' + z, c);
  const sx = Math.max(1, Math.round(m.sx / k)), sy = Math.max(1, Math.round(m.sy / k)), sz = Math.max(1, Math.round(m.sz / k));
  const blocks = [];
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const c = src.get(Math.floor((x + 0.5) * k) + ',' + Math.floor((y + 0.5) * k) + ',' + Math.floor((z + 0.5) * k));
    if (c != null) blocks.push([x, y, z, c === C.lamp ? CHROME : c]);
  }
  const out = { sx, sy, sz, blocks };
  if (r !== 1) out.res = r;
  return out;
}

// The res-12 vehicle grid behind carModel. o.paint overrides the body colour of
// the everyday kinds (sedan, hatchback, pickup, SUV, panel van, city car);
// o.compact swaps the long kinds for a car-length (12 × ≤ 33 voxel) cousin —
// minibus, ambulance van, fire-rescue van, little delivery truck, ice-cream
// van — so every kind fits one lot stall (stampCar).
function vehicleGrid(variant, o = {}) {
  const vi = variant | 0;
  const k = ((vi % CAR_KINDS) + CAR_KINDS) % CAR_KINDS;
  const rng = mulberry32((vi >>> 0) * 7 + 51);
  const pick = a => a[(rng() * a.length) | 0];
  const col = () => (o.paint != null ? o.paint : pick(CAR_COLS()));
  const cpt = !!o.compact;
  const seed = ((Math.floor(vi / CAR_KINDS) % 6) + 6) % 6;   // r11: livery slot (fleet vans / trucks)
  return flare(wrapCorners(vehicleKind(k, pick, col, rng, cpt, o, seed)));
}

// r13 (the r12 critic: "no visible black wheels or wheel arches ... give each
// vehicle ... black wheels at the corners"): every tyre stands one voxel
// proud of the flank, so from the iso camera's high angle its black top shows
// outside the body line at all four corners (a flush tyre hid under the
// shoulder). The grid grows by one voxel a side; everything else shifts +1 X.
function flare(g) {
  const W = g.sx, out = grid(W + 2, g.sy, g.sz, RV);
  for (const [key, c] of g.map) { const p = key.split(','); out.set(+p[0] + 1, +p[1], +p[2], c); }
  for (const [key, c] of g.map) {
    if (c !== TYRE) continue;
    const p = key.split(','), x = +p[0], y = +p[1], z = +p[2];
    if (y > 4) continue;
    if (x === 0 || !has(g, x - 1, y, z)) out.set(x, y, z, TYRE);
    if (x === W - 1 || !has(g, x + 1, y, z)) out.set(x + 2, y, z, TYRE);
  }
  return out;
}
function vehicleKind(k, pick, col, rng, cpt, o, seed) {
  switch (k) {
    case 1: return taxi();
    case 2: return bus(pick, false, cpt);
    case 3: return iceCream(cpt);
    case 4: return fireTruck(cpt);
    case 5: return racing(hatchback(col(), rng() < 0.3), rng);
    case 6: return police();
    case 7: return ambulance(cpt);
    case 8: return boxTruck(seed, cpt);
    case 9: return pickup(col(), rng() < 0.6);
    case 10: return suv(col(), rng() < 0.5);
    case 11: return panelVan(seed, o.paint);
    case 12: return bus(pick, true, cpt);
    case 13: return cityCar(col(), rng() < 0.5);
    default: return racing(sedan(col(), { roof: rng() < 0.12 ? C.vehCharcoal : undefined }), rng);
  }
}

// Twin rally stripes over bonnet, roof and boot on ~1 in 4 everyday cars: the
// iso camera mostly sees roofs, so a stripe is what tells two sedans apart at
// iso-mid (the r6 critic: "coloured specks, hard to tell apart").
function racing(g, rng) {
  if (rng() >= 0.12) return g;   // r13: rarer (0.28 read as a toy set)
  const W = g.sx, xs = [(W >> 1) - 2, (W >> 1) + 1];
  let body = null;
  for (let y = g.sy - 1; y >= 0 && body == null; y--) {
    const c = g.map.get((W >> 1) + ',' + y + ',' + (g.sz >> 1));
    if (c != null) body = c;
  }
  const bodyAt = g.map.get('0,3,' + (g.sz >> 1));
  const col = bodyAt === WHITE || bodyAt === C.taxiYellow || bodyAt === C.vehSilver ? C.navy : WHITE;
  for (const x of xs) for (let z = 0; z < g.sz; z++) {
    for (let y = g.sy - 1; y >= 0; y--) {
      const c = g.map.get(x + ',' + y + ',' + z);
      if (c == null) continue;
      if (c === bodyAt || c === body && c !== GLASS && c !== GLASS_DK) g.set(x, y, z, col);
      break;
    }
  }
  return g;
}

// Copy a vehicle grid into a bay grid: vehicle raised one voxel onto the paint
// layer, centred along the bay, 1 voxel off the kerb (+X); outline paint.
// bays stay in WORLD units whatever RV is: 1.2 / 2.4 half-length, 0.93 deep
const BAY_HALF1 = Math.round(1.2 * RV), BAY_HALF2 = Math.round(2.4 * RV), BAY_D = Math.round(0.93 * RV);
function inBay(src, bays) {
  const half = bays === 2 ? BAY_HALF2 : BAY_HALF1;
  const L = half * 2, D = BAY_D;
  const W = Math.max(D + 1, src.sx + 1);
  const g = grid(W, src.sy + 1, L, RV);
  const ox = Math.min(W - 1 - src.sx, W - Math.round((D + src.sx) / 2)), oz = half - Math.round(src.sz / 2);
  for (const [key, c] of src.map) {
    const p = key.split(',');
    g.set(+p[0] + ox, +p[1] + 1, +p[2] + oz, c === C.lamp ? CHROME : c); // parked: lights off
  }
  for (let x = W - D; x < W; x++) { g.set(x, 0, 0, C.signWhite); g.set(x, 0, L - 1, C.signWhite); }
  for (let z = 0; z < L; z++) g.set(W - D, 0, z, C.signWhite);
  const m = g.done();
  m.blobs = [[(ox + src.sx / 2 - W / 2) / RV, (oz + src.sz / 2 - L / 2) / RV, src.sx / RV, src.sz / RV, 1 / RV, BLOB_PARK]];
  return small(m);
}

// parkedRowModel(items) — every car parked along ONE road tile's kerbs,
// merged into a single res-12 model (96 × 96 voxels = the 8-unit tile, centred
// on the tile centre) so a whole street of parked cars costs one draw call per
// tile instead of one per car. Each item:
//   { variant, kx, kz, h, s, bays }
//   kx, kz  the kerb-face point at the middle of the bay (world units from the
//           tile centre); h = the heading the car faces (0 N -Z, 1 E +X, 2 S +Z,
//           3 W -X); s = the side the kerb is on (the car's right, +X in model
//           space); bays = 1 (car) or 2 (bus, trucks, ambulance ...).
// Each bay is painted as a clearly drawn box on the asphalt — a line at both
// ends plus the lane-side edge line (ref05's parking reads as white-outlined
// stalls) — one voxel tall; life.js sinks the model so only a paint-thin top
// shows. The car sits squarely in its bay one voxel off the kerb, lights off.
const DIR4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export function parkedRowModel(items) {
  const S = 8 * RV, g = grid(S, 24, S, RV), blobs = [];
  const put = (u, y, v, c) => g.set(Math.floor(u + S / 2), y, Math.floor(v + S / 2), c);
  for (const it of items || []) {
    const [hx, hz] = DIR4[(it.h | 0) & 3], [sx, sz] = DIR4[(it.s | 0) & 3];
    const kx = it.kx * RV, kz = it.kz * RV;
    const half = it.bays === 2 ? BAY_HALF2 : BAY_HALF1, D = BAY_D;
    for (let a = -half; a < half; a++) {
      for (let d = 0; d < D; d++) {
        if (a !== -half && a !== half - 1 && d !== D - 1) continue;
        put(kx - sx * (d + 0.5) + hx * (a + 0.5), 0, kz - sz * (d + 0.5) + hz * (a + 0.5), C.signWhite);
      }
    }
    const m = carModel(it.variant);
    const off = Math.max(1 + m.sx / 2, D / 2);          // r10: centred in the bay (narrower cars)
    const cx = kx - sx * off, cz = kz - sz * off;
    for (const [x, y, z, c] of m.blocks) {
      const r = x + 0.5 - m.sx / 2, f = -(z + 0.5 - m.sz / 2);   // right, forward
      put(cx + f * hx + r * sx, y + 1, cz + f * hz + r * sz, c === C.lamp ? CHROME : c);
    }
    const along = hx !== 0;   // heading along X: the car's length lies on X
    blobs.push([cx / RV, cz / RV, (along ? m.sz : m.sx) / RV, (along ? m.sx : m.sz) / RV, 1 / RV, BLOB_PARK]);
  }
  const out = g.done();
  out.blobs = blobs;
  return small(out);
}

// lotCarsModel(items) — the cars of one car park (terrain.js vacant-lot
// parking) merged into a single model, one draw call per lot. items:
//   { x, z, h, k }  x, z = car centre in world units from the model centre,
//                   h = heading (0 N -Z, 1 E +X, 2 S +Z, 3 W -X), k = seed
// Everyday kinds in the lot palette plus the odd taxi / van, lights off.
// Authored at res 15 (the res-12 vehicles × 0.8): the r4 critic wanted lot
// cars ~15-20 % smaller against the 1.5-unit stalls.
const LOT_RES = RV;
const LOT_MIX = [0, 5, 13, 10, 0, 13, 5, 9, 11, 0, 5, 13, 1];
export function lotCarsModel(items) {
  let ext = 1;
  for (const it of items || []) ext = Math.max(ext, Math.abs(it.x), Math.abs(it.z));
  const S = Math.ceil(ext + 1.6) * 2 * LOT_RES;
  const g = grid(S, 20, S, LOT_RES), blobs = [];
  const cols = CAR_COLS();
  for (const it of items || []) {
    const s = (((it.k | 0) + 0x9e37) * 2654435761) >>> 0;
    const kind = LOT_MIX[(s >>> 4) % LOT_MIX.length];
    const vg = vehicleGrid(kind + CAR_KINDS * ((s >>> 12) % 5), { paint: cols[(s >>> 20) % cols.length], compact: true });
    const [hx, hz] = DIR4[(it.h | 0) & 3], [rx, rz] = DIR4[((it.h | 0) + 1) & 3];
    for (const [key, c] of vg.map) {
      const p = key.split(',');
      const r = (+p[0] + 0.5 - vg.sx / 2) / LOT_RES, f = -(+p[2] + 0.5 - vg.sz / 2) / LOT_RES;
      const wx = it.x + f * hx + r * rx, wz = it.z + f * hz + r * rz;
      g.set(Math.floor(wx * LOT_RES + S / 2), +p[1], Math.floor(wz * LOT_RES + S / 2), c === C.lamp ? CHROME : c);
    }
    const along = hx !== 0;
    blobs.push([it.x, it.z, (along ? vg.sz : vg.sx) / LOT_RES, (along ? vg.sx : vg.sz) / LOT_RES, 0, BLOB_PARK]);
  }
  const out = g.done();
  out.blobs = blobs;
  return small(out);
}

// ---------------------------------------------------------------------------
// Cars. r10 (the r9 critic: "a generic chunky hatchback repainted ... cabins
// oversized ... about one lane-width wide and nearly as tall as the people";
// ref05's cars are long, low, with dark window strips and black wheel
// arches): every car is 10 wide (was 12) and LOW — body y1..4 (4 rows, the
// tyres d 4 fill it: big black wheels), a dark 3-row window band y5..7 set
// one voxel in from the shoulders, roof y8. 9 tall × 10 wide × 19..27 long =
// 0.5 × 0.56 × 1.05..1.5 units at res 18 (lane 3.3: ~17 % of it, was 22 %).
// Each kind keeps its own silhouette and length.
// ---------------------------------------------------------------------------
const CW = 10;                       // car width in voxels

// shared lower body: tray, body box y1..top, rounded nose + plan corners,
// lamps, dark sills between the wheels
function carBody(W, L, H, top, body, o = {}) {
  const g = grid(W, H, L, RV);
  tray(g, W, 2, L - 3);
  g.box(0, 1, 0, W - 1, top, L - 1, body);
  for (let x = 0; x < W; x++) g.del(x, top, 0);               // rounded nose
  if (o.roundTail !== false) for (let x = 0; x < W; x++) g.del(x, top, L - 1);
  roundCorners(g, W, 0, L - 1, 1, top);
  nose(g, W, 2, 0, o.nose);
  tail(g, W, o.roundTail !== false ? top - 2 : top - 1, L - 1, 2, o.tailBumper);
  return g;
}
function sills(g, W, z0, z1, c = DARK) { g.box(0, 1, z0, 0, 1, z1, c); g.box(W - 1, 1, z0, W - 1, 1, z1, c); }

// Sedan: three boxes — long hood, raked glasshouse, trunk. 26 long.
function sedan(body, o = {}) {
  const W = CW, L = 26, H = o.H || 9;
  const g = carBody(W, L, H, 4, body);
  cabin(g, { x0: 1, x1: W - 2, zF: 8, zB: 19, y0: 5, rows: 3, body, roof: o.roof, pillars: [14] });
  mirrors(g, W, 5, 9, body);
  wheels(g, W, [5, L - 6]);
  seams(g, W, [9, 14, 19], 2, 4, body);
  return g;
}

// Hatchback: two boxes, short tail, upright glazed tailgate. 22 long.
function hatchback(body, twoTone) {
  const W = CW, L = 22, H = 9;
  const g = carBody(W, L, H, 4, body, { roundTail: false });
  cabin(g, { x0: 1, x1: W - 2, zF: 7, zB: L - 1, y0: 5, rows: 3, body, rakeB: 0,
    roof: twoTone ? C.black : body, pillars: [13] });
  g.box(1, 8, L - 1, W - 2, 8, L - 1, twoTone ? C.black : body);        // spoiler lip
  mirrors(g, W, 5, 8, body);
  wheels(g, W, [5, L - 5]);
  seams(g, W, [8, 13], 2, 4, body);
  return g;
}

// City car: 19 long, stubby nose, tall bubble glasshouse (4 rows), optional
// white roof — the one "cute" silhouette in the mix.
function cityCar(body, twoTone) {
  const W = CW, L = 19, H = 10;
  const g = carBody(W, L, H, 4, body, { roundTail: false });
  cabin(g, { x0: 1, x1: W - 2, zF: 5, zB: L - 1, y0: 5, rows: 4, body, rakeB: 0,
    roof: twoTone ? WHITE : body, pillars: [10] });
  mirrors(g, W, 5, 6, body);
  wheels(g, W, [4, L - 4]);
  return g;
}

function taxi() {
  const g = sedan(C.taxiYellow, { H: 11 });
  const W = CW;
  for (let z = 8; z <= 19; z++) {                           // checker band on the doors
    const c = z & 1 ? C.black : C.signWhite;
    g.set(0, 3, z, c); g.set(W - 1, 3, z, c);
  }
  g.box(3, 9, 12, 6, 9, 15, C.signWhite);                    // roof sign ...
  g.box(3, 9, 12, 6, 9, 12, C.black); g.box(3, 9, 15, 6, 9, 15, C.black); // ... "TAXI" faces
  g.box(4, 10, 13, 5, 10, 14, C.win);                        // lit top (glows at night)
  return g;
}

function police() {
  const W = CW;
  const g = sedan(WHITE, { roof: WHITE, H: 10 });
  for (const x of [0, W - 1]) {
    g.box(x, 1, 0, x, 4, 8, C.navy);                         // navy nose + tail, white doors
    g.box(x, 1, 20, x, 4, 25, C.navy);
    g.box(x, 3, 10, x, 3, 18, BEACON_B);                     // blue door stripe
  }
  for (let x = 1; x < W - 1; x++) for (let z = 0; z < 8; z++) if (g.map.get(x + ',4,' + z) === WHITE) g.set(x, 4, z, C.navy);
  for (let x = 1; x < W - 1; x++) for (let z = 20; z < 26; z++) if (g.map.get(x + ',4,' + z) === WHITE) g.set(x, 4, z, C.navy);
  wheels(g, W, [5, 20]);                                      // re-cut the arches over the new paint
  g.box(1, 9, 13, 3, 9, 14, TAIL);                           // light bar: red | white | blue
  g.box(4, 9, 13, 5, 9, 14, C.signWhite);
  g.box(6, 9, 13, 8, 9, 14, BEACON_B);
  g.box(3, 1, 0, 6, 2, 0, DARK);                             // push bar
  return g;
}

// SUV: tall, boxy, black cladding + wheel arches, roof rails, spare wheel.
function suv(body, rails) {
  const W = CW, L = 25, H = 11;
  const g = carBody(W, L, H, 5, body, { roundTail: false, tailBumper: DARK, nose: { bumper: DARK, grille: C.black } });
  sills(g, W, 1, L - 2, DARK);
  cabin(g, { x0: 1, x1: W - 2, zF: 7, zB: L - 1, y0: 6, rows: 3, body, rakeB: 0, pillars: [13, 19] });
  if (rails) for (let z = 10; z <= L - 3; z++) { g.set(1, 10, z, CHROME); g.set(W - 2, 10, z, CHROME); }
  g.box(3, 2, L - 1, 6, 5, L - 1, TYRE);                     // spare wheel
  g.del(3, 2, L - 1); g.del(6, 2, L - 1); g.del(3, 5, L - 1); g.del(6, 5, L - 1);
  mirrors(g, W, 6, 8, body);
  wheels(g, W, [5, L - 6], 5);
  return g;
}

// Pickup: cab + open bed with a tailgate (and sometimes a load of crates).
function pickup(body, crate) {
  const W = CW, L = 26, H = 9;
  const g = carBody(W, L, H, 4, body, { roundTail: false });
  cabin(g, { x0: 1, x1: W - 2, zF: 7, zB: 14, y0: 5, rows: 3, body, rakeB: 0 });
  for (let x = 1; x <= W - 2; x++) for (let z = 15; z <= L - 2; z++) {  // bed, dark liner
    for (let y = 2; y <= 4; y++) g.del(x, y, z);
    g.set(x, 1, z, DARK);
  }
  if (crate) {
    g.box(2, 2, 17, 4, 5, 20, C.plank); g.box(5, 2, 18, 7, 4, 22, C.wood);
    g.box(2, 5, 18, 4, 5, 18, C.woodDark);
  }
  mirrors(g, W, 5, 8, body);
  wheels(g, W, [5, L - 6]);
  return g;
}

// Panel van: short nose, tall box body, cab side windows, livery stripe +
// a logo patch on the cargo sides, twin rear-door windows. 27 long, 12 tall.
// r11 (the r10 critic: "more car types and colours ... vehicles you can name
// at a glance"): the variant's colour slot picks a trade livery, so a shop's
// kerb can hold ITS van (life.js FLEET): body, stripe, logo icon, roof sign.
const VAN_LIV = () => [
  [WHITE, C.vehRed, C.vehRed, null],                 // 0 courier
  [WHITE, C.blossomDark, C.amber, null],             // 1 bakery: r13 white with a pink band (a pink body read as candy)
  [C.vehRed, C.taxiYellow, C.vehRed, C.taxiYellow],  // 2 pizza: red, yellow band, roof sign
  [C.yellow, C.vehRed, C.vehBlue, null],             // 3 post
  [C.vehGreen, WHITE, C.pink, null],                 // 4 florist: r14 green body, white band, a pink flower
  [C.blue, WHITE, C.blue, null],                     // 5 plumber: r14 blue body (4 of 6 liveries were white vans)
];
function panelVan(seed, paint) {
  const W = CW, L = 27, H = 12;                             // r13: 12 tall (was 13: "oversized vans dominate")
  const liv = VAN_LIV()[seed % 6];
  const body = paint != null ? paint : liv[0];
  const stripe = liv[1] === body ? WHITE : liv[1];
  const g = carBody(W, L, H, 5, body, { roundTail: false });
  g.box(0, 6, 5, W - 1, 9, L - 1, body);                     // box body
  roundCorners(g, W, 5, L - 1, 6, 9);
  cabin(g, { x0: 1, x1: W - 2, zF: 2, zB: 4, y0: 6, rows: 3, body, rakeB: 0, chamfer: false });
  g.box(1, 9, 5, W - 2, 9, 5, body);
  for (const x of [0, W - 1]) {
    g.box(x, 6, 5, x, 8, 9, GLASS); g.box(x, 8, 5, x, 8, 9, GLASS_DK); // cab side window
    g.set(x, 7, 6, GLASS_HI);
    g.box(x, 4, 10, x, 5, L - 2, stripe);                    // livery band (2 rows: reads at iso-mid)
    g.box(x, 6, 13, x, 9, 22, stripe); g.box(x, 7, 14, x, 8, 21, WHITE);  // logo patch
    g.box(x, 7, 17, x, 8, 18, liv[2]);                       // icon
  }
  g.box(0, 10, 6, W - 1, 10, L - 1, body); roundCorners(g, W, 6, L - 1, 10, 10);
  // r14 (the r13 critic: "white boxes with a pink or green roof stripe"): no
  // painted roof logo — the livery lives on the flanks, which now light. A
  // grey roof vent + dark roof bars read as "van" from above instead.
  g.box(3, 11, 8, W - 4, 11, 10, C.stone);
  for (const z of [14, 19, 24]) g.box(1, 11, z, W - 2, 11, z, DARK);   // roof bars (a light rail frame read as a painted outline)
  if (liv[3] != null && paint == null) {                    // pizza roof sign
    g.box(3, 11, 9, 6, 11, 12, liv[3]); g.box(3, 11, 10, 6, 11, 11, C.vehRed);
  }
  g.box(1, 7, L - 1, 3, 8, L - 1, GLASS); g.box(6, 7, L - 1, 8, 8, L - 1, GLASS); // rear doors
  g.box(4, 2, L - 1, 5, 9, L - 1, C.stone);
  mirrors(g, W, 6, 4, body);
  wheels(g, W, [5, L - 6], 5);
  return g;
}

// ---------------------------------------------------------------------------
// Service vehicles, trucks, buses. r10: 11 wide (was 13; compact = 10, the
// lot-stall cousin) and LOWER (the r9 critic: ref05's fire engines are "long,
// low ... with ladder racks and chrome"; ambulances "white with red stripes
// and light bars"). Tyres d 5.
// ---------------------------------------------------------------------------
const SW_ = 11;

// Ambulance: glazed cab + a white box. Red waist band with an orange
// pin-stripe, red crosses on the sides and roof, red / blue light bar on the
// cab and beacons at the box corners, red-white chevrons on the back.
function ambulance(cpt) {
  const W = cpt ? CW : SW_, L = cpt ? 27 : 32, H = 13;
  const xr = W - 1, zb = cpt ? 8 : 9;                         // box starts at zb
  const g = grid(W, H, L, RV);
  tray(g, W, 2, L - 3);
  g.box(0, 1, 0, xr, 5, zb - 1, WHITE);                      // cab lower
  for (let x = 0; x < W; x++) g.del(x, 5, 0);
  g.box(0, 1, zb, xr, 11, L - 1, WHITE);                     // patient box
  roundCorners(g, W, 0, L - 1, 1, 5); roundCorners(g, W, zb, L - 1, 6, 11);
  nose(g, W, 2, 0);
  cabin(g, { x0: 1, x1: xr - 1, zF: 3, zB: zb - 1, y0: 6, rows: 3, body: WHITE, rakeB: 0 });
  // band: red y3..4 + orange y5, all round the flanks
  for (let z = 1; z < L - 1; z++) for (const x of [0, xr]) {
    if (!has(g, x, 4, z)) continue;
    g.set(x, 4, z, TAIL); g.set(x, 3, z, TAIL); if (z >= zb) g.set(x, 5, z, IND);
  }
  g.box(3, 3, 0, xr - 3, 3, 0, TAIL);                        // red grille band
  // crosses (both sides + roof)
  const cz = Math.round((zb + L - 1) / 2);
  for (const x of [0, xr]) {
    g.box(x, 6, cz - 1, x, 10, cz, TAIL); g.box(x, 7, cz - 3, x, 8, cz + 2, TAIL);
    g.box(x, 7, zb + 1, x, 9, zb + 2, GLASS); g.set(x, 9, zb + 1, GLASS_DK); // box front window
  }
  const mx = W >> 1;
  g.box(mx - 1, 11, cz - 3, mx, 11, cz + 2, TAIL); g.box(mx - 3, 11, cz - 1, mx + 2, 11, cz, TAIL);
  // light bar on the cab roof, beacons at the box corners
  g.box(1, 10, zb - 2, 3, 10, zb - 1, TAIL); g.box(4, 10, zb - 2, xr - 4, 10, zb - 1, C.signWhite);
  g.box(xr - 3, 10, zb - 2, xr - 1, 10, zb - 1, BEACON_B);
  g.box(0, 12, zb, 1, 12, zb + 1, TAIL); g.box(xr - 1, 12, zb, xr, 12, zb + 1, BEACON_B);
  g.box(0, 12, L - 2, 1, 12, L - 1, TAIL); g.box(xr - 1, 12, L - 2, xr, 12, L - 1, TAIL);
  // rear: chevrons, twin windows, tails
  for (let x = 1; x < xr; x++) for (let y = 2; y <= 5; y++) g.set(x, y, L - 1, ((x + y) >> 1) & 1 ? TAIL : WHITE);
  g.box(1, 7, L - 1, mx - 1, 10, L - 1, GLASS); g.box(mx + 1, 7, L - 1, xr - 1, 10, L - 1, GLASS);
  g.set(2, 9, L - 1, GLASS_HI); g.set(mx + 2, 9, L - 1, GLASS_HI);
  g.box(1, 1, L - 1, xr - 1, 1, L - 1, CHROME);
  g.box(0, 6, L - 1, 0, 6, L - 1, TAIL); g.box(xr, 6, L - 1, xr, 6, L - 1, TAIL);
  mirrors(g, W, 6, 4, WHITE);
  wheels(g, W, cpt ? [5, L - 6] : [5, L - 7], 5);
  return g;
}

// Fire engine (after ref05's fire-station engines): a long, low red cab-over
// with a WHITE roof and a big dark wrap-round windscreen (centre pillar,
// crew windows behind), red / blue light bar, chrome bumper + ribbed grille,
// white waist band all round, chrome lockers a side, and an aerial ladder —
// white rails, silver rungs with see-through gaps — on dark saddles, from
// over the cab to the turntable at the back. Compact: a fire-rescue van.
function fireTruck(cpt) {
  const W = cpt ? CW : SW_, L = cpt ? 30 : 44, H = 12;
  const xr = W - 1, red = C.fireRed, zc = cpt ? 7 : 10;       // cab z 0..zc
  const mx = W >> 1;
  const g = grid(W, H, L, RV);
  tray(g, W, 2, L - 3);
  g.box(0, 1, 0, xr, 8, zc, red);                             // cab
  g.box(0, 9, 0, xr, 9, zc, WHITE);                           // white cab roof
  g.box(0, 1, zc + 1, xr, 7, L - 1, red);                     // equipment body (lower than the cab)
  roundCorners(g, W, 0, L - 1, 1, 9);
  g.del(0, 9, 0); g.del(xr, 9, 0);
  // wrap-round windscreen y5..8, centre pillar, reflections
  g.box(1, 5, 0, xr - 1, 8, 0, GLASS); g.box(1, 8, 0, xr - 1, 8, 0, GLASS_DK);
  g.box(mx, 5, 0, mx, 8, 0, red);
  for (let k = 0; k < 3; k++) { g.set(2 + k, 5 + k, 0, GLASS_HI); if (mx + 2 + k < xr) g.set(mx + 2 + k, 5 + k, 0, GLASS_HI); }
  for (const x of [0, xr]) {
    g.box(x, 5, 1, x, 8, 4, GLASS); g.box(x, 8, 1, x, 8, 4, GLASS_DK);   // door window
    g.set(x, 7, 2, GLASS_HI);
    if (!cpt) { g.box(x, 5, 6, x, 8, zc - 1, GLASS); g.box(x, 8, 6, x, 8, zc - 1, GLASS_DK); g.set(x, 7, 7, GLASS_HI); }
    g.box(x, 2, 5, x, 4, 5, DARK);                             // door shut-line
    g.set(x, 3, 4, CHROME);                                    // handle
  }
  // front: chrome bumper y1, ribbed chrome grille y2..3, lamps, indicators
  g.box(1, 1, 0, xr - 1, 1, 0, CHROME);
  g.box(3, 2, 0, xr - 3, 3, 0, CHROME);
  for (let x = 4; x <= xr - 3; x += 2) g.box(x, 2, 0, x, 3, 0, C.stone);
  g.box(1, 2, 0, 2, 3, 0, C.lamp); g.box(xr - 2, 2, 0, xr - 1, 3, 0, C.lamp);
  g.set(1, 4, 0, IND); g.set(xr - 1, 4, 0, IND);
  // white waist band all round at y4 (under the glass on the cab)
  for (let z = 0; z < L; z++) for (const x of [0, xr]) if (g.map.get(x + ',4,' + z) === red) g.set(x, 4, z, WHITE);
  // light bar on the cab roof: red, blue centre, red
  for (let x = 1; x < xr; x++) g.set(x, 10, 1, Math.abs(x - mx) <= 1 ? BEACON_B : TAIL);
  g.box(1, 10, 2, xr - 1, 10, 2, C.signWhite);
  // lockers: chrome roller shutters (ribbed), red posts between
  const lockers = cpt ? [[zc + 2, zc + 8], [zc + 10, L - 4]]
    : [[zc + 2, zc + 9], [zc + 11, zc + 19], [zc + 21, L - 4]];
  for (const [a, b] of lockers) for (const x of [0, xr]) {
    g.box(x, 5, a, x, 6, b, CHROME);
    g.box(x, 6, a, x, 6, b, C.stone);
    g.set(x, 5, (a + b) >> 1, DARK);                          // handle
  }
  for (const x of [0, xr]) g.box(x, 1, zc + 1, x, 1, L - 2, CHROME); // sill
  // body top: white rim; aerial ladder on dark saddles, turntable aft
  for (let z = zc + 1; z < L; z++) { g.set(0, 7, z, WHITE); g.set(xr, 7, z, WHITE); }
  const tz0 = L - (cpt ? 7 : 9);
  g.box(2, 8, tz0, xr - 2, 8, L - 2, DARK);                   // turntable
  g.box(3, 9, tz0 + 1, xr - 3, 9, L - 3, CHROME);
  const lz0 = zc - 4, lz1 = L - 2;
  // r10: a narrower ladder (rails at x 3 / xr-3) so the red body top and
  // its white rim show either side, as on ref05's engines
  const la = 3, lb = xr - 3;
  for (let z = zc + 2; z < tz0; z += 5) { g.box(la, 8, z, la, 9, z, DARK); g.box(lb, 8, z, lb, 9, z, DARK); } // saddles
  for (let z = lz0; z <= lz1; z++) {
    g.set(la, 10, z, C.signWhite); g.set(lb, 10, z, C.signWhite);         // rails
    if ((z - lz0) % 2 === 0) g.box(la + 1, 10, z, lb - 1, 10, z, CHROME); // rungs
  }
  g.box(la, 10, lz0, lb, 10, lz0, C.signWhite);               // ladder tip
  // rear: chrome step panel with ribs, tail lamps
  g.box(2, 2, L - 1, xr - 2, 6, L - 1, CHROME);
  for (let y = 3; y <= 6; y += 2) g.box(2, y, L - 1, xr - 2, y, L - 1, C.stone);
  tail(g, W, 2, L - 1, 3);
  g.set(0, 7, 1, CHROME); g.set(xr, 7, 1, CHROME);             // mirrors
  wheels(g, W, cpt ? [5, L - 6] : [5, L - 13, L - 7], 5);
  return g;
}

// Box truck: cab-over + a tall cargo box with a coloured band and a big logo
// panel; ribbed roller door at the back. Compact: little delivery truck.
// r11: liveries by colour slot (life.js fleets line up ONE livery at a depot;
// ref05's logistics yard is rows of orange delivery trucks). The box ROOF is
// the box colour — the iso camera sees the roof first (a white top made every
// orange truck read white).
const BOX_LIV = () => [
  [WHITE, C.orange, C.navy],          // 0 orange delivery (ref05)
  [C.vehRed, WHITE, C.vehRed],        // 1 removals
  [C.vehGreen, WHITE, C.vehGreen],    // 2 grocer
  [C.vehBlue, C.taxiYellow, C.navy],  // 3 toys / parcels
  [C.orange, C.orange, WHITE],        // 4 all-orange
  [WHITE, WHITE, C.vehBlue],          // 5 dairy
];
function boxTruck(seed, cpt) {
  const W = cpt ? CW : SW_, L = cpt ? 28 : 40, H = cpt ? 13 : 15;
  const xr = W - 1, zc = cpt ? 7 : 9;
  const [cab, box, accent] = BOX_LIV()[seed % 6];
  const g = grid(W, H, L, RV);
  tray(g, W, 2, L - 3);
  g.box(0, 1, 0, xr, 9, zc - 1, cab);
  roundCorners(g, W, 0, zc - 1, 1, 9);
  for (let x = 0; x < W; x++) g.del(x, 9, 0);
  g.box(1, 5, 0, xr - 1, 8, 0, GLASS); g.box(1, 8, 0, xr - 1, 8, 0, GLASS_DK);
  for (let k = 0; k < 3; k++) g.set(2 + k, 5 + k, 0, GLASS_HI);
  nose(g, W, 2, 0, { grille: CHROME });
  for (const x of [0, xr]) {
    g.box(x, 5, 2, x, 8, zc - 3, GLASS); g.box(x, 8, 2, x, 8, zc - 3, GLASS_DK);
    g.set(x, 7, 3, GLASS_HI);
  }
  g.box(1, 1, zc, xr - 1, 2, L - 1, DARK);                    // chassis rail
  const bt = H - 2;
  g.box(0, 3, zc, xr, bt, L - 1, box);                        // cargo box
  g.box(0, bt, zc, xr, bt, L - 1, box);                        // roof in the box colour
  for (const x of [0, xr]) g.box(x, bt, zc, x, bt, L - 1, box === WHITE ? C.concrete : WHITE); // top rails
  const la = zc + 3, lb = L - 4;
  for (const x of [0, xr]) {
    g.box(x, 4, la, x, 4, lb, accent);                        // band
    const mz = Math.round((la + lb) / 2), hw = cpt ? 4 : 6;
    g.box(x, 6, mz - hw, x, bt - 2, mz + hw, accent);         // logo panel
    g.box(x, 7, mz - hw + 2, x, bt - 3, mz + hw - 2, WHITE);
    g.box(x, 8, mz - 1, x, bt - 4, mz + 1, accent);
  }
  for (const x of [0, xr]) {                                   // corner posts + rub rail
    g.box(x, 3, zc, x, bt, zc, CHROME); g.box(x, 3, L - 1, x, bt, L - 1, CHROME);
    g.box(x, 3, zc + 1, x, 3, L - 2, DARK);
  }
  for (let z = zc + 4; z < L - 2; z += 6) g.box(1, bt, z, xr - 1, bt, z, box === WHITE ? C.stone : C.concrete); // roof bows
  for (let y = 4; y < bt; y += 2) g.box(1, y, L - 1, xr - 1, y, L - 1, C.stone); // roller door ribs
  tail(g, W, 2, L - 1, 2, DARK);
  mirrors(g, W, 6, 1, DARK);
  wheels(g, W, cpt ? [5, L - 6] : [5, L - 12, L - 7], 5);
  return g;
}

// City bus / school bus. City: body colour lower, dark window band with
// pillars, white upper band + roof, roof A/C pod, lit destination sign,
// kerb-side doors. School: all yellow, black rub rails, a short bonnet,
// red flashers, stop-sign arm. Compact: a 30-long minibus.
function bus(pick, school, cpt) {
  const W = cpt ? CW : SW_, L = cpt ? 30 : 42, H = cpt ? 12 : 14;
  const xr = W - 1;
  const body = school ? C.yellow : pick([C.vehRed, C.vehGreen, C.vehBlue, C.teal, C.orange]);
  const top = H - 2;                                          // roof row
  const g = grid(W, H, L, RV);
  tray(g, W, 2, L - 3);
  const zf = school ? (cpt ? 4 : 6) : 0;                      // bonnet length (school)
  if (zf) {
    g.box(0, 1, 0, xr, 5, zf - 1, body);                      // bonnet
    for (let x = 0; x <= xr; x++) g.del(x, 5, 0);
    g.del(0, 4, 0); g.del(xr, 4, 0);
    g.box(3, 2, 0, xr - 3, 3, 0, CHROME);
    g.box(1, 3, 0, 2, 4, 0, C.lamp); g.box(xr - 2, 3, 0, xr - 1, 4, 0, C.lamp);
    g.box(1, 1, 0, xr - 1, 1, 0, DARK);
  }
  g.box(0, 1, zf, xr, top, L - 1, body);
  roundCorners(g, W, zf, L - 1, 1, top);
  if (!school) g.box(0, top - 1, zf, xr, top, L - 1, WHITE); // white upper band + roof
  g.box(1, top, zf + 1, xr - 1, top, L - 2, school ? body : WHITE);
  // window band y 5..top-2 along the sides, pillars every 5
  const w0 = 5, w1 = top - 2;
  for (const x of [0, xr]) {
    g.box(x, w0, zf + 2, x, w1, L - 3, GLASS); g.box(x, w1, zf + 2, x, w1, L - 3, GLASS_DK);
    for (let z = zf + 6; z < L - 3; z += 5) g.box(x, w0, z, x, w1, z, school ? body : DARK);
    for (let z = zf + 3; z < L - 3; z += 5) { g.set(x, w1 - 1, z, GLASS_HI); g.set(x, w1 - 2, z + 1, GLASS_HI); }
    if (school) { g.box(x, 3, zf, x, 3, L - 1, C.black); g.box(x, w0 - 1, zf, x, w0 - 1, L - 1, C.black); }
    else g.box(x, 3, zf, x, 3, L - 1, WHITE);                 // livery stripe
  }
  // windscreen + destination sign
  const ws0 = zf ? 6 : 3;
  g.box(1, ws0, zf, xr - 1, w1 + 1, zf, GLASS); g.box(1, w1 + 1, zf, xr - 1, w1 + 1, zf, GLASS_DK);
  for (let k = 0; k < 4; k++) g.set(3 + k, ws0 + k, zf, GLASS_HI), g.set(4 + k, ws0 + k, zf, GLASS_HI);
  if (school) {
    g.box(2, top, zf, xr - 2, top, zf, C.black);
    g.box(0, top, zf, 1, top, zf, TAIL); g.box(xr - 1, top, zf, xr, top, zf, TAIL);
    g.box(0, w0, zf + 3, 0, w0 + 1, zf + 4, TAIL); g.set(0, w0, zf + 3, C.signWhite); // stop arm
  } else {
    g.box(2, top, 0, xr - 2, top, 0, C.win);                  // destination sign (lit)
    g.box(1, 2, 0, 2, 2, 0, C.lamp); g.box(xr - 2, 2, 0, xr - 1, 2, 0, C.lamp);
    g.box(3, 1, 0, xr - 3, 1, 0, DARK);
  }
  // kerb-side doors (+X): one behind the front wheel (or at the front), one mid
  const doors = cpt ? [Math.round(L * 0.42)] : [school ? zf + 2 : 1, Math.round(L * 0.52)];
  for (const d of doors) {
    g.box(xr, 1, d, xr, w1, d + 3, GLASS);
    g.box(xr, 1, d, xr, w1, d, CHROME); g.box(xr, 1, d + 3, xr, w1, d + 3, CHROME);
  }
  if (!school && !cpt) g.box(3, top + 1, 12, xr - 3, top + 1, 19, C.concrete); // A/C pod
  // rear window + tails
  g.box(1, w0 + 1, L - 1, xr - 1, w1, L - 1, GLASS);
  tail(g, W, 2, L - 1, 2, DARK);
  mirrors(g, W, w0, zf + 1, DARK);
  wheels(g, W, cpt ? [5, L - 6] : [school ? zf - 1 : 8, L - 8], 5);
  return g;
}

// Ice-cream van: white van with pink stripes, a serving hatch + striped
// awning on the kerb side, a pink roof with a giant cone.
function iceCream(cpt) {
  const B = CW, W = B + 1, L = cpt ? 25 : 29, H = 17;          // x 0..9 body, x 10 awning
  const xr = B - 1;
  const g = grid(W, H, L, RV);
  tray(g, B, 2, L - 3);
  g.box(0, 1, 0, xr, 5, L - 1, WHITE);
  for (let x = 0; x < B; x++) g.del(x, 5, 0);
  g.box(0, 6, 6, xr, 10, L - 1, WHITE);                       // servery
  roundCorners(g, B, 0, L - 1, 1, 10);
  nose(g, B, 2, 0);
  tail(g, B, 3, L - 1);
  cabin(g, { x0: 1, x1: xr - 1, zF: 2, zB: 5, y0: 6, rows: 3, body: WHITE, rakeB: 0 });
  g.box(0, 11, 6, xr, 11, L - 1, WHITE);                      // roof: r13 white with a pink rim (an all-pink lid read as candy)
  for (let z = 6; z < L; z++) { g.set(0, 11, z, C.pink); g.set(xr, 11, z, C.pink); }
  for (let z = 0; z < L; z++) for (const x of [0, xr]) if (has(g, x, 4, z)) { g.set(x, 4, z, C.pink); g.set(x, 3, z, C.blossom); }
  const h0 = 9, h1 = L - 5;
  g.box(xr, 7, h0, xr, 9, h1, C.win);                         // serving hatch (lit)
  g.box(xr, 6, h0, xr, 6, h1, CHROME);                        // counter
  for (let z = h0 - 1; z <= h1 + 1; z++) g.set(B, 10, z, (z >> 1) & 1 ? C.pink : C.signWhite); // awning
  g.box(0, 7, h0, 0, 10, h1, C.pink); g.box(0, 8, h0 + 2, 0, 9, h1 - 2, C.signWhite); // menu board
  // giant cone on the roof
  const cz = Math.round((6 + L - 1) / 2), cx = B >> 1;
  g.box(cx - 1, 12, cz - 1, cx, 13, cz, C.amber); g.set(cx, 12, cz, C.gold);
  g.box(cx - 2, 14, cz - 2, cx + 1, 15, cz + 1, C.pink); g.box(cx - 1, 16, cz - 1, cx, 16, cz, C.pink);
  g.set(cx, 16, cz, C.red);
  mirrors(g, B, 6, 3, WHITE);
  wheels(g, B, [5, L - 6], 5);
  return g;
}

// ---------------------------------------------------------------------------
// stampCar(g, variant, x0, y0, z0, dir, body) — park a little car in a
// building grid (lots with striped stalls, drive-ins, driveways ...).
// Round 5: the r4 critic read the old res-4 lot twins as "rounded two-tone
// candy — no windscreen, no wheels, no lights". A res-4 voxel is too coarse for
// that detail, so lot cars are now the SAME res-12 models the traffic drives:
// stampCar records the car, and when the builder calls g.done() every recorded
// car is laid into one res-12 PART model (model.parts → a child mesh in
// engine.js addBuilding: same footprint + anchor, follows rot / grow / ghost).
// One extra draw call per building, parts cached by content so re-placements
// share geometry. Nothing is written into the building's own voxels.
//   Footprint: 1 × 2.25 world units (res 4: 4 wide × 9 long), the vehicle
//   centred in it; long kinds (bus, fire engine, ambulance, box truck,
//   ice-cream truck) come as their car-length cousins. dir 0 faces -Z, 1 +X,
//   2 +Z, 3 -X; (x0, y0, z0) = min corner (may be fractional, e.g. +0.5 to
//   centre in an odd-width stall); body overrides the paint of everyday kinds.
//   Works through grid wrappers that remap g.set (rot180, mirrors): the
//   mapping is probed. Returns the footprint {w, d} in the grid's voxels.
// stampLotCar(g, x0, y0, z0, dir, body, seed) — same, kind picked from the
// seed (sedan / hatchback / city car / SUV / pickup; taxi-yellow paint → taxi).
// ---------------------------------------------------------------------------
const LOT_GEN = [0, 5, 13, 0, 10, 13, 5, 9];
export function stampLotCar(g, x0, y0, z0, dir, body, seed = 0) {
  const s = ((seed | 0) * 2654435761) >>> 0;
  if (body === C.taxiYellow || body === C.taxiYellow && (s & 3) === 0) return stampCar(g, 1, x0, y0, z0, dir);
  return stampCar(g, LOT_GEN[(s >>> 8) % LOT_GEN.length] + CAR_KINDS * ((s >>> 16) % 7), x0, y0, z0, dir, body);
}

export function stampCar(g, variant, x0, y0, z0, dir = 0, body) {
  const d = ((dir | 0) % 4 + 4) % 4;
  const res = g && g.res > 0 ? g.res : 1, kf = RV / res;
  const fw = RV / kf, fl = 2.25 * RV / kf;                // footprint in grid voxels (1 × 2.25 units)
  const out = (d & 1) ? { w: fl, d: fw } : { w: fw, d: fl };
  const xi = Math.floor(x0), yi = Math.round(y0), zi = Math.floor(z0);
  const P0 = kf >= 1 ? probe(g, xi, yi, zi) : null;
  const ex = P0 && axisProbe(g, P0, xi, yi, zi, 1, 0);
  const ez = P0 && axisProbe(g, P0, xi, yi, zi, 0, 1);
  if (!P0 || !ex || !ez) {                                 // unknown grid: res-4 fallback
    if (res === R) stampLotTwin(g, variant, xi, yi, zi, d, body);
    return out;
  }
  if (!g.__lotCars) hookDone(g);
  // r9: the stall is the car's — a visitor stamped earlier on this spot goes
  // (the r8 critic read a lot with people wedged between cars as a pile-up)
  const rect = [x0, z0, x0 + out.w, z0 + out.d];
  g.__lotCars = g.__lotCars.filter(c => !(c.p != null && c.yi === yi && inRect(rect, c.wx, c.wz, 0.2 * res)));
  g.__lotCars.push({ v: variant | 0, body: body == null ? -1 : body, d, kf, yi, rect,
    cx: x0 - xi + out.w / 2, cz: z0 - zi + out.d / 2, P0, ex, ez });
  return out;
}

// stampPerson(g, cx, y0, cz, seed, dir) — a visitor standing on a building
// lot: the SAME figure life.js walks down the sidewalks (5×5 head, shirt,
// arms, two legs), laid into the building's res-15 lot part like stampCar
// (nothing is written into the building's voxels). (cx, cz) = the spot's
// centre in grid voxels (fractional ok), y0 = the floor row; dir 0..3 as
// stampCar. r8: the lots' own 1-2 voxel people were the "pegs with no head
// or arms" the r7 critic flagged. A spot closer than 0.45 units to one
// already stamped in this grid is skipped (the old helpers relied on their
// voxels to keep crowds apart). Returns true if the person was placed.
export function stampPerson(g, cx, y0, cz, seed = 0, dir = 0) {
  const d = ((dir | 0) % 4 + 4) % 4;
  const res = g && g.res > 0 ? g.res : 1, kf = RV / res;
  if (kf < 1) return false;
  const xi = Math.floor(cx), yi = Math.round(y0), zi = Math.floor(cz);
  const P0 = probe(g, xi, yi, zi);
  const ex = P0 && axisProbe(g, P0, xi, yi, zi, 1, 0);
  const ez = P0 && axisProbe(g, P0, xi, yi, zi, 0, 1);
  if (!P0 || !ex || !ez) return false;
  if (!g.__lotCars) hookDone(g);
  const min = 0.45 * res;
  for (const c of g.__lotCars) {
    if (c.p != null && c.yi === yi && Math.hypot(c.wx - cx, c.wz - cz) < min) return false;
    if (c.rect && Math.abs(c.yi - yi) <= 2 && inRect(c.rect, cx, cz, 0.2 * res)) return false;   // r9: never in a stall
  }
  g.__lotCars.push({ v: ((seed | 0) >>> 0) % 997, p: 1, body: -1, d, kf, yi, wx: cx, wz: cz,
    cx: cx - xi, cz: cz - zi, P0, ex, ez });
  return true;
}

// (x, z) inside rect [x0, z0, x1, z1] grown by m on every side?
function inRect(r, x, z, m) { return x > r[0] - m && x < r[2] + m && z > r[1] - m && z < r[3] + m; }

// Which map key does g.set(x, y, z) write? (null if the write is dropped)
function probe(g, x, y, z) {
  const m = g && g.map;
  if (!m && g && typeof g.set === 'function' && typeof g.done === 'function' && g.sx > 0) {
    // map-less fast grid (commercial.js typed-array grid): identity mapping
    const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
    return xi >= 0 && yi >= 0 && zi >= 0 && xi < g.sx && yi < g.sy && zi < g.sz ? [xi, yi, zi] : null;
  }
  if (!m || typeof m.set !== 'function' || typeof g.set !== 'function') return null;
  let got = null;
  m.set = function (k) { got = k; return this; };
  try { g.set(x, y, z, 0); } catch (_) { got = null; } finally { delete m.set; }
  if (got == null) return null;
  const p = String(got).split(',');
  return p.length === 3 ? [+p[0], +p[1], +p[2]] : null;
}
function axisProbe(g, P0, x, y, z, dx, dz) {
  let q = probe(g, x + dx, y, z + dz), s = 1;
  if (!q) { q = probe(g, x - dx, y, z - dz); s = -1; }
  if (!q) return null;
  const a = [(q[0] - P0[0]) * s, (q[2] - P0[2]) * s];
  return Math.abs(a[0]) + Math.abs(a[1]) === 1 ? a : null;
}

function hookDone(g) {
  g.__lotCars = [];
  const d0 = g.done;
  g.done = function () {
    const m = d0.apply(this, arguments);
    try { attachLotPart(m, this.__lotCars, this.sx, this.sz); } catch (_) { /* never break a building */ }
    return m;
  };
}

// Lay the recorded cars into a res-12 part. The part is exposed through a
// `parts` accessor that follows catalogModel's flipZ of the base (flipZ only
// mirrors the base blocks): a sentinel base block tells whether the base has
// been mirrored, and the matching (pre-mirrored or not) part is returned.
const _lotParts = new Map();
function attachLotPart(m, cars, sx, sz) {
  if (!m || !cars || !cars.length) return;
  const kf = cars[0].kf;
  const key = sx + 'x' + sz + ':' + kf + '|' + cars.map(c =>
    [c.p ? 'p' + c.v : c.v, c.body, c.d, c.cx, c.cz, c.P0.join(':'), c.ex.join(':'), c.ez.join(':')].join(',')).join(';');
  let ent = _lotParts.get(key);
  if (!ent) {
    if (_lotParts.size > 400) _lotParts.clear();
    ent = { cars: cars.slice(), sx, sz, kf, plain: null, flipped: null };
    _lotParts.set(key, ent);
  }
  const blocks = m.blocks || [];
  let sb = null;
  for (let i = 0; i < blocks.length && i < 4096; i++) if (2 * blocks[i][2] !== m.sz - 1) { sb = blocks[i]; break; }
  const sz0 = sb ? sb[2] : 0;
  let extra = Array.isArray(m.parts) ? m.parts.slice() : [];
  Object.defineProperty(m, 'parts', {
    configurable: true, enumerable: true,
    get() {
      const flipped = !!sb && sb[2] !== sz0;
      return extra.concat([lotPart(ent, flipped)]);
    },
    set(v) { extra = Array.isArray(v) ? v.slice() : []; },
  });
}

function lotPart(ent, flipped) {
  const slot = flipped ? 'flipped' : 'plain';
  if (ent[slot]) return ent[slot];
  const { kf, sx, sz } = ent;
  const FX = Math.round(sx * kf), FZ = Math.round(sz * kf);
  let maxY = 1;
  const pts = [];
  for (const c of ent.cars) {
    const vg = c.p ? personGrid(c.v) : vehicleGrid(c.v, { paint: c.body >= 0 ? c.body : undefined, compact: true });
    const WV = vg.sx, LV = vg.sz;
    for (const [key, col] of vg.map) {
      const p = key.split(',');
      const mx = +p[0], my = +p[1], mz = +p[2];
      // model-local offset from the car centre in grid voxels: r = right, f = toward the tail
      const r = (mx + 0.5 - WV / 2) / kf, f = (mz + 0.5 - LV / 2) / kf;
      let dx, dz;
      if (c.d === 0) { dx = r; dz = f; } else if (c.d === 1) { dx = -f; dz = r; }
      else if (c.d === 2) { dx = -r; dz = -f; } else { dx = f; dz = -r; }
      // pre-transform continuous offset from the probed voxel's centre
      const ux = c.cx + dx - 0.5, uz = c.cz + dz - 0.5;
      const gx = c.P0[0] + 0.5 + ux * c.ex[0] + uz * c.ez[0];
      const gz = c.P0[2] + 0.5 + ux * c.ex[1] + uz * c.ez[1];
      const fx = Math.floor(gx * kf), fy = Math.round(c.P0[1] * kf - 0.3) + my; // never float (kf 3.75)
      let fz = Math.floor(gz * kf);
      if (flipped) fz = FZ - 1 - fz;
      if (fy + 1 > maxY) maxY = fy + 1;
      pts.push(fx, fy, fz, col === C.lamp ? C.vehSilver : col);      // parked: lights off
    }
  }
  const part = grid(FX, maxY, FZ, RV);
  for (let i = 0; i < pts.length; i += 4) part.set(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
  const m = small(part.done());
  ent[slot] = m;
  return m;
}

// Fallback for a grid whose g.set mapping cannot be probed: the old res-4
// twin stamped straight into the building's voxels (4 × 4 × 9).
function stampLotTwin(g, variant, x0, y0, z0, d, body) {
  const m = lotCar(variant, body);
  const W = m.sx, L = m.sz;
  for (const [x, y, z, c] of m.blocks) {
    let u, v;                                         // model (x, z) -> footprint
    if (d === 0) { u = x; v = z; }
    else if (d === 1) { u = L - 1 - z; v = x; }
    else if (d === 2) { u = W - 1 - x; v = L - 1 - z; }
    else { u = z; v = W - 1 - x; }
    g.set(x0 + u, y0 + y, z0 + v, c);
  }
}

// The res-4 lot car: tyres + dark sill, one body row with lamps, a glass row
// with pillars (hood and boot in body colour), then the roof.
function lotCar(variant, paint) {
  const vi = variant | 0;
  const k = ((vi % CAR_KINDS) + CAR_KINDS) % CAR_KINDS;
  const rng = mulberry32((vi >>> 0) * 7 + 51);
  const cols = CAR_COLS();
  let body = cols[(rng() * cols.length) | 0], roof = body, van = false, sign = null;
  if (k === 1) { body = roof = C.taxiYellow; sign = C.win; }
  else if (k === 6) { body = C.navy; roof = C.white; sign = C.blue; }
  else if (k === 7) { body = roof = C.white; van = true; sign = C.red; }
  else if (k === 4) { body = roof = C.fireRed; van = true; }
  else if (k === 8 || k === 11) { body = roof = C.white; van = true; }
  else if (k === 2 || k === 12) { body = roof = C.taxiYellow; van = true; }
  else if (k === 13 && rng() < 0.5) roof = C.white;
  if (paint != null) { if (roof === body) roof = paint; body = paint; }
  const W = 4, L = 9, H = van ? 5 : 4;
  const g = grid(W, H, L, R);
  g.box(1, 0, 1, 2, 0, L - 2, C.darkGray);
  for (const z of [1, 2, L - 3, L - 2]) { g.set(0, 0, z, C.black); g.set(W - 1, 0, z, C.black); }
  g.box(0, 1, 0, W - 1, 1, L - 1, body);
  g.set(0, 1, 0, C.lamp); g.set(W - 1, 1, 0, C.lamp);
  g.set(0, 1, L - 1, C.red); g.set(W - 1, 1, L - 1, C.red);
  const top = van ? 3 : 2;
  const zf = van ? 1 : 2, zb = van ? L - 1 : L - 2;
  for (let y = 2; y <= top; y++) {
    g.box(0, y, zf, W - 1, y, zb, C.vehGlass);
    for (const x of [0, W - 1]) { g.set(x, y, zf, body); g.set(x, y, 5, body); if (!van) g.set(x, y, zb, body); }
    if (van && y === top) { g.box(0, y, 6, 0, y, zb, body); g.box(W - 1, y, 6, W - 1, y, zb, body); }
    if (van && y < top) { g.box(0, y, 5, 0, y, zb, body); g.box(W - 1, y, 5, W - 1, y, zb, body); }
  }
  g.set(1, top, zf, C.vehPearl);
  g.box(0, 2, 0, W - 1, 2, zf - 1, body);            // bonnet
  if (!van) g.box(0, 2, zb + 1, W - 1, 2, L - 1, body); // boot
  g.box(0, top + 1, zf + (van ? 0 : 1), W - 1, top + 1, zb - (van ? 0 : 1), roof);
  if (sign != null) g.set(1, top + 1, 4, sign), g.set(2, top + 1, 4, sign);
  return g.done();
}

// ---------------------------------------------------------------------------
// personModel(variant) — little res-11 people, 1.0 units tall (level with a
// car's roof, a head under a van's) and 0.45 wide with arms: 5 wide × 3 deep,
// facing -Z. Adults 11 voxels (legs 4 incl. shoes, torso 4, head 3 incl.
// hair), kids 7 (legs 2, torso 2, head 3). Round 4: the r3 critic read the
// 0.75-unit people as "2-3 voxel stubs that barely read as people" — the
// longer legs and torso give a clear two-legged silhouette at iso zoom, and
// the bright shirt (with a darker collar row + belt) is what catches the eye.
// Varied skin / hair / trousers, skirts, shorts, hats, backpacks.
// ---------------------------------------------------------------------------
export function personModel(variant) { return withBlob(personGrid(variant).done(), BLOB_PED); }
function personGrid(variant) {
  const rng = mulberry32(((variant | 0) >>> 0) * 3 + 201);
  const pick = a => a[(rng() * a.length) | 0];
  const skin = pick([C.skin1, C.skin2, C.skin3, C.skin4, C.skin5]);
  const shirt = pick([C.vehRed, C.vehBlue, C.teal, C.orange, C.purple, C.vehGreen, C.pink,
    C.taxiYellow, C.white, C.blue, C.crimson, C.mint]);
  const pants = pick([C.navy, C.trunkDark, C.stoneDark, C.roofBlue, C.darkGray, C.sandDark]);
  const hair = pick([C.hairBlack, C.hairBrown, C.hairBlonde, C.hairAuburn, C.hairGray, C.hairBlack]);
  const shoe = pick([C.hairBlack, C.white, C.darkGray]);
  const kid = rng() < 0.22;
  const style = rng();                         // < .22 skirt, < .4 shorts
  const hat = rng() < 0.2 ? pick([C.vehRed, C.vehBlue, C.taxiYellow, C.vehGreen, C.white]) : null;
  const longHair = rng() < 0.35;
  const pack = !hat && rng() < 0.2 ? pick([C.orange, C.vehRed, C.vehBlue, C.vehGreen]) : null;
  const sleeve = rng() < 0.5;                  // short sleeves: bare forearms

  // r8 (the r7 critic: "2-3 voxel pegs with no readable head or arms"): a
  // chunky toy figure at res 14, 7 wide × 4 deep — a 5×5×4 head (a third of
  // an adult), shirt torso with arms hanging clear of it, two legs with a gap.
  const legs = kid ? 2 : 3, torso = kid ? 3 : 5, head = kid ? 4 : 5;   // r11: stockier (shorter legs)
  const H = legs + torso + head;
  const g = grid(7, H, 4, RP);
  const t0 = legs, t1 = legs + torso - 1, h0 = t1 + 1, ht = H - 1;
  // legs x 1-2 / 4-5 (gap at 3), z 1..2; shoes one voxel longer at the toe
  for (const x0 of [1, 4]) {
    g.box(x0, 0, 1, x0 + 1, legs - 1, 2, pants);
    g.box(x0, 0, 0, x0 + 1, 0, 2, shoe);
    if (!kid && style < 0.4) g.box(x0, 1, 1, x0 + 1, 1, 2, skin);         // bare shins
  }
  if (!kid && style < 0.22) g.box(1, legs - 1, 0, 5, legs - 1, 3, shirt);  // skirt / dress hem
  // torso x 1..5, z 0..2 + a collar row; belt
  g.box(1, t0, 0, 5, t1, 2, shirt);
  if (style >= 0.22) g.box(1, t0, 0, 5, t0, 2, pants === C.navy ? C.trunkDark : C.darkGray);
  g.box(2, t1, 0, 4, t1, 0, skin);                                          // open collar / neck
  // arms x 0 / 6, z 1..2: sleeve on top, bare forearm or cuff, hand
  for (const x of [0, 6]) {
    g.box(x, t0, 1, x, t1, 1, shirt);
    if (sleeve) g.box(x, t0, 1, x, t1 - 2, 1, skin);
    g.set(x, t0, 1, skin);
  }
  // head x 1..5, y h0..ht, z 0..3: face, eyes, cheeks; hair cap + back + sides
  g.box(1, h0, 0, 5, ht, 3, skin);
  const ey = h0 + (kid ? 1 : 2);
  g.set(2, ey, 0, C.hairBlack); g.set(4, ey, 0, C.hairBlack);
  // r14: no crimson smile pixel — at iso zoom it read as a clown nose
  const top = hat != null ? hat : hair;
  g.box(1, ht, 0, 5, ht, 3, top);
  g.box(1, h0 + 1, 3, 5, ht, 3, hair);
  for (const x of [1, 5]) g.box(x, ht - 1, 1, x, ht - 1, 3, hair);
  if (hat != null) {
    g.box(1, ht - 1, 0, 5, ht - 1, 0, hat);                                 // peak
    if (hat !== C.white) g.set(3, ht, 0, C.signWhite);                      // badge
  } else g.box(1, ht, 0, 5, ht, 0, hair);
  if (longHair && hat == null) { g.box(1, t1 - 1, 3, 5, h0, 3, hair); g.box(1, h0, 2, 1, ht, 3, hair); g.box(5, h0, 2, 5, ht, 3, hair); }
  if (pack) { g.box(2, t0 + 1, 3, 4, t1 - 1, 3, pack); g.set(1, t1, 1, pack); g.set(5, t1, 1, pack); }
  return g;
}

// ---------------------------------------------------------------------------
// birdModel / cloudModel / smokePuffModel
// ---------------------------------------------------------------------------
// A little white gull (res 8, 1 × 0.4 × 0.75 units: a car's width, r7 — at
// res 4 it was bigger than the shrunken cars) — the old res-1 bird was the
// size of a bus and read as a black blob against the buildings.
export function birdModel() {
  const g = grid(8, 3, 6, 8);
  g.box(3, 0, 1, 4, 1, 4, C.signWhite);             // body
  g.box(3, 1, 0, 4, 2, 1, C.signWhite);             // head
  g.set(3, 2, 0, C.hairBlack); g.set(4, 2, 0, C.hairBlack);   // eyes
  g.set(3, 0, 0, C.orange); g.set(4, 0, 0, C.orange);         // beak
  g.box(0, 1, 2, 2, 1, 3, C.offwhite); g.box(5, 1, 2, 7, 1, 3, C.offwhite); // wings
  g.set(0, 1, 2, C.stone); g.set(7, 1, 2, C.stone);           // grey wingtips
  g.box(3, 1, 5, 4, 1, 5, C.stone);                           // tail
  return g.done();
}

export function cloudModel(variant) {
  const v = (((variant | 0) % 4) + 4) % 4;
  const rng = mulberry32(((variant | 0) >>> 0) + 301);
  const w = 4 + v, d = 3 + (v % 2), h = 2;
  const g = grid(w + 1, h, d + 1);
  for (let x = 1; x < w; x++) for (let z = 1; z < d; z++) g.set(x, 0, z, C.white);
  // puffy bumps on top
  const bumps = 2 + v;
  for (let i = 0; i < bumps; i++) {
    const bx = 1 + ((rng() * (w - 1)) | 0), bz = 1 + ((rng() * (d - 1)) | 0);
    g.set(bx, 1, bz, rng() < 0.3 ? C.offwhite : C.white);
  }
  return g.done();
}

// Soft white steam puff (res 4, 1.5 units): a chamfered cuboid with a lighter
// crown — ref05's chimneys breathe clean white, never grey smog.
export function smokePuffModel() {
  const g = grid(6, 5, 6, R);
  g.box(1, 0, 1, 4, 0, 4, C.offwhite);
  g.box(0, 1, 1, 5, 3, 4, C.offwhite); g.box(1, 1, 0, 4, 3, 5, C.offwhite);
  g.box(1, 4, 1, 4, 4, 4, C.signWhite);
  g.box(1, 3, 1, 3, 3, 3, C.signWhite); g.set(0, 3, 2, C.signWhite); g.set(2, 3, 0, C.signWhite);
  return g.done();
}

// ---------------------------------------------------------------------------
// boatModel(variant) — 4 res-6 boats facing -Z, each dragging a baked foam
// wake (ref05's water is flat pool-blue, so a boat only reads with a
// saturated hull + a white V behind it).
//   0 sailboat  1 rowboat  2 mini-ferry  3 speedboat
// Rows: 0 = draft (under water), 1 = waterline / foam row (life.js floats the
// model so row 1's top sits just above the water plane), 2.. = freeboard.
// The grid is padded symmetrically fore/aft, so the model's pivot stays at the
// hull's centre and the wake trails behind the stern.
// ---------------------------------------------------------------------------
// Tapered hull: full half-width aft, pinching to a point over `bow` rows.
function hullHalf(W, z, bow) { return ((W - 1) / 2) * Math.pow(Math.min(1, (z + 0.5) / bow), 0.75); }
function hull(g, W, L, bow, rows, cols, ox = 0, oz = 0) {
  const cx = (W - 1) / 2;
  for (let z = 0; z < L; z++) {
    const half = hullHalf(W, z, bow);
    for (let y = 0; y < rows; y++) {
      const hy = Math.max(0.5, half - (y === 0 ? 1.2 : 0));
      for (let x = 0; x < W; x++) if (Math.abs(x - cx) <= hy + 0.01) g.set(ox + x, y, oz + z, cols[Math.min(y, cols.length - 1)]);
    }
  }
}
function deck(g, W, L, bow, y, rim, fill, ox = 0, oz = 0) {
  const cx = (W - 1) / 2;
  for (let z = 0; z < L; z++) {
    const half = hullHalf(W, z, bow);
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - cx);
      if (d > half + 0.01) continue;
      const edge = d > half - 1 || z === L - 1 || z === 0;
      g.set(ox + x, y, oz + z, edge ? rim : fill);
    }
  }
}

// A boat workspace: hull W × L placed at (ox, oz) inside a grid padded by
// `wk` fore and aft and `sp` either side, so the pivot is the hull centre.
function boatGrid(W, L, H, wk, sp) {
  const g = grid(W + 2 * sp, H, L + 2 * wk, RB);
  return { g, ox: sp, oz: wk, W, L };
}

// Foam: a bow wave hugging the forward hull, a churned strip astern and two
// arms spreading into a V. `k` 0..1 scales it (rowboat small, speedboat big).
function wake(b, bow, k, rng) {
  const { g, ox, oz, W, L } = b;
  const cx = ox + (W - 1) / 2, y = 1;
  const foam = C.signWhite, soft = C.offwhite;
  // bow wave: one-two voxels outboard of the hull over the front third
  for (let z = 0; z < Math.round(L * 0.45); z++) {
    const half = hullHalf(W, z, bow);
    for (const s of [-1, 1]) {
      g.set(Math.round(cx + s * (half + 1)), y, oz + z, foam);
      if (k > 0.3 && z > 1 && z < L * 0.3) g.set(Math.round(cx + s * (half + 2)), y, oz + z, soft);
    }
  }
  g.set(Math.round(cx), y, oz - 1, foam);
  // astern: a solid churned strip fading out + a spreading V
  const n = Math.min(oz, Math.round(4 + 20 * k)), zs = oz + L;
  const half0 = (W - 1) / 2;
  for (let d = 0; d < n; d++) {
    const z = zs + d, t = d / n;
    const cw = Math.max(0, Math.round((1 - t * 1.4) * (1 + 2.5 * k)));      // churn half-width
    for (let dx = -cw; dx <= cw; dx++) if (rng() < 1.1 - t) g.set(Math.round(cx + dx), y, z, rng() < 0.8 ? foam : soft);
    const arm = half0 * 0.7 + d * (0.4 + 0.3 * k);
    for (const s of [-1, 1]) {
      const x = Math.round(cx + s * arm);
      if (rng() < 1.2 - t * 0.7) g.set(x, y, z, t < 0.6 ? foam : soft);
      if (rng() < 0.95 - t * 0.8) g.set(x + s, y, z, soft);
    }
  }
}

export function boatModel(variant) {
  const v = (((variant | 0) % 4) + 4) % 4;
  const rng = mulberry32(((variant | 0) >>> 0) * 5 + 401);
  const pick = a => a[(rng() * a.length) | 0];

  if (v === 0) {
    // sailboat: saturated hull, white boot stripe, teak deck, mast + two sails
    const W = 11, L = 32, H = 32;
    const hc = pick([C.navy, C.vehRed, C.teal, C.vehBlue, C.taxiYellow]);
    const b = boatGrid(W, L, H, 14, 8), { g, ox, oz } = b;
    const P = (x, y, z, c) => g.set(ox + x + 1, y, oz + z, c);          // x 0..8 = centre band
    const B = (x0, y0, z0, x1, y1, z1, c) => g.box(ox + x0 + 1, y0, oz + z0, ox + x1 + 1, y1, oz + z1, c);
    hull(g, W, L, 10, 4, [C.roofRed, hc, hc, C.white], ox, oz);
    deck(g, W, L, 10, 4, hc, C.plank, ox, oz);
    B(2, 5, 17, 6, 6, 25, C.white);                     // cabin top
    B(2, 6, 17, 6, 6, 17, C.vehGlass); for (const z of [19, 21, 23]) { P(6, 5, z, C.vehGlass); P(2, 5, z, C.vehGlass); }
    B(3, 7, 19, 5, 7, 23, hc);                             // coloured coachroof stripe
    for (let y = 5; y < H - 1; y++) P(4, y, 12, C.stone);                // mast
    for (let y = 6; y < H - 2; y++) {                                       // mainsail
      const len = Math.round((H - 2 - y) * 0.5);
      for (let z = 13; z <= 13 + len && z < L - 2; z++) P(4, y, z, C.signWhite);
    }
    const jib = hc === C.taxiYellow ? C.vehRed : pick([C.vehRed, C.orange, C.taxiYellow, C.teal]);
    for (let y = 6; y < H - 5; y++) {                                       // coloured jib
      const len = Math.round((H - 5 - y) * 0.36);
      for (let z = 11 - len; z <= 11; z++) if (z >= 1) P(4, y, z, jib);
    }
    for (let y = 8; y < H - 4; y += 5) for (let z = 14; z < 14 + Math.round((H - 2 - y) * 0.5) && z < L - 2; z++) P(4, y, z, C.offwhite); // sail seams
    for (let z = 13; z < L - 3; z++) P(4, 6, z, C.stone);                // boom
    B(4, H - 1, 12, 4, H - 1, 13, C.vehRed);                               // pennant
    wake(b, 10, 0.3, rng);
    return small(g.done());
  }
  if (v === 1) {
    // rowboat: pointed bright shell, dark inside, two thwarts, oars out
    const W = 7, L = 16, H = 5;
    const wood = pick([C.vehRed, C.teal, C.taxiYellow, C.orange, C.vehGreen]);
    const b = boatGrid(W, L, H, 5, 4), { g, ox, oz } = b;
    const P = (x, y, z, c) => g.set(ox + x, y, oz + z, c);
    hull(g, W, L, 6, 4, [wood, C.white, wood, wood], ox, oz);
    deck(g, W, L, 6, 4, wood, C.plank, ox, oz);                         // coloured gunwale ring
    for (let z = 3; z < L - 1; z++) for (let x = 2; x <= 4; x++) { P(x, 3, z, C.plank); g.del(ox + x, 4, oz + z); }
    for (const z of [7, 11]) g.box(ox + 1, 4, oz + z, ox + 5, 4, oz + z, C.plank);   // thwarts
    for (let x = -3; x <= 0; x++) P(x, 4, 9, C.plank);                     // oars out to the sides
    for (let x = 6; x <= 9; x++) P(x, 4, 9, C.plank);
    P(-3, 3, 9, C.woodDark); P(9, 3, 9, C.woodDark);                       // blades
    P(3, 5, 1, wood); P(3, 4, 0, wood);                                    // raised stem
    wake(b, 6, 0.08, rng);
    return small(g.done());
  }
  if (v === 2) {
    // mini-ferry: coloured hull, white two-deck superstructure, windows, funnel
    const W = 13, L = 38, H = 17;
    const hullC = pick([C.vehBlue, C.navy, C.vehRed, C.teal]);
    const b = boatGrid(W, L, H, 22, 12), { g, ox, oz } = b;
    const P = (x, y, z, c) => g.set(ox + x, y, oz + z, c);
    const B = (x0, y0, z0, x1, y1, z1, c) => g.box(ox + x0, y0, oz + z0, ox + x1, y1, oz + z1, c);
    hull(g, W, L, 8, 4, [C.roofRed, hullC, hullC, C.white], ox, oz);
    deck(g, W, L, 8, 4, C.white, C.lotPave, ox, oz);
    B(1, 5, 9, 11, 8, 30, C.white);                                     // main deck house
    B(1, 6, 10, 1, 7, 29, C.vehGlass); B(11, 6, 10, 11, 7, 29, C.vehGlass);
    for (let z = 12; z < 29; z += 3) { B(1, 6, z, 1, 7, z, C.white); B(11, 6, z, 11, 7, z, C.white); }
    B(2, 6, 9, 10, 7, 9, C.vehGlass); P(4, 7, 9, C.vehPearl); P(8, 6, 9, C.vehPearl);
    B(1, 8, 9, 11, 8, 30, hullC);                                          // coloured band
    B(2, 9, 24, 10, 9, 33, C.skyBlue); B(2, 9, 24, 2, 9, 33, C.white); B(10, 9, 24, 10, 9, 33, C.white); // sun deck
    B(1, 5, 31, 11, 5, 36, C.plank);                                    // aft deck
    B(3, 9, 12, 9, 11, 22, C.white);                                    // bridge
    B(3, 10, 12, 9, 11, 12, C.vehGlass); B(3, 10, 13, 3, 10, 21, C.vehGlass); B(9, 10, 13, 9, 10, 21, C.vehGlass);
    P(5, 11, 12, C.vehPearl);
    B(2, 12, 11, 10, 12, 23, hullC);                                       // bridge roof
    B(5, 13, 16, 7, 14, 17, C.stone);                                    // radar mast
    B(5, 9, 25, 7, 14, 28, C.vehRed); B(5, 14, 25, 7, 14, 28, C.hairBlack); // funnel
    B(5, 12, 25, 7, 12, 28, C.white);
    for (let z = 1; z < L - 1; z += 2) { P(0, 5, z, C.white); P(W - 1, 5, z, C.white); } // rail posts
    P(6, 5, 3, C.orange); P(6, 6, 36, C.orange);                     // life rings
    wake(b, 8, 0.6, rng);
    return small(g.done());
  }
  // speedboat: sleek coloured hull, white deck, windscreen, two seats, outboard
  const W = 9, L = 24, H = 8;
  const acc = pick([C.vehRed, C.vehBlue, C.orange, C.taxiYellow, C.navy]);
  const b = boatGrid(W, L, H, 24, 14), { g, ox, oz } = b;
  const P = (x, y, z, c) => g.set(ox + x, y, oz + z, c);
  const B = (x0, y0, z0, x1, y1, z1, c) => g.box(ox + x0, y0, oz + z0, ox + x1, y1, oz + z1, c);
  hull(g, W, L, 9, 4, [C.white, C.white, acc, acc], ox, oz);
  deck(g, W, L, 9, 4, acc, acc, ox, oz);
  for (let z = 11; z < L - 2; z++) for (let x = 2; x <= 6; x++) P(x, 4, z, C.plank); // cockpit sole
  B(1, 5, 10, 7, 6, 10, C.vehGlass); P(2, 6, 10, C.vehPearl); P(5, 5, 10, C.vehPearl); // windscreen
  B(1, 5, 11, 7, 5, 11, C.white);
  for (let z = 2; z < 10; z++) P(4, 5, z, C.white);                   // bow stripe
  B(2, 5, 13, 3, 5, 14, C.white); B(5, 5, 13, 6, 5, 14, C.white);   // seats
  B(2, 5, 19, 6, 5, 19, C.white);                                    // bench
  B(3, 2, L, 5, 6, L, C.darkGray);                                     // outboard
  B(3, 6, L, 5, 6, L, C.stone);
  B(0, 3, 12, 0, 3, L - 2, C.white); B(W - 1, 3, 12, W - 1, 3, L - 2, C.white); // go-faster stripe
  wake(b, 9, 0.7, rng);
  return small(g.done());
}


// ---------------------------------------------------------------------------
// dogModel(variant) — tiny res-16 dogs (0.19 × 0.25 × 0.375 world units,
// about knee-high to the res-12 people), facing -Z.
// ---------------------------------------------------------------------------
export function dogModel(variant) {
  const coats = [C.trunk, C.woodDark, C.hairBlonde, C.hairBlack, C.offwhite, C.sandDark, C.hairAuburn];
  const vi = (((variant | 0) % coats.length) + coats.length) % coats.length;
  const coat = coats[vi];
  const ear = coat === C.hairBlack ? C.darkGray : coat === C.offwhite ? C.hairBrown : C.trunkDark;
  const g = grid(3, 4, 6, RD);
  for (const z of [1, 4]) { g.set(0, 0, z, coat); g.set(2, 0, z, coat); } // legs
  g.box(0, 1, 1, 2, 2, 4, coat);                                         // body
  g.box(0, 2, 0, 2, 3, 1, coat);                                         // head
  g.set(1, 2, 0, C.hairBlack);                                           // nose
  g.set(0, 3, 0, C.hairBlack); g.set(2, 3, 0, C.hairBlack);              // eyes
  g.set(0, 3, 1, ear); g.set(2, 3, 1, ear);                              // ears
  g.set(1, 3, 5, coat); g.set(1, 2, 5, coat);                            // tail up
  if (vi % 3 === 0) g.box(0, 1, 2, 2, 1, 3, C.white);                 // white belly
  if (vi % 2 === 1) g.set(1, 2, 1, C.vehRed);                            // collar
  return withBlob(g.done(), 0.4);
}

// ---------------------------------------------------------------------------
// balloonModel(variant) — ≥5 bright single balloons (res 8: 0.9 × 2.25 × 0.9
// world units) with a knot and a string.
// ---------------------------------------------------------------------------
export function balloonModel(variant) {
  const cols = [C.vehRed, C.vehBlue, C.vehGreen, C.taxiYellow, C.pink, C.purple, C.orange, C.teal];
  const c = cols[(((variant | 0) % cols.length) + cols.length) % cols.length];
  const S = 7, H = 18;
  const g = grid(S, H, S, 8);
  // chunky rounded cube (the ref's cuboid language): 3×3 → 5×5 → 7×7 (chamfered)
  // → 5×5 → 3×3, a knot and a string
  const ring = (y, r, chamfer) => {
    for (let x = 3 - r; x <= 3 + r; x++) for (let z = 3 - r; z <= 3 + r; z++) {
      if (chamfer && Math.abs(x - 3) === r && Math.abs(z - 3) === r) continue;
      g.set(x, y, z, c);
    }
  };
  ring(8, 1, false); ring(9, 2, true);
  for (let y = 10; y <= 14; y++) ring(y, 3, true);
  ring(15, 2, true); ring(16, 1, false);
  g.set(1, 14, 1, C.signWhite); g.set(1, 13, 1, C.signWhite); g.set(2, 15, 1, C.signWhite); // shine
  g.set(3, 7, 3, c);                                                     // knot
  for (let y = 0; y < 7; y++) g.set(3 + ((y >> 2) & 1), y, 3, C.signWhite); // string (with a kink)
  return small(g.done());
}

// ---------------------------------------------------------------------------
// sparkModel(variant) — ≥6 tiny 2×2×2 glowing burst cubes (vivid palette + 203)
// ---------------------------------------------------------------------------
export function sparkModel(variant) {
  const cols = [C.red, C.yellow, C.blue, C.roofGreen, C.orange, C.pink, C.purple, C.neon, C.gold, C.teal];
  const c = cols[(((variant | 0) % cols.length) + cols.length) % cols.length];
  const g = grid(2, 2, 2);
  g.box(0, 0, 0, 1, 1, 1, c);
  return g.done();
}
