# CONTRACTS-RENDER.md — the AAA render layer (`src/render/`)

Binding spec for the Cities-Skylines-grade graphics overhaul. Every module under
`src/render/` is written **independently** against this document. Only
`src/engine.js` imports them; render modules never import each other except where
this file explicitly says so.

Read this before touching anything in `src/render/`.

---

## 0. Hard constraints (non-negotiable)

1. **Three.js r160, vendored.** Import with
   `import * as THREE from '../../vendor/three.module.js';`
   Nothing from `three/addons` / `three/examples` is vendored — if you need
   EffectComposer, SSAO, bloom, SMAA, Sky, Water, **write it yourself** in your
   module. Do not add files to `vendor/`.
2. **No build step, no npm, no network.** Plain browser ES modules. No CDN
   `<script>`, no `fetch()` of assets, no binary asset files. Every texture must
   be **generated procedurally** at runtime (canvas 2D, `DataTexture`, or pure
   in-shader noise). Keep generated textures ≤ 512² unless you justify it.
3. **WebGL2 target.** Assume WebGL2 (`renderer.capabilities.isWebGL2`), but
   degrade gracefully — never throw, never render black, if a feature (e.g.
   float linear filtering) is missing.
4. **Performance budget.** 60 fps at 1280×720 on integrated graphics with a full
   city (~700 building meshes, 600 precipitation instances). Your module must
   expose a quality level and honour it (§6). Never allocate per-frame: reuse
   scratch `Vector3`/`Matrix4`/`Color`.
5. **Art direction: elevate, don't grim-ify.** This is a bright, kid-friendly
   voxel city. Cities: Skylines quality means *tilt-shift miniature realism,
   rich materials, atmospheric light, dense detail* — NOT desaturated grey
   realism. Colours must stay saturated and cheerful; contrast, depth, and
   material response are what get upgraded. A washed-out or muddy result is a
   failure even if it is "more realistic".
6. **Never break the game.** The existing public `Engine` API (see §2) must keep
   working byte-identically from `main.js`'s point of view.

---

## 1. World facts you can rely on

| Fact | Value |
|---|---|
| `TILE` (world units per tile) | `8` |
| `N` (tiles per map side) | `80` |
| `MAP_W` (world size) | `640` |
| Map spans world XZ | `0 .. 640` |
| Map centre | `(320, 0, 320)` |
| Ground top Y | `0` (grass/sand/road), `-2.6` (water, recessed basin — water.js round 11), `0..16` (mountain columns) |
| Voxel size | 1 world unit; buildings are bottom-anchored at y=0 |
| Camera | **True-isometric `OrthographicCamera`** (elevation 35.264°, azimuth π/4 + k·π/2, 90° snap rotation). Zoom = `camDist`-equivalent 36..~920 (ortho half-height = camDist·tan 20°); the camera sits camDist from the target along the view axis; near = −700 (negative!), far = 3200 |
| Up axis | `+Y` |

Tile types (`state.map[z*N+x]`): `0 GRASS, 1 WATER, 2 SAND, 3 ROAD, 8 TREE,
15 MOUNTAIN` (mountain voxel height in `state.variant[i]`, 2..16). `state.bridge[i]===1`
means "map says ROAD but render as water; a deck prop is drawn on top".

Colour space: the renderer is `SRGBColorSpace` output. All palette hexes in
`src/models.js` are **sRGB**; convert with `color.setHex(hex, THREE.SRGBColorSpace)`
so you get linear working values. Palette indices `200..203` are emissive window /
lamp / neon colours.

---

## 2. Engine integration surface (owned by `src/engine.js` — do not edit it)

`engine.js` is the integration owner and the ONLY file that imports `src/render/*`.
Your module is handed what it needs through its constructor and an `update()`
call. Assume `engine.js` will call, in this order, every frame:

```js
sky.update(dt, ctx);        // may move the sun; returns lighting suggestion
water.update(dt, ctx);
terrain/roads: (static, rebuilt on demand)
post.render(dt, ctx);       // replaces renderer.render(scene, camera)
```

`ctx` (a plain object, reused — never retain it) is:

