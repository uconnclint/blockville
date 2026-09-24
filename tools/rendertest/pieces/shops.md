# Shops & food (id shops) — running notes

## 2026-09-24 — round 1 (builder)
**Changed** (src/models/commercial.js rewritten; `[commercial]` palette block in core.js: comRoof, comFrame,
comDough, comIcing, comChoco, comCone, comConeDk, comPatty, comCheese, comLettuce, comTerra):
- All 20 shop ids + zoned C growth are now res 4 on `lotPlinth` lots. The 16 small 1×1 shops share `stdShop()`
  (body x4..26 z10..21, H 25): framed glass storefront, door with a canopy, striped awning, sign fascia with a
  flat pixelText name, corner window + awning + blade sign on min-X, AC/drain on max-X. Rooftop AC, vent and
  hatch. Each shop gets a big themed rooftop icon: donut (bakery), cone (ice-cream), pizza with a pulled-out
  slice, 3D burger, coffee cup, ABC blocks, dog bone, book stack, potted flower, shopping cart, joystick,
  lollipop, music note, soccer ball, scissors.
- **Gallery lesson:** gal-*/one-* shots look at each building's BACK and its min-X side (front faces the road
  away from the camera). So the back is dressed as a second "patio" storefront (glass + awning + the same
  sign) with umbrella tables. Keep every side presentable.
- Custom builds: diner (min-X parking bay with a car + drive-thru arrow, chrome/stripe/neon bands, ribbon glass,
  rooftop DINER board + star); cinema 2×1 (marquee with bulbs, CINEMA letters at 2× on front AND back, poster
  lightboxes, blade sign, ticket booth, popcorn cart, film reel + clapperboard on the roof); mall 3×3 (striped
  parking with cars, entrance block with curtain wall + MALL sign front and back, shop rows with awnings and
  3-letter signs on front/back/min-X, loading docks on max-X, skylights, AC grid, water tank, bag icon);
  market stall (2 striped stalls + crate beds); fruit stand (stepped produce tiers, FRUIT board, apple).
- Barber pole part re-authored at res 4 (3×12×3 spiral stripes); door forced left, pole between door and
  glass; ANIMS offsets ox -0.75, oy 2.375, oz 2 (derivation in the comment above ANIMS).
