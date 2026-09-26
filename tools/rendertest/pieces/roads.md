# Roads & sidewalks (piece `roads`) — running notes

## 2026-09-24 — round 1 (builder)

**Changed (src/render/roads.js; one-line integration in src/render/props.js)**
- Took out all the asphalt "realism": aggregate atlas texture, blotches, patches, tar seams, cracks,
  manholes, wheel tracks, crown. Asphalt is now one flat colour plus a tight gutter contact shadow.
  The 512² atlas (and its anisotropy probe) is gone, so the road shader is much cheaper.
- New markings, all analytic + `bvStroke()` (energy-preserving AA: sub-pixel lines widen to 1 px and
  fade, so they never shimmer): white dashed centre line (hw 0.105, duty 0.52, global phase kept),
  solid yellow edge lines 0.40 in from each kerb that follow the exact kerb distance (inside a
  junction they use only the straight kerb slabs, so no orphan arcs), chunky 7-stripe zebra
  + right-lane stop bar on every junction approach, edge line cut across mouth + zebra.
  Dropped the cul-de-sac turnaround circle.
- Kerb: CURB_H 0.15 -> 0.25 so the face is 3-4 px at iso-close (visible raised edge). Face gets a
  contact shadow at its foot + crisp lip bevel; walk top is flat concrete with a slightly brighter
  0.24 kerb-stone strip and a fine joint. No slab grid/noise. props.js PROP_Y 0.17 -> 0.27 to match.
- Colours live in `PALETTE` (sRGB) + `setPalette()`. Calibrated against the lit, tonemapped frame
  (snapshot of the live tree at ~09:30): asphalt 0x2c2b30, concrete 0xbcb8c0 (slightly cool to cancel
  the warm key), paint 0xffffff / 0xffc81a.
- Furniture anchors thinned: 4-way = 2 signals (opposite corners), T = 1 stop sign on the stem only.

**Measured (iso-close, pixel column through a straight road)**
- asphalt (27,28,27) vs ref05 (22..27, 22..29, 22..27); kerb top (210,208,196) vs ref05 (211,207,199);
  kerb face ~(105,105,94), 3-4 px tall; 61 fps, 0 console errors; selfTest passes in node.

**Caveats / next**
- Palette depends on the lighting piece's exposure/tonemap. If lighting changes, re-measure the column
  (x=1300, y 560..660 in iso-close) and retune PALETTE only.
- Rain via `BV.engine.setWeather({rain:1})` showed no visible change in a shot — verify the wet path
  (uBvWet) actually ramps in the current engine.
- Street furniture models (lamp/signal/stop-sign voxels) live in props.js/models.js — the stop sign is a
  chunky red box on a pole; a slimmer model would read better at iso. Not in this piece's files.
- Consider a lighter kerb face tone on the lit side and a subtle darker band where the sidewalk meets
  a lot plinth, so kerb and lot rim separate as they do in ref05.

## 2026-09-24 — round 2 (builder)

