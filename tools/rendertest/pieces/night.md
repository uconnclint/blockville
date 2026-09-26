# night — night lights & windows

Owner files (night-only branches): `src/render/lighting.js` (lamp pools, bulb glows, moon),
`src/render/materials.js` (window emissives, night grading), `src/render/post.js` (bloom, night
grade gates), `src/render/sky.js` (night sky / night fill). Day paths belong to light / surface / post.

Bar (no night shots in the reference): a night city as crafted and cheerful as the day look —
deep blue-violet (not black) ambient, readable building masses, warm lit windows varied per
building, small warm lamp pools, a few neon signs, gentle bloom, no haze sheets.

Tuning harness used this round (scratchpad, not committed): `scratchpad/tune.mjs --vars v.json`
= shoot.mjs that builds the demo city ONCE, then poses a list of variants (`shotDef` adds a shot,
e.g. `{"shot":"mid-night","shotDef":{"night":0.92}}` = iso-mid framing at night) and runs live
`setParams` JS before each capture. ~4 min for 4-5 variants instead of ~2 min per variant.

## 2026-09-25 — round 1 (builder)

### Baseline problems found (r1-base/iso-night.png)
1. Every lamp carried a 3-unit camera-facing bulb billboard (glowRadius 1.5) on a 2.3-unit post:
   rows of floating orange balls.
2. Window-spill billboards (`setWindowGlows`, up to 6 units) clipped against the facades they sat
   in: pale wedges and warm haze sheets over whole residential blocks (the "wedges" surface r5
   saw). Measured: `_glowMesh.count = 0` removed all of it.
3. Grain/sparkle ring around every lamp pool. Cause: roads/terrain/props materials had
   `dithering: true`; on the half-float scene target that +/-0.5/255 noise sits under the
   tonemap's black plateau (invisible) until a pool lifts the asphalt into the toe, where it
   becomes a speckle. Post's daylight asphalt ops (chroma/luma gated) amplified it. Proven by
   toggling dithering live (t6/dith.png).
4. Downtown curtain-wall towers were the darkest things in the city: they are authored in
   PAINTED glass colours (dtGlass*, civGlass -> voxel.js class 'paint'), so no window ever lit.
5. Cool (201) panes read as a cold blue-white city; one city-wide 34% off made every building
   the same speckle.
