// Blockville rendering engine.
// Owns the Three.js scene, camera, lights, sky/fog, voxel meshing, ground chunks,
// dynamic objects, ghost preview and day/night. Pure ES module.
// Only dependency: vendored three.js (r160) + shared constants.

import * as THREE from '../vendor/three.module.js';
import { TILE, N, CHUNK } from './constants.js';
import { buildVoxelGeometry, modelRes, materialFor, lodModel } from './render/voxel.js';
import { MaterialLib } from './render/materials.js';
import { PostFX } from './render/post.js';
import { Sky } from './render/sky.js';
import { Terrain, LOT_Y } from './render/terrain.js';
import { Roads } from './render/roads.js';
import { WaterFX } from './render/water.js';
import { LightingRig } from './render/lighting.js';
import * as LightingNS from './render/lighting.js';   // CSM GLSL for water.js
import { Props } from './render/props.js';

const MAP_W = N * TILE;               // world width of the map (640 at N=80)
const CENTER = MAP_W / 2;             // world center (320 at N=80)
const CHUNKS = Math.ceil(N / CHUNK);  // 5 chunks per side at N=80

// Day / night key colours (sRGB hex).
const DAY_SKY = 0x87d4f5;
const NIGHT_SKY = 0x0e1836;
const SUNSET = 0xff9a5c;
const SUN_DAY = 0xfff4e0;
const MOON = 0x8fb0ff;
const RAIN_GRAY = 0x8a929c;    // sky tint under rain

// Window / glow tints (sRGB hex) by palette index.
const GLOW_WARM = 0xffd98a;   // 200
const GLOW_COOL = 0xbde3ff;   // 201
const GLOW_LAMP = 0xffe7a8;   // 202
// 203 (neon) uses the block's own colour boosted.

// Ground palette (sRGB hex).
const GRASS_A = 0x86d94f;
const GRASS_B = 0x74c73f;
const WATER_C = 0x3fa9f0;
const SAND_C = 0xe6d59a;
const ROAD_C = 0x40454d;
// Mountain height bands (grassy base -> rock -> snow cap).
const MTN_GRASS = 0x5a9e3f;   // low ~1/3
const MTN_ROCK = 0x8b9098;    // middle
const MTN_SNOW = 0xf4f8ff;    // top ~2 voxels on tall peaks

// Key-to-fill balance. sky.js returns a physically-plausible but fill-dominant
// solution; these push it toward the sun so cast shadows read as shapes rather
// than a tint. See _applySkyLighting().
const SUN_GAIN = 1.85;
const FILL_GAIN = 0.70;

// ---- Daytime key placement (art direction: "Isometric City Voxel") --------
// The reference keys every block from the UPPER LEFT of the iso view, so each
// one reads as three separated tones: top brightest, left wall mid, right wall
// darkest-but-colourful, with soft shadows falling back/right. That is a
// relation to the VIEW, so the key is placed relative to the camera's
// (smoothed) azimuth rather than fixed in the world: rotating the camera keeps
// the same read instead of turning every lit wall to the back.
//   camera horizontal dir = (sin az, cos az); the LEFT visible wall faces
//   az - 45deg, the right one az + 45deg. Key az = az - 35deg puts the key 10deg
//   off the left-wall normal: the left wall takes ~all of the horizontal key,
//   the right wall only a grazing sliver, shadows fall back-right.
// Measured on probe cubes (sRGB luma top/left/right after post), offset sweep:
//   -19deg  blue 112/86/74  orange 158/131/117   (right wall too close to left)
//   -35deg  blue 112/88/66  orange 158/134/106   <- ~1 : 0.80 : 0.63
//   -50deg  blue 112/89/61  orange 158/135/97    (right wall starts to go flat)
// Round 2 (critic: "cast shadows onto lots and roads too faint and too small
// to read in iso-mid"): at -35deg the shadows ran along the iso axis straight
// BEHIND each building — a tower's shadow tip landed inside its own right
// wall's silhouette, so it was hidden by construction. -60deg swings them to
// fall back and to the RIGHT onto open ground, as in the reference; the right
// wall then takes no key at all (fill only — kept colourful by the fill
// saturation in lighting.js). 50deg elevation keeps the top brightest.
// Round 3 (critic: "buildings cast almost no visible shadow onto the road, the
// lots or the blocks next to them"): at -60 the shadow still ran up-right at
// ~18 deg on screen, i.e. almost ALONG the right wall's own silhouette edge
// (30 deg), so each building hid most of its own shadow. -95 puts the key
// just behind screen-left: shadows fall straight to the right on screen, a
// clear wedge in front of every right wall (the lot / road the critic looked
// at), and the left wall still takes cos(50) of the horizontal key. 42 deg
// lengthens them (1.1 x height instead of 0.84) without the left wall
// overtaking the top — the fill is top-heavy (sky.js), so tops stay brightest.
// Probe cubes (sRGB luma top/left/right, after post), with sky.js's r3 fill:
//   cream 225/189/130 (1 : .84 : .58)  brick 103/86/53 (1 : .83 : .51)
//   open-grass cast shadow / lit grass 0.53-0.55 (was 0.60 and barely read).
// Round 6 (critic r5: "the left and right walls of the grey helipad tower are
// nearly the same light grey ... the reference always has mid-tone left faces
// and a clearly darker right face"). At -95 the key sat 50 deg past the left-
// wall normal, so the left wall took only cos(42)cos(50) = 0.48 of the key —
// less than a roof (0.67) — and the fill did most of the work on both walls.
// -75 / 40 puts it 30 deg off the left-wall normal: left wall 0.66 of the key
// (+38%), roofs 0.64, right wall still none. Shadows fall right and ~9 deg up
// on screen, still clear of the right wall's own silhouette (30 deg).
// Measured iso-mid, SKY tower, sRGB luma lit/away (after post, 2x):
//   -95/42 216/140 (0.65)   -75/40 + r6 fill (sky.js) 231/135 (0.58),
//   away wall (126,136,149): darker AND a touch cool, like ref05's bank.
// Coordinator 21:05 set -100 / 58 from a white-probe sweep (1 : 0.87 : 0.70).
// Round 8 (critic r7: "left and right walls sit at almost the same mid value
// ... towers cast almost no visible soft shadow"): measured with the faces
// masked by a normal render (scratchpad lt8/an.py), -100/58 left walls took
// almost no key — key-only render, neutral walls: left 47 vs top 191 sRGB — so
// BOTH walls were fill-lit and converged; the white probe hid it because its
// top clips. -85 / 50 gives the left wall a real key (cos50 cos40 = 0.49 of
// it) while tops stay brightest (0.77), and throws 0.84 x height shadows to
// the right on screen. The right wall's darkness now comes from the
// directional wall fill (lighting.js csmWallFill), not from starving the left.
// iso-mid white prop T/L/R 249 / 227 / 159 (1 : 0.91 : 0.64; ref04 0.89/0.63).
const KEY_AZ_OFFSET = -100 * Math.PI / 180;   // coordinator: faceprobe-measured (pieces/light.md 21:05, 22:45). Change ONLY with faceprobe numbers.
const KEY_ELEVATION = 58 * Math.PI / 180;
// The voxel material's own "sky fill" (materials.js skyFill, a flat bounce
// that is not scaled by any light) was ~20% of a wall's light and alone kept
// every far wall at ~0.65 of its top. By day it is scaled down with the rest of
// the authored fill (see _applySkyLighting); dusk/night keep materials' value.
const DAY_SKYFILL_SCALE = 0.36;
const FILL_SCALE = 0.8;   // global daytime fill multiplier (see _fillScale)
// Same treatment for materials.js's "sun bounce" (params.bounce, 0.30): it adds
// key light to faces turned AWAY from the key, and it is added AFTER the BRDF
// (no 1/PI), so at 0.30 it was ~1.7x the key's own direct light on the lit
// wall. Measured r5, iso-mid, pale-blue tower sRGB luma left/right: 211/211
// with it, 211/148 without — it was the whole reason pale buildings showed no
// dark side (critic r4: "left and right walls differ only slightly"). By day
// keep a trace for hue carry; dusk/night keep materials' value.
const DAY_BOUNCE_SCALE = 0.1;
// Share of lighting.js's contact AO that voxel faces keep (materials.js
// params.worldAOKeep defaults to 0 because the OLD sparse kernel streaked
// flat faces; the r7 map-space version is smooth). See _applySkyLighting.
const VOXEL_WORLD_AO_KEEP = 1.0;

const clamp = THREE.MathUtils.clamp;

// ---- True-isometric orthographic camera -----------------------------------
// Elevation atan(1/sqrt2) = 35.264 deg (polar from +Y = acos(1/sqrt3)), azimuth
// on the 45-degree diagonals, snapped in 90-degree steps. "Zoom" is still kept
// as a camDist-EQUIVALENT: the orbit distance at which the old 40-degree
// perspective camera showed the same view height. The ortho view half-height is
// camDist * ISO_TAN_HALF, and the ortho camera itself sits camDist away from the
// target along the view axis, so everything that reads ctx.camDist or measures
// distance from camera.position (post DOF focus, fog, LOD, props culling) keeps
// its old meaning at the matching apparent zoom.
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));    // 0.9553 rad = 54.736 deg
const ISO_AZ0 = Math.PI * 0.25;                   // first 45-degree diagonal
const ISO_STEP = Math.PI * 0.5;                   // rotation snap
const ISO_TAN_HALF = Math.tan(20 * Math.PI / 180); // old fov/2 -> camDist mapping
// Closest zoom: one 2x2 lot (16 world units + its building) fills the screen.
const ISO_ZOOM_MIN = 36;
// Ortho near is NEGATIVE: the camera sits only camDist from the target, and at
// close zoom a tall tower near the bottom of the frame extends behind the
// camera plane. A generous back margin keeps it from ever clipping.
const ISO_NEAR = -700;
const ISO_FAR = 3200;

