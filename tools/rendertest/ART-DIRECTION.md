# Art direction — target: Pablo Gamedev's "Isometric City Voxel"

This replaces the old "Cities: Skylines realism" target. Every render piece is
judged blind, side by side, against the reference pack. Reference images (not in
the repo — copyrighted, review use only):

`/private/tmp/claude-501/-Users-clintonmcleod-AI-skylines/5fc12e46-b935-4e31-941f-6553148850f6/scratchpad/ref/`

| file | what it shows | use it to judge |
|---|---|---|
| `ref05.jpg` | 1920×1080 city overview — **the primary target** | overall look, ground, roads, lots, density, palette, light |
| `ref04.png` | one house, Blender render, 2048² | voxel faces, AO, soft shadows, material colour, detail density |
| `ref06.png` | trees, rocks, flowers, bushes | vegetation |
| `ref01.png` | the free pack: a small town on light-grey roads | simpler city composition |
| `ref02.png` | a shop close-up | building detail, awnings, AC units, props |
| `ref07.jpg`, `ref08.png`, `ref09.jpg`, `ref10-15.png` | building sheets / thumbnails | building variety and detail |

Crop the reference to the region that matches the piece you are judging (e.g. a
single building from ref05, or the lower-left roads).

## What the reference looks like (the checklist)

- **Projection:** true isometric, orthographic. Nothing recedes, nothing blurs.
  No depth of field, no tilt-shift, no fog, no visible sky or horizon at normal
  zoom.
- **Light:** one warm-white key from the upper left + a bright soft sky fill.
  Three clearly separated face tones on every block: **top brightest, left mid,
  right darkest** — but the dark side is still colourful, never muddy or black.
  Soft, fairly light shadows falling back/right; soft ambient occlusion in every
  inside corner and where objects meet the ground (ref04 is the gold standard).
- **Surfaces:** clean, flat, confidently coloured faces. **No per-voxel grid
  lines, no noise textures, no speckle, no grime.** Big faces read as one smooth
  colour with only lighting gradients across them. Detail comes from geometry
  (frames, sills, ledges, pilasters, cornices), not from texture.
- **Palette:** bright, saturated but tasteful. Lime/yellow-green grass
  (~`#9fcb45`–`#b3d65a`), near-black asphalt (~`#1c1d20`), light concrete kerbs
  and plinths (~`#dcd8cc`), cream/white/terracotta/brick/teal buildings, glassy
  blue windows with light reflections, bright pool-blue water (~`#2ea3ee`).
- **Ground plan:** every building sits on a **raised lot/plinth** with a light
  concrete rim, its own paving, planters, parking with white lines, benches,
  umbrellas, tiny cars. Roads are wide black asphalt with thin light kerbs and
  dashed white/yellow markings and zebra crossings.
- **Detail density:** extremely high. Every building has window frames, doors,
  signage, rooftop AC units/vents/solar panels/water tanks, railings, awnings,
  planters. Nothing is a plain box.
- **Vegetation:** chunky cuboid canopies in lime/yellow-green with darker
  lower bands and a few darker "pixel" dots, brown square trunks; grey stepped
  rock clusters; small voxel flowers (white/blue/red); cube bushes.
- **Readability:** every object is instantly identifiable at the default zoom;
  crisp silhouettes, strong value separation between ground, road, lot and
  building. Zero aliasing shimmer.

## Kid-friendly constraints that still apply

Bright and cheerful beats realistic. Never grim, grey or muddy. 60 fps at
1280×720 on integrated graphics with a full city is still the budget.

## Lots — the shared convention (decided; every piece follows it)

As in the reference, **each building model brings its own lot**. Every catalog
building is authored at `res 4` (32 voxels/tile; `res 2` allowed for very large
footprints if triangle counts demand it) and starts with
`lotPlinth(g, 0, 0, sx-1, sz-1, {fill})` from `src/models/core.js`: a 0.5-unit
raised slab, light concrete rim (`C.lotRim`), darker side band (`C.lotSide`),
and a paved / grass / asphalt-parking top. Put the paving, planters, parking
stripes (`C.lotLine`), benches, umbrellas, little parked cars etc. ON the lot.
Terrain therefore draws **plain clean grass** under and between lots — it must
not add its own plinths under buildings. Roads meet lots at the kerb.

Building artists: don't edit `src/models/core.js` except to append palette
colours inside your own `// [category]` block in `_colors` (keys prefixed with
your category) — put any new helper functions in your own category file.
See `bBakery` in `src/models/commercial.js` for a worked res-4 example.

## Don't break the game for everyone

Thirteen builders share one working tree and every critic renders it live. After
EVERY edit run `tools/rendertest/check.sh` (parses all modules as ES modules) —
a single syntax error stops the game booting for all critics. Never put
backticks inside GLSL template literals (not even in comments).

## For critics: making a FAIR blind pair (mandatory)

A pair is only meaningful if both sides show comparable content at comparable scale.
- **Match scale.** ref05 is ~120 px per map tile at 1920 wide. Our `iso-mid` shot is
  ~116 px per tile at 1600 wide — the same scale. Compare ref05 crops against
  `iso-mid` (or crops of it at the same crop size). Never compare a zoomed-in ref05
  crop against `iso-wide` / `iso-park` (those are ~2-4× smaller scale), and never
  upscale a small crop of ours to fill the pair.
- **Match content.** Buildings vs buildings, roads vs roads, open grass vs ref05's
  open grass (top-left of ref05: lime field with a sprinkle of cuboid trees and grey
  rocks). Our game has countryside and water the reference doesn't; judge those
  against the closest analogue (ref05 top-left field; ref05 pool for water; ref06 for
  vegetation), not against a dense city block.
- **Close-ups:** `iso-close` / `one-<id>` against ref04 / ref02 at similar object size.
- Use the same crop size on both sides (e.g. 900×600 px from each).

## For builders: critics are noisy — steer by consensus

Every round gets a brand-new critic, so individual verdicts swing (water: "too dark"
→ "too pale"; veg rocks: "busy pile of tiny cubes" → "too few big cubes"; roads:
"too empty" → "too cluttered"). Treat the latest gap as ONE sample. Before
changing direction, list every past gap in your notes file and fix what several
critics agree on; for a lone contradicting remark, aim at the midpoint and the
reference itself (measure its pixels with PIL: colours, face-value ratios, block
counts) rather than flipping to the opposite extreme. Never undo something that
earlier critics praised or that was present when you WON a round.

### Update (14:40): screenshots are now 2x (3200×1800)
`shoot.mjs` renders at devicePixelRatio 2 by default (what a retina player sees).
Earlier critics kept calling our image "soft" because they cropped a 1600×900 shot
and blindpair UPscaled the crop — the reference was only ever downscaled. Now:
`iso-mid` at 3200 wide is ~232 px/tile vs ref05's ~120 px/tile at 1920 — so to
match scale, crop ~1.9× the size of your ref05 crop from ours (blindpair then
downscales both to 900 high). Never upscale ours. Performance: judge fps with
`--dpr 1` on an idle machine; the fps printed during critic runs (many Chromes
at once, 2x pixels) is not the budget.
- (17:50) Gallery layout is now per category: homes/shops/deco pack shoulder to shoulder along the street; fun/civic/downtown/factories get a road-framed block each. Judge layout accordingly.
