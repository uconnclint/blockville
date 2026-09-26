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

## 2026-09-26 — wave 4, round 1 (builder)

**Brief:** same as w2 (distinct podiums, per-floor articulation, material variety, full lots).
coherence.md has no [downtown] items. Baseline shots: scratchpad/rounds/downtown/w4r1-base.

**Changed.**
- **Glass hue (measured).** ref05 glass is a dark petrol blue: bank/hospital/glass office pixels
  cluster at (32-48, 64-80, 80-96), reflections (80-112, 112-128, 128-144). Ours rendered ROYAL
  blue (48,80,176) / (64,128,240), which made iso-mid a blue wall. `dtGlassDeep 0x2a5b9f → 0x2c5a78`,
  `dtGlassDark 0x2b4776 → 0x2a4a66` (civic uses dtGlassDark, industrial dtGlassDeep as mullions —
  both shift toward the ref too). **materials.js `nightGlassColors` synced** (exact-match list:
  change both together or night windows stop lighting). SKY now renders (32,64,80)-(48,128,144).
  SKY v0: petrol panes + silver-stone (dtStone) pilasters; ONYX and spire tier 2 panes now use
  dtGlassDeep as the base tone (dtGlass only on streaks). dtGlass/dtGlassHi untouched (shared).
- **ONYX = jade + gold art deco**: `dtPad 0x3f6b78 → 0x347a63` (only downtown uses it). It sat
  next to SKY as a second blue tower; now renders jade (64,160,128) lit.
- **Signs.** portico `sign:'letters'` (MEDIA/CORP/CITY, APTS, ORBIT/HALO/ROUND, SKY, BLOX, TECH, CITY)
  was 2-deep free-standing letters that read as a jumble of yellow blocks in game. Now a framed
  board (the ref05 HOTEL sign): black board 2 deep, rim + 5x7 letters 1 proud in textC, 2 legs.
  Pergola (ECO) got a green board with white letters.
- **Temple text overflow**: 1x1 temples (TOWN, CITY) were 19 wide for a 23-wide name, so the first
  letter floated off the end ("OWN"). portico widens a temple to fit its name.
- Round tower: drum glass bands now split into discrete framed windows (mullion every ~4 voxels
  of arc, head frame) instead of continuous stripes.
- Deco tower: 3 bays per face (pw 1, cw 2), glass fills the bay under a gold head (was 2 bays of
  3-wide slits that read as blank slots).
- Tool: scratchpad/iso.mjs — node software iso preview of catalogModel (id:variant[:rot], --k px
  per voxel), ~1 s, no Chrome. Use it; shoot.mjs took 10+ min per shot set at load 80.

**Measured.** `_selfTest` ok, check.sh ok. Final shots: scratchpad/rounds/downtown/w4r1-builder.

**Next.** (1) dtGlass (0x4f86bd, shared by every category) still renders sky-royal (64,128,240)
vs ref (96,128,144); a global desaturation belongs to a coherence pass (+ nightGlassColors).
(2) Twins brickDark renders coral (216-252,72-108,72-96); ref hotel brick is (132,36,48), ref fire
station (252,96,24). Aim between if a critic calls it pink. (3) 1x1 towers are 5:1 on screen vs
ref ~2.2:1 — critics praised silhouettes, so height was left alone. (4) Palette is FULL (index
199 used): recolour, never add keys.

## 2026-09-26 — wave 4, round 1 (builder, resumed after the first instance stopped mid-round)

**Changed (downtown.js only).** The first instance's unshot edits are kept and verified in game:
- portico `kind:'arch'` (twins): stone pylons, a round-headed tunnel, a gold archivolt and keystone,
  a sunburst fanlight, TWINS in gold on a black band, and finials.
- portico `kind:'cochere'` (spire): a deep drive-through roof on slim columns, a teal skylight, a
  lit soffit, a SPIRE board and a taxi. It replaces the spire's kerbCars lay-by.

Podium de-duplication, so that no gallery page repeats a (ground, portico) pair:
- small office: colonnade → arcade (keeps the temple). It had duplicated the clock tower's
  colonnade + temple on gal-1.
- ONYX: arcade → shop ground (shopfronts + awnings under the marquee). It had duplicated DECO.
- office block v0: arcade → colonnade. It had duplicated the round tower's arcade + slab on gal-2.
- small office roof billboard: now CAFE/LOANS/NEWS, so it no longer repeats the temple's CITY.

**Measured.**
- `_selfTest` ok. check.sh ok. Zero console errors on all 5 shots (scratchpad/rounds/downtown/w4r1-builder).
- Tris: gal-1 0.50M, gal-2 0.68M, gal-3 0.65M, one-glass-sky 0.53M, iso-mid 2.12M.
- fps: 14–50 at load average ~10 (noise).

**Next.**
1. dtGlass (shared) still renders royal/cyan on the glass office and BLOX. It needs a coherence
   pass together with nightGlassColors.
2. Tech and the glass office are both glass + glass (on different pages).
3. The iso-mid downtown is still a dense forest of 1×1 needles. Critics praised the silhouettes,
   so they were left alone.

## 2026-09-26 — wave 4, round 2 (builder)

**Critic (w4r1) picked the reference.** Main points, on gal-2 (SKY and ONYX):
- the shafts repeat one module with no bold cornice;
- the roofs are sparse;
- the signs are small and low in contrast;
- the lots are full of parked cars instead of a designed plaza;
- ONYX's gold trim reads as noisy stripes.

**Changed (downtown.js only; no palette keys).**
- New lot helpers:
  - `plazaStrip`: paving on a 5-grid, plus raised planted beds (stone rim, grass, chunky tree, flowers) along the strip.
  - `forecourt`: a front plaza with a planted bed and a fountain in each wing, and a dark-paved walk.
- The side parking lanes on SKY, ONYX, twins, spire and BLOX are now plaza strips. The kerbside car lay-bys on SKY, twins and BLOX are gone, replaced by a forecourt (twins, SKY) or a planted strip (BLOX). Parking is kept only on the back strip (p 0.6) and in the BLOX right-hand car park (p 0.7).
- New `bigSign`: the ref05 HOTEL sign at 2x. It has 5x7 letters at k 2 in yellow on a black board with a lit rim, stands on steel legs, and is lettered on both sides.
- SKY crown rebuilt:
  - a navy frieze and a 4-out overhanging cornice;
  - the lantern moved to the back half of the roof, with a big SKY sign on it as the top of the silhouette;
  - the front half is crowded with 2 cooling towers, 5 condensers and vents;
  - the helipad and the dish are gone.