```js
{
  time,        // seconds since boot
  dt,          // clamped frame delta
  nightT,      // 0 = noon .. 1 = midnight (raw request)
  nightEff,    // 0..1 after the "Always bright" lock
  weather: { rain, snow, tint:[r,g,b] },
  camera,      // THREE.OrthographicCamera, true iso (already positioned this frame).
               // Depth is LINEAR (viewZ = near + d*(far-near)) and near is NEGATIVE;
               // rays are parallel — never assume camera.fov. Branch on
               // camera.isOrthographicCamera where it matters (SSAO/DOF/CSM do).
  camDist,     // zoom as a perspective-equivalent orbit distance, 36..~920. It is also
               // the exact view depth of the camera target, so DOF focus = camDist.
  sunDir,      // THREE.Vector3, normalized, pointing FROM the scene TOWARD the sun
  quality,     // 0 = low, 1 = medium, 2 = high (see §6)
}
```

If your module needs something not on `ctx`, say so in your report — do not reach
into `engine` internals or globals.

---

## 3. Module roster and interfaces

Each module default-exports nothing; it exports one named class/factory. Every
class implements `dispose()`. Sizes come through `setSize(w, h, pixelRatio)`.

### 3.1 `src/render/post.js` → `export class PostFX`

The full post-processing stack, hand-rolled (no EffectComposer).

```js
new PostFX(renderer, scene, camera, opts)
postfx.setSize(w, h, pixelRatio)
postfx.setQuality(level)          // 0|1|2
postfx.setParams({...})           // see below; partial updates
postfx.render(dt, ctx)            // draws to the canvas. Replaces renderer.render()
postfx.dispose()
```

Required effects, in this order:

1. **Scene pass** into an HDR-ish float/half-float render target (+ depth texture,
   + a normal buffer if your AO needs one — MRT via WebGL2 is fine).
2. **SSAO** — screen-space ambient occlusion from depth (+normals). This is the
   single biggest quality win on blocky geometry: every street canyon, every
   building base, every window recess should darken. Must not halo on the sky.
3. **Bloom** — energy-conserving, threshold + multi-mip blur. Night windows,
   neon, sun glint on water bloom; daytime stays clean.
4. **Tilt-shift depth of field** — the Cities: Skylines signature. Blur strength
   ramps with distance from a focus plane derived from `ctx.camDist` (miniature
   look: strong at close orbit, subtle when zoomed out). Bokeh, not a box blur.
5. **Tone mapping + colour grade** — ACES-style filmic (or AgX) tonemap, then a
   grade: lift/gamma/gain, saturation boost, subtle warm highlights / cool
   shadows split-tone, and a **vignette**. Must land bright and saturated (§0.5).
6. **Anti-aliasing** — SMAA (preferred) or a high-quality FXAA 3.11. The current
   build has `antialias:false` and the jaggies on voxel edges are the loudest
   "cheap web game" tell. This must be visibly, completely solved.
7. Optional final **sharpen** (CAS-style) to recover micro-detail after AA/DOF.

`setParams` keys (all optional, sensible defaults): `ssao{intensity,radius,bias}`,
`bloom{threshold,strength,radius}`, `dof{focus,range,strength,maxBlur}`,
`grade{exposure,saturation,contrast,lift,gain,vignette}`, `aa{enabled}`.

Notes: you own the render targets. Handle `pixelRatio` changes and window
resize without leaking GPU memory. Everything must work with the existing
`onBeforeCompile` shader injections on the scene materials — do not require
material changes.

### 3.2 `src/render/sky.js` → `export class Sky`

```js
new Sky(scene, opts)
sky.update(dt, ctx)   // returns { sunDir, sunColor, skyColor, groundColor, intensity }
sky.setWeather({ rain, snow, overcast })
sky.getEnvironment(renderer)  // THREE.Texture (PMREM cube) for scene.environment / IBL
sky.dispose()
```

Deliver:
- A **sky dome** with real atmospheric scattering (Preetham or Hosek-style
  analytic model is fine, written by you) — horizon gradient, sun disc with
  correct limb, Mie glow around the sun, blue Rayleigh zenith.
- **Sunrise / sunset** that actually looks like sunrise/sunset (warm horizon
  band, purple opposite the sun) driven by `ctx.nightT`.
- **Night** — deep blue, star field (procedural, twinkling, correctly not
  visible at day), moon disc.
