# coherence — whole-game pass (all pieces together, as a player)

## 2026-09-25 — first coherence pass

### What was played / tested
Headless (a scripted variant of shoot.mjs driving the real UI) plus the browser pane:
- Splash, "New City", mode picker (Everything), welcome, "Continue".
- New city: straight roads, a 4-way crossing, T junctions, L corners, a road across
  the lake (bridge), 93 catalog buildings from every category (homes/shops/downtown/
  fun/factories/deco, 1x1 up to 4x4, all 4 auto-rotations), bulldoze, undo.
- Ghost preview (valid green + blocked red) on a res-4 4x4 (stadium) and a 3x3 (mall);
  construction grow animation at 15/50/85 %.
- Camera: all 4 rotations, zoom 45..800. Day → dusk → night → dawn, the "Always
  bright" lock, rain, snow (settled), autumn tint.
- Photo/postcard, city-name prompt, sticker toasts.
- Demo city (BVBOOT iso-mid / iso-water / iso-park / iso-night / iso-close / iso-wide).
- Self-tests: sim, life, challenges, models (+ modelhash) and every render module's
  selfTest() — all pass (see note on GL-error cross-talk below).

### Fixed (files)
1. **Night streets were solid orange** (light; `src/render/lighting.js`
   `lampRadius 9.5→5`, `lampIntensity 1.0→0.10`). ~1 lamp per road tile under the
   iso camera, each an additive 19-unit pool: they overlapped into a flat sand sheet
   that erased asphalt, markings and zebras. Now small warm puddles; roads read.
2. **Pale-blue "mist" sheets over towers at night** (surface; `src/render/materials.js`
   `GLOW_DEFAULTS intensity 0.030→0.006, maxRadius 18→6`). The per-band window
   spill billboards were up to 18 units wide.
3. **Lake glowed day-blue at night** (water; `src/render/water.js` night fold ramps in
   with `smoothstep(0,0.7,uNight)`, `uNightTint 0.10/0.17/0.34 → 0.035/0.06/0.12`).
4. **Terrain lots went grey-lavender at night next to hue-keeping building lots**
   (ground; `src/render/terrain.js` `uNightChroma 0.16→0.6`, `uNightSky ×0.85`).
5. **Two/three clashing grass greens by day** (ground + surface/res):
   field grass had drifted to washed #c4dc8b (paler than every lot, hedge and tree),
   `C.lotGrass` rendered neon #b6f972, `C.resLawn` mint #b6f888. Re-solved together
   so all land in one lime family (~#b0d26a–#b8da73): `terrain.js grassMid/grassLit
   0x7e8a5c/0x818c5d → 0x718445/0x758546`, `models/core.js lotGrass 0x9fcb45→0x96b03d`,
   `resLawn 0x9cc77e→0x95b368`.
6. **Snow only whitened terrain and roads** — every building roof, lot and tree stayed
   summer green on a white ground. Added a shared snow-cover term on up-facing faces:
   `materials.js` (`uSnowCover`, `setSnow`), `props.js` (`uPropSnow`, `setSnow`),
   wired in `engine.js setWeather`.
7. **Bridge deck was the pre-overhaul res-1 checkered wooden plank model** with
   crenellated posts, 1 unit above the road (orange, from another game).
   New res-4 `bridgeModel` (`src/models/infra.js`): dark asphalt deck flush with the
   road, yellow edge / white centre dash, light concrete sidewalk + parapet on open
   sides, lot-side band, concrete piers into the basin. Needs `model.yOffset`, which
   `engine.addProp`/`_reseatProps` now honour. Added palette key `C.infraDeck`
   (`models/core.js`). `life.js BRIDGE_Y 1.0→0.02` so cars drive on the new deck.
   `models/selftest.js` bridge check made res-aware.

Before/after pairs: `scratchpad/coh/ba-iso-night.png`, `ba-bridge.png`, `ba-grass.png`,
`ba-snow.png` (session scratchpad; not committed).

### Remaining cross-piece issues (prioritised)
1. **[roads]** Bridge deck asphalt still reads mid-grey (#6f7a89) next to roads.js
   asphalt (#16171a) even with the darkest palette colour — materials' dark floor +
   sky fill lift voxel near-blacks. Either let roads.js draw the deck surface over
   bridge tiles, or give the voxel material a per-index "no floor" flag for asphalt.
   (Also: voxel `lotAsphalt` parking reads fine at #111314, so the lift is specific
   to large flat tops — check materials skyFill on horizontal faces.)
2. **[water / ground]** Bridge sprouts a small sand-rimmed pool notch (terrain draws a
   beach/basin ring round the bridged tile) and the beach under a road end shows a
   pale yellow "glow" rectangle (additive? lot-side?) — see shots18d/bridge-r0.
3. **[ground]** Mountains render as flat light-grey blocks (#a0a8a0 / #c0c8c0 / white
   caps) with near-black shade faces — no hue, much darker right faces than any
   building; reads as unfinished next to the lime field. Needs the three-tone
   colourful face treatment and rock palette from ART-DIRECTION.
4. **[ground / veg]** New city default: the open field is an even lattice of identical
   tiny trees in every direction (hundreds on screen). Reads as wallpaper; ref05's
   field is mostly clean lime. Lower FIELD_TREE in unbuilt countryside.
5. **[light / post]** Dusk (clock ~0.3) grades the whole city salmon/peach including
   white and blue buildings — strongest single tint in the game; dawn is fine.
6. **[night]** Terrain-drawn vacant lots/parks still read lighter and flatter than
   building lots at night; the moonlit floor could be unified between terrain
   (`uNightSky`) and materials (`skyFill` / rim at night).
7. **[res / all res-4 categories]** The construction grow scales the whole mesh in Y,
   lot plinth included, so every res-4 building's own lot starts as a squashed sliver
   and "grows" with the building (unverified visually at small scales). Consider
   growing only above the plinth (engine.updateBuildingScale / main.js growAnims).
8. **[surface]** Ghost preview is a flat translucent tint of the whole res-4 mesh:
   dense models (stadium, mall) become a busy wireframe-looking blob. Consider
   drawing only the footprint + silhouette, or raising opacity.
9. **[life]** Pedestrians/cars at iso-mid are fine scale-wise; at default zoom 205
   they are 1–2 px specks. No action unless the art direction wants bigger movers.
10. **[perf]** Unchanged from brief: overview ~2.8M tris ~24–32 fps, night ~5.8M
    ~17–19 fps at 2x. Lamp pools are cheaper now (smaller quads) but that is
    fill-rate only.
11. **[test harness]** Render selfTests share one GL context: whichever runs after
    another's leftover state reports "GL error 0x501/1281" (roads after materials, or
    materials after roads). Each passes when run first. Tests should `gl.getError()`
    drain before they start.
12. **[test harness]** `BVBOOT('iso-*')` picks its iso azimuth from the live sun, and
    the sim clock keeps running, so two runs can frame different sides of the plaza
    (before/after iso-water differ for that reason, not from any edit).
