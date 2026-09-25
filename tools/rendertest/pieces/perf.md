# perf — frame-time work (render layer + engine)

## 2026-09-25 — first performance pass (render-overhaul)

### How it was measured
`tools/rendertest/perfprobe.js` (load via `shoot.mjs --eval`, see its header):
- `ms`: synced wall time per `engine.render()` (1-px readback after each frame; CPU and GPU serialised).
- `pipe`: N frames back to back, one readback at the end. This is the real frame cost under rAF (CPU and
  GPU overlap). The headline numbers below are `pipe`.
- per-pass GPU: `EXT_disjoint_timer_query_webgl2` on ANGLE/Metal gave nonsense (sum of passes 4x the
  wall time), and even sync-bracketed passes mis-attribute work (Metal defers the scene pass into
  whatever first samples its target). **Attribution was done by A/B toggles** (`BVAB` / `BVPIPE`,
  `BVPATCHV` shader bisection), not by per-pass timers.
- `tools/rendertest/tribreak.js` (`BVTRIS`): triangles / draws per category; `freeze.js` (`BVFREEZE`):
  deterministic frames for pixel A/B (movers hidden, clocks pinned); `selftests.js` (`BVSELF`).
All at 1280x720, dpr 1, M5 Pro, headless Chrome (ANGLE Metal), demo city, after LOD/cache settle.

### Profile before changes (quality 2, 1280x720 dpr 1, synced ms; A/B deltas)
| | iso-mid (85) | iso (190, default overview) |
|---|---|---|
| frame (synced / pipelined) | 28 / 22 | 46 / 37 |
| scene-pass tris / draws | 2.65M / 640 | 5.95M / 1120 |
| buildings (hide all) | 17.6 | 31 |
| ...of which voxel FRAGMENT shader (trivial-frag A/B) | 16 | 26 |
| ...glass mirror / sheen block (runs for every wall fragment) | 7 | 11 |
| ...CSM in the voxel shader (grid PCSS filter ~5 of it) | 10 | 12 |
| SSAA 1.5x (dpr 1 only) | 7 | 9 |
| MSAA 4x | 6 | 11 |
| shadow cascades (depth passes) | 2.4 | 1.3 |
| movers (cars/people, ~400 draws, 0.3-0.6M tris) | 3 | 3.6 |
| everything that is not the scene pass | 6 | 7 |
| CPU in engine.render / life.update | 2.6 / 0.8 | 3.5 / 0.8 |

Key finding: fragment cost scales with TRIANGLE count far more than with pixels (at 320x180 internal the
voxel shader still cost 7 ms): res-4 facades are thousands of ~1-px triangles, each spawning 2x2 quads
of a very heavy uber-shader. So the levers are (a) fewer triangles, (b) less work per invocation.

### Changes (all exact unless noted)
1. **View index** (`voxel.js` `_exteriorAir`, `userData.viewIndex`; `engine.js` `_getViewGeometry`,
   `lighting.js` `_swapCaster`): flood-fill outside air; -Y faces and faces into sealed interiors (~19%
   of all quads) are dropped from the scene-pass index. Depth/world-AO passes swap in the full geometry.
2. **Branch out dead shader work** (`materials.js`): glass mirror + per-pane tilt fbm, sun glint and the
   per-window night hashes only run where their mix factor is non-zero (bit-identical output).
   Measured -17% frame at iso-mid.
3. **AO atlas** (`voxel.js` atlas sweep, `materials.js` `AoAtlas`, `engine.js` `_getGeometry`): the
   AO-tolerant sweep only stamps its bilinear AO onto the face lattice; a colour-only sweep emits the
   quads; each quad's AO is an R8 region (1x1 / 2xN / full lattice, deduped) packed by a k-d buddy
   allocator into ONE 4096^2 texture (texStorage2D + texSubImage2D, blocks freed by
   FinalizationRegistry). -25% scene triangles (buildings 1.45x fewer). The demo city (274 building
   geometries) uses 10.9M of 16.8M texels; overflow falls back to per-vertex AO. Movers keep per-vertex
   AO. Only differences: single edge pixels along colour seams (re-triangulated T-junctions) and <=1/255
   AO inside tolerant-merged quads.
4. **CSM filter loops** (`lighting.js` `csmGridFilter`): WebGL2 path visits only taps with non-zero tent
   weight (same taps, same summation order — bit-identical) instead of an 8x8 grid; the debug-only atlas
   fetch is behind the debug uniform. -1.5 ms at iso.