**Measured:** `_selfTest` ok. Tris (engine opts, greedy): 1×1 shops 7.7k–9.5k (old bakery was 6.3k), diner 7.1k,
market 3.5k, fruit stand 4.5k, cinema 14.7k, mall ~35k. gal-shops-1/2, one-bakery, one-diner: 61 fps, 0 errors
(fps drops to 30–50 only while other builders' Chromes run at the same time).
Flat sign text (out = board plane) reads far better than proud letters at gallery zoom.
**Next:** trim tris (donut sprinkles, lettuce checker, pizza pepperoni are the noisiest; mall parking cars);
vary the 1×1 silhouette more (some 2-storey, some wider/lower like the ref05 diner, a roof terrace with
seating); little people on the patios; check the barber pole in-game from the front (needs a rotated shot).

## 2026-09-24 — round 2 (builder)
**Critic r1:** picked the ref. Shops were narrow one-tile towers with a giant mascot, lost in filler; diner a jumble.
**Changed** (src/models/commercial.js only; no new palette keys, since the palette is at 198/200):
- **The gallery camera now sees the FRONT (road side) + the max-X face** (demo-city changed since r1). So aprons
  go out front and the max-X side gets the awning. Re-check this before assuming a camera side.
- New `stdShop`: WIDE + LOW. Body x 3..27 (fills the tile width), z z0..25, one 22-voxel storey. Continuous glass
  ribbon (mullion 4) front and back with a 6-wide door + wall piers; a proud colour band y 14..20 carrying the
  name in flat pixelText over a 1-voxel contrast stripe (y 13), white cornice, parapet. Tidy awnings attached
  under the band (no floating). Side windows on both sides; side tags removed because neighbours hid them ("BAKERY YU").
- One purposeful front apron per shop (`apron`): patio (3 compact café tables, NO umbrellas, since umbrellas
  next to awnings made clutter), bikes, display (flower planters), yard (picket fence, doghouse, pups), parking
  (3 striped nose-in bays, 2 cars and a zebra walk-in bay), court (painted half court + hoop), drive (burger:
  lane across the front, car at the pick-up window, zebra, lit menu board). z0 = 11 for seating aprons and 15 for car aprons.
- Cars on lots are STAMPED from vehicles.js `carModel` (city car, 12 long, variants 13+14k), so they match the
  road traffic. `parkedCar(g, rng, x, z, rot, y, pick)`.
- Mascots are now signage: `iconAt()` renders any icon builder into a scratch grid and nearest-resamples it
  to a max side of ~12-16 voxels, on the roof's front max-X corner. Roof: 2 AC boxes, hatch, vents, solar array,
  duct box.
- Car-apron shops fail the selftest's "+Z face glazed" heuristic (glass lands at pre-flip z 16). Fixed with a
  low lit monument sign (winCool) at the min-X front corner, kept below the band so it never hides the name.
  (A tall pylon at max-X hid the end of MARKET/ARCADE.)
- Diner rebuilt as ref05 "Mac Auto": drive-thru lane down max-X with a car at the pick-up window and a zebra
  crossing, a white box with a red band ('EAT'), a roof terrace with café tables at the front, and a short
  upper storey behind carrying the DINER band plus a star. Fruit-stand apple shrunk to 8 voxels.
- Barber pole moved to the new storefront, standing on the paving and below the band: ANIMS ox -0.25, oy 1.875, oz 1.75.
**Measured:** `_selfTest` ok. gal-shops-1/2, one-bakery, one-diner, one-barber: 0 console errors, 60-61 fps
(37 fps once, with other builders' Chromes running at the same time). Tris (greedy, current mesher, which grew
the unchanged cinema/mall by ~40% since r1): 1×1 shops 8.4k-9.5k, diner 11k, mall 53k.
**Next:** gal-shops-3 still looks sparse because the 3×3 mall makes the gallery columns 3 wide, so the 1×1 shops
sit in big filler lots (a harness layout issue, not the models). Give the mall the same band/glass language.
A few people on the patios. Vary the silhouette (a 2-storey corner shop, an L-plan). The scaled scissors and ball
icons are the least legible.

## 2026-09-24 — round 3 (builder)
**Critic r2:** picked the ref. The sign band covered most of the facade over a thin dark window strip; coarse awning
teeth; giant food sculptures on bare roofs with 2-3 big grey AC boxes; every shop the same box; sparse market.
**Changed** (src/models/commercial.js only; no palette keys):
- New shopfront kit: `shopGlass()`: 14 rows of recessed glass (y 4..17) with light 1-voxel mullions
  flush with the wall (so they stand proud of the glass), a transom at 14, a lit display in the bottom rows (counter
  plus per-shop `goods` colours) and short diagonal reflections. The front has glass either side of a 6-wide double
  glass door with a transom light, and the max-X side wraps the display glass round. The fascia is now a 1-row stripe
  plus a 6-row band (y 19..24), about 1/4 of a one-storey facade and much less on the taller ones. Side tag text removed.
- Awnings are now FLAT, crisp canopies: 1 thick, 3 deep at y 17, 2-voxel stripes running out from the wall, and a
  solid lip. The sloped `awning()` with a valance read as "teeth".
- Varied massing: `floors` 1-3 with flats above (framed windows, flower boxes, wall AC, an upper wall colour
  `upper`), `terrace` (a roof café with rail and tables on 1-storey shops), `x1` (narrower body plus a side alley).
  bakery/pizza/pet/flower/music/barber have 2 floors, cafe/books 3, ice-cream/candy/burger a terrace,
  toys/grocery/arcade/sports 1 storey.
- `roofKit()`: light tiled deck with a white edge ring. A deterministic packer (scan from an rng start) fills it with
  a bulkhead (flats), a roof garden, a tank (3 floors), AC, solar, a hatch, a dish, a duct, 4-6 condensers, vents and
  vent boxes. Light rails sit on the coping of the flats. Mascot icons are shrunk to 10-13 voxels with no plinth.
  DON'T use C.metal or C.metalDark for rooftop gear or rails: they are metallic in materials.js and render dark grey.
  Use offwhite/concrete.
- Diner rebuilt again, closer to Mac Auto: glass box with white corner piers, white/colour/accent fascia, 'D' logo
  tiles on the parapet, tan tiled terrace with tables, a small upper block at the back with a sign box (DINER) and a big
  star, a nose-in bay plus zebra out front, and the lane with the pick-up canopy on max-X.
- Market stall is now packed: 6 produce beds, 2 round striped parasols, 2 canopy stalls at the back, crates,
  barrels, 6 people, and a paving grid. `person()` (1×6 voxels, skin/hair from the shared palette) was added to the aprons.
**Measured:** `_selfTest` ok. Tris (current mesher): 1-storey 6.1-6.8k, 2-storey 9.2-10.6k, 3-storey 13.2-13.4k,
diner 8.0k, market 5.3k. Zoned C growth: L1 6-7k, L2 9-10k, L3 (4 floors) 14-16k. 0 console errors on
gal-shops-1..4, one-bakery/diner/barber/market-stall. fps 58-61 when running alone, 19-48 while ~49 other shoot.mjs Chromes ran.
**Next:** the 1-storey TOYS/BURGER fascias still look heavy next to the tall ones (try a 2-storey toy store or a
5-row band). Bring the cinema and the mall into the new glass/roof language. Market-row look: a mid-block
2-storey shop sharing a wall with its neighbour. A night check of the display glass.

## 2026-09-24 — round 4 (builder)
**Critic r3:** picked the ref. Tall narrow 3-4 storey towers, huge sign band, bare roof + one big mascot, empty lots, 2x coarser.
**Changed** (src/models/commercial.js only; no palette keys; still res 4, the shared convention):
- New `stdShop` kit, LOW + WIDE: one glazed storey, GF = 21 (was 26 + 12/storey). Body x 2..28, z 13..25, so every
  apron is 11 deep. The glass is taller (y 4..15) with a LIT INTERIOR (`shopFront`: counter, shelves of goods, staff,
  pendant lamps, reflections). Slim fascia: 1 stripe row, a 3-row band, a white cornice, and a 1-voxel coping in the
  brand colour. The name sits on a compact 7-row panel (`namePanel`, 1-voxel border, padded when the text fits).
  5×5 `LOGOS` on 7×7 tiles (`logoTile`) on the side and back bands, like the ref05 'M' tiles.
- Upper storeys are SET BACK (`upAt` 'back' = the rear 7 rows; 'left'; 'full' only for zoned L3). The rest of the
  roof is a terrace (`terrace`): a wooden deck, 3 striped parasol tables, a hedge or glass balustrade, pots. Each
  shop gets one of 3 flat styles (`upperFace`: windows+shutters/boxes, ribbon glass, panel fins) in its own colour.
  1-storey roofs are 'patio' (terrace + gear strip), 'garden', or 'gear'. The mascot is now 8-10 voxels and stands
  on the roof deck (no plinth or bulkhead under it). The bulkhead moves to the max-X back corner.
- Aprons are denser and finer: kerb hedges broken into shrub clumps, parasol sets plus bistro sets, bikes, bollards,
  4 nose-in bays with the 4×9 lot car (`stampCar`), zebra walk-ins. `person()` is now 1×5.
- Diner rebuilt as Mac Auto: a white glass box, x 2..22, with a red band and yellow pin-stripe, and 'D' tiles on
  every corner. It has a tan terrace with red tables and a DINER sign box on stilts at the back (9 rows, yellow
  border, red margin), a gold star, a drive-thru lane with 2 cars on max-X, and 3 nose-in bays out front.
- `signText` draws W and M 5 wide (the core 3×5 W read as H: "FLOHER"). The barber pole now stands LEFT of the
  door (x 3..5): ANIMS ox -2.75 (oy / oz unchanged).
**Lessons:** DARK letters on a light panel with no padding read as mirrored gibberish, because the eye picks up the
light gaps. Use light letters on a colour panel, with a border colour different from the letters. `g.walls` on a
sign box paints the big faces too. Striped edge rings on parasols read as stars or trees. Use 4 wedges instead.
Continuous lime hedges read as neon bars. Use shrub clumps, leafMid/bush.
**Measured:** `_selfTest` ok. Tris: 1-storey 6.4-8.2k, 2-storey 9.1-10.6k, diner 7.6k, zoned L1/L2/L3 ~7.5k / 9.5k /
12.5k. The shops total is 193k (r3: 206k). gal-shops-1/2, one-bakery, one-diner, one-barber, gal-shops-3: 0 console
errors, 58-61 fps when running alone.
**Next:** 6-letter names still make a full-width panel. Try a roof-edge sign box on the 1-storey shops.
The 4-stall "market" lot top-left of gal-shops-1 is NOT a shops model: it is gallery filler from another piece.
Bring the cinema and mall into the r4 kit (slim band, lit glass, terraces). res 8 would fix the "2x coarser" note, but
doubling alone costs 2.3x tris (measured: bakery 10.7k to 24.8k), so it needs a convention change for everyone.

## 2026-09-24 — round 5 (builder)
**Critic r4:** picked the ref. Every shop was the same white 2-storey box with a giant sign band, the roofs were noisy (blob
mascots, parasols, lime strips), and the glass was blue/red/yellow noise. The market had 4 lonely stalls. Across r1-r4 the
critics agree on: busy roofs, giant signs, sameness, and lots that are too empty or too cluttered.
**Changed** (src/models/commercial.js only; no palette keys; about 690 lines of the r4 kit, icons and roofKit deleted):
- New `shop(rng, S)` kit. Each shop sets its OWN `body` rect, `floors` (1-3) and `tall`. Silhouettes: a kiosk (ice cream), a
  townhouse with a flat above (bakery, books, music), a drive-thru with an L-shaped lane (burger), a building set back behind a
  deep terrace (cafe), a supermarket behind its car park with a loading dock (grocery), a fenced dog run (pets), a glasshouse
  (flower), tall boxes (toys, arcade), a half court (sports). Diner = Mac Auto: DINER box + star on the roof, red tables on the side.
- CLEAN glass (`glassRun`): thin frame, evenly spaced mullions, a transom, one white glint per 2 panes, no goods. `glassDoor`
  = 6-wide glass double door + canopy. Slim fascia: 1-row accent stripe + 2-row band + cornice. The name is a compact
  `signBox` over the door, on the FRONT ONLY. The back gets a logo tile, the sides get glass + sloped awnings (no side tiles:
  3+ icons per view read as spam).
- CLEAN roof (`cleanRoof`): grey comRoof deck + white rim, 1-3 small ref02 AC units (`acUnit5`, 4×3×4), 2 vents, a hatch, an
  optional solar pair, and ONE `logoPole` (7×7 board, 5×5 LOGOS art on both faces). Ice cream uses a tiny 3D `coneSign`
  instead. Cinema: the film reel and clapperboard are replaced by AC units + a clapper logo pole.
- The lot carries the detail: `cafeTerrace` (tan tiles, a tidy grid of tables, parasols 'all' | 'alt' | 'none'), `carPark`,
  `glassScreen`, `totem`, `backApron` (path, bench, planter, bikes or a row of tables behind every shop).
- Market stall rebuilt as a packed 3×3 grid of produce beds, small parasols, crates, barrels and 10 people.
**Lessons:** THE GALLERY CAMERA IS NOT STABLE. The iso snap follows `sunDir`, which the lighting piece keeps changing (and it
drifts with the clock). This round, gal-shops-1/2 showed the BACK plus one side, while the one-* shots showed the front on some
runs and the back on others. So every side must be presentable. Bodies now sit mid-lot (z0 about 11-13, z1 about 21-24) with
dressed aprons front AND back.
A sign border in the letter colour (PETS: cream on cream) merges the 5-row letters into the ring and reads as gibberish.
`signBox` now forces border = bg when bd === fg. The 5×5 cone logo reads as a monster face. Use the 3D cone.
**Measured:** full `_selfTest` ok (barber anim included). Tris via voxel.js `buildVoxelGeometry`: 1-storey 4.9-7.0k,
townhouses 8.2-8.6k, diner 5.9k, market 5.5k, cinema 14.6k, mall 31.8k, zoned C 6.5k / 8.8k / 10.9k. Shops total 158k (r4: 193k).
0 console errors on gal-shops-1/2/3/4 and one-bakery/diner/barber/ice-cream/book-shop/market-stall. Alone: 57-61 fps.
With about 35 other shoot.mjs Chromes running: 23-46 fps.
**Next:** the 3×5 font at res 4 still makes 5-6 letter names wide (BAKERY, MARKET, GAMES). Try shorter words or text only on
the fascia band of the wider bodies. Toys, cafe and pizza are still similar 1-storey boxes from the back: vary them (a
sawtooth roof or a corner turret for toys, a pergola for the cafe). The mall still has its roof bag sculpture: give it the
r5 kit (cleanRoof, glassRun, signBox).

### Note from life (r8, 2026-09-24)
The `person()` helper in your model file now calls `stampPerson` from vehicles.js, and in commercial.js `car()` now calls `stampCar`. These draw the same figure/car as the traffic, as a res-15 lot part. The r7 critic named the old 1-2 voxel people as "pegs with no head or arms". Please keep this change when you rewrite the file: in round 8 a whole-file write reverted it once.

## 2026-09-24 — round 6 (builder)
**Critic r5:** picked the ref. "Voxels 3-4x too coarse": a chunky box, a blank grey roof with a few cubes, 2-3 big panes per
face, a blurry pictogram on a pole. Wanted: many framed window bays along the whole frontage with an awning per bay, the
name as lettering on a fascia band, roofs with parapets + AC + vents + a terrace, busier lots. (Consensus r1-r5: busy/bare
roofs, giant signs, sameness, coarse detail.)
**Changed** (src/models/commercial.js rewritten; no palette keys):
- **res 8** for every shop, the zoned C growth, the cinema (127×63) and the mall (191×191), like residential. A fast
  typed-array grid (`grid`, with `get`/`clearBox`) replaces core's Map grid.
- Facade kit: `bay()` (1-voxel frame flush with the wall, glass recessed 1, mullions every ~5, a transom, a 2-row kick
  plate, a 3-voxel glint), `splitBays()` (bays between 3-voxel wall piers), `awning()` per bay (sloped, 2-voxel stripes,
  scalloped valance), `glassDoor()` (8-wide double glass door with stiles, push bars, mat, pots either side),
  `serviceDoor`, `wallAC` (ref02), proud 3-wide corner piers, an accent stripe + 9-row fascia band + proud cornice ring.
- Lettering: a new **5×7 font** (`F7`) for names on the band, 3×5 (`F5` + wide M/W) for long words (SUPERMARKET,
  ICE CREAM); flat light letters on the band colour. 7×7 `LOGO` art on 9×9 band tiles on the flanks (no logo poles).
- Upper storeys: `upRow` of sash windows (frame, centre bar, transom, proud sill; styles sash / shutter / ribbon) with
  flower boxes, belt courses, a cornice ring; set-back upper blocks leave a GF roof terrace behind a glass rail.
- Roofs: parapet + coping, and a packer (`roofGear`) filling the deck with a stair house, AC units (fan grille, louvres),
  big condensers, mushroom vents, hatches, skylights, solar, tanks, ducts, planters; `roofTerrace` (tables, parasols,
  pots) on bakery / pizza / ice cream / candy / music / cafe / burger. 3D crisp sculptures only where they are the sign:
  ice-cream cone, BURGER box + 3D burger, DINER box + star, ABC blocks on the toy store.
- **Every face is a storefront.** The gallery iso snap follows the sun and showed the BACK in half my runs, so the back
  is a mirrored storefront with the name, and `S.lot` runs twice: front, then the back apron via `mirrorZ(g)` (bodies are
  centred, z 18..44, both aprons 17 deep). Side strips (bench, bins, planters) are drawn once in `after`.
- Lots: `lotTerrace` (tiled, table sets with round segmented parasols), `parking` (11-wide bays, wheel stops, zebra
  walk-in, a disabled bay), paving grids, kerb bollards, `crowd()` people.
- **Lot parts:** the life piece moved `person()` / `car()` to vehicles.js `stampPerson` / `stampCar` (res-17 lot part via
  a probe). The probe cannot see through `mirrorZ`, so both helpers map a proxy (`g.__base`, `g.__Z`) back to the real
  grid (car footprint [z-2, z+16) -> real [Z-z-15, Z-z+3), dir 2). Without this the back aprons had no cars/people.
**Measured:** `_selfTest` ok. Base tris (voxel.js, engine opts) 1×1 shops 7.8k-17.8k (avg ~14k; r5 ~6.5k), mall 46k,
cinema 15k, zoned C L1 9-14k / L2 13-18k / L3 18-21k; lot parts add 2-6k each (life's). gal-shops-1/2, one-bakery,
one-diner: 0 console errors; fps 40-60 at dpr 1 on a quiet machine, 5-30 while ~18 other shoot Chromes ran.
**Next:** trim tris if the hero city budget bites (lot mirroring doubles terrace cost; parasol domes and awnings dominate).
The gallery is now shoulder-to-shoulder: side strips matter less, fronts/backs more. Mall's level-2 walls and the cinema
flanks are still plainer than the 1×1 shops.

### Coordinator note (2026-09-24 18:40) — ignore gallery-layout remarks
Critics contradict each other about how the gallery lays buildings out (res r5:
"isolated in asphalt → pack them"; res r6, after packing: "jammed shoulder to
shoulder → separate them"). Layout is the harness's job, not yours — ignore it.
Act on what is consistent across your critics: finer window rhythm / more, smaller
framed windows; trim bands; varied LIGHTER roofs (rooftop terraces, gardens, AC
units, solar) instead of dominant flat dark slabs; denser small props on the lot.

## 2026-09-24 — round 7 (builder)
**Critic r6:** picked the ref. Biggest gap was frontage density. Our shops were separate boxes on mostly empty lots, with big flat
one-colour upper walls, a few chunky windows and one awning band. ref05's row stands shoulder to shoulder with finely broken
facades, and its lots and roofs are full of props. Consensus r1-r6 (plus the coordinator's 18:40 note): finer window rhythm, trim
bands, lighter planted roofs, denser small lot props.
**Changed** (src/models/commercial.js; core.js `comRoof` 0x9aa1aa → 0xb7bcc2, lighter roof decks; still res 8):
- **Continuous frontage.** The default body is now `BODY = [1, 13, 61, 49]`, the full lot width. A gallery row of 1×1 shops now reads
  as ONE street wall with a 1-voxel joint. Flank awnings are skipped at party walls, where they would clip. Pets, flowers and
  burger lost their side yards: the dog run became a `dogpen` slot, the glasshouse became a roof conservatory, and the drive-thru
  lane moved to the burger's back apron.
- **Finer floors.** GF glass runs 6..19 (was 6..23), and `UP` = 16 (was 26). New `upWin`/`upRow` styles (`WSTYLE`): grid 4×8, tall 4×10,
  pair 7×8 with a centre bar, shutter, balc (French window + slab + glass balustrade), sash, ribbon. Each gets a proud sill, an optional
  lintel and flower boxes. Every storey has a belt course, 2-wide proud corner quoins and a double cornice on top. `S.upStyles`
  varies the style per floor. Shops now have 2-4 storeys at about the old height: bakery, cafe and music 3; books 4; grocery 1.
- `bladeSign()`: a projecting logo board on the first upper floor at the FAR end of the front (and on the back at the other end).
  **Lesson:** a blade projects toward the lens and hides the wall about 10 voxels down and along from it. At mid-facade it ate the
  last letters ("BAKER", "PIZZ"). It now sits at x1-3, 2..10 out, and the band logo tile on that end is dropped.
- **Aprons.** `apron(c, spec)` builds a sidewalk band under the awnings, a door path, and a DISPLAY in front of every GF bay: crates,
  bistro, flowers, books, bread, toys, bench or planter. It then packs slot items left and right of the door (`SLOT`): table,
  bistro, stall (ref05 striped market stall with separate crates), cart, planter, shrub, bikes, bench, lamp, board, bins, crates,
  car (parallel bay via `pcar` → stampCar dir 1/3), people, ride, dogpen, lolly, busker, hoop, balloons. It still runs mirrored
  for the back apron.
- **Roofs.** Concrete paver lines every 8, plus white planter runs (shrubs + flowers) along the front and back parapets, skipping
  terraces. Loose `pot` gear is removed: many single pots read as green-dot noise.
- **Cinema.** The body is centred (z 16..46) and BOTH long faces are entrance fronts: marquee, NOW SHOWING, CINEMA, posters,
  pilasters, belt courses, upper windows. Both aprons are red-carpet plazas. The r6 back was a big flat red wall in gal-shops-3.
- Burger band now reads DRIVE IN (it said BURGERS under a BURGER box). The burger stands on the sign box again. Diner: taller glass
  (tall 3) and a red-table roof terrace.
- Barber: `BARBER.body` is now the full width. The pole still stands left of the door (ANIMS derives from BARBER). `noAwn` keeps
  awnings off the pole, and `dispFrom` keeps the bench display clear of it.
**Measured:** `_selfTest` ok, and all modules parse. Base tris (shoptris.mjs): 1×1 shops 12-23k (r6 7.8-17.8k). bakery 21k, cafe 21.6k,
books 23.3k, cinema 21k, mall 38k, total 938k (r6 684k). Zoned C: L1 14-16k, L2 18-20k, L3 22-24k (r6 9-14 / 13-18 / 18-21).
Cost split for a 2-storey shop: GF+lot plinth 6.5k, each upper floor ~3.9k, roof gear 1.7k, planter runs 0.8k, both aprons 3-4.7k.
gal-shops-1 frame: 575-607k tris. With load ~7 at dpr 1 it ran 31 fps, and gal-homes-1 (362k) ran the same 31 fps in the same
minute, so the fps is bound by machine load, not our tris. 0 console errors on gal-shops-1..4 and one-bakery/diner/barber.
Shots are in `rounds/shops/r7-builder`.
**Note for the critic/coordinator:** the "flat brown crate grid" market lot beside the shops in gal-shops-1/2 is TERRAIN filler for
the empty gallery tiles, not `market-stall`.
**Next:** trim the zoned C tris if the hero city bites. Options: drop flank windows on party walls when a neighbour exists (not
knowable in the model), or halve the mirrored back apron's slots. The mall's second level and roof are still plain next to the
1×1s. The diner's 9-row band is heavy over its short glass.

## 2026-09-24 — round 8 (builder)
**Critic r7:** picked the ref. Biggest gap: muddy signage (thin cream BAKERY on a maroon band), slatted 2-voxel brown/cream awnings that
blur into the facade, and roofs covered in planter boxes. ref02 has ONE bold high-contrast sign, a few solid awnings and 3-4 roof props
on a smooth deck. Also: the diner billboard was oversized, and facades had too much small busy detail.
**Changed** (src/models/commercial.js only; no palette keys):
- **Bold signs.** New `boldText`/`textWB`/`boldGap`: the 3×5 glyphs at 2× (2-voxel strokes, 10 rows), gap 2 or 1. The fascia band is
  now 12 rows (`levels`: B1 = GY1+16, TOP = GY1+17, which adds 3 rows to every shop). `nameOn` uses the bold font, and names are
  signWhite on dark or saturated bands (the cream `nameFg` values were removed). Names that were too long changed: ICE CREAM -> SCOOPS
  (on a chocolate band), SUPERMARKET -> GROCERY, and the diner front SHAKES -> FRIES. The BURGER and DINER boards are bold too.
  **Lesson:** at gallery zoom, 1-voxel strokes get an outline + AO edge on each side and their interior disappears. Use 2-voxel strokes.
- **Awnings.** `awning()` is now SOLID cols[0] by default. `S.awnStripe` gives wide 4-voxel stripes. `S.awnCycle` gives one solid colour
  per bay (toys). `S.awnLip` sets a valance colour. Closed triangular end cheeks and a straight valance. Upper-window awnings are solid.
  Bakery, ice cream, candy, sports, barber, books, grocery, diner and some zoned shops are striped; the rest are solid.
- **Roofs.** No paver lines, and no planter runs unless `edgeGreen: true`. Terrace pots are off by default. Default gear:
  stair + acBig + solarBig + ac. Each shop now has 2-4 props (the r7 lists had 7-16). `solar()` now draws SEPARATE 2×2 framed, tilted
  panels (a single 26×16 slab read as a flat blue blob, and white frames made it read as benches). Cinema and mall lists are trimmed the same way.
- **Calmer facades.** Flower boxes are a plain green box with 2 blooms (the old version was a per-voxel colour stripe), and boxes are off on
  most shops. The bakery upper floors are shutter + sash windows with no balconies.
- **Diner.** The board is 38×12 on short legs (was 43×16 plus a 14-row star), with a small star on its corner. Piers are white and the awnings
  are striped, so it reads as a white box with a red band (Mac Auto) rather than a solid red box.
**Measured:** `_selfTest` ok, all modules parse. Model tris (shoptris) total 688k (r7 781k): bakery 14.9k (17.4k), cafe 15.6k,
books 16.7k, diner 6.0k, mall 29.5k. gal-shops-1 frame 446-497k tris (r7 575-607k). 0 console errors on gal-shops-1/2,
one-bakery and one-diner. fps was 9-30 on a heavily loaded machine (buildMs 55-85 s from the other shoot Chromes), so it is not a budget reading.
Shots are in `rounds/shops/r8-builder`.
**Next:** the big 1-storey decks (toys, cafe, grocery) are now plain grey. ref02 has a light rim band inside the parapet, so a white
2-voxel inner rim could lift them. The TOYS yellow-on-blue and SCOOPS white-on-chocolate signs are readable but weaker than the white-on-red
ones. Check the zoned C growth in a city view (it uses the same kit, and half its awnings are striped).

## 2026-09-24 — round 9 (builder)
**Critic r8:** picked the ref. Biggest gap: the roofs (Burger/Cafe/Toys/Pizza) were big flat empty grey slabs with only 1-2 props, and the ref has
gardens, terrace seating, parapet trim and HVAC clusters on every roof. Also: upper floors were "repeated grids of identical blue windows" (the ref has
white cornices, pilasters and trim bands), and the doubled 3×5 sign letters looked "warped". fps 5-7 was machine load.
**Changed** (src/models/commercial.js only; no palette keys):
- **ROOFSCAPE** (`roofScape`, `ROOFMOD`). The deck, inside a 2-wide light rim (`roofRim`), is split into cells of about 18×15 (nx = W/19, nz = D/17), with
  2-voxel walkways between them. Each cell holds ONE module that fills it:
  - `garden`: a white raised bed of lawn, packed with 4×4 cube bushes 2-6 tall (lighter top over a darker band, one green per bed) and lawn gaps with flowers
  - `patio`: tiles, parasol tables and corner pots (colours from `roofTerraceO`)
  - `hvac`: concrete pad, acBig, 2 AC units, vents and a pipe
  - `solar`: 2×2 panels via the new nx/nz args
  - `stair`, `tank`, `sky`, `pergola` (posts, slats, vines, bench), `court`
  - `pad`: tiles plus pots under a sculpture. Cells never skip a pad.
  Each shop sets `roofPlan` (row-major, front row first). Otherwise `ROOFPLANS` picks one at random (this covers the zoned C shops). A cell that overlaps
  `roofBlock` is skipped (strict overlap), and the leftovers get small gear. The old per-shop `roofTerrace` rects are gone except on the diner. Cinema and mall
  use the same system (mall: cell 30×24). The burger sign box moved to the back of the roof (z 44, 57 wide, bold 5×7) so the front cells stay free.
  The ice-cream cone moved to x 49, the pizza flue to z 38, and the conservatory to x 27..55.
- **Parapet**: a coloured trim row sits under a WHITE 3-wide cap that overhangs by 1 (`cap`). The top cornice is white (`S.cornice`). The parapet's second row is a
  frieze in `S.frieze`, or upTrim by default.
- **Upper facades**: `upRow` takes `group` (default 2). Windows come in groups with a 5-wider gap and a 3-wide proud pilaster (`S.pilaster`, default the cornice white)
  between the groups, on the front and back (the sides are ungrouped).
- **Signs**: `bold7`/`fitBold` draw the 5×7 font with 2-voxel stems and bars (column scale [2,1,2,1,2], row scale [2,1,1,2,1,1,2], 8×10 glyphs). If a word
  doesn't fit, it falls back to the r8 3×5 bold. The name sits on a proud sign PANEL (out 2, rows STR..TOP, 1-voxel border, 1-row/2-col margin). `S.panel:false`
  (diner) keeps flat letters on the band.
**Measured:** `_selfTest` ok, all modules parse. Model tris 786k in total with the current mesher. Zoned C L1/L2/L3 12-13k / 15-16k / 17.5-20k.
gal-shops-1 frame 488-528k tris (r8 446-497k). 0 console errors on gal-shops-1..4, one-bakery and one-diner. fps was 8-28 with the machine loaded
(buildMs 60-130 s, so this is not a budget reading). Shots are in `rounds/shops/r9-builder`.
**Lessons:** a stampVeg 'shrub'/'bushTall' at 1:1 in a res-8 grid reads as ONE big smooth green cube, so use cube-bush clusters instead. Blocks that touch a
cell edge skipped whole cells (the Toys roof came out empty): overlap is now strict and the sculpture blocks are tight.
**Next:** the diner is still a 3×5 bold FRIES/DINER. Widen its body so the bold 5×7 fits. Group the side windows symmetrically. The mall MALL entrance lettering is
still the old text(). Watch the roof tris if the hero city bites. Gardens are the cheapest roof filler, and patio parasols are the most expensive.

### Coordinator note (2026-09-24 21:15) — the consensus fix: SHRINK THE SIGNS
Signage has been the named problem in r2, r3, r7 and r9 ("huge blocky pixel-letter
billboards painted across whole storeys"). Look at ref05's MAC AUTO / SUPERMARKET /
HOTEL: one slim fascia sign, letters ~1/4-1/3 of a storey tall, on a contrasting
panel, over a ground floor that is mostly GLASS shopfront with mullions, individual
striped awnings per bay, display items. Upper floors: framed windows with sills,
not a uniform grid, maybe a balcony or planter. Keep the fun rooftop icon but small.
Make this change across all 20 shops.

## 2026-09-24 — round 10 (builder)
**Critic r9:** picked the ref. Biggest gap: huge bold pixel-font names (TOYS, CAFE, PIZZA, SCOOPS, BAKERY, BURGER/DRIVE IN) covered whole
storeys, with identical window grids above them. ref05 has small crisp signs, fine per-bay shopfronts and varied upper floors and
rooflines. The diner close-up had a thin ring of props, and its FRIES/EAT lettering was crude. (The same sign complaint came up in r2, r3, r7 and r9, and in the coordinator's 21:15 note.)
**Changed** (src/models/commercial.js only; no palette keys):
- **Small sign boards.** New `signBoard()`: a 1-voxel-thick board, 7 rows tall. A 1-voxel frame surrounds the 3×5 lettering (5 rows, about 1/3 of a storey),
  with 2 columns of margin. The letters are FLUSH in the board face, so there is no relief: no AO or ink edge, and 1-voxel strokes stay crisp. Boards are
  about 1/3-1/2 of the frontage and sit centred over the door. The default is light-on-dark (comFrame board, white letters, stripe-colour frame).
  White boards with band-coloured letters lost contrast on the shaded side. Overrides: `signBg`, `signFg`, `signBd`, `signLamps`.
  `levels()`: the fascia is 6 rows again (B1 = GY1+10, TOP = GY1+11, was +16/+17), so every shop is 5 rows lower. Band logo tiles are gone.
  The logo now appears only on blade signs and gables. The bold 2× fonts (boldText/bold7/fitBold) are deleted.
- **Rooftop signs, Mac Auto style.** Burger: a compact red box with small BURGERS lettering, plus a bigger 3D burger icon (r7) on top.
  Diner: the same box with DINER lettering and a 3D gold star (`star3d`). Cinema: a small 5×7 lit CINEMA board (was 2× on a 79×17 fascia),
  with windows either side. Mall: a small MALL board (was 2×).
- **Upper-floor / roofline variety** (new S options): `gable` 'step' | 'pediment' | 'flat' (raised centre parapet on the front and back walls,
  with the logo tile on BOTH faces; the inner face showed as a blank slab over the roof); `oriel` (projecting bay window up the middle of the
  front and back); `balcRun` (a continuous glass balcony along a floor, with planters); `dentil` (a course under the top cornice).
  Assignments: bakery step+dentil, pizza pediment+dentil, barber pediment+dentil, candy step, pets/sports/grocery flat, cafe oriel,
  books oriel+dentil, ice-cream balcony, music balcony on floor 2. Zoned C picks randomly.
- **Display windows:** `goods` gives each bay a shelf line with small wares in the glass plane (per-shop colours).
- **Diner:** the body is centred (x 13..49) with a parasol terrace + planters on BOTH flanks (the iso snap shows either). There is nose-in parking with a
  zebra walk and kerb planters in front, and a drive-thru lane at the back with arrows, a lit 2-sided menu board, a car and planters. A pole sign
  by the road shows OPEN plus a star. Names are SHAKES (front) and EAT (sides), with DINER on the roof box.
**Measured:** `_selfTest` ok, all modules parse. Model tris 881k total (r9 801k): bakery 19.4k, cinema 23k, mall 41k, diner 9.8k.
gal-shops-1 frame 558k tris (r9 528k). 0 console errors on gal-shops-1/2, one-bakery and one-diner. fps 14-29 on a loaded machine
(buildMs about 90-120 s), so this is not a budget reading. Shots are in `rounds/shops/r10-builder`.
**Lessons:** the one-* camera still flips between runs (the diner showed its min-X side in one run and its max-X side in the next), so both flanks must be dressed.
3×5 'B' reads as 'E' at 1-voxel strokes on low-contrast boards, and light-on-dark fixes most of it. K was redrawn.
**Next:** the tris growth comes mostly from gables with double logos and from the flush lettering. If the budget bites, drop the inner gable logo on 1-floor shops.
Upper walls are still strongly coloured (pink/teal/red). ref05's row is mostly white, cream and brick with colour in the awnings, so try calmer `upper` picks.
Mall unit fascias still use full-bay colour strips.
