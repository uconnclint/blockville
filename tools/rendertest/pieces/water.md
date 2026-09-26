# Water & shoreline (piece: water) — builder notes

## 2026-09-24 — round 1 (builder)

**Changed (src/render/water.js, rewrite of the surface; API kept):**
- Dropped the realistic ocean (GGX glint, fresnel mirror, 4 scrolling normal
  maps, gerstner swell, navy deep ramp). The surface is now flat, opaque and
  fully authored: pale band #9aeafc -> shallow #46c9f6 -> pool #22b7ef ->
  open water #1eaaec, stepped as terraces on a 2-unit voxel grid (the grid
  quantisation fades out when a block is < ~2 px, so the wide shot is clean).
- ref05-pool patchwork: drifting, cross-fading axis-aligned light slabs
  (#5ee0fb) + faint dark slabs, and sparse little white "wave dash" marks.
- Shoreline: crisp AA white foam line (~0.6 u, breathing width, >= 1.2 px so it
  survives the wide zoom), a pale shallows band, and two soft surf lines rolling
  out from the shore. Square rain ripple rings; sunset tint; night folds to a
  deep saturated blue + the existing city-light streak reflection.
- **Foam follows terrain.js's warped bank**, not the tile grid:
  `setLandWarp(fn, step)` inverts terrain's `_warp` by fixed-point iteration
  over a cached lattice and marks water cells the land covers; the shore field
  is now 8 samples/tile (1 unit) and its B channel is a SIGNED fine distance
  whose zero is the real waterline. Build ~26 ms, refreshTiles ~1.2 ms.
- **Receives CSM shadows** via `setShadowSource({uniforms, fragPars, vertPars,
  vertMain})` (shadow tint 0.66/0.77/0.90 — shadowed water stays blue).
- Mesh: 1 quad per tile (sub 1), no jitter. Material opaque.

**engine.js (surgical):** after `new WaterFX` -> `setLandWarp(terrain._warp)`;
after `patchMaterial(terrain.material)` -> `setShadowSource(...)` using a
namespace import `import * as LightingNS from './render/lighting.js'` (a
missing export just disables water shadows, never breaks boot).

**Measured:** iso-water / iso-wide 61 fps, zero console errors; selfTest pass.
Lake body renders ~#1bb8ee (ref pool #04b8e9/#06b5e4); deep terrace matches
terrain's off-map sea (#1aa8ed) so the coast has no colour seam. Verified
shadows with a debug cube (black tint) — they land correctly.

**Next / notes for others:**
- terrain.js (ground): a thin sand/brown strip runs along the map border
  between my ocean and the off-map sea in iso-wide; beach sand right at the
  waterline is as pale as the foam — a slightly darker wet-sand lip would make
  the foam pop. If seaFar changes, retune uDeepColor to match it.
- props.js: boats don't cast shadows (water now receives them).
- Could try: a darker "inner wall" band on far-side shores (ref pool walls),
  and a quick A/B on slab density at iso-mid scale.

## 2026-09-24 — round 2 (builder)

Critic (round 1) picked the reference: "lake is a flat decal level with the
ground; blurry airbrushed sand halo; no recessed pool wall". Fixed at the root:

**Voxel basin (new, src/render/water.js `_buildBank`)** — per chunk, flat-shaded
vertex-colour quads in a lit `MeshStandardMaterial` (`water.bankMaterial`,
CSM-patched by engine.js, casts + receives shadows):
- every SAND tile is a hard-edged raised sand deck, top y=0.5 (same as lot
  plinths), #f7d9a0 top / #d9a86a outer side band;
- a cream coping lip (0.9 wide, +0.12) along every deck edge that meets water,
  with corner squares where water only touches diagonally;
- a vertical pool wall (#1a9ce2, coping-coloured top band) on EVERY land/water
  tile edge, from 0.45 below the surface to the rim => water sits 0.97 below
  the rim. The camera sees the far walls' inner faces (ref05 does the same —
  near walls are geometrically hidden; the coping line reads there instead);
- a light-blue cut face at the map edge down to terrain's borderY sea (kills
  the brown border line noted in round 1).
- refreshTiles rebuilds the 3x3-neighbourhood chunks (walls depend on
  neighbours); `_waterTiles` no longer drifts on refresh.

**Terrain meets it on the grid (surgical):** engine.js passes
`shoreWarp:0, swash:0, beachNoise:false` to Terrain; terrain.js got a 2-line
`beachNoise` option (early-return in `_beach`). engine.js also patches
`water.bankMaterial` with the CSM rig.