- Marquee (ONYX, DECO): the fascia is black with yellow letters (it was gold on jade or navy). The blade sign now carries the name in stacked 5x7 lit letters on both faces, with a bulb border.
- ONYX: the per-floor ledge is jade (dtPad), so it reads as a shadow line, not a gold stripe. Gold stays on the window heads and the band every 3 storeys.

**Measured.**
- `_selfTest` ok, check.sh ok, zero console errors on all 5 shots (scratchpad/rounds/downtown/w4r2-builder).
- Tris: gal-1 0.50M, gal-2 0.68M, gal-3 0.63M, one-glass-sky 0.51M, iso-mid 2.12M. These are unchanged within noise.
- fps: 12–53 (load average ~10).
- The cars still visible next to the SKY and ONYX lots are on the road's parking lane (roads piece), not on the lot.
- The white blob near the SKY sign in the shots is a field prop. It shows in open grass too, so it is not ours.

**Next.**
1. ONYX has no rooftop name, because its top stage is only 21 wide. Consider a vertical blade on the crown.
2. The twins, spire and BLOX roofs could get the same crowded HVAC front half.
3. The SKY lower shaft (4 storeys) is still one module. If a critic repeats "repeats floor after floor", add a mid-shaft balcony tier.

### Coordinator note (2026-09-26 16:40, wave 4) — glass is PATTERN, not colour
w4r2 critic: "flat dark-navy recessed slots in a uniform grid"; shops critic said similar. Measured blue-glass luminance quartiles, dark→bright:
  ref05 bank/hotel: #174766 #245a76 #376f8a #548ba2 #6cb6ce
  ours iso-mid:     #294c74 #366b91 #4c84b4 #6cacd3 #a8dbfa   (ours is already as bright or brighter)
So don't recolour glass. The gap is the arrangement: replace small punched slots with BIG continuous panes / vertical curtain-wall bands spanning several floors on at least one face of glass towers, with 1-2 diagonal light streaks (lighter pane voxels) across them; vary window rhythm between towers (bands, ribbon windows, grids) and floors (podium vs shaft vs crown). Plus the plaza point: towers on wide paved plazas with steps, planters and a canopied entrance, not thin car-filled strips.

## 2026-09-26 — wave 4, round 3 (builder)

**Critic (w4r2) picked the reference.** Main point: the glass on SPIRE, TWINS, BLOX and TECH was flat dark-navy recessed slots. ref05 has bright cyan panes with diagonal streaks. They also asked for wider plazas instead of car strips. Both w4 critics said the roofs were sparse.

**Changed.**
- New `paintPane` + `PANE_RAMP` (downtown.js). `framedBays`, `pierBays`, `bayWall` and `ribbons` now paint every dtGlassDeep/Dark/dtGlass/dtGlassTeal pane in four parts: a dark foot row (dtGlassDark), a body (dtGlassDeep) in the lower 40%, a lit upper band (dtGlassTeal), and a short rising dtGlassHi streak. The streak offset changes per pane. The pane measurements came from ref05's bank: foot (16-48,48-80,64-96), lit body (80-112,128-160,150-180). The old upper-left `sheen` is skipped on ramped panes.
- **dtGlassTeal 0x238f9c → 0x35a0b0** (a lighter teal-cyan, used only by downtown). **materials.js `nightGlassColors` synced** (slot 4). I tried 0x3f9bbf first. It turned SKY v1 (teal pilasters) into a royal-blue slab, so I kept the hue teal.
- Spire tier 1: pd 2 → 1, ledgeOut 2 → 1, deep off. The deep piers and ledges hid most of each pane in shadow.
- TECH: the front asphalt car park is replaced by a `forecourt` (fountains + planted beds).

**Measured.**
- Zero console errors on all 5 shots (rounds/downtown/w4r3-builder).
- Tris: gal-1 0.54M, gal-2 0.72M, gal-3 0.67M (was 0.63M), one-glass-sky 0.55M, iso-mid 2.19M (was 2.12M). The pane gradient costs about 3-5%.
- In game, spire and twins panes now read (80,144,192) lit / (32,112,160) body instead of being mostly (16-32,32-48,48-64). SKY v1 reads as a teal-cyan curtain wall.

**Next.**
1. Roofs are still thin on the twins crowns, the spire top and BLOX. The setback terraces are only 3 wide, so a crowd needs the lantern/penthouse made smaller.
2. The twins and spire still have kerbside parking on the back strip.
3. If a critic calls the streaks a zig-zag, make them 1-wide single diagonals.

## 2026-09-26 — wave 4, round 4 (builder)

**Critic (w4r3) picked the reference.** All three w4 critics agreed on two things. First, the shafts are uniform grids of small dark recessed windows; they want tall glass bays of 2-3 storeys framed by pilasters, with cyan glass and light streaks, like the ref05 bank. Second, the lots are thin rims full of cars. All three also called the roofs sparse. coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- New `giantBays`, the ref05 bank order for towers. Pilasters stand `pd` proud. Every `span` storeys a band flush with the pilaster faces carries a 1-out cap, with capitals under it. Each bay is one continuous glass sheet 2-3 storeys tall: thin transoms at the floor lines, an optional centre mullion, a dark foot row, a deep lower 30%, a lit teal body, and two rising diagonal dtGlassHi streaks (4 wide and 2 wide) across the whole bay, offset per bay. Default tones are `GTONES`.
  - Spire tier 1: beige pilasters (pd 1, bw 10), span 3, white caps, navy transoms.
  - Twins tier 1: brick pilasters (pd 1, bw 7), span 3, cream bands and transoms, no mullion.
  - SKY shaft: span 2, silver pilasters (pd 1), white bands, transoms and mullions (fb bw 9, lr bw 8). Corner piers are now cpd 1.
  - ONYX stage 1: span 3, jade pilasters, gold caps and transoms. Stages 2-3 keep framedBays, so the rhythm changes up the tower.
