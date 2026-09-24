// Blockville models — catalog dispatch: buildingModel (zoned R/C/I growth),
// the sandbox CATALOG metadata, catalogModel(id, variant) and catalogAnim(id).
// Builders live in the per-category files; each exports a BUILDERS map
// { id: (rng, variant, entry) => model } that is merged here.

import { catRng, flipZ, mulberry32 } from './core.js';
import { residential, BUILDERS as B_RES } from './residential.js';
import { commercial, BUILDERS as B_COM, ANIMS as A_COM } from './commercial.js';
import { industrial, BUILDERS as B_IND, ANIMS as A_IND, VENTS as V_IND } from './industrial.js';
import { BUILDERS as B_CIV, ANIMS as A_CIV } from './civic.js';
import { BUILDERS as B_FUN, ANIMS as A_FUN } from './fun.js';
import { BUILDERS as B_DT } from './downtown.js';

// ---------------------------------------------------------------------------
// buildingModel(zone, level, variant)
// ---------------------------------------------------------------------------
export function buildingModel(zone, level, variant) {
  let Z = String(zone == null ? 'R' : zone).toUpperCase();
  if (Z !== 'R' && Z !== 'C' && Z !== 'I') Z = 'R';
  let L = Math.round(Number(level));
  if (!Number.isFinite(L)) L = 1;
  L = Math.min(3, Math.max(1, L));
  const seed = ((((variant | 0) >>> 0) ^ (Z.charCodeAt(0) * 131) ^ (L * 977)) >>> 0) || 1;
  const rng = mulberry32(seed);
  if (Z === 'R') return residential(L, rng);
  if (Z === 'C') return commercial(L, rng);
  return industrial(L, rng);
}

// --- builder dispatch + catalog entries ------------------------------------
const BUILDERS = Object.assign({}, B_RES, B_COM, B_IND, B_CIV, B_FUN, B_DT);
const ANIMS = Object.assign({}, A_COM, A_IND, A_CIV, A_FUN);

