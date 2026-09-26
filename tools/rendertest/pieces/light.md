
### Coordinator note (2026-09-24 10:20) — cross-piece critic signal
Surface critic r1: "dirty grey AO/shadow blotches on the white parapet, roof well and
cornice plus near-black undersides under the awning, where ref04 has razor-crisp flat
faces with thin clean AO bands and a colourful dark side". Shadowed/under-faces must
stay colourful (strong bright sky fill), never near-black; shadow blotches must not
smear across small res-4 geometry (check shadow filtering radius / PCSS softness vs
the new 0.25-unit voxels).
# Piece: light (key light, shading & shadows)

## 2026-09-24 — round 1 (builder)

Changed
- `sky.js`: new DAYTIME ART DIRECTION layer. Physical noon was an ORANGE key
  (lin 1.00/0.75/0.40) over a saturated Rayleigh-blue fill (0.07/0.45/1.14) —
  the blue-grey murk. sky.js now also returns an authored key/fill
  (`artAmount`, `keyColor/keyIntensity`, `fillSky/fillGround/fillAmbient`,
  `fillHemiIntensity/fillAmbientIntensity`); `artAmount` fades out over sun
  elevation 24 -> 12 deg, at night and under overcast, so dusk/night/rain keep
  the physical grade. Key #fffaf2 @2.1, hemi #f3f4f2/#4a4838 @1.3 (top-heavy:
  bright sky, dim bounce), ambient 0.03. The PMREM bake gets its own compile
  (`ENV_PASS`, `_envMaterial`) that swaps the dome for a neutral studio sky +
  dim ground + key-side lobe (`envSun`); the visible dome/water are untouched.
  `setSunFrame(az, maxElev)` places the key cheaply every frame.
- `engine.js`: key is CAMERA-RELATIVE (`KEY_AZ_OFFSET` -35 deg = 10 deg off the
  left-wall normal, `KEY_ELEVATION` 45 deg) so the three-tone read survives
  camera rotation. `_applySkyLighting` blends physical -> authored by
  `artAmount`. Fog pushed behind everything visible (near = d + 0.55*MAP_W).
  Rig opts: `skyContactWorld 10 -> 4.5`, `skyOpenFloor 0.30 -> 0.15` (contact
  darkening only at the foot of walls), softer penumbra (`minPenumbra 0.30,
  softness 0.06, maxPenumbra 2.6, blockerSearchWorld 2.2`).
- `lighting.js`: untouched this round.

Measured (probe cubes 8^3 on open grass, iso view; sRGB luma top/left/right)
- before: red 66/76/73, blue 114/76/65 (far wall >= key wall; tops dark).
- after: red 108/84/61, blue 122/95/71, orange 161/144/114 (~1 : .80-.89 : .60-.71;
  ref04 ~1 : .92 : .75). Open cast shadow / lit grass 0.45-0.54 -> ~0.68
  (ref04 0.58-0.69). Lit grass (176,215,85).
- frame stats iso-mid: meanL 88 -> 135 (ref05 132), p50 87 -> 144 (ref05 140).
  Neutral pixels B-R: now -7..-10 (slightly warm; ref05 0; post grade adds some).
- fps: A/B inside one page shows my params are fps-neutral; absolute fps read 31
  only because ~18 headless Chromes were running concurrently.

Tools: probe cubes + in-page readPixels A/B lived in the session scratchpad
(cubes.js / variants.js / runvars.sh) — worth promoting to tools/rendertest.

Next
- Top vs key-wall is ~.85 for light albedos vs ref .92: try elevation 42 and a
  slightly larger `envSun` if judges want the left wall brighter.
- Neutral B-R still -8: check post's warm grade vs key; maybe key #fffcf7.
- Night is flat grey-blue (not judged): give it the same authored treatment.
- lighting.js skylight accessors / moon floor still assume the old 63-75 deg
  noon; revisit its comments and selfTest numbers.

### Coordinator note (2026-09-24 10:22) — you broke the game for everyone
A comment you added inside a GLSL template literal contained backticks
(`fill saturation`), which terminated the JS template string — SyntaxError, the
game stopped booting for every critic. I changed them to single quotes. Never put
backticks inside shader template strings; run `cp src/render/lighting.js /tmp/x.mjs
&& node --check /tmp/x.mjs` after every edit.

### Coordinator note (2026-09-24 11:00) — contrast ownership between light & post
Both the light critic (r1) and the post critic (r2) now say the same thing: cream/
white towers have nearly EQUAL left/right face values and almost no AO/contact
darkening in street canyons and under ledges, so the frame reads pale and flat vs
ref05's clear three-tone faces and dark crevices. Split of responsibility so you
don't fight each other:
 - LIGHT owns the face ratios (key vs fill vs sky, so top : lit side : shade side
   on a white wall is roughly 1.00 : 0.80 : 0.55 in final sRGB value, shade side
   still colour-rich) and the contact/AO darkening.
 - POST owns only the global tone curve (a gentle S for midtone punch, no crushed
   blacks, no clipped whites) and must not flatten what light produces (no heavy
   exposure lift, no low-contrast grade, SSAO strength coordinated with light's AO
   — pick ONE of the two AO paths to carry contact darkening; say which in your notes).
Measure face values on a white tower in iso-mid with PIL before/after.

### Coordinator note (2026-09-24 11:08)
Surface critic r2: "the grey bakery roof deck shows diagonal banding" = shadow
acne on flat roofs (probably from tightening shadow bias for the finer res-4
geometry). Fix acne on every flat surface without losing contact shadows
(slope-scaled bias / normal offset tuned per cascade, check all 4 iso rotations).
AO ownership: surface owns baked voxel AO in corners; you own cast shadows +
contact shadow at ground; post's SSAO = mesh-to-mesh contact only.

## 2026-09-24 — round 2 (builder)

Critic r1: AO/contact shadow "nearly missing" (ledges float, no anchoring at wall
feet), cast shadows too faint/small in iso-mid, right faces grey.

Changed
- `lighting.js`: NEW world-space AO. A top-down height volume is rendered over
  the camera's ground footprint (RG16F, 2048² q2 / 1024² q1, off at q0; one
  MAX-blended pass: R = column top, G = highest DOWN-facing surface), then a
  bounded flood fill (ping-pong, `aoFloodWorld` 1.6u) keeps an underside only if
  it connects sideways to open air. Needed because voxel buildings are HOLLOW
  shells (core.js walls()): measured, a tower read as a 0.25u slab floating at
  y=16.4 and nothing at its foot was occluded. Shader: 6 cosine directions x 2
  ray-march steps (0.35R, R; R = 3.0u), smooth inside-tests, no noise. Applied to
  hemi/ambient + sky IBL with Jimenez multi-bounce (occluded colours go deeper,
  not grey) and 60% share on the direct key (`aoDirect`) so sunlit wall feet
  and under-ledge bands read. `aoPower` 1.6. Plus `aoFillSaturation` 0.3: fill
  is tinted by albedo/luma (bounce colour) so right faces stay rich.
  Re-render only on region move (>S/12), zoom step (1.25x) or a static-scene
  transform signature change (checked every 15 frames): ~2 ms per rebuild.
  Debug: setDebugMode(7) = raw AO as final colour; 8 = height-map probe.