- In game, pd 2 buried narrow bays in AO; the twins' right face measured (23,38,57). pd 1 with wider bays fixed it. The spire's lit face now measures median (37,110,131), against the ref bank's median of (29,130,158).
- New `plazaLot(g)`: a beige plaza lot (C.sand fill, sandDark 6-grid) that also sets `g.pave`, which `plazaStrip` and `forecourt` now use. Spire, twins and bank use it (the ref05 bank's forecourt is beige). Sand and sandDark were added to PAVED so `fillLot` dresses them.
- The back-strip car parks on SPIRE, TWINS, SKY and ONYX are now planted plaza strips. The only lot parking left is BLOX's right-hand car park. The cars along the kerbs in the galleries are the roads piece's parking lane.
- Spire setback terraces: roofCrowd raised from ac 2 to 4 per side, vents from 1 to 2.

**Measured.** check.sh ok. Zero console errors on all 5 shots (rounds/downtown/w4r4-builder).
- Tris: gal-1 0.54M, gal-2 0.71M, gal-3 0.59M (was 0.67M), one-glass-sky 0.54M, iso-mid 2.13M. The giant bays cost less than the framedBays they replace.
- fps 41-61 on galleries, 17 on iso-mid (load average ~10).
- Note: one early gal-downtown-2 shot framed empty countryside (a transient camera or other-agent issue). The re-shot was fine.

**Next.**
1. The 1x1 towers (deco, clock, brick, hotel) still use punched or framed grids. Deco and the brick highrise could take giantBays span 2.
2. The twins' crowns and the spire's lantern roof are still thin. The terraces are only 3 wide.
3. If a critic calls the streaks "staircase" zig-zags, try a slope-2 streak or a 2-tone (lit + hi) band.
4. The 2x2 towers still fill most of the lot. A truly wide forecourt needs the podiums moved back, and every coordinate in those builders is hard-coded.

### Coordinator note (2026-09-26 19:15) — after w4r4: midpoint, my 16:40 note overshot
w4r2 wanted "tall glass bays, not punched slots"; w4r4 now sees "coarse flat slabs with a few chunky dark window blocks" and wants "a fine dense grid of small framed windows, pilasters and cornices every floor". Both describe ref05's bank/hotel correctly: a FINE window grid (one window per 2-4 voxels, every floor), each window FRAMED in pale stone/trim so it catches light, grouped into bays between pilasters, with a cornice/ledge per floor or every few floors. Curtain-wall glass bands only on the 1-2 ids that are genuinely glass towers. So: restore the fine rhythm where the r3/r4 changes made big panes/slabs; windows framed, not dark holes. The windows reading "dark" is partly global: the light builder is lifting midtones (median 0.45→0.55) — re-check after that lands. Plaza/forecourt lots remain the other half.

## 2026-09-26 — wave 4, round 5 (builder)

**Critic (w4r4) picked the reference.** Main point: the shafts of SKY and ONYX read as coarse, flat slabs of colour with a few chunky window blocks. That was the r4 `giantBays`. The critic wanted the ref05 fine grid: framed windows with sills, pilasters and a ledge on every floor, plus a wider stepped entrance and lots that look roomier. I followed the coordinator's 19:15 midpoint note. coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- New `gridBays` + `gridLayout` helpers, modelled on the ref05 hotel shaft. Windows are laid out from the centre of each face, each one a pale frame round `ww` glass. Inside a group, windows are `gap` apart (-1 = they share a mullion frame). A pilaster `pw` wide stands `pd` proud between groups, and corner piers stand `cpd` proud. Other options:
  - `ledgeC`: a sill ledge on every floor.
  - `bandEvery`: a bolder band with a 1-out cap.
  - `sillC`: a proud sill under each window.
  - `jambs:false`: head and sill only, so the wall material shows beside the glass.
  - `recess` (glass depth) and `frameOut` (frame 1 proud).
  - **Lesson:** small panes recessed 1 went dark navy in game (AO). `recess:0` flush glass reads bright blue, and a proud or pale frame gives the relief.
- Where it is used:
  - SKY shaft: paired 3-wide windows in white frames and silver pilasters, a white ledge every floor and a band every 4 storeys. The corner piers are glass-coloured (petrol v0, teal v1). v0 had read as flat grey.
  - ONYX, all 3 stages: cream frames on jade, jade ledges, and a gold-capped band every 3 storeys.
  - Twins tier 1: head and sill frames only, so the brick shows. Brick pilasters, stone quoins and sills, and a stone band every 3. A first try with full cream frames and stone pilasters turned the twins cream. Keep the brick.
  - Spire tier 1: white frames, beige pilasters, a stone ledge every floor, and white-capped bands.
  - Deco stage 1: cream frames with stone sills. The upper stages keep their wide gold-headed bays, so the rhythm changes up the tower.
  - `giantBays` is now unused.
- `portico` (non-cochère): the first tread is now 3 deep and runs the landing's full width + 2, with a dark kerb edge and clipped shrub boxes at both ends of the landing.
- `plazaStrip`: every other bed is now a low clipped hedge instead of a tree, so the lot reads as an open paved plinth.

**Measured.** check.sh ok. Zero console errors on all 5 shots (rounds/downtown/w4r5-builder).
- Tris: gal-1 0.47M (was 0.54M), gal-2 0.64M (was 0.71M), gal-3 0.59M, one-glass-sky 0.45M, iso-mid 2.17M.
- fps 12–42 at load average ~10 (noise).
- In game, iso-mid now reads as dense framed-window grids (like the ref05 tower cluster), not slabs.

**Next.**
1. The glass office (the blue 1x1 on gal-1) is still a coarse framedBays curtain wall. It could take gridBays with teal frames.
2. SKY v1 is mostly white frames. If a critic calls it pale, colour its frames or ledges.
3. The 2x2 podiums still fill about 65% of the lot. A roomier plinth needs a smaller P box (all coordinates are hard-coded).

### Coordinator note (2026-09-26 21:45) — after w4r5: I looked at the pair; concrete targets
(rounds/downtown/w4r5-critic/pair.png) The critic compared SKY + ONYX against ref05's bank + hotel. Two measurable differences:
1. LOT: ref hotel's building covers ~50% of its lot; the front ~30% is a forecourt (steps up to a canopied entrance, lawn strips, planters, a flagpole/lamp). Ours: shaft fills ~85% to the kerb, with parked cars round the edge. Target: tower footprint ≤ 60% of the lot, set back from the front kerb; front forecourt ≥ 25% of lot depth; NO cars parked on tower lots (delete them).
2. FACADE DEPTH: ref bank = columns standing 2+ voxels proud of glass recessed between them (the recess catches shadow on one side and sky highlight on the glass); ours = flat wall with small windows flush. Target: on the podium and at least one face of each shaft, pilasters/columns projecting 2 fine voxels (res 4) with glass bays recessed between them; keep the fine window rhythm above (19:15 note), each window framed.
Also consider: ref towers are broad and mid-height (hotel ~10 storeys); a couple of our slender 20+ storey shafts could be broader/shorter to give the frame bigger readable masses.

## 2026-09-26 — wave 4, round 6 (builder)

**Critic (w4r5) picked the reference.** Three critics running (w4r3, r4, r5) agreed that the towers fill their lots to the kerb. The ref05 hotel and bank each stand on a ~1-tile footprint in a 2x2 lot, with an open paved forecourt, hedges, lawn, steps and a porch. w4r3 and r5 also said the glass reflects nothing. coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- New `hotelLot(g, P, rng, {xc, hw, fz, flags})`, the ref05 hotel lot:
  - a dark-paved, stone-kerbed walk from the kerb to the steps;
  - two lawn panels in clipped-hedge rims either side of the walk, each with a tree and flowers;
  - L-shaped hedges on the front corners;
  - side strips that are lawn with spaced trees (or a hedge if narrow);
  - a back hedge line and a service corner.
  - Everything else is left as OPEN paving: no fillLot, plazaStrip or forecourt clutter.
- New footprints for the 2x2 towers, set back toward the rear so the front ~1/3 of the lot is forecourt:
  - SKY: P 13..49 x 24..60, T 15..47 x 27..57 (33x31, was 37x32), nf 7+v (was 8+v). Sand plazaLot.
  - ONYX: P 13..49 x 24..60, stages 33x31 / 25x23 / 17x15, spire moved to z 42, lantern ins 3. Light-grey plazaLot, and the flags moved to the walk.
  - SPIRE: P 14..48 x 24..60, stages 33 / 25 / 19 wide, mast moved to z 42. The cochère drive is kept.
  - TWINS: moved back 7 (P z 21..60, T1 z 23..57). The notches, skybridge and roof garden moved with them.
  - BLOX and TECH are unchanged. BLOX still has its right-hand car park.
- On the narrower shafts, gridBays uses `pw 1` + `cw 1/2` so there are still six windows a face (3 pairs) with narrow corner piers. With pw 2 the leftover width went to 5-voxel corner slabs, which read as big dark blocks.
- New `glint(base, lit, P, seed)` glassFn: a rising diagonal band of lit panes across the whole face (dtGlassHi pane at the leading edge, then a dtGlassTeal-ramped pane), so a light streak crosses several windows. Used on SKY, all ONYX stages and spire tier 1.
- TRIED `recess: 1` (glass 2 behind a proud frame), as the w4r5 critic asked. In game, 2-3-wide panes turn into cream-jambed slits with the glass hidden in the reveal. REVERTED to recess 0. Depth must come from pilasters or ledges, or the panes must be ≥5 wide. Note: the software iso tool (scratchpad/iso.mjs) also mis-sorts recessed panes, so check recess in game.

**Measured.** check.sh ok, `_selfTest` ok, zero console errors on all 5 shots (rounds/downtown/w4r6-builder).
- Tris: gal-1 0.47M, gal-2 0.63M, gal-3 0.58M, one-glass-sky 0.47M, iso-mid 2.03M (r5: 2.17M).
- fps 25-60 at load ~7.
- In gal-2 and gal-3, the SKY, ONYX, SPIRE and TWINS lots now show hedged lawns and paving in front of the entries, instead of a tower wall at the kerb.

**Next.**
1. The SKY shaft still reads white-framed with small panes. If a critic repeats "punched windows", try frames in the pier colour (silver) and wh 8, or pd 2 fins on the lr faces only.
2. BLOX still fills its lot, with its car park on the right. Give it a hotelLot front, or move L back 6.
3. The 1x1 towers (gal-1) still fill 1x1 lots. The only lever there is a thinner shaft or a 2-voxel lawn rim.
4. hotelLot's side-lawn logic assumes nothing else sits in the side strips. Don't call it on lots with a side car park.

## 2026-09-26 — wave 4, round 7 (builder)

**Critic (w4r6) picked the reference.** Main point: SKY, ONYX and the sage slab read as extruded window grids on a thin lobby. The ref05 hotel and bank each have a separate, heavily detailed 1-2 storey base: a brick podium, a column portico, wide steps, a glass canopy and deep cornices. The critic also wanted a few balcony or ledge floors and busier roofs (AC units, water tanks, railings). coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- New `podiumTerrace(g, P, T, top, rng, {trim, cornC, pave, box, railC})` dresses the podium roof as a setback terrace:
  - a stepped cornice: dentils, then courses 2 and 3 out;
  - pale paving and a metal railing on the parapet;
  - a clipped-hedge ring with flowers in stone boxes inside the parapet;
  - trees on the front corners and down the side strips;
  - benches on the front strip and condensers on the back strip.
- New `balconyFloor(g, B, y, slabC)` adds a slab 3 out with a 2-tall glass balustrade and a steel rail.
- `streetPodium` has a new `cornerC` option. With it, colonnade corner piers use that colour (the wall) and get quoins, so a brick podium reads as brick.
- SKY:
  - The podium is now P 9..53 x 22..60, 5-6 voxels wider than the shaft on every side. The shaft box is unchanged.
  - The podium is deep brick (v1 terracotta) with a giant order of cream columns, brick corner piers with cream quoins, and a terrace.
  - Balcony floors on storey 2 and the top storey.
  - A water tank and a railing on the lantern roof.
- ONYX:
  - The podium is now P 9..53 x 22..60, in sandstone `dtLimeShade` with white trim and a gold cornice lip (v1: terracotta with cream). The shop ground floor is kept. SKY next to it is brick, so the two are distinct.
  - Added a terrace, and a jade balcony floor half way up stage 1.
- SPIRE: the podium is now P 9..53 x 24..60, 6 wider on each side (the cochère keeps the front), with brick corners, quoins and a terrace.

**Measured.** check.sh ok. Zero console errors on all 5 shots (rounds/downtown/w4r7-builder).
- Tris: gal-1 0.47M, gal-2 0.63M, gal-3 0.59M, one-glass-sky 0.49M, iso-mid 2.04M. All unchanged within noise.
- fps: 35-60 galleries, 22 iso-mid.
- In gal-2, SKY now stands on a red-brick base with cream columns and a planted terrace ledge. ONYX stands on a sandstone base with a gold lip. Each base is a clearly separate block under the shaft.

**Next.**
1. The twins and BLOX podiums still hug their shafts. The twins' T1 fronts sit only 2 behind P.
2. The SKY shaft is still white frames on silver. If a critic calls it pale, use pier-coloured frames.
3. The SKY portico could become a pedimented temple (ref05 bank). The small office and the clock tower use the temple on gal-1, so check for duplicates per page first.
4. If critics call the brick podiums "two reds", note that the spire (gal-3) and SKY (gal-2) share the brick-and-cream-column podium, on different pages.

### Coordinator note (2026-09-26 23:05) — after w4r7: build depth OUTWARD, not inward
Good call reverting recess (narrow panes become slits at iso). Seven critics now name facade depth, so build it outward: (1) full-height pilasters/piers projecting 2 fine voxels PROUD of the wall between every bay (or every 2 bays), in the trim/stone colour, on both visible faces — they throw a vertical shadow strip on the key-away side and give the "columns" read; (2) a projecting cornice at the top (2-3 voxels out, 2 tall) and a belt course over the podium; (3) the podium itself 1-2 voxels proud of the shaft above it, in a heavier material (stone/brick), with the canopy entrance. Base–middle–top must read from iso-mid. The bank: make it the broad grand landmark (ref05 bank: wide, 3-4 storeys, big portico with 4-6 columns and a pediment, broad steps). Keep the windows flush where they are (no recess).

## 2026-09-26 — wave 4, round 8 (builder)

**Critic (w4r7) picked the reference.** It looked at gal-3. What w4r5, r6 and r7 all say: the facades are flat grids with no depth. They want thicker pilasters with the bays pushed back behind them, glass reflections, and a clear base, shaft and crown. r7 also said the BANK is "a small grey box squeezed under the towers" with a faint label. coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- New `gridBays` option `ledgeIn`: the per-floor ledge stays in the bays, behind the pilaster faces. The pilasters now run unbroken from base to top and the bays read as recessed vertical strips. Before, every ledge ran out to the corner-pier depth (max(lo, cpd)) across the whole face, which turned it into a uniform floor-by-floor grid.
- Twins tier 1 follows the ref05 hotel: CREAM pilasters 2 proud (they were brick, 1 proud, and could not be seen) over red-brick bays. Windows are paired and 3 wide with a shared mullion, carry a glint reflection streak, and have a band with a gold cap every 3 storeys.
- Spire tier 1: pw 2, pd 2, cpd 3, `ledgeIn`, petrol spandrels (`spandC`).
- SKY shaft: pd 2, cpd 2, `ledgeIn`. At cpd 3 the petrol corners turned into dark masses.
- ONYX stage 1: pd 2, cpd 3, `ledgeIn`.
- BLOX: two white fins per face stand 3 proud through the floor slabs, making an egg-crate.
- TECH upper block: terracotta sun fins every ~9 voxels, 3 proud, crossing the white sunshades (brise-soleil).
- The bank is rebuilt about 25% bigger:
  - off-white stone (v1 limestone) instead of the mid-grey dtStone;
  - an 11-tall plinth and 38-tall columns, 4 per face, 7 wide and 5 deep, standing in front of a navy hall 1 behind them;
  - tall glass sheets flush in the bays, running from a petrol foot to a teal body, with two rising dtGlassHi streaks, stone transoms and a mullion;
  - a 17-tall frieze with BANK in 2x navy 5x7 letters, readable at gallery zoom;
  - a full-width pediment with a radius-6 clock, and a 35-wide stair.
  - Two things I tried and dropped: at hall inset 5 or 4, the columns hid the glass completely. A 1-deep glass reveal went dark in AO, so the glass is now flush.

**Measured.**
- check.sh ok, `_selfTest` ok, zero console errors on all shots (rounds/downtown/w4r8-builder).
- Tris: gal-1 0.47M, gal-2 0.58M (was 0.63M), gal-3 0.52M (was 0.59M), one-glass-sky 0.48M, iso-mid 2.00M.
- In game, gal-2 SKY and ONYX show deep unbroken ribs with shadow bands on the right face. gal-3 twins read as cream pilasters on red brick, like the ref hotel. TECH has red fins over dark glass. The bank is a white landmark with a big legible BANK.

**Next.**
1. The bank glass is still partly hidden behind the columns at the iso angle. If a critic wants more glass, go to 3 bays per face (columns at 8/31/54) with wider sheets.
2. The pediment's teal gable roof steps back over the attic, and seen from the back it reads as a staircase. It could stop at the attic front.
3. BLOX's white fins are white on white. Try the fins in pier navy or teal glass if a critic still calls BLOX flat.
4. A white "P"-shaped block appears at the TECH lot's front-left in the gal-3 shot. It is not in the model (the software iso shows nothing there), so it is probably another piece's prop.

## 2026-09-26 — wave 4, round 9 (builder)

**Critic (w4r8) picked the reference.** Critics w4r6, r7 and r8 agree: the shafts (SPIRE, TWINS, BLOX, SKY) read as flat, repeated window grids with pale, low-contrast glass. They want facade relief of 1-2 voxels on every floor (protruding sills and cornices, shadowed recesses) and saturated glass with highlights. r7 and r8 also called the lots sparse. coherence.md has no [downtown] items.

**Measured first (PIL, gal-3 w4r8).** On the spire's tier 1, the dominant colours were beige stone and GREY (the white frame rings on the dark face). Glass was 11% of the face against 19% on the ref05 hotel, with saturation 0.49 against 0.65. The white frame round every 3-wide pane is what made the grid read as a pale lattice.

**Changed (downtown.js only; the palette ends unchanged).**
- `gridBays` has two new options. `hoodC`/`hoodOut` adds a hood moulding over each window, 2 proud and 1 wider each side. `lugC`/`lugOut` adds a lug sill.
- Spire tier 1, SKY shaft and ONYX stages 1-3 now share one treatment:
  - frames are FLUSH and in the pilaster colour (stone / dtStone / jade) instead of a white ring;
  - each window gets a hood (white; cream on ONYX) and a lug sill;
  - panes are 8 tall (were 7);
  - the per-floor `ledgeIn` ledge is dropped, because the hoods now mark the floors.
- Tried and dropped: frameOut 1 jambs. At iso they hid about a third of each 3-wide pane, which took the spire's glass from 0.11 down to 0.07.
- Twins: I tried hoods there too, and they buried the red brick. REVERTED, so the twins are unchanged.
- `paintPane` ramp: the dark body is now 25% of the pane (was 40%), so more of each pane is lit teal. Saturation went from 0.49 to 0.58 on the spire and from 0.57 to 0.60 on SKY.
- BLOX:
  - The v0 ribbons are ramped dtGlassDeep (were flat dtGlassTeal), so the white tower now has saturated blue bands, like the ref05 hospital.
  - The 3-proud fins have teal-glass outer faces; white on white had made them vanish. Navy fins were tried first and read as dark stripes.
- `hotelLot` now ends with a moderate `fillLot` scatter: 14 props on a 2x2 lot, 6 on a 1x1, with the walk kept clear. This covers the r7 and r8 "sparse lots" notes.
- TRIED `dtGlassTeal 0x35a0b0 → 0x2a9ccc` (with materials.js nightGlassColors synced). It turned SKY v1's teal pilasters into a royal-blue slab, the same trap as w4r3. REVERTED both files. **Never shift dtGlassTeal's hue**: SKY v1 uses it as its pier colour.

**Measured.**
- check.sh ok, `_selfTest` ok, zero console errors on all 5 shots (rounds/downtown/w4r9-builder).
- Tris: gal-1 0.47M, gal-2 0.57M, gal-3 0.53M, one-glass-sky 0.47M, iso-mid 2.01M. All unchanged within noise.
- fps 50-61 in galleries, 23 on iso-mid.

**Next.**
1. Signs: r7 and r8 both call TECH, BLOX and SKY crude or blocky. The SKY roof sign is k2, about twice the letter size of the ref's HOTEL sign; k1 would match the ref's scale.
2. A white floating "P"-shaped block drifts over the gallery (seen near SKY, then over the grass). It is not in any downtown model; it is probably a life/sky prop.
3. The glass share is still about 0.10 against the ref's 0.19. The next lever is `per 3` groups or `ww 4` panes on the spire and SKY.
4. The spire's lit face picks up a lot of AO from the hoods. If a critic calls it muddy, set hoodOut to 1 beyond the frame on the lit faces only.

### Coordinator note (2026-09-27 01:25) — w4r9: identity per tower
w4r9 judged iso-mid: "a solid wall of towers that share the same blue glass + cream setbacks and reuse the same rooftop kit (AC boxes, column pavilion, lime cube planters, SKY billboards)". The demo city packs downtown densely on purpose, so the fix is per-id IDENTITY: give each of the 14 ids its own (a) material family (red brick, white stone, teal glass, bronze/dark glass, terracotta, sage…), (b) crown/silhouette (spire, stepped art-deco top, flat helipad, pyramid cap, clock, dome), (c) rooftop kit — don't reuse the pavilion/lime planters/billboard on every roof; at most one tower carries a billboard. Keep the depth work (pilasters, cornices, podium). Check iso-mid: no two adjacent towers should share material + crown.

## 2026-09-26 — wave 4, round 10 (builder)

**Critic (w4r9) picked the reference.** It looked at iso-mid and saw a solid wall of towers that all share blue glass and reuse one rooftop kit (a grey column pavilion, AC boxes, lime cube planters, SKY billboards). I followed the coordinator's 01:25 note: fix per-id identity, not the density. I left heights alone. Measured, ref05's hotel is also about 4 tiles tall. The "wall" comes from 1x1 towers packed 3x3 per block in demo-city, which is not my file. coherence.md has no [downtown] items. The white floating "P" block is tagged [ui][life] and is still present; it is not in any downtown model (checked with the software iso).

**Changed (downtown.js only; no palette keys).**
- SKY (glass-skyscraper): the grey K lantern (the "column pavilion"), the 2x SKY billboard and the water tank are gone. SKY now has its own crown: a glass drum set back 6 with a HELIPAD over it that overhangs by 3 (dark deck, yellow ring, white H, lamps), plus a 22-tall mast. The name stays on the portico.
- Billboards: HOTEL is now the only tower with a roof sign. I removed the small office's roof billboard and the BLOX and TECH roof sign boxes; their names stay on the canopies.
- Water tanks: only on the small office and the brick highrise now. The hotel and the twins' crowns get condensers instead.
- ECO (green-glass-tower): GREEN glass in every variant (dtGlassGreen / dtPad), so it has its own material family. It also gets one roof per variant: v0 trees + pergola, v1 a solar array + a small wind turbine, v2 a glass greenhouse. This id repeats about 3x in iso-mid, which is where the "same lime cube planters" came from.
- Glass office v1: the piers are terracotta instead of blue on blue. The variants are now sand, terracotta and teal.

**Measured.** check.sh ok. Zero console errors on all 5 shots (rounds/downtown/w4r10-builder).
- Tris: gal-1 0.47M, gal-3 0.52M, one-glass-sky 0.42M (was 0.48M).
- gal-2 read 0.56M on the first pass and 0.65M on the re-shoot, and iso-mid 2.00M then 2.34M. The two gal-2 frames are identical and none of my changes are in that frame, so the jump comes from another piece.
- fps 15-61 at load average ~9.
- Glass share on shaft faces is about 0.13, against 0.26 on the ref05 hotel. Glass colour is close: median (45,111,130) against the ref's (0,113,143).
- In iso-mid there is now one roof sign (HOTEL), two helipads as landmarks, green ECO towers with three different roofs, and a red terracotta glass office.

**Next.**
1. Glass share is still half the ref's. On the spire, ww 4 does not help (it only fits 4 windows). Try wh 9 or thinner pilasters (pw 1).
2. The round tower's three variants all read blue + copper in iso-mid. Give v1/v2 a stronger colour.
3. To open up iso-mid, the demo-city downtown density is the lever (coordinator call), not tower height.

### Coordinator note (2026-09-27 02:50) — w4r10: the glass is dark because of the palette mix
Count in downtown.js: dtGlassDeep (#2c5a78) ×50 + dtGlassDark (#2a4a66) ×32 vs dtGlass (#4f86bd) ×38, dtGlassTeal ×44, dtGlassHi ×74. Pane BODIES should be dtGlass / dtGlassTeal (ref05 hotel/bank glass sits mostly #376f8a–#6cb6ce, brightest panes ~#9ad2f2), with dtGlassHi as a top row / diagonal glint on most panes; Deep/Dark only for 1-voxel reveals and ONE deliberately dark-glass tower. Surface is separately adding reflection streaks to the shared glass material — don't fight it. Forecourts: w4r10 still sees "thin rims of green blobs" — pave them (light stone), with 2-4 planters, steps and a canopy, not hedge blobs.

## 2026-09-26 — wave 4, round 11 (builder)

**Critic (w4r10) picked the reference.** Critics r8 and r10 agree: tower glass (SPIRE, TWINS, BLOX, TECH) reads as flat dark-blue slots, stamped as one grid on every floor, with no reflections. They want light-cyan glass with white diagonal glints, and each tower split into zones (glazed base, shaft, crown band) that mix curtain-wall bands with punched windows. r8 and r10 also called the block-letter signs large and fuzzy. coherence.md has no [downtown] items.

**Measured first (PIL).** Pane colour was not the problem: our q50 was about #4870a0, against the ref bank's #43667a. The gaps were glass SHARE (0.11-0.13 on our shafts, against 0.51 on the ref bank and logistics block) and the glints (our q98 was #84c0ed, the ref's #cde3f1, near white).

**Changed (downtown.js only).**
- New `curtain(g, B, which, o)` curtain-wall zone:
  - one flush sheet of glass between solid corner piers;
  - each floor runs dtGlassDeep foot → dtGlassTeal → dtGlassHi head;
  - facade-wide 45° glints: a 2-wide near-white (dtFrame) core with dtGlassHi edges, plus a 1-wide companion;
  - vertical mullions FLUSH (proud ones buried the strips in AO); a transom 1 proud at each floor line;
  - an optional `spandC` band gives ribbon glazing.
- Zones:
  - SPIRE: tier 2 is stone-spandrel ribbons, tier 3 an all-glass crown cage. Tier 1 keeps the fine framed grid.
  - TWINS: tier 3 is a curtain crown on gold mullions.
  - SKY: the grid runs up to the sky garden only; above it is a curtain crown band.
  - ONYX: stage 3 is a curtain on gold mullions.
  - BLOX: the crown storey is a curtain band.
  - TECH: the upper block is a bright curtain behind its fins and sunshades.
- BANK: the 2x navy letters are gone. It now has a crisp 1x gold BANK on a navy plaque with a gold rim, centred in the frieze.
- **The palette is FULL.** `_colors` holds exactly 200 entries (indices 0-199, and 200+ are the emissive windows). Adding a key pushed infraDeck onto index 200, the warm window. I reverted it. Never add a palette key; reuse existing colours (the glint uses dtFrame).

**Measured.**
- check.sh ok. Zero console errors on all 5 shots (rounds/downtown/w4r11-builder).
- Tris: gal-1 0.47M, gal-2 0.63M, gal-3 0.52M, one-glass-sky 0.43M, iso-mid 2.02M. All unchanged within noise.
- fps: 48-61 on galleries, 27 on iso-mid.
- SKY crown glass: sat 0.61-0.67, val 0.50-0.73 (ref bank: sat 0.62, val 0.49). The glints now read white.

**Next.**
1. SPIRE tier 1 is still the biggest area of small punched windows. If a critic repeats "stamped grid", give its podium storey (the glazed base) a curtain too, or put ribbon floors every 4th storey.
2. The glints are 45° voxel staircases. If a critic calls them jagged, try slope 2 (u - 2y).
3. Lots are still the other open note (r8, r10: forecourts with canopies, benches, parking).

### Coordinator note (2026-09-27 04:00) — w4r11: gallery context fixed; your lever is base/shaft/crown
gal-downtown-* now rings the showroom with 2 tiles of low shops/homes outside its outer roads (no more "big empty grass field"; scratchpad dtfix). Your part per w4r11 (and w4r6/w4r7): every tower reads as a DESIGNED building — strong base (columns/pediment/canopy entrance, heavier material, proud of the shaft), a clear shaft whose floors are NOT all identical (a belt course every 3-5 floors, a change of window rhythm or material at 1/3 and 2/3 height, a few balconies/loggias), and a crowned top with signage (cornice + crown/spire/stepped cap). Plus the 02:50 glass palette remap and 01:25 identity per id.

## 2026-09-26 — wave 4, round 12 (builder)

**Critic (w4r11) picked the reference.** Main point: the shafts of SKY and the green tower (gal-2) are tall stacks of identical floors, with the shaft taking up nearly all of the height. The ref hotel and bank read as base, a SHORT shaft, and crown. The critic asked for a shorter middle, a bolder 2-storey base, and a change of material part-way up. coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- SKY (glass-skyscraper) now follows the ref hotel's three parts:
  - base: the brick podium, raised from h 32 to 40 (a taller giant order);
  - shaft: 3 framed storeys (was 4 + a sky garden + 2-3 curtain storeys, flush) under dentils and a stepped cornice;
  - setback: a `podiumTerrace` (hedges, trees, railing, condensers) on the shaft roof;
  - crown: 2+v storeys of all-glass curtain wall on `Tc = ins(T, 4)`, then the cornice, the glass drum and the helipad (K = ins(Tc, 5)).
  - The teal spine now runs through the setback (3 proud of the shaft, 7 of the crown).
  - skyGarden and the balcony floors are dropped from SKY.
  - Height went from 37-41 to 34-40 units.
- ONYX (dark-skyscraper): the stages are now about 4 / 2 / 2 storeys (were 5.5 / 2.7 / 2.7).
  - Stage 2 changes material: a cream-ribbon curtain (cream spandrels, gold mullions). Stage 1 keeps the jade grid and stage 3 the glass crown.
  - The podium is raised to h 40.
  - Height went from 50-53 to 45-48 units.
- Shops & Offices: 3+v framed storeys, then a main cornice with a railed terrace and planters, then a glass ATTIC set back 3 (curtain on slab-colour corners), with its own cornice and the roof kit.
- One storey off the repeated middle of glass-office, brick-highrise, green (ECO), round, deco (stages -10/-12) and twins (tier 1 -10). Clock, hotel, spire, bank and tech are unchanged.

**Measured.** check.sh ok, `_selfTest` ok, zero console errors on all 5 shots (rounds/downtown/w4r12-builder).
- Tris: gal-1 1.05M, gal-2 1.55M, gal-3 1.70M, one-glass-sky 0.44M, iso-mid 2.75M. The gallery jump comes from the coordinator's new shop/home ring round the showroom, not from the models.
- fps: 32 galleries, 27 iso-mid, 61 one-shot.
- On gal-2, SKY now reads brick base → short blue shaft → terrace → glass crown + helipad (about 30/35/35 of the height). ONYX reads jade grid → cream ribbons → glass crown.

**Next.**
1. The 1x1s (gal-1) are still about 4:1 needles. The next lever is a setback crown zone on the brick highrise / clock (same move as SKY) rather than more storey cuts.
2. iso-mid is still a wall of towers. That comes from demo-city's downtown density, which is the coordinator's call.
3. The SKY terrace hedges barely show at gallery zoom. If a critic wants a greener setback, add 2 trees on the front corners.

## 2026-09-26 — wave 4, round 13 (builder)

**Critic (w4r12) picked the reference.** Critics r10, r11 and r12 agree on two things. First, the shafts of SPIRE, TWINS and BLOX (the blue-grey slab behind the BANK on gal-3) repeat one window-and-pier grid for 10+ floors. They want base, middle and crown, a change of bay rhythm, and recessed glass bands. Second, the tower lots barely read ("thin rims with green cube bushes"; the ref has paved forecourts). coherence.md has no [downtown] items.

**Changed (downtown.js only; no palette keys).**
- SPIRE: tier 1 is now 3 framed storeys, then a double-height recessed LOGGIA (a `skyGarden` with stone columns before deep glass and a planted lip) under the tier-1 cornice. Tier 2 is 2 storeys of ribbons and tier 3 the glass cage. The stage tops are Y+86 / 119 / 147 (were 100 / 138 / 166), so the tower is 19 voxels lower. The mast is capped at top+84, so it keeps its old length.
- TWINS: the tier-2 cream-and-brick balcony checker was the same look as the shaft. Tier 2 is now a recessed LOGGIA (cream columns, gold soffit, planted lip). The twins now read: arcade podium / brick shaft / loggia / gold glass crown.
- BLOX: three banded storeys (ribbons, proud slabs, teal fins) / the sky-garden loggia moved down to storey 4 / a PUNCHED upper zone (`gridBays` triples of 2-wide windows under white hoods, pilasters 1 proud) / the curtain crown storey. The fins and slabs stop at the loggia. nf is unchanged.
- `skyGarden`: `out` now accepts 0 (it was `o.out || 4`).
- `hotelLot` (SKY, ONYX, TWINS, SPIRE):
  - the lawn panels in hedge rims are gone. Each front panel is now a stone-kerbed PAVED court in the lot's own paving (5-grid joints) with a tree in a stone pit, a flower planter and a bench;
  - the front-corner hedges are now bollards;
  - wide side strips are paving with trees in stone pits, and narrow strips get stone flower boxes instead of a hedge wall.

**Measured.** check.sh ok, zero console errors on all 5 shots (rounds/downtown/w4r13-builder).
- Tris: gal-1 0.95M, gal-2 1.41M, gal-3 1.49M, one-glass-sky 0.42M, iso-mid 2.51M.
- fps: 33-35 on galleries, 61 on the one-shot, 21 on iso-mid (load average ~7).
- In gal-3, SPIRE now reads brick base → stone grid → loggia → glass tiers. The twins show a clear loggia break under their crowns, and BLOX shows bands → loggia → punched → glass. The SPIRE and TWINS lots read as light paved plinths.

**Next.**
1. The twins' brick shaft (4 storeys) plus the arcade podium's upper storey still read as about 6 rows of the same window. A balcony floor or ribbon storey at mid-shaft would break it.
2. The gal-1 1x1s (clock, APTS, DECO, ECO) in their gallery variants are tall needles. Give them the same move: a loggia/belt at about 2/3 height, or a storey off.
3. The round tower (gal-2, iso-mid) is still a uniform striped drum. It needs a ring loggia or a band change.
4. BLOX's upper punched zone is white-heavy. If a critic calls it blank, use wider panes or a tinted wall.

## 2026-09-26 — wave 4, round 14 (builder)

**Critic (w4r13) picked the reference.** r11, r12 and r13 agree: at ref05 scale the towers fill the frame, stand shoulder to shoulder, and hide their own and their neighbours' lots. r11 also asked for a shorter repeated middle. r13 wanted windows recessed behind the piers, with brighter glass and a highlight. The "stray white voxel block" on TWINS is the transient [ui][life] white P-block (coherence.md). It is not in any model, and it shows up on open grass in my w4r14 gal-3 as well. coherence.md has no [downtown] items.

**Measured first.** At matched scale (gal-3 crop 2130x1330 vs ref05 1120x700), the ref05 hotel is about 100-115 fine voxels tall on a 2x2 lot, and the ref bank is lower still. Our body tops (v0, the gallery variant) were: SPIRE 162, ONYX 154, BLOX 130, TWINS 129 (plus spires), SKY 123. So our towers were about 1.4-1.6x the ref hotel.

**Changed (downtown.js only; no palette keys).**
- Proportions:
  - SPIRE: tiers Y+74 / 97 / 118 (were 86 / 119 / 147). Tier 1 is 2 framed storeys + the loggia, and the loggia now starts at y0+2FL+1. The mast keeps its length.
  - ONYX: stages Y+74 / 98 / 122 (were 86 / 110 / 136).
  - TWINS: top pt+76 (was 86). The skybridge moved down to pt+20 so it stays inside tier 1.
  - BLOX: nf 7+v (was 8), with 2 banded storeys instead of 3.
  - New body tops: SPIRE 133, ONYX 140 (with lantern), TWINS 119, BLOX 118, SKY 123 (unchanged).
- Facade depth:
  - Recess 1 on the shaft windows of TWINS, SPIRE tier 1, ONYX stage 1 and the SKY shaft. The pilasters were already 2 proud.
  - Cost: +0.8k tris on TWINS and about +1.5k on SPIRE. The mesher now handles 1-deep recesses cheaply.
- Glass: pane bodies moved from dtGlassDeep to dtGlass/dtGlassTeal on TWINS, SPIRE, ONYX, SKY and BLOX v0 (BLOX v0 was all Deep: "the blue-grey slab").
- SPIRE tier-1 hoods: now 1 proud (was 2). At 2 they shaded the recessed panes into navy slots.

**Measured.** check.sh ok, zero console errors on all 5 shots (rounds/downtown/w4r14-builder).
- Tris: gal-1 0.94M, gal-2 1.17M, gal-3 1.20M, one-glass-sky 0.42M, iso-mid 2.03M.
- fps: 33-37 on galleries, 27 on iso-mid (other agents running).
- On the self-made matched-scale pair (scratchpad work/pair_b.png), TWINS and SPIRE are now about 1.2-1.3x the ref hotel (were about 1.4-1.6x). More of the lots and streets show.

**Next.**
1. Our BANK is still taller than the ref bank (about 101 vs about 75 voxels). If a critic again says "towers fill the frame", lower the bank's giant order by about 1 storey.
2. The tower lots are still busy: lime cube trees in the side strips, people, the cochère taxi. The ref lots are clean paving with low hedges. Next lever: replace the hotelLot side-strip trees with low hedges or planters, and drop the podium-terrace side trees.
3. The white P-block ([ui][life]) keeps landing in downtown crops. It needs its owner to fix it.