Critic (r1) picked the reference: kerbs were thick mid-grey (~#a0a0a0) slabs, low contrast; too much
street furniture; zebras on every arm + dense dashes.

**Changed (src/render/roads.js only)**
- THIN KERB: new `SW = 0.6` sidewalk width. Cell classification is unchanged (1-unit cells, columns
  0/7 are sidewalk), but geometry goes through `cellX()` which maps cell coord 1 -> SW, 7 -> 8-SW
  (linear in between), and the shader's kerb-distance / to-carriage functions use `BV_SW`. Carriageway
  is now 6.8 wide; kerb ~6 px at iso-mid (ref05 ~9 px at 1920).
- Kerb tone: walk top is one flat bright concrete (no stone strip / joint any more, just a faint
  0.10 brighter lip). Kerb faces get an explicit darker albedo (x0.66, the "side band", like
  C.lotSide) + foot contact shadow -> light lip over dark edge = crisp block outline.
- PALETTE recalibrated against the current lit frame: asphalt 0x2a292f, concrete 0xcfccd8 (cool, to
  cancel the warm key), paintYellow 0xffe03a (lemon like ref, was orange).
- Yellow edge line moved to 0.40 from kerb (hw 0.065) — at 0.26 the near kerb's top occluded the gap
  in iso and the line touched the kerb. Gutter AO tightened (0.40*exp2(-kd*16)).
- Markings thinned: dash period 8/3 (3 per tile), duty 0.42; zebras only on N/S approaches of a
  junction (k 0/2), stop bars removed; E/W approaches just stop the centre line 1.5 short.
- Furniture: no traffic lights or stop signs at all (voxel posts read as big black hooks and cast long
  shadows), lamps every 3rd straight tile, none on bends, cul-de-sac head lamp kept, hydrant ~1/29
  tiles. Anchors pass through cellX so they sit on the thin kerb (0.3 from the tile edge).
- Program cache key -> bv-roads-v5. selfTest passes in node.

**Measured**
- iso-mid open street: kerb top ~(227-231,225-233,211-229), kerb face ~(84-100) band 2-3 px,
  yellow (185,165,20), asphalt ~(14..21,16..22,20..26) vs ref05 (22,22,22). iso-close: dark 1-2 px gap
  between yellow line and kerb, as in ref.
- 0 console errors. fps 61 on iso-close; iso/iso-mid showed 42-44 in the last run, but that coincides
  with other builders' new dense downtown models (and parallel shooters) — roads shader got cheaper.

**Next**
- Palette is still hostage to the lighting piece; re-measure the iso-mid column (x=820, y 500..560)
  whenever lighting changes and retune PALETTE only.
- Lamp posts (props.js) are still chunky; a slimmer lamp model and a per-anchor scale in props.js
  would help. Lamps sit half on the neighbouring lot plinth now that the kerb is 0.6 wide.
- Consider 1-2 zebras total per junction chosen by hash instead of always the N/S pair.

## 2026-09-24 — round 3 (builder)

Critic (r2) picked the reference: grass-side kerb read as a thin, low grey strip; wanted a wider,
raised, bright band on every edge. Stray white tick at the iso-close bend.

**Measured first:** ref05 x=1360 cross-section: kerb band 8-9 px, asphalt 56 px -> band/asphalt 0.16,
band ~(203,203,205), yellow line 1 px dark gap inside it. Ours at SW 0.6 was 0.6/6.8 = 0.09.

**Changed**
- `SW` 0.6 -> 1.0 (cellX becomes identity; carriageway 6.0) -> ratio 0.167, matches ref05.
- `CURB_H` 0.25 -> 0.35 (face ~8 px at iso-close). Integration: props.js `PROP_Y` 0.27 -> 0.37 and
  life.js `WALK_Y` 0.27 -> 0.37 (one line each) so lamps/pedestrians stand on the new top.
- Kerb face albedo x0.66 -> x0.70, foot contact shadow 0.70 -> 0.74 over 35% of the height (face is a
  mid tone, not a dark line, so the band reads as one bright raised block).
- Marking AA ramp 0.55 -> 0.45 px (crisper paint edges; still energy-preserving). Cache key v6.
- Stray tick: NOT in roads — r2-builder iso-close at the same spot is clean and r3 shots have none;
  it is a transient vertical object (vehicle/agent), bluish-grey, ~15 px tall. Leave to life/props.

**Measured after** iso-close: grass-side kerb top ~16 px bright + face; far kerb 7 px top, 1 px gap,
yellow. selfTest passes. 0 console errors; fps 31 in all three shots (baseline in the same session
40/23/31 — parallel shooters + other pieces' dense models; roads tris unchanged).

**Next**
- Lot-side: our kerb + the lot plinth rim are both near-white, so road->lot is a wide white apron;
  if critics want a crisper lot outline, the lot plinth's side band (models core.js) is the lever.
- Kerb top is warm-bright (~241,239,229) vs ref (~203,203,205); grass is also brighter than ref, so
  keep the kerb bright for separation unless the terrain piece tones grass down.

## 2026-09-24 — round 4 (builder)

Critic (r3) picked the reference: at iso-mid our streets were "a thin dark slot squeezed between raised
white sidewalks"; yellow edge lines + short dashes read as busy fragments; wanted a bold black grid.
(Note: this reverses r2's "kerb too thin" — the light band ref05 shows at a road edge is the LOT's
plinth rim, not a sidewalk. Our lots now bring their own rim, so the road only needs a thin kerb.)

**Changed (src/render/roads.js; one line in src/life.js)**
- `SW` 1.0 -> 0.35: kerb is a thin raised rim; carriageway 6.0 -> 7.3 of the 8-unit tile (+22%,
  and the white band at every road edge drops from 1.0+0.25 lot rim to 0.35+0.25). CURB_H stays 0.35.
  life.js `PED_LANE` 3.5 -> 3.825 (middle of the rim) so pedestrians stay on the kerb top.
- Yellow edge lines removed. Centre dashes: DASH_P 8/3 -> 4.0, duty 0.50 (two 2-unit dashes/tile).
- Whole-dash muting: near a junction a dash is dropped whole (by its midpoint's distance to the arm)
  instead of being smoothstep-cut, so no stub fragments at junction mouths / dead ends.
- BUG FIX, dash direction: the phase walk stored only an offset, so any tile whose local s ran against
  the chain (common at straight->bend seams) drew a MIRRORED pattern -> stub dash at bends. Now each
  tile also stores dir (+/-1) in the tile texture's alpha; shader s = phase + dir*cen.x. selfTest
  now checks direction continuity too (passes).
- Zebras: per junction, chosen on the CPU (b channel = per-arm zebra bits): ~half the junctions get
  ONE crossing on a hashed arm; zebra spans the wider carriageway (8 stripes, both ends on a stripe).
- Lamps every 2nd straight tile (was 3rd), still on the kerb rim. Cache key bv-roads-v9.

**Measured**: iso/iso-mid now read as a bold black grid framing the lots (close to ref05);
bends show perfectly regular dashes; 0 console errors from roads (one transient water.js
FLOAT_SLOTS compile error from the water builder's in-progress edit). fps 31/21/31-45 under heavy
parallel load (shader got cheaper: edge line removed). NB :8351 was resetting connections under
parallel shooters — used a private dev server on --port 8473.

**Next**
- Cars in life.js drive 1.5 off centre; with a 7.3 carriageway 1.8 would centre them in the lane.
- If critics still want more street furniture, trees/planters belong on lot edges (buildings/props).

## 2026-09-24 — round 5 (builder)

Critic (r4) picked ours but was not wowed: where road met GRASS the 0.35 rim read as "a flat hairline
white stripe ... asphalt like a decal"; wanted ref05's raised light-concrete kerb (lit top, visible
step, thin yellow line just inside); the dashed centreline curved through a bend; few zebras downtown;
lamps only. (r3 vs r4 critics contradicted on width because ref05's band is the LOT rim next to lots
but a real sidewalk next to grass — so width is now per side.)

**Changed (src/render/roads.js only)**
- PER-SIDE SIDEWALK WIDTH: a side facing open ground (GRASS/WATER/SAND/TREE/MOUNTAIN/map edge,
  `OPEN_GROUND`) gets a full sidewalk `SW_G = 1.0`; a side facing a lot/zone/road keeps the thin
  `SW = 0.35` rim. Corner islands take the diagonal tile's width (= both adjoining bands, so they
  always match). Asphalt geometry is UNCHANGED (always the thin-rim layout, no T-junctions); a wide
  sidewalk is a raised slab standing on it. Where a band changes width between tiles (lot next to a
  grass gap) the wider tile emits a small step face. Geometry rewritten in world units (`walk()`,
  `face()`); refreshTile now rebuilds the 8-neighbourhood (widths depend on diagonals).
- Tile texture repacked: g bit5 = dash direction (was alpha), g bit4 also set for BENDS;
  alpha = open-ground bits for 4 sides + 4 diagonals. Shader `bvKerbDist` is exact over side bands,
  islands and jog pieces with per-side widths.
- Kerb step: face albedo x0.70 -> x0.56 (foot shadow 0.72), concrete 0xcfccd8 -> 0xbab8c2 so the top
  is light grey (~222) not white (~243) — ref05 kerb ~203. Gutter AO 0.45*exp2(-kd*14).
- Yellow edge line back (hw 0.05), VIEW-AWARE offset: 0.24 from the kerb's visible edge. A camera-side
  kerb hides ~0.35 units of road (h/tan(elev), across the kerb at iso), which buried a fixed-offset
  line on every near-side kerb; offset = 0.24 + occlusion from `isOrthographic ? viewMatrix row 2 :
  cameraPosition-world`. Only evaluated when kd < 1.4 + AA.
- Bends: no centre line, approaches mute dashes like junctions -> clean corner boxes.
- Zebras: 3 of 4 junctions, half of those on two opposed arms; only arms leading to plain approach
  tiles; zebra spans kerb-to-kerb of its own tile (per-side widths) 0.45 clear of each kerb.
- Furniture: lamps sit behind the kerb on wide sidewalks; benches (1 in 5 wide straight sides,
  clear of the lamp); hydrants at the kerb. Tried bins: the props.js bin model is ~1.9 units tall,
  reads as a big green box -> dropped. Cache key v10. selfTest adds a widths/jog-face check.

**Measured** iso-close grass side: top ~(222) light grey band ~1 unit, darker outer face band down to
the grass, 1-2 px dark gap then yellow line on BOTH sides of the street. 0 console errors in all
shots; fps 54-61 iso-close, iso/iso-mid 30-44 (machine load avg 5-17 from parallel shooters; hiding
the road meshes did not measurably change fps).

**Next**
- Another builder now plants street trees right on the grass edge; they hide much of the new kerb in
  iso-close — worth a word with props/terrain (set trees back ~1 unit from road tiles).
- life.js PED_LANE (0.175 from the tile edge) walks the OUTER edge of a wide sidewalk; fine, but
  3.5 would centre pedestrians on a full sidewalk.
- Centre line stays at 4.0 even when one side is wide (lane 0.65 narrower there); if a critic notices,
  offset the centreline by (wR - wL)/2 per tile (needs cars in life.js to follow).

## 2026-09-24 — round 6 (builder)

Critic (r5) picked ours but not wowed: road surfaces were "big empty black areas", centre dashes few and
short, most junction mouths had no zebra or stop line, the yellow kerb line read as a "cartoon
outline"; sidewalks bare; kerb wider/chunkier than ref05's thin rim.

**Changed (src/render/roads.js only)**
- ZEBRA ON EVERY ARM: `zebraArms()` now returns every arm that leads into a plain approach tile OR a
  bend (was: 3 of 4 junctions, 1-2 hashed arms). Bends carry a crossing too (new g bit 6 = self is a
  bend; the approach loop runs for bends, still no centre line there). Only an arm running straight
  into another junction has no crossing (no tile to draw it in).
- STOP BAR behind every zebra across the incoming (right-hand, q.x > 4) lane, q.y 2.42..2.74.
  Zebra band 0.40..2.00, 0.40 clear of each kerb. Centre-line mute distance at a zebra arm 3.05.
- Junction-adjacency bits are now masked by the tile's own connectivity in the shader: an
  unconnected junction beside a straight used to mute its dashes at the wrong end and veto zebras.
- CENTRE DASHES: DASH_P 4.0 -> 3.0, duty 0.50 -> 0.68 (2.04-unit dashes, 0.96 gaps), hw 0.10 -> 0.11.
- YELLOW EDGE LINE REMOVED (whole view-aware block gone; shader cheaper).
- Kerbside parking-bay separators on mid-block straights (no junction/bend on either arm), both
  kerbs, 3 per tile at along 1.33/4/6.67, 1.15 deep. In the demo city these only land on the long
  park-side streets (every lot-side straight is a junction approach), so they rarely show.
- SW_G 1.0 -> 0.8 (slimmer grass-side sidewalk). Benches 1 in 4 wide sides (was 1 in 5),
  hydrants ~1 in 13 tiles (was 1 in 23). Cache key bv-roads-v11.

**Measured**: iso-close now shows a zebra + stop bar at every junction mouth in frame and a steady
dash rhythm on every street; iso/iso-mid read clean, no shimmer on the zebras or dashes. 0 console
errors in all shots; fps 61/37/61 (iso-mid/iso/iso-close) on a quiet run, 32/19/61 under parallel
shooter load. selfTest passes in node.

**Next**
- Bench model (props.js) is 2.4 units tall and dwarfs pedestrians; a smaller bench/bin at
  FURN_SCALE ~0.3 would let the sidewalk carry bins + benches without reading as big boxes.
- Junction interiors are still plain black squares (like ref05); if critics want more, a thin
  white box junction outline or turn arrows in the approach lanes are the next levers.

### Coordinator note (2026-09-24 11:35) — you're winning; converge, don't swing
Blind picks: r4 W, r5 W, r6 W. r5 said "too empty — add dashes/zebras/parking";
r6 (after you added them) says "zebras on every arm, fat and hard against the kerb,
chunky sidewalks — too cluttered". Stable target from ref05: calm near-black bands,
THIN crisp light kerb line + thin yellow edge line, white centre dashes, zebra
crossings on only ONE or TWO arms of the busier junctions (set back from the kerb
by a stop line), sidewalks slim. Chase "calm graphic shapes", not more markings.

## 2026-09-24 — round 7 (builder)

Critic (r6) picked the reference: junctions cluttered (a thick zebra on every arm, hard against the
kerb), sidewalks/plinths "wide, chunky mid-grey bands"; wanted ref05's calm black band with a thin
light kerb (#dcd8cc) + thin yellow edge line, crossings only on some arms, set back from the corner.

**Changed (src/render/roads.js only)**
- ZEBRAS SPARSE: `zebraArms()` -> hashed, ~1 junction in 2 gets ONE crossing on one plain-approach
  arm. `bvApproach` set back from the mouth (q.y 1.00..2.20, was 0.40..2.00), inset 0.60 from each
  kerb, 8 finer stripes (duty 0.5, was 0.58), STOP BAR REMOVED. Dash mute at a zebra arm 2.85.
- YELLOW EDGE LINE back, flush against the kerb (centre 0.10, hw 0.055). View-aware without a
  per-side branch: kdv = min(kd(p), kd(p + camDirXZ * CURB_H/tan(elev))) = distance to the kerb edge
  as SEEN on screen, so camera-side kerbs (which hide ~0.5 of road) get the line too, with no gap.
  Wraps corner islands cleanly. Only evaluated when kd < 1.2.
- KERB LIGHTER/THINNER: concrete 0xbab8c2 -> 0xcdc9d0 (lit top ~(238,240,234), neutral; 0xdcd8cc
  raw came out (249,249,202) — the key is warm/green, so the albedo must be cool). Face x0.56 ->
  x0.84 (foot 0.86). SW_G 0.8 -> 0.55. Benches off (`BENCHES=false`: model overhangs a 0.55 walk).
- Cache key bv-roads-v12. selfTest passes in node.

**Measured**: iso-close column x=620: kerb top 13 px ~(238,242,238), face ~8 px, then 2-3 px
yellow (254,218,34), then asphalt (23,25,28). 1-2 zebras per iso-close frame (was ~8).
0 console errors; fps 59 iso-close quiet, 42/27/33 under parallel shooter load.

**Next**
- The dark bottom of the kerb face is mostly the post piece's SSAO (albedo foot is x0.86 only);
  if critics call the edge heavy, ask post to cap AO on thin horizontal steps or drop CURB_H to 0.25
  (props.js PROP_Y + life.js WALK_Y must follow).
- Lot plinth rims (models core.js) are warm cream vs our neutral kerb; if they should read as one
  band, align C.lotRim with PALETTE.concrete.

## 2026-09-24 — round 8 (builder)

Critic (r7) picked ours, not wowed: "Sidewalks barely exist" (thin kerb + yellow line right beside it,
no light-concrete strip); the crossings they saw sat on lot plinths (those are the BUILDING models' own
parking-lot zebras, not ours; ours were on ~half the junctions, set back 1.0 from the mouth); square
corners without an even rim; sparse furniture.

**Changed (src/render/roads.js; one line in src/life.js)**
- REAL SIDEWALK ON EVERY ROAD: `SW` 0.35 -> 1.0 and `SW_G` 0.55 -> 1.0 (lot and grass sides equal, so
  one even rim round every block and no jogs; per-side machinery kept). Carriageway 6.0, cars at 1.5
  are now lane-centred. life.js `PED_LANE` 3.825 -> 3.5 (middle of the walk).
- WALK TOP two-tone: new `bvWalkKerbDist()` (distance to the kerb segments incl. islands) paints a
  0.2-wide brighter kerb-stone rim (x1.08) at the road edge, walk behind it x0.95. Lot plinth side band
  then separates walk from lot. `KERB_STONE` / `BV_KS`.
- Yellow line thinner + gap: centre 0.10 -> 0.17 from the visible kerb edge, hw 0.055 -> 0.04. The
  view-aware kdv now also samples the sweep at 1/3 and 2/3 (the 2-sample min notched every island corner).
- CROSSINGS AT EVERY JUNCTION, AT THE MOUTH: zebraArms(): 4-way -> an opposed pair (hashed N/S or E/W),
  T -> the stem; bvApproach q.y 0.40..1.80 (was 1.00..2.20), 0.50 clear of each kerb.
- Furniture: + one lamp on a hashed corner island of every junction; hydrants 1/13 -> 1/9 tiles.
  Tried lamps on every straight tile (picket fence of grey posts) and benches (2.4-unit model = big
  orange box on a 1.0 walk) — both reverted. Bay ticks 1.15 -> 0.95 deep. Cache key bv-roads-v13.
  selfTest: jog check expects 0 step faces when SW === SW_G (passes).

**Measured** iso-close grass side: kerb face ~75, kerb-stone rim ~(226,226,212), walk ~(199..172)
(grades darker toward the lot: post-AO), then lot rim. Crossing on the carriageway at each junction
mouth in frame. 0 console errors; fps 56-61 iso-close, iso/iso-mid 19-45 under parallel shooter load
(2.8-3.1M tris from building pieces; roads added ~0 tris).

**Next**
- The walk top shows faint blotches (SSAO/shadow noise from post) — ask post to cap AO on flat tops.
- A slimmer lamp model (props.js) would let us add furniture without clutter; benches need a ~1-unit model.

## 2026-09-24 — round 9 (builder)

Critic (r8) picked ours, not wowed. Biggest gap: street lamps were "plain grey slab pillars, as tall as a
two-storey house, on a black cube base, throwing a big dark shadow across the lanes". Also: bay ticks
read as stray marks; sidewalk muddy with a dark seam next to the lot plinth; frame slightly soft.

**Changed**
- LAMP MODEL (surgical edit in src/render/props.js, the lamp exists only for our anchors): the voxel
  lamp (1 voxel = 0.48 wide mast, 4.3 tall, dark cross foot) is replaced by `lampBoxes()`, a 4-box
  world-unit model: 0.16 light-grey pole 2.28 tall, 0.10 light arm reaching 0.56 over the kerb, a
  warm 202 head (0.26 x 0.14 x 0.40) under a thin light cap. No foot block. Both LODs share it
  (60 tris). `LAMP_HEAD_Y = 2.12`; props selfTest now checks the head box instead of the 4.2 pool.
- roads.js lamp anchors carry `bulbY` (= kerb top + LAMP_HEAD_Y) so lighting.js's night glow sits
  on the new head instead of its 4.2 default.
- Parking-bay ticks removed from the shader (calm asphalt; ref05 parks inside lots).
- LOT APRON: the "dark seam" was the terrain footing's top (LOT_Y 0.42) showing in a ~0.15 gap
  between our walk edge and the building's plinth wall (models are inset from the tile edge), dark
  olive in the plinth's contact shadow. On every side facing a lot the walk continues APRON 0.3
  under the lot at APRON_Y 0.445 (just above the footing), with a sub-pixel step face.
- LOT WATCH (real bug): buildings placed beside a road never reach roads.refreshTile(), so the road
  kept geometry computed when that neighbour was grass (widths/apron were stale). update() now
  re-checks per-tile class (open/road/lot) every 0.25 s and rebuilds only affected chunks.
- Walk top brighter/cleaner: walk x0.95 -> x1.0, kerb-stone rim x1.08 -> x1.07. Cache key v14.

**Measured**: iso-close walk ~(230,229,215) (was 199..172 grading darker), seam gone (a light grey
apron strip with faint SSAO speckle at the plinth foot remains). Lamps ~half height, slim, warm head.
roads + props selfTests pass in node; 0 console errors in iso-mid/iso/iso-close; fps 33-38 under
parallel shooter load (53 quiet baseline before changes; roads added ~0 tris).

**Next**
- The residual speckle at the plinth foot is the post piece's SSAO noise (also the "slightly soft
  frame" note is post/AA) — ask post to blur/cap AO on thin creases.
- If critics want more furniture now that lamps are slim, try a lamp on every straight tile again.

## 2026-09-24 — round 10 (builder)

Critic (r9) picked ours, not wowed. Biggest gap: the grass-side sidewalk was "too wide, flat and
washed-out beige", fading into the lawn with no crisp kerb step; dark smudge at the far-left road edge.

**Root cause (measured):** the pale band at a grass edge was 1.7 units, not 1.0: terrain.js's
`_vergeKerb` (ground r2) laid a 0.7 cream band (P.rim, rendered (250,251,216)) flush beside our
1.0 walk, and its 0.62 face + SSAO made the soft gradient into the grass. Our own outer face was the
same light tone as the top, so there was no step anywhere in that band.

**Changed**
- terrain.js (surgical): `VERGE_KERB = false` gates the `_vergeKerb` call; `_verge` bits / lot keys
  / its selfTest untouched.
- roads.js: new vertex kind `V_OUTER` for sidewalk faces down to terrain (outer faces + bridge caps),
  albedo x`OUTER_K` 0.62 on top of the kerb-face tone -> lit top over a clearly darker side band.
- `SW_G` 1.0 -> 0.7 (true open-ground side only). `cellX` now lays the asphalt out for
  `SW_MIN = min(SW, SW_G)` — with SW_G < SW the old layout left a 0.3 strip of TERRAIN GRASS showing
  at the kerb foot (lime line hiding the yellow edge line); caught in a panned shot, fixed.
- Raised terrain lots count as lots: `Roads` takes `opts.groundTop` (engine.js passes
  terrain.cellTopY, one-line integration); a grass tile with a vacant/parcel plinth (> 0.3) is a lot
  side (SW 1.0), so the kerb no longer jogs 1.0 -> 0.7 at every farm/pitch/parking plinth. The packed
  tile-texture width bits (`OG`) and `_lotClass`/lot watch use the same `_openGround` (a mismatch hid
  the yellow line under the walk). selfTest jog check now handles SW_G < SW.
- Furniture (props.js, surgical — these models exist only for our anchors): hydrant / bin / bench
  are now world-unit box models (`hydrantBoxes` 0.58 tall, `binBoxes` 0.56, `benchBoxes` 1.2 x 0.4),
  replacing voxel models at FURN_SCALE (hydrant was a 1.4 x 2.9 red totem overhanging the road).
  Old voxel furniture functions removed. roads.js: BENCHES on; a bench + bin at the back of 1 in 3
  full sidewalks per straight side, a lone bin on 1 in 5 others. Cache key bv-roads-v15.
- The "smudge" is a kerb-row tree's soft canopy shadow falling onto the road from just off-frame
  (confirmed in a panned shot) — a real shadow, left alone.

**Measured**: grass edge now = slim lit walk + grey outer face + grass, no cream verge; lot-side
kerbs continuous with the yellow line, no jogs; benches/bins/hydrants knee-high on the walk.
roads/props/terrain selfTests pass; 0 console errors in iso-mid/iso/iso-close; fps 60 iso-close quiet,
11-46 under load avg ~32 from parallel shooters (0 road chunk rebuilds over 3 s — lot watch is idle).
NB the iso-close hero building moves as other pieces change heights; this round's frame shows
mostly lot-side roads.

**Next**
- Pedestrians crossing at junction mouths stand in the carriageway (life.js) — ask life to snap
  crossings onto the zebras.
- Faint grid pattern on the lawn (terrain) and SSAO speckle at plinth feet (post) remain.
- If critics want signs: a slim world-unit stop sign/street-name post in props.js, 1 per T-junction.

## 2026-09-24 — round 11 (builder)

Critic (r10) picked the reference: every block's rim was "fat, tall cream slabs almost a lane wide ...
a chunky raised tray"; wanted ref05's thin crisp light kerb flush on the asphalt, thinner/no yellow
line; dashes "oversized and heavy". (Root cause: our 1.0 walk + 0.3 light apron stood beside the lot
model's OWN cream plinth rim, so every block had two stacked cream bands. In ref05 the lot rim IS the
block edge; the road only needs a slim kerb.)

**Changed (src/render/roads.js; one constant each in src/render/props.js and src/life.js)**
- `SW` 1.0 -> 0.35, `SW_G` 0.7 -> 0.42, `CURB_H` 0.35 -> 0.22 (walk top 0.24). Carriageway ~7.3.
  props.js `PROP_Y` 0.37 -> 0.24; life.js `WALK_Y` 0.37 -> 0.24, `PED_LANE` 3.5 -> 3.8 (kerb middle).
- `KERB_STONE` 0.2 -> 1.0: the slim kerb is one flat light tone (no 2-tone slivers).
- Lot apron: new vertex kind `V_APRON` (riser + top). Shader routes kind 4 through the TOP branch
  (no lip bevel) and tints it to the lot plinth side-band tone (y-switched albedo so the vertical riser
  and horizontal top land on similar values). Face branch / normal bevel now `kind in (1.5, 3.5)`.
  Result: rim | plinth side | dark crease | slim light kerb | yellow hairline | asphalt.
  NB the 5 px dark band directly under the plinth side is NOT ours (present with roads hidden; it is the
  terrain footing/model base) — tried APRON 0.6, no change, reverted to 0.3.
- Yellow line: hw 0.04 -> 0.028, centre 0.17 -> 0.12 from the visible kerb edge.
- Centre dashes: DASH_P 3.0 -> 2.0, duty 0.68 -> 0.52, hw 0.11 -> 0.07 (four fine 1.04 dashes / tile).
- Zebra: 7.5 -> 10.5 periods (0.30 stripes), band q.y 0.45..1.65. Bins only on >= 0.4 kerbs (centred);
  benches effectively off (need >= 0.95 walk). Cache key bv-roads-v16.

**Measured**: iso-close column through a lot-side edge: rim 18 px (246,251,220), plinth side 9 px
(~117), crease ~11 px dark, kerb top 8 px (160->220), face 4 px (~60), asphalt. iso/iso-mid: bold black
grid with hairline light kerbs, very close to ref05. selfTest passes; 0 console errors all shots;
fps 55/31/40 (iso-mid/iso/iso-close) under parallel load, 61 iso-close quiet. Roads tris unchanged.

**Next**
- The crease between kerb and lot (dark olive) is the terrain footing side/model base in AO; if a
  critic calls it a dirty seam, the lever is terrain.js footing tone (P.side) or post AO, not roads.
- Parking-lot "smudge" and pitch moire from r10 notes are shadows/terrain, not roads.
- Pedestrians still cross mid-carriageway (life.js); snapping crossings onto the zebras is life's call.

## 2026-09-24 — round 12 (builder)

Critic (r11) picked the reference: at the road/block edge we showed only a thin yellow hairline at the
foot of a tall cream plinth, with no flat sidewalk band on the road side; ref05 frames every block with a
wide, flat, light-grey rim (~#dcd8cc) and a crisp bevel. Also: asphalt darker/softer at the frame corners.

**Measured ref05 first** (x=1250, fire-station block): lot | 1 px dark | 9 px flat NEUTRAL grey
(~205,203,205) | 1 px dark | yellow | asphalt 22. At 120 px/tile that band is ~1 unit (same as r3's
0.16 band/asphalt ratio).

**Changed (src/render/roads.js; one constant each in src/life.js)**
- `SW` 0.35 -> 0.8 and `SW_G` 0.42 -> 0.8: one even, flat sidewalk band on every road edge (between
  r10's 1.0 "fat tray" and r11's hairline). CURB_H stays 0.22, so props/pedestrian heights are unchanged.
- Walk tone: new `BV_WALK_K` (0.80,0.80,0.85) on the walk field -> lit ~(216,216,211), cool neutral
  grey and clearly different from the lot's cream rim (the raw concrete lit to (251,250,236) = the
  rim's cream). `KERB_STONE` 1.0 -> 0.1: a thin full-bright lip strip along the road edge
  (~(251,250,236)) over the darker face (~130) = the crisp bevel. Apron is unchanged.
- Walk-top shadow easing (`GLSL_WALK_SHADOW`, injected after <lights_fragment_end>, guarded by
  `#ifdef CSM_MAX_TAPS`, uniform `uBvWalkSh` 0.55): on the shade side the plinth's shadow edge ran
  along the wide band as a stair-stepped shadow-map sawtooth. I tried an S-curve "crispen" first and
  it made the sawtooth WORSE, so I dropped it. Now walk tops keep 55% of the sun shadow.
- Benches allowed on walks >= 0.75 (were >= 0.95). Cache key bv-roads-v20.
- life.js: `PED_LANE` 3.8 -> 3.6 (middle of the 0.8 walk); kerbside parking `kerb` offset 0.35 -> 0.8
  on lot sides, because parked cars' baked bay boxes overlapped the wider walk.

**Measured**: iso-close column: plinth crease -> walk ramps up to a flat ~(216,216,211) -> lip
(251,250,236) -> face ~130 -> yellow -> asphalt ~(23,27,26). iso looks like a black grid with light
rims round every block, very close to ref05. selfTest passes; 0 console errors in all 3 shots; fps
41 iso-close / 23 iso / 13 iso-mid under heavy parallel-shooter load (57-61 iso-close on quieter
runs this round). The walk shader only adds a few ALU ops.
NB the demo-city layout/framing changed between runs this round (other pieces), so A/B crops at a
fixed pixel are unreliable. Compare by diffing two runs of the same build.

**Not ours / next**
- The soft asphalt darkening at the frame corners is PCSS penumbra from tall buildings (the lighting
  piece; the post vignette is 0). In one frame there was also a blotchy speckled shadow with "holes" on
  a walk beside a plinth corner. It goes away with shadow casting off, so it's a shadow-caster gap in
  the models or lighting, not roads.
- If a critic says the block edge is now too wide (walk + wide plinth rim), step SW to 0.65 before
  changing the tone.

## 2026-09-24 — round 13 (builder)

Critic (r12) picked ours but was not wowed. Biggest gap: junctions were "huge, empty areas of black
asphalt", the road edge read as "thin yellow lines at ground level", and there was no crisp raised
light kerb with a side face. Also: the zebras sat far from the corners, which left dead asphalt.

**Changed (src/render/roads.js; small constant edits in src/life.js and src/render/props.js)**
- `SW` = `SW_G` 0.8 -> 1.1: carriageway 6.4 -> 5.8. `CURB_H` 0.22 -> 0.30. Kerb face albedo x0.84 -> x0.66
  (foot x0.82), `OUTER_K` 0.62 -> 0.79 so the outer face keeps its old tone. The result is a lit top, a
  bright lip, then a shaded face on every block edge.
- YELLOW EDGE LINE REMOVED. This also drops the 4 extra bvKerbDist calls per edge fragment, so the
  shader is cheaper.
- CROSSINGS MOVED INTO THE JUNCTION TILE: new `bvJunctionZebra()` draws in the mouth band of every
  open arm, between the two corner islands (q.y 0.14..wc-0.14, 0.16 clear of each kerb, a half-integer
  number of periods of about 0.6). Four zebras now frame every crossroads and three frame every T.
  `zebraArms()` returns every arm except arms into a bridge; two adjacent junctions share one crossing,
  drawn by the lower-index tile. Tile-data b channel: on a junction tile it holds the zebra arms; on
  any other tile, bit k = neighbour k is a junction.
- STOP BARS: new `bvStopBar()` on each approach tile draws a bar across the incoming right-hand lane
  (q.x > 4, q.y 0.34..0.56). The centre line is muted within 1.25 of the mouth. The old set-back
  `bvApproach` and its zOk logic were removed. Cache key bv-roads-v21.
- life.js: `KERB` 3.2 -> 2.9, `CAR_LANE` 1.45 -> 1.25 (a bus still clears the 1.08-deep bays),
  `PED_LANE` 3.6 -> 3.45, `WALK_Y` 0.24 -> 0.32. props.js: `PROP_Y` 0.24 -> 0.32.
  Pedestrians at PED_LANE now cross junctions ON the zebras, because the zebra band is 0..1.1 from
  the tile edge.

**Measured** (iso-close column through a lot-side kerb): walk (220,220,215), lip (251,250,237),
face ~115 for ~12 px, gutter AO ~9, then asphalt ~(28,28,33). The crossroads is now a framed box:
4 zebras plus stop bars, with a ~3.6-unit black centre. At iso zoom the zebras fade to a steady
grey band, with no shimmer. selfTest passes; 0 console errors in iso-mid/iso/iso-close. fps was
16/6/21 at dpr 2 and 27/20 (iso-close/iso-mid) at dpr 1 under heavy parallel-shooter load. The
baseline run just before this round's changes was 16/8/4, so there is no regression.

**Next**
- The walk is cool (220,220,215) vs the art-direction #dcd8cc. If a critic wants warmer kerbs, try
  BV_WALK_K (0.80,0.79,0.80). Keep it distinct from the lot's cream rim.
- If a critic calls the junctions "busy", drop the stop bars before touching the zebras.
- Faint per-pixel colour noise on the asphalt (±5 per channel) is not from our shader. Check post grain.

## 2026-09-24 — round 14 (builder)

Critic (r13) picked ours, not wowed. Biggest gap: sidewalks were "wide, flat light-grey slabs" with no
paving joints, no bevelled kerb lip and no asphalt edge line; junction centres read as "big empty black
voids"; there was little street furniture. Secondary notes: muddy soft shadow smudges on the asphalt,
and few lamps or benches.

**Past-gap consensus on width:** 1.1 is "fat" (r10, r13), 0.35 is a "hairline" (r4, r11), and 0.8 got no
width complaint (r12). ref05's band is ~0.6 units. Settled on 0.7 and put the detail INTO the band
rather than changing its tone.

**Changed (src/render/roads.js; small integration edits in src/render/props.js and src/life.js)**
- `SW` = `SW_G` 1.1 -> 0.7. The carriageway is 6.6. life.js: `KERB` 3.3, `CAR_LANE` 1.5, `PED_LANE` 3.58.
- Walk top: fine 1-unit PAVING JOINTS (the grid lines inside a <1 band are exactly its transverse
  joints, which gives 1.0 x 0.7 slabs). They use energy-preserving strokes and fade out when bvPix > 0.1.
  There is also a DARK TRIM (0.05, x0.66) along the back edge on every closed side.
- KERB LIP = CHAMFER: the 0.09 lip strip's normal tilts 45 degrees toward the road (-grad of
  bvWalkKerbDist, found by forward differences on lip fragments only). The lip reads bright on sun-side
  kerbs and mid-tone on shade-side ones.
- YELLOW EDGE LINE back (centre 0.13 from the kerb as SEEN, hw 0.034). It is view-aware (the min of kd
  along the view sweep up to kerb height), now with 8 samples, because 4 samples scalloped the line
  round the camera-side island corners. It only runs where kd < |off| + 0.2. It wraps every island
  and bend like ref05.
- Zebras: a fixed 0.12..1.0 deep, inset 0.32 from each island, so the stripes reach just past the
  island corners and frame the junction box. The stop bar's lane end is also inset 0.32, and neither
  touches the yellow line.
- TRAFFIC SIGNALS: props.js `trafficBoxes()` is a slim world-unit model: a 0.14 dark pole, a 1.9 mast
  arm, and a black head with a yellow backboard and R/A/G lenses facing local -X. It replaces the voxel
  model for both LODs (the old trafficLightModel was removed). roads.js places one per arm on the
  island at that arm's right: an opposed pair (hashed) at a crossroads, two at a T, and a lamp on a
  free island.
- Lamps now go on EVERY straight tile (alternating sides). Benches (+bin) go on walks >= 0.65, on half
  the straight sides; lone bins on 1 in 3 others.
- Asphalt shadow easing: `uBvRoadSh` 0.72, in the same post-lights splice as the walk (`uBvWalkSh`).
- Cache key bv-roads-v22.

**Measured**: iso-close shows a slim lit kerb with a bevel highlight, visible slab joints, a crisp
yellow line wrapping every island, and 4 zebras plus 2 signals per crossroads. iso and iso-mid read as
ref05: a black grid, a thin light kerb and a fine yellow edge line, with no shimmer. roads and props
selfTests pass. There were 0 console errors in all shots. fps was 29/13/6 (dpr 2) and 28/28 (dpr 1)
under load avg ~7 from parallel shooters. fps is dominated by other pieces' tris (2-4M), so I could not
attribute a cost to this piece.

**Next**
- If a critic calls the junctions busy, drop the stop bars first, then the signal backboards.
- Signal lenses are non-emissive. At night, a red/green glow (lighting.js pool at the head) would be
  a nice touch.
- The parked-car bays in life.js are 1.08 deep from KERB 3.3. Check that a bus at CAR_LANE 1.5 still
  clears them (the visual check looked fine).

## 2026-09-25 — wave 2, round 1 (builder)

Brief: converge. coherence.md items tagged [roads]: bridge deck mid-grey vs near-black road; neutral
near-black asphalt (not blue-grey); junctions not oversized-empty; slim lamps with arm + warm head.

**Measured first**: the light/post chain has drifted since r14. PALETTE.asphalt 0x2a292f now renders
BLUE-GREY (39,40,44) in iso-mid/iso-close (ref05 (22,22,22)). Live sweep in the iso-close frame via
`BV.engine._roads.setPalette({asphalt})` (scratchpad rounds/roads/tools/sweep2.mjs, play.mjs harness):
0x1a1a1a -> (24,25,23), 0x1e1e1e -> (27,28,26), 0x1e1d1f -> (23,23,24), 0x202020 -> (28,30,27),
0x222222 -> (32,34,31), 0x221f1d -> (48,45,37), 0x262422 -> (58,57,46). The grade is STEEP and hue-
twisting this close to black (~8x gain, warm/green push), so a hair of blue in the albedo neutralises.

**Changed**
- PALETTE.asphalt 0x2a292f -> 0x1e1d1f. After: dominant asphalt bin (21,21,21) in iso-mid and iso,
  (21-24) in iso-close = ref05 exactly, neutral.
- BRIDGES DRAWN BY ROADS.JS: `_isDrawn()` no longer skips state.bridge tiles; tile data includes them
  (dash phase runs straight across the water); zebraArms still skips arms into a bridge; a bridge tile
  gets lamps only (no bench/bin/hydrant) and no outer kerb faces (new `_isBridge`).
- infra.js `bridgeModel` is now only the structure: deck slab top at -0.05 (BR_DROP 2.75 -> 2.80,
  hidden under our asphalt), lot-side band, girder line, piers, and a one-voxel light parapet column
  (C.lotRim, -0.05..0.70) on each open side = the bridge's edge. Its own asphalt/markings/walk removed.
- water.js (surgical, 2 lines): the pool wall on a bridge tile tops at -0.03 (was 0.03, poked through
  the road as a dotted line at the shore seam) and the centre pier tops at -1.0 (was 0.05: its edges
  drew a "V" on every bridge tile's asphalt). water/roads/models selfTests pass.
- Lamps: already slim world-unit (pole + arm + warm 202 head) since r9 — verified, unchanged.
- Junctions: left as the r13/r14 framed box (4 zebras + stop bars + 2 signals). Nothing new added;
  the ref05 junction is plain black, and critics have swung on clutter here.

**Measured after**: bridge (play.mjs + tools/bridge.mjs): the street continues across the water with
identical asphalt, dashes, yellow line and kerbs, no seam; light parapet + band + piers read as a
bridge. iso-mid/iso/iso-close: 0 console errors. fps 7/1/2 this run (load avg ~40 from 13 parallel
builders; baseline run the same session 25/2/17) — roads adds ~0 tris (bridge tiles are 2 quads more).

**Next**
- If a critic says the near-side bridge parapet reads as a tall cream slab, drop BR_PAR1 13 -> 12
  (top 0.45, just a lip over the 0.32 walk).
- Re-sweep the asphalt whenever light/post change: the grade near black is steep and hue-twisting.
- Sand-deck slab beside a bridge end and the basin notch are water/ground's (coherence #2).
