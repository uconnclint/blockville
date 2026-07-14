// Blockville rendering engine.
// Owns the Three.js scene, camera, lights, sky/fog, voxel meshing, ground chunks,
// dynamic objects, ghost preview and day/night. Pure ES module.
// Only dependency: vendored three.js (r160) + shared constants.

import * as THREE from '../vendor/three.module.js';
import { TILE, N, CHUNK } from './constants.js';

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
    const sHalf = MAP_W * 0.75;
    sc.left = -sHalf; sc.right = sHalf; sc.top = sHalf; sc.bottom = -sHalf;
    // near/far span the map comfortably from the raised sun position.
    sc.near = MAP_W * 0.08; sc.far = MAP_W * 2.6;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.9;
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
    this._voxMat = this._makeVoxelMaterial(false);
    this._ghostMat = this._makeVoxelMaterial(true);
    this._ghostMat.transparent = true;
    this._ghostMat.opacity = 0.55;
    this._ghostMat.depthWrite = false;
    this._groundMat = this._makeGroundMaterial();

    // ---- Caches / registries ----------------------------------------------
    this._geoCache = new WeakMap();        // model -> BufferGeometry
    this._buildings = new Map();           // id -> Mesh
    this._props = new Map();               // "kind:x:z" -> Mesh
    this._groundChunks = new Map();        // "cx,cz" -> Mesh
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

  _makeVoxelMaterial() {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const nightU = this._nightUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = nightU;
      shader.vertexShader =
        'attribute float emissiveT;\nattribute vec3 glowColor;\nvarying float vEmi;\nvarying vec3 vGlow;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvEmi = emissiveT;\nvGlow = glowColor;'
        );
      shader.fragmentShader =
        'uniform float uNight;\nvarying float vEmi;\nvarying vec3 vGlow;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          '#include <opaque_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vGlow, clamp(vEmi * uNight, 0.0, 1.0));'
        );
    };
    return mat;
  }

  _makeGroundMaterial() {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const timeU = this._waterUniform;
    const seasonU = this._seasonUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.uniforms.uSeason = seasonU;
      shader.vertexShader =
        'attribute float wave;\nvarying float vWave;\nvarying vec3 vWPos;\nuniform float uTime;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
          'vWave = wave;\n' +
          'transformed.y += sin(uTime * 1.6 + transformed.x * 0.35 + transformed.z * 0.35) * 0.12 * wave;\n' +
          'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
        );
      shader.fragmentShader =
        'varying float vWave;\nvarying vec3 vWPos;\nuniform float uTime;\nuniform vec3 uSeason;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          '#include <opaque_fragment>\n' +
          'gl_FragColor.rgb *= uSeason;\n' +
          'float shim = 0.5 + 0.5 * sin(uTime * 2.2 + vWPos.x * 0.25 + vWPos.z * 0.2);\n' +
          'gl_FragColor.rgb += vWave * 0.10 * shim;'
        );
    };
    return mat;
  }

  // ---------------------------------------------------------------------------
  // Voxel meshing (cached by model reference)
  // ---------------------------------------------------------------------------

  _getGeometry(model) {
    if (!model || !Array.isArray(model.blocks)) return this._emptyGeometry();
    let geo = this._geoCache.get(model);
    if (geo) return geo;
    geo = this._buildVoxelGeometry(model);
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
    mesh.receiveShadow = false;
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
    mesh.receiveShadow = false;
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

  buildGround(state) {
    // Dispose any previous chunks.
    for (const mesh of this._groundChunks.values()) {
      this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
    }
    this._groundChunks.clear();
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        this._buildChunk(state, cx, cz);
      }
    }
  }

  refreshTile(state, x, z) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const key = cx + ',' + cz;
    const old = this._groundChunks.get(key);
    if (old) {
      this.scene.remove(old);
      if (old.geometry) old.geometry.dispose();
      this._groundChunks.delete(key);
    }
    this._buildChunk(state, cx, cz);
  }

  _tileTopY(state, x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return null; // out of bounds (border)
    const i = z * N + x;
    // Bridge tiles are ROAD in the map but render as (lower) water.
    const water = state.map[i] === 1 /* WATER */ || (state.bridge && state.bridge[i] === 1);
    return water ? -0.35 : 0;
  }

  _tileGroundColor(type, x, z) {
    switch (type) {
      case 1: return this._linTriple(WATER_C);
      case 2: return this._linTriple(SAND_C);
      case 3: return this._linTriple(ROAD_C);
      default: {
        // grass: hash for a two-tone checker with slight variation
        const h = ((x * 73856093) ^ (z * 19349663)) & 1;
        return this._linTriple(h ? GRASS_A : GRASS_B);
      }
    }
  }

  _buildChunk(state, cx, cz) {
    const baseY = -1.6;
    const x0t = cx * CHUNK, z0t = cz * CHUNK;
    const x1t = Math.min(N, x0t + CHUNK), z1t = Math.min(N, z0t + CHUNK);

    const pos = [], nor = [], col = [], wav = [];

    const quad = (ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz, nx, ny, nz, c, w) => {
      const px = [ax, ay, az, bx, by, bz, cx2, cy, cz2, ax, ay, az, cx2, cy, cz2, dx, dy, dz];
      for (let k = 0; k < 18; k += 3) {
        pos.push(px[k], px[k + 1], px[k + 2]);
        nor.push(nx, ny, nz);
        col.push(c[0], c[1], c[2]);
        wav.push(w);
      }
    };

    // Mountain band colours (linear triples), precomputed once per chunk.
    const MG = this._linTriple(MTN_GRASS);
    const MR = this._linTriple(MTN_ROCK);
    const MS = this._linTriple(MTN_SNOW);
    // Neighbour mountain height (0 = ground/water/border/non-mountain).
    const mtnH = (nx, nz) => {
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) return 0;
      const ni = nz * N + nx;
      if (state.map[ni] !== 15 /* MOUNTAIN */) return 0;
      const hv = state.variant ? state.variant[ni] : 0;
      return hv > 0 ? hv : 4;
    };

    for (let z = z0t; z < z1t; z++) {
      for (let x = x0t; x < x1t; x++) {
        let type = state.map[z * N + x];

        // MOUNTAIN: solid raised column (y=0..h), height-banded colour, with
        // neighbour-culled side walls. Does NOT emit the flat grass slab.
        if (type === 15 /* MOUNTAIN */) {
          const hv = state.variant ? state.variant[z * N + x] : 0;
          const h = hv > 0 ? hv : 4;                 // voxel height (default 4)
          const wx0 = x * TILE, wx1 = wx0 + TILE;
          const wz0 = z * TILE, wz1 = wz0 + TILE;
          const snowy = h >= 8;
          const snowLine = h - 2;                    // top ~2 voxels get snow
          const third = h / 3;
          // Colour of the voxel at level L (spanning y=L..L+1).
          const band = (L) => {
            if (snowy && L >= snowLine) return MS;
            if (L < third) return MG;
            return MR;
          };
          // Top cap (always emitted), coloured by the peak voxel.
          const cTop = band(h - 1);
          quad(wx0, h, wz0, wx0, h, wz1, wx1, h, wz1, wx1, h, wz0, 0, 1, 0, cTop, 0);
          // Exposed side walls: for each side emit only the voxel band above the
          // neighbour's height (buried faces against equal/taller mountains skip).
          const hE = mtnH(x + 1, z), hW = mtnH(x - 1, z),
                hN = mtnH(x, z - 1), hS = mtnH(x, z + 1);
          for (let L = hE; L < h; L++) { const c = band(L), y0 = L, y1 = L + 1; // East +X
            quad(wx1, y0, wz1, wx1, y0, wz0, wx1, y1, wz0, wx1, y1, wz1, 1, 0, 0, c, 0); }
          for (let L = hW; L < h; L++) { const c = band(L), y0 = L, y1 = L + 1; // West -X
            quad(wx0, y0, wz0, wx0, y0, wz1, wx0, y1, wz1, wx0, y1, wz0, -1, 0, 0, c, 0); }
          for (let L = hN; L < h; L++) { const c = band(L), y0 = L, y1 = L + 1; // North -Z
            quad(wx1, y0, wz0, wx0, y0, wz0, wx0, y1, wz0, wx1, y1, wz0, 0, 0, -1, c, 0); }
          for (let L = hS; L < h; L++) { const c = band(L), y0 = L, y1 = L + 1; // South +Z
            quad(wx0, y0, wz1, wx1, y0, wz1, wx1, y1, wz1, wx0, y1, wz1, 0, 0, 1, c, 0); }
          continue;
        }

        // Bridge tile: map says ROAD, but render it as animated WATER (the wooden
        // deck is drawn separately as a prop by main.js).
        if (state.bridge && state.bridge[z * N + x] === 1) type = 1 /* WATER */;
        const topY = type === 1 ? -0.35 : 0;
        const isWater = type === 1 ? 1 : 0;
        const c = this._tileGroundColor(type, x, z);
        const wx0 = x * TILE, wx1 = wx0 + TILE;
        const wz0 = z * TILE, wz1 = wz0 + TILE;

        // Top face
        quad(wx0, topY, wz0, wx0, topY, wz1, wx1, topY, wz1, wx1, topY, wz0, 0, 1, 0, c, isWater);

        // Side skirts only where the neighbour is lower (water step) or the map border.
        const nE = this._tileTopY(state, x + 1, z);
        const nW = this._tileTopY(state, x - 1, z);
        const nN = this._tileTopY(state, x, z - 1);
        const nS = this._tileTopY(state, x, z + 1);
        const lowE = nE === null ? baseY : nE;
        const lowW = nW === null ? baseY : nW;
        const lowN = nN === null ? baseY : nN;
        const lowS = nS === null ? baseY : nS;

        if (lowE < topY) // East +X
          quad(wx1, lowE, wz1, wx1, lowE, wz0, wx1, topY, wz0, wx1, topY, wz1, 1, 0, 0, c, 0);
        if (lowW < topY) // West -X
          quad(wx0, lowW, wz0, wx0, lowW, wz1, wx0, topY, wz1, wx0, topY, wz0, -1, 0, 0, c, 0);
        if (lowN < topY) // North -Z
          quad(wx1, lowN, wz0, wx0, lowN, wz0, wx0, topY, wz0, wx1, topY, wz0, 0, 0, -1, c, 0);
        if (lowS < topY) // South +Z
          quad(wx0, lowS, wz1, wx1, lowS, wz1, wx1, topY, wz1, wx0, topY, wz1, 0, 0, 1, c, 0);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('wave', new THREE.Float32BufferAttribute(wav, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this._groundMat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this._groundChunks.set(cx + ',' + cz, mesh);
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
          this._camPolar = clamp(this._camPolar - (e.clientY - py) * 0.006, 0.35, 1.2);
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

    // Sky / fog colour: day -> night, with a warm sunset bump around te=0.5.
    this._skyCol.copy(this._dayColor).lerp(this._nightColor, te);
    const sunset = Math.max(0, 1 - Math.abs(te - 0.5) / 0.2);
    if (sunset > 0) this._skyCol.lerp(this._sunsetColor, sunset * 0.5);
    // Rain grays the sky (composes with day/night so night+rain works). When
    // locked, reduce the gray contribution so "Always bright" stays legible.
    const gray = this._daylightLock ? this._weatherGray * 0.35 : this._weatherGray;
    if (gray > 0) this._skyCol.lerp(this._weatherGrayColor, gray);
    this.scene.background.copy(this._skyCol);
    this.fog.color.copy(this._skyCol);

    // Sun dims and cools toward moonlight.
    this.sun.intensity = 1.1 + (0.18 - 1.1) * te;
    this.sun.color.copy(this._sunDayColor).lerp(this._moonColor, te);

    // Fill lights dim at night.
    this.hemi.intensity = 0.6 + (0.28 - 0.6) * te;
    this.ambient.intensity = 0.18 + (0.15 - 0.18) * te;
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

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const el = this._canvas;
    const w = el.clientWidth || el.width || 800;
    const h = el.clientHeight || el.height || 600;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