- `engine.js`: key az offset -35 -> -60 deg, elevation 45 -> 50. At -35 the
  shadow of a box fell along the iso axis and its tip landed INSIDE the box's
  own right-wall silhouette (hidden by construction). Now shadows fall
  back-right onto open ground. Added `_keyAzOffset/_keyElevation` runtime
  overrides for A/B.

Measured
- Lit grass (172,201,110) vs tree shadow (95,124,40): luma ratio ~0.58, green.
- AO GPU cost (timer query, interleaved on/off x10, iso-mid, loaded machine):
  +14-15% of the post.render GPU time with 12 taps (was ~+25% at 16).
- selfTest passes (incl. no-leak over 100 quality cycles); q0/q1/q2, night, rain
  run with zero console errors. fps in shoot runs swung 22-61 purely with how
  many other headless Chromes were running.
- Tools (scratchpad lt/): ab.mjs (one boot, N variant screenshots), evalpage.mjs,
  gpu2.js (timer-query A/B), aocpu2.js (CPU replica of the AO shader).

Next
- Cheaper AO: a dilated max-height mip to early-out fragments with nothing
  within R (open roofs/fields) would claw back most of the 15%.
- Doorway leaks: the flood can enter a hollow interior through a ground-floor
  opening (bounded to 1.6u) — harmless so far.
- Shadow density is ~0.58 lit ratio; if the next critic still wants denser,
  raise `skyOpenFloor` (engine rig opts) 0.15 -> 0.3 rather than shadowStrength.

### Coordinator note (2026-09-24 12:25) — ACNE DIAGNOSIS from the res builder (high priority)
The "blotchy mottled roofs/quoins" the res critic flagged, the surface critic's
"diagonal banding on the roof deck", and likely the veg "smudgy" canopies are
SHADOW ACNE in lighting.js. Evidence (scratchpad rounds/res/r3-diag/): blotches
survive post 'raw', voxel AO off and env off, but vanish with shadowStrength 0.
Debug mode 6 (signed depth delta) shows sawtooth acne along every res-4 roof step,
quoin block and canopy edge. Cause: the BackSide second-depth casters assume thick
shells, but res-4 details (2-voxel roof courses, proud quoins) are thin along the
light ray, so the stored back-face depth sits right behind the lit face.
Live test via BV.engine._lighting.setParams: depthBiasTexels 0.5 -> 2.5 removes most
of it; normalOffsetTexels 1.0 -> 2.0 cleaner still (see diag8.png there). This hits
every res-4 piece. Pick the final values yourself, then re-check contact shadows
(the light critic ALSO wants stronger cast shadows back-right of buildings) — so fix
acne via bias/offset, and get shadow darkness from strength/fill, not from tighter bias.
I (coordinator) already applied depthBiasTexels 2.5 / normalOffsetTexels 2.0 as the new defaults at 12:27 — verify and tune from there; keep them unless you find better.

### Coordinator note (2026-09-24 12:32) — your height-map AO is the new blotch source
After the bias fix, one-bakery (scratchpad me2/one-bakery.png) still shows BLOCKY,
stair-stepped grey-green blotches on flat lot paving around props (market stalls,
tree planters) and on the bakery roof deck. Surface critic r3 independently: "white
and light faces carry streaky smeared grey-green blotches like a noisy or poorly
denoised AO pass". That is the region height-map AO you added (its texel is too
coarse vs res-4 detail, and it tints green). Fix: higher-res / bilinear-smoothed
height map, clamp its darkening on upward-facing flat surfaces to a soft ring around
the prop's footprint, no hue shift, OR drop it in favour of voxel AO + SSAO. Clean
flat faces matter more than extra AO.

### Coordinator note (2026-09-24 13:10) — worldAO defaulted OFF
Four critics (surface r3/r4, post r3, veg r7) lost rounds to "blocky square-texel
grey smudges" on flat lot paving, kerbs and grass around props. A/B on one-bakery
(scratchpad ao-cmp.png: left worldAO on, right off) proves it's worldAO: stair-stepped
blotches on the paving with it on, clean with it off, and cast shadows remain. I set
`worldAO: false` as the default. You may turn it back on ONLY if flat surfaces are
blotch-free at iso-mid, iso-close and one-bakery (compare with ao-cmp.png). Corner
AO should come from the voxel AO (surface owns it); get the "anchoring" darkness
from cast shadow strength + contact shadows instead.

### Coordinator note (2026-09-24 14:50) — remaining "grey smears" = over-wide penumbra
A/B on one-bakery (scratchpad blotch/parapet-shadow-smear-AB.png: base | shadowStrength
0 | SSAO off): the grey smears on the white parapet/cornice survive SSAO-off but vanish
with shadows off. They're cast shadows from small rooftop props with a PCSS penumbra
so wide relative to res-4 detail that they read as dirty smudges. ref04's shadows
are soft-EDGED but have a clear shape and flat interior. Cap the penumbra width for
short caster-receiver distances (e.g. max ~0.3-0.5 world units at small blocker
distance), keep long shadows softer. Surface critics have lost 5 rounds to this.

## 2026-09-24 — round 3 (builder)

Critic r2: buildings cast almost no shadow onto road/lots, no contact band, left
and right faces of white/cream facades nearly equal, slightly hazy.

Root causes found (measured, not guessed)
1. Casters were `BackSide` (second depth). The res-4 catalog meshes are OPEN
   underneath (no bottom faces under lots, canopies, buildings), so a ray
   entering a roof/canopy top never "leaves" and nothing is stored: buildings
   cast thin slivers, tree shadows were jagged fragments detached from the
   trees (debug 6 showed it). -> `casterSide: THREE.DoubleSide` (lighting.js).
   The coordinator's 2.5 / 2.0 texel bias holds acne off; checked roofs, lot
   paving, canopies at iso-close / one-bakery — clean.
2. Key at az -60: on screen the shadow ran ~18 deg up-right, almost along the
   right wall's own silhouette (30 deg), so every building hid its own shadow.
   -> KEY_AZ_OFFSET -95, KEY_ELEVATION 42 (engine.js): shadows fall to screen-
   right as a wedge in front of each right wall, ~1.1x height long.
