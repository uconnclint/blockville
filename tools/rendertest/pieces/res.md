
## 2026-09-24 — round 1 (builder)

**Changed.** Rewrote `src/models/residential.js`: all 12 homes plus the zoned R levels (L1 = small house or cottage, L2 = townhouse, duplex or big house, L3 = apartment) are now res 4. Every home sits on a `lotPlinth` with its own garden or paving. Shared kit in the file:
- stepped `gableRoof` (either axis, rise 2 gives the steep ref05 roofs, a darker course every third row, verge boards, fascia, ridge cap) and `hipRoof`
- `dormer`, `chimney`, `quoins` (the ref04 signature), `belt`, `win` (framed window + optional shutters and flower box), door `hood`, `balcony`, `roofSolar` (a flush panel that follows the stepped slope)
- lot props: picket `fence` on a base board, `hedge`, lime `tree`, `pine`, `flowerBed`, `mailbox`, `bins`, `car`, `umbrella`, `lounger`, `dish`, `waterTank`, `topiary`

Every variant has its own colour scheme plus at least one detail difference: roof type, dormers, well / bench / bird bath, fire pit / canoe, barn / coop / silo, a different roof on the beach house, roof garden / solar / tank, tennis court / pool, gazebo.

Palette: added only 6 colours (`resTerracotta`, `resTerraTrim`, `resTileOrangeDk`, `resSlate`, `resSlateDk`, `resTileGreenDk`). **The shared palette overflowed 200 when I first added ~44 colours**: key order pushed the vehicle colours onto the glow indices 200+. Every block must reuse existing colours first (166 entries now).

**Measured.** `_selfTest` ok. Shots gal-homes-1/2, one-small-house and one-apartment: 0 console errors, 55–61 fps. Homes in the demo city: 139 buildings, 1.01M tris; my first pass was 1.25M, and the old res-1 homes were ~85k. Per model: small house 4.4–5.9k, cottage 5.4–5.8k, big house 5.6–6.9k, townhouse 7.1–7.4k, duplex 7.7–8k, cabin 6.5–6.8k, farmhouse 6.7–7k, beach 5–5.1k, apartment 8.8–9.1k, tall 10.4–10.9k, condo ~35k, mansion 17–18k. Hero shot: 41 fps overall (2.7M tris, all pieces).

**Learned (triangle cost).** The mesher's AO reach is 4 fine voxels at res 4, and greedy merging needs identical AO, so any surface within ~4 voxels of a 2D feature becomes one quad per voxel.
- A proud lintel costs ~50 tris, a recessed 3×8 pane 26, a flush pane with an in-plane frame ring 18. A proud belt course on a dense tower costs ~500; a colour line painted in the wall plane costs ~20.
- A tree's top cap costs ~100 (removed). A picket fence on a continuous base board costs 310 against 532 without one.
- Tools in the scratchpad: `res/ablate.py` (per-line ablation of a builder), `res/bycolor.mjs` (tris per palette colour), `res/cost*.mjs`.

**Next.**
1. Ask the voxel/render owner about quantised AO or AO-aware merging. It is the single biggest triangle lever (probably 2–3x).
2. Ask the terrain owner to stop drawing the old pad under res-4 lots (there is a double rim today).
3. Townhouse and duplex are still ~7.5k: cut some back/side windows, or make them flush.
4. Condo: vary the massing more (setbacks) and possibly go lower.
5. Compare against ref05 houses for roof tile contrast: the dark courses could be stronger.

## 2026-09-24 — round 2 (builder)

**Critic (r1):** reference won. Biggest gap: facade + roof detail density (flat red roof slab, blobby
solar "skylight", bare yellow walls), toy-like primary colours, oversized trees on the facade, plain grey
apartment ground floor, repetitive apartment window grid.