5. **Static shadow cache** (`lighting.js` `cacheStatic`, `_casterSig`): cascades redraw only on a move,
   light turn, caster change (visible-caster signature: geometry/attribute versions, transforms, instance
   counts), markDirty, or every 120 frames; animated casters flagged `userData.shadowLowRate` (water
   floats) refresh every 4 frames (their bob shadow updates at 15 Hz instead of 60). **Gotcha found and
   fixed**: the depth pass's READS of the fill lights resolve lighting.js's lazy skylight grade; skipping
   the pass made hemi/ambient colours alternate every frame. `_touchLightState()` makes the same reads.
6. **Distance LOD** (`voxel.js` `lodModel`, `engine.js` `_updateLod`): coarser integer-res resample
   (majority fill >= 1/2, surface voxels outvote buried ones, glass-weighted colour vote), built lazily
   (<= 4 ms/frame). Quality 2: only when a coarse voxel <= 0.5 device px (in practice res >= 8 houses at
   far zoom; no change at gameplay zooms at dpr 2). Quality 1: 1.0 px; quality 0: 1.6 px (+ movers).
   A 2:1 resample at 0.6 px measurably shifted facade tone (mean diff 0.6 at iso-wide), hence the tiers.
7. **Quality auto-selection** (`engine.js` `_deviceQuality`, `_governor`): start tier from GPU/UA
   (Chromebook, Intel/Mali/Adreno, phones, iPads -> 0/1; Apple-silicon Macs, discrete GPUs -> 2), then
   step down 2+SSAA -> 2 -> 1 -> 0 on two slow 2-s windows (< 50 fps), probe one rung up after 30 s, ban
   a rung whose probe is slow again. First 6 s ignored. `setAutoQuality(false)` pins (bootstrap does).
   Also: lighting now re-renders the world-AO map on a quality switch (it kept the old resolution).

### Results — pipelined ms/frame, 1280x720 dpr 1 (before -> after)
| shot | q2 | q1 | q0 |
|---|---|---|---|
| iso-mid | 22.1 -> 13.5 | 14.2 -> 7.5 | 8.5 -> 4.0 |
| iso (default overview) | 36.7 -> 20.8 | 24.6 -> 12.7 | 12.3 -> 5.0 |
| iso-night | 34.9 -> 19.7 | 24.3 -> 12.0 | 12.1 -> 4.8 |
| iso-close | 13.0 -> 9.2 | 6.4 -> 4.2 | 4.0 -> 2.4 |
| iso-wide | 17.9 -> 9.8 | 13.1 -> 5.0 | 9.9 -> 4.1 |

Scene-pass tris (q2): iso-mid 2.65M -> 1.70M, iso 5.95M -> 4.03M, iso-night 5.89M -> 3.97M,
iso-wide 7.18M -> 3.12M. Draws unchanged (~640 / ~1120); shadow-pass draws gone while static.
q2 without SSAA (governor rung 1): iso-mid 8.6, iso 14.7. dpr 2 (retina, no SSAA) q2: iso-mid 31.1 -> 22.8,
iso 44.5 -> 28.9.

Pixel A/B (frozen, dpr 2, vs baseline): mean abs diff iso-mid 0.14, iso-close 0.13, iso-night 0.26,
one-bakery 0.05, gal-downtown-1 0.002 (baseline run-to-run noise 0-0.08); the differing pixels are single
edge pixels along colour seams. Self-tests all pass (roads' "GL error 0x501" only appears when run after
the other modules' tests — it also does on the baseline; roads alone passes).

### Honest status vs the budget
60 fps with 2x headroom (<= 8.3 ms) at 1280x720 dpr 1 on this M5 Pro: **quality 0 everywhere, quality 1
at iso-mid / close / wide**. Quality 2 (the art-directed look incl. 1.5x SSAA) is 13.5-21 ms at the
overview zooms — 50-75 fps at iso-mid, ~48 at the default overview. The governor handles it (drops SSAA
first, then quality). Target Chromebooks/iPads start at 0/1.

### Remaining ideas (by expected value)
1. The voxel shader's CSM is still ~9 ms of the q2 overview frame: every SIMD group with one penumbra
   fragment runs the full 16-tap blocker search (a min-map early-out was tried: exact, fired on most
   fragments, saved nothing — divergence). A deferred screen-space shadow mask (per pixel, not per quad)
   would remove the triangle-count multiplier; needs a depth(+normal) prepass.
2. Varying diet in the voxel material (~45 floats/vertex; vVoxWorld/vVoxDepth duplicate the CSM
   varyings, aoQuad/aoUV are dead on atlas geometry) — TBDR GPUs pay per vertex output.
3. Movers: InstancedMesh per model (400 draws -> ~20); needs instanceMatrix in VERT_BODY / CSM varyings.
4. The catalog memo holds 24 models, so >24 distinct buildings re-mesh (50-900 ms each) whenever
   main.js asks again; a content-hash geometry cache would stop the re-meshing (and atlas churn).
5. LOD colour fidelity (average-preserving resample) would let quality 2 use LOD from ~1 px.
