// Blockville — iconrender.js: draws one icon mesh (from iconmesh.js) into a
// small transparent PNG. Used inside the icon worker on an OffscreenCanvas (so
// the main thread pays nothing), or on the main thread as a fallback. Private
// WebGLRenderer + scene + camera — the game's renderer is never touched.
// Look: true-isometric 3/4 ortho camera (the game's iso elevation), warm key
// light from the viewer's upper left + sky/ground fill, the mesher's voxel AO,
// a soft contact-shadow disc, transparent background.

import * as THREE from '../vendor/three.module.js';

export const SIZE = 144;                       // px; shown at ~42-60 CSS px (crisp on 2x screens)
const ISO_EL = Math.atan(1 / Math.SQRT2); // 35.26 deg — the game's true-iso elevation
export const ISO_AZ = Math.PI * 0.25;   // 45 deg diagonal: +Z front on the left, +X side on the right

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
// True where this context can create a WebGL OffscreenCanvas (worker render path).
export function canRenderOffscreen() {
  try { return typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('webgl2'); } catch (_) { return false; }
}
function blobToDataURL(blob) {
  if (typeof FileReaderSync === 'function') return new FileReaderSync().readAsDataURL(blob);
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

// ---------------------------------------------------------------------------
const VERT = `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute vec3 normal;
attribute vec3 color;
attribute float aoT;
attribute float rough;
varying vec3 vN;
varying vec3 vC;
varying float vA;
varying float vR;
void main() {
  vN = normal; vC = color; vA = aoT; vR = rough;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
precision highp float;
uniform vec3 uLight;
uniform float uGlassy;
varying vec3 vN;
varying vec3 vC;
varying float vA;
varying float vR;
void main() {
  vec3 n = normalize(vN);
  float diff = max(dot(n, uLight), 0.0);
  // sky/ground hemisphere fill + warm key, the game's sunny-day balance
  vec3 hemi = mix(vec3(0.42, 0.38, 0.34), vec3(0.78, 0.86, 1.0), n.y * 0.5 + 0.5);
  vec3 lit = vC * (hemi * 0.66 + vec3(1.0, 0.95, 0.86) * diff * 0.82);
  lit *= mix(1.0, vA, 0.85);
  if (uGlassy > 0.5 && vR < 0.14) {
    // glass: a touch of sky reflection so windows read as panes, not paint
    lit = mix(lit, vec3(0.52, 0.72, 0.92) * (0.75 + 0.25 * diff), 0.28);
  }
  lit = lit / (1.0 + lit * 0.12);                       // gentle shoulder
  vec3 c = pow(max(lit * 1.08, 0.0), vec3(1.0 / 2.2));  // linear -> sRGB
  float g = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(g), c, 1.12);                            // a little extra candy
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Light direction relative to the icon camera: from the viewer's upper left.
function lightFor(az) {
  const la = az - 0.95;                     // swing left of the view direction
  const el = 0.95;
  return new THREE.Vector3(Math.sin(la) * Math.cos(el), Math.sin(el), Math.cos(la) * Math.cos(el)).normalize();
}

export class IconRenderer {
  constructor() {
    const canvas = makeCanvas(SIZE, SIZE);
    this.r = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power',
    });
    this.r.setPixelRatio(1);
    this.r.setSize(SIZE, SIZE, false);
    this.r.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.mat = new THREE.RawShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uLight: { value: new THREE.Vector3(0, 1, 0) }, uGlassy: { value: 1 } },
    });
    // soft contact shadow: a radial-gradient disc under the footprint
    const sc = makeCanvas(64, 64);
    const g = sc.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    grd.addColorStop(0, 'rgba(20,40,60,0.42)');
    grd.addColorStop(0.6, 'rgba(20,40,60,0.2)');
    grd.addColorStop(1, 'rgba(20,40,60,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    this.shTex = new THREE.CanvasTexture(sc);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.shTex, transparent: true, depthWrite: false }));
    this.shadow.renderOrder = -1;
    this._v = new THREE.Vector3();
  }

  draw(out) {
    const meshes = [];
    for (const p of out.parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(p.nrm, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(p.col, 3));
      geo.setAttribute('aoT', new THREE.BufferAttribute(p.ao, 1));
      geo.setAttribute('rough', new THREE.BufferAttribute(p.rough, 1));
      if (p.idx) geo.setIndex(new THREE.BufferAttribute(p.idx, 1));
      const m = new THREE.Mesh(geo, this.mat);
      meshes.push(m); this.scene.add(m);
    }
    const [x0, y0, z0, x1, y1, z1] = out.box;
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    // contact shadow, nudged away from the light (down-right on screen)
    const az = out.az == null ? ISO_AZ : out.az;
    const L = lightFor(az);
    this.shadow.scale.set(w * 1.18 + 0.4, 1, d * 1.18 + 0.4);
    this.shadow.position.set(cx - L.x * w * 0.06, y0 + 0.01, cz - L.z * d * 0.06);
    this.scene.add(this.shadow);
    this.mat.uniforms.uLight.value.copy(L);
    this.mat.uniforms.uGlassy.value = out.glassy === false ? 0 : 1;

    // camera: true-iso elevation on the job's azimuth, framed on the real vertices
    const R = Math.max(w, y1 - y0, d) * 2 + 10;
    const cy = (y0 + y1) / 2;
    const cam = this.cam;
    cam.position.set(cx + Math.sin(az) * Math.cos(ISO_EL) * R, cy + Math.sin(ISO_EL) * R, cz + Math.cos(az) * Math.cos(ISO_EL) * R);
    cam.up.set(0, 1, 0);
    cam.lookAt(cx, cy, cz);
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    const v = this._v;
    for (const p of out.parts) {
      const P = p.pos, step = P.length > 90000 ? 9 : 3;
      for (let i = 0; i < P.length; i += step) {
        v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(inv);
        if (v.x < a0) a0 = v.x; if (v.x > a1) a1 = v.x;
        if (v.y < b0) b0 = v.y; if (v.y > b1) b1 = v.y;
      }
    }
    const half = Math.max(a1 - a0, b1 - b0) / 2 * 1.1;
    const mx = (a0 + a1) / 2, my = (b0 + b1) / 2;
    cam.left = mx - half; cam.right = mx + half;
    cam.top = my + half; cam.bottom = my - half;
    cam.near = 0.1; cam.far = R * 3;
    cam.updateProjectionMatrix();

    this.r.render(this.scene, cam);
    for (const m of meshes) { this.scene.remove(m); m.geometry.dispose(); }
    this.scene.remove(this.shadow);
  }

  // draw + encode → Promise<PNG data URL>. OffscreenCanvas (worker) encodes
  // asynchronously; a DOM canvas (main-thread fallback) uses toDataURL.
  render(out) {
    this.draw(out);
    const c = this.r.domElement;
    if (typeof c.convertToBlob === 'function') {
      return c.convertToBlob({ type: 'image/png' }).then(blobToDataURL);
    }
    return Promise.resolve(c.toDataURL('image/png'));
  }

  dispose() {
    try { this.shadow.geometry.dispose(); this.shadow.material.dispose(); this.shTex.dispose(); } catch (_) { /* ignore */ }
    try { this.mat.dispose(); this.r.dispose(); this.r.forceContextLoss(); } catch (_) { /* ignore */ }
  }
}

