# BLOCKVILLE v2 — SANDBOX REWORK CONTRACT (supplements CONTRACTS.md)

Blockville becomes a PURE SANDBOX: no economy, no money, no costs, no unlocks, no
milestones, no zones. Kids pick a specific building from a category and place it
instantly. Population remains as a cosmetic stat (drives cars/pedestrian density).
Day/night cycle, autosave, cars/peds/birds/clouds/smoke all stay.

## Multi-tile footprints
Buildings may occupy tw×td TILES (1×1, 1×2, 2×1, 2×2). The placement anchor is the
NW corner tile (min x, min z). All footprint tiles must be GRASS and unoccupied.
Voxel canvas for a footprint: up to (tw*8-1) × height × (td*8-1) voxels
(leave ≥ half-voxel border). Height caps: 1×1 ≤ 24, 2×2 ≤ 30.

## models.js — NEW exports (KEEP all existing exports working: roadModel, treeModel,
serviceModel, carModel, personModel, birdModel, cloudModel, smokePuffModel,
constructionModel, PALETTE, buildingModel)

```js
export const CATALOG = {
  homes:     [ ENTRY, ... ],   // ≥ 10 types
  shops:     [ ENTRY, ... ],   // ≥ 12 types
  factories: [ ENTRY, ... ],   // ≥ 9 types
  fun:       [ ENTRY, ... ],   // ≥ 8 types (park, school, fire station, fountain,
                               //   stadium, wind power, playground, ferris wheel, pool…)
}
// ENTRY = { id:'mansion', name:'Mansion', emoji:'🏰', tw:2, td:2, cap:8, variants:3 }
//   id: kebab, unique across ALL categories. name: short kid-readable.
//   emoji: single emoji for the UI card. cap: population added when placed
//   (homes 2..30 by size; shops/factories/fun use cap for "workers", 1..10).
//   variants: how many distinct looks (≥3 for 1×1, ≥2 for larger).
export function catalogModel(id, variant) // -> voxel model {sx,sy,sz,blocks,tw,td}
//   MUST set model.tw/model.td. Deterministic per (id,variant). Unknown id -> null.
```

Suggested types (adapt freely, keep the spirit — every type visually DISTINCT):
- homes: small-house, big-house, cottage, townhouse, duplex, cabin, apartment,
  tall-apartment, condo-tower (2×2), mansion (2×2), farmhouse, beach-house
- shops: bakery, ice-cream, pizza, burger, cafe, toy-store, pet-shop, book-shop,
  flower-shop, grocery, arcade, cinema (2×1), mall (2×2), market-stall
- factories: workshop, toy-factory, chocolate-factory, robot-factory, rocket-lab,
  sawmill, bottling-plant, warehouse, mega-factory (2×2), recycling-center
- fun: park, school, fire-station, fountain, playground, swimming-pool,
  stadium (2×2), ferris-wheel (2×2), wind-power, zoo (2×2)
Signature details per type (awnings, signs, chimneys, cones on ice-cream shop,
rocket on the lab, animals implied at zoo, glowing windows 200/201, neon 203).

## sim.js — REWRITE as sandbox. Same file, `export class Sim`.
```js
state = {
  map, zoneOf, level, variant,      // same Uint8Arrays — see mapping below
  buildings: [],                    // [{bid, type, cat, x, z, tw, td, variant}]
  nextBid: 1,
  pop: 0, day: 1, clock: 0.3, speed: 1,
  occ: Int32Array(N*N),             // building bid occupying tile, 0 = free
}
```
Map mapping (KEEPS engine ground + life.js working unchanged): every tile covered
by a building stays `map = T.BLDG`; `zoneOf` = T.ZONE_R for homes, T.ZONE_C for
shops, T.ZONE_I for factories (life.js smoke keys off ZONE_I), T.ZONE_C for fun.
Roads/trees/water/sand/grass in map as before. The old service tile types
(T.PARK etc.) are NO LONGER placed — fun buildings are catalog buildings.