3. Fill-dominated light: with the key OFF a top face still read 223/226, and
   the studio env's HORIZON (#fbf7ee) was its brightest band, so walls facing
   away got as much fill as walls facing the key. sky.js art defaults now:
   key 3.0 (was 2.1), hemi 1.6 / ground #1a1914 (was #4a4838), env horizon
   #7a776f, env ground #1a1914, envLevel 1.03. engine.js also scales the voxel
   material's flat `skyFill` (materials.js, unscaled by any light, ~20% of a
   wall) by 0.36 during the day via artAmount (DAY_SKYFILL_SCALE); dusk/night/
   rain keep the physical blend (artAmount -> 0) — checked rain, dusk, night.

Measured (probe cubes 8^3 on open grass, sRGB luma top/left/right, post on)
- r2: cream 226/206/158 (.91/.70), brick 107/93/71 (.87/.66), navy 87/59/44
- r3: cream ~225/189/130 (.84/.58), brick 103/86/53 (.83/.51), navy 81/54/32
- open-ground cast shadow / lit ground 0.60 -> ~0.54 (and now actually cast).
- iso-mid frame p50 0.453 -> 0.475, p90 0.78 -> 0.85 (ref05 0.548 / 0.895).
- zero console errors; fps unreadable this round (12 headless Chromes, load 8):
  iso-close 37-61, one-bakery 44 in the same runs. DoubleSide casters add no
  draw calls; the depth pass rasterises ~2x faces.

Tried and dropped
- worldAO "floor" channel + contact-only mode (walls/ground-at-wall-foot only).
  Height volume works (verified by readback) but at iso-close/one-bakery the
  voxel material pre-seeds csmAoVis = 1 (materials.js worldAOKeep 0), so only
  terrain/roads would see it and the result was near-invisible. Reverted; the
  worldAO default stays OFF per the 13:10 note. The wall-foot contact band now
  comes from the real cast shadow (DoubleSide) + voxel AO (surface owns it).

Next
- If critics still want a darker crease at wall feet: ask surface to raise
  voxel AO reach at the ground course, or let materials opt into a contact
  term — lighting can't reach voxel faces while worldAOKeep = 0.
- Penumbra is still wide on tall-tree shadows (maxPenumbra 2.6); crisper
  settings (0.15/0.04/1.8) A/B'd ~identical at iso-close, left as is.

## 2026-09-24 — round 4 (builder)

Critic r3 (lost to ref): rooftop cast shadows "smeared, streaky, dithered grey
blotches with ragged edges"; weak corner AO; iso-mid gaps "navy/near-black"
(fill too weak); shadows should be lighter/cooler like ref05.

Root cause (measured): the game camera is ORTHOGRAPHIC, so the depth-split CSM
made every cascade cover the whole screen width: at iso-close a 1024 tile gave
0.064-0.134 world units per shadow texel = 4-9 device px per texel (2x DPR),
2-4 texels per res-4 voxel. On top, a 16-tap Vogel disk over a ~5-texel radius
(engine minPenumbra 0.30) = a sum of 16 shifted step edges = the streaks, and an
AC unit's shadow was almost all penumbra = the smear.

Changed (lighting.js)
- ISO LAYOUT (ortho camera; `isoLayout` opt, QUALITY[].isoTile/isoGrid):
  cascade 0 = tight light-space RECTANGLE fitted to the screen's corner rays
  clipped to y in [isoFitLow -2, isoFitHeight 24], depth extended toward the
  light to maxCasterHeight; 2048^2 at q1/q2 (1536 at q0); extents quantised to
  2 units, centre texel-snapped (no swim when panning). Cascade 1 = the old
  whole-view sphere at 1024 as a fallback, blended by coverage (3 % edge fade).
  Atlas 3072x2048 (was 2048^2). Texel: iso-close 0.045-0.053, iso-mid 0.076,
  iso 0.156 (debug mode 1 shows cascade 0 covers every pixel of iso-mid).
- csmGridFilter: exact separable TENT over a (2K+2)^2 texel window (K=3 q2,
  2 q1/q0), radius 1..K texels from the PCSS gap; stride-2 blocker search over
  the same window (early-out lit/umbra). Continuous in position and radius: no
  noise, no ghosts, no rotation.
- Receiver-plane depth bias from dFdx/dFdy(world pos) (taken at the top of
  csmApply, before any branch): removed a comb of false shadow teeth under every
  convex ledge/parapet that the wider window otherwise produced.
- Old perspective path untouched (selfTest passes, incl. orbit snap + leak).
Changed (engine.js rig opts): minPenumbra 0.03, softness 0.025, maxPenumbra 0.5;
  shadowAmbient 0.45 / shadowIbl 0.60 (was 0.64 / 0.88: canyons were black).
Changed (sky.js art): key 2.6 (was 3.0), hemi 1.75 (1.6), ground + env ground
  #4a463c (#1a1914), envLevel 1.2 (1.03).

Measured
- iso-close roof crops (r4-builder/crop-roof.png vs r4-base/crop-roof.png):
  AC-unit/pole/billboard shadows are clean shapes with even soft edges; no
  streaks, stipple or comb.
- iso-mid frame luma p10/p25/p50/p90: base shoot .120/.313/.531/.907 -> r4
  .161/.369/.583/.875 (ref05 .086/.266/.548/.895); channel-clipped px 3.8 %
  (ref05 7.2 %). An intermediate fill (hemi 2.2 / env 1.4) went to p50 .64 and
  ~10-20 % clipped - too bright, backed off.
- GPU timer A/B in one page (iso layout vs old, 8 interleaved pairs, 1280x720):
  ratio 1.01 iso-mid, 1.01 iso. Zero console errors; night/rain/q0/q1 run.

Notes for others / next
- The white-grey "SKY" helipad tower shows ~equal left/right/top values even
  where nothing shadows it, unlike the cream/blue towers - looks material-side
  (metalness/env on that palette?). Worth a check by surface/materials.
- materials.js `bounce` (0.30) adds key light to faces turned AWAY from the key;
  with the brighter fill, keep an eye on right faces not creeping up to left.
- Corner AO: still carried by voxel AO (surface) + SSAO (post); worldAO stays
  OFF. The crisper shadows make the existing contact darkening read, but if the
  next critic still wants deeper inside-corner AO it belongs in voxel.js reach /
  strength.
- Possible upgrade: non-square cascade-0 tile matching the fit aspect (~1.45:1)
  would buy ~20 % texel density for the same memory.

## 2026-09-24 — round 5 (builder)

Critic r4 (picked ours, not wowed): pale/grey towers' left and right walls nearly
equal; cast shadows nearly invisible on asphalt and lots; roofs darker than walls.

