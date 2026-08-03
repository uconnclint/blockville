// Blockville rendering engine.
// Owns the Three.js scene, camera, lights, sky/fog, voxel meshing, ground chunks,
// dynamic objects, ghost preview and day/night. Pure ES module.
// Only dependency: vendored three.js (r160) + shared constants.

import * as THREE from '../vendor/three.module.js';
import { TILE, N, CHUNK } from './constants.js';
import { buildVoxelGeometry } from './render/voxel.js';
import { MaterialLib } from './render/materials.js';
import { PostFX } from './render/post.js';
import { Sky } from './render/sky.js';
import { Terrain } from './render/terrain.js';
import { Roads } from './render/roads.js';
import { WaterFX } from './render/water.js';
import { LightingRig } from './render/lighting.js';
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

const clamp = THREE.MathUtils.clamp;

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
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
    this._camTarget = new THREE.Vector3(CENTER, 0, CENTER);
    this._camDist = 205;
    this._camAz = Math.PI * 0.25;
    this._camPolar = 0.9;
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
    this._quality = 2;
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
    this._roads = new Roads(this.scene, { quality: this._quality });
    // seabed:false — terrain.js already draws an opaque sculpted seabed
    // (-1.15 at shore to -2.30 offshore). Two seabeds would z-fight.
    this._water = new WaterFX(this.scene, { seabed: false, quality: this._quality });
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
      // Art direction lives here, at the integration point — post.js ships
      // neutral defaults. Cities:Skylines' tilt-shift is a *hint* of miniature,
      // not a macro lens: keep a wide in-focus band and blur only the far
      // periphery, or the city reads as an out-of-focus photograph.
      params: {
        // Measured Laplacian energy showed the DISTANT half of the frame was
        // marginally sharper than the near half — the tilt ramp started too
        // high and the peak CoC was too small to survive the half-res DoF
        // buffer, so the miniature read was absent entirely.
        dof: { maxBlur: 0.40, rangeScale: 1.6, tilt: 0.22, tiltStart: 0.55, tiltEnd: 0.94 },
        // Bright saturated voxel colours cross a 0.85 threshold constantly,
        // which made rooftops and white props blow out into halos.
        bloom: { threshold: 0.58, strength: 0.30, radius: 0.85 },
        // saturation 1.3 + punch 0.5 pushed already-strong palette greens to
        // 0.88 saturation with no filmic shoulder — grass read as astroturf.
        grade: { exposure: 1.12, saturation: 1.24, contrast: 1.05, vignette: 0.16, punch: 0.50 },
        // bias 0.13 rejected exactly the near-range samples that produce
        // contact occlusion: measured only a ~9% luma dip over 5px at building
        // bases, where Cities:Skylines puts 35-55% into the first metre.
        ssao: { bias: 0.025, radius: 4.5, contactIntensity: 2.8, contactRadius: 0.7 },
        atmo: { strength: 0.18 },
        // CAS ran after FXAA and re-hardened the edges FXAA had just resolved.
        sharpen: { amount: 0.12, beforeAA: true },
      },
    });
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

  _getGeometry(model) {
    if (!model || !Array.isArray(model.blocks)) return this._emptyGeometry();
    let geo = this._geoCache.get(model);
    if (geo) return geo;
    // Upgraded mesher: adds per-vertex voxel AO (`aoT`) and per-palette
    // roughness/metalness (`matParams`), which MaterialLib's shader reads.
    geo = buildVoxelGeometry(model, {
      ao: true,
      bevel: this._bevel,
      palette: this._palLin,
      glowPalette: this._glowLin,
    });
    this._geoCache.set(model, geo);
    return geo;
  }

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
    const geo = this._getGeometry(model);
    const mesh = new THREE.Mesh(geo, this._voxMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;   // self-shadowing + tower-onto-tower
    // (x,z) is the NW anchor tile of the EFFECTIVE footprint; rot k swaps
    // the model's tw×td when odd. rot 0 fronts +Z(S), 1 +X(E), 2 −Z(N), 3 −X(W).
    const tw = model.tw || 1, td = model.td || 1;
    const etw = (rot % 2) ? td : tw, etd = (rot % 2) ? tw : td;
    mesh.position.set((x + etw / 2) * TILE, 0, (z + etd / 2) * TILE);
    mesh.rotation.y = (rot || 0) * Math.PI / 2;
    mesh.scale.y = Math.max(0.001, yScale);
    this.scene.add(mesh);
    this._buildings.set(id, mesh);
  }

  updateBuildingScale(id, yScale) {
    const mesh = this._buildings.get(id);
    if (mesh) mesh.scale.y = Math.max(0.001, yScale);
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
    const geo = this._getGeometry(model);
    const mesh = new THREE.Mesh(geo, this._voxMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set((x + 0.5) * TILE, 0, (z + 0.5) * TILE);
    this.scene.add(mesh);
    this._props.set(key, mesh);
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
    const geo = this._getGeometry(model);
    const mesh = new THREE.Mesh(geo, this._voxMat);
    mesh.castShadow = false;   // keep the shadow pass cheap (many dynamics)
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    this.scene.add(mesh);
    const scene = this.scene;
    return {
      setPos(x, y, z) { mesh.position.set(x, y, z); },
      setRot(yRad) { mesh.rotation.y = yRad; },
      setVisible(b) { mesh.visible = !!b; },
      dispose() { scene.remove(mesh); },
    };
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
    mesh.position.y = -((model && model.sy) || 1) / 2;
    pivot.add(mesh);
    this.scene.add(pivot);
    const scene = this.scene;

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
      setPos(x, y, z) { pivot.position.set(x, y, z); },
      setBaseYaw(rad) { baseYaw = rad; apply(); },
      setSpin(nax, nay, naz, rad) { ax = nax; ay = nay; az = naz; ang = rad; apply(); },
      setVisible(b) { pivot.visible = !!b; },
      dispose() { scene.remove(pivot); },
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
    this._ghostMat.color.setHex(ok ? 0x66ff88 : 0xff6b6b);
    const tw = model.tw || 1, td = model.td || 1;
    const etw = (rot % 2) ? td : tw, etd = (rot % 2) ? tw : td;
    this._ghostMesh.position.set((x + etw / 2) * TILE, 0.02, (z + etd / 2) * TILE);
    this._ghostMesh.rotation.y = (rot || 0) * Math.PI / 2;
    this._ghostMesh.visible = true;
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
      q.mesh.position.set((cell.x + 0.5) * TILE, 0.05, (cell.z + 0.5) * TILE);
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
      mesh.position.set((cell.x + 0.5) * TILE, 0.05, (cell.z + 0.5) * TILE);
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
  //   water   -> the translucent surface at y=-0.35 over WATER/bridge tiles
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

  refreshTile(state, x, z) {
    this._terrain.refreshTile(state, x, z);
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
    this._ray.setFromCamera(this._ndc, this.camera);
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
          this._camAz -= (e.clientX - px) * 0.006;
          this._camPolar = clamp(this._camPolar - (e.clientY - py) * 0.006, 0.35, 1.35);
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
      e.preventDefault();
    };

    const wheel = (e) => {
      this._camDist = clamp(this._camDist * Math.pow(1.0015, e.deltaY), 30, 380);
      e.preventDefault();
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('wheel', wheel, { passive: false });
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

  // Gently frame a tile or neighborhood. Main uses this for "find my city"
  // and for missions whose target (such as the river) may begin off-screen.
  focusAt(x, z, distance) {
    const tx = clamp((Number(x) + 0.5) * TILE, 0, MAP_W);
    const tz = clamp((Number(z) + 0.5) * TILE, 0, MAP_W);
    this._camTarget.set(tx, 0, tz);
    if (Number.isFinite(distance)) this._camDist = clamp(distance, 45, 300);
  }

  _twoPointer() {
    let a = null, b = null;
    for (const p of this._pointers.values()) { if (!a) a = p; else if (!b) b = p; }
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    if (this._pinchDist == null) { this._pinchDist = dist; this._pinchAng = ang; return; }
    if (dist > 0) this._camDist = clamp(this._camDist * (this._pinchDist / dist), 30, 380);
    this._camAz += ang - this._pinchAng;
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
    this.sun.color.copy(s.sunColor);
    this.hemi.color.copy(s.skyColor);
    this.hemi.groundColor.copy(s.groundColor);
    this.ambient.color.copy(s.ambientColor);
    // sky.js's own mix is fill-dominant, which flattens cast shadows into a
    // faint tint: measured light budget at noon was sun ~10%, hemi+ambient
    // ~13%, sky env ~44%. Rebalance toward the key light so shadows read as
    // shapes. Mean frame luminance barely moves (90.7 -> 84.9), so the city
    // stays as bright — the shadows just get their form back.
    this.sun.intensity = s.intensity * SUN_GAIN;
    this.hemi.intensity = s.hemiIntensity * FILL_GAIN;
    this.ambient.intensity = s.ambientIntensity * FILL_GAIN;
    // Horizon sample, so terrain never fades to a colour the sky isn't.
    this.fog.color.copy(s.fogColor);
    // Fog was fixed at near=352/far=1184 while the hero camera sits at 150 —
    // nothing in frame was ever beyond `near`, so aerial perspective was
    // mathematically inactive at every shot distance. Scale it to the orbit so
    // distance always reads as distance.
    const d = this._sDist;
    this.fog.near = d * 0.55;
    this.fog.far = clamp(d * 2.6 + MAP_W * 0.45, MAP_W * 1.05, MAP_W * 1.7);
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
    const d = clamp(dt || 0, 0, 0.1);
    const k = Math.min(1, d * 10);

    // Damp camera toward goals.
    this._sTarget.lerp(this._camTarget, k);
    this._sDist += (this._camDist - this._sDist) * k;
    this._sAz += (this._camAz - this._sAz) * k;
    this._sPolar += (this._camPolar - this._sPolar) * k;

    this._applyCamera();

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
      this._lighting.setParams({ skylightWarmth: skyOut.skylightWarmth * 0.62 });
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._post) this._post.setSize(w, h, this.renderer.getPixelRatio());
  }
}
