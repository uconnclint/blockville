// tools/rendertest/roadmeasure.js — device-framebuffer measurements + debug
// visualisations for src/render/roads.js.
//
// Dev-only. Never imported by src/. Load AFTER postmeasure.js:
//   (0,eval)(await (await fetch('/tools/rendertest/roadmeasure.js',{cache:'no-store'})).text());
//   await RM.ready;
//
// Provides window.RM:
//   RM.classify()          -> {w,h,cls}  per-pixel road class from a real ID pass
//                             0 = not road, 1 = asphalt, 2 = sidewalk top, 3 = kerb face
//   RM.debug(mode)         -> paints a debug visualisation ONTO the canvas and
//                             leaves it there (mode 0 kind, 1 kerbDist bands,
//                             2 kerbDist ramp, 3 chunk id, 4 tile-local, 5 normal)
//   RM.stats()             -> the numbers the review asks for
//   RM.crop(x,y,w,h,scale) -> 1:1 device-pixel crop blitted into a 2D canvas
//                             overlay (computer{zoom} is a no-op in this pane)
//   RM.probe(mat)          -> render the road meshes with a stand-in material so
//                             albedo vs. lighting can be A/B'd
//
// The ID pass is occlusion-correct: every non-road mesh is swapped to a black
// depth-writing material for the pass, so a road pixel behind a building is not
// counted.