- **Clouds** — a drifting volumetric-ish cloud layer (raymarched or layered
  noise billboards). Kid-friendly puffy cumulus, not thin cirrus wisps. They must
  cast a sense of scale and move slowly. Overcast under rain.
- **PMREM environment map** regenerated at a low cadence (e.g. every ~2 s of
  in-game time, or when `nightT` changes by >0.02) so buildings get real IBL
  without a per-frame cost.
- Replaces `scene.background`; must play nicely with `scene.fog` (the sky dome
  itself must be fog-exempt).

### 3.3 `src/render/water.js` → `export class WaterFX`

```js
new WaterFX(scene, opts)
water.buildSurface(state)      // (re)build the water surface mesh(es) from the tile map
water.refreshTiles(state, x, z)
water.update(dt, ctx)
water.dispose()
```

Deliver a water surface at `y = -2.6` (was -0.35, then -1.85; lowered so the pool walls read) covering every WATER/bridge tile with:
- **Depth-based colour** — shallow turquoise near shores → deep blue offshore,
  computed from distance to the nearest land tile (bake into a vertex attribute
  or a generated data texture; do NOT do a depth-buffer read that breaks with
  the post stack).
- **Fresnel reflection** of the sky colour + env map at grazing angles.
- **Animated normal detail** — two or three scrolling procedural normal layers
  at different scales, so it reads as moving water, not a wobbling plane.
- **Specular sun glint** — a sharp, bloom-feeding highlight that tracks
  `ctx.sunDir`.
- **Shoreline foam** — a soft animated white band where water meets land/sand.
- **Rain response** — ripple rings when `ctx.weather.rain > 0`.
- Must stay bright and inviting (kid game), not black-ocean realistic.

Coordinate with `terrain.js`: the terrain module stops emitting the flat blue
water quads; `WaterFX` owns everything at the water surface.

### 3.4 `src/render/terrain.js` → `export class Terrain`

Takes over ground chunk meshing from `engine._buildChunk`.

```js
new Terrain(scene, opts)
terrain.build(state)                 // full rebuild, all chunks
terrain.refreshTile(state, x, z)     // rebuild the one chunk containing (x,z)
terrain.setWeather({ tint, snow })
terrain.update(dt, ctx)
terrain.dispose()
```

Deliver:
- **No more hard checkerboard.** Grass gets multi-octave procedural variation
  (colour + a detail normal) that reads as turf at close orbit and as soft
  colour variety at distance, with a distance-based fade so it never aliases.
- **Blended transitions** between grass / sand / road / water edges instead of
  hard tile seams — a per-vertex blend weight computed from tile neighbours.
- **Baked vertex ambient occlusion** — darken ground vertices adjacent to
  buildings/mountains/water steps; darken mountain crevices. Cheap and huge.
- **Mountains**: proper rock — strata banding, a rock normal detail, snow that
  accumulates on up-facing slopes only, scree at the base. Currently 3 flat
  colour bands.
- **Beaches**: wet-sand darkening band adjacent to water.
- Keep the chunked structure (`CHUNK = 16`, 5×5 chunks) and the
  `refreshTile → rebuild one chunk` contract — placement latency matters.

### 3.5 `src/render/roads.js` → `export class Roads`

Roads are ~40 % of the pixels in a city screenshot and are currently flat dark
quads with a yellow dashed line. This module owns everything road.

```js
new Roads(scene, opts)
roads.build(state)                  // full rebuild from the tile map
roads.refreshTile(state, x, z)
roads.update(dt, ctx)
roads.dispose()
```

Deliver, per Cities: Skylines:
- **Asphalt** with procedural grain, patchy tonal variation, subtle wetness under
  rain (raise specular + darken).
- **Correct markings by connectivity** — a road tile knows its 4 neighbours.
  Straights get a dashed centre line; intersections get **no** centre line but do
  get **crosswalk zebra stripes** on each approach and stop bars; dead ends get a
  turnaround. Curves get properly curved markings, not L-shaped stubs.
- **Sidewalks with a raised curb** on both sides of every road, mitred correctly
  at corners and interrupted at driveways/crosswalks. Concrete tone, slight
  height (≈0.15 world units) so it catches shadow and AO.