6. Terrain parks/vacant lots read brighter and greener than building lots (coherence #6).

### Changed
- lighting.js: `lampGlowRadius 0.55` / `lampGlowIntensity 1.1` (small hot bulb, bloom does the
  halo); `windowGlowBillboards: false` (list still accepted, still feeds the sky city glow);
  pools `lampRadius 5 -> 3.4`, `lampIntensity 0.10 -> 0.24`, `lampColor 0xffcf8a -> 0xffc47c`
  (a lamp's own warm puddle; asphalt, dashes, zebras still read between lamps).
- materials.js (FRAG_OUT, night only):
  - per-building personality `voxBldRand(vVoxSeed, salt)` (smooth in the seed, CPU mirror
    `_bldRand`): unlit share `winOff 0.34 +/- winOffVary 0.50/2`, bulb temperature skewed warm
    (`winWarm [2.2, 0.35, 0.75]`), cool 201 panes pulled 75% to `winCoolTo 0xffe4b8`.
    `computeWindowGlows` mirrors occupancy + temperature (not the cool-pane pull).
  - plain glass lights up as offices: res>1 wall glass (voxGlass OR one of `nightGlassColors`
    = dtGlass/Hi/Deep/Teal/Dark + civGlass, matched on vVoxGlow = exact linear palette colour),
    >= 1.4 u above the model base, rooms 2 u wide x 1 floor, `glassNight [1, 0.48, 0.30, 1.4]`
    (~1 room in 5 lit, dim, under the bloom threshold). 0.16/0.75 flooded downtown in gold (t7).
  - `nightSat 0.22`: palette saturation lift ramping in over nightEff 0.45..0.8 so red stays
    red under the violet moon.
- sky.js: night zenith/horizon navy -> blue-violet (0.024,0.024,0.086 / 0.058,0.054,0.150),
  moon key (0.62,0.72,1.0) -> lavender (0.70,0.70,1.0), night ground bounce violet, night fill
  ~0.83x (`moonI 0.16->0.135`, hemi 0.30->0.25, amb 0.22->0.185): windows and pools pop, masses
  still read (frame mean luma 91 -> 84).
- post.js: bloom threshold 0.9 -> 0.8, strength 0.30 -> 0.38 (still night-only). New `uNightK`
  (smoothstep 0.35..0.7 of nightEff) fades the daylight asphalt ops (deepDark, asphalt flatten)
  and gates the black-plateau chroma switch by brightness at night. Day output is unchanged
  (uNightK = 0).
- Surgical, outside my files: `dithering: false` in roads.js / terrain.js / props.js (see 3);
  terrain.js `uNightSky` 0.162/0.166/0.191 -> 0.110/0.105/0.150 (coherence #6).

### Measured
- Self-tests pass in-page: materials, sky, lighting, post. 0 console errors on iso-night,
  iso-mid, mid-night, dusk (0.62) and day variants.
- fps: machine load avg 20-36 from other builders' Chromes; iso-night 10-21, mid-night 13-27 at
  dpr 2 — same range as the baseline under the same load. New shader work is night-only and
  confined to glass fragments (6 distance checks + 5 hashes); perf.md's window gating kept.
- Before/after: r1-base/iso-night.png vs r1-builder/iso-night.png; t6/dith.png (grain);
  t8/cmp.png (glass share sweep).

### Not mine / for others
- **[downtown / civic / shops]** Signs don't glow: HOTEL/BLOX/CAFE letters are painted
  (C.yellow, C.signWhite), and C.neon (203) is almost unused. Author sign letters (or a sign's
  rim) in `C.neon` (pink) or `C.win` (warm) and they will glow + bloom at night.
- **[downtown]** If you add a new glass colour, add it to materials.js `nightGlassColors` (6
  slots) or it stays dark at night.
- **[water]** At the wide night shot the lake is still a fairly bright day-ish blue in the corner.

### Next
- Glowing signs (above) is the biggest missing piece of the brief.
- Lamp pools could take a subtle second ring on the pavement/kerb side; bulbs at iso-wide are
  1-2 px — maybe scale glow radius with zoom.
- Per-floor correlation of lit rooms on towers (whole floors on/off reads more "office").

## 2026-09-26 — wave 4 round 1 (builder)

State found: an earlier (unrecorded, pre-reboot) w4 pass had already added lit sign letters
(core.js `SIGN_LIT` twins 204+, routed via `signLit()` in pixelText / commercial text / civic /
industrial; materials.js FRAG_OUT sign block with `nightSign` + `signBoost`) and glass strips.
Only pixelText-based downtown signs (CITY, LOANS) lit; everything drawn with downtown's 5x7
`text5` (HOTEL, BLOX, TWINS, PLAZA, ECO, APTS/ROUND, portico letters) stayed painted, and every
lit sign was warm white — no colour neon anywhere.

### Changed
- downtown.js (surgical, 2 lines): `text5` routes its colour through `signLit()` (+ import).
  Day look identical (twin = same colour); BANK uses dtNavyPanel, not a twin, so stays unlit.
- materials.js FRAG_OUT sign block: on "hot" signs (signBoost.z share), pale/white letters turn
  pink (1,.30,.72) or cyan (.30,.86,1) neon instead of warm-white bulbs; new param
  `signNeon [amount 1.0, pink share 0.5]` -> `uSignNeon`. Coloured letters (yellow/gold/red)
  keep their own hue.

### Measured
- iso-night: pink BLOX / ECO, cyan LOANS, warm PLAZA / TWINS / APTS ROUND now glow with bloom;
  ~1 in 5 signs stay dark. iso-mid (day) unchanged by eye. 0 console errors both shots
  (w4r1-builder/). fps 9-17 under heavy machine load (other builders' Chromes), not a budget read.

### Next
- HOTEL (yellow on black board) reads dim when it lands on the soft "lit board" level; could lift
  signBoost.x a touch for yellow letters. Streets are near-black; a faint violet lift on asphalt at
  night would belong to roads.js.

### Coordinator note (2026-09-26 13:35, wave 4) — measured hue/value
w4r1 critic: "downtown washes into one lavender-purple haze; towers merge into each other and the ground". I checked iso-night: luminance p5/25/50/75/95 = 0.04/0.07/0.20/0.35/0.52; the mid-value body averages RGB(40,35,53) — violet-grey, i.e. mauve. Agree with the critic, while keeping the earlier "not black" win:
- Shift the ambient/moon hue from violet to BLUE-navy (mid-value body target ~RGB(28,38,66); B well above R, R ≈ G). 
- Value order at night: roofs (moonlit) > walls lit face > lots/pavement > right faces > roads. Lots/ground clearly darker than roofs (now similar); right faces deep blue.
- Then the warm window grids, lamp pools and neon signs are the only warm/bright elements — keep window variety, maybe a touch more lit windows on the tall towers so masses separate.
Measure the same numbers before/after and log them.

## 2026-09-26 — wave 4 round 2 (builder)

Gap (w4r1 critic): downtown one lavender-purple haze; walls, lots, road edges in one mid-violet band.
Measured the cause with live toggles on iso-night (centre 1800x1200 crop, mean RGB removed):
rim 5.5/6/10.7, sky env 7.5/6.9/12.8, moon key 14.9/12.4/8.6, hemi+amb+skyFill 3.3/3.4/7.7. And the
tan-lit "left" walls were NOT moonlit: the moon key sat behind the city (disc azimuth = sun + pi + 0.55),
so both visible walls were fill-only, lit by materials' warm sun BOUNCE (engine hands it the full
0.22 at night = 10x the day's, tinted 0xfff1e0). Every face in the same band = the haze.

### Changed
- sky.js: moon KEY decoupled from the moon DISC: at night keyDir = day key's camera-relative azimuth
  + `nightKeyAz 0.35` at `nightKeyElev 0.90` (~52 deg); `nightKeyI` param (0.135 -> 0.22). Disc
  unchanged (still low, opposite the sun). Night blocks get three tones: top brightest, left mid,
  right deep blue.
- materials.js (night-gated): `rimNight 0.26 -> 0.07` (rim is additive lavender on every iso face);
  `envNight 0.5` (env at full night = base x 0.5, was x 1.22); `nightShade [0x5a78ff, 1.25]` — the
  shade-side bounce turns navy at night instead of warm; `nightFloor [0.62, 0.4, 4.5, 1]` — lot
  plinths / lower storeys take 62% of the moon+sky, ramping to full by 4.5 u above the model base,
  so lots read darker than roofs (fades in over uNight 0.45..0.8; emissives / pools untouched).
- Day paths untouched (all terms x uNight or gated); iso-mid visually identical.

### Measured
- iso-night crop luma mean 69 -> 48, p50 61 -> 30, p90 124 -> 109, p99 unchanged 235 (lit panes,
  signs keep full value). Warm windows, lamp pools, SKY/BLOX/ECO signs are now the bright elements.
- Self-tests materials / sky / lighting / post pass. 0 console errors iso-night, iso-mid, dusk
  0.55/0.65/0.75 (smooth hand-off). fps 18-23 at 2x under other builders' load.
- Shots: rounds/night/w4r2-base vs w4r2-builder; n2/ (toggles, grids).

### Next
- Residential (low houses) are now dim brown under the floor ramp; if a critic calls it grim, raise
  nightFloor.x to ~0.7 or start the ramp lower, don't restore the rim/env lift.
- Coherence #6 [night]: terrain-drawn vacant lots / parks may now read lighter than the (darker)
  building lots — terrain.js uNightSky could drop ~15% to match (ground owns it).
- Red brick goes brown-maroon under the lavender key; a slightly bluer key (0.64,0.70,1.0) + nightSat
  could keep it red.

### Coordinator note (2026-09-26 15:40) — after w4r2
Both wave-4 critics agree on the real problem: VALUE SEPARATION and HUE (purple mass), not overall brightness (r1 said darker, r2 said lift). So keep the overall level about where it is and: shift the hue from purple to blue-teal; roofs clearly lighter than walls (moonlight from above); lots a step darker than roofs; streets dark but not pure black (a hint of blue); more lit ground-floor shopfronts and warm lamp pools on every street. Measure roof vs wall vs lot luminance on 3-4 low-rise blocks before and after and log it.

## 2026-09-26 — wave 4 round 3 (builder)

Gap (w4r1 + w4r2 agree, plus the coordinator note): the night was one purple/mauve band. Roofs, walls and lots sat at the same value, lamp pools were small dots, and brick went maroon.

### Changed
- sky.js (night only): the key colour is now a param, `nightKeyColor` [0.66,0.78,1.0] (was lavender 0.70/0.70/1.0).
  The night ground bounce is now a param, `nightBounce` [0.040,0.078,0.160] (was violet 0.066/0.060/0.150).
  uNightZenith/Horizon are navy-teal (0.014,0.032,0.088 / 0.034,0.066,0.150). `nightKeyElev` 0.90 -> 1.05 (~60 deg). `nightKeyI` 0.22 -> 0.26.
- materials.js (night-gated): new `nightTop` [0.6, 1.6, 0.35] (uNightTop). An UP face more than 0.6..1.6 u above the lattice
  base ramps to the full moon (lot paving stays on nightFloor's dim floor), and it gets a x1.35 key boost. Result:
  roofs > lit wall > lot > right wall. `nightShade` 0x5a78ff -> 0x3f86ff. `nightSat` 0.22 -> 0.35.
  New `winShop` [0.4, 5.0, 1.2] (uWinShop): window panes below 5 u above the model's lattice min corner get 0.4x the unlit share
  and 1.2x the level, so more ground-floor shopfronts and front rooms are lit. computeWindowGlows mirrors it on the cell's cy.
  NOTE: vVoxGrid.y is measured from the model's lattice MIN corner, which sits below the lot plinth. The commercial shopfront
  storey only started to light at a threshold of ~5 u, not the ~2.4 u you would expect from the model's rows.
- lighting.js: lamp pools `lampRadius` 3.4 -> 4.4, `lampIntensity` 0.24 -> 0.34. Each street now shows its own warm puddles.
- Did NOT change: `glassNight.w` (0.6 made no visible difference), roads.js asphalt (not mine).

### Measured (iso-night, fixed patches, luma(R,G,B), script scratchpad/nmeas.py)
- centre crop pct p5/25/50/75/95: 9/12/29/62/158 -> 9/16/41/75/168. Mid body mean RGB (32,30,48) mauve -> (34,43,53) blue-teal.
- fire station: roof 46 -> 69, left wall 45 -> 57, lot rim 23 -> 35, road 11 -> 12. Gable house: roof 34 -> 53, right wall 11 -> 14.
  Value order is now roof > wall > rim > road.
- Self-tests materials/sky/lighting/post pass. 0 console errors on iso-night, iso-mid, dusk 0.55/0.70. Dusk hands off smoothly.
  iso-mid (day) is unchanged. fps 22 at 2x.
- Shots: rounds/night/w4r3-base vs w4r3-builder. Variants in n3/ (A..H, X1..X4 = winShop threshold probes).

### Next
- Streets are still near-black (road luma 12). A faint blue asphalt lift belongs to roads.js (ground/roads owner).
- The brick houses' right walls stay very dark (luma 14). If a critic calls it grim, raise nightShade.w 1.25 -> 1.5.
- winShop is a height heuristic. A per-pane "shopfront" flag from commercial.js would be exact.

### Coordinator note (2026-09-26 17:30) — after w4r3: hue fixed, separation still missing
Progress: purple → slate-blue (good, keep). All three critics now point at one thing: unlit masses share one value. Night needs the SAME three-tone face structure as day, driven by a cool directional moon key (not just ambient): measure with tools/rendertest/faceratio.sh OUTDIR "BVDEMO.night(1)" and aim for top : left : right ≈ 1 : 0.70 : 0.45 on the white cube, with the top face around luminance 0.35-0.45 (moonlit, not grey-black). Add light rims: kerbs, parapets and roof edges a touch brighter so silhouettes separate. Windows/neon/lamp pools stay the warm accents. Log the numbers.

## 2026-09-26 — wave 4 round 4 (builder)

Gap (w4r1..r3 + coordinator 17:30 all agree): unlit masses share one dark value; no light edges; right faces
near-black; low-rise flat and dim. Fixed value structure + silhouettes, kept hue (slate-blue) and all accents.

### Changed
- post.js (night-only): new **moon rim** — `moonRim {strength 0.55, width 1.4 css px, minStep 0.35, slope 3,
  color [0.55,0.66,0.82]}` -> `uMoonRim`/`uMoonRimCol`. Reuses the ink's depth-laplacian (`inkK(R, thr)` now takes
  radius/threshold) to find the NEAR side of every depth step and max-blends it toward pale moon blue: thin light
  lines on roof edges over the street, towers against the next tower, parapets. Scaled by uNightK (0 by day, taps
  skipped); vegetation (alpha 0.2) and water spared; lit panes/neon never dim (max-blend).
- sky.js: `nightKeyI` 0.26 -> 0.38 (moon key lifts tops and lit walls).
- materials.js: `nightTop.z` 0.35 -> 0.7 (roof key boost), `nightShade` [0x3f86ff,1.25] -> [0x4a8cff,2.8]
  (right faces deep coloured blue), `nightFloor.x` 0.62 -> 0.7 (low-rise/lots less dim). The nightShade strength
  now ramps smoothstep(0.45,0.85,uNight) (tint stays linear) — without it dusk 0.55 right faces went pale lavender.

### Measured (iso-night, nmeas.py patches, luma)
- pct p5/25/50/75/95: 9/16/41/73/172 -> 10/23/58/105/182; mid body RGB (33,43,53) -> (50,62,75).
- fire station roof 69 -> 95, left wall 50 -> 66, lot rim 31 -> 86 (moon rim), lot 26 -> 40, road 12 -> 14.
  Gable house roof 54 -> 82, right wall 14 -> 34 (real buildings top:right ~1 : 0.4).
- White probe cube at night(0.92) (scratchpad/nfr.sh = faceratio.sh with night in --post): 1 : 0.72 : 0.54 ->
  1 : 0.73 : 0.73 — the probe's right face is bounce-dominated saturated blue (75,133,245) on white albedo; real
  facades land near target. If a critic calls right faces too bright/blue, drop nightShade.w to ~2.2.
- Self-tests materials/sky/lighting/post pass; 0 console errors iso-night, iso-mid, dusk 0.55/0.70, mid-night.
  Day (iso-mid) untouched by my code (diff only on models other builders are editing + moving cars).
  Dusk 0.55 matches the old dusk (n4/z07.png). fps 9-19 at 2x under heavy machine load (not a budget read).
- Shots: rounds/night/w4r4-base vs w4r4-builder; variants n4/ (R* rim sweep, K* level sweep, z0x comparisons).

### Next
- Greens at night (critic w4r3 "olive"): trees/park grass are props/terrain — a night saturation lift for
  vegetation belongs to veg/ground; materials' nightSat doesn't reach them.
- Kerbs mostly don't catch the moon rim at iso-night zoom (0.5 u step under the wpp threshold); a night-only
  kerb-top lift would be roads.js.

## 2026-09-26 — wave 4 round 5 (builder)

Gap (w4r2..r4 agree): downtown towers merge into one blue-grey mass; every facade the same scattered
window grid; top/left/right too close; brown/maroon towers muddy; core street level black.

### Changed
- materials.js (night-only):
  - **Whole floors** (`winFloor [dark 0.28, busy 0.22, busy unlit x0.20, band 2.0 u]` -> uWinFloor): new
    `voxPaneY` (pane CENTRE height from the pane-UV derivatives, so a row never splits) keys a per-floor
    hash; dark floors go fully dark, busy floors mostly lit. Office glass uses floor(vVoxGrid.y). Shop
    storey never goes fully dark.
  - **Bimodal buildings**: `winBimodal 1.0` (2x smoothstep on the building occupancy) + `winOffVary`
    0.5 -> 0.9: some towers nearly dark, some mostly lit. CPU mirror (computeWindowGlows) updated.
  - **Lobbies**: `glassLobby [0, 2.4 u, unlit 0.12, level 1.1]` -> uGlassLobby: street-level office
    glass lights full height (was excluded below glassNight.w).
  - Face values: `nightTop.z` 0.7 -> 2.2 (moonlit roofs brightest), `nightShade.w` 2.8 -> 1.3 (right
    faces a dark third tone), `nightSat` 0.35 -> 0.6 (brown/cream/green towers keep their colour).
- sky.js: `nightKeyI` 0.38 -> 0.58, `nightKeyColor` [0.66,0.78,1] -> [0.60,0.80,1] (stays blue-teal
  with the stronger key, not grey).

### Measured
- iso-night nmeas pct 10/23/58/105/182 -> 11/32/75/128/213; mid body RGB (50,62,75) -> (65,79,85).
- White probe (nfr.sh): 1 : 0.73 : 0.73 -> 1 : 0.61 : 0.51 (target 1 : 0.70 : 0.45).
- Self-tests pass (materials/sky/lighting/post); roads selfTest FAILS "GL error after compile 0x501"
  — not from my files (roads owner). 0 console errors iso-night, iso-mid, dusk 0.55/0.70, mid-night.
  Dusk hands off smoothly (slightly paler at 0.55). Day unchanged (all terms night-gated).
- Shots: rounds/night/w4r5-builder; variants n5/ (A0..J; g7.png = critic-style crop before/after).

### Next
- Water at night is a dull navy (water owner). Lot rims could catch a touch more moon (roads/terrain).
- If a critic calls it "moonlit day"/too bright: nightKeyI 0.58 -> 0.50 first, keep nightTop/nightShade.

### Coordinator note (2026-09-26 20:35) — after w4r5: left == right, root cause to find
Five critics, one gap: at night left and right faces are the same value. Your own probe says it: 1 : 0.73 : 0.73. That means the moon key is NOT offset in azimuth the way the day key is — by day engine.js locks the key at camera azimuth + KEY_AZ_OFFSET (now -110°, measured), so the left face faces the sun and the right face is away from it. Check what azimuth sky.js / lighting.js give the moon (and whether the night hemi/bounce dominates the right face). Fix: the moon key should use the SAME camera-locked azimuth offset as the day key (only colour, intensity and elevation change), and the night fill/bounce on the right face must drop so the probe reads ~1 : 0.70 : 0.45. Verify with your nfr.sh probe; log the numbers. This single fix is worth more than any window work.