API:
- constructor(seed?) — same terrain gen (river, sand, ~40 trees).
- place(entry, x, z, variant?) -> {ok, reason?, bid} — entry is a CATALOG ENTRY
  (has id, cat, tw, td, cap). Validates bounds/terrain/occupancy. Picks random
  variant if not given. Updates occ/map/zoneOf/buildings, pop += cap,
  pushes event {type:'placed', bid, entry, x, z, variant}.
- placeRoad(x,z) / placeTree(x,z) -> {ok, reason?} (road on grass/sand; tree on grass)
- bulldoze(x,z) -> {ok, removed?} — removes the building covering (x,z) (whole
  footprint, pop -= cap, event {type:'removed', bid, x, z, tw, td}) or road/tree.
- tick(dt) -> events DRAINED (never return the same event twice). Only clock/day
  now — no growth, no economy. Keep piggy/milestone/upgrade logic DELETED.
- events() — drain (tick already drains; events() for symmetry).
- roadGraph() — unchanged semantics.
- save()/load(str) — new format {v:2, seed, day, clock, roads+trees from map,
  buildings list}. load returns false for anything else (incl. old v1 saves).
- _selfTest() — place several buildings incl. a 2×2, overlap rejection, bulldoze
  restores grass, save/load roundtrip, tick drains. Run in node until {ok:true}.

## ui.js — REWRITE toolbar as categories. Same file, same init pattern.
```js
initUI({onTool(tool), onSpeed(s), onNew(), onMute()}) -> ui
// tool is now: null | 'road' | 'tree' | 'bulldoze' | {id, cat, ...entry}  (catalog entry object)
ui.setStats({pop, day, clockLabel})        // NO money, NO happiness
ui.setActiveTool(toolOrNull)               // matches by entry.id for catalog tools
ui.setCatalog(CATALOG)                     // called once at boot, builds the drawers
ui.toast(text, emoji?) ; ui.celebrate(...) // keep (used rarely)
ui.showWelcome()                           // update copy: "1. 🛣️ Draw roads,
                                           //  2. 🏠 Pick buildings and place them!
                                           //  3. 👀 Watch your city come alive!"
```
Bottom bar: category tabs — 🛣️ Road · 🏠 Homes · 🏪 Shops · 🏭 Factories ·
🎡 Fun · 🌳 Tree · 🧹 Erase. Road/Tree/Erase are direct tools. Tapping a category
tab opens a DRAWER above the bar: horizontally scrollable cards (≥64px), each =
entry.emoji + entry.name; 2×2 buildings show a tiny "2×2" size badge. Tap card →
onTool(entry), card highlighted; tap again → deselect (onTool(null)). Drawer
closes when another tab opens or on map tap? NO — stays open while placing
(kids place many). Close button (✕) on the drawer. NO cost badges, NO locks.
Top bar: 👥 pop · 📅 day + clock, speed ⏸️▶️⏩, 🔊, 🆕. Keep styling/safe-areas.

## Unchanged modules
engine.js — main.js passes anchor-tile + model with tw/td; engine centers over the
footprint (handled by integrator). life.js, audio.js unchanged (milestone/coin/piggy
sounds simply stop being triggered; 'built' sound reused for placement).

## main.js (integrator-owned) — rewiring summary
Tool routing: 'road'→placeRoad, 'tree'→placeTree, 'bulldoze'→bulldoze, entry→place.
Drag paints roads/trees/bulldoze continuously; catalog buildings place per new tile
under the pointer (footprint-collision prevents spam). Ghost previews footprint.
Rebuild-from-save iterates state.buildings.

# ── v2.1 ADDENDUM — road-facing placement + category redo ──────────────────

## Facing convention (models.js — ALL catalog models)
Every catalog model has a FRONT: the side with the door / entrance / sign /
marquee. The front MUST be the +Z side (max-Z face) of the model, for every
type and variant, homes included. (Cars/people keep their existing -Z-forward
convention — this rule is for catalogModel output only.)

## Rotation (sim.js decides, engine renders)
rot k ∈ {0,1,2,3} = k×90° around Y; front faces: 0→S(+Z), 1→E(+X), 2→N(−Z), 3→W(−X).
Effective footprint: k odd swaps tw/td (etw=td, etd=tw). Anchor (x,z) is always
the NW corner of the EFFECTIVE footprint.