export class Engine {
  constructor(canvas) {
    this._canvas = canvas;

    // ---- Renderer ----------------------------------------------------------
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // keep bright saturated kid colours
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // ---- Scene / sky / fog -------------------------------------------------
    this.scene = new THREE.Scene();
    this._skyCol = this._mkColor(DAY_SKY);
    this._dayColor = this._mkColor(DAY_SKY);
    this._nightColor = this._mkColor(NIGHT_SKY);
    this._sunsetColor = this._mkColor(SUNSET);
    this._sunDayColor = this._mkColor(SUN_DAY);
    this._moonColor = this._mkColor(MOON);
    this.scene.background = this._skyCol.clone();
    // Fog near/far scale with MAP_W so distant edges fade without hiding the city.
    this.fog = new THREE.Fog(this.scene.background.getHex(), MAP_W * 0.55, MAP_W * 1.85);
    this.fog.color.copy(this.scene.background);
    this.scene.fog = this.fog;

    // ---- Lights ------------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xbfe3ff, 0x6b8f4e, 0.6);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0x2a3550, 0.18);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(this._sunDayColor.getHex(), 1.1);
    this.sun.color.copy(this._sunDayColor);
    this.sun.position.set(CENTER - 150, 320, CENTER - 110);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(3072, 3072);
    const sc = this.sun.shadow.camera;
    // Ortho frustum sized to the whole map (±0.75·MAP_W ≈ ±384 at N=64) so
    // shadows don't clip at the edges of the bigger world.
    const sHalf = MAP_W * 0.30;   // was 0.75 — 2.5x the shadow texel density
    sc.left = -sHalf; sc.right = sHalf; sc.top = sHalf; sc.bottom = -sHalf;
    // near/far span the map comfortably from the raised sun position.
    sc.near = MAP_W * 0.08; sc.far = MAP_W * 2.6;
    sc.updateProjectionMatrix();
    // STOPGAP (superseded once src/render/lighting.js lands): normalBias was
    // 0.9 — nearly a full voxel — which offset the shadow lookup so far off
    // every caster that the city cast no visible shadow at all. Combined with
    // a +/-480 frustum at 3072px (~0.31 world units per texel, coarser than one
    // voxel) nothing survived. Tighten both.
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this._sunTarget = new THREE.Object3D();
    this._sunTarget.position.set(CENTER, 0, CENTER);
    this.scene.add(this._sunTarget);
    this.sun.target = this._sunTarget;

    // ---- Camera ------------------------------------------------------------
    // True-isometric orthographic camera (see ISO_* above). Frustum extents are
    // set every frame in _applyCamera() from the smoothed zoom.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, ISO_NEAR, ISO_FAR);
    this._aspect = 1;
    this._camTarget = new THREE.Vector3(CENTER, 0, CENTER);
    this._camDist = 205;          // zoom, as a perspective-equivalent orbit distance
    this._camAz = ISO_AZ0;        // always ISO_AZ0 + k * ISO_STEP (input snaps)
    this._camPolar = ISO_POLAR;
    this._rotAccum = 0;           // px of right-drag / rad of twist toward a snap
    // Smoothed (damped) copies actually used to place the camera.
    this._sTarget = this._camTarget.clone();
    this._sDist = this._camDist;
    this._sAz = this._camAz;
    this._sPolar = this._camPolar;

    // ---- Shared uniforms ---------------------------------------------------
    this._nightUniform = { value: 0 };   // window glow amount 0..1
    this._waterUniform = { value: 0 };   // water animation time
    this._seasonUniform = { value: new THREE.Vector3(1, 1, 1) }; // weather tint multiplier for ground

    // ---- Materials ---------------------------------------------------------
    // Render quality: 0 low, 1 medium, 2 high. Drives PostFX, shadow cascades
    // and voxel bevelling. See CONTRACTS-RENDER.md §6.
    // PERF: start at the level this device can carry (see _deviceQuality);
    // the frame-time governor in render() steps down from there if needed.
    this._quality = this._deviceQuality();
    this._qualityCap = this._quality;
    this._autoQ = true;
    this._gov = { t: 0, acc: 0, n: 0, slow: 0, slowWins: 0, rung: this._quality === 2 ? 0 : this._quality === 1 ? 2 : 3,
      cap: this._quality === 2 ? 0 : this._quality === 1 ? 2 : 3, lastChange: 0, failed: new Set(), probeAt: -1 };
    // Micro-bevelling costs a measured 5.00x triangles (1.12M -> 5.60M for a
    // 500-building city, before shadow passes re-submit it). Off by default;
    // the per-vertex AO term carries block separation on its own.
    this._bevel = false;

    this._matLib = new MaterialLib(this.renderer, {
      uniforms: { uNight: this._nightUniform, uSeason: this._seasonUniform },
      quality: this._quality,
      // The scene already carries a hemisphere + ambient fill from the sky's
      // analytic solution. Full-strength IBL *on top* of that double-counts
      // ambient and washes every facade out to near-white.
      params: { envIntensity: 0.38 },
    });
    this._voxMat = this._matLib.voxel;
    this._ghostMat = this._matLib.ghost;

    // ---- Sky / ground modules ----------------------------------------------
    // Sky owns scene.background (it sets it to null and draws a dome instead)
    // and is the authority on sun direction/colour; setNight() feeds it.
    this._sky = new Sky(this.scene, {
      renderer: this.renderer,
      quality: this._quality,
      applyEnvironment: true,
      // sky.js was authored against NoToneMapping; PostFX applies ACES
      // downstream, which eats roughly 15% — pay it back here.
      exposure: 0.052,
      // 0.52 rad = 30deg, matching lighting.js's moon key floor. The default
      // 4.3deg put the disc barely above the horizon while the key lit from 30.
      moonElevation: 0.52,
      horizonLift: 1.0,   // must track terrain's uHorizonLift exactly
    });
    this._terrain = new Terrain(this.scene, {
      uniforms: { uNight: this._nightUniform, uSeason: this._seasonUniform },
      quality: this._quality,
      envIntensity: 0.40,
      aniso: this.renderer.capabilities.getMaxAnisotropy(),
      // water.js recesses every lake/sea into a hard-edged voxel basin (sand
      // deck + walls on the tile grid, ref05's hotel pool), so the ground must
      // meet it ON the grid: no warped bank, no swash ramp, no noise beach.
      shoreWarp: 0,
      swash: 0,
      beachNoise: false,
      // The water surface is opaque and sits ~2.6 below the ground (a deep
      // basin with tall pool walls, water.js), so terrain's seabed (-1.15 at
      // the shore) would poke through it — and would never be seen anyway.
      seabed: false,
    });
    if (this._terrain.uniforms && this._terrain.uniforms.uHorizonLift) {
      // terrain's lift existed only to compensate for sky.js converging just
      // 62% of the way to fogColor. sky.js now converges properly, so any lift
      // is a 1:N radiance MISMATCH between the dome and the ground skirt — and
      // that mismatch, measured at exactly 2.20x, WAS the frame-wide horizon
      // seam. Both sides now converge on plain fogColor. This also matches
      // buildings/props/water, which fog to 1.0x via three's stock chunk.
      this._terrain.uniforms.uHorizonLift.value = 1.0;
    }
    // groundTop: raised terrain lots count as lots for the sidewalk width (roads r10)
    this._roads = new Roads(this.scene, { quality: this._quality,
      groundTop: (x, z) => (this._terrain && this._terrain.cellTopY ? this._terrain.cellTopY(x, z) : 0) });
    // seabed:false — the surface is opaque; nothing below it is ever seen.
    this._water = new WaterFX(this.scene, { seabed: false, quality: this._quality });
    // The foam line follows terrain.js's warped (off-grid) bank, not the tiles.
    if (this._water.setLandWarp && this._terrain && typeof this._terrain._warp === 'function') {
      this._water.setLandWarp((x, z, o) => this._terrain._warp(x, z, o), TILE / (this._terrain.sub || 2));
    }
    this._roadAnchors = [];
    this._lampsDirty = false;
    this._glowsDirty = false;
    this._glowsLit = false;

    // ---- Lighting / cascaded shadows ---------------------------------------
    // LightingRig REPLACES three's shadow system wholesale. three's
    // MeshDepthMaterial round-trips depth at only ~9 effective bits on this
    // stack, which is why the old code needed normalBias 0.9 (≈2 voxels of
    // offset) to hide the acne — and thereby deleted every shadow. The rig
    // packs 24-bit depth into its own caster material and casts back faces, so
    // the bias drops to ~0.09 world units. Turn three's shadow pass off; it
    // would be a pure waste of a geometry pass now.
    this.renderer.shadowMap.enabled = false;
    this._lighting = new LightingRig(this.renderer, this.scene, this.camera, {
      quality: this._quality,
      sunSource: 'external',      // sky.js is the authority on sun direction
      skylightWarmth: 0.62,       // full strength read as orange paint (R/B 1.82 on asphalt)
      // Must clear the TALLEST THING IN THE SCENE, not the tallest model:
      // buildings sit on terrain and the seeded city reaches y=56.3, so a 40
      // cap clipped the top ~30% of every skyscraper out of the shadow map and
      // downtown rendered shadowless. Keep headroom over stadium + mountains.
      maxCasterHeight: 80,
      // Art direction: light, soft shadows with CONTACT darkening only where
      // things actually meet (ref04). The default 10-unit contact distance
      // treated everything within a whole building-width of a wall as
      // "enclosed", so open ground in a cast shadow lost most of its sky fill
      // and read 0.45-0.54 of lit grass (sRGB luma) against ref04's 0.58-0.69.
      // 4.5 / 0.15 keeps the dark tuck at the foot of every wall and lifts
      // the open shadow to ~0.66.
      skyContactWorld: 4.5,
      // r5: 0.15 -> 0.8. Critic r4: "cast shadows are nearly invisible ... the
      // city reads as one wall of lit facades with little depth". Open ground
      // in a tower's shadow kept ~93% of its fill, so a shadow only removed
      // the key: lit/shadow sRGB luma 0.76 on light paving, 0.65 on asphalt.
      // Now an open shadow also loses a real share of sky (the tower that
      // blocks the sun does fill part of the dome): 0.59 / 0.41 — ref04's
      // Blender shadows sit at 0.58-0.69. Faces turned away from the key are
      // never "sun-blocked" (lighting.js terminator fade), so this deepens
      // cast shadows WITHOUT darkening the far walls.
      // r8: 0.8 -> 1.0 (with shadowAmbient 0.8 / shadowIbl 0.92 below). Critic
      // r7: "the tall towers cast almost no visible soft shadow onto the lots,
      // roads or neighbouring roofs". Post's shaded-face floor (r10) lifts the
      // darker half of the frame, so cast shadow / lit on tops had crept back
      // to 0.73-0.75 (iso-mid, same frame with shadowStrength 0). Now 0.57-0.61
      // (ref04 0.58-0.69); asphalt 0.61.
      skyOpenFloor: 1.0,
      // Penumbra (r4). The iso layout (lighting.js QUALITY isoTile/isoGrid)
      // fits a 2048 map to the screen (0.045-0.08 world units per texel at
      // iso-close / iso-mid, was 0.064-0.134 on a 1024 depth-split cascade)
      // and filters with an exact tent capped at 3 texels, so the penumbra
      // no longer has to hide a staircase: contact-hardening from ~1 texel
      // at a wall foot to ~3 texels for a long tower shadow. The old 0.30-unit
      // floor made a 0.75-unit AC unit's shadow almost all penumbra — the r3
      // critic's "smeared grey blotches".
      minPenumbra: 0.03,
      // surface r8 (critic r7: "ragged, blotchy shadow boundaries, looks like
      // an oil-paint/denoise filter" on the bakery). A/B on one-bakery: the
      // ragged edges are the shadow-map texel staircase + tap noise at the
      // 4-device-px default floor (they survive every post pass off and
      // vanish with shadows off). A 10 px floor turns them into a clean soft
      // edge; taps stay capped at CSM_MAX_TAPS. LIGHT: tune freely, but keep
      // shadow edges on voxel walls free of the sawtooth.
      penumbraFloorPixels: 10,
      softness: 0.025,
      maxPenumbra: 0.5,
      blockerSearchWorld: 2.2,
      // Sky occlusion near casters (canyons, wall feet). r3 critic: the gaps
      // between towers went "navy and near-black" — 0.64 / 0.88 on top of
      // SSAO + voxel AO compounded; ref05's shaded streets stay light and airy.
      // r5: 0.45/0.60 -> 0.6/0.75 with the higher open floor above.
      // r6: 0.6/0.75 -> 0.7/0.85 (critic r5: "cast shadows are very faint at
      // the mid zoom"). Only horizontal receivers take this now (lighting.js
      // csmLastUpW), so it deepens shadows on lots/roofs/streets without
      // pushing a shadowed building's key-side wall below its far wall.
      // Open-top shadow / lit at iso-mid: 0.63 -> 0.59 (ref04 0.58-0.69).
      shadowAmbient: 0.8,   // r8: 0.7 -> 0.8 (see skyOpenFloor)
      shadowIbl: 0.92,      // r8: 0.85 -> 0.92
    });
    // The rig brings its own sun/hemi/ambient and needs its sun to be
    // directional light index 0 — retire the engine's originals and adopt the
    // rig's so the rest of this file (and _applySkyLighting) keeps working.
    this.scene.remove(this.sun);
    this.scene.remove(this.hemi);
    this.scene.remove(this.ambient);
    this.scene.remove(this._sunTarget);
    this.sun = this._lighting.sun;
    this.hemi = this._lighting.hemi;
    this.ambient = this._lighting.ambient;
    this._sunTarget = this._lighting.sunTarget;

    // Every lit material must sample the rig's cascade atlas. patchMaterial
    // CHAINS onBeforeCompile, so each module's own shader injection survives.
    this._lighting.patchMaterial(this._matLib.voxel);
    this._lighting.patchMaterial(this._terrain.material);
    // water.js is a raw ShaderMaterial, so it takes the CSM GLSL explicitly.
    if (this._water.setShadowSource) {
      this._water.setShadowSource({
        uniforms: this._lighting.getShaderUniforms(),
        fragPars: LightingNS.CSM_FRAGMENT_PARS,
        vertPars: LightingNS.CSM_VERTEX_PARS,
        vertMain: LightingNS.CSM_VERTEX_MAIN,
      });
    }
    // The voxel basin (sand deck, pool walls, floats) is a lit standard material.
    if (this._water.bankMaterial) this._lighting.patchMaterial(this._water.bankMaterial);
    // Street furniture + natural scatter. roads.js has been emitting ~306
    // anchors (lamp/trafficlight/sign/hydrant/bin/bench) since it shipped and
    // nothing consumed them — every critic named the bare sidewalks as the
    // single biggest "not a real city" tell.
    this._propFX = new Props(this.scene, {
      quality: this._quality,
      uniforms: { uNight: this._nightUniform },
    });
    this._lighting.patchMaterial(this._propFX.material);   // required for CSM shadows
    this._propFX.material.envMapIntensity = 0.38;

    if (this._roads.material) {
      this._lighting.patchMaterial(this._roads.material);
      this._roads.material.envMapIntensity = 0.38;   // same key/fill rebalance
    }

    // ---- Post-processing ---------------------------------------------------
    // PostFX owns the scene pass: render() below calls it INSTEAD of
    // renderer.render(). Sized by resize() at the end of the constructor.
    this._post = new PostFX(this.renderer, this.scene, this.camera, {
      quality: this._quality,
      // Art direction (iso reference, ART-DIRECTION.md): pin-sharp and evenly
      // lit edge to edge — no tilt-shift/DOF, no vignette, no distance
      // desaturation; bloom only at night; a neutral (identity-below-0.76)
      // tonemap so the authored palette lands as authored; soft ref04-style
      // AO; supersampled AA at quality 2. Those are post.js's own defaults
      // now — only integration-specific overrides belong here.
      params: {
        dof: { enabled: false },
        atmo: { strength: 0 },
        grade: { vignette: 0 },
        sharpen: { amount: 0.12, beforeAA: true },
      },
    });
    // Post's twilight white balance reads the key / sky / ambient lights.
    if (this._post.setLights) this._post.setLights(this.sun, this.hemi, this.ambient);
    // Reused per-frame context handed to every render module (never retained).
    this._ctx = {
      time: 0, dt: 0, nightT: 0, nightEff: 0,
      weather: { rain: 0, snow: 0, tint: [1, 1, 1] },
      camera: this.camera, camDist: this._camDist,
      sunDir: new THREE.Vector3(), quality: this._quality,
    };
    this._elapsed = 0;

    // ---- Caches / registries ----------------------------------------------
    this._geoCache = new WeakMap();        // model -> BufferGeometry
    this._buildings = new Map();           // id -> Mesh
    this._props = new Map();               // "kind:x:z" -> Mesh
    this._ghostMesh = null;

    // Palette lookups (linear rgb triples). Filled by setPalette().
    this._palLin = [];
    this._glowLin = [];

    // ---- Raycast / input scratch (no per-frame allocation) ----------------
    this._ray = new THREE.Raycaster();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ndc = new THREE.Vector2();
    this._panA = new THREE.Vector3();
    this._panB = new THREE.Vector3();
    this._tmpHit = new THREE.Vector3();
    this._pointers = new Map();            // pointerId -> {x,y,button}
    this._pinchDist = null;
    this._pinchAng = null;

    this._tmpColor = new THREE.Color();

    // ---- Weather ----------------------------------------------------------
    this._nightT = 0;                       // last day/night value (for re-apply)
    this._weatherGray = 0;                  // sky gray factor (rain * 0.35)
    this._weatherGrayColor = this._mkColor(RAIN_GRAY);
    this._precip = null;                    // lazy precipitation system
    this._precipMode = null;                // 'rain' | 'snow' | null
    this._precipIntensity = 0;
    this._precipTime = 0;
    this._identityQuat = new THREE.Quaternion();

    // ---- Placement feedback / path preview / daylight lock ----------------
    this._daylightLock = false;             // "Always bright" — see setNight
    this._cellGeo = null;                    // shared flat tile quad geometry
    this._flashQuads = [];                   // pooled fading feedback quads (cap 32)
    this._ghostCellQuads = [];               // pooled steady road-path preview quads

    this.setNight(0);
    this.resize();
    // Place the camera immediately so picking works before the first frame.
    this._applyCamera();
  }