- **Street furniture** hooks: return, from `build()`, a list of
  `{ x, z, yaw, kind }` anchors for street lamps / signs / hydrants so a later
  pass can place props. Do not place the props yourself.
- Roads must sit flush with terrain (no z-fighting) and read cleanly from the
  farthest zoom.

### 3.6 `src/render/voxel.js` → `export function buildVoxelGeometry(model, opts)`

Extracted and upgraded from `engine._buildVoxelGeometry`. Same input
(`{sx,sy,sz,blocks:[[x,y,z,ci]]}`), same output contract (a `BufferGeometry`
with `position`, `normal`, `color`, `glowColor`, `emissiveT`), plus:

- **Per-vertex ambient occlusion** — the classic voxel 4-neighbour AO term per
  face corner, written to a new `float aoT` attribute. This alone makes voxel
  geometry look modelled instead of stickered.
- **Micro-bevel option** — inset face edges very slightly (≈0.03) and add a
  darker rim, so adjacent same-colour voxels still read as separate blocks.
- **Roughness / metalness per palette index** — export a
  `materialFor(colorIndex) -> { roughness, metalness }` table so metal reads
  metallic, glass reads glossy, brick/wood read rough. Written to `matParams`
  (vec2) vertex attributes.
- Must stay fast: a 4×4×34 stadium model is ~500 voxels and is meshed once,
  cached by model reference. Keep it under a few ms.

`opts`: `{ ao: true, bevel: true, palette, glowPalette }`. Pure function, no
three.js scene access beyond `BufferGeometry`.

**Finer resolution + greedy meshing (v4).** A model may declare `res`
(voxels per world unit; default 1, integer ≤ 8 for buildings; ≤ 20 is
honoured for small dynamics such as vehicles and people). `sx/sy/sz` and block coords
are then in fine voxels and the geometry is emitted in WORLD units (÷ res), so
the engine places any res identically; only `makeSpinner` reads `model.sy`
(pivot = sy / (2·res)). Models with `res > 1` (or `opts.greedy: true`, or
`opts.aoReach > 1`) take a slice mesher: greedy merging of coplanar
same-colour faces with identical AO corners (merged only along axes the AO is
constant on, so shading is unchanged), no micro-bevel, AO sampled over a
(2R)² window with R = `opts.aoReach` (auto = res → ~1 world unit ramp), and a
`vec4 voxLat` attribute (res, lattice origin) that `materials.js` uses to keep
its per-cell lattice at 1 world unit. `greedy` auto = on for res > 1, off for
res 1, so every res-1 model is byte-identical to the legacy path.
`setVoxelDefaults(patch)` patches module defaults (e.g. `{greedy:true}` for
measurement); `modelRes(model)` returns the effective res.

**Perf additions (2026-09-25, tools/rendertest/pieces/perf.md).** Slice-mesher
geometry carries `userData.viewIndex` (same vertices/quad order, minus -Y faces
and faces into sealed interiors — nothing the iso camera can see); meshes drawn
with it name the full geometry in `userData.casterGeometry`, which lighting.js
renders in its depth / world-AO passes. `opts.aoAtlas: true` merges faces by
colour only and emits `aoAtlas` UVs + `userData.aoRegions` (R8 AO lattice
regions) instead of `aoQuad`/`aoUV`; materials.js `AoAtlas.place(geo)` packs
them into one shared texture (the voxel material reads it when `aoAtlas.x > 0`).
`lodModel(model, res)` resamples a model to a coarser integer res for distance
LOD (engine.js `_updateLod`, quality-tiered).

### 3.7 `src/render/materials.js` → `export class MaterialLib`

```js
new MaterialLib(renderer, opts)
lib.setPalette(paletteArray)
lib.voxel        // THREE.Material for buildings/props
lib.ghost        // translucent placement preview
lib.setEnvironment(envTexture)
lib.update(dt, ctx)
lib.dispose()
```

Replace `MeshLambertMaterial` with a **physically based** material
(`MeshStandardMaterial` + `onBeforeCompile`, or a custom `ShaderMaterial`) that
consumes the new `aoT` and `matParams` attributes from §3.6, does IBL from
`sky.getEnvironment()`, keeps the existing night-glow behaviour
(`uNight` × `emissiveT` → `glowColor`), and adds:
- window glass with a real specular lobe + env reflection,
- neon that genuinely feeds the bloom pass,
- a subtle rim/fill so silhouettes separate against the sky.

