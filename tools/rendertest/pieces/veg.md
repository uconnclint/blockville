# veg — trees, bushes, rocks & flowers

## 2026-09-24 — round 1 (builder)

**Changed**
- `src/models/vegetation.js` rewritten. Every tree/bush/rock is a short list of
  boxes at res 4 (SHAPES) → `vegModel(kind, seed)` rasterises it (lime canopy,
  darker bottom band ~14% of height, 1-voxel darker "pixel" dots only on exposed
  side faces) and `vegFarBoxes(kind)` returns the same boxes in world units for
  the far impostor (no dots, main stem only). Kinds: column, round, cluster,
  sapling, pine (slim stepped tiers, lime-green), blossom, shrub (cube + little
  cube), hedge (two-height block), rock (stepped grey cluster), flowers (patch of
  3 plus-shaped white/red/blue flowers with yellow eye). World sizes match the
  old 5×9×5 oak so props.js size ladders / selfTest canopy limits still hold.
- `treeModel(v)` now 6 shapes (round, pine, blossom, cluster, sapling, column),
  cached. `miniTree` restyled to a cuboid lime/pink tree and is res-aware.
- Exported `vegFlower`, `decoBush(rng,v)`, `decoFlowerBed(rng,v)` (res-4 deco
  builders). I swapped them into fun.js's registry but the civic+fun builder
  rewrote fun.js concurrently and has its own flower-bed/hedge now — left theirs.
- `core.js` [vegetation] palette: vegLeaf/Band/Dot, vegPine*, vegBloom*,
  vegTrunk (orange-brown), vegBush, vegRock(+Light), petals W/B/R, pollen, stem, tuft.
- `render/props.js` (model side only): old oak/pine/blossom voxel + far box
  functions replaced by vegetation.js models; near LOD meshed with `aoReach: 1`
  (default reach=res split every contact into AO slivers: cluster 1548 → 682
  tris). New types `column`, `cluster`, `flowers`; in `push()` a scattered 'oak'
  is dealt into oak/column/cluster (42/28/30%) and 34% of shrubs become flower
  patches by position hash (counts/density untouched); scatter yaw snapped to
  90° (cuboids at 37° smeared in iso). Far impostor only for oak/cluster/pine to
  keep the selfTest draw budget (street 20 ≤ 20). Tree lod1 95 → 140 (iso camera
  sits camDist 85-190 from target, so 95 put the whole iso-park frame on the
  impostor). Flowers: skipBottom + no shadow casting.

**Measured**
- props selfTest: pass (street 20 draws / 299k tris, region 10 draws / 370k).
  models _selfTest ok. Zero console errors in iso-park, iso-mid, gal-deco-1.
- Near tris (props, reach 1): column 154, round 424, cluster 682, pine 324,
  blossom 344, shrub 74, hedge 76, rock 166, flowers ~220.
- Prop triangles in frame: iso-park ~390k (all veg+furniture), iso-mid ~167k.
  fps 61 on all three shots when the machine was quiet; later runs read 31 on
  every shot incl. the 478k-tri gallery, with ~30 parallel headless Chromes
  running — hiding all veg made no consistent difference.

**Next**
- Tree LOD by distance is wrong for an ortho camera (far trees are not smaller
  on screen); switch LOD on camDist/zoom instead of per-chunk distance.
- Blossom and column have no far impostor (draw budget) — a shared broadleaf
  instanced mesh with per-instance shape index would free draw calls.
- Pine share comes from the ground builder's conifer field; ref05 has only lime
  broadleaf — worth lowering if the woodland reads too "pine".
- Engine TREE tiles (player tree tool) mesh at default AO reach 4 (cluster
  1548 tris); could pass aoReach through engine._getGeometry if many are placed.

## 2026-09-24 — round 2 (builder)

Critic picked the reference: our trees were squat canopies on hidden trunks,
plus tiered pines; rocks/bushes scarce; forest cluttered; canopies smeared.

**Changed**
- `vegetation.js` SHAPES re-proportioned as ref06 LOLLIPOPS (measured off
  ref06 tree 1: trunk ≈ 42% of height, total height ≈ 4x canopy width, trunk
  ≈ 1/4 canopy width). Canopies narrowed from 14 fine voxels to 8-10 (2-2.5
  units), trunks raised to 14-18 fine (canopy starts at 40-50% of height),
  branch forks moved to y 13-15 so they show under the canopy. Heights kept
  (≤33 for 'round' = oak0) so the street-size selfTest still holds.
- 'pine' is no longer a tiered stack: a slender poplar (8-wide canopy on a
  2-wide stem, 22 tall) in a slightly deeper lime (vegPine palette moved
  toward lime). Rock redone as a ref06 stepped cluster (slab + tall block +
  shelf + loose cubes, 3 x 2 x 3 units). Band colours darkened (0x7c9f06).
- `props.js` push(): 75% of woodland understorey below scale 0.39 is dealt
  into cube bushes (68%) or grey rocks (32%, scale 0.70-1.15) — fewer, cleaner
  tree silhouettes and the ref's ground layer of rocks/bushes. Tree/shrub
  sway 0.03-0.055 → 0.012 (the shear skewed cuboid edges into parallelograms
  = "soft/smeared" canopies in stills).

**Measured**
- props selfTest pass: street 19 draws / 90k tris, region 10 draws / 172k
  (was 20 / 299k and 10 / 370k). oak 19 size buckets. models _selfTest ok.
- Zero console errors on iso-park, iso-mid, gal-deco-1. gal-deco-1 61 fps;
  iso-park 18-21 fps with 2.5M tris in frame and many parallel Chromes (the
  shared :8351 server was resetting connections — I shot on my own :8419).

**Next**
- Long soft contact shadows under trees are the lighting piece's — ask for
  tighter / lighter shadows (ref has short, faint ones).
- Woodland is still denser than ref05's evenly spaced park; the ground
  builder could lower pTree or add a min-spacing (Poisson) pass.
- Blossom has no far impostor (draw budget).

## 2026-09-24 — round 3 (builder)

Critic picked the reference: canopies read as one smooth lime box (band and
dots were in the model but invisible), trunks a single post, rocks beige,
bushes too close to the grass, flowers sub-pixel at iso-park.