  _applyCamera() {
    // Ortho frustum from the smoothed zoom (camDist-equivalent).
    const cam = this.camera;
    const hh = this._sDist * ISO_TAN_HALF;
    const hw = hh * this._aspect;
    if (cam.top !== hh || cam.right !== hw) {
      cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
      cam.updateProjectionMatrix();
    }
    const sp = Math.sin(this._sPolar), cp = Math.cos(this._sPolar);
    this.camera.position.set(
      this._sTarget.x + this._sDist * sp * Math.sin(this._sAz),
      this._sTarget.y + this._sDist * cp,
      this._sTarget.z + this._sDist * sp * Math.cos(this._sAz)
    );
    this.camera.lookAt(this._sTarget);
    this.camera.updateMatrixWorld();
  }

  // ---------------------------------------------------------------------------
  // Palette
  // ---------------------------------------------------------------------------

  // Called once at boot by main.js before any model is rendered.
  setPalette(paletteArray) {
    this._palLin = [];
    this._glowLin = [];
    if (!Array.isArray(paletteArray)) return;
    const c = this._tmpColor;
    for (let i = 0; i < paletteArray.length; i++) {
      const hex = paletteArray[i];
      if (hex === undefined || hex === null) continue;
      c.setHex(hex, THREE.SRGBColorSpace);
      this._palLin[i] = [c.r, c.g, c.b];
    }
    // Glow tints for window indices.
    this._glowLin[200] = this._linTriple(GLOW_WARM);
    this._glowLin[201] = this._linTriple(GLOW_COOL);
    this._glowLin[202] = this._linTriple(GLOW_LAMP);
    // 203 neon: boost the block's own day colour.
    const base = this._palLin[203] || this._linTriple(0xff36c0);
    this._glowLin[203] = [
      Math.min(1, base[0] * 1.7 + 0.1),
      Math.min(1, base[1] * 1.7 + 0.1),
      Math.min(1, base[2] * 1.7 + 0.1),
    ];
    // The PBR material library derives roughness/metalness from the same palette.
    if (this._matLib) this._matLib.setPalette(paletteArray);
  }