The `uNight`, `uSeason` uniform objects are owned by `engine.js` and passed in
via `opts.uniforms` — share, don't clone.

---

## 4. Self-test requirement

Every module ships a `selfTest()` export that runs headless-ish assertions
(geometry attribute counts, no NaNs, shader compiles, no leaked targets over
100 resize cycles) and returns `{ pass: boolean, notes: string[] }`. Wire nothing
into the game; `engine.js` will call these under a debug flag.

## 5. Definition of done (you WILL be graded against this)

A hostile reviewer will put your output side by side with real Cities: Skylines
screenshots, blind, and pick which looks better. "Good for a web game" is a
fail. Specifically they will look for:

- No aliasing on any edge, at any zoom.
- Real contact darkening where anything meets the ground.
- Materials that respond to light differently from each other.
- Atmosphere: depth haze, light that has a colour and a direction.
- Sharp foreground, soft distance (miniature/tilt-shift read).
- Nothing flat, nothing plastic, nothing that reads as "untextured".

## 6. Quality levels

`ctx.quality`: `0` low (no SSAO, no DOF, FXAA, half-res bloom), `1` medium
(SSAO half-res, DOF, SMAA), `2` high (everything full res). Engine picks the
level from a frame-time probe. Your module must switch levels **without**
reallocating the world, and must never stutter on a switch.

Engine (2026-09-25): the starting level comes from the device (`_deviceQuality`:
Chromebooks / Intel / Mali / phones / iPads 0–1, Apple-silicon Macs and discrete
GPUs 2), then a governor steps down a ladder (2+SSAA → 2 → 1 → 0) on sustained
< 50 fps and probes back up once after 30 s. `engine.setAutoQuality(false)`
pins the level (the render-test bootstrap does, at 2).

---

## §3.8 `src/render/lighting.js` → `export class LightingRig`

The sun/moon rig, ambient/IBL, **cascaded shadow maps (CSM)** with PCSS-style
contact-hardening soft shadows, and the batched night light-pool system.

This module owns **all** shadowing. `engine.js` must stop using
`renderer.shadowMap` for the sun (`engine.sun.castShadow = false`, or remove
`engine.sun`/`engine.hemi`/`engine.ambient` entirely and let the rig supply
them — the rig adds its own `DirectionalLight` + `HemisphereLight` +
`AmbientLight` to the scene in its constructor).

### 3.8.1 API

```js
import { LightingRig, csmPatchShader, selfTest,
         CSM_FRAGMENT_PARS, CSM_VERTEX_PARS, CSM_VERTEX_MAIN,
         csmLightsFragmentBegin } from './render/lighting.js';

const rig = new LightingRig(renderer, scene, camera, opts);

// --- per frame (after the camera is positioned, BEFORE post.render) --------
const info = rig.update(dt, ctx);
//   -> { sunDir, sunColor, skyColor, groundColor, intensity,
//        isMoon, elevation /* radians */, envIntensity }

// --- configuration ---------------------------------------------------------
rig.setQuality(0|1|2)            // §6. Cascade count changes recompile once.
rig.getQuality()
rig.setCascadeCount(1..4)        // explicit override; null/absent = follow quality
rig.setPcfTaps(1..16)            // no shader recompile
rig.setParams({ ... })           // partial; see 3.8.4
rig.setDebugCascades(bool)       // false-colour cascade split view
rig.setSize(w, h, pixelRatio)
rig.markDirty()                  // geometry changed: force a full cascade re-render

// --- sun ownership ---------------------------------------------------------
rig.setSunSource('internal' | 'external')   // who drives the sun direction
rig.setSunDirection(vec3)                   // for 'external' (sky.js drives it)
rig.getSunDirection()                       // THREE.Vector3, do NOT mutate

// --- IBL -------------------------------------------------------------------
rig.setEnvironment(tex)          // sets scene.environment; opts.envIntensity is
                                 // the value materials.js should use for envMapIntensity

// --- night lighting (cheap, batched) ---------------------------------------
rig.setLampAnchors([{ x, z, y?, radius?, intensity?, color?, bulbY?, glowRadius? }, ...])
rig.setWindowGlows([{ x, y, z, radius?, intensity?, color? }, ...])

// --- material integration --------------------------------------------------
rig.getShaderUniforms()          // the SHARED uniform bag (see 3.8.3)
rig.patchMaterial(material)      // convenience: chains onBeforeCompile for you

rig.dispose()
rig.selfTest()                   // == selfTest(renderer, rig); restores rig state
```

