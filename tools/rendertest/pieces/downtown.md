# Piece: downtown towers (src/models/downtown.js + [downtown] palette block in core.js)

## 2026-09-24 — round 1 (builder)

**Changed.** Rewrote all 17 downtown catalog buildings at res 4 (ids, footprints,
variant counts unchanged; `_selfTest` passes). Every model now starts with
`lotPlinth` and has a distinct base, shaft and crown. Added a local toolkit at the
top of downtown.js: `win` (framed window with a glowing head strip), `curtain`
(mullions, spandrels, "pop" panes), `decoStrips` (flush strips with proud piers),
`ledge`/`ring`/`parapetOn`/`piers`, rooftop kit (`penthouse`, `waterTank`,
`helipad`, `mast`, `roofSign`), lot kit (`tree`, `hedge`, `lamp`, `car`,
`parkRow`/`parkCol`, `umbrella`, `flag`, `canopy`, `shopfront`, `entrance`),
`clockFace`, `textC`, and `finish()`, which trims `sy` down to the real height.
Palette block `dt*`: painted glass (dtGlass/Deep/Teal/Dark/Green/Hi), limestone,
terracotta, copper, helipad, frame white, navy panel, warm grey.
Signature models: the hotel follows the ref05 hotel (red podium, cream piers with
red window strips, glass top storey, HOTEL sign, teal porte-cochère). The city bank
follows the ref05 bank (columns, 45° pediment with BANK, teal roof and condensers,
clock tower with a gold dome). The clock tower has three colour schemes. There is
also a brick highrise with a fire escape and water tank, deco and twin setbacks, an
eco tower with balconies and roof garden, a round drum tower, a glass skyscraper
with notched corners and a helipad, and a black tower with gold fins and a neon
lantern. Corporate HQ has a feature spine and a sky-garden notch. Tech campus has a
car park, a green roof with solar panels, and a TECH sign. Office block has a car
park, a stepped wing terrace and a glass stair bay. Shops & Offices has four
signed shopfronts with awnings and a podium roof terrace.
Glass is painted colour with a 201/200 strip at each pane head. By day the strip
reads as a sky reflection, and at night it lights the windows (checked with a
night render).

**Measured** (node, `buildVoxelGeometry(model,{})`, latest mesher). Average tris per
model by id: small-office 9.0k, hotel 8.2k, deco 10.3k, clock 11.3k, office-block
11.2k, glass-office 12.1k, green 13.0k, brick 13.7k, glass-sky 16.1k, shops 17.9k,
corporate 18.0k, round 18.3k, spire 18.9k, tech 19.8k, bank 19.8k, dark 22.9k,
twin 24.3k. The downtown average is about 15k. The old res-1 set averaged 4.7k on
the same mesher. Gallery pages ran at 57–61 fps and iso-mid at 46–61 fps, with zero
console errors. fps was noisy because other agents were running Chrome at the same
time: a homes gallery showed the same dips.

