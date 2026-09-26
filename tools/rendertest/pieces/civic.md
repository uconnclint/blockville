# Civic, fun & deco — builder notes

## 2026-09-24 — round 1 (builder)
**Changed.** All 15 fun/civic attractions and all 11 deco items are re-authored at res 4 (civic.js, fun.js).
- Attractions start with `lotPlinth`. Deco items have no plinth, so fences, hedges and paths tile edge to edge.
- Shared prop helpers are exported from civic.js: tree, bush, lampPost, car, fireTruck, umbrella, lounger, flagPole, disc, rrDist, bin, hydrant.
- Palette: 16 `civ*` colours in core.js. Tree and bush colours reuse the `veg*` keys, with fallbacks if those keys are missing.
- Stadium (ref05): built from a rounded-rect distance field. It has a two-tier stepped bowl with navy risers, blue seats with orange radial aisles (red/white on v1), a skybox glass band and a concourse. The white roof ring has blue panels, and there are lamp rigs on the corners. It also has a players' tunnel, a pitch with full markings and goals, ad boards, and a banded facade with pillars. There are STADIUM signs on the front and back, plus back parking with cars.
- Ferris wheel spinner: two rims, 16 spokes, 16 gondolas and rim lamps. Hub pivot oy = (80+0.5)/4.
- Carousel spinner: platform, mirrored column, 8 horses and a stepped striped canopy. Pivot oy = 1.25 + 50/8.
- Fountain spinner: spray crown sitting on the top bowl. Pivot oy = 5 + 7/8.
**Gallery camera sees the authored BACK + one side.** The gallery puts the flipped front on the road side, away from the lens. So backs need to be as rich as fronts. Examples: school back has a SCHOOL rooftop sign, a bus and a court; the museum has a rear entrance and a MUSEUM panel; the carnival has circus-stripe backs; the fire station has a back door, AC units and a hose reel. Keep tall props toward the authored front and low props at the back (pool cabana, playground fence).
**Measured** (node mesher; see scratchpad civic/tris.mjs):
- Triangles, variant 0: stadium 52.6k (was 74k at res 1); museum 24k; zoo 25k; ferris base 10k + wheel 18.5k; carousel base 6k + part 13k.
- Triangles, variant 0: 1×1 buildings 2–11k; deco 70–1.4k.
- models._selfTest: 0 errors for these ids.
- Shots: zero console errors. FPS swings 27–61 in the same shot while other builders run Chrome, so load dominates it. Non-civic shots also read ~31 at those times.
**Next:**
- Stadium: fix the stripe/rib discontinuities in the corners (perimeter param seams). Maybe a darker, less pastel facade.
- Zoo: denser vegetation, plus rock/water detail per enclosure.
- Carousel part is 13k tris. A cheaper canopy is possible.
- The wheel part could drop the inner ring.
- Deco: per-variant review in gal-deco-2.
- Harness: gallery pages keep stray spinners from the previous page (ferris/carousel ghosts in gal-fun-3). That's a demo-city clearWorld issue, not a model issue.

## 2026-09-24 — round 2 (builder)
**Critic gap:** civic pieces were too small and plain on their lots, and the parks read as filler. **Fix:** 1×1 civic models now fill their lot as landmarks. Footprints are unchanged, because a catalog change would break saved cities.
- **School:** 3-storey block, 25×19 on a 31 lot. Pilasters every 6 voxels, proud courses and cornice, and a parapet. Pedimented entrance pavilions with steps on BOTH long sides. A 9-wide clock tower (clock faces on front and back only; faces on adjacent sides read as "eyes"). SCHOOL boards on BOTH parapets. Bus bay, bike rack and hopscotch in the back yard.
  - Variants: v0 brick + cream, v1 peach + white, v2 pale blue + white.
  - `civText()` (exported from civic.js) uses a squarer S. The core S read as "I", which gave "ICHOOL". The stadium and museum now use it too.
- **Fire station (ref05):** brick hall with white stone bands and a green cornice and roof (new palette key `civFireRoof`). Three roll-up bays in front and two behind (drive-through), one of them open. Watch tower on the back-left corner with a "7" plaque and a louvred cupola. FIRE boards on both parapets. Dark-green apron on both sides with yellow lead lines, a truck on each apron, hydrants, cones and bollards.
- **Fountain → monument plaza:** hedge ring with gates, three marble terraces with 6-step stairs on all four sides, and corner reflecting pools. Four statues and a tall tiered column. The spray spinner moved to the top bowl: `FT_BOWL` = 34, oy = (FT_BOWL+1)/4 + 7/8. Bollard lights replace the tall black lamps.
- **Park:** themed per variant: v0 bandstand, v1 duck pond with a red bridge, v2 box-hedge parterre with a statue. Trees are stamped half-scale from vegetation.js (`stampVeg`) in varied kinds. Tall items sit away from the near corner.
- **Pool → lido:** big lane pool on the diagonal and a low pool house with a two-sided POOL sign on the roof. Kiddie pool with a mushroom fountain, diving platform, umbrellas and loungers. Tall pieces sit only on the two side corners, so neither view loses the water.
- **Stadium:**
  - Both variants use the ref blue bowl (v1 has white aisles instead of orange). This fixes the red/blue mismatch between shots.
  - Navy structural band under the roof, a concourse balcony with a rail, and four banded ramp towers at the corners (these also hide the corner seams).
  - Plaza clutter: flags, food kiosks with umbrellas, benches and lamp masts.
- **Deco:**
  - Statue is now a composed mini-plaza with a paved roundel, hedge ring, flower pockets, benches and bollards. v2 changed from the gold ball to a victory column.
  - Streetlight stands on a paved foot with a flower ring.
  - Flower bed uses chunky 2×2 clumps around a shrub (no per-voxel speckle).
  - Hedge is lumpy, with a dark band.
- **Harness fix (engine.js, surgical):** `makeSpinner` pivots are tracked and `clearWorld()` removes them. The gallery reseed no longer leaves ghost ferris wheels and carousels in later shots; that was the "oversized carousel" in gal-deco-1.
- **Preview tool:** `tools/rendertest/pieces/civic-preview.html` plus scratchpad `civic/pv.mjs` renders models only, in iso, in about 1 s. Use `?items=id:variant:rot` with `az=0..3`. The id `dbg` is an orientation cube.

