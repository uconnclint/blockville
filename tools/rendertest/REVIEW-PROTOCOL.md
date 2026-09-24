# Visual review protocol

Every graphics reviewer for this overhaul uses **exactly** this procedure, so
that iteration-to-iteration comparisons and blind A/B judgements are honest.

## Setting up the reference city

1. Ensure the dev server is up: `preview_start {name:"blockville"}` (port 8351,
   serves the repo root).
2. Create **your own** browser tab (`tabs_create`) and pass that `tabId` to every
   browser call — several reviewers run at once.
3. Navigate to `http://localhost:8351/index.html`.
4. Click through: **Start Building!** → **Everything** → **Let's build!**
5. Run this in the page to lay out the deterministic reference city and hide the
   HUD:

```js
(async () => {
  const r = await fetch('/tools/demo-city.js', {cache:'no-store'});
  (0,eval)(await r.text());
  const p = BVDEMO.build();
  BVDEMO.hideUI(true);
  return JSON.stringify(p);
})()
```

   The layout is seeded, so every reviewer gets the same city.

## Standard shots

Headless (preferred): `node tools/rendertest/shoot.mjs --out <dir> --shots iso,iso-close,iso-wide,iso-night,iso-water,iso-park`.
In a browser tab: `BVDEMO.shot('<name>')`, then screenshot.

The game camera is a **true-isometric orthographic** camera (35.264° elevation,
45° diagonals, 90° snap rotation), so review through it. All `iso*` shots are
deterministic (fixed seed, clock, weather, DOF, and a snap chosen from the sun).

| Shot | What it is there to expose |
|---|---|
| `iso` | Overview framed like ref05: ~5-7 blocks, downtown + houses + greenery. Overall impression. |
| `iso-close` | One building + its lot at ~60-70% of the frame, like ref04. Voxel crispness, materials, AO, edges. |
| `iso-wide` | Whole map at max zoom-out, plus countryside and water. Distance aliasing, terrain, haze. |
| `iso-night` | Same framing as `iso` at night. Windows, lamps, bloom. |
| `iso-water` | The shore nearest downtown. Water, shoreline, sand, town edge. |
| `iso-park` | The greenest neighbourhood. Trees, grass, rocks, flowers. |

The legacy perspective-angle shots (`hero`, `street`, `region`, `golden`,
`night`, `waterfront`) still work, but they now render through the ortho camera
at those angles — use them for regressions only.

Camera/interaction regression check: `node tools/rendertest/isocheck.mjs`
(picking at all 4 rotations and zoom extremes, pan anchoring, focusAt, ghost,
paint, near/far clipping). Must print `"pass": true`.

## How to judge

The target is Pablo Gamedev's **Isometric City Voxel** look (reference images
ref01/ref04/ref05): a crisp, bright, saturated, true-isometric voxel diorama.
Shown our frame next to the reference, it should read as the same art style.

Tells to hunt for, roughly in priority order:

1. **Softness** — blurry voxels or edges. The reference is pin-sharp everywhere;
   any tilt-shift must be subtle and never smear the subject.
2. **Muddy or grey colour** — the reference is bright, clean and saturated;
   dull greens, grey haze or dark exposure fail.
3. **Flat lighting** — the three visible faces of a block (top / left / right)
   must read as three clearly separated values, with soft contact shadow at bases.
4. **Noise and texture clutter** — the reference uses clean flat colour per voxel
   with light AO; noisy detail textures on grass, roads or walls look wrong.
5. **Aliasing / shimmer** — stair-stepped edges or crawling at any zoom.
6. **Weak lot/sidewalk definition** — the reference reads as clean tiles with
   kerbs and pavements separating lots from roads.
7. **Dead water** — water should be a bright, clear blue with a readable shoreline.

## Reporting

Report per shot: a verdict (`ON STYLE` / `OFF STYLE`), and if `OFF STYLE` a
ranked list of concrete defects — what is wrong, where in the frame, and the fix.
