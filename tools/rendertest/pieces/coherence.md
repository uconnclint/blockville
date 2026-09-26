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

- (2026-09-26, res w4r2 critic) [ground] A grey rock cluster from the grass scatter sits right behind a gallery house and pokes up through its roof silhouette. Scatter should keep rocks/trees at least one tile clear of building lots (or below roofline behind them).
- (2026-09-26, ground w4r2 critic, piece WON) [ground][post] Park/field grass tops now read highlighter-neon ~rgb(189,233,48) vs the matched ~#a8c66c/#a2ba6c. Find what moved it (ground builder change vs post's new midtone curve/saturation) with an on/off A/B and pull grass tops back toward ~#a8cf50 at most. Parks also carry scattered cars/pink/grey cubes that read as clutter on open ground.
- (2026-09-26, veg w4r3 critic, piece WON) [veg][ground] Park/median hedge boxes are flat saturated emerald with no top/bottom tone split and clash with the lime trees; ref06 bushes are lime single cubes with a small knob and a clear three-tone split. Bring hedge/bush colours into the canopy lime family.
- (2026-09-26, surface w4r3) [light][ground] The "near-black plinth side band" under every building lot (critic w4r2) is mostly NOT voxel. On one-bakery's right edge, terrain's LOT_Y footing side renders at 9-17/255 (lotSide albedo #a9a59a). With lighting `wallFillAway` 0 it goes to ~69, and with worldAO also off to ~106. The lot-top strip beside every wall foot renders at 22 and goes to 129 with worldAO off. The 0.8 away-wall fill cut stacks with worldAO's contact term on low away-facing faces. Suggest exempting faces within ~1 unit of the ground from the away cut, or flooring worldAO on lot tops/footings at ~0.6. (Surface fixed its own share: the voxel plinth no longer takes a ground crease; see surface.md w4r3.)
- (2026-09-26, light w4r4 critic, piece WON) [light][roads] Cast and contact shadows of buildings and cars vanish on the near-black asphalt; no visible contact AO where storefronts/cars meet kerb and road. Consider a slightly lighter asphalt (#1c1d20 ref) or stronger contact AO on road surfaces.
- (2026-09-26 21:30, coordinator, from the icons agent's UI screenshots) [ground] A NEW city's whole map is now an even lattice of trees + grey rocks at ~1.2 trees/tile (my measured ref05 field density applied everywhere). It reads as a forest grid and leaves no open meadow to build on. Keep the ref density only as local groves; make the default map mostly open grass with scattered groves/clusters of varied size, rock clusters rarer (~0.1/tile), and keep the area around the start/camera centre fairly open.
- (2026-09-26, icons agent) [ui] The selected-tool banner ("Move", "Stadium") floats on top of dialogs (sticker book title, help). Hide it while a modal/dialog is open.
- (2026-09-26, icons agent) [build] dist/blockville.html: bundle src/iconworker.js separately and inline it as globalThis.BV_ICON_WORKER_SRC, else icons render on the main thread (up to ~0.6 s stalls).