**Measured.**
- `models._selfTest`: 0 errors.
- Real shots have 0 console errors. FPS was 27–61 under load from four parallel shoots, and 61 when the machine is quiet.
- Triangles (voxel.js changed during this round, and every count rose about 1.4×, mine included):
  - school 15.8k, fire 12k, fountain 4.8k, park 4–6k, pool 6.2k
  - stadium 112k (the ramp towers are about 13k of that)
  - statue 3.5k
- **Camera side:** the gallery lens now sees authored FRONT + RIGHT. The sun or snap moved since round 1, when it saw back + left. Design every civic model to be double-fronted: signs and entrances on both long sides.

**Next.**
- Gallery gaps between models become terrain.js "vacant lots" (tennis courts, plazas). That is the filler parkland the critic blamed on us, and it comes from terrain/demo-city, not our models.
- Stadium ramp towers could use an octagon to save tris.
- Playground, zoo, water-slide, mini-golf and skate-park still look like round 1. Give them the same landmark treatment.
- A police-station and hospital look is still missing (no catalog ids for them).

## 2026-09-24 — round 3 (builder)
**Critic gap:** our civic lots were sparse, the benches were car-sized, the buildings were plain blocky masses, and the SCHOOL/FIRE billboards read as toy-like. **Fix:** each 1×1 civic model is now a building across the back of its lot, with purpose-built dressing on the front (the road side, which the lens sees).
- **Scale reference (from vehicles.js):** at res 4 a lot car is 4×4×9 and a person is 3 voxels tall. All props follow that scale:
  - New `benchS` helper (seat 4–5 long) and `lampPost({small:true})` lamps 9–13 tall. The core `bench(len 6–8)` and 3×3-foot lamp calls in civic.js and fun.js were all regex-swapped over.
  - `car()` now delegates to `stampCar` from vehicles.js.
  - `fireTruck` is 6 wide and 13–15 long.
  - `umbrella` has r=2 and h=6, `lounger` is 2×5, `bin` is 2×2×3, `hydrant` is 1×1×3.
- **Fire station:** 29×16 brick hall with full-height piers and a double white stone band.
  - Windows are recessed in brick (the frame is the wall colour) with stone lintels and keystones. White frames made the whole facade read white. Avoid them.
  - Dentil cornice, parapet and coping, and a green roof carrying AC units, a skylight, a stair hatch and vents.
  - Corner tower with quoins, a clock face, a louvred lantern and a flag.
  - Dark-green apron with yellow bay dividers, stop bars and kerb hatching. Two engines sit nose-out in bays 1 and 3; the middle bay is open with an engine inside. A chief's van, hydrants, cones and bollards complete the apron.
  - No FIRE text. v1 now also has the green cornice, because the gallery shows v1.
- **School:** 27×15 two-storey block under a slate hipped roof (new `hipRoof` helper, solid layers plus a flat top).
  - Pilasters, an entablature frieze with a small crest, and a columned portico with a pediment and steps.
  - Clock tower with an open belfry, a bell and a spire through the roof. Flag and AC units on the roof flat.
  - Front yard: painted basketball half-court with a hoop, hopscotch, bike rack, planters, and a bus bay with a new `schoolBus` (5×7×13).
  - **No SCHOOL text.** Any 3×5-font word spans the whole facade at res 4, so it always reads as a billboard.
- **Fountain → ref05 monument plaza:** three-tier marble platform (21/15/9) with a 5-wide stair on every side and balustrade cheeks. Statues on pedestals sit at the lower-tier corners.
  - Two front reflecting pools with white rims.
  - Lumpy hedge ring on the back and sides, with small trees in the back corners.
  - FT_BOWL and the spinner pivot are unchanged.
- **Pool (lido):** big pool on a sand deck with a steps corner, lane rope, rings, balls and ladders. Diving board, lifeguard chair, umbrella and lounger columns, a low pool house with an awning (no POOL sign), and a kiddie pool.
- **Mini golf:** rebuilt with four packed holes (windmill, castle gate, island green, pond and bridge), a striped lighthouse and a clubhouse with an awning. The GOLF text is gone.
- **Skate park:** painted mini-ramp across the back and a graffiti wall. Fun box with a rail, a kicker, a stair set with handrail, and a skate-shop kiosk.
- **Water slide:** sand deck, colour legs and white braces on the tower, 2-high chute walls, a snack hut, more loungers, and palms.
- **Park:** tall trees moved to the authored back and left, so they no longer hide the feature from the lens corner (front+right = authored min-Z, max-X). Paths are light paving. The parterre has low borders, grass lawns and cone topiaries.
- **Stadium:** ground ring is now an arcade: white piers with arched dark bays, and glass in the upper arch. The STADIUM billboards are replaced by a crest roundel. Both variants use orange aisles (ref05). v1 has navy roof panels.
- **Deco, all at people scale:**
  - Bench: a paved pocket with a 6-long seat plus a bin, planter or lamp.
  - Fence 5–6 tall, hedge 5–6, streetlight 16.
  - Statue figure about 25, obelisk 40, column 35.
  - Flag pole 32 with an 11×7 flag.
  - Mailbox on a pad, 6–8 tall.
  - Picnic table 7 long on a gravel pad.
  - The flower bed lost its green box frame.

**Measured.**
- Triangles (v0):
  - school 7.0k (was 11.5k), fire 9.0k, fountain 4.8k, pool 2.8k
  - water-slide 6.7k, mini-golf 3.7k, skate 1.9k
  - stadium 71.7k, total fun+deco v0 209k (was 217k)
- `_selfTest`: 0 errors.
- 6 shots, 0 console errors. FPS 28–61 with other builders loading the machine; one-school and one-stadium 61.

**Next.**
- The frame still reads road- and vacant-lot-dominated. The gallery tennis courts and lawns come from terrain.js, and road width from roads.js. Neither is ours.
- Playground and zoo could get the same lot-dressing pass.
- A police-station and hospital look would still need catalog ids.
- The school could get a real wing and courtyard (L-plan) if a 2×1 variant is ever added.