  _linTriple(hex) {
    const c = this._tmpColor;
    c.setHex(hex, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
  }

  _mkColor(hex) {
    return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  }

  _colOf(ci) {
    const p = this._palLin[ci];
    if (p) return p;
    // Fallback so a missing index never crashes: a stable-ish grey.
    return [0.6, 0.6, 0.62];
  }

  _glowOf(ci) {
    const g = this._glowLin[ci];
    if (g) return g;
    // Unknown window index -> warm glow default.
    return this._glowLin[200] || this._linTriple(GLOW_WARM);
  }

  // ---------------------------------------------------------------------------
  // Materials (custom shader injection)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Voxel meshing (cached by model reference)
  // ---------------------------------------------------------------------------

  _getGeometry(model, noAtlas) {
    if (model && model.surf) return this._getSurfGeometry(model);
    if (!model || !Array.isArray(model.blocks)) return this._emptyGeometry();
    let geo = this._geoCache.get(model);
    if (geo) return geo;
    // Upgraded mesher: adds per-vertex voxel AO (`aoT`) and per-palette
    // roughness/metalness (`matParams`), which MaterialLib's shader reads.
    // Models may declare `res` (voxels per world unit); the mesher emits WORLD
    // units either way, so addBuilding/addProp/setGhost/makeDynamic place any
    // res identically (only makeSpinner's pivot reads model.sy — see there).
    // life r14: a model may carry `voxOpts` (mesher AO overrides). Small
    // movers (vehicles, people) pass a prop-scale AO (aoDist < 1): the
    // building-scale ground / broad / sky terms reach 2-3.5 units, so on a
    // 0.5-unit car every flank sat at AO 0.24-0.43 and its shade side went
    // black against the asphalt.
    // PERF: AO atlas (materials.js AoAtlas) — faces merge by colour alone and
    // read their AO from one shared texture (~2x fewer triangles). Falls back
    // to per-vertex AO if the atlas is unavailable or full.
    const atlas = !noAtlas && this._aoAtlasOn !== false && this._matLib && this._matLib.aoAtlas;
    const vopts = Object.assign({
      ao: true,
      bevel: this._bevel,
      palette: this._palLin,
      glowPalette: this._glowLin,
      aoAtlas: !!(atlas && atlas.ok),
    }, model.voxOpts || null);
    geo = buildVoxelGeometry(model, vopts);
    if (geo.userData && geo.userData.aoRegions && !atlas.place(geo)) {
      geo = buildVoxelGeometry(model, Object.assign(vopts, { aoAtlas: false }));
    }
    this._geoCache.set(model, geo);
    return geo;
  }

  // SMOOTH SURFACE part (model.surf, CONTRACTS.md): a pre-tessellated mesh in
  // world units, model-local like voxel.js output (x/z centred, y up from 0),
  // e.g. a lathed cooling tower. { pos, nrm: Float32Array(3n), ci: palette
  // index per vertex, ao?: Float32Array(n), idx: Uint32Array }. Given the
  // voxel material's attribute set so it lights, shadows and glows like the
  // rest of the building.
  _getSurfGeometry(model) {
    let geo = this._geoCache.get(model);
    if (geo) return geo;
    const s = model.surf, n = s.pos.length / 3;
    const color = new Float32Array(n * 3), matParams = new Float32Array(n * 2), aoT = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const ci = s.ci[v], c = this._palLin[ci] || [0.6, 0.6, 0.62], m = materialFor(ci);
      color[v * 3] = c[0]; color[v * 3 + 1] = c[1]; color[v * 3 + 2] = c[2];
      matParams[v * 2] = m.roughness; matParams[v * 2 + 1] = m.metalness;
      aoT[v] = s.ao ? s.ao[v] : 1;
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(s.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(s.nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('glowColor', new THREE.BufferAttribute(color.slice(), 3));
    geo.setAttribute('emissiveT', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aoT', new THREE.BufferAttribute(aoT, 1));
    geo.setAttribute('matParams', new THREE.BufferAttribute(matParams, 2));
    geo.setIndex(new THREE.BufferAttribute(s.idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this._geoCache.set(model, geo);
    return geo;
  }

  // PERF: the SCENE-PASS geometry of a model — the cached voxel geometry's
  // attributes with voxel.js's `viewIndex` (no -Y faces, no faces into a
  // sealed interior: nothing the iso camera can ever see). Same vertices and
  // quad order, so every visible pixel is unchanged. Meshes that use it carry
  // the full geometry in `userData.casterGeometry`, which lighting.js renders
  // in its shadow and world-AO passes (back faces / undersides matter there).
  _getViewGeometry(model, noAtlas) {
    const full = this._getGeometry(model, noAtlas);
    const vi = full.userData && full.userData.viewIndex;
    if (!vi) return full;
    const vc = this._viewGeoCache || (this._viewGeoCache = new WeakMap());
    let geo = vc.get(full);
    if (geo) return geo;
    geo = new THREE.BufferGeometry();
    for (const k in full.attributes) geo.setAttribute(k, full.attributes[k]);
    geo.setIndex(new THREE.BufferAttribute(vi, 1));
    geo.boundingSphere = full.boundingSphere;
    geo.boundingBox = full.boundingBox;
    geo.userData = full.userData;
    vc.set(full, geo);
    return geo;
  }

  // A static mesh drawn with the view geometry, casting with the full one.
  _viewMesh(model) {
    const mesh = new THREE.Mesh(this._getViewGeometry(model), this._voxMat);
    const full = this._getGeometry(model);
    if (mesh.geometry !== full) mesh.userData.casterGeometry = full;
    mesh.userData.voxModel = model;
    this._lodAssign(mesh);
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // PERF: distance LOD (see voxel.js lodModel)
  // ---------------------------------------------------------------------------
  // A catalog building is ~10k triangles of res-4/8 detail; zoomed out past
  // the default view a fine voxel is well under a device pixel and those
  // triangles cost vertex work plus 2x2-quad fragment work for nothing. Each
  // voxel mesh (building, part, prop, mover) shows the coarsest resampled copy
  // of its model whose voxels are still at most `_lodPx` device pixels
  // (quality-tiered, see _lodPxFor), built lazily a few per frame. The ghost,
  // spinners and the window-glow light positions always use the full model.
  // Max coarse-voxel size in DEVICE px. Measured (perf.md): at 0.6 px a 2:1
  // resample of a res-4 facade still shifted tone (frames / panes / AO blend
  // differently), so quality 2 only resamples once a coarse voxel is <= 0.5
  // px — in practice res >= 8 models and movers when zoomed right out.
  // Movers (tiny, always in motion) and the lower quality levels go further.
  _lodPxFor(q, dyn) {
    // Movers: off at quality 2 (life.js makes many one-off composite models —
    // parked rows, lot fills — and resampling each cost more CPU than the
    // few triangles saved); on at 1 / 0.
    if (dyn) return q >= 2 ? 0 : q === 1 ? 1.5 : 2.0;
    return q >= 2 ? 0.5 : q === 1 ? 1.0 : 1.6;
  }

  // Device pixels per world unit at the current zoom (ortho: constant).
  _unitPx() {
    const cam = this.camera;
    const hh = (cam.top - cam.bottom) / (cam.zoom || 1);
    const bufH = this._post && this._post._h ? this._post._h : (this._canvas.height || 720);
    return bufH / Math.max(1e-6, hh);
  }

  // Target res for a model of res r: the coarsest of r/2, r/4, r/8 (integers)
  // whose voxels stay <= lodPx device px; r itself when none qualifies.
  _lodRes(r, unitPx, lodPx) {
    if (!(unitPx > 0) || !(lodPx > 0) || r <= 1) return r;
    const need = unitPx / lodPx;          // minimum res that keeps voxels <= lodPx
    let best = r;
    for (let d = 2; d <= 8; d *= 2) {
      const r2 = Math.floor(r / d);
      if (r2 < 1 || r2 < need) break;
      best = r2;
    }
    return best;
  }

  // Geometry pair for (model, res): { view, full } or null (not built / none).
  _lodEntry(model, r2) {
    const c = this._lodCache || (this._lodCache = new WeakMap());
    let m = c.get(model);
    if (!m) { m = new Map(); c.set(model, m); }
    if (m.has(r2)) return m.get(r2);
    return undefined;
  }

  _lodBuild(model, r2, dyn) {
    const lm = lodModel(model, r2);
    let entry = null;
    if (lm) {
      const full = this._getGeometry(lm, dyn);
      entry = { full, view: this._getViewGeometry(lm, dyn) };
    }
    this._lodCache.get(model).set(r2, entry);
    return entry;
  }

  // Point one mesh at the geometry for the current LOD (or queue the build).
  _lodAssign(mesh) {
    const model = mesh.userData.voxModel;
    if (!model || !model.blocks) return;
    const r = modelRes(model);
    const r2 = this._lodRes(r, this._lodUnitPx || 0, mesh.userData.lodDyn ? this._lodPxDyn || 0 : this._lodPx || 1);
    let view, full;
    if (r2 < r) {
      const e = this._lodEntry(model, r2);
      if (e === undefined) { (this._lodQueue || (this._lodQueue = new Set())).add(mesh); return; }
      if (e) { view = e.view; full = e.full; }
    }
    if (!view) { const na = !!mesh.userData.lodDyn; view = this._getViewGeometry(model, na); full = this._getGeometry(model, na); }
    if (mesh.geometry === view) return;
    mesh.geometry = view;
    mesh.userData.casterGeometry = full !== view ? full : undefined;
    // window-glow light positions always come from the full-detail model
    mesh.userData.glowGeometry = this._getGeometry(model, !!mesh.userData.lodDyn);
  }

  _lodForEach(fn) {
    for (const m of this._buildings.values()) {
      fn(m);
      const k = m.children;
      for (let i = 0; i < k.length; i++) if (k[i].userData.voxModel) fn(k[i]);
    }
    for (const m of this._props.values()) fn(m);
    if (this._dynMeshes) for (const m of this._dynMeshes) fn(m);
  }

  // Per frame: re-evaluate when the zoom moved > 8% (hysteresis), then spend
  // a small budget building queued LOD geometry.
  _updateLod() {
    if (this._lodEnabled === false) {
      if (this._lodUnitPx) { this._lodUnitPx = 0; this._lodForEach((m) => this._lodAssign(m)); }
      return;
    }
    const u = this._unitPx();
    const lp = this._lodPxFor(this._quality, false);
    const cur = this._lodUnitPx || 0;
    if (lp !== this._lodPx || !cur || Math.abs(u - cur) > 0.08 * cur) {
      this._lodPx = lp;
      this._lodPxDyn = this._lodPxFor(this._quality, true);
      this._lodUnitPx = u;
      if (this._lodQueue) this._lodQueue.clear();
      this._lodForEach((m) => this._lodAssign(m));
    }
    const q = this._lodQueue;
    if (!q || !q.size) return;
    const t0 = performance.now();
    for (const mesh of q) {
      q.delete(mesh);
      if (!mesh.parent) continue;            // removed / disposed meanwhile
      const model = mesh.userData.voxModel;
      const r2 = this._lodRes(modelRes(model), this._lodUnitPx, mesh.userData.lodDyn ? this._lodPxDyn : this._lodPx);
      if (this._lodEntry(model, r2) === undefined) this._lodBuild(model, r2, !!mesh.userData.lodDyn);
      this._lodAssign(mesh);
      if (performance.now() - t0 > 4) break;
    }
  }

  setLod(on) { this._lodEnabled = on !== false; }

  _emptyGeometry() {
    if (!this._empty) {
      this._empty = new THREE.BufferGeometry();
      this._empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    }
    return this._empty;
  }

  _buildVoxelGeometry(model) {
    const sx = model.sx || 1, sy = model.sy || 1, sz = model.sz || 1;
    const blocks = model.blocks;
    const hx = sx / 2, hz = sz / 2;

    // Occupancy set for simple face occlusion.
    const occ = new Set();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      occ.add(b[0] + ',' + b[1] + ',' + b[2]);
    }

    const pos = [], nor = [], col = [], glo = [], emi = [];

    const pushQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, c, g, e) => {
      // two triangles: A,B,C and A,C,D
      const px = [ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz];
      for (let k = 0; k < 18; k += 3) {
        pos.push(px[k], px[k + 1], px[k + 2]);
        nor.push(nx, ny, nz);
        col.push(c[0], c[1], c[2]);
        glo.push(g[0], g[1], g[2]);
        emi.push(e);
      }
    };

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const vx = b[0], vy = b[1], vz = b[2], ci = b[3];
      const c = this._colOf(ci);
      const isWin = ci >= 200;
      const e = isWin ? 1 : 0;
      const g = isWin ? this._glowOf(ci) : c;

      const x0 = vx - hx, x1 = x0 + 1;
      const y0 = vy, y1 = vy + 1;
      const z0 = vz - hz, z1 = z0 + 1;

      // Top +Y
      if (!occ.has(vx + ',' + (vy + 1) + ',' + vz))
        pushQuad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0, c, g, e);
      // Bottom -Y (skip if on ground or covered)
      if (vy > 0 && !occ.has(vx + ',' + (vy - 1) + ',' + vz))
        pushQuad(x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1, 0, -1, 0, c, g, e);
      // North -Z
      if (!occ.has(vx + ',' + vy + ',' + (vz - 1)))
        pushQuad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, c, g, e);
      // South +Z
      if (!occ.has(vx + ',' + vy + ',' + (vz + 1)))
        pushQuad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, c, g, e);
      // West -X
      if (!occ.has((vx - 1) + ',' + vy + ',' + vz))
        pushQuad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, c, g, e);
      // East +X
      if (!occ.has((vx + 1) + ',' + vy + ',' + vz))
        pushQuad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, c, g, e);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('glowColor', new THREE.Float32BufferAttribute(glo, 3));
    geo.setAttribute('emissiveT', new THREE.Float32BufferAttribute(emi, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  // ---------------------------------------------------------------------------
  // Buildings / props / dynamics
  // ---------------------------------------------------------------------------

  _tileCenter(x, z, out) {
    out.set((x + 0.5) * TILE, 0, (z + 0.5) * TILE);
    return out;
  }

  addBuilding(id, model, x, z, yScale = 1, rot = 0) {
    if (this._buildings.has(id)) this.removeBuilding(id);
    const mesh = this._viewMesh(model);
    mesh.castShadow = true;
    mesh.receiveShadow = true;   // self-shadowing + tower-onto-tower
    // (x,z) is the NW anchor tile of the EFFECTIVE footprint; rot k swaps
    // the model's tw×td when odd. rot 0 fronts +Z(S), 1 +X(E), 2 −Z(N), 3 −X(W).
    const tw = model.tw || 1, td = model.td || 1;
    const etw = (rot % 2) ? td : tw, etd = (rot % 2) ? tw : td;
    // Buildings stand on their lot plinth (terrain.js draws it; LOT_Y high).
    // ground r10: a 1x1 deco item on a raised lawn plinth stands on its top
    // (lawnLift is 0 everywhere else, and under any real building's footing).
    mesh.position.set((x + etw / 2) * TILE, LOT_Y + (etw * etd === 1 ? this._lawnLift(x, z) : 0), (z + etd / 2) * TILE);
    mesh.rotation.y = (rot || 0) * Math.PI / 2;
    mesh.scale.y = Math.max(0.001, yScale);
    // model.parts (optional): extra voxel models on the same footprint and
    // anchor (same sx/res, sz/res), e.g. a res-8 cooling tower on a res-4
    // power plant. Children follow the building's rot, grow-in scale and removal.
    if (Array.isArray(model.parts)) for (const p of model.parts) {
      const child = this._viewMesh(p);
      child.castShadow = true;
      child.receiveShadow = true;
      mesh.add(child);
    }
    this.scene.add(mesh);
    this._buildings.set(id, mesh);
    mesh.userData.baseY = mesh.position.y;
    this._growLot(mesh, mesh.scale.y);
    // main.js does not refreshTile() on 'placed'; let terrain raise the pad.
    if (this._terrain && this._terrain.noteTiles) this._terrain.noteTiles(x, z, etw, etd);
  }

  updateBuildingScale(id, yScale) {
    const mesh = this._buildings.get(id);
    if (!mesh) return;
    mesh.scale.y = Math.max(0.001, yScale);
    this._growLot(mesh, mesh.scale.y);
  }

  // res r1 (coherence #7): a catalog building brings its own 0.5-unit lot
  // plinth (ART-DIRECTION "Lots"). The construction grow used to scale the
  // whole mesh in Y, so the lot started as a sliver and rose with the house.
  // While growing, the building scales about the plinth top instead, and a
  // child mesh of just the plinth layers (counter-scaled) holds the lot flat
  // at full height; the squashed copy of the plinth hides inside it.
  _lotInfo(model) {
    if (!model || !Array.isArray(model.blocks) || !model.blocks.length) return null;
    const c = this._lotInfoCache || (this._lotInfoCache = new WeakMap());
    if (c.has(model)) return c.get(model);
    let info = null;
    const res = modelRes(model), L = Math.round(0.5 * res) - 1;   // top plinth layer
    const sx = model.sx | 0, sz = model.sz | 0;
    if (res >= 2 && L >= 0 && sx > 0 && sz > 0 && (model.sy | 0) > L + 1) {
      const top = new Uint8Array(sx * sz), low = [];
      for (const b of model.blocks) {
        if (!b || b[1] > L) continue;
        low.push(b);
        if (b[1] === L && b[0] >= 0 && b[0] < sx && b[2] >= 0 && b[2] < sz) top[b[2] * sx + b[0]] = 1;
      }
      let n = 0;
      for (let i = 0; i < top.length; i++) n += top[i];
      if (n >= 0.9 * sx * sz) {
        info = { h: (L + 1) / res, model: { sx, sy: L + 1, sz, res: model.res, blocks: low } };
      }
    }
    c.set(model, info);
    return info;
  }

  _growLot(mesh, s) {
    const base = mesh.userData.baseY != null ? mesh.userData.baseY : mesh.position.y;
    let lot = mesh.userData.growLot;
    const info = s < 0.999 || s > 1.001 ? this._lotInfo(mesh.userData.voxModel) : null;
    if (!info) {
      if (lot) { mesh.remove(lot); mesh.userData.growLot = null; }
      mesh.position.y = base;
      return;
    }
    if (!lot) {
      lot = this._viewMesh(info.model);
      lot.castShadow = true;
      lot.receiveShadow = true;
      mesh.add(lot);
      mesh.userData.growLot = lot;
    }
    const pivot = info.h - 0.01;           // just under the lot top: no z-fight
    mesh.position.y = base + pivot * (1 - s);
    lot.scale.y = 1 / s;
    lot.position.y = -pivot * (1 - s) / s;  // world y of the lot = base + y
  }

  removeBuilding(id) {
    const mesh = this._buildings.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    this._buildings.delete(id);
  }

  addProp(kind, model, x, z) {
    const key = kind + ':' + x + ':' + z;
    const existing = this._props.get(key);
    if (existing) this.scene.remove(existing);
    const mesh = this._viewMesh(model);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // ground r10: a tree on a raised lawn plinth stands on its top.
    // coherence 09-25: model.yOffset lowers a prop authored from below ground
    // (the bridge deck's piers stand in the recessed water basin).
    mesh.userData.yOff = (model && Number.isFinite(model.yOffset)) ? model.yOffset : 0;
    mesh.position.set((x + 0.5) * TILE, this._lawnLift(x, z) + mesh.userData.yOff, (z + 0.5) * TILE);
    this.scene.add(mesh);
    this._props.set(key, mesh);
  }

  // ground r10: terrain.js raises open lawn the town closes in on to lot height.
  _lawnLift(x, z) {
    const t = this._terrain;
    return t && t.lawnLift ? t.lawnLift(x, z) : 0;
  }

  // Re-seat the 1x1 props (sim trees) after a terrain refresh: a road can
  // close (or open) a lawn region anywhere, which raises (or lowers) its tiles.
  _reseatProps() {
    for (const [key, mesh] of this._props) {
      const p = key.split(':');
      const y = this._lawnLift(+p[1], +p[2]) + (mesh.userData.yOff || 0);
      if (mesh.position.y !== y) { mesh.position.y = y; mesh.updateMatrixWorld && mesh.updateMatrixWorld(); }
    }
  }

  removeProp(kind, x, z) {
    const key = kind + ':' + x + ':' + z;
    const mesh = this._props.get(key);
    if (!mesh) return;
    this.scene.remove(mesh);
    this._props.delete(key);
  }

  // Small movable object (car/person/bird/cloud). Shares cached geometry.
  makeDynamic(model) {
    // Dynamics only yaw about +Y and cast nothing: the view geometry is exact.
    // They stay on per-vertex AO: tiny meshes, and the atlas is kept for the
    // static city (it is where the triangles are).
    const geo = this._getViewGeometry(model, true);
    const mesh = new THREE.Mesh(geo, this._voxMat);
    mesh.castShadow = false;   // keep the shadow pass cheap (many dynamics)
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.userData.voxModel = model;
    mesh.userData.lodDyn = true;
    const dyn = this._dynMeshes || (this._dynMeshes = new Set());
    dyn.add(mesh);
    this._lodAssign(mesh);
    // life r12: model.blobs (optional) = soft dark CONTACT SHADOWS under the
    // vehicles / people (dynamics cast no sun shadow and get no AO, so a car
    // floated on the asphalt). Every blob is one instance of a shared
    // InstancedMesh (hundreds of agents = one draw call). See _blobAlloc.
    const bl = model && Array.isArray(model.blobs) ? model.blobs : null;
    const blobs = [];
    if (bl) for (const b of bl) { const h = this._blobAlloc(b); if (h) blobs.push(h); }
    this.scene.add(mesh);
    const scene = this.scene;
    return {
      setPos(x, y, z) { mesh.position.set(x, y, z); for (const b of blobs) b.pos(x, y, z); },
      setRot(yRad) { mesh.rotation.y = yRad; for (const b of blobs) b.rot(yRad); },
      setVisible(v) { mesh.visible = !!v; for (const b of blobs) b.show(!!v); },
      dispose() { scene.remove(mesh); dyn.delete(mesh); for (const b of blobs) b.free(); blobs.length = 0; },
    };
  }

  // life r12: contact-shadow blobs. model.blobs = [[x, z, w, l, y, a], ...] in
  // model-local WORLD units (x/z centre, w along X, l along Z, y above the
  // model base, a = core opacity 0..1, default 0.6). Each is a 9-slice quad:
  // the footprint at full opacity fading to 0 over 0.2 units outside it
  // (vertex alpha, no texture). Transparent + no depth write, so the AO and
  // shadow passes skip it (lighting.js hides such overlays).
  // One instanced contact-shadow blob (see makeDynamic). Pools are keyed by
  // core opacity; each instance carries its footprint size (aBlob) and a
  // world transform (position + yaw). Hidden / freed slots get size 0.
  _blobAlloc(b) {
    const a = b[5] == null ? 0.6 : +b[5];
    const pools = this._blobPools || (this._blobPools = new Map());
    let P = pools.get(a);
    if (!P) {
      const CAP = 4096, F = 0.2;
      const pos = [], fade = [], col = [], index = [];
      const cs = [-0.5, -0.475, 0.475, 0.5], fs = [-F, 0, 0, F];
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        pos.push(cs[i], 0, cs[j]); fade.push(fs[i], fs[j]);
        col.push(1, 1, 1, i > 0 && i < 3 && j > 0 && j < 3 ? a : 0);
      }
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const q = j * 4 + i;
        index.push(q, q + 4, q + 1, q + 1, q + 4, q + 5);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
      geo.setIndex(index);
      const size = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2);
      size.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aBlob', size);
      const im = new THREE.InstancedMesh(geo, this._getBlobInstMaterial(), CAP);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0; im.frustumCulled = false; im.renderOrder = 2;
      im.castShadow = false; im.receiveShadow = false;
      this.scene.add(im);
      P = { im, size, free: [], next: 0, CAP };
      pools.set(a, P);
    }
    const slot = P.free.length ? P.free.pop() : (P.next < P.CAP ? P.next++ : -1);
    if (slot < 0) return null;
    if (slot + 1 > P.im.count) P.im.count = slot + 1;
    const bx = +b[0] || 0, bz = +b[1] || 0;
    const w = Math.max(0.02, +b[2] || 0), l = Math.max(0.02, +b[3] || 0), dy = (b[4] == null ? 0 : +b[4]) + 0.012;
    const M = P.im.instanceMatrix, E = M.array, o = slot * 16, S = P.size.array;
    let x = 0, y = 0, z = 0, yaw = 0, vis = false, live = true;
    const write = () => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      E[o] = c; E[o + 1] = 0; E[o + 2] = -s; E[o + 3] = 0;
      E[o + 4] = 0; E[o + 5] = 1; E[o + 6] = 0; E[o + 7] = 0;
      E[o + 8] = s; E[o + 9] = 0; E[o + 10] = c; E[o + 11] = 0;
      E[o + 12] = x + c * bx + s * bz; E[o + 13] = y + dy; E[o + 14] = z - s * bx + c * bz; E[o + 15] = 1;
      mark(M, 16);
    };
    // upload only the used slots (one range, grown in place until uploaded)
    const mark = (attr, k) => {
      const n = P.next * k, r = attr.updateRanges;
      if (!r.length) attr.addUpdateRange(0, n); else if (r[0].count < n) r[0].count = n;
      attr.needsUpdate = true;
    };
    const sz = () => { const on = vis && live; S[slot * 2] = on ? w : 0; S[slot * 2 + 1] = on ? l : 0; mark(P.size, 2); };
    write(); sz();
    return {
      pos(nx, ny, nz) { x = nx; y = ny; z = nz; write(); },
      rot(r) { yaw = r; write(); },
      show(v) { if (v !== vis) { vis = v; sz(); } },
      free() { if (!live) return; live = false; sz(); P.free.push(slot); },
    };
  }