New sim API:
- plan(entry, x, z) -> {ok, reason?, rot, etw, etd}
  Tries rotations; for each k where the effective footprint fits (bounds, grass,
  unoccupied), counts ROAD tiles directly adjacent to the FRONT edge for that k
  (front edge for k=0 is the z = z+etd row spanning x..x+etw−1; k=1 the x+etw
  column; k=2 the z−1 row; k=3 the x−1 column). Picks the valid k with the most
  front-edge road tiles; tie/no-road → first valid in order 0,1,2,3.
- place(entry, x, z, variant?) uses plan() internally; stores rot on the
  building record; event {type:'placed', ..., rot, etw, etd}. 'removed' event
  reports the effective tw/td it occupied.
- save: building entries gain r (omit when 0); load applies it (missing r → 0).

## engine.js (integrator-owned)
addBuilding(id, model, x, z, yScale, rot) / setGhost(model, x, z, ok, rot):
mesh.rotation.y = rot*π/2, centered over the effective footprint.

## Category redo (models.js)
Shops, Factories, Fun get the same richness bar as Homes: improve existing art
AND extend — shops ≥ 18, factories ≥ 14, fun ≥ 14 types. Keep existing ids
stable (saves reference them); new types add new ids. Homes stay 12 but get the
front-normalization pass (and any art touch-ups needed).

# ── v2.2 ADDENDUM — "do it all" pack ────────────────────────────────────────
Bridges, animated buildings, Deco category, undo, boats/dogs/balloons/fireworks,
weather+seasons, photo postcard, sticker book. APIs below are binding.

## models.js
- CATALOG.deco: NEW 5th category, ≥10 types, all 1×1, cap:0, variants ≥3:
  flower-bed, bench, fence, hedge, streetlight (202 glow head), statue,
  stone-path (flat), picnic-table, mailbox, pond, flag-pole… charming, small.
- export function catalogAnim(id) -> null | {part, ox, oy, oz, ax, ay, az, speed}
  part = voxel model of the MOVING piece only (base model must NOT contain it).
  (ox,oy,oz) = part-center offset in world units from the building's footprint
  center at ground level. (ax,ay,az) = unit rotation axis in MODEL-LOCAL space.
  speed = rad/s. Provide for: ferris-wheel (wheel+gondolas, horizontal X axis),
  carousel (canopy+horses, Y), wind-power (rotor, front-facing axis), fountain
  (sparkle ring, Y, slow), barber (pole, Y, fast). Others → null.
- export function bridgeModel(mask) — road-over-water piece, 8×?×8: wooden plank
  deck at y=0 (light warm wood, dashed center optional), railings y=1..2 along
  the two NON-connected edges + corner posts. mask bits as roadModel. All y ≥ 0.
- export function boatModel(variant) ≥3 (sailboat, rowboat, mini-ferry), face −Z,
  ≤6 long, sits so hull bottom ≈ y0. dogModel(variant) ≥3 tiny (≤3×3×4).
  balloonModel(variant) ≥5 bright colors (balloon + string, ≤3×6×3).
  sparkModel(variant) ≥6 — tiny 2×2×2 glowing burst cube (bright/neon colors).
- Self-test covers all new generators + deco entries.

## sim.js — bridges only
- state.bridge = Uint8Array(N*N); 1 = road tile over water.
- placeRoad(x,z): now ALSO ok on WATER (occ must be 0) → map=T.ROAD, bridge=1.
  Grass/sand behaviour unchanged (bridge stays 0).
- bulldoze of a road tile with bridge=1 → restores T.WATER (bridge=0).
- save(): add bridges:[i,…] (omit when empty); load(): restore (missing → none);
  still v:2. roadGraph/plan unchanged (bridge tiles are ROAD → count normally).
- Deco entries need no sim changes (generic place(), cap 0).

## engine.js
- clearWorld(): remove + dispose ALL building meshes and props (ghost hidden).
  Ground chunks may stay (buildGround rebuilds them).
- makeSpinner(model) -> {setPos(x,y,z), setBaseYaw(rad), setSpin(ax,ay,az,rad),
  setVisible(b), dispose()} — rotation = quat(baseYaw about world Y) ∘
  quat(local axis, rad). Shares geometry cache like makeDynamic.