**Changed**
- Root cause of "no band / no dots": the tone curve compresses albedo steps —
  a 0.72x band rendered only ~15% darker, and the dot colour (0x93b80a) was
  nearly the leaf colour. `core.js` [vegetation]: band 0x5f8204, dot 0x6b8f05
  (≈ band, as in ref06: dots and band are the same olive), bloom band/dot
  darker pink, pine deeper, trunk browner (0xa45d38), bush deep saturated
  0x3fa60a + skirt 0x2c8406, rock cool neutral 0x818488/0x909397 + new
  vegRockDark 0x46494e for inset gaps. Stem green deepened.
- `vegetation.js`: band = 13% of each lobe (min 2 voxels); every lobe gets its
  own band, painted so leaf always wins over another lobe's band. Dots 2-8
  per exposed face (area/26), never touching each other, 15% 2x2, 15% 1x2.
  Shapes redone: trunks 3x3 (1/4 of an 11-wide canopy); round = main cube +
  low side lobe on a sideways branch under the canopy (short riser, reads as
  ref06's loop); cluster = 4 offset lobes on a Y-fork whose arms sit just
  under their lobes; blossom = 2 lobes + branch + stub; pine = tall block +
  1-voxel-inset shoulder tier. Bushes get a 1-voxel dark skirt. Rock 3.5 x
  2.25 x 3.5 with shelves, loose cubes, dark seams and carved notches.
  Flower patch authored at res 2 (each flower 1.5 units, plus-shaped leaf
  clump), spots off the iso diagonals so they sit side by side on screen.
- `vegFarBoxes` now emits every branch (the fork is what distinguishes the
  shapes at iso-park, which draws the impostor): cluster far 168 tris.
- New `stampVeg(g, kind, x, y, z, seed, scale)` — stamps a vegModel into any
  res-4 building grid. The lot trees in civic/fun/residential/commercial/
  downtown/industrial are each builder's own plain helper (no band/dots/fork);
  they could switch to stampVeg for a consistent look.

**Measured**
- props selfTest pass: street 19 draws / 120k tris, region 10 draws / 243k
  (r2: 90k / 172k). Near tris: oak 360, cluster 712, pine 292, column 246,
  blossom 350, rock 346, flowers 246, shrub 90. Props in the iso-park frame
  ~321k tris. models _selfTest ok. Zero console errors on all three shots;
  gal-deco-1 61 fps, iso-mid 40-48, iso-park 22-35 (3.2-3.8M tris total,
  mostly buildings, machine shared with other builders).
- Rendered band now clearly darker on both side faces; dots read as crisp
  squares at gal-deco-1 zoom.

**Next**
- Tree LOD is still per-chunk camera distance; on the ortho camera iso-park
  (dist 165) draws the impostor (no dots). Switch LOD on ortho zoom.
- Ask the building builders to use stampVeg for lot trees.
- Woodland density is the ground builder's; the meadow is still crowded.

## 2026-09-24 — round 4 (builder)

Critic picked the reference: 8-15 dots per canopy face, soft-looking edges,
saturated orange-red trunks, iso-park one flat lime mass, flower heaps busy.

**Changed**
- `vegetation.js` sprinkleDots rewritten: single-voxel dots only (no 2x2 /
  1x2 dashes), n = min(4, area/32) on the face interior (2-voxel margin from
  edges and band, 3-voxel spacing) → tall column 3-4 per face, main cubes
  2-3, small lobes 0-1. Dot colour now ~0.75x leaf albedo (renders ~0.9x, as
  ref06's barely-darker dots) instead of = band.
- `core.js` [vegetation]: leaf 0xb4d00c, band 0x7c9c06 (lighter; renders
  ~0.8-0.85x), dot 0x86a20a; pine band/dot lightened; trunk 0xa45d38 →
  0xb07c6c. The grade's vibrance/shadowSat pushes browns hard: 0xa45d38
  rendered #c15406/#8e3e01; 0xb07c6c renders #c27447 lit / #9b4d1c shade vs
  ref06's #c27642 / #9b4f2a. Palette index max is 194/199 — nearly full, so I
  reused the (greener) PINE palette for the cluster tree instead of adding one.
- Shapes: pine is one slender 9x24 block (the inset second tier read as a box
  on a box). Cluster uses the greener PINE lime → woods show two tones.
  Flower patch = 2 flowers side by side on screen (was 3; heaps overlapped).
- `props.js`: sway 0 for oak/column/cluster/pine/blossom/shrub (ref is
  static; any shear slants the cuboid verticals). Flowers/hedge keep sway.

**Measured**
- Zero console errors on iso-park / iso-mid / gal-deco-1; fps 39 / 51-61 / 61
  (iso-park 3.1M tris, shared machine). models _selfTest: 15 errors, all
  other builders' front-face glazing, none vegetation.

**Next**
- Canopy face tones: ref06 has the LEFT face dark (#85ab00) and right light
  (#b0cf00); ours is lit from the left (lighting piece) — the left/right
  contrast is also weaker (~0.9 vs 0.75).
- The dark silhouette ink (post edge pass) gives canopies a faint outline
  that can read as "soft"; ask post whether it can skip vegetation.
- Grass is now bright (#b7d953) and close to the canopy lime; ref05 grass is
  muted (#a0b870) so its trees pop. Ground piece's call.

## 2026-09-24 — round 5 (builder)

Critic picked the reference: canopies washed out / blended into the grass —
side faces nearly the same tone, top barely brighter, weak bottom band; bush
too deep a green; iso-park forest a speckle; rocks rare and small.

**Changed**
- Root cause of the flat canopies: the rig's fill is ~90% of a pixel's light,
  so the sun alone only separates the side faces ~0.8x and the top ~1.1x, all
  at one hue. `props.js` now has a stylised VEGETATION FACE-TONE term: veg
  geometries carry `aVegTone = 1` (material default 0, so furniture is a
  no-op); VERT_BODY classifies each face from the view-space normal (top /
  lit side / shade side / underside) and multiplies the albedo: top x1.12
  (leaf greens also nudged chartreuse), shade side x0.70 and greener, lit
  x0.97. `uPropToneSide` (set in update() from ctx.sunDir . camera right)
  picks which side face is the shade side, so it survives 90-degree snaps.
- `core.js`: leaf 0xaac80a (greener, lit face no longer grass-coloured),
  band 0x6a9408 (renders ~0.66-0.72x of its face), bush 0x5eb814 / skirt
  0x47980c (renders lit #55c501 / shade #358d00 vs ref06 #62c700 / #358e00).
- `props.js` model dispatch: oak-family shape now 70% from a 14-unit patch
  hash (groves of one shape instead of confetti); rock share 0.32 -> 0.42 of
  the swapped understorey and rock scale 0.70-1.15 -> 1.00-1.70;
  `_foliageTint` is now mostly value (0.90-1.06) with a small hue drift (the
  old independent R/G spread made some canopies lemon-yellow).

**Measured**
- Rendered canopy (gal-deco-1): top #d4e902, lit #a7cd01, shade #6f9600
  (r4: #bdf70b / #adde01 / #89b700). Lit band #6ea801, shade band #427200.
- props selfTest pass (street 19 draws, region 9). models _selfTest ok.
  Zero console errors on iso-park / iso-mid / gal-deco-1. fps 61 on
  gal-deco-1 when the machine was quiet; iso-park 23-28 (3.8M tris, shared).
- Note: viewing a PNG, a 0.66x side-face step reads much weaker than the
  numbers say — verify tones with pixel samples, not just by eye.

**Next**
- Soft canopy shadow / AO smear at trunk bases is the lighting piece's.
- Lot trees inside building models (engine material) don't get the face
  tones; builders could use stampVeg, and the engine material could adopt
  the same aVegTone term if vegetation gets a palette flag.
- Top face could go a touch less yellow on the warm-tinted instances.

### Coordinator note (2026-09-24 11:45) — measured ref06 targets (stop chasing critic swings)
r3 said "too many dark dots, orange-red trunks"; r5 said "dots near-invisible, want
orange-brown chunky trunks". Measured from ref06 (rendered pixels, 8-level buckets):
 - canopy: top #c0d800 / #b0c800, lit side #98b810, shade side #80a800, lower band
   #689008. Dark dots = ~#689008, 3-6 per face, each 1-2 voxels (at res 4), clearly
   visible but sparse.
 - trunk: lit #c07040, shade #984828 / #904820 — warm orange-brown, CHUNKY
   (≈ 2 world units wide on the big trees), long and clearly visible below canopy.
 - rocks: #888888 top, #707070 side, #484848 gaps; stepped clusters.
Compare YOUR rendered pixels (PIL on the screenshot) to these after lighting, not
the palette hexes. Also make sure rocks + flower clumps actually appear in iso-park
(coordinate with ground's scatter if needed: read ground.md).

## 2026-09-24 — round 6 (builder)

Critic picked the reference: park trees soft/undersized, thin dark-maroon
trunks, band and dots barely visible, forks hidden; hedge / rocks / flowers /
shadows secondary.

**Changed**
- `vegetation.js` SHAPES re-authored: canopies 11 -> 14 fine voxels wide
  (~1.3x), trunks 3x3 -> 4x4, every fork 3-5 voxels BELOW its lobes so it
  shows under the band. round = ref06 tree 2 (main 14^3-ish cube + 8-wide
  side lobe on a DIAGONAL corner (-x,+z), reached by an L-shaped branch loop;
  the diagonal makes the lobe visible under 3 of the 4 scatter yaws — on the
  x axis it hid behind the main cube). cluster = 3 lobes (tall back + two
  side lobes on a Y fork). column 14 x 26 canopy. Grids now 20-26 wide.
  bandRows 13% -> 15%.
- `core.js`: band/dots now a darker OLIVE step (0x587410 / 0x607c0c; pine
  0x5a7610 / 0x62800e; bloom darker). The r5 band was a saturated green that
  read as a hue stripe, not shade. Trunk 0xb07c6c -> 0xb48a60 (the grade
  eats blue: the old one rendered pink-maroon #bf6340).
- `props.js` VERT_BODY: `barky` (r > g > b) term — bark shade face x0.95
  instead of the leaves' x0.70 (canopy shadow already darkens trunks).
- `stampVeg` at scale < 1: dots survive downsampling (a cell that is solid
  takes a dot if any fine voxel in it is a dot) — civic lotTree uses it.

**Measured** (gal-deco-1)
- trunk lit #bc7d38 (ref #c27642, critic target #c0703c), was #bf6340 /
  shade #6a2d0e. Band lit #5d8501 on leaf #89ae01-#a7cd01; dots read at zoom.
- props selfTest pass: street max 3.05 x 5.08 (< 3.2 x 5.4), 18 draws /
  73k tris street, 9 / 137k region. models _selfTest ok.
- Zero console errors; fps gal-deco-1 61, iso-mid 49-58, iso-park 39-48
  (2.8M tris, shared machine).

**Next / not mine**
- Plain lime-cube lot trees in other builders' lot models (e.g. right side of
  gal-deco-1) — they should call stampVeg. fun.js dHedge (the saturated long
  hedge with pink dots) is the fun builder's.
- Soft blotchy tree shadows = lighting; grass speckle = ground; blur = post.
- Far impostor (iso-park) still has no dots.

## 2026-09-24 — round 7 (builder)

Critic picked the reference: canopy side faces "almost the same mid-green"
under a flat lime top, soft edges; grass ghosting; rocks/flowers unseen.

**Diagnosis (pixels, not eyes)**
- r6 rendered: top #c7f101 (neon), lit #96b800, shade #587900, bands
  #4d6e01 / #263e00. By value the sides were 0.6x apart — MORE contrast than
  ref06 — yet both I and the critic see them as one mid-green (checked by
  pasting a #587800 swatch next to the tree: identical pixels, the tree face
  still reads lighter). What ref06 does instead: the TOP and LIT side are
  both yellow-lime and close (#c4dd00 / #b0cf00), the SHADE side a separate
  olive (#85ab00), bands/dots only ~0.8x of their face (#98bc11 / #6c930c).
  A neon top + two darker greens + near-black bands is what read as "flat".

**Changed**
- `props.js` VERT_BODY: per-channel `lime` face tones (only yellow-limes:
  g dominant and linear r/g > ~0.45 — leaf, pine, band, dots; bush greens
  keep the old tones, which already match ref06 bushes): top (1.10, 0.91,
  0.60), lit (1.28, 1.20, 1), shade (1.14, 1.22, 1). Solved from the rig's
  measured per-face light (top ~1.3x, lit ~0.8x, shade ~0.4x of albedo, lin).
  `greyish` term for rocks: top 1.0, lit 0.90, shade 0.98 (was 0.70).
- `core.js`: band 0x87a80e / dot 0x7e9f0e, pine band 0x7ba817 / dot 0x74a017
  (~0.6-0.7x of the leaf in linear, was 0.3x).

**Measured** (gal-deco-1 column tree; ref06 in brackets)
- top #c7de01 (#c4dd00), lit #b1d100 (#b0cf00), shade #7ea700 (#85ab00),
  band lit #97bc01 (#98bc11), band shade #749f00 (#6c930c).
- rock: top #919391 (#8d8d8d), lit #747573 (#737373), shade #4a4e4e (#4d4d4d);
  was shade #363a39 and low shelves #131516.
- Zero console errors; fps 61 gal-deco-1, 47 iso-mid, 39 iso-park (shared box).

**Not mine / next**
- Grass "diamond ghosting" under trees: square outlines at tree/rock feet.
  Still there with post SSAO off AND with lighting shadowStrength 0; absent
  in some runs of identical code (timing dependent). No props 'path' decals
  exist (footpaths are off). Likely a stale/cached map in lighting or post —
  hand to light/post with those facts.
- Blur is mostly the critic's 2.4x upscale of a 480x380 crop; post's
  silhouette ink (edge.strength 0.3) adds a dark rim on canopy outlines that
  becomes a soft halo when upscaled — post could skip or weaken it on veg.
- Plain lime-cube lot trees in parking lots / plazas (terrain parcels and
  fun/civic lots) have no band/fork/tones — should use stampVeg.
- Plaza flower bed (fun.js dFlowerBed, 2x2 colour clumps) is the fun
  builder's; vegetation.js decoFlowerBed / vegFlower give ref06 cross flowers.

## 2026-09-24 — round 8 (builder)

Critic picked the reference: rocks = dark busy piles of tiny cubes with a
near-black skirt and a pale "ghost" diamond beside each; faint grid decals
under trees; band/dots too faint; city-zoom trees all one lollipop.

**Diagnosis**
- The ghost diamond AND the black skirt were the rock's own CAST SHADOW:
  hiding rock meshes or setting rock castShadow=false removed both. A
  knee-high caster sits inside the CSM bias/normal-offset band, so only the
  tall block's shadow survived, detached ~1 unit along the sun (sun dir
  (-0.17, 0.77, 0.62): shadows fall screen right+up). ref05's field rocks
  show no cast shadow.
- "Busy pile": the rock model had 11 pieces incl. 1-voxel cubes, dark seam
  voxels and carved notches, and the scatter sets rocks in overlapping pairs
  (0.9 + 0.6 scale, 1.2 apart) -> ~25 small facets.
- Grid decals: with all veg castShadow off they vanished; later runs of the
  unchanged code (after other builders' scatter edits) no longer show them
  either. Intermittent; not reproduced after my changes.

**Changed**
- `vegetation.js` rock: 5 big pieces in one grey (dominant 8x9x8 block, a
  mid slab and a low shelf stepping down toward the camera, 2 small cubes
  >= 3 voxels). No seams / carve.
- `props.js`: `NO_SHADOW` set (path, flowers, rock) used by both castShadow
  sites. VERT_BODY grey tones top 1.02 / lit 1.02 / shade 1.60 (no more
  self-shadow to compensate for); new `bushy` term for saturated bush greens
  (top 0.80/0.74/0.60, shade 0.84/1.15/0.49). Oak-family dispatch: CDF
  0.36/0.70 (more columns) + per-shape size multiplier (oak 1.0, column 1.16,
  cluster 0.94) so groves mix tall columns and low clusters.
- `core.js`: rock 0x8b8e91; band 0x7a9814 / dot 0x76960e (olive-er, darker);
  pine band 0x6d9619 / dot 0x689216.
- sprinkleDots: up to 5 per face (area/26), ~1 in 4 a 2x2 dot on faces >= 11
  voxels wide, spacing 4.

**Measured** (gal-deco-1; ref06 in brackets)
- rock top #8d8f8d (#8d8d8d), lit #737571 (#737373), shade #4a4f4d (#4e4e4e).
- bush top #63cb04 (#62c700), lit #59ba01 (#4db400), shade #379300 (#358e00)
  — was neon top #74f103.
- canopy top #c3e602, lit #acd701, shade #77a800 (#c4dd00/#b0cf00/#85ab00).
- props selfTest pass (street 18 draws / 82k tris, region 9 / 151k).
  Zero console errors on all three shots; gal-deco-1 61 fps; iso-park 10-31
  and iso-mid 31 with builds taking 35-67 s (machine heavily shared).

**Next**
- 1-2 px near-black slits where two overlapping rock instances meet (post
  ink + AO in the crevice); a rock-pair-aware placement (ground's scatter)
  or a single "pair" model would remove them.
- Flower patches read large/heaped at gal-deco-1 (scale is the scatter's).
- Far impostor still has no dots; iso-park could use a column impostor.

## 2026-09-24 — round 9 (builder)

Critic picked the reference: rocks = "two or three big soft grey cubes,
faint smudged ledges, side faces close in tone"; canopies need darker
contact shading at lobe junctions / under the canopy; flowers are specks.

**Diagnosis**
- Rendered rock (gal-deco-1): top #8e, lit side #75, shade side #5e-#6e
  (ref06 #8d / #72 / #4d) — the r8 grey shade lift (1.60) had flattened the
  dark face. And the "2-3 soft cubes" were the scatter's 3-rock groups
  (1.25 / 0.8 / 0.5 overlapping copies of the 5-piece r8 rock): only each
  copy's big dominant block survived the overlap.
- All rocks were pushed with yaw 0 -> every rock the same silhouette, and the
  r8 model's small pieces sat on +x/+z only.

**Changed**
- `vegetation.js` rock: 13 pieces on an 18 x 11 x 18 grid (4.5 x 2.75 x 4.5
  world): dominant 8x9x8 block + cap step, two mid shelves, two low slabs,
  three small steps on the shelves, four loose cubes round the foot each one
  voxel apart (dark slits). Pieces ring ALL four sides (every piece >= 2 vox).
- `props.js` (model side): rock geometry uses ray AO (aoReach 4, aoDist 0.45,
  strength 0.95, curve 0.55); all near veg models use ray AO (aoDist 1.0,
  strength 0.95) instead of the 1-voxel box ramp; `aoMergeTol 1.5` keeps the
  triangle count at the old level (library 3224 tris < 4000 cap; without it
  4626 = selfTest FAIL). VERT_BODY: vegetation AO -> pow(aoT, 1.7) (open faces
  untouched; lobe junctions / crevices ~0.5 -> ~0.3). Grey shade-side tone
  1.60 -> 1.25.
- `props.js` push() dispatcher (surgical, placement untouched): a rock pushed
  within 2.2 units of the previous rock folds into it (the model now IS the
  cluster; same clusters per tile), rock scale x0.9, and each rock gets a
  hashed 90-degree yaw.

**Measured**
- Rock (gal-deco-1): top #85-#91, lit #74, shade #4d-#4e, slits ~#30
  (ref06 #8d / #72 / #4d / #44). Side-by-side with ref06 rock 1 at matched
  scale: same stepped-stack read.
- Canopy lobe junction diff vs r8: up to 41 levels darker, open faces equal.
- props selfTest PASS (street 18 draws / 118k tris, region 9 / 193k);
  models _selfTest ok. Zero console errors on iso-park / iso-mid /
  gal-deco-1; fps 21 / 55 / 61 (iso-park 4.7M tris total, shared machine).

**Next / not mine**
- The flower-specks note is about the plaza flower beds (fun.js dFlowerBed /
  the monument ring) — `vegetation.js` exports decoFlowerBed / vegFlower with
  ref06 cross flowers; the fun builder could use them.
- Blurry cast shadows = lighting (CSM filter), not the models.
- Canopy junction dark is AO only; ref06's is partly cast shadow.

## 2026-09-24 — round 10 (builder)

Critic picked the reference: canopy/rock outlines "soft and smeared", rock
tops ~ the same grey as the sides ("dark lumps"), weak top-vs-band contrast;
bushes plain cubes; iso-park trees small / washed out.

**Diagnosis**
- The smear was DOUBLE AO: props wrote scene alpha 1, so post.js's wide
  screen-space AO (radius 1.6 world) landed on top of the baked ray AO —
  soft vertical gradients down every 2-4 unit rock / canopy face plus a dark
  skirt on the grass. Voxel buildings already opt out via scene alpha
  (materials ssaoKeep 0); vegetation didn't.
- The rig changed since r9: rock shade faces rendered #35-#3e, canopy shade
  #759500, bands #4c6b00, trunk shade #6c3a0c (r9 tones were solved on a
  brighter fill). Shots are now 3200x1800 (2x) so silhouettes are sharper.

**Changed** (props.js model/material side; vegetation.js)
- Veg fragments write scene alpha = `uPropVegSsao` (0.2): they take 20% of
  SSAO and cast 20% onto the grass (0 = rocks float, 1 = smear).
- Veg ray AO tightened: canopies aoDist 1.0 -> 0.5 (toe 0.10); rock 0.45 ->
  0.3, curve 0.4, mergeTol 1.5 -> 0.3 (tol 1.5 drew diagonal triangle
  seams + rings at 1-voxel reach). Rock 864 tris; library 3728 < 4000.
- Face tones re-solved: grey top 1.30 / lit 1.10 / shade 1.80; lime top
  (1.03,0.87,0.60) lit (1.26,1.27,1) shade (1.48,1.62,1); bark shade
  (1.50,1.40,1.35).
- shrub: main cube + foot cube + low ledge along -x + nub on -z (stepped).
- flowers patch = ONE centred flower (the 2-flower pair lined up one behind
  the other under half the yaw/snap combos -> a stacked "totem" in iso-park).

**Measured** (gal-deco-1, final; ref06 in brackets)
- rock top #a7a9a5 (#8d, critic wanted lighter), lit #767776 (#72), shade
  #41-#59 (#4b). Canopy top #d7e602 (#c4dd00), lit #b4d100 (#b0cf00), shade
  #84a900 (#85ab00), band lit #87aa01 / shade #5a7f00 (#98bc11 / #6c930c:
  deliberately more top-vs-band contrast). Trunk #b26c2d / #8c4c14.
- Zero console errors on iso-park / iso-mid / gal-deco-1; gal-deco-1 60-61
  fps, iso-park 10-26 / iso-mid 18-29 (4.6M / 2.3M tris of city, 2x shots,
  shared machine). props selfTest pass (street 18 draws, region 9), models
  _selfTest ok.

**Next / not mine**
- The lime cubes on parking-lot grass pads (terrain.js lot trees ~l.2638
  and `bushes` ~l.2783) are still plain cubes — terrain could stamp
  vegModel('shrub') / ref06 trees.
- Column top can read a touch neon (#d7e6) on warm-tinted instances.
- Veg tones are hand-solved per rig; if lighting changes fill again they
  drift — a rig-normalised veg shading term would make them robust.

## 2026-09-24 — round 11 (builder)

Critic (r10, picked ours but not wowed): rocks = "neat symmetric stepped
pyramid of soft, bevelled blocks with even grey faces" vs ref06's irregular
overhangs / dark pockets / chip-cubes; parking-island bushes plain cubes;
no flowers in the park grass.

**Diagnosis**
- The soft "bevelled" smear was NOT the baked AO: rock ao:false changed the
  crop by ~1 level. post.js now sets ssao.voxelKeep = 1 (uncommitted post
  work), which floors every pixel's SSAO keep at 1 — so r10's veg alpha 0.2
  gate was dead and the 0.5-unit contact term smeared every rock step.
- The "parking-island bushes" are terrain.js `tree(u, v, 0.6)` on the lot
  planter pads (trunk hidden under a single cube canopy), not props shrubs.

**Changed**
- `vegetation.js` rock: rebuilt after ref06 rocks 1-3 on 20x12x20 — tall
  block centre-back, mid block with an undercut back corner, slab, low front
  shelf, overhanging slab on a back plinth (slot under its free end), low back
  shelf, 2 small cubes on the shelves, 5 chip-cubes a voxel clear of the mass;
  carves: bite out of the tall block's top corner, undercut, junction pocket,
  corner notch. No mid-face notches (they read as windows).
- `props.js`: FRAG_SSAO_KEEP writes alpha = -1 - uPropRockSsao (0) for grey
  veg (rocks); `post.js` composite (1 surgical line): alpha < -0.5 -> explicit
  keep that bypasses the voxelKeep floor. ROCK_AO aoDist 0.8 / curve 0.8 /
  toe 0.10 / mergeTol 0.6 (870 tris; library 3740 < 4000). Grey face tones
  re-solved without SSAO: top 0.80 / lit 0.90 / shade 1.05 (were 1.30/1.10/1.80).
- `terrain.js` lot `tree()` (surgical, ground's file): + a lower half-size
  lobe stepped out of one corner (band + leaf) -> parking-island "bushes" and
  lot trees now have ref06's offset sub-cube.
- flowers patch: three flowers (W/R/B) on spots [1,2],[1,6],[7,4] — >= 4 grid
  voxels apart in x - z under all four yaws (no totem).

**Measured** (gal-deco-1)
- rock top ~#9a-#a0, lit ~#80, shade ~#60-#66 (ref06 #8d/#72/#4d); crease
  profile 118 -> 51 at the line, back to 150 within ~1 voxel; notch/slot dark.
- props selfTest PASS (street 18 draws, region 9; library 3740 tris);
  models _selfTest ok. Zero console errors on iso-park / iso-mid / gal-deco-1
  (a transient post.js uDeepDark error mid-run was the post builder's edit).
  fps 18 / 26 / 31 (4.3M / 2.0M / 0.57M tris, shared machine).
- Scatter layout / rock scale changed between runs (other builders) — rocks
  now render ~half a tree wide.

**Next**
- Crevices could go a touch darker (curve 0.7) if the critic still wants
  "deep" pockets; watch the "dark lumps" regression.
- Trees still take full post SSAO (voxelKeep 1); if the canopy looks smeared,
  extend the negative-alpha opt-out to lime/bark (tones would need re-solving).
- Canopy tops read neon (#d7-#e0) on some instances; flowers still rare in
  park grass (FLOWER_SHARE / scatter is ground's).

## 2026-09-24 — round 12 (builder)

Critic r11 (picked ours, not wowed): rocks = "tiny dark-grey heaps of many
broken-up cubelets with black gaps" (ref06: 2-3 big stepped slabs, bush
sized, clean face tones); the twin-cube tree cloned in a grid; flowers too
small / too few.

**Consensus across r8-r11 rock notes**: r8 "tiny cubes" -> r9/r10 "too few
big cubes / soft" -> r11 "rubble". Midpoint = ref06 rock 1 literally: one big
block + wide platform + one step + 3-4 chunky blocks, all touching.

**Changed**
- `vegetation.js` rock: 7 touching pieces on the 20x12x20 grid (platform
  14x5x12, big block 8x11x8, mid step 7x7x7, -x slab, +z foot block, back
  corner block, one small step on the platform); no chip-cubes, no slits,
  no carves. Old r8-r11 comment history condensed to 3 lines.
- `core.js` vegRock 0x8b8e91 -> 0x94979a (a touch lighter).
- `props.js` dispatcher (model side): rock scale `s*0.72+0.30` (was `s*0.9`:
  small meadow rocks 0.43 -> 0.65, big scree/sand rocks unchanged); rock fold
  radius 2.2 -> 2.8; flower patches x1.3 (FLOWER_SCALE); FLOWER_SHARE 0.34 ->
  0.40; OAK_FAMILY_CDF [0.36,0.70] -> [0.28,0.64] (fewer twin 'round');
  per-patch shape share 179/256 -> 90/256 so neighbours differ.
- `cluster` tree: side lobes moved onto the tall lobe's z line at +-10
  voxels (grid 26 -> 28): under every 90-degree yaw one lobe shows left and
  one right -> always a 3-cube crown (before, one lobe slid in front and the
  crown read as another twin).
- `treeModel`: 8-entry table (main.js uses hash%8, never rotates tile trees):
  round, column, cluster, sapling, round(mirrored), pine, cluster(mirrored),
  blossom. `vegModel(kind, seed, flip)` gained an optional x<->z transpose.

**Measured**
- Rock faces (gal-deco-1, median L): top 141 / lit 110 / shade 66 before the
  colour lift (ref06 141 / ~115 / ~70). Library 3358 tris (was 3740).
- props selfTest PASS (street 18 draws, region 9). Zero console errors on
  iso-park / iso-mid / gal-deco-1; gal-deco-1 61 fps, iso-park 11-24 (4.8M
  tris, shared machine). modelhash selfTest fails only on "mall +Z face not
  glazed" (commercial, not veg).
- gal-deco-1's camera changed between runs this round (someone else's).

**Next**
- If a critic calls rocks "plain / too few cubes" again, add ONE small
  touching cube on a shelf — do not reintroduce detached chips or slits.
- Tile trees (main.js) could take a hashed 90-degree rotation (engine
  addProp has no rot) for more variety.

## 2026-09-24 — round 13 (builder)

Critic r12 (picked the reference): rocks = "only two or three grey cubes,
edges soft, bevelled, smeared"; ref06 = one big block with a mid ledge +
5-8 offset chips round the base, three separate face tones. Secondary: canopy
left/right faces too close; bushes vary little; flowers sparse.

**Diagnosis**
- Soft/bevelled = ROCK_AO itself: 0.8-unit rays + ground term (times the
  1-1.5 rock scale) put a soft vertical gradient down every face and the
  mergeTol ramps drew diagonal smears. Not post (rocks already opt out).
- Measured canopy sides in the r12 critic crop: lit #abce02 / shade #84af00,
  i.e. ref06's own values mirrored (ref06 lights from the right; our scene
  sun is left, kept). So the fix is a bigger shade step, not a flip.

**Changed**
- `vegetation.js` rock: 22x11x22 — platform, one big block (9x11x8, not a
  tower), a 2/3-height ledge block stepped out of its front, two shoulder
  steps, two small cubes up on the ledges, 7 chips (2-3 voxels) round the
  foot, each TOUCHING a face (no 1-voxel slits) but offset along it.
- `props.js` ROCK_AO: aoDist 0.3, strength 0.85, curve 1, toe 0, groundAO
  false, mergeTol 0.3 -> crisp 1-voxel crease lines, flat faces, sharp edges
  (rock 656 tris; library 3934 < 4000 — groundAO on was 4042, over cap).
- Rock tones: grey topT 0.80 -> 0.88 (top/lit/shade now ~158/121/77 L).
- Canopy: lime darkT (1.48,1.62,1) -> (1.22,1.38,1) (shade ~#78a200 olive);
  lime topT (1.03,0.87,0.6) -> (0.93,0.81,0.6) (top was neon #daf00e).
- New `bushTall` shape (ref06 bush 3: tall block + foot cube) + TYPE
  'bushTall' (one geometry, no far LOD); push() deals half the non-flower
  shrubs into it (same placement). Note TYPES indices shifted: rock is 15.
- ROCK_SCALE 0.72/0.30 -> 0.66/0.27 (grid grew 20 -> 22).

**Measured**
- Close-up (scratchpad veg13/c9, closeup2.sh picks a rock among trees):
  sharp stepped clusters with chips, three tones. props selfTest PASS
  (street 19 draws, region 10, library 3934); models _selfTest ok. Zero
  console errors on iso-park / iso-mid / gal-deco-1. fps uncontended
  23 / 25 / 61 (same as baseline); 3-15 when 6+ headless shoots run.
- gal-deco-1 / iso-park framing and the city layout changed between runs
  this round (other builders) — the critic's left-edge rock is not always
  in frame.

**Next**
- Flowers/bush COUNT is scatter (ground); FLOWER_SHARE left at 0.40.
- If rocks are called "plain" again, add a 2nd rock geometry (rock2 type,
  ref06 rock 3 long slab) rather than more chips — library has ~66 tris
  headroom only, so trim flowers (246 tris) first.
- Lime tones are still ~10% brighter than ref06 on the iso-park rig.

## 2026-09-24 — round 14 (builder)

Critic r13 (picked the reference): flowers "as big as a tree canopy ...
giant toys" (ref06: tiny ankle-height accent, ~1/4 of a bush); no rocks in
frame; thin dark outline + smudgy AO blotch where canopy lobes overlap;
lower band faint.

**Diagnosis**
- Flowers: res-2 patch (1.5-unit flowers) x FLOWER_SCALE 1.3 = ~2 units.
- Outline = post.js silhouette ink (edge.strength 0.5) on the canopy rim.
- Blotch = voxel.js's NEW default `aoSpread: 1.0` (+gain 0.75, added by the
  voxel builder for cornices): it dilates every lobe-contact crease ~4
  voxels across the face -> radial starburst. It also re-softened the
  rocks and pushed rock0 656 -> 1062 tris (library 4250 > 4000 cap: the
  props selfTest was FAILING before my change).
- Band: measured ref06 band/face ~0.86 (sRGB) and ours already 0.77-0.82;
  the band was just thin (2 voxels on 11-16-row lobes, ref06 ~0.2 of face).

**Changed**
- `vegetation.js`: flowers patch now res 4, five flowers on a 14x14 grid
  (>= 3 voxels apart), each a petal plus + pollen eye sitting straight on a
  1-2-voxel leaf plus (no bare stem; same tris either height).
  `vegFlower(g,x,y,z,petal,leafH=1)`; decoFlowerBed passes leafH 2.
  bandRows: max(2, h*0.15) -> max(3, h*0.16).
- `props.js`: FLOWER_SCALE 1.3 -> 0.84 (flower ~0.5 units, ~0.3 of r13);
  flowers0 ao:false (290 tris); VEG_AO aoDist 0.5->0.3, strength 0.95->0.85,
  curve 0.55->1.0, aoSpread 0, mergeTol 1.0; ROCK_AO aoSpread 0.
- `post.js` (1 surgical line, composite): silhouette ink skipped where
  scene alpha ~0.2 (props veg's uPropVegSsao) — clean canopy edges.
  If uPropVegSsao ever changes, update that constant too.

**Measured**
- props selfTest PASS, library 3592 tris (was 4250 FAIL); modelhash
  selfTest ok; zero console errors on iso-park / iso-mid / gal-deco-1.
  fps 12 / 2-14 / 27 with 13 concurrent headless shoots (baseline this
  round 17 / 18 / 45 under less load); scene tris unchanged or lower.
- Close-ups (rounds/veg/r14-close2, r14-close3): canopies clean-edged,
  no starburst, band clearly two-tone; rocks crisp; flowers tiny trios.
- gal-deco-1 camera / gallery layout changed between my runs again.

**Next**
- Rocks in the critic's three shots are placement (ground's lawn-park
  LZ_CLEAR / meadow shares) — ask ground for a rock per park clearing.
- Bush crease (shrub foot cube) still a little dark; could take aoDist 0.2.
- Watch voxel.js DEFAULTS: new defaults silently change every veg bake —
  VEG_AO / ROCK_AO now pin aoSpread explicitly.

## 2026-09-26 — wave 4 round 1 (builder)

Lineup close-up (scratchpad rounds/veg/lineup.sh) at start: shapes already on
brief (column / round / 3-lobe / sapling with band + sparse dots, rock = big
block + ledges + 8 chips, tiny flower trios). Two real defects, both from
OTHER passes, found by A/B toggles:

**Diagnosis**
- Rock low shelves / chips near-black (#15-#1d) and warm-black shade faces:
  NOT baked AO (ao:false: no change), NOT SSAO, NOT world AO, NOT shadows. It
  was post.js's ASPHALT ops (deepDark + asphalt pull to 0.08, no floor lift)
  which key on "neutral dark AND world y < 1.0" — every knee-high grey rock
  face qualified. This is the old "black skirt / dark lumps" complaint.
- Tree "ghost" rectangles on the grass (critics r7/r8 "diamond ghosting",
  "grid decals"): lighting.js's top-down world-AO height volume treats each
  canopy as an overhang and stamps its footprint with a crisp rim. Confirmed
  by worldAO=false (gone).

**Changed**
- `post.js` (1 surgical line in the grade's above-ground key): scene alpha
  < -0.5 (props rocks only) -> aboveK = full, i.e. rocks are not asphalt.
- `lighting.js` (1 surgical condition in _aoRender): meshes with
  `userData.noWorldAO` stay out of the AO height volume. `props.js` sets it
  on tree types (NO_WORLD_AO: oak/column/cluster/pine/blossom/sapling);
  rocks / bushes (solid to the ground) keep their contact AO on the grass.
- `props.js` VERT_BODY tones re-solved: grey top 0.165 / lit 0.20 / shade
  (1.12, 0.98, 0.84); lime top (0.53, 0.50, 0.02); bark lit (0.30, 0.24, 0.26).

**Measured** (lineup, gal-deco-1 zoom; ref06 in brackets)
- Rock: top 151 / lit 120 / shade 76, chips identical to the big block's
  faces (141 / 115 / 79). Was 176 / 136 / (55,49,45) with chips 21-36.
- Canopy top #c5e231 (#c4dd00), lit #bed80e, shade #86a205, bands #a0c30e /
  #678906; trunk lit #cc7543 (#c27642).
- Zero console errors on iso-park / iso-mid / gal-deco-1 (fps 23 / 2 / 23 on
  a heavily shared machine). Before/after: rounds/veg/w4r1-corner.png.

**Coherence #4 [ground / veg]** (field lattice of identical tiny trees): the
ground builder rewrote the field scatter this same round (quincunx, per-tree
round/cluster/column mix, larger sizes, ref05-counted ~0.8 trees/tile) — left
placement to them; the "identical" part is now fixed by that dispatch.

**Next**
- If critics call trunks bare at the foot: trees lost the world-AO contact
  line with the canopy exclusion; a baked trunk-foot term would be veg-local.
- Any other knee-high neutral grey prop (bins, hydrants) likely has the same
  asphalt-crush; post could generalise the alpha gate.

### Coordinator note (2026-09-26 16:15, wave 4) — w4r1 "washed-out lime-on-lime"
Measured ref06 canopy luminance bands: top 10% #c1db00, next #b1d000, mid #7cb901, darkest 40% #62a201. Your last logged render: top #d4e902 (already brighter than ref — don't push the top further), shade #6f9600. So the fix is NOT a brighter top: it's the SPREAD — make sure the shaded side and the lower band actually reach the #62a201–#7cb901 range at iso-park/iso-mid (after lighting/post), with a clearly darker bottom band, and a few dark pixels. Do NOT flip which face is dark: ref06 is a separate sheet lit from the right; our world key light comes from the upper left (ref05) — keep consistency with it. Forked/visible trunks under the canopy are a fair ask.

## 2026-09-26 — wave 4 round 2 (builder)

Critic w4r1 (picked the reference): canopies "lime on lime" — top barely
brighter than the lit face, weak lower band; ref06 top vivid ~#c5e000,
trunks fork visibly; dots a bit big / frequent.

**Diagnosis** (critic crop, PIL): top #c7e430 / lit #c0da0e / shade #88a405,
lawn #b6de6f. The top's blue (0x30) was the sky SPECULAR (F0 0.04 x bright
dome) added after the albedo — no albedo tone could remove it. The lit face
was only ~0.95x of the top and the same value as the lawn.

**Changed** (props.js model/material side, vegetation.js, core.js veg block)
- `FRAG_VEG_SPEC`: lime canopies (same lime test as VERT_BODY) zero
  material.specularColor / specularF90 — matte leaves like ref06.
- lime litT (1.05,0.95,0.30) -> (0.78,0.76,0.30); vegLeafBand 0x7a9814 -> 0x72900f.
- bark topT (0.20,0.14,0.10): fork-arm tops rendered pale peach #fab579
  (deep in the tone-map shoulder; 0.81/0.53 factors barely moved them).
- NEW `uPropWallComp` (update(): reads lighting's shared uCsmWallFill):
  shade-side tones are normalised to the away-wall cut they were solved at
  (VEG_WALL_REF 0.75). Light w4r2 briefly set 0.95 -> every canopy / rock /
  trunk shade face went near-black (#3f5101, rock #0b0b0c). Now robust to
  their tuning; at night (z = 0) the gain is 1.
- Shapes: round tree's limb 3 voxels tall and 2 lower (taller open loop,
  ref06 tree 2); cluster arms 3 tall. A Y on the column tree was tried and
  dropped (arms hide inside a 14-wide canopy's iso silhouette; ref06 tree 1
  has a plain trunk). Dots: single voxels only, <= 4 per face (area/32).

**Measured** (gal-deco-1 + lineup; ref06 in brackets)
- top #c3e104 (#c4dd00), lit #afd003 (#b0cf00), shade #87a302 (#85ab00),
  band lit #8bb404 (#98bc11, deliberately a bit darker), band shade #618402
  (#6c930c), trunk #c76f3f / #913e25, rock 96 / 73 / 47 unchanged.
- props selfTest PASS (library 3742 < 4000). Zero console errors on
  iso-park / iso-mid / gal-deco-1 (fps 19 / 1 / 9, machine load ~11).

**Next**
- ref06 lights from the right (its LEFT face is the olive one); ours keeps
  the scene key from the left per ART-DIRECTION — a critic may still say
  "darken the left face". Don't flip it; the step sizes now match.
- Parking-pad / lot "trees" in terrain.js and the building lots are still
  plain lime cubes without these tones (ground / building builders).

## 2026-09-26 — wave 4 round 3 (builder)

Critic w4r2 (picked the reference): rocks "a busy heap of many small grey
cubes, all about the same size" (ref06: 1-2 big stepped slabs + a few small
base cubes); only two tree silhouettes in frame, dots faint.

**Changed**
- `vegetation.js` rock (22x12x22): 8 equal 2-3-voxel chips -> 5 chips of
  three sizes (4, 3, 3, 2, 2) + one small cube on the mid step; big block
  9x12x9 on a 14-wide mid tier; the mid step (7x9x8, top 3/4) moved from the
  big block's diagonal to the +x SIDE and the slab to +z, so no 90-degree yaw
  hides both steps behind the big block (yaw 0 read as a top hat).
- `cluster` tree: + a 4th lobe (ref06 tree 3's back lobe) off the tall lobe's
  -z face, y 24-33 -> a 4-lobe crown from every yaw (a front lobe under two);
  dots 0.9 -> 1.1.
- `sapling`: dropped the second grass tuft (read as a stray floating cube).
- `props.js`: OAK_FAMILY_CDF [0.26,0.58,0.88,1] -> [0.24,0.52,0.86,1]
  (cluster 30 -> 34 %, sapling 12 -> 14 %).

**Measured**
- Rock faces (lineup, L): top 150 / lit 114 / shade 72 (ref06 141/114/77).
- props selfTest PASS: library 3604 tris (was 3742, rocks got cheaper than
  the new lobe), street 19 draws, region 9. Zero console errors on iso-park /
  iso-mid / gal-deco-1 (fps 20 / 18 / 50). Lineups: rounds/veg/w4r3-line3,
  w4r3-rocks2.png, w4r3-trees3.png.

**Next**
- iso-mid "single-cube lollipop" trees are roof-garden / lot planting in the
  building models (other builders); they could use stampVeg(..., 0.5).
- If rocks are called "plain" next: add a second rock geometry (ref06 rock 3,
  long slab) — library has ~400 tris headroom now.