`update()` is the only method that touches the GPU. It saves and restores
`renderer`'s render target, clear colour/alpha, `autoClear`, `shadowMap.enabled`,
`scene.background` and `scene.overrideMaterial`, so it is safe to call from
anywhere in the frame before `post.render()`.

### 3.8.2 Sun direction ownership (agreement with `sky.js`)

Constructor option `sunSource`:

- `'internal'` (default) — the rig computes the sun/moon direction from
  `ctx.nightT`/`ctx.nightEff` (and `ctx.dayPhase` if `engine.js` ever supplies a
  0..1 clock) and publishes it as `rig.sunDir` / `update()`'s return value.
  `sky.js` should read that and draw its sun disc there.
- `'external'` — the rig uses `setSunDirection(v)`, falling back to
  `ctx.sunDir`. `sky.js` becomes the authority.

Below the horizon the rig automatically flips to a **moon** key light (same arc,
opposite hemisphere, cool colour, reduced shadow strength) — `info.isMoon` says
which is active. `info.elevation` is signed, in radians, for the *visible*
body.

### 3.8.3 What a material must splice in (for `materials.js`)

The easiest path is `rig.patchMaterial(mat)`. If `materials.js` needs to own
`onBeforeCompile` itself, call `csmPatchShader(shader, rig.getShaderUniforms())`
at the end of its own handler. It performs exactly three edits:

1. **Uniforms** — copies the shared bag into `shader.uniforms`. Share the
   objects; do not clone. The bag is:

   | uniform | type | meaning |
   |---|---|---|
   | `uCsmAtlas` | `sampler2D` | 2×2 tiled shadow atlas (RGB 24-bit packed depth) |
   | `uCsmAtlasTexel` | `vec2` | `1/atlasWidth, 1/atlasHeight` |
   | `uCsmCount` | `float` | active cascade count; `0` disables the lookup |
   | `uCsmTaps` | `vec4` | `(pcfTaps, searchTaps, rotate01, indirectOcclusion)` |
   | `uCsmSplits[4]` | `vec4` | `(fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd)` in view Z |
   | `uCsmMatrix[4]` | `mat4` | origin-relative world → cascade `[0,1]³` |
   | `uCsmParams[4]` | `vec4` | `(texelWorld, depthRange, normalOffsetWorld, depthBiasWorld)` |
   | `uCsmRect[4]` | `vec4` | atlas sub-rect `(offsetU, offsetV, scaleU, scaleV)` |
   | `uCsmSoft` | `vec4` | `(minPenumbra, blockerSearchWorld, softness, maxPenumbra)` |
   | `uCsmMisc` | `vec4` | `(shadowStrength, debug, distFadeStart, distFadeEnd)` |
   | `uCsmOrigin` | `vec3` | world origin the position varying is relative to |

2. **Vertex shader** — prepend `CSM_VERTEX_PARS` and insert `CSM_VERTEX_MAIN`
   immediately **after** `#include <project_vertex>`. This declares and fills:

   ```glsl
   uniform vec3 uCsmOrigin;
   varying highp vec3  vCsmWorldPos;   // world position MINUS uCsmOrigin
   varying highp float vCsmViewZ;      // -mvPosition.z
   ```

   `vCsmWorldPos` is deliberately origin-relative and `highp`: absolute
   0..640 world coordinates lose enough precision in the interpolator on some
   drivers to produce multi-texel shadow error.

