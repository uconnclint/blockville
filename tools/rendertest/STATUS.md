# Render overhaul — integration status

Reference frame for all comparisons: seed **20240601**, plaza **(40,40)**, 270
buildings. Set up with `tools/rendertest/bootstrap.js` → `BVBOOT('<shot>')`.
Shots defined in `tools/demo-city.js`. Grading rubric: `REVIEW-PROTOCOL.md`.

## Integrated into `src/engine.js`

| module | status | notes |
|---|---|---|
| `voxel.js` | **live** | per-vertex AO + `matParams`; **bevel OFF** — measured 5.00x triangles (1.12M → 5.60M for 500 buildings, before shadow passes) |
| `materials.js` | **live** | PBR + IBL; `envIntensity: 0.55` (full strength double-counted the sky's hemi+ambient fill and washed facades to near-white) |
| `post.js` | **live** | MSAA 4x + FXAA, SSAO, bloom, tilt-shift, ACES+grade. Retuned at the call site: `maxBlur 1.0→0.42`, `rangeScale 0.62→1.15`, `bloom.threshold 0.85→1.15`, `exposure→1.12` |
| `sky.js` | **live** | owns sun/fog/fill via `_applySkyLighting()`; `exposure 0.045→0.052` to repay the ACES loss downstream |
| `terrain.js` | **live** | shadow receipt fixed (bug 2 below); `selfTest()` now reads the compiled fragment shader back and asserts `getShadow()` survives the injection. Grass re-graded — measured hero meadow sat 0.51 / hue 95 / blue-green 0.49 / sigma-mean 11.4% |
| `roads.js` | **live** | legacy voxel road props disabled in `main.js` (`refreshRoadProp` now only places the bridge deck) — they were double-drawing markings on top of the new asphalt |
| `water.js` | **live** | constructed `seabed:false` — terrain and water both wanted to draw a seabed; terrain's won. Surface reworked: own aerial perspective (bug 4 below), GGX glint, foam/waterline wobble. Measure with `BVWM.report()` / `BVWM.diag()` in `water-measure.js` |
| `lighting.js` | **live** | CSM + PCSS + night pools. Indirect/IBL occlusion is now driven by a **sky-visibility** term (contact proximity from the PCSS blocker gap), not by the cast shadow — open shadowed ground keeps its sky, canyons do not. Taps are bilinear (`csmTap`), kernel rotation is no longer per-pixel. Low-sun strength ramp retuned to `smoothstep(0.4°, 3°)`. Skylight (hemi + ambient + diffuse IBL) is now re-graded off SUN ELEVATION so golden hour is warm, and the moon key rides a real arc with `isMoon` finally reporting the truth (bugs 7/8 below). Measure with `SM.report()` / `SM.ab()` in `shadowmeter.js` and `WM.shot()` / `WM.budget()` in `warmmeter.js` |

## Confirmed bugs

1. **Shadows were globally invisible.** `sun.shadow.normalBias` was `0.9` (≈ a whole
   voxel) and the ortho frustum was ±480 at 3072px (~0.31 world units/texel,
   coarser than one voxel). Stopgap in `engine.js`: `normalBias 0.035`,
   `bias -0.0004`, `sHalf MAP_W*0.75 → *0.30`, and the sun target now follows
   the camera target so the tighter frustum stays over the view. Superseded when
   `lighting.js` (CSM) lands.
2. ~~**`terrain.js`'s ground material receives no cast shadows.**~~ **FIXED.**
   Root cause: an `onBeforeCompile` `replace()` that dropped the
   `#include <lights_fragment_begin>` it matched instead of re-emitting it,
   which deletes `getShadow()` while the material still renders perfectly.
   Rule now documented at the top of `terrain.js`: every injection re-emits its
   own `#include` and only APPENDS. `terrain.selfTest(renderer)` reads the
   compiled shader source back off the GL program and asserts `USE_SHADOWMAP`,
   the shadow-coord varyings and >= 2 `getShadow(` occurrences.
   `roads.js` and `materials.js` use the same injection technique — **still
   worth auditing them against the same rule.**
3. Buildings/props had `receiveShadow = false` — now `true` (self-shadowing and
   tower-onto-tower).
4. **`scene.fog` was inverting the water's fresnel.** `water.js` ended its
   fragment shader with `#include <fog_fragment>`, so at the far edge of a
   640-unit map (fog factor ~0.95) the haze colour overwrote the reflection
   entirely: measured water luminance **83** immediately below the horizon while
   the sky one pixel above it was **175**. That is what read as "no fresnel /
   darker at the grazing edge". `water.js` now runs its own aerial perspective
   with the same `fogNear/fogFar/vFogDepth`, but converging on the *reflected
   sky* instead of the land haze tone. Far-edge water is now ~187.
   **Worth checking whether `terrain.js` wants the same treatment** for distant
   land, which still washes to the flat haze colour.

5. **Shadowed ground was crushed by the shadow occluding the SKY.** `csmIblScale()`
   / `csmIndirectScale()` scaled the sky IBL and the hemi/ambient fill by the
   CAST-SHADOW term (0.72 / 0.55). Sun-blocked is not the same as sky-blocked:
   open road in a tower's long shadow still sees the whole dome. Now gated by
   `csmSkyOcclusion()` (contact proximity), so open shadowed ground loses only
   0.88×0.30 ≈ 0.26 of the IBL while a wall base loses the full 0.88. Same
   session, `SM.ab()`, lit:shadow sRGB medians road/terrain — street
   7.64/5.91 → 4.62/3.96, golden 4.60/3.54 → 3.24/2.66, hero 3.93/3.51 → 3.04/2.84.
6. **Penumbra stipple.** Per-pixel interleaved-gradient kernel rotation over 16
   nearest taps made every pixel an independent Bernoulli estimate — pure
   1-pixel-period noise, with no shadow denoise pass anywhere downstream.
   Fixed by bilinear (`sampler2DShadow`-style) taps plus dropping the per-pixel
   rotation. Rooftop-penumbra hf1 (street, baseline 0.32): **2.585 → 1.060**.
   NOTE for `post.js`: the AO buffer gets a `[1,2,2,2,1]/8` blur, the shadow
   term gets nothing — it is computed inline in the forward pass and never
   lands in a buffer. Anything further needs temporal AA or a shadow buffer.
7. **"Golden hour" was measurably BLUE.** At `golden` the key is a 2.83:1 warm
   sun (#ffb95a, 19.9°) and LIT road/terrain/building measured **R/B 0.66 /
   0.64 / 0.60**. Cause: hemisphere (#48b3ff @ 0.434), ambient (#4799de @ 0.112)
   and the diffuse sky IBL all stayed at DAYLIGHT BLUE down to the horizon —
   and the IBL is the biggest single contributor to a ground pixel (measured on
   lit road, linear: sun 22 % of the red / 1 % of the blue, hemi+ambient 12/17,
   **IBL 27/41**, aerial-perspective haze 38/41). `lighting.js` now re-grades
   hemisphere + ambient + the diffuse IBL toward a warm horizon band over sun
   elevation 34°→18° (`skylightWarmth`, `uCsmIblTint`), at constant luminance:
   **R/B 1.35 / 1.09 / 1.23**, lit:shadow 2.36/2.34 → 2.58/2.56, hero (63°)
   bit-identical. Measure with `WM.shot()` in `warmmeter.js`.
   Because `engine.js` rewrites those lights from sky.js AFTER `rig.update()`,
   the grade is delivered through property accessors on the lights — writers own
   the base value, the rig owns the elevation grade of it.
   **Still blue and NOT fixable from `lighting.js`:** sky.js's `fogColor` at
   golden is **#7491b6 (R/B 0.38)** and terrain/water/roads mix toward it for
   aerial perspective (17 % of a lit terrain pixel); materials.js's own
   `uSkyFillColor`/`uRimColor` fill is fed the same blue zenith.
8. **The moon key shaped nothing, and `isMoon` was never true.** In `external`
   mode sky.js hands over `keyDir`, which IS the moon at night, so
   `sunDir.y < 0` reported `isMoon` false at nightT 0.92 — the moon has been
   casting full-strength daylight shadows and being colour-graded as a sunrise.
   And sky.js authors the moon at a fixed **4.3°**, i.e. `sin(4.3°) = 0.075` of
   the key onto any road or roof. Measured night lit:shadow on road: **1.74**,
   with the "lit" set no brighter than the shadowed one. `lighting.js` now
   derives `isMoon` from the clock and floors the moon KEY at
   `moonKeyElevation` (30°, ramped in over the handover so nothing snaps):
   N·L on a horizontal surface **0.075 → 0.500**, direct receipt 0.022 → 0.148,
   night road lit:shadow **1.74 → 3.27**, frame-below-luma-4 2.74 % → 1.89 %.
   **The DISC is sky.js's**: `sky.js` `_moonElev` (opts.moonElevation, default
   0.075 rad) should be raised onto the same arc so disc and key agree — the
   floor then stops firing on its own.

## Open, not yet addressed

- Clouds are barely visible at the game's camera polar range (0.35–1.2); `sky.js`
  fades them out below ~17° elevation, which is most of what this camera sees.
- No true reflections in water — fresnel reflects an analytic sky, not the scene.
  Mountains do not appear in it. Lit buildings DO, cheaply: a 64² top-down
  emitter map marched 10 taps along the reflection ray (measured +8/255 mean on
  night water within ~300 units of downtown, 0 beyond that).
- **The rectilinear shoreline is terrain's, not water's.** `water.js` can wobble
  the waterline (colour + foam) but not the silhouette: it can only move its
  fringe vertices *onshore* (which hides them under terrain's bank) — moving
  them offshore uncovers the bed and hard black bank slivers, verified visually
  via the `shoreRetreat` option. A real fix needs either terrain jittering its
  own sand/bank edge, or a signed shore field plus a raised swash skirt drawn
  over the beach.
- Mountains read as stepped mesas, not alpine peaks (inherent to 16-unit max
  height on a 640-unit map).
- `props.js` is **written and verified but NOT yet constructed by `engine.js`**.
  It consumes `roads.build()`'s anchors (lamp posts with an emissive bulb under
  lighting.js's existing pool, traffic signals, stop signs, hydrants, bins,
  benches) and scatters deterministic vegetation (clustered trees, hedges,
  shrubs, rocks, dirt paths) over the empty grass. Harness:
  `tools/rendertest/props.html`. Measured on the reference city: **+8 draws /
  +65k tris / +0.07 ms at `region`**, +18 draws / +82k tris / +0.21 ms at
  `hero`. Wire-up is three calls — see the props.js header.
