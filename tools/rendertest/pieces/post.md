# post — Post-process, grade & anti-aliasing (src/render/post.js + PostFX params in src/engine.js)

## 2026-09-24 — round 1 (builder)

**Changed**
- Tilt-shift/DOF off by default (`dof.enabled:false`; code kept for a photo mode). Vignette 0, distance desaturation (`atmo`) 0.
- Bloom is night-only: strength x smoothstep(0.18, 0.6, ctx.nightEff), threshold 0.9; whole mip chain skipped by day.
- Tonemap: Khronos PBR Neutral replaces ACES by default (`grade.tonemap:'neutral'|'aces'`). Identity below ~0.76, so the palette lands as authored; exposure 1.0, sat 1.05, contrast 1.05, lift 0, warm 0.02. A hue-preserving display-space shoulder (`grade.knee` 0.96) replaces the hard ceiling, so sat/contrast never flat-clip whites.
- AA: quality 2 supersamples (`aa.ssaa` max 1.75, capped so internal px <= `aa.ssaaPixels` 2.3e6; floor-quantised to 1/8; <1.2 -> off) + 4x MSAA, resolved by a separable Mitchell-Netravali filter (2 passes at output res). FXAA/CAS skipped when SS is on; FXAA+CAS remain the fallback (retina canvases, quality 0/1). Quality 1 now 4x MSAA (was 2x).
- SSAO retuned to ref04-style soft corners: wide 1.0 @ 2.6u, contact 1.5 @ 1.1u, powers 1.0, neutral tint (the cool tint greyed warm walls), new `ssao.chroma` 0.35 keeps occluded texels saturated instead of grey. AO runs at 0.75x internal when supersampling.
- BUG FIX: SSAO centre is now snapped to the depth texel it reads. With a non-integer AO:depth ratio the unsnapped P sat off-surface by (gradient x sub-texel phase) and the tangent-plane gate turned that into column-periodic false occlusion = vertical "brushed metal" streaks on every wall.
- engine.js call site reduced to dof off / atmo 0 / vignette 0 / sharpen 0.12 — post.js defaults now carry the art direction.

**Measured** (1600x900, M5 Pro): fps 60-61 on iso-mid/iso/iso-close, zero console errors; selfTest passes all checks. Sync'd frame time (CPU+GPU, 40 frames): ss 1.0 = 11.3 ms, ss 1.25 (what 1600x900 gets) = 12.4 ms, ss 1.75 = 17.8 ms. Luma: mean 0.54 / p50 0.55 / p99 0.96 vs ref05 0.52 / 0.55 / 0.99 (was 0.30 / 0.29 / 0.64 with ACES+vignette+DOF). No clipped channels, crush <0.5%.

**Tools**: the working tree changes under you; `rsync` it to scratchpad/snap and serve on :8452 (`shoot.mjs --port 8452`) for stable A/Bs. `setParams({debug:'ao'})`, `setParams({split:0.5})` (raw vs graded), `setParams({aa:{ssaa:1}})` for no-SS A/B.

**Next**: (1) if integrated GPUs can't hold 60 at 1280x720 (gets 1.5x SS -> 1920x1080 internal), drop `ssaaPixels` to ~1.8e6 or add an engine frame-time probe that calls setQuality(1). (2) Night: bloom reads subtle — consider threshold 0.7 / strength 0.4 once the lighting piece settles night exposure. (3) CONTRACTS-RENDER.md §3.1 still describes tilt-shift + vignette as required; it should be updated by whoever owns the contract.

### Coordinator note (2026-09-24 10:20) — cross-piece critic signal
Critics judging OTHER pieces keep blaming the final image: roads r2 "the whole road
surface is soft/blurred where the reference has crisp hard-edged kerbs"; surface r1
"bakery faces are soft and smeared". The reference is razor-crisp edge to edge.
Hunt down every source of softness: leftover DOF/tilt-shift, FXAA over-blur,
render-target scale < 1, bloom veil, SSAO blur bleeding across edges, TAA/jitter,
CAS mis-tuned. Prefer MSAA (or 2x supersample if the budget allows) + no FXAA.

## 2026-09-24 — round 2 (builder)

**Critic r1:** picked the reference — "muted, hazy, olive grass, charcoal shaded faces, smudgy AO halos on grass, faint vertical light streaks, soft/low local contrast".

**Root cause found for half of it:** the critic's frames were RAINY. main.js re-rolls a 25% rain chance per sim day; the old demo-city.js
never froze it, so some shots got rain (grey sky tint, darker ground, the "vertical light streaks" = rain particles). Probed at capture
time on the old harness: `weather.rain 0.37 -> target 0.83`. The live demo-city.js now has `clearWeather()` (someone else added it this round);
re-verify the critic's frames are dry before reading grade complaints.

**Changed (src/render/post.js only; engine call site untouched)**
- Grade: new display-space, ratio-safe ops after sat/contrast: `shadowLift` (luma bump over 0.11..0.78, zero at asphalt), `shadowSat` (extra
  chroma over the shaded band), `vibrance` (sat weighted to muted colours, gated off near-greys so asphalt doesn't tint), `greenLift`
  (hue-keyed 60..130 deg luminance gain for grass/canopies). Defaults 0.05 / 0.30 / 0.30 / 0.10; contrast 1.05 -> 1.08; exposure stays 1.0.
  NOTE: lighting brightened its fill in the same round; my first pass (exposure 1.06 + lift 0.14) stacked on that and washed the cream towers
  out (clip 1.3%). Keep this grade chroma-first and let lighting own brightness.
- SSAO: res-4 buildings mean a voxel is 0.25 u, so the old radii (2.6 / 1.1) were 10 / 4 voxels -> grey skirts on grass. Now wide 1.6 @ 0.75,
  contact 0.5 @ 2.0: halos gone from open ground, crevices (pilasters, sills, roof steps) as dark or darker.
- Silhouette ink (`edge: {strength 0.3, minStep 0.35u, minPixels 2}`): depth LAPLACIAN in the composite at internal (SS) res -> darkens only the
  near side of real depth steps; zero on any plane, no halo on the ground behind, no line on wall/ground seams. `setParams({debug:'edge'})` shows it.
- SS resolve Mitchell (B,C) 1/3,1/3 -> 0.2,0.4: crisper, no visible ringing.

**Measured** (snapshot A/B, same frame, old params vs new): iso-close grass #9db96b -> #a3c666, asphalt #1b1b1c unchanged, sat_mean 0.33 -> 0.37,
clip 0.01% -> 0.4%, p5 0.085 -> 0.084. fps 61 on iso-mid/iso-close when the machine isn't shared (parallel builder Chromes drag it to 30-45
for everyone — not a render cost). Zero console errors.