(function () {
  const RM = {};
  const E = () => window.BV.engine;
  let THREE = null;

  RM.ready = (async () => { THREE = await import('/vendor/three.module.js'); RM.THREE = THREE; return true; })();

  // ------------------------------------------------------------------ shaders
  const DBG_VERT = `
attribute vec2 aBvLocal;
attribute float aBvMask;
attribute float aBvKind;
varying vec2 vL; varying float vM; varying float vK; varying vec3 vW; varying vec3 vN;
void main(){
  vL = aBvLocal; vM = aBvMask; vK = aBvKind;
  vW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vN = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

  const DBG_FRAG = `
precision highp float;
varying vec2 vL; varying float vM; varying float vK; varying vec3 vW; varying vec3 vN;
uniform int uMode;
uniform float uChunk;

float kerbDist( vec2 p, float bN, float bE, float bS, float bW ) {
  float xa = mix( 1.0, -6.0, bW );
  float xb = mix( 7.0, 14.0, bE );
  float za = mix( 1.0, -6.0, bN );
  float zb = mix( 7.0, 14.0, bS );
  float d = max( p.x - xa, 0.0 );
  d = min( d, max( xb - p.x, 0.0 ) );
  d = min( d, max( p.y - za, 0.0 ) );
  d = min( d, max( zb - p.y, 0.0 ) );
  d = min( d, length( max( vec2( p.x - 1.0, p.y - 1.0 ), 0.0 ) ) );
  d = min( d, length( max( vec2( 7.0 - p.x, p.y - 1.0 ), 0.0 ) ) );
  d = min( d, length( max( vec2( p.x - 1.0, 7.0 - p.y ), 0.0 ) ) );
  d = min( d, length( max( vec2( 7.0 - p.x, 7.0 - p.y ), 0.0 ) ) );
  return d;
}
vec3 ramp( float t ){
  t = clamp( t, 0.0, 1.0 );
  return clamp( vec3( 1.5 - abs( 4.0 * t - 3.0 ), 1.5 - abs( 4.0 * t - 2.0 ), 1.5 - abs( 4.0 * t - 1.0 ) ), 0.0, 1.0 );
}
void main(){
  float bN = step( 0.5, mod( vM, 2.0 ) );
  float bE = step( 0.5, mod( floor( vM / 2.0 ), 2.0 ) );
  float bS = step( 0.5, mod( floor( vM / 4.0 ), 2.0 ) );
  float bW = step( 0.5, mod( floor( vM / 8.0 ), 2.0 ) );
  vec3 c = vec3( 0.0 );
  if ( uMode == 0 ) {
    // ID pass — exact bytes, no filtering
    c = vec3( vK < 0.5 ? 0.25 : ( vK < 1.5 ? 0.5 : 0.8 ), 0.0, 0.0 );
  } else if ( uMode == 1 ) {
    float d = kerbDist( vL, bN, bE, bS, bW );
    float band = fract( d * 2.0 );
    c = ramp( clamp( d / 4.0, 0.0, 1.0 ) ) * ( 0.55 + 0.45 * step( 0.5, band ) );
    if ( vK > 0.5 ) c = vec3( 0.06 );
  } else if ( uMode == 2 ) {
    float d = kerbDist( vL, bN, bE, bS, bW );
    c = vec3( clamp( d / 4.0, 0.0, 1.0 ) );
    if ( vK > 0.5 ) c = vec3( 0.0, 0.25, 0.0 );
  } else if ( uMode == 3 ) {
    float ci = uChunk;
    c = ramp( fract( ci * 0.137 ) ) * ( vK < 0.5 ? 1.0 : 0.4 );
  } else if ( uMode == 4 ) {
    c = vec3( vL / 8.0, vK * 0.4 );
  } else {
    c = vN * 0.5 + 0.5;
  }
  gl_FragColor = vec4( c, 1.0 );
}`;

  let _dbg = null, _black = null;
  function dbgMat() {
    if (!_dbg) _dbg = new THREE.ShaderMaterial({
      uniforms: { uMode: { value: 0 }, uChunk: { value: 0 } },
      vertexShader: DBG_VERT, fragmentShader: DBG_FRAG,
    });
    return _dbg;
  }
  function blackMat() {
    if (!_black) _black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    return _black;
  }

  // Render the scene with the road meshes swapped to `mat` (or per-chunk clones)
  // and every other mesh black. Occlusion stays correct. Leaves the result on
  // the default framebuffer.
  function idPass(mat, perChunk) {
    const e = E(), r = e.renderer, sc = e.scene, cam = e.camera;
    const roads = new Set(e._roads._chunks.values());
    const saved = [];
    sc.traverse((o) => {
      if (!o.material) return;
      saved.push([o, o.material, o.visible]);
      if (roads.has(o)) o.material = mat;
      else o.material = blackMat();
    });
    // hide the sky dome's own background
    const prevBg = sc.background, prevFog = sc.fog, prevTgt = r.getRenderTarget();
    const prevAC = r.autoClear, prevCC = new THREE.Color(); r.getClearColor(prevCC);
    const prevCA = r.getClearAlpha();
    const prevTM = r.toneMapping, prevOCS = r.outputColorSpace;
    sc.background = null; sc.fog = null;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 1);
    r.autoClear = true;
    if (perChunk) {
      // draw each chunk with its own id
      r.clear(true, true, true);
      r.autoClear = false;
      let i = 0;
      const list = [...e._roads._chunks.values()];
      // black pre-pass for depth
      for (const [o, m] of saved) { if (roads.has(o)) o.visible = false; }
      r.render(sc, cam);
      for (const [o, m, v] of saved) { if (roads.has(o)) o.visible = v; else o.visible = false; }
      for (const m of list) { mat.uniforms.uChunk.value = i++; r.render(sc, cam); }
      for (const [o, m, v] of saved) o.visible = v;
    } else {
      r.render(sc, cam);
    }
    const w = r.domElement.width, h = r.domElement.height;
    const px = new Uint8Array(w * h * 4);
    const gl = r.getContext();
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    // restore
    for (const [o, m, v] of saved) { o.material = m; o.visible = v; }
    sc.background = prevBg; sc.fog = prevFog;
    r.setRenderTarget(prevTgt); r.autoClear = prevAC;
    r.setClearColor(prevCC, prevCA);
    r.toneMapping = prevTM; r.outputColorSpace = prevOCS;
    return { w, h, px };
  }

  RM.idPass = idPass;

  /** Per-pixel road class. 0 none, 1 asphalt, 2 sidewalk top, 3 kerb face. */
  RM.classify = function classify() {
    const m = dbgMat(); m.uniforms.uMode.value = 0;
    const g = idPass(m, false);
    // readPixels is bottom-up; `cls` is indexed TOP-DOWN like PM.at()/RM.crop().
    const cls = new Uint8Array(g.w * g.h);
    for (let gy = 0; gy < g.h; gy++) {
      const src = gy * g.w, dst = (g.h - 1 - gy) * g.w;
      for (let x = 0; x < g.w; x++) {
        const r = g.px[(src + x) * 4];
        cls[dst + x] = r > 190 ? 3 : (r > 110 ? 2 : (r > 40 ? 1 : 0));
      }
    }
    return { w: g.w, h: g.h, cls };
  };

  /** Erode a class mask by `k` pixels so post-process bleed at class edges is
   *  excluded from statistics. */
  RM.erode = function erode(mask, want, k) {
    const { w, h, cls } = mask;
    let cur = new Uint8Array(w * h);
    for (let i = 0; i < cur.length; i++) cur[i] = cls[i] === want ? 1 : 0;
    for (let pass = 0; pass < k; pass++) {
      const nxt = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        nxt[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
      }
      cur = nxt;
    }
    return cur;
  };

  /** Paint a debug visualisation onto the canvas and leave it there. */
  RM.debug = function debug(mode) {
    const m = dbgMat(); m.uniforms.uMode.value = mode | 0;
    return idPass(m, mode === 3);
  };

  /** Render the road meshes with a stand-in material (albedo vs lighting A/B). */
  RM.probe = function probe(opts) {
    opts = opts || {};
    const e = E(), r = e.renderer, sc = e.scene;
    const roads = [...e._roads._chunks.values()];
    const mat = new THREE.MeshStandardMaterial({
      color: opts.color != null ? opts.color : 0x808080,
      roughness: opts.roughness != null ? opts.roughness : 0.85,
      metalness: 0,
    });
    if (e._lighting && e._lighting.patchMaterial) e._lighting.patchMaterial(mat);
    mat.envMapIntensity = 0.38;
    const saved = roads.map((o) => [o, o.material]);
    roads.forEach((o) => { o.material = mat; });
    const g = window.PM.grab();
    saved.forEach(([o, m]) => { o.material = m; });
    mat.dispose();
    return g;
  };

  // --------------------------------------------------------------- statistics
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  function classStats(g, sel, w, h) {
    let n = 0, sum = 0, sum2 = 0;
    let e1 = 0, e4 = 0, e8 = 0;
    let peak = [0, 0, 0], peakL = -1, peakR = -1, peakRGB = [0, 0, 0];
    const redHist = new Int32Array(256);
    const px = g.px;
    for (let y = 8; y < h - 8; y++) {
      const row = y * w;
      const orow = (h - 1 - y) * w;
      for (let x = 8; x < w - 8; x++) {
        if (!sel[row + x]) continue;
        const o = (orow + x) * 4;
        const R = px[o], G = px[o + 1], B = px[o + 2];
        const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        n++; sum += l; sum2 += l * l;
        if (l > peakL) { peakL = l; peak = [R, G, B]; }
        if (R > peakR) { peakR = R; peakRGB = [R, G, B]; }
        redHist[R]++;
        for (let k = 0; k < 3; k++) {
          const s = k === 0 ? 1 : (k === 1 ? 4 : 8);
          const a = (orow + x - s) * 4, b = (orow + x + s) * 4;
          const c = (orow + s * w + x) * 4, d = (orow - s * w + x) * 4;
          const lh = (0.2126 * px[a] + 0.7152 * px[a + 1] + 0.0722 * px[a + 2]
                    + 0.2126 * px[b] + 0.7152 * px[b + 1] + 0.0722 * px[b + 2]) * 0.5;
          const lv = (0.2126 * px[c] + 0.7152 * px[c + 1] + 0.0722 * px[c + 2]
                    + 0.2126 * px[d] + 0.7152 * px[d + 1] + 0.0722 * px[d + 2]) * 0.5;
          const e = Math.abs(l - lh) + Math.abs(l - lv);
          if (k === 0) e1 += e; else if (k === 1) e4 += e; else e8 += e;
        }
      }
    }
    if (!n) return { n: 0 };
    const mean = sum / n;
    const sigma = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const q = (p) => { let c = 0; const t = p * n; for (let i = 0; i < 256; i++) { c += redHist[i]; if (c >= t) return i; } return 255; };

    // LOCAL sigma/mean over 9x9 windows entirely inside the class: this is the
    // surface-texture contrast the review is asking about, with global lighting
    // and shadow variation (which dominate the whole-region sigma) removed.
    let ln = 0, lacc = 0;
    for (let y = 12; y < h - 12; y += 3) {
      for (let x = 12; x < w - 12; x += 3) {
        if (!sel[y * w + x]) continue;
        let s = 0, s2 = 0, k = 0, allIn = true;
        for (let j = -4; j <= 4 && allIn; j++) {
          for (let i = -4; i <= 4; i++) {
            if (!sel[(y + j) * w + x + i]) { allIn = false; break; }
            const o = ((h - 1 - y - j) * w + x + i) * 4;
            const l = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
            s += l; s2 += l * l; k++;
          }
        }
        if (!allIn || k < 81) continue;
        const mu = s / k;
        if (mu < 4) continue;
        lacc += Math.sqrt(Math.max(0, s2 / k - mu * mu)) / mu;
        ln++;
      }
    }
    return {
      n, mean: +mean.toFixed(2), sigma: +sigma.toFixed(3),
      sigmaOverMean: +(sigma / Math.max(1e-6, mean)).toFixed(4),
      localSigmaOverMean: ln ? +(lacc / ln).toFixed(4) : null, localN: ln,
      hf1: +(e1 / (2 * n)).toFixed(3),
      hf4: +(e4 / (2 * n)).toFixed(3),
      hf8: +(e8 / (2 * n)).toFixed(3),
      peakLumaRGB: peak, peakRedRGB: peakRGB,
      redP999: q(0.999), redP99: q(0.99), redMedian: q(0.5),
    };
  }

  /**
   * The review's numbers.
   *   asphalt  — sigma/mean, hf1 (per-pixel noise), hf4/hf8 (real structure)
   *   kerb     — peak RGB of the chromatic outlier
   *   salmon   — count + peak of strongly red-dominant pixels, per class
   */
  RM.stats = function stats(opts) {
    opts = opts || {};
    const mask = RM.classify();
    const w = mask.w, h = mask.h;
    const g = window.PM.grab();
    const selA = RM.erode(mask, 1, opts.erode != null ? opts.erode : 2);
    const selW = RM.erode(mask, 2, opts.erode != null ? opts.erode : 2);
    const selC = RM.erode(mask, 3, 0);   // kerb faces are only a few px tall

    // "lit" asphalt: the brighter half, so shadowed road does not dominate
    const hist = new Int32Array(256);
    let nA = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!selA[i]) continue;
      const o = ((h - 1 - y) * w + x) * 4;
      hist[Math.min(255, lum(g.px[o], g.px[o + 1], g.px[o + 2]) | 0)]++; nA++;
    }
    let acc = 0, med = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= nA * 0.5) { med = i; break; } }
    const selLit = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!selA[i]) continue;
      const o = ((h - 1 - y) * w + x) * 4;
      if (lum(g.px[o], g.px[o + 1], g.px[o + 2]) >= med) selLit[i] = 1;
    }

    // salmon census: red-dominant outliers, attributed to a class
    const salmon = { asphalt: 0, walk: 0, kerb: 0, other: 0, peak: [0, 0, 0], peakClass: 0, peakXY: [0, 0] };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = ((h - 1 - y) * w + x) * 4;
      const R = g.px[o], G = g.px[o + 1], B = g.px[o + 2];
      if (!(R > 60 && R > G * 1.4 && R > B * 1.2)) continue;
      const c = mask.cls[y * w + x];
      if (c === 1) salmon.asphalt++; else if (c === 2) salmon.walk++;
      else if (c === 3) salmon.kerb++; else salmon.other++;
      if (R > salmon.peak[0]) { salmon.peak = [R, G, B]; salmon.peakClass = c; salmon.peakXY = [x, y]; }
    }

    return {
      shot: opts.shot || '?', w, h,
      asphalt: classStats(g, selA, w, h),
      asphaltLit: classStats(g, selLit, w, h),
      walk: classStats(g, selW, w, h),
      kerb: classStats(g, selC, w, h),
      salmon,
    };
  };

  /** The full before/after report: both shots, one identical procedure. */
  RM.report = function report(shots) {
    RM.uncrop();
    const out = {};
    for (const s of (shots || ['golden', 'street'])) {
      window.BVDEMO.shot(s);
      for (let i = 0; i < 8; i++) E().render(0.016);
      const st = RM.stats({ shot: s });
      // kerb-face chromatic outlier: every class-3 pixel, no erosion
      out[s] = {
        asphalt: { mean: st.asphalt.mean, sigmaOverMean: st.asphalt.sigmaOverMean, localSigmaOverMean: st.asphalt.localSigmaOverMean, hf1: st.asphalt.hf1, hf4: st.asphalt.hf4, hf8: st.asphalt.hf8, n: st.asphalt.n },
        asphaltLit: { mean: st.asphaltLit.mean, sigmaOverMean: st.asphaltLit.sigmaOverMean, localSigmaOverMean: st.asphaltLit.localSigmaOverMean, hf1: st.asphaltLit.hf1, hf4: st.asphaltLit.hf4, hf8: st.asphaltLit.hf8 },
        walk: { mean: st.walk.mean, sigmaOverMean: st.walk.sigmaOverMean, localSigmaOverMean: st.walk.localSigmaOverMean, hf1: st.walk.hf1, hf4: st.walk.hf4 },
        kerb: { n: st.kerb.n, mean: st.kerb.mean, peakRedRGB: st.kerb.peakRedRGB, peakLumaRGB: st.kerb.peakLumaRGB },
        salmonOnRoad: st.salmon.asphalt + st.salmon.walk + st.salmon.kerb,
        salmonKerbOnly: st.salmon.kerb,
        kerbChroma: RM.kerbChroma(),
      };
      // kerb vs adjacent asphalt step (does the kerb read as a step?)
      out[s].kerbStep = RM.kerbStep();
    }
    return out;
  };

  /**
   * The "orange rim on every kerb face" measure, restricted to geometry this
   * module owns: how warm the kerb faces are relative to neutral. redExcess =
   * R - max(G,B); a neutral concrete face under any light sits near 0.
   */
  RM.kerbChroma = function kerbChroma() {
    const m = RM.classify(), g = window.PM.grab();
    const w = m.w, h = m.h, px = g.px, cls = m.cls;
    let n = 0, sum = 0, warm = 0, peak = -999, peakRGB = null;
    for (let y = 4; y < h - 4; y++) for (let x = 4; x < w - 4; x++) {
      if (cls[y * w + x] !== 3) continue;
      const o = ((h - 1 - y) * w + x) * 4;
      const R = px[o], G = px[o + 1], B = px[o + 2];
      if (R + G + B < 30) continue;                 // ignore near-black faces
      const ex = R - Math.max(G, B);
      n++; sum += ex;
      if (R > G * 1.25 && R > B * 1.1) warm++;
      if (ex > peak) { peak = ex; peakRGB = [R, G, B]; }
    }
    if (!n) return { n: 0 };
    return {
      n, meanRedExcess: +(sum / n).toFixed(2),
      warmFraction: +(warm / n).toFixed(4),
      peakRedExcess: peak, peakRedExcessRGB: peakRGB,
    };
  };

  /**
   * How much value separation there is between the sidewalk TOP, the kerb FACE
   * and the asphalt directly below it. A kerb that "reads as a step" has a
   * large |top - face| and a dark line on the asphalt side.
   */
  RM.kerbStep = function kerbStep() {
    const m = RM.classify(), g = window.PM.grab();
    const w = m.w, h = m.h, px = g.px, cls = m.cls;
    const L = (x, y) => { const o = ((h - 1 - y) * w + x) * 4; return 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; };
    let n = 0, top = 0, face = 0, road = 0, roadFar = 0, roadMin = 0;
    // walk every vertical run  walkTop | kerbFace | asphalt  (screen-down kerbs)
    for (let x = 6; x < w - 6; x++) {
      for (let y = 12; y < h - 20; y++) {
        if (cls[y * w + x] !== 3) continue;
        // face run
        let y1 = y; while (y1 < h - 20 && cls[y1 * w + x] === 3) y1++;
        const above = cls[(y - 1) * w + x], below = cls[y1 * w + x];
        if (!((above === 2 && below === 1) || (above === 1 && below === 2))) { y = y1; continue; }
        const walkY = above === 2 ? y - 2 : y1 + 1;
        const roadY = above === 1 ? y - 2 : y1 + 1;
        if (walkY < 2 || roadY < 2 || walkY >= h - 2 || roadY >= h - 2) { y = y1; continue; }
        if (cls[walkY * w + x] !== 2 || cls[roadY * w + x] !== 1) { y = y1; continue; }
        const far = roadY + (above === 1 ? -8 : 8);
        if (far < 2 || far >= h - 2 || cls[far * w + x] !== 1) { y = y1; continue; }
        top += L(x, walkY); face += L(x, (y + y1 - 1) / 2 | 0); road += L(x, roadY); roadFar += L(x, far);
        // darkest asphalt pixel within 6 px of the kerb — the shadow line,
        // wherever the classifier happens to put its boundary
        let mn = 1e9;
        for (let k = 0; k <= 6; k++) {
          const yy = roadY + (above === 1 ? -k : k);
          if (yy < 2 || yy >= h - 2 || cls[yy * w + x] !== 1) break;
          mn = Math.min(mn, L(x, yy));
        }
        roadMin += (mn < 1e8 ? mn : L(x, roadY));
        n++; y = y1;
      }
    }
    if (!n) return { n: 0 };
    return {
      n, walkTop: +(top / n).toFixed(2), kerbFace: +(face / n).toFixed(2),
      roadAtKerb: +(road / n).toFixed(2), roadFar: +(roadFar / n).toFixed(2),
      topMinusFace: +((top - face) / n).toFixed(2),
      contactRatio: +((road / n) / Math.max(1e-6, roadFar / n)).toFixed(3),
      lipShadowRatio: +((roadMin / n) / Math.max(1e-6, roadFar / n)).toFixed(3),
    };
  };

  /** 1:1 device-pixel crop, blitted into a fixed overlay canvas (computer{zoom}
   *  silently returns the whole screenshot in this pane, so this is the only way
   *  to inspect small features). */
  RM.crop = function crop(x, y, cw, ch, scale, g) {
    g = g || window.PM.grab();
    scale = scale || 4;
    let el = document.getElementById('rm-crop');
    if (!el) {
      el = document.createElement('canvas'); el.id = 'rm-crop';
      el.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;image-rendering:pixelated;border:2px solid #0f0';
      document.body.appendChild(el);
    }
    el.width = cw * scale; el.height = ch * scale;
    el.style.display = '';
    const c2 = el.getContext('2d');
    const img = c2.createImageData(cw, ch);
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const sx = x + i, sy = y + j;
      const o = ((g.h - 1 - sy) * g.w + sx) * 4;
      const d = (j * cw + i) * 4;
      img.data[d] = g.px[o]; img.data[d + 1] = g.px[o + 1]; img.data[d + 2] = g.px[o + 2]; img.data[d + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = cw; tmp.height = ch;
    tmp.getContext('2d').putImageData(img, 0, 0);
    c2.imageSmoothingEnabled = false;
    c2.drawImage(tmp, 0, 0, cw * scale, ch * scale);
    return { x, y, cw, ch, scale };
  };
  RM.uncrop = function () { const el = document.getElementById('rm-crop'); if (el) el.style.display = 'none'; };

  /** median refreshTile() cost over n paints, restoring the map afterwards. */
  RM.refreshPerf = function refreshPerf(n) {
    n = n || 60;
    const e = E(), st = (window.BV.sim && window.BV.sim.state) || e.state, N = 80;
    const samples = [];
    const TX = 4, TZ = 4, prev = [];
    for (let i = 0; i < n; i++) {
      const x = TX + (i % 8), z = TZ + ((i / 8) | 0) % 8;
      const idx = z * N + x;
      prev.push([idx, st.map[idx]]);
      st.map[idx] = 3;
      const t0 = performance.now();
      e._roads.refreshTile(st, x, z);
      samples.push(performance.now() - t0);
    }
    for (const [i, v] of prev) st.map[i] = v;
    e._roads.build(st);
    samples.sort((a, b) => a - b);
    return { n, median: +samples[n >> 1].toFixed(3), p90: +samples[(n * 0.9) | 0].toFixed(3), max: +samples[n - 1].toFixed(3) };
  };

  window.RM = RM;
})();
