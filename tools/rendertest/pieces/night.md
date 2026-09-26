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