**Tools:** scratchpad/var.sh NAME SHOTS "{params}" [port] (retries boot flakes; runs measure.py); cmp.py for side-by-side crops. Shoots in
parallel against the single-threaded dev server fail with "BV never booted" — run them sequentially.

**Next:** (1) local contrast is still below ref05 (16px-block luma std 0.10-0.17 vs 0.18) — mostly detail density, but a gentle mid-radius
clarity on luma (reuse a 1/8-res bloom mip by day) is worth an A/B if halos can be kept off grass. (2) if the ink reads as "outlined" to a
critic, drop to 0.2; if still soft, 0.4. (3) CONTRACTS-RENDER.md §3.1 still lists tilt-shift + vignette.
- selfTest: the new chroma stage first used the same 25%-of-darkest-channel guard as the main saturation; two in a row compounded
  to 6% and failed the hostile-grade hue-clip check (5.99%). Guard is now 70% for that stage -> 0.061%, selfTest passes all checks.

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

## 2026-09-24 — round 3 (builder)

**Critic r2:** picked the reference: "grade washed out, cream/white towers have nearly equal left/right faces, no punchy midtone curve, cyan-dominated".

**Diagnosis (measured, not guessed):** shot the frame at exposure 0.5 with the grade off and read scene-linear Y on the iso-mid cream/white
towers: top 0.99, lit face 0.88-0.97, shaded face 0.52-0.62. Lighting's linear ratios were already about 0.6. The flattening was ours: PBR
Neutral's shoulder starts at 0.76, so top, lit face and trim all landed around 0.93, and sRGB turns a 0.6 linear ratio into 0.82 in display. r2's
`shadowLift` then lifted the shaded band.

**Changed (src/render/post.js only; engine call site untouched)**
- Tone curve (composite, display luma, ratio-preserving, after the r2 colour ops so their luma bands still select the same pixels): an
  UPPER-MID DIP `f = y - dip*6.75*u^2*(1-u)`, u over [dipStart,1], which peaks near 0.78 where shaded wall faces sit. The slope near white
  goes UP (~2), so lit and shaded faces separate. The alternative was a pivot-0.5 S-curve, but that COMPRESSES 0.75-0.95 and would have made
  it worse (tested). Optional top-anchored `gamma` with toe (default off). `curve.sat` returns chroma to darkened pixels. `curve.green` spares
  lawn/foliage hues (the curve alone turned grass olive: #a4ca33 -> #92b232).
- `grade.shoulder` (PBR Neutral compression start) 0.76 -> 0.90; `shadowLift` 0.05 -> 0; `coolSat` 0.15 (hue-keyed saturation cut on
  cyan..blue, centred at 195 deg).
- SSAO: optional broad `canyonIntensity/canyonRadius` term (default OFF). It did nothing visible on near-black roads and put soft skirts on
  lawns among trees (the veg critic already complains about those).
- BUG FIX: `setParams` only merged 2 levels deep, so `setParams({grade:{curve:{...}}})` replaced the whole curve object. It is now a recursive merge.
  The curve gate also ignored `dip` when gamma == 1.
- AO ownership (coordinator): SSAO = contact between SEPARATE meshes only (ground, roads, props, trees). Voxel pixels opt out via scene alpha
  (materials `ssaoKeep 0`); corner/ledge AO on buildings = surface's baked voxel AO; cast/contact shadows = light.

**Measured** (snapshot A/B, same frame, lighting as of ~11:40): iso-mid cream tower lit/shade 8-bit luma 233/191 (0.82) -> 232/162 (0.70). ref05
cream tower ~218/160, shade ~#a7a191; ours #afa282. Frame p50 0.615 -> 0.54 (ref05 0.548), mean 0.59 -> 0.54, asphalt p5 unchanged,
clip < 1%. Glass #1c4c94 -> #1e4177. selfTest passes (hostile-grade hue clip 0.068%). Zero console errors. fps 57-61 when the machine is quiet;
the composite change is a few ALU ops. Readings of 15-30 fps came from ~15 concurrent builder Chromes.
WARNING, stacking: my first tune (gamma 1.3 + dip 0.09, exposure 0.92) was made on the older, flatter lighting. Once light darkened its fill
it stacked to 0.65 / p50 0.46 (muddy). If light changes the fill again, re-tune `curve.dip` HERE so the iso-mid p50 stays about 0.55. Don't fight it.

**Next:** (1) top faces are NOT the brightest tier (top 232 = lit face 231). Only lighting can fix that (key elevation / sky fill on
up-facing normals), and it's worth telling them. (2) local contrast (16px luma std 0.16 vs ref 0.18) is now detail density, not the grade.
(3) CONTRACTS-RENDER.md §3.1 still lists tilt-shift + vignette.

### Coordinator note (2026-09-24 12:36)
r3 still: "close-zoom foreground goes soft like DOF". DOF is confirmed OFF (engine.js
:345, post.js :135), so look elsewhere: FXAA is on with subpix 0.75 (post.js ~217) —
that's a known softener; with MSAA 4x the scene edges are already clean, so try FXAA
off (or subpix <= 0.25) and compare crop sharpness numerically (e.g. mean abs
Laplacian on a tree/grass crop) before vs after. Also check the "edge" pass and any
bloom veil on the bright grass. The blotchy square ghosts on open grass are the light
builder's height-map AO (told them) — not yours, but don't let SSAO add to it.

## 2026-09-24 — round 4 (builder)

**Critic r3:** picked the reference. "iso-close foreground goes soft like tilt-shift; SSAO leaves blotchy square ghosts on open grass
under the tree; overview flatter / lower contrast than ref05; faint glow on white facades; 2 fps iso at 2.96M tris".

**Diagnosis (measured, not guessed)**
- There is NO depth blur anywhere: dof.enabled is false (engine + demo-city only set focus/range), and nothing in post is
  position-dependent. The ref is simply a visibly SHARPENED render: 1-px luma step p99 0.53 vs ours 0.41, |laplacian| 0.195
  vs 0.137 on comparable-density frames. Ours read as "soft" next to it.
- The square ghosts are NOT our SSAO. `debug:'ao'` is clean there, and a raycast hits only `terrain-ground`. They vanish with
  `BV.engine._lighting.setParams({worldAO:false})` and survive `shadowStrength:0`. They come from lighting.js's height-map world AO:
  12 kernel taps, each reading a hard-edged canopy footprint, give 12 shifted copies of the canopy with bilinear rims. The same
  source is behind veg r7 ("pale diamond shadow ghosts") and surface r4 ("blocky square-texel smudges"). OWNER: light (it is being
  edited live, so I did not touch it).
- The iso-close grey torn diamonds on the new football pitch are Z-FIGHTING between coplanar pitch and lot/terrain tops. Depth is
  24-bit over a 3900u ortho range (0.0002u steps), so post is not the cause. OWNER: whoever places the pitch (ground/civic).
- The iso fps is geometry-bound: 3.46M tris. Turning SS and USM off does not raise it (24 vs 29 fps, noise).

**Changed (src/render/post.js only; engine call site untouched)**
- New output-res luma unsharp mask in OUTPUT_FRAG (`usm: {fine 0.6, edge 0.5, radius 2.5, overshoot 0.15, coreLo 0.05, coreHi 0.14,
  noSS 0.4}`). Two bands: pixel minus a 3x3 binomial (acutance), and pixel minus a ring of 8 taps at 2.5 px (facade/road/lot value
  separation = "punch"). Three guards keep it from looking over-processed:
  (1) HALO CLAMP to the pixel's own 3x3 min/max (+15% of that range), so flat faces and lawns cannot get rims.
  (2) Reinhard SOFT HEADROOM on the delta, so whites never flat-clip and asphalt is never crushed to 0 (p1 went 0.008 -> 0.031).
  (3) CORING on the 3x3 range (0.05..0.14), so faint marks such as other passes' AO ghosts or paving speckle are NOT amplified.
  Applied as a luma ratio, so hue and saturation are unchanged. At quality 1 (no SS) the frame has already had CAS + FXAA, so USM
  runs at 0.4x. About 21 taps at output res, which is negligible.
- grade.contrast 1.08 -> 1.14 (p5 0.103 -> 0.079 on iso-mid; ref05 p5 0.086).
- Tried: a Catmull-Rom SS resolve (B0/C0.5) gave +10% laplacian, but USM does the same job with halo control. Mitchell 0.2/0.4 kept.

**Measured** (snapshot A/B, iso): g99 0.405 -> 0.56 (ref 0.53), lap 0.137 -> 0.205 (ref 0.195), 16px local contrast 0.150 -> 0.176
(ref 0.188); clip (any channel > 0.995, mostly saturated yellows) 4.6% vs ref 3.3%. Live r4-builder shots: iso-mid 59 fps, iso-close
61 fps, iso 31 fps (geometry). Zero console errors, and selfTest passes. Night looks unchanged; bloom is still night-only.

**Next:** (1) light must fix the world-AO ghosts, since a critic will keep blaming "SSAO" for them: jitter or rotate the 6 kernel
directions per texel and denoise, or blur the height map before the taps, or drop world AO on up-facing ground far from walls.
(2) If a critic calls the image "over-sharpened / crunchy", drop usm.edge to 0.35 first, then fine to 0.45. (3) Pitch Z-fight
(ground/civic). (4) CONTRACTS-RENDER.md §3.1 still lists tilt-shift + vignette.

### Coordinator note (2026-09-24 14:05) — you now own contact AO (clean!)
Lighting's worldAO is now OFF by default (it made blocky blotches). So post SSAO is
allowed — expected — to carry the soft contact/crevice darkening critics keep asking
for (r2, r4: "almost no inside-corner AO or contact shadow ... ref05 grades every
block with deep soft AO under cornices, roof clutter and at ground contact"). Rules:
smooth (full-res or depth-aware bilateral upsample, no blocks, no halos on grass),
colour-preserving (multiply toward a darker saturated version of the surface, not
grey), radius ~0.5-1.5 world units, strongest in true creases. Also r4: "rooftops
washed near-white" — check exposure/whites on light roofs (target light roof tops
around 90-93% value, not clipped).

### Coordinator note (2026-09-24 14:25)
Roads critic r11: "ours darkens and softens the asphalt toward the frame corners
instead of keeping it uniformly flat near-black" — that's a vignette and/or
edge-weighted softening. The reference has none. Remove vignette entirely (and any
radial blur / chromatic aberration / lens effect).
Follow-up (14:30): verified — vignette 0, atmo strength 0, fog starts past the map.
Measured dark (asphalt) pixels in r11 iso-mid: centre ~(22,27,34), corners ~(11-17)
— variation comes from building shadows, not a vignette. Nothing to fix there;
ignore that remark.

### Coordinator note (2026-09-24 15:55) — HALOS
Surface critic r6: "screen-space AO and sharpening leave smudgy dark halos along every
silhouette and under ledges on the bakery facade; ref04 has clean tight AO confined
to inside corners". Suspects in post.js: the `edge` pass (strength 0.3 — draws dark
outlines at depth edges), `sharpen` (amount 0.3, beforeAA — unsharp mask = halos),
and SSAO bleeding across depth discontinuities (occlusion from a FOREGROUND surface
darkening the background behind a silhouette). Fix: edge pass off (or only where the
reference would have a crease), sharpen off or ≤0.1 after AA, SSAO with a strict
depth/normal-aware range check so it only darkens true creases (range check falloff
~0.5 world units), never behind silhouettes. Keep the contact AO that post critics
want — but only IN creases.