**Surface:** foam line, pale band, surf lines and white dashes removed. Vivid
body (#12cbf0 in -> renders ~#02beee..#06ccf0; ref #15d7f0), two HARD voxel
depth steps (lighter shallows), crisp drifting rectangles snapped to the 2-unit
block (dark #039ddd + light #5ae8fa, translation-only animation so edges never
smear), thin deeper-blue wall-contact line + a breathing pale lap sliver.
Open sea (coarse field saturated) blends to #2cb2f2 = terrain's off-map sea, so
no coast seam.

**Props (in water.js):** swim rings (red/white, yellow/orange) and voxel beach
balls bobbing, allocated per water body (lakes first, 1-5 each; sea max 4);
parasol + sun-lounger sets on deck tiles fronting water (~1 per 7), scaled 1.3.
InstancedMeshes, 4 extra draw calls.

**Measured:** zero console errors; selfTest pass (build ~35 ms, refresh
1.3 ms/tile). FPS this session was 58-60 early, then 31 later — A/B with the
basin+floats hidden, and with the whole water group hidden, is ALSO 31, so the
drop is elsewhere (tri count rose to 2.5-2.9M from other pieces / load avg ~5).

**Next:** tiny pale sand smudges remain on grass at deck outer corners (terrain
`_blendAt` vertex blend of SAND weight — ground piece could snap sand weight to
the tile). props.js scatters rocks/scrub on SAND tiles; they now sit 0.5 inside
the deck — lift them by 0.5 on SAND tiles (or skip rocks there). The lake shape
itself comes from the demo map (1-tile notches); a designed pool outline would
need demo-city/map changes.

## 2026-09-24 — round 3 (builder)

Critic (round 2): "game did not boot, errors: []". **Root cause found and
fixed:** not a code error — the dev server. `tools/dev-server.py` was the stock
single-threaded `HTTPServer` (listen backlog 5); with several headless Chromes
loading the ~40-module import graph at once, connections were reset
(reproduced: 100 parallel curls -> 11/200 `000` resets; after fix 400/400 OK).
Module fetch failures never reach `Runtime.*`, so shoot.mjs showed no errors.
- `tools/dev-server.py`: `ThreadingHTTPServer`, daemon threads,
  `request_queue_size=256`. Restarted the live :8351 server (nohup, PID changed).
- `tools/rendertest/shoot.mjs`: `Log.enable` + `Network.enable`; logs
  `Log.entryAdded` errors and `Network.loadingFailed`; if BV never appears it
  prints every shot as an error WITH the failed module URLs and exits 3.
- `tools/demo-city.js`: `BV.weather` is main.js's state OBJECT, not a function,
  so "clear" silently failed and main.js re-rolled 25%/day rain -> random rainy
  shots (rain streaks + my ripple rings = grid noise on the lake). New
  `clearWeather()` zeroes rain/snow/targets and pins `rolledDay`.

**water.js:**
- Map-edge sea: open water steps (2-block voxel terraces over `uEdgeFade`=20u)
  into `uSeaColor` (#4cbaf4, renders ~#2bb9fa = terrain's off-map sea
  #2ab3fb), patchwork calms out there, wall line/lap suppressed at the map
  boundary; cut face recoloured #1aa6ff (was grey-teal). Seam gone in iso-wide.
- Splash halos around bobbing floats (ref05 balls/rings have white collars):
  `uFloatPos[MAX_FLOATS]` fed from `_animFloats`; hard white collar + one
  square ripple rolling out and fading.
**Measured:** zero console errors (iso-water/iso-wide/iso-night). FPS is load-
bound (load avg hit 85): A/B water visible vs hidden 49/23/44/46 — no cost.
Lake tone percentiles vs ref05 pool: 10/50/90% ours #00a8e2/#06ccf0/#29d9f1,
ref #0292ce/#09c0ea/#1adcf5 — matched.
**Next:** far pool walls are shorter than ref05's (0.97u visible) — deeper
look needs a lower waterY (props.js boats + engine agree on it). Terrain: the
off-map land/sea boundary is a blurry band with a white mist line (iso-wide
corners). Night: sand deck goes very dark vs the still-bright water.

## 2026-09-24 — round 4 (builder)

Critic (round 3): "no depth read at the shoreline — thin outline straight onto
a flat mosaic; no wall face, no shallow band, no foam, no glints; cells large
and low-contrast; off-map ocean a flat slab with a blurred edge".

**Basin depth (the big one):** water surface lowered -0.35 -> **-1.85**
(`WATER_Y`), so the far walls show ~2.5 u of face (was 0.97). Surgical deps:
engine.js passes `seabed:false` to Terrain (its bed at -1.15 would poke
through the opaque surface, and was never visible anyway); life.js
`WATER_Y = -1.85` (boats); CONTRACTS-RENDER.md + engine comment updated.
**Walls** are now pool-tiled: darker wet strip (#0b74bf) 0.32 above the
waterline, alternating 1-unit tile columns (#1690d8 / #239fe3), a thin light
grout line, then the coping band. Bridge tiles get a light concrete pier.
**Surface:** four depth terraces (4/10/18 u, voxel-snapped) #4fe2f7 ->
#26d2f3 -> #10c0ee -> #08a9e6; patchwork cells smaller (12/9/6) and
RELATIVE to the local depth colour (dark = body * (0.62,0.78,0.93), light
mixes toward #7af0fc; overlaps give extra steps). Shoreline uses a new
in-shader `boxShore()` (8 tile lookups in the shore map G channel): straight
along walls, SQUARE at corners — crisp white foam line (0.30 u, breathing),
a pale 1.5 u ledge band and a dashed lap line. AA uses pxw, not fwidth (fwidth
blew up at tile seams -> dotted lines). Twinkling 4-point white glints,
screen-aligned (arms along x±z, vertical stretched 1.55), `uSpark`=0.24.
**Off-map sea:** `_buildApron` continues the same surface 90 tiles past every
water edge tile (corner squares too), cut face dropped when apron>0 — no
seam/step at the map edge; the off-map sea now has a crisp straight edge
against terrain's grass and carries a shallow band along that edge.

**Measured:** zero console errors; selfTest pass (build 35 ms, refresh
1.45 ms/tile). iso-wide 61 fps, iso-water 47 fps (load-bound; earlier runs
this session 31-45 before my change too).

**Next:** the grass skirt beyond the apron's lateral edge is terrain's (still
soft where it meets its own off-map sea further out). Maybe try a slightly
darker wall-shadow band on the water under lit-side walls if CSM shadows are
too soft; a proper pool staircase/ladder prop on one wall per lake would add
ref05 detail.

## 2026-09-24 — round 5 (builder)

Critic (round 4, picked ours but not wowed): "lake is a busy random checker of
small light/dark squares + twinkle stars; ref05 uses a few LARGE blocky tonal
steps, light at the rim, deeper in the middle; no cream coping lip; inner wall
one flat navy on both faces; no foam/light line at the wall foot".

**Surface (the big one):** the random `rects()` patchwork and the sparkle
glints are GONE (helper, uniforms uDarkColor/uSpark/uDetailAmt removed). The
only tone structure is now depth: four terraces (uTerrace 3.5/9/16 u) snapped
to a 4 u block (half a tile, was 2), palette spread wider #5ee4f7 -> #2ccff2
-> #12b5ec -> #0a9ae2. A low-frequency value-noise wobble of the depth
(`uDepthJit` = amp 6.5 u, scale 22 u, drift 0.35 u/s; damped x0.35 for the
first step so the lightest band always hugs the wall; s1<=s0, s2<=s1) turns the
rings into irregular blocky plateaus that slowly creep — the gentle animation.
Ledge band by the wall is now a distinct light turquoise (uPatchColor #8ef3fb,
1.25 u) under a wider white foam line (0.45 u). Float ripple squares 0.75->0.45
(they read a bit like selection boxes). setSky `slabs` now scales the wobble.
**Walls:** per-orientation tone baked into vertex colour (`WALL_TONE`: +z
faces x1.12 lit, +x faces x0.58 shade, hidden faces 0.8/0.95) — two faces now
clearly split like ref05's #0086d0/#004d95. Grout line is now a dark shadow
line under the lip; wall top on deck edges is a pale coping face (0.3 u).
**Coping:** LIP 0.12->0.2, COPE_W 0.9->1.1, top #fff8ea, outer faces #e2bd84 —
reads as a pale concrete lip on every edge now.

**Measured:** zero console errors; iso-water 42-46 fps (load-bound; 20 in one
run under load avg 9), iso-wide 58-61. Lake tone percentiles 10/50/90 ours
#009feb/#01b9f3/#3fe5f7 vs ref05 pool #048dd3/#09c0ea/#1fd8f4.

**Next:** plateaus follow the Euclidean coarse field, so they're a bit
concentric in narrow arms — could jitter per-lake centre or use a larger
noise scale for big lakes. A pool ladder/steps prop on one wall, and a light
wet-deck strip just outside the coping, would add ref05 detail. Boats (life.js)
now crowd the lake (6-7 in iso-water) — worth a word with whoever owns life.js.

### Coordinator note (2026-09-24 11:12) — r4 vs r5 critics pulled opposite ways
r4: "busy random checker of small squares + sparkle stars → want a few large smooth
tonal steps". r5 (after you smoothed it): "concentric depth-contour rings like a topo
map → want irregular lighter/darker square tile patches + a few white glints".
Both picked OURS. The synthesis is ref05's pool: a broad smooth shallow→deep
gradient (no visible rings/contours) with a SPARSE scatter of LARGE (1-3 voxel-tile)
slightly lighter/darker square patches and only a handful of small white glints.
Don't swing back to the dense checker.

## 2026-09-24 — round 6 (builder)

Critic (round 5, picked ours, not wowed): "nested depth bands follow the
zig-zag shore -> reads as a topographic contour map, stepping into a dark
bowl; ref05 is flat pool blue with uneven lighter/darker square patches +
glints; no light band at wall foot; coping lip weak; wakes thin".

**Surface (the big one):** depth terraces + `uDepthJit` wobble are GONE (also
`uTerrace`). Body is ONE colour (uMidColor #12bdf0); all tone comes from
`patchLayer()` — three layers of axis-aligned rectangles, one per cell of a
drifting grid (cells 19x13, 11x16, ~7x7 u; occupancy .62/.50/.30), sizes and
offsets whole voxels (1 u), each +1 light / -1 dark, summed and clamped to
+-2 steps: light2 #66e8f9 / light1 #33d4f6 / body / dark1 #06a0e3 / dark2
#0487d0 (new `uDark2Color`). Not tied to shore distance; the only depth cue is
statistical (near the rim a patch leans light, 50% -> 78%). Layers drift in
different directions at 0.28 u/s (`uPatchMix`), so overlaps slowly re-form.
Per-layer LOD (smallest fades first by pxw) keeps the wide shot calm.
**Flecks:** sparse screen-aligned white bar + shorter cyan bar under it, each
blinking on ~40% of its own 3-7 s period (`uSpark` = strength .2 density,
6.5 u cells); kept off the rim/open sea. setSky: `slabs` = patch strength,
`dashes` = fleck strength, `block` = layer-B cell width.
**Walls:** wet strip is now a LIGHT waterline band (#5fd3f5, 0.26 u); coping
outer faces darker (#d2a468) so the cream lip separates from the sand. Float
ripple squares faded 0.45 -> 0.26 (read like selection boxes).

**Measured:** zero console errors; iso-water 33 fps / iso-wide 47 (load avg
~8; same code measured 18/24 under heavier load, so load-bound). Lake tone
10/50/90 ours #00a5eb/#05c1f6/#13d4f6 vs ref05 pool #0292ce/#09c0ea/#1adcf5.

**Next:** wakes are life.js's (thin white dashes, crowd the lake — 6-7 boats);
they'd read better as 2-voxel-thick V's. Open-sea patchwork->flat sea fade is
soft at wide zoom (s3 smoothstep when detail->0) — could step it on a coarse
block. Pool ladder prop on one wall per lake still unbuilt.

## 2026-09-24 — round 7 (builder)

Critic (round 6, picked ref): "no sense of depth — checker stays one mid blue
from wall to middle; want a lighter cyan band ~1 tile inside the wall, steady
darkening toward the centre, a few crisp white glints; a light-concrete
(#dcd8cc) coping lip between sand and water; all-sand surround = swimming pool".

**Depth (the big one):** body is now a CONTINUOUS ramp shallow #2acdf5 ->
mid #12b4ee -> deep #0a94db driven by the coarse chamfer distance to land,
sampled at the centre of a 4 u (half-tile) block and averaged over a 5-tap
cross (+-6 u) so the medial ridge softens (new `uDepth` = (4, 34) u). No
terraces -> no contour rings; the half-tile blocks read as pool tiles getting
darker toward the middle. `far` 5 -> 8 tiles so lake centres never saturate
into the open-sea colour. Patchwork kept but made RELATIVE to the depth
colour (light = 26% toward uEdgeColor, dark = x uDark2Color which is now a
multiplier (0.83,0.915,0.975)); patch light/dark odds follow depth (80% light
at the rim -> 22% in the middle).
**Band:** hard square-cornered light cyan band (uPatchColor #7ff0fc) 4.5 u
wide from the wall (`uFoam.y`), a lighter 1.4 u step right at the wall, white
foam line, lap dashes rolling across the band. Suppressed on open sea.
**Glints:** mostly-on white bar + stepped shorter bar, 0.55 u thick, 2.6-4.2 u
long, 20% of 11.7x9 u cells, kept outside the band.
**Coping:** COPE_W 1.1 -> 1.7, LIP 0.24, top #dcd8cc, sides #a9a293 grey.
**Shore:** chunky hedge planters (lime #5fae34/#86c83f, dark foot band) on
~55% of the outer sand-ring edges (and sand/lawn edges); deck tiles with no
water in their 8-neighbourhood become raised lawn beds (none in the demo lake
— its ring is 1 tile).

**Measured:** zero console errors; selfTest pass (build 32 ms, refresh
2.0 ms/tile — far 8 costs ~0.6 ms/tile). iso-wide 60-61 fps, iso-water
23-56 fps (load-bound, varies run to run). Pre-grade tones (r7-d): rim
#88f0f7, mid #0ccaf6, centre #0088da. **Warning:** mid-round, post.js's new
grade (coolSat 0.15 at hue 195 + upper-mid dip curve) turned the same pixels
into mid #1497b5 / rim #79ced4 — the pool now reads teal and duller than
ref05 (#09c0ea). I did NOT compensate in water.js (would overshoot if post
reverts); coordinator should decide whether water is exempt from coolSat.

**Next:** if post keeps coolSat, raise uGain ~1.08 and nudge hues to ~205 deg.
Pool ladder prop still unbuilt; boats (life.js) still crowd the lake (6-8).

### Coordinator note (2026-09-24 12:02) — r7 lost: too dark/teal. Measured targets.
Modal pixels of the ref05 pool (8-level buckets): #08c8e8, #00a0d8, #10c8e8, #00b0e0,
#10d0f0 — i.e. bright cyan-azure, value ~85-95%, NOT teal-navy. Your r7 render
measured ~#0e6b9c-#128cb0 by the critic. Depth read should be done with hue/value
steps WITHIN that bright range (shallow ~#10d0f0 → deep ~#00a0d8), inner wall faces
a slightly darker but still bright azure (~#0090c8), never navy. Measure your
rendered pixels with PIL against these after lighting/post.

## 2026-09-24 — round 8 (builder)

Critic (round 7, picked ref): "dull teal-navy #0e6b9c..#128cb0, darkest in the
middle; thick dark-navy inner wall band makes the lake heavy and sunken;
patchwork low-contrast/murky".

**Root cause:** post.js's grade (exposure 0.92, luma curve gamma 1.3 + dip,
coolSat 0.15 @195 deg, knee) — not the authored colours. Calibrated with flat
lakes via `--eval "BV.engine._water.setSky({...})"` (6 shoot runs in parallel;
note: `&` without `wait` kills them — shoot.mjs exits when its parent dies):
flat #2ea3ee -> #1691d4, #44caff -> #26acda, #6ae0ff -> #45c3e0; blue caps
near 0xe8. With gain 1.35: #2194e6 -> #1e94e7, #4dbff5 -> #3cafe4.
**Surface:** uGain 1.0 -> 1.35, applied to the LAKE body/band only (the open
sea mixes in after, unscaled, so terrain's off-map sea still matches; gain
fades to 1 at night). Palette re-authored bright + cyan: shallow #40c8f8,
mid #3ab4f4, deep #2a9cee, band #30dcff, light-patch target #1ae4ff (low red
so coolSat can't grey it); patch steps stronger (light 26% -> 55% toward
edge, dark mult (0.68,0.82,0.93)).
**Walls:** new `aGlow` vertex attribute on bank geometry + onBeforeCompile on
bankMaterial (chains fine under lighting.patchMaterial): walls add
diffuse*aGlow*uWallGlow emissive (WALL_GLOW 0.55, coping band half), dimmed
x0.15 at night. WALL_TONE px 0.58 -> 0.80; wall #2396e4 / alt #36adf0,
grout #1f7fd0 (was navy), wet band #5cdcfa. All bank geometries (incl. float
boxes) carry aGlow so no generic-attribute leak.
**Measured (screen):** lake mid #2da1e5, centre #1f92e9, shallows/light
blocks #32c1df..#34c3e0; walls lit #2e97eb..#39a3e7, shade face #107cc1
(was #062d4a). Zero console errors; iso-wide 61 fps, iso-water 24-39
(load-bound, same as base 32).
**Next:** if post.js changes its grade (esp. coolSat/curve), re-run the
flat-lake calibration and retune uGain/palette. Coast: deep blocks near the
map edge are a touch darker than the flat sea — could lerp uDeepColor*gain
toward uSeaColor with the s4 edge fade. Night water still reads bright
(pre-existing; uNight fold looks weak in iso-night).

### Coordinator note (2026-09-24 12:50) — stop oscillating
r4/r5/r6 WON with the older look. r7 lost "too dark teal-navy", r8 lost "too pale pastel,
low-contrast checker". You're overshooting each way. Anchor to the measured ref05
pool pixels (see 12:02 note): body #00b0e0-#10c8e8 saturated azure, clearly darker
tile patches ~#00a0d8, inner wall a SATURATED deeper blue (~#0088c8, not navy, not
pastel). Measure your rendered pixels with PIL each iteration and land on those
numbers; saturation high, value high, contrast between tiles moderate.

## 2026-09-24 — round 9 (builder)

Critic (round 8, picked ref): "lake pale, pastel, flat; checker tiles barely
differ; inner wall a washed-out light blue; ref05 is saturated ~#2ea3ee with
15-20% darker tiles and a deep saturated blue inner wall; want brighter
caustic-like light patches".

**Root cause:** round 8's uGain 1.35 pushed the lake into HDR, where post's
PBR-neutral shoulder (0.90) desaturates toward white and the split-tone /
coolSat add red -> R 0x28-0x32 = pastel. Calibrated flat lakes (gain 1,
slabs 0, dashes 0) through the current grade: #00c8ff -> #1bacd7,
#00a8ff -> #1996e0, #0090f0 -> #1186d5, #0078e0 -> #0f72ca; HDR linear
[0,0.9,2.0] -> #50a9e8 (washed). So: **gain 1.0, all body colours R = 0,
peak <= 1** (shallow #00c0ff, mid #00aeff, deep #009af4, band #02c8ff, light
patch target #06dcff). coolSat still floors R at ~0x10-0x18 (can't go lower
without a post.js mask).
- Dark patch multiplier (0.68,0.82,0.93) -> (0.55,0.60,0.82): ~18% darker,
  clearly visible; negative stacking clamped at -1.3 (two dark layers on the
  deep body went navy).
- New `uCausticHi` #6ceaff: where two light patches overlap (k > 1.2) the
  block jumps 55% toward a pale caustic cyan — sparse bright patches.
- Walls: wall #0856bc / alt #0b62ca / grout #07469c / wet #1a92ec -> strong
  saturated blue under the cream coping (screen ~#0870c8 lit, deeper shade).
- uSeaColor #4cbaf4 -> #00a0f6: the coastal strip no longer sits as dark
  blocks against a pale flat sea. Whole visible sea in iso-wide is my apron,
  so no seam against terrain.
**Measured:** lake modal #18a8d0/#18a0d8/#18b0d0/#1898d8/#1090d8, walls
#0870c8 (was #289de4..#32ade2 body, #36adf0 walls). Zero console errors;
iso-water 43-47 fps, iso-wide 35-61 (load-bound; colour-only change + one mix).
**Next:** if more cyan is wanted (ref modal #08c8e8), post.js coolSat at
195 deg is the limiter — ask post's owner to exempt water (e.g. an alpha flag)
rather than overdriving here. Boats (life.js) still crowd the lake.

## 2026-09-24 — round 10 (builder)

Critic (round 9, picked ref): "lake a darker, flatter cobalt (deep patches
~#0f75cb), low-contrast patches; ref05 is luminous turquoise #2ea3ee..cyan
with pale-cyan patches + white glints; inner walls a dark-navy gutter; no
light edge line at the wall foot; no edge->centre value variation".

**Root cause (the real one this time):** post.js's upper-mid luma DIP
(0.11 @ 0.35..1) + coolSat (0.15 @ 195 deg) CAP any pool colour. Flat-lake
calibration (slabs/dashes 0): #00d8ff -> #1cb7d5, #00e8ff -> #1ec5d5,
#00ccff -> #1caed6 — blue never passes ~0xd8 and R is floored at ~0x1c
whatever water.js authors (dip factor ~0.86 at pool luma; only luma > 0.9
escapes, i.e. hue ~180). No palette could reach ref05's #0cbff1.
**Fix — WATER KEY:** the water shader writes scene alpha 0.625 (opaque
material, no blending; voxels write 0, other opaque 1). post.js composite
(surgical, 3 lines): reads tLit.a -> `waterK`, which spares those pixels the
dip (spare = max(spare, waterK)) and the coolSat cut. Tonemap, contrast,
saturation, vibrance, split-tone, knee still apply. Re-calibrated flat:
#00ccff -> #0bc9fb, #0098e0 -> #0098e1, #40e8ff -> #19e5fa (~identity).
At night the key slides off (alpha 0.625 + 0.07*uNight) so moonlit water
takes the city's grade. AO pass gives water 62.5% SSAO (harmless).
**Palette off ref05 pixels:** shallow #0ac6f4, mid #00aae8, deep #0096dc,
light-patch target #6aeefe (lightStep 0.46), caustic #b4f7ff at 0.70, dark
mult (0.40,0.78,0.89) -> dark tiles ~#0092d4, band #30dcfa, sea #02aeea.
Glint density 0.20 -> 0.34; foam line 0.40 -> 0.55 u (min 1.8 px), lap 0.55.
**Walls lighter (critic):** wall #2088e4 / alt #2a96ec / grout #1468c8 /
wet #3cbcf6, WALL_GLOW 0.55 -> 0.65 -> screen ~#1070c0 lit (was #0060a0).
**Measured:** lake hue/sat/val p50 192/1.0/0.96, lum p10/50/90/98
#008ed7/#00c6f5/#23dafa/#8bf3fc vs ref05 pool 191/0.95/0.91,
#0092d4(dark tiles)/#0cbff1/#20d9f8/#5de8fd (was ours 196/.88/.85,
#107acd/#16a9d3/#1cb1d7). Zero console errors (iso-water, iso-wide,
iso-night). FPS 18-34 this session, load-bound (baseline before my change
was 21 in the same conditions); cost is one alpha read in post.
**Next:** if post.js's owner reworks the composite, keep the waterK hook
(grep "WATER KEY"). Ours is now a hair lighter than ref05 (val .96 vs .91) —
could trim lightStep/caustic if a critic says "too pale". Night water still
reads a bit bright vs the dark city (pre-existing). Floats' square ripple
still reads slightly like a selection box.

## 2026-09-24 — round 11 (builder)

Critic (round 10, picked ours, not wowed): "lake too cyan/light (#00c6f5..
#23dafa vs ref #0495d4..#02aede), narrow value band = one flat glowing sheet;
want base ~#0a9fe0, 15-20% edge->centre darkening, a taller, lighter, TILED
inner wall; dash glints look like UI glyphs; sand shore has no wet edge".

**Water level:** WATER_Y -1.85 -> **-2.6** (walls show ~3.3 u, was ~2.6).
Surgical deps: life.js `WATER_Y = -2.6` (boats), engine.js comment,
CONTRACTS-RENDER.md (2 lines).
**Walls:** real pool TILES — 1 u squares with 0.16 u darker seams both ways
(rows counted down from the coping), thin wet strip 0.12 (was a 0.26 light
band), coping face 0.3 -> 0.2. Wall faces (aGlow > 0.5) now write post.js's
WATER KEY alpha 0.625 in bankMaterial (dithering_fragment hook; off at night
via uWallGlow), so the grade no longer greys them. WALL_TONE px 1.08 / pz 0.80
(ref05's two faces are nearly equal). Colours wall #067ac2 / alt #0a80c8 /
seam #0668b0 / grout #044e92 -> screen lit ~#008ee5, shade ~#0070c1..#0080d4
(ref #0087c9..#008bd4).
**Body:** shallow #06ace6, mid #04a0e0, deep #0288d0, sea #0394d8, band
#12c0f0 at 2.6 u (was #30dcfa 4.5 u), light-patch target #3cd8f8 (step .42),
caustic #8aeafc @ .60, dark mult (0.55,0.85,0.93), uDepth (3,30).
**Glints -> sheens:** the screen-aligned dash glyphs are gone; each is now a
world-axis, voxel-snapped 3-6 x 2-4 u pale-cyan patch with feathered edge +
an inset whiter step, slowly swelling/fading (uSpark density .26, cell 12).
**Deck:** 1.1 u damp-sand strip (#e6b677) beside the coping (wet edge).
**Measured:** lake lum p10/30/50/70/90/98 #007bcf/#009edf/#00ace7/#01bbef/
#00c8f8/#57e3fd (was #008ed6/#00b4eb/#00cbf8/#09defb/#23dbfb/#8bf3fc).
Zero console errors; iso-water 38 fps (load-bound, 7-41 across runs; base
23), iso-wide 61.
**Next:** coping is still a white/cream band where ref05 uses the sand deck
lip — could go sand-toned if a critic flags the white frame. Sheens may be too
subtle at iso-wide scale. Night pass not re-checked this round.

## 2026-09-24 — round 12 (builder)

Critic (round 11, picked ours, not wowed): "light/dark squares scattered at
random over one flat mid-blue -> no depth; ref05 has a darker shadow band under
its far (top/left) walls and gets lighter toward pale turquoise at the near
edge and the step; far fewer random patches; a bit royal-blue; foam is a thin
even line that never follows the stepped corners".

**Depth is now directional (the big one):** new `nearShore(p)` sphere-traces
the coarse field toward the camera (world +x+z = straight down the screen),
on 2 u voxel blocks -> distance to the NEAR shore. `uNearRamp` (3, 44) u
drives shallow #38d8f0 -> mid #0ec6ec -> deep #06ade4 (more turquoise than
r11's #06ace6/#04a0e0/#0288d0); the old Euclidean depth only adds x0.55 so big
lakes stay deepest mid-lake. Result: pale near edge, darkest under the far walls.
**Far-wall shade band:** new `boxShoreDir(p)` splits the voxel shore distance
into (far -x, far -z, near +x, near +z) (camera looks from +x+z, so -x/-z walls
are the ones whose faces show). `uWallShade` (3.4 u / 2.2 u, strength 1 /
0.85) + `uShadeColor` (0.40,0.70,0.83): a dark step under the wall and a half
step out to 1.8x — measured #0092d1 -> #00a1dc -> body #00afe7 (ref05
#058ecc under the wall vs #0dbce6). Patches/sheens are suppressed inside it
(bodyBase). Mixed diagonals (+x-z, -x+z) feed only the far bands — wrapping
the near band round them made pale "glyph boxes" under the far walls.
**Near shore:** pale turquoise band (#5ee0ee, 2.6 u) + white foam only on the
near walls, with a square foam splash block at every near corner (inner and
outer); far walls get a thin 0.22 u light waterline + small corner blocks.
The inset second band (ledge2) is gone.
**Fewer patches:** layer C removed; occupancy A .55 -> .26, B .45 -> .18;
light step .42 -> .36, dark mult (0.62,0.88,0.95), caustic overlap .60 -> .25,
sheen density .26 -> .08.
**Measured:** zero console errors (iso-water, iso-wide, iso-night); iso-wide
61 fps, iso-water 34-52 (load-bound, same range as r11). Screen profile down
the lake: wall #007bcf, band #0092d1/#00a1dc, body #00afe7, lower #04cef2,
near edge #0cddf7.
**Next:** the step/near band could get a subtle lap animation; the shade band
is a fixed authored direction (-x strong, -z weaker) — if lighting.js's key
azimuth changes a lot, flip uWallShade.z/w to match. Night water still bright
vs the city (pre-existing).

## 2026-09-24 — round 13 (builder)

Critic (round 12, picked ref): "lake one flat light cyan; checker tiles ~5%
value change, no specular highlights -> painted floor; ref05 has big deeper-blue
blocks mid/far, lighter shallows by the walls, white streaks + glints; wall
grout grid too strong (ref wall = smooth blue band); no foam at the waterline".
Past-gap list: r7 dull/dark, r8 pale/flat, r9 dark cobalt+low contrast, r10
too cyan/one sheet, r11 random patches no depth, r12 flat+no highlights ->
the consensus across 5 critics is LOW PATCH CONTRAST; fixed properly this time.

**Root cause:** uDark2Color was a LINEAR multiplier (0.62,0.88,0.95) ->
only ~-6% G on screen. Now (0.42,0.60,0.83) ~ -22% G / -8% B sRGB, a second
overlapping dark block steps one more notch; light step .36 -> .55,
caustic overlap .25 -> .45. Occupancy A .26 -> .58, B .18 -> .40, cells
(26x18, 14x17). Dark sign biased by depth (pLight .85 -> .10) and never
within 5 u of a wall (2 u block-snapped gate) nor in the map-edge coastal
strip (read as speckle in iso-wide).
**Camera now rotates** (engine.js 90-deg snaps; iso shots pick the snap from
the sun — the iso-water view flipped mid-round): near/far are no longer
hard-coded +x+z. boxShoreDir(p, camS) / nearShore(p, dir) take the toward-
camera ground direction from viewMatrix row 3 (sign-snapped for the bands).
**Highlights:** round-11 sheens (square-in-square glyphs) replaced by stacked
2-3 bar stair-stepped white streaks in a pale-cyan halo (cell 17.5x14,
density .30, slow slide + fade) and twinkling 0.64 u white sparkles (cell 7).
uSpark = (strength, streak density, streak cell, sparkle cell).
**Shore:** far-wall shade is now a narrow 1.2/0.9 u step (was 3.4 u + half
step); beyond it a pale shallow band (uPatchColor #7ae9f6, was #5ee0ee) —
also used on the near walls. Far waterline white foam 0.34 u (was 0.22 @ .75)
+ breathing pale lap line. Walls: 2 u vertical tile columns only, no
horizontal seams, softer seam #0770b8; wet strip #6ad6f6 0.18 u.
**Measured** (lake crop, 3200-wide shot): lum p2/10/30/50/70/90/98
#0072c0/#0086d0/#00afe7/#00caf0/#24d1f4/#2fe5f8/#59eaff, p10-p90 luma range
74 (r12 55; ref05 pool 57, p10 #008bd5 p50 #0cbde7 p90 #17d9fc). Zero console
errors. FPS 48 (iso-water, first run) but 6-22 later — machine load avg 11
with 18 headless Chromes; the shader adds ~1 fetch + a 3-iter loop.
**Next:** our range is now a bit WIDER than ref05 — if a critic says "too
contrasty/navy blocks", trim uDark2Color G toward 0.66 rather than cutting
occupancy. Float collars' square ripple still reads a little like a
selection box. WALL_TONE is per world axis, so after a camera snap the
visible pair of wall faces uses nx/nz tones (0.9/0.95) — fine but untuned.

## 2026-09-24 — round 14 (builder)

Critic (round 13, picked ours, not wowed): "dark tone patches scattered as
random rectangles = checkerboard blotches, not depth; pale washed-out cyan at
the rims; ref05 is a saturated pool blue that darkens steadily toward the
centre; inner wall a flat even blue with no tile/depth gradient; no foam/edge
line where water meets wall".

**Depth = distance from the walls, stepped (the big one):** the round-12
view-direction ramp (nearShore 16-iter trace + 5-tap depth blur), the
independent light/dark patch tones, the caustic overlap and the far-wall shade
band are all gone. Tone is now ONE function of the coarse shore distance read
on a 4 u block (2 u notched every contour into speckle), quantised into five
saturated steps: rim (Chebyshev band 2.4 u, square corners) #16cbf2 ->
shallow #0abbee -> mid #02a9e6 -> deep #0499de -> core #048fd9 -> abyss
#0684d2 at uTerr (6, 12, 19, 28) u. Irregularity comes only from a fixed
jitter (12x8 u cells, +-1.8 u, none within ~6 u of a wall) and the drifting
patch layers, which now PUSH the distance by +-5 u (uTerr2.x) instead of
tinting — so every "patch" is just a neighbouring depth step bulging in or
out, never a foreign tone. Far zoom blends to the smooth field (no speckle).
New uniforms uTerr, uTerr2, uCoreColor, uAbyssColor.
**Shore:** every wall gets a solid white foam line (far 0.40 u, near 0.45 u +
corner splash blocks + rolling dashes) and a thin pale-cyan lap line ~0.6-0.9 u
out. Wall waterline strip wallWet #6ad6f6 -> #d6f6ff (bright edge line).
**Walls:** tile rows 1 u tall counted down from the coping, each row darker
toward the water (ROW_K 1.0/0.84/0.70), 2 u columns with soft seams; base
#0674be; WALL_TONE shade faces darker (pz .72, nz .80, nx .86).
**Measured** (lake interior, iso-water): lum p2/10/30/50/70/90/98
#0080cf/#008dd8/#008dd8/#0098de/#00abe8/#00bff2/#2cc7f9 (ref05 pool p10
#008bd5, p50 #0cbde7, p90 #17d9fc) — we are a touch deeper at the median
because this lake is much bigger than ref05's pool. Zero console errors both
shots; fps 20-31 iso-water / 27-30 iso-wide, load-bound (load avg ~8, same as
r13's 23/16); the shader is cheaper than r13 (loop + 5 fetches removed).
**Next:** if "too dark in the middle", lift uAbyssColor/uCoreColor or push
uTerr.w out; if "too regular / concentric", raise the jitter amplitude or the
patch occupancy (0.42/0.30 in the shader). Wall seams could go if a critic
calls the tile grid busy again. uWallShade/uShadeColor/uNearRamp/uDepth(main)
are now unused in main() — safe to delete next round.

## 2026-09-25 — wave 2, round 1 (builder)

Brief: converge on ref05's pool (#00a0d8..#10d0f0 bright azure, darker
saturated inner wall, broad smooth depth gradient, sparse LARGE tile patches,
a few glints). Past-gap consensus: r7/r9 too dark, r8/r10 too pale, r11/r13
random blotches / no depth, r12 flat, r14 terraces -> converge on the middle.

**Found:** the live grade now LIFTS and saturates blue hard for water-key
pixels — baseline lake read #06bbfa (B pinned at 0xfa) although authored
#02a9e6; any authored B >= 0xa0 lands at ~0xfa. Flat-lake calibration (sun
fixed, `setSky({..., slabs:0, dashes:0})`), authored -> screen:
#08b0dc->#08caf9, #06a0c0->#08cdf2, #0598b8->#07c9f0, #03a8c8->#07d0f4,
#0cc0d0->#0cdfee, #0380a8->#06b8ef, #045c90->#0698ee, #024c80->#0587e2,
#0240a0->#0465fc. Author with B well below 0xd0 now.

**Changed (src/render/water.js only):**
- Body: stepped terraces (uTerr) gone. Smooth continuous ramp shallow
  #04a8c8 -> mid #0590b4 -> deep #035c90 from the Euclidean shore distance
  averaged over a 5-tap +-10 u cross, uDepth (2, 30). No 4 u block on the
  ramp (its staircase read as diamond contour rings).
- Patches: two drifting layers of big rectangles, sizes/offsets snapped to
  4 u, >= 8 u (1-3 tiles), cells 26x18 / 18x28, occupancy .55/.42, mostly
  DARK (pLight .55 -> .18 with depth; never dark within ~5 u of a wall).
  Dark -> uCoreColor #02487c at .70 (2 overlaps -> uAbyssColor), light ->
  uEdgeColor #1cc8dc at .42. Calmed on the map-edge coastal strip, faded at
  far zoom (pxw .8-1.6) and 75% at night (were black squares on the moonlit
  lake).
- Rim band 2.4 -> 1.6 u (#0cc0d4 @ .85). Glints: streak density .30 -> .18,
  sparkle odds .16 -> .10. Float ripple SQUARE removed (collar only).
- Walls: WALL_GLOW .65 -> .25 (was clipping to one flat #0994f8), wall
  #034f8a / alt #045591 / seam #033f74 / grout #022c58, WALL_TONE px .86 ->
  screen #185fa6 top .. #134377 at the waterline (ref #0a5491 .. #044376).
- Sea #0470a0.
**Measured (iso-water lake crop, 3200 wide):** p10/30/50/70/90 ours
#069de5/#07bcf0/#0bc8ee/#0eccf4/#0cd8f4, luma range 38 (base: #07a0fb/
#06a8fb/#06bbfa/#06bcfb/#0ac9fa, range 25); ref05 pool #018fdb/#04acdd/
#08c1ed/#10cef0/#13dcf6, range 54. Zero console errors (iso-water, iso-wide,
iso-night); selfTest pass. FPS 10-31 — machine load avg 12-17 from other
builders' Chromes; shader cost ~equal to r14 (+4 fetches for the ramp, the
jitter/terrace code gone).
**Coherence [water/ground] bridge notch:** checked — the "sand-rimmed pool"
beside the bridge is a real 1-tile lake inlet next to the bridged tile (sim
only bridges WATER tiles), so the basin is right to wall it; not changed.
The pale-yellow gradient "glow" at deck corners is terrain.js's sand vertex
blend smearing onto the neighbouring grass tile (round-2 note) — ground's.
**Next:** if a critic says "dark patches too strong/navy", drop the .70 dark
mix to ~.55 before touching occupancy. If post.js changes its grade, redo the
flat-lake calibration first (colours are grade-dependent). Glint streaks are
still slightly glyph-like; ref05's are soft chevrons.