3. **Fragment shader** — prepend `CSM_FRAGMENT_PARS` (self-contained, no chunk
   dependencies) and replace `#include <lights_fragment_begin>` with
   `csmLightsFragmentBegin()`. That helper takes
   `THREE.ShaderChunk.lights_fragment_begin` **verbatim at runtime** and adds
   exactly two lines:

   ```glsl
   // (a) after getDirectionalLightInfo, for directional light 0 only:
   #if ( UNROLLED_LOOP_INDEX == 0 )
   directLight.color = csmApply( directLight.color, geometryNormal, directLight.direction );
   #endif

   // (b) just before the RE_IndirectSpecular block:
   #if defined( RE_IndirectDiffuse )
   irradiance *= csmIndirectScale();
   #endif
   ```

   Public GLSL entry points: `csmApply(vec3 lightColor, vec3 viewNormal,
   vec3 viewLightDir) -> vec3` and `csmIndirectScale() -> float`. Everything
   else in the block is `csm`-prefixed and will not collide.

**Constraints for materials.js**

- The rig's sun **must be directional light index 0** (it is, if the rig is
  constructed before any other `DirectionalLight` is added to the scene).
- The rig does **not** use `THREE.WebGLShadowMap`, so `receiveShadow` on a mesh
  is irrelevant — a patched material always receives CSM. `castShadow = true`
  is still what decides whether a mesh is rendered into the cascade passes.
- Casters render their **back faces** (`opts.casterSide`). Any caster you add
  must be a closed shell. Open/single-sided casters need
  `casterSide: THREE.FrontSide` plus `normalOffsetTexels ≈ 3.0`,
  `depthBiasTexels ≈ 1.5`.
- The rig sets `renderer.shadowMap.type = THREE.BasicShadowMap` and leaves
  `renderer.shadowMap.enabled` alone.

### 3.8.4 `setParams` keys

`shadowStrength` (0..1, direct-light shadow depth), `shadowAmbient` (0..1, how
much of the hemi/ambient fill the shadow also removes), `softness` (penumbra
world units per world unit of caster gap), `minPenumbra`, `maxPenumbra`,
`blockerSearchWorld`, `normalOffsetTexels`, `depthBiasTexels`, `splitLambda`,
`maxCasterHeight`, `minShadowDistance`, `maxShadowDistance`, `shadowDistance`
(hard override), `farCascadeInterval`, `exposure` (scales sun + fill),
`fillBoost` (scales fill only — raise for softer, more colourful shadows),
`maxSunElevation`, `horizonEase`, `azimuthBase`, `azimuthSweep`,
`minShadowElevation`, `moonShadows`, `lampColor`, `lampRadius`,
`lampIntensity`, `envIntensity`.

### 3.8.5 Quality levels (§6)

| level | cascades | PCF taps | blocker taps | tile | atlas | disk rotation |
|---|---|---|---|---|---|---|
| 0 | 1 | 4 | 4 | 1024 | 1024² | off |
| 1 | 2 | 9 | 6 | 1024 | 2048² | on |
| 2 | 3 | 16 | 8 | 1024 | 2048² | on |

Tap counts are uniforms (Vogel disk, valid for any count) so `setPcfTaps()`
never recompiles a shader. Changing the **cascade count** changes
`uCsmCount` only — also no recompile — but does reallocate the atlas between
levels 0 and 1.

### 3.8.6 Night light pools

`setLampAnchors()` builds two `InstancedMesh`es and nothing else:

- an additive ground decal disc per lamp (analytic radial falloff, `depthTest`
  on so buildings occlude it, `depthWrite` off),
- a camera-facing additive bulb/window-spill billboard.

**Two draw calls total, for any number of lamps.** No `PointLight` is ever
created. Both fade in with `smoothstep(0.42, 0.68, nightT)` and are hidden at
day. Verified at 400 anchors in `selfTest()`.

### 3.8.7 Self-test

`selfTest(renderer?, rig?)` → `{ pass, notes }`. Without a renderer it runs the
pure-math assertions only. With a renderer it also verifies texel-snapping
stability through a full 360° orbit and that 100 quality/resize cycles leak no
render targets. Passing an existing rig leaves that rig's quality, cascade
count and lamp anchors unchanged.

### 3.8.8 Test harness

`tools/rendertest/lighting.html` — stand-in voxel city over the real 640×640
world, orbit camera 30..380, sliders for time of day / quality / cascade count /
PCF taps / softness / zoom / orbit, a false-colour cascade-split toggle, a
`selfTest` button, and a **"legacy bug repro"** toggle that reconfigures the
rig's sun with `engine.js`'s exact shadow settings so the original
invisible-shadow bug can be reproduced and A/B'd on demand.