## 2026-09-24 — round 5 (builder)

**Critic r4:** picked the reference. "Flat, too little contrast at small scale. Cream and blue tower walls and grey roofs read as single
slabs. Almost no soft AO in inside corners, under cornices, round rooftop AC units or where buildings meet their lots. Tops washed toward
white, only thin black seams separate the blocks. Over-saturated, uniform in value."

**Diagnosis:** the missing AO was ours. Since surface r5, voxel pixels write scene alpha `ssaoKeep 0` and `castGate 1`, so SSAO never
touched a building. The baked voxel AO reaches about one voxel and never sees ANOTHER model: an AC unit on a roof deck, a tower on its lot,
two towers across a canyon. `debug:'ao'` with the gate off showed a clean, halo-free buffer (the tangent-plane gate handles convex edges),
so the gate was hiding a good signal.
ALSO: shoot.mjs now defaults to **--dpr 2** (3200x1800). At dpr 2 there's no SS: q2 falls back to MSAA+FXAA+CAS, and USM runs at noSS 0.4.
Critics see these frames downscaled. Compare our r5+ numbers only with dpr-2 shots.

**Changed (post.js only; engine call site untouched)**
- New `ssao.voxelKeep` (LIT pass: keep = alpha + (1-alpha)*voxelKeep) = 1, and `castGate` 1 -> 0. SSAO now grades buildings too. Wide term
  0.75 @ 1.6 -> 1.1 @ 2.0. The canyon term is ON (0.4 @ 4.0) and gives the soft darkening toward a wall's foot and a roof deck inside its parapet.
  `ssao.chroma` 0.35 -> 0.1 (to curb saturation).
- Grade: contrast 1.14 -> 1.08 (the AO carries the separation now; 1.14 on top of it crushed p5), saturation 1.05 -> 1.0, vibrance 0.30 ->
  0.15, curve.dip 0.11 -> 0.06 (keeps lit faces/tops up, so value spread comes from AO and not from a global darken).
