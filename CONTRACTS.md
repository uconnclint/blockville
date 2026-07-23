# BLOCKVILLE — Architecture Contract (READ FULLY BEFORE CODING)

A kid-friendly voxel city-builder ("Cities Skylines for elementary schoolers").
Target: Chromebooks + iPads. Chrome/Safari, mouse AND touch. 60fps on weak hardware.
Plain ES modules, NO build step, NO TypeScript, NO external deps except `./vendor/three.module.js` (r160).

## Hard rules
- Each module ONLY imports: `../vendor/three.module.js` (engine/life only), `./constants.js`, and `./models.js` (life only). No cross-imports between sim/ui/engine/life/audio — `main.js` wires everything.
- Every module file is self-contained and syntactically valid ES module. Export EXACTLY the API below.
- No `fetch()`, no external URLs, no images — all art is voxels + CSS + inline SVG/emoji.
- Performance: merged BufferGeometry per chunk, InstancedMesh for repeated props. Never one Mesh per voxel. Target < 300 draw calls.
- Kid-friendly: bright saturated colors, chunky shapes, no death/crime/disasters, gentle failure (can't go below -200 coins; a "piggy bank" gives +500 when broke, once per day).

## Coordinate system
- Map: `N = 48` tiles per side. Tile (x,z), 0..47. One tile = one building cell.
- World: 1 tile = `TILE = 8` world units. Tile (x,z) spans world X:[x*8,(x+1)*8], Z:[z*8,(z+1)*8]. Ground top at y=0. Voxels are 1×1×1 world units.
- Voxel models: `{sx, sy, sz, blocks: [[vx,vy,vz,colorIndex], ...]}` — vx∈[0,sx), vy∈[0,sy) up, vz∈[0,sz). colorIndex into `PALETTE` from models.js. Models are placed centered on their tile(s), sitting on y=0.

## constants.js (provided, import from './constants.js')
See file — TILE, N, tile type enums T = {GRASS,WATER,SAND,ROAD,ZONE_R,ZONE_C,ZONE_I,BLDG,TREE,PARK,SCHOOL,FIRE,FOUNTAIN,STADIUM,POWER}, TOOLS, COSTS, SPEEDS, EVENTS names.

## State shape (owned by sim.js, read-only to others)
```js
state = {
  map: Uint8Array(N*N),        // tile type T.*, index = z*N + x
  zoneOf: Uint8Array(N*N),     // for T.BLDG tiles: original zone T.ZONE_R/C/I; else 0
  level: Uint8Array(N*N),      // building level 1..3 (0 = none/under construction)
  variant: Uint8Array(N*N),    // visual variant 0..255 (random at construction)
  progress: Float32Array(N*N), // construction progress 0..1 for zones growing
  money: 1500, pop: 0, jobs: 0, happiness: 0.8,
  day: 1, clock: 0.3,          // clock 0..1 (0.5 = noon), full day = 120s at speed 1
  speed: 1,                    // 0 paused, 1, 3
  unlocked: ['road','home','shop','tree','bulldoze','park'], // tool ids
}
```

## Module APIs

### engine.js — `export class Engine`
```js
constructor(canvas)                    // sets up renderer, scene, lights, sky, fog, camera
attachInput(domElement)                // orbit/pan/pinch: 1-finger drag or left-drag = pan, 2-finger pinch/wheel = zoom, 2-finger twist or right-drag = rotate. Clamp: zoom 30..260 dist, polar 0.35..1.2 rad. Camera starts isometric-ish looking at map center.
buildGround(state)                     // full terrain rebuild from state.map (grass/water/sand/road tiles as voxel ground w/ road markings; water animated shader or vertex wiggle ok)
refreshTile(state, x, z)               // cheap partial update after a tile changes (may rebuild the 16x16-tile chunk containing it)
addBuilding(id, model, x, z, yScale=1) // place voxel model centered on tile (x,z); yScale for construction pop-up anim; returns nothing; id is unique int
updateBuildingScale(id, yScale)        // used for grow-in animation
removeBuilding(id)
addProp(kind, model, x, z)             // like addBuilding but keyed (kind,x,z) — for trees etc. removeProp(kind,x,z)
removeProp(kind, x, z)
makeDynamic(model) -> handle           // small movable object (car/person/bird/cloud). handle = {setPos(x,y,z), setRot(yRad), setVisible(b), dispose()}. Use per-model-shared geometry + one Mesh each (few hundred total OK), or InstancedMesh pools.
screenToTile(clientX, clientY) -> {x,z}|null
setGhost(model|null, x, z, ok)         // translucent preview at tile, green tint if ok else red
setNight(t)                            // t 0..1 (0 day, 1 night): sky color, sun/ambient dim, fog color. Also expose scene, and window lights handled via emissive palette trick: models use colorIndex >= 200 as "window" colors — engine renders those as emissive at night.
render(dt)                             // per-frame; animate water, do camera damping
resize()
```

### models.js — voxel art catalog (NO three.js import; pure data)
```js
export const PALETTE = [...]           // ~64 hex ints 0xRRGGBB. Indices 200+ reserved: 200=warm window, 201=cool window, 202=streetlight glow, 203=neon (engine makes these emissive at night; by day they render as light yellow/blue glass).
export function buildingModel(zone, level, variant) // zone: 'R'|'C'|'I', level 1..3, variant int → model. MUST provide ≥4 distinct looks per (zone,level) via variant, with charming details: doors, windows(use 200/201), roofs, chimneys, AC units, signs, awnings. R: houses→townhouses→small apartments. C: kiosk/shop→store w/ awning→little tower w/ neon(203). I: workshop→factory w/ chimney→big factory. Footprint ≤ 7×7 voxels (leave 1 border), heights: L1 ≤8, L2 ≤14, L3 ≤22.
export function serviceModel(kind, variant)         // 'park'(trees+pond+bench), 'school'(flag!), 'fire'(red+garage), 'fountain', 'stadium'(9 tiles? NO — single tile, chunky), 'power'(wind turbine, rotor separate? no—static ok)
export function treeModel(variant)                  // ≥5 variants incl. round, pine, blossom
export function roadModel(mask)                     // mask bit 1=N,2=E,4=S,8=W neighbors are road → 16 flat models 8×1×8: dark asphalt, dashed yellow center lines along connections, corner sidewalk pixels, crosswalks at 4-ways
export function carModel(variant)                   // ≥6 cute cars/bus/taxi/icecream truck, ≤6×4×3, facing +X? NO: facing -Z (forward = -Z)
export function personModel(variant)                // ≥8 tiny people 2×4×1ish, varied shirt/hair/skin tones
export function birdModel(), cloudModel(variant), smokePuffModel()
export function constructionModel()                 // crane/scaffold shown while progress < 1
```

### sim.js — `export class Sim`
```js
constructor()                          // fresh state: island terrain — grass, a river or lake, sand edges, ~40 random trees. Deterministic-ish from random seed. Starter road optional.
state                                  // the shape above
applyTool(toolId, x, z) -> {ok, reason?, spent?}   // toolId ∈ TOOLS keys: road,home,shop,factory,park,school,fire,fountain,stadium,power,tree,bulldoze. Validates: in bounds, terrain buildable (grass only; road also on sand), cost affordable, zones must touch road? NO—zones can be painted anywhere but only GROW when within 2 tiles of a road. Deduct cost, mutate map, push events.
tick(dt) -> events[]                   // dt sim-seconds (already speed-scaled by caller). Advances clock/day. Zone growth: painted zone tiles near roads accrue progress (faster w/ happiness); at 1.0 → becomes BLDG level 1 (event 'built'). Buildings level up over time if happiness>0.7 and demand (event 'upgraded', max 3). Economy every game-hour: income = pop*2 + jobs*3, upkeep = roads*0.2 + services*2. Pop = sum homes capacity (L1=4,L2=10,L3=24), jobs likewise for C/I. Happiness = f(parks/schools coverage, tree count, factory adjacency penalty to homes, jobs/pop balance). Milestones at pop 25/75/150/300/500 → unlock tools (factory@25, school@75, fire@75, fountain@150, power@150, stadium@300) → event 'milestone'. Piggy bank event when money< -100.
events()                               // drained queue: {type:'built'|'upgraded'|'milestone'|'piggy'|'toolUnlocked', x?, z?, ...}
roadGraph() -> {isRoad(x,z), neighbors(x,z)->[{x,z}]}  // for life.js
coverage helpers: happinessAt(x,z) 0..1 (for happy/sad face overlay maybe)
save() -> string ; load(str) -> bool ; (JSON, arrays as base64 or plain arrays ok)
```

### life.js — `export class Life`
```js
constructor(engine, modelsRef)          // modelsRef = the models module namespace
sync(state, roadGraph)                  // called after map changes: prune cars/peds on removed roads
update(dt, state, roadGraph)            // real-time dt * speed already applied. Maintain: cars ≈ min(2+pop/10, 40) driving tile-to-tile along roads, right-hand offset, smooth turns, varied speeds; peds ≈ min(pop/4, 60) wandering on sidewalk edges of roads & in parks; 3-6 birds flying loops; 6-10 clouds drifting; smoke puffs rising from factory chimneys (spawn/expire); at night reduce peds 80%, cars 50%.
setDensityScale(f)                      // perf knob
```
Cars/peds/etc use `engine.makeDynamic(model)`. Keep pooling; dispose when shrinking.

### ui.js — `export function initUI(hooks)` + updates
```js
initUI({onTool(toolId), onSpeed(0|1|3), onNew(), onHelp?}) -> ui
ui.setStats({money,pop,happiness,day,clockLabel})   // animated counters
ui.setUnlocked(toolIds[]) ; ui.setActiveTool(toolId)
ui.toast(text, emoji?) ; ui.celebrate(title, subtitle) // confetti burst for milestones (CSS/JS particles, no libs)
ui.showWelcome()                                     // first-run friendly 3-step how-to, big "Let's build!" button
```
Style: ui.js injects its own `<style>`. Big rounded touch targets (min 56px), tool buttons = emoji + tiny label (🛣️ Road, 🏠 Homes, 🏪 Shops, 🏭 Factory, 🌳 Tree, 🌸 Park, 🏫 School, 🚒 Fire, ⛲ Fountain, 🏟️ Stadium, 🌬️ Power, 🧹 Erase). Toolbar bottom, stats top (💰 🙂 👥 📅). Locked tools show 🔒 + needed pop. Bright playful font (system rounded stack). Active tool = bounce/glow. Cost badge on buttons. Must not block map drags outside its own elements.

### audio.js
```js
export function initAudio()             // lazy AudioContext on first user gesture
export function play(name)              // 'place','road','bulldoze','built','upgrade','milestone','coin','error','click','piggy'  — cheerful synthesized WebAudio blips/arps, SHORT, quiet (master gain .25)
export function setAmbience(nightT, pop)// ensures the background music playlist is running (nightT/pop kept for call-site compatibility, unused). Must survive not being supported (try/catch).
export function toggleMute() -> muted
```

### main.js (integration owner — do not write, provided later)
Wires: input → tool apply → engine refresh; sim.tick at speed; sim events → ui/audio/engine (construction models while progress<1, building add on 'built', scale-pop animation); life.update; day/night from state.clock (night = clock<0.25||>0.75 smoothstep); autosave localStorage 'blockville-save' every 10s; ghost preview on pointer move.

## Acceptance bar per module
Runs with zero console errors, no unhandled promise rejections, works with only its documented API touched. Code is plain, commented lightly, and defensive (bad args → no crash).