- buildGround/refreshTile: a tile with state.bridge[i]===1 renders as WATER
  (animated), not asphalt — the deck comes from a 'road' prop (bridgeModel).
- setWeather({tint, rain, snow}): tint = [r,g,b] multiplier (≈0.7..1.2 each)
  applied to ground grass colors via a uniform (onBeforeCompile like uNight);
  rain/snow ∈ 0..1 drive a looping precipitation layer over the visible area
  (~600 instanced thin streaks for rain — fast, bluish; chunky white flakes for
  snow — slow drift). 0 = hidden, no cost. Rain also grays the sky slightly
  (multiply sky color toward gray by rain*0.35). Animate in render(dt).
- All existing APIs unchanged.

## life.js (models via injected namespace; buildings via state.buildings)
- BOATS: ≤3 when the map has ≥25 WATER tiles (exclude bridge tiles — they're
  ROAD in map). Drift tile-to-tile through 4-adjacent water, 1.5–2.5 u/s,
  hull at y≈−0.2, face travel (−Z convention). boatModel.
- DOGS: ~25% of road pedestrians get a dog (dogModel) trailing ~1.5 units
  behind, same path, little bob.
- BALLOONS: each building of type 'balloon-factory' releases a balloonModel
  every 2–3 s from its roof (start y≈10) rising to y≈35 with sideways drift,
  then dispose. Pool cap 12.
- FIREWORKS: at night only (clock<0.25||>0.78): sites = buildings of type
  'stadium' | 'ferris-wheel' | 'carnival-games'. Per site every 4–8 s (max 2
  bursts airborne globally): one spark rises from the site to y 30–40 in ~1 s,
  then bursts into 8–12 sparkModel dynamics flying outward with gravity,
  disposed after ~0.9 s. Pool everything (≤60 spark handles).
- update()/sync() signatures unchanged; all defensive; counts scale with
  setDensityScale.

## ui.js
- hooks add onUndo(), onPhoto(). Top bar adds ↩️ (undo), 📷 (photo),
  📖 (sticker book — opens internally). Keep everything else.
- Deco tab: 🌼 Deco in the category tabs between Fun and Tree (CATALOG.deco).
- ui.setStickers(placedSet /* Set of type ids */) — store; 📖 overlay shows all
  catalog entries grouped by category: collected = full color emoji + name,
  uncollected = dimmed/grayscale with the name hidden ("?"), header counter
  "N / M collected". Kid-friendly, scrollable, ✕ closes.
- ui.showPostcard(dataURL, cityName, day) — overlay: framed snapshot, bouncy
  banner "🏙️ <cityName> — Day <day>", buttons [💾 Save picture] (a[download]
  PNG) and ✕; small hint "on iPad: press and hold the picture to save".