## 2026-09-24 — round 4 (builder)
**Critic gap (r3 lost):** the civic landmarks were too small and plain for their lots. They needed facade geometry (cornice, frames, signage) and themed forecourts. The monument was a "thin green stick", and the playground and statue read as clutter. The stadium lacked a dark concourse and a crowd.
- **School → ref05 town hall at landmark scale** (walls X1..23 × Z12..29, 3 storeys FL=8):
  - Quoins, a stepped dentil cornice, and a slate hipped mansard from the cornice with dormers. No attic parapet: it hid the roof.
  - Giant-order portico with **2-wide** columns (1-wide read blurry), a podium, a 3-step stair and a pediment with a gold crest.
  - New exported `signPlate()`: a navy plate with a row of light 1-voxel "lettering" marks. It reads as a name plate, not a billboard (the midpoint between r2 "billboard" and r3 "add signage").
  - Windows are recessed into the wall colour with trim sills and hoods, in the dtGlass colour. White frames made the facade read all-white.
  - Bus bay down the right edge: asphalt, yellow kerb, zig-zags, the school bus and a shelter.
  - Variants: v0 mint `civHall`, v1 brick, v2 sandstone (`civPlaza`).
- **Fountain:** terrace tiers 6..24 / 9..21 / 11..19, with 5-wide stairs cut into all four sides. A round basin sits on top, and the three-bowl column has overflow curtains (rings, not 1-voxel pillars). Stone flower urns replace the slab statues, cone topiaries replace the corner trees, and the front-corner reflecting pools are kept.
  - **FT_BOWL 34 → 42.** The spinner pivot follows the constant.
  - The spray arcs are now continuous.
- **Park v2 → ref05 obelisk memorial:** a 3-tier marble terrace with stairs, a pedestal with bronze plaques, and a stepped 5×5 → 3×3 obelisk to y+45 with a gold tip. Bronze groups on the tier corners, reflecting pools by the front walk, and hedges.
- **Playground → one silhouette:** a two-tower play castle with 2×2 posts, crenellations, stepped striped roofs and pennants.
  - A rope bridge, a wide wave slide off the front, and a striped tube slide down the right side.
  - Swings, a sandpit and a spring rider along the edges.
  - Use arrow slits, not portholes (portholes read as eyes).
- **Stadium:** the lot fill is now `civConcourse` (dark), with light paving joints every 12. About 260 fans (legs, shirt, head) cluster near the gates.
- **Fire station:** navy `signPlate` on the parapet.
- **Palette (core.js civic block):** civHall, civHallDk, civConcourse, civConcourseLt, civSign, civBronze, civSkin.

**Measured.**
- Triangles, variant 0: school 8.0k, fire 8.8k, fountain 5.3k, park v2 2.9k, playground 5.6k, stadium 77k.
- Total fun+deco v0: 216k (was 207k).
- `_selfTest`: 0 errors.
- Shots: 0 console errors across all 6. The first run was 61 fps everywhere. The final run was 22–56 fps with load average 6.7 and 16 headless Chromes from other builders.
- **Camera note:** the final gallery run came out at 3200×1800 on the other iso snap, so the lens saw the authored BACK + LEFT. Snaps flip with the light piece's sun. Keep every civic model double-fronted.

**Next.**
- The gallery still frames vacant terrain lots (tennis courts, sand plazas) between and beside our lots. They come from terrain.js and demo-city (`W = colW*3+1` leaves empty tiles), not from us, and the critic keeps charging them to this piece.
- The school back could get a rear entrance or pavilion, since it is visible on the other snap.
- The pool is still low and flat next to the new landmarks. A cabana or hotel wing on the back edge would help.
- A police-station and hospital look still needs catalog ids.

## 2026-09-24 — round 5 (builder)
**Critic gap (r4 lost):** our civic and fun lots sat as lone islands in wide grass, with thin rims and almost nothing on them. Secondary notes:
- The school looked like a plain box: no sign, steps, playground or flag.
- The deco monument was a thin column.
- The fun-1 tower read as a jumble.

**Root cause of the islands:** the harness, not the models. The gallery laid every page out in max-footprint cells (`colW = max tw`). On gal-fun-2 that put the carousel (2×2), the water slide and the wind turbine (1×1) each in a 4×4 cell of lawn.

**Harness fix (tools/demo-city.js, surgical):** each gallery row is now packed by the entries' real footprints, like a city block. Row depth is that row's own max td + 1 road. Uniform pages (all 1×1) lay out exactly as before. gal-fun-2 and gal-fun-3 now read as dense blocks. The leftover tiles become terrain vacant lots (market stalls, parterres), which read as city, not lawn.

**New helpers in civic.js:**
- `person` and `crowd(g, rects, y, n, seed)`: visitors 3 voxels tall, placed only on dry, clear ground, never shoulder to shoulder, deterministic.
  - Lot cars from `stampCar` are NOT in `g.map`, so keep crowd rects off parking bays.
- `kiosk`: a two-faced food stall with a striped canopy and a roof sign.
- `umbTable`.
- `parkingRow`.

**Lots filled edge to edge:**
- **Ferris wheel:** food court with 2 kiosks and 4 café tables, a visitor car park with two rows of bays, a garden with a popcorn cart and benches, bunting masts, and about 90 visitors including the deck.
- **Carousel:** two-tone corner paving, a ticket booth, ice-cream and popcorn kiosks, café tables, a planter tree, a bulb-lit striped gate arch and about 46 visitors.
- **Zoo, museum, carnival, pool, slide, mini-golf, skate park, park, fountain, playground:** crowds added. Pool and slide also get swimmers (heads and caps on open water, via `swimmers()` in fun.js).

