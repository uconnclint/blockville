# Cars, people & boats (piece `life`) — running notes

## 2026-09-24 — round 1 (builder)

**Changed**
- `src/models/vehicles.js`: cars, people, dogs, boats, balloons re-authored at res 4. 12 car kinds
  (sedan, taxi, bus/school bus, ice-cream truck, fire truck, hatchback, police, ambulance, box truck,
  pickup, SUV, panel van; kind = variant mod 12, colour from the rest). Shared helpers: proud 3×3
  tyres with a silver hub, dark under-plate (stands in for the contact shadow dynamics don't cast),
  silver bumpers, lamp-202 headlights (glow at night), red tail lights, raked glasshouse with
  pillars + a reflection streak. Scale set against roads.js: car 1.75 wide × ~1.6 tall × 3.5–4 long
  in a 3-unit lane; buses/trucks 2 wide, ≤ 6 long. People 1.75 tall (kids 1.25) with arms, shoes,
  hair/hats, skirts/shorts, backpacks. Boats: sailboat, rowboat, mini-ferry, speedboat with tapered
  hulls; balloons are chamfered cubes (the ref's cuboid language — a voxel sphere read as a pineapple).
- `src/models/core.js`: 22 `veh*` colours in the [vehicles] block (palette now ~176/200 — tight).
- `src/life.js`: agents move on exact in-tile paths (straight / quarter arc about the bend's inner
  corner, radius 4∓lane, matching the road markings / U-turn half circle) → no lane pops or yaw lag.
  Lanes: cars 1.5 (lane centre), peds 3.5 (sidewalk middle), y from the roads.js cell rule (kerb
  0.27 / asphalt 0.02 / bridge deck 1.0). Car-following (gap + smooth accel/brake, slower in bends),
  junction yielding (one entry heading crosses a degree≥3 tile at a time), anti-gridlock ghosting.
  Traffic mix weights (`CAR_MIX`), per-kind speeds. Models cached per variant (geometry shared).
  Boats only on open water (8 neighbours water), spawn biased toward the town, arc through turns.
  Park peds stand on LOT_Y + the park model's plinth. Dogs trail by path distance.
- `src/models/selftest.js` (surgical): dog/balloon size limits are now in world units (÷ res).

**Measured**
- life `_selfTest` ok; added a smooth-motion check (max per-step move = 1.00× top speed, 0 samples
  off-road, 0 car pairs closer than 1.6 on a ring + cross street). Grid stress test (node, 40 cars,
  25 junctions, 2000 frames): avg speed 92 % of vmax, 1.2 % stopped, 0 overlaps.
- models `_selfTest`: no errors from my generators (catalog errors seen mid-round are other pieces').
- Triangles: cars 410–820 each, person 100, dog 118, boats 250–1070; all live life ≈ 35k tris of a
  ~1.6M frame. Alone on the machine: 59–61 fps with vs. without life within noise; 0 console errors.
- The shared :8351 server reset connections under 14 parallel shooters; I used a private
  `tools/dev-server.py 8362` (threaded) + `--port 8362`.

**Next**
- ref05's vehicles mostly sit in parking lots — building pieces could reuse `carModel` for parked cars.
- Night: verify headlights/taxi sign glow framed on a car (my night framing got occluded).
- Peds cross junctions without yielding to cars; smoke puffs/birds/clouds are still res 1 and clouds
  float in the iso view — worth a pass (or hiding clouds) next round.

### Coordinator note (2026-09-24 10:35)
The "stray black cross block" floating over the city that two critics (industry r1,
and visible in iso-mid) flagged is birdModel(): a dark-grey plus-shaped blob that
reads as a rendering bug at iso zoom. Restyle birds (small, light — white gulls
with a grey wingtip, or pale pigeons — at res 4) or keep them clearly low over
water/parks so they read as birds.

## 2026-09-24 — round 2 (builder)

Critic r1 picked the reference: traffic sparse + generic sedans with a dark window band, no readable
wheels/service vehicles, no people at normal zoom, boats white specks with no hull colour or wake.

**Changed**
- `src/life.js` — **view-focused crowd** (cosmetic LOD): proj×view is read off `engine.camera`; road
  tiles are classed on-screen (NDC ≤ 1.02) / spawn ring (≤ 1.45) when the view moves (or every 0.5 s).
  Targets: cars = min(4 + pop/8, 1.0 × on-screen road tiles + 0.3 × ring, 90); sidewalk people =
  min(pop/5, 1.5 × on-screen + 0.3 × ring, 100). Agents past NDC 1.7 are recycled (≤ 3/frame) and
  respawn on screen while it is < 70 % full, else just off screen so traffic drives in; ≤ 4 pop-ins
  per frame; shrinking retires off-screen agents first. Boats do the same toward on-screen open water.
  No camera (self-test / headless) → `_view = null` → old uniform behaviour.
  **Service-site affinity**: 35 % of car spawns go to roads touching a service building, with its
  kinds (`SITE_KINDS`: fire-station → fire engines/ambulance/police, school → school buses, parks →
  ice-cream trucks, factories/warehouse/mall → box trucks/vans, bank/hotel → taxis …).
  14 car kinds + new `CAR_MIX` (more taxis/vans/trucks/service vehicles, fewer plain sedans).
  BOAT_CAP 3 → 8, BOAT_Y lowered so the foam row sits 0.1 above the water.
- `src/main.js` (surgical): while paused (`speed === 0`) main now calls `life.update(0, …)` so the
  crowd still fills whatever the camera pans to (the iso shot harness pauses the sim — without this
  the shots showed whatever was spawned before the camera was posed).
- `src/models/vehicles.js` — glass is now bright sky blue (`vehGlass 0x4fa6e2`) with a white streak
  on the windscreen, each side pane and the rear (was dark navy = "one dark window band"); brighter hubs.
  New kinds: 12 school bus, 13 city car (short, bubbly, optional white roof). People rebuilt as chunky
  toy figures (5 × 7 × 3 res-4 voxels: 3×3×3 head with eyes, 3-wide torso, arms, legs with a gap; kids
  5 tall). Boats rebuilt bigger with saturated hulls/decks + a **baked foam wake** (bow wave, churn,
  spreading V) — the grid is padded fore/aft so the pivot stays at the hull centre. Smoke puff is now
  a white res-4 steam puff; the bird is a small res-4 gull (the res-1 bird was bus-sized and showed
  up as a black blob in iso-close). New export `stampCar(g, variant, x0, y0, z0, dir)` stamps any
  traffic model into a res-4 building grid (7 × 12–16 cars, 8 × 19–24 buses/trucks) — for building
  pieces that want the same crisp cars parked in their stalls (NOT yet adopted by any building file).
- `src/models/core.js` [vehicles]: vehGlass / vehGlassHi / vehHub retuned (no new keys; palette 188).

**Measured**
- life `_selfTest` ok (maxJump 1.00, 0 off-road); models `_selfTest` ok; sim `_selfTest` ok.
- Live counts: iso-close 22 cars (14 on screen) + ~30 people; iso-mid 90 cars / 100 people.
  Flow over 12 s running: avg speed 0.67–0.68 × vmax, 10–12 % stopped (queues at junctions), ~2 % ghosting.
- Life adds ~11k tris (iso-close) / ~40k (iso-mid) but ~+45 / +150 draw calls (one mesh per agent).
  fps A/B life on/off inside one page: indistinguishable within the (heavy, shared-machine) noise;
  final shots 51–61 fps iso-mid/close, iso-water 34–39 fps with or without life (not life's cost).
- 0 console errors.

**Next**
- Parked rows: the reference's lots are full of cars in striped stalls — that lives in the building
  models. Offer `stampCar` to civic/commercial/downtown builders (their own car helpers are 5–6 wide
  blobs); needs stalls ≥ 8 voxels pitch for 7-wide cars.
- Draw calls: an instanced path in engine (`makeDynamic` per model → one InstancedMesh per variant)
  would make the 190 agents ~30 calls.
- Panel van's 3-row raked windscreen reads as a staircase; try 2 rows + upright top row.
- Night check of headlights / taxi sign / beacons still not framed.

## 2026-09-24 — round 3 (builder)

Critic r2 picked the reference: "vehicles and people far too big for the buildings (taxi ≈ half a
storefront, peds' heads as big as a car cabin); ref05's cars ≈ a third of that; fleets parked in
neat striped bays at civic lots; keep traffic centred in its lane".

**Changed**
- `src/models/vehicles.js` — **scale pass**: road vehicles re-authored at **res 8** (same voxel
  detail, half the world size): car 8 wide × 14–19 long = 1.0 × 1.75–2.4 units (~1 tall), buses /
  box truck / fire engine 9 × 28–30 = 1.1 × 3.5–3.75, ambulance 9 × 23. 4×4 tyres with a 2×2 hub on
  the big ones, dark under-plate, deeper glass (`vehGlass 0x2d5f96`, streak `vehGlassHi`) so the
  windows read "dark with a highlight" like ref05; van windscreen is now upright on a cowl (no
  staircase). People at **res 12**: adults 9 voxels = 0.75 tall (legs 3, torso 3, head 3 — head is
  a third of the body now, not 43 %), kids 0.58. Dogs res 16 (0.19 × 0.25 × 0.375). Balloons res 8.
  Boats res 6 (sailboat ~5.3 long, ferry ~6.3; they were a whole tile long next to 2-unit cars).
  `carModel(v, parked=true)` = the same vehicle standing in a painted kerbside bay (white ticks at
  roads.js's 8/3 pitch baked one voxel tall; long kinds take a double bay; headlights off).
  `stampCar` now lays a hand-made **res-4 twin** (4 × 4 × 9, vans 5 tall = the traffic's world size)
  with an optional paint override — the res-8 traffic blocks can't go into res-4 building grids.
- `src/life.js` — CAR_LANE 1.5 → 1.75 (3.65-unit lanes; centred but a hair inboard so a bus clears
  parked cars). Following re-sized to the small cars (look-ahead 10, lateral 1.0, standstill gap
  0.45, slow-down from 3.4); cars now wait **behind the stop bar** (nose 2.35 back from the mouth)
  instead of at the tile edge; speeds × 0.8; CARS_PER_TILE 1.2. Peds 0.55–0.9 u/s, smaller bob;
  DOG_GAP 0.55. Boat float height derived from the model res. **Kerbside parking** (`_planParking`,
  rebuilt on sync, deterministic per tile hash): on straight road tiles along a building's side,
  fleets per building type (`FLEET`: fire station → fire engines/ambulance/police, school → school
  buses, warehouse/factories → box trucks/vans, hotel/bank → taxis/police, parks → ice-cream van)
  and shoppers' cars in front of shops/downtown; the half of a tile next to a junction stays clear
  (that's where roads.js paints zebra + stop bar). ≤ 120 static meshes (frustum-culled).
  Self-test gained a fire station → asserts its fleet stands inside the bay band.
- Surgical, outside my files: `models/selftest.js` res bound 8 → 16; `models/commercial.js`
  `parkedCar` → `stampCar` (centred in its old 7 × 12 stall); `models/residential.js` driveway
  `car()` → `stampCar(…, body)` (was 1.5 × 2.75 × 1.75 — bigger than the traffic).

**Measured**
- life `_selfTest` ok (maxJump 1.00, 0 off-road, 0 overlaps, parked 2); models + sim self-tests ok.
- Demo city: 120 bay slots planned (cap), iso-close ~10 moving cars + ~25 peds. Draw calls with life
  on/off: iso-close 100 / 62, iso-mid 347 / 187 (parked ≈ +5 / +47). Frame-time A/B interleaved ×4:
  within the noise of a heavily shared machine (iso-mid ≈ 23 vs 22.5 ms median); 0 console errors.
- Visually (r3-builder): a taxi is now ~1/4 of a storefront, peds are small full figures, ambulance /
  police / fire engine liveries crisp with dark glass, parked van sits in roads.js's own bay ticks.

**Next**
- Other pieces still draw big res-4 vehicles: industrial.js `truck()` (6 × 18 = 1.5 × 4.5 units, the
  depot trucks look huge next to the traffic) and civic.js `fireTruck()` (4.5 long). Point them at
  `stampCar` or a res-8 stamp path (needs a res-8 lot grid or a res-4 truck twin).
- Draw calls: an engine-side instanced dynamic path (one InstancedMesh per model) would turn the
  ~160 life meshes in iso-mid into ~40.
- Peds still cross junction mouths anywhere, not at the zebra; could route them along the arm that
  roads.js picked for its crossing if that bit were exposed.

## 2026-09-24 — round 4 (builder)

Critic r3 picked ours but wasn't wowed. Biggest gap: vehicles only drive by or sit in one standalone car park. In ref05 the civic and commercial lots have parked service vehicles. Also: sparse traffic, and people read as stubs.

**Found first.** The building models already carry lot parking. civic.js puts fire engines and an ambulance nosed into the fire-station apron (gal-fun-1), and commercial.js shops have striped stalls with stampCar cars. The r3 iso-close hero was a residential block, and life only parked at fleet and shop buildings, so that frame had no parked vehicles. The hero building also changes between runs, because the demo city and models keep changing under us.

**Changed**
- `src/models/vehicles.js`: new export `parkedRowModel(items)` (re-exported from `src/models.js`, a one-word surgical edit). It merges every parked vehicle along one road tile's kerbs into one res-8, 64×64 model centred on the tile, so there is one draw call per tile, not one per car. Each bay is painted as a clearly drawn stall: an end tick at each end plus the lane-side edge line. roads.js dropped its bare ticks as "stray marks"; this paint appears only under a car. Parked vehicles have their headlights off.
  People are rebuilt at res 11, 5 × 11 × 3 voxels = 1.0 unit tall (was 0.75): legs 4, torso 4 with a belt, head 3, two-voxel-deep sleeves with hands, and a cap badge. Kids are 0.64. They now read as two-legged figures at iso-close.
- `src/life.js` kerbside parking:
  - It now covers homes (`RESIDENT` mix: sedans, hatchbacks, city cars, SUVs, pickups), not just fleets and shoppers.
  - Parking probability per tile side: fleets 0.9, shops/downtown 0.6, homes 0.45.
  - Up to 360 parked cars in ≤ 200 merged tile meshes.
  - Tile models are cached by content, so a rescan re-meshes only the tiles that changed.
  - Stale meshes beyond 16 spares are disposed, and their models dropped. Before this, the pool could fill with stale handles after enough road edits.
  - Traffic: CARS_PER_TILE 1.2 → 1.7, CAR_CAP 90 → 110. CAR_MIX leans toward private cars (ambulance, fire engine and panel van shares cut, since a residential street showed three ambulances). Peds walk at 0.6–1.0 u/s.
  - Spawn fix: no pop-ins inside junction tiles, plus a Euclidean clearance check on spawn. The paused shot harness had spawned a box truck, a taxi and a car stacked in one junction.
  - The self-test now asserts that the fire station's fleet is exactly one merged mesh on tile (8,10) and that every slot is in the bay band.

**Measured**
- life `_selfTest` ok (maxJump 1.00, 0 overlaps, parked 1 tile). models and sim self-tests ok. check.sh ok. 0 console errors in every shot.
- Demo city: 300 parked cars on ~200 tiles. Merged parking geometry is 160k tris / 28.6 MB total, of which ~40 tiles are drawn in iso-close.
- `_planParking`: 1.3 ms when cached, 511 ms for a cold full re-mesh (once at load).
- Draw calls in iso-mid: 229 → ~242–279 depending on run (the city changes between runs). A/B in iso-mid, life hidden vs shown: 29/31 vs 29/27 fps. That is the same within noise; load average was 13.7 with other builders' Chromes running.
- Visually (r4-b, r4-builder): shop fronts have rows of parked cars in outlined bays, the fire station has engines, an ambulance and a school bus at its kerb, residential blocks have family cars, and roads are busier. People are clearly figures.

**Next**
- People still cross junction mouths inside the junction tile, ~1.6 units short of the zebra, which roads.js paints at q.y 0.40–1.80 of the approach arm, and only on the arms it picks. Route crossings over the zebra arm; needs roads.js to expose its zebra bits.
- Res-4 `stampCar` lot cars look chunkier than the res-8 traffic next to them. A res-8 lot path (buildings authoring parking at res 8, or life placing parked cars into lots that export stall slots) would match.
- Residential builder: in the r3 iso-close, the big-house driveway car (`car(g, 22, 1, ...)`) read as "a red car on the lawn". Its paving patch barely shows; widen the drive to the kerb.
- There is no hospital or police station in the catalog. ref05's ambulance bays live at the hospital.

## 2026-09-24 — round 5 (builder)

Critic r4 picked the reference. Biggest gap: parked lot cars were "rounded two-tone lumps — no windscreen,
side glass, wheels, lights or livery"; shrink them ~15-20 % against the stalls; people a bit large.

**Found first.** The iso-close lot was NOT mine: it is terrain.js's vacant-lot car park (box cars:
a body box + a glass box). Building lots drew cars with four more private helpers (downtown/commercial/
industrial `car()`/`van()`), plus my res-4 `stampCar` twins; a res-4 voxel is too coarse for glass/
wheels/lights. And `voxel.js modelRes()` clamped res to 8, so my res-11 people were drawn 1.375 tall
(and res-16 dogs 2×) — that was the "people a bit large".

**Changed**
- `vehicles.js`: `vehicleGrid(variant, {paint, compact})` behind `carModel` (paint override for the
  everyday kinds; compact = car-length cousins of the long kinds: minibus / school minibus, ambulance
  van, fire-rescue van with ladder + light bar, delivery truck, 18-long ice-cream van).
  **`stampCar` now lays the real res-8 vehicle** as a `model.parts` child (engine addBuilding already
  meshes parts, follows rot / grow / ghost): stampCar records the car (g.set mapping probed by
  intercepting `g.map.set`, so rot180 / mirror wrappers work, fractional x0/z0 allowed for centring),
  a wrapped `g.done()` builds one res-8 part per building, cached by content; `parts` is an accessor
  that follows catalogModel's flipZ (sentinel base block) and keeps any other parts (industrial hiRes).
  Fallback to the old res-4 twin if the grid can't be probed. New `stampLotCar(g,x0,y0,z0,dir,body,seed)`
  (kind from seed; taxi-yellow → taxi). New `lotCarsModel(items)` — a whole car park merged at res 10
  (= cars × 0.8, the critic's shrink). Glass `vehGlass 0x3a78bc` (lighter blue), people res 12 (0.92
  tall), dogs res 12.
- `life.js`: `_syncLotCars()` (per-frame version check) mirrors `terrain.lotCars` into one merged
  mesh per car park; sets `terrain.lotCarsExternal = true` in the constructor when it can draw them.
- Surgical, outside my files: terrain.js `lotCars`/`lotCarsVersion`/`lotCarsExternal` + its lot `car()`
  records {x,z,y,h,k} instead of drawing boxes when external (chunk rebuild purges its rects' entries);
  downtown/commercial/industrial `car()`/`van()` bodies → `stampLotCar`/`stampCar` centred in the old
  footprints; voxel.js `modelRes` clamp 8 → 16 (only people/dogs declare > 8) + CONTRACTS-RENDER note;
  models.js exports `lotCarsModel`; selftest front-face check counts the midline row (the mall only
  passed because its lot cars' winCool glass sat in the front half).

**Measured**
- life / models / sim / terrain / voxel self-tests ok; check.sh ok; 0 console errors in every shot.
- Cost (A/B hiding lot meshes + building parts in-page): iso-mid +39k tris (1.6 %) +22 calls, iso-water
  +76k (1.8 %) +36 calls, iso-close +6k. Whole map: ~19 car parks / 350 lot cars ≈ 145k tris (414/car,
  culled per lot), building parts 69k. fps 50–61 iso-mid/close, 34 iso-water (shared machine; the
  frame totals grew mostly from other pieces this round: 1.47M → 2.4M iso-mid).
- Visually (r5-b crops, r5-builder): the car park reads as rows of real little cars — glass band with
  highlight, wheels, tail lights, vans/taxis mixed in; building lots (mall, tech campus, warehouse,
  shops, homes) carry the same models; people now sit at car-roof height.

**Next**
- Lot cars (dynamics) cast no shadows; a castShadow flag on makeDynamic (engine) would ground them more.
- terrain.js car parks still skip 30 % of bays and have a wide empty aisle (critic note 1) — the ground
  piece could fill bays / narrow the aisle; the dark smudge across that lot is a shadow/AO artefact there.
- civic.js `fireTruck()` / `schoolBus()` are still res-4 own models; `stampCar` could take a long-kind
  footprint (res-8 fire engine = 4.5 × 15 res-4 voxels) if the civic builder wants it.

## 2026-09-24 — round 6 (builder)

Critic r5 picked the reference. Biggest gap: cars were "squat, generic blob-boxes" with "muddy blue window smears", no livery, and hard to tell apart. Pedestrians stood on the asphalt in the middle of a junction. A white van overlapped the kerb.

**Found first.** The palette had overflowed. Other blocks grew, which pushed my [vehicles] block past index 199. vehNavy, vehPolice, vehStripe and vehHullRed landed on the emissive specials 200–203, and vehDeck landed on 204. So the ambulance stripe rendered as lamp yellow, police bodies as winCool cyan, and boat decks as fallback grey, and all of them glowed at night. The kerbside bays were also still placed at the old 0.35 rim (HALF − 0.35). roads.js r12 has 0.8 sidewalks everywhere, so parked cars stood 0.45 into the kerb. That was the van on the kerb.

**Changed**
- `core.js` [vehicles]: cut to 7 keys (vehGlass 0x4b95dc, vehGlassDk, vehGlassHi, vehRed, vehBlue, vehGreen, vehSilver). Everything else reuses base colours (black, darkGray, red, white, navy, orange, teal, skyBlue, taxiYellow, yellow, plank, roofRed, stone). The palette is now at 190/200. **This block sits LAST, so the next overflow hits vehicles again.**
- `vehicles.js`: road vehicles are re-authored at **res 12** at about the same world size (car 12 wide = 1.0 unit; trucks, bus and ambulance 13 wide). Shared helpers:
  - round d4/d5 tyres with silver hubs, set in dark wheel arches;
  - the glasshouse is inset from the shoulders, with body-colour pillars, a darker top glass row and white highlights (drawn only on glass);
  - 2×2 headlamps with orange indicators, chrome bumpers, mirrors and door handles.
  Each type has its own silhouette:
  - sedan (3-box), hatch (2-box), city car, SUV (cladding, rails, spare wheel), pickup (open bed and crates), panel van (logo patch);
  - taxi: checker band and a "TAXI" roof sign;
  - police: navy with white doors and a red/white/blue bar;
  - ambulance: red and orange band, crosses on the sides and roof, light bar, beacons, chevron rear;
  - fire engine: cab-over, chrome grille and bumper, white band, chrome lockers, roof ladder on a turntable, light bar;
  - bus: window band, white roof, lit destination sign, kerb doors;
  - school bus: bonnet, black rails, stop arm;
  - box truck: logo panel and ribbed roller door;
  - ice-cream van.
  Compact (12×27) cousins exist for lot stalls. Bay paint and the parked row are now at res 12 (bay 1.08 deep). lotCarsModel is res 15 (×0.8). stampCar keeps its 1×2.25 footprint and now accepts non-integer kf (res-8 grids). The balloon keeps res 8.
  New export `carModelAt(variant, res)` does a nearest-centre resample, for grids that copy car blocks.
- `life.js`:
  - CAR_LANE 1.75 → 1.45 (3.2 lanes); KERB = 3.2 for bays; PARK_SINK 0.06.
  - **Pedestrians walk bends and dead ends square**: `a.sq`, `pathLen(…, sq)`, and evalPath legs through the sidewalk corner. Left arcs of radius 7.6 had cut across the junction asphalt.
  - Road peds only spawn with a non-road tile on their right (the paused shots showed spawn points on junction mouths).
  - The self-test now asserts every road-ped sample is on the tile's sidewalk ring. I checked that it fails (606 samples) with arcs.
- Surgical, outside my files: `residential.js` driveway `car()` → `carModelAt(variant, 8)`. It copied res-12 blocks into its res-8 grid, so its cars came out 1.5× the traffic size. **The residential builder overwrote this once mid-round (old import); I re-applied it. Re-check that it is still in place.**

**Measured**
- Tris per vehicle: 680–1630 (avg ~990, was ~500); person 144.
- life, models and sim self-tests ok; check.sh ok; 0 console errors in every shot.
- A/B in-page, life shown vs hidden (dpr 1, load avg ~6):
  - iso-mid: +130–290k tris (1.54M → 1.67–1.83M), +90–190 calls, fps within noise (14–21 either way);
  - iso-close: +30–44k tris;
  - iso-water: +285k tris.
- Visually (r6/sheet2, r6-builder): every type reads at a glance, liveries are crisp, parked cars sit squarely inside their outlined bays at the kerb, and people are on the sidewalks.

**Next**
- Draw calls: ~190 life meshes in iso-mid. An engine-side instanced dynamic path would help most.
- Nose-in fleet bays / apron lanes at civic buildings: civic.js `fireTruck()` and `schoolBus()` are still its own res-4 models. Point them at stampCar (compact kinds) or a long-kind stamp.
- Windscreen steps read a little like blinds up close (lit step tops). Could try rakeF 0 on the top row, or GLASS_DK tops.

### Coordinator note (2026-09-24 16:05) — SCALE, again (r2 and r6)
Two critics say vehicles are "oversized chunky" and people "pin-sized". Measure it:
in ref05 a sedan is ~1/3 of a lane-tile long relative to a 1-tile building lot
(roughly 2.4-2.8 world units long vs our 8-unit tile), ambulances/trucks ~3.5-4.5;
people ~0.7-0.9 units tall (big enough to read heads/bodies at iso-close). Set car
models at res 4 to those world sizes (≈10-11 fine voxels long for a sedan) and make
people ~3-4 fine voxels tall with a readable head/torso/legs, then verify in
iso-close with PIL measurements vs a known building. Also: denser parked cars in
the lots that have parking (coordinate by reading shops.md/civic.md — the building
artists own lot parking bays; you can add parked-car props on their stripes).

## 2026-09-24 — round 7 (builder)

Critic r6 picked the reference. Biggest gap: too few vehicles, and they "read as oversized toys" (one fire truck, one box truck, one sedan and one bus on a long empty lane). People were "dots". Parking lots had "lines but almost no cars". Asked for: scale down 20-30 %, more livery, more parked in lots/aprons.
Consensus check: the r2, r4 and r6 critics all called the vehicles too big. People have been called too big (r2, r4) and too small (r6), so I aimed at the midpoint.
I measured ref05: its cars are ~0.24 of the carriageway width and ours were 0.31. Its fire engines are ~0.6, the same as ours.

**Changed**
- `vehicles.js`:
  - Road vehicles render at **RV 15** (was 12), so every vehicle is ×0.8 with the same voxel detail: car 0.8 wide × 1.4–1.8 long, bus/fire engine ~3.0.
  - Lot cars use LOT_RES = RV, so they match the traffic. Kerbside bays are re-sized to res 15 (BAY_HALF1 18 = 2.4-long bays, 0.93 deep).
  - Compact (stall) cousins are longer: fire engine 33 (2.2) and now has a turntable + ladder heel, ambulance 30, box truck 31, minibus 33.
  - `racing()` gives ~28 % of sedans/hatches twin rally stripes over bonnet/roof/boot. They show from above at iso-mid, where cars were "specks hard to tell apart".
  - People at **RP 11** are 1.0 tall (was 0.92).
  - Gull at res 8. At res 4 it was bigger than the new cars.
  - lotPart y is now floored, so no part floats at kf 3.75.
- `life.js`:
  - CARS_PER_TILE 1.7 → 2.6, CAR_CAP 110 → 190, PEDS_PER_TILE 1.5 → 2.1, PED_CAP 100 → 150, SPAWN_PER_FRAME 6.
  - Kerbside parking re-pitched to `BAY` 2.4. A clear kerb holds 3 bays, a kerb with one junction end holds 2, and a kerb with junctions at both ends holds 1. Long kinds take 2 bays and are now allowed with one junction end.
  - Fill: side probability 0.95 fleet / 0.75 shop / 0.55 home, extra bays 0.85/0.7. PARKED_CAP 560. PARK_SINK 0.045.
- Surgical, outside my files:
  - `civic.js fireTruck()` delegates to `stampCar(g, 4, …)`, centred in the old L×6 footprint. The fire station apron now holds the shared res-15 ladder engines with light bars instead of res-4 block trucks.
  - `terrain.js` car-park skip 0.30 → 0.12.

**Measured**
- life / models / sim self-tests ok; check.sh ok; 0 console errors in every shot.
- iso-close: ~35 moving + ~45 kerbside cars, peds clearly visible.
- dpr 1 (load 7): iso-mid 53 fps, iso-close 61. dpr 2: iso-mid 28, iso-close 42, iso-water 12. iso-water is 3.86M tris, mostly not life.
- iso-close life ≈ 57k tris.

**Next**
- industrial.js `truck()` depot semis are still res-4 1.5-wide blocks. They look huge beside the ×0.8 traffic (one-fire-station shot, right side). Point them at stampCar or a long-kind stamp.
- terrain car-park bays are 4.2 deep for 1.8-long cars. Shallower bays (~2.6) would read fuller.
- Instanced dynamics (engine) would help if CAR_CAP rises further. Wide shots are still capped (outer roads empty in iso-water).

## 2026-09-24 — round 8 (builder)

Critic r7 picked the reference. Biggest gap: vehicles were "toy boxes: flat body colour + one blue window band, no lights, grilles or livery", the fire truck was "a red brick with a white stripe", and pedestrians were "2-3 voxel pegs".
**Found first.** The pegs were mostly not mine. commercial.js `person()` draws 2×2×9 columns, civic.js draws 1×3 and downtown.js draws 1×5. The "stepped lump" lot cars came from commercial.js and residential.js resampling my res-15 cars to res 8 (`carModelAt`). My own lamps sat only on the end faces. The iso camera mostly sees the roof and flanks, so the lamps never showed.

**Changed**
- `vehicles.js`:
  - `wrapCorners()` runs on every vehicle. Headlamps, indicators, tails and chrome bumper corners now wrap onto the flanks.
  - `seams()` adds door shut-lines on sedan and hatch.
  - The windscreen rakes in 2-row steps (`cabin pair`), not four 1-voxel steps that read as blinds.
  - Glass is darker: vehGlass 0x2f6fb4, Dk 0x1c3a66, Hi 0xcdeeff.
  - The fire engine is rebuilt after ref05: white cab roof, wrap-round windscreen with a centre pillar, crew windows, and a red/blue light bar. It has a ribbed chrome grille, a white waist band, and three chrome lockers a side. The aerial ladder has white rails and silver rungs with see-through gaps, sits on dark saddles, runs over the cab and has a turntable aft.
  - Box truck: corner posts, rub rail and roof bows. The logo accent is never white-on-white.
  - `C.skyBlue` is removed from all body paints. voxel.js classes skyBlue as GLASS, so those bodies drew sheen streaks.
  - People are rebuilt at RP 16: 7 wide × 14 tall × 4 deep (0.875 tall). They have a 5×5×4 head with eyes, hair cap, back and fringe (or a cap with a peak), a shirt torso with collar and belt, arms hanging clear with hands and optional bare forearms, and two 2-wide legs with a gap and shoes.
  - Boats are at RB 5 (×1.2). Rowboat and speedboat now show hull colour from above (coloured gunwale/deck, white boot stripe), and wakes are smaller.
- New export `stampPerson(g, cx, y, cz, seed, dir)`: the life figure goes into the building's lot part, the same path as stampCar, and a 0.45-unit spacing check replaces the old voxel-based spacing. `probe()` now accepts map-less typed-array grids (commercial/residential) with identity mapping.
- Surgical edits outside my files:
  - commercial.js `person()` → stampPerson (keeps its 4 rng draws) and `car()` → stampCar;
  - civic.js `person()` → stampPerson (crowd skips rejected spots);
  - downtown.js `person()` → stampPerson;
  - residential.js driveway `car()` → stampCar.
  A whole-file write by the shops builder reverted commercial.js once mid-round. The re-apply script is `scratchpad/reapply_commercial.py`, and I left a note in shops.md, civic.md, downtown.md and res.md.

**Measured**
- life, models and sim self-tests ok; check.sh ok; 0 console errors in all three shots.
- fps on the shared machine: iso-close 16–35, iso-mid 8–26, iso-water 22–26 (same range as r7, load-dominated).
- Shop lot parts: 189k blocks over 20 shops × 2 variants, mostly the mall.
- Visually (r8-builder crops, r8-s2/s3 sheets):
  - the fire engine reads as a ladder truck at iso-close;
  - lamps show on every car's flank, and the glass reads as framed windows with a glint;
  - supermarket and house lots carry the same detailed cars as the street;
  - lot and street people are figures with heads and arms.

**Next**
- Re-check that commercial.js still imports stampPerson/stampCar (it has been overwritten once).
- Vehicle glass could join voxel.js's glass class (its pane sheen), but that needs a PALETTE_SPEC entry in voxel.js.
- Police share looks high near banks and hotels (SITE_KINDS / FLEET); trim if a critic notices.
- The critic still called our vehicles "too big" next to the buildings, while the coordinator's ref05 measure says they are already smaller. Consider ×0.9 only if the next critic repeats it.

### Coordinator note (2026-09-24 17:35) — BUG before polish
Critic r8: "cars in the front-left lots of the bakery block are jammed and overlapping
at odd angles like a pile-up". That's a correctness bug (overlapping spawn/park
positions or cars leaving lanes into lots), not a style note. Reproduce in
one-bakery / iso-close, fix it (one car per stall, aligned to the stall/lane, no
overlap), and add a self-test asserting no two vehicle footprints overlap.

## 2026-09-24 — round 9 (builder)

Critic r8 picked the reference. Biggest gap: the supermarket lot beside the bakery (iso-close) read as a pile-up of blob cars at odd angles. Secondary: vehicles oversized next to the buildings, weak lights and glass.
**Found first.** A top view of `catalogModel('grocery')` (scratchpad `topview.mjs`/`topview.py`) showed every car was already square in its own stall. The pile-up had two causes. First, 0.8-wide cars in 1.375-unit stalls leave no visible gap between neighbours at the iso angle. Second, `crowd()`/`person()` visitors were stamped standing inside the stalls, between the cars. The r2, r4, r6 and r8 critics all called vehicles too big, so that is now a consensus.

**Changed**
- `vehicles.js`:
  - **RV 15 → 17.** Every vehicle is ×0.88 with the same voxel art: a car is 0.71 wide and 1.24–1.59 long.
  - The bay constants are now in world units (`BAY_HALF1 = round(1.2·RV)` …), so the kerbside bays and life.js `BAY` are unchanged.
  - Lot stalls now show clear asphalt and their white lines between cars.
  - `stampCar` records its stall rect and drops any visitor stamped earlier inside it. `stampPerson` refuses spots inside a stall (+0.2 margin). This means no people are wedged between parked cars, whichever file stamps them.
  - Head and tail lamps are 3 wide (they were 2), and they still wrap onto the flanks.
- `core.js` [vehicles]: glass is darker for contrast on any paint (vehGlass 0x255a94, Dk 0x15305a, Hi 0xd6f4ff). vehBlue is lighter (0x4f9ff0) so blue bodies no longer match their glass.
- Surgical, outside my files: `voxel.js modelRes` clamp 16 → 20; `models/selftest.js` res bound ≤ 20; CONTRACTS-RENDER note (≤ 20 for vehicles/people).
- `life.js`: comments only (BAY / PARK_SINK at res 17).

**Measured**
- models / life / sim self-tests ok; check.sh ok; 0 console errors in all shots.
- dpr 1 (load avg 4–7, noisy): iso-close 27–58 fps, iso-mid 36–42. Triangle counts unchanged (same voxel art).
- Visually (r9-builder/crit.png is the same crop as the r8 critic's): the grocery lot reads as 4 cars in 4 marked stalls plus a zebra bay. Kerbside bays show more white outline, and the terrain car parks (iso-water) are tidy rows.

**Next**
- Back aprons dressed through commercial.js `mirrorZ()` get no lot cars: the wrapper has no map/done, so probe() fails. Give probe() a hook for mirror wrappers if the shops builder wants cars on both aprons.
- The ref's vehicles have dark outlines and strong edges. That is a post/outline question, not model detail.
- People (0.875 tall) were called "a few blocky pixels" this time and "too big" before, so they are left as they are.

### Coordinator correction (2026-09-24 18:30)
My 16:05 size note (sedan 2.4-2.8 units) was wrong for our scale — ignore it; your
measured ×0.88 shrink (cars 1.24-1.59 long) stands. The consistent critic complaint
(r7, r9) is now PROPORTION + READABILITY, not length: "one generic chunky hatchback
silhouette, oversized cabins, no readable wheels/glazing/lights/livery". Make
distinct low-slung types: sedan (cabin ≤ 40% of height, set back), taxi (roof sign,
checker stripe), van, box truck, bus, ambulance (white, red stripe + cross, light
bar), fire engine (red, ladder rack, chrome, light bar), police (black/white, bar).
Dark wheels visible below the body line on every side, window band continuous
around the cabin. Test at iso-close and crop cars at 2x.

## 2026-09-24 — round 10 (builder)

Critic r9 picked the reference. Biggest gap: "a generic chunky hatchback repainted"; cabins oversized; no readable dark wheels, window bands, lights or liveries; cars "one lane wide, nearly as tall as the people". They asked to shrink vehicles 20-25 % against the lane.
**Found first.** The r9 sheet (`scratchpad/lsheet10.js`, run through shoot.mjs --eval) showed several problems:
- Cars were 12 wide × 11 tall × 21-27 long, so L/W was about 2 (stubby) and the glasshouse was 5 of the 11 rows.
- Silver hubs made every wheel a light blob.
- The blue glass (0x255a94) merged with blue and navy paint.
- vehSilver bodies (silver cars, vans, the bus A/C pod) rendered as a bluish sheen.

**Changed**
- `vehicles.js`:
  - RV 17 → 18.
  - Every car is now **10 wide and low**: body y1..4, a 3-row dark window band y5..7 inset from the shoulders, roof y8. That makes 0.56 wide × 0.5 tall × 1.06-1.5 long (17 % of a 3.3 lane, down from 22 %). Shared `carBody()`.
  - Each kind has its own length and silhouette:
    - sedan 26 (3-box);
    - hatch 22 (spoiler);
    - city car 19 (4-row bubble);
    - SUV 25 × 11 tall (black cladding, d5 wheels);
    - pickup 26;
    - van 27 × 12 tall.
  - Police is now panda (white doors, navy ends, blue stripe, bar). Taxi keeps the checker and roof sign.
  - Service vehicles are 11 wide and lower:
    - fire engine 44 × 12 tall with a narrower ladder, so the red top and white rim show;
    - ambulance 32 × 13;
    - bus 42 × 14;
    - box truck 40 × 15;
    - ice-cream 29 × 17.
  - Compact cousins are 10 wide.
  - Wheels are black tyres with only a small grey hub (`RIM`/`HUB`). Only the arch lid is dark, because a full dark ring blacked out the 4-row flank. Sills are gone on the low cars.
  - 2×2 headlamps sit at the corners with the indicator under them. They still wrap onto the flanks.
  - Parked cars are centred in their bays (parkedRowModel / inBay).
  - `CAR_COLS` uses C.concrete instead of vehSilver, and so do the van, box-truck rails and bus A/C pod.
- `core.js` [vehicles]: dark window strips: vehGlass 0x26374d, Dk 0x172230, Hi 0xbfe8ff.
- `life.js` (calmer, r9 "kerbside rows cluttered"):
  - CARS_PER_TILE 2.6 → 2.3;
  - kerb parking p shop 0.75 → 0.65, home 0.55 → 0.45;
  - extra-bay fill 0.85/0.7 → 0.75/0.5.

**Measured**
- models, life and sim self-tests ok; check.sh ok; 0 console errors in iso-mid, iso-close, iso-water, one-fire-station and the sheets.
- Blocks per sedan 2416 → ~1500, bus 9253 → 5900, fire engine 6891 → 4260. iso-mid tris 3.13M → 2.65M (shared scene, other pieces changed too).
- fps is load-dominated (load avg 7.5-9, 6 headless Chromes): 27/16/7 before and 2-17/7-9/7-13 after, with fewer tris. It is not a life regression.
- Visually:
  - r10-sheet1/2: every kind reads at a glance, with dark window strip, black wheels, lamps, ambulance crosses/band/light bar/chevrons, panda police and taxi sign;
  - r10-one: the fire-station apron and bay engines read as ladder trucks;
  - r10-builder iso-close: kerb rows are calmer and cars sit small and tidy in the lanes and bays.

**Next**
- People are unchanged (0.875 tall). If the "posts" note repeats, try a head a voxel wider than the torso (chibi) rather than a taller figure.
- Moving traffic is now sparse in some poses. If a critic calls streets empty, raise CARS_PER_TILE back toward 2.6 rather than refilling the kerbs.
- Bays are still 2.4 long for 1.44 sedans. A painted bay shorter than the pitch (~2.0) would look snugger.

## 2026-09-24 — round 11 (builder)

Critic r10 picked the reference. Biggest gap: vehicles "sparse and generic": a few lone cars on big empty asphalt, lot bays nearly empty, no fleets that match their building. Secondary: pedestrians "too tall, as tall as a car is long"; cars become specks at mid zoom.
**Found first.** Sparseness in the shots was mostly a *spawn/recycle* bug, not the density knobs. The r10 post-eval counted **4-35 cars in view of 46-120 alive**. Four causes:
- Spawn was capped at 6 per frame and recycle at 3 per frame. The review Chromes run at 1-10 fps, so after the camera jump most of the crowd stayed off screen.
- One refused spawn (a junction tile, or another car in the way) ended that frame's spawning.
- Every car spawned mid-tile, which gives only 2 spawn spots per tile.
- The pop cap was 4 + pop/8. A town of 991 was capped at 127 cars against 250+ wanted.

**Changed**
- `life.js`:
  - Spawn and recycle budgets follow wall time (`budget` = 6/frame at 60 fps, up to 90). `_maintain` tolerates refusals. Spawns skip junction tiles and pick another, and land anywhere along the straight while staying clear of the stop-bar zones. Pop cap is now pop/3, CAR_CAP 190 → 300, CARS_PER_TILE 2.3 → 3.2. Now 33-38 in view at iso-close (was 4-17) and 160-185 at iso-mid (was 35).
  - Kerbside fleets:
    - `FLEET` entries can be exact variants `V(kind, livery)`, so depots line up one livery (warehouse and mega-factory get orange delivery trucks).
    - A new `LEAD` table puts a shop's own van in its first bay: bakery (pink), pizza (red with a roof sign), florist, post, grocer truck, ice-cream truck at ice-cream/candy.
    - `DEPOT` covers the other factories, and fun buildings park shoppers.
    - Fill rates: fleet p/fill 1/0.95, shop 0.9/0.8, home 0.6/0.55, other 0.8/0.7. A fleet's second long vehicle lines up behind the first. PARKED_CAP 900, PARKED_TILES 300.
    - Self-test asserts no two bays on a kerb overlap, and that the fire-station kerb is filled.
  - Traffic flow (denser traffic had made gridlock and ghost overlaps worse):
    - Junction claims are a heading bitmask. The oncoming flow shares the junction unless someone turns left.
    - Waits are fair and persistent: a flow waiting >1 s goes next.
    - Don't-block-the-box: `a.pre` picks the exit early, and a car only enters when the exit tile has room. `_advance` honours `a.pre`.
    - No ghosting for cars queued behind a stopped car. Ghosting starts after 8 s at a junction, or after 20 s in any queue as a safety valve.
    - In-game 40 s at iso-mid: overlap samples 187 → 17, ghosting cars 14 → 1.6 per frame.
  - CAR_MIX has more vans and trucks and fewer taxis. CAR_COLOURS 6 → 10. Taxi-heavy site kinds are trimmed.
- `vehicles.js`:
  - Liveries by colour slot (`VAN_LIV`, `BOX_LIV`; slot = floor(variant/14) % 6). Panel van (now 13 tall): courier, bakery pink, pizza red + roof sign, post yellow, florist, plumber. Each has a 2-row band, a logo patch with an icon, and a roof panel in the trade colour so it reads from above. Box truck: orange delivery (ref05), removals, grocer, parcels, all-orange, dairy. The **box roof is now the box colour**; the old white top made orange trucks read white from the iso camera.
  - People: RP = RV (18), adult legs 4 → 3. That makes them 13 voxels = 0.72 tall (was 0.875) and stockier, the same size as the stampPerson lot figures.
- Surgical, outside my files: terrain.js street-strip / depot car-park fill 0.7 / 0.75 → 0.9.

**Measured**
- life, models and sim self-tests ok; check.sh ok; 0 console errors in iso-mid, iso-close, iso-water, one-fire-station, one-warehouse and one-bakery.
- In-page A/B at dpr 1 (render with life shown vs hidden, load avg ~13): iso-mid ~3 ms vs ~2.7 ms, iso-close ~1.7 ms vs ~1.5 ms. 280-300 cars is fine on M5; draw calls are +~100 dynamics.
- Stopped share ~40 % at full density (30 % at 0.55 density). Queues form at the grid's 4-tile junction spacing.

**Next**
- The big terrain car park beside the iso-close shops still has deep 4.2 stalls for 1.4 cars, so they look sparse. Terrain could use ~2.4-deep stalls, or double-park nose-to-tail.
- Instanced dynamics in the engine would make CAR_CAP 400+ cheap.
- If "too many taxis/school buses" comes up, trim SITE_KINDS / LEAD rather than CAR_MIX.

### Coordinator note (2026-09-24 20:48) — alignment bug (r11)
"Blue car and ambulance straddle dashes and bay lines, taxis sit on the centre dash."
CAR_LANE already follows roads r14, so check: (1) kerbside bay positions/depth vs the
roads builder's current bay markings (roads.js may have moved/resized them after
r14), (2) turn arcs and U-turns crossing the centre line mid-block, (3) cars sampled
mid-turn by the screenshot. Freeze time (BV.sim.state.speed=0 as the shots do) and
overlay a top-down check of every car centre vs lane centre / bay rect; add it to a
self-test. Also stronger contact shadow under vehicles (a dark 1-voxel footprint
plate at res works well at iso zoom).

## 2026-09-24 — round 12 (builder)

Critic r11 picked the reference. Biggest gap: cars on the iso-close avenue "placed loosely": far-lane cars straddled the bay lines, near-lane taxis sat on the centre dash. Contact shadows were weak, and wheels and windows broke up into "dark speckled crosses". They asked for lane/bay snapping, a dark soft shadow per vehicle, one dark block per wheel and flat glass.
**Found first.** The footprints were already exactly on the lane path (1.5 off the centre line). The straddling came from the **orthographic iso lean**: a roof h up draws over ground h·cot(35.26°)·(1,1)/√2 behind it, i.e. h across-road on an axis road. So every body leaned onto the far line: bay lines in the far lane, centre dashes in the near lane. Dynamics also get no AO and no sun shadow, so nothing anchored them.

**Changed**
- `life.js`:
  - CAR_LANE 1.5 → 1.25. That is the middle of the driving strip between the centre dashes (0) and the bay lane-line (KERB − 0.93 = 2.37).
  - New iso-lean compensation. `_leanRefresh()` reads the camera matrix each update (leanX/Z = e8/e9, e10/e9). `_placeCar` shifts the drawn car ACROSS its lane only, by LEAN·height·(lean·right), where LEAN = 0.5 centres the silhouette. Path positions, gaps and claims are unchanged. The shift is continuous through bends and follows the eased Q/E rotation. Agents carry `bh` (model height).
- `engine.js` (surgical, makeDynamic): optional `model.blobs = [[x, z, w, l, y, opacity]]` soft contact shadows.
  - Each blob is a 9-slice quad with vertex alpha: the footprint is at full opacity and fades to 0 over 0.2 units. The material is black, transparent, with no depth write, so the AO and shadow passes skip it.
  - All blobs are instances of InstancedMeshes pooled by opacity (`_blobAlloc`). A vertex patch scales the core by the instance's aBlob (w, l) and keeps the fade ring fixed.
  - Each pool uploads only its used range. Parked and lot cars use opacity 0.86, so they sit in their own static pool, and only the 0.88 moving pool re-uploads each frame.
  - Documented in CONTRACTS.md.
- `vehicles.js`:
  - withBlob() is applied to carModel (0.88), personModel (0.6) and dogModel (0.4). parkedRowModel, inBay and lotCarsModel emit one blob per car (0.86).
  - Wheels are one solid black block: the grey rim, hub, cut corners and dark-grey arch lid are gone, and d ≥ 5 wheels only round their top corners.
  - Glass is one flat colour: GLASS_DK and GLASS_HI alias to GLASS, so there are no streaks and no dark top row.
  - Door seams and the chrome handle pixels are off.
- `core.js` [vehicles]: vehGlass 0x26374d → 0x2b4262 (a touch bluer; flat panes now).

**Measured**
- life, models and sim self-tests ok; check.sh ok; 0 console errors in iso-mid, iso-close and iso-water.
- Blob A/B at dpr 1, instanced (load ~11): no measurable cost at iso-close or iso-mid, within noise. The first child-mesh version had cost about +1.5 ms at iso-mid with ~400 extra draws.
- Pools: moving 300, peds 150, dogs ~60, parked/lot ~1200 live (CAP 4096 each).
- Pixels: on-asphalt (28,30,33); under the blob edge it drops to ~11-20. The blob shows clearly on the grey lot asphalt, and on the black road it reads as a dark halo on the near side.
- Visually (r12-builder/z1 is the r11 critic's region):
  - every moving car's body sits centred between the dashes and the bay line (far lane) or the kerb (near lane);
  - wheels are clean black squares and windows flat;
  - iso-mid traffic reads as two orderly lanes per street.

**Next**
- Parked cars in NEAR-side bays still lean their roof over the bay's road line. The ref's lot ambulances do the same, since in iso that is normal occlusion. If a critic calls it out, split the bay paint from the car row (two dynamics per tile) and give the cars the same across-shift.
- On near-black asphalt the blob has little contrast. An offset toward the sun's shadow side, done in the instance transform, would read more like ref05's cast shadows.
- People are unchanged in size (0.72) apart from the new blob. If "barely visible" repeats, try RP 16 (0.81), the midpoint between the r10 "too tall" and r11 verdicts.

## 2026-09-24 — round 13 (builder)

Critic r12 picked the reference. Biggest gap: traffic read as "low-detail, rounded-off blobs in a candy palette" (pink vans, lime/teal hatchbacks): no dark windshield or side glass, no visible black wheels, toy-set colours. Secondary: people 1-2 px specks; service vehicles should be parked with purpose.
**Found first.** A colour-strip probe (`scratchpad/lsheet13.js`, 8 dark palette cubes) showed that ANY near-black top face renders as a flat grey of about (145,150,155), which is sky spec on a dark albedo, while the vertical faces stay near-black. So from the iso camera the old inset glasshouse showed only as a thin dark band, and the roof dominated. Flush tyres hid under the shoulder from above. The saturated palette (vehGreen, mint, teal, pink, purple) is pushed further by the post grade.

**Changed**
- `vehicles.js`:
  - `cabin()` continues the windscreen (2 rows) and rear window (1 row) onto the roof inside a body-colour pillar frame (`topF`/`topB`). From above it reads as ref05's light-grey reflecting screen, and the side glass is a black band.
  - New `flare()` pass on every vehicle grid: each tyre stands one voxel proud of the flank, so there are black wheel tops at all four corners. Cars are 12 wide = 0.67, trucks 13.
  - CAR_COLS are real paints: white ×3, silver (vehPearl) ×2, grey, one charcoal, red ×2, blue ×2, bottle green, yellow, orange. Pink, purple, mint, teal and crimson are gone. Two charcoal slots made holes in the near-black asphalt, so there is one.
  - Racing stripes 28 % → 12 %.
  - Panel van 13 → 12 tall. Bakery livery is now a white van with a pink band, and the roof logo patch is smaller.
  - Ice-cream roof is white with a pink rim (the cone stays).
  - People RP 18 → 16 (0.81 tall; the lot figures stay at 0.72).
- `core.js` [vehicles]:
  - vehGlass 0x141a26;
  - the unused vehGlassDk/Hi slots are renamed vehCharcoal 0x3b3f46 and vehPearl 0xb3b8bf;
  - vehRed 0xd83a31 (a touch deeper);
  - vehGreen 0x3a7a4a;
  - vehBlue is unchanged because residential props use it. Car blue is C.blue.
- `life.js`:
  - CAR_MIX is more private cars and fewer vans / taxis / ice-cream.
  - FLEET adds an ambulance at swimming-pool and stadium, and two police cars at city-bank. The catalog has no hospital or police station.

**Measured**
- life, sim and models self-tests ok; check.sh ok; 0 console errors in iso-mid, iso-close and iso-water.
- fps 2-12 on a loaded machine (load avg 10-20). Model blocks are +~5 % per car.
- Visually (r13-builder, crops c1/c2): traffic reads as white/silver/red/blue city cars with black side glass, grey screens on the roof and black corner wheels. Ambulance and fire engine liveries read at iso-close, and a person on the sidewalk shows a head and shirt.

**Next**
- Dark-top-face = grey is a renderer trait. If a critic wants DARK windscreens from above, the fix belongs in materials (a vehicle-glass class with low spec), not in the model.
- School buses cluster near schools (SITE_KINDS). Trim if called out.
- A hospital / police-station building would let the ambulance/police fleets sit "with purpose" as in ref05.

## 2026-09-24 — round 14 (builder)

The r13 critic picked the reference. Biggest gap: our vehicles read as "smooth, rounded white boxes with a pink or green roof stripe": no wheels, glass, lights or bumpers, and one van repeated 5-6 times. Secondary notes: soft/blurry edges (post AA, not my file), and people as tan-and-green blocks.

**Found first (root cause, not model detail).**
- In-page pixel probes (Browser pane, canvas readback) of a plain white 12×10×26 box on the road gave these values:
  - top 248;
  - lit side 180;
  - shade side (+Z) **25**, which is the colour of the asphalt.
- The same happened on a static-flagged copy, with SSAO off and at every rotation.
- Geometry dump: every vertical face of a 0.5-unit model had aoT **0.24-0.43**. The mesher's building-scale AO does this:
  - 2-unit rays;
  - a solid ground plane;
  - broad and sky terms reaching 3.5 units.
  All of these swallow a car-sized object whole. The shade-side flank therefore went black and took the wheels, glass, lamps and livery with it. Rounds 10-13 detailed the models, but on the shade side that detail never showed.

**Changed**
- `engine.js` (surgical, `_getGeometry`): merges an optional `model.voxOpts` into the mesher options. Documented in CONTRACTS.md makeDynamic.
- `vehicles.js`:
  - `VOX_SMALL = { aoDist: 0.25, aoSpread: 0 }` via `small()` on carModel, inBay, parkedRowModel, lotCarsModel, lot parts, people, dogs, boats and balloons. With aoDist < 1 the voxel.js broad/sky/floor terms switch off, as they do for props.
  - Result: the shade flank goes 25 → ~185.
  - Recessed 2×2 grey hub in every tyre. flare() copies only TYRE voxels, so the hub sits one voxel deep.
  - Van roof logo patches removed (the "roof stripe"). A grey vent and dark roof bars replace them.
  - Florist van is now a green body and plumber a blue body, so 2 of 6 liveries are white (was 4).
  - CAR_COLS: one white fewer, plus teal.
  - Person smile pixel removed (it read as a clown nose).
- `core.js` [vehicles]: vehGlass 0x141a26 → 0x17233c (dark navy). 0x1b3050 was tested and the grade lifted it to lavender; 0x192844 was already slate.
- `life.js` LEAD: cafe and music-store no longer lead with a van, and the diner gets the red food van. The bakery's white van had stood at three kerbs of one block.

**Measured**
- life, models and sim self-tests ok; check.sh ok; 0 console errors in iso-mid, iso-close and iso-water.
- fps is not meaningful this round: load avg ~30, and the Browser pane Chrome was also running.
- Visually (r14-builder):
  - ambulances show the red cross, band and chevrons on both flanks;
  - taxis show their checker;
  - police cars are two-tone;
  - box trucks show their logo panel;
  - black wheels with hubs, navy glass and lamps read at iso-close.

**Next**
- Shade faces of small props elsewhere (benches, bins, lot people stamped by other pieces into building voxels) probably suffer the same building-scale AO. Pieces that own them could pass `voxOpts` too.
- Soft edges are post AA (post.js), not the models.
- Tools: `scratchpad/recv.py` (POST receiver on :8399) plus an in-page `__cap()` gave full-res captures from the Browser pane without a 4-minute shoot.mjs run.

## 2026-09-25 — wave 2, round 1 (builder)

Brief consensus: distinct readable types, dark wheels, continuous glass band, bright varied paint, no
dark cars vanishing into asphalt, emergency vehicles RARE and in context, centred in lanes/bays.
Coherence list: only item 9 is tagged life ("no action unless the art direction wants bigger movers") —
size left alone (the r2/r4/r6/r8 consensus).

**Found first.** Baseline iso-close (`scratchpad/rounds/life/r1-base`): the windscreens still read as
lavender-grey "venetian blinds" from above (the dark vehGlass top faces lift to sky-spec grey, and the
2-row raked steps alternate grey tops with dark fronts); two white vans with red / pink bands (courier,
bakery) and the red pizza van read as ambulances / a fire van; three police cars + an ambulance + a fire
engine on one shopping street (CAR_MIX 5 % police, 3 % ambulance, 2 % fire + SITE_P 0.35).
New fast harness: `scratchpad/life/lshoot.mjs --sheet scratchpad/life/sheet.js --shots close,close2,far`
boots WITHOUT the demo city (BVDEMO.reseed(), clears trees, paints two roads, lays every kind + a colour
sweep + people + a parked row; `--pre "window.__patch=[[from,to],...]"` tests vehicles.js edits via a
blob-URL import without touching the live file). ~6 s a shot vs ~2.5 min for shoot.mjs.

**Changed**
- `vehicles.js`: `skyGlass()` pass on every vehicle grid: glass voxels showing a top / front / rear face
  (windscreen, rear window, roof screen rows) become `SCREEN = C.skyBlue` = the materials.js glass class
  (clear blue + sky reflection + sheen, the buildings' panes); side panes stay the dark navy band. Reads
  as ref05's bright reflecting screens from above; no more grey blinds. Night: screens do not glow.
- `CAR_COLS`: no charcoal / stone bodies; white ×2, silver, red ×2, blue ×2, teal, green, yellow, orange.
- Van liveries: courier white + ORANGE band, bakery CREAM + brown band, pizza WHITE + green band with a
  red/yellow roof sign (none reads as an ambulance / fire van any more).
- `life.js`: CAR_MIX fire 0 / ambulance 0 / police 1.2 % / ice-cream + school bus 0.4 %, the share goes
  to sedans / city cars / vans / box trucks; emergency kinds only come from their site streets
  (SITE_KINDS) and kerbs (FLEET); `EMERG_CAP = 3` driving at once; SITE_P 0.35 → 0.25; ambulances no
  longer park at swimming-pool / stadium (no hospital in the catalog), bank keeps one police car.

**Measured**
- life + models self-tests ok (node: maxJump 1, 0 overlaps); check.sh ok; 0 console errors in
  iso-mid / iso-close / iso-water (r1-builder). fps in those runs 27 / 29 / 21 at dpr 2 on a shared
  machine (baseline run 5 / 5 / 2 under heavier load) — no geometry added (same voxel counts).
- Visually: iso-close street traffic is a mix of red / blue / white / teal / yellow cars with bright
  screens and black wheels; one fire engine only near the fire station; vans read as trades.

**Next**
- Instanced movers (perf idea 3) needs `instanceMatrix` in materials.js VERT_BODY (it uses modelMatrix
  for vVoxWorld / normals) — owner of materials.js; then life can put each variant in one InstancedMesh.
- Blue bodies + blue glass-class screens are low contrast; a lighter/whiter screen class would fix it.
- Van roof bars (dark) read a bit heavy from above; the farm tractor (another piece) dwarfs the traffic.