  _getBlobInstMaterial() {
    if (!this._blobInstMat) {
      const m = new THREE.MeshBasicMaterial({
        color: 0x000000, vertexColors: true, transparent: true, depthWrite: false,
        fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      // footprint-sized 9-slice: the core scales with the instance's aBlob
      // (w, l); the fade ring (aFade) stays BLOB_FADE wide whatever the size
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = 'attribute vec2 aBlob;\nattribute vec2 aFade;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>',
          'vec3 transformed = vec3( position.x * aBlob.x + aFade.x * step( 0.001, aBlob.x ), position.y, position.z * aBlob.y + aFade.y * step( 0.001, aBlob.y ) );');
      };
      m.customProgramCacheKey = () => 'bv-blob-inst';
      this._blobInstMat = m;
    }
    return this._blobInstMat;
  }

  // Spinner: an animated part whose orientation is
  //   quat(baseYaw about world +Y) ∘ quat(normalized local axis, angle).
  // Shares the cached-geometry path of makeDynamic; per-frame allocation-free
  // (scratch quats/vectors are reused per handle).
  makeSpinner(model) {
    const geo = this._getGeometry(model);
    const mesh = new THREE.Mesh(geo, this._voxMat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    // Shared voxel geometry is bottom-center anchored; a spinner must pivot on
    // its TRUE center (a wheel spins on its hub). Parent the mesh in a group,
    // shifted down half its height, and rotate the group.
    const pivot = new THREE.Group();
    // Geometry is in WORLD units (voxel.js divides by model.res), so the
    // half-height is sy / res.
    mesh.position.y = -((model && model.sy) || 1) / (2 * modelRes(model));
    pivot.add(mesh);
    this.scene.add(pivot);
    const scene = this.scene;
    // Tracked so clearWorld() also drops spinners (a reseed without a full
    // visuals rebuild left ferris wheels / carousels floating in the new world).
    const pivots = this._spinPivots || (this._spinPivots = new Set());
    pivots.add(pivot);

    // Per-handle scratch — reused every frame, no allocation in setters.
    const qBase = new THREE.Quaternion();
    const qSpin = new THREE.Quaternion();
    const upY = new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3(1, 0, 0);
    let baseYaw = 0, ax = 1, ay = 0, az = 0, ang = 0;

    const apply = () => {
      qBase.setFromAxisAngle(upY, baseYaw);
      const len = Math.hypot(ax, ay, az) || 1;
      axis.set(ax / len, ay / len, az / len);
      qSpin.setFromAxisAngle(axis, ang);
      pivot.quaternion.multiplyQuaternions(qBase, qSpin);
    };
    apply();

    return {
      // Spinners belong to buildings, which stand on the lot plinth.
      setPos(x, y, z) { pivot.position.set(x, y + LOT_Y, z); },
      setBaseYaw(rad) { baseYaw = rad; apply(); },
      setSpin(nax, nay, naz, rad) { ax = nax; ay = nay; az = naz; ang = rad; apply(); },
      setVisible(b) { pivot.visible = !!b; },
      dispose() { scene.remove(pivot); pivots.delete(pivot); },
    };
  }

  // Remove ALL building + prop meshes from the scene and clear their registries,
  // and hide the ghost. The shared geometry cache (WeakMap) is intentionally NOT
  // disposed — geometries are reused after a rebuild. Ground chunks stay (buildGround
  // rebuilds them).
  clearWorld() {
    for (const mesh of this._buildings.values()) this.scene.remove(mesh);
    this._buildings.clear();
    for (const mesh of this._props.values()) this.scene.remove(mesh);
    this._props.clear();
    if (this._spinPivots) { for (const p of this._spinPivots) this.scene.remove(p); this._spinPivots.clear(); }
    if (this._ghostMesh) this._ghostMesh.visible = false;
  }

  // ---------------------------------------------------------------------------
  // Ghost preview
  // ---------------------------------------------------------------------------

  setGhost(model, x, z, ok, rot = 0) {
    if (!model) {
      if (this._ghostMesh) this._ghostMesh.visible = false;
      return;
    }
    const geo = this._getGeometry(model);
    if (!this._ghostMesh) {
      this._ghostMesh = new THREE.Mesh(geo, this._ghostMat);
      this._ghostMesh.castShadow = false;
      this._ghostMesh.receiveShadow = false;
      this.scene.add(this._ghostMesh);
    } else {
      this._ghostMesh.geometry = geo;
    }
    // model.parts (see addBuilding): ghost them too, reusing child meshes
    const parts = Array.isArray(model.parts) ? model.parts : [];
    const kids = this._ghostMesh.children;
    while (kids.length > parts.length) this._ghostMesh.remove(kids[kids.length - 1]);
    parts.forEach((p, i) => {
      const pg = this._getGeometry(p);
      if (kids[i]) kids[i].geometry = pg;
      else { const c = new THREE.Mesh(pg, this._ghostMat); c.castShadow = false; c.receiveShadow = false; this._ghostMesh.add(c); }
    });
    this._ghostMat.color.setHex(ok ? 0x66ff88 : 0xff6b6b);
    const tw = model.tw || 1, td = model.td || 1;
    const etw = (rot % 2) ? td : tw, etd = (rot % 2) ? tw : td;
    this._ghostMesh.position.set((x + etw / 2) * TILE, LOT_Y + 0.02, (z + etd / 2) * TILE);
    this._ghostMesh.rotation.y = (rot || 0) * Math.PI / 2;
    this._ghostMesh.visible = true;
    // surface: depth pre-pass so only the front-most ghost surface is tinted
    if (this._matLib && this._matLib.prepGhost) this._matLib.prepGhost(this._ghostMesh);
  }

  // ---------------------------------------------------------------------------
  // Flat tile-quad markers (placement feedback + road path preview)
  // ---------------------------------------------------------------------------

  // Shared TILE×TILE quad lying flat (facing +Y). Baked so meshes need no rot.
  _getCellGeo() {
    if (!this._cellGeo) {
      this._cellGeo = new THREE.PlaneGeometry(TILE, TILE);
      this._cellGeo.rotateX(-Math.PI / 2);
    }
    return this._cellGeo;
  }

  _makeCellQuad(hex, opacity) {
    const mat = new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity, depthWrite: false,
      fog: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this._getCellGeo(), mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.scene.add(mesh);
    return mesh;
  }

  // Grab a free flash quad, growing the pool up to `cap`; null when full.
  _acquireFlashQuad(cap) {
    const pool = this._flashQuads;
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) return pool[i];
    }
    if (pool.length >= cap) return null;
    const mesh = this._makeCellQuad(0xffffff, 0);
    mesh.visible = false;
    const q = { mesh, mat: mesh.material, active: false, life: 0, ms: 1, startOpacity: 0.6 };
    pool.push(q);
    return q;
  }

  // Touch-friendly failed-placement feedback: flat translucent tile quads at
  // y≈0.05 (green if ok else red) that fade to 0 over `ms` then hide. Pooled
  // (cap 32); the fade advances in render(dt).
  flashCells(cells, ok = false, ms = 650) {
    if (!Array.isArray(cells) || cells.length === 0) return;
    const hex = ok ? 0x66ff88 : 0xff5a5a;
    const dur = Math.max(1, ms);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell) continue;
      const q = this._acquireFlashQuad(32);
      if (!q) break;   // pool exhausted this burst
      q.mat.color.setHex(hex);
      q.startOpacity = 0.6;
      q.mat.opacity = 0.6;
      q.life = dur;
      q.ms = dur;
      q.active = true;
      q.mesh.position.set((cell.x + 0.5) * TILE, this._cellY(cell.x, cell.z), (cell.z + 0.5) * TILE);
      q.mesh.visible = true;
    }
  }

  // Advance the flash fades (called from render). No allocation.
  _animateFlash(d) {
    const pool = this._flashQuads;
    const ms = d * 1000;
    for (let i = 0; i < pool.length; i++) {
      const q = pool[i];
      if (!q.active) continue;
      q.life -= ms;
      if (q.life <= 0) {
        q.active = false;
        q.mat.opacity = 0;
        q.mesh.visible = false;
      } else {
        q.mat.opacity = q.startOpacity * (q.life / q.ms);
      }
    }
  }

  // Persistent translucent tile markers for the ROAD drag path preview
  // (steady ~0.4 opacity). Passing null/empty hides them all. Pooled &
  // reused; separate from the single-model setGhost.
  setGhostCells(cells, ok = true) {
    const pool = this._ghostCellQuads;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
      for (let i = 0; i < pool.length; i++) pool[i].visible = false;
      return;
    }
    const hex = ok ? 0x66ff88 : 0xff5a5a;
    let n = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell) continue;
      let mesh = pool[n];
      if (!mesh) {
        mesh = this._makeCellQuad(hex, 0.4);
        pool[n] = mesh;
      }
      mesh.material.color.setHex(hex);
      mesh.material.opacity = 0.4;
      mesh.position.set((cell.x + 0.5) * TILE, this._cellY(cell.x, cell.z), (cell.z + 0.5) * TILE);
      mesh.visible = true;
      n++;
    }
    for (let i = n; i < pool.length; i++) pool[i].visible = false;
  }

  // ---------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------

  // Ground is now three cooperating modules (see CONTRACTS-RENDER.md):
  //   terrain -> grass/sand/rock/banks + the opaque seabed under water
  //   roads   -> asphalt, markings, sidewalks, curbs (covers ROAD tiles at y>=0.02)
  //   water   -> the opaque surface at y=-1.85 over WATER/bridge tiles
  buildGround(state) {
    this._terrain.build(state);
    this._roadAnchors = this._roads.build(state);
    this._water.buildSurface(state);
    this._propFX.setAnchors(this._roadAnchors);
    this._propFX.scatter(state);
    if (this._lighting && this._lighting.setLampAnchors) {
      this._lighting.setLampAnchors(this._roadAnchors.filter((a) => a.kind === 'lamp'));
    }
  }

  // Overlay height for a tile: just above whatever lot top terrain drew there.
  _cellY(x, z) {
    const t = this._terrain;
    return (t && t.cellTopY ? Math.max(LOT_Y, t.cellTopY(x, z)) : LOT_Y) + 0.1;
  }

  refreshTile(state, x, z) {
    this._terrain.refreshTile(state, x, z);
    this._reseatProps();
    this._roadAnchors = this._roads.refreshTile(state, x, z) || this._roadAnchors;
    this._water.refreshTiles(state, x, z);
    // Roads are almost always painted tile-by-tile through here, not through
    // buildGround (which only runs at reseed, when there are zero road tiles).
    // Without this the lighting rig was fed an empty lamp list forever and the
    // streets rendered pitch black at night despite 88 lamp anchors existing.
    this._lampsDirty = true;
  }

  // Emissive windows were decoration only — a tower with a blazing facade lit
  // nothing around it, because LightingRig.setWindowGlows() had no callers.
  // materials.js can mirror its own shader hash on the CPU and tell us exactly
  // which panes it lit; recomputing costs ~26ms for 467 glows, so only redo it
  // when the building set changes or we cross into/out of night.
  _syncWindowGlows(ctx) {
    if (!this._lighting.setWindowGlows || !this._matLib.windowGlowsFor) return;
    const lit = ctx.nightEff > 0.25;
    if (!this._glowsDirty && lit === this._glowsLit) return;
    this._glowsDirty = false;
    this._glowsLit = lit;
    const glows = lit ? this._matLib.windowGlowsFor(this.scene) : [];
    // CONTRACT MISMATCH between two modules, bridged here (the integration
    // point) rather than in either of them: materials.js emits `color` as a
    // LINEAR [r,g,b] array, lighting.js consumes it with setHex(). An array
    // coerces to 0, so all 467 window glows rendered pure black and additive
    // blending of black is a no-op — the lights were "wired" but dead.
    // lighting.js decodes the hex with SRGBColorSpace, so the linear values
    // must be sRGB-ENCODED on the way in or they round-trip too dark.
    const enc = (c) => {
      c = clamp(c, 0, 1);
      const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.round(s * 255);
    };
    for (const g of glows) {
      if (Array.isArray(g.color)) {
        g.color = (enc(g.color[0]) << 16) | (enc(g.color[1]) << 8) | enc(g.color[2]);
      }
    }
    this._lighting.setWindowGlows(glows);
    // Feed the same data to the sky as a horizon sodium glow, so a big lit city
    // actually brightens the night sky above it.
    if (this._sky.setCityGlow) {
      let gx = 0, gz = 0, w = 0;
      for (const g of glows) { const i = g.intensity || 1; gx += g.x * i; gz += g.z * i; w += i; }
      this._sky.setCityGlow(w > 0
        ? { x: gx / w, z: gz / w, amount: Math.min(1, glows.length / 900) }
        : { x: CENTER, z: CENTER, amount: 0 });
    }
  }

  // Coalesced to once per frame — a road drag calls refreshTile per tile.
  _syncLampAnchors() {
    if (!this._lampsDirty || !this._lighting.setLampAnchors) return;
    this._lampsDirty = false;
    this._propFX.setAnchors(this._roadAnchors);
    this._lighting.setLampAnchors(this._roadAnchors.filter((a) => a.kind === 'lamp'));
  }

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------

  _rayToGround(clientX, clientY, out) {
    const rect = this._canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const cam = this.camera;
    if (cam.isOrthographicCamera) {
      // Parallel ray from the NEAR plane (not the camera plane, which is what
      // Raycaster.setFromCamera uses — with a negative near that can start
      // below the ground and miss it).
      const r = this._ray.ray;
      r.origin.set(this._ndc.x, this._ndc.y, -1).unproject(cam);
      r.direction.set(0, 0, -1).transformDirection(cam.matrixWorld);
    } else {
      this._ray.setFromCamera(this._ndc, cam);
    }
    return !!this._ray.ray.intersectPlane(this._groundPlane, out);
  }

  screenToTile(clientX, clientY) {
    if (!this._rayToGround(clientX, clientY, this._tmpHit)) return null;
    const x = Math.floor(this._tmpHit.x / TILE);
    const z = Math.floor(this._tmpHit.z / TILE);
    if (x < 0 || z < 0 || x >= N || z >= N) return null;
    return { x, z };
  }

  // ---------------------------------------------------------------------------
  // Input (pointer events: mouse + touch)
  // ---------------------------------------------------------------------------

  attachInput(domElement) {
    const el = domElement || this._canvas;
    this._input = el;
    el.style.touchAction = 'none'; // stop iPad scroll/bounce

    const down = (e) => {
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
      if (this._pointers.size >= 2) { this._pinchDist = null; this._pinchAng = null; }
      e.preventDefault();
    };

    const move = (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const px = p.x, py = p.y;
      p.x = e.clientX; p.y = e.clientY;

      if (this._pointers.size === 1) {
        const rotate = (p.button === 2) || e.ctrlKey;
        if (rotate) {
          // Right-drag / ctrl-drag: horizontal travel accumulates toward a
          // 90-degree snap (one step per ~90 px). Elevation is fixed (true iso).
          this._rotAccum += (e.clientX - px);
          if (Math.abs(this._rotAccum) >= 90) {
            this.rotateStep(this._rotAccum > 0 ? -1 : 1);
            this._rotAccum = 0;
          }
        } else {
          this._panBy(px, py, e.clientX, e.clientY);
        }
      } else if (this._pointers.size === 2) {
        this._twoPointer();
      }
      e.preventDefault();
    };

    const up = (e) => {
      el.releasePointerCapture && el.releasePointerCapture(e.pointerId);
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) { this._pinchDist = null; this._pinchAng = null; }
      if (this._pointers.size === 0) this._rotAccum = 0;
      e.preventDefault();
    };

    const wheel = (e) => {
      this.zoomBy(Math.pow(1.0015, e.deltaY));
      e.preventDefault();
    };

    // Keyboard camera: Q / E rotate 90 degrees, + / - zoom. (Arrow keys are
    // main.js's tile cursor and are left alone.)
    const key = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'q' || k === 'Q') { this.rotateStep(-1); e.preventDefault(); }
      else if (k === 'e' || k === 'E') { this.rotateStep(1); e.preventDefault(); }
      else if (k === '+' || k === '=') { this.zoomBy(1 / 1.25); e.preventDefault(); }
      else if (k === '-' || k === '_') { this.zoomBy(1.25); e.preventDefault(); }
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('keydown', key);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Pan so the grabbed ground point stays anchored under the pointer.
  _panBy(prevX, prevY, curX, curY) {
    if (!this._rayToGround(prevX, prevY, this._panA)) return;
    if (!this._rayToGround(curX, curY, this._panB)) return;
    this._camTarget.x += this._panA.x - this._panB.x;
    this._camTarget.z += this._panA.z - this._panB.z;
    // Keep the target within the map plus a MAP_W-derived margin (~1/8 of the map).
    const panMargin = MAP_W * 0.125;
    this._camTarget.x = clamp(this._camTarget.x, -panMargin, MAP_W + panMargin);
    this._camTarget.z = clamp(this._camTarget.z, -panMargin, MAP_W + panMargin);
  }

  panScreen(prevX, prevY, curX, curY) {
    this._panBy(prevX, prevY, curX, curY);
  }

  // ---- iso camera controls -------------------------------------------------
  // Largest useful zoom-out: the whole 80x80 map (its diagonal runs across the
  // screen in iso) fits with a small margin, at the current aspect.
  _zoomMax() {
    const diag = MAP_W * Math.SQRT2 * 1.06;
    const hFit = (diag * 0.5) / Math.max(0.2, this._aspect);          // width-limited
    const vFit = (diag * Math.sin(Math.PI / 2 - ISO_POLAR) * 0.5 + 40) * 1.06; // height-limited
    return Math.max(380, Math.max(hFit, vFit) / ISO_TAN_HALF);
  }

  _clampZoom(d) { return clamp(d, ISO_ZOOM_MIN, this._zoomMax()); }

  // Multiply the zoom (camDist-equivalent) by `f` (>1 zooms out).
  zoomBy(f) {
    if (!(f > 0)) return;
    this._camDist = this._clampZoom(this._camDist * f);
  }

  // Rotate the view one 90-degree step (dir = +1 / -1). The damped camera in
  // render() eases the smoothed azimuth to the new snap over ~0.3 s.
  rotateStep(dir) {
    const k = Math.round((this._camAz - ISO_AZ0) / ISO_STEP) + (dir < 0 ? -1 : 1);
    this._camAz = ISO_AZ0 + k * ISO_STEP;
  }

  // Current view: target tile-space centre, zoom and 0..3 rotation index.
  getView() {
    const k = Math.round((this._camAz - ISO_AZ0) / ISO_STEP);
    return {
      x: this._camTarget.x / TILE - 0.5, z: this._camTarget.z / TILE - 0.5,
      zoom: this._camDist, rot: ((k % 4) + 4) % 4,
      zoomMin: ISO_ZOOM_MIN, zoomMax: this._zoomMax(),
    };
  }

  // Gently frame a tile or neighborhood. Main uses this for "find my city"
  // and for missions whose target (such as the river) may begin off-screen.
  focusAt(x, z, distance) {
    const tx = clamp((Number(x) + 0.5) * TILE, 0, MAP_W);
    const tz = clamp((Number(z) + 0.5) * TILE, 0, MAP_W);
    this._camTarget.set(tx, 0, tz);
    if (Number.isFinite(distance)) this._camDist = this._clampZoom(clamp(distance, 45, 300));
  }

  _twoPointer() {
    let a = null, b = null;
    for (const p of this._pointers.values()) { if (!a) a = p; else if (!b) b = p; }
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    if (this._pinchDist == null) { this._pinchDist = dist; this._pinchAng = ang; return; }
    if (dist > 0) this.zoomBy(this._pinchDist / dist);
    // Two-finger twist accumulates toward a 90-degree snap (~26 degrees).
    let da = ang - this._pinchAng;
    if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
    this._rotAccum += da;
    if (Math.abs(this._rotAccum) >= 0.45) {
      this.rotateStep(this._rotAccum > 0 ? 1 : -1);
      this._rotAccum = 0;
    }
    this._pinchDist = dist;
    this._pinchAng = ang;
  }

  // ---------------------------------------------------------------------------
  // Day / night
  // ---------------------------------------------------------------------------

  // "Always bright" lock. When on, setNight uses a capped effective darkness so
  // the city stays legible at night/rain. Stores the flag and re-applies the
  // last requested day/night value immediately.
  setDaylightLock(on) {
    this._daylightLock = !!on;
    this.setNight(this._nightT);
  }

  setNight(t) {
    t = clamp(t, 0, 1);
    this._nightT = t;   // remember the RAW request so re-applies (weather/lock) work.
    // Effective darkness: capped when "Always bright" is locked.
    const te = this._daylightLock ? Math.min(t, 0.12) : t;
    this._nightUniform.value = te;
    // The sky module is the authority on sun position/colour, fog and fill
    // light — it recomputes them from ctx.nightEff during render(). Nothing
    // more to do here; _applySkyLighting() below consumes its output.
  }

  // Copy one frame of the sky's analytic lighting solution onto the scene's
  // lights and fog. `s` is sky.update()'s return value — it is reused every
  // frame by sky.js, so read it immediately and never retain it.
  _applySkyLighting(s) {
    if (!s) return;
    // Follow the camera target so the (now much tighter) shadow frustum stays
    // over whatever the player is looking at instead of the fixed map centre.
    const fx = this._sTarget.x, fz = this._sTarget.z;
    this._sunTarget.position.set(fx, 0, fz);
    // MUST be keyDir, not sunDir. sunDir is the true SOLAR vector, which at
    // night is ~60 degrees BELOW the map — positioning the scene's directional
    // light from it buried the key light 430 units underground and contributed
    // exactly nothing (measured: zeroing sun.intensity changed the night frame
    // mean by 0.009/255). keyDir is the sun by day and the MOON by night.
    // This also runs after _lighting.update(), so it overwrites the rig's own
    // correct placement — it has to be right here.
    const k = s.keyDir || s.sunDir;
    this.sun.position.set(fx + k.x * 500, k.y * 500, fz + k.z * 500);
    // Physical solution (dusk / night / weather) blended onto sky.js's
    // AUTHORED daytime key + fill by `artAmount` (see sky.js "DAYTIME ART
    // DIRECTION"). The physical noon was an orange key (1.00,0.75,0.40) over a
    // saturated Rayleigh-blue fill — the blue-grey murk. The authored values
    // are already in final units; only the physical side takes the gains.
    // Assign through .r/.g/.b: hemi/ambient colours are accessors owned by
    // lighting.js's skylight grade, which must see plain writes.
    const a = s.artAmount || 0;
    const lerpC = (dst, A, B) => {
      dst.r = A.r + (B.r - A.r) * a; dst.g = A.g + (B.g - A.g) * a; dst.b = A.b + (B.b - A.b) * a;
    };
    if (a > 0 && s.keyColor) {
      lerpC(this.sun.color, s.sunColor, s.keyColor);
      lerpC(this.hemi.color, s.skyColor, s.fillSky);
      lerpC(this.hemi.groundColor, s.groundColor, s.fillGround);
      lerpC(this.ambient.color, s.ambientColor, s.fillAmbient);
    } else {
      this.sun.color.copy(s.sunColor);
      this.hemi.color.copy(s.skyColor);
      this.hemi.groundColor.copy(s.groundColor);
      this.ambient.color.copy(s.ambientColor);
    }
    // sky.js's physical mix is fill-dominant, which flattens cast shadows into
    // a faint tint: measured light budget at noon was sun ~10%, hemi+ambient
    // ~13%, sky env ~44%. Rebalance toward the key light so shadows read as
    // shapes.
    const pSun = s.intensity * SUN_GAIN;
    const pHemi = s.hemiIntensity * FILL_GAIN;
    const pAmb = s.ambientIntensity * FILL_GAIN;
    this.sun.intensity = pSun + ((s.keyIntensity != null ? s.keyIntensity : pSun) - pSun) * a;
    // _fillScale: one global multiplier on all daytime fill (hemi, ambient,
    // material sky fill) for face-separation tuning (coordinator, faceprobe.js).
    const fs = this._fillScale != null ? this._fillScale : FILL_SCALE;
    this.hemi.intensity = (pHemi + ((s.fillHemiIntensity != null ? s.fillHemiIntensity : pHemi) - pHemi) * a) * fs;
    this.ambient.intensity = (pAmb + ((s.fillAmbientIntensity != null ? s.fillAmbientIntensity : pAmb) - pAmb) * a) * fs;
    // Light r8: directional wall fill (lighting.js csmWallFill) rides the same
    // daytime art blend — the far wall gets the dim half of the sky by day,
    // dusk/night/overcast keep the symmetric physical fill.
    if (this._lighting.setWallFillAmount) this._lighting.setWallFillAmount(a);
    // materials.js's flat sky fill rides the same daytime art blend (see
    // DAY_SKYFILL_SCALE). Scaled from ITS configured value so its owner's
    // tuning still applies; guarded so a material library without it is fine.
    const ml = this._matLib;
    if (ml && ml.uniforms && ml.uniforms.uSkyFill && ml._params && ml._params.skyFill != null) {
      ml.uniforms.uSkyFill.value = ml._params.skyFill * (1 + (DAY_SKYFILL_SCALE - 1) * a) * fs;
    }
    if (ml && ml.uniforms && ml.uniforms.uBounce && ml._params && Array.isArray(ml._params.bounce)) {
      ml.uniforms.uBounce.value.x = ml._params.bounce[0] * (1 + (DAY_BOUNCE_SCALE - 1) * a);
    }
    // Light r7: voxel faces take lighting.js's (rewritten, map-space) contact
    // AO too — the wall-to-plinth / prop-to-paving line crosses two meshes'
    // worth of geometry the baked per-model voxel AO cannot see. Floor at
    // materials' own value so its owner can still raise it.
    if (ml && ml.uniforms && ml.uniforms.uWorldAOKeep && ml._params) {
      ml.uniforms.uWorldAOKeep.value = Math.max(ml._params.worldAOKeep || 0, VOXEL_WORLD_AO_KEEP);
    }
    // Horizon sample, so terrain never fades to a colour the sky isn't.
    this.fog.color.copy(s.fogColor);
    // Fog was fixed at near=352/far=1184 while the hero camera sits at 150 —
    // nothing in frame was ever beyond `near`, so aerial perspective was
    // mathematically inactive at every shot distance. Scale it to the orbit so
    // distance always reads as distance.
    // Ortho iso camera: zoom can now exceed the old 380 orbit cap (whole-map
    // view), and the camera sits exactly `d` from the target along the view
    // axis, so keep the fog profile RELATIVE TO THE TARGET: identical to the
    // old formula up to d = 380, then shifted back with the target beyond it.
    //
    // Art direction: NO aerial haze at gameplay zooms — the reference is a
    // flat orthographic diorama where nothing recedes. With the ortho iso
    // camera, everything in frame sits within ~one view-height of the target
    // depth `d`, so the fog now starts well BEHIND anything visible and only
    // ever reaches the far terrain skirt past the map edge (which still wants
    // to dissolve into the dome rather than end on a hard line).
    const d = this._sDist;
    this.fog.near = d + MAP_W * 0.55;
    this.fog.far = this.fog.near + MAP_W * 1.2;
    // Water reflects the sky it actually sits under.
    this._water.setSky({
      skyTop: s.skyColor, skyHorizon: s.fogColor, sunColor: s.sunColor,
    });
  }

  // ---------------------------------------------------------------------------
  // Weather (seasonal ground tint + rain/snow precipitation)
  // ---------------------------------------------------------------------------

  // tint: [r,g,b] multipliers (~0.7..1.2) for the ground colouring.
  // rain, snow ∈ 0..1: one precipitation mode (whichever intensity > 0).
  setWeather(opts) {
    opts = opts || {};
    const tint = opts.tint;
    if (Array.isArray(tint)) {
      const r = (typeof tint[0] === 'number') ? tint[0] : 1;
      const g = (typeof tint[1] === 'number') ? tint[1] : 1;
      const b = (typeof tint[2] === 'number') ? tint[2] : 1;
      this._seasonUniform.value.set(r, g, b);
    }
    const rain = clamp(opts.rain || 0, 0, 1);
    const snow = clamp(opts.snow || 0, 0, 1);

    // Rain grays the sky; re-apply the day/night+weather sky composition.
    this._weatherGray = rain * 0.35;
    this.setNight(this._nightT);
    this._ctx.weather.rain = rain;
    this._ctx.weather.snow = snow;
    if (Array.isArray(tint)) this._ctx.weather.tint = tint;
    this._sky.setWeather({ rain, snow });
    this._terrain.setWeather({ tint, rain, snow });
    this._roads.setWeather({ tint, rain, snow });
    // coherence 09-25: buildings, lots and props take the snow too (they were
    // the only pieces that stayed summer-green on a white ground).
    if (this._matLib && this._matLib.setSnow) this._matLib.setSnow(snow);
    if (this._propFX && this._propFX.setSnow) this._propFX.setSnow(snow);

    // Only one precipitation mode active at a time.
    let mode = null, intensity = 0;
    if (rain > 0) { mode = 'rain'; intensity = rain; }
    else if (snow > 0) { mode = 'snow'; intensity = snow; }
    this._setPrecip(mode, intensity);
  }

  _ensurePrecip() {
    if (this._precip) return;
    const max = 600;
    const geo = new THREE.BoxGeometry(1, 1, 1);   // unit box; per-instance scale bakes the shape
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, fog: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.frustumCulled = false;   // it follows the camera target, always in view
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    this.scene.add(mesh);

    // Spawn radius scales with the map so precipitation fills the wider view.
    const radius = MAP_W * 0.3;   // ≈154 at N=64
    const offX = new Float32Array(max), offY = new Float32Array(max),
          offZ = new Float32Array(max), phase = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      offX[i] = (Math.random() * 2 - 1) * radius;
      offZ[i] = (Math.random() * 2 - 1) * radius;
      offY[i] = Math.random() * 60;
      phase[i] = Math.random() * Math.PI * 2;
    }
    this._precip = {
      mesh, mat, geo, max, offX, offY, offZ, phase,
      radius, wrap: radius * 2,
      scale: new THREE.Vector3(0.08, 2.2, 0.08),
      mat4: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
    };
  }

  _setPrecip(mode, intensity) {
    if (!mode || intensity <= 0) {
      // Hidden -> zero per-frame cost.
      if (this._precip) this._precip.mesh.visible = false;
      this._precipMode = null;
      this._precipIntensity = 0;
      return;
    }
    this._ensurePrecip();
    const p = this._precip;
    this._precipMode = mode;
    this._precipIntensity = intensity;
    if (mode === 'rain') {
      p.scale.set(0.08, 2.2, 0.08);
      p.mat.color.setHex(0x9fb3c8);   // slight blue-gray
      p.mat.opacity = 0.55;
    } else {
      p.scale.set(0.5, 0.5, 0.5);
      p.mat.color.setHex(0xffffff);   // white flakes
      p.mat.opacity = 0.9;
    }
    // Count scales with intensity.
    p.mesh.count = Math.max(1, Math.min(p.max, Math.round(p.max * intensity)));
    p.mesh.visible = true;
    p.mesh.instanceMatrix.needsUpdate = true;
  }

  // Allocation-free precipitation step (reuses matrix/vector scratch).
  _animatePrecip(d) {
    const p = this._precip;
    if (!p || !p.mesh.visible || !this._precipMode) return;
    this._precipTime += d;
    const t = this._precipTime;
    const cx = this._sTarget.x, cz = this._sTarget.z;
    const rain = this._precipMode === 'rain';
    const vy = rain ? 55 : 6;         // fall speed
    const slant = rain ? 8 : 0;       // rain sideways slant (u/s)
    const count = p.mesh.count;
    const mat = p.mat4, pos = p.pos, scale = p.scale, q = this._identityQuat;
    const offX = p.offX, offY = p.offY, offZ = p.offZ, phase = p.phase;
    const rad = p.radius, wrap = p.wrap;

    for (let i = 0; i < count; i++) {
      let y = offY[i] - vy * d;
      let x = offX[i];
      let z = offZ[i];
      if (rain) {
        x += slant * d;
      } else {
        x += Math.sin(t * 1.5 + phase[i]) * 6 * d;   // sinusoidal sideways drift
      }
      if (y < 0) {                                    // recycle to the top
        y += 60;
        x = (Math.random() * 2 - 1) * rad;
        z = (Math.random() * 2 - 1) * rad;
      }
      if (x > rad) x -= wrap; else if (x < -rad) x += wrap;
      if (z > rad) z -= wrap; else if (z < -rad) z += wrap;
      offX[i] = x; offY[i] = y; offZ[i] = z;
      pos.set(cx + x, y, cz + z);
      mat.compose(pos, q, scale);
      p.mesh.setMatrixAt(i, mat);
    }
    p.mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------

  render(dt) {
    this._governor(dt);
    const d = clamp(dt || 0, 0, 0.1);
    const k = Math.min(1, d * 10);

    // Damp camera toward goals.
    this._sTarget.lerp(this._camTarget, k);
    this._sDist += (this._camDist - this._sDist) * k;
    this._sAz += (this._camAz - this._sAz) * k;
    this._sPolar += (this._camPolar - this._sPolar) * k;

    this._applyCamera();
    this._updateLod();

    // Water animation.
    this._waterUniform.value += d;

    // Precipitation (no-op when hidden).
    this._animatePrecip(d);

    // Placement-feedback quad fades (no-op when none active).
    this._animateFlash(d);

    // ---- Shared per-frame context (see CONTRACTS-RENDER.md §2) -------------
    this._elapsed += d;
    const ctx = this._ctx;
    ctx.time = this._elapsed;
    ctx.dt = d;
    ctx.nightT = this._nightT;
    ctx.nightEff = this._daylightLock ? Math.min(this._nightT, 0.12) : this._nightT;
    ctx.camDist = this._sDist;
    ctx.quality = this._quality;

    // Sky first — it owns the sun, so everything downstream reads a settled
    // sunDir. Then push its solution onto the lights/fog/water.
    if (this._sky.setSunFrame) {
      const ko = this._keyAzOffset != null ? this._keyAzOffset : KEY_AZ_OFFSET;
      const ke = this._keyElevation != null ? this._keyElevation : KEY_ELEVATION;
      this._sky.setSunFrame(this._sAz + ko, ke);
    }
    const skyOut = this._sky.update(d, ctx);
    if (skyOut) ctx.sunDir.copy(skyOut.sunDir);
    else ctx.sunDir.copy(this.sun.position).sub(this._sunTarget.position).normalize();

    // Cascaded shadows. This renders depth passes, so it must not run inside
    // another render — it is deliberately before post.render() below.
    this._syncLampAnchors();
    this._propFX.update(d, ctx);
    if (skyOut && skyOut.keyDir) ctx.sunDir.copy(skyOut.keyDir);
    if (skyOut && skyOut.skylightWarmth != null && this._lighting.setParams) {
      // One source of truth for the low-sun warm ramp, shared by sky and lights.
      // Light wave-2 r1: while sky.js's authored rig is active (now through
      // golden hour) the fill hue is authored (cool at dusk); lighting.js's
      // warm re-grade of hemi/ambient/IBL on top of it was the salmon wash
      // on every shade face (coherence #5). Keep only a trace of it there.
      const artA = skyOut.artAmount || 0;
      this._lighting.setParams({ skylightWarmth: skyOut.skylightWarmth * 0.62 * (1 - 0.85 * artA) });
    }
    this._lighting.setSunDirection(ctx.sunDir);
    this._lighting.update(d, ctx);

    // Apply the sky's analytic colours AFTER the rig, so the light that hits
    // the city matches the dome the player can actually see.
    if (skyOut) this._applySkyLighting(skyOut);

    // Feed the material library the sky's own solution: without this its
    // rim/fill uniforms stay a fixed daytime blue even at midnight.
    if (this._matLib.setSkyLight) {
      this._matLib.setSkyLight({
        skyColor: this.hemi.color,
        groundColor: this.hemi.groundColor,
      });
    }
    this._syncWindowGlows(ctx);

    this._terrain.update(d, ctx);
    this._roads.update(d, ctx);
    this._water.update(d, ctx);
    this._matLib.update(d, ctx);

    // PostFX owns the scene pass — it renders the scene into its own HDR target
    // and composites to the canvas, so we must NOT call renderer.render() here.
    this._post.render(d, ctx);
  }

  // ---------------------------------------------------------------------------
  // PERF: quality auto-selection (CONTRACTS-RENDER.md §6: "Engine picks the
  // level from a frame-time probe")
  // ---------------------------------------------------------------------------
  // Starting level from what the device is (classroom Chromebooks and iPads
  // must not boot into the full-fat level and stutter until the governor
  // notices). GPU string where the browser exposes it, else the UA.
  _deviceQuality() {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const nav = typeof navigator !== 'undefined' ? navigator : {};
      const ua = String(nav.userAgent || '');
      const mem = nav.deviceMemory || 8, cores = nav.hardwareConcurrency || 4;
      const touch = (nav.maxTouchPoints || 0) > 1;
      if (!this.renderer.capabilities.isWebGL2) return 0;
      if (/SwiftShader|llvmpipe|Software|Basic Render/i.test(gpu)) return 0;
      if (/CrOS/.test(ua)) return (mem > 4 && /Iris|Arc|Radeon|GeForce/i.test(gpu)) ? 1 : 0;
      // iPadOS Safari reports a Mac UA with touch; phones/tablets generally.
      if (/Android|iPhone|iPad|Mobile/i.test(ua) || (touch && /Macintosh/.test(ua))) return (mem <= 4 || cores <= 4) ? 0 : 1;
      if (/Intel|Mali|Adreno|PowerVR|Vivante|Mesa/i.test(gpu)) return (/Iris|Arc/i.test(gpu) && mem >= 8) ? 1 : 0;
      return 2;   // Apple-silicon Macs, discrete NVIDIA / AMD
    } catch (e) { return 1; }
  }

  // Governor rungs, best first: quality 2 (+ supersampling where post.js
  // would use it), quality 2 without supersampling, quality 1, quality 0.
  _applyRung(r) {
    const q = r <= 1 ? 2 : r === 2 ? 1 : 0;
    if (this._post && this._post.setParams) this._post.setParams({ aa: { ssaa: r === 0 ? 1.75 : 1 } });
    this.setQuality(q);
    this._gov.rung = r;
    this._gov.lastChange = this._elapsed;
  }

  // Called every frame with the real frame delta. Every 2 s: two slow windows
  // in a row (avg < 50 fps, most frames slow) step one rung down; after 30 s
  // at a lower rung it probes one rung up once, and a probe that is slow again
  // within 10 s bans that rung. vsync hides headroom, hence probe-and-ban.
  _governor(dt) {
    const g = this._gov;
    // Ignore the first seconds (shader compiles, city meshing).
    if (!this._autoQ || !(dt > 0) || dt > 0.25 || this._elapsed < 6) return;
    g.t += dt; g.acc += dt; g.n++;
    if (dt > 1 / 50) g.slow++;
    if (g.t < 2) return;
    const avg = g.acc / g.n, slowFrac = g.slow / g.n;
    g.t = 0; g.acc = 0; g.n = 0; g.slow = 0;
    const since = this._elapsed - g.lastChange;
    if (avg > 1 / 50 && slowFrac > 0.5) {
      g.slowWins++;
      if (g.slowWins >= 2 && g.rung < 3 && since > 3) {
        if (g.probeAt >= 0 && this._elapsed - g.probeAt < 12) g.failed.add(g.rung);
        g.probeAt = -1;
        g.slowWins = 0;
        this._applyRung(g.rung + 1);
      }
      return;
    }
    g.slowWins = 0;
    if (g.rung > g.cap && since > 30 && avg < 1 / 55 && !g.failed.has(g.rung - 1)) {
      g.probeAt = this._elapsed;
      this._applyRung(g.rung - 1);
    }
  }

  /** Auto quality on/off (on by default). Off keeps whatever level is set. */
  setAutoQuality(on) { this._autoQ = !!on; }
  getQuality() { return this._quality; }

  // Render quality 0 (low) / 1 (medium) / 2 (high). See CONTRACTS-RENDER.md §6.
  setQuality(level) {
    const q = clamp(Math.round(level), 0, 2);
    if (q === this._quality) return;
    this._quality = q;
    this._ctx.quality = q;
    this._post.setQuality(q);
    this._matLib.setQuality(q);
    this._lighting.setQuality(q);
    this._sky.setQuality(q);
    this._terrain.setQuality(q);
    this._roads.setQuality(q);
    this._propFX.setQuality(q);
    this._water.setQuality(q);
  }

  resize() {
    const el = this._canvas;
    const w = el.clientWidth || el.width || 800;
    const h = el.clientHeight || el.height || 600;
    this.renderer.setSize(w, h, false);
    this._aspect = w / h;
    this._camDist = this._clampZoom(this._camDist);
    // Force the ortho frustum to re-derive for the new aspect.
    this.camera.right = NaN;
    if (this._sTarget) this._applyCamera();
    if (this._post) this._post.setSize(w, h, this.renderer.getPixelRatio());
  }
}