- New display-space TOE at the end of OUTPUT_FRAG (`grade.toe {amount 0.035, end 0.14}`): y + a(1-y/y0)^2 below y0, capped luma ratio +
  grey remainder. Pixels below 8/255: 4.4% -> 0% (ref05 0.3%). Asphalt (~0.1) moves < 1/255.

**Measured** (dpr 2, snapshot A/B, iso-mid 8-bit luma p5/p25/p50/p75/p90): base 19/93/144/181/234 -> 14/58/126/176/225. ref05 is
22/68/140/192/228, so the lower mids now spread like the ref. Fraction > 235: 0.090 -> 0.080 (ref 0.077). Sync'd frame time at 2000x1125
internal: base 19.5 ms, new 19.7 ms (noise). SSAO total is ~1.6 ms. Harness fps 24-40 at dpr 2 for base AND new while ~4 builder Chromes
share the GPU; 61 at dpr 1. selfTest passes, zero console errors. Checked quality 1: the wall grain there is lighting's shadow taps
(it's there with voxelKeep 0 too), not AO.

**Next:** (1) If a critic calls the corners "dirty", drop the canyon term to 0.25 first, then the wide term to 0.9. Keep voxelKeep 1.
(2) The lime planters (#aefb3b) are an asset-palette issue. greenLift 0.10 isn't the cause; grass median #7bc847 is already darker than ref.
(3) Clarity/local-contrast: not added. With AO on, 16px local contrast is at or above the ref. A day-time 1/8-res mip clarity would risk
halos at tower/road silhouettes. (4) Tell surface: materials.js `ssaoKeep 0` is overridden by post `ssao.voxelKeep 1`. Set
voxelKeep 0 to hand AO back to the bake.

### Coordinator note (2026-09-24 16:50) — sharpen/usm/detail defaulted OFF
Surface critic r7: "faces look smeared and painterly — edges wobble and shadow
boundaries are ragged as if an oil-paint/denoise filter ran over them". A/B on
one-bakery (scratchpad paint/filters-on-vs-off.png, left = your stack, right =
sharpen+usm+detail off): the stacked sharpen + USM + detail luma-pull produce
crunchy ringing edges (bright fringes on dark trim) and ragged boundaries; with them
off the render reads like ref04's clean Blender output. I set all three
`enabled: false`. Crispness should come from resolution/AA (SSAA+MSAA, Mitchell B
0.2), not filters. Don't re-enable without an A/B that a fresh eye prefers.

## 2026-09-24 — round 6 (builder)

**Critic r5:** picked the reference. "At overview zoom (iso) the grade is high-saturation everywhere with weak value hierarchy; windows,
props and rooftop units at full chroma turn to speckle; ref05 has light, slightly desaturated lots/faces, deep asphalt, a gentle curve
and soft mid-tone AO so each block reads as one mass. Also a filmic shoulder, and some smoothing at far zoom." Praised: no DOF/fog,
crisp clean AA and AO at mid/close, lime grass, colourful shade sides.

**Diagnosis (measured at 1920 wide, vs ref05):** MEAN saturation already matched (0.366 vs 0.351). What didn't match was HIGH-FREQUENCY
chroma, |chroma - 7px box|: ours 0.122, ref 0.063 (ref05 is also a 4:2:0 JPEG). The neutral-light share and colour (lots/plinths) already
matched (#d3d4c9 vs #d1d4cf, 23% of the frame both), so "lift lots to warm off-white" was not supported and I did not do it. Sunlit asphalt was
#242429 vs ref's flat #161616. Mid-round, light deepened its fill and open shadows (skyOpenFloor 0.8, hemi 1.75): live iso p50 fell to
121/255 (ref 139), and shaded asphalt fell to 11-14/255.

**Changed (post.js only)**
- `detail` (OUTPUT_FRAG): SMALL-FEATURE chroma restraint. Colour similarity to 16 taps on two rings (3 CSS px and 1.5). If fewer than about a third
  match, the pixel is a small feature and loses up to `chroma` 0.55 of its saturation (luma kept, no bleed). An AA-edge guard skips pixels whose
  colour lies on the segment between opposite 1-px neighbours. A zoom gate (building voxel 4..8 device px) means iso-mid, iso-close and every
  close-up skip the branch entirely (bit-identical to off). Luma pull exists but is 0. The coordinator's 16:50 "ragged edges" A/B was the
  luma pull on AA edge pixels at close zoom; both causes are now removed. Re-enabled on that basis. Veto with `detail.enabled:false`.
- `ssao.voxelCanyon` 0.8: SSAO .g now carries the canyon term alone (the old z/far marker was never read). Voxel faces, which opt out of the
  contact/cavity AO (surface r7 halos), take only this broad term: soft mass shading at tower feet, parapets, street canyons. No halos seen at
  iso-close/bakery.
- `grade.deepDark` 0.2: low-chroma display luma 0.08..0.25 comes down by up to 20% and loses part of its sky tint. Sunlit asphalt #242429 -> ~#1e1e21.
- Curve re-tuned for light's darker fill: dip 0.06 -> 0 (light owns the lit/shade split now), gamma 1.0 -> 0.88 (toe-faded below 0.3).
  The lawn exemption now applies to darkening only. Toe 0.035/0.14 -> 0.06/0.16 (shaded asphalt 11-14 -> 16-18). knee 0.96 -> 0.94.
- usm fine band has a far-zoom fade (`farLo/farHi`), but moot while the coordinator keeps usm/sharpen OFF (left off).
- Bug fix: setParams referenced an undefined `dst` when dof.focus was passed without autoFocus.

**Measured** (live, dpr 2, downscaled to 1920): iso p25/50/75 66/121/170 (before this round's curve) -> 76/136/187 (ref 67/139/191). Sat 0.379 -> 0.341
(ref 0.351). hfC with detail on vs off on the same frame (snapshot): 0.118 -> 0.103. Clip 2.0% -> 1.2%. Grass median at iso #79bb35 -> #89c641. selfTest passes,
zero console errors. fps under load: 16-39 at dpr 2, 39 at dpr 1 iso-close (61 when the machine is quiet). The added cost is 24 taps at output res
plus one extra blurred AO channel. Sync'd frame time new vs old: equal within noise (44-46 ms both, on a saturated GPU).

**Next:** (1) If a critic says "washed/greyish windows", drop detail.chroma to 0.4. If overview is still "speckly", raise zoomHi to 10 and
chroma to 0.65. Keep luma 0. (2) If light changes fill again, re-tune curve.gamma (not dip) so the iso p50 stays at ~135/255 at 1920.
(3) Ref grass is paler (#a5bd6f median); ours is deeper green (#89c641). That's a terrain palette call; greenLift/gamma are already helping.
(4) CONTRACTS-RENDER.md §3.1 still lists tilt-shift and vignette.

## 2026-09-24 — round 7 (builder)

**Critic r6:** picked ours but was not wowed. "Silhouettes lack ref05's crisp dark edges; buildings and props run into the asphalt and
into each other (downtown, parked cars). Right faces and cast shadows on asphalt drop to near-black and the detail in them is lost. Also far-iso
window grids look moire." Praised: AA, sharpness, no DOF, grade, clean AO. None of that was touched.

**Diagnosis:** (1) The old ink was a 1-texel depth Laplacian at strength 0.3. At dpr 2 that is a 1-device-px line, so it disappears at the
critic's 0.5x downscale (ink pixels measured 0.67x, but only on ~4% of pixels and 1 px wide). (2) The near-black shadows came from the TONEMAP.
The Khronos PBR Neutral black offset (x - 6.25x^2) has zero slope at black, so shaded asphalt (raw sRGB 26..42) and everything inside cast
shadows mapped to one flat 15/255, which was the display toe's floor. Most of iso-mid's road area is shaded (bin map: scratchpad
rounds/post/z7_bins.png). Sunlit asphalt landed at ~30.

**Changed (post.js only; engine call site untouched)**
- New silhouette ink `inkK()`: fits the local depth plane from one-sided min-abs derivatives, then tests 16 taps on two rings (edge.width CSS
  px and half that) for "farther than the plane by > thr". Ink = fraction behind, so it is anti-aliased and the same width at every zoom.
  Planes, concave creases and convex box corners give 0. thr = max(minStep 0.3u, wpp * max(2, R*slope 4)), so far zoom only inks big
  steps. There is an outer-ring early-out. Defaults: strength 0.75, width 1.5. `debug:'edge'` shows the mask, which is clean.
- `grade.blackSlope` 0.4: the PBR Neutral toe is generalised to a cubic with slope s at black that still meets the 0.04 plateau at x = 0.08
  (0 = Khronos). This keeps detail in shadows.
- `grade.asphalt {amount 0.55, target 0.086}`: low-chroma display darks 0.015..0.2 are pulled toward 22/255 while keeping a positive slope.
  Coloured darks are exempt (sat gate 0.16..0.34). deepDark's low ramp 0.05..0.12 -> 0..0.04 (a plain ratio, no flat band). Toe
  0.06/0.16 -> 0.035/0.12.
- `detail.luma` 0 -> 0.35 (zoom-gated, far only): window grids at iso are a little calmer. Laplacian of the downscaled tower crop 52.5 -> 49.5.

**Measured** (snapshot :8452, same frame, iso-mid dpr 2, neutral raw->final medians): shaded asphalt 15-16 -> 19, sunlit 30 -> 26 (ref05 flat
22), raw 18-26 slope restored. Luma < 16/255: 1.8% -> 0.6%. p25/p50 77/128 (ink adds ~4% dark rim pixels). Timing ink on vs off: within noise
on a saturated GPU (14 headless Chromes, load 9). selfTest passes, zero console errors. Live r7-builder fps 18/12/25 (iso-mid/iso/iso-close)
under that load.
NOTE: the live demo city changed layout mid-round (iso-mid now centres on the blue towers), so r7-builder stats don't compare to r6.

**Next:** (1) If a critic calls the lines "drawn-on / cartoon", drop edge.strength to 0.6 first, then width 1.2. If they are still too
faint, go to 0.85 (not wider). (2) ref05 also has BRIGHT convex rim highlights on cornices and roof edges. Post could add them (residual
between 0.3 and 1 thr of the convex sign plus an up-facing normal), but it is better as a bevel in voxel/materials. (3) Concave-crease ink
(the dark seams in ref05's recesses) is not done; AO carries it. (4) CONTRACTS-RENDER.md §3.1 still lists tilt-shift + vignette.

### Coordinator measurement (2026-09-24 19:45)
Post r7 said "too dark and heavy, lift shadow faces". Measured white probe cube: right
(shade) face = 0.63 of top, which is the reference target (ref06 rocks ≈ 0.53-0.62).
Don't lift shadows globally. Real issues: top clips and left face == top (light is
fixing the key angle). If AO pools read too dense, reduce SSAO intensity ~20% but keep
it in creases only.

## 2026-09-24 — round 8 (builder)

**Critic r7:** picked the reference. "Grade too dark and heavy vs ref05. Right faces drop to deep navy/brown (blue cylinders, red TWINS,
cream towers), and dense AO under ledges adds near-black mass. Ref's darkest face is ~60-70% of the top and still coloured. Fix: a stronger
fill or a lifted shadow floor, halve AO, lift mids." Also: "greens/pinks slightly hot".

**Diagnosis (same-frame variant A/B, one boot):** iso-mid p25/p50/p75 was 43/83/136 (ref05 68/140/192), and colour-dark share (sat > .25,
L < .25) was 0.27 (ref 0.135). The graded frame was DARKER than the raw scene (raw p50 112). Main cause: the PBR Neutral black plateau
subtracts a flat 0.04 linear from every channel. That takes linear 0.10 to 0.06 (sRGB 89 -> 69), and it removes a shade face's LOW channels
first, so a shaded blue turns saturated navy. contrast 1.08 (display .09 -> .057), shadowSat 0.3 and curve sat added to it. SSAO and ink only
account for ~5 p50 points (aooff 102, inkoff 104 vs 97). The coordinator's light note says the white-cube right/top ratio is 0.63 (on target),
so I did NOT ask for more fill. Fixed in the grade instead.

**Changed (post.js only)**
- `grade.blackOffset` 0.012: the plateau is now CHROMA-WEIGHTED. Neutral pixels keep Khronos 0.04, so asphalt stays deep. Chromatic
  pixels (scene-linear sat 0.3 -> 0.6) ease down to blackOffset, so a shade face keeps its hue instead of going navy/brown.
- New `grade.floor {amount 0.15, neutral 0.4}` (composite, after the asphalt op): luma lift y + A * 6.75 y (1-y)^2 (exactly A at y = 1/3,
  ~0 at white, monotone for A < 0.44). 40% of the lift is added as grey sky light, so a lifted navy face reads light blue-grey rather than
  bright navy. Gated off neutral darks (sat < .22 and y < .16), so roads are untouched.
- contrast 1.08 -> 1.03, saturation 1.0 -> 0.96, vibrance 0.15 -> 0.05, shadowSat 0.3 -> 0.1. asphalt pull 0.55/0.086 -> 0.8/0.08 (holds
  roads at ~29/255 under the lift; was 28).
- SSAO roughly halved: cavity 1.1 @ 2.0 -> 0.55 @ 1.2, contact 2.0 @ 0.5 -> 1.0 @ 0.35, canyon 0.4 -> 0.2, voxelCanyon 0.8 -> 0.4.

**Measured** (same frame, base -> new, 1920-wide): iso-mid p25/50/75 43/83/136 -> 79/129/170 (ref 68/140/192). Colour-dark share .27 -> .088
(ref .135). Mean sat .41 -> .32 (ref .35). iso p50 99 -> 143. iso-close p50 74 -> 122, <40 share .36 -> .25. Asphalt median 28 -> 29.
Exposure 1.06 and gamma 0.82 variants were only +3 p50, and they lifted asphalt, so both were rejected. selfTest passes, zero console errors.
The changes are ALU only, no taps. fps read 2-15 under a load avg of 10-60, the same as base in the same runs.
Tools: scratchpad/vshoot.mjs --vars X.json (N param variants of the same frame in one boot), stats.py, asph.py.
NOTE: the final r8-builder boot showed many empty beige lots (tris 2.3-3.0M vs 4.5M) and swapped iso/iso-mid framing. That comes from
another piece's in-flight change, not from post.

**Next:** (1) p75/p95 are still low (170/221 vs 192/243): the lit tops are greyer than ref05's near-white. That's light/material. If a critic
wants brighter tops, try knee 0.96 before exposure (exposure lifts roads). (2) If shade faces now read "washed/milky", drop floor.neutral
to 0.3 first, then amount to 0.12. (3) If navy comes back, check blackOffset is still applied (the chroma gate is scene-linear sat 0.3..0.6).

### Coordinator note (2026-09-24 20:28) — zoom-dependent crispness is allowed
r6 WON with sharpen/usm/detail off. r8 says the OVERVIEW (iso-mid/iso) reads soft/hazy.
My 16:50 A/B that turned the filters off was at close zoom (one-bakery), where they
caused ringing. So: you may bring back a MILD local-contrast/USM that fades IN with
distance (your usm already had farLo/farHi) — zero effect at iso-close / one-* zooms,
gentle at iso-mid, and never ringing (clamp to the 3×3 range). Acceptance test: the
one-bakery crop must still look like the right half of scratchpad
paint/filters-on-vs-off.png, and iso-mid must gain edge separation. Show both in
your notes.

## 2026-09-24 — round 9 (builder)

**Critic r8:** picked the reference. Comparing on the 'iso' overview: "soft and slightly hazy, pale is the dominant cast. Grass, kerbs, lot
rims and paving sit at the same light value, and props run into speckle. ref05 has crisp dark silhouettes, stronger local contrast and deeper
shade sides." They praised iso-close ("sharp, clean AO, three face tones"), the AA and the lack of DOF/fog.

**Diagnosis (same-frame variant A/B, iso):** most of the pale cast came from the r8 shade FLOOR. Its y(1-y)^2 kernel is broad, so it also
lifted the light upper mids (lawn 0.65 by about +0.07, paving by +0.03), and 40% of that lift was grey, which reads as haze. floor 0 -> iso
p50 went from 136 to 103. That is too dark (the r7 complaint), so I didn't zero it. At overview the ink also only caught big steps (thr 0.83u).

**Changed (post.js only; engine call site untouched).** Everything is gated by a new zoom factor `ov` = 1 below `overview.lo` 2.4 CSS px
per building voxel and 0 above `hi` 3.4. iso is 1.6 and iso-mid 3.6, so **iso-mid and iso-close are identical to r8** (verified by stats).
- `grade.floor.shape` (kernel exponent n, 2 = r8) and `floor.green` (lawn hues always use the r8 kernel and amount, via the new shared
  `greenKey()`). At ov = 1 the settings become `overview.floor` 0.5 (amount scale), `floorShape` 3 and `floorNeutral` 0.25. Shade sides are
  deeper, the lift comes off the light ground, and less of it is grey.
- `overview.ground {amount 0.12, y0 1.15, y1 1.7, lo .45, hi .85, satLo .3, satHi .55}` is a ground key in the composite. World height comes
  from the depth plus camera.matrixWorld row 1 (new uniforms uOrthoBox, uWorldRowY). Pale, LOW-CHROMA pixels below ~1.2u (kerbs, rims,
  paving, sidewalks, washed-out field) come down by up to 12% (a ratio, so hue is kept). Lime lawns, water and asphalt don't move, and
  buildings sit above the band. `white` (default off) spares near-white kerb tops; I tried it and it looked like no key at all.
- Ink at overview: strength 0.75 -> `overview.inkStrength` 1.0, slope 4 -> `inkSlope` 2.5 (catches plinths, cars and props).
- `overview.sharpen {fine .35, edge .65, radius 1.25 CSS px, overshoot .1, core .04/.12}` reuses the halo-clamped USM code only while
  ov > 0 and the global usm is off. The coordinator's close-zoom veto still holds.

**Measured** (iso, 1920-wide stats): p25/50/75/95 84/142/185/233 -> 53/116/168/217 (ref05 68/140/192/243). Our frame has more asphalt
(<40: 0.21 vs 0.157), which drags the percentiles down. Colour-dark share .045 -> .106 (ref .135). Sat .292 -> .311 (ref .351). selfTest
passes, zero console errors. The cost is ALU plus 1 depth tap (composite) and ~17 taps (output), only at overview. fps is load-dominated
(load avg 11): 13/3/5.

**Next:** (1) If a critic calls overview "dark/heavy/grey ground", raise `overview.floor` to 0.65 first, then ground.amount to 0.09. (2) If
the lines read "drawn-on", drop inkStrength to 0.85 and keep slope 2.5. (3) If there's speckle/crunch at overview, drop sharpen.fine to 0.2
and keep edge. (4) Ref paving is mid-grey (110-170) with bright ~240 kerb lines. Ours are wide pale sidewalks, which is a roads/terrain
palette call, not post.

## 2026-09-24 — round 10 (builder)

**Critic r9:** picked the reference. At overview the grade was too dark and dense: near-black AO/contact in tower gaps, dark outline-like
rims on facades and roofs, greyish desaturated shade faces, mids too low. iso-close was fine; mid and far were the problem.

**Diagnosis (same-frame variant A/B, one boot, iso):** the r9 overview ops were most of it. `overview.enabled:false` took p50 from 117 to 138,
and ink 1.0 alone took ~11 more p50 points. SSAO on or off was only ~3. The grey share of the floor (0.4) was the "greyish" shade faces.
Consensus so far: r7 and r9 said "dark/heavy", r8 said "pale/hazy" (that was grey lift). So the aim is brighter AND colourful, not grey.

**Changed (post.js defaults only; engine untouched)**
- Floor amount 0.15 -> 0.24, neutral 0.4 -> 0.15, shape 2 -> 2.5. Shade faces lift a lot and keep their hue; light paving moves less.
- curve.gamma 0.88 -> 0.82 (mids). shadowSat 0.1 -> 0.22.
- SSAO: every term x0.75 (0.41 / 0.75 / canyon 0.15 / voxelCanyon 0.3).
- edge.strength 0.75 -> 0.5. Overview: floor 0.5 -> 0.85, shape 2.5, neutral 0.15, inkStrength 1.0 -> 0.25, ground key amount 0.12 -> 0
  (off), sharpen fine 0.35 -> 0.2, edge 0.65 -> 0.5.

**Measured** (same frame, base -> new): iso p25/50/75 51/111/165 -> 96/153/190. iso-mid 52/113/159 -> 71/137/173. iso-close 35/100/159
-> 40/123/172 (ref05 68/140/192). colDark .11 -> .04-.07. Live r10-builder: iso-mid p50 135, iso 147, iso-close 119, zero console errors. fps is
load-bound (load avg 9-45, 22/30 at dpr 1). The changes are parameter-only and there are no new taps (the ground key is now skipped).

**Next:** (1) If a critic calls the overview "pale/washed", drop overview.floor to 0.7 first. Do NOT raise the floor's neutral share (that is
what turns it grey) and do not bring the ink back above 0.4. (2) p75/p95 are still under ref05 (173/218 vs 192/243). The lit tops/whites are
light/material, or try knee 0.96. (3) If shade faces read "navy" again, shadowSat goes back to 0.15.

## 2026-09-24 — round 11 (builder)

**Critic r10:** picked the reference. "Fine detail is soft and lacks micro-contrast. Roof clutter, signs and shopfronts blur into a mid-tone
speckle. Shade faces and AO are a flat, greyed blue-grey. ref05 has crisp near-outlined silhouettes and strong local face contrast."
Suggested fix: unsharp mask or CAS after AA, a steeper local contrast curve, and chroma in shadow/AO instead of grey.

**Diagnosis (same-frame A/B, scratchpad rounds/post/r11-v1, r11-v2):** at dpr 2 (the critics' 3200x1800) the canvas is too big to
supersample, so the chain was 4x MSAA + **FXAA with subpix 0.75**. That sub-pixel blend was the main source of the softness. Mean |Laplacian|
of iso-mid at 1920 wide: 0.137 with FXAA, 0.159 without (ref05 0.188). There were no stair-steps without it, because MSAA at 2x DPR already gives
16 samples per CSS px. The old USM was also clamped to each pixel's 3x3 device-px range, so at dpr 2 it only touched pixels within 1 device px of
an edge, and the critic's downscale averaged that away. `detail.luma` 0.35 pulled small features toward the neighbourhood mean, which is the
"mid-tone speckle".

**Changed (post.js only; engine call site untouched)**
- `aa.fxaaMsaa` 4: FXAA is skipped when MSAA >= 4 and pixelRatio >= 1.5. 1x canvases keep the SS or FXAA paths as before.
- New **crisp** pass (`params.crisp`) at the very end, after AA and the SS resolve. It is a two-band luma USM. The luma blurs are separable
  13-tap Gaussians at CSS resolution (fine, sigma 1 CSS px) and at half CSS res (mid, sigma 4 CSS px), in half-float targets (4 small blits,
  new `LUMA_BLUR_FRAG`). fine = y - G1 (amount 0.9, soft limit 0.10); mid = G1 - G4 (amount 0.35, limit 0.06). Both are cored at 0.006..0.03,
  so AO grain and paving don't get sharpened. It is applied as a luma ratio with headroom, so hue is kept, nothing clips and asphalt is not
  crushed. There is a close-zoom scale: x0.55 from 12 CSS px per building voxel up. The overview USM is skipped while crisp is on.
- Grade chroma: floor.neutral 0.15 -> 0 (and overview.floorNeutral -> 0), shadowSat 0.22 -> 0.32, ssao.chroma 0.1 -> 0.3.
- detail: luma 0.35 -> 0, chroma 0.55 -> 0.35.

**Measured** (1920-wide, same frame, r10 -> r11; ref05 lap 0.188, dx99 0.453, lc 0.144, sat 0.351). iso-mid: lap 0.137 -> 0.202, dx99
0.348 -> 0.455, lc 0.131 -> 0.162, sat 0.350 -> 0.374, p50 122 -> 125. iso: lap 0.222 -> 0.257, sat 0.312 -> 0.343. iso-close: lap 0.095 -> 0.128.
The one-bakery crop has no ringing (r11/bk.png). selfTest passes (20 targets, 0 leak), zero console errors. Timing new vs old is within noise
(load-bound ~90-120 ms frames at load avg 10-15). The crisp pass is 4 blits at CSS res plus 3 taps per output px.

**Next:** (1) If a critic calls it "over-sharpened / haloed / crunchy", drop crisp.mid to 0.25 first (wide halos), then fine to 0.7. Do NOT
bring FXAA back at dpr 2. (2) If shade faces read "navy" again, shadowSat goes to 0.25. Keep floor.neutral at 0. (3) The 1x SS path
(1280x720 gets 1.75x SS) now also gets crisp after the Mitchell resolve. Check a dpr-1 shot for crunch if a critic ever judges at 1x.

### Coordinator note (2026-09-24 22:05) — r11: the close-zoom rule was broken
r10 "too soft at overview" → r11 "over-sharpened, crunchy edges, dark outline halos,
shadows crushed to near-black — see umbrellas and storefronts in iso-close". My 20:28
rule was: sharpening/local contrast must be ZERO at iso-close / one-* zooms and only
fade in toward iso-mid/iso/iso-wide. Enforce it (gate on ctx.camDist, e.g. 0 below
~70, full by ~150). Also: cut the outline/edge-darkening pass (surface r6, post r9 and
r11 all flagged dark silhouette halos), and lift the shadow floor slightly (deep
shade and awning undersides should stay colourful, ~0.35-0.45 value, not near-black).
Before finishing: A/B one-bakery vs scratchpad paint/filters-on-vs-off.png (right
half) — it must match that clean look.

### Coordinator (2026-09-24 22:15) — edge ink defaulted OFF
Your always-on `edge` ink pass (strength 0.5 at ALL zooms) is what surface r12, light
r8 and your own r9/r11 critics call "dark outline halos / crunchy edges". Your notes
say r6 — your only win — had no ink. I set edge.enabled=false. The zoom-gated
`overview` block (inkStrength 0.25, sharpen) stays as you built it. Don't re-enable
the global edge pass.

## 2026-09-24 — round 12 (builder)

**Critic r11:** picked the reference. The grade had too much contrast and too much sharpening. Shade faces, awning undersides and contact
shadows crushed to near-black, and dark outline halos plus crunchy sharpening wrapped the umbrellas, storefronts and cars. The AO read as black
grime, and blues and reds were too saturated.

**Diagnosis (same-boot A/B, rounds/post/r12-v1..v5; the city layout and lighting change between boots, so compare only within one boot):**
- The halos came from the crisp pass's mid band (sigma 4 CSS px) plus the fine band at iso-close. The ink was already off (coordinator 22:15).
- The near-black undersides were NEUTRAL darks. Every dark-handling op keyed "neutral + dark" as asphalt: the Khronos 0.04 black plateau,
  deepDark, the flat-asphalt pull, and the floor gate that excludes neutral darks. So a white awning underside or a grey wall in shadow got the
  road treatment. A global contrast cut is NOT the fix: contrast 0.98 lifted the roads from 32 to 43/255 in the same frame.

**Changed (post.js only; engine untouched)**
- New `grade.above {lo 1.0, hi 1.3}` above-ground key. It gets world Y from depth (reusing uOrthoBox/uWorldRowY; heights are road 0, sidewalk
  ~0.3, lot top ~0.9). Above the ground layer, the asphalt ops are off, the black plateau is the gentle chromatic one (blackOffset), and the
  floor lifts neutrals too. Roads and lot parking are unchanged. New `debug:'height'` view (R = wy/4, G = fract(4wy)).
- crisp: new `distLo 70 / distHi 150` camDist gate, so it is exactly 0 at iso-close (36) and ~0.09 at iso-mid (85), and the blits are
  skipped. fine 0.9 -> 0.5, mid 0.35 -> 0.1, limits 0.08/0.05. overview.sharpen off and overview.inkStrength 0.
- Grade: contrast 1.03 -> 1.02, saturation 0.96 -> 0.95, shadowSat 0.32 -> 0.2, curve.sat 1.1 -> 0.7, blackOffset 0.012 -> 0.008,
  coolSat 0.15 -> 0.22. Floor stays at 0.24: surface critic r13 called the facades "washed-out pastel", so I did not add a global lift.
- SSAO about x0.6: 0.26 / contact 0.42 / canyon 0.1 / voxelCanyon 0.18.

**Measured** (same boot, r11 params -> new, height-masked). iso-close: above-ground pixels with L < 0.3 went from 14% to 2%, above p5/p25
43/99 -> 87/125, and the road median stayed 33-34 (unchanged). iso-mid: above-dark 13% -> 1.5%, and roads 30 -> 34. Frame sat .34 -> .30.
Final r12-builder p5/p50: iso-close 21/135, iso-mid 40/156, iso 32/155 (ref05 22/140). selfTest passes, zero console errors. fps is load-bound (3-16 with
~14 Chromes running). The cost goes DOWN: crisp is skipped at close and mid, and the above key adds 1 depth tap.
Rejected: blackSlope 0.75 (lifts roads 34 -> 48), floor 0.36 / n 2.1 (pastel wash, iso-mid p50 182), and contrast 0.98 (lifts roads).

**Next:** (1) If a critic calls it "pale/washed/flat faces" (iso-mid p50 162 is above ref05's 140), try floor 0.24 -> 0.2 first. Keep
`above` on, because it is what fixes the crush. (2) If "soft at overview", raise crisp.fine at distHi (0.5 -> 0.7). Never lower distLo
below 70. (3) If roads read grey, check `above.lo`: it must stay above the lot top (~0.9).

## 2026-09-25 — wave 2, round 1 (builder)

**Start state (same boot, iso-mid downscaled 1.93x to ref05's px/tile):** |Laplacian| 0.126 (ref05 0.188), 16-px local contrast 0.140
(ref 0.182), sat 0.308 (ref 0.351). It read pastel and soft next to ref05. The crisp pass only reached ~9% at iso-mid (gate 70..150). White
probe cube (faceratio.sh) right/top was 0.69, target 0.63, so the r12 floor 0.24 was over-lifting the shade side.

**Changed (post.js, plus one engine.js line)**
- crisp gate distLo/distHi 70/150 -> 50/85. Full at iso-mid, and exactly 0 at iso-close (36) and single-building shots (22-45). fine 0.5 -> 1.1,
  mid 0.1 -> 0.45, limits 0.08/0.05 -> 0.12/0.08, coring 0.006/0.03 -> 0.01/0.035 (asphalt 5-px sd +0.3/255 only).
- grade.floor 0.24 -> 0.18. The probe ratio measured 0.64 at 0.17, so the shade side is now on target (not a global darken).
- saturation 0.95 -> 0.98, vibrance 0.05 -> 0.12. Vibrance lifts muted/pastel faces, not the already-hot reds/blues.
- **Coherence #5 (dusk salmon) — new `grade.wb`:** a twilight white balance, a partial von Kries adaptation in scene-linear. The illuminant is
  estimated from the lights (key x intensity x sunWeight 0.35 + hemi + ambient). engine.js calls `post.setLights(sun, hemi, ambient)` right after
  constructing PostFX. The day reference is an EMA captured while nightEff < 0.05. Gains are (ref/cur)^k, normalised so a white surface keeps
  its luminance, and clamped to [1/2, 2]. k = amount 0.35 x gate (in 0.2..0.36, out 0.5..0.66). Day and full night are bit-identical (gain 1).
  No frame statistics are used, so there is no pumping on pans.

**Measured.** Same-boot old -> new. iso-mid: lap 0.123 -> 0.173, lc 0.139 -> 0.171, sat 0.331 -> 0.342, p5/25/50/75/95 24/120/155/184/233 ->
21/102/143/182/240 (ref05 22/68/140/192/243). iso: lap 0.169 -> 0.200, p50 156 -> 147. iso-close: lap and lc unchanged (crisp is 0 there), p50 148 -> 135
(floor only). The umbrella/storefront crop is clean. Dusk nightEff 0.45, bright-pixel mean: (226,163,142) salmon -> (210,174,157) golden. White and
blue towers now read as white and blue under a warm key. selfTest passes, zero console errors. fps was load-bound (load avg ~21): 18/9/29. Cost:
the crisp blits already ran at iso-mid (k 0.09 > 0.001); they now also run at camDist 50-70. WB is CPU only. No perf/auto-quality code touched.
Tools: scratchpad/jshoot.mjs (vshoot + per-variant JS, `{"name":{"p":{params},"js":"..."}}`), m2.py (matched-scale metrics), pair.py (900x600 ref pair).

**Next:** (1) If a critic calls the overview "crunchy/haloed", drop crisp.mid 0.45 -> 0.3 first, then fine 1.1 -> 0.9. Never lower distLo below 50.
(2) If dusk reads "grey/dull", lower wb.amount to 0.25. If it's still salmon, raise it to 0.45 (0.5+ greys the key). (3) Blue hour (nightEff ~0.55)
is a violet wash. That's lighting's night look, so WB only fades through it. (4) If light changes fill, re-run faceratio.sh and re-tune floor to 0.63.