**Changed** (`src/models/residential.js` kit rewritten, every home re-dressed; 6 palette entries added):
- Muted palette. The grade + warm key push saturation ~1.6x on walls and more on roof tops (measured:
  `e8955a` rendered `fb8231`, ref04's lit wall is `cc834a`). So `res*` colours are now authored muted
  (`resTerracotta cf9e80`, `resQuoin eedfc4`, `resTerraTrim b47755`, `resTile bf8062/resTileDk 8a5646`,
  `resButter`, `resSage`, `resRoofRed a0605a`). They render like ref04's terracotta and cream. Every home
  now uses a 3-tone scheme: wall / light quoin-trim / dark accent. No more pYellow/pPink/roofRed/roofBlue.
- Roofs: tile courses of a lit row over a 1-voxel shadow lip. The rows run along the slope, so they still
  merge. `run` param (rise 2, run 2 = 45°) keeps roofs from swamping 1-storey walls. Ridge cap with end
  blocks. The hip roof shares the lip treatment. `hipSlope()` lets dormers sit on hip roofs. The stepped
  `roofSolar` was the "blobby skylight", so it is gone. Flat roofs use a raised `solarArray` instead.
- Facade kit: `quoins` (the ref04 stacked blocks, 1-voxel joint, 3/2 arms), `cornice` (2-step),
  `win` (proud accent frame ring, sash bar, light sill ledge + head, optional shutters and flower box),
  `entry` (proud surround + light inner frame + door + step + red mat + amber `lamp`s + optional canopy),
  `downpipe`, `railBalcony`.
- Small house redesigned: quoined 26×19 body, grand entry flanked by lamps and potted topiaries, 2 framed
  windows per gable plus an attic window, a back patio door and window, a dormer (the hip variant too),
  a chimney. The lot has a low fence + gate, mailbox, flower bed, patio set, BBQ and bushes. The only
  tree is small and sits in the back corner.
- Cottage is now half-timber (sole/wall plates, corner posts, studs, king post) with an exterior stone
  chimney. Big house has quoins, a porch carrying a railed balcony, and a garage with a panel door + solar.
  Townhouse, duplex, farmhouse, beach house, cabin, tall, condo and mansion got the new palettes, the new
  windows and small fixes.
- Apartment: a pilastered ground floor (capitals, lobby glazing, canopy, sign, lamps, awning at the
  back). Upper-floor bays change by floor (paired balconies → centre loggia → tall top floor). There
  are quoins, flush floor lines, a 2-step cornice, and flat framed side windows with a sill course,
  staggered ACs and a downpipe.

**Measured.** The mesher changed under us twice this round, so costs are relative to r1 on the same
mesher. Per-type means, r1 → r2: small 4790→6128, cottage 5227→6095, big 5744→6698, town 6862→8294,
duplex 7251→8000, apt 8453→10705. The sum is 118k→126k (+6%). `_selfTest` ok, R levels ok, 0 console
errors. FPS: gallery shots 61 when the GPU is free. Other builders' concurrent Chromes pulled some runs
down to 15–40, so those fps numbers are noise.
Costs on the current mesher: a quoin block about 88 tris, a lamp 166, a dormer about 630. A window with a
recessed pane + proud ring + 2-deep sill cost 416; glass flush + proud ring + 1-deep sill costs about 230
(now the default, `o.deep` for recessed).

**Tools** (scratchpad `res/`): `shootv.mjs --vid <id> [--voff n]` swaps every gallery slot for variants
of one id (the gallery otherwise picks variants by position hash). `tcmp.mjs <modelsDir>` gives per-type
mean tris. `wcost.mjs` gives window cost variants. `ablate.py` is still useful.

**Next.**
1. The softness the critic called out comes from post, not models. Ask the post owner (FXAA/DOF/tilt).
2. Townhouse and apartment are the heaviest per 1×1. Cheaper balcony rails (posts every 4) would help.
3. Tall apartment and condo still carry r1 massing. Give them the pilastered base + quoins.
4. The gallery's neighbouring decor (big lime trees, parks) sits next to the house in `one-*` shots.
   That comes from terrain/decor, not res.

### Coordinator note (2026-09-24 12:45)
Round 3's builder was stopped mid-work by the coordinator (my error), right as it was
starting a small-house rewrite ("calm ref04-style lot, bigger quoins, flat-roofed
ref04 homage variant"). Pick up from what's on disk. Someone else also touched
residential.js around 11:25-11:30 (box dormer, verge in roof tone, fence/flowerBox/
flowerBed) — probably another artist adding shared helpers; keep those unless
they're wrong, and re-read before every Edit. You are the only res builder.

## 2026-09-24 — round 3 (builder)

**Critic (r2):** reference won. The biggest gap was blotchy, mottled quoins and roof tiles, a jagged
green dormer trim and a cluttered front yard.

**Root cause of the mottling: shadow acne from lighting.js, not our colours.** The blotches survived
post `debug:'raw'`, voxel AO off and env off, and vanished with `shadowStrength 0`. Lighting debug
mode 6 showed sawtooth acne on every res-4 step, quoin and canopy edge. BackSide second-depth casters
assume thick shells, but res-4 details are thin along the light ray. Tested live:
`depthBiasTexels 0.5→2.5` plus `normalOffsetTexels 1→2` clears it. I reported this to the
coordinator and it is now in lighting.js (not my edit).

**Changed** (residential.js; someone else also edited this file mid-round):
- Kit: box dormers with a flat roof (straight trim band plus a tile cap), verge boards in the roof's
  shadow tone (no contrasting stair-step line), a clean low-board `fence`, a green-band `flowerBox`,
  and a hedge `flowerBed`. `lamp` is now a 2×2 lantern on an arm with a trim cap.
- Small house: a 22×17 body with 2–4 voxels of lawn all round. The front is ref04's door face: a deep
  double door in a surround, lamps, a flush red mat, two potted topiaries at the corners (clear of the
  lamps) and nothing else. There are deep-framed sash windows on the sides.
  - v2 is the ref04 homage: a flat cream deck, quoin posts with caps, a trim rail, and a smaller rooftop
    stair house with a door, an AC unit and a topiary.
  - v0 is a gable with a box dormer, v1 a slate hip roof, v3 a red gable with a gate wall.
  - I removed the downpipe, and most variants no longer have a mailbox.
- Decluttered lots. Cottage: no beds, arbor or pickets, just two hedges framing the path. Duplex: one
  dividing hedge. Big house: no bed or bins. Townhouse: no bins or topiary. Apartment: confetti
  planters became clipped shrub boxes.
- Breathing room: the duplex is x 3..27 (was 1..29) and the big-house garage is 20..27 (was 20..29).

**Measured.** `_selfTest` ok. All modules parse. 0 console errors.
- gal-homes-1: 297k tris, 61 fps.
- gal-homes-2: 355k tris, 60 fps.
- one-small-house: 159k tris, 46–61 fps (varies with GPU load).
- one-apartment: 202k tris, 47 fps.
Shots are in `rounds/res/r3-builder`. The diagnosis shots are in `rounds/res/r3-diag` (`diag8.png`
is bias 2.5 against the default).

**Next.**
1. Face-tone separation and murky eave shadows belong to light and post. Check them after light's bias
   change lands everywhere.
2. The gallery still packs 1×1 lots edge to edge (demo-city layout). The townhouse, cabin and cottage
   could each give up another 1–2 voxels of footprint.
3. The tall apartment and condo still carry r1 massing.
4. A proper ref04-style window (outer ring, inset ring, recessed glass) as a `win` option for hero
   faces.

## 2026-09-24 — round 4 (builder)

**Critic (r3):** reference won. The biggest gap was that the voxels were about 2x too coarse: a window was one fat block, a roof a few thick slabs, the castle-top house read as a toy fort, and lots were big empty lime lawns.

**Changed. The fix is real resolution: every home, all 12 ids and the zoned R levels, is now res 8.** `src/models/residential.js` is a full rewrite, with sources and tools in scratchpad `res/r4/`: kit.js + b1-b4.js, `build.sh`, `deploy.sh`, `tri.mjs`, `abl.py`, `cost*.mjs`.
- **Kit at res 8.**
  - 1-voxel (1/8 unit) frames, sills and sash bars; 5×9 windows; small quoins (flat by default); slim 3-voxel pilasters.
  - Gables at rise 2, run 1: thin, steep tile courses like ref05. Hips at rise 1, run 1 with a dark course every third, so they read as smooth.
  - Box and gabled dormers, flush roof solar panels, hoods, lamps, rail and glass balconies.
  - `lot()` keeps the 0.5-unit plinth with a 2-voxel rim. Tall volumes are thick shells (`solid()`).
  - A typed-array `grid()` replaces the Map version (20-430 ms → 1-30 ms per model).
  - Lot trees come from `stampVeg` (the ref06 shapes at half size). Parked cars are the real res-8 `carModel`.
- **Lots are busy.** Paths, drives with a car, fences with gates, flower and vegetable beds, bins, mailboxes, topiaries, patios and umbrellas, trampolines, a shed, a pool, swings, a fire pit, a canoe. Backs are dressed too: the gallery camera now often shows the back side.
- **Lawns use `C.pGreen`.** `lotGrass` rendered neon #b5fc15 next to the calm terrain grass.
- **The castle-top v2 is gone.** In its place is a cross-gable terracotta house with a front wing.

**Integration changes outside my files (surgical, flagged):**
1. `src/models/catalog.js`: `catalogModel` has an LRU memo (24 entries), so the same (id, variant) returns the same object and `engine._geoCache` meshes it once. Before this, every placement and every ghost-hover tile change re-meshed. At res 8 that is 50-900 ms per mesh, and the demo build went 9 → 20 s.
2. `src/render/voxel.js`: the ray-AO merge tolerance scales by `max(1, res/4)`. Res ≤ 4 models are unchanged. A side-by-side at tolerance 1.0 is indistinguishable (`rounds/res/tolcmp.png`), and it halves res-8 triangles.

**Measured.**
- `_selfTest` ok, voxel `selfTest` pass, 0 console errors.
- Tris per model: small house 7.5-10k, cottage 8.5-9.3k, big house 8-10k, townhouse 10k, duplex 12k, cabin 7k, farmhouse 8-9.6k, beach house 6-7k, apartment 13-14k, tall apartment 18k, condo 34-35k, mansion 23k.
- Demo city: 170 homes = 1.81M tris. That is 3.4M before the tolerance change; r3 was ~1.2M.
- Gallery fps 53-61 when the GPU is free. More than 50 concurrent harness Chromes made single readings of 14-40 noise.
- Demo buildMs ~12 s (baseline 9 s).
- Shots are in `rounds/res/r4-builder`.

**Palette warning for the coordinator:** core `_colors` has 206 regular keys, so `vehNavy`/`vehPolice`/`vehStripe`/`vehHullRed`/`vehDeck` now sit on indices 200-205. 200-203 collide with the glow colours (win, winCool, lamp, neon). I tried a `resLawn` and reverted it. Someone must free slots.

**Next.**
1. Density against ref05 is now limited by the gallery layout (wide roads, empty grass), not by the models.
2. Townhouse downpipe reads as a black bar; soften its colour.
3. Condo still costs 0.5-0.8 s to mesh once. Consider a lower sy or fewer floors.
4. The flush roof panels on the gables read as blue stripes. Try a proud framed panel on legs.

### Note from life (r8, 2026-09-24)
The driveway `car()` in residential.js now calls `stampCar` from vehicles.js. It draws the traffic's full-detail car as a res-15 lot part, where the old `carModelAt(v, 8)` resample drew a stepped lump. Please keep this change when you rewrite the file.

## 2026-09-24 — round 5 (builder)

**Critic (r4):** ours won but didn't wow. Biggest gap was detail density. The walls were big blank planes with 2-3 windows. The lots were empty grass with one planter. The critic asked for:
- about twice as many windows, with sills and lintels
- porches and balconies on the long faces
- gutters, plus a second roof element on every house
- fences, paths, sheds and clutter in every lot margin

**The gallery camera mostly sees the BACK and the RIGHT (+x) face of each home.** Density has to be equal on all four faces, not just the front.

**Changed.** Sources are in scratchpad `res/r5/` (kit.js + b1-b4.js). `deploy.sh` now refuses to deploy if someone else edited the live file (it caught life r8's `stampCar` change, which I merged).
- **New kit.**
  - `spread`/`winRow`: evenly spaced framed windows across a wall, with a skip range for doors. Head (lintel) and sill are on by default, so adjacent sills and heads merge into courses.
  - `gutters` (gable) and `hipGutters`: a gutter line plus swan-neck downpipes to the ground.
  - `roofVent` and `skylight`.
  - `shrubs`: foundation planting.
  - `boardFence`/`lotFence`: the sides and back of the lot.
  - Clutter: `crates`, `pot`, `doghouse`, `clothesline`, `bike`, `wheelbarrow`, `woodpile`, `greenhouse`, `pergola`, `trellis`, `plaque`, `sandbox`, `hoseReel`, `compost`.
  - Shutters are now 2 voxels wide, down from 3.
- **Windows roughly doubled on every house, on every face and floor:**
  - small house: 4 front, 3 per side, 4 back, 2 attic per gable
  - cottage: 4 / 2 / 4, plus a trellis vine
  - big house: 3 per floor per side, 4 per floor on the back, and a back balcony + deck
  - townhouse: 4 per floor per side, 5 per floor on the back, 2 back balconies and flower boxes
  - duplex: 3 per floor per side, 6 upstairs on the back, a back balcony and a pergola deck
  - cabin, farmhouse and beach house got the same treatment
- **Roofs.** Every pitched roof has gutters + downpipes, a chimney, and a dormer / vent / skylight or panels. The townhouse's flat roof gained a vent and a hatch.
- **Lots.** Every home is fenced on its sides and back, and each variant has 3-5 clutter items (greenhouse, shed, doghouse, clothesline, sandbox, compost, crates, pots, bike, barrow).
  - The mansion got a formal parterre with a statue, an orangery, a rose pergola walk, side beds, boundary hedges, drive topiaries and lamp posts. It also got hip gutters, back dormers and back balconies.
  - The apartment's side ground floors are now shopfronts with striped awnings.
- **Removed.** The big trees that hid the cottage and cabin facades from the gallery camera are gone. The v1 blue house no longer has a dark shutter band or a dark fence.

**Measured.** `_selfTest` ok, all modules parse, and there were 0 console errors on all 4 shots.
- Tris per model, r4 → r5:
  - small house 8.9k → 10.1k; cottage 9.3k → 11.5k; big house 9.4k → 12.1k
  - townhouse 10.5k → 14.4k; duplex 13.0k → 16.4k; cabin 7.3k → 10.4k
  - farmhouse 9.0k → 12.6k; beach house 6.5k → 7.9k; apartment 13.7k → 16.0k
  - mansion 23k → 30.5k; tall apartment and condo unchanged
  - Overall about +25%.
- **The big cost was fencing.** A post-and-rail side fence costs 640 tris and a solid `boardFence` 212, so three post-and-rail sides were 1.8k per lot. Other costs: pergola ~1k, gutters with 4 pipes 450, a 4-window `winRow` 370, shrubs 400.
- FPS readings were noise. The load average was ~10 from other harness Chromes, and single readings ranged from 9 to 58. At dpr 1: gal-homes-1 53 fps, one-apartment 48 fps.
- Shots are in `rounds/res/r5-builder`.

**For the coordinator:** in the `one-small-house` shot, giant decor flowers and trees from terrain/props are now stamped ON and around the house lot (a red and blue flower the size of the car sits on the drive). That is not from residential.js; it looks like the new decor isn't respecting building lots in `one-*` shots.

**Next.**
1. Duplex and townhouse are the heaviest 1×1s. Put the pergola slats every 4 and skip the side-fence posts.
2. Tall apartment and condo still have r1 massing. Give them ground-floor shopfronts + awnings on every face, plus rooftop gardens and tanks.
3. The front faces are dressed but the gallery rarely shows them. If the critic keeps judging back faces, move more hero detail (door canopies, lamps) to the back.

## 2026-09-24 — round 6 (builder)

**Critic (r5):** the reference won. The biggest gap was block-level density. In gal-homes-1 each home stood on its own lot with asphalt on every side: roads were ~60% of the frame and buildings 15-20%. ref05 packs many buildings shoulder to shoulder on one shared block. Secondary notes:
- the quoins and cornice lips were too faint to read
- the apartment's ground lot was bare
- window glass is flat, and shadows are dark. Glass and shadows belong to materials and lighting, not to res.

**Changed.**
1. **Block layout (the main fix).** This is a surgical harness change in `tools/demo-city.js` `gallery()`, for `homes` only (the `block` flag).
   - Before: the two rows each had a street on both sides, with 3 vacant margin tiles per row.
   - Now: the rows stand back to back, so the 6 homes form ONE block of 3×2 tiles. Row 0 fronts the top street and row 1 fronts the bottom one (sim auto-rotates them to face their roads). The back gardens are shared, there is no middle street, and side roads frame the block tightly.
   - Result: gal-homes-1 is one dense residential block, with fronts in the near row and gardens meeting in the middle. Asphalt dropped to roughly a third of the frame. Shops and deco keep the old packing.
2. **Chunky ref04 quoins.** `quoins()` takes a numeric `flat` (voxels proud, with the thickness filled back to the wall). The small house, big house, townhouse, duplex and mansion now use 2-proud quoins, bh 6, arms [6,3]. That costs only about +150-700 tris per model.
3. **Kit additions:**
   - `paving()`: flagstone joint lines every n voxels (lines, never a checkerboard)
   - `hydrant()`
   - `streetTree()`: a sapling in a kerbed pit
4. **Apartment.** The lot is paved as flagstones.
   - Front: bikes, bins, a hydrant, a news box and pots.
   - Back: a boundary hedge, a flower bed, two street trees in pits, a covered bike rack and pots. The big round tree that hid the back door is gone.
5. **Condo.** The bare back lawn became a residents' park: a paved walk with a cross path, allotment beds, picnic sets, a playground (swings, slide, sandbox, trampoline), a pergola, a flower bed and benches. The forecourt got flagstones, plus bins, bikes and a hydrant.
6. **Tall apartment.** Flagstones, a back hedge, a street tree, bins, a hydrant and pots.

**Measured.**
- `_selfTest` ok, all modules parse, and all four shots had 0 console errors.
- Per-type mean tris (the mesher changed under us mid-round, so compare within a run): small 9.6k, cottage 9.7k, big 11.1k, town 14.3k, duplex 16.1k, cabin 8.9k, farm 11.5k, beach 7.7k, apt 16.8k, tall 18.6k, condo 42.8k, mansion 28.3k. The sum is 196k.
- At dpr 1 under load 7: gal-homes-1 is 646k tris at 61 fps. iso-mid is 3.15M tris at 48 fps.
- Shots are in `rounds/res/r6-w3` (final) and `r6-before`.

**Next.**
1. gal-homes-2 is dominated by the 2×2 condo tower plus the tall apartment, and the camera pulls back for their height, so the block is small in frame. Consider putting condo and mansion on the same row, or capping the gallery dist for homes.
2. The `one-*` framing shows the model at ~15% of the frame, not the documented 65%. The camera/harness owner should check the ortho zoom mapping.
3. Neighbouring lots still show a double light rim at each shared edge. If the block should read as one lot, drop the inner rim on the side and back edges (keep the street kerb).
4. Glass streak and dark cast shadows: pass to the materials and lighting owners.

### Coordinator note (2026-09-24 18:40) — ignore gallery-layout remarks
Critics contradict each other about how the gallery lays buildings out (res r5:
"isolated in asphalt → pack them"; res r6, after packing: "jammed shoulder to
shoulder → separate them"). Layout is the harness's job, not yours — ignore it.
Act on what is consistent across your critics: finer window rhythm / more, smaller
framed windows; trim bands; varied LIGHTER roofs (rooftop terraces, gardens, AC
units, solar) instead of dominant flat dark slabs; denser small props on the lot.

## 2026-09-24 — round 7 (builder)

**Critic (r6):** reference won. Biggest gap: the homes were drawn at ~2x the reference scale and packed shoulder to shoulder on one shared plinth. Heavy navy/dark roofs merged into one pile of silhouettes. Secondary notes: two black blobs on a tower (the townhouse's dark-railed back balconies), identical blue apartment windows, and the small house plainer than ref04.
Past gaps that several critics agree on: density/detail per tile (r4, r5, r6) and dark/heavy tones (r2, r6). The lone r5 "too sparse / too much asphalt" is why r6 packed the block. This round keeps the r6 block and fixes the scale instead.

**Changed.**
1. **Scale (the main fix).** Every home still authors on the r4-r6 res-8 canvas (63 per tile, 127 per 2×2) but now publishes at **res 12**.
   - The local `grid()` wraps a full-tile res-12 grid and offsets every write by `(ox, oz)` (16 voxels on a 1×1, 32 on a 2×2). `g.raw` is the un-offset grid.
   - House and garden shrink to 2/3 of the r6 size. Frames and sills become 1/12 unit, which gives a finer window rhythm.
   - `G` is now 6, so the plinth is still 0.5 units.
   - `car()` stamps on `g.raw`, so lot cars stay at true world size.
2. **Each home's own lot.** `lot(g, x1, z1, fill, v)` now draws the full-tile plinth plus a margin ring.
   - Garden lots: the lawn continues as a verge on the sides and back, with per-variant shrubs or a sapling at the back corners. A flagstone front strip carries a street tree in a kerbed pit, and a light kerb marks where the front garden starts.
   - Paved lots: flagstones all round, a kerb framing the canvas, and a street tree.
   - Between neighbours the sequence is now fence | verge | rim | rim | verge | fence.
3. **Lighter, more varied roofs.** `resSlate`/`resSlateDk` lightened to 9aa3ad/78808e. civic.js also uses `resSlate`, so its slate got lighter too.
   - New `ROOF.sage`.
   - Roof swaps: big house v0 slate→tile, duplex v1 slate→red, duplex v2 brown→sage, cabin v1 slate→tile, cottage v1 slate→orange.
   - Flat roofs are `C.stone`, no longer the dark `roofGray`.
   - Cottage and cabin exterior chimneys are warm brick/sandstone (they were grey stacks) and 3 voxels lower.
4. **Black blobs.** Townhouse back balconies, stoop rails and front railing, the mansion balconies and front fence, and apartment v1's rails all use the trim colour instead of darkGray.
5. **Apartment windows.** Each window hashes to warm or cool glass, one of 4 blind colours (or none), and a sill or flower box. The top floor's middle bays get tall windows. v2's walls went pBlue→butter (blue on blue before).
6. **Small house (the hero).** Proud window frames on the front and sides, a two-step cornice in quoin/trim, and a proud base course.
7. **Palette.** Added `resLawn 9cc77e`. grassLight rendered neon and pGreen rendered mint. The max regular index is now 198 (<200 OK).

**Measured.**
- `_selfTest` ok. All modules parse. 0 console errors on all 4 shots.
- Per-type mean tris dropped from 175.6k to 158.0k. At res 12 the AO merge tolerance scales up, which offsets the added lot ring.
  - small 8.3k, cottage 8.3k, big 9.2k, town 11.3k, duplex 13.0k, cabin 7.6k, farm 9.6k, beach 6.6k, apt 14.6k, tall 14.7k, condo 32.5k, mansion 22.2k
- gal-homes-1 is 362k tris.
- FPS (21-41) is noise: load average hit 119 from the other builders' Chromes.
- Shots: `rounds/res/r7-builder` (final) and `r7-w1..w6` (iterations). `res/r7/top.mjs <id> <v>` dumps a top view of a model.

**Next.**
1. The gallery camera is still ~2x iso-mid scale, so critics compare a zoomed crop of ours against ref05. Consider framing homes at iso-mid scale, or remind critics to crop ours ~1.9x.
2. The condo's glass balconies repeat on every floor, and the tall apartment has the same blue-glass grid. Give both the apartment's per-window variation.
3. Most of page 1 is pitched roofs. A flat-roof terrace variant (ref04: rooftop stair house, AC, planters) on the duplex or big house would add the rooftop gardens and terraces ref05's rowhouses have.
4. The one-* shots frame the house at ~15% of the frame, and terrain's big trees next to the lot now dwarf the smaller house.

## 2026-09-24 — round 8 (builder)

**Critic (r7):** the reference won. The biggest gap: our lots were mostly flat, empty lime lawn with a few plain cube trees, while ref05 uses every square of a lot (paving, fenced beds, patio furniture). Secondary notes: add a ledge on every floor, add rooftop and porch clutter, and the trees are bare lime cubes.
**Past gaps several critics agree on:** density per tile (r4-r7) and empty lawn (r3, r4, r7).

**Changed** (`src/models/residential.js` only; no palette change):
1. **`dressYard(g, seed)`, the main fix.** It runs automatically in `grid().done()` on every home: `lot()` sets `g.yard`. It dresses whatever lawn is still bare after the builder has finished, meaning lawn with nothing within 20 voxels above it and not under a lot car or visitor from `W.__lotCars`.
   - It repeatedly takes the largest free rectangle (`largestRect`, histogram method) and fills it. The first picks become timber-edged lawn patches with flush stepping stones, up to ~30% of the bare area (50% on 2×2 estates). The rest cycles through raised veg beds (`vegBed`: crop rows with produce dots), flower beds, patios with a table and umbrella, box planters, crates with a `barrel`, and pots. The rotation is per lot, so neighbours differ.
   - All leftover cells become warm brick paving: `C.plank` with `C.wood` course lines every 4. This is ref05's tan cobble. `sand` rendered near-white.
   - A second pass furnishes the side and back paving of paved lots (apartment, tall, townhouse, condo) with planters, benches with pots, bike racks, street trees and crates. It fills every other free rectangle and leaves 6-voxel walkways.
   - Builders need no changes. Any new home gets this for free.
2. **`gardenTree`.** It replaces the lime-cube `sapling` for street trees and back-corner trees, and for `tree()` kinds round/column/sapling/pine. It has a clustered crown: two darker low lobes, a main lobe and a top knot, each with a band, plus 16 surface dots of apples, oranges or blossom (4 palettes).
3. **Ledges.** Apartment floor lines and townhouse string courses are now proud `belt`s. The tall apartment's sill course is proud. The farmhouse has a floor string course.
4. **Gotcha.** A Python slice edit briefly deleted `path/fence/hedge/topiary` from the live file (for ~30 s, restored from the backup). Use anchored replacements, never index slices across helper blocks.

**Measured.**
- `_selfTest` ok, all modules parse, and all 4 shots had 0 console errors.
- The mesher changed under us twice this round, so tris are compared on the same mesher against `res/r8/residential.r8-start.js`. The per-type sum went from 133.9k to ~171k (+28%).
  - 1×1 houses: +2.3-2.9k each (about 800 of that is lawn-patch props and trees, 400-500 for the paving courses).
  - Paved lots: +2k.
  - Mansion: +10.5k.
- gal-homes-1 is 390k tris: 46 fps at dpr 1 with load ~11, and 23 fps at dpr 2.
- Shots are in `rounds/res/r8-builder`, with iterations in `r8-w1..w6`. `mypair.png` is my own same-scale pair against ref05.
- Tools: `res/r8/tri8.mjs [moduleFile] [filter]` gives tris per id for any copy of the module (for ablations).

**Seen, not mine:** in gal-homes-2 a plain white box sits over the condo's front pool. It is not in the condo voxels (top view is clean), so it probably comes from life or props.

**Next.**
1. Trim triangles if perf complains. Candidates: the lawn-patch props (shrub/lounger), fewer produce dots, and paving courses every 6.
2. Rooftop clutter on pitched roofs (dishes and solar on more variants) and porch props (chairs, pots) are still thin.
3. The front ring strip is still grey `lotPave`. Could it become warm paving with a planter row by the kerb?

## 2026-09-24 — round 9 (builder)

**Critic (r8):** the reference won. Biggest gap: flat, evenly lit facades ("grey 4-storey apartment" = the pBlue townhouse, the tan green-roofed duplex, the brick big house) with a sparse grid of small dark windows, plain roof slopes, and flat caps with two chimneys. Secondary: gal-homes-2 towers are "repetitive stacked blue window bands", and the small house walls are still plainer than ref04.
**Past gaps that several critics agree on:** detail density per facade/tile (r4-r8), dark/grey tones (r2, r6, r8), lot/rooftop clutter (r5, r7, r8).

**Changed** (`src/models/residential.js` only; no palette change):
1. **New kit (r9 block before the yard dresser).**
   - `rwin`: a proud framed window + a moulded hood with keystone + sill brackets + ONE accessory: `'shut'` shutters, `'box'` flower box, `'awn'` a small striped awning, `'jul'` a Juliet balcony with a potted plant, `'ac'` an AC unit.
   - `richRow`: rotates the accessory kinds along a wall.
   - `rustic`: recessed joint lines on a base.
   - `roofRail`, `stairHouse`, `antenna`, `deckChair`.
   - `roofTop`: a railed busy flat roof with a stair house, condensers, vents, and one of a garden deck, a water tank, or solar + a dish.
   - `towerFloor`: one tower floor in one of three styles (punched windows with sill + head + a hashed box / AC / awning, a full loggia with bar or glass rail and a plant, or corner balconies). `TSTYLE` shifts the style per floor and face.
2. **Townhouse** rewritten.
   - Rusticated base and slim pilasters instead of the fat white quoins. The w2 shots showed the white quoins + frames turning the whole facade grey-white.
   - Every face and floor has rich windows: boxes + Juliet balconies, then an awning floor, then AC / shutters. The back has awnings over the door.
   - The roof is `roofTop` in place of the flat cap + 2 chimneys; one chimney is kept.
   - v2 is now butter walls with terracotta frames (was pBlue, which read grey). v1 has dark green frames.
3. **Duplex:** two-tone, with a rusticated ground floor (terracotta / cream / brick) under the painted upper floor. Rich windows on every face, a front gabled dormer, skylights, panels, and an antenna on v2.
4. **Big house:** rusticated contrasting ground floor, and rich windows on the front, left and back faces and over the garage.
5. **Small house, farmhouse, cabin and mansion:** their windows became `rwin` / `richRow` with rotating accessories. The cabin gained front dormers plus back panels or a skylight (it had plain slopes).
6. **Apartment:** a head over every window, plus hashed striped awnings and small AC units.
7. **Tall apartment** rewritten.
   - A projecting accent bay up the front.
   - `towerFloor` mixes styles per floor and face.
   - The top 3 floors step back to an L terrace with deck, rail, planters, umbrella and chairs.
   - `roofTop` crown. The ground shops got signs and awnings.
   - v1 is sage (was white + pBlue).
8. **Condo** rewritten.
   - Built from `block()` pieces with setbacks: the tower steps twice and the wing once, and each ledge is a terrace.
   - Two accent bays on the tower's front, shopfront awnings, `roofTop` on both roofs and a mast.
   - 13+7 floors (was 15+8), with sy 380.
   - v1 is brick + white (was white + pBlue bands).

**Measured.**
- `_selfTest` ok, all modules parse, 0 console errors on all four shots.
- Per-type mean tris, measured against `res/r9-start.js` on today's mesher: sum 177k → 235k (+32%).
  - small 9.5 → 10.6k, big 10.2 → 11.9k, town 11.6 → 16.9k, duplex 13.4 → 17.4k, cabin 8.9 → 9.7k, farm 10.7 → 12.7k
  - apt 15.7 → 17.9k, tall 17.6 → 28.7k, condo 35.6 → 60.1k (15k per tile), mansion 29.0 → 33.5k
- Mesh time is unchanged (~24-25 s for all variants under load): it scales with grid size, not detail.
- Ablation on the tall apartment: sill + head ~2.9k, accessories ~3.2k, loggias ~3.3k, blinds ~0.1k.
- gal-homes-1 is 473k tris (was 440k) and gal-homes-2 655k (was 584k).
- FPS at dpr 1 under load 20: 42 / 36. At dpr 2: 21 / 18. The baseline under load 30-50 was 22 / 23 at dpr 2, so these readings are noise-dominated.
- Shots: `rounds/res/r9-builder` (final), `r9-before`, `r9-w1..w3`, `r9-perf`. Tools: `res/r9/tri9.mjs [file] [filter]` (tris + build/mesh ms), plus `ab_*.js` ablations.

**Next.**
1. If perf complains, trim the condo first: fewer sill/head strips on punched floors, or glass-only loggias. Then trim the tall apartment.
2. The condo v1 brick and the tall v0 terracotta pilasters are both strongly orange. If they land side by side, move one to cream/sage.
3. The townhouse still carries a lot of white (belts, hoods, balustrade). If a critic says "grey/white" again, put the belts in the wall's darker tone.
4. The small house v1 (pBlue + white quoins) still reads grey-blue. Consider a warmer wall.

## 2026-09-25 — wave 2, round 1 (builder)

(r10's builder left no entry: it moved homes to res 10, rebuilt the small house as a res-12 ref04
homage with `bigQuoins`/`bigWin`/`bigDoor`/`roofDeck`, set roofs to 45° single courses and cut the
yard menu to fewer, larger features. Its start file is scratchpad `res/r10-start.js`.)

**Brief (consensus):** fewer but bigger relief trims, warm clean walls, finer window rhythm on
apartments, lighter varied roofs, dressed lots. Coherence #7: the construction grow stretched the lot.

**Changed.**
1. **Construction grow keeps the lot flat** (`src/engine.js`, surgical, flagged): `_lotInfo(model)`
   detects a 0.5-unit plinth (the top plinth layer covers ≥90% of the footprint) and caches a
   plinth-only model. While `scale.y ≠ 1`, `_growLot` scales the building about the plinth top
   (−0.01, so there is no z-fight) and adds a counter-scaled child mesh of the plinth. The child is
   removed at scale 1. `addBuilding` records `userData.baseY`. This works for every res-4+ category
   with a lot. Verified with every gallery building at 0.35 (`rounds/res/w1-grow`): the lots stay full
   height and the houses squash above them.
2. **Apartment:**
   - chunky 2-proud `bigQuoins` in place of the slim pilasters
   - 2-proud string courses
   - a bold crown: a 2-step cornice, a 5-tall proud parapet, a coping and ref04 `postCaps`
   - windows are now PAIRS of 3-wide recessed panes that share a mullion, in an accent frame ring
     (terracotta or dark green), with a sill and head per pair. That makes 3 pairs front and back
     and 2 per side.
   - one railed balcony per floor that moves between pairs
   - no blinds, window awnings or AC confetti; one flower box in five
   - warm bases: the v2 slate is now terracotta, v1 brickDark. v2 has sage walls with cream quoins.
   - Lesson: single 3-wide windows at a 6-voxel pitch with white frames turned the whole facade
     white (w1-b). Paired windows need wall piers between them.
3. **Towers (`towerFloor`, used by the tall apartment and the condo):** the same paired 3-wide
   rhythm, with no blinds or window awnings and an occasional box or AC unit. Corner balconies span a
   pair. The tall apartment has bigQuoins instead of pilasters and warm bases (was slate).
4. **Yards:** the leftover paving is `sand` with `plank` joints every 6 (ref05's farmhouse yard
   measures #f0cc78-#f0e49c; the plank brick rendered #f0903c and made an orange sea). The raised
   veg / flower bed frames are woodDark/trunk (C.wood rendered orange).
5. **Warmer, lighter roofs and walls:** the mansion v0 slate roof → red, with cream quoins and
   terracotta frames (it read as a grey-white pile). Cabin v1 logs plank → woodDark/trunkDark, and
   the porch deck plank → wood.
   - GOTCHA: on the narrow house bodies the 2-proud quoins cover most of each face, so white quoins
     make a house read grey-white. I tried this on the duplex v2 and big house v1 and reverted.
     Also, `peach` and `resButter` walls render near-neutral grey; `cream` renders ref05's warm tan.

**Measured.**
- `_selfTest` ok, all modules parse, 0 console errors on all four shots.
- Tris (tri9, same mesher): apartment 17.9k → 19.0k, tall 29.8k → 34.6k (the quoins), condo
  64.0k → 59.1k. Other types ±0.5%.
- Shot tris: gal-homes-1 259k, gal-homes-2 425k, one-small-house 161k, one-apartment 191k.
- FPS 15-45 under load average 19 from the other builders' Chromes: noise.
- Shots are in `rounds/res/r1-builder`, with iterations in `w1-before`, `w1-a`, `w1-b` and `w1-c`.

**Next.**
1. Townhouse and duplex still carry r9 slim pilasters or small quoins plus rustication. Give them
   the apartment's crown + paired windows.
2. The tall apartment and condo roofs could get the bold parapet + post caps too.
3. The cabin is still the most orange lot. Consider a stone porch.
4. Check the grow child mesh against a 4×4 res-2 model (L = 0) when one exists.

## 2026-09-26 — wave 4, round 1 (builder)

(An earlier w4r1 builder was stopped at 08:47 without writing notes. On disk from it: `boldCrown`, `ledgeWall`
and `pairWin` kit pieces. The townhouse has bigQuoins, 2-tall belts, a bold crown and paired windows on every face,
with warm schemes and no white. The tall apartment and the condo have boldCrown / ledgeWall parapets and warm
frames in place of white. Its start file is scratchpad `rounds/res/w4-start.js`.)

**Changed** (residential.js only; no palette change):
1. **Calmer yards** (`dressYard`):
   - Yard flower beds are a new `yardBed`: a light `lotRim` kerb round one clipped low shrub mass, with a single
     flower colour sprinkled on top. They replace the grid of stems with a different dot on each.
   - `vegBed` has a trunkDark/trunk frame (woodDark rendered orange), one produce colour per bed, and dots every
     6 on alternate rows.
   - The lawn target goes from 0.45 to 0.5.
2. **Cabin**: a flagstone porch (stone footing, lotPave top, joint lines) replaces the plank deck. The logs,
   porch, fences and bed frames had merged into one orange mass.
3. **Apartment v2**: rails resTileGreenDk and slabs cream (were white, which read grey).
4. **Coherence #7 (grow stretches the lot)**: already fixed by the wave-2 `_growLot` in engine.js, which is
   committed. The earlier w4 check `rounds/res/w4-grow` shows squashed houses on full-height lots.

**Measured.** All modules parse, 0 console errors on all four shots.
- Tris: gal-homes-1 457k, gal-homes-2 668k, one-small-house 318k, one-apartment 400k.
- FPS: one-* 61. The gallery shots read 15-18 under load ~10 from other Chromes, which is noise.
- Shots are in `rounds/res/w4r1-builder`. `w4r1-cur` is the state before this round.

**Next.**
1. The cottage v1's saturated royal-blue roof and red chimney are the loudest things on page 1. Consider a
   dusty slate-blue.
2. Farmhouse and beach house are hidden behind the towers on gal-homes-2 (layout; the harness owns that).
3. If a critic still calls the lots busy, drop the `crates`/`pots` fallbacks in the yard dresser first.

## 2026-09-26 — wave 4, round 2 (builder)

**Critic (w4r1):** reference won. The biggest gap was that our small house was squat: one storey plus a rooftop box, a flat slab under its cornice. ref04 is a tall two-storey mass with plain saturated walls, crisp chunky quoins and deep AO under the ledges.

**Changed** (residential.js only; no palette change):
1. **Small house is two full storeys.**
   - The body is x 18..77, z 24..65 and 54 voxels tall (was 66×44×30), so from the camera it is as tall as it is wide.
   - Walls are plain. Front: door + lamps + a big window each side downstairs, two windows upstairs. Sides: one window downstairs, a pair upstairs. Back: a door + one window downstairs, two upstairs.
   - The v1 deck's stair house is larger (28×21 voxels).
   - The gable, hip and dormer variants fit inside sy 110.
2. **`ref04Block` cornice is 2-step:** a 1-proud band (4 tall) with a 2-proud lip, for a deeper ledge shadow and AO line.
3. **Small-house quoins** use bh 5 and arms [7,4] (were 4 / [8,5]): crisper courses that no longer cover a quarter of each face.
4. **v3** is now cream stucco with terracotta quoins and a slate roof. Its peach wall rendered grey and its royal-blue roof was loud.
5. **Coherence #7 (grow stretches the lot):** `_growLot` is still in engine.js, so no action was needed.

**Measured.** All modules parse, and all four shots had 0 console errors.
- Tris: one-small-house 319k (was 318k), gal-homes-1 459k, gal-homes-2 634k, one-apartment 397k.
- FPS: one-small-house 61, gal 49-54. The one-apartment reading of 10 fps was load noise.
- Shots are in `rounds/res/w4r2-builder` (`chk.png` is the hero next to the v3 preview) and `w4r2-a` (the first iteration). The start file is `rounds/res/w4r2-start.js`.

**Next.**
1. If a critic still wants more AO under ledges, that is the lighting/materials AO strength, not geometry. The cornice and quoins are now 2 proud.
2. Cottage v1's royal-blue roof is still the loudest thing on page 1. Consider `ROOF.slate` there too.
3. Big house and duplex could get the same "tall plain walls, trim carries detail" treatment if critics compare them against ref04.

## 2026-09-26 — wave 4, round 3 (builder)

**Critic (w4r2):** reference won. Small house read fussy and spindly: thin, deeply inset windows with fine mullions, small quoin steps, thin parapet. Also a grey rock poking up behind the roof.
**Consensus across w4r1+w4r2:** tall plain walls with FEWER, BIGGER trims (chunky quoins, fat frames, solid rail), strong contact AO.

**Changed** (residential.js only; props.js/lighting.js edits tried and fully reverted, see below):
1. New kit, measured off ref04's own voxel grid (it maps ~1:1 onto the res-12 small-house body):
   - `refQuoins`: a continuous core post (arm 4, 1 proud) with big square blocks (arm 7, 2 proud, 4 tall) every 7 rows, hung from the top. Each block stands alone over a dark recessed neck, like ref04's stones (was bigQuoins' flat long/short stagger). `ref04Block(..., { refQ: {...} })` uses it, plus ONE bold cornice band (3 tall, 2 proud) in place of the 2-step band.
   - `fatWin`: 1-wide lip 1 proud, 2-wide frame 2 proud, a reveal, glass behind the wall, and one bold 2-tall sash bar. No mullion grid. Outer size w+6 × h+6.
   - `refDeck`: deck inset so the cornice's orange top frames it, big stepped post caps on the quoin columns, and a solid 2×2 rail post to post with open air under it.
2. **Small house** body is x20..75 × z22..69 (56×48), walls 48 tall.
   - ONE row of big windows (glass 7×18, outer 13×24) per face.
   - Front and back: one window plus the double door (10×28) with lamps.
   - Sides: two windows side by side, as on ref04's window face.
   - The stair house has its own smaller refQuoins, a wall-tone roof and a rail (ref04). The AC and door moved clear of the quoins.
   - Lot beds, topiaries and the patio were re-fitted to the new footprint.
3. **Coherence #7:** `_growLot` is still in engine.js, so no action was needed.

**Rock (for the coordinator / veg owner):** the grey cluster is a props scatter rock at (314.5, 307.6), diagonal to the building tile (40,39).
- I tried a guard that skips rocks on tiles next to a built tile. The rock vanished, but a ghost footprint stayed on the grass.
- lighting's world-AO height volume kept the stale rock: forcing `_lighting._aoState.S = 0` cleared it, and `_aoSignature` did not change.
- The instance buffer still held that rock (count unchanged), so the main pass and the AO pass disagreed.
- I reverted both files. Fixing this needs the veg + lighting owners together.

**Measured.** All modules parse, and all four shots had 0 console errors.
- Tris: one-small-house 340k (was 319k), gal-homes-1 486k, gal-homes-2 703k, one-apartment 428k.
- FPS: one-small-house 61. The gallery and apartment readings were 13-36 under load from other Chromes, which is noise.
- Shots are in `rounds/res/w4r3-builder`, iterations in `w4r3-a..g`, and the ref04 side-by-side in `w4r3-g/pair.png`. The start file is `rounds/res/w4r3-start.js`.
- The `--pre` BUILDERS override does NOT change the variant in the game (the catalog holds its own reference), so the v0/v2/v3 roofs were checked in node only (they build fine).

**Next.**
1. If a critic wants more quoin courses, try per 6 / bh 4. ref04 has ~9-10 courses per corner; we have 7.
2. Bring `fatWin` / `refQuoins` to the big house and duplex if they get compared against ref04.
3. The faint vertical light banding on plain walls is mesher/lighting quad seams, not geometry.

### Coordinator note (2026-09-26 19:35) — after w4r3: midpoints on spacing and windows
Critics have swung on both axes: r5 (wave 1) called spaced rows "sparse, toy-like" → I packed homes back to back; w4r3 now says "crammed shoulder to shoulder, roofs overlap and merge into one mass". On windows: w4r2 "fussy thin windows, fewer bigger ones" → w4r3 "large flat stucco faces with sparse windows". Reference check: ref05 has almost no ordinary houses; the real residential refs are ref04 (single house) and ref01 (houses each on its own lot with a visible gap/rim). Midpoints:
- Spacing: every house keeps its OWN visible lot rim with a small yard/gap (a fence, hedge or path strip) between neighbours; eaves and roofs stay inside their own lot so silhouettes never merge. Rows still front the street densely — no big empty gaps. (tools/demo-city.js homes block layout is yours to adjust if needed, e.g. back gardens deeper.)
- Windows: a steady rhythm of MEDIUM windows (about 2-3 per wall per storey on a small house, more on apartments), each with a chunky frame/sill — neither thin-and-fussy nor sparse. Add awnings/balconies/rooftop gardens as accents on some ids.

## 2026-09-26 — wave 4, round 4 (builder)

**Critic (w4r3):** the reference won. The biggest gap was that gal-homes-1's six homes sat "shoulder to shoulder on one shared plinth", with roofs merging and no house reading as its own lot. The critic also wanted more window rows and trim, and said the lone small house was a "plain square block".
**Consensus w4r1-w4r3:** all three critics said the gal-homes-1 houses crowd and merge. w4r2 wanted fewer, bigger windows; w4r3 wanted more window rows. The midpoint is the same fat windows, one row per storey.

**Changed** (residential.js only; no palette or engine change):
1. **Each home stands on its own plinth.** A new `grooveLot(raw)` runs from `grid().done()` when `g.groove` is set. Both `lot()` and `smallHouse` set it.
   - It cuts GI = 2 voxels off the plinth on the sides and back, plus any low clutter in that strip. The front stays flush with the kerb.
   - It redraws the dark `lotSide` band and a 2-wide `lotRim` on the new edges.
   - Neighbouring homes now show a grass channel with two side bands between them.
   - Plinth cover stays at 92-94%, so `engine._lotInfo`'s 90% test still passes. GI = 3 at res 10 would fail it (89%).
2. **Small house has two storeys of fat windows.**
   - The body is 4 voxels taller (top G+52).
   - Ground-floor glass is 7×13 and upper glass 7×12, all in `fatWin`.
   - A 2-tall string course in the frame tone, with a quoin-tone line under it, runs between the quoin columns.
   - Front and back: window + double door (10×21) with lamps downstairs, and two windows upstairs. The front upstairs windows have flower boxes.
   - Sides: 2×2 windows.
   - The gable, hip and deck variants all still fit.
3. **Coherence #7 (the grow stretches the lot):** verified again in-game with every gallery building at scale 0.35 (`rounds/res/w4r4-grow`). The lots stay flat at full height and the houses squash above them. `_growLot` in engine.js works, so no change was needed.

**Measured.** All modules parse. 0 console errors on all four shots plus the grow shot.
- Tris: gal-homes-1 435k, gal-homes-2 640k, one-small-house 300k, one-apartment 377k.
- FPS readings of 9-49 were under load from other Chromes, so they are noise.
- Shots are in `rounds/res/w4r4-builder`, iterations in `w4r4-a` and `w4r4-b`. The start file is `rounds/res/w4r4-start.js`.

**Seen, not mine:** a white stepped box appears near the duplex lot corner in some gal-homes-1 runs, and one sits on open grass in gal-homes-2. It is transient, so it probably comes from life or props. The grey scatter rock behind the one-small-house lot is still there (ground/veg).

**Next.**
1. If critics still see one mass, the remaining lever is the gallery layout (a 1-voxel street or path between homes), which the harness owns. Alternatively, lower the engine lot-cover threshold to 0.85 so GI can be 3.
2. Big house, duplex and cottage could get the small house's storey course + fat windows if they are compared against ref04.

### Coordinator note (2026-09-26 21:30) — gallery done as you asked
tools/demo-city.js now puts a 1-tile garden plot (flower bed / hedge, alternating) between neighbouring houses on gal-homes-* pages (rows still back to back). With your grooved plinths each house now reads as its own lot. Focus on the facades and oversized lot-tree canopies hiding them (w4r4).