- ui.askCityName(current, onDone(name)) — cute dialog, text input maxlength 20,
  big [That's it! ✨] button; onDone gets trimmed name (fallback 'Blockville').

## main.js (integrator-owned)
Undo = snapshot stack of sim.save() (push on pointerdown + per debug paint,
cap 25; onUndo → sim.load + clearWorld + rebuild). Weather director: season =
floor((day−1)/3)%4 (spring/summer/fall/winter tints); daily roll — rain 25%
(snow 40% in winter); engine.setWeather lerped. Spinner registry from
catalogAnim on place/remove/rebuild. Sticker set persisted in localStorage,
"New sticker!" toast on first placement of a type. Photo: render → toDataURL →
ui.showPostcard (city name via askCityName once, stored in localStorage).
Bridge visuals: road props use bridgeModel(mask) when state.bridge[i].

# ── v3.1 ADDENDUM — bigger map + bigger buildings ───────────────────────────
constants.js N is now 64 (was 48) — the map is a third bigger. Footprints may
now exceed 2×2 (up to 4×4). Height caps rise. All modules must scale with N.

## Footprints & height caps (models.js + contract)
Allowed footprints: 1×1, 2×1/1×2, 2×2, 3×2/2×3, 3×3, 4×3/3×4, 4×4.
Voxel canvas per footprint: (tw*8-1) wide × height × (td*8-1) deep.
Height caps by max(tw,td): 1 → 26, 2 → 34, 3 → 44, 4 → 54.
sim.plan()/place() and engine centering are already generic over tw/td — no
special-casing needed for the new sizes; rotation swaps tw/td as before.

## models.js — GO THROUGH EVERY ASSET (all 5 categories, 75 types)
Two goals: (a) make the world feel substantial — bump heights/chunkiness across
the board so a placed city reads as real buildings, not tiny toys; (b) give the
big civic landmarks much bigger FOOTPRINTS so they tower over the neighborhood.
Reassign these entries (update tw/td AND the art to fill the new footprint, and
raise heights toward the new caps):
- stadium        → 4×4, tall bowl (~30 h): full oval seating rings in team
  colors, field with center circle, floodlight towers at the corners, big roof
  gap. This is the showpiece — make it genuinely large.
- mega-factory   → 3×3, tall; multiple chimneys/tanks/pipes, loading bays.
- mall           → 3×3, wide; skylit atrium roof, storefront row, parking hint.
- museum         → 3×2, grand; columned portico, dome, wide steps.
- zoo            → 3×3; bigger fenced grounds, 2-3 chunky animals, pond, paths.
- ferris-wheel   → 3×3; MUCH taller wheel (fill height cap) — update catalogAnim
  offset/part so the enlarged wheel still pivots on its hub.
- carousel       → 2×2; larger canopy — update its catalogAnim part/offset too.
- condo-tower    → 2×2 but TALLER (toward the 34 cap).
- rocket-lab     → 2×2; taller gantry + bigger rocket.
Everything else: keep its footprint but review scale — nudge heights up where a
type looks stubby (houses a bit taller, shops with real signage height, trees a
touch bigger). Keep the +Z front convention, glow indices (200-203), determinism
per (id,variant), and every existing id STABLE. Update the entry `variants`/`cap`
only if needed (caps still homes 2..30, others 1..10; bigger civic = higher cap).
Update _selfTest to assert new footprints validate within canvas+height caps and
that catalogAnim parts for resized ferris-wheel/carousel still have finite,
in-range offsets. Run the node self-test to {ok:true}.

## engine.js — scale for the bigger map
Derive everything from N/TILE (do NOT hardcode 48-based numbers):
- Shadow: ortho frustum must cover the whole map from the sun angle — set
  sc.left/right/top/bottom to about ±(MAP_W*0.75) and far to reach; bump shadow
  mapSize to 3072 so the larger area stays crisp (keep PCF soft).
- Camera: raise the default distance (~215) and the zoom-out clamp (~340) so the
  whole city can be framed; keep the min zoom. Pan clamp stays "target within
  map ± margin" using MAP_W. Fog near/far scale with MAP_W.
- buildGround already loops CHUNKS = ceil(N/CHUNK) = 4 — verify it still works.
- Precipitation area should cover a bit more (follow camera target as now).
Keep all APIs identical. Parse-import check must print ok.

## sim.js — scale terrain + migrate saves across the resize
- Terrain gen: scale the river band and the "central build area kept clear" box
  and the tree count to N (e.g. ~70 trees; central clear box ~ N*0.31..0.69).
  Keep it deterministic from seed.
- SAVE MIGRATION (important): roads/trees/bridges are stored as FLAT indices
  i=z*N+x, which break if N changed. Add `n: N` to the save. On load, if the
  saved `n` differs from current N, REMAP every flat index: x=i%oldN,
  z=floor(i/oldN); skip if x>=N||z>=N; newI=z*N+x. Buildings store x,z
  explicitly — keep those (skip any now out of bounds). This preserves a kid's
  city across the update instead of wiping it. Still v:2; a missing `n` means
  old N=48. Reject only truly malformed saves.
- Everything else (plan/place/bulldoze/footprint loops) already generic. Extend
  _selfTest: place a 4×4 and a 3×2, overlap + rotation still correct, and a
  save-with-old-n remaps road/tree indices correctly on load. Node self-test ok.

## ui.js — generic size badge
The drawer size badge must show `${tw}×${td}` for ANY multi-tile footprint
(2×1, 3×3, 4×4, …), shown whenever tw>1 || td>1. No other changes. Parse ok.

# ── v3.2 ADDENDUM — Downtown: offices + skyscrapers ─────────────────────────
New 6th category CATALOG.downtown — office buildings and skyscrapers. These are
commercial (sim catZone() maps any non-home/non-factory category to ZONE_C, so
they add "workers" to pop, draw cars/peds, and DON'T smoke — no changes needed
in sim/engine/life/main; all iterate the catalog generically).

## Height caps RAISED (models.js + self-test) so towers can be dramatic
By max(tw,td): 1 → 48, 2 → 64, 3 → 56, 4 → 64. (Only ceilings — existing shorter
types stay as they are; the self-test keys the cap off max(tw,td).) A 1×1 tower
at ~40 tall reads as a slim needle; a 2×2 at ~56–64 is a proper skyscraper.

## models.js — CATALOG.downtown, ≥16 types, front +Z, LOTS of glow windows
Mixed footprints (slim towers 1×1, big towers 2×2, a couple 2×1 office blocks).
Every type visually distinct; use 200/201 glass window grids densely (they glow
beautifully at night), 203 neon for rooftop signage/spires. cap 3..10 by size.
variants ≥3 for 1×1, ≥2 for larger. Deterministic per (id,variant), unique ids.
Suggested set (adapt, hit ≥16):
- 1×1 slim: small-office (mid-rise), glass-office, brick-highrise, deco-tower
  (stepped setbacks + spire), green-glass-tower, clock-tower (bank w/ clock
  face), round-tower, hotel (vertical sign in 203).
- 2×1: office-block (wide mid-rise), shopping-office (retail base + offices).
- 2×2 big: glass-skyscraper (blue), dark-skyscraper (modern black glass),
  corporate-hq (two-tone w/ logo), twin-setback (art-deco, tall), spire-tower
  (TALLEST — antenna/spire to the cap), tech-campus (wide, mid-height, green
  roof), city-bank (grand columned base + tower).
Give tops character: setbacks, antennas, spires, water tanks, helipads, rooftop
neon signs (203), a clock face. Ground floors: lobby glass + doors on +Z front.
Keep ALL existing exports + ids stable. Update _selfTest to include downtown
across variants (bounds/palette/tw-td, new caps) and report its count.

## ui.js — add the tab + sticker section
Add { key:'downtown', emoji:'🏙️', label:'Downtown' } to CATEGORY_TABS (after
Fun, before Deco is fine) AND to the sticker-book STICKER_SECTIONS. The sticker
"N / M collected" total M MUST be computed from the catalog (sum of all category
lengths), not hardcoded, so it grows to include downtown. No other changes.

# ── v3.3 ADDENDUM — Education pack (City Helper, cause&effect, modes, a11y) ──
Big release. Per-file APIs below are BINDING; main.js is the integrator. Keep ALL
existing exports/signatures working (new fields are additive/optional). Gentle
always: suggestions & visuals, never failure/bankruptcy/locks.

## audio.js — speech (Web Speech API, defensive)
- export function speak(text) — cancel any current utterance, speak `text` with a
  friendly voice, slightly slow rate (~0.95), pitch ~1.1; no-op if speechSynthesis
  missing or speech disabled. export function cancelSpeech().
- export function setSpeechEnabled(on) / isSpeechEnabled() — gate; default OFF.
  (main enables it for Picture Play.) Wrap everything in try/catch.

## sim.js — cause & effect (cosmetic, gentle)
- state: `pop` = RESIDENTS only (sum of caps of category 'homes'). NEW `jobs` =
  sum of caps of all non-home categories. NEW `happiness` 0..1, NEW `air` 0..1.
- place(): if entry.cat==='homes' pop+=cap else jobs+=cap. bulldoze reverses the
  right one. load recomputes pop/jobs from rebuilt buildings.
- Recompute happiness & air cheaply (every ~2 sim-sec in tick AND right after
  place/bulldoze): 
  happiness = clamp(0.55 + 0.03*parks + 0.015*trees + 0.02*shopVariety
              + 0.02*(schools>0) - 0.03*factoriesFarFromTrees , 0.15, 1).
  air = clamp(1 - 0.05*factories + 0.03*trees + 0.02*windPowers, 0.1, 1).
  (Tune to taste; keep it forgiving — trees/parks noticeably help.)
- export/`metrics()` -> plain object with at least:
  { residents, jobs, roadTiles, bridges, homes, shops, factories, funCount,
    downtown, trees, parks, schools, firestations, shopNearHome (count of shops
    within Chebyshev 6 of a home), happiness, air }. Cheap: iterate buildings once
    + a cached road/tree/bridge count maintained on edits. Used by missions +
    suggestions.
- save/load unchanged format (jobs/happiness/air are derived; recompute on load).
- _selfTest: pop counts homes only; jobs counts others; metrics() returns sane
  numbers; happiness rises when parks/trees added. Node self-test {ok:true}.

## challenges.js — NEW module (pure logic, no DOM/three)
```
export const CHALLENGES = [ { id, title, say, emoji, subject, goal, hint, ask } ... ]
  // subject ∈ 'math'|'civics'|'environment'|'literacy'|'design'
  // say  = spoken/kid text ("Let's build a road with 5 pieces!")
  // emoji= big picture for the card. ask = reflection prompt ("What changed?")
  // goal kinds:
  //   {kind:'roads', n}         delta: n new road tiles since mission start
  //   {kind:'homes', n}         delta: n new homes
  //   {kind:'trees', n}         delta: n new trees
  //   {kind:'place', cat, n}    delta: n new buildings in a category
  //   {kind:'shopNearHome', n}  absolute: metrics.shopNearHome >= n
  //   {kind:'bridge'}           absolute: metrics.bridges >= 1
  //   {kind:'nameCity'}         literacy — completed by main when city named
  //   {kind:'postcard'}         literacy — completed by main when a postcard taken
export const GUIDED = [ ...ordered challenge ids for the first-run helper sequence ]
  // e.g. ['road5','homes3','shopNear','bridge'] — matches the user's examples.
export function makeBaseline(goal, metrics) -> baselineObj   // snapshot for delta goals
export function progress(goal, metrics, baseline) -> { done, total, complete }
export function _selfTest()  // run to {ok:true}
```
Include ≥12 challenges spanning all five subjects (math: build 5 homes / use a 2×2 /
symmetrical block; civics: place a school/fire station/park; environment: plant
trees near a factory / add wind power; literacy: name your city / take a postcard;
design: "the ducks need a safe park — where should it go?"). main special-cases
nameCity/postcard/design (design = open-ended, auto-complete on any placement +
show the reflection prompt).

## engine.js — placement feedback, path preview, always-bright
- flashCells(cells, ok=false, ms=650): cells=[{x,z}] — show translucent tile quads
  (green if ok else RED) that fade over ms then vanish. TOUCH-FRIENDLY failed-place
  feedback (no hover needed). Pool the quads; allocation-light.
- setGhostCells(cells|null, ok=true): persistent translucent tile markers for the
  ROAD path preview during a drag; null clears. (Separate from setGhost model.)
- setDaylightLock(on): when on, setNight(t) renders with effective darkness capped
  (treat t as min(t,0.12)) AND rain sky-gray reduced, so "Always bright" stays
  legible. Keep setNight signature; store the lock and apply inside it.
- Keep ALL existing APIs. Parse-import check prints ok.

## ui.js — the big one (may use subagents; keep it all in ui.js)
Extend initUI(hooks) hooks with (all optional): onUndo, onPhoto (exist), onHelp,
onFreeBuild, onMissionNext, onMode(mode), onPalettePick(item), onAlwaysBright(on),
onSpeechToggle(on), onSpeak(text), onCityLoad(id), onCityNew(name),
onCityRename(id,name), onCityDelete(id), onFavorite(entry).
New/extended methods:
- setStats({pop, jobs, happiness, air, day, clockLabel}) — HUD shows 👥 people
  (animated, live-region announced), 💼 jobs, a 😀 happiness FACE that morphs
  (😟🙂😀🤩) by value, and a 🌿 air meter. Extra fields optional (old call still ok).
- showModePicker(onPick) — first-run friendly role=dialog: three big cards
  “🧸 Picture Play (Ages 5–6)”, “🏙️ City Explorer (Ages 7–9)”, “✨ Everything”.
- setMode(mode, picturePalette) — 'picture' shows a SIMPLE bottom bar of the 6
  picturePalette items (big emoji + short label, tap → onPalettePick(item), and
  onSpeak(label) when speech on); minimal text; hide category tabs & advanced
  buttons. 'explorer'/'everything' show full category tabs & all controls.
  picturePalette = [{ kind:'tool'|'entry', id, emoji, label, entry? }].
- Failed placement: showBlocked(text) — brief friendly RED toast (distinct from
  normal toast) with the message; main pairs it with engine.flashCells.
- Drawer scroll affordance: left/right arrow buttons + edge fade gradients +
  a “Swipe for more →” hint the first time a drawer overflows.
- Selected-building BANNER: setActiveTool(tool) also shows a floating banner just
  under the top bar with the tool's big emoji + name (cleared when null). This is
  the “larger picture + name above the map”.
- setFavorites(entries[]) — a “⭐ Recent” quick row above the toolbar (tap → place;
  same onTool). Hidden when empty.
- setMission({emoji,title,say,done,total,ask,complete}) / hideMission() — the CITY
  HELPER card (bottom-left, non-blocking): big emoji picture, title, a 🔊 “Say it
  again” button (onSpeak(say)), progress “2 of 3” + a little progress bar, a
  “Free Build” button (onFreeBuild). On complete: celebratory look + the reflection
  `ask` text + a “Next ▶” button (onMissionNext). Must not block map drags.
- showCityManager({cities:[{id,name,day,pop}], currentId, ...}) — “My Cities”
  role=dialog: list with Load/Rename/Delete + a “New City” (asks a name). Uses the
  onCity* hooks.
- Buttons added to the top bar (with proper aria-labels): ❓ help (onHelp), ☀️
  always-bright toggle (aria-pressed, onAlwaysBright), 🔊 speech toggle
  (aria-pressed, onSpeechToggle), 🗂️ cities (open showCityManager via onHelp-style;
  main supplies the list through showCityManager).
- ACCESSIBILITY (whole file): every icon-only button gets aria-label; toggles get
  aria-pressed. All overlays (welcome, mode picker, sticker book, postcard, city
  name, city manager) get role="dialog" aria-modal="true", move focus in on open,
  trap Tab, close on Escape, restore focus on close. Add ONE polite aria-live
  region; announce people changes (“Now 12 people live in your city”) and new
  stickers. Preserve existing prefers-reduced-motion handling.
- Parse-import check prints ok; keep module top-level DOM-free.

## main.js (integrator) — owns
Modes (localStorage 'bv-mode'; first run → showModePicker); Picture Play 6-item
palette = [road, small-house, a shop, tree, park, school]. Mission runtime: walk
GUIDED via challenges.progress over sim.metrics() + baselines; drive setMission;
Free Build hides helper; Next advances; literacy/design goals completed on
nameCity/postcard/any-place. Cause-effect suggestions: from sim.metrics with a
~25s cooldown, gentle toasts ("Lots of smoke! Try planting trees 🌳", "Add a park
to make people happy 🌳🎠"). Failed placement: map plan/place reason →
'terrain'→“This building needs grass.”, 'occupied'→“Something is already here.”,
'bounds'→“This building needs more room.”; call engine.flashCells(footprintCells,
false) + ui.showBlocked(msg) — on touch too (no hover). Road drag: snap the drag
to the dominant tile axis (a straight line from the start tile), show
engine.setGhostCells preview during drag, commit the straight line on release.
Save slots: 'bv-city-<id>' + an index 'bv-cities'; wire showCityManager; autosave
into the current slot. Favorites: track recently placed type ids → ui.setFavorites.
Speech: onSpeak→audio.speak; speech toggle→audio.setSpeechEnabled; default enabled
only in Picture Play. Always-bright→engine.setDaylightLock + persist. Selected
banner handled by ui.setActiveTool. Replayable help (❓)→ui.showWelcome. Favicon in
index.html + build shells. README 75→92.
