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

## The six standard shots

Then, for each shot name, run `BVDEMO.shot('<name>')` and take a screenshot:

| Shot | What it is there to expose |
|---|---|
| `hero` | The signature Cities:Skylines mid-orbit view. Overall impression. |
| `street` | Street level. Materials, road markings, AO and sidewalks have nowhere to hide. |
| `region` | Full map at max zoom-out. Terrain, water, atmosphere, and distance aliasing. |
| `golden` | Golden hour. Atmosphere, raking shadows, warm/cool separation. |
| `night` | Emissive windows, neon, bloom, street lighting. |
| `waterfront` | Water shader, shoreline foam, reflections. |

## How to judge

You are grading against **retail Cities: Skylines**, not against "good for a
browser game". The bar is: shown these two screenshots blind, an experienced
player picks ours. Anything less is a fail.

Specific tells to hunt for, in the order they usually give the game away:

1. **Aliasing** — any stair-stepped edge, at any zoom. Instant fail.
2. **Missing contact darkening** — objects that look pasted onto the ground
   rather than sitting on it. Look at every building base and every curb.
3. **Flat lighting** — surfaces at different angles reading the same brightness;
   no sense of a directional key light with a colour.
4. **Untextured surfaces** — large areas of a single flat colour. Especially
   grass, asphalt and building walls.
5. **No atmosphere** — no depth haze, no aerial perspective, distance reading as
   the same "weight" as the foreground.
6. **Uniform focus** — Cities:Skylines' miniature read comes from tilt-shift.
   Everything equally sharp looks like a diagram.
7. **Dead water** — water that does not move, reflect, or shallow out at shore.
8. **Repetition** — visible tiling, identical checkerboards, obviously repeated
   props.

## Reporting

Report per shot: a verdict (`AAA` / `NOT AAA`), and if `NOT AAA` a ranked list of
concrete, actionable defects — what is wrong, where in the frame, and what the
fix is. No praise, no hedging. If you would not pick our screenshot blind
against Cities:Skylines, say `NOT AAA` and say exactly why.