**Mesh-cost lessons (the greedy mesher's wide AO decides everything):**
- Recessing a small window 1 voxel costs about 5× a flush one, because AO varies in
  2D over every pane. Windows, curtain walls and shopfronts are now FLUSH by default
  (`recess: true` is still available). Depth comes from continuous proud piers and
  a few cornices instead.
- Proud piers combined with repeated horizontal ledges is the worst pattern: on a
  test box it cost 11k versus 2k for piers alone. Per-window sills add about 50%.
  Ledges got more expensive after the 'solid' AO mode landed. Use per-floor ledges
  only where they are the whole idea (the balconies on the eco tower, the tech
  sunshades) and keep them 1 deep.
- Glow colours never merge across a world cell, so each 201 head strip costs one
  quad per cell. That is fine at 2 rows.
- Circles (clock dials, drums, domes) are expensive when proud. Clock dials are now
  flush, with only the hands proud.

**Next.** (1) The twin towers (24k) and the black tower (23k) are the heaviest.
Thin the deco strip count on the twins and simplify the black tower's fins and
stages. (2) Give the backs more personality: service doors, AC units on walls, a
loading bay. The gallery camera changed during the round and now shows fronts, but
backs are still seen in play. (3) The 1x1 towers are still slim (about 3.5–4.5:1).
If the critic wants ref05 chunkiness, drop one or two more storeys or use
2.5-unit storeys, as the hotel now does. (4) The lot dressing inside 1x1 lots is
thin because towers fill most of the tile. Consider a front plaza strip with a
bike rack or bollards on the entrance side. (5) Consider a real sign font at 2×
scale for HOTEL/BANK.

## 2026-09-24 — round 2 (builder)

**Critic (r1) picked the reference:** flat extruded boxes, one window module plinth to roof,
no base/middle/top, flat BANK on the roof, thin flat mullions, tower tops cropped in galleries.

**Changed.**
- New facade grammar in downtown.js: `bayWall` puts windows in bays between pilasters or fins
  that stand 1-2 voxels proud (`proud`, `pierC`, with the corners wrapped). `ribbons` gives
  recessed horizontal window bands, with an optional spandrel colour. `course` is a string course
  that fills the slots. `cornice` is a dark frieze with stepped mouldings. There are also
  `rustic` (a rusticated base), `lobbyGlass` (recessed storefront/lobby glass) and `roofKit`
  (clustered condensers). `skyGlass` shades the panes from deep at the foot to sky-bright at the
  crown, with a diagonal sheen streak. This addresses the critic's "no reflection gradient" note.
- `finish()` now seals the interior: it flood-fills from the canvas border and fills every
  enclosed air cell. This matters most for recessed facades, where hollow shells cost about 2.5x.
  A plain hollow shell costs about 1.1k tris just for its inner faces. The fill is about 20 ms
  for a full 2x2 tower, the models are transient, and the mesh time is unchanged.
- All 17 buildings were re-authored with a distinct base, shaft and top, and with more materials:
  - small office: red brick or grey stone, cross windows in slots, proud quoins, granite lobby,
    billboard.
  - glass office: fins over a sky-gradient curtain wall, grey-stone lobby, glass lantern.
  - brick highrise: rusticated limestone base, stone pilasters over brick, belt courses, dentil
    cornice, water tank, fire escape.
  - deco: proud piers, gold setback bands.
  - green: deep balconies with glass rails and planters, roof pergola.
  - clock: white colonnade base, pilasters, clock stage, cupola.
  - hotel (the ref05 hotel): brick podium with quoins, cream pilasters over brick spandrels,
    teal glass band, navy cornice, a HOTEL sign standing on the front edge, porte-cochère.
  - office block: ribbons over dark spandrels, sunshades.
  - shops & offices: pilastered slab.
  - glass skyscraper: grey fins, gradient glass, mechanical bands every 6 storeys, lantern,
    helipad.
  - black tower: fins proud 1 so the dark glass shows.
  - corporate HQ: horizontal ribbons against a vertical glass spine.
  - twins: pilastered podium, deco stages.
  - spire: fins, navy spandrels.
  - tech campus: ribbons with sunshades.
  - city bank (rebuilt as the ref05 bank): giant order all round (columns 2 proud of tall glass),
    a portico with 7 columns, a 45° pediment with BANK on the tympanum and a raking cornice, an
    entablature and cornice, an attic with square windows, a teal roof crowded with condensers
    and a skylight, a full-width stair. The clock tower is gone.
- Palette block retuned (still 14 keys): muted glass, rosy brick (dtTerra). dtWarmGray was
  renamed to dtStone, a light blue-grey stone. Only downtown.js used any of these.
- Surgical change in tools/demo-city.js `gallery()`: downtown-only galleries and one- shots now
  frame the REAL model height (catalogModel sy/res) instead of `cap`, so crowns are no longer
  cropped.

**Measured.**
- Average tris per id is 14.9k (r1: 15.6k). Per id: small 9.7k, glass-office 8.3k, brick 12.9k,
  deco 8.3k, green 11.5k, clock 9.2k, round 9.4k, hotel 10.2k, office-block 13.2k, shops 16.1k,
  glass-sky 21k, dark 15.4k, corporate 26k, twins 25.6k, spire 17.9k, tech 16.1k, bank 16.5k.
- iso-mid: 1.61–1.66M tris (r1: 1.85M), 39–45 fps. Galleries ran at 52–61 fps and one- shots at
  61 fps. Zero console errors. fps is noisy because load average was about 7 from the other agents.
- `_selfTest` passes.

**Mesh-cost lessons (new):**
- A recess deeper than 1 is about 2.7x the cost of a 1-deep one, because wide AO varies across the
  whole slot. Get depth from PROUD pilasters/fins over a flush or 1-deep bay. The pier/bay
  pattern with d0 and proud 2 costs about 5k per 1x1 full height.
- A projecting course that crosses pilasters costs about 1.5–3k each. Use flush bands between
  pilasters every 3 storeys, and keep projecting courses for the base/shaft and shaft/top splits.
- Every colour row per storey (glass, head strip, spandrel) multiplies the AO columns beside each
  fin. Wider bays and fewer fins are the cheapest lever.

**Next.**
1. Corporate HQ and the twins are still about 25k: use wider slab ribbons or fewer deco strips.
2. The 1x1 towers are still slim needles (4–7:1). A light-court notch or a projecting bay stack
   on the brick highrise and hotel would break the box silhouette.
3. The bank pediment still steps when seen edge-on. A thin (2-deep) triangle with a proud
   1-voxel rake might read cleaner.
4. The market-stall lots the critic disliked are NOT downtown lots: they are another piece's
   plazas that fill empty gallery slots.

## 2026-09-24 — round 3 (builder)

**Critic (r2) picked the reference.** Their main point: the towers are flat extruded boxes that
repeat one vertical window stripe from bottom to top, with nothing for AO or shadow to catch.
They also said the bank reads as a cream box with painted fluting, and that BANK and TECH are
illegible.

**Changed.**
- New grammar in downtown.js. Depth now comes from MASSING plus PUNCHED windows instead of
  proud piers.
  - `punch`: glass sits 1 voxel back, with optional proud sill, frame ring, red/dark spandrel
    slot (`slotC`) and a flush sill option (`sillIn`).
  - `notch`: cuts a vertical balcony void out of the shell. It gives the void dark glass back
    walls with door mullions, a slab and a rail on every storey, and a lid at the top (see the
    lessons below).
  - `textBig`: pixel text at k× scale. `roofSign` takes k.
  - `dentils` and `roofCrowd` (condensers, vents).
- The bank is rebuilt. It has a peristyle of FREESTANDING octagonal columns (base, echinus,
  abacus) standing 2 voxels clear of a recessed hall of tall dark-glass windows, square antae at
  the corners, and a rusticated plinth with basement windows. The entablature carries BANK in 2x
  navy letters, plus dentils and a 3-out cornice. Above that sit an attic, a pediment with a gold
  clock, and a gable roof that runs back and reads as the ref's teal roof. A full-width stair has
  cheek walls and lamps.
- Hotel: wider (23 voxels) and fewer storeys. The podium is 1 proud, with white-framed tall
  windows and quoins. Shaft windows are punched into red spandrel slots with cream sills. A
  projecting centre bay runs front and back, with a band every 2 storeys. On top: a heavy navy
  cornice with dentils, the HOTEL sign on stilts, a lift house, a water tank and condensers.
- Glass skyscraper: horizontal glass ribbons behind white floor slabs, all four corners notched
  into balcony stacks, a sky-lobby ledge every 5 storeys, and 2 cornices. A 2x SKY sign stands on
  the podium roof, with a cantilevered canopy.
- Spire: same grammar, plus a pale sky-lobby band and a heavy cornice at each setback, with
  condensers on the terraces.
- Black tower: dark ribbons, a gold ledge every 3 storeys, notched corners on stage 1, and
  cornices at the setbacks. Its glass is lighter and it is lower.
- Deco and the twins: windows in dark spandrel slots, corners notched on stage 1, and a heavy
  cornice over a gold band at every setback, with urns.
- Clock tower: one stone plus one accent colour (critic: "noisy"). It has a freestanding
  colonnade in front of glass and punched framed windows.
- Small office: an oriel bay and framed windows.
- Glass office: ribbons, a corner notch and a stair tower.
- Brick highrise: a bay-window stack, framed windows and quoins.
- Shops & Offices: framed punched windows, notches, a glass stair on the front, a service core on
  the back and bands.
- Office block: 2 corner notches and a back core.
- Round tower: a proud floor-slab ring on every storey.
- Big 2x TECH and BLOX signs.
- Heights came down. 1×1 towers are 19–36 units (were 21–41). 2×2 towers are 40–50 units, except
  the spire.
- No palette changes. No files touched outside downtown.js.

**Measured.**
- Average tris per id is 17.2k (r2: 14.9k). Per id: small 12.2k, glass-office 11.8k, brick 15.3k,
  deco 11.6k, green 9.6k, clock 13.7k, round 12.8k, hotel 12.7k, office-block 15.0k,
  shops 23.2k, glass-sky 24.9k, dark 16.1k, corporate 26.6k, twins 28.9k, spire 20.7k,
  tech 15.3k, bank 22.7k.
- `_selfTest` is ok and every module parses. Every shot had zero console errors.
- iso-mid is now 2.56M tris, because the demo city is much denser than in r2. It ran at 18–29
  fps with load average 5–11 from the other agents. Galleries ran at 21–61 fps and the one-shot
  at 61 fps; the numbers are noisy.

**Mesh-cost lessons (ray AO, new):**
- A recessed (punched) window costs about 50–60 tris no matter its width (2–5 voxels). A flush
  window costs about 4. My earlier "5 per window" lab number was wrong, because the windows had
  merged into a ribbon.
- A continuous slot (`slotC`) plus a PROUD sill across it costs about 14k on the twins. A flush
  sill is about half that, and no sill is cheapest. The twins go without sills.
- **A notch in a hollow shell MUST get a lid.** An open ceiling connects the interior to the
  outside, so `fillSealed` cannot fill it, and every inner face gets meshed: +10k on corporate HQ.
  `notch()` now adds the lid itself.
- Massing is cheap. A projecting bay is about 0.2k and a notch about 1.4k, and at gallery scale
  they read far better than per-window detail.

**Next.**
1. Corporate HQ (26.6k) and the twins (28.9k) are the heaviest. Flush the glass on their back
   faces, or use wider ribbon panes.
2. The twin shafts still read somewhat vertical. Try a flush stone band every 2 storeys, or
   balconies at the setbacks.
3. The gallery showroom still sits on empty grass with no neighbouring lots (critic note 1).
   That is demo-city.js, not this piece.
4. The BLOX letters use glow (201) on navy, which blooms. Consider signWhite.

### Coordinator note (2026-09-24 15:15) — SAME gap three rounds running
r1, r2, r3 critics all said the same thing: towers are uniform extruded window grids
on flat wall planes. Incremental trim isn't moving the verdict. Make a bold pass:
EVERY tower gets (1) a distinct 1-3 storey base with lobby glazing, canopy, steps,
signage; (2) a shaft with REAL relief — pilasters/mullion fins proud by 1-2 fine
voxels, recessed window bays, balconies or spandrel bands every 1-3 floors, corner
chamfers/setbacks; (3) a crown: cornice, parapet, rooftop plant, tanks, railings,
helipad or signage. Vary materials (stone, brick, glass curtain wall, trim colour).
Triangle budget is NOT the constraint: a stress test with 270 res-4 bakeries was
1.8M tris at 61 fps; greedy meshing makes flat areas cheap. Relief is mandatory.
Study the bank, hotel and hospital in ref05 closely (crop and zoom them).

## 2026-09-24 — round 4 (builder)

**Critic (r3) picked the reference.** Main point: the facades are flat, repeated window
grids. Ref05's bank, hotel and hospital have relief at several depths: pilasters, recessed
bays, cornice bands, a different lobby storey, and crowded roofs. Other notes: the lots are
empty, the BANK letters are blobby, and BLCK/TECH are hard to read.

**Changed (downtown.js only; no palette changes).**
- New facade grammar, `pierBays`. The wall becomes continuous vertical slots: spandrel plus
  glass rows, sitting 1 back. Piers stand `pd` proud between the slots, corner piers are wider
  and prouder, and there is a band every N storeys, flush with the pier faces. Result: a
  recessed egg-crate 2–3 voxels deep (the ref05 hospital and hotel).
- `lobbyBays` makes a lobby storey that differs from the shaft: a granite plinth, square piers,
  dark glass 2 back behind a lit transom, and a band on top. It uses `alcove`, a recess ≥2 deep
  that keeps the shell sealed with cheeks and a lintel. A bare 2-deep clear unseals the hollow
  interior.
- `roofCornice` = cornice + a deck at its top. **Every roof kit before this floated** 3–5
  voxels above a sunken deck, hidden behind the cornice ring.
- New helpers:
  - `mechCrown` builds the roof: plant room, cooling towers, tank, condensers, vents, masts and
    dishes. `railing` is a cheap rail with sparse posts.
  - `text5`/`signBox` give crisp 5×7 1-voxel letters. The sign is double-sided, because the
    gallery lens sometimes shows backs.
  - Lot kit: `people`, `tiles`, `bollards`, `bikeRack`.
- Rebuilt buildings:
  - Corporate HQ is hospital-like interlocking volumes: a lobby, a front wing with a garden
    roof, a 4-storey left wing with cooling towers, the main tower, a teal glass lift core
    rising past the roof, a crowded crown, the BLOX sign, and a plaza with a car park.
  - Tech has a lower block and an upper block cantilevered over the entrance plaza on columns,
    with coloured spandrels.
  - Twins: pierBays stages with a band every 2 storeys, railed terraces with AC units, and a
    plant room, tank and spire on top.
  - Spire and dark tower use pierBays over their setbacks, with railings and a dark-tower lobby.
- Converted to pierBays: glass skyscraper (white fins over glass slots, bands every 4, no
  notches), glass office, deco, hotel (cream pilasters over red slots, like the ref), office
  block, shops slab.
- Every lot got paving tiles and people. Several got car parks, planters, flags and bikes.
- BANK and HOTEL now use the 5×7 font. The HOTEL sign was widened to the lot.

**Measured.**
- Avg tris per id 19.0k (r3 17.2k).
- 2×2: corporate 27.2k, twins 37.4k (heaviest), spire 28.9k, tech 25.3k, glass-sky ~26k,
  dark 21.5k, bank 21.2k.
- 1×1: 9–16k.
- iso-mid 2.53M tris (r3 2.56M). fps 17–20 at load average 9; galleries 25–54 fps. Zero console
  errors. `_selfTest` ok.

**Mesh-cost lessons.**
- pierBays on a 2×2 face (10 storeys): slots + piers ≈ 9.7k for 4 sides. Bands every 2 storeys
  ≈ +8k, every 3 storeys (2 high) ≈ +7k. Egg-crate on every storey ≈ +17k, so avoid.
- Glass colour rows and mullions are cheap (±1k).
- Corner notches that cut *through* proud corner piers cost ~9k on the glass skyscraper. If the
  notch box stays inside the wall it is cheap, but it is then hidden behind the piers (the r4
  bug on glass-sky). So either cut both, or neither.
- Posts every 4 on a railing ≈ 0.6k per roof. Use a continuous rail with posts every 8.

**Next.**
1. Twins at 37k: the podium plus 2 towers × 3 stages. Try `bandEvery` 3 on stage 2, or drop the
   podium's upper storey.
2. The glass skyscraper still reads a bit white-heavy. Try lighter glass tones or thinner corner
   piers.
3. The small office, brick highrise and clock tower still use punched windows. They have
   relief, but could get pierBays pilasters.
4. The gallery camera flips between fronts and backs from run to run. Keep all 4 sides
   finished.

### Note from life (r8, 2026-09-24)
The `person()` helper in your model file now calls `stampPerson` from vehicles.js, and in commercial.js `car()` now calls `stampCar`. These draw the same figure/car as the traffic, as a res-15 lot part. The r7 critic named the old 1-2 voxel people as "pegs with no head or arms". Please keep this change when you rewrite the file: in round 8 a whole-file write reverted it once.

## 2026-09-24 — round 5 (builder)

**Critic (r4) picked the reference.** Main point: the shafts (SPIRE, BLOX, twins) were long runs
of one recessed dark-blue window strip on flat cream faces, and the plazas at the tower bases were
nearly empty. The silhouettes and the bank were praised; keep them.

**Changed (downtown.js; no palette keys added, see the warning below).**
- New `framedBays` replaces every `pierBays` shaft. The pier/slot massing stays, but each slot
  now holds one DISCRETE window per storey:
  - a white frame ring, or with `jambs:false` only a head and sill, so the spandrel colour shows
    beside the glass (hotel red);
  - a centre mullion, sky-blue glass with a paler upper-pane sheen, and a glow head strip;
  - a sill per storey: `sillOut` 1 is proud, 0 is flush, -1 is painted;
  - optional balconies (`balc`), hanging AC units (`ac`) and flower boxes, set per bay and
    storey. Stages now switch treatment up the height (spire: framed windows with AC units, then
    balcony stacks, then a glass cage; twins: framed windows, then a checker of balconies; deco
    and dark: balconies on stage 2).
- Intermediate piers are now flush (`pd:0`), and only the corner piers stand proud. The 2-deep
  reveals were hiding the narrow glass at iso angles, so the windows read as slits.
- Glass is bright throughout: the navy `dtGlassDeep`/`dtGlassDark` tones in shafts and lobbies
  became `dtGlass`/`dtGlassHi`. Lobby mullions are white.
- `grandEntry` adds a glass lobby recess with mullions and a lit transom, double doors, a stepped
  stone terrace, a glass canopy on posts with a fascia and the name standing on it, and flanking
  planters with shrubs and lamps. It is now on the spire, glass skyscraper, corporate, twins,
  dark tower and tech.
- `stripLot` dresses a lot strip by its width: 10 or more gives nose-in stalls, 5–9 a
  parallel-parking lane with white ticks and cars, less than that a hedge. The 2×2 podiums were
  pulled in from the lot edge to make room: spire P 9..53×14..53, glass skyscraper 9..53×16..53,
  twins 7..55×14..53. Every 2×2 tower now has parking on 3 sides and a busy front plaza.
- Glass skyscraper: a teal glass spine stands 3 proud up the front and back and rises past the
  roof, so the curtain wall is not a uniform grid. Its corner bays carry balcony stacks.
- Hotel: the fronts use 6-wide bays and the sides 6/1/2. White-headed windows sit between red
  jambs, with cream proud sills and AC units, as in the ref05 hotel.

**WARNING: palette cap.** I added 3 dt keys, and together with the new [vehicles] block that
pushed `vehSilver` to index 200, colliding with `C.win`. voxel.js then logged a palette drift and
fell back to hex colours, and the WHOLE city rendered GREY (seen in gal/iso shots at 14:30). I
removed my 3 keys. The palette is back to 202 names including the 4 glow slots, and the highest
named index is `vehSilver` at 197. Only 2 free slots remain before 200. Reuse existing colours
instead of adding keys.

**Measured.**
- Tris per id, averaged over variants (the shared mesher changed mid-round, so these are not
  comparable to r4's 17.7k):
  - 2×2: twins 41–42k, corporate 30–31k, spire 31k, glass skyscraper 29–32k, dark 24k,
    tech 23–26k, bank 20k.
  - 1×1: 9–16k.
  - Downtown average 18.8k.
- Proud sills are the expensive part. They break every slot per storey and cost about 11k on the
  twins; flush sills cost about the same, and painted sills about 1k. The twins, spire and glass
  skyscraper use painted sills. The hotel, office blocks and corporate keep proud sills.
- `_selfTest` is ok and every module parses. Zero console errors on every shot.
- iso-mid is about 3.1–3.2M tris, but load average was 7–10 from the other agents, so the fps
  figures (13–61) are noise.

**Next.**
1. The twins are still the heaviest (41k). Try `bandEvery` 3 on stage 1, or fewer balconies.
2. The round tower is still a uniform stripe drum. Try a balcony ring every 3rd storey or a
   vertical glass fin.
3. The 1×1 towers do not use grandEntry yet (only the 2×2 do). With `lamps:false` it fits a
   31-wide lot.
4. The gallery camera flips between fronts and backs, so both must stay dressed. Tool: a copy of
   shoot.mjs with `--post` for camera tweaks is at scratchpad/dt5/shoot2.mjs (rotate `_camAz` by
   PI to see the other side).

### Coordinator note (2026-09-24 18:55) — you're close; the gap is now MATERIAL VARIETY
Looked at r5's pair myself: the articulation work landed (the BANK is near
reference quality). What a viewer notices now is that almost every tower is
cream/white with the same blue window grid. ref05 mixes per building: orange/red
brick hotel with cream trim, teal-roofed stone bank, white hospital with red cross,
dark navy glass office, terracotta + teal accents. Give each of the 17 ids a
distinct primary material + trim + glass tint (and vary variants too), and dress
the lots (parking stripes with a few cars, planters, plaza paving, a flagpole).
Keep the relief you've built.

## 2026-09-24 — round 6 (builder)

**Critic (r5) picked the reference.** Main point: material and facade monotony. TECH, BLOX,
TWINS and SPIRE were all cream or white shafts, each with the same small blue window grid. The
lots were thin rims. Other notes: the signs were blue on blue (hard to read), and the black
tower had a magenta cube.

**Changed (downtown.js only; no palette keys added — the cap is still tight).**
- Every id now has its own primary material (the per-tier rhythm from r5 is kept):
  - corporate HQ (BLOX): white with continuous teal glass ribbons behind proud floor slabs,
    deep white corner piers, an all-glass top storey, and a deep-blue lift core. v1 uses blue
    ribbons. The core now stops under the BLOX roof sign, which it used to hide.
  - twins: a red-brick shaft (v1 dtTerra) with cream quoins, a pd 1 pilaster egg-crate, loggia
    notches, a cream balcony tier and a gold crown with tall windows.
  - spire: silver stone piers standing 2 proud of dark-blue glass with navy spandrels, banded
    floors on tier 2 and a glass cage at the top.
  - tech: a terracotta lower block and a dark-glass cantilever banded by white sunshades.
  - glass skyscraper: a blue glass prism (v1 teal). The fins are glass-coloured, the corner
    piers navy, and white appears only on the 4-storey bands and the cornices.
  - deco: terracotta (resTerracotta) / blue-grey / butter per variant, with gold trim.
  - brick highrise: the stone frame ring on every window is gone, because it covered the brick
    and the tower read cream. The bay stack is brick with stone arrises, and the quoins are
    slimmer.
  - clock: one variant is brick with cream trim.
  - shops & offices: sage / blue-grey / butter slab.
  - office block: white with terracotta spandrels (v0), or slate with navy (v1).
- Signs: grandEntry now stands the name on a dark board in white. TWINS is gold on black, TECH
  is the logo colour on black, and ONYX's magenta lantern is now warm lit glass with gold
  mullions. Mast beacons (the `mast` default and the deco tip) are red instead of neon pink.
- Lots: `kerbCars` adds a kerbside lay-by of cars and taxis along the front edge of the
  corporate, twins, spire and glass-skyscraper lots. The side strips' parking fill went up to
  0.95.
- New dev tool: scratchpad/dt6/iso.mjs + isos.sh is a software iso rasteriser of
  catalogModel. It takes about 1 s per model and needs no Chrome. Use it to iterate on
  materials, then confirm with shoot.mjs, which took about 2 min per shot at load 50–100.

**Measured.**
- Tris per id (the mesher changed mid-round again, so only relative numbers mean anything):
  - twins 32.6–33.9k, glass skyscraper 21.9–24.1k, corporate 21.9–23.0k, spire 22.5k,
    dark 19.2k, tech 17–19k, bank 16.4k.
  - 1×1 towers 7–13.5k.
  - Downtown average 14.4k (the same code measured 16.6k before the mesher change).
- `_selfTest` is ok and check.sh passes. Zero console errors on all 5 shots.
- fps: gal 11–23, one-shot 32, iso-mid 8 at 2.42M tris. Load average was 12–100 from the
  other agents, so these numbers are noise.
- Result: iso-mid now shows red brick, sage, blue glass, navy, terracotta and cream side by
  side, not a cream field.

**Next.**
1. The critic also wanted the dark right-hand face to show deeper recesses. Most shafts
   still use pd 0 piers with only the corner piers proud. Try pd 1 on one tier per tower,
   like twins tier 1 and spire tier 1.
2. The 1×1 lots are still plaza-only. A kerbside car or two would need the planters and
   lamps moved back.
3. The twins' C.brick reads very saturated in game. If a critic calls it garish, try a
   dtTerra/brick mix per tier.

## 2026-09-24 — round 7 (builder)

**Critic (r6) picked the reference.** Main point: the shafts (Twins, Spire, Blox) looked soft and
low in contrast "under a light haze", with the same bay from base to crown and no dark recess
lines. Lots were thin rims.

**Changed (downtown.js + dt glass keys in core.js; no keys added).**
- The haze was ours: `skyGlass` ramped the glass from mid blue to pale `dtGlassHi` toward the
  crown, and `framedBays` painted `sheen` over the whole upper half of every pane. Now the glass
  stays the DEEP base tone from foot to crown, and only diagonal streak panes pick up the
  mid/bright tones. Sheen is now the upper-left quarter pane only. `SKY` is
  [dtGlassDeep, dtGlass, dtGlassHi].
- Palette (mine only): dtGlassDeep 0x2a5b9f, dtGlassTeal 0x238f9c, dtGlassDark 0x213450. These
  are more saturated and darker. dtGlass / dtGlassHi are unchanged, because commercial, civic,
  fun and industrial use them.
- `framedBays` gained a `deep` option (default on). The pane sits at -2 behind its frame ring at
  -1, so AO draws a dark reveal line at every head and jamb. It is off where the pilasters
  already give depth (twins tier 1 and 2).
- New `skyGarden(g,B,ys,ye)`: one storey carved 3 back all round into a shadowed loggia with
  dark glass, columns, a hedge and flower planter ring, and slabs above and below. Used on the
  glass skyscraper (after storey 4) and on BLOX (after storey 5), so both shafts now have a
  lower and an upper part.
- Twins tier 1: the windows fill the bay (5×7, white head, painted stone sill). The shaft no
  longer reads as flat red pilasters with slits.
- BLOX floor slabs now stand 2 proud, so each one casts a shadow line over its ribbon.
- Lots: `fillLot` scans each finished lot for free PAVED ground and scatters planters, tree
  boxes, benches, tubs, bins, kiosks, café umbrellas and lamps (30 per 2×2, 14 per 1×1). It
  keeps the `frontWalk` clear. Glass skyscraper and spire podiums were narrowed to 11..51, so
  their side strips are 10 wide and hold nose-in stall rows instead of parallel lanes.

**Measured.**
- Tris per id (v0): glass-sky 43k, spire 45k, twins 38k, corporate 25k, dark 23k, others
  8–20k. Average 18.4k (r6 14.4k).
- Deep windows cost about 20k each on glass-sky and spire (~90 tris/window). They cost 9–11k on
  the twins, which is why they are off there. fillLot costs about 1.5–2.5k per model.
- `_selfTest` ok, check.sh ok, zero console errors on all 5 shots.
- iso-mid 2.66M tris at fps 10, gal 14–17, one-shot 29. Load average was 10–16, so these fps
  numbers are noise.

**Next.**
1. If the tri budget bites, turn `deep` off on the glass-sky side faces (b/r), or try one
   continuous 2-deep slot per bay with spandrel bars at -1.
2. The spire tier 1 is still 6 identical storeys; a sky garden at storey 3 would split it.
3. 2×2 lots still read as rims because the podiums fill most of the lot. Shrinking the tower
   footprints (for a ref05-hospital-style big car park) would be the real fix, but it makes the
   towers slimmer.
4. The glass-sky front spine top pokes out as a plain white block under the cornice. Give it a
   cap or glass.

## 2026-09-24 — round 8 (builder)

**Critic (r7) picked the reference.** Main point, on gal-downtown-2: the SKY and ONYX shafts
were tall slabs of flat colour, one repeated window strip per bay, nothing marking the floors,
and ONYX read as a nearly black mass (its dark side had no colour). They wanted a ledge or sill
on every floor, vertical pilasters, and a bright podium with a canopy and signage. They also
called the rooftops sparse. Past critics agree on "flat slab / uniform grid" (r1–r4, r7) and
"too dark" (r7). The r6 note was "hazy", so I aimed for the middle rather than going pale.

**Changed.**
- `framedBays` gained `ledgeC`/`ledgeOut`: a continuous ledge under every window row. It fills
  the slots and crosses the pilasters, and is skipped on band rows. Most shafts now use
  `pd: 1` pilasters + a ledge on every floor + `deep: false`. The ledge replaces the per-window
  deep reveal, which was the costly part.
  - SKY: silver-stone (v1 limestone) pilasters, wide white-framed bays split per side (fb 8, lr 9).
    White corners replace the navy mass, the ledges are white, and the bands every 4 storeys
    are kept.
  - ONYX: slate-blue piers. **dtPad changed 0x3b4149 → 0x5b6476**, and the helipad now uses
    stoneDark. Bays are filled with glass under gold (or white) heads, with a gold ledge on
    every floor. Stage bays are 7/6/5 wide, so the upper stages get windows. Setback terraces
    have railings and roofCrowd, and the setback roofs are roofGray instead of black.
  - Shops & Offices: light spandrels (terra, blue glass or copper, no navy), white ledges,
    pd 1, light notch backs.
  - Office block: bw 5 / cw 2, a ledge on every floor, v1 copper spandrels, stair windows up
    the back core, and a light lobby.
  - Glass office: cw 1 (glass-dominant). Deco and spire tier 2 get pd 1 + ledges. Twins tier 1
    and spire tier 1 get ledges. Spire spandrels are dtGlassDeep instead of navy. Hotel gets
    pd 1.
- **dtGlassDark changed 0x213450 → 0x2b4776** (only downtown uses it).
- New `awnings()` puts striped shop awnings (plus sign boards) over lobby bays on all 4 sides.
  Used on the SKY, ONYX, SPIRE, BLOX and TWINS podiums, skipping the grandEntry bays.

**Measured.** Tris per id: glass-sky 28–30k (was 43–46k), dark 25k, spire 40k, twins 34–36k,
corporate 23–24k, the rest 7–17k. Downtown average about 15.7k (r7 at the start of this round:
18.2k). `_selfTest` ok, check.sh ok, zero console errors on all 5 shots. fps was 6–22 in the
galleries and 8 in iso-mid (2.69M tris), at load average 9–15 with many Chromes, so these fps
numbers are noise. iso-mid needed `--timeout 900`. In game, SKY now reads as framed windows
between pilasters with a white ledge on every floor. ONYX reads as a slate-blue and gold
art-deco tower whose right face stays blue (glass renders about (66,132,190)).

**Next.**
1. The round tower is repeated a lot in iso-mid and is still a uniform striped drum. Give it
   a balcony ring every 3rd storey or a vertical glass fin.
2. ONYX may still read slightly periwinkle under the grade. If a critic says "purple", move
   dtPad toward 0x5f6570.
3. The gallery camera azimuth changed between each run in this round (front vs back). Both
   sides are dressed, but the BLOX side faces are still plain ribbons.
4. The last two edits (dtPad 0x58627a→0x5b6476 and glass-office cw 1) came after the final
   shots and were checked only in the iso preview.

## 2026-09-25 — wave 2, round 1 (builder)

**Brief (coordinator):** every tower needs a DISTINCT 1-2 storey podium, per-floor articulation,
material variety per id (brick / terracotta / teal / dark glass, no near-black masses), full lots.
coherence.md had no [downtown]-tagged items.

**Changed (downtown.js + dtPad in the [downtown] palette block).**
- `streetPodium` gained `ground`: 'shop' (the old shopfront + fascia + awnings), 'arcade'
  (round-arched 2-deep openings, fanlights, keystones, impost band), 'colonnade' (two-storey
  giant order: columns with bases + capitals in front of a 2-deep dark-glass hall) and 'glass'
  (two-storey glass lobby behind slim white fins + a cantilevered canopy band with small boards).
  Before this, 12 of 17 ids shared the same red-brick shopfront podium.
- `portico` gained kinds 'marquee' (theatre canopy with bulb rows, lit name, vertical blade sign:
  DECO, ONYX) and 'pergola' (timber + climbers: ECO), and `sign: 'letters'` (free-standing
  2-deep letters on the canopy instead of the black sign box that sat on every tower).
- Per id: small office colonnade+temple; glass office glass lobby; APTS shop; deco arcade+marquee;
  eco glass+pergola; clock tower REBUILT base = colonnade podium + TOWN temple (was a cage of
  red columns on a thin plinth); round arcade; office block arcade (v0) / glass (v1); SKY
  colonnade; ONYX arcade+marquee; BLOX glass; twins arcade; spire colonnade; tech glass.
- Materials: SKY is now a dark-blue (v1 teal) glass tower (glass-coloured pilasters + corners,
  white ledge every floor); glass office = beige / dark-blue glass / TEAL per variant (gallery
  shows v2 = teal); spire v0 warm beige stone (v1 terracotta); ONYX dtPad 0x5b6476 -> 0x3f6b78
  (steel-teal + gold, renders ~#4f8fb0, not black); round tower slab colour per variant (white /
  terracotta / cream) + glass per variant; office block v1 cream + teal; clock tower brick
  variant -> limestone + green roof; small office v0 -> terracotta.

**Measured.** avg tris per id 20.5k (19.7k before; spire 45.5k, SKY 35k heaviest). `_selfTest`
ok, check.sh ok, zero console errors on all shots. fps 8-38 galleries, 10-11 iso-mid at load
avg ~20 (noise; baseline shots at the same load were 21-37 / 22). Software iso preview
(scratchpad/dt6/isos.sh) used for all iteration. In game iso-mid now reads teal, blue glass,
brick red, cream, sage, butter instead of a pale grey-blue field; gal-1 no longer has 4 reds.

**Next.** (1) twins brickDark and resTerracotta render quite saturated coral/salmon; if a critic
calls them loud, move toward ref05's pink-red. (2) The gallery variant for each id is v2 for
glass-office (not v0) — check which variant a gallery uses before recolouring. (3) Spire (45k)
and SKY (35k) are the heaviest; spire tier-1 framedBays with pd 2 is the cost. (4) The hotel is
still the only 1x1 with its own bespoke podium; consider a porte-cochere variant for others.
(5) NEVER `git stash` in this shared tree to measure a baseline (I did once; it popped cleanly).