export const CATALOG = {
  homes: [
    { id: 'small-house', name: 'Small House', emoji: '🏠', tw: 1, td: 1, cap: 3, variants: 4 },
    { id: 'cottage', name: 'Cottage', emoji: '🏡', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'big-house', name: 'Big House', emoji: '🏘️', tw: 1, td: 1, cap: 5, variants: 3 },
    { id: 'townhouse', name: 'Townhouse', emoji: '🏙️', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'duplex', name: 'Duplex', emoji: '🏚️', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'cabin', name: 'Log Cabin', emoji: '🛖', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'farmhouse', name: 'Farmhouse', emoji: '🚜', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'beach-house', name: 'Beach House', emoji: '🏖️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'apartment', name: 'Apartment', emoji: '🏢', tw: 1, td: 1, cap: 12, variants: 3 },
    { id: 'tall-apartment', name: 'Tall Apartments', emoji: '🏬', tw: 1, td: 1, cap: 18, variants: 3 },
    { id: 'condo-tower', name: 'Condo Tower', emoji: '🌆', tw: 2, td: 2, cap: 30, variants: 2 },
    { id: 'mansion', name: 'Mansion', emoji: '🏰', tw: 2, td: 2, cap: 10, variants: 2 },
  ],
  shops: [
    { id: 'bakery', name: 'Bakery', emoji: '🥐', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'ice-cream', name: 'Ice Cream', emoji: '🍦', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'pizza', name: 'Pizza Place', emoji: '🍕', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'burger', name: 'Burger Joint', emoji: '🍔', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'cafe', name: 'Café', emoji: '☕', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'toy-store', name: 'Toy Store', emoji: '🧸', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'pet-shop', name: 'Pet Shop', emoji: '🐾', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'book-shop', name: 'Book Shop', emoji: '📚', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'flower-shop', name: 'Flower Shop', emoji: '🌸', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'grocery', name: 'Grocery', emoji: '🛒', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'market-stall', name: 'Market Stall', emoji: '🍎', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'arcade', name: 'Arcade', emoji: '🕹️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'cinema', name: 'Cinema', emoji: '🎬', tw: 2, td: 1, cap: 6, variants: 2 },
    { id: 'mall', name: 'Mall', emoji: '🏬', tw: 3, td: 3, cap: 10, variants: 2 },
    { id: 'candy-shop', name: 'Candy Shop', emoji: '🍭', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'music-store', name: 'Music Store', emoji: '🎵', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'sports-shop', name: 'Sports Shop', emoji: '⚽', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'barber', name: 'Barber Shop', emoji: '💈', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'diner', name: 'Diner', emoji: '🍽️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'fruit-stand', name: 'Fruit Stand', emoji: '🍎', tw: 1, td: 1, cap: 2, variants: 3 },
  ],
  factories: [
    { id: 'workshop', name: 'Workshop', emoji: '🔧', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'toy-factory', name: 'Toy Factory', emoji: '🎁', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'chocolate-factory', name: 'Chocolate Factory', emoji: '🍫', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'robot-factory', name: 'Robot Factory', emoji: '🤖', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'rocket-lab', name: 'Rocket Lab', emoji: '🚀', tw: 2, td: 2, cap: 6, variants: 2 },
    { id: 'sawmill', name: 'Sawmill', emoji: '🪵', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'warehouse', name: 'Warehouse', emoji: '📦', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'recycling-center', name: 'Recycling Center', emoji: '♻️', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'mega-factory', name: 'Mega Factory', emoji: '🏭', tw: 3, td: 3, cap: 10, variants: 2 },
    { id: 'cheese-factory', name: 'Cheese Factory', emoji: '🧀', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'crayon-factory', name: 'Crayon Factory', emoji: '🖍️', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'balloon-factory', name: 'Balloon Factory', emoji: '🎈', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'car-factory', name: 'Car Factory', emoji: '🚗', tw: 1, td: 1, cap: 5, variants: 3 },
    { id: 'bakery-plant', name: 'Bakery Plant', emoji: '🍩', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'greenhouse-farm', name: 'Greenhouse Farm', emoji: '🌱', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'juice-factory', name: 'Juice Factory', emoji: '🧃', tw: 1, td: 1, cap: 4, variants: 3 },
    { id: 'cookie-factory', name: 'Cookie Factory', emoji: '🍪', tw: 1, td: 1, cap: 4, variants: 3 },
  ],
  fun: [
    { id: 'park', name: 'Park', emoji: '🌳', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'school', name: 'School', emoji: '🏫', tw: 2, td: 2, cap: 6, variants: 3 },
    { id: 'fire-station', name: 'Fire Station', emoji: '🚒', tw: 2, td: 2, cap: 5, variants: 3 },
    { id: 'fountain', name: 'Fountain', emoji: '⛲', tw: 2, td: 2, cap: 1, variants: 3 },
    { id: 'playground', name: 'Playground', emoji: '🛝', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'swimming-pool', name: 'Swimming Pool', emoji: '🏊', tw: 2, td: 2, cap: 3, variants: 3 },
    { id: 'wind-power', name: 'Wind Power', emoji: '🌬️', tw: 1, td: 1, cap: 1, variants: 3 },
    { id: 'stadium', name: 'Stadium', emoji: '🏟️', tw: 4, td: 4, cap: 10, variants: 2 },
    { id: 'ferris-wheel', name: 'Ferris Wheel', emoji: '🎡', tw: 3, td: 3, cap: 8, variants: 2 },
    { id: 'zoo', name: 'Zoo', emoji: '🦒', tw: 3, td: 3, cap: 8, variants: 2 },
    { id: 'carousel', name: 'Carousel', emoji: '🎠', tw: 2, td: 2, cap: 3, variants: 2 },
    { id: 'water-slide', name: 'Water Slide', emoji: '🛝', tw: 1, td: 1, cap: 3, variants: 3 },
    { id: 'mini-golf', name: 'Mini Golf', emoji: '⛳', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'skate-park', name: 'Skate Park', emoji: '🛹', tw: 1, td: 1, cap: 2, variants: 3 },
    { id: 'museum', name: 'Museum', emoji: '🏛️', tw: 3, td: 2, cap: 8, variants: 2 },
    { id: 'carnival-games', name: 'Carnival Games', emoji: '🎪', tw: 2, td: 1, cap: 6, variants: 2 },
  ],
  deco: [
    { id: 'flower-bed', name: 'Flower Bed', emoji: '🌼', tw: 1, td: 1, cap: 0, variants: 4 },
    { id: 'bench', name: 'Bench', emoji: '🪑', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'fence', name: 'Picket Fence', emoji: '🚧', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'hedge', name: 'Hedge', emoji: '🌳', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'streetlight', name: 'Streetlight', emoji: '💡', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'statue', name: 'Statue', emoji: '🗿', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'stone-path', name: 'Stone Path', emoji: '🪨', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'picnic-table', name: 'Picnic Table', emoji: '🧺', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'mailbox', name: 'Mailbox', emoji: '📮', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'pond', name: 'Pond', emoji: '🦆', tw: 1, td: 1, cap: 0, variants: 3 },
    { id: 'flag-pole', name: 'Flag Pole', emoji: '🚩', tw: 1, td: 1, cap: 0, variants: 4 },
  ],
  downtown: [
    // 1×1 slim towers
    { id: 'small-office', name: 'Small Office', emoji: '🏢', tw: 1, td: 1, cap: 6, variants: 3 },
    { id: 'glass-office', name: 'Glass Office', emoji: '🔷', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'brick-highrise', name: 'Brick Highrise', emoji: '🧱', tw: 1, td: 1, cap: 7, variants: 3 },
    { id: 'deco-tower', name: 'Deco Tower', emoji: '🗼', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'green-glass-tower', name: 'Green Tower', emoji: '🟢', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'clock-tower', name: 'Clock Tower', emoji: '🕰️', tw: 1, td: 1, cap: 7, variants: 3 },
    { id: 'round-tower', name: 'Round Tower', emoji: '🛢️', tw: 1, td: 1, cap: 8, variants: 3 },
    { id: 'hotel', name: 'Grand Hotel', emoji: '🏨', tw: 1, td: 1, cap: 7, variants: 3 },
    // 2×1 office blocks
    { id: 'office-block', name: 'Office Block', emoji: '🏢', tw: 2, td: 1, cap: 8, variants: 2 },
    { id: 'shopping-office', name: 'Shops & Offices', emoji: '🛍️', tw: 2, td: 1, cap: 8, variants: 2 },
    // 2×2 big skyscrapers
    { id: 'glass-skyscraper', name: 'Glass Skyscraper', emoji: '🏙️', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'dark-skyscraper', name: 'Black Tower', emoji: '🌃', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'corporate-hq', name: 'Corporate HQ', emoji: '🏦', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'twin-setback', name: 'Twin Towers', emoji: '🏬', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'spire-tower', name: 'Spire Tower', emoji: '📡', tw: 2, td: 2, cap: 10, variants: 2 },
    { id: 'tech-campus', name: 'Tech Campus', emoji: '💻', tw: 2, td: 2, cap: 9, variants: 2 },
    { id: 'city-bank', name: 'City Bank', emoji: '🏛️', tw: 2, td: 2, cap: 10, variants: 2 },
  ],
};

// flat id -> entry lookup (built once)
export const _ENTRY_BY_ID = {};
for (const cat in CATALOG) for (const e of CATALOG[cat]) _ENTRY_BY_ID[e.id] = e;

// catalogModel(id, variant) -> voxel model with tw/td set, or null for unknown id
// Small LRU memo (res r4): the same (id, variant) returns the SAME model
// object, so engine._geoCache (a WeakMap keyed by model) meshes it once —
// a second copy of a building, the ghost preview on every hovered tile and
// the demo city all reuse the geometry instead of re-meshing (res-8 homes
// cost 50-900 ms to mesh). Models are deterministic per (id, variant), and
// callers only read them. Bounded so rarely used voxel arrays are released.
const _memo = new Map();
const MEMO_MAX = 24;
export function catalogModel(id, variant) {
  const key = String(id == null ? '' : id);
  const entry = _ENTRY_BY_ID[key];
  const build = BUILDERS[key];
  if (!entry || !build) return null;
  const v = (variant | 0);
  const mk = key + '#' + v;
  const hit = _memo.get(mk);
  if (hit) { _memo.delete(mk); _memo.set(mk, hit); return hit; }
  const m = build(catRng(key, v), v, entry);
  if (!m || typeof m !== 'object') return null;
  flipZ(m);                 // normalize: front -> +Z (max-Z) face
  m.tw = entry.tw; m.td = entry.td;
  _memo.set(mk, m);
  if (_memo.size > MEMO_MAX) _memo.delete(_memo.keys().next().value);
  return m;
}

// ---------------------------------------------------------------------------
// catalogAnim(id) -> null | { part, ox,oy,oz, ax,ay,az, speed }
// part = voxel model of the MOVING piece only (the matching catalogModel base
// no longer contains it). (ox,oy,oz) = part-center offset in WORLD units from
// the footprint center at ground. (ax,ay,az) = unit axis in MODEL-LOCAL space.
// Each part is authored so its own model center is the natural pivot.
// ---------------------------------------------------------------------------
// catalogVents(id, variant) -> [[ox,oy,oz], ...] chimney mouths (WORLD units
// from the footprint centre at ground, model-local like catalogAnim offsets),
// [] for a smoke-free building, or null when the id has no vent data (life.js
// then falls back to its per-tile smoke).
export function catalogVents(id, variant) {
  const key = String(id == null ? '' : id);
  const f = Object.prototype.hasOwnProperty.call(V_IND, key) ? V_IND[key] : null;
  return f ? f(variant | 0) : null;
}

export function catalogAnim(id) {
  const key = String(id == null ? '' : id);
  const make = Object.prototype.hasOwnProperty.call(ANIMS, key) ? ANIMS[key] : null;
  return make ? make() : null;
}