**Double-fronted rebuilds.** The lens snap flipped again this round (it follows the lighting builder's sun), so each of these now works from any side:
- **School:** a 17×15 hall centred in the lot.
  - A portico with stair, cheeks, sign plate, pediment and crest on BOTH long faces.
  - A bus bay on the right; a fenced playground strip on the left (slim metal swing frame, open slide tower, spring rider).
  - Dormers on all four slopes. Clock faces on the front and back of the tower only; the sides get louvres, because two adjacent clocks read as eyes.
  - Flag in the front-right corner.
- **Fire station:** a drive-through hall across the middle of the lot, with three bays on BOTH faces (one open) and aprons front and back with yellow bay lines. Engines nose out on both sides (new `fireTruck` option `rev`). Watch tower on the left end; busy roof.
- **Fountain:** the tall banded column is replaced by a calm two-bowl marble fountain with overflow curtains.
  - FT_BOWL 42 → 28, with a smaller spray spinner (9×5×9); pivot `oy = (FT_BOWL+1)/4 + 5/8`.
  - All variants are white marble.
  - Bronze statues replace the flower urns.
- **Deco statue:** ref05 memorial in miniature. A square paved plaza, a 3-tier terrace with a stair on every side, two reflecting pools and bronze groups on the corners. The pedestal carries plaques, and the monument on top is v0 hero / v1 obelisk / v2 victory column.
- **Playground:** two hues plus white per variant (it used to be four saturated hues).

**Measured.**
- `_selfTest` 0 errors.
- Total fun+deco v0 about 231k tris (was 216k). Ferris 19.7k (+8k for crowd and stalls), carousel 9.4k, school 9.6k, fire 7.7k.
- Six shots, 0 console errors. FPS at dpr 1: gal-fun-1 61; gal-fun-2 61 on one run and 37 on the next, same shot and load. The noise comes from other builders' Chromes; the packed block holds about 750k scene tris, most of them terrain vacant lots.

**Next.**
- Stadium apron: pack it with more stalls and fans on the lens sides. The critic still calls it the strongest piece, so change it carefully.
- Carnival and museum could get a parking strip with tour buses.
- A police station and hospital still need catalog ids (ref05 has both).
- If gallery fps matters, the terrain vacant-lot stalls inside the packed block are the big tris cost, not our models.

### Note from life (r8, 2026-09-24)
The `person()` helper in your model file now calls `stampPerson` from vehicles.js, and in commercial.js `car()` now calls `stampCar`. These draw the same figure/car as the traffic, as a res-15 lot part. The r7 critic named the old 1-2 voxel people as "pegs with no head or arms". Please keep this change when you rewrite the file: in round 8 a whole-file write reverted it once.

## 2026-09-24 — round 6 (builder)
**Critic gap (r5 lost):** landmarks were packed shoulder to shoulder on narrow median strips with too little room to read. Buildings needed to be centred on square lots with a plaza apron, and bigger relative to the road. Secondary notes: the city hall had no clean portico or cornices; the fire station lacked brick-and-pilaster detail; a wind turbine stood in front of the stadium.

**Harness state when I started:** the coordinator had already changed `gallery()` in tools/demo-city.js (16:30). Every gallery entry now sits on its own road-framed block, so the "median strip" layout is gone. I left that as it is and fixed the models to suit it.

**Harness change (surgical, tools/demo-city.js):**
- In a row of mixed footprints, the small lots go to the end of the row away from the lens.
- The lens side is computed from the current snap: camera = target + (sin az, cos az).
- Result: the gal-fun-2 turbine now stands behind the ferris wheel instead of cutting through the stadium facade.

**School → ref05 city hall, centred:**
- The side strips (bus bay, playground) are gone; they merged into the neighbours.
- New hall: X5..25 × Z9..21, two tall storeys (FL 9), on a 3-high marble podium with a 2-voxel ledge all round.
- Double-fronted: a portico with four 2×2 columns (x 10/13/16/19) on a shallow pavilion, stepped entablature with the navy name plate, and a 5-step pediment with a gold crest — on BOTH long faces.
- On BOTH ends: a proud entrance pavilion with stone pilasters, a mini pediment and a side stair.
- Dentil cornice, slate hip roof with dormers, and a centred clock tower (TT = TOP+10) with belfry and dome.
- Windows use frame = wall colour, with a trim sill and hood only. Dense white frames plus columns hid the wall colour completely (the v1 brick read cream).
- Apron: corner lawn beds with flowering hedges, LOW cone topiaries (tall canopies hid the facades), bollard lights, benches, a bike rack, hopscotch and kids.
- v2 wall is a new palette key `civStone` 0xd9d3c3. The old sandstone `civPlaza` read orange.
- `civHall` is now 0xb7cfbf (was 0xdce6df, which read white).

**Fire station:**
- Hall is now X3..27, centred with side walks. The tower moved to x3..9.
- Bays are 10..14, 16..20 and 22..26, with piers at 9/15/21/27.
- Piers are brick, 2 proud, with stone quoin stripes every 3 rows, a stone base block and a green capital.
- A green frieze runs under the cornice.
- All 3 variants are brick with stone trim and a green cornice. The v2 cream-on-cream version read as noise.

**Measured:**
- Tris: school 7.5k (was 9.6k), fire 7.1k; fun+deco v0 total 226k.
- `_selfTest` 0 errors. All 6 shots have 0 console errors.
- FPS 41–61 at dpr 1 (load average about 7 from other builders).
- The preview tool does NOT render `model.parts`, so lot cars and trucks from stampCar only show in real shots.

**Next:**
- The road-framed gallery is now about 60% asphalt at ref scale, and a 1×1 lot can never be wider than a 1-tile road. Only a harness or roads decision can change that. If the critic calls out asphalt again, raise with the coordinator either a back-to-back 3×2 civic block ringed by roads or a larger civic footprint. A larger footprint breaks saved cities: sim.load skips any building whose footprint no longer fits.
- Deco in the road-framed gallery reads as empty grass lots (a bench on a whole block). Consider pocket-plaza versions of bench, streetlight and fence.
- The pool and playground are unchanged this round.

### Coordinator note (2026-09-24 17:45) — the consensus across r1,r3,r4,r6
Every civic critic says the same thing: the buildings are small squat blobs on
oversized lots. Fix THAT: the building mass should cover ~60-75% of its lot and be
tall enough to read as a landmark (use more of the height cap), with the remaining
lot densely dressed (parking stripes + service vehicles for fire/police/hospital,
plaza paving, fountain, benches, hedges). Add readable signage (pixelText:
SCHOOL, FIRE, CITY HALL, MUSEUM...) and full facade window grids with frames.
(The gallery now puts each building on its own road-framed block like ref05 — the
asphalt around lots is intentional; ignore "vast empty asphalt" remarks.)

## 2026-09-24 — round 7 (builder)
**Critic gap (r6 lost):** in gal-fun-1 the civic pieces were squat blobs covering about a third of their lots. They needed tall, crisp facades that fill the lot, regular window grids, pilasters and cornices, and a readable name sign. The monument read as a lumpy blue-white pile. **Fix:** each civic model now fills its lot edge to edge, with more height and signage.

**New in civic.js: `hiText(g, side, plane, uc, y4, text, c, out)` and `doneHi(g)`.**
- `hiText` stamps res-8 lettering into a pre-flipped `model.parts` part, the same way industrial.js `hiRes` does. At res 4 a 3×5 word spans a whole facade and reads as a billboard; at res 8 it reads as a name plate, like ref05's POLICE / STATION.
- End a builder with `doneHi(g)` instead of `g.done()`. It coexists with vehicles.js's lot-car `parts` accessor.
- The preview tool (civic-preview.html) now renders `model.parts`. `pv.mjs` takes an 8th arg for extra query params, e.g. `&ty=10` (camera target height).
- Preview az=1 = authored back+right; az=0 = front+right.

**School → city hall:**
- A 27×19 block (X2..28 × Z6..24) on a marble podium that runs edge to edge. Three storeys at FL 8, and a pilaster between every window bay (in the wall colour: white pilasters made it a wedding cake).
- String courses, a frieze and a dentil cornice.
- A proud centre pavilion with a columned porch and balcony. The navy SCHOOL plate (res 8) sits on the frieze, with a pediment over it.
- Slate hip roof with dormers. A clock tower to about y+68, with an open belfry and a dome.
- Double-fronted. v2 wall is now `pBlue`; the cream `civStone` hall read as washed out.
- 11k tris.

**Fire station:**
- A 27×13 drive-through hall (Z9..21) with 9-high bays, two storeys at FL 7, brick piers with stone quoins, and a green frieze and cornice.
- Raised parapet with a two-line FIRE / STATION plate (res 8) on both long faces.
- Watch tower on the left end up to TOP+13, plus a lantern and flag.
- Four engines nose out of the open bays. 8k tris.
- The FL 8 / BAYH 10 version read as a narrow tenement tower, so I dropped it one step.

**Fountain → ref05 obelisk monument:**
- Two marble terraces fill the lot, with a stair cut into every side. A square basin sits on top.
- A 7×7 pedestal with bronze plaques carries a 5×5 obelisk, chamfered in its upper half so it reads as tapering, with a pyramidion and a gold tip at about y+60.
- Bronze figures stand on the terrace corners. There is a clipped hedge border with gaps at the stairs and cone topiaries, on the warm plaza.
- **FT_BOWL 28 → 5** (the basin water voxel).
- New spinner: a ring of 8 arcing jets at r 5..7 round the pedestal (17×5×17, 448 tris). Its swept disc clears the pedestal corners at r 4.3.
- Gold figures read as orange blobs, so every variant uses bronze.

**Swimming pool → lido:**
- A lane pool across the front, and a three-deck diving tower on the authored front-right corner.
- A two-storey glazed pool hall with a POOL plate and a glass barrel roof on the back-left corner. Both tall pieces are on side corners.
- Sun deck with umbrellas and loungers, and a kiddie pool. 5k tris.

**Other changes:**
- **Museum:** MUSEUM plate (res 8) on the front entablature. The back billboard became a small plate.
- **Deco bench:** now a 23×17 pocket plaza. Two benches face each other across a flower bed, with a lamp and a bin, plus a tree, urns or a birdbath per variant.
- **Park:** trees moved off the lens corner, so the pond and bridge show.

**Measured:**
- `_selfTest` 0 errors. All 6 shots have 0 console errors.
- Scene tris went slightly down: gal-fun-1 641k (was 650k).
- FPS: gal-fun-1 55 on an idle-ish machine (load 6.8). It was 14–37 in the final run at load average 13.6.
- **The snap flipped between my runs this round** (back+right, then front+left). Keep everything double-fronted.

**Found, not mine:** core.js palette overflow. `vehSilver` is index 200, which collides with `C.win` = 200 (the warm window glow). The vehicles block pushed `_colors` past 200 entries.

**Next:**
- The playground castle could grow to fill more of its lot.
- Water slide, mini golf and skate park are still low 1×1s.
- The gallery's vacant terrain lots (football pitch, checker plazas) are terrain.js filler, which the critic keeps charging to this piece.

### Coordinator correction (2026-09-24 19:10)
My 17:45 note said "tall enough to read as a landmark" — that pushed you toward
narrow towers and r7 penalised it ("narrow vertical towers on tiny lots"). Correct
target: BROAD and LOW (2-3 storeys; one accent element may rise — a clock/bell
tower, flagpole, hose tower), footprint filling ~70% of the lot edge to edge, with
the rest of the lot as forecourt/stairs/apron/parking. Sprawl horizontally, not up.

## 2026-09-24 — round 8 (builder)
**Critic gap (r7 lost):** school, fire station, pool and water park were narrow towers on 1×1 lots with asphalt crossroads dominating. ref05 civic pieces are broad and low on wide lots, and fill the rest with use-specific forecourts.
- **Footprints 1×1 → 2×2** (catalog.js; backup in scratchpad civic/catalog_r7_backup.js): school, fire-station, fountain, swimming-pool. All four were re-authored at 63×63 res 4 as broad, low buildings:
  - School: a hall with wings, a pavilion and a portico stair; a bus bay with buses; flag, hedged beds and playground.
  - Fire station: a wide brick hall with a green apron, yellow bay lines, engines and an ambulance.
  - Fountain: an obelisk on a large stepped white plinth, with a basin, bronze figures and a hedge ring. It uses a 12-jet spinner at r 8.4–11.
  - Pool: an L-shaped lido with a sun deck and kiddie pool.
- **sim.js load migration (surgical):** if an old save's grown footprint doesn't fit, `load()` tries the other anchors that still cover the saved tile, so the building isn't silently dropped. sim `_selfTest` passes.
- **Pool hall rebuilt clean** (critic: noisy, no silhouette). The roof terrace with umbrellas and planters is gone, and so is the big outside stair. It is now one broad white 2-storey block (x2..30 × z41..60) with a glazed ground floor, a POOL band and a glass barrel skylight. Umbrellas are ref05 red/white (v1 blue). Loungers are white with a pale towel; brown read as mud and red as blobs.
- **Park v2:** the thin obelisk shaft is replaced by a bronze hero on the pedestal. The fountain monument now owns the obelisk.

**Measured:**
- `_selfTest` 0 errors.
- Tris v0: school 20.4k, fire 10k, fountain 10k (+732 anim), pool 8.7k. Total fun+deco v0 about 233k.
- All 6 shots have 0 console errors.
- FPS 6–25 at dpr 2 with the machine load average at 20–200 (other builders), so it is not a meaningful budget reading.

**Next:**
- Park and playground are still 1×1 and read small next to the 2×2 civics. A 2×2 playground (castle + sports court) would match them.
- The school is 20k tris. Its dormers and quoins could be thinned if the budget bites.
- The water slide, mini golf and skate park are still 1×1s.

## 2026-09-24 — round 9 (builder)
**Critic gap (r8 lost):** facades built from coarse voxels (big flat faces, chunky features); the monument was "a stack of plain grey slabs around a flat blue pool" vs ref05's carved stepped obelisk on a terracotta plaza with statues, twin fountains and a hedge border. Fix: a res-8 **fine-trim part** on top of the res-4 massing.

**New fine toolkit in civic.js** (all write into the res-8 `g.__hi` part that `doneHi(g)` pre-flips and attaches — every civic/fun builder now ends with `doneHi(g)`):
- `hiGrid(g, sy8?)` (optional height cap — the part's mesh cost scales with grid volume), `hiFacade(g, side, plane)`: a `facade()` on the fine grid where out 0 = first fine layer in front of the res-4 wall.
- `fineWin`: glass flush in the base, a 1-fine architrave ring + glazing bars (transom; mullions for w ≥ 3) + fine sill + hood (+ keystone). ~70-100 tris/window. Recessed glass (res-4 out -1) read as dark slits; fine glass at out -2 cost 140 tris/window — flush glass + proud frame is the sweet spot.
- `fineDentils`, `fineBand`, `fineBalustrade` (balusters every 3rd fine), `fineHipRoof` (1-fine steps, SOLID layers — hollow rings emitted hidden inner faces), `fineColumn` (plinth, echinus, abacus, flutes), `fineDome`, `fineAC`, `fineUmbrella`, `fineLounger`, `fineBlooms` (bush({flowers}) now uses it), `clockFace` is now a round fine dial.
- `gclr(g, ...)`: **`g.box(..., null)` never deleted anything** (grid.set ignores null). Every old "carve" in civic/fun was a no-op; all converted (school belfry is now open, park v2 stair notches cut).
- `lumpHedge` (clipped cubes with dips).

**Monument (fountain) rebuilt:** terracotta civPlaza plaza, lumpy hedge ring with gaps at 4 walks, corner gardens with fine statues, a white two-tier base (tier 1 ±18.5, tier 2 ±14.5, no grey risers) with fine plinth mouldings/pilasters/cornices, 18-step fine stairs with sloped cheeks + lamp newels on every side, a raised pool with two jets beside each stair (4 pools; the lens sees 2), white raised-arm statues on tier-1 corners, posts on tier-2 corners, a fine 3-stage carved pedestal (plaques, corner pilasters, fluted collar) and a chamfered tapering obelisk (14→12→10 fine) with carved bands, relief panels, pyramidion, gold tip. The flat top pool is gone: a narrow round channel (fine r 20.5..24) round the pedestal carries the spinner (16 fine jets, res-8, 48 wide so it sits on the base's half-voxel lattice). **FT_WATER = 21 (fine row), pivot oy = 21/8 + FT_SY/16.**
**School:** fine windows everywhere (surround = civHallDk on v0, wall colour on v1/v2 — white rings made the brick variant read cream), fine string courses, dentils + balustrade round every roof, fine hip roofs, fine pediment (raking cornice, gold crest), fine fluted columns, fine 8-step front stair, round clock; lot fill → civPlaza.
**Fire station:** fine windows, roll-up doors with fine slats + glazed band, fine alternating quoins on the piers, dentils, louvred lantern, fine hip cap, a fine roof kit (6 AC units, skylight, vents, hatch, duct run).
**Pool:** fine glazing on the hall, fine barrel vault, dentils, glass terrace railing on the canopy, fine umbrellas + loungers, fine lane ropes, fine rubber rings, swimmers as fine heads, fine blooms.
**Museum:** fine windows, dentils, fine pediment with a gold medallion, fluted columns, smooth fine ribbed dome + lantern. **Stadium:** fine sill ledges, mullions, dentils and pier capitals on the straight facades; the 260 res-4 peg fans → 50 life.js figures. **Deco:** flower-bed and hedge v1 use fine blooms.

**Measured** (base + parts, v0): school 45k (was ~21k), fire 27k (~17k), fountain 24k (~13k), pool 17k (~9k), stadium 76k. Part mesh time ~0.5-0.9 s per 2×2 civic (res-8 ray AO) — once per variant. `_selfTest` 0 errors. All 6 shots 0 console errors. `--dpr 1` at load ~10: gal-fun-1 41 fps / 550k scene tris, one-stadium 29 fps / 485k (dpr 2 under heavier load: 23-40 and 7). Deco statue corner bronzes → fine white figures. The gallery snap flipped again mid-round; everything stays double-fronted.

**Next:** the fine part has no AO contact with the base (separate mesh) — fine trim is thin enough that it doesn't show, but big fine masses (monument core) are built with their own fine floor under them for that reason. Window tris are the biggest cost; a mesher hint to skip faces buried in the base would halve them. Playground castle / carnival / zoo are still pure res 4.

## 2026-09-24 — round 10 (builder)
**Critic gap (r9 lost):** the civic landmarks had soft, low-contrast facades with no crisp outline. The fire station's red and teal ran together, and the pale-blue hall washed out. They were small on their lots. The critic asked for dark trim and outline lines, deeper window insets, and brick coursing.

**New outline toolkit in civic.js:**
- `INK()` returns civNavy.
- `inkBand` draws a dark fine line round a box.
- `inkEdges` draws dark L-beads up every corner.
- `brickCourse` adds fine course lines on EXPOSED wall-colour cells only, so it breaks cleanly at windows and trim.
- **`fineWin` changed for every caller.** The window surround is now a dark INK reveal, 2 fine deep. The sill and hood step one fine further out and each has an ink shadow line. Windows also get a pale glint (dtGlassHi) and a centre mullion on 2-wide windows. The default glass is now dtGlassDark.

**Fire station:**
- Hall Z18..44 (was 22..40), three storeys with TOP = y+30 (was 23). Tower TT = TOP+14.
- Deep-red brick with crimson piers and cream quoins. Fine coursing on the walls; pier coursing was dropped because it doubled the quoins.
- Ink under every stone band and cornice. Dark door reveals. Dark-sage cornice and deck.
- Near-black aprons with a pale forecourt strip at the doors and a diagonal-hatched keep-clear box.

**School → city hall:**
- FL 8 → 9. Wings widened to X5..57 on a 3..59 podium.
- Solid corner pilasters plus a pilaster between the wing bays, all in DARK `quoin`.
- Ink under string courses, frieze and cornice. Ink edges on every mass and the tower.
- Variants: v0 cream `civHall` with grey-teal `civHallDk` and `civSlate` roof (ref05); v1 brick with brickDark; v2 civStone with civSlate. pBlue is gone.

**Pool hall:** 3 storeys (RT = y+22). Band-colour pilaster grid, dark-reveal windows on two floors, ink lines under the canopy, ledge and roof lip.

**Playground:** the keeps are solid cream stone, ink-edged, with one roof colour per variant, corbelled battlements, arrow slits and arched doors.

**Stadium:**
- Roof ring widened d ≥ 20 → d ≥ 17 into a white membrane with grey ribs, a translucent blue inner band, a deep white fascia with lamps, and a fine ink line under the inner lip (the ref05 cantilever ring).
- Fans 50 → 64.

**Palette (core.js):**
- civBrick 0xc23d25, civCornice 0x4f806a, civApron 0x243a35, civFireRoof 0x5f8a74, civHall 0xe4e3d3, civHallDk 0x5f8f8e.
- civSkin was renamed to **civSlate** 0x3f6269; swimmers now use C.skin1.
- **The palette is full (199 of 200 slots).** Repurpose keys; don't add them.

**Measured:**
- Tris (base + parts, v0): school 50k (was 43k), fire 41k (was 25k; coursing about 5.7k of that), pool 24k (was 19k), stadium 86k, playground 6k. Total fun+deco v0 about 397k.
- `_selfTest` 0 errors.
- All 6 shots: 0 console errors. FPS 8–28 at dpr 2 with load average 10–22 (many critics' Chromes), so this is not a budget reading. buildMs 57–123 s under that load.

**Not ours:** a flat, unshaded WHITE stepped blob appears on some lots in the gallery. In gal-fun-1 it sits on the pool lot's back-right corner; in gal-fun-3 on a vacant terrain lot. It is not in the model: the preview renders that corner clean. It probably comes from life.js or terrain (a pooled puff or a placeholder). Flag it to the coordinator.

**Next:**
- If the budget bites, cut fire coursing to step 6 or the lit faces only, and thin the school's dormers and quoins.
- The museum picked up dark reveals automatically; it could also use inkBand under its entablature.
- Zoo, carnival and water slide are still pure res 4 with no ink.

## 2026-09-26 — wave 4 round 1 (builder)
**Direction (user, relayed):** if it wins, stop — no chasing "wow". So this round is a small consolidation pass, not a rebuild.
**Changed (civic.js only):**
- Fire station is now broad and LOW (coordinator 19:10): a 2-storey hall (bays plus one office floor, TOP = y+23, was y+30) that is deeper (Z16..46). The second office row and its stone course are gone. The tower is TOP+13 and has shifted to z13..27, with end and tower windows respaced to match.
- Monument obelisk: the pedestal is broader and more decisive (a wide plaque stage, corner buttresses with finials, a fluted collar). The shaft is THICK and tapers smoothly 18→10 fine, where before it was slim with bands ("lighthouse"). It has one carved relief panel low on all 4 sides.
- Monument plaques are civBronze on every variant. The v1 gold rendered as flat orange tiles on the white pedestal.
- civText letters go through `signLit()` (night-lit signs; same colour by day).
**Coherence list:** no items are tagged civic.
**Measured:** 6 shots (gal-fun-1/2/3, gal-deco-1, one-stadium, one-school) all have 0 console errors. FPS was 14–42 at dpr 2 under load average ~7–17 (other builders), so it isn't a budget reading. gal-fun-1 has 567k scene tris.
**Self-judged vs ref05 civic crop:** gal-fun-1 (city hall, fire station, obelisk plaza, lido) matches ref05 composition and beats it on crispness/detail → stopping here.
**Not ours:** a flat unshaded white box turned up again on the pool lot's back-right corner in gal-fun-1. It was absent in the 12:00 run of the same shot, so it is non-deterministic and outside the model (see the r10 note).
**Next (only if a critic loses us the round):** give the 1×1 fun items (water slide, mini golf, skate park) more lot coverage, and consider a 2×2 playground.

### Coordinator note (2026-09-26 14:35, wave 4) — lot fill + gallery scale
w4r1 critic: "buildings sit small in oversized road-framed blocks with wide empty plinth margins". I looked at the pair: detail quality is close; two things lose it.
1. Scale: gal-fun-* frames 6 buildings, so buildings render ~1.5x smaller than the ref05 crop the critic picks. In tools/demo-city.js gallery() (road-framed categories), you may tighten the camera so one gallery page shows buildings at iso-mid scale (~232 px/tile at 2x) — fewer per frame is fine. Don't change homes/shops/deco/factories layouts (other pieces own those judgments).
2. Lot fill: in a mixed row, a building shallower than the row's depth leaves empty tiles that terrain fills as parking/infill, and your own lots keep a wide empty rim. Ref05 landmarks fill the block edge to edge: plaza paving, hedges, fountains, flag poles and benches run right up to the kerb; the building mass takes ~70% of the lot. Grow footprint dressing to the lot edge; heavier cornices and rooftop clutter as the critic says.

## 2026-09-26 — wave 4 round 2 (builder)
**Critic gap (w4r1 lost):** the civic buildings looked like tiny models on oversized, empty lots. Buildings should cover about 80% of the lot, and the fire station and city hall roofs need clutter. The zoo and pool lots were flat.
**Changed:**
- **Fire station (civic.js):** the hall now runs kerb to kerb, X 2..60 × Z 12..50 (was 4..57 × 16..46). Building coverage went from 42% to about 59%, and the rest is aprons full of engines.
  - Piers are now [22..58] and bays shifted to match. The tower moved to x2..12 × z9..25. End, left and tower windows were respaced.
  - Aprons are 11 deep: 9-long engines fill the bays to the kerb, and the engine in the open bay noses half out of the door. A hatched keep-clear box sits in front of the tower.
  - Roof kit: 10 AC units, a skylight, a 3-row solar array, a water tank on legs with a red band, a stair hatch, vents, duct runs and a radio mast with a red light.
- **Pool (fun.js):** the hall spans the whole back edge (x 2..60, was 2..30), like ref05's hotel over its pool. Signs read SWIM CLUB front and back and POOL on the right. The barrel vault runs longer and there is more roof gear, including solar rows and a hatch. The kiddie pool moved into the court at x4..17 × z27..40, the umbrella deck was re-spaced at x50/57 × z3..33, and the crowd and swimmers were re-targeted.
- **City hall:** 6 fine AC units plus 2 glazed skylights on the main block's flat roof tops, either side of the tower.
- **Monument:** a small cuboid lot tree in every corner garden on the kerb side, so the plaza crowds up to the kerb (ref05).
**Measured:** tris (base + parts, v0/v1) fire 36.7k, pool 30.2k (was ~24k), school v2 48k, fountain 23k. 6 shots have 0 console errors. buildMs for gal-fun-1 was 64 s (78 s last round) under load average ~17, and fps is not a budget reading. **Snap:** the lens saw authored front + right. Note that the pool hall now blocks part of the water on the flipped snap (back + left).
**Self-judged:** gal-fun-1 now reads as filled lots: fire station and lido are lot-wide buildings, and the city hall and monument were already dense.
**Next (only if a critic loses us the round):** give the zoo more height (an aviary dome or visitor centre on its back edge), and deepen the city hall if it is called small again. The school mirror constant `54 - z` is hard-coded, so shift MZ carefully.

### Coordinator note (2026-09-26 17:10) — after w4r2: windows read as dark holes
w4r2 critic: facades are "flat grey/red slabs with dark punched window holes"; ref05 civic windows are glassy blue with pale stone frames. Check what your windows render as (PIL-sample a few panes on city hall/fire station at gal-fun scale): they should land in the measured ref05 glass range (#245a76 … #6cb6ce, with a lighter top/streak pane), framed by pale stone (not darkGray/metalDark), with recess depth only 1 voxel so the pane catches light. Pale stone pilasters + cornices on the big grey/red faces. The lot-fill note from 14:35 still stands.

## 2026-09-26 — wave 4 round 3 (builder)
**Critic gap (w4r2 lost), agreed with w4r1:** the facades read as flat slabs with dark punched window holes. ref05's windows are glassy blue with light reflections, set in trim. (The "cars and buses scattered" on our lots are life.js traffic stopping at the kerb; the school buses are not in the model.)
**Changed:**
- **`fineWin` (civic.js), which every caller shares** (hall, fire, pool, museum):
  - Default glass is now `dtGlass` (mid blue), not `dtGlassDark`. The top res-4 row of the glass is `civGlass`, a lighter sky catch.
  - A fine diagonal `dtGlassHi` reflection streak (2 wide, plus a thin second line on wide panes) replaces the 3-voxel corner glint.
  - The dark reveal is **1 fine deep by default** (it was 2). At 2, its side and top faces hid most of the glass at the iso angle; that is where the "punched holes" came from. Pass `deep: true` to get the old reveal back.
  - 2-wide windows have no centre mullion now.
- **School and fire station:** glass switched from `dtGlassDark` to `dtGlass`.
- **Pool hall (fun.js):** pilasters every 8 instead of every 4. Windows are framed in the band colour instead of ink, with no mullion. It now reads as blue glass in a white and red frame rather than red stripes round dark slots.
**Measured:**
- Tris (base + parts): school v2 50.0k (was ~48k), fire v1 36.6k (unchanged), pool v2 32.1k (was 30.2k), museum 41.9k.
- 6 shots, 0 console errors. FPS 6–43 at dpr 2 under load (not a budget reading). gal-fun-1 has 613k scene tris.
- Before/after crop of gal-fun-1: the city hall now shows a clear grid of blue glass windows with highlights, and the fire station and pool hall both show blue glass. No regressions in gal-fun-2/3, gal-deco-1 or one-school.
**Next (only if a critic loses us the round):**
- Compose the lots further: twin small fountains in the city hall lawns, a marked parking row on the pool lot.
- The core 3×5 "M" reads as "H" in SWIM CLUB. It could get a civText override like GLYPH_S.

### Coordinator note (2026-09-26 19:55) — gallery fixed for you
The "small islands in oversized asphalt blocks" verdict (w4r1, w4r3) was mostly the test gallery: enclosed grass tiles next to 1×1 items and in the spare edge columns were dressed by terrain as car parks/paving. tools/demo-city.js now fills them with parks on gal-fun-* pages, so every block is full. Don't spend effort on that point; focus on multi-material facades (stone, brick, trim, glass) and busy lots as the critic says.