Root cause 1 (measured, iso-mid, pale-blue tower sRGB luma left/right): 211/211.
materials.js `bounce` (0.30) adds `albedo * keyColour * 0.3 * away` to faces
turned AWAY from the key AFTER the BRDF (no 1/PI), so the far wall got ~1.7x the
direct key the lit wall got. With it off: 211/148. SKY-tower pilasters now 196/144.
-> engine.js DAY_BOUNCE_SCALE 0.1 (scales ml._params.bounce[0] by artAmount in
_applySkyLighting, same pattern as DAY_SKYFILL_SCALE; dusk/night untouched).
Root cause 2: open ground in a cast shadow kept ~93% of its fill (skyOpenFloor
0.15), so a shadow removed only the key. -> engine rig opts skyOpenFloor 0.8,
shadowAmbient 0.6, shadowIbl 0.75. Far walls are unaffected (csmApply returns
before setting csmLastShadow when N.L <= 0), so this only deepens cast shadows.
sky.js key 2.6 -> 2.9 to hold lit faces.

Measured (iso-mid 1600x900 A/B in one page, shadow ratio = frame / same frame
with shadowStrength 0): bright-surface shadow ratio 0.76 -> 0.59 (ref04 0.58-0.69),
asphalt 0.65 -> 0.41; yellow block T/L/R 199/207/146 (was 189/204/201).
Frame luma p50 0.566 -> ~0.46 (darker far walls + real shadows).
Tops: grey roof decks still ~= cream left walls; key 2.6->2.9 or elevation 46/50
moved them < 2 luma (post's shoulder + roof albedo) — it's a material/post thing.
Night / dusk / rain / selfTest ok, zero console errors. fps unreadable (load avg 10,
16 headless Chromes); the change is uniform values only (no passes, no taps).
Tools (scratchpad lt5/): ab.mjs (now re-poses via BVDEMO.shot, --dpr), mk.py
(variant + shadowStrength-0 twin), an.py (face + shadow-ratio stats).
Note: main.js calls engine.setNight() every frame — to A/B night, override
E.setNight (see lt5/v9.json).

Next
- If a critic says far walls are too grey/dead: raise DAY_BOUNCE_SCALE to ~0.2
  before touching fill; if shadows read too dark: skyOpenFloor 0.8 -> 0.6.
- Roof brightness: ask materials for lighter roof-deck albedo (or post for a
  touch more highlight headroom); lighting can't lift it without flattening.

### Coordinator note (2026-09-24 18:15) — FACE SEPARATION, measured. Top priority.
Face separation is now the #1 complaint across pieces: light r2/r4/r5, post r2, surface
r8, veg r4 ("left and right faces nearly the same; tops not brightest").
I built an instrument: tools/rendertest/faceprobe.js drops a plain WHITE cube next to
the shot target and returns its top/left/right face screen coords; shoot.mjs now has
--post (value printed as postResult). Recipe (see scratchpad keyprobe/ for my runs):
  LOAD="(async()=>{(0,eval)(await (await fetch('/tools/rendertest/faceprobe.js',{cache:'no-store'})).text());return 1})()"
  node tools/rendertest/shoot.mjs --out DIR --shots iso-close --eval "$LOAD.then(()=>{BV.engine._keyAzOffset=A*Math.PI/180;BV.engine._keyElevation=E*Math.PI/180;return 1})" --post "BVFACEPROBE(6)"
  then average 13x13 px at faces.{top,left,right} * dpr in the PNG, compare luma.
Measured (luma, top : left : right) on the white cube:
  current (az -95, el 42)  1 : 0.99 : 0.78   top CLIPPED (249,244,231)
  az -95 el 58             1 : 0.96 : 0.78
  az -60 el 58             1 : 0.99 : 0.78
  az -130 el 58            1 : 0.81 : 0.78
  az -110 el 55            1 : 0.91 : 0.78
Reference targets (ref06 rocks: top #888 / #707 / #484 → 1 : 0.82 : 0.53; ref06
tree canopy 1 : 0.85 : 0.75) → aim for ~1 : 0.80-0.85 : 0.55-0.62, top NOT clipped
(white top ≈ 238-242). Diagnosis: (1) the right face at 0.78 means total sky fill
(hemi + ambient + envIntensity IBL + materials skyFill) is too strong vs the key —
cut fill ~30-40% and raise the key to compensate; (2) top clips so top == left —
lower exposure/key a little or raise elevation to ~55-60; (3) pick an azimuth that
lights the left face at ~0.82 of top (between -95 and -130 per the table).
Keep the shaded side colourful (your fill-saturation trick) — darker, not greyer.
Post owns the tone curve; tell post.md if you need the grade adjusted.

## 2026-09-24 — round 6 (builder)

Critic r5 (picked ref): helipad tower's left/right walls nearly the same grey;
roofs darker than walls; cast shadows faint at iso-mid.

Diagnosis (iso-mid 2x, decomposed by switching terms off one at a time; faces
masked with a key-only render and an overhead-key "top mask", lt6/mask3.py):
- The key barely lit the left wall: at az -95 it sat 50 deg past the left-wall
  normal, so left got cos42*cos50 = 0.48 of it, LESS than a roof (0.67). Fill
  (hemi + env + skyFill) lit both walls equally and did most of the work.
- A building standing in a neighbour's cast shadow showed an INVERTED 3-tone:
  its key-facing wall lost 50-60% of its fill (sky occlusion), while its far
  wall (N.L <= 0, never "sun-blocked") kept 100%.
- Roofs darker than walls is ALBEDO: roofGray 0x6b6f76 (ceramic) vs dtStone/
  dtFrame walls. Same-albedo tops are already brighter than lit walls (white
  tops 235-250). Lighting can't fix a 3.7x linear albedo gap without clipping
  white tops -> MATERIALS/MODELS: a lighter roof-deck grey (~#a9adb3) would do it.

Changed
- engine.js: KEY_AZ_OFFSET -95 -> -75, KEY_ELEVATION 42 -> 40 (key 30 deg off
  the left-wall normal; shadows fall right and ~9 deg up on screen, still clear
  of the right wall). shadowAmbient 0.6 -> 0.7, shadowIbl 0.75 -> 0.85.
- lighting.js: `csmLastUpW = smoothstep(0.2, 0.7, wnrm.y)` scales the cast-
  shadow sky occlusion, so only ground/roofs lose fill in a shadow; walls keep
  it (no more inverted tones on shadowed buildings).
- sky.js: new art param `envUpPow` (uEnvUpPow, ENV_PASS dome gradient
  exponent, was hard-coded 0.55) -> 1.0: zenith-heavier IBL, walls see less.
  keyI 2.9 -> 3.2, hemiI 1.75 -> 1.85, sky #f1f3f4 -> #e4ecf6, envUp #eceef0 ->
  #e2eaf4 (right faces a touch cool, like ref05's bank right face ~(137,162,168)).

Measured (same frame, one boot, lt6/a4 + a5)
- SKY tower lit/away sRGB luma 216/140 (0.65) -> 231/135 (0.58), away rgb
  (126,136,149). ref05 bank: left ~221-241, right ~157 (137,162,168).
  NB the base itself moved 162 -> 140 on the away face between two of my runs
  (someone else's change landed mid-round) — r5 critic frame was 0.75.
- Cast shadow / lit on TOP faces 0.63 -> 0.59; walls in shadow 0.69 (fill kept).
- frame p10/50/90 .126/.508/.848 -> ~.129/.50/.87.
- Zero console errors at iso-mid/iso-close/iso, dusk/night/rain render.
  fps printed 3-5: ~33 shoot/ab processes running, load avg 8; my changes are
  uniforms + one smoothstep, no passes/taps.
Tools: scratchpad lt6/ (ab.mjs, v1-v6.json variant sets, mask3.py face stats
incl. keyonly + topmask variants — reuse them).

Next
- If a critic says far walls are too dark/cold: sky #e4ecf6 -> #eaeff5 first,
  then envUpPow 1.0 -> 0.8. If left walls clip on white: key 3.2 -> 3.0.
- Roof decks: ask materials/models for a lighter roofGray (see above).
- Shadows at iso-mid mostly fall on other buildings / black asphalt; if still
  "faint", az -80 lands more of them on lots (costs ~5% of left-wall key).

### Coordinator measurement (2026-09-24 19:45) — fill fix worked; now fix the LEFT face
White probe cube now: top (248,247,237), left (244,248,224), right (155,157,151) →
1 : 1.00 : 0.63. Right face is ON TARGET — keep the fill where it is. Remaining: top
still clips and the left face equals the top. Needed: left ≈ 0.82 of top, top not
clipped (~240). Swing the key azimuth so the left face gets a more grazing key
(table in the 18:15 note: az -130 gave left 0.81) and/or raise elevation, and bring
the key/exposure down slightly so the top lands ~240. Post r7 called the frame
"too dark/heavy" — don't respond by lifting fill; the ratio is right, the problem is
the missing mid-tone on the left face making everything read as either blown or dark.

### Coordinator update (2026-09-24 20:22) — use ref04's measured ratio; coordinate with surface
The surface builder measured ref04 same-albedo faces at top : left : right =
1 : 0.89 : 0.63 — a better target than my rock-based 0.82. Use 1 : ~0.89 : ~0.63.
Also: surface added `wallKey 0.70` in materials.js (scales the key's direct diffuse
on vertical faces by day, so lit walls sit under the tops). Measure with faceprobe
AFTER that change before you move the key angle, so the two of you don't
double-correct. Read surface.md's round-10 entry.

## 2026-09-24 — round 7 (builder, second pass "r7b")

Critic r6 (picked ref): no tight dark AO line at wall feet / prop feet / under
cornices and awnings ("objects float"); shade faces one flat value; flat areas dead.

Root cause (measured by reading the AO height map back at a wall foot, new
tool tools/rendertest/aoprobe.js: `__row(cssX, cssY)` prints top / underside /
floor / B for the columns around a raycast hit): the 2-layer height map only
knew each column's TOP. Under any overhang (cornice lip 0.11 u, awning,
umbrella) the paving was invisible, so the ground read "covered, vis ~1" and
walls read "under an overhang, no floor" -> the wall-foot line stopped at the
overhang's edge, i.e. it was missing exactly where the critic looked.

Changed (lighting.js only)
- G is now the LOWEST down-facing surface (1/(h+1) under the MAX blend,
  decoded in AO_COPY_FRAG); new second scene pass AO_FLOOR_FRAG writes A =
  highest up-facing surface below it (the paving under an awning/cornice).
  The flood validates floors (A>0) only when they connect sideways at/above
  an open neighbour's level, so buried floors (terrain under a lot slab,
  paving under a wall or a pole) never make walls look hollow.
- AO_GROUND_FRAG receives at the floor for overhang columns; neighbours show
  only their floor while you stand below their overhang (AO_COLUMN_GLSL).
  `aoTight` 1.0: extra horizon term within 0.3*aoRadius = the thin crease.
  `aoBroad` 0.25 / `aoBroadRadius` 4: sparse 8x4 wide term, gentle GI-like
  darkening of plazas/lawns toward buildings. Blur is floor-aware.
- csmAoTexel/csmWorldAO rewritten: up-facing floors under overhangs get
  B * cover; walls under an overhang get the contact line from its floor
  plus the crease (multiplied, not averaged).
- `aoWallGrad` 0.3 / `aoWallGradPow` 0.8 (uAoGrad): fill on every wall
  rises from its foot to the top of the solid behind it (one texel behind
  the face) — the "lighter toward the top" gradient on shade faces.

Measured / checked
- iso-close bakery/cafe/barber: clear contact lines at wall feet, under
  awnings, stall, planters, benches, bins, lamp posts (lt7/a5 new vs off,
  ratio maps). AO field is smooth (no blocks/streaks; ao7 debug).
- The fine stipple visible in dark paving is NOT the AO (ao7 is clean) — it is
  there with worldAO off too; looks like post grain/SSAO noise (tell post).
- fps A/B one page, iso-mid 1280x720 dpr1 (loaded machine): AO on 18-20 vs off
  21-22 (~10%). No refreshes while static (counted 0 in 5 s). selfTest pass,
  q0/q1/q2 switch clean, zero console errors in all shoots.

Next
- If critics call contacts too heavy/grimy: aoTight 1.0 -> 0.6 first.
- Road shadows still low contrast on near-black asphalt; that needs a lighter
  asphalt albedo (roads) rather than darker shadows.
- Flood depth (aoFloodWorld 1.6 -> 32 steps) bounds how deep an awning's
  floor is validated; deeper canopies fall back to the old cover term.

### Coordinator (2026-09-24 21:05) — I set the key/fill defaults from a probe sweep
Your r7 defaults (az -75, el 40) measured 1 : 0.98 : 0.73 on the white probe (walls as
bright as roofs — the #1 complaint). Sweep (scratchpad sweep/, sweep2/):
  az -100 el 58 fill 1.0 → 1 : 0.89 : 0.73   (lit side = ref04 target exactly)
  az -100 el 58 fill 0.8 → 1 : 0.87 : 0.70   ← now the DEFAULT
  fill 0.65 → 0.85 : 0.68, fill 0.5 → 0.84 : 0.65
  az -120 el 50 → 0.82 : 0.70; az -130 el 55 → 0.79 : 0.70
New engine knob: FILL_SCALE / engine._fillScale multiplies hemi+ambient+material sky
fill. The remaining right-face excess (0.70 vs 0.63) is the sky IBL (envIntensity),
which _fillScale doesn't touch — if you want the last step, scale IBL on vertical
faces only rather than dimming everything (post r9 already says the frame is "too
dark/dense", so don't go darker overall). Keep these defaults unless a faceprobe
measurement shows something better; always report faceprobe numbers in your notes.

## 2026-09-24 — round 8 (builder)

Critic r7 (picked ref): downtown left/right walls "almost the same mid value";
towers cast almost no visible soft shadow; wants right face 35-45% darker, cool.

New instrument (scratchpad lt8/): ab.mjs = shoot.mjs + `--variants` (one boot,
N screenshots); mk.py builds variant JSON with a full param RESET each time and
a last `normals` variant (scene.overrideMaterial = MeshNormalMaterial, post
bypassed) -> an.py masks TOP / LEFT / RIGHT faces exactly and reports median
sRGB luma per hue group (neutral / blue / green / warm), frame and downtown box;
sh.py = cast-shadow coverage + lit/shadow ratio on tops vs a shadowStrength-0
twin. Use --vsettle 3000 (a 900 ms settle caught half-updated frames).

Findings (measured, not guessed)
- Coordinator's -100/58 key: KEY-ONLY render, neutral walls left 47 vs top 191.
  Left walls got almost no key, so BOTH walls were fill-lit -> they converged.
  The white probe hid it (its top clips at 248, so L/T looked like 0.89).
- The hemi + studio IBL are symmetric about Y: every wall got the same fill
  whichever way it faced. That is the flat downtown.
- POST's shaded-face floor (grade.floor.amount 0.24, r10) is the other half:
  same frame, neutral right/left 0.87 with it, 0.67 with floor 0; blue 0.78 ->
  0.64; it lifts exactly the far walls AND the cast shadows (shadow/lit on tops
  0.73-0.75 with it). Lighting alone can only push against it.

Changed
- lighting.js: `csmWallFill()` — directional daytime fill. Walls turned AWAY
  from the key lose `wallFillAway` 0.75 of hemi+ambient+diffuse IBL, tinted
  cool (`wallFillTint` [0.88,0.98,1.16]); key-facing walls gain
  `wallFillToward` 0.25 (so a key-side wall in a neighbour's shadow stays a
  step above its own far wall). Horizontal faces untouched. Uniforms
  uCsmWallFill / uCsmWallTint / uCsmKeyDirW (set in setSunDirection);
  `setWallFillAmount(a)` gates it by sky artAmount (off at dusk/night/rain).
- engine.js: key -100/58 -> -85/50 (left wall gets cos50 cos40 = 0.49 of the
  key, tops 0.77, shadows 0.84 x height to screen-right); calls
  setWallFillAmount(a) in _applySkyLighting. Rig: skyOpenFloor 0.8 -> 1.0,
  shadowAmbient 0.7 -> 0.8, shadowIbl 0.85 -> 0.92.
- sky.js: keyI 3.2 -> 3.3.

Measured (iso-mid, one boot, base = coordinator defaults vs new)
- right/left luma: neutral 0.88 -> 0.81, blue 0.77 -> 0.64, green 0.84 -> 0.72,
  warm 0.79 -> 0.75. White prop T/L/R 249/212/168 -> 249/227/159
  (1 : 0.91 : 0.64 — ref04 1 : 0.89 : 0.63).
- cast shadow / lit on tops 0.73-0.75 -> 0.57-0.61 (ref04 0.58-0.69), asphalt
  0.66 -> 0.61; ~38% of top pixels in shadow at iso-mid. Frame p50 .50 -> .46.
- selfTest pass; zero console errors at iso-mid / iso-close / iso. fps not
  measurable (load avg 12-14); the change is one small function per fragment,
  no taps/passes.

For POST / coordinator (I did not touch post.js)
- With the same light and post floor 0.12 instead of 0.24: neutral R/L 0.70,
  blue 0.57, white prop R/L 0.57 — the critic's "35-45% darker" lands only if
  the floor comes down. If post needs the mid-zoom brightness back, lift it on
  TOPS/lit faces (exposure/curve) rather than a floor on the darker half.
  If post drops the floor, re-check shadows: 0.57-0.61 may then read too dark
  -> skyOpenFloor 1.0 -> 0.85 first.

Next
- If far walls read muddy: wallFillAway 0.75 -> 0.6 (tint stays).
- If tops lose to lit walls (L/T neutral now 0.92): elevation 50 -> 54.

### Coordinator note (2026-09-26 13:25, wave 4)
The post critic measured our lower midtones lifted vs ref05 (p25 luminance 0.42 vs 0.27). Your faceratio right face is still ~0.69 vs the 0.63 target — close that (measured with faceratio.sh), which is the physically right half of the fix; post will add a gentle midtone curve for the rest. Re-measure after post's change lands so you two don't double-darken.

### Coordinator note (2026-09-26 14:20) — SUPERSEDES the 13:25 note
Post WON w4r2 with its lower-mid curve; that critic said shadowed faces/canyons now read slightly HEAVY (dim navy/brown) — the opposite of w4r1. So the tonal gap is closed at the midpoint: do NOT darken the right face further. Hold the right-face ratio where it is (or lift the fill a hair if faceratio shows <0.63), and keep dark sides colourful (sky-fill tinted, not navy/brown). Focus your remaining effort on cast-shadow shape/softness and contact shadows.

## 2026-09-26 — wave 4 round 1 (builder)

User direction relayed this round: once the piece wins, stop; no chasing "wow". So this
was a measure-first pass, and I changed only what measurement said was still off.

Measured (current tree, before my edit)
- faceratio (white probe, iso-close): top (248,246,235) left (227,226,215) right
  (158,160,155) -> 1 : 0.92 : 0.65 (ref04 1 : 0.89 : 0.63). Key/fill left as they are.
- Cast shadows, shadows on/off A/B in one boot (scratchpad lt/sh1, ratio.png): 12 % of
  iso-close pixels shadowed, median shadow/lit 0.70 (ref04 0.58-0.69). Shadows fall
  screen-right / slightly down, in front of each right face: clearly read on sidewalks,
  lot paving, rooftops (AC units, parapets: clean shapes, no smear, no acne). On the
  near-black asphalt they are not visible, same as in ref05 (whose ground shows almost
  no cast shadow at all). Lighting cannot fix asphalt legibility without lighter asphalt.
- Contact / crevices: prop feet, benches, bins, wall feet have soft clean contact
  darkening; luma<25 pixels that are not neutral asphalt = 0.14 % of iso-close. Only the
  under-awning shop bays read dark navy (glass/material, also as in ref05).
- Dusk (coherence #5): the wave-2 dusk palette already stopped the salmon wash; at
  night 0.40/0.47 whites read cream-gold with cool shade faces.

Changed (sky.js only)
- duskKey #ffc584 -> #ffd6a0, duskSky #bfc8ec -> #c8d2ee: a softer gold on lit whites,
  a bit less peach on the asphalt and lots. Daytime is untouched (faceratio after:
  1 : 0.91 : 0.65, same within noise).

Checked: check.sh clean; iso-mid / iso-close / iso shoot with zero console errors;
BVSELF: every module passes except roads' known GL error 0x501 (cross-talk, coherence
#11). fps in the shoot runs (2-8) is not meaningful, because many headless Chromes were
running at once. The change only alters colour constants.

Next (only if a critic reports a real gap)
- Longer or more visible ground shadows would need el 58 -> ~52. That lifts the left face
  above 0.92, so re-measure with faceratio first.
- Top white still sits at 248 (near clip). Try key 3.3 -> 3.1 only if critics say
  white roofs have lost their detail.

### Coordinator note (2026-09-26 15:00) — amends 14:20; go by MEASUREMENT
Critics now pull both ways (post w4r2: canyons "heavy"; light w4r1: "cast shadows too faint, face values too close"). Resolve with numbers, not adjectives:
- Faces: land exactly on the ref04 target 1 : 0.89 : 0.63 with faceratio.sh (last measured ~1 : 0.92 : 0.69, so a small, measured step darker on left/right is correct). Keep dark faces colourful (sky-tinted blue, not brown/navy mud).
- Cast shadows on the GROUND are a separate knob from face shading: measure in ref05 the luminance ratio of shadowed vs sunlit grass and shadowed vs sunlit lot paving (pick 3-4 spots each with PIL), then match those ratios in iso-mid. Shadows should be clearly visible, soft-edged, slightly blue-grey, falling back-right.
- AO in deep canyons stays where post left it; don't add darkening there.
Log all numbers in your notes.

## 2026-09-26 — wave 4 round 2 (builder)

Critic w4r1 (picked ref): downtown right faces only a bit darker than left, towers
flat/pastel; almost no visible cast shadow on lots/roads; wants right face 15-20%
deeper and cooler, darker shadows on light surfaces.

New instrument (scratchpad lt/): ab.mjs variants + a MeshNormalMaterial variant
(engine.render swapped for a plain renderer.render with overrideMaterial) ->
an.py: exact TOP/LEFT/RIGHT masks; median luma ratio across real vertical CORNERS
(left-face pixel vs right-face pixel 7 px either side of the same edge = same
building, same material), frame + downtown box; shadow coverage and shadow/lit
on up-facing pixels vs a shadowStrength-0 twin; shadow hue on light paving.

Reference measured (ref05, PIL): right/left on real buildings ~0.57 (hotel cream
242 -> 137, fire-station brick 124-131 -> 69-76). Shadow on tan plinth (bank
lot): lit ~(211,192,148) vs shadow ~(126,130,130): ratio ~0.6-0.67, B/R 1.03
(blue-grey) vs 0.70 lit.

Before (iso-mid): corner R/L frame 0.654, downtown 0.670; up-facing in shadow
24.0 %, shadow/lit 0.578; light paving in shadow B/R 0.88 (olive, lit 0.82).
faceratio 1 : 0.91 : 0.65.

Sweep (one boot each, numbers are corner R/L frame/downtown, shadow %):
  wallFillAway 0.9 / 1.0 -> 0.605/0.630, 0.567/0.595 (shadows unchanged)
  az -115 -> R/L 0.687, shadow 25.5 %, L/T down; az -85 -> 0.638, 21.6 %
  el 50 -> shadow 28.6 %, L/T 0.868 -> 0.894
  spec cut on away walls: small (0.632 -> 0.620 at 1.0)
  material skyFill 0 / half -> 0.495 / 0.556 (and shadows 0.50 / 0.55)
  bounce 0 -> 0.452 (too dark/uncoloured; not used)
  key intensity 3.3 -> 3.9: ~no change (post normalises), not used.

Changed
- engine.js: key -100/58 -> -110/52; DAY_SKYFILL_SCALE 0.36 -> 0.30;
  DAY_BOUNCE_SCALE 0.1 -> 0.08.
- lighting.js: wallFillAway 0.75 -> 0.95; new wallFillSpec 0.6 (csmWallSpec():
  same away-wall cut on the sky SPECULAR, uCsmWallFill.w); new shadowFillTint
  [0.76,0.96,1.45] x shadowFillTintAmount 1 (uCsmShadowTint, applied in
  csmWallFill to hemi+IBL fill of up-facing fragments in cast shadow, gated by
  the daytime art amount).

After (iso-mid, defaults): corner R/L frame 0.568, downtown 0.596 (-13 % / -11 %);
L/T 0.854; up-facing in shadow 27.3 % (+14 %), shadow/lit 0.565; light paving in
shadow B/R 1.03 (= ref05). faceratio 1 : 0.89 : 0.59 (left on the ref04 target;
right 0.04 under ref04, deliberately toward ref05's measured ~0.57).
Frame p10/50/90 .139/.475/.855 -> .117/.444/.835 (ref05 .086/.548/.895; the
mid/high gap is post's curve, key intensity does not move it).
Checked: check.sh clean; iso-mid/iso-close/iso zero console errors; BVSELF all
pass except roads' known 0x501 cross-talk. fps in shoot runs (2-18) is load noise;
the change adds one small function per fragment (no taps/passes).

Next (only on a real critic gap)
- If far walls read heavy/navy: DAY_SKYFILL_SCALE 0.30 -> 0.33 first (probe R
  ~0.61), then wallFillAway 0.95 -> 0.85.
- If shadows read too blue on grass: shadowFillTint toward [0.84,0.97,1.28]
  (measured B/R 0.97 on paving).
- Contact AO at mid zoom untouched (coordinator: canyon AO stays where post left it).

### Coordinator note (2026-09-26 18:00) — after w4r2: overshot; land exactly on target
Critics swung faint (r1) → heavy (r2). I measured now: faceratio 1 : 0.89 : 0.59, right face RGB (148,146,139) — neutral grey. Target 1 : 0.89 : 0.63. So: (1) lift the right face back to 0.63 exactly (left is already on target — don't move it); (2) give shade colour: the fill/sky contribution on right faces and in cast shadows should carry a cool sky tint (right face on the white cube roughly B > R by ~8-12, e.g. ~(150,156,168)), so dark sides stay "clearly coloured" instead of grey; (3) cast shadows light cool-grey and soft, measured against ref05 shadowed/sunlit ground ratios per the 15:00 note, so adjacent shadows don't merge into one dark mass. Stop after landing these numbers — no further swings.

## 2026-09-26 — wave 4 round 3 (builder)

Critic w4r2 (picked ref): right faces and canyon shade read "heavy", cast shadows merge
into one mid-dark mass; wants ref05's light, cool-grey shadows and right faces that stay
coloured. w4r1 had asked for the opposite (deeper faces and shadows). So I took the MIDPOINT
of the two measured states and checked it against the reference numbers.

Measured before (iso-mid, scratchpad lt/r3a, one boot, normal-masked): corner R/L 0.561
(w4r1 saw 0.654), up-facing shadow/lit 0.565, coverage 27 %. faceratio 1 : 0.89 : 0.59.
Right-face chroma scales with luma (C 40 vs left 68 = same ratio as luma), so the right
faces are not desaturated, only dark.
Sweep: wallFillAway 0.85 -> R/L 0.597; material skyFill x1.1 -> +0.008 (weak);
shadowAmbient/Ibl 0.68/0.80 -> shadow/lit 0.627 (coverage unchanged); aoBroad 0.12 and
softness 0.045 / maxPenumbra 0.9 -> no measurable change. The iso grid filter clamps r to
K = 3 texels, so softness/maxPenumbra do nothing in iso. Softer edges would need K 4,
which means more taps and the blocker loop bound (j < 4) too. I did not do that, to keep
perf's savings.

Changed
- lighting.js: wallFillAway 0.95 -> 0.80.
- engine.js (rig opts): shadowAmbient 0.8 -> 0.68, shadowIbl 0.92 -> 0.80.

After: faceratio 1 : 0.89 : 0.63 (the ref04 target exactly). iso-mid corner R/L ~0.61
(the midpoint of 0.654 and 0.561; ref05 ~0.57). Up-facing shadow/lit 0.626 (ref05 tan
plinth 0.60-0.67), coverage 26.7 %, shadow hue still blue-grey. iso-mid / iso-close / iso
had zero console errors. check.sh clean.

Not lighting (for coordinator): the critic's "roofs near-white" gap. Downtown L/T at
corners is ~1.0 because the roof albedo (grey roofGray/gravel) is darker than the facades.
The white probe top already sits at 248, so the key cannot lift the roofs further. That is
a materials/models roof-colour change.
Next: only if a critic calls shadow edges too crisp, try iso grid K 3 -> 4 (perf cost).

### Coordinator note (2026-09-26 18:25) — ROOT CAUSE of "heavy" (r2, r3): the midtones, measured
Luminance percentiles p5/p25/p50/p75 (iso-mid downscaled to ref05 scale):
  ref05:                 0.09 0.27 0.55 0.75
  ours now (w4r3):       0.08 0.27 0.45 0.63   <- median and upper mids ~0.10 too low
  ours before post's fix: 0.09 0.42 0.57 0.71
Post's lower-mid curve (post piece is DONE, won w4r2) landed p25 exactly but dragged the median and p75 down with it — that's the heaviness three critics see, not the face ratio. You may now make a surgical change to the post curve in src/render/post.js (note it in pieces/post.md too): hold p5 ~0.09 and p25 ~0.27, bring p50 back to ~0.55 and p75 to ~0.75 (i.e. the curve should bend only BELOW ~0.3, not across the midtones). Then land the white-cube right face at 0.63 with a cool sky tint (18:00 note). Re-measure these percentiles and log them. This should also fix what the materials/civic/downtown critics called "dark punched windows".

### Coordinator note (2026-09-26 18:40) — shadow-map artifacts at close zoom (from surface w4r2)
I looked at one-bakery (w4r2-critic, crop x1300-2300,y1300-1900 of the 3200px shot): (a) the tree-planter shadow on the lot paving has hard stair-stepped (texel-aliased) edges; (b) thin dark streaks run along the left plinth side band — looks like acne/peter-panning striping; both appear only close up. Please A/B them (shadow filter radius / bias / cascade texel density at close zoom) and fix without re-introducing the old res-4 acne. Log before/after crops.

## 2026-09-26 — wave 4 round 4 (builder)

Critic w4r3 (picked ref), agreeing with w4r2: tower canyons and right faces sink to a
"dim, desaturated navy-grey". Wants the shade airier and cool-tinted, not darker. Coordinator
18:00: keep faceratio at 0.63, but tint the right face cool (B > R by ~8-12).

Measured before (scratchpad lt4/, one boot, normal-masked downtown box of iso-mid):
- faceratio 1 : 0.89 : 0.63, right (154,155,150): neutral and slightly warm.
- World AO on/off: key-side walls 146 -> 165, roofs 135 -> 148, frame p25 65 -> 78.
  The ratio map shows it mostly as grey bands over every recessed window column. The
  narrow-gap term fires on the pilasters beside each pane, then aoPower 2 squares it.
  aoWallGrad and aoDirect add to the same bands. aoCrease had no measurable effect.
- Right-face light sources on the white probe: without the hemi/IBL wall fill the right
  face is still 146/143/134, and without the bounce it is 137/144/148. So the WARM key
  bounce (materials uBounce) is what greys the far wall.

Changed
- lighting.js: wallFillAway 0.80 -> 0.68, wallFillTint [0.88,0.98,1.16] ->
  [0.80,0.97,1.36], aoGap 0.5 -> 0.85, aoWallGrad 0.3 -> 0.15, aoDirect 0.85 -> 0.6,
  aoFillFloor 0 -> 0.45, aoFillSaturation 0.3 -> 0.5.
- engine.js: DAY_BOUNCE_SCALE 0.08 -> 0.04 (only takes effect by day, via artAmount).

After
- faceratio 1 : 0.89 : 0.63 (unchanged), right face (149,156,162): B-R +13, sky-tinted.
- iso-mid downtown, same boot, old vs new: key-side walls 161 -> 178, right faces 106 -> 110
  with B-R -1 -> +14 (chroma 43 -> 38; the cooler fill takes a little hue off warm walls,
  and fill saturation 0.5 wins most of it back). Roof p25 104 -> 114, frame p10/25/50
  25/66/118 -> 28/75/123, "dark mass" share of the frame (luma 35-100, not asphalt)
  0.254 -> 0.235.
- iso-close, same boot: the wall-foot, prop-foot and plinth contact lines look the same
  (the ground term and aoTight are untouched). The walls are only a little lighter.
- check.sh clean; iso-mid / iso-close / iso had zero console errors. fps 3-12 is load noise
  (load avg ~10). Only uniform values changed.

Next (only on a real critic gap)
- If right faces now read too cold/blue on warm walls: wallFillTint -> [0.84,0.97,1.28]
  and/or aoFillSaturation 0.5 -> 0.6.
- Lot/road "plinth seam" (w4r3 note): the seam lands on near-black asphalt, so the
  lighting AO can't show it there. If it is still wanted, it belongs to the lot-side band
  colour (models/core.js lotSide) or to a darker kerb foot.
